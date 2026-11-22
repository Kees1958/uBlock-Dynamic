/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958

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

*/

// ── ad-cleaner-routes.js ─────────────────────────────────────────────────────
// (11.0.0) Service-worker side of the "Ad leftover cleaner" (js/data/ad-cleaner.js): starts it in a tab and saves
// what the person keeps.
//
// Public interface:
//   handleAdCleanerLaunch({ tabId })             — MSG_AD_CLEANER_LAUNCH (popup) and the right-click item
//   handleAdCleanerKeep({ selectors }, sender)   — MSG_AD_CLEANER_KEEP (the page script's "Keep for this site")
//
// Guards:
//   launch — a numeric tab id; an http(s) page; a data file of the expected shape; failures are console warnings
//            only (same posture as the picker launch). User-started, so not site-mode-gated ('exempt' in
//            tools/check-scripting-site-mode-gating.mjs, like the picker): it hides nothing until asked.
//   both   — (11.0.0) a site on the lists' whole-site exception list: the cleaner does not run, nothing is kept.
//   keep   — this extension's own content script, top frame only; 1..AD_CLEANER_KEEP_MAX strings, each one of the
//            shipped list's selectors, not exempted for this site by EasyList, and passing the stylesheet guard; the
//            hostname comes from the sender (Chrome's record), never from the message.
//
// State owned: none. The data file is read per call and dropped when the call ends — nothing to clear or release.
// ─────────────────────────────────────────────────────────────────────────────

import { browser } from '../data/ext.js';
import {
    AD_CLEANER_DATA_FILE, AD_CLEANER_DATA_GLOBAL, AD_CLEANER_KEEP_MAX, AD_CLEANER_SCRIPT_FILES,
    adCleanerExceptionsFor, isAdCleanerData, isAdCleanerSiteExempt,
} from '../data/ad-cleaner.js';
import { isSafePickedSelector } from '../util/css-selector-guard.js';
// (11.0.3, C15) Both helpers moved down out of filter-routes.js: a route file never imports another route file.
import { saveCustomCosmeticSelectors } from '../core/cosmetic-rule-save.js';
import { trustedHostnameFromSender } from '../util/trusted-sender.js';

const LOG_PREFIX = '[uBlock-Dynamic] ad leftover cleaner:';
const PAGE_PROTOCOLS = Object.freeze([ 'http:', 'https:' ]);

async function readAdCleanerData() {
    const response = await fetch(browser.runtime.getURL(AD_CLEANER_DATA_FILE));
    const data = await response.json();
    if ( isAdCleanerData(data) === false ) { throw new Error(`${AD_CLEANER_DATA_FILE} has an unexpected shape`); }
    return data;
}

function hostnameOfPage(url) {
    try {
        const parsed = new URL(url);
        return PAGE_PROTOCOLS.includes(parsed.protocol) ? parsed.hostname : '';
    } catch {
        return '';
    }
}

// Runs in the page (isolated world): hands the data to the page script that is injected next.
function setPageData(globalName, payload) {
    self[globalName] = payload;
}

export async function handleAdCleanerLaunch(request) {
    const tabId = request?.tabId;
    if ( typeof tabId !== 'number' ) {
        console.warn(`${LOG_PREFIX} launch without a valid tabId — ignored`);
        return { ok: false };
    }
    try {
        const tab = await browser.tabs.get(tabId);
        const hostname = hostnameOfPage(tab?.url ?? '');
        if ( hostname === '' ) { return { ok: false }; }
        const data = await readAdCleanerData();
        // (11.0.0) A site where generic hiding is known to break it: the page script only says it does not run here.
        const payload = isAdCleanerSiteExempt(hostname, data.exemptSites)
            ? { exempt: true, hashes: {}, unkeyed: [], exceptions: [] }
            : { hashes: data.hashes, unkeyed: data.unkeyed, exceptions: adCleanerExceptionsFor(hostname, data.exceptions) };
        const target = { tabId, frameIds: [ 0 ] };
        await browser.scripting.executeScript({ func: setPageData, args: [ AD_CLEANER_DATA_GLOBAL, payload ], target });
        await browser.scripting.executeScript({ files: [ ...AD_CLEANER_SCRIPT_FILES ], target });
        return { ok: true };
    } catch (reason) {
        console.warn(`${LOG_PREFIX} launch failed, tabId=`, tabId, reason);
        return { ok: false };
    }
}

export async function handleAdCleanerKeep(request, sender) {
    if ( sender?.id !== browser.runtime.id ) { return { ok: false }; }
    if ( sender?.frameId !== 0 ) { return { ok: false }; }
    const selectors = request?.selectors;
    if ( Array.isArray(selectors) === false || selectors.length === 0 || selectors.length > AD_CLEANER_KEEP_MAX ) {
        console.warn(`${LOG_PREFIX} keep refused: expected 1..${AD_CLEANER_KEEP_MAX} selectors`);
        return { ok: false };
    }
    const hostname = trustedHostnameFromSender(sender);
    if ( hostnameOfPage(sender?.url ?? '') === '' || hostname === '' ) { return { ok: false }; }
    let data;
    try {
        data = await readAdCleanerData();
    } catch (reason) {
        console.warn(`${LOG_PREFIX} keep failed: data file not readable`, reason);
        return { ok: false };
    }
    if ( isAdCleanerSiteExempt(hostname, data.exemptSites) ) {
        console.warn(`${LOG_PREFIX} keep refused: the lists say generic hiding breaks ${hostname}`);
        return { ok: false };
    }
    const shipped = new Set([ ...Object.values(data.hashes).flat(), ...data.unkeyed ]);
    const exempted = new Set(adCleanerExceptionsFor(hostname, data.exceptions));
    const valid = selectors.every(s => typeof s === 'string' && shipped.has(s) && exempted.has(s) === false && isSafePickedSelector(s));
    if ( valid === false ) {
        console.warn(`${LOG_PREFIX} keep refused: a selector is not one of the list's for this site`);
        return { ok: false };
    }
    try {
        await saveCustomCosmeticSelectors(hostname, [ ...new Set(selectors) ]);
        return { ok: true };
    } catch (reason) {
        console.warn(`${LOG_PREFIX} keep failed for`, hostname, reason);
        return { ok: false };
    }
}
