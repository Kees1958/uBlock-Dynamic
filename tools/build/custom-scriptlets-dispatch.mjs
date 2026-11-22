// ── tools/build/custom-scriptlets-dispatch.mjs ────────────────────────────────────────
// Custom-rule scriptlets dispatch generator.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: buildCustomScriptletsDispatch
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import { adguardScriptletFileNotice, UBO_PATCH_SCRIPTLET_NOTICE } from './third-party-credits.mjs';
import path from 'path';
import fs from 'fs/promises';
import { ROOT } from './build-paths.mjs';
import { buildNotices } from './build-state.mjs';

/******************************************************************************/
// Custom-rule scriptlets dispatch generator — see Custom-Rule-Scriptlets-Plan.md.
//
// Unlike buildTrimmedCorelibs (above), which only keeps scriptlets already
// referenced by shipped filter lists, custom rules are typed by the user
// after install — the specific name they'll use isn't known at build time,
// so ALL scriptlets in the full library must be AVAILABLE, not a trimmed
// subset.
//
// PERFORMANCE FIX (target #3 — see CHANGELOG/REFACTOR_PLAN.md, superseded by the (10.6.0) file-based rewrite
// below): a 9.x-era pass already fixed the PER-INJECTION cost (one executeScript({ func, args }) call per
// matching directive, each targeting just that one scriptlet's own top-level function — func.toString() only
// serializes that one function's own source, not its siblings, verified empirically in a real browser; see
// TEST_PLAN.md). That fix left a DIFFERENT cost untouched: js/core/custom-scriptlets.js (imported unconditionally
// by the service worker on every cold start, to have SOME function reference ready to pass to executeScript's
// func) statically imported ALL ~101 function bodies from this file — every one of them had to be parsed by the
// SW's own V8 instance at import time, regardless of whether any custom scriptlet rule existed at all. Splitting
// those bodies across many top-level exports in ONE file does not help: ES static imports parse the WHOLE module
// graph eagerly, so the total parse cost at SW startup was the same ~600KB either way.
//
// (10.6.0) The real fix: stop giving the SW the function bodies at all. Each deduped scriptlet body is now its
// own tiny standalone FILE under js/generated/custom-scriptlets/ — never imported by any JS module (just like
// js/scripting/*.js's content scripts; see knip.jsonc's entry list) — injected directly into the target PAGE
// via chrome.scripting.executeScript({ files: [...] }), which loads and parses that one small file in the
// PAGE's own V8 instance, never the service worker's. The SW now only ever holds SCRIPTLET_NAME_TO_FILE (a
// name -> path STRING map, a few KB) and KNOWN_SCRIPTLET_NAMES (unchanged) — no function bodies at all.
//
// executeScript's `files` option has no way to carry per-call dynamic `args` the way `func` does (files are
// static content, not re-parsed function references) — js/core/custom-scriptlets.js's injectCustomScriptletsForFrame()
// covers the args hand-off with a small two-call shim (its own header comment there has the full mechanism and
// the race it specifically avoids): one tiny inline `func` call sets a single-slot global for that frame, then
// the matching file is injected and reads+consumes it immediately. The scriptlet body itself is UNCHANGED
// (`entry.scriptlet.toString()`) — only how it reaches the page changed, never its own source.
/******************************************************************************/

// (10.6.0) Per-scriptlet file content: a self-contained IIFE that reads this ONE frame's single-slot args hand-
// off (see this file's own header comment above, and injectCustomScriptletsForFrame()'s header comment in
// js/core/custom-scriptlets.js for the full shim mechanism and the race it avoids), consumes it immediately, and
// calls the scriptlet body with it. Deliberately reads+deletes the slot BEFORE calling the body, not after —
// GUARD (release): the slot must not survive past this one injection even if the body itself throws.
const CUSTOM_SCRIPTLET_ARGS_SLOT = '__uboCustomScriptletArgs';
function renderCustomScriptletFile(fnSource, creditNotice) {
    return creditNotice + [
        `(function(){`,
        `    var a = self.${CUSTOM_SCRIPTLET_ARGS_SLOT};`,
        `    delete self.${CUSTOM_SCRIPTLET_ARGS_SLOT};`,
        `    var source = (a && a[0]) || {};`,
        `    var args = (a && a[1]) || [];`,
        `    (${fnSource})(source, args);`,
        `})();`,
        '',
    ].join('\n');
}

export async function buildCustomScriptletsDispatch(full) {
    // Dedupe: many names alias the same function body (e.g. 'noeval',
    // 'noeval.js', 'ubo-noeval.js', 'ubo-noeval' all point to one function).
    // (10.6.0) fnVarMap's value is now a FILE var name (same s0/s1/... scheme as before — unchanged naming,
    // just a file on disk instead of a module-level export) — every alias name still maps to ONE shared var,
    // so two aliases of the same body still produce exactly one file, never a duplicate.
    const fnVarMap  = new Map();  // function body string -> var name (also the file's basename, sans extension)
    const fileWrites = [];        // [{ varName, code }] — written to disk after the loop below
    const nameToVar = new Map();  // every alias name -> var name
    let varIndex = 0;

    for ( const entry of full.scriptlets ) {
        if ( !fnVarMap.has(entry.scriptlet) ) {
            const v = `s${varIndex++}`;
            fnVarMap.set(entry.scriptlet, v);
            fileWrites.push({ varName: v, code: renderCustomScriptletFile(entry.scriptlet.toString(), adguardScriptletFileNotice(full.version)) });
        }
        const v = fnVarMap.get(entry.scriptlet);
        for ( const name of entry.names ) {
            nameToVar.set(name, v);
        }
    }

    // Bare-alias fix (real-world incident: a user's ABP-import used `set`,
    // `aeld`, `nostif`, `rc`, `ra`, `cookie-remover` — all real uBO filter-
    // syntax aliases — and every one was rejected as "unknown scriptlet
    // name", because @adguard/scriptlets' own `names` arrays register the
    // uBO-compatible alias WITH a `.js` suffix (`set.js`, `aeld.js`, ...)
    // but not consistently the bare uBO short form uBO's own filter parser
    // actually accepts (uBO treats "foo" and "foo.js" as interchangeable).
    // Generic fix, not a 6-name patch list: for every name already
    // registered ending in `.js`, also register its bare form, UNLESS that
    // bare form is already a DIFFERENT, real name pointing at a different
    // function (verified empirically before this fix: zero such collisions
    // across the whole library as of the vendored version — checked again
    // below, defensively, in case a future library version introduces one).
    for ( const [ name, v ] of [ ...nameToVar ] ) {
        if ( name.endsWith('.js') === false ) { continue; }
        const bare = name.slice(0, -3);
        const existing = nameToVar.get(bare);
        if ( existing !== undefined && existing !== v ) {
            throw new Error(`buildCustomScriptletsDispatch: bare-alias fix would overwrite "${bare}" (currently -> ${existing}) with a different function (-> ${v}, from "${name}") — a real collision appeared; resolve by hand before continuing.`);
        }
        nameToVar.set(bare, v);
    }

    // uBO-patch scriptlets (C40) — small, untrusted scriptlets missing
    // from @adguard/scriptlets entirely, hand-ported from real uBO
    // source (js/resources/ubo-patch-scriptlets-source.mjs). Merged in
    // AFTER every @adguard/scriptlets name/alias above, and only for a
    // name @adguard/scriptlets does NOT already define — @adguard's own
    // version always wins the moment it adds one, per C21/C40. Reports
    // (never silently drops) any patch entry that has become redundant,
    // so a human deletes the dead source in a follow-up commit.
    const { UBO_PATCH_SCRIPTLETS } = await import('../../js/resources/ubo-patch-scriptlets-source.mjs');
    const redundantPatchNames = [];
    for ( const entry of UBO_PATCH_SCRIPTLETS ) {
        const v = `u${varIndex++}`;
        fileWrites.push({ varName: v, code: renderCustomScriptletFile(entry.scriptlet.toString(), UBO_PATCH_SCRIPTLET_NOTICE) });
        for ( const name of entry.names ) {
            if ( nameToVar.has(name) ) { redundantPatchNames.push(name); continue; }
            nameToVar.set(name, v);
        }
    }
    if ( redundantPatchNames.length !== 0 ) {
        buildNotices.push({
            level: 'WARNING',
            text: `${redundantPatchNames.length} uBO-patch scriptlet name(s) are now also in @adguard/scriptlets@${full.version} and were skipped in favor of it: ${redundantPatchNames.join(', ')}. Delete the now-redundant entry from js/resources/ubo-patch-scriptlets-source.mjs.`,
        });
    }

    // (10.6.0) GUARD (release, before writing the new set): remove every PREVIOUSLY-generated per-scriptlet file
    // so a scriptlet dropped by a @adguard/scriptlets update (or a renamed var index) never lingers on disk as
    // an orphaned file nothing points to any more — same "init, clear, release" discipline this project applies
    // to every other generated-file directory (e.g. rulesets/ before a filter-list rebuild).
    const outDir = path.join(ROOT, 'js/generated/custom-scriptlets');
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(outDir, { recursive: true });
    for ( const { varName, code } of fileWrites ) {
        await fs.writeFile(path.join(outDir, `${varName}.js`), code, 'utf8');
    }

    // SCRIPTLET_NAME_TO_FILE: name -> the one file that carries its body — a plain string map (a few KB), never
    // a function reference, so importing THIS file (still an ordinary ES import, unlike the per-scriptlet files
    // above) costs the SW nothing close to the ~600KB the old SCRIPTLET_NAME_TO_FN export did. See this file's
    // own header comment above for the full before/after.
    const lookupLines = [ 'export const SCRIPTLET_NAME_TO_FILE={' ];
    for ( const [ name, v ] of nameToVar ) {
        lookupLines.push(`    ${JSON.stringify(name)}:${JSON.stringify(`/js/generated/custom-scriptlets/${v}.js`)},`);
    }
    lookupLines.push('};');

    const code = [
        '/*',
        ' * custom-scriptlets-dispatch.mjs — GENERATED by tools/build-rulesets.mjs,',
        ' * do not edit by hand.',
        ` * Lists ALL ${full.scriptlets.length} scriptlets from @adguard/scriptlets`,
        ` * v${full.version} by NAME + FILE PATH only — never a function body —`,
        ' * so importing this file into the service worker costs a few KB, not',
        ' * the ~600KB every scriptlet body together would cost. The bodies',
        ' * themselves live as individual files under',
        ' * js/generated/custom-scriptlets/, never imported by any JS module',
        ' * (see knip.jsonc\'s entry list), injected directly into the target',
        ' * page via chrome.scripting.executeScript({ files: [...] }) instead.',
        ' * See Custom-Rule-Scriptlets-Plan.md and this file\'s own header',
        ' * comment above for the full mechanism.',
        ' */',
        '',
        lookupLines.join('\n'),
        '',
        '// Flat list of every valid name — for cheap validation in the dashboard',
        '// editor (see js/core/custom-scriptlets.js), which should not need to',
        '// load/parse any scriptlet body just to check "is this a known name".',
        `export const KNOWN_SCRIPTLET_NAMES = ${JSON.stringify([ ...nameToVar.keys() ])};`,
        '',
    ].join('\n');

    const outPath = path.join(ROOT, 'js/generated/custom-scriptlets-dispatch.mjs');
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, code, 'utf8');

    console.log(`Custom-scriptlets dispatch: ${full.scriptlets.length} scriptlets, ` +
                `${nameToVar.size} names, ${fileWrites.length} file(s) under js/generated/custom-scriptlets/, ` +
                `${Math.round(code.length / 1024)}KB lookup -> js/generated/custom-scriptlets-dispatch.mjs`);
}
