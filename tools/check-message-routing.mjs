// C20a — message-type routing cross-reference. Every exported MSG_*
// constant is either request/response (needs a route AND a handler) or
// broadcast-only (needs at least one .onmessage reader, not a route).
// See Xplainer_Programming_principles_audit.md's C20a for the full
// rationale — this is a straight port of that section's check to fit
// this project's own tools/ + npm test convention, not a new design.
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

// Maintain this set explicitly — broadcast-only types are expected to be
// absent from the route/dispatch tables; everything else is not. Verified
// against the actual broadcastMessage()/.onmessage call sites in this
// codebase, not assumed or copied from another project's version of this
// same check.
const BROADCAST_ONLY = new Set([
    'MSG_MATRIX_ENTRY', 'MSG_MATRIX_CLOSED',
    'MSG_PRIVACY_INSPECTOR_ENTRY', 'MSG_PRIVACY_INSPECTOR_CLOSED',
    // Cookie/consent-clicker: SW -> content-script broadcast (via
    // browser.tabs.sendMessage() with no frameId — see cookie-clicker-
    // routes.js's broadcastPickerStop()), NOT a BroadcastChannel message
    // like the four above. Its reader lives in js/scripting/cookie-
    // clicker-picker.js's onRuntimeMessage() (chrome.runtime.onMessage),
    // which is why it needs its own entry in broadcastReaderFiles below
    // rather than reusing matrix-panel.js/privacy-inspector.js's list.
    'MSG_COOKIE_CLICKER_PICKER_STOP',
]);

const typesSrc  = read('js/data/message-types.js');
const routesSrc = read('js/workflow/message-routes.js');
const bgSrc     = read('js/workflow/background.js');

const msgConstEntries = [ ...typesSrc.matchAll(/export const (MSG_\w+)\s*=\s*'([^']+)'/g) ]
    .map(m => ({ name: m[1], value: m[2] }));
const msgConsts = msgConstEntries.map(e => e.name);

const missingRoute = [];
const missingHandler = [];
for ( const name of msgConsts ) {
    if ( BROADCAST_ONLY.has(name) ) { continue; }
    if ( !routesSrc.includes(`[${name}]`) ) { missingRoute.push(name); }
    if ( !bgSrc.includes(`[${name}]`) ) { missingHandler.push(name); }
}

// Broadcast-only types: confirm at least one .onmessage reader exists
// somewhere that checks for this exact constant name, across every file
// with a BroadcastChannel 'uBOL' handler.
const broadcastReaderFiles = [
    'matrix/matrix-panel.js',
    'privacy/privacy-inspector.js',
];
const readerSrcCombined = broadcastReaderFiles.map(f => {
    try { return read(f); } catch { return ''; }
}).join('\n');

// Reader files that are injected as PLAIN content scripts (via
// chrome.scripting.executeScript's `files` array), not loaded as ES
// modules — such files structurally CANNOT `import` message-types.js's
// constants (no module scope to import into), so their reader code
// necessarily compares against the message's literal STRING VALUE
// instead of the constant's NAME. Kept as its own small map (rather than
// folding into broadcastReaderFiles/readerSrcCombined above) so the
// distinction — "matched by name" vs "matched by value, because this
// reader can't import" — stays visible here instead of silently
// papered over by string-matching both the same way.
const VALUE_MATCHED_READERS = new Map([
    [ 'MSG_COOKIE_CLICKER_PICKER_STOP', 'js/scripting/cookie-clicker-picker.js' ],
]);

const missingReader = [ ...BROADCAST_ONLY ].filter(name => {
    // Must actually be declared (skip if this project's broadcast-only
    // set drifted out of sync with message-types.js itself).
    if ( !msgConsts.includes(name) ) { return false; }
    const valueReaderFile = VALUE_MATCHED_READERS.get(name);
    if ( valueReaderFile !== undefined ) {
        const value = msgConstEntries.find(e => e.name === name)?.value;
        let src = '';
        try { src = read(valueReaderFile); } catch { /* handled by the .includes() below returning false */ }
        return !(value !== undefined && src.includes(`'${value}'`));
    }
    return !readerSrcCombined.includes(name);
});

console.log('=== C20a: message-type routing cross-reference ===');
console.log(`Checked ${msgConsts.length} declared MSG_* constants (${BROADCAST_ONLY.size} broadcast-only, ${msgConsts.length - BROADCAST_ONLY.size} request/response).`);

let ok = true;
if ( missingRoute.length > 0 ) {
    ok = false;
    console.log(`FAIL: missing route entry: ${missingRoute.join(', ')}`);
}
if ( missingHandler.length > 0 ) {
    ok = false;
    console.log(`FAIL: missing dispatch handler: ${missingHandler.join(', ')}`);
}
if ( missingReader.length > 0 ) {
    ok = false;
    console.log(`FAIL: broadcast-only type with no .onmessage reader found: ${missingReader.join(', ')}`);
}
// Also flag any constant in BROADCAST_ONLY that no longer exists in
// message-types.js — the maintained set itself can drift stale after a
// rename, same failure mode the doc's own checklist calls out.
const staleBroadcastEntries = [ ...BROADCAST_ONLY ].filter(name => !msgConsts.includes(name));
if ( staleBroadcastEntries.length > 0 ) {
    ok = false;
    console.log(`FAIL: BROADCAST_ONLY set references constants no longer in message-types.js: ${staleBroadcastEntries.join(', ')}`);
}

if ( ok ) { console.log('PASS: every MSG_* constant is fully wired.'); }
console.log('');

// ── Raw-string routes (v9.6.1 addition — real incident) ────────────────
// A handful of ROUTE_HANDLERS entries in background.js use a plain string
// key directly (e.g. `siteModeGetAll: handleSiteModeGetAll`) instead of a
// named MSG_* constant — invisible to every check above, which only ever
// looks at message-types.js's own exports. Real bug this missed: two new
// entries (saferegionsGetAll/saferegionsSetAll) were added to
// ROUTE_HANDLERS but never declared in MESSAGE_ROUTES, so
// dispatchRoutedMessage() silently rejected every call before
// ROUTE_HANDLERS was ever consulted — a real user-reported failure (an
// Allow-list $saferegions entry that silently never saved), not a
// hypothetical. This section closes that gap: every plain-identifier
// ROUTE_HANDLERS key must have a matching MESSAGE_ROUTES entry, and vice
// versa, the same "declared somewhere, wired everywhere" standard the
// MSG_* check above already applies.
const routeHandlersBlockMatch = bgSrc.match(/const ROUTE_HANDLERS = \{([\s\S]*?)\n\};/);
const routeHandlersBlock = routeHandlersBlockMatch ? routeHandlersBlockMatch[1] : '';
const rawHandlerKeys = [ ...routeHandlersBlock.matchAll(/^\s{4}(\w+):\s*\w+,?\s*$/gm) ].map(m => m[1]);

const routesBlockMatch = routesSrc.match(/export const MESSAGE_ROUTES = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
const routesBlock = routesBlockMatch ? routesBlockMatch[1] : '';
const rawRouteKeys = [ ...routesBlock.matchAll(/^\s{4}(\w+):\s*Object\.freeze/gm) ].map(m => m[1]);

const rawMissingRoute = rawHandlerKeys.filter(k => !rawRouteKeys.includes(k));
const rawMissingHandler = rawRouteKeys.filter(k => !rawHandlerKeys.includes(k));

let rawOk = true;
if ( rawMissingRoute.length > 0 ) {
    rawOk = false;
    console.log(`FAIL: raw-string ROUTE_HANDLERS ${rawMissingRoute.length === 1 ? 'entry has' : 'entries have'} no MESSAGE_ROUTES declaration: ${rawMissingRoute.join(', ')}`);
}
if ( rawMissingHandler.length > 0 ) {
    rawOk = false;
    console.log(`FAIL: raw-string MESSAGE_ROUTES ${rawMissingHandler.length === 1 ? 'entry has' : 'entries have'} no ROUTE_HANDLERS handler: ${rawMissingHandler.join(', ')}`);
}
if ( rawOk ) {
    console.log(`PASS: every raw-string route (${rawHandlerKeys.length} handlers) is fully wired both ways.`);
    ok = ok && true;
} else {
    ok = false;
}
console.log('');

process.exitCode = ok ? 0 : 1;
