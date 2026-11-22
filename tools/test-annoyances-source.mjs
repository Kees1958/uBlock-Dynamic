// tools/test-annoyances-source.mjs — proves gateAnnoyanceLines() (tools/build/annoyances-sources.mjs)
// applies exactly the gates the "AdGuard and EasyList annoyances" list is specified to have.
// Drives the REAL exported function with synthetic input (no network) — never a re-implementation
// (Part D, step 15). Exit 0 only if every case passes.
import assert from 'assert';
import { gateAnnoyanceLines, siteRuleCategory, ANNOYANCE_SOURCES } from './build/annoyances-sources.mjs';
import { topAdultSiteDomains } from './build/adult-site-rules.mjs';

// Synthetic CrUX top-1M set: two generic-TLD sites, one in-scope country-code site.
const TOP = new Set([ 'popular.com', 'shop.org', 'nachrichten.de', 'sport.ru' ]);
function gate(lines, categoryFilter = false) { return gateAnnoyanceLines(lines, { topSites: TOP, categoryFilter }); }

let failures = 0;
function check(label, fn) {
    try { fn(); console.log(`  PASS: ${label}`); }
    catch ( err ) { failures++; console.log(`  FAIL: ${label} — ${err.message}`); }
}

console.log('=== annoyances gate (tools/build/annoyances-sources.mjs) ===');

// ── per-site rules ──
check('generic TLD site in the top-1M is kept', () => {
    assert.deepStrictEqual(gate([ 'popular.com###newsletter-popup' ]), [ 'popular.com###newsletter-popup' ]);
});
check('generic TLD site NOT in the top-1M is dropped', () => {
    assert.deepStrictEqual(gate([ 'unknown-blog.com###newsletter-popup' ]), []);
});
check('country-code TLD in scope AND in the top-1M is kept (top-1M applies to every TLD)', () => {
    assert.deepStrictEqual(gate([ 'nachrichten.de##.signup' ]), [ 'nachrichten.de##.signup' ]);
});
check('country-code TLD in scope but NOT in the top-1M is dropped', () => {
    assert.deepStrictEqual(gate([ 'kleine-seite.de##.signup' ]), []);
});
check('geographic scope (10.4.5): an out-of-scope TLD is dropped even when the site is in the top-1M', () => {
    assert.deepStrictEqual(gate([ 'sport.ru##.subscribe' ]), [ ]);
});
check('a subdomain of a top-1M site counts as that site', () => {
    assert.deepStrictEqual(gate([ 'blog.popular.com##.subscribe' ]), [ 'blog.popular.com##.subscribe' ]);
});
check('a multi-site rule is expanded to one line per PASSING site (others dropped, ~negated dropped)', () => {
    assert.deepStrictEqual(
        gate([ 'popular.com,unknown.com,shop.org,~sub.popular.com###newsletter' ]),
        [ 'popular.com###newsletter', 'shop.org###newsletter' ]
    );
});
check('scriptlet (#%#) and hide-exception (#@#) rules are kept', () => {
    assert.deepStrictEqual(
        gate([ "popular.com#%#//scriptlet('set-cookie', 'x', '1')", 'shop.org#@#.keep-me' ]),
        [ "popular.com#%#//scriptlet('set-cookie', 'x', '1')", 'shop.org#@#.keep-me' ]
    );
});
check('rule shapes the pipeline skips anyway are not carried (#?#, #$#, $$, generic, comments)', () => {
    assert.deepStrictEqual(gate([
        'popular.com#?#div:has-text(Subscribe)',
        'popular.com#$#div { display: none }',
        'popular.com$$div[class="x"]',
        '###generic-no-site',
        '! a comment',
        '[Adblock Plus 2.0]',
        '',
    ]), []);
});

// ── network rules ──
check('host-anchored network rule with an in-scope TLD is kept WITHOUT a top-1M requirement', () => {
    assert.deepStrictEqual(gate([ '||push.vendor-example.com^$third-party' ]), [ '||push.vendor-example.com^$third-party' ]);
});
check('geographic scope (10.4.5): a network rule on an out-of-scope TLD is dropped', () => {
    assert.deepStrictEqual(gate([ '||push.vendor-example.ru^' ]), [ ]);
});
check('network rule with a wildcard host is dropped (cannot be suppressed outside a Worry-free session)', () => {
    assert.deepStrictEqual(gate([ '||link*.example.com/join/' ]), []);
});
check('path-only network rule (no host anchor) is dropped', () => {
    assert.deepStrictEqual(gate([ '/OneSignalSDKWorker.js', '/larapush_script_' ]), []);
});
check('a `*` or `|` after the host makes it unsuppressible and is dropped (real case from the first build)', () => {
    assert.deepStrictEqual(gate([ '||ryobitools.eu|*/NewsletterPopup-', '||a.example.com|/x' ]), []);
});
check('`^` followed by more pattern is dropped — it compiles to `|` mid-pattern (real case: ||ryobitools.eu^*/NewsletterPopup-)', () => {
    assert.deepStrictEqual(gate([ '||ryobitools.eu^*/NewsletterPopup-$script', '||push.example.com^/join' ]), []);
});
check('`||host^`, `||host^$options`, `||host/path^` and `||host?x` are kept (their compiled host is clean)', () => {
    const kept = [ '||a.example.com^', '||b.example.com^$third-party', '||c.example.com/push^', '||d.example.com?x=1' ];
    assert.deepStrictEqual(gate(kept), kept);
});
check('a host followed directly by $options is kept; a :port host is dropped', () => {
    assert.deepStrictEqual(gate([ '||push.vendor-example.com$third-party', '||push.vendor-example.com:8080/x' ]), [ '||push.vendor-example.com$third-party' ]);
});
check('host + path network rule is kept (host is still literal)', () => {
    assert.deepStrictEqual(gate([ '||voltmail.io/static/js/push-embed.ts$third-party' ]), [ '||voltmail.io/static/js/push-embed.ts$third-party' ]);
});

// ── category filter (only the AdGuard popups_specific list) ──
check('category filter keeps a newsletter rule and drops an unclassifiable one', () => {
    assert.deepStrictEqual(
        gate([ 'popular.com###newsletter-popup', 'popular.com###some-random-widget' ], true),
        [ 'popular.com###newsletter-popup' ]
    );
});
check('category filter drops "Sign in with Google", app-install and generic-modal rules', () => {
    assert.deepStrictEqual(gate([
        'popular.com###credential_picker_container',
        'popular.com##.app-banner',
        'popular.com##.some-modal-wrapper',
    ], true), []);
});
check('category filter drops network rules', () => {
    assert.deepStrictEqual(gate([ '||push.vendor-example.com^' ], true), []);
});
check('siteRuleCategory: first match wins (a cookie rule that says "popup" is a cookie rule)', () => {
    assert.strictEqual(siteRuleCategory("//scriptlet('set-cookie', 'close-popup', '1')"), 'cookie');
});

// ── guards ──
check('empty top-1M set throws instead of silently dropping every site rule', () => {
    assert.throws(() => gateAnnoyanceLines([ 'popular.com##.x' ], { topSites: new Set(), categoryFilter: false }), /top-1M/);
});
check('exactly six sources, exactly one of them category-filtered (popups_specific)', () => {
    assert.strictEqual(ANNOYANCE_SOURCES.length, 6);
    assert.deepStrictEqual(ANNOYANCE_SOURCES.filter(s => s.categoryFilter).map(s => s.name), [ 'AdGuard popups_specific' ]);
});

console.log(failures === 0 ? '\nPASS: annoyances gate behaves as specified.' : `\n${failures} annoyances-gate check(s) FAILED.`);
// ── top-25 adult sites (10.5.1, tools/build/adult-site-rules.mjs) ──
console.log('=== top-25 adult sites ===');
check('the site list is the single source adult-sites.mjs (25 sites, sorted)', () => {
    const sites = topAdultSiteDomains();
    assert.strictEqual(sites.length, 25);
    assert.deepStrictEqual(sites, [ ...sites ].sort());
});

process.exit(failures === 0 ? 0 : 1);
