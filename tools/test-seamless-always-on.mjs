#!/usr/bin/env node
// tools/test-seamless-always-on.mjs — (11.0.0) Seamless surfing is always on; only advanced users can turn it off. HARD.
// What it is: js/data/seamless-switch.js. Four parts:
//   1. Mirrors + default: the prompt's copies equal their sources; the setting defaults ON; a saved value of the removed
//      startup option does not carry over (everyone updating is on).
//   2. Routes (real cookie-clicker-routes.js / security-routes.js / session manager, chrome mocked): "off" is refused in
//      simple mode and accepted in advanced mode (session stopped); picking a mode turns it back on (session running);
//      the off switch through setSecurityConfig needs advanced mode; switching to simple mode turns it back on in
//      "accept, else decline"; an "on" for a running session keeps it as it is.
//   3. Service worker wiring (static): browser start switches it back on (off lasts one browser session) and starts it;
//      install / update applies the switch.
//   4. Prompt (real js/scripting/worry-free-picker.js in JSDOM): the off choice and its line only for advanced users;
//      one explanation line per option; the "change it later" line fits the mode; the launch flag is cleared.
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel.replace(/^\//, '')), 'utf8'); }

// ── Settings ──────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
    PROMPT: 'js/scripting/worry-free-picker.js',
    RETIRED_STARTUP_KEY: 'startWorryFreeOnBrowserStartup',
    SESSION_STORAGE_KEY_RE: /autoDeny|autodeny/i,
});

console.log('=== Seamless surfing always on (11.0.0) ===');
let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if ( !ok ) { failures++; }
}
function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}\nA check that did not run has not passed.`);
    process.exit(1);
}

// ── chrome mock ───────────────────────────────────────────────────────────────
const local = new Map();
function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
function mkArea(store) { return {
    get: async keys => {
        if ( keys === null || keys === undefined ) { return Object.fromEntries(store); }
        const names = typeof keys === 'string' ? [ keys ] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(names.filter(k => store.has(k)).map(k => [ k, clone(store.get(k)) ]));
    },
    set: async obj => { for ( const [ k, v ] of Object.entries(obj) ) { store.set(k, clone(v)); } },
    remove: async keys => { for ( const k of (typeof keys === 'string' ? [ keys ] : keys) ) { store.delete(k); } },
    clear: async () => { store.clear(); },
    setAccessLevel: async () => {},
}; }
globalThis.self = globalThis;
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '11.0.0' }), getURL: p => p, lastError: null, id: 'test', onMessage: { addListener() {} } },
    storage: { local: mkArea(local), session: mkArea(new Map()), onChanged: { addListener() {} } },
    declarativeNetRequest: {
        updateDynamicRules: async () => {}, getDynamicRules: async () => [], getSessionRules: async () => [],
        updateSessionRules: async () => {}, updateEnabledRulesets: async () => {}, getEnabledRulesets: async () => [],
        isRegexSupported: async () => ({ isSupported: true }),
    },
    scripting: {
        getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, updateContentScripts: async () => {},
        unregisterContentScripts: async () => {}, executeScript: async () => [],
    },
    tabs: { query: async () => [], get: async () => ({}), sendMessage: async () => {} },
    permissions: { contains: async () => true, getAll: async () => ({ origins: [ '<all_urls>' ] }) },
    action: { setIcon() {}, setBadgeText() {}, setTitle() {}, setBadgeBackgroundColor() {} },
    alarms: { create() {}, clear: async () => true, get: async () => undefined, onAlarm: { addListener() {} } },
};
globalThis.fetch = async url => ({ json: async () => JSON.parse(read(String(url))), text: async () => read(String(url)) });

let sw, pt, cfg, routes, sec, mgr, JSDOM;
try {
    sw = await import(path.join(ROOT, 'js/data/seamless-switch.js'));
    pt = await import(path.join(ROOT, 'js/data/power-tools.js'));
    cfg = await import(path.join(ROOT, 'js/data/config.js'));
    routes = await import(path.join(ROOT, 'js/workflow/cookie-clicker-routes.js'));
    sec = await import(path.join(ROOT, 'js/workflow/security-routes.js'));
    mgr = await import(path.join(ROOT, 'js/core/cookie-clicker-autodeny-manager.js'));
    ({ JSDOM } = await import('jsdom'));
} catch ( err ) {
    didNotRun(`cannot import the modules under test (${err.stack})`);
}
const KEY = sw.SEAMLESS_ENABLED_SETTING_KEY;
const ADV = pt.POWER_TOOLS_SETTING_KEY;
const S = cfg.securityConfig;
async function running() { return (await mgr.getAutoDenyState())?.active === true; }

// ── 1. Mirrors + default ──────────────────────────────────────────────────────
console.log('--- 1. mirrors + default ---');
const prompt = read(CONFIG.PROMPT);
check('prompt off choice = SEAMLESS_OFF_ACTION', prompt.includes(`action: '${sw.SEAMLESS_OFF_ACTION}'`));
check('prompt launch flag = SEAMLESS_PROMPT_OFFER_OFF_GLOBAL', prompt.includes(`const OFFER_OFF_GLOBAL = '${sw.SEAMLESS_PROMPT_OFFER_OFF_GLOBAL}';`));
check('default is ON', S[KEY] === true && sw.isSeamlessSurfingEnabled({}) && sw.isSeamlessSurfingEnabled({ [KEY]: false }) === false);
local.set('securityConfig', { [CONFIG.RETIRED_STARTUP_KEY]: false, [ADV]: true });
await cfg.loadRulesetConfig();
check('a saved "startup off" does not carry over: on after the update', S[KEY] === true && Object.hasOwn(S, CONFIG.RETIRED_STARTUP_KEY) === false);

// ── 2. Routes ─────────────────────────────────────────────────────────────────
console.log('--- 2. routes ---');
try {
    await mgr.startAutoDeny();
    S[ADV] = false;
    await routes.handleCookieClickerAutoDenyStart({ cookieBannerAction: 'off' }, {});
    check('simple mode: "off" refused, session keeps running', S[KEY] === true && await running());
    await sec.handleSetSecurityConfig({ key: KEY, value: false });
    check('simple mode: off through setSecurityConfig refused', S[KEY] === true && await running());

    S[ADV] = true;
    await routes.handleCookieClickerAutoDenyStart({ cookieBannerAction: 'off' }, {});
    check('advanced: "off" turns it off and stops the session', S[KEY] === false && await running() === false
        && local.get('securityConfig')?.[KEY] === false);
    await routes.handleCookieClickerAutoDenyStart({ cookieBannerAction: 'decline' }, {});
    check('picking a mode turns it back on and starts the session', S[KEY] === true && await running() && S.seamlessCookieBannerAction === 'decline');

    await sec.handleSetSecurityConfig({ key: KEY, value: false });
    check('advanced: off through setSecurityConfig stops the session', S[KEY] === false && await running() === false);
    await sec.handleSetSecurityConfig({ key: ADV, value: false });
    check('switching to simple mode turns it back on, in "accept, else decline", running', S[KEY] === true && await running()
        && S.seamlessCookieBannerAction === 'prefer-accept');

    const before = (await mgr.getAutoDenyState()).startedAtMs;
    await mgr.applySeamlessSwitch(true);
    check('"on" for a running session keeps it as it is', (await mgr.getAutoDenyState()).startedAtMs === before);
    const get = await routes.handleCookieClickerAutoDenyGet();
    check('the popup state carries seamlessEnabled', get.seamlessEnabled === true);
} catch ( err ) {
    didNotRun(`routes failed (${err.stack})`);
}

// ── 3. Service worker wiring ──────────────────────────────────────────────────
console.log('--- 3. service worker wiring ---');
const bg = read('js/workflow/background.js');
check('browser start: an advanced user\'s "off" is reset (off lasts one browser session), then the session starts',
    /await clearAutoDenyOnBrowserStartup\(\);[\s\S]{0,600}if \( isSeamlessSurfingEnabled\(securityConfig\) === false \) \{\s*securityConfig\[SEAMLESS_ENABLED_SETTING_KEY\] = true;\s*await saveSecurityConfig\(\);\s*\}\s*await startAutoDeny\(\);/.test(bg));
check('install / update: the switch is applied', /onInstalled\.addListener[\s\S]{0,400}applySeamlessSwitch\(isSeamlessSurfingEnabled\(securityConfig\)\)/.test(bg));
check('restoring a backup applies the switch', /applySeamlessSwitch\(isSeamlessSurfingEnabled\(securityConfig\)\)/.test(read('js/workflow/settings-routes.js')));

// ── 4. Prompt ─────────────────────────────────────────────────────────────────
console.log('--- 4. prompt ---');
function renderPrompt(advanced) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/', runScripts: 'outside-only' });
    const w = dom.window;
    const roots = [];
    const orig = w.Element.prototype.attachShadow;
    w.Element.prototype.attachShadow = function(o) { const r = orig.call(this, { ...o, mode: 'open' }); roots.push(r); return r; };
    w.chrome = { runtime: { sendMessage: async () => {} } };
    w[sw.SEAMLESS_PROMPT_OFFER_OFF_GLOBAL] = advanced;
    w.eval(prompt);
    const root = roots[0];
    const out = {
        actions: [ ...root.querySelectorAll('button.choice') ].map(b => b.dataset.action),
        lines: [ ...root.querySelectorAll('.explanation-lines .explanation-intro') ].map(p => p.textContent),
        flagCleared: w[sw.SEAMLESS_PROMPT_OFFER_OFF_GLOBAL] === undefined,
    };
    w.close();
    return out;
}
try {
    const adv = renderPrompt(true);
    const simple = renderPrompt(false);
    check('advanced: four choices, the off choice last', JSON.stringify(adv.actions) === JSON.stringify([ 'prefer-accept', 'accept', 'decline', 'off' ]), adv.actions.join(','));
    check('simple: three choices, no off', JSON.stringify(simple.actions) === JSON.stringify([ 'prefer-accept', 'accept', 'decline' ]), simple.actions.join(','));
    // The owner's own wording (2026-11-19): one line per shown option, then the Cookie consent clicker line.
    check('one explanation line per shown option, then the Cookie consent clicker line', adv.lines.length === 5 && simple.lines.length === 4
        && /^Automate missed cookie prompts with the 'Cookie consent clicker'\.$/.test(adv.lines.at(-1)) && adv.lines.at(-1) === simple.lines.at(-1));
    check('advanced: the off line says "for this browser session" and how to activate again',
        adv.lines[3] === 'You can turn Seamless surfing off for this browser session. Click Seamless surfing in the toolbar popup to activate again.', adv.lines[3]);
    check('simple: no off line', simple.lines.every(l => /turn Seamless surfing off/.test(l) === false));
    check('the launch flag is cleared after reading', adv.flagCleared && simple.flagCleared);
} catch ( err ) {
    didNotRun(`prompt failed in JSDOM (${err.stack})`);
}

console.log(failures === 0 ? 'PASS' : `FINDINGS: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
