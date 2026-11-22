#!/usr/bin/env node
// tools/check-crud-lifecycle.mjs — C41: CRUD for every data element, Initiate–Perform–End for every process (HARD check).
//
// WHY (real report, 10.0.0/10.0.1): "@@domain$worryfree" shipped documented in tooltips but only CREATABLE in one of its three
// channels; its list was Created and Read but never EXPORTED (a settings backup silently lost it); and an Allow-list change
// did not refresh the content-script exclusions (an Update that did not reach its dependents). Each is a missing CRUD letter or a
// missing lifecycle step that every mechanical check still passed. This check makes the letters and steps explicit:
//
//   DATA ELEMENT — Created (where does it come from) · Read (is it actually consumed) · Updated (a path to change it, which reaches
//   its dependents) · Deleted (a path to remove/clear/reset it, leaving nothing stranded).
//   PROCESS — guards live in the code (B3a/B10); this adds the LOGICAL check: Initiate (what starts it) → Perform (the observable
//   effect actually happens) → End (every way it ends leaves nothing behind), proven by a test that drives the real functions.
//
// Four parts, each fails by default for anything NEW and unclassified (C25's allowlist pattern):
//   1. every boolean securityConfig toggle: default (C) · reader outside config (R) · dashboard checkbox (U) · export+import (D)
//   2. every per-site option (SITE_MODE_OPTIONS): Get/Set routes (R/U) · settings export + import (C/D round trip)
//   3. every dynamic-rule id the exemption managers own: built by the manager (C) and removed by it (D)
//   4. every process module (js/core/*-manager.js + exempt-domains.js): registered with an Initiate/Perform/End test label that
//      exists in the named test file — or explicitly marked legacy (pre-C41, informational count)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function listFiles(dir, out = []) {
    for ( const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }) ) {
        const rel = path.posix.join(dir, entry.name);
        if ( entry.isDirectory() ) { listFiles(rel, out); } else if ( /\.(m?js)$/.test(entry.name) ) { out.push(rel); }
    }
    return out;
}
function stripLineComments(text) { return text.replace(/^\s*\/\/.*$/gm, ''); }

// ── Config — every tunable declared once ───────────────────────────────────────────────────────────
// Where a Read of a securityConfig key counts (behaviour code). NOT config.js itself (that is the Create) and NOT the update plumbing.
const READER_DIRS = [ 'js/core', 'js/scripting', 'js/offscreen', 'js/security', 'popup', 'privacy', 'matrix' ];
// Single files that also CONSUME a key (the service worker's startup flow).
// (11.0.0) js/data/power-tools.js: arePowerToolsShown() is the one reader of advancedUser — popup, background and
// dashboard all read it through that function (by POWER_TOOLS_SETTING_KEY, never the literal), so the literal is there.
// (11.0.0) js/data/seamless-switch.js: isSeamlessSurfingEnabled() is the one reader of seamlessSurfingEnabled (same shape).
const READER_FILES = [ 'js/workflow/background.js', 'js/data/power-tools.js', 'js/data/seamless-switch.js' ];
// securityConfig keys with NO dashboard checkbox ON PURPOSE. Each needs a reason; a new key here is a decision, not a default.
// Empty since 10.5.0 — blockPings (the one key that used to live here) was removed outright, not just
// its checkbox; see CHANGELOG_HISTORY.md. Kept as an object, not deleted, so a future "no checkbox by
// design" key needs no new plumbing here.
const NO_CHECKBOX_BY_DESIGN = Object.freeze({
    // (11.0.0, owner's decision) Seamless surfing is always on; an advanced user turns it off (and back on) from the
    // Seamless surfing prompt's own choices, not from an Options checkbox (js/data/seamless-switch.js).
    seamlessSurfingEnabled: 'switched from the Seamless surfing prompt (advanced users only), not an Options checkbox',
});
// The test file + label substring proving each lifecycle step of each process (Part 4). One entry per process module.
const PROCESS_REGISTRY = Object.freeze({
    'js/core/exempt-domains.js': { process: 'ABP-import exemption lists', file: 'tools/test-worryfree-exemption.mjs',
        initiate: 'effective list = built-in + ABP-import', perform: 'DNR: the three whole-site rules carry the ABP-import site',
        end: 'removing the ABP-import line removes the DNR exemption' },
    'js/core/worryfree-manager.js': { process: '$worryfree whole-site exemption', file: 'tools/test-worryfree-exemption.mjs',
        initiate: 'dnr: input normalised', perform: 'site: three whole-site rules at 9 500',
        end: 'dnr: clearing the Allow-list tab' },
    // (10.7.16) CMP loader blocks (Sourcepoint) while Seamless surfing declines cookie banners.
    'js/core/cmp-loader-block-manager.js': { process: 'CMP loader blocks', file: 'tools/test-cmp-loader-block.mjs',
        initiate: 'initiate: decline mode adds one loader-block rule', perform: 'perform: sites with a saved cookie-clicker rule are exempt',
        end: 'end: release removes every loader-block rule' },
    // (10.3.0 removal) 'js/core/saferegions-manager.js' and 'js/core/worry-free-familiar-tld-manager.js'
    // REMOVED from this registry — both files are deleted along with the retired Worry-free tier
    // checkboxes and the $saferegions option; see CHANGELOG.md 10.3.0 and
    // js/data/retired-protections.js.
});
// Process modules that PRE-DATE this principle and whose lifecycle has not been audited yet. Listed, counted, never silently
// skipped; moving one into PROCESS_REGISTRY (with real test labels) is the way out. A NEW module may NOT be added here.
// (AdShield Evolution rename pass) js/core/worry-free-advanced-manager.js
// removed from this list — the file itself was deleted (the Advanced
// tier it implemented is retired per explicit request); see
// CHANGELOG_HISTORY.md for the full entry.
// (10.3.0 removal) js/core/worry-free-high-risk-headers-manager.js removed — the file is deleted along
// with the retired Privacy & Security protections.
const LEGACY_UNAUDITED = Object.freeze([
    'js/core/cookie-clicker-autodeny-manager.js', 'js/core/filter-manager.js', 'js/core/mode-manager.js',
    'js/core/ruleset-manager.js', 'js/core/scripting-manager.js', 'js/core/site-mode-manager.js', 'js/core/temp-disable-manager.js',
    'js/core/worry-free-extra-manager.js',
]);
const PROCESS_MODULE_RE = /(-manager\.js|^exempt-domains\.js)$/;

let failures = 0;
let legacyCount = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if ( !ok ) { failures += 1; }
}

// ── Minimal chrome mock so config.js can be imported ──────────────────────────────────────────────────
function area() { return { get: async () => ({}), set: async () => {}, remove: async () => {}, setAccessLevel: async () => {} }; }
globalThis.self = globalThis;
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => p, lastError: null, onMessage: { addListener() {} } },
    storage: { local: area(), session: area() },
    declarativeNetRequest: { updateDynamicRules: async () => {}, getDynamicRules: async () => [], updateSessionRules: async () => {},
        getSessionRules: async () => [], updateEnabledRulesets: async () => {}, getEnabledRulesets: async () => [] },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {} },
    tabs: { query: async () => [], get: async () => ({}) }, action: { setIcon() {}, setBadgeText() {}, setTitle() {} },
    permissions: { contains: async () => true },
};
const config = await import(path.join(ROOT, 'js/data/config.js'));
const { SITE_MODE_OPTIONS } = await import(path.join(ROOT, 'js/util/site-mode-parser.js'));

const background = read('js/workflow/background.js');          // ROUTE_HANDLERS (the wiring)
// (10.7.12) The settings handlers moved from background.js to js/workflow/settings-routes.js — this check reads them there.
const settingsRoutes = read('js/workflow/settings-routes.js');
const modeRoutes = read('js/workflow/mode-routes.js');
const dashboardHtml = read('dashboard/dashboard.html');
const readerFiles = [ ...READER_DIRS.flatMap(dir => (fs.existsSync(path.join(ROOT, dir)) ? listFiles(dir) : [])), ...READER_FILES ]
    .map(rel => ({ rel, text: stripLineComments(read(rel)) }));

// ── Part 1 — securityConfig toggles ──────────────────────────────────────────────────────────────────
console.log('\n── Part 1: securityConfig toggles (C · R · U · D) ──');
const toggleKeys = Object.entries(config.securityConfig).filter(([ , v ]) => typeof v === 'boolean').map(([ k ]) => k);
// (10.3.0 removal) securityConfig shrank from 20+ keys to 8 — the retired Privacy & Security
// protections' toggles are gone; see CHANGELOG.md 10.3.0.
check('securityConfig has toggles to audit', toggleKeys.length > 5, `${toggleKeys.length} boolean keys`);
const exportIncludes = /securityConfig:\s*structuredClone\(securityConfig\)/.test(settingsRoutes);
// (10.5.0) The import keeps only known keys before merging (pickKnownKeys(securityConfig, payload.securityConfig) —
// replaced the 10.3.0 retired-key strip), so the second Object.assign() argument is a wrapped call — match either shape.
const importMerges = /Object\.assign\(securityConfig,\s*(payload\.securityConfig|pickKnownKeys\(securityConfig,\s*payload\.securityConfig\))/.test(settingsRoutes);
check('Delete/Create via backup: the settings export carries the whole securityConfig and the import merges it back', exportIncludes && importMerges);
const readMissing = [];
const updateMissing = [];
for ( const key of toggleKeys ) {
    const re = new RegExp(`\\b${key}\\b`);
    if ( readerFiles.some(f => re.test(f.text)) === false ) { readMissing.push(key); }
    const hasCheckbox = new RegExp(`data-setting="${key}"`).test(dashboardHtml);
    if ( hasCheckbox === false && NO_CHECKBOX_BY_DESIGN[key] === undefined ) { updateMissing.push(key); }
}
check('Read: every toggle is consumed by behaviour code (js/core, scripting, security, popup, ...)', readMissing.length === 0, readMissing.join(', '));
check('Update: every toggle has a dashboard checkbox (data-setting) or a stated reason in NO_CHECKBOX_BY_DESIGN', updateMissing.length === 0, updateMissing.join(', '));
const staleNoCheckbox = Object.keys(NO_CHECKBOX_BY_DESIGN).filter(k => toggleKeys.includes(k) === false);
check('NO_CHECKBOX_BY_DESIGN lists no key that no longer exists', staleNoCheckbox.length === 0, staleNoCheckbox.join(', '));

// ── Part 2 — per-site options ────────────────────────────────────────────────────────────────────────
console.log('\n── Part 2: per-site options (routes · backup round trip) ──');
const messageRoutes = read('js/workflow/message-routes.js');
// The object the export RETURNS (not the whole function: the field name also appears in the Promise.all destructuring,
// which would let a forgotten return field pass).
const exportFn = settingsRoutes.slice(settingsRoutes.indexOf('async function handleExportAllSettings'), settingsRoutes.indexOf('async function handleImportAllSettings'));
const exportReturned = (exportFn.match(/return\s*\{[\s\S]*?\n\s*\};/) ?? [ '' ])[0];
for ( const option of Object.values(SITE_MODE_OPTIONS) ) {
    check(`[${option}] Read/Update routes: ${option}GetAll / ${option}SetAll are declared in MESSAGE_ROUTES and wired in ROUTE_HANDLERS`,
        new RegExp(`${option}GetAll:`).test(messageRoutes) && new RegExp(`${option}SetAll:`).test(messageRoutes)
        && new RegExp(`${option}GetAll:\\s*handle`).test(background) && new RegExp(`${option}SetAll:\\s*handle`).test(background));
    check(`[${option}] Create/Read via backup: the settings EXPORT carries the Allow list tab's ${option} list`,
        new RegExp(`\\b${option}Domains\\b`).test(exportReturned));
    // (10.7.12) The import's merge table names the getter and setter directly ([ '<option>Domains', get…, set… ]);
    // the setter must be the very function the Allow list tab's SetAll handler (mode-routes.js) calls.
    const mergeRow = settingsRoutes.match(new RegExp(`\\[\\s*'${option}Domains',\\s*(\\w+),\\s*(\\w+)\\s*\\]`));
    const capOption = option.charAt(0).toUpperCase() + option.slice(1);
    const setAllAt = modeRoutes.indexOf(`function handle${capOption}SetAll`);
    const setAllBody = setAllAt === -1 ? '' : modeRoutes.slice(setAllAt, modeRoutes.indexOf('\n}\n', setAllAt));
    check(`[${option}] Delete/Update via backup: the settings IMPORT merges it back through the same setter as its SetAll handler`,
        mergeRow !== null && new RegExp(`\\b${mergeRow[2]}\\(`).test(setAllBody), mergeRow ? mergeRow[2] : 'no merge row');
}

// ── Part 3 — dynamic rule ids owned by the exemption managers ───────────────────────────────────────
console.log('\n── Part 3: dynamic rule ids (built by the owner · removed by the owner) ──');
const budgets = read('js/core/dnr-budgets.js');
// (10.3.0 removal) the saferegions-manager.js/SAFEREGIONS_ pair is gone — that manager file is
// deleted along with the retired $saferegions option; see CHANGELOG.md 10.3.0.
for ( const [ managerFile, idPrefix ] of [ [ 'js/core/worryfree-manager.js', 'WORRYFREE_' ] ] ) {
    const manager = stripLineComments(read(managerFile));
    // Exclude ids whose OWN declaration line is tagged "// RETIRED" (10.3.0's retirement convention —
    // the identifier itself keeps its name, never renamed, but the trailing comment says it's
    // permanently reserved in dnr-budgets.js RETIRED_PROTECTION_RULE_RANGES, not managed here).
    const ids = [ ...budgets.matchAll(new RegExp(`export const (${idPrefix}[A-Z0-9_]*_RULE_ID)\\s*=[^\\n]*$`, 'gm')) ]
        .filter(m => /\/\/\s*RETIRED\b/.test(m[0]) === false)
        .map(m => m[1]);
    check(`${managerFile}: owns ${ids.length} rule id(s)`, ids.length > 0);
    for ( const id of ids ) {
        check(`  ${id}: built (Create) and in the remove-all list (Delete) by ${path.basename(managerFile)}`,
            manager.includes(id) && /ALL_RULE_IDS/.test(manager) && /removeRuleIds/.test(manager));
    }
}

// ── Part 4 — process lifecycle registry ──────────────────────────────────────────────────────────────
console.log('\n── Part 4: processes (Initiate · Perform · End) ──');
const processModules = listFiles('js/core').filter(rel => PROCESS_MODULE_RE.test(path.posix.basename(rel)));
for ( const rel of processModules ) {
    const entry = PROCESS_REGISTRY[rel];
    if ( entry !== undefined ) {
        const testText = read(entry.file);
        const missing = [ 'initiate', 'perform', 'end' ].filter(step => testText.includes(entry[step]) === false);
        check(`${rel}: "${entry.process}" — Initiate/Perform/End each proven by a test in ${entry.file}`, missing.length === 0,
            missing.map(s => `${s}: "${entry[s]}" not found`).join('; '));
    } else if ( LEGACY_UNAUDITED.includes(rel) ) {
        legacyCount += 1;
    } else {
        check(`${rel}: a NEW process module must be registered with an Initiate/Perform/End test (C41) — it is in neither list`, false);
    }
}
for ( const rel of Object.keys(PROCESS_REGISTRY) ) {
    check(`registry entry ${rel} still exists`, processModules.includes(rel));
}
for ( const rel of LEGACY_UNAUDITED ) {
    check(`legacy entry ${rel} still exists (remove it from LEGACY_UNAUDITED once audited or deleted)`, processModules.includes(rel));
}
console.log(`INFO ${legacyCount} pre-C41 process module(s) still have an unaudited lifecycle (listed in LEGACY_UNAUDITED).`);

if ( failures !== 0 ) {
    console.log(`\nFAIL: ${failures} problem(s) — a data element is missing a CRUD letter or a process is missing a lifecycle proof (C41).`);
    process.exit(1);
}
console.log('\nPASS: every data element has its CRUD paths and every registered process is proven Initiate -> Perform -> End.');
