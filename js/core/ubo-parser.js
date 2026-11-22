/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2014-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/Kees1958/uBol-stripped
    Based on uBlock Origin Lite (https://github.com/gorhill/uBlock), modified in
    2026 for uBlock-Stripped-Dynamic — see CHANGELOG.md for the changes.
*/

import * as sfp from './static-filtering-parser.js';
import punycode from '../util/punycode.js';
import redirectResourceMap from './redirect-resources.js';

/******************************************************************************/

// Default resource types assumed for a filter that does not explicitly
// specify any (e.g. a plain `||example.com^` with no `$script,image,...`
// options). Deliberately narrower than dnr-parser.js's validResourceTypeValues
// (which is the *exhaustive* list of values Chrome's DNR API accepts when a
// resource type *is* explicitly specified) - webtransport/webbundle are
// intentionally left out of this safe default. Not a duplicate to merge.
const safeResourceTypes = [
    'main_frame',
    'sub_frame',
    'stylesheet',
    'script',
    'image',
    'font',
    'object',
    'xmlhttprequest',
    'ping',
    'csp_report',
    'media',
    'websocket',
    'other',
];

/******************************************************************************/

const validRedirectResources = (( ) => {
    const out = new Map();
    for ( const [ name, resource ] of redirectResourceMap ) {
        out.set(name, name);
        if ( resource.alias === undefined ) { continue; }
        if ( typeof resource.alias === 'string' ) {
            out.set(resource.alias, name);
            continue;
        }
        if ( Array.isArray(resource.alias) ) {
            for ( const alias of resource.alias ) {
                out.set(alias, name);
            }
        }
    }
    return out;
})();

function isNotEntity(hn) { return hn.endsWith('.*') === false; }

/******************************************************************************/

function toSuperDomain(hn) {
    const pos = hn.indexOf('.');
    if ( pos === -1 ) { return; }
    return hn.slice(pos+1);
}

/******************************************************************************/

function parseHostnameList(iter) {
    const out = {
        included: {
            good: [],
            bad: [],
        },
        excluded: {
            good: [],
            bad: [],
        },
    };
    for ( let { hn, not, bad } of iter ) {
        bad ||= hn.includes('/') || hn.includes('*');
        const hnAscii = bad === false && hn.startsWith('xn--')
            ? punycode.toASCII(hn)
            : hn;
        const destination = not ? out.excluded : out.included;
        if ( bad ) {
            destination.bad.push(hnAscii);
        } else {
            destination.good.push(hnAscii);
        }
    }
    return out;
}

/******************************************************************************/

function ownerFromPropertyPath(root, path) {
    let owner = root;
    let prop = path;
    for (;;) {
        if ( owner instanceof Object === false ) { break; }
        const pos = prop.indexOf('.');
        if ( pos === -1 ) { break; }
        owner = owner[prop.slice(0, pos)];
        prop = prop.slice(pos+1)
    }
    return { owner: owner ?? undefined, prop };
}

/******************************************************************************/

function mergeArrays(rules, propertyPath) {
    const out = [];
    const distinctRules = new Map();
    for ( const rule of rules ) {
        const { id } = rule;
        const { owner, prop } = ownerFromPropertyPath(rule, propertyPath);
        if ( owner === undefined || Array.isArray(owner[prop]) === false ) {
            out.push(rule);
            continue;
        }
        const collection = owner[prop] || [];
        owner[prop] = undefined;
        rule.id = undefined;
        const hash = JSON.stringify(rule);
        const details = distinctRules.get(hash) ||
            { id, collection: new Set() };
        if ( details.collection.size === 0 ) {
            distinctRules.set(hash, details);
        }
        for ( const hn of collection ) {
            details.collection.add(hn);
        }
    }
    for ( const [ hash, { id, collection } ] of distinctRules ) {
        const rule = JSON.parse(hash);
        if ( id ) {
            rule.id = id;
        }
        if ( collection.size !== 0 ) {
            const { owner, prop } = ownerFromPropertyPath(rule, propertyPath);
            owner[prop] = Array.from(collection).sort();
        }
        out.push(rule);
    }
    return out;
}

/******************************************************************************/

export function minimizeRuleset(rules) {
    rules = mergeArrays(rules, 'condition.requestDomains');
    rules = mergeArrays(rules, 'condition.excludedRequestDomains');
    rules = mergeArrays(rules, 'condition.initiatorDomains');
    rules = mergeArrays(rules, 'condition.excludedInitiatorDomains');
    rules = mergeArrays(rules, 'condition.topDomains');
    rules = mergeArrays(rules, 'condition.excludedTopDomains');
    rules = mergeArrays(rules, 'condition.resourceTypes');
    rules = mergeArrays(rules, 'condition.excludedRequestMethods');
    rules = mergeArrays(rules, 'condition.requestMethods');
    rules = mergeArrays(rules, 'condition.excludedResourceTypes');
    rules = mergeArrays(rules, 'action.redirect.transform.queryTransform.removeParams');
    return rules;
}

/******************************************************************************/

export function minimizeRules(rules) {
    const hostnameListProp = [
        'requestDomains',
        'excludedRequestDomains',
        'initiatorDomains',
        'excludedInitiatorDomains',
    ];
    for ( const rule of rules ) {
        for ( const prop of hostnameListProp ) {
            const hostnames = rule.condition[prop];
            if ( hostnames === undefined ) { continue; }
            if ( hostnames.length === 1 ) { continue; }
            const hnSet = new Set(hostnames);
            for ( let hn of hnSet ) {
                for (;;) {
                    const hnup = toSuperDomain(hn);
                    if ( hnup === undefined ) { break; }
                    if ( hnSet.has(hnup) ) { hnSet.delete(hn); }
                    hn = hnup;
                }
            }
            if ( hnSet.size === hostnames.length ) { continue; }
            rule.condition[prop] = Array.from(hnSet).sort();
        }
    }
    return rules;
}

/******************************************************************************/

function dropEntities(rule, prop) {
    const { condition } = rule;
    if ( condition[prop] === undefined ) { return; }
    const sanitized = condition[prop].filter(a => isNotEntity(a));
    if ( sanitized.length === condition[prop].length ) { return; }
    if ( sanitized.length === 0 ) { return 0; }
    // (10.7.6) Was "condition.requestDomains = sanitized" for EVERY list (upstream bug): an initiator list with
    // one "site.*" entry was written into requestDomains, turning "block X on these sites" into "block these
    // sites" (and leaving the entity in initiatorDomains). Each list now keeps its own field.
    condition[prop] = sanitized;
}

/******************************************************************************/

// (10.7.6) Why validateRules() would drop this ONE rule, or null when it keeps it — so the Import ABP box can name the
// reason beneath the source line. Same checks, same order as validateRules() below (asserted by suite step 77).
// Works on a copy: dropEntities() rewrites the rule.
export function explainValidationDrop(rule) {
    if ( validateRules([ structuredClone(rule) ]).length !== 0 ) { return null; }
    const { condition } = rule;
    if ( condition.resourceTypes && condition.excludedResourceTypes ) {
        return 'request types and excluded request types cannot be combined in one Chrome rule';
    }
    if ( condition.requestMethods && condition.excludedRequestMethods ) {
        return 'request methods and excluded request methods cannot be combined in one Chrome rule';
    }
    if ( rule.action?.redirect?.regexSubstitution && condition.regexFilter === undefined ) {
        return 'a URL rewrite needs a /regex/ pattern';
    }
    return NETWORK_REJECTION_REASONS.WILDCARD_SITES;
}

export function validateRules(rules) {
    const out = [];
    for ( const rule of rules ) {
        const { condition } = rule;
        // "Only one of resourceTypes and excludedResourceTypes should be specified"
        if ( condition.resourceTypes ) {
            if ( condition.excludedResourceTypes ) { continue; }
        }
        // "Only one of requestMethods and excludedRequestMethods should be specified"
        if ( condition.requestMethods ) {
            if ( condition.excludedRequestMethods ) { continue; }
        }
        // Drop entity-based hostnames
        if ( dropEntities(rule, 'requestDomains') === 0 ) { continue; }
        if ( dropEntities(rule, 'excludedRequestDomains') === 0 ) { continue; }
        if ( dropEntities(rule, 'initiatorDomains') === 0 ) { continue; }
        if ( dropEntities(rule, 'excludedInitiatorDomains') === 0 ) { continue; }
        // regexSubstitution requires regexFilter
        if ( rule.action?.redirect?.regexSubstitution ) {
            if ( rule.condition.regexFilter === undefined ) { continue; }
        }
        out.push(rule);
    }
    return out;
}

/******************************************************************************/

// ── Why a network line gives no rule (10.7.6) ─────────────────────────────────
// The Import ABP box comments out every network line it cannot use and writes the reason beneath it in red (the
// owner's rule since 10.7.2, first applied to scriptlet and $popup lines only). parseNetworkFilter() returns nothing
// for such a line; this names the reason from the line's options. One table, one place for the wording.
const NETWORK_REJECTION_REASONS = Object.freeze({
    REDIRECT_RULE:  '$redirect-rule is not supported — Chrome cannot make a rule depend on another rule blocking the request',
    NETWORK:        '$network (block an IP address for every domain on it) is not supported — Chrome only sees web addresses',
    HEADER_CHANGE:  'changing request or response headers ($removeheader / $requestheader) is not supported',
    EXCEPTION_OF:   'an exception to this option cannot be expressed — in Chrome it would also lift every other block on these requests',
    ADGUARD_ONLY:   'this option has no Chrome rule equivalent (it needs a full content blocker such as the AdGuard app)',
    PARSE_ERROR:    'not a valid filter — check the spelling of the pattern and its options',
    WILDCARD_SITES: 'every site in the list is a wildcard (e.g. google.*) — Chrome needs full site names',
    GENERIC:        'cannot be turned into a Chrome rule',
});
const EXCEPTION_ONLY_DROPPED = new Set([ 'csp', 'permissions', 'removeparam', 'queryprune', 'urltransform', 'uritransform' ]);
const ADGUARD_APP_OPTIONS = new Set([ 'app', 'extension', 'content', 'jsinject', 'stealth', 'cookie', 'replace', 'hls',
    'jsonprune', 'xmlprune', 'urlblock', 'genericblock', 'elemhide', 'generichide', 'specifichide', 'network' ]);

// The option names of a network line, lower-case, without "~" or "=value" (a /regex/ pattern's own "$" is skipped).
function networkOptionsOf(line) {
    const start = line.startsWith('/') ? line.lastIndexOf('/') : 0;
    const at = line.indexOf('$', start);
    if ( at === -1 ) { return []; }
    return line.slice(at + 1).split(',').map(o => o.trim().replace(/^~/, '').split('=')[0].toLowerCase()).filter(o => o !== '');
}

// The "=value" of option `name` in a network line ('' when absent).
function optionValueOf(text, name) {
    const m = new RegExp(`[$,]~?${name}=([^,]*)`, 'i').exec(text);
    return m ? m[1].trim() : '';
}

/**
 * The reason a network line yields no rule, worded for the person editing the Import ABP box. `parseError` = the
 * parser refused the line itself (hasError()).
 */
export function explainNetworkRejection(line, parseError = false) {
    if ( parseError ) { return NETWORK_REJECTION_REASONS.PARSE_ERROR; }
    const text = String(line ?? '').trim();
    const options = networkOptionsOf(text);
    if ( options.includes('redirect-rule') ) { return NETWORK_REJECTION_REASONS.REDIRECT_RULE; }
    if ( options.includes('network') ) { return NETWORK_REJECTION_REASONS.NETWORK; }
    if ( options.includes('redirect') ) {
        const target = optionValueOf(text, 'redirect').split(':')[0];
        if ( target !== '' && validRedirectResources.has(target) === false ) {
            const offered = [ ...redirectResourceMap.values() ].map(r => [].concat(r.alias ?? [])[0]).filter(Boolean);
            return `redirect target "${target}" is not included in uBD — available: ${offered.join(', ')}`;
        }
    }
    if ( options.some(o => o === 'removeheader' || o === 'requestheader') ) { return NETWORK_REJECTION_REASONS.HEADER_CHANGE; }
    const sites = [ 'domain', 'from', 'to', 'denyallow' ].flatMap(o => optionValueOf(text, o).split('|')).filter(Boolean);
    if ( sites.length !== 0 && sites.every(d => d.replace(/^~/, '').endsWith('.*')) ) { return NETWORK_REJECTION_REASONS.WILDCARD_SITES; }
    if ( text.startsWith('@@') && options.some(o => EXCEPTION_ONLY_DROPPED.has(o)) ) { return NETWORK_REJECTION_REASONS.EXCEPTION_OF; }
    const appOnly = options.find(o => ADGUARD_APP_OPTIONS.has(o));
    if ( appOnly !== undefined ) { return `$${appOnly}: ${NETWORK_REJECTION_REASONS.ADGUARD_ONLY}`; }
    return options.length !== 0
        ? `${NETWORK_REJECTION_REASONS.GENERIC} (check the options: ${options.map(o => `$${o}`).join(', ')})`
        : NETWORK_REJECTION_REASONS.GENERIC;
}

/******************************************************************************/

// Priority (ABP import — dynamic rules; USER_RULES_PRIORITY is added by ruleset-manager.js):
//   Removeparam: 1-4
//   Block: 10 (default priority)
//   Redirect: 11-19
//   Excepted redirect: 20
//   Allow: 30
//   Block important: 40
//   Redirect important: 41-49
// (10.7.6) Named here once; the build reads isImportantPriority() to mark a static rule "$important".
export const RULE_PRIORITY = Object.freeze({
    DEFAULT:            1,
    BLOCK:              10,
    REDIRECT:           11,   // + $redirect=name:N subpriority (0-8)
    EXCEPTED_REDIRECT:  20,
    ALLOW:              30,
    BLOCK_IMPORTANT:    40,
    REDIRECT_IMPORTANT: 41,   // + subpriority
});

/** True when parseNetworkFilter() gave a rule the "$important" priority (block or redirect). */
export function isImportantPriority(priority) {
    return typeof priority === 'number' && priority >= RULE_PRIORITY.BLOCK_IMPORTANT;
}

// (10.7.6) ABP / AdGuard dialect normalisation of one network line, applied BEFORE the parser sees it — by
// the build (tools/build/rule-parsers.mjs) and the ABP import (js/offscreen/compile-filters.js) alike.
//   - "@@…$important": AdGuard's high-priority exception. The parser rejects "important" on an exception
//     (uBO dialect); DNR already lets an allow win over a block of the same priority, so it is dropped.
export function normalizeAbpNetworkLine(line) {
    if ( line.startsWith('@@') === false ) { return line; }
    const dollarPos = line.lastIndexOf('$');
    if ( dollarPos === -1 ) { return line; }
    const opts = line.slice(dollarPos + 1).split(',');
    const kept = opts.filter(o => o !== 'important');
    if ( kept.length === opts.length ) { return line; }
    return kept.length === 0 ? line.slice(0, dollarPos) : `${line.slice(0, dollarPos)}$${kept.join(',')}`;
}

// The pattern part of a raw network line: without "@@" and without the "$options" list.
function rawNetPatternText(raw) {
    const line = raw.startsWith('@@') ? raw.slice(2) : raw;
    const dollarPos = line.lastIndexOf('$');
    return dollarPos === -1 ? line : line.slice(0, dollarPos);
}

export function parseNetworkFilter(parser, details = {}) {
    if ( parser.isNetworkFilter() === false ) { return; }
    if ( parser.hasError() ) { return; }

    // (10.7.6) An option the parser does not know is not split off: the whole "$option" text stays in the
    // pattern (e.g. AdGuard's "1.2.3.4$network", "||x^$removeheader=…"), and the result was a junk urlFilter
    // that can never match. Such a line is dropped — the build and the ABP import alike (one parser).
    if ( parser.hasOptions() === false && parser.isRegexPattern() === false ) {
        if ( parser.getNetPattern().includes('$') ) { return; }
    }

    const validResourceTypes = details.resourceTypes ?? safeResourceTypes;
    const rule = {
        action: { type: 'block' },
        condition: { },
    };
    const isException = parser.isException();
    if ( isException ) {
        rule.action.type = 'allow';
    }

    let pattern = parser.getNetPattern();
    if ( parser.isHostnamePattern() && parser.isLeftHnAnchored() === false ) {
        // (10.7.6) ABP / AdGuard dialect — the lists we compile AND the "Import ABP rules" editor: a bare
        // token without "||" ("promo-pc.jpg$domain=download.cnet.com", "reklama") matches ANYWHERE in the URL.
        // uBO reads a hostname-looking token as "||token^", which turned these rules into hosts that never exist.
        rule.condition.urlFilter = pattern;
    } else if ( parser.isHostnamePattern() && rawNetPatternText(parser.raw).endsWith('^') === false ) {
        // (10.7.6) "||buzzer.xhamster*" — no separator after the host, so it is a PREFIX ("buzzer.xhamster…"),
        // not the exact host the parser read it as.
        rule.condition.urlFilter = `||${pattern}`;
    } else if ( parser.isHostnamePattern() ) {
        rule.condition.requestDomains = [ pattern ];
    } else if ( parser.isPlainPattern() || parser.isGenericPattern() ) {
        if ( parser.isLeftHnAnchored() ) {
            pattern = `||${pattern}`;
        } else if ( parser.isLeftAnchored() ) {
            pattern = `|${pattern}`;
        }
        if ( parser.isRightAnchored() ) {
            pattern = `${pattern}|`;
        }
        rule.condition.urlFilter = pattern;
    } else if ( parser.isRegexPattern() ) {
        rule.condition.regexFilter = pattern;
    } else if ( parser.isAnyPattern() === false ) {
        rule.condition.urlFilter = pattern;
    }

    const defaultResourceTypes = new Set();
    const initiatorDomains = new Set();
    const excludedInitiatorDomains = new Set();
    const requestDomains = new Set();
    const excludedRequestDomains = new Set();
    const topDomains = new Set();
    const excludedTopDomains = new Set();
    const requestMethods = new Set();
    const excludedRequestMethods = new Set();
    const resourceTypes = new Set();
    const excludedResourceTypes = new Set();

    function processResourceType(resourceType, nodeType) {
        const not = parser.isNegatedOption(nodeType)
        if ( validResourceTypes.includes(resourceType) === false ) {
            if ( not ) { return; }
        }
        if ( not ) {
            excludedResourceTypes.add(resourceType);
        } else {
            resourceTypes.add(resourceType);
        }
    }

    let subpriority = 0;
    let isImportant = false;

    for ( const type of parser.getNodeTypes() ) {
        switch ( type ) {
        case sfp.NODE_TYPE_NET_OPTION_NAME_1P:
            rule.condition.domainType = parser.isNegatedOption(type)
                ? 'thirdParty'
                : 'firstParty';
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_STRICT1P:
        case sfp.NODE_TYPE_NET_OPTION_NAME_STRICT3P:
        case sfp.NODE_TYPE_NET_OPTION_NAME_BADFILTER:
        case sfp.NODE_TYPE_NET_OPTION_NAME_CNAME:
        case sfp.NODE_TYPE_NET_OPTION_NAME_EHIDE:
        case sfp.NODE_TYPE_NET_OPTION_NAME_GENERICBLOCK:
        case sfp.NODE_TYPE_NET_OPTION_NAME_GHIDE:
        case sfp.NODE_TYPE_NET_OPTION_NAME_IPADDRESS:
        case sfp.NODE_TYPE_NET_OPTION_NAME_REDIRECTRULE:
        case sfp.NODE_TYPE_NET_OPTION_NAME_REPLACE:
        case sfp.NODE_TYPE_NET_OPTION_NAME_SHIDE:
        case sfp.NODE_TYPE_NET_OPTION_NAME_URLSKIP:
            return;
        case sfp.NODE_TYPE_NET_OPTION_NAME_REQUESTHEADER:
        case sfp.NODE_TYPE_NET_OPTION_NAME_UNKNOWN:
            // (10.7.6) DNR cannot match on a REQUEST header, and an unknown option has no meaning to
            // translate. Ignoring either one (the old default) BROADENED the rule — e.g.
            // "||x^$requestheader=…" became a block of every request to x. The whole filter is dropped.
            return;
        case sfp.NODE_TYPE_NET_OPTION_NAME_EMPTY:
        case sfp.NODE_TYPE_NET_OPTION_NAME_MP4:
            // AdGuard's old shorthands for "answer with an empty body / a silent video". Kept as a plain
            // block (same result for the page as before 10.7.6), written down here instead of falling
            // through the default branch unnoticed.
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_POPUNDER:
        case sfp.NODE_TYPE_NET_OPTION_NAME_POPUP:
            // (10.7.2) The whole filter is dropped, exactly as the build does since 9.2.8
            // (tools/build/rule-parsers.mjs). DNR cannot tell a popup from a normal link click, and
            // falling through to the default types (the 8.6.5 behaviour below) turned e.g.
            // "*$popup,domain=site" into a block of EVERY request on that site. A popup host the lists
            // mark $all is still blocked as a page ($all case below). Decision record:
            // docs popup-popunder-abp-import-voorstel.md, Part 4.
            return;
        case sfp.NODE_TYPE_NET_OPTION_NAME_INLINEFONT:
        case sfp.NODE_TYPE_NET_OPTION_NAME_INLINESCRIPT:
        case sfp.NODE_TYPE_NET_OPTION_NAME_WEBRTC:
            // (10.7.3) The whole filter is dropped, as the build does (tools/build/rule-parsers.mjs
            // PAGE_ONLY_OPTIONS for inline-script / inline-font; webrtc is unknown there and dropped).
            // Falling through to the default types (the 8.6.5 behaviour described below) BROADENED
            // the rule: "||site^$inline-script" became a block of every request to that site.
            return;
            // (History, superseded by the return above.)
            // BUG FIX (v8.6.5): none of these five modifiers has a DNR
            // resourceType equivalent — Chrome's declarativeNetRequest
            // cannot express "block only when used as inline-font/
            // inline-script/popup/popunder/webrtc". The previous
            // processResourceType('', type) call added an empty string
            // to the resourceTypes Set below, which the .filter(a => a
            // !== '') further down silently strips back out — but that
            // now-emptied Set had already counted as non-empty at the
            // `resourceTypes.size === 0` check above it, so a rule using
            // ONLY one of these five (no other type-affecting option)
            // ended up with resourceTypes: [], an invalid DNR condition.
            // Real-world impact, not theoretical: ruleset-manager.js's
            // updateUserRules() sends every sandbox rule in ONE atomic
            // dnr.updateDynamicRules({ addRules }) call — Chrome rejects
            // that whole call if even one rule is invalid, so a single
            // stray e.g. $popup line (present in real lists — AdGuard's
            // own Popups filter has several) silently zeroed out every
            // other rule in the same import, with no indication which
            // line caused it.
            // Fix: since none of these five can be represented as a DNR
            // resourceType, do nothing here — same treatment
            // build-rulesets.mjs already gives these same five names in
            // its own option-parser's ignore-list. The rule then falls
            // through to defaultResourceTypes exactly as if the option
            // had never been written, instead of corrupting
            // resourceTypes into an empty array.
        case sfp.NODE_TYPE_NET_OPTION_NAME_3P:
            rule.condition.domainType = parser.isNegatedOption(type)
                ? 'firstParty'
                : 'thirdParty';
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_ALL:
            validResourceTypes.forEach(a => resourceTypes.add(a));
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_CSP:
            if ( rule.action.responseHeaders ) { return; }
            rule.action.type = 'modifyHeaders';
            rule.action.responseHeaders = [ {
                header: 'content-security-policy',
                operation: 'append',
                value: parser.getNetOptionValue(type),
            } ];
            defaultResourceTypes.add('main_frame');
            defaultResourceTypes.add('sub_frame');
            defaultResourceTypes.add('object');
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_CSS:
            processResourceType('stylesheet', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_DENYALLOW: {
            const { included, excluded } = parseHostnameList(
                parser.getNetFilterDenyallowOptionIterator()
            );
            if ( excluded.good.length !== 0 || excluded.bad.length !== 0 ) { return; }
            if ( included.bad.length !== 0 ) { return; }
            if ( included.good.length === 0 ) { return; }
            for ( const hn of included.good ) {
                excludedRequestDomains.add(hn);
            }
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_DOC:
            processResourceType('main_frame', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_FONT:
            processResourceType('font', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_FRAME:
            processResourceType('sub_frame', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_FROM: {
            const { included, excluded } = parseHostnameList(
                parser.getNetFilterFromOptionIterator()
            );
            if ( included.good.length === 0 ) {
                if ( included.bad.length !== 0 ) { return; }
            }
            if ( excluded.bad.length !== 0 ) { return; }
            for ( const hn of included.good ) {
                initiatorDomains.add(hn);
            }
            for ( const hn of excluded.good ) {
                excludedInitiatorDomains.add(hn);
            }
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_RESPONSEHEADER: {
            const details = sfp.parseHeaderValue(parser.getNetOptionValue(type));
            if ( details.bad ) { return; }
            const headerInfo = {
                header: details.name,
            };
            if ( details.value !== '' ) {
                if ( details.isRegex ) { return; }
                headerInfo.values = [ details.value ];
            }
            if ( details.not ) {
                rule.condition.excludedResponseHeaders = [ headerInfo ];
            } else {
                rule.condition.responseHeaders = [ headerInfo ];
            }
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_IMAGE:
            processResourceType('image', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_IMPORTANT:
            isImportant = true;
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_MATCHCASE:
            // (10.7.6) Only a URL pattern has a case; a hostname target (requestDomains) is lower-case anyway.
            if ( rule.condition.urlFilter !== undefined || rule.condition.regexFilter !== undefined ) {
                rule.condition.isUrlFilterCaseSensitive = true;
            }
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_MEDIA:
            processResourceType('media', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_METHOD: {
            const value = parser.getNetOptionValue(type);
            for ( const method of value.toLowerCase().split('|') ) {
                const not = method.charCodeAt(0) === 0x7E /* '~' */;
                if ( not ) {
                    excludedRequestMethods.add(method.slice(1));
                } else {
                    requestMethods.add(method);
                }
            }
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_OBJECT:
            processResourceType('object', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_OTHER:
            processResourceType('other', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_PERMISSIONS:
            if ( rule.action.responseHeaders ) { return; }
            rule.action.type = 'modifyHeaders';
            rule.action.responseHeaders = [ {
                header: 'permissions-policy',
                operation: 'append',
                value: parser.getNetOptionValue(type),
            } ];
            defaultResourceTypes.add('main_frame');
            defaultResourceTypes.add('sub_frame');
            defaultResourceTypes.add('object');
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_PING:
            processResourceType('ping', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_REASON:
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_REDIRECT: {
            if ( rule.action.type !== 'block' ) { return; }
            let value = parser.getNetOptionValue(type);
            const match = /:(\d+)$/.exec(value);
            if ( match ) {
                subpriority = Math.min(parseInt(match[1], 10) || 0, 8);
                value = value.slice(0, match.index);
            }
            if ( validRedirectResources.has(value) === false ) { return; }
            rule.action.type = 'redirect';
            rule.action.redirect = {
                extensionPath: `/web_accessible_resources/${validRedirectResources.get(value)}`,
            };
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM: {
            const details = sfp.parseQueryPruneValue(parser.getNetOptionValue(type));
            if ( details.bad ) { return; }
            if ( details.not ) { return; }
            if ( details.re ) { return; }
            const removeParams = [];
            if ( details.name ) {
                removeParams.push(details.name);
                if ( rule.condition.urlFilter === undefined ) {
                    if ( rule.condition.regexFilter === undefined ) {
                        rule.condition.urlFilter = `^${details.name}=`;
                    }
                }
            }
            rule.action.type = 'redirect';
            if ( removeParams.length !== 0 ) {
                rule.action.redirect = { transform: { queryTransform: { removeParams } } };
            } else {
                // (10.7.8) "$removeparam" without a value removes the whole query (AdGuard 5.5.2 semantics). Chrome
                // rejects an empty removeParams list, and a rule without an address would strip the query of every
                // page, so it is translated only when the line names an address: transform.query = '' (DNR: an
                // empty query removes the existing one).
                const c = rule.condition;
                if ( c.urlFilter === undefined && c.regexFilter === undefined && c.requestDomains === undefined ) { return; }
                rule.action.redirect = { transform: { query: '' } };
            }
            defaultResourceTypes.add('main_frame');
            defaultResourceTypes.add('sub_frame');
            defaultResourceTypes.add('xmlhttprequest');
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_SCRIPT:
            processResourceType('script', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_TO: {
            const { included, excluded } = parseHostnameList(
                parser.getNetFilterToOptionIterator()
            );
            if ( included.good.length === 0 ) {
                if ( included.bad.length !== 0 ) { return; }
            }
            if ( excluded.bad.length !== 0 ) { return; }
            for ( const hn of included.good ) {
                requestDomains.add(hn);
            }
            for ( const hn of excluded.good ) {
                excludedRequestDomains.add(hn);
            }
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_TOP: {
            const { included, excluded } = parseHostnameList(
                parser.getNetFilterTopOptionIterator()
            );
            if ( included.good.length === 0 ) {
                if ( included.bad.length !== 0 ) { return; }
            }
            if ( excluded.bad.length !== 0 ) { return; }
            for ( const hn of included.good ) {
                topDomains.add(hn);
            }
            for ( const hn of excluded.good ) {
                excludedTopDomains.add(hn);
            }
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_URLTRANSFORM: {
            const parsed = sfp.parseReplaceByRegexValue(parser.getNetOptionValue(type));
            if ( parsed === undefined ) { return; }
            if ( parsed.re ) { return; }
            rule.action.type = 'redirect';
            rule.action.redirect = {
                regexSubstitution: parsed.replacement.replace(/\$(\d+)/g, '\\$1'),
            };
            break;
        }
        case sfp.NODE_TYPE_NET_OPTION_NAME_XHR:
            processResourceType('xmlhttprequest', type);
            break;
        case sfp.NODE_TYPE_NET_OPTION_NAME_WEBSOCKET:
            processResourceType('websocket', type);
            break;
        default:
            break;
        }
    }
    if ( initiatorDomains.size !== 0 ) {
        rule.condition.initiatorDomains = Array.from(initiatorDomains).sort();
    }
    if ( excludedInitiatorDomains.size !== 0 ) {
        rule.condition.excludedInitiatorDomains = Array.from(excludedInitiatorDomains).sort();
    }
    if ( requestDomains.size !== 0 ) {
        rule.condition.requestDomains = Array.from(requestDomains).sort();
    }
    if ( excludedRequestDomains.size !== 0 ) {
        rule.condition.excludedRequestDomains = Array.from(excludedRequestDomains).sort();
    }
    if ( topDomains.size !== 0 ) {
        rule.condition.topDomains = Array.from(topDomains).sort();
    }
    if ( excludedTopDomains.size !== 0 ) {
        rule.condition.excludedTopDomains = Array.from(excludedTopDomains).sort();
    }
    if ( requestMethods.size !== 0 ) {
        rule.condition.requestMethods = Array.from(requestMethods).sort();
    }
    if ( excludedRequestMethods.size !== 0 ) {
        rule.condition.excludedRequestMethods = Array.from(excludedRequestMethods).sort();
    }
    if ( resourceTypes.size === 0 && excludedResourceTypes.size === 0 ) {
        defaultResourceTypes.forEach(a => resourceTypes.add(a));
    }
    if ( resourceTypes.size !== 0 ) {
        const types = Array.from(resourceTypes).filter(a => a !== '').sort();
        if ( types.length === 0 ) { return; }
        rule.condition.resourceTypes = types;
    }
    if ( excludedResourceTypes.size !== 0 && resourceTypes.size !== 0 ) {
        // (10.7.6) "$subdocument,~xmlhttprequest": both lists given — the rule applies to the named types
        // minus the excluded ones (ABP/AdGuard meaning). Dropping the whole rule (uBO) lost e.g.
        // "||pornpics.com^$subdocument,~xmlhttprequest".
        const kept = Array.from(resourceTypes).filter(a => a !== '' && excludedResourceTypes.has(a) === false).sort();
        if ( kept.length === 0 ) { return; }
        rule.condition.resourceTypes = kept;
        excludedResourceTypes.clear();
    }
    if ( excludedResourceTypes.size !== 0 ) {
        excludedResourceTypes.add('main_frame');
        rule.condition.excludedResourceTypes = Array.from(excludedResourceTypes).sort();
    }
    let priority = RULE_PRIORITY.DEFAULT;
    if ( rule.action.type === 'block' ) {
        priority = isImportant ? RULE_PRIORITY.BLOCK_IMPORTANT : RULE_PRIORITY.BLOCK;
    } else if ( rule.action.type === 'allow' ) {
        priority = RULE_PRIORITY.ALLOW;
    } else if ( rule.action.type === 'redirect' ) {
        if ( rule.action.redirect.extensionPath ) {
            if ( isException ) {
                rule.action.type = 'block';
                delete rule.action.redirect;
                priority = RULE_PRIORITY.EXCEPTED_REDIRECT;
            } else {
                priority = (isImportant ? RULE_PRIORITY.REDIRECT_IMPORTANT : RULE_PRIORITY.REDIRECT) + subpriority;
            }
        } else if ( rule.action.redirect.transform?.queryTransform?.removeParams || rule.action.redirect.transform?.query === '' ) {
            if ( isException ) { return; }
        } else if ( rule.action.redirect.regexSubstitution ) {
            if ( isException ) { return; }
        }
    } else if ( rule.action.type === 'modifyHeaders' ) {
        if ( isException ) { return; }
    }
    // (10.7.6) An exception to a removeparam / uritransform / CSP / permissions rule ("@@||site^$csp") means
    // "do not apply THAT rule here". DNR can only express it as an ALLOW of the whole request, which also
    // cancels every unrelated block for those request types (28 such allows in AdGuard Base, e.g.
    // "@@||uptostream.com^$csp=…"). The exception is dropped instead.
    if ( priority !== RULE_PRIORITY.DEFAULT ) {
        rule.priority = priority;
    }
    return rule;
}

/******************************************************************************/


