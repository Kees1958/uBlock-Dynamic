// ── tools/build/regex-support.mjs ─────────────────────────────────────────────────────
// Ships a filter-list regexFilter rule only when CHROME ITSELF accepts the regex (10.7.6 Phase 3, owner's
// decision "A. Translate only supported and warn when pre-compiling hits above 800 supported regexes").
//
// Why Chrome and not a static check: DNR matches regexFilter with RE2 under a per-regex memory budget, and
// only chrome.declarativeNetRequest.isRegexSupported() knows that budget (a case-insensitive regex can be
// "too complex" where the same regex case-sensitive is not). tools/check-dnr-regex-constraints.mjs stays the
// static pre-flight check; this module is the authoritative one.
//
// How: every verdict is CACHED in tools/regex-support-verdicts.json (reviewable, committed with the tools), so
// a normal or replayed build never needs a browser. Only a regex with no cached verdict starts a headless
// Chrome (puppeteer-core + a throw-away extension that calls isRegexSupported()), once per build, lazily.
// No Chrome available -> the unknown regex rules are DROPPED and reported (never shipped unverified).
//
// Public interface:
//   openRegexSupport(root)                 — INIT: load the verdict cache (call once per build, stepInit)
//   filterSupportedRegexRules(rules, owner) — keep non-regex rules + Chrome-supported regex rules
//   noteShippedRegexRules(rulesetId, rules) — per written ruleset: warn above 800, fail above Chrome's 1 000
//   closeRegexSupport()                    — RELEASE: save new verdicts, close Chrome, return the report data
//   verdictKey(regex, caseSensitive)       — the cache key (shared with the standing check)
// State owned: `regexChecker` (state vector below) — per build run, lost when the process ends (safe: the
//   cache file is the durable part).

import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { MAX_NUMBER_OF_REGEX_RULES } from '../../js/core/dnr-budgets.js';

/******************************************************************************/
// Configuration — every switch and number of this module, in one place
/******************************************************************************/

export const REGEX_SUPPORT_CONFIG = Object.freeze({
    VERDICTS_FILE:          'tools/regex-support-verdicts.json',   // the cache (relative to the project root)
    VERDICTS_SCHEMA:        1,                                     // bump when the file shape changes
    REPORT_FILE:            'dropped-regex-rules.txt',             // written by stepWriteReports
    // Owner's decision: a warning above 800 regex rules in ONE ruleset (Chrome's cap is 1 000 per static
    // ruleset — MAX_NUMBER_OF_REGEX_RULES in js/core/dnr-budgets.js; above it the build FAILS, because Chrome
    // would silently ignore the excess).
    WARN_REGEX_RULES_PER_RULESET: 800,
    CHROME_PATH_ENV:        'CHROME_PATH',                         // set it to point at a Chrome / Chrome for Testing
    CHROME_PATH_CANDIDATES: Object.freeze([                        // tried in order when CHROME_PATH is unset
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ]),
    WORKER_WAIT_MS:         30_000,                                // max wait for the probe extension's service worker
    VERDICT_BATCH_SIZE:     200,                                   // regexes checked per worker.evaluate() call
    // Verdict reasons of our own (Chrome's own reason codes are kept as Chrome returns them).
    REASON_NOT_VERIFIED:    'not verified — no Chrome to ask (set CHROME_PATH and install puppeteer-core)',
});

const PHASES = Object.freeze({
    IDLE:    'idle',      // not opened for this build
    LOADED:  'loaded',    // cache in memory, no browser
    BROWSER: 'browser',   // headless Chrome running (lazily started)
    NO_BROWSER: 'no-browser',   // a browser was needed and could not be started — unknown regexes are dropped
    CLOSED:  'closed',    // released
});

// ── STATE VECTOR ────────────────────────────────────────────────────────────
const regexChecker = {
    owner:        'regex-support',
    phase:        PHASES.IDLE,
    root:         null,
    verdicts:     new Map(),    // key "ci:<regex>" / "cs:<regex>" -> { supported, reason, chrome }
    dirty:        false,        // a verdict was added -> the cache file is rewritten on close
    browser:      null,         // puppeteer Browser (BROWSER phase only)
    worker:       null,         // the probe extension's service worker
    probeDir:     null,         // temp dir of the probe extension (removed on close)
    chromeVersion: null,
    noBrowserReason: null,
    dropped:      [],           // { owner, regex, caseSensitive, reason }
    shippedCounts: [],          // { rulesetId, count }
};

// The cache key of one verdict — exported so tools/check-dnr-regex-constraints.mjs reads the same key (B2).
export function verdictKey(regex, caseSensitive) { return `${caseSensitive ? 'cs' : 'ci'}:${regex}`; }

/******************************************************************************/
// INIT / RELEASE
/******************************************************************************/

// INIT guard: a fresh state for this build run, then the cache. A missing cache file is an empty cache; a
// cache with another schema is refused (the build stops) instead of being half-read.
export async function openRegexSupport(root) {
    await releaseBrowser();
    Object.assign(regexChecker, {
        phase: PHASES.LOADED, root, verdicts: new Map(), dirty: false, chromeVersion: null,
        noBrowserReason: null, dropped: [], shippedCounts: [],
    });
    const file = path.join(root, REGEX_SUPPORT_CONFIG.VERDICTS_FILE);
    let data = null;
    try { data = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (err) { if ( err.code !== 'ENOENT' ) { throw new Error(`${REGEX_SUPPORT_CONFIG.VERDICTS_FILE}: ${err.message}`, { cause: err }); } }
    if ( data === null ) { return; }
    if ( data.schema !== REGEX_SUPPORT_CONFIG.VERDICTS_SCHEMA || typeof data.verdicts !== 'object' ) {
        throw new Error(`${REGEX_SUPPORT_CONFIG.VERDICTS_FILE}: unknown schema ${data.schema} — expected ${REGEX_SUPPORT_CONFIG.VERDICTS_SCHEMA}`);
    }
    for ( const [ key, v ] of Object.entries(data.verdicts) ) {
        if ( typeof v?.supported !== 'boolean' ) { throw new Error(`${REGEX_SUPPORT_CONFIG.VERDICTS_FILE}: bad verdict for ${key}`); }
        regexChecker.verdicts.set(key, v);
    }
}

// RELEASE guard: write new verdicts (sorted, so the file diffs cleanly), close Chrome, remove the probe
// extension. Safe to call more than once and on the error path (build-rulesets.mjs).
export async function closeRegexSupport() {
    if ( regexChecker.phase === PHASES.IDLE || regexChecker.phase === PHASES.CLOSED ) { return null; }
    await releaseBrowser();
    if ( regexChecker.dirty ) {
        const verdicts = Object.fromEntries([ ...regexChecker.verdicts ].sort(([ a ], [ b ]) => (a < b ? -1 : a > b ? 1 : 0)));
        const file = path.join(regexChecker.root, REGEX_SUPPORT_CONFIG.VERDICTS_FILE);
        await fs.writeFile(file, JSON.stringify({ schema: REGEX_SUPPORT_CONFIG.VERDICTS_SCHEMA, verdicts }, null, 2) + '\n', 'utf8');
        regexChecker.dirty = false;
    }
    regexChecker.phase = PHASES.CLOSED;
    return { dropped: regexChecker.dropped, shippedCounts: regexChecker.shippedCounts, chromeVersion: regexChecker.chromeVersion };
}

async function releaseBrowser() {
    const { browser, probeDir } = regexChecker;
    regexChecker.browser = null;
    regexChecker.worker = null;
    regexChecker.probeDir = null;
    if ( browser !== null ) {
        await browser.close().catch(err => console.error(`[regex-support] closing Chrome failed: ${err.message}`));
    }
    if ( probeDir !== null ) { await fs.rm(probeDir, { recursive: true, force: true }); }
}

/******************************************************************************/
// Chrome (lazily started, only for regexes without a cached verdict)
/******************************************************************************/

function findChromeExecutable() {
    const fromEnv = process.env[REGEX_SUPPORT_CONFIG.CHROME_PATH_ENV];
    if ( fromEnv ) { return existsSync(fromEnv) ? fromEnv : null; }
    return REGEX_SUPPORT_CONFIG.CHROME_PATH_CANDIDATES.find(p => existsSync(p)) ?? null;
}

// Starts headless Chrome with a minimal probe extension. Returns true when a worker is ready; otherwise
// records why not (NO_BROWSER) and returns false — never throws, the caller drops what it cannot verify.
async function startBrowser() {
    if ( regexChecker.phase === PHASES.BROWSER ) { return true; }
    if ( regexChecker.phase === PHASES.NO_BROWSER ) { return false; }
    const executablePath = findChromeExecutable();
    if ( executablePath === null ) {
        return markNoBrowser(`no Chrome found (set ${REGEX_SUPPORT_CONFIG.CHROME_PATH_ENV})`);
    }
    let puppeteer;
    try { puppeteer = (await import('puppeteer-core')).default; }
    catch { return markNoBrowser('puppeteer-core is not installed (npm install in tools/)'); }
    try {
        regexChecker.probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'regex-probe-'));
        await fs.writeFile(path.join(regexChecker.probeDir, 'manifest.json'), JSON.stringify({
            manifest_version: 3, name: 'regex-support-probe', version: '1',
            permissions: [ 'declarativeNetRequest' ], background: { service_worker: 'sw.js' },
        }));
        await fs.writeFile(path.join(regexChecker.probeDir, 'sw.js'), '// probe: the build calls isRegexSupported() here\n');
        regexChecker.browser = await puppeteer.launch({
            executablePath, headless: true, pipe: true, enableExtensions: [ regexChecker.probeDir ],
            args: [ '--no-sandbox', '--no-first-run' ],
        });
        const target = await regexChecker.browser.waitForTarget(t => t.type() === 'service_worker', { timeout: REGEX_SUPPORT_CONFIG.WORKER_WAIT_MS });
        regexChecker.worker = await target.worker();
        regexChecker.chromeVersion = (await regexChecker.browser.version()).replace(/^HeadlessChrome\//, '');
        regexChecker.phase = PHASES.BROWSER;
        console.log(`  [regex-support] asking Chrome ${regexChecker.chromeVersion} (${executablePath})`);
        return true;
    } catch (err) {
        await releaseBrowser();
        return markNoBrowser(`Chrome did not start: ${err.message}`);
    }
}

function markNoBrowser(reason) {
    regexChecker.phase = PHASES.NO_BROWSER;
    regexChecker.noBrowserReason = reason;
    console.log(`  [regex-support] ${reason} — regex rules without a cached verdict are dropped`);
    return false;
}

// Asks Chrome about every { regex, caseSensitive } not in the cache; stores the verdicts.
async function verifyUnknown(items) {
    if ( items.length === 0 || await startBrowser() === false ) { return; }
    for ( let i = 0; i < items.length; i += REGEX_SUPPORT_CONFIG.VERDICT_BATCH_SIZE ) {
        const batch = items.slice(i, i + REGEX_SUPPORT_CONFIG.VERDICT_BATCH_SIZE);
        const results = await regexChecker.worker.evaluate(async list => {
            const out = [];
            for ( const { regex, caseSensitive } of list ) {
                out.push(await globalThis.chrome.declarativeNetRequest.isRegexSupported(   // runs IN the probe's worker
                    { regex, isCaseSensitive: caseSensitive }));
            }
            return out;
        }, batch);
        batch.forEach(({ regex, caseSensitive }, j) => {
            const r = results[j] ?? {};
            regexChecker.verdicts.set(verdictKey(regex, caseSensitive), {
                supported: r.isSupported === true,
                ...(r.isSupported === true ? {} : { reason: r.reason ?? 'unknown' }),
                chrome: regexChecker.chromeVersion,
            });
        });
        regexChecker.dirty = true;
    }
}

/******************************************************************************/
// Filtering and counting
/******************************************************************************/

// Returns the rules to keep: every rule without a regexFilter, and every regex rule Chrome accepted. Each
// dropped regex rule is recorded (report + end-of-build notice).
export async function filterSupportedRegexRules(rules, owner) {
    if ( regexChecker.phase === PHASES.IDLE || regexChecker.phase === PHASES.CLOSED ) {
        throw new Error('regex-support: filterSupportedRegexRules() before openRegexSupport()');
    }
    const regexRules = rules.filter(r => typeof r.condition?.regexFilter === 'string');
    if ( regexRules.length === 0 ) { return rules; }
    const unknown = new Map();
    for ( const r of regexRules ) {
        const caseSensitive = r.condition.isUrlFilterCaseSensitive === true;
        const key = verdictKey(r.condition.regexFilter, caseSensitive);
        if ( regexChecker.verdicts.has(key) === false ) { unknown.set(key, { regex: r.condition.regexFilter, caseSensitive }); }
    }
    await verifyUnknown([ ...unknown.values() ]);
    return rules.filter(r => {
        if ( typeof r.condition?.regexFilter !== 'string' ) { return true; }
        const caseSensitive = r.condition.isUrlFilterCaseSensitive === true;
        const verdict = regexChecker.verdicts.get(verdictKey(r.condition.regexFilter, caseSensitive));
        if ( verdict?.supported === true ) { return true; }
        regexChecker.dropped.push({
            owner, regex: r.condition.regexFilter, caseSensitive,
            reason: verdict === undefined ? REGEX_SUPPORT_CONFIG.REASON_NOT_VERIFIED : `Chrome: ${verdict.reason}`,
        });
        return false;
    });
}

// Per written ruleset file: records its regex-rule count; above Chrome's cap the build stops (Chrome would
// silently ignore the excess). Returns the count.
export function noteShippedRegexRules(rulesetId, rules) {
    const count = rules.reduce((n, r) => (typeof r.condition?.regexFilter === 'string' ? n + 1 : n), 0);
    if ( count > MAX_NUMBER_OF_REGEX_RULES ) {
        throw new Error(`${rulesetId}: ${count} regex rules — above Chrome's ${MAX_NUMBER_OF_REGEX_RULES} per static ruleset`);
    }
    if ( count !== 0 ) { regexChecker.shippedCounts.push({ rulesetId, count }); }
    return count;
}
