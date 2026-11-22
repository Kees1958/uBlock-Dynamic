// tools/build/safe-update-rules.mjs
// Single source of truth for what Chrome Web Store skip-review calls a
// "safe" rule. Imported by tools/build-safe-filters.mjs (which BUILDS a
// safe-only update) and tools/verify-safe-update.mjs (which PROVES a built
// package pair qualifies), so the two can never disagree.
//
// Chrome's own definition (developer.chrome.com/docs/extensions/reference/
// api/declarativeNetRequest#safe_rules): a rule is safe when action.type is
// one of the values below. `redirect` (which is what $removeparam compiles
// to) and `modifyHeaders` are NOT safe.
//
// Pure data — nothing to initialise, clear or release.

export const SAFE_RULE_ACTIONS = Object.freeze([ 'block', 'allow', 'allowAllRequests', 'upgradeScheme' ]);

/** True when a DNR rule's action type is one Chrome treats as safe. */
export function isSafeRule(rule) {
    return SAFE_RULE_ACTIONS.includes(rule?.action?.type);
}
