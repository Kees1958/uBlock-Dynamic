// ── ad-cleaner-sources.mjs ───────────────────────────────────────────────────
// (11.0.0) Build input of the "Ad leftover cleaner" (js/data/ad-cleaner.js): generic element hiding from EasyList and
// AdGuard Base (owner 2026-11-19: + AdGuard's general_elemhide and banner_sizes sections), minus both lists' own
// exceptions, indexed by each selector's leading id/class.
//
// What is kept: plain generic hiding rules (`##selector`) whose selector passes the stylesheet guard
// (js/util/css-selector-guard.js — the same check the save route applies). Dropped and counted: rules with a site
// (`site##…`; the general file has none today), procedural/extended syntax, selectors the guard refuses, duplicates.
// Exceptions (`site#@#selector`) are kept only for selectors that are in the list, from either exception source (an
// AdGuard exception also covers the same selector from EasyList — it is the same element on the same site).
// Whole-site exceptions (`@@||site^$generichide` / `$elemhide`, AdGuard's allowlist) mean "generic hiding breaks this
// site": the cleaner does not run there. Only rules that cover the page itself are taken — a bare `||host^` with no
// path, not cancelled by `badfilter`, and no resource-type option (e.g. `$xmlhttprequest,elemhide` only covers XHRs).
//
// Guards (C13a): both downloads go through fetch-helpers.mjs (size + "looks like a filter list" checks, retries);
// the result must hold at least MIN_KEPT_RULES rules, else the build fails rather than ship a near-empty cleaner.
//
// Public interface:
//   AD_CLEANER_SOURCES                 — { hide: [ { name, url, minKept } ], allow: [ { name, url } ] }
//   buildAdCleanerData()               — downloads every list, returns the data object (js/data/ad-cleaner.js shape)
//   adCleanerDataFromText(hide, allow) — the same from list text — a string or an array of strings (pure; tests)
//   writeAdCleanerData(data)           — writes AD_CLEANER_DATA_FILE, returns [ rel, bytes ]
// Holds no state between calls: nothing to clear or release.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import path from 'path';
import { ROOT } from './build-paths.mjs';
import { fetchListText } from './fetch-helpers.mjs';
import { isSafePickedSelector } from '../../js/util/css-selector-guard.js';
import {
    AD_CLEANER_DATA_FILE, AD_CLEANER_DATA_VERSION, adCleanerHash, adCleanerKeyOf,
} from '../../js/data/ad-cleaner.js';

// ── Settings ──────────────────────────────────────────────────────────────────
// minKept: far fewer rules than this from one list means a broken or truncated download, not a smaller list
// (sizes on 2026-11-19: EasyList ~13,600, AdGuard general ~300, AdGuard banner sizes 27).
const ADGUARD_SECTIONS = 'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/refs/heads/master/BaseFilter/sections';
export const AD_CLEANER_SOURCES = Object.freeze({
    hide: Object.freeze([
        Object.freeze({ name: 'EasyList general hide', minKept: 5000,
            url: 'https://raw.githubusercontent.com/easylist/easylist/master/easylist/easylist_general_hide.txt' }),
        Object.freeze({ name: 'AdGuard Base general element hiding', minKept: 100,
            url: `${ADGUARD_SECTIONS}/general_elemhide.txt` }),
        Object.freeze({ name: 'AdGuard Base banner sizes', minKept: 10,
            url: `${ADGUARD_SECTIONS}/banner_sizes.txt` }),
    ]),
    allow: Object.freeze([
        Object.freeze({ name: 'EasyList general hide exceptions',
            url: 'https://raw.githubusercontent.com/easylist/easylist/master/easylist/easylist_allowlist_general_hide.txt' }),
        Object.freeze({ name: 'AdGuard Base allowlist', url: `${ADGUARD_SECTIONS}/allowlist.txt` }),
    ]),
});
// Options of a whole-site exception that keep it about the page itself (anything else — a resource type such as
// xmlhttprequest or script, a header= or a domain= — narrows it to something the cleaner cannot follow, so it is skipped).
const WHOLE_SITE_OPTIONS = new Set([ 'generichide', 'elemhide', 'ghide', 'ehide', 'jsinject', 'extension', 'content',
    'genericblock', 'document', 'important', 'urlblock' ]);
const WHOLE_SITE_HIDE_OPTIONS = new Set([ 'generichide', 'elemhide', 'ghide', 'ehide' ]);
const WHOLE_SITE_RE = /^@@\|\|([a-z0-9.-]+\.[a-z0-9-]+)\^?\$(.+)$/;
// Extended (non-CSS) syntax the page's querySelector cannot run, and :has(), kept out for speed on large pages.
const EXTENDED_SYNTAX_RE = /:-abp-|:has-text|:xpath|:upward|:remove|:style\(|:matches-|:min-text|:watch-attr|:others|:has\(/;
// A hostname as EasyList writes it (lower case letters, digits, dots, dashes; no wildcard or negation).
const HOSTNAME_RE = /^[a-z0-9.-]+\.[a-z0-9-]+$/;

function ruleLines(text) {
    return text.split('\n').map(l => l.trim()).filter(l => l !== '' && l.startsWith('!') === false && l.startsWith('[') === false);
}

function joinTexts(texts) {
    return [].concat(texts).filter(t => typeof t === 'string').join('\n');
}

// `@@||host^$elemhide,...` -> host, or null when the rule is not a whole-page generic-hide exception.
function wholeSiteExceptionHost(line) {
    const m = WHOLE_SITE_RE.exec(line);
    if ( m === null ) { return null; }
    const options = m[2].split(',').map(o => o.trim());
    if ( options.every(o => WHOLE_SITE_OPTIONS.has(o)) === false ) { return null; }   // badfilter, xhr, header=… -> skip
    if ( options.some(o => WHOLE_SITE_HIDE_OPTIONS.has(o)) === false ) { return null; }
    return m[1];
}

export function adCleanerDataFromText(hideTexts, allowTexts) {
    const hideText = joinTexts(hideTexts);
    const allowText = joinTexts(allowTexts);
    const counts = { kept: 0, keyed: 0, unkeyed: 0, withSite: 0, extended: 0, refused: 0, duplicate: 0, exceptionSites: 0,
        exceptions: 0, exemptSites: 0 };
    const seen = new Set();
    const hashes = new Map();
    const unkeyed = [];
    for ( const line of ruleLines(hideText) ) {
        const at = line.indexOf('##');
        if ( at === -1 ) { continue; }
        if ( at !== 0 ) { counts.withSite++; continue; }
        const selector = line.slice(2).trim();
        if ( EXTENDED_SYNTAX_RE.test(selector) ) { counts.extended++; continue; }
        if ( isSafePickedSelector(selector) === false ) { counts.refused++; continue; }
        if ( seen.has(selector) ) { counts.duplicate++; continue; }
        seen.add(selector);
        const key = adCleanerKeyOf(selector);
        if ( key === null ) {
            unkeyed.push(selector);
            counts.unkeyed++;
        } else {
            const hash = adCleanerHash(key.type, key.token);
            const list = hashes.get(hash) ?? [];
            list.push(selector);
            hashes.set(hash, list);
            counts.keyed++;
        }
        counts.kept++;
    }
    const exceptions = {};
    const exemptSites = new Set();
    for ( const line of ruleLines(allowText) ) {
        const host = wholeSiteExceptionHost(line);
        if ( host !== null ) { exemptSites.add(host); continue; }
        const at = line.indexOf('#@#');
        if ( at <= 0 ) { continue; }
        const selector = line.slice(at + 3).trim();
        if ( seen.has(selector) === false ) { continue; }   // only exceptions for selectors the cleaner has
        for ( const raw of line.slice(0, at).split(',') ) {
            const host = raw.trim().toLowerCase();
            if ( HOSTNAME_RE.test(host) === false ) { continue; }
            const list = exceptions[host] ?? (exceptions[host] = []);
            if ( list.includes(selector) === false ) { list.push(selector); counts.exceptions++; }
        }
    }
    counts.exceptionSites = Object.keys(exceptions).length;
    counts.exemptSites = exemptSites.size;
    const sortedHashes = Object.fromEntries([ ...hashes.entries() ].sort((a, b) => a[0] - b[0]));
    return { version: AD_CLEANER_DATA_VERSION, hashes: sortedHashes, unkeyed, exceptions,
        exemptSites: [ ...exemptSites ].sort(), counts };
}

export async function buildAdCleanerData() {
    const hideTexts = await Promise.all(AD_CLEANER_SOURCES.hide.map(s => fetchListText(s.url)));
    const allowTexts = await Promise.all(AD_CLEANER_SOURCES.allow.map(s => fetchListText(s.url)));
    // GUARD (C13a): each hide list on its own must hold a plausible number of rules.
    AD_CLEANER_SOURCES.hide.forEach((source, i) => {
        const kept = adCleanerDataFromText(hideTexts[i], '').counts.kept;
        if ( kept < source.minKept ) {
            throw new Error(`ad cleaner: ${source.name} gave only ${kept} rules (expected at least ${source.minKept}) — refusing a broken download`);
        }
    });
    return adCleanerDataFromText(hideTexts, allowTexts);
}

export async function writeAdCleanerData(data) {
    const text = JSON.stringify(data);
    await fs.writeFile(path.join(ROOT, AD_CLEANER_DATA_FILE), text);
    return [ AD_CLEANER_DATA_FILE, Buffer.byteLength(text) ];
}
