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

// ── UBO_PATCH_SCRIPTLETS ────────────────────────────────────────────────────
// One entry per distinct function. `names` lists every alias this
// scriptlet should be reachable by (bare form only — the generic
// `.js`-alias-stripping fix in buildCustomScriptletsDispatch() handles
// the `.js`-suffixed forms the same way it does for @adguard/scriptlets'
// own names, so only the bare names need listing here).
export const UBO_PATCH_SCRIPTLETS = [
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
