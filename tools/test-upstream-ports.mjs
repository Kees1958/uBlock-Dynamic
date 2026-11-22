#!/usr/bin/env node
// ── tools/test-upstream-ports.mjs ─────────────────────────────────────────────
// Suite step 80 (10.7.8): the improvements taken over from uBO Lite and AdGuard after the November 2026 upstream
// review (project doc claude/UPSTREAM_REVIEW_2026-11.md). Each section drives the real exported code, with only
// browser storage / messaging mocked (Part D rule 15), and fails on the 10.7.7 code (C42, fault-verified).
//
//   A. Picker overlay secret (uBO ead588a)        — js/core/tool-overlay-secret.js, filter-routes.js, both overlay sides
//   B. Permission changes serialized (uBO 30c897c) — background.js uses one createLock, awaits registration
//   C. Filter-parser fixes (uBO bfbd7f6, a63712e)  — static-filtering-parser.js, ext-selector-compiler.js
//   D. Immediate site-specific hiding (uBO 2720077) — css-api.js insert(css, true) + both callers
//   E. "$domain=name.*" from the CrUX snapshot (option C) — topSiteDomainsByName(), parseBlockRule()
//   F. Value-less "$removeparam" (AdGuard 5.5.2)  — ubo-parser.js, parseRemoveparamRules()
//   G. Page-injection failures as expected errors (uBO b4979e4) — expected-errors.js, both call sites
//   H. High-contrast (forced-colors) rules (AdGuard 5.5) — css/common.css, dashboard/filtering-mode.css
//
// Exit 0 = all pass; 1 = a failure.

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';   // mock extension id

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
    if ( !ok ) { failures += 1; }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function moduleUrl(rel, tag = '') { return pathToFileURL(path.join(ROOT, rel)).href + (tag ? `?${tag}` : ''); }

globalThis.self = globalThis;   // the extension's modules read `self` (service-worker global)
// Mock browser before any extension module is imported: storage.session (a plain Map) and runtime.id.
const sessionStore = new Map();
globalThis.chrome = {
    runtime: { id: EXT_ID, getURL: p => `chrome-extension://${EXT_ID}${p}`, sendMessage: async () => undefined },
    storage: {
        session: {
            async get(key) { return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}; },
            async set(bin) { for ( const [ k, v ] of Object.entries(bin) ) { sessionStore.set(k, v); } },
            async setAccessLevel() {},
        },
        local: { async get() { return {}; }, async set() {}, async remove() {} },
    },
    i18n: { getMessage: () => '' },
};

async function sectionA() {
    console.log('── A. Picker overlay secret ──');
    const first = await import(moduleUrl('js/core/tool-overlay-secret.js', 'a1'));
    const [ s1, s2 ] = await Promise.all([ first.getToolOverlaySecret(), first.getToolOverlaySecret() ]);
    check('secret is a non-empty string', typeof s1 === 'string' && s1.length >= 32, String(s1));
    check('two concurrent first calls get the same secret', s1 === s2);
    check('secret is stored in storage.session', sessionStore.get('toolOverlaySecret') === s1);
    const restarted = await import(moduleUrl('js/core/tool-overlay-secret.js', 'a2'));   // fresh module memory = SW restart
    check('after a service-worker restart the same secret is restored', await restarted.getToolOverlaySecret() === s1);
    const { handleGetToolOverlaySecret } = await import(moduleUrl('js/workflow/filter-routes.js'));
    check('handler answers this extension', await handleGetToolOverlaySecret({}, { id: EXT_ID }) === s1);
    check('handler refuses another sender', await handleGetToolOverlaySecret({}, { id: 'other' }) === undefined);
    const ui = read('js/ui/tool-overlay-ui.js');
    check('tool frame compares msg.secret before starting', /msg\.secret !== toolOverlaySecret/.test(ui));
    const page = read('js/scripting/tool-overlay.js');
    check('page side sends the secret in startOverlay', /what: 'startOverlay',\s*secret: toolOverlaySecret/.test(page));
    check('page side releases what start() acquired when no secret', /typeof toolOverlaySecret !== 'string' \) \{ this\.stop\(\); return false; \}/.test(page));
    const routes = read('js/workflow/message-routes.js');
    check('route entry exists for the secret message', routes.includes('[MSG_GET_TOOL_OVERLAY_SECRET]: Object.freeze({'));
}

function sectionB() {
    console.log('── B. Permission changes serialized ──');
    const bg = read('js/workflow/background.js');
    check('no snapshot-of-array "pending" sequencing left', bg.includes('onPermissionsChanged.pending') === false);
    check('one createLock for permission changes', /const permissionChangeLock = createLock\(/.test(bg));
    check('changes run under the lock with a logged failure', /permissionChangeLock\.withLock\([\s\S]{0,200}\)\.catch\(catchExpected\(/.test(bg));
    const at = bg.indexOf('async function onPermissionsRemoved()');
    const removed = at === -1 ? '' : bg.slice(at, bg.indexOf('\n}\n', at));
    check('removal awaits content-script registration', /await registerContentScripts\(\)/.test(removed));
}

async function sectionC() {
    console.log('── C. Filter-parser fixes ──');
    const { AstFilterParser } = await import(moduleUrl('js/core/static-filtering-parser.js'));
    const p = new AstFilterParser({ trustedSource: false });
    const cases = [
        [ '/ab,example.com##.ad', true, 'a "/" site whose closing slash lies past the site list is an error' ],
        [ 'example.com,/foo##.ad', true, 'same, as the second site' ],
        [ '/foo/,example.com##.ad', false, 'a real regex site still parses' ],
        [ 'example.com##[a]span', true, 'tag name run together after an attribute is an error' ],
        [ 'example.com##.ad*', true, '"*" run together is an error (unchanged)' ],
        [ 'example.com##.ad span', false, 'tag name after whitespace is fine' ],
        [ 'example.com##div.ad', false, 'leading tag name is fine' ],
    ];
    for ( const [ line, wantError, label ] of cases ) {
        p.parse(line);
        check(`${label}: ${line}`, p.hasError() === wantError, `hasError() = ${p.hasError()}`);
    }
}

function sectionD() {
    console.log('── D. Immediate site-specific hiding ──');
    const adopted = [];
    const sent = [];
    class FakeSheet { replaceSync(css) { this.css = css; } }
    const sandbox = {
        self: {}, document: { adoptedStyleSheets: adopted }, CSSStyleSheet: FakeSheet,
        chrome: { runtime: { id: 'test-extension-id', sendMessage: msg => { sent.push(msg); return Promise.resolve(); } } },
    };
    Object.defineProperty(sandbox.document, 'adoptedStyleSheets', {
        get() { return adopted.slice(); },
        set(v) { adopted.length = 0; adopted.push(...v); },
    });
    vm.runInNewContext(read('js/scripting/css-api.js'), sandbox);
    sandbox.self.cssAPI.insert('.a{display:none!important;}', true);
    check('insert(css, true) adds a constructed stylesheet at once', adopted.length === 1 && adopted[0].css === '.a{display:none!important;}');
    check('insert(css, true) still sends insertCSS to the background', sent.length === 1 && sent[0].what === 'insertCSS');
    sandbox.self.cssAPI.insert('.b{display:none!important;}');
    check('insert(css) without the flag adds no stylesheet', adopted.length === 1 && sent.length === 2);
    for ( const rel of [ 'js/scripting/css-specific.js', 'js/offscreen/css-compiled.template.js' ] ) {
        check(`${rel} passes immediate = true`, /cssAPI\.insert\(`\$\{s\.join\(',\\n'\)\}\{display:none!important;\}`, true\)/.test(read(rel)));
    }
}

async function sectionE() {
    console.log('── E. "$domain=name.*" from the CrUX snapshot ──');
    const { topSiteDomainsByName } = await import(moduleUrl('tools/build/crux-top-sites.mjs'));
    const { setTopSitesSet } = await import(moduleUrl('tools/build/build-state.mjs'));
    const { parseBlockRule } = await import(moduleUrl('tools/build/rule-parsers.mjs'));
    const top = new Set([ 'modivo.pl', 'shop.modivo.de', 'modivo.ru', 'idealo.co.uk', 'idealo.de', 'example.com' ]);
    const byName = topSiteDomainsByName(top);
    check('index: "modivo" has .pl, .de (from a subdomain) and .ru', [ 'modivo.de', 'modivo.pl', 'modivo.ru' ].every(d => byName.get('modivo')?.has(d)));
    check('index: "idealo" has the second-level co.uk form', byName.get('idealo')?.has('idealo.co.uk') === true);
    setTopSitesSet(top);
    const rule = parseBlockRule('||ads.example.net^$domain=modivo.*|idealo.*', 1, 10000, { listName: 'test' });
    const sites = rule?.condition?.initiatorDomains ?? [];
    check('a wildcard site expands to every in-scope top-site domain', [ 'modivo.pl', 'modivo.de', 'idealo.co.uk', 'idealo.de' ].every(d => sites.includes(d)), JSON.stringify(sites));
    check('an out-of-scope TLD (.ru) is left out', sites.includes('modivo.ru') === false, JSON.stringify(sites));
    check('no 33-TLD guess appears (no modivo.com)', sites.includes('modivo.com') === false);
    const none = parseBlockRule('||ads.example.net^$domain=nosuchsite.*', 2, 10000, { listName: 'test' });
    check('a wildcard with no top-site match leaves no site (rule not shipped)', none === null || (none.condition?.initiatorDomains ?? []).length === 0, JSON.stringify(none));
    setTopSitesSet(null);
}

async function sectionF() {
    console.log('── F. Value-less "$removeparam" ──');
    const { parseRemoveparamRules } = await import(moduleUrl('tools/build/rule-parsers.mjs'));
    const rules = parseRemoveparamRules('||example.org^$removeparam\n$removeparam\n*$removeparam,domain=x.com\n||a.com^$removeparam=utm_source', 1);
    const whole = rules.filter(r => r.action?.redirect?.transform?.query === '');
    check('one whole-query rule, for the line that names an address', whole.length === 1, JSON.stringify(rules));
    check('it targets example.org', JSON.stringify(whole[0]?.condition?.requestDomains) === '["example.org"]');
    check('address-less forms are refused (would strip every page\'s query)', rules.length === 2, String(rules.length));
    check('named parameters still work', rules.some(r => JSON.stringify(r.action?.redirect?.transform?.queryTransform?.removeParams) === '["utm_source"]'));
    check('no rule carries an empty removeParams list', rules.every(r => r.action?.redirect?.transform?.queryTransform?.removeParams?.length !== 0));
}

async function sectionG() {
    console.log('── G. Page-injection failures as expected errors ──');
    const { EXPECTED_ERRORS, PAGE_INJECTION_EXPECTED_ERRORS, isExpectedError } = await import(moduleUrl('js/data/expected-errors.js'));
    const real = [
        [ 'No frame with id 7 in tab 12.', 'frame gone' ],
        [ 'No tab with id: 12.', 'tab gone' ],
        [ 'Frame with ID 3 was removed.', 'frame removed' ],
        [ 'Frame with ID 0 is showing error page', 'error page' ],
    ];
    for ( const [ message, label ] of real ) {
        check(`expected: ${label}`, isExpectedError(new Error(message), PAGE_INJECTION_EXPECTED_ERRORS));
    }
    check('an unrelated failure is not expected', isExpectedError(new Error('Invalid CSS'), PAGE_INJECTION_EXPECTED_ERRORS) === false);
    check('FRAME_GONE is a declared class', typeof EXPECTED_ERRORS.FRAME_GONE?.pattern?.test === 'function');
    for ( const rel of [ 'js/workflow/filter-routes.js', 'js/core/filter-manager.js' ] ) {
        const src = read(rel);
        check(`${rel}: no console.error for injection failures`, /console\.error\(`\[uBlock-Dynamic\][^`]*(?:insertCSS|removeCSS|executeScript)/.test(src) === false);
        check(`${rel}: uses PAGE_INJECTION_EXPECTED_ERRORS`, src.includes('catchExpected(') && src.includes('PAGE_INJECTION_EXPECTED_ERRORS'));
    }
}

function sectionH() {
    console.log('── H. High-contrast rules ──');
    const common = read('css/common.css');
    const block = common.slice(common.indexOf('@media (forced-colors: active)'));
    check('common.css has a forced-colors section', common.includes('@media (forced-colors: active)'));
    check('checkbox and radio redrawn in system colours', /\.checkbox[^{]*:checked \+ svg \{[^}]*Highlight/.test(block) && /\.radio[^{]*:checked \+ svg > circle \{[^}]*Highlight/.test(block));
    check('focus ring in system colours', /focus-visible[^{]*\{[^}]*outline: 2px solid Highlight/.test(block));
    const toggle = read('dashboard/filtering-mode.css');
    check('allow-list toggle redrawn in forced colours', /@media \(forced-colors: active\)[\s\S]*:checked ~ \.toggleTrack \{[^}]*Highlight/.test(toggle));
}

await sectionA();
sectionB();
await sectionC();
sectionD();
await sectionE();
await sectionF();
await sectionG();
sectionH();
console.log(failures === 0 ? '\nAll upstream-port checks passed.' : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
