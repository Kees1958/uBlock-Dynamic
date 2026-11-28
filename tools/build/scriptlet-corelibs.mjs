// ── tools/build/scriptlet-corelibs.mjs ────────────────────────────────────────────────
// AG corelibs fetch and trim.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: buildTrimmedCorelibs, selectProjectScriptlets, applyProjectReplacements (11.1.6), fetchCorelibsFromNpm (10.6.0 — see that
// export's own comment at its declaration for why a 3rd caller needs it directly)
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import { corelibsCreditFields } from './third-party-credits.mjs';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { withRetry, fetchWithTimeout } from '../lib/fetch-with-retry.mjs';
import zlib from 'zlib';
import { ROOT } from './build-paths.mjs';
import { buildNotices } from './build-state.mjs';
import { UBO_PATCH_SCRIPTLETS } from '../../js/resources/ubo-patch-scriptlets-source.mjs';

/******************************************************************************/
// AG corelibs fetch + trim
//
// Fetches AdGuard's published scriptlets library directly from npm (the
// same package @adguard/scriptlets that ships dist/scriptlets.corelibs.json
// — see https://github.com/AdguardTeam/Scriptlets) rather than reading a
// locally-committed copy. This mirrors how every other filter list in
// FILTER_LISTS is fetched fresh at build time instead of vendored — a
// committed static copy would silently drift out of date every time
// AdGuard publishes a new scriptlets release, with nothing here to notice.
//
// npm doesn't publish dist/scriptlets.corelibs.json as a standalone raw
// file over HTTP (only inside the package tarball), so this does a minimal
// gzip+tar extraction using only Node's built-in zlib — no dependency, no
// `npm install` step needed to build this extension.
//
// Then keeps only scriptlets whose primary name is in the usedNames set.
// Written to js/resources/ag-scriptlets-corelibs.json.
/******************************************************************************/

// ── AdGuard scriptlets package — integrity + update tracking ─────────────
// (tools audit after 9.7.5, item 1.) The package's scriptlets become code
// that runs in the MAIN world on every site, so the download is verified
// before use. Per explicit requirement, NEW upstream versions are still
// picked up automatically on every filter update (new scriptlets used by
// AdGuard Base must keep working) — what changed is that the update is now
// VERIFIED and VISIBLE instead of silent:
//   - the tarball must hash (sha512) to the registry's own dist.integrity;
//   - AG_SCRIPTLETS_LOCK_PATH records version + integrity + scriptlet
//     names, so a version change and its NEW scriptlets are reported by
//     name in the end-of-build summary (and ship in the next version bump);
//   - the SAME version with DIFFERENT content is refused outright (a
//     republished/tampered release — npm versions are immutable, so this
//     should never legitimately happen).
const AG_SCRIPTLETS_LATEST_URL = 'https://registry.npmjs.org/@adguard/scriptlets/latest';
const AG_SCRIPTLETS_LOCK_PATH = path.join(ROOT, 'tools', 'adguard-scriptlets.lock.json');

async function readAgScriptletsLock() {
    try {
        const lock = JSON.parse(await fs.readFile(AG_SCRIPTLETS_LOCK_PATH, 'utf8'));
        if ( typeof lock?.version === 'string' && typeof lock?.integrity === 'string' && Array.isArray(lock?.scriptletNames) ) {
            return lock;
        }
        console.warn(`\nWARNING: ${path.relative(ROOT, AG_SCRIPTLETS_LOCK_PATH)} has an unexpected shape — treating as absent.`);
    } catch {
        // absent on the very first run — expected, not an error
    }
    return null;
}

function verifyTarballIntegrity(tgzBuffer, integrity) {
    const m = /^sha512-(.+)$/.exec(integrity ?? '');
    if ( m === null ) { throw new Error(`registry gave no sha512 integrity for @adguard/scriptlets (${integrity})`); }
    const actual = crypto.createHash('sha512').update(tgzBuffer).digest('base64');
    if ( actual !== m[1] ) {
        throw new Error('@adguard/scriptlets tarball does not match the registry\'s sha512 integrity — refusing to use it');
    }
}

// Exported (10.6.0) so tools/build/custom-scriptlets-dispatch.mjs's one real caller (stepScriptletAssets, via
// buildTrimmedCorelibs's own `full` return value) stays the only normal path, while still letting a one-off
// regeneration of JUST the custom-scriptlets dispatch — without re-deriving/rewriting the unrelated trimmed
// js/resources/ag-scriptlets-corelibs.json intermediate buildTrimmedCorelibs() also writes — call this directly.
export async function fetchCorelibsFromNpm() {
    const lock = await readAgScriptletsLock();
    const meta = await withRetry('npm registry lookup for @adguard/scriptlets', async signal => {
        const m = await (await fetchWithTimeout(AG_SCRIPTLETS_LATEST_URL, signal)).json();
        if ( typeof m?.version !== 'string' || typeof m?.dist?.tarball !== 'string' ) {
            throw new Error('unexpected registry response shape');
        }
        return m;
    });
    if ( lock !== null && lock.version === meta.version && lock.integrity !== meta.dist.integrity ) {
        throw new Error(`@adguard/scriptlets@${meta.version}: registry integrity differs from the recorded one for the SAME version — refusing (republished or tampered release)`);
    }
    // Download + integrity check form ONE retried attempt: a corrupted or
    // truncated download is retried, not just a failed connection.
    const tgz = await withRetry(`@adguard/scriptlets@${meta.version} tarball`, async signal => {
        const buf = Buffer.from(await (await fetchWithTimeout(meta.dist.tarball, signal)).arrayBuffer());
        verifyTarballIntegrity(buf, meta.dist.integrity);
        return buf;
    });
    const corelibs = extractCorelibsFromTarball(tgz, meta.version);
    const names = corelibs.scriptlets.map(sc => sc.names[0]).sort();
    if ( lock === null || lock.version !== meta.version ) {
        const known = new Set(lock?.scriptletNames ?? []);
        const added = lock === null ? [] : names.filter(n => !known.has(n));
        buildNotices.push({
            level: 'NOTICE',
            text: lock === null
                ? `AdGuard scriptlets package recorded for the first time: v${meta.version} (${names.length} scriptlets).`
                : `AdGuard scriptlets package UPDATED v${lock.version} -> v${meta.version}` +
                  (added.length !== 0 ? ` — ${added.length} new scriptlet(s): ${added.join(', ')}` : ' — no new scriptlet names') +
                  '. Ships with the next extension version bump.',
        });
        await fs.writeFile(AG_SCRIPTLETS_LOCK_PATH, JSON.stringify({
            version: meta.version,
            integrity: meta.dist.integrity,
            scriptletNames: names,
        }, null, 2) + '\n', 'utf8');
    }
    // (11.1.6) The ONE place a project scriptlet replaces an AdGuard one — every consumer (list rules, custom-rule
    // dispatch, cookie-notice step) starts from this object. The lock file above still records AdGuard's own names.
    return applyProjectReplacements(corelibs);
}

// (11.1.6) The `.js` suffix AdGuard adds to many uBO aliases; a name and its bare form are the same scriptlet.
const SCRIPTLET_JS_SUFFIX = '.js';
function bareScriptletName(name) {
    return name.endsWith(SCRIPTLET_JS_SUFFIX) ? name.slice(0, -SCRIPTLET_JS_SUFFIX.length) : name;
}

// (11.1.6) Project scriptlets marked `replacesAdGuard: true` (js/resources/ubo-patch-scriptlets-source.mjs; the reason
// is written at each entry) take the place of every AdGuard scriptlet that shares a name with them: same position, the
// AdGuard entry's names unchanged, the project's function as the body.
// An entry whose AdGuard counterpart has disappeared needs nothing here — it is then an ordinary project scriptlet.
// Pure: returns a new object, keeps nothing.
export function applyProjectReplacements(corelibs, projectScriptlets = UBO_PATCH_SCRIPTLETS) {
    const replacements = projectScriptlets.filter(entry => entry.replacesAdGuard === true);
    if ( replacements.length === 0 ) { return corelibs; }
    const scriptlets = corelibs.scriptlets.map(agEntry => {
        const agBare = new Set(agEntry.names.map(bareScriptletName));
        const replacement = replacements.find(entry => entry.names.some(n => agBare.has(bareScriptletName(n))));
        if ( replacement === undefined ) { return agEntry; }
        // AdGuard's own names only: one project function may replace SEVERAL AdGuard entries (remove-node-text and
        // trusted-replace-node-text), each keeping its first name — the library name a rule's source.name gets, which
        // the function reads to know what it is doing. Every AdGuard alias still resolves; bare uBO spellings resolve
        // as for any AdGuard entry (dispatch bare-alias rule, buildScriptletFile's ubo-<name>.js fallback).
        return { names: [ ...agEntry.names ], scriptlet: replacement.scriptlet.toString() };
    });
    return { ...corelibs, scriptlets };
}

function extractCorelibsFromTarball(tgz, version) {
    const tar = zlib.gunzipSync(tgz);

    // Minimal POSIX ustar reader — just enough to find one named entry in
    // an npm package tarball (always laid out as package/<path>).
    const targetName = 'package/dist/scriptlets.corelibs.json';
    let offset = 0;
    while ( offset + 512 <= tar.length ) {
        const header = tar.subarray(offset, offset + 512);
        if ( header.every(b => b === 0) ) { break; }  // end-of-archive marker
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
        const size = parseInt(sizeOctal, 8) || 0;
        const contentStart = offset + 512;
        if ( name === targetName ) {
            const content = tar.subarray(contentStart, contentStart + size);
            return JSON.parse(content.toString('utf8'));
        }
        offset = contentStart + Math.ceil(size / 512) * 512;
    }
    throw new Error(`${targetName} not found in @adguard/scriptlets@${version} tarball`);
}

// Project-own scriptlets (10.1.8): the hand-written entries of js/resources/ubo-patch-scriptlets-source.mjs
// that a shipped list actually uses (e.g. `cnn.com#%#//scriptlet('disable-fave-ssai')` in the Quick-fixes list),
// in the same { names, scriptlet: <source text> } shape as an AdGuard corelibs entry. A name that
// @adguard/scriptlets also defines is left to AdGuard (same priority rule as the custom-rule dispatch,
// build/custom-scriptlets-dispatch.mjs). Pure: allocates its result, keeps nothing.
export function selectProjectScriptlets(usedNames, agAvailableNames) {
    const selected = [];
    for ( const entry of UBO_PATCH_SCRIPTLETS ) {
        // (11.1.6) A replacement whose AdGuard counterpart exists is already in place (applyProjectReplacements()).
        if ( entry.replacesAdGuard === true && entry.names.some(n => agAvailableNames.has(n)) ) { continue; }
        const names = entry.names.filter(n => agAvailableNames.has(n) === false);
        if ( names.length === 0 || names.some(n => usedNames.has(n)) === false ) { continue; }
        selected.push({ names, scriptlet: entry.scriptlet.toString() });
    }
    return selected;
}

// (11.0.0) `prefetched`: the full corelibs a previous step of THIS run already downloaded (the cookie-notice step, which
// needs the alias table and value lists before the lists' names are final) — reused instead of a second download.
export async function buildTrimmedCorelibs(usedNames, prefetched = null) {
    const full = prefetched ?? await fetchCorelibsFromNpm();
    const agAvailable = new Set(full.scriptlets.flatMap(sc => sc.names));
    const projectScriptlets = selectProjectScriptlets(usedNames, agAvailable);

    const trimmed = {
        version:    full.version,
        ...corelibsCreditFields(),  // credit: where the code comes from and under which licence
        scriptlets: [ ...full.scriptlets.filter(s => usedNames.has(s.names[0])), ...projectScriptlets ],
    };

    // "Are there new scriptlets in AdGuard Base we can't run?" — a name the
    // filter lists use but the package doesn't have is silently skipped by
    // buildScriptletFile() (no function body to inline), so it is surfaced
    // here instead. Every alias counts as available (names[1..]).
    const available = new Set([ ...agAvailable, ...projectScriptlets.flatMap(sc => sc.names) ]);
    const missing = [ ...usedNames ].filter(n => !available.has(n) && !available.has(`ubo-${n}.js`) && !available.has(`abp-${n}`)).sort();
    if ( missing.length !== 0 ) {
        buildNotices.push({
            level: 'WARNING',
            text: `${missing.length} scriptlet name(s) used by the filter lists are not in @adguard/scriptlets@${full.version}, so those rules are skipped: ${missing.join(', ')}`,
        });
    }

    // Build-time-only intermediate: buildScriptletFile() below reads this
    // same path later in this build() run to look up scriptlet function
    // bodies for the per-ruleset dispatch files (ruleset_<id>-scriptlets.js —
    // the files actually shipped and read at runtime). Nothing in the
    // extension's runtime code reads js/resources/ag-scriptlets-corelibs.json
    // directly; it exists only as a hand-off between these two build steps
    // and should not be copied into the shipped extension package.
    const outPath = path.join(ROOT, 'js/resources/ag-scriptlets-corelibs.json');
    await fs.writeFile(outPath, JSON.stringify(trimmed), 'utf8');

    const fullSize    = JSON.stringify(full).length;
    const trimmedSize = JSON.stringify(trimmed).length;
    console.log(`AG corelibs v${full.version}: ${trimmed.scriptlets.length}/${full.scriptlets.length} scriptlets, ` +
                `${Math.round(trimmedSize/1024)}KB (full: ${Math.round(fullSize/1024)}KB)`);

    return full;
}
