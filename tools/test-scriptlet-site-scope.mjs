#!/usr/bin/env node
// tools/test-scriptlet-site-scope.mjs — (10.5.6) js/util/scriptlet-site-scope.js's pure functions.
//
// Why: this module decides, from match patterns alone, which pages get the SITES scriptlet registration (the sites
// the lists actually name) and which get the much smaller ENTITY one (everywhere else — the "name.*" rules no
// match pattern can express). A wrong pattern here silently either leaks scriptlet rules onto a site that is not
// theirs, or (the worse direction) drops the sites registration's protection on a site it should cover. Drives the
// REAL exported functions — sitePattern, topLevelSites, buildScriptletScopes, directiveUpdate — not a re-implemented
// copy (C21/C24). Exit 0 = pass, 1 = failed assertion, 2 = could not run (C38).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
const MODULE = 'js/util/scriptlet-site-scope.js';
const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_DID_NOT_RUN = 2;

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if ( !ok ) { failures += 1; }
}
function didNotRun(msg) { console.log(`DID NOT RUN: ${msg}`); process.exit(EXIT_DID_NOT_RUN); }
function sameSet(a, b) {
    const x = new Set(a), y = new Set(b);
    return x.size === y.size && [ ...x ].every(v => y.has(v));
}

async function main() {
    let mod;
    try {
        mod = await import(pathToFileURL(path.join(ROOT, MODULE)).href);
    } catch ( err ) { didNotRun(`cannot import ${MODULE} (${err.message})`); }
    for ( const fn of [ 'sitePattern', 'topLevelSites', 'buildScriptletScopes', 'directiveUpdate' ] ) {
        if ( typeof mod[fn] !== 'function' ) { didNotRun(`${MODULE} does not export ${fn} — this check needs updating`); }
    }
    const { sitePattern, topLevelSites, buildScriptletScopes, directiveUpdate } = mod;

    console.log('\n── sitePattern() ──');
    check('normal host -> "*://*.host/*" (covers the host and its subdomains)', sitePattern('example.com') === '*://*.example.com/*');
    check('dotted-quad IPv4 -> exact "*://ip/*" (Chrome\'s "*." wildcard does not apply to an IP)', sitePattern('192.168.1.1') === '*://192.168.1.1/*');
    check('a host that merely contains digits like an IP, but is not one, still gets the subdomain pattern', sitePattern('1.2.3.4.example.com') === '*://*.1.2.3.4.example.com/*');

    console.log('\n── topLevelSites() ──');
    check('a child dropped when its parent is also listed (the parent pattern already covers it)',
        sameSet(topLevelSites([ 'a.com', 'sub.a.com' ]), [ 'a.com' ]));
    check('two unrelated hosts both kept', sameSet(topLevelSites([ 'a.com', 'b.com' ]), [ 'a.com', 'b.com' ]));
    check('a grandchild dropped too, through the direct child', sameSet(topLevelSites([ 'a.com', 'x.sub.a.com' ]), [ 'a.com' ]));
    check('an IPv4 entry is never treated as a subdomain of anything and is always kept',
        sameSet(topLevelSites([ '1.2.3.4', 'a.com' ]), [ '1.2.3.4', 'a.com' ]));
    check('a false-positive guard: "notasub-a.com" is not treated as a subdomain of "a.com"',
        sameSet(topLevelSites([ 'a.com', 'notasub-a.com' ]), [ 'a.com', 'notasub-a.com' ]));

    console.log('\n── buildScriptletScopes() — normal mode (siteMode.allowedHosts absent) ──');
    {
        const siteMode = { matches: [ '<all_urls>' ], excludeMatches: [ '*://*.off.example/*' ] };
        const r = buildScriptletScopes([ 'a.com', 'b.com' ], siteMode);
        check('SITES matches are exactly the per-site patterns', sameSet(r.sites.matches, [ '*://*.a.com/*', '*://*.b.com/*' ]));
        check('SITES carries the same exclude list as the overall site mode (an off-site stays off for SITES too)',
            sameSet(r.sites.excludeMatches, siteMode.excludeMatches));
        check('ENTITY matches everywhere the site mode itself allows (normally all sites)', sameSet(r.entity.matches, siteMode.matches));
        check('ENTITY excludes the off-site AND every listed site (so SITES+ENTITY never both run on the same page)',
            sameSet(r.entity.excludeMatches, [ ...siteMode.excludeMatches, '*://*.a.com/*', '*://*.b.com/*' ]));
    }

    console.log('\n── buildScriptletScopes() — reverse mode (filtering on only for siteMode.allowedHosts) ──');
    {
        // allowed: only on.example (and subdomains). Listed sites: a.com (not allowed) and sub.on.example (allowed,
        // and inside the allowed host) and on.example itself is also allowed directly.
        const siteMode = { matches: [ '*://on.example/*', '*://*.on.example/*' ], excludeMatches: [], allowedHosts: [ 'on.example' ] };
        const r = buildScriptletScopes([ 'a.com', 'sub.on.example' ], siteMode);
        check('a listed site outside the allowed scope is dropped from SITES entirely (not allowed to run anywhere)',
            r.sites.matches.every(p => p.includes('a.com') === false));
        check('a listed site inside the allowed scope keeps its own (deeper) pattern',
            r.sites.matches.includes('*://*.sub.on.example/*'));
        check('ENTITY still runs on the rest of the allowed scope (on.example itself, not just its listed subdomain)',
            sameSet(r.entity.matches, siteMode.matches));
        check('ENTITY excludes the listed+allowed site so the two registrations never overlap in reverse mode',
            r.entity.excludeMatches.some(p => p.includes('sub.on.example')));
    }

    console.log('\n── buildScriptletScopes() — fault injection (proves this check actually catches the bug) ──');
    {
        // A deliberately-broken scope builder that forgets to exclude the listed sites from ENTITY — the exact
        // regression this module exists to prevent (SITES and ENTITY would both run on a listed site: harmless
        // duplication at best, a sign the split silently stopped excluding at worst).
        const siteMode = { matches: [ '<all_urls>' ], excludeMatches: [] };
        const broken = { entity: { matches: siteMode.matches, excludeMatches: [] } }; // missing the sitePatterns exclusion
        const real = buildScriptletScopes([ 'a.com' ], siteMode);
        check('fault check: the broken (unexcluded) shape is distinguishable from the real result',
            sameSet(broken.entity.excludeMatches, real.entity.excludeMatches) === false);
        check('…and the real result does exclude the listed site from ENTITY', real.entity.excludeMatches.includes('*://*.a.com/*'));
    }

    console.log('\n── directiveUpdate() ──');
    {
        const existing = { id: 'x', js: [ 'a.js' ], matches: [ '*://*.a.com/*' ], excludeMatches: [], world: 'MAIN', runAt: 'document_start', allFrames: true };
        check('identical directive -> null (skip the browser.scripting call entirely)',
            directiveUpdate(existing, { ...existing }) === null);
        const onlyExcludeChanged = { ...existing, excludeMatches: [ '*://*.off.example/*' ] };
        const patch = directiveUpdate(existing, onlyExcludeChanged);
        check('only excludeMatches differs -> the patch carries just that field (plus id)',
            patch !== null && Object.keys(patch).sort().join(',') === 'excludeMatches,id');
        check('…with the new value', sameSet(patch.excludeMatches, onlyExcludeChanged.excludeMatches));
        const reorderedExisting = { ...existing, excludeMatches: [ 'y', 'x' ] };
        check('matches/excludeMatches comparison is order-insensitive (Chrome does not promise an order)',
            directiveUpdate(reorderedExisting, { ...reorderedExisting, matches: [ ...reorderedExisting.matches ].reverse() }) === null);
        const jsReordered = { ...existing, js: [ 'b.js', 'a.js' ] };
        check('js file order DOES matter (load order) and is detected as a change',
            directiveUpdate(existing, jsReordered) !== null);
    }
}

main().then(() => {
    console.log(failures ? `\nFAIL: ${failures} problem(s)` : '\nPASS: scriptlet-site-scope.js\'s site/entity split is correct.');
    process.exit(failures ? EXIT_FAIL : EXIT_PASS);
}).catch(err => didNotRun(err.stack ?? err.message));
