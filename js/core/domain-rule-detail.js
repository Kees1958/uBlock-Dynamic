/*
 * domain-rule-detail.js — On-demand raw rule lookup for one domain
 *
 * Public interface:
 *   getDomainRuleDetail(domain) — scans every ENABLED static ruleset's
 *                                 compiled JSON, returns every rule that
 *                                 mentions this domain, as plain data
 *                                 (no priority/allow-override resolution
 *                                 — see below for why)
 *
 * WHY THIS EXISTS
 * matrix-panel.js's SHOW BLOCKED/ALLOWED view answers one coarse
 * question per domain: "is the whole domain blocked?" (see
 * static-block-check.js). That's wrong for a domain like xHamster's
 * phncdn.com, which has THREE narrow block rules on specific paths and
 * FOUR allow rules on other specific paths/domains under it — a single
 * yes/no can't represent that, and answering it correctly would require
 * real DNR-equivalent matching (urlFilter wildcards/anchors, priority
 * ordering, domainType) — a substantially larger undertaking, discussed
 * and deliberately deferred (see CHANGELOG). This module is the
 * DELIBERATELY SIMPLER first step of that: on click (Matrix panel's new
 * expand-row column), fetch every rule that MENTIONS this domain and let
 * the person read them directly — no attempt to compute a final verdict.
 * Cheap because it's on-demand (one domain, one click), not run
 * continuously across live traffic — same "expensive-but-accurate on
 * click, not always-on" reasoning already agreed for this feature.
 *
 * MATCHING HEURISTIC (deliberately permissive, not a real DNR matcher):
 * a rule "mentions" a domain if the domain is in its requestDomains
 * array (the coalesced-rule form — see static-block-check.js's own
 * requestDomains fix for why this matters), OR its urlFilter contains
 * the domain as a substring (covers both bare ||domain^ rules AND
 * path-specific ones like "phncdn.com, wildcard, pics/skins path"). This is
 * intentionally loose — a false-positive match (a rule that happens to
 * contain the domain string but wouldn't really apply) is an acceptable
 * cost for a "show me everything relevant, let the person judge" tool;
 * a false negative (hiding a genuinely relevant rule) is not.
 *
 * NOT included, on purpose, for this first pass:
 *   - priority ordering / resolving which rule actually wins
 *   - initiatorDomains/excludedInitiatorDomains matching against the
 *     CURRENT page (shown as raw data, not evaluated)
 *   - resourceType matching against what was actually observed
 * All of the above are exactly the "substantially larger undertaking"
 * scoped out of this pass — see CHANGELOG for the fuller discussion.
 *
 * BUG FIX (real report, 10.6.4): this used to ONLY scan the bundled
 * static ruleset JSON files (manifest.declarative_net_request.
 * rule_resources). It never looked at chrome.declarativeNetRequest.
 * getDynamicRules() at all — which is where a user's own "Import ABP
 * rules" sandbox rules actually live (USER_RULES_BASE_ID, dnr-budgets.js),
 * and where Matrix-panel click overrides live too (MATRIX_RULES_BASE_ID).
 * Confirmed via a real case: a saved `||sentry.io^$domain=nos.nl` ABP-
 * import rule genuinely blocked the request (verified in DevTools'
 * Network tab — status (blocked:other)), while this module told the
 * Matrix panel "No rules... apply to this domain", because it was
 * structurally incapable of ever seeing a dynamic rule, no matter how
 * correct that rule was. Fixed by also scanning getDynamicRules() with
 * the exact same loose "mentions this domain" heuristic already used for
 * static rules, tagging each match with a human-readable source label
 * (see dynamicRuleSourceLabel() below) instead of a ruleset id — the
 * renderer (matrix/matrix-panel.js's rulesetDisplayName()) already falls
 * back to showing the raw string when it isn't a known ruleset id, so no
 * renderer change was needed for this to display correctly.
 */

import { browser } from '../data/ext.js';
import { WORRY_FREE_NAME } from '../data/ui-names.js';
import { dnr } from '../data/ext-compat.js';
import { getEnabledRulesets } from './static-rulesets.js';
import {
    USER_RULES_BASE_ID, USER_RULES_MAX,
    MATRIX_RULES_BASE_ID, MATRIX_RULES_MAX_DNR,
} from './dnr-budgets.js';
import { catchExpected } from '../data/expected-errors.js';

/******************************************************************************/

// Human-readable source label for a live dynamic DNR rule, by which
// reserved id range (dnr-budgets.js) its id falls into — the SAME ranges
// ruleset-manager.js / matrix-block-rules.js already use to own their own
// rules, read here rather than re-declared, so this never drifts out of
// sync with the real allocation (B1: one source of truth, no magic
// numbers duplicated).
function dynamicRuleSourceLabel(id) {
    if ( id >= USER_RULES_BASE_ID && id < USER_RULES_BASE_ID + USER_RULES_MAX ) {
        return 'Custom rule (Import ABP rules)';
    }
    if ( id >= MATRIX_RULES_BASE_ID && id < MATRIX_RULES_BASE_ID + MATRIX_RULES_MAX_DNR ) {
        return 'Matrix panel override';
    }
    return `Other active rule (built-in whitelist / security / ${WORRY_FREE_NAME})`;
}

function mentionsDomain(cond, needle) {
    const requestDomains = Array.isArray(cond.requestDomains) ? cond.requestDomains : [];
    const urlFilter = typeof cond.urlFilter === 'string' ? cond.urlFilter : '';
    return {
        matched: requestDomains.includes(needle) || urlFilter.toLowerCase().includes(needle),
        requestDomains,
        urlFilter,
    };
}

// Deliberately NOT cached like static-block-check.js's blockedDomains —
// this runs once per explicit user click on one domain, not continuously
// across live traffic, so there's no repeated-cost problem to solve by
// caching, and caching would need its own invalidation story (ruleset
// toggles, etc.) for a feature that doesn't need it.
export async function getDomainRuleDetail(domain) {
    if ( typeof domain !== 'string' || domain === '' ) { return []; }
    const needle = domain.toLowerCase();

    const manifest = browser.runtime.getManifest();
    const resources = manifest.declarative_net_request?.rule_resources ?? [];
    const enabledIds = await getEnabledRulesets();

    const matches = [];

    await Promise.all([
        ...resources
            .filter(r => enabledIds.has(r.id))
            .map(async r => {
                try {
                    const res = await fetch(browser.runtime.getURL(r.path));
                    const rules = await res.json();
                    for ( const rule of rules ) {
                        const cond = rule.condition ?? {};
                        const { matched, requestDomains, urlFilter } = mentionsDomain(cond, needle);
                        if ( !matched ) { continue; }
                        matches.push({
                            ruleset: r.id,
                            action: rule.action?.type ?? 'unknown',
                            priority: rule.priority ?? null,
                            urlFilter: urlFilter || null,
                            // Only surfaced when the coalesced array is
                            // small enough to be meaningful context —
                            // a 3000-domain array being "the pattern"
                            // for a match is noise, not signal.
                            requestDomainsCount: requestDomains.length > 0 ? requestDomains.length : null,
                            resourceTypes: cond.resourceTypes ?? null,
                            excludedResourceTypes: cond.excludedResourceTypes ?? null,
                            initiatorDomains: cond.initiatorDomains ?? null,
                            excludedInitiatorDomains: cond.excludedInitiatorDomains ?? null,
                            domainType: cond.domainType ?? null,
                        });
                    }
                } catch (reason) {
                    // One unreadable/malformed ruleset file shouldn't take
                    // down the whole lookup — skip it, keep the rest, but log it (C5).
                    catchExpected('read static ruleset for domain lookup', [])(reason);
                }
            }),
        // Live dynamic rules — custom/sandbox ABP-import rules AND Matrix
        // panel click overrides both live here (see this file's header
        // for the real bug this closes). Same loose match heuristic,
        // same permissive "show it, let the person judge" philosophy.
        (async () => {
            try {
                const dynamicRules = await dnr.getDynamicRules();
                for ( const rule of dynamicRules ) {
                    const cond = rule.condition ?? {};
                    const { matched, requestDomains, urlFilter } = mentionsDomain(cond, needle);
                    if ( !matched ) { continue; }
                    matches.push({
                        ruleset: dynamicRuleSourceLabel(rule.id),
                        action: rule.action?.type ?? 'unknown',
                        priority: rule.priority ?? null,
                        urlFilter: urlFilter || null,
                        requestDomainsCount: requestDomains.length > 0 ? requestDomains.length : null,
                        resourceTypes: cond.resourceTypes ?? null,
                        excludedResourceTypes: cond.excludedResourceTypes ?? null,
                        initiatorDomains: cond.initiatorDomains ?? null,
                        excludedInitiatorDomains: cond.excludedInitiatorDomains ?? null,
                        domainType: cond.domainType ?? null,
                    });
                }
            } catch (reason) {
                // dnr.getDynamicRules() failing shouldn't take down the
                // whole lookup either — same "skip it, keep the rest"
                // reasoning as the static-ruleset fetches above (logged, C5).
                catchExpected('read dynamic rules for domain lookup', [])(reason);
            }
        })(),
    ]);

    // Highest priority first — not a resolved verdict (see header), just
    // the most useful reading order for a person scanning the list by
    // hand, since a higher-priority rule is the one more likely to
    // actually matter if there's a conflict.
    matches.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return matches;
}
