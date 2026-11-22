/*******************************************************************************

    uBlock-Stripped-Dynamic — Cookie/consent-clicker picker
    Copyright (C) 2025-present Kees1958

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

/******************************************************************************/
//
// Architecture note: injected on demand by popup/popup.js's
// #gotoCookieClicker handler via chrome.scripting.executeScript({ files:
// [...], target: { tabId, allFrames: true } }) — the SAME allFrames: true
// fix COOKIE-CLICKER-DESIGN.md diagnoses as the ORIGINAL picker attempt's
// missing piece, applied here to a brand new, purpose-built picker rather
// than retrofitted onto the existing cosmetic-rule picker (js/scripting/
// picker.js) — deliberately kept separate: that picker's job (build a
// CSS/procedural selector to HIDE elements, with a full slider-based
// refinement UI) is materially different from this one's (pick ONE
// element to CLICK, with a much smaller confirm-and-save step), and reusing
// its considerably more complex machinery (tool-overlay.js's dedicated
// overlay iframe, the multi-candidate slider) here would need to somehow
// make that TOP-FRAME-ONLY machinery work across cross-origin iframes too
// — a much larger undertaking than the small, self-contained, per-frame
// approach this file takes instead.
//
// Every instance of this script (one per frame, since allFrames: true)
// runs entirely independently — hover highlighting, click capture, and
// the confirm bubble are all local DOM operations within that ONE frame,
// needing no visibility into any other frame's DOM at all. The only
// cross-frame coordination is via chrome.runtime.sendMessage to the
// service worker (see MSG_COOKIE_CLICKER_ADD_RULE/_PICKER_STOP), which
// the service worker then relays back out to every frame of the tab —
// see popup.js / cookie-clicker-routes.js for the other ends of that
// round trip.
//
// "Smart button" resolution (findClickTarget(), see its own comment
// below) means a hover or click on a decorative child of a real button
// — an icon, a label span — resolves to that enclosing button, not the
// leaf. Applied identically to the hover highlight and the click
// finalize step, so what gets outlined is always what gets picked.
//
// An action dialog (buildActionDialog(), v8.2 — see NEVER-CONSENT-
// DESIGN.md §5) shows on EVERY detected-banner encounter, in the TOP
// FRAME ONLY (window.top === window.self) — deliberate scope decision: a
// separate dialog rendered independently in every iframe of the page
// would be confusing and redundant, and iframes have no reliable way to
// know whether the top frame's own dialog is still up. Only the top
// frame's own picking is gated behind dismissing it; iframe instances
// stay armed immediately, since a user may need to click inside a CMP
// iframe directly and gating that on a dialog they can't see would just
// look broken with no visible explanation. Offers three choices: Cancel,
// Automate your choice (arms manual picking, same as the old "Got it"),
// or Never consent for 60 minutes (starts the global auto-deny session
// and ends this picking session immediately) — see maybeShowActionDialog()
// and buildActionDialog() for the full button-behavior/D12-capability-gate
// details.
//
// ── STATE / GUARDS ───────────────────────────────────────────────────────
// All picking-session state lives in section 4 (SESSION STATE): the picking
// flag, the hover-highlight record, the confirm-bubble host and the
// action-dialog host + its auto-dismiss timer. The sentinel
// `self.__uBolCookieClickerPicker` (an object holding stop(), or undefined
// when no picker session is active in this frame) marks an active session.
// stop() is the single RELEASE guard: it removes every listener this file
// ever attached, removes the confirm-bubble host AND the action-dialog host
// (plus its own pending auto-dismiss timer) from the DOM if either is
// present, restores whatever inline `outline` style a hovered element had
// before this script touched it, and clears the sentinel — see stop()'s own
// comment for the exact list. Called on: a successful save, Escape (even
// while the action dialog is still up — this is exactly why the dialog's
// own host/timer needed to join this same guard rather than only being
// cleaned up by its own buttons), a stop broadcast relayed from another
// frame, or a second injection of this same file into an already-active
// frame (the toggle-off convention js/scripting/tool-overlay.js's own
// uBOLOverlay already uses for the exact same "re-injected while already
// running" case).
//
// ── LAYOUT (10.7.9, reorganised — no behaviour change) ───────────────────
//   1. Toggle-off guard            9. Action dialog (markup + builder)
//   2. Config                     10. Action-dialog gate
//   3. Storage helpers            11. Confirm bubble (markup + placement + builder)
//   4. Frame identity             12. Hover highlight
//   5. Session state              13. Picking actions
//   6. Smart button detection     14. Event handlers
//   7. Selector builder           15. Lifecycle (start / stop)
//   8. Top-layer dialog host
//
/******************************************************************************/

(async function uBOL_cookieClickerPicker() {

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


/* ══════════════════════════════════════════════════════════════
   1. TOGGLE-OFF GUARD
   ══════════════════════════════════════════════════════════════ */

// Toggle-off convention, mirroring tool-overlay.js's uBOLOverlay: a
// second injection into a frame that's already picking stops the
// existing session instead of stacking a second one.
if ( self.__uBolCookieClickerPicker ) {
    self.__uBolCookieClickerPicker.stop();
    return;
}

/* ══════════════════════════════════════════════════════════════
   2. CONFIG  —  every constant/magic-number/text this file uses,
   declared once, here
   ══════════════════════════════════════════════════════════════ */

// Outline used to highlight the element currently under the pointer.
// Distinct color from the existing cosmetic picker's own highlight
// (js/scripting/tool-overlay.js) so the two tools' visual language never
// gets confused if somehow both were ever active at once (they can't be,
// in practice, but "distinct on purpose" costs nothing here).
const HIGHLIGHT_OUTLINE = '2px solid #1a7f37';
const HIGHLIGHT_OUTLINE_OFFSET = '1px';

// Selector-builder bounds — how far up the DOM this file will walk
// looking for a unique selector before giving up and returning its best
// (possibly non-unique) attempt. 8 ancestors comfortably covers real
// consent-banner markup (typically 3-6 levels of wrapper divs deep)
// without walking arbitrarily far up an unrelated page's DOM.
const SELECTOR_MAX_DEPTH = 8;
// Element class names this file will fold into a candidate selector.
// Framework-generated "utility" classes (long hashes, single-letter,
// etc.) add noise without adding stability — capped at 3 REAL,
// human-authored-looking classes per element, in DOM order.
const SELECTOR_MAX_CLASSES_PER_NODE = 3;

// Confirm-bubble placement — clamped this many px from the viewport edge
// so it can never render partially off-screen for a click near a corner.
const BUBBLE_VIEWPORT_MARGIN = 12;

// Action-dialog placement — anchors the Cancel/Automate choice panel to
// the top-right corner of the viewport (near the browser's own
// extensions toolbar/dropdown, which is what opened this picker in the
// first place) instead of dead-center. Distinct constant from
// BUBBLE_VIEWPORT_MARGIN above even though the value happens to differ:
// that one clamps a bubble that FOLLOWS the click point and needs a tight
// fit; this one is a fixed corner anchor for a panel with no click point
// of its own, so a slightly more generous margin reads better against
// the browser chrome above it.
const ACTION_DIALOG_ANCHOR_MARGIN = 16;

// "Smart button" lookup — how far up the DOM this file will walk from
// whatever element the pointer is actually over, looking for the
// nearest REAL clickable control, before giving up and using the
// literal hovered/clicked element as-is. Exists because the element
// directly under the cursor is very often a decorative child — an
// icon `<svg>`, a text `<span>`, an inner wrapper `<div>` — of the
// actual `<button>`/`<a>` that handles the click, especially for
// icon-only or icon+label consent buttons. Picking that decorative
// child produces a selector that's technically clickable
// (`element.click()` doesn't error) but often does nothing, because
// the real click handler is bound to the ANCESTOR control, not the
// leaf — a real, previously-unexplained failure mode this directly
// targets. 5 levels comfortably covers real button markup (typically
// button > span > svg, at most 2-3 levels of wrapping) without ever
// walking far enough up to risk resolving to something structural like
// a whole banner `<div>`.
const CLICKABLE_ANCESTOR_MAX_DEPTH = 5;

// Confirm-bubble placement around the click point (computeBubblePosition()):
// a small visual gap between the click point and the bubble, distinct from
// BUBBLE_VIEWPORT_MARGIN (the viewport-edge margin), and the size used when
// measuring the rendered bubble somehow returns 0.
const BUBBLE_CLICK_GAP = 8;
const BUBBLE_FALLBACK_WIDTH = 304;  // 280 content + 2*12 padding, matches the CSS
const BUBBLE_FALLBACK_HEIGHT = 200; // generous estimate, same as the old fixed guess

// Message values sent to / received from the service worker. This file is a
// plain content script (injected via executeScript's `files`), so it cannot
// import js/data/message-types.js — the values are copied here once and
// matched by value (tools/check-message-routing.mjs, VALUE_MATCHED_READERS).
const MSG_ADD_RULE = 'cookieClickerAddRule';
const MSG_PICK_CANCELLED = 'cookieClickerPickCancelled';
const MSG_PICKER_STOP = 'cookieClickerPickerStop';

// Action-dialog text/timing/storage-key — v8.2 replaced the old one-time
// "Got it / Cancel / don't-show-again" intro with a dialog shown on EVERY detected-banner encounter.
// v8.3.3: reduced to 2 buttons (Cancel / Automate) — the third choice,
// "Never consent", is now a standalone top-level popup feature
// ("Worry-free surfing mode", see popup/worry-free-ui.js) reachable
// without needing a detected banner first, rather than something this
// per-page dialog offers. The shared backend (js/core/cookie-clicker-
// autodeny-manager.js's startAutoDeny()) is unchanged either way.
//
// "Don't show this again" — ported from picker/picker.js's own
// INTRO_HIDE_FLAG_KEY mechanism (explicit request: copy that proven
// pattern here, same shape). Deliberately only ever written when the
// user explicitly checks the box AND dismisses via the affirmative
// path ("Automate your choice") — never via Cancel, and never on
// auto-dismiss (this dialog's own auto-dismiss already defaults to
// 'cancel', unlike picker.js's own default-to-'Understood' — kept
// as-is here, not changed, since arming automatic clicking is a more
// consequential action than arming a manual picker, so it shouldn't
// happen silently just because the person walked away). This keeps
// the opt-out a deliberate action, same B12 safety reasoning
// picker.js's own header documents.
const ACTION_HIDE_FLAG_KEY = 'cookieClickerPicker.introSeen';
// Shown as an on-page notice (js/scripting/start-notice.js) when the picker
// starts WITHOUT its dialog because "Don't show this again" was ticked —
// otherwise a launch click looks like nothing happened (picking is armed,
// but nothing visible appears until the pointer moves). v9.6.5. Same
// wording shape as the Cosmetic element picker's own notice
// (picker/picker.js START_NOTICE_TEXT) — keep the two in step (C22).
const START_NOTICE_TEXT = 'Click the consent button to save it, Esc cancels.';
// Shown as the dialog's own standing explanation of what happens once
// "Understood" is clicked — plain instructional text, matching
// picker/picker.js's own INTRO_TEXT style (describes the workflow
// itself, not built around quoting a specific button's own label,
// since the button is now a generic "Understood" rather than an
// action-named one).
// (11.0.0) The owner's own, simpler wording (2026-11-19).
const AUTOMATE_EXPLANATION_TEXT = 'Click the Accept/Reject button on ' +
    'this page\u2019s cookie banner yourself once. Confirm your choice in ' +
    'the small popup that appears. Optionally add the button\u2019s ' +
    'visible label (e.g. \u201cAccept\u201d) as an extra safety net. The ' +
    'saved rule then clicks that same button on every future visit.';
// Longer than the old 3000ms intro's dismiss window — two buttons still
// need a moment longer to read/choose than a single "Got it".
const ACTION_AUTO_DISMISS_MS = 12000;

// REMOVED (v8.6.2) — DETECTION_STORAGE_KEY and the sessionReadOnce() call
// that used to read it in maybeShowActionDialog() below. Nothing writes
// this key anymore (js/workflow/cookie-clicker-routes.js's own D10
// detection pass was removed for the same reason — see that file's own
// comment for the full account, including why this file's OLD comment
// here claiming a consumer in cookie-clicker-autodeny-manager.js was
// itself already stale/inaccurate, confirmed by a full-tree grep before
// removing anything).

/* ══════════════════════════════════════════════════════════════
   3. STORAGE HELPERS  —  the "Don't show this again" flag
   ══════════════════════════════════════════════════════════════ */

// localRead()/localWrite() were briefly removed (v8.6.2, once
// sessionReadOnce()'s only call site — reading the D10 detection result
// popup.js used to write — was itself removed as dead weight; see
// js/workflow/cookie-clicker-routes.js's own comment for that account) and
// are back for the "Don't show this again" checkbox's own storage flag —
// ported from picker/picker.js's own localRead/localWrite pattern, per
// explicit request. A content script cannot import js/data/ext.js.
async function localRead(key) {
    try {
        const bin = await chrome.storage.local.get(key);
        return bin?.[key];
    } catch {
        // benign: a failed read means "flag not set" — the dialog is shown, which is the safe default
    }
}

async function localWrite(key, value) {
    try {
        await chrome.storage.local.set({ [key]: value });
    } catch {
        // benign: a failed write only means the dialog is shown again next time
    }
}

/* ══════════════════════════════════════════════════════════════
   4. FRAME IDENTITY
   ══════════════════════════════════════════════════════════════ */

// Frame identity — same document.location.ancestorOrigins-based technique
// isolated-api.js already provides (loaded as this file's own sibling
// dependency by popup.js's executeScript files array — see that call
// site), so this works correctly from inside a cross-origin iframe too.

const { isolatedAPI } = self;
if ( isolatedAPI === undefined ) { return; } // guard: shared dependency file failed to load

const topHostname = isolatedAPI.contexts.topHostname;
const thisHostname = document.location.hostname || '';

/* ══════════════════════════════════════════════════════════════
   5. SESSION STATE  —  everything stop() releases
   ══════════════════════════════════════════════════════════════ */

// Initial value depends on frame identity: the top frame starts PAUSED
// (false) until maybeShowActionDialog() resolves — either immediately setting
// this true (intro already seen) or leaving it false until the dialog
// is dismissed. Every other frame (an iframe) starts armed immediately,
// true — see this file's own header for why iframes are deliberately
// excluded from the intro-dialog gate.
let picking = window.top === window.self ? false : true; // also toggled false while a confirm bubble is open (see onClick())

// Hover highlight (section 12) — the element itself plus its own
// pre-existing inline outline, restored by clearHighlight().
let highlighted;        // the currently-outlined element, or undefined
let highlightedPrevOutline; // that element's own pre-existing inline outline (to restore)
let highlightedPrevOutlineOffset;

let confirmBubbleHost; // the currently-open confirm bubble's host element, or undefined

// Action dialog (section 9) — its host element and auto-dismiss timer are
// tracked here alongside the confirm bubble's, rather than being purely
// local to that section: stop() needs to be able to tear both down from a
// single RELEASE guard, including while the dialog is still up.
let introDialogHost;   // the currently-open action-dialog host element, or undefined
let introDismissHandle; // the pending ACTION_AUTO_DISMISS_MS timer, or undefined

/* ══════════════════════════════════════════════════════════════
   6. SMART BUTTON DETECTION
   ══════════════════════════════════════════════════════════════ */

// Smart button detection — see CLICKABLE_ANCESTOR_MAX_DEPTH above for
// why this exists. Used for BOTH the hover highlight (so the preview
// outline shows what will actually be picked) and the click handler
// (so the pick itself resolves to the same element).

// Semantic "this is a real clickable control" test — checked before the
// generic cursor:pointer fallback below, since a semantic match is far
// more reliable evidence of "this is THE control", not just "something
// somewhere in this element's subtree is clickable" (a large wrapping
// div can legitimately have cursor:pointer without itself being the
// intended target).
function isClickableControl(el) {
    const tag = el.localName;
    if ( tag === 'button' ) { return true; }
    if ( tag === 'a' && el.hasAttribute('href') ) { return true; }
    if ( tag === 'input' ) {
        const type = (el.getAttribute('type') || '').toLowerCase();
        return type === 'button' || type === 'submit' || type === 'reset' || type === 'image';
    }
    const role = el.getAttribute('role');
    if ( role === 'button' || role === 'link' ) { return true; }
    return false;
}

// Returns the best clickable target for `startEl`: the nearest ancestor
// (including itself) that isClickableControl() accepts, within
// CLICKABLE_ANCESTOR_MAX_DEPTH; else the nearest ancestor with an
// inline `cursor: pointer` style (a common non-semantic-markup pattern
// this project has no control over — some sites bind click handlers to
// a plain styled `<div>`), same depth bound; else `startEl` itself,
// unchanged — this function NEVER returns something the user didn't
// effectively point at, only refines within the depth bound.
function findClickTarget(startEl) {
    let node = startEl;
    for ( let depth = 0; depth < CLICKABLE_ANCESTOR_MAX_DEPTH && node && node.nodeType === 1; depth++ ) {
        if ( isClickableControl(node) ) { return node; }
        node = node.parentElement;
    }
    node = startEl;
    for ( let depth = 0; depth < CLICKABLE_ANCESTOR_MAX_DEPTH && node && node.nodeType === 1; depth++ ) {
        if ( self.getComputedStyle(node).cursor === 'pointer' ) { return node; }
        node = node.parentElement;
    }
    return startEl;
}

/* ══════════════════════════════════════════════════════════════
   7. SELECTOR BUILDER
   ══════════════════════════════════════════════════════════════ */

// Selector builder — simpler, purpose-built version of the same
// "walk up, prefer id, fall back to classes/nth-of-type, stop once
// unique" idea js/scripting/picker.js's candidatesAtPoint() already uses
// for the cosmetic picker, WITHOUT that file's full slider/multi-
// candidate machinery — this tool only ever needs ONE good selector per
// pick, not a ranked list of alternatives for the user to choose between
// (the textFilter field the confirm bubble also offers is this tool's
// equivalent safety net instead — see cookie-clicker-click.js's own
// header for why both together are enough).

function isStableClassName(name) {
    // Filters out the kind of class name that's more likely to be a
    // build-tool-generated utility/hash than a stable, human-authored
    // hook — heuristic, not exhaustive: rejects anything under 2 chars,
    // anything that's mostly digits, and single-letter-prefixed hash-like
    // tokens (e.g. 'css-1a2b3c', 'a3f9c1'). Good enough for this tool's
    // purpose (a candidate selector, refined by the textFilter safety net
    // if it turns out wrong) rather than a hard correctness requirement.
    if ( name.length < 2 ) { return false; }
    if ( /^[a-z0-9]{6,}$/i.test(name) && /\d/.test(name) ) { return false; }
    return true;
}

function selectorPartFor(node, parent) {
    if ( typeof node.id === 'string' && node.id !== '' ) {
        return `#${CSS.escape(node.id)}`;
    }
    let part = node.localName;
    const classes = Array.from(node.classList).filter(isStableClassName).slice(0, SELECTOR_MAX_CLASSES_PER_NODE);
    if ( classes.length > 0 ) {
        part += classes.map(c => `.${CSS.escape(c)}`).join('');
    }
    if ( parent ) {
        const sameTagSiblings = Array.from(parent.children).filter(el => el.localName === node.localName);
        if ( sameTagSiblings.length > 1 ) {
            part += `:nth-of-type(${sameTagSiblings.indexOf(node) + 1})`;
        }
    }
    return part;
}

// Returns a CSS selector string, unique within `scope` (document or a
// ShadowRoot) if one can be found within SELECTOR_MAX_DEPTH ancestors —
// else its best (possibly non-unique) attempt at that depth. Ancestor
// walk naturally stops at `scope`'s own boundary: `.parentElement` on a
// node whose parent is a ShadowRoot (not an Element) returns null, so no
// extra boundary check is needed here.
function buildSelectorScoped(target, scope) {
    const parts = [];
    let node = target;
    for ( let depth = 0; depth < SELECTOR_MAX_DEPTH && node && node.nodeType === 1; depth++ ) {
        const parent = node.parentElement;
        parts.unshift(selectorPartFor(node, parent));
        const candidate = parts.join(' > ');
        let matches;
        try {
            matches = scope.querySelectorAll(candidate);
        } catch {
            matches = [];
        }
        if ( matches.length === 1 ) { return candidate; }
        if ( parts[0].startsWith('#') ) { break; } // an id-rooted selector that's STILL not unique won't get more unique by walking further up
        node = parent;
    }
    return parts.join(' > ');
}

// FIX (8.2.11): a click landing inside a Shadow DOM subtree — DPG
// Media's own consent dialog on nu.nl, real report — needs TWO
// selectors, not one: `document.querySelectorAll()` (used both by this
// function's own uniqueness check and, later, by cookie-clicker-
// click.js's replay) can never see past a shadow boundary, open or
// closed, no matter how the selector is written. So the actual button
// needs a selector scoped to its OWN shadow root, PLUS a separate,
// document-scoped selector for the shadow HOST element, so a later page
// load can re-find the host, then step into its `.shadowRoot` from
// there.
//
// `target.getRootNode()` correctly returns the enclosing ShadowRoot
// regardless of open/closed mode — closed mode only blocks DISCOVERING
// a shadow root via the host's OWN `.shadowRoot` property from outside;
// it does not block a method call on a node reference already in hand
// (which is what we have here, via composedPath()). That asymmetry is
// exactly why `shadowRootClosed` below still matters: THIS function can
// always build a correct selector pair, but cookie-clicker-click.js's
// REPLAY, at a future page load with no live reference, can only
// re-enter the shadow tree via `host.shadowRoot` — which returns `null`
// for a closed root. A rule saved against a closed shadow root is
// therefore saved faithfully, but will never actually fire — the confirm
// bubble surfaces this plainly (see buildConfirmBubble's own
// `shadowRootClosed` handling) rather than silently producing a rule
// that looks fine and never works.
function buildSelector(target) {
    const shadowRoot = target.getRootNode();
    if ( shadowRoot instanceof ShadowRoot === false ) {
        return { selector: buildSelectorScoped(target, document), shadowHostSelector: null, shadowRootClosed: false };
    }
    return {
        selector: buildSelectorScoped(target, shadowRoot),
        shadowHostSelector: buildSelectorScoped(shadowRoot.host, document),
        shadowRootClosed: shadowRoot.mode === 'closed',
    };
}

/* ══════════════════════════════════════════════════════════════
   8. TOP-LAYER DIALOG HOST  —  shared by the action dialog and the
   confirm bubble
   ══════════════════════════════════════════════════════════════ */

// REAL-WORLD FIX (nature.com, reported): a plain `<div>` at the max
// z-index (2147483647) is still NOT guaranteed to render above
// everything on the page. Some sites (nature.com's OneTrust-style "TCF"
// banner confirmed via direct DevTools inspection: `<dialog class=
// "cc-banner cc-banner--is-tcf" ... open>` with its own `::backdrop`)
// build their consent banner from the native <dialog> element opened via
// showModal(), which Chrome always renders in a separate "top layer"
// that sits above the ENTIRE normal document — no z-index, however
// high, can out-rank it. Our own dialogs were plain styled <div>s and so
// always lost to any site using this pattern.
//
// Fix: each host is a real <dialog>, opened the same native way
// (`.showModal()`, by the caller). Top-layer dialogs stack in the order
// they were opened — most-recently-opened on top — and ours always opens
// AFTER the page's own (if any), so ours correctly wins.
//
// REAL BUG (caught live on nature.com, right after the top-layer fix
// above shipped): <dialog> is one of a small, fixed set of elements
// that CANNOT host a shadow root directly — attachShadow() throws
// NotSupportedError on it (confirmed against the actual browser
// error, not assumed). The permitted list is article/aside/
// blockquote/body/div/footer/h1-h6/header/main/nav/p/section/span
// plus autonomous custom elements — <dialog> was never on it, in any
// browser, at any version. Fix: attach the shadow root to a plain
// <div> INSIDE the <dialog> instead — the <dialog> itself only needs
// to exist for its native showModal()/top-layer behavior, nothing
// about that requires IT to be the shadow host.
//
// (10.7.9) Both builders created this same <dialog> + <div> + closed shadow
// root by hand; now one function, called with each builder's own inline
// styles. The host is NOT yet connected to the document.
function createTopLayerDialog(hostCssText, shadowHostCssText) {
    const host = document.createElement('dialog');
    host.style.cssText = hostCssText;
    const shadowHost = document.createElement('div');
    shadowHost.style.cssText = shadowHostCssText;
    host.appendChild(shadowHost);
    const root = shadowHost.attachShadow({ mode: 'closed' });
    return { host, root };
}

// Connects a host from createTopLayerDialog() and opens it in the top layer.
// Must append BEFORE calling showModal() — the element has to already be
// connected to the document, or this throws.
function openTopLayerDialog(host) {
    document.documentElement.appendChild(host);
    host.showModal();
}

// RELEASE for a host from createTopLayerDialog(): close() before remove() —
// a no-op if it's already closed, so safe to call unconditionally.
function closeTopLayerDialog(host) {
    host.close();
    host.remove();
}

/* ══════════════════════════════════════════════════════════════
   9. ACTION DIALOG  —  Cancel / Understood, top frame only
   ══════════════════════════════════════════════════════════════ */

// v8.3.9 — restyled to match the popup's own Worry-free modal design
// (popup/popup.css's #worryFreeModal*), per explicit "same style
// guide" request: same light/dark color values (copied from css/
// default.css's actual --surface-*/--ink-*/--border-1 RGB numbers —
// this is a content-script Shadow DOM running on an arbitrary page,
// with no access to the popup document's own CSS custom properties,
// so the values are duplicated here rather than referenced; kept in
// sync by eye against default.css, not a shared import — there's no
// cross-document custom-property mechanism that would make one
// possible), same @media (prefers-color-scheme: dark) switch
// js/ui/theme.js's own detection already uses, same panel/button
// shapes, and the SAME caption / choices / explanation-last order
// this dialog already used unchanged (the popup's own modal was
// restructured in 8.3.8 to match THIS dialog's order, not the other
// way around). v8.3.14 — font sizes increased throughout, per
// explicit feedback ("increase font size" on both dialogs).
// The markup is a literal at its innerHTML sink: only UPPER_CASE constants are interpolated (F-SINK-1).

const ACTION_DIALOG_HOST_CSS = 'all:initial;position:fixed;z-index:2147483647;inset:0;';
const ACTION_DIALOG_SHADOW_HOST_CSS = 'all:initial;display:block;height:100%;width:100%;';

// onChoice(choice) — choice is one of 'cancel' | 'automate'.
// v8.3.3: this dialog only ever offers Cancel/Automate now — the
// "Never consent" choice (previously gated here by autoDenyCapable, D12)
// moved to a standalone popup feature; see this file's DETECTION_STORAGE_KEY
// comment above for the full account.
//
// v8.3.14 — the capability-note (yellow "no known cookie consent
// mechanism..." text) and the separate status-text line both removed,
// per explicit feedback ("remove irrelevant yellow text" + "construct
// same [structure as the Worry-free modal] popup"). cmpFound/cmpName
// were read only to drive that note — no longer needed, so
// buildActionDialog() no longer takes them as a parameter at all. The
// caption itself now carries the status message directly (ACTION_TEXT's
// own value), matching the Worry-free modal's own pattern exactly (that
// modal's caption already IS the actual message/question, not a
// restated feature name — see popup/popup.html's
// #worryFreeModalCaption, 8.3.8).
//
// Layout note: the panel sizes to its content (`width: max-content`,
// capped by max-width in the markup below) so both buttons fit on ONE row without
// wrapping, left-aligned so Cancel starts directly under the title text
// — deliberately NOT right-aligned/wrapped, per the visual-feedback pass
// this replaced.
function buildActionDialog(onChoice) {
    const { host, root } = createTopLayerDialog(ACTION_DIALOG_HOST_CSS, ACTION_DIALOG_SHADOW_HOST_CSS);
    root.innerHTML = `
        <style>
            :host { all: initial; }
            .backdrop {
                /* Anchored top-right (near the browser's own extensions
                   toolbar/dropdown that launched this picker), not
                   centered — explicit request, see ACTION_DIALOG_ANCHOR_MARGIN's
                   own comment above for why this value specifically. */
                align-items: flex-start;
                background: rgb(0 0 0 / 45%);
                box-sizing: border-box;
                display: flex;
                height: 100%;
                justify-content: flex-end;
                padding: ${ACTION_DIALOG_ANCHOR_MARGIN}px ${ACTION_DIALOG_ANCHOR_MARGIN}px 0 0;
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
                max-width: 520px;
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
            /* Right-aligned, matching picker.css's own #pickerIntroButtons
               layout exactly — same workflow, same look. */
            .row { display: flex; flex-wrap: nowrap; align-items: center; gap: 8px; justify-content: flex-end; margin-bottom: 14px; }
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
            .understood { background: rgb(var(--mode-indicator)); color: #fff; }
            .understood:hover { background: rgb(var(--mode-indicator) / 85%); }
            .hide-next-time-row { align-items: center; display: flex; gap: 0.5em; margin: 0 0 14px; font-size: 13px; cursor: pointer; }
            .explanation-intro { color: rgb(var(--ink-1) / 78%); font-size: 13px; line-height: 1.4; margin: 0 0 14px; text-align: left; }
        </style>
        <div class="backdrop">
            <div class="panel">
                <p class="caption">Cookie consent clicker</p>
                <p class="explanation-intro">${AUTOMATE_EXPLANATION_TEXT}</p>
                <label class="hide-next-time-row">
                    <input class="hide-next-time" type="checkbox">
                    Don't show this again
                </label>
                <div class="row">
                    <button class="cancel" type="button">Cancel</button>
                    <button class="understood" type="button">Understood</button>
                </div>
            </div>
        </div>
    `;
    openTopLayerDialog(host);

    const cancelBtn = root.querySelector('.cancel');
    const understoodBtn = root.querySelector('.understood');
    const hideNextTimeBox = root.querySelector('.hide-next-time');

    function finish(choice) {
        // Only ever written on the affirmative path with the box
        // explicitly checked — never on Cancel, never on auto-dismiss
        // (which defaults to 'cancel' here — see ACTION_HIDE_FLAG_KEY's
        // own comment for why that's unchanged from picker.js's
        // own default-to-affirmative behavior).
        if ( choice === 'automate' && hideNextTimeBox.checked ) {
            localWrite(ACTION_HIDE_FLAG_KEY, true);
        }
        removeIntroDialog();
        onChoice(choice);
    }

    introDismissHandle = self.setTimeout(() => finish('cancel'), ACTION_AUTO_DISMISS_MS);
    cancelBtn.addEventListener('click', trustedOnly(() => finish('cancel')));
    understoodBtn.addEventListener('click', trustedOnly(() => finish('automate')));

    return host;
}

// RELEASE guard for JUST the action dialog's own state — folded into the
// file's single stop() guard, and also called directly by the dialog's own
// buttons and its auto-dismiss timer.
function removeIntroDialog() {
    if ( introDismissHandle !== undefined ) {
        clearTimeout(introDismissHandle);
        introDismissHandle = undefined;
    }
    if ( introDialogHost !== undefined ) {
        closeTopLayerDialog(introDialogHost);
        introDialogHost = undefined;
    }
}

/* ══════════════════════════════════════════════════════════════
   10. ACTION-DIALOG GATE  —  arms picking in the top frame
   ══════════════════════════════════════════════════════════════ */

// Only the top frame ever calls this (see this file's own header for why
// iframes are deliberately excluded — same scope decision the old intro
// dialog already made). Gates THIS frame's own `picking` flag until the
// dialog is dismissed — see the `let picking = ...` initializer (section 5)
// for the other half of this gate. (v8.6.2 — the D10 pre-launch
// detection this comment used to describe is gone; see this file's own
// comment above, near where DETECTION_STORAGE_KEY used to live, for the
// full account.)
async function maybeShowActionDialog() {
    if ( window.top !== window.self ) { return; }
    // Guard: same shape as picker.js's own hideFlag check before
    // showIntro() — if the person already opted out, arm directly
    // without showing the dialog at all, rather than showing it anyway.
    const hideFlag = await localRead(ACTION_HIDE_FLAG_KEY);
    if ( hideFlag === true ) {
        picking = true;
        // Optional chaining: start-notice.js is loaded by the launch route
        // just before this file; if it ever isn't, the picker still works,
        // just without the notice.
        self.uBolStartNotice?.show(START_NOTICE_TEXT);
        return;
    }
    introDialogHost = buildActionDialog(choice => {
        if ( choice === 'cancel' ) {
            // Cancel ends the WHOLE picking session tab-wide, same as
            // pressing Escape.
            endPickingSessionTabWide();
            return;
        }
        // 'automate' — arm picking mode, same as the old "Got it" path.
        picking = true;
    });
}

/* ══════════════════════════════════════════════════════════════
   11. CONFIRM BUBBLE  —  Save / optional text filter / Pick again
   ══════════════════════════════════════════════════════════════ */

// A small, self-contained panel (shadow DOM, so this tool's own styling can
// never leak into, or be leaked into by, the host page's CSS) offering
// Save / optional text filter / Cancel for whatever element was just clicked.
//
// (10.7.6) selectorText is built from the picked page element's own id/class attributes — fully PAGE-CONTROLLED. It is
// therefore never put into the HTML text (forbidden practice F-SINK-1): the bubble's markup below is fixed, and the
// selector is set afterwards with textContent / the title property, so the browser treats it as plain text whatever it
// contains. Replaces escapeHtmlText() and a hand-written quote escape (audit 10.7.5 B-3: "&" was not escaped there).
// The bubble's markup is a literal at its innerHTML sink (F-SINK-1).

// Same native-<dialog>/showModal() top-layer fix as the action dialog (see
// section 8). This bubble sets its own explicit `left`/`top` (it follows
// the click point, not a fixed corner), which still works correctly as a
// real <dialog>: the inline `all:initial` reset (needed either way, div or
// dialog, to strip host-page CSS leakage) already overrides the UA
// stylesheet's default `margin: auto` centering that <dialog>:modal would
// otherwise apply — inline styles always win over any stylesheet rule, so
// our explicit positioning is unaffected.
const CONFIRM_BUBBLE_HOST_CSS = 'all:initial;position:fixed;z-index:2147483647;';
// Unlike the action dialog's shadowHost, this one is NOT sized to
// 100%/100%: this bubble is a small, naturally-sized box positioned at a
// click point, not a full-viewport backdrop, so shadowHost must be free to
// size itself to its own content (the `.panel` inside) for the
// getBoundingClientRect() measurement to return the bubble's real size
// rather than a forced 100% one.
const CONFIRM_BUBBLE_SHADOW_HOST_CSS = 'all:initial;display:block;';

// v8.3.10 — real bug, not cosmetic: user reports the bubble "vaak
// helemaal onderaan staat" (often ends up right at the very bottom).
// Root cause: cookie-consent banners are overwhelmingly bottom-
// anchored UI, so ev.clientY (the click point this bubble positions
// from) is very often already near window.innerHeight — the OLD
// clamp-only logic just pinned the bubble to the bottom edge in that
// case instead of moving it somewhere more visible.
//
// Fix: measure the bubble's REAL rendered size (it's already in the
// DOM at that point, just not yet positioned/visible) instead of the
// old fixed 200px height guess, then place it with proper popover
// collision handling — prefer below-and-right of the click point,
// but FLIP above/left when the preferred side would overflow the
// viewport, only falling back to a plain clamp if even the flipped
// side doesn't fully fit (a very small viewport). This is the
// standard tooltip/popover placement strategy — same idea as CSS
// anchor-positioning's own fallback behavior, done manually here since
// that API isn't available in every browser this project targets yet.
//
// (10.7.9) Pure: computes { left, top } only; buildConfirmBubble() applies it.
function computeBubblePosition({ x, y, bubbleW, bubbleH, viewportW, viewportH }) {
    // Horizontal: prefer to the right of the click point, flip to the
    // left of it if that would overflow the right edge.
    let left;
    const fitsRight = x + BUBBLE_CLICK_GAP + bubbleW <= viewportW - BUBBLE_VIEWPORT_MARGIN;
    const fitsLeft  = x - BUBBLE_CLICK_GAP - bubbleW >= BUBBLE_VIEWPORT_MARGIN;
    if ( fitsRight || !fitsLeft ) {
        left = x + BUBBLE_CLICK_GAP;
    } else {
        left = x - BUBBLE_CLICK_GAP - bubbleW;
    }
    left = Math.min(Math.max(left, BUBBLE_VIEWPORT_MARGIN), viewportW - bubbleW - BUBBLE_VIEWPORT_MARGIN);

    // Vertical: prefer below the click point, flip ABOVE it if below
    // would overflow the bottom edge — this is the actual fix for the
    // reported complaint, since "below a bottom-anchored banner" is
    // exactly the case that used to just clamp to the bottom edge.
    let top;
    const fitsBelow = y + BUBBLE_CLICK_GAP + bubbleH <= viewportH - BUBBLE_VIEWPORT_MARGIN;
    const fitsAbove = y - BUBBLE_CLICK_GAP - bubbleH >= BUBBLE_VIEWPORT_MARGIN;
    if ( fitsBelow || !fitsAbove ) {
        top = y + BUBBLE_CLICK_GAP;
    } else {
        top = y - BUBBLE_CLICK_GAP - bubbleH;
    }
    top = Math.min(Math.max(top, BUBBLE_VIEWPORT_MARGIN), viewportH - bubbleH - BUBBLE_VIEWPORT_MARGIN);

    return { left, top };
}

function buildConfirmBubble({ x, y, selectorText, shadowRootClosed, onSave, onCancel }) {
    const { host, root } = createTopLayerDialog(CONFIRM_BUBBLE_HOST_CSS, CONFIRM_BUBBLE_SHADOW_HOST_CSS);
    root.innerHTML = `
        <style>
            :host { all: initial; }
            .panel {
                /* BUG FIXED: was hardcoded dark-only (#1e1e1e etc.) regardless
                   of the person's own light/dark preference — the only one of
                   this file's three dialogs that didn't follow the system
                   theme. Same RGB values + media-query switch as
                   buildActionDialog()'s own .panel above, duplicated here for
                   the same reason (a content-script Shadow DOM has no access
                   to another document's CSS custom properties) — kept
                   consistent with default.css by eye, not a shared import.
                   --code-green is the already-verified green-text pair from
                   STYLE_GUIDE_LIGHT.md/STYLE_GUIDE_DARK.md (A9 — reuse a
                   proven value, not a freshly-guessed one): the original
                   #9fd39f was only ever tuned to read against a near-black
                   #111 background and was never checked against a light
                   background at all. */
                --surface-1: 240 240 242;
                --surface-2: 226 226 229;
                --surface-3: 198 198 204;
                --border-1:  184 184 192;
                --ink-1:     32 18 58;
                --code-green: 22 115 66; /* light — 5.18:1 vs --surface-1, passes 4.5:1 */
                background: rgb(var(--surface-1));
                border: 1px solid rgb(var(--border-1));
                border-radius: 6px;
                box-shadow: 0 4px 16px rgb(0 0 0 / 25%);
                color: rgb(var(--ink-1));
                font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                padding: 10px 12px;
                width: 280px;
            }
            @media (prefers-color-scheme: dark) {
                .panel {
                    --surface-1: 27 27 35;
                    --surface-2: 47 47 59;
                    --surface-3: 69 69 85;
                    --border-1:  81 81 98;
                    --ink-1:     226 226 229;
                    --code-green: 77 219 138; /* dark — 9.62:1 vs --surface-1, text-safe */
                }
            }
            .title { font-weight: 600; margin: 0 0 6px; text-align: left; }
            .selector {
                background: rgb(var(--surface-1));
                border: 1px solid rgb(var(--border-1));
                border-radius: 3px;
                color: rgb(var(--code-green));
                font-family: monospace;
                margin: 0 0 8px;
                max-height: 3.6em;
                overflow: hidden;
                padding: 4px 6px;
                text-align: left;
                text-overflow: ellipsis;
                word-break: break-all;
            }
            label { display: block; margin: 0 0 3px; opacity: 0.85; text-align: left; }
            input {
                background: rgb(var(--surface-2));
                border: 1px solid rgb(var(--border-1));
                border-radius: 3px;
                box-sizing: border-box;
                color: rgb(var(--ink-1));
                margin: 0 0 8px;
                padding: 4px 6px;
                width: 100%;
            }
            .row { display: flex; gap: 6px; justify-content: flex-end; }
            button {
                border: 0;
                border-radius: 3px;
                cursor: pointer;
                font: inherit;
                padding: 5px 10px;
            }
            .save { background: #1a7f37; color: #fff; }
            .cancel { background: rgb(var(--surface-3)); color: rgb(var(--ink-1)); }
            .hint { margin: 0 0 8px; opacity: 0.7; text-align: left; }
            .shadow-warning { color: #d0a020; margin: 0 0 8px; text-align: left; }
        </style>
        <div class="panel">
            <p class="title">Save consent-click rule?</p>
            <p class="selector"></p>
            <p class="shadow-warning" hidden>This button lives inside a closed shadow DOM — some sites use this specifically to block automation. Saving may not work on future visits.</p>
            <p class="hint">Optionally add the button's visible label text — e.g. "Accept" or "Reject All" — not its name/id/class. Exact case, just the core word.</p>
            <label for="textFilter">Text filter (optional)</label>
            <input id="textFilter" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. Accept">
            <div class="row">
                <button class="cancel" type="button">Pick again</button>
                <button class="save" type="button">Save &amp; click</button>
            </div>
        </div>
    `;
    // Page-controlled text: set as text, never as HTML (see the F-SINK-1 comment above this function).
    const selectorEl = root.querySelector('.selector');
    selectorEl.textContent = selectorText;
    selectorEl.title = selectorText;
    root.querySelector('.shadow-warning').hidden = shadowRootClosed !== true;
    openTopLayerDialog(host);

    const rect = root.querySelector('.panel').getBoundingClientRect();
    const { left, top } = computeBubblePosition({
        x,
        y,
        bubbleW: rect.width  || BUBBLE_FALLBACK_WIDTH,
        bubbleH: rect.height || BUBBLE_FALLBACK_HEIGHT,
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
    });
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;

    const saveBtn = root.querySelector('.save');
    const cancelBtn = root.querySelector('.cancel');
    const textFilterInput = root.querySelector('#textFilter');

    saveBtn.addEventListener('click', trustedOnly(() => onSave(textFilterInput.value.trim())));
    cancelBtn.addEventListener('click', trustedOnly(() => onCancel()));

    return host; // caller keeps this to remove it later (release guard — see stop())
}

function removeConfirmBubble() {
    if ( confirmBubbleHost === undefined ) { return; }
    closeTopLayerDialog(confirmBubbleHost);
    confirmBubbleHost = undefined;
}

/* ══════════════════════════════════════════════════════════════
   12. HOVER HIGHLIGHT
   ══════════════════════════════════════════════════════════════ */

// RELEASE guard: always restores whatever inline `outline`/`outlineOffset`
// the element had BEFORE this script touched it (captured once per
// element, the first time it's highlighted), rather than unconditionally
// clearing those properties — a page that itself sets an inline outline
// style must get that back untouched when picking ends, not have it
// silently erased.
function clearHighlight() {
    if ( highlighted === undefined ) { return; }
    highlighted.style.outline = highlightedPrevOutline;
    highlighted.style.outlineOffset = highlightedPrevOutlineOffset;
    highlighted = undefined;
}

function highlight(el) {
    if ( el === highlighted ) { return; }
    clearHighlight();
    if ( !(el instanceof Element) ) { return; }
    highlightedPrevOutline = el.style.outline;
    highlightedPrevOutlineOffset = el.style.outlineOffset;
    el.style.outline = HIGHLIGHT_OUTLINE;
    el.style.outlineOffset = HIGHLIGHT_OUTLINE_OFFSET;
    highlighted = el;
}

/* ══════════════════════════════════════════════════════════════
   13. PICKING ACTIONS  —  save a pick, end the session
   ══════════════════════════════════════════════════════════════ */

// Save handler for the confirm bubble of one pick.
async function saveRuleAndClick(target, { selector, shadowHostSelector }, textFilter) {
    const response = await sendToExtension({
        what: MSG_ADD_RULE,
        siteHostname: topHostname,
        frameHostname: thisHostname,
        selector,
        shadowHostSelector,
        textFilter,
    }).catch(() => undefined); // benign: no answer = not saved; the target is then not clicked
    // Close the confirm bubble BEFORE clicking target, not after
    // — now that the bubble is a real modal <dialog> (see
    // section 8), the page underneath it is treated as "inert"
    // (non-interactive to the USER) for as long as our modal stays
    // open. target.click() is a direct script call, not user input,
    // so it isn't actually blocked by that — but closing first removes
    // any ambiguity instead of relying on that distinction.
    removeConfirmBubble();
    if ( response?.ok ) {
        // Immediate-effect guard: click the just-saved target
        // right now too, in THIS already-open banner, rather
        // than making the user reload the page to see the rule
        // take effect for the very first time.
        try { target.click(); } catch { /* benign: the rule is saved; it fires on the next visit */ }
    }
    self.__uBolCookieClickerPicker?.stop();
}

// Ends the WHOLE picking session tab-wide, not just this frame — relayed
// via the service worker (see MSG_COOKIE_CLICKER_PICKER_STOP's own comment
// in message-types.js for why a broadcast, not a direct cross-frame call,
// is how this reaches sibling/parent frames). Used by Escape and by the
// action dialog's Cancel.
function endPickingSessionTabWide() {
    sendToExtension({ what: MSG_PICK_CANCELLED }).catch(() => {}); // benign: this frame stops regardless
    self.__uBolCookieClickerPicker?.stop();
}

/* ══════════════════════════════════════════════════════════════
   14. EVENT HANDLERS
   ══════════════════════════════════════════════════════════════ */

// Hardening (10.7.13): only a real user gesture may drive the picker.
// The page shares this DOM, so its scripts can dispatch synthetic
// mouseover/click/keydown events (and call .click() on our buttons'
// hosts) — those arrive with isTrusted === false and are ignored here,
// so a page can neither pick an element of its choosing, confirm a save,
// nor end the session on the user's behalf. Real input is unaffected.
function isUserGesture(ev) {
    return ev?.isTrusted === true;
}

// Wraps a button handler so it runs for real user clicks only.
function trustedOnly(handler) {
    return ev => {
        if ( isUserGesture(ev) === false ) { return; }
        handler(ev);
    };
}

function onMouseOver(ev) {
    if ( !picking ) { return; }
    if ( isUserGesture(ev) === false ) { return; }
    // FIX (8.2.11): ev.target, not ev.composedPath()[0] — a click/hover
    // landing inside a Shadow DOM subtree (e.g. DPG Media's own
    // '#pg-shadow-host-dom' consent dialog, observed on nu.nl) gets
    // ev.target RETARGETED to the shadow HOST element by the browser
    // itself, per standard shadow-DOM event retargeting rules — this
    // applies to both open and closed shadow roots, and happens
    // specifically because this listener is attached on `document`,
    // outside the shadow tree. composedPath()[0] is the one API that
    // correctly returns the true innermost originating element straight
    // through any shadow boundary, open or closed.
    const startEl = ev.composedPath()[0];
    if ( startEl instanceof Element === false ) { return; }
    highlight(findClickTarget(startEl));
}

function onClick(ev) {
    if ( !picking ) { return; }
    if ( isUserGesture(ev) === false ) { return; }
    const startEl = ev.composedPath()[0]; // see onMouseOver()'s comment on why not ev.target
    if ( startEl instanceof Element === false ) { return; }
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    // Smart-button resolution — see CLICKABLE_ANCESTOR_MAX_DEPTH's own
    // comment above. Same call as onMouseOver()'s highlight so the pick
    // always resolves to exactly what was just outlined, never a
    // surprise switch between hover and click.
    const target = findClickTarget(startEl);
    const { selector, shadowHostSelector, shadowRootClosed } = buildSelector(target);
    picking = false;
    clearHighlight();


    confirmBubbleHost = buildConfirmBubble({
        x: ev.clientX,
        y: ev.clientY,
        selectorText: selector,
        shadowRootClosed,
        onSave: textFilter => saveRuleAndClick(target, { selector, shadowHostSelector }, textFilter),
        onCancel() {
            removeConfirmBubble();
            picking = true;
        },
    });
}

function onKeyDown(ev) {
    if ( isUserGesture(ev) === false ) { return; }
    if ( ev.key !== 'Escape' && ev.which !== 27 ) { return; }
    ev.stopPropagation();
    ev.preventDefault();
    endPickingSessionTabWide();
}

function onRuntimeMessage(msg) {
    if ( msg?.what !== MSG_PICKER_STOP ) { return; }
    self.__uBolCookieClickerPicker?.stop();
}

/* ══════════════════════════════════════════════════════════════
   15. LIFECYCLE  —  start / stop (the RELEASE guard)
   ══════════════════════════════════════════════════════════════ */

function start() {
    // C47 (10.7.15): on WINDOW, capture phase — the earliest point in the event's path, so a page's own
    // window/document capture listener cannot stop the event before the picker sees it.
    window.addEventListener('mouseover', onMouseOver, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    maybeShowActionDialog();
}

// RELEASE guard — the ONE place every listener/DOM node/style mutation/
// timer this file made gets torn down. See this file's own header for
// the full list of call sites that reach here — notably including
// Escape pressed WHILE the intro dialog is still up, which is why
// removeIntroDialog() (host + its own pending auto-dismiss timer) is
// folded in here rather than only ever being cleaned up by the dialog's
// own buttons/timer.
function stop() {
    window.removeEventListener('mouseover', onMouseOver, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    clearHighlight();
    removeConfirmBubble();
    removeIntroDialog();
    self.uBolStartNotice?.hide(); // RELEASE — notice + its auto-dismiss timer (v9.6.5)
    self.__uBolCookieClickerPicker = undefined;
}

self.__uBolCookieClickerPicker = { stop };
start();

/******************************************************************************/

})();

void 0;

