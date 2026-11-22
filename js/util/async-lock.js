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
*/

/*
 * async-lock.js — generic phase-tagged mutex
 *
 * A promise-chain-based, non-reentrant mutex: callers queue via
 * lock.withLock(fn); each fn runs only after every previously-queued fn on
 * the same lock instance has settled (resolved or rejected), one at a time.
 *
 * Extracted from js/core/scripting-manager.js (uBol-stripped-code-review.md
 * §1 / CHANGELOG 5.0.16-5.0.17), which had this exact mechanism inlined
 * twice — once for its general browser.scripting mutex, once for
 * serializing registerContentScripts() calls specifically. Pulled out once
 * both turned out to be the same primitive used twice, not two different
 * mechanisms.
 *
 * Lives in js/util/ (not js/core/) deliberately: zero imports, and nothing
 * scripting/DNR/feature-specific — the five-tier model (ARCHITECTURE.md)
 * describes util/ as "pure, stateless helpers with no dependencies inside
 * the extension", which is what this is: any future module that needs "run
 * these async steps one at a time, and let me inspect whether one is
 * currently running" can use it the same way scripting-manager.js does.
 *
 * Public interface:
 *   createLock(owner)   — owner: string label, used only for
 *                         getState().owner (debugging). Returns a fresh,
 *                         independent lock instance: { withLock(fn), getState() }.
 */

export function createLock(owner) {
    let chain = Promise.resolve();

    // Phase-tagged state vector for this lock instance (uBol-stripped-
    // code-review.md §1's own FUTURE IMPROVEMENT, implemented in 5.0.16).
    // Private to this closure — getState() below only ever returns a
    // snapshot copy, never this object itself, so nothing outside this
    // module can mutate a lock's reported state.
    const state = {
        owner,
        phase: 'idle',    // 'idle' | 'running'
        heldSince: null,  // Date.now() when phase became 'running'; else null
    };

    // Queues `fn` behind every previously-queued call to this same lock
    // instance. `fn` always eventually runs — even if an earlier queued
    // call rejected — since the chain link is unconditionally resolved
    // regardless of outcome (the `.then(() => {}, () => {})` below), so one
    // failed caller can never wedge the queue for later callers. Each
    // caller still observes its own success/failure via the returned
    // promise. try/finally guarantees the phase always resets even if `fn`
    // throws, so a failed caller can never leave the vector stuck reporting
    // 'running' forever.
    function withLock(fn) {
        async function guarded() {
            state.phase = 'running';
            state.heldSince = Date.now();
            try {
                return await fn();
            } finally {
                state.phase = 'idle';
                state.heldSince = null;
            }
        }
        const run = chain.then(guarded, guarded);
        chain = run.then(() => {}, () => {});
        return run;
    }

    // Debugging aid only — see module header. Returns a snapshot, not the
    // live state object.
    function getState() {
        return { ...state };
    }

    return { withLock, getState };
}
