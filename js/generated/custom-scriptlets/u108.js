/*! Adapted from uBlock Origin (https://github.com/gorhill/uBlock), Copyright (C) Raymond Hill, GPL-3.0-or-later; hand-ported by uBlock-Stripped-Dynamic (js/resources/ubo-patch-scriptlets-source.mjs); see THIRD_PARTY_LICENSES.md. */
(function(){
    var a = self.__uboCustomScriptletArgs;
    delete self.__uboCustomScriptletArgs;
    var source = (a && a[0]) || {};
    var args = (a && a[1]) || [];
    (function hrefSanitizer(source, args) {
            const [ selector = '', srcSpec = '' ] = args || [];
            if ( selector === '' ) { return; }
            const rawSource = srcSpec === '' ? 'text' : srcSpec;
            const logPrefix = `[uBlock-Dynamic] href-sanitizer(${selector}):`;
            // Inlined uBO's urlskip.js urlSkip() — self-contained.
            const urlSkip = (url, steps) => {
                try {
                    let urlout = url;
                    for ( const step of steps ) {
                        const urlin = urlout;
                        const c0 = step.charCodeAt(0);
                        if ( c0 === 0x23 && step === '#' ) {
                            const pos = urlin.indexOf('#');
                            urlout = pos !== -1 ? urlin.slice(pos + 1) : '';
                            continue;
                        }
                        if ( c0 === 0x26 ) {
                            const i = (parseInt(step.slice(1)) || 0) - 1;
                            if ( i < 0 ) { return; }
                            const u = new URL(urlin);
                            if ( i >= u.searchParams.size ) { return; }
                            const params = Array.from(u.searchParams.keys());
                            urlout = decodeURIComponent(params[i]);
                            continue;
                        }
                        if ( c0 === 0x2B && step === '+https' ) {
                            const s = urlin.replace(/^https?:\/\//, '');
                            if ( /^[\w-]:\/\//.test(s) ) { return; }
                            urlout = `https://${s}`;
                            continue;
                        }
                        if ( c0 === 0x2D ) {
                            if ( step === '-base64' ) { urlout = self.atob(urlin); continue; }
                            if ( step === '-safebase64' ) {
                                urlout = self.atob(urlin.replace(/[-_]/g, c => c === '-' ? '+' : '/'));
                                continue;
                            }
                            if ( step === '-uricomponent' ) { urlout = decodeURIComponent(urlin); continue; }
                        }
                        if ( c0 === 0x2F ) {
                            const re = new RegExp(step.slice(1, -1));
                            const match = re.exec(urlin);
                            if ( match === null || match.length <= 1 ) { return; }
                            urlout = match[1];
                            continue;
                        }
                        if ( c0 === 0x3F ) {
                            urlout = (new URL(urlin)).searchParams.get(step.slice(1));
                            if ( urlout === null ) { return; }
                            if ( urlout.includes(' ') ) { urlout = urlout.replace(/ /g, '%20'); }
                            continue;
                        }
                        return;
                    }
                    const urlfinal = new URL(urlout);
                    if ( urlfinal.protocol !== 'https:' && urlfinal.protocol !== 'http:' ) { return; }
                    return urlout;
                } catch {
                }
            };
            const sanitizeCopycats = (href, text) => {
                let elems = [];
                try { elems = document.querySelectorAll(`a[href="${href}"`); } catch {}
                for ( const elem of elems ) { elem.setAttribute('href', text); }
                return elems.length;
            };
            const validateURL = text => {
                if ( typeof text !== 'string' || text === '' ) { return ''; }
                if ( /[\x00-\x20\x7f]/.test(text) ) { return ''; }
                try { return (new URL(text, document.location)).href; } catch {}
                return '';
            };
            const extractURL = (elem, src) => {
                if ( /^\[.*\]$/.test(src) ) { return elem.getAttribute(src.slice(1, -1).trim()) || ''; }
                if ( src === 'text' ) {
                    return elem.textContent
                        .replace(/^[^\x21-\x7e]+/, '')
                        .replace(/[^\x21-\x7e]+$/, '');
                }
                const steps = src.replace(/(\S)\?/g, '\\1 ?').split(/\s+/);
                const url = urlSkip(elem.href, steps);
                if ( url === undefined ) { return; }
                return url.replace(/ /g, '%20');
            };
            const sanitize = ( ) => {
                let elems = [];
                try { elems = document.querySelectorAll(selector); } catch { return false; }
                for ( const elem of elems ) {
                    if ( elem.localName !== 'a' || elem.hasAttribute('href') === false ) { continue; }
                    const href = elem.getAttribute('href');
                    const hrefAfter = validateURL(extractURL(elem, rawSource));
                    if ( hrefAfter === '' || hrefAfter === href ) { continue; }
                    elem.setAttribute('href', hrefAfter);
                    const count = sanitizeCopycats(href, hrefAfter);
                    if ( source.verbose ) { console.log(logPrefix, `Sanitized ${count + 1} link(s) to`, hrefAfter); }
                }
                return true;
            };
            let observer, timer;
            const onDomChanged = mutations => {
                if ( timer !== undefined ) { return; }
                let should = false;
                for ( const m of mutations ) {
                    for ( const n of m.addedNodes ) { if ( n.nodeType === 1 ) { should = true; break; } }
                    if ( should ) { break; }
                }
                if ( !should ) { return; }
                timer = requestAnimationFrame(( ) => { timer = undefined; sanitize(); });
            };
            const start = ( ) => {
                if ( sanitize() === false ) { return; }
                observer = new MutationObserver(onDomChanged);
                observer.observe(document.body, { subtree: true, childList: true });
            };
            if ( document.readyState === 'loading' ) {
                document.addEventListener('DOMContentLoaded', start, { once: true });
            } else {
                start();
            }
        })(source, args);
})();
