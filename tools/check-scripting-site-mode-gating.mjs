#!/usr/bin/env node
// check-scripting-site-mode-gating.mjs — guards against the recurring bug
// class documented in ARCHITECTURE.md's "HARD CONSTRAINT — every
// browser.scripting call site must be site-mode-gated": a call into the
// browser.scripting API that runs with no awareness of per-site filtering
// mode at all, so turning a site OFF (or a temp-disable pause) stops DNR
// network blocking but leaves that call's own JS/CSS injection running
// anyway. Found and fixed FOUR separate times in this codebase before this
// check existed — see CHANGELOG.md.
//
// This is a static, heuristic scan, not a control-flow analyzer — it
// cannot prove a call site is correctly gated, only that someone looked at
// it and recorded why it's safe (or isn't). Every real call site in the
// codebase must appear in the CLASSIFIED map below with one of three
// justifications:
//
//   'gated'      — the enclosing function itself consults site-mode state
//                   (buildSiteModeMatchScope() / getFilteringMode()) before
//                   this call.
//   'downstream' — this call only ever runs because an already-gated
//                   content script (registered with site-mode-aware
//                   matches/excludeMatches) asked for it; the gating
//                   happened one level up, at registration time.
//   'exempt'     — deliberately outside site-mode's scope: a user-invoked,
//                   host-scoped tool (e.g. Privacy Inspector's probe) that
//                   isn't passive ambient filtering, or a call that isn't
//                   filtering-related at all (e.g. a one-off hostname
//                   probe).
//
// A call site found in the scan but NOT in CLASSIFIED fails the check —
// new code must be triaged into one of the three categories (and, for
// 'gated', actually gated) before it can ship. A CLASSIFIED entry no
// longer found in the scan is reported as stale (warning only, so a
// refactor that removes/renames a call site doesn't need this file edited
// in the same breath — but it should be cleaned up).
//
// Usage: node tools/check-scripting-site-mode-gating.mjs   (also runs as
// step 14 of `npm run check` / tools/complete-check.mjs)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listFiles } from './lib/walk.mjs';
import { scanScriptingCallSites } from './lib/scripting-call-sites.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
// ENTRYPOINT GUARD (added alongside the CLASSIFIED export above): the
// scan-and-report logic at the bottom of this file must only run when
// this script is executed directly (`node tools/check-scripting-site-
// mode-gating.mjs`), not when it's imported purely to reuse CLASSIFIED
// (see check-scripting-site-mode-gating-semgrep.mjs) — without this,
// importing the map would also trigger a full second scan + its own
// process.exit() as a side effect of the import itself.
const isMainModule = process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

// file (relative to ROOT) -> Map<enclosingFunctionName, { status, why }>
// EXPORTED (added when wiring in the semgrep cross-check, see
// check-scripting-site-mode-gating-semgrep.mjs) so the AST-based
// cross-check consumes the exact same classification data — one source
// of domain knowledge, not two independently-maintained copies (B15).
export const CLASSIFIED = new Map([
    [ 'js/core/scripting-manager.js', new Map([
        // registerScriptletContentScriptsImpl/registerCosmeticContentScriptsImpl/
        // registerSecurityContentScriptsImpl themselves no longer contain a
        // literal browser.scripting.* call as of the C25 batch-registration
        // consolidation (see ARCHITECTURE.md's "HARD CONSTRAINT — batch
        // browser.scripting (un)registration") — each now builds its own
        // site-mode-gated directives (via buildSiteModeMatchScope() /
        // prepareSecurityScriptletDirectives()) exactly as before, then
        // delegates the actual native calls to the shared
        // registerOrUpdateContentScripts() helper below. The three entries
        // that used to be classified here for those functions are replaced
        // by the two entries below, which cover where the calls actually
        // live now — nothing about the underlying gating changed, only
        // where the native call textually sits.
        [ 'updateOne', {
            status: 'downstream',
            why: 'nested helper inside registerOrUpdateContentScripts() — the `wanted` directives it (un)registers are built and site-mode-gated by whichever *ContentScriptsImpl() function called registerOrUpdateContentScripts() (buildSiteModeMatchScope()), before this helper ever runs.',
        } ],
        [ 'registerOrUpdateContentScripts', {
            status: 'downstream',
            why: 'the shared batch (un)registration helper itself — its two batched calls register the `wanted` directives exactly as received, and every caller (*ContentScriptsImpl()) builds and site-mode-gates them first (buildSiteModeMatchScope()). Its own entry since the audit after 9.7.5: the old line-based scan attributed these two calls to registerOne (declared just above them), which this list had to work around; the parser-based scan attributes them correctly.',
        } ],
        [ 'registerOne', {
            status: 'downstream',
            why: 'same reasoning as updateOne just above — nested fallback helper inside registerOrUpdateContentScripts(), directives are pre-gated by the calling *ContentScriptsImpl() function.',
        } ],
        [ 'registerCookieClickerContentScriptsImpl', {
            status: 'gated',
            why: 'built from buildSiteModeMatchScope() (siteModeMatches/siteModeExcludes) earlier in this same function — untouched by the C25 batch-registration consolidation above (single-directive registration, nothing to batch)',
        } ],
        // registerCookieClickerAutoDenyContentScriptsImpl REMOVED (10.4.9): it registers two directives since then
        // (bundle + cookie-clicker precedence marker) and so goes through registerOrUpdateContentScripts() (C25), like
        // the scriptlet/cosmetic/security functions; both directives are still built from buildSiteModeMatchScope().
        [ 'register', {
            status: 'gated',
            why: 'toAdd is built by registerCustomFilters(context), which applies context.filteringModeDetails (none/basic) before adding anything',
        } ],
        [ 'registerContentScriptsSafely', {
            status: 'downstream',
            why: 'generic pass-through; directives are supplied by the caller — see privacy-inspector.js registerProbe(), classified as exempt below',
        } ],
        [ 'catchUpAlreadyOpenTabsForScriptlets', {
            status: 'gated',
            why: '(10.6.0, fix #5) per-tab executeScript call guarded by `if ( level === MODE_NONE ) { return; }`, where level = await getFilteringMode(hostname) for that tab\'s own hostname — the exact HARD CONSTRAINT guard, applied per already-open tab rather than via buildSiteModeMatchScope() (which builds a match-pattern scope for declarative registration; this function targets an explicit tabId instead, so there is no pattern to scope — see this function\'s own header comment in scripting-manager.js for why that is a sound substitution here, not a gap).',
        } ],
    ] ) ],
    [ 'js/core/filter-manager.js', new Map([
        [ 'startCustomFilters', {

            status: 'downstream',
            why: 'only invoked by css-user.js, which is only ever registered on non-OFF hostnames by registerCustomFilters() (see its own BUG FIXED comment for the historical version of this exact gap)',
        } ],
        [ 'terminateCustomFilters', {
            status: 'exempt',
            why: 'cleanup/teardown action (removes previously-injected CSS) — safe to run unconditionally regardless of current site mode',
        } ],
        [ 'injectCustomFilters', {
            status: 'gated',
            why: 'collectMatchingFilterEntries(index, hostname) already scopes to matching stored rules for this hostname; additionally downstream of registerCustomFilters() gating css-user.js registration itself',
        } ],
    ] ) ],
    [ 'js/core/custom-scriptlets.js', new Map([
        [ 'injectCustomScriptletsForFrame', {
            status: 'gated',
            why: 'getFilteringMode(hostname) === MODE_NONE guard at the top of this function — see CHANGELOG.md, the 4th occurrence of this bug class',
        } ],
    ] ) ],
    [ 'js/workflow/filter-routes.js', new Map([
        [ 'handleInjectCSSProceduralAPI', {
            status: 'downstream',
            why: 'responds to a message sent BY an already-injected content script (loaded via injectCustomFilters(), itself downstream of registerCustomFilters() gating) — moved here from background.js during the filter-manager.js route extraction, same classification carried over unchanged',
        } ],
    ] ) ],
    [ 'js/workflow/ad-cleaner-routes.js', new Map([
        [ 'handleAdCleanerLaunch', {
            status: 'exempt',
            why: '(11.0.0) Ad leftover cleaner: a deliberate, single-click, user-initiated tool (popup line or right-click item) on the page the person is looking at — the same established convention as the picker and handleCookieClickerLaunchPicker. It hides nothing until asked, only in that tab\'s top frame, and only for that page view; what the person keeps is saved as custom cosmetic rules, which ARE site-mode-gated by their own registration.',
        } ],
    ]) ],
    [ 'js/workflow/cookie-clicker-routes.js', new Map([
        [ 'handleCookieClickerAutoDenyStart', {
            status: 'gated',
            why: 'immediate-apply executeScript for the tab that triggered "Never consent" — FIXED this pass (previously unclassified/ungated, a real instance of the HARD CONSTRAINT bug class: the future-load registration was already gated via buildSiteModeMatchScope() inside startAutoDeny(), but this immediate-tab call was not). Now guarded with getFilteringMode(hostname) === MODE_NONE, same pattern as custom-scriptlets.js injectCustomScriptletsForFrame() and privacy-inspector.js recordPrivacyInspectorEvent() (sender.url || sender.tab?.url for the frame URL, never tabId alone).',
        } ],
        [ 'handleCookieClickerLaunchPicker', {
            status: 'exempt',
            why: 'deliberate, single-click, user-initiated detection + picker launch (button in the popup) — moved here from popup.js\'s own #gotoCookieClicker click handler in 8.2.17 (see this function\'s own file-header note). The pre-existing popup.js picker launches (#gotoPicker for the cosmetic element picker, and the original #gotoCookieClicker before the 8.2.17 move) were never site-mode-gated either — established project convention for manual, one-shot authoring/detection tools the user explicitly triggers on the page they are already looking at, as distinct from automatic per-navigation injection.',
        } ],
        [ 'injectSeamlessPrompt', {
            status: 'downstream',
            why: '(10.7.1) the ONE injection of the Seamless surfing prompt, moved out of handleWorryFreeLaunchPicker. Two callers, both decided upstream: (1) handleWorryFreeLaunchPicker — a deliberate, single-click, user-initiated overlay launch from the popup line, same exempt reasoning as handleCookieClickerLaunchPicker above (the session itself only starts once the person picks Accept/Decline, through handleCookieClickerAutoDenyStart, whose immediate-apply call is gated); (2) background.js maybeOfferSeamlessCookiePrompt — the AUTOMATIC once-after-update offer, which checks getFilteringMode(hostname) === MODE_NONE itself before calling, so a site with filtering off never gets the prompt.',
        } ],
    ] ) ],
    [ 'js/workflow/background.js', new Map([
        [ 'onPermissionGrantedThruBrowser', {
            status: 'exempt',
            why: 'not a filtering action — probes the active tab\'s hostname to decide whether to auto-reload after a permission grant',
        } ],
        [ 'onContextMenuClicked', {
            status: 'exempt',
            why: 'RENAMED from onContextMenuPickerClicked (v8.6.3) — this function is now the single switch-based router for all 4 right-click menu items (Cosmetic element picker, Cookie consent clicker, Dynamic DNR filtering, Privacy Inspector), not just the picker; only the PICKER case still contains a browser.scripting call, same shape/reasoning as cookie-clicker-routes.js\'s handleCookieClickerLaunchPicker/handleWorryFreeLaunchPicker (v8.5.6) — a deliberate, single-click, user-initiated cosmetic element picker launch, this time from the right-click context menu rather than the popup\'s own #gotoPicker button, but the exact same underlying tool/files/target shape either way. Manual, one-shot authoring tool the user explicitly triggers on the page they are already looking at, as distinct from automatic per-navigation injection — same established convention popup.js\'s own #gotoPicker has never been site-mode-gated under either. The other 3 menu items added in this same pass (Cookie consent clicker, Dynamic DNR filtering, Privacy Inspector) call handleCookieClickerLaunchPicker()/handleStartMatrix()/handleStartPrivacyInspector() directly — no new browser.scripting call site, so nothing further to classify here for them.',
        } ],
    ] ) ],
]);

// Call sites are found by tools/lib/scripting-call-sites.mjs, which PARSES
// each file (espree) instead of matching text. Replaced (audit after 9.7.5)
// a line-based `function name(` lookup that could not see arrow functions,
// function expressions or methods — and silently attributed such a call to
// the preceding `function` line, which is how registerOrUpdateContentScripts()'s
// two calls had been credited to registerOne. The Semgrep cross-check that
// was meant to cover this gap (step 29) never ran (Semgrep not installed)
// and was removed once the parser closed the gap here (principle C38).

const jsDir = path.join(ROOT, 'js');

// ── Everything below only runs when this file is executed directly —
// see the ENTRYPOINT GUARD comment above CLASSIFIED's export for why. ──
if ( isMainModule ) {
    const files = listFiles(jsDir, { exts: [ '.js', '.mjs' ], excludeDirs: [ 'lib', 'generated' ] });

    const found = []; // { relPath, func, lineNo }
    for ( const file of files ) {
        const relPath = path.relative(ROOT, file).split(path.sep).join('/');
        let sites;
        try {
            sites = scanScriptingCallSites(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            // A file that cannot be parsed was NOT scanned — never report
            // that as "no call sites" (principle C38).
            console.log(`DID NOT RUN: cannot parse ${relPath} (${err.message}). A check that did not run has not passed.`);
            process.exit(1);
        }
        for ( const site of sites ) {
            found.push({ relPath, func: site.enclosingFunction, lineNo: site.line });
        }
    }
    if ( files.length === 0 ) {
        console.log('DID NOT RUN: no files found under js/ — the scan covered nothing.');
        process.exit(1);
    }

    let failures = 0;
    const seen = new Set(); // relPath::func already reported, so N calls in one function print once

    console.log(`Scanned ${files.length} files under js/ — found ${found.length} browser.scripting call site(s).\n`);

    for ( const { relPath, func, lineNo } of found ) {
        const key = `${relPath}::${func}`;
        if ( seen.has(key) ) { continue; }
        seen.add(key);

        const fileMap = CLASSIFIED.get(relPath);
        const entry = func !== null ? fileMap?.get(func) : undefined;

        if ( entry === undefined ) {
            failures++;
            console.log(`✗ UNCLASSIFIED: ${relPath}:${lineNo} — inside ${func ? `function "${func}"` : '(no enclosing function found — check by hand)'}`);
            console.log(`    This call site is not in CLASSIFIED. Either gate it using getFilteringMode()/`);
            console.log(`    buildSiteModeMatchScope() (see ARCHITECTURE.md's HARD CONSTRAINT), or add it to`);
            console.log(`    CLASSIFIED here with a 'gated'/'downstream'/'exempt' justification.`);
            continue;
        }
        console.log(`✓ ${entry.status.padEnd(10)} ${relPath}::${func}`);
        console.log(`    ${entry.why}`);
    }

    // Stale-entry check — informational, does not fail the run (see file header).
    let stale = 0;
    for ( const [ relPath, fileMap ] of CLASSIFIED ) {
        for ( const func of fileMap.keys() ) {
            if ( seen.has(`${relPath}::${func}`) ) { continue; }
            stale++;
            console.log(`\n⚠ STALE CLASSIFIED entry (no longer found by the scan): ${relPath}::${func} — remove or investigate why it disappeared.`);
        }
    }

    console.log('');
    if ( failures > 0 ) {
        console.log(`${failures} unclassified browser.scripting call site(s) — do not zip until triaged.`);
        process.exit(1);
    }
    console.log(`All browser.scripting call sites are classified.${stale > 0 ? ` (${stale} stale entries, see warnings above)` : ''}`);
}
