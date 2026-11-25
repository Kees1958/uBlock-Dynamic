#!/usr/bin/env node
/*******************************************************************************

    uBlock-Stripped-Dynamic — Release packaging script
    Run from the repo root: node tools/package-release.mjs

    RECONSTRUCTED (v8.3.1) — this file existed once (introduced in `8.1.3`,
    per CHANGELOG.md's own entry) but was never part of any export this
    project's tooling was rebuilt from (the `v8.1` full-source export this
    reconciliation pass used predates `8.1.3` by three patch versions).
    Rebuilt from CHANGELOG.md's `8.1.3` entry, which described its
    behavior in enough detail to reconstruct faithfully — extended here
    from that entry's original TWO-zip split (extension/docs) to the
    THREE-zip split Xplainer_Programming_principles_conscript.md's Ground
    Rules now require (extension/tools/docs), plus the "only rebuild an
    artifact if its own contents changed" rule from that same document.
    If the original `8.1.3` file is ever recovered, diff it against this
    one before trusting this reconstruction over the real thing.

    Produces, in dist/:
      uBlock-Stripped-Dynamic-<version>-extension.zip  — Chrome Web Store
        upload. Runtime code only. Zero documentation files, zero dev
        tooling. Structurally guaranteed, not just remembered — see
        guardNoLeakedFiles().
      uBlock-Stripped-Dynamic-<version>-tools.zip       — build/verify/
        lint/test suite. Never uploaded anywhere.
      uBlock-Stripped-Dynamic-<version>-docs.zip        — project history.
        Never uploaded anywhere.

    Each of the three is rebuilt and re-versioned ONLY if its own content
    changed since the last release — see ARTIFACT_STATE_FILE below.

*******************************************************************************/

import fs   from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { REGEX_SUPPORT_CONFIG } from './build/regex-support.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/*==============================================================================
    CONFIG — every tunable constant lives here, nowhere else in this file
    (this project's own standing convention: variables/switches/magic
    numbers declared in one place, with a comment explaining each).
==============================================================================*/

// Plain, unversioned folder name every zip extracts into — per
// Xplainer_Programming_principles_conscript.md's C27: the zip's own
// filename carries the version, the extracted folder never does, so a
// fixed path (IDE workspace, chrome://extensions "Load unpacked") never
// breaks release to release.
const PROJECT_FOLDER_NAME = 'uBlock-Stripped-Dynamic';

// Project-history-only files. Never uploaded anywhere. Declared once,
// here, with the reason for each — per this project's own "magic values
// in one place" convention. guardInit() fails loudly if this list and
// the repo's actual root-level *.md files ever drift apart, instead of
// silently shipping or silently dropping an untracked doc file.
const DOC_FILES = [
    'ARCHITECTURE.md',
    'FILTER_PROCESSING_REFERENCE.md',
    'PRIVACY_POLICY.md',
    'STYLE_GUIDE_DARK.md',
    'STYLE_GUIDE_LIGHT.md',
    'Xplainer_Injection-architecture-evaluation.md',
    'Xplainer_Programming_principles_conscript.md',
    // Working proposal/evaluation doc, same genre as the Xplainer_*
    // entries above (analysis, not end-user documentation) — added
    // here so guardInit()'s drift check doesn't fail on it and so it
    // doesn't fall through to the extension artifact by default.
    'popup-popunder-abp-import-voorstel.md',
    // GitHub repository front page and the repo copy of the privacy text
    // (added with the Kees1958/uBlock-Dynamic repo, 2026-11-22). Repo/
    // project documents only — never part of the extension upload.
    'README.md',
    'PRIVACY.md',
    // Working performance-optimization tracker — analysis + implementation
    // plan, same genre as the Xplainer_* files and the proposal doc above.
    // Added here for the same reason: keeps guardInit()'s drift check
    // passing and keeps it out of the extension artifact.
    'OPTIMIZE.md',
    // Per-option protections reference for the Privacy & Security tab
    // (v9.7.2) — built to cross-check against the Firefox sibling
    // ("Power Tools for Adblockers") row by row. Same genre as the
    // Xplainer_* analysis docs above: internal technical reference, not
    // curated end-user content, so it stays here rather than shipping
    // with the extension.
    'protections.md',
    // Geographic scope reference (10.4.9): which countries, territories and generic-use ccTLDs
    // the filters keep or drop, and how to change it. Describes GEO_SCOPE (tools/build/tld-scope.mjs).
    'GEOGRAPHIC_SCOPE.md',
    // DISCONNECT_GHOSTERY_INTEGRATION_PLAN.md REMOVED entirely — its
    // content was fully implemented (v8.6.12) and the person decided the
    // decision-record no longer needed to be kept around, unlike this
    // project's usual "keep implemented plans as historical record"
    // convention. See CHANGELOG for the removal entry.
    // v10.1.4 — BOTH changelogs now live in docs (never uploaded anywhere):
    //   CHANGELOG.md — brief, per-release summary: what changed, not how
    //     or why. It used to ship INSIDE the extension (9.7.1-10.1.3) so
    //     users could read it, but that made a Chrome Web Store
    //     skip-review ("safe update") impossible: every release must add
    //     a CHANGELOG.md entry (check-version-sync.mjs enforces it), so
    //     every package differed from the last published one in a file
    //     that is neither manifest.json nor a rule_resources file. Chrome
    //     diffs the WHOLE package, not just files the extension loads.
    //   CHANGELOG_HISTORY.md — the technical record. Written ONLY for big
    //     changes (new feature, bug-class fix, refactor, batch of
    //     principle fixes) — see the programming-principles doc's B4 and
    //     that file's own header. One exception, enforced by
    //     check-version-sync.mjs: every tools version still needs at
    //     least a one-line mention there.
    // guardNoLeakedFiles() below refuses to build an extension zip that
    // contains either file, so this cannot silently regress.
    'CHANGELOG.md',
    'CHANGELOG_HISTORY.md',
];

// DOCS_EXTRA_FILES is declared below, after TOOLS_DIR (it references that constant) — see its own
// comment there for what it holds and why it isn't part of DOC_FILES above.

// Real gap, found and fixed in place at 9.0.4 (not a new version bump —
// this corrects an already-shipped release, per this project's own
// "shipped broken, fix without stacking a new release" rule):
// LICENSE.txt ships WITH the extension and explicitly says "See
// THIRD_PARTY_LICENSES.md for the full, canonical, per-entry account" —
// but that file was DOC_FILES-only, so every actual install shipped
// without it, pointing at a file nobody who installs the extension has.
// The CC BY-NC-SA 4.0/MPL-2.0/MIT-licensed content that file documents
// is bundled INTO the extension itself, not just referenced — proper
// attribution needs to travel with the redistributed software.
//
// Originally fixed by shipping in BOTH bundles (docs AND extension).
// Per explicit follow-up request, now EXTENSION-ONLY — docs.zip is
// never uploaded anywhere, so keeping a second copy there added nothing
// once the real fix (shipping it with the extension at all) was in
// place. Removing it from DOC_FILES alone does NOT reintroduce the
// 9.0.4 bug — that bug was specifically "missing from the extension,"
// and this file still ships there via resolveArtifactFiles()'s own
// extension catch-all (anything not in DOC_FILES/TOOLS_ROOT_FILES/
// TOOLS_DIR defaults to extension) — it's docs that loses it now, which
// carries no such risk.
//
// Still needs explicit tracking here (not just silently falling off
// DOC_FILES) for two reasons: guardInit()'s own drift check expects
// every root .md file to be accounted for somewhere, and
// guardNoLeakedFiles() needs to know this specific "doc-shaped" file is
// allowed in the extension zip deliberately, not a leak.
const EXTENSION_ONLY_ROOT_MD_FILES = new Set([
    // Only the licence notice remains here. (CHANGELOG.md used to be listed
    // too; it moved to DOC_FILES in 10.1.4 so a safe-update package can be
    // byte-identical to the last published one — see DOC_FILES' comment.)
    'THIRD_PARTY_LICENSES.md',
]);

// Dev-tooling files. Never uploaded anywhere; needed to regenerate
// filterlists and run the full check suite in any future session. This
// is the exact set the "code-only" export (used 8.2.0-8.3.0) silently
// dropped — see CHANGELOG.md's 8.3.1 entry for the full incident.
const TOOLS_ROOT_FILES = [
    'package.json',
    'package-lock.json',
    'eslint.config.mjs',
    'knip.jsonc',
    '.depcheckrc.json',
    '.stylelintrc.mjs',
];
const TOOLS_DIR = 'tools'; // entire directory, every file in it

// (10.5.0) Non-root doc files — live outside ROOT's top level, so they can't go in DOC_FILES above
// (guardInit()'s drift check compares DOC_FILES against root-level *.md files only; a nested or
// non-md path there would break that comparison). Declared separately, same "ships in docs.zip" intent,
// and merged into docSet alongside DOC_FILES in resolveArtifactFiles() below.
const DOCS_EXTRA_FILES = [
    // tools/package-release-state.json — this script's own per-artifact "last shipped" hash ledger
    // (see ARTIFACT_STATE_FILE below), added to docs per explicit request: it's release history, same
    // genre as the two changelogs above, not end-user tooling. STALENESS NOTE: saveState() writes the
    // updated ledger only AFTER every artifact is already staged and zipped (see main()) — the file's
    // own current content would need to already know docs.zip's own hash to record it, which is
    // circular. The copy shipped in any given docs.zip is therefore always the ledger as saved at the
    // END of the PREVIOUS packaging run, one release behind — by design, not a bug. Previously listed
    // in NEVER_SHIP (excluded from every zip); removed from there to ship here instead, and explicitly
    // excluded from toolsSet in resolveArtifactFiles() so it ships once, not doubled into tools.zip too.
    path.join(TOOLS_DIR, 'package-release-state.json'),
    // (11.0.4) Notes on vendor/autoconsent's licence split — present in the GitHub repo; project
    // documentation, never part of the Chrome Web Store upload (the MPL LICENSE file itself still ships).
    path.join('vendor', 'autoconsent', 'README.md'),
];

// LICENSE.txt deliberately ships in the EXTENSION zip, not docs — it's a
// legal distribution notice, not project documentation (8.1.3's own
// distinction, carried over unchanged). No constant is needed for that:
// it is in neither DOC_FILES nor the tools set, so resolveArtifactFiles()
// puts it in the extension by default. (A `LICENSE_FILE` constant that
// nothing read used to sit here — removed in 9.7.3 as dead code.)

// Directories/files that exist in the working tree but must never be
// staged into ANY release zip (build output, installed deps, git
// metadata, editor state). Checked by guardClearStaging() and by the
// extension-stage leak guard.
const NEVER_SHIP = [
    'node_modules', '.git', 'dist', 'test-fixtures',
    '.DS_Store',
    // package-release-state.json REMOVED from this list (10.5.0) — it now ships in docs.zip, see
    // DOCS_EXTRA_FILES above.
    // Standard coverage-tool output directory (e.g. c8's default). Not
    // wired into this project's own tooling as of this writing, but
    // excluded defensively — a real incident during dev-sandbox
    // exploration left a stray coverage/ dir on disk that would
    // otherwise have silently swept into the extension zip (nothing in
    // DOC_FILES/TOOLS_ROOT_FILES/TOOLS_DIR claimed it, so
    // resolveArtifactFiles()'s extension catch-all took it).
    'coverage',
    // Chrome's OWN compiled cache of the DNR rulesets this extension
    // declares — not source, not something the code loads. Chrome
    // creates and persists it under the browser-reserved `_metadata`
    // folder the moment it loads `rulesets/*.json` (unpacked or
    // packed), and regenerates it identically on the next load if
    // absent. Confirmed via Chromium's own source docs (declarative_net_
    // request/README) and a live Chromium-extensions report that
    // including it in a Web Store upload can itself trigger a warning/
    // error. Matched by basename only, at any depth — this does NOT
    // exclude the rest of `_metadata/`, since that folder name is
    // Chrome-reserved and could hold something else in a future Chrome
    // version; only this specific, confirmed-safe-to-drop subfolder is
    // excluded.
    'generated_indexed_rulesets',
    // tools/build-rulesets.mjs's own build-time diagnostic report (every
    // $badfilter line dropped from a regular filter list this run, for
    // manual review — see that script's own comment). Regenerated fresh
    // on every build run, meant to be read by whoever ran the build, not
    // shipped anywhere — same "not source, not something the code loads"
    // reasoning as generated_indexed_rulesets above. Real incident: this
    // leaked into the extension zip (Chrome Web Store upload) the first
    // time this report existed, caught by inspecting the zip contents
    // before finalizing the release rather than by any automated guard —
    // exactly the kind of stray-root-file gap the coverage/ incident
    // above already warns this project is prone to.
    'dropped-badfilters.txt',
    // Same category, same reasoning, added alongside this session's new
    // [$domain=...] generic-cosmetic-qualifier reporting (see CHANGELOG,
    // AdGuard Base blacklist-model rearchitecture) — a second build-time
    // diagnostic report that didn't exist when the incident above was
    // fixed, and would otherwise repeat it identically.
    'dropped-generic-domain-qualifiers.txt',
    // Same category, same reasoning, added alongside this session's
    // $domain=example.* wildcard-token handling (BUGREPORT-domain-
    // wildcard-invalid-dnr-rules.md) — two more build-time-only diagnostic
    // reports that would otherwise repeat the exact same leak incident.
    'dropped-wildcard-domains.txt',
    'expanded-wildcard-domains.txt',
    // Same category (10.1.7): build-time report of scriptlet rule lines
    // whose scope ([$path=..]/[$url=..] bracket scopes, ~negated hosts)
    // cannot be a dispatch key. Must never reach the Chrome Web Store zip.
    'dropped-unsupported-scriptlet-scopes.txt',
    'dropped-unsupported-list-lines.txt',
    // Same category (10.4.6): rules the scriptlet policy refused (js/data/scriptlet-policy.js). Never in the Store zip.
    'dropped-policy-scriptlets.txt',
    // Same category (11.1.4): rules a list marks as meant for another platform (tools/build/list-directives.mjs).
    'dropped-platform-rules.txt',
    // Same category (10.7.6): regexFilter rules Chrome refused or could not verify (tools/build/regex-support.mjs).
    REGEX_SUPPORT_CONFIG.REPORT_FILE,
];

// Where dist output goes.
const DIST_DIR = path.join(ROOT, 'dist');
// Ephemeral staging directory — always cleared before AND after a run
// (RELEASE guard), so no interrupted run's leftovers can survive into a
// later one.
const STAGE_DIR = path.join(ROOT, 'dist', '.staging');

// Persisted per-artifact "last shipped" record — sha256 content hash +
// the version it was last actually rebuilt under. Lets this script
// answer "did the tools/ content change since the last release" without
// git (this sandbox's filesystem doesn't persist git history reliably
// across sessions either — see CHANGELOG_HISTORY.md's 8.3.1 entry).
const ARTIFACT_STATE_FILE = path.join(ROOT, 'tools', 'package-release-state.json');

const ARTIFACTS = [ 'extension', 'tools', 'docs' ];
// docs MUST stay last: main() saves the state ledger just before staging docs, so the docs zip carries this
// release's ledger (see STATE_FILE_REL).
// The ledger's path relative to ROOT, as it appears in the docs file set.
const STATE_FILE_REL = path.join('tools', 'package-release-state.json');

// SAFE filter update (10.2.0): tools/build-safe-filters.mjs writes this marker (the last published extension
// zip it built against). When present, the extension zip is verified against that baseline with
// tools/verify-safe-update.mjs right after it is built — a package that does not qualify for skip-review fails
// the release instead of being uploaded by mistake. The marker is consumed (deleted) by a successful run.
const SAFE_MARKER_FILE = path.join(DIST_DIR, '.safe-update-baseline.json');

/*==============================================================================
    GUARDS — init / clear / release, per this project's own standing
    convention (guards for resource init, clear, and release).
==============================================================================*/

async function guardInit() {
    // Fail loudly before touching anything if manifest.json doesn't
    // parse, or if DOC_FILES/TOOLS_ROOT_FILES have drifted from the
    // repo's actual root-level files (an untracked doc/tooling file
    // added since this script was last edited would otherwise silently
    // ship in the wrong zip, or not ship at all).
    const manifestRaw = await fs.readFile(path.join(ROOT, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw); // throws loudly if malformed
    if ( typeof manifest.version !== 'string' || manifest.version === '' ) {
        throw new Error('guardInit: manifest.json has no version field.');
    }

    const rootEntries = await fs.readdir(ROOT, { withFileTypes: true });
    const rootMdFiles = rootEntries
        .filter(e => e.isFile() && e.name.endsWith('.md'))
        .map(e => e.name)
        .sort();
    // Every root .md file must be accounted for as either a doc (ships
    // in docs.zip) or an extension-only .md file (ships in extension.zip
    // instead — see EXTENSION_ONLY_ROOT_MD_FILES's own comment for why
    // THIRD_PARTY_LICENSES.md is the one file in this second category).
    const declaredDocs = [ ...DOC_FILES, ...EXTENSION_ONLY_ROOT_MD_FILES ].sort();
    if ( JSON.stringify(rootMdFiles) !== JSON.stringify(declaredDocs) ) {
        throw new Error(
            `guardInit: DOC_FILES drift detected.\n` +
            `  On disk:  ${rootMdFiles.join(', ')}\n` +
            `  Declared: ${declaredDocs.join(', ')}\n` +
            `Update DOC_FILES at the top of this file before packaging.`
        );
    }

    for ( const f of TOOLS_ROOT_FILES ) {
        try {
            await fs.access(path.join(ROOT, f));
        } catch {
            throw new Error(`guardInit: declared TOOLS_ROOT_FILES entry "${f}" does not exist on disk.`);
        }
    }

    return manifest.version;
}

async function guardClearStaging() {
    // INIT-time clear — removes any leftover staging directory from a
    // prior, interrupted run before this run starts. Every run is
    // idempotent because of this, not because runs are assumed to
    // always finish cleanly.
    await fs.rm(STAGE_DIR, { recursive: true, force: true });
    await fs.mkdir(STAGE_DIR, { recursive: true });
    await fs.mkdir(DIST_DIR, { recursive: true });
}

// PACKAGING-time guard (item 1 — "SAFE-FILTERS" scriptlet exceptions):
// build-rulesets.mjs writes tools/scriptlet-wildcard-report.json every
// run — empty when no wildcard (`#@#//scriptlet()`, all-scriptlets-on-
// this-hostname) exceptions are active, non-empty otherwise. A wildcard
// exception is a deliberate stopgap (see badfilter-quick-fixes.txt's own
// discussion of why it's blunter than the named form) that should never
// silently ship forever — this halts packaging and requires explicit
// confirmation every time one is present, specifically so it keeps
// surfacing until it's actually resolved (named exception, or the
// underlying scriptlet fixed upstream) rather than being buried in
// ordinary build console output and forgotten.
async function guardScriptletWildcardExceptions() {
    const reportPath = path.join(ROOT, 'tools', 'scriptlet-wildcard-report.json');
    let report;
    try {
        report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    } catch {
        // Report missing entirely (e.g. build-rulesets.mjs hasn't been run
        // yet this session) — nothing to guard against; not this script's
        // job to run the filter build itself.
        return;
    }
    if ( !Array.isArray(report) || report.length === 0 ) { return; }

    if ( process.argv.includes('--confirm-wildcard-scriptlets') ) {
        console.log(`\nProceeding with ${report.length} active wildcard scriptlet exception(s) (confirmed via --confirm-wildcard-scriptlets):`);
        for ( const { hostname, suppressedCount } of report ) {
            console.log(`  ${hostname} — ${suppressedCount} scriptlet(s) suppressed`);
        }
        return;
    }

    const lines = report.map(({ hostname, suppressedCount }) => `  ${hostname} — ${suppressedCount} scriptlet(s) suppressed`);
    throw new Error(
        `HALTED before packaging: ${report.length} wildcard scriptlet exception(s) ` +
        `(#@#//scriptlet(), no name) are currently active — a blunt stopgap that ` +
        `silently swallows every scriptlet on that hostname, not just the one that ` +
        `was broken:\n${lines.join('\n')}\n` +
        `Re-run with --confirm-wildcard-scriptlets once you've decided this is ` +
        `acceptable for this release, or replace the wildcard with a named ` +
        `exception in badfilter-quick-fixes.txt and rebuild first.`
    );
}

async function guardSyncToolsPackageVersion(resolvedToolsVersion) {
    // RELEASE-time sync guard — real incident (tools v1.7.0): this field
    // used to be hand-maintained and drifted silently out of sync with
    // the actual version this script computes and persists in
    // ARTIFACT_STATE_FILE (last recorded here: package.json said
    // 1.6.18, the last-shipped zip filename said 1.6.20, and
    // CHANGELOG.md's last documented tools entry said 1.6.4 — three
    // different numbers for one artifact). tools/package.json's
    // "version" field is no longer a second, independently-maintained
    // copy — it is written FROM this script's own resolved version,
    // every run, whether or not tools was rebuilt this pass, so there
    // is exactly one source of truth (ARTIFACT_STATE_FILE) and one
    // place that copies it outward. See tools/check-version-sync.mjs
    // for the complementary check that verifies this stayed true.
    const pkgPath = path.join(ROOT, 'package.json'); // tools artifact's own package.json — lives at repo root, per TOOLS_ROOT_FILES above, not under tools/
    const pkgRaw = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgRaw);
    if ( pkg.version === resolvedToolsVersion ) { return; } // already in sync, no write needed
    pkg.version = resolvedToolsVersion;
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log(`package.json (tools artifact) version synced to ${resolvedToolsVersion}.`);
}

async function guardRelease() {
    // RELEASE guard — removes the staging directory after zipping.
    // Called from main()'s own try/finally, so it runs even if packaging
    // fails partway through — no mutable intermediate state survives a
    // broken run into the next one.
    await fs.rm(STAGE_DIR, { recursive: true, force: true });
}

async function guardNoLeakedFiles(stageSubdir, forbiddenNames, label) {
    // Structurally guaranteed, not just remembered: after staging an
    // artifact, assert none of the forbidden filenames are present
    // anywhere in that staged tree. Aborts the whole run rather than
    // silently shipping a leaked file.
    const found = [];
    async function walk(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for ( const e of entries ) {
            if ( forbiddenNames.has(e.name) ) { found.push(path.relative(stageSubdir, path.join(dir, e.name))); }
            if ( e.isDirectory() ) { await walk(path.join(dir, e.name)); }
        }
    }
    await walk(stageSubdir);
    if ( found.length > 0 ) {
        throw new Error(`guardNoLeakedFiles: ${label} staging contains forbidden file(s): ${found.join(', ')}`);
    }
}

/*==============================================================================
    Per-artifact file-list resolution
==============================================================================*/

async function listAllFiles(dir, relTo = dir) {
    const out = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for ( const e of entries.sort((a, b) => a.name.localeCompare(b.name)) ) {
        if ( NEVER_SHIP.includes(e.name) ) { continue; }
        const full = path.join(dir, e.name);
        if ( e.isDirectory() ) {
            out.push(...await listAllFiles(full, relTo));
        } else {
            out.push(path.relative(relTo, full));
        }
    }
    return out;
}

async function resolveArtifactFiles() {
    const allRootFiles = await listAllFiles(ROOT);

    const docSet = new Set([ ...DOC_FILES, ...DOCS_EXTRA_FILES ]);
    const toolsSet = new Set([
        ...TOOLS_ROOT_FILES,
        // DOCS_EXTRA_FILES entries under TOOLS_DIR (currently just package-release-state.json) are
        // excluded here so they ship in docs.zip only, not doubled into tools.zip too.
        ...(await listAllFiles(path.join(ROOT, TOOLS_DIR)))
            .map(f => path.join(TOOLS_DIR, f))
            .filter(f => !DOCS_EXTRA_FILES.includes(f)),
    ]);

    const docs = allRootFiles.filter(f => docSet.has(f));
    const tools = allRootFiles.filter(f => toolsSet.has(f));
    const extension = allRootFiles.filter(f => {
        if ( docSet.has(f) ) { return false; }
        if ( toolsSet.has(f) ) { return false; }
        if ( f.startsWith(TOOLS_DIR + path.sep) ) { return false; }
        // Includes LICENSE.txt (per the constant above) and
        // THIRD_PARTY_LICENSES.md (per EXTENSION_ONLY_ROOT_MD_FILES —
        // not in docSet, so it reaches here naturally, no special-case
        // needed).
        return true;
    });

    return { extension, tools, docs };
}

/*==============================================================================
    Change detection — sha256 over sorted (relPath, content) pairs
==============================================================================*/

// Files whose "version" field is a derived OUTPUT of this script (via
// guardSyncToolsPackageVersion, above), not an independent source of
// "did this artifact's real content change" — normalized out of the
// hash so writing the resolved version back doesn't look like a content
// change on the NEXT run, which would otherwise force a version bump
// every single run regardless of whether anything real changed. Single
// place this exception lives, per this project's own "declared once,
// not scattered" convention.
const VERSION_FIELD_NORMALIZED_FILES = new Set([ 'package.json' ]);

async function hashFileSet(relPaths) {
    const hash = crypto.createHash('sha256');
    for ( const rel of [ ...relPaths ].sort() ) {
        let content = await fs.readFile(path.join(ROOT, rel));
        if ( VERSION_FIELD_NORMALIZED_FILES.has(rel) ) {
            const parsed = JSON.parse(content.toString('utf8'));
            delete parsed.version;
            content = Buffer.from(JSON.stringify(parsed));
        }
        hash.update(rel);
        hash.update('\0');
        hash.update(content);
    }
    return hash.digest('hex');
}

async function loadState() {
    try {
        return JSON.parse(await fs.readFile(ARTIFACT_STATE_FILE, 'utf8'));
    } catch {
        return {}; // first run ever — every artifact is "changed"
    }
}

async function saveState(state) {
    await fs.writeFile(ARTIFACT_STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/*==============================================================================
    Zip creation (shells out to the system `zip` — same tool this
    project's own manual releases have always used, no new dependency)
==============================================================================*/

async function stageAndZip(name, relFiles, version) {
    const stageSubdir = path.join(STAGE_DIR, name, PROJECT_FOLDER_NAME);
    await fs.mkdir(stageSubdir, { recursive: true });
    for ( const rel of relFiles ) {
        const dest = path.join(stageSubdir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(path.join(ROOT, rel), dest);
    }
    return stageSubdir;
}

function zipDirectory(stageSubdir, outZipPath) {
    // Zip from inside dist/.staging/<name>/ so the archive's own internal
    // paths start at PROJECT_FOLDER_NAME/, not the full host path.
    const cwd = path.dirname(stageSubdir);
    execFileSync('zip', [ '-r', '-q', outZipPath, PROJECT_FOLDER_NAME ], { cwd, stdio: 'inherit' });
}

/*==============================================================================
    SAFE filter update verification (10.2.0)
==============================================================================*/

function verifySafeUpdateIfRequested(newZipPath) {
    let marker;
    try { marker = JSON.parse(readFileSync(SAFE_MARKER_FILE, 'utf8')); } catch { return; } // normal release
    console.log(`SAFE filter update: verifying against the published ${marker.baselineVersion} (${path.basename(marker.baselineZip)})…`);
    try {
        execFileSync(process.execPath, [ path.join(ROOT, 'tools', 'verify-safe-update.mjs'), marker.baselineZip, newZipPath ], { cwd: ROOT, stdio: 'inherit' });
    } catch {
        throw new Error(`the extension zip does NOT qualify for skip-review against ${marker.baselineVersion} — see the verifier's reasons above. Not a SAFE update.`);
    }
}

/*==============================================================================
    Main
==============================================================================*/

// Tools ships its own independent version, NOT the extension's
// manifest.json version — the person's own explicit instruction: tools
// changes on its own schedule (an internal dev-tooling revision) that
// has nothing to do with when the extension itself last shipped. Starts
// at 1.0.0 only when tools' own content hash actually changes — same
// "only rebuild if changed" rule as every other artifact, just with its
// own version line instead of borrowing the extension's.
//
// BUG FIXED (v8.6.3 packaging pass): this function used to bump only the
// (major, minor) pair and silently drop the patch digit whenever `prior`
// was already 3-part semver (e.g. '1.6.3' -> '1.7', not '1.6.4') — a
// genuine version-scheme mismatch, not a cosmetic one, since the actual
// tools history (see CHANGELOG.md — 1.5.7, 1.6.0, 1.6.3, ...) has been
// 3-part semver for a long time before this pass. Now bumps the PATCH
// component when `prior` has one, matching the version scheme actually
// in use, and only falls back to the 2-part (major.minor) shape for a
// genuinely 2-part prior version (there is no historical evidence this
// project's tools version was ever 2-part, but the fallback is kept for
// robustness against a hand-edited prior value).
const TOOLS_INITIAL_VERSION = '1.0.0';

// (11.0.0, owner's decision 2026-11-19: tools 3.0.0) A deliberate jump. package.json's "version" is normally only a COPY
// of the ledger (guardSyncToolsPackageVersion); a value set there by hand that is NEWER than the next patch version is
// read as the owner's chosen next version (a major/minor jump) and used instead. tools/check-version-sync.mjs allows
// package.json to be ahead of the ledger for exactly this pending case.
function compareDottedVersions(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for ( let i = 0; i < Math.max(pa.length, pb.length); i++ ) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if ( d !== 0 ) { return d < 0 ? -1 : 1; }
    }
    return 0;
}
async function requestedToolsVersion() {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && /^\d+\.\d+\.\d+$/.test(pkg.version) ? pkg.version : null;
}

function nextToolsVersion(prior) {
    if ( !prior ) { return TOOLS_INITIAL_VERSION; }
    const parts = prior.split('.').map(n => parseInt(n, 10));
    const major = Number.isFinite(parts[0]) ? parts[0] : 1;
    const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
    if ( parts.length >= 3 && Number.isFinite(parts[2]) ) {
        return `${major}.${minor}.${parts[2] + 1}`;
    }
    return `${major}.${minor + 1}`;
}

async function main() {
    const version = await guardInit();
    await guardClearStaging();
    await guardScriptletWildcardExceptions();

    console.log(`Packaging release — extension/docs v${version}\n`);

    const { extension, tools, docs } = await resolveArtifactFiles();
    const fileSets = { extension, tools, docs };
    // Per-artifact version scheme — extension and docs share the
    // extension's own version (they ARE that release's package and its
    // record); tools resolves its own independent version below, once
    // its hash is known to have changed or not.
    const versionFor = { extension: version, docs: version };

    const state = await loadState();
    const results = {};

    for ( const artifact of ARTIFACTS ) {
        const files = fileSets[artifact];
        // (10.7.9, audit 10.7.8) The state ledger is excluded from the docs hash: it is rewritten every release, so
        // hashing it made docs read as "changed" every time, and it is not docs content (the docs zip carries it).
        const hashedFiles = artifact === 'docs' ? files.filter(rel => rel !== STATE_FILE_REL) : files;
        const currentHash = await hashFileSet(hashedFiles);
        const prior = state[artifact];

        if ( prior && prior.hash === currentHash ) {
            console.log(`${artifact}: unchanged since v${prior.version} — not rebuilt, not re-versioned.`);
            results[artifact] = { rebuilt: false, version: prior.version };
            if ( artifact === 'tools' ) { await guardSyncToolsPackageVersion(prior.version); }
            continue;
        }

        let artifactVersion = artifact === 'tools'
            ? nextToolsVersion(prior?.version)
            : versionFor[artifact];
        if ( artifact === 'tools' ) {
            const requested = await requestedToolsVersion();
            if ( requested !== null && compareDottedVersions(requested, artifactVersion) > 0 ) { artifactVersion = requested; }
        }

        if ( artifact === 'tools' ) { await guardSyncToolsPackageVersion(artifactVersion); }

        if ( artifact === 'docs' ) {
            // (10.7.9, audit 10.7.8) Write the ledger BEFORE staging docs: the docs zip carries
            // tools/package-release-state.json, and staging it before saveState() shipped the PREVIOUS release's
            // ledger in every docs zip (10.7.8's said 10.7.7 / 2.0.46 — suite step 19 failed on the shipped tree).
            // docs is the last entry of ARTIFACTS, so extension and tools are already recorded here.
            state[artifact] = { hash: currentHash, version: artifactVersion, files: files.length };
            await saveState(state);
        }

        const stageSubdir = await stageAndZip(artifact, files, artifactVersion);

        if ( artifact === 'extension' ) {
            // Anything in DOC_FILES is forbidden in the extension package
            // — no exceptions needed anymore now that
            // THIRD_PARTY_LICENSES.md moved to EXTENSION_ONLY_ROOT_MD_FILES
            // instead of living in DOC_FILES with a carve-out. DOCS_EXTRA_FILES' basenames added too
            // (10.5.0) — TOOLS_DIR already covers package-release-state.json structurally (it lives
            // under tools/, and the whole directory is forbidden here), but listing the basename
            // explicitly keeps this guard legible on its own, not dependent on that other file's path.
            const forbiddenInExtension = new Set(
                [ ...DOC_FILES, ...TOOLS_ROOT_FILES, TOOLS_DIR, ...DOCS_EXTRA_FILES.map(f => path.basename(f)) ]
            );
            await guardNoLeakedFiles(stageSubdir, forbiddenInExtension, 'extension');
        }

        const outName = artifact === 'tools'
            ? `${PROJECT_FOLDER_NAME}-tools-${artifactVersion}.zip`
            : `${PROJECT_FOLDER_NAME}-${artifactVersion}-${artifact}.zip`;
        const outPath = path.join(DIST_DIR, outName);
        await fs.rm(outPath, { force: true }); // never build into a name that might already exist (stale-entry pitfall)
        zipDirectory(stageSubdir, outPath);
        if ( artifact === 'extension' ) { verifySafeUpdateIfRequested(outPath); }

        state[artifact] = { hash: currentHash, version: artifactVersion, files: files.length };
        if ( artifact === 'extension' ) {
            // What this release actually ships, for tools/check-permission-
            // additions.mjs (principle C36): a permission ADDED in a later
            // update disables the extension for every existing user until
            // they re-approve it, so the next release is compared against
            // THIS record — the last published manifest, not the last session.
            state[artifact].shippedPermissions = await readShippedPermissions();
        }
        console.log(`${artifact}: CHANGED — rebuilt as v${artifactVersion} (${files.length} files) -> dist/${outName}`);
        results[artifact] = { rebuilt: true, version: artifactVersion };
    }

    await saveState(state);
    await fs.rm(SAFE_MARKER_FILE, { force: true });   // consumed — a later normal release must not be verified as SAFE
    console.log(`\nDone. ${Object.values(results).filter(r => r.rebuilt).length} of 3 artifacts rebuilt.`);
}

// The four manifest keys whose additions can trigger Chrome's re-approval
// prompt (optional ones are listed too, so a move between required and
// optional is visible). Sorted, so the record is stable across releases.
const PERMISSION_KEYS = [ 'permissions', 'host_permissions', 'optional_permissions', 'optional_host_permissions' ];
async function readShippedPermissions() {
    const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
    return Object.fromEntries(PERMISSION_KEYS.map(k => [ k, [ ...(manifest[k] ?? []) ].sort() ]));
}

main()
    .catch(err => {
        console.error('\npackage-release.mjs FAILED:', err.message);
        process.exitCode = 1;
    })
    .finally(guardRelease); // RELEASE guard — runs even on failure
