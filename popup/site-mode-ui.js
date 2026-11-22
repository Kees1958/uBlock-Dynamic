/*******************************************************************************

    uBlock-Stripped-Dynamic — Site mode UI

    Simple OFF / BASIC toggle button for the active tab's hostname.
    Shows the domain name and a power icon. Click to toggle.
    Sends MSG_SITE_MODE_SET to the SW on click.

*******************************************************************************/

import { sendMessage, browser } from '../js/data/ext.js';
import { SITE_MODE_OFF, SITE_MODE_BASIC, SITE_MODE_DEFAULT } from '../js/core/site-mode-manager.js';
import { renderState } from './popup.js';

/******************************************************************************/

let currentHostname = '';
let currentMode = SITE_MODE_DEFAULT;
let currentTabId = undefined;

function render(mode) {
    currentMode = mode;
    const isOff = mode === SITE_MODE_OFF;
    const label = document.getElementById('siteModeLabel');
    const btn   = document.getElementById('siteModeButton');

    if ( label ) { label.textContent = isOff ? 'Turn on' : 'Turn off'; }
    if ( btn )   { btn.classList.toggle('is-off', isOff); }
    renderState(isOff);
}

async function toggle() {
    if ( !currentHostname ) { return; }
    const newMode = currentMode === SITE_MODE_OFF ? SITE_MODE_BASIC : SITE_MODE_OFF;
    render(newMode);
    await sendMessage({
        what: 'siteModeSet',
        hostname: currentHostname,
        mode: newMode,
        tabId: currentTabId,
    });
}

async function init() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab  = tabs?.[0];
    currentTabId = tab?.id;

    let hostname = '';
    try {
        hostname = new URL(tab?.url ?? '').hostname.replace(/^www\./, '');
    } catch {}
    currentHostname = hostname;

    const hnEl = document.getElementById('siteModeHostname');
    if ( hnEl ) { hnEl.textContent = hostname || ''; }

    if ( hostname ) {
        const resp = await sendMessage({ what: 'siteModeGet', hostname });
        render(resp?.mode ?? SITE_MODE_DEFAULT);
    } else {
        render(SITE_MODE_DEFAULT);
    }

    const btn = document.getElementById('siteModeButton');
    if ( btn ) { btn.addEventListener('click', toggle); }
}

init();

/******************************************************************************/
