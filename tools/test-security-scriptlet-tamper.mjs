#!/usr/bin/env node
/*******************************************************************************

    uBlock-Stripped-Dynamic — MAIN-world security scriptlet tamper test
    Run: node tools/test-security-scriptlet-tamper.mjs [dir] [--expect-fail]

    What it checks (principle C35, audit 9.7.5): every js/security/sec-*.js
    protection runs in the page's own JavaScript realm, where page code can
    replace any builtin after injection. Each case below loads one real
    scriptlet file into a fresh realm, then performs one concrete page-side
    tampering move, then asserts that the protection still holds AND that
    the unprotected original was not handed to page code.

    (10.3.0 removal) js/security/ was cut to one file, sec-pings.js — twelve others were deleted along
    with the Privacy & Security tab sections and Worry-free tiers that gated them (see CHANGELOG.md's
    10.3.0 entry); their VM-realm and fake-API tamper cases were deleted with them, same reasoning as
    below.

    (10.5.0 removal) sec-pings.js itself — the last MAIN-world security scriptlet — was removed
    outright (owner's request, low standalone value); js/security/ no longer exists. PING_CASES below
    is deleted for the identical reason the 10.3.0 cases above it were: reporting "BYPASS" for a file
    that no longer ships is a false positive, not a regression. This check now only confirms there is
    nothing left to tamper-test (js/security/ absent) — it stays in the suite, not deleted outright,
    so it starts failing loudly instead of silently if a MAIN-world security scriptlet is ever added
    again without a matching tamper case here.

    Real files, not re-implementations (Part D step 15): each case reads the
    actual scriptlet source from disk.

    --expect-fail (with a directory holding the OLD files) inverts the exit
    status: it passes only if EVERY case fails there. That is how this
    check was proven to detect the bug class it claims to (C25 step 5).

*******************************************************************************/

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// 'jsdom' import removed with the last tamper case (10.5.0) — re-add `import { JSDOM } from 'jsdom';`
// when CASES below gets its first entry again; it is still a project dependency either way.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── CONFIG ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const EXPECT_FAIL = args.includes('--expect-fail');
const SCRIPTLET_DIR = path.resolve(args.find(a => !a.startsWith('--')) ?? path.join(ROOT, 'js', 'security'));

// ── CASES ─────────────────────────────────────────────────────────────────
// No MAIN-world security scriptlets ship any more (10.5.0 — sec-pings.js, the last one, was removed
// outright). When one ships again: restore the 'jsdom' import above, add a CASES array of
// [name, tamper(window)] pairs and a runCase([name, tamper]) runner (read the file from SCRIPTLET_DIR,
// eval it into a fresh JSDOM window, apply tamper, assert the protection held — see this file's git
// history pre-10.5.0 for the sec-pings.js version of exactly that shape), and replace the MAIN block
// below with the scored pass/fail loop it used to run.

// ── MAIN ──────────────────────────────────────────────────────────────────
console.log(`=== MAIN-world security scriptlet tamper test (C35) — ${path.relative(ROOT, SCRIPTLET_DIR) || SCRIPTLET_DIR}${EXPECT_FAIL ? ' — EXPECT-FAIL mode' : ''} ===`);

const dirExists = fs.existsSync(SCRIPTLET_DIR);
const shippedFiles = dirExists ? fs.readdirSync(SCRIPTLET_DIR).filter(f => f.endsWith('.js')) : [];

// Guard against silent drift: if a scriptlet file ever ships again without this file being updated to
// test it (see the CASES comment above), fail loudly here rather than reporting a hollow "PASS" for a
// file nothing actually tamper-tested.
if ( shippedFiles.length > 0 ) {
    console.log(`FAIL: ${shippedFiles.length} MAIN-world security scriptlet(s) ship (${shippedFiles.join(', ')}) but this test has no cases for any of them — add some.`);
    process.exit(EXPECT_FAIL ? 0 : 1);
}
console.log('No MAIN-world security scriptlets ship (js/security/ absent) — nothing to tamper-test.');
process.exit(EXPECT_FAIL ? 1 : 0);
