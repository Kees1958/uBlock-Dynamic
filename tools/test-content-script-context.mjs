// ── test-content-script-context.mjs ──────────────────────────────────────────
// Step 90 (11.0.2): page scripts survive the extension being reloaded or updated under an open page.
//
// Why: after a reload/update, scripts left in open pages lose their connection and
// chrome.runtime.sendMessage() THROWS synchronously ("Extension context invalidated."); a .catch() cannot see
// it. Found live (audit 11.0.2, finding 1): the Ad leftover cleaner kept watching the page and css-api.js threw on its
// next hide — an error on chrome://extensions with no context. Ten send sites in eight page scripts had the gap.
//
// What is checked (C25: the shape, not just the known sites):
//   A. No page script calls chrome.runtime.sendMessage() directly, except inside the guard block itself.
//   B. Every page script that uses sendToExtension() carries the guard block, word for word the same as every other
//      copy (page scripts cannot import, so the copies must not drift — B15).
//   C. The guard really works: run in a sandbox where chrome.runtime.id is gone and sendMessage throws, it resolves
//      instead of throwing; with sendMessage throwing for another reason it rejects instead of throwing.
//   D. Every `new self.ProceduralFiltererAPI()` is either checked first (typeof === 'function') or listed below
//      with the reason it cannot meet the inject promise.
//   E. The Ad leftover cleaner ends its run when the extension is gone.
//
// Dependencies: js/scripting/*.js (read as text; part C evaluates the guard block in node:vm).

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/******************************************************************************/
// Configuration — one place
/******************************************************************************/

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTING_DIR = path.join(ROOT, 'js/scripting');

// Generated snippet bundles are not hand-written page scripts that message the extension.
const SKIP_FILE_RE = /\.generated\.js$/;

const GUARD_START = '// ── (11.0.2) GUARD: the extension was reloaded or updated under this page';
const GUARD_END = '// ── end GUARD';

// Constructor sites that cannot meet the inject promise, with the reason (anything else must check typeof first).
const CONSTRUCTOR_EXEMPT = Object.freeze({
    'js/scripting/picker.js': 'injected together with css-procedural-api.js in one executeScript call, so the class is set',
    'js/scripting/tool-overlay.js': 'only injected after css-procedural-api.js in the same executeScript file list',
    'js/offscreen/css-compiled.template.js': 'offscreen document template: imports the class directly, no page',
});

/******************************************************************************/

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : ` — ${detail}`}`);
    if ( ok === false ) { failures += 1; }
}

function rel(file) { return path.relative(ROOT, file); }

function guardBlockOf(text) {
    const start = text.indexOf(GUARD_START);
    if ( start === -1 ) { return null; }
    const endLine = text.indexOf(GUARD_END, start);
    if ( endLine === -1 ) { return null; }
    const end = text.indexOf('\n', endLine);
    return text.slice(start, end === -1 ? text.length : end);
}

// Same text whatever the indentation (one copy sits inside an arrow function).
function normalise(block) {
    return block.split('\n').map(l => l.trim()).filter(l => l !== '').join('\n');
}

function withoutComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
}

console.log('=== Step 90: page scripts survive an extension reload (11.0.2) ===');

const files = fs.readdirSync(SCRIPTING_DIR)
    .filter(n => n.endsWith('.js') && SKIP_FILE_RE.test(n) === false)
    .map(n => path.join(SCRIPTING_DIR, n));

// ── A + B ─────────────────────────────────────────────────────────────────────
const direct = [];
const users = [];
const blocks = new Map();
for ( const file of files ) {
    const text = fs.readFileSync(file, 'utf8');
    const block = guardBlockOf(text);
    const outside = withoutComments(block === null ? text : text.replace(block, ''));
    if ( /chrome\.runtime\.sendMessage\s*\(/.test(outside) ) { direct.push(rel(file)); }
    if ( /\bsendToExtension\s*\(/.test(outside) ) {
        users.push(rel(file));
        if ( block === null ) { blocks.set(rel(file), null); } else { blocks.set(rel(file), normalise(block)); }
    }
}
check('no page script calls chrome.runtime.sendMessage() outside the guard', direct.length === 0, direct.join(' | '));
const missing = [ ...blocks ].filter(([ , b ]) => b === null).map(([ f ]) => f);
check(`every sendToExtension() user carries the guard block (${users.length} scripts)`, missing.length === 0 && users.length >= 8, missing.join(' | ') || `${users.length} users`);
const variants = new Set([ ...blocks.values() ].filter(b => b !== null));
check('every copy of the guard block is identical', variants.size === 1, `${variants.size} different copies`);

// ── C ─────────────────────────────────────────────────────────────────────────
const canonical = [ ...variants ][0] ?? '';
async function runGuard(chrome) {
    const sandbox = { chrome, Promise };
    vm.createContext(sandbox);
    vm.runInContext(`${canonical}\nthis.sendToExtension = sendToExtension; this.isExtensionGone = isExtensionGone;`, sandbox);
    let threw = false;
    let outcome;
    try {
        outcome = await sandbox.sendToExtension({ what: 'x' }).then(v => `resolved:${v}`, r => `rejected:${r.message}`);
    } catch {
        threw = true;
    }
    return { threw, outcome, gone: sandbox.isExtensionGone() };
}
const invalidated = await runGuard({ runtime: { id: undefined, sendMessage() { throw new Error('Extension context invalidated.'); } } });
check('extension gone: resolves, does not throw', invalidated.threw === false && invalidated.outcome === 'resolved:undefined' && invalidated.gone, JSON.stringify(invalidated));
const otherFailure = await runGuard({ runtime: { id: 'abc', sendMessage() { throw new Error('boom'); } } });
check('other synchronous failure: rejects, does not throw', otherFailure.threw === false && otherFailure.outcome === 'rejected:boom', JSON.stringify(otherFailure));
const normal = await runGuard({ runtime: { id: 'abc', sendMessage: async () => 42 } });
check('normal case: passes the response through', normal.outcome === 'resolved:42', JSON.stringify(normal));
const noRuntime = await runGuard({});
check('no runtime at all: counts as gone', noRuntime.gone && noRuntime.outcome === 'resolved:undefined', JSON.stringify(noRuntime));

// ── D ─────────────────────────────────────────────────────────────────────────
const unchecked = [];
for ( const file of [ ...files, path.join(ROOT, 'js/offscreen/css-compiled.template.js') ] ) {
    if ( fs.existsSync(file) === false ) { continue; }
    const text = withoutComments(fs.readFileSync(file, 'utf8'));
    if ( /new self\.ProceduralFiltererAPI\(/.test(text) === false ) { continue; }
    if ( CONSTRUCTOR_EXEMPT[rel(file)] !== undefined ) { continue; }
    const at = text.indexOf('new self.ProceduralFiltererAPI(');
    const before = text.slice(Math.max(0, at - 600), at);
    if ( /typeof self\.ProceduralFiltererAPI !== 'function'/.test(before) === false ) { unchecked.push(rel(file)); }
}
check('every new self.ProceduralFiltererAPI() is checked first or listed with a reason', unchecked.length === 0, unchecked.join(' | '));

// ── E ─────────────────────────────────────────────────────────────────────────
const cleaner = fs.readFileSync(path.join(SCRIPTING_DIR, 'ad-cleaner.js'), 'utf8');
const surveyAt = cleaner.indexOf('function survey() {');
const surveyHead = surveyAt === -1 ? '' : cleaner.slice(surveyAt, surveyAt + 600);
check('Ad leftover cleaner ends its run when the extension is gone', /isExtensionGone\(\)\s*\)\s*\{\s*stopRun\(STOP_REASONS\.GONE\)/.test(surveyHead));

console.log(failures === 0 ? '\nPASS' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
