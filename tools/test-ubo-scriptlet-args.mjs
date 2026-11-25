#!/usr/bin/env node
// test-ubo-scriptlet-args.mjs — (11.1.4) uBO's named extra scriptlet arguments are translated for AdGuard's scriptlet
// (js/data/ubo-scriptlet-args.js), in the build and for the user's own rules.
//
// Checked with the REAL functions (no network):
//   1. the translated rule empties EXACTLY the texts uBO's rmnt would: the combined pattern is run against sample
//      script texts and compared with uBO's own decision (includes / excludes / condition, string and regex forms) —
//      the real foxbusiness.com rules from uBO's Admiral section are among the cases;
//   2. rules that need no translation come back unchanged (AdGuard's own remove-node-text with a parent selector,
//      a two-argument rmnt), and a translated rule is stable when translated again;
//   3. what cannot be expressed exactly is refused with a reason (unknown key, missing value, mixed flags);
//   4. wiring: the build's scriptlet parser (rules AND exceptions) and the custom-rule parser use the translation.
//
// Usage: node tools/test-ubo-scriptlet-args.mjs   (step 97 of tools/complete-check.mjs)
// Pure: in-memory fixtures; resets the build's report accumulators before and after (RELEASE guard).

import { translateUboScriptletArgs, UBO_SCRIPTLET_ARGS } from '../js/data/ubo-scriptlet-args.js';
import { parseScriptletExceptionRules, parseScriptletRules } from './build/scriptlet-rules.mjs';
import { droppedUnsupportedScriptletScopes, resetBuildAccumulators } from './build/build-state.mjs';

// ── CONFIG ─────────────────────────────────────────────────────────────
const TEST_CONFIG = Object.freeze({
    // uBO's own foxbusiness.com rule arguments (uAssets filters-general.txt, Admiral section, 2026-11-25).
    FOXBUSINESS_EXCLUDES: '/,\\\\"|self\\.__next|pageProps/',
    ADMIRAL_TEXT:  'window.admiral=1; if(typeof a.unshift==="function"){adblockerDisabled()}',
    NEXT_TEXT:     'self.__next_f.push([1,"adblockerDisabled appears in page data"])',
    PLAIN_TEXT:    'console.log("nothing to see")',
    ALLOW_HOST:    'always.example',
    EXT_ID:        'testextensionid',
});

// Minimal extension environment before the run-time module is imported (same stub shape as test-picker-hardening).
globalThis.self = globalThis;
globalThis.chrome = {
    runtime: { id: TEST_CONFIG.EXT_ID, getURL: p => `chrome-extension://${TEST_CONFIG.EXT_ID}${p}`, sendMessage: async () => undefined, getManifest: () => ({ version: '0' }) },
    storage: {
        local: { async get() { return {}; }, async set() {}, async remove() {} },
        session: { async get() { return {}; }, async set() {}, async setAccessLevel() {} },
    },
    i18n: { getMessage: () => '' },
};
const { parseScriptletLine } = await import('../js/core/custom-scriptlets.js');

const failures = [];
function check(label, condition, detail = '') { if ( condition !== true ) { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); } }

// The decision AdGuard's remove-node-text makes for a node text, with the translated arguments (its toRegExp():
// "/body/flags" → new RegExp(body, flags), a plain string → literal match).
function adguardEmpties(args, text) {
    const pattern = args[1];
    const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
    const re = m === null ? new RegExp(pattern.replace(UBO_SCRIPTLET_ARGS.REGEX_SPECIAL_RE, '\\$&')) : new RegExp(m[1], m[2]);
    return re.test(text);
}
// uBO's own decision (replaceNodeTextFn): includes/condition must match, excludes must not, the pattern must.
// uBO's patternToRegex(): "/body/flags" as written, a plain string literal with the given flags.
function toRe(p, flags) {
    const m = /^\/(.+)\/([gimsu]*)$/.exec(p);
    return m ? new RegExp(m[1], m[2]) : new RegExp(p.replace(UBO_SCRIPTLET_ARGS.REGEX_SPECIAL_RE, '\\$&'), flags);
}
function uboEmpties(pattern, extra, text) {
    const inc = extra.includes ?? extra.condition;
    if ( inc !== undefined && toRe(inc, 'ms').test(text) === false ) { return false; }
    if ( extra.excludes !== undefined && toRe(extra.excludes, 'ms').test(text) ) { return false; }
    return pattern === '' || toRe(pattern, 'gms').test(text);
}

resetBuildAccumulators();
try {
    // 1. Same decision as uBO on sample texts.
    const cases = [
        [ 'script', 'adblockerDisabled', { excludes: TEST_CONFIG.FOXBUSINESS_EXCLUDES } ],
        [ 'script', '/typeof [a-z]\\.unshift/', { excludes: TEST_CONFIG.FOXBUSINESS_EXCLUDES } ],
        [ 'script', 'admiral', { condition: 'unshift' } ],
        [ 'script', '', { includes: 'admiral', excludes: '__next' } ],
        [ 'script', '/ADMIRAL/i', { excludes: '/next/i' } ],
    ];
    for ( const [ node, pattern, extra ] of cases ) {
        const flat = Object.entries(extra).flat();
        const t = translateUboScriptletArgs('ubo-rmnt', [ node, pattern, ...flat ]);
        check(`translates rmnt(${pattern}, ${flat.join(', ')})`, t.error === undefined && t.name === UBO_SCRIPTLET_ARGS.ADGUARD_REMOVE_NODE_TEXT && t.args.length === 2, JSON.stringify(t));
        if ( t.error !== undefined ) { continue; }
        for ( const text of [ TEST_CONFIG.ADMIRAL_TEXT, TEST_CONFIG.NEXT_TEXT, TEST_CONFIG.PLAIN_TEXT ] ) {
            check(`same decision as uBO: rmnt(${pattern}, ${flat.join(', ')}) on "${text.slice(0, 30)}…"`,
                adguardEmpties(t.args, text) === uboEmpties(pattern, extra, text));
        }
    }
    check('the foxbusiness excludes case really excludes Next.js page data', (() => {
        const t = translateUboScriptletArgs('ubo-rmnt', [ 'script', 'adblockerDisabled', 'excludes', TEST_CONFIG.FOXBUSINESS_EXCLUDES ]);
        return adguardEmpties(t.args, TEST_CONFIG.ADMIRAL_TEXT) && adguardEmpties(t.args, TEST_CONFIG.NEXT_TEXT) === false;
    })());
    check('timing-only arguments are dropped', JSON.stringify(translateUboScriptletArgs('rmnt', [ 'script', 'x', 'stay', '1' ]).args) === JSON.stringify([ 'script', 'x' ]));
    // 2. Unchanged / stable.
    const adg = translateUboScriptletArgs('remove-node-text', [ 'script', 'x', 'div.parent' ]);
    check('AdGuard remove-node-text keeps its parent-selector argument', JSON.stringify(adg.args) === JSON.stringify([ 'script', 'x', 'div.parent' ]));
    check('a two-argument rmnt is unchanged', JSON.stringify(translateUboScriptletArgs('ubo-rmnt', [ 'script', 'x' ]).args) === JSON.stringify([ 'script', 'x' ]));
    const once = translateUboScriptletArgs('ubo-rmnt', [ 'script', 'x', 'excludes', 'y' ]);
    const twice = translateUboScriptletArgs(once.name, once.args);
    check('translating twice changes nothing', JSON.stringify(once) === JSON.stringify(twice));
    check('other scriptlets are untouched', JSON.stringify(translateUboScriptletArgs('ubo-set', [ 'a', 'b', 'c', 'd' ]).args) === JSON.stringify([ 'a', 'b', 'c', 'd' ]));
    // 3. Refusals.
    check('an unknown named argument is refused', typeof translateUboScriptletArgs('rmnt', [ 'script', 'x', 'frobnicate', '1' ]).error === 'string');
    check('a named argument without value is refused', typeof translateUboScriptletArgs('rmnt', [ 'script', 'x', 'excludes' ]).error === 'string');
    check('patterns with different flags are refused', typeof translateUboScriptletArgs('rmnt', [ 'script', '/x/i', 'excludes', '/y/' ]).error === 'string');
    check('a case-insensitive regex with a literal string is refused', typeof translateUboScriptletArgs('rmnt', [ 'script', '/x/i', 'excludes', 'y' ]).error === 'string');
    // 4. Wiring — build rules, build exceptions, custom rules.
    const built = parseScriptletRules(`${TEST_CONFIG.ALLOW_HOST}#%#//scriptlet('ubo-rmnt', 'script', 'adblockerDisabled', 'excludes', 'pageProps')`, () => true);
    check('build: the rule is translated', built.length === 1 && built[0].name === UBO_SCRIPTLET_ARGS.ADGUARD_REMOVE_NODE_TEXT && built[0].args.length === 2, JSON.stringify(built));
    const refused = parseScriptletRules(`${TEST_CONFIG.ALLOW_HOST}#%#//scriptlet('ubo-rmnt', 'script', 'x', 'frobnicate', '1')`, () => true);
    check('build: an untranslatable rule is dropped and reported', refused.length === 0 && droppedUnsupportedScriptletScopes.some(d => d.kind === 'untranslatable-ubo-args'));
    const exc = parseScriptletExceptionRules(`${TEST_CONFIG.ALLOW_HOST}#@#//scriptlet('ubo-rmnt', 'script', 'adblockerDisabled', 'excludes', 'pageProps')`);
    check('build: an exception gets the same translation, so it still names its rule',
        exc.length === 1 && exc[0].name === built[0]?.name && JSON.stringify(exc[0].args) === JSON.stringify(built[0]?.args), JSON.stringify(exc));
    const typed = parseScriptletLine(`${TEST_CONFIG.ALLOW_HOST}##+js(remove-node-text, script, adblockerDisabled, excludes, pageProps)`);
    check('custom rule (uBO syntax): translated like a list rule', typed?.rules?.[0]?.name === built[0]?.name
        && JSON.stringify(typed.rules[0].args) === JSON.stringify(built[0]?.args), JSON.stringify(typed));
    const typedAdg = parseScriptletLine(`${TEST_CONFIG.ALLOW_HOST}#%#//scriptlet('remove-node-text', 'script', 'x', 'div.parent')`);
    check('custom rule (AdGuard syntax): AdGuard meaning kept', JSON.stringify(typedAdg?.rules?.[0]?.args) === JSON.stringify([ 'script', 'x', 'div.parent' ]));
    check('custom rule: an untranslatable uBO rule is refused with a reason', typeof parseScriptletLine(`${TEST_CONFIG.ALLOW_HOST}##+js(rmnt, script, x, frobnicate, 1)`)?.error === 'string');
} finally {
    resetBuildAccumulators();
}

for ( const f of failures ) { console.error(`FAIL: ${f}`); }
if ( failures.length !== 0 ) { process.exit(1); }
console.log('PASS: uBO\'s extra scriptlet arguments are translated to the same decision, in the build and for typed rules.');
