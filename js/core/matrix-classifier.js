/*
 * matrix-classifier.js — Pure per-domain classification for the Matrix panel
 *
 * Public interface:
 *   etldPlusOne(url)                 — eTLD+1 host extraction, '' on failure
 *   isBuiltinWhitelisted(host)       — true if host is on BUILTIN_DOMAINS
 *                                       (CRITICAL RESOURCE column, green)
 *   isSignalDomain(host)             — true if host is on SIGNAL_DOMAINS
 *                                       (CRITICAL RESOURCE column, yellow —
 *                                       informational only, never implies
 *                                       any block/allow decision)
 *   getBuiltinCategory(host)         — human-readable category string or
 *                                       null, for the column's tooltip
 *   getWhitelistLevel(host)          — WHITELIST_LEVEL.WHITE / .GREY / null
 *                                       (10.2.0 — see matrix-constants.js's
 *                                       "Whitelist levels" block)
 *   getGreyReason(host)              — why anyone can publish on a GREY host,
 *                                       or null
 *
 * Adapted from 3P-Matrix-lite's core/rule-classifier.js — trimmed to the
 * exact-match/suffix-match domain lookup this fork's Matrix panel needs for
 * its CRITICAL RESOURCE column, with the TLD-whitelist/blacklist/CDN-match/
 * level-based wouldBlock() machinery deliberately not ported (see
 * js/data/matrix-constants.js's header for why — this Matrix panel has no
 * level/mode system).
 *
 * No state, no caching — every function is a pure host -> value mapping
 * over the frozen data in matrix-constants.js. No init/clear/release guard
 * needed: a pure function has nothing to initialise, clear or release.
 */

import {
    MULTI_PART_SUFFIXES,
    BUILTIN_DOMAINS,
    SIGNAL_DOMAINS,
    BUILTIN_DOMAIN_CATEGORY,
    WHITELIST_LEVEL,
    GREY_DOMAINS,
} from '../data/matrix-constants.js';

/******************************************************************************/

export function etldPlusOne(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        const labels = hostname.split('.');
        if ( labels.length <= 2 ) { return hostname; }
        const last2 = labels.slice(-2).join('.');
        if ( MULTI_PART_SUFFIXES.indexOf(last2) !== -1 && labels.length >= 3 ) {
            return labels.slice(-3).join('.');
        }
        return last2;
    } catch {
        return '';
    }
}

/******************************************************************************/
// Exact-match-priority lookup, longest-suffix-wins among suffix matches —
// same semantics as rule-classifier.js's _findEntryInMap(), ported as-is:
// a more specific subdomain's own narrower flags must never be silently
// overridden by a broader parent-domain entry that also happens to match.
/******************************************************************************/

function findEntryInMap(host, map) {
    if ( Object.prototype.hasOwnProperty.call(map, host) ) {
        return map[host];
    }
    let bestKey = null;
    for ( const key of Object.keys(map) ) {
        if ( host.endsWith('.' + key) ) {
            if ( !bestKey || key.length > bestKey.length ) { bestKey = key; }
        }
    }
    return bestKey ? map[bestKey] : null;
}

/******************************************************************************/

export function isBuiltinWhitelisted(host) {
    return findEntryInMap(host, BUILTIN_DOMAINS) !== null;
}

export function isSignalDomain(host) {
    return findEntryInMap(host, SIGNAL_DOMAINS) !== null;
}

export function getBuiltinCategory(host) {
    if ( findEntryInMap(host, BUILTIN_DOMAINS) !== null ) {
        return BUILTIN_DOMAIN_CATEGORY[host] ?? null;
    }
    if ( findEntryInMap(host, SIGNAL_DOMAINS) !== null ) {
        return BUILTIN_DOMAIN_CATEGORY[host] ?? null;
    }
    return null;
}

// Whitelist level (10.2.0). Same longest-suffix lookup as above. A domain is
// in at most one level (tools/check-whitelist-levels.mjs), so the order of
// the two lookups does not decide anything.
export function getWhitelistLevel(host) {
    if ( findEntryInMap(host, BUILTIN_DOMAINS) !== null ) { return WHITELIST_LEVEL.WHITE; }
    if ( findEntryInMap(host, GREY_DOMAINS) !== null ) { return WHITELIST_LEVEL.GREY; }
    return null;
}

export function getGreyReason(host) {
    return findEntryInMap(host, GREY_DOMAINS);
}
