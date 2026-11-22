// ── persisted-timed-state.js ─────────────────────────────────────────────────
// (audit 10.6.4) One storage-mirrored, optionally-expiring state record for every timed feature
// (temporary global disable, cookie-clicker auto-deny) — replaces two near-identical copies of
// readState()/writeState() and the public-state/self-heal block in temp-disable-manager.js and
// cookie-clicker-autodeny-manager.js (audit 10.6.4: B15 near-duplicates, C21 one proven solution).
//
// State record shape (owned by the caller, only these fields are read here):
//   { untilMs: number | null, startedAtMs: number, ...callerFields }
//   untilMs === null means "no expiry" (until browser restart / next session).
//
// Lifecycle (GUARDS):
//   init    — readState(): the ONE place the in-memory mirror goes from undefined (not loaded yet)
//             to its stored value (or null when nothing is stored).
//   perform — writeState(state): mirror and storage are written in the same call, so they never drift.
//   release — writeState(null): the ONE place the stored key is removed; the mirror is reset with it.
//   expiry  — getPublicState(onExpired): a stored expiry that has already passed (e.g. the alarm was
//             missed while the browser was closed) is self-healed by awaiting onExpired() — the
//             caller's own guarded restore — so the feature never stays on forever.
//
// Storage access is injected (read/write/remove), so this util has no dependency on js/data/
// (C15: util depends on nothing). The SW restart path is safe: the mirror is rebuilt from storage
// on the first readState() after a restart.
// ─────────────────────────────────────────────────────────────────────────────

// createPersistedTimedState({ read, write, remove })
//   read   — async () => stored record or undefined/null
//   write  — async (record) => persists the record
//   remove — async () => removes the stored record
export function createPersistedTimedState({ read, write, remove }) {
    if ( typeof read !== 'function' || typeof write !== 'function' || typeof remove !== 'function' ) {
        throw new TypeError('createPersistedTimedState: read, write and remove must be functions');
    }

    let cache;   // undefined = not loaded yet; null = nothing active; object = the active record

    async function readState() {
        if ( cache !== undefined ) { return cache; }
        cache = await read() ?? null;
        return cache;
    }

    async function writeState(state) {
        cache = state;
        if ( state === null ) {
            return remove();
        }
        return write(state);
    }

    // The shape both popups/dashboards render: { active } plus, while active, untilMs,
    // remainingMs (only when there is an expiry) and startedAtMs.
    async function getPublicState(onExpired) {
        const state = await readState();
        if ( state === null ) { return { active: false }; }
        if ( state.untilMs === null ) {
            return { active: true, untilMs: null, startedAtMs: state.startedAtMs };
        }
        if ( Date.now() >= state.untilMs ) {
            await onExpired();
            return { active: false };
        }
        return {
            active: true,
            untilMs: state.untilMs,
            remainingMs: state.untilMs - Date.now(),
            startedAtMs: state.startedAtMs,
        };
    }

    return Object.freeze({ readState, writeState, getPublicState });
}
