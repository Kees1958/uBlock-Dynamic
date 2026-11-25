// ── tools/build/rule-parsers.mjs ──────────────────────────────────────────────────────
// Filter-rule parsing: resource-type mapping, $option parser, URL pattern -> urlFilter, block/allow rules, $removeparam.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: parseBlockRule, parseRemoveparamRules
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import { SITE_MODE_OPTIONS, RETIRED_SITE_MODE_OPTIONS } from '../../js/util/site-mode-parser.js';
import { STATIC_EXCEPTION_PRIORITY_OFFSET, STATIC_FILTER_LIST_PRIORITY, STATIC_IMPORTANT_PRIORITY_OFFSET, STATIC_REDIRECT_PRIORITY_OFFSET } from '../../js/core/dnr-budgets.js';
import { droppedWildcardDomains, expandedWildcardDomains, topSitesSet } from './build-state.mjs';
import { topSiteDomainsByName } from './crux-top-sites.mjs';
import { isTLDKept } from './tld-scope.mjs';
// (10.7.6) ONE PARSER — network lines are translated by the same parser the extension's ABP-import editor uses
// (js/offscreen/compile-filters.js): the AST parser plus parseNetworkFilter(). This file keeps only the BUILD's
// own decisions around it (badfilter / exemption lines, wildcard sites, which rule kinds a static list ships).
import * as sfp from '../../js/core/static-filtering-parser.js';
import { isImportantPriority, normalizeAbpNetworkLine, parseNetworkFilter } from '../../js/core/ubo-parser.js';

/******************************************************************************/
// Resource types and option decisions
/******************************************************************************/

// The request types a static list may name. "$all" (10.7.2) expands to this list in the shared parser — the
// PAGE itself included ('main_frame': a tab or popup window loading that address); Chrome's DNR never applies
// a rule to a top-level page unless 'main_frame' is listed (e.g. AdGuard Base's "||s.pemsrv.com^$all").
const ALL_RESOURCE_TYPES = [
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
    'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
];

// Option decisions now made ONCE, in the shared parser (js/core/ubo-parser.js parseNetworkFilter), for the build
// and the ABP import alike (10.7.6):
//   - page-only options (generichide/ghide, genericblock, specifichide/shide, elemhide/ehide, inline-script,
//     inline-font, webrtc) DROP the line (10.7.3): ignoring one BROADENED the rule — e.g. AdGuard's
//     "@@||bing.com^$generichide" became a full ALLOW of every bing.com host (bat.bing.com let through);
//   - $popup / $popunder DROP the line (9.2.8, docs popup-popunder-abp-import-voorstel.md Part 4): DNR cannot
//     tell a popup from a normal link click;
//   - unknown options and $requestheader DROP the line (10.7.6): ignoring them broadened the rule too;
//   - "~third-party" maps to first-party and vice versa (DNR domainType), never ignored.

// Every cosmetic / scriptlet / CSS marker AdGuard and uBO use between a line's site part and its body:
//   ##  #?#  #$#  #%#  #$?#            hide, procedural, CSS inject, JS scriptlet, CSS-inject procedural
//   #@#  #@?#  #@$#  #@%#  #@$?#       the same five as EXCEPTIONS
// A line carrying one is never a network rule (parseCosmeticRules / scriptlet steps handle it, or it is
// unsupported). (10.7.3) Was /#[@$?%]?#/ — one character between the hashes only — so the two-character
// exception markers (#@?#, #@$#, #@%#) slipped through and compiled as URL block rules that can never
// match (11 in the 10.7.2 build, e.g. "chatgpt.com#@?#[class|="border-"]:contains(Ad)").
const COSMETIC_MARKER_RE = /#@?(?:\$\?|[$?%])?#/;



// Pure-ish (one side effect: pushes to the module-scope report accumulators; one read of the module-scope
// `topSitesSet`, populated once per build — see fetchTopSitesSet()) — given one side ($domain= include list, or its ~
// negated exclude list) of a $domain= modifier's tokens, returns the tokens valid for DNR's
// initiatorDomains/excludedInitiatorDomains (literal hostnames only). A concrete token passes through unchanged. An
// ABP/uBO "example.*" TLD-wildcard token becomes every in-scope domain named "example" in the CrUX top-1M snapshot
// (topSiteDomainsByName(), option C, 10.7.8 — before: 33 guessed TLDs, each checked against the snapshot). Nothing is
// invented: every name added is a site Chrome users visit. If nothing is found the token is dropped and reported
// (droppedWildcardDomains); otherwise the domains are kept and reported (expandedWildcardDomains). Result deduped.
function resolveWildcardDomainTokens(tokens, context) {
    const out = [];
    const byName = topSitesSet ? topSiteDomainsByName(topSitesSet) : null;
    for ( const token of tokens ) {
        if ( !token.endsWith('.*') ) { out.push(token); continue; }
        const found = byName?.get(token.slice(0, -2));
        const confirmed = found ? [ ...found ].filter(d => isTLDKept(d)).sort() : [];
        if ( confirmed.length > 0 ) {
            out.push(...confirmed);
            expandedWildcardDomains.push({ list: context?.listName ?? '(unknown list)', line: context?.line ?? token, token, confirmed });
        } else {
            droppedWildcardDomains.push({ list: context?.listName ?? '(unknown list)', line: context?.line ?? token, token });
        }
    }
    return [ ...new Set(out) ];
}

/******************************************************************************/
// Block / allow rule parser
/******************************************************************************/

// Per-site exemption options a list line may carry ("@@domain$<option>"), and the flag each one returns.
// Keyed from SITE_MODE_OPTIONS so this list cannot drift from the Allow list editor's own (one source of
// truth); tools/check-exemption-channels.mjs fails if an option there is missing here.
// (11.0.2) The only rule action a Bad filter fixes line can cancel exactly, by
// becoming an allow of the same condition. See parseBlockRule() case 2.
const BADFILTER_CANCELLABLE_ACTION = 'block';

// Report text for a Bad filter fixes line aimed at a rule with another action.
function badfilterNotBlockReason(actionType) {
    return `$badfilter for a "${actionType ?? 'unknown'}" rule: an allow rule would cancel more than that one rule (11.0.2)`;
}

const EXEMPT_OPTION_FLAGS = Object.freeze({
    [SITE_MODE_OPTIONS.WORRYFREE]:   'worryfreeExempt',
});

// (11.1.3) The step a compiled rule takes above its list's own priority — see STATIC_*_PRIORITY_OFFSET.
const STATIC_EXCEPTION_ACTION_TYPES = Object.freeze([ 'allow', 'allowAllRequests' ]);
function staticPriorityOffset(action, important) {
    if ( important ) { return STATIC_IMPORTANT_PRIORITY_OFFSET; }
    if ( STATIC_EXCEPTION_ACTION_TYPES.includes(action?.type) ) { return STATIC_EXCEPTION_PRIORITY_OFFSET; }
    if ( action?.type === 'redirect' ) { return STATIC_REDIRECT_PRIORITY_OFFSET; }
    return 0;
}

export function parseBlockRule(line, id, priority = STATIC_FILTER_LIST_PRIORITY, options = {}) {
    const t = line.trim();
    if ( !t || t.startsWith('!') || t.startsWith('#') || t.startsWith('[') ) { return null; }
    // Skip cosmetic, scriptlet and response-header rules.
    // AdGuard uses several markers beyond basic ABP ones:
    //   ##  #@#  #?#  #$#  basic cosmetic / exception / procedural / CSS inject
    //   #%# AdGuard JS scriptlet (e.g. #%#//scriptlet(...))
    //   #$## #?## #@## #$?# #$?## composite markers
    if ( COSMETIC_MARKER_RE.test(t) ) { return null; }
    // (10.7.6) removeparam lines belong to parseRemoveparamRules() wherever the option stands in the list.
    // Only "$removeparam" (first option) used to be recognised: "$xhr,removeparam=…" fell through and was
    // compiled as a BLOCK of the whole request (shipped e.g. for Prime Video's playback API).
    if ( hasRemoveparamOption(t) ) { return null; }

    const isException = t.startsWith('@@');
    const raw = isException ? t.slice(2) : t;

    let pattern, optStr = '';
    if ( raw.startsWith('/') ) {
        // Regex pattern: /regex/$options
        // Find the FIRST occurrence of /$ (closing slash + option separator).
        // We cannot use lastIndexOf('/') because $options may contain sub-patterns
        // like header=etag:/^value$/ which have their own slashes and dollar signs.
        const closingSeq = raw.indexOf('/$', 1);
        if ( closingSeq !== -1 ) {
            pattern = raw.slice(0, closingSeq + 1);  // include closing /
            optStr  = raw.slice(closingSeq + 2);       // skip /$
        } else if ( raw.endsWith('/') && raw.length > 1 ) {
            pattern = raw;  // bare /regex/ with no options
        } else {
            // BUG FIX (found via a real report — a genuine, live AdGuard
            // Base rule, "@@/videos/*$domain=pornhub.com|pornhub.org|
            // pornhub.net", compiled with the literal text
            // "$domain=pornhub.com|..." baked straight into urlFilter,
            // making the rule permanently unable to match any real URL —
            // silently broken, not dropped, not erroring). raw.startsWith
            // ('/') is only a valid signal for TRUE ABP/uBO regex syntax
            // when the pattern is genuinely delimited by a matching
            // closing '/' (either right before "$options" or at the very
            // end) — neither matched here, meaning this was never a
            // regex at all, just an ordinary plain path pattern that
            // happens to start with a literal '/' (a normal, common,
            // valid ABP/uBO shape: "match this path substring on any
            // domain", scoped down by $domain= like any other plain
            // rule). The OLD code assumed "doesn't fit either regex
            // shape" meant "malformed, use the whole string as-is" — but
            // that's wrong for exactly this common case. Correct
            // handling: fall back to the SAME plain, non-regex
            // '$'-splitting logic the `else` branch below already uses
            // for every pattern that doesn't start with '/' at all —
            // there's nothing regex-specific left to do once we know
            // this isn't really a regex.
            const dollarPos = raw.lastIndexOf('$');
            if ( dollarPos !== -1 ) { pattern = raw.slice(0, dollarPos); optStr = raw.slice(dollarPos + 1); }
            else { pattern = raw; }
        }
    } else {
        const dollarPos = raw.lastIndexOf('$');
        if ( dollarPos !== -1 ) { pattern = raw.slice(0, dollarPos); optStr = raw.slice(dollarPos + 1); }
        else { pattern = raw; }
    }
    if ( !pattern ) { return null; }

    // $badfilter — checked BEFORE parseOptions() (which silently no-ops on
    // it, see that function's own option list) so both branches below can
    // key off it. A badfilter line's whole purpose is to CANCEL another
    // rule, not to become one itself — until this check existed, that
    // distinction was lost entirely and a line like
    // "||annoying-ads.com^$badfilter" silently compiled into an ordinary
    // BLOCK rule for that domain, the exact opposite of its intent.
    const optNames = optStr ? optStr.split(',').map(o => o.replace(/^~/, '')) : [];
    const isBadfilter = optNames.includes('badfilter');

    // $saferegions (item 2) — checked BEFORE parseOptions() for the exact
    // same reason $badfilter is: 'saferegions' is not a real ABP/uBO
    // option, so parseOptions() would silently drop the whole line via
    // its own unrecognized-option fallthrough (see that function's final
    // `return null`). Deliberately kept as its own distinct branch, not
    // folded into the $badfilter handling above — a $saferegions line
    // produces no DNR rule of its own at all (unlike $badfilter, which
    // either cancels one or becomes an allow rule); it only ever feeds a
    // domain into SAFE_REGION_TLD_EXCLUDE_MATCHES and the per-domain
    // Worry-free TLD-allow rule set — see applySaferegionsExemptions()
    // and buildWorryFreeTldAllowRules() below.
    //
    // $worryfree (10.0.0) -- the SAME shape, handled by the same branch (B15: one implementation, not a
    // parallel copy): "@@domain$worryfree" in a list is a built-in per-site exemption from Worry-free
    // altogether (the extra filter lists and every protection), exactly what the person gets by typing the
    // line in the Allow list tab. Like $saferegions it compiles to NO DNR rule here: the domain is collected
    // and (10.2.0) shipped as one carrier allow rule in the quick-fixes ruleset (build-steps.mjs,
    // js/core/builtin-exemption-carriers.js), read back and merged into the runtime list by
    // js/core/exempt-domains.js. Before 10.0.0 such a line was silently dropped here (the
    // unrecognised-option fallthrough below), while its tooltips already promised it worked.
    //
    // RETIRED options (10.3.0 — "$saferegions", util/site-mode-parser.js RETIRED_SITE_MODE_OPTIONS): still
    // RECOGNISED here, so the line is neither compiled nor silently lost — it is returned as
    // ignoredRetiredOption and list-parser.mjs records it in dropped-unsupported-list-lines.txt.
    const retiredOption = RETIRED_SITE_MODE_OPTIONS.find(option => optNames.includes(option));
    if ( retiredOption !== undefined ) {
        return { ignoredRetiredOption: retiredOption, line: t };
    }
    const exemptOption = Object.entries(EXEMPT_OPTION_FLAGS).find(([ option ]) => optNames.includes(option));
    if ( exemptOption !== undefined ) {
        if ( !isException ) { return null; } // must be @@domain$<option>, not a bare block
        const domain = pattern.replace(/^\|\|/, '').replace(/\^$/, '');
        if ( !domain ) { return null; }
        return { [exemptOption[1]]: true, domain, line: t };
    }

    if ( isBadfilter && !options.convertBadfilterToAllow ) {
        // Case 1 (every regular filter list) — per explicit request: never
        // auto-apply a third-party list's own badfilter directive (no
        // same-build cross-referencing against other parsed rules, unlike
        // AdGuard's tsurlfilter). Drop it — compile nothing for this line
        // — and hand the raw text back so the caller can record it in
        // dropped-badfilters.txt for manual review instead.
        return { droppedBadfilter: true, line: t };
    }

    // Wildcard sites ("domain=site.*") are resolved here, as before (CrUX-confirmed TLDs only); the line is
    // then rewritten with the concrete sites so the shared parser sees plain hostnames.
    const rewrittenOptStr = rewriteWildcardDomainOptions(optStr, { listName: options.listName, line: t });
    if ( rewrittenOptStr === null ) { return null; }
    // A badfilter line in the Quick-fixes list becomes an ALLOW of the rule it names: translate it without
    // the badfilter option (case 2 below). Every other badfilter line returned above.
    const optsForParser = isBadfilter
        ? rewrittenOptStr.split(',').filter(o => o !== 'badfilter').join(',')
        : rewrittenOptStr;
    const parserLine = `${isException ? '@@' : ''}${pattern}${optsForParser ? `$${optsForParser}` : ''}`;

    const translated = translateNetworkLine(parserLine);
    if ( translated === null ) { return null; }
    const { action, condition, important } = translated;

    if ( isBadfilter && options.convertBadfilterToAllow ) {
        // Case 2 (badfilter-quick-fixes list only) — per explicit request:
        // convert to an ALLOW rule at this list's own elevated priority
        // instead of a block rule. isException ("@@") is irrelevant here —
        // a badfilter line is a cancellation, never itself an exception
        // rule, regardless of an "@@" prefix a source might mistakenly add.
        //
        // (11.0.2) Only a fix for a plain BLOCK rule can be written as an
        // allow of the same condition. A fix for a rule with another action
        // (e.g. "$redirect=noopjs") would become an allow of the WHOLE
        // condition — far more than the one rule it names, so the site's
        // other blocks stop too. AdGuard fixed the same class of bug
        // (tsurlfilter 6.1.0 / dnr-converter 2.1.0: a $badfilter cancels only
        // the rule it names). Such a line is dropped and listed in the
        // unsupported-lines report instead.
        if ( action?.type !== BADFILTER_CANCELLABLE_ACTION ) {
            return { unsupportedReason: badfilterNotBlockReason(action?.type), line: t };
        }
        return { id, priority: options.badfilterPriority ?? priority, action: { type: 'allow' }, condition };
    }

    // (10.7.6 / 11.1.3, owner's decisions) The order within this list's tier (js/core/dnr-budgets.js):
    // block < $redirect < "@@" exception < "$important".
    return { id, priority: priority + staticPriorityOffset(action, important), action, condition };
}

/******************************************************************************/
// Shared-parser adapter (10.7.6)
/******************************************************************************/

// One parser instance for the whole build (the parser is re-used line by line, as the ABP import does).
// Same context as js/offscreen/compile-filters.js compileSandboxFilters().
const sharedNetworkParser = new sfp.AstFilterParser({ localSource: true, nativeCssHas: true, trustedSource: true });

// What a STATIC filter list ships from a translated network line (10.7.6 Phase 3, owner's decisions "translate
// network correctly when possible" and "B. Translate" redirects). Anything else the shared parser can produce is
// dropped here: CSP/permissions headers (modifyHeaders — counted for the owner's decision, not shipped),
// $urltransform (regexSubstitution), response headers ($header=), top-domain conditions, and removeparam (that
// one has its own parser, parseRemoveparamRules()).
//   - redirect: ONLY to a file the extension bundles (the shared parser already maps $redirect= to
//     js/core/redirect-resources.js — noop.js / noop-1s.mp4 — and drops any other target). Unsafe for
//     skip-review, so build-steps.mjs splitUnsafeRules() puts it in the list's unsafe companion.
//   - regexFilter: shipped only when Chrome's own isRegexSupported() accepted it (build-steps.mjs ->
//     regex-support.mjs, cached verdicts); the parser cannot know RE2's memory limit.
const STATIC_ACTION_TYPES = new Set([ 'block', 'allow', 'redirect' ]);
const STATIC_CONDITION_KEYS = new Set([
    'urlFilter', 'regexFilter', 'isUrlFilterCaseSensitive',
    'requestDomains', 'excludedRequestDomains',
    'resourceTypes', 'excludedResourceTypes',
    'requestMethods', 'excludedRequestMethods',
    'domainType', 'initiatorDomains', 'excludedInitiatorDomains',
]);

// True when a redirect action is the one kind a static list ships: a bundled extension file.
function isBundledFileRedirect(action) {
    const redirect = action?.redirect ?? {};
    return typeof redirect.extensionPath === 'string' && Object.keys(redirect).length === 1;
}

// Translates one network filter line with the shared parser and returns { action, condition, important } in the build's
// shape, or null when the line is not a network filter, does not translate, or yields a rule kind a static
// list does not ship (see STATIC_*). Shape (kept so geo scope, top-1M, coalescing and country split work
// unchanged): a lone hostname target is "urlFilter: '||host^'" (Chrome: same match as requestDomains [host]),
// a URL pattern carries isUrlFilterCaseSensitive (false unless $match-case), excluded types become the
// complementary resourceTypes, and the condition keys always come in the same order (stable rule ids).
function translateNetworkLine(line) {
    sharedNetworkParser.parse(normalizeAbpNetworkLine(line));
    if ( sharedNetworkParser.hasError() || sharedNetworkParser.isNetworkFilter() === false ) { return null; }
    const rule = parseNetworkFilter(sharedNetworkParser, { resourceTypes: ALL_RESOURCE_TYPES });
    if ( !rule || STATIC_ACTION_TYPES.has(rule.action?.type) === false ) { return null; }
    if ( rule.action.type === 'redirect' && isBundledFileRedirect(rule.action) === false ) { return null; }
    const src = rule.condition;
    if ( Object.keys(src).some(k => STATIC_CONDITION_KEYS.has(k) === false) ) { return null; }

    let urlFilter = src.urlFilter;
    let requestDomains = src.requestDomains;
    if ( urlFilter === undefined && src.regexFilter === undefined && Array.isArray(requestDomains) && requestDomains.length === 1 ) {
        urlFilter = `||${requestDomains[0]}^`;   // the hostname pattern itself — kept in the old shape
        requestDomains = undefined;
    }
    if ( urlFilter !== undefined && LONE_ANCHOR_URL_FILTERS.has(urlFilter) ) { urlFilter = undefined; }
    const hasUrlTarget = urlFilter !== undefined || src.regexFilter !== undefined || Array.isArray(requestDomains);
    if ( hasUrlTarget === false ) {
        // No URL target: kept ONLY in the "$denyallow=" shape ("*$script,3p,denyallow=a.com,domain=site"): the
        // author listed what may still load, and it is limited to the named sites. Any other target-less rule
        // matches every request of its sites — dropped as before (the C13c overly-broad rule).
        const scoped = Array.isArray(src.initiatorDomains) && src.initiatorDomains.length > 0;
        if ( Array.isArray(src.excludedRequestDomains) === false || scoped === false ) { return null; }
    }

    let resourceTypes = src.resourceTypes;
    if ( Array.isArray(src.excludedResourceTypes) ) {
        const excluded = new Set(src.excludedResourceTypes);   // the shared parser adds main_frame (pages keep loading)
        resourceTypes = ALL_RESOURCE_TYPES.filter(t => excluded.has(t) === false);
    }
    const condition = {};
    if ( src.domainType ) { condition.domainType = src.domainType; }
    if ( src.initiatorDomains ) { condition.initiatorDomains = src.initiatorDomains; }
    if ( src.excludedInitiatorDomains ) { condition.excludedInitiatorDomains = src.excludedInitiatorDomains; }
    if ( requestDomains ) { condition.requestDomains = requestDomains; }
    if ( src.excludedRequestDomains ) { condition.excludedRequestDomains = src.excludedRequestDomains; }
    if ( src.requestMethods ) { condition.requestMethods = src.requestMethods; }
    if ( src.excludedRequestMethods ) { condition.excludedRequestMethods = src.excludedRequestMethods; }
    if ( resourceTypes ) {
        if ( resourceTypes.length === 0 ) { return null; }
        condition.resourceTypes = resourceTypes;
    }
    if ( urlFilter !== undefined ) { condition.urlFilter = urlFilter; }
    if ( src.regexFilter !== undefined ) { condition.regexFilter = src.regexFilter; }
    if ( urlFilter !== undefined || src.regexFilter !== undefined ) {
        condition.isUrlFilterCaseSensitive = src.isUrlFilterCaseSensitive === true;
    }
    const action = rule.action.type === 'redirect'
        ? { type: 'redirect', redirect: { extensionPath: rule.action.redirect.extensionPath } }
        : { type: rule.action.type };
    // (10.7.6) "$important" (block or redirect; "@@…$important" was normalised to a plain allow) — the parser's
    // own priority says it; parseBlockRule() raises the rule above its list's tier.
    return { action, condition, important: isImportantPriority(rule.priority) };
}

// urlFilter values that match every URL — never a useful static rule (same set as the old patternToUrlFilter()).
const LONE_ANCHOR_URL_FILTERS = new Set([ '*', '|', '||', '||^', '|^', '^' ]);

// removeparam (and its old name queryprune) as an option anywhere in the list, with or without a value.
function hasRemoveparamOption(line) {
    const opts = splitOptions(line);
    return opts.some(o => /^(?:removeparam|queryprune)(?:=|$)/.test(o));
}

// The option list of a network line ('' when none) — same "$" split the build always used.
function splitOptions(line) {
    const t = line.startsWith('@@') ? line.slice(2) : line;
    if ( t.startsWith('/') ) {
        const closingSeq = t.indexOf('/$', 1);
        if ( closingSeq !== -1 ) { return t.slice(closingSeq + 2).split(','); }
        if ( t.endsWith('/') ) { return []; }
    }
    const dollarPos = t.lastIndexOf('$');
    return dollarPos === -1 ? [] : t.slice(dollarPos + 1).split(',');
}

// Rewrites every domain=/from= option so wildcard sites ("site.*") become their CrUX-confirmed hostnames
// (resolveWildcardDomainTokens(), unchanged). DANGEROUS case, INCLUDE side only: DNR's initiatorDomains, if
// omitted, means "match ALL sites" — the opposite of "none of the requested sites survived". So when the
// include side is left empty the whole rule is dropped (returns null): an unscoped block would fire on every
// site, an unscoped ALLOW would exempt the pattern everywhere (BUGREPORT-domain-wildcard-invalid-dnr-rules.md).
// The EXCLUDE side has no such trap: an omitted excludedInitiatorDomains excludes nothing, which is what an
// all-dead wildcard exclusion did anyway.
function rewriteWildcardDomainOptions(optStr, context) {
    if ( !optStr ) { return ''; }
    const out = [];
    for ( const opt of optStr.split(',') ) {
        const m = /^(domain|from)=(.*)$/.exec(opt);
        if ( m === null ) { out.push(opt); continue; }
        const incRaw = [], excRaw = [];
        for ( const raw of m[2].split('|') ) {
            ( raw.startsWith('~') ? excRaw : incRaw ).push(raw.replace(/^~/, ''));
        }
        const inc = resolveWildcardDomainTokens(incRaw, context);
        const exc = resolveWildcardDomainTokens(excRaw, context);
        if ( incRaw.length > 0 && inc.length === 0 ) { return null; }
        const parts = [ ...inc, ...exc.map(d => `~${d}`) ];
        if ( parts.length !== 0 ) { out.push(`${m[1]}=${parts.join('|')}`); }
    }
    return out.join(',');
}

/******************************************************************************/
// $removeparam parser
/******************************************************************************/

export function parseRemoveparamRules(text, startId) {
    // (10.7.6) Every removeparam line goes through the shared parser (one parser), wherever the option
    // stands in the list, and keeps its site scope ($domain=) and resource types — before, only lines whose
    // FIRST option was removeparam were seen, and the per-pattern rules lost their $domain= sites.
    // Kept decisions: a regex removeparam is skipped (DNR can only remove named parameters); a value-less one
    // removes the whole query on its named address (10.7.8), and is skipped when it names no address;
    // an exception ("@@…$removeparam") is skipped — DNR can only express it as an ALLOW of the whole request,
    // which would also cancel unrelated blocks; and every pattern-less ("global") parameter is merged into
    // ONE main_frame-only rule (see the note at the global rule below).
    const globalParams = [];
    const scopedRules  = [];
    for ( const line of text.split('\n') ) {
        const t = line.trim();
        if ( !t || t.startsWith('!') || t.startsWith('#') || t.startsWith('[') || t.startsWith('@@') ) { continue; }
        if ( COSMETIC_MARKER_RE.test(t) || hasRemoveparamOption(t) === false ) { continue; }
        const rewrittenOptStr = rewriteWildcardDomainOptions(splitOptions(t).join(','), { line: t });
        if ( rewrittenOptStr === null ) { continue; }
        const pattern = t.slice(0, t.length - splitOptions(t).join(',').length).replace(/\$$/, '');
        sharedNetworkParser.parse(`${pattern}$${rewrittenOptStr}`);
        if ( sharedNetworkParser.hasError() || sharedNetworkParser.isNetworkFilter() === false ) { continue; }
        const rule = parseNetworkFilter(sharedNetworkParser, { resourceTypes: ALL_RESOURCE_TYPES });
        if ( rule?.action?.type !== 'redirect' ) { continue; }
        const transform = rule.action.redirect?.transform;
        const removeParams = transform?.queryTransform?.removeParams;
        const c = rule.condition;
        // (10.7.8) value-less "$removeparam" on a named address: remove the whole query (transform.query = '',
        // produced by the shared parser; it refuses the address-less form).
        if ( transform?.query === '' ) {
            if ( c.regexFilter !== undefined ) { continue; }
            if ( c.urlFilter !== undefined ) { c.isUrlFilterCaseSensitive = false; }
            scopedRules.push({ transform: { query: '' }, condition: c });
            continue;
        }
        if ( !Array.isArray(removeParams) || removeParams.length === 0 ) { continue; }
        const isGlobal = pattern === '' || pattern === '*';
        if ( isGlobal && !c.initiatorDomains && !c.excludedInitiatorDomains && !c.domainType && !c.resourceTypes ) {
            globalParams.push(...removeParams);
            continue;
        }
        if ( c.regexFilter !== undefined ) { continue; }   // regex patterns: not shipped (same as network rules)
        if ( c.urlFilter !== undefined ) { c.isUrlFilterCaseSensitive = false; }
        scopedRules.push({ transform: { queryTransform: { removeParams: [...new Set(removeParams)] } }, condition: c });
    }

    const rules = [];
    let id = startId;
    if ( globalParams.length > 0 ) {
        // GLOBAL (no URL pattern) rule: matches EVERY request of its types. It used to cover sub_frame
        // too, and at the default-list priority a redirect that matches every frame outranks every
        // Worry-free rule below it (extra lists 8 000, Medium tier 300–320, …): an ad iframe was
        // "redirected" (still loaded) instead of blocked — measured 9.9.1: 70% of the frames the extra
        // lists block were defeated this way. Stripping tracking parameters from a frame's URL has no
        // benefit worth that, so the blanket rule is main_frame (page loads) only. The scoped rules
        // below name a specific URL (or site) and cannot match an arbitrary ad frame.
        rules.push({
            id: id++, priority: STATIC_FILTER_LIST_PRIORITY,
            action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: [...new Set(globalParams)] } } } },
            condition: { resourceTypes: ['main_frame'] },
        });
    }
    for ( const { transform, condition } of scopedRules ) {
        rules.push({
            id: id++, priority: STATIC_FILTER_LIST_PRIORITY,
            action: { type: 'redirect', redirect: { transform } },
            condition,
        });
    }
    return rules;
}
