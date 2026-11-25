// ── tools/build/fetch-helpers.mjs ─────────────────────────────────────────────────────
// fetchList() — the one download helper, with validation that the response looks like a filter list.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: fetchList, fetchListText, fetchJsonData, applyScriptletTrustGate
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import { withRetry, fetchWithTimeout } from '../lib/fetch-with-retry.mjs';
import { isTrustedScriptletSource, requiresTrust, safeReplacementFor, SCRIPTLET_POLICY } from '../../js/data/scriptlet-policy.js';
import { droppedPolicyScriptlets } from './build-state.mjs';
import { formatAdguardScriptletLine, parseUboScriptletLine } from './ubo-scriptlet-syntax.mjs';
import { parseScriptletRules } from './scriptlet-rules.mjs';
import { applyListDirectives } from './list-directives.mjs';

// ── Scriptlet trust gate (10.4.6, rule A of js/data/scriptlet-policy.js) ──
// The single download helper is the one place every upstream text passes through with its own source URL, so the
// per-SOURCE decision is made here: a list that combines an AdGuard source with another (French = AdGuard + EasyList
// anti-adblock) keeps the AdGuard source's trusted scriptlets and loses the other source's. Text derived later from
// an AdGuard download (foreign.txt routing, the Spanish->Portuguese hand-off) keeps AdGuard's verdict.
const TRUST_GATE_CONFIG = Object.freeze({
    // Scriptlet-call markers: AdGuard (#%#//scriptlet(…)) and uBO (##+js(…)). Exceptions (#@%# / #@#+js) are not
    // matched: they only cancel a rule and run nothing.
    SCRIPTLET_CALL_RE: /(?:#%#\/\/scriptlet|##\+js)\(\s*(['"]?)([^'",)\s]+)\1/,
    // (11.1.3) For the safe-replacement step: the AdGuard call marker, and the stand-in host the AdGuard line is parsed
    // under (any plain hostname; only name and arguments are read back).
    ADGUARD_CALL_MARK: '#%#//scriptlet(',
    PARSE_PROBE_HOST:  'probe.invalid',
});

// (11.1.3, owner's decision) Before a refused line is dropped, the policy is asked for a safe equivalent
// (safeReplacementFor). A line with one — uBO or AdGuard syntax — is rewritten to that safe scriptlet, in the AdGuard
// form the build parses, and reported with reason REASON_REPLACED instead of being dropped.
function safeReplacementLine(line) {
    const parsed = parseUboScriptletLine(line) ?? parseAdguardScriptletLine(line);
    if ( parsed === null || parsed.exception ) { return null; }
    const safe = safeReplacementFor(parsed.name, parsed.args);
    return safe === null ? null : formatAdguardScriptletLine(parsed.hosts, safe.name, safe.args);
}

// One AdGuard scriptlet line taken apart ({ hosts, exception: false, name, args }) by the build's own parser
// (parseScriptletRules). The parser sees the call under a fixed probe host, so its reports on unusual host scopes
// (negations, [$path=…]) are not filed twice; the line's own host text is kept as written for the later parse.
function parseAdguardScriptletLine(line) {
    const at = line.indexOf(TRUST_GATE_CONFIG.ADGUARD_CALL_MARK);
    if ( at <= 0 ) { return null; }
    const [ rule ] = parseScriptletRules(`${TRUST_GATE_CONFIG.PARSE_PROBE_HOST}${line.slice(at)}`, ( ) => true);
    return rule === undefined ? null : { hosts: line.slice(0, at).trim(), exception: false, name: rule.name, args: rule.args };
}

// Removes every line calling a scriptlet that needs trust when `url` is not an AdGuard Team source, unless the policy
// has a safe replacement for it (then the line is replaced). Each removed or replaced line is recorded in
// droppedPolicyScriptlets. Returns the text unchanged for a trusted source.
export function applyScriptletTrustGate(url, text) {
    if ( isTrustedScriptletSource(url) ) { return text; }
    const kept = [];
    for ( const line of text.split('\n') ) {
        const m = TRUST_GATE_CONFIG.SCRIPTLET_CALL_RE.exec(line);
        if ( m !== null && line.trimStart().startsWith('!') === false && requiresTrust(m[2]) ) {
            const replacement = safeReplacementLine(line);
            const reason = replacement === null ? SCRIPTLET_POLICY.REASON_UNTRUSTED_SOURCE : SCRIPTLET_POLICY.REASON_REPLACED;
            droppedPolicyScriptlets.push({ source: url, name: m[2], args: [], reason, line: line.trim() });
            if ( replacement !== null ) { kept.push(replacement); }
            continue;
        }
        kept.push(line);
    }
    return kept.join('\n');
}

/******************************************************************************/
// Fetch helper
/******************************************************************************/

// Wrapped in withRetry() — timeout + one retry (tools/lib/fetch-with-retry.mjs).
// The whole attempt, validation included, is retried.
export async function fetchList(url) {
    return applyScriptletTrustGate(url, await fetchListText(url));
}

// (audit 10.6.4) The same download with the same guards, WITHOUT the trust gate — for a caller that takes only a few
// selected lines from a large list (anti-admiral.mjs) and gates exactly those, so the drop report does not list
// hundreds of trusted rules from that list that were never going to be used anyway.
// (11.1.4) Every download leaves here with the list's own platform directives applied ("!+ PLATFORM(…)" hints and
// "!#if" blocks for other blockers left out — list-directives.mjs), so no caller can parse a rule its source never
// meant for this platform. Applied after the retry wrapper, so a retried download is reported once.
export async function fetchListText(url) {
    const text = await withRetry(`filter list ${url}`, signal => fetchListOnce(url, signal));
    return applyListDirectives(url, text);
}

// (11.0.0) The same download guards (retry, timeout, not-near-empty) for a JSON data file — Privacy Badger's
// seed.json (tools/build/privacy-badger-unbreak.mjs). Returns the parsed object; a non-JSON answer (an HTML error
// page) fails like a non-filter-list answer does above.
export async function fetchJsonData(url) {
    return withRetry(`data file ${url}`, async signal => {
        const resp = await fetchWithTimeout(url, signal);
        const text = await resp.text();
        if ( text.length < 20 ) { throw new Error(`Suspiciously small response (${text.length} bytes) from ${url}`); }
        try { return JSON.parse(text); } catch { throw new Error(`Response from ${url} is not JSON — aborting`); }
    });
}

async function fetchListOnce(url, signal) {
    const resp = await fetchWithTimeout(url, signal);
    const text = await resp.text();
    // Guard: reject empty or near-empty responses that indicate a network
    // or GitHub error rather than a real (even tiny) filter list.
    if ( text.length < 20 ) {
        throw new Error(`Suspiciously small response (${text.length} bytes) from ${url}`);
    }
    if ( !text.includes('!') && !text.includes('||') && !text.includes('##') ) {
        throw new Error(`Response from ${url} does not look like a filter list — aborting`);
    }
    return text;
}
