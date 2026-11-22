#!/usr/bin/env node
// tools/compare-rulesets.mjs — rule-level comparison of two built trees (10.7.6, one-parser switch).
//
// STANDALONE, like verify-build-unchanged.mjs: use it around a change to how network rules are TRANSLATED,
// where "identical output" is not the goal but every changed rule must have a reason. Pairs each removed
// rule with its replacement and names the difference (separator restored, end anchor, resource types, …);
// equivalent notations are folded first (case-insensitive pattern case, trailing/leading "*", case flag
// false == absent, coalesced host lists exploded per host). Anything left as plain ADDED/REMOVED needs a
// manual look at its source line.
//
// Typical use: verify-build-unchanged.mjs record <dir> on the OLD tree (live downloads), then
// FETCH_RR_MODE=replay build of the NEW tree on the same recording, then:
//   node tools/compare-rulesets.mjs <oldRoot> <newRoot> [examplesPerCategory]
import fs from 'fs';
import path from 'path';

const [ aRoot, bRoot, exArg ] = process.argv.slice(2);
const EX = Number(exArg ?? 2);
function sortDeep(v) {
    if ( Array.isArray(v) ) { return v.map(sortDeep).sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1); }
    if ( v && typeof v === 'object' ) { return Object.fromEntries(Object.keys(v).sort().map(k => [ k, sortDeep(v[k]) ])); }
    return v;
}
// Equivalent notations folded before comparing: case-insensitive patterns compared lowercase, a trailing "*"
// dropped (Chrome: both match identically), case flag false == absent (default since Chrome 118).
function equivalentForm(r) {
    const c = JSON.parse(JSON.stringify(r)); delete c.id;
    const cond = c.condition ?? {};
    if ( typeof cond.urlFilter === 'string' ) {
        if ( cond.isUrlFilterCaseSensitive !== true ) { cond.urlFilter = cond.urlFilter.toLowerCase(); }
        cond.urlFilter = cond.urlFilter.replace(/\*+$/, '').replace(/^\*+(?=[^|])/, '');
    }
    if ( cond.isUrlFilterCaseSensitive === false ) { delete cond.isUrlFilterCaseSensitive; }
    return c;
}
function canon(r) { return JSON.stringify(sortDeep(equivalentForm(r))); }
function explode(r) {
    return (r.condition?.requestDomains?.length > 1)
        ? r.condition.requestDomains.map(d => ({ ...r, condition: { ...r.condition, requestDomains: [ d ] } })) : [ r ];
}
function load(root, f) {
    try { const d = JSON.parse(fs.readFileSync(path.join(root, 'rulesets', f), 'utf8')); return Array.isArray(d) ? d.filter(r => r && r.condition && r.action).flatMap(explode) : []; } catch { return []; }
}
// Pairing key: the rule with every separator/anchor char removed from urlFilter, requestDomains folded into
// urlFilter, and resourceTypes ignored — so a rule and its corrected version land on the same key.
function pairKey(r) {
    r = equivalentForm(r);
    const c = { ...r.condition };
    let uf = c.urlFilter ?? (c.requestDomains ? `||${c.requestDomains[0]}` : '');
    uf = uf.replace(/[\^|]/g, '');
    delete c.urlFilter; delete c.requestDomains; delete c.resourceTypes; delete c.isUrlFilterCaseSensitive;
    return JSON.stringify(sortDeep({ a: r.action?.type, uf, c, p: r.priority }));
}
function why(a, b) {
    a = equivalentForm(a); b = equivalentForm(b);
    const reasons = [];
    const ua = a.condition.urlFilter ?? '', ub = b.condition.urlFilter ?? '';
    if ( ua !== ub ) {
        const coreA = ua.replace(/^\|\|?/, ''), coreB = ub.replace(/^\|\|?/, '');
        if ( /\|/.test(coreA.replace(/\|$/, '')) && coreB.includes('^') ) { reasons.push('mid "|" -> "^" (rule could never match)'); }
        else if ( ub === `${ua}^` ) { reasons.push('trailing "^" restored (no longer over-matches)'); }
        else if ( ua.endsWith('|') && ub.endsWith('^') ) { reasons.push('"|" end anchor -> "^" separator'); }
        else { reasons.push(`urlFilter ${JSON.stringify(ua)} -> ${JSON.stringify(ub)}`); }
    }
    if ( JSON.stringify(a.condition.requestDomains) !== JSON.stringify(b.condition.requestDomains) && (a.condition.requestDomains || b.condition.requestDomains) ) { reasons.push('requestDomains <-> urlFilter'); }
    const ta = JSON.stringify((a.condition.resourceTypes ?? []).slice().sort()), tb = JSON.stringify((b.condition.resourceTypes ?? []).slice().sort());
    if ( ta !== tb ) {
        const A = new Set(a.condition.resourceTypes ?? []), B = new Set(b.condition.resourceTypes ?? []);
        reasons.push(`resourceTypes -[${[ ...A ].filter(x => !B.has(x))}] +[${[ ...B ].filter(x => !A.has(x))}]`);
    }
    return reasons.join(' & ') || '(order/other)';
}
const files = new Set([ ...fs.readdirSync(path.join(aRoot, 'rulesets')), ...fs.readdirSync(path.join(bRoot, 'rulesets')) ].filter(f => f.endsWith('.json')));
const cats = new Map();
function add(cat, file, ex) { const e = cats.get(cat) ?? { n: 0, ex: [] }; e.n++; if ( e.ex.length < EX ) { e.ex.push(`${file}: ${ex}`); } cats.set(cat, e); }
for ( const f of files ) {
    const A = load(aRoot, f), B = load(bRoot, f);
    const mA = new Map(), mB = new Map();
    for ( const r of A ) { const k = canon(r); mA.set(k, [ ...(mA.get(k) ?? []), r ]); }
    for ( const r of B ) { const k = canon(r); mB.set(k, [ ...(mB.get(k) ?? []), r ]); }
    const removed = [], added = [];
    for ( const [ k, rs ] of mA ) { const n = rs.length - (mB.get(k)?.length ?? 0); for ( let i = 0; i < n; i++ ) { removed.push(rs[0]); } }
    for ( const [ k, rs ] of mB ) { const n = rs.length - (mA.get(k)?.length ?? 0); for ( let i = 0; i < n; i++ ) { added.push(rs[0]); } }
    const addByKey = new Map();
    for ( const r of added ) { const k = pairKey(r); addByKey.set(k, [ ...(addByKey.get(k) ?? []), r ]); }
    for ( const r of removed ) {
        const k = pairKey(r); const list = addByKey.get(k);
        if ( list?.length ) { const b = list.shift(); add(`CHANGED: ${why(r, b)}`, f, `${JSON.stringify(r.condition).slice(0, 150)}  =>  ${JSON.stringify(b.condition).slice(0, 150)}`); }
        else { add(`REMOVED (${r.action.type}${r.action.redirect ? ':redirect' : ''})`, f, JSON.stringify(r).slice(0, 260)); }
    }
    for ( const list of addByKey.values() ) { for ( const r of list ) { add(`ADDED (${r.action.type})`, f, JSON.stringify(r).slice(0, 260)); } }
}
for ( const [ cat, e ] of [ ...cats ].sort((x, y) => y[1].n - x[1].n) ) {
    console.log(`\n[${e.n}] ${cat}`);
    for ( const x of e.ex ) { console.log(`    ${x}`); }
}
