/*! AdGuard Scriptlets 2.6.0 (https://github.com/AdguardTeam/Scriptlets) by the AdGuard team (AdguardTeam), GPL-3.0. Bundled unchanged by uBlock-Stripped-Dynamic; see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function noeval(source,args){const uniqueIdentifier=source.uniqueId+source.name+"_"+(Array.isArray(args)?args.join("_"):"");if(source.uniqueId&&"done"===Window.prototype.toString[uniqueIdentifier])return;const updatedArgs=args?[].concat(source).concat(args):[source];try{(function(source){window.eval=function(s){!function(e){if(e.verbose){try{var n=console.trace.bind(console),i="[AdGuard] ";"corelibs"===e.engine?i+=e.ruleText:(e.domainName&&(i+=`${e.domainName}`),e.args?i+=`#%#//scriptlet('${e.name}', '${e.args.join("', '")}')`:i+=`#%#//scriptlet('${e.name}')`),n&&n(i)}catch(e){}"function"==typeof window.__debug&&window.__debug(e)}}(source),function(e,o){var r=arguments.length>2&&void 0!==arguments[2]&&arguments[2],a=!(arguments.length>3&&void 0!==arguments[3])||arguments[3],{name:n,verbose:g}=e;if(r||g){var i=console.log;a?i(`${n}: ${o}`):Array.isArray(o)?i(`${n}:`,...o):i(`${n}:`,o)}}(source,`AdGuard has prevented eval:\n${s}`,!0)}.bind()}).apply(this,updatedArgs),source.uniqueId&&Object.defineProperty(Window.prototype.toString,uniqueIdentifier,{value:"done",enumerable:!1,writable:!1,configurable:!1})}catch(e){console.log(e)}})(source, args);
})();
