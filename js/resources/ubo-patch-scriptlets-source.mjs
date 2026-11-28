/*
 * ubo-patch-scriptlets-source.mjs — HAND-MAINTAINED (not generated).
 *
 * Scriptlets that are missing from the vendored @adguard/scriptlets
 * library entirely (in no name form), adapted — not copy-pasted — from
 * uBlock Origin's own real source (github.com/gorhill/uBlock,
 * src/js/resources/, GPL-3.0-or-later; see THIRD_PARTY_LICENSES.md for
 * the full attribution). Added per Xplainer_Programming_principles_audit
 * C40's size ceiling and trust check: each entry here is a small,
 * standalone function (no shared multi-hundred-line engine), confirmed
 * via uBO's own `requiresTrust` registration field (not the `trusted-`
 * name prefix, which is an incomplete signal — see C40's own correction)
 * to NOT require trust.
 *
 * Calling convention matches every other entry in
 * js/generated/custom-scriptlets-dispatch.mjs: `fn(source, args)`, where
 * `args` is the plain array of the filter rule's own scriptlet
 * parameters. Real uBO scriptlets take those as separate positional
 * parameters, so each function below starts with a one-line adapter
 * unpacking `args` before running the ported logic — this is the same
 * shape AdGuard's own build already applies to every uBO-original
 * scriptlet it carries, not a new convention.
 *
 * Each dependency a scriptlet needs (safeSelf's logging helpers,
 * proxyApplyFn, onIdleFn/runAt, the urlSkip transform engine) is
 * inlined as a local nested function, because
 * chrome.scripting.executeScript's `func` only serializes the ONE
 * referenced top-level function's own source text — see
 * tools/build-rulesets.mjs's buildCustomScriptletsDispatch() header for
 * why every entry in this project's dispatch must be fully
 * self-contained.
 *
 * (11.1.6) One exception to "AdGuard wins": an entry marked `replacesAdGuard: true` is a deliberate replacement of
 * the AdGuard scriptlet with the same name (its reason is written at the entry). It is applied once, where the AdGuard
 * package is read (tools/build/scriptlet-corelibs.mjs applyProjectReplacements()), so every consumer gets it.
 *
 * buildUboPatchScriptletsDispatch() (tools/build-rulesets.mjs) merges
 * these into the same generated dispatch file as @adguard/scriptlets,
 * with @adguard/scriptlets always taking priority for any name it also
 * defines — see that function's own header for the redundancy check
 * that flags (never silently drops) a patch entry once that happens.
 *
 * Deliberately NOT here (see C40 / the ARCHITECTURE.md HARD CONSTRAINT
 * this list should also be added to):
 *   - `prevent-clipboard-write` — `requiresTrust: true` in real uBO,
 *     despite its plain-looking name.
 *   - All 11 AdGuard `trusted-*` names — restricted by AdGuard's own
 *     policy to their own vetted filters; confirmed (build log, every
 *     generated shipped-list scriptlet file) that no shipped list here
 *     currently needs any of them.
 *   - `mpegdash-prune` and the `edit-*-object`/`json-edit-*`/
 *     `jsonl-edit-*` family (11 names) — each depends on a
 *     multi-hundred-line shared engine (prevent-xhr.js's
 *     modifyXhrResponseFn, json-edit.js), over this project's
 *     hand-port size ceiling.
 */

import { SCRIPTLET_POLICY } from '../data/scriptlet-policy.js';

// ── UBO_PATCH_SCRIPTLETS ────────────────────────────────────────────────────
// One entry per distinct function. `names` lists every alias this
// scriptlet should be reachable by (bare form only — the generic
// `.js`-alias-stripping fix in buildCustomScriptletsDispatch() handles
// the `.js`-suffixed forms the same way it does for @adguard/scriptlets'
// own names, so only the bare names need listing here).
export const UBO_PATCH_SCRIPTLETS = [
    {
        names: [ 'remove-node-text', 'ubo-remove-node-text', 'rmnt', 'ubo-rmnt', 'trusted-replace-node-text' ],
        // (11.1.6, owner's decision 2026-11-28) REPLACES AdGuard's remove-node-text (`replacesAdGuard` — applied where
        // the AdGuard package is read, tools/build/scriptlet-corelibs.mjs applyProjectReplacements()), for every list
        // rule and custom rule of that name, including the uBO `rmnt` rules the build translates into it.
        // Why: AdGuard's version (1) checks a node only at the moment it is ADDED and skips it while its text is still
        // empty — the HTML parser adds an inline <script> first and fills its text afterwards, so a script delivered
        // in more than one network packet was never checked (reproduced in real Chrome: Fox News's 7 KB Admiral
        // starter ran with its full text); and (2) disconnects its observer 10 s after the page starts, so anything
        // inserted later is never touched. uBlock Origin's rmnt has neither limit — this follows its approach.
        // Arguments: AdGuard's, unchanged — 1 = node name ('script', '#text', … or /regex/), 2 = text to look for
        // (plain text or /regex/flags), 3 = optional parent selector. A matching node's whole text becomes ''.
        // (11.1.6, scriptlet audit finding 2) Also REPLACES AdGuard's trusted-replace-node-text (built the same way, same
        // two limits): when the rule's name (source.name) is a replace name, the arguments are AdGuard's for that one —
        // 1 = node name, 2 = text to look for, 3 = PATTERN (/regex/flags, or plain text = first occurrence), 4 = the
        // REPLACEMENT — and only the pattern is replaced, not the whole text. It stays a trusted scriptlet: the trust
        // policy (js/data/scriptlet-policy.js) decides by the rule's name, which this does not change.
        // Lifetime (B10): one observer per rule, started at once, disconnected on pagehide, restarted (with a scan of
        // the page) on pageshow from the back/forward cache. Invalid arguments: nothing is installed.
        replacesAdGuard: true,
        scriptlet: function removeNodeText(source, args) {
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
        },
    },
    {
        names: [ 'stub-window-object' ],
        // Own implementation (10.1.8). Replaces a page's global object with a harmless stub, a short while after the
        // page has loaded: `window[name] = { method: noop, ... }`. Written for AdGuard's CNN rule
        //   cnn.com#%#(()=>{ ... setTimeout(() => { window.AdFuel = { queueRegistry(){}, destroySlots(){} } }, 500) ... })()
        // (raw JavaScript, cannot be compiled here). Usage, in the Quick-fixes list:
        //   cnn.com#%#//scriptlet('stub-window-object', 'AdFuel', 'queueRegistry,destroySlots', '500')
        // Args: 1 = global property name, 2 = comma-separated method names (each becomes a no-op), 3 = delay in ms after
        // DOMContentLoaded (optional, default 0, capped). The page's own script is NOT blocked: it loads first and is
        // overwritten afterwards, which is what the original rule does. Invalid arguments make it do nothing.
        scriptlet: function stubWindowObject(source, args) {
            const [ propertyName = '', methodList = '', delayText = '0' ] = args || [];
            // Limits: a global name and method names must be plain identifiers; the delay is capped.
            const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
            const MAX_DELAY_MS = 10000;
            const methods = methodList.split(',').map(m => m.trim()).filter(m => m !== '');
            if ( IDENTIFIER.test(propertyName) === false || methods.some(m => IDENTIFIER.test(m) === false) ) { return; }
            const delay = Math.min(Math.max(parseInt(delayText, 10) || 0, 0), MAX_DELAY_MS);
            const install = ( ) => {
                const stub = {};
                for ( const method of methods ) { stub[method] = function() {}; }
                window[propertyName] = stub;
            };
            const schedule = ( ) => { setTimeout(install, delay); };
            if ( document.readyState === 'loading' ) {
                document.addEventListener('DOMContentLoaded', schedule, { once: true });
            } else {
                schedule();
            }
        },
    },
    {
        names: [ 'disable-fave-ssai' ],
        // Own implementation (10.1.8), written for CNN's "FAVE" video player: switches off its server-side
        // ad insertion (SSAI) flags so clips and live streams are served without stitched-in ads. AdGuard
        // ships the same effect as a raw-JS rule (`cnn.com#%#(()=>{window.FAVE=...})()`) plus a `$replace`
        // network rule; neither can be compiled here (raw JS is not a named scriptlet, MV3 has no response
        // rewriting), so this named scriptlet is the supported form. Usage, in the Quick-fixes list:
        //   cnn.com#%#//scriptlet('disable-fave-ssai')
        // Behaviour: wraps window.FAVE in a Proxy; on every property write it sets `enabled=false` on
        // ads.ssai.prod.{clips,liveAuth,liveUnauth} of FAVE.settings, of the value being written when the
        // property is `settings`, and of every FAVE.player.instances[*].configs. Takes no arguments.
        scriptlet: function disableFaveSsai(source, args) {
            void args;
            // The SSAI switches this scriptlet turns off (inside ads.ssai.prod).
            const SSAI_SWITCHES = [ 'clips', 'liveAuth', 'liveUnauth' ];
            const switchOff = config => {
                const prod = config?.ads?.ssai?.prod;
                if ( prod === null || typeof prod !== 'object' ) { return; }
                for ( const key of SSAI_SWITCHES ) {
                    if ( prod[key]?.enabled ) { prod[key].enabled = false; }
                }
            };
            const switchOffAll = fave => {
                switchOff(fave?.settings);
                const instances = fave?.player?.instances;
                if ( instances === null || typeof instances !== 'object' ) { return; }
                for ( const id of Object.keys(instances) ) { switchOff(instances[id]?.configs); }
            };
            window.FAVE = window.FAVE || {};
            switchOffAll(window.FAVE);
            window.FAVE = new Proxy(window.FAVE, {
                set(target, prop, value, receiver) {
                    if ( prop === 'settings' ) { switchOff(value); }
                    switchOffAll(target);
                    return Reflect.set(target, prop, value, receiver);
                },
            });
        },
    },
    {
        names: [ SCRIPTLET_POLICY.BLANK_SETATTRIBUTE_VALUE_NAME ],
        // Own implementation (11.1.3), the safe replacement of one rule-A shape (js/data/scriptlet-policy.js,
        // SAFE_SCRIPTLET_REPLACEMENTS). uBlock Origin's Ad-Shield fixes use
        //   site##+js(trusted-replace-argument, Element.prototype.setAttribute, 1, , condition, /pattern/)
        // which needs trust only because trusted-replace-argument can write ANY value into ANY call. This scriptlet does
        // the one thing those rules use it for: when a setAttribute() VALUE matches the pattern, the value becomes ''.
        // It cannot insert anything else. Ad-Shield writes its recovery code into script attributes (onerror …); an
        // emptied attribute runs nothing. Usage (Quick-fixes list, or written by the build for the rule above):
        //   example.com##+js(blank-setattribute-value, /pattern/)
        // Args: 1 = pattern, a /regex/ (flags allowed, g and y ignored) or plain text to look for. An empty, too long or
        // invalid pattern makes it do nothing. setAttribute is wrapped in a Proxy whose toString() answers like the original.
        scriptlet: function blankSetAttributeValue(source, args) {
            const [ pattern = '' ] = args || [];
            // Limits and fixed values — the only place they live.
            const MAX_PATTERN_LENGTH = 1000;
            const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/;
            const STATEFUL_FLAGS = /[gy]/g;   // would make test() depend on the previous call
            const BLANK_VALUE = '';
            const VALUE_INDEX = 1;            // setAttribute(name, VALUE)
            const logPrefix = '[uBlock-Dynamic] blank-setattribute-value:';
            if ( typeof pattern !== 'string' || pattern === '' || pattern.length > MAX_PATTERN_LENGTH ) { return; }
            let matches;
            const literal = REGEX_LITERAL.exec(pattern);
            if ( literal !== null ) {
                let re;
                try { re = new RegExp(literal[1], literal[2].replace(STATEFUL_FLAGS, '')); } catch { return; }
                matches = text => re.test(text);
            } else {
                matches = text => text.includes(pattern);
            }
            const original = Element.prototype.setAttribute;
            if ( typeof original !== 'function' ) { return; }
            const wrapped = new Proxy(original, {
                apply(target, thisArg, callArgs) {
                    if ( callArgs.length > VALUE_INDEX ) {
                        let text = null;
                        try { text = String(callArgs[VALUE_INDEX]); } catch { /* e.g. a Symbol: leave the call alone */ }
                        if ( text !== null && matches(text) ) {
                            callArgs[VALUE_INDEX] = BLANK_VALUE;
                            if ( source.verbose ) { console.log(logPrefix, 'Value blanked'); }
                        }
                    }
                    return Reflect.apply(target, thisArg, callArgs);
                },
            });
            // Hide the wrapper the way uBO's proxyApplyFn does: toString() of the wrapper (and of the toString wrapper
            // itself) answers with the original's text, so a page cannot spot the change by reading the source text.
            const nativeToString = Function.prototype.toString;
            const toStringWrapper = new Proxy(nativeToString, {
                apply(target, thisArg, callArgs) {
                    const real = thisArg === wrapped ? original : thisArg === toStringWrapper ? nativeToString : thisArg;
                    return Reflect.apply(target, real, callArgs);
                },
            });
            Function.prototype.toString = toStringWrapper;
            Element.prototype.setAttribute = wrapped;
        },
    },
    {
        names: [ SCRIPTLET_POLICY.SET_STORAGE_ITEM_NOW_NAME ],
        // Own implementation (11.1.3), the safe replacement of
        //   site##+js(trusted-set-local-storage-item, key, $now$)   /   …trusted-set-session-storage-item, key, $now$)
        // (js/data/scriptlet-policy.js, SAFE_SCRIPTLET_REPLACEMENTS): "remember when the ad was last shown", so a site's
        // pop-under or interstitial waits. Writes ONLY the current time (Date.now(), as the trusted scriptlet's $now$
        // does) — never a value from the rule. Usage:  example.com##+js(set-storage-item-now, local, lastAdTime)
        // Args: 1 = 'local' or 'session', 2 = the key. Anything else, or a storage that refuses, does nothing.
        // The limits repeat SCRIPTLET_POLICY's (this function runs stand-alone in the page; the suite checks they agree).
        scriptlet: function setStorageItemNow(source, args) {
            const [ kind = '', key = '' ] = args || [];
            const STORAGE_BY_KIND = { local: 'localStorage', session: 'sessionStorage' };
            const MAX_KEY_LENGTH = 256;
            const storageName = STORAGE_BY_KIND[kind];
            if ( storageName === undefined || typeof key !== 'string' || key.trim() === '' || key.length > MAX_KEY_LENGTH ) { return; }
            try {
                self[storageName].setItem(key, String(Date.now()));
                if ( source.verbose ) { console.log('[uBlock-Dynamic] set-storage-item-now:', kind, key); }
            } catch { /* storage disabled or full: nothing to do */ }
        },
    },
    {
        names: [ SCRIPTLET_POLICY.SET_DATA_ATTR_NAME ],
        // Own implementation (11.1.3), the safe replacement of
        //   site##+js(trusted-set-attr, selector, data-x, word)
        // for the shape "a data-* attribute set to a short plain word" — anti-adblock probes such as data-allok=y. A
        // data-* attribute is never run as code and the value is letters, digits, "-" or "_" only (32 at most).
        // Usage:  example.com##+js(set-data-attr, body, data-allok, y)
        // Args: 1 = selector, 2 = data-* attribute name, 3 = value. Sets it on matching elements now and on matching
        // elements added later (one MutationObserver, batched per animation frame). Invalid arguments do nothing.
        // The limits repeat SCRIPTLET_POLICY's (this function runs stand-alone in the page; the suite checks they agree).
        scriptlet: function setDataAttr(source, args) {
            const [ selector = '', attr = '', value = '' ] = args || [];
            const NAME_RE = /^data-[a-z0-9-]{1,64}$/i;
            const VALUE_RE = /^[A-Za-z0-9_-]{1,32}$/;
            if ( typeof selector !== 'string' || selector.trim() === '' ) { return; }
            if ( NAME_RE.test(attr) === false || VALUE_RE.test(value) === false ) { return; }
            let pending;
            const apply = ( ) => {
                pending = undefined;
                let elems;
                try { elems = document.querySelectorAll(selector); } catch { return false; }   // invalid selector
                for ( const elem of elems ) {
                    if ( elem.getAttribute(attr) !== value ) { elem.setAttribute(attr, value); }
                }
                return true;
            };
            if ( apply() === false ) { return; }
            const observer = new MutationObserver(( ) => {
                if ( pending !== undefined ) { return; }
                pending = requestAnimationFrame(apply);
            });
            observer.observe(document, { childList: true, subtree: true });
        },
    },
    {
        names: [ 'prevent-dialog' ],
        // Adapted from uBO's prevent-dialog.js (registerScriptlet
        // preventDialog). Force-closes a page's own <dialog> element —
        // e.g. example.com##+js(prevent-dialog).
        scriptlet: function preventDialog(source, args) {
            const [ selector = '' ] = args || [];
            const logPrefix = `[uBlock-Dynamic] prevent-dialog(${selector}):`;
            const prevent = ( ) => {
                debouncer = undefined;
                const elems = document.querySelectorAll(`dialog${selector}`);
                for ( const elem of elems ) {
                    if ( typeof elem.close !== 'function' ) { continue; }
                    if ( elem.open === false ) { continue; }
                    elem.close();
                    if ( source.verbose ) { console.log(logPrefix, 'Closed'); }
                }
            };
            let debouncer;
            const observer = new MutationObserver(( ) => {
                if ( debouncer !== undefined ) { return; }
                debouncer = requestAnimationFrame(prevent);
            });
            observer.observe(document, { childList: true, subtree: true });
            prevent();
        },
    },
    {
        names: [ 'bab-defuser', 'nobab' ],
        // Adapted from uBO's prevent-bab.js (registerScriptlet
        // preventBab). Defeats the "BlockAdblock" anti-adblock script by
        // intercepting its own eval()/setTimeout() detection calls.
        scriptlet: function preventBab(source) {
            const logPrefix = '[uBlock-Dynamic] bab-defuser:';
            // Inlined uBO proxy-apply.js's proxyApplyFn — self-contained,
            // no further dependencies (globalThis, Proxy, Reflect only).
            function proxyApplyFn(target, handler, options = {}) {
                let context = globalThis;
                let prop = target;
                for (;;) {
                    const pos = prop.indexOf('.');
                    if ( pos === -1 ) { break; }
                    context = context[prop.slice(0, pos)];
                    if ( context instanceof Object === false ) { return; }
                    prop = prop.slice(pos + 1);
                }
                const fn = context[prop];
                if ( typeof fn !== 'function' ) { return; }
                if ( proxyApplyFn.CtorContext === undefined ) {
                    proxyApplyFn.ctorContexts = [];
                    proxyApplyFn.CtorContext = class {
                        constructor(...a) { this.init(...a); }
                        init(callFn, callArgs) { this.callFn = callFn; this.callArgs = callArgs; return this; }
                        reflect() {
                            const r = Reflect.construct(this.callFn, this.callArgs);
                            this.callFn = this.callArgs = undefined;
                            proxyApplyFn.ctorContexts.push(this);
                            return r;
                        }
                        static factory(...a) {
                            return proxyApplyFn.ctorContexts.length !== 0
                                ? proxyApplyFn.ctorContexts.pop().init(...a)
                                : new proxyApplyFn.CtorContext(...a);
                        }
                    };
                    proxyApplyFn.applyContexts = [];
                    proxyApplyFn.ApplyContext = class {
                        constructor(...a) { this.init(...a); }
                        init(callFn, thisArg, callArgs) { this.callFn = callFn; this.thisArg = thisArg; this.callArgs = callArgs; return this; }
                        reflect() {
                            const r = Reflect.apply(this.callFn, this.thisArg, this.callArgs);
                            this.callFn = this.thisArg = this.callArgs = undefined;
                            proxyApplyFn.applyContexts.push(this);
                            return r;
                        }
                        static factory(...a) {
                            return proxyApplyFn.applyContexts.length !== 0
                                ? proxyApplyFn.applyContexts.pop().init(...a)
                                : new proxyApplyFn.ApplyContext(...a);
                        }
                    };
                    proxyApplyFn.isCtor = new Map();
                    proxyApplyFn.proxies = new WeakMap();
                    if ( (options.skipToString || proxyApplyFn.skipToString) !== true ) {
                        proxyApplyFn.nativeToString = Function.prototype.toString;
                        const proxiedToString = new Proxy(Function.prototype.toString, {
                            apply(target, thisArg) {
                                let proxied = thisArg;
                                for (;;) {
                                    const f = proxyApplyFn.proxies.get(proxied);
                                    if ( f === undefined ) { break; }
                                    proxied = f;
                                }
                                return proxyApplyFn.nativeToString.call(proxied);
                            }
                        });
                        proxyApplyFn.proxies.set(proxiedToString, proxyApplyFn.nativeToString);
                        Function.prototype.toString = proxiedToString;
                    }
                }
                if ( proxyApplyFn.isCtor.has(target) === false ) {
                    proxyApplyFn.isCtor.set(target, fn.prototype?.constructor === fn);
                }
                const proxyDetails = {
                    apply(target, thisArg, args) {
                        return handler(proxyApplyFn.ApplyContext.factory(target, thisArg, args));
                    }
                };
                if ( proxyApplyFn.isCtor.get(target) ) {
                    proxyDetails.construct = function(target, args) {
                        return handler(proxyApplyFn.CtorContext.factory(target, args));
                    };
                }
                const proxiedTarget = new Proxy(fn, proxyDetails);
                proxyApplyFn.proxies.set(proxiedTarget, fn);
                context[prop] = proxiedTarget;
            }
            const signatures = [
                [ 'blockadblock' ],
                [ 'babasbm' ],
                [ /getItem\('babn'\)/ ],
                [
                    'getElementById', 'String.fromCharCode',
                    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                    'charAt', 'DOMContentLoaded', 'AdBlock', 'addEventListener',
                    'doScroll', 'fromCharCode', '<<2|r>>4', 'sessionStorage',
                    'clientWidth', 'localStorage', 'Math', 'random',
                ],
            ];
            const check = s => {
                if ( typeof s !== 'string' ) { return false; }
                for ( const tokens of signatures ) {
                    let match = 0;
                    for ( const token of tokens ) {
                        const hit = token instanceof RegExp ? token.test(s) : s.includes(token);
                        if ( hit ) { match += 1; }
                    }
                    if ( (match / tokens.length) >= 0.8 ) { return true; }
                }
                return false;
            };
            proxyApplyFn('eval', context => {
                const a = context.callArgs[0];
                if ( !check(a) ) { return context.reflect(); }
                if ( source.verbose ) { console.log(logPrefix, 'Prevented'); }
                if ( document.body ) { document.body.style.removeProperty('visibility'); }
                const el = document.getElementById('babasbmsgx');
                if ( el ) { el.parentNode.removeChild(el); }
            });
            proxyApplyFn('setTimeout', context => {
                const { callArgs } = context;
                const a = callArgs[0];
                if ( typeof a === 'string' && /\.bab_elementid.$/.test(a) ) {
                    callArgs[0] = ( ) => {};
                    if ( source.verbose ) { console.log(logPrefix, 'Prevented'); }
                }
                return context.reflect();
            });
        },
    },
    {
        names: [ 'freeze-element-property' ],
        // Adapted from uBO's prevent-innerHTML.js (registerScriptlet
        // freezeElementProperty). Conditionally blocks assignment to one
        // element property matching a selector/value pattern.
        scriptlet: function freezeElementProperty(source, args) {
            const [ property = '', selector = '', pattern = '' ] = args || [];
            if ( property === '' ) { return; }
            const logPrefix = `[uBlock-Dynamic] freeze-element-property(${property}):`;
            const negate = pattern.startsWith('!');
            const rawPattern = negate ? pattern.slice(1) : pattern;
            const asRegex = /^\/.+\/$/.test(rawPattern)
                ? new RegExp(rawPattern.slice(1, -1))
                : null;
            const testPattern = text => {
                if ( rawPattern === '' ) { return true; }
                const hit = asRegex ? asRegex.test(text) : text.includes(rawPattern);
                return negate ? !hit : hit;
            };
            const owner = (( ) => {
                if ( Object.hasOwn(HTMLScriptElement.prototype, property) ) { return HTMLScriptElement.prototype; }
                if ( Object.hasOwn(HTMLElement.prototype, property) ) { return HTMLElement.prototype; }
                if ( Object.hasOwn(Element.prototype, property) ) { return Element.prototype; }
                if ( Object.hasOwn(Node.prototype, property) ) { return Node.prototype; }
                return null;
            })();
            if ( owner === null ) { return; }
            const current = Object.getOwnPropertyDescriptor(owner, property);
            if ( current === undefined ) { return; }
            const shouldPreventSet = (elem, a) => {
                if ( selector !== '' ) {
                    if ( typeof elem.matches !== 'function' ) { return false; }
                    if ( elem.matches(selector) === false ) { return false; }
                }
                return testPattern(`${a}`);
            };
            Object.defineProperty(owner, property, {
                get: function() { return current.get ? current.get.call(this) : current.value; },
                set: function(a) {
                    if ( shouldPreventSet(this, a) ) {
                        if ( source.verbose ) { console.log(logPrefix, 'Assignment prevented'); }
                    } else if ( current.set ) {
                        current.set.call(this, a);
                    }
                    current.value = a;
                },
            });
        },
    },
    {
        // NOTE: @adguard/scriptlets added `href-sanitizer` itself between
        // this file being written and its first real build (caught by
        // the redundancy check the moment it ran) — that name was
        // removed from this list in the same pass. It does NOT register
        // `urlskip` as an alias of its own href-sanitizer, so that one
        // real gap remains and this entry stays for it.
        names: [ 'urlskip' ],
        // Adapted from uBO's href-sanitizer.js (registerScriptlet
        // hrefSanitizer) plus its own internal use of urlskip.js's
        // urlSkip() transform engine (a SEPARATE, untrusted, internal
        // use of that helper — not the unrelated `$urlskip=` trusted
        // network-filter option urlSkip() also backs elsewhere in uBO;
        // see this file's own header). Rewrites a link's href to its
        // real destination, defeating shortener/redirect wrappers.
        scriptlet: function hrefSanitizer(source, args) {
            const [ selector = '', srcSpec = '' ] = args || [];
            if ( selector === '' ) { return; }
            const rawSource = srcSpec === '' ? 'text' : srcSpec;
            const logPrefix = `[uBlock-Dynamic] href-sanitizer(${selector}):`;
            // Inlined uBO's urlskip.js urlSkip() — self-contained.
            const urlSkip = (url, steps) => {
                try {
                    let urlout = url;
                    for ( const step of steps ) {
                        const urlin = urlout;
                        const c0 = step.charCodeAt(0);
                        if ( c0 === 0x23 && step === '#' ) {
                            const pos = urlin.indexOf('#');
                            urlout = pos !== -1 ? urlin.slice(pos + 1) : '';
                            continue;
                        }
                        if ( c0 === 0x26 ) {
                            const i = (parseInt(step.slice(1)) || 0) - 1;
                            if ( i < 0 ) { return; }
                            const u = new URL(urlin);
                            if ( i >= u.searchParams.size ) { return; }
                            const params = Array.from(u.searchParams.keys());
                            urlout = decodeURIComponent(params[i]);
                            continue;
                        }
                        if ( c0 === 0x2B && step === '+https' ) {
                            const s = urlin.replace(/^https?:\/\//, '');
                            if ( /^[\w-]:\/\//.test(s) ) { return; }
                            urlout = `https://${s}`;
                            continue;
                        }
                        if ( c0 === 0x2D ) {
                            if ( step === '-base64' ) { urlout = self.atob(urlin); continue; }
                            if ( step === '-safebase64' ) {
                                urlout = self.atob(urlin.replace(/[-_]/g, c => c === '-' ? '+' : '/'));
                                continue;
                            }
                            if ( step === '-uricomponent' ) { urlout = decodeURIComponent(urlin); continue; }
                        }
                        if ( c0 === 0x2F ) {
                            const re = new RegExp(step.slice(1, -1));
                            const match = re.exec(urlin);
                            if ( match === null || match.length <= 1 ) { return; }
                            urlout = match[1];
                            continue;
                        }
                        if ( c0 === 0x3F ) {
                            urlout = (new URL(urlin)).searchParams.get(step.slice(1));
                            if ( urlout === null ) { return; }
                            if ( urlout.includes(' ') ) { urlout = urlout.replace(/ /g, '%20'); }
                            continue;
                        }
                        return;
                    }
                    const urlfinal = new URL(urlout);
                    if ( urlfinal.protocol !== 'https:' && urlfinal.protocol !== 'http:' ) { return; }
                    return urlout;
                } catch {
                }
            };
            const sanitizeCopycats = (href, text) => {
                let elems = [];
                try { elems = document.querySelectorAll(`a[href="${href}"`); } catch {}
                for ( const elem of elems ) { elem.setAttribute('href', text); }
                return elems.length;
            };
            const validateURL = text => {
                if ( typeof text !== 'string' || text === '' ) { return ''; }
                if ( /[\x00-\x20\x7f]/.test(text) ) { return ''; }
                try { return (new URL(text, document.location)).href; } catch {}
                return '';
            };
            const extractURL = (elem, src) => {
                if ( /^\[.*\]$/.test(src) ) { return elem.getAttribute(src.slice(1, -1).trim()) || ''; }
                if ( src === 'text' ) {
                    return elem.textContent
                        .replace(/^[^\x21-\x7e]+/, '')
                        .replace(/[^\x21-\x7e]+$/, '');
                }
                const steps = src.replace(/(\S)\?/g, '\\1 ?').split(/\s+/);
                const url = urlSkip(elem.href, steps);
                if ( url === undefined ) { return; }
                return url.replace(/ /g, '%20');
            };
            const sanitize = ( ) => {
                let elems = [];
                try { elems = document.querySelectorAll(selector); } catch { return false; }
                for ( const elem of elems ) {
                    if ( elem.localName !== 'a' || elem.hasAttribute('href') === false ) { continue; }
                    const href = elem.getAttribute('href');
                    const hrefAfter = validateURL(extractURL(elem, rawSource));
                    if ( hrefAfter === '' || hrefAfter === href ) { continue; }
                    elem.setAttribute('href', hrefAfter);
                    const count = sanitizeCopycats(href, hrefAfter);
                    if ( source.verbose ) { console.log(logPrefix, `Sanitized ${count + 1} link(s) to`, hrefAfter); }
                }
                return true;
            };
            let observer, timer;
            const onDomChanged = mutations => {
                if ( timer !== undefined ) { return; }
                let should = false;
                for ( const m of mutations ) {
                    for ( const n of m.addedNodes ) { if ( n.nodeType === 1 ) { should = true; break; } }
                    if ( should ) { break; }
                }
                if ( !should ) { return; }
                timer = requestAnimationFrame(( ) => { timer = undefined; sanitize(); });
            };
            const start = ( ) => {
                if ( sanitize() === false ) { return; }
                observer = new MutationObserver(onDomChanged);
                observer.observe(document.body, { subtree: true, childList: true });
            };
            if ( document.readyState === 'loading' ) {
                document.addEventListener('DOMContentLoaded', start, { once: true });
            } else {
                start();
            }
        },
    },
];
