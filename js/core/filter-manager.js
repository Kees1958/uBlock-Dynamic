/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/Kees1958/uBol-stripped
    Based on uBlock Origin Lite (https://github.com/gorhill/uBlock), modified in
    2026 for uBlock-Stripped-Dynamic — see CHANGELOG.md for the changes.
*/
/*
 * filter-manager.js — Custom cosmetic / element-picker rule storage and injection
 *
 * Public interface:
 *   addCustomFilters(hostname, selectors)   — saves picker-created rules to storage
 *   getAllCustomFilters()                   — returns all saved rules keyed by hostname
 *   getAllCustomFilterKeys()                — returns storage keys for all saved rules
 *   getSandboxFilters() / setSandboxFilters(text) — raw sandbox ABP text
 *   annotateRejectedSandboxLines({ rejectedLines, rejectedRegexes }) — (10.7.6) comments out unusable
 *                                             network lines with "! Rejected: <reason>" beneath
 *   startCustomFilters(tabId, frameId)     — injects css-user.js into a specific frame
 *   terminateCustomFilters(tabId, frameId) — removes css-user.js from a frame
 *   injectCustomFilters(tabId, frameId, hostname) — inserts CSS for picker rules
 *   deleteCustomFilter(hostname, selector) — removes one selector from one hostname's rules
 *   clearAllCustomFilters()                — removes every site.* rule
 *   deleteCustomFiltersMatching(filter)    — Manage Custom Rules' "Delete rules" button
 *   getAllCustomFiltersWithDates()         — dashboard-only variant of getAllCustomFilters()
 *                                             with each selector's createdAt attached
 *   importCosmeticFilters(hostname, entries) — Manage Custom Rules' Import,
 *                                             entries: { selector, createdAt }[]
 *   importCosmeticFiltersBulk(entriesByHostname) — same, but for many
 *                                             hostnames from one payload —
 *                                             batches the shared cosmetic-
 *                                             rule-dates read/write (3.2)
 *                                             AND the corpus read + index
 *                                             rebuild (3.3) across the
 *                                             whole set instead of once
 *                                             per hostname
 *   pruneCSSCache()                        — removes stale per-tab CSS injection records
 *   registerCustomFilters(context)         — builds and returns content-script directives
 *
 * Hostname-indexed cache: injectCustomFilters() and registerCustomFilters()
 * both read from an in-memory Map<hostname, { applyPlain, applyProcedural,
 * exceptionPlain, exceptionProcedural }> built by buildFilterIndex() from
 * site.* storage + the sandbox text, instead of re-reading storage /
 * re-parsing sandbox text on every call. The index is refreshed automatically
 * as part of writeToStorage()/removeFromStorage() —
 * the only two functions that ever mutate site.* / sandboxFilters storage in
 * this file — so every write path (addCustomFilters, deleteCustomFilter,
 * clearAllCustomFilters, setSandboxFilters) keeps it in sync structurally,
 * not by convention. Sandbox exception rules (`hostname#@#selector`) cancel
 * a matching apply selector at collection time — see
 * collectMatchingFilterEntries()'s own header for the exact semantics,
 * deliberately mirroring custom-scriptlets.js's identical feature.
 */


import {
    browser,
    localKeys,
    localRead,
    localRemove,
    localWrite,
} from '../data/ext.js';

import {
    intersectHostnameIters,
    isScriptlet,
    matchesFromHostnames,
    subtractHostnameIters,
    todayISODate,
    isValidISODate,
    isValidHostnamePattern,
    isBoundedString,
} from '../util/utils.js';
import { isSafePickedSelector } from '../util/css-selector-guard.js';

import { CUSTOM_COSMETIC_MAX } from './dnr-budgets.js';
import { syncScriptletRulesFromSandboxText } from './custom-scriptlets.js';
import { REJECTED_LINE_PREFIX } from '../data/editor-annotations.js';
import { createLock } from '../util/async-lock.js';
import { catchExpected, PAGE_INJECTION_EXPECTED_ERRORS } from '../data/expected-errors.js';

/******************************************************************************/

function isProcedural(a) { return a.startsWith('{'); }
function isCSS(a) { return isProcedural(a) === false && isScriptlet(a) === false; }

/******************************************************************************/
// Config — single source of truth for the sandbox cosmetic-line syntax and
// the CSS-join separator, per this project's config-in-one-place convention.
/******************************************************************************/

// Per-selector length bound (addCustomFilters() input validation, see its
// own comment) — generous enough for any real CSS/procedural selector a
// person or the picker would ever produce, small enough to reject a
// pathological single entry regardless of how few entries the request
// contains. Deliberately not part of CUSTOM_COSMETIC_MAX above — that
// caps total STORED entry count across all site.* keys; this caps the
// size of any one entry, an orthogonal concern.
const CUSTOM_SELECTOR_MAX_LENGTH = 2_000;

// Matches `hostname##selector` (apply) and `hostname#@#selector`
// (exception — cancels a matching apply selector; see
// collectMatchingFilterEntries() below) sandbox lines — plain CSS hide
// rules only, scriptlet calls (`##+js(...)` / `#@#+js(...)`) are excluded
// here via the negative lookahead (unaffected by the optional `@` capture,
// since the lookahead checks what follows the SECOND `#` either way) and
// handled entirely by custom-scriptlets.js. Previously duplicated inline
// in both injectCustomFilters() and registerCustomFilters(); now parsed
// once, in buildFilterIndex() below, per cache rebuild instead of per call.
const SANDBOX_COSMETIC_LINE_RE = /^([^#,\s]+)#(@?)#(?!\+js\()(.+)$/;

// (10.7.6) Every OTHER cosmetic syntax the Import ABP box sees. Such lines used to be skipped without a word; they
// are now commented out with the reason beneath (red), like every refused line (owner's rule since 10.7.2).
// Scriptlet forms (##+js(…), #%#, #@%#) are NOT here: js/core/custom-scriptlets.js handles and annotates them.
const SANDBOX_COSMETIC_MARKER_RE = /^(.*?)(#@?\?#|#@?\$\??#|\$@?\$|#@?#)(.*)$/;
const SANDBOX_SCRIPTLET_MARKER_RE = /#@?%#|#@?#\+js\(/;
const COSMETIC_REJECTION_REASONS = Object.freeze({
    NO_SITE:        'a cosmetic rule needs a site in front (example.com##…) — rules for every site are not supported',
    SEVERAL_SITES:  'several sites in one line are not supported — write one line per site (example.com##…)',
    EXCLUDED_SITE:  'excluding a site (~example.com) is not supported in a cosmetic rule',
    CSS_INJECTION:  '#$# (CSS injection) is not supported — hide the element with example.com##selector instead',
    EXTENDED_CSS:   '#?# (AdGuard extended CSS) is not supported — write it as example.com##selector',
    HTML_FILTER:    '$$ (HTML filtering) is not supported by Chrome extensions',
});

// One sandbox line -> null (not a plain cosmetic line: network, scriptlet, comment), { ok: true, hostname, selector,
// exception }, or { ok: false, reason }. The ONE place that decides what a sandbox cosmetic line means: used by
// buildFilterIndex() (what applies) and annotateUnusableCosmeticLines() (what the editor marks as refused).
function classifySandboxCosmeticLine(t) {
    // "#" starts a comment — except a cosmetic rule for every site ("##.ad", "#?#…", "#$#…"), which must be refused.
    if ( t === '' || t.startsWith('!') || (t.startsWith('#') && /^#@?[#?$]/.test(t) === false) ) { return null; }
    if ( SANDBOX_SCRIPTLET_MARKER_RE.test(t) ) { return null; }
    const m = SANDBOX_COSMETIC_LINE_RE.exec(t);
    if ( m ) {
        const hostname = m[1].toLowerCase();
        // '*' (unscoped) and exception-DOMAIN ('~') hostnames are
        // unsupported for sandbox cosmetic lines — unchanged from prior
        // behavior (predates exception-RULE support added here). Applies
        // identically to exception-rule lines (m[2] === '@') — an exception
        // rule still needs a concrete positive hostname to scope its
        // cancellation to, same as an apply rule needs one to scope its hiding to.
        if ( hostname === '*' ) { return { ok: false, reason: COSMETIC_REJECTION_REASONS.NO_SITE }; }
        if ( hostname.startsWith('~') ) { return { ok: false, reason: COSMETIC_REJECTION_REASONS.EXCLUDED_SITE }; }
        return { ok: true, hostname, selector: m[3], exception: m[2] === '@' };
    }
    const c = SANDBOX_COSMETIC_MARKER_RE.exec(t);
    if ( c === null ) { return null; }
    const [ , sites, marker ] = c;
    // A network rule can carry "#" or "$$" in its URL pattern — only a site list (or nothing) may precede the marker.
    if ( /^[^/|@*\s]*$/.test(sites) === false && sites !== '*' ) { return null; }
    if ( marker.includes('?') && marker.includes('$') === false ) { return { ok: false, reason: COSMETIC_REJECTION_REASONS.EXTENDED_CSS }; }
    if ( marker.startsWith('#') && marker.includes('$') ) { return { ok: false, reason: COSMETIC_REJECTION_REASONS.CSS_INJECTION }; }
    if ( marker.startsWith('$') ) { return { ok: false, reason: COSMETIC_REJECTION_REASONS.HTML_FILTER }; }
    if ( sites === '' || sites === '*' ) { return { ok: false, reason: COSMETIC_REJECTION_REASONS.NO_SITE }; }
    if ( sites.includes(',') ) { return { ok: false, reason: COSMETIC_REJECTION_REASONS.SEVERAL_SITES }; }
    if ( sites.startsWith('~') ) { return { ok: false, reason: COSMETIC_REJECTION_REASONS.EXCLUDED_SITE }; }
    return null;   // a shape this classifier does not know: left to the network compiler (it reports its own refusals)
}

// (10.7.6) Comments out every sandbox cosmetic line that cannot apply, with "! Rejected: <reason>" beneath. Pure:
// text in, { text, rejected } out. Idempotent — a commented line is a comment.
export function annotateUnusableCosmeticLines(text) {
    const out = [];
    const rejected = [];
    for ( const rawLine of String(text ?? '').split(/\r\n|\r|\n/) ) {
        const verdict = classifySandboxCosmeticLine(rawLine.trim());
        if ( verdict === null || verdict.ok ) { out.push(rawLine); continue; }
        out.push(`!${rawLine}`, `${REJECTED_LINE_PREFIX}${verdict.reason}`);
        rejected.push({ line: rawLine.trim(), reason: verdict.reason });
    }
    return { text: out.join('\n'), rejected };
}

// Separator used to join plain CSS selectors into one rule body. A single
// constant keeps the pre-joined per-hostname cache chunks (built once in
// buildFilterIndex()) byte-for-byte compatible with the final join across
// matched hostname levels in collectMatchingFilterEntries().
const CSS_JOIN_SEPARATOR = ',\n';

/******************************************************************************/

async function keysFromStorage() {
    return customFilterStorageLock.withLock(( ) => localKeys());
}

async function readFromStorage(key) {
    return customFilterStorageLock.withLock(( ) => localRead(key));
}

async function writeToStorage(key, value) {
    const result = await customFilterStorageLock.withLock(( ) => localWrite(key, value));
    // Single choke point for cache invalidation: every write of site.* or
    // sandboxFilters storage in this file funnels through here (or
    // removeFromStorage() below) — refreshing the index here, rather than
    // separately at each call site, makes "forgot to invalidate after a
    // write" structurally impossible instead of something to remember per
    // caller. Same reasoning as custom-scriptlets.js's
    // writeCustomScriptletRules().
    await refreshCustomFilterIndex();
    return result;
}

async function removeFromStorage(keyOrKeys) {
    const result = await customFilterStorageLock.withLock(( ) => localRemove(keyOrKeys));
    await refreshCustomFilterIndex();  // see writeToStorage()'s comment above
    return result;
}

// Bulk-safe sibling to writeToStorage() above — OPTIMIZE.md 3.3. Writes
// every [ key, value ] pair through the exact same serialised
// customFilterStorageLock queue (so a bulk import can never race a concurrent
// single-item write), but calls refreshCustomFilterIndex() ONCE after
// every write has landed, instead of once per write. writeToStorage()
// itself is untouched — every existing single-item caller (addCustomFilters,
// deleteCustomFilter, etc.) keeps its immediate-refresh guarantee exactly
// as before; only a genuine multi-key batch (currently:
// importCosmeticFiltersBulk() below) should ever call this instead.
// Found missing while porting this fix to a sibling extension (AdShield
// Extra) — see PORTING_9_4_9_ISSUES_FOUND.md item 8: without this,
// importCosmeticFiltersBulk() paid for a full corpus scan + full index
// rebuild once per hostname in the batch, not once per batch.
async function writeManyToStorage(entries) {
    // One lock step for the whole batch: the writes stay in order and a failed write stops the
    // rest of the batch, exactly as the old chained writes did.
    await customFilterStorageLock.withLock(async ( ) => {
        for ( const [ key, value ] of entries ) {
            await localWrite(key, value);
        }
    });
    await refreshCustomFilterIndex();
}

// customFilterStorageLock serialises write operations to prevent concurrent
// storage mutations from racing.
// Note: reads intentionally bypass this queue (use localRead() directly)
// so Promise.all() over multiple reads resolves independently. See v3.0.3
// fix note — never use readFromStorage() inside Promise.all().
// (10.7.6) createLock() (js/util/async-lock.js), not a raw `p = p.then(fn)` chain: with a raw chain ONE rejected
// step left the chain rejected, so every later step was skipped until the service worker restarted. The lock runs
// each step after the previous one SETTLED, and each caller still sees its own failure (C21: reuse the proven lock).
const customFilterStorageLock = createLock('custom-filter-storage');

/******************************************************************************/

// REMOVED (audit 9.7.5) — customFiltersFromHostname(): exported, never
// imported or called anywhere (verified by grep across js/, dashboard/,
// popup/, matrix/, privacy/, picker/ and tools/). Its ancestor-walk
// semantics live on in the index-based lookup below, which replaced it.

/******************************************************************************/

async function getAllCustomFilterKeys() {
    const storageKeys = await keysFromStorage() || [];
    return storageKeys.filter(a => a.startsWith('site.'));
}

/******************************************************************************/

export async function getAllCustomFilters() {
    const keys = await getAllCustomFilterKeys();
    const results = await Promise.all(keys.map(k => localRead(k)));
    return keys.map((k, i) => [ k.slice(5), results[i] ?? [] ]);
}

// Dashboard-only variant of getAllCustomFilters() above — attaches each
// selector's createdAt date. Deliberately a SEPARATE function rather than
// changing getAllCustomFilters() itself: that one's plain-string-array
// shape is relied on by the runtime content-script generation path
// (compiled-filters.js) and by this file's own internal callers
// (addCustomFilters()' cap-counting, the hostname-index cache builder) —
// changing it to embed date objects would mean updating all of those for
// a purely cosmetic (pun intended) dashboard display need. Falls back to
// today for any selector with no recorded date — the only remaining
// source of a dateless selector now that the one-time backfill migration
// this fallback used to be belt-and-suspenders alongside
// (backfillCosmeticRuleDates(), removed in 10.0.3 along with every other
// pre-10.0.3 upgrade step — see CHANGELOG_HISTORY.md's 10.0.3 entry) no
// longer runs at all. Shape: [ [ hostname, [ { selector, createdAt } ] ] ].
export async function getAllCustomFiltersWithDates() {
    const [ entries, dates ] = await Promise.all([
        getAllCustomFilters(),
        readCosmeticRuleDates(),
    ]);
    const stamp = todayISODate();
    return entries.map(([ hostname, selectors ]) => {
        const hostDates = dates.get(hostname);
        return [
            hostname,
            selectors.map(selector => {
                const createdAt = hostDates?.get(selector);
                return { selector, createdAt: isValidISODate(createdAt) ? createdAt : stamp };
            }),
        ];
    });
}

// Single-hostname import path — used by importCosmeticFilters() below.
// Mutates `dates` in place; does not read or write it to storage — that's
// the caller's own responsibility.
//
// UPDATE (OPTIMIZE.md 3.3): importCosmeticFiltersBulk() further below
// USED to share this function (one read + one addCustomFilters() call per
// hostname), but that per-item shape was itself the cost 3.3 fixed — the
// bulk path now applies entries against a single in-memory corpus
// snapshot instead. The two paths still apply the identical dedup/cap
// rule (via the shared computeUpdatedSelectors()) and the identical
// import-date rule (via the shared resolveImportedSelectorDate()) — see
// each helper's own comment — so they cannot diverge on behavior, just on
// how many storage round-trips it costs to get there.
async function applyCosmeticImportForHostname(hostname, entries, dates) {
    if ( hostname === '' || !Array.isArray(entries) || entries.length === 0 ) { return false; }
    const validEntries = entries.filter(e => e && typeof e.selector === 'string' && e.selector !== '');
    if ( validEntries.length === 0 ) { return false; }
    const before = await readFromStorage(`site.${hostname}`) || [];
    const beforeSet = new Set(before);
    const added = await addCustomFilters(hostname, validEntries.map(e => e.selector), dates);
    if ( !added ) { return false; }
    // Only stamp dates for selectors that were actually NEW here — one
    // that already existed on this install already has its own (correct,
    // earlier) date from addCustomFilters()' own bookkeeping, which a
    // re-import shouldn't reset to whatever this file happened to export.
    const newlyAdded = validEntries.filter(e => !beforeSet.has(e.selector));
    if ( newlyAdded.length === 0 ) { return true; }
    const hostDates = dates.get(hostname) ?? new Map();
    for ( const { selector, createdAt } of newlyAdded ) {
        // Only overwrite the today's-date stamp addCustomFilters() itself
        // already wrote if the import file provided a valid earlier date
        // — an import with no/garbled date data still ends up with
        // TODAY as a reasonable fallback, already handled.
        if ( isValidISODate(createdAt) ) { hostDates.set(selector, createdAt); }
    }
    dates.set(hostname, hostDates);
    return true;
}

// Pure — no IO. The createdAt an imported selector should actually be
// recorded with: the import file's own date if it's a valid ISO date,
// else today. This is the exact net effect applyCosmeticImportForHostname()
// above already produces (addCustomFilters() stamps today's date for
// every newly-added selector via its own `sharedDates` bookkeeping, then
// applyCosmeticImportForHostname() overwrites it when the import supplied
// a valid date) — pulled out as its own pure rule so
// importCosmeticFiltersBulk() below can apply the identical rule without
// going through addCustomFilters()' per-item IO. See B15: this is the one
// piece of applyCosmeticImportForHostname()'s logic the bulk path needs
// to match exactly, so it's named and shared rather than re-derived.
function resolveImportedSelectorDate(createdAt) {
    return isValidISODate(createdAt) ? createdAt : todayISODate();
}

// Manage Custom Rules' Import — counterpart to addCustomFilters() above,
// but accepting { selector, createdAt } entries (the shape
// getAllCustomFiltersWithDates() exports) instead of bare selector
// strings, so an imported rule's ORIGINAL creation date survives the
// round-trip rather than every imported selector getting today's date.
// Same cap/dedup logic as addCustomFilters() — delegates to it for the
// actual selectors write, then layers the date-preservation on top,
// since duplicating that logic here would be two places to keep in sync
// with CUSTOM_COSMETIC_MAX enforcement.
/** @public Reference implementation for the bulk-import equivalence test (tools/test-core-modules-dry-run.mjs). */
export async function importCosmeticFilters(hostname, entries) {
    const dates = await readCosmeticRuleDates();
    const added = await applyCosmeticImportForHostname(hostname, entries, dates);
    if ( added ) { await writeCosmeticRuleDates(dates); }
    return added;
}

// Bulk counterpart to importCosmeticFilters() above, for Manage Custom
// Rules' Import / Settings restore importing many hostnames from one
// payload (see OPTIMIZE.md 3.2). `entriesByHostname` is an iterable of
// [ hostname, entries ] pairs — same entries shape importCosmeticFilters()
// itself accepts. Reads the shared cosmetic-rule-dates map once, applies
// every hostname, writes once for the whole batch — instead of
// importCosmeticFilters()'s own full read+write of that same shared
// structure, repeated once per hostname (3.2's own fix).
//
// OPTIMIZE.md 3.3: this used to delegate to applyCosmeticImportForHostname()
// -> addCustomFilters() once per hostname. Each of those per-item calls
// independently re-read the ENTIRE site.* corpus for its own global-cap
// check (getAllCustomFilters()) and, via writeToStorage(), triggered a
// full refreshCustomFilterIndex() rebuild (another full corpus scan +
// sandbox re-parse + index rebuild) on every single write — for N
// hostnames in one import, that was N full corpus scans and N full index
// rebuilds, a cost layered underneath the dates-map fix 3.2 already made,
// and easy to miss because writeToStorage() looks like a plain storage
// write from its own call site. Found while porting the 3.1/3.2 fixes to
// a sibling extension (AdShield Extra) — see
// PORTING_9_4_9_ISSUES_FOUND.md item 8.
//
// Fixed the same way as 3.1/3.2: read the site.* corpus ONCE into an
// in-memory Map, apply every hostname against that snapshot via
// computeUpdatedSelectors() — the exact same pure dedup/cap rule
// addCustomFilters() itself uses, not a second copy (B15) — keeping a
// running `totalExisting` count in sync instead of re-scanning storage
// per hostname, then batch every changed key through writeManyToStorage()
// above, which rebuilds the index once for the whole batch instead of
// once per key. Returns the Set of hostnames that actually got something
// new — same contract as before.
export async function importCosmeticFiltersBulk(entriesByHostname) {
    const dates = await readCosmeticRuleDates();

    // One-time snapshot standing in for every per-hostname
    // getAllCustomFilters() call the old path made. totalExisting is kept
    // in sync as each hostname below is processed, so the global
    // CUSTOM_COSMETIC_MAX cap is enforced exactly as addCustomFilters()
    // enforces it — without re-reading storage per hostname.
    const allEntries = await getAllCustomFilters();
    const selectorsByHostname = new Map(allEntries);
    let totalExisting = allEntries.reduce((n, [, s]) => n + s.length, 0);

    const addedHostnames = new Set();
    const pendingWrites = [];

    for ( const [ hostname, entries ] of entriesByHostname ) {
        if ( hostname === '' || !Array.isArray(entries) || entries.length === 0 ) { continue; }
        if ( isValidHostnamePattern(hostname) === false ) { continue; }
        const validEntries = entries.filter(e => e && typeof e.selector === 'string' && e.selector !== '');
        if ( validEntries.length === 0 ) { continue; }

        const existingSelectors = selectorsByHostname.get(hostname) ?? [];
        const available = Math.max(0, CUSTOM_COSMETIC_MAX - totalExisting + existingSelectors.length);
        const { selectors, newlyAdded } = computeUpdatedSelectors(
            existingSelectors, validEntries.map(e => e.selector), available
        );
        if ( selectors.length === existingSelectors.length ) { continue; }

        totalExisting += selectors.length - existingSelectors.length;
        selectorsByHostname.set(hostname, selectors);
        pendingWrites.push([ `site.${hostname}`, selectors ]);
        addedHostnames.add(hostname);

        // Stamp dates only for selectors that actually landed here — same
        // "keep the earlier date, don't reset it on re-import" rule
        // applyCosmeticImportForHostname() applies for the single-
        // hostname path, via the shared resolveImportedSelectorDate() rule
        // above. newlyAdded is already deduped by computeUpdatedSelectors(),
        // so every entry here is a selector that is genuinely new to this
        // hostname's stored set.
        const createdAtBySelector = new Map();
        for ( const e of validEntries ) {
            if ( !createdAtBySelector.has(e.selector) ) { createdAtBySelector.set(e.selector, e.createdAt); }
        }
        const hostDates = dates.get(hostname) ?? new Map();
        for ( const selector of newlyAdded ) {
            hostDates.set(selector, resolveImportedSelectorDate(createdAtBySelector.get(selector)));
        }
        dates.set(hostname, hostDates);
    }

    if ( pendingWrites.length > 0 ) { await writeManyToStorage(pendingWrites); }
    if ( addedHostnames.size > 0 ) { await writeCosmeticRuleDates(dates); }
    return addedHostnames;
}

// (10.0.3) backfillCosmeticRuleDates() — the one-time migration step that
// stamped a createdAt date onto any selector that predated date-tracking —
// was removed along with every other pre-10.0.3 upgrade step; see
// CHANGELOG_HISTORY.md's 10.0.3 entry. getAllCustomFiltersWithDates()'s own
// per-read fallback (above) is now the only place a dateless selector is
// ever given one.

/******************************************************************************/
// Hostname-indexed cache — avoids, on every committed navigation, both the
// per-ancestor-level storage reads (one localRead() per hostname level)
// that the old, now-removed customFiltersFromHostname() cost, and a full
// re-parse of the sandbox text (previously repeated inline
// in injectCustomFilters() AND registerCustomFilters() on every call). Built
// once, refreshed only when site.* storage or the sandbox text actually
// change — see writeToStorage()/removeFromStorage() above and
// setSandboxFilters() below, the only ways either can change.
//
// Bonus, near-free once this cache exists at all: each bucket's plain CSS
// selectors are pre-joined into one string at build time, not on every
// match — collectMatchingFilterEntries() only joins the (few) per-level
// chunks it actually matched, not every individual selector, every time.
/******************************************************************************/

// In-memory only — lost on service worker restart, same convention as
// custom-scriptlets.js's customScriptletRuleIndex. Self-heals via
// ensureCustomFilterIndex()'s lazy-build check below: a restart just means
// the next call rebuilds it, not a stale-forever cache.
let customFilterIndex;

// index: Map<hostname, { applyPlain: string[], applyProcedural: string[],
//                         exceptionPlain: Set<string>, exceptionProcedural: Set<string> }>
//
// Exceptions are NEVER persisted to site.* storage — only sandbox text can
// author one (the element picker only ever creates apply-type hide rules;
// there's no "pick an element to un-hide" action), so this index is the
// only place they exist at all, rebuilt fresh from raw sandbox text on
// every cache refresh. This is why exception support needed no storage
// schema change and no migration, unlike it might first appear.
//
// Selectors are kept as arrays/Sets here, NOT pre-joined into one CSS
// string per hostname like an earlier version of this cache did — joining
// early would make it impossible for collectMatchingFilterEntries() below
// to cancel an apply selector against an exception declared at a
// DIFFERENT (ancestor) hostname level, the same cross-level cancellation
// custom-scriptlets.js's collectMatchingRules() already does for
// scriptlet exceptions. The join happens once, in
// collectMatchingFilterEntries(), against the final post-cancellation set
// — still just once per navigated frame, not once per selector.
function buildFilterIndex(entries, sandboxText) {
    const raw = new Map(); // hostname -> { apply: string[], exception: string[] }

    function bucketFor(hostname) {
        let bucket = raw.get(hostname);
        if ( bucket === undefined ) {
            bucket = { apply: [], exception: [] };
            raw.set(hostname, bucket);
        }
        return bucket;
    }

    function addSelector(hostname, selector, isException) {
        const bucket = bucketFor(hostname);
        const list = isException ? bucket.exception : bucket.apply;
        if ( !list.includes(selector) ) { list.push(selector); }
    }

    // site.* storage entries (picker + import) are always apply-type —
    // exceptions can only come from the sandbox text loop below.
    for ( const [ hostname, selectors ] of entries ) {
        for ( const selector of selectors ) { addSelector(hostname, selector, false); }
    }

    for ( const line of (sandboxText ?? '').split(/\n|\r\n|\r/) ) {
        // (10.7.6) classifySandboxCosmeticLine() decides — the same function that marks refused lines in the editor.
        const verdict = classifySandboxCosmeticLine(line.trim());
        if ( verdict === null || verdict.ok === false ) { continue; }
        addSelector(verdict.hostname, verdict.selector, verdict.exception);
    }

    // Split each level's apply/exception lists into plain CSS vs
    // procedural selectors — same isCSS/isProcedural split as before, just
    // no longer immediately joined into one string (see this function's
    // own header comment on why).
    const index = new Map();
    for ( const [ hostname, bucket ] of raw ) {
        index.set(hostname, {
            applyPlain: bucket.apply.filter(isCSS),
            applyProcedural: bucket.apply.filter(isProcedural),
            exceptionPlain: new Set(bucket.exception.filter(isCSS)),
            exceptionProcedural: new Set(bucket.exception.filter(isProcedural)),
        });
    }
    return index;
}

async function refreshCustomFilterIndex() {
    try {
        const [ entries, sandboxText ] = await Promise.all([
            getAllCustomFilters(),
            getSandboxFilters(),
        ]);
        customFilterIndex = buildFilterIndex(entries, sandboxText);
    } catch (reason) {
        // Guard: a failed rebuild must not corrupt or blank out an index
        // that was already working — leave whatever's currently cached
        // (possibly still `undefined` on a first-ever call, which
        // ensureCustomFilterIndex() below will simply retry on its next
        // call) rather than let one storage hiccup silently stop every
        // custom cosmetic rule from matching until the next edit. Same
        // reasoning as custom-scriptlets.js's refreshCustomScriptletRuleIndex().
        console.error('[uBlock-Dynamic] refreshCustomFilterIndex:', reason);
    }
}

// Guard: explicit, synchronous release of the cached index. Still not
// called anywhere — the bulk-import path this was originally anticipating
// (OPTIMIZE.md 3.3, importCosmeticFiltersBulk() above) ended up using
// writeManyToStorage()'s single immediate refreshCustomFilterIndex() call
// instead of a lazy invalidate, to keep the same "index is correct the
// instant the call returns" guarantee addCustomFilters()'s own comment
// documents needing (registerContentScripts() reads the index right after).
// Kept in reserve for any future path that's genuinely fine paying for a
// lazy rebuild on next access instead.
function invalidateCustomFilterIndex() {
    customFilterIndex = undefined;
}

async function ensureCustomFilterIndex() {
    if ( customFilterIndex === undefined ) {
        await refreshCustomFilterIndex();
    }
    return customFilterIndex;
}

// Ancestor-walk semantics: the hostname itself, then each parent domain
// (a.b.example.com → b.example.com → example.com → com), matching the old,
// now-removed customFiltersFromHostname() exactly — but
// against the pre-built index (O(levels) map lookups) instead of firing one
// localRead() per level and re-parsing the sandbox text inline.
//
// Exception cancellation — same cross-level pattern as custom-scriptlets.js's
// collectMatchingRules(): gather every apply AND exception selector across
// the WHOLE ancestor chain first, then drop any apply selector that
// exact-matches an exception selector from ANYWHERE in that same collected
// set (regardless of which level either was declared at) — an exception at
// a broader hostname can cancel an apply rule inherited from that same
// broader level when visiting a narrower host, exactly mirroring how a
// broader-level scriptlet exception cancels an inherited apply scriptlet.
// Exceptions themselves are never part of the output — they only suppress.
function collectMatchingFilterEntries(index, pageHostname) {
    const applyPlain = [];
    const applyProcedural = [];
    const exceptionPlain = new Set();
    const exceptionProcedural = new Set();

    let current = pageHostname;
    for ( ;; ) {
        const bucket = index.get(current);
        if ( bucket !== undefined ) {
            applyPlain.push(...bucket.applyPlain);
            applyProcedural.push(...bucket.applyProcedural);
            for ( const s of bucket.exceptionPlain ) { exceptionPlain.add(s); }
            for ( const s of bucket.exceptionProcedural ) { exceptionProcedural.add(s); }
        }
        const dot = current.indexOf('.');
        if ( dot === -1 ) { break; }
        current = current.slice(dot + 1);
    }

    // Fast path — no exceptions anywhere in the collected set, nothing to
    // cancel (mirrors collectMatchingRules()'s identical fast path).
    const finalPlain = exceptionPlain.size === 0
        ? applyPlain
        : applyPlain.filter(s => !exceptionPlain.has(s));
    const finalProcedural = exceptionProcedural.size === 0
        ? applyProcedural
        : applyProcedural.filter(s => !exceptionProcedural.has(s));

    return {
        plainCSS: finalPlain.length !== 0 ? finalPlain.slice().sort().join(CSS_JOIN_SEPARATOR) : '',
        proceduralSelectors: finalProcedural,
    };
}

/******************************************************************************/

export function startCustomFilters(tabId, frameId) {
    return browser.scripting.executeScript({
        files: [ '/js/scripting/css-user.js' ],
        target: { tabId, frameIds: [ frameId ] },
        injectImmediately: true,
    }).catch(reason => {
        console.error(`[uBlock-Dynamic] startCustomFilters/${reason}`);
    })
}

export function terminateCustomFilters(tabId, frameId) {
    return browser.scripting.executeScript({
        files: [ '/js/scripting/css-user-terminate.js' ],
        target: { tabId, frameIds: [ frameId ] },
        injectImmediately: true,
    }).catch(reason => {
        console.error(`[uBlock-Dynamic] terminateCustomFilters/${reason}`);
    })
}

/******************************************************************************/

export async function injectCustomFilters(tabId, frameId, hostname) {
    const index = await ensureCustomFilterIndex();
    if ( index === undefined ) { return; }  // rebuild failed — see its own guard comment

    const { plainCSS, proceduralSelectors } = collectMatchingFilterEntries(index, hostname);
    if ( plainCSS === '' && proceduralSelectors.length === 0 ) { return; }

    const promises = [];
    if ( plainCSS !== '' ) {
        promises.push(
            browser.scripting.insertCSS({
                css: `${plainCSS}{display:none!important;}`,
                origin: 'USER',
                target: { tabId, frameIds: [ frameId ] },
            }).catch(catchExpected('apply picked hiding rules (insertCSS)', PAGE_INJECTION_EXPECTED_ERRORS))
        );
    }
    if ( proceduralSelectors.length !== 0 ) {
        promises.push(
            browser.scripting.executeScript({
                files: [
                    '/js/scripting/css-api.js',
                    '/js/scripting/css-procedural-api.js',
                ],
                target: { tabId, frameIds: [ frameId ] },
                injectImmediately: true,
            }).catch(catchExpected('apply picked procedural rules', PAGE_INJECTION_EXPECTED_ERRORS))
        );
    }
    await Promise.all(promises);
    return { plainCSS, proceduralSelectors };
}

/******************************************************************************/

export async function registerCustomFilters(context) {
    // Reuses the same hostname-indexed cache as injectCustomFilters() — see
    // the "Hostname-indexed cache" section above. Both storage's site.*
    // entries and sandbox-text-derived rules are already merged and split
    // into plain/procedural per hostname there, so this no longer needs its
    // own separate rebuild-from-storage + sandbox-text reparse.
    const index = await ensureCustomFilterIndex();
    if ( index === undefined || index.size === 0 ) { return; }

    // A hostname only qualifies if its bucket actually has something to
    // inject — precomputed once per bucket at cache-build time now, instead
    // of re-checked here via customFilters.get(a).some(isCSS/isProcedural)
    // on every registerContentScripts() call.
    //
    // Own-level-only check (ignores ancestor inheritance AND exception
    // cancellation, both of which are only resolved later, at actual
    // injection time in collectMatchingFilterEntries()) — same scope this
    // check always had, before exception support existed. A hostname whose
    // only apply selector happens to be fully cancelled by an exception
    // will still register css-user.js here and simply inject nothing —
    // harmless, just a very minor unnecessary registration, not a
    // correctness bug.
    let hostnames = Array.from(index.keys()).filter(hostname => {
        const bucket = index.get(hostname);
        return bucket.applyPlain.length !== 0 || bucket.applyProcedural.length !== 0;
    });
    if ( hostnames.length === 0 ) { return; }

    const { none } = context.filteringModeDetails;
    let excludeHostnames = [];
    if ( none.has('all-urls') ) {
        const { basic } = context.filteringModeDetails;
        // BUG FIXED: `basic` always carries a bookkeeping 'all-urls' member
        // (mode-manager.js's defaultFilteringModes = { basic: ['all-urls'] },
        // never cleared by setDefaultFilteringMode(NONE) — only `none` is
        // touched) — it means "the default level is basic", not "the
        // hostname literally called all-urls is pinned to basic". Passing
        // that raw Set straight into intersectHostnameIters() is wrong: that
        // helper explicitly special-cases the literal string 'all-urls' as
        // "matches everything" (see js/util/utils.js), so it silently
        // treated a fresh/default `basic` — with ZERO real per-site pins —
        // as "everything is pinned to basic", which meant every sandbox/
        // picker custom cosmetic rule kept being registered (and therefore
        // applied via css-user.js) during a full site-off or temp-disable
        // pause, no matter which hostname it targeted. Strip the sentinel
        // before this call so only genuine per-site pins survive.
        const realBasicHostnames = [ ...basic ].filter(hn => hn !== 'all-urls');
        hostnames = intersectHostnameIters(hostnames, realBasicHostnames);
    } else if ( none.size !== 0 ) {
        hostnames = [ ...subtractHostnameIters(hostnames, none) ];
        excludeHostnames = Array.from(none);
    }
    if ( hostnames.length === 0 ) { return; }

    const directive = {
        id: 'css-user',
        js: [ '/js/scripting/css-user.js' ],
        matches: matchesFromHostnames(hostnames),
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: 'document_start',
    };
    if ( excludeHostnames.length !== 0 ) {
        directive.excludeMatches = matchesFromHostnames(excludeHostnames);
    }

    context.toAdd.push(directive);
}

/******************************************************************************/

/******************************************************************************/
// Cosmetic rule creation dates — Manage Custom Rules' "created" column.
// Separate storage key from site.* itself (site.* selectors are stored as
// bare strings, not objects, precisely so the runtime content-script
// generation path — compiled-filters.js, injectCustomFilters(), and
// every other site.* reader in this file — never has to know or care
// about this dashboard-only metadata; changing the site.* value shape
// would touch all of those). Own serialized-write queue, same reasoning
// as customFilterStorageLock above, kept separate from it since these writes
// are otherwise unrelated to the site.* hostname-index cache and
// shouldn't be forced to wait behind it or vice versa. Shape:
// { [hostname]: { [selector]: 'YYYY-MM-DD' } }.
/******************************************************************************/

const COSMETIC_DATES_STORAGE_KEY = 'cosmeticRuleDates';
const cosmeticDatesLock = createLock('cosmetic-rule-dates');   // same reason as customFilterStorageLock

// chrome.storage.local only stores plain JSON-serializable values — Map
// isn't one, so these are the boundary conversions between the in-memory
// nested-Map representation and the on-disk plain-object one. Same
// pattern as matrix-block-rules.js's mapToPlainObject()/
// objectToNestedMap() (duplicated here rather than shared — this file
// and that one are otherwise unrelated, and it's two small functions).
function datesMapToPlainObject(map) {
    const out = {};
    for ( const [ hostname, hostDates ] of map ) {
        out[hostname] = Object.fromEntries(hostDates);
    }
    return out;
}

function datesObjectToNestedMap(obj) {
    const map = new Map();
    for ( const [ hostname, hostDates ] of Object.entries(obj ?? {}) ) {
        map.set(hostname, new Map(Object.entries(hostDates ?? {})));
    }
    return map;
}

// Map<hostname, Map<selector, 'YYYY-MM-DD'>> — dynamically-keyed at BOTH
// levels (arbitrary hostnames, arbitrary selector strings) with entries
// actually deleted (see deleteCustomFilter()/deleteCustomFiltersMatching()
// below), the same combination that forces a V8 plain object into
// dictionary mode — see matrix-block-rules.js's ensureLoaded() for the
// full reasoning, identical here.
async function readCosmeticRuleDates() {
    return datesObjectToNestedMap(await cosmeticDatesLock.withLock(( ) => localRead(COSMETIC_DATES_STORAGE_KEY)));
}

async function writeCosmeticRuleDates(dates) {
    return cosmeticDatesLock.withLock(( ) => localWrite(COSMETIC_DATES_STORAGE_KEY, datesMapToPlainObject(dates)));
}

/******************************************************************************/

// Pure — no IO, no shared-state mutation. Given a hostname's existing
// selectors, the candidate selectors to add, and how many additional
// slots remain under CUSTOM_COSMETIC_MAX, returns the updated (sorted,
// deduped, length-bounded) selectors array and which candidates actually
// landed. Extracted out of addCustomFilters() below (OPTIMIZE.md 3.3) so
// importCosmeticFiltersBulk() further down can reuse the exact same
// dedup/cap/length-validation rule instead of a second copy that could
// silently drift from this one — the specific failure mode B15 warns
// about.
function computeUpdatedSelectors(existingSelectors, toAdd, availableSlots) {
    const selectors = existingSelectors.slice();
    const newlyAdded = [];
    let added = 0;
    for ( const selector of toAdd ) {
        // Reject anything that isn't a plausible, bounded-length selector
        // string before it ever reaches storage — the count cap above
        // already stops unbounded growth, this stops one absurdly-long
        // entry from being accepted regardless of how few entries the
        // request contains.
        if ( isBoundedString(selector, CUSTOM_SELECTOR_MAX_LENGTH) === false ) { continue; }
        // (10.7.14) Nothing that could escape the injected stylesheet is
        // stored, whichever path adds it — the picker route, Import custom
        // rules and Restore settings all pass through here (one place).
        if ( isSafePickedSelector(selector) === false ) { continue; }
        if ( selectors.includes(selector) ) { continue; }
        if ( added >= availableSlots ) { break; }
        selectors.push(selector);
        newlyAdded.push(selector);
        added++;
    }
    if ( newlyAdded.length > 0 ) { selectors.sort(); }
    return { selectors, newlyAdded };
}

// Input validation (C6) — added by the security-audit pass that found this
// boundary accepted hostname/toAdd essentially as-is (see
// Security_evaluatie.md's Medium finding #1). `hostname` here should
// already be background-derived/trusted by the caller (filter-routes.js's
// handleAddCustomFilters() — see its own comment on why it no longer
// trusts a request-supplied hostname), but this function is the actual
// storage boundary and validates independently of who's calling it,
// exactly like every other exported function taking external input in
// this codebase (C6) — a future caller that skips the trusted-sender
// derivation shouldn't get a free pass just because this one does it
// correctly today.
export async function addCustomFilters(hostname, toAdd, sharedDates) {
    if ( isValidHostnamePattern(hostname) === false ) { return false; }
    if ( Array.isArray(toAdd) === false || toAdd.length === 0 ) { return false; }
    const key = `site.${hostname}`;
    const existingSelectors = await readFromStorage(key) || [];
    // Enforce global cap across all site.* keys before adding new selectors.
    const allEntries = await getAllCustomFilters();
    const totalExisting = allEntries.reduce((n, [, s]) => n + s.length, 0);
    const available = Math.max(0, CUSTOM_COSMETIC_MAX - totalExisting + existingSelectors.length);
    const { selectors, newlyAdded } = computeUpdatedSelectors(existingSelectors, toAdd, available);
    if ( selectors.length === existingSelectors.length ) { return false; }
    // Bug fix: MUST be awaited, not fire-and-forget. writeToStorage()
    // internally does `await refreshCustomFilterIndex()` — the ONLY
    // thing that rebuilds the in-memory index registerCustomFilters()
    // (called right after this function returns, via background.js's
    // handleAddCustomFilters() -> registerContentScripts()) reads from.
    // ensureCustomFilterIndex() only rebuilds when the index is
    // undefined; otherwise it hands back whatever's currently cached.
    // Without this await, addCustomFilters() could return `true` before
    // that rebuild lands, so registerContentScripts() could register the
    // content script for future page loads using the STALE index — i.e.
    // one that doesn't include the selector just added here — and
    // nothing re-registers afterward to self-correct. Symptom this
    // caused: a brand-new picker rule hid its element immediately (that
    // path — injectCustomFilters(), triggered by the picker's own
    // startCustomFilters message — reads storage directly for the
    // current tab, independent of this registration) but did not
    // survive a page refresh, while older rules (already correctly
    // registered by an earlier, fully-settled registerContentScripts()
    // call, e.g. at service-worker startup) kept working. Confirmed via
    // testing across multiple versions, including the pristine
    // unmodified original, before this fix.
    await writeToStorage(key, selectors);
    // Only for the selectors that actually landed (dedup/cap can mean
    // fewer than toAdd.length) — a selector that already existed here
    // keeps its own earlier date, not today's.
    if ( newlyAdded.length > 0 ) {
        const dates = sharedDates ?? await readCosmeticRuleDates();
        const hostDates = dates.get(hostname) ?? new Map();
        const stamp = todayISODate();
        for ( const selector of newlyAdded ) { hostDates.set(selector, stamp); }
        dates.set(hostname, hostDates);
        if ( !sharedDates ) { await writeCosmeticRuleDates(dates); }
    }
    return true;
}

/******************************************************************************/

// Deletes one selector from one hostname's site.* entry (dashboard/monitor
// "delete rule" action). Routed through writeToStorage()/removeFromStorage()
// — not a direct localWrite()/localRemove() at the caller (see
// js/workflow/background.js's handleDeleteCosmeticRule) — so the hostname
// cache above is guaranteed to be refreshed as part of the same operation,
// not left for the caller to remember.
export async function deleteCustomFilter(hostname, selector) {
    const key = `site.${hostname}`;
    const selectors = await localRead(key) || [];
    const filtered = selectors.filter(s => s !== selector);
    if ( filtered.length === 0 ) {
        await removeFromStorage(key);
    } else {
        await writeToStorage(key, filtered);
    }
    const dates = await readCosmeticRuleDates();
    const hostDates = dates.get(hostname);
    if ( !hostDates || !hostDates.has(selector) ) { return; }
    hostDates.delete(selector);
    if ( hostDates.size === 0 ) { dates.delete(hostname); }
    await writeCosmeticRuleDates(dates);
}

// Removes every site.* entry (dashboard "clear all cosmetic rules" action).
// Same rationale as deleteCustomFilter() above: routed through
// removeFromStorage() so the cache is released and rebuilt as one atomic
// step instead of a bulk localRemove() at the caller that forgets to.
export async function clearAllCustomFilters() {
    const keys = await getAllCustomFilterKeys();
    if ( keys.length === 0 ) { return; }
    // Immediate, synchronous release: drop the (soon-stale) cached index
    // right away rather than leave it serving now-being-deleted entries for
    // the duration of the awaited bulk removeFromStorage() call below.
    // removeFromStorage() rebuilds it fresh once the removal completes.
    invalidateCustomFilterIndex();
    await removeFromStorage(keys);
    await writeCosmeticRuleDates(new Map());
}

// Manage Custom Rules' "Delete rules" toolbar button — deletes every
// site.* entry whose hostname CONTAINS filter (case-insensitive), or
// EVERY entry when filter is '' (no filter active = delete all, the
// same "smart delete" behavior clearAllCustomFilters() above used to be
// the only way to get). Same "contains" matching the dashboard's own
// domain filter already uses (see custom-rules.js's matchesFilter()), so
// "delete what's currently shown" and "what's currently filtered" can
// never disagree. Returns the count of hostnames actually deleted, for
// the dashboard's result summary.
export async function deleteCustomFiltersMatching(filter) {
    const keys = await getAllCustomFilterKeys();
    const needle = (filter ?? '').toLowerCase();
    const matchingKeys = needle === ''
        ? keys
        : keys.filter(k => k.slice(5).toLowerCase().includes(needle)); // slice(5) strips the 'site.' prefix
    if ( matchingKeys.length === 0 ) { return 0; }
    invalidateCustomFilterIndex();
    await removeFromStorage(matchingKeys);
    const matchingHostnames = matchingKeys.map(k => k.slice(5));
    const dates = await readCosmeticRuleDates();
    let datesChanged = false;
    for ( const hostname of matchingHostnames ) {
        if ( !dates.has(hostname) ) { continue; }
        dates.delete(hostname);
        datesChanged = true;
    }
    if ( datesChanged ) { await writeCosmeticRuleDates(dates); }
    return matchingKeys.length;
}

/******************************************************************************/

export function getSandboxFilters() {
    return localRead('sandboxFilters');
}

// (10.7.6) Network lines the import could not use: commented out, with "! Rejected: <reason>" beneath (shown in red),
// the same treatment scriptlet and $popup lines get in setSandboxFilters() below — the owner's rule since 10.7.2 for
// EVERY refused line. Called after the compile (rejectedLines from js/offscreen/compile-filters.js) and after the
// DNR update (rejectedRegexes: Chrome's isRegexSupported() refused the regex). Idempotent: a commented line is never
// matched again. Returns the number of lines annotated.
export async function annotateRejectedSandboxLines({ rejectedLines = [], rejectedRegexes = [] } = {}) {
    if ( rejectedLines.length === 0 && rejectedRegexes.length === 0 ) { return 0; }
    const text = await getSandboxFilters();
    if ( typeof text !== 'string' || text === '' ) { return 0; }
    const reasonByLine = new Map(rejectedLines.map(r => [ String(r.line).trim(), String(r.reason) ]));
    const regexReasons = rejectedRegexes.map(r => [ `/${r.regex}/`, `Chrome refuses this regular expression (${r.reason ?? 'unknown reason'})` ]);
    const out = [];
    let annotated = 0;
    for ( const rawLine of text.split(/\r\n|\r|\n/) ) {
        const t = rawLine.trim();
        let reason;
        if ( t !== '' && t.startsWith('!') === false ) {
            reason = reasonByLine.get(t) ?? regexReasons.find(([ pattern ]) => t.startsWith(pattern))?.[1];
        }
        if ( reason === undefined ) { out.push(rawLine); continue; }
        out.push(`!${rawLine}`, `${REJECTED_LINE_PREFIX}${reason}`);
        annotated += 1;
    }
    if ( annotated !== 0 ) {
        console.warn(`[uBlock-Dynamic] ABP import: ${annotated} network line(s) cannot be used — commented out with the reason`);
        await writeToStorage('sandboxFilters', out.join('\n'));
    }
    return annotated;
}

export async function setSandboxFilters(text = '') {
    text = text.trim();
    // Sync scriptlet (`##+js(...)` / AdGuard `#%#//scriptlet(...)`) lines
    // separately — these are never handled by the plain-CSS-selector paths
    // above (injectCustomFilters/registerCustomFilters both explicitly
    // exclude scriptlet lines). See js/core/custom-scriptlets.js and
    // Custom-Rule-Scriptlets-Plan.md.
    //
    // The text this function persists is syncScriptletRulesFromSandboxText's
    // returned `text`, NOT the raw input — any rejected scriptlet line comes
    // back commented out with a `! Rejected: ...` explanation directly below
    // it, so the editor shows *why* a rule didn't take effect instead of
    // silently dropping it. All non-scriptlet lines (plain cosmetic/network
    // filters, existing comments) pass through unchanged.
    const { rejected, text: scriptletAnnotatedText } = await syncScriptletRulesFromSandboxText(text);
    if ( rejected.length > 0 ) {
        console.warn('[uBlock-Dynamic] sandbox scriptlet lines rejected:', rejected);
    }
    // (10.7.6) Same for cosmetic lines that cannot apply (no site, several sites, #$#, #?#, $$ …).
    const cosmetic = annotateUnusableCosmeticLines(scriptletAnnotatedText);
    if ( cosmetic.rejected.length > 0 ) {
        console.warn('[uBlock-Dynamic] sandbox cosmetic lines rejected:', cosmetic.rejected);
    }
    const annotatedText = cosmetic.text;
    // Routed through writeToStorage()/removeFromStorage() — not a direct
    // localWrite()/localRemove() — so the hostname cache above picks up
    // sandbox-derived selector changes too. See those functions' own
    // invalidation comment.
    const result = annotatedText !== ''
        ? await writeToStorage('sandboxFilters', annotatedText)
        : await removeFromStorage('sandboxFilters');
    return result;
}
