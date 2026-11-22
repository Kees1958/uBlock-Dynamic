#!/usr/bin/env node
// tools/test-session-deadline.mjs — (10.7.6) js/core/session-deadline.js: the deadline of a timed panel session
// (Fingerprint Inspector, Matrix panel) is a chrome.alarms alarm, so it survives the service worker sleeping
// (audit 10.7.5, D-1). Replaces tools/test-session-watchdog.mjs (the 10.5.0 setInterval watchdog it retired).
//
// Behaviour on the real helper with a fake alarms API (C42): arm sets the alarm at the deadline, disarm clears it,
// the alarm ends an expired session, re-arms an early one, ignores a paused one and other alarm names; boot
// reconcile re-arms a running session and releases left-overs when there is none.
// Wiring (both modules + background.js): start/resume arm, stop/pause disarm, one routed onAlarm listener, no
// setInterval watchdog left.
// Usage: node tools/test-session-deadline.mjs        Outcomes (C38): PASS / FAIL / DID NOT RUN.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const TIMEOUT_MS = 5 * 60 * 1000;
const CLOCK_SLACK_MS = 1000;   // tolerance for "when" computed from Date.now() in two places

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
    if ( !ok ) { failures += 1; }
}

function makeFakeAlarms() {
    const alarms = new Map();
    return {
        alarms,
        create: (name, info) => { alarms.set(name, info); return Promise.resolve(); },
        clear: name => Promise.resolve(alarms.delete(name)),
    };
}

// The text of one exported function (up to its closing brace at column 0).
function functionBody(src, signature) {
    const at = src.indexOf(signature);
    return at === -1 ? '' : src.slice(at, src.indexOf('\n}\n', at));
}

async function main() {
    const { createSessionDeadline } = await import(pathToFileURL(path.join(ROOT, 'js/core/session-deadline.js')).href);

    console.log('── Behaviour ──');
    const fake = makeFakeAlarms();
    let session = null;
    let timeouts = 0;
    let orphanReleases = 0;
    const deadline = createSessionDeadline({
        alarms: fake, alarmName: 'testDeadline', timeoutMs: TIMEOUT_MS,
        ensureHydrated: async ( ) => {}, getSession: () => session,
        onTimeout: async ( ) => { timeouts += 1; session = null; },
        releaseOrphans: async ( ) => { orphanReleases += 1; },
    });

    await deadline.arm(TIMEOUT_MS);
    const when = fake.alarms.get('testDeadline')?.when ?? 0;
    check('arm() sets the alarm at the deadline', Math.abs(when - (Date.now() + TIMEOUT_MS)) < CLOCK_SLACK_MS, String(when));
    await deadline.disarm();
    check('disarm() clears it', fake.alarms.has('testDeadline') === false);

    check('another alarm name is not handled', await deadline.handleAlarm('deferredJobs') === false);

    session = { phase: 'running', startTime: Date.now() - TIMEOUT_MS - 1, timeElapsed: 0 };
    check('its own alarm is handled', await deadline.handleAlarm('testDeadline') === true);
    check('an expired running session ends (timeout)', timeouts === 1 && session === null);

    session = { phase: 'running', startTime: Date.now() - 60_000, timeElapsed: 0 };
    await deadline.handleAlarm('testDeadline');
    const reWhen = fake.alarms.get('testDeadline')?.when ?? 0;
    check('an early alarm re-arms for the rest (no early end)', timeouts === 1
        && Math.abs(reWhen - (Date.now() + TIMEOUT_MS - 60_000)) < CLOCK_SLACK_MS, String(reWhen));

    await deadline.disarm();
    session = { phase: 'paused', startTime: null, timeElapsed: 120_000 };
    await deadline.handleAlarm('testDeadline');
    check('a paused session is left alone', timeouts === 1 && fake.alarms.has('testDeadline') === false);

    session = { phase: 'running', startTime: Date.now() - 120_000, timeElapsed: 30_000 };
    await deadline.reconcile();
    const recWhen = fake.alarms.get('testDeadline')?.when ?? 0;
    check('boot reconcile re-arms a running session for its remaining time',
        Math.abs(recWhen - (Date.now() + TIMEOUT_MS - 150_000)) < CLOCK_SLACK_MS, String(recWhen));

    session = null;
    await deadline.reconcile();
    check('boot reconcile with no session clears the alarm and releases left-overs',
        fake.alarms.has('testDeadline') === false && orphanReleases === 1);

    let threw = false;
    try { createSessionDeadline({ alarms: null, alarmName: 'x' }); } catch { threw = true; }
    check('missing alarms API is refused at creation', threw);

    console.log('\n── Wiring ──');
    const MODULES = {
        'js/core/privacy-inspector.js': { start: 'export async function startPrivacyInspector', stop: 'export async function stopPrivacyInspector',
            pause: 'export async function pausePrivacyInspector', resume: 'export async function resumePrivacyInspector' },
        'js/core/matrix-panel.js': { start: 'export async function startMatrix', stop: 'export async function stopMatrix' },
    };
    for ( const [ file, fns ] of Object.entries(MODULES) ) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        check(`${file}: uses createSessionDeadline with browser.alarms`, /createSessionDeadline\(\{[\s\S]*?alarms: browser\.alarms/.test(src));
        check(`${file}: no setInterval watchdog left`, !/setInterval\(|createSessionWatchdog/.test(src));
        check(`${file}: start arms the alarm`, /deadline\.arm\(/.test(functionBody(src, fns.start)));
        check(`${file}: stop disarms the alarm`, /deadline\.disarm\(\)/.test(functionBody(src, fns.stop)));
        if ( fns.pause ) {
            check(`${file}: pause disarms the alarm`, /deadline\.disarm\(\)/.test(functionBody(src, fns.pause)));
            check(`${file}: resume arms the alarm`, /deadline\.arm\(/.test(functionBody(src, fns.resume)));
        }
    }
    const bg = fs.readFileSync(path.join(ROOT, 'js/workflow/background.js'), 'utf8');
    check('background.js: exactly one onAlarm listener', (bg.match(/alarms\.onAlarm\.addListener/g) ?? []).length === 1);
    check('background.js: routes both deadline alarms', /handlePrivacyInspectorDeadlineAlarm\(alarm\.name\)/.test(bg) && /handleMatrixDeadlineAlarm\(alarm\.name\)/.test(bg));
    check('background.js: reconciles both deadlines at boot', /reconcilePrivacyInspectorDeadline\(\)/.test(bg) && /reconcileMatrixDeadline\(\)/.test(bg));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    check('manifest: "alarms" permission declared', manifest.permissions?.includes('alarms'));

    console.log(failures === 0 ? '\nPASS' : `\n${failures} assertion(s) failed.`);
    process.exit(failures === 0 ? EXIT_PASS : EXIT_FAIL);
}

main().catch(err => {
    console.error('DID NOT RUN: test-session-deadline —', err);
    process.exit(EXIT_FAIL);
});
