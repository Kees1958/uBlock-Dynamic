/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2022-present Raymond Hill

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

*******************************************************************************/

import { browser, runtime, sendMessage } from '../js/data/ext.js';
import { MSG_AD_CLEANER_LAUNCH, MSG_START_MATRIX, MSG_START_PRIVACY_INSPECTOR } from '../js/data/message-types.js';
import { MODE_NONE } from '../js/core/mode-manager.js';
import { openOrFocusPanel } from '../js/core/panel-window.js';

/******************************************************************************/

import { dom, qs$ } from '../js/ui/dom.js';
import { POPUP_PAUSE_CONTROL_ID, POPUP_TOOL_IDS } from '../js/data/power-tools.js';
import { AD_CLEANER_NAME, DNR_TRACKING_FILTER_NAME } from '../js/data/ui-names.js';

/******************************************************************************/

const currentTab = {};
const tabURL = new URL(runtime.getURL('/'));

/******************************************************************************/

function displayHostname(hostname) {
    return hostname.replace(/^www\./, '');
}

/******************************************************************************/

// ── Combined status-bar state ──────────────────────────────────────────────
// Two independent inputs feed the single #statusText/#statusIcon display:
//   1. `lastIsOff`       — the current SITE's own on/off state (set by
//                          site-mode-ui.js's render(), and by init() below
//                          from the initial popupPanelData fetch).
//   2. `tempDisableActive` — the GLOBAL temporary-pause state (set by
//                          temp-disable-ui.js), which is independent of any
//                          single site and, while active, overrides the
//                          displayed text regardless of the current site's
//                          own setting.
// Both are tracked here (not recomputed from scratch on every call) so
// either module can update its own input at any time — e.g. the countdown
// panel expiring — without needing to know or re-fetch the other one.
let lastIsOff = false;
let tempDisableActive = false;

function renderState(isOff = false) {
    lastIsOff = isOff;
    const isHTTP = tabURL.protocol === 'http:' || tabURL.protocol === 'https:';
    const statusText = qs$('#statusText');
    const statusIcon = qs$('#statusIcon');
    if ( !isHTTP ) {
        if ( statusText ) { statusText.textContent = 'Not applicable'; }
        if ( statusIcon ) { statusIcon.classList.remove('status-off'); }
    } else if ( tempDisableActive ) {
        // Same OFF icon as the plain "Filtering off" case below — visually
        // it IS off — but distinct text: this is a timed pause, not the
        // user having deliberately turned filtering off for this site.
        if ( statusText ) { statusText.textContent = 'Filtering temporarily disabled'; }
        if ( statusIcon ) { statusIcon.classList.add('status-off'); }
    } else if ( isOff ) {
        if ( statusText ) { statusText.textContent = 'Filtering off'; }
        if ( statusIcon ) { statusIcon.classList.add('status-off'); }
    } else {
        if ( statusText ) { statusText.textContent = 'Filtering active'; }
        if ( statusIcon ) { statusIcon.classList.remove('status-off'); }
    }
}

// Called by temp-disable-ui.js whenever the global pause starts, ends
// early, or expires — re-renders using whatever the current site's own
// isOff state already was, so this never has to re-fetch it.
export function setTempDisableActive(active) {
    tempDisableActive = active;
    renderState(lastIsOff);
}

/******************************************************************************/
// openOrFocusPanel() now lives in js/core/panel-window.js (imported above)
// — moved out so background.js's right-click context-menu entries can
// launch the same panels via the exact same, already-hardened
// ghost-tab-guard logic, instead of a second copy that could drift from
// this one. See that module's own header for the full history.
/******************************************************************************/

dom.on('#gotoPrivacyInspector', 'click', async ev => {
    if ( ev.isTrusted !== true || ev.button !== 0 ) { return; }
    await sendMessage({ what: MSG_START_PRIVACY_INSPECTOR, tabId: currentTab.id });
    await openOrFocusPanel(runtime.getURL('privacy/privacy-inspector.html'));
    self.close();
});

dom.on('#gotoMatrixPanel', 'click', async ev => {
    if ( ev.isTrusted !== true ) { return; }
    if ( ev.button !== 0 ) { return; }
    await sendMessage({ what: MSG_START_MATRIX, tabId: currentTab.id });
    await openOrFocusPanel(runtime.getURL('matrix/matrix-panel.html'));
    self.close();
});

// (Simplified popup, per explicit request) #gotoCustomRules,
// #gotoFilterLists, #gotoDashboard ("Import ABP rules"),
// #gotoFilteringMode ("Allow (white) list") and #gotoSecurity
// ("Privacy & Security extra's") — each of which wrote a different
// dashboard.activePane value before opening the dashboard — are
// replaced by the one #gotoSettingsDashboard handler below, which just
// opens the dashboard with no pane override. Every one of those five
// panes is still reachable from inside the dashboard itself, as a tab.
dom.on('#gotoSettingsDashboard', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    if ( ev.button !== 0 ) { return; }
    runtime.openOptionsPage();
});

dom.on('#gotoPicker', 'click', async ( ) => {
    if ( browser.scripting === undefined ) { return; }
    // v9.6.5: a failed launch is logged as a console warning ONLY — never a
    // user-visible signal (explicit requirement, same as the Cookie consent
    // clicker's launch route). Awaited BEFORE closing the popup so the
    // catch can actually run: this used to fire-and-forget, so a rejection
    // was an unhandled promise on a page that was already closing. Safe to
    // wait: the injection is dispatched to the browser either way, and the
    // wait is the few milliseconds executeScript takes.
    try {
        await browser.scripting.executeScript({
            files: [
                '/js/scripting/css-procedural-api.js',
                '/js/scripting/tool-overlay.js',
                '/js/scripting/picker.js',
            ],
            target: { tabId: currentTab.id },
        });
    } catch (reason) {
        console.warn('[uBlock-Dynamic] Cosmetic element picker launch failed, tabId=', currentTab.id, reason);
    }
    self.close();
});

// Cookie/consent-clicker picker — see COOKIE-CLICKER-DESIGN.md for the
// full design history. The actual detect/toggle/inject sequence
// (D6/D10) lives in js/workflow/cookie-clicker-routes.js's own
// handleCookieClickerLaunchPicker() as of 8.2.17 — moved out of this
// popup entirely. See that function's own header for the full
// reasoning, in short: this popup window closes the instant it loses
// focus, and the detection step's own bounded retry (8.2.9, up to
// ~1.5s across every frame) made running that sequence HERE vulnerable
// to being silently abandoned mid-flight if the popup closed before it
// finished — the real cause behind "sometimes I have to click a few
// times before it starts." Firing one message and closing immediately,
// without awaiting a response, decouples this popup's own (unreliable)
// lifetime from that work entirely — once dispatched, the background
// service worker keeps running it to completion regardless of whether
// this popup still exists a moment later.
dom.on('#gotoCookieClicker', 'click', ( ) => {
    if ( browser.scripting === undefined ) { return; }
    sendMessage({ what: 'cookieClickerLaunchPicker', tabId: currentTab.id });
    self.close();
});

// (11.0.0) Ad leftover cleaner — the background injects it (js/workflow/ad-cleaner-routes.js), so closing the popup at
// once cannot abandon the launch. Label from js/data/ui-names.js (one source).
qs$('#adCleanerLabel').textContent = AD_CLEANER_NAME;
qs$('#dnrTrackingFilterLabel').textContent = DNR_TRACKING_FILTER_NAME;   // (11.0.0) renamed from "Dynamic DNR filtering"
dom.on('#gotoAdCleaner', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    if ( browser.scripting === undefined ) { return; }
    sendMessage({ what: MSG_AD_CLEANER_LAUNCH, tabId: currentTab.id });
    self.close();
});


/******************************************************************************/

async function init() {
    const [ tab ] = await browser.tabs.query({
        active: true,
        currentWindow: true,
    });
    if ( tab instanceof Object === false ) { return true; }
    Object.assign(currentTab, tab);

    let url;
    try {
        url = new URL(currentTab.url);
        tabURL.href = url.href || '';
    } catch {
        return false;
    }

    // Fetch popup data — includes the site's current filtering level.
    const response = await sendMessage({
        what: 'popupPanelData',
        origin: url.origin,
        hostname: tabURL.hostname,
    });

    const isHTTP = url.protocol === 'http:' || url.protocol === 'https:';
    dom.cl.toggle(dom.root, 'isHTTP', isHTTP);

    // BUG FIX: this element was always left blank — displayHostname() was
    // defined but never actually called anywhere (found via ESLint
    // no-unused-vars). See uBol-stripped-code-review.md §3c.
    const hostnameEl = qs$('#siteModeHostname');
    if ( hostnameEl ) {
        hostnameEl.textContent = displayHostname(tabURL.hostname);
    }

    // BUG FIX: renderState() used to be called with no argument here, so
    // its `isOff` parameter always defaulted to false — the popup's status
    // text showed "Filtering active" unconditionally, even on a site where
    // filtering was actually off. `response` (the site's real filtering
    // level) was fetched above and silently discarded (also found via
    // ESLint no-unused-vars). MODE_NONE (0) is mode-manager.js's own
    // "no filtering" value — see its MODE_NONE/MODE_BASIC definitions.
    renderState(response?.level === MODE_NONE);
    renderPowerTools(response?.powerTools === true);
    return true;
}

// (11.0.0) "I am an advanced user (unhide power tools)": the power-tool lines (js/data/power-tools.js) are hidden while it
// is off. An older background without the field reads as hidden — the same as the default for a new install.
function renderPowerTools(shown) {
    for ( const id of [ ...POPUP_TOOL_IDS.power, POPUP_PAUSE_CONTROL_ID ] ) {
        const el = qs$(`#${id}`);
        if ( el !== null ) { dom.cl.toggle(el, 'powerToolHidden', shown === false); }
    }
}

export { renderState };
const INIT_RETRY_MAX_ATTEMPTS = 20;
// Chosen default: init() fails when the service worker hasn't finished
// waking up yet (cold-start race right after browser launch) — this delay
// gives it breathing room between retries instead of busy-looping.
// Found via ESLint (no-undef): this constant was referenced below but
// never declared, so setTimeout was silently getting `undefined` (coerced
// to 0ms) — the retry loop had no actual delay at all. 150ms × up to 20
// attempts keeps the worst-case wait under ~3s, matching the timescale of
// a service-worker cold start rather than a network round-trip.
const INIT_RETRY_DELAY_MS = 150;

async function tryInit(attempt = 0) {
    try {
        await init();
    } catch {
        if ( attempt < INIT_RETRY_MAX_ATTEMPTS ) {
            setTimeout(( ) => tryInit(attempt + 1), INIT_RETRY_DELAY_MS);
        }
    } finally {
        dom.cl.remove(dom.body, 'loading', 'busy');
    }
}

tryInit();

/******************************************************************************/
