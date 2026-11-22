/*
 * settings-routes.js — Save / Restore / Reset settings, custom-rules export/import, "Delete rules" and the
 * Import ABP (sandbox) save
 *
 * (10.7.12) Moved here from background.js. Same three-layer split as the other *-routes.js files:
 *   Layer 1 — message-routes.js:  POLICY (which sender may send which message)
 *   Layer 2 — this file:          the settings handlers (they orchestrate several features)
 *   Layer 3 — core/ and data/:    the actual logic
 * C15: this file imports only core/, data/ and util/ — never another route file. The site-mode procedures it
 * shares with the Allow list editor and the popup live in core/site-mode-apply.js for that reason.
 *
 * Public interface — referenced by background.js's ROUTE_HANDLERS:
 *   handleExportCustomRules, handleImportCustomRules     (Manage custom rules: Export / Import)
 *   handleExportAllSettings, handleImportAllSettings     (Filter lists tab: Save settings / Restore settings)
 *   handleResetAllSettings                               (Reset to defaults)
 *   handleDeleteFilteredCustomRules                      (Manage custom rules: Delete rules)
 *   handleGetSandboxFilters, handleSetSandboxFilters     (Import ABP rules editor: load / save)
 *
 * State owned: none (CUSTOM_RULES_EXPORT_FORMAT / ALL_SETTINGS_EXPORT_FORMAT are constants).
 */

import { browser, getCurrentVersion } from '../data/ext.js';
import { dnr } from '../data/ext-compat.js';
import {
    pickKnownKeys,
    rulesetConfig,
    saveRulesetConfig,
    saveSecurityConfig,
    securityConfig,
} from '../data/config.js';

import { getPrivacyInspectorScriptletRules, deletePrivacyScriptletRulesMatching, importCustomScriptletRules } from '../core/custom-scriptlets.js';
import { getFilteringModeDetails } from '../core/mode-manager.js';
import {
    deleteCustomFiltersMatching,
    getAllCustomFiltersWithDates,
    importCosmeticFiltersBulk,
    getSandboxFilters,
    setSandboxFilters,
    annotateRejectedSandboxLines,
} from '../core/filter-manager.js';
import { updateUserRules, applyBadgeCountVisibility } from '../core/ruleset-manager.js';
import { registerContentScripts, registerCookieClickerContentScripts } from '../core/scripting-manager.js';
import { updateCompiledFilters } from '../core/compiled-filters.js';
import { setRulesetEnabled, getEnabledRulesetOverrides, STATIC_RULESET_IDS } from '../core/static-rulesets.js';
import { getLanguageFilterCountries, replaceLanguageFilterCountries } from '../core/language-filter-countries.js';
import { getMatrixBlockRules, deleteMatrixOverridesMatching, importMatrixOverrides } from '../core/matrix-block-rules.js';
import { getWorryfreeDomains, setWorryfreeDomains, applyWorryfreeRules } from '../core/worryfree-manager.js';
import { refreshImportedExemptDomains } from '../core/exempt-domains.js';
import { refreshImportedTabUnderEntries } from '../core/tab-under-guard.js';
import { getAllCookieClickerRules, deleteCookieClickerRulesMatching, importCookieClickerRules } from '../core/cookie-clicker-rules.js';
import { refreshUserRuleBlockCache } from '../core/matrix-panel.js';
import { getAutoDenyState } from '../core/cookie-clicker-autodeny-manager.js';
import { reconcileWorryFreeExtraSuppressionRule } from '../core/worry-free-extra-manager.js';
import { applySeamlessSwitch } from '../core/cookie-clicker-autodeny-manager.js';
import { isSeamlessSurfingEnabled } from '../data/seamless-switch.js';
import { applyAllSiteModes, applyFilteringModeDetails, getAllSiteModes } from '../core/site-mode-apply.js';
import { RELOAD_AFTER_RESPONSE_DELAY_MS } from '../data/timing-constants.js';

/******************************************************************************/

// Export format version — bump this if the payload shape below ever
// changes incompatibly, so a future import can tell an old export apart
// from a new one instead of guessing from field presence. Single source
// of truth for both handlers below, not a literal repeated in each.
const CUSTOM_RULES_EXPORT_FORMAT = 1;
const ALL_SETTINGS_EXPORT_FORMAT = 1;

// Combined export across all FOUR Manage Custom Rules sections at once
// (Cosmetic, Cookie/consent-clicker, Dynamic DNR, Privacy/scriptlet) —
// deliberately NOT per-section like the "Clear all" buttons are; one
// file, everything in it, matching the single Export button in the
// dashboard toolbar.
// Field shapes are chosen to round-trip losslessly through
// handleImportCustomRules() below with no reshaping needed on either
// side: matrixOverrides is exactly getMatrixBlockRules()'s own array
// shape, scriptletRules strips only the regenerate-on-import fields
// (uid, source), cookieClickerRules strips uid/id the same way (a fresh
// id is minted per rule on import — see importCookieClickerRules()'s
// own comment in cookie-clicker-rules.js).
export async function handleExportCustomRules() {
    const [ matrixRules, cosmeticEntries, scriptletRules, cookieClickerRules ] = await Promise.all([
        getMatrixBlockRules(),
        getAllCustomFiltersWithDates(),
        getPrivacyInspectorScriptletRules(),
        getAllCookieClickerRules(),
    ]);

    const cosmeticRules = {};
    for ( const [ hostname, entries ] of cosmeticEntries ) {
        cosmeticRules[hostname] = entries; // [ { selector, createdAt } ]
    }

    return {
        ok: true,
        exportFormat: CUSTOM_RULES_EXPORT_FORMAT,
        extensionVersion: getCurrentVersion(),
        exportedAt: new Date().toISOString(),
        matrixOverrides: matrixRules.map(({ site, domain, all, code, createdAt }) => ({ site, domain, all, code, createdAt })),
        cosmeticRules,
        scriptletRules: scriptletRules.map(({ hostname, name, args, createdAt }) => ({ hostname, name, args, createdAt })),
        cookieClickerRules: cookieClickerRules.map(({ siteHostname, frameHostname, selector, shadowHostSelector, textFilter, enabled, createdAt }) => (
            { siteHostname, frameHostname, selector, shadowHostSelector, textFilter, enabled, createdAt }
        )),
    };
}

// Counterpart to handleExportCustomRules() above — same combined, all-
// three-sections-at-once scope. MERGES into whatever is already on this
// install (an import is meant to bring rules IN, not silently replace
// everything already set up here) by delegating to each section's own
// existing, already-validated add path: importMatrixOverrides() for
// Dynamic DNR, importCosmeticFiltersBulk() for Cosmetic,
// importCustomScriptletRules() for Privacy/scriptlet (both bulk variants
// added per OPTIMIZE.md 3.2 — validate and dedup each item exactly the
// same way their single-item counterparts do, via a shared internal
// helper each pairs with, but batch the storage read/write across the
// whole import instead of once per item) — validation a manual add
// would go through either way, so import can't bypass it. request.payload
// is untrusted file content, not trusted internal data — every field is
// type/shape-checked before use, nothing is assumed.
//
// BUG FIX: cookieClickerRules and cosmeticRules each trigger a follow-up
// content-script re-registration when they actually added something —
// see each section's own comment below for why. matrixOverrides and
// scriptletRules need no such follow-up: matrix overrides are pure DNR
// (importMatrixOverrides() already calls syncDNRRules() itself), and
// custom scriptlet rules are looked up fresh from storage on every
// navigation (js/core/custom-scriptlets.js's injectCustomScriptletsForFrame(),
// triggered by background.js's own webNavigation.onCommitted listener) —
// neither is registered ahead of time the way css-user.js/cookie-clicker
// are, so neither has a "new hostname isn't in the match list yet" gap.
export async function handleImportCustomRules(request) {
    const payload = request.payload;
    if ( !payload || typeof payload !== 'object' ) {
        return { ok: false, error: 'Not a valid custom-rules export file.' };
    }

    const counts = { matrixOverrides: 0, cosmeticHostnames: 0, scriptletRules: 0, cookieClickerRules: 0 };
    const errors = [];

    if ( Array.isArray(payload.matrixOverrides) ) {
        counts.matrixOverrides = await importMatrixOverrides(payload.matrixOverrides);
    }

    if ( Array.isArray(payload.cookieClickerRules) ) {
        counts.cookieClickerRules = await importCookieClickerRules(payload.cookieClickerRules);
        if ( counts.cookieClickerRules > 0 ) {
            await registerCookieClickerContentScripts();
        }
    }

    if ( payload.cosmeticRules && typeof payload.cosmeticRules === 'object' ) {
        const entriesByHostname = [];
        for ( const [ hostname, rawEntries ] of Object.entries(payload.cosmeticRules) ) {
            if ( typeof hostname !== 'string' || hostname === '' ) { continue; }
            if ( !Array.isArray(rawEntries) ) { continue; }
            // Accepts both the current { selector, createdAt } shape AND
            // a plain string array — an export made before this
            // date-tracking feature existed. A bare string just carries
            // no createdAt, which importCosmeticFiltersBulk() already
            // treats the same as any other missing/invalid date
            // (stamps today).
            const entries = rawEntries
                .map(e => typeof e === 'string' ? { selector: e, createdAt: undefined } : e)
                .filter(e => e && typeof e.selector === 'string' && e.selector !== '');
            if ( entries.length === 0 ) { continue; }
            entriesByHostname.push([ hostname, entries ]);
        }
        if ( entriesByHostname.length > 0 ) {
            // importCosmeticFiltersBulk() reports which hostnames got
            // anything NEW (dedup + the global cosmetic-rule cap can both
            // mean 0 of N were actually new for a given hostname) —
            // counted per hostname touched, not per selector, same as
            // before.
            const addedHostnames = await importCosmeticFiltersBulk(entriesByHostname);
            counts.cosmeticHostnames = addedHostnames.size;
            // BUG FIX: css-user.js (the content script that applies the
            // user's own custom cosmetic rules — filter-manager.js's
            // registerCustomFilters()) is registered with a `matches` list
            // built from whichever hostnames ALREADY had a custom cosmetic
            // rule the last time registration ran (scripting-manager.js's
            // registerContentScripts.register()). A hostname that is brand
            // new to custom cosmetic filtering as a result of THIS import
            // is not yet in that list, so its rules would silently never
            // apply on that site until something unrelated happened to
            // trigger a full re-registration (a security toggle, a
            // site-mode change, an extension restart) — indistinguishable
            // from the rules simply not having imported at all. Same fix
            // shape as cookieClickerRules just above
            // (registerCookieClickerContentScripts()); reuses the shared
            // registerContentScripts() orchestrator (already called the
            // same way by handleSetSandboxFilters() below) rather than a
            // new narrower wrapper, since registerCustomFilters() has no
            // standalone public entry point of its own — it only runs as
            // part of this shared orchestration, alongside
            // registerToolbarIconToggler(). Gated on cosmeticHostnames > 0,
            // same "only if it actually added something" posture as the
            // cookie-clicker call above.
            if ( counts.cosmeticHostnames > 0 ) {
                await registerContentScripts();
            }
        }
    }

    if ( Array.isArray(payload.scriptletRules) ) {
        const validRules = payload.scriptletRules.filter(rule => rule && typeof rule === 'object');
        if ( validRules.length > 0 ) {
            const results = await importCustomScriptletRules(validRules, 'import');
            for ( const result of results ) {
                if ( result.ok ) { counts.scriptletRules++; }
                else if ( result.error ) { errors.push(result.error); }
            }
        }
    }

    return { ok: true, counts, errors };
}

/******************************************************************************/
// Filter (block) lists tab — "Save settings" / "Restore settings".
// Broader than the custom-rules export above: the full configuration
// (rulesetConfig, securityConfig, site modes/Allow list) PLUS the exact same custom-rules payload nested under
// `customRules`, produced by calling handleExportCustomRules() directly
// rather than re-gathering that data a second way (C21 — reuse a
// proven function, don't build a second path to the same information).
// One file is then a complete backup; the narrower custom-rules-only
// export stays available on its own tab too, unchanged, for anyone who
// only wants that scope.
/******************************************************************************/

export async function handleExportAllSettings() {
    const [ customRules, filteringModeDetails, sandboxFilters, siteModes, worryfreeDomains, enabledRulesetOverrides, languageFilterCountries ] = await Promise.all([
        handleExportCustomRules(),
        getFilteringModeDetails(true),
        getSandboxFilters(),
        getAllSiteModes(),
        // The Allow list tab's "@@domain$worryfree" lines (10.0.1, CRUD audit: they were Created and Read but
        // never exported, so a backup silently lost them). The user's OWN list only — the built-in quick-fixes
        // sites and the ABP-import lines travel with the build / sandboxFilters. (10.3.0: saferegionsDomains and
        // familiarTlds are no longer exported — both features were removed.)
        getWorryfreeDomains(),
        // (10.1.0) Which filter lists are turned on/off (Built-in toggles, added Language filters,
        // Worry-free list toggles) — stored under its own key by static-rulesets.js, never previously
        // part of the Save/Restore round trip at all (same CRUD gap class as the two entries above).
        getEnabledRulesetOverrides(),
        // (10.4.5) Which country rows of a combined language filter (Balkan, Baltic states) were added (C41: a new
        // data element travels with Save/Restore from the start).
        getLanguageFilterCountries(),
    ]);
    return {
        ok: true,
        exportFormat: ALL_SETTINGS_EXPORT_FORMAT,
        extensionVersion: getCurrentVersion(),
        exportedAt: new Date().toISOString(),
        rulesetConfig: structuredClone(rulesetConfig),
        securityConfig: structuredClone(securityConfig),
        filteringModeDetails,
        siteModes,
        customRules,
        sandboxFilters,
        worryfreeDomains,
        enabledRulesetOverrides,
        languageFilterCountries,
    };
}

// Counterpart to handleExportAllSettings() above. Same MERGE posture as
// handleImportCustomRules() — an import brings settings IN, it doesn't
// wipe and replace everything already configured on this install.
// request.payload is untrusted file content — every top-level section
// is optional and independently shape-checked before use; a file
// missing or malformed in one section still applies whatever other
// sections are valid, rather than failing the whole import over one
// bad part.
export async function handleImportAllSettings(request) {
    const payload = request.payload;
    if ( !payload || typeof payload !== 'object' ) {
        return { ok: false, error: 'Not a valid settings export file.' };
    }

    const applied = { rulesetConfig: false, securityConfig: false, filteringModeDetails: false, siteModes: false, sandboxFilters: false, exemptionLists: false, enabledRulesetOverrides: false, languageFilterCountries: false };
    let customRulesResult;
    let sandboxCompileResult;   // { ok, error } from updateCompiledFilters(), set only when ABP rules were restored

    if ( payload.rulesetConfig && typeof payload.rulesetConfig === 'object' ) {
        Object.assign(rulesetConfig, payload.rulesetConfig);
        saveRulesetConfig();
        applied.rulesetConfig = true;
    }

    if ( payload.securityConfig && typeof payload.securityConfig === 'object' ) {
        // GUARD (C6, 10.5.0): only settings this version knows, with the right type — replaces the
        // 10.3.0 retired-key list and its "moved to 3P-Matrix" restore alert.
        Object.assign(securityConfig, pickKnownKeys(securityConfig, payload.securityConfig));
        await saveSecurityConfig();
        applied.securityConfig = true;
    }

    // (audit 10.6.4) payload.securityAllowlist — present in backups made before this version — is
    // ignored: the allowlist was removed (it was empty since 10.5.0 and nothing read it).

    if ( payload.filteringModeDetails && typeof payload.filteringModeDetails === 'object' ) {
        // MERGE, not replace — applyFilteringModeDetails()/
        // setFilteringModeDetails() write the exact Set it's given, so
        // union with whatever is already configured here first rather
        // than handing it the imported Sets verbatim (which would drop
        // every hostname not present in the imported file, the opposite
        // of "bring settings IN").
        const current = await getFilteringModeDetails(true);
        const mergedNone = new Set([ ...(current.none ?? []), ...(payload.filteringModeDetails.none ?? []) ]);
        const mergedBasic = new Set([ ...(current.basic ?? []), ...(payload.filteringModeDetails.basic ?? []) ]);
        await applyFilteringModeDetails({ none: mergedNone, basic: mergedBasic });
        applied.filteringModeDetails = true;
    }

    if ( payload.customRules && typeof payload.customRules === 'object' ) {
        customRulesResult = await handleImportCustomRules({ payload: payload.customRules });
    }

    if ( payload.siteModes && typeof payload.siteModes === 'object' ) {
        // MERGE, not replace — same posture as every other section here.
        // Reuses applyAllSiteModes() (the procedure behind the Allow list save) rather than writing the
        // 'siteModes' storage key directly, so imported entries go
        // through the exact same full-union reconciliation and
        // content-script re-registration that function was hardened
        // with (see the 9.4.0 allow-list-desync fix and the 9.4.4
        // cookie-clicker-registration fix, both in this same function) —
        // a raw storage write here would silently bypass all of that.
        const currentSiteModes = await getAllSiteModes();
        const mergedSiteModes = { ...currentSiteModes, ...payload.siteModes };
        await applyAllSiteModes(mergedSiteModes);
        applied.siteModes = true;
    }

    // The per-site exemption list (10.0.1, CRUD audit): MERGE, like every other section — union with what is
    // already configured, through the same setWorryfreeDomains() the Allow list editor's handler uses (so the dynamic rules
    // follow). Shape-checked: a malformed list is skipped, never trusted. (10.3.0: an older file's
    // saferegionsDomains and familiarTlds fields are ignored — both features were removed.)
    for ( const [ field, getAll, setAll ] of [
        [ 'worryfreeDomains',   getWorryfreeDomains,   setWorryfreeDomains ],
    ] ) {
        const imported = payload[field];
        if ( Array.isArray(imported) === false ) { continue; }
        const merged = [ ...new Set([ ...(await getAll()), ...imported.filter(d => typeof d === 'string') ]) ];
        await setAll(merged);
        applied.exemptionLists = true;
    }

    // (10.1.0) Filter-list on/off choices (Built-in toggles, added Language filters, Worry-free list
    // toggles) — REPLACE per id, same posture as sandboxFilters: a restore should
    // reproduce the backup's own choices for the ids it names, not merge booleans. Goes through
    // setRulesetEnabled() (not a raw storage write) so DNR state, companion rulesets (C2/C4) and the
    // persisted override itself all stay in sync, same as a user clicking the toggle by hand. Unknown
    // ids are silently skipped (setRulesetEnabled()'s own STATIC_RULESET_IDS guard).
    // (10.4.5) Country rows first (REPLACE), then the on/off choices.
    if ( payload.languageFilterCountries && typeof payload.languageFilterCountries === 'object' ) {
        applied.languageFilterCountries = await replaceLanguageFilterCountries(payload.languageFilterCountries);
    }
    if ( payload.enabledRulesetOverrides && typeof payload.enabledRulesetOverrides === 'object' ) {
        for ( const [ storedId, enabled ] of Object.entries(payload.enabledRulesetOverrides) ) {
            if ( typeof enabled !== 'boolean' ) { continue; }
            // (10.5.0) A retired id in an old backup (e.g. Lithuanian) is skipped like any unknown id — the
            // 10.4.5 carry-over to its successor was removed with the old conversion code.
            if ( !STATIC_RULESET_IDS.includes(storedId) ) { continue; }
            const result = await setRulesetEnabled(storedId, enabled);
            // (10.7.6, audit 10.7.5 D-9) A list Chrome refused is named on the restore screen, not only logged.
            if ( result?.ok === false ) { (applied.rulesetsRefused ??= []).push({ id: storedId, error: result.error }); }
        }
        applied.enabledRulesetOverrides = true;
    }

    if ( typeof payload.sandboxFilters === 'string' && payload.sandboxFilters.trim() !== '' ) {
        // REPLACE, not merge — deliberately the one exception to this
        // function's own general "import brings settings IN, doesn't
        // wipe" posture (see the header comment above). Reported: a
        // full-settings restore kept appending another dated copy of
        // the ABP/sandbox filter text on top of what was already there,
        // instead of putting it back to the exact state the backup
        // captured — the append-with-dated-separator semantics make
        // sense for the standalone Import ABP rules tab (combining
        // several third-party lists over time is the point), but not
        // for a "Restore Settings" backup, which the user reasonably
        // expects to reproduce the saved state, not accumulate on top
        // of whatever happens to already be there. Every other section
        // in this function stays MERGE — this is scoped to sandboxFilters
        // only, per the specific reported symptom, not a change to the
        // function's overall posture.
        await setSandboxFilters(payload.sandboxFilters.trim());
        applied.sandboxFilters = true;
    }

    // Security config changes can affect which Worry-free extra lists are switched on — re-apply once,
    // after every section above has been written, rather than per-section.
    if ( applied.securityConfig ) {
        const autoDenyState = await getAutoDenyState();
        await reconcileWorryFreeExtraSuppressionRule(autoDenyState?.active === true, 'importAllSettings');
    }
    if ( applied.rulesetConfig ) {
        await applyBadgeCountVisibility();
    }
    // BUG FIX: setSandboxFilters() above only persists the merged text
    // (plus syncing scriptlet lines) — it does not compile or register
    // anything. The standalone Import ABP rules tab's own handler
    // (handleSetSandboxFilters()) always follows setSandboxFilters() with
    // updateCompiledFilters() + registerContentScripts()/updateUserRules()
    // so imported network/cosmetic rules actually take effect; this path
    // was missing that same follow-up, so a restored ABP filter list was
    // saved and displayed correctly in the editor but never compiled or
    // applied. Same bug class already fixed once in this function for
    // customRules.cosmeticRules (see handleImportCustomRules()'s own
    // registerContentScripts() call) — reusing that established pattern
    // here (C21) rather than a new mechanism.
    if ( applied.sandboxFilters ) {
        refreshImportedExemptDomains(await getSandboxFilters());   // same follow-up as handleSetSandboxFilters()
        refreshImportedTabUnderEntries(await getSandboxFilters());   // (10.7.2) the editor's $popunder lines
        // (10.7.6, C5) Same report as handleSetSandboxFilters(): the restore screen says so when the
        // restored ABP rules could not be applied (dashboard/settings-io.js).
        sandboxCompileResult = await updateCompiledFilters();
        const [ , userRulesResult ] = await Promise.all([
            registerContentScripts(),
            updateUserRules(),
        ]);
        await annotateRejectedSandboxLines({   // (10.7.6) same as handleSetSandboxFilters()
            rejectedLines: sandboxCompileResult?.rejectedLines,
            rejectedRegexes: userRulesResult?.rejectedRegexes,
        });
        sandboxCompileResult = sandboxApplyReport(sandboxCompileResult, userRulesResult);
        await applyWorryfreeRules();
        // (audit 10.6.4, B-1) Same follow-up as handleSetSandboxFilters(): an open Matrix panel must
        // reflect the restored user rules right away, not after the next reconcile/reopen.
        await refreshUserRuleBlockCache();
    }

    // (10.5.0) The 10.0.7 filter-list-reorg re-run for pre-10.0.7 backups was REMOVED with the 10.0.7
    // migration itself (owner's clean-up of old conversion code; see CHANGELOG_HISTORY.md 10.5.0).
    // (11.0.0) The 10.5.0 "startup ON" step for older backups is REMOVED with that option. A restored
    // Seamless surfing on/off (js/data/seamless-switch.js) applies at once: a running session starts or stops.
    if ( applied.securityConfig ) {
        try {
            await applySeamlessSwitch(isSeamlessSurfingEnabled(securityConfig));
        } catch (reason) {
            console.error('[uBlock-Dynamic] handleImportAllSettings: Seamless surfing on/off not applied:', reason);
        }
    }

    return { ok: true, applied, customRules: customRulesResult, sandboxCompile: sandboxCompileResult };
}

/******************************************************************************/
// Filter (block) lists tab — "Reset to defaults". Same effect as
// installing the extension from scratch — see MSG_RESET_ALL_SETTINGS's
// own comment in message-types.js for why a full clear+reload is the
// only genuinely correct way to do this (rulesetConfig/securityConfig
// are live objects already mutated in place by
// Object.assign() — nothing short of a fresh module evaluation reverts
// them to their real literal defaults).
/******************************************************************************/

export async function handleResetAllSettings() {
    // BUG FIX (found via a real report — "restore defaults doesn't
    // re-enable a filter the user had disabled"): clearing extension
    // storage does NOT touch Chrome's own DNR ruleset enable/disable
    // state — per static-rulesets.js's own header comment, Chrome
    // persists that state independently across service-worker and
    // browser restarts, and it is completely unaffected by
    // storage.local/session.clear(). Without this explicit step, a
    // ruleset the user had toggled off stayed off after "Reset to
    // defaults" — only the extension's own override-tracking key
    // (which restoreEnabledRulesetsFromStorage() reads on the next SW
    // startup) got wiped, not the live Chrome-side state it exists to
    // reapply. browser.runtime.getManifest() returns the STATIC
    // manifest.json declaration — never affected by any runtime
    // updateEnabledRulesets() call — so it's the correct single source
    // of truth for "what are the real defaults", with no separate
    // hardcoded list here that could drift from manifest.json.
    try {
        const manifest = browser.runtime.getManifest();
        const ruleResources = manifest.declarative_net_request?.rule_resources ?? [];
        const enableRulesetIds  = ruleResources.filter(r => r.enabled).map(r => r.id);
        const disableRulesetIds = ruleResources.filter(r => !r.enabled).map(r => r.id);
        await dnr.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
    } catch (reason) {
        console.error('[uBlock-Dynamic] handleResetAllSettings: failed to restore default ruleset state:', reason);
        return { ok: false, error: String(reason?.message ?? reason) };
    }
    try {
        await Promise.all([
            browser.storage.local.clear(),
            browser.storage.session.clear(),
        ]);
    } catch (reason) {
        console.error('[uBlock-Dynamic] handleResetAllSettings: storage clear failed:', reason);
        return { ok: false, error: String(reason?.message ?? reason) };
    }
    // Respond BEFORE reloading — browser.runtime.reload() tears down
    // this service worker (and, per MDN, does so essentially
    // immediately), which would otherwise race the dashboard's own
    // sendMessage() promise and could leave it unresolved. A short
    // delay after the response is sent gives that promise time to
    // settle on the caller's side before the extension actually goes
    // away.
    self.setTimeout(() => browser.runtime.reload(), RELOAD_AFTER_RESPONSE_DELAY_MS);
    return { ok: true };
}

/******************************************************************************/

// Toolbar's "Delete rules" button — smart-deletes across all FOUR
// sections at once, scoped to whatever domain filter is currently active
// in the dashboard (request.filter === '' means no filter, i.e. delete
// everything — the same scope the old per-section Clear all buttons
// covered individually, now unified into this one filter-aware action).
// filter is matched case-insensitively as a plain "contains" — see each
// of the four delete*Matching() functions' own comments for exactly
// which field(s) it's checked against per section.
export async function handleDeleteFilteredCustomRules(request) {
    const filter = typeof request.filter === 'string' ? request.filter : '';
    const [ cosmeticHostnames, matrixOverrides, scriptletRules, cookieClickerRules ] = await Promise.all([
        deleteCustomFiltersMatching(filter),
        deleteMatrixOverridesMatching(filter),
        deletePrivacyScriptletRulesMatching(filter),
        deleteCookieClickerRulesMatching(filter),
    ]);
    if ( cookieClickerRules > 0 ) {
        await registerCookieClickerContentScripts();
    }
    return { ok: true, counts: { cosmeticHostnames, matrixOverrides, scriptletRules, cookieClickerRules } };
}

/******************************************************************************/
// Import ABP rules editor (sandbox): load and save
/******************************************************************************/

export async function handleGetSandboxFilters() {
    return getSandboxFilters();
}

// setSandboxFilters() (filter-manager.js) already syncs BOTH the cosmetic
// index and scriptlet rules as one atomic operation — it calls straight
// into custom-scriptlets.js's syncScriptletRulesFromSandboxText() (that
// function's ONLY caller in the whole codebase) to parse/validate
// scriptlet lines and get back the annotated text (rejected lines
// commented with a reason), while rebuilding its own cosmetic index from
// the same text alongside it. There is exactly one shared text blob here
// (the dashboard's single ABP-import textarea) — no cosmetic-only or
// scriptlet-only save exists to split this into, so this handler stays
// one function rather than being divided by rule-syntax the way some of
// its sibling handlers were.
//
// This handler's own job is the OUTER orchestration on top of that:
// compiling the network/DNR portion (updateCompiledFilters(),
// compiled-filters.js) and re-registering/re-applying everything
// (registerContentScripts() from scripting-manager.js, updateUserRules()
// from ruleset-manager.js).
// (10.7.6) What the Import ABP box tells the person after a save or a settings restore, from the compile result and
// the DNR update result: anything Chrome refused that has no single line to annotate (rule caps, a refused batch). Before 10.7.6 the DNR
// update's errors were dropped here and only reached the developer console. One shape for both entry points (C22).
function sandboxApplyReport(compileResult, userRulesResult) {
    const applyErrors = (userRulesResult?.errors ?? []).filter(e => e.startsWith('regexFilter:') === false);   // regex: annotated per line
    return {
        ok: compileResult?.ok !== false,
        error: compileResult?.error,
        applyErrors,
        noRulesActive: userRulesResult?.batchFailed === true,
    };
}

export async function handleSetSandboxFilters(request) {
    await setSandboxFilters(request.text);
    // The editor's "@@domain$worryfree" lines are per-site exemptions (third channel next to the Allow list
    // tab and the built-in quick-fixes list; "$saferegions" lines are a retired option, ignored since
    // 10.3.0): recompute them from the text that was
    // just stored, and re-apply what depends on them. Part of the SAME save, so the two cannot disagree.
    refreshImportedExemptDomains(await getSandboxFilters());
    // (10.7.2) The editor's "$popunder" lines configure the tab-under guard — same save, same text.
    refreshImportedTabUnderEntries(await getSandboxFilters());
    // (10.7.6, C5) The compile result is reported back: on failure the text is saved but the previous
    // network rules stay active, and the dashboard tells the user so (filter-manager-ui.js).
    const compileResult = await updateCompiledFilters();
    const [ , userRulesResult ] = await Promise.all([ registerContentScripts(), updateUserRules() ]);
    // (10.7.6) Every line that gave no rule is commented out with its reason in red — the owner's rule for ALL
    // refused lines (10.7.2), until now applied to scriptlet and $popup lines only.
    await annotateRejectedSandboxLines({
        rejectedLines: compileResult?.rejectedLines,
        rejectedRegexes: userRulesResult?.rejectedRegexes,
    });
    await applyWorryfreeRules();
    // BUG FIX (10.6.4): a Matrix panel session already running WHILE the
    // user saves new/changed sandbox rules used to keep showing the OLD
    // rules' blocked/not-blocked state until the next reconcile (an SW
    // restart) or the next time the panel is reopened — refreshOverridesCache()
    // already gets this same "refresh right after the thing it reflects
    // changes" treatment for Matrix-panel click overrides; this is the
    // equivalent for the user's own sandbox rules. No-op (cheap) if no
    // Matrix session is currently running — see refreshUserRuleBlockCache()'s
    // own header for why.
    await refreshUserRuleBlockCache();
    return sandboxApplyReport(compileResult, userRulesResult);
}

/******************************************************************************/
