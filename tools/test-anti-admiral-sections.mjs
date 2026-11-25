#!/usr/bin/env node
// test-anti-admiral-sections.mjs — (11.1.3) the Anti-Admiral list takes uBlock Origin's whole Admiral and Ad-Shield
// sections from uAssets' filters-general.txt (tools/build/anti-admiral.mjs).
//
// Checked with the REAL functions, on an in-memory fixture shaped like the upstream file (no network):
//   1. the "!#if" preprocessor is answered as uBO Lite on Chromium: the "!#else" branch of cap_html_filtering is
//      taken, an ext_ubol branch is taken, a Safari-only branch is not;
//   2. only lines BETWEEN the section markers are taken, comments and blank lines left out;
//   3. a missing section fails loudly (an upstream reorganisation must not ship an empty list silently);
//   4. the taken lines then pass the real trust gate: the Ad-Shield setAttribute shape becomes the safe project
//      scriptlet, another trusted scriptlet is dropped, an ordinary scriptlet is kept.
//
// Usage: node tools/test-anti-admiral-sections.mjs   (step 95 of tools/complete-check.mjs)
// Pure: builds its fixture in memory, keeps nothing.

import { pruneForUbol, selectUassetsSectionRules } from './build/anti-admiral.mjs';
import { applyScriptletTrustGate } from './build/fetch-helpers.mjs';
import { SCRIPTLET_POLICY } from '../js/data/scriptlet-policy.js';

// ── CONFIG ─────────────────────────────────────────────────────────────
const TEST_CONFIG = Object.freeze({
    SECTION:          'Ad-Shield',
    MISSING_SECTION:  'No-Such-Vendor',
    // Not an AdGuard Team URL, so rule A applies (the real source is uAssets on raw.githubusercontent.com).
    SOURCE_URL:       'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-general.txt',
    PATTERN:          "'/error-report|&&window,|adShieldError/'",
    FIXTURE_LINES: Object.freeze([
        '! outside any section',
        'outside.com##+js(rmnt, script, html-load)',
        '! SECTION: Ad-Shield',
        '! a comment inside',
        '',
        'html-filter-env.com##+js(ra, onerror, script[id][onerror], asap, quitAfter, 10)',
        '!#if cap_html_filtering',
        'html.com##^script[src*="html-load.com"]',
        '!#else',
        'mv3.com##+js(rmnt, script, /html-load\\.com/)',
        '!#endif',
        '!#if ext_ubol',
        'ubol.com##+js(set, adShield, false)',
        '!#endif',
        '!#if env_safari',
        'safari.com##+js(set, safariOnly, true)',
        '!#endif',
        "future.com##+js(trusted-replace-argument, Element.prototype.setAttribute, 1, , condition, '/error-report|&&window,|adShieldError/')",
        'insert.com##+js(trusted-replace-argument, document.getElementById, 0, json:"x", condition, y)',
        '! !SECTION: Ad-Shield',
        'after.com##+js(rmnt, script, html-load)',
    ]),
});

const failures = [];
function check(label, condition) { if ( condition !== true ) { failures.push(label); } }

const pruned = pruneForUbol(TEST_CONFIG.FIXTURE_LINES.join('\n'));
const taken = selectUassetsSectionRules(pruned, TEST_CONFIG.SECTION);
function has(host) { return taken.some(l => l.startsWith(`${host}#`)); }

// 1. Preprocessor.
check('the !#else (MV3) branch of cap_html_filtering is taken', has('mv3.com'));
check('the cap_html_filtering (HTML filtering) branch is not taken', has('html.com') === false);
check('an ext_ubol branch is taken', has('ubol.com'));
check('a Safari-only branch is not taken', has('safari.com') === false);
// 2. Section bounds and comments.
check('a rule outside the section (before it) is not taken', has('outside.com') === false);
check('a rule outside the section (after it) is not taken', has('after.com') === false);
check('a rule without the vendor name inside the section is taken', has('html-filter-env.com'));
check('comments and blank lines are left out', taken.every(l => l !== '' && l.startsWith('!') === false));
// 3. Missing section.
let threw = false;
try { selectUassetsSectionRules(pruned, TEST_CONFIG.MISSING_SECTION); } catch { threw = true; }
check('a missing section fails the build', threw);
// 4. Through the real trust gate.
const gated = applyScriptletTrustGate(TEST_CONFIG.SOURCE_URL, taken.join('\n')).split('\n');
check('the Ad-Shield setAttribute rule becomes the safe project scriptlet',
    gated.includes(`future.com#%#//scriptlet('${SCRIPTLET_POLICY.BLANK_SETATTRIBUTE_VALUE_NAME}', ${TEST_CONFIG.PATTERN})`));
check('a trusted scriptlet that inserts a value is dropped', gated.some(l => l.startsWith('insert.com')) === false);
check('an ordinary scriptlet passes the gate unchanged', gated.some(l => l.startsWith('mv3.com##+js(rmnt')));

for ( const f of failures ) { console.error(`FAIL: ${f}`); }
if ( failures.length !== 0 ) { process.exit(1); }
console.log(`OK: uAssets sections — preprocessor, section bounds, missing-section guard and trust-gate replacement (${taken.length} rules taken from the fixture).`);
