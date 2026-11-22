#!/usr/bin/env node
// check-cosmetic-exception-logic.mjs — pins the behavior of the cosmetic
// (element-hiding) EXCEPTION feature (`hostname#@#selector`, added in
// js/core/filter-manager.js, in parity with the scriptlet exception
// feature — see check-scriptlet-exception-logic.mjs) against the real,
// live implementation.
//
// Unlike the scriptlet check, this one can't import internal functions
// directly (buildFilterIndex()/collectMatchingFilterEntries() aren't
// exported, and exporting them test-only would mean threading a second
// export convention into a file that doesn't already have one) — instead
// it drives the REAL public API end to end: setSandboxFilters() to author
// rules, then injectCustomFilters() (with browser.scripting mocked to
// capture the CSS it would have injected) to observe the actual
// cancellation output, and registerCustomFilters() to check the
// documented own-level-only registration-eligibility simplification.
// Slower than a pure unit test, but never at risk of testing a
// reimplementation that's drifted from the real code — there's only one
// implementation here at all.
//
// Usage: node tools/check-cosmetic-exception-logic.mjs   (also runs as
// step 15 of `npm run check` / tools/complete-check.mjs)

import assert from 'assert';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Minimal global mock — same shape as check-scriptlet-exception-logic.mjs's
// own mock, extended with browser.scripting (captured below per-call
// rather than here, since each test needs its own capture variable).
const store = {};
global.chrome = {
    storage: {
        local: {
            get: (key) => Promise.resolve(typeof key === 'string' ? { [key]: store[key] } : { ...store }),
            set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
            remove: (keys) => { for ( const k of [].concat(keys) ) { delete store[k]; } return Promise.resolve(); },
        },
    },
    runtime: { getURL: p => `chrome-extension://test/${p}` },
};
global.browser = global.chrome;
global.self = global;

const fm = await import(`${ROOT}/js/core/filter-manager.js?t=${Date.now()}`);

let failures = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log(`  PASS: ${name}`);
    } catch (err) {
        failures++;
        console.log(`  FAIL: ${name}`);
        console.log(`    ${err.stack ?? err.message}`);
    }
}

function section(name) { console.log(`\n── ${name} `.padEnd(70, '─')); }

async function injectedCSSFor(hostname) {
    let captured = null;
    global.browser.scripting = {
        insertCSS: (opts) => { captured = opts.css; return Promise.resolve(); },
        executeScript: () => Promise.resolve(),
    };
    await fm.injectCustomFilters(1, 0, hostname);
    return captured;
}

/******************************************************************************/
section('Cosmetic exception cancellation, via the real injectCustomFilters() path');
/******************************************************************************/

await check('same-level exception cancels a same-level apply selector', async () => {
    await fm.setSandboxFilters([
        'example.com##.ad-banner',
        'example.com#@#.ad-banner',
    ].join('\n'));
    assert.strictEqual(await injectedCSSFor('example.com'), null);
});

await check('broader exception cancels an inherited subdomain apply selector', async () => {
    await fm.setSandboxFilters([
        'example.com##.ad-banner',
        'sub.example.com#@#.ad-banner',
    ].join('\n'));
    assert.strictEqual(await injectedCSSFor('sub.example.com'), null);
});

await check('exception at a subdomain does not cancel the parent domain\'s own apply selector', async () => {
    await fm.setSandboxFilters([
        'example.com##.ad-banner',
        'sub.example.com#@#.ad-banner',
    ].join('\n'));
    const css = await injectedCSSFor('example.com');
    assert.ok(css && css.includes('.ad-banner'));
});

await check('exception scoped to one subdomain does not leak to an unrelated sibling', async () => {
    await fm.setSandboxFilters([
        'example.com##.ad-banner',
        'sub.example.com#@#.ad-banner',
    ].join('\n'));
    const css = await injectedCSSFor('other-sub.example.com');
    assert.ok(css && css.includes('.ad-banner'));
});

await check('different selector text does not cancel', async () => {
    await fm.setSandboxFilters([
        'example.com##.ad-banner',
        'example.com#@#.other-banner',
    ].join('\n'));
    const css = await injectedCSSFor('example.com');
    assert.ok(css && css.includes('.ad-banner'));
});

await check('no exception present at all — apply selector survives untouched', async () => {
    await fm.setSandboxFilters('example.com##.ad-banner');
    const css = await injectedCSSFor('example.com');
    assert.ok(css && css.includes('.ad-banner'));
});

await check('an exception with no matching apply selector is simply a no-op', async () => {
    await fm.setSandboxFilters('example.com#@#.nonexistent');
    assert.strictEqual(await injectedCSSFor('example.com'), null);
});

await check('multiple apply selectors — only the one an exception targets is cancelled', async () => {
    await fm.setSandboxFilters([
        'example.com##.ad-banner',
        'example.com##.popup',
        'example.com#@#.ad-banner',
    ].join('\n'));
    const css = await injectedCSSFor('example.com');
    assert.ok(css && !css.includes('.ad-banner') && css.includes('.popup'));
});

await check('procedural selectors ({...}) also support exception cancellation', async () => {
    await fm.setSandboxFilters([
        String.raw`example.com##{"selector":".ad"}`,
        String.raw`example.com#@#{"selector":".ad"}`,
    ].join('\n'));
    // Procedural selectors go through executeScript, not insertCSS — capture
    // whether executeScript (the procedural path) is even invoked at all.
    let executeScriptCalled = false;
    global.browser.scripting = {
        insertCSS: () => Promise.resolve(),
        executeScript: () => { executeScriptCalled = true; return Promise.resolve(); },
    };
    await fm.injectCustomFilters(1, 0, 'example.com');
    assert.strictEqual(executeScriptCalled, false, 'no procedural selectors should remain to inject');
});

await check('a picker/import-sourced (site.* storage) apply selector can be cancelled by a sandbox exception', async () => {
    await fm.setSandboxFilters(''); // clear sandbox text first
    await fm.addCustomFilters('example.com', [ '.picker-picked-this' ]);
    await fm.setSandboxFilters('example.com#@#.picker-picked-this');
    assert.strictEqual(await injectedCSSFor('example.com'), null);
    // cleanup for subsequent checks in this file
    await fm.clearAllCustomFilters();
    await fm.setSandboxFilters('');
});

/******************************************************************************/
section('registerCustomFilters() eligibility — documented own-level-only simplification');
/******************************************************************************/

await check('a hostname whose ONLY apply selector is inherited (not own-level) is not registered, even if a same-level exception exists', async () => {
    await fm.setSandboxFilters([
        'example.com##.ad-banner',
        'sub.example.com#@#.ad-banner',
    ].join('\n'));
    const context = { filteringModeDetails: { none: new Set(), basic: new Set([ 'all-urls' ]) }, toAdd: [] };
    await fm.registerCustomFilters(context);
    const matches = context.toAdd[0]?.matches ?? [];
    assert.ok(!matches.some(m => m.includes('sub.example.com')));
    assert.ok(matches.some(m => m.includes('example.com') && !m.includes('sub.')));
});

/******************************************************************************/
console.log('');
if ( failures > 0 ) {
    console.log(`${failures} cosmetic-exception-logic check(s) FAILED.`);
    process.exit(1);
}
console.log('All cosmetic-exception-logic checks passed.');
