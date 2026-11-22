#!/usr/bin/env node
// tools/test-settings-known-keys.mjs — (10.5.0) the generic guard that replaced the 10.3.0 retired-key
// lists: stored and restored settings keep only keys this version knows, with the right type (C6/C13b).
//   1. pickKnownKeys(): unknown key dropped, wrong type dropped, known key kept, bad input -> {}.
//   2. Startup load (real js/data/config.js against mocked storage): a stored retired key never reaches
//      memory and is released from storage (written back once); a clean store is not rewritten.
//   3. Restore wiring: handleImportAllSettings() merges securityConfig through pickKnownKeys() and no
//      longer restores the removed securityAllowlist (source check — the handler needs the whole SW).
//   (audit 10.6.4) securityAllowlist was removed: its stored key must be released on load.
// Exit 0 = pass, 1 = failed assertion, 2 = could not run (C38).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
const RETIRED_KEY = 'blockWebBundles';   // a real 10.3.0-retired securityConfig key, as an old install stores it
const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_DID_NOT_RUN = 2;

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if ( !ok ) { failures += 1; }
}

const storage = new Map();
const writes = [];
function area(log) {
    return {
        get: async keys => {
            const names = typeof keys === 'string' ? [ keys ] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
            return Object.fromEntries(names.filter(k => storage.has(k)).map(k => [ k, JSON.parse(JSON.stringify(storage.get(k))) ]));
        },
        set: async obj => { for ( const [ k, v ] of Object.entries(obj) ) { storage.set(k, JSON.parse(JSON.stringify(v))); if ( log ) { writes.push(k); } } },
        remove: async keys => { for ( const k of [ keys ].flat() ) { storage.delete(k); } },
    };
}

async function main() {
    globalThis.self = globalThis;
    globalThis.chrome = globalThis.browser = {
        runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => p, lastError: null, onMessage: { addListener() {} } },
        storage: { local: area(true), session: area(false) },
    };
    // Seed what a pre-10.3.0 install leaves behind, BEFORE config.js loads it.
    storage.set('rulesetConfig', { version: '10.2.0' });
    storage.set('securityConfig', { deleteHistoryOnStart: false, [RETIRED_KEY]: true, seamlessSurfingEnabled: 'yes' });
    // (audit 10.6.4) securityAllowlist was removed outright — an old install still has the stored key.
    storage.set('securityAllowlist', { blockPings: 'a.com', [RETIRED_KEY]: 'b.com' });
    const config = await import(pathToFileURL(path.join(ROOT, 'js/data/config.js')).href);

    console.log('\n── 1. pickKnownKeys ──');
    const defaults = { a: true, b: '' };
    const picked = config.pickKnownKeys(defaults, { a: false, b: 7, c: true });
    check('known key with the right type is kept', picked.a === false);
    check('known key with the wrong type is dropped', !Object.hasOwn(picked, 'b'));
    check('unknown key is dropped', !Object.hasOwn(picked, 'c'));
    check('null / non-object input gives {}', Object.keys(config.pickKnownKeys(defaults, null)).length === 0
        && Object.keys(config.pickKnownKeys(defaults, 'x')).length === 0);

    console.log('\n── 2. Startup load ──');
    await config.loadRulesetConfig();
    check('retired key never reaches memory', !Object.hasOwn(config.securityConfig, RETIRED_KEY));
    check('known stored value is applied', config.securityConfig.deleteHistoryOnStart === false);
    check('wrongly typed stored value is not applied (default kept)', config.securityConfig.seamlessSurfingEnabled === true);
    check('retired key released from storage (securityConfig)', !Object.hasOwn(storage.get('securityConfig'), RETIRED_KEY));
    await new Promise(r => setTimeout(r, 0));   // the release is fire-and-forget in loadRulesetConfig()
    check('removed securityAllowlist key released from storage', storage.has('securityAllowlist') === false);
    check('securityAllowlist is no longer exported', !Object.hasOwn(config, 'securityAllowlist'));
    writes.length = 0;
    await config.loadRulesetConfig();
    check('a clean store is not rewritten on the next load', !writes.includes('securityConfig') && !writes.includes('securityAllowlist'), writes.join(','));
    check('the removed key is not written back either', storage.has('securityAllowlist') === false);

    console.log('\n── 3. Restore wiring ──');
    // (10.7.12) The settings handlers moved from background.js to js/workflow/settings-routes.js — this check reads them there.
    const bg = fs.readFileSync(path.join(ROOT, 'js/workflow/settings-routes.js'), 'utf8');
    const importFn = bg.slice(bg.indexOf('async function handleImportAllSettings'), bg.indexOf('async function handleResetAllSettings'));
    check('restore merges securityConfig through pickKnownKeys', /Object\.assign\(securityConfig,\s*pickKnownKeys\(securityConfig,\s*payload\.securityConfig\)\)/.test(importFn));
    check('restore no longer touches the removed securityAllowlist', !/securityAllowlist\s*[,)=]|saveSecurityAllowlist/.test(importFn.replace(/\/\/.*$/gm, '')));

    console.log(failures === 0 ? '\nPASS' : `\n${failures} assertion(s) failed.`);
    process.exit(failures === 0 ? EXIT_PASS : EXIT_FAIL);
}

main().catch(err => {
    console.error('test-settings-known-keys: could not run —', err);
    process.exit(EXIT_DID_NOT_RUN);
});
