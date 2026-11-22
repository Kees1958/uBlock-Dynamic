// ── builtin-exemption-carriers.js ────────────────────────────────────────────
// How the BUILT-IN per-site exemptions ("@@domain$worryfree" lines in badfilter-quick-fixes.txt) travel from
// the build to the runtime (10.2.0). ("@@domain$saferegions" lines are ignored since 10.3.0 — the option is
// retired, see util/site-mode-parser.js RETIRED_SITE_MODE_OPTIONS — so they get no carrier.)
//
// Before 10.2.0 the build wrote them into a JS module (js/generated/exempt-domains-generated.mjs), so adding
// one exemption to the quick-fixes list was a code change that needed a full Chrome Web Store review. Now
// they are CARRIED as ordinary safe allow rules inside the quick-fixes ruleset itself
// (rulesets/ruleset_badfilter_quickfixes.json, a declared rule_resources file), so such a change qualifies
// for the skip-review ("SAFE") update path, like every other filter-list change.
//
// One carrier rule per option. It is deliberately a SUBSET of an allow the extension already applies for
// that domain at runtime, so shipping it changes nothing on the network:
//   $worryfree   → allow main_frame TO the domain at WORRY_FREE_SITE_ALLOW_PRIORITY — part of
//                  worryfree-manager.js's own request allow rule (same priority, more types).
// The runtime reads the domain lists back out of the shipped file (core/exempt-domains.js
// loadBuiltinExemptDomains()) and feeds every existing consumer exactly as before.
//
// A carrier is recognised ONLY by its full signature (action, priority, resource types, domain field) — no
// other rule in the quick-fixes ruleset has it (its own rules sit at BADFILTER_QUICKFIXES_PRIORITY);
// tools/build/build-steps.mjs fails the build if one ever does.
//
// Public interface:
//   QUICKFIXES_RULESET_PATH                       — where the runtime reads the carriers from
//   buildExemptionCarrierRules(firstId, byOption)  — pure: { worryfree:[] } → carrier rules
//   readExemptionCarrierDomains(rules)             — pure: shipped rules → { worryfree:[] }
//   isExemptionCarrierRule(rule)                   — pure: true for a carrier (build-time signature check)
//
// Pure: no state — nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────
import { WORRY_FREE_SITE_ALLOW_PRIORITY } from './dnr-budgets.js';
import { SITE_MODE_OPTIONS } from '../util/site-mode-parser.js';

export const QUICKFIXES_RULESET_PATH = '/rulesets/ruleset_badfilter_quickfixes.json';

// option -> carrier signature. The ONLY place these shapes are declared.
const CARRIERS = Object.freeze({
    [SITE_MODE_OPTIONS.WORRYFREE]: Object.freeze({
        priority: WORRY_FREE_SITE_ALLOW_PRIORITY,
        resourceTypes: Object.freeze([ 'main_frame' ]),
    }),
});

function sameTypes(a, b) {
    return Array.isArray(a) && a.length === b.length && a.every((t, i) => t === b[i]);
}

function carrierOptionOf(rule) {
    if ( rule?.action?.type !== 'allow' ) { return null; }
    const condition = rule.condition ?? {};
    if ( !Array.isArray(condition.requestDomains) || Object.keys(condition).length !== 2 ) { return null; }
    for ( const [ option, carrier ] of Object.entries(CARRIERS) ) {
        if ( rule.priority === carrier.priority && sameTypes(condition.resourceTypes, carrier.resourceTypes) ) { return option; }
    }
    return null;
}

export function isExemptionCarrierRule(rule) {
    return carrierOptionOf(rule) !== null;
}

// byOption: { worryfree: string[] } (SITE_MODE_OPTIONS keys). Empty lists emit nothing.
export function buildExemptionCarrierRules(firstId, byOption) {
    const rules = [];
    for ( const [ option, carrier ] of Object.entries(CARRIERS) ) {
        const domains = [ ...new Set(byOption?.[option] ?? []) ].sort();
        if ( domains.length === 0 ) { continue; }
        rules.push({
            id: firstId + rules.length,
            priority: carrier.priority,
            action: { type: 'allow' },
            condition: { requestDomains: domains, resourceTypes: [ ...carrier.resourceTypes ] },
        });
    }
    return rules;
}

export function readExemptionCarrierDomains(rules) {
    const out = Object.fromEntries(Object.keys(CARRIERS).map(option => [ option, [] ]));
    for ( const rule of Array.isArray(rules) ? rules : [] ) {
        const option = carrierOptionOf(rule);
        if ( option !== null ) { out[option].push(...rule.condition.requestDomains); }
    }
    for ( const option of Object.keys(out) ) { out[option] = [ ...new Set(out[option]) ]; }
    return out;
}
