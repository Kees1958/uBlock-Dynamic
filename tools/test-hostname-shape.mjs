// ── test-hostname-shape.mjs ───────────────────────────────────────────────────
// Step 89 (11.0.2): every hostname check accepts underscores, like Chrome does; the Allow list accepts only site names.
//
// Why: Chrome loads hosts such as `my_site.example.com` or `lorenne_.wehype.app`.
// Before 11.0.2 our hostname checks refused them, so the element picker, Cookie
// consent clicker rules and custom scriptlets silently failed to save there.
// AdGuard fixed the same gap (tsurlfilter 6.1.0). This check drives the REAL
// exported checks, and scans js/ so a new hand-written hostname regex without
// '_' fails instead of bringing the gap back (C25).
//
// Dependencies: js/util/utils.js, js/util/site-mode-parser.js,
//               js/core/static-block-check.js (read as text), js/util/popunder-parser.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/******************************************************************************/
// Configuration — one place
/******************************************************************************/

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Hosts Chrome loads that must pass every check.
const UNDERSCORE_HOSTS = Object.freeze([ 'lorenne_.wehype.app', 'my_site.example.com', '_dmarc.example.com', 'a_b.c_d.com' ]);

// Malformed input that must still be refused by the strict check.
const MALFORMED_HOSTS = Object.freeze([ '', 'a..b', '.example.com', 'example.com.', 'exa mple.com', '-bad.com', 'bad-.com', 'EXAMPLE.com' ]);

// Modules that must take their hostname shape from the one shared PLAIN_HOSTNAME_RE (C21).
const SHARED_SHAPE_USERS = Object.freeze([
    'js/util/popunder-parser.js',
    'js/core/scripting-manager.js',
    'js/core/cmp-loader-block-manager.js',
]);

// A hand-written "label(.label)+" hostname class without '_' (the pre-11.0.2 shape).
const HOSTNAME_RE_WITHOUT_UNDERSCORE = /\[a-z0-9-\]\+\(\\\.\[a-z0-9-\]\+\)\+/;

/******************************************************************************/

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : ` — ${detail}`}`);
    if ( ok === false ) { failures += 1; }
}

function moduleUrl(rel) { return pathToFileURL(path.join(ROOT, rel)).href; }

function jsFiles(dir) {
    const out = [];
    for ( const entry of fs.readdirSync(dir, { withFileTypes: true }) ) {
        const full = path.join(dir, entry.name);
        if ( entry.isDirectory() ) { out.push(...jsFiles(full)); continue; }
        if ( entry.name.endsWith('.js') ) { out.push(full); }
    }
    return out;
}

console.log('=== Step 89: hostname checks accept underscores (11.0.2) ===');

const { isValidHostnamePattern, PLAIN_HOSTNAME_RE } = await import(moduleUrl('js/util/utils.js'));
const { extractOptionLinesFromText } = await import(moduleUrl('js/util/site-mode-parser.js'));
// static-block-check.js imports the extension API at load, so its exported regex is read from the source text.
const blockCheckSrc = fs.readFileSync(path.join(ROOT, 'js/core/static-block-check.js'), 'utf8');
const literal = /export const SIMPLE_DOMAIN_RULE = \/(.+)\/([a-z]*);/.exec(blockCheckSrc);
const SIMPLE_DOMAIN_RULE = literal === null ? /(?!)/ : new RegExp(literal[1], literal[2]);
check('SIMPLE_DOMAIN_RULE found in js/core/static-block-check.js', literal !== null);

const strictRefused = UNDERSCORE_HOSTS.filter(h => isValidHostnamePattern(h) === false);
check(`isValidHostnamePattern() accepts underscore hosts (${UNDERSCORE_HOSTS.length})`, strictRefused.length === 0, strictRefused.join(' | '));
const plainRefused = UNDERSCORE_HOSTS.filter(h => PLAIN_HOSTNAME_RE.test(h) === false);
check('PLAIN_HOSTNAME_RE accepts underscore hosts', plainRefused.length === 0, plainRefused.join(' | '));
const malformedPassed = MALFORMED_HOSTS.filter(h => isValidHostnamePattern(h));
check(`isValidHostnamePattern() still refuses malformed input (${MALFORMED_HOSTS.length})`, malformedPassed.length === 0, malformedPassed.join(' | '));

const optionText = UNDERSCORE_HOSTS.map(h => `@@${h}$worryfree`).join('\n');
const optionResult = extractOptionLinesFromText(optionText);
check('Allow-list option lines accept underscore hosts', JSON.stringify(optionResult).includes(UNDERSCORE_HOSTS[0]), JSON.stringify(optionResult).slice(0, 160));
const domainRuleMissed = UNDERSCORE_HOSTS.filter(h => SIMPLE_DOMAIN_RULE.exec(`||${h}^`)?.[1] !== h);
check('whole-domain user rules accept underscore hosts', domainRuleMissed.length === 0, domainRuleMissed.join(' | '));

for ( const rel of SHARED_SHAPE_USERS ) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    check(`${rel} uses the shared PLAIN_HOSTNAME_RE`, /import \{[^}]*PLAIN_HOSTNAME_RE[^}]*\} from/.test(src));
}

const stale = jsFiles(path.join(ROOT, 'js'))
    .filter(f => HOSTNAME_RE_WITHOUT_UNDERSCORE.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(ROOT, f));
check('no hand-written hostname regex without "_" left in js/', stale.length === 0, stale.join(' | '));

// (11.0.2, audit finding 5) The Allow list takes the site name out of a pasted web address and refuses non-sites.
const { siteModesFromText, hostnameFromAllowListLine } = await import(moduleUrl('js/util/site-mode-parser.js'));
const lineCases = [
    [ 'https://www.bbc.com/news', 'www.bbc.com' ], [ 'example.com/path?q=1', 'example.com' ], [ 'example.org:8080', 'example.org' ],
    [ 'café.com', 'xn--caf-dma.com' ], [ '*', '*' ], [ 'my_site.example.com', 'my_site.example.com' ],
    [ 'foo bar', '' ], [ '..', '' ], [ 'http://', '' ],
];
const wrongLines = lineCases.filter(([ line, want ]) => hostnameFromAllowListLine(line) !== want).map(([ line ]) => line);
check(`Allow list lines: pasted addresses become site names, non-sites are refused (${lineCases.length})`, wrongLines.length === 0, wrongLines.join(' | '));
const refusedLines = [];
const modes = siteModesFromText('https://www.bbc.com/news\nfoo bar\n# comment\n', refusedLines);
check('siteModesFromText() reports the refused lines (and not comments)', JSON.stringify(Object.keys(modes)) === '["www.bbc.com"]' && JSON.stringify(refusedLines) === '["foo bar"]', JSON.stringify({ modes, refusedLines }));
const editorSrc = fs.readFileSync(path.join(ROOT, 'js/ui/mode-editor.js'), 'utf8');
check('the Allow list editor tells the person which lines were not saved', /siteModesFromText\(remainingText, refusedLines\)/.test(editorSrc) && /refusedLinesMessage\(refusedLines\)/.test(editorSrc));
const wfSrc = fs.readFileSync(path.join(ROOT, 'js/core/worryfree-manager.js'), 'utf8');
check('Seamless exemption domains are checked before the one DNR update', /isValidHostnamePattern\(d\) === false/.test(wfSrc) && /punycode\.toASCII/.test(wfSrc));

console.log(failures === 0 ? '\nPASS' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
