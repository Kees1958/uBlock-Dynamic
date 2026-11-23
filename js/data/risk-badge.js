/*
 * risk-badge.js — Shared breakage-risk badge display config
 *
 * Single source of truth for the 🔴/🟡/🟢/⚪ glyph + accessible label per
 * risk tier, used by both:
 *   - dashboard/custom-rules.js (a saved rule's breakage risk)
 *   - privacy/privacy-inspector.js (a LIVE signal's breakage risk, computed
 *     before any rule exists — see getScriptletRuleRisk() in
 *     scriptlet-rule-labels.js, fed a hypothetical {name, args} built by
 *     that page's own scriptletMappingFor())
 *   - matrix/matrix-panel.js (11.1.0 — a third-party DOMAIN's breakage risk
 *     in the DNR tracking filter, computed by js/core/breakage-risk.js;
 *     its hover reasons are DOMAIN_RISK_REASON below)
 *
 * 'unknown' is this module's own addition, not one of the three tiers
 * js/data/scriptlet-rule-labels.js classifies rules into — it's the
 * display fallback for when that module has no evidence-based data for a
 * given rule shape (e.g. a category with no scriptlet mapping at all, or
 * a hand-typed sandbox scriptlet). Shown explicitly rather than omitting
 * the badge entirely, so "no data" reads as a deliberate, understood
 * state instead of looking like a missing/broken badge.
 */

import { RISK_HIGH, RISK_MEDIUM, RISK_LOW } from './scriptlet-rule-labels.js';

export const RISK_UNKNOWN = 'unknown';

export const RISK_BADGE = {
    [RISK_HIGH]:    { glyph: '🔴', srLabel: 'Higher breakage risk' },
    [RISK_MEDIUM]:  { glyph: '🟡', srLabel: 'Some breakage risk' },
    [RISK_LOW]:     { glyph: '🟢', srLabel: 'Low breakage risk' },
    [RISK_UNKNOWN]: { glyph: '⚪', srLabel: 'Breakage risk unknown' },
};

export const UNKNOWN_RISK_REASON_RULE =
    'No breakage-risk data available for this rule — likely one you (or someone else) wrote directly in the sandbox editor rather than one created via the Monitor.';

export const UNKNOWN_RISK_REASON_SIGNAL =
    'No breakage-risk data available for this signal — there is no precise website-specific protection to assess yet.';

// (11.1.0) DNR tracking filter — hover reason per level, one per rule in js/core/breakage-risk.js (same order).
// Written from the user's side: what the domain is, and what blocking it is likely to do.
export const DOMAIN_RISK_REASON = Object.freeze({
    [RISK_HIGH]:
        'On the built-in whitelist of services websites need (payment, sign-in, CAPTCHA, video, code libraries). Blocking it will likely break this website.',
    [RISK_MEDIUM]:
        'Websites need this domain (or part of it): the tracker filter lists make an allow exception for it because blocking it broke websites (AdGuard, EFF Privacy Badger), or Disconnect or Ghostery list it as a tracker sites need (content, players, hosting, consent, chat, fraud protection). Blocking it may break this website.',
    [RISK_LOW]:
        'A known tracker (DuckDuckGo Tracker Radar) without an allow exception. Usually safe to block.',
    [RISK_UNKNOWN]:
        'Not on the built-in whitelist, the tracker exceptions or DuckDuckGo Tracker Radar: no breakage information for this domain.',
});
