/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2022-present Raymond Hill

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

*******************************************************************************/

import { dom, qs$, qsa$ } from '../js/ui/dom.js';
import { sendMessage } from '../js/data/ext.js';
import { PROTECTIONS_MOVED_NOTICE } from '../js/data/retired-protections.js';

/*******************************************************************************

    Options tab (renamed 10.5.0; was "Privacy & Security", before that "Security & privacy") — redesigned from a
    flat, gated two-column grid behind an "I am an advanced user"
    confirmation checkbox into three risk-tiered groups, no gate at all —
    see CHANGELOG for the full history. Down to two things:
    renderSecurityConfig() (reflects stored config into every
    [data-setting] checkbox in the section) and one change listener that
    saves whichever checkbox changed.

    Everything gate-related from the previous design — GATE_KEY,
    loadGateState()/applyGateState(), the #advancedUserCheck listener,
    enableAllProtections()'s bulk-enable-on-unlock — is deleted outright:
    none of it has anything left to gate. Every item in this tab is
    independently visible and toggleable on page load, same as every
    other tab's checkboxes.

    (10.3.0) Only the "Privacy enhancements" rows are left (renamed "On startup" in 10.5.0 once
    Worry-free's own row moved in as its first row — see history-cleaner.js for the "at browser start"
    clears, grown to seven opt-in checkboxes; blockPings REMOVED outright, 10.5.0); the
    trailing #protectionsMovedNotice paragraph shows PROTECTIONS_MOVED_NOTICE
    (js/data/retired-protections.js — the same text the settings restore
    shows), rendered here rather than hard-coded in the HTML (B2a).
    (10.5.0) Its own heading ("Security enhancements") and the "Worry-free
    surfing" heading above it were both removed, per owner's request — the
    notice is now this tab's last line, directly above the dashboard footer.

*******************************************************************************/

// Load current security config and reflect in the UI checkboxes.

async function renderSecurityConfig() {
    const config = await sendMessage({ what: 'getSecurityConfig' });
    if ( !config ) { return; }
    for ( const input of qsa$('section[data-pane="security"] input[data-setting]') ) {
        const key = input.dataset.setting;
        if ( Object.hasOwn(config, key) ) {
            input.checked = config[key];
        }
    }
}

/******************************************************************************/
// Handle toggle changes.

dom.on(
    'section[data-pane="security"]',
    'change',
    'input[type="checkbox"][data-setting]',
    async ev => {
        const input = ev.target;
        const key = input.dataset.setting;
        const value = input.checked;
        input.disabled = true;
        try {
            await sendMessage({ what: 'setSecurityConfig', key, value });
        } finally {
            input.disabled = false;
        }
    }
);

/******************************************************************************/

function renderProtectionsMovedNotice() {
    const el = qs$('#protectionsMovedNotice');
    if ( el ) { el.textContent = PROTECTIONS_MOVED_NOTICE; }
}

/******************************************************************************/

renderProtectionsMovedNotice();
renderSecurityConfig();

/******************************************************************************/
