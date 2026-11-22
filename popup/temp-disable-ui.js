/*******************************************************************************

    uBlock-Stripped-Dynamic — Temporary global disable UI

    Wires the button beneath the site-mode toggle and the duration-picker
    modal to the js/core/temp-disable-manager.js backend (via
    tempDisableGet/Start/Cancel messages — see js/workflow/background.js /
    message-routes.js). The button itself doubles as the live countdown
    display while a pause is active.

    Unlike site-mode-ui.js's per-site toggle, this is NOT scoped to the
    current tab's hostname — it's a single global on/off switch with a timer,
    so there is no per-hostname state to read here at all.

*******************************************************************************/

import { sendMessage } from '../js/data/ext.js';
import { dom, qs$ } from '../js/ui/dom.js';
import { setTempDisableActive } from './popup.js';

/******************************************************************************/

// ── Config — declared once, here ────────────────────────────────────────
// The duration buttons are rendered by renderDurationChoices() below, from
// the SAME backend list startTempDisable() itself validates against
// (temp-disable-manager.js's getAllowedDurationsMinutes(), piggybacked on
// the existing tempDisableGet round-trip in init() — see that function's
// own comment) — one source of truth now, not a hardcoded popup.html copy
// manually kept in sync with a separate backend constant. That was the
// previous design: this file's own top comment used to say "5/10/15/30/60-
// minute", which had drifted from BOTH the real backend list and the real
// HTML buttons (actually 5/15/30, since 6.1.9) — a concrete sign the
// manually-kept-in-sync approach doesn't reliably stay in sync, not just a
// theoretical risk.
//
// How often the countdown/count-up display re-renders. 1 second is
// plenty for a minutes-scale timer — no need to tax the popup with
// anything finer.
const COUNTDOWN_TICK_MS = 1000;

/******************************************************************************/
// State
/******************************************************************************/

let selectedMinutes = null;

// Guard: the single live timer (counting down for a timed pause, or up
// for an indefinite one). stopTicker() always clears this before
// startTicker() creates a new one, and it's cleared again whenever the
// button returns to its inactive state (cancelled, expired, or on init
// finding no active pause) — never left running with nothing to update,
// and never silently doubled by a stray extra call to startTicker().
let countdownIntervalId = null;

/******************************************************************************/
// Timer — one shared ticker, two display modes
/******************************************************************************/

function formatClock(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Timed pause: counts DOWN to untilMs. ceil so it doesn't visually touch
// 0:00 a tick early.
function formatRemaining(ms) {
    return formatClock(Math.max(0, Math.ceil(ms / 1000)));
}

// Indefinite ("until browser restart") pause: counts UP from
// startedAtMs — there's no end time to count down to. floor so it reads
// 0:00 right at the start, then ticks up naturally.
function formatElapsed(ms) {
    return formatClock(Math.max(0, Math.floor(ms / 1000)));
}

function stopTicker() {
    if ( countdownIntervalId === null ) { return; }
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
}

function startTicker(tick) {
    stopTicker();   // guard: never stack a second interval over the first
    tick();
    countdownIntervalId = setInterval(tick, COUNTDOWN_TICK_MS);
}

function startCountdown(untilMs) {
    const countdownEl = qs$('#tempDisableButtonCountdown');
    startTicker(( ) => {
        const remainingMs = untilMs - Date.now();
        if ( remainingMs <= 0 ) {
            applyInactiveState();
            return;
        }
        if ( countdownEl ) { countdownEl.textContent = formatRemaining(remainingMs); }
    });
}

function startCountup(startedAtMs) {
    const countdownEl = qs$('#tempDisableButtonCountdown');
    startTicker(( ) => {
        const elapsedMs = Date.now() - startedAtMs;
        if ( countdownEl ) { countdownEl.textContent = formatElapsed(elapsedMs); }
    });
}

/******************************************************************************/
// Button state
/******************************************************************************/

// Tracked so the single #tempDisableButton click handler below knows
// which action it should take — open the duration picker, or end an
// already-active pause — without needing to re-derive it from DOM state.
let isActive = false;

function applyActiveState(untilMs, startedAtMs) {
    isActive = true;
    const labelEl = qs$('#tempDisableButtonLabel');
    const btn = qs$('#tempDisableButton');
    if ( labelEl ) { labelEl.textContent = 'Enable filtering again'; }
    if ( btn ) { btn.classList.add('is-active'); }
    if ( untilMs === null ) {
        startCountup(startedAtMs ?? Date.now());
    } else {
        startCountdown(untilMs);
    }
    setTempDisableActive(true);
}

function applyInactiveState() {
    isActive = false;
    stopTicker();
    const labelEl = qs$('#tempDisableButtonLabel');
    const btn = qs$('#tempDisableButton');
    const countdownEl = qs$('#tempDisableButtonCountdown');
    if ( labelEl ) { labelEl.textContent = 'Pause filtering…'; }
    if ( btn ) { btn.classList.remove('is-active'); }
    // Release guard: clear the leftover countdown text explicitly, rather
    // than leaving a stale "0:00" (or worse, the last real reading)
    // sitting in the DOM the next time the button is inactive.
    if ( countdownEl ) { countdownEl.textContent = ''; }
    setTempDisableActive(false);
}

/******************************************************************************/
// Duration-picker modal
/******************************************************************************/

function resetDurationChoices() {
    selectedMinutes = null;
    for ( const el of document.querySelectorAll('.tempDisableDurationChoice') ) {
        el.classList.remove('is-selected');
    }
    const confirmBtn = qs$('#tempDisableConfirmBtn');
    if ( confirmBtn ) { confirmBtn.disabled = true; }
}

// Renders the duration buttons from the backend's own allowed-durations
// list (see init() below) — replaces the previous hardcoded popup.html
// copy. Safe to call before the modal is ever opened (it always is —
// see init()): #tempDisableDurationChoices is a plain, always-present
// container, not conditionally rendered.
//
// IMPORTANT: the click handler for these buttons (below) uses dom.on()'s
// DELEGATED 4-arg form (container, type, childSelector, callback), not
// the 3-arg form — that 3-arg form does a one-time DOM snapshot query at
// call time and would never see buttons created here, since this
// function runs after an async round-trip, well after this module's own
// top-level dom.on() calls have already executed. Same delegation
// pattern dashboard/custom-rules.js already uses for its own
// dynamically-rendered rows (C21) — not a new mechanism.
function renderDurationChoices(minutesList) {
    const container = qs$('#tempDisableDurationChoices');
    if ( !container ) { return; }
    container.textContent = '';
    for ( const minutes of minutesList ) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tempDisableDurationChoice';
        btn.dataset.minutes = String(minutes);
        btn.textContent = `${minutes} min`;
        container.appendChild(btn);
    }
}

function openModal() {
    resetDurationChoices();
    const modal = qs$('#tempDisableModal');
    if ( modal ) { modal.hidden = false; }
}

function closeModal() {
    const modal = qs$('#tempDisableModal');
    if ( modal ) { modal.hidden = true; }
}

/******************************************************************************/
// Event wiring
/******************************************************************************/

// Small helper so the click handler below and any other future caller
// share exactly one place that actually calls tempDisableCancel.
async function cancelPause() {
    await sendMessage({ what: 'tempDisableCancel' });
    applyInactiveState();
}

// Stop mechanism: the button itself, same principle as the site-mode
// turn-off/turn-on button — one control whose label and action both
// flip with the current state. "Pause filtering…" opens the picker;
// "Enable filtering again" (while active) ends the pause directly.
dom.on('#tempDisableButton', 'click', async ev => {
    if ( ev.isTrusted !== true || ev.button !== 0 ) { return; }
    if ( isActive ) {
        await cancelPause();
        return;
    }
    openModal();
});

dom.on('#tempDisableDurationChoices', 'click', '.tempDisableDurationChoice', ev => {
    if ( ev.isTrusted !== true || ev.button !== 0 ) { return; }
    // ev.target, not ev.currentTarget — in dom.on()'s delegated 4-arg
    // form, currentTarget stays the container the listener is actually
    // attached to (#tempDisableDurationChoices); target is the matched
    // child. Same convention dashboard/custom-rules.js's own delegated
    // handlers already use (C21) — this file's own earlier handler here
    // used currentTarget because it was still the 3-arg snapshot-bind
    // form at the time, where currentTarget and target coincide (no
    // container in between); switching forms without switching this too
    // would have been a real, silent bug (always reading the container's
    // own — absent — dataset.minutes, never the clicked button's).
    const el = ev.target;
    const minutes = parseInt(el.dataset.minutes, 10);
    if ( !Number.isFinite(minutes) ) { return; }
    selectedMinutes = minutes;
    for ( const choice of document.querySelectorAll('.tempDisableDurationChoice') ) {
        choice.classList.toggle('is-selected', choice === el);
    }
    const confirmBtn = qs$('#tempDisableConfirmBtn');
    if ( confirmBtn ) { confirmBtn.disabled = false; }
});

dom.on('#tempDisableCancelBtn', 'click', ev => {
    if ( ev.isTrusted !== true || ev.button !== 0 ) { return; }
    closeModal();
});

// Clicking the dimmed backdrop (not the picker card itself) also dismisses
// the modal, same as the Cancel button — a plain click-outside-to-close,
// common enough that requiring the Cancel button specifically would be
// more surprising than not.
dom.on('#tempDisableModal', 'click', ev => {
    if ( ev.isTrusted !== true || ev.button !== 0 ) { return; }
    if ( ev.target !== ev.currentTarget ) { return; }   // ignore clicks inside the card
    closeModal();
});

dom.on('#tempDisableConfirmBtn', 'click', async ev => {
    if ( ev.isTrusted !== true || ev.button !== 0 ) { return; }
    if ( selectedMinutes === null ) { return; }
    const confirmBtn = ev.currentTarget;
    confirmBtn.disabled = true;   // guard against a double-submit while the request is in flight
    try {
        const resp = await sendMessage({ what: 'tempDisableStart', minutes: selectedMinutes });
        closeModal();
        if ( resp?.active ) { applyActiveState(resp.untilMs, resp.startedAtMs); }
    } finally {
        confirmBtn.disabled = false;
    }
});

// Indefinite pause — a direct action, not a chip-then-confirm choice:
// clicking it commits immediately, same as the timed picker's Pause
// button does after a duration is selected.
dom.on('#tempDisableUntilRestartBtn', 'click', async ev => {
    if ( ev.isTrusted !== true || ev.button !== 0 ) { return; }
    const btn = ev.currentTarget;
    btn.disabled = true;   // guard against a double-submit while the request is in flight
    try {
        const resp = await sendMessage({ what: 'tempDisableStartUntilRestart' });
        closeModal();
        if ( resp?.active ) { applyActiveState(resp.untilMs, resp.startedAtMs); }
    } finally {
        btn.disabled = false;
    }
});

/******************************************************************************/
// Init
/******************************************************************************/

async function init() {
    const resp = await sendMessage({ what: 'tempDisableGet' });
    if ( Array.isArray(resp?.allowedDurationsMinutes) ) {
        renderDurationChoices(resp.allowedDurationsMinutes);
    }
    if ( resp?.active ) {
        applyActiveState(resp.untilMs, resp.startedAtMs);
    } else {
        applyInactiveState();
    }
}

init();

/******************************************************************************/
