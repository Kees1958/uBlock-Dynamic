// ── tools/build/antiadblock-country-split.mjs ───────────────────────────────────────
// (2026-11-09, owner's decision) Routes AdGuard Base's anti-adblock section by COUNTRY, the same way EasyList's
// per-language anti-adblock files already go into the matching language filters (filter-lists.mjs):
//   - a rule for a site under a country TLD that has a language filter (.de -> German, .nl -> Dutch, …) goes INTO
//     that language filter's own text — so it works whenever that language filter is on, whatever the state of
//     AdGuard Base or the anti-adblock list, and it keeps the language filters' exemption from the CrUX top-1M limit;
//   - everything else (generic-TLD sites, countries without a language filter, site-less rules) goes to the
//     separate anti-adblock list (ruleset_adguard_antiadblock), which applies the top-1M limit.
//
// Which TLD belongs to which language filter is NOT a new table: it is read from AdGuard Base's own countryOverflow
// buckets (filter-lists.mjs) and the bucket -> visible filter companion map (js/data/ruleset-companions.js), so the
// two routings can never disagree. A rule naming sites of several countries is split per country (one copy per
// target, each with only its own sites); exclusions (~site) are copied into every copy, like extractCountryOverflow().
//
// Public interface:
//   antiadblockGeneralText()          — async: the anti-adblock list's share (fetched once per build)
//   antiadblockCountryTextFor(listId) — async: the share of one language filter ('' when it has none)
//   splitAntiadblockByCountry(text, tldToListId) — pure: { generalLines, byList: Map<listId, string[]>, counts }
//   resetAntiadblockSplitCache()      — release the cached download (called at the start of every build)
// Dependencies: fetch-helpers.mjs (fetchList: guards + trust gate), filter-lists.mjs (lazy import — it imports this
// module), js/data/ruleset-companions.js.

import { fetchList } from './fetch-helpers.mjs';
import { splitRulesBySite } from './site-split.mjs';
import { RULESET_COMPANIONS } from '../../js/data/ruleset-companions.js';

// ── CONFIG ────────────────────────────────────────────────────────────────────
export const ANTIADBLOCK_SPLIT_CONFIG = Object.freeze({
    SOURCE_URL: 'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/BaseFilter/sections/antiadblock.txt',
    BASE_LIST_ID: 'ruleset_adguard_base',
    OVERFLOW_ID_PREFIX: 'ruleset_agbase_overflow_',
    ENTITY_SUFFIX: '.*',
    GENERAL_KEY: '',   // internal key for the anti-adblock list's share
});

// ── Pure split ───────────────────────────────────────────────────────────────
// The line routing itself is the shared splitRulesBySite() (site-split.mjs); only the per-host decision is here.
function tldOf(host) { return host.slice(host.lastIndexOf('.') + 1).toLowerCase(); }

export function splitAntiadblockByCountry(text, tldToListId) {
    const C = ANTIADBLOCK_SPLIT_CONFIG;
    function keyOfHost(host) {
        return host.endsWith(C.ENTITY_SUFFIX) ? C.GENERAL_KEY : (tldToListId.get(tldOf(host)) ?? C.GENERAL_KEY);
    }
    const { byKey, splitRules } = splitRulesBySite(text, keyOfHost, { siteLessKey: C.GENERAL_KEY });
    const generalLines = byKey.get(C.GENERAL_KEY) ?? [];
    byKey.delete(C.GENERAL_KEY);
    function isRule(l) { const t = l.trim(); return t !== '' && !t.startsWith('!') && !t.startsWith('['); }
    const counts = {
        general: generalLines.filter(isRule).length,
        country: [ ...byKey.values() ].reduce((n, lines) => n + lines.length, 0),
        splitRules,
    };
    return { generalLines, byList: byKey, counts };
}

// ── Build-time cache (one download per build) ────────────────────────────────
let splitPromise = null;   // INIT: created by the first caller of a build; RELEASE: resetAntiadblockSplitCache()

export function resetAntiadblockSplitCache() { splitPromise = null; }

async function tldToLanguageListMap() {
    const { FILTER_LISTS } = await import('./filter-lists.mjs');   // lazy: filter-lists.mjs imports this module
    const base = FILTER_LISTS.find(l => l.id === ANTIADBLOCK_SPLIT_CONFIG.BASE_LIST_ID);
    if ( base === undefined || !Array.isArray(base.countryOverflow) ) {
        throw new Error('antiadblock split: AdGuard Base countryOverflow config not found');
    }
    // overflow bucket id -> the visible language filter it belongs to (ruleset-companions.js)
    const bucketToList = new Map();
    for ( const [ listId, companions ] of Object.entries(RULESET_COMPANIONS) ) {
        if ( listId.startsWith(ANTIADBLOCK_SPLIT_CONFIG.OVERFLOW_ID_PREFIX) ) { continue; }
        for ( const id of companions ) {
            if ( id.startsWith(ANTIADBLOCK_SPLIT_CONFIG.OVERFLOW_ID_PREFIX) ) { bucketToList.set(id, listId); }
        }
    }
    const tldToListId = new Map();
    for ( const bucket of base.countryOverflow ) {
        const listId = bucketToList.get(bucket.id);
        if ( listId === undefined ) { continue; }   // e.g. the "other" bucket: no language filter -> general
        for ( const tld of bucket.tlds ) { tldToListId.set(tld, listId); }
    }
    return tldToListId;
}

function getSplit() {
    if ( splitPromise === null ) {
        splitPromise = (async ( ) => {
            const [ text, tldToListId ] = await Promise.all([ fetchList(ANTIADBLOCK_SPLIT_CONFIG.SOURCE_URL), tldToLanguageListMap() ]);
            const split = splitAntiadblockByCountry(text, tldToListId);
            process.stdout.write(`(AdGuard Base anti-adblock: ${split.counts.general} to the anti-adblock list, `
                + `${split.counts.country} to ${split.byList.size} language filters, ${split.counts.splitRules} rules split by country) `);
            return split;
        })();
        // A failed download must not stay cached for the next caller of the same build: each caller then fails on
        // its own and the build's own carry-over/abort handling decides, exactly as for any failed list.
        splitPromise.catch(( ) => { splitPromise = null; });
    }
    return splitPromise;
}

export async function antiadblockGeneralText() {
    const { generalLines } = await getSplit();
    return [ '!------------------ AdGuard Base anti-adblock (sites without a language filter) ------------------!', ...generalLines ].join('\n');
}

export async function antiadblockCountryTextFor(listId) {
    const { byList } = await getSplit();
    const lines = byList.get(listId);
    if ( lines === undefined || lines.length === 0 ) { return ''; }
    return [ '!------------------ AdGuard Base anti-adblock (this language\'s country sites) ------------------!', ...lines ].join('\n');
}
