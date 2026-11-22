// ── safe-update-report.mjs ────────────────────────────────────────────────────
// Tells the owner what a SAFE (skip-review) update LEAVES OUT. A SAFE update ships only the requested list's
// DNR rule file(s); everything else the same list compiles to (scriptlet rules, hide rules) is code or data
// that runs in pages, is not a rule_resources file, and so needs a normal release. Before 10.1.9 the safe
// build discarded those files without a word (the CNN scriptlet lines in the Quick-fixes list vanished).
//
// Public interface:
//   findLeftOutFiles(id, preSnap, postFiles)  — pure: names of the list's own non-rule files the build made or changed
//   describeLeftOutFile(name, text)           — pure: one human-readable line per file (counts and, for scriptlets, the rules)
//   formatLeftOutReport(items)                — pure: report text, or '' when nothing is left out
// Dependencies: scriptlet-dispatch-layout.mjs (decodeDispatchSource). Pure functions: nothing is kept between
// calls, so there is nothing to initialise, clear or release.

import { decodeDispatchSource } from './scriptlet-dispatch-layout.mjs';

/******************************************************************************/
// Single place for every limit and file-name rule of the report.
/******************************************************************************/
export const SAFE_REPORT_CONFIG = Object.freeze({
    // A file belongs to list <id> when its name starts with `<id>-` (…-scriptlets.js, …-cosmetic-specific.json,
    // …-cosmetic-loader.js). The rule files <id>.json and <id>_removeparam.json have no dash and are not matched.
    OWN_FILE_PREFIX_SEPARATOR: '-',
    // How many scriptlet rules / hostnames are spelled out per file; the rest is summarised as a count.
    MAX_LISTED_RULES: 25,
    MAX_LISTED_HOSTS: 10,
    // Longest argument text printed in one rule line.
    MAX_ARG_TEXT: 60,
    // Report wording.
    HEADING: 'NOT INCLUDED in this SAFE update (needs a normal Chrome Web Store release):',
});

// Names of the list's own files (not the rule files) that the build produced or changed.
export function findLeftOutFiles(id, preSnap, postFiles) {
    if ( typeof id !== 'string' || id === '' ) { throw new Error('findLeftOutFiles: id must be a non-empty string'); }
    const prefix = id + SAFE_REPORT_CONFIG.OWN_FILE_PREFIX_SEPARATOR;
    const names = [];
    for ( const [ name, text ] of postFiles ) {
        if ( name.startsWith(prefix) === false ) { continue; }
        if ( preSnap.get(name) === text ) { continue; } // unchanged: nothing is lost
        names.push(name);
    }
    // A file the list used to compile to and no longer does: the shipped copy stays until a normal release.
    for ( const name of preSnap.keys() ) {
        if ( name.startsWith(prefix) && postFiles.has(name) === false ) { names.push(name); }
    }
    return names.sort();
}

function clip(text) {
    const max = SAFE_REPORT_CONFIG.MAX_ARG_TEXT;
    return text.length > max ? text.slice(0, max) + '…' : text;
}

export function describeLeftOutFile(name, text) {
    const lines = [];
    if ( text === undefined ) {
        return `  ${name}: no longer produced by the list (the shipped copy stays until a normal release)`;
    }
    if ( name.endsWith('-scriptlets.js') ) {
        const decoded = decodeDispatchSource(text);
        const byRow = new Map();
        for ( const [ host, refs ] of decoded.entries ) {
            for ( const [ fnIndex, row, args ] of refs ) {
                if ( byRow.has(row) === false ) { byRow.set(row, { fnIndex, args, hosts: [] }); }
                byRow.get(row).hosts.push(host);
            }
        }
        lines.push(`  ${name}: ${byRow.size} scriptlet rule(s) on ${decoded.hostnames.length} host(s)`);
        let listed = 0;
        for ( const row of byRow.values() ) {
            if ( listed++ >= SAFE_REPORT_CONFIG.MAX_LISTED_RULES ) { lines.push('    …'); break; }
            const hosts = row.hosts.slice(0, SAFE_REPORT_CONFIG.MAX_LISTED_HOSTS).join(', ') +
                (row.hosts.length > SAFE_REPORT_CONFIG.MAX_LISTED_HOSTS ? ', …' : '');
            const args = row.args.map(a => `'${clip(a)}'`).join(', ');
            // (after 10.4.4) a data file names the shared-library scriptlets it calls directly.
            lines.push(`    ${hosts}: ${decoded.fnNames[row.fnIndex] ?? `function#${row.fnIndex}`}(${args})`);
        }
    } else if ( name.endsWith('-cosmetic-specific.json') ) {
        let hostCount = 0;
        try { hostCount = JSON.parse(text).hostnames?.length ?? 0; } catch { hostCount = 0; }
        lines.push(`  ${name}: hide rules for ${hostCount} host(s)`);
    } else {
        lines.push(`  ${name}: ${text.length} bytes of page code/data`);
    }
    return lines.join('\n');
}

export function formatLeftOutReport(items) {
    if ( Array.isArray(items) === false || items.length === 0 ) { return ''; }
    const out = [ '', SAFE_REPORT_CONFIG.HEADING ];
    for ( const { id, descriptions } of items ) {
        out.push(` list ${id}:`);
        out.push(...descriptions);
    }
    out.push('');
    return out.join('\n');
}
