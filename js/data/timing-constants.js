/*
 * timing-constants.js — shared timing values used by more than one feature
 *
 * Public interface: numeric constants only. No logic, no state.
 */

/*******************************************************************************

    DEFAULT_SESSION_TIMEOUT_MS
    ---------------------------
    Block Monitor and Privacy Inspector each independently chose a 5-minute
    session timeout — same value, but a coincidence of two unrelated
    features, not a structural coupling between them (uBol-stripped-
    code-review.md §2). Named once here so the literal itself can't drift
    out of sync between the 4 places that used it (js/core/block-monitor.js,
    js/core/privacy-inspector.js, monitor/monitor-panel.js,
    privacy/privacy-inspector.js's own SW-side guard and UI-side countdown
    display for each feature).

    Each consumer still assigns this to its own locally-named constant
    (e.g. `const SESSION_TIMEOUT_MS = DEFAULT_SESSION_TIMEOUT_MS;`) rather
    than importing and using DEFAULT_SESSION_TIMEOUT_MS directly everywhere
    — so a future feature can deliberately diverge from this default later
    by simply no longer importing it, without this file's name implying
    the two timeouts must always match.

*******************************************************************************/
export const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// (10.7.6) chrome.alarms names of the timed panel sessions' deadlines (js/core/session-deadline.js). One place, so the
// background's onAlarm routing and the two session modules can never name an alarm differently. Alarm names are
// per-extension and only ever created by this code.
export const SESSION_DEADLINE_ALARMS = Object.freeze({
    MATRIX:            'matrixSessionDeadline',
    PRIVACY_INSPECTOR: 'privacyInspectorSessionDeadline',
});

// (11.0.2, audit 11.0.2 finding 6) Delays that were typed into the code in several places. Values unchanged.
//
// A download's object URL is released this long after the click: revoking at once can race the browser's own
// download start on some platforms. Used by every dashboard download (custom rules, ABP import, settings backup).
export const DOWNLOAD_URL_REVOKE_DELAY_MS = 4000;
// After answering a "reset everything" request, the worker waits this long before reloading the extension, so the
// dashboard's own sendMessage() promise settles first (js/workflow/settings-routes.js).
export const RELOAD_AFTER_RESPONSE_DELAY_MS = 200;
// After a restore, the dashboard waits this long before reloading itself, so its "restored" message can be read
// (dashboard/settings-io.js).
export const RESTORE_PAGE_RELOAD_DELAY_MS = 1200;
