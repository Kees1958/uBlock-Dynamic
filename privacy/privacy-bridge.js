// ── privacy-bridge.js ───────────────────────────────────────────────────────────
// Fingerprint Inspector, ISOLATED world: relays the MAIN-world probe's events to the service worker and passes
// the page's active scriptlet rules back to the probe. Classic content script (no import/export).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Extension-context guard ──────────────────────────────────────────────
// Once the extension is reloaded/updated (routine during development, or a
// browser-triggered update) any tab that already had this content script
// injected keeps running with a now-dead chrome.runtime reference — every
// chrome.* call in that orphaned script throws SYNCHRONOUSLY ("Extension
// context invalidated"), not as a promise rejection, so a bare
// `.catch(() => {})` after the call never actually sees it. contextLost
// short-circuits every further call in this file the moment that's
// detected, instead of re-throwing (and re-logging to the console) on
// every single privacy-sensitive event the still-open page keeps
// generating afterwards — this page can fire many events per second.
let contextLost = false;

function sendMessageSafely(payload) {
    if ( contextLost ) { return Promise.resolve(undefined); }
    try {
        return chrome.runtime.sendMessage(payload).catch(() => undefined);
    } catch {
        // Synchronous throw path — the actual case this guard exists for.
        contextLost = true;
        return Promise.resolve(undefined);
    }
}

// Relay privacy-sensitive API detections from the probe to the background.
window.addEventListener('uBolPrivacyInspector', event => {
    const detail = event.detail;
    if ( detail instanceof Object === false ) { return; }
    sendMessageSafely({ what: 'privacyInspectorEvent', detail });
});

// Fetch any custom scriptlet rules matching this page's hostname and hand
// them to the probe (MAIN world — no chrome.* API access there) so it can
// apply real blocking behavior directly, including inside a same-origin
// iframe reached via contentWindow. This is needed specifically because
// chrome.scripting.executeScript cannot run a script inside a `sandbox`
// iframe that lacks `allow-scripts` — the probe's direct-property-access
// approach is the only way such a frame's canvas prototypes (etc.) can be
// patched at all. See privacy-probe.js's instrumentWindow().
sendMessageSafely({ what: 'getMatchingScriptletRules', hostname: location.hostname })
    .then(rules => {
        if ( !Array.isArray(rules) || rules.length === 0 ) { return; }
        window.dispatchEvent(new CustomEvent('uBolActiveScriptletRules', { detail: rules }));
    });
