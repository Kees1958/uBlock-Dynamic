// tools/test-network-translation.mjs — ONE network-filter parser (10.7.6), proven per fix (C42).
//
// The build (tools/build/rule-parsers.mjs parseBlockRule / parseRemoveparamRules) and the "Import ABP rules"
// editor (js/offscreen/compile-filters.js: normalizeAbpNetworkLine + AstFilterParser + parseNetworkFilter)
// translate network lines with the same parser. Each case below is one bug the old build parser or the old
// uBO translator had, written as the line that exposed it and the DNR result it must give now.
// Fault-verified: run against the 10.7.5 tree (`node tools/test-network-translation.mjs <old-root>`), the
// build cases fail.
//
// Usage: node tools/test-network-translation.mjs [extensionRoot]
// Outcomes (C38): PASS / FAIL / DID NOT RUN.
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));
// Request types the ABP import passes (any list works for these cases; the build uses its own list).
const RUNTIME_TYPES = [ 'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
    'xmlhttprequest', 'ping', 'media', 'websocket', 'other' ];

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
    if ( !ok ) { failures += 1; }
}
function show(v) { return JSON.stringify(v); }

// Build-side cases: line -> expected { urlFilter?, resourceTypes?, initiatorDomains?, action? } or null (dropped).
const BUILD_CASES = [
    [ 'separator "^" kept at the end (no over-match of ads.com.evil)', '||sovrn.com^$domain=site.com',
        { urlFilter: '||sovrn.com^', initiatorDomains: [ 'site.com' ] } ],
    [ 'separator "^" kept mid-pattern (rule can match again)', '@@||cnn.com^*/ad_policy.xml',
        { urlFilter: '||cnn.com^*/ad_policy.xml', action: 'allow' } ],
    [ 'end anchor "|" kept', '@@||pagead2.googlesyndication.com/pagead/js/adsbygoogle.js|$domain=x.com',
        { urlFilter: '||pagead2.googlesyndication.com/pagead/js/adsbygoogle.js|', action: 'allow' } ],
    [ 'removeparam in any option position is NOT a block', '/GetPlaybackResources?$xmlhttprequest,removeparam=deviceAdInsertionTypeOverride,domain=amazon.com',
        null, 'redirect' ],   // ABP import: a parameter-strip rule; the build ships it from parseRemoveparamRules()
    [ 'bare token is a substring, not a host (ABP meaning)', 'promo-pc.jpg$domain=download.cnet.com',
        { urlFilter: 'promo-pc.jpg', initiatorDomains: [ 'download.cnet.com' ] } ],
    [ '"||host*" is a prefix, not an exact host', '||buzzer.xhamster*', { urlFilter: '||buzzer.xhamster' } ],
    [ '"$~script" does not block page loads', '||x.com^$~script',
        { urlFilter: '||x.com^', resourceTypes: [ 'sub_frame', 'stylesheet', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other' ] } ],
    [ 'named types minus excluded types', '||pornpics.com^$subdocument,~xmlhttprequest',
        { urlFilter: '||pornpics.com^', resourceTypes: [ 'sub_frame' ] } ],
    [ '"$doc" alias translated (scam-page block)', '||replicapatekphilippe.com^$doc',
        { urlFilter: '||replicapatekphilippe.com^', resourceTypes: [ 'main_frame' ] } ],
    [ '"@@…$important" kept as an allow', '@@||bing.com/search?showselans=$document,subdocument,important',
        { urlFilter: '||bing.com/search?showselans=', action: 'allow', resourceTypes: [ 'main_frame', 'sub_frame' ] } ],
    [ '"@@…$csp" is not an allow of everything', '@@||uptostream.com^$csp=worker-src \'none\'', null ],
    [ 'unknown option drops the line (no junk urlFilter)', '89.127.233.127$network', null ],
    [ '"$removeheader" drops the line (was a block)', '||x.com^$removeheader=refresh', null ],
    [ '"$requestheader" drops the line (was a block)', '||x.com^$requestheader=via:1', null ],
    [ 'page-only option still drops the line (10.7.3)', '@@||bing.com^$generichide', null ],
    [ '$popup still drops the line (9.2.8)', '||ads.com^$popup', null ],
    // Phase 3 (10.7.6, owner: "translate network correctly when possible", redirects "B. Translate")
    [ 'regex pattern translated (Chrome verdict applied later, regex-support.mjs)', '/ads[0-9]+\\.js/$script',
        { regexFilter: 'ads[0-9]+\\.js', resourceTypes: [ 'script' ], isUrlFilterCaseSensitive: false } ],
    [ 'regex $match-case is case-sensitive', '/Ads/$match-case', { regexFilter: 'Ads', isUrlFilterCaseSensitive: true } ],
    [ 'plain $match-case (no upper case) is case-sensitive', '||x.com/ad.js$match-case',
        { urlFilter: '||x.com/ad.js', isUrlFilterCaseSensitive: true } ],
    [ 'plain $match-case WITH upper case is dropped (the parser lower-cases)', '||x.com/Ad.js$match-case', null ],
    [ '$redirect to a bundled file becomes a redirect', '||npttech.com^$script,redirect=noopjs',
        { urlFilter: '||npttech.com^', action: 'redirect', extensionPath: '/web_accessible_resources/noop.js' } ],
    [ '$redirect to the bundled Optimizely surrogate (11.0.4)', '||cdn.optimizely.com/js/*.js$script,redirect=optimizely.js',
        { urlFilter: '||cdn.optimizely.com/js/*.js', action: 'redirect', extensionPath: '/web_accessible_resources/optimizely.js' } ],
    [ '$redirect to the bundled IMA SDK surrogate, AdGuard name (11.1.4)', '||imasdk.googleapis.com/js/sdkloader/ima3.js$redirect=google-ima3,domain=bbc.com,important',
        { urlFilter: '||imasdk.googleapis.com/js/sdkloader/ima3.js', action: 'redirect', extensionPath: '/web_accessible_resources/google-ima.js', initiatorDomains: [ 'bbc.com' ] } ],
    [ '$redirect to the bundled IMA SDK surrogate, uBO name (11.1.4)', '||imasdk.googleapis.com/js/sdkloader/ima3.js$script,redirect=google-ima.js',
        { urlFilter: '||imasdk.googleapis.com/js/sdkloader/ima3.js', action: 'redirect', extensionPath: '/web_accessible_resources/google-ima.js' } ],
    [ '$redirect to a file we do not bundle drops the line','||x.com^$script,redirect=googletagmanager_gtm.js', null ],
    [ '$denyallow with sites: block all but the listed hosts', '*$script,3p,denyallow=a.com|b.com,domain=c.com',
        { excludedRequestDomains: [ 'a.com', 'b.com' ], initiatorDomains: [ 'c.com' ], domainType: 'thirdParty' } ],
    [ '$to= target hosts kept next to the pattern', '/ads/*$to=a.com|b.com', { urlFilter: '/ads/', requestDomains: [ 'a.com', 'b.com' ] } ],
    [ '$method translated', '||x.com^$xhr,method=post', { urlFilter: '||x.com^', requestMethods: [ 'post' ] } ],
    [ '$important block is raised one step above its list (beats the list\'s @@)', '||ads.com^$important',
        { urlFilter: '||ads.com^', priority: 'important' } ],
    [ 'a plain block keeps its list priority', '||ads.com^', { urlFilter: '||ads.com^', priority: 'list' } ],
    [ '$important redirect is raised too', '||npttech.com^$script,redirect=noopjs,important',
        { urlFilter: '||npttech.com^', action: 'redirect', priority: 'important' } ],
    [ 'a rule with sites but no URL target is still dropped (C13c)', '$script,domain=c.com', null, 'block' ],   // ABP import: the person's own rule, kept
];

// Expected keys compared field by field (arrays order-insensitive); "action"/"extensionPath" are checked apart.
const CONDITION_FIELDS = [ 'urlFilter', 'regexFilter', 'isUrlFilterCaseSensitive', 'requestDomains', 'excludedRequestDomains',
    'requestMethods', 'initiatorDomains', 'resourceTypes', 'domainType' ];
function sameValue(a, b) {
    return Array.isArray(b) ? show([ ...(a ?? []) ].sort()) === show([ ...b ].sort()) : a === b;
}

// Removeparam cases (parseRemoveparamRules): line -> expected removeParams + scope, or null.
const REMOVEPARAM_CASES = [
    [ 'removeparam keeps its sites and pattern', '/GetPlaybackResources?$xmlhttprequest,removeparam=deviceAdInsertionTypeOverride,domain=amazon.com',
        { removeParams: [ 'deviceAdInsertionTypeOverride' ], initiatorDomains: [ 'amazon.com' ] } ],
    [ 'a removeparam exception is skipped (would allow the whole request)', '@@||x.com^$removeparam=utm_source', null ],
];

try {
    globalThis.self = globalThis;
    function imp(p) { return import(pathToFileURL(path.join(ROOT, p)).href); }
    const { parseBlockRule, parseRemoveparamRules } = await imp('tools/build/rule-parsers.mjs');
    const sfp = await imp('js/core/static-filtering-parser.js');
    const uboParser = await imp('js/core/ubo-parser.js');
    const budgets = await imp('js/core/dnr-budgets.js');
    const PRIORITY_OF = {
        list: budgets.STATIC_FILTER_LIST_PRIORITY,
        important: budgets.STATIC_FILTER_LIST_PRIORITY + (budgets.STATIC_IMPORTANT_PRIORITY_OFFSET ?? NaN),
    };

    for ( const [ label, line, expected ] of BUILD_CASES ) {
        const r = parseBlockRule(line, 1);
        if ( expected === null ) { check(`build: ${label}`, r === null, show(r)); continue; }
        const c = r?.condition ?? {};
        const ok = r !== null
            && c.urlFilter === expected.urlFilter   // also when absent: a target-less rule must not invent one
            && (expected.action ?? 'block') === r.action?.type
            && (expected.extensionPath === undefined || r.action?.redirect?.extensionPath === expected.extensionPath)
            && (expected.priority === undefined || r.priority === PRIORITY_OF[expected.priority])
            && CONDITION_FIELDS.every(f => expected[f] === undefined || sameValue(c[f], expected[f]));
        check(`build: ${label}`, ok, `${line} -> ${show(r)}`);
    }
    for ( const [ label, line, expected ] of REMOVEPARAM_CASES ) {
        const rules = parseRemoveparamRules(line, 1);
        if ( expected === null ) { check(`build: ${label}`, rules.length === 0, show(rules)); continue; }
        const r = rules[0];
        const ok = rules.length === 1
            && show(r.action?.redirect?.transform?.queryTransform?.removeParams) === show(expected.removeParams)
            && show(r.condition?.initiatorDomains) === show(expected.initiatorDomains);
        check(`build: ${label}`, ok, `${line} -> ${show(rules)}`);
    }

    // Coalescing (list-parser.mjs) must not fold a "$important" host block into the list-priority domain list.
    const { parseList } = await imp('tools/build/list-parser.mjs');
    const listed = parseList('||plain-a.com^\n||plain-b.com^\n||important-c.com^$important', PRIORITY_OF.list, { listName: 'test' }).dnrRules;
    const importantRule = listed.find(r => r.condition.urlFilter === '||important-c.com^' || r.condition.requestDomains?.includes('important-c.com'));
    check('build: a $important host block is not coalesced into the plain domain list',
        importantRule?.priority === PRIORITY_OF.important && importantRule.condition.requestDomains === undefined, show(listed));

    // ABP import: the same parser must agree with the build on what is a rule and what is dropped.
    const normalize = uboParser.normalizeAbpNetworkLine ?? (l => l);
    const parser = new sfp.AstFilterParser({ localSource: true, nativeCssHas: true, trustedSource: true });
    for ( const [ label, line, expected, abpAction ] of BUILD_CASES ) {
        parser.parse(normalize(line));
        const r = parser.hasError() ? undefined : uboParser.parseNetworkFilter(parser, { resourceTypes: RUNTIME_TYPES });
        const wanted = abpAction ?? (expected === null ? undefined : (expected.action ?? 'block'));
        const agrees = wanted === undefined ? r === undefined : r?.action?.type === wanted;
        check(`ABP import: ${label}`, agrees, `${line} -> ${show(r)}`);
    }
    // validateRules() (ABP import): an entity site ("site.*") is removed from ITS OWN list, never moved into requestDomains.
    const validated = uboParser.validateRules([ { action: { type: 'block' }, condition: { urlFilter: '/ad.js', initiatorDomains: [ 'a.com', 'site.*' ] } } ]);
    check('ABP import: entity site dropped from its own list (dropEntities)',
        validated.length === 1 && show(validated[0].condition.initiatorDomains) === show([ 'a.com' ]) && validated[0].condition.requestDomains === undefined,
        show(validated));
} catch (err) {
    console.log(`DID NOT RUN: ${err.stack ?? err}`);
    failures += 1;
}

if ( failures > 0 ) {
    console.log(`\n${failures} assertion(s) FAILED.`);
    process.exit(1);
}
console.log('\nPASS: one parser — the build and the ABP import translate every case the same, each fix holds.');
