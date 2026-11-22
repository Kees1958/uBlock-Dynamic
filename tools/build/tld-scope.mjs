// ── tools/build/tld-scope.mjs ─────────────────────────────────────────────────────────
// TLD scoping: geographic scope (one gate for every list), wildcard-domain expansion, Foreign-rules filter, adult-site domain list.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: GENERIC_DOMAIN_QUALIFIER_RE, GEO_SCOPE, OUT_OF_SCOPE_CCTLDS, PORTUGUESE_SPEAKING_TLDS, extractAdultSiteRules, extractDomainScopedAdultRules, extractSpanishGenericAndLusophone, extractForeignRulesSections, filterGenericDomainQualifier, isTLDKept
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import { domainToASCII, domainToUnicode } from 'node:url';
import { CONTINENTS, COUNTRY_DATA, TERRITORY_DATA } from './country-language-data.mjs';

/******************************************************************************/
// GEOGRAPHIC SCOPE (10.4.5, owner's decision — re-installs a jurisdiction limit that 10.0.7 removed).
// In scope:
//   - Europe: the EU, the extended zone (EFTA, UK, the micro-states) and the other European countries
//     (Albania, North Macedonia, the former Yugoslav countries), EXCEPT Moldova, Belarus, Ukraine and Russia.
//     (Turkey, Georgia, Armenia and Azerbaijan are Asia in COUNTRY_DATA, so they are out without a line here.)
//   - The Americas: North, Central (incl. the Caribbean) and South America.
//   - Asia/Oceania: only Australia and New Zealand (South Korea and Japan removed again in 10.4.6, owner's decision).
// Model: a BLACKLIST of country-code TLDs, derived from COUNTRY_DATA/TERRITORY_DATA (never hand-typed).
// Generic TLDs (com, net, org, xyz …) are kept. A ccTLD the data does not know is kept too, EXCEPT the codes in
// EXCLUDED_UNLISTED_CCTLDS (.su) and OVERSEAS_TERRITORIES_OUT_OF_SCOPE. The known ones are listed explicitly (10.4.9, owner's decision) in
// GENERIC_USE_CCTLDS (io, cc, sh, ac, nu) or UNLISTED_TERRITORIES_IN_SCOPE (territories of in-scope countries),
// so it is visible WHY each is kept.
// One gate, every list, every rule kind (owner's decision 2026-10-21):
//   - cosmetic and scriptlet rules: a hostname outside the scope is removed (isTLDKept, parsers);
//   - network rules: dropped when their target host (||host^) is outside the scope — ad servers too — and
//     their site list ($domain=/initiatorDomains) loses every out-of-scope site; a rule left with no site is
//     dropped (list-parser.mjs's applyGeoScopeToNetworkRule()).
/******************************************************************************/
export const GEO_SCOPE = Object.freeze({
    // Continents kept whole (except EXCLUDED_IN_KEPT_CONTINENTS).
    KEPT_CONTINENTS: Object.freeze([ CONTINENTS.EUROPE, CONTINENTS.NORTH_AMERICA, CONTINENTS.SOUTH_AMERICA ]),
    // Countries of a kept continent that are out of scope: Moldova, Belarus, Ukraine, Russia.
    EXCLUDED_IN_KEPT_CONTINENTS: Object.freeze([ 'md', 'by', 'ua', 'ru' ]),
    // Country codes our country data does not know (so they would be kept as generic) that are out of scope
    // anyway (owner's decision, 10.4.9): .su — the old Soviet Union code, still in use, mostly by
    // Russian sites — is treated like .ru.
    EXCLUDED_UNLISTED_CCTLDS: Object.freeze([ 'su' ]),
    // Countries outside the kept continents that are in scope: Australia, New Zealand. (10.4.6: South Korea and Japan
    // removed with their filters — owner's decision.)
    KEPT_COUNTRIES: Object.freeze([ 'au', 'nz' ]),
    // ccTLDs used worldwide as generic names (streaming, short links, analytics, tech …), kept as generic
    // (owner's decision). Countries out of scope: Tuvalu, Tonga, Samoa, Micronesia, Palau, São Tomé, Laos, Somalia,
    // Libya (.ly: parse.ly / count.ly analytics, adf.ly). Codes our country data does not know (10.4.9):
    // British Indian Ocean Territory (.io), Cocos Islands (.cc), St Helena (.sh), Ascension (.ac), Niue (.nu).
    GENERIC_USE_CCTLDS: Object.freeze([ 'tv', 'to', 'ws', 'fm', 'pw', 'st', 'la', 'so', 'ly', 'io', 'cc', 'sh', 'ac', 'nu' ]),
    // Codes our country data does not know that belong to an in-scope country, the EU or an in-scope continent
    // (10.4.9, owner's decision). Kept. Europe: .eu, Åland, Guernsey, Jersey, Gibraltar. Americas
    // (incl. Caribbean): Anguilla, Bermuda, Cayman, Montserrat, Turks & Caicos, British/US Virgin Islands,
    // Guadeloupe, Martinique, French Guiana, St Pierre & Miquelon, Sint Maarten and Bonaire/St Eustatius/Saba (former
    // Dutch Caribbean; Aruba .aw and Curaçao .cw are in the country data, North America), Falklands, South Georgia.
    // Australia / New Zealand: Christmas Island, Norfolk Island, Heard & McDonald Islands, Cook Islands, Tokelau.
    UNLISTED_TERRITORIES_IN_SCOPE: Object.freeze([
        'eu', 'ax', 'gg', 'je', 'gi',
        'ai', 'bm', 'ky', 'ms', 'tc', 'vg', 'vi', 'gp', 'mq', 'gf', 'pm', 'sx', 'bq', 'fk', 'gs',
        'cx', 'nf', 'hm', 'ck', 'tk',
    ]),
    // Overseas territories of in-scope countries that lie OUTSIDE Europe, the Americas and Australia/New Zealand
    // (owner's decision, 10.4.9): EXCLUDED, kept as their own category so they are easy to bring back
    // (move a code to UNLISTED_TERRITORIES_IN_SCOPE). French: Réunion, Mayotte, New Caledonia, French Polynesia,
    // Wallis & Futuna, French Southern Territories. US Pacific: American Samoa, Guam, Northern Mariana Islands.
    // UK: Pitcairn.
    OVERSEAS_TERRITORIES_OUT_OF_SCOPE: Object.freeze([
        're', 'yt', 'nc', 'pf', 'wf', 'tf',
        'as', 'gu', 'mp',
        'pn',
    ]),
    // Non-Latin domain names (owner's decision): a hostname with a character of any other script is outside
    // the scope, EXCEPT the scripts of in-scope countries that have a filter list — Bulgarian (Cyrillic — also
    // Serbian/Macedonian) and Greek (Greece is EU). (10.4.6: Japanese — Han, Hiragana, Katakana — and Korean —
    // Hangul — removed with their filters.) Latin includes accented letters (müller.de); digits, "-" and "." are Common.
    KEPT_SCRIPTS_RE: /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\p{Script=Cyrillic}\p{Script=Greek}]*$/u,
    // Country-code TLDs written in a KEPT non-Latin script -> their country, so the country decides as for the
    // Latin ccTLD (.рф is Russia: out; .бг is Bulgaria: in). Written in Unicode here; matched in both forms.
    // Han/Hangul ccTLDs stay listed although those scripts are out of scope since 10.4.6: the PUNYCODE form
    // (xn--…) is plain ASCII and passes the script test, so only this map keeps e.g. .xn--3e0b707e (.한국) out.
    IDN_CCTLD_COUNTRY: Object.freeze({
        'рф': 'ru', 'укр': 'ua', 'бел': 'by', 'қаз': 'kz', 'мон': 'mn',
        'срб': 'rs', 'мкд': 'mk', 'бг': 'bg', 'ελ': 'gr', '한국': 'kr',
        '中国': 'cn', '中國': 'cn', '香港': 'hk', '台湾': 'tw', '台灣': 'tw',
    }),
});

function buildOutOfScopeCcTlds() {
    const S = GEO_SCOPE;
    const all = new Map();   // ccTLD -> continent
    for ( const source of [ COUNTRY_DATA, TERRITORY_DATA ] ) {
        for ( const [ continent, countries ] of Object.entries(source) ) {
            for ( const cc of Object.keys(countries) ) { all.set(cc, continent); }
        }
    }
    // Load-time guards: every hand-named code must exist in the data and be on the side it claims to change,
    // so a typo or a data change can never silently widen or narrow the scope.
    for ( const cc of S.EXCLUDED_IN_KEPT_CONTINENTS ) {
        if ( S.KEPT_CONTINENTS.includes(all.get(cc)) === false ) { throw new Error(`GEO_SCOPE: "${cc}" is not a country of a kept continent`); }
    }
    for ( const cc of S.KEPT_COUNTRIES ) {
        if ( all.has(cc) === false ) { throw new Error(`GEO_SCOPE: "${cc}" is not in COUNTRY_DATA/TERRITORY_DATA`); }
        if ( S.KEPT_CONTINENTS.includes(all.get(cc)) ) { throw new Error(`GEO_SCOPE: "${cc}" is already in a kept continent`); }
    }
    // A generic-use code is either unknown to the data or a country of an out-of-scope continent.
    for ( const cc of S.GENERIC_USE_CCTLDS ) {
        if ( all.has(cc) && S.KEPT_CONTINENTS.includes(all.get(cc)) ) { throw new Error(`GEO_SCOPE: "${cc}" is already in a kept continent`); }
    }
    // Hand-listed unknown codes must really be unknown to the data (else the data decides — no second opinion).
    for ( const cc of [ ...S.EXCLUDED_UNLISTED_CCTLDS, ...S.UNLISTED_TERRITORIES_IN_SCOPE, ...S.OVERSEAS_TERRITORIES_OUT_OF_SCOPE ] ) {
        if ( all.has(cc) ) { throw new Error(`GEO_SCOPE: "${cc}" is in COUNTRY_DATA/TERRITORY_DATA — let the data decide`); }
    }
    // No code may be in two hand-made lists (one decision per code).
    const named = [ ...S.EXCLUDED_IN_KEPT_CONTINENTS, ...S.EXCLUDED_UNLISTED_CCTLDS, ...S.KEPT_COUNTRIES,
                    ...S.GENERIC_USE_CCTLDS, ...S.UNLISTED_TERRITORIES_IN_SCOPE, ...S.OVERSEAS_TERRITORIES_OUT_OF_SCOPE ];
    const dup = named.find((cc, i) => named.indexOf(cc) !== i);
    if ( dup !== undefined ) { throw new Error(`GEO_SCOPE: "${dup}" is named in more than one list`); }
    const out = new Set([ ...S.EXCLUDED_UNLISTED_CCTLDS, ...S.OVERSEAS_TERRITORIES_OUT_OF_SCOPE ]);
    for ( const [ cc, continent ] of all ) {
        const inScope = S.KEPT_CONTINENTS.includes(continent)
            ? S.EXCLUDED_IN_KEPT_CONTINENTS.includes(cc) === false
            : S.KEPT_COUNTRIES.includes(cc) || S.GENERIC_USE_CCTLDS.includes(cc);
        if ( inScope === false ) { out.add(cc); }
    }
    return out;
}
// Every country-code TLD outside the scope (pure data, computed once at load).
export const OUT_OF_SCOPE_CCTLDS = Object.freeze(buildOutOfScopeCcTlds());

// Non-Latin ccTLD (both its Unicode and its punycode form) -> country code; load-time guard: every country exists.
const IDN_CCTLD_TO_COUNTRY = (( ) => {
    const out = new Map();
    for ( const [ unicodeTld, cc ] of Object.entries(GEO_SCOPE.IDN_CCTLD_COUNTRY) ) {
        const ascii = domainToASCII(`x.${unicodeTld}`).split('.').pop();
        if ( ascii === '' || ascii.startsWith('xn--') === false ) { throw new Error(`GEO_SCOPE: cannot encode TLD "${unicodeTld}"`); }
        out.set(unicodeTld, cc);
        out.set(ascii, cc);
    }
    return out;
})();

// True when a hostname (or "name.*" entity key, or bare TLD) is inside the scope: its script is a kept one and
// its last label (a non-Latin ccTLD mapped to its country first) is not an out-of-scope country code.
export function isTLDKept(hostname) {
    if ( typeof hostname !== 'string' || hostname === '' ) { return false; }
    const h = hostname.toLowerCase().replace(/\.$/, '');
    // Punycode or raw non-ASCII: judge the script on the Unicode form ("*" is a wildcard, not part of a name).
    if ( h.includes('xn--') || /[^\x00-\x7f]/.test(h) ) {
        const unicode = domainToUnicode(h.replace(/\*/g, 'x')) || h;
        if ( GEO_SCOPE.KEPT_SCRIPTS_RE.test(unicode) === false ) { return false; }
    }
    const tld = h.slice(h.lastIndexOf('.') + 1);
    return OUT_OF_SCOPE_CCTLDS.has(IDN_CCTLD_TO_COUNTRY.get(tld) ?? tld) === false;
}

/******************************************************************************/
// (10.7.8) WILDCARD_EXPANSION_TLD_CANDIDATES (33 guessed TLDs, each checked against the CrUX top-1M) was retired:
// "$domain=example.*" now expands to every in-scope domain named "example" that the CrUX snapshot actually contains
// (topSiteDomainsByName() in crux-top-sites.mjs, resolveWildcardDomainTokens() in rule-parsers.mjs — owner's
// option C). History: BUGREPORT-domain-wildcard-invalid-dnr-rules.md and CHANGELOG_HISTORY.md 10.7.8.

// ── Generic cosmetic/scriptlet rules with a `[$domain=...]` qualifier ──────
// AdGuard Base's real content uses this bracket-PREFIX form (not the plain
// trailing `##selector$domain=a|b` form) — and in every real instance found,
// the bracket content is a REGEX (`[$domain=/7tv\d+\.com$/]##selector`), not
// an enumerable domain list. Both shapes are handled; the plain-list branch
// exists for forward-compatibility in case that shape ever appears upstream
// (none found as of this writing — see CHANGELOG for what was checked).
export const GENERIC_DOMAIN_QUALIFIER_RE = /^\[\$domain=(.+)\]/;
// Matches a literal ".tld" right before the pattern's end anchor, e.g.
// /7tv\d+\.com$/ → "com". Only handles a single literal trailing TLD — the
// shape every real instance found actually has; anything else (alternation,
// no trailing anchor, etc.) fails extraction and the rule is dropped (see
// filterGenericDomainQualifier() below) rather than guessed at.
const REGEX_DOMAIN_TLD_RE = /\\\.([a-z]{2,24})\$\/?$/i;

function extractTldFromDomainRegex(regexSource) {
    const m = REGEX_DOMAIN_TLD_RE.exec(regexSource);
    return m ? m[1].toLowerCase() : null;
}

// Returns the cleaned-up bracket content to keep, or null to drop the whole
// rule. `tldCheckFn` is the same (hostname) => boolean "keep" signature used
// throughout this file — isTLDKept in practice, passed explicitly rather than
// hardcoded so this function has no hidden dependency on which list calls it.
export function filterGenericDomainQualifier(domainExpr, tldCheckFn) {
    const t = domainExpr.trim();

    if ( t.startsWith('/') && t.endsWith('/') ) {
        const tld = extractTldFromDomainRegex(t);
        // No extractable literal TLD → drop (can't verify it's safe), per
        // explicit request — the drop-on-failed-extraction default.
        if ( tld === null ) { return null; }
        return tldCheckFn(`x.${tld}`) ? t : null;
    }

    // Plain pipe-separated domain list (not seen in real content as of this
    // writing — kept for forward-compatibility, see comment above).
    const kept = t
        .split('|')
        .map(d => d.trim())
        .filter(Boolean)
        .filter(d => tldCheckFn(d.startsWith('~') ? d.slice(1) : d));
    if ( kept.length === 0 ) { return null; }
    return kept.join('|');
}

/******************************************************************************/
// "Foreign rules" section filter — AdGuard's Base filter groups per-site
// rules for languages without a dedicated filter list under a "Foreign
// rules" section, itself subdivided by language with headers of the form:
//
//   !---------------------------------------------------------------------
//   !------------------------------ Albanian -----------------------------
//   !---------------------------------------------------------------------
//
// Unlike KEEP_TLDS (which filters by the rule's domain TLD), this filters by
// the SOURCE LANGUAGE of the subsection — necessary because most non-EU/5-Eyes
// sites still register generic .com/.net/.org domains that would otherwise
// pass straight through the TLD filter untouched (measured: ~85% of domains
// in this section use a TLD that's on the "kept" list regardless of the
// site's actual language/region).
//
// Only applied to the AdGuard Base filter's "Foreign rules" section — this
// section-header format is specific to that filter, not the general ABP
// syntax, so it must not be applied to other filter lists.
/******************************************************************************/

// Language subsection name → destination. Three kinds:
//   - a countryOverflow bucket id string (see the AdGuard Base FILTER_LISTS
//     entry's countryOverflow config) — reuses the EXISTING hidden bucket
//     and its EXISTING RULESET_COMPANIONS auto-enable wiring; several
//     language names may map to the same bucket id (matches how one bucket
//     can already own several TLDs).
//   - the sentinel 'BELGIAN' — routed to the new, separate, VISIBLE
//     ruleset_adguard_belgian filter (no clean existing bucket owner — see
//     the .be TLD precedent this mirrors).
//   - the sentinel 'MAIN' — not a language at all ("Fixing other filters"
//     is a maintenance subsection); stays inline in the main AdGuard Base
//     output, same as before this change.
//   (10.4.6) The 10.4.5 'KOREAN' visible-filter route was removed with the
//     Korean filter; AdGuard's Korean subsection is dropped again. The Balkan
//     and Baltic states languages go to their filter's overflow bucket
//     (shown as countries — tools/build/filter-lists.mjs).
// Out-of-scope languages (Arabian, Armenian, Azerbaijani, Moldovian,
// Georgian, Hebrew, Thai, Vietnamese, …) have no entry and are dropped.
// Every language name NOT in this map is blacklisted — dropped entirely,
// same outcome as the old KEEP_LANGUAGES-absent case, just inverted
// framing (blacklist model, not allowlist, per the AdGuard-Base-only
// scope of this whole mechanism).
const LANGUAGE_TO_DESTINATION = {
    'Bulgarian':            'ruleset_agbase_overflow_bulgarian',
    'Czech and Slovakian':  'ruleset_agbase_overflow_czech_slovak',
    'Danish':               'ruleset_agbase_overflow_nordic',
    'Norwegian':            'ruleset_agbase_overflow_nordic',
    'Iceland':              'ruleset_agbase_overflow_nordic',
    // (10.4.5) Baltic states filter (Estonia, Finland, Latvia, Lithuania) — id kept from the Latvian filter.
    'Latvian':               'ruleset_agbase_overflow_latvian',
    'Lithuanian':            'ruleset_agbase_overflow_latvian',
    'Estonian':              'ruleset_agbase_overflow_latvian',
    'Finnish':               'ruleset_agbase_overflow_latvian',
    'Italian':               'ruleset_agbase_overflow_italian',
    'Polish':                'ruleset_agbase_overflow_polish',
    // (10.4.5) Balkan filter — id kept from the Bulgarian filter ('Bulgarian' above already routes here).
    'Albanian':              'ruleset_agbase_overflow_bulgarian',
    'Bosnian':               'ruleset_agbase_overflow_bulgarian',
    'Croatian':              'ruleset_agbase_overflow_bulgarian',
    'Greek':                 'ruleset_agbase_overflow_bulgarian',
    'Macedonian':            'ruleset_agbase_overflow_bulgarian',
    'Montenegrin':           'ruleset_agbase_overflow_bulgarian',
    'Romanian':              'ruleset_agbase_overflow_bulgarian',
    'Serbian':               'ruleset_agbase_overflow_bulgarian',
    'Slovenian':             'ruleset_agbase_overflow_bulgarian',
    // (10.4.5) Hungarian filter.
    'Hungarian':             'ruleset_agbase_overflow_hungarian',
    'Luxembourgish':         'ruleset_agbase_overflow_other',
    'Maltese':               'ruleset_agbase_overflow_other',
    'Swedish':               'ruleset_agbase_overflow_nordic',   // (10.4.5) Sweden joined Nordic
    'Belgian':               'BELGIAN',
    'Fixing other filters':  'MAIN',
};


// Matches the wide language-header format only (~65-71 char total width).
// Deliberately does NOT match the shorter nested dividers used inside a
// language's own rules (e.g. "!---- JS rules ----", ~19 chars) — those stay
// attached to whichever language section they're nested in.
const LANGUAGE_HEADER_RE = /^!-{4,}\s+([A-Za-z][A-Za-z\s]*?)\s+-{4,}$/;
const MIN_HEADER_LINE_LENGTH = 40;

// Replaces the old stripForeignRulesSection() (drop-only). Routes each
// language subsection to its destination per LANGUAGE_TO_DESTINATION
// instead of just dropping non-kept ones. Returns:
//   text        — main AdGuard Base text with the whole Foreign rules
//                 section removed except 'MAIN'-routed content spliced
//                 back in place
//   belgianText — raw text of the Belgian subsection (empty string if none)
//   bucketText  — Map<bucketId, text> for every countryOverflow-bucket-
//                 routed subsection; merged into that bucket's own
//                 TLD-based extraction later (see build()'s own comment
//                 on this merge step)
export function extractForeignRulesSections(text) {
    const lines = text.split('\n');
    const startIdx = lines.findIndex(l => l.includes('!------------------ Foreign rules'));
    if ( startIdx === -1 ) { return { text, belgianText: '', bucketText: new Map() }; }
    let endIdx = lines.length;
    for ( let i = startIdx + 1; i < lines.length; i++ ) {
        if ( /^!------------------ .+ -+!$/.test(lines[i].trimEnd()) ) {
            endIdx = i;
            break;
        }
    }

    const out = lines.slice(0, startIdx);
    let currentLanguage = null;
    let destination = null;  // null until the first header is seen — see below
    let droppedLines = 0;
    const mainKept = [];
    const belgianLines = [];
    const bucketLines = new Map();

    for ( let i = startIdx; i < endIdx; i++ ) {
        const line = lines[i].trimEnd();
        if ( line.length >= MIN_HEADER_LINE_LENGTH ) {
            const m = LANGUAGE_HEADER_RE.exec(line);
            if ( m ) {
                currentLanguage = m[1].trim();
                destination = LANGUAGE_TO_DESTINATION[currentLanguage] ?? null;
            }
        }
        // Before the first language header (file-level preamble/commentary,
        // no actual filter content) — always dropped, matches this content
        // having no functional effect either way.
        if ( currentLanguage === null ) { droppedLines++; continue; }
        if ( destination === 'MAIN' ) { mainKept.push(lines[i]); }
        else if ( destination === 'BELGIAN' ) {
            // Confirmed mislabeling in AdGuard's OWN upstream foreign.txt
            // (10.0.6): dir.bg is a genuine Bulgarian site — it appears
            // correctly under CyrillicFilters/Bulgarian/sections/filter.txt
            // on AdGuard's side (||dir.bg/js_ext.php?...) — but these two
            // lines also sit, wrongly, under the "Belgian" header here.
            // Dropped rather than carried into Dutch/French, where a
            // Bulgarian site's cosmetic rule has no business being.
            if ( lines[i].includes('dir.bg') ) { droppedLines++; continue; }
            belgianLines.push(lines[i]);
        }
        else if ( destination !== null ) {
            if ( !bucketLines.has(destination) ) { bucketLines.set(destination, []); }
            bucketLines.get(destination).push(lines[i]);
        } else {
            droppedLines++;  // blacklisted language, no destination
        }
    }

    // Array.push(...largeArray) hits V8's max-arguments-per-call limit —
    // build the final array via concat instead, which has no such limit.
    const result = out.concat(mainKept, lines.slice(endIdx));
    process.stdout.write(`(dropped ${droppedLines} blacklisted-language lines, routed ${belgianLines.length} Belgian + ${[...bucketLines.values()].reduce((s, a) => s + a.length, 0)} bucket lines) `);
    const bucketText = new Map();
    for ( const [id, arr] of bucketLines ) { bucketText.set(id, arr.join('\n')); }
    return { text: result.join('\n'), belgianText: belgianLines.join('\n'), bucketText };
}

// (10.5.1) readAdultSiteDomains() removed — adult-site-rules.mjs's topAdultSiteDomains() is the one reader of
// adult-sites.mjs now (single source of truth unchanged).

// Name → domain(s), for matching a general_url.txt comment-header (a human
// site name, e.g. "xHamster") back to that site's actual domain(s) from
// the list above. Only multi-domain sites need an explicit array entry;
// everything else is derived by lowercasing the header and checking
// against the domain list directly (see matchAdultSiteHeader() below).
const ADULT_SITE_NAME_ALIASES = {
    'xhamster':    [ 'xhamster.com', 'xhamster19.com', 'xhamsterlive.com' ],
    'xvideos':     [ 'xvideos.com', 'xvideos.es' ],
    'xgroovy':     [ 'xgroovy.com', 'xgroovy.tv' ],
};

// Matches a block's header text against a known adult-site name. Returns
// the matching domain(s) or null (no specific site named — generic porn/
// adult commentary, not attributable to one site).
function matchAdultSiteHeader(headerText, allDomains) {
    const norm = headerText.toLowerCase().replace(/[^a-z0-9]/g, '');
    if ( ADULT_SITE_NAME_ALIASES[norm] ) { return ADULT_SITE_NAME_ALIASES[norm]; }
    for ( const d of allDomains ) {
        const base = d.split('.')[0];  // 'pornhub.com' → 'pornhub'
        if ( norm === base ) { return [ d ]; }
    }
    return null;
}

// Splits general_url.txt-shaped text into comment-header-delimited blocks
// (see this project's own recognition rule: a block is one or more
// consecutive '!' lines immediately followed by one or more consecutive
// non-'!' pattern lines, ending at the next '!' line or EOF), classifies
// each block against the adult-site domain list, and returns:
//   remainingText — original text with site-named blocks removed
//   adultRuleLines — site-named blocks' pattern lines, each rewritten with
//                    $domain= scoping added (existing options preserved)
//   coveredDomains — Set of every curated domain that had at least one
//                    block here (AdGuard's own named-site coverage) — see
//                    extractDomainScopedAdultRules()'s skipDomains param.
export function extractAdultSiteRules(text, allDomains) {
    const lines = text.split('\n');
    const remaining = [];
    const adultRuleLines = [];
    const coveredDomains = new Set();
    let i = 0;
    let extractedBlocks = 0;

    while ( i < lines.length ) {
        if ( !lines[i].trimStart().startsWith('!') ) {
            remaining.push(lines[i]);
            i++;
            continue;
        }
        // Consume the full header run.
        const headerStart = i;
        const headerLines = [];
        while ( i < lines.length && lines[i].trimStart().startsWith('!') ) {
            headerLines.push(lines[i].replace(/^!\s*/, '').trim());
            i++;
        }
        // Consume the pattern run that follows (until the next '!' or EOF).
        const patternStart = i;
        while ( i < lines.length && !lines[i].trimStart().startsWith('!') && lines[i].trim() !== '' ) { i++; }
        const patternLines = lines.slice(patternStart, i);

        const headerText = headerLines.join(' ');
        const domains = matchAdultSiteHeader(headerText, allDomains);
        if ( domains === null || patternLines.length === 0 ) {
            // Generic (no specific site named) or a header with no
            // following pattern lines at all — leave exactly as-is.
            for ( let j = headerStart; j < patternStart; j++ ) { remaining.push(lines[j]); }
            for ( const pl of patternLines ) { remaining.push(pl); }
            continue;
        }
        extractedBlocks++;
        const domainOpt = domains.join('|');
        for ( const d of domains ) { coveredDomains.add(d); }
        for ( const pl of patternLines ) {
            const t = pl.trim();
            if ( !t ) { continue; }
            adultRuleLines.push(t.includes('$') ? `${t},domain=${domainOpt}` : `${t}$domain=${domainOpt}`);
        }
        // Site-named block's lines are NOT pushed to remaining — pulled out.
    }

    if ( extractedBlocks > 0 ) {
        process.stdout.write(`(pulled ${extractedBlocks} site-named block(s) out for adult ruleset) `);
    }
    // coveredDomains — every curated domain AdGuard's own general_url.txt already has
    // a dedicated block for (10.4.x, explicit request: avoid shipping a second,
    // differently-sourced rule set for a site AdGuard already covers, to avoid
    // multi-source conflicts). Passed by the caller as extractDomainScopedAdultRules()'s
    // skipDomains, below.
    return { remainingText: remaining.join('\n'), adultRuleLines, coveredDomains };
}

/******************************************************************************/
// extractDomainScopedAdultRules() — domain-matched extraction for FLAT, non-header
// sources (general-purpose supplemental lists, e.g. uBlockOrigin/uAssets' filters.txt,
// ubol-filters.txt, filters-2026.txt), added 10.3.0 by explicit request.
//
// Unlike extractAdultSiteRules() above (which matches a general_url.txt-shaped
// COMMENT HEADER against a site name table), these sources have no per-site header at
// all — just a flat stream of ordinary rules, most of which already name the target
// host directly inside the rule (a cosmetic host prefix, a `$domain=` option, or a
// `||host` network-rule prefix). So the match here is host-text-based, not header-based,
// and every matched line already carries its own correct scoping — nothing needs a
// `$domain=` suffix ADDED (contrast extractAdultSiteRules(), which adds one).
//
// Three line shapes recognised, each checked independently so a line can only match
// through the shape it actually uses:
//   1. Cosmetic/scriptlet  — "host1,host2##selector" / "#@#" / "#?#" / "#@?#" / "#%#".
//      Only the matching host(s) from the comma list are kept; unrelated co-listed
//      hosts are dropped so the extracted rule cannot leak onto a non-adult site.
//   2. Network rule with a `$...,domain=a|b,...` option — same per-token keep/drop,
//      applied to the option's own value list; `~excluded` tokens are left alone
//      (they only narrow, never decide inclusion) and dropped from the rebuilt list.
//   3. Network rule with a bare `||host^` / `||host/path` prefix and no domain= option
//      — the host IS the scope, so the whole line is kept as-is once it matches.
//
// Wildcard TLD host ("pornhub.*") is resolved to the concrete curated domain whose
// first label matches ("pornhub.com") and the wildcard is REWRITTEN to that domain in
// the emitted line — per explicit request ("translate the * to the domain name").
// An unresolvable wildcard (base doesn't match any curated domain) is simply not a
// match; it is never emitted as a half-translated or still-wildcarded line.
//
// Guard: any line inside an `!#if ... !#endif` preprocessor block is skipped
// unconditionally, whichever branch it's in — this function has no environment model,
// so it cannot safely decide an environment-gated rule applies, and extracting one
// without its guard would silently broaden it to every environment.
/******************************************************************************/

// Resolves one host token to the concrete curated domain it names, translating a
// single-label wildcard ("pornhub.*" -> "pornhub.com") against allDomains' own first
// label. A non-wildcard token passes through unchanged (lowercased). Returns null only
// for a wildcard token whose base matches no curated domain — never a partial/guessed
// translation.
function resolveAdultHostToken(token, allDomains) {
    const t = token.trim().toLowerCase();
    if ( !t.endsWith('.*') ) { return t; }
    const base = t.slice(0, -2);
    const resolved = allDomains.find(d => d.split('.')[0] === base);
    return resolved ?? null;
}

// Returns the specific curated domain `resolvedHost` (already passed through
// resolveAdultHostToken — null means "no match") falls under — itself, or a
// subdomain of one — or null if it matches none. Returning the specific
// matched entry (not just true/false) is what lets the caller check it
// against skipDomains below — a plain boolean would lose which domain matched.
function matchAdultDomain(resolvedHost, allDomains) {
    if ( resolvedHost === null ) { return null; }
    for ( const d of allDomains ) {
        if ( resolvedHost === d || resolvedHost.endsWith(`.${d}`) ) { return d; }
    }
    return null;
}

const COSMETIC_MARKER_RE = /^([^!#][^#]*?)(##|#@#|#\?#|#@\?#|#%#)/;

// skipDomains (10.4.x, explicit request) — a Set of curated domains to leave
// OUT of this extraction entirely, because AdGuard's own general_url.txt
// already has a dedicated block for them (extractAdultSiteRules()'s
// coveredDomains). Rationale: shipping a second, differently-sourced rule
// set for a site AdGuard already covers risks the two sources conflicting
// (different cosmetic selectors fighting, overlapping-but-not-identical
// network rules) for no real gain — AdGuard's own coverage is kept, the
// uBO/uAssets content for that one site is dropped, every other matched
// site is unaffected. Defaults to an empty Set so every existing caller
// (and every test) that doesn't pass one keeps today's behaviour exactly.
export function extractDomainScopedAdultRules(text, allDomains, skipDomains = new Set()) {
    const matched = [];
    let ifDepth = 0;
    let skippedUboScriptletCount = 0;
    let skippedConflictCount = 0;
    for ( const raw of text.split('\n') ) {
        const line = raw.trim();
        if ( line === '' ) { continue; }
        if ( line.startsWith('!#if') ) { ifDepth++; continue; }
        if ( line.startsWith('!#endif') ) { if ( ifDepth > 0 ) { ifDepth--; } continue; }
        if ( ifDepth > 0 ) { continue; }
        if ( line.startsWith('!') ) { continue; }

        // Shape 1 — cosmetic/scriptlet: "host1,host2##selector".
        const cosmeticMatch = COSMETIC_MARKER_RE.exec(line);
        if ( cosmeticMatch ) {
            const [ wholeMatch, hostsPart, marker ] = cosmeticMatch;
            const rest = line.slice(wholeMatch.length);
            // GUARD: uBO's own scriptlet-call shorthand is "##+js(name, args)" — the
            // SAME bare `##` marker as an ordinary cosmetic hide rule, distinguished
            // only by the selector text itself starting with "+js(". This codebase's
            // cosmetic parser (cosmetic-data.mjs) has no "+js(" recognition at all —
            // it only special-cases the AdGuard/ABP `#%#//scriptlet(...)` marker as
            // scriptlet syntax — so a "##+js(...)" line would silently compile as a
            // bogus, inert CSS selector (never matches any real element) rather than
            // as a working scriptlet injection. Confirmed by inspecting a real build's
            // output: these lines landed verbatim as literal selector strings inside
            // the (since 10.5.1 removed) ruleset_adguard_base_adult-cosmetic-specific.json. Until this codebase
            // gains real "##+js(...)" -> scriptlet-dispatch translation, such lines
            // are skipped here rather than shipped broken — counted and reported so
            // the drop is visible, never silent.
            if ( marker === '##' && rest.trimStart().startsWith('+js(') ) {
                skippedUboScriptletCount++;
                continue;
            }
            const keptHosts = [];
            for ( const h of hostsPart.split(',') ) {
                const resolved = resolveAdultHostToken(h, allDomains);
                const domain = matchAdultDomain(resolved, allDomains);
                if ( domain === null ) { continue; }
                if ( skipDomains.has(domain) ) { skippedConflictCount++; continue; }
                keptHosts.push(resolved);
            }
            if ( keptHosts.length > 0 ) { matched.push(`${keptHosts.join(',')}${marker}${rest}`); }
            continue;
        }

        // Shape 2 — network rule carrying a `$...,domain=a|b,...` option.
        const dollarIdx = line.indexOf('$');
        if ( dollarIdx !== -1 ) {
            const opts = line.slice(dollarIdx + 1).split(',');
            const domainOptIdx = opts.findIndex(o => o.startsWith('domain='));
            if ( domainOptIdx !== -1 ) {
                const keptDomains = [];
                for ( const v of opts[domainOptIdx].slice('domain='.length).split('|') ) {
                    if ( v.startsWith('~') ) { continue; } // excludes only narrow; never a match reason
                    const resolved = resolveAdultHostToken(v, allDomains);
                    const domain = matchAdultDomain(resolved, allDomains);
                    if ( domain === null ) { continue; }
                    if ( skipDomains.has(domain) ) { skippedConflictCount++; continue; }
                    keptDomains.push(resolved);
                }
                if ( keptDomains.length > 0 ) {
                    opts[domainOptIdx] = `domain=${keptDomains.join('|')}`;
                    matched.push(`${line.slice(0, dollarIdx)}$${opts.join(',')}`);
                }
                continue;
            }
        }

        // Shape 3 — bare `||host^` / `||host/path`, no domain= option.
        const hostMatch = /^\|\|([a-z0-9.*-]+)/i.exec(line);
        if ( hostMatch ) {
            const resolved = resolveAdultHostToken(hostMatch[1], allDomains);
            const domain = matchAdultDomain(resolved, allDomains);
            if ( domain !== null ) {
                if ( skipDomains.has(domain) ) {
                    skippedConflictCount++;
                } else {
                    matched.push(resolved === hostMatch[1] ? line : `||${resolved}${line.slice(hostMatch[0].length)}`);
                }
            }
        }
    }
    if ( matched.length > 0 ) {
        process.stdout.write(`(domain-matched ${matched.length} adult-site rule(s)) `);
    }
    if ( skippedUboScriptletCount > 0 ) {
        process.stdout.write(`(skipped ${skippedUboScriptletCount} "##+js(...)" uBO-scriptlet-syntax line(s) — not yet supported by this codebase's scriptlet pipeline) `);
    }
    if ( skippedConflictCount > 0 ) {
        process.stdout.write(`(skipped ${skippedConflictCount} rule(s) for ${skipDomains.size} site(s) AdGuard already covers directly) `);
    }
    return matched;
}

/******************************************************************************/
// Portuguese-speaking TLDs + AdGuard Spanish generic extraction (10.0.7)
/******************************************************************************/

// ALL Portuguese-speaking countries/territories, computed ONCE from the reference data (not hand-typed,
// not just Brazil): ao, br, cv, gq, gw, mo, mz, pt, st, tl. LUSOPHONE_LANGUAGE_CODE is the data's code.
const LUSOPHONE_LANGUAGE_CODE = 'pt';
export const PORTUGUESE_SPEAKING_TLDS = Object.freeze([ ...new Set(
    [ COUNTRY_DATA, TERRITORY_DATA ].flatMap(source => Object.values(source))
        .flatMap(byTld => Object.entries(byTld))
        .filter(([ , languages ]) => languages.includes(LUSOPHONE_LANGUAGE_CODE))
        .map(([ tld ]) => tld)
) ].sort());

// A literal ".tld" that is NOT the start of a longer label (".br" must not match ".bravo"/".bread").
const LUSOPHONE_TLD_RE = new RegExp(`\\.(${PORTUGUESE_SPEAKING_TLDS.join('|')})(?![a-z0-9-])`, 'i');

// From AdGuard SpanishFilter's fetched sections ({ name: text }) pulls what the Portuguese filter also needs:
// (a) the generic (non-country-specific) sections, listed in SPANISH_GENERIC_SECTIONS, in full, and
// (b) any rule line in the other sections tagged with a Portuguese-speaking-country TLD.
// Returns the de-duplicated text (comment/blank lines dropped).
const SPANISH_GENERIC_SECTIONS = Object.freeze([ 'general_extensions', 'general_url' ]);
export function extractSpanishGenericAndLusophone(sections) {
    const out = new Set();
    for ( const [ name, text ] of Object.entries(sections) ) {
        const generic = SPANISH_GENERIC_SECTIONS.includes(name);
        for ( const raw of text.split('\n') ) {
            const line = raw.trim();
            if ( line === '' || line.startsWith('!') || line.startsWith('[') ) { continue; }
            if ( generic || LUSOPHONE_TLD_RE.test(line) ) { out.add(line); }
        }
    }
    return [ ...out ].join('\n');
}
