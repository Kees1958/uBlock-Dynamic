// Dry-test: loads dashboard.html into a real JSDOM DOM, mocks the chrome
// extension APIs, then actually imports+executes custom-rules.js as a
// live ES module. This catches things static analysis (node --check,
// eslint) structurally cannot: a qs$() call against an id that doesn't
// exist in the actual HTML, a dom.on() registered against a selector
// with no matching element, or any other error thrown during the
// module's real top-level execution (which includes every qs$/dom.on
// call plus the onPaneChange()/updateDeleteAllButtonLabel() calls at the
// bottom of the file).
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');

function report(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
        return true;
    } catch (err) {
        console.log(`FAIL: ${name}`);
        console.log(`  ${err.stack ?? err}`);
        return false;
    }
}

let allPassed = true;

// ── 1. Parse dashboard.html structurally, confirm every element ID the
//      JS references actually exists in the markup ──────────────────────
allPassed &= report('dashboard.html: every ID referenced by custom-rules.js exists in the DOM', () => {
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/dashboard.html'), 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const js = fs.readFileSync(path.join(ROOT, 'dashboard/custom-rules.js'), 'utf8');
    const idRefs = new Set();
    for ( const m of js.matchAll(/qs\$\('#([\w-]+)'\)/g) ) { idRefs.add(m[1]); }
    for ( const m of js.matchAll(/dom\.on\('#([\w-]+)'/g) ) { idRefs.add(m[1]); }

    const missing = [ ...idRefs ].filter(id => !doc.getElementById(id));
    if ( missing.length > 0 ) {
        throw new Error(`IDs referenced in JS but missing from dashboard.html: ${missing.join(', ')}`);
    }
    console.log(`  (checked ${idRefs.size} distinct element IDs)`);
});

// ── 2. Same check for the Matrix panel ──────────────────────────────────
allPassed &= report('matrix-panel.html: every ID referenced by matrix-panel.js exists in the DOM', () => {
    const html = fs.readFileSync(path.join(ROOT, 'matrix/matrix-panel.html'), 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const js = fs.readFileSync(path.join(ROOT, 'matrix/matrix-panel.js'), 'utf8');
    const idRefs = new Set();
    for ( const m of js.matchAll(/qs\$\('#([\w-]+)'\)/g) ) { idRefs.add(m[1]); }

    const missing = [ ...idRefs ].filter(id => !doc.getElementById(id));
    if ( missing.length > 0 ) {
        throw new Error(`IDs referenced in JS but missing from matrix-panel.html: ${missing.join(', ')}`);
    }
    console.log(`  (checked ${idRefs.size} distinct element IDs)`);
});

// ── 3. Real CSS parser (jsdom/cssom), not brace-counting — catches things
//      like the unclosed-comment bug brace-counting was blind to ────────
allPassed &= report('custom-rules.css parses cleanly through a real CSS parser', () => {
    const css = fs.readFileSync(path.join(ROOT, 'dashboard/custom-rules.css'), 'utf8');
    const dom = new JSDOM(`<style>${css}</style>`);
    const sheet = dom.window.document.styleSheets[0];
    const ruleCount = sheet.cssRules.length;
    if ( ruleCount === 0 ) { throw new Error('parsed to zero rules — something is badly wrong'); }
    // Sanity check specific to the bug already found this session: confirm
    // the previously-swallowed #scriptletRulesList .scriptlet-api-label
    // rule is actually present as a real, parsed rule now.
    const selectors = [ ...sheet.cssRules ].map(r => r.selectorText).filter(Boolean);
    if ( !selectors.includes('#scriptletRulesList .scriptlet-api-label') ) {
        throw new Error('#scriptletRulesList .scriptlet-api-label rule not found by the real parser — regression of the unclosed-comment bug');
    }
    console.log(`  (parsed ${ruleCount} CSS rules, including the previously-swallowed .scriptlet-api-label rule)`);
});

allPassed &= report('matrix-panel.css parses cleanly through a real CSS parser', () => {
    const css = fs.readFileSync(path.join(ROOT, 'matrix/matrix-panel.css'), 'utf8');
    const dom = new JSDOM(`<style>${css}</style>`);
    const sheet = dom.window.document.styleSheets[0];
    const ruleCount = sheet.cssRules.length;
    if ( ruleCount === 0 ) { throw new Error('parsed to zero rules — something is badly wrong'); }
    console.log(`  (parsed ${ruleCount} CSS rules)`);
});

// ── 4. Actually EXECUTE custom-rules.js as a live ES module against the
//      real dashboard.html DOM, with chrome APIs mocked — this is the
//      real dry-run: it runs every qs$()/dom.on() call and the
//      onPaneChange()/updateDeleteAllButtonLabel() calls at the bottom of
//      the file for real, catching anything that would throw at load time
//      in an actual browser. ──────────────────────────────────────────
async function runDashboardModule() {
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/dashboard.html'), 'utf8');
    const dom = new JSDOM(html, { url: 'chrome-extension://test/dashboard/dashboard.html', runScripts: 'outside-only' });
    const { window } = dom;

    // Minimal chrome extension API mock — just enough surface for the
    // module's TOP-LEVEL execution (import-time side effects) to run
    // without throwing. Doesn't need to behave correctly, just needs to
    // exist and not throw when called.
    const storageData = {};
    const chromeMock = {
        runtime: {
            id: 'test-extension-id',
            getURL: p => `chrome-extension://test/${p}`,
            getManifest: () => ({ version: '0.0.0-test' }),
            sendMessage: (msg, cb) => { const p = Promise.resolve(undefined); if ( cb ) { p.then(cb); return; } return p; },
            onMessage: { addListener: () => {} },
            onInstalled: { addListener: () => {} },
            onStartup: { addListener: () => {} },
        },
        storage: {
            local: {
                get: (keys, cb) => { const r = {}; const p = Promise.resolve(r); if ( cb ) { p.then(cb); return; } return p; },
                set: (obj, cb) => { Object.assign(storageData, obj); const p = Promise.resolve(); if ( cb ) { p.then(cb); return; } return p; },
                remove: () => Promise.resolve(),
            },
            session: {
                get: () => Promise.resolve({}),
                set: () => Promise.resolve(),
            },
            onChanged: { addListener: () => {} },
        },
        i18n: { getMessage: k => k },
    };
    window.chrome = chromeMock;
    window.browser = chromeMock;

    // Inject jsdom's window/document/etc onto Node's actual global scope
    // — the module files reference these as bare globals (they're
    // written as ordinary browser page scripts), so Node's module loader
    // needs to see them as real globals, not just properties of a local
    // `window` variable.
    const keysToExpose = [
        'window', 'document', 'navigator', 'location', 'chrome', 'browser',
        'HTMLElement', 'Node', 'CustomEvent', 'Event', 'MutationObserver',
        'confirm', 'Blob', 'URL', 'FileReader',
        'Window', 'Document', 'Element',
    ];
    const previous = {};
    for ( const key of keysToExpose ) {
        previous[key] = global[key];
        if ( window[key] !== undefined ) {
            // Plain assignment (global[key] = ...) throws for a couple of
            // these — Node itself exposes some browser-like globals
            // (navigator, in particular) as read-only getters since
            // Node 21ish. defineProperty with configurable: true sets it
            // regardless, and still lets the restore loop below clean up
            // properly afterward.
            Object.defineProperty(global, key, { value: window[key], writable: true, configurable: true });
        }
    }
    global.self = window;

    try {
        const modUrl = pathToFileURL(path.join(ROOT, 'dashboard/custom-rules.js')).href + `?t=${Date.now()}`;
        await import(modUrl);
    } finally {
        for ( const key of keysToExpose ) {
            if ( previous[key] === undefined ) {
                delete global[key];
            } else {
                Object.defineProperty(global, key, { value: previous[key], writable: true, configurable: true });
            }
        }
        delete global.self;
    }

    // Spot-check: the module's own init calls should have run without
    // throwing, and left the DOM in the expected default state.
    const btn = window.document.getElementById('deleteAllCustomRules');
    if ( !btn ) { throw new Error('deleteAllCustomRules button not found after module execution'); }
    if ( btn.textContent !== 'Delete all rules' ) {
        throw new Error(`expected default button label "Delete all rules", got "${btn.textContent}"`);
    }
    const status = window.document.getElementById('customRulesToolbarStatus');
    if ( !status.hidden ) { throw new Error('status line should start hidden'); }
}

allPassed &= true; // placeholder removed below; real async check follows

// report() is sync-oriented; the module-execution check is async, so it
// gets its own small block rather than forcing report() into an awkward
// shape.
{
    let ok = true;
    try {
        await runDashboardModule();
        console.log('PASS: custom-rules.js executes as a live module against the real DOM without throwing');
    } catch (err) {
        ok = false;
        console.log('FAIL: custom-rules.js executes as a live module against the real DOM without throwing');
        console.log(`  ${err.stack ?? err}`);
    }
    allPassed = allPassed && ok;
}

console.log('');
console.log(allPassed ? 'ALL DRY-RUN CHECKS PASSED' : 'SOME DRY-RUN CHECKS FAILED');
process.exit(allPassed ? 0 : 1);
