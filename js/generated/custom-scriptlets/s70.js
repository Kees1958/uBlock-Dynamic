/*! AdGuard Scriptlets 2.6.0 (https://github.com/AdguardTeam/Scriptlets) by the AdGuard team (AdguardTeam), GPL-3.0. Bundled unchanged by uBlock-Stripped-Dynamic; see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function removeNodeText(source, args) {
            // Fixed values — the only place they live.
            const REPLACE_NAME_RE = /replace-node-text|rpnt/;   // source.name of a replace rule (not remove)
            const replaceMode = REPLACE_NAME_RE.test(String(source && source.name));
            const list = Array.isArray(args) ? args : [];
            const [ nodeNameArg = '', textArg = '' ] = list;
            const parentSelector = replaceMode ? '' : (list[2] || '');
            const patternArg = replaceMode ? (list[2] || '') : '';
            const replacementArg = replaceMode ? (list[3] || '') : '';
            const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/;
            const STATEFUL_FLAGS = /[gy]/g;          // would make test() depend on the previous call
            const TEXT_NODE_NAME = '#text';
            const ANY_ELEMENT = '*';
            const EMPTY_TEXT = '';
            const OBSERVE_OPTIONS = { childList: true, subtree: true, characterData: true };
            const TT_POLICY_NAME = 'uBD-remove-node-text';   // Trusted Types policy used only to write a script's new text
            const DONE_MARK = 'done';
            const logPrefix = '[uBlock-Dynamic] remove-node-text:';
            if ( typeof nodeNameArg !== 'string' || typeof textArg !== 'string' || nodeNameArg === '' || textArg === '' ) { return; }
            if ( replaceMode && patternArg === '' ) { return; }
            // Guard (initialise once): the same rule injected twice into one page installs one observer.
            const onceKey = source && source.uniqueId ? `${source.uniqueId}${source.name}_${args.join('_')}` : null;
            if ( onceKey !== null && Window.prototype.toString[onceKey] === DONE_MARK ) { return; }
            const toMatcher = arg => {
                const literal = REGEX_LITERAL.exec(arg);
                if ( literal === null ) { return null; }
                return new RegExp(literal[1], literal[2].replace(STATEFUL_FLAGS, ''));
            };
            let nameRe, textRe, patternRe = null;
            try {
                nameRe = toMatcher(nodeNameArg);
                textRe = toMatcher(textArg);
                if ( replaceMode ) {   // the replace pattern keeps its g flag (replace all), as AdGuard's toRegExp does
                    const literal = REGEX_LITERAL.exec(patternArg);
                    patternRe = literal === null ? null : new RegExp(literal[1], literal[2]);
                }
            } catch { return; }   // invalid regex: nothing is installed
            const wantedName = nodeNameArg.toLowerCase();
            const textMode = nameRe === null && wantedName === TEXT_NODE_NAME;
            const selector = nameRe === null ? wantedName : ANY_ELEMENT;
            const nameMatches = node => {
                const name = node.nodeName.toLowerCase();
                return nameRe !== null ? nameRe.test(name) : name === wantedName;
            };
            const textMatches = text => textRe !== null ? textRe.test(text) : text.includes(textArg);
            const parentMatches = node => {
                if ( parentSelector === '' ) { return true; }
                const parent = node.parentElement;
                if ( parent === null ) { return false; }
                try { return textMode ? parent.matches(parentSelector) : parent.closest(parentSelector) !== null; } catch { return false; }
            };
            let ttPolicy = null;   // null = not created yet, false = not available on this page
            // The text a node gets: '' (remove), or its text with the pattern replaced (replace).
            const newTextFor = text => {
                if ( replaceMode === false ) { return EMPTY_TEXT; }
                return patternRe !== null ? text.replace(patternRe, replacementArg) : text.replace(patternArg, replacementArg);
            };
            const written = new WeakMap();   // node -> text this scriptlet wrote, so its own write is not handled again
            const scriptTextValue = text => {
                if ( ttPolicy === null ) {
                    ttPolicy = false;
                    try {
                        if ( self.trustedTypes && typeof self.trustedTypes.createPolicy === 'function' ) {
                            ttPolicy = self.trustedTypes.createPolicy(TT_POLICY_NAME, { createScript: text => text });
                        }
                    } catch { /* the page's CSP forbids new policies: a plain string is tried below */ }
                }
                return ttPolicy ? ttPolicy.createScript(text) : text;
            };
            const clearIfMatching = node => {
                if ( nameMatches(node) === false || parentMatches(node) === false ) { return; }
                const text = node.textContent;
                if ( typeof text !== 'string' || text === EMPTY_TEXT || written.get(node) === text || textMatches(text) === false ) { return; }
                const next = newTextFor(text);
                if ( next === text ) { return; }
                try {
                    node.textContent = node.nodeName === 'SCRIPT' ? scriptTextValue(next) : next;
                    written.set(node, next);
                    if ( source.verbose ) { console.log(logPrefix, nodeNameArg, textArg); }
                } catch { /* Trusted Types refused the write: nothing else can be done for this node */ }
            };
            // One node from a mutation. Script mode: a text node is judged by its parent element — that is how the
            // text of a parser-inserted script arrives, after its (still empty) element.
            const consider = node => {
                if ( node.nodeType === Node.TEXT_NODE ) {
                    if ( textMode ) { clearIfMatching(node); return; }
                    if ( node.parentElement !== null ) { clearIfMatching(node.parentElement); }
                    return;
                }
                if ( node.nodeType !== Node.ELEMENT_NODE ) { return; }
                if ( textMode ) {   // '#text': the text inside an added block (e.g. HTML added in one go)
                    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                    for ( let n = walker.nextNode(); n !== null; n = walker.nextNode() ) { clearIfMatching(n); }
                    return;
                }
                clearIfMatching(node);
                if ( node.firstElementChild !== null ) {
                    for ( const inner of node.querySelectorAll(selector) ) { clearIfMatching(inner); }
                }
            };
            const scanExisting = ( ) => {
                const root = document.documentElement;
                if ( root === null ) { return; }
                if ( textMode ) {
                    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                    for ( let n = walker.nextNode(); n !== null; n = walker.nextNode() ) { clearIfMatching(n); }
                    return;
                }
                for ( const node of root.querySelectorAll(selector) ) { clearIfMatching(node); }
            };
            const onMutations = records => {
                for ( const record of records ) {
                    if ( record.type === 'characterData' ) { consider(record.target); continue; }
                    for ( const node of record.addedNodes ) { consider(node); }
                }
            };
            const observer = new MutationObserver(onMutations);
            const start = ( ) => { observer.observe(document, OBSERVE_OPTIONS); };
            scanExisting();
            start();
            // Release: no observer while the page is being left or sits in the back/forward cache.
            self.addEventListener('pagehide', ( ) => { observer.disconnect(); });
            self.addEventListener('pageshow', event => {
                if ( event.persisted !== true ) { return; }
                scanExisting();
                start();
            });
            if ( onceKey !== null ) {
                Object.defineProperty(Window.prototype.toString, onceKey, { value: DONE_MARK, enumerable: false, writable: false, configurable: false });
            }
        })(source, args);
})();
