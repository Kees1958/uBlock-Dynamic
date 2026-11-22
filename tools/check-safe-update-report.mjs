#!/usr/bin/env node
// check-safe-update-report.mjs — the SAFE-update build says what it leaves out (step 53 of tools/complete-check.mjs).
//
// Real functions of tools/build/safe-update-report.mjs over a real generated scriptlet file (built with the real
// encoder/renderer), plus the way tools/build-safe-filters.mjs wires them in.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encodeDispatchTables, renderScriptletFile } from './build/scriptlet-dispatch-layout.mjs';
import { findLeftOutFiles, describeLeftOutFile, formatLeftOutReport } from './build/safe-update-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── CONFIG ────────────────────────────────────────────────────────────────
const CHECK_CONFIG = Object.freeze({
    LIST_ID:      'ruleset_demo',
    OTHER_ID:     'ruleset_other',
    SCRIPTLET_NAME: 'demo-scriptlet',   // the shared-library name the data file calls (after 10.4.4)
    HOST:         'demo.example',
    ARG:          'someArgument',
});

const failures = [];
function expect(condition, label) {
    if ( condition === false ) { failures.push(label); }
}

function buildDemoScriptletFile() {
    const byHostname = new Map([ [ CHECK_CONFIG.HOST, [ [ 0, 1, [ CHECK_CONFIG.ARG ] ] ] ] ]);
    return renderScriptletFile([ CHECK_CONFIG.SCRIPTLET_NAME ], encodeDispatchTables(byHostname), false, CHECK_CONFIG.LIST_ID);
}

function run() {
    const id = CHECK_CONFIG.LIST_ID;
    const fileText = buildDemoScriptletFile();
    const scriptletName = `${id}-scriptlets.js`;
    const cosmeticName = `${id}-cosmetic-specific.json`;
    const cosmeticText = JSON.stringify({ hostnames: [ 'a.example', 'b.example' ] });

    // 1. Selection: new file, changed file, unchanged file, other list's file, the rule files, a file no longer produced.
    const pre = new Map([
        [ `${id}.json`, 'old' ], [ cosmeticName, cosmeticText ], [ `${id}-gone.js`, 'x' ],
    ]);
    const post = new Map([
        [ `${id}.json`, 'new' ], [ `${id}_removeparam.json`, 'new' ], [ scriptletName, fileText ],
        [ cosmeticName, cosmeticText ], [ `${CHECK_CONFIG.OTHER_ID}-scriptlets.js`, fileText ],
    ]);
    const names = findLeftOutFiles(id, pre, post);
    expect(names.includes(scriptletName), 'a new scriptlet file is reported');
    expect(names.includes(`${id}-gone.js`), 'a file the list no longer produces is reported');
    expect(names.includes(cosmeticName) === false, 'an unchanged file is not reported');
    expect(names.includes(`${id}.json`) === false && names.includes(`${id}_removeparam.json`) === false, 'rule files are never reported');
    expect(names.every(n => n.startsWith(id + '-')), 'another list\'s files are never reported');

    // 2. Description: names the host, the scriptlet function and its argument.
    const described = describeLeftOutFile(scriptletName, fileText);
    expect(described.includes(CHECK_CONFIG.HOST), 'description names the host');
    expect(described.includes(CHECK_CONFIG.SCRIPTLET_NAME), 'description names the scriptlet function');
    expect(described.includes(CHECK_CONFIG.ARG), 'description shows the argument');
    expect(describeLeftOutFile(cosmeticName, cosmeticText).includes('2 host'), 'cosmetic description counts hosts');
    expect(describeLeftOutFile(`${id}-gone.js`, undefined).includes('no longer produced'), 'removed file is described');

    // 3. Report: empty when nothing is left out, otherwise headed and listing the list id.
    expect(formatLeftOutReport([]) === '', 'no report when nothing is left out');
    const report = formatLeftOutReport([ { id, descriptions: [ described ] } ]);
    expect(report.includes('NOT INCLUDED') && report.includes(id), 'report has a heading and the list id');

    // 4. Wiring: the SAFE build collects the report BEFORE it reverts the files, and prints it.
    const safeSource = fs.readFileSync(path.join(ROOT, 'tools', 'build-safe-filters.mjs'), 'utf8');
    const collectAt = safeSource.indexOf('findLeftOutFiles(');
    // (10.2.0) the revert is restoreBaselineBytes() — the CALL in main(), not the function definition.
    const revertAt = safeSource.indexOf('= restoreBaselineBytes(');
    expect(collectAt > 0 && collectAt < revertAt, 'the report is collected before the files are reverted');
    expect(safeSource.includes('formatLeftOutReport(leftOutItems)'), 'the report is printed');
}

run();
if ( failures.length > 0 ) {
    console.error('FAIL — safe-update report:');
    for ( const f of failures ) { console.error('  ' + f); }
    process.exit(1);
}
console.log('OK: the SAFE-update build reports what it leaves out.');
