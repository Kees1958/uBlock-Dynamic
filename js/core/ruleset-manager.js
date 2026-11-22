/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/Kees1958/uBol-stripped
    Based on uBlock Origin Lite (https://github.com/gorhill/uBlock), modified in
    2026 for uBlock-Stripped-Dynamic — see CHANGELOG.md for the changes.

*******************************************************************************/
/*
 * ruleset-manager.js — Dynamic DNR rule management
 *
 * Public interface:
 *   filteringModesToDNR(modes)   — writes trusted-directive allowAllRequests rules
 *   updateUserRules()            — registers compiled sandbox DNR rules (cap: USER_RULES_MAX)
 *   getEffectiveUserRules()      — returns currently registered sandbox DNR rules
 *
 * Rule ID ranges: see js/core/dnr-budgets.js for the authoritative allocation table.
 *
 * ── STATE / GUARDS (uBol-stripped-code-review.md §1 retrofit) ───────────────
 * No session, no phases: every exported function here is a standalone,
 * idempotent read-DNR/compute/write-DNR operation — there's no multi-step
 * lifecycle to model with a phase enum (contrast block-monitor.js, which
 * genuinely has one). The state-vector pattern (B3a) is deliberately NOT
 * applied here for that reason — forcing a phase field onto functions that
 * don't have phases would add fake complexity, not real clarity.
 *
 * State owned: none. (11.0.0) The regex-validation cache moved with
 * pruneInvalidRegexRules() to js/core/regex-rule-guard.js.
 */


// Static DNR rulesets are always fully enabled in this build (rule_resources
// is [] in the manifest). This file now only manages:
//   1. filteringModesToDNR  — translate mode Sets → DNR allowAllRequests rules
//   2. updateDynamicRules   — clean up legacy dynamic rules on version change
//   3. updateUserRules      — register compiled sandbox DNR rules
//   4. getEffectiveUserRules — read current sandbox rule slot from dynamic rules

import {
    localRead, localRemove, localWrite,
} from '../data/ext.js';

import { dnr } from '../data/ext-compat.js';
import { pruneInvalidRegexRules } from './regex-rule-guard.js';
import { rulesetConfig } from '../data/config.js';

import {
    TRUSTED_DIRECTIVE_BASE_ID,
    TRUSTED_DIRECTIVE_PRIORITY,
    USER_RULES_BASE_ID,
    USER_RULES_MAX,
    USER_RULES_PRIORITY,
    MAX_NUMBER_OF_REGEX_RULES,
} from './dnr-budgets.js';
import { catchExpected } from '../data/expected-errors.js';

/******************************************************************************/

// (audit 10.6.4) SPECIAL_RULES_REALM (5 000 000) removed with updateDynamicRules(), its only user.


/******************************************************************************/

// Translate filtering mode Sets into a DNR allowAllRequests rule pair so the
// browser enforces per-hostname filtering decisions at the network layer.

export async function filteringModesToDNR(modes) {
    const noneHostnames = new Set([ ...modes.none ]);
    // modes.basic always carries a bookkeeping 'all-urls' member (see
    // js/core/filter-manager.js's registerCustomFilters() for the full
    // explanation and the real bug this same leak caused there). Harmless
    // here — dnr.setAllowAllRules() just gets one unmatchable 'all-urls'
    // domain string in its exclusion list — but stripped for consistency.
    const notNoneHostnames = new Set([ ...modes.basic ].filter(hn => hn !== 'all-urls'));
    const requestDomains = [];
    const excludedRequestDomains = [];
    const allowEverywhere = noneHostnames.has('all-urls');
    if ( allowEverywhere ) {
        excludedRequestDomains.push(...notNoneHostnames);
    } else {
        requestDomains.push(...noneHostnames);
    }
    return dnr.setAllowAllRules(
        TRUSTED_DIRECTIVE_BASE_ID,
        requestDomains.sort(),
        excludedRequestDomains.sort(),
        allowEverywhere,
        TRUSTED_DIRECTIVE_PRIORITY
    );
}

/******************************************************************************/

// (11.0.0) pruneInvalidRegexRules() moved to js/core/regex-rule-guard.js (shared with cmp-loader-block-manager.js).

/******************************************************************************/

// (audit 10.6.4, C13b) updateDynamicRules() REMOVED — the "on version change" legacy clean-up
// (remove every dynamic rule below SPECIAL_RULES_REALM, clear ALL session rules) had no caller:
// background.js imported it but never called it since the pre-10.0.3 migration steps were removed.
// It must not simply be re-wired either: clearing ALL session rules would now also wipe live
// session rules of current features.

/******************************************************************************/

// Read the current sandbox-rule slot from the dynamic rule set.
// Rules below USER_RULES_BASE_ID belong to other subsystems.

export async function getEffectiveUserRules() {
    const allRules = await dnr.getDynamicRules();
    return allRules.filter(rule => rule.id >= USER_RULES_BASE_ID);
}

/******************************************************************************/

// Apply compiled sandbox DNR rules to the dynamic rule slot.
// Removes all existing user-slot rules first (separately, to avoid a failed
// add blocking the removal of stale rules).

export async function updateUserRules() {
    const [
        currentUserRules,
        sandboxRules,
    ] = await Promise.all([
        getEffectiveUserRules(),
        localRead('sandboxFilters.dnrRules'),
    ]);

    const rules = Array.isArray(sandboxRules) ? sandboxRules.slice() : [];

    // Elevate priority so sandbox rules win over static ruleset rules.
    for ( const rule of rules ) {
        rule.priority = (rule.priority || 1) + USER_RULES_PRIORITY;
    }

    const removeRuleIds = currentUserRules.map(r => r.id);
    const rejectedRegexes = [];
    const validRules = await pruneInvalidRegexRules(rules, rejectedRegexes);
    // Enforce cap — Chrome allows 30 000 safe dynamic rules total; staying
    // within USER_RULES_MAX prevents sandbox rules from starving other slots.
    const capped = validRules.slice(0, USER_RULES_MAX);
    // Proactive regexFilter-count cap (dnr-budgets.js's own comment on
    // MAX_NUMBER_OF_REGEX_RULES has the full "why" — a real design gap,
    // flagged in an earlier release, now closed). Chrome's own
    // updateDynamicRules() rejects the ENTIRE batch atomically if the
    // regex-bearing subset exceeds this cap, even though it's well within
    // USER_RULES_MAX — so this must be checked and trimmed BEFORE
    // submitting, not left to surface as one generic caught error for the
    // whole import. Same "keep the first N, report the excess as dropped"
    // pattern as the USER_RULES_MAX check just above — kept as two
    // separate checks/messages rather than merged, since they're two
    // independent Chrome-imposed caps with different causes and a person
    // reading the error needs to know WHICH limit they hit.
    let regexCount = 0;
    const addRules = [];
    let regexRulesDropped = 0;
    for ( const rule of capped ) {
        if ( rule.condition?.regexFilter ) {
            regexCount++;
            if ( regexCount > MAX_NUMBER_OF_REGEX_RULES ) { regexRulesDropped++; continue; }
        }
        addRules.push(rule);
    }
    // (10.7.6) rejectedRegexes: { regex, reason } — Chrome refused the regex; the Import ABP box annotates the line.
    const out = { added: 0, removed: 0, errors: [], rejectedRegexes };

    for ( const e of rejectedRegexes ) {
        out.errors.push(`regexFilter: ${e.regex} → ${e.reason}`);
    }
    if ( validRules.length > USER_RULES_MAX ) {
        out.errors.push(`${validRules.length - USER_RULES_MAX} rules dropped — exceeded USER_RULES_MAX (${USER_RULES_MAX})`);
    }
    if ( regexRulesDropped > 0 ) {
        out.errors.push(`${regexRulesDropped} regexFilter-based rule(s) dropped — your import has more than Chrome's own regexFilter limit of ${MAX_NUMBER_OF_REGEX_RULES} (this is a separate, smaller cap than the ${USER_RULES_MAX}-rule USER_RULES_MAX budget above; non-regex rules are unaffected)`);
    }

    if ( removeRuleIds.length === 0 && addRules.length === 0 ) {
        await localRemove('userDnrRuleCount');
        return out;
    }

    let ruleId = 0;
    for ( const rule of addRules ) {
        rule.id = USER_RULES_BASE_ID + ruleId++;
    }

    // Remove then add in two separate calls so a bad rule in addRules cannot
    // prevent removal of the stale rules.
    try {
        await dnr.updateDynamicRules({ removeRuleIds });
        await dnr.updateDynamicRules({ addRules });
        out.added = addRules.length;
        out.removed = removeRuleIds.length;
    } catch(reason) {
        console.error(`[uBlock-Dynamic] updateUserRules/${reason}`);
        out.errors.push(`${reason}`);
        out.batchFailed = true;   // (10.7.6) Chrome refused the batch: the old rules were already removed, none are active
    } finally {
        const remaining = await getEffectiveUserRules();
        if ( remaining.length === 0 ) {
            await localRemove('userDnrRuleCount');
        } else {
            await localWrite('userDnrRuleCount', addRules.length);
        }
    }

    return out;
}

/******************************************************************************/

// (10.3.0) updateSecurityRules() and its slot table (SECURITY_RULES_BASE_ID +0..+20: Web Bundles,
// suspicious 3P requests, the local-network block and the suspicious-hosting ruleset with its per-site
// mirrors) were REMOVED with the Privacy & Security extra protections, which moved to 3P-Matrix.
// Their ids stay reserved (dnr-budgets.js RETIRED_PROTECTION_RULE_RANGES; the start-up clean-up of
// leftovers was removed in 10.5.0); ruleset_suspicious_hosting left the manifest.

/******************************************************************************/
// Icon badge count visibility — single source of truth, called at startup
// (background.js's startSession()). Previously also accounted for
// Global Privacy Control — see CHANGELOG for the full history: GPC's DNR
// rule (a modifyHeaders match) was counted by Chrome's own badge the same
// as a real block, making the badge deeply misleading whenever GPC was
// on. Fixing that accurately (without either weakening GPC's spec-
// required scope, or building a whole separate webRequest-based counter
// just for this one toggle) wasn't achievable simply, so GPC was removed
// as a feature entirely instead. This function is back to trivial —
// kept as a real function (not inlined at the one call site) because a
// second call site may reasonably exist again in the future.
export async function applyBadgeCountVisibility() {
    if ( typeof dnr.setExtensionActionOptions !== 'function' ) { return; } // Firefox — no-op, same guard background.js already had
    await dnr.setExtensionActionOptions({
        displayActionCountAsBadgeText: rulesetConfig.showBlockedCount,
    }).catch(catchExpected('set badge count visibility', []));
}

/******************************************************************************/
