#!/usr/bin/env node
// tools/test-power-tools.mjs — (11.0.0) "I am an advanced user (unhide power tools)", HARD check.
// What it is: js/data/power-tools.js. Three parts:
//   1. Classification (C25-style, static): every popup tool line (popup/popup.html #goto*), every right-click menu id
//      (js/workflow/background.js CONTEXT_MENU_IDS) is classified power / always exactly once; the simple-mode tools
//      are never power tools; popup.js and background.js read the classification from power-tools.js (no copies); the
//      dashboard hides nothing (owner, second pass).
//   2. Default (real js/data/config.js, chrome mocked): a new install -> hidden; saved settings without the key (an
//      existing user) -> shown, and written back once; a saved explicit false stays false.
//   3. Untick (real js/workflow/security-routes.js): switching it off sets Seamless surfing to "accept, else decline";
//      switching it on leaves the mode alone; a non-boolean value is refused.
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
function JSON_CLONE(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }   // plain storage-value copy
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ── Settings ──────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
    NEVER_POWER_POPUP: [ 'gotoAdCleaner', 'gotoPicker', 'gotoCookieClicker', 'gotoSettingsDashboard' ],   // owner's decisions 2026-11-19
    NEVER_POWER_MENU:  [ 'uBolStrippedDynamic.adLeftoverCleaner', 'uBolStrippedDynamic.cosmeticElementPicker', 'uBolStrippedDynamic.cookieConsentClicker' ],
    POPUP_LINE_RE:     /<span id="(goto\w+)" class="menuItem/g,                     // popup/popup.html tool lines
    MENU_BLOCK_RE:     /const CONTEXT_MENU_IDS = Object\.freeze\(\{([\s\S]*?)\}\);/, // js/workflow/background.js
    MENU_VALUE_RE:     /'([^']+)'/g,
    SECURITY_KEY:      'securityConfig',                                           // chrome.storage.local key
});

console.log('=== Power tools option (11.0.0) ===');
let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if ( !ok ) { failures++; }
}
function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}\nA check that did not run has not passed.`);
    process.exit(1);
}

// ── chrome mock (storage only is used by the modules under test) ──────────────
const local = new Map();
function mkArea(store) { return {
    get: async keys => {
        if ( keys === null || keys === undefined ) { return Object.fromEntries(store); }
        const names = typeof keys === 'string' ? [ keys ] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(names.filter(k => store.has(k)).map(k => [ k, JSON_CLONE(store.get(k)) ]));
    },
    set: async obj => { for ( const [ k, v ] of Object.entries(obj) ) { store.set(k, JSON_CLONE(v)); } },
    remove: async keys => { for ( const k of (typeof keys === 'string' ? [ keys ] : keys) ) { store.delete(k); } },
    clear: async () => { store.clear(); },
    setAccessLevel: async () => {},
}; }
const session = new Map();
globalThis.self = globalThis;
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '11.0.0' }), getURL: p => p, lastError: null, id: 'test', onMessage: { addListener() {} } },
    storage: { local: mkArea(local), session: mkArea(session), onChanged: { addListener() {} } },
    declarativeNetRequest: {
        updateDynamicRules: async () => {}, getDynamicRules: async () => [],
        getSessionRules: async () => [], updateSessionRules: async () => {},
        updateEnabledRulesets: async () => {}, getEnabledRulesets: async () => [],
        isRegexSupported: async () => ({ isSupported: true }),
    },
    scripting: {
        getRegisteredContentScripts: async () => [], registerContentScripts: async () => {},
        updateContentScripts: async () => {}, unregisterContentScripts: async () => {}, executeScript: async () => [],
    },
    tabs: { query: async () => [], get: async () => ({}), sendMessage: async () => {} },
    permissions: { contains: async () => true, getAll: async () => ({ origins: [ '<all_urls>' ] }) },
    action: { setIcon() {}, setBadgeText() {}, setTitle() {}, setBadgeBackgroundColor() {} },
    alarms: { create() {}, clear: async () => true, get: async () => undefined, onAlarm: { addListener() {} } },
};
globalThis.fetch = async url => ({ json: async () => JSON.parse(read(String(url).replace(/^\//, ''))), text: async () => read(String(url).replace(/^\//, '')) });

let pt, action;
try {
    pt     = await import(path.join(ROOT, 'js/data/power-tools.js'));
    action = await import(path.join(ROOT, 'js/data/cookie-banner-action.js'));
} catch ( err ) {
    didNotRun(`cannot import the modules under test (${err.message})`);
}
const KEY = pt.POWER_TOOLS_SETTING_KEY;

// ── 1. Classification ─────────────────────────────────────────────────────────
console.log('--- 1. classification ---');
function classify(label, found, table, neverPower) {
    const all = [ ...table.power, ...table.always ];
    const unclassified = found.filter(id => !all.includes(id));
    const stale = all.filter(id => !found.includes(id));
    const twice = all.filter((id, i) => all.indexOf(id) !== i);
    check(`${label}: every item classified`, found.length !== 0 && unclassified.length === 0, unclassified.join(', '));
    check(`${label}: no classified item that does not exist`, stale.length === 0, stale.join(', '));
    check(`${label}: no item classified twice`, twice.length === 0, twice.join(', '));
    const wrong = neverPower.filter(id => table.power.includes(id) || !table.always.includes(id));
    check(`${label}: the simple-mode tools (Ad leftover cleaner, Cosmetic element picker, Cookie consent clicker, Settings) never hidden`, wrong.length === 0, wrong.join(', '));
}
const popupHtml = read('popup/popup.html');
const popupIds = [ ...popupHtml.matchAll(CONFIG.POPUP_LINE_RE) ].map(m => m[1]);
classify('popup', popupIds, pt.POPUP_TOOL_IDS, CONFIG.NEVER_POWER_POPUP);

const bg = read('js/workflow/background.js');
const menuBlock = bg.match(CONFIG.MENU_BLOCK_RE);
if ( menuBlock === null ) { didNotRun('CONTEXT_MENU_IDS not found in js/workflow/background.js'); }
const menuIds = [ ...menuBlock[1].matchAll(CONFIG.MENU_VALUE_RE) ].map(m => m[1]);
classify('context menu', menuIds, pt.CONTEXT_MENU_TOOL_IDS, CONFIG.NEVER_POWER_MENU);

// (11.0.0, owner — second pass) The dashboard always shows every tab: nothing there reads the option any more.
check('dashboard: no tab is hidden by the option', pt.DASHBOARD_PANES === undefined
    && /powerToolHidden/.test(read('dashboard/dashboard.js') + read('dashboard/dashboard.html') + read('dashboard/dashboard.css')) === false
    && /power-tools\.js/.test(read('dashboard/dashboard.js')) === false);

// (11.0.0, owner) The right-click menu lists its tools in the popup's order (C22: one order, two places).
const POPUP_TO_MENU = Object.freeze({
    gotoAdCleaner: 'AD_CLEANER', gotoPicker: 'PICKER', gotoCookieClicker: 'COOKIE_CLICKER',
    gotoMatrixPanel: 'DYNAMIC_FILTERING', gotoPrivacyInspector: 'PRIVACY_INSPECTOR',
});
const itemsBlock = bg.slice(bg.indexOf('const CONTEXT_MENU_ITEMS'), bg.indexOf('];', bg.indexOf('const CONTEXT_MENU_ITEMS')));
const menuOrder = [ ...itemsBlock.matchAll(/id: CONTEXT_MENU_IDS\.([A-Z_]+)/g) ].map(m => m[1]);
const popupOrder = popupIds.filter(id => Object.hasOwn(POPUP_TO_MENU, id)).map(id => POPUP_TO_MENU[id]);
check('right-click menu order = popup order', menuOrder.length !== 0 && JSON.stringify(menuOrder) === JSON.stringify(popupOrder),
    `menu ${menuOrder.join(',')} / popup ${popupOrder.join(',')}`);

const popupJs = read('popup/popup.js');
check('the Pause filtering control exists and is hidden with the power tools',
    popupHtml.includes(`id="${pt.POPUP_PAUSE_CONTROL_ID}"`) && /POPUP_PAUSE_CONTROL_ID/.test(read('popup/popup.js')));
check('popup.js reads POPUP_TOOL_IDS from power-tools.js', /from '\.\.\/js\/data\/power-tools\.js'/.test(popupJs) && popupJs.includes('POPUP_TOOL_IDS'));
check('background.js reads CONTEXT_MENU_TOOL_IDS from power-tools.js', /from '\.\.\/data\/power-tools\.js'/.test(bg) && bg.includes('CONTEXT_MENU_TOOL_IDS.power'));
const dashHtml = read('dashboard/dashboard.html');
check('Options holds the checkbox bound to the setting', dashHtml.includes(`data-setting="${KEY}"`));
check('arePowerToolsShown: only an explicit true shows', pt.arePowerToolsShown({ [KEY]: true }) === true
    && pt.arePowerToolsShown({}) === false && pt.arePowerToolsShown(undefined) === false && pt.arePowerToolsShown({ [KEY]: 'yes' }) === false);

// ── 2. Default (real config.js, one fresh module instance per case) ───────────
console.log('--- 2. default for new and existing users ---');
async function loadWith(saved, tag) {
    local.clear(); session.clear();
    if ( saved !== undefined ) { local.set(CONFIG.SECURITY_KEY, JSON_CLONE(saved)); }
    const cfg = await import(`${path.join(ROOT, 'js/data/config.js')}?case=${tag}`);
    await cfg.loadRulesetConfig();
    await new Promise(r => setTimeout(r, 0));   // let fire-and-forget writes land
    return { live: cfg.securityConfig[KEY], stored: local.get(CONFIG.SECURITY_KEY)?.[KEY] };
}
try {
    const fresh = await loadWith(undefined, 'new');
    check('new install: hidden', fresh.live === false && fresh.stored === false, JSON.stringify(fresh));
    const existing = await loadWith({ seamlessCookieBannerAction: 'decline' }, 'existing');
    check('existing user (key absent): shown, and saved once', existing.live === true && existing.stored === true, JSON.stringify(existing));
    const keptOff = await loadWith({ [KEY]: false }, 'off');
    check('saved explicit off stays off', keptOff.live === false, JSON.stringify(keptOff));
    const keptOn = await loadWith({ [KEY]: true }, 'on');
    check('saved explicit on stays on', keptOn.live === true, JSON.stringify(keptOn));
} catch ( err ) {
    didNotRun(`config.js load failed (${err.message})`);
}

// ── 3. Untick switches Seamless surfing to "accept, else decline" ─────────────
console.log('--- 3. untick ---');
try {
    local.clear(); session.clear();
    const cfg = await import(path.join(ROOT, 'js/data/config.js'));
    const routes = await import(path.join(ROOT, 'js/workflow/security-routes.js'));
    const A = action.COOKIE_BANNER_ACTIONS;
    const MODE = action.COOKIE_BANNER_SETTING_KEY;
    cfg.securityConfig[MODE] = A.DECLINE;
    cfg.securityConfig[KEY] = true;
    await routes.handleSetSecurityConfig({ key: KEY, value: false });
    check('untick: mode becomes "accept, else decline"', cfg.securityConfig[MODE] === A.PREFER_ACCEPT, cfg.securityConfig[MODE]);
    check('untick: saved', local.get(CONFIG.SECURITY_KEY)?.[MODE] === A.PREFER_ACCEPT && local.get(CONFIG.SECURITY_KEY)?.[KEY] === false);
    cfg.securityConfig[MODE] = A.ACCEPT;
    await routes.handleSetSecurityConfig({ key: KEY, value: true });
    check('tick: mode left alone', cfg.securityConfig[MODE] === A.ACCEPT, cfg.securityConfig[MODE]);
    const temp = await import(path.join(ROOT, 'js/core/temp-disable-manager.js'));
    cfg.securityConfig[KEY] = true;
    await temp.startTempDisableUntilRestart();
    const pausedBefore = (await temp.getTempDisableState())?.active === true;
    await routes.handleSetSecurityConfig({ key: KEY, value: false });
    check('untick: a running pause is ended', pausedBefore && (await temp.getTempDisableState())?.active !== true);
    cfg.securityConfig[KEY] = true;
    cfg.securityConfig[MODE] = A.ACCEPT;
    await routes.handleSetSecurityConfig({ key: KEY, value: 'false' });
    check('non-boolean value refused', cfg.securityConfig[KEY] === true && cfg.securityConfig[MODE] === A.ACCEPT);
} catch ( err ) {
    didNotRun(`security-routes.js failed (${err.message})`);
}

console.log(failures === 0 ? 'PASS' : `FINDINGS: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
