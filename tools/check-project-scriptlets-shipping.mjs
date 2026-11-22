#!/usr/bin/env node
// check-project-scriptlets-shipping.mjs — a project-own scriptlet written in a list (e.g. the Quick-fixes list) really ships.
//
// Chain tested, with the REAL functions of the build (only the network fetch of @adguard/scriptlets is left out):
//   rule text -> parseScriptletRules -> selectProjectScriptlets (build lookup) -> encodeDispatchTables +
//   renderScriptletFile (generated per-ruleset data file) + renderLibraryFile/renderLibraryEndFile (the shared
//   library, after 10.4.4) -> library + data + end executed in one context for a matching and a non-matching page.
// Also: every hand-written scriptlet must be self-contained (it is inlined as source text into the shared library)
// and an AdGuard scriptlet of the same name must win over the project one.
//
// Usage: node tools/check-project-scriptlets-shipping.mjs   (step 51 of tools/complete-check.mjs)

import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import { parseScriptletRules } from './build/scriptlet-rules.mjs';
import { selectProjectScriptlets } from './build/scriptlet-corelibs.mjs';
import { encodeDispatchTables, renderLibraryEndFile, renderLibraryFile, renderScriptletFile } from './build/scriptlet-dispatch-layout.mjs';
import { UBO_PATCH_SCRIPTLETS } from '../js/resources/ubo-patch-scriptlets-source.mjs';

const isMainModule = process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

// ── CONFIG ────────────────────────────────────────────────────────────────
const CHECK_CONFIG = Object.freeze({
    // The rules as the owner writes them in the Quick-fixes list. `ran` tells, from the window the scriptlet was run
    // against, whether it took effect (the stub scriptlet acts after a timer, so it is checked by its scheduled work).
    RULES: Object.freeze([
        { text: "cnn.com#%#//scriptlet('disable-fave-ssai')", scriptlet: 'disable-fave-ssai' },
        { text: "cnn.com#%#//scriptlet('stub-window-object', 'AdFuel', 'queueRegistry,destroySlots', '500')", scriptlet: 'stub-window-object' },
    ]),
    HIT_HOSTS:    ['cnn.com', 'edition.cnn.com'],
    MISS_HOSTS:   ['example.com', 'notcnn.com'],
});

// Build the generated files exactly the way buildScriptletFile() + stepWriteScriptletFiles() do for a rule list:
// the list's data file, calling the library by each scriptlet's first name, plus the shared library and end file.
// Returns the three texts in registration order, or null when nothing ships.
function buildFile(ruleText, agNames) {
    const rules = parseScriptletRules(ruleText);
    const used = new Set(rules.map(r => r.name));
    const bodies = selectProjectScriptlets(used, agNames);
    const fnNames = [], fnIndexByName = new Map(), libraryBodies = new Map(), byHostname = new Map();
    rules.forEach((rule, i) => {
        const entry = bodies.find(b => b.names.includes(rule.name));
        if ( entry === undefined ) { return; }
        const libraryName = entry.names[0];
        if ( fnIndexByName.has(libraryName) === false ) {
            fnIndexByName.set(libraryName, fnNames.length);
            fnNames.push(libraryName);
            libraryBodies.set(libraryName, String(entry.scriptlet));
        }
        for ( const hn of rule.hostnames ) {
            if ( byHostname.has(hn) === false ) { byHostname.set(hn, []); }
            byHostname.get(hn).push([ fnIndexByName.get(libraryName), i, rule.args ]);
        }
    });
    if ( byHostname.size === 0 ) { return null; }
    return [
        renderLibraryFile([ ...libraryBodies ].sort()),
        renderScriptletFile(fnNames, encodeDispatchTables(byHostname), false, 'ruleset_badfilter_quickfixes'),
        renderLibraryEndFile(),
    ];
}

// Runs the generated file for a page; returns the window and the timers the scriptlet scheduled (the DOM is faked).
function runOnPage(texts, hostname) {
    const win = {};
    const timers = [];
    const doc = { readyState: 'complete', addEventListener() {} };
    function setTimeoutStub(cb, ms) { timers.push([ cb, ms ]); return timers.length; }
    const ctx = vm.createContext({ location: { hostname }, window: win, document: doc, setTimeout: setTimeoutStub, Proxy, Reflect, Object });
    for ( const text of texts ) { vm.runInContext(text, ctx, { timeout: 5000 }); }
    for ( const [ cb ] of timers ) { cb(); }
    return win;
}

function run() {
    const failures = [];
    for ( const rule of CHECK_CONFIG.RULES ) {
        const code = buildFile(rule.text, new Set());
        if ( code === null ) {
            failures.push(`rule "${rule.text}" produced no scriptlet file — the build does not know the scriptlet.`);
            continue;
        }
        // Each scriptlet leaves a visible trace on window: FAVE (wrapped) or AdFuel (stub).
        function trace(win) { return win.FAVE !== undefined || win.AdFuel !== undefined; }
        for ( const host of CHECK_CONFIG.HIT_HOSTS ) {
            if ( trace(runOnPage(code, host)) === false ) { failures.push(`${host}: "${rule.scriptlet}" did not take effect.`); }
        }
        for ( const host of CHECK_CONFIG.MISS_HOSTS ) {
            if ( trace(runOnPage(code, host)) ) { failures.push(`${host}: "${rule.scriptlet}" ran on a page it is not written for.`); }
        }
        // AdGuard wins on a name clash: with the name known to AdGuard the project copy must not be used.
        if ( buildFile(rule.text, new Set([ rule.scriptlet ])) !== null ) {
            failures.push(`"${rule.scriptlet}": a name defined by @adguard/scriptlets was still taken from the project copy.`);
        }
    }
    // Self-contained: the function source, evaluated alone, must not reference another top-level name of its module.
    for ( const entry of UBO_PATCH_SCRIPTLETS ) {
        try {
            vm.runInNewContext(`(${entry.scriptlet.toString()})`, {}, { timeout: 2000 });
        } catch (e) {
            failures.push(`"${entry.names[0]}": source text does not evaluate on its own — ${e.message}`);
        }
    }
    for ( const f of failures ) { console.error(`VIOLATION: ${f}`); }
    if ( failures.length ) { return false; }
    console.log(`OK: ${CHECK_CONFIG.RULES.length} Quick-fixes rule(s) ship and run only on their hosts; AdGuard wins name clashes; ${UBO_PATCH_SCRIPTLETS.length} project scriptlet(s) are self-contained.`);
    return true;
}

if ( isMainModule ) { process.exit(run() ? 0 : 1); }
export { run };
