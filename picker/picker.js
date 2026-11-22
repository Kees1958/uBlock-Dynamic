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

import { dom, qs$, qsa$ } from '../js/ui/dom.js';
import { localRead, localWrite } from '../js/data/ext.js';
import { ExtSelectorCompiler } from '../js/core/static-filtering-parser.js';
import { toolOverlay } from '../js/ui/tool-overlay-ui.js';
import { hidesWholePage } from '../js/util/css-selector-guard.js';

/******************************************************************************/

const selectorCompiler = new ExtSelectorCompiler({ nativeCssHas: true });

let selectorPartsDB = new Map();
let sliderParts = [];
let sliderPartsPos = -1;

/*******************************************************************************
 * INTRO DIALOG — configuration
 *
 * Every constant, storage key and switch that controls the intro dialog's
 * behaviour is declared here, in one place, so a future change never
 * requires hunting for a second copy of the same value elsewhere in this
 * file.
 *
 * History (read before changing this mechanism again — see CHANGELOG.md):
 * - Pre-6.7.9: gated behind a one-time-only localRead/localWrite
 *   ('picker.introSeen') flag. A user who missed the single 3s showing
 *   never saw it again on ANY future version — read as "the feature is
 *   broken," not "already seen."
 * - 6.7.9: the one-time flag was removed entirely; the dialog was made
 *   to show every time the picker opens, with no way to silence it.
 * - 7.5.10: brought back a "Don't show this again" opt-out, but scoped
 *   narrower than the pre-6.7.9 version on purpose — see
 *   INTRO_HIDE_FLAG_KEY below for why it can only be set by explicit,
 *   deliberate user action.
 ******************************************************************************/

// Instructional text shown in the dialog body.
const INTRO_TEXT = 'Click an element on the page to select it, then refine the ' +
    'highlighted selection using the slider or candidate list below. ' +
    'Click "Create" to hide every matching element on this site.';

// How long the dialog stays up before auto-dismissing (ms). Auto-dismiss
// behaves the same as clicking "Understood" (the picker becomes usable),
// never the same as clicking "Cancel" — a user who walks away from their
// keyboard should not have their picker session silently cancelled.
const INTRO_AUTO_DISMISS_MS = 3000;

// (11.0.2, audit finding 6) A touch counts as a tap (a pick), not a swipe, when it moved less than this many pixels
// and lasted less than this long (uBO values).
const TAP_MAX_DISTANCE_PX = 32;
const TAP_MAX_DURATION_MS = 200;

// browser.storage.local key backing the "Don't show this again" checkbox.
// Deliberately only ever written when the user explicitly checks the box
// and then dismisses via "Understood" (including via auto-dismiss, since
// the checkbox may already be checked when the timer fires) — never as a
// side effect of "Cancel", and never defaulted to true. This keeps the
// opt-out a deliberate, explicit user action rather than something that
// can happen to a user who never asked for it, which is what made the
// pre-6.7.9 version of this flag effectively permanent and unrecoverable
// for anyone who tripped it by accident.
const INTRO_HIDE_FLAG_KEY = 'picker.introSeen';

// Start notice (v9.6.5) — shown INSTEAD of the intro dialog when the
// "Don't show this again" opt-out above is set, so a launch never looks
// like nothing happened. Same wording shape as the Cookie consent
// clicker's own notice (js/scripting/cookie-clicker-picker.js
// START_NOTICE_TEXT) — keep the two in step (C22).
const START_NOTICE_TEXT = 'Click the element to hide it, Esc cancels.';
// How long it stays up (ms). Longer than INTRO_AUTO_DISMISS_MS on purpose:
// it is shown on every qualifying launch (not a one-shot), and a comfortable
// read time costs nothing.
const START_NOTICE_DISPLAY_MS = 6000;

/******************************************************************************/

// Pending auto-dismiss timer handle (undefined = no timer pending). This
// is the one piece of transient state the intro dialog owns; it is
// cleared — never just overwritten — on every path that ends the intro
// dialog's life (explicit dismiss, or the picker quitting outright while
// the dialog is still up), so no stray timer can fire a callback against
// a picker session that no longer exists.
let introTimer;

function clearIntroTimer() {
    if ( introTimer === undefined ) { return; }
    clearTimeout(introTimer);
    introTimer = undefined;
}

function showIntro() {
    qs$('#pickerIntroText').textContent = INTRO_TEXT;
    qs$('#pickerIntroHideNextTime').checked = false;
    dom.cl.add(dom.root, 'showIntro');
    introTimer = setTimeout(onIntroUnderstoodClicked, INTRO_AUTO_DISMISS_MS);
}

function hideIntroDialog() {
    clearIntroTimer();
    dom.cl.remove(dom.root, 'showIntro');
}

// Pending start-notice auto-dismiss timer (undefined = none). Second and
// last piece of transient state this file's intro/notice UI owns; cleared
// on every path that ends the notice (its own timer, or quitPicker()).
let startNoticeTimer;

function hideStartNotice() {
    if ( startNoticeTimer !== undefined ) {
        clearTimeout(startNoticeTimer);
        startNoticeTimer = undefined;
    }
    dom.cl.remove(dom.root, 'showStartNotice');
}

function showStartNotice() {
    hideStartNotice();
    qs$('#pickerStartNotice').textContent = START_NOTICE_TEXT;
    dom.cl.add(dom.root, 'showStartNotice');
    startNoticeTimer = setTimeout(hideStartNotice, START_NOTICE_DISPLAY_MS);
}

// Arms the actual picker. This is the ONLY place that does so —
// startPicker() itself never arms the picker directly, so the picker can
// never become interactive while the intro dialog's instructions haven't
// yet been acknowledged, this session or a previous one.
//
// Opens the picker window immediately, as if the user had already
// clicked the minimize/restore square (□) — done by calling
// onMinimizeClicked() itself rather than duplicating its logic, so this
// stays in sync with whatever a real click does (C21: reuse, don't
// reinvent). That handler both un-minimizes AND pauses (see the
// paused/unpaused state comment above pausePicker()), which is the
// correct combination for "window open, not yet actively picking" —
// exactly the state a manual click produces, so highlightElementUnderMouse
// is intentionally left to that path rather than set here directly.
function armPicker() {
    onMinimizeClicked();
}

// "Understood" — explicit click, or the auto-dismiss timer standing in
// for it. Either way the workflow proceeds into the actual picker.
async function onIntroUnderstoodClicked() {
    const hideNextTime = qs$('#pickerIntroHideNextTime').checked === true;
    hideIntroDialog();
    armPicker();
    if ( hideNextTime === false ) { return; }
    await localWrite(INTRO_HIDE_FLAG_KEY, true);
}

// "Cancel" — stops the whole workflow; never arms the picker. The
// checkbox is deliberately ignored here: cancelling this session isn't
// the same as asking to never see the dialog again.
function onIntroCancelClicked() {
    hideIntroDialog();
    quitPicker();
}

/******************************************************************************/

// 11.0.2 — shown as the hover text of "Error" when a rule would hide or
// remove <html>/<body> itself (the service worker refuses it as well).
const WHOLE_PAGE_ERROR_TEXT = 'This would hide the whole page. Pick a smaller part.';

function validateSelector(selector) {
    validateSelector.error = undefined;
    if ( selector === '' ) { return; }
    const result = {};
    if ( selectorCompiler.compile(selector, result) ) {
        if ( hidesWholePage(result.compiled) ) {
            validateSelector.error = WHOLE_PAGE_ERROR_TEXT;
            return;
        }
        return result.compiled;
    }
    validateSelector.error = 'Error';
}

/******************************************************************************/

function onSvgTouch(ev) {
    if ( ev.type === 'touchstart' ) {
        onSvgTouch.x0 = ev.touches[0].screenX;
        onSvgTouch.y0 = ev.touches[0].screenY;
        onSvgTouch.t0 = ev.timeStamp;
        return;
    }
    if ( onSvgTouch.x0 === undefined ) { return; }
    const stopX = ev.changedTouches[0].screenX;
    const stopY = ev.changedTouches[0].screenY;
    const distance = Math.sqrt(
        Math.pow(stopX - onSvgTouch.x0, 2) +
        Math.pow(stopY - onSvgTouch.y0, 2)
    );
    // Interpret touch events as a tap if:
    // - Swipe is not valid; and
    // - The time between start and stop was less than 200ms.
    const duration = ev.timeStamp - onSvgTouch.t0;
    if ( distance >= TAP_MAX_DISTANCE_PX || duration >= TAP_MAX_DURATION_MS ) { return; }
    onSvgClicked({
        type: 'touch',
        target: ev.target,
        clientX: ev.changedTouches[0].pageX,
        clientY: ev.changedTouches[0].pageY,
    });
    ev.preventDefault();
}
onSvgTouch.x0 = onSvgTouch.y0 = 0;
onSvgTouch.t0 = 0;

/******************************************************************************/

function onSvgClicked(ev) {
    // Ignore clicks on the page while the intro popup is up.
    if ( dom.cl.has(dom.root, 'showIntro') ) { return; }
    // BUG FIXED (v8.6.2): a click on the page while paused (the candidate
    // dialog is open after a previous selection) used to only unpause the
    // picker and `return` — silently discarding THIS click's own target,
    // so the person had to click a second time for it to actually
    // register as a pick. svg#overlay only ever receives clicks meant
    // for the page itself (the dialog panel is a separate element with
    // its own button handlers — confirmed in picker.css: the overlay
    // stays clickable, cursor: not-allowed, while paused, rather than
    // being disabled), so there's no case where falling through here
    // could misfire on a dialog-panel click. One click now both
    // dismisses the open dialog AND picks the new target underneath it.
    if ( dom.cl.has(dom.root, 'paused') ) {
        if ( dom.cl.has(dom.root, 'preview') ) {
            updatePreview(false);
        }
        unpausePicker();
    }
    // Force dialog to always be visible when using a touch-driven device.
    if ( ev.type === 'touch' ) {
        dom.cl.add(dom.root, 'show');
    }
    toolOverlay.postMessage({
        what: 'candidatesAtPoint',
        mx: ev.clientX,
        my: ev.clientY,
        broad: ev.ctrlKey,
    }).then(details => {
        showDialog(details);
    });
}

/******************************************************************************/

function onKeyPressed(ev) {
    if ( ev.key === 'Escape' || ev.which === 27 ) {
        quitPicker();
        return;
    }
}

/******************************************************************************/

function onMinimizeClicked() {
    if ( dom.cl.has(dom.root, 'paused') === false ) {
        pausePicker();
        highlightCandidate();
        return;
    }
    dom.cl.toggle(dom.root, 'minimized');
}

/******************************************************************************/

function onFilterTextChanged() {
    highlightCandidate();
}

/******************************************************************************/

function toggleView(view, persist = false) {
    dom.root.dataset.view = `${view}`;
    if ( persist !== true ) { return; }
    localWrite('picker.view', dom.root.dataset.view);
}

function onViewToggled(dir) {
    let view = parseInt(dom.root.dataset.view, 10);
    view += dir;
    if ( view < 0 ) { view = 0; }
    if ( view > 2 ) { view = 2; }
    toggleView(view, true);
}

/******************************************************************************/

function selectorFromCandidates() {
    const selectorParts = [];
    let liPrevious = null;
    for ( const li of qsa$('#candidateFilters li') ) {
        const selector = [];
        for ( const span of qsa$(li, '.on[data-part]') ) {
            selector.push(span.textContent);
        }
        if ( selector.length !== 0 ) {
            if ( liPrevious !== null ) {
                if ( li.previousElementSibling === liPrevious ) {
                    selectorParts.unshift(' > ');
                } else if ( liPrevious !== li ) {
                    selectorParts.unshift(' ');
                }
            }
            liPrevious = li;
            selectorParts.unshift(selector.join(''));
        }
    }
    return selectorParts.join('');
}

/******************************************************************************/

function onSliderChanged(ev) {
    updateSlider(Math.round(ev.target.valueAsNumber));
}

function updateSlider(i) {
    if ( i === sliderPartsPos ) { return; }
    const parts = sliderParts[i];
    if ( Array.isArray(parts) === false ) { return; }   // (11.0.2 fix) GUARD: no slider position i
    sliderPartsPos = i;
    dom.cl.remove('#candidateFilters [data-part]', 'on');
    for ( const address of parts ) {
        dom.cl.add(`#candidateFilters [data-part="${address}"]`, 'on');
    }
    const selector = selectorFromCandidates();
    qs$('textarea').value = selector;
    highlightCandidate();
}

/******************************************************************************/

function updateElementCount(details) {
    const { count, error } = details;
    const span = qs$('#resultsetCount');
    if ( error ) {
        span.textContent = 'Error';
        span.setAttribute('title', error);
        dom.attr('#create', 'disabled', '');
    } else {
        span.textContent = count;
        span.removeAttribute('title');
        dom.attr('#create', 'disabled', null);
    }
    updatePreview();
}

/******************************************************************************/

function onPreviewClicked() {
    dom.cl.toggle(dom.root, 'preview');
    updatePreview();
}

function updatePreview(state) {
    if ( state === undefined ) {
        state = dom.cl.has(dom.root, 'preview');
    } else {
        dom.cl.toggle(dom.root, 'preview', state)
    }
    const selector = state && validateSelector(qs$('textarea').value) || '';
    return toolOverlay.postMessage({ what: 'previewSelector', selector });
}

/******************************************************************************/

async function onCreateClicked() {
    const selector = validateSelector(qs$('textarea').value);
    if ( selector === undefined ) { return; }

    await toolOverlay.postMessage({ what: 'terminateCustomFilters' });
    await toolOverlay.sendMessage({
        what: 'addCustomFilters',
        // Deliberately the EXACT current hostname, not normalized to
        // eTLD+1 — a cosmetic selector is tied to this specific page's
        // DOM, so precision here matters more than automatically also
        // matching sibling subdomains that may look completely
        // different. Contrast with Dynamic DNR overrides
        // (js/core/matrix-block-rules.js), which deliberately DO
        // normalize to eTLD+1 for the opposite reason — see
        // dashboard/custom-rules.js's own file-header DESIGN NOTE for
        // the full trade-off both sides of this choice.
        hostname: toolOverlay.url.hostname,
        selectors: [ selector ],
    });
    await toolOverlay.postMessage({ what: 'startCustomFilters' });
    qs$('textarea').value = '';
    dom.cl.remove(dom.root, 'preview');
    // REVERTED (v8.6.2): v8.5.6 changed this from quitPicker() to
    // resetPicker() so the tool stayed armed after creating a filter,
    // per that release's own explicit request — reverted back to
    // quitPicker() per a later explicit request ("dit werkt toch niet"),
    // after real-world use showed the stay-open behavior didn't work
    // out in practice. Creating a filter closes the picker again now,
    // same as before v8.5.6.
    quitPicker();
}

/******************************************************************************/

function attributeNameFromSelector(part) {
    const pos = part.search(/\^?=/);
    return part.slice(1, pos);
}

/******************************************************************************/

function onCandidateClicked(ev) {
    const target = ev.target;
    if ( target.matches('[data-part]') ) {
        const address = target.dataset.part;
        const part = selectorPartsDB.get(parseInt(address, 10));
        if ( part.startsWith('[') ) {
            if ( target.textContent === part ) {
                target.textContent = `[${attributeNameFromSelector(part)}]`;
                dom.cl.remove(target, 'on');
            } else if ( dom.cl.has(target, 'on') ) {
                target.textContent = part;
            } else {
                dom.cl.add(target, 'on');
            }
        } else {
            dom.cl.toggle(target, 'on');
        }
    } else if ( target.matches('li') ) {
        if ( qs$(target, ':scope > span:not(.on)') !== null ) {
            dom.cl.add(qsa$(target, ':scope > [data-part]:not(.on)'), 'on');
        } else {
            dom.cl.remove(qsa$(target, ':scope > [data-part]'), 'on');
        }
    }
    const selector = selectorFromCandidates();
    qs$('textarea').value = selector;
    highlightCandidate();
}

/******************************************************************************/

// (11.0.2 fix) GUARD: a click with nothing pickable under it — no element at all, or only <body>/<html> (which the
// slider never offers, js/scripting/picker.js WHOLE_PAGE_DEPTH) — gives no candidates. Ignored: the picker stays in
// picking mode. Before, the dialog opened on that empty reply and threw ("reading 'partsDB'", "parts is not iterable").
function hasPickCandidates(msg) {
    return msg !== null && typeof msg === 'object' &&
        Array.isArray(msg.partsDB) && Array.isArray(msg.listParts) &&
        Array.isArray(msg.sliderParts) && msg.sliderParts.length !== 0;
}

function showDialog(msg) {
    if ( hasPickCandidates(msg) === false ) { return; }
    pausePicker();

    /* global */selectorPartsDB = new Map(msg.partsDB);
    const { listParts } = msg;
    const root = qs$('#candidateFilters');
    const ul = qs$(root, 'ul');
    while ( ul.firstChild !== null ) {
        ul.firstChild.remove();
    }
    for ( const parts of listParts ) {
        const li = document.createElement('li');
        for ( const address of parts ) {
            const span = document.createElement('span');
            const part = selectorPartsDB.get(address);
            span.dataset.part = address;
            if ( part.startsWith('[') ) {
                span.textContent = `[${attributeNameFromSelector(part)}]`;
            } else {
                span.textContent = part;
            }
            li.append(span);
        }
        ul.appendChild(li);
    }

    /* global */sliderParts = msg.sliderParts;
    /* global */sliderPartsPos = -1;
    const slider = qs$('#slider');
    const last = sliderParts.length - 1;
    dom.attr(slider, 'max', last);
    dom.attr(slider, 'value', last);
    dom.attr(slider, 'disabled', last !== 0 ? null : '');
    slider.value = last;
    updateSlider(last);
}

/******************************************************************************/

function highlightCandidate() {
    const selector = validateSelector(qs$('textarea').value);
    if ( selector === undefined ) {
        toolOverlay.postMessage({ what: 'unhighlight' });
        updateElementCount({ count: 0, error: validateSelector.error });
        return;
    }
    toolOverlay.postMessage({
        what: 'highlightFromSelector',
        selector,
    }).then(result => {
        updateElementCount(result);
    });
}

/*******************************************************************************
 * 
 * paused:
 * - select element mode disabled
 * - preview mode enabled or disabled
 * - dialog unminimized
 * 
 * unpaused:
 * - select element mode enabled
 * - preview mode disabled
 * - dialog minimized
 * 
 * */

function pausePicker() {
    dom.cl.add(dom.root, 'paused');
    dom.cl.remove(dom.root, 'minimized');
    toolOverlay.highlightElementUnderMouse(false);
}

function unpausePicker() {
    dom.cl.remove(dom.root, 'paused', 'preview');
    dom.cl.add(dom.root, 'minimized');
    updatePreview(false);
    toolOverlay.highlightElementUnderMouse(true);
}

/******************************************************************************/

async function startPicker() {
    toolOverlay.postMessage({ what: 'startTool' });

    localRead('picker.view').then(value => {
        if ( Boolean(value) === false ) { return; }
        toggleView(value);
    });

    self.addEventListener('keydown', onKeyPressed, true);
    dom.on('svg#overlay', 'click', onSvgClicked);
    dom.on('svg#overlay', 'touchstart', onSvgTouch, { passive: true });
    dom.on('svg#overlay', 'touchend', onSvgTouch);
    dom.on('#minimize', 'click', onMinimizeClicked);
    dom.on('textarea', 'input', onFilterTextChanged);
    dom.on('#quit', 'click', quitPicker);
    dom.on('#slider', 'input', onSliderChanged);
    dom.on('#pick', 'click', resetPicker);
    dom.on('#preview', 'click', onPreviewClicked);
    dom.on('#moreOrLess > span:first-of-type', 'click', ( ) => { onViewToggled(1); });
    dom.on('#moreOrLess > span:last-of-type', 'click', ( ) => { onViewToggled(-1); });
    dom.on('#create', 'click', ( ) => { onCreateClicked(); });
    dom.on('#candidateFilters ul', 'click', onCandidateClicked);
    dom.on('#pickerIntroCancel', 'click', onIntroCancelClicked);
    dom.on('#pickerIntroOk', 'click', onIntroUnderstoodClicked);

    // Guard: the picker only ever becomes interactive through armPicker(),
    // reached from exactly one of the two branches below — never from
    // startPicker() itself. This is what stops element hover-highlighting
    // from being live behind the intro dialog before it's acknowledged.
    const hideFlag = await localRead(INTRO_HIDE_FLAG_KEY);
    if ( hideFlag === true ) {
        armPicker();
        showStartNotice();
        return;
    }
    showIntro();
}

/******************************************************************************/

function quitPicker() {
    // Guard: release the pending auto-dismiss timer (if any) so it can
    // never fire against a picker session that's already gone.
    clearIntroTimer();
    hideStartNotice(); // RELEASE — start notice + its auto-dismiss timer (v9.6.5)
    updatePreview(false);
    toolOverlay.stop();
}

/******************************************************************************/

function resetPicker() {
    toolOverlay.postMessage({ what: 'unhighlight' });
    unpausePicker();
}

/******************************************************************************/

function onMessage(msg) {
    switch ( msg.what ) {
    case 'startTool':
        startPicker();
        break;
    default:
        break;
    }
}

/******************************************************************************/

// Wait for the content script to establish communication
toolOverlay.start(onMessage);

/******************************************************************************/
