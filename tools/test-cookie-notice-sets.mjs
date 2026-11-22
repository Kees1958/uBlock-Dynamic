#!/usr/bin/env node
// tools/test-cookie-notice-sets.mjs — (11.0.0) Seamless surfing's site-specific cookie-notice sets, HARD check.
// What they are: js/data/cookie-notice-sets.js. Three parts:
//   1. Rules (pure): the accept / decline classification, the "CMP uBD already answers" detection, the hide shard script.
//   2. Shipped files: every mode's data file decodes under the cookie library's OWN global and holds only policy-clean,
//      non-reload rows; the library publishes exactly what they call; "accept, else decline" = accept rows, else decline
//      rows, and its hide / block sets name no accept site; every hide shard and the sites file agree with the files.
//   3. Registration (real js/core/scripting-manager.js, chrome mocked): per mode the right files are registered, matched
//      to their own sites, with saved clicker-rule sites excluded everywhere (saved rules prevail), the mode's block
//      rules become session rules excluding those sites; accept mode has no hide/block; no session -> nothing at all.
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel.replace(/^\//, '')), 'utf8'); }

// ── Settings ──────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
    RULE_SITE: null,                                  // filled from the shipped decline set (a site that has rules)
    AUTO_DENY_STORAGE_KEY: 'cookieClicker.autoDeny',  // js/core/scripting-manager.js
    COOKIE_CLICKER_STORAGE_KEY: 'cookieClicker.rules',
    SETTING_KEY: 'seamlessCookieBannerAction',        // js/data/cookie-banner-action.js COOKIE_BANNER_SETTING_KEY
    RELOAD_NAMES: [ 'set-cookie-reload', 'trusted-set-cookie-reload' ],
});

console.log('=== Seamless surfing cookie-notice sets (11.0.0) ===');
let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if ( !ok ) { failures++; }
}
function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}\nA check that did not run has not passed.`);
    process.exit(1);
}

// ── chrome mock (storage, scripting, session DNR rules, package fetch) ────────
const local = new Map();
let registered = [];
let sessionRules = [];
function mkArea(store) { return {
    get: async keys => {
        if ( keys === null || keys === undefined ) { return Object.fromEntries(store); }
        const names = typeof keys === 'string' ? [ keys ] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(names.filter(k => store.has(k)).map(k => [ k, store.get(k) ]));
    },
    set: async obj => { for ( const [ k, v ] of Object.entries(obj) ) { store.set(k, v); } },
    remove: async keys => { for ( const k of (typeof keys === 'string' ? [ keys ] : keys) ) { store.delete(k); } },
    clear: async () => { store.clear(); },
    setAccessLevel: async () => {},
}; }
globalThis.self = globalThis;
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '11.0.0' }), getURL: p => p, lastError: null, id: 'test', onMessage: { addListener() {} } },
    storage: { local: mkArea(local), session: mkArea(new Map()), onChanged: { addListener() {} } },
    declarativeNetRequest: {
        updateDynamicRules: async () => {}, getDynamicRules: async () => [],
        getSessionRules: async () => sessionRules,
        updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
            sessionRules = sessionRules.filter(r => !removeRuleIds.includes(r.id)).concat(addRules);
        },
        updateEnabledRulesets: async () => {}, getEnabledRulesets: async () => [],
        isRegexSupported: async () => ({ isSupported: true }),
    },
    scripting: {
        getRegisteredContentScripts: async ({ ids } = {}) => registered.filter(r => !ids || ids.includes(r.id)),
        registerContentScripts: async list => { registered = registered.filter(r => !list.some(n => n.id === r.id)).concat(list); },
        updateContentScripts: async list => { registered = registered.map(r => ({ ...r, ...(list.find(n => n.id === r.id) ?? {}) })); },
        unregisterContentScripts: async ({ ids } = {}) => {
            const missing = (ids ?? []).filter(id => !registered.some(r => r.id === id));
            if ( missing.length !== 0 ) { throw new Error(`Nonexistent script ID '${missing[0]}'`); }   // Chrome rejects the whole call
            registered = ids ? registered.filter(r => !ids.includes(r.id)) : [];
        },
        executeScript: async () => [],
    },
    tabs: { query: async () => [], get: async () => ({}), sendMessage: async () => {} },
    permissions: { contains: async () => true, getAll: async () => ({ origins: [ '<all_urls>' ] }) },
    action: { setIcon() {}, setBadgeText() {}, setTitle() {}, setBadgeBackgroundColor() {} },
    alarms: { create() {}, clear: async () => true, get: async () => undefined, onAlarm: { addListener() {} } },
};
globalThis.fetch = async url => ({ json: async () => JSON.parse(read(String(url))), text: async () => read(String(url)) });

let sets, sources, layout, policy, action, config, sm;
try {
    sets    = await import(path.join(ROOT, 'js/data/cookie-notice-sets.js'));
    sources = await import(path.join(ROOT, 'tools/build/cookie-notice-sources.mjs'));
    layout  = await import(path.join(ROOT, 'tools/build/scriptlet-dispatch-layout.mjs'));
    policy  = await import(path.join(ROOT, 'js/data/scriptlet-policy.js'));
    action  = await import(path.join(ROOT, 'js/data/cookie-banner-action.js'));
    config  = await import(path.join(ROOT, 'js/data/config.js'));
    sm      = await import(path.join(ROOT, 'js/core/scripting-manager.js'));
} catch ( err ) {
    didNotRun(`cannot import the modules under test (${err.message})`);
}
const A = action.COOKIE_BANNER_ACTIONS;

// ── 1. Rules (pure) ───────────────────────────────────────────────────────────
console.log('--- 1. classification ---');
const C = sources.classifyAnswer;
check('click on a reject button is decline', C('trusted-click-element', [ '#cookie-reject-all' ]) === 'decline');
check('click on "disagree" is decline (not read as "agree")', C('trusted-click-element', [ 'button#disagree-btn' ]) === 'decline');
check('click on an accept button is accept', C('trusted-click-element', [ '.cookie-accept-all' ]) === 'accept');
check('click chain with both words is unclear', C('trusted-click-element', [ '.settings, .accept, .reject' ]) === 'unclear');
check('consent cookie = rejected is decline', C('set-cookie', [ 'cookie_consent', 'rejected' ]) === 'decline');
check('consent cookie = accepted is accept', C('set-cookie', [ 'cookie_consent', 'accepted' ]) === 'accept');
check('tracking cookie = false is decline', C('set-cookie', [ 'allowMarketing', 'false' ]) === 'decline');
check('consent cookie = true is accept', C('set-cookie', [ 'cookiesAccepted', 'true' ]) === 'accept');
check('"banner seen" = 1 is neutral (dismissed, no consent)', C('set-cookie', [ 'privacy_banner_viewed', '1' ]) === 'neutral');
check('refusal cookie = false is unclear', C('set-cookie', [ 'cookies_rejected', 'false' ]) === 'unclear');
check('a free-form JSON value is unclear', C('trusted-set-cookie', [ 'consent', '{"ads":true}' ]) === 'unclear');
check('a helper scriptlet is not an answering rule', C('remove-class', [ 'no-scroll', 'body' ]) === null);
const solid = new Set([ 'OneTrust', 'Quantcast Choice / InMobi CMP' ]);
check('OneTrust click is a covered CMP', sources.coveredCmpOf('trusted-click-element', [ '#onetrust-reject-all-handler' ], solid) === 'OneTrust');
check('Quantcast cookie key is a covered CMP', sources.coveredCmpOf('trusted-click-element', [ '.qc-cmp2-summary-buttons > button' ], solid) === 'Quantcast Choice / InMobi CMP');
check('an own banner is not covered', sources.coveredCmpOf('set-cookie', [ 'cookie_notice_closed', '1' ], solid) === null);
check('a CMP not in the solid set is not covered', sources.coveredCmpOf('trusted-click-element', [ '#onetrust-accept' ], new Set()) === null);

// Hide shard script: runs, hands exactly the page's selectors (one rule each) to cssAPI.insert.
{
    const writer = await import(path.join(ROOT, 'tools/build/cookie-notice-write.mjs'));
    const code = writer.renderHideShard(new Map([ [ 'example.com', [ '#cookie-bar', '.consent' ] ], [ 'other.org', [ '#x' ] ] ]));
    const calls = [];
    new Function('self', 'location', code)({ cssAPI: { insert: (css, now) => calls.push([ css, now ]) } }, { hostname: 'www.example.com' });
    check('hide shard: a subdomain page gets its site\'s selectors, each as its own rule, applied at once',
        calls.length === 1 && calls[0][1] === true && calls[0][0] === '#cookie-bar{display:none!important}\n.consent{display:none!important}', JSON.stringify(calls));
    const none = [];
    new Function('self', 'location', code)({ cssAPI: { insert: css => none.push(css) } }, { hostname: 'unrelated.net' });
    check('hide shard: an unlisted page inserts nothing', none.length === 0);
}

// ── 2. Shipped files ──────────────────────────────────────────────────────────
console.log('--- 2. shipped files ---');
let sitesFile;
try { sitesFile = JSON.parse(read(sets.COOKIE_NOTICE_SITES_FILE)); } catch ( err ) { didNotRun(`cannot read ${sets.COOKIE_NOTICE_SITES_FILE} (${err.message}) — run the build`); }
const decoded = {};
for ( const [ mode, files ] of Object.entries(sets.COOKIE_NOTICE_MODE_FILES) ) {
    try { decoded[mode] = layout.decodeDispatchSource(read(files.scriptlets), sets.COOKIE_NOTICE_LIBRARY_GLOBAL); } catch ( err ) {
        check(`${mode}: data file decodes under the cookie library global`, false, err.message); continue;
    }
    const d = decoded[mode];
    check(`${mode}: data file decodes under the cookie library global`, true);
    check(`${mode}: sites file lists exactly the data file's sites`, JSON.stringify([ ...d.entries.keys() ].sort()) === JSON.stringify(sitesFile.scriptlets[mode]));
    const rows = d.rowTable.map(r => ({ name: d.fnNames[r.fnIndex], args: r.args }));
    check(`${mode}: no reload scriptlet`, rows.every(r => !CONFIG.RELOAD_NAMES.includes(r.name)));
    const bad = rows.find(r => policy.scriptletViolationAnySource(r.name, r.args) !== null);
    check(`${mode}: every row passes the scriptlet policy`, bad === undefined, JSON.stringify(bad));
}
{
    const lib = layout.decodeLibrarySource(read(sets.COOKIE_NOTICE_LIBRARY_FILE), sets.COOKIE_NOTICE_LIBRARY_GLOBAL);
    const called = new Set(Object.values(decoded).flatMap(d => d.fnNames));
    check('cookie library publishes exactly the functions the three files call', JSON.stringify([ ...called ].sort()) === JSON.stringify([ ...lib.names ].sort()));
    check('cookie library does NOT use the shared library global', !read(sets.COOKIE_NOTICE_LIBRARY_FILE).includes('__usd_scriptlets_7f3a9c2e'));
    check('cookie end file removes the cookie global', read(sets.COOKIE_NOTICE_LIBRARY_END_FILE).includes(sets.COOKIE_NOTICE_LIBRARY_GLOBAL));
}
const PA = A.PREFER_ACCEPT;
if ( decoded[A.ACCEPT] && decoded[A.DECLINE] && decoded[PA] ) {
    const acceptSites = new Set(decoded[A.ACCEPT].entries.keys());
    function rowsOf(d, site) { return JSON.stringify((d.entries.get(site) ?? []).map(([ fn, , args ]) => [ d.fnNames[fn], args ])); }
    const wrong = [ ...decoded[PA].entries.keys() ].find(site => rowsOf(decoded[PA], site) !== rowsOf(acceptSites.has(site) ? decoded[A.ACCEPT] : decoded[A.DECLINE], site));
    check('accept, else decline: each site carries its accept rows, else its decline rows', wrong === undefined, wrong);
    const expectedSites = new Set([ ...acceptSites, ...decoded[A.DECLINE].entries.keys() ]);
    check('accept, else decline: covers every accept and every decline site', expectedSites.size === decoded[PA].entries.size);
    function parents(h) { const o = [ h ]; for ( let i = h.indexOf('.'); i !== -1 && h.indexOf('.', i + 1) !== -1; i = h.indexOf('.', i + 1) ) { o.push(h.slice(i + 1)); } return o; }
    // Every decline hide rule stays (a dialog the accept rule does not answer must still go — bbc.com, 11.0.0).
    check('accept, else decline: uses the decline hide family (every hide rule, no copy)',
        sets.COOKIE_NOTICE_MODE_FILES[PA].hideFamily === sets.COOKIE_NOTICE_MODE_FILES[A.DECLINE].hideFamily);
    check('accept, else decline: bbc.com keeps its accept rule AND its hide rules',
        acceptSites.has('bbc.com') && sitesFile.hide[sets.COOKIE_NOTICE_MODE_FILES[PA].hideFamily].flat().includes('bbc.com'));
    const blocks = JSON.parse(read(sets.COOKIE_NOTICE_MODE_FILES[PA].blocks));
    const blockLeak = blocks.find(r => (r.condition.initiatorDomains ?? []).some(d => parents(d).some(p => acceptSites.has(p))));
    check('accept, else decline: no block rule scoped to an accept site', blockLeak === undefined, JSON.stringify(blockLeak));
}
for ( const family of Object.keys(sitesFile.hide) ) {
    const shards = sitesFile.hide[family];
    check(`hide family ${family}: ${sets.COOKIE_NOTICE_HIDE_SHARDS} shards, each file present`, shards.length === sets.COOKIE_NOTICE_HIDE_SHARDS
        && shards.every((_, i) => fs.existsSync(path.join(ROOT, sets.cookieNoticeHideFile(family, i)))));
    check(`hide family ${family}: every site sits in the shard its hash names`, shards.every((list, i) => list.every(s => sets.cookieNoticeHideShardOf(s) === i)));
}
check('accept mode has no hide family and no block file', sets.COOKIE_NOTICE_MODE_FILES[A.ACCEPT].hideFamily === null && sets.COOKIE_NOTICE_MODE_FILES[A.ACCEPT].blocks === null);

// ── 3. Registration (real scripting-manager.js) ───────────────────────────────
console.log('--- 3. registration ---');
const ruleSite = sitesFile.scriptlets[A.DECLINE][0];
local.set(CONFIG.COOKIE_CLICKER_STORAGE_KEY, { [ruleSite]: [ { selector: '#x', enabled: true } ] });
const ruleSitePattern = `*://${ruleSite}/*`;
function own(id) { return id === sets.COOKIE_NOTICE_SCRIPTLET_CS_ID || id.startsWith(`${sets.COOKIE_NOTICE_HIDE_CS_ID}-`); }
async function runPass(mode, active) {
    config.securityConfig[CONFIG.SETTING_KEY] = mode;
    local.set(CONFIG.AUTO_DENY_STORAGE_KEY, { active });
    await sm.registerCookieClickerAutoDenyContentScripts();
    return registered.filter(r => own(r.id));
}
for ( const mode of [ A.DECLINE, PA, A.ACCEPT ] ) {
    const files = sets.COOKIE_NOTICE_MODE_FILES[mode];
    const regs = await runPass(mode, true);
    const scriptlet = regs.find(r => r.id === sets.COOKIE_NOTICE_SCRIPTLET_CS_ID);
    check(`${mode}: scriptlet registration = cookie library + this mode's file + end file, MAIN world, document_start`,
        JSON.stringify(scriptlet?.js) === JSON.stringify([ `/${sets.COOKIE_NOTICE_LIBRARY_FILE}`, `/${files.scriptlets}`, `/${sets.COOKIE_NOTICE_LIBRARY_END_FILE}` ])
        && scriptlet.world === 'MAIN' && scriptlet.runAt === 'document_start', JSON.stringify(scriptlet?.js));
    check(`${mode}: scriptlet registration matched to its own sites only`, scriptlet?.matches?.length > 0 && !scriptlet.matches.includes('<all_urls>'));
    const hides = regs.filter(r => r.id.startsWith(`${sets.COOKIE_NOTICE_HIDE_CS_ID}-`));
    if ( files.hideFamily === null ) {
        check(`${mode}: no hide registration`, hides.length === 0, String(hides.length));
    } else {
        check(`${mode}: hide shards registered from this mode's family, ISOLATED, through css-api.js`, hides.length > 0
            && hides.every(h => h.world === 'ISOLATED' && h.js[0] === '/js/scripting/css-api.js' && h.js[1].includes(`-hide-${files.hideFamily}-`)));
    }
    check(`${mode}: the saved clicker-rule site is excluded from every cookie-notice registration`, regs.every(r => (r.excludeMatches ?? []).includes(ruleSitePattern)));
    const blocks = sessionRules.filter(r => r.priority === 9200 && r.id >= 20_100_000);
    if ( files.blocks === null ) {
        check(`${mode}: no cookie-notice block rule`, blocks.length === 0, String(blocks.length));
    } else {
        const expected = JSON.parse(read(files.blocks)).length;
        check(`${mode}: the mode's block rules are session rules`, blocks.length === expected, `${blocks.length}/${expected}`);
        check(`${mode}: every block rule excludes the saved clicker-rule site`, blocks.every(r => r.condition.excludedInitiatorDomains?.includes(ruleSite)));
    }
}
{
    await runPass(A.DECLINE, true);
    const regs = await runPass(A.DECLINE, false);
    check('no session: every cookie-notice registration is released', regs.length === 0, String(regs.length));
    check('no session: every cookie-notice block rule is released', sessionRules.filter(r => r.id >= 20_100_000).length === 0);
}

console.log(failures === 0
    ? '\nPASS: cookie-notice sets are classified, built and registered as specified, and saved clicker rules prevail.'
    : `\nFINDINGS: ${failures} — the cookie-notice sets are not as specified.`);
process.exit(failures === 0 ? 0 : 1);
