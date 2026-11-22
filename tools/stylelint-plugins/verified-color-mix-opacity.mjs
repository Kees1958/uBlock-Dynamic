// tools/stylelint-plugins/verified-color-mix-opacity.mjs
//
// Encodes STYLE_GUIDE_LIGHT.md / STYLE_GUIDE_DARK.md's "Proven-safe
// de-emphasis opacities" tables directly as a lint rule, per A9's own
// requirement: "before introducing a new color/opacity value... check
// the relevant style guide first... if a genuinely new value is needed,
// compute its contrast in both modes per A8, then add it to both style
// guide files."
//
// Scope: only the EXACT documented pattern —
//   color: color-mix(in srgb, currentColor NN%, transparent);
// — matches the style guides' own de-emphasis-opacity tables. Does NOT
// fire on color-mix used for background-color/border-color, or any
// shape other than "currentColor NN%, transparent" (mixing a token into
// black, or mixing two named colors, is a different pattern with its
// own — currently unverified — contrast math; see the sibling rule
// no-unsafe-status-color-as-text.mjs for the --color-green/
// --color-amber-as-text case, which covers color-mix ingredients too).
import stylelint from 'stylelint';

const { createPlugin, utils: { report, ruleMessages, validateOptions } } = stylelint;

const ruleName = 'ubol/verified-color-mix-opacity';

// Proven values, both documented AND actually passing (see both style
// guides' tables — 25% and 35% are documented but FAIL). Kept in sync
// with STYLE_GUIDE_LIGHT.md/STYLE_GUIDE_DARK.md's own "Proven-safe
// de-emphasis opacities" tables — this set had drifted behind those
// tables (69/70/85/90 were added to both guides but never mirrored
// here), which made this check flag already-verified values as
// unverified; re-synced rather than recomputed (A9: reuse the guides'
// own recorded numbers).
const VERIFIED_PASSING = new Set([ 55, 65, 69, 70, 75, 85, 90 ]);
// Documented AND confirmed failing — a real violation, not just unverified.
const DOCUMENTED_FAILING = new Set([ 25, 35 ]);
const LOWEST_PROVEN_PASS = 55;
const HIGHEST_PROVEN_PASS = 90;

const messages = ruleMessages(ruleName, {
    failing: (pct) =>
        `color-mix opacity ${pct}% is a DOCUMENTED FAIL in both style guides' own tables (below the 3:1 minimum in at least one mode) — do not use; see STYLE_GUIDE_LIGHT.md/STYLE_GUIDE_DARK.md's "Proven-safe de-emphasis opacities" tables.`,
    belowFloor: (pct) =>
        `color-mix opacity ${pct}% is below the lowest proven-safe value (${LOWEST_PROVEN_PASS}%) documented in either style guide — unverified, and in the range where 25%/35% are known to fail. Compute its real contrast (A8) before shipping, or use a proven value (${[ ...VERIFIED_PASSING ].join('%, ')}%).`,
    unverifiedBetween: (pct) =>
        `color-mix opacity ${pct}% sits between two proven-safe values (${LOWEST_PROVEN_PASS}%/${HIGHEST_PROVEN_PASS}%) but isn't itself a documented, computed value — likely safe by the same monotonic trend (higher % = more contrast), but not literally verified. Either round to a proven value or compute and add its own style-guide entry (A9).`,
    aboveCeiling: (pct) =>
        `color-mix opacity ${pct}% is higher than the highest proven-safe value (${HIGHEST_PROVEN_PASS}%) documented — very likely safe (more opacity = more contrast), but not formally recorded in either style guide. Consider adding it once verified (A9), or use ${HIGHEST_PROVEN_PASS}% instead.`,
});

const meta = {
    url: 'https://internal/STYLE_GUIDE_LIGHT.md#proven-safe-de-emphasis-opacities-light-mode',
};

const colorMixPattern = /color-mix\(\s*in\s+srgb\s*,\s*currentColor\s+([0-9]+(?:\.[0-9]+)?)%\s*,\s*transparent\s*\)/i;

function rule(primary) {
    return (root, result) => {
        const validOptions = validateOptions(result, ruleName, { actual: primary, possible: [ true ] });
        if ( !validOptions ) { return; }

        root.walkDecls('color', (decl) => {
            const m = colorMixPattern.exec(decl.value);
            if ( !m ) { return; }
            const pct = parseFloat(m[1]);

            if ( VERIFIED_PASSING.has(pct) ) { return; } // proven-safe, nothing to flag

            let messageFn;
            if ( DOCUMENTED_FAILING.has(pct) ) { messageFn = messages.failing; }
            else if ( pct < LOWEST_PROVEN_PASS ) { messageFn = messages.belowFloor; }
            else if ( pct > HIGHEST_PROVEN_PASS ) { messageFn = messages.aboveCeiling; }
            else { messageFn = messages.unverifiedBetween; }

            report({
                message: messageFn,
                messageArgs: [ pct ],
                node: decl,
                result,
                ruleName,
            });
        });
    };
}

rule.ruleName = ruleName;
rule.messages = messages;
rule.meta = meta;

export default createPlugin(ruleName, rule);
