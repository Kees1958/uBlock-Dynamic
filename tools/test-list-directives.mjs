#!/usr/bin/env node
// test-list-directives.mjs — (11.1.4) a downloaded list's own platform directives are applied before parsing
// (tools/build/list-directives.mjs, called from fetchListText()).
//
// Checked with the REAL function, on in-memory fixtures (no network):
//   1. AdGuard "!+ PLATFORM(…)" / "!+ NOT_PLATFORM(…)" hints: a rule is kept only when AdGuard's Chrome MV3 platform is
//      named (or nothing excludes it) — the same test as AdGuard's FiltersCompiler; the hint covers ONE line only;
//      the hint lines themselves are gone; the "corelibs" alias is expanded;
//   2. "!#if" blocks: an AdGuard source is answered as AdGuard's Chrome MV3 build (adguard, adguard_ext_chromium_mv3
//      true; adguard_ext_chromium, ext_ublock, iOS/Safari false); any other source as uBO Lite on Chromium;
//   3. every left-out rule is reported in droppedPlatformLines with its source.
// The fixture reproduces the real case that started this (11.1.4): AdGuard Base's iOS/Safari-only allow for
// bbc.com's dotcom-ads.js, which used to ship and beat AdGuard's own block of that script.
//
// Usage: node tools/test-list-directives.mjs   (step of tools/complete-check.mjs)
// Pure: builds its fixtures in memory; resets the report accumulator before and after (RELEASE guard).

import { applyListDirectives, isRuleForPlatform } from './build/list-directives.mjs';
import { droppedPlatformLines, resetBuildAccumulators } from './build/build-state.mjs';

// ── CONFIG ─────────────────────────────────────────────────────────────
const TEST_CONFIG = Object.freeze({
    ADGUARD_URL: 'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/BaseFilter/sections/allowlist.txt',
    UBO_URL:     'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    BBC_IOS_ALLOW: '@@||gn-web-assets.api.bbc.com/ngas/*/dotcom-ads.js$domain=bbc.com',
    ADGUARD_FIXTURE: Object.freeze([
        '! https://github.com/AdguardTeam/AdguardFilters/issues/166444',
        '!+ PLATFORM(ios, ext_android_cb, ext_safari)',
        '@@||gn-web-assets.api.bbc.com/ngas/*/dotcom-ads.js$domain=bbc.com',
        'after-hint.com##.ad',
        '!+ PLATFORM(ext_chromium_mv3, ext_ff)',
        'for-mv3.com##.ad',
        '!+ NOT_PLATFORM(ext_ublock)',
        'not-ublock.com##.ad',
        '!+ NOT_PLATFORM(ext_chromium_mv3)',
        'not-mv3.com##.ad',
        '!+ PLATFORM(corelibs)',
        'corelibs.com##.ad',
        '!+ NOT_OPTIMIZED',
        'not-optimized.com##.ad',
        '!#if (adguard_ext_chromium_mv3)',
        'if-mv3.com##.ad',
        '!#endif',
        '!#if (adguard_ext_chromium)',
        'if-chromium-mv2.com##.ad',
        '!#endif',
        '!#if (adguard_app_ios || adguard_ext_safari || adguard_ext_android_cb || ext_ublock)',
        'if-ios-or-ublock.com##.ad',
        '!#endif',
        '!#if (!adguard_app_windows && !adguard_app_mac && !adguard_app_android && !adguard_app_cli)',
        'if-not-apps.com##.ad',
        '!#endif',
    ]),
    UBO_FIXTURE: Object.freeze([
        '!#if cap_html_filtering',
        'html.com##^script:has-text(x)',
        '!#else',
        'mv3.com##+js(rmnt, script, x)',
        '!#endif',
        '!#if env_safari',
        'safari.com##.ad',
        '!#endif',
    ]),
});

const failures = [];
function check(label, condition) { if ( condition !== true ) { failures.push(label); } }
function startsAny(lines, prefix) { return lines.some(l => l.startsWith(prefix)); }

resetBuildAccumulators();
try {
    const ag = applyListDirectives(TEST_CONFIG.ADGUARD_URL, TEST_CONFIG.ADGUARD_FIXTURE.join('\n')).split('\n');
    function has(host) { return startsAny(ag, host); }
    // 1. Hints.
    check('the iOS/Safari-only bbc.com allow is left out', ag.includes(TEST_CONFIG.BBC_IOS_ALLOW) === false);
    check('a hint covers only the line directly below it', has('after-hint.com'));
    check('PLATFORM naming ext_chromium_mv3 keeps the rule', has('for-mv3.com'));
    check('NOT_PLATFORM of another platform keeps the rule', has('not-ublock.com'));
    check('NOT_PLATFORM(ext_chromium_mv3) leaves the rule out', has('not-mv3.com') === false);
    check('the corelibs alias (apps only) leaves the rule out', has('corelibs.com') === false);
    check('a hint without a platform keeps the rule', has('not-optimized.com'));
    check('hint lines are removed', ag.some(l => l.startsWith('!+ ')) === false);
    check('isRuleForPlatform: no hint → kept', isRuleForPlatform(null) && isRuleForPlatform('! a comment'));
    // 2. "!#if" for an AdGuard source.
    check('!#if adguard_ext_chromium_mv3 is taken', has('if-mv3.com'));
    check('!#if adguard_ext_chromium (the MV2 build) is not taken', has('if-chromium-mv2.com') === false);
    check('!#if iOS/Safari/ext_ublock is not taken', has('if-ios-or-ublock.com') === false);
    check('!#if not-the-apps is taken', has('if-not-apps.com'));
    // 2. "!#if" for a uBO source.
    const ubo = applyListDirectives(TEST_CONFIG.UBO_URL, TEST_CONFIG.UBO_FIXTURE.join('\n')).split('\n');
    check('uBO source: the cap_html_filtering !#else branch is taken', ubo.some(l => l.startsWith('mv3.com')));
    check('uBO source: the HTML-filtering branch is not taken', ubo.some(l => l.startsWith('html.com')) === false);
    check('uBO source: a Safari branch is not taken', ubo.some(l => l.startsWith('safari.com')) === false);
    // 3. Report.
    check('the left-out bbc.com allow is reported with its source',
        droppedPlatformLines.some(d => d.line === TEST_CONFIG.BBC_IOS_ALLOW && d.source === TEST_CONFIG.ADGUARD_URL));
    check('a rule left out by !#if is reported', droppedPlatformLines.some(d => d.line === 'html.com##^script:has-text(x)'));
    check('a kept rule is not reported', droppedPlatformLines.some(d => d.line.startsWith('for-mv3.com')) === false);
} finally {
    resetBuildAccumulators();
}

for ( const f of failures ) { console.error(`FAIL: ${f}`); }
if ( failures.length !== 0 ) { process.exit(1); }
console.log('PASS: list platform directives (AdGuard hints and !#if) are applied as AdGuard\'s Chrome MV3 build / uBO Lite apply them.');
