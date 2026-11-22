/*
 * ruleset-routes.js — Ruleset toggle / DNR data message-route adapters
 *
 * Same three-layer split as matrix-routes.js / security-routes.js (see
 * matrix-routes.js's own header for the full rationale):
 *   Layer 1 — message-routes.js:  POLICY
 *   Layer 2 — this file:          ADAPTER
 *   Layer 3 — ruleset-manager.js, static-rulesets.js, scripting-manager.js,
 *             static-block-check.js, and the raw dnr API (data/ext-compat.js)
 *             — the actual logic
 *
 * Two of these six (getAllDynamicRules, getAllSessionRules) are pure
 * pass-throughs straight to the browser's own declarativeNetRequest API —
 * no core/ module involved at all, included here anyway since they're
 * DNR-data reads in the same family as the other four, not because they
 * share an implementation with them.
 *
 * Public interface — one function per MSG_* route this feature owns,
 * referenced by background.js's ROUTE_HANDLERS:
 *   handleGetAllDynamicRules, handleGetAllSessionRules,
 *   handleUpdateUserDnrRules, handleGetEffectiveUserRules,
 *   handleGetEnabledRulesets, handleSetRulesetEnabled,
 *   handleGetLanguageFilterCountries, handleSetLanguageFilterCountries (10.4.5)
 */

import { dnr } from '../data/ext-compat.js';

import { updateUserRules, getEffectiveUserRules } from '../core/ruleset-manager.js';
import { getEnabledRulesets, setRulesetEnabled } from '../core/static-rulesets.js';
import { resetStaticBlockCache } from '../core/static-block-check.js';
import { refreshUserRuleBlockCache } from '../core/matrix-panel.js';
import { getLanguageFilterCountries, setLanguageFilterCountries } from '../core/language-filter-countries.js';
import {
    registerScriptletContentScripts,
    registerCosmeticContentScripts,
} from '../core/scripting-manager.js';

/******************************************************************************/

export async function handleGetAllDynamicRules() {
    return dnr.getDynamicRules();
}

export async function handleGetAllSessionRules() {
    return dnr.getSessionRules();
}

export async function handleUpdateUserDnrRules() {
    const result = await updateUserRules();
    // (audit 10.6.4, B-1) Same follow-up as background.js's handleSetSandboxFilters(): keep an open
    // Matrix panel's BLOCKED/NOT BLOCKED view in step with the user's DNR rules just written.
    await refreshUserRuleBlockCache();
    return result;
}

export async function handleGetEffectiveUserRules() {
    return getEffectiveUserRules();
}

export async function handleGetEnabledRulesets() {
    return getEnabledRulesets().then(s => [...s]);
}

// (10.4.5) Country rows of the combined language filters — see js/core/language-filter-countries.js.
export async function handleGetLanguageFilterCountries() {
    return getLanguageFilterCountries();
}

export async function handleSetLanguageFilterCountries(request) {
    const ok = await setLanguageFilterCountries(request?.rulesetId, request?.countryIds);
    return { ok };
}

export async function handleSetRulesetEnabled(request) {
    // (10.7.6) Chrome's refusal goes back to the dashboard, which says so and sets the switch back.
    const result = await setRulesetEnabled(request.id, request.enabled);
    if ( result?.ok === false ) { return result; }
    // Re-register scriptlet + cosmetic content scripts and user scripts so
    // the new enabled set takes effect immediately.
    //
    // bypassAlwaysOnIds: an explicit user action on request.id is
    // unambiguous — no SW-startup race is possible here (see
    // ALWAYS_ON_RULESETS's own comment in scripting-manager.js for the
    // race that constant exists to guard against). Passing request.id
    // forces this one registration pass to honor the real enabled state
    // for that ruleset even if it's normally in ALWAYS_ON_RULESETS —
    // fixes "disabling AdGuard Base in Filter Lists didn't actually stop
    // its scriptlets/cosmetics" without touching the SW-startup fallback
    // that protects every other case.
    const bypassAlwaysOnIds = new Set([ request.id ]);
    registerScriptletContentScripts(bypassAlwaysOnIds);
    registerCosmeticContentScripts(bypassAlwaysOnIds);
    // DDG Tracker Radar's static-block check (js/core/static-block-check.js)
    // caches which domains are whole-domain-blocked by the currently
    // enabled rulesets — that selection just changed, so drop the cache.
    resetStaticBlockCache();

    return getEnabledRulesets().then(s => [...s]);
}

/******************************************************************************/
