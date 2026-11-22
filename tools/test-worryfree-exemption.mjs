#!/usr/bin/env node
// tools/test-worryfree-exemption.mjs — "@@example.com$worryfree" (HARD check).
//
// (10.3.0 removal) This used to guard TWO halves — Worry-free SCRIPTLETS (excludeMatches of every
// Worry-free-gated security scriptlet) and Worry-free DNR BLOCKLISTS (an allow rule per protected
// item). The scriptlet half and the per-item/security-toggle part of the DNR half were retired along
// with the Privacy & Security tab's extra protections (moved to 3P-Matrix); see CHANGELOG.md 10.3.0.
// What's left and still guarded here: worryfree-manager.js's three WHOLE-SITE allow rules, which keep
// $worryfree able to put a site outside the Worry-free extra filter lists — the one DNR mechanism this
// exemption still reaches, asserted against the real exported functions (Part D step 15 — never a
// re-implementation).
//
// Also asserts the parser: $saferegions is retired (10.3.0) and is now dropped and counted via
// ignoredRetiredCount rather than extracted, and that retirement must never swallow a live
// $worryfree line in the same pass (B15's "one shared parser" shape, now one recognised option
// plus one retired option rather than two recognised ones).
//
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOMAIN = 'exempt.example';
const OTHER = 'notexempt.example';

console.log('=== $worryfree per-site exemption — parser, scriptlets, DNR ===');

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}

// ── Minimal browser/chrome mock ─────────────────────────────────────────
const storage = new Map();
let dynamicRules = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async url => {
    if ( typeof url === 'string' && url.startsWith('/rulesets/') ) {
        const text = fs.readFileSync(path.join(ROOT, url), 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    }
    return realFetch(url);
};
function mkArea() { return {
    get: async keys => {
        const names = typeof keys === 'string' ? [ keys ] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
        return Object.fromEntries(names.filter(k => storage.has(k)).map(k => [ k, storage.get(k) ]));
    },
    set: async obj => { for ( const [ k, v ] of Object.entries(obj) ) { storage.set(k, v); } },
    remove: async keys => { for ( const k of (typeof keys === 'string' ? [ keys ] : keys) ) { storage.delete(k); } },
    setAccessLevel: async () => {},
}; }
globalThis.self = globalThis;
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => p, lastError: null, onMessage: { addListener() {} } },
    storage: { local: mkArea(), session: mkArea() },
    declarativeNetRequest: {
        ResourceType: Object.fromEntries([ 'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other' ].map(t => [ t.toUpperCase(), t ])),
        isRegexSupported: async () => ({ isSupported: true }),
        updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
            dynamicRules = dynamicRules.filter(r => removeRuleIds.includes(r.id) === false).concat(addRules);
        },
        getDynamicRules: async () => dynamicRules,
        updateSessionRules: async () => {},
        getSessionRules: async () => [],
        updateEnabledRulesets: async () => {},
        getEnabledRulesets: async () => [],
    },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {} },
    tabs: { query: async () => [], get: async () => ({}) },
    action: { setIcon() {}, setBadgeText() {}, setTitle() {} },
    permissions: { contains: async () => true },
    i18n: { getAcceptLanguages: async () => [] },
};

let parser, config, worryfree, exempt, generated;
try {
    parser = await import(path.join(ROOT, 'js/util/site-mode-parser.js'));
    config = await import(path.join(ROOT, 'js/data/config.js'));
    worryfree = await import(path.join(ROOT, 'js/core/worryfree-manager.js'));
    exempt = await import(path.join(ROOT, 'js/core/exempt-domains.js'));
    // (10.2.0) The built-in lists ship as carrier rules inside the quick-fixes ruleset, not a generated module:
    // read them from the SHIPPED file and load them the way background.js start() does.
    const carriers = await import(path.join(ROOT, 'js/core/builtin-exemption-carriers.js'));
    const shippedCarriers = carriers.readExemptionCarrierDomains(JSON.parse(fs.readFileSync(path.join(ROOT, 'rulesets/ruleset_badfilter_quickfixes.json'), 'utf8')));
    generated = { WORRYFREE_EXEMPT_DOMAINS: shippedCarriers.worryfree };
    await exempt.loadBuiltinExemptDomains();
} catch (err) {
    didNotRun(`cannot import the modules under test (${err.message})`);
}

let failures = 0;
function check(label, ok, detail = '') {
    if ( ok !== true ) { failures += 1; }
    console.log(`${ok === true ? 'OK  ' : 'FAIL'} ${label}${detail !== '' ? ` — ${detail}` : ''}`);
}

// ── 1. Parser: both options, one pass, neither swallowing the other ─────
{
    const text = [
        'plain-allow.com',
        `@@sr.example$saferegions`,
        `@@${DOMAIN}$worryfree`,
        `@@Mixed.Example$WORRYFREE`,
        '@@typo.example$worryfre',
        'another-allow.org',
    ].join('\n');
    const { byOption, remainingText, ignoredRetiredCount } = parser.extractOptionLinesFromText(text);
    check('parser: $worryfree domains extracted',
        byOption.worryfree.join(',') === `${DOMAIN},mixed.example`, byOption.worryfree.join(','));
    check('parser: the retired $saferegions line is dropped and counted, not swallowed into $worryfree',
        ignoredRetiredCount === 1 && byOption.saferegions === undefined, `ignoredRetiredCount=${ignoredRetiredCount}`);
    const modes = parser.siteModesFromText(remainingText);
    check('parser: option lines never become no-filtering entries',
        Object.keys(modes).sort().join(',') === 'another-allow.org,plain-allow.com', Object.keys(modes).join(','));
    check('parser: a misspelled option is ignored, not turned into an "@" entry',
        Object.keys(modes).includes('@') === false);
    check('parser: round-trip serialisation',
        parser.textFromWorryfree([ DOMAIN ]).trim() === `@@${DOMAIN}$worryfree`);
}

// ── 2. DNR half: allow rules for the site the user is ON ────────────────
{
    const stored = await worryfree.setWorryfreeDomains([ ` ${DOMAIN.toUpperCase()} `, DOMAIN, '' ]);
    check('dnr: input normalised (trim, lowercase, de-duplicate, drop empties)',
        stored.length === 1 && stored[0] === DOMAIN, JSON.stringify(stored));
    // (10.3.0 removal) Re-scoped from "2 per-item header allows + 3 whole-site rules" (5 total) to just
    // the 3 whole-site rules: worryfree-manager.js's own two header-allow ITEMS (the Low-group SCP
    // privacy/security off-switches) were retired along with those protections; see CHANGELOG.md
    // 10.3.0 and js/core/worryfree-manager.js's own header. Only SITE_ITEMS remains.
    check('dnr: the three whole-site rules, nothing else',
        dynamicRules.length === 3, `${dynamicRules.length} rule(s)`);
    check('dnr: every rule is an allow rule (the frame-tree rule is allowAllRequests)', dynamicRules.every(r => r.action?.type === 'allow' || r.action?.type === 'allowAllRequests'));
    check('dnr: rule ids are the declared constants in the 18_000_00x range',
        dynamicRules.every(r => r.id >= 18_000_000 && r.id <= 18_000_006),
        dynamicRules.map(r => r.id).join(','));

    // The WHOLE-SITE rules (10.0.0): "$worryfree" puts the site outside Worry-free altogether, so these two
    // must outrank the Worry-free extra FILTER LISTS (8 000) and their per-list off-switch (9 000) — and
    // stay below the default lists (10 000). Without them $worryfree could never fix a site an extra list breaks.
    const siteRules = dynamicRules.filter(r => r.priority === 9_500);
    const frameTreeRule = siteRules.find(r => r.action?.type === 'allowAllRequests');
    const allowSiteRules = siteRules.filter(r => r.action?.type === 'allow');
    const initiatorRule = allowSiteRules.find(r => r.condition.initiatorDomains !== undefined);
    const requestRule = allowSiteRules.find(r => r.condition.requestDomains !== undefined);
    check('site: three whole-site rules at 9 500 (above the extra lists + off-switch, below the default lists)',
        siteRules.length === 3 && allowSiteRules.length === 2 && initiatorRule?.condition.initiatorDomains.includes(DOMAIN) && requestRule?.condition.requestDomains.includes(DOMAIN),
        siteRules.map(r => `${r.id}@${r.priority}`).join(','));
    // Option B (10.1.3): embedded third-party frames are covered by an allowAllRequests rule on the site's own page.
    check('site: the frame-tree rule is allowAllRequests on the site\'s main_frame only (embedded frames follow the page)',
        frameTreeRule?.condition.requestDomains?.includes(DOMAIN) === true
        && JSON.stringify(frameTreeRule.condition.resourceTypes) === '["main_frame"]');
    check('site: the initiator rule excludes main_frame (a link followed OUT of the site is the person\'s own choice); the request rule keeps it',
        initiatorRule?.condition.resourceTypes.includes('main_frame') === false && requestRule?.condition.resourceTypes.includes('main_frame') === true);
    check('site: an unrelated site is NOT exempted',
        siteRules.every(r => JSON.stringify(r.condition).includes(OTHER) === false));

    // GUARD (clear/release): emptying the list must strand nothing.
    await worryfree.setWorryfreeDomains([]);
    // Clearing the Allow-list tab's list removes ITS rules; the built-in sites (badfilter-quick-fixes.txt,
    // 10.0.0) keep theirs — all three rules when there are any built-in sites, none when there are not.
    // (10.5.5) Built-in = what the extension itself treats as built-in once the tab's list is empty: the quick-fixes
    // carriers AND the trusted-service whitelist (281 sites). Counting only the carriers (0) expected no rules — stale.
    const builtInSites = exempt.getEffectiveWorryfreeDomains();
    check('dnr: clearing the Allow-list tab\'s list removes its rules (only the built-in sites\' remain)',
        dynamicRules.length === (builtInSites.length === 0 ? 0 : 3)
            && dynamicRules.every(r => JSON.stringify(r.condition).includes(DOMAIN) === false),
        `${dynamicRules.length} left`);
    await worryfree.setWorryfreeDomains([ DOMAIN ]);
    check('dnr: re-adding does not duplicate ids',
        new Set(dynamicRules.map(r => r.id)).size === dynamicRules.length);
}

// -- 3. Scriptlet half — RETIRED (10.3.0) ----------------------------------------
// prepareSecurityScriptletDirectives() no longer builds any $worryfree-specific excludeMatches: the
// only surviving SECURITY_SCRIPTLETS entry (blockPings) was never Worry-free-gated — it is one of
// the "Privacy enhancements" rows — and every item that WAS Worry-free-gated
// (and so needed this exemption) moved to 3P-Matrix. See js/core/compiled-filters.js's
// buildSiteModeMatchScope(), which now only reflects per-site filtering mode, not $worryfree.

// -- 4. Worry-free annoyances list — RETIRED (10.0.7) --------------------------
// ruleset_annoyances is an always-on Built-in default list now (no session gate, no
// $worryfree-specific exemption left to test here). See test-annoyances-registration.mjs,
// which asserts the replacement behavior directly against the real registration functions.

// -- 5. Security-toggle rules — RETIRED (10.3.0) ---------------------------------
// updateSecurityRules() and the whole security-toggle rule mechanism (including "Block suspicious
// 3P-requests") were retired along with the Privacy & Security tab's extra protections; see
// CHANGELOG.md 10.3.0. Nothing left here for $worryfree to reach through that no longer reaches it
// through SITE_ITEMS (section 2) already.

// -- 6. Behaviour against the SHIPPED extra lists (10.0.0) ------------------------------------------
// The regression this exists for: after the 9.9.1 ladder put the Worry-free extra lists (8 000) above every
// safe-domain exemption, "@@bbc.com$saferegions" stopped fixing BBC video and "$worryfree" could not either
// (its per-item allows sit at 101-131). Evaluated with the independent precedence model
// (tools/dnr-precedence-eval.mjs — a model of Chrome's documented rule, not Chrome itself).
{
    const evaluator = await import(path.join(ROOT, 'tools/dnr-precedence-eval.mjs'));
    if ( typeof evaluator.evaluate !== 'function' || typeof evaluator.loadEnabledRules !== 'function' ) {
        didNotRun('dnr-precedence-eval.mjs no longer exports evaluate/loadEnabledRules — this check needs updating, not silently skipping');
    }
    const { rules: shipped } = evaluator.loadEnabledRules(ROOT);
    // A request that ONLY an extra list blocks: the same URL blocked by a DEFAULT list (10 000) would
    // correctly keep winning after the exemption, which is not what is under test here.
    // BUG FIX (10.0.7): this used to try only probeUrls(r)[0] — the first domain of the first
    // qualifying rule — which silently broke once that one domain also happened to be blocked by
    // a DIFFERENT list (e.g. ruleset_hagezi_light also covering ruleset_adguard_tracking_servers'
    // first domain). Now loops over EVERY domain of EVERY qualifying rule.
    let url, type;
    outer:
    for ( const r of shipped ) {
        // 10.1.2: the extra lists are now third-party-only blocks (domainType 'thirdParty'), so rules that
        // carry that domainType must qualify too — the probe below uses DOMAIN as the initiator, which is
        // third-party to every probed URL. Only a first-party-only rule would not match that probe.
        if ( r.action?.type !== 'block' || !evaluator.EXTRA_LIST_IDS.includes(r._list) || r.priority !== 8_000
            || ( r.condition?.domainType !== undefined && r.condition.domainType !== 'thirdParty' ) ) { continue; }
        const candidateType = r.condition?.resourceTypes?.[0] ?? 'script';
        for ( const candidateUrl of evaluator.probeUrls(r) ) {
            const verdict = evaluator.evaluate(shipped, { url: candidateUrl, initiator: DOMAIN, type: candidateType });
            if ( verdict.outcome === 'BLOCK' && evaluator.EXTRA_LIST_IDS.includes(verdict.winner?._list) ) {
                url = candidateUrl; type = candidateType; break outer;
            }
        }
    }
    if ( url === undefined ) {
        didNotRun('no request found that ONLY a shipped Worry-free extra list blocks');
    }
    const asSite = { url, initiator: DOMAIN, type };
    const asOther = { url, initiator: OTHER, type };

    await worryfree.setWorryfreeDomains([]);
    const none = [ ...shipped, ...dynamicRules ];
    check('behaviour: without any exemption an extra-list rule blocks the request (premise)',
        evaluator.evaluate(none, asSite).outcome === 'BLOCK', url);

    await worryfree.setWorryfreeDomains([ DOMAIN ]);
    const withRules = [ ...shipped, ...dynamicRules ];
    check('behaviour: with "$worryfree" the same request from the exempt site is ALLOWED (the extra list no longer wins)',
        evaluator.evaluate(withRules, asSite).outcome === 'ALLOW', `${url} ${type} winner=${evaluator.evaluate(withRules, asSite).winner?._list ?? evaluator.evaluate(withRules, asSite).winner?.id}`);
    check('behaviour: the same request from an UNRELATED site is still BLOCKED (no cross-site leak)',
        evaluator.evaluate(withRules, asOther).outcome === 'BLOCK');
    const perItemOnly = [ ...shipped, ...dynamicRules.filter(r => r.priority < 9_000) ];
    check('behaviour: the four per-item allows alone (101-131) can NOT cancel an extra-list block — the 9.9.1 regression this fixes',
        evaluator.evaluate(perItemOnly, asSite).outcome === 'BLOCK');

    // Requests sent TO the exempt site's hosts from another site's page.
    const toSite = { priority: 8_000, action: { type: 'block' }, condition: { urlFilter: `||${DOMAIN}^`, resourceTypes: [ 'script', 'media' ] } };
    check('behaviour: a request TO the exempt site\'s host is allowed even when another site made it',
        evaluator.evaluate([ toSite, ...dynamicRules ], { url: `https://video.${DOMAIN}/x`, initiator: OTHER, type: 'media' }).outcome === 'ALLOW');

    // (10.3.0 removal) The always-on web-bundle block this used to check is gone along with the rest
    // of the Privacy & Security tab's "Security enhancements" group; see CHANGELOG.md 10.3.0.
    // GUARD (release): leave the shared mock as found.
    await worryfree.setWorryfreeDomains([ DOMAIN ]);
}

// -- 7. The other two channels (10.0.0): built-in quick-fixes list + ABP-import editor ----------------
// "@@domain$worryfree" is accepted in THREE places; each must reach the same rules. (The Allow list tab is
// sections 2-6 above; tools/check-exemption-channels.mjs asserts the wiring of all three for every option.)
{
    const IMPORTED = 'imported-by-abp.example';
    const builtIn = generated.WORRYFREE_EXEMPT_DOMAINS;
    check('built-in: the shipped quick-fixes ruleset carries the $worryfree domains (array)', Array.isArray(builtIn));

    // Allow list tab EMPTY: only the built-in list and the ABP-import editor remain.
    config.worryfreeState.domains = [];
    storage.set('cookieClicker.autoDeny', { active: true });
    exempt.refreshImportedExemptDomains(`! ABP-import editor\n@@${IMPORTED}$worryfree\n||tracker.example^`);

    const effective = exempt.getEffectiveWorryfreeDomains();
    check('effective list = built-in + ABP-import (+ Allow list tab)',
        builtIn.every(d => effective.includes(d)) && effective.includes(IMPORTED), effective.join(','));
    check('the Allow list editor\'s own list stays user-only (built-in/imported sites never leak into it)',
        worryfree.getWorryfreeDomains().length === 0 && config.worryfreeState.domains.length === 0);

    await worryfree.applyWorryfreeRules();
    const wholeSite = dynamicRules.filter(r => r.priority === 9_500);
    const initiator = wholeSite.find(r => r.condition.initiatorDomains !== undefined);
    check('DNR: the three whole-site rules carry the ABP-import site AND the built-in sites',
        wholeSite.length === 3 && initiator?.condition.initiatorDomains.includes(IMPORTED)
            && builtIn.every(d => initiator.condition.initiatorDomains.includes(d)),
        JSON.stringify(initiator?.condition.initiatorDomains));

    // (10.3.0 removal) The Security-toggle-exclusion and scriptlet-exclusion checks this section used
    // to run here (updateSecurityRules(), prepareSecurityScriptletDirectives(true)) are gone along
    // with that whole mechanism — see sections 3 and 5's own notes above. Only the DNR whole-site
    // allow, asserted just above, is left for $worryfree to reach through this channel.

    // GUARD (clear/release): removing the line must strand nothing anywhere.
    exempt.refreshImportedExemptDomains('! empty now');
    await worryfree.applyWorryfreeRules();
    check('removing the ABP-import line removes the DNR exemption',
        dynamicRules.filter(r => r.priority === 9_500).every(r => JSON.stringify(r.condition).includes(IMPORTED) === false));

    // Every OTHER way the process ends (C41 — Initiate -> Perform -> End): the editor emptied completely (the stored
    // text is then ABSENT, i.e. undefined/null, not an empty string) and the text being something that is not a string.
    exempt.refreshImportedExemptDomains(`@@${IMPORTED}$worryfree`);
    check('end: an emptied ABP-import editor (stored text undefined) removes the exemption',
        (exempt.refreshImportedExemptDomains(undefined), exempt.getEffectiveWorryfreeDomains().includes(IMPORTED) === false));
    exempt.refreshImportedExemptDomains(`@@${IMPORTED}$worryfree`);
    check('end: a non-string stored text (corrupt storage) clears it rather than throwing',
        (exempt.refreshImportedExemptDomains({ not: 'a string' }), exempt.getEffectiveWorryfreeDomains().includes(IMPORTED) === false));
    // Restart: the derived list lives in memory only, so a service-worker restart must RE-derive it from the stored text.
    exempt.refreshImportedExemptDomains(`@@${IMPORTED}$worryfree`);
    check('restart: the same stored text re-derives the same exemption (recompute is idempotent)',
        (exempt.refreshImportedExemptDomains(`@@${IMPORTED}$worryfree`), exempt.getEffectiveWorryfreeDomains().filter(d => d === IMPORTED).length === 1));
    exempt.refreshImportedExemptDomains('');

    // GUARD (release): leave shared state as found.
    storage.delete('cookieClicker.autoDeny');
    config.worryfreeState.domains = [ DOMAIN ];
    await worryfree.applyWorryfreeRules();
}

if ( failures !== 0 ) {
    console.log(`\nFAIL: ${failures} problem(s) — the $worryfree exemption would be partial, which reads as "it does not work".`);
    process.exit(1);
}
console.log('\nPASS: parser and DNR allow rules honour $worryfree.');
