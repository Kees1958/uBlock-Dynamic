// ── tools/build/cosmetic-data.mjs ─────────────────────────────────────────────────────
// Cosmetic rules: parser, dispatch-table shape config, cosmetic JS file builder, SPECIFIC-DATA generator and version stamp.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: COSMETIC_SPECIFIC_CONFIG, DISPATCH_SHAPE_CONFIG, buildCosmeticFile, buildCosmeticSpecificData, buildCosmeticSpecificLoader, parseCosmeticRules, stampCosmeticSpecificData
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import { droppedGenericDomainQualifiers } from './build-state.mjs';
import { GENERIC_DOMAIN_QUALIFIER_RE, filterGenericDomainQualifier, isTLDKept } from './tld-scope.mjs';

/******************************************************************************/
// Cosmetic rule parser
// Parses domain##selector lines, returns Map<hostname, Set<selector>>
// Exceptions (#@#) are applied to suppress matching hide rules.
// Skips: generic (no domain), procedural (#?#), CSS inject (#$#), scriptlets (#%#)
/******************************************************************************/

export function parseCosmeticRules(text, tldCheckFn = isTLDKept, allowGenericDomainQualifier = false) {
    const hideMap   = new Map();   // hostname → Set<selector>
    const exceptMap = new Map();   // hostname → Set<selector>

    for ( const line of text.split('\n') ) {
        const t = line.trim();
        if ( !t || t.startsWith('!') ) { continue; }
        if ( t.includes('#%#') || t.includes('#$#') || t.includes('#?#') ) { continue; }
        // GUARD (audit 10.6.4): a uBO scriptlet line is never a hide rule. build-steps.mjs converts these before
        // parsing (ubo-scriptlet-syntax.mjs); this second line of defence keeps any that slip through (another entry
        // path, a future caller) from becoming an invalid "+js(…)" selector that disables the site's whole CSS rule.
        if ( t.includes('#+js(') ) { continue; }

        // Generic form: [$domain=...]##selector. Same architectural limit
        // as the scriptlet case above (see that comment) — the cosmetic
        // dispatch table is also a static hostname→CSS lookup, so a
        // regex-scoped generic rule has nowhere to attach. Logged, always
        // dropped, TLD check run for the log entry only.
        if ( allowGenericDomainQualifier ) {
            const gm = GENERIC_DOMAIN_QUALIFIER_RE.exec(t);
            if ( gm ) {
                const kept = filterGenericDomainQualifier(gm[1], tldCheckFn);
                droppedGenericDomainQualifiers.push({
                    line: t,
                    wouldKeep: kept !== null,
                    reason: 'no static dispatch path for regex-scoped generic rules',
                });
                continue;
            }
        }
        if ( t.startsWith('[') ) { continue; }

        const isException = t.includes('#@#');
        const sepIdx = isException ? t.indexOf('#@#') : t.indexOf('##');
        if ( sepIdx === -1 ) { continue; }

        const domainPart = t.slice(0, sepIdx).trim();
        const selector   = t.slice(sepIdx + (isException ? 3 : 2)).trim();

        if ( !domainPart || domainPart.startsWith('~') || !selector ) { continue; }

        const hostnames = domainPart.split(',').map(h => h.trim()).filter(Boolean);
        const target = isException ? exceptMap : hideMap;

        for ( const rawHn of hostnames ) {
            if ( rawHn.startsWith('~') ) { continue; }
            const hn = rawHn.toLowerCase();
            if ( !tldCheckFn(hn) ) { continue; }
            if ( !target.has(hn) ) { target.set(hn, new Set()); }
            target.get(hn).add(selector);
        }
    }

    // Apply exceptions
    for ( const [hn, selectors] of exceptMap ) {
        if ( !hideMap.has(hn) ) { continue; }
        for ( const sel of selectors ) { hideMap.get(hn).delete(sel); }
        if ( hideMap.get(hn).size === 0 ) { hideMap.delete(hn); }
    }

    return hideMap;
}

/******************************************************************************/
// Dispatch-table SHAPE config (Phase 1.5 — closure-avoidance).
// Shared by both buildCosmeticFile() and buildScriptletFile() below — one
// place for the knobs controlling how EITHER per-ruleset dispatch table is
// shaped, since both used to have (and both are fixed here) the exact same
// underlying problem.
//
// Phase 1 (5.6.0) trimmed what data goes into each per-hostname call site.
// This trims HOW that data is stored: previously every single hostname got
// its own `()=>{...}` arrow-function closure in the dispatch table, even
// though at most one ever runs per page load. That means V8 had to
// allocate one throwaway closure per hostname (~11,697 for AdGuard Base's
// scriptlet file alone) on every page/frame, purely as a side effect of
// the table's SHAPE — not because the logic needs them.
//
// Fix, applied identically to both file types: the dispatch table holds
// plain data per hostname (a CSS string for cosmetics; an array of
// [fnIndex, uniqueId, args] triples for scriptlets) and ONE shared
// interpreter loop — written once per file, not once per hostname — does
// the actual work for whichever single entry matched. For scriptlets,
// function bodies move from named consts (`f0`, `f1`, ...) into one `FNS`
// array, indexed the same way, so `fnIndex` doubles as both the FNS lookup
// key AND the scriptlet's `name` value (see SCRIPTLET_SOURCE_CONFIG below
// for why any short, non-empty, per-scriptlet-unique value satisfies every
// corelib body's use of `.name` — a number satisfies that exactly as well
// as the short string it replaces) — so no separate `name` field needs to
// be stored at all anymore.
//
// Also switches the dispatch table itself from a `{}` object literal
// (which inherits from Object.prototype — a hostname literally named
// "constructor" or "toString" could theoretically collide with an
// inherited property instead of a real entry) to `Object.create(null)`,
// matching real uBOL's own defensive pattern. Cheap, zero downside.
export const DISPATCH_SHAPE_CONFIG = Object.freeze({
    USE_PLAIN_DATA_TABLE: true,   // data + shared loop, not per-hostname closures
    USE_NULL_PROTO_TABLE: true,   // Object.create(null) instead of {}
});

/******************************************************************************/
// Cosmetic JS file builder
// Generates a self-executing dispatch script that injects CSS per hostname
// via adoptedStyleSheets (synchronous, no flash of unstyled content).
/******************************************************************************/

export function buildCosmeticFile(cosmeticMap) {
    if ( cosmeticMap.size === 0 ) { return null; }

    // Plain hostname -> CSS-text data (no per-hostname closure) per
    // DISPATCH_SHAPE_CONFIG above.
    const entries = [];
    for ( const [hn, selectors] of cosmeticMap ) {
        const esc = hn.replace(/'/g, "\\'");
        const css = [...selectors]
            .map(s => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`'))
            .join(',\n');
        entries.push(`'${esc}':\`${css}\``);
    }

    const tableDecl = DISPATCH_SHAPE_CONFIG.USE_NULL_PROTO_TABLE
        ? `const m=Object.assign(Object.create(null),{${entries.join(',')}});`
        : `const m={${entries.join(',')}};`;
    // Shared dispatch loop — written ONCE per file regardless of hostname
    // count. try/catch is still per-application (one bad selector set
    // must not break the rest — same guarantee as before), but that
    // try/catch is now interpreter code, not duplicated per hostname.
    const dispatchLoop = [
        'const h=location.hostname;let p=h;',
        'for(;;){const c=m[p];if(c){try{const s=new CSSStyleSheet();',
        's.replaceSync(c+"{display:none!important}");',
        'document.adoptedStyleSheets=[...document.adoptedStyleSheets,s]}catch(e){}}',
        'const i=p.indexOf(".");if(i<0||!p.slice(i+1).includes("."))break;p=p.slice(i+1)}',
    ].join('');

    return [
        '(()=>{"use strict";',
        tableDecl,
        dispatchLoop,
        '})();',
    ].join('');
}

/******************************************************************************/
// Cosmetic SPECIFIC-DATA generator (compact storage-backed format)
//
// LIVE — this IS what registerCosmeticContentScriptsImpl() registers today
// (js/scripting/css-specific.js reading chrome.storage.local, per that
// function's own comment in js/core/scripting-manager.js). The paragraph
// that used to be here ("PARKED / not yet wired into registration... css-
// specific.js currently dead code, never wired up") was accurate when
// written but was never updated after the switch actually happened —
// scripting-manager.js's own comment is the authoritative, current
// account; this one was stale documentation contradicting reality, not a
// second true statement. buildCosmeticFile() below is kept only to
// produce test-fixtures/legacy-cosmetic/, ground truth for tools/check-
// cosmetic-specific-format-equivalence.mjs — it is NOT shipped and NOT
// consulted by registration, exactly as scripting-manager.js's comment
// says.
//
// Deliberately simpler than the full contract css-specific.js's reader
// supports, because OUR data never exercises the more general cases:
//   - No negative (exception/unhide) selector indices — parseCosmeticRules()
//     above already resolves #@# exceptions by subtracting them from
//     hideMap BEFORE cosmeticMap is ever returned (see its own "Apply
//     exceptions" step). By the time this function sees cosmeticMap, every
//     selector remaining is a plain apply-selector — this generator never
//     needs to emit a bitwise-complemented index.
//   - No procedural ('{'-prefixed JSON) selectors — parseCosmeticRules()
//     explicitly skips any line containing '#?#'/'#$#'/'#%#' at parse time;
//     only plain '##selector' lines ever reach cosmeticMap.
//   - No regex-based hostname matching — cosmeticMap's keys are always
//     plain hostnames (or the literal '*' wildcard) from a comma-split
//     domain list, never a regex pattern. regexes is always [].
//
// hasEntities IS a real, computed boolean (not hardcoded) — BUG FIX: it
// used to be hardcoded false here, on the claim that "nothing in this
// pipeline currently produces an entity-style hostname key". That claim
// was simply wrong — parseCosmeticRules() splits a rule's domain list on
// commas and stores each token as-is, with no special handling for ABP's
// entity convention, so a source rule like "kat.*##selector" produces the
// literal Map key "kat.*" same as any other token. Verified against real
// shipped data: 416 such entries across 11 rulesets (AdGuard Base alone:
// 331 — kat.*, yts.*, ebay.*, google.*, gmx.*, and more). With hasEntities
// hardcoded false, css-specific.js's reader (js/scripting/css-specific.js)
// never calls its own — already correct — entity-matching branch
// (isolatedAPI.contexts.entities), so every one of these entries was
// silently unreachable: present in the shipped data, contributing to file
// size, never once actually matching a page. Same fix shape as
// js/offscreen/make-cosmetic-filters.js's own makeCosmeticScripts()
// already uses correctly (`hasEntities ||= hn.endsWith('.*')`) — ported
// from there rather than reinvented (C21).
//
// Bare-TLD entries (the hostname IS a whole TLD, e.g. literal "pl" or
// literal "com") get the SAME treatment as every other hostname here —
// no special-casing. This format's fuller ancestor-walk depth (see
// isolated-api.js's contexts.hostnames — it walks all the way to the bare
// TLD and '*', unlike the OLD embedded-blob dispatch loop, which stops
// one level short and never reaches these at all — see CHANGELOG.md for
// the full trace) means these start matching real hostnames for the
// first time. Confirmed deliberate, not an authoring accident, by
// checking the actual raw upstream source: e.g. EasyList Polish's
// `pl,com,info,starnowa.tv##.td-a-rec` explicitly combines a ccTLD with
// generic gTLDs and a specific site in ONE rule — the filter author is
// knowingly blanket-covering a pattern observed to cross TLD boundaries,
// not scoping to Poland by accident. An earlier version of this function
// excluded generic TLDs from this fix specifically because that intent
// couldn't yet be confirmed; it's now verified directly against the raw
// source, so the exclusion was removed rather than left in as unwarranted
// caution.
//
// CRITICAL correctness constraint, verified against isolated-api.js's real
// binarySearch(), not assumed: the `hostnames` array MUST be sorted by
// LENGTH ASCENDING, with lexicographic order only as a tiebreak for equal
// lengths — binarySearch() compares `needle.length - candidate.length`
// FIRST. A plain alphabetical sort here would silently corrupt every
// lookup (wrong or missing matches, no error) — this is exactly the
// failure mode the differential test (tools/check-cosmetic-specific-
// format-equivalence.mjs) exists to catch before this ever reaches
// registration.
export function buildCosmeticSpecificData(cosmeticMap) {
    if ( cosmeticMap.size === 0 ) { return null; }

    // Shared, deduplicated selector pool — same dedup spirit as
    // buildCustomScriptletsDispatch()'s fnVarMap, applied to selector text
    // instead of function bodies.
    const selectorIndex = new Map(); // selector string -> index in `selectors`
    const selectors = [];
    const selectorListIndex = new Map(); // comma-joined-indices string -> index in `selectorLists`
    const selectorLists = [];

    // hostnames/selectorListRefs built as parallel arrays, sorted together
    // at the end — length-ascending-then-lexicographic, per the CRITICAL
    // correctness constraint above.
    const hostnameEntries = []; // { hostname, selectorListRef }
    let hasEntities = false;

    for ( const [ hostname, selectorSet ] of cosmeticMap ) {
        hasEntities ||= hostname.endsWith('.*');
        const indices = [];
        for ( const selector of selectorSet ) {
            let idx = selectorIndex.get(selector);
            if ( idx === undefined ) {
                idx = selectors.length;
                selectors.push(selector);
                selectorIndex.set(selector, idx);
            }
            indices.push(idx);
        }
        // Matches css-specific.js's own read side exactly: `JSON.parse('['
        // + selectorLists[ilist] + ']')` — so what's stored here must be
        // valid content for that wrapping, i.e. a bare comma-joined list of
        // integers, nothing else.
        const key = indices.join(',');
        let listRef = selectorListIndex.get(key);
        if ( listRef === undefined ) {
            listRef = selectorLists.length;
            selectorLists.push(key);
            selectorListIndex.set(key, listRef);
        }
        hostnameEntries.push({ hostname, selectorListRef: listRef });
    }

    hostnameEntries.sort((a, b) => {
        const d = a.hostname.length - b.hostname.length;
        if ( d !== 0 ) { return d; }
        return a.hostname < b.hostname ? -1 : (a.hostname > b.hostname ? 1 : 0);
    });

    return {
        hostnames: hostnameEntries.map(e => e.hostname),
        selectorListRefs: hostnameEntries.map(e => e.selectorListRef),
        selectorLists,
        selectors,
        hasEntities,
        regexes: [],
    };
}

/******************************************************************************/
// Cosmetic SPECIFIC-DATA version stamp + per-ruleset loader.
//
// AS OF 7.7.9 this data IS wired into registration — see
// js/core/scripting-manager.js's registerCosmeticContentScriptsImpl() and
// this file's own header note on the 7.7.9 CHANGELOG entry for the
// skipped-verification caveat. buildCosmeticFile() above is still built
// and shipped alongside this (untouched, unused by the live path) as the
// documented rollback target — see CHANGELOG.md's "COSMETIC-RULE
// OPTIMIZATION STATUS" block (top of file) "Fallback / rollback" section.
//
// COSMETIC_SPECIFIC_CONFIG — single place for both knobs this generator's
// runtime consumer (scripting-manager.js) needs to agree with:
//   STORAGE_KEY_PREFIX  must match css-specific.js's own hardcoded
//                        `css.specific.${rulesetId}` read exactly — changing
//                        one without the other silently breaks every lookup
//                        (wrong/missing matches, no error), same failure
//                        mode as the hostname-sort-order constraint above.
//   VERSION_FIELD       the key under which shortHash()'s output is stored
//                        INSIDE the data object itself, so the runtime can
//                        tell "already have this, no storage.local write
//                        needed" apart from "stale, must rewrite" without a
//                        second round-trip or a separate manifest field.
export const COSMETIC_SPECIFIC_CONFIG = Object.freeze({
    STORAGE_KEY_PREFIX: 'css.specific.',
    VERSION_FIELD: 'v',
});

// Small, deterministic (non-crypto) string hash — used ONLY to let the
// runtime detect whether a ruleset's compact cosmetic-specific data
// changed between builds, so registerCosmeticContentScriptsImpl() can
// skip rewriting chrome.storage.local on every registration pass when
// nothing actually changed (most calls — ruleset toggles, site-mode
// changes — don't touch this data at all). Collisions are an accepted,
// low-stakes risk here: worst case is one unnecessary storage write, not
// a correctness bug, so this deliberately isn't a cryptographic hash.
function shortHash(str) {
    let h = 0;
    for ( let i = 0, n = str.length; i < n; i++ ) {
        h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

// Stamps buildCosmeticSpecificData()'s output with a version field derived
// from its own content — called once per ruleset, right before writing the
// JSON file, so the stamp and the file it describes can never drift apart.
export function stampCosmeticSpecificData(data) {
    if ( data === null ) { return null; }
    // Hash everything except the version field itself (which doesn't
    // exist yet at this point) — order-stable since buildCosmeticSpecificData()
    // already returns keys in a fixed, deterministic order.
    const stamped = { ...data };
    stamped[COSMETIC_SPECIFIC_CONFIG.VERSION_FIELD] = shortHash(JSON.stringify(data));
    return stamped;
}

// Tiny per-ruleset loader — sets self.specificImports so the SHARED
// css-specific.js content script (one copy, registered for every cosmetic
// ruleset) knows which chrome.storage.local key to read for THIS
// particular registration. Mirrors registerScriptletContentScripts()'s
// existing per-scriptlet registration pattern structurally (one small
// per-item file feeding a shared interpreter) — see that function's own
// comment in js/core/scripting-manager.js.
//
// Deliberately just one line, no dispatch logic of its own — this is NOT
// a repeat of the old embedded-blob problem (see the file-size table in
// CHANGELOG.md's 5.7.0/7.7.9 entries): a single-element array literal is
// bytes, not kilobytes, regardless of how many hostnames the ruleset it
// points to actually has.
export function buildCosmeticSpecificLoader(rulesetId) {
    const esc = rulesetId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `self.specificImports=['${esc}'];`;
}
