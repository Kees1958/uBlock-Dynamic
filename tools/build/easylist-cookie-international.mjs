// ── tools/build/easylist-cookie-international.mjs ─────────────────────────────────
// EasyList Cookie International (easylist_cookie_international_specific_hide.txt) — site-specific cookie-banner
// hide rules, partitioned per language. Added 10.4.9 (owner's decision): each language section is appended SILENTLY
// to our own language filter for that language (no separate toggle, same model as AdGuard Base's foreign.txt
// routing), so it is on exactly when that language filter is on.
//
// Owner's decisions: no CrUX top-1M gate here (non-English sites rarely reach the top 1M); the geographic scope still
// applies (parser, isTLDKept); out-of-scope languages are not used at all.
//
// Public interface:
//   easylistCookieTextFor(rulesetId) — async: the hide-rule lines of every section mapped to that ruleset ('' if none)
//   resetEasylistCookieCache()       — release the cached download (build start)
//
// Resources: one download per build, cached as a promise (every language list asks for its own sections; the file is
// fetched once). Initialised on the first request, cleared on a failed download (the next list retries), released by
// resetEasylistCookieCache() — called by build-steps.mjs right after resetBuildAccumulators() at every build start.
import { fetchList } from './fetch-helpers.mjs';
import { buildNotices } from './build-state.mjs';

/******************************************************************************/
// Settings — the ONLY place these values live.
/******************************************************************************/

const EASYLIST_COOKIE_INTERNATIONAL_URL =
    'https://raw.githubusercontent.com/easylist/easylist/refs/heads/master/easylist_cookie/easylist_cookie_international_specific_hide.txt';

// Section header as written upstream: "! ---------- German ----------" (trailing dashes vary in count).
const SECTION_HEADER_RE = /^!\s*-{3,}\s*(.+?)\s*-{3,}\s*$/;

// Upstream section name -> our language filter ruleset. Combined country filters take every language of their group.
const SECTION_TO_RULESET = Object.freeze({
    German:     'ruleset_adguard_german',
    French:     'ruleset_adguard_french',
    Dutch:      'ruleset_adguard_dutch',
    Spanish:    'ruleset_adguard_spanish',
    Catalan:    'ruleset_adguard_spanish',
    Italian:    'ruleset_easylist_italian',
    Polish:     'ruleset_easylist_polish',
    Portuguese: 'ruleset_easylist_portuguese',
    Hungarian:  'ruleset_hungarian',
    Czech:      'ruleset_easylist_czech_slovak',
    Slovak:     'ruleset_easylist_czech_slovak',
    // Nordic group
    Danish:     'ruleset_easylist_nordic',
    Icelandic:  'ruleset_easylist_nordic',
    Norwegian:  'ruleset_easylist_nordic',
    Swedish:    'ruleset_easylist_nordic',
    // Baltic states group (Finland belongs to it)
    Estonian:   'ruleset_easylist_latvian',
    Finnish:    'ruleset_easylist_latvian',
    Latvian:    'ruleset_easylist_latvian',
    Lithuanian: 'ruleset_easylist_latvian',
    // Balkan group
    Bosnian:    'ruleset_easylist_bulgarian',
    Bulgarian:  'ruleset_easylist_bulgarian',
    Croatian:   'ruleset_easylist_bulgarian',
    Greek:      'ruleset_easylist_bulgarian',
    Macedonian: 'ruleset_easylist_bulgarian',
    Romanian:   'ruleset_easylist_bulgarian',
    Serbian:    'ruleset_easylist_bulgarian',
    Slovenian:  'ruleset_easylist_bulgarian',
});

// Sections deliberately NOT used: languages outside the geographic scope, and Welsh (no language filter of ours;
// English-language sites are AdGuard Base's job). A section in neither map is reported as a build notice.
const IGNORED_SECTIONS = Object.freeze(new Set([
    'Arabic', 'Belarusian', 'Chinese', 'Georgia', 'Hebrew', 'Indian', 'Japanese', 'Korean', 'Malaysian',
    'Philippines', 'Russian', 'Thai', 'Turkish', 'Ukrainian', 'Indonesian', 'Vietnamese', 'Welsh',
]));

// GUARD (C13a): a download with fewer recognised sections is truncated or not this file.
const MIN_MAPPED_SECTIONS = 20;

/******************************************************************************/

let sectionsPromise = null;   // Map<rulesetId, string[]> for this build, or null before the first request

export function resetEasylistCookieCache() {
    sectionsPromise = null;
}

async function loadSections() {
    const text = await fetchList(EASYLIST_COOKIE_INTERNATIONAL_URL);   // throws on empty / non-filter-list responses
    const byRuleset = new Map();
    const unknown = new Set();
    const mapped = new Set();
    let target;   // ruleset of the current section, null = ignored, undefined = before the first header
    for ( const raw of text.split('\n') ) {
        const line = raw.trim();
        const header = SECTION_HEADER_RE.exec(line);
        if ( header !== null ) {
            const name = header[1];
            if ( Object.hasOwn(SECTION_TO_RULESET, name) ) { target = SECTION_TO_RULESET[name]; mapped.add(name); }
            else { target = null; if ( IGNORED_SECTIONS.has(name) === false ) { unknown.add(name); } }
            continue;
        }
        if ( !target || line === '' || line.startsWith('!') ) { continue; }
        if ( byRuleset.has(target) === false ) { byRuleset.set(target, []); }
        byRuleset.get(target).push(line);
    }
    if ( mapped.size < MIN_MAPPED_SECTIONS ) {
        throw new Error(`EasyList Cookie International: only ${mapped.size} known language sections (expected at least ${MIN_MAPPED_SECTIONS}) — truncated download or format change`);
    }
    if ( unknown.size > 0 ) {
        buildNotices.push({ level: 'NOTICE', text: `EasyList Cookie International: new language section(s) not used yet: ${[ ...unknown ].join(', ')} — add each to SECTION_TO_RULESET or IGNORED_SECTIONS (tools/build/easylist-cookie-international.mjs).` });
    }
    return byRuleset;
}

export async function easylistCookieTextFor(rulesetId) {
    if ( Object.values(SECTION_TO_RULESET).includes(rulesetId) === false ) { return ''; }   // fast path: not a target
    if ( sectionsPromise === null ) {
        sectionsPromise = loadSections();
        sectionsPromise.catch(() => { sectionsPromise = null; });   // a failed download is retried by the next list
    }
    const lines = (await sectionsPromise).get(rulesetId) ?? [];
    if ( lines.length > 0 ) { process.stdout.write(`(+${lines.length} EasyList cookie hide rule(s)) `); }
    return lines.length > 0
        ? [ '!------------------ EasyList Cookie International ------------------!', ...lines ].join('\n')
        : '';
}
