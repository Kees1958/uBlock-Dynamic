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
