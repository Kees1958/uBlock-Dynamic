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
//
// filter-ast-constants.js -- pure data: AST/node type IDs, flag bitmasks,
// error bitmasks, and lookup tables used by the filter-list parser.
//
// Split out of static-filtering-parser.js (see CHANGELOG.md) so that adding
// or removing a constant is a data-table edit, not a hand-verified
// renumbering exercise across a single giant file. Every constant below
// participates in one of several `iota`-based numbering sequences (each
// sequence starts with `iota = 0;`) -- inserting or deleting an entry
// *within* a sequence renumbers every entry after it in that same sequence.
// Appending a new entry at the *end* of a sequence, just before the next
// `iota = 0;` reset, is always safe.
//
// Every export here is importable by sibling modules (filter-parser-
// helpers.js, ext-selector-compiler.js, static-filtering-parser.js). This is
// an internal module boundary, separate from the public `sfp.*` surface that
// external consumers (ubo-parser.js, filter-editor.js, compile-filters.js)
// use -- that public surface is preserved exactly via explicit re-exports in
// static-filtering-parser.js, regardless of which file a symbol now lives in.
//
/******************************************************************************/

let iota = 0;

iota = 0;
export const AST_TYPE_NONE                            = iota++;
export const AST_TYPE_UNKNOWN                         = iota++;
export const AST_TYPE_COMMENT                         = iota++;
export const AST_TYPE_NETWORK                         = iota++;
export const AST_TYPE_EXTENDED                        = iota++;

iota = 0;
export const AST_TYPE_NETWORK_PATTERN_ANY             = iota++;
export const AST_TYPE_NETWORK_PATTERN_HOSTNAME        = iota++;
export const AST_TYPE_NETWORK_PATTERN_PLAIN           = iota++;
export const AST_TYPE_NETWORK_PATTERN_REGEX           = iota++;
export const AST_TYPE_NETWORK_PATTERN_GENERIC         = iota++;
export const AST_TYPE_NETWORK_PATTERN_BAD             = iota++;
export const AST_TYPE_EXTENDED_COSMETIC               = iota++;
export const AST_TYPE_EXTENDED_SCRIPTLET              = iota++;
export const AST_TYPE_EXTENDED_HTML                   = iota++;
export const AST_TYPE_EXTENDED_RESPONSEHEADER         = iota++;
export const AST_TYPE_COMMENT_PREPARSER               = iota++;

iota = 0;
export const AST_FLAG_UNSUPPORTED                     = 1 << iota++;
export const AST_FLAG_IGNORE                          = 1 << iota++;
export const AST_FLAG_HAS_ERROR                       = 1 << iota++;
export const AST_FLAG_IS_EXCEPTION                    = 1 << iota++;
export const AST_FLAG_EXT_STRONG                      = 1 << iota++;
export const AST_FLAG_EXT_STYLE                       = 1 << iota++;
export const AST_FLAG_EXT_SCRIPTLET_ADG               = 1 << iota++;
export const AST_FLAG_NET_PATTERN_LEFT_HNANCHOR       = 1 << iota++;
export const AST_FLAG_NET_PATTERN_RIGHT_PATHANCHOR    = 1 << iota++;
export const AST_FLAG_NET_PATTERN_LEFT_ANCHOR         = 1 << iota++;
export const AST_FLAG_NET_PATTERN_RIGHT_ANCHOR        = 1 << iota++;
export const AST_FLAG_HAS_OPTIONS                     = 1 << iota++;

iota = 0;
// Not exported: verified unused by any consumer. Kept un-exported (rather
// than removed) to preserve the iota numbering of the AST_ERROR_* flags
// that follow it in this sequence.
iota++;   // (10.7.6) slot of the unused AST_ERROR_NONE: kept so every value after it stays the same
export const AST_ERROR_REGEX                          = 1 << iota++;
export const AST_ERROR_PATTERN                        = 1 << iota++;
export const AST_ERROR_DOMAIN_NAME                    = 1 << iota++;
export const AST_ERROR_OPTION_DUPLICATE               = 1 << iota++;
export const AST_ERROR_OPTION_UNKNOWN                 = 1 << iota++;
export const AST_ERROR_OPTION_BADVALUE                = 1 << iota++;
export const AST_ERROR_OPTION_EXCLUDED                = 1 << iota++;
export const AST_ERROR_IF_TOKEN_UNKNOWN               = 1 << iota++;
export const AST_ERROR_UNTRUSTED_SOURCE               = 1 << iota++;

iota = 0;
export const NODE_RIGHT_INDEX                                = iota++;
export const NOOP_NODE_SIZE                                  = iota;
export const NODE_TYPE_INDEX                                 = iota++;
export const NODE_DOWN_INDEX                                 = iota++;
export const NODE_BEG_INDEX                                  = iota++;
export const NODE_END_INDEX                                  = iota++;
export const NODE_FLAGS_INDEX                                = iota++;
export const NODE_TRANSFORM_INDEX                            = iota++;
export const FULL_NODE_SIZE                                  = iota;

iota = 0;
export const NODE_TYPE_NOOP                           = iota++;
export const NODE_TYPE_LINE_RAW                       = iota++;
export const NODE_TYPE_LINE_BODY                      = iota++;
export const NODE_TYPE_WHITESPACE                     = iota++;
export const NODE_TYPE_COMMENT                        = iota++;
export const NODE_TYPE_IGNORE                         = iota++;
export const NODE_TYPE_EXT_RAW                        = iota++;
export const NODE_TYPE_EXT_OPTIONS_ANCHOR             = iota++;
export const NODE_TYPE_EXT_OPTIONS                    = iota++;
export const NODE_TYPE_EXT_DECORATION                 = iota++;
export const NODE_TYPE_EXT_PATTERN_RAW                = iota++;
export const NODE_TYPE_EXT_PATTERN_COSMETIC           = iota++;
export const NODE_TYPE_EXT_PATTERN_HTML               = iota++;
export const NODE_TYPE_EXT_PATTERN_RESPONSEHEADER     = iota++;
export const NODE_TYPE_EXT_PATTERN_SCRIPTLET          = iota++;
export const NODE_TYPE_EXT_PATTERN_SCRIPTLET_TOKEN    = iota++;
export const NODE_TYPE_EXT_PATTERN_SCRIPTLET_ARGS     = iota++;
export const NODE_TYPE_EXT_PATTERN_SCRIPTLET_ARG      = iota++;
export const NODE_TYPE_NET_RAW                        = iota++;
export const NODE_TYPE_NET_EXCEPTION                  = iota++;
export const NODE_TYPE_NET_PATTERN_RAW                = iota++;
export const NODE_TYPE_NET_PATTERN                    = iota++;
export const NODE_TYPE_NET_PATTERN_PART               = iota++;
export const NODE_TYPE_NET_PATTERN_PART_SPECIAL       = iota++;
export const NODE_TYPE_NET_PATTERN_PART_UNICODE       = iota++;
export const NODE_TYPE_NET_PATTERN_LEFT_HNANCHOR      = iota++;
export const NODE_TYPE_NET_PATTERN_LEFT_ANCHOR        = iota++;
export const NODE_TYPE_NET_PATTERN_RIGHT_ANCHOR       = iota++;
export const NODE_TYPE_NET_OPTIONS_ANCHOR             = iota++;
export const NODE_TYPE_NET_OPTIONS                    = iota++;
export const NODE_TYPE_NET_OPTION_SEPARATOR           = iota++;
export const NODE_TYPE_NET_OPTION_SENTINEL            = iota++;
export const NODE_TYPE_NET_OPTION_RAW                 = iota++;
export const NODE_TYPE_NET_OPTION_NAME_NOT            = iota++;
export const NODE_TYPE_NET_OPTION_NAME_UNKNOWN        = iota++;
export const NODE_TYPE_NET_OPTION_NAME_1P             = iota++;
export const NODE_TYPE_NET_OPTION_NAME_STRICT1P       = iota++;
export const NODE_TYPE_NET_OPTION_NAME_3P             = iota++;
export const NODE_TYPE_NET_OPTION_NAME_STRICT3P       = iota++;
export const NODE_TYPE_NET_OPTION_NAME_ALL            = iota++;
export const NODE_TYPE_NET_OPTION_NAME_BADFILTER      = iota++;
export const NODE_TYPE_NET_OPTION_NAME_CNAME          = iota++;
export const NODE_TYPE_NET_OPTION_NAME_CSP            = iota++;
export const NODE_TYPE_NET_OPTION_NAME_CSS            = iota++;
export const NODE_TYPE_NET_OPTION_NAME_DENYALLOW      = iota++;
export const NODE_TYPE_NET_OPTION_NAME_DOC            = iota++;
export const NODE_TYPE_NET_OPTION_NAME_EHIDE          = iota++;
export const NODE_TYPE_NET_OPTION_NAME_EMPTY          = iota++;
export const NODE_TYPE_NET_OPTION_NAME_FONT           = iota++;
export const NODE_TYPE_NET_OPTION_NAME_FRAME          = iota++;
export const NODE_TYPE_NET_OPTION_NAME_FROM           = iota++;
export const NODE_TYPE_NET_OPTION_NAME_GENERICBLOCK   = iota++;
export const NODE_TYPE_NET_OPTION_NAME_GHIDE          = iota++;
export const NODE_TYPE_NET_OPTION_NAME_RESPONSEHEADER = iota++;
export const NODE_TYPE_NET_OPTION_NAME_IMAGE          = iota++;
export const NODE_TYPE_NET_OPTION_NAME_IMPORTANT      = iota++;
export const NODE_TYPE_NET_OPTION_NAME_INLINEFONT     = iota++;
export const NODE_TYPE_NET_OPTION_NAME_INLINESCRIPT   = iota++;
export const NODE_TYPE_NET_OPTION_NAME_IPADDRESS      = iota++;
export const NODE_TYPE_NET_OPTION_NAME_MATCHCASE      = iota++;
export const NODE_TYPE_NET_OPTION_NAME_MEDIA          = iota++;
export const NODE_TYPE_NET_OPTION_NAME_METHOD         = iota++;
export const NODE_TYPE_NET_OPTION_NAME_MP4            = iota++;
export const NODE_TYPE_NET_OPTION_NAME_NOOP           = iota++;
export const NODE_TYPE_NET_OPTION_NAME_OBJECT         = iota++;
export const NODE_TYPE_NET_OPTION_NAME_OTHER          = iota++;
export const NODE_TYPE_NET_OPTION_NAME_PERMISSIONS    = iota++;
export const NODE_TYPE_NET_OPTION_NAME_PING           = iota++;
export const NODE_TYPE_NET_OPTION_NAME_POPUNDER       = iota++;
export const NODE_TYPE_NET_OPTION_NAME_POPUP          = iota++;
export const NODE_TYPE_NET_OPTION_NAME_REASON         = iota++;
export const NODE_TYPE_NET_OPTION_NAME_REDIRECT       = iota++;
export const NODE_TYPE_NET_OPTION_NAME_REDIRECTRULE   = iota++;
export const NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM    = iota++;
export const NODE_TYPE_NET_OPTION_NAME_REPLACE        = iota++;
export const NODE_TYPE_NET_OPTION_NAME_REQUESTHEADER  = iota++;
export const NODE_TYPE_NET_OPTION_NAME_SCRIPT         = iota++;
export const NODE_TYPE_NET_OPTION_NAME_SHIDE          = iota++;
export const NODE_TYPE_NET_OPTION_NAME_TO             = iota++;
export const NODE_TYPE_NET_OPTION_NAME_TOP            = iota++;
export const NODE_TYPE_NET_OPTION_NAME_URLSKIP        = iota++;
export const NODE_TYPE_NET_OPTION_NAME_URLTRANSFORM   = iota++;
export const NODE_TYPE_NET_OPTION_NAME_XHR            = iota++;
export const NODE_TYPE_NET_OPTION_NAME_WEBRTC         = iota++;
export const NODE_TYPE_NET_OPTION_NAME_WEBSOCKET      = iota++;
export const NODE_TYPE_NET_OPTION_ASSIGN              = iota++;
export const NODE_TYPE_NET_OPTION_QUOTE               = iota++;
export const NODE_TYPE_NET_OPTION_VALUE               = iota++;
export const NODE_TYPE_OPTION_VALUE_DOMAIN_LIST       = iota++;
export const NODE_TYPE_OPTION_VALUE_DOMAIN_RAW        = iota++;
export const NODE_TYPE_OPTION_VALUE_NOT               = iota++;
export const NODE_TYPE_OPTION_VALUE_DOMAIN            = iota++;
export const NODE_TYPE_OPTION_VALUE_SEPARATOR         = iota++;
export const NODE_TYPE_PREPARSE_DIRECTIVE             = iota++;
export const NODE_TYPE_PREPARSE_DIRECTIVE_VALUE       = iota++;
// Not exported: verified unused by any consumer. Kept un-exported (rather
// than removed) to preserve the iota numbering of the NODE_TYPE_* values
// that follow it in this sequence.
iota++;   // (10.7.6) slot of the unused NODE_TYPE_PREPARSE_DIRECTIVE_IF: kept so every value after it stays the same
export const NODE_TYPE_PREPARSE_DIRECTIVE_IF_VALUE    = iota++;
export const NODE_TYPE_COMMENT_URL                    = iota++;
export const NODE_TYPE_COUNT                          = iota;

iota = 0;
export const NODE_FLAG_IGNORE                         = 1 << iota++;
export const NODE_FLAG_ERROR                          = 1 << iota++;
export const NODE_FLAG_IS_NEGATED                     = 1 << iota++;
export const NODE_FLAG_OPTION_HAS_VALUE               = 1 << iota++;
// Not exported: verified unused by any consumer. Kept un-exported (rather
// than removed) to preserve the iota numbering of this NODE_FLAG_* sequence.
iota++;   // (10.7.6) slot of the unused NODE_FLAG_PATTERN_UNTOKENIZABLE: kept so every value after it stays the same

export const nodeTypeFromOptionName = new Map([
    [ '', NODE_TYPE_NET_OPTION_NAME_UNKNOWN ],
    [ '1p', NODE_TYPE_NET_OPTION_NAME_1P ],
    /* synonym */ [ 'first-party', NODE_TYPE_NET_OPTION_NAME_1P ],
    [ 'strict1p', NODE_TYPE_NET_OPTION_NAME_STRICT1P ],
    /* synonym */ [ 'strict-first-party', NODE_TYPE_NET_OPTION_NAME_STRICT1P ],
    [ '3p', NODE_TYPE_NET_OPTION_NAME_3P ],
    /* synonym */ [ 'third-party', NODE_TYPE_NET_OPTION_NAME_3P ],
    [ 'strict3p', NODE_TYPE_NET_OPTION_NAME_STRICT3P ],
    /* synonym */ [ 'strict-third-party', NODE_TYPE_NET_OPTION_NAME_STRICT3P ],
    [ 'all', NODE_TYPE_NET_OPTION_NAME_ALL ],
    [ 'badfilter', NODE_TYPE_NET_OPTION_NAME_BADFILTER ],
    [ 'cname', NODE_TYPE_NET_OPTION_NAME_CNAME ],
    [ 'csp', NODE_TYPE_NET_OPTION_NAME_CSP ],
    [ 'css', NODE_TYPE_NET_OPTION_NAME_CSS ],
    /* synonym */ [ 'stylesheet', NODE_TYPE_NET_OPTION_NAME_CSS ],
    [ 'denyallow', NODE_TYPE_NET_OPTION_NAME_DENYALLOW ],
    [ 'doc', NODE_TYPE_NET_OPTION_NAME_DOC ],
    /* synonym */ [ 'document', NODE_TYPE_NET_OPTION_NAME_DOC ],
    [ 'ehide', NODE_TYPE_NET_OPTION_NAME_EHIDE ],
    /* synonym */ [ 'elemhide', NODE_TYPE_NET_OPTION_NAME_EHIDE ],
    [ 'empty', NODE_TYPE_NET_OPTION_NAME_EMPTY ],
    [ 'font', NODE_TYPE_NET_OPTION_NAME_FONT ],
    [ 'frame', NODE_TYPE_NET_OPTION_NAME_FRAME ],
    /* synonym */ [ 'subdocument', NODE_TYPE_NET_OPTION_NAME_FRAME ],
    [ 'from', NODE_TYPE_NET_OPTION_NAME_FROM ],
    /* synonym */ [ 'domain', NODE_TYPE_NET_OPTION_NAME_FROM ],
    [ 'genericblock', NODE_TYPE_NET_OPTION_NAME_GENERICBLOCK ],
    [ 'ghide', NODE_TYPE_NET_OPTION_NAME_GHIDE ],
    /* synonym */ [ 'generichide', NODE_TYPE_NET_OPTION_NAME_GHIDE ],
    [ 'image', NODE_TYPE_NET_OPTION_NAME_IMAGE ],
    [ 'important', NODE_TYPE_NET_OPTION_NAME_IMPORTANT ],
    [ 'inline-font', NODE_TYPE_NET_OPTION_NAME_INLINEFONT ],
    [ 'inline-script', NODE_TYPE_NET_OPTION_NAME_INLINESCRIPT ],
    [ 'ipaddress', NODE_TYPE_NET_OPTION_NAME_IPADDRESS ],
    [ 'match-case', NODE_TYPE_NET_OPTION_NAME_MATCHCASE ],
    [ 'media', NODE_TYPE_NET_OPTION_NAME_MEDIA ],
    [ 'method', NODE_TYPE_NET_OPTION_NAME_METHOD ],
    [ 'mp4', NODE_TYPE_NET_OPTION_NAME_MP4 ],
    [ '_', NODE_TYPE_NET_OPTION_NAME_NOOP ],
    [ 'object', NODE_TYPE_NET_OPTION_NAME_OBJECT ],
    /* synonym */ [ 'object-subrequest', NODE_TYPE_NET_OPTION_NAME_OBJECT ],
    [ 'other', NODE_TYPE_NET_OPTION_NAME_OTHER ],
    [ 'permissions', NODE_TYPE_NET_OPTION_NAME_PERMISSIONS ],
    [ 'ping', NODE_TYPE_NET_OPTION_NAME_PING ],
    /* synonym */ [ 'beacon', NODE_TYPE_NET_OPTION_NAME_PING ],
    [ 'popunder', NODE_TYPE_NET_OPTION_NAME_POPUNDER ],
    [ 'popup', NODE_TYPE_NET_OPTION_NAME_POPUP ],
    [ 'reason', NODE_TYPE_NET_OPTION_NAME_REASON ],
    [ 'redirect', NODE_TYPE_NET_OPTION_NAME_REDIRECT ],
    /* synonym */ [ 'rewrite', NODE_TYPE_NET_OPTION_NAME_REDIRECT ],
    [ 'redirect-rule', NODE_TYPE_NET_OPTION_NAME_REDIRECTRULE ],
    [ 'removeparam', NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM ],
    [ 'replace', NODE_TYPE_NET_OPTION_NAME_REPLACE ],
    /* synonym */ [ 'queryprune', NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM ],
    [ 'requestheader', NODE_TYPE_NET_OPTION_NAME_REQUESTHEADER ],
    [ 'responseheader', NODE_TYPE_NET_OPTION_NAME_RESPONSEHEADER ],
    /* synonym */ [ 'header', NODE_TYPE_NET_OPTION_NAME_RESPONSEHEADER ],
    [ 'script', NODE_TYPE_NET_OPTION_NAME_SCRIPT ],
    [ 'shide', NODE_TYPE_NET_OPTION_NAME_SHIDE ],
    /* synonym */ [ 'specifichide', NODE_TYPE_NET_OPTION_NAME_SHIDE ],
    [ 'to', NODE_TYPE_NET_OPTION_NAME_TO ],
    [ 'top', NODE_TYPE_NET_OPTION_NAME_TOP ],
    [ 'urlskip', NODE_TYPE_NET_OPTION_NAME_URLSKIP ],
    [ 'uritransform', NODE_TYPE_NET_OPTION_NAME_URLTRANSFORM ],
    [ 'xhr', NODE_TYPE_NET_OPTION_NAME_XHR ],
    /* synonym */ [ 'xmlhttprequest', NODE_TYPE_NET_OPTION_NAME_XHR ],
    [ 'webrtc', NODE_TYPE_NET_OPTION_NAME_WEBRTC ],
    [ 'websocket', NODE_TYPE_NET_OPTION_NAME_WEBSOCKET ],
]);

export const nodeNameFromNodeType = new Map([
    [ NODE_TYPE_NOOP, 'noop' ],
    [ NODE_TYPE_LINE_RAW, 'lineRaw' ],
    [ NODE_TYPE_LINE_BODY, 'lineBody' ],
    [ NODE_TYPE_WHITESPACE, 'whitespace' ],
    [ NODE_TYPE_COMMENT, 'comment' ],
    [ NODE_TYPE_IGNORE, 'ignore' ],
    [ NODE_TYPE_EXT_RAW, 'extRaw' ],
    [ NODE_TYPE_EXT_OPTIONS_ANCHOR, 'extOptionsAnchor' ],
    [ NODE_TYPE_EXT_OPTIONS, 'extOptions' ],
    [ NODE_TYPE_EXT_DECORATION, 'extDecoration' ],
    [ NODE_TYPE_EXT_PATTERN_RAW, 'extPatternRaw' ],
    [ NODE_TYPE_EXT_PATTERN_COSMETIC, 'extPatternCosmetic' ],
    [ NODE_TYPE_EXT_PATTERN_HTML, 'extPatternHtml' ],
    [ NODE_TYPE_EXT_PATTERN_RESPONSEHEADER, 'extPatternResponseheader' ],
    [ NODE_TYPE_EXT_PATTERN_SCRIPTLET, 'extPatternScriptlet' ],
    [ NODE_TYPE_EXT_PATTERN_SCRIPTLET_TOKEN, 'extPatternScriptletToken' ],
    [ NODE_TYPE_EXT_PATTERN_SCRIPTLET_ARGS, 'extPatternScriptletArgs' ],
    [ NODE_TYPE_EXT_PATTERN_SCRIPTLET_ARG, 'extPatternScriptletArg' ],
    [ NODE_TYPE_NET_RAW, 'netRaw' ],
    [ NODE_TYPE_NET_EXCEPTION, 'netException' ],
    [ NODE_TYPE_NET_PATTERN_RAW, 'netPatternRaw' ],
    [ NODE_TYPE_NET_PATTERN, 'netPattern' ],
    [ NODE_TYPE_NET_PATTERN_PART, 'netPatternPart' ],
    [ NODE_TYPE_NET_PATTERN_PART_SPECIAL, 'netPatternPartSpecial' ],
    [ NODE_TYPE_NET_PATTERN_PART_UNICODE, 'netPatternPartUnicode' ],
    [ NODE_TYPE_NET_PATTERN_LEFT_HNANCHOR, 'netPatternLeftHnanchor' ],
    [ NODE_TYPE_NET_PATTERN_LEFT_ANCHOR, 'netPatternLeftAnchor' ],
    [ NODE_TYPE_NET_PATTERN_RIGHT_ANCHOR, 'netPatternRightAnchor' ],
    [ NODE_TYPE_NET_OPTIONS_ANCHOR, 'netOptionsAnchor' ],
    [ NODE_TYPE_NET_OPTIONS, 'netOptions' ],
    [ NODE_TYPE_NET_OPTION_RAW, 'netOptionRaw' ],
    [ NODE_TYPE_NET_OPTION_SEPARATOR, 'netOptionSeparator'],
    [ NODE_TYPE_NET_OPTION_SENTINEL, 'netOptionSentinel' ],
    [ NODE_TYPE_NET_OPTION_NAME_NOT, 'netOptionNameNot'],
    [ NODE_TYPE_NET_OPTION_ASSIGN, 'netOptionAssign' ],
    [ NODE_TYPE_NET_OPTION_VALUE, 'netOptionValue' ],
    [ NODE_TYPE_OPTION_VALUE_DOMAIN_LIST, 'netOptionValueDomainList' ],
    [ NODE_TYPE_OPTION_VALUE_DOMAIN_RAW, 'netOptionValueDomainRaw' ],
    [ NODE_TYPE_OPTION_VALUE_NOT, 'netOptionValueNot' ],
    [ NODE_TYPE_OPTION_VALUE_DOMAIN, 'netOptionValueDomain' ],
    [ NODE_TYPE_OPTION_VALUE_SEPARATOR, 'netOptionsValueSeparator' ],
]);
{
    for ( const [ name, type ] of nodeTypeFromOptionName ) {
        nodeNameFromNodeType.set(type, name);
    }
}

/******************************************************************************/

// Local constants

export const DOMAIN_CAN_USE_WILDCARD        = 0b0000001;
export const DOMAIN_CAN_USE_ENTITY          = 0b0000010;
export const DOMAIN_CAN_USE_SINGLE_WILDCARD = 0b0000100;
export const DOMAIN_CAN_BE_NEGATED          = 0b0001000;
export const DOMAIN_CAN_BE_REGEX            = 0b0010000;
export const DOMAIN_CAN_BE_ANCESTOR         = 0b0100000;
export const DOMAIN_CAN_HAVE_PATH           = 0b1000000;

export const DOMAIN_FROM_FROMTO_LIST = DOMAIN_CAN_USE_ENTITY |
    DOMAIN_CAN_BE_NEGATED |
    DOMAIN_CAN_BE_REGEX;
export const DOMAIN_FROM_DENYALLOW_LIST = 0;
export const DOMAIN_FROM_EXT_LIST = DOMAIN_CAN_USE_ENTITY |
    DOMAIN_CAN_USE_SINGLE_WILDCARD |
    DOMAIN_CAN_BE_NEGATED |
    DOMAIN_CAN_BE_REGEX |
    DOMAIN_CAN_BE_ANCESTOR |
    DOMAIN_CAN_HAVE_PATH;

/******************************************************************************/

// Precomputed AST layouts for most common filters.
//
// (10.7.6) Every layout is the same three wrapper levels (line body > network raw > pattern raw) around the
// pattern's own nodes, plus optional siblings of the pattern (the options part) — built by netTemplate()
// instead of six hand-copied trees. tools/test-network-translation.mjs is unaffected; the equivalence of the
// generated objects with the old literals (JSON, key order included) was checked when this was introduced.
function netTemplate(patternChildren, { flags, siblings = [] } = {}) {
    return {
        ...(flags !== undefined ? { flags } : {}),
        type: NODE_TYPE_LINE_BODY,
        beg: 0,
        end: 0,
        children: [{
            type: NODE_TYPE_NET_RAW,
            beg: 0,
            end: 0,
            children: [{
                type: NODE_TYPE_NET_PATTERN_RAW,
                beg: 0,
                end: 0,
                register: true,
                children: patternChildren,
            }, ...siblings],
        }],
    };
}

// "||" at the start of a pattern.
const LEFT_HNANCHOR_NODE = { type: NODE_TYPE_NET_PATTERN_LEFT_HNANCHOR, beg: 0, end: 2 };

export const astTemplates = {
    // ||example.com^
    netHnAnchoredHostnameAscii: netTemplate([
        { ...LEFT_HNANCHOR_NODE },
        { type: NODE_TYPE_NET_PATTERN, beg: 2, end: -1, register: true },
        { type: NODE_TYPE_NET_PATTERN_PART_SPECIAL, beg: -1, end: 0 },
    ], { flags: AST_FLAG_NET_PATTERN_LEFT_HNANCHOR | AST_FLAG_NET_PATTERN_RIGHT_PATHANCHOR }),
    // ||example.com^$third-party
    net3pHnAnchoredHostnameAscii: netTemplate([
        { ...LEFT_HNANCHOR_NODE },
        { type: NODE_TYPE_NET_PATTERN, beg: 2, end: -13, register: true },
        { type: NODE_TYPE_NET_PATTERN_PART_SPECIAL, beg: -13, end: -12 },
    ], {
        flags: AST_FLAG_NET_PATTERN_LEFT_HNANCHOR | AST_FLAG_NET_PATTERN_RIGHT_PATHANCHOR | AST_FLAG_HAS_OPTIONS,
        siblings: [{
            type: NODE_TYPE_NET_OPTIONS_ANCHOR,
            beg: -12,
            end: -11,
        }, {
            type: NODE_TYPE_NET_OPTIONS,
            beg: -11,
            end: 0,
            register: true,
            children: [{
                type: NODE_TYPE_NET_OPTION_RAW,
                beg: 0,
                end: 0,
                children: [{
                    type: NODE_TYPE_NET_OPTION_NAME_3P,
                    beg: 0,
                    end: 0,
                    register: true,
                }],
            }],
        }],
    }),
    // ||example.com/path/to/resource
    netHnAnchoredPlainAscii: netTemplate([
        { ...LEFT_HNANCHOR_NODE },
        { type: NODE_TYPE_NET_PATTERN, beg: 2, end: 0, register: true },
    ], { flags: AST_FLAG_NET_PATTERN_LEFT_HNANCHOR }),
    // example.com
    // -resource.
    netPlainAscii: netTemplate([
        { type: NODE_TYPE_NET_PATTERN, beg: 0, end: 0, register: true },
    ]),
    // 127.0.0.1 example.com
    netHosts1: netTemplate([
        { type: NODE_TYPE_IGNORE, beg: 0, end: 10 },
        { type: NODE_TYPE_NET_PATTERN, beg: 10, end: 0, register: true },
    ]),
    // 0.0.0.0 example.com
    netHosts2: netTemplate([
        { type: NODE_TYPE_IGNORE, beg: 0, end: 8 },
        { type: NODE_TYPE_NET_PATTERN, beg: 8, end: 0, register: true },
    ]),
    // ##.ads-container
    extPlainGenericSelector: {
        type: NODE_TYPE_LINE_BODY,
        beg: 0,
        end: 0,
        children: [{
            type: NODE_TYPE_EXT_RAW,
            beg: 0,
            end: 0,
            children: [{
                type: NODE_TYPE_EXT_OPTIONS_ANCHOR,
                beg: 0,
                end: 2,
                register: true,
            }, {
                type: NODE_TYPE_EXT_PATTERN_RAW,
                beg: 2,
                end: 0,
                register: true,
                children: [{
                    type: NODE_TYPE_EXT_PATTERN_COSMETIC,
                    beg: 0,
                    end: 0,
                    register: true,
                }],
            }],
        }],
    },
};

/******************************************************************************/

export const removableHTTPHeaders = new Set([
    'location',
    'refresh',
    'report-to',
    'set-cookie',
]);
