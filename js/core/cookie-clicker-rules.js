/*
 * cookie-clicker-rules.js — Consent-clicker rule storage
 *
 * See COOKIE-CLICKER-DESIGN.md for the full design history (why this
 * exists, why it isn't AdGuard's `trusted-click-element`, and the
 * Path A/Path B tradeoff this file is the Path B side of).
 *
 * Public interface:
 *   getAllCookieClickerRules()          — every rule, flattened, each
 *                                       with its own `uid` and
 *                                       `siteHostname` — shaped for
 *                                       Manage Custom Rules, same
 *                                       pattern as getMatrixBlockRules()
 *   addCookieClickerRule({ siteHostname, frameHostname, selector,
 *                           shadowHostSelector, textFilter })
 *                                       — persists a new rule, returns
 *                                       it (with `id`/`uid`/`createdAt`
 *                                       stamped)
 *   deleteCookieClickerRule(uid)        — removes one rule
 *   clearCookieClickerRules()           — removes every rule, everywhere
 *   deleteCookieClickerRulesMatching(filter) — Manage Custom Rules'
 *                                       "Delete rules" toolbar button
 *   importCookieClickerRules(rules)     — Manage Custom Rules' Import and
 *                                       Restore; overwrites an identical
 *                                       stored rule (11.1.3), returns
 *                                       { added, changed }
 *
 * Deliberately does NOT call registerCookieClickerContentScripts() (or
 * anything else in scripting-manager.js) itself on mutation — that would
 * make this a core/ module reaching sideways into another core/ module's
 * browser.scripting registration, which isn't how any of the OTHER
 * user-rule-creating core modules here do it either (filter-manager.js's
 * addCustomFilters()/deleteCustomFilter(), custom-scriptlets.js's
 * addCustomScriptletRule() — none of them call registerContentScripts()
 * themselves; js/workflow/filter-routes.js's handlers do, right after
 * delegating to the core function). matrix-block-rules.js's own internal
 * syncDNRRules() self-trigger is the one exception, and it's a poor
 * precedent to follow here: that module owns the declarativeNetRequest
 * API outright (its own header literally says "storage + DNR sync"),
 * where this module owns storage only — registration stays the workflow
 * layer's job, via js/workflow/cookie-clicker-routes.js, exactly like
 * cosmetic rules. See that file's handlers for where
 * registerCookieClickerContentScripts() actually gets called.
 *
 * Storage shape — ONE flat key, not sharded per-site (rule counts here
 * are expected to be tens, not thousands, unlike the bundled filter-list
 * cosmetic data css-specific.js reads — see that file's own header for
 * why THAT data needed sharding and this doesn't):
 *
 *   chrome.storage.local['cookieClicker.rules'] = {
 *     [siteHostname]: [
 *       {
 *         id:            string,  // short random id, unique within site
 *         frameHostname: string,  // hostname of the frame the button
 *                                 // actually lives in — equal to
 *                                 // siteHostname for a top-frame button,
 *                                 // different for a CMP iframe (e.g.
 *                                 // 'consent.cookiebot.com')
 *         selector:      string,  // CSS selector, computed at pick time
 *         shadowHostSelector: string | null, // (8.2.11) document-scoped
 *                                 // selector for the enclosing Shadow
 *                                 // DOM host element, if the button was
 *                                 // picked from inside one — null for
 *                                 // an ordinary light-DOM button. When
 *                                 // set, `selector` above is scoped to
 *                                 // that host's OWN shadowRoot, not to
 *                                 // `document` — see cookie-clicker-
 *                                 // click.js's own replay logic and
 *                                 // js/scripting/cookie-clicker-
 *                                 // picker.js's buildSelector() for the
 *                                 // full reasoning (including why a
 *                                 // CLOSED shadow root means this rule
 *                                 // was saved faithfully but can never
 *                                 // actually fire — a real browser
 *                                 // security boundary, not a bug here).
 *         textFilter:    string,  // '' = no extra filter; otherwise the
 *                                 // click interpreter also requires the
 *                                 // element's textContent to include
 *                                 // this — extra disambiguation if the
 *                                 // site's markup drifts after pick time
 *         enabled:       boolean,  // always true for now (no per-rule
 *                                 // enable/disable toggle exists in the
 *                                 // UI — see this file's own C11 note
 *                                 // below); kept as a field, and honored
 *                                 // by the click interpreter's `r.enabled
 *                                 // !== false` check, so a future toggle
 *                                 // UI or a hand-edited/imported rule
 *                                 // that sets it false needs no schema
 *                                 // change, just a mutator this file
 *                                 // doesn't currently need to expose
 *         createdAt:     string,  // ISO date
 *       },
 *       ...
 *     ],
 *   }
 *
 * STORAGE KEY — must match js/scripting/cookie-clicker-click.js's own
 * hardcoded read of the exact same key. Declared once here as the single
 * source of truth (this module owns every write to it); the content
 * script's copy is commented with the same "must match" warning pointing
 * back here, the same convention scripting-manager.js's
 * COSMETIC_SPECIFIC_STORAGE_PREFIX already uses for the identical
 * cross-file-agreement problem.
 */

import { localRead, localWrite } from '../data/ext.js';
import { todayISODate, isValidISODate, isValidHostnamePattern, isBoundedString } from '../util/utils.js';

/******************************************************************************/
// Config — single source of truth for this module's storage key and the
// short-id alphabet/length, per this project's own "declare once, with
// clear comments" convention.
/******************************************************************************/

const STORAGE_KEY = 'cookieClicker.rules';

// Short id: enough entropy that two rules created back-to-back on the
// same site can't collide (36^8 ≈ 2.8e12 combinations), short enough to
// stay readable in a future Manage Custom Rules list.
const RULE_ID_LENGTH = 8;

// B6 (unbounded-collection guard) — global cap across every site,
// mirroring filter-manager.js's own CUSTOM_COSMETIC_MAX for picker-
// created cosmetic rules (same storage-quota-risk reasoning: an
// unbounded chrome.storage.local key eventually risks that API's own
// per-extension quota). 2,000 is generous for genuine one-at-a-time
// manual picking (even a very heavy user creating a rule a day for
// years stays well under it) while still bounding the worst case — an
// oversized/malformed import file, or a future automated-detection
// layer (see COOKIE-CLICKER-DESIGN.md's optional CMP-detection-layer
// scope note) that could otherwise generate rules far faster than a
// human clicking ever would. Deliberately NOT CUSTOM_COSMETIC_MAX's
// 10,000 verbatim — that number is sized for bundled filter-list-scale
// data via Import; this category's only realistic bulk-creation path
// (Import) is still human-curated-export-sized, not filter-list-sized.
const RULES_MAX = 2_000;

// C6 input bound (10.7.13) for one picked rule's free-text fields
// (selector, shadowHostSelector, textFilter): same 2,000-character
// ceiling as filter-manager.js's CUSTOM_SELECTOR_MAX_LENGTH and
// custom-scriptlets.js's CUSTOM_SCRIPTLET_ARG_MAX_LENGTH. RULES_MAX bounds
// how many rules exist; this bounds how large any single one can be.
const RULE_FIELD_MAX_LENGTH = 2_000;

// A picked rule always belongs to one real site and frame: the "all
// sites" wildcard isValidHostnamePattern() accepts elsewhere is refused.
function isConcreteHostname(hostname) {
    return hostname !== '*' && isValidHostnamePattern(hostname);
}

// C6 — the one field check shared by a new pick (addCookieClickerRule)
// and Import / Restore (importCookieClickerRules), so the two entry
// points cannot accept different rules (B15).
function areRuleFieldsValid({ siteHostname, frameHostname, selector, shadowHostSelector, textFilter }) {
    if ( isConcreteHostname(siteHostname) === false ) { return false; }
    if ( isConcreteHostname(frameHostname) === false ) { return false; }
    if ( isBoundedString(selector, RULE_FIELD_MAX_LENGTH) === false ) { return false; }
    if ( shadowHostSelector && isBoundedString(shadowHostSelector, RULE_FIELD_MAX_LENGTH) === false ) { return false; }
    if ( typeof textFilter === 'string' && textFilter.length > RULE_FIELD_MAX_LENGTH ) { return false; }
    return true;
}

// (11.1.3) A rule's identity: the fields that decide WHAT it clicks (site, frame, selector, shadow host, text). Two
// rules with the same identity are the same rule, whatever their id, date or on/off state. Shared by a new pick
// (addCookieClickerRule) and Import / Restore (importCookieClickerRules), so neither can store the same rule twice —
// before 11.1.3 every Restore of a backup appended a second copy of every rule (owner's report).
function normalizedShadowHost(shadowHostSelector) {
    return typeof shadowHostSelector === 'string' && shadowHostSelector !== '' ? shadowHostSelector : null;
}
function normalizedTextFilter(textFilter) {
    return typeof textFilter === 'string' ? textFilter : '';
}
function findSameRule(siteRules, { frameHostname, selector, shadowHostSelector, textFilter }) {
    if ( Array.isArray(siteRules) === false ) { return undefined; }
    const shadow = normalizedShadowHost(shadowHostSelector);
    const text = normalizedTextFilter(textFilter);
    return siteRules.find(r => r.frameHostname === frameHostname && r.selector === selector
        && normalizedShadowHost(r.shadowHostSelector) === shadow && normalizedTextFilter(r.textFilter) === text);
}

/******************************************************************************/
// uid encoding — a (siteHostname, id) pair as one string, mirroring
// matrix-block-rules.js's uidFor()/parseUid() exactly (same '::'
// separator reasoning: neither hostnames nor generated ids can contain
// ':', so this can't collide/ambiguate).
/******************************************************************************/

function uidFor(siteHostname, id) {
    return `${siteHostname}::${id}`;
}

function parseUid(uid) {
    const i = uid.indexOf('::');
    if ( i === -1 ) { return null; }
    return { siteHostname: uid.slice(0, i), id: uid.slice(i + 2) };
}

function newRuleId() {
    // crypto.randomUUID() is available in both the service worker and
    // content-script execution contexts this project targets (Chrome
    // 122+ — see manifest.json's minimum_chrome_version); sliced down
    // rather than used in full since a full UUID is overkill for a
    // same-site collision space this small.
    return crypto.randomUUID().replace(/-/g, '').slice(0, RULE_ID_LENGTH);
}

/******************************************************************************/
// Lazy-loaded cache — GUARD: init/clear/release.
//
// init:    ensureLoaded() below — the ONE place `rules` transitions from
//          null (not yet loaded) to a real Map, reading storage exactly
//          once per service-worker lifetime (subsequent calls reuse the
//          in-flight/settled loadPromise).
// clear:   every mutator (add/setEnabled/delete/clear) updates the
//          in-memory Map AND persists it in the same call, so the two
//          can never drift — there is no code path that mutates one
//          without the other.
// release: deleteCookieClickerRule()/clearCookieClickerRules() delete
//          the Map entry outright (not just empty its array) when a
//          site's last rule is removed, so storage never accumulates
//          `siteHostname: []` dead entries — mirrors matrix-block-
//          rules.js's identical siteEntries.size === 0 check.
/******************************************************************************/

let rules = null; // null until first load — shape: Map<siteHostname, rule[]>
let loadPromise = null;

async function ensureLoaded() {
    if ( rules !== null ) { return; }
    if ( loadPromise === null ) {
        loadPromise = localRead(STORAGE_KEY).then(stored => {
            rules = new Map(Object.entries(stored ?? {}));
        });
    }
    await loadPromise;
}

async function persist() {
    const out = {};
    for ( const [ siteHostname, siteRules ] of rules ) {
        out[siteHostname] = siteRules;
    }
    await localWrite(STORAGE_KEY, out);
}

function totalRuleCount() {
    let total = 0;
    for ( const siteRules of rules.values() ) { total += siteRules.length; }
    return total;
}

/******************************************************************************/
// Public API
/******************************************************************************/

export async function getAllCookieClickerRules() {
    await ensureLoaded();
    const out = [];
    for ( const [ siteHostname, siteRules ] of rules ) {
        for ( const r of siteRules ) {
            out.push({ ...r, uid: uidFor(siteHostname, r.id), siteHostname });
        }
    }
    return out;
}

export const COOKIE_CLICKER_RULES_MAX = RULES_MAX;

// Current total across every site — lets the route tell "cap reached"
// apart from "field rejected" when addCookieClickerRule() returns null.
export async function countCookieClickerRules() {
    await ensureLoaded();
    return totalRuleCount();
}

export async function addCookieClickerRule({ siteHostname, frameHostname, selector, shadowHostSelector, textFilter }) {
    await ensureLoaded();
    if ( !siteHostname || !frameHostname || !selector ) { return null; }
    // C6 (10.7.13): validate at the storage boundary, not only in the route.
    if ( areRuleFieldsValid({ siteHostname, frameHostname, selector, shadowHostSelector, textFilter }) === false ) { return null; }
    const siteRules = rules.get(siteHostname) ?? [];
    // (11.1.3) Picking the same button again returns the stored rule (switched on) instead of adding a copy.
    const same = findSameRule(siteRules, { frameHostname, selector, shadowHostSelector, textFilter });
    if ( same !== undefined ) {
        if ( same.enabled !== true ) { same.enabled = true; await persist(); }
        return { ...same, uid: uidFor(siteHostname, same.id) };
    }
    if ( totalRuleCount() >= RULES_MAX ) { return null; } // RULES_MAX guard — see its own comment above
    const rule = {
        id: newRuleId(),
        frameHostname,
        selector,
        shadowHostSelector: normalizedShadowHost(shadowHostSelector),
        textFilter: normalizedTextFilter(textFilter),
        enabled: true,
        createdAt: todayISODate(),
    };
    siteRules.push(rule);
    rules.set(siteHostname, siteRules);
    await persist();
    return { ...rule, uid: uidFor(siteHostname, rule.id) };
}

export async function deleteCookieClickerRule(uid) {
    await ensureLoaded();
    const parsed = parseUid(uid);
    if ( !parsed ) { return false; }
    const siteRules = rules.get(parsed.siteHostname);
    if ( !siteRules ) { return false; }
    const next = siteRules.filter(r => r.id !== parsed.id);
    if ( next.length === siteRules.length ) { return false; } // nothing removed
    if ( next.length === 0 ) {
        rules.delete(parsed.siteHostname); // RELEASE: no dead empty-array entry left behind
    } else {
        rules.set(parsed.siteHostname, next);
    }
    await persist();
    return true;
}

export async function clearCookieClickerRules() {
    await ensureLoaded();
    rules = new Map();
    await persist();
}

// Manage Custom Rules' "Delete rules" toolbar button — deletes every rule
// whose siteHostname OR frameHostname CONTAINS filter (case-insensitive),
// or EVERY rule when filter is '' — same either-field "contains" scheme
// matrix-block-rules.js's deleteMatrixOverridesMatching() and
// filter-manager.js's deleteCustomFiltersMatching() already use, so
// "delete what's currently shown" and "what's currently filtered" can
// never disagree for this category either. Returns the count of rules
// actually deleted.
export async function deleteCookieClickerRulesMatching(filter) {
    await ensureLoaded();
    const needle = (filter ?? '').toLowerCase();
    let deleted = 0;
    for ( const [ siteHostname, siteRules ] of rules ) {
        const kept = siteRules.filter(r => {
            const matches = needle === '' ||
                siteHostname.toLowerCase().includes(needle) ||
                r.frameHostname.toLowerCase().includes(needle);
            if ( matches ) { deleted++; }
            return !matches;
        });
        if ( kept.length === 0 ) {
            rules.delete(siteHostname); // RELEASE: no dead empty-array entry left behind
        } else {
            rules.set(siteHostname, kept);
        }
    }
    if ( deleted > 0 ) {
        await persist();
    }
    return deleted;
}

// Manage Custom Rules' combined Import — merges an array of the EXACT
// shape getAllCookieClickerRules() returns ({ siteHostname,
// frameHostname, selector, textFilter, enabled, createdAt }, uid/id
// ignored — a fresh id is minted per imported rule so an import can never
// collide with an existing rule's id on this install), so export ->
// import is a lossless round-trip. Validated field-by-field since this
// reads a user-supplied JSON file, not trusted internal data — same
// posture as importMatrixOverrides()/importCosmeticFilters(). Returns the
// count of rules actually imported.
// (11.1.3) A rule already stored here (same identity, findSameRule) is OVERWRITTEN, not added again: it takes the
// file's on/off state and keeps its own id and creation date — the same posture importMatrixOverrides() takes for a
// site+domain pair already present. Returns { added, changed }: rules added, and stored rules whose on/off state the
// file changed. Either one changes which sites the click script is registered on, so the caller re-registers when
// either is non-zero; only `added` is reported to the user as imported. Any change is persisted.
export async function importCookieClickerRules(rulesArray) {
    await ensureLoaded();
    let imported = 0;
    let overwritten = 0;
    if ( Array.isArray(rulesArray) ) {
        let available = Math.max(0, RULES_MAX - totalRuleCount()); // RULES_MAX guard — see its own comment above
        for ( const entry of rulesArray ) {
            if ( !entry || typeof entry !== 'object' ) { continue; }
            const { siteHostname, frameHostname, selector, shadowHostSelector, textFilter, enabled, createdAt } = entry;
            if ( typeof siteHostname !== 'string' || siteHostname === '' ) { continue; }
            if ( typeof frameHostname !== 'string' || frameHostname === '' ) { continue; }
            if ( typeof selector !== 'string' || selector === '' ) { continue; }
            // (10.7.14) Same field check as a new pick — see areRuleFieldsValid().
            if ( areRuleFieldsValid({ siteHostname, frameHostname, selector, shadowHostSelector, textFilter }) === false ) { continue; }
            const siteRules = rules.get(siteHostname) ?? [];
            const same = findSameRule(siteRules, { frameHostname, selector, shadowHostSelector, textFilter });
            if ( same !== undefined ) {
                if ( same.enabled !== (enabled !== false) ) { same.enabled = enabled !== false; overwritten++; }
                continue;
            }
            if ( available <= 0 ) { continue; }   // full: a NEW rule is skipped, an overwrite above still applies
            const rule = {
                id: newRuleId(),
                frameHostname,
                selector,
                shadowHostSelector: normalizedShadowHost(shadowHostSelector),
                textFilter: normalizedTextFilter(textFilter),
                enabled: enabled !== false,
                createdAt: isValidISODate(createdAt) ? createdAt : todayISODate(),
            };
            siteRules.push(rule);
            rules.set(siteHostname, siteRules);
            imported++;
            available--;
        }
    }
    if ( imported > 0 || overwritten > 0 ) {
        await persist();
    }
    return { added: imported, changed: overwritten };
}

/******************************************************************************/
// (10.0.3) backfillCookieClickerRuleDates() — the one-time migration step
// that stamped a createdAt date onto any rule that predated date-tracking
// — was removed along with every other pre-10.0.3 upgrade step; see
// CHANGELOG_HISTORY.md's 10.0.3 entry.
/******************************************************************************/
