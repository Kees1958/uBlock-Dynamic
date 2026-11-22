/*
 * custom-scriptlets.js — runtime dispatch for user-entered scriptlet rules.
 *
 * See Custom-Rule-Scriptlets-Plan.md for the full design rationale. Short
 * version: a custom rule like `example.com##+js(noeval)` never causes any
 * code to be constructed from a string. `noeval` is looked up (a plain
 * object-key lookup, not code execution) against KNOWN_SCRIPTLET_NAMES —
 * every name in the full ~100-scriptlet @adguard/scriptlets library. Each
 * scriptlet's real, static function body lives in its own small file
 * (js/generated/custom-scriptlets/sN.js — see tools/build-rulesets.mjs's
 * buildCustomScriptletsDispatch()), never imported by this module or any
 * other: only SCRIPTLET_NAME_TO_FILE (a name -> file-path STRING map, in
 * the generated js/generated/custom-scriptlets-dispatch.mjs) is. This is
 * what makes custom-rule scriptlets dispatchable by name with zero
 * `userScripts` permission AND without this service worker ever having to
 * parse ~600KB of scriptlet bodies on cold start just to have one function
 * reference ready (10.6.0 — see injectCustomScriptletsForFrame()'s own
 * header comment below for the two-step file+args injection this enables).
 * Only the name and arguments — plain data — ever travel from storage;
 * the code itself never varies at runtime.
 *
 * Public interface:
 *   isKnownScriptletName(name)              — true/false, cheap validation
 *   getCustomScriptletRules()               — returns stored rules array
 *   addCustomScriptletRule(rule, source)    — validates + stores one rule (returns
 *                                              the existing one instead of a
 *                                              duplicate if content already
 *                                              matches), returns { ok, error?, rule? }
 *   importCustomScriptletRules(rules, source) — same, but for many rules
 *                                              from one payload — batches
 *                                              the stored-rules read/write
 *                                              across the whole set instead
 *                                              of once per rule (OPTIMIZE.md 3.2)
 *   parseScriptletLine(line)                — single parser for BOTH uBO
 *                                              (`##+js(...)`) and AdGuard
 *                                              (`//scriptlet(...)`) syntax;
 *                                              recognizes `#@#`/`#@%#`
 *                                              EXCEPTION syntax (rule.exception),
 *                                              which cancels a same name+args
 *                                              apply rule instead of running —
 *                                              see collectMatchingRules() below
 *   deleteCustomScriptletRule(uid)          — removes one rule by uid (any source)
 *   get/clearPrivacyInspectorScriptletRules() — sources: 'privacy-inspector'
 *                                              AND 'auto-privacy' (merged; see
 *                                              that function's own comment)
 *   maybeRemoveOrphanedPrivacyExtras(hostname) — cascade-deletes a hostname's
 *                                              'auto-privacy' rules once no
 *                                              other Privacy (scriptlet) rule
 *                                              remains for it
 *   deletePrivacyScriptletRulesMatching(filter) — Manage Custom Rules'
 *                                              "Delete rules" button
 *   injectCustomScriptletsForFrame(details) — called on navigation; looks up
 *                                              and dispatches matching rules
 *                                              for one committed frame, after
 *                                              first checking the hostname's
 *                                              filtering mode isn't OFF
 *
 * Also exports isSameRuleContent()/collectMatchingRules() — NOT part of the
 * functional interface above, kept internal-use in spirit; exported only so
 * tools/check-scriptlet-exception-logic.mjs can assert against the real
 * implementation instead of a hand-copy that could drift from it.
 */

import { browser, localRead, localWrite } from '../data/ext.js';
import { SCRIPTLET_NAME_TO_FILE, KNOWN_SCRIPTLET_NAMES } from '../generated/custom-scriptlets-dispatch.mjs';
import { scriptletRuleRejection } from '../data/scriptlet-policy.js';
import { todayISODate, isValidISODate, isValidHostnamePattern, isBoundedString } from '../util/utils.js';
import { getFilteringMode, MODE_NONE } from './mode-manager.js';
import { CUSTOM_SCRIPTLET_MAX } from './dnr-budgets.js';
import { REJECTED_LINE_PREFIX } from '../data/editor-annotations.js';
import { POPUP_OPTION_REJECTION, isPopupOptionLine, parsePopunderLine } from '../util/popunder-parser.js';

// Input-validation bounds for addCustomScriptletRule() — see its own
// comment. Same per-string length as filter-manager.js's
// CUSTOM_SELECTOR_MAX_LENGTH (2 000) for consistency across the two
// custom-rule stores; ARGS_MAX_COUNT is this store's own concern (a
// selector is one string, a scriptlet call is name + an argument list).
const CUSTOM_SCRIPTLET_ARG_MAX_LENGTH = 2_000;
const CUSTOM_SCRIPTLET_ARGS_MAX_COUNT = 20;

/******************************************************************************/
// Config — single source of truth for the storage key and hostname-matching
// rule, per this project's config-in-one-place convention.
/******************************************************************************/

const STORAGE_KEY = 'customScriptletRules';

// A rule's `hostname` matches a page if the page's hostname equals it OR is
// a subdomain of it — same convention as the monitor's own domain-scoped
// block rules and the security scriptlets' allowlist matching.
export function hostnameMatches(pageHostname, ruleHostname) {
    if ( !ruleHostname || ruleHostname === '*' ) { return true; }  // unscoped ("all sites") rule
    if ( pageHostname === ruleHostname ) { return true; }
    return pageHostname.endsWith(`.${ruleHostname}`);
}

const KNOWN_NAMES_SET = new Set(KNOWN_SCRIPTLET_NAMES);

// Rule-identity comparator — single source of truth for "is this the same
// rule" used both when preventing a new duplicate (addCustomScriptletRule)
// and when collapsing duplicates already sitting in storage
// (getCustomScriptletRules' migration). Deliberately compares by
// hostname + name + args VALUE, not by `uid` (assigned per-call, so it can
// never match a distinct write of identical content) and not by `source`
// (a Sandbox-authored rule and a Privacy-Inspector-authored rule with the
// same hostname/name/args are still the same effective mitigation and
// should not both be kept).
// Exported (in addition to being used internally below) solely so
// tools/check-scriptlet-exception-logic.mjs can assert against the real
// implementation instead of a hand-maintained copy that could silently
// drift from it — no other caller outside this file should use it; it's
// not part of the feature's functional public interface described above.
export function isSameRuleContent(a, b) {
    if ( a.hostname !== b.hostname || a.name !== b.name ) { return false; }
    // An apply rule and an exception rule for the identical hostname/name/
    // args are opposites, not duplicates — never collapse one into the
    // other, or an exception could silently absorb/replace the very apply
    // rule it's meant to cancel.
    if ( (a.exception === true) !== (b.exception === true) ) { return false; }
    const argsA = Array.isArray(a.args) ? a.args : [];
    const argsB = Array.isArray(b.args) ? b.args : [];
    if ( argsA.length !== argsB.length ) { return false; }
    return argsA.every((value, index) => value === argsB[index]);
}

/******************************************************************************/
// Validation — the entire safety boundary for this feature. See the file
// header: only names that were embedded as real, static functions at build
// time (KNOWN_SCRIPTLET_NAMES) are ever allowed to be dispatched.
/******************************************************************************/

// (10.4.6) The trust and Manifest V3 decisions live in ONE place, js/data/scriptlet-policy.js, shared with the build
// and the suite. It replaces DELIBERATELY_EXCLUDED_SCRIPTLET_NAMES, a documentation-only constant that no code read
// and that missed every AdGuard `trusted-*` scriptlet the library actually contains. Own rules (Custom Rules, ABP
// import, Privacy Inspector) are not an AdGuard source, so scriptletRuleRejection() refuses every trusted scriptlet
// there (owner's decision), and code as argument / inserted external URLs for every scriptlet.
export function isKnownScriptletName(name) {
    return typeof name === 'string' && KNOWN_NAMES_SET.has(name);
}

/******************************************************************************/
// Storage — same uid-based pattern as js/core/block-monitor.js's monitor
// block rules, for the same reason: once a rule can carry more than one
// distinguishing field (here: hostname + name + args), matching for
// delete/dedup by those fields alone gets ambiguous. A stable uid,
// assigned once at creation, isn't.
/******************************************************************************/

export async function getCustomScriptletRules() {
    const stored = await localRead(STORAGE_KEY);
    let rules = Array.isArray(stored) ? stored : [];

    // Migration: rules created via addCustomScriptletRule() before 5.0.14
    // have no `source` field at all (that fix added source: 'privacy-inspector'
    // going forward). The only two writers of this storage are that function
    // and syncScriptletRulesFromSandboxText() (which has always set
    // source: 'sandbox'), so any rule missing `source` entirely can only
    // have come from the pre-fix Privacy Inspector path — safe to backfill.
    // Without this, such a rule stays invisible to the dashboard's
    // "Manage custom rules" list AND remains exposed to the exact silent-wipe
    // bug 5.0.14 fixed for new rules (syncScriptletRulesFromSandboxText's
    // fromOtherSources filter requires a truthy `source` to preserve a rule).
    let migrated = false;
    for ( const rule of rules ) {
        if ( !rule.source ) { rule.source = 'privacy-inspector'; migrated = true; }
    }

    // Migration: collapse rules that were duplicated before 5.0.2's dedup
    // guard in addCustomScriptletRule() existed (e.g. Privacy Inspector's
    // "Select" clicked on two log rows that resolved to the same
    // hostname/scriptlet/args — see isSameRuleContent()). Keeps the first
    // occurrence (oldest uid) of each distinct hostname+name+args
    // combination so existing uid references (e.g. an open dashboard list)
    // stay stable; every later duplicate is dropped.
    const seen = [];
    const deduped = rules.filter(rule => {
        const isDuplicate = seen.some(kept => isSameRuleContent(kept, rule));
        if ( isDuplicate ) { migrated = true; return false; }
        seen.push(rule);
        return true;
    });
    rules = deduped;

    if ( migrated ) {
        await writeCustomScriptletRules(rules);
    }

    return rules;
}

async function writeCustomScriptletRules(rules) {
    await localWrite(STORAGE_KEY, rules);
    // Single choke point for cache invalidation: every mutation path in this
    // file (addCustomScriptletRule, deleteCustomScriptletRule,
    // clearScriptletRulesBySource, syncScriptletRulesFromSandboxText) already
    // funnels through this one function to write to storage — refreshing
    // the index here, rather than separately at each of those call sites,
    // makes "forgot to invalidate after a write" structurally impossible
    // instead of something to remember per caller.
    await refreshCustomScriptletRuleIndex(rules);
}

/******************************************************************************/
// Rule-matching cache — avoids re-reading storage and re-deduping the full
// rule list on every single committed navigation/frame (which is what
// getCustomScriptletRules() alone would cost, called from
// injectCustomScriptletsForFrame() as it used to be). Built once, refreshed
// only when the underlying rules actually change (via writeCustomScriptletRules()
// above), not on every read.
/******************************************************************************/

// In-memory only — lost on service worker restart, same as this project's
// other per-session caches (e.g. mode-manager.js's readFilteringModeDetails
// cache). Self-heals via ensureCustomScriptletRuleIndex()'s lazy-build check
// below: a restart just means the next call rebuilds it, not a stale-forever
// cache.
let customScriptletRuleIndex;

function buildRuleIndex(rules) {
    const index = new Map();
    for ( const rule of rules ) {
        const hostname = rule.hostname || '*';
        let bucket = index.get(hostname);
        if ( bucket === undefined ) {
            bucket = [];
            index.set(hostname, bucket);
        }
        bucket.push(rule);
    }
    return index;
}

async function refreshCustomScriptletRuleIndex(rules) {
    try {
        if ( rules === undefined ) { rules = await getCustomScriptletRules(); }
        customScriptletRuleIndex = buildRuleIndex(rules);
    } catch (reason) {
        // Guard: a failed refresh must not corrupt or blank out an index
        // that was already working — leave whatever's currently cached
        // (possibly still `undefined` on a first-ever call, which
        // ensureCustomScriptletRuleIndex() below will simply retry on its
        // next call) rather than let one storage hiccup silently stop
        // every custom scriptlet rule from matching until the next edit.
        console.error('[uBlock-Dynamic] refreshCustomScriptletRuleIndex:', reason);
    }
}

async function ensureCustomScriptletRuleIndex() {
    if ( customScriptletRuleIndex === undefined ) {
        await refreshCustomScriptletRuleIndex();
    }
    return customScriptletRuleIndex;
}

// Rule-signature key for exception matching — name + args VALUE, same
// fields isSameRuleContent() compares (minus hostname, since an exception
// cancels an apply rule by what it *does*, at whatever level in the
// hostname chain either one was declared; both are already scoped to the
// current page by the caller's hostname walk below).
function exceptionKey(r) { return `${r.name}\u0000${(Array.isArray(r.args) ? r.args : []).join('\u0000')}`; }

// Mirrors hostnameMatches()'s exact semantics (page hostname equals the
// rule's hostname, or is a subdomain of it) but as an O(levels) walk up
// pageHostname's own ancestor chain against O(1) exact-key lookups in the
// index, instead of hostnameMatches()'s O(1)-per-rule endsWith() check
// repeated over every stored rule.
//
// Exported for the same test-only reason as isSameRuleContent() above —
// see that function's comment. buildRuleIndex() (its usual companion) is
// deliberately NOT exported alongside it: the check constructs its own
// index literally (a plain Map) rather than depending on that helper too,
// since the goal is to pin collectMatchingRules()'s exception-cancellation
// CONTRACT, not its indexing implementation detail.
export function collectMatchingRules(index, pageHostname) {
    const result = [];

    const globalRules = index.get('*');
    if ( globalRules !== undefined ) { result.push(...globalRules); }

    let current = pageHostname;
    for ( ;; ) {
        const rules = index.get(current);
        if ( rules !== undefined ) { result.push(...rules); }
        const dot = current.indexOf('.');
        if ( dot === -1 ) { break; }
        current = current.slice(dot + 1);
    }

    // Exception pass — an exception rule (`#@#+js(...)` / `#@%#//scriptlet(...)`)
    // cancels any apply rule with the same name+args among this same
    // matched set, then is itself dropped: exceptions are never dispatched,
    // they only suppress. Cheap in practice — this set is the handful of
    // rules already matched for one page, not the full stored rule list.
    const hasExceptions = result.some(r => r.exception === true);
    if ( !hasExceptions ) { return result; }
    const cancelled = new Set(result.filter(r => r.exception === true).map(exceptionKey));
    return result.filter(r => r.exception !== true && !cancelled.has(exceptionKey(r)));
}

// ─────────────────────────────────────────────────────────────────────────
// Auto-apply "extra" privacy protections — formerly two standalone global
// toggles (blockWindowName / blockVisibilityChange in Privacy & Security),
// then (until 7.0.0) gated behind a third manual dashboard toggle
// (autoApplyPrivacyExtras), now unconditional: writing ordinary custom
// scriptlet rules the moment the user clicks Privacy Inspector's "Block
// All" button specifically — not on every individual "Select" click, and
// not for sandbox-authored rules. The manual toggle was removed because it
// was pure friction for a low-breakage-risk pair of mitigations the user
// had already signaled they wanted by clicking Block All in the first
// place; "Block All" itself remains the actual condition — see caller
// (blockAll() in privacy-inspector.js), which only sends the
// MSG_APPLY_PRIVACY_EXTRAS message this function responds to when at least
// one rule was just written for that hostname, so this never fires for a
// domain with zero Privacy Inspector rules. "Block All" is the signal that
// the user has decided this whole site needs privacy hardening, which is
// the right moment for these two low-breakage-risk extras to come along;
// a single "Select" on one specific detected event is a narrower, more
// targeted decision that shouldn't carry the same implication.
//
// Both mitigations are real, already-shipped AdGuard corelib scriptlets —
// no new dispatch mechanism needed:
//   - window.name snooping:  set-constant('name', '') — pins window.name to
//     an empty string and traps further writes, stronger than the old
//     clear-once-at-document_start approach.
//   - Tab monitoring:        prevent-addEventListener('visibilitychange') —
//     identical behavior to the retired sec-vischange.js, just delivered
//     through the standard custom-scriptlet-rule pathway instead of its own
//     dedicated always-on content script.
//
// These rules are just as removable by hand afterward as any other Privacy
// (scriptlet) rule — see maybeRemoveOrphanedPrivacyExtras() below for the
// counterpart cleanup that runs when a user deletes rules down to none for
// a given hostname.
//
// Called explicitly by the background message handler for "Block All"
// (see handleApplyPrivacyExtras() in background.js) — NOT wired into
// addCustomScriptletRule() itself, so ordinary Select clicks and
// sandbox-authored rules never trigger it.
const AUTO_PRIVACY_SOURCE = 'auto-privacy';
const AUTO_PRIVACY_RULES = [
    { name: 'set-constant',              args: [ 'name', '' ] },
    { name: 'prevent-addEventListener',  args: [ 'visibilitychange' ] },
];

export async function applyPrivacyExtrasForHost(hostname) {
    if ( !hostname || hostname === '*' ) { return; } // only meaningful for one specific site
    for ( const { name, args } of AUTO_PRIVACY_RULES ) {
        await addCustomScriptletRule({ hostname, name, args }, AUTO_PRIVACY_SOURCE);
    }
}

// REMOVED (v8.5.7) — the "Worry-free global privacy scriptlets" block
// that lived here (nowebrtc/prevent-canvas/tz-fingerprint/idle/nfc,
// applied sitewide via hostname '*' for the duration of a Worry-free
// session, plus a per-site exception list for nytimes.com's own WebGL
// use) has been removed entirely, per explicit request. The exported
// functions `applyWorryFreeGlobalPrivacyScriptlets()`/
// `removeWorryFreeGlobalPrivacyScriptlets()` and their INIT/RELEASE call
// sites in cookie-clicker-autodeny-manager.js were removed together with
// this block — see that file's own comments and CHANGELOG for the full
// account. The generic exception-rule capability added to
// addCustomScriptletRule() to support the nytimes.com case (threading a
// caller-supplied `exception` flag through to the stored rule) was NOT
// reverted — it's a genuinely reusable capability or is used elsewhere.

// REMOVED (v8.4.10) — the coveryourtracks.eff.org-only "test-site extras"
// layer that lived here was superseded by the curated high-risk site list's
// protections, which were themselves removed in 10.3.0 (moved to 3P-Matrix).
// See CHANGELOG_HISTORY.md.

// Counterpart cleanup to applyPrivacyExtrasForHost() above. The two
// auto-privacy rules are visible and individually deletable in Manage
// Custom Rules → Privacy (scriptlet) rules, same as any other row (see
// getPrivacyInspectorScriptletRules() below — both sources are merged into
// one list there, deliberately, with no visual distinction). That creates a
// real "last rule for this domain" ambiguity: a domain's auto-privacy rules
// are themselves part of what makes that list non-empty, so "no rules left
// for this domain" can only mean "no rules besides the auto-privacy pair
// itself" — counting the auto-privacy rules in their own removal condition
// would mean this could never fire. Call after any per-rule delete (or a
// clear-all, though that already removes everything indiscriminately and
// needs no extra step here) that affects Privacy (scriptlet) rules, passing
// the hostname of the rule that was just removed.
export async function maybeRemoveOrphanedPrivacyExtras(hostname) {
    if ( !hostname || hostname === '*' ) { return; }
    const stored = await getCustomScriptletRules();
    const hasRemainingRealRule = stored.some(rule =>
        rule.hostname === hostname && rule.source !== AUTO_PRIVACY_SOURCE
    );
    if ( hasRemainingRealRule ) { return; }
    const withoutOrphanedExtras = stored.filter(rule =>
        !(rule.hostname === hostname && rule.source === AUTO_PRIVACY_SOURCE)
    );
    if ( withoutOrphanedExtras.length === stored.length ) { return; } // nothing to remove — guard against a needless write
    await writeCustomScriptletRules(withoutOrphanedExtras);
}

// Shared by addCustomScriptletRule() (single-rule public API, below) and
// importCustomScriptletRules() (OPTIMIZE.md 3.2, further below) — kept as
// one function so the two callers can never validate a candidate
// differently. Pure: no storage access, just the name/hostname/args
// checks and candidate shaping.
function validateScriptletRuleCandidate(rule) {
    const { hostname, name, args } = rule ?? {};
    if ( !isKnownScriptletName(name) ) {
        return {
            ok: false,
            error: `Unknown scriptlet name "${name}" — only names from AdGuard's/uBO's ` +
                   `scriptlet library are supported without enabling user scripts.`,
        };
    }
    // (10.4.6) Scriptlet policy — an exception only cancels a rule and runs nothing, so it is not checked.
    if ( rule?.exception !== true ) {
        const rejection = scriptletRuleRejection(name, Array.isArray(args) ? args : []);
        if ( rejection !== null ) { return { ok: false, error: rejection }; }
    }
    const candidateHostname = hostname || '*';
    if ( isValidHostnamePattern(candidateHostname) === false ) {
        return { ok: false, error: `Invalid hostname "${hostname}".` };
    }
    const candidateArgs = Array.isArray(args) ? args : [];
    if ( candidateArgs.length > CUSTOM_SCRIPTLET_ARGS_MAX_COUNT ||
         candidateArgs.some(a => isBoundedString(a, CUSTOM_SCRIPTLET_ARG_MAX_LENGTH) === false) ) {
        return { ok: false, error: 'Invalid or excessive scriptlet arguments.' };
    }
    return {
        ok: true,
        candidate: { hostname: candidateHostname, name, args: candidateArgs, exception: rule?.exception === true },
    };
}

// rule: { hostname, name, args }. hostname may be '*' for "all sites".
// source identifies which feature created the rule (currently
// 'privacy-inspector' or 'auto-privacy') — required, not defaulted, so
// every caller is explicit about it. Sandbox-authored rules are tagged
// 'sandbox' by syncScriptletRulesFromSandboxText() instead of this
// function. Returns { ok: true, rule } with the uid assigned, or
// { ok: false, error } if the name isn't recognized — callers (the
// dashboard editor, the picker overlay) must surface `error` inline and
// must NOT store or attempt to dispatch a rejected rule.
// Input validation (C6) — added by the security-audit pass that found
// this boundary validated `name` (via isKnownScriptletName below) but not
// `hostname` or `args` (Security_evaluatie.md's Medium finding #2). The
// name→function mapping stays the primary security barrier (a rejected
// name never reaches chrome.scripting.executeScript at all — see this
// file's own header), but hostname/args reaching storage unchecked was
// still a real gap: a malformed hostname can never legitimately match a
// real page (harmless on its own) but an unbounded args array/string is
// exactly the kind of pathological single entry CUSTOM_SCRIPTLET_MAX's
// count cap doesn't protect against, same reasoning as filter-manager.js's
// addCustomFilters() sibling fix.
export async function addCustomScriptletRule(rule, source) {
    const validated = validateScriptletRuleCandidate(rule);
    if ( !validated.ok ) { return validated; }
    const { candidate } = validated;
    const stored = await getCustomScriptletRules();
    if ( stored.length >= CUSTOM_SCRIPTLET_MAX ) {
        return { ok: false, error: 'Custom scriptlet rule limit reached.' };
    }

    // Dedup guard — e.g. Privacy Inspector's "Select" button can be clicked
    // on two separate log rows that resolve to the same mitigation (same
    // category → same scriptlet, same hostname), which would otherwise push
    // a second, functionally-identical rule with only a new uid. Return the
    // existing rule instead of storing another copy — it already carries
    // its own (earlier, correct) createdAt, nothing to do here for that.
    const existingRule = stored.find(rule => isSameRuleContent(rule, candidate));
    if ( existingRule ) {
        return { ok: true, rule: existingRule };
    }

    const newRule = {
        uid: `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        source,
        // Accepts a caller-supplied date (Import, preserving the
        // exported rule's original creation date) if it looks valid,
        // else stamps today — the normal "created just now" case for
        // every other caller (Privacy Inspector's Select button,
        // sandbox-authored rules).
        createdAt: isValidISODate(rule?.createdAt) ? rule.createdAt : todayISODate(),
        ...candidate,
    };
    stored.push(newRule);
    await writeCustomScriptletRules(stored);
    return { ok: true, rule: newRule };
}

// Bulk counterpart to addCustomScriptletRule() above, for Manage Custom
// Rules' Import / Settings restore importing many rules from one payload
// (see OPTIMIZE.md 3.2). Same validation, cap check, and dedup logic as
// addCustomScriptletRule() (via the shared validateScriptletRuleCandidate()
// helper above) — but against ONE read-and-mutate-in-memory pass over the
// stored rules array, writing once at the end instead of once per rule.
// Returns an array of { ok, error? , rule? } results, one per input rule,
// in the same order.
export async function importCustomScriptletRules(rules, source) {
    const stored = await getCustomScriptletRules();
    const results = [];
    let changed = false;
    for ( const rule of rules ) {
        const validated = validateScriptletRuleCandidate(rule);
        if ( !validated.ok ) { results.push(validated); continue; }
        const { candidate } = validated;
        if ( stored.length >= CUSTOM_SCRIPTLET_MAX ) {
            results.push({ ok: false, error: 'Custom scriptlet rule limit reached.' });
            continue;
        }
        const existingRule = stored.find(r => isSameRuleContent(r, candidate));
        if ( existingRule ) {
            results.push({ ok: true, rule: existingRule });
            continue;
        }
        const newRule = {
            uid: `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            source,
            createdAt: isValidISODate(rule?.createdAt) ? rule.createdAt : todayISODate(),
            ...candidate,
        };
        stored.push(newRule);
        changed = true;
        results.push({ ok: true, rule: newRule });
    }
    if ( changed ) { await writeCustomScriptletRules(stored); }
    return results;
}

export async function deleteCustomScriptletRule(uid) {
    const stored = await getCustomScriptletRules();
    const filtered = stored.filter(r => r.uid !== uid);
    await writeCustomScriptletRules(filtered);
    return filtered;
}

// Dashboard "Manage custom rules" pane sections each only ever operate on
// their own source's rules — sandbox-sourced rules are already managed
// through the ABP-import editor itself and must not be touched by any of
// these, or a "Clear all" click in one section would silently wipe rules
// belonging to a different feature entirely.
async function getScriptletRulesBySource(sources) {
    const wanted = new Set(Array.isArray(sources) ? sources : [ sources ]);
    const stored = await getCustomScriptletRules();
    return stored.filter(r => wanted.has(r.source));
}

async function clearScriptletRulesBySource(sources) {
    const wanted = new Set(Array.isArray(sources) ? sources : [ sources ]);
    const stored = await getCustomScriptletRules();
    const filtered = stored.filter(r => !wanted.has(r.source));
    await writeCustomScriptletRules(filtered);
    return filtered;
}

// The "Privacy (scriptlet) rules" section in Manage Custom Rules shows
// rules the user picked directly (source: 'privacy-inspector'), the two
// auto-applied extras (source: 'auto-privacy', see applyPrivacyExtrasForHost
// above), AND rules brought in via Manage Custom Rules' Import feature
// (source: 'import', see js/workflow/background.js's
// handleImportCustomRules) — all visible and removable like any other
// row, not hidden bookkeeping. Sandbox-authored rules stay excluded (see
// getScriptletRulesBySource()'s own comment for why). One constant, not
// three separate literal-array copies between get/clear below, so a
// future source can't be added to one and forgotten in the other.
const PRIVACY_SCRIPTLET_SOURCES = Object.freeze([ 'privacy-inspector', AUTO_PRIVACY_SOURCE, 'import' ]);

export function getPrivacyInspectorScriptletRules() {
    return getScriptletRulesBySource(PRIVACY_SCRIPTLET_SOURCES);
}

export function clearPrivacyInspectorScriptletRules() {
    return clearScriptletRulesBySource(PRIVACY_SCRIPTLET_SOURCES);
}

// Manage Custom Rules' "Delete rules" toolbar button — same
// PRIVACY_SCRIPTLET_SOURCES scope as the two functions just above
// (sandbox-authored rules stay untouched), deletes every rule whose
// hostname CONTAINS filter (case-insensitive), or every rule in scope
// when filter is '' (no filter active = delete all). Returns the count
// actually deleted.
export async function deletePrivacyScriptletRulesMatching(filter) {
    const needle = (filter ?? '').toLowerCase();
    const wanted = new Set(PRIVACY_SCRIPTLET_SOURCES);
    const stored = await getCustomScriptletRules();
    const toDelete = stored.filter(rule =>
        wanted.has(rule.source) && (needle === '' || rule.hostname.toLowerCase().includes(needle))
    );
    if ( toDelete.length === 0 ) { return 0; }
    const doomedUids = new Set(toDelete.map(rule => rule.uid));
    const remaining = stored.filter(rule => !doomedUids.has(rule.uid));
    await writeCustomScriptletRules(remaining);
    return toDelete.length;
}

// (10.0.3) backfillScriptletRuleDates() — the one-time migration step
// that stamped a createdAt date onto any rule that predated date-tracking
// — was removed along with every other pre-10.0.3 upgrade step; see
// CHANGELOG_HISTORY.md's 10.0.3 entry.

/******************************************************************************/
// Sandbox-text parsing — extracts scriptlet rules from the dashboard's
// existing Sandbox editor free-text box (js/core/filter-manager.js's
// getSandboxFilters/setSandboxFilters). Two rule syntaxes are recognized:
//
//   uBO:      hostname##+js(name, arg1, arg2)
//   AdGuard:  hostname(,hostname)*#%#//scriptlet('name', 'arg1', 'arg2')
//
// KNOWN LIMITATION: this uses a deliberately simplified argument splitter
// (splitScriptletArgs() below), not the same robust argument parser
// static-filtering-parser.js uses (js/core/arglist-parser.js's
// ArglistParser) — reusing that here isn't possible without violating
// this project's five-tier dependency model (js/ui/ is a HIGHER tier
// than js/core/; core/ may not import from ui/ — see ARCHITECTURE.md).
// splitScriptletArgs() IS quote-aware — a comma inside a quoted argument
// is not treated as a separator; still simplified relative to
// ArglistParser (e.g. no escaped-quote handling), but correct for the
// common case.
/******************************************************************************/

// ── Scriptlet line syntax — one parser for both uBO and AdGuard forms ───────
//
// hostname(,hostname)*##+js(name, arg1, arg2)              — uBO, apply
// hostname(,hostname)*#@#+js(name, arg1, arg2)             — uBO, exception
// hostname(,hostname)*#%#//scriptlet('name', 'arg1', 'arg2')  — AdGuard, apply
// hostname(,hostname)*#@%#//scriptlet('name', 'arg1', 'arg2') — AdGuard, exception
//
// Previously two near-identical regexes/functions (parseScriptletLine() for
// uBO, parseAdGuardScriptletLine() for AdGuard), tried one after the other
// by the only real caller (syncScriptletRulesFromSandboxText() below). Two
// real differences justified consolidating them into one:
//   1. The uBO parser's argument splitting was a naive `.split(',')` — a
//      quoted argument containing a literal comma (e.g. `json-prune, 'a,b',
//      c`) parsed WRONG when written in uBO syntax but correctly when
//      written in AdGuard syntax, purely because of which marker was used.
//      Both syntaxes now go through the same quote-aware splitScriptletArgs().
//   2. The uBO parser's hostname group (`[^#,\s]+`) disallowed commas,
//      meaning uBO-syntax lines couldn't target multiple hostnames the way
//      real uBO syntax (and this project's own AdGuard parser) allows.
//      Both syntaxes now share the same comma-separated hostname-list
//      handling — a real, if minor, capability gain for uBO-syntax lines,
//      not just a refactor.
// Single regex, alternating only on the call marker (`#+js(` vs
// `%#//scriptlet(`) — everything else (hostname list, optional `@`
// exception marker, argument body) is shared structure, so the two forms
// can never drift out of sync with each other the way two separate
// regexes eventually would.
const SCRIPTLET_LINE_RE = /^([^#]+)#(@?)(?:#\+js|%#\/\/scriptlet)\((.*)\)$/;

// Splits a scriptlet call's argument list on top-level commas only — a
// comma inside a quoted argument (single or double quotes) does not
// split. Quote characters themselves are stripped from each argument.
// Name kept syntax-neutral (not "AdGuard") now that both uBO- and
// AdGuard-syntax lines share this same splitter — see this section's own
// header comment for why unifying this specifically was the point.
function splitScriptletArgs(argsText) {
    const args = [];
    let current = '';
    let quoteChar = null;
    for ( let i = 0; i < argsText.length; i++ ) {
        const ch = argsText[i];
        if ( quoteChar !== null ) {
            if ( ch === quoteChar ) { quoteChar = null; }
            else { current += ch; }
            continue;
        }
        if ( ch === '\'' || ch === '"' ) { quoteChar = ch; continue; }
        if ( ch === ',' ) { args.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    const last = current.trim();
    if ( last !== '' || args.length > 0 ) { args.push(last); }
    return args;
}

// Returns:
//   null              — line is not scriptlet syntax (uBO or AdGuard) at all
//   { error }         — syntax matched but the rule can't be represented
//                        (exception domain, missing name, etc.)
//   { rules: [...] }  — one entry per hostname (multi-domain expansion —
//                        for a single-hostname line this is just a
//                        1-element array, not a special case)
export function parseScriptletLine(line) {
    const m = SCRIPTLET_LINE_RE.exec(line.trim());
    if ( !m ) { return null; }

    const exception = m[2] === '@';
    const hostnames = m[1].trim().split(',').map(s => s.trim().toLowerCase()).filter(s => s !== '');
    if ( hostnames.length === 0 ) {
        return { error: 'Scriptlet rule has no domain' };
    }
    // Exception DOMAINS (a `~`-prefixed hostname in the comma list, as
    // opposed to the `#@#`/`#@%#` exception RULE marker above) are
    // deliberately NOT supported: this rule schema/hostnameMatches() only
    // understands a single positive hostname or '*', with no "apply
    // everywhere except these" concept. Silently dropping the exclusion
    // and applying to the rest would widen the rule's scope beyond what
    // the filter author intended, which is worse than refusing outright —
    // so any exclusion token rejects the whole line with a clear reason
    // instead. '*' itself (apply to all sites) is NOT rejected here —
    // unlike the cosmetic-rule parser's exclusion of it, which guards
    // against a global CSS selector accidentally hiding legitimate
    // content site-wide. A scriptlet applied everywhere carries no
    // equivalent risk; it's exactly what the built-in Privacy & Security
    // toggles already do by default.
    const exceptionDomains = hostnames.filter(h => h.startsWith('~'));
    if ( exceptionDomains.length > 0 ) {
        return {
            error: `Exception domain(s) not supported here: ${exceptionDomains.join(', ')} ` +
                   `— split into a separate include-only rule instead`,
        };
    }

    const args = splitScriptletArgs(m[3]);
    const name = args.shift();
    if ( !name ) {
        return { error: 'Scriptlet call has no scriptlet name' };
    }

    return { rules: hostnames.map(hostname => ({ hostname, name, args, exception })) };
}

// Replaces (not appends to) the sandbox-derived subset of stored rules with
// whatever the CURRENT sandbox text parses to — so editing or deleting a
// line in the editor is correctly reflected, not just additive. Rules from
// any other source (currently: Privacy Inspector, tagged
// source: 'privacy-inspector' by addCustomScriptletRule()) are left
// untouched — they were previously silently dropped here because they had
// no `source` field at all, and this filter only preserved rules whose
// `source` was truthy.
//
// Every rejected line is ALSO annotated directly in the returned `text`:
// the offending line is commented out (`!` prefix, the same comment
// convention this editor already recognizes — see updateView() in
// dashboard/filter-manager-ui.js) and a `!` explanation line is inserted
// immediately below it. This replaces silently dropping the line (the
// previous behavior) with something visible in the editor itself, not
// just a console.warn only the developer console would show. Idempotent:
// a line already commented out is left untouched on the next save (the
// `t.startsWith('!')` check below short-circuits before any parsing), so
// re-saving never stacks a second annotation under the first.
//
// Returns { added, rejected, text } — `text` is what the caller should
// persist in place of the raw input text.
export async function syncScriptletRulesFromSandboxText(text) {
    const added = [];
    const rejected = [];
    const outputLines = [];

    for ( const rawLine of (text ?? '').split(/\r\n|\r|\n/) ) {
        const t = rawLine.trim();
        if ( t === '' || t.startsWith('!') || t.startsWith('#') ) {
            outputLines.push(rawLine);
            continue;
        }

        function reject(error) {
            rejected.push({ line: t, error });
            outputLines.push(`!${rawLine}`);
            outputLines.push(`${REJECTED_LINE_PREFIX}${error}`);
        }

        // (10.7.2 branch, merged in 10.7.5) uBD's pop-up / pop-under lines (js/util/popunder-parser.js), checked
        // BEFORE the scriptlet parser:
        //   prevent-popunder — a setting in scriptlet form for the tab-under guard (js/core/tab-under-guard.js), kept
        //                      as written when valid; never registered as an injectable scriptlet
        //   $popup/$popunder — not supported (owner's decision): commented out with the reason, like any refused line
        if ( isPopupOptionLine(t) ) {
            reject(POPUP_OPTION_REJECTION);
            continue;
        }
        const popunderResult = parsePopunderLine(t);
        if ( popunderResult !== null ) {
            if ( popunderResult.ok ) { outputLines.push(rawLine); } else { reject(popunderResult.reason); }
            continue;
        }

        const scriptletResult = parseScriptletLine(t);
        if ( scriptletResult !== null ) {
            if ( scriptletResult.error ) {
                reject(scriptletResult.error);
                continue;
            }
            const unknown = scriptletResult.rules.find(r => !isKnownScriptletName(r.name));
            if ( unknown ) {
                reject(`Unknown scriptlet name "${unknown.name}"`);
                continue;
            }
            // (10.4.6) Scriptlet policy, same check as validateScriptletRuleCandidate() above.
            const refused = scriptletResult.rules
                .filter(r => r.exception !== true)
                .map(r => scriptletRuleRejection(r.name, r.args ?? []))
                .find(message => message !== null);
            if ( refused !== undefined ) {
                reject(refused);
                continue;
            }
            added.push(...scriptletResult.rules);
            outputLines.push(rawLine);
            continue;
        }

        // Matches neither syntax — not a scriptlet line at all (plain
        // cosmetic/network filter, etc.) — not this function's concern.
        outputLines.push(rawLine);
    }

    const stored = await getCustomScriptletRules();
    const fromOtherSources = stored.filter(r => r.source && r.source !== 'sandbox');
    const rebuilt = [
        ...fromOtherSources,
        ...added.map(r => ({
            uid: `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            source: 'sandbox',
            hostname: r.hostname,
            name: r.name,
            args: r.args,
            exception: r.exception === true,
        })),
    ];
    await writeCustomScriptletRules(rebuilt);

    return { added: added.length, rejected, text: outputLines.join('\n') };
}

/******************************************************************************/
// Dispatch — called on every committed navigation (see
// js/workflow/background.js's webNavigation.onCommitted listener). Looks up
// which stored rules apply to this frame's hostname and, only if there's
// at least one match, injects them — never registerContentScripts, since the
// set of matching rules is data that can change per navigation.
//
// (10.6.0) TWO executeScript calls per matching directive, not one, because the scriptlet body itself now lives
// in its own FILE (js/generated/custom-scriptlets/sN.js — see this module's own header and
// buildCustomScriptletsDispatch()'s header for why) rather than a function reference this module holds, and
// executeScript's `files` option has no `args` channel the way `func` does:
//   1. a tiny inline shim (setCustomScriptletArgsForFrame, defined just below, NOT generated — it has nothing
//      to do with any one scriptlet) runs via `func`+`args`, writing this ONE frame's (source, args) pair into
//      a single-slot global on that frame.
//   2. the matching file is then injected via `files`; its own top-of-file code (rendered at build time —
//      see renderCustomScriptletFile() in tools/build/custom-scriptlets-dispatch.mjs) reads and immediately
//      deletes that slot, then calls the scriptlet body with it.
//
// RACE GUARD: the slot is a single, fixed-name global, not keyed per directive — so when more than one
// directive matches the SAME frame, the shim-then-file pair for each MUST fully complete (both awaited) before
// the next directive's pair begins, or a second shim could overwrite the slot before the first file reads it.
// This is why the loop below is sequential (`for…of` with `await`), not the previous `Promise.all` fan-out.
//
// WARNING FOR IMPLEMENTATION IMPACT: when more than one custom scriptlet rule matches the SAME frame (rare —
// most pages match 0 or 1), those scriptlets now inject one at a time instead of concurrently. Each pair is
// still only a few KB and typically resolves in low single-digit milliseconds, so this is not expected to be
// perceptible, but it is a real behavior change from the previous all-in-parallel dispatch.
/******************************************************************************/

// The one piece of code this module still holds directly (not generated, not scriptlet-specific) — small enough
// that importing it costs nothing close to the ~600KB this whole rewrite exists to avoid. Writes to a single,
// fixed-name slot on `self` (the frame's own global) rather than a per-directive key: see the RACE GUARD above
// for why that is safe only because callers serialize shim+file pairs per frame.
function setCustomScriptletArgsForFrame(source, args) {
    self.__uboCustomScriptletArgs = [ source, args ];
}

export async function injectCustomScriptletsForFrame({ tabId, frameId, hostname }) {
    if ( !hostname ) { return; }

    // BUG FIXED (v7.7.3): this dispatch path had no site-mode awareness at
    // all — the 4th occurrence of the same bug class already fixed for
    // pre-compiled AdGuard scriptlets/cosmetics (scripting-manager.js) and
    // security scriptlets (compiled-filters.js's prepareSecurityScriptlet-
    // Directives()). Whitelisting a site (SITE_MODE_OFF / MODE_NONE via the
    // popup) correctly disabled DNR blocking and those other three groups,
    // but ABP-imported scriptlet rules kept firing on that site regardless,
    // since this function only ever matched by hostname. Reusing the same
    // authoritative getFilteringMode() lookup mode-manager.js already
    // exposes (single per-hostname check, session-cached) rather than the
    // matches/excludeMatches-array shape buildSiteModeMatchScope() builds
    // for browser.scripting.registerContentScripts() — this path calls
    // executeScript() per-navigation instead, so a plain boolean guard is
    // both sufficient and cheaper here.
    //
    // (10.7.2) Guard ORDER: the cheap in-memory rule match runs FIRST, the
    // site-mode lookup only when at least one rule matched. This listener
    // fires for every committed frame, and on most frames no rule matches —
    // the old order fetched the site-mode details (a fresh copy of the
    // allow-list Sets per call) for nothing on each of those frames.
    // Behavior is identical: both guards only ever return early, so their
    // order cannot change which scriptlets a frame ends up with.
    const index = await ensureCustomScriptletRuleIndex();
    if ( index === undefined ) { return; }   // refresh failed — see its own guard comment

    const matching = collectMatchingRules(index, hostname)
        .map(r => ({ name: r.name, args: r.args, uid: r.uid }));
    if ( matching.length === 0 ) { return; }

    if ( await getFilteringMode(hostname) === MODE_NONE ) { return; }

    try {
        // (10.6.0) Sequential, not Promise.all — see this section's own header comment (RACE GUARD) for why:
        // each directive's shim-then-file pair must fully complete before the next one starts, since both
        // share one single-slot global on the target frame.
        for ( const d of matching ) {
            const file = SCRIPTLET_NAME_TO_FILE[d.name];
            // Shouldn't happen — every stored rule's name was already
            // validated against KNOWN_SCRIPTLET_NAMES at write time (see
            // isKnownScriptletName() callers) — but fail closed rather
            // than inject a `files` entry that doesn't exist, which would
            // throw a much less legible error.
            if ( file === undefined ) { continue; }
            // (10.4.6) Run-time guard: a rule stored before the scriptlet policy existed (a trusted scriptlet, code
            // as argument, an inserted external URL) is never executed, even though it is still listed.
            if ( scriptletRuleRejection(d.name, d.args ?? []) !== null ) { continue; }
            try {
                const target = { tabId, frameIds: [ frameId ] };
                // Step 1: the shim — tiny, not generated, not scriptlet-specific (see setCustomScriptletArgsForFrame
                // above) — writes this directive's (source, args) into the frame's single-slot global.
                await browser.scripting.executeScript({
                    target,
                    world: 'MAIN',
                    func: setCustomScriptletArgsForFrame,
                    args: [
                        { name: d.name, args: d.args, verbose: false, engine: 'extension', uniqueId: d.uid },
                        d.args,
                    ],
                    injectImmediately: true,
                });
                // Step 2: the scriptlet's own file — reads+consumes the slot the shim just wrote, then calls
                // the real body. Never imported by this module (see the header comment above and knip.jsonc).
                await browser.scripting.executeScript({
                    target,
                    world: 'MAIN',
                    files: [ file ],
                    injectImmediately: true,
                });
            } catch (reason) {
                // Expected/benign on some frames (e.g. chrome://, extension
                // pages, frames that navigated away before injection
                // completed) — don't let one frame's failure spam the
                // console on every navigation. One directive's failure
                // must not stop the OTHERS — this per-directive try/catch,
                // inside the sequential loop, is what preserves that
                // isolation even though the loop itself is no longer
                // Promise.all.
                if ( /cannot access|no tab with id|frame with id|extensions gallery cannot be scripted/i.test(String(reason?.message ?? reason)) ) { continue; }
                console.error('[uBlock-Dynamic] injectCustomScriptletsForFrame:', reason);
            }
        }
    } catch (reason) {
        console.error('[uBlock-Dynamic] injectCustomScriptletsForFrame:', reason);
    }
}
