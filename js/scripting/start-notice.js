/*******************************************************************************

    uBlock-Stripped-Dynamic — start-notice.js

    A small, auto-dismissing, display-only on-page notice for the Cookie
    consent clicker's start feedback (v9.6.5, see CHANGELOG "picker start
    feedback"): tells the person what just happened when a launch click
    would otherwise look like nothing happened.

    Public interface (isolated world, TOP FRAME ONLY — in an iframe this
    file defines nothing, so callers use optional chaining):
      self.uBolStartNotice.show(text) — replaces any notice already up,
                                        shows `text` for NOTICE_DISPLAY_MS
      self.uBolStartNotice.hide()     — removes the notice + its timer now

    Loaded, never registered: injected on demand by
      - js/workflow/cookie-clicker-routes.js (before cookie-clicker-
        picker.js in the launch files list; and alone, followed by a one-
        line show() call, when a launch click stops a running Worry-free
        session instead of launching the picker)
    and consumed by js/scripting/cookie-clicker-picker.js.
    (The Cosmetic element picker has its own notice element inside its
    own panel, picker/picker.html — different context, same wording
    shape; see that file's config block.)

    State owned by this file: `dismissHandle` (auto-dismiss timer),
    `noticeHost` (the single DOM node). Both are cleared together in
    hide(), which show() calls first — so there is never more than one
    notice and never a stray timer. Lost on page navigation (safe: the
    notice is transient by design).

    Colours: NO new values. Same RGB tokens the consent picker's own
    dialogs already use (copied from css/default.css; content scripts
    cannot reference the popup document's custom properties). Text is
    --ink-1 on --surface-1: 15.26:1 light / 13.23:1 dark, computed and
    recorded in STYLE_GUIDE_LIGHT.md / STYLE_GUIDE_DARK.md (core tokens
    table) — well above the 4.5:1 bar. --border-1 is a decorative edge
    only (same use as the dialogs' panels).

*******************************************************************************/

(function uBOL_startNotice() {

// Already loaded in this frame (a second injection must not redefine the
// API or reset an active notice), or not the top frame (the notice is a
// page-level message; iframes never show one).
if ( self.uBolStartNotice !== undefined ) { return; }
if ( window.top !== window.self ) { return; }

/******************************************************************************/
// Config — every constant this file uses, declared once, here.
/******************************************************************************/

// How long a notice stays up (ms). Deliberately longer than the 3 s
// intro-popup window that caused the "missed it once, gone forever"
// class of bug (CHANGELOG B12): unlike that one-shot popup this notice is
// shown on EVERY qualifying launch, so a missed one is one re-click away —
// but a comfortable read time still costs nothing.
const NOTICE_DISPLAY_MS = 6000;
// Distance from the top of the viewport, px.
const NOTICE_TOP_PX = 16;
// Max text width, px — keeps a longer sentence from spanning a wide page.
const NOTICE_MAX_WIDTH_PX = 460;
// Above every page layer; the host is also promoted to the top layer via
// the popover API below, so an already-open modal consent dialog (itself
// in the top layer) cannot cover it.
const NOTICE_Z_INDEX = 2147483647;

/******************************************************************************/

let dismissHandle;   // pending auto-dismiss timer, undefined = none
let noticeHost;      // the single notice DOM node, undefined = none

function hide() {
    if ( dismissHandle !== undefined ) {
        self.clearTimeout(dismissHandle);
        dismissHandle = undefined;
    }
    if ( noticeHost === undefined ) { return; }
    try { noticeHost.hidePopover(); } catch { /* not shown as a popover, or already hidden */ }
    noticeHost.remove();
    noticeHost = undefined;
}

function buildNoticeHost(text) {
    const host = document.createElement('div');
    host.setAttribute('popover', 'manual');
    // pointer-events:none — display-only; must never intercept a click
    // meant for the consent banner or the picker's own hover targeting.
    host.style.cssText = `all:initial;position:fixed;top:${NOTICE_TOP_PX}px;left:50%;` +
        `transform:translateX(-50%);z-index:${NOTICE_Z_INDEX};pointer-events:none;`;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
        <style>
            :host { all: initial; }
            .notice {
                --surface-1: 240 240 242;
                --border-1:  184 184 192;
                --ink-1:     32 18 58;
                background: rgb(var(--surface-1));
                border: 1px solid rgb(var(--border-1));
                border-radius: 8px;
                box-shadow: 0 4px 16px rgb(0 0 0 / 25%);
                box-sizing: border-box;
                color: rgb(var(--ink-1));
                font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                max-width: ${NOTICE_MAX_WIDTH_PX}px;
                padding: 12px 16px;
                width: max-content;
            }
            @media (prefers-color-scheme: dark) {
                .notice {
                    --surface-1: 27 27 35;
                    --border-1:  81 81 98;
                    --ink-1:     226 226 229;
                }
            }
        </style>
        <div class="notice" role="status"></div>
    `;
    // textContent, never innerHTML — the text is a constant today, but
    // this file must stay safe if a caller ever passes anything else.
    root.querySelector('.notice').textContent = text;
    return host;
}

function show(text) {
    if ( typeof text !== 'string' || text === '' ) { return; }
    hide();
    noticeHost = buildNoticeHost(text);
    document.documentElement.appendChild(noticeHost);
    // Must be connected before showPopover(). If the popover API is
    // unavailable the fixed position + max z-index above still show it.
    try { noticeHost.showPopover(); } catch { /* fallback: plain fixed element */ }
    dismissHandle = self.setTimeout(hide, NOTICE_DISPLAY_MS);
}

self.uBolStartNotice = Object.freeze({ show, hide });

/******************************************************************************/

})();

void 0;
