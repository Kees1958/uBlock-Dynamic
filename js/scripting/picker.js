/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2025-present Raymond Hill

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

/******************************************************************************/
//
// Architecture note: files under js/scripting/ run in the page (content
// script) execution context, injected via chrome.scripting.executeScript()
// by js/core/scripting-manager.js. They are outside the five-tier
// ui/workflow/core/util/data dependency model — see ARCHITECTURE.md.
//
// ── STATE / GUARDS (uBol-stripped-code-review.md §1 retrofit) ──────────────
// This file itself owns no session and needs no phase enum: every function
// here (attributeNameFromPart, selectorFromAddresses, candidatesAtPoint,
// previewSelector) is a stateless, self-contained operation over whatever
// DOM point/selector it's given — there's nothing that spans multiple calls
// except previewProceduralFiltererAPI (below), which already has an explicit
// reset guard: onMessage()'s 'quitTool' case calls .reset() on it, so a
// closed picker session never leaves stale procedural-filter state behind
// for the next one.
//
// The actual multi-step interactive picker session (hover → select →
// confirm, overlay lifecycle, message port) is owned by the ubolOverlay
// instance this file installs into (see js/scripting/tool-overlay.js) —
// that class already keeps its own state as instance fields (this.frame,
// this.port, this.lastX/this.lastY, etc.) rather than scattered module
// globals, which is the same state-ownership principle B3a asks for, just
// expressed as a class instance instead of a phase-tagged object. Out of
// scope for this specific file.
//
/******************************************************************************/

(async ( ) => {

/******************************************************************************/

const ubolOverlay = self.ubolOverlay;
if ( ubolOverlay === undefined ) { return; }
if ( ubolOverlay.file === '/picker/picker.html' ) { return; }

/******************************************************************************/

function attributeNameFromPart(part) {
    const pos = part.search(/\^?=/);
    return part.slice(1, pos);
}

function selectorFromAddresses(partsDB, addresses) {
    const selector = [];
    let majorLast = -1;
    for ( const address of addresses ) {
        const major = address >>> 12;
        if ( majorLast !== -1 ) {
            const delta = majorLast - major;
            if ( delta > 1 ) {
                selector.push(' ');
            } else if ( delta === 1 ) {
                selector.push(' > ');
            }
        }
        majorLast = major;
        const part = partsDB.get(address);
        selector.push(
            (address & 0xF) === 3
                ? `[${attributeNameFromPart(part)}]`
                : part
        );
    }
    return selector.join('');
}

/*******************************************************************************
 * 
 * Selector part address:
 * 0b00000000_00000000_0000
 *          |        |    |
 *          |        |    +-- 4-bit: Descriptor
 *          |        +------- 8-bit: Part index
 *          +---------------- 8-bit: List index
 * Descriptor:
 * - 0: tag name
 * - 1: id
 * - 2: class
 * - 3: attribute
 * - 4: :nth-of-type
 * List index: 0 is deepest
 * 
 * Selector part addresses are used to reference parts in associated database.
 * 
 * */

// 11.0.2 — number of entries at the top of the element path that are the
// page itself (<body>, then <html>). They are listed so their classes can
// anchor a selector, but the slider never offers them as a target.
const WHOLE_PAGE_DEPTH = 2;

function candidatesAtPoint(x, y) {
    // We need at least one element.
    let elem = null;
    if ( typeof x === 'number' ) {
        elem = ubolOverlay.elementFromPoint(x, y);
    } else if ( x instanceof HTMLElement ) {
        elem = x;
        x = undefined;
    }

    const partsDB = new Map();
    const listParts = [];
    // 11.0.2 — ported from uBO 9510a0b38c: walk up to and including <body>
    // and <html>, so their classes/attributes can anchor a selector. A rule
    // that would hide <html>/<body> itself is refused by
    // js/util/css-selector-guard.js hidesWholePage().
    while ( elem !== null ) {
        const tagName = elem.localName;
        const addressMajor = listParts.length << 12;
        partsDB.set(addressMajor, CSS.escape(tagName));
        const parts = [ addressMajor ];
        // Id
        if ( typeof elem.id === 'string' && elem.id !== '' ) {
            const address = addressMajor | parts.length << 4 | 1;
            partsDB.set(address, `#${CSS.escape(elem.id)}`);
            parts.push(address);
        }
        // Classes
        for ( const name of elem.classList.values() ) {
            const address = addressMajor | parts.length << 4 | 2;
            partsDB.set(address, `.${CSS.escape(name)}`);
            parts.push(address);
        }
        // Attributes
        for ( const name of elem.getAttributeNames() ) {
            if ( name === 'id' || name === 'class' ) { continue; }
            if ( excludedAttributeExpansion.includes(name) ) {
                const address = addressMajor | parts.length << 4 | 3;
                partsDB.set(address, `[${CSS.escape(name)}]`);
                parts.push(address);
                continue;
            }
            let value = elem.getAttribute(name);
            const pos = value.search(/[\n\r]/);
            if ( pos !== -1 ) {
                value = value.slice(0, pos);
            }
            const address = addressMajor | parts.length << 4 | 3;
            partsDB.set(address, `[${CSS.escape(name)}="${value}"]`);
            parts.push(address);
        }
        // https://github.com/chrisaljoudi/uBlock/issues/637
        //   If the selector is still ambiguous at this point, further narrow
        // using `:nth-of-type`.
        const parentNode = elem.parentNode;
        if ( ubolOverlay.qsa(parentNode, `:scope > ${selectorFromAddresses(partsDB, parts)}`).length > 1 ) {
            let i = 1;
            while ( elem.previousSibling !== null ) {
                elem = elem.previousSibling;
                if ( typeof elem.localName !== 'string' ) { continue; }
                if ( elem.localName !== tagName ) { continue; }
                i++;
            }
            const address = addressMajor | parts.length << 4 | 4;
            partsDB.set(address, `:nth-of-type(${i})`);
            parts.push(address);
        }
        listParts.push(parts);
        elem = elem.parentElement;
    }
    if ( listParts.length === 0 ) { return; }

    const sliderCandidates = [];
    // 11.0.2 — ported from uBO 9510a0b38c: the last two entries are <body>
    // and <html> (WHOLE_PAGE_DEPTH); never start a slider candidate there.
    for ( let i = 0, n = Math.max(listParts.length - WHOLE_PAGE_DEPTH, 0); i < n; i++ ) {
        sliderCandidates.push(listParts[i]);
        for ( let j = i + 1; j < n; j++ ) {
            sliderCandidates.push([
                ...listParts[j],
                ...sliderCandidates.at(-1),
            ]);
        }
    }
    const sliderMap = new Map();
    for ( const candidates of sliderCandidates ) {
        if ( candidates.some(a => (a & 0xF) === 1) ) {
            const selectorPath = candidates.filter(a => (a & 0xF) === 1);
            sliderMap.set(JSON.stringify(selectorPath), 0);
        } else if ( candidates.some(a => (a & 0xF) === 4) ) {
            const selectorPath = candidates.filter(a => {
                return a &= 0xF, a === 0 || a === 4;
            });
            sliderMap.set(JSON.stringify(selectorPath), 0);
        }
        if ( candidates.some(a => (a & 0xF) === 2) ) {
            const selectorPath = candidates.filter(a => {
                return a &= 0xF, a === 0 || a === 2;
            });
            sliderMap.set(JSON.stringify(selectorPath), 0);
        }
        const selectorPath = candidates.filter(a => {
            return a &= 0xF, a === 0 || a === 3;
        });
        sliderMap.set(JSON.stringify(selectorPath), 0);
    }
    sliderMap.delete('[]');
    const elemToIdMap = new Map();
    const resultSetMap = new Map();
    let elemId = 1;
    for ( const json of sliderMap.keys() ) {
        const addresses = JSON.parse(json);
        const selector = selectorFromAddresses(partsDB, addresses);
        if ( excludedSelectors.includes(selector) ) { continue; }
        const elems = ubolOverlay.qsa(document, selector);
        if ( elems.length === 0 ) { continue; }
        const resultSet = [];
        for ( const elem of elems ) {
            if ( elemToIdMap.has(elem) === false ) {
                elemToIdMap.set(elem, elemId++);
            }
            resultSet.push(elemToIdMap.get(elem));
        }
        const resultSetKey = JSON.stringify(resultSet.sort());
        const current = resultSetMap.get(resultSetKey);
        if ( current ) {
            if ( current.length < addresses.length ) { continue; }
            if ( current.length === addresses.length ) {
                if ( addresses.some(a => (a & 0xF) === 2) === false ) {
                    if ( current.some(a => (a & 0xF) === 2) ) { continue; }
                }
            }
        }
        resultSetMap.set(resultSetKey, addresses);
    }
    const sliderParts = Array.from(resultSetMap).toSorted((a, b) => {
        let amajor = a[1].at(-1) >>> 12;
        let bmajor = b[1].at(-1) >>> 12;
        if ( amajor !== bmajor ) { return bmajor - amajor; }
        amajor = a[1].at(0) >>> 12;
        bmajor = b[1].at(0) >>> 12;
        if ( amajor !== bmajor ) { return bmajor - amajor; }
        if ( a[0].length !== b[0].length ) {
            return b[0].length - a[0].length;
        }
        return b[1].length - a[1].length;
    }).map(a => a[1]);
    return {
        partsDB: Array.from(partsDB),
        listParts,
        sliderParts,
    };
}

const excludedAttributeExpansion = [
    'sizes',
    'srcset',
];
const excludedSelectors = [
    'div',
    'span',
];

/******************************************************************************/

async function previewSelector(selector) {
    previewSelector.promise = previewSelector.promise.then(( ) =>
        previewSelector.commit(selector)
    );
    return previewSelector.promise;
}

previewSelector.commit = async function(selector) {
    if ( selector === previewSelector.selector ) { return; }
    if ( previewSelector.selector !== '' ) {
        if ( previewSelector.selector.startsWith('{') ) {
            if ( self.pickerProceduralFilteringAPI ) {
                await self.pickerProceduralFilteringAPI.reset();
            }
        }
        if ( previewSelector.css !== '' ) {
            await ubolOverlay.sendMessage({ what: 'removeCSS', css: previewSelector.css });
            previewSelector.css = '';
        }
    }
    previewSelector.selector = selector || '';
    if ( selector === '' ) { return; }
    if ( selector.startsWith('{') ) {
        if ( self.ProceduralFiltererAPI === undefined ) { return; }
        if ( self.pickerProceduralFilteringAPI === undefined ) {
            self.pickerProceduralFilteringAPI = new self.ProceduralFiltererAPI();
        }
        const pselector = JSON.parse(selector);
        if ( pselector.cssable ) {
            self.pickerProceduralFilteringAPI.addDeclaratives([ pselector ]);
        } else {
            self.pickerProceduralFilteringAPI.addProcedurals([ pselector ]);
        }
        return;
    }
    previewSelector.css = `${selector}{display:none!important;}`;
    await ubolOverlay.sendMessage({ what: 'insertCSS', css: previewSelector.css });
};

previewSelector.promise = Promise.resolve();
previewSelector.selector = '';
previewSelector.css = '';

/******************************************************************************/

const previewProceduralFiltererAPI = new self.ProceduralFiltererAPI(); 

/******************************************************************************/

function onMessage(msg) {
    switch ( msg.what ) {
    case 'quitTool':
        previewProceduralFiltererAPI.reset();
        break;
    case 'startCustomFilters':
        return ubolOverlay.sendMessage({ what: 'startCustomFilters' });
    case 'terminateCustomFilters':
        return ubolOverlay.sendMessage({ what: 'terminateCustomFilters' });
    case 'candidatesAtPoint':
        return candidatesAtPoint(msg.mx, msg.my, msg.broad);
    case 'previewSelector':
        return previewSelector(msg.selector);
    default:
        break;
    }
}

/******************************************************************************/

await ubolOverlay.install('/picker/picker.html', onMessage);

/******************************************************************************/

})();


void 0;
