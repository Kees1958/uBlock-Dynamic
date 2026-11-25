// ── tools/build/build-state.mjs ───────────────────────────────────────────────────────
// The build's shared mutable state (per-run accumulators, AdGuard-Base hand-off text, phase/step bookkeeping) — one owner, changed only through the functions below.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: BUILD_PHASES, STEP_OK, agBaseBelgianText, agBaseLanguageBucketText, agSpanishGenericText, buildNotices, buildState, droppedBadfilters, droppedGenericDomainQualifiers, droppedPolicyScriptlets, droppedUnsupportedListLines, droppedUnsupportedScriptletScopes, droppedWildcardDomains, expandedWildcardDomains, resetBuildAccumulators, setAgBaseBelgianText, setAgBaseLanguageBucketText, setAgSpanishGenericText, setTopSitesSet, topSitesSet
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).

// Shared state populated as a side effect of ruleset_adguard_base's own
// customFetch (see extractForeignRulesSections())
// and consumed by the sibling FILTER_LISTS entries below
// (ruleset_adguard_dutch and ruleset_adguard_french, both — agBaseBelgianText
// is now duplicated into each, 10.0.6) and the
// language-bucket merge step in build() (see that function's own comment
// on the merge). Requires ruleset_adguard_base to be processed BEFORE any
// of its consumers in the FILTER_LISTS array below — enforced by array
// order, not by any runtime check, so keep that order if this file is
// ever restructured. RELEASE guard: reset at the top of build(), same
// discipline as droppedBadfilters/droppedGenericDomainQualifiers.
export let agBaseBelgianText = null;
export let agBaseLanguageBucketText = new Map();
// (10.0.7) Hand-off from ruleset_adguard_spanish's fetch to ruleset_easylist_portuguese (same
// shared-variable-plus-splice shape as agBaseBelgianText, C21): AdGuard SpanishFilter's two generic
// (non-country-specific) sections plus every line tagged with a Portuguese-speaking-country TLD.
// Requires ruleset_adguard_spanish to be processed BEFORE ruleset_easylist_portuguese (array order).
export let agSpanishGenericText = null;
// (2026-11-09) Hand-offs to ruleset_english_outside_top1m (english-outside-top-sites.mjs), same shape as
// agBaseBelgianText: AdGuard Base's and the anti-adblock list's rules for English/generic sites outside the CrUX top
// 1M (string[] of rule lines). null = not handed over this build (that list failed or was kept from a previous
// build) — the English list then fails and keeps its own previous copy. Both lists come before it (array order).
export let agBaseEnglishText = null;
export let antiadblockEnglishText = null;
// call in one build run (one report file for the whole build, not one per
// list, so it's easy to scan) — see writeDroppedBadfiltersReport() below.
// Cleared at the top of build() (RELEASE guard — same "fresh each build"
// discipline as every other per-run accumulator in this file).
export let droppedBadfilters = [];

// droppedGenericDomainQualifiers — same accumulate-and-report discipline as
// droppedBadfilters above, for the `[$domain=...]` generic cosmetic/
// scriptlet rules that have no static dispatch path (see the comments in
// parseCosmeticRules()/parseScriptletRules()). AdGuard-Base-only in
// practice, but not hardcoded that way — just whatever list happens to
// pass allowGenericDomainQualifier: true. Cleared at the top of build().
export let droppedGenericDomainQualifiers = [];

// droppedUnsupportedScriptletScopes — same accumulate-and-report discipline,
// for scriptlet rule lines whose scope cannot be a plain hostname key:
// bracket-prefixed `[$path=...]host` / `[$url=...]` scopes (kind
// 'bracket-modifier') and negated `~host` entries (kind 'negated-hostname').
// Fed by parseScriptletRules(), written to
// dropped-unsupported-scriptlet-scopes.txt. Cleared at the top of build().
export let droppedUnsupportedScriptletScopes = [];

// droppedUnsupportedListLines (10.1.8) — same accumulate-and-report discipline, for lines of a hand-written list
// (the Quick-fixes list) that this build cannot use: raw-JavaScript rules, CSS injection, procedural filters, network
// rules that do not compile. Shape { list, line, reason }. Fed by parseList() when the list sets
// reportUnsupportedLines, written to dropped-unsupported-list-lines.txt. Cleared at the top of build().
export let droppedUnsupportedListLines = [];

// droppedPolicyScriptlets (10.4.6) — same accumulate-and-report discipline, for scriptlet rules refused by the scriptlet
// policy (js/data/scriptlet-policy.js): a trusted scriptlet from a non-AdGuard source (rule A, removed at download by
// fetch-helpers.mjs), code as argument (rule B) or an inserted external URL (rule C) (both removed per list in
// build-steps.mjs). (11.1.3) A rule-A line replaced by a safe project scriptlet is recorded too, with reason
// REASON_REPLACED. Shape { source, name, args, reason }. Written to dropped-policy-scriptlets.txt. Cleared at the top
// of build().
export let droppedPolicyScriptlets = [];

// droppedWildcardDomains / expandedWildcardDomains — same accumulate-and-
// report discipline as droppedBadfilters above, for the $domain=example.*
// TLD-wildcard tokens resolveWildcardDomainTokens() either drops (no
// in-scope domain of that name in the CrUX snapshot) or expands (to every
// such domain — topSiteDomainsByName(), 10.7.8) — see
// BUGREPORT-domain-wildcard-invalid-dnr-rules.md for the full history. Both cleared at the top of build().
export let droppedWildcardDomains = [];
export let expandedWildcardDomains = [];

// (10.3.0) saferegionsExemptDomains removed — "$saferegions" lines are a retired option, ignored and listed in
// droppedUnsupportedListLines (list-parser.mjs).

// worryfreeExemptDomains (10.0.0) -- the "@@domain$worryfree" lines, collected (same parseList() call, same reset at the top of build()). Written to
// (10.2.0) a carrier allow rule in the quick-fixes ruleset (js/core/builtin-exemption-carriers.js) and merged at runtime by
// js/core/exempt-domains.js (the whole-site allow rules themselves stay dynamic, worryfree-manager.js).
export let worryfreeExemptDomains = [];

// topSitesSet — CrUX top-1M snapshot (see fetchTopSitesSet()/
// isPopularHostname() above), promoted to module scope so
// resolveWildcardDomainTokens() (called deep inside parseList() ->
// parseBlockRule() -> rewriteWildcardDomainOptions(), many call frames down) can read it
// without threading it through every intermediate function signature —
// same "many callers deep down need read access to one per-build
// resource" shape as the other module-scope accumulators here. Populated
// once near the top of build(), released (`= null`) at the end — same
// discipline as every other per-run resource in this file.
export let topSitesSet = null;

// End-of-build notices (tools audit after 9.7.5, items 1 + 2): things the
// person running "update all filters" must see even though the build
// finished — a list carried over from the previous build after its
// download failed twice, an AdGuard scriptlets package update, scriptlet
// names the package lacks. Printed as one block AFTER "Done", so they
// can't scroll away. Reset at the start of every build() run, same
// discipline as the dropped-* accumulators above.
// Shape: { level: 'WARNING' | 'NOTICE', text: string }
export let buildNotices = [];

export const BUILD_PHASES = Object.freeze({
    IDLE:                 'idle',
    INIT:                 'init',
    COOKIE_NOTICES:       'cookie-notices',        // (11.0.0) before LISTS: it needs the CrUX set LISTS releases
    LISTS:                'lists',
    SCRIPTLET_ASSETS:     'scriptlet-assets',
    SCRIPTLET_PRECOMPILE: 'scriptlet-precompile',
    EXCEPTIONS:           'exceptions',
    WRITE_SCRIPTLETS:     'write-scriptlets',
    COOKIE_NOTICE_WRITE:  'cookie-notice-write',   // (11.0.0)
    AD_CLEANER:           'ad-cleaner',            // (11.0.0) Ad leftover cleaner data (independent of the other steps)
    REGISTRY_MANIFEST:    'registry-manifest',
    ORPHAN_CLEANUP:       'orphan-cleanup',
    REPORTS:              'reports',
    DONE:                 'done',
    ERROR:                'error',
});

// What every step returns when it completed. A step that cannot complete
// throws (or, for the documented unrecoverable download case, exits) — it
// never returns a partial result.
export const STEP_OK = Object.freeze({ status: 'ok' });

export const buildState = {
    owner:     'build-rulesets',
    phase:     BUILD_PHASES.IDLE,
    completed: [],      // phases finished, in order — for the error message
};

/******************************************************************************/
// Changing the shared state. ES-module bindings are read-only for importers,
// so every reassignment that used to happen inline in another section of the
// old single file goes through one of these functions instead (each is a
// one-line move of the original assignment — same value, same moment).
/******************************************************************************/

// RELEASE guard: fresh accumulators for every build run — the ten inline
// resets stepInit() used to do, in the same order.
export function resetBuildAccumulators() {
    droppedBadfilters = [];
    droppedGenericDomainQualifiers = [];
    droppedUnsupportedScriptletScopes = [];
    droppedUnsupportedListLines = [];
    droppedPolicyScriptlets = [];
    droppedWildcardDomains = [];
    expandedWildcardDomains = [];
    worryfreeExemptDomains = [];
    topSitesSet = null;
    buildNotices = [];
    agBaseBelgianText = null;
    agBaseLanguageBucketText = new Map();
    agSpanishGenericText = null;
    agBaseEnglishText = null;
    antiadblockEnglishText = null;
}
export function setAgBaseBelgianText(v)       { agBaseBelgianText = v; }
export function setAgBaseLanguageBucketText(v) { agBaseLanguageBucketText = v; }
export function setAgSpanishGenericText(v)     { agSpanishGenericText = v; }
export function setAgBaseEnglishText(v)        { agBaseEnglishText = v; }
export function setAntiadblockEnglishText(v)   { antiadblockEnglishText = v; }
export function setTopSitesSet(v)              { topSitesSet = v; }
