#!/usr/bin/env node
// tools/test-ad-cleaner.mjs — (11.0.0) "Ad leftover cleaner", HARD check.
// What it is: js/data/ad-cleaner.js. Five parts:
//   1. Mirrors: the page script's copies (hash function, data global, keep message) equal their sources.
//   2. Build (pure, tools/build/ad-cleaner-sources.mjs): keyed / unkeyed split, extended and site rules dropped,
//      exceptions kept only for listed selectors.
//   3. Shipped data file: expected shape, a realistic size, every keyed selector filed under its own hash.
//   4. Page script (real js/scripting/ad-cleaner.js in JSDOM): hides only what really matches (EasyList exceptions
//      respected), reports it, Undo removes exactly what it inserted, Stop / leaving the page release the observer
//      and timers, a second launch replaces the first, buttons ignore untrusted clicks.
//   5. Routes (real js/workflow/ad-cleaner-routes.js, chrome mocked): launch injects data + scripts into frame 0 of an
//      http(s) tab with only this site's exceptions; keep saves only shipped, non-exempted selectors from this
//      extension's top-frame content script, under the sender's hostname.
//   6. Always hidden from now on (11.0.4, owner's request): after "Remove them" the saved selectors are hidden on every
//      later visit of that site — the page script is registered for it, a new page load gets the hiding CSS (also
//      after a service-worker restart, i.e. rebuilt from storage), and another site gets nothing.
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel.replace(/^\//, '')), 'utf8'); }

// ── Settings ──────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
    PAGE_SCRIPT: 'js/scripting/ad-cleaner.js',
    MIN_SHIPPED_RULES: 5000,
    HASH_SAMPLES: [ 'ad', 'AD_160', 'ad-container', 'sponsored-links', 'x', 'a-very-long-class-name-for-sampling-123' ],
    TAB_URL: 'https://www.example.com/article',
});

console.log('=== Ad leftover cleaner (11.0.0) ===');
let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if ( !ok ) { failures++; }
}
function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}\nA check that did not run has not passed.`);
    process.exit(1);
}

let ac, src, msgs, JSDOM;
try {
    ac = await import(path.join(ROOT, 'js/data/ad-cleaner.js'));
    src = await import(path.join(ROOT, 'tools/build/ad-cleaner-sources.mjs'));
    msgs = await import(path.join(ROOT, 'js/data/message-types.js'));
    ({ JSDOM } = await import('jsdom'));
} catch ( err ) {
    didNotRun(`cannot import the modules under test (${err.message})`);
}
const pageSource = read(CONFIG.PAGE_SCRIPT);

// ── 1. Mirrors ────────────────────────────────────────────────────────────────
console.log('--- 1. mirrors ---');
const hashSrc = /function adCleanerHash\(type, s\) \{[\s\S]*?\n\}/.exec(pageSource);
if ( hashSrc === null ) { didNotRun('adCleanerHash() not found in the page script'); }
const pageHash = new Function(`${hashSrc[0]}; return adCleanerHash;`)();
const T = ac.AD_CLEANER_HASH_TYPES;
const hashOk = CONFIG.HASH_SAMPLES.every(s => pageHash(T.ID, s) === ac.adCleanerHash(T.ID, s) && pageHash(T.CLASS, s) === ac.adCleanerHash(T.CLASS, s));
check('page script hash = js/data/ad-cleaner.js hash', hashOk);
check('page script data global = AD_CLEANER_DATA_GLOBAL', pageSource.includes(`const AD_CLEANER_DATA_GLOBAL = '${ac.AD_CLEANER_DATA_GLOBAL}';`));
check('page script keep message = MSG_AD_CLEANER_KEEP', pageSource.includes(`const MSG_KEEP = '${msgs.MSG_AD_CLEANER_KEEP}';`));
check('page script hash seeds = AD_CLEANER_HASH_TYPES', pageSource.includes(`HASH_TYPE_ID = 0x${T.ID.toString(16)};`) && pageSource.includes(`HASH_TYPE_CLASS = 0x${T.CLASS.toString(16).toUpperCase()};`));

// ── 2. Build (pure) ───────────────────────────────────────────────────────────
console.log('--- 2. build ---');
const sample = src.adCleanerDataFromText([
    '! comment', '###ad-top', '##.sponsor-box > div', '##[data-ad-slot]', '##.promo:has(img)', 'site.com##.local-ad',
    '##.sponsor-box > div', '##.esc\\:aped',
].join('\n'), [ 'news.com,www.blog.org#@##ad-top', 'other.com#@#.not-in-list', 'bad host#@##ad-top' ].join('\n'));
const c = sample.counts;
check('keyed / unkeyed split', c.keyed === 2 && c.unkeyed === 2, JSON.stringify(c));
check('extended (:has) and site rules dropped, duplicate counted', c.extended === 1 && c.withSite === 1 && c.duplicate === 1);
const topHash = String(ac.adCleanerHash(T.ID, 'ad-top'));
check('#ad-top filed under its hash', sample.hashes[topHash]?.includes('#ad-top') === true);
check('escaped token left unkeyed', sample.unkeyed.includes('.esc\\:aped'));
check('exceptions only for listed selectors and valid hostnames',
    JSON.stringify(sample.exceptions) === JSON.stringify({ 'news.com': [ '#ad-top' ], 'www.blog.org': [ '#ad-top' ] }), JSON.stringify(sample.exceptions));
check('exceptions apply to subdomains', ac.adCleanerExceptionsFor('m.news.com', sample.exceptions).includes('#ad-top')
    && ac.adCleanerExceptionsFor('blog.org', sample.exceptions).length === 0);

// (11.0.0, owner) Several hide lists and exception lists combine; whole-site exceptions only when they cover the page.
const multi = src.adCleanerDataFromText([ '##.one\n##.shared', '##.shared\n##iframe[width="728"][height="90"]' ], [
    'a.com#@#iframe[width="728"][height="90"]',                // exception from the second source, for a selector of the second list
    '@@||broken.com^$generichide',                               // whole site
    '@@||broken2.com^$elemhide,jsinject,extension,content',      // whole site
    '@@||xhr-only.com^$xmlhttprequest,elemhide',                 // only XHRs -> not the page
    '@@||cancelled.com^$generichide,badfilter',                  // cancelled
    '@@||path.com/sub/$elemhide',                                // a path -> not the whole site
    '@@||header.com^$elemhide,header=Set-Cookie:/x/',            // narrowed -> skipped
]);
check('several lists combine, duplicates across lists counted once', multi.counts.kept === 3 && multi.counts.duplicate === 1);
check('an exception from either source covers the combined list', multi.exceptions['a.com']?.[0] === 'iframe[width="728"][height="90"]');
check('whole-site exceptions: only page-wide, uncancelled, unnarrowed rules',
    JSON.stringify(multi.exemptSites) === JSON.stringify([ 'broken.com', 'broken2.com' ]), JSON.stringify(multi.exemptSites));
check('whole-site exception covers subdomains', ac.isAdCleanerSiteExempt('www.broken.com', multi.exemptSites)
    && ac.isAdCleanerSiteExempt('notbroken.com', multi.exemptSites) === false);
check('three hide lists and two exception lists are configured', src.AD_CLEANER_SOURCES.hide.length === 3 && src.AD_CLEANER_SOURCES.allow.length === 2
    && src.AD_CLEANER_SOURCES.hide.every(s => s.minKept > 0));

// ── 3. Shipped data file ──────────────────────────────────────────────────────
console.log('--- 3. shipped data ---');
let shipped;
try { shipped = JSON.parse(read(ac.AD_CLEANER_DATA_FILE)); } catch ( err ) { didNotRun(`${ac.AD_CLEANER_DATA_FILE} not readable (${err.message})`); }
check('data file has the expected shape and version', ac.isAdCleanerData(shipped));
check(`data file holds a realistic list (>= ${CONFIG.MIN_SHIPPED_RULES})`, shipped.counts?.kept >= CONFIG.MIN_SHIPPED_RULES, String(shipped.counts?.kept));
check('data file holds the AdGuard banner-size rules and whole-site exceptions',
    shipped.unkeyed.includes('iframe[width="728"][height="90"]') && shipped.exemptSites.length > 0);
let misfiled = 0;
for ( const [ hash, list ] of Object.entries(shipped.hashes) ) {
    for ( const s of list ) {
        const k = ac.adCleanerKeyOf(s);
        if ( k === null || String(ac.adCleanerHash(k.type, k.token)) !== hash ) { misfiled++; }
    }
}
check('every keyed selector is filed under its own hash', misfiled === 0, `${misfiled} misfiled`);

// ── 4. Page script in JSDOM ───────────────────────────────────────────────────
console.log('--- 4. page script ---');
function makePage(html) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: CONFIG.TAB_URL, runScripts: 'outside-only' });
    const w = dom.window;
    const sent = [];
    const inserted = [];
    const roots = [];
    const timers = new Set();
    const origSet = w.setTimeout.bind(w);
    const origClear = w.clearTimeout.bind(w);
    w.setTimeout = (fn, ms) => { const id = origSet(( ) => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
    w.clearTimeout = id => { timers.delete(id); origClear(id); };
    const clickHandlers = [];   // JSDOM cannot fake isTrusted: record the handlers, call them with a trusted-shaped event
    const origAdd = w.EventTarget.prototype.addEventListener;
    w.EventTarget.prototype.addEventListener = function(type, fn, opts) {
        if ( type === 'click' ) { clickHandlers.push(fn); }
        return origAdd.call(this, type, fn, opts);
    };
    const origAttach = w.Element.prototype.attachShadow;
    w.Element.prototype.attachShadow = function(opts) { const r = origAttach.call(this, { ...opts, mode: 'open' }); roots.push(r); return r; };
    w.chrome = { runtime: { id: 'test-extension-id', sendMessage: async msg => { sent.push(msg); return msg.what === msgs.MSG_AD_CLEANER_KEEP ? { ok: true } : undefined; } } };
    w.cssAPI = { insert: css => inserted.push(css) };
    w.console = { info() {}, warn() {}, log() {}, error() {} };
    return { dom, w, sent, inserted, roots, timers, clickHandlers };
}
function launch(page, exceptions = []) {
    page.w[ac.AD_CLEANER_DATA_GLOBAL] = { hashes: shipped.hashes, unkeyed: shipped.unkeyed, exceptions };
    page.w.eval(pageSource);
}
function panelText(page) { return page.roots.at(-1)?.querySelector('.message')?.textContent ?? ''; }
function click(page, action, trusted = true) {
    const btn = page.roots.at(-1)?.querySelector(`button[data-action="${action}"]`);
    if ( !btn ) { return false; }
    if ( trusted === false ) { btn.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true })); return true; }   // real event: isTrusted false
    page.clickHandlers.at(-1)({ isTrusted: true, target: btn });
    return true;
}
function tick(ms) { return new Promise(r => setTimeout(r, ms)); }
const knownKeyed = Object.values(shipped.hashes).flat().find(s => /^#[\w-]+$/.test(s));
const knownUnkeyed = shipped.unkeyed.find(s => /^\[[\w-]+\]$/.test(s));
if ( !knownKeyed || !knownUnkeyed ) { didNotRun('no simple sample selectors found in the shipped list'); }
const keyedId = knownKeyed.slice(1);
const unkeyedAttr = knownUnkeyed.slice(1, -1);
try {
    const page = makePage(`<div id="${keyedId}">ad</div><div ${unkeyedAttr}>ad2</div><p class="article">text</p>`);
    launch(page);
    const css = page.inserted.join('\n');
    check('hides a keyed match and an unkeyed match', css.includes(knownKeyed) && css.includes(knownUnkeyed), css.slice(0, 120));
    check('hides nothing that is not on the page', page.inserted.join('').split(',').length <= 4);
    check('panel reports the count', panelText(page) === 'Found 2 ad leftovers.', panelText(page));
    check('untrusted click is ignored', click(page, 'stop', false) && page.timers.size > 0);
    click(page, 'undo');
    const removed = page.sent.filter(m => m.what === 'removeCSS').map(m => m.css);
    check('Undo removes exactly what was inserted', JSON.stringify(removed) === JSON.stringify(page.inserted));
    check('Undo releases every timer and the panel', page.timers.size === 0 && page.w.document.querySelector('[popover]') === null);

    const exc = makePage(`<div id="${keyedId}">ad</div>`);
    launch(exc, [ knownKeyed ]);
    check('an EasyList exception for this site is respected', exc.inserted.length === 0 && panelText(exc) === 'No ad leftovers found.', panelText(exc));
    click(exc, 'stop');
    check('Stop releases every timer', exc.timers.size === 0);
    click(exc, 'close');
    check('Close removes the panel', exc.w.document.querySelector('[popover]') === null);

    const re = makePage(`<div id="${keyedId}">ad</div>`);
    launch(re);
    launch(re);
    const removedOnRelaunch = re.sent.filter(m => m.what === 'removeCSS').length;
    check('a second launch replaces the first (undo + one panel)', removedOnRelaunch === 1 && re.w.document.querySelectorAll('[popover]').length === 1);
    click(re, 'keep');
    await tick(10);
    const keep = re.sent.find(m => m.what === msgs.MSG_AD_CLEANER_KEEP);
    check('Keep sends only the matched selectors', JSON.stringify(keep?.selectors) === JSON.stringify([ knownKeyed ]));
    check('Keep ends the run and says so', re.timers.size === 0 && panelText(re) === 'Removed on this site from now on.', panelText(re));

    const late = makePage('<p>start</p>');
    launch(late);
    const el = late.w.document.createElement('div');
    el.id = keyedId;
    late.w.document.body.appendChild(el);
    await tick(150);
    check('catches a leftover added after the start', late.inserted.join('').includes(knownKeyed));
    late.w.dispatchEvent(new late.w.Event('pagehide'));
    check('leaving the page releases timers and panel', late.timers.size === 0 && late.w.document.querySelector('[popover]') === null);

    const ex = makePage(`<div id="${keyedId}">ad</div>`);
    ex.w[ac.AD_CLEANER_DATA_GLOBAL] = { exempt: true, hashes: {}, unkeyed: [], exceptions: [] };
    ex.w.eval(pageSource);
    check('a whole-site-exempt site: says so, hides nothing, holds nothing',
        panelText(ex) === 'Not used on this website: it is known to break it.' && ex.inserted.length === 0 && ex.timers.size === 0, panelText(ex));
    ex.w.close();

    const none = makePage('<p>x</p>');
    none.w.cssAPI = { insert() {} };
    none.w.eval(pageSource);   // no data global
    check('without data: says it could not run, holds nothing', panelText(none) === 'Could not run here.' && none.timers.size === 0);
    for ( const p of [ page, exc, re, late, none ] ) { p.w.close(); }
} catch ( err ) {
    didNotRun(`page script failed in JSDOM (${err.stack})`);
}

// ── 5. Routes ─────────────────────────────────────────────────────────────────
console.log('--- 5. routes ---');
const local = new Map();
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
const injected = [];
const registered = [];   // section 6: content scripts registered
const insertedCss = [];  // section 6: CSS inserted into a page
let tabUrl = CONFIG.TAB_URL;
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
        getRegisteredContentScripts: async () => [], registerContentScripts: async d => { registered.push(...d); }, updateContentScripts: async d => { registered.push(...d); },
        unregisterContentScripts: async () => {}, executeScript: async d => { injected.push(d); return []; },
        insertCSS: async d => { insertedCss.push(d); },
    },
    tabs: { query: async () => [], get: async () => ({ url: tabUrl }), sendMessage: async () => {} },
    permissions: { contains: async () => true, getAll: async () => ({ origins: [ '<all_urls>' ] }) },
    action: { setIcon() {}, setBadgeText() {}, setTitle() {}, setBadgeBackgroundColor() {} },
    alarms: { create() {}, clear: async () => true, get: async () => undefined, onAlarm: { addListener() {} } },
};
globalThis.fetch = async url => ({ json: async () => JSON.parse(read(String(url))), text: async () => read(String(url)) });
try {
    const routes = await import(path.join(ROOT, 'js/workflow/ad-cleaner-routes.js'));
    const exceptionSite = Object.keys(shipped.exceptions)[0];
    const exceptionSelector = shipped.exceptions[exceptionSite][0];

    tabUrl = `https://${exceptionSite}/`;
    const r = await routes.handleAdCleanerLaunch({ tabId: 7 });
    const [ first, second ] = injected;
    check('launch: ok, data first then scripts, both into frame 0 only', r.ok === true && first?.func !== undefined
        && JSON.stringify(second?.files) === JSON.stringify(ac.AD_CLEANER_SCRIPT_FILES)
        && first.target.frameIds?.[0] === 0 && second.target.frameIds?.[0] === 0);
    check('launch: only this site\'s exceptions are passed', first?.args?.[1]?.exceptions.includes(exceptionSelector)
        && first.args[1].exceptions.length === shipped.exceptions[exceptionSite].length);
    injected.length = 0;
    tabUrl = 'chrome://extensions/';
    check('launch: refused on a non-web page', (await routes.handleAdCleanerLaunch({ tabId: 7 })).ok === false && injected.length === 0);
    check('launch: refused without a tab id', (await routes.handleAdCleanerLaunch({})).ok === false);

    const sender = { id: 'test', frameId: 0, url: CONFIG.TAB_URL, tab: { url: CONFIG.TAB_URL } };
    const ok = await routes.handleAdCleanerKeep({ selectors: [ knownKeyed ] }, sender);
    check('keep: saves a shipped selector under the sender\'s hostname', ok.ok === true && local.get('site.www.example.com')?.includes(knownKeyed) === true,
        JSON.stringify(local.get('site.www.example.com')));
    // ── 6. Always hidden from now on ───────────────────────────────────────────
    console.log('--- 6. always hidden from now on ---');
    const SITE = new URL(CONFIG.TAB_URL).hostname;
    const OTHER_SITE = 'www.another-site.org';
    const userScript = registered.find(d => d.id === 'css-user');
    check('after Remove them: the page script is registered for this site',
        userScript?.js?.includes('/js/scripting/css-user.js') === true && userScript.matches.some(m => m.includes(SITE)),
        JSON.stringify(userScript?.matches));
    check('after Remove them: the page script is not registered for another site',
        userScript?.matches.some(m => m.includes(OTHER_SITE)) === false);
    const fm = await import(path.join(ROOT, 'js/core/filter-manager.js'));
    async function cssOnNextVisit(manager, hostname) {
        insertedCss.length = 0;
        await manager.injectCustomFilters(7, 0, hostname);
        return insertedCss.map(d => d.css).join('');
    }
    function hides(css) { return css.includes(knownKeyed) && css.includes('{display:none!important;}'); }
    const next = await cssOnNextVisit(fm, SITE);
    check('next visit of this site: the leftover is hidden', hides(next), next.slice(0, 120));
    check('next visit of another site: nothing is hidden', await cssOnNextVisit(fm, OTHER_SITE) === '');
    // A fresh module instance = a service-worker restart: the index is rebuilt from storage alone.
    const fmRestarted = await import(`${path.join(ROOT, 'js/core/filter-manager.js')}?sw-restart`);
    const afterRestart = await cssOnNextVisit(fmRestarted, SITE);
    check('after a service-worker restart: still hidden on this site', hides(afterRestart), afterRestart.slice(0, 120));

    check('keep: refuses a selector not in the list', (await routes.handleAdCleanerKeep({ selectors: [ 'body' ] }, sender)).ok === false);
    check('keep: refuses another extension', (await routes.handleAdCleanerKeep({ selectors: [ knownKeyed ] }, { ...sender, id: 'other' })).ok === false);
    check('keep: refuses a sub-frame', (await routes.handleAdCleanerKeep({ selectors: [ knownKeyed ] }, { ...sender, frameId: 3 })).ok === false);
    check('keep: refuses too many', (await routes.handleAdCleanerKeep({ selectors: Array(ac.AD_CLEANER_KEEP_MAX + 1).fill(knownKeyed) }, sender)).ok === false);
    const exemptSite = shipped.exemptSites[0];
    injected.length = 0;
    tabUrl = `https://www.${exemptSite}/`;
    await routes.handleAdCleanerLaunch({ tabId: 7 });
    check('launch on an exempt site: no list is sent, the page is told why', injected[0]?.args?.[1]?.exempt === true
        && Object.keys(injected[0].args[1].hashes).length === 0);
    const exemptSender = { ...sender, url: `https://${exemptSite}/`, tab: { url: `https://${exemptSite}/` } };
    check('keep: refused on an exempt site', (await routes.handleAdCleanerKeep({ selectors: [ knownKeyed ] }, exemptSender)).ok === false);
    const exSender = { ...sender, url: `https://${exceptionSite}/`, tab: { url: `https://${exceptionSite}/` } };
    check('keep: refuses a selector EasyList exempts on this site', (await routes.handleAdCleanerKeep({ selectors: [ exceptionSelector ] }, exSender)).ok === false);
} catch ( err ) {
    didNotRun(`routes failed (${err.stack})`);
}

console.log(failures === 0 ? 'PASS' : `FINDINGS: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
