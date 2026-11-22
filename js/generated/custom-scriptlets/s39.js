/*! AdGuard Scriptlets 2.6.0 (https://github.com/AdguardTeam/Scriptlets) by the AdGuard team (AdguardTeam), GPL-3.0. Bundled unchanged by uBlock-Stripped-Dynamic; see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function log(source,args){const uniqueIdentifier=source.uniqueId+source.name+"_"+(Array.isArray(args)?args.join("_"):"");if(source.uniqueId&&"done"===Window.prototype.toString[uniqueIdentifier])return;const updatedArgs=args?[].concat(source).concat(args):[source];try{(function(){for(var _len=arguments.length,args=new Array(_len),_key=0;_key<_len;_key++)args[_key]=arguments[_key];console.log(args)}).apply(this,updatedArgs),source.uniqueId&&Object.defineProperty(Window.prototype.toString,uniqueIdentifier,{value:"done",enumerable:!1,writable:!1,configurable:!1})}catch(e){console.log(e)}})(source, args);
})();
