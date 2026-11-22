/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2019-present Raymond Hill

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

// Important!
// Isolate from global scope
(async function uBOL_cssSpecific() {

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


/******************************************************************************/

const specificImports = self.specificImports || [];
self.specificImports = undefined;

/******************************************************************************/

const { isolatedAPI } = self;

// Storage failures here are best-effort by design — this is a per-page
// selector CACHE; a miss only means recomputing. But they are no longer
// silent (C5): each logs once, with context, at console.debug level —
// hidden in DevTools by default ("Verbose"), so no noise in the page's
// own console for real users, yet visible to anyone diagnosing why the
// cache never hits. Prefix matches the rest of this extension's logs.
const LOG_PREFIX = '[uBlock-Dynamic] css-specific';

// (10.7.6, audit 10.7.5 D-5, owner's option B) The per-site cache lives in storage.local, NOT session storage: session
// storage is closed to content scripts (background.js sets TRUSTED_CONTEXTS), because it holds uBD's own state and this
// script runs inside every page. Bounds are unchanged and owned by the worker (js/core/scripting-manager.js): cleared by
// every full content-script registration (browser start included), capped at 256 entries by pruneCSSCache().

// BUG FIX (audit 9.7.5, C5): set() returns a promise; it was called without await inside try/catch, so a rejection
// escaped the catch entirely as an unhandled rejection. Now handled on the promise itself. Still fire-and-forget —
// callers don't wait on a cache write.
function cacheWrite(key, data) {
    try {
        chrome.storage.local.set({ [key]: data }).catch(reason => {
            console.debug(`${LOG_PREFIX}: cacheWrite(${key}) failed`, reason);
        });
    } catch (reason) {
        // Synchronous throw path (API missing / context invalidated).
        console.debug(`${LOG_PREFIX}: cacheWrite(${key}) threw`, reason);
    }
}

async function localRead(key) {
    try {
        const bin = await chrome.storage.local.get(key);
        return bin?.[key] ?? undefined;
    } catch (reason) {
        console.debug(`${LOG_PREFIX}: localRead(${key}) failed`, reason);
    }
}

function selectorsFromListIndex(data, ilist) {
    const list = JSON.parse(`[${data.selectorLists[ilist]}]`);
    const { result } = data;
    for ( const iselector of list ) {
        if ( iselector >= 0 ) {
            result.selectors.add(data.selectors[iselector]);
        } else {
            result.exceptions.add(data.selectors[~iselector]);
        }
    }
}

function selectorsFromHostnames(haystack, needles, data) {
    let listref = -1;
    for ( const needle of needles ) {
        listref = isolatedAPI.binarySearch(haystack, needle, listref);
        if ( listref >= 0 ) {
            selectorsFromListIndex(data, data.selectorListRefs[listref]);
        } else {
            listref = ~listref + 1;
        }
    }
}

async function selectorsFromRuleset(rulesetId, result) {
    const data = await localRead(`css.specific.${rulesetId}`);
    if ( typeof data !== 'object' || data === null ) { return; }
    data.result = result;
    const { hostnames, regexes } = data;
    if ( hostnames.length ) {
        selectorsFromHostnames(hostnames, isolatedAPI.contexts.hostnames, data);
        if ( data.hasEntities ) {
            selectorsFromHostnames(hostnames, isolatedAPI.contexts.entities, data);
        }
    }
    for ( let i = 0, n = regexes.length; i < n; i += 3 ) {
        if ( thisHostname.includes(regexes[i+0]) === false ) { continue; }
        if ( typeof regexes[i+1] === 'string' ) {
            regexes[i+1] = new RegExp(regexes[i+1]);
        }
        if ( regexes[i+1].test(thisHostname) === false ) { continue; }
        selectorsFromListIndex(data, regexes[i+2]);
    }
}

async function fillCache(rulesetIds) {
    const selectors = new Set();
    const exceptions = new Set();
    const result = { selectors, exceptions };
    const [ filteringModeDetails ] = await Promise.all([
        localRead('filteringModeDetails'),
        ...rulesetIds.map(a => selectorsFromRuleset(a, result)),
    ]);
    const skip = filteringModeDetails?.none.some(a => {
        if ( topHostname.endsWith(a) === false ) { return false; }
        const n = a.length;
        return topHostname.length === n || topHostname.at(-n-1) === '.';
    });
    for ( const selector of exceptions ) {
        selectors.delete(selector);
    }
    if ( skip ) {
        selectors.clear();
    }
    cacheEntry.s = [];
    cacheEntry.p = [];
    for ( const selector of selectors ) {
        if ( selector.startsWith('{') ) {
            cacheEntry.p.push(JSON.parse(selector));
        } else {
            cacheEntry.s.push(selector);
        }
    }
    return cacheEntry;
}

const topHostname = isolatedAPI.contexts.topHostname;
const thisHostname = document.location.hostname || '';
const cachePath = topHostname !== thisHostname ? `${topHostname}/` : '';
const cacheKey = `cache.css.${cachePath}${thisHostname}`;

let cacheEntry = await localRead(cacheKey) ?? { t: 0 };
if ( cacheEntry.t === 0 ) {
    cacheEntry = await fillCache(specificImports);
}
// (11.0.2, audit finding 6) Cache freshness is counted in 5-minute steps (uBOL value): an entry is refreshed once at
// least one full step has passed since it was last stamped.
const CACHE_TIME_STEP_MS = 5 * 60 * 1000;
const now = Math.round(Date.now() / CACHE_TIME_STEP_MS);
const since = now - cacheEntry.t;
if ( since > 1 ) {
    cacheEntry.t = now;
    cacheWrite(cacheKey, cacheEntry);
}

const { s, p } = cacheEntry;

if ( s.length !== 0 ) {
    self.cssAPI.insert(`${s.join(',\n')}{display:none!important;}`, true);
}

if ( p.length === 0 ) { return; }

if ( self.ProceduralFiltererAPI === undefined ) {
    self.ProceduralFiltererAPI = sendToExtension({
        what: 'injectCSSProceduralAPI'
    }).catch(( ) => {
    });
}

await self.ProceduralFiltererAPI;
// (11.0.2) GUARD: the inject message above replaces self.ProceduralFiltererAPI with a class once
// css-procedural-api.js has run. If the inject failed (the extension was reloaded, or the page refused it), it is still
// the promise, and `new` on it threw "is not a constructor". Stop here instead; nothing was hidden yet.
if ( typeof self.ProceduralFiltererAPI !== 'function' ) {
    console.debug('[uBlock-Dynamic] procedural filtering not started: its script could not be injected');
    return;
}
self.listsProceduralFiltererAPI = new self.ProceduralFiltererAPI();

const declaratives = p.filter(a => a.cssable);
if ( declaratives.length !== 0 ) {
    self.listsProceduralFiltererAPI.addDeclaratives(declaratives);
}
const procedurals = p.filter(a => !a.cssable);
if ( procedurals.length !== 0 ) {
    self.listsProceduralFiltererAPI.addProcedurals(procedurals);
}

/******************************************************************************/

})();

void 0;
