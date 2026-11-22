// ── session-deadline.js (core) ──────────────────────────────────────────────────
// (10.7.6, audit 10.7.5 bullet 4 / D-1) The 5-minute deadline of a timed panel session (Matrix panel, Fingerprint
// Inspector) as a chrome.alarms alarm. Replaces js/util/session-watchdog.js (a setInterval in the worker's memory).
//
// Why an alarm: Chrome stops an idle service worker after ~30 s and every setTimeout / setInterval dies with it. A
// session whose panel was closed with its X then kept running — Inspector probe registered, Matrix listener back on
// every wake — until something woke the worker AND a 5-minute interval survived long enough to tick. An alarm is
// kept by Chrome itself and WAKES the worker at the deadline (minimum 30 s; the session is 5 minutes).
//
// Two independent paths still end every session (B3b): this alarm, and the panel's own 15 s poll
// (getPrivacyInspectorData() / getMatrixData() end an expired session). The module's in-memory setTimeout stays for
// exact timing while the worker is awake.
//
// Public interface:
//   createSessionDeadline({ alarms, alarmName, timeoutMs, ensureHydrated, getSession, onTimeout, releaseOrphans })
//     -> { arm(remainingMs), disarm(), handleAlarm(name), reconcile() }
//   arm(remainingMs)   — INIT: (re)sets the alarm at now + remainingMs (start / resume)
//   disarm()           — RELEASE: clears the alarm (stop / pause)
//   handleAlarm(name)  — onAlarm: true when the alarm was this session's; ends an expired session, re-arms an early one
//   reconcile()        — worker boot: a running session gets its alarm (again); no session -> releaseOrphans()
// Dependencies are injected (alarms = browser.alarms) so the helper is testable in Node (tools/test-session-deadline.mjs).
// State owned: none — the session lives in its module (chrome.storage.session); the alarm lives in Chrome.
// ─────────────────────────────────────────────────────────────────────────────

import { catchExpected } from '../data/expected-errors.js';

// Elapsed running time of a session record { phase, startTime, timeElapsed } at `now`.
function elapsedMsOf(session, now) {
    const running = session.phase === 'running' && session.startTime !== null;
    return session.timeElapsed + (running ? now - session.startTime : 0);
}

export function createSessionDeadline({ alarms, alarmName, timeoutMs, ensureHydrated, getSession, onTimeout, releaseOrphans }) {
    if ( typeof alarms?.create !== 'function' || typeof alarmName !== 'string' || alarmName === '' ) {
        throw new TypeError('createSessionDeadline: alarms API and a non-empty alarmName are required');
    }

    function arm(remainingMs) {
        const delayMs = Math.max(0, Number(remainingMs) || 0);
        // Chrome raises a "when" closer than 30 s to 30 s — harmless: the setTimeout of the module covers exact timing.
        return Promise.resolve(alarms.create(alarmName, { when: Date.now() + delayMs }))
            .catch(catchExpected(`arm ${alarmName} alarm`));
    }

    function disarm() {
        return Promise.resolve(alarms.clear(alarmName)).catch(catchExpected(`clear ${alarmName} alarm`));
    }

    async function handleAlarm(name) {
        if ( name !== alarmName ) { return false; }
        await ensureHydrated();
        const session = getSession();
        if ( !session || session.phase !== 'running' ) { return true; }   // paused or ended: nothing is due
        const remaining = timeoutMs - elapsedMsOf(session, Date.now());
        if ( remaining <= 0 ) {
            await onTimeout();
        } else {
            await arm(remaining);   // fired early (clock change): wait for the rest
        }
        return true;
    }

    async function reconcile() {
        await ensureHydrated();
        const session = getSession();
        if ( session && session.phase === 'running' ) {
            await arm(timeoutMs - elapsedMsOf(session, Date.now()));
            return;
        }
        if ( !session ) {
            await disarm();
            // GUARD (release): resources a session leaves in Chrome (e.g. a persistent content-script registration)
            // outlive chrome.storage.session, which a browser restart clears — drop them when no session exists.
            if ( typeof releaseOrphans === 'function' ) { await releaseOrphans(); }
        }
    }

    return { arm, disarm, handleAlarm, reconcile };
}
