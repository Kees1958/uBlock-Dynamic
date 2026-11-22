// ── blocked.js ───────────────────────────────────────────────────────────────
// Script of uBD's block page (blocked/blocked.html, 10.7.2): fills in the extension name and the blocked domain, and
// closes the tab on request.
//
// Inputs: the "host" query parameter (set by js/core/block-page.js — the page is not web-accessible, so only the
// extension can open it) and the extName message (_locales, the single source of the extension's name).
// Written with textContent only — never HTML — so a crafted parameter can never inject markup.
//
// State: none. Resources: one click listener, released with the page.
import { browser } from '../js/data/ext.js';

// ── Declared constants ────────────────────────────────────────────────────────
const BLOCKED_PAGE_CONFIG = Object.freeze({
    HOST_PARAM:        'host',      // query parameter carrying the blocked domain (js/core/block-page.js)
    EXT_NAME_MESSAGE:  'extName',   // _locales message holding the extension's full name
    MAX_HOST_LENGTH:   253,         // DNS limit — anything longer is not shown
});

function blockedHostFromUrl() {
    const host = new URL(self.location.href).searchParams.get(BLOCKED_PAGE_CONFIG.HOST_PARAM) ?? '';
    return host.length <= BLOCKED_PAGE_CONFIG.MAX_HOST_LENGTH ? host : '';
}

function renderBlockNotice() {
    const nameEl = document.getElementById('blockExtName');
    const hostEl = document.getElementById('blockHost');
    if ( nameEl !== null ) { nameEl.textContent = browser.i18n?.getMessage(BLOCKED_PAGE_CONFIG.EXT_NAME_MESSAGE) ?? ''; }
    if ( hostEl !== null ) { hostEl.textContent = blockedHostFromUrl(); }
}

// Closes this tab. tabs.getCurrent() needs no permission for an extension page.
async function closeThisTab() {
    try {
        const tab = await browser.tabs.getCurrent();
        if ( tab?.id !== undefined ) { await browser.tabs.remove(tab.id); return; }
    } catch (reason) {
        console.error('[uBlock-Dynamic] blocked.js/closeThisTab:', reason);
    }
    self.close();
}

renderBlockNotice();
document.getElementById('blockCloseTab')?.addEventListener('click', closeThisTab);
