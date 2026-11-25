#!/usr/bin/env node
// complete-check.mjs — the full "before you zip" validation pass.
//
// Runs, in order:
//   1. node --check on every extension JS file (syntax)
//   2. ESLint (npm run lint's own config)
//   3. CSS structural validation (brace + comment balance, real parser)
//   4. HTML structural validation (parses cleanly)
//   5. JSDOM dry-run (tools/test-dashboard-dry-run.mjs) — live module
//      execution against the real DOM
//   6. Functional smoke test (tools/test-core-modules-dry-run.mjs) —
//      exercises the Map-converted core modules end-to-end
//   7. C20a — message-type routing cross-reference
//   8. C20  — manifest/file-reference cross-reference
//   9. DNR rule-ID range collision check (+ priority-window invariants, v9.6.4)
//   (9a. "High-risk site list sync," v9.6.4, and 9b "Fingerprint script copy sync," v9.6.8, BOTH
//        REMOVED in 10.3.0 along with the files they checked — see their own former location,
//        further down, for the full entry.)
//   (9c. "Advanced tier + tier hierarchy drift," v9.7.0, REMOVED — see this
//        step's own former location, further down, for the full entry.)
//  10. Dead-export check (informational)
//  11. CSS class cross-reference check
//  12. Chrome DNR regexFilter constraints (RE2 syntax, ASCII-only,
//      1000-rule cap distinct from any feature's own general rule budget)
//  13. Scriptlet exception-rule logic (tools/check-scriptlet-exception-logic.mjs)
//      — parsers + collectMatchingRules() cancellation contract, against
//      the real implementation, across every hostname-hierarchy/args/name
//      branch identified during the exception-feature review
//  14. Scripting site-mode gating (tools/check-scripting-site-mode-gating.mjs)
//      — every browser.scripting call site must be classified gated/
//      downstream/exempt against the recurring bug class in
//      ARCHITECTURE.md's HARD CONSTRAINT of the same name
//  15. Cosmetic exception-rule logic (tools/check-cosmetic-exception-logic.mjs)
//      — the `hostname#@#selector` feature, added in parity with the
//      scriptlet exception feature (#13), verified end-to-end through the
//      real injectCustomFilters()/registerCustomFilters() API surface
//  16. Cosmetic SPECIFIC-DATA format equivalence
//      (tools/check-cosmetic-specific-format-equivalence.mjs) — the new
//      storage-backed cosmetic format (live as of 7.7.9, see
//      js/core/scripting-manager.js's registerCosmeticContentScriptsImpl())
//      produces identical lookup results to the old embedded-blob format,
//      differentially tested against every real generated ruleset — see
//      that file's own header for the one documented, accepted exception
//      (dormant bare-TLD entries). Promoted here from a standalone-only
//      script per CHANGELOG.md's "COSMETIC-RULE OPTIMIZATION STATUS"
//      block, "what's not done" step 3.
//  17. Knip whole-tree unused-file/unused-export/unused-dependency and
//      duplicate-export scan — HARD since the audit after 9.7.5 (it had
//      crashed silently on every run while "informational"; see
//      tools/check-knip-dead-code.mjs and principle C38). Broader than #10,
//      which stays js/core-only by design.
//  18. depcheck unused/missing devDependency check
//      (tools/check-depcheck.mjs) — hard check, low false-positive risk
//      for this project's small devDependency list
//  19. Version-congruence check (tools/check-version-sync.mjs) — real
//      incident (tools v1.7.0): package.json, package-release-state.json,
//      and CHANGELOG.md had silently drifted to three different tools
//      version numbers. Hard check now enforces they stay congruent and
//      that every shipped version has a CHANGELOG record.
//  20. stylelint, style-guide-derived rules only (informational — see
//      tools/check-stylelint-style-guide.mjs; encodes
//      STYLE_GUIDE_LIGHT.md/STYLE_GUIDE_DARK.md's proven-safe opacity
//      tables and the documented --color-green/--color-amber-as-text
//      bug as real lint rules, per A9)
//  21. JSON syntax (tools/check-json-syntax.mjs) — ported from
//      tools/self-test.mjs, now retired (see CHANGELOG — it was an
//      explicit stopgap for a missing complete-check.mjs, no longer
//      missing)
//  22. CMP data consistency + hash trip-wire
//      (tools/check-autoconsent-cmp-consistency.mjs) — ported from
//      self-test.mjs; rules.json ↔ eval-snippets.js ↔ generated bundle
//  23. Popup DOM-id references (tools/check-popup-dom-refs.mjs) —
//      ported from self-test.mjs
//  24. Seamless surfing popup line e2e (tools/e2e_seamless_line.mjs) — 10.7.1: replaces the countdown e2e
//      (the countdown was removed); one line, "<mode> - accept|decline" while a session runs
//  25. Seamless surfing prompt e2e (tools/e2e_seamless_prompt.mjs) — 10.7.1: replaces the reopen e2e;
//      Cancel / Accept cookies / Decline cookies and the exact message each sends
//  26. madge circular-dependency check (tools/check-circular-deps.mjs)
//      — hard check, automates part of C15's tier-flow rule (the
//      unambiguous "no cycles" subset; tier-direction itself still
//      needs manual review)
//  27. jscpd duplicate-code scan (tools/check-duplicate-code.mjs) —
//      informational (B15); this exact tool, run manually, is what
//      found the worry-free-ui-test.js drift fixed this pass (see
//      CHANGELOG) — now standing, not manual-only
//  28. c8 coverage report (tools/check-coverage.mjs) — informational,
//      real V8 execution coverage of the dry-run test scripts (not
//      simulated, but also not real-browser/user coverage — see that
//      file's own header)
//  29. (REMOVED in the audit after 9.7.5) Semgrep cross-check for step 14.
//      Semgrep was never installed, so the step never ran and only looked
//      like coverage (principle C38). Its purpose — resolving arrow
//      functions / function expressions / methods — is now built into
//      steps 14 and 31 themselves via tools/lib/scripting-call-sites.mjs
//      (espree parser). Number kept unused so earlier step references
//      stay valid.
//  30. Message-derived hostname/site trust boundary (C28)
//      (tools/check-message-hostname-trust.mjs)
//  31. Scripting batch-registration (tools/check-scripting-batch-calls.mjs)
//      — C25: guards ARCHITECTURE.md's "HARD CONSTRAINT — batch
//      browser.scripting (un)registration, never one call per directive"
//      (found 3 independent times: scriptlet/cosmetic/security
//      registration each looped registerContentScripts()/
//      updateContentScripts() once per directive instead of batching).
//      Fails if a new per-directive loop appears outside the shared
//      registerOrUpdateContentScripts() helper.
//  32. Entity-dispatch coverage (tools/check-entity-dispatch-coverage.mjs)
//      — guards ARCHITECTURE.md's "HARD CONSTRAINT — every compiled
//      hostname dispatch table must account for entity-style (name.*)
//      keys" (found independently in cosmetic's hasEntities flag and the
//      scriptlet dispatch loop — both compiled real ABP entity domain
//      tokens into their dispatch tables with no runtime path that could
//      ever reach them). Fails if a compiled ruleset contains an
//      entity-style key its own dispatch mechanism doesn't account for.
//  33. Manifest permissions <-> browser.* API usage (C19)
//      (tools/check-manifest-permissions.mjs) — the check the 8.6.0
//      incident (a permission silently dropped from manifest.json; every
//      other check passed; the service worker failed to register) showed
//      was missing. Fails on: an API used but its permission not declared;
//      a permission declared but never used; an unclassified permission;
//      declarativeNetRequestFeedback in the manifest; or non-comment code
//      calling the unpacked-only onRuleMatchedDebug/testMatchOutcome/
//      getMatchedRules. Proven able to fail by injection (see
//      CHANGELOG_HISTORY.md 9.7.3), not just shown to pass.
//  34. Optimization-change functional dry-run
//      (tools/test-optimization-dry-run.mjs) — exercises the real bulk
//      cosmetic/scriptlet functions and the css-user registration diff
//      logic against mocked storage/scripting/DNR. It had real assertions
//      and passed, but was wired into neither this suite nor `npm test`
//      until 9.7.3 — an unwired check protects nothing.
//  35. MAIN-world security scriptlet tamper resistance (C35)
//      (tools/test-security-scriptlet-tamper.mjs) — loads each real
//      js/security/sec-*.js into a fresh realm, replaces the builtins it
//      depends on, and asserts the protection holds and never hands the
//      unprotected original to page code; baseline cases confirm
//      untampered behavior is unchanged. Proven with --expect-fail
//      against the pre-9.7.6 files (all 21 tamper cases were bypasses).
//  36. C33 — no dynamic import() in the service worker import graph
//      (tools/check-sw-no-dynamic-import.mjs; espree parser, walks the real
//      static graph from manifest.json's service_worker entry).
//  37. C36 — no unapproved permission additions since the last PUBLISHED
//      release (tools/check-permission-additions.mjs; baseline written by
//      package-release.mjs into package-release-state.json).
//  38. C31 — JSON-lossy message responses: the detector's cases and its
//      wiring into background.js's router (tools/test-json-safe.mjs).
//  40. $worryfree per-site exemption (tools/test-worryfree-exemption.mjs)
//      — the shared option-line parser ($worryfree, with the retired $saferegions dropped and
//      counted, B15) and the three whole-site DNR allow rules (matching the SITE the user is on,
//      not the request destination). (10.3.0) No longer tests the scriptlet half — every Worry-
//      free-gated scriptlet was retired along with the Privacy & Security tab's extra protections;
//      see CHANGELOG.md 10.3.0.
//  (39 REMOVED in 10.3.0 — ClickFix clipboard protection detection corpus. js/security/sec-
//      clickfix-clipboard.js is deleted; that protection moved to 3P-Matrix.)
//  43. Worry-free annoyances list source gate (tools/test-annoyances-source.mjs)
//      — drives the REAL gateAnnoyanceLines() from tools/build/annoyances-sources.mjs:
//      top-1M required for every TLD, out-of-scope TLDs dropped, only host-anchored
//      literal-host network rules kept (a rule the Worry-free suppression rule cannot
//      scope would block outside a session), one category-filtered source. The runtime
//      half (session gate + $worryfree exemption) is in step 40's test, section 4.
//  44. Worry-free annoyances list network suppression (tools/test-annoyances-suppression.mjs)
//      — drives the REAL reconcileWorryFreeExtraSuppressionRule() against the SHIPPED
//      rulesets/ruleset_annoyances.json: every block rule's host must be inside the
//      suppression rule's requestDomains, or that rule would block outside a Worry-free
//      session. (A first build produced exactly one such rule; this is the guard.)
//  45. Worry-free annoyances list content-script gate (tools/test-annoyances-registration.mjs)
//      — drives the REAL registerScriptletContentScripts()/registerCosmeticContentScripts()
//      against the shipped registries: not registered without a session or with the checkbox
//      off, registered (with the $worryfree exclusions) during one, unregistered and its
//      storage-backed data released afterwards. Fault-injection verified: removing the
//      cosmetic gate makes it fail in 5 places.
//  (46 REMOVED in 10.3.0 — "Strict 3P block stays retired". What it asserted still being live (the
//      adult-site header/eval/fingerprint protections) is ALSO retired now; see CHANGELOG.md 10.3.0.
//      tools/test-strict-3p-retired.mjs is deleted.)
//  47. Priority-ladder self-correction (tools/test-priority-ladder-migration.mjs) — drives the REAL
//      updateUserRules() with rules seeded at stale (pre-9.9.1) priorities and asserts they always
//      rebuild onto the CURRENT ladder (a leftover user rule at 1 000 010 would outrank the new top
//      tier). (10.0.3) No longer tests the pre-10.0.3 migration wiring itself — that step was
//      removed; see CHANGELOG_HISTORY.md's 10.0.3 entry. (10.3.0) No longer tests
//      updateSecurityRules() either — that function is retired along with the whole security-toggle
//      rule mechanism; see CHANGELOG.md 10.3.0. Fault-verified: the old USER_RULES_PRIORITY fails it.
//
// Exit code 0 only if every check passes. For #10, #20, #27 and
// #28 FINDINGS are informational only, but a failure to RUN fails the suite
// like any other check (principle C38). No step is try/catch-wrapped any
// more; every step goes through run().
//
// Usage: node tools/complete-check.mjs   (or: npm run check)
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { listFiles } from './lib/walk.mjs';

// Third-party code shipped as-is — not this project's source. EXACT path
// (the top-level lib/ only): the old by-name `lib` exclusion also skipped
// tools/lib/, so its files were never syntax-checked (tools audit, item 3).
const VENDORED_DIRS = [ 'lib' ];

const ROOT = path.resolve(import.meta.dirname, '..');

// ── Step 16 fixture (single place for these two paths) ───────────────
// test-fixtures/legacy-cosmetic/ is a build artifact, not shipped in any
// zip, so a fresh extraction lacks it. Step 16 builds it on demand via the
// offline generator (derives from the shipped rulesets/*-cosmetic-specific
// .json — no network; rulesets/ and manifest.json untouched).
const LEGACY_COSMETIC_FIXTURE_DIR = path.join(ROOT, 'test-fixtures', 'legacy-cosmetic');
const LEGACY_COSMETIC_FIXTURE_BUILDER = 'tools/build-legacy-cosmetic-fixture.mjs';
process.chdir(ROOT);

let failures = 0;
const results = [];

async function run(name, fn) {
    console.log(`\n${'═'.repeat(70)}\n${name}\n${'═'.repeat(70)}`);
    try {
        await fn();
        results.push({ name, ok: true });
    } catch (err) {
        failures++;
        results.push({ name, ok: false, error: err.message });
        console.log(`\n✗ ${name} FAILED`);
        if ( err.stdout ) { console.log(err.stdout.toString()); }
        if ( err.stderr ) { console.log(err.stderr.toString()); }
    }
}

// ── 1. Syntax ─────────────────────────────────────────────────────────
await run('1. Syntax check (node --check) — every extension JS file', () => {
    const files = listFiles(ROOT, { exts: [ '.js', '.mjs' ], excludeDirs: VENDORED_DIRS });
    let checked = 0;
    for ( const f of files ) {
        execFileSync(process.execPath, [ '--check', f ], { stdio: 'pipe' });
        checked++;
    }
    console.log(`Checked ${checked} files — all valid.`);
});

// ── 2. ESLint ─────────────────────────────────────────────────────────
// (audit 10.6.4) --max-warnings 0: warnings used to print but never fail the step, so 11 unused
// imports in background.js stayed behind a "Clean." line. A warning is now a failure, like an error.
const ESLINT_MAX_WARNINGS = '0';
await run('2. ESLint', () => {
    execFileSync('npx', [ 'eslint', '.', '--max-warnings', ESLINT_MAX_WARNINGS ], { stdio: 'inherit', cwd: ROOT });
    console.log('Clean.');
});

// ── 3. CSS structural validation ─────────────────────────────────────
await run('3. CSS structural validation (brace + comment balance)', () => {
    const cssFiles = listFiles(ROOT, { exts: [ '.css' ], excludeDirs: VENDORED_DIRS });
    for ( const f of cssFiles ) {
        const s = fs.readFileSync(f, 'utf8');
        const braceMismatch = (s.match(/\{/g) ?? []).length !== (s.match(/\}/g) ?? []).length;
        const commentMismatch = (s.match(/\/\*/g) ?? []).length !== (s.match(/\*\//g) ?? []).length;
        if ( braceMismatch ) { throw new Error(`${path.relative(ROOT, f)}: brace mismatch`); }
        if ( commentMismatch ) { throw new Error(`${path.relative(ROOT, f)}: unclosed comment (brace-count alone is blind to this — see the .scriptlet-api-label incident)`); }
    }
    console.log(`Checked ${cssFiles.length} CSS files — all balanced.`);
});

// ── 4. HTML structural validation ────────────────────────────────────
await run('4. HTML structural validation', async () => {
    const { JSDOM } = await import('jsdom');
    const htmlFiles = listFiles(ROOT, { exts: [ '.html' ], excludeDirs: VENDORED_DIRS });
    for ( const f of htmlFiles ) {
        new JSDOM(fs.readFileSync(f, 'utf8')); // throws on unrecoverable parse failure
    }
    console.log(`Checked ${htmlFiles.length} HTML files — all parse cleanly.`);
});

// ── 5. JSDOM dry-run ──────────────────────────────────────────────────
await run('5. JSDOM dry-run (live module execution against real DOM)', () => {
    execFileSync(process.execPath, [ 'tools/test-dashboard-dry-run.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 6. Functional smoke test ─────────────────────────────────────────
await run('6. Functional smoke test (Map-converted core modules)', () => {
    execFileSync(process.execPath, [ 'tools/test-core-modules-dry-run.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 7. Message-type routing (C20a) ───────────────────────────────────
await run('7. Message-type routing cross-reference (C20a)', () => {
    execFileSync(process.execPath, [ 'tools/check-message-routing.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 8. File references (C20) ─────────────────────────────────────────
await run('8. Manifest/file-reference cross-reference (C20)', () => {
    execFileSync(process.execPath, [ 'tools/check-file-references.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 8a. Static ruleset ID cross-reference — new this session, from a
// real bug: 4 manifest-declared rulesets (ruleset_disconnect_ads,
// ruleset_ghostery_ads, ruleset_disconnect_other, ruleset_ghostery_other)
// were missing from js/core/static-rulesets.js's STATIC_RULESET_IDS,
// silently no-op'ing every toggle click. C20/check-file-references.mjs
// only checks that referenced *files* exist, not that ruleset *ids*
// stay in sync between the two declaration points — a distinct check.
await run('8a. Static ruleset ID cross-reference', () => {
    execFileSync(process.execPath, [ 'tools/check-static-ruleset-ids.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 9. DNR rule-ID range collisions ──────────────────────────────────
await run('9. DNR rule-ID range collision check', () => {
    execFileSync(process.execPath, [ 'tools/check-dnr-id-ranges.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (9a/9b/6b REMOVED in 10.3.0 — High-risk site list sync, fingerprint script copy sync, and the
// Worry-free tier/familiar-TLD wiring e2e all tested mechanisms that were retired along with the
// Privacy & Security tab's extra protections and the Worry-free tier checkboxes; see CHANGELOG.md
// 10.3.0. tools/check-high-risk-sites-sync.mjs, tools/check-scp-fingerprint-copy-sync.mjs and
// tools/test-worry-free-tiers-e2e.mjs are deleted — nothing left in either role for a step to check.)

// (9c. "Advanced tier + tier hierarchy drift," v9.7.0, REMOVED — AdShield
// Evolution rename pass: that tier is retired and tools/check-advanced-
// protections.mjs was deleted; see CHANGELOG_HISTORY.md for the full
// entry. The one section of that file genuinely unrelated to the tier —
// the generated safe-region TLD file's own internal consistency — was
// briefly salvaged into tools/check-safe-region-tlds.mjs, then THAT check
// was also deleted once the editable familiar-TLD feature removed the
// generated TLD file it checked entirely (no more build-time TLD pair to
// compare — there is only one, live source of truth now; see
// js/core/worry-free-familiar-tld-manager.js's own header). Nothing
// replaces this step: there is nothing left in either role for a step to
// check.)

// ── 10. 10. Dead exports (informational findings) ──
// Informational = its FINDINGS never fail the suite. Not running always
// does (principle C38): the script exits non-zero only when it could not
// complete. Was try/catch-wrapped until the audit after 9.7.5, which
// hid a failure to run behind "informational".
await run('10. Dead exports (informational findings)', () => {
    execFileSync(process.execPath, [ 'tools/check-dead-exports.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 11. CSS class cross-reference ────────────────────────────────────
await run('11. CSS class cross-reference', () => {
    execFileSync(process.execPath, [ 'tools/check-css-class-usage.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 12. Chrome DNR regexFilter constraints ───────────────────────────
await run('12. Chrome DNR regexFilter constraints (RE2 syntax, ASCII-only, 1000-rule cap)', () => {
    execFileSync(process.execPath, [ 'tools/check-dnr-regex-constraints.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 13. Scriptlet exception-rule logic ───────────────────────────────
await run('13. Scriptlet exception-rule logic (parsers + cancellation contract)', () => {
    execFileSync(process.execPath, [ 'tools/check-scriptlet-exception-logic.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 14. Scripting site-mode gating ───────────────────────────────────
await run('14. Scripting site-mode gating (every browser.scripting call site classified)', () => {
    execFileSync(process.execPath, [ 'tools/check-scripting-site-mode-gating.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 15. Cosmetic exception-rule logic ────────────────────────────────
await run('15. Cosmetic exception-rule logic (hostname#@#selector cancellation, real API)', () => {
    execFileSync(process.execPath, [ 'tools/check-cosmetic-exception-logic.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 16. Cosmetic SPECIFIC-DATA format equivalence ────────────────────
// Rebuilds nothing itself — reads whatever's currently in test-fixtures/
// legacy-cosmetic/ (that dir is a build artifact, not shipped in any zip —
// if it is missing, this step now builds it first, see the constants at
// the top of this file). Real-execution differential test: loads and runs the
// REAL js/scripting/isolated-api.js for the new lookup path, not a
// reimplementation — see that script's own header for why this matters.
await run('16. Cosmetic SPECIFIC-DATA format equivalence (storage-backed vs embedded-blob)', () => {
    if ( !fs.existsSync(LEGACY_COSMETIC_FIXTURE_DIR) ) {
        console.log('   (fixture missing — building it first via ' + LEGACY_COSMETIC_FIXTURE_BUILDER + ')');
        execFileSync(process.execPath, [ LEGACY_COSMETIC_FIXTURE_BUILDER ], { stdio: 'inherit', cwd: ROOT });
    }
    execFileSync(process.execPath, [ 'tools/check-cosmetic-specific-format-equivalence.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 17. Knip dead-code scan (HARD since the audit after 9.7.5) ───────
// Was informational AND wrapped in try/catch — so Knip crashing on every
// run was indistinguishable from "no dead code". See the script's header
// and principle C38.
await run('17. Knip whole-tree dead-code scan (unused files/exports/deps, duplicate exports)', () => {
    execFileSync(process.execPath, [ 'tools/check-knip-dead-code.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 18. depcheck ──────────────────────────────────────────────────────
await run('18. depcheck (unused/missing devDependencies)', () => {
    execFileSync(process.execPath, [ 'tools/check-depcheck.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 19. Version-congruence check ─────────────────────────────────────
await run('19. Version-congruence check (manifest / package.json / state / CHANGELOG)', () => {
    execFileSync(process.execPath, [ 'tools/check-version-sync.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 20. 20. stylelint style-guide rules (informational findings) ──
// Informational = its FINDINGS never fail the suite. Not running always
// does (principle C38): the script exits non-zero only when it could not
// complete. Was try/catch-wrapped until the audit after 9.7.5, which
// hid a failure to run behind "informational".
await run('20. stylelint style-guide rules (informational findings)', () => {
    execFileSync(process.execPath, [ 'tools/check-stylelint-style-guide.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 21. JSON syntax ───────────────────────────────────────────────────
await run('21. JSON syntax (ported from self-test.mjs)', () => {
    execFileSync(process.execPath, [ 'tools/check-json-syntax.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 22. CMP data consistency + hash trip-wire ────────────────────────
await run('22. CMP data consistency + hash trip-wire (ported from self-test.mjs)', () => {
    execFileSync(process.execPath, [ 'tools/check-autoconsent-cmp-consistency.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 23. Popup DOM-id references ──────────────────────────────────────
await run('23. Popup DOM-id references (ported from self-test.mjs)', () => {
    execFileSync(process.execPath, [ 'tools/check-popup-dom-refs.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 24. Seamless surfing popup line e2e ──────────────────────────────
await run('24. Seamless surfing popup line e2e (tools/e2e_seamless_line.mjs)', () => {
    execFileSync(process.execPath, [ 'tools/e2e_seamless_line.mjs' ], { stdio: 'inherit', cwd: ROOT, timeout: 15000 });
});

// ── 25. Seamless surfing prompt e2e ──────────────────────────────────
await run('25. Seamless surfing prompt e2e (tools/e2e_seamless_prompt.mjs)', () => {
    execFileSync(process.execPath, [ 'tools/e2e_seamless_prompt.mjs' ], { stdio: 'inherit', cwd: ROOT, timeout: 15000 });
});

// ── 26. madge circular-dependency check ──────────────────────────────
await run('26. Circular-dependency check (C15, madge)', () => {
    execFileSync(process.execPath, [ 'tools/check-circular-deps.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 27. 27. jscpd duplicate-code scan (informational findings) ──
// Informational = its FINDINGS never fail the suite. Not running always
// does (principle C38): the script exits non-zero only when it could not
// complete. Was try/catch-wrapped until the audit after 9.7.5, which
// hid a failure to run behind "informational".
await run('27. jscpd duplicate-code scan (informational findings)', () => {
    execFileSync(process.execPath, [ 'tools/check-duplicate-code.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 28. 28. c8 coverage report (informational, no gate) ──
// Informational = its FINDINGS never fail the suite. Not running always
// does (principle C38): the script exits non-zero only when it could not
// complete. Was try/catch-wrapped until the audit after 9.7.5, which
// hid a failure to run behind "informational".
await run('28. c8 coverage report (informational, no gate)', () => {
    execFileSync(process.execPath, [ 'tools/check-coverage.mjs' ], { stdio: 'inherit', cwd: ROOT, timeout: 30000 });
});

// ── 30. Message-derived hostname/site trust boundary (C28) ──────────
await run('30. Message-derived hostname/site trust boundary (C28)', () => {
    execFileSync(process.execPath, [ 'tools/check-message-hostname-trust.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 31. Scripting batch-registration (C25) ───────────────────────────
await run('31. Scripting batch-registration (no per-directive browser.scripting loops)', () => {
    execFileSync(process.execPath, [ 'tools/check-scripting-batch-calls.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 32. Entity-dispatch coverage (cosmetic hasEntities / scriptlet entity branch)
await run('32. Entity-dispatch coverage (name.* keys reachable in cosmetic + scriptlet dispatch)', () => {
    execFileSync(process.execPath, [ 'tools/check-entity-dispatch-coverage.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 33. Manifest permissions <-> browser.* API usage (C19) ──────────
await run('33. Manifest permissions <-> browser.* API usage (C19; 8.6.0 lesson)', () => {
    execFileSync(process.execPath, [ 'tools/check-manifest-permissions.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 34. Optimization-change functional dry-run ──────────────────────
await run('34. Optimization-change functional dry-run (bulk functions, css-user diff)', () => {
    execFileSync(process.execPath, [ 'tools/test-optimization-dry-run.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 35. MAIN-world security scriptlet tamper resistance (C35) ───────
// Loads every js/security/sec-*.js into a fresh realm, tampers with the
// builtins it depends on, and asserts the protection still holds and the
// unprotected original is never handed to page code. Proven against the
// pre-9.7.6 files with --expect-fail (every case detected a real bypass).
await run('35. MAIN-world security scriptlet tamper resistance (C35)', () => {
    execFileSync(process.execPath, [ 'tools/test-security-scriptlet-tamper.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 36-38. Checks added in the audit after 9.7.5 (C33, C36, C31) ────
// Each proven in all three outcomes (PASS / FINDINGS / DID NOT RUN) on a
// scratch copy before being wired in (principle C38 rule 3).
await run('36. C33 — no dynamic import() in the service worker graph', () => {
    execFileSync(process.execPath, [ 'tools/check-sw-no-dynamic-import.mjs' ], { stdio: 'inherit', cwd: ROOT });
});
await run('37. C36 — no unapproved permission additions since the last release', () => {
    execFileSync(process.execPath, [ 'tools/check-permission-additions.mjs' ], { stdio: 'inherit', cwd: ROOT });
});
await run('38. C31 — JSON-lossy message responses (detector + router wiring)', () => {
    execFileSync(process.execPath, [ 'tools/test-json-safe.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (39 REMOVED in 10.3.0 — the ClickFix clipboard protection's detection corpus. js/security/sec-
// clickfix-clipboard.js and tools/test-clickfix-clipboard.mjs are both deleted: that protection moved
// to 3P-Matrix along with the rest of the Privacy & Security tab's extra protections; see
// CHANGELOG.md 10.3.0.)

// ── 40. $worryfree per-site exemption ────────────────────────────────
// (10.3.0) The scriptlet half this used to guard is retired along with every Worry-free-gated
// scriptlet; see tools/test-worryfree-exemption.mjs's own header. What's left: the parser and the
// three whole-site DNR allow rules, asserted against the real exported functions.
await run('40. $worryfree per-site exemption (parser, DNR allow rules)', () => {
    execFileSync(process.execPath, [ 'tools/test-worryfree-exemption.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 41. Worry-free priority ORDER (constants, shipped rulesets, outcomes) ──
// Extra ad lists must outrank every TLD allow and Privacy/Security item, sit
// below the 200 off-switch and outside the retired 140-165 band. Proven to
// fail with --simulate-extras-priority=100/116/135/150 (principle C38 rule 3).
await run('41. Worry-free priority order (extra lists vs TLD allows / off-switches)', () => {
    execFileSync(process.execPath, [ 'tools/check-dnr-priority-order.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 42. uBO-patch scriptlets functional test (C40) ────────────────────────
// Real assertions against the actual DOM behavior of the 4 hand-ported
// scriptlets (prevent-dialog, bab-defuser/nobab, freeze-element-property,
// href-sanitizer/urlskip), not just a syntax check.
await run('42. uBO-patch scriptlets functional test (C40)', () => {
    execFileSync(process.execPath, [ 'tools/test-ubo-patch-scriptlets.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

await run('43. Worry-free annoyances list — source gate (top-1M, TLD scope, host-anchored network rules)', () => {
    execFileSync(process.execPath, [ 'tools/test-annoyances-source.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

await run('44. Worry-free annoyances list — network rules suppressed outside a session (shipped ruleset)', () => {
    execFileSync(process.execPath, [ 'tools/test-annoyances-suppression.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

await run('45. Worry-free annoyances list — hide rules + scriptlets registered only during a session', () => {
    execFileSync(process.execPath, [ 'tools/test-annoyances-registration.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (46 REMOVED in 10.3.0 — "Strict 3P block stays retired". What it asserted still being live (the
// adult-site header/eval/fingerprint protections) is ALSO retired now — see js/data/retired-
// protections.js and CHANGELOG.md 10.3.0 — so nothing is left in either role for this step to check.
// tools/test-strict-3p-retired.mjs is deleted.)

await run('47. Priority ladder: stale-priority rules are always rebuilt onto the current ladder', () => {
    execFileSync(process.execPath, [ 'tools/test-priority-ladder-migration.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

await run('48. Allow-list options ($saferegions/$worryfree) work in ALL THREE channels (Allow list, quick-fixes list, ABP-import)', () => {
    execFileSync(process.execPath, [ 'tools/check-exemption-channels.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

await run('49. C41 — CRUD for every data element, Initiate-Perform-End for every process', () => {
    execFileSync(process.execPath, [ 'tools/check-crud-lifecycle.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 50. Scriptlet dispatch layout (10.1.7) ───────────────────────────────
// Fuzz equivalence of the real generated lookup vs a reference walk, guard
// negative tests, and a decode + dead-key + run check of every shipped file.
await run('50. Scriptlet dispatch layout — equivalence, guards, shipped files', () => {
    execFileSync(process.execPath, [ 'tools/check-scriptlet-dispatch-layout.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 51. Project-own scriptlets ship (10.1.8) ──────────────────────────────
// A rule such as the Quick-fixes line `cnn.com#%#//scriptlet('disable-fave-ssai')`
// goes through the real parser, the build lookup and the generated-file
// renderer, and runs only on its hosts.
await run('51. Project-own scriptlets written in a list ship and run', () => {
    execFileSync(process.execPath, [ 'tools/check-project-scriptlets-shipping.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 52. Hand-written list lines are never lost silently (10.1.8) ──────────
// The real parseList() with the Quick-fixes options over a table of line shapes: kept, ignored, or dropped AND reported.
await run('52. Quick-fixes list — unsupported lines are dropped and reported', () => {
    execFileSync(process.execPath, [ 'tools/check-unsupported-list-lines.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 53. SAFE update reports what it leaves out (10.1.9) ───────────────────
// A scriptlet/hide-rule file a list compiles to is not a rule_resources file, so a skip-review update drops it;
// the safe build must say so (the CNN Quick-fixes lines vanished silently before).
await run('53. SAFE update — reports the files it leaves out', () => {
    execFileSync(process.execPath, [ 'tools/check-safe-update-report.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 54. Whitelist levels (10.2.0) ─────────────────────────────────────────
// One whitelist, two levels: WHITE (owner-published, fully trusted) and GREY (anyone can publish, never trusted).
// Fails on a host where anyone can publish entered as WHITE, a domain in two levels, a half-trusted WHITE entry,
// or a whole-domain googleapis.com entry.
await run('54. Whitelist levels (WHITE / GREY)', () => {
    execFileSync(process.execPath, [ 'tools/check-whitelist-levels.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 55. Safe/unsafe split of every shipped ruleset (10.2.0) ───────────────
// A main filter ruleset holds safe rules only; unsafe ones live in the declared companions
// (js/data/ruleset-companions.js) — otherwise a SAFE (skip-review) refresh of that list is impossible.
await run('55. Every main filter ruleset is safe-only (unsafe rules only in declared companions)', () => {
    execFileSync(process.execPath, [ 'tools/check-unsafe-split.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 56. Geographic scope (10.4.5) ─────────────────────────────────────
// Europe without Moldova/Belarus/Ukraine/Russia, the Americas, and only Australia/New Zealand
// in Asia/Oceania (South Korea/Japan removed in 10.4.6) (GEO_SCOPE, tools/build/tld-scope.mjs): the gate behaves and no shipped file leaks an
// out-of-scope domain.
await run('56. Geographic scope — gate behaves, no shipped file holds an out-of-scope domain', () => {
    execFileSync(process.execPath, [ 'tools/check-geo-scope.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 57. Combined language filters' country rows (10.4.5) ──────────────
// Balkan / Baltic states are one stored ruleset shown as countries: the stored country rows (C41 CRUD), and a
// stored choice for an id this version does not ship is pruned (10.5.0: the older-choice migration was removed).
await run('57. Combined language filters — country rows stored, unknown stored choices pruned', () => {
    execFileSync(process.execPath, [ 'tools/test-language-filter-countries.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 58. Language filters switched on at first install (10.4.5) ────────
// Owner's rule: the browser's languages first; only when none has a filter, the country (language-tag region, else
// time zone — js/core/country-resolver.js, ported from 3P Matrix) and every language spoken there.
await run('58. First-install language filters — languages first, then the country\'s languages', () => {
    execFileSync(process.execPath, [ 'tools/test-language-auto-enable.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 59. Manifest V3 compliance and the scriptlet policy (10.4.6) ───────
// Chrome Web Store rejected a package over a scriptlet that loaded remote code ("Blue Argon", 2026-10-23). The policy
// (js/data/scriptlet-policy.js): trusted scriptlets only from AdGuard Team sources, no code as argument, no inserted
// external URL — checked on the shipped data, the package, the wiring, and by a self-test on the real incident.
await run('59. Manifest V3 — no remotely hosted code, scriptlet policy holds in data, build and extension', () => {
    execFileSync(process.execPath, [ 'tools/check-mv3-compliance.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 60. UI names from one source (10.5.0) ─────────────────────────
// js/data/ui-names.js is the one place for the Worry-free name and the dashboard tabs (C39a). A content
// script's forced copy must equal it (Part D step 51 rule); retired names may not come back.
await run('60. UI names — forced copies equal js/data/ui-names.js, no retired name in shipped files', () => {
    execFileSync(process.execPath, [ 'tools/check-ui-name-copies.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 61. Options tab + Worry-free startup default (10.5.0) ────────────
// Tab order/labels, the startup option on the Options tab (saved once, no caveat), default ON and the
// one-time switch-on for installs and backups older than 10.5.0 (fault-verified, C42).
await run('61. Options tab, tab order and Worry-free startup default (one-time switch-on)', () => {
    execFileSync(process.execPath, [ 'tools/test-options-tab-and-worryfree-default.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 62. Derived UI values (C39a — Part D step 50, ported 10.5.0) ──────
// A number the user reads that is typed into HTML or a UI string is an unlinked copy of a constant.
await run('62. Derived UI values — no typed number in user-visible text (C39a)', () => {
    execFileSync(process.execPath, [ 'tools/check-derived-literals.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 63. Settings keep only known keys (10.5.0) ────────────────────────
// Replaced the 10.3.0 retired-key lists: stored and restored settings drop unknown / wrongly typed keys.
await run('63. Settings — stored and restored settings keep only known keys (C6/C13b)', () => {
    execFileSync(process.execPath, [ 'tools/test-settings-known-keys.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 64. Session deadline alarm (10.5.0 watchdog; 10.7.6 alarm) ────────
// One shared deadline for Privacy Inspector + Matrix panel, as a chrome.alarms alarm (survives the worker sleeping —
// audit 10.7.5 D-1): armed with a session, cleared when it pauses or ends, routed by the one onAlarm listener.
await run('64. Session deadline — an alarm armed with a session, cleared when it ends (B3b/B7/B10)', () => {
    execFileSync(process.execPath, [ 'tools/test-session-deadline.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 65. HaGeZi Multi light selection (10.5.5) ─────────────────────────
// Which HaGeZi light entries ship (tools/build/hagezi-light-selection.mjs): each source keeps only what it vouches
// for, '.' is the only label boundary (the TOP-N '-' quirk is gone — fault-verified), the CrUX rank cut-off holds,
// and ruleset_hagezi_light's customFetch IS the selection.
await run('65. HaGeZi Multi light selection — sources, label boundaries, rank cut-off, wiring', () => {
    execFileSync(process.execPath, [ 'tools/test-hagezi-light-selection.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 66. Matrix panel request-listener lifecycle (10.5.6) ─────────────
// The webRequest listener exists only while a Matrix session is running (B10): otherwise Chrome wakes the
// service worker for every request on every tab even with the panel closed, and it never idles.
await run('66. Matrix panel — request listener lives exactly as long as its session (B10)', () => {
    execFileSync(process.execPath, [ 'tools/test-matrix-request-listener.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 67. Scriptlet SITES/ENTITY site-scope split (10.5.6) ──────────────
// js/util/scriptlet-site-scope.js decides which pages get the full scriptlet data (SITES, the sites the lists
// actually name) vs. the much smaller ENTITY-only registration (every other page) — fault-verified (C24).
await run('67. Scriptlet site scope — SITES/ENTITY pattern split and registration diffing (B10/C24)', () => {
    execFileSync(process.execPath, [ 'tools/test-scriptlet-site-scope.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 68. Fix #5 — catch up already-open tabs for scriptlets (10.6.0) ───
// catchUpAlreadyOpenTabsForScriptlets(): one-time imperative injection into already-open http(s) tabs at a
// genuine browser restart or install/update, since declarative registration only affects future navigations.
await run('68. Open-tabs catch-up — eligibility gate, per-tab fault tolerance, missing-data fallback (C24)', () => {
    execFileSync(process.execPath, [ 'tools/test-catchup-open-tabs.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

await run('69. Disconnect removed — no leftovers, retired suppression rule released (10.7.1)', () => {
    execFileSync(process.execPath, [ 'tools/test-disconnect-retired.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

await run('70. Seamless surfing cookie-banner choice — stored, followed by the session, prompt offered once (10.7.1)', () => {
    execFileSync(process.execPath, [ 'tools/test-seamless-cookie-choice.mjs' ], { stdio: 'inherit', cwd: ROOT, timeout: 60000 });
});

await run('71. Pop-up / pop-under handling and block page — prevent-popunder, $popup refusal, send-back, block page (10.7.2 branch, merged 10.7.5)', () => {
    execFileSync(process.execPath, [ 'tools/test-tab-under-guard.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 72-73. Silent errors (10.7.6, audit 10.7.5 — C5/C25/C42) ─────────
// 72: standing scan of the service-worker graph — no ignored .catch(), no unmarked empty catch {}, no raw
// promise-chain lock (fault-verified: 53 findings on the pre-10.7.6 tree). 73: the expected-error helper and the
// ABP-import failure report, against the real modules (fault-verified: part B fails on the pre-10.7.6 tree).
await run('72. C5/C25 — no silently swallowed errors or raw promise-chain locks in the service worker graph', () => {
    execFileSync(process.execPath, [ 'tools/check-silent-catch.mjs' ], { stdio: 'inherit', cwd: ROOT });
});
await run('73. Error reporting — expected-error classes, ABP-import failure reported, lock survives a failure (C5/C42)', () => {
    execFileSync(process.execPath, [ 'tools/test-error-reporting.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 74. One network-filter parser (10.7.6) ──────────────────────────
// The build and the ABP import translate network lines with the same parser; one assertion per fix that
// switch made (separator "^", end anchor, removeparam position, bare tokens, prefix hosts, type exclusions,
// $doc, @@$important, @@$csp, unknown options, $removeheader/$requestheader) and the Phase 3 translations (regex,
// $match-case, bundled-file $redirect, $denyallow, $to, $method) — fault-verified: 27 fail on 10.7.5.
await run('74. One network-filter parser — build and ABP import agree, every 10.7.6 translation fix holds (B15/C42)', () => {
    execFileSync(process.execPath, [ 'tools/test-network-translation.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 75. Regex rules ship only with Chrome's verdict (10.7.6) ─────────
// tools/build/regex-support.mjs on the real module, no browser: supported verdict ships; refused or UNKNOWN
// (no Chrome) is dropped and reported; >1 000 per ruleset fails the build; open/close release everything.
// The SHIPPED files are checked against the same verdict cache in step 12 (check-dnr-regex-constraints.mjs).
// Fault-verified: keeping unknown regexes fails 4 assertions.
await run('75. Regex rules ship only with Chrome\'s isRegexSupported() verdict (B13/C42)', () => {
    execFileSync(process.execPath, [ 'tools/test-regex-support.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 76. What a page's content script can reach (10.7.6, audit 10.7.5 D-4/D-5) ──
// Only "no sender" (internal calls) and uBD's own pages are trusted (isTrustedSender, real function); session storage
// stays closed to content scripts (TRUSTED_CONTEXTS, no content-script file touches it); the per-site CSS cache lives
// in storage.local on both sides. Fault-verified: DID NOT RUN on 10.7.5 (no isTrustedSender); a session write in
// css-specific.js fails 2 assertions.
await run('76. Content scripts — trusted sender, session storage closed, CSS cache in local (C28/D-5)', () => {
    execFileSync(process.execPath, [ 'tools/test-storage-sender-trust.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 77. Import ABP box: every unusable line is marked, nothing is refused silently (10.7.6) ──
// The owner's rule since 10.7.2, until 10.7.6 applied to scriptlet and $popup lines only: network lines the parser
// cannot translate, cosmetic lines that cannot apply, rules validateRules() drops and regexes Chrome refuses are
// commented out with "! Rejected: <reason>" beneath (red); rule caps and a refused batch reach the person as a notice.
// Real functions (compile-filters.js, filter-manager.js, ubo-parser.js, editor-annotations.js); the NOS redirect must
// stay a working rule. Fault-verified: DID NOT RUN on 10.7.5; removing the cosmetic pass from setSandboxFilters() fails it.
await run('77. Import ABP box — every unusable line commented out with its reason, Chrome refusals reported (C5/C22)', () => {
    execFileSync(process.execPath, [ 'tools/test-import-rejections.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 78. Chrome's static-ruleset limits, and a refused filter-list switch reaches the person (10.7.6) ──
// Audit 10.7.5 D-9: declared / on-by-default lists and their rules against dnr-budgets.js (Chrome's own limits); a
// switch Chrome refuses is returned by setRulesetEnabled() (real function), shown in the dashboard and set back, and
// named after a settings restore. Fault-verified: DID NOT RUN on 10.7.5 (no limit constants); a direct send fails it.
await run('78. Filter-list limits — within Chrome\'s limits, a refused switch is shown and set back (B13/C5)', () => {
    execFileSync(process.execPath, [ 'tools/check-dnr-ruleset-limits.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 79. HTML sinks receive fixed markup only (10.7.6, forbidden practice F-SINK-1) ──
// innerHTML / outerHTML / insertAdjacentHTML / document.write: only fixed markup and UPPER_CASE constants; any other
// value is set afterwards as text. Fault-verified: 4 findings on 10.7.5 (cookie-clicker selector, worry-free buttons).
await run('79. HTML sinks — fixed markup only, values set as text (F-SINK-1, D-10)', () => {
    execFileSync(process.execPath, [ 'tools/check-html-sinks.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 80. Upstream ports (10.7.8, uBO Lite + AdGuard review, claude/UPSTREAM_REVIEW_2026-11.md) ──
// Picker secret, serialized permission changes, parser fixes, immediate site-specific hiding, "$domain=name.*" from
// the CrUX snapshot, value-less $removeparam, page-injection expected errors, high-contrast rules. Real exported code,
// browser mocked. Fault-verified: 16 failures + a crash on 10.7.7.
await run('80. Upstream ports — picker secret, permissions lock, parser, hiding, wildcards, removeparam, errors, contrast', () => {
    execFileSync(process.execPath, [ 'tools/test-upstream-ports.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── 81. Picker / cookie-clicker hardening (10.7.13, uBO UXSS GHSA-cmqw-9r2w-6wv2 review) ──
// Picked selectors cannot escape the injected stylesheet (real ExtSelectorCompiler output of every bundled cosmetic
// selector must pass); cookie-clicker rules validate hostnames and lengths and cross-check the sender; the
// cookie-clicker picker ignores synthetic events; the matrix panel is not web-accessible. Fault-verified: reverting
// the four fixes fails 8 assertions. Import / Restore use the same checks; extension-page CSP tightened; no listener
// for other extensions or web pages. Fault-verified: reverting the import guards and the CSP fails 4 more.
await run('81. Picker hardening — selector escape guard on every path, cookie-rule validation, isTrusted, WAR, CSP', () => {
    execFileSync(process.execPath, [ 'tools/test-picker-hardening.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (10.7.16) CMP loader blocks — Sourcepoint's consent loader is blocked only while Seamless surfing DECLINES banners,
// saved cookie-clicker rule sites exempt, released with the session. Real module, session-rule store mocked.
// Fault-verified: dropping the saved-rule exemption fails 2 assertions.
await run('82. CMP loader blocks — decline mode only, saved-rule sites exempt, released with the session (C41)', () => {
    execFileSync(process.execPath, [ 'tools/test-cmp-loader-block.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.0.0) Seamless surfing's site-specific cookie-notice sets (AdGuard Cookie Notices, EasyList Cookie uBO, EasyList Cookie
// hide/block) — classified accept/decline, built per mode ("accept, else decline" included), registered only during a
// session in its mode, saved clicker-rule sites excluded from every part, all released with the session.
await run('83. Cookie-notice sets — per mode, own library, saved clicker rules prevail, released with the session', () => {
    execFileSync(process.execPath, [ 'tools/test-cookie-notice-sets.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.0.0) "I am an advanced user (unhide power tools)" — every popup line, context-menu item and dashboard tab
// classified power/always (C25-style: a new, unclassified one fails), new install hidden / existing user shown,
// unticking sets Seamless surfing to "accept, else decline".
await run('84. Power tools option — classification, new/existing default, untick sets smart', () => {
    execFileSync(process.execPath, [ 'tools/test-power-tools.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.0.0) Ad leftover cleaner — page-script mirrors, build split, shipped data, the real page script in JSDOM (hides
// only real matches, exceptions, Undo/Stop/Keep/page-left release everything, relaunch replaces), real routes.
await run('85. Ad leftover cleaner — data, page script lifecycle, launch and keep routes', () => {
    execFileSync(process.execPath, [ 'tools/test-ad-cleaner.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.0.0) Seamless surfing always on — the startup option removed; only advanced users can turn it off (prompt).
await run('86. Seamless surfing always on — default, off only for advanced users, browser start / install, prompt', () => {
    execFileSync(process.execPath, [ 'tools/test-seamless-always-on.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.0.0, owner's rule) User-facing hover text never names internal code (files, paths, functions).
await run('87. Hover text has no internal code references', () => {
    execFileSync(process.execPath, [ 'tools/check-hover-text-no-code-refs.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.0.0, owner's decision) EFF Privacy Badger "needed" hosts stop the four Seamless tracker lists from breaking sites:
// cookieblock only, exact host, at the tracker lists' "@@" step, never lifting another list's block.
await run('88. Privacy Badger unbreak — needed hosts excepted for the tracker lists only', () => {
    execFileSync(process.execPath, [ 'tools/test-privacy-badger-unbreak.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.0.2) Chrome loads hosts with '_' (my_site.example.com); every hostname check accepts them (AdGuard fixed the same).
await run('89. Hostname checks accept underscores, one shared shape (11.0.2)', () => {
    execFileSync(process.execPath, [ 'tools/test-hostname-shape.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.0.2, audit finding 1) Page scripts survive the extension being reloaded under an open page.
await run('90. Page scripts survive an extension reload (one guard, identical copies, no direct sends)', () => {
    execFileSync(process.execPath, [ 'tools/test-content-script-context.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.0.2, audit finding 8) The real extension in real Chrome: tools, worker restart, reload under an open page.
// Skipped (with a message) when no Chrome is found — set CHROME_PATH.
await run('91. Live smoke test in real Chrome (skipped without Chrome)', () => {
    execFileSync(process.execPath, [ 'tools/e2e-live-smoke.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.0.2, manual v15 C49 / F-INPUT-1) Outside input is size-checked before it is read: every whole-file read is
// gated by checkImportFileSize() or classified with a reason; the helper itself is driven with edge sizes.
await run('92. Input size checked before reading (C49, F-INPUT-1)', () => {
    execFileSync(process.execPath, [ 'tools/check-input-size-limits.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.0.3, manual v15 C15, audit 11.0.2 finding 1) Imports between tiers flow downward; only background.js imports a
// route file. Step 26 sees cycles only — a sideways route-to-route import shipped twice (10.7.12, 11.0.0) unseen.
await run('93. Tier direction — downward imports only, no route file imports another (C15)', () => {
    execFileSync(process.execPath, [ 'tools/check-tier-direction.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.1.0, owner's request) DNR tracking filter Break risk: whitelist = high, tracker-list allow exception = medium,
// DDG Tracker Radar = low, none = unknown — rule, shipped-data parse, per-tier examples, load/release, display.
await run('94. DNR tracking filter Break risk — rule, shipped data, lifecycle, every verdict displayable', () => {
    execFileSync(process.execPath, [ 'tools/test-breakage-risk.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// (11.1.3, owner's decision) Anti-Admiral takes uBlock Origin's whole Admiral and Ad-Shield sections: preprocessor as
// uBO Lite on Chromium, section bounds, missing-section guard, and rule A's safe replacement in the trust gate.
await run('95. Anti-Admiral — uAssets Admiral/Ad-Shield sections, MV3 preprocessor, safe scriptlet replacement', () => {
    execFileSync(process.execPath, [ 'tools/test-anti-admiral-sections.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}\nSUMMARY\n${'═'.repeat(70)}`);
for ( const r of results ) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}`);
}
console.log('');
if ( failures > 0 ) {
    console.log(`${failures} CHECK(S) FAILED — do not zip until these are resolved.`);
    process.exit(1);
}
console.log('ALL CHECKS PASSED.');
