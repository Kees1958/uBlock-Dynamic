// ── trusted-sender.js ─────────────────────────────────────────────────────────
// Decides whether a runtime message comes from uBD itself (C28, F-TRUST-2).
//
// Public interface:
//   isTrustedSender(sender, extensionOrigin, extensionId) — true for an internal call (no sender at all) or one of
//                                                           this extension's own pages (own id AND own origin)
//   trustedHostnameFromSender(sender, { preferTabUrl })    — the hostname a content-script message really comes from,
//                                                           from Chrome's sender.url / sender.tab.url ('' if none)
//
// Dependencies: none (util/ tier — imports nothing, so workflow/ and core/ may both use it).
// State owned: none (pure function).
//
// Moved here verbatim from js/workflow/message-routes.js in 10.7.9 (audit 10.7.8) so the core-tier offscreen
// compile listener (js/core/compiled-filters.js) can use the same rule without an upward import.
// message-routes.js re-exports it under the same name, so every existing importer keeps working.
// ──────────────────────────────────────────────────────────────────────────────

// True for uBD's own internal calls (no sender at all — js/data/alarms.js processDueJobs(), the deadline alarms) and
// for this extension's own pages (sender.id is ours AND sender.origin is our chrome-extension:// origin). Until 10.7.6
// a sender OBJECT without an origin was trusted too; every real sender has an origin since Chrome 80, so that was a
// latent gap, not a behaviour anyone relied on. Pure: the caller passes its own origin and id.
export function isTrustedSender(sender, extensionOrigin, extensionId) {
    if ( sender === undefined ) { return true; }
    if ( sender === null || typeof sender !== 'object' ) { return false; }
    if ( sender.id !== extensionId ) { return false; }
    return typeof sender.origin === 'string' && sender.origin.toLowerCase() === extensionOrigin;
}

// Derives the hostname a content-script- or picker-relayed message is
// really operating on — never trust a request-supplied hostname directly.
// Real reason: css-user.js/tool-overlay.js derive their hostname from
// `document.baseURI`, which a page can spoof via `<base href="...">`
// before the content script ever reads it. `sender.url`/`sender.tab.url`
// are Chrome's own authoritative record of the frame's/tab's URL and are
// not something page content can rewrite — same proven pattern already
// used by custom-scriptlets.js's injectCustomScriptletsForFrame() call
// site and privacy-inspector.js's recordPrivacyInspectorEvent() ("never
// trust tabId alone", sender.url || sender.tab?.url for the frame's own
// URL) — ported here rather than re-derived, per this project's own
// reuse-a-proven-solution convention.
//
// preferTabUrl: the picker's own UI (picker.js) runs inside a TRUSTED
// chrome-extension://<id>/picker/picker.html iframe overlaid on the real
// page (see tool-overlay.js's install()) — for messages it sends,
// sender.url is the IFRAME's own extension-origin URL, not the page being
// picked from; sender.tab.url (the tab hosting that iframe) is the value
// that actually means "the page the user is picking on". For a genuine
// page-context content script (css-user.js), sender.url already is the
// correct frame URL and should be preferred.
// (11.0.0) Exported for js/workflow/ad-cleaner-routes.js (same proven check, not a copy — C21).
// (11.0.3, C15) Moved here verbatim from js/workflow/filter-routes.js: two route files need it, and a route file may
// not import another route file. It is pure and imports nothing, so util/ is its tier.
export function trustedHostnameFromSender(sender, { preferTabUrl = false } = {}) {
    const url = preferTabUrl
        ? (sender?.tab?.url || sender?.url || '')
        : (sender?.url || sender?.tab?.url || '');
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}
