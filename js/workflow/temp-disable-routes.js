/*
 * temp-disable-routes.js — "Buying, booking, banking mode" (timed global
 * filtering pause) message-route adapters
 *
 * Same three-layer split as the other six route files (see
 * matrix-routes.js's own header for the full rationale):
 *   Layer 1 — message-routes.js:  POLICY
 *   Layer 2 — this file:          ADAPTER
 *   Layer 3 — core/temp-disable-manager.js — the actual logic
 *
 * All five handlers here are one-line pass-throughs to
 * temp-disable-manager.js — this was already the most internally coherent
 * cluster in background.js (noted as such during the original measurement
 * pass), just never actually relocated alongside the other six route
 * files until this pass caught it.
 *
 * clearTempDisableOnBrowserStartup() (also exported by
 * temp-disable-manager.js) deliberately stays imported directly by
 * background.js, not routed through here — it's called from the
 * browser.runtime.onStartup listener, not from a message route at all.
 *
 * Public interface — one function per MSG_* route this feature owns,
 * referenced by background.js's ROUTE_HANDLERS:
 *   handleTempDisableGet, handleTempDisableStart,
 *   handleTempDisableStartUntilRestart, handleTempDisableCancel,
 *   handleTempDisableExpire
 */

import {
    getTempDisableState,
    getAllowedDurationsMinutes,
    startTempDisable,
    startTempDisableUntilRestart,
    cancelTempDisable,
    expireTempDisable,
} from '../core/temp-disable-manager.js';

/******************************************************************************/

export async function handleTempDisableGet() {
    // allowedDurationsMinutes piggybacks on this same round-trip (not a
    // separate message) — the popup already awaits this exact call before
    // the duration picker can possibly be opened (see temp-disable-ui.js's
    // init()), so there's no new async gap to introduce, only an existing
    // one to also carry this data through.
    return { ...await getTempDisableState(), allowedDurationsMinutes: getAllowedDurationsMinutes() };
}

export async function handleTempDisableStart(request) {
    return startTempDisable(request.minutes, request.tabId);
}

export async function handleTempDisableStartUntilRestart(request) {
    return startTempDisableUntilRestart(request.tabId);
}

export async function handleTempDisableCancel() {
    return cancelTempDisable();
}

// Dispatched internally by js/data/alarms.js's processDueJobs() (via the
// onMessage(request) call with no `sender` at all — see
// dispatchRoutedMessage()'s isTrustedOrigin() treating a missing sender as
// trusted, same as the existing 'pruneCSSCache' job).
export async function handleTempDisableExpire() {
    return expireTempDisable();
}

/******************************************************************************/
