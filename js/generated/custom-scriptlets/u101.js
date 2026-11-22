/*! Adapted from uBlock Origin (https://github.com/gorhill/uBlock), Copyright (C) Raymond Hill, GPL-3.0-or-later; hand-ported by uBlock-Stripped-Dynamic (js/resources/ubo-patch-scriptlets-source.mjs); see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function stubWindowObject(source, args) {
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
        })(source, args);
})();
