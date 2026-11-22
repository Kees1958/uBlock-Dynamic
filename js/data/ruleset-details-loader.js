// ── ruleset-details-loader.js ───────────────────────────────────────────────
// Single, shared fetch-and-cache of rulesets/ruleset-details.json — the
// build-generated catalog of every ruleset's name, category and locale
// auto-enable triggers (see tools/build/build-steps.mjs's own comment on
// the `category`/`locales` fields, added 10.0.5). Every page-context
// consumer that needs a human name or category for a ruleset id reads
// this instead of keeping its own hand-maintained copy.
//
// Public interface:
//   loadRulesetDetailsMap()  — returns a Promise<Map<id, entry>>, where
//     entry is the raw ruleset-details.json object for that id
//     ({ id, name, category, locales, enabled, ruleCount, ... }).
//
// Dependencies (must be loaded before this file):
//   js/data/ext.js: runtime
//
// Fetches via runtime.getURL('/rulesets/ruleset-details.json') — an
// absolute extension URL, not a relative path — so this one module works
// identically from a page context (dashboard/, matrix/, one directory
// below the extension root) AND the service worker (js/workflow/
// background.js, loaded from a different location entirely). A relative
// '../rulesets/...' path only resolves correctly from the former; using
// runtime.getURL() throughout is what lets background.js share this same
// loader instead of needing its own fetch (10.0.5 — see this module's own
// header on why it exists).
//
// State owned by this module:
//   rulesetDetailsPromise  — the in-flight/resolved fetch, cached so every
//     caller across every importing page shares the SAME fetch pass (same
//     "cache the promise, not a not-yet-populated result" pattern this
//     logic already used before being extracted here — see the BUG FIX
//     comment this file's history carries forward from
//     dashboard/filter-manager-ui.js).
import { runtime } from './ext.js';

let rulesetDetailsPromise = null;

export async function loadRulesetDetailsMap() {
    if ( rulesetDetailsPromise !== null ) { return rulesetDetailsPromise; }
    rulesetDetailsPromise = (async () => {
        const map = new Map();
        try {
            const resp = await fetch(runtime.getURL('/rulesets/ruleset-details.json'));
            const list = await resp.json();
            for ( const entry of list ) {
                map.set(entry.id, entry);
            }
        } catch (reason) {
            console.error('[uBlock-Dynamic] ruleset-details-loader:', reason);
        }
        return map;
    })();
    return rulesetDetailsPromise;
}
