/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2020-present Raymond Hill

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
    Based on uBlock Origin (https://github.com/gorhill/uBlock), modified in
    2026 for uBlock-Stripped-Dynamic — see CHANGELOG.md for the changes.
*/

import { ArglistParser } from './arglist-parser.js';
import { JSONPath } from './jsonpath.js';

import {
    NODE_DOWN_INDEX,
    NODE_FLAG_ERROR,
    NODE_RIGHT_INDEX,
    NODE_TYPE_INDEX,
    NODE_TYPE_OPTION_VALUE_DOMAIN,
    NODE_TYPE_OPTION_VALUE_DOMAIN_RAW,
    NODE_TYPE_OPTION_VALUE_NOT,
} from './filter-ast-constants.js';

/******************************************************************************/
//
// filter-parser-helpers.js -- supporting classes and free-standing functions
// used by the filter-list parser (static-filtering-parser.js), extracted so
// that file can stay focused on the AstFilterParser state machine itself.
//
// Contents:
//   - escapeForRegex        shared string-escaping helper
//   - AstWalker              tree-walking utility for the AST produced by
//                             AstFilterParser
//   - DomainListIterator     iterates the domain list of a network/cosmetic
//                             filter's AST node
//   - parseQueryPruneValue, parseHeaderValue, parseReplaceByRegexValue,
//     parseReplaceValue      modifier-value parsers for $removeparam,
//                             $header/$responseheader, and $replace
//   - netOptionTokenDescriptors  network-rule option name -> descriptor map
//   - utils                  preparse-directive evaluation + misc helpers
//
// Split out of static-filtering-parser.js -- see CHANGELOG.md.
//
/******************************************************************************/

export function escapeForRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/******************************************************************************/

export class AstWalker {
    constructor(parser, from = 0) {
        this.parser = parser;
        this.stack = [];
        this.reset(from);
    }
    get depth() {
        return this.stackPtr;
    }
    reset(from = 0) {
        this.nodes = this.parser.nodes;
        this.stackPtr = 0;
        return (this.current = from || this.parser.rootNode);
    }
    next() {
        const current = this.current;
        if ( current === 0 ) { return 0; }
        const down = this.nodes[current+NODE_DOWN_INDEX];
        if ( down !== 0 ) {
            this.stack[this.stackPtr++] = this.current;
            return (this.current = down);
        }
        // No child: the rest of a depth-first step is exactly right() (10.7.6 — was a verbatim copy).
        return this.right();
    }
    right() {
        const current = this.current;
        if ( current === 0 ) { return 0; }
        const right = this.nodes[current+NODE_RIGHT_INDEX];
        if ( right !== 0 && this.stackPtr !== 0 ) {
            return (this.current = right);
        }
        while ( this.stackPtr !== 0 ) {
            const parent = this.stack[--this.stackPtr];
            const right = this.nodes[parent+NODE_RIGHT_INDEX];
            if ( right !== 0 ) {
                return (this.current = right);
            }
        }
        return (this.current = 0);
    }
    until(which) {
        let node = this.next();
        while ( node !== 0 ) {
            if ( this.nodes[node+NODE_TYPE_INDEX] === which ) { return node; }
            node = this.next();
        }
        return 0;
    }
    canGoDown() {
        return this.nodes[this.current+NODE_DOWN_INDEX] !== 0;
    }
    dispose() {
        this.parser.walkerJunkyard.push(this);
    }
}

/******************************************************************************/

export class DomainListIterator {
    constructor(parser, root) {
        this.parser = parser;
        this.walker = parser.getWalker();
        this.value = undefined;
        this.item = { hn: '', not: false, bad: false };
        this.reuse(root);
    }
    next() {
        if ( this.done ) { return this.value; }
        let node = this.walker.current;
        let ready = false;
        while ( node !== 0 ) {
            switch ( this.parser.getNodeType(node) ) {
            case NODE_TYPE_OPTION_VALUE_DOMAIN_RAW:
                this.item.hn = '';
                this.item.not = false;
                this.item.bad = this.parser.getNodeFlags(node, NODE_FLAG_ERROR) !== 0;
                break;
            case NODE_TYPE_OPTION_VALUE_NOT:
                this.item.not = true;
                break;
            case NODE_TYPE_OPTION_VALUE_DOMAIN:
                this.item.hn = this.parser.getNodeTransform(node);
                this.value = this.item;
                ready = true;
                break;
            default:
                break;
            }
            node = this.walker.next();
            if ( ready ) { return this; }
        }
        return this.stop();
    }
    reuse(root) {
        this.walker.reset(root);
        this.done = false;
        return this;
    }
    stop() {
        this.done = true;
        this.value = undefined;
        this.parser.domainListIteratorJunkyard.push(this);
        return this;
    }
    [Symbol.iterator]() {
        return this;
    }
}

/******************************************************************************/


/******************************************************************************/

export function parseQueryPruneValue(arg) {
    let s = arg.trim();
    if ( s === '' ) { return { all: true }; }
    const out = { };
    out.not = s.charCodeAt(0) === 0x7E /* '~' */;
    if ( out.not ) {
        s = s.slice(1);
    }
    const match = /^\/(.+)\/(i)?$/.exec(s);
    if ( match !== null ) {
        try {
            out.re = new RegExp(match[1], match[2] || '');
        }
        catch {
            out.bad = true;
        }
        return out;
    }
    // Checked 2026-07-28 against the live upstream lists this project
    // actually compiles from (tools/build-rulesets.mjs's own source
    // URLs): `$queryprune=` doesn't appear at all in AdGuard Base
    // (164152 lines), AdGuard TrackParam (3866 lines — the list most
    // likely to use a query-parameter modifier), AdGuard Antiadblock,
    // easylistitaly, or the Polish adblock list — so this legacy
    // `|prefix` variant specifically has no known current use anywhere
    // this project pulls from. Kept anyway: depends on AdGuard/EasyList's
    // own future authoring, not something this project controls.
    if ( s.startsWith('|') ) {
        try {
            out.re = new RegExp('^' + s.slice(1), 'i');
        } catch {
            out.bad = true;
        }
        return out;
    }
    // Multiple values not supported (because very inefficient)
    if ( s.includes('|') ) {
        out.bad = true;
        return out;
    }
    out.name = s;
    return out;
}

export function parseHeaderValue(arg) {
    let s = arg.trim();
    const out = { };
    let pos = s.indexOf(':');
    if ( pos === -1 ) { pos = s.length; }
    out.name = s.slice(0, pos).toLowerCase();
    out.bad = out.name === '';
    s = s.slice(pos + 1);
    out.not = s.charCodeAt(0) === 0x7E /* '~' */;
    if ( out.not ) { s = s.slice(1); }
    out.value = s;
    if ( s === '' ) { return out; }
    const match = /^\/(.+)\/(i)?$/.exec(s);
    out.isRegex = match !== null;
    if ( out.isRegex ) {
        out.reStr = match[1];
        out.reFlags = match[2] || '';
        try { new RegExp(out.reStr, out.reFlags); }
        catch { out.bad = true; }
        return out;
    }
    out.reFlags = 'i';
    if ( /[*?]/.test(s) === false ) {
        out.reStr = escapeForRegex(s);
        return out;
    }
    const reConstruct = /(?<!\\)[*?]/g;
    const reParts = [];
    let beg = 0;
    for (;;) {
        const match = reConstruct.exec(s);
        if ( match === null ) { break; }
        reParts.push(
            escapeForRegex(s.slice(beg, match.index)),
            match[0] === '*' ? '.*' : '.?',
        );
        beg = reConstruct.lastIndex;
    }
    reParts.push(escapeForRegex(s.slice(beg)));
    out.reStr = reParts.join('');
    return out;
}

// https://adguard.com/kb/general/ad-filtering/create-own-filters/#replace-modifier

export function parseReplaceByRegexValue(s) {
    if ( s.charCodeAt(0) !== 0x2F /* / */ ) { return; }
    const parser = new ArglistParser('/');
    parser.nextArg(s, 1);
    let pattern = s.slice(parser.argBeg, parser.argEnd);
    if ( parser.transform ) {
        pattern = parser.normalizeArg(pattern);
    }
    if ( pattern !== '' ) {
        pattern = parser.normalizeArg(pattern, '$');
        pattern = parser.normalizeArg(pattern, ',');
    }
    parser.nextArg(s, parser.separatorEnd);
    let replacement = s.slice(parser.argBeg, parser.argEnd);
    if ( parser.separatorEnd === parser.separatorBeg ) { return; }
    if ( parser.transform ) {
        replacement = parser.normalizeArg(replacement);
    }
    replacement = parser.normalizeArg(replacement, '$');
    replacement = parser.normalizeArg(replacement, ',');
    const flags = s.slice(parser.separatorEnd);
    if ( pattern === '' ) {
        return { flags, replacement }
    }
    try {
        return { re: new RegExp(pattern, flags), replacement };
    } catch { // benign: an invalid regex makes the filter invalid (undefined), reported by the caller
    }
}

export function parseReplaceValue(s) {
    if ( s.startsWith('/') ) {
        const r = parseReplaceByRegexValue(s);
        if ( r ) {
            if ( r.re === undefined ) { return; }
            r.type = 'text';
        }
        return r;
    }
    const pos = s.indexOf(':');
    if ( pos === -1 ) { return; }
    const type = s.slice(0, pos);
    if ( type === 'json' || type === 'jsonl' ) {
        const query = s.slice(pos+1);
        const jsonp = JSONPath.create(query);
        if ( jsonp.valid === false ) { return; }
        return { type, jsonp };
    }
}

/******************************************************************************/

export const netOptionTokenDescriptors = new Map([
    [ '1p', { canNegate: true } ],
    /* synonym */ [ 'first-party', { canNegate: true } ],
    [ 'strict1p', { } ],
    /* synonym */ [ 'strict-first-party', { } ],
    [ '3p', { canNegate: true } ],
    /* synonym */ [ 'third-party', { canNegate: true } ],
    [ 'strict3p', { } ],
    /* synonym */ [ 'strict-third-party', { } ],
    [ 'all', { } ],
    [ 'badfilter', { } ],
    [ 'cname', { allowOnly: true } ],
    [ 'csp', { mustAssign: true } ],
    [ 'css', { canNegate: true } ],
    /* synonym */ [ 'stylesheet', { canNegate: true } ],
    [ 'denyallow', { mustAssign: true } ],
    [ 'doc', { canNegate: true } ],
    /* synonym */ [ 'document', { canNegate: true } ],
    [ 'ehide', { } ],
    /* synonym */ [ 'elemhide', { } ],
    [ 'empty', { blockOnly: true } ],
    [ 'frame', { canNegate: true } ],
    /* synonym */ [ 'subdocument', { canNegate: true } ],
    [ 'from', { mustAssign: true } ],
    /* synonym */ [ 'domain', { mustAssign: true } ],
    [ 'font', { canNegate: true } ],
    [ 'genericblock', { } ],
    [ 'ghide', { } ],
    /* synonym */ [ 'generichide', { } ],
    [ 'image', { canNegate: true } ],
    [ 'important', { blockOnly: true } ],
    [ 'inline-font', { canNegate: true } ],
    [ 'inline-script', { canNegate: true } ],
    [ 'ipaddress', { mustAssign: true } ],
    [ 'match-case', { } ],
    [ 'media', { canNegate: true } ],
    [ 'method', { mustAssign: true } ],
    [ 'mp4', { blockOnly: true } ],
    [ '_', { } ],
    [ 'object', { canNegate: true } ],
    /* synonym */ [ 'object-subrequest', { canNegate: true } ],
    [ 'other', { canNegate: true } ],
    [ 'permissions', { mustAssign: true } ],
    [ 'ping', { canNegate: true } ],
    /* synonym */ [ 'beacon', { canNegate: true } ],
    [ 'popunder', { } ],
    [ 'popup', { canNegate: true } ],
    [ 'reason', { mustAssign: true } ],
    [ 'redirect', { mustAssign: true } ],
    /* synonym */ [ 'rewrite', { mustAssign: true } ],
    [ 'redirect-rule', { mustAssign: true } ],
    [ 'removeparam', { } ],
    /* synonym */ [ 'queryprune', { } ],
    [ 'replace', { mustAssign: true } ],
    [ 'requestheader', { mustAssign: true } ],
    [ 'responseheader', { mustAssign: true } ],
    /* synonym */ [ 'header', { mustAssign: true } ],
    [ 'script', { canNegate: true } ],
    [ 'shide', { } ],
    /* synonym */ [ 'specifichide', { } ],
    [ 'to', { mustAssign: true } ],
    [ 'top', { mustAssign: true } ],
    [ 'urlskip', { mustAssign: true } ],
    [ 'uritransform', { mustAssign: true } ],
    [ 'xhr', { canNegate: true } ],
    /* synonym */ [ 'xmlhttprequest', { canNegate: true } ],
    [ 'webrtc', { } ],
    [ 'websocket', { canNegate: true } ],
]);

/******************************************************************************/

export const utils = (( ) => {

    const preparserTokens = new Map([
        [ 'ext_ublock', 'ublock' ],
        [ 'ext_ubol', 'ubol' ],
        [ 'ext_devbuild', 'devbuild' ],
        [ 'env_chromium', 'chromium' ],
        [ 'env_edge', 'edge' ],
        [ 'env_firefox', 'firefox' ],
        [ 'env_legacy', 'legacy' ],
        [ 'env_mobile', 'mobile' ],
        [ 'env_mv3', 'mv3' ],
        [ 'env_safari', 'safari' ],
        [ 'cap_html_filtering', 'html_filtering' ],
        [ 'cap_user_stylesheet', 'user_stylesheet' ],
        [ 'cap_ipaddress', 'ipaddress' ],
        [ 'false', 'false' ],
        // Hoping ABP-only list maintainers can at least make use of it to
        // help non-ABP content blockers better deal with filters benefiting
        // only ABP.
        [ 'ext_abp', 'false' ],
        // Compatibility with other blockers
        // https://adguard.com/kb/general/ad-filtering/create-own-filters/#conditions-directive
        [ 'adguard', 'adguard' ],
        [ 'adguard_app_android', 'false' ],
        [ 'adguard_app_cli', 'false' ],
        [ 'adguard_app_ios', 'false' ],
        [ 'adguard_app_mac', 'false' ],
        [ 'adguard_app_windows', 'false' ],
        [ 'adguard_ext_android_cb', 'false' ],
        [ 'adguard_ext_chromium', 'chromium' ],
        [ 'adguard_ext_chromium_mv3', 'mv3' ],
        [ 'adguard_ext_edge', 'edge' ],
        [ 'adguard_ext_firefox', 'firefox' ],
        [ 'adguard_ext_opera', 'chromium' ],
        [ 'adguard_ext_safari', 'false' ],
    ]);

    function toURL(url) {
        try {
            return new URL(url.trim());
        } catch { // benign: an unparsable URL value makes the option invalid (undefined)
        }
    }

    // Useful reference:
    // https://adguard.com/kb/general/ad-filtering/create-own-filters/#conditions-directive

    class preparser {
        static evaluateExprToken(token, env = []) {
            const not = token.charCodeAt(0) === 0x21 /* ! */;
            if ( not ) { token = token.slice(1); }
            let state = preparserTokens.get(token);
            if ( state === undefined ) {
                if ( token.startsWith('cap_') === false ) { return; }
                state = 'false';
            }
            return state === 'false' && not || env.includes(state) !== not;
        }

        static evaluateExpr(expr, env = []) {
            if ( expr.startsWith('(') && expr.endsWith(')') ) {
                expr = expr.slice(1, -1);
            }
            const matches = Array.from(expr.matchAll(/(?:(?:&&|\|\|)\s+)?\S+/g));
            if ( matches.length === 0 ) { return; }
            if ( matches[0][0].startsWith('|') || matches[0][0].startsWith('&') ) { return; }
            let result = this.evaluateExprToken(matches[0][0], env);
            for ( let i = 1; i < matches.length; i++ ) {
                const parts = matches[i][0].split(/ +/);
                if ( parts.length !== 2 ) { return; }
                const state = this.evaluateExprToken(parts[1], env);
                if ( state === undefined ) { return; }
                if ( parts[0] === '||' ) {
                    result = result || state;
                } else if ( parts[0] === '&&' ) {
                    result = result && state;
                } else {
                    return;
                }
            }
            return result;
        }

        // This method returns an array of indices, corresponding to position in
        // the content string which should alternatively be parsed and discarded.
        static splitter(content, env = []) {
            const reIf = /^!#(if|else|endif)\b([^\n]*)(?:[\n\r]+|$)/gm;
            const stack = [];
            const parts = [ 0 ];
            let discard = false;

            function shouldDiscard() { return stack.some(v => v.known && v.discard); }

            function begif(details) {
                if ( discard === false && details.known && details.discard ) {
                    parts.push(details.pos);
                    discard = true;
                }
                stack.push(details);
            }

            function endif(match) {
                stack.pop();
                const stopDiscard = shouldDiscard() === false;
                if ( discard && stopDiscard ) {
                    parts.push(match.index + match[0].length);
                    discard = false;
                }
            }

            for (;;) {
                const match = reIf.exec(content);
                if ( match === null ) { break; }

                switch ( match[1] ) {
                case 'if': {
                    const result = this.evaluateExpr(match[2].trim(), env);
                    begif({
                        known: result !== undefined,
                        discard: result === false,
                        pos: match.index,
                    });
                    break;
                }
                case 'else': {
                    if ( stack.length === 0 ) { break; }
                    const details = stack[stack.length-1];
                    endif(match);
                    details.discard = details.discard === false;
                    details.pos = match.index;
                    begif(details);
                    break;
                }
                case 'endif': {
                    endif(match);
                    break;
                }
                default:
                    break;
                }
            }

            parts.push(content.length);
            return parts;
        }

        static expandIncludes(parts, env = []) {
            const out = [];
            const reInclude = /^!#include +(\S+)[^\n\r]*(?:[\n\r]+|$)/gm;
            for ( const part of parts ) {
                if ( typeof part === 'string' ) {
                    out.push(part);
                    continue;
                }
                if ( part instanceof Object === false ) { continue; }
                const content = part.content;
                const slices = this.splitter(content, env);
                for ( let i = 0, n = slices.length - 1; i < n; i++ ) {
                    const slice = content.slice(slices[i+0], slices[i+1]);
                    if ( (i & 1) !== 0 ) {
                        out.push(slice);
                        continue;
                    }
                    let lastIndex = 0;
                    for (;;) {
                        const match = reInclude.exec(slice);
                        if ( match === null ) { break; }
                        if ( toURL(match[1]) !== undefined ) { continue; }
                        if ( match[1].indexOf('..') !== -1 ) { continue; }
                        // Compute nested list path relative to parent list path
                        const pos = part.url.lastIndexOf('/');
                        if ( pos === -1 ) { continue; }
                        const subURL = part.url.slice(0, pos + 1) + match[1].trim();
                        out.push(
                            slice.slice(lastIndex, match.index + match[0].length),
                            `! >>>>>>>> ${subURL}\n`,
                            { url: subURL },
                            `! <<<<<<<< ${subURL}\n`
                        );
                        lastIndex = reInclude.lastIndex;
                    }
                    out.push(lastIndex === 0 ? slice : slice.slice(lastIndex));
                }
            }
            return out;
        }

        static prune(content, env) {
            const parts = this.splitter(content, env);
            const out = [];
            for ( let i = 0, n = parts.length - 1; i < n; i += 2 ) {
                const beg = parts[i+0];
                const end = parts[i+1];
                out.push(content.slice(beg, end));
            }
            return out.join('\n');
        }

        static getHints() {
            const out = [];
            const vals = new Set();
            for ( const [ key, val ] of preparserTokens ) {
                if ( vals.has(val) ) { continue; }
                vals.add(val);
                out.push(key);
            }
            return out;
        }

        static getTokens(env) {
            const out = new Map();
            for ( const [ key, val ] of preparserTokens ) {
                out.set(key, val !== 'false' && env.includes(val));
            }
            return Array.from(out);
        }
    }

    return {
        preparser,
    };
})();

/******************************************************************************/
