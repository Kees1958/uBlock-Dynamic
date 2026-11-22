// ── tab-under-guard.js ───────────────────────────────────────────────────────
// Puts a tab back on the site page when that site turns it into a pop-under ad (10.7.2, "tab-under").
//
// The pattern (xgroovy.com, 10.7.2 report): a click on a video opens the video in a NEW tab, and the ORIGINAL tab is
// sent to an ad network's click URL (s.pemsrv.com/v1/link.php?...). Page rules (scriptlets) could not stop it: the
// redirect is started from another tab or a cross-origin ad frame, which a page's own scripts never see. This module
// works one level higher, in the service worker: it sees every top-level page load of every tab, so it does not
// matter who starts the redirect, or which extension (or Brave) then blocks the ad page.
//
// Configured per site with uBD's own pseudo-scriptlet "prevent-popunder" (js/util/popunder-parser.js) — a setting in
// scriptlet form, never injected into a page — from two channels:
//   built-in — the Quick-fixes list, shipped as inert carrier rules (js/core/popunder-carriers.js)
//   imported — the ABP-import editor's own text
//     xgroovy.com#%#//scriptlet('prevent-popunder', 'pemsrv.com')
//
// How it works:
//   1. onCommitted (top frame): a tab that commits a page of a configured site has that page's URL recorded;
//      any other page removes the record. So a record always means "this tab is showing a configured site now".
//   2. onBeforeNavigate (top frame): when a recorded tab starts loading a network host configured for that site,
//      the tab is sent back to the recorded URL (tabs.update). The site page reloads; the ad never stays.
//   3. A loop guard stops after RESTORE_MAX restores of one tab within RESTORE_WINDOW_MS (a site that re-fires the
//      tab-under on every load would otherwise bounce forever); the ad page then simply stays.
//   4. SITE-MODE GATE (ARCHITECTURE.md HARD CONSTRAINT, C25): nothing happens on a site whose filtering is OFF.
//   5. LIGHT WAKE-UP PATH (10.7.2, owner's decision): the handlers do NOT wait for uBD's full startup. The configured
//      entries are mirrored to storage.session, so a service worker woken by the tab-under itself only reads that
//      small key before deciding — the shorter that path, the shorter any flash of a blocked page.
//   6. BLOCK PAGE COORDINATION: js/core/block-page.js asks isTabBeingSentBack(tabId) before replacing a blocked tab
//      with uBD's block page, so a tab this module is sending back is never covered by the block page.
//
// Side effect, by design: a link to a configured network that the person clicks themselves on a configured site
// is also sent back — such a link is the ad itself.
//
// Public interface:
//   loadBuiltinTabUnderEntries()           — async; reads the carriers from the shipped quick-fixes ruleset. Call once per SW start.
//   refreshImportedTabUnderEntries(text)   — recompute the ABP-import part from the editor's text
//   recordTabUnderCommit(details)          — webNavigation.onCommitted handler body (top frame only)
//   restoreTabUnderNavigation(details, isFilteringOff) — webNavigation.onBeforeNavigate handler body; isFilteringOff(hostname) → Promise<boolean>
//   isTabBeingSentBack(tabId)              — async; true while this module is (or just was) sending the tab back
//   releaseTabUnderTab(tabId)              — tabs.onRemoved: drops every record of the tab
//
// State owned by this module:
//   builtinEntries / importedEntries {Array} — [{network, sites}], replaced wholesale on every load/refresh (never
//     appended to); mirrored to storage.session (SESSION_ENTRIES_KEY) for the light wake-up path. Lost on SW restart
//     (safe): read back from storage.session by the first event, and recomputed by background.js start().
//   siteIndex {Map<site, Set<network>>} — derived from the two lists above, rebuilt with them.
//   lastSiteUrlByTab {Map<tabId, url>|null} — one entry per OPEN tab currently showing a configured site; persisted in
//     storage.session (SESSION_KEY) so a sleeping service worker still knows where to send a tab back. Bounded by the
//     open tabs; released per tab on navigation away and on tab close.
//   restoreTimesByTab {Map<tabId, number[]>} — loop-guard timestamps, at most RESTORE_MAX per tab, released on tab
//     close. In memory only: losing it on SW restart only resets the guard (safe).
//   decisionByTab {Map<tabId, Promise<boolean>>} / sentBackAtByTab {Map<tabId, number>} — the latest send-back decision
//     per tab and when the last send-back happened, for isTabBeingSentBack(). One entry per open tab, replaced on
//     every top-frame navigation, released on tab close. In memory only: the block-page check that reads them runs
//     in the same service-worker life as the navigation that set them.
// ─────────────────────────────────────────────────────────────────────────────
import { browser, sessionRead, sessionWrite } from '../data/ext.js';
import { extractPopunderLines } from '../util/popunder-parser.js';
import { readPopunderCarrierEntries } from './popunder-carriers.js';
import { QUICKFIXES_RULESET_PATH } from './builtin-exemption-carriers.js';

// ── Declared constants ────────────────────────────────────────────────────────
const TAB_UNDER_CONFIG = Object.freeze({
    SESSION_KEY:       'tabUnder.lastSiteUrlByTab',   // storage.session: { [tabId]: url }
    SESSION_ENTRIES_KEY: 'tabUnder.entries',          // storage.session: { builtin: [...], imported: [...] }
    SEND_BACK_GRACE_MS: 3_000,                        // a block error this soon after a send-back belongs to it
    RESTORE_WINDOW_MS: 10_000,                        // loop-guard window
    RESTORE_MAX:       2,                             // restores of one tab allowed inside that window
    WEB_PROTOCOLS:     Object.freeze([ 'http:', 'https:' ]),
    TOP_FRAME_ID:      0,
    LOG_PREFIX:        '[uBlock-Dynamic] tab-under-guard',
});

// ── State ─────────────────────────────────────────────────────────────────────
let builtinEntries = [];
let importedEntries = [];
let builtinReady = false;             // true once builtinEntries holds real data (loaded, or read from storage.session)
let importedReady = false;            // same for importedEntries
let siteIndex = new Map();
let lastSiteUrlByTab = null;          // null until loaded from storage.session (lazy, see loadTabRecords())
let loadingTabRecords = null;         // the pending load, so concurrent events share one read
// Bound (B6): one entry per open tab at most; releaseTabUnderTab() deletes all three on tabs.onRemoved
// (background.js). Lost on service-worker restart: safe — they only debounce decisions for live navigations.
const restoreTimesByTab = new Map();
const decisionByTab = new Map();
const sentBackAtByTab = new Map();

// ── Configuration ─────────────────────────────────────────────────────────────
function rebuildSiteIndex() {
    const index = new Map();
    for ( const { network, sites } of [ ...builtinEntries, ...importedEntries ] ) {
        for ( const site of sites ) {
            if ( index.has(site) === false ) { index.set(site, new Set()); }
            index.get(site).add(network);
        }
    }
    siteIndex = index;
}

// GUARD — init/clear: replaces the previous list wholesale. A failed read keeps the previous value (logged), so a
// transient error never wipes entries that were already loaded this session.
export async function loadBuiltinTabUnderEntries() {
    try {
        const res = await fetch(browser.runtime.getURL(QUICKFIXES_RULESET_PATH));
        const rules = await res.json();
        if ( !Array.isArray(rules) ) { throw new Error('quick-fixes ruleset is not an array'); }
        builtinEntries = readPopunderCarrierEntries(rules);
        builtinReady = true;
        rebuildSiteIndex();
        await persistEntries();
    } catch (reason) {
        console.error(`${TAB_UNDER_CONFIG.LOG_PREFIX}/loadBuiltinTabUnderEntries:`, reason);
    }
}

// GUARD — init/clear: replaces the previous list wholesale, so a line removed from the editor stops applying on the
// next call. Malformed lines are not applied; the editor comments them out with their reason on save
// (js/core/custom-scriptlets.js), so they are not reported a second time here.
export function refreshImportedTabUnderEntries(text) {
    importedEntries = extractPopunderLines(typeof text === 'string' ? text : '').entries;
    importedReady = true;
    rebuildSiteIndex();
    persistEntries();
}

// Mirror of the configured entries for the light wake-up path. Written only once BOTH parts hold real data, so a
// half-loaded state (e.g. the built-in part still loading) never overwrites a complete mirror. Errors are logged,
// never thrown: the in-memory copy stays authoritative for this service-worker life.
function persistEntries() {
    if ( builtinReady === false || importedReady === false ) { return Promise.resolve(); }
    const value = { builtin: builtinEntries, imported: importedEntries };
    return Promise.resolve(sessionWrite(TAB_UNDER_CONFIG.SESSION_ENTRIES_KEY, value)).catch(reason => {
        console.error(`${TAB_UNDER_CONFIG.LOG_PREFIX}/persistEntries:`, reason);
    });
}

function validEntries(list) {
    return Array.isArray(list)
        ? list.filter(e => typeof e?.network === 'string' && Array.isArray(e.sites) && e.sites.every(s => typeof s === 'string'))
        : [];
}

// GUARD — init (light wake-up path): fills whichever part startup has not provided yet from storage.session. Never
// overwrites a part startup already loaded in this service-worker life.
async function ensureEntriesLoaded() {
    if ( builtinReady && importedReady ) { return; }
    const stored = await sessionRead(TAB_UNDER_CONFIG.SESSION_ENTRIES_KEY);
    if ( stored === undefined || stored === null ) { return; }
    if ( builtinReady === false ) { builtinEntries = validEntries(stored.builtin); builtinReady = true; }
    if ( importedReady === false ) { importedEntries = validEntries(stored.imported); importedReady = true; }
    rebuildSiteIndex();
}

// The configured networks for a hostname: the entry of the hostname itself or of its closest parent domain.
function networksForHost(hostname) {
    let candidate = hostname;
    for (;;) {
        const networks = siteIndex.get(candidate);
        if ( networks !== undefined ) { return networks; }
        const dot = candidate.indexOf('.');
        if ( dot === -1 ) { return null; }
        candidate = candidate.slice(dot + 1);
    }
}

function hostMatchesNetwork(hostname, networks) {
    for ( const network of networks ) {
        if ( hostname === network || hostname.endsWith(`.${network}`) ) { return true; }
    }
    return false;
}

function webHostnameOf(url) {
    try {
        const u = new URL(url);
        return TAB_UNDER_CONFIG.WEB_PROTOCOLS.includes(u.protocol) ? u.hostname : null;
    } catch {
        return null;
    }
}

// ── Per-tab records (storage.session) ─────────────────────────────────────────
// GUARD — init: loaded once per SW life; concurrent callers share the same pending read.
function loadTabRecords() {
    if ( lastSiteUrlByTab !== null ) { return Promise.resolve(lastSiteUrlByTab); }
    if ( loadingTabRecords === null ) {
        loadingTabRecords = sessionRead(TAB_UNDER_CONFIG.SESSION_KEY).then(stored => {
            const map = new Map();
            for ( const [ id, url ] of Object.entries(stored ?? {}) ) {
                const tabId = Number(id);
                if ( Number.isInteger(tabId) && typeof url === 'string' ) { map.set(tabId, url); }
            }
            lastSiteUrlByTab = map;
            loadingTabRecords = null;
            return map;
        });
    }
    return loadingTabRecords;
}

function persistTabRecords() {
    return Promise.resolve(sessionWrite(TAB_UNDER_CONFIG.SESSION_KEY, Object.fromEntries(lastSiteUrlByTab))).catch(reason => {
        console.error(`${TAB_UNDER_CONFIG.LOG_PREFIX}/persistTabRecords:`, reason);
    });
}

// ── Event handlers ────────────────────────────────────────────────────────────
export async function recordTabUnderCommit(details) {
    if ( details?.frameId !== TAB_UNDER_CONFIG.TOP_FRAME_ID || !(details.tabId >= 0) ) { return; }
    await ensureEntriesLoaded();
    const hostname = webHostnameOf(details.url);
    const isConfiguredSite = hostname !== null && networksForHost(hostname) !== null;
    const records = await loadTabRecords();
    if ( isConfiguredSite ) {
        if ( records.get(details.tabId) === details.url ) { return; }
        records.set(details.tabId, details.url);
    } else {
        // RELEASE: the tab left the configured site — its record goes with it.
        if ( records.delete(details.tabId) === false ) { return; }
    }
    await persistTabRecords();
}

// Loop guard: true when one more restore of this tab is allowed now (and counts it).
function takeRestoreSlot(tabId, now) {
    const C = TAB_UNDER_CONFIG;
    const recent = (restoreTimesByTab.get(tabId) ?? []).filter(t => now - t < C.RESTORE_WINDOW_MS);
    if ( recent.length >= C.RESTORE_MAX ) {
        restoreTimesByTab.set(tabId, recent);
        return false;
    }
    recent.push(now);
    restoreTimesByTab.set(tabId, recent);
    return true;
}

// Records the decision for this tab SYNCHRONOUSLY (before any await), so a block error arriving while the decision
// is still being made is held until it is known (isTabBeingSentBack()).
export function restoreTabUnderNavigation(details, isFilteringOff) {
    if ( details?.frameId !== TAB_UNDER_CONFIG.TOP_FRAME_ID || !(details.tabId >= 0) ) { return Promise.resolve(false); }
    const decision = decideAndSendBack(details, isFilteringOff).catch(reason => {
        console.error(`${TAB_UNDER_CONFIG.LOG_PREFIX}/restoreTabUnderNavigation:`, reason);
        return false;
    });
    decisionByTab.set(details.tabId, decision);
    return decision;
}

// Returns true when the tab was sent back.
async function decideAndSendBack(details, isFilteringOff) {
    await ensureEntriesLoaded();
    if ( siteIndex.size === 0 ) { return false; }   // nothing configured: the common case
    const destination = webHostnameOf(details.url);
    if ( destination === null ) { return false; }
    const records = await loadTabRecords();
    const siteUrl = records.get(details.tabId);
    if ( siteUrl === undefined ) { return false; }
    const siteHost = webHostnameOf(siteUrl);
    const networks = siteHost === null ? null : networksForHost(siteHost);
    if ( networks === null || hostMatchesNetwork(destination, networks) === false ) { return false; }
    if ( await isFilteringOff(siteHost) ) { return false; }                     // SITE-MODE GATE (C25)
    if ( takeRestoreSlot(details.tabId, Date.now()) === false ) {
        console.warn(`${TAB_UNDER_CONFIG.LOG_PREFIX}: loop guard — not sending tab ${details.tabId} back again`);
        return false;
    }
    await browser.tabs.update(details.tabId, { url: siteUrl });
    sentBackAtByTab.set(details.tabId, Date.now());
    return true;
}

// For js/core/block-page.js: waits for this tab's pending decision, then answers whether a send-back is in progress
// (or happened within SEND_BACK_GRACE_MS — the send-back's own navigation replaces the decision before the blocked
// load's error arrives).
export async function isTabBeingSentBack(tabId) {
    await (decisionByTab.get(tabId) ?? Promise.resolve(false));
    const at = sentBackAtByTab.get(tabId);
    return at !== undefined && Date.now() - at < TAB_UNDER_CONFIG.SEND_BACK_GRACE_MS;
}

// RELEASE: everything this module keeps for a tab.
export async function releaseTabUnderTab(tabId) {
    restoreTimesByTab.delete(tabId);
    decisionByTab.delete(tabId);
    sentBackAtByTab.delete(tabId);
    const records = await loadTabRecords();
    if ( records.delete(tabId) ) { await persistTabRecords(); }
}
