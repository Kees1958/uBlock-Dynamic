// ── tools/build/worry-free-extra-lists.mjs ────────────────────────────────────────────
// Worry-free extra blocklist sources: simple-rule-only extraction and the source texts for the extra lists.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: ADGUARD_TRACKING_SERVERS_SOURCE, EASYLIST_ADULT_SPECIFIC_SOURCE, HAGEZI_LIGHT_SOURCE, PETERLOWE_SOURCE, buildWorryFreeLists
// (10.3.0: buildScpPrivacyBlockRule/buildScpSecurityBlockRule removed with the two SCP header rulesets.)
// (AdShield Evolution rename pass: buildWorryFree3pBlockRule,
// buildWorryFreeDownloadBlockRule, buildWorryFreeDownloadTldAllowRules,
// buildWorryFreeTldAllowRules removed from this list — see the RETIRED
// comment where they used to be declared, below. Editable familiar-TLD
// feature: buildScpPrivacyTldAllowRules/buildScpSecurityTldAllowRules
// removed too — converted to dynamic DNR rules; see the RETIRED comment
// where THEY used to be declared. buildSafeRegionTldExcludeMatchesFile
// renamed to buildExemptDomainsGeneratedFile — see that function's own
// header comment for why.)
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import { withRetry, fetchWithTimeout } from '../lib/fetch-with-retry.mjs';
import { fetchList } from './fetch-helpers.mjs';

/******************************************************************************/
// Worry-free extra blocklist sources — simple-rule-only extraction,
// TLD-scope filter, and bare/third-party-aware dedup, shared by
// buildWorryFreeLists() below. See the FILTER_LISTS entries above
// (ruleset_adguard_tracking_servers, ruleset_easylist_adservers,
// ruleset_peterlowe) — NOT ruleset_disconnect_other (removed 10.7.1), despite an earlier
// version of this comment saying so: Disconnect never went through this
// function, it has its own separate customFetch with no TLD-scoping at
// all (confirmed while renaming this function, per explicit request —
// "all of the filters I mentioned should NOT be touched and used AS-IS",
// meaning Disconnect stays exactly as it already was, not extended to
// use this mechanism too).
/******************************************************************************/

// Only the exact "simple" shape this list wants: bare ||domain^ or
// ||domain^$third-party, nothing else (no other modifiers, no paths, no
// regex, no exceptions). Anything else is silently skipped — conservative
// on purpose, matching the person's own explicit scoping instruction.
const WORRY_FREE_SIMPLE_RULE_RE = /^\|\|([a-z0-9.-]+)\^(\$third-party)?$/i;
// ── Extended rule shapes, opt-in per source via `keepPathAndSubdocument` ──
// buildWorryFreeLists() was domain-only: it keeps `||domain^` (optionally
// $third-party) and silently skips everything else. That is the right
// filter for a pure ad-SERVER list, but it throws away 85% of a
// SITE-SPECIFIC list, where most rules carry a path. Measured on
// easylist_adult/adult_specific_block.txt: 104 of 677 rules kept
// domain-only, versus 502 of 677 with the two shapes below.
//
// Both emit plain ABP text, which the normal parseBlockRule() pipeline
// then translates — paths become urlFilter, $subdocument becomes the
// sub_frame resource type (the shared parser, js/core/ubo-parser.js). Nothing new downstream.
//
// 1. ||host/path  — no options at all. The host may carry a wildcard
//    (`||123av.*/assets/ad/`), which DNR's urlFilter supports.
const WORRY_FREE_PATH_RULE_RE = /^\|\|([a-z0-9.*-]+)(\/[^$]*)$/i;
// 2. ||host^$subdocument or ||host/path$subdocument, with an optional
//    third-party/~third-party alongside it. The party modifier is
//    PRESERVED verbatim in the emitted line rather than dropped:
//    "~third-party" means first-party only, and emitting a bare
//    $subdocument instead would silently BROADEN the rule to block
//    third-party frames the author deliberately left alone.
const WORRY_FREE_SUBDOC_RULE_RE = /^\|\|([a-z0-9.*-]+)(\^|\/[^$]*)\$((?:~?third-party,)?subdocument(?:,~?third-party)?)$/i;

// Hosts-file format ("127.0.0.1 domain" or "0.0.0.0 domain") — Peter
// Lowe's list's own format (v8.3.15). Always a bare/unconditional block
// (hosts files have no concept of a "$third-party" modifier), so lines
// matching this feed the same 'bare' bucket WORRY_FREE_SIMPLE_RULE_RE's
// unconditional matches do.
const WORRY_FREE_HOSTS_LINE_RE = /^(?:127\.0\.0\.1|0\.0\.0\.0)\s+([a-z0-9.-]+)$/i;

// Scope (10.0.7, explicit request: remove the jurisdiction restriction entirely).
// The four TLD sets that used to gate which source domains were kept (generic, 5 Eyes, EU,
// extended EU) and the worryFreeTld() helper are RETIRED: every domain is in scope except IP
// literals (unrelated to jurisdiction — a hosts-style IP can never be a DNR requestDomain).
// (GENERIC_TLDS, js/data/generic-tlds.js, was removed in 10.3.0 with the runtime "familiar TLDs" list.)
function isIpLiteral(domain) {
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(domain);
}
function worryFreeInScope(domain) {
    return !isIpLiteral(domain);
}

// Hosts-format fetch — same safety posture as fetchList()/
// fetchPlainDomainList() above, validated against what this format
// actually looks like ("127.0.0.1 domain" per line — no "!"/"||"/"##"
// ever appears, so fetchList()'s own guard would always reject it).
// Wrapped in withRetry() — timeout + one retry (tools/lib/fetch-with-retry.mjs).
// The whole attempt, validation included, is retried.
async function fetchHostsFormatList(url) {
    return withRetry(`hosts list ${url}`, signal => fetchHostsFormatListOnce(url, signal));
}

async function fetchHostsFormatListOnce(url, signal) {
    const resp = await fetchWithTimeout(url, signal);
    const text = await resp.text();
    if ( text.length < 20 ) {
        throw new Error(`Suspiciously small response (${text.length} bytes) from ${url}`);
    }
    const sampleLines = text.split('\n').slice(0, 50).map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'));
    const hostsLikeCount = sampleLines.filter(l => WORRY_FREE_HOSTS_LINE_RE.test(l)).length;
    if ( sampleLines.length === 0 || hostsLikeCount / sampleLines.length < 0.5 ) {
        throw new Error(`Response from ${url} does not look like a hosts-format list — aborting`);
    }
    return text;
}

// Single-source variant of the merge logic that used to live in
// buildWorryFreeExtraBlocklistSourceText() (RETIRED, v9.1.7 — see below)
// — same fetch/marker/format/TLD-scope treatment, for exactly one
// source, used by AdGuard tracking servers, EasyList advertising
// servers, and Peter Lowe's so each can be toggled on its own.
//
// RENAMED (this release) from buildSingleSourceBlocklistText — per
// explicit request: "there is no singleSourceBlock list anymore" (the
// extraUrl merge added earlier this session means it can already combine
// two sources, so "single source" was already inaccurate) — a name
// describing WHAT this feeds (the Worry-free-gated lists) rather than an
// implementation detail that stopped being true. Pure rename — no
// behavior change, same fetch/TLD-scope/dedup logic as before.
export async function buildWorryFreeLists(src) {
    const fullText = src.format === 'hosts'
        ? await fetchHostsFormatList(src.url)
        : await fetchList(src.url);
    const text = src.startMarker
        ? fullText.slice(fullText.indexOf(src.startMarker))
        : fullText;
    if ( src.startMarker && text === fullText ) {
        throw new Error(`buildWorryFreeLists: marker "${src.startMarker}" not found in ${src.url} — source format may have changed, aborting rather than silently using the whole file.`);
    }

    // Guard (10.0.5): this function only ever recognizes domain/hosts/
    // path/subdocument-shaped lines below — it has no cosmetic (##/#@#)
    // or scriptlet (#%#/+js()) parsing path at all, by design (these are
    // meant to be pure network-rule sources). A line of either syntax
    // doesn't match any of the regexes below, so it would otherwise just
    // silently vanish with no log entry and no error. Checked directly
    // against all 5 real upstream sources this function is used for
    // (EasyList adult_specific_block.txt, easylist_thirdparty.txt,
    // AdGuard tracking_servers.txt, Peter Lowe's list, HaGeZi Multi
    // light) — none currently contain either syntax. Same "abort rather
    // than silently drop" posture as the startMarker guard just above,
    // for the same reason: if that ever changes upstream, this must fail
    // the build loudly, not quietly ship fewer rules than the source
    // actually has.
    if ( src.format !== 'hosts' ) {
        const cosmeticOrScriptlet = /##|#@#|#\?#|#@\?#|#%#|\+js\(/;
        for ( const line of text.split('\n') ) {
            if ( cosmeticOrScriptlet.test(line.trim()) ) {
                throw new Error(`buildWorryFreeLists: ${src.url} contains cosmetic/scriptlet syntax this function cannot parse — it would be silently dropped. First offending line: ${JSON.stringify(line.trim().slice(0, 120))}`);
            }
        }
    }

    // Optional second source, folded into the same merged output before
    // parsing — same dedup/scope logic below then applies uniformly to
    // both. Always ABP-syntax (fetchList(), never the hosts-format path)
    // — no current extraUrl use case needs that combination.
    const combinedText = src.extraUrl
        ? `${text}\n${await fetchList(src.extraUrl)}`
        : text;

    const merged = new Map();
    // Extended shapes (opt-in per source) are kept as VERBATIM ABP lines,
    // separate from the domain map: they are not domains, so they cannot
    // participate in its bare-vs-third-party merge. De-duplicated by line.
    const extraLines = new Set();
    let pathKept = 0, subdocKept = 0, outOfScopeExtra = 0;
    for ( const line of combinedText.split('\n') ) {
        const trimmed = line.trim();
        let domain, thirdPartyOnly;
        if ( src.format === 'hosts' ) {
            const hm = WORRY_FREE_HOSTS_LINE_RE.exec(trimmed);
            if ( hm === null ) { continue; }
            domain = hm[1].toLowerCase();
            thirdPartyOnly = false;
        } else {
            const m = WORRY_FREE_SIMPLE_RULE_RE.exec(trimmed);
            if ( m === null ) {
                // Not the domain-only shape. For sources that opted in, try
                // the two extended shapes before giving up on the line.
                if ( src.keepPathAndSubdocument !== true ) { continue; }
                const sub = WORRY_FREE_SUBDOC_RULE_RE.exec(trimmed);
                const pth = sub === null ? WORRY_FREE_PATH_RULE_RE.exec(trimmed) : null;
                const host = (sub ?? pth)?.[1];
                if ( host === undefined ) { continue; }
                // Same country-code scoping as the domain path above. A
                // wildcard TLD (`123av.*`) has no knowable ccTLD, so it is
                // kept — worryFreeInScope() would reject it outright.
                if ( host.endsWith('.*') === false && !worryFreeInScope(host.toLowerCase()) ) {
                    outOfScopeExtra += 1;
                    continue;
                }
                extraLines.add(trimmed);
                if ( sub !== null ) { subdocKept += 1; } else { pathKept += 1; }
                continue;
            }
            domain = m[1].toLowerCase();
            thirdPartyOnly = m[2] !== undefined;
        }
        if ( !worryFreeInScope(domain) ) { continue; }
        const existing = merged.get(domain);
        if ( existing === undefined ) {
            merged.set(domain, thirdPartyOnly ? 'thirdParty' : 'bare');
        } else if ( existing === 'thirdParty' && !thirdPartyOnly ) {
            merged.set(domain, 'bare');
        }
    }

    // thirdPartyOnly source flag (10.1.1): force every domain to a `$third-party` block, whatever the
    // upstream wrote. Sources that opt in are blocked only when requested BY another site, never when
    // the domain itself is the page being visited (main_frame) or its own first-party traffic.
    if ( src.thirdPartyOnly === true ) {
        for ( const domain of merged.keys() ) { merged.set(domain, 'thirdParty'); }
    }

    let bareCount = 0, thirdPartyCount = 0;
    const lines = [];
    for ( const [ domain, kind ] of merged ) {
        if ( kind === 'bare' ) { bareCount++; lines.push(`||${domain}^`); }
        else { thirdPartyCount++; lines.push(`||${domain}^$third-party`); }
    }
    lines.sort();
    if ( src.keepPathAndSubdocument === true ) {
        process.stdout.write(`(${merged.size} domain: ${bareCount} bare, ${thirdPartyCount} third-party; ` +
            `${pathKept} path, ${subdocKept} subdocument; ${outOfScopeExtra} extra out-of-scope) `);
        lines.push(...[ ...extraLines ].sort());
    } else {
        process.stdout.write(`(${merged.size} unique in-scope: ${bareCount} bare, ${thirdPartyCount} third-party) `);
    }
    return lines.join('\n');
}

// Standalone source definitions for the three now-independently-
// selectable entries below — extracted out of WORRY_FREE_EXTRA_SOURCES
// (which they used to live in) so each can be its own FILTER_LISTS entry.
export const ADGUARD_TRACKING_SERVERS_SOURCE = {
    name: 'AdGuard tracking servers',
    url:  'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/SpywareFilter/sections/tracking_servers.txt',
    startMarker: null,
    thirdPartyOnly: true,   // 10.1.1 — third-party blocks only (was: bare + third-party mix)
};
// Peter Lowe's Ad and tracking server list — hosts format (`127.0.0.1 domain`), single source.
// Restored in 10.1.1 as a Worry-free opt-in (retired in 10.0.7 as largely redundant with HaGeZi
// Multi light; brought back per explicit request). Fetched through uBlockOrigin/uAssets, the same
// mirror this project used before. Needs format:'hosts' — see fetchHostsFormatList().
export const PETERLOWE_SOURCE = {
    name: "Peter Lowe's Ad and tracking server list",
    url:  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/thirdparties/pgl.yoyo.org/as/serverlist',
    format: 'hosts',
    thirdPartyOnly: true,   // 10.1.1 — third-party blocks only
};
// Added this release. Both opt into keepPathAndSubdocument: they are
// SITE-SPECIFIC lists, where the domain-only filter would discard most of
// the file (measured: adult_specific_block 104/677 kept domain-only vs
// 502/677 with paths + subdocument).
//
// EasyList's own general easylist_adservers.txt was CONSIDERED AND DROPPED
// (explicit decision): after country-code filtering it still adds 28,275
// rules, which would take the enabled-static-rule total to 40,299 —
// 10,299 over Chrome's 30,000 guaranteed-enabled cap. Not a parsing
// problem, a budget one; revisit only with an overlap analysis against
// AdGuard Base / HaGeZi / Peter Lowe's, which likely already cover much
// of it.
export const EASYLIST_ADULT_SPECIFIC_SOURCE = {
    name: 'EasyList easylist_adult/adult_specific_block.txt',
    url:  'https://raw.githubusercontent.com/easylist/easylist/master/easylist_adult/adult_specific_block.txt',
    keepPathAndSubdocument: true,
};

// HaGeZi's Multi LIGHT — ABP-syntax (`||domain^`), single source, no
// startMarker. Consumed (10.5.5: through hagezi-light-selection.mjs) by the ruleset_hagezi_light
// FILTER_LISTS entry, which is a normal default list, NOT a Worry-free-gated one — it
// only borrows this function's fetch/TLD-scope/dedup logic (C21). The
// function's name still says "WorryFree" for historical reasons (it was
// written for the Worry-free lists); a rename was deliberately not folded
// into this change to keep it minimal.
// (10.5.2–10.5.4) Chris Buijs' TOP-N version was used instead. (10.5.5, owner's decision) Back to HaGeZi's own
// full `adblock/light.txt`; which entries ship is now decided by tools/build/hagezi-light-selection.mjs
// (Tracker Radar, CrUX top sites, top-25 adult sites, HTTP Archive), which calls buildWorryFreeLists() with this.
export const HAGEZI_LIGHT_SOURCE = {
    name: "HaGeZi's Multi LIGHT",
    url:  'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/light.txt',
    startMarker: null,
};

// RETIRED (v9.1.7) — buildWorryFreeExtraBlocklistSourceText() removed
// entirely along with ruleset_worryfree_extra (its only caller, in
// FILTER_LISTS above) — the "adult-site ad servers + transcend.io"
// blocklist and its underlying five/one-source merge machinery are gone,
// per explicit request, not rescoped.

// (Editable familiar-TLD feature) worryFreeAllSafeTlds() REMOVED — its
// only callers were the two TLD-allow rule builders this pass converted
// to dynamic DNR rules (js/core/worry-free-familiar-tld-manager.js's own
// buildTldAllowRules(), which reads the person's live, editable list
// instead), and the generated-file builder this pass trimmed down to
// just its two unrelated domain lists. (10.0.7: the four jurisdiction TLD
// sets worryFreeInScope() used to read were retired — see its comment.)

// safeRegionTldUrlFilter(tld) — `||<tld>^`, the one DNR expression of "this host ends in
// this TLD" — moved to js/data/safe-region-url-filter.js in v9.7.0 (shared with the
// runtime advanced-tier rules); imported at the top of this file. See that file for
// the full account of the v9.6.9 bug it replaced.

// BUG FIX (blockScpFingerprint TLD-scoping): the fingerprint mitigation
// (sec-scp-fingerprint, loads sec-adult-fingerprint.js) is registered as
// a content script (browser.scripting.registerContentScripts()), not a
// DNR rule — so unlike its three siblings (SCP privacy, SCP security,
// Worry-free 3P/download block), which get their "outside safe regions"
// scoping for free from a static TLD-allow DNR ruleset pair generated
// elsewhere in this file, this one needs the safe-region TLD list
// available at RUNTIME, as content-script excludeMatches patterns —
// worryFreeAllSafeTlds() itself only exists in this build-time file.
//
// Generated once per build into js/generated/ (same convention as
// custom-scriptlets-dispatch.mjs above — a build-time-computed static
// data file, not a duplicated copy of the TLD list hand-maintained a
// second time in runtime code, which would drift from this one the
// moment either changed — see B15). js/core/compiled-filters.js imports
// this and wires it into SECURITY_SCRIPTLET_BUILTIN_EXCLUDES.
//
// Pattern shape: Chrome content-script match patterns support a bare
// `*.tld` host (matches the TLD itself and any subdomain under it) —
// verified against Chrome's own match-pattern syntax, not assumed; this
// is the exact same "does this host's TLD count as safe" question the
// DNR safeRegionTldUrlFilter() (`||tld^`) above answers, just expressed in the
// different pattern language browser.scripting requires.
// (10.2.0) buildExemptDomainsGeneratedFile() REMOVED — it wrote js/generated/exempt-domains-generated.mjs
// (SAFE_REGION_EXEMPT_DOMAINS, WORRYFREE_EXEMPT_DOMAINS) from the quick-fixes list's "$saferegions" /
// "$worryfree" lines. Those now ship as carrier allow rules inside the quick-fixes ruleset
// (js/core/builtin-exemption-carriers.js), so a change to them is a SAFE (skip-review) update.

// (AdShield Evolution rename pass) RETIRED — buildWorryFree3pBlockRule(),
// buildWorryFreeTldAllowRules(), buildWorryFreeDownloadBlockRule(), and
// buildWorryFreeDownloadTldAllowRules() all removed together: all four
// fed blockScpTldBlock ("Block third-party scripts, frames and downloads
// outside safer regions"), removed entirely per explicit request — see
// CHANGELOG_HISTORY.md for the full entry and dnr-budgets.js's own
// retirement comments for the ids/priorities this freed up.

// (10.3.0) buildScpPrivacyBlockRule() / buildScpSecurityBlockRule() — the Low group's two Permissions-Policy
// header rules — REMOVED with the Privacy & Security extra protections (moved to 3P-Matrix).
