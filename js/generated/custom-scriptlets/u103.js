/*! Adapted from uBlock Origin (https://github.com/gorhill/uBlock), Copyright (C) Raymond Hill, GPL-3.0-or-later; hand-ported by uBlock-Stripped-Dynamic (js/resources/ubo-patch-scriptlets-source.mjs); see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function preventDialog(source, args) {
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
        })(source, args);
})();
