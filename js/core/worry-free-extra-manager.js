/*******************************************************************************

    uBlock-Stripped-Dynamic — Worry-free extra suppression rule manager

    Manages independent session-scoped chrome.declarativeNetRequest
    suppression rules for the Worry-free extra FILTER LISTS, in two shapes:

    DOMAIN-SCOPED (three rules since 10.7.1; was four, v9.1.4) — condition.requestDomains set to
    exactly that item's own ruleset's domain list, read at runtime from
    the bundled ruleset JSON (same fetch(runtime.getURL(...)) pattern
    static-block-check.js already established — C21, reused not
    reinvented). Because each suppression rule can only ever match its OWN
    domains, the three are independently toggleable without one silently
    suppressing a sibling.

    CONDITION-SCOPED, NO TIER (one rule, 10.0.7) — ruleset_adguard_base_
    removeparam is pure $removeparam (a redirect-shaped action), so there is
    no block-rule domain list to mirror; its suppression rule is scoped by
    its own priority window and resource types instead.

    (10.3.0) The Privacy & Security protections this file also used to
    gate — the two Low-group Permissions-Policy header switches
    (blockScpPrivacy/blockScpSecurity) and the sandbox-safe-scripts row
    (enforceMediumSandboxSafeScripts) with its safer-region exemption band —
    were REMOVED (moved to 3P-Matrix), together with the Worry-free tier
    hierarchy (worry-free-tiers.js) they read. (10.5.0) The start-up clean-up of
    their leftover rules on pre-10.3.0 installs was removed (old conversion code).

    Design: present by default (normal browsing), absent for the
    duration of an active Worry-free/"Never consent" session AND the
    corresponding setting being enabled — matching
    js/core/cookie-clicker-autodeny-manager.js's own active/inactive
    state, since that IS the same session.

    Session rules reset to empty on a genuine browser restart (MDN: "not
    persisted across browser sessions") — unlike this session's own
    Worry-free active/inactive state, which DOES persist (chrome.
    storage.local, via cookie-clicker-autodeny-manager.js). That means a
    real restart can leave the two out of sync (rule gone, but a session
    was still supposed to be active, or vice versa) — reconcile(), below,
    is the one place that re-derives the correct rule state FROM the
    persisted session state, called at every point that could plausibly
    have left them mismatched (extension start, browser startup, and
    directly from every session state transition) rather than assumed
    correct from whatever ran last.

*******************************************************************************/

import { dnr } from '../data/ext-compat.js';
import { browser } from '../data/ext.js';
import {
    WORRY_FREE_ADGUARD_TRACKING_RULES_BASE_ID, WORRY_FREE_DISCONNECT_OTHER_RULES_RETIRED_BASE_ID,
    WORRY_FREE_KEES1958_RULES_BASE_ID, WORRY_FREE_PETERLOWE_RULES_BASE_ID, WORRY_FREE_ADGUARD_REMOVEPARAM_RULES_BASE_ID,
    WORRY_FREE_HAGEZI_RULES_BASE_ID,
    WORRY_FREE_ADGUARD_REMOVEPARAM_SUPPRESS_PRIORITY,
    WORRY_FREE_EXTRA_ALLOW_PRIORITY,
} from './dnr-budgets.js';
import { securityConfig } from '../data/config.js';
// Deliberately NOT importing getAutoDenyState() from
// cookie-clicker-autodeny-manager.js here — that module needs to call
// INTO this one (onWorryFreeSessionStart/End, from its own startAutoDeny/
// cancelAutoDeny/expireAutoDeny), and a reverse import back would be a
// genuine circular dependency. reconcileWorryFreeExtraSuppressionRule()
// below takes the active state as a parameter instead — callers that
// already sit above both modules in the layering (js/workflow/*) fetch it
// once and pass it in.

/******************************************************************************/
// Resource-type enum helper — ported here from the deleted worry-free-
// advanced.js (AdShield Evolution rename pass). DERIVED from the runtime
// enum, never hard-coded: a resource type the browser does not know makes
// the WHOLE updateSessionRules() call fail, and the enum differs between
// browsers/versions (Chrome has webtransport/webbundle). Exported for
// worryfree-manager.js's SITE_ITEMS, which needs "every resource type the
// browser knows".
/******************************************************************************/

// Only used where the browser's own enum cannot be read (a test harness
// without the API). (10.3.0: worryfree-manager.js's SITE_ITEMS is now the
// only consumer — the sandbox-safe-scripts exemption band that also used it
// was removed.) In a real browser the list is DERIVED from
// dnr.ResourceType. Exact same combined list the deleted worry-free-
// advanced.js's own fallback used (its two halves, ADVANCED_3P_EXEMPT_
// RESOURCE_TYPES + ADVANCED_3P_FALLBACK_BLOCKED_RESOURCE_TYPES, merged
// here rather than kept as two named halves — nothing else needs them
// separately once this is this function's only caller of the fallback).
const RESOURCE_TYPE_ENUM_FALLBACK = Object.freeze([
    'main_frame', 'sub_frame', 'stylesheet', 'font', 'image', 'media',
    'script', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'websocket', 'other',
]);

function readResourceTypeEnum() {
    try {
        const values = Object.values(dnr.ResourceType ?? {});
        return values.length !== 0 ? values : undefined;
    } catch {
        return undefined;
    }
}

export function getAllResourceTypes() {
    return readResourceTypeEnum() ?? [ ...RESOURCE_TYPE_ENUM_FALLBACK ];
}

/******************************************************************************/
// Config — declared once, here.
/******************************************************************************/

// The domain-scoped, independently-toggleable items (was five —
// ruleset_ghostery_other and, 10.7.1, ruleset_disconnect_other removed entirely, see CHANGELOG).
// `rulesetPath` points at the bundled static ruleset JSON whose domains
// this suppression rule must mirror exactly — see getRulesetRequestDomains()
// below. Each has its OWN settingKey (see config.js).
const SCOPED_SUPPRESSION_RULES = [
    { id: WORRY_FREE_ADGUARD_TRACKING_RULES_BASE_ID,  settingKey: 'worryFreeAdguardTrackingEnabled',   rulesetPath: '/rulesets/ruleset_adguard_tracking_servers.json' },
    // (10.7.1) Disconnect (Cryptomining, Fingerprinting) REMOVED, owner's decision — see
    // RETIRED_SUPPRESSION_RULE_IDS below for its leftover session rule.
    // (10.0.7) Kees1958 EU+US ads/tracking — moved from always-on Built-in to a Worry-free
    // opt-in. Stays a static ruleset (DNR enable state is independent of this overlay).
    { id: WORRY_FREE_KEES1958_RULES_BASE_ID,           settingKey: 'worryFreeKees1958Enabled',          rulesetPath: '/rulesets/ruleset_kees1958.json' },
    // (10.1.1) Peter Lowe's list restored as a Worry-free opt-in (suppression-only ruleset, like AdGuard tracking).
    { id: WORRY_FREE_PETERLOWE_RULES_BASE_ID,          settingKey: 'worryFreePeterloweEnabled',         rulesetPath: '/rulesets/ruleset_peterlowe.json' },
    // (11.0.0, owner's decision) HaGeZi Light moved here from the always-on default lists. Its rule names ~27 000
    // domains (the others ~4 000); at 9 000 it stays below AdGuard Base (10 000), so it never lifts a default block.
    { id: WORRY_FREE_HAGEZI_RULES_BASE_ID,             settingKey: 'worryFreeHageziEnabled',            rulesetPath: '/rulesets/ruleset_hagezi_light.json' },
];

// (10.0.7) SHAPE 3 — condition-scoped suppression with NO tier and NO domain list. Needed for
// ruleset_adguard_base_removeparam: pure $removeparam (a redirect-shaped action), so there is no
// block-rule domain list for SCOPED_SUPPRESSION_RULES to mirror, and it belongs to no
// tier. Present whenever no Worry-free session is active OR its own toggle is off.
const NO_TIER_CONDITION_SUPPRESSION_RULES = [
    { id: WORRY_FREE_ADGUARD_REMOVEPARAM_RULES_BASE_ID,
      settingKey: 'worryFreeAdguardRemoveparamEnabled',
      priority: WORRY_FREE_ADGUARD_REMOVEPARAM_SUPPRESS_PRIORITY,
      condition: { resourceTypes: [ 'main_frame', 'sub_frame' ] } },
];

/******************************************************************************/
// Domain lookup for the scoped suppression rules — reads the actual
// bundled ruleset JSON at runtime (fetch(runtime.getURL(...)), same
// pattern static-block-check.js already established for exactly this
// kind of "read a shipped ruleset file's own rules" need — C21, reused
// not reinvented). Cached per path: the bundled file's content never
// changes at runtime, only between builds, so one fetch per session is
// enough.
/******************************************************************************/

const rulesetDomainsCache = new Map();  // path -> string[] (or null on failure)

async function getRulesetRequestDomains(rulesetPath) {
    if ( rulesetDomainsCache.has(rulesetPath) ) {
        return rulesetDomainsCache.get(rulesetPath);
    }
    let domains = null;
    try {
        const res = await fetch(browser.runtime.getURL(rulesetPath));
        const rules = await res.json();
        const set = new Set();
        for ( const rule of rules ) {
            if ( rule.action?.type !== 'block' ) { continue; }
            for ( const d of (rule.condition?.requestDomains ?? []) ) { set.add(d); }
            // urlFilter-based rules (this release): the two EasyList
            // site-specific lists added alongside ruleset_easylist_adservers
            // are almost entirely PATH rules ("||eporner.com/dot/"), which
            // carry no requestDomains at all — 425 of 426 rules in one of
            // them. Reading only requestDomains would leave those
            // unsuppressed, i.e. blocking even outside a Worry-free session,
            // which is precisely what this manager exists to prevent.
            // The host is taken from the "||host" prefix and suppressed as a
            // requestDomain, which outranks every rule targeting that host
            // (path rules and the sub_frame rule alike).
            const host = hostFromUrlFilter(rule.condition?.urlFilter);
            if ( host !== null ) { set.add(host); }
        }
        domains = [ ...set ];
    } catch (reason) {
        console.error(`[uBlock-Dynamic] worry-free-extra-manager/getRulesetRequestDomains(${rulesetPath}):`, reason);
    }
    rulesetDomainsCache.set(rulesetPath, domains);
    return domains;
}

/******************************************************************************/

// "||host^" / "||host/path" → "host". Returns null for anything else —
// a pattern with no "||" anchor, or a wildcard in the host (DNR accepts
// "*" in a urlFilter, but requestDomains takes literal domains only, so a
// wildcard host cannot be expressed here and is deliberately skipped
// rather than guessed at).
function hostFromUrlFilter(urlFilter) {
    if ( typeof urlFilter !== 'string' || urlFilter.startsWith('||') === false ) { return null; }
    const rest = urlFilter.slice(2);
    const end = Math.min(
        ...[ '^', '/', '?' ].map(ch => {
            const i = rest.indexOf(ch);
            return i === -1 ? rest.length : i;
        })
    );
    const host = rest.slice(0, end).toLowerCase();
    if ( host === '' || host.includes('*') ) { return null; }
    return host;
}

function buildScopedConditionSuppressionRule(id, priority, condition) {
    return { id, priority, action: { type: 'allow' }, condition };
}

// Scoped variant — condition.requestDomains limits this allow rule to
// EXACTLY the domains its own ruleset blocks, so turning this one item
// off can never suppress a sibling item's blocking too. Returns null if
// the domain list couldn't be read (caller must treat that as "leave
// this rule's state alone this pass" — see reconcile() below).
async function buildScopedSuppressionRule(id, rulesetPath) {
    const domains = await getRulesetRequestDomains(rulesetPath);
    if ( domains === null || domains.length === 0 ) { return null; }
    return {
        id,
        priority: WORRY_FREE_EXTRA_ALLOW_PRIORITY,
        action: { type: 'allow' },
        condition: { requestDomains: domains },
    };
}

// GUARD — release (10.7.1): session suppression rules of REMOVED lists. A suppression rule is an allow at
// WORRY_FREE_EXTRA_ALLOW_PRIORITY (9 000) over the removed list's domains — left behind, it would keep
// unblocking those domains for every remaining extra list (8 000) during a session. Chrome normally clears
// session rules on an extension update, but nothing here relies on that: reconcile() removes any of these
// ids it finds, every time, and never adds them. Ids stay reserved in dnr-budgets.js.
const RETIRED_SUPPRESSION_RULE_IDS = Object.freeze([
    WORRY_FREE_DISCONNECT_OTHER_RULES_RETIRED_BASE_ID,   // ruleset_disconnect_other, removed 10.7.1
]);

async function presentSuppressionRuleIds() {
    let rules = [];
    try {
        rules = await dnr.getSessionRules();
    } catch {
        return null; // couldn't determine — reconcile() treats this as "do nothing"
    }
    const ids = new Set([
        ...SCOPED_SUPPRESSION_RULES.map(s => s.id),
        ...NO_TIER_CONDITION_SUPPRESSION_RULES.map(s => s.id),
        ...RETIRED_SUPPRESSION_RULE_IDS,
    ]);
    return new Set(rules.filter(r => ids.has(r.id)).map(r => r.id));
}

/******************************************************************************/
// Public interface
/******************************************************************************/

// Called directly from startAutoDeny() — the session is becoming active
// RIGHT NOW. For each item, the suppression rule comes off ONLY if its
// own setting is currently enabled (default true) — if the person turned
// one off, that item simply never activates for this session, same as if
// it didn't exist.
//
// BUG FIX (v8.6.6): this used to build addRules/removeRuleIds purely
// from `securityConfig[settingKey]`, with no check for what dnr.
// getSessionRules() actually had registered. If a suppression rule that
// "should be (re-)added" per settings was already present — plausible
// any time this ran without a matching prior removal, e.g. after a
// stale/mismatched state from an earlier session — the blind add threw
// "Rule with id N does not have a unique ID." reconcileWorryFree
// ExtraSuppressionRule() below already solves exactly this (it diffs
// against presentSuppressionRuleIds() before deciding what to touch);
// this is that same target state (`isActive: true`), so delegating to
// it (C21 — reuse the proven fix already in this file) removes the
// duplicated, buggy logic instead of patching it a second time.
export async function onWorryFreeSessionStart() {
    return reconcileWorryFreeExtraSuppressionRule(true, 'onWorryFreeSessionStart');
}

// Called directly from cancelAutoDeny()/expireAutoDeny() — the session
// just ended, so every suppression rule must go back on immediately,
// regardless of each item's own setting (nothing from this tier should
// ever be active outside a session).
//
// BUG FIX (v8.6.6): same defect and same fix shape as onWorryFree
// SessionStart() above — this used to unconditionally push all five
// rules into addRules with no removeRuleIds and no presence check,
// which throws the identical "not a unique ID" error the moment any of
// the five is already registered. `isActive: false` here makes every
// rule's shouldBePresent true regardless of settingKey — same end
// target as the original unconditional add — but now diffed safely
// against what's actually present first.
export async function onWorryFreeSessionEnd() {
    return reconcileWorryFreeExtraSuppressionRule(false, 'onWorryFreeSessionEnd');
}

// Re-derives the correct rule state from the persisted session state (and,
// while active, each item's own setting) and fixes any mismatch. Takes
// `isActive` as a parameter rather than fetching it itself — see this
// file's own header on why (avoiding a circular import with cookie-
// clicker-autodeny-manager.js). Called at extension start and at browser
// startup — the two points a genuine browser restart (which wipes session
// rules, but not the persisted active/inactive state) could plausibly
// have left the two out of sync. Idempotent and safe to call at any other
// time too (a plain SW wakeup, where session rules already survived
// correctly, costs one no-op read-and-compare).
//
// `label` (optional, defaults to this function's own name) lets
// onWorryFreeSessionStart()/onWorryFreeSessionEnd() above delegate here
// while keeping their own, caller-specific console.error prefix — so a
// future error still says which entry point triggered it, not just
// "reconcile", even though there's now only one real implementation.

export async function reconcileWorryFreeExtraSuppressionRule(isActive, label = 'reconcile') {
    const present = await presentSuppressionRuleIds();
    if ( present !== null ) {
        const addRules = [];
        const removeRuleIds = [];

        // Scoped rules need an async domain lookup per item — done in
        // parallel, same reasoning as static-block-check.js's own
        // Promise.all over its bundled-file reads.
        await Promise.all(SCOPED_SUPPRESSION_RULES.map(async ({ id, settingKey, rulesetPath }) => {
            const shouldBePresent = isActive !== true || securityConfig[settingKey] === false;
            const isPresent = present.has(id);
            if ( shouldBePresent && !isPresent ) {
                const rule = await buildScopedSuppressionRule(id, rulesetPath);
                // null means the domain list couldn't be read this pass —
                // leave this one rule's state alone rather than add a
                // suppression rule with no domains (which would suppress
                // nothing, silently making this item behave as if its
                // setting were off without actually reflecting that anywhere).
                if ( rule !== null ) { addRules.push(rule); }
            } else if ( !shouldBePresent && isPresent ) {
                removeRuleIds.push(id);
            }
        }));

        // Retired lists (10.7.1): always removed when present, never added.
        for ( const id of RETIRED_SUPPRESSION_RULE_IDS ) {
            if ( present.has(id) ) { removeRuleIds.push(id); }
        }

        // Shape 3 (10.0.7): no tier, no domain list — a plain condition-scoped rule.
        for ( const { id, settingKey, priority, condition } of NO_TIER_CONDITION_SUPPRESSION_RULES ) {
            const shouldBePresent = isActive !== true || securityConfig[settingKey] === false;
            const isPresent = present.has(id);
            if ( shouldBePresent && !isPresent ) { addRules.push(buildScopedConditionSuppressionRule(id, priority, condition)); }
            else if ( !shouldBePresent && isPresent ) { removeRuleIds.push(id); }
        }

        if ( addRules.length !== 0 || removeRuleIds.length !== 0 ) {
            try {
                await dnr.updateSessionRules({ addRules, removeRuleIds });
            } catch (reason) {
                console.error(`[uBlock-Dynamic] worry-free-extra-manager ${label}:`, reason);
            }
        }
    }
}
