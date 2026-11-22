/*******************************************************************************

    uBlock-Stripped-Dynamic — Worry-free surfing mode, in-page picker

    v8.3.19 — moved from a small dialog INSIDE the popup's own window
    (popup/popup.html's #worryFreeModal) to an in-page overlay injected
    into the current tab, per explicit request/confirmation: "de
    Worry-free-tijdskeuze moet ook als overlay op de pagina zelf
    verschijnen (net als cookie-clicker), in plaats van in dat kleine
    popup-venster." Same mechanism, same style, deliberately reused —
    see js/scripting/cookie-clicker-picker.js's buildActionDialog() for
    the pattern this mirrors closely (Shadow DOM, same light/dark color
    values copied from css/default.css's real --surface-, --ink-, and
    --border-1 RGB numbers — this is a content script running on an
    arbitrary page with no access to the popup document's own CSS custom
    properties, so the values are duplicated here too, same reasoning).

    Launch flow (js/workflow/cookie-clicker-routes.js's
    injectSeamlessPrompt()): from the popup line (always — 10.7.1: also
    while a session runs, to change the cookie-banner choice; the D6
    click-to-turn-off is gone), and once after the 10.7.1 update
    (background.js maybeOfferSeamlessCookiePrompt()).

*******************************************************************************/

// GUARD — top-level, before anything else: a second injection while a
// dialog is still open in this frame (a fast double-click, or a race
// between two launch messages) stops that instance instead of stacking
// a second one on top — same toggle-off posture cookie-clicker-picker.js
// uses. This does NOT mean "never run again": removeDialog() below
// always clears the sentinel back to undefined once the dialog closes
// for any reason (a choice, a click outside the panel, or auto-dismiss), so the
// next legitimate launch (after the auto-deny session was toggled off
// and the person opens the picker again) correctly falls through to
// the `else` branch and builds a fresh dialog.
//
// BUG FIXED: previously this guard checked `=== undefined` and wrapped
// the entire rest of the file inside that one-shot condition, with
// nothing anywhere ever resetting the sentinel — so after the very
// first time this dialog closed, EVERY later injection into the same
// frame silently did nothing at all, with no error, until the page was
// reloaded (which is the only thing that reset `self`). Reported as:
// "toggle worry-free off, then can't turn it back on without a page
// refresh."
if ( self.__uBolWorryFreePicker ) {

self.__uBolWorryFreePicker.stop();

} else {

// ── (11.0.2) GUARD: the extension was reloaded or updated under this page ─────────────────────────────────────────────
// Scripts left in an open page then lose their connection: chrome.runtime.id becomes undefined and
// chrome.runtime.sendMessage() THROWS synchronously ("Extension context invalidated."), which a .catch() cannot see —
// it surfaced on chrome://extensions as an error with no context. sendToExtension() always returns a promise: it
// resolves to undefined once the extension is gone, and rejects (never throws) on any other failure. Same pattern as
// css-specific.js cacheWrite(). Page scripts cannot import, so this block is copied word for word into every page
// script that messages the extension; tools/test-content-script-context.mjs keeps the copies identical.
function isExtensionGone() {
    try {
        return chrome.runtime?.id === undefined;
    } catch {
        return true;   // benign: no runtime at all means the same — the extension is gone
    }
}
function sendToExtension(msg) {
    if ( isExtensionGone() ) { return Promise.resolve(); }
    try {
        return chrome.runtime.sendMessage(msg);
    } catch (reason) {
        return Promise.reject(reason);
    }
}
// ── end GUARD ──────────────────────────────────────────────────────────────────────────────────────────────────────────


self.__uBolWorryFreePicker = { stop: removeDialog };

/******************************************************************************/
// Config — declared once, here.
/******************************************************************************/

// (10.7.1, owner's decision) No duration choice any more. The prompt asks one thing — what Seamless surfing does
// with cookie banners — and each button enables it with that choice, or switches a running session to it. It opens from the popup line (always, also while running) and once after the update. Sessions
// are open-ended (cookie-clicker-autodeny-manager.js). (11.0.0) Seamless surfing is on at every browser start; an
// advanced user can turn it off for the rest of the browser session with this prompt's fourth choice, shown only when the background says so (SEAMLESS_PROMPT_OFFER_OFF_GLOBAL,
// js/data/seamless-switch.js — the background re-checks the answer). The choice is stored by the background and also
// applies when a session starts by itself at browser start (js/data/cookie-banner-action.js).
// (10.5.0) Content script — cannot import js/data/ui-names.js, so the feature name is copied ONCE
// here and tools/check-ui-name-copies.mjs proves it equal to WORRY_FREE_NAME (Part D step 51 rule).
const WORRY_FREE_NAME = 'Seamless surfing';
// (11.0.0) Same rule for the Cookie consent clicker's name (js/data/ui-names.js COOKIE_CLICKER_NAME).
const COOKIE_CLICKER_NAME = 'Cookie consent clicker';
const CAPTION_TEXT = `${WORRY_FREE_NAME}: what should happen with cookie banners?`;
// (11.0.0, owner's decisions 2026-11-19) No Cancel button. Closing the prompt — a real click OUTSIDE the panel, or Escape
// — keeps the existing choice and counts as answered (seamlessCookiePromptDismiss, the message Cancel used to send).
// Auto-dismiss records nothing, so a missed prompt is offered again in a later browser session (B12).
// Button order = the order of the stacked buttons. `action` values must match COOKIE_BANNER_ACTIONS in
// js/data/cookie-banner-action.js (a content script cannot import it; the background re-validates every value).
// (11.0.0, owner's decision) Three modes; the default "accept, else decline" first.
// `advancedOnly` choices are shown only to advanced users (11.0.0: the off choice).
// `explain` is that choice's own line in the explanation (owner 2026-11-19: one sentence per option, each on its own line).
const CHOICES = Object.freeze([
// Texts: the owner's own wording (2026-11-19, second pass), one line per option.
    Object.freeze({ action: 'prefer-accept', label: 'Accept, else decline',
        explain: 'Accept, else decline (default): accepts where ' + WORRY_FREE_NAME + ' knows how to, declines everywhere else.' }),
    Object.freeze({ action: 'accept',        label: 'Accept cookies',
        explain: 'Accept cookies: accepts where ' + WORRY_FREE_NAME + ' knows how to, websites work as intended.' }),
    Object.freeze({ action: 'decline',       label: 'Decline cookies',
        explain: 'Decline cookies: the fewest cookies, but a few websites may not work (because they require cookies).' }),
    // MIRROR of js/data/seamless-switch.js SEAMLESS_OFF_ACTION — proven equal by tools/test-seamless-always-on.mjs.
    Object.freeze({ action: 'off',           label: 'Turn ' + WORRY_FREE_NAME + ' off', advancedOnly: true,
        explain: 'You can turn ' + WORRY_FREE_NAME + ' off for this browser session. Click ' + WORRY_FREE_NAME + ' in the toolbar popup to activate again.' }),
]);
// MIRROR of js/data/seamless-switch.js SEAMLESS_PROMPT_OFFER_OFF_GLOBAL (set by the launch; read and cleared below).
const OFFER_OFF_GLOBAL = '__usd_seamless_offer_off_5d2a90';
const EXPLANATION_TEXT = WORRY_FREE_NAME + ' clicks cookie banners away for you on the websites you visit, and turns on the extra anti-tracking filters.';
const DISMISS_HINT_TEXT = 'Press Escape or click outside this box to keep your current choice.';
const DISMISS_KEY = 'Escape';
const COOKIE_CLICKER_HINT_TEXT = 'Automate missed cookie prompts with the \'' + COOKIE_CLICKER_NAME + '\'.';

// Same auto-dismiss posture as cookie-clicker-picker.js's own
// ACTION_AUTO_DISMISS_MS — a person who walks away from their keyboard
// should not have this stay on-screen forever.
const AUTO_DISMISS_MS = 15000;

let dialogHost;
let dismissHandle;
let keydownHandler;   // (11.0.0) the Escape listener — removed with the dialog (removeDialog)

/******************************************************************************/

// RELEASE guard — the ONE place this file's DOM node, timer, AND its
// own sentinel all get torn down together. Clearing the sentinel here
// (not just the DOM/timer) is what makes the next injection into this
// frame work correctly instead of silently no-oping — see this file's
// own top-of-file GUARD comment for the bug this fixes.
function removeDialog() {
    if ( dismissHandle !== undefined ) {
        clearTimeout(dismissHandle);
        dismissHandle = undefined;
    }
    if ( keydownHandler !== undefined ) {
        self.removeEventListener('keydown', keydownHandler, true);
        keydownHandler = undefined;
    }
    if ( dialogHost !== undefined ) {
        dialogHost.remove();
        dialogHost = undefined;
    }
    self.__uBolWorryFreePicker = undefined;
}

function buildDialog() {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;inset:0;';
    const root = host.attachShadow({ mode: 'closed' });
    // (10.7.6) FIXED markup only in the HTML text (forbidden practice F-SINK-1); the choice buttons are added below as
    // elements, their label set with textContent.
    root.innerHTML = `
        <style>
            :host { all: initial; }
            .backdrop {
                align-items: center;
                background: rgb(0 0 0 / 45%);
                display: flex;
                height: 100%;
                justify-content: center;
                width: 100%;
            }
            .panel {
                /* Light theme (default) — same RGB values as css/default.css's
                   :root.light block (gray-95/90/80/75, ink-80). */
                --surface-1: 240 240 242;
                --surface-2: 226 226 229;
                --surface-3: 198 198 204;
                --border-1:  184 184 192;
                --ink-1:     32 18 58;
                --mode-indicator: 34 89 223; /* #2259df, same both themes */
                background: rgb(var(--surface-1));
                border: 1px solid rgb(var(--border-1));
                border-radius: 8px;
                box-shadow: 0 4px 16px rgb(0 0 0 / 25%);
                color: rgb(var(--ink-1));
                font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                width: max-content;
                max-width: 420px;
                padding: 18px 20px;
            }
            @media (prefers-color-scheme: dark) {
                .panel {
                    /* Dark theme — same RGB values as css/default.css's
                       :root.dark block (gray-10/20/30/35, ink-rgb=gray-90). */
                    --surface-1: 27 27 35;
                    --surface-2: 47 47 59;
                    --surface-3: 69 69 85;
                    --border-1:  81 81 98;
                    --ink-1:     226 226 229;
                }
            }
            .caption { font-size: 19px; font-weight: 700; line-height: 1.3; margin: 0 0 14px; text-align: left; }
            /* (11.0.0) The three choices are stacked, full panel width: three side by side ran past the panel's
               420 px (owner's screenshot), and stacked they stay inside it whatever the label length. */
            .row { display: flex; flex-direction: column; align-items: stretch; gap: 8px; margin-bottom: 8px; }
            button {
                background: rgb(var(--surface-2));
                border: 0;
                border-radius: 6px;
                color: rgb(var(--ink-1));
                cursor: pointer;
                font: inherit;
                font-size: 14px;
                font-weight: 600;
                padding: 8px 16px;
                white-space: nowrap;
            }
            button:hover { background: rgb(var(--surface-3)); }
            button:disabled { cursor: not-allowed; opacity: 0.45; }
            .explanation-intro { color: rgb(var(--ink-1) / 78%); font-size: 13px; line-height: 1.4; margin: 12px 0 0; text-align: left; }
            /* (11.0.0) one line per option, a little space between them (owner 2026-11-19) */
            .explanation-lines { margin: 12px 0 0; }
            .explanation-lines .explanation-intro { margin: 0 0 6px; }
        </style>
        <div class="backdrop">
            <div class="panel">
                <p class="caption">${CAPTION_TEXT}</p>
                <div class="row"></div>
                <p class="explanation-intro">${DISMISS_HINT_TEXT}</p>
                <p class="explanation-intro">${EXPLANATION_TEXT}</p>
                <div class="explanation-lines"></div>
            </div>
        </div>
    `;
    const choiceRow = root.querySelector('.row');
    const lines = root.querySelector('.explanation-lines');
    // GUARD: read the launch's flag once and clear it (it is for this one prompt).
    const advanced = self[OFFER_OFF_GLOBAL] === true;
    self[OFFER_OFF_GLOBAL] = undefined;
    const shownChoices = CHOICES.filter(c => c.advancedOnly !== true || advanced);
    for ( const text of [ ...shownChoices.map(c => c.explain), COOKIE_CLICKER_HINT_TEXT ] ) {
        const p = document.createElement('p');
        p.className = 'explanation-intro';
        p.textContent = text;
        lines.append(p);
    }
    for ( const choice of shownChoices ) {
        const btn = document.createElement('button');
        btn.className = 'choice';
        btn.type = 'button';
        btn.dataset.action = choice.action;
        btn.textContent = choice.label;
        choiceRow.append(btn);
    }
    document.documentElement.appendChild(host);

    const backdrop = root.querySelector('.backdrop');
    const choiceBtns = root.querySelectorAll('.choice');

    function finish() {
        if ( dismissHandle !== undefined ) { clearTimeout(dismissHandle); dismissHandle = undefined; }
        removeDialog();
    }

    dismissHandle = self.setTimeout(finish, AUTO_DISMISS_MS);

    // (11.0.0, owner's decision) Closing the prompt (click outside the panel, Escape) keeps the existing choice and counts
    // as answered. Auto-dismiss does NOT send this — a missed prompt comes back (B12).
    // C47 (10.7.15): act on real user clicks only (isTrusted) — same rule as cookie-clicker-picker.js's
    // trustedOnly(); the closed shadow root already hides the buttons, this is the second layer.
    function keepExistingChoice() {
        sendToExtension({ what: 'seamlessCookiePromptDismiss' }).catch(( ) => {});
        finish();
    }
    backdrop.addEventListener('click', ev => {
        if ( ev.isTrusted !== true ) { return; }
        if ( ev.target !== backdrop ) { return; }   // a click inside the panel bubbles here: not a dismissal
        keepExistingChoice();
    });
    // Escape: window, capture phase (the page cannot stop it first), real key presses only (C47).
    keydownHandler = ev => {
        if ( ev.isTrusted !== true ) { return; }
        if ( ev.key !== DISMISS_KEY ) { return; }
        keepExistingChoice();
    };
    self.addEventListener('keydown', keydownHandler, true);

    for ( const btn of choiceBtns ) {
        btn.addEventListener('click', async ev => {
            if ( ev.isTrusted !== true ) { return; }
            for ( const b of choiceBtns ) { b.disabled = true; }
            try {
                await sendToExtension({
                    what: 'cookieClickerAutoDenyStart',
                    cookieBannerAction: btn.dataset.action,
                });
            } catch {
                // Non-fatal for this dialog's own purposes — the popup's
                // own #worryFreeLabel/#worryFreeCountdown (popup/worry-
                // free-ui.js) re-reads the real state itself the next
                // time it opens, same "eventually consistent, not
                // silently pretending success" posture the rest of this
                // feature already follows.
            }
            finish();
        });
    }

    return host;
}

dialogHost = buildDialog();

}
