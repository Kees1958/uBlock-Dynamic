#!/usr/bin/env node
// tools/check-dnr-ruleset-limits.mjs — (10.7.6, audit 10.7.5 D-9) Chrome's limits on STATIC rulesets, and what the
// person sees when Chrome refuses to switch a filter list.
//   A. Shipped manifest + ruleset files against js/core/dnr-budgets.js: declared lists <= MAX_NUMBER_OF_STATIC_RULESETS,
//      lists on by default <= MAX_NUMBER_OF_ENABLED_STATIC_RULESETS, their rules <= GUARANTEED_MINIMUM_STATIC_RULES
//      (FAIL). What a person could switch on beyond that is reported (INFO) — Chrome then refuses and the dashboard
//      says so (part B).
//   B. setRulesetEnabled() (the real function, Chrome mocked) returns Chrome's refusal and does not remember the
//      choice; the route returns it; every dashboard switch goes through requestRulesetEnabled(), which shows it;
//      a settings restore names the refused lists.
// Usage: node tools/check-dnr-ruleset-limits.mjs        Outcomes (C38): PASS / FAIL / DID NOT RUN.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OVERRIDES_KEY_HINT = 'enabledRulesetOverrides';   // informational: the stored-choices key static-rulesets.js uses

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
    if ( !ok ) { failures += 1; }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function ruleCount(resource) { return JSON.parse(read(resource.path.replace(/^\//, ''))).length; }

async function main() {
    const B = await import(pathToFileURL(path.join(ROOT, 'js/core/dnr-budgets.js')).href);

    console.log('── A. Shipped rulesets against Chrome\'s limits ──');
    const resources = JSON.parse(read('manifest.json')).declarative_net_request?.rule_resources ?? [];
    const onByDefault = resources.filter(r => r.enabled);
    const defaultRules = onByDefault.reduce((n, r) => n + ruleCount(r), 0);
    const allRules = resources.reduce((n, r) => n + ruleCount(r), 0);
    check(`declared lists ${resources.length} <= ${B.MAX_NUMBER_OF_STATIC_RULESETS}`, resources.length <= B.MAX_NUMBER_OF_STATIC_RULESETS);
    check(`lists on by default ${onByDefault.length} <= ${B.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS}`, onByDefault.length <= B.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS);
    check(`rules on by default ${defaultRules} <= ${B.GUARANTEED_MINIMUM_STATIC_RULES} (guaranteed budget)`, defaultRules <= B.GUARANTEED_MINIMUM_STATIC_RULES);
    console.log(`INFO all ${resources.length} lists together: ${allRules} rules (guaranteed ${B.GUARANTEED_MINIMUM_STATIC_RULES}); `
        + `${resources.length > B.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS ? `more than ${B.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS} switched on at once is refused by Chrome — the dashboard reports it (part B)` : 'all can be on at once'}.`);

    console.log('\n── B. A refusal reaches the person ──');
    const store = {};
    let refuse = false;
    globalThis.self = globalThis;
    globalThis.chrome = globalThis.browser = {
        runtime: { id: 'test', getURL: p => p, getManifest: () => ({ version: '0' }) },
        storage: { local: {
            get: async key => (typeof key === 'string' ? { [key]: store[key] } : { ...store }),
            set: async obj => { Object.assign(store, obj); },
            remove: async keys => { for ( const k of [].concat(keys) ) { delete store[k]; } },
        } },
        declarativeNetRequest: {
            getEnabledRulesets: async () => [],
            updateEnabledRulesets: async () => { if ( refuse ) { throw new Error('The number of enabled static rulesets exceeds the limit.'); } },
        },
    };
    const sr = await import(pathToFileURL(path.join(ROOT, 'js/core/static-rulesets.js')).href);
    const id = sr.STATIC_RULESET_IDS[0];
    const ok = await sr.setRulesetEnabled(id, true);
    check('a successful switch returns { ok: true }', ok?.ok === true, JSON.stringify(ok));
    const before = JSON.stringify(store);
    refuse = true;
    const refused = await sr.setRulesetEnabled(id, false);
    check('Chrome\'s refusal is returned with its reason', refused?.ok === false && /exceeds the limit/.test(refused.error ?? ''), JSON.stringify(refused));
    check(`a refused choice is not remembered (${OVERRIDES_KEY_HINT})`, JSON.stringify(store) === before);
    check('an unknown list is refused, not ignored', (await sr.setRulesetEnabled('no_such_ruleset', true))?.ok === false);

    const route = read('js/workflow/ruleset-routes.js');
    check('the route returns the refusal to the dashboard', /const result = await setRulesetEnabled\(request\.id, request\.enabled\);\s*\n\s*if \( result\?\.ok === false \) \{ return result; \}/.test(route));
    const ui = read('dashboard/filter-manager-ui.js');
    const direct = (ui.match(/what:\s*MSG_SET_RULESET_ENABLED/g) ?? []).length;
    check('every dashboard switch goes through requestRulesetEnabled() (one direct send, inside it)', direct === 1, `${direct} direct sends`);
    check('requestRulesetEnabled() shows the refusal', /async function requestRulesetEnabled[\s\S]*?elFilterListsStatus\.textContent =/.test(ui));
    check('a refused switch is set back', (ui.match(/=== false \) \{ cb\.checked = !cb\.checked; \}/g) ?? []).length === 2);
    check('the status element exists', /id="filterListsStatus"/.test(read('dashboard/dashboard.html')));
    check('a settings restore names refused lists', /rulesetsRefused/.test(read('js/workflow/settings-routes.js'))   // (10.7.12) restore moved there
 && /rulesetsRefused/.test(read('dashboard/settings-io.js')));

    console.log(failures === 0 ? '\nPASS' : `\n${failures} assertion(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('DID NOT RUN: check-dnr-ruleset-limits —', err);
    process.exit(1);
});
