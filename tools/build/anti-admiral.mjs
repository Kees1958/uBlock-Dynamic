// ── tools/build/anti-admiral.mjs ──────────────────────────────────────────────────────
// Anti-Admiral: three-source fetch, format-normalise and domain-level extraction.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: buildAntiAdmiralSourceText, selectAdmiralSiteRules
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import { withRetry, fetchWithTimeout } from '../lib/fetch-with-retry.mjs';
import { applyScriptletTrustGate, fetchList, fetchListText } from './fetch-helpers.mjs';

/******************************************************************************/
// Anti-Admiral — three-source fetch, format-normalize, and domain-level
// dedup. See the FILTER_LISTS entry above for why this exists as a
// dedicated function rather than the ordinary url:[...] array path.
/******************************************************************************/

// Every tunable for this one list lives here, in one place, per this
// project's own "magic values declared once" convention.
const ANTI_ADMIRAL_SOURCES = [
    {
        name:   'HaGeZi ad-shield.txt',
        url:    'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/share/ad-shield.txt',
        // Plain domain-per-line (no ABP syntax at all — this is a DNS-
        // blocklist format, e.g. "example.com", not "||example.com^").
        // Confirmed by inspecting the real file before writing this parser,
        // not assumed from the file extension.
        format: 'plain-domain',
    },
    {
        name:   'EasyList easyprivacy_trackingservers_admiral.txt',
        url:    'https://raw.githubusercontent.com/easylist/easylist/master/easyprivacy/easyprivacy_trackingservers_admiral.txt',
        // Standard ABP network-rule syntax ("||domain^$third-party" etc.),
        // same family as every other easyprivacy_trackingservers_*.txt file.
        format: 'ubo-filter',
    },
    {
        name:   'LanikSJ getadmiral-domains.txt',
        url:    'https://raw.githubusercontent.com/LanikSJ/ubo-filters/master/filters/getadmiral-domains.txt',
        // Standard ABP network-rule syntax ("||domain^"), confirmed against
        // the real file (LanikSJ/ubo-filters ships plain uBO filter lists).
        format: 'ubo-filter',
    },
];

// (2026-11-09, owner's decision) Admiral site rules from uBlock Origin's own lists, so the Anti-Admiral list
// works on its own: per-site page scripts and hide rules whose RULE part (after the ## marker) names Admiral,
// e.g. "cbssports.com##+js(rmnt, script, /admiral/i)". The Admiral DOMAINS those lists (and AdGuard Base) block
// are already all in the three sources above (measured 2026-11-09: every hit was a duplicate), so only site
// rules are taken. AdGuard Base was checked too: it has no Admiral site rules (its only "admiral" lines are for
// the unrelated Croatian betting site admiral.hr, in its foreign section, which is not used here).
const ANTI_ADMIRAL_SITE_RULE_SOURCES = Object.freeze([
    'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2025.txt',
    'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2026.txt',
    'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-others.txt',
]);
// The vendor name as it appears in a rule's own part (scriptlet arguments or selector). Case-insensitive.
const ADMIRAL_RULE_PART_RE = /admiral/i;
// Cosmetic/scriptlet separators, longest first so "#@#" is not read as "#" + "@#".
const SITE_RULE_SEPARATORS = Object.freeze([ '#@#+js(', '##+js(', '#@#', '#?#', '#$#', '##' ]);

// Pure: picks the Admiral site rules out of one list's text. A rule needs a site part (generic rules are not
// taken — owner's rule) and "admiral" in its rule part, not merely in its hostnames or in a comment.
export function selectAdmiralSiteRules(text) {
    const picked = [];
    for ( const raw of text.split('\n') ) {
        const line = raw.trim();
        if ( line === '' || line.startsWith('!') || line.startsWith('[') ) { continue; }
        const sep = SITE_RULE_SEPARATORS.find(m => line.includes(m));
        if ( sep === undefined ) { continue; }
        const at = line.indexOf(sep);
        if ( at <= 0 ) { continue; }   // no site part: a generic rule
        if ( ADMIRAL_RULE_PART_RE.test(line.slice(at + sep.length)) === false ) { continue; }
        picked.push(line);
    }
    return picked;
}

// Matches a bare hostname on its own line: letters/digits/hyphen/dot only,
// nothing else on the line. Anything that doesn't match this (blank lines,
// `#`/`!` comments, anything with a slash or other character) is skipped —
// conservative on purpose: a plain-domain source should never contain
// anything else, so a line that doesn't match is far more likely to be a
// comment or metadata header than a domain this parser mis-read.
const PLAIN_DOMAIN_LINE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// Extracts the bare hostname from a `||hostname^...` / `||hostname^` uBO/ABP
// network rule. Deliberately narrow — only the pure-hostname shape this
// dedup step cares about; anything with a path, regex, or non-hostname
// pattern is left as `null` and passed through unmerged (see below), not
// force-fit into this extractor.
const UBO_HOSTNAME_RULE_RE = /^\|\|([a-z0-9.-]+)\^(?:\$.*)?$/i;

function extractDomainFromLine(line, format) {
    const t = line.trim();
    if ( t === '' ) { return null; }
    if ( format === 'plain-domain' ) {
        if ( t.startsWith('#') || t.startsWith('!') ) { return null; }
        return PLAIN_DOMAIN_LINE_RE.test(t) ? t.toLowerCase() : null;
    }
    // format === 'ubo-filter'
    if ( t.startsWith('!') || t.startsWith('[') ) { return null; }
    const m = UBO_HOSTNAME_RULE_RE.exec(t);
    return m ? m[1].toLowerCase() : null;
}

// Plain-domain-list fetch — same network/size safety posture as fetchList()
// above, but validated against the format this source actually uses (no
// `!`/`||`/`##` markers ever appear in a pure domain-per-line file, so
// fetchList()'s own filter-list-shape guard would always reject it; this
// is a format-appropriate replacement, not a bypass of that guard).
// Wrapped in withRetry() — timeout + one retry (tools/lib/fetch-with-retry.mjs).
// The whole attempt, validation included, is retried.
async function fetchPlainDomainList(url) {
    return withRetry(`domain list ${url}`, signal => fetchPlainDomainListOnce(url, signal));
}

async function fetchPlainDomainListOnce(url, signal) {
    const resp = await fetchWithTimeout(url, signal);
    const text = await resp.text();
    if ( text.length < 20 ) {
        throw new Error(`Suspiciously small response (${text.length} bytes) from ${url}`);
    }
    const sampleLines = text.split('\n').slice(0, 50).map(l => l.trim()).filter(l => l !== '');
    const domainLikeCount = sampleLines.filter(l => PLAIN_DOMAIN_LINE_RE.test(l)).length;
    if ( sampleLines.length === 0 || domainLikeCount / sampleLines.length < 0.5 ) {
        throw new Error(`Response from ${url} does not look like a plain domain list — aborting`);
    }
    return text;
}

export async function buildAntiAdmiralSourceText() {
    const seenDomains = new Set(); // INIT guard — fresh Set every build run
    const perSourceCounts = [];

    for ( const src of ANTI_ADMIRAL_SOURCES ) {
        const text = src.format === 'plain-domain'
            ? await fetchPlainDomainList(src.url)
            : await fetchList(src.url);
        const before = seenDomains.size;
        let extracted = 0;
        for ( const line of text.split('\n') ) {
            const domain = extractDomainFromLine(line, src.format);
            if ( domain === null ) { continue; }
            extracted++;
            seenDomains.add(domain); // Set — duplicate domains across all
                                      // three sources collapse automatically,
                                      // this IS the dedup step.
        }
        perSourceCounts.push({ name: src.name, extracted, newDomains: seenDomains.size - before });
    }

    process.stdout.write(
        `[${perSourceCounts.map(c => `${c.name}: ${c.extracted} lines, ${c.newDomains} new`).join(' | ')}] `
    );
    process.stdout.write(`(deduplicated to ${seenDomains.size} unique domains) `);

    // Admiral site rules from uBO's own lists (see ANTI_ADMIRAL_SITE_RULE_SOURCES). Same download guards as every
    // list (fetchListText); the scriptlet trust gate runs on the SELECTED lines only, so its report names only rules
    // this list would actually have used. A Set drops duplicates across files. The CrUX top-1M limit for these site
    // rules is applied later in the build, by this list's popularityFilter (filter-lists.mjs).
    const siteRules = new Set();   // INIT guard — fresh every build run
    for ( const url of ANTI_ADMIRAL_SITE_RULE_SOURCES ) {
        const selected = selectAdmiralSiteRules(await fetchListText(url)).join('\n');
        for ( const rule of applyScriptletTrustGate(url, selected).split('\n') ) {
            if ( rule !== '' ) { siteRules.add(rule); }
        }
    }
    process.stdout.write(`(+${siteRules.size} uBlock Origin Admiral site rules) `);

    // RELEASE guard — the Set itself goes out of scope when this function
    // returns; nothing to explicitly clear. Emit as standard "||domain^"
    // ABP syntax so the shared parseList()/DNR-compile/coalesce pipeline
    // below (same one every other FILTER_LISTS entry uses) picks it up
    // exactly like any other hostname-block source — no separate output
    // path, no separate ruleset-details.json handling to maintain.
    return [
        ...[ ...seenDomains ].sort().map(d => `||${d}^`),
        '!------------------ Admiral site rules: uBlockOrigin/uAssets ------------------!',
        ...[ ...siteRules ].sort(),
    ].join('\n');
}

