/*
 * scriptlet-site-scope.js — (10.5.6) where the two scriptlet registrations may run (pure).
 *
 * Why: up to 10.5.5 every page and frame received the full scriptlet data of every enabled list (about 1 MB,
 * mostly AdGuard Base's table for ~14,000 sites) and searched it for its own hostname — on most sites without a
 * hit. Measured in Chrome (10.5.5): pages reached DOMContentLoaded 35-45 ms later; without that data, about as
 * fast as with no extension. Now Chrome itself decides, from match patterns, which pages get it:
 *   SITES  — the sites the lists name, each with its subdomains;
 *   ENTITY — every other page (the "name.*" rules, which no match pattern can express).
 * See js/data/scriptlet-library.js for the files each registration carries.
 *
 * Public interface:
 *   sitePattern(host)                         — the one Chrome match pattern for a site and its subdomains
 *   topLevelSites(keys)                       — the keys that are not a subdomain of another key (fewer patterns)
 *   buildScriptletScopes(siteKeys, siteMode)  — { sites, entity }: matches/excludeMatches of both registrations
 *   directiveUpdate(existing, wanted)         — the fields of `wanted` that differ from the registered script,
 *                                               or null when nothing differs (skip the call)
 * Dependencies: none. Pure functions: everything is allocated inside the call, nothing is kept.
 */

// ── Settings (one place) ──────────────────────────────────────────────────────────────────────────
// A dotted-quad IP key: Chrome's "*." host wildcard does not apply to an IP address, so it gets an exact pattern.
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// Fields of a registered content script compared by directiveUpdate() (everything this module's callers set).
const COMPARED_FIELDS = Object.freeze([ 'js', 'matches', 'excludeMatches', 'world', 'runAt', 'allFrames' ]);
const LABEL_SEP = '.';

// `*://*.example.com/*` matches example.com itself and every subdomain (verified in Chrome, 2026-11-03).
export function sitePattern(host) {
    return IPV4_RE.test(host) ? `*://${host}/*` : `*://*.${host}/*`;
}

// Same two patterns buildSiteModeMatchScope() uses for an allowed (reverse-mode) site.
function allowedPatterns(host) {
    return [ `*://${host}/*`, `*://*.${host}/*` ];
}

// Every parent of a host ("a.b.c" -> b.c, c), not the host itself.
function parentsOf(host) {
    const out = [];
    for ( let i = host.indexOf(LABEL_SEP); i !== -1; i = host.indexOf(LABEL_SEP, i + 1) ) { out.push(host.slice(i + 1)); }
    return out;
}

// A key whose parent is also a key adds nothing: the parent's pattern already covers it.
export function topLevelSites(keys) {
    const all = new Set(keys);
    return [ ...all ].filter(k => IPV4_RE.test(k) || parentsOf(k).every(p => all.has(p) === false)).sort();
}

// siteKeys: every site key of the enabled lists. siteMode: buildSiteModeMatchScope()'s result
// ({ matches, excludeMatches, allowedHosts }). Normal mode: SITES runs on the listed sites; ENTITY everywhere else.
// Reverse mode (filtering on only for `allowedHosts`): both are limited to the allowed sites — SITES to the listed
// sites inside them, ENTITY to the allowed sites minus the listed ones. Sites switched off (excludeMatches) are
// excluded from both, exactly as the single registration excluded them.
export function buildScriptletScopes(siteKeys, siteMode) {
    const sites = topLevelSites(siteKeys);
    const sitePatterns = sites.map(sitePattern);
    const siteModeExcludes = siteMode.excludeMatches ?? [];
    let siteMatches;
    if ( siteMode.allowedHosts === null || siteMode.allowedHosts === undefined ) {
        siteMatches = sitePatterns;
    } else {
        // Intersection of "a listed site (+ subdomains)" and "an allowed site (+ subdomains)": the deeper of the two
        // whenever one is inside the other.
        const allowed = new Set(siteMode.allowedHosts);
        const out = new Set();
        for ( const site of sites ) {
            if ( allowed.has(site) || parentsOf(site).some(p => allowed.has(p)) ) { out.add(sitePattern(site)); }
        }
        const siteSet = new Set(sites);
        for ( const host of allowed ) {
            if ( parentsOf(host).some(p => siteSet.has(p)) ) { for ( const p of allowedPatterns(host) ) { out.add(p); } }
        }
        siteMatches = [ ...out ].sort();
    }
    return {
        sites:  { matches: siteMatches, excludeMatches: [ ...siteModeExcludes ] },
        entity: { matches: [ ...siteMode.matches ], excludeMatches: [ ...siteModeExcludes, ...sitePatterns ] },
    };
}

// Order-insensitive comparison for pattern lists, order-sensitive for js (file order matters).
function sameField(field, a, b) {
    if ( Array.isArray(a) || Array.isArray(b) ) {
        const x = a ?? [], y = b ?? [];
        if ( x.length !== y.length ) { return false; }
        if ( field === 'js' ) { return x.every((v, i) => v === y[i]); }
        const set = new Set(x);
        return y.every(v => set.has(v));
    }
    return (a ?? null) === (b ?? null);
}

// Registering a 15,000-site list costs Chrome about 0.6 s, an exclude-only update about 45 ms (measured): send only
// what changed, and nothing at all at a service-worker start where nothing did.
export function directiveUpdate(existing, wanted) {
    const changed = COMPARED_FIELDS.filter(f => (f in wanted || f in existing) && sameField(f, existing[f], wanted[f]) === false);
    if ( changed.length === 0 ) { return null; }
    const update = { id: wanted.id };
    for ( const f of changed ) { update[f] = wanted[f] ?? []; }
    return update;
}
