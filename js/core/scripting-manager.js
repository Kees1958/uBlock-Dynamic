/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/Kees1958/uBol-stripped
    Based on uBlock Origin Lite (https://github.com/gorhill/uBlock), modified in
    2026 for uBlock-Stripped-Dynamic — see CHANGELOG.md for the changes.
*/
/*
 * scripting-manager.js — Single owner of all browser.scripting registrations
 *
 * This is the only module that calls browser.scripting.registerContentScripts(),
 * updateContentScripts(), unregisterContentScripts(), or getRegisteredContentScripts().
 * All other modules that need content scripts registered must go through here.
 *
 * Five namespaced registration groups, each with its own prefix/id and lifecycle:
 *   ag-scriptlets-*      MAIN world     — (10.6.0) one SITES registration PER enabled list
 *                                        (`ag-scriptlets-sites-<ruleset id>`, scoped to only that
 *                                        list's own sites — a site named by one list no longer also
 *                                        receives every other enabled list's scriptlet bytes), plus
 *                                        ONE shared ENTITY registration (`ag-scriptlets-entity`, the
 *                                        "name.*" rules no match pattern can express) and a single
 *                                        `ag-scriptlets-main` all-sites fallback the GUARD below falls
 *                                        back to if a per-list registration is ever refused
 *                                        (js/data/scriptlet-library.js, js/util/scriptlet-site-scope.js)
 *   ag-cosmetic-*        ISOLATED world — pre-compiled per-ruleset cosmetic CSS files
 *   sec-*                MAIN world     — security toggle scriptlets (inline code)
 *   ubol-cookie-clicker  ISOLATED world — user-created consent-click rules (ONE
 *                                        directive, not per-ruleset — see that
 *                                        section's own header below)
 *   ubol-autodeny        MAIN world     — "Never consent" generic auto-deny
 *                                        action bundle (v8.2), registered ONLY
 *                                        while a session is active (D11) — see
 *                                        that section's own header below
 *
 * Public interface:
 *   registerContentScripts()          — (re)registers custom filter + toolbar scripts,
 *                                       plus re-diffs the sec-, ag-scriptlets-,
 *                                       ag-cosmetic-, ubol-cookie-clicker, and
 *                                       ubol-autodeny groups (each via its own
 *                                       existing-vs-wanted diff — no blanket
 *                                       wipe; see OPTIMIZE.md 1.1)
 *   registerScriptletContentScripts() — registers/updates the ag-scriptlets-* group (per-list SITES + shared ENTITY)
 *   catchUpAlreadyOpenTabsForScriptlets() — (10.6.0, fix #5) one-time imperative
 *                                       injection of the combined scriptlet files into
 *                                       already-open http(s) tabs, called only at a
 *                                       genuine browser restart or install/update —
 *                                       see that function's own header comment
 *   registerCosmeticContentScripts()  — registers/updates ag-cosmetic-* group
 *   registerCookieClickerContentScripts() — registers/updates the
 *                                       ubol-cookie-clicker script;
 *                                       called by js/workflow/cookie-clicker-routes.js
 *                                       whenever a consent-click rule is
 *                                       added/deleted/cleared
 *   registerCookieClickerAutoDenyContentScripts() — registers/updates the
 *                                       ubol-autodeny script; called by
 *                                       js/core/cookie-clicker-autodeny-
 *                                       manager.js's startAutoDeny()/
 *                                       restoreNow() (init/release, D11)
 *   getRegisteredContentScripts()     — returns all registered script IDs
 *   pruneCSSCache()                   — trims the per-site CSS cache (storage.local since 10.7.6)
 *   getScriptingManagerLockState()    — debugging aid: snapshot of both
 *                                       locks' phase/heldSince (see below)
 *
 * Concurrency: every one of the four functions above that touches
 * browser.scripting shares one in-module mutex (withRegistrationLock(),
 * defined just below the imports) so their check-then-act sequences can
 * never interleave with each other or with the four-group batch inside
 * registerContentScripts() (no longer a blanket wipe — see OPTIMIZE.md
 * 1.1 — but still a shared batch worth excluding the others from while
 * it runs). See that constant's comment for the specific race this fixes.
 *
 * ── STATE / GUARDS (uBol-stripped-code-review.md §1 retrofit) ───────────────
 *
 * This module owns no session with phases (unlike block-monitor.js) — every
 * exported function is a standalone, idempotent registration pass over
 * whatever browser.scripting/DNR state exists *right now*. What it does own
 * is concurrency control, via two independent lock instances (both created
 * from js/util/async-lock.js's createLock() — see that module for the
 * queueing/state-vector mechanism itself; deliberately not merged into one
 * lock — see each instance's own comment at its declaration for exactly
 * what it guards and why they're kept separate):
 *
 *   registrationLock (withRegistrationLock())
 *     General mutex around every browser.scripting.* call in this module —
 *     registerScriptletContentScripts(), registerCosmeticContentScripts(),
 *     the blanket wipe-and-rebuild inside
 *     registerContentScripts.register(), and the two generic
 *     registerContentScriptsSafely()/unregisterContentScriptsByIds()
 *     primitives used by privacy-inspector.js. Non-reentrant by design.
 *
 *   pendingOpLock (registerContentScripts.pendingOp)
 *     Narrower: serializes successive calls to registerContentScripts()
 *     itself (the exported entry point), so two full re-registration passes
 *     triggered back-to-back (e.g. two rapid permission changes) queue
 *     rather than race each other's toAdd/context state.
 *
 * ── OBSERVABILITY ────────────────────────────────────────────────────────────
 * Each lock instance's phase/heldSince is inspectable via its own
 * getState() — see getScriptingManagerLockState() at the end of this file,
 * which exposes both. See js/util/async-lock.js for how that state vector
 * is maintained (try/finally around each queued call).
 *
 * ── WHY THIS FILE ISN'T SPLIT FURTHER (uBol-stripped-code-review.md §1) ──────
 * This file's sections are now clearly labeled (Content-script registration
 * mutex / Scriptlet / Cosmetic / Session CSS cache / Main
 * orchestration / Introspection / Debugging), and the generic mutex has
 * already been extracted to js/util/async-lock.js. Splitting the three
 * registration kinds (scriptlet/cosmetic/security) into separate files was
 * considered and deliberately NOT done — assessed and rejected, not simply
 * unconsidered:
 *
 *   1. The shared registrationLock is the entire point of this file's
 *      concurrency model. If each split-out file created its own
 *      createLock() instance instead of importing one shared instance, the
 *      mutual-exclusion guarantee would silently break — each would queue
 *      independently, reintroducing the exact race this lock exists to
 *      prevent, with no error to catch it.
 *   2. registerContentScripts.register() calls the three *Impl functions
 *      directly, bypassing their lock-acquiring public wrappers, to avoid
 *      deadlocking on a lock it already holds. Splitting means each file
 *      would need to export both its guarded public function AND its raw,
 *      lock-bypassing internal — a much easier place to call the wrong one
 *      from the wrong context than when it's one comment in one file.
 *   3. SCRIPTLET_CS_PREFIX / COSMETIC_CS_PREFIX /
 *      COOKIE_CLICKER_CS_ID cross-reference each other ("must not
 *      collide") — an invariant that's easy to see in one file, easy to
 *      silently violate across several.
 *   4. No test suite: a working, subtle, concurrency-critical file is
 *      exactly the wrong place to take on structural risk for a cosmetic
 *      (fewer-lines-per-file) benefit.
 *
 * Revisit if a genuinely new registration kind is added that does NOT need
 * to share registrationLock — that would be a natural, lower-risk seam.
 * ─────────────────────────────────────────────────────────────────────────────
 */


import {
    browser,
    localKeys, localRead, localWrite, localRemove,
} from '../data/ext.js';

import { PLAIN_HOSTNAME_RE } from '../util/utils.js';
import { getFilteringModeDetails, getFilteringMode, MODE_NONE } from './mode-manager.js';
import { getEnabledRulesets } from './static-rulesets.js';
import { registerCustomFilters } from './filter-manager.js';
import { buildSiteModeMatchScope } from './compiled-filters.js';
import { registerJob } from '../data/alarms.js';
import { securityConfig } from '../data/config.js';
import { COOKIE_BANNER_ACTIONS, cookieBannerActionFor, cookieBannerBundleFor } from '../data/cookie-banner-action.js';
import { syncCmpLoaderBlockRules } from './cmp-loader-block-manager.js';
import {
    COOKIE_NOTICE_HIDE_CS_ID, COOKIE_NOTICE_HIDE_SHARDS, COOKIE_NOTICE_LIBRARY_END_FILE, COOKIE_NOTICE_LIBRARY_FILE,
    COOKIE_NOTICE_MODE_FILES, COOKIE_NOTICE_SCRIPTLET_CS_ID, COOKIE_NOTICE_SITES_FILE, cookieNoticeHideFile,
} from '../data/cookie-notice-sets.js';
import { registerToolbarIconToggler } from './action.js';
import { createLock } from '../util/async-lock.js';
import { SCRIPTLET_LIBRARY_FILE, SCRIPTLET_LIBRARY_END_FILE, SCRIPTLET_LIBRARY_ENTITY_FILE, SCRIPTLET_SITES_FILE } from '../data/scriptlet-library.js';
import { buildScriptletScopes, directiveUpdate } from '../util/scriptlet-site-scope.js';
import { catchExpected, EXPECTED_ERRORS } from '../data/expected-errors.js';

/******************************************************************************/
// Content-script registration mutex
//
// Every function below that does a check-then-act sequence against
// browser.scripting (getRegisteredContentScripts() -> decide -> register /
// update / unregister) — plus the blanket wipe-and-rebuild in
// registerContentScripts.register() — must run through withRegistrationLock()
// so none of them can ever interleave. Chrome's scripting API has no atomic
// "diff and apply" primitive: without this, two such sequences running close
// together can race (one sees an id as "existing" and schedules an update,
// the other's unregister/rebuild removes that id first), producing errors
// like "Script with ID '…' does not exist or is not fully registered".
//
// Non-reentrant by design: registerContentScripts.register() already holds
// this lock for its whole blanket-wipe-and-rebuild sequence, so it calls the
// three *Impl functions directly — never their public, lock-acquiring
// wrappers — to avoid deadlocking on this same queue.
//
// The mutex mechanism itself (queueing + phase-tagged state vector) now
// lives in js/util/async-lock.js — see that file's header for why it moved
// out. withRegistrationLock() is kept as a thin delegating wrapper (rather
// than replacing every call site below with registrationLock.withLock(...))
// so this extraction touches nothing else in this file.
const registrationLock = createLock('scripting-manager/registrationLock');
function withRegistrationLock(fn) {
    return registrationLock.withLock(fn);
}

/******************************************************************************/

// ── Shared batch registration helper ────────────────────────────────────────
// HARD CONSTRAINT (C25 — recurring bug class, standing check required): every
// *ContentScriptsImpl() function in this file that registers/updates MORE
// THAN ONE content-script directive per pass MUST route through this helper.
// It was found, independently, that the three multi-directive registration
// functions in this file (scriptlet, cosmetic, security) each looped over
// their own `toRegister`/`directives` array calling
// browser.scripting.registerContentScripts([directive])/
// updateContentScripts([directive]) ONCE PER DIRECTIVE — for a ruleset set of
// size N, that's up to 2N separate native-API round trips (each one an IPC
// hop to the browser process) on every registration pass (a site-mode
// change, a ruleset toggle, extension startup), where 2 batched calls would
// do. Three independent occurrences of the identical shape is exactly the
// pattern this codebase's own C25 principle says to fix with a shared helper
// plus a standing check (see tools/check-scripting-batch-calls.mjs, wired
// into Part D), not a fourth one-off patch.
//
// registerContentScripts()/updateContentScripts() are each atomic across
// their own array argument — one bad directive rejects the WHOLE call, same
// as updateDynamicRules() (see B13's own note on that atomicity). That's
// worth preserving deliberately, not just tolerating: on a batch rejection,
// this helper falls back to one-call-per-directive for JUST that batch, so a
// single broken ruleset's directive can't silently block every sibling
// ruleset from ever registering. This fallback reproduces the exact
// per-item behavior (and per-item error labels) the previous, always-N-calls
// code had — it's the safety net the batching sits on top of, not a
// behavior change.
//
// (audit 10.6.4) The `retryDuplicateAsUpdate`/`postDuplicateUpdateLabel` options were removed with
// registerSecurityContentScriptsImpl(), their only user.
async function registerOrUpdateContentScripts(wanted, existingMap, {
    updateErrorLabel,
    registerErrorLabel,
} = {}) {
    const toUpdate = [];
    const toAdd = [];
    for ( const directive of wanted ) {
        (existingMap.has(directive.id) ? toUpdate : toAdd).push(directive);
    }

    async function updateOne(directive) {
        await browser.scripting.updateContentScripts([ directive ]).catch(reason => {
            console.error(updateErrorLabel, directive.id, reason);
        });
    }
    async function registerOne(directive) {
        try {
            await browser.scripting.registerContentScripts([ directive ]);
        } catch (reason) {
            console.error(registerErrorLabel, directive.id, reason);
        }
    }

    if ( toUpdate.length > 0 ) {
        await browser.scripting.updateContentScripts(toUpdate).catch(async ( ) => {
            // Batch rejected — fall back to the exact original per-item
            // behavior for just this batch, rather than losing every
            // update in it over one bad directive.
            for ( const directive of toUpdate ) { await updateOne(directive); }
        });
    }
    if ( toAdd.length > 0 ) {
        await browser.scripting.registerContentScripts(toAdd).catch(async ( ) => {
            for ( const directive of toAdd ) { await registerOne(directive); }
        });
    }
}

/******************************************************************************/
// Scriptlet content script registration
// Pre-compiled per-ruleset scriptlet JS files are registered as static content
// scripts in the MAIN world — no userScripts API or "Allow User Scripts" needed.
/******************************************************************************/

// Prefix for scriptlet content script IDs so they can be selectively updated. Every id below is built from this
// prefix plus a fixed, non-ruleset-id suffix ("main", "entity", "sites-") or an actual ruleset id, which always
// starts with "ruleset_" — none of those three fixed suffixes can ever collide with one, by construction.
// (11.1.6, scriptlet audit finding 8) How EVERY scriptlet registration is injected — the filter lists' (SITES, ENTITY,
// the all-sites fallback) and the cookie-notice lists'. `matchOriginAsFallback`: also into frames a page creates without
// an address of its own (about:blank, srcdoc, blob:), judged by the page that created them — as uBO Lite registers its
// scriptlets. Without it, such a frame had no scriptlets, and anti-adblock code could take clean, un-hooked browser
// functions from it. Chrome requires every match pattern's path to be "/*" — every pattern here is (sitePattern(),
// buildSiteModeMatchScope()). Deliberately NOT used for the cookie clicker, hide CSS and Never-consent bundle (CMP banners
// live in frames with a real address — autoconsent 18.14.0: 16 of 1,606 CMP rules, all https; SCRIPTLET_AUDIT.md).
const SCRIPTLET_INJECTION = Object.freeze({ world: 'MAIN', allFrames: true, matchOriginAsFallback: true, runAt: 'document_start' });

const SCRIPTLET_CS_PREFIX = 'ag-scriptlets-';
// The all-sites fallback id (10.5.5 shape; shared library + every wanted list's data file in one registration).
// Up to 10.4.4 every enabled list had its own `ag-scriptlets-<ruleset id>` registration carrying its own copy of
// every scriptlet function; those older ids are still matched by SCRIPTLET_CS_PREFIX, so the first registration
// pass after an update unregisters them too.
const SCRIPTLET_CS_ID = `${SCRIPTLET_CS_PREFIX}main`;
// The one shared ENTITY registration (every page not named by the SITES registration below — the "name.*" rules,
// which no match pattern can express). See js/data/scriptlet-library.js, js/util/scriptlet-site-scope.js.
// (10.6.0–10.7.3 per-list ids `${SCRIPTLET_CS_PREFIX}sites-<ruleset id>` share SCRIPTLET_CS_PREFIX, so the first
// registration pass after the update unregisters them.)
const SCRIPTLET_ENTITY_CS_ID = `${SCRIPTLET_CS_PREFIX}entity`;
// (10.7.4) The ONE shared SITES registration: the library, EVERY wanted list's data file, the end file — matched on
// the union of every wanted list's sites. Replaces 10.6.0's one-registration-per-list (`…sites-<ruleset id>`), which
// broke every site named by two or more lists: Chrome runs an extension file only once per page, so the first list's
// copy of the end file deleted the library global before the next list's data file ran, and that list's scriptlets
// silently did nothing (1 008 of 13 829 sites, e.g. cnn.com: Quick-fixes behind AdGuard Base). Each data file still
// checks the page's hostname itself, so a list's scriptlets only ever run on that list's own sites.
// Cost, measured (owner's decision, Occam): a scriptlet site now also compiles the other lists' data files, ~8-11 ms
// per page load on those sites only; nothing changes anywhere else.
const SCRIPTLET_SITES_CS_ID = `${SCRIPTLET_CS_PREFIX}sites`;

// (10.5.6) Parsed rulesets/scriptlet-sites.json ({ list id: [site, ...] }) — same lifetime and reasoning as
// scriptletFilesCache below (static per version, reloaded once after a worker restart). null = could not be read:
// the registration then falls back to the single all-sites registration (never less protection).
let scriptletSitesCache;

// Parsed contents of the static, build-time-generated scriptlet-files.json
// manifest (OPTIMIZE.md 1.4) — this file only changes on a new extension
// version, so re-fetching and re-parsing it on every registration call was
// pure waste. Lost on SW restart; safe, since it's cheap to reload once on
// the next call — same "acceptable to lose, rebuilt on demand" posture as
// mode-manager.js's readFilteringModeDetails.cache.
let scriptletFilesCache;

// How often the session CSS cache is pruned (see pruneCSSCache() below).
// Was previously the literal `15 * 60 * 1000` duplicated identically in two
// places in this file (uBol-stripped-code-review.md §2) — named once here
// so the two call sites can never drift out of sync with each other.
const CSS_CACHE_PRUNE_INTERVAL_MS = 15 * 60 * 1000;

// Rulesets whose scriptlet and cosmetic content scripts are always registered
// on service-worker startup — a fallback for a real, previously-confirmed
// race condition: getEnabledRulesets() (queried from Chrome's live DNR
// state) can return an incomplete answer if queried before Chrome has
// fully settled that state on a cold start. For a ruleset whose scriptlets/
// cosmetics matter from the very first navigation after startup, missing
// that race means those scripts silently never register for the rest of
// that SW lifetime — no error, just a feature that quietly doesn't work.
//
// This is a STARTUP-ONLY safety net, not a way to make a ruleset immune to
// the user's own Filter Lists toggle: registerScriptletContentScripts()/
// registerCosmeticContentScripts() are called again, explicitly, from the
// ruleset-toggle handler in background.js after updateEnabledRulesets()
// resolves — at that point the user's intent is unambiguous (no race is
// possible), so that call path passes an explicit override forcing this
// set to be ignored for the one ruleset just toggled. See that handler's
// own comment for the override mechanism.
//
// ── CRITICAL MAINTENANCE RULE ────────────────────────────────────────────────
// Any ruleset that should get this SW-startup protection MUST appear in ALL
// THREE places:
//   1. Here in ALWAYS_ON_RULESETS (so scriptlet + cosmetic scripts are registered)
//   2. manifest.json  rule_resources[]  with  "enabled": true
//   3. static-rulesets.js  STATIC_RULESET_IDS[]
//
// Omitting a ruleset from this set risks the exact race described above for
// that ruleset specifically — worth doing only for rulesets whose scriptlet/
// cosmetic content is expected to matter immediately after a cold start.
// ─────────────────────────────────────────────────────────────────────────────
const ALWAYS_ON_RULESETS = new Set([
    'ruleset_adguard_base',
    // ruleset_kees1958 / ruleset_kees1958_tracking REMOVED (confirmed via
    // rulesets/scriptlet-files.json and rulesets/cosmetic-files.json: both
    // produce zero scriptlet and zero cosmetic entries — pure DNR network/
    // removeparam lists). Their presence here was inert; removing them
    // changes nothing observable, just stops implying a protection that
    // was never actually doing anything for these two.
    // 10.0.7: ruleset_annoyances is now an ordinary always-on Built-in default list (was a
    // Worry-free opt-in gated at registration time). It produces hide rules and scriptlets, so
    // it needs the same SW-startup race protection as ruleset_adguard_base. The Filter-lists
    // enable/disable toggle still works through bypassAlwaysOnIds (see the toggle handler).
    'ruleset_annoyances',
    // Add future always-on rulesets here (e.g. cookies) only if
    // they genuinely produce scriptlet/cosmetic content that must survive
    // the SW-startup race described above.
]);

// (10.6.0) Extracted out of registerScriptletContentScriptsImpl() below so the SAME "which lists are wanted,
// what are their files/sites" computation can also drive catchUpAlreadyOpenTabsForScriptlets() (fix #5, further
// below) without a second, independently-maintained copy of this loop (B15/C21 — two copies of the same
// eligibility logic drift; see this file's own module header for the project's standing rule on that). Pure with
// respect to its inputs — scriptletFiles/enabledRulesets/bypassAlwaysOnIds in, a plain data shape out; no I/O, no
// browser.* calls, so it is safe to call from any context that already has those three values in hand.
function getWantedScriptletEntries(scriptletFiles, enabledRulesets, bypassAlwaysOnIds) {
    const wanted = [];
    const allSiteKeys = [], entityFiles = [];
    let sitesComplete = scriptletSitesCache !== null;
    for ( const { id, file, entityFile } of scriptletFiles ) {
        const treatAsAlwaysOn = ALWAYS_ON_RULESETS.has(id) && !bypassAlwaysOnIds?.has(id);
        if ( !treatAsAlwaysOn && !enabledRulesets.has(id) ) { continue; }
        const sites = scriptletSitesCache?.[id];
        if ( !Array.isArray(sites) ) { sitesComplete = false; }
        wanted.push({ id, file, sites: Array.isArray(sites) ? sites : [] });
        if ( Array.isArray(sites) ) { allSiteKeys.push(...sites); }
        if ( entityFile ) { entityFiles.push(`/${entityFile}`); }
    }
    return { wanted, allSiteKeys, entityFiles, sitesComplete };
}

export async function registerScriptletContentScripts(bypassAlwaysOnIds) {
    return withRegistrationLock(() => registerScriptletContentScriptsImpl(undefined, bypassAlwaysOnIds));
}
async function registerScriptletContentScriptsImpl(precomputedScope, bypassAlwaysOnIds) {
    // BUG FIXED: this previously always used matches: ['*://*/*'] with no
    // site-mode awareness at all — identical in kind to the cosmetic-
    // filter bug fixed just below, and to the one buildSiteModeMatchScope()
    // was originally introduced to fix for security scriptlets (see that
    // function's own comment in compiled-filters.js). Turning a site OFF
    // (or pausing filtering everywhere via temp-disable-manager.js) never
    // actually stopped AdGuard-style scriptlet filters from running on
    // that site — only DNR network blocking and the Privacy & Security
    // sec-* toggles were ever gated by filtering mode. Reusing the same
    // buildSiteModeMatchScope() the security scriptlets already rely on,
    // rather than a third, separately-maintained copy of this logic.
    const siteModeScope = precomputedScope ?? await buildSiteModeMatchScope();
    const { matches: siteModeMatches, excludeMatches: siteModeExcludes } = siteModeScope;
    if ( siteModeMatches.length === 0 ) {
        // Reverse mode with no basic-mode exceptions at all: nowhere to
        // inject.
        return browser.scripting.unregisterContentScripts({
            ids: (await browser.scripting.getRegisteredContentScripts())
                .filter(s => s.id.startsWith(SCRIPTLET_CS_PREFIX))
                .map(s => s.id),
        }).catch(catchExpected('unregister scriptlet content scripts', [ EXPECTED_ERRORS.SCRIPT_NOT_REGISTERED ]));
    }

    const enabledRulesets = await getEnabledRulesets();

    let scriptletFiles = scriptletFilesCache;
    if ( scriptletFiles === undefined ) {
        try {
            const resp = await fetch(browser.runtime.getURL('/rulesets/scriptlet-files.json'));
            scriptletFiles = await resp.json();
            scriptletFilesCache = scriptletFiles;
        } catch {
            return;
        }
    }

    if ( scriptletSitesCache === undefined ) {
        try {
            const resp = await fetch(browser.runtime.getURL(`/${SCRIPTLET_SITES_FILE}`));
            const parsed = await resp.json();
            scriptletSitesCache = parsed !== null && typeof parsed === 'object' ? parsed : null;
        } catch {
            scriptletSitesCache = null;
        }
    }

    // (10.7.4) ONE combined SITES registration again (the 10.5.6 shape) — see SCRIPTLET_SITES_CS_ID for why the
    // 10.6.0 per-list split was reverted. ENTITY stays ONE combined registration (union of every list's entity files).
    const { wanted, allSiteKeys, entityFiles, sitesComplete } = getWantedScriptletEntries(scriptletFiles, enabledRulesets, bypassAlwaysOnIds);
    const base = { ...SCRIPTLET_INJECTION };
    function withExcludes(directive, excludeMatches) {
        if ( excludeMatches.length > 0 ) { directive.excludeMatches = excludeMatches; }
        return directive;
    }
    // The single all-sites registration (10.5.5/10.5.6 shape): the fallback whenever the split cannot be built or
    // Chrome refuses part of it (GUARD below).
    const dataFiles = wanted.map(w => `/${w.file}`);
    const allSitesDirective = dataFiles.length === 0 ? null : withExcludes({
        id: SCRIPTLET_CS_ID, ...base,
        js: [ `/${SCRIPTLET_LIBRARY_FILE}`, ...dataFiles, `/${SCRIPTLET_LIBRARY_END_FILE}` ],
        matches: siteModeMatches,
    }, siteModeExcludes);
    const toRegister = [];
    if ( wanted.length > 0 && sitesComplete ) {
        const siteModeForScopes = { matches: siteModeMatches, excludeMatches: siteModeExcludes, allowedHosts: siteModeScope.allowedHosts ?? null };
        // One call over the union of every wanted list's sites: SITES matches it, ENTITY excludes it, so the two stay
        // mutually exclusive everywhere (same guarantee as 10.5.6) — every page gets at most ONE library + end pair.
        const combined = buildScriptletScopes(allSiteKeys, siteModeForScopes);
        if ( entityFiles.length > 0 ) {
            toRegister.push(withExcludes({
                id: SCRIPTLET_ENTITY_CS_ID, ...base,
                js: [ `/${SCRIPTLET_LIBRARY_ENTITY_FILE}`, ...entityFiles, `/${SCRIPTLET_LIBRARY_END_FILE}` ],
                matches: combined.entity.matches,
            }, combined.entity.excludeMatches));
        }
        // The ONE SITES directive: only the data files of lists that name at least one site (a list with only
        // entity rules has nothing to do here).
        const siteDataFiles = wanted.filter(w => w.sites.length > 0).map(w => `/${w.file}`);
        if ( siteDataFiles.length > 0 && combined.sites.matches.length > 0 ) {
            toRegister.push(withExcludes({
                id: SCRIPTLET_SITES_CS_ID, ...base,
                js: [ `/${SCRIPTLET_LIBRARY_FILE}`, ...siteDataFiles, `/${SCRIPTLET_LIBRARY_END_FILE}` ],
                matches: combined.sites.matches,
            }, combined.sites.excludeMatches));
        }
    } else if ( allSitesDirective !== null ) {
        console.error('[uBlock-Dynamic] scriptlets: site list unavailable — using the all-sites registration');
        toRegister.push(allSitesDirective);
    }

    // Every registration of this group, by prefix — includes the per-list ids of an install updated from
    // 10.4.4 or older, which are unregistered here (GUARD: release, legacy registrations).
    let existing = [];
    try {
        existing = (await browser.scripting.getRegisteredContentScripts())
            .filter(s => s.id.startsWith(SCRIPTLET_CS_PREFIX));
    } catch {
        existing = [];
    }

    const existingMap = new Map(existing.map(s => [s.id, s]));
    const wantedIds = new Set(toRegister.map(s => s.id));

    const toRemove = [...existingMap.keys()].filter(id => !wantedIds.has(id));
    if ( toRemove.length ) {
        await browser.scripting.unregisterContentScripts({ ids: toRemove }).catch(catchExpected('unregister stale scriptlet content scripts', [ EXPECTED_ERRORS.SCRIPT_NOT_REGISTERED ]));
    }

    // (10.5.6) Only what changed: an unchanged registration (every worker start) is not re-sent at all, a site
    // toggle sends only the exclude list (js/util/scriptlet-site-scope.js directiveUpdate()).
    const changes = toRegister
        .map(d => existingMap.has(d.id) ? directiveUpdate(existingMap.get(d.id), d) : d)
        .filter(d => d !== null);
    await registerOrUpdateContentScripts(changes, existingMap, {
        updateErrorLabel: '[uBlock-Dynamic] updateContentScripts:',
        registerErrorLabel: '[uBlock-Dynamic] registerContentScripts:',
    });

    // GUARD (never less protection): if Chrome refused ANY of the per-list SITES registrations (e.g. a pattern it
    // rejects), fall back to the single all-sites registration — never leave only SOME lists' SITES data applied
    // while others silently lost theirs.
    const wantedSitesIds = toRegister
        .filter(d => d.id.startsWith(`${SCRIPTLET_CS_PREFIX}sites-`))
        .map(d => d.id);
    if ( allSitesDirective !== null && wantedSitesIds.length > 0 ) {
        const after = await browser.scripting.getRegisteredContentScripts({ ids: wantedSitesIds }).catch(catchExpected('read registered scriptlet content scripts', [], []));
        if ( after.length < wantedSitesIds.length ) {
            console.error('[uBlock-Dynamic] scriptlets: a per-list site registration was refused — using the all-sites registration');
            await browser.scripting.unregisterContentScripts({ ids: [ SCRIPTLET_ENTITY_CS_ID, ...wantedSitesIds ] }).catch(catchExpected('unregister scriptlet entity/site content scripts', [ EXPECTED_ERRORS.SCRIPT_NOT_REGISTERED ]));
            await registerOrUpdateContentScripts([ allSitesDirective ], new Map(), {
                updateErrorLabel: '[uBlock-Dynamic] updateContentScripts:',
                registerErrorLabel: '[uBlock-Dynamic] registerContentScripts:',
            });
        }
    }
}

/******************************************************************************/
// Fix #5 (10.6.0) — catch up already-open tabs after a genuine browser restart or install/update.
//
// Why: content-script registration (above) only affects *future* navigations/frame loads — a tab that was
// already open and loaded before the registration changed never receives newly-registered scriptlets without a
// reload. Inspired by an upstream uBO fix (gorhill/uBlock commit 9af8ef4c6b) that does the same "catch up open
// tabs" pass for its own content scripts after a restart — approved for this project as fix #5.
//
// Deliberately coarser-grained than the declarative registration above, for this ONE-TIME pass only: rather than
// replicating the per-list SITES/ENTITY split (which needs the full siteModeScope plus buildScriptletScopes()
// hostname-pattern matching this module already does for registration), this injects the SAME combined "every
// wanted list's files" shape into each eligible tab via chrome.scripting.executeScript() with an explicit
// tabId. Targeting a tab directly bypasses Chrome's own match-pattern evaluation entirely — the extension names
// the exact tab, not a pattern Chrome matches against — so no hostname-to-site-list matching needs to be
// re-implemented here at all (C21/C24: verified against the real executeScript() contract, not assumed).
// Eligibility uses the coarser getFilteringMode(hostname) !== MODE_NONE check — the SAME one
// registerScriptletContentScriptsImpl() itself falls back to when site data is incomplete — rather than a
// precise per-list site lookup. This can, very rarely, inject a few more bytes into a tab than the precise
// per-list check would have (a site named by no list still gets the general-purpose scriptlets, same as the
// existing all-sites fallback), but it NEVER under-protects, and it only ever runs once per genuine
// restart/install — not on every navigation, and not a full tab reload (too disruptive to trigger from the
// background for every open tab on every restart).
//
// Trigger points (background.js, wired separately from this module per its own "single owner of
// browser.scripting calls" rule — background.js only ever calls this one exported function, never
// browser.scripting directly): a genuine browser restart, via the existing RESTART_ONLY_ACTIONS_RAN_KEY
// chrome.storage.session guard (runBrowserRestartOnlyActionsOnce()) — deliberately NOT every routine SW
// idle-restart, which happens every ~30s of idle within one continuous browsing session and would make this
// fire, and inject into every open tab, far too often; and browser.runtime.onInstalled, for a fresh
// install/update, where every already-open tab is in the same "registered-after-the-fact" situation.
export async function catchUpAlreadyOpenTabsForScriptlets() {
    const enabledRulesets = await getEnabledRulesets();

    let scriptletFiles = scriptletFilesCache;
    if ( scriptletFiles === undefined ) {
        try {
            const resp = await fetch(browser.runtime.getURL('/rulesets/scriptlet-files.json'));
            scriptletFiles = await resp.json();
            scriptletFilesCache = scriptletFiles;
        } catch {
            return;
        }
    }

    // bypassAlwaysOnIds is intentionally omitted (undefined) here: this pass runs only at a genuine
    // restart/install, when there is no in-flight ruleset-toggle override to honor — the same two situations
    // ALWAYS_ON_RULESETS's own comment describes as needing the plain always-on treatment.
    const { wanted } = getWantedScriptletEntries(scriptletFiles, enabledRulesets, undefined);
    const dataFiles = wanted.map(w => `/${w.file}`);
    if ( dataFiles.length === 0 ) { return; }
    const files = [ `/${SCRIPTLET_LIBRARY_FILE}`, ...dataFiles, `/${SCRIPTLET_LIBRARY_END_FILE}` ];

    // Query scoped to http(s) only (GUARD: never attempt injection into chrome://, the Web Store, or other
    // pages executeScript cannot reach at all) — same scheme restriction mode-routes.js's sibling
    // refreshToolbarIconsForOpenTabs() relies on implicitly via its own URL-parse try/catch, made explicit here
    // at the query itself since this function additionally injects content, not just reads state.
    let tabs = [];
    try {
        tabs = await browser.tabs.query({ url: [ 'http://*/*', 'https://*/*' ] });
    } catch {
        return;
    }

    // One independent attempt per tab (Promise.all, not a loop that stops on the first failure) — modeled on
    // mode-routes.js's refreshToolbarIconsForOpenTabs() for the same open-tabs-enumeration shape (C21/C22).
    await Promise.all(tabs.map(async tab => {
        if ( typeof tab.id !== 'number' ) { return; }
        let hostname;
        try {
            hostname = new URL(tab.url).hostname;
        } catch {
            return;
        }
        if ( hostname === '' ) { return; }
        let level;
        try {
            level = await getFilteringMode(hostname);
        } catch {
            return;
        }
        if ( level === MODE_NONE ) { return; }
        try {
            await browser.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                world: 'MAIN',
                files,
            });
        } catch (reason) {
            // Expected and harmless for a tab executeScript genuinely cannot reach (mid-navigation, a
            // just-closed tab, a page executeScript itself refuses) — never fatal to the rest of this
            // one-time, best-effort catch-up pass. Any other failure is logged (C5).
            catchExpected('catch-up scriptlet injection', [ EXPECTED_ERRORS.TAB_GONE, EXPECTED_ERRORS.NOT_SCRIPTABLE ])(reason);
        }
    }));
}

/******************************************************************************/
// Cosmetic content script registration
//
// Storage-backed path, wired 7.7.9, made the SOLE path 7.7.10 (the old
// embedded-blob format and its runtime rollback flag were removed once
// informal real-world verification — repeated fresh loads on real sites
// with confirmed cosmetic rules, forbes.com/cnn.com, reviewed frame-by-
// frame via phone slow-motion camera, no flash observed — gave enough
// confidence to commit. This was NOT the originally-planned automated
// DevTools frame-capture test; see CHANGELOG.md's 7.7.9 AND 7.7.10
// entries for the full history and honest caveat on what "verified"
// means here. If cosmetic filters are ever found to visibly flash on
// screen before hiding, on any page, this is the first place to look —
// mitigation now means reverting to the 7.7.9 zip (which still has the
// rollback flag) rather than flipping a switch in this version.
//
// (11.1.0) ONE registration for every list (COSMETIC_CS_ID — see there for why), loading small files instead of
// one large embedded-blob file:
//   css-api.js       — self.cssAPI.insert(), messages the background to
//                       call browser.scripting.insertCSS() (SAME file for
//                       every ruleset — shared, not duplicated per-ruleset)
//   isolated-api.js  — self.isolatedAPI (hostname-walk, binarySearch())
//                       (SAME file for every ruleset)
//   <id>-cosmetic-loader.js — ONE LINE per list, every wanted list's one:
//                       appends '<id>' to self.specificImports so the
//                       shared css-specific.js below knows which
//                       chrome.storage.local keys to read
//   css-specific.js  — reads chrome.storage.local['css.specific.<id>'],
//                       applies matching selectors (SAME file for every
//                       ruleset)
// Order matters: css-api.js/isolated-api.js populate self.cssAPI/
// self.isolatedAPI, the loader sets self.specificImports, THEN
// css-specific.js runs and consumes all three — see that file's own top
// of file for why.
//
// The old embedded-blob generator (buildCosmeticFile() in tools/build-
// rulesets.mjs) still exists and still runs on every build — but only to
// produce test-fixtures/legacy-cosmetic/, ground truth for tools/check-
// cosmetic-specific-format-equivalence.mjs (complete-check.mjs step 16).
// It is NOT shipped in the extension and NOT consulted by this function
// — see that generator's own comment for why it's kept at all.
/******************************************************************************/

const COSMETIC_CS_PREFIX = 'ag-cosmetic-';
// (11.1.0) BUG FIX — the ONE cosmetic registration: the two shared files, EVERY wanted list's loader, then the shared
// reader css-specific.js, as uBOL does. Replaces one registration per list (`ag-cosmetic-<ruleset id>`), which broke
// site-specific hide rules for every list but one: Chrome runs an extension file only once per page, so css-specific.js
// ran once, for whichever list's loader came first, and every other list's site rules were never read (reproduced in
// Chrome: only ruleset_adguard_antiadblock was read on cnn.com/bbc.com; owner's report: the Bad filter fixes rules for
// cnn.com and bbc.com did nothing). The scriptlet registrations had the same bug, fixed in 10.7.4
// (SCRIPTLET_SITES_CS_ID above) — this is that fix swept to the cosmetic side. The per-list ids share
// COSMETIC_CS_PREFIX, so the first registration pass after the update unregisters them.
const COSMETIC_CS_ID = `${COSMETIC_CS_PREFIX}specific`;

// Same caching rationale as scriptletFilesCache above.
let cosmeticFilesCache;

// Single source for the two files shared, unmodified, across every
// cosmetic-ruleset registration — declared once here rather than
// re-literaled at registerCosmeticContentScriptsImpl()'s directive-
// building call site, per this project's own "declare once" convention.
const COSMETIC_SPECIFIC_SHARED_JS = Object.freeze([
    '/js/scripting/css-api.js',
    '/js/scripting/isolated-api.js',
]);
const COSMETIC_SPECIFIC_READER_JS = '/js/scripting/css-specific.js';

// Storage-key namespace this function owns for the GUARD logic below
// (init / clear-and-release — see the two loops inside
// registerCosmeticContentScriptsImpl() that use these). Must exactly
// match css-specific.js's own hardcoded `css.specific.${rulesetId}` read
// — see that constant's twin in tools/build-rulesets.mjs's
// COSMETIC_SPECIFIC_CONFIG for the same value declared build-side, with
// the same "must match exactly" warning.
const COSMETIC_SPECIFIC_STORAGE_PREFIX = 'css.specific.';
const COSMETIC_SPECIFIC_VERSION_FIELD = 'v';
// Single local-storage key tracking which css.specific.* entries THIS
// function has ever written — lets the RELEASE guard below delete exactly
// the stale ones on a ruleset toggle/removal without a full
// chrome.storage.local scan (which would also touch unrelated keys, e.g.
// user custom-rule storage, that this function has no business reading).
const COSMETIC_SPECIFIC_REGISTRY_KEY = '__uBolCssSpecificRegistry';

export async function registerCosmeticContentScripts(bypassAlwaysOnIds) {
    return withRegistrationLock(() => registerCosmeticContentScriptsImpl(undefined, bypassAlwaysOnIds));
}
async function registerCosmeticContentScriptsImpl(precomputedScope, bypassAlwaysOnIds) {
    // BUG FIXED: same class of bug as registerScriptletContentScriptsImpl()
    // just above — matches: ['*://*/*'] with no site-mode awareness meant
    // cosmetic (CSS-hiding) filters kept running on a site the user had
    // explicitly turned OFF, and kept running everywhere during a
    // temp-disable-manager.js pause. See that function's comment for the
    // full history; same fix, same shared buildSiteModeMatchScope().
    const { matches: siteModeMatches, excludeMatches: siteModeExcludes } = precomputedScope ?? await buildSiteModeMatchScope();
    if ( siteModeMatches.length === 0 ) {
        return browser.scripting.unregisterContentScripts({
            ids: (await browser.scripting.getRegisteredContentScripts())
                .filter(s => s.id.startsWith(COSMETIC_CS_PREFIX))
                .map(s => s.id),
        }).catch(catchExpected('unregister cosmetic content scripts', [ EXPECTED_ERRORS.SCRIPT_NOT_REGISTERED ]));
    }

    const enabledRulesets = await getEnabledRulesets();

    let cosmeticFiles = cosmeticFilesCache;
    if ( cosmeticFiles === undefined ) {
        try {
            const resp = await fetch(browser.runtime.getURL('/rulesets/cosmetic-files.json'));
            cosmeticFiles = await resp.json();
            cosmeticFilesCache = cosmeticFiles;
        } catch {
            return;
        }
    }

    // Every entry SHOULD carry specificDataFile/loaderFile (build-rulesets.mjs
    // always writes them now) — the `Boolean(...)` check stays as a real
    // guard, not decoration, against a stale/partial rulesets/ directory
    // (e.g. a build interrupted mid-run) rather than silently registering
    // a broken directive with undefined path segments in its `js` array.
    const wantedEntries = cosmeticFiles.filter(({ id, specificDataFile, loaderFile }) =>
        ((ALWAYS_ON_RULESETS.has(id) && !bypassAlwaysOnIds?.has(id)) || enabledRulesets.has(id)) &&
        Boolean(specificDataFile) && Boolean(loaderFile)
    );

    // (11.1.0) One directive for all wanted lists (COSMETIC_CS_ID); none when no list is wanted.
    const toRegister = wantedEntries.length === 0 ? [] : [ {
        id: COSMETIC_CS_ID,
        js: [ ...COSMETIC_SPECIFIC_SHARED_JS, ...wantedEntries.map(entry => `/${entry.loaderFile}`), COSMETIC_SPECIFIC_READER_JS ],
        matches: siteModeMatches,
        world: 'ISOLATED',
        allFrames: true,
        runAt: 'document_start',
    } ];
    if ( toRegister.length > 0 && siteModeExcludes.length > 0 ) {
        toRegister[0].excludeMatches = siteModeExcludes;
    }

    // ── GUARD: init — ensure chrome.storage.local has fresh data for every
    // ruleset about to be registered. Version-checked
    // (COSMETIC_SPECIFIC_VERSION_FIELD, stamped at build time from the
    // data's own content) so a registration pass triggered by something
    // unrelated (a site-mode change, a different ruleset's toggle) doesn't
    // re-fetch/re-write data that hasn't actually changed since last time.
    const registry = await localRead(COSMETIC_SPECIFIC_REGISTRY_KEY).catch(catchExpected('read cosmetic registry', [])) ?? {};
    const nextRegistry = { ...registry };
    for ( const entry of wantedEntries ) {
        if ( registry[entry.id] === entry.v ) { continue; } // already current
        try {
            const resp = await fetch(browser.runtime.getURL(`/${entry.specificDataFile}`));
            const data = await resp.json();
            await localWrite(`${COSMETIC_SPECIFIC_STORAGE_PREFIX}${entry.id}`, data);
            nextRegistry[entry.id] = data[COSMETIC_SPECIFIC_VERSION_FIELD] ?? entry.v;
        } catch (reason) {
            console.error(`[uBlock-Dynamic] cosmetic specific-data init (${entry.id}):`, reason);
            // Leave nextRegistry[entry.id] as whatever it was — a failed
            // write must not be recorded as if it succeeded, or a real
            // future data change for this ruleset could be skipped by the
            // version check above.
        }
    }

    // ── GUARD: clear/release — any ruleset this function has EVER written
    // storage-backed data for, but that is no longer wanted this pass
    // (disabled, or missing required build fields), gets its
    // chrome.storage.local entry removed and its registry entry dropped.
    // Prevents storage.local from silently accumulating cosmetic data for
    // rulesets the user long ago turned off.
    const wantedRulesetIds = new Set(wantedEntries.map(e => e.id));
    const staleIds = Object.keys(registry).filter(id => !wantedRulesetIds.has(id));
    // (audit 10.6.4, C5) Both storage calls below used to swallow errors silently. A failed remove
    // used to drop the ids from the registry anyway, so the data stayed in storage.local with
    // nothing left pointing at it — never cleaned up. Now: logged, and the ids stay in the
    // registry so the next registration pass retries the removal.
    if ( staleIds.length > 0 ) {
        const removed = await localRemove(staleIds.map(id => `${COSMETIC_SPECIFIC_STORAGE_PREFIX}${id}`)).then(
            ( ) => true,
            reason => {
                console.error('[uBlock-Dynamic] cosmetic specific-data release (stale ids kept for retry):', staleIds, reason);
                return false;
            }
        );
        if ( removed ) {
            for ( const id of staleIds ) { delete nextRegistry[id]; }
        }
    }
    if ( Object.keys(registry).some(id => registry[id] !== nextRegistry[id]) ||
         wantedEntries.some(e => registry[e.id] !== nextRegistry[e.id]) ) {
        await localWrite(COSMETIC_SPECIFIC_REGISTRY_KEY, nextRegistry).catch(reason => {
            console.error('[uBlock-Dynamic] cosmetic specific-data registry write:', reason);
        });
    }

    // Every registration with the prefix — the one current id AND the per-list ids from 11.0.4 and earlier, so the
    // stale ones are unregistered just below (GUARD: release).
    let existing = [];
    try {
        existing = (await browser.scripting.getRegisteredContentScripts())
            .filter(s => s.id.startsWith(COSMETIC_CS_PREFIX));
    } catch {
        existing = [];
    }

    const existingMap = new Map(existing.map(s => [s.id, s]));
    const wantedIds = new Set(toRegister.map(s => s.id));

    const toRemove = [...existingMap.keys()].filter(id => !wantedIds.has(id));
    if ( toRemove.length ) {
        await browser.scripting.unregisterContentScripts({ ids: toRemove }).catch(catchExpected('unregister stale cosmetic content scripts', [ EXPECTED_ERRORS.SCRIPT_NOT_REGISTERED ]));
    }

    await registerOrUpdateContentScripts(toRegister, existingMap, {
        updateErrorLabel: '[uBlock-Dynamic] updateContentScripts (cosmetic):',
        registerErrorLabel: '[uBlock-Dynamic] registerContentScripts (cosmetic):',
    });
    // (11.1.0) GUARD (clear): the per-site cache holds the selectors of the lists registered when a site was last
    // visited. Only the full registerContentScripts() cleared it; a list switched on or off in Filter lists
    // (ruleset-routes.js) and the Seamless surfing passes (cookie-clicker-autodeny-manager.js) call this function
    // alone, so a site visited before kept the old lists' selectors until the browser restarted. Masked until now by
    // the one-reader bug (COSMETIC_CS_ID): the cache then held one list's selectors only.
    await resetCSSCache();
}

/******************************************************************************/
// Cookie/consent-clicker content script registration
//
// See COOKIE-CLICKER-DESIGN.md for the full design history. ONE small,
// this-project-owned content script (js/scripting/cookie-clicker-click.js
// — NOT AdGuard's `trusted-click-element`, see that design doc's "The
// 'trusted-' scriptlet question — resolved" section for why that trust
// tier was never actually needed) is registered ISOLATED-world,
// allFrames: true — the concrete, specific fix for the exact bug the
// design doc diagnosed in the ORIGINAL (picker-based) attempt at this
// feature: without allFrames: true, a script can only ever run in a
// page's top frame, and most real cookie-consent platforms (OneTrust,
// Cookiebot, Quantcast, TrustArc, etc.) render their actual "Accept"
// button inside a cross-origin iframe. allFrames: true means this script
// runs SEPARATELY, natively, inside every frame — including third-party
// CMP iframes — so it never needs to reach across the cross-origin
// boundary at all (impossible) — the click code is just already there,
// in the same origin as the button. Same fix shape as
// registerScriptletContentScriptsImpl()/registerCosmeticContentScriptsImpl()
// just above, applied to a brand new registration group instead of an
// existing one.
//
// Unlike scriptlets/cosmetic rules (bundled filter-list data, baked into
// per-ruleset files at build time), cookie-clicker rules are entirely
// user-created (via the picker, js/scripting/cookie-clicker-picker.js)
// and few in number — tens, not thousands — so there's no per-ruleset
// sharding here: ONE content-script directive, registered whenever ANY
// rule exists anywhere, unregistered (RELEASE guard) the moment none do.
// The script itself reads the flat rule set straight from
// chrome.storage.local at injection time (see that file's own header)
// and filters to whatever's relevant to its own frame — mirroring how
// css-specific.js reads its own storage-backed data at injection time,
// just without that file's per-ruleset sharding/build-time-generation
// step, since there's no build step for user-created rules.
/******************************************************************************/

// Must not collide with SCRIPTLET_CS_PREFIX ('ag-scriptlets-'),
// COSMETIC_CS_PREFIX ('ag-cosmetic-'), or
// AUTO_DENY_CS_ID ('ubol-autodeny') — same cross-reference invariant this
// file's header warns about. Not a prefix (only ever one directive, not
// one per ruleset) but named with the same 'CS_ID' suffix convention for
// readability at the call sites below.
const COOKIE_CLICKER_CS_ID = 'ubol-cookie-clicker';

// STORAGE KEY — must match js/core/cookie-clicker-rules.js's own
// STORAGE_KEY constant (that file owns every WRITE to this key; this
// function only ever READS it, to answer "is there anything to
// register?"). Also must match js/scripting/cookie-clicker-click.js's
// own hardcoded read of the same key. Three independent copies of one
// string is one more than ideal, but the three files live in different
// execution contexts (service worker / service worker / content script)
// with no shared import surface between the last one and the other two —
// same constraint COSMETIC_SPECIFIC_STORAGE_PREFIX's own "must match
// exactly" comment already documents for the identical problem.
const COOKIE_CLICKER_STORAGE_KEY = 'cookieClicker.rules';

async function hasAnyCookieClickerRulesStored() {
    // (v8.6.16) Restored — DPG Media's built-in rule is back (per
    // explicit clarification: it belongs in the always-on manual
    // cookie-clicker system, not Worry-free/auto-deny) — at least one
    // site always has real rules now, independent of anything the user
    // has ever created via the picker. Kept as an explicit constant here
    // (duplicated, not shared — no import surface between this service-
    // worker file and the injected content script, same posture as
    // COOKIE_CLICKER_STORAGE_KEY's own "three independent copies"
    // comment just above) rather than silently deleting the RELEASE
    // guard below — if every built-in is ever removed, flipping this
    // back to false restores the original "off by default" behavior
    // automatically.
    const HAS_BUILTIN_COOKIE_CLICKER_RULES = true;
    if ( HAS_BUILTIN_COOKIE_CLICKER_RULES ) { return true; }
    const stored = await localRead(COOKIE_CLICKER_STORAGE_KEY).catch(catchExpected('read cookie clicker rules', []));
    if ( typeof stored !== 'object' || stored === null ) { return false; }
    return Object.values(stored).some(siteRules => Array.isArray(siteRules) && siteRules.length > 0);
}

export async function registerCookieClickerContentScripts() {
    // (10.4.9) Every caller of this function has just changed the cookie-clicker rules (or the site-mode scope), so the
    // auto-deny registration is refreshed in the same locked pass: its exclude list and the rule-site list
    // (COOKIE_CLICKER_RULE_SITES_KEY) must follow the rules at once. A no-op unregister when no session is active.
    return withRegistrationLock(async scope => {
        const siteModeScope = scope ?? await buildSiteModeMatchScope();
        await registerCookieClickerContentScriptsImpl(siteModeScope);
        await registerCookieClickerAutoDenyContentScriptsImpl(siteModeScope);
    });
}
async function registerCookieClickerContentScriptsImpl(precomputedScope) {
    // Same site-mode / temp-disable gating as scriptlets and cosmetic
    // rules just above — a site the user turned OFF, or a global
    // temp-disable pause, must stop the consent-clicker too, not just
    // DNR network blocking.
    const { matches: siteModeMatches, excludeMatches: siteModeExcludes } = precomputedScope ?? await buildSiteModeMatchScope();

    // RELEASE guard: nowhere left to inject into (site-mode scope empty)
    // — unregister rather than leave a permanently-registered-but-never-
    // matching script behind. The "no rules anywhere" half of this guard
    // is now permanently false in practice (DPG Media's built-in rule —
    // see hasAnyCookieClickerRulesStored()'s own comment), so this now
    // registers whenever the site-mode scope is non-empty, effectively
    // always — the per-site "nothing to do here" check still lives
    // inside cookie-clicker-click.js itself, same as it always did for
    // the many sites that were never matched even when this guard was
    // still meaningfully conditional.
    const hasRules = siteModeMatches.length > 0 && await hasAnyCookieClickerRulesStored();
    if ( hasRules === false ) {
        return browser.scripting.unregisterContentScripts({
            ids: [ COOKIE_CLICKER_CS_ID ],
        }).catch(catchExpected('unregister cookie clicker content scripts', [ EXPECTED_ERRORS.SCRIPT_NOT_REGISTERED ]));
    }

    const directive = {
        id: COOKIE_CLICKER_CS_ID,
        js: [
            '/js/scripting/isolated-api.js',    // self.isolatedAPI — same shared file cosmetic rules use, for topHostname/thisHostname (document.location.ancestorOrigins-based, works inside cross-origin iframes)
            '/js/scripting/cookie-clicker-click.js',
        ],
        matches: siteModeMatches,
        world: 'ISOLATED',
        allFrames: true,
        // 'document_idle' (not 'document_start' like scriptlets/security,
        // which need to run BEFORE page scripts to intercept APIs) — a
        // consent banner's own DOM usually doesn't exist yet at
        // document_start, and this script's job is purely to find/click
        // an already-rendered element, not to race the page's own
        // scripts. The click interpreter's own MutationObserver-based
        // wait-and-click (see that file) still covers a banner that
        // renders even later than document_idle, so this is a
        // "reasonable default start point", not a hard timing
        // requirement.
        runAt: 'document_idle',
    };
    if ( siteModeExcludes.length > 0 ) {
        directive.excludeMatches = siteModeExcludes;
    }

    let existing = [];
    try {
        existing = await browser.scripting.getRegisteredContentScripts({
            ids: [ COOKIE_CLICKER_CS_ID ],
        });
    } catch {
        existing = [];
    }

    if ( existing.length > 0 ) {
        await browser.scripting.updateContentScripts([ directive ]).catch(reason => {
            console.error('[uBlock-Dynamic] updateContentScripts (cookie-clicker):', reason);
        });
    } else {
        await browser.scripting.registerContentScripts([ directive ]).catch(reason => {
            console.error('[uBlock-Dynamic] registerContentScripts (cookie-clicker):', reason);
        });
    }
}

/******************************************************************************/
// Never-consent / cookie-clicker auto-deny content script registration
// (v8.2)
//
// A generic, unattended "auto-deny" action bundle (js/scripting/autodeny-
// snippets.generated.js — vendored, build-time-compiled from DDG's
// autoconsent eval-snippets, see that file's own header) registered
// MAIN-world, allFrames: true (consent banners routinely render inside
// cross-origin CMP iframes, same reasoning as the cookie-clicker group
// just above), document_idle + the bundle's own internal retry/poll (D4
// — CMP globals like window.Didomi/window.Cookiebot may not exist yet at
// document_start).
//
// Registration-presence IS the on/off switch itself (D11) — NOT a
// priority/skip-flag check inside the bundle. Default state is fully
// unregistered: zero bytes reach any page until a session is actually
// started via js/core/cookie-clicker-autodeny-manager.js's
// startAutoDeny(). Called from exactly two places: startAutoDeny() (init)
// and restoreNow() (release) — no third call site, mirroring the cookie-
// clicker group's own two-call-site convention.
/******************************************************************************/

// Must not collide with SCRIPTLET_CS_PREFIX ('ag-scriptlets-'),
// COSMETIC_CS_PREFIX ('ag-cosmetic-'), or
// COOKIE_CLICKER_CS_ID ('ubol-cookie-clicker') — same cross-reference
// invariant this file's header warns about.
const AUTO_DENY_CS_ID = 'ubol-autodeny';

// STORAGE KEY — must match js/core/cookie-clicker-autodeny-manager.js's
// own STORAGE_KEY constant (that module owns every WRITE to this key;
// this function only ever READS it, to answer "is a session active?").
// Read directly here, rather than importing getAutoDenyState() from that
// module, deliberately — the same choice COOKIE_CLICKER_STORAGE_KEY just
// above already makes for the identical reason: importing a core/ module
// that itself imports THIS module's own registration function back would
// be a circular import. One more independent copy of one string, same
// "must match exactly" posture as COOKIE_CLICKER_STORAGE_KEY.
const AUTO_DENY_STORAGE_KEY = 'cookieClicker.autoDeny';

async function isAutoDenySessionActive() {
    const stored = await localRead(AUTO_DENY_STORAGE_KEY).catch(catchExpected('read auto-deny state', []));
    if ( typeof stored !== 'object' || stored === null ) { return false; }
    // Self-heal is getAutoDenyState()'s job (path 2, see that module's own
    // header) — this function is a cheap, read-only "is it plausibly on"
    // check for registration purposes only, so a session whose expiry has
    // technically already passed but hasn't yet been read/self-healed is
    // still treated as active for one extra registration pass at most;
    // getAutoDenyState()'s own self-heal (called on every popup poll, and
    // on the alarm firing) is what actually tears the registration back
    // down moments later via restoreNow()'s own release call. Never a
    // permanent leak — just a harmless few-second-wide race window.
    return stored.active === true;
}

// ── Cookie-clicker rule sites vs. auto-deny (10.4.9, owner's decision: "Cookie consent clicker rules always
// prevail above Worry-free trying to decline cookies") ────────────────────────────────────────────────────────
// Two layers, no delay for any site without a rule:
//   1. EXCLUDE: every site with a saved or built-in cookie-clicker rule is added to the auto-deny bundle's
//      excludeMatches, so the bundle never runs in that site's own frames.
//   2. MARK: a CMP frame inside such a site (consent.cookiebot.com …) cannot be excluded by URL without disabling
//      auto-deny for that CMP on every site. A tiny ISOLATED script (js/scripting/cookie-clicker-precedence.js),
//      registered only while a session is active, marks such frames at document_start; the bundle (document_idle)
//      sees the D5 marker and stays out. While its one storage read is pending it sets a "pending" mark the bundle
//      treats as "retry later", so even a slow read can never let the bundle go first.
// Cost: (1) none per page; (2) only during an auto-deny session, one tiny script per frame, top frames exit at once,
// subframes do one read of one small key.

// Must not collide with any other CS id (AUTO_DENY_CS_ID, COOKIE_CLICKER_CS_ID, prefixes — see the header).
const AUTO_DENY_PRECEDENCE_CS_ID = 'ubol-autodeny-precedence';

// STORAGE KEY of the derived rule-site list — written ONLY here (on every auto-deny registration), read by
// js/scripting/cookie-clicker-precedence.js (must match its RULE_SITES_STORAGE_KEY exactly; no shared import
// surface between a content script and this file — same posture as COOKIE_CLICKER_STORAGE_KEY above).
const COOKIE_CLICKER_RULE_SITES_KEY = 'cookieClicker.ruleSites';

// Sites with a BUILT-IN rule — must match the keys of js/scripting/cookie-clicker-click.js's BUILTIN_SITE_RULES
// (content script, no shared import surface; same posture as HAS_BUILTIN_COOKIE_CLICKER_RULES above).
const BUILTIN_COOKIE_CLICKER_SITES = Object.freeze([ 'myprivacy.dpgmedia.nl' ]);

// A hostname that can safely go into a match pattern (a malformed one would make the WHOLE registration fail).
const MATCH_PATTERN_HOSTNAME_RE = PLAIN_HOSTNAME_RE;   // (11.0.2) shared shape, underscores allowed

// Every site (top hostname) with at least one enabled-or-unspecified cookie-clicker rule, sorted, de-duplicated.
async function getCookieClickerRuleSites() {
    const sites = new Set(BUILTIN_COOKIE_CLICKER_SITES);
    const stored = await localRead(COOKIE_CLICKER_STORAGE_KEY).catch(catchExpected('read cookie clicker rules', []));
    if ( typeof stored === 'object' && stored !== null ) {
        for ( const [ site, rules ] of Object.entries(stored) ) {
            if ( Array.isArray(rules) && rules.some(r => r?.enabled !== false) ) { sites.add(site.toLowerCase()); }
        }
    }
    return [ ...sites ].filter(h => MATCH_PATTERN_HOSTNAME_RE.test(h)).sort();
}

// ── (11.0.0, owner's decisions 2026-11-19) Seamless surfing's site-specific cookie-notice sets ────────────────────────
// What they are and what each mode runs: js/data/cookie-notice-sets.js. Registered ONLY while a session runs, in the
// session's mode, beside the click bundle and in the same pass (so a saved clicker rule, a site switched off or a mode
// change reaches them at once). Each registration is matched to its own file's sites only; saved-rule sites are in
// every excludeMatches (saved rules prevail). Hide rules go through css-api.js -> the background's insertCSS.
const COOKIE_NOTICE_CSS_API_JS = '/js/scripting/css-api.js';
// Every id these registrations may use — RELEASE unregisters whichever of them is registered.
const COOKIE_NOTICE_OWN_IDS = Object.freeze([
    COOKIE_NOTICE_SCRIPTLET_CS_ID,
    ...Array.from({ length: COOKIE_NOTICE_HIDE_SHARDS }, (_, i) => `${COOKIE_NOTICE_HIDE_CS_ID}-${i}`),
]);
// The sites file (package data, read once per service-worker life; a failed read is retried on the next pass).
let cookieNoticeSitesCache = null;
async function readCookieNoticeSites() {
    if ( cookieNoticeSitesCache !== null ) { return cookieNoticeSitesCache; }
    try {
        const parsed = await (await fetch(browser.runtime.getURL(`/${COOKIE_NOTICE_SITES_FILE}`))).json();
        // Input validation (C6): the two maps must be objects of string arrays; anything else reads as "no sites".
        function isSiteList(v) { return Array.isArray(v) && v.every(h => typeof h === 'string'); }
        if ( typeof parsed?.scriptlets !== 'object' || typeof parsed?.hide !== 'object' ) { throw new TypeError('unexpected shape'); }
        cookieNoticeSitesCache = {
            scriptlets: Object.fromEntries(Object.entries(parsed.scriptlets).filter(([ , v ]) => isSiteList(v))),
            hide: Object.fromEntries(Object.entries(parsed.hide).filter(([ , v ]) => Array.isArray(v) && v.every(isSiteList))),
        };
    } catch (reason) {
        console.error('[uBlock-Dynamic] cookie notices: cannot read the sites file:', reason);
        return { scriptlets: {}, hide: {} };
    }
    return cookieNoticeSitesCache;
}
// The directives of one mode (an empty list when the mode's files name no site in this site-mode scope).
async function cookieNoticeDirectives(modeFiles, siteModeScope, ruleSitePatterns) {
    const sites = await readCookieNoticeSites();
    const directives = [];
    function scoped(siteKeys) {
        const { matches, excludeMatches } = buildScriptletScopes(siteKeys, siteModeScope).sites;
        if ( matches.length === 0 ) { return null; }
        const all = [ ...excludeMatches, ...ruleSitePatterns ];
        return all.length > 0 ? { matches, excludeMatches: all } : { matches };
    }
    const scriptletScope = scoped(sites.scriptlets[modeFiles.mode] ?? []);
    if ( scriptletScope !== null ) {
        directives.push({
            id: COOKIE_NOTICE_SCRIPTLET_CS_ID,
            js: [ `/${COOKIE_NOTICE_LIBRARY_FILE}`, `/${modeFiles.scriptlets}`, `/${COOKIE_NOTICE_LIBRARY_END_FILE}` ],
            ...scriptletScope, ...SCRIPTLET_INJECTION,
        });
    }
    if ( modeFiles.hideFamily !== null ) {
        const shards = sites.hide[modeFiles.hideFamily] ?? [];
        for ( let i = 0; i < Math.min(shards.length, COOKIE_NOTICE_HIDE_SHARDS); i++ ) {
            const scope = scoped(shards[i]);
            if ( scope === null ) { continue; }
            directives.push({
                id: `${COOKIE_NOTICE_HIDE_CS_ID}-${i}`,
                js: [ COOKIE_NOTICE_CSS_API_JS, `/${cookieNoticeHideFile(modeFiles.hideFamily, i)}` ],
                ...scope, world: 'ISOLATED', allFrames: true, runAt: 'document_start',
            });
        }
    }
    return directives;
}

export async function registerCookieClickerAutoDenyContentScripts() {
    return withRegistrationLock(registerCookieClickerAutoDenyContentScriptsImpl);
}
async function registerCookieClickerAutoDenyContentScriptsImpl(precomputedScope) {
    const siteModeScope = precomputedScope ?? await buildSiteModeMatchScope();
    const { matches: siteModeMatches, excludeMatches: siteModeExcludes } = siteModeScope;
    const ownIds = [ AUTO_DENY_CS_ID, AUTO_DENY_PRECEDENCE_CS_ID, ...COOKIE_NOTICE_OWN_IDS ];

    // RELEASE guard (D11) — checked BEFORE anything else touches
    // browser.scripting, so the overwhelmingly common case (feature never
    // turned on) costs one cheap storage read and injects nothing —
    // literally zero bytes reach any page, not "injected but inert".
    const active = siteModeMatches.length > 0 && await isAutoDenySessionActive();
    if ( active === false ) {
        // (10.7.16) RELEASE: no session -> no CMP loader block, (11.0.0) no cookie-notice block rules either.
        await syncCmpLoaderBlockRules(false);
        // (11.0.0) Only the ids that ARE registered: Chrome rejects the whole call when one id is not, which would leave
        // the others registered (the cookie-notice ids vary with the mode and the site-mode scope).
        const registered = await browser.scripting.getRegisteredContentScripts({ ids: ownIds })
            .catch(catchExpected('list cookie banner content scripts', [])) ?? [];
        if ( registered.length === 0 ) { return; }
        return browser.scripting.unregisterContentScripts({
            ids: registered.map(cs => cs.id),
        }).catch(catchExpected('unregister cookie clicker rule-site content scripts', [ EXPECTED_ERRORS.SCRIPT_NOT_REGISTERED ]));
    }

    // Layer 1 + the list layer 2 reads (written before registering, so a frame can never read a stale list).
    const ruleSites = await getCookieClickerRuleSites();
    const storedSites = await localRead(COOKIE_CLICKER_RULE_SITES_KEY).catch(catchExpected('read cookie clicker rule sites', []));
    if ( JSON.stringify(storedSites) !== JSON.stringify(ruleSites) ) {   // write only on change (no storage churn)
        await localWrite(COOKIE_CLICKER_RULE_SITES_KEY, ruleSites);
    }
    const bundleExcludes = [ ...siteModeExcludes, ...ruleSites.map(h => `*://${h}/*`) ];

    // (10.7.16, owner's decision 2026-11-19) CMP loader blocks (Sourcepoint): only while banners are DECLINED; in
    // ACCEPT mode the dialog stays so it can be accepted. Same rule-site exemption as the bundle just above
    // (saved cookie-clicker rules prevail). Never throws — see cmp-loader-block-manager.js's own guards.
    const mode = cookieBannerActionFor(securityConfig);
    const declining = mode === COOKIE_BANNER_ACTIONS.DECLINE;
    // (11.0.0) The mode's cookie-notice files (js/data/cookie-notice-sets.js): its block rules join the loader blocks here.
    const modeFiles = { mode, ...COOKIE_NOTICE_MODE_FILES[mode] };
    await syncCmpLoaderBlockRules(declining, ruleSites, modeFiles.blocks);

    const directive = {
        id: AUTO_DENY_CS_ID,
        // (10.7.1) decline or accept bundle — derived from the cookie clean-up setting (cookie-banner-action.js).
        // A changed path is an update of the same id (registerOrUpdateContentScripts), so a switch never leaves both.
        js: [ cookieBannerBundleFor(securityConfig) ],
        matches: siteModeMatches,
        world: 'MAIN',
        allFrames: true,
        runAt: 'document_idle', // D4 — bundle's own retry/poll still covers a CMP global that appears even later
    };
    if ( bundleExcludes.length > 0 ) {
        directive.excludeMatches = bundleExcludes;
    }
    // Layer 2 — same site-mode scope as the bundle itself (a site the user turned OFF gets neither).
    const precedenceDirective = {
        id: AUTO_DENY_PRECEDENCE_CS_ID,
        js: [ '/js/scripting/cookie-clicker-precedence.js' ],
        matches: siteModeMatches,
        world: 'ISOLATED',
        allFrames: true,
        runAt: 'document_start', // before the bundle's document_idle — see the layer comment above
    };
    if ( siteModeExcludes.length > 0 ) {
        precedenceDirective.excludeMatches = siteModeExcludes;
    }
    // (11.0.0) The mode's cookie-notice scriptlet and hide registrations (same site-mode scope, saved-rule sites excluded).
    const ruleSitePatterns = ruleSites.map(h => `*://${h}/*`);
    const directives = [ directive, precedenceDirective, ...await cookieNoticeDirectives(modeFiles, siteModeScope, ruleSitePatterns) ];

    let existing = [];
    try {
        existing = await browser.scripting.getRegisteredContentScripts({
            ids: ownIds,
        });
    } catch {
        existing = [];
    }
    const existingMap = new Map(existing.map(cs => [ cs.id, cs ]));
    // C25 HARD CONSTRAINT: two directives since 10.4.9 -> the shared batch helper (per-item fallback on a rejected
    // batch, so a broken precedence directive can never stop the bundle itself from registering).
    await registerOrUpdateContentScripts(directives, existingMap, {
        updateErrorLabel: '[uBlock-Dynamic] updateContentScripts (autodeny):',
        registerErrorLabel: '[uBlock-Dynamic] registerContentScripts (autodeny):',
    });
    // (11.0.0) CLEAR guard: a cookie-notice registration this pass no longer wants (mode switched to one without hide
    // rules, a shard left the site-mode scope) is unregistered — only ids that are registered (see the RELEASE path).
    const wantedIds = new Set(directives.map(d => d.id));
    const stale = [ ...existingMap.keys() ].filter(id => !wantedIds.has(id));
    if ( stale.length > 0 ) {
        await browser.scripting.unregisterContentScripts({ ids: stale })
            .catch(catchExpected('unregister stale cookie-notice content scripts', [ EXPECTED_ERRORS.SCRIPT_NOT_REGISTERED ]));
    }
}

/******************************************************************************/
// (audit 10.6.4, owner's decision) Security scriptlet registration REMOVED: registerSecurityContentScripts(),
// registerSecurityContentScriptsImpl() and the 'sec-' id prefix. No security scriptlet exists since 10.5.0
// (blockPings/sec-pings removed); the function's only remaining job was unregistering stale 'sec-*'
// registrations left by versions before 10.5.0, which the owner chose to drop.
/******************************************************************************/

/******************************************************************************/
// Per-site CSS cache helpers (see also pruneCSSCache() further below, which
// bounds this cache's size on the CSS_CACHE_PRUNE_INTERVAL_MS timer).
// (10.7.6, audit 10.7.5 D-5) In storage.local since session storage is closed to content scripts — the cache is
// written by js/scripting/css-specific.js (a content script, so it cannot import this prefix; keep both in step).
// Cleared here on every full registration (browser start included), so it never outlives a session in practice.
const CSS_CACHE_KEY_PREFIX = 'cache.css.';

async function resetCSSCache() {
    const keys = await localKeys() || [];
    return localRemove(keys.filter(a => a.startsWith(CSS_CACHE_KEY_PREFIX)));
}

/******************************************************************************/
// Main orchestration — full re-registration pass, triggered on startup and
// whenever filtering-mode/ruleset/permission state changes elsewhere.

// Issue: Safari appears to completely ignore excludeMatches
// https://github.com/radiolondra/ExcludeMatches-Test

// The mutex mechanism itself now lives in js/util/async-lock.js (see
// registrationLock above for the same extraction). .pendingOp is still
// assigned on every call — not just returned — so anything that reads this
// property later (see mode-manager.js's own comment citing this exact
// "function-as-namespace" convention) keeps seeing a live, correct promise.
const pendingOpLock = createLock('scripting-manager/registerContentScripts.pendingOp');

export async function registerContentScripts() {
    if ( browser.scripting === undefined ) { return false; }
    registerContentScripts.pendingOp = pendingOpLock.withLock(
        ( ) => registerContentScripts.register()
    );
    return registerContentScripts.pendingOp;
}
registerContentScripts.pendingOp = Promise.resolve();

registerContentScripts.register = async function register() {
    const filteringModeDetails = await getFilteringModeDetails();
    const toAdd = [];
    const context = {
        filteringModeDetails,
        toAdd,
    };

    await Promise.all([
        registerCustomFilters(context),
        registerToolbarIconToggler(context),
    ]);

    // withRegistrationLock() still guards this batch against a race with
    // any of these same four groups' own public wrapper being called
    // concurrently from elsewhere (e.g. a picker rule addition firing
    // registerCookieClickerContentScripts() while a site-mode change is
    // also mid-registration) — see that guard's own history for the
    // "does not exist or is not fully registered" errors it exists to
    // prevent. No longer preceded by a blanket unregisterContentScripts()
    // wipe (removed — see OPTIMIZE.md 1.1 for the full history and why
    // it was safe to remove only once every path here, including
    // css-user just above, had its own existing-vs-wanted diff): each of
    // these four already unregisters its own stale entries and
    // updates/registers only what actually changed, so removing the
    // wipe only removes redundant work — every call previously rebuilt
    // all four groups from scratch regardless of which one, if any,
    // actually had anything to change.
    // Computed once and shared with the four consumers below that each
    // previously called buildSiteModeMatchScope() independently for an
    // identical result (see OPTIMIZE.md 1.3). Each of those four still
    // accepts no argument and computes this itself when called on its
    // own via its public wrapper (e.g. a single cookie-clicker rule
    // addition) — only this shared batch path benefits.
    const siteModeScope = await buildSiteModeMatchScope();

    await withRegistrationLock(async ( ) => {
        await Promise.all([
            registerScriptletContentScriptsImpl(siteModeScope),
            registerCosmeticContentScriptsImpl(siteModeScope),
            registerCookieClickerContentScriptsImpl(siteModeScope),
            registerCookieClickerAutoDenyContentScriptsImpl(siteModeScope),
        ]);
    });

    // css-user is the one id registerCustomFilters() (filter-manager.js)
    // can push into toAdd — must match that function's own literal id
    // string exactly. Not imported as a shared constant: filter-manager.js
    // sits below this module in the dependency order (this module imports
    // FROM it), so a shared constant would need to live in a third file;
    // one duplicated string is simpler, same tradeoff AUTO_DENY_STORAGE_KEY
    // above already documents for the identical reason.
    const CSS_USER_CS_ID = 'css-user';
    const wantedCssUserDirective = toAdd.find(d => d.id === CSS_USER_CS_ID);

    let existingCssUser = [];
    try {
        existingCssUser = await browser.scripting.getRegisteredContentScripts({
            ids: [ CSS_USER_CS_ID ],
        });
    } catch {
        existingCssUser = [];
    }

    if ( wantedCssUserDirective === undefined ) {
        if ( existingCssUser.length > 0 ) {
            await browser.scripting.unregisterContentScripts({
                ids: [ CSS_USER_CS_ID ],
            }).catch(catchExpected('unregister annoyances content scripts', [ EXPECTED_ERRORS.SCRIPT_NOT_REGISTERED ]));
        }
    } else if ( existingCssUser.length > 0 ) {
        await browser.scripting.updateContentScripts([ wantedCssUserDirective ]).catch(reason => {
            console.error(`[uBlock-Dynamic] updateContentScripts (css-user)/${reason}`);
        });
    } else {
        try {
            await browser.scripting.registerContentScripts([ wantedCssUserDirective ]);
        } catch(reason) {
            console.error(`[uBlock-Dynamic] registerContentScripts (css-user)/${reason}`);
        }
    }

    await Promise.all([
        resetCSSCache(),
        registerJob('pruneCSSCache', Date.now() + CSS_CACHE_PRUNE_INTERVAL_MS),
    ]);

    return true;
};

/******************************************************************************/
// Introspection

export async function getRegisteredContentScripts() {
    const scripts = await browser.scripting.getRegisteredContentScripts();
    return scripts.map(a => a.id);
}

/******************************************************************************/
// Generic, lock-guarded register/unregister primitives for modules outside
// this one that still need to register their own content scripts (currently:
// js/core/privacy-inspector.js's probe/bridge pair). Keeps this module the
// sole direct caller of browser.scripting.*, per the header comment, while
// still letting callers build their own directives — and, critically, keeps
// them inside withRegistrationLock() so they can't race the blanket wipe in
// registerContentScripts.register() the way an unguarded direct call would.
/******************************************************************************/

export async function registerContentScriptsSafely(directives) {
    return withRegistrationLock(async ( ) => {
        try {
            await browser.scripting.registerContentScripts(directives);
            return { ok: true };
        } catch (reason) {
            console.error('[uBlock-Dynamic] registerContentScriptsSafely:', reason);
            return { ok: false, error: String(reason?.message ?? reason) };
        }
    });
}

export async function unregisterContentScriptsByIds(ids) {
    return withRegistrationLock(async ( ) => {
        try {
            await browser.scripting.unregisterContentScripts({ ids });
        } catch (reason) {
            // Ids not currently registered is an expected outcome here (e.g. first-ever registration,
            // or already torn down); any other failure is logged (C5).
            catchExpected('unregister content scripts by id', [ EXPECTED_ERRORS.SCRIPT_NOT_REGISTERED ])(reason);
        }
        return { ok: true };
    });
}

/******************************************************************************/
// Per-site CSS cache pruning (bounds the cache resetCSSCache() clears in bulk
// — see that function further above).

export async function pruneCSSCache() {
    registerJob('pruneCSSCache', Date.now() + CSS_CACHE_PRUNE_INTERVAL_MS);
    const MAX_CACHE_ENTRY_LOW = 256;
    const MAX_CACHE_ENTRY_HIGH = MAX_CACHE_ENTRY_LOW +
        Math.max(Math.round(MAX_CACHE_ENTRY_LOW / 8), 8);
    const keys = await localKeys() || [];
    const cacheKeys = keys.filter(a => a.startsWith(CSS_CACHE_KEY_PREFIX));
    if ( cacheKeys.length < MAX_CACHE_ENTRY_HIGH ) { return; }
    const entries = await Promise.all(cacheKeys.map(async a => {
        const entry = await localRead(a) || {};
        entry.key = a;
        return entry;
    }));
    entries.sort((a, b) => b.t - a.t);
    await localRemove(entries.slice(MAX_CACHE_ENTRY_LOW).map(a => a.key));
}

/******************************************************************************/
// Debugging

// Debugging aid only — not used by any other module's actual control flow,
// so it can never become a hidden coupling. Delegates to each lock's own
// getState() (js/util/async-lock.js), which already returns a snapshot, not
// the live object. See the OBSERVABILITY note near the top of this file.
export function getScriptingManagerLockState() {
    return {
        registrationLock: registrationLock.getState(),
        pendingOp:        pendingOpLock.getState(),
    };
}

/******************************************************************************/
