#!/usr/bin/env node
// check-mv3-compliance.mjs — Manifest V3 "no remotely hosted code" and the scriptlet policy hold (suite step 59, 10.4.6).
//
// Why: Chrome Web Store rejection "Blue Argon" (2026-10-23) — an AdGuard French rule
// trusted-create-element('head','script','', <code loading https://cdn.viously.com/js/sdk/boot.js>) shipped, because
// no check compared the shipped DATA against the Manifest V3 rules and the trust exclusion was documentation only.
// The policy itself lives in js/data/scriptlet-policy.js; this check runs the REAL policy functions, never a copy.
//
// Checks:
//   1. Policy behaviour: fixed examples (the rejected rule included) through the real functions; the serialized
//      run-time guard works stand-alone and agrees with the module; reason strings agree with SCRIPTLET_POLICY.
//   2. Trust gate: applyScriptletTrustGate() (the build's single download helper) drops trusted scriptlets from a
//      non-AdGuard source and keeps them from an AdGuard Team source; fetchList() actually calls it.
//   3. Shipped scriptlet data: every row of every rulesets/*-scriptlets.js passes scriptletViolationAnySource() (rules D, B, C); lists
//      without any AdGuard Team content carry no scriptlet that needs trust; the shared library carries the current
//      run-time guard.
//   4. Remote code in the package: no script/module/importScripts/manifest entry loads code from a URL, and the
//      manifest CSP allows no remote source or eval.
//   5. Wiring: the build gate, the input gate and the run-time gate all call the policy; the old documentation-only
//      constant is gone.
//   6. Self-test: synthetic violations (the real rejected rule, a remote import) are injected into in-memory copies
//      and MUST be detected — proves the check can fail, every run.
// Pure read of the tree (plus in-memory fixtures) — nothing to initialise, clear or release.
import fs from 'fs';
import path from 'path';
import { SCRIPTLET_POLICY, isBlockedScriptletFamily, isTrustedScriptletSource, requiresTrust, safeReplacementFor, scriptletPolicyViolation, scriptletRuleRejection, scriptletViolationAnySource } from '../js/data/scriptlet-policy.js';
import { applyScriptletTrustGate } from './build/fetch-helpers.mjs';
import { convertUboScriptletSyntax } from './build/ubo-scriptlet-syntax.mjs';
import { DISPATCH_LAYOUT_CONFIG, decodeDispatchSource, decodeLibrarySource, encodeDispatchTables, renderScriptletFile } from './build/scriptlet-dispatch-layout.mjs';
import { SCRIPTLET_LIBRARY_FILE } from '../js/data/scriptlet-library.js';
import { RULESET_COMPANIONS } from '../js/data/ruleset-companions.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── CONFIG (every example, path and pattern of this check, one place) ─────────
const CHECK_CONFIG = Object.freeze({
    // (11.1.3) Rule A's safe replacement: a uAssets Ad-Shield line (shape of uAssets filters-general.txt), a
    // trusted-replace-argument that inserts a real value (stays dropped), and what the gate must leave.
    SAFE_REPLACEMENT: Object.freeze({
        REPLACEABLE:     "a.com,b.com##+js(trusted-replace-argument, Element.prototype.setAttribute, 1, , condition, '/error-report|&&window,|adShieldError/')",
        NOT_REPLACEABLE: 'c.com##+js(trusted-replace-argument, document.getElementById, 0, json:"freestar-bootstrap", condition, adblock)',
        EXPECTED:        `a.com,b.com#%#//scriptlet('${SCRIPTLET_POLICY.BLANK_SETATTRIBUTE_VALUE_NAME}', '/error-report|&&window,|adShieldError/')`,
        // [ trusted name, args, expected { name, args } or null ] — shapes seen in uAssets (2026-11-25).
        SHAPES: P => [
            [ 'trusted-set-local-storage-item', [ 'pbs_action_time', P.NOW_VALUE_TOKEN ], { name: P.SET_STORAGE_ITEM_NOW_NAME, args: [ P.STORAGE_KINDS.LOCAL, 'pbs_action_time' ] } ],
            [ 'trusted-set-session-storage-item', [ 'lastAdTime', P.NOW_VALUE_TOKEN ], { name: P.SET_STORAGE_ITEM_NOW_NAME, args: [ P.STORAGE_KINDS.SESSION, 'lastAdTime' ] } ],
            [ 'trusted-set-local-storage-item', [ 'dvt_p_ts', `[${P.NOW_VALUE_TOKEN}]` ], null ],
            [ 'trusted-set-attr', [ 'body', 'data-allok', 'y' ], { name: P.SET_DATA_ATTR_NAME, args: [ 'body', 'data-allok', 'y' ] } ],
            [ 'trusted-set-attr', [ 'img', 'onerror', 'y' ], null ],
            [ 'trusted-set-cookie', [ 'stpdsck', '1' ], { name: P.TWINS['trusted-set-cookie'].twin, args: [ 'stpdsck', '1' ] } ],
            [ 'trusted-set-constant', [ 'ConFig.config.ads', 'json:{"pause":{"state":{}}}' ], null ],
            [ 'trusted-set-local-storage-item', [ 'gtv_adfree_status_v1', '{"active":true}' ], null ],
            [ 'trusted-set-cookie-reload', [ 's', '180,,4,,a' ], null ],
            [ 'trusted-click-element', [ 'button' ], null ],
        ],
    }),
    // The rule Chrome Web Store rejected (2026-10-23), verbatim arguments.
    REJECTED_RULE: Object.freeze({ name: 'trusted-create-element', args: [ 'head', 'script', '',
        '(()=>{window.addEventListener("load",(()=>{document.querySelector(".vsly-player")&&(()=>{const e=document.createElement("script");e.id="xieg6Sie",e.src="https://cdn.viously.com/js/sdk/boot.js",document.head.appendChild(e)})()}));})();' ] }),
    // [ name, args, expected reason key (null = allowed) ]
    POLICY_EXAMPLES: Object.freeze([
        [ 'trusted-create-element', [ 'head', 'script', '', '(()=>{})()' ], 'REASON_CODE_ARGUMENT' ],
        [ 'trusted-create-element', [ 'head', 'SCRIPT', 'src="x.js"' ], 'REASON_CODE_ARGUMENT' ],
        [ 'trusted-create-element', [ 'body', 'div', 'class="adsbygoogle" style="height:6px;width:1px;"' ], null ],
        [ 'trusted-create-element', [ 'head', 'link', 'rel="stylesheet" href="https://cdn.example.com/a.css"' ], 'REASON_EXTERNAL_RESOURCE' ],
        [ 'trusted-create-element', [ 'body', 'iframe', 'src="//ads.example.com/f.html"' ], 'REASON_EXTERNAL_RESOURCE' ],
        [ 'trusted-set-attr', [ 'img.ad', 'src', 'https://evil.example/x.png' ], 'REASON_EXTERNAL_RESOURCE' ],
        [ 'trusted-replace-node-text', [ 'script', 'preRollVideos', 'preRollSource.src = ', '//preRollSource.src =' ], null ],
        [ 'trusted-replace-argument', [ 'Node.prototype.appendChild', '0', '"https://cdn.example.com/sdk.js"', 'sdk' ], 'REASON_EXTERNAL_RESOURCE' ],
        [ 'prevent-fetch', [ 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js' ], null ],
        [ 'prevent-element-src-loading', [ 'script', 'https://safelinku.com/admanager.js' ], null ],
        [ 'trusted-replace-outbound-text', [ 'atob', '//pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'data:text/javascript;base64,KCk9Pnt9' ], null ],
        [ 'set-constant', [ 'canRunAds', 'true' ], null ],
    ]),
    // (audit 10.6.4) Rule D — the json-edit family is refused from every source, in every alias spelling; json-prune
    // (removes fields only) stays allowed. [ name, blocked? ]
    BLOCKED_FAMILY_EXAMPLES: Object.freeze([
        [ 'json-edit', true ], [ 'ubo-json-edit', true ], [ 'json-edit.js', true ], [ 'ubo-json-edit.js', true ],
        [ 'json-edit-xhr-response', true ], [ 'json-edit-fetch-response', true ], [ 'jsonl-edit', true ],
        [ 'trusted-json-edit', true ], [ 'trusted-jsonl-edit-fetch-response', true ], [ 'JSON-EDIT', true ],
        [ 'json-prune', false ], [ 'json-prune-fetch-response', false ], [ 'ubo-json-prune.js', false ], [ 'set-constant', false ],
    ]),
    ADGUARD_URL:     'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/BaseFilter/sections/specific.txt',
    NON_ADGUARD_URL: 'https://raw.githubusercontent.com/easylist/antiadblockfilters/master/antiadblockfilters/antiadblock_french.txt',
    LOOKALIKE_URL:   'https://raw.githubusercontent.com/AdguardTeamFake/x/master/list.txt',
    // Shipped lists with AdGuard Team content that ruleset-details.json's url does not show: lists built by a custom
    // fetch (no url recorded: AdGuard Base, the annoyances merge — which also carries the top-25 adult-site rules since 10.5.1) and a hand-off (Portuguese gets
    // AdGuard Spanish's generic sections). Their non-AdGuard sources are still gated per source at download.
    ADGUARD_DERIVED_LISTS: Object.freeze([ 'ruleset_adguard_base', 'ruleset_annoyances', 'ruleset_easylist_portuguese' ]),
    // Package scan: directories that are not part of the extension package.
    SKIP_DIRS: Object.freeze([ 'tools', 'node_modules', '.git', 'dist', 'test-fixtures' ]),
    SCAN_EXTENSIONS: Object.freeze([ '.js', '.mjs', '.html' ]),
    // Remote-code patterns. A URL here is "(scheme:)//host" — a page-relative or extension path never matches.
    REMOTE_CODE_PATTERNS: Object.freeze([
        [ /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i,                     'HTML <script src> from a URL' ],
        [ /\bimportScripts\s*\(\s*["'`](?:https?:)?\/\//,                         'importScripts() from a URL' ],
        [ /\bimport\s*\(\s*["'`](?:https?:)?\/\//,                                'dynamic import() from a URL' ],
        [ /^\s*import\b[^;]*?\bfrom\s*["'](?:https?:)?\/\//m,                     'static import from a URL' ],
        [ /\.src\s*=\s*["'`](?:https?:)?\/\/[^"'`\s]+\.m?js\b/,                   'script .src set to a remote .js' ],
        [ /setAttribute\(\s*["']src["']\s*,\s*["'`](?:https?:)?\/\/[^"'`\s]+\.m?js\b/, 'setAttribute("src", remote .js)' ],
    ]),
    MAX_REPORTED: 15,
});

const failures = [];
function expect(condition, label) { if ( condition === false ) { failures.push(label); } }
function readText(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ── 1. Policy behaviour ───────────────────────────────────────────────────────
function checkPolicy() {
    const R = CHECK_CONFIG.REJECTED_RULE;
    expect(scriptletPolicyViolation(R.name, R.args) !== null, 'policy: the rejected viously rule is allowed');
    expect(scriptletRuleRejection(R.name, R.args) !== null, 'policy: the rejected viously rule is accepted as own rule');
    for ( const [ name, args, key ] of CHECK_CONFIG.POLICY_EXAMPLES ) {
        const got = scriptletPolicyViolation(name, args);
        const want = key === null ? null : SCRIPTLET_POLICY[key];
        expect(got === want, `policy: ${name} ${JSON.stringify(args).slice(0, 80)} -> ${got}, expected ${want}`);
    }
    expect(requiresTrust('trusted-click-element') && requiresTrust('prevent-clipboard-write'), 'policy: trust names not recognised');
    expect(requiresTrust('set-constant') === false, 'policy: an ordinary scriptlet is marked as needing trust');
    expect(scriptletRuleRejection('trusted-set-cookie', [ 'a', 'b' ]) !== null, 'policy: own rule with a trusted scriptlet accepted');
    expect(scriptletRuleRejection('set-constant', [ 'a', 'true' ]) === null, 'policy: own ordinary rule refused');
    expect(isTrustedScriptletSource(CHECK_CONFIG.ADGUARD_URL), 'policy: AdGuard Team source not trusted');
    expect(isTrustedScriptletSource(CHECK_CONFIG.NON_ADGUARD_URL) === false, 'policy: non-AdGuard source trusted');
    expect(isTrustedScriptletSource(CHECK_CONFIG.LOOKALIKE_URL) === false, 'policy: look-alike owner name trusted');
    for ( const [ name, blocked ] of CHECK_CONFIG.BLOCKED_FAMILY_EXAMPLES ) {
        expect(isBlockedScriptletFamily(name) === blocked, `policy (rule D): ${name} blocked=${!blocked}, expected ${blocked}`);
        expect((scriptletViolationAnySource(name, []) === SCRIPTLET_POLICY.REASON_BLOCKED_FAMILY) === blocked,
            `policy (rule D): build gate disagrees for ${name}`);
        expect((scriptletRuleRejection(name, []) !== null) === blocked || blocked === false && requiresTrust(name),
            `policy (rule D): own-rule gate disagrees for ${name}`);
    }
    // The run-time guard is this function's SOURCE TEXT, evaluated stand-alone in the page: it must not depend on
    // anything outside its own body and must agree with the module on every example.
    const standalone = new Function(`return (${scriptletPolicyViolation.toString()});`)();
    for ( const [ name, args ] of [ [ R.name, R.args ], ...CHECK_CONFIG.POLICY_EXAMPLES ] ) {
        expect(standalone(name, args) === scriptletPolicyViolation(name, args), `guard: serialized copy disagrees for ${name}`);
    }
    const src = scriptletPolicyViolation.toString();
    expect(src.includes(`'${SCRIPTLET_POLICY.REASON_CODE_ARGUMENT}'`) && src.includes(`'${SCRIPTLET_POLICY.REASON_EXTERNAL_RESOURCE}'`),
        'guard: reason strings in scriptletPolicyViolation() differ from SCRIPTLET_POLICY');
}

// ── 1b. uBO scriptlet syntax conversion (audit 10.6.4) ───────────────────────
function checkUboConversion() {
    const r = convertUboScriptletSyntax([
        'a.com##+js(rmnt, script, /admiral/i)', 'b.com#@#+js(acs, x)', 'c.com#@#+js()', 'd.com##.ad', 'e.com##+js(ubo-set, a, 1)',
    ].join('\n'));
    const lines = r.text.split('\n');
    expect(lines[0] === "a.com#%#//scriptlet('ubo-rmnt', 'script', '/admiral/i')", `ubo: rule not converted — ${lines[0]}`);
    expect(lines[1] === "b.com#@#//scriptlet('ubo-acs', 'x')", `ubo: exception not converted — ${lines[1]}`);
    expect(lines[2] === 'c.com#@#//scriptlet()', `ubo: wildcard exception not converted — ${lines[2]}`);
    expect(lines[3] === 'd.com##.ad', 'ubo: an ordinary hide rule was changed');
    expect(lines[4] === "e.com#%#//scriptlet('ubo-set', 'a', '1')", `ubo: an existing ubo- name was prefixed twice — ${lines[4]}`);
    expect(r.converted === 4 && r.dropped === 0, `ubo: counts ${r.converted}/${r.dropped}, expected 4/0`);
    expect(requiresTrust('ubo-trusted-set-cookie'), 'policy: a ubo- alias of a trusted scriptlet is not seen as trusted');
    expect(/convertUboScriptletSyntax\(text\)/.test(readText('tools/build/build-steps.mjs')), 'wiring: the build does not convert uBO scriptlet syntax');
}

// ── 2. Trust gate ─────────────────────────────────────────────────────────────
function checkTrustGate() {
    const text = [
        "a.com#%#//scriptlet('trusted-click-element', 'button')",
        "b.com#%#//scriptlet('set-constant', 'x', 'true')",
        'c.com##+js(trusted-set-cookie, a, b)',
        "d.com#@%#//scriptlet('trusted-click-element', 'button')",
    ].join('\n');
    const gated = applyScriptletTrustGate(CHECK_CONFIG.NON_ADGUARD_URL, text);
    expect(gated.includes('trusted-click-element\', \'button\')\nb.com') === false && gated.includes('a.com#%#') === false,
        'gate: trusted scriptlet from a non-AdGuard source kept');
    expect(gated.includes('c.com##+js') === false, 'gate: uBO-syntax trusted scriptlet from a non-AdGuard source kept');
    expect(gated.includes('b.com#%#'), 'gate: ordinary scriptlet dropped');
    expect(gated.includes('d.com#@%#'), 'gate: exception line dropped (it runs nothing)');
    expect(applyScriptletTrustGate(CHECK_CONFIG.ADGUARD_URL, text) === text, 'gate: AdGuard Team source changed');
    // (11.1.3) Safe replacement: the exact uAssets Ad-Shield shape becomes the project scriptlet; any other shape of the
    // same trusted scriptlet (a real value to insert) is still dropped.
    const S = CHECK_CONFIG.SAFE_REPLACEMENT;
    const replaced = applyScriptletTrustGate(CHECK_CONFIG.NON_ADGUARD_URL, [ S.REPLACEABLE, S.NOT_REPLACEABLE ].join('\n'));
    expect(replaced === S.EXPECTED, `gate: safe replacement wrong — got ${JSON.stringify(replaced).slice(0, 300)}`);
    // (11.1.3) The same step for an AdGuard-syntax line (EasyList anti-adblock writes those): host scope kept as written.
    const agLine = "x.com,~y.x.com#%#//scriptlet('trusted-set-cookie', 'consent', '1')";
    const agWant = `x.com,~y.x.com#%#//scriptlet('${SCRIPTLET_POLICY.TWINS['trusted-set-cookie'].twin}', 'consent', '1')`;
    expect(applyScriptletTrustGate(CHECK_CONFIG.NON_ADGUARD_URL, agLine) === agWant, 'gate: AdGuard-syntax trusted line with a safe twin not replaced');
    const safe = safeReplacementFor('ubo-trusted-replace-argument', [ 'Element.prototype.setAttribute', '1', '', 'condition', '/x/' ]);
    expect(safe !== null && safe.name === SCRIPTLET_POLICY.BLANK_SETATTRIBUTE_VALUE_NAME && safe.args.length === 1 && safe.args[0] === '/x/',
        'policy: safe replacement not found for the alias spelling ubo-trusted-replace-argument');
    expect(safeReplacementFor('trusted-replace-argument', [ 'Element.prototype.setAttribute', '1', 'x', 'condition', '/x/' ]) === null,
        'policy: a trusted-replace-argument that INSERTS a value got a safe replacement');
    expect(safeReplacementFor('trusted-replace-argument', [ 'Element.prototype.setAttribute', '1', '', 'condition', '' ]) === null,
        'policy: safe replacement given for an empty pattern');
    expect(scriptletRuleRejection('trusted-replace-argument', [ 'Element.prototype.setAttribute', '1', '', 'condition', '/x/' ])
        .includes(SCRIPTLET_POLICY.BLANK_SETATTRIBUTE_VALUE_NAME), 'policy: own-rule message does not name the safe replacement');
    expect(scriptletPolicyViolation(SCRIPTLET_POLICY.BLANK_SETATTRIBUTE_VALUE_NAME, [ '/x/' ]) === null && requiresTrust(SCRIPTLET_POLICY.BLANK_SETATTRIBUTE_VALUE_NAME) === false,
        'policy: the safe replacement scriptlet itself is refused');
    // (11.1.3) The other replacement shapes, and what must stay refused.
    const P = SCRIPTLET_POLICY;
    for ( const [ name, args, want ] of CHECK_CONFIG.SAFE_REPLACEMENT.SHAPES(P) ) {
        const got = safeReplacementFor(name, args);
        expect(JSON.stringify(got) === JSON.stringify(want), `policy: safeReplacementFor(${name}, ${JSON.stringify(args).slice(0, 80)}) -> ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
    for ( const safeName of [ P.SET_STORAGE_ITEM_NOW_NAME, P.SET_DATA_ATTR_NAME, ...Object.values(P.TWINS).map(t => t.twin) ] ) {
        expect(requiresTrust(safeName) === false, `policy: replacement ${safeName} itself needs trust`);
    }
    expect(scriptletPolicyViolation(P.SET_DATA_ATTR_NAME, [ 'body', 'data-x', 'https://x.example/' ]) === P.REASON_EXTERNAL_RESOURCE,
        'policy (rule C): set-data-attr value is not checked as an inserted value (serialized name out of step with SCRIPTLET_POLICY)');
    expect(/return applyScriptletTrustGate\(url, await fetchListText\(url\)\);/.test(readText('tools/build/fetch-helpers.mjs')),
        'wiring: fetchList() does not pass its downloads through applyScriptletTrustGate()');
}

// (2026-11-09) A language filter with an AdGuard Base country companion also receives AdGuard Base's anti-adblock
// rules for its country sites (tools/build/antiadblock-country-split.mjs) — AdGuard Team content whatever its own
// url shows. Derived from the same companion map the split reads, never hand-listed.
function receivesAdguardBaseCountryContent(id) {
    return (RULESET_COMPANIONS[id] ?? []).some(c => c.startsWith('ruleset_agbase_overflow_'));
}

// ── 3. Shipped scriptlet data ─────────────────────────────────────────────────
function rowsOf(decoded) {
    return decoded.rowTable.map(r => ({ name: decoded.fnNames[r.fnIndex], args: r.args }));
}
function checkScriptletFile(rel, text, adguardContent, report) {
    const decoded = decodeDispatchSource(text);
    for ( const { name, args } of rowsOf(decoded) ) {
        const reason = scriptletViolationAnySource(name, args);   // rules D, B, C
        if ( reason !== null ) { report.push(`${rel}: ${name} — ${reason}`); }
        if ( adguardContent === false && requiresTrust(name) ) { report.push(`${rel}: ${name} — ${SCRIPTLET_POLICY.REASON_UNTRUSTED_SOURCE}`); }
    }
}
function checkShippedData() {
    const details = JSON.parse(readText('rulesets/ruleset-details.json'));
    const urlOf = new Map(details.map(d => [ d.id, String(d.url ?? '') ]));
    const report = [];
    const dir = path.join(ROOT, 'rulesets');
    for ( const file of fs.readdirSync(dir).filter(f => f.endsWith('-scriptlets.js')).sort() ) {
        const id = file.slice(0, -'-scriptlets.js'.length);
        const urls = urlOf.get(id) ?? '';
        const adguardContent = urls.split(' + ').some(isTrustedScriptletSource) || CHECK_CONFIG.ADGUARD_DERIVED_LISTS.includes(id)
            || receivesAdguardBaseCountryContent(id);
        checkScriptletFile(`rulesets/${file}`, fs.readFileSync(path.join(dir, file), 'utf8'), adguardContent, report);
    }
    for ( const line of report.slice(0, CHECK_CONFIG.MAX_REPORTED) ) { failures.push(`data: ${line}`); }
    if ( report.length > CHECK_CONFIG.MAX_REPORTED ) { failures.push(`data: … and ${report.length - CHECK_CONFIG.MAX_REPORTED} more`); }
    // (audit 10.6.4) No uBO scriptlet line may ship as a hide rule: an invalid "+js(…)" selector makes the browser drop
    // the whole CSS rule of its site (the extension joins a site's selectors into one rule). The build converts these
    // lines (tools/build/ubo-scriptlet-syntax.mjs); this proves none reached a cosmetic file.
    for ( const file of fs.readdirSync(dir).filter(f => /-cosmetic.*\.(json|js)$/.test(f)).sort() ) {
        if ( fs.readFileSync(path.join(dir, file), 'utf8').includes('+js(') ) {
            failures.push(`data: rulesets/${file} carries a uBO scriptlet "+js(…)" as a hide selector — rebuild`);
        }
    }
    // The shared library must publish every function through the CURRENT run-time guard.
    const lib = readText(SCRIPTLET_LIBRARY_FILE);
    try { decodeLibrarySource(lib); } catch (err) { failures.push(`library: ${err.message} — the run-time guard is missing or outdated (rebuild)`); return; }
    expect(lib.endsWith(DISPATCH_LAYOUT_CONFIG.LIB_TAIL) && lib.includes(`const V=${scriptletPolicyViolation.toString()};`),
        'library: rulesets/scriptlet-library.js does not carry the current run-time policy guard (rebuild)');
}

// ── 4. Remote code in the package ─────────────────────────────────────────────
function walk(dir, out) {
    for ( const entry of fs.readdirSync(dir, { withFileTypes: true }) ) {
        if ( entry.isDirectory() ) {
            if ( CHECK_CONFIG.SKIP_DIRS.includes(entry.name) ) { continue; }
            walk(path.join(dir, entry.name), out);
        } else if ( CHECK_CONFIG.SCAN_EXTENSIONS.includes(path.extname(entry.name)) ) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}
function remoteCodeFindings(rel, text) {
    const found = [];
    for ( const [ re, label ] of CHECK_CONFIG.REMOTE_CODE_PATTERNS ) {
        const m = re.exec(text);
        if ( m !== null ) { found.push(`${rel}: ${label} — ${m[0].slice(0, 120)}`); }
    }
    return found;
}
function checkManifest(manifest) {
    const remote = /^(?:https?:)?\/\//i;
    const csp = manifest.content_security_policy;
    const cspText = typeof csp === 'string' ? csp : JSON.stringify(csp ?? {});
    expect(/unsafe-eval|unsafe-inline|https?:|wasm-unsafe-eval/.test(cspText) === false, `manifest: content_security_policy allows remote code or eval: ${cspText}`);
    const scripts = [ manifest.background?.service_worker, ...(manifest.content_scripts ?? []).flatMap(c => c.js ?? []) ];
    for ( const s of scripts.filter(Boolean) ) { expect(remote.test(s) === false, `manifest: script loaded from a URL: ${s}`); }
}
function checkPackage() {
    const report = [];
    for ( const file of walk(ROOT, []) ) {
        report.push(...remoteCodeFindings(path.relative(ROOT, file), fs.readFileSync(file, 'utf8')));
    }
    for ( const line of report.slice(0, CHECK_CONFIG.MAX_REPORTED) ) { failures.push(`package: ${line}`); }
    checkManifest(JSON.parse(readText('manifest.json')));
}

// ── 5. Wiring ─────────────────────────────────────────────────────────────────
function checkWiring() {
    const steps = readText('tools/build/build-steps.mjs');
    expect(/scriptletViolationAnySource\(r\.name, r\.args\)/.test(steps), 'wiring: the build does not gate scriptlet rules per list (rules D, B, C)');
    const cs = readText('js/core/custom-scriptlets.js');
    expect((cs.match(/scriptletRuleRejection\(/g) ?? []).length >= 3,
        'wiring: custom-scriptlets.js must check the policy at Custom Rules input, ABP import and before executeScript');
    expect(/export const DELIBERATELY_EXCLUDED_SCRIPTLET_NAMES/.test(cs) === false,
        'wiring: the documentation-only exclusion constant is back — the policy lives in js/data/scriptlet-policy.js');
}

// ── 6. Self-test — the check must catch the real incident ────────────────────
function selfTest() {
    const R = CHECK_CONFIG.REJECTED_RULE;
    const byHostname = new Map([ [ 'supersoluce.com', [ [ 0, 1, R.args ] ] ] ]);
    const fake = renderScriptletFile([ R.name ], encodeDispatchTables(byHostname), false, 'selftest');
    const caught = [];
    checkScriptletFile('selftest-scriptlets.js', fake, true, caught);
    expect(caught.length === 1, 'self-test: the rejected viously rule in a data file was NOT detected');
    const trustedFake = renderScriptletFile([ 'trusted-click-element' ], encodeDispatchTables(new Map([ [ 'x.com', [ [ 0, 1, [ 'button' ] ] ] ] ])), false, 'selftest');
    const caughtTrust = [];
    checkScriptletFile('selftest-scriptlets.js', trustedFake, false, caughtTrust);
    expect(caughtTrust.length === 1, 'self-test: a trusted scriptlet in a non-AdGuard list was NOT detected');
    expect(remoteCodeFindings('selftest.js', 'const m = await import("https://cdn.example.com/x.js");').length === 1,
        'self-test: a remote dynamic import was NOT detected');
    expect(remoteCodeFindings('selftest.html', '<script src="https://cdn.example.com/x.js"></script>').length === 1,
        'self-test: a remote <script src> was NOT detected');
    expect(remoteCodeFindings('selftest.js', 'e.src="https://cdn.viously.com/js/sdk/boot.js"').length === 1,
        'self-test: a remote script .src was NOT detected');
    expect(remoteCodeFindings('selftest.js', 'import { a } from "./local.js"; s.src = chrome.runtime.getURL("x.js");').length === 0,
        'self-test: a local import or extension URL was reported as remote');
}

checkPolicy();
checkUboConversion();
checkTrustGate();
checkShippedData();
checkPackage();
checkWiring();
selfTest();

if ( failures.length !== 0 ) {
    console.error(`check-mv3-compliance: ${failures.length} problem(s):`);
    for ( const f of failures ) { console.error(`  ✗ ${f}`); }
    process.exit(1);
}
console.log('check-mv3-compliance: OK — policy, trust gate, shipped scriptlet data, package and wiring comply with Manifest V3.');
