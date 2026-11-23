/*
 * breakage-risk.js — Breakage-risk verdict for a third-party domain in the
 * DNR tracking filter (11.1.0, owner's request: the same low / medium / high
 * indicator the Fingerprint Inspector shows, now per domain).
 *
 * Public interface:
 *   ensureBreakageRiskDataReady() — loads the two lazily-fetched inputs
 *                                   (tracker-exception hosts below, and the
 *                                   DDG Tracker Radar dataset) once; idempotent,
 *                                   safe to call on every session start / SW wake
 *   breakageRiskOf(host)          — RISK_HIGH | RISK_MEDIUM | RISK_LOW | RISK_UNKNOWN
 *   classifyBreakageRisk(signals) — the pure rule (exported for the test)
 *   extractExceptionHosts(rules)  — the pure ruleset parser (exported for the test)
 *   resetBreakageRiskCache()      — release guard: matrix-panel.js stopMatrix() drops the host sets with the
 *                                   session; the next session start loads them again
 *
 * THE RULE (owner's decision 2026-11-23) — first match wins, highest risk first:
 *   HIGH    — on the built-in whitelist (matrix-classifier isBuiltinWhitelisted):
 *             payment, sign-in, CAPTCHA, players, libraries websites need.
 *   MEDIUM  — websites NEED this domain (or a parent of it, or a host under it), by either of:
 *             (a) the hidden tracker-exception ruleset (ruleset_tracking_servers_allowlist) has an allow for it;
 *             (b) (owner, same day) Disconnect or Ghostery classify it as a tracker sites need — their
 *                 "Content"/"Anti-fraud"/"ConsentManagers" and player/hosting/utilities/consent/customer-
 *                 interaction categories, bundled as js/data/needed-trackers-data.json by
 *                 tools/build-needed-trackers.mjs (a listed domain covers its subdomains).
 *             For (a):
 *             That ruleset IS "the allow exceptions we use to filter out the risky
 *             ones" for the combined tracker lists (Kees1958, Peter Lowe, AdGuard
 *             tracking servers, HaGeZi Light): AdGuard's own tracker exceptions plus
 *             EFF Privacy Badger's cookieblock hosts (tools/build/tracking-allowlist-
 *             source.mjs). Read from the SHIPPED ruleset — one source of truth, no
 *             second build artifact that could drift from the rules that really apply.
 *             "A host under it" counts because a 3P-all/3P-code click on the row's
 *             domain also blocks that excepted host.
 *   LOW     — in the bundled DuckDuckGo Tracker Radar dataset (and none of the above).
 *   UNKNOWN — on none of these lists: no breakage information (shown as ⚪, as the
 *             Fingerprint Inspector does — "no data" is a deliberate state, not "safe").
 *
 * Dependencies: matrix-classifier.js (whitelist), tracker-radar-lookup.js (DDG),
 * the shipped ruleset JSON and js/data/needed-trackers-data.json (fetched, not imported —
 * import() is disallowed in a SW).
 *
 * State owned by this module:
 *   exceptionAnchoredHosts {Set|null} — `||host` exceptions and needed-tracker domains (cover host + subdomains)
 *   exceptionCoveredHosts  {Set|null} — every excepted / needed host AND each of its parents,
 *                                       so "a host under this domain is excepted" is one lookup
 *   loadPromise {Promise|null}        — in-flight/completed load, shared by concurrent callers
 *   loadGeneration {number}           — bumped by every reset, so a load still in flight when the session is
 *                                       released never writes its sets back afterwards
 * All three are null/empty until loaded and lost on SW restart; breakageRiskOf() then
 * degrades to "no exception" (never throws) and reconcileMatrixCaches() reloads them.
 */

import { browser } from '../data/ext.js';
import { RISK_HIGH, RISK_MEDIUM, RISK_LOW } from '../data/scriptlet-rule-labels.js';
import { RISK_UNKNOWN } from '../data/risk-badge.js';
import { isBuiltinWhitelisted } from './matrix-classifier.js';
import { isKnownTracker, preloadTrackerRadarData } from './tracker-radar-lookup.js';
import { isDescendantHostnameOfIter } from '../util/utils.js';
import { catchExpected } from '../data/expected-errors.js';

/******************************************************************************/
// Config
/******************************************************************************/

// The hidden tracker-exception ruleset (manifest rule_resources id). Its path is read from the manifest, never retyped.
export const TRACKER_EXCEPTION_RULESET_ID = 'ruleset_tracking_servers_allowlist';
// Disconnect + Ghostery "needed" trackers (tools/build-needed-trackers.mjs): { domains: { <domain>: [...] } }.
export const NEEDED_TRACKERS_FILE = '/js/data/needed-trackers-data.json';

// urlFilter shapes the exception ruleset uses (measured on 11.0.4: 1,263 rules, all but 1 parse):
//   '||host…'          — domain anchor: the host and every subdomain        -> anchored
//   '|https://host^'   — exact host (EFF cookieblock, tracking-allowlist-source.mjs)  -> exact
//   '://host/…'        — any scheme, exact host                              -> exact
// The host ends at the first separator DNR knows ('^', '/', ':', '*', '?') or the end of the filter.
// Anything else (e.g. '.2o7.net/', a bare suffix already covered by an anchored rule) is skipped.
// '_' allowed in the hostname, as in every other hostname check (js/util/utils.js HOSTNAME_LABEL_RE).
const HOST_END = '(?=[\\^/:*?]|$)';
const ANCHORED_HOST_RE = new RegExp(`^\\|\\|([a-z0-9_.-]+)${HOST_END}`, 'i');
const EXACT_HOST_RES = Object.freeze([
    new RegExp(`^\\|https?://([a-z0-9_.-]+)${HOST_END}`, 'i'),
    new RegExp(`^://([a-z0-9_.-]+)${HOST_END}`, 'i'),
]);

/******************************************************************************/
// State — see header
/******************************************************************************/

let exceptionAnchoredHosts = null;
let exceptionCoveredHosts = null;
let loadPromise = null;
let loadGeneration = 0;

/******************************************************************************/
// Pure helpers
/******************************************************************************/

// The host itself and each parent above it, stopping before the bare TLD ('a.b.c.com' -> a.b.c.com, b.c.com, c.com).
function hostAndParents(host) {
    const out = [ host ];
    let h = host;
    for (;;) {
        const dot = h.indexOf('.');
        if ( dot === -1 ) { break; }
        h = h.slice(dot + 1);
        if ( h.indexOf('.') === -1 ) { break; }
        out.push(h);
    }
    return out;
}

// rules (the ruleset JSON array) -> { anchored: Set, exact: Set, skipped: number }. Only 'allow' rules count.
export function extractExceptionHosts(rules) {
    const anchored = new Set();
    const exact = new Set();
    let skipped = 0;
    for ( const rule of Array.isArray(rules) ? rules : [] ) {
        if ( rule?.action?.type !== 'allow' ) { continue; }
        const uf = rule.condition?.urlFilter;
        if ( typeof uf !== 'string' ) { skipped++; continue; }
        const a = ANCHORED_HOST_RE.exec(uf);
        if ( a ) { anchored.add(a[1].toLowerCase()); continue; }
        const e = EXACT_HOST_RES.map(re => re.exec(uf)).find(Boolean);
        if ( e ) { exact.add(e[1].toLowerCase()); continue; }
        skipped++;
    }
    return { anchored, exact, skipped };
}

// The rule itself — signals: { whitelisted, neededBySites, knownTracker } (booleans).
export function classifyBreakageRisk({ whitelisted, neededBySites, knownTracker }) {
    if ( whitelisted ) { return RISK_HIGH; }
    if ( neededBySites ) { return RISK_MEDIUM; }
    if ( knownTracker ) { return RISK_LOW; }
    return RISK_UNKNOWN;
}

/******************************************************************************/
// Loading
/******************************************************************************/

// Fetches one bundled JSON file; a missing/unreadable file yields null (logged), never a throw.
async function fetchBundledJson(file, context) {
    try {
        const res = await fetch(browser.runtime.getURL(file));
        return await res.json();
    } catch (reason) {
        catchExpected(context, [])(reason);
        return null;
    }
}

async function loadNeededHosts() {
    const generation = loadGeneration;
    const resources = browser.runtime.getManifest().declarative_net_request?.rule_resources ?? [];
    const resource = resources.find(r => r.id === TRACKER_EXCEPTION_RULESET_ID);
    // GUARD (init): start empty, so a missing/unreadable file degrades to "not needed", never a throw.
    const anchored = new Set();
    const exact = new Set();
    const [ rules, needed ] = await Promise.all([
        resource !== undefined ? fetchBundledJson(resource.path, 'read tracker-exception ruleset for breakage risk') : null,
        fetchBundledJson(NEEDED_TRACKERS_FILE, 'read needed-trackers data for breakage risk'),
    ]);
    if ( rules !== null ) {
        const hosts = extractExceptionHosts(rules);
        for ( const h of hosts.anchored ) { anchored.add(h); }
        for ( const h of hosts.exact ) { exact.add(h); }
    }
    for ( const d of Object.keys(needed?.domains ?? {}) ) { anchored.add(d.toLowerCase()); }
    const covered = new Set();
    for ( const h of [ ...anchored, ...exact ] ) {
        for ( const p of hostAndParents(h) ) { covered.add(p); }
    }
    if ( generation !== loadGeneration ) { return; }   // GUARD: released while loading — keep the reset state
    exceptionAnchoredHosts = anchored;
    exceptionCoveredHosts = covered;
}

export async function ensureBreakageRiskDataReady() {
    if ( loadPromise === null ) {
        loadPromise = Promise.all([ loadNeededHosts(), preloadTrackerRadarData() ]);
    }
    await loadPromise;
}

// Release guard — drops the cached host sets; the next ensureBreakageRiskDataReady() reloads them.
export function resetBreakageRiskCache() {
    loadGeneration++;
    exceptionAnchoredHosts = null;
    exceptionCoveredHosts = null;
    loadPromise = null;
}

/******************************************************************************/
// Lookup
/******************************************************************************/

// True if an exception / needed entry applies to host, a parent of host (anchored entries only), or a host under it.
function isNeededBySites(host) {
    if ( exceptionCoveredHosts === null || !host ) { return false; }
    return exceptionCoveredHosts.has(host) || isDescendantHostnameOfIter(host, exceptionAnchoredHosts);
}

export function breakageRiskOf(host) {
    const h = typeof host === 'string' ? host.toLowerCase() : '';
    return classifyBreakageRisk({
        whitelisted: h !== '' && isBuiltinWhitelisted(h),
        neededBySites: isNeededBySites(h),
        knownTracker: h !== '' && isKnownTracker(h),
    });
}
