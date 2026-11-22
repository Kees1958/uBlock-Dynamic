/*******************************************************************************

    uBlock-Stripped-Dynamic — Allow list parser / serialiser

    Parses and serialises the plain domain list used in the Allow list
    dashboard editor.

    Format: one domain per line, blank lines and lines starting with # ignored.

    Internal representation: { [hostname]: 0 }
    All listed domains are mapped to mode 0 (no-filtering / off).

    Values:
      0 = OFF   / no-filtering  (the only mode exposed here)
      1 = BASIC / on            (the global default for unlisted domains)

*******************************************************************************/
/*
 * site-mode-parser.js -- plain-list serialiser/parser for the allow list editor
 *
 * Public interface:
 *   siteModesFromText(text, refused = []) -- parses plain list -> {hostname: 0} object; lines that are not a
 *                                 site name are skipped and pushed onto `refused` (11.0.2)
 *   hostnameFromAllowListLine(line) -- the site name in one line: a plain name, or a pasted web address
 *                                      (scheme, path, port removed); '' when it is not a site name (11.0.2)
 *   textFromSiteModes(modes)   -- serialises {hostname: mode} -> plain list
 *   extractOptionLinesFromText(text) -- pulls "@@domain$worryfree" lines (and the retired
 *                                      "@@domain$saferegions" lines, which are dropped)
 *                                      out of the same editor's text, returns
 *                                      { byOption, remainingText, ignoredRetiredCount }
 *   textFromWorryfree(domains)  -- serialises a domain list back into
 *                                  "@@domain$worryfree" lines
 *
 * No state. No side effects. Pure serialisation utility.
 */


import punycode from './punycode.js';
import { isValidHostnamePattern, MAX_HOSTNAME_LENGTH } from './utils.js';

/******************************************************************************/

// REMOVED (audit after 9.7.5): SECTION_NAMES — its comment said
// mode-editor.js used it, but nothing in the codebase imports it any more.

/******************************************************************************/

// Per-site option lines — "@@domain$<option>", the same syntax badfilter-quick-fixes.txt's own
// build-time entries use (parseBlockRule() in tools/build/rule-parsers.mjs), so a person familiar
// with one recognizes the other. Case-insensitive on the option word only — the domain itself is
// lowercased the same way every other line in this file is.
//
// MERGED PARSER (B15): one regex with the option word as an alternation, one implementation, for
// every option — live and retired alike — so the channels can never disagree about what an option
// line is.
//
//   $worryfree   — exempts the domain from Worry-free altogether: the Worry-free extra filter
//                  lists and cookie-consent dismissal (worryfree-manager.js, compiled-filters.js).
export const SITE_MODE_OPTIONS = Object.freeze({
    WORRYFREE:   'worryfree',
});

// RETIRED options (10.3.0) — still RECOGNISED, so an old line never falls through to become a junk
// no-filtering domain or a compiled filter, but IGNORED: the domains are dropped and only counted.
//   saferegions — exempted a site from the "outside safer regions" protections of the Privacy &
//                 Security tab; those protections moved to the separate 3P-Matrix extension.
// One place: every channel (Allow list tab, ABP-import editor, badfilter-quick-fixes.txt at build
// time) reads this list, so a retired option cannot be honoured by one channel and not another.
export const RETIRED_SITE_MODE_OPTIONS = Object.freeze([ 'saferegions' ]);

const OPTION_NAMES = Object.freeze(Object.values(SITE_MODE_OPTIONS));
const RECOGNISED_OPTION_NAMES = Object.freeze([ ...OPTION_NAMES, ...RETIRED_SITE_MODE_OPTIONS ]);

// (11.0.2) '_' allowed in the hostname, as in every other hostname check (js/util/utils.js HOSTNAME_LABEL_RE).
const OPTION_LINE_RE = new RegExp(`^@@([a-z0-9_.-]+)\\$(${RECOGNISED_OPTION_NAMES.join('|')})$`, 'i');

// Any recognised option line at all (live or retired) — kept out of the no-filtering list.
function isOptionLine(trimmed) { return OPTION_LINE_RE.test(trimmed); }

// Pulls option lines out of the editor's raw text BEFORE it reaches siteModesFromText() — an option
// line must never become a no-filtering domain entry. Returns the domains for every LIVE option
// (keyed by option name), the remaining text (every other line, unchanged), and how many RETIRED
// option lines were dropped (so the caller can tell the person — the Allow list editor does).
export function extractOptionLinesFromText(text) {
    const byOption = Object.fromEntries(OPTION_NAMES.map(name => [ name, [] ]));
    const remainingLines = [];
    let ignoredRetiredCount = 0;
    for ( const rawLine of text.split(/\n|\r\n|\r/) ) {
        const trimmed = rawLine.trim();
        const m = OPTION_LINE_RE.exec(trimmed);
        if ( m === null ) { remainingLines.push(rawLine); continue; }
        const option = m[2].toLowerCase();
        if ( RETIRED_SITE_MODE_OPTIONS.includes(option) ) { ignoredRetiredCount += 1; continue; }
        const hn = punycode.toASCII(m[1].toLowerCase());
        if ( hn.length > 0 && hn.length <= MAX_HOSTNAME_LENGTH ) { byOption[option].push(hn); }
    }
    return { byOption, remainingText: remainingLines.join('\n'), ignoredRetiredCount };
}

// Serialises an option's domain list back into the editor's own line shape, same sorted-list style
// as textFromSiteModes() below.
function textFromOptionDomains(domains, option) {
    if ( !Array.isArray(domains) || domains.length === 0 ) { return ''; }
    if ( OPTION_NAMES.includes(option) === false ) {
        console.warn(`[uBlock-Dynamic] textFromOptionDomains: unknown option '${option}'`);
        return '';
    }
    return [ ...domains ]
        .map(hn => punycode.toUnicode(hn))
        .sort((a, b) => a.localeCompare(b))
        .map(hn => `@@${hn}$${option}`)
        .join('\n') + '\n';
}

export function textFromWorryfree(domains) {
    return textFromOptionDomains(domains, SITE_MODE_OPTIONS.WORRYFREE);
}

/******************************************************************************/

// (11.0.2, audit 11.0.2 finding 5) A pasted web address ("https://www.bbc.com/news") used to be stored as it was: a
// "site" that never matches, with no message. Now the site name is taken out of it; anything that is still not a site
// name is refused. Same rule as every other hostname check (js/util/utils.js isValidHostnamePattern(); '*' = all sites).
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//;

export function hostnameFromAllowListLine(line) {
    let raw = String(line).trim().toLowerCase();
    if ( URL_SCHEME_RE.test(raw) ) {
        try {
            raw = new URL(raw).hostname;
        } catch {
            return '';   // benign: not a web address after all — refused like any other non-site line
        }
    } else {
        raw = raw.split(/[/?#]/)[0].replace(/:\d+$/, '');   // "example.com/path", "example.com:8080"
    }
    const hn = punycode.toASCII(raw);
    return isValidHostnamePattern(hn) ? hn : '';
}

export function siteModesFromText(text, refused = []) {
    const out = {};

    for ( const rawLine of text.split(/\n|\r\n|\r/) ) {
        const trimmed = rawLine.trim();

        // Skip blank lines and comments
        if ( trimmed === '' || trimmed.startsWith('#') ) { continue; }

        // Option lines — a different line shape entirely, extracted
        // separately by extractOptionLinesFromText() before this function
        // ever sees the text (see mode-editor.js). Skipped here defensively
        // too, in case this function is ever called directly on
        // un-pre-filtered text — an option line must never become a
        // no-filtering domain entry.
        if ( isOptionLine(trimmed) ) { continue; }

        // BUG FIX (found while adding $worryfree): a line that STARTS like an
        // option line but does not parse as one — a misspelled option
        // ("@@example.com$worryfre"), or an unknown one — used to fall
        // through to the domain path below, where punycode.toASCII() reduces
        // it to the single character "@". The result was a junk allow-list
        // entry named "@" and, worse, silence: the intended exemption was
        // never applied and nothing said so. Pre-existing (one option could
        // already be misspelled), but a second option makes it likelier.
        // Skipped and logged instead, so the line survives in the editor's
        // text for the person to correct.
        if ( trimmed.startsWith('@@') ) {
            console.warn(`[uBlock-Dynamic] Allow list: ignored "${trimmed}" — not a valid option line. Expected "@@domain$<option>" with one of: ${OPTION_NAMES.join(', ')}.`);
            continue;
        }

        const hn = hostnameFromAllowListLine(trimmed);
        if ( hn === '' ) {
            refused.push(trimmed);
            continue;
        }
        // All listed domains are no-filtering (mode 0)
        out[hn] = 0;
    }

    return out;
}

/******************************************************************************/

export function textFromSiteModes(siteModes) {
    const domains = [];

    for ( const [hn, mode] of Object.entries(siteModes) ) {
        // Only emit domains that are explicitly turned off (mode 0)
        if ( mode !== 0 ) { continue; }
        // Skip the internal sentinel; it has no meaning in the plain list
        if ( hn === 'all-urls' ) { continue; }
        domains.push(punycode.toUnicode(hn));
    }

    domains.sort((a, b) => a.localeCompare(b));
    return domains.length > 0 ? domains.join('\n') + '\n' : '';
}

/******************************************************************************/
