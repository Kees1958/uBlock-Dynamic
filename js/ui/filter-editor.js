/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2026-present Raymond Hill

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

import * as sfp from '../core/static-filtering-parser.js';
import { dom, qs$ } from './dom.js';
import { SITE_MODE_OPTIONS } from '../util/site-mode-parser.js';
import { REJECTED_LINE_PREFIX } from '../data/editor-annotations.js';
import { normalizeEditorText, replaceEditorDoc, buildIOPanel } from './editor-helpers.js';   // (audit 10.6.4) shared with dashboard/develop.js

/******************************************************************************/

const streamParser = (( ) => {
    function nodeHasError(mode, node) {
        return mode.astParser.getNodeFlags(
            node || mode.currentWalkerNode, sfp.NODE_FLAG_ERROR
        ) !== 0;
    }

    // "@@domain$worryfree" (10.0.0): a per-site exemption this editor accepts (processed by
    // js/core/exempt-domains.js, never compiled as a network rule), so the parser's "unknown option" error must
    // not paint it red. The option names come from SITE_MODE_OPTIONS (one source of truth). (10.3.0) A retired
    // "$saferegions" line is no longer listed there, so it shows as an unknown option — it is ignored.
    const EXEMPTION_OPTION_NAMES = new Set(Object.values(SITE_MODE_OPTIONS));
    function isExemptionOptionName(mode) {
        if ( mode.astParser.getNodeType(mode.currentWalkerNode) !== sfp.NODE_TYPE_NET_OPTION_NAME_UNKNOWN ) { return false; }
        return EXEMPTION_OPTION_NAMES.has(mode.astParser.getNodeString(mode.currentWalkerNode).toLowerCase());
    }

    function colorFromAstNode(mode) {
        if ( mode.astParser.nodeIsEmptyString(mode.currentWalkerNode) ) { return '+'; }
        if ( isExemptionOptionName(mode) ) { mode.lastNetOptionType = 0; return 'sfp_keyword'; }
        if ( nodeHasError(mode) ) { return 'sfp_error'; }
        const nodeType = mode.astParser.getNodeType(mode.currentWalkerNode);
        switch ( nodeType ) {
        case sfp.NODE_TYPE_WHITESPACE:
            return '';
        case sfp.NODE_TYPE_COMMENT:
            if ( mode.astWalker.canGoDown() ) { break; }
            return 'sfp_comment';
        case sfp.NODE_TYPE_COMMENT_URL:
            return 'sfp_comment sfp_link';
        case sfp.NODE_TYPE_IGNORE:
            return 'sfp_comment';
        case sfp.NODE_TYPE_PREPARSE_DIRECTIVE:
        case sfp.NODE_TYPE_PREPARSE_DIRECTIVE_VALUE:
            return 'sfp_directive';
        case sfp.NODE_TYPE_PREPARSE_DIRECTIVE_IF_VALUE: {
            return 'sfp_def sfp_strong';
        }
        case sfp.NODE_TYPE_EXT_OPTIONS_ANCHOR:
            return mode.astParser.getFlags(sfp.AST_FLAG_IS_EXCEPTION)
                ? 'sfp_tag sfp_strong'
                : 'sfp_def sfp_strong';
        case sfp.NODE_TYPE_EXT_DECORATION:
            return 'sfp_def';
        case sfp.NODE_TYPE_EXT_PATTERN_RAW:
            if ( mode.astWalker.canGoDown() ) { break; }
            return 'sfp_variable';
        case sfp.NODE_TYPE_EXT_PATTERN_COSMETIC:
        case sfp.NODE_TYPE_EXT_PATTERN_HTML:
            return 'sfp_variable';
        case sfp.NODE_TYPE_EXT_PATTERN_RESPONSEHEADER:
        case sfp.NODE_TYPE_EXT_PATTERN_SCRIPTLET:
            if ( mode.astWalker.canGoDown() ) { break; }
            return 'sfp_variable';
        case sfp.NODE_TYPE_EXT_PATTERN_SCRIPTLET_TOKEN: {
            return 'sfp_variable';
        }
        case sfp.NODE_TYPE_EXT_PATTERN_SCRIPTLET_ARG:
            return 'sfp_variable';
        case sfp.NODE_TYPE_NET_EXCEPTION:
            return 'sfp_tag sfp_strong';
        case sfp.NODE_TYPE_NET_PATTERN:
            if ( mode.astWalker.canGoDown() ) { break; }
            if ( mode.astParser.isRegexPattern() ) {
                return 'sfp_variable sfp_notice';
            }
            return 'sfp_variable';
        case sfp.NODE_TYPE_NET_PATTERN_PART:
            return 'sfp_variable';
        case sfp.NODE_TYPE_NET_PATTERN_PART_SPECIAL:
            return 'sfp_keyword sfp_strong';
        case sfp.NODE_TYPE_NET_PATTERN_PART_UNICODE:
            return 'sfp_variable sfp_unicode';
        case sfp.NODE_TYPE_NET_PATTERN_LEFT_HNANCHOR:
        case sfp.NODE_TYPE_NET_PATTERN_LEFT_ANCHOR:
        case sfp.NODE_TYPE_NET_PATTERN_RIGHT_ANCHOR:
        case sfp.NODE_TYPE_NET_OPTION_NAME_NOT:
            return 'sfp_keyword sfp_strong';
        case sfp.NODE_TYPE_NET_OPTIONS_ANCHOR:
        case sfp.NODE_TYPE_NET_OPTION_SEPARATOR:
            mode.lastNetOptionType = 0;
            return 'sfp_def sfp_strong';
        case sfp.NODE_TYPE_NET_OPTION_NAME_UNKNOWN:
            mode.lastNetOptionType = 0;
            return 'sfp_error';
        case sfp.NODE_TYPE_NET_OPTION_NAME_1P:
        case sfp.NODE_TYPE_NET_OPTION_NAME_STRICT1P:
        case sfp.NODE_TYPE_NET_OPTION_NAME_3P:
        case sfp.NODE_TYPE_NET_OPTION_NAME_STRICT3P:
        case sfp.NODE_TYPE_NET_OPTION_NAME_ALL:
        case sfp.NODE_TYPE_NET_OPTION_NAME_BADFILTER:
        case sfp.NODE_TYPE_NET_OPTION_NAME_CNAME:
        case sfp.NODE_TYPE_NET_OPTION_NAME_CSP:
        case sfp.NODE_TYPE_NET_OPTION_NAME_CSS:
        case sfp.NODE_TYPE_NET_OPTION_NAME_DENYALLOW:
        case sfp.NODE_TYPE_NET_OPTION_NAME_DOC:
        case sfp.NODE_TYPE_NET_OPTION_NAME_EHIDE:
        case sfp.NODE_TYPE_NET_OPTION_NAME_EMPTY:
        case sfp.NODE_TYPE_NET_OPTION_NAME_FONT:
        case sfp.NODE_TYPE_NET_OPTION_NAME_FRAME:
        case sfp.NODE_TYPE_NET_OPTION_NAME_FROM:
        case sfp.NODE_TYPE_NET_OPTION_NAME_GENERICBLOCK:
        case sfp.NODE_TYPE_NET_OPTION_NAME_GHIDE:
        case sfp.NODE_TYPE_NET_OPTION_NAME_IMAGE:
        case sfp.NODE_TYPE_NET_OPTION_NAME_IMPORTANT:
        case sfp.NODE_TYPE_NET_OPTION_NAME_INLINEFONT:
        case sfp.NODE_TYPE_NET_OPTION_NAME_INLINESCRIPT:
        case sfp.NODE_TYPE_NET_OPTION_NAME_MATCHCASE:
        case sfp.NODE_TYPE_NET_OPTION_NAME_MEDIA:
        case sfp.NODE_TYPE_NET_OPTION_NAME_METHOD:
        case sfp.NODE_TYPE_NET_OPTION_NAME_MP4:
        case sfp.NODE_TYPE_NET_OPTION_NAME_NOOP:
        case sfp.NODE_TYPE_NET_OPTION_NAME_OBJECT:
        case sfp.NODE_TYPE_NET_OPTION_NAME_OTHER:
        case sfp.NODE_TYPE_NET_OPTION_NAME_PING:
        case sfp.NODE_TYPE_NET_OPTION_NAME_POPUNDER:
        case sfp.NODE_TYPE_NET_OPTION_NAME_POPUP:
        case sfp.NODE_TYPE_NET_OPTION_NAME_REDIRECT:
        case sfp.NODE_TYPE_NET_OPTION_NAME_REDIRECTRULE:
        case sfp.NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM:
        case sfp.NODE_TYPE_NET_OPTION_NAME_RESPONSEHEADER:
        case sfp.NODE_TYPE_NET_OPTION_NAME_REQUESTHEADER:
        case sfp.NODE_TYPE_NET_OPTION_NAME_SCRIPT:
        case sfp.NODE_TYPE_NET_OPTION_NAME_SHIDE:
        case sfp.NODE_TYPE_NET_OPTION_NAME_TO:
        case sfp.NODE_TYPE_NET_OPTION_NAME_TOP:
        case sfp.NODE_TYPE_NET_OPTION_NAME_URLTRANSFORM:
        case sfp.NODE_TYPE_NET_OPTION_NAME_XHR:
        case sfp.NODE_TYPE_NET_OPTION_NAME_WEBRTC:
        case sfp.NODE_TYPE_NET_OPTION_NAME_WEBSOCKET:
            mode.lastNetOptionType = nodeType;
            return 'sfp_def';
        case sfp.NODE_TYPE_NET_OPTION_ASSIGN:
        case sfp.NODE_TYPE_NET_OPTION_QUOTE:
            return 'sfp_def';
        case sfp.NODE_TYPE_NET_OPTION_VALUE:
            if ( mode.astWalker.canGoDown() ) { break; }
            switch ( mode.lastNetOptionType ) {
            case sfp.NODE_TYPE_NET_OPTION_NAME_REDIRECT:
            case sfp.NODE_TYPE_NET_OPTION_NAME_REDIRECTRULE:
                return 'sfp_value';
            default:
                break;
            }
            return 'sfp_value';
        case sfp.NODE_TYPE_OPTION_VALUE_NOT:
            return 'sfp_keyword sfp_strong';
        case sfp.NODE_TYPE_OPTION_VALUE_DOMAIN:
            return 'sfp_value';
        case sfp.NODE_TYPE_OPTION_VALUE_SEPARATOR:
            return 'sfp_def';
        default:
            break;
        }
        return '+';
    }

    class ModeState {
        constructor() {
            this.astParser = new sfp.AstFilterParser({
                interactive: true,
                localSource: true,
                nativeCssHas: true,
                trustedSource: true,
            });
            this.astWalker = this.astParser.getWalker();
            this.currentWalkerNode = 0;
            this.lastNetOptionType = 0;
        }
    }

    return {
        languageData: {
            commentTokens: { line: '!' },
        },
        tokenTable: [
            'sfp_comment',
            'sfp_def',
            'sfp_directive',
            'sfp_error',
            'sfp_ext-dom',
            'sfp_ext-html',
            'sfp_ext-js',
            'sfp_keyword',
            'sfp_link',
            'sfp_net',
            'sfp_notice',
            'sfp_rejected',
            'sfp_strong',
            'sfp_tag',
            'sfp_unicode',
            'sfp_value',
            'sfp_variable',
        ],
        startState() {
            return new ModeState();
        },
        copyState(other) {
            return other;
        },
        token(stream, state) {
            if ( stream.sol() ) {
                // (10.7.2) The "! Rejected: <reason>" line written beneath a refused line (data/editor-annotations.js)
                // is shown in the error colour, so the info box's "with the reason in red beneath them" holds.
                if ( stream.string.trimStart().startsWith(REJECTED_LINE_PREFIX.trim()) ) {
                    stream.skipToEnd();
                    return 'sfp_rejected';
                }
                state.astParser.parse(stream.string);
                if ( state.astParser.getFlags(sfp.AST_FLAG_UNSUPPORTED) !== 0 ) {
                    stream.skipToEnd();
                    return 'sfp_error';
                }
                if ( state.astParser.getType() === sfp.AST_TYPE_NONE ) {
                    stream.skipToEnd();
                    return 'sfp_comment';
                }
                state.currentWalkerNode = state.astWalker.reset();
            } else if ( nodeHasError(state) ) {
                state.currentWalkerNode = state.astWalker.right();
            } else {
                state.currentWalkerNode = state.astWalker.next();
            }
            let style = '';
            while ( state.currentWalkerNode !== 0 ) {
                style = colorFromAstNode(state, stream);
                if ( style !== '+' ) { break; }
                state.currentWalkerNode = state.astWalker.next();
            }
            if ( style === '+' ) {
                stream.skipToEnd();
                return null;
            }
            stream.pos = state.astParser.getNodeStringEnd(state.currentWalkerNode);
            if ( state.astParser.isNetworkFilter() ) {
                return style ? `sfp_net ${style}` : 'sfp_net';
            }
            if ( state.astParser.isExtendedFilter() ) {
                let flavor = '';
                if ( state.astParser.isCosmeticFilter() ) {
                    flavor = 'sfp_ext-dom';
                } else if ( state.astParser.isScriptletFilter() ) {
                    flavor = 'sfp_ext-js';
                } else if ( state.astParser.isHtmlFilter() ) {
                    flavor = 'sfp_ext-html';
                }
                if ( flavor !== '' ) {
                    style = `${flavor} ${style}`;
                }
            }
            style = style.trim();
            return style !== '' ? style : null;
        },
    };
})();

/******************************************************************************/

export class FilterEditor {
    constructor(parent, text = '') {
        this.ioPanel = self.cm6.createViewPanel();
        const viewConfig = {
            text,
            oneDark: dom.cl.has(':root', 'dark'),
            lineWrapping: true,
            updateListener: info => { this.updateListener(info); },
            saveListener: ( ) => { this.saveContent(); },
            lineError: true,
            spanError: true,
            streamParser,
            panels: [ this.ioPanel ],
        };
        this.view = self.cm6.createEditorView(viewConfig, parent);
        this.lastSavedText = text;
        self.cm6.resetUndoRedo(this.view);
        this.updateIOPanel();
    }

    getContent() {
        return this.normalizeContent(this.view.state.doc.toString());
    }

    setContent(text, saved = false) {
        text = this.normalizeContent(text);
        if ( saved ) {
            this.lastSavedText = text;
        }
        replaceEditorDoc(this.view, text);
    }

    normalizeContent(text) {
        return normalizeEditorText(text);
    }

    contentChanged() {
        const text = this.normalizeContent(this.getContent());
        return text !== this.lastSavedText;
    }

    async loadContent(text) {
        this.setContent(text, true);
        self.cm6.resetUndoRedo(this.view);
        this.updateView();
    }

    async saveContent() {
        this.lastSavedText = this.getContent();
        this.updateView();
    }

    revertContent() {
        if ( this.contentChanged() === false ) { return; }
        this.setContent(this.lastSavedText);
    }

    updateListener(info) {
        if ( info.docChanged === false ) { return; }
        this.updateView();
    }


    updateView() {
        const changed = this.contentChanged();
        if ( this.ioPanelRoot ) {
            dom.attr(qs$(this.ioPanelRoot, '#apply'), 'disabled', changed ? null : '');
            dom.attr(qs$(this.ioPanelRoot, '#revert'), 'disabled', changed ? null : '');
        }
    }

    updateIOPanel() {
        const { root, config } = buildIOPanel(
            [ 'apply', 'revert' ],
            ( ) => { this.saveContent(); },
            ( ) => { this.revertContent(); },
        );
        this.ioPanelRoot = root;
        this.ioPanel.render(this.view, config);
    }
}
