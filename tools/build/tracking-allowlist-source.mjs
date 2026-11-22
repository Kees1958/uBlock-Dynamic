// ── tools/build/tracking-allowlist-source.mjs ──────────────────────────────────────────
// Source text for ruleset_tracking_servers_allowlist (10.7.1, owner's decision): the hidden, always-on list of
// AdGuard's own exceptions for the three Worry-free tracker lists. AdGuard's SpywareFilter allowlist.txt fixes
// pages its tracking-servers list breaks; we keep ONLY the `@@` network rules whose host IS a domain those three
// lists block, or a subdomain of one ("strict" selection). The site gates — geographic scope (parseList, every
// list) and CrUX top-1M (popularityFilter on the FILTER_LISTS entry) — run in the normal build afterwards.
// (11.0.0, owner's decision) Plus EFF Privacy Badger's "needed" hosts (its cookieblock list —
// tools/build/privacy-badger-unbreak.mjs) that these lists block: exact-host `@@` lines, so the same exception
// mechanism stops the tracker lists from breaking logins, checkouts, paywalls, consent banners and players.
//
// Public interface:
//   TRACKING_ALLOWLIST_SOURCE            — url, parent rulesets and the plausibility floors, declared once
//   selectTrackingAllowLines(text, set)  — pure: allowlist.txt text + blocked-domain Set -> selected `@@` lines
//   blockedDomainsFromRulesets(rulesets) — pure: parsed parent ruleset JSON arrays -> Set of blocked domains
//   selectPrivacyBadgerAllowLines(needed, blocked) — pure: needed hosts + blocked-domain Set -> exact-host `@@` lines
//   buildTrackingAllowlistSourceText()   — async: read the parents THIS build just wrote, download, select
//
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
// ORDER: the FILTER_LISTS entry MUST come after the three parent lists — it reads their freshly written files.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './build-paths.mjs';
import { fetchListText } from './fetch-helpers.mjs';
import { PRIVACY_BADGER_SOURCE, exactHostAllowLines, fetchPrivacyBadgerNeededHosts } from './privacy-badger-unbreak.mjs';

// ── CONFIG ────────────────────────────────────────────────────────────────────────────
export const TRACKING_ALLOWLIST_SOURCE = Object.freeze({
    url: 'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/SpywareFilter/sections/allowlist.txt',
    // The lists whose blocks these exceptions are for. Reading their WRITTEN files (not re-fetching their sources)
    // keeps the selection identical to what actually ships, including each list's own TLD gating.
    // (11.0.0) + ruleset_hagezi_light, moved into the Seamless tracker lists (owner's decision).
    parentRulesetIds: Object.freeze([ 'ruleset_kees1958', 'ruleset_peterlowe', 'ruleset_adguard_tracking_servers', 'ruleset_hagezi_light' ]),
    // GUARDS (C13a): an upstream file this small, or a parent set this small, is a broken download or build.
    minAllowLines: 1000,     // allowlist.txt held ~2 600 `@@` lines on 2026-11-10
    minBlockedDomains: 3000, // the three parents held 7 208 unique domains in 10.7.0
    // Rules for Android apps (AdGuard for Android) — meaningless in a browser.
    nonBrowserOptions: Object.freeze([ 'app=' ]),
});

// Host part of an `@@` network rule: after `||`, or after a leading `.`/`://`/`|http(s)://` when unanchored.
const ANCHORED_HOST_RE   = /^\|\|([a-z0-9*.\-_]+)/i;
const UNANCHORED_HOST_RE = /^(?:\|?https?:\/\/|:\/\/|\.)?([a-z0-9\-_]+(?:\.[a-z0-9\-_]+)+)/i;

function allowRuleHost(body) {
    const m = ANCHORED_HOST_RE.exec(body) ?? UNANCHORED_HOST_RE.exec(body);
    if ( m === null ) { return null; }
    const host = m[1].toLowerCase().replace(/^\.+|\.+$/g, '');
    return host.includes('*') ? null : host;   // wildcard hosts: not a strict match, skipped
}

// True when host, or a parent of it, is in the blocked set (the parents block subdomains too).
function hitsBlockedDomain(host, blocked) {
    const labels = host.split('.');
    for ( let i = 0; i < labels.length - 1; i++ ) {
        if ( blocked.has(labels.slice(i).join('.')) ) { return true; }
    }
    return false;
}

function isBrowserRule(body) {
    const dollar = body.lastIndexOf('$');
    if ( dollar === -1 ) { return true; }
    const opts = body.slice(dollar + 1).split(',');
    return opts.some(o => TRACKING_ALLOWLIST_SOURCE.nonBrowserOptions.some(n => o.startsWith(n))) === false;
}

export function selectTrackingAllowLines(text, blocked) {
    const selected = new Set();   // dedup: an identical line listed twice upstream ships once
    let allowLines = 0;
    for ( const raw of text.split('\n') ) {
        const line = raw.trim();
        if ( line.startsWith('@@') === false ) { continue; }
        allowLines++;
        const body = line.slice(2);
        if ( isBrowserRule(body) === false ) { continue; }
        const host = allowRuleHost(body);
        if ( host !== null && hitsBlockedDomain(host, blocked) ) { selected.add(line); }
    }
    return { lines: [ ...selected ], allowLines };
}

// (11.0.0) A needed host the parents block (the host itself or a parent of it) becomes one exception line.
export function selectPrivacyBadgerAllowLines(neededHosts, blocked) {
    return [ ...neededHosts ].filter(host => hitsBlockedDomain(host, blocked)).sort().flatMap(exactHostAllowLines);
}

export function blockedDomainsFromRulesets(rulesets) {
    const blocked = new Set();
    for ( const rules of rulesets ) {
        for ( const rule of rules ) {
            if ( rule?.action?.type !== 'block' ) { continue; }
            for ( const d of rule.condition?.requestDomains ?? [] ) { blocked.add(d.toLowerCase()); }
        }
    }
    return blocked;
}

async function readParentRulesets() {
    const out = [];
    for ( const id of TRACKING_ALLOWLIST_SOURCE.parentRulesetIds ) {
        const file = path.join(ROOT, 'rulesets', `${id}.json`);
        const rules = JSON.parse(await fs.readFile(file, 'utf8'));
        if ( Array.isArray(rules) === false || rules.length === 0 ) {
            throw new Error(`tracking allowlist: parent ${id} is empty or not an array — build it first`);
        }
        out.push(rules);
    }
    return out;
}

export async function buildTrackingAllowlistSourceText() {
    const blocked = blockedDomainsFromRulesets(await readParentRulesets());
    if ( blocked.size < TRACKING_ALLOWLIST_SOURCE.minBlockedDomains ) {
        throw new Error(`tracking allowlist: parents block only ${blocked.size} domains (expected at least ${TRACKING_ALLOWLIST_SOURCE.minBlockedDomains})`);
    }
    // fetchListText (not fetchList): network `@@` lines only, no scriptlets for the trust gate to judge.
    const { lines, allowLines } = selectTrackingAllowLines(await fetchListText(TRACKING_ALLOWLIST_SOURCE.url), blocked);
    if ( allowLines < TRACKING_ALLOWLIST_SOURCE.minAllowLines ) {
        throw new Error(`tracking allowlist: only ${allowLines} @@ lines upstream (expected at least ${TRACKING_ALLOWLIST_SOURCE.minAllowLines}) — truncated or wrong download`);
    }
    // (11.0.0) Privacy Badger's needed hosts — a line AdGuard already lists is not added twice.
    const pbLines = selectPrivacyBadgerAllowLines(await fetchPrivacyBadgerNeededHosts(), blocked)
        .filter(line => lines.includes(line) === false);
    process.stdout.write(`(${lines.length} of ${allowLines} @@ lines hit ${blocked.size} blocked domains; `
        + `+${pbLines.length} Privacy Badger needed hosts) `);
    return [
        '! Title: Tracker-list exceptions for HaGeZi Light, Peter Lowe, Kees1958 and AdGuard tracking servers (AdGuard + EFF Privacy Badger)',
        `! Source: ${TRACKING_ALLOWLIST_SOURCE.url} — @@ rules whose host is blocked by ${TRACKING_ALLOWLIST_SOURCE.parentRulesetIds.join(', ')}`,
        ...lines,
        `! Source: ${PRIVACY_BADGER_SOURCE.url} — hosts Privacy Badger found websites need (cookieblock), blocked by the lists above`,
        ...pbLines,
    ].join('\n');
}
