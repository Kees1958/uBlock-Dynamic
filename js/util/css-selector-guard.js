// ── css-selector-guard.js ─────────────────────────────────────────────────────
// Structural check that a picked cosmetic selector cannot break out of the
// stylesheet it is injected into (10.7.13 hardening).
//
// Why: picked plain selectors end up joined into one USER-origin stylesheet,
// `${selectors.join(',\n')}{display:none!important;}` (filter-manager.js
// injectCustomFilters(), css-specific.js). A "selector" carrying `{`, `}`,
// `;`, `@` or a line break outside a quoted string would close that rule and
// add CSS of its own — at USER origin, which beats the page's !important.
// The picker page already compiles every selector before sending it; this is
// the service worker's own check of the same boundary (C6), so a message
// that did not come from a real pick cannot store one.
//
// What it is NOT: a full CSS parse. The full compiler (ExtSelectorCompiler +
// css-tree, ~200 KB) is not loaded in the service worker (C33, start-up
// cost). This guard only rejects the characters that let text escape a
// selector list; a selector that is merely invalid CSS is still possible
// and is dropped by the browser on its own, as before.
//
// Public interface:
//   isSafePickedSelector(value) — true when `value` is a plain selector, or
//       the picker's compiled procedural JSON, with nothing that can escape.
//   hidesWholePage(value)       — true when the rule would hide or remove
//       <html> or <body> itself (11.0.2, see WHOLE_PAGE_* below).
//
// Whole-page check (11.0.2): the picker now lists <html> and <body> in its
// element path (ported from uBO 9510a0b38c), so their classes can anchor a
// selector, e.g. `body.modal-open .overlay`. A picked rule whose final
// target is <html>/<body> itself would blank the whole site, so the picker
// page and the service worker's picker route (filter-routes.js
// handleAddCustomFilters) refuse it. Deliberately NOT part of
// isSafePickedSelector(): shipped filter lists, the Ad leftover cleaner data
// and the user's own imported rules may hide <body> on a specific page on
// purpose. A :style(), :remove-attr() or :remove-class() rule on them is
// allowed: it changes them without hiding the page.
//
// Dependencies: none (Tier 4, self-contained).

/******************************************************************************/
// Configuration — one place (user preference: declared together, commented)
/******************************************************************************/

// Outside a quoted string, none of these can appear in a selector list:
// braces and ';' end or open a rule, '@' starts an at-rule, '<' is the
// HTML-comment token CSS still tolerates, a backslash-escaped character is
// skipped separately below.
const FORBIDDEN_OUTSIDE_STRINGS = Object.freeze(new Set([ '{', '}', ';', '@', '<' ]));

// Any control character (U+0000–U+001F, U+007F) — includes \n, \r, \t and
// \f, the line breaks the upstream UXSS chain used to split one value into
// several filters. Never legitimate in a picked selector, quoted or not.
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

// The picker sends a procedural selector as JSON (compile() stringifies it,
// see ext-selector-compiler.js); a plain selector never starts with '{'.
const PROCEDURAL_JSON_PREFIX = '{';

// Procedural task operators whose argument is written into a stylesheet by
// css-procedural-api.js cssRuleFromProcedural(): the media query and the
// selector path. Every other operator runs in JS only (querySelector,
// regex, text match), so its argument may legitimately hold '{' etc.
const CSS_SINK_TASK_OPERATORS = Object.freeze(new Set([ 'matches-media', 'spath' ]));

// A :style() declaration list is written inside `{...}`, so ';' is allowed
// there, but nothing that closes the block or starts a new rule, and none of
// what the picker's own compileStyleProperties() already refuses (url(),
// image-set(), comments, '//', backslash escapes).
const STYLE_FORBIDDEN_RE = /[{}@<\\]|url\(|image-set\(|\/\*|\/\s*\//i;

// Elements that ARE the whole page. A hide/remove rule whose final target
// is one of these blanks the site.
const WHOLE_PAGE_TAGS = Object.freeze(new Set([ 'html', 'body' ]));

// `:root` is <html> written as a pseudo-class.
const WHOLE_PAGE_PSEUDO = ':root';

// Procedural actions that change an element without hiding or removing it,
// so they are fine on <html>/<body> (e.g. unlocking scrolling with :style).
// No action at all means "hide"; 'remove' deletes the element.
const NON_HIDING_ACTIONS = Object.freeze(new Set([ 'style', 'remove-attr', 'remove-class' ]));

// Procedural tasks that move the final target away from the base selector
// (to an ancestor, a sibling, a shadow root, an XPath result). The final
// target cannot be known from the text, so the whole-page check is skipped.
const TARGET_MOVING_TASKS = Object.freeze(new Set([ 'upward', 'spath', 'xpath', 'others', 'shadow' ]));

// Characters that separate compounds in a selector (combinators).
const COMBINATOR_CHARS = Object.freeze(new Set([ ' ', '\t', '\n', '\r', '\f', '>', '+', '~' ]));

/******************************************************************************/

// Walks the text once, skipping quoted strings and backslash escapes, and
// reports whether a forbidden character or a comment opener appears
// outside them. An unterminated string is rejected: in a stylesheet it
// would swallow the declaration block after it.
function hasEscapeOutsideStrings(text) {
    let quote = '';
    for ( let i = 0; i < text.length; i++ ) {
        const ch = text[i];
        if ( ch === '\\' ) { i++; continue; }          // escaped char: inert
        if ( quote !== '' ) {
            if ( ch === quote ) { quote = ''; }
            continue;
        }
        if ( ch === '"' || ch === "'" ) { quote = ch; continue; }
        if ( FORBIDDEN_OUTSIDE_STRINGS.has(ch) ) { return true; }
        if ( ch === '/' && text[i + 1] === '*' ) { return true; }
    }
    return quote !== '';
}

function isSafeSelectorText(text) {
    if ( typeof text !== 'string' ) { return false; }
    if ( CONTROL_CHAR_RE.test(text) ) { return false; }
    return hasEscapeOutsideStrings(text) === false;
}

function isSafeStyleText(text) {
    if ( typeof text !== 'string' ) { return false; }
    if ( CONTROL_CHAR_RE.test(text) ) { return false; }
    return STYLE_FORBIDDEN_RE.test(text) === false;
}

// The procedural form: a JSON object. Only the fields that reach a
// stylesheet are checked — the top-level selector (may be '' for a
// :matches-media-only rule), the matches-media/spath task arguments, and a
// style action's declarations; JS-only task arguments are left as they are.
function isSafeProceduralJson(value) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch {
        return false;
    }
    if ( parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ) { return false; }
    if ( isSafeSelectorText(parsed.selector) === false ) { return false; }
    if ( parsed.tasks !== undefined ) {
        if ( Array.isArray(parsed.tasks) === false ) { return false; }
        for ( const task of parsed.tasks ) {
            if ( Array.isArray(task) === false ) { return false; }
            if ( CSS_SINK_TASK_OPERATORS.has(task[0]) && isSafeSelectorText(task[1]) === false ) { return false; }
        }
    }
    if ( parsed.action !== undefined ) {
        if ( Array.isArray(parsed.action) === false ) { return false; }
        if ( parsed.action[0] === 'style' && isSafeStyleText(parsed.action[1]) === false ) { return false; }
    }
    return true;
}

// True when a single compound (no combinators) targets <html>/<body>:
// it starts with the tag name (`body`, `body.x`, `html[lang]`) or :root.
function isWholePageCompound(compound) {
    const c = compound.trim().toLowerCase();
    const match = /^[a-z][a-z0-9-]*/.exec(c);
    if ( match !== null && WHOLE_PAGE_TAGS.has(match[0]) ) { return true; }
    if ( c.startsWith(WHOLE_PAGE_PSEUDO) ) {
        return /^[a-z0-9-]/.test(c.slice(WHOLE_PAGE_PSEUDO.length)) === false;
    }
    return false;
}

// Splits a selector list at top-level commas and checks the LAST compound of
// each selector (the element it actually targets). Brackets, parentheses,
// quoted strings and backslash escapes are skipped, so `div:has(> body)` or
// `[data-x="a, b"]` are read correctly.
function selectorListTargetsWholePage(text) {
    let depth = 0;
    let quote = '';
    let compoundStart = 0;
    for ( let i = 0; i <= text.length; i++ ) {
        const ch = text[i];
        if ( i === text.length || (ch === ',' && depth === 0 && quote === '') ) {
            if ( isWholePageCompound(text.slice(compoundStart, i)) ) { return true; }
            compoundStart = i + 1;
            continue;
        }
        if ( ch === '\\' ) { i++; continue; }
        if ( quote !== '' ) {
            if ( ch === quote ) { quote = ''; }
            continue;
        }
        if ( ch === '"' || ch === "'" ) { quote = ch; continue; }
        if ( ch === '(' || ch === '[' ) { depth++; continue; }
        if ( ch === ')' || ch === ']' ) { depth = Math.max(depth - 1, 0); continue; }
        if ( depth === 0 && COMBINATOR_CHARS.has(ch) ) {
            // Trailing whitespace before a comma/end is not a combinator.
            if ( text.slice(i + 1).trim() === '' || /^\s*,/.test(text.slice(i + 1)) ) { continue; }
            compoundStart = i + 1;
        }
    }
    return false;
}

export function hidesWholePage(value) {
    if ( typeof value !== 'string' || value === '' ) { return false; }
    if ( value.startsWith(PROCEDURAL_JSON_PREFIX) === false ) {
        return selectorListTargetsWholePage(value);
    }
    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch {
        return false;   // not ours to judge: isSafeProceduralJson() refuses it
    }
    if ( parsed === null || typeof parsed !== 'object' ) { return false; }
    if ( Array.isArray(parsed.action) && NON_HIDING_ACTIONS.has(parsed.action[0]) ) { return false; }
    if ( Array.isArray(parsed.tasks) && parsed.tasks.some(t => Array.isArray(t) && TARGET_MOVING_TASKS.has(t[0])) ) { return false; }
    if ( typeof parsed.selector !== 'string' || parsed.selector === '' ) { return false; }
    return selectorListTargetsWholePage(parsed.selector);
}

export function isSafePickedSelector(value) {
    if ( typeof value !== 'string' || value === '' ) { return false; }
    if ( value.startsWith(PROCEDURAL_JSON_PREFIX) ) { return isSafeProceduralJson(value); }
    return isSafeSelectorText(value);
}
