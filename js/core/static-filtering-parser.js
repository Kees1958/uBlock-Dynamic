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

/******************************************************************************/

/*******************************************************************************
 * 
 * The parser creates a simple unidirectional AST from a raw line of text.
 * Each node in the AST is a sequence of numbers, so as to avoid the need to
 * make frequent memory allocation to represent the AST.
 * 
 * All the AST nodes are allocated in the same integer-only array, which
 * array is reused when parsing new lines.
 * 
 * The AST can only be walked from top to bottom, then left to right.
 * 
 * Each node typically refer to a corresponding string slice in the source
 * text.
 *
 * It may happens a node requires to normalize the corresponding source slice,
 * in which case there will be a reference in the AST to a transformed source
 * string. (For example, a domain name might contain unicode characters, in
 * which case the corresponding node will contain a reference to the
 * (transformed) punycoded version of the domain name.)
 * 
 * The AST can be easily used for syntax coloring purpose, in which case it's
 * just a matter of walking through all the nodes in natural order.
 * 
 * A tree walking utility class exists for compilation and syntax coloring
 * purpose.
 * 
**/

/******************************************************************************/
//
// C1 note (single-responsibility audit, revised): this file was previously
// kept as one large monolithic module (see CHANGELOG.md, prior audit pass).
// With upstream-diffability no longer a constraint for this fork, it has
// since been split by concern:
//   - filter-ast-constants.js   AST/node type IDs, flags, lookup tables
//                                 (pure data -- see that file's header for
//                                 why the `iota` numbering lives there)
//   - filter-parser-helpers.js  AstWalker, DomainListIterator, standalone
//                                 modifier-value parsers, preparse-directive
//                                 evaluation (utils)
//   - ext-selector-compiler.js  ExtSelectorCompiler -- self-contained,
//                                 no dependency on AstFilterParser
//   - static-filtering-parser.js (this file) -- the AstFilterParser state
//                                 machine itself, plus a barrel re-export
//                                 section at the bottom that preserves the
//                                 exact public `sfp.*` surface all consumers
//                                 (ubo-parser.js, filter-editor.js,
//                                 compile-filters.js) already depend on.
//                                 No consumer needed to change: they still
//                                 `import * as sfp from './static-filtering-
//                                 parser.js'` and every `sfp.X` they used
//                                 before still resolves to the same value.
//
// AstFilterParser itself (the ~2,250-line class below) was intentionally
// NOT split further (owner, 10.7.11: keep it one class, make it readable): it is a single stateful tokenizer whose methods share
// internal state (the AST node array, cursor position). Splitting a
// stateful class's methods across files means either a mixin/prototype-
// composition rewrite or passing shared state through an external
// coordinator -- both are real behavioural rewrites, not mechanical moves,
// and neither was justified without a test suite to catch a bad extraction.
//
/******************************************************************************/

// ── READING MAP (10.7.11 — methods regrouped by flow, no code changed) ──────
//
// One line of filter text goes through:
//
//   parse(raw)                                         section 2
//     parseRaw()          whitespace, unicode, case flags
//     parseFilter()       decides the line type:
//       parseComment() / parsePreparseDirective()       section 2
//       parseNet()        network line  ── validateNet()  section 4
//         parseNetPattern()               URL pattern      section 5
//         parseNetOptions() / parseNetOption()  $options    section 6
//           parseDomainList()             domain= etc.     section 7
//       parseExt()        site##… line  ── validateExt()  section 8
//         parseDomainList()               the site list    section 7
//         parseExtPattern…()              cosmetic / scriptlet / HTML / header
//
// Consumers then read the result through the queries (section 3), the
// iterators and walker (section 12) and the node text accessors (section 10).
//
// Why one class: the AST is not a tree of objects but numbers in ONE shared
// Uint32Array (this.nodes — 16,384 entries, grown on demand by
// growNodePool(), section 9). Each node is a fixed run of slots (type,
// flags, begin/end offsets into this.raw, right/down links, transform).
// One instance is reused for every line: parse() resets the pointers
// instead of allocating, which is what keeps a whole-list build fast. All
// ~30 `this.` fields are that shared per-line state, read and written by
// every section — so the methods stay together on one class.
//
// Sections inside the class:
//    1. Construction and reset          7. Domain lists
//    2. Entry point, line classification 8. Extended filters
//    3. Result queries                  9. AST node pool
//    4. Network: structure, validation 10. Node text and transforms
//    5. Network: pattern               11. Text scanning helpers
//    6. Network: options               12. Iterators and tree walking
//
/******************************************************************************/

import { ArglistParser } from './arglist-parser.js';

import {
    AST_ERROR_DOMAIN_NAME,
    AST_ERROR_IF_TOKEN_UNKNOWN,
    AST_ERROR_OPTION_BADVALUE,
    AST_ERROR_OPTION_DUPLICATE,
    AST_ERROR_OPTION_EXCLUDED,
    AST_ERROR_OPTION_UNKNOWN,
    AST_ERROR_PATTERN,
    AST_ERROR_REGEX,
    AST_ERROR_UNTRUSTED_SOURCE,
    AST_FLAG_EXT_SCRIPTLET_ADG,
    AST_FLAG_EXT_STRONG,
    AST_FLAG_EXT_STYLE,
    AST_FLAG_HAS_ERROR,
    AST_FLAG_HAS_OPTIONS,
    AST_FLAG_IGNORE,
    AST_FLAG_IS_EXCEPTION,
    AST_FLAG_NET_PATTERN_LEFT_ANCHOR,
    AST_FLAG_NET_PATTERN_LEFT_HNANCHOR,
    AST_FLAG_NET_PATTERN_RIGHT_ANCHOR,
    AST_FLAG_NET_PATTERN_RIGHT_PATHANCHOR,
    AST_FLAG_UNSUPPORTED,
    AST_TYPE_COMMENT,
    AST_TYPE_COMMENT_PREPARSER,
    AST_TYPE_EXTENDED,
    AST_TYPE_EXTENDED_COSMETIC,
    AST_TYPE_EXTENDED_HTML,
    AST_TYPE_EXTENDED_RESPONSEHEADER,
    AST_TYPE_EXTENDED_SCRIPTLET,
    AST_TYPE_NETWORK,
    AST_TYPE_NETWORK_PATTERN_ANY,
    AST_TYPE_NETWORK_PATTERN_BAD,
    AST_TYPE_NETWORK_PATTERN_GENERIC,
    AST_TYPE_NETWORK_PATTERN_HOSTNAME,
    AST_TYPE_NETWORK_PATTERN_PLAIN,
    AST_TYPE_NETWORK_PATTERN_REGEX,
    AST_TYPE_NONE,
    AST_TYPE_UNKNOWN,
    DOMAIN_CAN_BE_ANCESTOR,
    DOMAIN_CAN_BE_NEGATED,
    DOMAIN_CAN_BE_REGEX,
    DOMAIN_CAN_HAVE_PATH,
    DOMAIN_CAN_USE_ENTITY,
    DOMAIN_CAN_USE_SINGLE_WILDCARD,
    DOMAIN_CAN_USE_WILDCARD,
    DOMAIN_FROM_DENYALLOW_LIST,
    DOMAIN_FROM_EXT_LIST,
    DOMAIN_FROM_FROMTO_LIST,
    FULL_NODE_SIZE,
    NODE_BEG_INDEX,
    NODE_DOWN_INDEX,
    NODE_END_INDEX,
    NODE_FLAGS_INDEX,
    NODE_FLAG_ERROR,
    NODE_FLAG_IGNORE,
    NODE_FLAG_IS_NEGATED,
    NODE_FLAG_OPTION_HAS_VALUE,
    NODE_RIGHT_INDEX,
    NODE_TRANSFORM_INDEX,
    NODE_TYPE_COMMENT,
    NODE_TYPE_COMMENT_URL,
    NODE_TYPE_COUNT,
    NODE_TYPE_EXT_DECORATION,
    NODE_TYPE_EXT_OPTIONS,
    NODE_TYPE_EXT_OPTIONS_ANCHOR,
    NODE_TYPE_EXT_PATTERN_COSMETIC,
    NODE_TYPE_EXT_PATTERN_HTML,
    NODE_TYPE_EXT_PATTERN_RAW,
    NODE_TYPE_EXT_PATTERN_RESPONSEHEADER,
    NODE_TYPE_EXT_PATTERN_SCRIPTLET,
    NODE_TYPE_EXT_PATTERN_SCRIPTLET_ARG,
    NODE_TYPE_EXT_PATTERN_SCRIPTLET_ARGS,
    NODE_TYPE_EXT_PATTERN_SCRIPTLET_TOKEN,
    NODE_TYPE_EXT_RAW,
    NODE_TYPE_IGNORE,
    NODE_TYPE_INDEX,
    NODE_TYPE_LINE_BODY,
    NODE_TYPE_LINE_RAW,
    NODE_TYPE_NET_EXCEPTION,
    NODE_TYPE_NET_OPTIONS,
    NODE_TYPE_NET_OPTIONS_ANCHOR,
    NODE_TYPE_NET_OPTION_ASSIGN,
    NODE_TYPE_NET_OPTION_NAME_1P,
    NODE_TYPE_NET_OPTION_NAME_3P,
    NODE_TYPE_NET_OPTION_NAME_ALL,
    NODE_TYPE_NET_OPTION_NAME_BADFILTER,
    NODE_TYPE_NET_OPTION_NAME_CNAME,
    NODE_TYPE_NET_OPTION_NAME_CSP,
    NODE_TYPE_NET_OPTION_NAME_CSS,
    NODE_TYPE_NET_OPTION_NAME_DENYALLOW,
    NODE_TYPE_NET_OPTION_NAME_DOC,
    NODE_TYPE_NET_OPTION_NAME_EHIDE,
    NODE_TYPE_NET_OPTION_NAME_EMPTY,
    NODE_TYPE_NET_OPTION_NAME_FONT,
    NODE_TYPE_NET_OPTION_NAME_FRAME,
    NODE_TYPE_NET_OPTION_NAME_FROM,
    NODE_TYPE_NET_OPTION_NAME_GENERICBLOCK,
    NODE_TYPE_NET_OPTION_NAME_GHIDE,
    NODE_TYPE_NET_OPTION_NAME_IMAGE,
    NODE_TYPE_NET_OPTION_NAME_IMPORTANT,
    NODE_TYPE_NET_OPTION_NAME_INLINEFONT,
    NODE_TYPE_NET_OPTION_NAME_INLINESCRIPT,
    NODE_TYPE_NET_OPTION_NAME_IPADDRESS,
    NODE_TYPE_NET_OPTION_NAME_MATCHCASE,
    NODE_TYPE_NET_OPTION_NAME_MEDIA,
    NODE_TYPE_NET_OPTION_NAME_METHOD,
    NODE_TYPE_NET_OPTION_NAME_MP4,
    NODE_TYPE_NET_OPTION_NAME_NOOP,
    NODE_TYPE_NET_OPTION_NAME_NOT,
    NODE_TYPE_NET_OPTION_NAME_OBJECT,
    NODE_TYPE_NET_OPTION_NAME_OTHER,
    NODE_TYPE_NET_OPTION_NAME_PERMISSIONS,
    NODE_TYPE_NET_OPTION_NAME_PING,
    NODE_TYPE_NET_OPTION_NAME_POPUNDER,
    NODE_TYPE_NET_OPTION_NAME_POPUP,
    NODE_TYPE_NET_OPTION_NAME_REASON,
    NODE_TYPE_NET_OPTION_NAME_REDIRECT,
    NODE_TYPE_NET_OPTION_NAME_REDIRECTRULE,
    NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM,
    NODE_TYPE_NET_OPTION_NAME_REPLACE,
    NODE_TYPE_NET_OPTION_NAME_REQUESTHEADER,
    NODE_TYPE_NET_OPTION_NAME_RESPONSEHEADER,
    NODE_TYPE_NET_OPTION_NAME_SCRIPT,
    NODE_TYPE_NET_OPTION_NAME_SHIDE,
    NODE_TYPE_NET_OPTION_NAME_STRICT1P,
    NODE_TYPE_NET_OPTION_NAME_STRICT3P,
    NODE_TYPE_NET_OPTION_NAME_TO,
    NODE_TYPE_NET_OPTION_NAME_TOP,
    NODE_TYPE_NET_OPTION_NAME_UNKNOWN,
    NODE_TYPE_NET_OPTION_NAME_URLSKIP,
    NODE_TYPE_NET_OPTION_NAME_URLTRANSFORM,
    NODE_TYPE_NET_OPTION_NAME_WEBRTC,
    NODE_TYPE_NET_OPTION_NAME_WEBSOCKET,
    NODE_TYPE_NET_OPTION_NAME_XHR,
    NODE_TYPE_NET_OPTION_QUOTE,
    NODE_TYPE_NET_OPTION_RAW,
    NODE_TYPE_NET_OPTION_SENTINEL,
    NODE_TYPE_NET_OPTION_SEPARATOR,
    NODE_TYPE_NET_OPTION_VALUE,
    NODE_TYPE_NET_PATTERN,
    NODE_TYPE_NET_PATTERN_LEFT_ANCHOR,
    NODE_TYPE_NET_PATTERN_LEFT_HNANCHOR,
    NODE_TYPE_NET_PATTERN_PART,
    NODE_TYPE_NET_PATTERN_PART_SPECIAL,
    NODE_TYPE_NET_PATTERN_PART_UNICODE,
    NODE_TYPE_NET_PATTERN_RAW,
    NODE_TYPE_NET_PATTERN_RIGHT_ANCHOR,
    NODE_TYPE_NET_RAW,
    NODE_TYPE_NOOP,
    NODE_TYPE_OPTION_VALUE_DOMAIN,
    NODE_TYPE_OPTION_VALUE_DOMAIN_LIST,
    NODE_TYPE_OPTION_VALUE_DOMAIN_RAW,
    NODE_TYPE_OPTION_VALUE_NOT,
    NODE_TYPE_OPTION_VALUE_SEPARATOR,
    NODE_TYPE_PREPARSE_DIRECTIVE,
    NODE_TYPE_PREPARSE_DIRECTIVE_IF_VALUE,
    NODE_TYPE_PREPARSE_DIRECTIVE_VALUE,
    NODE_TYPE_WHITESPACE,
    NOOP_NODE_SIZE,
    astTemplates,
    nodeNameFromNodeType,
    nodeTypeFromOptionName,
    removableHTTPHeaders
} from './filter-ast-constants.js';

import {
    AstWalker,
    DomainListIterator,
    escapeForRegex,
    parseReplaceByRegexValue,
    parseReplaceValue,
    netOptionTokenDescriptors,
    utils,
} from './filter-parser-helpers.js';

import { ExtSelectorCompiler } from './ext-selector-compiler.js';

/******************************************************************************/

function exCharCodeAt(s, i) {
    const pos = i >= 0 ? i : s.length + i;
    return pos >= 0 ? s.charCodeAt(pos) : -1;
}

/******************************************************************************/

export class AstFilterParser {
    /* ══════════════════════════════════════════════════════════════
       1. CONSTRUCTION AND RESET
       one instance is created once and reused for every line (see the map above)
       ══════════════════════════════════════════════════════════════ */

    constructor(options = {}) {
        this.raw = '';
        this.rawEnd = 0;
        this.nodes = new Uint32Array(16384);
        this.nodePoolPtr = FULL_NODE_SIZE;
        this.nodePoolEnd = this.nodes.length;
        this.astTransforms = [ null ];
        this.astTransformPtr = 1;
        this.rootNode = 0;
        this.astType = AST_TYPE_NONE;
        this.astTypeFlavor = AST_TYPE_NONE;
        this.astFlags = 0;
        this.astError = 0;
        this.nodeTypeRegister = [];
        this.nodeTypeRegisterPtr = 0;
        this.nodeTypeLookupTable = new Uint32Array(NODE_TYPE_COUNT);
        this.punycoder = new URL('https://ublock0.invalid/');
        this.domainListIteratorJunkyard = [];
        this.walkerJunkyard = [];
        this.hasWhitespace = false;
        this.hasUnicode = false;
        this.hasUppercase = false;
        // Options
        this.options = options;
        this.interactive = options.interactive || false;
        this.badTypes = new Set(options.badTypes || []);
        this.maxTokenLength = options.maxTokenLength || 7;
        // TODO: rethink this
        this.result = { exception: false, raw: '', compiled: '', error: undefined };
        this.selectorCompiler = new ExtSelectorCompiler(options);
        // Regexes
        this.reWhitespaceStart = /^\s+/;
        this.reWhitespaceEnd = /(?:^|\S)(\s+)$/;
        this.reCommentLine = /^(?:!|#\s|####|\[adblock)/i;
        this.reExtAnchor = /(#@?(?:\$\?|\$|%|\?)?#).{1,2}/;
        this.reInlineComment = /(?:\s+#).*?$/;
        this.reNetException = /^@@/;
        this.reNetAnchor = /(?:)\$[^,\w~]/;
        this.reHnAnchoredPlainAscii = /^\|\|[0-9a-z%&,\-./:;=?_]+$/;
        this.reHnAnchoredHostnameAscii = /^\|\|(?:[\da-z][\da-z_-]*\.)*[\da-z_-]*[\da-z]\^$/;
        this.reHnAnchoredHostnameUnicode = /^\|\|(?:[\p{L}\p{N}][\p{L}\p{N}\u{2d}]*\.)*[\p{L}\p{N}\u{2d}]*[\p{L}\p{N}]\^$/u;
        this.reHn3pAnchoredHostnameAscii = /^\|\|(?:[\da-z][\da-z_-]*\.)*[\da-z_-]*[\da-z]\^\$third-party$/;
        this.rePlainAscii = /^[0-9a-z%&\-./:;=?_]{2,}$/;
        this.reNetHosts1 = /^127\.0\.0\.1 (?:[\da-z][\da-z_-]*\.)+[\da-z-]*[a-z]$/;
        this.reNetHosts2 = /^0\.0\.0\.0 (?:[\da-z][\da-z_-]*\.)+[\da-z-]*[a-z]$/;
        this.rePlainGenericCosmetic = /^##[.#][A-Za-z_][\w-]*$/;
        this.reHostnameAscii = /^(?:[\da-z][\da-z_-]*\.)*[\da-z][\da-z-]*[\da-z]$/;
        this.rePlainEntity = /^(?:[\da-z][\da-z_-]*\.)+\*$/;
        this.reHostsSink = /^[\w%.:[\]-]+\s+/;
        this.reHostsRedirect = /(?:0\.0\.0\.0|broadcasthost|local|localhost(?:\.localdomain)?|ip6-\w+)(?:[^\w.-]|$)/;
        this.reNetOptionComma = /,(?:~?[13a-z-]+(?:=.*?)?|_+)(?:,|$)/;
        this.rePointlessLeftAnchor = /^\|\|?\*+/;
        this.rePointlessLeadingWildcards = /^(\*+)[^%0-9A-Za-z\u{a0}-\u{10FFFF}]/u;
        this.rePointlessTrailingSeparator = /\*(\^\**)$/;
        this.rePointlessTrailingWildcards = /(?:[^%0-9A-Za-z]|[%0-9A-Za-z]{7,})(\*+)$/;
        this.reHasWhitespaceChar = /\s/;
        this.reHasUppercaseChar = /[A-Z]/;
        this.reHasUnicodeChar = /[^\x00-\x7F]/;
        this.reUnicodeChars = /\P{ASCII}/gu;
        this.reBadHostnameChars = /[\x00-\x24\x26-\x29\x2b\x2c\x2f\x3b-\x40\x5c\x5e\x60\x7b-\x7f]/;
        this.reIsEntity = /^[^*]+\.\*$/;
        this.rePreparseDirectiveIf = /^!#if /;
        this.rePreparseDirectiveAny = /^!#(?:else|endif|if |include )/;
        this.reURL = /\bhttps?:\/\/\S+/;
        this.reHasPatternSpecialChars = /[*^]/;
        this.rePatternAllSpecialChars = /[*^]+|[^\x00-\x7f]+/g;
        // https://github.com/uBlockOrigin/uBlock-issues/issues/1146
        //   From https://codemirror.net/doc/manual.html#option_specialChars
        this.reHasInvalidChar = /[\x00-\x1F\x7F-\x9F\xAD\u061C\u200B-\u200F\u2028\u2029\uFEFF\uFFF9-\uFFFC]/;
        this.reHostnamePatternPart = /^[^\x00-\x24\x26-\x29\x2B\x2C\x2F\x3A-\x40\x5B-\x5E\x60\x7B-\x7F]+/;
        this.reHostnameLabel = /[^.]+/g;
        this.reResponseheaderPattern = /^\^responseheader\(.*\)$/;
        this.rePatternScriptletJsonArgs = /^\{.*\}$/;
        this.reBadCSP = /(?:^|[;,])\s*report-(?:to|uri)\b/i;
        this.reBadPP = /(?:^|[;,])\s*report-to\b/i;
        this.reNetOption = /^(~?)([134a-z_-]+)(=?)/;
        this.reNoopOption = /^_+$/;
        this.reAdvancedDomainSyntax = /^([^>]+?)(>>)?(\/.*)?$/;
        this.netOptionValueParser = new ArglistParser(',');
        this.scriptletArgListParser = new ArglistParser(',');
        this.domainRegexValueParser = new ArglistParser('/');
        this.reNetOptionTokens = new RegExp(
            `^~?(${Array.from(netOptionTokenDescriptors.keys())
                .map(s => escapeForRegex(s))
                .join('|')})\\b`
        );
    }

    finish() {
        this.selectorCompiler.finish();
    }

    /* ══════════════════════════════════════════════════════════════
       2. ENTRY POINT AND LINE CLASSIFICATION
       parse() -> parseRaw() -> parseFilter() -> comment / preparse / network / extended
       ══════════════════════════════════════════════════════════════ */

    parse(raw) {
        this.raw = raw;
        this.rawEnd = raw.length;
        this.nodePoolPtr = FULL_NODE_SIZE;
        this.nodeTypeRegisterPtr = 0;
        this.astTransformPtr = 1;
        this.astType = AST_TYPE_NONE;
        this.astTypeFlavor = AST_TYPE_NONE;
        this.astFlags = 0;
        this.astError = 0;
        this.rootNode = this.allocTypedNode(NODE_TYPE_LINE_RAW, 0, this.rawEnd);
        if ( this.rawEnd === 0 ) { return; }

        // Fast-track very common simple filters using pre-computed AST layouts
        // to skip parsing and validation.
        const c1st = this.raw.charCodeAt(0);
        const clast = exCharCodeAt(this.raw, -1);
        if ( c1st === 0x7C /* | */ ) {
            if (
                clast === 0x5E /* ^ */ &&
                this.reHnAnchoredHostnameAscii.test(this.raw)
            ) {
                // ||example.com^
                this.astType = AST_TYPE_NETWORK;
                this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_HOSTNAME;
                const node = this.astFromTemplate(this.rootNode,
                    astTemplates.netHnAnchoredHostnameAscii
                );
                this.linkDown(this.rootNode, node);
                return;
            }
            if (
                this.raw.endsWith('$third-party') &&
                this.reHn3pAnchoredHostnameAscii.test(this.raw)
            ) {
                // ||example.com^$third-party
                this.astType = AST_TYPE_NETWORK;
                this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_HOSTNAME;
                const node = this.astFromTemplate(this.rootNode,
                    astTemplates.net3pHnAnchoredHostnameAscii
                );
                this.linkDown(this.rootNode, node);
                return;
            }
            if ( this.reHnAnchoredPlainAscii.test(this.raw) ) {
                // ||example.com/path/to/resource
                this.astType = AST_TYPE_NETWORK;
                this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_PLAIN;
                const node = this.astFromTemplate(this.rootNode,
                    astTemplates.netHnAnchoredPlainAscii
                );
                this.linkDown(this.rootNode, node);
                return;
            }
        } else if ( c1st === 0x23 /* # */ ) {
            if ( this.rePlainGenericCosmetic.test(this.raw) ) {
                // ##.ads-container
                this.astType = AST_TYPE_EXTENDED;
                this.astTypeFlavor = AST_TYPE_EXTENDED_COSMETIC;
                const node = this.astFromTemplate(this.rootNode,
                    astTemplates.extPlainGenericSelector
                );
                this.linkDown(this.rootNode, node);
                this.result.exception = false;
                this.result.raw = this.raw.slice(2);
                this.result.compiled = this.raw.slice(2);
                return;
            }
        } else if ( c1st === 0x31 /* 1 */ ) {
            if ( this.reNetHosts1.test(this.raw) ) {
                // 127.0.0.1 example.com
                this.astType = AST_TYPE_NETWORK;
                this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_HOSTNAME;
                const node = this.astFromTemplate(this.rootNode,
                    astTemplates.netHosts1
                );
                this.linkDown(this.rootNode, node);
                return;
            }
        } else if ( c1st === 0x30 /* 0 */ ) {
            if ( this.reNetHosts2.test(this.raw) ) {
                // 0.0.0.0 example.com
                this.astType = AST_TYPE_NETWORK;
                this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_HOSTNAME;
                const node = this.astFromTemplate(this.rootNode,
                    astTemplates.netHosts2
                );
                this.linkDown(this.rootNode, node);
                return;
            }
        } else if (
            (c1st !== 0x2F /* / */ || clast !== 0x2F /* / */) &&
            (this.rePlainAscii.test(this.raw))
        ) {
            // example.com
            // -resource.
            this.astType = AST_TYPE_NETWORK;
            this.astTypeFlavor = this.reHostnameAscii.test(this.raw)
                ? AST_TYPE_NETWORK_PATTERN_HOSTNAME
                : AST_TYPE_NETWORK_PATTERN_PLAIN;
            const node = this.astFromTemplate(this.rootNode,
                astTemplates.netPlainAscii
            );
            this.linkDown(this.rootNode, node);
            return;
        }

        // All else: full parsing and validation.
        this.hasWhitespace = this.reHasWhitespaceChar.test(raw);
        this.linkDown(this.rootNode, this.parseRaw(this.rootNode));
    }

    astFromTemplate(parent, template) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        const beg = template.beg + (template.beg >= 0 ? parentBeg : parentEnd);
        const end = template.end + (template.end <= 0 ? parentEnd : parentBeg);
        const node = this.allocTypedNode(template.type, beg, end);
        if ( template.register ) {
            this.addNodeToRegister(template.type, node);
        }
        if ( template.flags ) {
            this.addFlags(template.flags);
        }
        if ( template.nodeFlags ) {
            this.addNodeFlags(node, template.nodeFlags);
        }
        const children = template.children;
        if ( children === undefined ) { return node; }
        const head = this.astFromTemplate(node, children[0]);
        this.linkDown(node, head);
        const n = children.length;
        if ( n === 1 ) { return node; }
        let prev = head;
        for ( let i = 1; i < n; i++ ) {
            prev = this.linkRight(prev, this.astFromTemplate(node, children[i]));
        }
        return node;
    }

    parseRaw(parent) {
        const head = this.allocHeadNode();
        let prev = head, next = 0;
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        const l1 = this.hasWhitespace
            ? this.leftWhitespaceCount(this.getNodeString(parent))
            : 0;
        if ( l1 !== 0 ) {
            next = this.allocTypedNode(
                NODE_TYPE_WHITESPACE,
                parentBeg,
                parentBeg + l1
            );
            prev = this.linkRight(prev, next);
            if ( l1 === parentEnd ) { return this.throwHeadNode(head); }
        }
        const r0 = this.hasWhitespace
            ? parentEnd - this.rightWhitespaceCount(this.getNodeString(parent))
            : parentEnd;
        if ( r0 !== l1 ) {
            next = this.allocTypedNode(
                NODE_TYPE_LINE_BODY,
                parentBeg + l1,
                parentBeg + r0
            );
            this.linkDown(next, this.parseFilter(next));
            prev = this.linkRight(prev, next);
        }
        if ( r0 !== parentEnd ) {
            next = this.allocTypedNode(
                NODE_TYPE_WHITESPACE,
                parentBeg + r0,
                parentEnd
            );
            this.linkRight(prev, next);
        }
        return this.throwHeadNode(head);
    }

    parseFilter(parent) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        const parentStr = this.getNodeString(parent);

        // A comment?
        if ( this.reCommentLine.test(parentStr) ) {
            const head = this.allocTypedNode(NODE_TYPE_COMMENT, parentBeg, parentEnd);
            this.astType = AST_TYPE_COMMENT;
            if ( this.interactive ) {
                this.linkDown(head, this.parseComment(head));
            }
            return head;
        }

        // An extended filter? (or rarely, a comment)
        if ( this.reExtAnchor.test(parentStr) ) {
            const match = this.reExtAnchor.exec(parentStr);
            const matchLen = match[1].length;
            const head = this.allocTypedNode(NODE_TYPE_EXT_RAW, parentBeg, parentEnd);
            this.linkDown(head, this.parseExt(head, parentBeg + match.index, matchLen));
            return head;
        } else if ( parentStr.charCodeAt(0) === 0x23 /* # */ ) {
            const head = this.allocTypedNode(NODE_TYPE_COMMENT, parentBeg, parentEnd);
            this.astType = AST_TYPE_COMMENT;
            return head;
        }

        // Good to know in advance to avoid costly tests later on
        this.hasUppercase = this.reHasUppercaseChar.test(parentStr);
        this.hasUnicode = this.reHasUnicodeChar.test(parentStr);

        // A network filter (probably)
        this.astType = AST_TYPE_NETWORK;

        // Parse inline comment if any
        let tail = 0, tailStart = parentEnd;
        if ( this.hasWhitespace && this.reInlineComment.test(parentStr) ) {
            const match = this.reInlineComment.exec(parentStr);
            tailStart = parentBeg + match.index;
            tail = this.allocTypedNode(NODE_TYPE_COMMENT, tailStart, parentEnd);
        }

        const head = this.allocTypedNode(NODE_TYPE_NET_RAW, parentBeg, tailStart);
        if ( this.linkDown(head, this.parseNet(head)) === 0 ) {
            this.astType = AST_TYPE_UNKNOWN;
            this.addFlags(AST_FLAG_UNSUPPORTED | AST_FLAG_HAS_ERROR);
        }
        if ( tail !== 0 ) {
            this.linkRight(head, tail);
        }
        return head;
    }

    parseComment(parent) {
        const parentStr = this.getNodeString(parent);
        if ( this.rePreparseDirectiveAny.test(parentStr) ) {
            this.astTypeFlavor = AST_TYPE_COMMENT_PREPARSER;
            return this.parsePreparseDirective(parent, parentStr);
        }
        if ( this.reURL.test(parentStr) === false ) { return 0; }
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        const match = this.reURL.exec(parentStr);
        const urlBeg = parentBeg + match.index;
        const urlEnd = urlBeg + match[0].length;
        const head = this.allocTypedNode(NODE_TYPE_COMMENT, parentBeg, urlBeg);
        let next = this.allocTypedNode(NODE_TYPE_COMMENT_URL, urlBeg, urlEnd);
        let prev = this.linkRight(head, next);
        if ( urlEnd !== parentEnd ) {
            next = this.allocTypedNode(NODE_TYPE_COMMENT, urlEnd, parentEnd);
            this.linkRight(prev, next);
        }
        return head;
    }

    parsePreparseDirective(parent, s) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        const match = this.rePreparseDirectiveAny.exec(s);
        const directiveEnd = parentBeg + match[0].length;
        const head = this.allocTypedNode(
            NODE_TYPE_PREPARSE_DIRECTIVE,
            parentBeg,
            directiveEnd
        );
        if ( directiveEnd !== parentEnd ) {
            const type = s.startsWith('!#if ')
                ? NODE_TYPE_PREPARSE_DIRECTIVE_IF_VALUE
                : NODE_TYPE_PREPARSE_DIRECTIVE_VALUE;
            const next = this.allocTypedNode(type, directiveEnd, parentEnd);
            this.addNodeToRegister(type, next);
            this.linkRight(head, next);
            if ( type === NODE_TYPE_PREPARSE_DIRECTIVE_IF_VALUE ) {
                const rawToken = this.getNodeString(next).trim();
                if ( utils.preparser.evaluateExpr(rawToken) === undefined ) {
                    this.addNodeFlags(next, NODE_FLAG_ERROR);
                    this.addFlags(AST_FLAG_HAS_ERROR);
                    this.astError = AST_ERROR_IF_TOKEN_UNKNOWN;
                }
            }
        }
        return head;
    }

    /* ══════════════════════════════════════════════════════════════
       3. RESULT QUERIES
       what the last parsed line is: type, flavour, flags, error state
       ══════════════════════════════════════════════════════════════ */

    getType() {
        return this.astType;
    }

    isComment() {
        return this.astType === AST_TYPE_COMMENT;
    }

    isFilter() {
        return this.isNetworkFilter() || this.isExtendedFilter();
    }

    isNetworkFilter() {
        return this.astType === AST_TYPE_NETWORK;
    }

    isExtendedFilter() {
        return this.astType === AST_TYPE_EXTENDED;
    }

    isCosmeticFilter() {
        return this.astType === AST_TYPE_EXTENDED &&
            this.astTypeFlavor === AST_TYPE_EXTENDED_COSMETIC;
    }

    isScriptletFilter() {
        return this.astType === AST_TYPE_EXTENDED &&
            this.astTypeFlavor === AST_TYPE_EXTENDED_SCRIPTLET;
    }

    isHtmlFilter() {
        return this.astType === AST_TYPE_EXTENDED &&
            this.astTypeFlavor === AST_TYPE_EXTENDED_HTML;
    }

    isResponseheaderFilter() {
        return this.astType === AST_TYPE_EXTENDED &&
            this.astTypeFlavor === AST_TYPE_EXTENDED_RESPONSEHEADER;
    }

    getFlags(flags = 0xFFFFFFFF) {
        return this.astFlags & flags;
    }

    addFlags(flags) {
        this.astFlags |= flags;
    }

    hasError() {
        return (this.astFlags & AST_FLAG_HAS_ERROR) !== 0;
    }

    isUnsupported() {
        return (this.astFlags & AST_FLAG_UNSUPPORTED) !== 0;
    }

    hasOptions() {
        return (this.astFlags & AST_FLAG_HAS_OPTIONS) !== 0;
    }

    isNegatedOption(type) {
        const node = this.nodeTypeLookupTable[type];
        const flags = this.nodes[node+NODE_FLAGS_INDEX];
        return (flags & NODE_FLAG_IS_NEGATED) !== 0;
    }

    isException() {
        return (this.astFlags & AST_FLAG_IS_EXCEPTION) !== 0;
    }

    isLeftHnAnchored() {
        return (this.astFlags & AST_FLAG_NET_PATTERN_LEFT_HNANCHOR) !== 0;
    }

    isLeftAnchored() {
        return (this.astFlags & AST_FLAG_NET_PATTERN_LEFT_ANCHOR) !== 0;
    }

    isRightAnchored() {
        return (this.astFlags & AST_FLAG_NET_PATTERN_RIGHT_ANCHOR) !== 0;
    }

    /* ══════════════════════════════════════════════════════════════
       4. NETWORK FILTERS — STRUCTURE AND VALIDATION
       splits a network line into exception mark, pattern and options; validateNet() checks the option combination
       ══════════════════════════════════════════════════════════════ */

    // Very common, look into fast-tracking such plain pattern:
    // /^[^!#\$\*\^][^#\$\*\^]*[^\$\*\|]$/
    parseNet(parent) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        const parentStr = this.getNodeString(parent);
        const head = this.allocHeadNode();
        let patternBeg = parentBeg;
        let prev = head, next = 0, tail = 0;
        if ( this.reNetException.test(parentStr) ) {
            this.addFlags(AST_FLAG_IS_EXCEPTION);
            next = this.allocTypedNode(NODE_TYPE_NET_EXCEPTION, parentBeg, parentBeg+2);
            prev = this.linkRight(prev, next);
            patternBeg += 2;
        }
        let anchorBeg = this.indexOfNetAnchor(parentStr);
        if ( anchorBeg === -1 ) { return 0; }
        anchorBeg += parentBeg;
        if ( anchorBeg !== parentEnd ) {
            tail = this.allocTypedNode(
                NODE_TYPE_NET_OPTIONS_ANCHOR,
                anchorBeg,
                anchorBeg + 1
            );
            next = this.allocTypedNode(
                NODE_TYPE_NET_OPTIONS,
                anchorBeg + 1,
                parentEnd
            );
            this.addFlags(AST_FLAG_HAS_OPTIONS);
            this.addNodeToRegister(NODE_TYPE_NET_OPTIONS, next);
            this.linkDown(next, this.parseNetOptions(next));
            this.linkRight(tail, next);
        }
        next = this.allocTypedNode(
            NODE_TYPE_NET_PATTERN_RAW,
            patternBeg,
            anchorBeg
        );
        this.addNodeToRegister(NODE_TYPE_NET_PATTERN_RAW, next);
        this.linkDown(next, this.parseNetPattern(next));
        prev = this.linkRight(prev, next);
        if ( tail !== 0 ) {
            this.linkRight(prev, tail);
        }
        if ( this.astType === AST_TYPE_NETWORK ) {
            this.validateNet();
        }
        return this.throwHeadNode(head);
    }

    // Checks a parsed network line's options, in two passes:
    //   Pass 1 — every option on its own (loop + switch below): is it negated or
    //            given a value where that is not allowed, and which counter it
    //            adds to (request types, document types, "behaviour" options like
    //            ehide, abstract types like popup). A "modifier" option (csp,
    //            redirect, removeparam, replace, …) is remembered in modifierType;
    //            only one modifier is allowed per line.
    //   Pass 2 — the modifier against those counters (second switch): e.g. a
    //            redirect cannot be combined with types it cannot redirect.
    // A bad option gets NODE_FLAG_ERROR on its node; a real error also sets
    // AST_FLAG_HAS_ERROR on the line.
    validateNet() {
        const isException = this.isException();
        let bad = false, realBad = false;
        let abstractTypeCount = 0;
        let behaviorTypeCount = 0;
        let docTypeCount = 0;
        let modifierType = 0;
        let requestTypeCount = 0;
        let unredirectableTypeCount = 0;
        let isBadfilter = false;
        for ( let i = 0, n = this.nodeTypeRegisterPtr; i < n; i++ ) {
            const type = this.nodeTypeRegister[i];
            const targetNode = this.nodeTypeLookupTable[type];
            if ( targetNode === 0 ) { continue; }
            if ( this.badTypes.has(type) ) {
                this.addNodeFlags(NODE_FLAG_ERROR);
                this.addFlags(AST_FLAG_HAS_ERROR);
                this.astError = AST_ERROR_OPTION_EXCLUDED;
            }
            const flags = this.getNodeFlags(targetNode);
            if ( (flags & NODE_FLAG_ERROR) !== 0 ) { continue; }
            const isNegated = (flags & NODE_FLAG_IS_NEGATED) !== 0;
            const hasValue = (flags & NODE_FLAG_OPTION_HAS_VALUE) !== 0;
            bad = false; realBad = false;
            switch ( type ) {
            // ── pass 1: party and meta options ──
            case NODE_TYPE_NET_OPTION_NAME_ALL:
                realBad = isNegated || hasValue || modifierType !== 0;
                break;
            case NODE_TYPE_NET_OPTION_NAME_1P:
            case NODE_TYPE_NET_OPTION_NAME_3P:
                realBad = hasValue;
                break;
            case NODE_TYPE_NET_OPTION_NAME_BADFILTER:
                isBadfilter = true;
                /* falls through */
            case NODE_TYPE_NET_OPTION_NAME_NOOP:
                realBad = isNegated || hasValue;
                break;
            // ── request types (counted) ──
            case NODE_TYPE_NET_OPTION_NAME_CSS:
            case NODE_TYPE_NET_OPTION_NAME_FONT:
            case NODE_TYPE_NET_OPTION_NAME_IMAGE:
            case NODE_TYPE_NET_OPTION_NAME_MEDIA:
            case NODE_TYPE_NET_OPTION_NAME_OTHER:
            case NODE_TYPE_NET_OPTION_NAME_SCRIPT:
            case NODE_TYPE_NET_OPTION_NAME_XHR:
                realBad = hasValue;
                if ( realBad ) { break; }
                requestTypeCount += 1;
                break;
            // ── modifiers and option-specific checks (alphabetical, as upstream) ──
            case NODE_TYPE_NET_OPTION_NAME_CNAME:
                realBad = isException === false || isNegated || hasValue;
                if ( realBad ) { break; }
                modifierType = type;
                break;
            case NODE_TYPE_NET_OPTION_NAME_CSP:
                realBad = (hasValue || isException) === false ||
                    modifierType !== 0 ||
                    this.reBadCSP.test(
                        this.getNetOptionValue(NODE_TYPE_NET_OPTION_NAME_CSP)
                    );
                if ( realBad ) { break; }
                modifierType = type;
                break;
            case NODE_TYPE_NET_OPTION_NAME_DENYALLOW:
                realBad = isNegated || hasValue === false ||
                    this.getBranchFromType(NODE_TYPE_NET_OPTION_NAME_FROM) === 0;
                break;
            case NODE_TYPE_NET_OPTION_NAME_DOC:
            case NODE_TYPE_NET_OPTION_NAME_FRAME:
            case NODE_TYPE_NET_OPTION_NAME_OBJECT:
                realBad = hasValue;
                if ( realBad ) { break; }
                docTypeCount += 1;
                break;
            case NODE_TYPE_NET_OPTION_NAME_EHIDE:
            case NODE_TYPE_NET_OPTION_NAME_GHIDE:
            case NODE_TYPE_NET_OPTION_NAME_SHIDE:
                realBad = isNegated || hasValue || modifierType !== 0;
                if ( realBad ) { break; }
                behaviorTypeCount += 1;
                unredirectableTypeCount += 1;
                break;
            case NODE_TYPE_NET_OPTION_NAME_EMPTY:
            case NODE_TYPE_NET_OPTION_NAME_MP4:
                realBad = isNegated || hasValue || modifierType !== 0;
                if ( realBad ) { break; }
                modifierType = type;
                break;
            case NODE_TYPE_NET_OPTION_NAME_FROM:
            case NODE_TYPE_NET_OPTION_NAME_METHOD:
            case NODE_TYPE_NET_OPTION_NAME_TO:
            case NODE_TYPE_NET_OPTION_NAME_TOP:
                realBad = isNegated || hasValue === false;
                break;
            case NODE_TYPE_NET_OPTION_NAME_GENERICBLOCK:
                bad = true;
                realBad = isException === false || isNegated || hasValue;
                break;
            case NODE_TYPE_NET_OPTION_NAME_IMPORTANT:
                realBad = isException || isNegated || hasValue;
                break;
            case NODE_TYPE_NET_OPTION_NAME_INLINEFONT:
            case NODE_TYPE_NET_OPTION_NAME_INLINESCRIPT:
                realBad = hasValue;
                if ( realBad ) { break; }
                modifierType = type;
                unredirectableTypeCount += 1;
                break;
            case NODE_TYPE_NET_OPTION_NAME_IPADDRESS: {
                const value = this.getNetOptionValue(NODE_TYPE_NET_OPTION_NAME_IPADDRESS);
                if ( /^\/.+\/$/.test(value) ) {
                    try { void new RegExp(value); }
                    catch { realBad = true; }
                }
                break;
            }
            case NODE_TYPE_NET_OPTION_NAME_MATCHCASE:
                // (10.7.6) ABP / AdGuard dialect: "$match-case" is valid on a plain pattern too (DNR's
                // isUrlFilterCaseSensitive covers urlFilter and regexFilter alike); uBO accepted it on a regex
                // only. LIMIT: a plain pattern is lower-cased when it is parsed (normalizePattern), so one WITH
                // upper-case letters would silently lose them — that line stays rejected (dropped), never
                // half-translated.
                realBad = this.isRegexPattern() === false &&
                    this.reHasUppercaseChar.test(this.getNodeString(
                        this.nodeTypeLookupTable[NODE_TYPE_NET_PATTERN]
                    ));
                break;
            case NODE_TYPE_NET_OPTION_NAME_PERMISSIONS:
                realBad = modifierType !== 0 ||
                    (hasValue || isException) === false ||
                    this.reBadPP.test(
                        this.getNetOptionValue(NODE_TYPE_NET_OPTION_NAME_PERMISSIONS)
                    );
                if ( realBad ) { break; }
                modifierType = type;
                break;
            case NODE_TYPE_NET_OPTION_NAME_PING:
            case NODE_TYPE_NET_OPTION_NAME_WEBSOCKET:
                realBad = hasValue;
                if ( realBad ) { break; }
                requestTypeCount += 1;
                if ( (flags & NODE_FLAG_IS_NEGATED) === 0 ) {
                    unredirectableTypeCount += 1;
                }
                break;
            case NODE_TYPE_NET_OPTION_NAME_POPUNDER:
            case NODE_TYPE_NET_OPTION_NAME_POPUP:
                realBad = hasValue;
                if ( realBad ) { break; }
                abstractTypeCount += 1;
                unredirectableTypeCount += 1;
                break;
            case NODE_TYPE_NET_OPTION_NAME_REASON:
                realBad = hasValue === false;
                break;
            case NODE_TYPE_NET_OPTION_NAME_REDIRECT:
            case NODE_TYPE_NET_OPTION_NAME_REDIRECTRULE:
            case NODE_TYPE_NET_OPTION_NAME_REPLACE:
            case NODE_TYPE_NET_OPTION_NAME_URLSKIP:
            case NODE_TYPE_NET_OPTION_NAME_URLTRANSFORM:
                realBad = isNegated || (isException || hasValue) === false ||
                    modifierType !== 0;
                if ( realBad ) { break; }
                modifierType = type;
                break;
            case NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM:
                realBad = isNegated || modifierType !== 0;
                if ( realBad ) { break; }
                modifierType = type;
                break;
            case NODE_TYPE_NET_OPTION_NAME_REQUESTHEADER:
            case NODE_TYPE_NET_OPTION_NAME_RESPONSEHEADER:
                realBad = isNegated || hasValue === false;
                break;
            case NODE_TYPE_NET_OPTION_NAME_STRICT1P:
            case NODE_TYPE_NET_OPTION_NAME_STRICT3P:
                realBad = isNegated || hasValue;
                break;
            case NODE_TYPE_NET_OPTION_NAME_UNKNOWN:
                this.astError = AST_ERROR_OPTION_UNKNOWN;
                realBad = true;
                break;
            case NODE_TYPE_NET_OPTION_NAME_WEBRTC:
                realBad = true;
                break;
            case NODE_TYPE_NET_PATTERN_RAW:
                realBad = this.hasOptions() === false &&
                    this.getNetPattern().length <= 1;
                break;
            default:
                break;
            }
            if ( bad || realBad ) {
                this.addNodeFlags(targetNode, NODE_FLAG_ERROR);
            }
            if ( realBad ) {
                this.addFlags(AST_FLAG_HAS_ERROR);
            }
        }
        // ── pass 2: the one modifier against the counted types ──
        switch ( modifierType ) {
        case NODE_TYPE_NET_OPTION_NAME_CNAME:
            realBad = abstractTypeCount || behaviorTypeCount || requestTypeCount;
            break;
        case NODE_TYPE_NET_OPTION_NAME_CSP:
        case NODE_TYPE_NET_OPTION_NAME_PERMISSIONS:
            realBad = abstractTypeCount || behaviorTypeCount || requestTypeCount;
            break;
        case NODE_TYPE_NET_OPTION_NAME_INLINEFONT:
        case NODE_TYPE_NET_OPTION_NAME_INLINESCRIPT:
            realBad = behaviorTypeCount;
            break;
        case NODE_TYPE_NET_OPTION_NAME_EMPTY:
            realBad = abstractTypeCount || behaviorTypeCount;
            break;
        case NODE_TYPE_NET_OPTION_NAME_MEDIA:
        case NODE_TYPE_NET_OPTION_NAME_MP4:
            realBad = abstractTypeCount || behaviorTypeCount || docTypeCount || requestTypeCount;
            break;
        case NODE_TYPE_NET_OPTION_NAME_REDIRECT:
        case NODE_TYPE_NET_OPTION_NAME_REDIRECTRULE: {
            realBad = abstractTypeCount || behaviorTypeCount || unredirectableTypeCount;
            break;
        }
        case NODE_TYPE_NET_OPTION_NAME_REPLACE: {
            realBad = abstractTypeCount || behaviorTypeCount || unredirectableTypeCount;
            if ( realBad ) { break; }
            if ( isException || isBadfilter ) { break; }
            if ( this.options.trustedSource !== true ) {
                this.astError = AST_ERROR_UNTRUSTED_SOURCE;
                realBad = true;
                break;
            }
            const value = this.getNetOptionValue(NODE_TYPE_NET_OPTION_NAME_REPLACE);
            if ( parseReplaceValue(value) === undefined ) {
                this.astError = AST_ERROR_OPTION_BADVALUE;
                realBad = true;
            }
            break;
        }
        case NODE_TYPE_NET_OPTION_NAME_URLSKIP: {
            realBad = abstractTypeCount || behaviorTypeCount || unredirectableTypeCount;
            if ( realBad ) { break; }
            if ( isException || isBadfilter ) { break; }
            if ( this.options.trustedSource !== true ) {
                this.astError = AST_ERROR_UNTRUSTED_SOURCE;
                realBad = true;
                break;
            }
            const value = this.getNetOptionValue(NODE_TYPE_NET_OPTION_NAME_URLSKIP);
            if ( value.length < 2 ) {
                this.astError = AST_ERROR_OPTION_BADVALUE;
                realBad = true;
            }
            break;
        }
        case NODE_TYPE_NET_OPTION_NAME_URLTRANSFORM: {
            realBad = abstractTypeCount || behaviorTypeCount || unredirectableTypeCount;
            if ( realBad ) { break; }
            if ( isException || isBadfilter ) { break; }
            if ( this.options.trustedSource !== true ) {
                this.astError = AST_ERROR_UNTRUSTED_SOURCE;
                realBad = true;
                break;
            }
            const value = this.getNetOptionValue(NODE_TYPE_NET_OPTION_NAME_URLTRANSFORM);
            if ( value !== '' && parseReplaceByRegexValue(value) === undefined ) {
                this.astError = AST_ERROR_OPTION_BADVALUE;
                realBad = true;
            }
            break;
        }
        case NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM:
            realBad = abstractTypeCount || behaviorTypeCount;
            break;
        default:
            break;
        }
        if ( realBad ) {
            const targetNode = this.getBranchFromType(modifierType);
            this.addNodeFlags(targetNode, NODE_FLAG_ERROR);
            this.addFlags(AST_FLAG_HAS_ERROR);
        }
    }

    /* ══════════════════════════════════════════════════════════════
       5. NETWORK FILTERS — PATTERN
       the URL pattern: anchors, hostname fast path, regex, wildcards, normalisation
       ══════════════════════════════════════════════════════════════ */

    indexOfNetAnchor(s) {
        const end = s.length;
        if ( end === 0 ) { return 0; }
        let j = s.lastIndexOf('$');
        if ( j === -1 ) { return end; }
        let htmlFilteringRule = false;
        for (;;) {
            if ( s.charCodeAt(j-1) === 0x24 /* $ */ ) {
                htmlFilteringRule = true;
            }
            if ( this.reNetOptionTokens.test(s.slice(j+1)) ) { return j; }
            if ( j === 0 ) { break; }
            j = s.lastIndexOf('$', j-1);
            if ( j === -1 ) { break; }
        }
        if ( htmlFilteringRule ) { return -1; } 
        return end;
    }

    // The URL pattern of a network line, in steps (each early `return` ends it):
    //   1. empty pattern (matches everything)
    //   2. fast path: plain EasyList hostname "||example.com^" (the common case)
    //   3. hosts-file entry ("0.0.0.0 example.com")
    //   4. regex pattern "/…/"
    //   5. left anchor "|" / "||"     6. right anchor "|"
    //   7-9. drop pointless leading wildcards, trailing separators, trailing wildcards
    //  10. normalise, classify (any / hostname / generic / plain / bad) and emit the node
    parseNetPattern(parent) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];

        // Step 1 — empty pattern
        if ( parentEnd === parentBeg ) {
            this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_ANY;
            const node = this.allocTypedNode(
                NODE_TYPE_NET_PATTERN,
                parentBeg,
                parentEnd
            );
            this.addNodeToRegister(NODE_TYPE_NET_PATTERN, node);
            this.setNodeTransform(node, '*');
            return node;
        }

        const head = this.allocHeadNode();
        let prev = head, next = 0, tail = 0;
        let pattern = this.getNodeString(parent);
        const hasWildcard = pattern.includes('*');
        const c1st = pattern.charCodeAt(0);
        const c2nd = pattern.charCodeAt(1) || 0;
        const clast = exCharCodeAt(pattern, -1);

        // Step 2 — common case: Easylist syntax-based hostname
        if (
            hasWildcard === false &&
            c1st === 0x7C /* | */ && c2nd === 0x7C /* | */ &&
            clast === 0x5E /* ^ */ &&
            this.isAdblockHostnamePattern(pattern)
        ) {
            this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_HOSTNAME;
            this.addFlags(
                AST_FLAG_NET_PATTERN_LEFT_HNANCHOR |
                AST_FLAG_NET_PATTERN_RIGHT_PATHANCHOR
            );
            next = this.allocTypedNode(
                NODE_TYPE_NET_PATTERN_LEFT_HNANCHOR,
                parentBeg,
                parentBeg + 2
            );
            prev = this.linkRight(prev, next);
            next = this.allocTypedNode(
                NODE_TYPE_NET_PATTERN,
                parentBeg + 2,
                parentEnd - 1
            );
            pattern = pattern.slice(2, -1);
            const normal = this.hasUnicode
                ? this.normalizeHostnameValue(pattern)
                : pattern;
            if ( normal !== undefined && normal !== pattern ) {
                this.setNodeTransform(next, normal);
            }
            this.addNodeToRegister(NODE_TYPE_NET_PATTERN, next);
            prev = this.linkRight(prev, next);
            next = this.allocTypedNode(
                NODE_TYPE_NET_PATTERN_PART_SPECIAL,
                parentEnd - 1,
                parentEnd
            );
            this.linkRight(prev, next);
            return this.throwHeadNode(head);
        }

        let patternBeg = parentBeg;
        let patternEnd = parentEnd;

        // Step 3 — hosts file entry?
        if (
            this.hasWhitespace &&
            this.isException() === false &&
            this.hasOptions() === false &&
            this.reHostsSink.test(pattern)
        ) {
            const match = this.reHostsSink.exec(pattern);
            patternBeg += match[0].length;
            pattern = pattern.slice(patternBeg);
            next = this.allocTypedNode(NODE_TYPE_IGNORE, parentBeg, patternBeg);
            prev = this.linkRight(prev, next);
            if (
                this.reHostsRedirect.test(pattern) ||
                this.reHostnameAscii.test(pattern) === false
            ) {
                this.astType = AST_TYPE_NONE;
                this.addFlags(AST_FLAG_IGNORE);
                next = this.allocTypedNode(NODE_TYPE_IGNORE, patternBeg, parentEnd);
                prev = this.linkRight(prev, next);
                return this.throwHeadNode(head);
            }
            this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_HOSTNAME;
            this.addFlags(
                AST_FLAG_NET_PATTERN_LEFT_HNANCHOR |
                AST_FLAG_NET_PATTERN_RIGHT_PATHANCHOR
            );
            next = this.allocTypedNode(
                NODE_TYPE_NET_PATTERN,
                patternBeg,
                parentEnd
            );
            this.addNodeToRegister(NODE_TYPE_NET_PATTERN, next);
            this.linkRight(prev, next);
            return this.throwHeadNode(head);
        }

        // Step 4 — regex?
        if (
            c1st === 0x2F /* / */ && clast === 0x2F /* / */ &&
            pattern.length > 2
        ) {
            this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_REGEX;
            const normal = this.normalizeRegexPattern(pattern);
            next = this.allocTypedNode(
                NODE_TYPE_NET_PATTERN,
                patternBeg,
                patternEnd
            );
            this.addNodeToRegister(NODE_TYPE_NET_PATTERN, next);
            if ( normal !== '' ) {
                if ( normal !== pattern ) {
                    this.setNodeTransform(next, normal);
                }
            } else {
                this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_BAD;
                this.astError = AST_ERROR_REGEX;
                this.addFlags(AST_FLAG_HAS_ERROR);
                this.addNodeFlags(next, NODE_FLAG_ERROR);
            }
            this.linkRight(prev, next);
            return this.throwHeadNode(head);
        }

        // Step 5 — left anchor
        if ( c1st === 0x7C /* '|' */ ) {
            if ( c2nd === 0x7C /* '|' */ ) {
                const type = this.isTokenCharCode(pattern.charCodeAt(2) || 0)
                    ? NODE_TYPE_NET_PATTERN_LEFT_HNANCHOR
                    : NODE_TYPE_IGNORE;
                next = this.allocTypedNode(type, patternBeg, patternBeg+2);
                if ( type === NODE_TYPE_NET_PATTERN_LEFT_HNANCHOR ) {
                    this.addFlags(AST_FLAG_NET_PATTERN_LEFT_HNANCHOR);
                }
                patternBeg += 2;
                pattern = pattern.slice(2);
            } else {
                const type = this.isTokenCharCode(c2nd)
                    ? NODE_TYPE_NET_PATTERN_LEFT_ANCHOR
                    : NODE_TYPE_IGNORE;
                next = this.allocTypedNode(type, patternBeg, patternBeg+1);
                if ( type === NODE_TYPE_NET_PATTERN_LEFT_ANCHOR ) {
                    this.addFlags(AST_FLAG_NET_PATTERN_LEFT_ANCHOR);
                }
                patternBeg += 1;
                pattern = pattern.slice(1);
            }
            prev = this.linkRight(prev, next);
            if ( patternBeg === patternEnd ) {
                this.addNodeFlags(next, NODE_FLAG_IGNORE);
            }
        }

        // Step 6 — right anchor
        if ( exCharCodeAt(pattern, -1) === 0x7C /* | */ ) {
            const type = exCharCodeAt(pattern, -2) !== 0x2A /* * */
                ? NODE_TYPE_NET_PATTERN_RIGHT_ANCHOR
                : NODE_TYPE_IGNORE;
            tail = this.allocTypedNode(type, patternEnd-1, patternEnd);
            if ( type === NODE_TYPE_NET_PATTERN_RIGHT_ANCHOR ) {
                this.addFlags(AST_FLAG_NET_PATTERN_RIGHT_ANCHOR);
            }
            patternEnd -= 1;
            pattern = pattern.slice(0, -1);
            if ( patternEnd === patternBeg ) {
                this.addNodeFlags(tail, NODE_FLAG_IGNORE);
            }
        }

        // Step 7 — ignore pointless leading wildcards
        if ( hasWildcard && this.rePointlessLeadingWildcards.test(pattern) ) {
            const match = this.rePointlessLeadingWildcards.exec(pattern);
            const ignoreLen = match[1].length;
            next = this.allocTypedNode(
                NODE_TYPE_IGNORE,
                patternBeg,
                patternBeg + ignoreLen
            );
            prev = this.linkRight(prev, next);
            patternBeg += ignoreLen;
            pattern = pattern.slice(ignoreLen);
        }

        // Step 8 — ignore pointless trailing separators
        if ( this.rePointlessTrailingSeparator.test(pattern) ) {
            const match = this.rePointlessTrailingSeparator.exec(pattern);
            const ignoreLen = match[1].length;
            next = this.allocTypedNode(
                NODE_TYPE_IGNORE,
                patternEnd - ignoreLen,
                patternEnd
            );
            patternEnd -= ignoreLen;
            pattern = pattern.slice(0, -ignoreLen);
            if ( tail !== 0 ) { this.linkRight(next, tail); }
            tail = next;
        }

        // Step 9 — ignore pointless trailing wildcards. Exception: when removing the
        // trailing wildcard make the pattern look like a regex.
        if ( hasWildcard && this.rePointlessTrailingWildcards.test(pattern) ) {
            const match = this.rePointlessTrailingWildcards.exec(pattern);
            const ignoreLen = match[1].length;
            const needWildcard = pattern.charCodeAt(0) === 0x2F &&
                exCharCodeAt(pattern, -ignoreLen-1) === 0x2F;
            const goodWildcardBeg = patternEnd - ignoreLen;
            const badWildcardBeg = goodWildcardBeg + (needWildcard ? 1 : 0);
            if ( badWildcardBeg !== patternEnd ) {
                next = this.allocTypedNode(
                    NODE_TYPE_IGNORE,
                    badWildcardBeg,
                    patternEnd
                );
                if ( tail !== 0 ) {this.linkRight(next, tail); }
                tail = next;
            }
            if ( goodWildcardBeg !== badWildcardBeg ) {
                next = this.allocTypedNode(
                    NODE_TYPE_NET_PATTERN_PART_SPECIAL,
                    goodWildcardBeg,
                    badWildcardBeg
                );
                if ( tail !== 0 ) { this.linkRight(next, tail); }
                tail = next;
            }
            patternEnd -= ignoreLen;
            pattern = pattern.slice(0, -ignoreLen);
        }

        const patternHasWhitespace = this.hasWhitespace &&
            this.reHasWhitespaceChar.test(pattern);
        // Step 10 — normalise, classify and emit the pattern node
        const needNormalization = this.needPatternNormalization(pattern);
        const normal = needNormalization
            ? this.normalizePattern(pattern)
            : pattern;
        next = this.allocTypedNode(NODE_TYPE_NET_PATTERN, patternBeg, patternEnd);
        if ( patternHasWhitespace || normal === undefined ) {
            this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_BAD;
            this.addFlags(AST_FLAG_HAS_ERROR);
            this.astError = AST_ERROR_PATTERN;
            this.addNodeFlags(next, NODE_FLAG_ERROR);
        } else if ( normal === '*' ) {
            this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_ANY;
        } else if ( this.reHostnameAscii.test(normal) ) {
            this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_HOSTNAME;
        } else if ( this.reHasPatternSpecialChars.test(normal) ) {
            this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_GENERIC;
        } else {
            this.astTypeFlavor = AST_TYPE_NETWORK_PATTERN_PLAIN;
        }
        this.addNodeToRegister(NODE_TYPE_NET_PATTERN, next);
        if ( needNormalization && normal !== undefined ) {
            this.setNodeTransform(next, normal);
        }
        if ( this.interactive ) {
            this.linkDown(next, this.parsePatternParts(next, pattern));
        }
        prev = this.linkRight(prev, next);

        if ( tail !== 0 ) {
            this.linkRight(prev, tail);
        }
        return this.throwHeadNode(head);
    }

    isAdblockHostnamePattern(pattern) {
        if ( this.hasUnicode ) {
            return this.reHnAnchoredHostnameUnicode.test(pattern);
        }
        return this.reHnAnchoredHostnameAscii.test(pattern);
    }

    parsePatternParts(parent, pattern) {
        if ( pattern.length === 0 ) { return 0; }
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const matches = pattern.matchAll(this.rePatternAllSpecialChars);
        const head = this.allocHeadNode();
        let prev = head, next = 0;
        let plainPartBeg = 0;
        for ( const match of matches ) {
            const plainPartEnd = match.index;
            if ( plainPartEnd !== plainPartBeg ) {
                next = this.allocTypedNode(
                    NODE_TYPE_NET_PATTERN_PART,
                    parentBeg + plainPartBeg,
                    parentBeg + plainPartEnd
                );
                prev = this.linkRight(prev, next);
            }
            plainPartBeg = plainPartEnd + match[0].length;
            const type = match[0].charCodeAt(0) < 0x80
                ? NODE_TYPE_NET_PATTERN_PART_SPECIAL
                : NODE_TYPE_NET_PATTERN_PART_UNICODE;
            next = this.allocTypedNode(
                type,
                parentBeg + plainPartEnd,
                parentBeg + plainPartBeg
            );
            prev = this.linkRight(prev, next);
        }
        if ( plainPartBeg !== pattern.length ) {
            next = this.allocTypedNode(
                NODE_TYPE_NET_PATTERN_PART,
                parentBeg + plainPartBeg,
                parentBeg + pattern.length
            );
            this.linkRight(prev, next);
        }
        return this.throwHeadNode(head);
    }

    // https://github.com/uBlockOrigin/uBlock-issues/issues/1118#issuecomment-650730158
    //   Be ready to deal with non-punycode-able Unicode characters.
    // https://github.com/uBlockOrigin/uBlock-issues/issues/772
    //   Encode Unicode characters beyond the hostname part.
    // Prepend with '*' character to prevent the browser API from refusing to
    // punycode -- this occurs when the extracted label starts with a dash.
    needPatternNormalization(pattern) {
        return pattern.length === 0 || this.hasUppercase || this.hasUnicode;
    }

    normalizePattern(pattern) {
        if ( pattern.length === 0 ) { return '*'; }
        if ( this.reHasInvalidChar.test(pattern) ) { return; }
        let normal = pattern.toLowerCase();
        if ( this.hasUnicode === false ) { return normal; }
        // Punycode hostname part of the pattern.
        if ( this.reHostnamePatternPart.test(normal) ) {
            const match = this.reHostnamePatternPart.exec(normal);
            const hn = match[0].replace(this.reHostnameLabel, s => {
                if ( this.reHasUnicodeChar.test(s) === false ) { return s; }
                if ( s.charCodeAt(0) === 0x2D /* - */ ) { s = '*' + s; }
                return this.normalizeHostnameValue(s, DOMAIN_CAN_USE_WILDCARD) || s;
            });
            normal = hn + normal.slice(match.index + match[0].length);
        }
        if ( this.reHasUnicodeChar.test(normal) === false ) { return normal; }
        // Percent-encode remaining Unicode characters.
        try {
            normal = normal.replace(this.reUnicodeChars, s =>
                encodeURIComponent(s).toLowerCase()
            );
        } catch {
            return;
        }
        return normal;
    }

    getNetPattern() {
        const node = this.nodeTypeLookupTable[NODE_TYPE_NET_PATTERN];
        return this.getNodeTransform(node);
    }

    isAnyPattern() {
        return this.astTypeFlavor === AST_TYPE_NETWORK_PATTERN_ANY;
    }

    isHostnamePattern() {
        return this.astTypeFlavor === AST_TYPE_NETWORK_PATTERN_HOSTNAME;
    }

    isRegexPattern() {
        return this.astTypeFlavor === AST_TYPE_NETWORK_PATTERN_REGEX;
    }

    isPlainPattern() {
        return this.astTypeFlavor === AST_TYPE_NETWORK_PATTERN_PLAIN;
    }

    isGenericPattern() {
        return this.astTypeFlavor === AST_TYPE_NETWORK_PATTERN_GENERIC;
    }

    isBadPattern() {
        return this.astTypeFlavor === AST_TYPE_NETWORK_PATTERN_BAD;
    }

    /* ══════════════════════════════════════════════════════════════
       6. NETWORK FILTERS — OPTIONS
       the $option list after the pattern
       ══════════════════════════════════════════════════════════════ */

    parseNetOptions(parent) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        if ( parentEnd === parentBeg ) { return 0; }
        const s = this.getNodeString(parent);
        const optionsEnd = s.length;
        const parseDetails = { node: 0, len: 0 };
        const head = this.allocHeadNode();
        let prev = head, next = 0;
        let optionBeg = 0, optionEnd = 0;
        while ( optionBeg !== optionsEnd ) {
            next = this.allocTypedNode(
                NODE_TYPE_NET_OPTION_RAW,
                parentBeg + optionBeg,
                parentBeg + optionsEnd // open ended
            );
            this.parseNetOption(next, parseDetails);
            // set next's end to down's end
            optionEnd += parseDetails.len;
            this.nodes[next+NODE_END_INDEX] = parentBeg + optionEnd;
            this.linkDown(next, parseDetails.node);
            prev = this.linkRight(prev, next);
            if ( optionEnd === optionsEnd ) { break; }
            optionBeg = optionEnd + 1;
            next = this.allocTypedNode(
                NODE_TYPE_NET_OPTION_SEPARATOR,
                parentBeg + optionEnd,
                parentBeg + optionBeg
            );
            if ( parseDetails.len === 0 || optionBeg === optionsEnd ) {
                this.addNodeFlags(next, NODE_FLAG_ERROR);
                this.addFlags(AST_FLAG_HAS_ERROR);
            }
            prev = this.linkRight(prev, next);
            optionEnd = optionBeg;
        }
        this.linkRight(prev,
            this.allocSentinelNode(NODE_TYPE_NET_OPTION_SENTINEL, parentEnd)
        );
        return this.throwHeadNode(head);
    }

    parseNetOption(parent, parseDetails) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const s = this.getNodeString(parent);
        const match = this.reNetOption.exec(s) || [];
        if ( match.length === 0 ) {
            this.addNodeFlags(parent, NODE_FLAG_ERROR);
            this.addFlags(AST_FLAG_HAS_ERROR);
            this.astError = AST_ERROR_OPTION_UNKNOWN;
            parseDetails.node = 0;
            parseDetails.len = s.length;
            return;
        }
        const head = this.allocHeadNode();
        let prev = head, next = 0;
        const matchEnd = match && match[0].length || 0;
        const negated = match[1] === '~';
        if ( negated ) {
            this.addNodeFlags(parent, NODE_FLAG_IS_NEGATED);
            next = this.allocTypedNode(
                NODE_TYPE_NET_OPTION_NAME_NOT,
                parentBeg,
                parentBeg+1
            );
            prev = this.linkRight(prev, next);
        }
        const nameBeg = negated ? 1 : 0;
        const assigned = match[3] === '=';
        const nameEnd = matchEnd - (assigned ? 1 : 0);
        const name = match[2] || '';
        let nodeOptionType = nodeTypeFromOptionName.get(name);
        if ( nodeOptionType === undefined ) {
            nodeOptionType = this.reNoopOption.test(name)
                ? NODE_TYPE_NET_OPTION_NAME_NOOP
                : NODE_TYPE_NET_OPTION_NAME_UNKNOWN;
        }
        next = this.allocTypedNode(
            nodeOptionType,
            parentBeg + nameBeg,
            parentBeg + nameEnd
        );
        if (
            nodeOptionType !== NODE_TYPE_NET_OPTION_NAME_NOOP &&
            this.getBranchFromType(nodeOptionType) !== 0
        ) {
            this.addNodeFlags(parent, NODE_FLAG_ERROR);
            this.addFlags(AST_FLAG_HAS_ERROR);
            this.astError = AST_ERROR_OPTION_DUPLICATE;
        } else {
            this.addNodeToRegister(nodeOptionType, parent);
        }
        prev = this.linkRight(prev, next);
        if ( assigned === false ) {
            parseDetails.node = this.throwHeadNode(head);
            parseDetails.len = matchEnd;
            return;
        }
        next = this.allocTypedNode(
            NODE_TYPE_NET_OPTION_ASSIGN,
            parentBeg + matchEnd - 1,
            parentBeg + matchEnd
        );
        prev = this.linkRight(prev, next);
        this.addNodeFlags(parent, NODE_FLAG_OPTION_HAS_VALUE);
        const details = this.netOptionValueParser.nextArg(s, matchEnd);
        if ( details.quoteBeg !== details.argBeg ) {
            next = this.allocTypedNode(
                NODE_TYPE_NET_OPTION_QUOTE,
                parentBeg + details.quoteBeg,
                parentBeg + details.argBeg
            );
            prev = this.linkRight(prev, next);
        } else {
            const argEnd = this.endOfNetOption(s, matchEnd);
            if ( argEnd !== details.argEnd ) {
                details.argEnd = details.quoteEnd = argEnd;
            }
        }
        next = this.allocTypedNode(
            NODE_TYPE_NET_OPTION_VALUE,
            parentBeg + details.argBeg,
            parentBeg + details.argEnd
        );
        if ( details.argBeg === details.argEnd ) {
            this.addNodeFlags(parent, NODE_FLAG_ERROR);
            this.addFlags(AST_FLAG_HAS_ERROR);
            this.astError = AST_ERROR_OPTION_BADVALUE;
        } else if ( details.transform ) {
            const arg = s.slice(details.argBeg, details.argEnd);
            this.setNodeTransform(next, this.netOptionValueParser.normalizeArg(arg));
        }
        switch ( nodeOptionType ) {
        case NODE_TYPE_NET_OPTION_NAME_DENYALLOW:
            this.linkDown(next, this.parseDomainList(next, '|'), DOMAIN_FROM_DENYALLOW_LIST);
            break;
        case NODE_TYPE_NET_OPTION_NAME_FROM:
        case NODE_TYPE_NET_OPTION_NAME_TO:
        case NODE_TYPE_NET_OPTION_NAME_TOP:
            this.linkDown(next, this.parseDomainList(next, '|', DOMAIN_FROM_FROMTO_LIST));
            break;
        default:
            break;
        }
        prev = this.linkRight(prev, next);
        if ( details.quoteEnd !== details.argEnd ) {
            next = this.allocTypedNode(
                NODE_TYPE_NET_OPTION_QUOTE,
                parentBeg + details.argEnd,
                parentBeg + details.quoteEnd
            );
            this.linkRight(prev, next);
        }
        parseDetails.node = this.throwHeadNode(head);
        parseDetails.len = details.quoteEnd;
    }

    endOfNetOption(s, beg) {
        const match = this.reNetOptionComma.exec(s.slice(beg));
        return match !== null ? beg + match.index : s.length;
    }

    getNetOptionValue(type) {
        if ( this.nodeTypeRegister.includes(type) === false ) { return ''; }
        const optionNode = this.nodeTypeLookupTable[type];
        if ( optionNode === 0 ) { return ''; }
        const valueNode = this.findDescendantByType(optionNode, NODE_TYPE_NET_OPTION_VALUE);
        if ( valueNode === 0 ) { return ''; }
        return this.getNodeTransform(valueNode);
    }

    /* ══════════════════════════════════════════════════════════════
       7. DOMAIN LISTS
       domain=, from=, to=, denyallow= and the site list of extended filters
       ══════════════════════════════════════════════════════════════ */

    parseDomainList(parent, separator, mode = 0) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        const containerNode = this.allocTypedNode(
            NODE_TYPE_OPTION_VALUE_DOMAIN_LIST,
            parentBeg,
            parentEnd
        );
        if ( parentEnd === parentBeg ) { return containerNode; }
        const separatorCode = separator.charCodeAt(0);
        const parseDetails = { separator, mode, node: 0, len: 0 };
        const listNode = this.allocHeadNode();
        let prev = listNode;
        let domainNode = 0;
        let separatorNode = 0;
        const s = this.getNodeString(parent);
        const listEnd = s.length;
        let beg = 0, end = 0;
        while ( beg < listEnd ) {
            const next = this.allocTypedNode(
                NODE_TYPE_OPTION_VALUE_DOMAIN_RAW,
                parentBeg + beg,
                parentBeg + listEnd // open ended
            );
            this.parseDomain(next, parseDetails);
            end = beg + parseDetails.len;
            const badSeparator = end < listEnd && s.charCodeAt(end) !== separatorCode;
            if ( badSeparator ) {
                end = s.indexOf(separator, end);
                if ( end === -1 ) { end = listEnd; }
            }
            this.nodes[next+NODE_END_INDEX] = parentBeg + end;
            if ( end !== beg ) {
                domainNode = next;
                this.linkDown(domainNode, parseDetails.node);
                prev = this.linkRight(prev, domainNode);
                if ( badSeparator ) {
                    this.addNodeFlags(domainNode, NODE_FLAG_ERROR);
                    this.addFlags(AST_FLAG_HAS_ERROR);
                }
            } else {
                domainNode = 0;
                if ( separatorNode !== 0 ) {
                    this.addNodeFlags(separatorNode, NODE_FLAG_ERROR);
                    this.addFlags(AST_FLAG_HAS_ERROR);
                }
            }
            if ( s.charCodeAt(end) === separatorCode ) {
                beg = end;
                end += 1;
                separatorNode = this.allocTypedNode(
                    NODE_TYPE_OPTION_VALUE_SEPARATOR,
                    parentBeg + beg,
                    parentBeg + end
                );
                prev = this.linkRight(prev, separatorNode);
                if ( domainNode === 0 ) {
                    this.addNodeFlags(separatorNode, NODE_FLAG_ERROR);
                    this.addFlags(AST_FLAG_HAS_ERROR);
                }
            } else {
                separatorNode = 0;
            }
            beg = end;
        }
        // Dangling separator node
        if ( separatorNode !== 0 ) {
            this.addNodeFlags(separatorNode, NODE_FLAG_ERROR);
            this.addFlags(AST_FLAG_HAS_ERROR);
        }
        this.linkDown(containerNode, this.throwHeadNode(listNode));
        return containerNode;
    }

    parseDomain(parent, parseDetails) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        const not = this.charCodeAt(parentBeg) === 0x7E /* ~ */;
        let head = 0, next = 0;
        let beg = parentBeg;
        if ( not ) {
            this.addNodeFlags(parent, NODE_FLAG_IS_NEGATED);
            head = this.allocTypedNode(NODE_TYPE_OPTION_VALUE_NOT, beg, beg + 1);
            if ( (parseDetails.mode & DOMAIN_CAN_BE_NEGATED) === 0 ) {
                this.addNodeFlags(parent, NODE_FLAG_ERROR);
            }
            beg += 1;
        }
        const c0 = this.charCodeAt(beg);
        let end = beg;
        let isRegex = false;
        if ( c0 === 0x2F /* / */ ) {
            this.domainRegexValueParser.nextArg(this.raw, beg+1);
            end = this.domainRegexValueParser.separatorEnd;
            // (10.7.8) A "/…" value whose closing slash lies past this option's end is not a regex: treat it as a
            // plain (invalid) value instead of reading past the option (uBO bfbd7f6, uBlock-issues#4113).
            if ( end <= parentEnd ) {
                isRegex = true;
            } else {
                end = -1;
            }
        } else if ( c0 === 0x5B /* [ */ && this.startsWith('[$domain=/', beg) ) {
            end = this.indexOf('/]', beg + 10, parentEnd);
            if ( end !== -1 ) { end += 2; }
            isRegex = true;
        } else {
            end = this.indexOf(parseDetails.separator, end, parentEnd);
        }
        if ( end === -1 ) { end = parentEnd; }
        if ( beg !== end ) {
            next = this.allocTypedNode(NODE_TYPE_OPTION_VALUE_DOMAIN, beg, end);
            const hn = this.normalizeDomainValue(next, isRegex, parseDetails.mode);
            if ( hn !== undefined ) {
                if ( hn !== '' ) {
                    this.setNodeTransform(next, hn);
                } else {
                    this.addNodeFlags(parent, NODE_FLAG_ERROR);
                    this.addFlags(AST_FLAG_HAS_ERROR);
                    this.astError = AST_ERROR_DOMAIN_NAME;
                }
            }
            if ( head === 0 ) {
                head = next;
            } else {
                this.linkRight(head, next);
            }
        } else {
            this.addNodeFlags(parent, NODE_FLAG_ERROR);
            this.addFlags(AST_FLAG_HAS_ERROR);
        }
        parseDetails.node = head;
        parseDetails.len = end - parentBeg;
    }

    normalizeDomainValue(node, isRegex, modeBits) {
        const raw = this.getNodeString(node);
        if ( isRegex ) {
            if ( (modeBits & DOMAIN_CAN_BE_REGEX) === 0 ) { return ''; }
            return this.normalizeDomainRegexValue(raw);
        }
        // Common: Assume plain hostname
        const r1 = this.normalizeHostnameValue(raw, modeBits);
        if ( r1 === undefined ) { return; }
        if ( r1 !== '' ) { return r1; }
        // Rare: Maybe advanced syntax is used
        const match = this.reAdvancedDomainSyntax.exec(raw);
        if ( match === null ) { return '' };
        const isAncestor = match[2] !== undefined;
        if ( isAncestor && (modeBits & DOMAIN_CAN_BE_ANCESTOR) === 0 ) { return ''; }
        const hasPath = match[3] !== undefined;
        if ( hasPath && (modeBits & DOMAIN_CAN_HAVE_PATH) === 0 ) { return ''; }
        if ( isAncestor && hasPath ) { return ''; }
        const r2 = this.normalizeHostnameValue(match[1], modeBits);
        if ( r2 === undefined ) { return; }
        if ( r2 === '' ) { return ''; }
        return `${r2}${match[2] ?? ''}${match[3] ?? ''}`;
    }

    normalizeDomainRegexValue(before) {
        const regex = before.startsWith('[$domain=/')
            ? `${before.slice(9, -1)}`
            : before;
        // Checked 2026-07-28 against the live upstream lists this project
        // actually compiles from (tools/build-rulesets.mjs's own source
        // URLs — AdGuard Base: 164152 lines, AdGuard TrackParam: 3866
        // lines): 14 real `[$domain=/.../]` rules currently exist in
        // Base, none contain an over-escaped `\|`, and two correctly use
        // *unescaped* `|` as regex alternation (`(net|com)`,
        // `(vibe|noble|stellar|halo|echo)`) — exactly the well-formed
        // syntax this unescaping step exists to tolerate the absence of.
        // Kept anyway: this depends on AdGuard's own future filter-list
        // authoring, not something this project controls, so today's
        // clean result doesn't guarantee it stays that way. The
        // replace() below is a no-op whenever `\|` isn't present, so
        // there's no cost to leaving it in place defensively. If a
        // literal `|` is ever needed in a path-based regex, the solution
        // is to use `\x7C` instead of `\|`.
        const source = this.normalizeRegexPattern(regex.replace(/\\\|/g, '|'));
        if ( source === '' ) { return ''; }
        const after = `/${source}/`;
        if ( after === before ) { return; }
        return after;
    }

    /* ══════════════════════════════════════════════════════════════
       8. EXTENDED FILTERS
       site##… lines: cosmetic, scriptlet (+js), HTML (^) and response-header filters
       ══════════════════════════════════════════════════════════════ */

    parseExt(parent, anchorBeg, anchorLen) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        const head = this.allocHeadNode();
        let prev = head, next = 0;
        this.astType = AST_TYPE_EXTENDED;
        this.addFlags(this.extFlagsFromAnchor(anchorBeg));
        if ( anchorBeg > parentBeg ) {
            next = this.allocTypedNode(
                NODE_TYPE_EXT_OPTIONS,
                parentBeg,
                anchorBeg
            );
            this.addFlags(AST_FLAG_HAS_OPTIONS);
            this.addNodeToRegister(NODE_TYPE_EXT_OPTIONS, next);
            const down = this.parseDomainList(next, ',', DOMAIN_FROM_EXT_LIST);
            this.linkDown(next, down);
            prev = this.linkRight(prev, next);
        }
        next = this.allocTypedNode(
            NODE_TYPE_EXT_OPTIONS_ANCHOR,
            anchorBeg,
            anchorBeg + anchorLen
        );
        this.addNodeToRegister(NODE_TYPE_EXT_OPTIONS_ANCHOR, next);
        prev = this.linkRight(prev, next);
        next = this.allocTypedNode(
            NODE_TYPE_EXT_PATTERN_RAW,
            anchorBeg + anchorLen,
            parentEnd
        );
        this.addNodeToRegister(NODE_TYPE_EXT_PATTERN_RAW, next);
        const down = this.parseExtPattern(next);
        if ( down !== 0 ) {
            this.linkDown(next, down);
        } else {
            this.addNodeFlags(next, NODE_FLAG_ERROR);
            this.addFlags(AST_FLAG_HAS_ERROR);
        }
        this.linkRight(prev, next);
        this.validateExt();
        return this.throwHeadNode(head);
    }

    extFlagsFromAnchor(anchorBeg) {
        let c = this.charCodeAt(anchorBeg+1) ;
        if ( c === 0x23 /* # */ ) { return 0; }
        if ( c === 0x25 /* % */ ) { return AST_FLAG_EXT_SCRIPTLET_ADG; }
        if ( c === 0x3F /* ? */ ) { return AST_FLAG_EXT_STRONG; }
        if ( c === 0x24 /* $ */ ) {
            c = this.charCodeAt(anchorBeg+2);
            if ( c === 0x23 /* # */ ) { return AST_FLAG_EXT_STYLE; }
            if ( c === 0x3F /* ? */ ) {
                return AST_FLAG_EXT_STYLE | AST_FLAG_EXT_STRONG;
            }
        }
        if ( c === 0x40 /* @ */ ) {
            return AST_FLAG_IS_EXCEPTION | this.extFlagsFromAnchor(anchorBeg+1);
        }
        return AST_FLAG_UNSUPPORTED | AST_FLAG_HAS_ERROR;
    }

    validateExt() {
        const isException = this.isException();
        let realBad = false;
        for ( let i = 0, n = this.nodeTypeRegisterPtr; i < n; i++ ) {
            const type = this.nodeTypeRegister[i];
            const targetNode = this.nodeTypeLookupTable[type];
            if ( targetNode === 0 ) { continue; }
            const flags = this.getNodeFlags(targetNode);
            if ( (flags & NODE_FLAG_ERROR) !== 0 ) { continue; }
            realBad = false;
            switch ( type ) {
            case NODE_TYPE_EXT_PATTERN_RESPONSEHEADER: {
                const pattern = this.getNodeString(targetNode);
                realBad =
                    pattern !== '' && removableHTTPHeaders.has(pattern) === false ||
                    pattern === '' && isException === false;
                break;
            }
            case NODE_TYPE_EXT_PATTERN_SCRIPTLET_TOKEN: {
                if ( this.interactive !== true ) { break; }
                if ( isException ) { break; }
                const { trustedSource, trustedScriptletTokens } = this.options;
                if ( trustedScriptletTokens instanceof Set === false ) { break; }
                const token = this.getNodeString(targetNode);
                if ( trustedScriptletTokens.has(token) && trustedSource !== true ) {
                    this.astError = AST_ERROR_UNTRUSTED_SOURCE;
                    realBad = true;
                }
                break;
            }
            default:
                break;
            }
            if ( realBad ) {
                this.addNodeFlags(targetNode, NODE_FLAG_ERROR);
                this.addFlags(AST_FLAG_HAS_ERROR);
            }
        }
    }

    parseExtPattern(parent) {
        const c = this.charCodeAt(this.nodes[parent+NODE_BEG_INDEX]);
        // ##+js(...)
        if ( c === 0x2B /* + */ ) {
            const s = this.getNodeString(parent);
            if ( /^\+js\(.*\)$/.exec(s) !== null ) {
                this.astTypeFlavor = AST_TYPE_EXTENDED_SCRIPTLET;
                return this.parseExtPatternScriptlet(parent);
            }
        }
        // #%#//scriptlet(...)
        if ( this.getFlags(AST_FLAG_EXT_SCRIPTLET_ADG) ) {
            const s = this.getNodeString(parent);
            if ( /^\/\/scriptlet\(.*\)$/.exec(s) !== null ) {
                this.astTypeFlavor = AST_TYPE_EXTENDED_SCRIPTLET;
                return this.parseExtPatternScriptlet(parent);
            }
            return 0;
        }
        // ##^... | ##^responseheader(...)
        if ( c === 0x5E /* ^ */ ) {
            const s = this.getNodeString(parent);
            if ( this.reResponseheaderPattern.test(s) ) {
                this.astTypeFlavor = AST_TYPE_EXTENDED_RESPONSEHEADER;
                return this.parseExtPatternResponseheader(parent);
            }
            this.astTypeFlavor = AST_TYPE_EXTENDED_HTML;
            return this.parseExtPatternHtml(parent);
        }
        // ##...
        this.astTypeFlavor = AST_TYPE_EXTENDED_COSMETIC;
        return this.parseExtPatternCosmetic(parent);
    }

    parseExtPatternScriptlet(parent) {
        const beg = this.nodes[parent+NODE_BEG_INDEX];
        const end = this.nodes[parent+NODE_END_INDEX];
        const s = this.getNodeString(parent);
        const rawArg0 = beg + (s.startsWith('+js') ? 4 : 12);
        const rawArg1 = end - 1;
        const head = this.allocTypedNode(NODE_TYPE_EXT_DECORATION, beg, rawArg0);
        let prev = head, next = 0;
        next = this.allocTypedNode(NODE_TYPE_EXT_PATTERN_SCRIPTLET, rawArg0, rawArg1);
        this.addNodeToRegister(NODE_TYPE_EXT_PATTERN_SCRIPTLET, next);
        this.linkDown(next, this.parseExtPatternScriptletArgs(next));
        prev = this.linkRight(prev, next);
        next = this.allocTypedNode(NODE_TYPE_EXT_DECORATION, rawArg1, end);
        this.linkRight(prev, next);
        return head;
    }

    parseExtPatternScriptletArgs(parent) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        if ( parentEnd === parentBeg ) { return 0; }
        const head = this.allocHeadNode();
        let prev = head, next = 0;
        const s = this.getNodeString(parent);
        const argsEnd = s.length;
        // token
        this.scriptletArgListParser.mustQuote = 
            this.getFlags(AST_FLAG_EXT_SCRIPTLET_ADG) !== 0;
        const details = this.scriptletArgListParser.nextArg(s, 0);
        if ( details.argBeg > 0 ) {
            next = this.allocTypedNode(
                NODE_TYPE_EXT_DECORATION,
                parentBeg,
                parentBeg + details.argBeg
            );
            prev = this.linkRight(prev, next);
        }
        const token = s.slice(details.argBeg, details.argEnd);
        const tokenEnd = details.argEnd - (token.endsWith('.js') ? 3 : 0);
        next = this.allocTypedNode(
            NODE_TYPE_EXT_PATTERN_SCRIPTLET_TOKEN,
            parentBeg + details.argBeg,
            parentBeg + tokenEnd
        );
        this.addNodeToRegister(NODE_TYPE_EXT_PATTERN_SCRIPTLET_TOKEN, next);
        if ( details.failed ) {
            this.addNodeFlags(next, NODE_FLAG_ERROR);
            this.addFlags(AST_FLAG_HAS_ERROR);
        }
        prev = this.linkRight(prev, next);
        if ( tokenEnd < details.argEnd ) {
            next = this.allocTypedNode(
                NODE_TYPE_IGNORE,
                parentBeg + tokenEnd,
                parentBeg + details.argEnd
            );
            prev = this.linkRight(prev, next);
        }
        if ( details.quoteEnd < argsEnd ) {
            next = this.allocTypedNode(
                NODE_TYPE_EXT_DECORATION,
                parentBeg + details.argEnd,
                parentBeg + details.separatorEnd
            );
            prev = this.linkRight(prev, next);
        }
        // all args
        next = this.allocTypedNode(
            NODE_TYPE_EXT_PATTERN_SCRIPTLET_ARGS,
            parentBeg + details.separatorEnd,
            parentBeg + argsEnd
        );
        this.linkDown(next, this.parseExtPatternScriptletArglist(next));
        this.linkRight(prev, next);
        return this.throwHeadNode(head);
    }

    parseExtPatternScriptletArglist(parent) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        if ( parentEnd === parentBeg ) { return 0; }
        const s = this.getNodeString(parent);
        const argsEnd = s.length;
        const head = this.allocHeadNode();
        let prev = head, next = 0;
        let decorationBeg = 0;
        let i = 0;
        for (;;) {
            const details = this.scriptletArgListParser.nextArg(s, i);
            if ( decorationBeg < details.argBeg ) {
                next = this.allocTypedNode(
                    NODE_TYPE_EXT_DECORATION,
                    parentBeg + decorationBeg,
                    parentBeg + details.argBeg
                );
                prev = this.linkRight(prev, next);
            }
            if ( i === argsEnd ) { break; }
            next = this.allocTypedNode(
                NODE_TYPE_EXT_PATTERN_SCRIPTLET_ARG,
                parentBeg + details.argBeg,
                parentBeg + details.argEnd
            );
            if ( details.transform ) {
                const arg = s.slice(details.argBeg, details.argEnd);
                this.setNodeTransform(next,
                    this.scriptletArgListParser.normalizeArg(arg)
                );
            }
            prev = this.linkRight(prev, next);
            if ( details.failed ) {
                this.addNodeFlags(next, NODE_FLAG_ERROR);
                this.addFlags(AST_FLAG_HAS_ERROR);
            }
            decorationBeg = details.argEnd;
            i = details.separatorEnd;
        }
        return this.throwHeadNode(head);
    }

    getScriptletArgs() {
        const args = [];
        if ( this.isScriptletFilter() === false ) { return args; }
        const root = this.getBranchFromType(NODE_TYPE_EXT_PATTERN_SCRIPTLET);
        const walker = this.getWalker(root);
        for ( let node = walker.next(); node !== 0; node = walker.next() ) {
            switch ( this.getNodeType(node) ) {
            case NODE_TYPE_EXT_PATTERN_SCRIPTLET_TOKEN:
            case NODE_TYPE_EXT_PATTERN_SCRIPTLET_ARG:
                args.push(this.getNodeTransform(node));
                break;
            default:
                break;
            }
        }
        walker.dispose();
        return args;
    }

    parseExtPatternResponseheader(parent) {
        const beg = this.nodes[parent+NODE_BEG_INDEX];
        const end = this.nodes[parent+NODE_END_INDEX];
        const s = this.getNodeString(parent);
        const rawArg0 = beg + 16;
        const rawArg1 = end - 1;
        const head = this.allocTypedNode(NODE_TYPE_EXT_DECORATION, beg, rawArg0);
        let prev = head, next = 0;
        const trimmedArg0 = rawArg0 + this.leftWhitespaceCount(s);
        const trimmedArg1 = rawArg1 - this.rightWhitespaceCount(s);
        if ( trimmedArg0 !== rawArg0 ) {
            next = this.allocTypedNode(NODE_TYPE_WHITESPACE, rawArg0, trimmedArg0);
            prev = this.linkRight(prev, next);
        }
        next = this.allocTypedNode(NODE_TYPE_EXT_PATTERN_RESPONSEHEADER, rawArg0, rawArg1);
        this.addNodeToRegister(NODE_TYPE_EXT_PATTERN_RESPONSEHEADER, next);
        if ( rawArg1 === rawArg0 && this.isException() === false ) {
            this.addNodeFlags(parent, NODE_FLAG_ERROR);
            this.addFlags(AST_FLAG_HAS_ERROR);
        }
        prev = this.linkRight(prev, next);
        if ( trimmedArg1 !== rawArg1 ) {
            next = this.allocTypedNode(NODE_TYPE_WHITESPACE, trimmedArg1, rawArg1);
            prev = this.linkRight(prev, next);
        }
        next = this.allocTypedNode(NODE_TYPE_EXT_DECORATION, rawArg1, end);
        this.linkRight(prev, next);
        return head;
    }

    getResponseheaderName() {
        if ( this.isResponseheaderFilter() === false ) { return ''; }
        const root = this.getBranchFromType(NODE_TYPE_EXT_PATTERN_RESPONSEHEADER);
        return this.getNodeString(root);
    }

    parseExtPatternHtml(parent) {
        const beg = this.nodes[parent+NODE_BEG_INDEX];
        const end = this.nodes[parent+NODE_END_INDEX];
        const head = this.allocTypedNode(NODE_TYPE_EXT_DECORATION, beg, beg + 1);
        let prev = head, next = 0;
        next = this.allocTypedNode(NODE_TYPE_EXT_PATTERN_HTML, beg + 1, end);
        this.linkRight(prev, next);
        if ( (this.hasOptions() || this.isException()) === false ) {
            this.addNodeFlags(parent, NODE_FLAG_ERROR);
            this.addFlags(AST_FLAG_HAS_ERROR);
            return head;
        }
        this.result.exception = this.isException();
        this.result.raw = this.getNodeString(next);
        this.result.compiled = undefined;
        const success = this.selectorCompiler.compile(
            this.result.raw,
            this.result, {
                asProcedural: this.getFlags(AST_FLAG_EXT_STRONG) !== 0
            }
        );
        if ( success !== true ) {
            this.addNodeFlags(next, NODE_FLAG_ERROR);
            this.addFlags(AST_FLAG_HAS_ERROR);
        }
        return head;
    }

    parseExtPatternCosmetic(parent) {
        const parentBeg = this.nodes[parent+NODE_BEG_INDEX];
        const parentEnd = this.nodes[parent+NODE_END_INDEX];
        const head = this.allocTypedNode(
            NODE_TYPE_EXT_PATTERN_COSMETIC,
            parentBeg,
            parentEnd
        );
        this.addNodeToRegister(NODE_TYPE_EXT_PATTERN_COSMETIC, head);
        this.result.exception = this.isException();
        this.result.raw = this.getNodeString(head);
        this.result.compiled = undefined;
        const success = this.selectorCompiler.compile(
            this.result.raw,
            this.result, {
                asProcedural: this.getFlags(AST_FLAG_EXT_STRONG) !== 0,
                adgStyleSyntax: this.getFlags(AST_FLAG_EXT_STYLE) !== 0,
            }
        );
        if ( success !== true ) {
            this.addNodeFlags(head, NODE_FLAG_ERROR);
            this.addFlags(AST_FLAG_HAS_ERROR);
        }
        return head;
    }

    /* ══════════════════════════════════════════════════════════════
       9. AST NODE POOL
       allocating, linking and flagging nodes in the shared Uint32Array
       ══════════════════════════════════════════════════════════════ */

    linkRight(prev, next) {
        return (this.nodes[prev+NODE_RIGHT_INDEX] = next);
    }

    linkDown(node, down) {
        return (this.nodes[node+NODE_DOWN_INDEX] = down);
    }

    makeChain(nodes) {
        for ( let i = 1; i < nodes.length; i++ ) {
            this.nodes[nodes[i-1]+NODE_RIGHT_INDEX] = nodes[i];
        }
        return nodes[0];
    }

    allocHeadNode() {
        const node = this.nodePoolPtr;
        this.nodePoolPtr += NOOP_NODE_SIZE;
        if ( this.nodePoolPtr > this.nodePoolEnd ) {
            this.growNodePool(this.nodePoolPtr);
        }
        this.nodes[node+NODE_RIGHT_INDEX] = 0;
        return node;
    }

    throwHeadNode(head) {
        return this.nodes[head+NODE_RIGHT_INDEX];
    }

    allocTypedNode(type, beg, end) {
        const node = this.nodePoolPtr;
        this.nodePoolPtr += FULL_NODE_SIZE;
        if ( this.nodePoolPtr > this.nodePoolEnd ) {
            this.growNodePool(this.nodePoolPtr);
        }
        this.nodes[node+NODE_RIGHT_INDEX] = 0;
        this.nodes[node+NODE_TYPE_INDEX] = type;
        this.nodes[node+NODE_DOWN_INDEX] = 0;
        this.nodes[node+NODE_BEG_INDEX] = beg;
        this.nodes[node+NODE_END_INDEX] = end;
        this.nodes[node+NODE_TRANSFORM_INDEX] = 0;
        this.nodes[node+NODE_FLAGS_INDEX] = 0;
        return node;
    }

    allocSentinelNode(type, beg) {
        return this.allocTypedNode(type, beg, beg);
    }

    growNodePool(min) {
        const oldSize = this.nodes.length;
        const newSize = (min + 16383) & ~16383;
        if ( newSize === oldSize ) { return; }
        const newArray = new Uint32Array(newSize);
        newArray.set(this.nodes);
        this.nodes = newArray;
        this.nodePoolEnd = newSize;
    }

    getNodeTypes() {
        return this.nodeTypeRegister.slice(0, this.nodeTypeRegisterPtr);
    }

    getNodeType(node) {
        return node !== 0 ? this.nodes[node+NODE_TYPE_INDEX] : 0;
    }

    getNodeFlags(node, flags = 0xFFFFFFFF) {
        return this.nodes[node+NODE_FLAGS_INDEX] & flags;
    }

    setNodeFlags(node, flags) {
        this.nodes[node+NODE_FLAGS_INDEX] = flags;
    }

    addNodeFlags(node, flags) {
        if ( node === 0 ) { return; }
        this.nodes[node+NODE_FLAGS_INDEX] |= flags;
    }

    removeNodeFlags(node, flags) {
        this.nodes[node+NODE_FLAGS_INDEX] &= ~flags;
    }

    addNodeToRegister(type, node) {
        this.nodeTypeRegister[this.nodeTypeRegisterPtr++] = type;
        this.nodeTypeLookupTable[type] = node;
    }

    getBranchFromType(type) {
        const ptr = this.nodeTypeRegisterPtr;
        if ( ptr === 0 ) { return 0; }
        return this.nodeTypeRegister.lastIndexOf(type, ptr-1) !== -1
            ? this.nodeTypeLookupTable[type]
            : 0;
    }

    /* ══════════════════════════════════════════════════════════════
       10. NODE TEXT AND TRANSFORMS
       the source slice of a node and its normalised (transformed) form
       ══════════════════════════════════════════════════════════════ */

    nodeIsEmptyString(node) {
        return this.nodes[node+NODE_END_INDEX] ===
            this.nodes[node+NODE_BEG_INDEX];
    }

    getNodeString(node) {
        const beg = this.nodes[node+NODE_BEG_INDEX];
        const end = this.nodes[node+NODE_END_INDEX];
        if ( end === beg ) { return ''; }
        if ( beg === 0 && end === this.rawEnd ) {
            return this.raw;
        }
        return this.raw.slice(beg, end);
    }

    getNodeStringBeg(node) {
        return this.nodes[node+NODE_BEG_INDEX];
    }

    getNodeStringEnd(node) {
        return this.nodes[node+NODE_END_INDEX];
    }

    getNodeStringLen(node) {
        if ( node === 0 ) { return ''; }
        return this.nodes[node+NODE_END_INDEX] - this.nodes[node+NODE_BEG_INDEX];
    }

    isNodeTransformed(node) {
        return this.nodes[node+NODE_TRANSFORM_INDEX] !== 0;
    }

    getNodeTransform(node) {
        if ( node === 0 ) { return ''; }
        const slot = this.nodes[node+NODE_TRANSFORM_INDEX];
        return slot !== 0 ? this.astTransforms[slot] : this.getNodeString(node);
    }

    setNodeTransform(node, value) {
        const slot = this.astTransformPtr++;
        this.astTransforms[slot] = value;
        this.nodes[node+NODE_TRANSFORM_INDEX] = slot;
    }

    getTypeString(type) {
        const node = this.getBranchFromType(type);
        if ( node === 0 ) { return; }
        return this.getNodeString(node);
    }

    /* ══════════════════════════════════════════════════════════════
       11. TEXT SCANNING AND NORMALISATION HELPERS
       character-level helpers used while parsing
       ══════════════════════════════════════════════════════════════ */

    leftWhitespaceCount(s) {
        const match = this.reWhitespaceStart.exec(s);
        return match === null ? 0 : match[0].length;
    }

    rightWhitespaceCount(s) {
        const match = this.reWhitespaceEnd.exec(s);
        return match === null ? 0 : match[1].length;
    }

    nextCommaInCommaSeparatedListString(s, start) {
        const n = s.length;
        if ( n === 0 ) { return -1; }
        const ilastchar = n - 1;
        let i = start;
        while ( i < n ) {
            const c = s.charCodeAt(i);
            if ( c === 0x2C /* ',' */ ) { return i + 1; }
            if ( c === 0x5C /* '\\' */ ) {
                if ( i < ilastchar ) { i += 1; }
            }
        }
        return -1;
    }

    endOfLiteralRegex(s, start) {
        const n = s.length;
        if ( n === 0 ) { return -1; }
        const ilastchar = n - 1;
        let i = start + 1;
        while ( i < n ) {
            const c = s.charCodeAt(i);
            if ( c === 0x2F /* '/' */ ) { return i + 1; }
            if ( c === 0x5C /* '\\' */ ) {
                if ( i < ilastchar ) { i += 1; }
            }
            i += 1;
        }
        return -1;
    }

    charCodeAt(pos) {
        return pos < this.rawEnd ? this.raw.charCodeAt(pos) : -1;
    }

    indexOf(needle, beg, end = 0) {
        const haystack = end === 0 ? this.raw : this.raw.slice(0, end);
        return haystack.indexOf(needle, beg);
    }

    startsWith(s, pos) {
        return pos < this.rawEnd && this.raw.startsWith(s, pos);
    }

    isTokenCharCode(c) {
        return c === 0x25 ||
            c >= 0x30 && c <= 0x39 ||
            c >= 0x41 && c <= 0x5A ||
            c >= 0x61 && c <= 0x7A;
    }

    // Ultimately, let the browser API do the hostname normalization, after
    // making some other trivial checks.
    //
    // returns:
    //   undefined: no normalization needed, use original hostname
    //   empty string: hostname is invalid
    //   non-empty string: normalized hostname
    normalizeHostnameValue(s, modeBits = 0) {
        if ( this.reHostnameAscii.test(s) ) { return; }
        if ( this.reBadHostnameChars.test(s) ) { return ''; }
        let hn = s;
        const hasWildcard = hn.includes('*');
        if ( hasWildcard ) {
            if ( modeBits === 0 ) { return ''; }
            if ( hn.length === 1 ) {
                if ( (modeBits & DOMAIN_CAN_USE_SINGLE_WILDCARD) === 0 ) { return ''; }
                return;
            }
            if ( (modeBits & DOMAIN_CAN_USE_ENTITY) !== 0 ) {
                if ( this.rePlainEntity.test(hn) ) { return; }
                if ( this.reIsEntity.test(hn) === false ) { return ''; }
            } else if ( (modeBits & DOMAIN_CAN_USE_WILDCARD) === 0 ) {
                return '';
            }
            hn = hn.replace(/\*/g, '__asterisk__');
        }
        this.punycoder.hostname = '_';
        try {
            this.punycoder.hostname = hn;
            hn = this.punycoder.hostname;
        } catch {
            return '';
        }
        if ( hn === '_' || hn === '' ) { return ''; }
        if ( hasWildcard ) {
            hn = this.punycoder.hostname.replace(/__asterisk__/g, '*');
        }
        if (
            (modeBits & DOMAIN_CAN_USE_WILDCARD) === 0 && (
                hn.charCodeAt(0) === 0x2E /* . */ ||
                exCharCodeAt(hn, -1) === 0x2E /* . */
            )
        ) {
            return '';
        }
        return hn;
    }

    normalizeRegexPattern(s) {
        try {
            const source = /^\/.+\/$/.test(s) ? s.slice(1,-1) : s;
            const regex = new RegExp(source);
            return regex.source;
        } catch (ex) {
            this.normalizeRegexPattern.message = ex.toString();
        }
        return '';
    }

    /* ══════════════════════════════════════════════════════════════
       12. ITERATORS AND TREE WALKING
       how consumers read the AST (compilers, syntax colouring, dump)
       ══════════════════════════════════════════════════════════════ */

    getDomainListIterator(root) {
        const iter = this.domainListIteratorJunkyard.length !== 0
            ? this.domainListIteratorJunkyard.pop().reuse(root)
            : new DomainListIterator(this, root);
        return root !== 0 ? iter : iter.stop();
    }

    getNetFilterFromOptionIterator() {
        return this.getDomainListIterator(
            this.getBranchFromType(NODE_TYPE_NET_OPTION_NAME_FROM)
        );
    }

    getNetFilterTopOptionIterator() {
        return this.getDomainListIterator(
            this.getBranchFromType(NODE_TYPE_NET_OPTION_NAME_TOP)
        );
    }

    getNetFilterToOptionIterator() {
        return this.getDomainListIterator(
            this.getBranchFromType(NODE_TYPE_NET_OPTION_NAME_TO)
        );
    }

    getNetFilterDenyallowOptionIterator() {
        return this.getDomainListIterator(
            this.getBranchFromType(NODE_TYPE_NET_OPTION_NAME_DENYALLOW)
        );
    }

    getExtFilterDomainIterator() {
        return this.getDomainListIterator(
            this.getBranchFromType(NODE_TYPE_EXT_OPTIONS)
        );
    }

    getWalker(from) {
        if ( this.walkerJunkyard.length === 0 ) {
            return new AstWalker(this, from);
        }
        const walker = this.walkerJunkyard.pop();
        walker.reset(from);
        return walker;
    }

    findDescendantByType(from, type) {
        const walker = this.getWalker(from);
        let node = walker.next();
        while ( node !== 0 ) {
            if ( this.getNodeType(node) === type ) { return node; }
            node = walker.next();
        }
        return 0;
    }

    dump() {
        if ( this.astType === AST_TYPE_COMMENT ) { return; }
        const walker = this.getWalker();
        for ( let node = walker.reset(); node !== 0; node = walker.next() ) {
            const type = this.nodes[node+NODE_TYPE_INDEX];
            const value = this.getNodeString(node);
            const name = nodeNameFromNodeType.get(type) || `${type}`;
            const bits = this.getNodeFlags(node).toString(2).padStart(4, '0');
            const indent = '  '.repeat(walker.depth);
            console.log(`${indent}type=${name} "${value}" 0b${bits}`);
            if ( this.isNodeTransformed(node) ) {
                console.log(`${indent}    transform="${this.getNodeTransform(node)}"`);
            }
        }
    }
}

/******************************************************************************/
//
// Barrel re-exports -- preserves the exact public sfp.* surface that
// existed before the split (150 exports total, unchanged). See the C1 note
// above for which file each symbol now physically lives in.
//
/******************************************************************************/

export {
    AST_ERROR_DOMAIN_NAME,
    AST_ERROR_IF_TOKEN_UNKNOWN,
    AST_ERROR_OPTION_BADVALUE,
    AST_ERROR_OPTION_DUPLICATE,
    AST_ERROR_OPTION_EXCLUDED,
    AST_ERROR_OPTION_UNKNOWN,
    AST_ERROR_PATTERN,
    AST_ERROR_REGEX,
    AST_ERROR_UNTRUSTED_SOURCE,
    AST_FLAG_EXT_SCRIPTLET_ADG,
    AST_FLAG_EXT_STRONG,
    AST_FLAG_EXT_STYLE,
    AST_FLAG_HAS_ERROR,
    AST_FLAG_HAS_OPTIONS,
    AST_FLAG_IGNORE,
    AST_FLAG_IS_EXCEPTION,
    AST_FLAG_NET_PATTERN_LEFT_ANCHOR,
    AST_FLAG_NET_PATTERN_LEFT_HNANCHOR,
    AST_FLAG_NET_PATTERN_RIGHT_ANCHOR,
    AST_FLAG_NET_PATTERN_RIGHT_PATHANCHOR,
    AST_FLAG_UNSUPPORTED,
    AST_TYPE_COMMENT,
    AST_TYPE_COMMENT_PREPARSER,
    AST_TYPE_EXTENDED,
    AST_TYPE_EXTENDED_COSMETIC,
    AST_TYPE_EXTENDED_HTML,
    AST_TYPE_EXTENDED_RESPONSEHEADER,
    AST_TYPE_EXTENDED_SCRIPTLET,
    AST_TYPE_NETWORK,
    AST_TYPE_NETWORK_PATTERN_ANY,
    AST_TYPE_NETWORK_PATTERN_BAD,
    AST_TYPE_NETWORK_PATTERN_GENERIC,
    AST_TYPE_NETWORK_PATTERN_HOSTNAME,
    AST_TYPE_NETWORK_PATTERN_PLAIN,
    AST_TYPE_NETWORK_PATTERN_REGEX,
    AST_TYPE_NONE,
    AST_TYPE_UNKNOWN,
    NODE_FLAG_ERROR,
    NODE_FLAG_IGNORE,
    NODE_FLAG_IS_NEGATED,
    NODE_FLAG_OPTION_HAS_VALUE,
    NODE_TYPE_COMMENT,
    NODE_TYPE_COMMENT_URL,
    NODE_TYPE_COUNT,
    NODE_TYPE_EXT_DECORATION,
    NODE_TYPE_EXT_OPTIONS,
    NODE_TYPE_EXT_OPTIONS_ANCHOR,
    NODE_TYPE_EXT_PATTERN_COSMETIC,
    NODE_TYPE_EXT_PATTERN_HTML,
    NODE_TYPE_EXT_PATTERN_RAW,
    NODE_TYPE_EXT_PATTERN_RESPONSEHEADER,
    NODE_TYPE_EXT_PATTERN_SCRIPTLET,
    NODE_TYPE_EXT_PATTERN_SCRIPTLET_ARG,
    NODE_TYPE_EXT_PATTERN_SCRIPTLET_ARGS,
    NODE_TYPE_EXT_PATTERN_SCRIPTLET_TOKEN,
    NODE_TYPE_EXT_RAW,
    NODE_TYPE_IGNORE,
    NODE_TYPE_LINE_BODY,
    NODE_TYPE_LINE_RAW,
    NODE_TYPE_NET_EXCEPTION,
    NODE_TYPE_NET_OPTIONS,
    NODE_TYPE_NET_OPTIONS_ANCHOR,
    NODE_TYPE_NET_OPTION_ASSIGN,
    NODE_TYPE_NET_OPTION_NAME_1P,
    NODE_TYPE_NET_OPTION_NAME_3P,
    NODE_TYPE_NET_OPTION_NAME_ALL,
    NODE_TYPE_NET_OPTION_NAME_BADFILTER,
    NODE_TYPE_NET_OPTION_NAME_CNAME,
    NODE_TYPE_NET_OPTION_NAME_CSP,
    NODE_TYPE_NET_OPTION_NAME_CSS,
    NODE_TYPE_NET_OPTION_NAME_DENYALLOW,
    NODE_TYPE_NET_OPTION_NAME_DOC,
    NODE_TYPE_NET_OPTION_NAME_EHIDE,
    NODE_TYPE_NET_OPTION_NAME_EMPTY,
    NODE_TYPE_NET_OPTION_NAME_FONT,
    NODE_TYPE_NET_OPTION_NAME_FRAME,
    NODE_TYPE_NET_OPTION_NAME_FROM,
    NODE_TYPE_NET_OPTION_NAME_GENERICBLOCK,
    NODE_TYPE_NET_OPTION_NAME_GHIDE,
    NODE_TYPE_NET_OPTION_NAME_IMAGE,
    NODE_TYPE_NET_OPTION_NAME_IMPORTANT,
    NODE_TYPE_NET_OPTION_NAME_INLINEFONT,
    NODE_TYPE_NET_OPTION_NAME_INLINESCRIPT,
    NODE_TYPE_NET_OPTION_NAME_IPADDRESS,
    NODE_TYPE_NET_OPTION_NAME_MATCHCASE,
    NODE_TYPE_NET_OPTION_NAME_MEDIA,
    NODE_TYPE_NET_OPTION_NAME_METHOD,
    NODE_TYPE_NET_OPTION_NAME_MP4,
    NODE_TYPE_NET_OPTION_NAME_NOOP,
    NODE_TYPE_NET_OPTION_NAME_NOT,
    NODE_TYPE_NET_OPTION_NAME_OBJECT,
    NODE_TYPE_NET_OPTION_NAME_OTHER,
    NODE_TYPE_NET_OPTION_NAME_PERMISSIONS,
    NODE_TYPE_NET_OPTION_NAME_PING,
    NODE_TYPE_NET_OPTION_NAME_POPUNDER,
    NODE_TYPE_NET_OPTION_NAME_POPUP,
    NODE_TYPE_NET_OPTION_NAME_REASON,
    NODE_TYPE_NET_OPTION_NAME_REDIRECT,
    NODE_TYPE_NET_OPTION_NAME_REDIRECTRULE,
    NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM,
    NODE_TYPE_NET_OPTION_NAME_REPLACE,
    NODE_TYPE_NET_OPTION_NAME_REQUESTHEADER,
    NODE_TYPE_NET_OPTION_NAME_RESPONSEHEADER,
    NODE_TYPE_NET_OPTION_NAME_SCRIPT,
    NODE_TYPE_NET_OPTION_NAME_SHIDE,
    NODE_TYPE_NET_OPTION_NAME_STRICT1P,
    NODE_TYPE_NET_OPTION_NAME_STRICT3P,
    NODE_TYPE_NET_OPTION_NAME_TO,
    NODE_TYPE_NET_OPTION_NAME_TOP,
    NODE_TYPE_NET_OPTION_NAME_UNKNOWN,
    NODE_TYPE_NET_OPTION_NAME_URLSKIP,
    NODE_TYPE_NET_OPTION_NAME_URLTRANSFORM,
    NODE_TYPE_NET_OPTION_NAME_WEBRTC,
    NODE_TYPE_NET_OPTION_NAME_WEBSOCKET,
    NODE_TYPE_NET_OPTION_NAME_XHR,
    NODE_TYPE_NET_OPTION_QUOTE,
    NODE_TYPE_NET_OPTION_RAW,
    NODE_TYPE_NET_OPTION_SENTINEL,
    NODE_TYPE_NET_OPTION_SEPARATOR,
    NODE_TYPE_NET_OPTION_VALUE,
    NODE_TYPE_NET_PATTERN,
    NODE_TYPE_NET_PATTERN_LEFT_ANCHOR,
    NODE_TYPE_NET_PATTERN_LEFT_HNANCHOR,
    NODE_TYPE_NET_PATTERN_PART,
    NODE_TYPE_NET_PATTERN_PART_SPECIAL,
    NODE_TYPE_NET_PATTERN_PART_UNICODE,
    NODE_TYPE_NET_PATTERN_RAW,
    NODE_TYPE_NET_PATTERN_RIGHT_ANCHOR,
    NODE_TYPE_NET_RAW,
    NODE_TYPE_NOOP,
    NODE_TYPE_OPTION_VALUE_DOMAIN,
    NODE_TYPE_OPTION_VALUE_DOMAIN_LIST,
    NODE_TYPE_OPTION_VALUE_DOMAIN_RAW,
    NODE_TYPE_OPTION_VALUE_NOT,
    NODE_TYPE_OPTION_VALUE_SEPARATOR,
    NODE_TYPE_PREPARSE_DIRECTIVE,
    NODE_TYPE_PREPARSE_DIRECTIVE_IF_VALUE,
    NODE_TYPE_PREPARSE_DIRECTIVE_VALUE,
    NODE_TYPE_WHITESPACE,
    nodeNameFromNodeType,
    nodeTypeFromOptionName,
    removableHTTPHeaders
};

export { ExtSelectorCompiler };

export {
    parseReplaceByRegexValue,
    parseReplaceValue,
    netOptionTokenDescriptors,
    utils,
};

export { parseQueryPruneValue, parseHeaderValue } from './filter-parser-helpers.js';
