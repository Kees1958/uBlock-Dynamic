#!/usr/bin/env node
// tools/test-tab-under-guard.mjs — (10.7.2) pop-up / pop-under handling and the block page, against the REAL modules
// (Part D step 15), with only the browser APIs mocked:
//   1. parser (js/util/popunder-parser.js): prevent-popunder in AdGuard and uBO form (incl. the build's "ubo-" alias),
//      every rejection reason, $popup/$popunder recognised as unsupported, extract/remaining text
//   2. name guard: no AdGuard/uBO scriptlet called prevent-popunder exists (it would clash with uBD's own meaning)
//   3. Import ABP editor (js/core/custom-scriptlets.js syncScriptletRulesFromSandboxText): a valid prevent-popunder line
//      is kept and NOT registered as an injectable scriptlet; a bad one and a $popup line are commented out with
//      "! Rejected:" beneath them; the compiler input (compiled-filters.js) keeps both kinds out
//   4. carriers (js/core/popunder-carriers.js): build → read round trip, inert, never confused with the $worryfree
//      carrier; the build picks the lines out before parsing
//   5. tab-under guard (js/core/tab-under-guard.js): send-back with both channels, subdomains, no action for another
//      site / host / sub-frame, site-mode gate, loop guard, release, restart survival, LIGHT WAKE-UP PATH (entries read
//      from storage.session without the startup loaders), isTabBeingSentBack()
//   6. block page (js/core/block-page.js): a blocked top-frame load is sent to blocked/blocked.html?host=…; not for a
//      sub-frame, another error, or a tab the guard is sending back; the page is NOT web-accessible; (11.1.6) not for
//      a page whose filtering is OFF (site switched off, global pause) — but still for a site pinned ON during a pause
//
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');
console.log('=== Pop-up / pop-under handling and block page (10.7.2 branch, merged 10.7.5) ===');

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}
const findings = [];
function expect(cond, msg) { if ( !cond ) { findings.push(msg); } }
function modUrl(rel, tag = '') { return pathToFileURL(path.join(ROOT, rel)).href + tag; }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

// ── Browser mock ─────────────────────────────────────────────────────────────────
const localStore = new Map();
const sessionStore = new Map();
const updates = [];
const removals = [];   // (10.7.5) tabs.remove calls (blocked popup closer)
const navListeners = {};   // (10.7.5) webNavigation event name → listeners
let shippedRules = [];
function mkArea(store) { return {
    get: async keys => {
        if ( keys === null ) { return Object.fromEntries(store); }
        const names = typeof keys === 'string' ? [ keys ] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
        return Object.fromEntries(names.filter(k => store.has(k)).map(k => [ k, clone(store.get(k)) ]));
    },
    set: async obj => { for ( const [ k, v ] of Object.entries(obj) ) { store.set(k, clone(v)); } },
    remove: async keys => { for ( const k of (typeof keys === 'string' ? [ keys ] : keys) ) { store.delete(k); } },
}; }
globalThis.self = globalThis;
// (11.1.6) mode-manager.js broadcasts each mode change; a real channel would keep Node running after the test
globalThis.BroadcastChannel = class { postMessage() {} close() {} };
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => `chrome-extension://test${p}`, lastError: null, id: 'test' },
    storage: { local: mkArea(localStore), session: mkArea(sessionStore) },
    tabs: {
        update: async (tabId, props) => { updates.push({ tabId, url: props.url }); return {}; },
        remove: async tabId => { removals.push(tabId); },
        onRemoved: { addListener: () => {} },
        TAB_ID_NONE: -1,
    },
    // (11.1.6) the block page reads the filtering mode (js/core/mode-manager.js), which writes the pause rules
    declarativeNetRequest: {
        getDynamicRules: async () => [], getSessionRules: async () => [],
        updateDynamicRules: async () => {}, updateSessionRules: async () => {},
    },
    webNavigation: new Proxy({}, { get: (_, name) => ({
        addListener: fn => { (navListeners[name] ??= []).push(fn); },
    }) }),
    i18n: { getMessage: () => '' },
};
globalThis.fetch = async () => ({ json: async () => shippedRules });

let parser, carriers, worryCarriers, customScriptlets, dispatch;
try {
    parser           = await import(modUrl('js/util/popunder-parser.js'));
    carriers         = await import(modUrl('js/core/popunder-carriers.js'));
    worryCarriers    = await import(modUrl('js/core/builtin-exemption-carriers.js'));
    customScriptlets = await import(modUrl('js/core/custom-scriptlets.js'));
    dispatch         = await import(modUrl('js/generated/custom-scriptlets-dispatch.mjs'));
} catch ( err ) {
    didNotRun(`cannot import the modules under test (${err.message})`);
}

// ── 1. Parser ────────────────────────────────────────────────────────────────────
const ag = parser.parsePopunderLine("xgroovy.com,xgroovy.tv#%#//scriptlet('prevent-popunder', 'pemsrv.com', 'magsrv.com')");
expect(ag?.ok === true && JSON.stringify(ag.sites) === '["xgroovy.com","xgroovy.tv"]' && JSON.stringify(ag.networks) === '["magsrv.com","pemsrv.com"]',
    `AdGuard form not parsed (${JSON.stringify(ag)})`);
expect(parser.parsePopunderLine('XGROOVY.com##+js(prevent-popunder, PEMSRV.com)')?.ok === true, 'uBO form / case not handled');
expect(parser.parsePopunderLine("xgroovy.com#%#//scriptlet('ubo-prevent-popunder', 'pemsrv.com')")?.ok === true, 'the build\'s "ubo-" alias not handled');
expect(parser.parsePopunderLine('example.com##+js(nowebrtc)') === null, 'another scriptlet was claimed');
expect(parser.parsePopunderLine("!xgroovy.com#%#//scriptlet('prevent-popunder', 'pemsrv.com')") === null, 'a commented-out line was claimed');
const REJECTS = [
    [ "#%#//scriptlet('prevent-popunder', 'pemsrv.com')", 'needs a site' ],
    [ "xgroovy.com#%#//scriptlet('prevent-popunder')", 'at least one ad network' ],
    [ 'xgroovy.*##+js(prevent-popunder, pemsrv.com)', 'not a plain domain' ],
    [ '~xgroovy.com##+js(prevent-popunder, pemsrv.com)', 'not a plain domain' ],
    [ 'xgroovy.com##+js(prevent-popunder, pemsrv)', 'not a plain domain' ],
    [ 'xgroovy.com#@#+js(prevent-popunder, pemsrv.com)', 'exceptions are not supported' ],
];
for ( const [ line, word ] of REJECTS ) {
    const r = parser.parsePopunderLine(line);
    expect(r?.ok === false && r.reason.includes(word), `"${line}" not rejected with "${word}" (${JSON.stringify(r)})`);
}
expect(parser.isPopupOptionLine('||t.me^$popup,domain=a.com') && parser.isPopupOptionLine('||x.com^$third-party,popunder'), '$popup/$popunder not recognised');
expect(parser.isPopupOptionLine('example.com##div[data-x="$popup"]') === false, 'a cosmetic line was read as $popup');
expect(parser.isPopupOptionLine('||ads.example^$script') === false, 'an ordinary network rule was read as $popup');
const extracted = parser.extractPopunderLines([
    '! c', "xgroovy.com#%#//scriptlet('prevent-popunder', 'pemsrv.com', 'magsrv.com')", '||ads.example^', '||t.me^$popup', 'x.*##+js(prevent-popunder, a.com)',
].join('\n'));
expect(extracted.entries.length === 2 && extracted.rejected.length === 2, `extract counts wrong (${JSON.stringify(extracted)})`);
expect(extracted.remainingText === '! c\n||ads.example^', `remainingText kept a pop-up line (${JSON.stringify(extracted.remainingText)})`);

// ── 2. Name guard ────────────────────────────────────────────────────────────────
const known = new Set(dispatch.KNOWN_SCRIPTLET_NAMES);
expect(known.has('prevent-popunder') === false && known.has('ubo-prevent-popunder') === false,
    'an AdGuard/uBO scriptlet named prevent-popunder now exists — uBD\'s own meaning would shadow it; rename uBD\'s');
expect(known.has('prevent-window-open') && known.has('prevent-navigation'), 'prevent-window-open / prevent-navigation (named in the info box) are no longer known scriptlets');

// ── 3. Import ABP editor ─────────────────────────────────────────────────────────
const sandbox = [
    "xgroovy.com#%#//scriptlet('prevent-popunder', 'pemsrv.com')",
    'x.*##+js(prevent-popunder, a.com)',
    '||t.me^$popup,domain=a.com',
    'example.com##+js(nowebrtc)',
].join('\n');
const synced = await customScriptlets.syncScriptletRulesFromSandboxText(sandbox);
const outLines = synced.text.split('\n');
expect(outLines[0] === "xgroovy.com#%#//scriptlet('prevent-popunder', 'pemsrv.com')", 'a valid prevent-popunder line was not kept as written');
expect(outLines[1] === '!x.*##+js(prevent-popunder, a.com)' && outLines[2].startsWith('! Rejected: '), 'a bad prevent-popunder line was not commented out with its reason');
expect(outLines[3] === '!||t.me^$popup,domain=a.com' && outLines[4] === `! Rejected: ${parser.POPUP_OPTION_REJECTION}`, 'a $popup line was not commented out with the agreed reason');
const storedRules = JSON.stringify([ ...localStore.values() ]);
expect(storedRules.includes('nowebrtc') && storedRules.includes('prevent-popunder') === false, 'prevent-popunder was registered as an injectable scriptlet');
expect(/extractPopunderLines\(stripExemptionOptionLines\(sandboxFilters\)\)\.remainingText/.test(read('js/core/compiled-filters.js')),
    'compiled-filters.js no longer keeps pop-up lines out of the network/cosmetic compiler');

// ── 4. Carriers and build ────────────────────────────────────────────────────────
const built = carriers.buildPopunderCarrierRules(500, [
    { network: 'pemsrv.com', sites: [ 'xgroovy.com' ] }, { network: 'magsrv.com', sites: [ 'xgroovy.com' ] }, { network: 'exosrv.com', sites: [ 'other.com' ] },
]);
expect(built.length === 2 && built[0].id === 500 && built[1].id === 501, 'carriers not grouped per site list with consecutive ids');
expect(built.every(r => JSON.stringify(r.condition.requestMethods) === '["connect"]' && JSON.stringify(r.condition.resourceTypes) === '["main_frame"]'),
    'a carrier is not inert (CONNECT + main_frame only)');
const roundTrip = carriers.readPopunderCarrierEntries(built).map(e => `${e.network}>${e.sites.join('|')}`).sort();
expect(JSON.stringify(roundTrip) === '["exosrv.com>other.com","magsrv.com>xgroovy.com","pemsrv.com>xgroovy.com"]', `carrier round trip lost data (${roundTrip})`);
const worryRule = worryCarriers.buildExemptionCarrierRules(1, { worryfree: [ 'bbc.com' ] })[0];
expect(carriers.isPopunderCarrierRule(worryRule) === false && built.every(r => worryCarriers.isExemptionCarrierRule(r) === false), 'the two carrier kinds are confused');
const buildSrc = read('tools/build/build-steps.mjs');
expect(/extractPopunderLines\(text\)/.test(buildSrc) && /buildPopunderCarrierRules\(/.test(buildSrc) && /isPopunderCarrierRule\)/.test(buildSrc),
    'the build no longer picks out / emits / guards prevent-popunder carriers');

// ── 5. Tab-under guard ───────────────────────────────────────────────────────────
shippedRules = carriers.buildPopunderCarrierRules(1, [ { network: 'pemsrv.com', sites: [ 'xgroovy.com' ] } ]);
let guard;
try {
    guard = await import(modUrl('js/core/tab-under-guard.js', '?run=1'));
} catch ( err ) {
    didNotRun(`cannot import js/core/tab-under-guard.js (${err.message})`);
}
let filteringOff = new Set();
async function isOff(host) { return filteringOff.has(host); }
function commit(g, tabId, url, frameId = 0) { return g.recordTabUnderCommit({ tabId, frameId, url }); }
function leave(g, tabId, url, frameId = 0) { return g.restoreTabUnderNavigation({ tabId, frameId, url }, isOff); }
const AD = 'https://s.pemsrv.com/v1/link.php?idzone=5836710';

guard.refreshImportedTabUnderEntries("xgroovy.com#%#//scriptlet('prevent-popunder', 'magsrv.com')");   // import channel
await guard.loadBuiltinTabUnderEntries();                                                              // built-in channel
await commit(guard, 1, 'https://nl.xgroovy.com/videos/123');
expect(await leave(guard, 1, AD) === true && updates.length === 1 && updates[0].url === 'https://nl.xgroovy.com/videos/123',
    `built-in entry: tab not sent back (${JSON.stringify(updates)})`);
expect(await guard.isTabBeingSentBack(1) === true, 'isTabBeingSentBack() false right after a send-back');
await commit(guard, 1, 'https://nl.xgroovy.com/videos/123');
updates.length = 0;
expect(await leave(guard, 1, 'https://a.magsrv.com/x') === true && updates.length === 1, 'imported entry: tab not sent back');
updates.length = 0;
await leave(guard, 1, 'https://example.org/');
await leave(guard, 1, AD, 3);
await commit(guard, 2, 'https://www.example.com/');
await leave(guard, 2, AD);
expect(updates.length === 0, 'a normal link, a sub-frame or an unconfigured site triggered a send-back');
expect(await guard.isTabBeingSentBack(2) === false, 'isTabBeingSentBack() true for a tab that was never sent back');
filteringOff = new Set([ 'nl.xgroovy.com' ]);
await leave(guard, 1, AD);
expect(updates.length === 0, 'site-mode gate: sent back on a site whose filtering is OFF');
filteringOff = new Set();
await leave(guard, 1, AD);   // the two restores above used this window's budget
expect(updates.length === 0, 'loop guard did not stop a third send-back inside its window');
await commit(guard, 4, 'https://xgroovy.com/');
await commit(guard, 4, 'https://news.example/');
await leave(guard, 4, AD);
expect(updates.length === 0, 'a tab that left the site was still sent back');
await commit(guard, 5, 'https://xgroovy.com/');
// Service-worker restart + LIGHT WAKE-UP PATH: a fresh instance whose startup loaders have NOT run must still decide,
// from storage.session alone (tab record + entries mirror).
shippedRules = [];   // prove the decision does not come from re-reading the shipped ruleset
const guard2 = await import(modUrl('js/core/tab-under-guard.js', '?run=2'));
expect(await leave(guard2, 5, AD) === true && updates.length === 1 && updates[0].url === 'https://xgroovy.com/',
    'light wake-up path: a fresh instance did not send the tab back from storage.session alone');
await guard2.releaseTabUnderTab(5);
const stored = sessionStore.get('tabUnder.lastSiteUrlByTab') ?? {};
expect(Object.hasOwn(stored, '5') === false, 'closed tab still recorded in storage.session');
expect(await guard2.isTabBeingSentBack(5) === false, 'released tab still reported as being sent back');
guard.refreshImportedTabUnderEntries('');
await commit(guard, 6, 'https://xgroovy.com/');
updates.length = 0;
await leave(guard, 6, 'https://a.magsrv.com/x');
expect(updates.length === 0, 'an entry removed from the editor still applied');

// ── 6. Block page ────────────────────────────────────────────────────────────────
let blockPage;
try {
    blockPage = await import(modUrl('js/core/block-page.js', '?run=1'));
} catch ( err ) {
    didNotRun(`cannot import js/core/block-page.js (${err.message})`);
}
updates.length = 0;
const BLOCKED = 'net::ERR_BLOCKED_BY_CLIENT';
await blockPage.showBlockPageForFailedLoad({ tabId: 7, frameId: 0, url: 'https://s.pemsrv.com/v1/link.php', error: BLOCKED });
expect(updates.length === 1 && updates[0].url === 'chrome-extension://test/blocked/blocked.html?host=s.pemsrv.com',
    `blocked load not sent to the block page (${JSON.stringify(updates)})`);
updates.length = 0;
await blockPage.showBlockPageForFailedLoad({ tabId: 7, frameId: 2, url: 'https://ads.example/', error: BLOCKED });
await blockPage.showBlockPageForFailedLoad({ tabId: 7, frameId: 0, url: 'https://down.example/', error: 'net::ERR_NAME_NOT_RESOLVED' });
expect(updates.length === 0, 'block page shown for a sub-frame or a non-block error');
// A tab the guard (same module instance the block page imports) is sending back is left alone.
const sharedGuard = await import(modUrl('js/core/tab-under-guard.js'));
sharedGuard.refreshImportedTabUnderEntries("xgroovy.com#%#//scriptlet('prevent-popunder', 'pemsrv.com')");
await sharedGuard.recordTabUnderCommit({ tabId: 8, frameId: 0, url: 'https://xgroovy.com/' });
const pending = sharedGuard.restoreTabUnderNavigation({ tabId: 8, frameId: 0, url: AD }, isOff);   // not awaited: the error races it
await blockPage.showBlockPageForFailedLoad({ tabId: 8, frameId: 0, url: AD, error: BLOCKED });
await pending;
expect(updates.length === 1 && updates[0].url === 'https://xgroovy.com/', `the block page covered a tab being sent back (${JSON.stringify(updates)})`);
// (10.7.5) ONE decision per blocked load: a popup tab a page just opened is CLOSED by js/core/blocked-popup-closer.js
// (10.7.3) instead of getting the block page; a tab nobody opened gets the block page; the closer has no
// onErrorOccurred listener of its own (else two handlers would race on the same tab).
const closer = await import(modUrl('js/core/blocked-popup-closer.js'));   // same instance block-page.js imports
closer.registerBlockedPopupCloser();
expect((navListeners.onErrorOccurred ?? []).length === 0, 'blocked-popup-closer registers its own onErrorOccurred listener again');
updates.length = 0;
navListeners.onCreatedNavigationTarget[0]({ tabId: 9, sourceTabId: 1 });
await blockPage.showBlockPageForFailedLoad({ tabId: 9, frameId: 0, url: 'https://s.pemsrv.com/', error: BLOCKED });
expect(removals.length === 1 && removals[0] === 9 && updates.length === 0,
    `a blocked popup tab was not closed, or also got the block page (removed ${JSON.stringify(removals)}, updates ${JSON.stringify(updates)})`);
await blockPage.showBlockPageForFailedLoad({ tabId: 10, frameId: 0, url: 'https://s.pemsrv.com/', error: BLOCKED });
expect(removals.length === 1 && updates.length === 1 && updates[0].tabId === 10, 'a tab no page opened was closed instead of shown the block page');
// (11.1.6) Filtering OFF for the blocked host: uBD's rules cannot have blocked it, so no block page — not for a site
// switched off, not during the global pause; a site pinned ON during the global pause is still filtered, so it does.
const modes = await import(modUrl('js/core/mode-manager.js'));   // same instance block-page.js imports
function setModes(none, basic) { return modes.setFilteringModeDetails({ none: new Set(none), basic: new Set(basic) }); }
updates.length = 0;
await setModes([ 's.pemsrv.com' ], [ 'all-urls' ]);
await blockPage.showBlockPageForFailedLoad({ tabId: 11, frameId: 0, url: 'https://s.pemsrv.com/', error: BLOCKED });
expect(updates.length === 0, `block page shown for a site whose filtering is OFF (${JSON.stringify(updates)})`);
await setModes([ 'all-urls' ], [ 'pinned.example' ]);
await blockPage.showBlockPageForFailedLoad({ tabId: 11, frameId: 0, url: 'https://s.pemsrv.com/', error: BLOCKED });
expect(updates.length === 0, `block page shown during the global pause (${JSON.stringify(updates)})`);
await blockPage.showBlockPageForFailedLoad({ tabId: 12, frameId: 0, url: 'https://pinned.example/', error: BLOCKED });
expect(updates.length === 1 && updates[0].tabId === 12, 'no block page for a site pinned ON during the global pause');
await setModes([], [ 'all-urls' ]);   // release: back to the default (filtering on everywhere)
const bgSource = read('js/workflow/background.js');
expect((bgSource.match(/webNavigation\.onErrorOccurred\.addListener/g) ?? []).length === 1,
    'background.js must have exactly ONE onErrorOccurred listener (the block page decision)');

const manifest = JSON.parse(read('manifest.json'));
const war = manifest.web_accessible_resources.flatMap(e => e.resources).join(' ');
expect(war.includes('blocked/') === false, 'the block page is web-accessible (websites could open it)');
const pageHtml = read('blocked/blocked.html');
expect(/src="\.\.\/img\/icon_128\.png"/.test(pageHtml) && /This page was blocked/.test(pageHtml) && /id="blockCloseTab"/.test(pageHtml),
    'block page lost its icon, heading or Close tab button');
expect(/innerHTML/.test(read('blocked/blocked.js')) === false, 'blocked.js writes HTML (the host parameter must be text only)');

if ( findings.length > 0 ) {
    console.log('FINDINGS:');
    for ( const f of findings ) { console.log(`  - ${f}`); }
    process.exit(1);
}
console.log('PASS: parser, name guard, editor annotation, carriers, send-back (both channels, gates, loop guard, light wake-up), block page (not when filtering is off, 11.1.6), popup closer coordination (10.7.5).');
