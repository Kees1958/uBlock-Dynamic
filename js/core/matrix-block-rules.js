/*
 * matrix-block-rules.js — Matrix panel per-SITE, per-domain override
 *                          storage + DNR sync
 *
 * Public interface:
 *   getMatrixOverridesForSite(site) — { [domain]: { all, code } } for ONE
 *                                       site only (site = eTLD+1 of the
 *                                       page being browsed)
 *   setMatrixOverride(site, domain, scope, action)
 *                                    — scope: 'all' | 'code'
 *                                      action: 'block' | 'allow' | null (clears)
 *   getMatrixBlockRules()           — one entry per (site, domain) pair
 *                                      with ANY active override, block OR
 *                                      allow (name kept for API stability
 *                                      — see message-types.js), shaped
 *                                      for Manage Custom Rules
 *                                      ({ uid, site, domain, all, code },
 *                                      all/code are 'block'|'allow'|null)
 *   deleteMatrixBlockRule(uid)      — clears BOTH scopes for that
 *                                      (site, domain) pair; uid encodes
 *                                      both (see uidFor/parseUid below)
 *   clearMatrixBlockRules()         — clears EVERY override (block or
 *                                      allow) across every (site, domain)
 *                                      pair — matches what
 *                                      getMatrixBlockRules() now shows
 *   restoreMatrixBlockRules()       — release guard counterpart: rebuilds
 *                                      DNR rules from storage on SW
 *                                      restart
 *   importMatrixOverrides(rules)    — merges an array of { site, domain,
 *                                      all, code } entries (Manage Custom
 *                                      Rules' Import) into existing
 *                                      overrides; returns count imported
 *   deleteMatrixOverridesMatching(filter) — deletes every (site, domain)
 *                                      pair matching filter on either
 *                                      field ('' = delete all); Manage
 *                                      Custom Rules' "Delete rules" button
 *
 * PER-SITE, NOT global — confirmed explicitly against the real
 * 3P-Matrix-lite source (its own matrixRules is a flat, global,
 * domain-only map — see rule-builder.js's buildMatrixOverrideRules(),
 * which reads Object.keys(matrixRules) directly with no site nesting).
 * This fork deliberately diverges: blocking badsite.com while browsing
 * example.org does NOT block it while browsing other.com. Each DNR rule
 * below carries BOTH initiatorDomains: [site] AND requestDomains: [domain]
 * to express that.
 *
 * Two independent scopes per (site, domain) pair:
 *   'all'  — every third-party resource type from that domain, on that site
 *   'code' — only script / sub_frame ("3P-code" in the panel)
 * Both start null (no override). Clicking a scope's cell in the panel sets
 * it to whichever action the panel's current mode implies (block in
 * "default"/filtered mode, allow in "show everything" mode — see
 * matrix/matrix-panel.js's header) or clears it if already set to that
 * action.
 *
 * DNR rule IDs: MATRIX_RULES_BASE_ID range (see dnr-budgets.js). Each
 * (site, domain) pair can contribute up to 2 dynamic rules (one per
 * overridden scope). Rebuilt in full on every change.
 */

import { localRead, localWrite } from '../data/ext.js';
import { dnr } from '../data/ext-compat.js';
import { todayISODate, isValidISODate } from '../util/utils.js';
import {
    MATRIX_RULES_BASE_ID,
    MATRIX_RULES_MAX_DNR,
    MATRIX_RULES_ALL_PRIORITY,
    MATRIX_RULES_CODE_PRIORITY,
    MATRIX_OVERRIDES_MAX,
} from './dnr-budgets.js';

const STORAGE_KEY = 'matrixOverrides';

// BUG FIX (found while answering a question about custom-rule caps):
// MATRIX_OVERRIDES_MAX was defined in dnr-budgets.js but never actually
// checked anywhere — setMatrixOverride() and importMatrixOverrides()
// both wrote to `overrides` with no count limit at all. Distinct from,
// and in ADDITION to, MATRIX_RULES_MAX_DNR above (which only bounds how
// many overrides ever get synced into a live DNR rule) — without this
// storage-level cap, overrides beyond MATRIX_RULES_MAX_DNR could still
// accumulate indefinitely in storage as "phantom" entries: listed in
// Manage Custom Rules as active block/allow rules, but never actually
// enforced, since they'd fall outside the DNR-sync window. Same "count
// existing (site, domain) pairs, only new pairs count against the cap"
// reasoning in both call sites below — toggling scope on an
// already-present pair is never itself growth.
function totalOverrideCount() {
    let total = 0;
    for ( const siteEntries of overrides.values() ) { total += siteEntries.size; }
    return total;
}

// "3P-code" resource types — script, frame. DNR's resourceType string for
// "frame" is 'sub_frame', not 'frame' — translated here, the one place it
// actually matters, rather than leaking the DNR-specific spelling into
// every caller (matches the panel's own 'frame' naming).
//
// websocket deliberately removed (was present through 8.1.2): neither
// websocket nor its modern QUIC-based counterpart, webtransport, are
// "code" in any literal sense — the browser never parses or executes
// their payload, it only hands received data to whatever script is
// already running on the page (see the discussion that led to this
// change). Kept in this scope for a while under the reasoning that it's
// a live channel closely associated with a third party's active script
// behavior, but that reasoning cuts both ways: adding webtransport for
// parity would have made "3P-code" broader and less accurate to its own
// name, not more so. Removed instead, so "3P-code" means what it says —
// script and frame, the two resource types that can actually deliver
// executable code — and third-party live-channel blocking is left to
// "3P-all" (which already covers every resource type, this one
// included) rather than being partially, inconsistently folded into
// "code".
const CODE_RESOURCE_TYPES = Object.freeze([ 'script', 'sub_frame' ]);

/******************************************************************************/
// uid encoding — a (site, domain) pair as one string, for Manage Custom
// Rules' delete-by-uid interface. '::' separator: neither site nor domain
// hostnames can legally contain ':', so this can't collide/ambiguate.
/******************************************************************************/

function uidFor(site, domain) {
    return `${site}::${domain}`;
}

function parseUid(uid) {
    const i = uid.indexOf('::');
    if ( i === -1 ) { return null; }
    return { site: uid.slice(0, i), domain: uid.slice(i + 2) };
}

/******************************************************************************/
// Lazy-loaded cache — mirrors static-block-check.js's pattern (build once,
// explicit release guard, never silently stale).
/******************************************************************************/

let overrides = null; // null until first load — shape: Map<site, Map<domain, { all, code, createdAt }>>
let loadPromise = null;

// chrome.storage.local only stores plain JSON-serializable values — Map
// isn't one, so these are the two boundary conversions between the
// in-memory nested-Map representation and the on-disk plain-object one.
// Generic/recursive rather than hardcoding the 2-level (site -> domain)
// nesting, so it stays correct if this ever grows another level.
function mapToPlainObject(map) {
    const out = {};
    for ( const [ key, value ] of map ) {
        out[key] = value instanceof Map ? mapToPlainObject(value) : value;
    }
    return out;
}

function objectToNestedMap(obj) {
    const map = new Map();
    for ( const [ key, value ] of Object.entries(obj ?? {}) ) {
        map.set(key, new Map(Object.entries(value ?? {})));
    }
    return map;
}

async function persistOverrides() {
    await localWrite(STORAGE_KEY, mapToPlainObject(overrides));
}

async function ensureLoaded() {
    if ( overrides !== null ) { return; }
    if ( loadPromise === null ) {
        // Nested Map, not nested plain objects — overrides accumulates
        // dynamically-keyed entries (arbitrary site/domain hostname
        // strings) with actual property DELETION on top (see
        // setMatrixOverride()/deleteMatrixBlockRule() below), which is
        // specifically the combination that forces a V8 plain object
        // into "dictionary mode" (V8 can't revert a hidden-class
        // transition once a property is removed, only add new ones) —
        // Map is hash-table-backed from the start and never suffers
        // this fallback, plus O(1) .size instead of an
        // Object.keys(...).length allocation, and .delete() with none
        // of the same penalty. Read in full on every syncDNRRules()
        // call, so this is worth getting right even though (unlike
        // matrix-panel.js's entriesByDomain/matrixOverridesCache) this
        // file's own functions only run on explicit user actions, not
        // on every network request.
        loadPromise = localRead(STORAGE_KEY).then(stored => {
            overrides = objectToNestedMap(stored);
        });
    }
    await loadPromise;
}

function isEmptyEntry(entry) {
    return !entry || (!entry.all && !entry.code);
}

/******************************************************************************/
// DNR sync
/******************************************************************************/

async function syncDNRRules() {
    const dnrRules = [];
    let index = 0;
    for ( const [ site, domains ] of overrides ) {
        for ( const [ domain, entry ] of domains ) {
            if ( isEmptyEntry(entry) ) { continue; }

            if ( entry.all === 'allow' || entry.all === 'block' ) {
                if ( index < MATRIX_RULES_MAX_DNR ) {
                    dnrRules.push({
                        id: MATRIX_RULES_BASE_ID + index,
                        priority: MATRIX_RULES_ALL_PRIORITY,
                        action: { type: entry.all },
                        condition: {
                            initiatorDomains: [ site ],
                            requestDomains: [ domain ],
                            domainType: 'thirdParty',
                        },
                    });
                    index++;
                }
            }
            if ( entry.code === 'allow' || entry.code === 'block' ) {
                if ( index < MATRIX_RULES_MAX_DNR ) {
                    dnrRules.push({
                        id: MATRIX_RULES_BASE_ID + index,
                        priority: MATRIX_RULES_CODE_PRIORITY,
                        action: { type: entry.code },
                        condition: {
                            initiatorDomains: [ site ],
                            requestDomains: [ domain ],
                            domainType: 'thirdParty',
                            resourceTypes: [ ...CODE_RESOURCE_TYPES ],
                        },
                    });
                    index++;
                }
            }
        }
    }

    const existing = await dnr.getDynamicRules();
    const removeRuleIds = existing
        .filter(r => r.id >= MATRIX_RULES_BASE_ID && r.id < MATRIX_RULES_BASE_ID + MATRIX_RULES_MAX_DNR)
        .map(r => r.id);

    await dnr.updateDynamicRules({
        removeRuleIds,
        addRules: dnrRules,
    }).catch(reason => {
        console.error(`[uBlock-Dynamic] matrix-block-rules/syncDNRRules: ${reason}`);
    });
}

/******************************************************************************/
// Public API
/******************************************************************************/

export async function getMatrixOverridesForSite(site) {
    await ensureLoaded();
    const domains = overrides.get(site);
    if ( !domains ) { return {}; }
    const out = {};
    for ( const [ domain, entry ] of domains ) {
        out[domain] = { ...entry };
    }
    return out;
}

export async function setMatrixOverride(site, domain, scope, action) {
    await ensureLoaded();
    if ( !site || !domain ) { return; }
    if ( scope !== 'all' && scope !== 'code' ) { return; }
    const siteEntries = overrides.get(site) ?? new Map();
    const isNewPair = !siteEntries.has(domain);
    // MATRIX_OVERRIDES_MAX guard — only a genuinely NEW (site, domain)
    // pair counts against the cap; toggling an existing pair's scope
    // never increases total count, so it must never be blocked by this
    // check regardless of how full storage already is.
    if ( isNewPair && totalOverrideCount() >= MATRIX_OVERRIDES_MAX ) { return; }
    // createdAt is stamped ONCE, the first time this (site, domain) pair
    // gets any override at all, and preserved across every later toggle
    // (e.g. adding a 3P-code override to a domain that already has a
    // 3P-all override from last week keeps last week's date, not
    // today's) — it answers "when did this pair first become an
    // override", not "when was it last touched".
    const entry = siteEntries.get(domain) ?? { all: null, code: null, createdAt: todayISODate() };
    entry[scope] = (action === 'allow' || action === 'block') ? action : null;
    if ( isEmptyEntry(entry) ) {
        siteEntries.delete(domain);
    } else {
        siteEntries.set(domain, entry);
    }
    if ( siteEntries.size === 0 ) {
        overrides.delete(site);
    } else {
        overrides.set(site, siteEntries);
    }
    await persistOverrides();
    await syncDNRRules();
}

// Despite the name (kept for API stability — see message-types.js), this
// now returns every (site, domain) pair with ANY active override, block
// OR allow — Manage Custom Rules' "Dynamic DNR Rules" group displays
// both, not just blocks, since the panel can create either kind.
export async function getMatrixBlockRules() {
    await ensureLoaded();
    const out = [];
    for ( const [ site, domains ] of overrides ) {
        for ( const [ domain, entry ] of domains ) {
            if ( isEmptyEntry(entry) ) { continue; }
            out.push({
                uid: uidFor(site, domain),
                site,
                domain,
                all: entry.all,   // 'block' | 'allow' | null
                code: entry.code, // 'block' | 'allow' | null
                createdAt: isValidISODate(entry.createdAt) ? entry.createdAt : todayISODate(),
            });
        }
    }
    return out;
}

export async function deleteMatrixBlockRule(uid) {
    await ensureLoaded();
    const parsed = parseUid(uid);
    if ( !parsed ) { return; }
    const siteEntries = overrides.get(parsed.site);
    if ( siteEntries ) {
        siteEntries.delete(parsed.domain);
        if ( siteEntries.size === 0 ) { overrides.delete(parsed.site); }
    }
    await persistOverrides();
    await syncDNRRules();
}

// Clears EVERY override (block or allow) across every (site, domain)
// pair — matches getMatrixBlockRules() now showing both kinds; "Clear
// all" should remove everything visible in that list, not silently leave
// allow overrides behind that the user can no longer see or manage there.
export async function clearMatrixBlockRules() {
    await ensureLoaded();
    overrides = new Map();
    await persistOverrides();
    await syncDNRRules();
}

export async function restoreMatrixBlockRules() {
    await ensureLoaded();
    await syncDNRRules();
}

// Manage Custom Rules' "Delete rules" toolbar button — deletes every
// (site, domain) override pair where EITHER field CONTAINS filter
// (case-insensitive), or EVERY pair when filter is '' (no filter active
// = delete all, same scope clearMatrixBlockRules() above covers). Same
// either-field "contains" matching custom-rules.js's renderMatrixRules()
// already filters Dynamic DNR rows by, so "delete what's currently
// shown" and "what's currently filtered" can never disagree. Returns the
// count of (site, domain) pairs actually deleted.
export async function deleteMatrixOverridesMatching(filter) {
    await ensureLoaded();
    const needle = (filter ?? '').toLowerCase();
    let deleted = 0;
    for ( const [ site, domains ] of overrides ) {
        for ( const domain of domains.keys() ) {
            const matches = needle === '' ||
                site.toLowerCase().includes(needle) ||
                domain.toLowerCase().includes(needle);
            if ( !matches ) { continue; }
            domains.delete(domain);
            deleted++;
        }
        if ( domains.size === 0 ) { overrides.delete(site); }
    }
    if ( deleted > 0 ) {
        await persistOverrides();
        await syncDNRRules();
    }
    return deleted;
}

function isValidActionValue(value) {
    return value === 'block' || value === 'allow' || value === null || value === undefined;
}

// Imports an array of { site, domain, all, code, createdAt } entries —
// the EXACT shape getMatrixBlockRules() already returns, so export →
// import is a lossless round-trip with no reshaping on either side.
// Imported entries WIN for exactly the (site, domain) pairs they
// mention; every other pair already in storage is left untouched (merge,
// not replace) — an import is meant to bring rules IN, not silently wipe
// out unrelated ones already set up on this install. Validated strictly
// field-by-field rather than trusted, since this reads a user-supplied
// JSON file, not another part of this codebase. Batches to a single
// storage write + single DNR resync at the end regardless of entry
// count, unlike setMatrixOverride() (correct for its own single-click
// use, wasteful here for what could be hundreds of entries at once).
export async function importMatrixOverrides(rulesArray) {
    await ensureLoaded();
    let imported = 0;
    if ( Array.isArray(rulesArray) ) {
        // MATRIX_OVERRIDES_MAX guard — same "only new pairs count"
        // reasoning as setMatrixOverride() above; an import entry that
        // matches an existing (site, domain) pair updates it in place
        // (see existingCreatedAt below) and never consumes a slot.
        let available = Math.max(0, MATRIX_OVERRIDES_MAX - totalOverrideCount());
        for ( const rule of rulesArray ) {
            if ( !rule || typeof rule !== 'object' ) { continue; }
            const { site, domain, all, code, createdAt } = rule;
            if ( typeof site !== 'string' || site === '' ) { continue; }
            if ( typeof domain !== 'string' || domain === '' ) { continue; }
            if ( !isValidActionValue(all) || !isValidActionValue(code) ) { continue; }
            const isNewPair = !overrides.get(site)?.has(domain);
            if ( isNewPair && available <= 0 ) { continue; }
            // A pair already present on THIS install keeps ITS OWN
            // creation date (a re-import shouldn't reset "when I first
            // set this up here"); a genuinely new pair takes the
            // imported date if the file provided a valid one, else
            // today (the import date is a legitimate "created" date for
            // a pair that's brand new to this install).
            const existingCreatedAt = overrides.get(site)?.get(domain)?.createdAt;
            const entry = {
                all: all === 'block' || all === 'allow' ? all : null,
                code: code === 'block' || code === 'allow' ? code : null,
                createdAt: isValidISODate(existingCreatedAt)
                    ? existingCreatedAt
                    : (isValidISODate(createdAt) ? createdAt : todayISODate()),
            };
            if ( isEmptyEntry(entry) ) { continue; }
            const siteEntries = overrides.get(site) ?? new Map();
            siteEntries.set(domain, entry);
            overrides.set(site, siteEntries);
            imported++;
            if ( isNewPair ) { available--; }
        }
    }
    if ( imported > 0 ) {
        await persistOverrides();
        await syncDNRRules();
    }
    return imported;
}

// (10.0.3) backfillMatrixOverrideDates() — the one-time migration step
// that stamped a createdAt date onto any override that predated
// date-tracking — was removed along with every other pre-10.0.3 upgrade
// step; see CHANGELOG_HISTORY.md's 10.0.3 entry.
