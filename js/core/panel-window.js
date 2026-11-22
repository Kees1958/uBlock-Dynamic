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

// ── panel-window.js ─────────────────────────────────────────────────────────
// Opens a dedicated extension panel (Matrix, Privacy Inspector, ...) in its
// own popup-type window — focusing an already-open instance instead of
// spawning a duplicate, and cleaning up the extra blank tab Chrome
// sometimes adds alongside the one actually requested.
//
// Public interface:
//   openOrFocusPanel(url) — opens `url` in a new popup window sized for
//                            this project's panel UIs, or focuses the
//                            existing one if already open.
//
// Dependencies (must be loaded before this file):
//   ../data/ext.js: browser
//
// State owned by this module:
//   none — every call is self-contained; nothing survives between calls.
//
// History: extracted from popup/popup.js (originally the only caller) so
// background.js's own right-click context-menu entries (see
// js/workflow/background.js's "Right-click context menu" section) can
// launch the same panels without a popup window ever having been open —
// reuse per this project's own C21 principle
// (Xplainer_Programming_principles_conscript.md): one proven, tested
// implementation of the ghost-tab guard's two-pass logic, not a second,
// independently-written copy that could drift from it.
//
// (10.7.6) Moved from js/util/ to js/core/ — it calls browser APIs (windows, tabs), so it is not one of
// util/'s zero-import pure helpers (C15). Code unchanged; only its folder moved.
// ─────────────────────────────────────────────────────────────────────────────

import { browser } from '../data/ext.js';
import { catchExpected, EXPECTED_ERRORS } from '../data/expected-errors.js';

// ── PANEL_WINDOW_CONFIG ─────────────────────────────────────────────────────
// Single declared place for every magic number this module uses.
const PANEL_WINDOW_CONFIG = Object.freeze({
    // Calculated, not guessed, from two competing constraints (carried
    // over verbatim from this module's original home in popup.js):
    //   1. Privacy Inspector's #monitorHelp paragraph ("Shows privacy-
    //      sensitive API calls..."), 151 characters at 0.82em regular
    //      weight, needs ~889px to fit on one line without wrapping.
    //   2. Matrix panel's "Show:" filter bar (12 checkboxes after the
    //      Legitimate-signals merge) needs only ~771px minimum to stay
    //      at 2 lines — well under constraint 1's requirement, so it
    //      isn't the binding constraint here.
    // 916px satisfies both (889px + ~3% margin). Re-measure both if
    // either #monitorHelp's text or SHORT_LABELS/FILTER_GROUPS changes.
    WIDTH: 916,
    HEIGHT: 540,
    // Delay before the second, belt-and-suspenders ghost-tab sweep (see
    // the BUG FIX comment below) — long enough for a late-arriving
    // Chrome-added tab to have shown up, short enough not to be
    // noticeable if it finds nothing.
    GHOST_TAB_RECHECK_DELAY_MS: 800,
});

// BUG FIX: Chrome sometimes spawns an extra blank tab (chrome://newtab/ or
// about:blank) in the same new window alongside the one actually requested
// in windows.create() — a known Chrome quirk. windows.create()'s resolved
// Window object already includes the tabs it just created, so whichever
// one isn't ours can be detected and closed instead of left behind.
export async function openOrFocusPanel(url) {
    const existing = await browser.tabs.query({ url });
    if ( existing.length > 0 ) {
        // (11.0.2, audit 11.0.2 finding 4) The window may close between query() and update(): expected, not logged.
        await browser.windows.update(existing[0].windowId, { focused: true })
            .catch(catchExpected('focus panel window', [ EXPECTED_ERRORS.TAB_GONE ]));
        return;
    }
    const win = await browser.windows.create({
        url,
        type: 'popup',
        width: PANEL_WINDOW_CONFIG.WIDTH,
        height: PANEL_WINDOW_CONFIG.HEIGHT,
        focused: true,
    });
    // BUG FIX: comparing tabs[i].url/pendingUrl against `url` here is
    // unreliable — navigation to `url` may not have committed yet by the
    // time this promise resolves, so the *real* tab's url/pendingUrl can
    // still be empty at this exact moment. The tab requested is reliably
    // the first one in the array; only remove anything beyond that, by
    // position, not by URL.
    const extraTabs = (win?.tabs ?? []).slice(1);
    if ( extraTabs.length > 0 ) {
        await browser.tabs.remove(extraTabs.map(t => t.id)).catch(catchExpected('remove ghost tab', [ EXPECTED_ERRORS.TAB_GONE ]));
    }

    // SECOND PASS, delayed: the check above only catches a ghost tab
    // Chrome has already added by the moment windows.create()'s promise
    // resolves. If Chrome adds one slightly later instead, this re-check
    // catches it too — belt-and-suspenders alongside the synchronous
    // check above, not a replacement for it. See this project's own C23
    // (check version history before touching a mechanism with prior
    // documented fixes) — this timing gap was found and fixed once
    // already; this comment is that history for the next person.
    setTimeout(async () => {
        const stillThere = await browser.tabs.query({ windowId: win.id }).catch(catchExpected('query panel window tabs', [ EXPECTED_ERRORS.TAB_GONE ], []));
        const lateGhosts = stillThere.slice(1);
        if ( lateGhosts.length > 0 ) {
            await browser.tabs.remove(lateGhosts.map(t => t.id)).catch(catchExpected('remove late ghost tab', [ EXPECTED_ERRORS.TAB_GONE ]));
        }
    }, PANEL_WINDOW_CONFIG.GHOST_TAB_RECHECK_DELAY_MS);
}
