// ── tools/build/privacy-badger-unbreak.mjs ─────────────────────────────────────────────
// (11.0.0, owner's decision 2026-11-20) "Unbreak" input from EFF's Privacy Badger: the hosts its tracker data marks
// `cookieblock` — trackers that Privacy Badger found websites NEED (logins, checkouts, paywalls, consent banners,
// players), so it lets them load without cookies instead of blocking them. We use ONLY that list, and only to STOP our
// tracker lists from blocking those hosts (the owner's core value: no website breakage). Not used: Privacy Badger's
// block list (it blocks whole platforms such as tiktok.com, safe only with its own click-to-load placeholders) and its
// allow list ("allow" means "not caught tracking with cookies", not "safe" — it holds ad servers). With third-party
// cookies blocked by the browser, stripping cookies adds nothing, so no cookie rules are made either.
//
// Consumer: tools/build/tracking-allowlist-source.mjs — the four Seamless tracker lists (HaGeZi Light, Peter Lowe,
//       Kees1958, AdGuard tracking servers, priority 8 000): exact-host `@@` lines in the hidden exception ruleset, same
//       priority, so allow wins — and only over those lists.
//   (HaGeZi Light is covered by the same exception ruleset since it moved into the Seamless tracker lists.)
//
// Public interface:
//   PRIVACY_BADGER_SOURCE                 — url and plausibility floors, declared once
//   neededHostsFromSeed(seed)             — pure: Privacy Badger seed.json object -> sorted array of cookieblock hosts
//   exactHostAllowLines(host)             — pure: the `@@` lines that lift a block for EXACTLY this host (https + http)
//   fetchPrivacyBadgerNeededHosts()       — async, memoised for one build: download, validate, return a Set
//   releasePrivacyBadgerNeededHosts()     — RELEASE the memoised set (called by the build after the lists are written)
//
// State owned: one memoised promise for the build process (downloaded once per build); released by
// releasePrivacyBadgerNeededHosts(). Nothing persisted.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchJsonData } from './fetch-helpers.mjs';

// ── CONFIG ────────────────────────────────────────────────────────────────────────────
export const PRIVACY_BADGER_SOURCE = Object.freeze({
    // Privacy Badger's bundled tracker data (GPL-3.0-or-later, Electronic Frontier Foundation), refreshed by EFF from
    // its Badger Sett / Badger Swarm scans. action_map[host].heuristicAction is 'block' | 'cookieblock' | 'allow'.
    url: 'https://raw.githubusercontent.com/EFForg/privacybadger/master/src/data/seed.json',
    neededAction: 'cookieblock',
    // GUARDS (C13a): sizes on 2026-11-20 — 10 608 hosts, 840 cookieblock. Far fewer = broken or truncated download.
    minHosts: 3000,
    minNeededHosts: 300,
});
// A plain host name (no wildcards, no ports) — anything else in the data is skipped, never guessed.
const HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export function neededHostsFromSeed(seed) {
    const map = seed?.action_map;
    if ( map === null || typeof map !== 'object' ) { throw new Error('Privacy Badger: seed.json has no action_map'); }
    const needed = [];
    for ( const [ host, entry ] of Object.entries(map) ) {
        if ( entry?.heuristicAction !== PRIVACY_BADGER_SOURCE.neededAction ) { continue; }
        const h = host.toLowerCase();
        if ( HOST_RE.test(h) ) { needed.push(h); }
    }
    return needed.sort();
}

// EXACT host only, never its subdomains (real finding in the first build): Privacy Badger lists 233 whole shared-hosting
// domains as needed (amazonaws.com, alicdn.com, b-cdn.net …). `@@||host^` would also allow every tracker hosted under
// them — a different party from what Privacy Badger meant. `|https://host^` matches that host and nothing below it.
export function exactHostAllowLines(host) {
    return [ `@@|https://${host}^`, `@@|http://${host}^` ];
}

let neededHostsPromise = null;   // memoised for this build process — RELEASE: releasePrivacyBadgerNeededHosts()

export function fetchPrivacyBadgerNeededHosts() {
    if ( neededHostsPromise !== null ) { return neededHostsPromise; }
    neededHostsPromise = (async ( ) => {
        const seed = await fetchJsonData(PRIVACY_BADGER_SOURCE.url);
        const hosts = Object.keys(seed?.action_map ?? {}).length;
        if ( hosts < PRIVACY_BADGER_SOURCE.minHosts ) {
            throw new Error(`Privacy Badger: only ${hosts} hosts in seed.json (expected at least ${PRIVACY_BADGER_SOURCE.minHosts})`);
        }
        const needed = neededHostsFromSeed(seed);
        if ( needed.length < PRIVACY_BADGER_SOURCE.minNeededHosts ) {
            throw new Error(`Privacy Badger: only ${needed.length} cookieblock hosts (expected at least ${PRIVACY_BADGER_SOURCE.minNeededHosts})`);
        }
        return new Set(needed);
    })();
    neededHostsPromise.catch(( ) => { neededHostsPromise = null; });   // a failed download is not memoised
    return neededHostsPromise;
}

export function releasePrivacyBadgerNeededHosts() {
    neededHostsPromise = null;
}
