// ── tools/build/build-steps.mjs ───────────────────────────────────────────────────────
// The nine build steps (INIT ... REPORTS). Each step's header lists what it reads from and writes to ctx.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: readJsonOr, stepCleanOrphans, stepCompileLists, stepInit, stepScriptletAssets, stepScriptletExceptions, stepScriptletPrecompile, stepWriteRegistries, stepWriteReports, stepWriteScriptletFiles
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import fs from 'fs/promises';
import path from 'path';
import { STATIC_FILTER_LIST_PRIORITY } from '../../js/core/dnr-budgets.js';
import { SCRIPTLET_POLICY, scriptletViolationAnySource } from '../../js/data/scriptlet-policy.js';
import { ROOT, __dirname } from './build-paths.mjs';
import { UNSUPPORTED_LINES_CONFIG } from './unsupported-lines.mjs';
import { STEP_OK, agBaseLanguageBucketText, buildNotices, droppedBadfilters, droppedGenericDomainQualifiers, droppedPlatformLines, droppedPolicyScriptlets, droppedUnsupportedListLines, droppedUnsupportedScriptletScopes, droppedWildcardDomains, expandedWildcardDomains, resetBuildAccumulators, setTopSitesSet, topSitesSet, worryfreeExemptDomains } from './build-state.mjs';
import { COSMETIC_SPECIFIC_CONFIG, buildCosmeticFile, buildCosmeticSpecificData, buildCosmeticSpecificLoader, stampCosmeticSpecificData } from './cosmetic-data.mjs';
import { extractCountryOverflow } from './country-overflow.mjs';
import { easylistCookieTextFor, resetEasylistCookieCache } from './easylist-cookie-international.mjs';
import { antiadblockCountryTextFor, resetAntiadblockSplitCache } from './antiadblock-country-split.mjs';
import { fetchTopSitesSet, filterCosmeticMapByPopularity, filterDnrRulesByPopularity, filterScriptletRulesByPopularity } from './crux-top-sites.mjs';
import { buildCustomScriptletsDispatch } from './custom-scriptlets-dispatch.mjs';
import { fetchList } from './fetch-helpers.mjs';
import { FILTER_LISTS } from './filter-lists.mjs';
import { parseList } from './list-parser.mjs';
import { convertUboScriptletSyntax } from './ubo-scriptlet-syntax.mjs';
import { buildTrimmedCorelibs } from './scriptlet-corelibs.mjs';
import { buildCookieNoticeSets, resetCookieNoticeCache } from './cookie-notice-sources.mjs';
import { writeCookieNoticeFiles } from './cookie-notice-write.mjs';
import { buildAdCleanerData, writeAdCleanerData } from './ad-cleaner-sources.mjs';
import { releasePrivacyBadgerNeededHosts } from './privacy-badger-unbreak.mjs';
import { AD_CLEANER_DATA_FILE } from '../../js/data/ad-cleaner.js';
import { COOKIE_NOTICE_MODE_FILES, COOKIE_NOTICE_SITES_FILE } from '../../js/data/cookie-notice-sets.js';
import { decodeDispatchSource, encodeDispatchTables, renderLibraryEndFile, renderLibraryFile, renderScriptletFile, splitSitesAndEntities, verifyRoundTrip } from './scriptlet-dispatch-layout.mjs';
import { SCRIPTLET_ENTITY_DATA_SUFFIX, SCRIPTLET_LIBRARY_END_FILE, SCRIPTLET_LIBRARY_ENTITY_FILE, SCRIPTLET_LIBRARY_FILE, SCRIPTLET_SITES_FILE } from '../../js/data/scriptlet-library.js';
import { applyScriptletExceptions } from './scriptlet-rules.mjs';
import { buildExemptionCarrierRules, isExemptionCarrierRule } from '../../js/core/builtin-exemption-carriers.js';
import { buildPopunderCarrierRules, isPopunderCarrierRule } from '../../js/core/popunder-carriers.js';
import { extractPopunderLines } from '../../js/util/popunder-parser.js';
import { REMOVEPARAM_COMPANIONS, UNSAFE_RULE_COMPANIONS } from '../../js/data/ruleset-companions.js';
import { isSafeRule } from './safe-update-rules.mjs';
import { REGEX_SUPPORT_CONFIG, closeRegexSupport, filterSupportedRegexRules, noteShippedRegexRules, openRegexSupport } from './regex-support.mjs';
import { SITE_MODE_OPTIONS } from '../../js/util/site-mode-parser.js';

/******************************************************************************/
// Main build
/******************************************************************************/

// Reads a JSON file, or returns `fallback` if it is absent or unparseable
// (a fresh tree has no previous build to carry over — that is not an error
// here; carryOverPreviousBuild() then simply finds nothing to keep).
export async function readJsonOr(filePath, fallback) {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return fallback; }
}

/******************************************************************************/
// Build step 1 of 9 — INIT: reset accumulators, prepare directories, read the manifest and the previous build's registries, download the CrUX top-sites set once (before anything is written).
// Reads from ctx : (nothing)
// Writes to ctx  : rulesetDir, legacyCosmeticFixtureDir, manifestPath, manifest, ruleResources, rulesetDetails, allScriptletRules, allScriptletExceptions, usedScriptletNames, allCosmeticFiles, previousBuild, carriedOverIds, failedListIds, carryOverPreviousBuild
// Body moved VERBATIM from the old single build() (phase 2, audit after
// 9.7.5) — proven byte-identical in output and console by a replayed build.
export async function stepInit(ctx) {
    const rulesetDir = path.join(ROOT, 'rulesets');
    await fs.mkdir(rulesetDir, { recursive: true });

    // RELEASE guard — fresh accumulator each build run, same discipline as
    // every other per-run accumulator in this file (see its own
    // declaration/header comment above parseList()).
    resetBuildAccumulators();   // (was ten inline assignments — now one owner, see build-state.mjs)
    resetEasylistCookieCache(); // (10.4.9) the EasyList Cookie International download of a previous run is never reused
    resetCookieNoticeCache();   // (11.0.0) nor the cookie-notice sets
    resetAntiadblockSplitCache(); // (2026-11-09) same for AdGuard Base's anti-adblock section, split by country
    await openRegexSupport(ROOT); // (10.7.6) INIT: the cached Chrome verdicts for regexFilter rules (regex-support.mjs)

    // GUARD: init — test-fixture directory for the OLD embedded-blob
    // cosmetic format, generated ONLY as ground truth for tools/check-
    // cosmetic-specific-format-equivalence.mjs (step 16 of complete-
    // check.mjs). Deliberately OUTSIDE rulesets/ (and therefore outside
    // every shipped zip — see CHANGELOG.md's 7.7.10 entry): as of
    // 7.7.10 this format is no longer registered by anything at runtime,
    // so shipping it would be pure dead weight, working directly against
    // the whole point of this optimization. Regenerated fresh on every
    // build (see the GUARD: clear/release right after this) — never
    // manually edited, never diffed for review, purely a build artifact.
    const legacyCosmeticFixtureDir = path.join(ROOT, 'test-fixtures', 'legacy-cosmetic');
    await fs.mkdir(legacyCosmeticFixtureDir, { recursive: true });
    // GUARD: clear/release — wipe any stale fixture files from a PRIOR
    // build before writing this run's. Without this, a ruleset removed or
    // renamed between builds would leave an orphaned, no-longer-generated
    // file behind that the differential test would keep reading forever
    // (silently testing stale data, not a build failure — the same class
    // of bug this project's own guard convention exists to prevent).
    for ( const f of await fs.readdir(legacyCosmeticFixtureDir).catch(() => []) ) {
        if ( f.endsWith('-cosmetic.js') ) {
            await fs.unlink(path.join(legacyCosmeticFixtureDir, f)).catch(() => {});
        }
    }

    const manifestPath = path.join(ROOT, 'manifest.json');
    const manifest     = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

    const ruleResources  = [];
    const rulesetDetails = [];
    const allScriptletRules = [];   // accumulated across all lists
    const allScriptletExceptions = []; // accumulated across all lists — #@#//scriptlet() lines
    const usedScriptletNames = new Set();
    const allCosmeticFiles = [];    // per-ruleset cosmetic JS files

    // ── Carry-over of a list whose download failed (tools audit, item 2) ──
    // Per explicit requirement, one list that still fails after its retry
    // no longer aborts the whole update: its PREVIOUS build is kept as-is
    // and a warning is printed at the end. "Kept as-is" has to be
    // complete, or the output becomes inconsistent: its ruleset files are
    // simply not rewritten, and its entries from the previous registries
    // (manifest rule_resources, ruleset-details.json, cosmetic-files.json,
    // scriptlet-files.json) are re-registered unchanged, so the orphan
    // cleanup below keeps its files and the runtime keeps loading them.
    // A carried-over scriptlet data file calls the shared library by name;
    // stepWriteScriptletFiles() adds the names it calls to this build's
    // library (and stops if it predates the shared-library layout).
    // Every id a list owns is DECLARED (list.id, its companions (companionIdsOf()), its
    // countryOverflow ids) — never matched by name prefix, which would be
    // wrong (e.g. ruleset_adguard_base_removeparam starts with ruleset_adguard_base).
    const previousBuild = {
        ruleResources: manifest.declarative_net_request?.rule_resources ?? [],
        details:       await readJsonOr(path.join(rulesetDir, 'ruleset-details.json'), []),
        cosmeticFiles: await readJsonOr(path.join(rulesetDir, 'cosmetic-files.json'), []),
        scriptletFiles: await readJsonOr(path.join(rulesetDir, 'scriptlet-files.json'), []),
    };
    const carriedOverIds = new Set();   // every ruleset id kept from the previous build
    const failedListIds  = new Set();   // list ids whose download failed

    async function carryOverPreviousBuild(list, reason) {
        const ids = new Set([
            list.id,
            ...companionIdsOf(list.id),
            ...(list.countryOverflow ?? []).flatMap(o => [ o.id, ...companionIdsOf(o.id) ]),
        ]);
        const prevResources = previousBuild.ruleResources.filter(r => ids.has(r.id));
        if ( prevResources.some(r => r.id === list.id) === false ) { return false; }
        for ( const r of prevResources ) {
            try { await fs.access(path.join(ROOT, r.path)); } catch { return false; }
        }
        // The list's own ruleset(s) follow the CURRENT list definition's
        // enabled flag (it may have changed since the last build); its
        // hidden overflow buckets keep their own recorded flag.
        function isOwnRuleset(id) { return id === list.id || companionIdsOf(list.id).includes(id); }
        ruleResources.push(...prevResources.map(r => isOwnRuleset(r.id) ? { ...r, enabled: list.enabled } : r));
        rulesetDetails.push(...previousBuild.details.filter(d => ids.has(d.id)));
        allCosmeticFiles.push(...previousBuild.cosmeticFiles.filter(f => ids.has(f.id)));
        for ( const id of ids ) { carriedOverIds.add(id); }
        failedListIds.add(list.id);
        buildNotices.push({
            level: 'WARNING',
            text: `${list.name} (${list.id}) was NOT updated — ${reason}. The previous build of this list was kept unchanged ` +
                  `(${prevResources.length} ruleset file(s)). Its scriptlet exceptions did not apply to other lists in this run. ` +
                  'Re-run the filter update to retry.',
        });
        return true;
    }

    // GUARD: fetched at most once per build, before any list is parsed —
    // resolveWildcardDomainTokens() (called from deep inside each list's
    // own parseList()/parseBlockRule() below) needs it to validate
    // $domain=example.* wildcard-expansion candidates against real traffic
    // data, and that need doesn't depend on any particular list opting in
    // (unlike the historical cosmetic-popularity use, which WAS gated on
    // list.popularityFilter — see filterCosmeticMapByPopularity() above,
    // currently unused by any list but kept working). Since essentially
    // every real build processes at least one list with $domain= wildcard
    // tokens (AG Base alone had 439 at last count), gating this fetch
    // conditionally the way the old cosmetic-only use did would just mean
    // it fires on nearly every real build anyway — simpler to always fetch
    // it once, unconditionally, than to maintain a "do we need it" guard
    // that's true in practice almost every time. Released (set back to
    // null) once every list has been processed, matching the "clear
    // resources when done" discipline the rest of this script follows for
    // per-list state.
    setTopSitesSet(await fetchTopSitesSet());
    Object.assign(ctx, { rulesetDir, legacyCosmeticFixtureDir, manifestPath, manifest, ruleResources, rulesetDetails, allScriptletRules, allScriptletExceptions, usedScriptletNames, allCosmeticFiles, previousBuild, carriedOverIds, failedListIds, carryOverPreviousBuild });
    return STEP_OK;
}

/******************************************************************************/
// Unsafe-rule split (10.2.0). Pure apart from the build notices it adds.
/******************************************************************************/

// How many dropped rules a warning spells out (the rest is a count).
const UNSAFE_DROP_SAMPLE_SIZE = 3;

function dropUnsafeRulesWithWarning(ownerId, rules) {
    const unsafe = rules.filter(r => !isSafeRule(r));
    if ( unsafe.length === 0 ) { return rules; }
    const sample = unsafe.slice(0, UNSAFE_DROP_SAMPLE_SIZE).map(r => `#${r.id} ${r.action?.type} ${JSON.stringify(r.condition).slice(0, 80)}`).join('; ');
    buildNotices.push({
        level: 'WARNING',
        text: `${ownerId}: ${unsafe.length} unsafe rule(s) DROPPED — this list has no unsafe-rule companion ` +
              `(js/data/ruleset-companions.js UNSAFE_RULE_COMPANIONS). ${sample}${unsafe.length > UNSAFE_DROP_SAMPLE_SIZE ? '; …' : ''}`,
    });
    return rules.filter(isSafeRule);
}

// Every companion ruleset id a list (or overflow bucket) declares: its unsafe companion and, for AdGuard Base, its
// removeparam companion (js/data/ruleset-companions.js). One place, for the carry-over and the split alike.
function companionIdsOf(id) {
    return [ UNSAFE_RULE_COMPANIONS[id], REMOVEPARAM_COMPANIONS[id] ].filter(c => c !== undefined);
}

// A $removeparam rule: a redirect that only strips query parameters.
function isRemoveparamRule(rule) {
    return Array.isArray(rule.action?.redirect?.transform?.queryTransform?.removeParams);
}

// list + its compiled rules -> { mainRules, companions: [ { id, rules } ] }. Unsafe rules go to the list's unsafe
// companion; a list with a removeparam companion (10.7.6) sends its $removeparam rules there instead, at
// list.removeparamCompanionPriority when set. A list without a companion for a rule kind has those rules
// dropped with a warning (dropUnsafeRulesWithWarning()).
function splitUnsafeRules(list, rules) {
    const unsafeId = UNSAFE_RULE_COMPANIONS[list.id] ?? null;
    const removeparamId = REMOVEPARAM_COMPANIONS[list.id] ?? null;
    const unsafe = rules.filter(r => !isSafeRule(r));
    const toRemoveparam = removeparamId === null ? [] : unsafe.filter(isRemoveparamRule)
        .map(r => list.removeparamCompanionPriority === undefined ? r : { ...r, priority: list.removeparamCompanionPriority });
    let toUnsafe = removeparamId === null ? unsafe : unsafe.filter(r => !isRemoveparamRule(r));
    if ( unsafeId === null ) {
        dropUnsafeRulesWithWarning(list.id, toUnsafe);
        toUnsafe = [];
    }
    const companions = [];
    if ( unsafeId !== null ) { companions.push({ id: unsafeId, rules: toUnsafe }); }
    if ( removeparamId !== null ) { companions.push({ id: removeparamId, rules: toRemoveparam }); }
    return { mainRules: rules.filter(isSafeRule), companions };
}

/******************************************************************************/
// Build step 2 of 9 — LISTS: download, validate, parse and compile every filter list (carry-over on a failed download).
// Reads from ctx : rulesetDir, legacyCosmeticFixtureDir, ruleResources, rulesetDetails, allScriptletRules, allScriptletExceptions, usedScriptletNames, allCosmeticFiles, failedListIds, carryOverPreviousBuild
// Writes to ctx  : (nothing)
// Body moved VERBATIM from the old single build() (phase 2, audit after
// 9.7.5) — proven byte-identical in output and console by a replayed build.
export async function stepCompileLists(ctx) {
    const { rulesetDir, legacyCosmeticFixtureDir, ruleResources, rulesetDetails, allScriptletRules, allScriptletExceptions, usedScriptletNames, allCosmeticFiles, failedListIds, carryOverPreviousBuild } = ctx;
    for ( const list of FILTER_LISTS ) {
        if ( list.derivedFrom !== undefined && failedListIds.has(list.derivedFrom) ) {
            // Its text comes from a list that was just carried over — carry
            // this one over too instead of rebuilding it from nothing.
            if ( await carryOverPreviousBuild(list, `its source list ${list.derivedFrom} could not be downloaded`) ) {
                console.log(`${list.name}: kept previous build (source list failed).`);
                continue;
            }
            console.error(`\nERROR: ${list.name}: its source list ${list.derivedFrom} failed and there is no previous build of this list to keep — cannot continue.`);
            process.exit(1);
        }
        process.stdout.write(`Fetching ${list.name}… `);
        let text;
        try {
            if ( typeof list.customFetch === 'function' ) {
                text = await list.customFetch();
            } else if ( Array.isArray(list.url) ) {
                const parts = await Promise.all(list.url.map(u => fetchList(u)));
                text = parts.join('\n');
            } else {
                text = await fetchList(list.url);
            }
            // (10.4.9) EasyList Cookie International: this language's cookie-banner hide rules, appended silently.
            const cookieText = await easylistCookieTextFor(list.id);
            if ( cookieText !== '' ) { text = `${text}\n${cookieText}`; }
            // (2026-11-09) AdGuard Base anti-adblock rules for this language's country sites — same per-list append
            // pattern as the cookie rules just above (antiadblock-country-split.mjs).
            const antiadblockText = await antiadblockCountryTextFor(list.id);
            if ( antiadblockText !== '' ) { text = `${text}\n${antiadblockText}`; }
            // (audit 10.6.4) uBO `##+js(…)` scriptlet lines -> AdGuard form, BEFORE any parser sees the text: they used
            // to reach the cosmetic parser as invalid "+js(…)" selectors, which disabled every hide rule of their site.
            const ubo = convertUboScriptletSyntax(text);
            text = ubo.text;
            if ( ubo.converted + ubo.dropped > 0 ) {
                process.stdout.write(`(uBO scriptlet syntax: ${ubo.converted} converted, ${ubo.dropped} dropped) `);
            }
        } catch (err) {
            console.error(`\nERROR: ${err.message}`);
            if ( await carryOverPreviousBuild(list, err.message) ) {
                console.log(`${list.name}: kept previous build (see the warning at the end).`);
                continue;
            }
            console.error(`${list.name}: no previous build of this list to keep — cannot continue.`);
            process.exit(1);
        }

        // Raw filter-line count — every non-empty, non-comment, non-
        // header line in the actual fetched source, BEFORE any parsing
        // into DNR/scriptlet/cosmetic output. This intentionally counts
        // ALL filter syntax (network rules, cosmetic ##... rules,
        // scriptlet #%#... rules together) — "how much did we actually
        // process from upstream," not just the DNR subset. Computed here,
        // not re-derived later, so it can never drift from what
        // parseList() actually saw as input.
        const rawLineCount = text.split('\n').filter(l => {
            const t = l.trim();
            return t !== '' && !t.startsWith('!') && !t.startsWith('[');
        }).length;

        // Per-list priority override — only the Worry-free extra blocklist
        // uses this (WORRY_FREE_EXTRA_BLOCKLIST_PRIORITY, deliberately
        // below the normal filter-list tier — see dnr-budgets.js's own
        // header on this reserved tier). Every other list falls back to
        // the shared default.
        // (10.7.2) Hand-written lists that carry built-in settings (the Quick-fixes list): the prevent-popunder
        // pseudo-scriptlet lines and the unsupported $popup/$popunder lines are taken OUT before parsing, so the
        // scriptlet parser never sees an unknown name and no $popup line is compiled (js/util/popunder-parser.js).
        const popunderLines = list.emitExemptionCarriers === true ? extractPopunderLines(text) : null;
        if ( popunderLines !== null ) { text = popunderLines.remainingText; }
        let { dnrRules, scriptletRules, scriptletExceptions, cosmeticMap } = parseList(text, list.priority ?? STATIC_FILTER_LIST_PRIORITY, {
            listName: list.name,
            convertBadfilterToAllow: list.convertBadfilterToAllow === true,
            reportUnsupportedLines: list.reportUnsupportedLines === true,
            badfilterPriority: list.badfilterPriority,
            allowGenericDomainQualifier: list.allowGenericDomainQualifier === true,
        });
        // (10.7.6) A regexFilter rule ships only when Chrome accepts the regex (regex-support.mjs) — before any
        // count, split or extraction, so every number and file below sees the same rules.
        dnrRules = await filterSupportedRegexRules(dnrRules, list.id);

        // Scriptlet policy gate (10.4.6, rules B and C of js/data/scriptlet-policy.js): code as argument and inserted
        // external URLs are refused for EVERY list, whatever its source (rule A already ran per source at download,
        // fetch-helpers.mjs). Applied right after parsing, before every count and before anything is accumulated, so the
        // shipped data, ruleset-details.json and ag-scriptlets-rules.json all agree.
        if ( !list.skipScriptlets ) {
            scriptletRules = scriptletRules.filter(r => {
                const reason = scriptletViolationAnySource(r.name, r.args);   // rules D, B, C (audit 10.6.4: D added)
                if ( reason === null ) { return true; }
                droppedPolicyScriptlets.push({ source: list.id, name: r.name, args: r.args, reason, hostnames: r.hostnames });
                return false;
            });
        }

        // (10.3.0) The extraRules hook (directly-constructed DNR rules appended after parsing) and the
        // compiledRules / unsafeByDesign / 'security'-category hooks were removed: their last users were
        // the retired SCP header and suspicious-hosting rulesets.

        // Built-in per-site exemptions (10.2.0): this list's "@@domain$worryfree" lines (10.3.0: the retired
        // "@@domain$saferegions" lines are ignored — rule-parsers.mjs) become carrier allow rules in its own ruleset (js/core/builtin-exemption-carriers.js), read back
        // by the runtime. GUARD: no compiled rule may already look like a carrier — the runtime would mistake it
        // for an exemption — so that aborts the build instead of shipping a silent extra exemption.
        if ( list.emitExemptionCarriers === true ) {
            const lookalikes = dnrRules.filter(isExemptionCarrierRule);
            if ( lookalikes.length !== 0 ) {
                throw new Error(`${list.id}: ${lookalikes.length} compiled rule(s) have the exemption-carrier signature (ids ${lookalikes.map(r => r.id).join(', ')}) — change the carrier signature in js/core/builtin-exemption-carriers.js`);
            }
            function ownLines(entries) { return entries.filter(e => e.list === list.name).map(e => e.domain); }
            const nextId = dnrRules.reduce((max, r) => Math.max(max, r.id), 0) + 1;
            const carriers = buildExemptionCarrierRules(nextId, {
                [SITE_MODE_OPTIONS.WORRYFREE]:   ownLines(worryfreeExemptDomains),
            });
            dnrRules = dnrRules.concat(carriers);
            console.log(`  exemption carriers: ${carriers.map(r => `${r.condition.requestDomains.length} domain(s) @${r.priority}`).join(', ') || 'none'}`);

            // (10.7.2) Tab-under guard: this list's "site#%#//scriptlet('prevent-popunder', 'network')" lines (picked
            // out before parsing, see popunderLines above) become INERT carrier rules in its own ruleset
            // (js/core/popunder-carriers.js), read back by js/core/tab-under-guard.js. Same GUARD as above: a compiled
            // rule with the carrier signature aborts the build. A malformed prevent-popunder line, and every
            // $popup/$popunder network line (not supported), is dropped AND reported with its reason
            // (dropped-unsupported-list-lines.txt), never half-applied.
            const popunderLookalikes = dnrRules.filter(isPopunderCarrierRule);
            if ( popunderLookalikes.length !== 0 ) {
                throw new Error(`${list.id}: ${popunderLookalikes.length} compiled rule(s) have the $popunder-carrier signature (ids ${popunderLookalikes.map(r => r.id).join(', ')}) — change the carrier signature in js/core/popunder-carriers.js`);
            }
            for ( const { line, reason } of popunderLines.rejected ) {
                droppedUnsupportedListLines.push({ list: list.name, line, reason });
            }
            const popunderFirstId = dnrRules.reduce((max, r) => Math.max(max, r.id), 0) + 1;
            const popunderCarriers = buildPopunderCarrierRules(popunderFirstId, popunderLines.entries);
            dnrRules = dnrRules.concat(popunderCarriers);
            console.log(`  $popunder carriers: ${popunderCarriers.map(r => `${r.condition.requestDomains.length} network(s) for ${r.condition.initiatorDomains.length} site(s)`).join(', ') || 'none'}`);
        }

        // ── Country-TLD overflow extraction (see extractCountryOverflow) ──
        // Runs before this list's own counts/output are computed, so every
        // downstream number (ruleCount, cosmeticHostnameCount, the written
        // .json/-cosmetic.js files) reflects what actually ships in THIS
        // list once its overflow content has been pulled out.
        const overflowOutputs = [];
        if ( list.countryOverflow && list.countryOverflow.length > 0 ) {
            const extraction = extractCountryOverflow(dnrRules, cosmeticMap, list.countryOverflow);
            dnrRules    = extraction.remainingDnrRules;
            cosmeticMap = extraction.remainingCosmeticMap;
            for ( const overflow of list.countryOverflow ) {
                const bucket = extraction.extractedByBucket.get(overflow.id);
                overflowOutputs.push({
                    id:          overflow.id,
                    name:        overflow.name,
                    locales:     overflow.locales ?? [],
                    sourceUrl:   Array.isArray(list.url) ? list.url.join(' + ') : list.url,
                    dnrRules:    bucket.dnrRules,
                    cosmeticMap: bucket.cosmeticMap,
                });
            }

            // ── foreign.txt language-bucket merge (point 8) ─────────────
            // AdGuard-Base-only: agBaseLanguageBucketText is populated as
            // a side effect of THIS list's own customFetch (see
            // extractForeignRulesSections()). Each bucket's raw text is
            // parsed through the SAME parseList() pipeline as everything
            // else in this list (the same geographic scope gate applies to
            // whatever it contains, not a free pass because it was already
            // language-routed) and merged into the matching
            // TLD-routed bucket above, renumbering DNR ids so they stay
            // unique within the merged file.
            if ( list.id === 'ruleset_adguard_base' && agBaseLanguageBucketText.size > 0 ) {
                for ( const overflowOut of overflowOutputs ) {
                    const bucketText = agBaseLanguageBucketText.get(overflowOut.id);
                    if ( !bucketText ) { continue; }
                    const parsed = parseList(bucketText, list.priority ?? STATIC_FILTER_LIST_PRIORITY, {
                        listName: `${list.name} (foreign.txt → ${overflowOut.id})`,
                        allowGenericDomainQualifier: list.allowGenericDomainQualifier === true,
                    });
                    parsed.dnrRules = await filterSupportedRegexRules(parsed.dnrRules, overflowOut.id);   // same gate as the main list
                    const startId = overflowOut.dnrRules.reduce((max, r) => Math.max(max, r.id), 0) + 1;
                    overflowOut.dnrRules = overflowOut.dnrRules.concat(
                        parsed.dnrRules.map((r, i) => ({ ...r, id: startId + i }))
                    );
                    for ( const [hn, selectors] of parsed.cosmeticMap ) {
                        if ( !overflowOut.cosmeticMap.has(hn) ) { overflowOut.cosmeticMap.set(hn, new Set()); }
                        for ( const sel of selectors ) { overflowOut.cosmeticMap.get(hn).add(sel); }
                    }
                }
            }
        }

        // ── Popularity filter (CrUX top-1M) — see the popularityFilter
        // comment on this list's FILTER_LISTS entry. Runs after country-
        // overflow extraction above, so it only ever trims what's left in
        // THIS list's own always-on core — never the extracted overflow
        // buckets (see that comment for why not).
        // (2026-11-09) Extended from hide rules alone to scriptlet sites and DNR initiatorDomains too, for the lists
        // that set it (anti-adblock, Anti-Admiral — owner's decision). The geographic scope already ran in parseList();
        // together they keep a site rule only for an in-scope TLD AND a CrUX top-1M site, the same two gates the
        // annoyances list applies at its source. GUARD: a list asking for the limit fails the build when the CrUX
        // set is missing, instead of silently shipping unlimited.
        if ( list.popularityFilter ) {
            if ( !(topSitesSet instanceof Set) || topSitesSet.size === 0 ) {
                throw new Error(`${list.id}: popularityFilter is set but the CrUX top-1M set is empty or missing`);
            }
            const before = { css: cosmeticMap.size, sl: scriptletRules.length, dnr: dnrRules.length };
            cosmeticMap    = filterCosmeticMapByPopularity(cosmeticMap, topSitesSet);
            scriptletRules = filterScriptletRulesByPopularity(scriptletRules, topSitesSet);
            dnrRules       = filterDnrRulesByPopularity(dnrRules, topSitesSet);
            console.log(`  popularity filter (CrUX top-1M): dropped ${before.css - cosmeticMap.size} of ${before.css} hide-rule sites, `
                + `${before.sl - scriptletRules.length} of ${before.sl} scriptlet rules, ${before.dnr - dnrRules.length} of ${before.dnr} network rules`);
        }

        const blockCount    = dnrRules.filter(r => r.action.type === 'block').length;
        const allowCount    = dnrRules.filter(r => r.action.type === 'allow').length;
        const redirectCount = dnrRules.filter(r => r.action.type === 'redirect').length;
        const flags = [
            list.skipDNR        ? 'DNR skipped'       : `${dnrRules.length} DNR rules (${blockCount} block, ${allowCount} allow, ${redirectCount} redirect/removeparam)`,
            list.skipScriptlets ? 'scriptlets skipped' : `${scriptletRules.length} scriptlet rules`,
            list.skipCosmetic   ? 'cosmetic skipped'   : `${cosmeticMap.size} cosmetic hostnames`,
        ];
        console.log(flags.join(', '));

        // ── Safe/unsafe split (Chrome Web Store skip-review eligibility, 10.2.0 — one rule for every list) ──
        // A main ruleset file holds SAFE rules only (tools/build/safe-update-rules.mjs isSafeRule()), so a
        // routine refresh of it can qualify for skip-review. Unsafe rules (redirect — what $removeparam and
        // $redirect compile to — or modifyHeaders) go to the list's declared companion
        // (js/data/ruleset-companions.js UNSAFE_RULE_COMPANIONS); a list WITHOUT a companion has them dropped
        // with a build warning (owner's rule). (10.7.6) AdGuard Base also has a REMOVEPARAM companion
        // (REMOVEPARAM_COMPANIONS) for its $removeparam rules — see splitUnsafeRules().
        //
        // removeparamCompanionPriority (10.0.7 removeparamPriority, 10.2.0 unsafeCompanionPriority, 10.7.6 back to
        // the removeparam companion only): ruleset_adguard_base_removeparam sits at
        // WORRY_FREE_ADGUARD_REMOVEPARAM_PRIORITY, below its suppression rule; the other rulesets keep the list's.
        const { mainRules, companions } = splitUnsafeRules(list, dnrRules);

        // Write DNR ruleset (empty array if skipped — keeps manifest entry valid)
        const rulesetPath = path.join(rulesetDir, `${list.id}.json`);
        const dnrOutput = list.skipDNR ? [] : mainRules;
        noteShippedRegexRules(list.id, dnrOutput);   // GUARD: Chrome's regex cap per ruleset (regex-support.mjs)
        await fs.writeFile(rulesetPath, JSON.stringify(dnrOutput, null, 2), 'utf8');

        // Domain count and tracking-parameter count, tracked SEPARATELY —
        // not just DNR rule count, and not merged into one "objects"
        // figure either (see dashboard/filter-manager-ui.js's summary
        // line, which shows both numbers distinctly). A coalesced
        // ruleset can fold thousands of domains into a handful of DNR
        // rules (see the CHUNK_SIZE coalescing above), so `ruleCount`
        // alone would show something like "1 rule" for a 2,000+-domain
        // list. Both summed directly from the actual written output —
        // domainCount from condition.requestDomains, paramCount from
        // redirect.transform.queryTransform.removeParams (e.g.
        // ruleset_adguard_base_removeparam's tracking-parameter list) — never
        // re-derived from source text, so neither can drift from what's
        // really shipped.
        const domainCount = dnrOutput.reduce(
            (n, r) => n + (r.condition?.requestDomains?.length ?? 0), 0
        );
        const paramCount = dnrOutput.reduce(
            (n, r) => n + (r.action?.redirect?.transform?.queryTransform?.removeParams?.length ?? 0), 0
        );

        ruleResources.push({ id: list.id, enabled: list.enabled, path: `rulesets/${list.id}.json` });
        rulesetDetails.push({
            id: list.id, name: list.name,
            // category/locales (10.0.5): single declared source for every
            // consumer that needs a human name or an auto-enable trigger
            // for a ruleset id — the dashboard catalog, the locale
            // auto-enable logic, and the Matrix panel's rule-summary line
            // all read this instead of keeping their own hand-maintained
            // copy. 'default' is the fallback for every list that doesn't
            // explicitly declare itself a language filter — see C21/the
            // naming-convention discussion this generalizes.
            category: list.category ?? 'default',
            locales: list.locales ?? [],
            // (10.4.5) the dashboard label's language, and a combined filter's rows (id, name, language, showCountry,
            // locales) for the dashboard and the auto-enable — present only where declared, so other entries are unchanged.
            ...(typeof list.language === 'string' ? { language: list.language } : {}),
            ...(typeof list.firstLanguage === 'string' ? { firstLanguage: list.firstLanguage } : {}),   // (10.7.0) auto-enable rule, language-auto-enable.js
            ...(Array.isArray(list.countries) ? { countries: list.countries.map(({ id, name, language, showCountry, locales }) =>
                ({ id, name, language, ...(showCountry === true ? { showCountry: true } : {}), locales })) } : {}),
            url: Array.isArray(list.url) ? list.url.join(' + ') : list.url,
            enabled: list.enabled,
            rawLineCount,
            ruleCount: dnrOutput.length,
            domainCount,
            paramCount,
            blockCount: list.skipDNR ? 0 : blockCount,
            allowCount: list.skipDNR ? 0 : allowCount,
            redirectCount: list.skipDNR ? 0 : mainRules.filter(r => r.action.type === 'redirect').length,
            scriptletRuleCount: list.skipScriptlets ? 0 : scriptletRules.length,
            cosmeticHostnameCount: list.skipCosmetic ? 0 : cosmeticMap.size,
        });

        // Write the unsafe-rule companion, if the list declares one — ALWAYS, even empty ([]), so a list that
        // starts producing unsafe rules later needs no manifest change. Its own rule_resources entry, never
        // merged back into the main file (that is the whole point). Unsafe rules never carry cosmetic or
        // scriptlet content, so there is nothing else to register for it.
        for ( const { id: companionId, rules: companionRules } of (list.skipDNR ? [] : companions) ) {
            const cPath = path.join(rulesetDir, `${companionId}.json`);
            noteShippedRegexRules(companionId, companionRules);
            await fs.writeFile(cPath, JSON.stringify(companionRules, null, 2), 'utf8');
            ruleResources.push({ id: companionId, enabled: list.enabled, path: `rulesets/${companionId}.json` });
            rulesetDetails.push({
                id: companionId,
                name: companionId.endsWith('_removeparam') ? `${list.name} — removeparam companion` : `${list.name} — unsafe-rule companion`,
                category: 'hidden-overflow', locales: [],
                url: Array.isArray(list.url) ? list.url.join(' + ') : list.url,
                enabled: list.enabled,
                ruleCount: companionRules.length,
                blockCount: 0, allowCount: 0, redirectCount: companionRules.filter(r => r.action.type === 'redirect').length,
                scriptletRuleCount: 0, cosmeticHostnameCount: 0,
            });
            console.log(`  ${companionId}.json: ${companionRules.length} unsafe rule(s) (split out — unsafe for skip-review)`);
        }

        // Accumulate scriptlet rules
        if ( !list.skipScriptlets ) {
            for ( const r of scriptletRules ) {
                allScriptletRules.push({ ...r, ruleset: list.id });
                usedScriptletNames.add(r.name);
            }
        }

        // Accumulate scriptlet EXCEPTIONS (item 1) — deliberately NOT gated
        // by list.skipScriptlets: an exception targets scriptlets that may
        // have come from a DIFFERENT list than the one this exception line
        // itself lives in (badfilter-quick-fixes.txt cancelling something
        // AdGuard Base produced, for example), so this list's own
        // skipScriptlets flag has no bearing on whether ITS exception
        // lines should be collected.
        for ( const e of scriptletExceptions ) {
            allScriptletExceptions.push(e);
        }

        // Build per-ruleset cosmetic JS file — OLD embedded-blob format,
        // written ONLY to the test-fixture dir (see GUARD comments at the
        // top of build()) as ground truth for the differential test. NOT
        // shipped, NOT referenced in cosmetic-files.json's `file` field
        // anymore (removed 7.7.10 — nothing at runtime has read it since
        // 7.7.9's wiring; keeping it in the manifest would have been a
        // stale, misleading field, not a real fallback).
        if ( !list.skipCosmetic && cosmeticMap.size > 0 ) {
            const cosmeticCode = buildCosmeticFile(cosmeticMap);
            if ( cosmeticCode ) {
                const cosmeticFixturePath = path.join(legacyCosmeticFixtureDir, `${list.id}-cosmetic.js`);
                await fs.writeFile(cosmeticFixturePath, cosmeticCode, 'utf8');
                const sizeKB = Buffer.byteLength(cosmeticCode, 'utf8') / 1024;
                console.log(`  ${list.id}-cosmetic.js (test fixture only): ${sizeKB.toFixed(0)} KB, ${cosmeticMap.size} hostnames`);

                // Storage-backed path — live since 7.7.9, the ONLY path
                // since 7.7.10 (no more runtime rollback flag — see
                // js/core/scripting-manager.js).
                const specificData = stampCosmeticSpecificData(buildCosmeticSpecificData(cosmeticMap));
                if ( specificData ) {
                    const specificDataFile = `rulesets/${list.id}-cosmetic-specific.json`;
                    await fs.writeFile(path.join(rulesetDir, `${list.id}-cosmetic-specific.json`), JSON.stringify(specificData), 'utf8');
                    const loaderFile = `rulesets/${list.id}-cosmetic-loader.js`;
                    await fs.writeFile(path.join(rulesetDir, `${list.id}-cosmetic-loader.js`), buildCosmeticSpecificLoader(list.id), 'utf8');
                    allCosmeticFiles.push({
                        id: list.id,
                        specificDataFile,
                        loaderFile,
                        v: specificData[COSMETIC_SPECIFIC_CONFIG.VERSION_FIELD],
                    });
                }
            }
        }

        // ── Write country-overflow rulesets extracted from this list ──────
        // Same output shape as any other ruleset (DNR json, cosmetic file,
        // ruleResources/rulesetDetails entries) so nothing downstream (the
        // runtime, the dashboard's ruleset-details.json consumer) needs to
        // treat these specially — they're just rulesets with enabled:false
        // and no entry in the dashboard's display-name map, which is what
        // keeps them out of the visible filter list (see
        // dashboard/filter-manager-ui.js's hardcoded name map).
        for ( const overflow of overflowOutputs ) {
            if ( overflow.dnrRules.length === 0 && overflow.cosmeticMap.size === 0 ) {
                console.log(`  ${overflow.id}: nothing extracted, skipping`);
                continue;
            }

            // (10.2.1) The same safe/unsafe split as every list: AdGuard Base's buckets are AdGuard content, so
            // each has its own declared unsafe companion (js/data/ruleset-companions.js, owner's decision); a
            // bucket without one would have its unsafe rules dropped with a warning.
            const overflowSplit = splitUnsafeRules({ id: overflow.id }, overflow.dnrRules);
            overflow.dnrRules = overflowSplit.mainRules;
            const overflowPath = path.join(rulesetDir, `${overflow.id}.json`);
            noteShippedRegexRules(overflow.id, overflow.dnrRules);
            await fs.writeFile(overflowPath, JSON.stringify(overflow.dnrRules, null, 2), 'utf8');
            for ( const { id: cId, rules: cRules } of overflowSplit.companions ) {
                noteShippedRegexRules(cId, cRules);
                await fs.writeFile(path.join(rulesetDir, `${cId}.json`), JSON.stringify(cRules, null, 2), 'utf8');
                ruleResources.push({ id: cId, enabled: false, path: `rulesets/${cId}.json` });
                rulesetDetails.push({
                    id: cId, name: `${overflow.name} — unsafe-rule companion`,
                    // (10.4.5) no locales of its own — like every other unsafe companion it is switched on through its
                    // parent (RULESET_COMPANIONS), never by the browser-language auto-enable directly.
                    category: 'hidden-overflow', locales: [],
                    url: `${overflow.sourceUrl} (auto-extracted overflow)`,
                    enabled: false,
                    ruleCount: cRules.length,
                    blockCount: 0, allowCount: 0, redirectCount: cRules.filter(r => r.action.type === 'redirect').length,
                    scriptletRuleCount: 0, cosmeticHostnameCount: 0,
                    hidden: true,
                });
                console.log(`  ${cId}.json: ${cRules.length} unsafe rule(s) (split out — unsafe for skip-review)`);
            }

            const ob = overflow.dnrRules.filter(r => r.action.type === 'block').length;
            const oa = overflow.dnrRules.filter(r => r.action.type === 'allow').length;
            const ord = overflow.dnrRules.filter(r => r.action.type === 'redirect').length;

            ruleResources.push({ id: overflow.id, enabled: false, path: `rulesets/${overflow.id}.json` });
            rulesetDetails.push({
                id: overflow.id, name: overflow.name,
                category: 'hidden-overflow', locales: overflow.locales,
                url: `${overflow.sourceUrl} (auto-extracted overflow)`,
                enabled: false,
                ruleCount: overflow.dnrRules.length, blockCount: ob, allowCount: oa, redirectCount: ord,
                scriptletRuleCount: 0,
                cosmeticHostnameCount: overflow.cosmeticMap.size,
                // Not shown in the dashboard's filter list — see comment
                // above. Enabled at runtime via a companion-ruleset hook,
                // not by the user finding it in the UI.
                hidden: true,
            });
            console.log(`  ${overflow.id}: ${overflow.dnrRules.length} DNR rules, ${overflow.cosmeticMap.size} cosmetic hostnames (extracted from ${list.id})`);

            if ( overflow.cosmeticMap.size > 0 ) {
                const overflowCosmeticCode = buildCosmeticFile(overflow.cosmeticMap);
                if ( overflowCosmeticCode ) {
                    const overflowCosmeticFixturePath = path.join(legacyCosmeticFixtureDir, `${overflow.id}-cosmetic.js`);
                    await fs.writeFile(overflowCosmeticFixturePath, overflowCosmeticCode, 'utf8');
                    const sizeKB = Buffer.byteLength(overflowCosmeticCode, 'utf8') / 1024;
                    console.log(`  ${overflow.id}-cosmetic.js (test fixture only): ${sizeKB.toFixed(0)} KB, ${overflow.cosmeticMap.size} hostnames`);

                    const overflowSpecificData = stampCosmeticSpecificData(buildCosmeticSpecificData(overflow.cosmeticMap));
                    if ( overflowSpecificData ) {
                        const overflowSpecificDataFile = `rulesets/${overflow.id}-cosmetic-specific.json`;
                        await fs.writeFile(path.join(rulesetDir, `${overflow.id}-cosmetic-specific.json`), JSON.stringify(overflowSpecificData), 'utf8');
                        const overflowLoaderFile = `rulesets/${overflow.id}-cosmetic-loader.js`;
                        await fs.writeFile(path.join(rulesetDir, `${overflow.id}-cosmetic-loader.js`), buildCosmeticSpecificLoader(overflow.id), 'utf8');
                        allCosmeticFiles.push({
                            id: overflow.id,
                            specificDataFile: overflowSpecificDataFile,
                            loaderFile: overflowLoaderFile,
                            v: overflowSpecificData[COSMETIC_SPECIFIC_CONFIG.VERSION_FIELD],
                        });
                    }
                }
            }
        }
    }
    setTopSitesSet(null); // GUARD: release — nothing after this point needs it
    releasePrivacyBadgerNeededHosts(); // (11.0.0) GUARD: release — its consumer (the tracker-exception list) ran in the loop above
    return STEP_OK;
}

/******************************************************************************/
// Build step 3 of 9 — SCRIPTLET_ASSETS: write the combined scriptlet-rules file, the trimmed AdGuard corelibs, the custom-scriptlet dispatch and the safe-region exclude file.
// Reads from ctx : rulesetDir, allScriptletRules, usedScriptletNames, previousBuild, carriedOverIds
// Writes to ctx  : (adds carried-over lists' scriptlet names to usedScriptletNames)
// Body moved VERBATIM from the old single build() (phase 2, audit after
// 9.7.5) — proven byte-identical in output and console by a replayed build.
export async function stepScriptletAssets(ctx) {
    const { rulesetDir, allScriptletRules, usedScriptletNames, previousBuild, carriedOverIds } = ctx;
    // Write combined AG scriptlet rules (kept for backward compat / debugging)
    const scriptletRulesPath = path.join(rulesetDir, 'ag-scriptlets-rules.json');
    // (tools 3.0.13) A carried-over list keeps its previous scriptlet data file, so (1) its rows stay in this record
    // (read from the previous record before it is overwritten) and (2) the names its data file calls are added to the
    // used names BEFORE the corelibs are trimmed — without that, the trimmed corelibs lacked every function only a
    // carried-over list calls and stepWriteScriptletFiles() stopped ("no function source for …").
    const carriedRecordRows = carriedOverIds.size === 0 ? [] :
        (await readJsonOr(scriptletRulesPath, [])).filter(r => carriedOverIds.has(r?.ruleset));
    for ( const entry of previousBuild.scriptletFiles ) {
        if ( carriedOverIds.has(entry.id) === false ) { continue; }
        for ( const n of await readCarriedOverScriptletNames(entry) ) { usedScriptletNames.add(n); }
    }
    await fs.writeFile(scriptletRulesPath, JSON.stringify([ ...allScriptletRules, ...carriedRecordRows ], null, 2), 'utf8');
    console.log(`\nAG scriptlet rules: ${allScriptletRules.length} total, ${usedScriptletNames.size} unique scriptlets`);

    // Build trimmed corelibs (for shipped filter-list scriptlets) and the
    // full-library dispatch function (for custom-rule scriptlets — see
    // Custom-Rule-Scriptlets-Plan.md; these are deliberately two different
    // scriptlet sets, not the same one reused).
    const fullCorelibs = await buildTrimmedCorelibs(usedScriptletNames, ctx.cookieNoticeSets?.corelibs ?? null);
    await buildCustomScriptletsDispatch(fullCorelibs);
    // (10.2.0) buildExemptDomainsGeneratedFile() removed — the built-in exemptions ship as carrier rules in the
    // quick-fixes ruleset (see stepCompileLists()), not as js/generated/exempt-domains-generated.mjs.
    return STEP_OK;
}

/******************************************************************************/
// Build step 4 of 9 — SCRIPTLET_PRECOMPILE: load the trimmed corelibs and build the per-ruleset scriptlet file generator.
// Reads from ctx : (nothing)
// Writes to ctx  : buildScriptletFile
// Body moved VERBATIM from the old single build() (phase 2, audit after
// 9.7.5) — proven byte-identical in output and console by a replayed build.
export async function stepScriptletPrecompile(ctx) {
    // ── Pre-compile per-ruleset scriptlet JS files ────────────────────────────
    // Each file contains:
    //   1. All unique scriptlet function bodies used by that ruleset (defined once)
    //   2. A hostname dispatch table that calls them at document_start
    // Registered as static content scripts via scripting.registerContentScripts()
    // — no userScripts API needed, no "Allow User Scripts" requirement.
    //
    // Adult bypass domains always get annoyance scriptlets regardless of slider.
    // Read full corelibs to build fn bodies
    //
    // ── Resource guard: corelibs file must exist and parse before any
    // ruleset's scriptlet file can be built. Fail loudly and early rather
    // than letting every ruleset silently emit zero scriptlets further down.
    const corelibsPath = path.join(ROOT, 'js/resources/ag-scriptlets-corelibs.json');
    let corelibs;
    try {
        corelibs = JSON.parse(await fs.readFile(corelibsPath, 'utf8'));
    } catch (err) {
        throw new Error(`buildScriptletFile: cannot read/parse corelibs at ${corelibsPath} — ` +
                         `did buildTrimmedCorelibs() run first? (${err.message})`, { cause: err });
    }
    if ( !Array.isArray(corelibs.scriptlets) || corelibs.scriptlets.length === 0 ) {
        throw new Error(`buildScriptletFile: corelibs at ${corelibsPath} contain no scriptlets`);
    }
    // Every alias of a scriptlet resolves to ONE library name (its first listed name) and ONE function source,
    // so two lists that spell the same scriptlet differently still share one library entry.
    const fnMap = new Map();            // any alias -> library name
    const libraryBodies = new Map();    // library name -> function source
    for ( const entry of corelibs.scriptlets ) {
        const libraryName = entry.names[0];
        libraryBodies.set(libraryName, entry.scriptlet);
        for ( const name of entry.names ) { fnMap.set(name, libraryName); }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Scriptlet dispatch-table serialization config (debloat Phase 1).
    // Single place for every knob controlling the per-call-site JSON blob
    // ({name, uniqueId, ...}) written into ruleset_<id>-scriptlets.js's
    // dispatch table. See cosmetic-scriptlet-debloat-plan.md, Phase 1, for
    // the measured before/after numbers and the full investigation.
    //
    // Background: this object is passed as `source`/`e` into every corelib
    // scriptlet function (AdGuard's @adguard/scriptlets library, fetched by
    // buildTrimmedCorelibs() above). It used to be
    // {name, uniqueId, verbose:false} spelled out in full at EVERY call
    // site (11,697+ for AdGuard Base alone) — ~1.1MB of pure repetition.
    // (10.1.7) The former SCRIPTLET_SOURCE_CONFIG object is now this comment: its only read switch (COMPACT_UNIQUE_ID) is gone,
    // and its two remaining entries were never read as switches — they document how the precompiled scriptlet sources are
    // produced elsewhere (scriptlet precompile step). Kept as text so the reasoning is not lost; nothing to initialise or release.
    //
    // 'verbose' is OMITTED entirely, not set to false. Every corelib
    // scriptlet body only reads it inside `if (e.verbose) {...}` debug-
    // logging branches, and this fork ships no verbose-logging feature
    // — verbose is always falsy either way, so `undefined` (an omitted
    // key) and `false` are behaviorally identical. Saves ~294KB on the
    // AdGuard Base scriptlet file alone.
    // INCLUDE_VERBOSE: false,
    // The `name` field's KEY cannot be dropped or renamed — corelib
    // bodies read `source.name` / `e.name` directly and that string
    // must stay untouched (editing 63+ third-party minified function
    // bodies to match would be high-risk for near-zero extra gain).
    // But the VALUE does not need to be the full descriptive scriptlet
    // name (e.g. "prevent-eval-if", 10-30 chars) — verified by
    // scanning every corelib body in use for `.name` reads, `.name` is
    // only ever used for:
    //   (a) optional debug-log text inside `if(e.verbose)` — dead code
    //       here, verbose is always false;
    //   (b) the `uniqueIdentifier` de-dup key
    //       (uniqueId+name+"_"+args) — any distinct string works;
    //   (c) ONE VERIFIED EXCEPTION: `prevent-element-src-loading` uses
    //       `source.name` as an internal DOM attribute-name marker
    //       (`elem.setAttribute(source.name,"matched")`, later read
    //       back via `getAttribute(source.name)`). It's only ever
    //       compared against itself within the same closure, never
    //       against the "real" scriptlet name, so any short, non-empty,
    //       per-scriptlet-unique string satisfies this too.
    // Given (c), `name` must stay non-empty and unique per distinct
    // scriptlet — so we reuse the short per-ruleset function-var name
    // ("f0","f1",...) already computed below, instead of inventing a
    // second identifier. Saves ~400KB (vs. full names) with zero risk
    // to the one non-logging use case found.
    // USE_SHORT_NAME: true,
    // (The former COMPACT_UNIQUE_ID switch is gone: since 10.1.7 the
    // uniqueId a scriptlet receives is its ROW NUMBER in the file's
    // shared rule table — see scriptlet-dispatch-layout.mjs. Nothing
    // is stored per call site any more, so there is nothing to compact.)

    // Returns { code, fnNames } — the list's DATA file and the library names it calls (the shared library file
    // itself is written once, for all lists, by stepWriteScriptletFiles()).
    function buildScriptletFile(rulesetId, rules) {
    // Assign a numeric index to each unique fn used in this ruleset.
    // These maps/arrays are guarded by construction: freshly allocated
    // per call, so nothing leaks or carries over between rulesets.
        const fnVarMap = new Map();   // library name -> index into fnNames
        const fnNames = [];           // library names, in first-use order
        const byHostname = new Map();
    // BUG FIX: an ABP entity domain token ("kat.*") used to be stored
    // as a literal dispatch-table key same as any real hostname, but
    // the dispatch loop below only ever walks REAL parent-domain
    // strings ("www.kat.com" -> "kat.com") — it never tried an entity
    // form, so a "kat.*" key was unreachable at runtime, same class of
    // bug as buildCosmeticSpecificData()'s own hasEntities fix above
    // (found independently, in this structurally different dispatch
    // mechanism — see ARCHITECTURE.md's HARD CONSTRAINT on this).
    // Tracked here so the entity-aware branch of the dispatch loop is
    // only ever generated for a ruleset that actually has one — a
    // ruleset with zero entity keys pays zero extra runtime cost.
        let hasEntities = false;

        for ( let i = 0; i < rules.length; i++ ) {
            const { hostnames, name, args } = rules[i];
            if ( !hostnames?.length || !name ) { continue; }

            const libraryName = fnMap.get(name) ?? fnMap.get(`ubo-${name}.js`) ?? fnMap.get(`abp-${name}`);
            if ( !libraryName ) { continue; }

            if ( !fnVarMap.has(libraryName) ) {
                fnVarMap.set(libraryName, fnNames.length);
                fnNames.push(libraryName);
            }
            const fnIndex = fnVarMap.get(libraryName);

            // `i` is the rule's identity inside this ruleset (source order).
            // The layout module turns it into the row number the scriptlet
            // later receives as uniqueId, and uses it to keep two different
            // rules with identical function+arguments as two rows ("keep-
            // twice" — behaviour of the previous layout, kept on purpose).
            // `name` is not stored per row: fnIndex points into fnNames, and
            // the library name is what the scriptlet receives as `.name`.
            const triple = [ fnIndex, i, args ?? [] ];

            for ( const hn of hostnames ) {
                if ( !byHostname.has(hn) ) { byHostname.set(hn, []); }
                byHostname.get(hn).push(triple);
                hasEntities ||= hn.endsWith('.*');
            }
        }

        if ( byHostname.size === 0 ) { return null; }

        // Data layout + generated lookup code live in ONE module (shared
        // rule rows, pooled arguments, sorted hostname list, binary-search
        // lookup — see scriptlet-dispatch-layout.mjs for the contract and
        // the measured gain). That module also refuses a dispatch key that
        // can never match a hostname (the parser is supposed to have
        // dropped such lines — if one still arrives, the build stops).
        // hasEntities: the entity step of the lookup is emitted only for a
        // ruleset that has an entity key, so other rulesets pay nothing.
        const code = renderScriptletFile(fnNames, encodeDispatchTables(byHostname), hasEntities, rulesetId);
        // Round-trip guard: what was written must decode back to exactly
        // the table that went in. A layout bug stops the build here and
        // never reaches a shipped file.
        verifyRoundTrip(byHostname, code);
        return { code, fnNames };
    }
    Object.assign(ctx, { buildScriptletFile, scriptletLibraryBodies: libraryBodies });
    return STEP_OK;
}

/******************************************************************************/
// Build step 5 of 9 — EXCEPTIONS: apply scriptlet exception rules across all lists.
// Reads from ctx : allScriptletRules, allScriptletExceptions
// Writes to ctx  : (nothing)
// Body moved VERBATIM from the old single build() (phase 2, audit after
// 9.7.5) — proven byte-identical in output and console by a replayed build.
export async function stepScriptletExceptions(ctx) {
    const { allScriptletRules, allScriptletExceptions } = ctx;
    // Apply scriptlet EXCEPTIONS (item 1) — must run AFTER every list has
    // been parsed and accumulated into allScriptletRules (an exception can
    // target a directive from any list, not just the one it lives in) and
    // BEFORE grouping/output below, since grouping reads allScriptletRules
    // as final. Extracted into its own function (not left inline) so it
    // can be exercised directly by a test driver without needing the rest
    // of build()'s plumbing.
    {
        const { filteredRules, wildcardReport, unmatchedNamed, droppedRuleCount, namedCount, wildcardCount } =
            applyScriptletExceptions(allScriptletRules, allScriptletExceptions);
        allScriptletRules.length = 0;
        allScriptletRules.push(...filteredRules);

        if ( allScriptletExceptions.length > 0 ) {
            console.log(`\nScriptlet exceptions: ${allScriptletExceptions.length} declared (${namedCount} named, ${wildcardCount} wildcard hostname(s)), ${droppedRuleCount} directive(s) cancelled.`);
            if ( unmatchedNamed.length > 0 ) {
                console.log(`  WARNING: ${unmatchedNamed.length} named exception(s) matched nothing (stale, or hostname/name/args no longer match what the source list compiles) — check these:`);
                for ( const line of unmatchedNamed ) { console.log(`    ${line}`); }
            }
        }

        // Wildcard report — package-release.mjs reads this file and halts
        // before creating a zip if it's non-empty, requiring explicit
        // confirmation (per explicit instruction: warn at packaging time,
        // not buried in build console output — "when it annoys me it is a
        // good trigger to solve"). Written every run, even when empty, so
        // a stale report from a previous run can never linger and falsely
        // halt a later, now-wildcard-free release.
        const wildcardReportPath = path.resolve(__dirname, 'scriptlet-wildcard-report.json');
        await fs.writeFile(wildcardReportPath, JSON.stringify(wildcardReport, null, 2) + '\n', 'utf8');
    }
    return STEP_OK;
}

// Names a carried-over data file calls. A file from before the shared library carries its own functions and
// cannot run in the combined registration's library scheme: stop with the reason instead of shipping a mix.
async function readCarriedOverScriptletNames(entry) {
    const text = await fs.readFile(path.join(ROOT, entry.file), 'utf8');
    try {
        return decodeDispatchSource(text).fnNames;
    } catch (err) {
        throw new Error(`${entry.id}: its download failed and its previous scriptlet file (${entry.file}) is not in the ` +
            `shared-library layout, so it cannot be carried over — re-run the build when the list is reachable (${err.message})`,
            { cause: err });
    }
}

/******************************************************************************/
// Build step 6 of 9 — WRITE_SCRIPTLETS: write per-ruleset scriptlet files and scriptlet-files.json.
// Reads from ctx : rulesetDir, ruleResources, allScriptletRules, previousBuild, carriedOverIds, buildScriptletFile,
//                  scriptletLibraryBodies
// Writes to ctx  : (nothing)
// Also writes the SHARED scriptlet library + its end file (js/data/scriptlet-library.js): every function any
// written or carried-over data file calls, once.
// Body moved VERBATIM from the old single build() (phase 2, audit after
// 9.7.5) — proven byte-identical in output and console by a replayed build.
export async function stepWriteScriptletFiles(ctx) {
    const { rulesetDir, ruleResources, allScriptletRules, previousBuild, carriedOverIds, buildScriptletFile, scriptletLibraryBodies } = ctx;
    // Group allScriptletRules by ruleset
    const rulesByRuleset = new Map();
    for ( const rule of allScriptletRules ) {
        const rs = rule.ruleset ?? 'unknown';
        if ( !rulesByRuleset.has(rs) ) { rulesByRuleset.set(rs, []); }
        rulesByRuleset.get(rs).push(rule);
    }

    const scriptletFiles = [];
    const libraryNames = new Set();   // every library name a shipped data file calls
    for ( const [rulesetId, rules] of rulesByRuleset ) {
        const built = buildScriptletFile(rulesetId, rules);
        if ( !built ) { continue; }
        const { code, fnNames } = built;
        for ( const n of fnNames ) { libraryNames.add(n); }
        const outPath = path.join(rulesetDir, `${rulesetId}-scriptlets.js`);
        await fs.writeFile(outPath, code, 'utf8');
        const sizeKB = Buffer.byteLength(code, 'utf8') / 1024;
        console.log(`  ${rulesetId}-scriptlets.js: ${sizeKB.toFixed(0)} KB`);
        scriptletFiles.push({ id: rulesetId, file: `rulesets/${rulesetId}-scriptlets.js` });
    }

    // Carried-over lists: their scriptlet file was not rewritten (no rules
    // accumulated for them this run) — keep their previous registry entry.
    // Its data file calls the shared library by name, so those names must be in this build's library too.
    for ( const entry of previousBuild.scriptletFiles ) {
        if ( carriedOverIds.has(entry.id) && !scriptletFiles.some(f => f.id === entry.id) ) {
            for ( const n of await readCarriedOverScriptletNames(entry) ) { libraryNames.add(n); }
            scriptletFiles.push(entry);
        }
    }

    // The shared library: sorted by name, so the file is deterministic. A name with no known function source
    // (a carried-over file calling a scriptlet that left the corelibs) stops the build — never ship a call
    // that would silently do nothing.
    const libraryEntries = [ ...libraryNames ].sort().map(name => {
        const body = scriptletLibraryBodies.get(name);
        if ( body === undefined ) { throw new Error(`scriptlet library: no function source for "${name}"`); }
        return [ name, body ];
    });
    const libraryCode = renderLibraryFile(libraryEntries);
    await fs.writeFile(path.join(ROOT, SCRIPTLET_LIBRARY_FILE), libraryCode, 'utf8');
    await fs.writeFile(path.join(ROOT, SCRIPTLET_LIBRARY_END_FILE), renderLibraryEndFile(), 'utf8');
    console.log(`  ${path.basename(SCRIPTLET_LIBRARY_FILE)}: ${(Buffer.byteLength(libraryCode, 'utf8') / 1024).toFixed(0)} KB (${libraryEntries.length} shared scriptlet functions)`);

    // (10.5.6) Site / entity split (js/data/scriptlet-library.js): from each list's WRITTEN data file (carried-over
    // lists included, so every list is split the same way), its site keys, its "name.*"-only file and the entity
    // library. The entity library publishes only what the entity files call — a subset of the full library.
    const sitesById = {};
    const entityLibraryNames = new Set();
    for ( const entry of scriptletFiles ) {
        const split = splitSitesAndEntities(await fs.readFile(path.join(ROOT, entry.file), 'utf8'));
        sitesById[entry.id] = split.sites;
        delete entry.entityFile;
        if ( split.entityCode !== null ) {
            entry.entityFile = `rulesets/${entry.id}${SCRIPTLET_ENTITY_DATA_SUFFIX}`;
            await fs.writeFile(path.join(ROOT, entry.entityFile), split.entityCode, 'utf8');
            for ( const n of split.entityNames ) { entityLibraryNames.add(n); }
        }
    }
    const entityLibraryEntries = libraryEntries.filter(([ name ]) => entityLibraryNames.has(name));
    if ( entityLibraryEntries.length !== entityLibraryNames.size ) { throw new Error('scriptlet entity library: a called name is missing from the library'); }
    const entityLibraryCode = renderLibraryFile(entityLibraryEntries);
    await fs.writeFile(path.join(ROOT, SCRIPTLET_LIBRARY_ENTITY_FILE), entityLibraryCode, 'utf8');
    await fs.writeFile(path.join(ROOT, SCRIPTLET_SITES_FILE), JSON.stringify(sitesById), 'utf8');
    const siteCount = Object.values(sitesById).reduce((n, list) => n + list.length, 0);
    console.log(`  ${path.basename(SCRIPTLET_LIBRARY_ENTITY_FILE)}: ${(Buffer.byteLength(entityLibraryCode, 'utf8') / 1024).toFixed(0)} KB ` +
        `(${entityLibraryEntries.length} functions for "name.*" rules); ${path.basename(SCRIPTLET_SITES_FILE)}: ${siteCount} sites`);
    // Deterministic order = the manifest's ruleset order (FILTER_LISTS
    // order), so a run with a carried-over list writes the SAME registry
    // as a normal run instead of appending the kept entry at the end.
    // Stable sort: ids not in ruleResources keep their relative order last.
    const rulesetOrder = new Map(ruleResources.map((r, i) => [ r.id, i ]));
    scriptletFiles.sort((a, b) => (rulesetOrder.get(a.id) ?? Infinity) - (rulesetOrder.get(b.id) ?? Infinity));

    // Write scriptlet-files.json so the runtime knows which files exist
    await fs.writeFile(
        path.join(rulesetDir, 'scriptlet-files.json'),
        JSON.stringify(scriptletFiles, null, 2), 'utf8'
    );
    console.log(`\nWrote ${scriptletFiles.length} scriptlet JS files`);
    return STEP_OK;
}

/******************************************************************************/
// (11.0.0) Build step COOKIE_NOTICES (after INIT, before LISTS — LISTS releases the CrUX set this step gates with): Seamless surfing's cookie-notice sets — AdGuard Cookie Notices, then
// EasyList Cookie uBO, then EasyList Cookie specific hide/block (tools/build/cookie-notice-sources.mjs). Runs before
// SCRIPTLET_ASSETS so the library names its two scriptlet files call are in the trimmed corelibs, and hands its full
// corelibs download on to that step (one download per run).
// Reads from ctx : usedScriptletNames
// Writes to ctx  : cookieNoticeSets (and adds its names to usedScriptletNames)
export async function stepCookieNotices(ctx) {
    const sets = await buildCookieNoticeSets({ topSites: topSitesSet });
    for ( const name of sets.usedNames ) { ctx.usedScriptletNames.add(name); }
    ctx.cookieNoticeSets = sets;
    function rows(mode) { return [ ...sets.scriptlets[mode].values() ].reduce((n, l) => n + l.length, 0); }
    console.log(`
[cookie notices] decline: ${sets.scriptlets.decline.size} sites / ${rows('decline')} scriptlets; ` +
        `accept: ${sets.scriptlets.accept.size} sites / ${rows('accept')} scriptlets; ` +
        `accept-else-decline: ${sets.scriptlets['prefer-accept'].size} sites / ${rows('prefer-accept')} scriptlets; ` +
        `hide: ${sets.hides.decline.size} sites (also used by accept-else-decline); ` +
        `block: ${sets.blocks.decline.length} rules (accept-else-decline ${sets.blocks['prefer-accept'].length}) — dropped: ${JSON.stringify(sets.report)}`);
    return STEP_OK;
}

/******************************************************************************/
// (11.0.0) Build step COOKIE_NOTICE_WRITE (after WRITE_SCRIPTLETS): writes the cookie-notice files
// (tools/build/cookie-notice-write.mjs) from the sets and the function sources of this run's trimmed corelibs.
// Reads from ctx : cookieNoticeSets, scriptletLibraryBodies
// Writes to ctx  : cookieNoticeFiles
export async function stepWriteCookieNotices(ctx) {
    const written = await writeCookieNoticeFiles(ctx.cookieNoticeSets, ctx.scriptletLibraryBodies);
    ctx.cookieNoticeFiles = written;
    const kb = written.sizes.map(([ rel, bytes ]) => `${path.basename(rel)} ${(bytes / 1024).toFixed(0)} KB`);
    function isShard(rel) { return /-hide-.*-\d+\.js$/.test(rel); }
    const shardSizes = written.sizes.filter(([ rel ]) => isShard(rel)).map(([ , b ]) => b);
    console.log(`  cookie notices: ${kb.filter(k => !/-hide-/.test(k)).join(', ')}; ${shardSizes.length} hide shards, ` +
        `largest ${(Math.max(...shardSizes) / 1024).toFixed(0)} KB`);
    return STEP_OK;
}

/******************************************************************************/
// (11.0.0) Build step AD_CLEANER (after COOKIE_NOTICE_WRITE): the Ad leftover cleaner's data file — EasyList general
// element hiding minus EasyList's per-site exceptions, indexed by leading id/class (tools/build/ad-cleaner-sources.mjs).
// Reads from ctx : (nothing)
// Writes to ctx  : adCleanerFile ([ rel, bytes ]), adCleanerCounts
export async function stepAdCleaner(ctx) {
    const data = await buildAdCleanerData();
    ctx.adCleanerFile = await writeAdCleanerData(data);
    ctx.adCleanerCounts = data.counts;
    const c = data.counts;
    console.log(`  ad leftover cleaner: ${c.kept} rules (${c.keyed} by id/class, ${c.unkeyed} direct), ` +
        `${c.exceptions} exceptions on ${c.exceptionSites} sites, ${c.exemptSites} sites exempt, ` +
        `${(ctx.adCleanerFile[1] / 1024).toFixed(0)} KB — ` +
        `dropped: site ${c.withSite}, extended ${c.extended}, refused ${c.refused}, duplicate ${c.duplicate}`);
    return STEP_OK;
}

/******************************************************************************/
// Build step 7 of 9 — REGISTRY_MANIFEST: write cosmetic-files.json, manifest.json rule_resources and ruleset-details.json.
// Reads from ctx : rulesetDir, manifestPath, manifest, ruleResources, rulesetDetails, allCosmeticFiles
// Writes to ctx  : (nothing)
// Body moved VERBATIM from the old single build() (phase 2, audit after
// 9.7.5) — proven byte-identical in output and console by a replayed build.
export async function stepWriteRegistries(ctx) {
    const { rulesetDir, manifestPath, manifest, ruleResources, rulesetDetails, allCosmeticFiles } = ctx;
    // Write cosmetic-files.json so the runtime knows which cosmetic files
    // exist. As of 7.7.10, every entry is storage-backed only
    // (`specificDataFile`/`loaderFile`/`v`) — the old embedded-blob `file`
    // field was removed once the runtime rollback flag was removed from
    // js/core/scripting-manager.js (nothing has read it since 7.7.9's
    // wiring anyway). The old format itself still exists, generated fresh
    // on every build, but only as a test fixture — see test-fixtures/
    // legacy-cosmetic/ and this file's own GUARD comments at the top of
    // build().
    await fs.writeFile(
        path.join(rulesetDir, 'cosmetic-files.json'),
        JSON.stringify(allCosmeticFiles, null, 2), 'utf8'
    );
    console.log(`Wrote ${allCosmeticFiles.length} cosmetic JS files`);

    // Update manifest.json
    manifest.declarative_net_request = manifest.declarative_net_request || {};
    manifest.declarative_net_request.rule_resources = ruleResources;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log('\nUpdated manifest.json rule_resources');

    // Guard (10.0.5): the dashboard catalog, the Matrix panel's rule-
    // summary line, and the locale auto-enable logic all now read their
    // display name / category / locale triggers directly from THIS file
    // — none of them keep a fallback hand-maintained list any more (see
    // js/data/ruleset-details-loader.js's header). That means a
    // malformed entry here is no longer a cosmetic nitpick caught by
    // eyeballing a diff — it ships as a blank dropdown option, a blank
    // Matrix "more info" line, or a ruleset nobody can ever auto-enable
    // by locale. Fail the build loudly instead, the same posture C13a
    // requires of any build-time data consumed without validation.
    // ('security', 10.2.0, removed in 10.3.0 with its only ruleset, ruleset_suspicious_hosting.)
    const VALID_CATEGORIES = new Set([ 'default', 'language-filter', 'hidden-overflow' ]);
    const detailProblems = [];
    const seenIds = new Set();
    for ( const entry of rulesetDetails ) {
        if ( typeof entry.id !== 'string' || entry.id === '' ) {
            detailProblems.push(`entry with missing/empty id: ${JSON.stringify(entry)}`);
            continue;
        }
        if ( seenIds.has(entry.id) ) { detailProblems.push(`duplicate id: ${entry.id}`); }
        seenIds.add(entry.id);
        if ( typeof entry.name !== 'string' || entry.name.trim() === '' ) {
            detailProblems.push(`${entry.id}: missing/empty name`);
        }
        if ( !VALID_CATEGORIES.has(entry.category) ) {
            detailProblems.push(`${entry.id}: invalid category ${JSON.stringify(entry.category)} (must be one of ${[ ...VALID_CATEGORIES ].join(', ')})`);
        }
        if ( !Array.isArray(entry.locales) ) {
            detailProblems.push(`${entry.id}: locales is not an array (${JSON.stringify(entry.locales)})`);
        }
    }
    if ( detailProblems.length > 0 ) {
        throw new Error(
            `ruleset-details.json: ${detailProblems.length} malformed entr${detailProblems.length === 1 ? 'y' : 'ies'} — ` +
            `every consumer (dashboard catalog, Matrix panel, locale auto-enable) reads this file directly with no ` +
            `fallback, so this must be fixed in tools/build/filter-lists.mjs before packaging:\n  ` +
            detailProblems.join('\n  ')
        );
    }

    // Write ruleset-details.json
    await fs.writeFile(
        path.join(rulesetDir, 'ruleset-details.json'),
        JSON.stringify(rulesetDetails, null, 2) + '\n',
        'utf8'
    );
    console.log('Updated rulesets/ruleset-details.json');
    return STEP_OK;
}

/******************************************************************************/
// Build step 8 of 9 — ORPHAN_CLEANUP: remove generated files no longer produced by any list.
// Reads from ctx : rulesetDir, ruleResources, allCosmeticFiles
// Writes to ctx  : (nothing)
// Body moved VERBATIM from the old single build() (phase 2, audit after
// 9.7.5) — proven byte-identical in output and console by a replayed build.
export async function stepCleanOrphans(ctx) {
    const { rulesetDir, ruleResources, allCosmeticFiles } = ctx;
    // (11.0.0) Cookie-notice files: this run's writer is the authority (COOKIE_NOTICE_WRITE). Any other file with the
    // prefix — a shard or mode file an earlier build wrote under another name — is a leftover and is removed.
    const COOKIE_NOTICE_FILE_PREFIX = 'cookie-notice-';
    const writtenCookieNoticeFiles = new Set((ctx.cookieNoticeFiles?.sizes ?? []).map(([ rel ]) => path.basename(rel)));
    // ── GUARD: clear/release — orphaned generated files in rulesets/.
    // Every generated file this build script writes follows one of a
    // small number of known naming patterns
    // (`<id>.json` — companions such as `<id>_removeparam.json`/`<id>_unsafe.json` included —, `<id>-cosmetic-specific.json`,
    // `<id>-cosmetic-loader.js`, `<id>-scriptlets.js` (10.4.6), plus the fixed-name manifests). A
    // file matching one of these patterns but whose `<id>` prefix isn't
    // in this run's actual output (a list removed from FILTER_LISTS, a
    // companion removed from UNSAFE_RULE_COMPANIONS, a
    // ruleset renamed) is a stale leftover from a PRIOR build — e.g.
    // `ruleset_kees1958_tracking.json` after that list was
    // retired (see the FILTER_LISTS comment on
    // ruleset_adguard_base). Without this guard such files sit in
    // rulesets/ forever: not referenced by manifest.json (so functionally
    // inert) but still shipped in every zip, confusing to find later, and
    // easy to mistake for something still in use. Scoped tightly to
    // known-generated filename patterns — never touches anything else
    // that might live in rulesets/.
    //
    // Suffixes ordered LONGEST-FIRST deliberately: a cosmetic-specific/
    // loader file's id (from allCosmeticFiles) is the bare ruleset id
    // with NO suffix at all — `-cosmetic-specific.json`/`-cosmetic-
    // loader.js` must be stripped in full, or the wrong id gets
    // recovered. A removeparam companion is the OPPOSITE case: its own
    // id (from ruleResources) already has `_removeparam` baked in as
    // PART of the id itself — only the bare `.json` extension should be
    // stripped for those, same as any other plain ruleset file.
    const expectedIds = new Set([
        ...ruleResources.map(r => r.id),
        ...allCosmeticFiles.map(f => f.id),
    ]);
    const knownGeneratedSuffixes = [
        '-cosmetic-specific.json', '-cosmetic-loader.js', '.json',
    ];
    const fixedNames = new Set([
        'cosmetic-files.json', 'ruleset-details.json',
        'ag-scriptlets-rules.json', 'scriptlet-files.json',
        path.basename(SCRIPTLET_SITES_FILE),   // (10.5.6) generated by step 6, not a ruleset id
        // (11.0.0) cookie-notice step: its sites file and the mode block-rule files
        path.basename(COOKIE_NOTICE_SITES_FILE),
        path.basename(AD_CLEANER_DATA_FILE),   // (11.0.0) AD_CLEANER step
        ...Object.values(COOKIE_NOTICE_MODE_FILES).map(f => f.blocks).filter(Boolean).map(f => path.basename(f)),
    ]);
    // (10.4.6) Per-list scriptlet data files (`<id>-scriptlets.js`) were not covered: a list that stopped producing
    // scriptlets, or was removed, kept its stale file in every later zip (found: ruleset_adguard_balkan-scriptlets.js
    // shipped unreferenced in 10.4.5). The authority is scriptlet-files.json, written by step 6 of THIS run (carried-
    // over lists included); the shared library files have other names and are never matched.
    const SCRIPTLET_DATA_SUFFIX = '-scriptlets.js';
    const writtenScriptletFiles = new Set((await readJsonOr(path.join(rulesetDir, 'scriptlet-files.json'), []))
        .flatMap(e => [ e.file, e.entityFile ]).filter(Boolean).map(f => path.basename(String(f))));
    let orphansRemoved = 0;
    for ( const f of await fs.readdir(rulesetDir).catch(() => []) ) {
        if ( f.startsWith(COOKIE_NOTICE_FILE_PREFIX) ) {
            if ( writtenCookieNoticeFiles.size === 0 || writtenCookieNoticeFiles.has(f) ) { continue; }   // GUARD: no list = keep all
            await fs.unlink(path.join(rulesetDir, f)).catch(() => {});
            orphansRemoved++;
            console.log(`  removed orphaned file: rulesets/${f}`);
            continue;
        }
        if ( fixedNames.has(f) ) { continue; }
        if ( f.endsWith(SCRIPTLET_DATA_SUFFIX) || f.endsWith(SCRIPTLET_ENTITY_DATA_SUFFIX) ) {   // (10.5.6) entity files too
            if ( writtenScriptletFiles.has(f) ) { continue; }
            await fs.unlink(path.join(rulesetDir, f)).catch(() => {});
            orphansRemoved++;
            console.log(`  removed orphaned file: rulesets/${f}`);
            continue;
        }
        const suffix = knownGeneratedSuffixes.find(s => f.endsWith(s));
        if ( suffix === undefined ) { continue; } // not a file this script generates — leave it alone
        const id = f.slice(0, -suffix.length);
        if ( expectedIds.has(id) ) { continue; }
        await fs.unlink(path.join(rulesetDir, f)).catch(() => {});
        orphansRemoved++;
        console.log(`  removed orphaned file: rulesets/${f}`);
    }
    if ( orphansRemoved > 0 ) {
        console.log(`Cleaned up ${orphansRemoved} orphaned file(s) from a prior build.`);
    }
    return STEP_OK;
}

/******************************************************************************/
// Build step 9 of 9 — REPORTS: write the dropped/expanded diagnostic reports.
// Reads from ctx : (nothing)
// Writes to ctx  : (nothing)
// Body moved VERBATIM from the old single build() (phase 2, audit after
// 9.7.5) — proven byte-identical in output and console by a replayed build.
export async function stepWriteReports(ctx) {
    // ── dropped-badfilters.txt — per explicit request: every $badfilter
    // line dropped from a regular filter list this run (never auto-
    // applied — see parseBlockRule()'s own comment on why), so it can be
    // reviewed and, if warranted, hand-added to the badfilter-quick-fixes
    // list instead. Written OUTSIDE rulesets/ (not shipped, not a
    // manifest-referenced asset — same reasoning as the cosmetic-format
    // test fixture directory above) so it never needs cross-reference-
    // checking against the manifest and can't accidentally ship. Always
    // (re)written, even when empty, so an empty file is visible
    // confirmation the check ran, not silence that could mean "forgot to
    // run" just as easily as "nothing to report".
    {
        const reportPath = path.join(ROOT, 'dropped-badfilters.txt');
        const lines = [
            `Dropped $badfilter lines — ${new Date().toISOString().slice(0, 10)}`,
            `${droppedBadfilters.length} total. Each was found in a regular filter list (NOT the`,
            `badfilter-quick-fixes list, which converts these to allow rules instead of`,
            `dropping them) and intentionally NOT auto-applied — review and, if you agree`,
            `with the upstream list's intent, add the equivalent line yourself to your own`,
            `badfilter-quick-fixes source.`,
            '',
            ...droppedBadfilters.map(({ list, line }) => `[${list}] ${line}`),
        ];
        await fs.writeFile(reportPath, lines.join('\n') + '\n', 'utf8');
        console.log(`\nWrote dropped-badfilters.txt (${droppedBadfilters.length} entries).`);
    }

    // ── dropped-generic-domain-qualifiers.txt — same reporting discipline
    // as dropped-badfilters.txt above, for `[$domain=...]` generic rules
    // that have no static dispatch path (see parseCosmeticRules()'s own
    // comment on this architectural limit). "wouldKeep" reflects the TLD
    // check alone — it's what a future regex-aware dispatch mechanism
    // could recover, not a claim these are currently shipping anywhere.
    {
        const reportPath = path.join(ROOT, 'dropped-generic-domain-qualifiers.txt');
        const lines = [
            `Dropped [$domain=...] generic cosmetic/scriptlet lines — ${new Date().toISOString().slice(0, 10)}`,
            `${droppedGenericDomainQualifiers.length} total. Every one dropped regardless of TLD — this`,
            `codebase's cosmetic/scriptlet dispatch is a static hostname lookup table with`,
            `no path for a regex-scoped rule to attach to. "wouldKeep" reflects the TLD`,
            `check alone (would this survive the country-code blacklist if a dispatch`,
            `mechanism existed) — informational only.`,
            '',
            ...droppedGenericDomainQualifiers.map(({ line, wouldKeep, reason }) => `[wouldKeep=${wouldKeep}] [${reason}] ${line}`),
        ];
        await fs.writeFile(reportPath, lines.join('\n') + '\n', 'utf8');
        console.log(`Wrote dropped-generic-domain-qualifiers.txt (${droppedGenericDomainQualifiers.length} entries).`);
    }

    // ── dropped-unsupported-scriptlet-scopes.txt — same reporting
    // discipline, for scriptlet rule lines whose scope cannot be a
    // dispatch key (see parseScriptletRules()): bracket-prefixed
    // `[$path=...]host` / `[$url=...]` scopes (never fired) and `~host`
    // negations (the exclusion was never honoured — the rule still applies
    // to its other hostnames). Dropping them changes nothing at runtime;
    // the report exists so a list author's intent is not lost silently.
    {
        const reportPath = path.join(ROOT, 'dropped-unsupported-scriptlet-scopes.txt');
        function byKind(kind) { return droppedUnsupportedScriptletScopes.filter(d => d.kind === kind); }
        const lines = [
            `Dropped scriptlet rule scopes that cannot be a hostname key — ${new Date().toISOString().slice(0, 10)}`,
            `${droppedUnsupportedScriptletScopes.length} total: ${byKind('bracket-modifier').length} bracket-modifier lines (dropped whole), ` +
            `${byKind('negated-hostname').length} negated hostnames (only the ~host entry dropped; the rule still applies to its other hostnames), ` +
            `${byKind('untranslatable-ubo-args').length} uBO rules whose extra arguments cannot be translated (dropped whole, 11.1.4).`,
            '',
            ...droppedUnsupportedScriptletScopes.map(({ kind, line }) => `[${kind}] ${line}`),
        ];
        await fs.writeFile(reportPath, lines.join('\n') + '\n', 'utf8');
        console.log(`Wrote dropped-unsupported-scriptlet-scopes.txt (${droppedUnsupportedScriptletScopes.length} entries).`);
    }

    // ── dropped-policy-scriptlets.txt (10.4.6) — every scriptlet rule the scriptlet policy refused
    // (js/data/scriptlet-policy.js): trusted scriptlets from a non-AdGuard source (rule A, at download), code as
    // argument (rule B) and inserted external URLs (rule C); (11.1.3) rule-A lines that got a safe replacement are listed
    // too, under their own reason. Always written, and summarised as an end-of-build
    // NOTICE per reason, so the owner sees what the policy removed from each refresh.
    {
        const reportPath = path.join(ROOT, 'dropped-policy-scriptlets.txt');
        const byReason = new Map();
        for ( const d of droppedPolicyScriptlets ) { byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1); }
        const lines = [
            `Scriptlet rules refused (or, rule A, replaced by a safe project scriptlet) by the scriptlet policy (js/data/scriptlet-policy.js) — ${new Date().toISOString().slice(0, 10)}`,
            `${droppedPolicyScriptlets.length} total: ${[ ...byReason ].map(([ r, n ]) => `${n} ${r}`).join('; ') || 'none'}.`,
            '',
            ...droppedPolicyScriptlets.map(d => d.line !== undefined
                ? `[${d.reason}] ${d.source}\n    ${d.line}`
                : `[${d.reason}] ${d.source} ${(d.hostnames ?? []).join(',')} ${d.name} ${JSON.stringify(d.args).slice(0, 300)}`),
        ];
        await fs.writeFile(reportPath, lines.join('\n') + '\n', 'utf8');
        console.log(`Wrote dropped-policy-scriptlets.txt (${droppedPolicyScriptlets.length} entries).`);
        for ( const reason of [ SCRIPTLET_POLICY.REASON_UNTRUSTED_SOURCE, SCRIPTLET_POLICY.REASON_CODE_ARGUMENT, SCRIPTLET_POLICY.REASON_EXTERNAL_RESOURCE ] ) {
            const n = byReason.get(reason) ?? 0;
            if ( n !== 0 ) { buildNotices.push({ level: 'NOTICE', text: `Scriptlet policy: ${n} rule(s) dropped — ${reason} (see dropped-policy-scriptlets.txt).` }); }
        }
        const replaced = byReason.get(SCRIPTLET_POLICY.REASON_REPLACED) ?? 0;
        if ( replaced !== 0 ) { buildNotices.push({ level: 'NOTICE', text: `Scriptlet policy: ${replaced} rule(s) kept as a safe replacement — ${SCRIPTLET_POLICY.REASON_REPLACED} (see dropped-policy-scriptlets.txt).` }); }
    }

    // ── dropped-platform-rules.txt (11.1.4) — rules a list itself marks as meant for another blocker ("!+ PLATFORM(…)"
    // hints, "!#if" blocks), left out at download by applyListDirectives() (tools/build/list-directives.mjs). A source
    // fetched by several lists is listed once. Always written, so an empty file shows the step ran.
    {
        const reportPath = path.join(ROOT, 'dropped-platform-rules.txt');
        const unique = new Map();
        for ( const d of droppedPlatformLines ) { unique.set(`${d.source}\n${d.line}`, d); }
        const byReason = new Map();
        for ( const d of unique.values() ) { byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1); }
        const lines = [
            `Rules left out because their list marks them for another platform (tools/build/list-directives.mjs) — ${new Date().toISOString().slice(0, 10)}`,
            `${unique.size} total: ${[ ...byReason ].map(([ r, n ]) => `${n} ${r}`).join('; ') || 'none'}.`,
            '',
            ...[ ...unique.values() ].map(d => `[${d.reason}] ${d.source}\n    ${d.line}`),
        ];
        await fs.writeFile(reportPath, lines.join('\n') + '\n', 'utf8');
        console.log(`Wrote dropped-platform-rules.txt (${unique.size} entries).`);
        if ( unique.size !== 0 ) { buildNotices.push({ level: 'NOTICE', text: `Platform directives: ${unique.size} rule(s) left out — marked for another blocker (see dropped-platform-rules.txt).` }); }
    }

    // ── dropped-unsupported-list-lines.txt (10.1.8) — lines of a hand-written
    // list (the Quick-fixes list) that the build cannot use: raw-JavaScript
    // rules, CSS injection, procedural filters, network rules that do not
    // compile. Dropped in parseList(), reported here, and surfaced as an
    // end-of-build WARNING so a line the owner wrote never vanishes silently.
    {
        const reportPath = path.join(ROOT, UNSUPPORTED_LINES_CONFIG.REPORT_FILE);
        const lines = [
            `Dropped list lines the build cannot use — ${new Date().toISOString().slice(0, 10)}`,
            `${droppedUnsupportedListLines.length} line(s).`,
            '',
            ...droppedUnsupportedListLines.map(({ list, line, reason }) => `[${list}] ${reason}\n    ${line}`),
        ];
        await fs.writeFile(reportPath, lines.join('\n') + '\n', 'utf8');
        console.log(`Wrote ${UNSUPPORTED_LINES_CONFIG.REPORT_FILE} (${droppedUnsupportedListLines.length} entries).`);
        if ( droppedUnsupportedListLines.length !== 0 ) {
            buildNotices.push({
                level: 'WARNING',
                text: `${droppedUnsupportedListLines.length} line(s) of a hand-written list were not understood and dropped — see ${UNSUPPORTED_LINES_CONFIG.REPORT_FILE}: ` +
                      droppedUnsupportedListLines.slice(0, 5).map(d => `"${d.line.slice(0, 70)}"`).join(', ') +
                      ( droppedUnsupportedListLines.length > 5 ? ', …' : '' ),
            });
        }
    }

    // ── dropped-regex-rules.txt (10.7.6) — regexFilter rules not shipped because Chrome refused the regex
    // (isRegexSupported) or there was no Chrome to ask; and the regex-rule count per ruleset, with the owner's
    // 800 warning. RELEASE: closes the verdict cache (new verdicts saved) and the headless Chrome, if one ran.
    {
        const result = await closeRegexSupport();
        const dropped = result?.dropped ?? [];
        const counts = result?.shippedCounts ?? [];
        const total = counts.reduce((n, c) => n + c.count, 0);
        const lines = [
            `Regex (regexFilter) rules — ${new Date().toISOString().slice(0, 10)}`,
            `Shipped: ${total} in ${counts.length} ruleset(s)${counts.length ? `: ${counts.map(c => `${c.rulesetId} ${c.count}`).join(', ')}` : ''}.`,
            `Dropped: ${dropped.length}.`,
            '',
            ...dropped.map(d => `[${d.owner}] ${d.reason}${d.caseSensitive ? ' (case-sensitive)' : ''}\n    /${d.regex}/`),
        ];
        await fs.writeFile(path.join(ROOT, REGEX_SUPPORT_CONFIG.REPORT_FILE), lines.join('\n') + '\n', 'utf8');
        console.log(`Wrote ${REGEX_SUPPORT_CONFIG.REPORT_FILE} (${total} shipped, ${dropped.length} dropped).`);
        for ( const c of counts.filter(c => c.count > REGEX_SUPPORT_CONFIG.WARN_REGEX_RULES_PER_RULESET) ) {
            buildNotices.push({ level: 'WARNING', text: `${c.rulesetId}: ${c.count} regex rules — above ${REGEX_SUPPORT_CONFIG.WARN_REGEX_RULES_PER_RULESET} (Chrome's cap is 1 000 per ruleset).` });
        }
        const unverified = dropped.filter(d => d.reason === REGEX_SUPPORT_CONFIG.REASON_NOT_VERIFIED).length;
        if ( unverified !== 0 ) {
            buildNotices.push({ level: 'WARNING', text: `${unverified} regex rule(s) dropped UNVERIFIED — no Chrome to ask (see ${REGEX_SUPPORT_CONFIG.REPORT_FILE}; set ${REGEX_SUPPORT_CONFIG.CHROME_PATH_ENV}).` });
        }
        if ( dropped.length > unverified ) {
            buildNotices.push({ level: 'NOTICE', text: `${dropped.length - unverified} regex rule(s) dropped — Chrome does not support the regex (see ${REGEX_SUPPORT_CONFIG.REPORT_FILE}).` });
        }
    }

    // ── dropped-wildcard-domains.txt / expanded-wildcard-domains.txt —
    // same reporting discipline as dropped-badfilters.txt above, for
    // $domain=example.* TLD-wildcard tokens (see
    // BUGREPORT-domain-wildcard-invalid-dnr-rules.md and resolveWildcardDomainTokens()
    // in rule-parsers.mjs). Two separate files
    // since they're two different outcomes, not two severities of the
    // same thing: dropped = no candidate confirmed against real traffic
    // data for this token, nothing replaces it; expanded = one or more
    // candidates confirmed real, kept.
    {
        const reportPath = path.join(ROOT, 'dropped-wildcard-domains.txt');
        const lines = [
            `Dropped $domain=example.* wildcard tokens — ${new Date().toISOString().slice(0, 10)}`,
            `${droppedWildcardDomains.length} total. Each was a "$domain=example.*" (or ~negated) token —`,
            `invalid DNR syntax (no wildcard support) — for which the CrUX top-1M snapshot`,
            `has no in-scope domain with that name (option C, 10.7.8: every "name.<tld>"`,
            `in the snapshot is used; see resolveWildcardDomainTokens() in`,
            `tools/build/rule-parsers.mjs). expanded-wildcard-domains.txt has the others.`,
            '',
            ...droppedWildcardDomains.map(({ list, line, token }) => `[${list}] [${token}] ${line}`),
        ];
        await fs.writeFile(reportPath, lines.join('\n') + '\n', 'utf8');
        console.log(`Wrote dropped-wildcard-domains.txt (${droppedWildcardDomains.length} entries).`);
    }
    {
        const reportPath = path.join(ROOT, 'expanded-wildcard-domains.txt');
        const lines = [
            `Expanded $domain=example.* wildcard tokens — ${new Date().toISOString().slice(0, 10)}`,
            `${expandedWildcardDomains.length} total. Each was a "$domain=example.*" (or ~negated)`,
            `token expanded to every in-scope domain with that name in the CrUX top-1M`,
            `snapshot (real, visited sites — not guessed TLDs; option C, 10.7.8). The`,
            `"->" column lists the domains used per token.`,
            '',
            ...expandedWildcardDomains.map(({ list, line, token, confirmed }) => `[${list}] [${token}] -> ${confirmed.join(', ')} :: ${line}`),
        ];
        await fs.writeFile(reportPath, lines.join('\n') + '\n', 'utf8');
        console.log(`Wrote expanded-wildcard-domains.txt (${expandedWildcardDomains.length} entries).`);
    }
    return STEP_OK;
}
