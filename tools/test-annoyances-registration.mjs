#!/usr/bin/env node
// tools/test-annoyances-registration.mjs — ruleset_annoyances is an always-on Built-in default
// list since 10.0.7 (previously its hide rules/scriptlets were session-gated at registration
// time). This test asserts it now behaves EXACTLY like an ordinary always-on list
// (ruleset_adguard_base): registered regardless of Worry-free session state, with no
// $worryfree-specific excludeMatches, its storage-backed cosmetic data persists the same way
// an ordinary list's does, and — critically — the ordinary Filter-Lists enable/disable toggle
// still works via bypassAlwaysOnIds (otherwise ALWAYS_ON_RULESETS would keep it registered
// regardless of the toggle, a real bug this test guards against, not just a cosmetic change).
//
// Drives the REAL exported registerScriptletContentScripts()/registerCosmeticContentScripts()
// against the SHIPPED rulesets/ registries (Part D step 15), with only Chrome's storage/DNR/
// scripting APIs mocked.
//
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RULESETS = path.join(ROOT, 'rulesets');
const ANNOY = 'ruleset_annoyances';
const AUTO_DENY_STORAGE_KEY = 'cookieClicker.autoDeny';
const EXEMPT = 'exempt.example';

console.log('=== ruleset_annoyances registers as an ordinary always-on default list (10.0.7) ===');

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}
for ( const f of [ 'scriptlet-files.json', 'cosmetic-files.json' ] ) {
    if ( !fs.existsSync(path.join(RULESETS, f)) ) { didNotRun(`rulesets/${f} is missing — build the rulesets first`); }
}
const scriptletFiles = JSON.parse(fs.readFileSync(path.join(RULESETS, 'scriptlet-files.json'), 'utf8'));
const cosmeticFiles = JSON.parse(fs.readFileSync(path.join(RULESETS, 'cosmetic-files.json'), 'utf8'));
if ( !scriptletFiles.some(e => e.id === ANNOY) || !cosmeticFiles.some(e => e.id === ANNOY) ) {
    didNotRun(`${ANNOY} is not in the shipped scriptlet-files.json / cosmetic-files.json registries`);
}
const ORDINARY = 'ruleset_adguard_base';
if ( !scriptletFiles.some(e => e.id === ORDINARY) || !cosmeticFiles.some(e => e.id === ORDINARY) ) {
    didNotRun(`${ORDINARY} is not in the registries — pick another ordinary list for this check`);
}

// ── Minimal browser/chrome mock ───────────────────────────────────────────────
const storage = new Map();
const registered = new Map();
function mkArea() { return {
    get: async keys => {
        const names = typeof keys === 'string' ? [ keys ] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
        return Object.fromEntries(names.filter(k => storage.has(k)).map(k => [ k, storage.get(k) ]));
    },
    set: async obj => { for ( const [ k, v ] of Object.entries(obj) ) { storage.set(k, v); } },
    remove: async keys => { for ( const k of (typeof keys === 'string' ? [ keys ] : keys) ) { storage.delete(k); } },
    setAccessLevel: async () => {},
}; }
let enabledRulesets = [ ANNOY, ORDINARY ];
globalThis.self = globalThis;
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => p, lastError: null, onMessage: { addListener() {} } },
    storage: { local: mkArea(), session: mkArea() },
    declarativeNetRequest: {
        updateDynamicRules: async () => {}, getDynamicRules: async () => [],
        updateSessionRules: async () => {}, getSessionRules: async () => [],
        updateEnabledRulesets: async () => {},
        getEnabledRulesets: async () => enabledRulesets,
    },
    scripting: {
        getRegisteredContentScripts: async filter => {
            const all = [ ...registered.values() ];
            return filter?.ids ? all.filter(d => filter.ids.includes(d.id)) : all;
        },
        registerContentScripts: async list => { for ( const d of list ) { registered.set(d.id, JSON.parse(JSON.stringify(d))); } },
        updateContentScripts: async list => { for ( const d of list ) { registered.set(d.id, JSON.parse(JSON.stringify(d))); } },
        unregisterContentScripts: async ({ ids } = {}) => { for ( const id of (ids ?? [ ...registered.keys() ]) ) { registered.delete(id); } },
    },
    tabs: { query: async () => [], get: async () => ({}) },
    action: { setIcon() {}, setBadgeText() {}, setTitle() {} },
    permissions: { contains: async () => true },
};
globalThis.fetch = async url => {
    const file = path.join(ROOT, String(url));
    if ( !fs.existsSync(file) ) { throw new Error(`no such shipped file: ${url}`); }
    return { json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

let manager, config;
try {
    manager = await import(path.join(ROOT, 'js/core/scripting-manager.js'));
    config = await import(path.join(ROOT, 'js/data/config.js'));
} catch ( err ) {
    didNotRun(`cannot import the modules under test (${err.message})`);
}
for ( const fn of [ 'registerScriptletContentScripts', 'registerCosmeticContentScripts' ] ) {
    if ( typeof manager[fn] !== 'function' ) { didNotRun(`scripting-manager.js does not export ${fn} — this check needs updating`); }
}

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if ( !ok ) { failures++; }
}
// Scriptlets: a list "is registered" when its data file (SITES: "<id>-scriptlets.js", or ENTITY: "<id>-
// scriptlets-entity.js") is in one of the two registrations' js list, between the matching library file (first)
// and the shared end file (last) — see js/util/scriptlet-site-scope.js (10.5.6).
function directiveFor(kind, id) {
    if ( kind === 'scriptlet' ) {
        return [ ...registered.values() ].find(d => d.id.includes(kind) &&
            ((d.js ?? []).includes(`/rulesets/${id}-scriptlets.js`) || (d.js ?? []).includes(`/rulesets/${id}-scriptlets-entity.js`)));
    }
    // (11.1.0) Hide rules: ONE shared registration (scripting-manager.js COSMETIC_CS_ID) — a list "is registered" when
    // its loader file is in that registration's js list, before the shared reader css-specific.js (last).
    const loader = cosmeticFiles.find(f => f.id === id)?.loaderFile;
    return [ ...registered.values() ].find(d => d.id.toLowerCase().includes(kind) && loader !== undefined &&
        (d.js ?? []).includes(`/${loader}`));
}
async function registerBoth(bypassAlwaysOnIds) {
    await manager.registerScriptletContentScripts(bypassAlwaysOnIds);
    await manager.registerCosmeticContentScripts(bypassAlwaysOnIds);
}
function setSession(active) {
    if ( active ) { storage.set(AUTO_DENY_STORAGE_KEY, { active: true, untilMs: null, startedAtMs: Date.now() }); }
    else { storage.delete(AUTO_DENY_STORAGE_KEY); }
}

const ORIG_DOMAINS = [ ...config.worryfreeState.domains ];
try {
    config.worryfreeState.domains = [];

    // 0 — an install updated from 10.4.4 or older still has one registration per list: the first pass
    //     must unregister those (GUARD: release, legacy registrations).
    const LEGACY_ID = `ag-scriptlets-${ORDINARY}`;
    registered.set(LEGACY_ID, { id: LEGACY_ID, js: [ `/rulesets/${ORDINARY}-scriptlets.js` ], matches: [ '<all_urls>' ], world: 'MAIN' });

    // 1 — no session: annoyances IS registered anyway (always-on default, like the ordinary list).
    setSession(false);
    await registerBoth();
    check('legacy per-list scriptlet registration from 10.4.4 is unregistered', registered.has(LEGACY_ID) === false);
    check('no session: annoyances scriptlets ARE registered (always-on default)', directiveFor('scriptlet', ANNOY) !== undefined);
    check('no session: annoyances hide rules ARE registered (always-on default)', directiveFor('cosmetic', ANNOY) !== undefined);
    check('no session: an ordinary list IS still registered (scriptlets)', directiveFor('scriptlet', ORDINARY) !== undefined);
    // (10.7.4) TWO registrations again (the 10.5.6 shape): ONE shared SITES registration carrying EVERY list's data
    // file between ONE library file and ONE end file, plus ONE shared ENTITY (ag-scriptlets-entity, the "name.*"
    // rules — present because ORDINARY, AdGuard Base, has some). 10.6.0's one-SITES-registration-per-list broke every
    // site named by two lists: Chrome runs an extension file once per page, so the first list's end file deleted the
    // library before the second list's data file ran (cnn.com: Quick-fixes behind AdGuard Base).
    const combined = [ ...registered.values() ].filter(d => d.id.includes('scriptlet'));
    const sites = combined.find(d => d.id === 'ag-scriptlets-sites');
    const entity = combined.find(d => d.id === 'ag-scriptlets-entity');
    function endsRight(d) { return d?.js.at(-1) === '/rulesets/scriptlet-library-end.js'; }
    check('scriptlets: exactly two registrations — one shared SITES + one shared ENTITY, library-first/end-file-last',
        combined.length === 2 && endsRight(sites) && endsRight(entity) &&
        sites.js[0] === '/rulesets/scriptlet-library.js' && entity.js[0] === '/rulesets/scriptlet-library-entity.js',
        combined.map(d => d.id).join(', '));
    check('…and the SITES registration carries BOTH lists\' data files with exactly ONE library and ONE end file (the fix)',
        sites.js.includes(`/rulesets/${ANNOY}-scriptlets.js`) && sites.js.includes(`/rulesets/${ORDINARY}-scriptlets.js`) &&
        sites.js.filter(f => f === '/rulesets/scriptlet-library.js').length === 1 &&
        sites.js.filter(f => f === '/rulesets/scriptlet-library-end.js').length === 1);
    check('…and no 10.6.0-style per-list SITES registration is left', combined.every(d => !d.id.startsWith('ag-scriptlets-sites-')));
    check('no session: an ordinary list IS still registered (hide rules)', directiveFor('cosmetic', ORDINARY) !== undefined);
    // (11.1.0) The cosmetic fix: Chrome runs a file once per page, so every list's loader must sit in ONE registration
    // ahead of the ONE reader — per-list registrations let only the first list's site rules be read.
    const cosmetic = [ ...registered.values() ].filter(d => d.id.startsWith('ag-cosmetic-'));
    const reader = '/js/scripting/css-specific.js';
    check('hide rules: exactly ONE registration, both lists\' loaders in it, ONE reader, last',
        cosmetic.length === 1 && cosmetic[0].js.at(-1) === reader && cosmetic[0].js.filter(f => f === reader).length === 1 &&
        [ ANNOY, ORDINARY ].every(id => cosmetic[0].js.includes(`/${cosmeticFiles.find(f => f.id === id).loaderFile}`)),
        cosmetic.map(d => d.id).join(', '));
    check('hide rules: every loader appends to self.specificImports (never replaces it)',
        cosmeticFiles.every(f => fs.readFileSync(path.join(path.dirname(RULESETS), f.loaderFile), 'utf8').startsWith('(self.specificImports=self.specificImports||[]).push(')));
    check('no session: the hide-rule data WAS written to storage (same as an ordinary list)', [ ...storage.keys() ].some(k => k.includes(ANNOY)));

    // 2 — session on: no change (not session-gated any more).
    setSession(true);
    await registerBoth();
    const s2 = directiveFor('scriptlet', ANNOY);
    const c2 = directiveFor('cosmetic', ANNOY);
    check('session on: annoyances scriptlets still registered (MAIN world)', s2 !== undefined && s2.world === 'MAIN');
    check('session on: annoyances hide rules still registered', c2 !== undefined);

    // 3 — a $worryfree exempt site must NOT affect annoyances any more (no special-casing left).
    config.worryfreeState.domains = [ EXEMPT ];
    await registerBoth();
    const s3 = directiveFor('scriptlet', ANNOY);
    const c3 = directiveFor('cosmetic', ANNOY);
    check('annoyances scriptlets get NO $worryfree-specific excludeMatches entry', (s3?.excludeMatches ?? []).every(p => !p.includes(EXEMPT)));
    check('annoyances hide rules get NO $worryfree-specific excludeMatches entry', (c3?.excludeMatches ?? []).every(p => !p.includes(EXEMPT)));
    config.worryfreeState.domains = [];
    await registerBoth();

    // 4 — bypassAlwaysOnIds: the ordinary Filter-Lists enable/disable toggle must still be able
    // to turn annoyances off, exactly like it would for any other ALWAYS_ON_RULESETS member.
    enabledRulesets = [ ORDINARY ];   // annoyances "disabled" via the toggle
    await registerBoth(new Set([ ANNOY ]));
    check('bypassAlwaysOnIds: toggling annoyances off actually unregisters its scriptlets', directiveFor('scriptlet', ANNOY) === undefined);
    check('bypassAlwaysOnIds: toggling annoyances off actually unregisters its hide rules', directiveFor('cosmetic', ANNOY) === undefined);
    check('bypassAlwaysOnIds: the ordinary list is unaffected by the bypass set', directiveFor('scriptlet', ORDINARY) !== undefined && directiveFor('cosmetic', ORDINARY) !== undefined);

    // 5 — release: re-enable, confirm it comes back without the bypass set.
    enabledRulesets = [ ANNOY, ORDINARY ];
    await registerBoth();
    check('re-enabled (no bypass): annoyances scriptlets registered again', directiveFor('scriptlet', ANNOY) !== undefined);
    check('re-enabled (no bypass): annoyances hide rules registered again', directiveFor('cosmetic', ANNOY) !== undefined);
} finally {
    config.worryfreeState.domains = ORIG_DOMAINS;   // GUARD (release): leave the shared config as found
}

if ( failures !== 0 ) {
    console.log(`\nFAIL: ${failures} problem(s) — ruleset_annoyances no longer behaves as an ordinary always-on default list.`);
    process.exit(1);
}
console.log('\nPASS: ruleset_annoyances registers exactly like any other always-on default list, and its Filter-Lists toggle still works.');
