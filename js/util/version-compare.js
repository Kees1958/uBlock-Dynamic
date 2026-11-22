// ── version-compare.js ───────────────────────────────────────────────────────
// "X.Y.Z older than X.Y.Z" — the one version comparator (C21/B15). (11.0.0) Moved here from
// js/core/worry-free-startup-default.js when that module was removed with the "Enable Seamless surfing on startup"
// option (Seamless surfing is always on now — js/data/seamless-switch.js).
//
// Public interface:
//   isVersionOlderThan(version, boundary) — an empty/missing version counts as older (a fresh install or a backup
//                                           without a version: the once-per-install steps then run).
// Pure: no state — nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────

export function isVersionOlderThan(version, boundary) {
    const a = String(version ?? '').split('.').map(n => parseInt(n, 10) || 0);
    const b = boundary.split('.').map(n => parseInt(n, 10) || 0);
    for ( let i = 0; i < Math.max(a.length, b.length); i++ ) {
        const x = a[i] ?? 0, y = b[i] ?? 0;
        if ( x !== y ) { return x < y; }
    }
    return false;
}
