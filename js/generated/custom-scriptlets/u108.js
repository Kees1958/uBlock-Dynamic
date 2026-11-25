/*! Adapted from uBlock Origin (https://github.com/gorhill/uBlock), Copyright (C) Raymond Hill, GPL-3.0-or-later; hand-ported by uBlock-Stripped-Dynamic (js/resources/ubo-patch-scriptlets-source.mjs); see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function freezeElementProperty(source, args) {
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
        })(source, args);
})();
