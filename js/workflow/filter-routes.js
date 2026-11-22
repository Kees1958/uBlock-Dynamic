/*
 * filter-routes.js — Custom cosmetic filter / CSS-injection message-route
 * adapters
 *
 * Same three-layer split as matrix-routes.js / security-routes.js /
 * ruleset-routes.js / mode-routes.js (see matrix-routes.js's own header
 * for the full rationale):
 *   Layer 1 — message-routes.js:  POLICY
 *   Layer 2 — this file:          ADAPTER
 *   Layer 3 — core/filter-manager.js — the actual logic
 *
 * Named filter-routes.js (domain noun), not filter-manager-routes.js
 * (module name) — matching the naming convention the other four route
 * files already established (matrix-/security-/ruleset-/mode-routes.js
 * are all named after the feature domain, not the core/ module they
 * happen to call into).
 *
 * Three of these ten (handleInsertCSS, handleRemoveCSS,
 * handleInjectCSSProceduralAPI) are the lowest-level CSS-injection bridge
 * — plain browser.scripting calls, no filter-manager.js logic involved at
 * all — grouped here anyway because they're the mechanism
 * startCustomFilters()/injectCustomFilters() build on top of, not because
 * they share an implementation with the other seven.
 *
 * Deliberately NOT included here: handleGetSandboxFilters/
 * handleSetSandboxFilters, which stay in background.js — see the doc
 * comment directly on those two handlers (and REFACTOR_PLAN.md) for why
 * splitting them wouldn't map to anything real underneath.
 *
 * Public interface — one function per MSG_* route this feature owns,
 * referenced by background.js's ROUTE_HANDLERS:
 *   handleInsertCSS, handleRemoveCSS, handleInjectCSSProceduralAPI,
 *   handleStartCustomFilters, handleTerminateCustomFilters,
 *   handleInjectCustomFilters, handleAddCustomFilters,
 *   handleClearCosmeticRules, handleDeleteCosmeticRule,
 *   handleGetCustomCosmeticRules, handleGetToolOverlaySecret
 *
 * Trust-boundary hardening (security-audit pass, see Security_evaluatie.md):
 * every route in this file is CONTENT_SCRIPT or ANY classified in
 * message-routes.js, meaning dispatchRoutedMessage() applies no origin
 * check at all before calling in here — see isFromThisExtension()/
 * trustedHostnameFromSender() (js/util/trusted-sender.js), both ported from the identical
 * pattern already used by privacy-inspector-routes.js and
 * custom-scriptlets.js/cookie-clicker-routes.js's own sender.url-based
 * hostname derivation.
 */

import { browser, webextFlavor, runtime } from '../data/ext.js';
import { hidesWholePage, isSafePickedSelector } from '../util/css-selector-guard.js';

import {
    startCustomFilters,
    terminateCustomFilters,
    injectCustomFilters,
    clearAllCustomFilters,
    deleteCustomFilter,
    getAllCustomFiltersWithDates,
} from '../core/filter-manager.js';

import { registerContentScripts } from '../core/scripting-manager.js';
import { saveCustomCosmeticSelectors } from '../core/cosmetic-rule-save.js';
import { trustedHostnameFromSender } from '../util/trusted-sender.js';
import { getToolOverlaySecret } from '../core/tool-overlay-secret.js';
import { catchExpected, PAGE_INJECTION_EXPECTED_ERRORS } from '../data/expected-errors.js';

// ── Trust-boundary hardening (security-audit pass — Security_evaluatie.md) ──
// Every handler below is reachable with CONTENT_SCRIPT or ANY sender
// classification (see message-routes.js's SENDER_KINDS — neither gets an
// isTrustedOrigin() check at the routing layer), so each one validates its
// own sender/data here, same posture privacy-inspector-routes.js's
// handlePrivacyInspectorEvent()/handleGetMatchingScriptletRules() already
// established for the identical situation.

// sender.id is always the extension's own id for a genuine message reaching
// this listener — Chrome stamps it, page content can't forge it — so this
// is defense-in-depth, not a fix for an exploitable gap today. Same exact
// check, same reasoning, as privacy-inspector-routes.js's two content-
// script-sourced handlers (see that file's own comment on why it's needed
// even though CONTENT_SCRIPT routes get no routing-layer origin check).
function isFromThisExtension(sender) {
    return sender?.id === runtime.id;
}

// trustedHostnameFromSender() — moved verbatim to js/util/trusted-sender.js in 11.0.3 (C15: ad-cleaner-routes.js uses it
// too, and a route file may not import another route file). Imported below.

// Shared benign-race check — ported verbatim from filter-manager.js's
// injectCustomFilters() (see that function's own comment for the full
// explanation: a content script reports its own frame ID, then that
// frame navigates away before the SW's async scripting.* call actually
// runs; there is no API to check frame liveness beforehand, so the
// reject is unavoidable and harmless). Reused here rather than
// reimplemented, per this project's own reuse-a-proven-solution
// principle — same three substrings, same downgrade-to-warn reasoning
// (Chrome/Brave's extension Errors panel surfaces console.error, not
// console.warn — this is what actually stops the benign case from
// showing up there while still being visible in the regular console).
// (10.7.8) Routine failures of the CSS-injection bridge (tab or frame went away, frame not scriptable) are declared
// expected classes (PAGE_INJECTION_EXPECTED_ERRORS, C5 rule 1) — everything else is still logged with context.

/******************************************************************************/
// Low-level CSS-injection bridge (no filter-manager.js involved)
/******************************************************************************/

export async function handleInsertCSS(request, sender, tabId, frameId) {
    if ( isFromThisExtension(sender) === false ) { return false; }
    if ( frameId === false ) { return false; }
    // https://bugs.webkit.org/show_bug.cgi?id=262491
    if ( frameId !== 0 && webextFlavor === 'safari' ) { return; }
    return browser.scripting.insertCSS({
        css: request.css,
        origin: 'USER',
        target: { tabId, frameIds: [ frameId ] },
    }).catch(catchExpected('insert hiding CSS', PAGE_INJECTION_EXPECTED_ERRORS));
}

export async function handleRemoveCSS(request, sender, tabId, frameId) {
    if ( isFromThisExtension(sender) === false ) { return false; }
    if ( frameId === false ) { return false; }
    // https://bugs.webkit.org/show_bug.cgi?id=262491
    if ( frameId !== 0 && webextFlavor === 'safari' ) { return; }
    return browser.scripting.removeCSS({
        css: request.css,
        origin: 'USER',
        target: { tabId, frameIds: [ frameId ] },
    }).catch(catchExpected('remove hiding CSS', PAGE_INJECTION_EXPECTED_ERRORS));
}

export async function handleInjectCSSProceduralAPI(request, sender, tabId, frameId) {
    if ( isFromThisExtension(sender) === false ) { return; }
    return browser.scripting.executeScript({
        files: [ '/js/scripting/css-procedural-api.js' ],
        target: { tabId, frameIds: [ frameId ] },
        injectImmediately: true,
    }).catch(catchExpected('inject procedural CSS API', PAGE_INJECTION_EXPECTED_ERRORS));
}

/******************************************************************************/
// filter-manager.js delegation
/******************************************************************************/

export async function handleStartCustomFilters(request, sender, tabId, frameId) {
    if ( isFromThisExtension(sender) === false ) { return; }
    if ( frameId === false ) { return; }
    return startCustomFilters(tabId, frameId);
}

export async function handleTerminateCustomFilters(request, sender, tabId, frameId) {
    if ( isFromThisExtension(sender) === false ) { return; }
    if ( frameId === false ) { return; }
    return terminateCustomFilters(tabId, frameId);
}

// The element picker's page-side script and its tool frame both fetch this secret; the frame starts only when the
// secret it receives in 'startOverlay' matches (uBO ead588a). Only this extension's own contexts get an answer.
export async function handleGetToolOverlaySecret(request, sender) {
    if ( sender?.id !== runtime.id ) { return; }
    return getToolOverlaySecret();
}

export async function handleInjectCustomFilters(request, sender, tabId, frameId) {
    if ( isFromThisExtension(sender) === false ) { return; }
    if ( frameId === false ) { return; }
    // WARNING FOR IMPLEMENTATION IMPACT: hostname is now derived from
    // sender.url/sender.tab.url, not request.hostname — a page that
    // spoofs document.baseURI via <base href> can no longer make this
    // handler look up or apply another hostname's stored custom filters.
    // For every legitimate call (css-user.js, unmodified page) this is
    // the same value document.baseURI would have reported anyway.
    const hostname = trustedHostnameFromSender(sender);
    if ( hostname === '' ) { return; }
    return injectCustomFilters(tabId, frameId, hostname);
}

export async function handleAddCustomFilters(request, sender) {
    if ( isFromThisExtension(sender) === false ) { return; }
    if ( Array.isArray(request.selectors) === false ) { return; }
    // C6 (10.7.13): the picker compiles each selector before sending it;
    // this re-checks the same boundary here, so text that could break out
    // of the injected stylesheet is never stored, whoever sent it. See
    // js/util/css-selector-guard.js. A real pick always passes.
    if ( request.selectors.every(isSafePickedSelector) === false ) {
        console.warn('[uBlock-Dynamic] addCustomFilters: refused a selector that could escape its stylesheet');
        return;
    }
    // (11.0.2) The picker lists <html>/<body> so their classes can anchor a
    // selector; a pick that hides or removes them blanks the whole site.
    // The picker page refuses it too — this is the service worker's own check.
    if ( request.selectors.some(hidesWholePage) ) {
        console.warn('[uBlock-Dynamic] addCustomFilters: refused a selector that would hide the whole page');
        return;
    }
    // WARNING FOR IMPLEMENTATION IMPACT: hostname is now derived from
    // sender.tab.url (the tab hosting the picker's trusted iframe), not
    // request.hostname (relayed from the page's own document.baseURI via
    // postMessage — spoofable with <base href>). A picked selector is now
    // always saved under the real page's hostname, never a hostname the
    // page itself claimed. For every legitimate picker use this is the
    // same value document.baseURI would have reported anyway.
    const hostname = trustedHostnameFromSender(sender, { preferTabUrl: true });
    if ( hostname === '' ) { return; }
    await saveCustomCosmeticSelectors(hostname, request.selectors);
}

// saveCustomCosmeticSelectors() — moved verbatim to js/core/cosmetic-rule-save.js in 11.0.3 (C15). Imported above.

export async function handleClearCosmeticRules() {
    // See handleDeleteCosmeticRule() below — same reasoning applies to the
    // bulk-clear path.
    await clearAllCustomFilters();
    await registerContentScripts();
    return { ok: true };
}

export async function handleDeleteCosmeticRule(request) {
    const { hostname, selector } = request;
    // Delegates to filter-manager.js's deleteCustomFilter() rather than
    // reading/writing site.* storage directly here — that function's
    // write path funnels through writeToStorage()/removeFromStorage(),
    // which refreshes the hostname-indexed cache as part of the same
    // operation. Doing the raw storage mutation in this file instead (as
    // before) would silently leave that cache stale until something else
    // happened to rebuild it.
    await deleteCustomFilter(hostname, selector);
    await registerContentScripts();
    return { ok: true };
}

export async function handleGetCustomCosmeticRules() {
    return getAllCustomFiltersWithDates();
}

/******************************************************************************/
