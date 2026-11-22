// ── tools/build/kees1958-source.mjs ─────────────────────────────────────────────────────
// Source text for ruleset_kees1958 ("Kees1958 most-used EU+US ads & tracking networks"), fetched by the main
// build itself (10.2.0). Until 10.1.9 this was a separate pre-step — tools/build-adtracking-sources.mjs wrote
// tools/data/kees1958-only-source.txt and the build read that file — so a "full update" of the filters
// silently kept whatever the last manual pre-step run had left there. One process now: the list is refreshed
// on every build like every other list. Same transformation as the old pre-step, used as-is (no safety
// filter, per the owner's earlier decision): every "||domain^…" line becomes "||domain^$third-party".
//
// Public interface:
//   KEES1958_SOURCE               — url and the plausibility floor, declared once
//   kees1958SourceTextFrom(text)  — pure: upstream text -> the ABP text parseList() compiles
//   buildKees1958SourceText()     — async: download (fetchList guards: non-2xx, tiny, not filter-shaped) + transform
//
// Pure apart from the download: nothing to initialise, clear or release.
import { fetchList } from './fetch-helpers.mjs';

export const KEES1958_SOURCE = Object.freeze({
    url: 'https://raw.githubusercontent.com/Kees1958/W3C_annual_most_used_survey_blocklist/master/EU_US_MV3_most_common_ad%2Btracking_networks.txt',
    // Last checked ~455 domains (2026-10); far fewer means a broken or truncated download (C13a).
    minDomains: 300,
});

// Same pattern the old pre-step used: a host-anchored rule with optional options.
const HOSTNAME_RULE_RE = /^\|\|([a-z0-9.-]+)\^(?:\$.*)?$/i;

export function kees1958SourceTextFrom(text) {
    const domains = new Set();
    for ( const line of String(text).split('\n') ) {
        const t = line.trim();
        if ( t === '' || t.startsWith('!') || t.startsWith('[') ) { continue; }
        const m = HOSTNAME_RULE_RE.exec(t);
        if ( m ) { domains.add(m[1].toLowerCase()); }
    }
    if ( domains.size < KEES1958_SOURCE.minDomains ) {
        throw new Error(`Kees1958 EU+US list: only ${domains.size} domains (expected at least ${KEES1958_SOURCE.minDomains}) — truncated or wrong download`);
    }
    return [
        '[AdBlockPlus 2.0]',
        '! Title: Kees1958 most-used EU+US ads & tracking networks',
        `! Source: ${KEES1958_SOURCE.url} (${domains.size} domains), used as-is`,
        ...[ ...domains ].sort().map(d => `||${d}^$third-party`),
        '',
    ].join('\n');
}

export async function buildKees1958SourceText() {
    return kees1958SourceTextFrom(await fetchList(KEES1958_SOURCE.url));
}
