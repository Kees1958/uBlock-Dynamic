/*
 * matrix-panel.js — Matrix panel session state and live-traffic collection
 *
 * Public interface:
 *   startMatrix(tabId, host)  — start session, reload tab
 *   stopMatrix(reason?)       — end session, full cleanup
 *   getMatrixData()           — { session, entries } snapshot, or null
 *   getCurrentSessionSite()   — the eTLD+1 site the active session is
 *                                scoped to, or null — the AUTHORITATIVE
 *                                site for override writes (background.js's
 *                                handleMatrixSetOverride() uses this
 *                                rather than trusting a client-supplied
 *                                site, so a compromised/buggy panel page
 *                                can't scope an override to an arbitrary
 *                                site it isn't actually showing)
 *   refreshOverridesCache()   — re-sync the sync-safe override snapshot
 *                                for the CURRENT session's site (call
 *                                after any override change)
 *   reconcileMatrixCaches()   — SW-restart-safe re-prime of
 *                                blockedDomains/matrixOverridesCache; call
 *                                once at every SW wake (background.js's
 *                                start()), same reconcile-on-wake pattern
 *                                as worry-free-extra-manager.js/worry-
 *                                free-strict-3p-manager.js's own
 *                                reconcile*() functions — see this file's
 *                                own comment on the two module-level
 *                                caches it re-primes for the real bug this
 *                                fixes
 *   startWatchdog()           — SW-restart-safe timeout fallback (call once)
 *
 * ONE ENTRY PER DOMAIN — not per request. This is the actual matrix-grid
 * data model (see CHANGELOG for the earlier per-request-row version this
 * replaces, which didn't look or behave like a matrix at all): each
 * third-party domain observed gets a single row, updated in place as more
 * requests to it arrive, accumulating which resource-type buckets have
 * been seen (image / media / stylesheet / script / frame / fetch-xhr /
 * other — see TYPE_BUCKET below for the webRequest-type -> bucket
 * mapping). No filtering applied to which domains appear — every
 * observed 3P domain gets a row, per this fork's "SHOW MATRIX panel is
 * shown with NO-filtering" design; the "hide already blocked" display is
 * a panel-side (UI) filter over this same full entry list.
 *
 * Each entry carries:
 *   - types: string[] — which buckets have been observed for this domain
 *   - criticalResource: { whitelisted, signal, category, level, greyReason }
 *     — CRITICAL RESOURCE data (matrix-classifier.js); level is the 10.2.0
 *     whitelist level ('white' | 'grey' | null), shown in the domain
 *     cell's tooltip (matrix/matrix-panel.js blockReasonTitle())
 *   (wouldBlockSuspiciousLink / wouldBlockDdns were removed in 10.3.0 with
 *   the "Block suspicious 3P-requests" protection they mirrored.)
 *   - staticallyBlocked — bundled-filter-list whole-domain match
 *   - userRuleBlocked — a BLOCK match in the user's OWN custom/sandbox
 *     "Import ABP rules" dynamic rules (USER_RULES_BASE_ID — dnr-budgets.js),
 *     scoped to the CURRENT session's site exactly like `override` below
 *     (10.6.4 — see refreshUserRuleBlockCache()'s own header for the real
 *     bug this closes: this panel used to have NO signal at all for the
 *     user's own saved rules, static or dynamic)
 *   - override: { all, code } — this domain's override on the CURRENT
 *     session's site only (matrix-block-rules.js is per-site — see its
 *     own header) — the 3P-all/3P-code columns' mini-squares reflect
 *     this directly
 */

import { browser, sessionRead, sessionWrite } from '../data/ext.js';
import { dnr } from '../data/ext-compat.js';
import { broadcastMessage } from '../data/broadcast.js';
import { MSG_MATRIX_ENTRY, MSG_MATRIX_CLOSED } from '../data/message-types.js';
import { DEFAULT_SESSION_TIMEOUT_MS, SESSION_DEADLINE_ALARMS } from '../data/timing-constants.js';
import { createSessionDeadline } from './session-deadline.js';
import { isDescendantHostnameOfIter } from '../util/utils.js';
import { MATRIX_RESOURCE_TYPES, MATRIX_CAP } from '../data/matrix-constants.js';
import { USER_RULES_BASE_ID, USER_RULES_MAX } from './dnr-budgets.js';
import { etldPlusOne, isBuiltinWhitelisted, isSignalDomain, getBuiltinCategory, getWhitelistLevel, getGreyReason } from './matrix-classifier.js';
import { getMatrixOverridesForSite } from './matrix-block-rules.js';
import { isDomainStaticallyBlocked, ensureStaticBlockSetReady, SIMPLE_DOMAIN_RULE } from './static-block-check.js';
import { isKnownTracker } from './tracker-radar-lookup.js';
import { breakageRiskOf, ensureBreakageRiskDataReady, resetBreakageRiskCache } from './breakage-risk.js';
import { catchExpected, EXPECTED_ERRORS } from '../data/expected-errors.js';

const SESSION_TIMEOUT_MS = DEFAULT_SESSION_TIMEOUT_MS;
const DOMAIN_CAP = MATRIX_CAP; // max distinct domains per session, same cap value as the old per-request FIFO used
const STORAGE_KEY = 'matrixPanelState';

// webRequest resourceType -> matrix column bucket. Anything not listed
// here (font, object, ping, csp_report, websocket, webbundle, and any
// future type Chrome adds) falls into "other" — a deliberately open
// fallback rather than an exhaustive list that breaks when Chrome adds a
// new resourceType.
const TYPE_BUCKET = Object.freeze({
    image: 'image',
    media: 'media',
    stylesheet: 'stylesheet',
    script: 'script',
    sub_frame: 'frame',
    xmlhttprequest: 'fetch/xhr',
});
function bucketFor(webRequestType) {
    return TYPE_BUCKET[webRequestType] ?? 'other';
}

// Same chrome.storage.session survival reasoning as privacy-inspector.js's
// own header comment — see that file for the full "why not a plain let"
// explanation. Identical pattern, applied here.
let session = null;
// Map, not a plain object — this can accumulate up to DOMAIN_CAP (100)
// dynamically-keyed entries per session, comfortably past V8's
// dictionary-mode threshold for plain objects (property access falls
// back to a hash table once an object accumulates enough dynamic string
// keys, losing the fast hidden-class/inline-offset path). The
// webRequest listener below — the actual hot path, firing on every
// third-party request, not just once per page load — reads/writes this
// on every call, so staying on the fast path matters here specifically
// in a way it doesn't for this file's other, far-less-frequently-touched
// state. Map is also immune to the same slowdown Object suffers from
// deleting properties (irrelevant here — nothing ever deletes from this
// one — but the same reasoning applies to matrixOverridesCache below).
// Iteration order is insertion order for Map too (see getMatrixData()),
// so this preserves that property exactly, not just the perf win.
let entriesByDomain = new Map(); // domain -> entry
let hydrated = false;
let sessionTimeoutHandle = null;

const hydration = (async ( ) => {
    const stored = await sessionRead(STORAGE_KEY);
    if ( stored ) {
        session = stored.session ?? null;
        // chrome.storage.session only stores plain JSON-serializable
        // values — Map isn't one, so the on-disk shape stays a plain
        // object (Object.entries/fromEntries at this one boundary,
        // see persist() below for the write side), while everything
        // in-memory works with the Map directly.
        entriesByDomain = new Map(
            stored.entriesByDomain && typeof stored.entriesByDomain === 'object'
                ? Object.entries(stored.entriesByDomain)
                : []
        );
    }
    hydrated = true;
    syncRequestListener();   // a session re-hydrated after a worker restart gets its listener back
})();

async function ensureHydrated() {
    if ( !hydrated ) { await hydration; }
}

async function persist() {
    await sessionWrite(STORAGE_KEY, { session, entriesByDomain: Object.fromEntries(entriesByDomain) });
}

function scheduleSessionTimeout(remainingMs) {
    clearSessionTimeoutHandle();
    sessionTimeoutHandle = setTimeout(() => { stopMatrix('timeout'); }, remainingMs);
}

function clearSessionTimeoutHandle() {
    if ( sessionTimeoutHandle !== null ) {
        clearTimeout(sessionTimeoutHandle);
        sessionTimeoutHandle = null;
    }
}

/******************************************************************************/
// Session lifecycle
/******************************************************************************/

export async function startMatrix(tabId, host) {
    await ensureHydrated();
    // 'clash' — same reasoning as privacy-inspector.js's startPrivacyInspector():
    // a second tab starting the Matrix panel properly notifies the first
    // panel to close instead of abandoning it.
    await stopMatrix('clash');
    // (11.1.0) Started here — AFTER stopMatrix(), which releases this data — so the fetches overlap the steps below,
    // and AWAITED before the tab reload: the Known tracker and Break risk columns are computed once, when a domain's
    // first request arrives, so the data must be loaded by then. The DDG preload used to be fire-and-forget, which
    // could leave the first rows of a session on "N".
    const riskDataReady = ensureBreakageRiskDataReady();
    entriesByDomain = new Map();
    session = {
        tabId,
        host,
        // session.host is the FULL hostname (e.g. "www.nbcnews.com" — see
        // handleStartMatrix() in background.js); the webRequest listener
        // below needs the eTLD+1-reduced form (e.g. "nbcnews.com") to
        // compare against etldPlusOne(details.url) correctly — computed
        // once here rather than on every single request, and rather than
        // comparing the two different reductions directly (a real bug an
        // earlier version of this file had: comparing full-hostname
        // session.host against eTLD+1 hostname never matched, letting
        // first-party subdomains leak through as false third-party
        // entries).
        hostEtldPlusOne: etldPlusOne(`https://${host}`),
        phase: 'running',
        startTime: Date.now(),
        timeElapsed: 0,
    };
    await persist();
    syncRequestListener();   // before the tab reload below, so the first requests are seen
    scheduleSessionTimeout(SESSION_TIMEOUT_MS);
    await deadline.arm(SESSION_TIMEOUT_MS);
    await ensureStaticBlockSetReady();
    await refreshOverridesCache();
    await refreshUserRuleBlockCache();
    await riskDataReady;
    await browser.tabs.reload(tabId).catch(catchExpected('reload Matrix tab', [ EXPECTED_ERRORS.TAB_GONE ]));
}

export async function stopMatrix(reason = 'user') {
    await ensureHydrated();
    const hadSession = session !== null;
    clearSessionTimeoutHandle();
    await deadline.disarm();   // GUARD (release): no timer or alarm outlives the session
    session = null;
    entriesByDomain = new Map();
    // GUARD (release, audit 10.6.4): the per-site user-rule caches belong to the session's site —
    // drop them with it (rebuilt by refreshUserRuleBlockCache() on the next start/reconcile).
    userRuleBlockedDomains = new Set();
    userRuleAllowedDomains = new Set();
    resetBreakageRiskCache();   // GUARD (release, 11.1.0): the exception host sets go with the session
    syncRequestListener();   // GUARD (release): no request listener outlives the session
    await persist();
    if ( hadSession ) {
        broadcastMessage({ what: MSG_MATRIX_CLOSED, reason });
    }
}

export async function getMatrixData() {
    await ensureHydrated();
    if ( !session ) { return null; }
    const elapsed = session.timeElapsed + (
        session.phase === 'running' && session.startTime !== null
            ? Date.now() - session.startTime
            : 0
    );
    if ( elapsed >= SESSION_TIMEOUT_MS ) {
        await stopMatrix('timeout');
        return null;
    }
    return {
        session: { ...session },
        entries: [ ...entriesByDomain.values() ],
    };
}

/******************************************************************************/
// Live traffic listener — always registered (module load time), internally
// phase-gated rather than attached/detached per session. Same reasoning as
// the removed block-monitor.js's own listener: an always-on registration
// survives SW restarts trivially (it's just top-level code that re-runs on
// every SW start), where a conditionally-attached one would need its own
// re-attach-on-restart logic for no benefit — the internal `session` check
// below is just as cheap as attaching/detaching would be.
/******************************************************************************/

function newEntry(hostname) {
    return {
        domain: hostname,
        types: [],
        criticalResource: {
            whitelisted: isBuiltinWhitelisted(hostname),
            signal: isSignalDomain(hostname),
            category: getBuiltinCategory(hostname),
            level: getWhitelistLevel(hostname),          // 10.2.0: 'white' | 'grey' | null
            greyReason: getGreyReason(hostname),         // why anyone can publish there, or null
        },
        // Whole-domain bundled-filter-list match (see static-block-check.js
        // — same ~25%-of-rules whole-domain-only limitation noted there
        // applies here too, honestly carried over rather than implying
        // more coverage than this actually has).
        staticallyBlocked: isDomainStaticallyBlocked(hostname),
        // See this file's own header + refreshUserRuleBlockCache()'s
        // header for the real bug this field closes.
        userRuleBlocked: isUserRuleBlocked(hostname),
        // KNOWN TRACKER column — presence-only check against the bundled
        // DDG Tracker Radar dataset (js/data/tracker-radar-data.json), via
        // tracker-radar-lookup.js. Distinct from the old (removed) DDG
        // breakage-risk verdict this dataset used to power — this is a
        // simple Y/N informational signal, not a block/allow decision.
        ddgTracker: isKnownTracker(hostname),
        // (11.1.0) BREAK RISK column — high/medium/low/unknown, one verdict per domain (js/core/breakage-risk.js).
        breakageRisk: breakageRiskOf(hostname),
        override: matrixOverridesCache.get(hostname) ?? { all: null, code: null },
        // Observed FULL hostnames under this domain (e.g. accounts.google.com
        // under google.com) — ONLY populated for CRITICAL RESOURCE-whitelisted
        // domains (see maybeTrackSubdomain() below). A whitelisted eTLD+1 like
        // google.com is too broad a unit to sensibly block/allow as one thing
        // — the panel shows its actual observed subdomains as child rows so
        // the user can act on e.g. just a tracking subdomain without also
        // affecting accounts.google.com. Not populated for non-whitelisted
        // domains: there the eTLD+1-level row is already the right
        // granularity, and tracking every subdomain of every domain would
        // bloat the panel for no benefit.
        subdomains: [],
    };
}

// A subdomain's own row is a lightweight version of a top-level entry —
// same CRITICAL RESOURCE / override AND already-blocked fields
// (staticallyBlocked, userRuleBlocked), computed for the EXACT subdomain, not inherited
// from the parent — a subdomain can legitimately differ from its parent
// on any of these (e.g. on the signal list even when its parent is fully
// whitelisted; or statically blocked by a filter list even when its
// parent isn't, or vice versa — this was a real bug: an earlier version
// hardcoded these three to false, so a child row could never be hidden
// by the "hide already blocked" filter even when its parent correctly
// was, making the child look orphaned once the parent disappeared).
// The one thing genuinely NOT tracked per-subdomain is connection type
// (types stays empty, every type/single column renders as "—") — tracking
// resource types separately per subdomain would be a much larger change
// for a benefit this feature doesn't need: the point is targeted
// block/allow, not a second matrix nested inside the first.
function newSubdomainEntry(fullHost) {
    return {
        domain: fullHost,
        types: [],
        criticalResource: {
            whitelisted: isBuiltinWhitelisted(fullHost),
            signal: isSignalDomain(fullHost),
            category: getBuiltinCategory(fullHost),
            level: getWhitelistLevel(fullHost),          // 10.2.0: 'white' | 'grey' | null
            greyReason: getGreyReason(fullHost),         // why anyone can publish there, or null
        },
        staticallyBlocked: isDomainStaticallyBlocked(fullHost),
        userRuleBlocked: isUserRuleBlocked(fullHost),
        ddgTracker: isKnownTracker(fullHost),
        breakageRisk: breakageRiskOf(fullHost),
        override: matrixOverridesCache.get(fullHost) ?? { all: null, code: null },
    };
}

// Called for every observed request on a whitelisted domain — adds the
// EXACT hostname as a child row if it isn't the bare eTLD+1 itself and
// isn't already tracked. No-op (returns immediately) for non-whitelisted
// domains — see newEntry()'s own comment on subdomains for why this is
// deliberately scoped to whitelisted domains only.
function maybeTrackSubdomain(entry, url) {
    if ( !entry.criticalResource.whitelisted ) { return; }
    let fullHost;
    try {
        fullHost = new URL(url).hostname.toLowerCase();
    } catch {
        return;
    }
    if ( !fullHost || fullHost === entry.domain ) { return; } // bare domain itself, not a subdomain
    if ( entry.subdomains.some(sub => sub.domain === fullHost) ) { return; } // already tracked
    entry.subdomains.push(newSubdomainEntry(fullHost));
}

// The site the current session is scoped to (eTLD+1) — authoritative
// source for background.js's handleMatrixSetOverride(), and for
// refreshOverridesCache() below. null if no session is running.
export function getCurrentSessionSite() {
    return session?.hostEtldPlusOne ?? null;
}

// The tabId the current session is watching — authoritative source for
// background.js's handleReloadMatrixTab() (the Refresh button). Same
// reasoning as getCurrentSessionSite() just above: derived server-side
// from the session, never taken from the panel's request payload, so a
// buggy/compromised panel page can't ask the background to reload some
// OTHER tab. null if no session is running.
export function getCurrentSessionTabId() {
    return session?.tabId ?? null;
}

// matrixOverridesCache: an in-memory snapshot of
// getMatrixOverridesForSite(currentSite), refreshed on session start and
// every override change (see refreshOverridesCache() calls) — the
// webRequest listener below must be synchronous, so this cache is the
// bridge between that constraint and matrix-block-rules.js's async
// storage-backed source of truth. Map, not a plain object, for the same
// reason as entriesByDomain above — read on every request in that same
// listener, keyed by arbitrary domain strings. Rebuilt fresh (not
// mutated in place) on every refresh, so unlike entriesByDomain there's
// no per-entry delete to worry about either way, but Map is still the
// right fit given how it's read.
let matrixOverridesCache = new Map();

// userRuleBlockedDomains: PER-SITE (current session's site), same async-
// to-sync bridging reasoning as matrixOverridesCache just above — the
// webRequest listener and newEntry()/newSubdomainEntry() all need a
// synchronous answer, so this is rebuilt on session start/reconcile, not
// queried live on every request.
//
// BUG FIX (real report, 10.6.4): this panel's "already blocked?" signal
// (isAlreadyBlocked(), matrix/matrix-panel.js) used to check ONLY
// entry.staticallyBlocked (bundled static filter lists, static-block-
// check.js) and entry.override (THIS panel's own click overrides,
// matrix-block-rules.js). A domain blocked purely by the user's own
// "Import ABP rules" sandbox rule (USER_RULES_BASE_ID, dnr-budgets.js)
// was invisible to both — confirmed via a real case: a saved
// `||sentry.io^$domain=nos.nl` rule genuinely blocked the request
// (verified in DevTools' Network tab), while the Matrix panel kept
// showing sentry.io under "domains not yet blocked" with no way to tell
// it was already handled. This cache closes that gap, scoped to the
// CURRENT site exactly like matrixOverridesCache above — NOT folded into
// isDomainStaticallyBlocked()/blockedDomains (static-block-check.js),
// since that cache is deliberately site-UNaware (a global whole-domain
// Set), while a sandbox rule's `$domain=` scoping is exactly as
// site-specific as a Matrix-panel override.
let userRuleBlockedDomains = new Set();
// (audit 10.6.4, B-2) Whole-domain user ALLOW rules (`@@||x.com^`) on the current site. A user
// allow rule cancels a user block rule for the same domain (and its subdomains), so a domain in
// here is never reported as user-rule-blocked. Rebuilt together with userRuleBlockedDomains.
let userRuleAllowedDomains = new Set();

// DNR action types that let a request through — the counterpart of 'block' for B-2 above.
const USER_RULE_ALLOW_ACTIONS = new Set([ 'allow', 'allowAllRequests' ]);

// domainType values under which a rule still covers a third-party domain on the current site.
// The Matrix panel lists third-party domains only, so `thirdParty` or no domainType both count;
// `firstParty` never matches a row the panel shows.
const USER_RULE_WHOLE_DOMAIN_TYPES = new Set([ undefined, 'thirdParty' ]);

// Site scoping, same semantics matrix-block-rules.js's own per-(site,domain) overrides already
// use: excluded wins over included; no initiatorDomains at all means the rule applies
// everywhere (a global custom rule), so it always counts regardless of the current site.
function userRuleAppliesOnSite(cond, site) {
    if ( Array.isArray(cond.excludedInitiatorDomains) && cond.excludedInitiatorDomains.length > 0 ) {
        if ( cond.excludedInitiatorDomains.includes(site) ||
             isDescendantHostnameOfIter(site, cond.excludedInitiatorDomains) ) { return false; }
    }
    if ( Array.isArray(cond.initiatorDomains) && cond.initiatorDomains.length > 0 ) {
        return cond.initiatorDomains.includes(site) ||
            isDescendantHostnameOfIter(site, cond.initiatorDomains);
    }
    return true;
}

// (audit 10.6.4, B-2) True only when the rule covers EVERY request to its domain(s): no
// resource-type or request-method restriction, no URL path or regex, and a domainType that
// still reaches the third-party rows. A partial rule (e.g. `$script` only) used to mark the
// whole domain BLOCKED while its other requests still loaded — against this cache's own
// "never show an unblocked domain as blocked" principle.
function isWholeDomainUserRule(cond) {
    if ( Array.isArray(cond.resourceTypes) && cond.resourceTypes.length > 0 ) { return false; }
    if ( Array.isArray(cond.excludedResourceTypes) && cond.excludedResourceTypes.length > 0 ) { return false; }
    if ( Array.isArray(cond.requestMethods) && cond.requestMethods.length > 0 ) { return false; }
    if ( Array.isArray(cond.excludedRequestMethods) && cond.excludedRequestMethods.length > 0 ) { return false; }
    if ( cond.regexFilter !== undefined ) { return false; }
    if ( USER_RULE_WHOLE_DOMAIN_TYPES.has(cond.domainType) === false ) { return false; }
    if ( cond.urlFilter !== undefined && SIMPLE_DOMAIN_RULE.test(cond.urlFilter) === false ) { return false; }
    return true;
}

// Same dual extraction form as static-block-check.js's own buildBlockedDomainSet()
// (requestDomains array AND the simple ||domain^ urlFilter shape) — reused via the exported
// SIMPLE_DOMAIN_RULE rather than a second, independently-maintained copy (C21/B15).
function addUserRuleDomains(cond, target) {
    for ( const d of (cond.requestDomains ?? []) ) { target.add(d.toLowerCase()); }
    if ( cond.urlFilter !== undefined ) {
        const match = SIMPLE_DOMAIN_RULE.exec(cond.urlFilter);
        if ( match ) { target.add(match[1].toLowerCase()); }
    }
}

export async function refreshUserRuleBlockCache() {
    const site = getCurrentSessionSite();
    // GUARD (init): fresh sets every pass — never mutate the live ones mid-build.
    let nextBlocked = new Set();
    let nextAllowed = new Set();
    if ( site ) {
        try {
            const rules = await dnr.getDynamicRules();
            for ( const rule of rules ) {
                if ( rule.id < USER_RULES_BASE_ID || rule.id >= USER_RULES_BASE_ID + USER_RULES_MAX ) { continue; }
                const type = rule.action?.type;
                const isBlock = type === 'block';
                if ( isBlock === false && USER_RULE_ALLOW_ACTIONS.has(type) === false ) { continue; }
                const cond = rule.condition ?? {};
                if ( userRuleAppliesOnSite(cond, site) === false ) { continue; }
                if ( isWholeDomainUserRule(cond) === false ) { continue; }
                addUserRuleDomains(cond, isBlock ? nextBlocked : nextAllowed);
            }
        } catch (reason) {
            // (audit 10.6.4, B-3) Fails OPEN and logs: a half-built set could mark only some
            // domains, so on any error the panel shows no user-rule blocks at all — a transient
            // dnr.getDynamicRules() error must never cause an unblocked domain to display as
            // blocked. (Was a bare catch that kept the partial set, with no trace.)
            console.warn('[uBlock-Dynamic] Matrix: user-rule block cache not refreshed —', reason);
            nextBlocked = new Set();
            nextAllowed = new Set();
        }
    }
    userRuleBlockedDomains = nextBlocked;
    userRuleAllowedDomains = nextAllowed;
    // Same "refresh in place" reasoning refreshOverridesCache() applies to
    // its own override field — existing on-screen entries were computed
    // against whatever this cache held at THEIR creation time, so a
    // domain already tracked before a sandbox-rule save (or before a
    // reconcile) is corrected retroactively, not just future ones.
    for ( const [ domain, entry ] of entriesByDomain ) {
        entry.userRuleBlocked = isUserRuleBlocked(domain);
        for ( const sub of entry.subdomains ) {
            sub.userRuleBlocked = isUserRuleBlocked(sub.domain);
        }
    }
}

function hostnameInDomainSet(hostname, domains) {
    return domains.has(hostname) || isDescendantHostnameOfIter(hostname, domains);
}

function isUserRuleBlocked(hostname) {
    if ( hostnameInDomainSet(hostname, userRuleAllowedDomains) ) { return false; }   // B-2: user @@ wins
    return hostnameInDomainSet(hostname, userRuleBlockedDomains);
}

export async function refreshOverridesCache() {
    const site = getCurrentSessionSite();
    // getMatrixOverridesForSite() still returns a plain object (its own
    // internal storage isn't Map — a separate, lower-priority follow-up,
    // see matrix-block-rules.js), so this is the one place that needs
    // converting at the boundary.
    matrixOverridesCache = site
        ? new Map(Object.entries(await getMatrixOverridesForSite(site)))
        : new Map();
    // Existing on-screen entries' override field is stale the moment this
    // changes (e.g. right after the user clicks a 3P-all/3P-code cell) —
    // refresh them in place so the very next broadcast/poll reflects the
    // new state, rather than waiting for a new request to that domain.
    for ( const [ domain, entry ] of entriesByDomain ) {
        entry.override = matrixOverridesCache.get(domain) ?? { all: null, code: null };
        for ( const sub of entry.subdomains ) {
            sub.override = matrixOverridesCache.get(sub.domain) ?? { all: null, code: null };
        }
    }
}

// ── SW-restart reconciliation ────────────────────────────────────────────
// Real bug (found via a live report — a genuinely-blocked domain, and
// separately a genuinely-active ALLOW override, both silently invisible
// to this panel mid-session): blockedDomains (static-block-check.js) and
// matrixOverridesCache above are both plain module-level variables,
// primed only at startMatrix() (and matrixOverridesCache again on every
// override change) — NEITHER is wired into ensureHydrated(), which only
// restores session/entriesByDomain. An MV3 service worker restarts on
// its own idle schedule, easily within a multi-minute Matrix session;
// after a restart, session correctly rehydrates from
// chrome.storage.session on the next call, but these two caches reset to
// empty and are NEVER rebuilt again for the rest of that session —
// isDomainStaticallyBlocked() silently returns false for every domain,
// and matrixOverridesCache.get() silently returns "no override" for
// every domain, even ones genuinely blocked or genuinely overridden.
//
// Fix: same reconcile-on-every-SW-wake pattern already proven for this
// exact class of problem — worry-free-extra-manager.js's
// reconcileWorryFreeExtraSuppressionRule() and worry-free-strict-3p-
// manager.js's reconcileWorryFreeStrict3pRules(), both called
// unconditionally from background.js's start() on every SW instantiation
// (fresh install, version bump, or plain wakeup alike) — ported here
// rather than inventing a different mechanism (C21). Only does the real
// work (fetching/parsing ruleset JSON, re-reading override storage) when
// a Matrix session is actually running — cheap no-op otherwise, so this
// adds no overhead to the common case of Matrix not being in use.
export async function reconcileMatrixCaches() {
    await ensureHydrated();
    if ( !session || session.phase !== 'running' ) { return; }
    await ensureStaticBlockSetReady();
    await ensureBreakageRiskDataReady();   // (11.1.0) lost on SW restart, like the caches below
    await refreshOverridesCache();
    // (10.6.4) refreshUserRuleBlockCache() joins the same reconcile-on-
    // every-SW-wake call — it's exactly the same "async cache, module-
    // level variable, reset to empty on SW restart" shape as the two
    // above, so it needs the identical treatment for the identical reason.
    // refreshUserRuleBlockCache() refreshes its own existing-entries'
    // userRuleBlocked field in place internally (same place
    // refreshOverridesCache() does for its own override field, just
    // above) — not duplicated here.
    await refreshUserRuleBlockCache();
    // Existing on-screen entries were computed against whatever this
    // cache held at THEIR creation time (possibly pre-restart, possibly
    // never-primed-at-all) — same "refresh in place" reasoning
    // refreshOverridesCache() already applies to its own override field,
    // extended here to staticallyBlocked, so a domain recorded before
    // this reconciliation ran is corrected retroactively, not just future
    // ones recorded after it.
    // (11.1.0) ddgTracker and breakageRisk too: a row recorded while the worker was still reloading their data
    // after a restart would otherwise keep "N" / "unknown" for the rest of the session.
    for ( const [ domain, entry ] of entriesByDomain ) {
        entry.staticallyBlocked = isDomainStaticallyBlocked(domain);
        entry.ddgTracker = isKnownTracker(domain);
        entry.breakageRisk = breakageRiskOf(domain);
        for ( const sub of entry.subdomains ) {
            sub.staticallyBlocked = isDomainStaticallyBlocked(sub.domain);
            sub.ddgTracker = isKnownTracker(sub.domain);
            sub.breakageRisk = breakageRiskOf(sub.domain);
        }
    }
    await persist();
}

// (10.5.6) Attached ONLY while a session runs (syncRequestListener()). It used to be registered at load for
// <all_urls>, so Chrome woke the service worker for every request of every tab even with the Matrix closed
// (measured: 535 calls in 47 s with 10 idle tabs) and the worker never went idle. A running session keeps the
// worker awake anyway (the panel polls every 15 s), and hydration re-attaches it after a worker restart.
const REQUEST_FILTER = Object.freeze({ urls: [ '<all_urls>' ], types: MATRIX_RESOURCE_TYPES });

function onMatrixRequest(details) {
    if ( !session || session.phase !== 'running' ) { return; }
    if ( details.tabId !== session.tabId ) { return; }
    if ( session.startTime === null ) { return; }

    const hostname = etldPlusOne(details.url);
    if ( !hostname || hostname === session.hostEtldPlusOne ) { return; } // first-party — Matrix is 3P-only, per its own purpose

    let entry = entriesByDomain.get(hostname);
    let isNewDomain = false;
    if ( !entry ) {
        if ( entriesByDomain.size >= DOMAIN_CAP ) { return; } // cap reached — stop adding new domains, existing rows keep updating
        entry = newEntry(hostname);
        entriesByDomain.set(hostname, entry);
        isNewDomain = true;
    }

    const bucket = bucketFor(details.type);
    if ( entry.types.indexOf(bucket) === -1 ) { entry.types.push(bucket); }
    maybeTrackSubdomain(entry, details.url);

    persist();
    broadcastMessage({ what: MSG_MATRIX_ENTRY, entry, isNewDomain });
}

// Attach the request listener while a session runs, detach it otherwise (init / release guard — idempotent,
// so every phase change can simply call it).
function syncRequestListener() {
    const wanted = session !== null && session.phase === 'running';
    const attached = browser.webRequest.onBeforeRequest.hasListener(onMatrixRequest);
    if ( wanted && !attached ) { browser.webRequest.onBeforeRequest.addListener(onMatrixRequest, REQUEST_FILTER); }
    else if ( !wanted && attached ) { browser.webRequest.onBeforeRequest.removeListener(onMatrixRequest); }
}

/******************************************************************************/
// Watchdog — identical rationale/shape to privacy-inspector.js's own
// startWatchdog(). See that module's header comment for the full "why".
/******************************************************************************/

// (10.7.6) Deadline alarm — js/core/session-deadline.js, same mechanism as privacy-inspector.js (C21): armed with a
// session, cleared when it ends; wakes the worker at the deadline. Replaces the 10.5.0 setInterval watchdog.
const deadline = createSessionDeadline({
    alarms: browser.alarms,
    alarmName: SESSION_DEADLINE_ALARMS.MATRIX,
    timeoutMs: SESSION_TIMEOUT_MS,
    ensureHydrated,
    getSession: () => session,
    onTimeout: () => stopMatrix('timeout'),
    // Nothing of a Matrix session lives outside chrome.storage.session (its request listener is phase-gated).
});

// background.js onAlarm: true when it was this session's deadline.
export function handleMatrixDeadlineAlarm(alarmName) {
    return deadline.handleAlarm(alarmName);
}

// Called once at SW boot by background.js: a running (re-hydrated) session gets its alarm.
export function reconcileMatrixDeadline() {
    return deadline.reconcile();
}
