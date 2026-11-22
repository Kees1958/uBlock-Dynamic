/*
 * builtin-fix-exceptions.js — Built-in, domain-scoped exceptions for
 *                              known upstream filter-list
 *                              miscategorizations
 *
 * Public interface:
 *   updateBuiltinFixExceptions() — (re)builds the exception DNR rules
 *                                   from the bundled FIX_EXCEPTIONS data.
 *                                   Call once at SW startup — the data is
 *                                   static/bundled, never changes at
 *                                   runtime, same lifecycle as
 *                                   updateBuiltinWhitelistRules().
 *
 * NOT visible to or configurable by the user, per explicit request — this
 * is a fix for an upstream data-quality problem (a source we don't
 * control classifying a site's own first-party infrastructure as a
 * third-party tracker), not a preference. See dnr-budgets.js's own
 * BUILTIN_FIX_EXCEPTIONS_BASE_ID comment for the full architectural
 * reasoning (why this is domain-scoped, not global, and why that's
 * different from js/core/builtin-whitelist-rules.js).
 *
 * Applies REGARDLESS of which specific default-filter or worry-free
 * checkbox is currently on/off — this priority tier sits above every
 * filter-list source (both the "default" always-loaded rulesets and the
 * worry-free-gated ones), so a fix here holds even if the person has,
 * say, only one Worry-free list enabled and nothing else.
 *
 * Each entry: the domain being wrongly blocked, and the ONE site it's
 * legitimately that site's own infrastructure for. Grouped by
 * initiatorDomain below (not one rule per entry) since DNR's
 * requestDomains/initiatorDomains condition is an AND-of-ORs — entries
 * sharing the same initiatorDomain can safely share one rule; entries
 * with different initiatorDomains need their own.
 */

import { dnr } from '../data/ext-compat.js';
import { BUILTIN_FIX_EXCEPTIONS_BASE_ID, BUILTIN_WHITELIST_RULES_PRIORITY } from './dnr-budgets.js';

// ── FIX_EXCEPTIONS — one entry per known miscategorization ─────────────
// Add new entries here as they're found; nothing else needs to change
// (updateBuiltinFixExceptions() regroups by initiatorDomain automatically
// and the id budget below has headroom for more rules).
//
// redditstatic.com / redditmedia.com — Reddit's own static-asset and
// media CDN. Present in Disconnect's Advertising category and (formerly)
// Ghostery's social_media category; genuinely Reddit's own
// infrastructure, not a third-party tracker when reddit.com itself is
// the page loading them. Found via direct inspection of
// rulesets/ruleset_disconnect_ads.json (that file no longer exists
// separately — Disconnect's Advertising category was later folded into
// ruleset_disconnect_other.json, itself removed in 10.7.1 — but this is where the
// miscategorization was originally found and confirmed).
//
// xhcdn.com — xHamster's own CDN. Ghostery's real trackerdb.json
// (fetched via the @ghostery/trackerdb npm package, dist/trackerdb.json)
// categorizes it under the "pornvertising" pattern entry alongside
// xhamster.com/xhamsterlive.com/xhamsterpremium.com itself — i.e. the
// site's own first-party CDN got bundled into the same tracker-database
// entry as the site, and gets blocked as third-party by
// rulesets/ruleset_ghostery_other.json's resulting
// `||xhcdn.com^$third-party` rule. Same miscategorization shape as the
// reddit.com entries above, found while debugging a report of
// static-ah.xhcdn.com being blocked (including non-script resources
// like stylesheets — this whole-domain block isn't resourceType-scoped,
// unlike worry-free-strict-3p-manager.js's unrelated CDN-hostname
// exception (that module was retired in 9.9.1), which only ever covered script/sub_frame for the Worry-free
// high-risk-site tier and was confirmed NOT to be the cause here).
// Not exported — only used within this module (to compute
// GROUPS_BY_INITIATOR below). Un-exported per the dead-export audit that
// found nothing outside this file ever referenced it; trivially
// re-exportable if a future test/audit script needs direct access to the
// raw list.
const FIX_EXCEPTIONS = [
    { requestDomain: 'redditstatic.com', initiatorDomain: 'reddit.com' },
    { requestDomain: 'redditmedia.com',  initiatorDomain: 'reddit.com' },
    { requestDomain: 'xhcdn.com',        initiatorDomain: 'xhamster.com' },
];

// Computed once at module load — FIX_EXCEPTIONS is a frozen bundled
// constant, never mutated at runtime, same reasoning as builtin-
// whitelist-rules.js's own SCRIPT_EXEMPT_DOMAINS/FRAME_EXEMPT_DOMAINS.
const GROUPS_BY_INITIATOR = (() => {
    const map = new Map(); // initiatorDomain -> requestDomain[]
    for ( const { requestDomain, initiatorDomain } of FIX_EXCEPTIONS ) {
        if ( map.has(initiatorDomain) === false ) { map.set(initiatorDomain, []); }
        map.get(initiatorDomain).push(requestDomain);
    }
    return [ ...map.entries() ];
})();

export async function updateBuiltinFixExceptions() {
    const ruleIds = GROUPS_BY_INITIATOR.map((_, i) => BUILTIN_FIX_EXCEPTIONS_BASE_ID + i);
    const addRules = GROUPS_BY_INITIATOR.map(([ initiatorDomain, requestDomains ], i) => ({
        id: BUILTIN_FIX_EXCEPTIONS_BASE_ID + i,
        priority: BUILTIN_WHITELIST_RULES_PRIORITY,
        action: { type: 'allow' },
        condition: {
            requestDomains,
            initiatorDomains: [ initiatorDomain ],
        },
    }));

    await dnr.updateDynamicRules({
        removeRuleIds: ruleIds,
        addRules,
    }).catch(reason => {
        console.error(`[uBlock-Dynamic] builtin-fix-exceptions/updateBuiltinFixExceptions: ${reason}`);
    });
}
