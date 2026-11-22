#!/usr/bin/env node
// tools/test-privacy-badger-unbreak.mjs — (11.0.0, owner's decision 2026-11-20) EFF Privacy Badger "unbreak", HARD.
// What it is: tools/build/privacy-badger-unbreak.mjs. Three parts:
//   1. Pure selection: needed hosts from seed.json (cookieblock only — never block/allow); a needed host blocked by the
//      four Seamless tracker lists (HaGeZi Light, Peter Lowe, Kees1958, AdGuard tracking servers) becomes an EXACT-host
//      exception — never one for its subdomains (a needed shared-hosting domain such as amazonaws.com unblocks nothing).
//   2. Shipped rulesets: the exceptions are in the hidden tracker-exception ruleset, at the tracker lists' priority,
//      and HaGeZi Light is one of its parents.
//   3. No side effect on other lists: an exception must not cover a host that a list at or below that priority (other
//      than the four tracker lists) blocks domain-wide — it would silently lift that block.
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ── Settings ──────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
    EXCEPTION_RULESET: 'rulesets/ruleset_tracking_servers_allowlist.json',
    TRACKER_LISTS: [ 'ruleset_kees1958', 'ruleset_peterlowe', 'ruleset_adguard_tracking_servers', 'ruleset_hagezi_light' ],
    NOT_LISTS: [ 'ruleset_tracking_servers_allowlist' ],
    // A realistic floor for the exceptions added (74 hosts on 2026-11-20); far fewer = the step silently did nothing.
    MIN_EXCEPTED: 30,
});

console.log('=== EFF Privacy Badger unbreak (11.0.0) ===');
let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if ( !ok ) { failures++; }
}
function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}\nA check that did not run has not passed.`);
    process.exit(1);
}

let pb, ta;
try {
    pb = await import(path.join(ROOT, 'tools/build/privacy-badger-unbreak.mjs'));
    ta = await import(path.join(ROOT, 'tools/build/tracking-allowlist-source.mjs'));
} catch ( err ) {
    didNotRun(`cannot import the modules under test (${err.message})`);
}

// ── 1. Pure selection ─────────────────────────────────────────────────────────
console.log('--- 1. selection ---');
const seed = { action_map: {
    'tiktok.com': { heuristicAction: 'block' },
    'adbutler.com': { heuristicAction: 'allow' },
    'cmp.inmobi.com': { heuristicAction: 'cookieblock' },
    'piano.io': { heuristicAction: 'cookieblock' },
    'video.primis.tech': { heuristicAction: 'cookieblock' },
    '*.bad': { heuristicAction: 'cookieblock' },
} };
const needed = pb.neededHostsFromSeed(seed);
check('only cookieblock hosts are taken (never block / allow), invalid names skipped',
    JSON.stringify(needed) === JSON.stringify([ 'cmp.inmobi.com', 'piano.io', 'video.primis.tech' ]), needed.join(','));
const neededSet = new Set(needed);
const trackerLines = ta.selectPrivacyBadgerAllowLines(neededSet, new Set([ 'inmobi.com', 'piano.io' ]));
check('tracker lists: needed hosts they block (itself or a parent) become EXACT-host exceptions',
    JSON.stringify(trackerLines) === JSON.stringify([ '@@|https://cmp.inmobi.com^', '@@|http://cmp.inmobi.com^', '@@|https://piano.io^', '@@|http://piano.io^' ]), trackerLines.join(','));
const broad = ta.selectPrivacyBadgerAllowLines(new Set([ 'amazonaws.com' ]), new Set([ 'amazonaws.com' ]));
check('a needed shared-hosting domain is excepted for itself only (exact host), never its subdomains',
    broad.every(l => l.startsWith('@@|http')) && broad.every(l => l.includes('||') === false), broad.join(','));
check('HaGeZi Light is one of the tracker lists the exceptions are made for',
    ta.TRACKING_ALLOWLIST_SOURCE.parentRulesetIds.includes('ruleset_hagezi_light'));

// ── 2. Shipped rulesets ───────────────────────────────────────────────────────
console.log('--- 2. shipped rulesets ---');
function load(rel) { try { return JSON.parse(read(rel)); } catch ( err ) { didNotRun(`${rel} not readable (${err.message})`); } }
function allowHosts(rules) {
    const out = new Set();
    for ( const r of rules ) {
        if ( r.action?.type !== 'allow' ) { continue; }
        const c = r.condition ?? {};
        for ( const d of c.requestDomains ?? [] ) { out.add(d); }
        const m = /^(?:\|\||\|https?:\/\/)([a-z0-9.-]+)\^$/.exec(c.urlFilter ?? '');
        if ( m ) { out.add(m[1]); }
    }
    return out;
}
function domainWideBlocks(rules) {
    const out = new Set();
    for ( const r of rules ) {
        if ( r.action?.type !== 'block' ) { continue; }
        const c = r.condition ?? {};
        if ( c.initiatorDomains || c.regexFilter ) { continue; }
        if ( c.requestDomains && c.urlFilter === undefined ) { for ( const d of c.requestDomains ) { out.add(d); } }
        const m = /^\|\|([a-z0-9.-]+)\^?$/.exec(c.urlFilter ?? '');
        if ( m && c.requestDomains === undefined ) { out.add(m[1]); }
    }
    return out;
}
function covers(host, set) {
    for ( let h = host; ; h = h.slice(h.indexOf('.') + 1) ) {
        if ( set.has(h) ) { return h; }
        if ( h.includes('.') === false ) { return null; }
    }
}
const exceptionRules = load(CONFIG.EXCEPTION_RULESET);
const exceptHosts = allowHosts(exceptionRules);
const exactPb = exceptionRules.filter(r => r.action?.type === 'allow' && /^\|https?:\/\//.test(r.condition?.urlFilter ?? ''));
check('tracker-list exceptions hold Privacy Badger hosts (e.g. the InMobi consent banner)', exceptHosts.has('cmp.inmobi.com'));
check(`a realistic number of Privacy Badger exceptions shipped (>= ${CONFIG.MIN_EXCEPTED} hosts)`,
    new Set(exactPb.map(r => r.condition.urlFilter.replace(/^\|https?:\/\/|\^$/g, ''))).size >= CONFIG.MIN_EXCEPTED, String(exactPb.length));
const allowPriority = exceptionRules.find(r => r.action?.type === 'allow')?.priority;
const trackerPriorities = new Set(CONFIG.TRACKER_LISTS.flatMap(id => {
    try { return load(`rulesets/${id}.json`).filter(r => r.action?.type === 'block').map(r => r.priority); } catch { return []; }
}));
check('the exceptions sit at exactly the tracker lists\' priority', trackerPriorities.size === 1 && trackerPriorities.has(allowPriority),
    `exceptions ${allowPriority}, tracker lists ${[ ...trackerPriorities ].join(',')}`);

// ── 3. No side effect on other lists ──────────────────────────────────────────
console.log('--- 3. other lists untouched ---');
const reachable = new Map();   // other lists whose blocks an allow at allowPriority could beat (priority <= it)
for ( const f of fs.readdirSync(path.join(ROOT, 'rulesets')) ) {
    const m = /^(ruleset_[a-z0-9_]+)\.json$/.exec(f);
    if ( m === null || CONFIG.TRACKER_LISTS.includes(m[1]) || CONFIG.NOT_LISTS.includes(m[1]) ) { continue; }
    let rules;
    try { rules = JSON.parse(read(path.join('rulesets', f))); } catch { continue; }
    if ( Array.isArray(rules) === false ) { continue; }
    reachable.set(m[1], domainWideBlocks(rules.filter(r => r.priority <= allowPriority)));
}
const lifted = [];
for ( const r of exactPb ) {
    const host = r.condition.urlFilter.replace(/^\|https?:\/\/|\^$/g, '');
    for ( const [ id, set ] of reachable ) {
        const hit = covers(host, set);
        if ( hit !== null ) { lifted.push(`${host} (${id} via ${hit})`); }
    }
}
check('no Privacy Badger exception lifts a block of another list', lifted.length === 0, lifted.slice(0, 5).join('; '));

console.log(failures === 0 ? 'PASS' : `FINDINGS: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
