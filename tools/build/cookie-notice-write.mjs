// ── tools/build/cookie-notice-write.mjs ───────────────────────────────────────────────
// (11.0.0) Writes Seamless surfing's cookie-notice sets (tools/build/cookie-notice-sources.mjs computes them; the file
// names and what the runtime does with them: js/data/cookie-notice-sets.js):
//   - the two scriptlet data files (decline / accept), in the shared dispatch layout but under the cookie library's
//     OWN page global (scriptlet-dispatch-layout.mjs `libGlobal`), plus that library and its end file;
//   - the decline hide shards (self-contained ISOLATED scripts);
//   - the decline block rules (DNR rules without ids) and the sites file.
// Every data file is decoded again before it is written (round-trip guard), and every scriptlet row is re-checked
// against js/data/scriptlet-policy.js.
//
// Public interface:
//   renderHideShard(table)             — Map<site, string[]> -> the shard script text (pure)
//   writeCookieNoticeFiles(sets, bodies) — write everything; returns { files, sizes } for the build log / checks
// Dependencies: scriptlet-dispatch-layout.mjs, js/data/cookie-notice-sets.js, js/data/scriptlet-policy.js.
// State owned: none — every structure is allocated inside the call.

import fs from 'fs/promises';
import path from 'path';
import { ROOT } from './build-paths.mjs';
import { encodeDispatchTables, renderLibraryEndFile, renderLibraryFile, renderScriptletFile, verifyRoundTrip } from './scriptlet-dispatch-layout.mjs';
import { scriptletViolationAnySource } from '../../js/data/scriptlet-policy.js';
import {
    COOKIE_NOTICE_HIDE_SHARDS, COOKIE_NOTICE_LIBRARY_END_FILE, COOKIE_NOTICE_LIBRARY_FILE, COOKIE_NOTICE_LIBRARY_GLOBAL,
    COOKIE_NOTICE_MODE_FILES, COOKIE_NOTICE_SITES_FILE, cookieNoticeHideFile, cookieNoticeHideShardOf,
} from '../../js/data/cookie-notice-sets.js';

/******************************************************************************/
// Settings
/******************************************************************************/
// The CSS each hidden selector gets (one rule per selector — see js/data/cookie-notice-sets.js).
const HIDE_DECLARATION = '{display:none!important}';
// uniqueId prefix of each mode's rows (feeds the scriptlets' own run-once guard; no ":" allowed).
function fileTagOf(mode) { return `cookie_notice_${mode.replace(/[^a-z]/g, '_')}`; }

/******************************************************************************/
// Scriptlet data file of one mode: Map<site, [{ name, args }]> -> { code, fnNames }
/******************************************************************************/
function renderModeFile(mode, bySite) {
    const fnNames = [ ...new Set([ ...bySite.values() ].flat().map(r => r.name)) ].sort();
    const fnIndex = new Map(fnNames.map((n, i) => [ n, i ]));
    const ruleIds = new Map();                     // identical rules on several sites share one row
    const byHostname = new Map();
    for ( const site of [ ...bySite.keys() ].sort() ) {
        byHostname.set(site, bySite.get(site).map(({ name, args }) => {
            const violation = scriptletViolationAnySource(name, args);
            if ( violation !== null ) { throw new Error(`cookie notices: ${site} ${name} — ${violation} (should have been dropped)`); }
            const key = JSON.stringify([ name, args ]);
            if ( !ruleIds.has(key) ) { ruleIds.set(key, ruleIds.size); }
            return [ fnIndex.get(name), ruleIds.get(key), args ];
        }));
    }
    const code = renderScriptletFile(fnNames, encodeDispatchTables(byHostname), false, fileTagOf(mode), COOKIE_NOTICE_LIBRARY_GLOBAL);
    verifyRoundTrip(byHostname, code, COOKIE_NOTICE_LIBRARY_GLOBAL);   // C13a: the written file holds exactly this table
    return { code, fnNames };
}

/******************************************************************************/
// Hide shard: a sorted site array, a selector pool and per-site selector indexes; the same hostname walk as the
// scriptlet lookup (the page hostname, then each parent domain, stopping before a bare TLD).
/******************************************************************************/
export function renderHideShard(table) {
    const sites = [ ...table.keys() ].sort();
    const pool = [ ...new Set([ ...table.values() ].flat()) ].sort();
    const poolIndex = new Map(pool.map((s, i) => [ s, i ]));
    const refs = sites.map(site => [ ...new Set(table.get(site)) ].map(s => poolIndex.get(s)).join(',')).join(';');
    return '(()=>{"use strict";const A=self.cssAPI;if(typeof A!=="object"||A===null)return;' +
        `const H=${JSON.stringify(sites)},S=${JSON.stringify(pool)},R=${JSON.stringify(refs)}.split(";");` +
        'const t=new Set();const f=s=>{let l=0,r=H.length;while(l<r){const m=l+r>>>1;if(H[m]<s)l=m+1;else r=m}' +
        'if(H[l]===s)for(const x of R[l].split(","))t.add(S[+x])};' +
        'let p=location.hostname;for(;;){f(p);const i=p.indexOf(".");if(i<0||!p.slice(i+1).includes("."))break;p=p.slice(i+1)}' +
        `if(t.size)A.insert([...t].map(s=>s+${JSON.stringify(HIDE_DECLARATION)}).join("\\n"),true)})();`;
}

/******************************************************************************/
// Writer
/******************************************************************************/
async function write(rel, text) {
    await fs.writeFile(path.join(ROOT, rel), text, 'utf8');
    return [ rel, Buffer.byteLength(text, 'utf8') ];
}

// sets: buildCookieNoticeSets()'s result; bodies: Map<library name, function source> (the build's scriptletLibraryBodies).
export async function writeCookieNoticeFiles(sets, bodies) {
    const sizes = [];
    const libraryNames = new Set();
    const sitesFile = { scriptlets: {}, hide: {} };
    for ( const [ mode, files ] of Object.entries(COOKIE_NOTICE_MODE_FILES) ) {
        const table = sets.scriptlets[mode];
        if ( !(table instanceof Map) || table.size === 0 ) { throw new Error(`cookie notices: no scriptlet table for mode "${mode}"`); }
        const { code, fnNames } = renderModeFile(mode, table);
        for ( const n of fnNames ) { libraryNames.add(n); }
        sizes.push(await write(files.scriptlets, code));
        sitesFile.scriptlets[mode] = [ ...table.keys() ].sort();
        if ( files.hideFamily !== null && sitesFile.hide[files.hideFamily] === undefined ) {   // a family shared by two modes is written once
            // Every shard file of a family is written (an empty shard is a no-op script), so the file set never varies.
            const shards = Array.from({ length: COOKIE_NOTICE_HIDE_SHARDS }, () => new Map());
            for ( const [ site, selectors ] of sets.hides[files.hideFamily] ) { shards[cookieNoticeHideShardOf(site)].set(site, [ ...selectors ]); }
            for ( let i = 0; i < shards.length; i++ ) { sizes.push(await write(cookieNoticeHideFile(files.hideFamily, i), renderHideShard(shards[i]))); }
            sitesFile.hide[files.hideFamily] = shards.map(m => [ ...m.keys() ].sort());
        }
        if ( files.blocks !== null ) { sizes.push(await write(files.blocks, JSON.stringify(sets.blocks[mode]))); }
    }
    const entries = [ ...libraryNames ].sort().map(name => {
        const body = bodies.get(name);
        if ( body === undefined ) { throw new Error(`cookie notices: no function source for "${name}" — it must be in the build's usedScriptletNames`); }
        return [ name, body ];
    });
    sizes.push(await write(COOKIE_NOTICE_LIBRARY_FILE, renderLibraryFile(entries, COOKIE_NOTICE_LIBRARY_GLOBAL)));
    sizes.push(await write(COOKIE_NOTICE_LIBRARY_END_FILE, renderLibraryEndFile(COOKIE_NOTICE_LIBRARY_GLOBAL)));
    sizes.push(await write(COOKIE_NOTICE_SITES_FILE, JSON.stringify(sitesFile)));
    return { sizes, libraryNames: [ ...libraryNames ].sort() };
}
