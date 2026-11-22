#!/usr/bin/env node
// tools/check-exemption-channels.mjs — every per-site Allow-list option must work in ALL THREE channels (HARD check).
//
// WHY (real report, 10.0.0): "@@bbc.com$worryfree" was documented in tooltips and typed into the built-in
// badfilter-quick-fixes.txt list, but the build parser silently dropped it, and the ABP-import editor never
// processed it either — each channel implemented its own subset. Same bug class as C25 (a feature added to
// one entry point and forgotten at its siblings), so this check is mechanical: it iterates SITE_MODE_OPTIONS
// (the one list of options the Allow list editor accepts) and fails when an option lacks a channel, so a
// NEW option cannot ship half-wired.
//
// The three channels:
//   1. Allow list tab        — site-mode-parser.js + the option's own manager (exercised by test-worryfree-exemption.mjs)
//   2. built-in quick-fixes  — tools/build/rule-parsers.mjs -> carrier allow rules inside the quick-fixes ruleset
//                              (js/core/builtin-exemption-carriers.js, 10.2.0) -> exempt-domains.js loadBuiltinExemptDomains()
//   3. ABP-import editor     — js/core/exempt-domains.js (+ compile-input stripping, editor highlight, wiring)
//
// Drives the REAL exported functions (Part D step 15), with only chrome.* mocked.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ── Config — (10.2.0) the built-in domains of every option travel as a carrier rule inside the quick-fixes
// ruleset (js/core/builtin-exemption-carriers.js); a NEW option in SITE_MODE_OPTIONS without a carrier shape
// FAILS the round-trip check below on purpose (forces triage).
// The effective-list getter exempt-domains.js must export for each option.
// (10.3.0 removal) The "saferegions" entry is gone — that option is retired (RETIRED_SITE_MODE_OPTIONS
// in js/util/site-mode-parser.js) and this file's own getter, getEffectiveSaferegionsDomains, no
// longer exists anywhere; see CHANGELOG.md 10.3.0.
const EFFECTIVE_GETTER_FOR_OPTION = Object.freeze({
    worryfree:   'getEffectiveWorryfreeDomains',
});
const PROBE = 'exemption-channel-probe.example';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if ( !ok ) { failures += 1; }
}

// ── Minimal chrome mock (config.js and the managers touch these at import time) ─────────────────
function area() { return { get: async () => ({}), set: async () => {}, remove: async () => {}, setAccessLevel: async () => {} }; }
globalThis.self = globalThis;
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => p, lastError: null, onMessage: { addListener() {} } },
    storage: { local: area(), session: area() },
    declarativeNetRequest: { updateDynamicRules: async () => {}, getDynamicRules: async () => [], updateSessionRules: async () => {},
        getSessionRules: async () => [], updateEnabledRulesets: async () => {}, getEnabledRulesets: async () => [] },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {} },
    tabs: { query: async () => [], get: async () => ({}) }, action: { setIcon() {}, setBadgeText() {}, setTitle() {} },
    permissions: { contains: async () => true },
};
function imp(rel) { return import(path.join(ROOT, rel)); }

const { SITE_MODE_OPTIONS } = await imp('js/util/site-mode-parser.js');
const { parseBlockRule } = await imp('tools/build/rule-parsers.mjs');
const carriers = await imp('js/core/builtin-exemption-carriers.js');
const exempt = await imp('js/core/exempt-domains.js');

const options = Object.values(SITE_MODE_OPTIONS);
check('SITE_MODE_OPTIONS lists the one surviving option (10.3.0 — "saferegions" is retired)',
    options.length === 1 && options.includes('worryfree'), options.join(','));

for ( const option of options ) {
    // channel 2a — the build parser accepts "@@domain$<option>" and yields an exemption, never a DNR rule or null
    const parsed = parseBlockRule(`@@${PROBE}$${option}`, 1, 600_000, { listName: 'probe' });
    check(`[${option}] build parser: "@@domain$${option}" in a list becomes an exemption (not dropped)`,
        parsed !== null && parsed !== undefined && parsed.domain === PROBE && Object.keys(parsed).some(k => k.endsWith('Exempt') && parsed[k] === true),
        JSON.stringify(parsed));
    check(`[${option}] build parser: a bare (non-exception) "${PROBE}$${option}" is not accepted`,
        parseBlockRule(`${PROBE}$${option}`, 1, 600_000, { listName: 'probe' }) === null);

    // channel 2b (10.2.0) — the build's carrier rule for this option round-trips to the same domain list
    const carrierRules = carriers.buildExemptionCarrierRules(1, { [option]: [ PROBE ] });
    const readBack = carriers.readExemptionCarrierDomains(carrierRules);
    check(`[${option}] quick-fixes carrier: a declared carrier shape exists and round-trips (build -> ruleset -> runtime)`,
        carrierRules.length === 1 && carrierRules.every(r => r.action.type === 'allow') && JSON.stringify(readBack[option]) === JSON.stringify([ PROBE ]),
        JSON.stringify(carrierRules));

    // channel 3 — the ABP-import editor: effective getter, text stripping, derived-state replacement
    const getterName = EFFECTIVE_GETTER_FOR_OPTION[option];
    const getter = exempt[getterName];
    check(`[${option}] exempt-domains.js exports ${getterName ?? '(no getter declared in this check)'}`, typeof getter === 'function');
    if ( typeof getter !== 'function' ) { continue; }
    exempt.refreshImportedExemptDomains(`! note\n@@${PROBE}$${option}\n||ads.example^`);
    check(`[${option}] ABP-import: the editor line joins the effective list`, getter().includes(PROBE), getter().join(','));
    const stripped = exempt.stripExemptionOptionLines(`! note\n@@${PROBE}$${option}\n||ads.example^`);
    check(`[${option}] ABP-import: the line is stripped from the compiler input, the other lines are kept`,
        !stripped.includes(`$${option}`) && stripped.includes('||ads.example^') && stripped.includes('! note'), JSON.stringify(stripped));
    exempt.refreshImportedExemptDomains('');
    check(`[${option}] ABP-import: removing the line removes the exemption (nothing stranded)`, !getter().includes(PROBE));
}

// ── channel 2c (10.2.0): the SHIPPED quick-fixes ruleset — its carriers read back, and nothing else looks like one
{
    const shipped = JSON.parse(read('rulesets/ruleset_badfilter_quickfixes.json'));
    const carrierCount = shipped.filter(carriers.isExemptionCarrierRule).length;
    const domains = carriers.readExemptionCarrierDomains(shipped);
    check('quick-fixes ruleset: at most one carrier per option, every one is a safe allow rule',
        carrierCount <= options.length && shipped.filter(carriers.isExemptionCarrierRule).every(r => r.action.type === 'allow'),
        `${carrierCount} carrier(s): ${JSON.stringify(domains)}`);
    globalThis.fetch = async url => ({ json: async () => JSON.parse(read(String(url).replace(/^\//, ''))) });
    await exempt.loadBuiltinExemptDomains();
    check('runtime: loadBuiltinExemptDomains() puts the shipped $worryfree domains into the effective list',
        domains.worryfree.every(d => exempt.getEffectiveWorryfreeDomains().includes(d)), domains.worryfree.join(','));
    // (10.3.0 removal) The parallel "$saferegions domains exposed" check is gone — that option is
    // retired, carriers.readExemptionCarrierDomains() no longer returns a .saferegions field at all,
    // and exempt-domains.js no longer exports getBuiltinSaferegionsDomains(); see CHANGELOG.md 10.3.0.
}

// ── Wiring (static): the places that must call into the module, so the data cannot go stale ───────
const background = read('js/workflow/background.js');
check('wiring (10.2.0): background.js start() loads the built-in exemptions from the shipped ruleset',
    /await loadBuiltinExemptDomains\(\)/.test(background));
// (10.7.12) The editor save and the settings import moved to settings-routes.js; start() stays in background.js.
// reapplyExemptionRules() (a one-line pass-through) was removed: they call applyWorryfreeRules() directly.
const settingsRoutes = read('js/workflow/settings-routes.js');
const refreshCalls = (background.match(/refreshImportedExemptDomains\(/g) ?? []).length + (settingsRoutes.match(/refreshImportedExemptDomains\(/g) ?? []).length;
check('wiring: the imported lists are recomputed at startup (background.js), on editor save AND on settings import (settings-routes.js)',
    /refreshImportedExemptDomains\(/.test(background) && refreshCalls >= 3, `${refreshCalls} call(s)`);
check('wiring: settings-routes.js re-applies the exemption rules after an editor save / import',
    (settingsRoutes.match(/applyWorryfreeRules\(\)/g) ?? []).length >= 2);
check('wiring: the sandbox compile input is stripped of the option lines (compiled-filters.js)',
    /stripExemptionOptionLines\(sandboxFilters\)/.test(read('js/core/compiled-filters.js')));
check('wiring: the ABP editor does not paint the options as errors (filter-editor.js uses SITE_MODE_OPTIONS)',
    /SITE_MODE_OPTIONS/.test(read('js/ui/filter-editor.js')));
// ── Trusted payment / sign-in services (10.1.5): built-in members of the effective $worryfree list ──
const trusted = await imp('js/data/trusted-service-domains.js');
exempt.refreshImportedExemptDomains('');
const effectiveWorryfree = exempt.getEffectiveWorryfreeDomains();
for ( const domain of [ 'paypal.com', 'js.stripe.com', 'checkout.stripe.com', 'accounts.google.com', 'okta.com', 'login.microsoftonline.com', 'hcaptcha.com', 'transbank.cl', 'pagbank.com.br' ] ) {
    check(`trusted services: ${domain} is exempt from Worry-free`, effectiveWorryfree.includes(domain));
}
for ( const domain of [ 'facebook.com', 'github.com', 'linkedin.com', 'google.com', 'globo.com' ] ) {
    check(`trusted services: whole site ${domain} is NOT exempted`, !trusted.TRUSTED_SERVICE_DOMAINS.includes(domain));
}
// ── Unified whitelist (10.1.6): meeting / gaming / streaming apps are in BOTH the Matrix whitelist and the Worry-free list ──
const appList = await imp('js/data/app-whitelist-domains.js');
const matrix  = await imp('js/data/matrix-constants.js');
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const allAppDomains = Object.values(appList.APP_WHITELIST_DOMAINS).flat();
check('unified whitelist: app list is not empty', allAppDomains.length > 0, `${allAppDomains.length} domain(s)`);
check('unified whitelist: every app domain is a lower-case hostname', allAppDomains.every(d => HOSTNAME_RE.test(d)),
    allAppDomains.filter(d => !HOSTNAME_RE.test(d)).join(', '));
check('unified whitelist: no duplicate inside the app list', new Set(allAppDomains).size === allAppDomains.length,
    allAppDomains.filter((d, i) => allAppDomains.indexOf(d) !== i).join(', '));
const categoryOfAppDomain = new Map(Object.entries(appList.APP_WHITELIST_DOMAINS).flatMap(([ category, domains ]) => domains.map(domain => [ domain, category ])));
const coreCollisions = allAppDomains.filter(d => matrix.SIGNAL_DOMAINS[d] !== undefined || matrix.BUILTIN_DOMAIN_CATEGORY[d] !== categoryOfAppDomain.get(d));
check('unified whitelist: no app domain collides with the Matrix core or signal list', coreCollisions.length === 0, coreCollisions.join(', '));
// (10.2.0) "every category is declared as trusted" check removed: there is no category filter any more —
// every whitelist entry is trusted (data/trusted-service-domains.js), proven by the check right below.
check('unified whitelist (10.2.0): every WHITE domain is in the Worry-free list (one treatment, no category filter)',
    Object.keys(matrix.BUILTIN_DOMAINS).every(d => trusted.TRUSTED_SERVICE_DOMAINS.includes(d) && effectiveWorryfree.includes(d)));
check('unified whitelist (10.2.0): no GREY domain is trusted or Worry-free-exempt',
    Object.keys(matrix.GREY_DOMAINS).every(d => !trusted.TRUSTED_SERVICE_DOMAINS.includes(d) && !effectiveWorryfree.includes(d)));
for ( const domain of allAppDomains ) {
    if ( matrix.BUILTIN_DOMAINS[domain] === undefined || !trusted.TRUSTED_SERVICE_DOMAINS.includes(domain) || !effectiveWorryfree.includes(domain) ) {
        check(`unified whitelist: ${domain} is in the Matrix whitelist AND the Worry-free list`, false);
    }
}
check('unified whitelist: every app domain is in the Matrix whitelist AND the Worry-free list',
    allAppDomains.every(d => matrix.BUILTIN_DOMAINS[d] !== undefined && trusted.TRUSTED_SERVICE_DOMAINS.includes(d) && effectiveWorryfree.includes(d)));
for ( const domain of [ 'youtube.com', 'youtu.be', 'zoom.us', 'netflix.com', 'steampowered.com', 'capcom.com', 'crunchyroll.com' ] ) {
    check(`unified whitelist: ${domain} is exempt from Worry-free and in the Matrix whitelist`, effectiveWorryfree.includes(domain) && matrix.BUILTIN_DOMAINS[domain] !== undefined);
}
check('unified whitelist: the old eval-only STREAMING_GAMING_EXCLUDES list is gone (no second copy)',
    !/STREAMING_GAMING_EXCLUDES\s*=/.test(read('js/core/compiled-filters.js')));
// (10.3.0 removal) compiled-filters.js, ruleset-manager.js and worry-free-extra-manager.js no longer
// read either effective-list function at all — the Worry-free-gated scriptlets, the SCP header allow
// rules and the sandbox-safe-scripts mechanism they used to read it for were all retired along with
// the Privacy & Security tab's extra protections; see CHANGELOG.md 10.3.0. The only surviving reader
// of getEffectiveWorryfreeDomains() is worryfree-manager.js itself (its three whole-site allow rules),
// and getEffectiveSaferegionsDomains() no longer exists anywhere.
for ( const [ file, what ] of [
    [ 'js/core/worryfree-manager.js', 'getEffectiveWorryfreeDomains' ],
] ) {
    check(`wiring: ${file} reads the EFFECTIVE list (${what}), not a single channel's state`, read(file).includes(what));
}
for ( const file of [ 'js/core/compiled-filters.js', 'js/core/ruleset-manager.js', 'js/core/worry-free-extra-manager.js' ] ) {
    check(`wiring: ${file} no longer reads worryfreeState directly`,
        !/\bworryfreeState\.domains\b/.test(read(file).replace(/\/\/.*$/gm, '')));
    check(`wiring: ${file} no longer reads the retired getEffectiveSaferegionsDomains/saferegionsState`,
        !/getEffectiveSaferegionsDomains|saferegionsState/.test(read(file)));
}

if ( failures !== 0 ) {
    console.log(`\nFAIL: ${failures} problem(s) — an Allow-list option is not processed in every channel.`);
    process.exit(1);
}
console.log('\nPASS: every per-site option works in the Allow list tab, the quick-fixes list and the ABP-import editor.');
