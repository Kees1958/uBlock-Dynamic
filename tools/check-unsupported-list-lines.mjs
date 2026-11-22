#!/usr/bin/env node
// check-unsupported-list-lines.mjs — a hand-written list (Quick-fixes) never loses a line silently (10.1.8).
//
// Drives the REAL parseList() with the Quick-fixes options (reportUnsupportedLines + convertBadfilterToAllow) over a table of
// lines and asserts, per line, whether it is kept (a rule / scriptlet / exception / cosmetic entry), silently ignored
// (comment, blank) or DROPPED AND REPORTED with the expected reason. Also: a list that does not opt in reports nothing.
//
// Usage: node tools/check-unsupported-list-lines.mjs   (step 52 of tools/complete-check.mjs)

import path from 'path';
import { fileURLToPath } from 'url';
import { parseList } from './build/list-parser.mjs';
import { parseBlockRule } from './build/rule-parsers.mjs';
import * as state from './build/build-state.mjs';

const isMainModule = process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

// ── CONFIG: one row per line. fate: 'kept' (compiled somewhere), 'ignored' (comment/blank), 'reported' (+ reason fragment) ──
const CASES = Object.freeze([
    { line: '! a comment',                                              fate: 'ignored' },
    { line: '[Adblock Plus 2.0]',                                       fate: 'ignored' },
    { line: '',                                                          fate: 'ignored' },
    { line: '||ads.example.com^$badfilter',                              fate: 'kept' },
    { line: '||ads.example.com^$script,domain=a.com,badfilter',          fate: 'kept' },
    // (11.0.2) A fix for a non-block rule would become an allow of the whole condition: dropped and reported.
    { line: '||ads.example.com^$redirect=noopjs,badfilter',              fate: 'reported', reason: 'cancel more than that one rule' },
    { line: '||cnn.com/ads/video.js$script',                             fate: 'kept' },
    { line: "cnn.com#%#//scriptlet('disable-fave-ssai')",                fate: 'kept' },
    { line: "cnn.com#@#//scriptlet('set-constant','a','b')",             fate: 'kept' },
    { line: 'cnn.com##.ad-slot',                                         fate: 'kept' },
    { line: '||x.com^$removeparam=utm_source',                           fate: 'kept' },
    { line: 'cnn.com#%#(()=>{window.X=1})();',                           fate: 'reported', reason: 'raw JavaScript rule' },
    { line: "cnn.com#@%#window.X=1",                                     fate: 'reported', reason: 'raw JavaScript exception' },
    { line: 'cnn.com#$#body { margin: 0 !important; }',                  fate: 'reported', reason: 'CSS-injection rule' },
    { line: 'cnn.com#?#div:has(> .ad)',                                  fate: 'reported', reason: 'procedural cosmetic filter' },
    { line: 'cnn.com$$script[data-src]',                                 fate: 'reported', reason: 'HTML-filtering rule' },
    { line: '||registry.api.cnn.io/bundles/fave/latest-*.x/js$replace=/a/b/,domain=cnn.com', fate: 'reported', reason: '$replace' },
    { line: '||a.com^$csp=script-src \'none\'',                          fate: 'reported', reason: '$csp' },
    { line: '||a.com^$unknownoption',                                    fate: 'reported', reason: 'could not be compiled' },
]);
// (11.0.2) Block rules whose Bad filter fix must cancel exactly them (same condition, allow action).
const EXACT_CANCEL_LINES = Object.freeze([
    '||ads.example.com^',
    '||ads.example.com^$script',
    '||ads.example.com^$script,domain=a.com|b.com',
    '||ads.example.com/path/*.js$third-party,image',
]);
const QUICKFIXES_OPTIONS = Object.freeze({ listName: 'Quick fixes (test)', convertBadfilterToAllow: true, badfilterPriority: 9, reportUnsupportedLines: true });

function parseOne(line, options) {
    state.resetBuildAccumulators();
    const result = parseList(line, 5, options);
    const reported = state.droppedUnsupportedListLines.slice();
    const kept = result.dnrRules.length + result.scriptletRules.length + result.scriptletExceptions.length + result.cosmeticMap.size;
    return { kept, reported };
}

function run() {
    const failures = [];
    for ( const c of CASES ) {
        const { kept, reported } = parseOne(c.line, QUICKFIXES_OPTIONS);
        if ( c.fate === 'kept' ) {
            if ( kept === 0 ) { failures.push(`"${c.line}": expected to be kept, nothing was produced.`); }
            if ( reported.length !== 0 ) { failures.push(`"${c.line}": kept, but also reported as dropped (${reported[0].reason}).`); }
        } else if ( c.fate === 'ignored' ) {
            if ( kept !== 0 || reported.length !== 0 ) { failures.push(`"${c.line}": a comment/blank line must be ignored without a report.`); }
        } else if ( reported.length !== 1 || reported[0].reason.includes(c.reason) === false ) {
            failures.push(`"${c.line}": expected ONE report containing "${c.reason}", got ${JSON.stringify(reported.map(r => r.reason))}.`);
        } else if ( kept !== 0 ) {
            failures.push(`"${c.line}": reported as dropped but something was produced from it.`);
        }
    }
    // (11.0.2) A Bad filter fixes line cancels exactly the rule it names: its allow rule carries the SAME condition
    // as the block rule written without "$badfilter" (AdGuard tsurlfilter 6.1.0 fixed the opposite case).
    for ( const named of EXACT_CANCEL_LINES ) {
        // parseBlockRule(), not parseList(): parseList() later merges plain "||host^" blocks into one requestDomains
        // rule (same match, different shape), which would hide what is compared here.
        const block = parseBlockRule(named, 5);
        const fix = parseOne(`${named}${named.includes('$') ? ',' : '$'}badfilter`, QUICKFIXES_OPTIONS);
        state.resetBuildAccumulators();
        const allow = parseList(`${named}${named.includes('$') ? ',' : '$'}badfilter`, 5, QUICKFIXES_OPTIONS).dnrRules[0];
        if ( block === undefined || allow === undefined || fix.reported.length !== 0 ) {
            failures.push(`"${named}": expected a block rule and an exact allow fix.`);
        } else if ( allow.action.type !== 'allow' || JSON.stringify(allow.condition) !== JSON.stringify(block.condition) ) {
            failures.push(`"${named}": the fix's allow condition ${JSON.stringify(allow.condition)} differs from the named rule's ${JSON.stringify(block.condition)}.`);
        }
    }
    // A list that does not opt in (the big third-party lists) reports nothing, whatever it contains.
    const quiet = parseOne('cnn.com#%#(()=>{})();\ncnn.com#$#a{b:c}', { listName: 'Big list (test)' });
    if ( quiet.reported.length !== 0 ) { failures.push('a list without reportUnsupportedLines produced report entries.'); }
    state.resetBuildAccumulators();
    for ( const f of failures ) { console.error(`VIOLATION: ${f}`); }
    if ( failures.length ) { return false; }
    console.log(`OK: ${CASES.length} line shapes behave as declared (kept / ignored / dropped and reported); ${EXACT_CANCEL_LINES.length} Bad filter fixes cancel exactly the rule they name; lists that do not opt in report nothing.`);
    return true;
}

if ( isMainModule ) { process.exit(run() ? 0 : 1); }
export { run };
