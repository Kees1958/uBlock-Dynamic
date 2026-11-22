// ── json-safe.js ──────────────────────────────────────────────────────────────
// Finds the first value that Chrome's extension messaging would silently
// change in transit (principle C31). runtime.sendMessage / sendResponse
// serialize with JSON, not structured clone: a Map or Set arrives as {},
// a Date as a string, an undefined property disappears, NaN becomes null —
// with no error on either side. JSON is Chrome's default; Chrome 148 added
// a structured-clone opt-in ("message_serialization" in the manifest) that
// uBD deliberately does not use: JSON is the narrower, safer format at the
// message boundary (C31); step 33 fails if the key appears.
//
// Public interface:
//   findJsonLossyValue(value, rootLabel) — returns null when `value`
//       survives a JSON round trip unchanged, otherwise a short description
//       of the FIRST lossy value found, e.g. "response.none: Set (arrives as {})".
//
// Used by background.js's message router in UNPACKED builds only (a
// development tripwire — store installs never run it), and unit-tested by
// tools/test-json-safe.mjs.
//
// Dependencies: none. State: none. Pure.
// ─────────────────────────────────────────────────────────────────────────────

// Upper bound on nodes inspected per response, so a very large response
// can never make the tripwire itself expensive. Beyond it the walk stops
// and reports nothing (a development aid, not a guarantee).
const MAX_NODES_INSPECTED = 20_000;

function describeLossy(value) {
    if ( value instanceof Map ) { return 'Map (arrives as {})'; }
    if ( value instanceof Set ) { return 'Set (arrives as {})'; }
    if ( value instanceof Date ) { return 'Date (arrives as a string)'; }
    if ( value instanceof RegExp ) { return 'RegExp (arrives as {})'; }
    if ( typeof value === 'function' ) { return 'function (dropped)'; }
    if ( typeof value === 'symbol' ) { return 'symbol (dropped)'; }
    if ( typeof value === 'bigint' ) { return 'bigint (JSON cannot encode it)'; }
    if ( typeof value === 'number' && Number.isFinite(value) === false ) { return `${value} (arrives as null)`; }
    if ( value !== null && typeof value === 'object' && Array.isArray(value) === false ) {
        const proto = Object.getPrototypeOf(value);
        if ( proto !== Object.prototype && proto !== null ) {
            return `${proto?.constructor?.name ?? 'class'} instance (arrives as a plain object, prototype lost)`;
        }
    }
    return null;
}

export function findJsonLossyValue(value, rootLabel = 'value') {
    const stack = [ [ value, rootLabel ] ];
    const seen = new Set();
    let inspected = 0;
    while ( stack.length !== 0 ) {
        if ( ++inspected > MAX_NODES_INSPECTED ) { return null; }
        const [ v, where ] = stack.pop();
        const lossy = describeLossy(v);
        if ( lossy !== null ) { return `${where}: ${lossy}`; }
        if ( v === null || typeof v !== 'object' ) { continue; }
        if ( seen.has(v) ) { return `${where}: circular reference (JSON cannot encode it)`; }
        seen.add(v);
        if ( Array.isArray(v) ) {
            for ( let i = 0; i < v.length; i++ ) {
                // In an array, undefined becomes null (the length is kept).
                if ( v[i] === undefined ) { return `${where}[${i}]: undefined (arrives as null)`; }
                stack.push([ v[i], `${where}[${i}]` ]);
            }
            continue;
        }
        for ( const key of Object.keys(v) ) {
            if ( v[key] === undefined ) { return `${where}.${key}: undefined (property disappears)`; }
            stack.push([ v[key], `${where}.${key}` ]);
        }
    }
    return null;
}
