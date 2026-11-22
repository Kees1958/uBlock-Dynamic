// tools/test-error-reporting.mjs — principle C5 / C42 (10.7.6).
//
// Proves, against the REAL modules (only the browser APIs are mocked):
//   A. js/data/expected-errors.js — each declared expected class matches the browser's real error text,
//      expected errors are not logged, every other error IS logged, and the caller's fallback is returned.
//   B. js/core/compiled-filters.js — a failed ABP-import compile is REPORTED as { ok: false, error }
//      instead of being swallowed (the dashboard shows it), and a THROWN failure does not poison the
//      pendingRegister chain: the next updateCompiledFilters() call still runs.
//
// Fault-verified (C42): run against the pre-10.7.6 compiled-filters.js, part B fails.
// Usage: node tools/test-error-reporting.mjs [extensionRoot]   (default: this repository)
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));
// The ABP-import text the mocked storage holds, so the compile path is actually taken.
const SANDBOX_TEXT = '||ads.example^';

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : ` — ${detail}`}`);
    if ( !ok ) { failures += 1; }
}

// ── console.warn capture (released at the end, B10) ────────────────────────────
const originalWarn = console.warn;
const warnings = [];
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
function takeWarnings() { return warnings.splice(0, warnings.length); }

// ── Browser mock: storage, runtime messaging, offscreen, DNR ───────────────────
const store = { sandboxFilters: SANDBOX_TEXT };
const mockState = { offscreenFailure: 'Only a single offscreen document may be created.', storageThrows: false };
global.chrome = {
    storage: {
        local: {
            get: key => mockState.storageThrows
                ? Promise.reject(new Error('IO error: storage unavailable'))
                : Promise.resolve(typeof key === 'string' ? { [key]: store[key] } : { ...store }),
            set: obj => { Object.assign(store, obj); return Promise.resolve(); },
            remove: keys => { for ( const k of [].concat(keys) ) { delete store[k]; } return Promise.resolve(); },
        },
        session: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve(),
            remove: () => Promise.resolve(),
        },
    },
    runtime: {
        id: 'test',
        getURL: p => `chrome-extension://test/${p}`,
        onMessage: { addListener() {}, removeListener() {} },
    },
    offscreen: {
        createDocument: () => Promise.reject(new Error(mockState.offscreenFailure)),
        closeDocument: () => Promise.resolve(),
    },
    declarativeNetRequest: {
        ResourceType: { MAIN_FRAME: 'main_frame' },
        getDynamicRules: () => Promise.resolve([]),
        getSessionRules: () => Promise.resolve([]),
        updateDynamicRules: () => Promise.resolve(),
        updateSessionRules: () => Promise.resolve(),
    },
};
global.browser = global.chrome;
global.self = global;

try {
    // ── A. expected-errors.js ──────────────────────────────────────────────────
    const { EXPECTED_ERRORS, isExpectedError, catchExpected } =
        await import(pathToFileURL(path.join(ROOT, 'js/data/expected-errors.js')).href);
    const REAL_MESSAGES = [
        [ 'TAB_GONE', 'No tab with id: 1234.' ],
        [ 'TAB_GONE', 'No window with id: 7.' ],
        [ 'TAB_GONE', 'Invalid tab ID: 1234' ],
        [ 'SCRIPT_NOT_REGISTERED', "Nonexistent script ID 'ubol-cosmetic-1'" ],
        [ 'NO_RECEIVER', 'Could not establish connection. Receiving end does not exist.' ],
        [ 'NOT_SCRIPTABLE', 'Cannot access a chrome:// URL' ],
        [ 'NOT_SCRIPTABLE', 'Frame with ID 0 is showing error page' ],
    ];
    for ( const [ cls, message ] of REAL_MESSAGES ) {
        check(`A: "${message}" is ${cls}`, isExpectedError(new Error(message), [ EXPECTED_ERRORS[cls] ]));
    }
    check('A: an unrelated error is not expected',
        isExpectedError(new Error('QUOTA_BYTES quota exceeded'), Object.values(EXPECTED_ERRORS)) === false);

    takeWarnings();
    const expectedResult = catchExpected('reload tab', [ EXPECTED_ERRORS.TAB_GONE ], 'fallback')(new Error('No tab with id: 5.'));
    check('A: an expected error returns the fallback', expectedResult === 'fallback');
    check('A: an expected error is NOT logged', takeWarnings().length === 0);
    const unexpectedResult = catchExpected('reload tab', [ EXPECTED_ERRORS.TAB_GONE ], null)(new Error('Permission denied'));
    const logged = takeWarnings();
    check('A: an unexpected error returns the fallback', unexpectedResult === null);
    check('A: an unexpected error IS logged, with its context', logged.length === 1 && logged[0].includes('reload tab') && logged[0].includes('Permission denied'), JSON.stringify(logged));

    // ── B. compiled-filters.js — reported, and the chain survives a throw ──────
    const { updateCompiledFilters } =
        await import(pathToFileURL(path.join(ROOT, 'js/core/compiled-filters.js')).href);

    takeWarnings();
    const failed = await updateCompiledFilters();
    check('B: a failed compile is reported as { ok: false }', failed?.ok === false, JSON.stringify(failed));
    check('B: the report carries the reason', typeof failed?.error === 'string' && failed.error.includes('offscreen'), JSON.stringify(failed));
    check('B: the failure is logged', takeWarnings().some(w => w.includes('ABP import')));

    mockState.storageThrows = true;          // update() itself throws (outside parseRawFilters' own try)
    const thrown = await updateCompiledFilters().catch(reason => ({ rejected: String(reason) }));
    mockState.storageThrows = false;
    check('B: a thrown failure is reported, not rejected', thrown?.ok === false, JSON.stringify(thrown));

    // The chain guard: after the throw above, the next call must still run (and fail the normal way).
    mockState.offscreenFailure = 'second call ran';
    const next = await updateCompiledFilters().catch(reason => ({ rejected: String(reason) }));
    check('B: the next call still runs after a thrown failure (chain not poisoned)',
        next?.ok === false && String(next.error).includes('second call ran'), JSON.stringify(next));
} catch (err) {
    console.log(`DID NOT RUN: ${err.stack ?? err}`);
    console.log('A check that did not run has not passed.');
    failures += 1;
} finally {
    console.warn = originalWarn;   // release the capture (B10)
}

if ( failures > 0 ) {
    console.log(`\n${failures} assertion(s) FAILED.`);
    process.exit(1);
}
console.log('\nPASS: expected errors are dropped, all others logged; compile failures are reported and never poison the chain.');
