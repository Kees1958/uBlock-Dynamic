#!/usr/bin/env node
// tools/test-breakage-risk.mjs — (11.1.0) the DNR tracking filter's Break risk verdict (js/core/breakage-risk.js).
//
// Owner's rule (2026-11-23), first match wins: built-in whitelist = high; needed by sites = medium (an allow exception
// in the hidden tracker-exception ruleset — AdGuard + EFF Privacy Badger — or a Disconnect / Ghostery "needed"
// category, js/data/needed-trackers-data.json); DuckDuckGo Tracker Radar = low; none = unknown. Drives the REAL module against the SHIPPED data (manifest, ruleset JSON, Tracker Radar JSON):
//   Rule      — the pure precedence table, every combination.
//   Parser    — every exception rule shape parses; a skipped shape is listed (at most MAX_SKIPPED); the Disconnect
//               and Ghostery parsers of tools/build-needed-trackers.mjs keep only the needed categories.
//   Real data — one known domain per tier, read from the shipped lists rather than typed here, and the
//               "host under the row's domain" case (blocking the domain would also block the excepted host).
//   Lifecycle — Initiate: lookups before loading degrade to "no exception" (never throw); Perform: load; End: reset
//               drops the sets; a load still in flight when reset never writes them back (generation guard).
//   Display   — every verdict has a badge and a hover reason (js/data/risk-badge.js), so no row renders blank.
// Exit 0 = pass, 1 = failed assertion, 2 = could not run (C38).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
globalThis.self = globalThis;   // the extension modules expect a worker global

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
const MODULE = 'js/core/breakage-risk.js';
const TRACKER_RADAR_FILE = 'js/data/tracker-radar-data.json';
const NEEDED_TRACKERS_FILE = 'js/data/needed-trackers-data.json';
const BUILD_TOOL = 'tools/build-needed-trackers.mjs';
const MAX_SKIPPED = 2;                       // exception rules whose urlFilter names no host (11.0.4: 1, '.2o7.net/')
const UNLISTED_HOST = 'no-such-host.invalid'; // reserved TLD: on no list, ever
const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_DID_NOT_RUN = 2;

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if ( !ok ) { failures += 1; }
}
function didNotRun(msg) { console.log(`DID NOT RUN: ${msg}`); process.exit(EXIT_DID_NOT_RUN); }
function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }

// ── Mocked chrome API: the real manifest; getURL/fetch read the extension's own files from disk ───────
let fetchGate = null;   // when set, every fetch waits for it (to hold a load in flight)
const manifest = readJson('manifest.json');
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => manifest, getURL: p => p.replace(/^\//, ''), lastError: null, id: 'test', onMessage: { addListener() {} } },
};
globalThis.fetch = async rel => {
    if ( fetchGate !== null ) { await fetchGate; }
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return { json: async () => JSON.parse(text) };
};

let M, RL, RB, classifier, B;
try {
    M = await import(pathToFileURL(path.join(ROOT, MODULE)).href);
    RL = await import(pathToFileURL(path.join(ROOT, 'js/data/scriptlet-rule-labels.js')).href);
    RB = await import(pathToFileURL(path.join(ROOT, 'js/data/risk-badge.js')).href);
    classifier = await import(pathToFileURL(path.join(ROOT, 'js/core/matrix-classifier.js')).href);
    B = await import(pathToFileURL(path.join(ROOT, BUILD_TOOL)).href);
} catch (e) { didNotRun(`cannot load the modules: ${e.message}`); }
const { RISK_HIGH, RISK_MEDIUM, RISK_LOW } = RL;
const { RISK_UNKNOWN, RISK_BADGE, DOMAIN_RISK_REASON } = RB;

// ── Rule: precedence, all 8 combinations ─────────────────────────────────────────────────────────
for ( const whitelisted of [ false, true ] ) {
    for ( const neededBySites of [ false, true ] ) {
        for ( const knownTracker of [ false, true ] ) {
            const want = whitelisted ? RISK_HIGH : neededBySites ? RISK_MEDIUM : knownTracker ? RISK_LOW : RISK_UNKNOWN;
            const got = M.classifyBreakageRisk({ whitelisted, neededBySites, knownTracker });
            check(`rule: whitelisted=${whitelisted} needed=${neededBySites} tracker=${knownTracker} -> ${want}`, got === want, got);
        }
    }
}

// ── Parser: the shipped exception ruleset ───────────────────────────────────────────────────────
const resource = manifest.declarative_net_request.rule_resources.find(r => r.id === M.TRACKER_EXCEPTION_RULESET_ID);
if ( resource === undefined ) { didNotRun(`manifest has no ruleset ${M.TRACKER_EXCEPTION_RULESET_ID}`); }
const rules = readJson(resource.path);
const parsed = M.extractExceptionHosts(rules);
check(`parser: at most ${MAX_SKIPPED} exception rule(s) name no host`, parsed.skipped <= MAX_SKIPPED, `${parsed.skipped} skipped`);
check('parser: anchored and exact hosts both found', parsed.anchored.size > 0 && parsed.exact.size > 0,
    `${parsed.anchored.size} anchored, ${parsed.exact.size} exact`);
check('parser: block rules are ignored', M.extractExceptionHosts([ { action: { type: 'block' }, condition: { urlFilter: '||x.example^' } } ]).anchored.size === 0);
check('parser: hostile input does not throw', M.extractExceptionHosts(null).skipped === 0 && M.extractExceptionHosts([ null, {} ]).skipped === 0);
const services = { categories: {
    Content: [ { E1: { 'https://e1.example': [ 'Content.Example', 'bad domain' ], performance: 'true' } } ],
    Advertising: [ { E2: { 'https://e2.example': [ 'ads.example' ] } } ],
} };
const dc = B.disconnectNeededDomains(services);
check('build parser (Disconnect): needed category kept, lower-cased; ad category, flags and non-hosts dropped',
    dc.has('content.example') && !dc.has('ads.example') && dc.size === 1, [ ...dc ].join(','));
function eno(cat) { return `name: x\ncategory: ${cat}\n\n--- domains\nplayer.example\n--- domains\n`; }
check('build parser (Ghostery): needed category kept, other category dropped',
    B.ghosteryPatternDomains(eno('audio_video_player')).join() === 'player.example' && B.ghosteryPatternDomains(eno('advertising')).length === 0);
check('build parser: hostile input does not throw', B.disconnectNeededDomains(null).size === 0 && B.ghosteryPatternDomains('').length === 0);

// ── Lifecycle (Initiate): before loading, lookups degrade and never throw ──────────────────────────
const anyAnchored = [ ...parsed.anchored ][0];
check('initiate: before loading, an excepted host reads as no exception (not medium)', M.breakageRiskOf(anyAnchored) !== RISK_MEDIUM);
check('initiate: empty / non-string host is unknown, no throw', M.breakageRiskOf('') === RISK_UNKNOWN && M.breakageRiskOf(undefined) === RISK_UNKNOWN);

// ── Perform: load, then one domain per tier from the shipped data ─────────────────────────────────
await M.ensureBreakageRiskDataReady();
const radar = readJson(TRACKER_RADAR_FILE);
const neededDomains = Object.keys(readJson(NEEDED_TRACKERS_FILE).domains);
const excepted = new Set([ ...parsed.anchored, ...parsed.exact, ...neededDomains ]);
function underAnException(h) { return [ ...excepted ].some(e => e === h || e.endsWith('.' + h) || h.endsWith('.' + e)); }
const whitelistedHost = [ ...excepted, ...Object.keys(radar) ].find(h => classifier.isBuiltinWhitelisted(h))
    ?? Object.keys(radar).find(h => classifier.isBuiltinWhitelisted(h));
const exceptionHost = [ ...parsed.anchored ].find(h => !classifier.isBuiltinWhitelisted(h));
const lowHost = Object.keys(radar).find(h => !classifier.isBuiltinWhitelisted(h) && !underAnException(h));
if ( exceptionHost === undefined || lowHost === undefined ) { didNotRun('shipped data has no example for every tier'); }

if ( whitelistedHost !== undefined ) {
    check(`real data: whitelisted ${whitelistedHost} -> high`, M.breakageRiskOf(whitelistedHost) === RISK_HIGH);
} else {
    console.log('NOTE whitelisted tier: no shipped tracker/exception host is whitelisted — covered by the rule table above');
}
check(`real data: excepted ${exceptionHost} -> medium`, M.breakageRiskOf(exceptionHost) === RISK_MEDIUM);
check(`real data: subdomain of anchored ${exceptionHost} -> medium`, M.breakageRiskOf(`sub.${exceptionHost}`) === RISK_MEDIUM);
const exactOnly = [ ...parsed.exact ].find(h => !classifier.isBuiltinWhitelisted(h) && h.split('.').length > 2
    && ![ ...parsed.anchored ].some(a => h === a || h.endsWith('.' + a)));
if ( exactOnly !== undefined ) {
    const parent = exactOnly.slice(exactOnly.indexOf('.') + 1);
    check(`real data: parent ${parent} of exact-excepted ${exactOnly} -> medium (a block on it covers that host)`,
        classifier.isBuiltinWhitelisted(parent) ? M.breakageRiskOf(parent) === RISK_HIGH : M.breakageRiskOf(parent) === RISK_MEDIUM);
}
const neededHost = neededDomains.find(h => !classifier.isBuiltinWhitelisted(h));
check(`real data: Disconnect/Ghostery needed ${neededHost} -> medium`, M.breakageRiskOf(neededHost) === RISK_MEDIUM);
check(`real data: subdomain of needed ${neededHost} -> medium`, M.breakageRiskOf(`cdn.${neededHost}`) === RISK_MEDIUM);
check(`real data: Tracker Radar ${lowHost} without exception -> low`, M.breakageRiskOf(lowHost) === RISK_LOW);
check(`real data: ${UNLISTED_HOST} -> unknown`, M.breakageRiskOf(UNLISTED_HOST) === RISK_UNKNOWN);
check('real data: case-insensitive', M.breakageRiskOf(exceptionHost.toUpperCase()) === RISK_MEDIUM);

// ── End: reset drops the sets; a load in flight during a reset never writes them back ───────────────
M.resetBreakageRiskCache();
check('end: after reset, the excepted host no longer reads as medium', M.breakageRiskOf(exceptionHost) !== RISK_MEDIUM);
let openGate;
fetchGate = new Promise(r => { openGate = r; });
const inFlight = M.ensureBreakageRiskDataReady();
M.resetBreakageRiskCache();     // the session is released while the load waits
openGate(); fetchGate = null;
await inFlight;
check('end: a load released mid-flight leaves the reset state (generation guard)', M.breakageRiskOf(exceptionHost) !== RISK_MEDIUM);
await M.ensureBreakageRiskDataReady();
check('restart: the next start loads again', M.breakageRiskOf(exceptionHost) === RISK_MEDIUM);

// ── Display: every verdict renders a badge and a reason ───────────────────────────────────────────
for ( const level of [ RISK_HIGH, RISK_MEDIUM, RISK_LOW, RISK_UNKNOWN ] ) {
    check(`display: ${level} has a badge and a hover reason`,
        typeof RISK_BADGE[level]?.glyph === 'string' && typeof DOMAIN_RISK_REASON[level] === 'string' && DOMAIN_RISK_REASON[level].length > 0);
}

console.log(failures === 0 ? 'PASS: Break risk verdict, data, lifecycle and display' : `FAIL: ${failures} check(s)`);
process.exit(failures === 0 ? EXIT_PASS : EXIT_FAIL);
