/*
 * privacy-inspector-routes.js — Privacy Inspector message-route adapters
 *
 * Same three-layer split as the other five route files (see
 * matrix-routes.js's own header for the full rationale):
 *   Layer 1 — message-routes.js:  POLICY
 *   Layer 2 — this file:          ADAPTER
 *   Layer 3 — core/privacy-inspector.js (session lifecycle) +
 *             core/custom-scriptlets.js (the scriptlet mitigations a
 *             Privacy Inspector session creates/manages) — the logic
 *
 * Like security-routes.js, no single core/ module owns this whole
 * domain — Privacy Inspector's session lifecycle (start/stop/pause/
 * resume/get-data/record-event) lives in privacy-inspector.js, while the
 * scriptlet mitigation rules a session creates are managed through
 * custom-scriptlets.js's general-purpose rule store (source:
 * 'privacy-inspector', same storage/dispatch as ABP-import scriptlets —
 * see custom-scriptlets.js's own header on why that pool is unfiltered by
 * source). Both halves are genuinely one feature domain from the user's
 * perspective, so they stay in one route file rather than being split
 * further along that internal seam.
 *
 * Public interface — one function per MSG_* route this feature owns,
 * referenced by background.js's ROUTE_HANDLERS:
 *   handlePrivacyInspectorEvent, handleGetMatchingScriptletRules,
 *   handleStartPrivacyInspector, handleStopPrivacyInspector,
 *   handlePausePrivacyInspector, handleResumePrivacyInspector,
 *   handleGetPrivacyInspectorData, handleAddPrivacyScriptletRule,
 *   handleApplyPrivacyExtras, handleGetPrivacyScriptletRules,
 *   handleDeletePrivacyScriptletRule, handleClearPrivacyScriptletRules
 */

import { browser, runtime } from '../data/ext.js';

import {
    startPrivacyInspector,
    stopPrivacyInspector,
    pausePrivacyInspector,
    resumePrivacyInspector,
    getPrivacyInspectorData,
    recordPrivacyInspectorEvent,
} from '../core/privacy-inspector.js';

import {
    getCustomScriptletRules,
    hostnameMatches,
    addCustomScriptletRule,
    applyPrivacyExtrasForHost,
    getPrivacyInspectorScriptletRules,
    deleteCustomScriptletRule,
    maybeRemoveOrphanedPrivacyExtras,
    clearPrivacyInspectorScriptletRules,
} from '../core/custom-scriptlets.js';
import { catchExpected, EXPECTED_ERRORS } from '../data/expected-errors.js';

/******************************************************************************/
// Session lifecycle
/******************************************************************************/

// Privacy Inspector events are emitted by an ISOLATED-world content script.
// sender.origin therefore belongs to the inspected page, not the extension
// — that's why this route is declared CONTENT_SCRIPT in message-routes.js
// rather than gated on the trusted-origin check. This handler still
// validates that the message came through this extension and has a real
// tab context, same as before.
export async function handlePrivacyInspectorEvent(request, sender) {
    if ( sender?.id !== runtime.id ) { return; }
    if ( typeof sender?.tab?.id !== 'number' ) { return; }
    await recordPrivacyInspectorEvent(sender, request.detail);
    return;
}

export async function handleStartPrivacyInspector(request) {
    const tab = await browser.tabs.get(request.tabId).catch(catchExpected('get inspected tab', [ EXPECTED_ERRORS.TAB_GONE ], null));
    if ( !tab ) { return { error: 'tab not found' }; }
    let host;
    try { host = new URL(tab.url).hostname; } catch { return { error: 'invalid url' }; }
    await startPrivacyInspector(tab.id, host);
    return { ok: true };
}

export async function handleStopPrivacyInspector() {
    await stopPrivacyInspector();
    return { ok: true };
}

export async function handlePausePrivacyInspector() {
    await pausePrivacyInspector();
    return { ok: true };
}

export async function handleResumePrivacyInspector() {
    await resumePrivacyInspector();
    return { ok: true };
}

export async function handleGetPrivacyInspectorData() {
    return await getPrivacyInspectorData();
}

/******************************************************************************/
// Scriptlet mitigations (custom-scriptlets.js, source: 'privacy-inspector')
/******************************************************************************/

// Same content-script-sender situation as handlePrivacyInspectorEvent above:
// called from privacy-bridge.js so the probe can apply its scriptlet rules
// (e.g. prevent-canvas) directly inside a sandboxed iframe's own window,
// since chrome.scripting.executeScript cannot run a script inside such a
// frame at all (see privacy-probe.js's instrumentWindow() for why the probe
// reaches in as plain property access instead).
export async function handleGetMatchingScriptletRules(request, sender) {
    if ( sender?.id !== runtime.id ) { return []; }
    if ( typeof request?.hostname !== 'string' ) { return []; }
    const rules = await getCustomScriptletRules();
    return rules.filter(r => hostnameMatches(request.hostname, r.hostname));
}

// Privacy Inspector "Select" mitigation for scriptlet-eligible categories
// (webrtc, webgl, canvas, beacon — see CATEGORY_SCRIPTLET_MAP in
// privacy/privacy-inspector.js). Delegates straight to the existing,
// already-used-by-the-sandbox-editor addCustomScriptletRule() — no new
// storage or dispatch logic here.
export async function handleAddPrivacyScriptletRule(request) {
    return addCustomScriptletRule(request.rule, 'privacy-inspector');
}

// Sent once by the Privacy Inspector panel after "Block All" finishes
// writing its whole batch of rules (not after each individual "Select") —
// see applyPrivacyExtrasForHost() in custom-scriptlets.js: this now applies
// unconditionally (7.0.0 removed the old autoApplyPrivacyExtras dashboard
// toggle this used to be gated on), "Block All" itself is the only
// remaining condition.
export async function handleApplyPrivacyExtras(request) {
    await applyPrivacyExtrasForHost(request.hostname);
}

export async function handleGetPrivacyScriptletRules() {
    return getPrivacyInspectorScriptletRules();
}

// Look up the rule's hostname BEFORE deleting it — deleteCustomScriptletRule()
// returns the remaining array, not the removed rule, and
// maybeRemoveOrphanedPrivacyExtras() needs to know which hostname to check.
// Guarded against a uid that no longer exists (e.g. a stale double-click):
// targetRule stays undefined, the cascade check is skipped, and
// deleteCustomScriptletRule() itself is already a no-op filter in that case.
export async function handleDeletePrivacyScriptletRule(request) {
    const stored = await getCustomScriptletRules();
    const targetRule = stored.find(rule => rule.uid === request.uid);
    const result = await deleteCustomScriptletRule(request.uid);
    if ( targetRule ) {
        await maybeRemoveOrphanedPrivacyExtras(targetRule.hostname);
    }
    return result;
}

export async function handleClearPrivacyScriptletRules() {
    await clearPrivacyInspectorScriptletRules();
    return { ok: true };
}

/******************************************************************************/
