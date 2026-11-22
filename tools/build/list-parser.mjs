// ── tools/build/list-parser.mjs ───────────────────────────────────────────────────────
// Full list parser — parseList() returns { dnrRules, scriptletRules }.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: parseList, REQUEST_DOMAINS_CHUNK_SIZE
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import { STATIC_FILTER_LIST_PRIORITY } from '../../js/core/dnr-budgets.js';
import { droppedBadfilters, droppedUnsupportedListLines, worryfreeExemptDomains } from './build-state.mjs';
import { parseCosmeticRules } from './cosmetic-data.mjs';
import { parseBlockRule, parseRemoveparamRules } from './rule-parsers.mjs';
import { parseScriptletExceptionRules, parseScriptletRules } from './scriptlet-rules.mjs';
import { isTLDKept } from './tld-scope.mjs';
import { classifyUnsupportedSyntax, describeUncompilableNetworkLine, isHandledElsewhere } from './unsupported-lines.mjs';

/******************************************************************************/
// Full list parser — returns { dnrRules, scriptletRules }
/******************************************************************************/

// Most domains coalesced into ONE DNR rule's requestDomains — see the CHUNK_SIZE comment inside parseList() for
// why 4 000. Exported (10.2.0) so every builder that coalesces domains uses the same proven number instead of
// its own copy.
export const REQUEST_DOMAINS_CHUNK_SIZE = 4000;

// droppedBadfilters — module-scope, accumulated across every parseList()

// Extracts the target hostname from a compiled DNR condition's urlFilter,
// for the `||hostname^...`-shaped patterns that are the overwhelming
// majority of network block/allow rules. Patterns with no clean anchored
// hostname (path-only patterns, mid-string matches, etc.) return null —
// nothing to TLD-gate them on, so they pass through unaffected by
// applyGeoScopeToNetworkRule() below.
// (10.4.5) also a host that ends the pattern ("||host", as domain lists write it) or is followed by a path or
// port — before, only "^"/"|" ended it, so "||ads.example.ru" (no "^") slipped past the gate.
const NETWORK_TARGET_HOSTNAME_RE = /^\|\|([a-z0-9*.-]+)(?=[|^/:?]|$)/i;
function extractNetworkTargetHostname(urlFilter) {
    const m = NETWORK_TARGET_HOSTNAME_RE.exec(urlFilter);
    return m ? m[1].toLowerCase() : null;
}

// Geographic scope for ONE compiled network rule (10.4.5, every list — see GEO_SCOPE in tld-scope.mjs).
// Returns the rule to keep (its site list possibly narrowed) or null to drop it:
//   - its target host (||host^…) is outside the scope -> dropped (ad servers too, owner's decision);
//   - (10.7.6) its target-host list (requestDomains, from $to=) is narrowed like the site list below;
//   - its site list (initiatorDomains, from $domain=) loses every out-of-scope site; a rule that had sites
//     and is left with none is dropped — it only ever applied on out-of-scope websites.
// excludedInitiatorDomains is left alone: an exception for an out-of-scope site cannot widen anything in scope.
// Pure: returns a new condition object when it narrows, never edits a shared one.
export function applyGeoScopeToNetworkRule(rule) {
    const condition = rule?.condition ?? {};
    const targetHn = extractNetworkTargetHostname(condition.urlFilter ?? '');
    if ( targetHn !== null && isTLDKept(targetHn) === false ) { return null; }
    let narrowed = null;
    // (10.7.6) The same two lists narrowed the same way: the target hosts ("$to=" — requestDomains) and the sites.
    for ( const key of [ 'requestDomains', 'initiatorDomains' ] ) {
        const hosts = condition[key];
        if ( Array.isArray(hosts) === false || hosts.length === 0 ) { continue; }
        const kept = hosts.filter(d => isTLDKept(d));
        if ( kept.length === 0 ) { return null; }
        if ( kept.length !== hosts.length ) { narrowed = { ...(narrowed ?? condition), [key]: kept }; }
    }
    return narrowed === null ? rule : { ...rule, condition: narrowed };
}

export function parseList(text, priority = STATIC_FILTER_LIST_PRIORITY, options = {}) {
    const lines = text.split('\n');
    const dnrRules = [];
    let id = 1;
    let outOfScopeDropped = 0;   // network rules dropped by the geographic scope (reported below)

    for ( const line of lines ) {
        // Hand-written lists (options.reportUnsupportedLines, the Quick-fixes list): a line nothing in the build can use is
        // dropped HERE, explicitly, and reported — never lost silently, and never turned into a junk network rule (the
        // network parser below would accept e.g. a raw-JavaScript exception `host#@%#...` as a URL pattern). Large
        // third-party lists do not opt in (they carry thousands of such lines on purpose).
        if ( options.reportUnsupportedLines === true ) {
            const syntaxReason = classifyUnsupportedSyntax(line);
            if ( syntaxReason !== null ) {
                droppedUnsupportedListLines.push({ list: options.listName ?? '(unknown list)', line: line.trim(), reason: syntaxReason });
                continue;
            }
        }
        const rule = parseBlockRule(line, id, priority, options);
        if ( rule === null ) {
            if ( options.reportUnsupportedLines === true && isHandledElsewhere(line) === false ) {
                droppedUnsupportedListLines.push({ list: options.listName ?? '(unknown list)', line: line.trim(), reason: describeUncompilableNetworkLine(line.trim()) });
            }
            continue;
        }
        if ( rule.unsupportedReason ) {
            // (11.0.2) A Bad filter fixes line an allow rule cannot express exactly (see parseBlockRule()).
            droppedUnsupportedListLines.push({ list: options.listName ?? '(unknown list)', line: rule.line, reason: rule.unsupportedReason });
            continue;
        }
        if ( rule.droppedBadfilter ) {
            droppedBadfilters.push({ list: options.listName ?? '(unknown list)', line: rule.line });
            continue;
        }
        if ( rule.ignoredRetiredOption ) {
            // (10.3.0) A retired per-site option ("@@domain$saferegions"): ignored, but listed so it is visible.
            droppedUnsupportedListLines.push({ list: options.listName ?? '(unknown list)', line: rule.line, reason: `retired option $${rule.ignoredRetiredOption} (10.3.0) — ignored` });
            continue;
        }
        if ( rule.worryfreeExempt ) {
            worryfreeExemptDomains.push({ domain: rule.domain, list: options.listName ?? '(unknown list)', line: rule.line });
            continue;
        }
        // Geographic scope (10.4.5): every list, every network rule — see applyGeoScopeToNetworkRule().
        const scoped = applyGeoScopeToNetworkRule(rule);
        if ( scoped === null ) { outOfScopeDropped++; continue; }
        dnrRules.push(scoped);
        id++;
    }
    if ( text.includes('removeparam') ) {
        const rpRules = parseRemoveparamRules(text, id);
        for ( const r of rpRules ) {
            const scoped = applyGeoScopeToNetworkRule(r);   // same scope as every other network rule
            if ( scoped === null ) { outOfScopeDropped++; continue; }
            scoped.id = id++;
            dnrRules.push(scoped);
        }
    }
    if ( outOfScopeDropped > 0 ) { process.stdout.write(`(dropped ${outOfScopeDropped} out-of-scope) `); }

    // Final validation — drop rules with invalid urlFilter/regexFilter:
    //   - spaces (parsing error let a non-network line through)
    //   - non-ASCII characters (Chrome DNR requires ASCII-only URL filters)
    //   - RE2-incompatible regex (lookahead/lookbehind already caught above,
    //     but guard here too in case patternToUrlFilter changes)
    function isAsciiOnly(s) { return !/[^\x00-\x7F]/.test(s); }
    let validated = dnrRules.filter(r => {
        const uf = r.condition?.urlFilter  ?? '';
        const rf = r.condition?.regexFilter ?? '';
        if ( uf && ( uf.includes(' ') || !isAsciiOnly(uf) ) ) { return false; }
        if ( rf && !isAsciiOnly(rf) ) { return false; }
        return true;
    });
    if ( validated.length !== dnrRules.length ) {
        process.stdout.write(`(dropped ${dnrRules.length - validated.length} invalid) `);
    }

    // Drop known overly-broad rules that break legitimate sites.
    //
    // Pattern 1 — |http*://*?
    //   Blocks ALL third-party requests that carry a query string from the
    //   listed initiator domains.  Far too aggressive; breaks navigation and
    //   API calls on those sites.
    //
    // Pattern 2 — |https:// or |http:// combined with domainType=thirdParty
    //   and initiatorDomains (i.e. "block every third-party script/XHR on
    //   site X").  The urlFilter matches literally every HTTPS/HTTP URL, so
    //   the rule indiscriminately blocks all third-party scripts and XHR on
    //   the named sites — including CDN-hosted player SDKs, fonts, and APIs
    //   they depend on.  Known to break xvideos.com and similar sites that
    //   load critical resources from third-party origins.
    //   Example rule that triggered this guard (AdGuard Base, rule 10902):
    //     { action:{type:"block"}, condition:{
    //         urlFilter:"|https://", domainType:"thirdParty",
    //         initiatorDomains:["xvideos.com"],
    //         resourceTypes:["script","xmlhttprequest"] } }
    //
    // OVERLY_BROAD_URL_FILTERS — urlFilter values that by themselves match
    // virtually every URL and therefore make any block rule far too wide.
    const OVERLY_BROAD_URL_FILTERS = new Set([
        '|http*://*?',  // any URL with a query string
        '|https://',    // every HTTPS URL
        '|http://',     // every HTTP URL
        '|https:',      // same without trailing slash
        '|http:',       // same without trailing slash
    ]);

    const beforeBroad = validated.length;
    validated = validated.filter(r => {
        if ( r.action?.type !== 'block' ) { return true; }
        const cond = r.condition ?? {};
        const uf   = cond.urlFilter ?? '';

        // Pattern 1: the bare overly-broad urlFilter alone is enough to reject.
        if ( uf === '|http*://*?' ) { return false; }

        // Pattern 2: broad urlFilter + thirdParty + initiatorDomains — the
        // combination means "block all 3rd-party traffic on specific sites",
        // which is never safe to apply globally via a static DNR ruleset.
        if (
            OVERLY_BROAD_URL_FILTERS.has(uf) &&
            cond.domainType === 'thirdParty'  &&
            Array.isArray(cond.initiatorDomains) &&
            cond.initiatorDomains.length > 0
        ) { return false; }

        return true;
    });
    if ( validated.length !== beforeBroad ) {
        process.stdout.write(`(dropped ${beforeBroad - validated.length} overly-broad) `);
    }

    // Coalesce pure hostname block rules into a single requestDomains rule.
    // Rules of the form ||hostname (no path, no extra conditions) can be merged:
    // instead of N separate urlFilter rules each blocking one hostname, emit
    // one DNR rule with requestDomains: [host1, host2, ...].
    // This mirrors what uBol Lite's build does and reduces rule count by ~75%
    // for lists like AdGuard Base that contain tens of thousands of host-only blocks.
    //
    // v8.3.6 — extended to ALSO coalesce ||hostname^$third-party the same
    // way, into its own separate group with domainType:'thirdParty' added
    // (a bare block and a third-party-only block are NOT the same condition
    // and can never share one coalesced rule — see the Worry-free extra
    // blocklist source's own dedup note on this exact point). Added because
    // that source's real data is ~75% third-party-only domains (3,769 of
    // 5,033) — without this, every one of those would've stayed an
    // individual, uncoalesced DNR rule instead of a handful of merged ones.
    // (10.7.6) Only an EXACT host target ("||host^") may become a requestDomains entry. "||host" without the
    // separator is a prefix ("||ads" also matches "adserver.net"), and a host with "*" or a trailing "." (a
    // wildcard TLD such as "||valentine.xhamster.") is not a hostname at all — both stay urlFilter rules. The
    // old pattern merged all three into requestDomains, which matched the wrong hosts or none.
    const HOSTNAME_BLOCK_RE = /^\|\|([a-zA-Z0-9._-]*[a-zA-Z0-9_-])\^$/;
    const hostnameBlockDomains           = [];
    const thirdPartyHostnameBlockDomains = [];
    const nonHostnameRules     = [];

    for ( const r of validated ) {
        const uf = r.condition?.urlFilter ?? '';
        const m  = HOSTNAME_BLOCK_RE.exec(uf);
        // (10.7.6) Only rules at the list's own priority: a "$important" block (raised priority) keeps its own rule.
        const isPlainHostnamePattern = r.action.type === 'block' && r.priority === priority && m !== null && !uf.slice(2).includes('/');
        const condKeys = isPlainHostnamePattern ? Object.keys(r.condition) : null;
        if ( isPlainHostnamePattern && condKeys.length === 2 ) {
            // Bare — urlFilter + isUrlFilterCaseSensitive only.
            hostnameBlockDomains.push(m[1]);
        } else if (
            isPlainHostnamePattern &&
            condKeys.length === 3 &&
            r.condition.domainType === 'thirdParty'
        ) {
            // Third-party-only — urlFilter + isUrlFilterCaseSensitive + domainType.
            thirdPartyHostnameBlockDomains.push(m[1]);
        } else {
            nonHostnameRules.push(r);
        }
    }

    // ── Stable, content-derived rule ids ──────────────────────────────────
    // WHY: a rule's `id` carries no meaning to DNR matching — it only has
    // to be a positive integer, unique within this file. Renumbering by
    // ARRAY POSITION (the old behavior: "starting at 1" here, and
    // count-dependent for the coalesced chunks below) meant inserting or
    // removing ONE upstream rule shifted the id of every rule after it,
    // even when nothing about those rules changed. That turned a true
    // few-rule content delta into a near-total rewrite of the ruleset file
    // on every release — verified directly: a release that net-changed
    // ruleset_adguard_base.json by 8 rules (8744→8752) showed 6752
    // added + 6744 removed (77% of the file) under the old positional
    // scheme, because unrelated rules after the changed ones all got new
    // ids purely from shifting position. This defeats the purpose of a
    // "safe, minimal" filter-only update (see tools/verify-safe-update.mjs)
    // and inflates every release's real diff far beyond its actual content
    // change.
    //
    // FIX: derive each rule's id from its own condition + action via a
    // deterministic hash, so a rule that didn't change keeps the same id
    // release after release — only rules that actually changed, or are
    // new, get a new id. Collisions (two different rules hashing to the
    // same slot) are resolved by deterministic linear probing; this only
    // perturbs the colliding rules, never the rest of the file.
    const STABLE_ID_RANGE = 2_000_000; // positive ids 1..STABLE_ID_RANGE; see dnr-budgets.js for the separate, much higher band reserved for exemption-carrier rules appended after this function returns (build-steps.mjs: nextId = max(id)+1)

    function fnv1aHash(str) {
        let h = 0x811c9dc5;
        for ( let i = 0; i < str.length; i++ ) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
    }

    function assignStableId(rule, usedIds) {
        const key = JSON.stringify({ c: rule.condition, a: rule.action });
        let slot = (fnv1aHash(key) % STABLE_ID_RANGE) + 1; // 1..STABLE_ID_RANGE, never 0
        while ( usedIds.has(slot) ) {
            slot = (slot % STABLE_ID_RANGE) + 1; // deterministic probe, wraps without landing on 0
        }
        usedIds.add(slot);
        return slot;
    }

    const coalescedRules = [];
    const usedStableIds = new Set();
    for ( const r of nonHostnameRules ) {
        coalescedRules.push({ ...r, id: assignStableId(r, usedStableIds) });
    }

    // Emit merged rule(s) for pure hostname blocks, bare and third-party-only
    // kept as two separate coalesced groups (see this function's own header
    // note on why they can never share one rule).
    //
    // CHUNK_SIZE (v8.3.6 correction, v8.3.15 raised): NOT an officially
    // documented Chrome API limit on requestDomains array length —
    // checked directly against MDN's and Chrome's own
    // declarativeNetRequest reference docs, found no such documented cap.
    // This number is an empirical, self-imposed safety margin. Raised
    // 2 000 -> 4 000 (v8.3.15) per explicit instruction: uBO-lite's own
    // build compiles Peter Lowe's list (~3 500 domains) into a single DNR
    // rule — real, working precedent that a single-rule domain count in
    // that range is safe in practice, not just a number picked at random
    // (another extension's own build reportedly uses 5 000, per the
    // person's own earlier note — 4 000 stays under that too).
    const CHUNK_SIZE = REQUEST_DOMAINS_CHUNK_SIZE;
    for ( let i = 0; i < hostnameBlockDomains.length; i += CHUNK_SIZE ) {
        const chunk = hostnameBlockDomains.slice(i, i + CHUNK_SIZE);
        const action = { type: 'block' };
        const condition = { requestDomains: chunk };
        coalescedRules.push({
            id: assignStableId({ condition, action }, usedStableIds),
            priority,
            action,
            condition,
        });
    }
    for ( let i = 0; i < thirdPartyHostnameBlockDomains.length; i += CHUNK_SIZE ) {
        const chunk = thirdPartyHostnameBlockDomains.slice(i, i + CHUNK_SIZE);
        const action = { type: 'block' };
        const condition = { requestDomains: chunk, domainType: 'thirdParty' };
        coalescedRules.push({
            id: assignStableId({ condition, action }, usedStableIds),
            priority,
            action,
            condition,
        });
    }

    if ( hostnameBlockDomains.length > 0 || thirdPartyHostnameBlockDomains.length > 0 ) {
        process.stdout.write(
            `(coalesced ${hostnameBlockDomains.length} bare + ` +
            `${thirdPartyHostnameBlockDomains.length} third-party hostname blocks → ` +
            `${Math.ceil(hostnameBlockDomains.length / CHUNK_SIZE) + Math.ceil(thirdPartyHostnameBlockDomains.length / CHUNK_SIZE)} rule(s)) `
        );
    }

    // Geographic scope for cosmetic/scriptlet hostnames (isTLDKept, every list) + generic-qualifier handling
    // (AdGuard Base only, allowGenericDomainQualifier).
    const tldCheckFn = options.tldCheckFn ?? isTLDKept;
    const allowGenericDomainQualifier = options.allowGenericDomainQualifier === true;
    const scriptletRules = parseScriptletRules(text, tldCheckFn, allowGenericDomainQualifier);
    const scriptletExceptions = parseScriptletExceptionRules(text);
    const cosmeticMap    = parseCosmeticRules(text, tldCheckFn, allowGenericDomainQualifier);

    return { dnrRules: coalescedRules, scriptletRules, scriptletExceptions, cosmeticMap };
}
