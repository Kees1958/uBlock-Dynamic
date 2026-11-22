/*
 * matrix-routes.js — Matrix panel message-route adapters
 *
 * Layer 2 of a three-layer split (see the CHANGELOG entry this file was
 * introduced in for the full rationale):
 *   Layer 1 — message-routes.js:  POLICY (who may call this, does it need init)
 *   Layer 2 — this file:          ADAPTER (request shape <-> plain function call)
 *   Layer 3 — matrix-panel.js /
 *             matrix-block-rules.js:  LOGIC (the actual Matrix panel behavior)
 *
 * Every function here does the same two things and nothing else: pull
 * whatever it needs out of `request`, call straight into Layer 3, and
 * shape the result into a {ok}/{error} response envelope. None of them
 * contain Matrix domain logic — that all already lived in matrix-panel.js
 * and matrix-block-rules.js before this file existed; this file only
 * relocates the adapter functions that were previously defined inline in
 * background.js, unchanged in behavior.
 *
 * Public interface — one function per MSG_* route this feature owns,
 * referenced by background.js's ROUTE_HANDLERS:
 *   handleClearMatrixBlockRules, handleDeleteMatrixBlockRule,
 *   handleGetMatrixBlockRules, handleGetMatrixData, handleMatrixSetOverride,
 *   handleReloadMatrixTab, handleStartMatrix, handleStopMatrix,
 *   handleGetDomainRuleDetail
 */

import { browser, reloadTab } from '../data/ext.js';

import {
    getMatrixBlockRules,
    deleteMatrixBlockRule,
    clearMatrixBlockRules,
    setMatrixOverride,
} from '../core/matrix-block-rules.js';

import {
    startMatrix,
    stopMatrix,
    getMatrixData,
    getCurrentSessionSite,
    getCurrentSessionTabId,
    refreshOverridesCache,
} from '../core/matrix-panel.js';

import { getDomainRuleDetail } from '../core/domain-rule-detail.js';
import { catchExpected, EXPECTED_ERRORS } from '../data/expected-errors.js';

/******************************************************************************/

export async function handleClearMatrixBlockRules() {
    await clearMatrixBlockRules();
    return { ok: true };
}

export async function handleDeleteMatrixBlockRule(request) {
    await deleteMatrixBlockRule(request.uid);
    return { ok: true };
}

export async function handleGetMatrixBlockRules() {
    return getMatrixBlockRules();
}

export async function handleGetMatrixData() {
    return getMatrixData();
}

export async function handleMatrixSetOverride(request) {
    // Site comes from the CURRENT session, never from the request payload
    // — see getCurrentSessionSite()'s own doc comment in matrix-panel.js
    // for why: a buggy or compromised panel page shouldn't be able to
    // scope an override to a site it isn't actually showing.
    const site = getCurrentSessionSite();
    if ( !site ) { return { ok: false, error: 'no active Matrix session' }; }
    await setMatrixOverride(site, request.domain, request.scope, request.action ?? null);
    await refreshOverridesCache();
    return { ok: true };
}

// Backs the panel's REFRESH button — see MSG_RELOAD_MATRIX_TAB's own doc
// comment in message-types.js for why this is a separate round-trip from
// the panel-local row-list refresh. tabId is server-derived (same
// reasoning as handleMatrixSetOverride() above), never taken from the
// request payload.
export async function handleReloadMatrixTab() {
    const tabId = getCurrentSessionTabId();
    if ( typeof tabId !== 'number' ) { return { ok: false, error: 'no active Matrix session' }; }
    try {
        // bypassCache: true is the actual fix, not optional — see
        // reloadTab()'s own comment (data/ext.js). A plain reload can
        // silently keep honoring a now-stale BLOCK decision for a domain
        // the user just set to ALLOW, because the page/resource was
        // already cached under the old rule set; a soft reload doesn't
        // guarantee a fresh network round-trip for it. This is exactly
        // why BLOCK overrides appeared to work instantly while ALLOW
        // overrides didn't: a freshly-blocked domain is usually something
        // that re-requests itself anyway (new request, never cached),
        // while a freshly-ALLOWED domain often doesn't get a fresh
        // request at all without forcing the cache bypass.
        await reloadTab(tabId, '', true);
    } catch (reason) {
        return { ok: false, error: String(reason) };
    }
    return { ok: true };
}

export async function handleStartMatrix(request) {
    let tabId = request.tabId;
    let host;
    if ( typeof tabId === 'number' ) {
        const tabs = await browser.tabs.get(tabId).catch(catchExpected('get Matrix tab', [ EXPECTED_ERRORS.TAB_GONE ], null));
        if ( !tabs ) { return { error: 'tab not found' }; }
        try { host = new URL(tabs.url).hostname; } catch { return { error: 'invalid url' }; }
    } else {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const tab = tabs?.[0];
        if ( !tab?.id ) { return { error: 'no active tab' }; }
        tabId = tab.id;
        try { host = new URL(tab.url).hostname; } catch { return { error: 'invalid url' }; }
    }
    await startMatrix(tabId, host);
    return { ok: true };
}

export async function handleStopMatrix() {
    await stopMatrix();
    return { ok: true };
}

// Backs the Matrix panel's expand-row column — see js/core/
// domain-rule-detail.js's own header for what this deliberately does
// and does not resolve (raw rule data, no priority/allow-override
// verdict). No session/sender-derivation needed here (unlike
// handleMatrixSetOverride's site, or handleReloadMatrixTab's tabId) —
// this is a pure read against the extension's own bundled ruleset data,
// scoped by whatever domain string the panel asks about; there's no
// "which site is this override for" trust question to get wrong, since
// nothing is written and no site-scoping decision is being made.
export async function handleGetDomainRuleDetail(request) {
    if ( typeof request?.domain !== 'string' || request.domain === '' ) { return []; }
    return getDomainRuleDetail(request.domain);
}

/******************************************************************************/
