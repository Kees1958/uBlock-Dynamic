// New check (this session, from a real bug): js/core/static-rulesets.js's
// own header states the invariant in plain words — "The list of valid IDs
// is STATIC_RULESET_IDS (must match manifest.json rule_resources)" — but
// nothing ever actually verified it. Four ruleset ids
// (ruleset_disconnect_ads, ruleset_ghostery_ads, ruleset_disconnect_other,
// ruleset_ghostery_other) were declared in manifest.json and rendered as
// real, toggleable rows in the dashboard, but missing from
// STATIC_RULESET_IDS — every toggle click for one of them silently no-op'd
// at setRulesetEnabled()'s own validation guard, so the checkbox always
// reverted to Chrome's real (unchanged) DNR state on refresh. Caught by
// manual code review, not by any automated check — this check exists so
// the next drift in either direction (a new manifest entry not added
// here, or a stale entry left here after a manifest removal) fails loudly
// instead of shipping silently.
//
// Cross-checks BOTH directions — the module's own stated invariant is
// exact equality, not "at least" in either direction — and imports the
// real STATIC_RULESET_IDS export rather than regex-scraping the source
// file, so this can never drift from what the code actually does (same
// reasoning as this project's B15/C21 "verify against the real
// implementation, not a hand-copy" convention).
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');

console.log('=== Static ruleset ID cross-reference (manifest.json <-> static-rulesets.js) ===');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const manifestIds = (manifest.declarative_net_request?.rule_resources ?? []).map(r => r.id);

// static-rulesets.js's own import chain (ext.js -> ext-compat.js) reads
// self.browser/self.chrome at module-load time — reuse the exact mock
// shape test-core-modules-dry-run.mjs already established for this same
// situation, rather than re-deriving a new one.
globalThis.chrome = {
    storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
    runtime: { getURL: p => `chrome-extension://test/${p}` },
};
globalThis.browser = globalThis.chrome;
globalThis.self = globalThis;

const mod = await import(pathToFileURL(path.join(ROOT, 'js/core/static-rulesets.js')).href);
const staticIds = mod.STATIC_RULESET_IDS;

const manifestSet = new Set(manifestIds);
const staticSet = new Set(staticIds);

// ── Documented allowlist — manifest ids deliberately NOT in
// STATIC_RULESET_IDS ─────────────────────────────────────────────────────
// These 11 are real static rulesets (declared in manifest.json,
// `enabled: true`, always loaded into Chrome's rule engine) but are
// managed EXCLUSIVELY through js/core/worry-free-extra-manager.js's own
// suppression-rule pattern (a dynamic, higher-priority allow rule that
// wins during a Worry-free session) rather than through
// setRulesetEnabled()/dnr.updateEnabledRulesets() — confirmed by grep:
// worry-free-extra-manager.js never calls updateEnabledRulesets() at all.
// The dashboard still exposes a checkbox for each (see
// dashboard/filter-manager-ui.js's worryFreeAdguardTrackingToggle /
// worryFreeEasylistAdserversToggle / worryFreePeterloweToggle, and the
// single worryFreeSecurityTldProtectionsToggle driving all 4 of the
// worryfree_* ones together) — it's just wired to a securityConfig-style
// setting key, not this module's ruleset-enable path. Two of manifest's
// other ids (ruleset_disconnect_other, ruleset_ghostery_other — both since removed) were
// DUAL-managed — both a real STATIC_RULESET_IDS entry (the Default Filter
// Lists panel toggle) AND their own worry-free suppression-rule entry
// (worryFreeDisconnectOtherEnabled/worryFreeGhosteryOtherEnabled) — that's
// intentional layering, not a conflict, and those two stay OUT of this
// allowlist since they must still be in STATIC_RULESET_IDS.
const WORRY_FREE_SUPPRESSION_ONLY_IDS = new Set([
    'ruleset_adguard_tracking_servers',
    // (10.1.1) ruleset_peterlowe RESTORED as a suppression-only Worry-free list (like the one above).
    'ruleset_peterlowe',
    // (10.0.7) ruleset_easylist_adservers/_adult_specific/_thirdparty and the
    // Worry-free-gated ruleset_annoyances RETIRED here: the first four were removed, annoyances is
    // an always-on Built-in default now (listed in STATIC_RULESET_IDS).
    // ruleset_kees1958 is NOT here either — it stays in STATIC_RULESET_IDS.
    // ruleset_adguard_base_removeparam (10.0.7): "AdGuard remove tracking parameters", split out
    // of AdGuard Base. Suppression-only via the no-tier suppression shape, governed by
    // worryFreeAdguardRemoveparamEnabled; never toggled via setRulesetEnabled(), so
    // deliberately NOT in STATIC_RULESET_IDS.
    'ruleset_adguard_base_removeparam',
    // (AdShield Evolution rename pass) ruleset_worryfree_3pblock,
    // ruleset_worryfree_tldallow, ruleset_worryfree_downloadblock, and
    // ruleset_worryfree_download_tldallow — blockScpTldBlock's own four
    // rulesets — REMOVED from this list, since blockScpTldBlock and
    // every mechanism behind it were removed per explicit request; see
    // CHANGELOG_HISTORY.md for the full entry. None of the four exist in
    // manifest.json anymore either, so this list no longer needs to
    // exclude them from the "missing from STATIC_RULESET_IDS" check.
    //
    // (The advanced "Medium" tier's six rulesets were removed in v9.6.8.)
    //
    // (10.3.0 removal) ruleset_scp_privacy_block/ruleset_scp_security_block and the whole
    // js/data/security-rulesets.js SECURITY_OWNED_RULESET_IDS allowlist REMOVED here — the
    // Privacy & Security tab's "Security enhancements" and both breakage-risk groups moved to
    // 3P-Matrix; none of those rulesets exist in manifest.json anymore either. See
    // CHANGELOG.md 10.3.0 and js/data/retired-protections.js.
]);

// (10.7.1) Hidden, always-on rulesets with NO switch of any kind: no dashboard row, no Worry-free setting, never
// passed to setRulesetEnabled(). Enabled by manifest.json alone, so they correctly stay OUT of STATIC_RULESET_IDS.
// Separate from the set above on purpose — these are not suppression-gated either.
const ALWAYS_ON_HIDDEN_IDS = new Set([
    // AdGuard's exceptions for the three Worry-free tracker lists (tools/build/tracking-allowlist-source.mjs).
    'ruleset_tracking_servers_allowlist',
]);
const NOT_TOGGLED_IDS = new Set([ ...WORRY_FREE_SUPPRESSION_ONLY_IDS, ...ALWAYS_ON_HIDDEN_IDS ]);

const missingFromStatic = manifestIds.filter(id => !staticSet.has(id) && !NOT_TOGGLED_IDS.has(id));
const missingFromManifest = staticIds.filter(id => !manifestSet.has(id));

// A manifest id can't be BOTH in STATIC_RULESET_IDS AND the allowlist —
// that would mean the allowlist itself has drifted stale (e.g. someone
// added a real setRulesetEnabled() entry for one of these 7 without
// removing it from this allowlist). Catch that explicitly rather than
// letting it silently pass as "fine either way".
const allowlistDrift = [ ...NOT_TOGGLED_IDS ].filter(id => staticSet.has(id));

let ok = true;

if ( missingFromStatic.length > 0 ) {
    ok = false;
    console.log(`FAIL: declared in manifest.json but missing from STATIC_RULESET_IDS (setRulesetEnabled() silently no-ops for these — this is exactly the bug this check exists to catch):`);
    for ( const id of missingFromStatic ) { console.log(`  - ${id}`); }
} else {
    console.log(`PASS: every manifest.json rule_resources id (${manifestIds.length}) is present in STATIC_RULESET_IDS.`);
}

if ( missingFromManifest.length > 0 ) {
    ok = false;
    console.log(`FAIL: present in STATIC_RULESET_IDS but not declared in manifest.json (stale entry — updateEnabledRulesets() will throw for the whole batch if this id is ever toggled):`);
    for ( const id of missingFromManifest ) { console.log(`  - ${id}`); }
} else {
    console.log(`PASS: every STATIC_RULESET_IDS entry (${staticIds.length}) is declared in manifest.json.`);
}

if ( new Set(staticIds).size !== staticIds.length ) {
    ok = false;
    console.log('FAIL: STATIC_RULESET_IDS contains a duplicate entry.');
}

if ( allowlistDrift.length > 0 ) {
    ok = false;
    console.log(`FAIL: these ids are in BOTH STATIC_RULESET_IDS and this check's WORRY_FREE_SUPPRESSION_ONLY_IDS allowlist — the allowlist is stale, remove them from it:`);
    for ( const id of allowlistDrift ) { console.log(`  - ${id}`); }
}

console.log(ok ? 'PASS: static-ruleset-ids check' : 'FAIL: static-ruleset-ids check');
process.exitCode = ok ? 0 : 1;
