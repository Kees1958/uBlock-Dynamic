// ── popunder-carriers.js ─────────────────────────────────────────────────────
// How the Quick-fixes list's "$popunder" lines (10.7.2, the tab-under guard — js/core/tab-under-guard.js) travel
// from the build to the runtime. Same idea as js/core/builtin-exemption-carriers.js (C21): the lines are
// CARRIED inside the quick-fixes ruleset itself (rulesets/ruleset_badfilter_quickfixes.json, a declared
// rule_resources file), so adding or changing one is a filter-list change that qualifies for the skip-review
// ("SAFE") update path, not a code change.
//
// A carrier must change nothing on the network. This one is INERT by construction: it only matches requests
// with method CONNECT, and a page load (main_frame) is never a CONNECT request — so the rule can never fire.
// It exists only as data the runtime reads back:
//   { action: allow, priority: BADFILTER_QUICKFIXES_PRIORITY,
//     condition: { requestDomains: [network], initiatorDomains: [sites], resourceTypes: ['main_frame'],
//                  requestMethods: ['connect'] } }
// One carrier per distinct site list, holding every network declared for exactly those sites.
//
// Recognised ONLY by its full signature — no other rule in the quick-fixes ruleset uses requestMethods
// ['connect']; tools/build/build-steps.mjs fails the build if one ever does.
//
// Public interface:
//   buildPopunderCarrierRules(firstId, entries) — pure: [{network,sites}] → carrier rules
//   readPopunderCarrierEntries(rules)           — pure: shipped rules → [{network,sites}]
//   isPopunderCarrierRule(rule)                 — pure: true for a carrier (build-time signature check)
//
// Pure: no state — nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────
import { BADFILTER_QUICKFIXES_PRIORITY } from './dnr-budgets.js';

// The carrier signature. The ONLY place this shape is declared.
const POPUNDER_CARRIER = Object.freeze({
    priority:       BADFILTER_QUICKFIXES_PRIORITY,           // the list's own priority — no new priority tier
    resourceTypes:  Object.freeze([ 'main_frame' ]),
    requestMethods: Object.freeze([ 'connect' ]),            // a page load is never CONNECT: the rule never matches
    conditionKeys:  Object.freeze([ 'initiatorDomains', 'requestDomains', 'requestMethods', 'resourceTypes' ]),
});

function sameList(a, b) {
    return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

export function isPopunderCarrierRule(rule) {
    if ( rule?.action?.type !== 'allow' || rule.priority !== POPUNDER_CARRIER.priority ) { return false; }
    const condition = rule.condition ?? {};
    return sameList(Object.keys(condition).sort(), POPUNDER_CARRIER.conditionKeys) &&
        sameList(condition.resourceTypes, POPUNDER_CARRIER.resourceTypes) &&
        sameList(condition.requestMethods, POPUNDER_CARRIER.requestMethods) &&
        Array.isArray(condition.requestDomains) && Array.isArray(condition.initiatorDomains);
}

// entries: [{ network, sites }] from js/util/popunder-parser.js. Grouped by identical site list, sorted, so the
// same input always produces the same file (tools/verify-build-unchanged.mjs).
export function buildPopunderCarrierRules(firstId, entries) {
    const networksBySites = new Map();
    for ( const { network, sites } of Array.isArray(entries) ? entries : [] ) {
        const key = [ ...new Set(sites) ].sort().join('|');
        if ( networksBySites.has(key) === false ) { networksBySites.set(key, new Set()); }
        networksBySites.get(key).add(network);
    }
    return [ ...networksBySites.keys() ].sort().map((key, i) => ({
        id: firstId + i,
        priority: POPUNDER_CARRIER.priority,
        action: { type: 'allow' },
        condition: {
            requestDomains:   [ ...networksBySites.get(key) ].sort(),
            initiatorDomains: key.split('|'),
            resourceTypes:    [ ...POPUNDER_CARRIER.resourceTypes ],
            requestMethods:   [ ...POPUNDER_CARRIER.requestMethods ],
        },
    }));
}

export function readPopunderCarrierEntries(rules) {
    const entries = [];
    for ( const rule of Array.isArray(rules) ? rules : [] ) {
        if ( isPopunderCarrierRule(rule) === false ) { continue; }
        for ( const network of rule.condition.requestDomains ) {
            entries.push({ network, sites: [ ...rule.condition.initiatorDomains ] });
        }
    }
    return entries;
}
