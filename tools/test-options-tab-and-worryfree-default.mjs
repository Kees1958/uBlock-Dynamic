#!/usr/bin/env node
// tools/test-options-tab-and-worryfree-default.mjs — (10.5.0) the owner's 10.5.0 requests, proven:
//   A. Dashboard tabs: Filter (block) lists first and the default pane; Allow list after Manage custom
//      rules; "Privacy & Security" is now "Options"; the rendered tab bar follows DASHBOARD_TABS.
//   B + C. (11.0.0) "Enable Seamless surfing on startup" is REMOVED (owner 2026-11-19: always on) — the option, its
//      key, its one-time switch-on step and its marker are gone (was: on the Options tab, default ON, switched ON once).
//   D. Extension name uses the em dash, like "3P Matrix — content firewall".
// Expected values are the owner's request itself (the spec); everything else is imported (C39a).
// Exit 0 = pass, 1 = a failed assertion, 2 = could not run (C38).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
// (11.0.0) the removed "Enable Seamless surfing on startup" option — must stay gone
const RETIRED_STARTUP_INPUT_ID = 'startWorryFreeOnBrowserStartupToggle';
const RETIRED_STARTUP_KEY = 'startWorryFreeOnBrowserStartup';
const RETIRED_CAVEAT = 'I understand that it can break website functionality';
const NAME_SEPARATOR = ' — ';   // owner: "the same hyphen as 3PM" (3P Matrix — content firewall)
const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_DID_NOT_RUN = 2;

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if ( !ok ) { failures += 1; }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function load(rel) { return import(pathToFileURL(path.join(ROOT, rel)).href); }
function area() { return { get: async () => ({}), set: async () => {}, remove: async () => {} }; }

async function main() {
    const names = await load('js/data/ui-names.js');
    const panes = names.DASHBOARD_TABS.map(t => t.pane);

    // ── A. Tabs ──
    console.log('\n── A. Dashboard tabs ──');
    check('Filter (block) lists is the first tab', panes[0] === 'filterlists', panes.join(' > '));
    check('Filter (block) lists is the default pane', names.DEFAULT_DASHBOARD_PANE === 'filterlists');
    check('Allow list comes right after Manage custom rules', panes.indexOf('develop') === panes.indexOf('customrules') + 1);
    check('the former Privacy & Security tab is labelled "Options"', names.tabLabel('security') === 'Options');
    check('every tab has a matching <section data-pane>', panes.every(p => read('dashboard/dashboard.html').includes(`<section data-pane="${p}">`)));

    // Render the real tab-bar code against the real HTML.
    const dom = new JSDOM(read('dashboard/dashboard.html'));
    globalThis.document = dom.window.document;
    const nav = dom.window.document.querySelector('#dashboard-nav');
    for ( const { pane, label } of names.DASHBOARD_TABS ) {   // the same loop dashboard.js runs
        const b = dom.window.document.createElement('button');
        b.className = 'tabButton'; b.dataset.pane = pane; b.textContent = label; nav.appendChild(b);
    }
    const { applyUiNames } = await load('js/ui/ui-names-apply.js');
    applyUiNames(dom.window.document);
    const rendered = [ ...nav.querySelectorAll('.tabButton') ].map(b => b.textContent);
    check('rendered tab bar = DASHBOARD_TABS labels, in order', rendered.join('|') === names.DASHBOARD_TABS.map(t => t.label).join('|'), rendered.join(' | '));
    const dashJs = read('dashboard/dashboard.js');
    check('dashboard.js builds the nav from DASHBOARD_TABS and sets DEFAULT_DASHBOARD_PANE',
        /for \( const \{ pane, label \} of DASHBOARD_TABS \)/.test(dashJs) && /dom\.body\.dataset\.pane = DEFAULT_DASHBOARD_PANE/.test(dashJs));

    // ── B + C. (11.0.0) The startup option is REMOVED — Seamless surfing is always on ──
    // The 10.5.0 checks (option on the Options tab, default ON, one-time switch-on) are replaced: the owner removed the
    // option (2026-11-19). The always-on behaviour itself is proven by tools/test-seamless-always-on.mjs.
    console.log('\n── B + C. Startup option removed (11.0.0) ──');
    const doc = dom.window.document;
    check('the startup option is gone from the dashboard', doc.getElementById(RETIRED_STARTUP_INPUT_ID) === null
        && !read('dashboard/dashboard.html').includes(`data-setting="${RETIRED_STARTUP_KEY}"`));
    check('the "(I understand ...)" caveat is gone from the page', !read('dashboard/dashboard.html').includes(RETIRED_CAVEAT));
    check('no empty [data-ui-name] placeholder is left', [ ...doc.querySelectorAll('[data-ui-name]') ].every(el => el.textContent.length > 0));
    globalThis.self = globalThis;
    globalThis.chrome = globalThis.browser = {
        runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => p, lastError: null, onMessage: { addListener() {} } },
        storage: { local: area(), session: area() },
    };
    const config = await load('js/data/config.js');
    check('the retired key is no longer a setting', Object.hasOwn(config.securityConfig, RETIRED_STARTUP_KEY) === false);
    check('the removed step\'s module is gone', fs.existsSync(path.join(ROOT, 'js/core/worry-free-startup-default.js')) === false);
    const bg = read('js/workflow/background.js');
    check('runVersionMigration no longer runs the switch-on step', !/applyWorryFreeStartupDefault|WORRY_FREE_STARTUP_MARKER_KEY/.test(bg + read('js/workflow/settings-routes.js')));
    check('its stored marker is released (RETIRED_STORAGE_KEYS)', /RETIRED_STORAGE_KEYS = Object\.freeze\(\[[^\]]*'worryFreeStartupDefaultAppliedIn'/.test(read('js/data/config.js')));

    // ── D. Name ──
    console.log('\n── D. Extension name ──');
    const extName = JSON.parse(read('_locales/en/messages.json')).extName.message;
    check(`extension name uses "${NAME_SEPARATOR.trim()}" like 3P Matrix`, extName.includes(NAME_SEPARATOR) && !extName.includes(' - '), extName);

    console.log(failures === 0 ? '\nPASS' : `\n${failures} assertion(s) failed.`);
    process.exit(failures === 0 ? EXIT_PASS : EXIT_FAIL);
}

main().catch(err => {
    console.error('test-options-tab-and-worryfree-default: could not run —', err);
    process.exit(EXIT_DID_NOT_RUN);
});
