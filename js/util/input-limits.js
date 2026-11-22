// ── input-limits.js ───────────────────────────────────────────────────────────
// Size limits for outside input, checked BEFORE the input is read or parsed (manual C49, F-INPUT-1).
//
// Public interface:
//   INPUT_LIMITS                    — the declared limits (frozen)
//   checkImportFileSize(file)       — { ok: true } or { ok: false, error } for a File the person picked
//
// Dependencies: none (zero-import util file, safe to import from every tier and page).
//
// State owned by this module: none — nothing to initialise, clear or release.
//
// Input trust:
//   checkImportFileSize(file) — UNTRUSTED (a file the person chose); only file.size is read, never the content.
//
// Errors:
//   never throws; a missing or non-numeric size is refused with a reason.
//
// WHY 10 MiB: every file the extension imports (Restore settings, Import custom rules, the Import ABP box) ends up
// in chrome.storage.local. Without the "unlimitedStorage" permission (uBD does not declare it) that whole storage
// area is capped at 10 MiB (chrome.storage.local.QUOTA_BYTES = 10,485,760). A file larger than everything the
// extension can store can never be a valid export of it, and its write would fail later anyway — after the whole
// file had been read and parsed. Real exports are far smaller, so no genuine import is refused.
// ─────────────────────────────────────────────────────────────────────────────

export const INPUT_LIMITS = Object.freeze({
    MAX_IMPORT_FILE_BYTES: 10 * 1024 * 1024,   // = chrome.storage.local.QUOTA_BYTES without unlimitedStorage
    BYTES_PER_MEGABYTE:    1024 * 1024,        // for the message the person sees
});

function megabytesOf(bytes) {
    return (bytes / INPUT_LIMITS.BYTES_PER_MEGABYTE).toFixed(1);
}

export function checkImportFileSize(file) {
    const size = file?.size;
    if ( typeof size !== 'number' || Number.isFinite(size) === false || size < 0 ) {
        return { ok: false, error: 'the file size could not be read' };
    }
    if ( size > INPUT_LIMITS.MAX_IMPORT_FILE_BYTES ) {
        return {
            ok: false,
            error: `the file is ${megabytesOf(size)} MB; the largest file this extension can store is ${megabytesOf(INPUT_LIMITS.MAX_IMPORT_FILE_BYTES)} MB`,
        };
    }
    return { ok: true };
}
