#!/usr/bin/env node
// check-geo-scope.mjs — the geographic scope (10.4.5) holds in the build AND in every shipped file (suite step 56).
//
// The scope (GEO_SCOPE, tools/build/tld-scope.mjs): Europe without Moldova/Belarus/Ukraine/Russia, the Americas,
// and in Asia/Oceania only Australia and New Zealand (South Korea and Japan out again since 10.4.6); worldwide-used
// ccTLDs stay generic; non-Latin domain names only in Cyrillic or Greek script, and non-Latin ccTLDs (.рф …) are
// judged by their country.
// Three checks, all on the REAL code and the REAL shipped files — never a copy of the rule:
//   1. The scope decision itself: fixed in-scope / out-of-scope / generic examples through the real isTLDKept().
//   2. The network gate: applyGeoScopeToNetworkRule() on rule shapes that slipped through before (no "^",
//      a "*" in the host, a path, a site list that loses only some or all of its sites).
//   3. Every shipped ruleset: no out-of-scope domain as a network target (urlFilter "||host"), in
//      requestDomains or initiatorDomains, nor as a cosmetic or scriptlet hostname.
// Pure read of the tree — nothing to initialise, clear or release.
import fs from 'fs';
import path from 'path';
import { OUT_OF_SCOPE_CCTLDS, isTLDKept } from './build/tld-scope.mjs';
import { applyGeoScopeToNetworkRule } from './build/list-parser.mjs';
import { decodeDispatchSource } from './build/scriptlet-dispatch-layout.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── CONFIG (every example of this check, one place) ───────────────────────
const CHECK_CONFIG = Object.freeze({
    IN_SCOPE:     [ 'example.com', 'x.nl', 'x.al', 'x.rs', 'x.ba', 'x.mk', 'x.me', 'x.uk', 'x.ch', 'x.no', 'x.br',
                    'x.mx', 'x.ca', 'x.ar', 'x.au', 'x.nz', 'x.eu', 'x.io', 'kat.*', '1.2.3.4',
                    'müller.de', 'пример.бг', 'παράδειγμα.ελ', 'xn--mller-kva.de' ],
    GENERIC_USE:  [ 'x.tv', 'x.to', 'x.ws', 'x.fm', 'x.pw', 'x.st', 'x.la', 'x.so', 'parse.ly' ],
    OUT_OF_SCOPE: [ 'x.ru', 'x.ua', 'x.by', 'x.md', 'x.tr', 'x.ge', 'x.in', 'x.cn', 'x.id', 'x.vn', 'x.za',
                    'x.il', 'x.hk', 'x.fj', 'x.jp', 'x.kr', '虹オタ.com', '한국어.kr', 'x.xn--3e0b707e', 'скачатьофис.рф', 'xn--80aswg.xn--p1ai', 'اكوام.net', 'analytics.ดูบอล.com' ],
    MAX_REPORTED: 10,
});

const failures = [];
function expect(condition, label) { if ( condition === false ) { failures.push(label); } }

// The real decision, so the shipped-file scan can never disagree with the build.
function outOfScope(d) { return isTLDKept(String(d)) === false; }

// 1 — the decision.
function checkDecision() {
    for ( const h of [ ...CHECK_CONFIG.IN_SCOPE, ...CHECK_CONFIG.GENERIC_USE ] ) { expect(isTLDKept(h), `in scope but dropped: ${h}`); }
    for ( const h of CHECK_CONFIG.OUT_OF_SCOPE ) { expect(isTLDKept(h) === false, `out of scope but kept: ${h}`); }
}

// 2 — the network gate.
function checkGate() {
    function block(condition) { return { id: 1, priority: 1, action: { type: 'block' }, condition }; }
    expect(applyGeoScopeToNetworkRule(block({ urlFilter: '||ads.example.ru^' })) === null, 'gate: "||host^" on .ru kept');
    expect(applyGeoScopeToNetworkRule(block({ urlFilter: '||ads.example.ru' })) === null, 'gate: "||host" (no ^) on .ru kept');
    expect(applyGeoScopeToNetworkRule(block({ urlFilter: '||ads*.example.ru^' })) === null, 'gate: "*" in the host on .ru kept');
    expect(applyGeoScopeToNetworkRule(block({ urlFilter: '||ads.example.ru/banner' })) === null, 'gate: host with a path on .ru kept');
    expect(applyGeoScopeToNetworkRule(block({ urlFilter: '||ads.example.com^' })) !== null, 'gate: an in-scope ad server was dropped');
    expect(applyGeoScopeToNetworkRule(block({ urlFilter: '/advert.js', initiatorDomains: [ 'a.ru', 'b.ua' ] })) === null,
        'gate: a rule left with no in-scope site was kept');
    const narrowed = applyGeoScopeToNetworkRule(block({ urlFilter: '/advert.js', initiatorDomains: [ 'a.ru', 'b.nl' ] }));
    expect(JSON.stringify(narrowed?.condition?.initiatorDomains) === '["b.nl"]', 'gate: the site list was not narrowed to its in-scope sites');
    const excluded = applyGeoScopeToNetworkRule(block({ urlFilter: '/advert.js', excludedInitiatorDomains: [ 'a.ru' ] }));
    expect(excluded !== null, 'gate: an exception for an out-of-scope site dropped the whole rule');
}

// 3 — every shipped file.
function checkShipped() {
    const dir = path.join(ROOT, 'rulesets');
    const leaks = [];
    let files = 0;
    for ( const name of fs.readdirSync(dir).sort() ) {
        const full = path.join(dir, name);
        if ( name.startsWith('ruleset_') && name.endsWith('.json') && name.includes('cosmetic') === false ) {
            files++;
            for ( const rule of JSON.parse(fs.readFileSync(full, 'utf8')) ) {
                const c = rule.condition ?? {};
                const m = /^\|\|([a-z0-9*.-]+)(?=[|^/:?]|$)/i.exec(c.urlFilter ?? '');
                if ( m && outOfScope(m[1]) ) { leaks.push(`${name}: urlFilter ${c.urlFilter}`); }
                for ( const key of [ 'requestDomains', 'initiatorDomains' ] ) {
                    for ( const d of c[key] ?? [] ) { if ( outOfScope(d) ) { leaks.push(`${name}: ${key} ${d}`); } }
                }
            }
        } else if ( name.endsWith('-cosmetic-specific.json') ) {
            files++;
            for ( const h of JSON.parse(fs.readFileSync(full, 'utf8')).hostnames ?? [] ) {
                if ( outOfScope(h) ) { leaks.push(`${name}: hostname ${h}`); }
            }
        } else if ( name.endsWith('-scriptlets.js') ) {
            files++;
            for ( const h of decodeDispatchSource(fs.readFileSync(full, 'utf8')).hostnames ) {
                if ( outOfScope(h) ) { leaks.push(`${name}: hostname ${h}`); }
            }
        }
    }
    for ( const l of leaks.slice(0, CHECK_CONFIG.MAX_REPORTED) ) { failures.push(`out-of-scope domain shipped — ${l}`); }
    if ( leaks.length > CHECK_CONFIG.MAX_REPORTED ) { failures.push(`… and ${leaks.length - CHECK_CONFIG.MAX_REPORTED} more`); }
    return files;
}

checkDecision();
checkGate();
const scanned = checkShipped();
if ( failures.length > 0 ) {
    for ( const f of failures ) { console.error(`FAIL: ${f}`); }
    console.error(`\n${failures.length} problem(s) with the geographic scope.`);
    process.exit(1);
}
console.log(`PASS: scope decision and network gate behave as specified; ${scanned} shipped file(s) hold no out-of-scope domain (${OUT_OF_SCOPE_CCTLDS.size} out-of-scope ccTLDs).`);
