// ── expected-errors.js ───────────────────────────────────────────────────────
// One place that decides which browser-API errors are EXPECTED (harmless, not logged) and turns
// every other error into a logged warning (principle C5 — "never swallow an error silently").
//
// Public interface:
//   EXPECTED_ERRORS            — frozen catalogue of the expected error classes (see below)
//   isExpectedError(reason, errorClasses)        — true when reason matches one of the classes
//   catchExpected(context, errorClasses, fallback) — returns a .catch() handler: expected errors are
//                                 dropped, anything else is logged with `context`; both resolve to
//                                 `fallback` so the caller's flow is unchanged
//
// Dependencies: none (pure; no browser API, no storage).
// State owned by this module: none.
//
// Why expected errors are not logged: they describe work that no longer matters — the tab was
// closed while the extension was still updating it, or a content script was already gone. They
// happen routinely; logging them would bury the real errors this module exists to surface.
// ─────────────────────────────────────────────────────────────────────────────

/*==============================================================================
    CONSTANTS — the expected error classes (single source of truth)
==============================================================================*/

// Each class: a stable name (for tests/docs) and the Chrome/Firefox error-message pattern.
export const EXPECTED_ERRORS = Object.freeze({
    // The tab (or its window) closed between the extension deciding to act on it and the call.
    // Chrome: "No tab with id: 12." / "No window with id: 3."; Firefox: "Invalid tab ID: 12".
    TAB_GONE: Object.freeze({
        name: 'tab-gone',
        pattern: /\bNo (?:tab|window) with id\b|\bInvalid tab ID\b/i,
    }),
    // A frame closed or navigated away between a content script's message and the background's reply — an inherent
    // race when a page is busy loading (10.7.8; uBO b4979e4 no longer reports these either).
    // Chrome: "No frame with id 7 in tab 12."
    FRAME_GONE: Object.freeze({
        name: 'frame-gone',
        pattern: /\bNo frame with id\b/i,
    }),
    // A content script id was already unregistered (by a concurrent pass or a browser update).
    // Chrome: "Nonexistent script ID 'x'".
    SCRIPT_NOT_REGISTERED: Object.freeze({
        name: 'script-not-registered',
        pattern: /\bNonexistent script ID\b/i,
    }),
    // A message to a tab/frame that has no listener (navigated away, closed, or never had the content
    // script). Chrome: "Could not establish connection. Receiving end does not exist."
    NO_RECEIVER: Object.freeze({
        name: 'no-receiver',
        pattern: /\bReceiving end does not exist\b/i,
    }),
    // executeScript() refused by the browser for this page or frame: chrome:// and Web Store pages, a
    // frame that went away or shows an error page, a host without permission.
    NOT_SCRIPTABLE: Object.freeze({
        name: 'not-scriptable',
        pattern: /\bCannot access\b|\bcannot be scripted\b|\bFrame with ID \d+ (?:was removed|is showing error page)\b|\bMissing host permission\b/i,
    }),
});

// (10.7.8) The classes a page-facing injection call (insertCSS / removeCSS / executeScript into a tab's frame) meets
// routinely: the tab or frame went away, or the frame cannot be scripted. One list for every such call site.
export const PAGE_INJECTION_EXPECTED_ERRORS = Object.freeze([
    EXPECTED_ERRORS.TAB_GONE, EXPECTED_ERRORS.FRAME_GONE, EXPECTED_ERRORS.NOT_SCRIPTABLE,
]);

// Prefix used by every warning this module logs — same prefix as the rest of the extension's logs.
const LOG_PREFIX = '[uBlock-Dynamic]';

/*==============================================================================
    Public interface
==============================================================================*/

function messageOf(reason) {
    return String(reason?.message ?? reason);
}

export function isExpectedError(reason, errorClasses = []) {
    const message = messageOf(reason);
    return errorClasses.some(errorClass => errorClass.pattern.test(message));
}

// Usage: browser.tabs.reload(tabId).catch(catchExpected('reload tab', [ EXPECTED_ERRORS.TAB_GONE ]))
// Pass an empty class list to log EVERY failure but still continue with `fallback`.
export function catchExpected(context, errorClasses = [], fallback = undefined) {
    if ( typeof context !== 'string' || context === '' ) {
        console.warn(`${LOG_PREFIX} catchExpected: missing context label`);
    }
    return function handleRejection(reason) {
        if ( isExpectedError(reason, errorClasses) === false ) {
            console.warn(`${LOG_PREFIX} ${context} failed:`, messageOf(reason));
        }
        return fallback;
    };
}
