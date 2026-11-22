// tools/check-autoconsent-cmp-consistency.mjs — rules.json ↔
// eval-snippets.js ↔ the generated autodeny bundle stay in sync, plus
// the hash trip-wire that catches an un-rebuilt bundle after
// eval-snippets.js changes. Ported from tools/self-test.mjs's checks
// [3/6] and [4/6] (see CHANGELOG — self-test.mjs retired; see
// check-json-syntax.mjs's own header for why).
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

let failures = 0;

console.log('=== CMP data consistency — rules.json ↔ eval-snippets.js ↔ generated bundle ===');

const rulesDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/autoconsent/rules/rules.json'), 'utf8'));
const actionableRules = rulesDoc.rules.filter(r => r.action !== null);

const evalSrc = fs.readFileSync(path.join(ROOT, 'vendor/autoconsent/eval-snippets.js'), 'utf8');
const missingFns = [];
for ( const rule of actionableRules ) {
    if ( evalSrc.includes(`${rule.action}:`) === false ) { missingFns.push(rule.action); }
}
if ( missingFns.length === 0 ) {
    console.log(`PASS: every one of ${actionableRules.length} actionable rules has a matching function in eval-snippets.js`);
} else {
    failures++;
    console.log(`FAIL: missing eval-snippets.js functions: ${JSON.stringify(missingFns)}`);
}

const bundleSrc = fs.readFileSync(path.join(ROOT, 'js/scripting/autodeny-snippets.generated.js'), 'utf8');
// [A-Z0-9_]+ (not [A-Z_]+) — digit-inclusion fix carried over from
// build-autodeny-bundle.mjs's own header regex (EVAL_TYPO3COOKIEMAN_REJECT/
// EVAL_STCMPV2_REJECT both contain a digit).
// (11.0.0) Compared with the number of DISTINCT action keys, not of rules: the bundle builder emits each function
// once (writeBundle()'s usedKeys), and since 11.0.0 several CMPs share EVAL_HIDE_ONLY (XenForo, Sirdata, Transcend).
const bundleFnCount = [ ...bundleSrc.matchAll(/EVAL_[A-Z0-9_]+:\s*function/g) ].length;
const distinctActionCount = new Set(actionableRules.map(r => r.action)).size;
const bundleRuleCount = [ ...bundleSrc.matchAll(/"action": "EVAL_[A-Z0-9_]+"/g) ].length;
if ( bundleFnCount === distinctActionCount && bundleRuleCount === actionableRules.length ) {
    console.log(`PASS: generated bundle contains exactly ${bundleFnCount} action functions for ${bundleRuleCount} rules, matching rules.json (${distinctActionCount} distinct actions, ${actionableRules.length} actionable rules)`);
} else {
    failures++;
    console.log(`FAIL: generated bundle mismatch — bundle has ${bundleFnCount} functions / ${bundleRuleCount} rules, rules.json expects ${distinctActionCount} / ${actionableRules.length}. Bundle may be stale: run node tools/build-autodeny-bundle.mjs`);
}

// (10.7.1) The ACCEPT side: every actionable rule carries accept data; every `api` it names exists in
// EVAL_ACCEPT_ALL's ACCEPT_APIS; the accept bundle lists every actionable rule with exactly one action function; and
// both bundle paths equal the ones js/data/cookie-banner-action.js hands to the registration.
{
    const acceptBody = evalSrc.slice(evalSrc.indexOf('EVAL_ACCEPT_ALL:'));
    const apiKeys = new Set([ ...(acceptBody.match(/const ACCEPT_APIS = \{([\s\S]*?)\n\s*\};/)?.[1] ?? '').matchAll(/^\s*([A-Z]+):/gm) ].map(m => m[1]));
    const noAccept = actionableRules.filter(r => !r.accept || !Array.isArray(r.accept.selectors)).map(r => r.name);
    const badApi = actionableRules.filter(r => r.accept?.api && !apiKeys.has(r.accept.api)).map(r => `${r.name}:${r.accept.api}`);
    const badScope = actionableRules.filter(r => r.accept?.scope !== undefined && r.accept.scope !== 'document').map(r => r.name);
    if ( evalSrc.includes('EVAL_ACCEPT_ALL:') && apiKeys.size > 0 && noAccept.length === 0 && badApi.length === 0 && badScope.length === 0 ) {
        console.log(`PASS: all ${actionableRules.length} actionable rules carry accept data; ${apiKeys.size} accept APIs, every named one exists`);
    } else {
        failures++;
        console.log(`FAIL: accept data — missing: ${JSON.stringify(noAccept)}, unknown api: ${JSON.stringify(badApi)}, bad scope: ${JSON.stringify(badScope)}, APIs found: ${apiKeys.size}`);
    }
    const acceptSrc = fs.readFileSync(path.join(ROOT, 'js/scripting/autoaccept-snippets.generated.js'), 'utf8');
    const acceptFnCount = [ ...acceptSrc.matchAll(/EVAL_[A-Z0-9_]+:\s*function/g) ].length;
    const acceptRuleCount = [ ...acceptSrc.matchAll(/"action": "EVAL_ACCEPT_ALL"/g) ].length;
    if ( acceptFnCount === 1 && acceptRuleCount === actionableRules.length ) {
        console.log(`PASS: accept bundle has 1 action function serving all ${acceptRuleCount} rules`);
    } else {
        failures++;
        console.log(`FAIL: accept bundle — ${acceptFnCount} function(s), ${acceptRuleCount} rule(s); expected 1 and ${actionableRules.length}. Run node tools/build-autodeny-bundle.mjs`);
    }
    const { COOKIE_BANNER_BUNDLES } = await import(path.join(ROOT, 'js/data/cookie-banner-action.js'));
    const missingBundle = Object.values(COOKIE_BANNER_BUNDLES).filter(p => !fs.existsSync(path.join(ROOT, p.replace(/^\//, ''))));
    if ( missingBundle.length === 0 ) {
        console.log('PASS: both bundles named in js/data/cookie-banner-action.js exist');
    } else {
        failures++;
        console.log(`FAIL: bundle(s) named in cookie-banner-action.js missing: ${JSON.stringify(missingBundle)}`);
    }
}

console.log('\n=== Hash trip-wire — vendor/autoconsent/eval-snippets.js matches the recorded hash in build-autodeny-bundle.mjs ===');
try {
    execFileSync(process.execPath, [ 'tools/build-autodeny-bundle.mjs' ], { cwd: ROOT, stdio: 'pipe' });
    console.log('PASS: build-autodeny-bundle.mjs ran clean — hash trip-wire did not fire.');
} catch (e) {
    failures++;
    console.log('FAIL: build-autodeny-bundle.mjs hash trip-wire fired (or another build error).');
    console.log((e.stderr?.toString() ?? '').split('\n').slice(0, 5).join('\n'));
}

console.log('');
if ( failures > 0 ) {
    console.log(`${failures} CMP data-consistency check(s) failed.`);
    process.exitCode = 1;
} else {
    console.log('PASS: all CMP data-consistency checks clean.');
}
