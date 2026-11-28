/*! Adapted from uBlock Origin (https://github.com/gorhill/uBlock), Copyright (C) Raymond Hill, GPL-3.0-or-later; hand-ported by uBlock-Stripped-Dynamic (js/resources/ubo-patch-scriptlets-source.mjs); see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function disableFaveSsai(source, args) {
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
        })(source, args);
})();
