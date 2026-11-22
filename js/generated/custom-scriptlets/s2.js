/*! AdGuard Scriptlets 2.6.0 (https://github.com/AdguardTeam/Scriptlets) by the AdGuard team (AdguardTeam), GPL-3.0. Bundled unchanged by uBlock-Stripped-Dynamic; see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function Fingerprintjs2(source,args){const uniqueIdentifier=source.uniqueId+source.name+"_"+(Array.isArray(args)?args.join("_"):"");if(source.uniqueId&&"done"===Window.prototype.toString[uniqueIdentifier])return;const updatedArgs=args?[].concat(source).concat(args):[source];try{(function(source){for(var browserId="",i=0;i<8;i+=1)browserId+=(65536*Math.random()+4096).toString(16).slice(-4);var Fingerprint2=function(){};Fingerprint2.prototype={get:Fingerprint2.get=function(options,callback){callback||(callback=options),setTimeout((function(){callback&&callback(browserId,[])}),1)}},window.Fingerprint2=Fingerprint2,window.Fingerprint=Fingerprint2,function(e){if(e.verbose){try{var n=console.trace.bind(console),i="[AdGuard] ";"corelibs"===e.engine?i+=e.ruleText:(e.domainName&&(i+=`${e.domainName}`),e.args?i+=`#%#//scriptlet('${e.name}', '${e.args.join("', '")}')`:i+=`#%#//scriptlet('${e.name}')`),n&&n(i)}catch(e){}"function"==typeof window.__debug&&window.__debug(e)}}(source)}).apply(this,updatedArgs),source.uniqueId&&Object.defineProperty(Window.prototype.toString,uniqueIdentifier,{value:"done",enumerable:!1,writable:!1,configurable:!1})}catch(e){console.log(e)}})(source, args);
})();
