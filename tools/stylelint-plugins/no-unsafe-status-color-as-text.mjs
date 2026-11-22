// tools/stylelint-plugins/no-unsafe-status-color-as-text.mjs
//
// Encodes STYLE_GUIDE_LIGHT.md's own documented incident directly as a
// lint rule: "--color-green/--color-amber were used as text color in
// several places before it was discovered they only ever passed WCAG
// for dark mode, never light" (2.52:1 / 1.93:1 in light mode — well
// under the 4.5:1 text minimum). The fix the style guide documents is
// the `-text` variant (`--color-green-text` / `--color-amber-text`),
// verified at 5.18:1 / 4.73:1 in light mode.
//
// Two shapes flagged, both under the `color` property specifically (not
// background-color/border-color/box-shadow, which the style guide's own
// "Component patterns" section explicitly says raw --color-green/
// --color-amber ARE fine for — fill/border usage was never the bug):
//   1. `color: var(--color-green)` / `color: var(--color-amber)` — the
//      literal historical bug, direct token reference as text color.
//   2. `color: color-mix(in srgb, var(--color-green) NN%, ...)` or the
//      reverse ingredient order — using the raw (not -text) token as an
//      ingredient of a computed text color. Not literally the same bug,
//      but the same underlying risk (a light-mode-unsafe token feeding
//      into what ends up as text color) — flagged as a MUST-VERIFY
//      finding rather than a hard "documented fail," since color-mix
//      shifts the result partway toward the ingredient rather than
//      being it outright.
//
// Verified exception (10.1.4): a color-mix() text colour that is listed in
// VERIFIED_TEXT_MIXES below is NOT reported. Those exact shapes were
// computed in BOTH modes and recorded in the style guides (A8/A9), so
// flagging them was a false positive (3 of them, every run, from 10.1.1 on).
// Anything else — another percentage, another token, another partner colour
// — is still reported, exactly as before.
import stylelint from 'stylelint';

const { createPlugin, utils: { report, ruleMessages, validateOptions } } = stylelint;

const ruleName = 'ubol/no-unsafe-status-color-as-text';

const UNSAFE_TOKENS = [ '--color-green', '--color-amber' ];
// ── VERIFIED_TEXT_MIXES — single place for the allow-list ───────────────────
// One entry per color-mix() TEXT colour whose real contrast was computed in
// both modes and recorded in the style guides. To allow a new one: compute it
// (A8), add it to STYLE_GUIDE_LIGHT.md AND STYLE_GUIDE_DARK.md first, THEN add
// it here with the same numbers. `partner` is the second colour in the mix.
const VERIFIED_TEXT_MIXES = Object.freeze([
    Object.freeze({
        token:   '--color-amber',
        percent: 50,
        partner: 'currentColor',
        light:   '4.97:1',   // STYLE_GUIDE_LIGHT.md, "Component patterns" row (amber 10% over surface-1)
        dark:    '9.68:1',   // STYLE_GUIDE_DARK.md, same pattern
        usedBy:  '#monitorHelpWarning, .custom-rules-hint',
    }),
]);

// Matches the whole value: color-mix(in srgb, var(--token) NN%, partner)
const COLOR_MIX_VALUE_PATTERN =
    /^color-mix\(\s*in\s+srgb\s*,\s*var\(\s*(--[a-z0-9-]+)\s*\)\s+([0-9]+(?:\.[0-9]+)?)%\s*,\s*([a-z-]+)\s*\)$/i;

// True only for an exact, recorded shape; pure function, no state.
function isVerifiedTextMix(value) {
    const m = COLOR_MIX_VALUE_PATTERN.exec(value.trim());
    if ( m === null ) { return false; }
    const [ , token, percent, partner ] = m;
    return VERIFIED_TEXT_MIXES.some(v =>
        v.token === token &&
        v.percent === Number(percent) &&
        v.partner.toLowerCase() === partner.toLowerCase()
    );
}

const SAFE_TEXT_VARIANT = { '--color-green': '--color-green-text', '--color-amber': '--color-amber-text' };

const messages = ruleMessages(ruleName, {
    directReference: (token) =>
        `color: var(${token}) as TEXT color is the exact documented bug in STYLE_GUIDE_LIGHT.md — ${token} is confirmed NOT text-safe in light mode (see its "Core tokens" table). Use var(${SAFE_TEXT_VARIANT[token]}) instead — see STYLE_GUIDE_LIGHT.md's "Text-safe variants" section.`,
    colorMixIngredient: (token) =>
        `color-mix(...) using var(${token}) as an ingredient of a TEXT color — ${token} itself is documented as light-mode-unsafe (see STYLE_GUIDE_LIGHT.md's "Core tokens" table). This isn't the literal documented bug (color-mix shifts toward it, doesn't equal it outright), but the same underlying risk. Compute the actual resulting contrast (A8) before shipping, or use var(${SAFE_TEXT_VARIANT[token]}) instead.`,
});

const meta = {
    url: 'https://internal/STYLE_GUIDE_LIGHT.md#text-safe-variants-introduced-for-the-matrix-panel-reusable-pattern',
};

function rule(primary) {
    return (root, result) => {
        const validOptions = validateOptions(result, ruleName, { actual: primary, possible: [ true ] });
        if ( !validOptions ) { return; }

        root.walkDecls('color', (decl) => {
            for ( const token of UNSAFE_TOKENS ) {
                const directPattern = new RegExp(`var\\(\\s*${token}\\s*(?:,[^)]*)?\\)`);
                const isDirect = directPattern.test(decl.value);
                const isInsideColorMix = /color-mix\(/i.test(decl.value);

                if ( !isDirect ) { continue; }

                if ( isInsideColorMix ) {
                    if ( isVerifiedTextMix(decl.value) ) { continue; }
                    report({
                        message: messages.colorMixIngredient,
                        messageArgs: [ token ],
                        node: decl,
                        result,
                        ruleName,
                    });
                } else {
                    report({
                        message: messages.directReference,
                        messageArgs: [ token ],
                        node: decl,
                        result,
                        ruleName,
                    });
                }
            }
        });
    };
}

rule.ruleName = ruleName;
rule.messages = messages;
rule.meta = meta;

export default createPlugin(ruleName, rule);
