/*
 * static-block-check.js — Packed-install-compatible "already blocked?" check
 *
 * Public interface:
 *   ensureStaticBlockSetReady() — builds the domain Set once (idempotent,
 *                                 safe to call every session start)
 *   isDomainStaticallyBlocked(domain) — synchronous Set lookup
 *   resetStaticBlockCache()     — release guard; forces a rebuild on next
 *                                 ensureStaticBlockSetReady() call (used
 *                                 when the user toggles a ruleset on/off,
 *                                 so the check reflects the new selection)
 *
 * WHY THIS EXISTS
 * declarativeNetRequest.onRuleMatchedDebug (block-monitor.js's original
 * blocked-status signal) is a Chrome platform restriction: it ONLY fires
 * for unpacked extensions, even with declarativeNetRequestFeedback
 * declared — confirmed via Chrome's own docs, not something any code
 * change here can lift. For a Chrome Web Store install (the vast
 * majority of real users), that signal silently never fires, so
 * already-blocked requests were staying visible in DDG Tracker Radar
 * instead of being filtered out.
 *
 * This module is a DIFFERENT signal that works identically whether
 * packed or unpacked: it reads the same static ruleset JSON files this
 * extension already bundles (rulesets/*.json) and extracts simple,
 * whole-domain block rules (urlFilter === '||domain' or '||domain^',
 * with no path/pattern component) into a plain Set. No restricted API
 * involved — just data already shipped in the extension, read via
 * fetch(runtime.getURL(...)), same as any other bundled asset.
 *
 * KNOWN LIMITATION (real, not hidden): this only catches whole-domain
 * block rules, not path/pattern-specific ones (e.g. a rule that only
 * blocks '/ads/specific-endpoint.js' on an otherwise-unblocked domain).
 * BUG FIX + RE-MEASURED (this release): the extraction used to only
 * check condition.urlFilter, missing every domain folded into a
 * coalesced condition.requestDomains array — build-rulesets.mjs bundles
 * most whole-domain rules into a handful of large requestDomains arrays
 * to stay under Chrome's rule-count budget, so this was the MAJORITY
 * case being silently missed, not an edge case (found via a real report:
 * doubleclick.net showing genuinely blocked in DevTools but "not
 * blocked" here — confirmed it existed only inside a 3069-domain and a
 * 416-domain coalesced array, never its own rule). Now correctly walks
 * both forms. Current measured coverage: 216 whole-domain-shaped rule
 * objects (out of 4571 total enabled block rules — most of the remaining
 * ~4355 are genuinely path/pattern-specific, not a missed-coalescing
 * artifact) account for 15,190 distinct domains this check can actually
 * detect as blocked — a rule-object percentage is a misleading way to
 * state this specific number, since coalescing makes "rules" and
 * "domains covered" very different scales; re-measure directly (see
 * CHANGELOG for the one-off script used) rather than trusting a
 * percentage figure at a glance. A full DNR-equivalent urlFilter matcher
 * (wildcards, anchors, domainType, priority/allow overrides) would close
 * the remaining path/pattern-specific gap but is a substantially larger
 * undertaking; this is the practical first step.
 */

import { browser } from '../data/ext.js';
import { getEnabledRulesets } from './static-rulesets.js';
import { isDescendantHostnameOfIter } from '../util/utils.js';
import { catchExpected } from '../data/expected-errors.js';

/******************************************************************************/
// Config
/******************************************************************************/

// Matches DNR's whole-domain anchor form exactly: '||domain' or '||domain^',
// nothing else. Anything with a path, wildcard, or extra separator is
// intentionally NOT matched here — see the module header's KNOWN LIMITATION.
// Exported (10.6.4) so matrix-panel.js's own site-scoped user-rule-block
// cache can reuse the exact same whole-domain-shaped-rule extraction
// instead of a second, independently-maintained copy (C21/B15) — see
// that module's refreshUserRuleBlockCache() for the real bug this closes.
// (11.0.2) '_' allowed in the hostname, as in every other hostname check (js/util/utils.js HOSTNAME_LABEL_RE).
export const SIMPLE_DOMAIN_RULE = /^\|\|([a-z0-9_.-]+)\^?$/i;

/******************************************************************************/
// Lazy-built cache — built once, on first use, not eagerly at module load.
/******************************************************************************/

let blockedDomains = null;   // null until built
let buildPromise = null;     // in-flight build, so concurrent callers share one fetch pass

async function buildBlockedDomainSet() {
    const manifest = browser.runtime.getManifest();
    const resources = manifest.declarative_net_request?.rule_resources ?? [];
    const enabledIds = await getEnabledRulesets();

    const domainSet = new Set();

    await Promise.all(
        resources
            // (10.3.0) The security-owned ruleset exclusion (ruleset_suspicious_hosting) went with that ruleset.
            .filter(r => enabledIds.has(r.id))
            .map(async r => {
                try {
                    const res = await fetch(browser.runtime.getURL(r.path));
                    const rules = await res.json();
                    for ( const rule of rules ) {
                        if ( rule.action?.type !== 'block' ) { continue; }
                        // BUG FIX (found via a real report — DevTools
                        // Network tab showed doubleclick.net genuinely
                        // blocked; this checker showed it as NOT blocked):
                        // this only ever checked condition.urlFilter via
                        // SIMPLE_DOMAIN_RULE — it never looked at
                        // condition.requestDomains at all. But
                        // build-rulesets.mjs's own coalescing step
                        // bundles MANY simple whole-domain rules into ONE
                        // rule's requestDomains array (visible in that
                        // script's own build-time log lines — "coalesced
                        // N bare + M third-party hostname blocks → K
                        // rule(s)"), specifically to stay under Chrome's
                        // rule-count budget. That coalescing is the
                        // MAJORITY-case output shape for whole-domain
                        // rules across nearly every bundled list —
                        // confirmed directly: doubleclick.net existed ONLY
                        // inside a 3069-domain coalesced requestDomains
                        // array (the since-removed Disconnect list) and a
                        // 416-domain one (ruleset_kees1958.json), never as
                        // its own standalone urlFilter rule. The module's
                        // own header comment's "roughly 25%" coverage
                        // figure was measured against the urlFilter-only
                        // extraction this fixes — expect it to be
                        // substantially higher now; re-measure before
                        // trusting that number again.
                        // (10.7.6) requestDomains next to a URL pattern or regex is a "$to=" target list — only
                        // those URLs on those hosts are blocked, not the hosts — so it is not a whole-domain block.
                        // The coalesced whole-domain rules never carry either.
                        const narrowedByUrl = rule.condition?.urlFilter !== undefined || rule.condition?.regexFilter !== undefined;
                        for ( const d of (narrowedByUrl ? [] : rule.condition?.requestDomains ?? []) ) {
                            domainSet.add(d.toLowerCase());
                        }
                        const uf = rule.condition?.urlFilter;
                        if ( !uf ) { continue; }
                        const match = SIMPLE_DOMAIN_RULE.exec(uf);
                        if ( match ) { domainSet.add(match[1].toLowerCase()); }
                    }
                } catch (reason) {
                    // One unreadable/malformed ruleset file shouldn't take
                    // down the whole build — skip it, keep the rest, but log it (C5).
                    catchExpected('read static ruleset for block check', [])(reason);
                }
            })
    );

    return domainSet;
}

/******************************************************************************/
// Public API
/******************************************************************************/

export async function ensureStaticBlockSetReady() {
    if ( blockedDomains !== null ) { return; }
    if ( buildPromise === null ) {
        buildPromise = buildBlockedDomainSet().then(set => {
            blockedDomains = set;
        });
    }
    await buildPromise;
}

// Synchronous — call only after ensureStaticBlockSetReady() has resolved.
// Fails open (returns false / "not blocked") if called before the set is
// built, rather than risking a false positive that hides a genuinely
// unblocked entry.
// BUG FIX (found via a real report — DevTools Network tab showed
// static-ah.xhcdn.com genuinely blocked, blockedDomains contained
// "xhcdn.com", Matrix panel still showed nothing): this was a plain
// exact-string Set lookup. A `||domain^` DNR rule (the shape
// buildBlockedDomainSet() above extracts) blocks that domain AND every
// subdomain — Chrome's own domain-anchor semantics — but `blockedDomains`
// only ever stores the bare domain string, so a subdomain never matched
// here even though it's genuinely blocked. Ported isDescendantHostnameOfIter()
// (js/util/utils.js) rather than writing new subdomain-walking logic —
// same "walk up the label chain against a Set" check this codebase
// already uses elsewhere (C21). Exact match is still checked first/also,
// since isDescendantHostnameOfIter() only checks PARENT domains, not the
// domain itself.
export function isDomainStaticallyBlocked(domain) {
    if ( blockedDomains === null || !domain ) { return false; }
    return blockedDomains.has(domain) || isDescendantHostnameOfIter(domain, blockedDomains);
}

// Release guard — call when the user's enabled-ruleset selection changes,
// so the next session rebuilds against the new selection instead of a
// stale one.
export function resetStaticBlockCache() {
    blockedDomains = null;
    buildPromise = null;
}
