/*! Adapted from uBlock Origin (https://github.com/gorhill/uBlock), Copyright (C) Raymond Hill, GPL-3.0-or-later; hand-ported by uBlock-Stripped-Dynamic (js/resources/ubo-patch-scriptlets-source.mjs); see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function blankSetAttributeValue(source, args) {
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
        })(source, args);
})();
