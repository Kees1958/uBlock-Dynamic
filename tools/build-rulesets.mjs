#!/usr/bin/env node
/*******************************************************************************

    uBol-stripped — Static ruleset build script
    Run from the repo root: node tools/build-rulesets.mjs

    Outputs per run:
      rulesets/ruleset_<id>.json          — DNR network + removeparam rules
      rulesets/ag-scriptlets-rules.json   — per-hostname AG scriptlet rules
      js/resources/ag-scriptlets-corelibs.json — trimmed AG scriptlet library
      rulesets/ruleset-details.json       — metadata for dashboard UI
      manifest.json                       — rule_resources updated

    DNR dynamic rule ID ranges (static ruleset IDs are Chrome-managed, no clash):
      6,000,000 – 6,002,999  monitor block rules (cap: 3,000)
      7,000,000+              security rules
      8,000,000+              trusted directive rules
      9,000,000+              sandbox user DNR rules
      10,000,000 – 10,001,999 reserved (2,000 slots — purpose TBD)

*******************************************************************************/

/*******************************************************************************

    Module map (phase 2 module split): this file is only the orchestrator.
    Everything it runs lives in tools/build/ — see each module's own header:
      build-paths.mjs      — tools/ dir and repo root
      build-state.mjs      — shared mutable state, phases, step bookkeeping
      filter-lists.mjs     — FILTER_LISTS (the declared upstream lists)
      build-steps.mjs      — the nine steps      build-step-checks.mjs — their post-conditions
      (parsers, TLD scoping, cosmetic/scriptlet generators, CrUX, corelibs: the rest)

*******************************************************************************/

import { BUILD_PHASES, STEP_OK, buildNotices, buildState } from './build/build-state.mjs';
import { checkAdCleaner, checkCleanOrphans, checkCookieNotices, checkInit, checkLists, checkScriptletAssets, checkScriptletExceptions, checkScriptletPrecompile, checkWriteCookieNotices, checkWriteRegistries, checkWriteReports, checkWriteScriptletFiles } from './build/build-step-checks.mjs';
import { closeRegexSupport } from './build/regex-support.mjs';
import { stepAdCleaner, stepCleanOrphans, stepCompileLists, stepCookieNotices, stepInit, stepScriptletAssets, stepScriptletExceptions, stepScriptletPrecompile, stepWriteCookieNotices, stepWriteRegistries, stepWriteReports, stepWriteScriptletFiles } from './build/build-steps.mjs';

/*******************************************************************************

    build() — the orchestrator (phase 2 of the tools rework, audit after 9.7.5)

    Until 9.7.5, build() was one ~900-line function. It is now a short,
    defensive sequence: each BUILD_STEPS entry runs one step, checks the
    step's own result, then checks that step's POST-CONDITIONS before the
    next step may start. Nothing proceeds on bad data: a failed condition
    stops the build and names the phase (buildState.phase) in the error.

    State: ctx is the one build context the steps share. Each step's header
    lists exactly what it reads from and writes to ctx (B3a/C12) — there are
    no other hand-offs between steps. The module-level report accumulators
    (droppedBadfilters, buildNotices, …) are reset by stepInit, as before.

    Swimming lane:
      [idle] → init → lists → scriptlet-assets → scriptlet-precompile →
      exceptions → write-scriptlets → registry-manifest → orphan-cleanup →
      reports → [done]            any failure → [error] (phase recorded)

    The step bodies were moved verbatim from the old build(); a replayed
    build (recorded inputs) produced byte-identical output files and
    console output before and after the move.

*******************************************************************************/


// The one declared step sequence — order, step, and its post-condition.
const BUILD_STEPS = Object.freeze([
    { phase: BUILD_PHASES.INIT,                 run: stepInit,                 check: checkInit },
    { phase: BUILD_PHASES.COOKIE_NOTICES,       run: stepCookieNotices,        check: checkCookieNotices },        // (11.0.0) needs the CrUX set, released by LISTS
    { phase: BUILD_PHASES.LISTS,                run: stepCompileLists,         check: checkLists },
    { phase: BUILD_PHASES.SCRIPTLET_ASSETS,     run: stepScriptletAssets,      check: checkScriptletAssets },
    { phase: BUILD_PHASES.SCRIPTLET_PRECOMPILE, run: stepScriptletPrecompile,  check: checkScriptletPrecompile },
    { phase: BUILD_PHASES.EXCEPTIONS,           run: stepScriptletExceptions,  check: checkScriptletExceptions },
    { phase: BUILD_PHASES.WRITE_SCRIPTLETS,     run: stepWriteScriptletFiles,  check: checkWriteScriptletFiles },
    { phase: BUILD_PHASES.COOKIE_NOTICE_WRITE,  run: stepWriteCookieNotices,   check: checkWriteCookieNotices },   // (11.0.0)
    { phase: BUILD_PHASES.AD_CLEANER,           run: stepAdCleaner,            check: checkAdCleaner },            // (11.0.0)
    { phase: BUILD_PHASES.REGISTRY_MANIFEST,    run: stepWriteRegistries,      check: checkWriteRegistries },
    { phase: BUILD_PHASES.ORPHAN_CLEANUP,       run: stepCleanOrphans,         check: checkCleanOrphans },
    { phase: BUILD_PHASES.REPORTS,              run: stepWriteReports,         check: checkWriteReports },
]);

async function build() {
    const ctx = {};
    for ( const step of BUILD_STEPS ) {
        buildState.phase = step.phase;
        const result = await step.run(ctx);
        if ( result?.status !== STEP_OK.status ) {
            throw new Error(`build step '${step.phase}' did not report completion`);
        }
        const problem = await step.check(ctx);
        if ( problem !== null ) {
            throw new Error(`build step '${step.phase}' post-condition failed: ${problem}`);
        }
        buildState.completed.push(step.phase);
    }
    buildState.phase = BUILD_PHASES.DONE;
    console.log('\nDone. Reload the extension in chrome://extensions.');
    printBuildNotices();
}

// One block, after "Done", so nothing that needs attention scrolls away.
// Exit code stays 0: the build finished and its output is consistent —
// these are things to act on, not a broken build.
function printBuildNotices() {
    if ( buildNotices.length === 0 ) { return; }
    const bar = '!'.repeat(70);
    console.log(`\n${bar}\nFILTER UPDATE FINISHED — ${buildNotices.length} item(s) need attention:\n${bar}`);
    for ( const n of buildNotices ) { console.log(`\n[${n.level}] ${n.text}`); }
    console.log(`\n${bar}`);
}

build().catch(err => {
    const failedPhase = buildState.phase;
    buildState.phase = BUILD_PHASES.ERROR;
    console.error(`\n[build-rulesets] FAILED in phase '${failedPhase}' (completed: ${buildState.completed.join(' → ') || 'none'})`);
    console.error(err);
    // RELEASE guard (10.7.6): a headless Chrome started for regex verdicts must not outlive a failed build.
    closeRegexSupport()
        .catch(closeErr => console.error(`[build-rulesets] releasing the regex checker failed: ${closeErr.message}`))
        .finally(() => process.exit(1));
});
