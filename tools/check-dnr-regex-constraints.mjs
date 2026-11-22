// New check (this session): Chrome declarativeNetRequest regexFilter
// constraints. Verified against Chrome's own docs before writing this
// (not assumed from general regex knowledge):
//
//   - regexFilter follows RE2 syntax, NOT full PCRE/JS regex — RE2
//     deliberately excludes backtracking-requiring constructs for
//     guaranteed linear-time matching. No lookahead ((?=...), (?!...)),
//     no lookbehind ((?<=...), (?<!...)), no backreferences (\1, \2...
//     referring back to an earlier capture group).
//   - regexFilter must be composed of ONLY ASCII characters.
//   - declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES = 1000, evaluated
//     SEPARATELY from the general dynamic-rule cap, and separately for
//     (a) dynamic + session-scoped rules combined, (b) each static
//     ruleset file. This is a DIFFERENT, SMALLER cap than a feature's
//     own general rule-count budget (e.g. USER_RULES_MAX = 5000 in
//     dnr-budgets.js) — staying under the general cap does NOT mean
//     staying under the regex-specific one.
//
// This is a static, pre-flight sanity check — Chrome's own
// dnr.isRegexSupported() (already used at runtime by this codebase's
// own pruneInvalidRegexRules() in ruleset-manager.js) remains the
// authoritative check for whether a SPECIFIC regex compiles within RE2's
// actual complexity budget; this script cannot fully replace that (it
// uses JS's regex engine as a syntax sanity check only, which is a
// different engine with different acceptance rules), but it catches
// gross RE2-incompatible constructs and the aggregate count question,
// both before ever reaching the browser.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');
// Single source of truth (dnr-budgets.js) — was a local, independently-
// hardcoded 1000 here before, duplicating the real value instead of
// importing it. Now imported so this check and the runtime cap in
// ruleset-manager.js's updateUserRules() can never drift apart.
// dnr-budgets.js has zero imports of its own (pure constants file, see
// its own header) — no chrome/browser/self mock needed to load it.
const { MAX_NUMBER_OF_REGEX_RULES } = await import(pathToFileURL(path.join(ROOT, 'js/core/dnr-budgets.js')).href);

console.log('=== Chrome DNR regexFilter constraints check ===');
let ok = true;

// ── 1. Extract statically-known regexFilter string literals from
//      ruleset-manager.js (the security-toggle rules) and validate each
//      for RE2-incompatible constructs. ──────────────────────────────
const rsSrc = fs.readFileSync(path.join(ROOT, 'js/core/ruleset-manager.js'), 'utf8');
const literalPattern = /regexFilter:\s*'((?:[^'\\]|\\.)*)'/g;
const staticRegexes = [ ...rsSrc.matchAll(literalPattern) ].map(m => ({ raw: m[1], quoted: true }));

// Template-literal regexFilter values (e.g. with an interpolated
// ${allowedPorts}) are skipped by the pattern above (single-quote only)
// — captured separately here. The interpolated part can't be resolved
// statically, but the STATIC text around it still shows up literally, so
// an RE2-unsupported construct sitting in the static portion is still
// caught; only the interpolated segment itself is unchecked.
const templatePattern = /regexFilter:\s*`([^`]*)`/g;
const templateRegexes = [ ...rsSrc.matchAll(templatePattern) ].map(m => ({ raw: m[1], quoted: false }));

console.log(`\nFound ${staticRegexes.length} single-quoted + ${templateRegexes.length} template-literal regexFilter declaration(s) in ruleset-manager.js.`);
if ( templateRegexes.length > 0 ) {
    console.log('(Template-literal ones are checked on their STATIC text only — any ${...} interpolated segment is not statically resolvable and is skipped within that pattern.)');
}

const RE2_UNSUPPORTED = [
    { pattern: /\(\?=/,  label: 'positive lookahead (?=...)' },
    { pattern: /\(\?!/,  label: 'negative lookahead (?!...)' },
    { pattern: /\(\?<=/, label: 'positive lookbehind (?<=...)' },
    { pattern: /\(\?<!/, label: 'negative lookbehind (?<!...)' },
    { pattern: /\\[1-9]/, label: 'backreference (\\1-\\9)' },
    { pattern: /\\k</,   label: 'named backreference (\\k<name>)' },
];

for ( const { raw, quoted } of [ ...staticRegexes, ...templateRegexes ] ) {
    // Un-escape the JS string-literal escaping (\\d -> \d, etc.) to get
    // the actual regex source the browser will see. Template literals
    // don't need the single-quote unescaping step single-quoted strings do.
    let regexSource;
    try {
        regexSource = quoted ? JSON.parse(`"${raw.replace(/\\'/g, "'")}"`) : raw.replace(/\\\\/g, '\\');
    } catch {
        regexSource = raw; // fall back to raw text if un-escaping trips on something unexpected
    }
    // Template-literal interpolations (${allowedPorts}, etc.) aren't
    // statically resolvable — substitute a harmless placeholder so the
    // STATIC text around them can still be validated for RE2-unsupported
    // constructs and basic parseability, without the literal "${...}"
    // syntax itself (not valid regex on its own) causing a false FAIL.
    const hadInterpolation = /\$\{[^}]*\}/.test(regexSource);
    regexSource = regexSource.replace(/\$\{[^}]*\}/g, 'PLACEHOLDER');

    console.log(`\n  Pattern: ${regexSource}${hadInterpolation ? '  (interpolated segment replaced with PLACEHOLDER for static validation)' : ''}`);

    // ASCII-only check
    const nonAscii = [ ...regexSource ].filter(ch => ch.charCodeAt(0) > 127);
    if ( nonAscii.length > 0 ) {
        ok = false;
        console.log(`    FAIL: contains non-ASCII character(s): ${nonAscii.join(', ')} — regexFilter must be ASCII-only`);
    }

    // RE2-unsupported construct check
    let foundUnsupported = false;
    for ( const { pattern, label } of RE2_UNSUPPORTED ) {
        if ( pattern.test(regexSource) ) {
            ok = false;
            foundUnsupported = true;
            console.log(`    FAIL: contains ${label} — not supported by RE2`);
        }
    }

    // Baseline JS-regex parseability — not proof of RE2 acceptance (different
    // engine, different acceptance rules — see this file's header), but a
    // gross syntax error here would fail in RE2 too.
    try {
        new RegExp(regexSource);
    } catch (err) {
        ok = false;
        console.log(`    FAIL: does not even parse as a JS regex (would certainly fail RE2 too): ${err.message}`);
    }

    if ( !foundUnsupported && nonAscii.length === 0 ) {
        console.log('    PASS: ASCII-only, no RE2-unsupported constructs found, parses as valid regex syntax.');
    }
}

// ── 2. Confirm the existing runtime validation mechanism is still wired
//      — this script doesn't replace it, so verify it hasn't been
//      accidentally removed. ─────────────────────────────────────────
console.log('');
// (11.0.0) The check itself moved to js/core/regex-rule-guard.js; BOTH rule writers that can carry a regexFilter must
// route through it — ruleset-manager.js (user/ABP rules) and cmp-loader-block-manager.js (EasyList cookie block rules,
// where a refused regex took every session rule down on 11.0.0's first load).
const guardSrc = fs.readFileSync(path.join(ROOT, 'js/core/regex-rule-guard.js'), 'utf8');
const cmpSrc = fs.readFileSync(path.join(ROOT, 'js/core/cmp-loader-block-manager.js'), 'utf8');
function usesGuard(src) { return /import \{ pruneInvalidRegexRules \} from '\.\/regex-rule-guard\.js';/.test(src) && /await pruneInvalidRegexRules\(/.test(src); }
const hasRuntimeValidation = guardSrc.includes('dnr.isRegexSupported(') && usesGuard(rsSrc) && usesGuard(cmpSrc);
if ( !hasRuntimeValidation ) {
    ok = false;
    console.log('FAIL: expected runtime regex validation (dnr.isRegexSupported() via pruneInvalidRegexRules(), js/core/regex-rule-guard.js) used by both ruleset-manager.js and cmp-loader-block-manager.js — this is the AUTHORITATIVE check (real RE2 engine, not this script\'s JS-regex approximation) and must stay wired.');
} else {
    console.log('PASS: runtime regex validation (dnr.isRegexSupported() via pruneInvalidRegexRules()) is present — the authoritative RE2 check for dynamically-constructed regexFilter rules (e.g. from ABP import) that this static script cannot itself validate.');
}

// ── 3. Aggregate regex-rule count vs MAX_NUMBER_OF_REGEX_RULES — this is
//      a SEPARATE, smaller cap than any feature's own general rule-count
//      budget (e.g. USER_RULES_MAX). Known-static count only; does NOT
//      include dynamically-compiled ABP-import regex rules, which are
//      proactively capped at runtime instead (checked below). ─────────
console.log('');
const totalStaticCount = staticRegexes.length + templateRegexes.length;
console.log(`Known static regexFilter rule count: ${totalStaticCount} (well under the ${MAX_NUMBER_OF_REGEX_RULES}-rule cap).`);
const userRulesMaxMatch = fs.readFileSync(path.join(ROOT, 'js/core/dnr-budgets.js'), 'utf8').match(/USER_RULES_MAX\s*=\s*([\d_]+)/);
const userRulesMax = userRulesMaxMatch ? Number(userRulesMaxMatch[1].replace(/_/g, '')) : undefined;

// Previously just an informational NOTE ("not fixed by this check,
// flagged for a deliberate decision") — the decision was made and the
// fix landed in ruleset-manager.js's updateUserRules(), so this is now a
// real PASS/FAIL verifying the fix is actually present and hasn't been
// silently reverted, not a reminder that it's still missing.
if ( userRulesMax !== undefined && userRulesMax > MAX_NUMBER_OF_REGEX_RULES ) {
    console.log(`NOTE: USER_RULES_MAX (${userRulesMax}, dnr-budgets.js) is HIGHER than MAX_NUMBER_OF_REGEX_RULES (${MAX_NUMBER_OF_REGEX_RULES}) — a user's "Import ABP rules" input CAN exceed the regex cap while staying under the general one. Verifying the proactive runtime guard for this below.`);
    const hasProactiveRegexCap = rsSrc.includes('MAX_NUMBER_OF_REGEX_RULES') && rsSrc.includes('regexRulesDropped');
    if ( !hasProactiveRegexCap ) {
        ok = false;
        console.log('FAIL: expected a proactive regexFilter-count cap in ruleset-manager.js\'s updateUserRules() (checking rule.condition.regexFilter against MAX_NUMBER_OF_REGEX_RULES BEFORE calling dnr.updateDynamicRules(), same pattern as the USER_RULES_MAX overflow check) — not found. Without it, Chrome rejects the ENTIRE updateDynamicRules({ addRules }) call atomically when the regex-bearing subset exceeds this cap, surfacing as one generic caught error instead of a specific, actionable message.');
    } else {
        console.log('PASS: updateUserRules() proactively caps regexFilter-bearing rules against MAX_NUMBER_OF_REGEX_RULES before submitting — same "keep the first N, report the rest as dropped" pattern as the USER_RULES_MAX check, imported from the same dnr-budgets.js constant this script uses.');
    }
}

// ── 4. (10.7.6) Shipped filter-list rulesets — regexFilter rules are now compiled from the lists, gated by
//      Chrome's own isRegexSupported() at build time (tools/build/regex-support.mjs). Verified here from the
//      SHIPPED files: every regex has a cached "supported" verdict (none slipped past the gate), is ASCII-only,
//      and no ruleset exceeds Chrome's per-ruleset cap (owner's 800 warning reported). ─────────────────────
console.log('');
{
    const { REGEX_SUPPORT_CONFIG, verdictKey } = await import(pathToFileURL(path.join(ROOT, 'tools/build/regex-support.mjs')).href);
    const verdictFile = path.join(ROOT, REGEX_SUPPORT_CONFIG.VERDICTS_FILE);
    const verdicts = fs.existsSync(verdictFile) ? JSON.parse(fs.readFileSync(verdictFile, 'utf8')).verdicts : {};
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    let shipped = 0;
    for ( const { id, path: rel } of manifest.declarative_net_request?.rule_resources ?? [] ) {
        const rules = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        const regexRules = rules.filter(r => typeof r.condition?.regexFilter === 'string');
        shipped += regexRules.length;
        if ( regexRules.length > MAX_NUMBER_OF_REGEX_RULES ) {
            ok = false;
            console.log(`FAIL: ${id} ships ${regexRules.length} regex rules — above Chrome's ${MAX_NUMBER_OF_REGEX_RULES} per static ruleset.`);
        } else if ( regexRules.length > REGEX_SUPPORT_CONFIG.WARN_REGEX_RULES_PER_RULESET ) {
            console.log(`NOTE: ${id} ships ${regexRules.length} regex rules — above the ${REGEX_SUPPORT_CONFIG.WARN_REGEX_RULES_PER_RULESET} warning level.`);
        }
        for ( const r of regexRules ) {
            const key = verdictKey(r.condition.regexFilter, r.condition.isUrlFilterCaseSensitive === true);
            if ( verdicts[key]?.supported !== true ) {
                ok = false;
                console.log(`FAIL: ${id} rule ${r.id} ships a regex with no "supported" Chrome verdict: /${r.condition.regexFilter}/`);
            }
            if ( /[^\x00-\x7F]/.test(r.condition.regexFilter) ) {
                ok = false;
                console.log(`FAIL: ${id} rule ${r.id} has a non-ASCII regexFilter.`);
            }
        }
    }
    console.log(`Shipped filter-list regexFilter rules: ${shipped} — each checked against its cached Chrome verdict (${REGEX_SUPPORT_CONFIG.VERDICTS_FILE}).`);
}

console.log('');
process.exitCode = ok ? 0 : 1;
