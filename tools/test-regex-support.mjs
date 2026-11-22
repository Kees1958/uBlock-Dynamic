// tools/test-regex-support.mjs — the build's regexFilter gate (tools/build/regex-support.mjs, 10.7.6), proven
// on the real module without a browser (C42): a cached "supported" verdict ships, a cached refusal and an
// UNKNOWN regex (no Chrome to ask) are dropped and reported — never shipped unverified; the per-ruleset cap
// fails the build; open/close leave no state behind.
// Usage: node tools/test-regex-support.mjs        Outcomes (C38): PASS / FAIL / DID NOT RUN.
import fs from 'fs/promises';
import os from 'os';
import path from 'path';


let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
    if ( !ok ) { failures += 1; }
}
function rule(id, regexFilter, caseSensitive = false) {
    return { id, action: { type: 'block' }, condition: { regexFilter, isUrlFilterCaseSensitive: caseSensitive } };
}

let tmpRoot = null;
try {
    // No browser in this test, whatever the machine has: the unknown regex must be dropped, not shipped.
    process.env.CHROME_PATH = path.join(os.tmpdir(), 'no-such-chrome-for-regex-test');
    const rs = await import('./build/regex-support.mjs');
    const { REGEX_SUPPORT_CONFIG: CFG } = rs;

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'regex-support-test-'));
    await fs.mkdir(path.join(tmpRoot, path.dirname(CFG.VERDICTS_FILE)), { recursive: true });
    const verdicts = {
        [rs.verdictKey('ok[0-9]+', false)]:  { supported: true, chrome: 'test' },
        [rs.verdictKey('big{1,999}', false)]: { supported: false, reason: 'memoryLimitExceeded', chrome: 'test' },
    };
    await fs.writeFile(path.join(tmpRoot, CFG.VERDICTS_FILE), JSON.stringify({ schema: CFG.VERDICTS_SCHEMA, verdicts }));

    await rs.openRegexSupport(tmpRoot);
    const plain = { id: 9, action: { type: 'block' }, condition: { urlFilter: '||x.com^' } };
    const kept = await rs.filterSupportedRegexRules([ plain, rule(1, 'ok[0-9]+'), rule(2, 'big{1,999}'), rule(3, 'unknown.+'), rule(4, 'ok[0-9]+', true) ], 'test-list');
    check('non-regex rule kept', kept.includes(plain));
    check('cached supported regex kept', kept.some(r => r.id === 1));
    check('cached refused regex dropped', kept.some(r => r.id === 2) === false);
    check('unknown regex dropped (no Chrome)', kept.some(r => r.id === 3) === false);
    check('verdict is per case-sensitivity (case-sensitive copy unknown -> dropped)', kept.some(r => r.id === 4) === false);

    let capThrew = false;
    try { rs.noteShippedRegexRules('big-ruleset', Array.from({ length: 1001 }, (_, i) => rule(i, 'ok[0-9]+'))); }
    catch { capThrew = true; }
    check('above Chrome\'s 1 000 regex rules per ruleset the build fails', capThrew);
    check('count returned', rs.noteShippedRegexRules('small', [ rule(1, 'ok[0-9]+'), plain ]) === 1);

    const report = await rs.closeRegexSupport();
    const reasons = report.dropped.map(d => d.reason);
    check('report: refused regex has Chrome\'s reason', reasons.includes('Chrome: memoryLimitExceeded'), JSON.stringify(reasons));
    check('report: unknown regex marked not verified', reasons.filter(r => r === CFG.REASON_NOT_VERIFIED).length === 2, JSON.stringify(reasons));
    check('report: shipped counts', JSON.stringify(report.shippedCounts) === JSON.stringify([ { rulesetId: 'small', count: 1 } ]), JSON.stringify(report.shippedCounts));
    const after = JSON.parse(await fs.readFile(path.join(tmpRoot, CFG.VERDICTS_FILE), 'utf8'));
    check('no verdict invented without Chrome (cache unchanged)', JSON.stringify(after.verdicts) === JSON.stringify(verdicts));
    check('closing twice is harmless', await rs.closeRegexSupport() === null);

    let usedAfterClose = false;
    try { await rs.filterSupportedRegexRules([ rule(1, 'ok[0-9]+') ], 'x'); } catch { usedAfterClose = true; }
    check('use after close is refused (no stale state)', usedAfterClose);
} catch (err) {
    console.log(`DID NOT RUN: ${err.stack ?? err}`);
    failures += 1;
} finally {
    if ( tmpRoot !== null ) { await fs.rm(tmpRoot, { recursive: true, force: true }); }   // RELEASE: temp cache
}

if ( failures > 0 ) {
    console.log(`\n${failures} assertion(s) FAILED.`);
    process.exit(1);
}
console.log('\nPASS: only Chrome-supported regexes ship; refused and unverified ones are dropped and reported.');
