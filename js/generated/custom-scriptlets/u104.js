/*! Adapted from uBlock Origin (https://github.com/gorhill/uBlock), Copyright (C) Raymond Hill, GPL-3.0-or-later; hand-ported by uBlock-Stripped-Dynamic (js/resources/ubo-patch-scriptlets-source.mjs); see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function setStorageItemNow(source, args) {
            const [ kind = '', key = '' ] = args || [];
            const STORAGE_BY_KIND = { local: 'localStorage', session: 'sessionStorage' };
            const MAX_KEY_LENGTH = 256;
            const storageName = STORAGE_BY_KIND[kind];
            if ( storageName === undefined || typeof key !== 'string' || key.trim() === '' || key.length > MAX_KEY_LENGTH ) { return; }
            try {
                self[storageName].setItem(key, String(Date.now()));
                if ( source.verbose ) { console.log('[uBlock-Dynamic] set-storage-item-now:', kind, key); }
            } catch { /* storage disabled or full: nothing to do */ }
        })(source, args);
})();
