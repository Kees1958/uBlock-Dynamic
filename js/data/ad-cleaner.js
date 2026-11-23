// ── ad-cleaner.js ────────────────────────────────────────────────────────────
// (11.0.0, owner's design 2026-11-19) "Ad leftover cleaner" — the ONE place for its file names, limits, the selector
// hash and the exception lookup, shared by the build (tools/build/ad-cleaner-sources.mjs), the service worker
// (js/workflow/ad-cleaner-routes.js) and the tests. On demand only: nothing runs until the person starts it from the
// popup or the right-click menu, and then only in that tab's top frame.
//   Data: generic element hiding from EasyList (easylist_general_hide.txt) and AdGuard Base (general_elemhide.txt,
//   banner_sizes.txt), minus both lists' exceptions (easylist_allowlist_general_hide.txt, AdGuard's allowlist.txt),
//   built into AD_CLEANER_DATA_FILE (tools/build/ad-cleaner-sources.mjs):
//     { version, hashes: { "<hash>": [ selector, ... ] },   — selectors that start with an id or class, by that token
//       unkeyed: [ selector, ... ],                         — the rest (attribute / tag selectors), tested directly
//       exceptions: { "<hostname>": [ selector, ... ] },    — per-site exceptions (only listed selectors)
//       exemptSites: [ hostname, ... ],                     — sites where generic hiding is known to break them:
//                                                             the cleaner does not run there (and their subdomains)
//       counts: { ... } }                                   — build report
//   Page script: js/scripting/ad-cleaner.js (the former uBOL css-generic.js, repurposed) — keeps its own copy of
//   adCleanerHash() (a content script cannot import), proven equal by tools/test-ad-cleaner.mjs.
//
// Public interface:
//   AD_CLEANER_DATA_FILE, AD_CLEANER_DATA_VERSION, AD_CLEANER_SCRIPT_FILES, AD_CLEANER_DATA_GLOBAL, AD_CLEANER_KEEP_MAX,
//   AD_CLEANER_HASH_TYPES
//   adCleanerHash(type, token)          — 16-bit hash of an id/class token (type = AD_CLEANER_HASH_TYPES.*)
//   adCleanerKeyOf(selector)            — { type, token } of a selector's leading id/class, or null (unkeyed)
//   adCleanerExceptionsFor(host, map)   — the exception selectors for a hostname and its parent domains
//   isAdCleanerSiteExempt(host, list)   — the hostname or a parent domain is on the whole-site exception list
//   isAdCleanerData(data)               — shape check of a parsed data file
//
// Pure data + pure functions: nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────

// The built data file (extension-relative; written by the build, read by the service worker on each launch/keep).
export const AD_CLEANER_DATA_FILE = 'rulesets/ad-cleaner.json';
// Bumped when the data file's shape changes; the service worker refuses another version.
// 2 (11.0.0, owner 2026-11-19): exemptSites added with AdGuard's lists and exceptions.
export const AD_CLEANER_DATA_VERSION = 2;
// Injected, in this order, into the tab's top frame (ISOLATED world) after the data global is set.
export const AD_CLEANER_SCRIPT_FILES = Object.freeze([ '/js/scripting/css-api.js', '/js/scripting/ad-cleaner.js' ]);
// Page global the launch sets and the page script reads and deletes at once (isolated world: the page cannot see it).
export const AD_CLEANER_DATA_GLOBAL = '__usd_ad_cleaner_data_7c41e2';
// Most selectors one "Remove them" may save (a busy page matches tens; the cap stops a runaway message).
export const AD_CLEANER_KEEP_MAX = 500;
// Hash "type" seeds: '#' for ids, '.' for classes (the same seeds uBOL's generic cosmetic filter used).
export const AD_CLEANER_HASH_TYPES = Object.freeze({ ID: 0x23, CLASS: 0x2E });

// djb2 variant over at most 8 sampled characters, 16 bits — from uBOL css-generic.js (hashFromStr). A collision only
// makes a selector a candidate; the page script then checks it really matches, so collisions cost time, never hide
// anything wrong. MIRRORED in js/scripting/ad-cleaner.js.
export function adCleanerHash(type, s) {
    const len = s.length;
    const step = len + 7 >>> 3;
    let hash = (type << 5) + type ^ len;
    for ( let i = 0; i < len; i += step ) {
        hash = (hash << 5) + hash ^ s.charCodeAt(i);
    }
    return hash & 0xFFFF;
}

// A selector that starts with `#token` or `.token` can only match when an element with that id/class exists, so it is
// indexed by that token. A token with a CSS escape is left unkeyed (its page spelling differs from the selector text).
const LEADING_TOKEN_RE = /^([#.])([\w-]+)(?![\w\\-])/;
export function adCleanerKeyOf(selector) {
    const m = LEADING_TOKEN_RE.exec(selector);
    if ( m === null ) { return null; }
    return { type: m[1] === '#' ? AD_CLEANER_HASH_TYPES.ID : AD_CLEANER_HASH_TYPES.CLASS, token: m[2] };
}

// EasyList exceptions name a site and apply to its subdomains too (example.com covers www.example.com).
export function adCleanerExceptionsFor(hostname, exceptions) {
    const out = [];
    if ( typeof hostname !== 'string' || exceptions === null || typeof exceptions !== 'object' ) { return out; }
    let h = hostname.toLowerCase();
    for (;;) {
        const list = Object.hasOwn(exceptions, h) ? exceptions[h] : undefined;
        if ( Array.isArray(list) ) { out.push(...list); }
        const dot = h.indexOf('.');
        if ( dot === -1 ) { break; }
        h = h.slice(dot + 1);
    }
    return out;
}

export function isAdCleanerSiteExempt(hostname, exemptSites) {
    if ( typeof hostname !== 'string' || Array.isArray(exemptSites) === false ) { return false; }
    let h = hostname.toLowerCase();
    for (;;) {
        if ( exemptSites.includes(h) ) { return true; }
        const dot = h.indexOf('.');
        if ( dot === -1 ) { return false; }
        h = h.slice(dot + 1);
    }
}

export function isAdCleanerData(data) {
    return data !== null && typeof data === 'object'
        && data.version === AD_CLEANER_DATA_VERSION
        && data.hashes !== null && typeof data.hashes === 'object'
        && Array.isArray(data.unkeyed)
        && data.exceptions !== null && typeof data.exceptions === 'object'
        && Array.isArray(data.exemptSites);
}
