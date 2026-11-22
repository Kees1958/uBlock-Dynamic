/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2014-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/Kees1958/uBol-stripped

    Based on uBlock Origin Lite (https://github.com/gorhill/uBlock), modified in
    2026 for uBlock-Stripped-Dynamic — see CHANGELOG.md for the changes.

*/

// ── ad-cleaner.js ────────────────────────────────────────────────────────────
// (11.0.0) "Ad leftover cleaner" — page script, injected ON DEMAND into a tab's top frame (ISOLATED world) by
// js/workflow/ad-cleaner-routes.js, after css-api.js and after the launch set the data global (js/data/ad-cleaner.js).
// Repurposed from uBOL's generic cosmetic filter (css-generic.js): the same id/class survey, hash lookup and
// mutation-driven re-survey — now run once on request, verifying each candidate, reporting what it hid, and ending
// through one path.
//
// Lifecycle (one state vector, `run`):
//   [scanning] ──first survey──► [watching] ──idle / nothing more / time limit / Stop / Undo / Keep / page left──► [stopped]
//   Every end goes through stopRun(reason): clears every timer, disconnects the observer, releases the data.
//   The panel stays until Close / Undo / Keep finishes; closePanel() removes it and its listeners.
//   A second launch in the same page ends the first run (Undo of its hiding) before starting.
//
// Reports (owner 2026-11-19 — "keep it simple, the main message"):
//   the person  — the in-page panel: how many ad leftovers were removed, and whether it is still looking;
//   background  — only on "Keep for this site" (MSG adCleanerKeep: the matched selectors; the hostname is taken from
//                 the sender by the background, never from this script);
//   console     — one line per run with the stop reason.
// ─────────────────────────────────────────────────────────────────────────────

(function adLeftoverCleaner() {

if ( window.top !== window.self ) { return; }   // top frame only (the launch targets frame 0; defense in depth)

/******************************************************************************/
// Config — every constant this file uses, declared once, here.

// MIRROR of js/data/ad-cleaner.js (a content script cannot import) — proven equal by tools/test-ad-cleaner.mjs.
const AD_CLEANER_DATA_GLOBAL = '__usd_ad_cleaner_data_7c41e2';
const AD_CLEANER_NAME = 'Ad leftover cleaner';            // MIRROR of js/data/ui-names.js AD_CLEANER_NAME
const RUN_GLOBAL = '__usd_ad_cleaner_run_7c41e2';         // the running instance in this page (isolated world)
const MSG_KEEP = 'adCleanerKeep';                          // MIRROR of js/data/message-types.js MSG_AD_CLEANER_KEEP
const HASH_TYPE_ID = 0x23;                                 // '#'
const HASH_TYPE_CLASS = 0x2E;                              // '.'

const SURVEY_TIME_SLICE_MS = 4;     // longest one survey pass may run before yielding (uBOL value)
const SURVEY_NODE_SLICE = 64;       // elements handled per inner step (uBOL value)
const PROCESS_DELAY_MS = 64;        // page changes are batched this long before a survey (uBOL value)
const IDLE_STOP_MS = 30000;         // stop watching after this long without page changes (uBOL value)
const IDLE_CHECK_MS = 5000;         // how often "has the page gone idle?" is checked
const MAX_RUN_MS = 60000;           // hard limit: a run never watches longer than this (owner-approved design)
const MISS_STOP_MIN_SURVEYS = 64;   // only judge "nothing more to find" after this many surveys (uBOL value)
const MISS_STOP_RATIO = 0.95;       // ...and when this share of them found nothing (uBOL value)
const UNKEYED_CHUNK = 100;          // unkeyed selectors tested together per querySelector call
const HIDE_DECLARATION = '{display:none!important;}';
const PANEL_TOP_PX = 16;            // panel position / size / layer — same values as start-notice.js
const PANEL_MAX_WIDTH_PX = 460;
const PANEL_Z_INDEX = 2147483647;
const LOG_PREFIX = '[uBlock-Dynamic] ad leftover cleaner:';

// ── (11.0.2) GUARD: the extension was reloaded or updated under this page ─────────────────────────────────────────────
// Scripts left in an open page then lose their connection: chrome.runtime.id becomes undefined and
// chrome.runtime.sendMessage() THROWS synchronously ("Extension context invalidated."), which a .catch() cannot see —
// it surfaced on chrome://extensions as an error with no context. sendToExtension() always returns a promise: it
// resolves to undefined once the extension is gone, and rejects (never throws) on any other failure. Same pattern as
// css-specific.js cacheWrite(). Page scripts cannot import, so this block is copied word for word into every page
// script that messages the extension; tools/test-content-script-context.mjs keeps the copies identical.
function isExtensionGone() {
    try {
        return chrome.runtime?.id === undefined;
    } catch {
        return true;   // benign: no runtime at all means the same — the extension is gone
    }
}
function sendToExtension(msg) {
    if ( isExtensionGone() ) { return Promise.resolve(); }
    try {
        return chrome.runtime.sendMessage(msg);
    } catch (reason) {
        return Promise.reject(reason);
    }
}
// ── end GUARD ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const PHASES = Object.freeze({ SCANNING: 'scanning', WATCHING: 'watching', STOPPED: 'stopped' });
// Why a run ended — one code each; the panel shows the plain line, the console the code.
const STOP_REASONS = Object.freeze({
    IDLE:      'idle',           // the page stopped changing
    NOTHING:   'nothing-more',   // surveys kept finding nothing
    TIME:      'time-limit',     // MAX_RUN_MS reached
    USER:      'stopped',        // Stop button
    UNDO:      'undone',         // Undo button
    KEPT:      'kept',           // Keep for this site
    LEFT:      'page-left',      // navigated away
    RESTARTED: 'restarted',      // a new launch replaced this run
    NO_DATA:   'no-data',        // launched without (valid) data
    EXEMPT:    'site-exempt',    // the lists say generic hiding breaks this site
    GONE:      'extension-gone', // (11.0.2) the extension was reloaded or updated under this page
});
const STATUS_TEXT = Object.freeze({
    watching: 'Still looking for more…',
    [STOP_REASONS.IDLE]: 'Done.',
    [STOP_REASONS.NOTHING]: 'Done.',
    [STOP_REASONS.TIME]: 'Done. Run it again to catch ads that load later.',
    [STOP_REASONS.USER]: 'Stopped.',
    [STOP_REASONS.GONE]: 'Stopped: the extension was updated. Reload the page to run it again.',
});

/******************************************************************************/
// MIRROR of js/data/ad-cleaner.js adCleanerHash() — proven equal by tools/test-ad-cleaner.mjs.

function adCleanerHash(type, s) {
    const len = s.length;
    const step = len + 7 >>> 3;
    let hash = (type << 5) + type ^ len;
    for ( let i = 0; i < len; i += step ) {
        hash = (hash << 5) + hash ^ s.charCodeAt(i);
    }
    return hash & 0xFFFF;
}

/******************************************************************************/
// Re-launch guard: end (and undo) a run still active in this page before starting a new one.

const previous = self[RUN_GLOBAL];
if ( previous !== undefined && typeof previous.replace === 'function' ) { previous.replace(); }

const data = self[AD_CLEANER_DATA_GLOBAL];
self[AD_CLEANER_DATA_GLOBAL] = undefined;   // release at once: one launch, one read

/******************************************************************************/
// The state vector — everything this run owns, in one place.

const run = {
    owner: 'ad-leftover-cleaner',
    phase: PHASES.SCANNING,
    stopReason: null,
    startedAt: Date.now(),
    lastDomChange: Date.now(),
    // matching state (released by stopRun)
    selectorMap: new Map(),        // hash -> [ selector ] still to try
    unkeyed: [],                   // unkeyed selectors not matched yet
    candidates: new Set(),         // keyed selectors whose id/class was seen but did not match yet
    exceptions: new Set(),         // selectors EasyList exempts on this site
    seenHashes: new Set(),
    pendingHashes: new Set(),
    pendingNodes: [],
    pendingNodeSet: new Set(),
    surveyCount: 0,
    missCount: 0,
    // results (kept until the panel closes)
    matched: new Set(),            // selectors that really matched — what Keep saves
    insertedCss: [],               // every CSS text inserted — what Undo removes
    hiddenCount: 0,
    // resources (released by stopRun / closePanel)
    observer: null,
    processTimer: undefined,
    idleTimer: undefined,
    maxTimer: undefined,
    panel: null,                   // { host, root, listeners: [ [ target, type, fn, opts ] ] }
};

/******************************************************************************/
// Matching

function hashesFromNode(node) {
    const id = node.id;
    if ( typeof id === 'string' && id !== '' ) { addHash(HASH_TYPE_ID, id.trim()); }
    const cls = node.getAttribute('class');   // getAttribute, not classList (uBO perf note, issues #2076)
    if ( typeof cls !== 'string' ) { return; }
    for ( const token of cls.split(/\s+/) ) {
        if ( token !== '' ) { addHash(HASH_TYPE_CLASS, token); }
    }
}

function addHash(type, token) {
    const hash = adCleanerHash(type, token);
    if ( run.seenHashes.has(hash) ) { return; }
    run.seenHashes.add(hash);
    run.pendingHashes.add(hash);
}

function nextNodes(out) {
    for ( const added of run.pendingNodes ) {
        if ( run.pendingNodeSet.has(added) ) { continue; }
        run.pendingNodeSet.add(added);
        if ( added.firstElementChild === null ) { continue; }
        for ( const descendant of added.querySelectorAll('[id],[class]') ) { run.pendingNodeSet.add(descendant); }
    }
    run.pendingNodes.length = 0;
    for ( const node of run.pendingNodeSet ) {
        run.pendingNodeSet.delete(node);
        out.push(node);
        if ( out.length === SURVEY_NODE_SLICE ) { break; }
    }
}

function matches(selector) {
    try { return document.querySelector(selector) !== null; } catch { return false; }   // invalid in this browser: never matches
}

// Candidates of this survey: selectors keyed by a newly seen id/class, plus earlier candidates that did not match yet.
function takeCandidates() {
    for ( const hash of run.pendingHashes ) {
        const list = run.selectorMap.get(hash);
        if ( list === undefined ) { continue; }
        run.selectorMap.delete(hash);
        for ( const selector of list ) {
            if ( run.exceptions.has(selector) === false ) { run.candidates.add(selector); }
        }
    }
    run.pendingHashes.clear();
}

function newMatches() {
    const found = [];
    for ( const selector of run.candidates ) {
        if ( matches(selector) ) { run.candidates.delete(selector); found.push(selector); }
    }
    // Unkeyed selectors: one combined query per chunk first, each one only inside a chunk that matched something.
    for ( let i = 0; i < run.unkeyed.length; i += UNKEYED_CHUNK ) {
        const chunk = run.unkeyed.slice(i, i + UNKEYED_CHUNK);
        let any = true;
        try { any = document.querySelector(chunk.join(',')) !== null; } catch { any = true; }   // one invalid: test each
        if ( any === false ) { continue; }
        for ( const selector of chunk ) {
            if ( matches(selector) ) { found.push(selector); }
        }
    }
    if ( found.length !== 0 ) {
        const hit = new Set(found);
        run.unkeyed = run.unkeyed.filter(s => hit.has(s) === false);
    }
    return found;
}

function hide(selectors) {
    for ( const selector of selectors ) {
        run.matched.add(selector);
        run.hiddenCount += document.querySelectorAll(selector).length;
    }
    const css = `${selectors.join(',\n')}${HIDE_DECLARATION}`;
    run.insertedCss.push(css);
    self.cssAPI.insert(css);
}

function survey() {
    if ( run.phase === PHASES.STOPPED ) { return; }
    // (11.0.2) The extension was reloaded or updated under this page: end the run cleanly instead of failing on the
    // next hide (that failure was the uncaught "Extension context invalidated." seen on chrome://extensions).
    if ( isExtensionGone() ) { stopRun(STOP_REASONS.GONE); return; }
    const deadline = performance.now() + SURVEY_TIME_SLICE_MS;
    const nodes = [];
    for (;;) {
        nextNodes(nodes);
        if ( nodes.length === 0 ) { break; }
        for ( const node of nodes ) { hashesFromNode(node); }
        nodes.length = 0;
        if ( performance.now() >= deadline ) { scheduleSurvey(); break; }   // more left: continue next tick
    }
    run.surveyCount += 1;
    takeCandidates();
    const found = newMatches();
    if ( found.length === 0 ) {
        run.missCount += 1;
        if ( run.surveyCount >= MISS_STOP_MIN_SURVEYS && run.missCount / run.surveyCount >= MISS_STOP_RATIO ) {
            stopRun(STOP_REASONS.NOTHING);
        }
    } else {
        hide(found);
    }
    if ( run.phase === PHASES.SCANNING ) { run.phase = PHASES.WATCHING; }
    renderPanel();
}

function scheduleSurvey() {
    if ( run.processTimer !== undefined || run.phase === PHASES.STOPPED ) { return; }
    run.processTimer = self.setTimeout(( ) => {
        run.processTimer = undefined;
        survey();
    }, PROCESS_DELAY_MS);
}

function onMutations(mutations) {
    for ( const mutation of mutations ) {
        if ( mutation.type === 'childList' ) {
            for ( const added of mutation.addedNodes ) {
                if ( added.nodeType !== 1 || added.parentElement === null ) { continue; }
                if ( run.panel !== null && added === run.panel.host ) { continue; }   // our own panel
                run.pendingNodes.push(added);
            }
        } else {
            hashesFromNode(mutation.target);
        }
    }
    run.lastDomChange = Date.now();
    scheduleSurvey();
}

function checkIdle() {
    run.idleTimer = undefined;
    if ( run.phase === PHASES.STOPPED ) { return; }
    if ( Date.now() - run.lastDomChange >= IDLE_STOP_MS ) { stopRun(STOP_REASONS.IDLE); return; }
    run.idleTimer = self.setTimeout(checkIdle, IDLE_CHECK_MS);
}

/******************************************************************************/
// The one end path. Safe to call more than once (the second call does nothing).

function stopRun(reason) {
    if ( run.phase === PHASES.STOPPED ) { return; }
    run.phase = PHASES.STOPPED;
    run.stopReason = reason;
    for ( const key of [ 'processTimer', 'idleTimer', 'maxTimer' ] ) {
        if ( run[key] !== undefined ) { self.clearTimeout(run[key]); run[key] = undefined; }
    }
    if ( run.observer !== null ) {
        run.observer.disconnect();
        run.observer.takeRecords();
        run.observer = null;
    }
    // release the matching data; the results (matched, insertedCss) stay for Undo / Keep
    run.selectorMap.clear();
    run.unkeyed = [];
    run.candidates.clear();
    run.exceptions.clear();
    run.seenHashes.clear();
    run.pendingHashes.clear();
    run.pendingNodes.length = 0;
    run.pendingNodeSet.clear();
    console.info(`${LOG_PREFIX} stopped (${reason}) — ${run.matched.size} selectors matched, ` +
        `${run.hiddenCount} elements hidden, ${run.surveyCount} surveys, ${Date.now() - run.startedAt} ms`);
    renderPanel();
}

function undoHiding() {
    for ( const css of run.insertedCss ) {
        sendToExtension({ what: 'removeCSS', css }).catch(reason => {
            console.warn(`${LOG_PREFIX} could not show hidden elements again:`, reason);
        });
    }
    run.insertedCss.length = 0;
}

// Release everything: the run, its panel, and this page's pointer to it.
function finish() {
    stopRun(run.stopReason ?? STOP_REASONS.USER);
    closePanel();
    run.matched.clear();
    if ( self[RUN_GLOBAL] === instance ) { self[RUN_GLOBAL] = undefined; }
}

/******************************************************************************/
// Panel — same host shape and colours as js/scripting/start-notice.js (proven in both modes; STYLE_GUIDE_*.md).

function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    run.panel.listeners.push([ target, type, fn, opts ]);
}

function buildPanel() {
    const host = document.createElement('div');
    host.setAttribute('popover', 'manual');
    host.style.cssText = `all:initial;position:fixed;top:${PANEL_TOP_PX}px;left:50%;` +
        `transform:translateX(-50%);z-index:${PANEL_Z_INDEX};`;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
        <style>
            :host { all: initial; }
            .panel {
                --surface-1: 240 240 242;
                --border-1:  184 184 192;
                --ink-1:     32 18 58;
                background: rgb(var(--surface-1));
                border: 1px solid rgb(var(--border-1));
                border-radius: 8px;
                box-shadow: 0 4px 16px rgb(0 0 0 / 25%);
                box-sizing: border-box;
                color: rgb(var(--ink-1));
                font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                max-width: ${PANEL_MAX_WIDTH_PX}px;
                padding: 12px 16px;
                width: max-content;
            }
            .title { font-weight: 600; }
            .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
            button {
                background: transparent;
                border: 1px solid rgb(var(--border-1));
                border-radius: 6px;
                color: rgb(var(--ink-1));
                cursor: pointer;
                font: inherit;
                padding: 4px 12px;
            }
            button[hidden] { display: none; }
            @media (prefers-color-scheme: dark) {
                .panel {
                    --surface-1: 27 27 35;
                    --border-1:  81 81 98;
                    --ink-1:     226 226 229;
                }
            }
        </style>
        <div class="panel" role="status">
            <div class="title"></div>
            <div class="message"></div>
            <div class="status"></div>
            <div class="row">
                <button type="button" data-action="keep">Keep for this site</button>
                <button type="button" data-action="undo">Undo</button>
                <button type="button" data-action="stop">Stop</button>
                <button type="button" data-action="close">Close</button>
            </div>
        </div>
    `;
    root.querySelector('.title').textContent = AD_CLEANER_NAME;
    run.panel = { host, root, listeners: [], done: false };
    listen(root.querySelector('.row'), 'click', onPanelClick);
    document.documentElement.appendChild(host);
    try { host.showPopover(); } catch { /* fallback: plain fixed element */ }
}

function setText(selector, text) {
    const el = run.panel.root.querySelector(selector);
    if ( el !== null ) { el.textContent = text; }
}

function showButton(action, visible) {
    const el = run.panel.root.querySelector(`button[data-action="${action}"]`);
    if ( el !== null ) { el.hidden = visible === false; }
}

function renderPanel() {
    if ( run.panel === null || run.panel.done ) { return; }
    const n = run.hiddenCount;
    setText('.message', n === 0 ? 'No ad leftovers found.' : `Removed ${n} ad leftover${n === 1 ? '' : 's'}.`);
    const stopped = run.phase === PHASES.STOPPED;
    setText('.status', stopped ? (STATUS_TEXT[run.stopReason] ?? '') : STATUS_TEXT.watching);
    showButton('keep', run.matched.size !== 0);
    showButton('undo', run.insertedCss.length !== 0);
    showButton('stop', stopped === false);
    showButton('close', true);
}

// A final message with only Close left (after Keep).
function renderDone(message) {
    if ( run.panel === null ) { return; }
    run.panel.done = true;
    setText('.message', message);
    setText('.status', '');
    for ( const action of [ 'keep', 'undo', 'stop' ] ) { showButton(action, false); }
    showButton('close', true);
}

function closePanel() {
    if ( run.panel === null ) { return; }
    for ( const [ target, type, fn, opts ] of run.panel.listeners ) { target.removeEventListener(type, fn, opts); }
    try { run.panel.host.hidePopover(); } catch { /* not shown as a popover, or already hidden */ }
    run.panel.host.remove();
    run.panel = null;
}

async function keepForSite() {
    const selectors = [ ...run.matched ];
    stopRun(STOP_REASONS.KEPT);
    let response;
    try {
        response = await sendToExtension({ what: MSG_KEEP, selectors });
    } catch (reason) {
        console.warn(`${LOG_PREFIX} keep failed:`, reason);
    }
    renderDone(response?.ok === true ? 'Kept for this site.' : 'Could not keep these for this site.');
}

function onPanelClick(ev) {
    if ( ev.isTrusted !== true ) { return; }   // the page cannot press these buttons
    const action = ev.target instanceof Element ? ev.target.closest('button')?.dataset.action : undefined;
    switch ( action ) {
    case 'keep': keepForSite(); break;
    case 'undo': stopRun(STOP_REASONS.UNDO); undoHiding(); finish(); break;
    case 'stop': stopRun(STOP_REASONS.USER); break;
    case 'close': finish(); break;
    default: break;
    }
}

function onPageHide() {
    stopRun(STOP_REASONS.LEFT);
    finish();
}

/******************************************************************************/
// Start

const instance = Object.freeze({
    // called by a newer launch in the same page: end this run and undo its hiding (the new run hides them again)
    replace() { stopRun(STOP_REASONS.RESTARTED); undoHiding(); finish(); },
});

function isValidData(d) {
    return d !== null && typeof d === 'object' && d.hashes !== null && typeof d.hashes === 'object'
        && Array.isArray(d.unkeyed) && Array.isArray(d.exceptions);
}

function start() {
    self[RUN_GLOBAL] = instance;
    buildPanel();
    listen(self, 'pagehide', onPageHide);
    if ( isValidData(data) === false || self.cssAPI === undefined || document.documentElement === null ) {
        stopRun(STOP_REASONS.NO_DATA);
        renderDone('Could not run here.');
        return;
    }
    if ( data.exempt === true ) {
        stopRun(STOP_REASONS.EXEMPT);
        renderDone('Not used on this website: it is known to break it.');
        return;
    }
    for ( const [ hash, list ] of Object.entries(data.hashes) ) {
        if ( Array.isArray(list) ) { run.selectorMap.set(Number(hash), list); }
    }
    run.unkeyed = data.unkeyed.filter(s => typeof s === 'string' && data.exceptions.includes(s) === false);
    for ( const s of data.exceptions ) { run.exceptions.add(s); }
    run.observer = new MutationObserver(onMutations);
    run.observer.observe(document, { attributeFilter: [ 'class', 'id' ], attributes: true, childList: true, subtree: true });
    run.idleTimer = self.setTimeout(checkIdle, IDLE_CHECK_MS);
    run.maxTimer = self.setTimeout(( ) => { run.maxTimer = undefined; stopRun(STOP_REASONS.TIME); }, MAX_RUN_MS);
    run.pendingNodes.push(document.documentElement);
    survey();
}

start();

/******************************************************************************/

})();

void 0;
