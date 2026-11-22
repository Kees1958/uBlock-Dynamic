// ── tools/build/english-outside-top-sites.mjs ───────────────────────────────────────
// (2026-11-09, owner's decision) Source of the "English language filter for websites outside top 1 Million"
// (ruleset_english_outside_top1m). It gathers site rules the other lists leave out or should not carry:
//   1. AdGuard Base: rules for sites under an ENGLISH-SPEAKING country code (.uk, .ie, .mt, .ca, .us, .au, .nz …,
//      see ENGLISH_SPEAKING_CCTLDS) that are NOT in the CrUX top 1M are MOVED out of AdGuard Base into this list
//      (owner: move, not copy — no rule is loaded twice; AdGuard Base gets smaller).
//   2. The anti-adblock list (ruleset_adguard_antiadblock): its site rules for sites outside the top 1M under a
//      GENERIC TLD (.com, .net, .org …, plus the generic-use ccTLDs) or an English-speaking country code go here
//      instead of being dropped by that list's top-1M limit (owner's choice: generic TLDs too).
// Rules for popular sites stay where they were; site-less rules are never moved; allow rules never move and
// exceptions are copied, not moved (see split() — "keep working" first). A rule naming sites of both
// kinds is split per kind (site-split.mjs). Entity sites ("example.*", every TLD of one name) never move.
// The geographic scope still applies to this list like to every list (parseList()).
//
// Hand-off: AdGuard Base's and the anti-adblock list's customFetch leave this list's share in build-state.mjs
// (agBaseEnglishText / antiadblockEnglishText, same shared-variable shape as agBaseBelgianText); this list must
// therefore come AFTER both in FILTER_LISTS (array order), and fails — so the build keeps its previous copy — when
// either share is missing (that list failed or was kept from a previous build).
//
// Public interface:
//   ENGLISH_SPEAKING_CCTLDS          — the country codes of rule 1, one place
//   splitBaseEnglish(text)           — pure on its inputs: { keep, english } for AdGuard Base
//   splitAntiadblockEnglish(text)    — pure on its inputs: { keep, english } for the anti-adblock list
//   englishOutsideTopSitesText()     — this list's customFetch
// Dependencies: site-split.mjs, crux-top-sites.mjs (isPopularSiteKey), tld-scope.mjs (GEO_SCOPE), build-state.mjs.

import { splitRulesBySite } from './site-split.mjs';
import { isPopularSiteKey } from './crux-top-sites.mjs';
import { GEO_SCOPE } from './tld-scope.mjs';
import { topSitesSet, agBaseEnglishText, antiadblockEnglishText } from './build-state.mjs';

// ── CONFIG ────────────────────────────────────────────────────────────────────
// English-speaking countries and territories inside the geographic scope (Europe, the Americas, Australia/New
// Zealand). Generic-use ccTLDs (.io, .sh, .ac …) are NOT listed: they count as generic TLDs (GEO_SCOPE).
export const ENGLISH_SPEAKING_CCTLDS = Object.freeze([
    // Europe: United Kingdom (.uk, .gb), Ireland, Malta, Gibraltar, Isle of Man, Jersey, Guernsey
    'uk', 'gb', 'ie', 'mt', 'gi', 'im', 'je', 'gg',
    // North America: Canada, United States, Bermuda, US Virgin Islands
    'ca', 'us', 'bm', 'vi',
    // Caribbean: Jamaica, Trinidad & Tobago, Bahamas, Barbados, Belize, Antigua & Barbuda, Dominica, Grenada,
    // St Kitts & Nevis, St Lucia, St Vincent, Cayman, British Virgin Islands, Anguilla, Montserrat, Turks & Caicos
    'jm', 'tt', 'bs', 'bb', 'bz', 'ag', 'dm', 'gd', 'kn', 'lc', 'vc', 'ky', 'vg', 'ai', 'ms', 'tc',
    // South America: Guyana, Falklands
    'gy', 'fk',
    // Oceania in scope: Australia, New Zealand
    'au', 'nz',
]);

const ENGLISH_SPLIT_CONFIG = Object.freeze({
    KEY_KEEP: 'keep',
    KEY_ENGLISH: 'english',
    ENTITY_SUFFIX: '.*',
    CCTLD_LENGTH: 2,                      // a two-letter TLD is a country code …
    GENERIC_USE_CCTLDS: GEO_SCOPE.GENERIC_USE_CCTLDS,   // … unless used worldwide as a generic name
    HEADER: '!------------------ English sites outside the CrUX top 1M ------------------!',
});

const ENGLISH_CC = new Set(ENGLISH_SPEAKING_CCTLDS);
function tldOf(host) { return host.slice(host.lastIndexOf('.') + 1); }
function isGenericTld(tld) {
    return tld.length !== ENGLISH_SPLIT_CONFIG.CCTLD_LENGTH || ENGLISH_SPLIT_CONFIG.GENERIC_USE_CCTLDS.includes(tld);
}

// GUARD: both splits need the CrUX set; without it every site would look unpopular and move.
function requireTopSites() {
    if ( !(topSitesSet instanceof Set) || topSitesSet.size === 0 ) {
        throw new Error('English outside-top-1M split: the CrUX top-1M set is empty or missing');
    }
    return topSitesSet;
}

// "Keep working is always the rule" (owner's standing rule) — exceptions never leave their list:
//   - a network ALLOW rule (`@@…`) stays where it is, unchanged: DNR allow rules work across rulesets, so it keeps
//     unbreaking its sites for every user, whether the English filter is on or not;
//   - a cosmetic/scriptlet EXCEPTION (`#@#`, `#@%#`, …) is kept in full where it is AND its English-site share is
//     copied into the English filter: these exceptions only cancel rules of their own list at build time, so each
//     list needs its own copy to cancel the rules it carries.
const ALLOW_RULE_PREFIX = '@@';
const EXCEPTION_OPERATOR_RE = /#@[#%?$]/;

function split(text, wantsHost) {
    const topSites = requireTopSites();
    const C = ENGLISH_SPLIT_CONFIG;
    function keyOfHost(host) {
        if ( host.endsWith(C.ENTITY_SUFFIX) ) { return C.KEY_KEEP; }
        if ( isPopularSiteKey(host, topSites) ) { return C.KEY_KEEP; }
        return wantsHost(tldOf(host)) ? C.KEY_ENGLISH : C.KEY_KEEP;
    }
    const movable = [];
    const exceptions = [];
    const keep = [];
    for ( const line of text.split('\n') ) {
        const t = line.trim();
        if ( t.startsWith(ALLOW_RULE_PREFIX) ) { keep.push(line); continue; }
        if ( EXCEPTION_OPERATOR_RE.test(t) ) { keep.push(line); exceptions.push(line); continue; }
        movable.push(line);
    }
    const moved = splitRulesBySite(movable.join('\n'), keyOfHost, { siteLessKey: C.KEY_KEEP });
    const copied = splitRulesBySite(exceptions.join('\n'), keyOfHost, { siteLessKey: C.KEY_KEEP });
    const english = [ ...(moved.byKey.get(C.KEY_ENGLISH) ?? []), ...(copied.byKey.get(C.KEY_ENGLISH) ?? []) ];
    process.stdout.write(`(English outside top 1M: ${(moved.byKey.get(C.KEY_ENGLISH) ?? []).length} rule(s) moved, `
        + `${(copied.byKey.get(C.KEY_ENGLISH) ?? []).length} exception(s) copied, ${moved.splitRules} split) `);
    return { keep: [ ...keep, ...(moved.byKey.get(C.KEY_KEEP) ?? []) ].join('\n'), english };
}

// Rule 1: AdGuard Base — English-speaking country codes only.
export function splitBaseEnglish(text) {
    return split(text, tld => ENGLISH_CC.has(tld));
}

// Rule 2: the anti-adblock list — generic TLDs and English-speaking country codes.
export function splitAntiadblockEnglish(text) {
    return split(text, tld => isGenericTld(tld) || ENGLISH_CC.has(tld));
}

export async function englishOutsideTopSitesText() {
    if ( agBaseEnglishText === null || antiadblockEnglishText === null ) {
        throw new Error('English outside-top-1M: AdGuard Base or the anti-adblock list did not hand over its share this build');
    }
    return [
        ENGLISH_SPLIT_CONFIG.HEADER,
        '! from AdGuard Base (English-speaking country codes)', ...agBaseEnglishText,
        '! from AdGuard and EasyList anti-adblock (generic TLDs and English-speaking country codes)', ...antiadblockEnglishText,
    ].join('\n');
}
