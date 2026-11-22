/*
 * tracker-radar-lookup.js — Lookup against the bundled DuckDuckGo Tracker
 * Radar dataset (js/data/tracker-radar-data.json)
 *
 * Public interface:
 *   preloadTrackerRadarData() — kicks off (and caches) the lazy fetch() of
 *                              the ~200KB dataset. Call once, as early as
 *                              possible, from a moment that can absorb the
 *                              load — matrix-panel.js's startMatrix() calls
 *                              this alongside its other setup steps, well
 *                              before its own tab-reload lets any real
 *                              request reach lookupTracker()/isKnownTracker()
 *                              below. NOT required before calling either of
 *                              those — they degrade safely (never match) if
 *                              called before this resolves — but calling it
 *                              first is what actually avoids the cold-start
 *                              cost this module would otherwise pay on every
 *                              service-worker wake-up regardless of whether
 *                              the Matrix panel was ever opened.
 *
 *                              FIXED (found via a real error report —
 *                              "import() is disallowed on
 *                              ServiceWorkerGlobalScope by the HTML
 *                              specification"): this used to be a dynamic
 *                              `import('../data/tracker-radar-data.js')`,
 *                              chosen specifically to keep the data lazy
 *                              (see OPTIMIZE.md 1.2 for why a static
 *                              top-level `import` was rejected — it would
 *                              have forced lookupTracker() async). What
 *                              wasn't caught at the time: dynamic import()
 *                              is unconditionally disallowed inside a
 *                              service worker, in every browser that
 *                              implements the spec — this call always
 *                              threw, was silently swallowed by its own
 *                              .catch(), and the dataset never loaded, ever.
 *                              Safe degradation (see lookupTracker() below)
 *                              is exactly why this shipped for a while with
 *                              no visible symptom beyond "Known Tracker"
 *                              never showing Y. Fixed by reusing the same
 *                              lazy-fetch pattern scripting-manager.js
 *                              already uses for scriptlet-files.json —
 *                              fetch() IS allowed in a service worker,
 *                              unlike import() — which requires the dataset
 *                              to ship as plain JSON rather than an ES
 *                              module (see tools/build-tracker-radar.mjs).
 *   lookupTracker(hostname) — { owner, prevalence, fingerprinting } for the
 *                              matching entry, or null if hostname is not a
 *                              known tracker domain OR the dataset hasn't
 *                              finished loading yet (see above — safe
 *                              degradation, not an error)
 *   isKnownTracker(hostname) — boolean convenience wrapper around
 *                              lookupTracker(), for callers that only need
 *                              a Known Tracker Y/N answer (e.g. the Matrix
 *                              panel's "Known tracker" column) and don't
 *                              need owner/prevalence/fingerprinting detail
 *
 * Dependencies: js/data/tracker-radar-data.json (fetched lazily, not
 * imported — see preloadTrackerRadarData() above for why).
 *
 * State owned by this module:
 *   trackerRadarDomains {Object} — populated by preloadTrackerRadarData();
 *     {} until then, so lookupTracker() degrades to "no match" rather than
 *     throwing. Lost on SW restart; safe — the next startMatrix() call
 *     re-triggers preloadTrackerRadarData() same as a first load.
 *   preloadPromise {Promise|undefined} — in-flight/completed load, so a
 *     second preloadTrackerRadarData() call (e.g. a second Matrix session
 *     in the same SW lifetime) reuses it instead of re-fetching.
 *
 * Matching is exact-domain plus registrable-suffix (the dataset key IS the
 * registrable/eTLD+1 domain for each entry — e.g. 'doubleclick.net' — so a
 * request host of 'stats.g.doubleclick.net' must be checked at every
 * dot-boundary suffix, not just as an exact string, the same walk-up
 * pattern isBuiltinWhitelisted()/isSignalDomain() use in
 * matrix-classifier.js). General-purpose: this module has no UI of its own
 * and is not exclusively owned by any one consumer — see CHANGELOG for the
 * history of what previously consumed it and why this restoration ships
 * with only the Matrix panel's "Known tracker" column wired to it, not a
 * full re-creation of every past consumer.
 */

import { webext } from '../data/ext-compat.js';

let trackerRadarDomains = {};
let preloadPromise;

export function preloadTrackerRadarData() {
    if ( preloadPromise === undefined ) {
        preloadPromise = fetch(webext.runtime.getURL('/js/data/tracker-radar-data.json'))
            .then(resp => resp.json())
            .then(data => { trackerRadarDomains = data; })
            .catch(reason => {
                console.error(`[uBlock-Dynamic] preloadTrackerRadarData/${reason}`);
            });
    }
    return preloadPromise;
}

/******************************************************************************/

// Walk every dot-boundary suffix of `hostname` (most-specific first) and
// return the first matching dataset entry, or null. Mirrors
// matrix-classifier.js's own suffix-walk shape for consistency across the
// codebase's domain-lookup helpers (see C21 — reuse a proven pattern
// rather than inventing a second one).
export function lookupTracker(hostname) {
    if ( typeof hostname !== 'string' || hostname === '' ) { return null; }
    let host = hostname.toLowerCase();
    for (;;) {
        const entry = trackerRadarDomains[host];
        if ( entry !== undefined ) { return entry; }
        const dot = host.indexOf('.');
        if ( dot === -1 ) { return null; }
        host = host.slice(dot + 1);
        if ( host.indexOf('.') === -1 ) { return null; } // stop at bare TLD
    }
}

export function isKnownTracker(hostname) {
    return lookupTracker(hostname) !== null;
}

/******************************************************************************/
