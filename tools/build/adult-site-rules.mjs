// ── tools/build/adult-site-rules.mjs ──────────────────────────────────────────────────────
// Top-25 adult-site rules — appended to ruleset_annoyances since 10.5.1 (owner's decision).
//
// Until 10.5.0 these rules shipped in their own hidden, always-on ruleset (ruleset_adguard_base_adult,
// with an always-empty _unsafe companion), assembled inside ruleset_adguard_base's customFetch and handed
// over through build-state.mjs. That ruleset is REMOVED; every rule it carried now ships in the always-on
// annoyances list.
//
// 10.6.1: HaGeZi Multi light's own first-party tracking hosts on these sites (e.g. "ads.pornhub.com") are NOW
// copied in too (source 5 below) — reverses the earlier "NOT copied in, HaGeZi light already blocks them while
// it is enabled, keeps this simple" decision. Owner's reasoning: those hosts should protect even when
// ruleset_hagezi_light itself is off, same as every other source in this file.
//
// Public interface:
//   buildTop25AdultSiteRulesText() — fetch every source, return ABP text (annoyances' customFetch appends it)
//   topAdultSiteDomains()          — the 25 sites, sorted (single source: adult-sites.mjs)
//
// Sources (each through fetchList()'s own guard — one failing aborts the build, never ships without it):
//   1. AdGuard Base general_url.txt — blocks whose header names one of the 25 sites, $domain=-scoped
//      (extractAdultSiteRules(); ruleset_adguard_base still calls it too, to drop those blocks from its own
//      copy, so nothing ships twice — same pure function, same input, two consumers).
//   2. Own rules — _xa/ads, _xa/ads_batch, and third-party websockets (10.4.9), on all 25 sites.
//   3. uBlockOrigin/uAssets general lists — only rules naming one of the 25 sites, and only for sites
//      AdGuard (1) does not already cover (extractDomainScopedAdultRules()'s skipDomains).
//   4. EasyList adult — top-25 rules the annoyances shape gate would otherwise drop.
//   5. HaGeZi Multi light — entries whose domain (or a parent of it) is one of the 25 sites
//      (hageziAdultSiteEntries(), reusing hagezi-light-selection.mjs's own keepHageziEntry() — C21, one
//      definition of "is this an adult-site host," not a second one). No overlap check against sources 1-4:
//      HaGeZi's plain `||domain^` shape never textually matches their `$domain=`-scoped shape, so a harmless
//      rule-count duplicate (both blocking the same host two different ways) is possible but not a correctness
//      issue — same tolerance this file already has for AGBASE_GENERAL_URL_SOURCE being fetched twice (here
//      and by ruleset_adguard_base) rather than cached.
//
// Dependencies: fetch-helpers.mjs, adult-sites.mjs, tld-scope.mjs, worry-free-extra-lists.mjs,
//   hagezi-light-selection.mjs.
// State owned by this module: none — pure assembly; nothing is kept between calls.

import { fetchList } from './fetch-helpers.mjs';
import { ADULT_SITE_DOMAINS } from './adult-sites.mjs';
import { extractAdultSiteRules, extractDomainScopedAdultRules } from './tld-scope.mjs';
import { EASYLIST_ADULT_SPECIFIC_SOURCE, HAGEZI_LIGHT_SOURCE, buildWorryFreeLists } from './worry-free-extra-lists.mjs';
import { hageziAdultSiteEntries } from './hagezi-light-selection.mjs';

/******************************************************************************/
// Settings — the ONLY place these values live.
/******************************************************************************/

// AdGuard Base general_url.txt (also fetched by ruleset_adguard_base — see source 1 above).
export const AGBASE_GENERAL_URL_SOURCE = 'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/BaseFilter/sections/general_url.txt';

// URL pattern for a websocket rule with no address of its own: matches every ws:// and wss:// URL (10.4.9).
const WEBSOCKET_URL_PATTERN = '|ws';

// uBlockOrigin/uAssets general-purpose lists, domain-matched only (10.3.0). Never a selectable filter;
// everything not naming one of the 25 sites is discarded. GPL-3.0 — see THIRD_PARTY_LICENSES.md.
const ADULT_DOMAIN_MATCH_SOURCES = Object.freeze([
    'https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/filters.txt',
    'https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/ubol-filters.txt',
    'https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/filters-2026.txt',
]);

// Section banners in the returned text (comments — a human reading the source can tell where a rule came from).
const BANNER = Object.freeze({
    AGBASE:  '!------------------ Top-25 adult sites: AdGuard Base general_url.txt ------------------!',
    OWN:     '!------------------ Top-25 adult sites: own rules (_xa/ads, third-party websockets) ------------------!',
    UASSETS: '!------------------ Top-25 adult sites: uBlockOrigin/uAssets (sites AdGuard does not cover) ------------------!',
    EASYLIST:'!------------------ Top-25 adult sites: EasyList adult (rules the annoyances gate drops) ------------------!',
    HAGEZI:  '!------------------ Top-25 adult sites: HaGeZi Multi light hosts (always-on, independent of ruleset_hagezi_light) ------------------!',
});

/******************************************************************************/

export function topAdultSiteDomains() {
    return [ ...ADULT_SITE_DOMAINS ].sort();
}

export async function buildTop25AdultSiteRulesText() {
    const sites = topAdultSiteDomains();
    const domainOpt = sites.join('|');
    const parts = [];

    // 1. AdGuard Base general_url.txt
    const { adultRuleLines, coveredDomains } = extractAdultSiteRules(await fetchList(AGBASE_GENERAL_URL_SOURCE), sites);
    parts.push(BANNER.AGBASE, ...adultRuleLines);

    // 2. Own rules. Websockets THIRD-PARTY ONLY so the sites' own live cams / chat keep working.
    parts.push(BANNER.OWN,
        `*/_xa/ads$domain=${domainOpt}`,
        `*/_xa/ads_batch?ads=$xmlhttprequest,script,domain=${domainOpt}`,
        `${WEBSOCKET_URL_PATTERN}$websocket,third-party,domain=${domainOpt}`,
    );

    // 3. uAssets — AdGuard's own coverage always wins (skipDomains = coveredDomains).
    parts.push(BANNER.UASSETS);
    for ( const url of ADULT_DOMAIN_MATCH_SOURCES ) {
        parts.push(...extractDomainScopedAdultRules(await fetchList(url), sites, coveredDomains));
    }

    // 4. EasyList adult — the whole list already ships in annoyances (annoyances-sources.mjs); only rules its
    //    shape gate drops are added, narrowed to the 25 sites. A pattern-less `$websocket,…` rule cannot compile
    //    (empty pattern), so it gets the same `|ws` pattern as our own websocket rule (same meaning: any websocket).
    const elShipped = new Set((await buildWorryFreeLists(EASYLIST_ADULT_SPECIFIC_SOURCE)).split('\n'));
    const elExtra = extractDomainScopedAdultRules(await fetchList(EASYLIST_ADULT_SPECIFIC_SOURCE.url), sites)
        .filter(line => elShipped.has(line) === false)
        .map(line => line.startsWith('$websocket') ? `${WEBSOCKET_URL_PATTERN}${line}` : line);
    parts.push(BANNER.EASYLIST, ...elExtra);

    // 5. HaGeZi Multi light — always-on copy, independent of ruleset_hagezi_light's own enabled state.
    const hageziLines = (await buildWorryFreeLists(HAGEZI_LIGHT_SOURCE)).split('\n').filter(Boolean);
    const hageziExtra = hageziAdultSiteEntries(hageziLines);
    parts.push(BANNER.HAGEZI, ...hageziExtra);

    process.stdout.write(`(top-25 adult: ${adultRuleLines.length} AdGuard, ${elExtra.length} EasyList, ${hageziExtra.length} HaGeZi) `);
    return parts.join('\n');
}
