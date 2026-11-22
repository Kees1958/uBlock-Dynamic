// ── tools/build/crux-top-sites.mjs ────────────────────────────────────────────────────
// CrUX top-1M snapshot: fetch and popularity lookups.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: fetchTopSitesSet, filterCosmeticMapByPopularity, filterScriptletRulesByPopularity,
//   filterDnrRulesByPopularity, isPopularHostname, isPopularSiteKey, isTopRankedHostname, topSiteRanksOf,
//   topSiteDomainsByName
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import { withRetry, fetchWithTimeout } from '../lib/fetch-with-retry.mjs';
import zlib from 'zlib';

/******************************************************************************/
// CrUX top-1M snapshot — TWO consumers now, added at different times:
//
//   fetchTopSitesSet()              — downloads + parses the snapshot once
//                                     per build (module-scope topSitesSet)
//   isPopularHostname()             — membership test, walks up to eTLD+1
//   filterCosmeticMapByPopularity() — drops non-matching cosmetic hostnames
//   filterScriptletRulesByPopularity() / filterDnrRulesByPopularity()
//                                   — (2026-11-09) the same limit for scriptlet
//                                     sites and DNR initiatorDomains; all three
//                                     run for a list with popularityFilter: true
//                                     (anti-adblock and Anti-Admiral, owner's
//                                     decision — see build-steps.mjs)
//   resolveWildcardDomainTokens()   — expands $domain=example.* to every
//                                     in-scope "example" domain in the
//                                     snapshot (topSiteDomainsByName(),
//                                     10.7.8; see BUGREPORT-domain-wildcard-
//                                     invalid-dnr-rules.md) — this is why the fetch is
//                                     now unconditional rather than gated
//                                     on popularityFilter (see build()'s own
//                                     comment on the fetch site)
//
// Source: zakird/crux-top-lists, a cached CSV snapshot of Google's public
// Chrome UX Report BigQuery data (real Chrome traffic, not a link-graph
// proxy like Alexa/Tranco). File is gzip-compressed, ~985K unique origins,
// columns "origin,rank" where rank is a bucket (1000/5000/.../1000000) —
// membership in the file at all is exactly "is this a top-1M site", which
// is all either consumer needs; the bucket granularity itself is unused.
/******************************************************************************/

const CRUX_TOP_SITES_URL = 'https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/global/current.csv.gz';

// Strips scheme + leading "www." — matches how AG Base's own cosmetic
// hostnames are written (bare registrable/full hostname, no scheme).
function normalizeTopSiteHost(origin) {
    let host = origin.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
    if ( host.startsWith('www.') ) { host = host.slice(4); }
    return host;
}

// Wrapped in withRetry() — timeout + one retry (tools/lib/fetch-with-retry.mjs).
// A final failure here still stops the build: every list's wildcard
// expansion depends on this set, and it is fetched before anything is
// written, so stopping leaves rulesets/ exactly as the last build left it.
export async function fetchTopSitesSet() {
    process.stdout.write(`Fetching CrUX top-1M site list… `);
    return withRetry('CrUX top-1M site list', signal => fetchTopSitesSetOnce(signal));
}

async function fetchTopSitesSetOnce(signal) {
    const resp = await fetchWithTimeout(CRUX_TOP_SITES_URL, signal);
    const gz = Buffer.from(await resp.arrayBuffer());
    const csv = zlib.gunzipSync(gz).toString('utf8');
    const topSites = new Set();
    const ranks = new Map();   // (10.5.5) host -> best CrUX rank bucket, for topSiteRanksOf()
    // First line is the "origin,rank" header — skipped by the leading-digit
    // guard below (rank is always numeric, "rank" the header-word is not).
    for ( const line of csv.split('\n') ) {
        const idx = line.lastIndexOf(',');
        if ( idx === -1 ) { continue; }
        const rank = line.slice(idx + 1).trim();
        if ( !/^\d+$/.test(rank) ) { continue; }
        const host = normalizeTopSiteHost(line.slice(0, idx));
        topSites.add(host);
        const bucket = Number(rank);
        if ( (ranks.get(host) ?? Infinity) > bucket ) { ranks.set(host, bucket); }
    }
    TOP_SITE_RANKS.set(topSites, ranks);
    console.log(`${topSites.size} unique hosts`);
    return topSites;
}

// (10.5.5) Rank buckets of the snapshot, kept beside the set fetchTopSitesSet() returns — same single download.
// A WeakMap keyed by that set: when the build releases the set (setTopSitesSet(null)), the ranks go with it.
const TOP_SITE_RANKS = new WeakMap();

// The rank map recorded for a set returned by fetchTopSitesSet() (null for any other set).
export function topSiteRanksOf(topSites) {
    return TOP_SITE_RANKS.get(topSites) ?? null;
}

// True when the hostname, or a parent of it down to two labels (the same walk as isPopularHostname()),
// has a CrUX rank bucket at or below maxRank.
export function isTopRankedHostname(hostname, ranks, maxRank) {
    const parts = hostname.split('.');
    for ( ;; ) {
        if ( (ranks.get(parts.join('.')) ?? Infinity) <= maxRank ) { return true; }
        if ( parts.length <= 2 ) { return false; }
        parts.shift();
    }
}

// A cosmetic-map hostname counts as "popular" if it, or any of its parent
// domains up to the eTLD+1 level, appears in the CrUX set — matches how a
// browser would actually resolve "is this site popular" for a rule written
// against a subdomain (e.g. "shop.example.com" should count if "example.com"
// is a top site, since CrUX only tracks origins that actually saw traffic
// and a lightly-trafficked subdomain of a major site is still that site).
// GUARD: stops at 2 labels (bare eTLD+1) rather than walking indefinitely —
// this is an approximation (doesn't know real public-suffix boundaries like
// "co.uk"), acceptable here since a false-positive "kept" costs nothing
// (worst case: one extra hostname stays in core) while the alternative
// (a proper PSL walk) would add a real dependency for a marginal accuracy
// gain on a best-effort size optimization.
export function isPopularHostname(hostname, topSites) {
    if ( topSites.has(hostname) ) { return true; }
    const parts = hostname.split('.');
    while ( parts.length > 2 ) {
        parts.shift();
        if ( topSites.has(parts.join('.')) ) { return true; }
    }
    return false;
}

// Entity hostnames ("example.*" — every TLD of one name) cannot be looked up directly; such a key counts as popular
// when ANY top site is that name plus one TLD label. The name set is derived once per topSites Set (WeakMap: released
// with the Set itself, nothing to clear by hand).
const ENTITY_SUFFIX = '.*';
const entityNamesCache = new WeakMap();
function topSiteEntityNames(topSites) {
    let names = entityNamesCache.get(topSites);
    if ( names === undefined ) {
        names = new Set();
        for ( const host of topSites ) {
            const dot = host.lastIndexOf('.');
            if ( dot > 0 ) { names.add(host.slice(0, dot)); }
        }
        entityNamesCache.set(topSites, names);
    }
    return names;
}
// (10.7.8) "example.*" expansion, option C (owner): every domain in the top-1M snapshot whose name is "example" —
// "example.<tld>", plus "example.<sld>.<tld>" for the common second-level suffixes below (co.uk, com.br …). A
// top site that is only a subdomain ("shop.example.de") also counts for its parent ("example.de"), the same
// walk-up isPopularHostname() does. Replaces the 33-TLD candidate list: no TLD is guessed, and TLDs a fixed list
// would miss (.pl, .hu, .cam …) are found. Index built once per topSites Set (WeakMap: released with the Set).
const WILDCARD_SECOND_LEVEL_LABELS = new Set([ 'co', 'com', 'org', 'net', 'ac', 'gov', 'edu' ]);  // "name.co.uk"-style suffixes
const domainsByNameCache = new WeakMap();
function addDomainUnderName(index, domain) {
    const labels = domain.split('.');
    if ( labels.length < 2 ) { return; }
    function put(name, d) {
        if ( name === '' ) { return; }
        let set = index.get(name);
        if ( set === undefined ) { set = new Set(); index.set(name, set); }
        set.add(d);
    }
    put(labels.slice(0, -1).join('.'), domain);
    if ( labels.length >= 3 && WILDCARD_SECOND_LEVEL_LABELS.has(labels[labels.length - 2]) ) {
        put(labels.slice(0, -2).join('.'), domain);
    }
}
export function topSiteDomainsByName(topSites) {
    let index = domainsByNameCache.get(topSites);
    if ( index !== undefined ) { return index; }
    index = new Map();
    for ( const host of topSites ) {
        const labels = host.split('.');
        for ( let i = 0; i <= labels.length - 2; i++ ) { addDomainUnderName(index, labels.slice(i).join('.')); }
    }
    domainsByNameCache.set(topSites, index);
    return index;
}

// Exported (2026-11-09) for english-outside-top-sites.mjs: the same popularity test, entities included.
export function isPopularSiteKey(key, topSites) {
    if ( key.endsWith(ENTITY_SUFFIX) ) { return topSiteEntityNames(topSites).has(key.slice(0, -ENTITY_SUFFIX.length)); }
    return isPopularHostname(key, topSites);
}

// Scriptlet rules ({ hostnames, name, args }): keeps only the popular hostnames of each rule; a rule left with none is
// dropped. Pure — returns new objects, never mutates the input.
export function filterScriptletRulesByPopularity(rules, topSites) {
    const kept = [];
    for ( const rule of rules ) {
        const hostnames = rule.hostnames.filter(h => isPopularSiteKey(h, topSites));
        if ( hostnames.length !== 0 ) { kept.push({ ...rule, hostnames }); }
    }
    return kept;
}

// DNR rules: only SITE-scoped rules are limited — their condition.initiatorDomains keep the popular sites; a rule left
// with none is dropped. A rule without initiatorDomains is not about a site (e.g. an Admiral server or an
// anti-adblock script blocked everywhere) and is kept: the CrUX list ranks websites people visit, not the servers
// they load from. Pure — returns new objects, never mutates the input.
export function filterDnrRulesByPopularity(rules, topSites) {
    const kept = [];
    for ( const rule of rules ) {
        const initiators = rule.condition?.initiatorDomains;
        if ( !Array.isArray(initiators) || initiators.length === 0 ) { kept.push(rule); continue; }
        const popular = initiators.filter(h => isPopularHostname(h, topSites));
        if ( popular.length !== 0 ) { kept.push({ ...rule, condition: { ...rule.condition, initiatorDomains: popular } }); }
    }
    return kept;
}

export function filterCosmeticMapByPopularity(cosmeticMap, topSites) {
    const kept = new Map();
    for ( const [ hostname, selectors ] of cosmeticMap ) {
        if ( isPopularHostname(hostname, topSites) ) {
            kept.set(hostname, selectors);
        }
    }
    return kept;
}
