// ── check-dnr-priority-order.mjs ──────────────────────────────────────────────
// Suite step 41. Asserts the DNR priority ORDER (9.9.1 ladder) three ways:
//   A. constants (js/core/dnr-budgets.js) satisfy the required relations, including the
//      security-toggle rules \u2014 the 9.7.9 version never looked at them, which is how the
//      old Medium tier's safe-domain band (allow, all types) sat above the extra lists
//      unnoticed while this check stayed green;
//   A2. the whole ladder, exactly: every tier has the owner-specified number and the order is strict;
//   B. every shipped extra-list ruleset really carries its constant;
//   C. outcomes, via tools/dnr-precedence-eval.mjs (a MODEL of Chrome's documented precedence, not
//      Chrome): the lists block third-party script / sub_frame / image / xhr, a per-list off-switch
//      (9 000) still allows, a default-list `@@` (10 000) still allows;
// `--simulate-extras-priority=N` overrides the six lists' priority to N so the
// check can be proven to FAIL on a wrong number (principle C38 rule 3).
//
// (AdShield Evolution rename pass) The old step D \u2014 scenarios built from the REAL
// Medium-tier rule builder (worry-free-advanced-manager.js, three rows, a real incident
// history of exactly this kind of priority bug) \u2014 is REMOVED: that builder and the tier
// it served are gone; see CHANGELOG_HISTORY.md for the full entry. The one surviving row,
// sandbox-safe-scripts, now sits in the same 100-199 band (170/180) its new safeRegions-tier
// siblings (SCP_PRIVACY/SCP_SECURITY) already occupy, and is covered the same way they are:
// by this file's own section A relational checks and by tools/check-dnr-id-ranges.mjs's
// dedicated header-vs-allow and id-containment checks for that row. A bespoke real-builder
// scenario test was valuable specifically for the old tier's multi-row complexity; a single
// row following an already-proven-safe pattern does not carry the same incremental risk.
//
// Public interface: CLI only; exit 0 = pass, 1 = findings.
// State owned: none.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as B from '../js/core/dnr-budgets.js';
import { loadEnabledRules, evaluate, probeUrls, EXTRA_LIST_IDS } from './dnr-precedence-eval.mjs';

// ── Config (one place) ───────────────────────────────────────────────────────
const CONFIG = Object.freeze({
    INITIATOR: 'example-site.nl',
    TYPES: Object.freeze([ 'script', 'sub_frame', 'image', 'xmlhttprequest' ]),
    HOST_SUFFIX: '.com',   // a TLD covered by every safe-TLD allow
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.find(a => a.startsWith('--simulate-extras-priority='));
const SIM = arg ? Number(arg.split('=')[1]) : null;
const findings = [];
function fail(msg) { findings.push(msg); }
const L = B.WORRY_FREE_EXTRA_LISTS_PRIORITY;

// ── A. constants ─────────────────────────────────────────────────────────────
// (AdShield Evolution rename pass) WORRY_FREE_EXTRA_TLD_ALLOW_PRIORITY,
// WORRY_FREE_DOWNLOAD_TLD_ALLOW_PRIORITY/_BLOCKLIST_PRIORITY/_SUPPRESS_PRIORITY, and
// ADVANCED_ALLOW_PRIORITY/_3P_BLOCK_PRIORITY/_FORCED_DOWNLOAD_BLOCK_PRIORITY/_HEADER_PRIORITY
// removed from these two arrays \u2014 all retired (blockScpTldBlock and the Medium tier's
// first-party-downloads/third-party-block rows, all removed per explicit request; see
// CHANGELOG_HISTORY.md), so there is no longer a live rule at any of those priorities to
// test the extra lists against. SANDBOX_SAFE_SCRIPTS_HEADER_PRIORITY/
// _ALLOW_PRIORITY added \u2014 the sandbox-safe-scripts row's own two priorities, the one
// surviving piece of that tier, now in the same band as its new safeRegions-tier siblings.
const tldAllows = [ B.SCP_PRIVACY_TLD_ALLOW_PRIORITY, B.SCP_SECURITY_TLD_ALLOW_PRIORITY,
    B.SANDBOX_SAFE_SCRIPTS_ALLOW_PRIORITY ];
const items = [ B.SCP_PRIVACY_BLOCKLIST_PRIORITY, B.SCP_PRIVACY_SUPPRESS_PRIORITY,
    B.SCP_SECURITY_BLOCKLIST_PRIORITY, B.SCP_SECURITY_SUPPRESS_PRIORITY,
    B.SANDBOX_SAFE_SCRIPTS_HEADER_PRIORITY,
    B.SECURITY_RULES_PRIORITY ];
const eff = SIM ?? L;
for ( const t of tldAllows ) { if ( !(eff > t) ) { fail(`A: extra lists (${eff}) must be above every TLD allow, but ${t} >= ${eff}`); } }
for ( const t of items ) { if ( !(eff > t) ) { fail(`A: extra lists (${eff}) must be above Worry-free/Privacy/Security item ${t}`); } }
if ( !(eff < B.WORRY_FREE_EXTRA_ALLOW_PRIORITY) ) { fail(`A: extra lists (${eff}) must be below the per-list off-switch (${B.WORRY_FREE_EXTRA_ALLOW_PRIORITY})`); }
if ( !(eff < B.STATIC_FILTER_LIST_PRIORITY) ) { fail(`A: extra lists (${eff}) must be below default filter lists (${B.STATIC_FILTER_LIST_PRIORITY})`); }
if ( eff >= B.RETIRED_ADVANCED_PRIORITY_MIN && eff <= B.RETIRED_ADVANCED_PRIORITY_MAX ) {
    fail(`A: extra lists (${eff}) sit inside the retired band ${B.RETIRED_ADVANCED_PRIORITY_MIN}-${B.RETIRED_ADVANCED_PRIORITY_MAX}`);
}
for ( const [ name, v ] of Object.entries(B) ) {
    if ( !name.endsWith('PRIORITY') || typeof v !== 'number' || name === 'WORRY_FREE_EXTRA_LISTS_PRIORITY' ) { continue; }
    if ( v >= B.RETIRED_ADVANCED_PRIORITY_MIN && v <= B.RETIRED_ADVANCED_PRIORITY_MAX ) { fail(`A: ${name}=${v} sits inside the retired band`); }
}

// ?? A2. the whole ladder, exactly (9.9.1, numbers specified by the owner) ??????????
// Highest first. Each entry is [constant name, expected value]; both the value AND the strict
// descending order are asserted, so neither a drifted number nor a swapped pair passes.
const LADDER = [
    [ 'TRUSTED_DIRECTIVE_PRIORITY',       1_000_000 ],   // pause / Allow list
    [ 'BUILTIN_WHITELIST_RULES_PRIORITY',   800_000 ],
    [ 'BADFILTER_QUICKFIXES_PRIORITY',      600_000 ],
    [ 'MATRIX_RULES_CODE_PRIORITY',         400_001 ],
    [ 'MATRIX_RULES_ALL_PRIORITY',          400_000 ],
    [ 'USER_RULES_PRIORITY',                200_000 ],   // ABP import / custom rules (+10/+11/+30 on top)
    [ 'STATIC_FILTER_LIST_PRIORITY',         10_000 ],   // default filter lists
    [ 'WORRY_FREE_SITE_ALLOW_PRIORITY',       9_500 ],   // "@@site$worryfree" (10.0.0): the whole site is outside Worry-free
    [ 'CMP_LOADER_BLOCK_PRIORITY',            9_200 ],   // (10.7.16) CMP loader block while Seamless surfing declines banners
    [ 'WORRY_FREE_EXTRA_ALLOW_PRIORITY',      9_000 ],   // per-list off-switch
    [ 'WORRY_FREE_EXTRA_LISTS_PRIORITY',      8_000 ],   // Worry-free extra lists
    [ 'SECURITY_PORT_ALLOW_PRIORITY',         1_001 ],
    [ 'SECURITY_RULES_PRIORITY',              1_000 ],   // security toggles
    [ 'HIGH_RISK_HEADERS_PRIORITY',             900 ],   // adult-site headers (a list @@ may cancel them: deliberate)
    // (AdShield Evolution rename pass) ADVANCED_ALLOW_PRIORITY/_HEADER_PRIORITY/
    // _FORCED_DOWNLOAD_BLOCK_PRIORITY/_3P_BLOCK_PRIORITY (320/310/305/300) removed \u2014
    // the Medium tier's first-party-downloads and third-party-block rows are retired;
    // see CHANGELOG_HISTORY.md. The sandbox-safe-scripts row's own two priorities
    // (170/180) are checked by section A above, not this exact-ladder list \u2014 they sit
    // inside the 100-199 Worry-free band, which tools/check-dnr-id-ranges.mjs's own
    // generic band scan already covers uniqueness/relations for.
];
let previous = null;
for ( const [ name, expected ] of LADDER ) {
    const actual = B[name];
    if ( actual !== expected ) { fail(`A2: ${name} is ${actual}, the ladder says ${expected}`); }
    if ( previous !== null && !(typeof actual === 'number' && actual < previous.value) ) {
        fail(`A2: ${name} (${actual}) must be BELOW ${previous.name} (${previous.value})`);
    }
    previous = { name, value: actual };
}
// The user rules carry small offsets on top of USER_RULES_PRIORITY (see ruleset-manager.js); they must
// stay inside the tier: above the default lists and below the Matrix panel.
if ( !(B.USER_RULES_PRIORITY + 99 < B.MATRIX_RULES_ALL_PRIORITY) ) { fail('A2: the user-rule offsets would reach the Matrix tier'); }


// ── B + C. shipped rulesets and outcomes ─────────────────────────────────────
const { rules, unmodeled } = loadEnabledRules(ROOT);
if ( SIM !== null ) { for ( const r of rules ) { if ( EXTRA_LIST_IDS.includes(r._list) ) { r.priority = SIM; } } }
const allows = rules.filter(r => r.action?.type !== 'block');
for ( const id of EXTRA_LIST_IDS ) {
    const own = rules.filter(r => r._list === id);
    if ( own.length === 0 ) { fail(`B: ${id} has no enabled rules`); continue; }
    const bad = own.filter(r => r.priority !== L);
    if ( bad.length ) { fail(`B: ${id}: ${bad.length} rule(s) at ${[ ...new Set(bad.map(r => r.priority)) ]} instead of ${L}`); }
    // C: one real host per list, in a safe TLD, probed for every type.
    const pick = own.filter(r => r.action.type === 'block')
        .flatMap(r => probeUrls(r).map(url => ({ r, url })))
        .find(({ r, url }) => new URL(url).hostname.endsWith(CONFIG.HOST_SUFFIX) && r.condition.domainType !== 'firstParty' && !r.condition.initiatorDomains);
    if ( !pick ) { fail(`C: ${id}: no third-party ${CONFIG.HOST_SUFFIX} probe host found`); continue; }
    const host = new URL(pick.url).hostname;
    const sw = { id: 1, priority: B.WORRY_FREE_EXTRA_ALLOW_PRIORITY, action: { type: 'allow' }, condition: { requestDomains: [ host ] }, _list: 'session-suppress' };
    const hdrOff = { id: 2, priority: B.SCP_SECURITY_SUPPRESS_PRIORITY, action: { type: 'allow' }, condition: { resourceTypes: [ 'main_frame', 'sub_frame' ] }, _list: 'security-off' };
    for ( const type of CONFIG.TYPES ) {
        if ( pick.r.condition.resourceTypes && !pick.r.condition.resourceTypes.includes(type) ) { continue; }
        const req = { url: pick.url, type, initiator: CONFIG.INITIATOR };
        // Judge the extras rule ALONE against every allow: the same host may also be
        // blocked by a default list (1000), which would mask the off-switch test.
        const scope = [ pick.r, ...allows ];
        const base = evaluate(scope, req);
        // The default-list exception (1000) may legitimately win; anything else must be this list's block.
        if ( base.outcome !== 'BLOCK' && base.winner?.priority !== B.STATIC_FILTER_LIST_PRIORITY + B.STATIC_EXCEPTION_PRIORITY_OFFSET ) {
            fail(`C: ${id}: ${type} ${host} -> ${base.outcome}, winner ${base.winner?._list}@${base.winner?.priority} (expected BLOCK by the list)`);
        }
        if ( evaluate([ ...scope, sw ], req).outcome !== 'ALLOW' ) { fail(`C: ${id}: ${type} ${host} still blocked with the per-list off-switch (${B.WORRY_FREE_EXTRA_ALLOW_PRIORITY}) present`); }
        if ( type === 'sub_frame' && base.outcome === 'BLOCK' && evaluate([ ...scope, hdrOff ], req).outcome !== 'BLOCK' ) {
            fail(`C: ${id}: sub_frame ${host} no longer blocked once Security is off (${B.SCP_SECURITY_SUPPRESS_PRIORITY} must not beat the list)`);
        }
    }
    const exc = { id: 3, priority: B.STATIC_FILTER_LIST_PRIORITY + B.STATIC_EXCEPTION_PRIORITY_OFFSET, action: { type: 'allow' }, condition: { requestDomains: [ host ] }, _list: 'default-list @@' };
    if ( evaluate([ pick.r, ...allows, exc ], { url: pick.url, type: 'script', initiator: CONFIG.INITIATOR }).outcome !== 'ALLOW' ) {
        fail(`C: ${id}: a default-list @@ exception (${exc.priority}) no longer wins`);
    }
}

// ── C2. (11.1.3) order WITHIN a static list's tier: block < $redirect < "@@" < "$important" ────────
// Strictly increasing steps (never a tie, so Chrome's tie-break never decides), and the highest step of each static
// tier stays below the next tier up: the default lists below the user-rule tier, the Worry-free extra lists below
// their per-list off-switch.
{
    const steps = [ 0, B.STATIC_REDIRECT_PRIORITY_OFFSET, B.STATIC_EXCEPTION_PRIORITY_OFFSET, B.STATIC_IMPORTANT_PRIORITY_OFFSET ];
    if ( steps.some(v => Number.isInteger(v) === false) || steps.some((v, i) => i > 0 && !(v > steps[i - 1])) ) {
        fail(`C2: static tier steps must be strictly increasing block < redirect < @@ < $important, got ${steps.join(' < ')}`);
    }
    const top = B.STATIC_IMPORTANT_PRIORITY_OFFSET;
    if ( !(B.STATIC_FILTER_LIST_PRIORITY + top < B.USER_RULES_PRIORITY) ) { fail(`C2: default lists' highest step (${B.STATIC_FILTER_LIST_PRIORITY + top}) reaches the user-rule tier`); }
    if ( !(B.WORRY_FREE_EXTRA_LISTS_PRIORITY + top < B.WORRY_FREE_EXTRA_ALLOW_PRIORITY) ) {
        fail(`C2: extra lists' highest step (${B.WORRY_FREE_EXTRA_LISTS_PRIORITY + top}) reaches their off-switch (${B.WORRY_FREE_EXTRA_ALLOW_PRIORITY})`);
    }
    // The case that motivated it: a list's $redirect must win over ANY list's plain block of the same request.
    const req = { url: 'https://html-load.com/loader.js', type: 'script', initiator: CONFIG.INITIATOR };
    const block = { id: 1, priority: B.STATIC_FILTER_LIST_PRIORITY, action: { type: 'block' }, condition: { requestDomains: [ 'html-load.com' ] }, _list: 'block' };
    const redirect = { id: 2, priority: B.STATIC_FILTER_LIST_PRIORITY + B.STATIC_REDIRECT_PRIORITY_OFFSET, action: { type: 'redirect', redirect: { extensionPath: '/x.js' } }, condition: { requestDomains: [ 'html-load.com' ] }, _list: 'redirect' };
    const got = evaluate([ block, redirect ], req);
    if ( got.winner?._list !== 'redirect' ) { fail(`C2: a $redirect no longer beats a plain block of the same request (winner ${got.winner?._list})`); }
}

// ── D. (10.7.1) hidden tracking-server allow list ─────────────────────────────
// Its allows sit exactly on the extra lists' "@@" step (11.1.3: list priority + STATIC_EXCEPTION_PRIORITY_OFFSET; until
// then they TIED the blocks and won on Chrome's tie-break) — above those lists' blocks and redirects, below their
// $important and far below 9 000. Any other number is a silent, unreviewed change; lower makes every exception dead.
// Then a real rule from the shipped file must actually beat the extra list it was selected for.
const ALLOWLIST_ID = 'ruleset_tracking_servers_allowlist';
if ( B.WORRY_FREE_EXTRA_LISTS_ALLOWLIST_PRIORITY !== B.WORRY_FREE_EXTRA_LISTS_PRIORITY ) {
    fail(`D: WORRY_FREE_EXTRA_LISTS_ALLOWLIST_PRIORITY (${B.WORRY_FREE_EXTRA_LISTS_ALLOWLIST_PRIORITY}) must equal WORRY_FREE_EXTRA_LISTS_PRIORITY (${L})`);
}
{
    const own = rules.filter(r => r._list === ALLOWLIST_ID);
    if ( own.length === 0 ) { fail(`D: ${ALLOWLIST_ID} has no enabled rules`); }
    const atStep = B.WORRY_FREE_EXTRA_LISTS_ALLOWLIST_PRIORITY + B.STATIC_EXCEPTION_PRIORITY_OFFSET;
    const off = own.filter(r => r.action?.type !== 'allow' || r.priority !== atStep);
    if ( off.length ) { fail(`D: ${ALLOWLIST_ID}: ${off.length} rule(s) not an allow at ${atStep}`); }
    // Probe: a site-less, host-only exception (e.g. '||kiplinger.112.2o7.net^') against the extra lists' blocks.
    const probe = own.find(r => !r.condition.initiatorDomains && !r.condition.domainType
        && /^\|\|[a-z0-9.-]+[\^|]?$/.test(r.condition.urlFilter ?? '') && !r.condition.resourceTypes);   // 10.7.6: "||host^" (the separator is kept now)
    if ( probe ) {
        const host = probe.condition.urlFilter.replace(/^\|\||[\^|]$/g, '');
        const req = { url: `https://${host}/x.js`, type: 'script', initiator: CONFIG.INITIATOR };
        const extras = rules.filter(r => EXTRA_LIST_IDS.includes(r._list));
        if ( evaluate(extras, req).outcome !== 'BLOCK' ) { fail(`D: probe ${host} is not blocked by any extra list — selection drifted`); }
        if ( evaluate([ ...extras, probe ], req).outcome !== 'ALLOW' ) { fail(`D: ${ALLOWLIST_ID} exception for ${host} does not beat the extra lists`); }
    } else {
        fail(`D: ${ALLOWLIST_ID}: no site-less host-only exception found to probe`);
    }
}

console.log(`Rules modelled: ${rules.length}; not modelled (skipped, counted): ${JSON.stringify(Object.fromEntries(unmodeled))}`);
if ( findings.length ) {
    console.error(`FAIL: ${findings.length} finding(s)`);
    for ( const f of findings ) { console.error(`  - ${f}`); }
    process.exit(1);
}
console.log(`PASS: extra lists at ${eff}: above every TLD allow and Privacy/Security item, below the off-switch (9 000) and the default lists (10 000), outside the retired band; ladder exact.`);
