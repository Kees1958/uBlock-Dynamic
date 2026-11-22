/*******************************************************************************

    uBlock-Stripped-Dynamic — Never-consent / cookie-clicker auto-deny
    Copyright (C) 2026-present Kees1958

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
*/
/*
 * cookie-clicker-autodeny-manager.js — "Never consent for 30 minutes": a
 * timed, GLOBAL (all tabs) session during which every recognized consent
 * banner is auto-denied, using DDG's vendored eval-snippets action layer
 * (see js/scripting/autodeny-snippets.generated.js).
 *
 * Directly modeled on js/core/temp-disable-manager.js — same state-vector
 * shape, same guarded init/clear/release lifecycle, same four-independent-
 * paths resilience against MV3 service-worker restarts (see §6.3 of the
 * design doc). Reused, not reinvented — see each section below for the
 * exact 1:1 mapping.
 *
 * (10.7.1, owner's decision) OPEN-ENDED only: the timed sessions (20/60 minutes, the expiry alarm, the popup
 * countdown) and the early-cancel path are REMOVED. A session runs until the browser restarts
 * (clearAutoDenyOnBrowserStartup()); it is switched off for good only by the browser-start option.
 *
 * Public interface:
 *   getAutoDenyState()              — { active, untilMs: null, startedAtMs } | { active: false }
 *   startAutoDeny()                 — begin (or restart, e.g. after a new cookie-banner choice) the session
 *   clearAutoDenyOnBrowserStartup() — end it on a genuine browser launch (background.js then starts it again
 *                                     when Seamless surfing is on — always, unless an advanced user turned it off)
 *   stopAutoDeny()                  — (11.0.0) the one full stop (session + pending picker resume)
 *   applySeamlessSwitch(enabled)    — (11.0.0) start if on and not running, stop if off (js/data/seamless-switch.js)
 *   retireTimedSession()            — one-time 10.7.1 step: make a pre-update timed session open-ended
 *   pauseForPicker() / resumeAfterPicker() / expirePickerResumeFallback() — element-picker pause (10.0.7)
 *
 * Persisted: chrome.storage.local[STORAGE_KEY] -> { active: true, untilMs: null,
 * startedAtMs } | absent (absent = inactive — see getAutoDenyState()). `untilMs` stays in the
 * record, always null: js/util/persisted-timed-state.js (shared with temp-disable-manager.js) reads it
 * as "no expiry".
 *
 * Precedence (D5): a saved per-site cookie-clicker rule ALWAYS wins over
 * this session, even while active — see js/scripting/cookie-clicker-
 * click.js's own precedence check, which reads getAutoDenyState() itself.
 * This module owns the session lifecycle only, never the precedence
 * decision — that stays where the two candidate actions actually meet,
 * same separation-of-concerns temp-disable-manager.js's own header
 * documents for its filtering-mode lever.
 */


import {
    localRead, localRemove, localWrite,
} from '../data/ext.js';
import { createPersistedTimedState } from '../util/persisted-timed-state.js';

import { registerJob, removeJob } from '../data/alarms.js';

import { broadcastMessage } from '../data/broadcast.js';

import {
    registerCookieClickerAutoDenyContentScripts,
    registerCosmeticContentScripts,
    registerScriptletContentScripts,
} from './scripting-manager.js';

import {
    onWorryFreeSessionStart, onWorryFreeSessionEnd,
} from './worry-free-extra-manager.js';

/******************************************************************************/
// Config — magic numbers declared once, here. Referenced by: this module,
// popup.js's countdown UI (via getAutoDenyState()'s returned untilMs/
// startedAtMs, never by re-deriving the duration itself), and
// js/scripting/cookie-clicker-click.js's precedence check (via
// getAutoDenyState()'s `active` field only).
/******************************************************************************/

const STORAGE_KEY = 'cookieClicker.autoDeny';
// (10.7.1) RETIRED — the expiry job of a timed session. Only named so retireTimedSession() can release one that a
// pre-update session left in the deferred-jobs queue; never registered any more.
const RETIRED_EXPIRY_JOB_NAME = 'cookieClickerAutoDenyExpire';

// (10.7.1) AUTO_DENY_DURATION_OPTIONS_MINUTES / _DEFAULT_MINUTES REMOVED with the timed sessions.

const MS_PER_MINUTE = 60 * 1000;

// (10.0.7) Picker pause/resume — launching the element picker while a session is active PAUSES
// it instead of cancelling it, and finishing/cancelling the pick RESUMES it automatically.
// Two independent paths (B3b): primary = the picker's add-rule / cancel messages call
// resumeAfterPicker(); fallback = a deferred alarm that resumes anyway if the picker is
// abandoned without any message ever coming back.
const PENDING_RESUME_STORAGE_KEY = 'cookieClicker.pendingResume';
const RESUME_FALLBACK_JOB_NAME = 'cookieClickerPickerResumeFallback';
const RESUME_FALLBACK_DELAY_MS = 5 * MS_PER_MINUTE;

// NOTE — no raw setTimeout/setInterval here, deliberately: both are wiped when the service worker restarts. The
// picker-resume fallback uses the js/data/alarms.js deferred-jobs queue, which survives that.

/******************************************************************************/
// State — in-memory mirror of storage, same convention as temp-disable-
// manager.js's own `cache` (module-scoped, populated lazily, re-assigned
// directly on every write, never separately invalidated since every write
// is immediately authoritative).
//
// GUARD — init: readState() below is the ONE place `cache` transitions
// from undefined (not yet loaded) to its real value.
// GUARD — clear/release: writeState(null), called from restoreNow() only,
// is the ONE place the persisted key is removed; `cache` is reassigned in
// the same call so the two can never drift.
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
// Public state read — also the single place that self-heals a missed
// expiry (path 2 of the four-path resilience scheme; see this module's
// own header for paths 1/3/4).
/******************************************************************************/

export async function getAutoDenyState() {
    // untilMs is always null (no expiry) since 10.7.1 — only a genuine browser restart ends the session. The
    // self-heal callback stays for a pre-update timed record not yet retired (retireTimedSession()).
    return timedState.getPublicState(restoreNow);
}

/******************************************************************************/
// Guarded restore — the single place the session ever ends: releases the
// storage entry, unregisters the auto-deny content-script group (D11 —
// registration-presence IS the gate), then broadcasts the new state.
// Callers: browser-start clear-up, the picker pause, and the self-heal of a
// pre-update timed record (10.7.1: the cancel/expiry callers are gone).
//
// GUARD: no-op if already restored (state === null) — two callers can still
// race (e.g. a picker pause right at browser start); the loser must not
// unregister an already-unregistered script.
/******************************************************************************/

async function restoreNow() {
    const state = await readState();
    if ( state === null ) { return; }
    await writeState(null);
    await registerCookieClickerAutoDenyContentScripts(); // RELEASE — sees active:false, unregisters (D11)
    await registerScriptletContentScripts(); // RELEASE — re-reads the session state; the annoyances list is an always-on default since 10.0.7, so it is unaffected
    await registerCosmeticContentScripts(); // RELEASE — same: annoyances' hide rules are unaffected (10.0.7)
    await onWorryFreeSessionEnd(); // RELEASE — re-adds the WORRY_FREE_EXTRA_ALLOW_PRIORITY suppression rules (the extra filter lists switch off)
    // (10.3.0) The Worry-free security scriptlets, high-risk-site headers and security-toggle DNR rules that
    // used to be released here were removed with the Privacy & Security extra protections (moved to 3P-Matrix).
    broadcastMessage({ cookieClickerAutoDeny: { active: false } });
}

/******************************************************************************/

// Starts (or restarts) the open-ended session. Restarting is how a new cookie-banner choice takes effect while a
// session runs: the registration inside re-derives the decline/accept bundle (js/data/cookie-banner-action.js).
export async function startAutoDeny() {
    return activateSession(Date.now());
}

// Shared init sequence (10.0.7) — also used by resumeAfterPicker() to re-activate a paused session.
async function activateSession(startedAtMs) {
    await writeState({ active: true, untilMs: null, startedAtMs });
    await registerCookieClickerAutoDenyContentScripts(); // INIT — sees active:true, registers (D11)
    await registerScriptletContentScripts(); // INIT — re-reads the session state (annoyances is an always-on default since 10.0.7, so unaffected)
    await registerCosmeticContentScripts(); // INIT — same
    await onWorryFreeSessionStart(); // INIT — removes the WORRY_FREE_EXTRA_ALLOW_PRIORITY suppression rule of every extra filter list whose own toggle is on
    // (10.3.0) The Worry-free security scriptlets, high-risk-site headers and security-toggle DNR rules that
    // used to be applied here were removed with the Privacy & Security extra protections (moved to 3P-Matrix).
    broadcastMessage({ cookieClickerAutoDeny: { active: true, untilMs: null } });
    return { active: true, untilMs: null, startedAtMs };
}

// (10.7.1) cancelAutoDeny() (popup toggle-off, D6) and expireAutoDeny() (scheduled end) REMOVED: no caller is left.

// (10.7.1) One-time step, called from background.js runVersionMigration(): a session started with 20 or 60 minutes
// before this update becomes open-ended, and its expiry job is released (GUARD: release — a left-over job would
// otherwise fire into a route that no longer exists). Idempotent: nothing to do on a second call.
export async function retireTimedSession() {
    await removeJob(RETIRED_EXPIRY_JOB_NAME);
    const state = await readState();
    if ( state !== null && state.untilMs !== null ) {
        await writeState({ ...state, untilMs: null });
    }
}

// Called once from background.js's browser.runtime.onStartup listener —
// which fires only on a genuine browser launch, never on the routine
// service-worker sleep/wake cycles MV3 does constantly within a single
// browser session. Mirrors temp-disable-manager.js's own
// clearTempDisableOnBrowserStartup() exactly, same reasoning: Worry-free
// is meant to last only as long as the browsing session it was started
// in — if the browser itself restarts, protection should come back to
// normal browsing, not silently keep counting down on whatever time was
// left. Safe to call even when no session is active — restoreNow()'s own
// guard makes that a no-op.
//
// BUG FIXED: previously the untilMs deadline (persisted in
// chrome.storage.local, which survives a genuine browser restart by
// design) was left untouched on startup — only the session-scoped
// suppression rule got reconciled to match whatever state was already
// there (see reconcileWorryFreeExtraSuppressionRule() in worry-free-
// extra-manager.js, still used for the separate SW-cold-start/version-
// bump case in background.js's start(), where that IS the correct
// behavior). The result: closing and reopening the browser mid-session
// silently resumed the countdown instead of ending it. Reported as:
// "closing and reopening the browser, the Worry-free timer just
// continues, while a browser restart should turn all such timers off."
export async function clearAutoDenyOnBrowserStartup() {
    await stopAutoDeny();
}

// (11.0.0) The one full stop: ends the session through restoreNow() and releases a pending picker-resume (its storage
// entry and fallback job), so a paused session cannot come back by itself. Used at browser start (above) and when an
// advanced user turns Seamless surfing off (applySeamlessSwitch). Safe to call with no session (restoreNow guard).
export async function stopAutoDeny() {
    await restoreNow();
    await localRemove(PENDING_RESUME_STORAGE_KEY);   // RELEASE — 10.0.7 picker resume
    await removeJob(RESUME_FALLBACK_JOB_NAME);       // RELEASE — its fallback job
}

// (11.0.0) Seamless surfing on/off (js/data/seamless-switch.js) made true now: on starts a session if none runs (a
// running one keeps its start time), off stops it. The caller has already saved the setting.
export async function applySeamlessSwitch(enabled) {
    const state = await readState();
    if ( enabled === true ) {
        if ( state === null ) { await startAutoDeny(); }
        return;
    }
    await stopAutoDeny();
}

/******************************************************************************/
// Picker pause / resume (10.0.7)
/******************************************************************************/

// Pause for the element picker: remember the running session,
// arm the fallback alarm, then end the session through the normal restore path.
// Returns false when no session is active (nothing to pause).
export async function pauseForPicker() {
    const state = await readState();
    if ( state === null ) { return false; }
    await localWrite(PENDING_RESUME_STORAGE_KEY, { startedAtMs: state.startedAtMs });
    await registerJob(RESUME_FALLBACK_JOB_NAME, Date.now() + RESUME_FALLBACK_DELAY_MS); // path 2 — survives SW restart
    await restoreNow();
    return true;
}

// Resume after the picker finished or was cancelled. Releases the pending record AND the
// fallback job together. Returns false when there is nothing to resume.
export async function resumeAfterPicker() {
    const pending = await localRead(PENDING_RESUME_STORAGE_KEY);
    if ( !pending || typeof pending !== 'object' ) { return false; }
    await localRemove(PENDING_RESUME_STORAGE_KEY);
    await removeJob(RESUME_FALLBACK_JOB_NAME);
    await activateSession(typeof pending.startedAtMs === 'number' ? pending.startedAtMs : Date.now());
    return true;
}

// Alarm-fired fallback path (B3b second independent path).
export async function expirePickerResumeFallback() {
    return resumeAfterPicker();
}

/******************************************************************************/
