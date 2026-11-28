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
 * temp-disable-manager.js — "Buying, booking, banking mode": a timed (or
 * indefinite, "until browser restart") global filtering pause with
 * automatic re-enable.
 *
 * Public interface:
 *   getAllowedDurationsMinutes()     — the fixed list of offerable durations
 *   getTempDisableState()            — { active, untilMs?, remainingMs? }
 *                                       untilMs === null means "until
 *                                       browser restart" — no expiry at all.
 *   startTempDisable(minutes, tabId) — begin (or restart) a timed pause
 *   startTempDisableUntilRestart(tabId) — begin (or restart) an indefinite
 *                                       pause, ended only by
 *                                       clearTempDisableOnBrowserStartup()
 *   cancelTempDisable()              — end early (e.g. user clicks the panel)
 *   expireTempDisable()              — end on schedule (called from the
 *                                       deferred-jobs alarm via background.js)
 *
 * Persisted: chrome.storage.local, key 'tempDisable' -> { untilMs,
 * previousDefaultMode } | absent. untilMs is either a timestamp (timed
 * pause) or null (indefinite, "until browser restart" — no deferred job
 * is ever registered for this case; see startTempDisableUntilRestart()).
 * Scheduling for timed pauses reuses the existing js/data/alarms.js
 * deferred-jobs queue (same mechanism scripting-manager.js's CSS-cache
 * pruning already relies on), not a separate chrome.alarms entry — one
 * less alarm-lifecycle to reason about.
 *
 * DESIGN — reuses the existing "default filtering mode" lever rather than
 * inventing a new DNR primitive: setDefaultFilteringMode(MODE_NONE) is
 * exactly mode-manager.js's setFilteringMode('all-urls', MODE_NONE), which
 * ruleset-manager.js's filteringModesToDNR() already turns into a single
 * blanket allowAllRequests DNR rule (see its `allowEverywhere` branch) —
 * this is the same mechanism a permanent "default: off" choice would use,
 * just time-boxed (or, for the indefinite case, session-boxed). Any
 * hostname explicitly pinned to BASIC mode (the per-site toggle) is
 * intentionally still excluded from that blanket allow and stays
 * filtered — consistent with how the per-site toggle already interacts
 * with the global default outside of this feature.
 *
 * (11.1.6) The tab the popup was opened on IS refreshed when a pause
 * starts (site caches cleared, then reloaded — js/core/pause-refresh.js,
 * shared with the per-site OFF switch). Other open tabs are not:
 *
 * SCOPE NOTE: does not force-reload the other already-open tabs. DNR blocking
 * changes take effect immediately for new requests; cosmetic filters and
 * security scriptlets already injected into an already-loaded page keep
 * running until that page reloads or navigates, same tradeoff
 * site-mode-manager.js's applySiteMode() documents for the per-site
 * toggle (which reloads only the *active* tab, deliberately not every
 * open tab everywhere — reloading the whole browsing session for a
 * "quick pause" feature would be far more disruptive than the feature
 * itself, so it is out of scope here entirely).
 */


import {
    localRead, localRemove, localWrite,
} from '../data/ext.js';
import { createPersistedTimedState } from '../util/persisted-timed-state.js';

import { registerJob, removeJob } from '../data/alarms.js';

import { broadcastMessage } from '../data/broadcast.js';

import {
    MODE_NONE,
    getDefaultFilteringMode,
    setDefaultFilteringMode,
} from './mode-manager.js';

import { registerContentScripts } from './scripting-manager.js';

import { refreshTabAfterPause } from './pause-refresh.js';

/******************************************************************************/

const STORAGE_KEY = 'tempDisable';
const JOB_NAME = 'tempDisableExpire';

// The fixed set of TIMED durations this feature offers — declared once,
// here, so the popup UI and this module can never drift apart. Minutes,
// not ms: ms conversion happens at the one call site that needs it
// (startTempDisable). The indefinite "until browser restart" option is
// separate — see startTempDisableUntilRestart() — since it isn't a
// duration at all, just a different call the UI's own dedicated button
// makes.
const ALLOWED_DURATIONS_MINUTES = Object.freeze([ 5, 15, 30 ]);

// Unit-conversion factor for turning a duration in minutes (what
// ALLOWED_DURATIONS_MINUTES and the UI both deal in) into the
// millisecond timestamp storage/registerJob() actually need.
const MS_PER_MINUTE = 60 * 1000;

export function getAllowedDurationsMinutes() {
    return ALLOWED_DURATIONS_MINUTES;
}

/******************************************************************************/
// State — same in-memory-mirror-of-storage convention as
// site-mode-manager.js's `cache` (module-scoped, populated lazily,
// re-assigned directly on every write, never explicitly invalidated since
// a write always immediately replaces it with the new authoritative value).
/******************************************************************************/

// (audit 10.6.4, B15/C21) readState()/writeState() and the public-state + self-heal block now come
// from the ONE shared js/util/persisted-timed-state.js (same code as temp-disable-manager.js /
// cookie-clicker-autodeny-manager.js used to keep in two copies). Same guards as before: init in
// readState(), release in writeState(null), mirror and storage written together.
const timedState = createPersistedTimedState({
    read:   ( ) => localRead(STORAGE_KEY),
    write:  state => localWrite(STORAGE_KEY, state),
    remove: ( ) => localRemove(STORAGE_KEY),
});
const { readState, writeState } = timedState;

/******************************************************************************/

// Returns the current state for the popup to render. Also the single
// place that notices a stored expiry has already passed (e.g. the alarm
// was missed because the browser itself was closed past the scheduled
// time) and self-heals by restoring immediately, rather than leaving
// filtering silently paused forever. Indefinite ("until browser restart")
// pauses have no expiry to self-heal against at all — only
// clearTempDisableOnBrowserStartup() ever ends those.
export async function getTempDisableState() {
    return timedState.getPublicState(restoreNow);
}

/******************************************************************************/
// Guarded restore — the single place that turns filtering back on and
// releases this feature's resources (storage entry + deferred job). Both
// the early-cancel path and the scheduled-expiry path fold into this, so
// there is exactly one way filtering ever comes back on, not two
// slightly-different copies that could drift apart.
//
// Guard: a no-op if already restored (state === null). Both
// cancelTempDisable() (user click) and expireTempDisable() (alarm) can
// legitimately race against each other right at the boundary — e.g. the
// user clicks the panel to cancel in the same instant the scheduled job
// fires. Without this guard, whichever call loses the race would still
// try to write state back (re-arming a job that was just removed) and
// call setDefaultFilteringMode() a second, redundant time.
/******************************************************************************/

async function restoreNow() {
    const state = await readState();
    if ( state === null ) { return; }
    await writeState(null);
    if ( state.untilMs !== null ) {
        await removeJob(JOB_NAME);
    }
    await setDefaultFilteringMode(state.previousDefaultMode);
    await registerContentScripts();
    broadcastMessage({ tempDisable: { active: false } });
}

/******************************************************************************/

// Starts (or restarts with a new duration) the temporary global disable.
export async function startTempDisable(minutes, tabId) {
    if ( ALLOWED_DURATIONS_MINUTES.includes(minutes) === false ) {
        throw new Error(`[uBlock-Dynamic] startTempDisable: unsupported duration ${minutes}`);
    }

    const existing = await readState();
    // Guard: if already active, keep the ORIGINAL previousDefaultMode.
    // Re-snapshotting now would capture MODE_NONE — the temporarily-
    // disabled state this feature itself just set — permanently losing
    // whatever the real prior setting was, rather than just extending
    // the countdown as intended.
    const previousDefaultMode = existing !== null
        ? existing.previousDefaultMode
        : await getDefaultFilteringMode();

    const untilMs = Date.now() + minutes * MS_PER_MINUTE;
    const startedAtMs = Date.now();
    await writeState({ untilMs, previousDefaultMode, startedAtMs });
    // Guard: switching from an indefinite ("until browser restart") pause
    // into a timed one needs no extra cleanup here — there was never a
    // job registered for the indefinite case (see
    // startTempDisableUntilRestart() below), so registerJob() below is
    // simply the first one, not a second alongside a stale one.
    await registerJob(JOB_NAME, untilMs);

    await setDefaultFilteringMode(MODE_NONE);
    await registerContentScripts();
    // (11.1.6) The page the popup was opened on: site caches cleared, then reloaded (js/core/pause-refresh.js).
    await refreshTabAfterPause(tabId);

    broadcastMessage({ tempDisable: { active: true, untilMs } });
    return { active: true, untilMs, startedAtMs };
}

/******************************************************************************/

// "Until browser restart" — an indefinite pause with no timer at all;
// only a genuine browser restart (browser.runtime.onStartup, see
// clearTempDisableOnBrowserStartup() below) ever ends it automatically.
export async function startTempDisableUntilRestart(tabId) {
    const existing = await readState();
    const previousDefaultMode = existing !== null
        ? existing.previousDefaultMode
        : await getDefaultFilteringMode();

    // Guard: switching from a TIMED pause into indefinite mode must
    // cancel the previously-scheduled expiry job — otherwise it would
    // still fire later and end the pause on its old schedule despite the
    // user having since chosen "until browser restart".
    if ( existing !== null && existing.untilMs !== null ) {
        await removeJob(JOB_NAME);
    }

    const startedAtMs = Date.now();
    await writeState({ untilMs: null, previousDefaultMode, startedAtMs });

    await setDefaultFilteringMode(MODE_NONE);
    await registerContentScripts();
    // (11.1.6) Same pause refresh as the timed pause above.
    await refreshTabAfterPause(tabId);

    broadcastMessage({ tempDisable: { active: true, untilMs: null } });
    return { active: true, untilMs: null, startedAtMs };
}

/******************************************************************************/

// User-initiated early end (clicking the countdown panel). Same effect as
// letting the timer run out, just sooner — both converge on restoreNow().
export async function cancelTempDisable() {
    await restoreNow();
    return { active: false };
}

// Scheduled end, invoked from background.js's 'tempDisableExpire' route
// when js/data/alarms.js's processDueJobs() finds this job's time has
// passed.
export async function expireTempDisable() {
    await restoreNow();
    return { active: false };
}

// Called once from background.js's browser.runtime.onStartup listener —
// which fires only on a genuine browser launch, never on the routine
// service-worker sleep/wake cycles MV3 does constantly within a single
// browser session (those don't touch this at all; only a real restart
// does). A pause is meant to last only as long as the browsing session
// it was started in: if the browser itself restarts, filtering should
// come back the same as it always does, not remain silently paused until
// whatever time was left on the original timer. Safe to call even when
// no pause is active — restoreNow()'s own guard makes that a no-op.
export async function clearTempDisableOnBrowserStartup() {
    await restoreNow();
}

/******************************************************************************/
