/*! Adapted from uBlock Origin (https://github.com/gorhill/uBlock), Copyright (C) Raymond Hill, GPL-3.0-or-later; hand-ported by uBlock-Stripped-Dynamic (js/resources/ubo-patch-scriptlets-source.mjs); see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function preventBab(source) {
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
        })(source, args);
})();
