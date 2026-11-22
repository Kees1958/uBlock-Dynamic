/*******************************************************************************

    uBlock-Stripped-Dynamic — Worry-free surfing mode (popup menu item)

    v8.3.19 — the duration-choosing UI moved OUT of the popup's own small
    window entirely, into an in-page overlay injected into the current
    tab — per explicit request/confirmation: "de Worry-free-tijdskeuze
    moet ook als overlay op de pagina zelf verschijnen (net als
    cookie-clicker), in plaats van in dat kleine popup-venster." See
    js/scripting/worry-free-picker.js for that overlay itself, and
    js/workflow/cookie-clicker-routes.js's handleWorryFreeLaunchPicker()
    for the launch/D6-toggle-off backend — both deliberately mirror
    popup.js's own #gotoCookieClicker handler and cookie-clicker-
    routes.js's handleCookieClickerLaunchPicker() closely (C21: reuse a
    proven pattern, don't invent a second one next to it).

    This file's own remaining job: render the one-line state on
    #gotoWorryFree ("<mode>" when off, "<mode> - accept|decline" while on,
    10.7.1). Clicking always opens the in-page prompt — also while a
    session runs, to change the cookie-banner choice (10.7.1: the D6
    click-to-turn-off is gone; only the browser-start option turns it off).

*******************************************************************************/

import { browser, sendMessage } from '../js/data/ext.js';
import { dom, qs$ } from '../js/ui/dom.js';
import { UI_NAMES } from '../js/data/ui-names.js';
import { COOKIE_BANNER_ACTIONS, DEFAULT_COOKIE_BANNER_ACTION } from '../js/data/cookie-banner-action.js';

/******************************************************************************/
// Config — declared once, here.
/******************************************************************************/

// (10.7.1, owner's decision) ONE line: while a session runs it reads "<mode> - accept" or "<mode> - decline" — the
// cookie-banner choice made in the Seamless surfing prompt (js/data/cookie-banner-action.js). The countdown, the
// "Until next session" text and the transaction-warning hover ("Don't complete purchases…") are REMOVED: every
// session is open-ended now, and the line itself says what happens to cookie banners.
const COOKIE_BANNER_LINE_WORD = Object.freeze({
    // (11.0.0, owner's decision) One short word, so "Seamless surfing mode - smart" fits on one line of the popup.
    [COOKIE_BANNER_ACTIONS.PREFER_ACCEPT]: 'smart',
    [COOKIE_BANNER_ACTIONS.ACCEPT]:        'accept',
    [COOKIE_BANNER_ACTIONS.DECLINE]:       'decline',
});
const LINE_SEPARATOR = ' - ';

/******************************************************************************/
// State rendering — no timers, nothing to release.
/******************************************************************************/

function applyActiveState(cookieBannerAction) {
    const labelEl = qs$('#worryFreeLabel');
    if ( labelEl === null ) { return; }
    // GUARD: an unknown/missing action (older background) reads as the default mode (cookie-banner-action.js).
    const word = COOKIE_BANNER_LINE_WORD[cookieBannerAction] ?? COOKIE_BANNER_LINE_WORD[DEFAULT_COOKIE_BANNER_ACTION];
    labelEl.textContent = `${UI_NAMES.worryFreeMode}${LINE_SEPARATOR}${word}`;   // derived — js/data/ui-names.js
}

function applyInactiveState() {
    const labelEl = qs$('#worryFreeLabel');
    if ( labelEl === null ) { return; }
    labelEl.textContent = UI_NAMES.worryFreeMode;   // (10.5.0) derived — js/data/ui-names.js
}

// (11.0.0) An advanced user turned Seamless surfing off (js/data/seamless-switch.js): the line says so.
const OFF_LINE_WORD = 'off';
function applyOffState() {
    const labelEl = qs$('#worryFreeLabel');
    if ( labelEl === null ) { return; }
    labelEl.textContent = `${UI_NAMES.worryFreeMode}${LINE_SEPARATOR}${OFF_LINE_WORD}`;
}

/******************************************************************************/
// Event wiring — fire-and-forget-and-close, same exact posture as
// popup.js's own #gotoCookieClicker handler (see that file's own
// comment on why: a Chrome extension popup closes the instant it loses
// focus, so awaiting a response here before closing would make this
// vulnerable to being silently abandoned mid-flight the same way that
// file's own history already documents). The D6 toggle-off decision
// (start vs. cancel) is made entirely on the backend side now
// (handleWorryFreeLaunchPicker()) — this handler doesn't need to know
// or check the current active state itself before sending.
/******************************************************************************/

dom.on('#gotoWorryFree', 'click', async ev => {
    if ( ev.isTrusted !== true || ev.button !== 0 ) { return; }
    if ( browser.scripting === undefined ) { return; }
    const [ tab ] = await browser.tabs.query({ active: true, currentWindow: true });
    if ( tab instanceof Object === false || typeof tab.id !== 'number' ) { return; }
    sendMessage({ what: 'worryFreeLaunchPicker', tabId: tab.id });
    self.close();
});

/******************************************************************************/
// Init — the popup is short-lived (re-created fresh on every open), so a
// one-shot fetch on load is enough; no BroadcastChannel listener needed
// (same posture cookie-clicker-autodeny-ui.js's own init() already
// takes for this exact same underlying session).
/******************************************************************************/

async function init() {
    // GUARD (init, 10.5.0): the label is derived, not typed in popup.html — show the inactive
    // label first so a failed or slow message below can never leave the menu item empty.
    applyInactiveState();
    const state = await sendMessage({ what: 'cookieClickerAutoDenyGet' });
    if ( state?.active ) {
        applyActiveState(state.cookieBannerAction);
    } else if ( state?.seamlessEnabled === false ) {
        applyOffState();
    } else {
        applyInactiveState();
    }
}

init();
