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

import { dom, qs$ } from '../js/ui/dom.js';
import {
    localRead, localRemove, localWrite,
    webextFlavor,
} from '../js/data/ext.js';
import { faIconsInit } from '../js/ui/fa-icons.js';
import { i18n } from '../js/ui/i18n.js';
import { DASHBOARD_TABS, DEFAULT_DASHBOARD_PANE } from '../js/data/ui-names.js';
import { applyUiNames } from '../js/ui/ui-names-apply.js';

/******************************************************************************/

dom.body.dataset.platform = webextFlavor;

dom.attr('a', 'target', '_blank');

// (10.5.0) The tab bar is built from js/data/ui-names.js's DASHBOARD_TABS — order and labels live
// there only (C39a). Every page-level name placeholder ([data-ui-name]) is filled in the same pass.
function renderDashboardNav() {
    const nav = qs$('#dashboard-nav');
    if ( nav === null ) { return; }
    nav.textContent = '';   // GUARD (clear): never append a second tab bar
    for ( const { pane, label } of DASHBOARD_TABS ) {
        const button = document.createElement('button');
        button.className = 'tabButton';
        button.type = 'button';
        button.tabIndex = 0;
        button.dataset.pane = pane;
        button.textContent = label;
        nav.appendChild(button);
    }
}
renderDashboardNav();
applyUiNames();
dom.body.dataset.pane = DEFAULT_DASHBOARD_PANE;

dom.on('#dashboard-nav', 'click', '.tabButton', ev => {
    const { pane } = ev.target.dataset;
    dom.body.dataset.pane = pane;
    if ( pane === DEFAULT_DASHBOARD_PANE ) {
        localRemove('dashboard.activePane');
    } else {
        localWrite('dashboard.activePane', pane);
    }
});

// Read pane on initial load
localRead('dashboard.activePane').then(pane => {
    if ( typeof pane !== 'string' ) { return; }
    if ( qs$(`section[data-pane="${pane}"]`) === null ) { return; }
    dom.body.dataset.pane = pane;
});

// Also switch pane when the popup sets dashboard.activePane on an already-open
// dashboard window — chrome.storage.onChanged fires even within the same page.
chrome.storage.local.onChanged.addListener(changes => {
    if ( changes['dashboard.activePane'] === undefined ) { return; }
    const pane = changes['dashboard.activePane'].newValue;
    if ( typeof pane !== 'string' ) { return; }
    if ( qs$(`section[data-pane="${pane}"]`) === null ) { return; }
    dom.body.dataset.pane = pane;
});

/******************************************************************************/

export function nodeFromTemplate(templateId, nodeSelector) {
    const template = qs$(`template#${templateId}`);
    const fragment = template.content.cloneNode(true);
    const node = nodeSelector !== undefined
        ? qs$(fragment, nodeSelector)
        : fragment.firstElementChild;
    faIconsInit(node);
    i18n.render(node);
    return node;
}

/******************************************************************************/

export function hashFromIterable(iter) {
    if ( Boolean(iter) === false ) { return ''; }
    return Array.from(iter).sort().join('\n');
}

/******************************************************************************/
