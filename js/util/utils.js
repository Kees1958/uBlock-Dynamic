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
 * utils.js — Shared utilities for URL matching, hostname handling and constants
 *
 * Public interface (selection of key exports):
 *   matchesFromHostname(hn)          — returns [*://hn/*, *://*.hn/*] (apex + subdomain)
 *   matchesFromHostnames(hostnames)  — maps matchesFromHostname over an array
 *   hostnameFromMatch(origin)        — reverses a match pattern back to a hostname
 *   hostnamesFromMatches(origins)    — maps hostnameFromMatch over an array
 *   isScriptlet(selector)            — true if selector starts with "##+js("
 *   isValidHostnamePattern(hn)       — loose but real hostname-shape check, '*' allowed
 *   PLAIN_HOSTNAME_RE                — one concrete hostname (no '*'), for DNR domain lists and match patterns
 *   MAX_HOSTNAME_LENGTH              — 253, the DNS limit for a whole hostname
 *   isBoundedString(value, maxLen)   — typeof/non-empty/max-length check for one string
 *
 * No state. No side effects. Pure utilities.
 *
 * (10.7.6) Upstream-only helpers that nothing here used were removed (owner's decision to stop tracking
 * upstream uBOL): matchFromHostname, urlFilterMatches, isDescendantHostname, intFromVersion, parsedURLromOrigin.
 */


/******************************************************************************/

// Manage Custom Rules' "created" date stamp — plain YYYY-MM-DD (UTC, via
// toISOString(), not local calendar date — same reasoning as any log
// timestamp: unambiguous regardless of the browser's timezone setting).
// Single source of truth so matrix-block-rules.js, custom-scriptlets.js,
// and filter-manager.js can't each format this slightly differently.
export function todayISODate() {
    return new Date().toISOString().slice(0, 10);
}

// Loose YYYY-MM-DD shape check — used when accepting a caller-supplied
// date (import, or an existing stored value) instead of always stamping
// today, so a malformed value from a hand-edited import file can't end
// up displayed as a rule's creation date. Deliberately not a full
// calendar-validity check (e.g. doesn't reject 2026-02-30) — this is a
// display-only field, not used in any date arithmetic, so "looks like a
// date" is a suffient bar; rejecting on a valid-but-unusual date some
// other tool exported would be a worse failure mode than showing one.
export function isValidISODate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/******************************************************************************/
// Input-validation helpers (C6 — every exported function accepting
// external input must validate it at the boundary). Added for the
// custom-cosmetic-filter / custom-scriptlet-rule trust boundary — see
// filter-manager.js's addCustomFilters() and custom-scriptlets.js's
// addCustomScriptletRule(), both of which accept data that ultimately
// originates from page-influenceable content (the element picker,
// content-script-relayed hostnames). Single source of truth so the two
// storage layers can't drift onto two different notions of "a
// plausible hostname" or "a reasonable selector/arg string" — same
// reasoning as every other shared constant in this file.

// Loose but real hostname-shape check: lowercase letters/digits/hyphens
// per label, labels separated by single dots, no leading/trailing dot,
// overall length within the real DNS limit (253). Deliberately NOT a
// strict public-suffix/TLD validator — this only needs to reject
// obviously-malformed input (empty labels, whitespace, control
// characters, absurd length), not police which TLDs are "real"; a
// hostname that's syntactically well-formed but doesn't resolve to
// anything is harmless here (it just never matches a real page).
//
// (11.0.2) Underscores are allowed, anywhere in a label: Chrome loads hosts
// such as `my_site.example.com` or `lorenne_.wehype.app`, and before this the
// picker, Cookie consent clicker and custom scriptlets silently failed to save
// on them. AdGuard fixed the same gap (tsurlfilter 6.1.0).
const HOSTNAME_LABEL_RE = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

// (11.0.2) One concrete hostname, at least two labels, no '*'. The single shape
// check for every place that writes a hostname into a DNR domain list or a
// content-script match pattern (one malformed entry fails the whole update or
// registration). Underscores allowed — see HOSTNAME_LABEL_RE above.
export const PLAIN_HOSTNAME_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;

// (11.0.2, audit 11.0.2 finding 6) The DNS limit for a whole hostname, one place for every hostname check.
export const MAX_HOSTNAME_LENGTH = 253;

export function isValidHostnamePattern(hostname) {
    if ( typeof hostname !== 'string' ) { return false; }
    if ( hostname === '*' ) { return true; }  // unscoped ("all sites") — a real, supported value, not a malformed one
    if ( hostname === '' || hostname.length > MAX_HOSTNAME_LENGTH ) { return false; }
    const labels = hostname.split('.');
    return labels.every(label => HOSTNAME_LABEL_RE.test(label));
}

// Bounds a caller-supplied string against a maximum length — used for
// selectors/scriptlet-args, where the real defense is the storage-layer
// count cap (CUSTOM_COSMETIC_MAX/CUSTOM_SCRIPTLET_MAX in dnr-budgets.js)
// but a single absurdly-long entry (megabytes in one array element)
// shouldn't be accepted just because the array itself is short.
export function isBoundedString(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/******************************************************************************/


/******************************************************************************/

export function toBroaderHostname(hn) {
    if ( hn === '*' ) { return ''; }
    const pos = hn.indexOf('.');
    return pos !== -1 ? hn.slice(pos+1) : '*';
}

/******************************************************************************/

// Is hna descendant hostname of hnb?


/**
 * Returns whether a hostname is part of a collection, or is descendant of an
 * item in the collection.
 * @param hna - the hostname representing the needle.
 * @param iterb - an iterable representing the haystack of hostnames.
 */

export function isDescendantHostnameOfIter(hna, iterb) {
    const setb = iterb instanceof Set ? iterb : new Set(iterb);
    if ( setb.has('all-urls') || setb.has('*') ) { return true; }
    let hn = hna;
    while ( hn ) {
        const pos = hn.indexOf('.');
        if ( pos === -1 ) { break; }
        hn = hn.slice(pos + 1);
        if ( setb.has(hn) ) { return true; }
    }
    return false;
}

/**
 * Returns all hostnames in the first collection which are equal or descendant
 * of hostnames in the second collection.
 * @param itera - an iterable which hostnames must be filtered out.
 * @param iterb - an iterable which hostnames must be matched.
 */

export function intersectHostnameIters(itera, iterb) {
    const setb = iterb instanceof Set ? iterb : new Set(iterb);
    if ( setb.has('all-urls') || setb.has('*') ) { return Array.from(itera); }
    const out = [];
    for ( const hna of itera ) {
        if ( setb.has(hna) || isDescendantHostnameOfIter(hna, setb) ) {
            out.push(hna);
        }
    }
    return out;
}

export function subtractHostnameIters(itera, iterb) {
    const setb = iterb instanceof Set ? iterb : new Set(iterb);
    if ( setb.has('all-urls') || setb.has('*') ) { return []; }
    const out = [];
    for ( const hna of itera ) {
        if ( setb.has(hna) ) { continue; }
        if ( isDescendantHostnameOfIter(hna, setb) ) { continue; }
        out.push(hna);
    }
    return out;
}

/******************************************************************************/


// Returns both the apex and wildcard-subdomain patterns for a hostname,
// so content scripts fire on both example.com and www.example.com.
export function matchesFromHostname(hn) { return hn === '*' || hn === 'all-urls'
        ? [ '<all_urls>' ]
        : [ `*://${hn}/*`, `*://*.${hn}/*` ]; }

export function matchesFromHostnames(hostnames) {
    const out = [];
    for ( const hn of hostnames ) {
        out.push(...matchesFromHostname(hn));
    }
    return out;
}

export function hostnameFromMatch(origin) {
    if ( origin === '<all_urls>' || origin === '*://*/*' ) { return 'all-urls'; }
    const match = /^[^:]+:\/\/(?:\*\.)?([^/]+)\/\*/.exec(origin);
    if ( match === null ) { return ''; }
    return match[1];
}

export function hostnamesFromMatches(origins) {
    const out = [];
    for ( const origin of origins ) {
        const hn = hostnameFromMatch(origin);
        if ( hn === '' ) { continue; }
        out.push(hn);
    }
    return out;
}

/******************************************************************************/

// The goal is just to be able to find out whether a specific version is older
// than another one.


/******************************************************************************/

export function isScriptlet(a) { return a.startsWith('+js'); }

/******************************************************************************/


