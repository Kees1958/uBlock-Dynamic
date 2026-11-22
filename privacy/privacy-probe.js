// ── privacy-probe.js ────────────────────────────────────────────────────────────
// Fingerprint Inspector, MAIN world: instruments fingerprinting-related browser APIs on the inspected page and
// reports each use to privacy-bridge.js. Classic content script (no import/export).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
(function(){
    'use strict';
    // Populated asynchronously by a CustomEvent from privacy-bridge.js
    // (which has chrome.* API access this MAIN-world script doesn't).
    // Holds whichever custom scriptlet rules match this page's hostname, so
    // instrumentWindow() can apply real blocking — not just detection —
    // directly via property access, which works even inside a sandboxed
    // iframe that chrome.scripting.executeScript cannot inject into at all.
    let activeRules = [];
    window.addEventListener('uBolActiveScriptletRules', event => {
        if ( !Array.isArray(event.detail) ) { return; }
        activeRules = event.detail;
    });
    function hasRule(name) { return activeRules.some(r => r.name === name); }
    function abortsProperty(path) { return activeRules.some(r => r.name === 'abort-on-property-read' && r.args?.[0] === path); }

    // De-dupe window: a single fingerprinting check often fires the exact
    // same {category, api, details} combination dozens of times per minute
    // (interval re-checks, multiple internal callers, etc.) — without this,
    // the panel fills with repeats of something you already know is
    // happening rather than new information. 2s is short enough that a
    // genuinely new, distinct occurrence a few seconds later still shows.
    const DEDUPE_WINDOW_MS = 2000;
    const recentReports = new Map(); // key -> timestamp of last report

    // Guard: prune expired entries on every call rather than letting the
    // map grow unbounded for the lifetime of the page — cost is
    // proportional to the (small, in practice) number of distinct keys
    // seen recently, not to how many times report() has ever been called.
    function pruneRecentReports(now) {
        for ( const [ key, ts ] of recentReports ) {
            if ( (now - ts) >= DEDUPE_WINDOW_MS ) { recentReports.delete(key); }
        }
    }

    function report(category, api, details = '', url = location.href) {
        const now = Date.now();
        pruneRecentReports(now);
        const key = `${category}|${api}|${details}`;
        if ( recentReports.has(key) ) { return; }
        recentReports.set(key, now);
        window.dispatchEvent(new CustomEvent('uBolPrivacyInspector', {
            detail: { category, api, details, url },
        }));
    }

    // ── Anti-detection: native-looking toString for every wrapped function ──
    // A Proxy over a function/constructor is, by itself, already detectable:
    // calling Function.prototype.toString on it yields
    // "function () { [native code] }" — the same [native code] body a
    // genuine native function/constructor would show, but with the NAME
    // silently dropped, even though the Proxy's own .name property still
    // correctly forwards to the target's real name. That name-vs-toString
    // mismatch is a well-documented, simple check some anti-bot/anti-fraud
    // vendor scripts use to flag canvas/WebGL/audio instrumentation — the
    // exact signature every canvas-fingerprint-resistance extension leaves
    // behind, real native constructors included (verified: Promise, Array
    // and Map all stringify as "function Name() { [native code] }", not a
    // class-style body, so one fake-toString format below covers both the
    // Proxy-based wraps and wrapGetter's plain-function replacement below).
    //
    // NOT a full defense: a script that saves a reference to
    // Function.prototype.toString before any content script runs, then
    // later calls `savedToString.call(wrapped)`, bypasses this entirely —
    // that call path never touches the wrapped value's own property lookup,
    // so neither a `get` trap (Proxy case) nor an own `toString` property
    // (plain-function case) can intercept it. Closing that gap would
    // require patching Function.prototype.toString itself globally, which
    // touches every function on the page (not just the handful instrumented
    // here) and is itself a stronger tamper signal if inspected — not worth
    // that tradeoff for this tool.
    function fakeNativeToString(name) {
        return function toString() {
            return `function ${name}() { [native code] }`;
        };
    }

    // Proxy case (wrapMethod below, plus every construct-trap Proxy further
    // down this file): merges a `get` trap for the 'toString' property into
    // the caller's own handler, so `proxy.toString()` resolves to the fake
    // above instead of fallthrough-forwarding to the target and hitting
    // V8's name-dropping Proxy toString behavior described above.
    function withNativeToString(original, handler) {
        const fakeToString = fakeNativeToString(original.name);
        return {
            ...handler,
            get(target, prop, receiver) {
                if ( prop === 'toString' ) { return fakeToString; }
                return handler.get
                    ? handler.get(target, prop, receiver)
                    : Reflect.get(target, prop, receiver);
            },
        };
    }

    // Applies every wrap to a given window object. Reusable for both the
    // top frame and any same-origin iframe's own window, since a canvas
    // element living inside an iframe uses THAT iframe's own separate
    // HTMLCanvasElement/CanvasRenderingContext2D/etc. prototypes — not the
    // top frame's — even when the call reaching it originates from the top
    // frame's script. A `sandbox` iframe without `allow-scripts` cannot run
    // any injected content script at all (a hard, correct browser security
    // restriction), so the only way to instrument — or mitigate — such a
    // frame's canvas API is to reach into its (same-origin) contentWindow
    // directly from here, rather than trying to get Chrome to inject a
    // *second* content script or executeScript call inside it.
    function instrumentWindow(win, label) {
        if ( !win || win.__uBolInstrumented ) { return; }
        try { win.__uBolInstrumented = true; } catch { return; }

        // shouldReport is optional and defaults to "always report" — every
        // existing call site below that doesn't pass it keeps behaving
        // exactly as before. Only added for cases (WebGL below) where the
        // method is called constantly for completely routine reasons and
        // only a specific argument combination is actually fingerprint-
        // relevant; reporting unconditionally there would just be noise.
        function wrapMethod(owner, name, category, detailBuilder, shouldBlock, shouldReport) {
            const original = owner?.[name];
            if ( typeof original !== 'function' ) { return; }
            owner[name] = new win.Proxy(original, withNativeToString(original, {
                apply(target, thisArg, args) {
                    if ( !shouldReport || shouldReport(args) ) {
                        let details = '';
                        try { details = detailBuilder ? detailBuilder(args) : ''; } catch {}
                        report(category, name, details);
                    }
                    if ( shouldBlock && shouldBlock(args) ) { return null; }
                    return Reflect.apply(target, thisArg, args);
                },
            }));
        }

        // Property-read variant of wrapMethod, above — needed because some
        // fingerprinting vectors (navigator.plugins et al.) are getters, not
        // functions, so there is no call for wrapMethod's apply-trap to
        // intercept. Re-defines the property on `owner` with a getter that
        // reports first, then defers to the original getter unchanged — this
        // is detection-only (no shouldBlock), matching how the property
        // itself is only ever read, never invoked with arguments worth
        // inspecting.
        function wrapGetter(owner, name, category) {
            const descriptor = owner && Object.getOwnPropertyDescriptor(owner, name);
            if ( !descriptor || typeof descriptor.get !== 'function' ) { return; }
            const originalGet = descriptor.get;
            try {
                // Declared as `function get()` (C9a — a named function is a
                // declaration, not `const x = function get() {}`), then
                // aliased. The NAME `get` is deliberate and must stay: it is
                // observable via `.name` on the replaced getter, so renaming
                // it would change the page-visible surface this file exists
                // to keep native-looking.
                function get() {
                    report(category, name);
                    return Reflect.apply(originalGet, this, []);
                }
                const replacementGet = get;
                // Own property, not inherited — shadows Function.prototype.toString
                // for plain `replacementGet.toString()` / `String(replacementGet)`
                // calls. See withNativeToString()'s comment above for the same
                // detectability reasoning and its one known limitation.
                win.Object.defineProperty(replacementGet, 'toString', {
                    value: fakeNativeToString('get ' + name),
                    writable: true,
                    configurable: true,
                });
                win.Object.defineProperty(owner, name, {
                    ...descriptor,
                    get: replacementGet,
                });
            } catch {}
        }

        try {
            const OriginalRTC = win.RTCPeerConnection || win.webkitRTCPeerConnection;
            if ( typeof OriginalRTC === 'function' ) {
                const replacement = new win.Proxy(OriginalRTC, withNativeToString(OriginalRTC, {
                    construct(target, args, newTarget) {
                        report('webrtc', 'RTCPeerConnection', JSON.stringify(args[0] || {}));
                        if ( hasRule('nowebrtc') ) {
                            throw new TypeError('RTCPeerConnection is blocked on this site');
                        }
                        return Reflect.construct(target, args, newTarget);
                    },
                }));
                if ( win.RTCPeerConnection ) { win.RTCPeerConnection = replacement; }
                if ( win.webkitRTCPeerConnection ) { win.webkitRTCPeerConnection = replacement; }
            }

            // prevent-canvas (as currently created — always with empty args,
            // meaning "block every contextType") — see the real scriptlet's
            // own logic in js/generated/custom-scriptlets-dispatch.mjs:
            // shouldPrevent is unconditionally true when no contextType arg
            // is given.
            function canvasBlocked() { return hasRule('prevent-canvas'); }
            if ( win.HTMLCanvasElement ) {
                wrapMethod(win.HTMLCanvasElement.prototype, 'getContext', 'webgl', args => String(args[0] || ''), canvasBlocked);
                wrapMethod(win.HTMLCanvasElement.prototype, 'toDataURL', 'canvas', undefined, canvasBlocked);
                wrapMethod(win.HTMLCanvasElement.prototype, 'toBlob', 'canvas', undefined, canvasBlocked);
            }
            if ( win.CanvasRenderingContext2D ) {
                wrapMethod(win.CanvasRenderingContext2D.prototype, 'getImageData', 'canvas', undefined, canvasBlocked);
            }

            // WebGL GPU-fingerprint detection — deliberately narrower than
            // "every getParameter/getExtension call": both are called
            // constantly by ordinary WebGL use (three.js, Babylon.js,
            // Google Maps' WebGL layer, any canvas game) for completely
            // routine feature-detection and state queries, so instrumenting
            // them wholesale would flag nearly every WebGL site as
            // "verdacht". The actual fingerprint-specific signal is
            // requesting the 'WEBGL_debug_renderer_info' extension — the
            // getParameter(UNMASKED_VENDOR_WEBGL/UNMASKED_RENDERER_WEBGL)
            // reads that normally follow are the extraction step, but they
            // add no new information once the getExtension call itself is
            // known to have happened, so only that one is reported (kept
            // as a plain wrapMethod call, undecorated by shouldReport,
            // rather than also instrumenting getParameter).
            const DEBUG_RENDERER_EXTENSION = 'WEBGL_debug_renderer_info';
            function wrapWebglContext(ContextClass) {
                if ( !ContextClass ) { return; }
                wrapMethod(
                    ContextClass.prototype, 'getExtension', 'webgl-fingerprint',
                    args => String(args[0] || ''),
                    undefined,
                    args => args[0] === DEBUG_RENDERER_EXTENSION,
                );
            }
            wrapWebglContext(win.WebGLRenderingContext);
            wrapWebglContext(win.WebGL2RenderingContext);
            if ( win.navigator?.clipboard ) {
                wrapMethod(win.navigator.clipboard, 'read', 'clipboard', undefined, () => abortsProperty('navigator.clipboard.read'));
                wrapMethod(win.navigator.clipboard, 'readText', 'clipboard', undefined, () => abortsProperty('navigator.clipboard.readText'));
                wrapMethod(win.navigator.clipboard, 'write', 'clipboard', undefined, () => abortsProperty('navigator.clipboard.write'));
                wrapMethod(win.navigator.clipboard, 'writeText', 'clipboard', undefined, () => abortsProperty('navigator.clipboard.writeText'));
            }
            // history.pushState/replaceState detection was dropped: it fires
            // on virtually every SPA route change (React Router, Vue Router,
            // Next.js, etc.), making it high-noise/low-signal compared to
            // the other categories here — not because browsers already
            // mitigate it (that's a separate, unrelated fix from years ago
            // for :visited link-color sniffing, not for pushState/
            // replaceState).
            if ( win.navigator ) {
                wrapMethod(win.navigator, 'sendBeacon', 'beacon', args => String(args[0] || ''), () => abortsProperty('navigator.sendBeacon'));
            }
            if ( win.navigator?.permissions ) {
                wrapMethod(win.navigator.permissions, 'query', 'permissions', args => String(args[0]?.name || ''), () => abortsProperty('navigator.permissions.query'));
            }
            const OriginalOfflineAudio = win.OfflineAudioContext || win.webkitOfflineAudioContext;
            if ( typeof OriginalOfflineAudio === 'function' ) {
                const replacement = new win.Proxy(OriginalOfflineAudio, withNativeToString(OriginalOfflineAudio, {
                    construct(target, args, newTarget) {
                        report('audio', 'OfflineAudioContext');
                        if ( abortsProperty('OfflineAudioContext') ) {
                            throw new TypeError('OfflineAudioContext is blocked on this site');
                        }
                        return Reflect.construct(target, args, newTarget);
                    },
                }));
                if ( win.OfflineAudioContext ) { win.OfflineAudioContext = replacement; }
                if ( win.webkitOfflineAudioContext ) { win.webkitOfflineAudioContext = replacement; }
            }

            // Regular (non-offline) AudioContext — the same audio-
            // fingerprinting technique (oscillator + AnalyserNode timing
            // differences) is at least as commonly done through the live
            // AudioContext as through OfflineAudioContext above; same
            // construct-Proxy pattern, reported under the same 'audio'
            // category since both are the same underlying signal from the
            // Privacy Inspector panel's point of view.
            const OriginalAudioContext = win.AudioContext || win.webkitAudioContext;
            if ( typeof OriginalAudioContext === 'function' ) {
                const replacement = new win.Proxy(OriginalAudioContext, withNativeToString(OriginalAudioContext, {
                    construct(target, args, newTarget) {
                        report('audio', 'AudioContext');
                        if ( abortsProperty('AudioContext') ) {
                            throw new TypeError('AudioContext is blocked on this site');
                        }
                        return Reflect.construct(target, args, newTarget);
                    },
                }));
                if ( win.AudioContext ) { win.AudioContext = replacement; }
                if ( win.webkitAudioContext ) { win.webkitAudioContext = replacement; }
            }

            // Timezone fingerprinting — Intl.DateTimeFormat().resolvedOptions()
            // exposes the system timezone. Function call, so this fits
            // wrapMethod directly with no new plumbing.
            if ( win.Intl?.DateTimeFormat?.prototype ) {
                wrapMethod(win.Intl.DateTimeFormat.prototype, 'resolvedOptions', 'tz-fingerprint');
            }

            // navigator.plugins / navigator.mimeTypes — in a modern Chrome
            // these are in practice always empty (NPAPI has been gone for
            // years), so reading them has almost no legitimate purpose left;
            // a site that still enumerates them is doing so almost
            // exclusively for fingerprinting. These are property getters,
            // not function calls, hence wrapGetter rather than wrapMethod.
            const NavigatorProto = win.Navigator?.prototype;
            if ( NavigatorProto ) {
                wrapGetter(NavigatorProto, 'plugins', 'navigator-plugins');
                wrapGetter(NavigatorProto, 'mimeTypes', 'navigator-plugins');
            }

            // ── Legitimate-use signals (detection-only, never mitigatable) ──
            // hardwareConcurrency, deviceMemory, maxTouchPoints, connection,
            // and getGamepads were previously offered as Select mitigations
            // under a broader 'device' category; all five were removed from
            // that because abort-on-property-read throws on read, and each
            // is legitimately read by widespread, unrelated-to-fingerprinting
            // code (worker-pool sizing, adaptive video quality/bitrate,
            // touch detection, gamepad-presence UI) — confirmed breaking
            // real sites for two of them.
            //
            // Re-added here as PURE DETECTION — no CATEGORY_SCRIPTLET_MAP
            // entry exists for 'legit-signals' in privacy-inspector.js, so
            // Select is always disabled for these rows; wrapGetter never
            // blocks regardless (see its own comment above), and the
            // wrapMethod call below passes no shouldBlock callback, so
            // getGamepads is never blocked either — reporting only.
            //
            // The reason to track them at all despite never mitigating them:
            // each is individually unremarkable, but a site reading several
            // of these together is the actual fingerprinting tell — see the
            // aggregate-signal banner in privacy-inspector.js, which counts
            // distinct properties seen under this category and warns once
            // enough of them accumulate, without ever risking the breakage
            // a real blocking rule would.
            if ( NavigatorProto ) {
                wrapGetter(NavigatorProto, 'hardwareConcurrency', 'legit-signals');
                wrapGetter(NavigatorProto, 'deviceMemory', 'legit-signals');
                wrapGetter(NavigatorProto, 'maxTouchPoints', 'legit-signals');
                wrapGetter(NavigatorProto, 'connection', 'legit-signals');
            }
            if ( win.navigator && typeof win.navigator.getGamepads === 'function' ) {
                wrapMethod(win.navigator, 'getGamepads', 'legit-signals');
            }

            // ── Battery status fingerprinting ─────────────────────────────
            // Was part of the same broader 'device' category; kept
            // mitigatable (unlike the five above) because Firefox and
            // Safari removed this API entirely — battery level + charging
            // time turned out to be a precise cross-session fingerprint,
            // with no comparably strong legitimate use case.
            if ( win.navigator && typeof win.navigator.getBattery === 'function' ) {
                wrapMethod(win.navigator, 'getBattery', 'device', undefined, () => abortsProperty('navigator.getBattery'));
            }

            // Idle Detection API — near-zero legitimate use outside a
            // handful of explicit presence/status apps; almost always a
            // tracking signal when present. Global constructor, so this
            // follows the same construct-Proxy pattern as RTCPeerConnection/
            // AudioContext above rather than wrapMethod/wrapGetter.
            const OriginalIdleDetector = win.IdleDetector;
            if ( typeof OriginalIdleDetector === 'function' ) {
                const replacement = new win.Proxy(OriginalIdleDetector, withNativeToString(OriginalIdleDetector, {
                    construct(target, args, newTarget) {
                        report('idle', 'IdleDetector');
                        if ( abortsProperty('IdleDetector') ) {
                            throw new TypeError('IdleDetector is blocked on this site');
                        }
                        return Reflect.construct(target, args, newTarget);
                    },
                }));
                win.IdleDetector = replacement;
            }

            // Web NFC — same reasoning and pattern as Idle Detection above:
            // global constructor, virtually no legitimate use on a typical
            // page outside a dedicated NFC-reader app.
            const OriginalNDEFReader = win.NDEFReader;
            if ( typeof OriginalNDEFReader === 'function' ) {
                const replacement = new win.Proxy(OriginalNDEFReader, withNativeToString(OriginalNDEFReader, {
                    construct(target, args, newTarget) {
                        report('nfc', 'NDEFReader');
                        if ( abortsProperty('NDEFReader') ) {
                            throw new TypeError('NDEFReader is blocked on this site');
                        }
                        return Reflect.construct(target, args, newTarget);
                    },
                }));
                win.NDEFReader = replacement;
            }
        } catch (ex) {
            console.warn('[uBlock-Dynamic] Privacy Inspector: failed to instrument', label, ex?.message || ex);
        }
    }

    function tryInstrumentIframe(iframe) {
        try {
            instrumentWindow(iframe.contentWindow, 'iframe:' + (iframe.src || '(no src)'));
        } catch {
            // Cross-origin, or a script-sandboxed frame with no
            // allow-same-origin either — nothing we can do from here in
            // that case; expected/benign, not logged as a failure.
        }
    }

    // Top frame — always our own window, always accessible.
    instrumentWindow(window, 'top:' + location.href);

    // Any iframe already present (unlikely at document_start, but cheap to
    // check) plus every one added afterwards — fingerprint scripts often
    // create their canvas iframe well after initial page load.
    for ( const f of document.querySelectorAll('iframe') ) { tryInstrumentIframe(f); }
    new MutationObserver(mutations => {
        for ( const m of mutations ) {
            for ( const node of m.addedNodes ) {
                if ( node.tagName === 'IFRAME' ) {
                    tryInstrumentIframe(node);
                } else if ( node.querySelectorAll ) {
                    for ( const f of node.querySelectorAll('iframe') ) { tryInstrumentIframe(f); }
                }
            }
        }
    }).observe(document.documentElement || document, { childList: true, subtree: true });

    // ── Tracking elements (10.7.0, owner's request) ─────────────────────────
    // Not API calls but page ELEMENTS used for tracking. Reported with the resource URL in `details`, which the
    // panel's per-site "Select" mitigation targets (privacy-inspector.js CATEGORY_SCRIPTLET_MAP):
    //   tracking-ping  — a link carrying a `ping` attribute (hyperlink auditing: a request fired on click);
    //   tracking-frame — an iframe of at most 1×1 pixel loading a web address;
    //   tracking-pixel — an image whose real (natural) size is 1×1 or 3×3 pixels, also when it is never added
    //                    to the page (`new Image().src = …`, the classic tracking pixel).
    // Detection only — this file never blocks these; a saved rule does (remove-attr / prevent-element-src-loading).
    // Every listener lives as long as the page and is released with it; nothing is stored.
    const TRACKING_ELEMENT_CONFIG = Object.freeze({
        PIXEL_SIZES: Object.freeze([ 1, 3 ]),   // square images of these sizes (natural width = height)
        MAX_FRAME_PX: 1,                        // iframes this small or smaller in both directions
        WEB_URL_RE: /^https?:/i,                // only real web addresses are reported (not data:/blob:/about:)
        PING_SELECTOR: 'a[ping]',
    });
    // Elements already reported — WeakSet: an element dropped by the page is released with it.
    const reportedElements = new WeakSet();

    function absoluteUrl(value) {
        try { return new URL(value, location.href).href; } catch { return ''; }
    }
    function checkPing(a) {
        if ( reportedElements.has(a) || !a.getAttribute ) { return; }
        const target = a.getAttribute('ping');
        if ( !target ) { return; }
        reportedElements.add(a);
        report('tracking-ping', TRACKING_ELEMENT_CONFIG.PING_SELECTOR, target.split(/\s+/).map(absoluteUrl).join(' '));
    }
    function checkFrame(frame) {
        if ( reportedElements.has(frame) ) { return; }
        const src = absoluteUrl(frame.getAttribute('src') || '');
        if ( !TRACKING_ELEMENT_CONFIG.WEB_URL_RE.test(src) ) { return; }
        const box = frame.getBoundingClientRect();
        const w = Math.round(box.width), h = Math.round(box.height);
        const max = TRACKING_ELEMENT_CONFIG.MAX_FRAME_PX;
        if ( w > max || h > max ) { return; }
        reportedElements.add(frame);
        report('tracking-frame', `iframe ${w}x${h}`, src);
    }
    function checkPixel(img) {
        if ( reportedElements.has(img) ) { return; }
        const w = img.naturalWidth, h = img.naturalHeight;
        if ( w !== h || !TRACKING_ELEMENT_CONFIG.PIXEL_SIZES.includes(w) ) { return; }
        const src = img.currentSrc || img.src || '';
        if ( !TRACKING_ELEMENT_CONFIG.WEB_URL_RE.test(src) ) { return; }
        reportedElements.add(img);
        report('tracking-pixel', `img ${w}x${h}`, src);
    }
    function scanNode(node) {
        if ( node.nodeType !== 1 ) { return; }
        if ( node.matches?.(TRACKING_ELEMENT_CONFIG.PING_SELECTOR) ) { checkPing(node); }
        for ( const a of node.querySelectorAll?.(TRACKING_ELEMENT_CONFIG.PING_SELECTOR) ?? [] ) { checkPing(a); }
        // A frame's size is known only after layout: checked on its load (below) and once on the next frame.
        const frames = node.tagName === 'IFRAME' ? [ node ] : [ ...(node.querySelectorAll?.('iframe') ?? []) ];
        if ( frames.length !== 0 ) { window.requestAnimationFrame(( ) => { for ( const f of frames ) { checkFrame(f); } }); }
    }
    try {
        // Images and frames in the page: their `load` event does not bubble, so one capture listener sees all.
        document.addEventListener('load', event => {
            const el = event.target;
            if ( el?.tagName === 'IMG' ) { checkPixel(el); } else if ( el?.tagName === 'IFRAME' ) { checkFrame(el); }
        }, true);
        // Images never added to the page: watch the `src` setter itself, and check the image once it loads.
        const srcDescriptor = Object.getOwnPropertyDescriptor(window.HTMLImageElement.prototype, 'src');
        if ( srcDescriptor && typeof srcDescriptor.set === 'function' ) {
            const originalSet = srcDescriptor.set;
            // Named `set` and given a native-looking toString, like wrapGetter()'s `get` above (anti-detection).
            function set(value) {
                if ( this.isConnected === false ) {
                    this.addEventListener('load', ( ) => checkPixel(this), { once: true });
                }
                return Reflect.apply(originalSet, this, [ value ]);
            }
            Object.defineProperty(set, 'toString', { value: fakeNativeToString('set src'), writable: true, configurable: true });
            Object.defineProperty(window.HTMLImageElement.prototype, 'src', { ...srcDescriptor, set });
        }
        // Links with a ping attribute and tiny frames, present now or added / changed later.
        function scanAll() { scanNode(document.documentElement); }
        if ( document.readyState === 'loading' ) { document.addEventListener('DOMContentLoaded', scanAll, { once: true }); } else { scanAll(); }
        new MutationObserver(mutations => {
            for ( const m of mutations ) {
                if ( m.type === 'attributes' ) { scanNode(m.target); continue; }
                for ( const node of m.addedNodes ) { scanNode(node); }
            }
        }).observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: [ 'ping', 'src' ] });
    } catch (ex) {
        console.warn('[uBlock-Dynamic] Privacy Inspector: tracking-element detection not started', ex?.message || ex);
    }
})();
