// ── tools/build/adult-sites.mjs ────────────────────────────────────────────────────────
// The curated adult-site list — BUILD-TIME ONLY since 10.3.0. adult-site-rules.mjs uses it to collect the top-25
// adult-site rules that ship in ruleset_annoyances (10.5.1; until 10.5.0 in the hidden ruleset_adguard_base_adult).
//
// History: until 10.3.0 this list lived in the runtime (js/core/compiled-filters.js ADULT_SITE_MATCHES and
// js/data/high-risk-sites.js HIGH_RISK_HOSTNAMES) for the Privacy & Security "high-risk (adult) websites"
// protections, and the build scraped it from compiled-filters.js. Those protections moved to 3P-Matrix, so
// the list now lives here, next to its only consumer, as plain data (no text scraping).
//
// Public interface: ADULT_SITE_DOMAINS — frozen, bare hostnames (no scheme, no wildcard), the owner's ranked
// top 25 (updated 10.4.9). History: the first 23 were the sites curated in v8.3.6 (Semrush "Most
// Visited Adult Websites", July 2026; see CHANGELOG_HISTORY.md); fullvideosporn.com was added in 10.3.0 and
// freepornvideos.xxx in 10.4.7, both by explicit request; the owner then confirmed all 25 as one ranked list.
// Pure data: nothing to initialise, clear or release.

// Number of sites the list must hold — a guard against an accidental edit (C13a). Change both together.
const ADULT_SITE_COUNT = 25;

export const ADULT_SITE_DOMAINS = Object.freeze([
    // Owner's ranked top 25 (10.4.9), in his rank order.
    'pornhub.com', 'xhamster.com', 'xvideos.com', 'xnxx.com', 'eporner.com',              //  1-5
    'redtube.com', 'tube8.com', 'xgroovy.com', 'xgroovy.tv', 'youporn.com',               //  6-10
    'spankbang.com', 'porntrex.com', 'onlyfans.com', 'theporndude.com', 'xvideos.es',     // 11-15
    'xhamsterlive.com', 'fpo.xxx', 'qorno.com', 'pornpics.com', 'f95zone.to',             // 16-20
    'xhamster19.com', 'beeg.com', 'tnaflix.com', 'fullvideosporn.com', 'freepornvideos.xxx', // 21-25
]);

// Load-time guard: the expected count, no duplicates, bare lower-case hostnames only.
if ( ADULT_SITE_DOMAINS.length !== ADULT_SITE_COUNT || new Set(ADULT_SITE_DOMAINS).size !== ADULT_SITE_COUNT ||
     ADULT_SITE_DOMAINS.some(d => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) === false) ) {
    throw new Error(`adult-sites.mjs: ADULT_SITE_DOMAINS must be ${ADULT_SITE_COUNT} unique bare hostnames`);
}
