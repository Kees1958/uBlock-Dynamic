// ── tools/build/build-paths.mjs ───────────────────────────────────────────────────────
// The two filesystem anchors every build module needs: the tools/ directory and the repo root.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: __dirname, ROOT
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import path from 'path';
import { fileURLToPath } from 'url';

// tools/ directory (this file lives in tools/build/) — same value the old
// single build script computed as its own __dirname.
export const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(__dirname, '..');
