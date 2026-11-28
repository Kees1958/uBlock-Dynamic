/*! Adapted from uBlock Origin (https://github.com/gorhill/uBlock), Copyright (C) Raymond Hill, GPL-3.0-or-later; hand-ported by uBlock-Stripped-Dynamic (js/resources/ubo-patch-scriptlets-source.mjs); see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function setDataAttr(source, args) {
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
        })(source, args);
})();
