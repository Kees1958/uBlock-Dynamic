/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2026-present Raymond Hill

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
 * compiled-filters.js — Sandbox ABP rule compilation (DNR rules only)
 *
 * Public interface:
 *   updateCompiledFilters()                — compiles sandbox ABP text via offscreen document;
 *                                            saves only DNR rules (network + cosmetic rules).
 *                                            Scriptlet rules (+js()) are compiled but their
 *                                            output is intentionally discarded — the userScripts
 *                                            permission has been removed in v3.12.
 *
 * State owned:
 *   compileLock     {Lock}    — serialises concurrent compile calls; lost on SW restart (safe)
 */


// Imported (subscribed) filter lists had no reachable UI to add one (that
// lived in the removed Filter lists tab), so all of that integration has
// been removed here too. Only sandbox filters are compiled/registered now.

import {
    localRead,
    localRemove,
    localWrite,
    runtime,
} from '../data/ext.js';

import {
    closeOffscreenDocument,
    createOffscreenDocument,
} from '../data/ext-offscreen.js';

import {
    getAllCustomFilters,
    getSandboxFilters,
} from './filter-manager.js';

import {
    isScriptlet,
} from '../util/utils.js';

import { dnr } from '../data/ext-compat.js';
import { stripExemptionOptionLines } from './exempt-domains.js';
import { extractPopunderLines } from '../util/popunder-parser.js';
import { getFilteringModeDetails } from './mode-manager.js';
import { createLock } from '../util/async-lock.js';
import { isTrustedSender } from '../util/trusted-sender.js';

/******************************************************************************/

// (audit 10.6.4) allowlistToExcludeMatches() removed with prepareSecurityScriptletDirectives(), its only user.

/******************************************************************************/

// ── Worry-free annoyances gate — RETIRED (10.0.7) ─────────────────────────────
// getWorryFreeAnnoyancesGate() / WORRY_FREE_ANNOYANCES_RULESET_ID are removed: ruleset_annoyances
// is now an ordinary always-on Built-in default list (scripting-manager.js ALWAYS_ON_RULESETS), so
// its hide rules and scriptlets are no longer session-gated at registration time.

/******************************************************************************/

// ── Security scriptlet registry — REMOVED (audit 10.6.4, owner's decision) ────
// SECURITY_SCRIPTLETS (empty since 10.5.0, when blockPings/sec-pings was removed) and
// prepareSecurityScriptletDirectives() are gone, together with scripting-manager.js's
// registerSecurityContentScripts(). buildSiteModeMatchScope() below stays: the scriptlet, cosmetic
// and cookie-clicker registrations all use it.

// Builds the base matches/excludeMatches for every content-script group from
// the current per-site filtering mode (siteModes / filteringModeDetails —
// see js/core/site-mode-manager.js and mode-manager.js), so that disabling
// uBOL-stripped for a site also disables every registered content script on that
// site, not just DNR-based blocking.
//
// BUG FIXED: prepareSecurityScriptletDirectives() previously had NO
// awareness of per-site OFF mode at all — it only excluded hostnames from
// securityAllowlist (the manually-typed per-toggle list) and, since 4.1.4,
// SECURITY_SCRIPTLET_BUILTIN_EXCLUDES. Content-script registration via
// chrome.scripting is not gated by DNR rule priority the way network
// blocking is, so the site-mode "OFF" allowAllRequests DNR rule (see
// ruleset-manager.js's filteringModesToDNR) had zero effect on these
// scriptlets — e.g. the obfuscated-eval blocker kept running and could
// still hang a login page's inline script even with uBOL-stripped
// explicitly disabled for that site.
//
// Mirrors filteringModesToDNR's own none/basic duality (core/ruleset-
// manager.js) rather than inventing different reverse-mode semantics here:
// normally `none` (OFF-mode hostnames) becomes excludeMatches against an
// <all_urls> base; in reverse mode (`none` contains the 'all-urls'
// sentinel — filtering OFF everywhere by default), `basic` (the explicit
// exception hostnames) becomes the matches list directly instead.
export async function buildSiteModeMatchScope() {
    const { none, basic } = await getFilteringModeDetails();
    function toHostPatterns(hostnames) { return [ ...hostnames ].flatMap(hn => [ `*://${hn}/*`, `*://*.${hn}/*` ]); }

    if ( none.has('all-urls') ) {
        // basic always carries a bookkeeping 'all-urls' member (see
        // filter-manager.js's registerCustomFilters() for the full
        // explanation and the real bug this same leak caused there).
        // Harmless here specifically — toHostPatterns() doesn't special-
        // case that string, so it just generates one unmatchable
        // '*://all-urls/*' pattern entry — but stripped anyway for
        // consistency with the one place this actually mattered.
        const realBasic = [ ...basic ].filter(hn => hn !== 'all-urls');
        return { matches: toHostPatterns(realBasic), excludeMatches: [], allowedHosts: realBasic };
    }
    // (10.5.6) allowedHosts: the hostnames `matches` stands for in reverse mode (null = every site) — the scriptlet
    // SITES registration intersects its own site list with them (js/util/scriptlet-site-scope.js).
    return { matches: [ '<all_urls>' ], excludeMatches: toHostPatterns(none), allowedHosts: null };
}

/******************************************************************************/

// How long to wait for the offscreen document to finish compiling filters
// before giving up. Generous on purpose: this runs rarely (only when the
// sandbox filters actually change) and involves fetching/bundling several
// support files (see toMv3Data() in offscreen/compile-filters.js).
const OFFSCREEN_COMPILE_TIMEOUT_MS = 60000;
// Converts OFFSCREEN_COMPILE_TIMEOUT_MS to seconds for the user-visible failure message.
const MS_PER_SECOND = 1000;
// Log prefix for this module's warnings — same prefix as the rest of the extension's logs.
const LOG_PREFIX = '[uBlock-Dynamic]';

/******************************************************************************/


/******************************************************************************/

async function getUserList() {
    const customFilters = await getAllCustomFilters();
    const lines = [];
    for ( const [ hostname, selectors ] of customFilters ) {
        for ( const selector of selectors ) {
            if ( isScriptlet(selector) === false ) { continue; }
            lines.push(`${hostname}##${selector}`);
        }
    }
    const sandboxFilters = await getSandboxFilters();
    if ( sandboxFilters ) {
        // "@@domain$worryfree" lines are per-site EXEMPTIONS (exempt-domains.js), not network rules, and
        // "@@domain$saferegions" lines are a retired option that is ignored (10.3.0): keep both out of the
        // compiler, which would otherwise reject or misread them.
        // (10.7.2) prevent-popunder lines configure the tab-under guard (core/tab-under-guard.js) and $popup/$popunder
        // lines are not supported: both kept out of the compiler, exactly as the build keeps them out of the
        // Quick-fixes list (js/util/popunder-parser.js). This also covers a $popup line saved before 10.7.2 that the
        // editor has not commented out yet (it is annotated on the next save).
        lines.push(extractPopunderLines(stripExemptionOptionLines(sandboxFilters)).remainingText);
    }
    return lines.join('\n').trim();
}

/******************************************************************************/

// This extension's own origin, as isTrustedSender() compares it (same derivation as background.js's UBOL_ORIGIN).
const EXTENSION_ORIGIN = runtime.getURL('').replace(/\/$/, '').toLowerCase();

async function parseRawFilters() {
    const {
        promise: offscreenPromise,
        resolve: offscreenResolve,
    } = Promise.withResolvers();
    function handler(request, sender, callback) {
        if ( typeof request !== 'object' ) { return; }
        if ( typeof request?.what !== 'string' || request.what.startsWith('compileFilters:') === false ) { return; }
        // (10.7.9, audit 10.7.8 — C28/F-TRUST-2) Only the offscreen compiler page (an extension page: own id AND own
        // origin) may ask for the person's filter text or deliver a compile result. A content script runs with the
        // page's origin and is refused, with a warning, like the main router refuses it.
        if ( isTrustedSender(sender, EXTENSION_ORIGIN, runtime.id) === false ) {
            console.warn(`[uBlock-Dynamic] compiled-filters: refused ${request.what} from an untrusted sender`);
            return;
        }
        switch ( request.what ) {
        case 'compileFilters:getResourceTypes':
            callback(Object.values(dnr.ResourceType));
            break;
        case 'compileFilters:getUserList':
            getUserList().then(text => {
                callback(text);
            });
            return true;
        case 'compileFilters:result':
            offscreenResolve(request);
            break;
        default:
            break;
        }
    }
    runtime.onMessage.addListener(handler);
    let timeoutId;
    const {
        promise: timeoutPromise,
        resolve: timeoutResolve,
    } = Promise.withResolvers();
    timeoutId = self.setTimeout(timeoutResolve, OFFSCREEN_COMPILE_TIMEOUT_MS);
    try {
        const [ result ] = await Promise.all([
            Promise.race([ offscreenPromise, timeoutPromise ]),
            createOffscreenDocument('/js/offscreen/compile-filters.html'),
        ]);
        if ( Boolean(result) === false ) {
            // The timeout won the race: the offscreen compiler never answered.
            return { error: `compiling took longer than ${OFFSCREEN_COMPILE_TIMEOUT_MS / MS_PER_SECOND} seconds` };
        }
        return result;
    } catch (reason) {
        // C5: report the failure to the caller instead of swallowing it (update() keeps the old rules).
        return { error: String(reason?.message ?? reason) };
    } finally {
        self.clearTimeout(timeoutId);
        runtime.onMessage.removeListener(handler);
        await closeOffscreenDocument();
    }
}

/******************************************************************************/

// prepareUserScripts / saveUserScripts / readUserScripts removed in v3.12.
// Sandbox ABP import here only produces DNR rules (network/cosmetic only).
// This offscreen compiler's own MAIN/ISOLATED scriptlet-shaped output is
// unused — that shape was for chrome.userScripts registration, and the
// userScripts permission has been removed from the manifest.
//
// This does NOT mean scriptlet rules go unsupported: they're independently
// re-parsed from the same raw sandbox text by the separate
// custom-scriptlets.js pipeline (syncScriptletRulesFromSandboxText(),
// invoked from filter-manager.js's setSandboxFilters()), which dispatches
// via chrome.scripting.executeScript instead — see that file's header for
// the supported syntaxes (uBO ##+js(...) and AdGuard #%#//scriptlet(...)).
// An earlier version of this comment claimed scriptlet rules weren't
// supported at all here, which stopped being true once that pipeline was
// added and was never updated to match — see also the (now corrected)
// comment in dashboard/dashboard.html above the Import ABP Rules pane.

/******************************************************************************/

async function saveSandboxDnrRules(rules) {
    const storageId = 'sandboxFilters.dnrRules';
    const beforeRules = await localRead(storageId);
    const afterRules = rules?.length && rules;
    const modified = JSON.stringify(afterRules) !== JSON.stringify(beforeRules);
    if ( modified === false ) { return false; }
    if ( Array.isArray(afterRules) ) {
        await localWrite(storageId, afterRules);
    } else {
        await localRemove(storageId);
    }
    return true;
}

/******************************************************************************/

// update() — compile sandbox ABP text and save DNR rules only.
// MAIN/ISOLATED scriptlet output from this offscreen compiler is
// intentionally ignored (userScripts permission removed, v3.12) — but
// scriptlet rules themselves ARE supported in the ABP import editor, via
// the separate custom-scriptlets.js/executeScript pipeline described above.
//
// Returns { ok: true } or { ok: false, error } (C5, 10.7.6). On failure the previously saved DNR rules stay
// active — same outcome as before — but the failure is now logged and reported to the caller, so the
// dashboard can tell the user their rules were saved but not applied.
async function update() {
    const hasUserFilters = await getUserList().then(a => Boolean(a));

    let result;
    if ( hasUserFilters ) {
        result = await parseRawFilters();
        if ( typeof result?.error === 'string' ) {
            console.warn(`${LOG_PREFIX} ABP import: compiling the rules failed, previous rules stay active:`, result.error);
            return { ok: false, error: result.error };
        }
    }

    await saveSandboxDnrRules(result?.sandbox?.dnrRules);
    // (10.7.6) Network lines that gave no rule, with the reason — the caller annotates them in the editor text.
    const rejectedLines = Array.isArray(result?.sandbox?.rejectedLines) ? result.sandbox.rejectedLines : [];
    return { ok: true, rejectedLines };
}

// A thrown failure becomes { ok: false, error } (C5): callers always get a report they can show, never a
// rejection (compileLock below already keeps later calls running after a failure).
async function updateNeverRejects() {
    try {
        return await update();
    } catch (reason) {
        const error = String(reason?.message ?? reason);
        console.warn(`${LOG_PREFIX} ABP import: applying the rules failed, previous rules stay active:`, error);
        return { ok: false, error };
    }
}

/******************************************************************************/

// This recompiles sandbox filters and saves DNR rules.
export async function updateCompiledFilters() {
    return compileLock.withLock(updateNeverRejects);
}


/******************************************************************************/

// Serialises concurrent compile/register calls so they never interleave.
// (10.7.6) createLock() (js/util/async-lock.js), not a raw `p = p.then(fn)` chain: with a raw chain ONE rejected
// step left the chain rejected, so every later step was skipped until the service worker restarted. The lock runs
// each step after the previous one SETTLED, and each caller still sees its own failure (C21: reuse the proven lock).
const compileLock = createLock('compiled-filters');
