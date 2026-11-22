/*******************************************************************************

    uBlock-Stripped-Dynamic — Static ruleset manager
    Reads and toggles the built-in filter list rulesets via the
    declarativeNetRequest.updateEnabledRulesets() API.
    Chrome persists enabled/disabled state across service-worker and browser
    restarts automatically — but NOT across an extension version update,
    where it resets to manifest.json's declared defaults instead. This
    module persists the user's own choices separately to survive that case
    too (see OVERRIDES_STORAGE_KEY below).

*******************************************************************************/
/*
 * static-rulesets.js — Static ruleset enable/disable
 *
 * Public interface:
 *   getEnabledRulesets()              — returns Set of currently enabled ruleset IDs
 *   setRulesetEnabled(id, enabled)    — enables or disables a static ruleset; (10.7.6) returns { ok, error }
 *                                       so a refusal by Chrome (ruleset limits) reaches the person,
 *                                       cascading to any companion ruleset(s)
 *                                       registered in RULESET_COMPANIONS
 *                                       (js/data/ruleset-companions.js);
 *                                       also persists the choice (see below)
 *   restoreEnabledRulesetsFromStorage() — reapplies persisted user choices;
 *                                       call once per SW startup (background.js);
 *                                       first deletes stored choices for ids this
 *                                       version does not ship (pruneUnknownOverrides)
 *
 * The list of valid IDs is STATIC_RULESET_IDS (must match manifest.json rule_resources).
 */


import { dnr } from '../data/ext-compat.js';
import { localRead, localWrite } from '../data/ext.js';
import { RULESET_COMPANIONS, UNSAFE_COMPANIONS_WITH_OWN_TOGGLE, UNSAFE_RULE_COMPANIONS } from '../data/ruleset-companions.js';

// ── PERSISTED OVERRIDES ──────────────────────────────────────────────────
// Chrome's declarativeNetRequest.updateEnabledRulesets() state does NOT
// reliably survive an extension *version update* — on update, Chrome
// re-applies the enabled/disabled defaults declared in manifest.json's
// rule_resources[], discarding any runtime toggle the user made (e.g.
// turning on the opt-in "AdGuard Anti-Adblock" list). The comment that used
// to sit on setRulesetEnabled() ("Chrome persists the state — no storage
// write needed") was true only across service-worker/browser restarts
// while the same version stays installed — not across updates. This module
// now tracks the user's own choices independently and reapplies them once
// per SW startup (see restoreEnabledRulesetsFromStorage(), called from
// startSession() in background.js), so a version bump can never silently
// revert a deliberate choice again.
const OVERRIDES_STORAGE_KEY = 'enabledRulesetOverrides';

// (10.5.0) The 10.4.5/10.4.6 retired-filter folding (Lithuanian -> Baltic states with its country row,
// Japanese/Korean deleted, former single-country rows backfilled) was REMOVED with the other old
// conversion code (owner). Its generic part stays as pruneUnknownOverrides(): a stored choice for an id
// this version does not ship is deleted, so a removed filter never leaves orphaned storage (C13b/C41).

/******************************************************************************/

// All static ruleset IDs declared in manifest.json rule_resources.
// Must stay in sync with tools/build-rulesets.mjs FILTER_LISTS[].id.
export const STATIC_RULESET_IDS = [
    // Core — enabled by default
    // ruleset_kees1958 stays in this array although it is a Worry-free opt-in since 10.0.7
    // (worryFreeKees1958Enabled): its DNR enable/disable state is independent of the
    // suppression overlay (worry-free-extra-manager.js SCOPED_SUPPRESSION_RULES).
    // ruleset_kees1958_tracking RETIRED (10.0.7) — replaced 1-for-1 by
    // ruleset_adguard_base_removeparam, which is deliberately NOT in this array: it is
    // suppression-only (no-tier shape), never toggled via setRulesetEnabled().
    'ruleset_kees1958',
    // AdGuard and EasyList annoyances — an always-on Built-in default since 10.0.7 (was a
    // Worry-free opt-in); listed here so its Filter-lists toggle works (setRulesetEnabled()).
    'ruleset_annoyances',
    // HaGeZi's Multi LIGHT (v9.7.3)  a normal, enabled-by-default filter list
    // with its own dashboard checkbox (DEFAULT_FILTER_IDS), so it MUST be
    // listed here: setRulesetEnabled() silently ignores any id not in this
    // array (the exact bug class check-static-ruleset-ids.mjs guards).
    // NOT Worry-free-gated — contrast ruleset_kees1958 (Worry-free opt-in since 10.0.7). See the
    // FILTER_LISTS entry in tools/build-rulesets.mjs for the full reasoning.
    'ruleset_hagezi_light',
    // BUG FIX (found during a Filter (block) list panel investigation):
    // these 4 were never in this list at all, even though they're real
    // static rulesets declared in manifest.json rule_resources and
    // rendered/toggled in the dashboard exactly like every ruleset below
    // (dashboard/filter-manager-ui.js's DEFAULT_FILTER_IDS). Every
    // toggle click for one of these silently no-op'd at
    // setRulesetEnabled()'s own `if (!STATIC_RULESET_IDS.includes(id))
    // return;` guard — the checkbox looked like it worked in the moment,
    // but nothing was ever actually written to Chrome's DNR state or to
    // OVERRIDES_STORAGE_KEY, so a page refresh always reverted it back
    // to enabled. Confirmed via direct code read, not assumed.
    //
    // ruleset_disconnect_ads REMOVED entirely — folded into
    // ruleset_disconnect_other, per explicit request. See CHANGELOG.
    // ruleset_disconnect_other (Disconnect Cryptomining + Fingerprinting)
    // REMOVED entirely (10.7.1, owner's decision) — its categories mix real
    // fingerprinters with sign-in/payment/captcha code. See CHANGELOG.
    // ruleset_ghostery_ads / ruleset_ghostery_other REMOVED entirely per
    // explicit request — see CHANGELOG for the removal entry. Both
    // manifest.json entries and every Ghostery-specific build/UI/
    // worry-free-suppression reference removed alongside these two.
    'ruleset_adguard_base',
    // ruleset_adguard_base_adult (hidden, always-on adult-site rules) REMOVED (10.5.1) — its rules now
    // ship in ruleset_annoyances. A stored choice for it is dropped by pruneUnknownOverrides().
    // ruleset_adguard_base_removeparam is explicitly NOT in this array (10.0.7): it is the split-off
    // $removeparam companion of the line above, a Worry-free opt-in handled by the no-tier
    // suppression rule (worry-free-extra-manager.js), never toggled via setRulesetEnabled().
    // AdGuard language filters — disabled by default
    'ruleset_adguard_dutch',
    'ruleset_adguard_german',
    'ruleset_adguard_french',
    'ruleset_adguard_spanish',
    // ruleset_adguard_belgian REMOVED (10.0.6) entirely — its content
    // (AG Base's own foreign.txt "Belgian" subsection) is now duplicated
    // into ruleset_adguard_dutch AND ruleset_adguard_french's own fetch
    // instead of a separate standalone filter. See the FILTER_LISTS
    // comment where this entry used to be in tools/build/filter-lists.mjs.
    // EasyList language filters — disabled by default
    'ruleset_easylist_italian',
    'ruleset_easylist_polish',
    'ruleset_easylist_portuguese',
    'ruleset_easylist_latvian',
    // ruleset_easylist_lithuanian RETIRED (10.4.5) — merged into the Baltic states filter
    // (ruleset_easylist_latvian). (10.5.0) Its stored choice is no longer carried over.
    'ruleset_easylist_czech_slovak',
    'ruleset_easylist_nordic',
    'ruleset_easylist_bulgarian',
    // (10.4.5) Hungarian filter (hufilter & AdGuard). The Balkan and Baltic states filters keep the ids
    // ruleset_easylist_bulgarian / ruleset_easylist_latvian above (storage keys — never renamed).
    'ruleset_hungarian',
    'ruleset_english_outside_top1m',   // (10.7.0) English sites outside the CrUX top 1M — tools/build/english-outside-top-sites.mjs
    // Optional annoyance filters — enabled by default (v8.3.2); user-toggled in dashboard Filter lists tab.
    // NOTE: ruleset file is a build-time output of tools/build-rulesets.mjs fetching
    //       AnnoyancesFilter/Popups/sections/antiadblock.txt — run the build before enabling.
    'ruleset_adguard_antiadblock',
    // Anti-Admiral (v8.3.2) — dedicated block against getadmiral.com's ad-recovery/
    // ad-block-circumvention network ("Admiral", also branded "Ad-Shield"). Distinct
    // from ruleset_adguard_antiadblock above: that one is AdGuard's own general
    // anti-adblock-circumvention list (a different upstream source, different
    // vendor coverage); this one is specifically Admiral/GetAdmiral infrastructure,
    // combined + deduplicated at build time from three independent open-source
    // sources (HaGeZi's ad-shield.txt, EasyList's easyprivacy_trackingservers_
    // admiral.txt, LanikSJ's getadmiral-domains.txt) — see
    // tools/build-rulesets.mjs's buildAntiAdmiralRuleset() for the exact
    // fetch/normalize/dedup logic and each source's own format quirks.
    // Enabled by default: unlike general anti-adblock bypass (which can carry some
    // site-breakage risk from broader circumvention scriptlets), this is pure
    // domain-blocking against one specific, well-documented ad-recovery vendor.
    'ruleset_antiadmiral',
    // Badfilter quick-fixes (personal $badfilter list) — every rule this
    // list produces is an ALLOW override at BADFILTER_QUICKFIXES_PRIORITY
    // (dnr-budgets.js), never a block rule — see tools/build-rulesets.mjs's
    // FILTER_LISTS entry and parseBlockRule()'s own comment. Enabled by
    // default like every other bundled source; toggleable the same way.
    'ruleset_badfilter_quickfixes',
    // Worry-free extra blocklist entry REMOVED (found stale during this
    // session's static-ruleset-id audit) — 'ruleset_worryfree_extra' had
    // no corresponding manifest.json rule_resources entry at all (removed
    // along with buildWorryFreeExtraBlocklistSourceText(), its only
    // builder, per the "Enable extra blocklist" feature removal — see
    // CHANGELOG). Its later replacement (the 4-way split:
    // ruleset_worryfree_3pblock/tldallow/downloadblock/download_tldallow)
    // is intentionally NOT listed here at all — see
    // tools/check-static-ruleset-ids.mjs's own documented allowlist for
    // why: those 4 are managed exclusively by worry-free-extra-manager.js's
    // suppression-rule pattern, never through setRulesetEnabled().
    // AG Base country-TLD overflow rulesets — hidden (no entry in
    // dashboard/filter-manager-ui.js's display-name map). Never toggled
    // directly by the user; see RULESET_COMPANIONS (enabled/disabled
    // together with their visible companion filter) and
    // enableLocaleLanguageFilter() in js/workflow/background.js (the
    // "other" bucket, which has no visible companion, is enabled directly
    // by detected browser locale).
    'ruleset_agbase_overflow_dutch',
    'ruleset_agbase_overflow_german',
    'ruleset_agbase_overflow_french',
    'ruleset_agbase_overflow_spanish',
    'ruleset_agbase_overflow_italian',
    'ruleset_agbase_overflow_polish',
    'ruleset_agbase_overflow_portuguese',
    'ruleset_agbase_overflow_latvian',
    'ruleset_agbase_overflow_czech_slovak',
    'ruleset_agbase_overflow_bulgarian',
    'ruleset_agbase_overflow_nordic',
    'ruleset_agbase_overflow_other',
    'ruleset_agbase_overflow_hungarian',   // (10.4.5) companion of ruleset_hungarian
    // Unsafe-rule companions (10.2.0) — derived from js/data/ruleset-companions.js, never hand-listed: each is
    // toggled together with its parent through RULESET_COMPANIONS, so it must be a known id here
    // (setRulesetEnabled() filters companions against this array). The ones with their own toggle
    // (ruleset_adguard_base_removeparam, suppression-managed) stay out, as before.
    ...Object.values(UNSAFE_RULE_COMPANIONS).filter(id => !UNSAFE_COMPANIONS_WITH_OWN_TOGGLE.includes(id)),
];

/******************************************************************************/

// Returns the raw persisted override map ({ id: enabled, ... }) — read-only,
// for Save/Restore Settings export (handleExportAllSettings()). Kept here
// rather than a direct localRead(OVERRIDES_STORAGE_KEY) call in background.js
// (C4 — single storage layer per module: this module owns this key).
export async function getEnabledRulesetOverrides() {
    try {
        return await localRead(OVERRIDES_STORAGE_KEY) ?? {};
    } catch (err) {
        console.error('[uBlock-Dynamic] getEnabledRulesetOverrides:', err);
        return {};
    }
}

/******************************************************************************/

// Returns a Set of currently enabled ruleset IDs.
export async function getEnabledRulesets() {
    try {
        const enabled = await dnr.getEnabledRulesets();
        return new Set(Array.isArray(enabled) ? enabled : []);
    } catch {
        return new Set();
    }
}

/******************************************************************************/

// Enable or disable a single static ruleset by ID. Also enables/disables
// any companion ruleset(s) registered for it in RULESET_COMPANIONS (e.g.
// toggling the visible "AdGuard Dutch filter" also toggles its hidden
// AG-Base-overflow companion) — see js/data/ruleset-companions.js.
// Persists the user's choice (see OVERRIDES_STORAGE_KEY above) so it can be
// reapplied on the next startup — Chrome's own DNR state does not survive
// an extension version update.
export async function setRulesetEnabled(id, enabled) {
    if ( !STATIC_RULESET_IDS.includes(id) ) { return { ok: false, error: `unknown filter list "${id}"` }; }

    // Collect id + companions, filtering out any companion id that isn't
    // actually a known static ruleset (defensive — e.g. if a build ran
    // without countryOverflow and the *-overflow-* files don't exist,
    // updateEnabledRulesets() would otherwise throw for the whole batch).
    const companions = (RULESET_COMPANIONS[id] ?? []).filter(cid => STATIC_RULESET_IDS.includes(cid));
    const ids = [ id, ...companions ];

    // Single atomic call for id + all its companions together (C14 —
    // atomic state transitions: a partial enable/disable across id and its
    // companions would leave AG Base's overflow content out of sync with
    // the visible filter it belongs to).
    try {
        await dnr.updateEnabledRulesets({
            enableRulesetIds:  enabled ? ids : [],
            disableRulesetIds: enabled ? [] : ids,
        });
    } catch (err) {
        // (10.7.6, audit 10.7.5 D-9) Reported, not only logged: Chrome refuses when too many lists are on
        // (MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) or the static rule budget is used up — the list is then NOT active.
        console.error(`[uBlock-Dynamic] setRulesetEnabled(${id}, ${enabled}):`, err);
        return { ok: false, error: String(err?.message ?? err) };
    }

    // Only persist on a successful DNR update — an override that was never
    // actually applied shouldn't be remembered as the user's choice.
    // Companions are intentionally NOT persisted individually here: they're
    // re-derived from RULESET_COMPANIONS every time `id` itself is restored
    // (see restoreEnabledRulesetsFromStorage() below), so the mapping stays
    // the single source of truth even if it changes in a future version.
    try {
        const overrides = await localRead(OVERRIDES_STORAGE_KEY) ?? {};
        overrides[id] = enabled;
        await localWrite(OVERRIDES_STORAGE_KEY, overrides);
    } catch (err) {
        console.error(`[uBlock-Dynamic] setRulesetEnabled(${id}, ${enabled}): failed to persist override:`, err);
    }
    return { ok: true };
}

/******************************************************************************/

// GUARD — clear (C13b): deletes stored choices for ruleset ids this version does not ship (a removed
// filter list), and persists the cleaned object once. Idempotent: no write when nothing is unknown.
// Returns the overrides to apply.
async function pruneUnknownOverrides(overrides) {
    const known = Object.fromEntries(Object.entries(overrides).filter(([ id ]) => STATIC_RULESET_IDS.includes(id)));
    if ( Object.keys(known).length !== Object.keys(overrides).length ) {
        try { await localWrite(OVERRIDES_STORAGE_KEY, known); } catch (err) {
            console.error('[uBlock-Dynamic] pruneUnknownOverrides: failed to persist overrides:', err);
        }
    }
    return known;
}

/******************************************************************************/

// Reapply every persisted user override, restoring deliberate choices that
// Chrome may have just reset to manifest defaults on this version's update.
// Called once from startSession() in background.js — the same place that
// already knows "this is a fresh install or version bump", which is
// precisely when Chrome's own DNR enabled-state can have been reset.
export async function restoreEnabledRulesetsFromStorage() {
    let overrides;
    try {
        overrides = await localRead(OVERRIDES_STORAGE_KEY) ?? {};
    } catch (err) {
        console.error('[uBlock-Dynamic] restoreEnabledRulesetsFromStorage: failed to read overrides:', err);
        return;
    }
    overrides = await pruneUnknownOverrides(overrides);
    const ids = Object.keys(overrides);
    if ( ids.length === 0 ) { return; }
    // Sequential, not Promise.all: setRulesetEnabled() issues its own
    // updateEnabledRulesets() call per id (plus companions) — running them
    // concurrently would let overlapping calls race on Chrome's internal
    // ruleset state. This only runs once per SW startup and the override
    // set is typically small, so sequential is not a meaningful cost.
    for ( const id of ids ) {
        await setRulesetEnabled(id, overrides[id]);
    }
}

/******************************************************************************/
