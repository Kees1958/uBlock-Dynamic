// ── tools/build/build-step-checks.mjs ─────────────────────────────────────────────────
// Post-conditions: one check per build step, run by the orchestrator before the next step may start.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: checkCleanOrphans, checkInit, checkLists, checkScriptletAssets, checkScriptletExceptions, checkScriptletPrecompile, checkWriteRegistries, checkWriteReports, checkWriteScriptletFiles
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import fs from 'fs/promises';
import path from 'path';
import { ROOT } from './build-paths.mjs';
import { topSitesSet } from './build-state.mjs';
import { readJsonOr } from './build-steps.mjs';
import { SCRIPTLET_LIBRARY_END_FILE, SCRIPTLET_LIBRARY_ENTITY_FILE, SCRIPTLET_LIBRARY_FILE, SCRIPTLET_SITES_FILE } from '../../js/data/scriptlet-library.js';

// ── Post-conditions ─────────────────────────────────────────────────────
// Each returns null when satisfied, or a one-line description of what is
// wrong. Silent on success, so a passing build's output is unchanged.

async function fileExists(relOrAbs) {
    try { await fs.access(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs)); return true; } catch { return false; }
}

export async function checkInit(ctx) {
    if ( !(topSitesSet instanceof Set) || topSitesSet.size === 0 ) { return 'CrUX top-sites set is empty or missing'; }
    if ( ctx.manifest === null || typeof ctx.manifest !== 'object' ) { return 'manifest.json was not read'; }
    return null;
}

export async function checkLists(ctx) {
    if ( ctx.ruleResources.length === 0 ) { return 'no ruleset was produced'; }
    const ids = ctx.ruleResources.map(r => r.id);
    if ( new Set(ids).size !== ids.length ) { return 'a ruleset id was produced twice'; }
    for ( const r of ctx.ruleResources ) {
        if ( await fileExists(r.path) === false ) { return `ruleset file missing: ${r.path}`; }
    }
    return null;
}

// (11.0.0) The cookie-notice sets exist, both modes have sites, and every name they call will be in the trimmed corelibs.
export async function checkCookieNotices(ctx) {
    const sets = ctx.cookieNoticeSets;
    if ( sets === undefined || !(sets.scriptlets?.decline instanceof Map) || !(sets.scriptlets?.accept instanceof Map) ) { return 'cookie-notice sets were not built'; }
    if ( sets.scriptlets.decline.size === 0 || sets.scriptlets.accept.size === 0 ) { return 'a cookie-notice scriptlet set is empty'; }
    const missing = [ ...sets.usedNames ].filter(n => !ctx.usedScriptletNames.has(n));
    return missing.length === 0 ? null : `cookie-notice names missing from usedScriptletNames: ${missing.join(', ')}`;
}

// (11.0.0) The Ad leftover cleaner data file was written and holds the list.
export async function checkAdCleaner(ctx) {
    const [ rel, bytes ] = ctx.adCleanerFile ?? [];
    if ( typeof rel !== 'string' || await fileExists(rel) === false ) { return 'ad cleaner data file was not written'; }
    if ( !(bytes > 0) || !(ctx.adCleanerCounts?.kept > 0) ) { return 'ad cleaner data file is empty'; }
    return null;
}

// (11.0.0) Every cookie-notice file was written.
export async function checkWriteCookieNotices(ctx) {
    const sizes = ctx.cookieNoticeFiles?.sizes;
    if ( !Array.isArray(sizes) || sizes.length === 0 ) { return 'cookie-notice files were not written'; }
    for ( const [ rel ] of sizes ) {
        if ( await fileExists(rel) === false ) { return `cookie-notice file missing: ${rel}`; }
    }
    return null;
}

export async function checkScriptletAssets() {
    if ( await fileExists('js/resources/ag-scriptlets-corelibs.json') === false ) { return 'trimmed corelibs file was not written'; }
    return null;
}

export async function checkScriptletPrecompile(ctx) {
    return typeof ctx.buildScriptletFile === 'function' ? null : 'scriptlet file generator was not built';
}

export async function checkScriptletExceptions(ctx) {
    return Array.isArray(ctx.allScriptletRules) ? null : 'scriptlet rules are no longer a list';
}

export async function checkWriteScriptletFiles(ctx) {
    const entries = await readJsonOr(path.join(ctx.rulesetDir, 'scriptlet-files.json'), null);
    if ( Array.isArray(entries) === false ) { return 'scriptlet-files.json is missing or unreadable'; }
    for ( const entry of entries ) {
        if ( await fileExists(entry.file) === false ) { return `registered scriptlet file missing: ${entry.file}`; }
        if ( entry.entityFile !== undefined && await fileExists(entry.entityFile) === false ) { return `registered "name.*" scriptlet file missing: ${entry.entityFile}`; }
    }
    // (10.5.6) Every list has its site list (the SITES registration's matches come from it).
    const sites = await readJsonOr(path.join(ROOT, SCRIPTLET_SITES_FILE), null);
    if ( sites === null || typeof sites !== 'object' ) { return `${SCRIPTLET_SITES_FILE} is missing or unreadable`; }
    const unlisted = entries.find(e => Array.isArray(sites[e.id]) === false);
    if ( unlisted !== undefined ) { return `${SCRIPTLET_SITES_FILE} has no site list for ${unlisted.id}`; }
    // The shared library and its end file are registered around every data file (after 10.4.4).
    for ( const file of [ SCRIPTLET_LIBRARY_FILE, SCRIPTLET_LIBRARY_ENTITY_FILE, SCRIPTLET_LIBRARY_END_FILE ] ) {
        if ( await fileExists(file) === false ) { return `shared scriptlet library file missing: ${file}`; }
    }
    return null;
}

export async function checkWriteRegistries(ctx) {
    const written = await readJsonOr(ctx.manifestPath, null);
    const resources = written?.declarative_net_request?.rule_resources;
    if ( Array.isArray(resources) === false ) { return 'manifest.json has no rule_resources after writing'; }
    if ( resources.length !== ctx.ruleResources.length ) { return 'manifest.json rule_resources does not match this build'; }
    return null;
}

export async function checkCleanOrphans(ctx) {
    // The orphan cleanup must never have removed a file this build registered.
    for ( const r of ctx.ruleResources ) {
        if ( await fileExists(r.path) === false ) { return `orphan cleanup removed a registered ruleset: ${r.path}`; }
    }
    return null;
}

export async function checkWriteReports() { return null; }
