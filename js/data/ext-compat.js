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
 * ext-compat.js — declarativeNetRequest (DNR) API compatibility shim
 *
 * Exports:
 *   dnr — normalised reference to chrome.declarativeNetRequest with
 *          consistent method names across Chrome versions
 */


import { deepEquals } from '../util/deep-compare.js';
import { catchExpected } from './expected-errors.js';

export const webext = self.browser || self.chrome;

// Lazy getter — declarativeNetRequest may not be defined at module parse
// time in some SW contexts. Accessed via function call at actual use.
// Custom methods (like setAllowAllRules) are stored on a separate target
// object so the Proxy can find them before falling through to the real API.
const dnrCustom = {};
export const dnr = new Proxy(dnrCustom, {
    get(target, prop) {
        if ( prop in target ) { return target[prop]; }
        const api = webext.declarativeNetRequest;
        if ( api === undefined ) { return undefined; }
        const val = api[prop];
        return typeof val === 'function' ? val.bind(api) : val;
    },
    set(target, prop, value) {
        target[prop] = value;
        return true;
    },
});

/******************************************************************************/


/******************************************************************************/

// KNOWN LIMITATION (browser/spec-level, not fixable here — see B5
// "architectural ceiling" convention): a network request initiated from
// a Worker (dedicated/shared/service worker) is not reliably exempted
// by an allowAllRequests rule, even when that rule matches the page's
// own main_frame at the highest priority in this extension.
// https://github.com/w3c/webextensions/issues/737
// https://github.com/uBlockOrigin/uBOL-home/issues/247
// Real-world symptom: "Filtering off" for a site still shows a nonzero
// blocked-request badge count, and Matrix panel entries for that site
// still show matching block rules — typically for RUM/analytics beacon
// vendors (e.g. Akamai mPulse, Adobe Experience Cloud) that fire
// requests from a Worker context rather than the document itself.
// Nothing in this extension's own rule set is wrong in this case; nor
// is there a code-level fix available — this is Chrome/the spec not
// honoring the exemption for that specific request-origin type.
// dnr.setAllowAllRules(id, ...) reserves exactly 2 ids starting at
// whatever `id` the caller passes — one dynamic rule, one session rule.
// This is a property of THIS function's own implementation, not of any
// particular caller's base id (currently only ruleset-manager.js's
// TRUSTED_DIRECTIVE_BASE_ID calls it, but the function itself is
// base-agnostic). Named here rather than left as bare `+0`/`+1` literals
// (B1: DNR rule id math should be a named, traceable value, not a magic
// number) — exported so tools/check-dnr-id-ranges.mjs can read the real
// footprint of any caller directly from these declarations instead of
// regex-matching this function's body for `id + <digit>` usage patterns,
// which is exactly the kind of thing a future refactor of this function
// could silently break without any test catching it.
export const SET_ALLOW_ALL_RULES_DYNAMIC_RULE_OFFSET = 0;
export const SET_ALLOW_ALL_RULES_SESSION_RULE_OFFSET = 1;

dnr.setAllowAllRules = async function(id, allowed, notAllowed, reverse, priority) {
    const [
        beforeDynamicRules,
        beforeSessionRules,
    ] = await Promise.all([
        dnr.getDynamicRules({ ruleIds: [ id + SET_ALLOW_ALL_RULES_DYNAMIC_RULE_OFFSET ] }),
        dnr.getSessionRules({ ruleIds: [ id + SET_ALLOW_ALL_RULES_SESSION_RULE_OFFSET ] }),
    ]);
    const addDynamicRules = [];
    const addSessionRules = [];
    if ( reverse || allowed.length || notAllowed.length ) {
        const rule0 = {
            id: id + SET_ALLOW_ALL_RULES_DYNAMIC_RULE_OFFSET,
            action: { type: 'allowAllRequests' },
            condition: {
                resourceTypes: [ 'main_frame' ],
            },
            priority,
        };
        if ( allowed.length ) {
            rule0.condition.requestDomains = allowed.slice();
        } else if ( notAllowed.length ) {
            rule0.condition.excludedRequestDomains = notAllowed.slice();
        }
        addDynamicRules.push(rule0);
        // https://github.com/uBlockOrigin/uBOL-home/issues/114
        // https://github.com/uBlockOrigin/uBOL-home/issues/247
        const rule1 = {
            id: id + SET_ALLOW_ALL_RULES_SESSION_RULE_OFFSET,
            action: { type: 'allow' },
            condition: {
                tabIds: [ webext.tabs.TAB_ID_NONE ],
            },
            priority,
        };
        if ( allowed.length ) {
            rule1.condition.initiatorDomains = allowed.slice();
        } else if ( notAllowed.length ) {
            rule1.condition.excludedInitiatorDomains = notAllowed.slice();
        }
        addSessionRules.push(rule1);
    }
    const promises = [];
    const modified = deepEquals(addDynamicRules, beforeDynamicRules) === false;
    if ( modified ) {
        promises.push(
            dnr.updateDynamicRules({
                addRules: addDynamicRules,
                removeRuleIds: beforeDynamicRules.map(r => r.id),
            })
        );
    }
    if ( deepEquals(addSessionRules, beforeSessionRules) === false ) {
        promises.push(
            dnr.updateSessionRules({
                addRules: addSessionRules,
                removeRuleIds: beforeSessionRules.map(r => r.id),
            })
        );
    }
    // (10.7.6, C5) A failed DNR update still reports "not modified" as before, but is now logged:
    // until then a site-mode change that did not reach the browser left no trace at all.
    return Promise.all(promises).then(( ) => modified).catch(catchExpected('apply site-mode allow rules', [], false));
};
