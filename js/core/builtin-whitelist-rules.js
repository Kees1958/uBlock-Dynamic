/*
 * builtin-whitelist-rules.js — Global DNR exemption for CRITICAL
 *                               RESOURCE-whitelisted domains
 *
 * Public interface:
 *   updateBuiltinWhitelistRules() — (re)builds the exemption DNR rules
 *                                    from the bundled BUILTIN_DOMAINS
 *                                    data. Call once at SW startup — the
 *                                    data is static/bundled, never
 *                                    changes at runtime, so this never
 *                                    needs to be called again afterward
 *                                    (dynamic rules just need
 *                                    re-establishing after an SW
 *                                    restart, same as
 *                                    restoreMatrixBlockRules()).
 *
 * Makes the Matrix panel's CRITICAL RESOURCE marker actually mean
 * something at the network level, not just a visual hint — before this,
 * a domain could show the green "trusted" marker in the panel while
 * still being silently blocked by a filter list underneath it, which
 * defeats the point of calling it "critical."
 *
 * GLOBAL, not per-site — deliberately different from the Matrix panel's
 * own per-site Allow/Block overrides (js/core/matrix-block-rules.js).
 * This matches how the real 3P-Matrix-lite's own builtin whitelist
 * behaves (a fixed, global trust list, not something scoped per browsing
 * session) — see that project's core/rule-classifier.js.
 *
 * TWO rules, not one, because BUILTIN_DOMAINS itself encodes
 * PER-RESOURCE-TYPE exemptions — e.g. hcaptcha.com is { script: false,
 * frame: true } (frame allowed, script still not) — 13 of ~190 entries
 * have at least one flag false. A single blanket "allow everything from
 * this domain" rule would silently over-grant those domains the
 * exemption they were deliberately NOT given for one resource type.
 *
 * Priority: BUILTIN_WHITELIST_RULES_PRIORITY (dnr-budgets.js) — above
 * every Security toggle and the static filter-list rulesets (so this
 * exemption actually overrides passive/automatic blocking), but below
 * the Matrix panel's own MATRIX_RULES_ALL/CODE_PRIORITY (a user's
 * deliberate Block click always wins over the automatic whitelist).
 */

import { dnr } from '../data/ext-compat.js';
import { BUILTIN_WHITELIST_RULES_BASE_ID, BUILTIN_WHITELIST_RULES_PRIORITY } from './dnr-budgets.js';
import { BUILTIN_DOMAINS } from '../data/matrix-constants.js';

const SCRIPT_RULE_ID = BUILTIN_WHITELIST_RULES_BASE_ID + 0;
const FRAME_RULE_ID  = BUILTIN_WHITELIST_RULES_BASE_ID + 1;

// Computed once at module load — BUILTIN_DOMAINS is a frozen bundled
// constant, never mutated at runtime, so there's nothing to invalidate
// or recompute later (unlike matrix-block-rules.js's per-site cache,
// which genuinely changes as the user clicks Allow/Block).
const SCRIPT_EXEMPT_DOMAINS = Object.keys(BUILTIN_DOMAINS).filter(d => BUILTIN_DOMAINS[d].script);
const FRAME_EXEMPT_DOMAINS  = Object.keys(BUILTIN_DOMAINS).filter(d => BUILTIN_DOMAINS[d].frame);

export async function updateBuiltinWhitelistRules() {
    const addRules = [
        {
            id: SCRIPT_RULE_ID,
            priority: BUILTIN_WHITELIST_RULES_PRIORITY,
            action: { type: 'allow' },
            condition: {
                requestDomains: SCRIPT_EXEMPT_DOMAINS,
                domainType: 'thirdParty',
                resourceTypes: [ 'script' ],
            },
        },
        {
            id: FRAME_RULE_ID,
            priority: BUILTIN_WHITELIST_RULES_PRIORITY,
            action: { type: 'allow' },
            condition: {
                requestDomains: FRAME_EXEMPT_DOMAINS,
                domainType: 'thirdParty',
                resourceTypes: [ 'sub_frame' ],
            },
        },
    ];

    await dnr.updateDynamicRules({
        removeRuleIds: [ SCRIPT_RULE_ID, FRAME_RULE_ID ],
        addRules,
    }).catch(reason => {
        console.error(`[uBlock-Dynamic] builtin-whitelist-rules/updateBuiltinWhitelistRules: ${reason}`);
    });
}
