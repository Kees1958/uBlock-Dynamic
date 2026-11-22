// ── check-manifest-permissions.mjs ───────────────────────────────────────────
// C19 / real incident 8.6.0: a permission was silently dropped from
// manifest.json during an unrelated cleanup, every automated check passed
// (none of them compared the browser.* APIs the code CALLS against the
// permissions the manifest DECLARES), and the extension then failed to
// register its service worker at all when actually loaded. This check is
// that missing comparison, in both directions, plus the store-readiness
// bans from C19.
//
// Checks (all hard failures):
//   1. USED BUT NOT DECLARED — the code calls browser.<ns> / chrome.<ns>
//      for a namespace that needs a manifest permission, and that
//      permission is not declared (in "permissions" or
//      "optional_permissions"). This is the 8.6.0 failure.
//   2. DECLARED BUT NEVER USED — a declared permission this table knows a
//      namespace for, with zero uses in shipped code. An unused permission
//      is a Chrome Web Store review liability and widens the install
//      warning for nothing. Deliberate exceptions go in
//      DECLARED_WITHOUT_CODE_USE_ALLOWLIST below, each with a reason.
//   3. UNKNOWN PERMISSION — a declared permission this table has no entry
//      for (neither a namespace mapping nor an explicit no-namespace
//      entry). Fails so a new permission is classified on purpose instead
//      of passing unexamined.
//   4. C19 STORE BANS (project policy, built on Chrome's limits) — the
//      manifest declares declarativeNetRequestFeedback (a debugging
//      permission for unpacked extensions), or non-comment code calls
//      onRuleMatchedDebug / testMatchOutcome (unpacked-only) or
//      getMatchedRules (needs that permission, or an activeTab grant for
//      one tab — uBD declares neither; see ARCHITECTURE.md).
//   5. C31 JSON MODE PINNED — the manifest declares "message_serialization".
//      uBD stays in Chrome's default JSON messaging on purpose: it is the
//      narrowest format at the boundary pages can reach (Chrome 148 added a
//      structured-clone opt-in that admits Map/Set/Date/buffers/cycles).
//
// Detection limits (stated, not hidden): a textual scan for
// `browser.<ns>` / `chrome.<ns>` / `webext.<ns>` (API_ROOTS). It cannot see
// an API reached through a computed property (`browser[name]`) or an alias
// created from a variable other than those literal roots. Comments are stripped before scanning
// with a simple line/block-comment pass, not a real parser — a `//`
// inside a string literal could hide a few characters of code from the
// scan; it cannot invent a use that isn't there, so the risk is a missed
// detection, never a false pass on check 2.
//
// Usage:  node tools/check-manifest-permissions.mjs [--root <dir>]
//   --root  scan another tree (used by the injection self-test recorded in
//           CHANGELOG_HISTORY.md 9.7.3 — C25's "prove the check can fail").
//
// Public interface: none (CLI script; exit code 0 = pass).
// Dependencies: node built-ins only.
// State owned: none (reads files, prints, exits).

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

/******************************************************************************/
// CONFIG — every tunable in one place
/******************************************************************************/

// API namespace -> the manifest permission that gates it. Only namespaces
// that REQUIRE a permission belong here; namespaces usable without one
// (runtime, i18n, action, permissions, windows, extension, commands, ...)
// are deliberately absent — using them never needs a manifest entry.
// `tabs` is absent on purpose: basic tab APIs need no permission (only
// reading url/title/favIconUrl does, and <all_urls> host access already
// covers that here).
const NAMESPACE_TO_PERMISSION = Object.freeze({
    alarms:                  'alarms',
    bookmarks:               'bookmarks',
    browsingData:            'browsingData',
    contentSettings:         'contentSettings',
    contextMenus:            'contextMenus',
    cookies:                 'cookies',
    debugger:                'debugger',
    declarativeContent:      'declarativeContent',
    declarativeNetRequest:   'declarativeNetRequest',
    downloads:               'downloads',
    history:                 'history',
    identity:                'identity',
    idle:                    'idle',
    management:              'management',
    notifications:           'notifications',
    offscreen:               'offscreen',
    pageCapture:             'pageCapture',
    power:                   'power',
    privacy:                 'privacy',
    proxy:                   'proxy',
    scripting:               'scripting',
    search:                  'search',
    sessions:                'sessions',
    sidePanel:               'sidePanel',
    storage:                 'storage',
    tabCapture:              'tabCapture',
    tabGroups:               'tabGroups',
    topSites:                'topSites',
    tts:                     'tts',
    webNavigation:           'webNavigation',
    webRequest:              'webRequest',
});

// A permission may also be satisfied by a sibling permission. Only one
// such pair is relevant here: declarativeNetRequestWithHostAccess grants
// the same namespace (C19's table lists it as the warning-free variant).
const PERMISSION_ALIASES = Object.freeze({
    declarativeNetRequest: [ 'declarativeNetRequestWithHostAccess' ],
});

// Declared permissions that have no API namespace to detect. Each is
// classified explicitly so check 3 (unknown permission) stays meaningful.
const NO_NAMESPACE_PERMISSIONS = Object.freeze(new Set([
    'activeTab',
    'unlimitedStorage',
    'clipboardWrite',
    'clipboardRead',
    'declarativeNetRequestWithHostAccess',   // covered via PERMISSION_ALIASES
    'nativeMessaging',
    'geolocation',
]));

// Declared permissions deliberately kept although the scan finds no code
// use. Empty on purpose; add `permission: 'reason'` only with a real one.
const DECLARED_WITHOUT_CODE_USE_ALLOWLIST = Object.freeze({});

// Permissions the Chrome Web Store build must never declare (C19).
const BANNED_MANIFEST_PERMISSIONS = Object.freeze({
    declarativeNetRequestFeedback:
        'a debugging permission for unpacked extensions (Chrome DNR reference); banned by project policy (C19)',
});

// Manifest keys uBD must not declare (C31): adding one is a decision to
// revisit in the principles doc first, not a side effect of an edit.
const BANNED_MANIFEST_KEYS = Object.freeze({
    message_serialization:
        'uBD stays in JSON messaging mode on purpose (C31): JSON is the narrowest format at the boundary ' +
        'pages can reach; structured clone admits many more value types every handler would have to validate',
});

// DNR match-feedback APIs banned by project policy (C19): two are
// unpacked-only, getMatchedRules needs the feedback permission or a
// per-tab activeTab grant. Matched as whole words in comment-stripped code.
const BANNED_API_NAMES = Object.freeze([
    'onRuleMatchedDebug',
    'testMatchOutcome',
    'getMatchedRules',
]);

// What "shipped code" means for the scan: every .js file in the working
// tree except these (build tooling, installed deps, build side-output).
const SKIP_DIRECTORIES = Object.freeze(new Set([
    'node_modules', 'tools', '.git', 'dist', 'test-fixtures', 'coverage',
]));

/******************************************************************************/
// Scan
/******************************************************************************/

// The three literal roots this codebase reaches the WebExtension API
// through: `browser` and `chrome` directly, and `webext` — the normalised
// root js/data/ext-compat.js builds (`webext.declarativeNetRequest` is how
// the whole `dnr` shim reaches that namespace; without this root the
// check reported declarativeNetRequest as unused on its first run).
const API_ROOTS = Object.freeze([ 'browser', 'chrome', 'webext' ]);
const ROOT_LITERAL_RE = new RegExp(`\\b(?:${API_ROOTS.join('|')})\\.([A-Za-z_$][A-Za-z0-9_$]*)`, 'g');

function stripComments(source) {
    // Block comments first, then whole-line and trailing `//` comments.
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function listShippedJsFiles(rootDir) {
    const out = [];
    for ( const entry of fs.readdirSync(rootDir, { withFileTypes: true }) ) {
        if ( SKIP_DIRECTORIES.has(entry.name) ) { continue; }
        const full = path.join(rootDir, entry.name);
        if ( entry.isDirectory() ) {
            out.push(...listShippedJsFiles(full));
        } else if ( entry.name.endsWith('.js') || entry.name.endsWith('.mjs') ) {
            out.push(full);
        }
    }
    return out;
}

// Returns { namespaceUses: Map<ns, Set<relPath>>, bannedApiUses: Map<name, Set<relPath>> }
function scanCode(rootDir) {
    const namespaceUses = new Map();
    const bannedApiUses = new Map();
    for ( const file of listShippedJsFiles(rootDir) ) {
        const rel = path.relative(rootDir, file);
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        for ( const m of code.matchAll(ROOT_LITERAL_RE) ) {
            const ns = m[1];
            if ( !namespaceUses.has(ns) ) { namespaceUses.set(ns, new Set()); }
            namespaceUses.get(ns).add(rel);
        }
        for ( const name of BANNED_API_NAMES ) {
            if ( new RegExp(`\\b${name}\\b`).test(code) ) {
                if ( !bannedApiUses.has(name) ) { bannedApiUses.set(name, new Set()); }
                bannedApiUses.get(name).add(rel);
            }
        }
    }
    return { namespaceUses, bannedApiUses };
}

/******************************************************************************/
// Checks
/******************************************************************************/

function declaredPermissionSet(manifest) {
    return new Set([
        ...(manifest.permissions ?? []),
        ...(manifest.optional_permissions ?? []),
    ]);
}

function isPermissionSatisfied(namespace, declared) {
    const needed = NAMESPACE_TO_PERMISSION[namespace];
    if ( declared.has(needed) ) { return true; }
    return (PERMISSION_ALIASES[namespace] ?? []).some(alias => declared.has(alias));
}

function findProblems(manifest, scan) {
    const problems = [];
    const declared = declaredPermissionSet(manifest);

    // 1. used but not declared
    for ( const [ ns, files ] of scan.namespaceUses ) {
        if ( !(ns in NAMESPACE_TO_PERMISSION) ) { continue; }
        if ( isPermissionSatisfied(ns, declared) ) { continue; }
        problems.push(
            `USED BUT NOT DECLARED: code calls browser/chrome.${ns} but manifest.json declares no ` +
            `"${NAMESPACE_TO_PERMISSION[ns]}" permission (used in ${[ ...files ].slice(0, 3).join(', ')}` +
            `${files.size > 3 ? `, +${files.size - 3} more` : ''}). ` +
            'The extension can fail to start at all (real incident, 8.6.0).'
        );
    }

    // 2 + 3. declared but unused / unknown
    for ( const perm of declared ) {
        if ( perm in BANNED_MANIFEST_PERMISSIONS ) { continue; }   // reported by check 4
        const namespaces = Object.keys(NAMESPACE_TO_PERMISSION).filter(ns =>
            NAMESPACE_TO_PERMISSION[ns] === perm || (PERMISSION_ALIASES[ns] ?? []).includes(perm));
        if ( namespaces.length === 0 ) {
            if ( NO_NAMESPACE_PERMISSIONS.has(perm) ) { continue; }
            problems.push(
                `UNKNOWN PERMISSION: "${perm}" is declared in manifest.json but this check has no rule for it — ` +
                'add it to NAMESPACE_TO_PERMISSION or NO_NAMESPACE_PERMISSIONS (with the reasoning) so it is classified on purpose.'
            );
            continue;
        }
        if ( perm in DECLARED_WITHOUT_CODE_USE_ALLOWLIST ) { continue; }
        if ( !namespaces.some(ns => scan.namespaceUses.has(ns)) ) {
            problems.push(
                `DECLARED BUT NEVER USED: manifest.json declares "${perm}" but no shipped code calls ` +
                `browser/chrome.${namespaces.join(' / ')}. Remove it (store-review risk, wider install warning) ` +
                'or allowlist it here with a reason.'
            );
        }
    }

    // 4. C19 store bans
    for ( const [ perm, why ] of Object.entries(BANNED_MANIFEST_PERMISSIONS) ) {
        if ( declared.has(perm) ) {
            problems.push(`BANNED PERMISSION: manifest.json declares "${perm}" — ${why}.`);
        }
    }
    for ( const [ name, files ] of scan.bannedApiUses ) {
        problems.push(
            `BANNED API: non-comment code references ${name} (DNR match feedback — unpacked-only or per-tab activeTab; banned by C19 policy) in ${[ ...files ].join(', ')}.`
        );
    }

    // 5. C31 JSON mode pinned
    for ( const [ key, why ] of Object.entries(BANNED_MANIFEST_KEYS) ) {
        if ( Object.hasOwn(manifest, key) ) {
            problems.push(`BANNED MANIFEST KEY: manifest.json declares "${key}" — ${why}.`);
        }
    }
    return problems;
}

/******************************************************************************/
// Main
/******************************************************************************/

function main() {
    const { values } = parseArgs({ options: { root: { type: 'string' } } });
    const rootDir = path.resolve(values.root ?? path.join(import.meta.dirname, '..'));

    console.log('=== C19: manifest permissions <-> browser.* API usage ===');
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
    const scan = scanCode(rootDir);
    const declared = declaredPermissionSet(manifest);
    console.log(
        `Declared permissions (${declared.size}): ${[ ...declared ].sort().join(', ')}\n` +
        `Namespaces used in shipped code that need a permission: ` +
        `${[ ...scan.namespaceUses.keys() ].filter(ns => ns in NAMESPACE_TO_PERMISSION).sort().join(', ')}`
    );

    const problems = findProblems(manifest, scan);
    if ( problems.length !== 0 ) {
        console.log('');
        for ( const p of problems ) { console.error(`FAIL: ${p}`); }
        console.error(`\n${problems.length} problem(s) found.`);
        process.exit(1);
    }
    console.log('\nPASS: every used permission-gated API is declared, every declared permission is used, and no C19-banned permission/API or C31-banned manifest key is present.');
}

main();
