#!/usr/bin/env node
// tools/test-import-rejections.mjs — (10.7.6) the owner's rule for the Import ABP box: EVERY line it cannot use is
// commented out with "! Rejected: <reason>" beneath it (red), and what Chrome refuses is reported — never silent.
// Until 10.7.6 only scriptlet and $popup lines got this; network and cosmetic lines vanished without a word.
//   1. network lines the parser cannot translate        (explainNetworkRejection, compile-filters.js)
//   2. cosmetic lines the editor cannot apply           (classifySandboxCosmeticLine via annotateUnusableCosmeticLines)
//   3. rules validateRules() drops after translation    (explainValidationDrop)
//   4. what Chrome refuses at apply time                (rejectedRegexes annotated; caps / refused batch -> notice)
// Every part runs the REAL module functions (C42); a working rule (the NOS redirect) must never be touched.
// Usage: node tools/test-import-rejections.mjs        Outcomes (C38): PASS / FAIL / DID NOT RUN.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOS_REDIRECT = '||cdn-ster-nl.akamaized.net/*.mp4$redirect=noopmp4-1s,domain=nos.nl';
const REJECTED_PREFIX = '! Rejected: ';

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
    if ( !ok ) { failures += 1; }
}
function imp(rel) { return import(pathToFileURL(path.join(ROOT, rel)).href); }

// Minimal extension APIs: the offscreen compiler's top-level run asks for the user list (none here) and posts a result.
const localStore = {};
function makeArea(store) {
    return {
        get: async key => (typeof key === 'string' ? { [key]: store[key] } : { ...store }),
        set: async obj => { Object.assign(store, obj); },
        remove: async keys => { for ( const k of [].concat(keys) ) { delete store[k]; } },
        getKeys: async () => Object.keys(store),
    };
}
function installChrome() {
    globalThis.self = globalThis;
    globalThis.chrome = globalThis.browser = {
        runtime: { id: 'test', getURL: p => p, sendMessage: async () => undefined, onMessage: { addListener() {} }, getManifest: () => ({ version: '0' }) },
        storage: { local: makeArea(localStore), session: makeArea({}) },
        declarativeNetRequest: { ResourceType: {}, getDynamicRules: async () => [], getSessionRules: async () => [] },
        scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {} },
    };
}

async function main() {
    installChrome();

    console.log('── 1. Network lines: reason per kind ──');
    const { explainNetworkRejection, explainValidationDrop } = await imp('js/core/ubo-parser.js');
    const NETWORK_CASES = [
        [ '||cdn-ster-nl.akamaized.net/*.mp4$redirect-rule=noopmp4-1s,domain=nos.nl', /redirect-rule/ ],
        [ '||x.com^$script,redirect=googletagmanager_gtm.js', /not included in uBD/ ],
        [ '||1.2.3.4^$network', /\$network/ ],
        [ '||x.com^$removeheader=refresh', /headers/ ],
        [ '@@||x.com^$csp', /exception/ ],
        [ '||x.com^$app=chrome.exe', /\$app/ ],
        [ '||x.com^$foobar', /\$foobar/ ],
    ];
    for ( const [ line, want ] of NETWORK_CASES ) {
        const reason = explainNetworkRejection(line);
        check(`reason for ${line}`, want.test(reason), reason);
    }

    console.log('\n── 1+3. The import compiler reports every unusable network line, keeps working ones ──');
    const { compileFilters } = await imp('js/offscreen/compile-filters.js');
    const input = [ NOS_REDIRECT, '||ads.example^', ...NETWORK_CASES.map(c => c[0]), '||x.com^$domain=google.*', 'example.com##.ad' ].join('\n');
    const compiled = compileFilters('sandbox', input, { localSource: true, nativeCssHas: true, trustedSource: true });
    const rejected = new Map((compiled?.rejectedLines ?? []).map(r => [ r.line, r.reason ]));
    check('the NOS redirect is NOT rejected', rejected.has(NOS_REDIRECT) === false);
    check('the NOS redirect becomes a redirect rule', compiled.dnrRules.some(r => r.action?.type === 'redirect' && r.condition?.initiatorDomains?.includes('nos.nl')));
    check('a plain block is not rejected', rejected.has('||ads.example^') === false);
    for ( const [ line ] of NETWORK_CASES ) { check(`rejected with a reason: ${line}`, typeof rejected.get(line) === 'string'); }
    check('3. a rule dropped by validateRules() is reported on its own line (domain=google.*)', /wildcard/.test(rejected.get('||x.com^$domain=google.*') ?? ''), rejected.get('||x.com^$domain=google.*'));
    check('3. explainValidationDrop() keeps a valid rule (null)', explainValidationDrop({ action: { type: 'block' }, condition: { urlFilter: '||a.com^' } }) === null);
    check('cosmetic lines are not reported by the network compiler', rejected.has('example.com##.ad') === false);

    console.log('\n── 2. Cosmetic lines that cannot apply ──');
    const fm = await imp('js/core/filter-manager.js');
    const COSMETIC_CASES = [
        [ '##.ad', /needs a site/ ],
        [ 'a.com,b.com##.ad', /several sites/ ],
        [ '~a.com##.ad', /excluding a site/ ],
        [ '*##.ad', /needs a site/ ],
        [ 'a.com#$#body { color: red }', /CSS injection/ ],
        [ 'a.com#?#div:has(> .ad)', /extended CSS/ ],
        [ 'a.com$$script[data-ad]', /HTML filtering/ ],
    ];
    const KEPT = [ 'example.com##.ad', 'example.com#@#.ad', NOS_REDIRECT, 'example.com##+js(aopr, x)', 'example.com#%#//scriptlet("abort-on-property-read", "x")', '! a comment', '||x.com/#anchor^' ];
    const { text: annotated, rejected: cosRejected } = fm.annotateUnusableCosmeticLines([ ...COSMETIC_CASES.map(c => c[0]), ...KEPT ].join('\n'));
    const outLines = annotated.split('\n');
    for ( const [ line, want ] of COSMETIC_CASES ) {
        const at = outLines.indexOf(`!${line}`);
        check(`commented out with the reason beneath: ${line}`, at !== -1 && outLines[at + 1]?.startsWith(REJECTED_PREFIX) && want.test(outLines[at + 1]), outLines[at + 1]);
    }
    for ( const line of KEPT ) { check(`left untouched: ${line}`, outLines.includes(line)); }
    check('idempotent: annotating again changes nothing', fm.annotateUnusableCosmeticLines(annotated).text === annotated);
    check('count of cosmetic rejections', cosRejected.length === COSMETIC_CASES.length, String(cosRejected.length));

    console.log('\n── 1+4. annotateRejectedSandboxLines() rewrites the stored box text ──');
    const regexLine = '/ad[0-9]+(?=x)/$script';
    localStore.sandboxFilters = [ NOS_REDIRECT, '||1.2.3.4^$network', regexLine, '||ok.example^' ].join('\n');
    const count = await fm.annotateRejectedSandboxLines({
        rejectedLines: [ { line: '||1.2.3.4^$network', reason: 'R-network' } ],
        rejectedRegexes: [ { regex: 'ad[0-9]+(?=x)', reason: 'syntaxError' } ],
    });
    const stored = localStore.sandboxFilters.split('\n');
    check('two lines annotated', count === 2, String(count));
    check('network line commented out + reason beneath', stored.indexOf('!||1.2.3.4^$network') !== -1 && stored[stored.indexOf('!||1.2.3.4^$network') + 1] === `${REJECTED_PREFIX}R-network`);
    check('4. a regex Chrome refuses is commented out + reason beneath', stored.indexOf(`!${regexLine}`) !== -1 && /syntaxError/.test(stored[stored.indexOf(`!${regexLine}`) + 1] ?? ''));
    check('the NOS redirect and a plain block are untouched', stored.includes(NOS_REDIRECT) && stored.includes('||ok.example^'));
    const again = await fm.annotateRejectedSandboxLines({ rejectedLines: [ { line: '||1.2.3.4^$network', reason: 'R-network' } ] });
    check('idempotent: an already commented line is not annotated twice', again === 0);

    console.log('\n── 4. The notice the person sees ──');
    const { formatSandboxApplyNotice } = await imp('js/data/editor-annotations.js');
    const failed = formatSandboxApplyNotice({ ok: true, applyErrors: [ 'Error: Rule with id 1 is invalid' ], noRulesActive: true }, '');
    check('a refused batch says no imported rule is active (error)', failed?.isError === true && /None of your imported network rules are active/.test(failed.text), failed?.text);
    const capped = formatSandboxApplyNotice({ ok: true, applyErrors: [ '12 rules dropped — exceeded USER_RULES_MAX (5000)' ] }, '');
    check('a cap overflow is shown (error)', capped?.isError === true && /USER_RULES_MAX/.test(capped.text), capped?.text);
    const counted = formatSandboxApplyNotice({ ok: true, applyErrors: [] }, `!x\n${REJECTED_PREFIX}a\n!y\n${REJECTED_PREFIX}b`);
    check('refused lines are counted (information)', counted?.isError === false && /^2 lines cannot be used/.test(counted.text), counted?.text);
    check('nothing to say -> null', formatSandboxApplyNotice({ ok: true, applyErrors: [] }, 'a\nb') === null);

    console.log('\n── Wiring ──');
    // (10.7.12) The settings handlers moved from background.js to js/workflow/settings-routes.js — this check reads them there.
    const bg = fs.readFileSync(path.join(ROOT, 'js/workflow/settings-routes.js'), 'utf8');
    check('save AND restore annotate the box', (bg.match(/await annotateRejectedSandboxLines\(\{/g) ?? []).length === 2);
    check('save AND restore return the same report', (bg.match(/sandboxApplyReport\(/g) ?? []).length === 3);
    const fmSrc = fs.readFileSync(path.join(ROOT, 'js/core/filter-manager.js'), 'utf8');
    const setBody = fmSrc.slice(fmSrc.indexOf('export async function setSandboxFilters'), fmSrc.indexOf('\n}\n', fmSrc.indexOf('export async function setSandboxFilters')));
    check('every save annotates cosmetic lines (setSandboxFilters)', /annotateUnusableCosmeticLines\(/.test(setBody));
    check('what applies and what is refused come from ONE classifier', (fmSrc.match(/classifySandboxCosmeticLine\((?:raw)?[lL]ine\.trim\(\)\)/g) ?? []).length === 2   /* buildFilterIndex + annotate */);
    const rm = fs.readFileSync(path.join(ROOT, 'js/core/ruleset-manager.js'), 'utf8');
    check('a refused DNR batch is flagged (batchFailed)', /out\.batchFailed = true/.test(rm));
    const ui = fs.readFileSync(path.join(ROOT, 'dashboard/filter-manager-ui.js'), 'utf8');
    check('the editor shows the stored (annotated) text right after a save', /getSandboxFilters' \}\);\s*\n\s*if \( typeof stored === 'string'/.test(ui));
    const io = fs.readFileSync(path.join(ROOT, 'dashboard/settings-io.js'), 'utf8');
    check('settings restore uses the same notice', /formatSandboxApplyNotice\(result\.sandboxCompile/.test(io));

    console.log(failures === 0 ? '\nPASS' : `\n${failures} assertion(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('DID NOT RUN: test-import-rejections —', err);
    process.exit(1);
});
