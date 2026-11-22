// ── tools/build/cookie-notice-sources.mjs ─────────────────────────────────────────────
// (11.0.0, owner's decisions 2026-11-19) Seamless surfing's site-specific cookie-notice sets — see
// js/data/cookie-notice-sets.js for what they are and how the runtime uses them. This module downloads the three
// sources, gates them, and splits them into an ACCEPT and a DECLINE set, in the owner's order:
//
//   Stage 1 — AdGuard Cookie Notices (cookies_specific). Its answering scriptlets (clicks, consent cookies/storage) are
//             sorted into accept / decline / neutral; its hide and block rules are decline-only. The sites it ships per
//             mode are the stage-1 domain set (an exact Set — the "bloom filter" of the owner's plan, exact because it
//             only exists at build time).
//   Stage 2 — EasyList Cookie uBO (easylist_cookie_specific_uBO). Sites in the stage-1 set of that mode are skipped;
//             the rest is sorted the same way.
//   Stage 3 — EasyList Cookie specific hide + specific block. Decline-only; sites in the stage-1 DECLINE set skipped.
//
// Safety rules (owner's decisions), applied per SITE to stages 1 and 2 — a site keeps its scriptlets only when ALL of
// its answering rules pass:
//   - a rule for a CMP uBD's own click bundle already answers (rules.json, a real click action) drops the site:
//     never two mechanisms answering one dialog. Sourcepoint (iframe, loader block) and the hide-only CMPs are not
//     "covered", so their rules stay;
//   - an UNCLEAR rule (accept or decline cannot be told from its selector or cookie) drops the site;
//   - reload scriptlets (set-cookie-reload, trusted-set-cookie-reload) are never carried — a reload loop risk;
//   - a non-trusted set-cookie / storage value that AdGuard's own scriptlet refuses is never carried (dead weight);
//   - js/data/scriptlet-policy.js rules A–D (trusted names only from AdGuard sources, no code, no external URLs).
// Gates (same as the annoyances list): a site rule only for an in-scope TLD AND a CrUX top-1M site.
//
// Public interface:
//   COOKIE_NOTICE_SOURCES                — the four upstream files, declared once
//   classifyAnswer(name, args)           — 'accept' | 'decline' | 'neutral' | 'unclear' | null (not an answering rule)
//   coveredCmpOf(name, args, solidCmps)  — the name of a CMP uBD's bundle answers that this rule targets, or null
//   buildCookieNoticeSets(opts)          — the whole pipeline (memoised per build run); returns per mode (decline, accept,
//                                          prefer-accept) the scriptlet table, and for decline / prefer-accept the hide
//                                          table and block rules; plus the used library names, the full corelibs and a report
//   resetCookieNoticeCache()             — clear the memo (stepInit, like resetEasylistCookieCache)
//
// Dependencies: fetch-helpers.mjs (fetchList), annoyances-sources.mjs (gateAnnoyanceLines — the shared site gate),
//   scriptlet-rules.mjs (parseScriptletRules), ubo-scriptlet-syntax.mjs, rule-parsers.mjs (parseBlockRule),
//   crux-top-sites.mjs, tld-scope.mjs, scriptlet-corelibs.mjs (fetchCorelibsFromNpm), js/data/scriptlet-policy.js,
//   js/util/css-selector-guard.js, vendor/autoconsent/rules/rules.json (the CMPs the bundle answers).
// State owned: one memo promise per build run (resetCookieNoticeCache() clears it). Everything else is pure.

import fs from 'fs/promises';
import path from 'path';
import { ROOT } from './build-paths.mjs';
import { fetchList } from './fetch-helpers.mjs';
import { gateAnnoyanceLines } from './annoyances-sources.mjs';
import { parseScriptletRules } from './scriptlet-rules.mjs';
import { convertUboScriptletSyntax } from './ubo-scriptlet-syntax.mjs';
import { parseBlockRule } from './rule-parsers.mjs';
import { isPopularHostname } from './crux-top-sites.mjs';
import { isTLDKept } from './tld-scope.mjs';
import { fetchCorelibsFromNpm } from './scriptlet-corelibs.mjs';
import { isTrustedScriptletSource, requiresTrust, scriptletViolationAnySource } from '../../js/data/scriptlet-policy.js';
import { isSafePickedSelector } from '../../js/util/css-selector-guard.js';
import { COOKIE_NOTICE_BLOCK_PRIORITY, COOKIE_NOTICE_BLOCK_RULES_MAX } from '../../js/core/dnr-budgets.js';

/******************************************************************************/
// Settings — the ONLY place these values live.
/******************************************************************************/

const ADGUARD_COOKIES_BASE = 'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/AnnoyancesFilter/Cookies/sections/';
const EASYLIST_COOKIE_BASE = 'https://raw.githubusercontent.com/easylist/easylist/master/easylist_cookie/';
export const COOKIE_NOTICE_SOURCES = Object.freeze({
    adguard:       { name: 'AdGuard Cookie Notices (cookies_specific)',      url: `${ADGUARD_COOKIES_BASE}cookies_specific.txt` },
    easylistUbo:   { name: 'EasyList Cookie uBO (specific_uBO)',             url: `${EASYLIST_COOKIE_BASE}easylist_cookie_specific_uBO.txt` },
    easylistHide:  { name: 'EasyList Cookie specific hide',                  url: `${EASYLIST_COOKIE_BASE}easylist_cookie_specific_hide.txt` },
    easylistBlock: { name: 'EasyList Cookie specific block',                 url: `${EASYLIST_COOKIE_BASE}easylist_cookie_specific_block.txt` },
});

const MODES = Object.freeze({ DECLINE: 'decline', ACCEPT: 'accept' });
// (11.0.0) The third Seamless surfing mode, "accept, else decline": per site its accept rules when it has any, otherwise
// its decline rules. The decline HIDE rules apply on every site: a site's accept rule may answer a different dialog than
// the one it shows (bbc.com: the accept rule sets BBC's own cvcConsentGiven, the dialog shown is Google Funding Choices),
// and a dialog no accept rule answered must still go. The decline BLOCK rules only on sites without accept rules:
// blocking a CMP loader would stop the accept rule from ever answering. Built here, not at run time (excluding ~1,700
// accept sites from 800+ session rules at every registration pass would be the costly way).
const PREFER_ACCEPT = 'prefer-accept';

// Scriptlets that ANSWER a cookie notice: a click, or writing the consent cookie / storage item. Everything else on the
// site (remove-class, set-constant, abort-*) is a HELPER: it ships with the site's answering rules in that mode.
const CLICK_SCRIPTLET_RE = /^(trusted-)?click-element$/;
const VALUE_SCRIPTLET_RE = /^(trusted-)?set-(cookie|local-storage-item|session-storage-item)$/;
// Never carried: a reload after setting the cookie can loop (seen with XenForo on malwaretips, 10.7.16).
const DROPPED_SCRIPTLETS = Object.freeze(new Set([ 'set-cookie-reload', 'trusted-set-cookie-reload' ]));
// Non-trusted value scriptlets validate their value against a fixed list; the list is read from AdGuard's own function
// source at build time (valueRulesFrom()), never copied here. These name the scriptlet whose list each one uses.
const VALUE_LIST_SOURCE = Object.freeze({
    'set-cookie':               'set-cookie',
    'set-local-storage-item':   'set-local-storage-item',
    'set-session-storage-item': 'set-session-storage-item',
});
const VALUE_MAX_NUMBER = 32767;                       // AdGuard: a numeric value is accepted up to this magnitude
const STORAGE_SPECIAL_VALUES = Object.freeze([ 'emptyArr', '$remove$' ]);   // storage scriptlets' special tokens

// Accept / decline vocabulary (measured on both lists, 11.0.0). "disagree" is read first: it contains "agree".
const DECLINE_WORD_RE = /disagree|reject|declin|deny|denied|refus|necessar|essential|required|mandatory|only|without|nur.?notwendig|ablehnen|weigeren|afwijzen|alleen|refuser|continuer.?sans|rifiut|rechaz|rejeit|odrzu|odmít|elutasít|avvisa|afvis|nødvendig|nodvandig|necesar|optout|opt-out|opt_out/i;
const ACCEPT_WORD_RE = /accept|agree|allow|akzept|zustimm|accetta|acept|aceit|akcept|elfogad|godkänn|tillad|optin|opt-in|opt_in|grant/i;
// A falsy / truthy value, and cookie names that say what the value is about.
const FALSY_VALUE_RE = /^(false|f|0|no|n|off|disabled?|deny|denied|reject(ed)?|declined?|necessary|required|essential|nonessential|mandatory|forbidden|notaccepted|emptyArr|\[\]|\{\})$/i;
const TRUTHY_VALUE_RE = /^(true|t|1|yes|y|on|ok)$/i;
const ACCEPT_VALUE_RE = /^(accept(ed)?|allow(ed)?|granted|agreed?|enabled?|all|approved)$/i;
const REFUSAL_NAME_RE = /reject|deny|denied|declin|refus|optout|opt_out|opt-out/i;   // falsy here = NOT refused
const TRACKING_NAME_RE = /marketing|advertis|analytic|statistic|tracking|personali[sz]|social|thirdparty|third_party|targeting|performance/i;
const CONSENT_NAME_RE = /consent|accept|agree|allow|optin|opt_in|granted/i;

// CMPs uBD's own click bundle answers — markers in a click selector or a cookie / storage key. Every name must be a
// rules.json `name` (checked at build time: a renamed CMP fails the build instead of silently matching nothing).
const CMP_MARKERS = Object.freeze([
    [ 'OneTrust',                    /onetrust|optanon|ot-sdk|ot-pc-/i ],
    [ 'Cookiebot',                   /cybot|^CookieConsent$|CookieConsentBulk/i ],
    [ 'Didomi',                      /didomi/i ],
    [ 'Quantcast Choice / InMobi CMP', /qc-cmp2|qc-cmp-|_cmpRepromptHash/i ],
    [ 'Usercentrics',                /usercentrics|uc-(deny|accept|save|more)|^uc_(settings|user_interaction)|^ucData$/i ],
    [ 'Complianz',                   /cmplz/i ],
    [ 'CookieYes',                   /cky-|cookieyes|cookie-law-info|cli_(accept|reject|settings)|^cookielawinfo|^viewed_cookie_policy$/i ],
    [ 'Klaro',                       /klaro|\.cm-btn/i ],
    [ 'Osano',                       /osano-cm|^osano_/i ],
    [ 'iubenda',                     /iubenda|^_iub_cs/i ],
    [ 'Borlabs Cookie',              /brlbs|borlabs/i ],
    [ 'CookieFirst',                 /cookiefirst/i ],
    [ 'Cookie Script',               /cookiescript/i ],
    [ 'Civic Cookie Control',        /#ccc-|^CookieControl$/i ],
    [ 'Cookie Information',          /coiConsentBanner|^CookieInformationConsent$/i ],
    [ 'Ketch',                       /ketch/i ],
    [ 'Real Cookie Banner',          /real_cookie_banner|rcb-/i ],
    [ 'TrustArc',                    /truste|trustarc|^notice_(preferences|gdpr_prefs|behavior)$|^cmapi_cookie_privacy$|^TAconsentID$/i ],
    [ 'tarteaucitron.js',            /tarteaucitron/i ],
    [ 'Axeptio',                     /axeptio/i ],
    [ 'Moove GDPR',                  /moove[-_]gdpr/i ],
    [ 'HubSpot',                     /hs-eu-|^__hs_(opt_out|cookie_cat_pref|initial_opt_in)$/i ],
    [ 'Termly',                      /termly|data-tid="banner-/i ],
    [ 'Fides',                       /fides-|^fides_consent$/i ],
    [ 'Shopify',                     /shopify-pc|^_tracking_consent$/i ],
    [ 'Silktide',                    /silktide/i ],
    [ 'Piwik PRO Consent Manager',   /ppms_cm|^ppms_privacy/i ],
    [ 'Evidon',                      /evidon/i ],
    [ 'TermsFeed',                   /termsfeed|cc-nb-|^cookie_consent_(level|user_accepted|user_consent_token)$/i ],
    [ 'ConsentManager',              /cmpbox|cmpbnt|^__cmp/i ],
    [ 'Wix',                         /consent-banner-apply|^consent-policy$/i ],
    [ 'Drupal EU Cookie Compliance', /eu-cookie-compliance|^cookie-agreed/i ],
    [ 'Webflow',                     /fs-cc|^fs-cc$/i ],
    [ 'Adopt',                       /adopt-(accept|reject)/i ],
    [ 'AdRoll',                      /adroll_consent/i ],
    [ 'DataGrail',                   /dg-consent|dg-button/i ],
    [ 'TYPO3 Cookieman',             /cookieman/i ],
    [ 'Google Funding Choices',      /fc-consent-root|fc-cta-|fc-dialog|fc-button|fc-confirm-choices|fc-preference/i ],   // (11.0.0)
]);
// Recognized by the bundle, but NOT a solid answer (owner's distinction): Sourcepoint answers in its own iframe (the
// "BBC kind", a loader block). Hide-only CMPs (EVAL_HIDE_ONLY) are excluded by their action, see solidCmpNames().
const NOT_SOLID_CMPS = Object.freeze(new Set([ 'Sourcepoint' ]));
const HIDE_ONLY_ACTION = 'EVAL_HIDE_ONLY';

// Hide rules: plain CSS only. A selector with an extended (procedural) operator is not CSS and is left out.
const PROCEDURAL_OPERATOR_RE = /:(-abp-|has-text|contains|xpath|upward|matches-css|matches-attr|matches-path|matches-media|matches-property|min-text-length|watch-attr|remove|style|others|if\(|if-not|nth-ancestor|shadow)/i;

// GUARDS: a source that yields fewer rules than this after gating has almost certainly changed format.
const MIN_RULES_PER_SOURCE = 10;

/******************************************************************************/
// Pure classification
/******************************************************************************/

// The value a value scriptlet writes (quotes AdGuard sometimes keeps inside the value removed).
function unquote(v) { return String(v ?? '').replace(/^(['"])(.*)\1$/, '$2'); }

// 'accept' | 'decline' | 'neutral' | 'unclear' for an answering rule; null for a helper.
export function classifyAnswer(name, args) {
    if ( CLICK_SCRIPTLET_RE.test(name) ) {
        const selector = String(args[0] ?? '');
        const declines = DECLINE_WORD_RE.test(selector);
        const accepts = ACCEPT_WORD_RE.test(selector.replace(/disagree/ig, ''));
        if ( declines && !accepts ) { return 'decline'; }
        if ( accepts && !declines ) { return 'accept'; }
        return 'unclear';
    }
    if ( VALUE_SCRIPTLET_RE.test(name) ) {
        const key = String(args[0] ?? '');
        const value = unquote(args[1]);
        if ( ACCEPT_VALUE_RE.test(value) ) { return 'accept'; }
        if ( FALSY_VALUE_RE.test(value) ) { return REFUSAL_NAME_RE.test(key) && /^(false|f|0|no|n|off)$/i.test(value) ? 'unclear' : 'decline'; }
        if ( TRUTHY_VALUE_RE.test(value) ) {
            if ( REFUSAL_NAME_RE.test(key) || /necessar|essential|required|minimal/i.test(key) ) { return 'decline'; }
            if ( TRACKING_NAME_RE.test(key) || CONSENT_NAME_RE.test(key) ) { return 'accept'; }
            return 'neutral';                       // "banner seen", "notice closed": dismissed, no consent given
        }
        // A trusted scriptlet's free-form value (JSON consent objects …) — cannot be read safely.
        return /^\{|^\[/.test(value) ? 'unclear' : 'neutral';
    }
    return null;
}

// The covered CMP an answering rule targets (by click selector or cookie / storage key), or null.
export function coveredCmpOf(name, args, solidCmps) {
    const subject = CLICK_SCRIPTLET_RE.test(name) ? String(args[0] ?? '') : VALUE_SCRIPTLET_RE.test(name) ? String(args[0] ?? '') : '';
    if ( subject === '' ) { return null; }
    for ( const [ cmp, re ] of CMP_MARKERS ) {
        if ( re.test(subject) && solidCmps.has(cmp) ) { return cmp; }
    }
    return null;
}

/******************************************************************************/
// Inputs read once per run
/******************************************************************************/

async function solidCmpNames() {
    const rulesDoc = JSON.parse(await fs.readFile(path.join(ROOT, 'vendor/autoconsent/rules/rules.json'), 'utf8'));
    const known = new Set(rulesDoc.rules.map(r => r.name));
    const unknown = CMP_MARKERS.map(([ n ]) => n).filter(n => !known.has(n));
    if ( unknown.length !== 0 ) {
        throw new Error(`cookie notices: CMP_MARKERS names not in rules.json: ${unknown.join(', ')} — rename them to match`);
    }
    return new Set(rulesDoc.rules
        .filter(r => typeof r.action === 'string' && r.action !== HIDE_ONLY_ACTION && !NOT_SOLID_CMPS.has(r.name))
        .map(r => r.name));
}

// Alias -> library name, and per value scriptlet a validator built from AdGuard's own accepted-value list.
function corelibsTables(corelibs) {
    const aliasToName = new Map();
    const bodyOf = new Map();
    for ( const entry of corelibs.scriptlets ) {
        bodyOf.set(entry.names[0], entry.scriptlet);
        for ( const alias of entry.names ) { aliasToName.set(alias, entry.names[0]); }
    }
    const valueOk = new Map();
    for ( const [ name, source ] of Object.entries(VALUE_LIST_SOURCE) ) {
        const body = bodyOf.get(source);
        const lists = [ ...String(body ?? '').matchAll(/new Set\((\[[^\]]*\])\)/g) ].map(m => { try { return JSON.parse(m[1]); } catch { return null; } });
        const words = lists.find(l => Array.isArray(l) && l.includes('true') && l.includes('false'));
        if ( words === undefined || words.length < 10 ) {
            throw new Error(`cookie notices: cannot read the accepted-value list of AdGuard's ${source} — its source changed`);
        }
        const set = new Set(words.map(w => String(w).toLowerCase()));
        const special = name === 'set-cookie' ? [] : STORAGE_SPECIAL_VALUES;
        valueOk.set(name, value => {
            const v = unquote(value);
            if ( set.has(v.toLowerCase()) || special.includes(v) ) { return true; }
            return /^-?\d+$/.test(v) && Math.abs(Number(v)) <= VALUE_MAX_NUMBER;
        });
    }
    return { aliasToName, valueOk };
}

/******************************************************************************/
// Stage helpers
/******************************************************************************/

// Scriptlet rules per site from gated lines: Map<site, [{ name, args }]>, names resolved to library names. Rules that
// can never ship (unknown name, dropped scriptlet, policy, untrusted source, refused value) are counted, not kept.
function scriptletsBySite(gatedLines, { aliasToName, valueOk, sourceUrl, report }) {
    const trusted = isTrustedScriptletSource(sourceUrl);
    const out = new Map();
    const text = gatedLines.filter(l => l.includes('#%#//scriptlet(')).join('\n');
    for ( const rule of parseScriptletRules(text, () => true) ) {
        const name = aliasToName.get(rule.name) ?? aliasToName.get(`${rule.name}.js`) ?? null;
        if ( name === null ) { report.unknownName++; continue; }
        if ( DROPPED_SCRIPTLETS.has(name) ) { report.reload++; continue; }
        if ( scriptletViolationAnySource(name, rule.args) !== null || (requiresTrust(name) && !trusted) ) { report.policy++; continue; }
        if ( valueOk.has(name) && valueOk.get(name)(rule.args[1]) === false ) { report.refusedValue++; continue; }
        for ( const site of rule.hostnames ) {
            const list = out.get(site) ?? out.set(site, []).get(site);
            list.push({ name, args: rule.args });
        }
    }
    return out;
}

// Per site: the rules it ships in each mode, or nothing (covered CMP / unclear rule anywhere on the site).
// alsoDeclineSites: sites with decline-only hide/block rules (stage 1) — their helpers ship in decline mode too.
function splitSite(rules, solidCmps, report, hasDeclineHideOrBlock) {
    const answers = { decline: [], accept: [] };
    const helpers = [];
    for ( const rule of rules ) {
        const kind = classifyAnswer(rule.name, rule.args);
        if ( kind === null ) { helpers.push(rule); continue; }
        if ( coveredCmpOf(rule.name, rule.args, solidCmps) !== null ) { report.coveredSites++; return null; }
        if ( kind === 'unclear' ) { report.unclearSites++; return null; }
        if ( kind !== MODES.ACCEPT ) { answers.decline.push(rule); }
        if ( kind !== MODES.DECLINE ) { answers.accept.push(rule); }
    }
    const result = {};
    for ( const mode of Object.values(MODES) ) {
        const shipsHelpers = answers[mode].length !== 0 || (mode === MODES.DECLINE && hasDeclineHideOrBlock);
        const rows = shipsHelpers ? [ ...answers[mode], ...helpers ] : answers[mode];
        if ( rows.length !== 0 ) { result[mode] = rows; }
    }
    return result;
}

// Hide table from gated "host##selector" / "host#@#selector" lines: Map<site, Set<selector>> (plain, safe CSS only).
function hideTable(gatedLines, skipSites, report) {
    const hides = new Map();
    const exceptions = new Set();
    for ( const line of gatedLines ) {
        const m = /^([^#]+)(##|#@#)(.+)$/.exec(line);
        if ( m === null ) { continue; }
        const [ , site, op, selector ] = m;
        if ( skipSites.has(site) ) { continue; }
        if ( selector.startsWith('+js(') || selector.startsWith('{') || PROCEDURAL_OPERATOR_RE.test(selector) || !isSafePickedSelector(selector) ) {
            report.hideNotCss++; continue;
        }
        if ( op === '#@#' ) { exceptions.add(`${site}\n${selector}`); continue; }
        (hides.get(site) ?? hides.set(site, new Set()).get(site)).add(selector);
    }
    for ( const key of exceptions ) {
        const [ site, selector ] = key.split('\n');
        hides.get(site)?.delete(selector);
        if ( hides.get(site)?.size === 0 ) { hides.delete(site); }
    }
    return hides;
}

// A site and every parent domain (to test "is this site — or the site it belongs to — in a skip set").
function siteAndParents(host) {
    const out = [ host ];
    for ( let i = host.indexOf('.'); i !== -1 && host.indexOf('.', i + 1) !== -1; i = host.indexOf('.', i + 1) ) { out.push(host.slice(i + 1)); }
    return out;
}

// Block rules (DNR, from the shared network parser) for the decline set. A rule with `$domain=` keeps only gated,
// non-skipped sites; a `||host` rule without one must name a literal in-scope host not belonging to a skipped site.
// Allow rules and site-less path rules are not carried (too broad for a site-specific list).
function blockRules(lines, { topSites, skipSites, report }) {
    const out = [];
    function siteOk(h) { return isTLDKept(h) && isPopularHostname(h, topSites); }
    for ( const line of lines ) {
        const t = line.trim();
        if ( t === '' || t.startsWith('!') || t.startsWith('@@') || /##|#@#|#%#|#\?#|#\$#/.test(t) ) { continue; }
        const rule = parseBlockRule(t, 1, COOKIE_NOTICE_BLOCK_PRIORITY);
        if ( rule === null || rule.action?.type !== 'block' ) { continue; }
        const c = rule.condition;
        if ( Array.isArray(c.initiatorDomains) ) {
            c.initiatorDomains = c.initiatorDomains.filter(d => siteOk(d) && !siteAndParents(d).some(s => skipSites.has(s)));
            if ( c.initiatorDomains.length === 0 ) { report.blockOutOfScope++; continue; }
        } else {
            const host = /^\|\|([a-z0-9.-]+)(?=[\^/]|$)/i.exec(c.urlFilter ?? '')?.[1]?.toLowerCase();
            if ( host === undefined || !isTLDKept(host) || siteAndParents(host).some(s => skipSites.has(s)) ) { report.blockOutOfScope++; continue; }
        }
        delete rule.id;
        out.push(rule);
    }
    return out;
}

/******************************************************************************/
// Pipeline (memoised per build run)
/******************************************************************************/

let memo = null;
export function resetCookieNoticeCache() { memo = null; }

// opts: { topSites: Set<string> }  (the CrUX top-1M set stepInit fetched)
export function buildCookieNoticeSets(opts) {
    memo ??= runPipeline(opts);
    return memo;
}

async function fetchGated(source, topSites, transform = t => t) {
    const text = transform(await fetchList(source.url));
    const gated = gateAnnoyanceLines(text.split('\n'), { topSites, categoryFilter: false });
    if ( gated.length < MIN_RULES_PER_SOURCE ) {
        throw new Error(`cookie notices: '${source.name}' produced ${gated.length} rules after gating — its format may have changed (${source.url})`);
    }
    return { text, gated };
}

async function runPipeline({ topSites }) {
    if ( !(topSites instanceof Set) || topSites.size === 0 ) { throw new Error('cookie notices: the CrUX top-1M set is empty'); }
    const S = COOKIE_NOTICE_SOURCES;
    const [ corelibs, solidCmps, adguard, uboSrc, elHide, elBlockText ] = await Promise.all([
        fetchCorelibsFromNpm(),
        solidCmpNames(),
        fetchGated(S.adguard, topSites),
        fetchGated(S.easylistUbo, topSites, t => convertUboScriptletSyntax(t).text),
        fetchGated(S.easylistHide, topSites),
        fetchList(S.easylistBlock.url),
    ]);
    const { aliasToName, valueOk } = corelibsTables(corelibs);
    const report = { unknownName: 0, reload: 0, policy: 0, refusedValue: 0, coveredSites: 0, unclearSites: 0, hideNotCss: 0, blockOutOfScope: 0 };
    const scriptlets = { decline: new Map(), accept: new Map() };   // site -> [{ name, args }]
    const stageSites = { decline: new Set(), accept: new Set() };   // the stage-1 domain set per mode

    // ── Stage 1: AdGuard Cookie Notices ──
    const agHide = hideTable(adguard.gated, new Set(), report);
    const agBlock = blockRules(adguard.text.split('\n'), { topSites, skipSites: new Set(), report });
    const agBlockSites = new Set(agBlock.flatMap(r => r.condition.initiatorDomains ?? []));
    for ( const [ site, rules ] of scriptletsBySite(adguard.gated, { aliasToName, valueOk, sourceUrl: S.adguard.url, report }) ) {
        const split = splitSite(rules, solidCmps, report, agHide.has(site) || agBlockSites.has(site));
        for ( const mode of Object.keys(split ?? {}) ) { scriptlets[mode].set(site, split[mode]); stageSites[mode].add(site); }
    }
    for ( const site of [ ...agHide.keys(), ...agBlockSites ] ) { stageSites.decline.add(site); }

    // ── Stage 2: EasyList Cookie uBO — sites outside the stage-1 set of each mode ──
    for ( const [ site, rules ] of scriptletsBySite(uboSrc.gated, { aliasToName, valueOk, sourceUrl: S.easylistUbo.url, report }) ) {
        const split = splitSite(rules, solidCmps, report, false);
        for ( const mode of Object.keys(split ?? {}) ) {
            if ( !stageSites[mode].has(site) ) { scriptlets[mode].set(site, split[mode]); }
        }
    }

    // ── Stage 3: EasyList Cookie specific hide + block — decline only, sites outside the stage-1 decline set ──
    const elHideTable = hideTable(elHide.gated, stageSites.decline, report);
    const elBlock = blockRules(elBlockText.split('\n'), { topSites, skipSites: stageSites.decline, report });

    // Decline hide table and block rules (stage 1 + stage 3), de-duplicated.
    const hides = new Map(agHide);
    for ( const [ site, set ] of elHideTable ) { hides.set(site, new Set([ ...(hides.get(site) ?? []), ...set ])); }
    const seen = new Set();
    const blocks = [ ...agBlock, ...elBlock ].filter(r => { const k = JSON.stringify(r.condition); return !seen.has(k) && seen.add(k); });
    if ( blocks.length > COOKIE_NOTICE_BLOCK_RULES_MAX ) {
        throw new Error(`cookie notices: ${blocks.length} block rules exceed COOKIE_NOTICE_BLOCK_RULES_MAX (${COOKIE_NOTICE_BLOCK_RULES_MAX})`);
    }
    for ( const mode of Object.values(MODES) ) {
        if ( scriptlets[mode].size < MIN_RULES_PER_SOURCE ) { throw new Error(`cookie notices: the ${mode} scriptlet set has only ${scriptlets[mode].size} sites`); }
    }
    // (11.0.0) "Accept, else decline": the accept rows of a site that has them, its decline rows otherwise; every decline
    // hide rule; the decline block rules only for sites (and their subdomains) without accept rows.
    const acceptSites = new Set(scriptlets.accept.keys());
    function isAcceptSite(h) { return siteAndParents(h).some(s => acceptSites.has(s)); }
    scriptlets[PREFER_ACCEPT] = new Map([ ...scriptlets.accept, ...[ ...scriptlets.decline ].filter(([ site ]) => !acceptSites.has(site)) ]);
    const preferBlocks = blocks.map(r => JSON.parse(JSON.stringify(r))).filter(r => {
        const c = r.condition;
        if ( Array.isArray(c.initiatorDomains) ) {
            c.initiatorDomains = c.initiatorDomains.filter(d => !isAcceptSite(d));
            return c.initiatorDomains.length !== 0;
        }
        const host = /^\|\|([a-z0-9.-]+)/i.exec(c.urlFilter ?? '')?.[1]?.toLowerCase();
        return host === undefined || !isAcceptSite(host);
    });
    const usedNames = new Set([ ...scriptlets.decline.values(), ...scriptlets.accept.values() ].flat().map(r => r.name));
    return {
        scriptlets,
        hides:  { [MODES.DECLINE]: hides },   // "accept, else decline" uses this same family (js/data/cookie-notice-sets.js)
        blocks: { [MODES.DECLINE]: blocks, [PREFER_ACCEPT]: preferBlocks },
        usedNames, corelibs, report,
    };
}
