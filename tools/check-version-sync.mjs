// tools/check-version-sync.mjs — version-congruence guard.
//
// WHY THIS EXISTS (real incident, tools v1.7.0): three sources of tools
// version truth had silently drifted apart from each other with nobody
// noticing: the last-shipped tools ZIP FILENAME said 1.6.20, the tools
// artifact's own package.json (lives at repo root — see
// TOOLS_ROOT_FILES in package-release.mjs) said 1.6.18, and
// CHANGELOG.md's own last recorded "tools X.Y.Z" entry said 1.6.4 —
// meaning at least 14 tools version bumps had shipped with no CHANGELOG
// entry at all, a direct violation of this project's own hard rule
// ("Add a CHANGELOG.md entry for every version"). Root cause:
// package.json's version field was never actually wired to
// package-release.mjs's own version-tracking state
// (tools/package-release-state.json) — package-release.mjs computes and
// persists the real next tools version there via nextToolsVersion(),
// but nothing ever copied that number back into package.json, so it was
// purely decorative and free to drift.
//
// THE STRUCTURAL FIX (package-release.mjs, guardSyncToolsPackageVersion):
// package-release.mjs now writes its own computed tools version straight
// into package.json immediately after resolving it, every run, whether
// or not tools was actually rebuilt this pass — single source of truth
// (package-release-state.json) written outward to package.json, not two
// independently-maintained copies.
//
// THIS CHECK is the second half — run as part of the standing complete
// check suite (see complete-check.mjs), it catches drift EARLY, before
// another packaging pass could paper over it, and specifically enforces
// the "every version gets a CHANGELOG entry" rule that the incident
// showed silently lapsed for a long stretch.
//
// Checks performed:
//   1. If tools/package-release-state.json exists: it records the LAST
//      SHIPPED versions. The tools version must match package.json's; the
//      extension/docs versions must not be NEWER than manifest.json's
//      (a manifest that is AHEAD of the state is the normal pending-release
//      situation since the version is bumped before packaging; 10.1.5 relaxed
//      the former equality test, which failed on every pre-zip run).
//   2. CHANGELOG.md's topmost `## X.Y.Z` heading must equal
//      manifest.json's version — the extension's own release record.
//   3. CHANGELOG_HISTORY.md must contain at least one line mentioning
//      "tools <package.json's version>" — every tools version that's
//      actually shipped must have a CHANGELOG record, not just a
//      version-number bump.
//
// Hard failure (non-zero exit) on any mismatch — this is exactly the
// class of drift that shipped silently for 14+ versions before; treating
// it as informational-only would repeat the same mistake.
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

function readJSON(relPath) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

console.log('=== Version-congruence check (manifest.json / package.json / package-release-state.json / CHANGELOG.md) ===');

let failures = 0;
/** -1 / 0 / 1 comparing dotted numeric versions ("10.1.5" vs "10.1.10"). */
function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for ( let i = 0; i < Math.max(pa.length, pb.length); i++ ) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if ( d !== 0 ) { return d < 0 ? -1 : 1; }
    }
    return 0;
}

function fail(msg) {
    console.log(`FAIL: ${msg}`);
    failures++;
}
function ok(msg) {
    console.log(`OK: ${msg}`);
}

const manifest = readJSON('manifest.json');
const toolsPkg = readJSON('package.json');
const extVersion = manifest.version;
const toolsVersion = toolsPkg.version;

if ( typeof extVersion !== 'string' || extVersion === '' ) {
    fail('manifest.json has no version field.');
}
if ( typeof toolsVersion !== 'string' || toolsVersion === '' ) {
    fail('package.json (tools artifact\'s own file, at repo root) has no version field.');
}

// ── 1. package-release-state.json cross-check (only if it exists — a
//    brand-new checkout with no release packaged yet has nothing to
//    reconcile against, and that's expected, not an error) ───────────
const stateFile = path.join(ROOT, 'tools', 'package-release-state.json'); // this one genuinely lives under tools/ — see ARTIFACT_STATE_FILE in package-release.mjs
if ( fs.existsSync(stateFile) ) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

    // (11.0.0) package.json AHEAD of the ledger is a pending deliberate jump (package-release.mjs requestedToolsVersion()),
    // the same pending situation as a manifest ahead of the ledger — allowed. Behind or a different same-level value is not.
    if ( state.tools?.version && compareVersions(toolsVersion, state.tools.version) > 0 ) {
        ok(`package.json (${toolsVersion}) is ahead of tools/package-release-state.json (${state.tools.version}) — a pending tools version jump, applied at packaging.`);
    } else if ( state.tools?.version && state.tools.version !== toolsVersion ) {
        fail(`tools/package-release-state.json records tools version ${state.tools.version}, but package.json says ${toolsVersion}. package-release.mjs's guardSyncToolsPackageVersion should keep these identical — check whether package.json was hand-edited.`);
    } else if ( state.tools?.version ) {
        ok(`tools/package-release-state.json (${state.tools.version}) matches package.json (${toolsVersion}).`);
    }

    if ( state.extension?.version && compareVersions(state.extension.version, extVersion) > 0 ) {
        fail(`tools/package-release-state.json records extension version ${state.extension.version}, which is NEWER than manifest.json (${extVersion}) — the version went backwards.`);
    } else if ( state.extension?.version ) {
        ok(`tools/package-release-state.json extension version (${state.extension.version}, last shipped) is not newer than manifest.json (${extVersion}).`);
    }

    if ( state.docs?.version && compareVersions(state.docs.version, extVersion) > 0 ) {
        fail(`tools/package-release-state.json records docs version ${state.docs.version}, which is NEWER than manifest.json (${extVersion}, which docs shares) — the version went backwards.`);
    } else if ( state.docs?.version ) {
        ok(`tools/package-release-state.json docs version (${state.docs.version}, last shipped) is not newer than manifest.json (${extVersion}).`);
    }
} else {
    console.log('NOTE: tools/package-release-state.json not present — nothing to reconcile against yet (expected for a fresh checkout with no release packaged in this session).');
}

// ── 2. CHANGELOG.md's top entry must match the extension version ────
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const topHeadingMatch = changelog.match(/^## ([0-9]+\.[0-9]+\.[0-9]+)\b/m);
if ( !topHeadingMatch ) {
    fail('CHANGELOG.md has no top-level "## X.Y.Z" version heading to check against.');
} else if ( topHeadingMatch[1] !== extVersion ) {
    fail(`CHANGELOG.md's topmost entry is "## ${topHeadingMatch[1]}", but manifest.json's version is ${extVersion}. Every packaged extension version needs its own CHANGELOG entry at the top.`);
} else {
    ok(`CHANGELOG.md's top entry (${topHeadingMatch[1]}) matches manifest.json (${extVersion}).`);
}

// ── 3. CHANGELOG_HISTORY.md must record the current tools version ───
// v9.7.1: split into a brief CHANGELOG.md and a full CHANGELOG_HISTORY.md —
// a "tools X.Y.Z" mention is internal detail a brief file won't naturally
// contain, so this check moved to the history file, where the real
// technical record continues to live. (10.1.4: both files now live in the
// docs zip; neither ships inside the extension.)
const changelogHistory = fs.readFileSync(path.join(ROOT, 'CHANGELOG_HISTORY.md'), 'utf8');
const toolsMentionPattern = new RegExp(`tools ${toolsVersion.replace(/\./g, '\\.')}\\b`);
if ( !toolsMentionPattern.test(changelogHistory) ) {
    fail(`CHANGELOG_HISTORY.md has no entry mentioning "tools ${toolsVersion}" — every shipped tools version needs a recorded reason, per this project's own "CHANGELOG entry for every version" rule. (This exact gap — silent, undocumented tools bumps — is the incident that made this check necessary.)`);
} else {
    ok(`CHANGELOG_HISTORY.md records "tools ${toolsVersion}".`);
}

console.log('');
if ( failures > 0 ) {
    console.log(`${failures} version-congruence check(s) FAILED.`);
    process.exitCode = 1;
} else {
    console.log('PASS: all version sources are congruent.');
    process.exitCode = 0;
}
