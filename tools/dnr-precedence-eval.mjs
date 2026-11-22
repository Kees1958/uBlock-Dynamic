// ── dnr-precedence-eval.mjs ───────────────────────────────────────────────────
// MODEL of Chrome's documented DNR precedence (highest priority wins; on a
// tie allow beats block). It is NOT Chrome. Rules it cannot model
// (regexFilter, redirect, modifyHeaders, excluded*Domains) are counted and
// reported, never guessed at.
//
// Public interface:
//   loadEnabledRules(root)                 — every manifest-enabled static rule
//   evaluate(rules, request, extraRules)   — { outcome, winner } for a request
//   CLI: node tools/dnr-precedence-eval.mjs   — per-list report
//
// State owned: none (pure functions; the CLI builds its own local arrays).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Config (one place) ────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
    // The Worry-free extra lists (selected by id, not priority, so the report keeps
    // working when their priority band moves). 10.0.7: the retired lists are gone, annoyances is
    // always-on (not an extra list any more) and ruleset_kees1958 is a Worry-free extra.
    // 10.7.1: ruleset_disconnect_other removed.
    EXTRA_LIST_IDS: Object.freeze([ 'ruleset_adguard_tracking_servers',
        'ruleset_kees1958', 'ruleset_peterlowe', 'ruleset_hagezi_light' ]),   // (11.0.0) + HaGeZi Light
    // Resource types probed per blocking rule.
    PROBE_TYPES: Object.freeze([ 'script', 'sub_frame', 'image', 'xmlhttprequest' ]),
    // Initiator used for third-party probes.
    THIRD_PARTY_INITIATOR: 'example-site.nl',
    // Max probe URLs per list (deterministic stride sample; keeps the run fast).
    MAX_PROBES_PER_LIST: 400,
    // DNR default when resourceTypes is absent: everything but main_frame.
    ALL_TYPES: Object.freeze([ 'sub_frame', 'stylesheet', 'script', 'image', 'font',
        'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other' ]),
});

export const EXTRA_LIST_IDS = CONFIG.EXTRA_LIST_IDS;

const UNMODELED = [ 'regexFilter', 'excludedInitiatorDomains', 'excludedRequestDomains',
    'excludedResourceTypes', 'requestMethods', 'tabIds' ];

// ── Matching ──────────────────────────────────────────────────────────────────
const filterCache = new Map(); // bounded by the number of distinct urlFilters in shipped rulesets

function urlFilterToRegex(filter, caseSensitive) {
    const key = `${caseSensitive ? 'S' : 'I'}${filter}`;
    let re = filterCache.get(key);
    if ( re ) { return re; }
    let f = filter, src = '';
    if ( f.startsWith('||') ) { src = '^[a-z][a-z0-9+.-]*://([^/]*\\.)?'; f = f.slice(2); }
    else if ( f.startsWith('|') ) { src = '^'; f = f.slice(1); }
    let tail = '';
    if ( f.endsWith('|') ) { tail = '$'; f = f.slice(0, -1); }
    for ( const ch of f ) {
        if ( ch === '*' ) { src += '.*'; }
        else if ( ch === '^' ) { src += '([^\\w\\-.%]|$)'; }
        else { src += ch.replace(/[.+?${}()|[\]\\/]/g, '\\$&'); }
    }
    re = new RegExp(src + tail, caseSensitive ? '' : 'i');
    filterCache.set(key, re);
    return re;
}

function hostMatches(host, list) { return list.some(d => host === d || host.endsWith(`.${d}`)); }
function registrable(host) { return host.split('.').slice(-2).join('.'); }

export function ruleMatches(rule, req) {
    const c = rule.condition ?? {};
    const types = c.resourceTypes ?? CONFIG.ALL_TYPES;
    if ( !types.includes(req.type) ) { return false; }
    const reqHost = new URL(req.url).hostname;
    const third = registrable(reqHost) !== registrable(req.initiator);
    if ( c.domainType === 'thirdParty' && !third ) { return false; }
    if ( c.domainType === 'firstParty' && third ) { return false; }
    if ( c.requestDomains && !hostMatches(reqHost, c.requestDomains) ) { return false; }
    if ( c.initiatorDomains && !hostMatches(req.initiator, c.initiatorDomains) ) { return false; }
    if ( c.urlFilter && !urlFilterToRegex(c.urlFilter, c.isUrlFilterCaseSensitive === true).test(req.url) ) { return false; }
    return true;
}

// Highest priority wins; allow beats block on a tie.
export function evaluate(rules, req) {
    let best = null;
    for ( const r of rules ) {
        const t = r.action?.type;
        if ( t !== 'block' && t !== 'allow' && t !== 'allowAllRequests' ) { continue; }
        if ( !ruleMatches(r, req) ) { continue; }
        const p = r.priority ?? 1;
        const isAllow = t !== 'block';
        if ( best === null || p > best.priority || (p === best.priority && isAllow && !best.isAllow) ) {
            best = { priority: p, isAllow, rule: r };
        }
    }
    return best === null ? { outcome: 'ALLOW', winner: null }
        : { outcome: best.isAllow ? 'ALLOW' : 'BLOCK', winner: best.rule };
}

// ── Loading ───────────────────────────────────────────────────────────────────
export function loadEnabledRules(root) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const out = [], unmodeled = new Map();
    for ( const rr of manifest.declarative_net_request.rule_resources ) {
        if ( rr.enabled !== true ) { continue; }
        const p = path.join(root, rr.path.replace(/^\//, ''));
        if ( !fs.existsSync(p) ) { throw new Error(`missing ruleset file: ${rr.path}`); }
        for ( const rule of JSON.parse(fs.readFileSync(p, 'utf8')) ) {
            const c = rule.condition ?? {};
            const bad = UNMODELED.find(k => c[k] !== undefined) ??
                (rule.action?.type === 'redirect' || rule.action?.type === 'modifyHeaders' ? rule.action.type : null);
            if ( bad ) { unmodeled.set(bad, (unmodeled.get(bad) ?? 0) + 1); continue; }
            out.push({ ...rule, _list: rr.id });
        }
    }
    return { rules: out, unmodeled };
}

// ── CLI report ────────────────────────────────────────────────────────────────
export function probeUrls(rule) {
    const c = rule.condition ?? {};
    if ( c.requestDomains ) { return c.requestDomains.map(d => `https://${d}/x`); }
    if ( c.urlFilter?.startsWith('||') ) {
        const u = c.urlFilter.slice(2).replace(/[\^|]/g, '').replace(/\*/g, 'x');
        return /^[a-z0-9.-]+(\/|$)/i.test(u) ? [ `https://${u}${u.includes('/') ? '' : '/x'}` ] : [];
    }
    return [];
}

function report(root) {
    const { rules, unmodeled } = loadEnabledRules(root);
    const allows = rules.filter(r => r.action?.type !== 'block');
    const lists = new Map();
    const probes = new Map(); // list -> [{rule,url}] (bounded by MAX_PROBES_PER_LIST after sampling)
    for ( const r of rules ) {
        if ( r.action?.type !== 'block' || !CONFIG.EXTRA_LIST_IDS.includes(r._list) ) { continue; }
        const arr = probes.get(r._list) ?? [];
        for ( const url of probeUrls(r) ) { arr.push({ r, url }); }
        probes.set(r._list, arr);
    }
    for ( const [ list, all ] of probes ) {
        const stride = Math.max(1, Math.ceil(all.length / CONFIG.MAX_PROBES_PER_LIST));
        const row = Object.fromEntries(CONFIG.PROBE_TYPES.map(t => [ t, { block: 0, allow: 0, by: new Map() } ]));
        for ( let i = 0; i < all.length; i += stride ) {
            const { r, url } = all[i];
            for ( const type of CONFIG.PROBE_TYPES ) {
                if ( r.condition?.resourceTypes && !r.condition.resourceTypes.includes(type) ) { continue; }
                const req = { url, type, initiator: CONFIG.THIRD_PARTY_INITIATOR };
                // Only allows can override the extras rule; consider it alone + all allows.
                const res = evaluate([ r, ...allows ], req);
                const cell = row[type];
                if ( res.outcome === 'BLOCK' ) { cell.block++; }
                else { cell.allow++; const w = `${res.winner._list}@${res.winner.priority}`; cell.by.set(w, (cell.by.get(w) ?? 0) + 1); }
            }
        }
        lists.set(list, row);
    }
    console.log(`Enabled static rules modelled: ${rules.length}`);
    console.log('Not modelled (skipped):', Object.fromEntries(unmodeled));
    for ( const [ list, row ] of lists ) {
        console.log(`\n${list}`);
        for ( const t of CONFIG.PROBE_TYPES ) {
            const c = row[t], n = c.block + c.allow;
            if ( n === 0 ) { continue; }
            const why = [ ...c.by ].map(([ k, v ]) => `${k}×${v}`).join(', ');
            console.log(`  3rd-party ${t.padEnd(15)} blocked ${c.block}/${n}` + (c.allow ? `  overridden by ${why}` : ''));
        }
    }
}

if ( process.argv[1] === fileURLToPath(import.meta.url) ) {
    report(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
