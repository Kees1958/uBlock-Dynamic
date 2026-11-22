// check-whitelist-levels.mjs — the ONE whitelist has two levels (10.2.0, js/data/matrix-constants.js
// "Whitelist levels"): WHITE (BUILTIN_DOMAINS — owner-published only, fully trusted) and GREY (GREY_DOMAINS —
// anyone can publish, never trusted). This check keeps that split honest:
//   1. no domain is in two of WHITE / GREY / SIGNAL;
//   2. no WHITE entry is a host where anyone can publish (USER_CONTENT_HOSTS below — a maintained list of such
//      platforms) or a parent of one — such a host belongs in GREY_DOMAINS, where the filter lists and every
//      protection keep applying to it (B11 trust-boundary rule; owner's decision, 10.2.0);
//   3. every WHITE entry is a Worry-free exemption and no GREY entry is (one treatment per level);
//   4. no WHITE or GREY entry is a whole-domain googleapis.com (too broad — fine-grained hosts only).
// Pure: imports the data modules, keeps nothing between runs — nothing to initialise, clear or release.
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── Configuration (the only place these live) ───────────────────────────────
// Platforms where ANYONE can publish files or code. Add a platform here when it is discovered; a WHITE entry that
// equals, is a subdomain of, or is a parent of one of these fails the check until it is moved to GREY_DOMAINS.
// Deliberately broader than GREY_DOMAINS: most of these are not on the whitelist at all and must stay off WHITE.
const USER_CONTENT_HOSTS = Object.freeze([
    'jsdelivr.net', 'unpkg.com', 'esm.sh', 'registry.npmjs.org', 'cdn.skypack.dev', 'jspm.io', 'statically.io',
    'githack.com', 'raw.githubusercontent.com', 'githubusercontent.com', 'github.io', 'gitlab.io', 'bitbucket.io',
    'storage.googleapis.com', 'firebasestorage.googleapis.com', 'googleusercontent.com', 'firebaseapp.com', 'web.app',
    'appspot.com', 'sites.google.com', 's3.amazonaws.com', 'amplifyapp.com', 'cloudfront.net',
    'blob.core.windows.net', 'web.core.windows.net', 'azurewebsites.net', 'azurestaticapps.net',
    'r2.dev', 'workers.dev', 'pages.dev', 'netlify.app', 'vercel.app', 'herokuapp.com', 'glitch.me', 'replit.dev',
    'repl.co', 'onrender.com', 'fly.dev', 'backblazeb2.com', 'codepen.io', 'jsfiddle.net', 'codesandbox.io',
    'ngrok.io', 'ngrok-free.app', 'trycloudflare.com',
]);
// A whole-domain entry for this suffix is always too broad (owner's decision, 10.2.0: fine-grained hosts only).
const FORBIDDEN_WHOLE_DOMAINS = Object.freeze([ 'googleapis.com' ]);

// ── Helpers ─────────────────────────────────────────────────────────────────
function related(a, b) {
    return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

let ok = true;
function check(label, pass, detail = '') {
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
    if ( !pass ) { ok = false; }
}

// ── Main ────────────────────────────────────────────────────────────────────
console.log('=== Whitelist levels (WHITE / GREY) ===');
function imp(rel) { return import(pathToFileURL(path.join(ROOT, rel)).href); }
const matrix  = await imp('js/data/matrix-constants.js');
const trusted = await imp('js/data/trusted-service-domains.js');

const white  = Object.keys(matrix.BUILTIN_DOMAINS);
const grey   = Object.keys(matrix.GREY_DOMAINS);
const signal = Object.keys(matrix.SIGNAL_DOMAINS);

check('levels enum is exactly { WHITE, GREY }',
    JSON.stringify(matrix.WHITELIST_LEVEL) === JSON.stringify({ WHITE: 'white', GREY: 'grey' }));
check('GREY list is not empty', grey.length > 0, `${grey.length} domain(s)`);

const inTwo = [
    ...white.filter(d => grey.includes(d)).map(d => `${d} (WHITE+GREY)`),
    ...white.filter(d => signal.includes(d)).map(d => `${d} (WHITE+SIGNAL)`),
    ...grey.filter(d => signal.includes(d)).map(d => `${d} (GREY+SIGNAL)`),
];
check('no domain is in two levels', inTwo.length === 0, inTwo.join(', '));

const whiteUserContent = white.flatMap(w => USER_CONTENT_HOSTS.filter(u => related(w, u)).map(u => `${w} ~ ${u}`));
check('no WHITE entry is (or contains) a host where anyone can publish', whiteUserContent.length === 0,
    whiteUserContent.join(', ') + (whiteUserContent.length ? ' — move it to GREY_DOMAINS' : ''));

const trustedSet = new Set(trusted.TRUSTED_SERVICE_DOMAINS);
const whiteNotTrusted = white.filter(d => !trustedSet.has(d));
check('every WHITE entry is a Worry-free exemption (one treatment)', whiteNotTrusted.length === 0, whiteNotTrusted.join(', '));
const greyTrusted = grey.filter(d => trustedSet.has(d));
check('no GREY entry is a Worry-free exemption', greyTrusted.length === 0, greyTrusted.join(', '));

const tooBroad = [ ...white, ...grey ].filter(d => FORBIDDEN_WHOLE_DOMAINS.includes(d));
check('no whole-domain entry for a too-broad suffix (googleapis.com)', tooBroad.length === 0, tooBroad.join(', '));

const greyUnknown = grey.filter(g => !USER_CONTENT_HOSTS.some(u => related(g, u)));
check('every GREY entry is a known anyone-can-publish host', greyUnknown.length === 0,
    greyUnknown.join(', ') + (greyUnknown.length ? ' — add it to USER_CONTENT_HOSTS or remove it from GREY' : ''));

console.log(`${white.length} WHITE, ${grey.length} GREY, ${signal.length} SIGNAL.`);
console.log(ok ? 'PASS: whitelist levels are consistent.' : 'FAIL: see above.');
console.log('');
process.exitCode = ok ? 0 : 1;
