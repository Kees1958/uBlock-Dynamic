/*
 * autoaccept-snippets.generated.js — BUILD-TIME GENERATED, DO NOT EDIT BY HAND.
 * Mode: accept ("accept all") — the bundle registered while the person DOES delete cookies at every
 * browser start (js/data/cookie-banner-action.js).
 * Regenerate via: node tools/build-autodeny-bundle.mjs
 * Source: vendor/autoconsent/eval-snippets.js + vendor/autoconsent/rules/rules.json
 *
 * LICENSE — MIXED, per-entry (see THIRD_PARTY_LICENSES.md and
 * vendor/autoconsent/rules/rules.json's own _provenance field): some of
 * the functions/rules compiled into this file are adapted from
 * duckduckgo/autoconsent's own MPL-2.0 code, others independently
 * hand-authored. vendor/autoconsent/LICENSE (MPL-2.0 text) covers the
 * former, per MPL-2.0 §3.1's own directory-level-notice allowance.
 *
 * Registered MAIN-world, allFrames:true, ONLY while a "Never consent"
 * session is active — js/core/scripting-manager.js's
 * registerCookieClickerAutoDenyContentScriptsImpl() (D11: registration-
 * presence IS the gate, no in-bundle runtime skip check).
 */
(() => {
    "use strict";

    // Precedence (D5) — a saved per-site cookie-clicker rule always wins;
    // see js/scripting/cookie-clicker-click.js's own PRECEDENCE_MARKER_ATTR
    // comment for why a DOM attribute is this cross-world signal.
    const PRECEDENCE_MARKER_ATTR = "data-ubol-cookie-clicker-rule";
    const PRECEDENCE_PENDING_ATTR = "data-ubol-cookie-clicker-pending";
    const RETRY_INTERVAL_MS = 1500;
    const RETRY_MAX_ATTEMPTS = 8;
    // (8.2.21) — after the fast retry window above gives up, fall back to
    // a much lower-frequency, MutationObserver-driven watch for up to
    // this long before finally giving up for good. Exists specifically
    // for two realistic cases neither previous window covered: an SPA
    // that swaps in new content (including a consent banner) well after
    // the original page load, and a third-party CMP script that's simply
    // slower than RETRY_MAX_ATTEMPTS * RETRY_INTERVAL_MS on a particular
    // page (ad-heavy article pages vary a lot). Generous enough to cover
    // realistic article-reading dwell time, but still finite — this file
    // must never watch indefinitely for the lifetime of a long-lived tab.
    const EXTENDED_WATCH_MS = 5 * 60 * 1000; // 5 minutes

    const FNS = {
    EVAL_ACCEPT_ALL: function(rule) {
        try {
            const ACCEPT_APIS = {
                ONETRUST:          () => window.OneTrust.AllowAll(),
                COOKIEBOT:         () => window.Cookiebot.submitCustomConsent(true, true, true),
                DIDOMI:            () => window.Didomi.setUserAgreeToAll(),
                USERCENTRICS:      () => (window.__ucCmp ? window.__ucCmp.acceptAllConsents() : window.UC_UI.acceptAllConsents()),
                KLARO:             () => { const m = window.klaro.getManager(); m.changeAll(true); m.saveAndApplyConsents(); },
                COOKIEINFORMATION: () => window.CookieInformation.submitAllCategories(),
                CONSENTMANAGER:    () => window.__cmp('setConsent', 1),
                TARTEAUCITRON:     () => window.tarteaucitron.userInterface.respondAll(true),
            };
            const ACCEPT_LABEL_RE = /^(accept( all( cookies)?)?|allow( all( cookies)?)?|agree( to all)?|i agree|i accept|ok(ay)?|got it|alle akzeptieren|akzeptieren|alle cookies akzeptieren|alles accepteren|accepteren|akkoord|alle cookies accepteren|tout accepter|accepter( tout)?|j\u0027accepte|aceptar( todo| todas)?|accetta( tutto| tutti)?|aceitar( todos)?|zaakceptuj( wszystko)?|acceptera alla|godkänn alla|hyväksy kaikki|accepter alle|godta alle|tillad alle)$/i;
            const accept = (rule && rule.accept) || {};
            // (10.7.16, owner's decision 2026-11-19) hideOnly: never click this CMP, not even to accept — the
            // accept bundle then only hides its banner (hideBannerContainer() right after this). For a CMP whose
            // buttons navigate away and back (XenForo) and whose own default without an answer is safe.
            if ( accept.hideOnly === true ) { return; }
            if ( accept.api && ACCEPT_APIS[accept.api] ) {
                try { ACCEPT_APIS[accept.api](); return; } catch {}   // API absent/changed: fall through to the DOM
            }
            const scopes = [];
            if ( accept.scope === 'document' ) {
                scopes.push(document);
            } else {
                const rootSel = rule.hideSelector || rule.detect.selector;
                for ( const root of (rootSel ? document.querySelectorAll(rootSel) : []) ) {
                    scopes.push(root);
                    if ( root.shadowRoot ) { scopes.push(root.shadowRoot); }
                }
            }
            for ( const scope of scopes ) {
                for ( const sel of (accept.selectors || []) ) {
                    const btn = scope.querySelector(sel);
                    if ( btn ) { btn.click(); return; }
                }
            }
            for ( const scope of scopes ) {
                for ( const el of scope.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]') ) {
                    const label = (el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
                    if ( ACCEPT_LABEL_RE.test(label) ) { el.click(); return; }
                }
            }
        } catch {}
    
    },
    };

    const RULES = [
    {
        "name": "OneTrust",
        "detect": {
            "global": "OneTrust",
            "selector": "#onetrust-banner-sdk, #onetrust-consent-sdk, .onetrust-pc-dark-filter"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "api": "ONETRUST",
            "selectors": [
                "#onetrust-accept-btn-handler",
                ".onetrust-close-btn-handler.accept-all"
            ]
        }
    },
    {
        "name": "Cookiebot",
        "detect": {
            "global": "Cookiebot",
            "selector": "#CybotCookiebotDialog"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "api": "COOKIEBOT",
            "selectors": [
                "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
                "#CybotCookiebotDialogBodyButtonAccept"
            ]
        }
    },
    {
        "name": "Klaro",
        "detect": {
            "global": "klaro",
            "selector": ".klaro .cm-modal"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "api": "KLARO",
            "selectors": [
                ".cm-btn-accept-all",
                ".cm-btn-success"
            ]
        }
    },
    {
        "name": "CookieYes",
        "detect": {
            "global": "CookieYes",
            "selector": "#cookie-law-info-bar, .cky-consent-container"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                ".cky-btn-accept",
                "#cookie_action_close_header"
            ]
        }
    },
    {
        "name": "Complianz",
        "detect": {
            "global": "complianz",
            "selector": "#cmplz-cookiebanner-container"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                ".cmplz-btn.cmplz-accept",
                ".cmplz-accept"
            ]
        }
    },
    {
        "name": "Osano",
        "detect": {
            "global": "Osano",
            "selector": ".osano-cm-dialog"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                ".osano-cm-accept-all",
                ".osano-cm-accept"
            ]
        }
    },
    {
        "name": "Termly",
        "detect": {
            "global": "displayPreferenceModal",
            "selector": "#termly-code-snippet-support"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "[data-tid=\"banner-accept\"]"
            ]
        }
    },
    {
        "name": "Didomi",
        "detect": {
            "global": "Didomi",
            "selector": "#didomi-host"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "api": "DIDOMI",
            "selectors": [
                "#didomi-notice-agree-button"
            ]
        }
    },
    {
        "name": "Sourcepoint",
        "detect": {
            "global": "_sp_",
            "selector": "[id^='sp_message_container_'], iframe[id^='sp_message_iframe_']"
        },
        "hideSelector": "[id^='sp_message_container_'], iframe[id^='sp_message_iframe_'], .message-overlay, .message-container",
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "scope": "document",
            "selectors": [
                "button.sp_choice_type_11",
                "button[title=\"Accept all\"]",
                "button[title=\"Accept\"]"
            ]
        }
    },
    {
        "name": "Fides",
        "detect": {
            "global": "Fides",
            "selector": "#fides-banner, #fides-modal, #fides-overlay"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                ".fides-accept-all-button"
            ]
        }
    },
    {
        "name": "Usercentrics",
        "detect": {
            "selector": "#usercentrics-root"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "api": "USERCENTRICS",
            "selectors": [
                "[data-testid=\"uc-accept-all-button\"]"
            ]
        }
    },
    {
        "name": "UserWay",
        "detect": {
            "selector": "#cookie_consent_banner_main_app"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": []
        }
    },
    {
        "name": "Shopify",
        "detect": {
            "selector": "#shopify-pc__banner"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#shopify-pc__banner__btn-accept"
            ]
        }
    },
    {
        "name": "TrustArc",
        "detect": {
            "global": "truste",
            "selector": ".truste_popframe.trustarc_newcm_container"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#truste-consent-button"
            ]
        }
    },
    {
        "name": "Quantcast Choice / InMobi CMP",
        "detect": {
            "global": "__cmp",
            "selector": "#qc-cmp2-container"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                ".qc-cmp2-summary-buttons button[mode=\"primary\"]"
            ]
        }
    },
    {
        "name": "iubenda",
        "detect": {
            "global": "_iub",
            "selector": "#iubenda-cs-banner"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                ".iubenda-cs-accept-btn"
            ]
        }
    },
    {
        "name": "ConsentManager",
        "detect": {
            "selector": "#ncmp__tool .ncmp__banner.ncmp__active"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "api": "CONSENTMANAGER",
            "selectors": []
        }
    },
    {
        "name": "Borlabs Cookie",
        "detect": {
            "global": "BorlabsCookie",
            "selector": "._brlbs-block-content, .brlbs-cmpnt-dialog, #BorlabsCookieBox"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "a[data-cookie-accept-all]",
                ".brlbs-btn-accept-all",
                "._brlbs-btn-accept-all"
            ]
        }
    },
    {
        "name": "CookieFirst",
        "detect": {
            "selector": "#cookiefirst-root, .cookiefirst-root"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "[data-cookiefirst-action=\"accept\"]"
            ]
        }
    },
    {
        "name": "Cookie Script",
        "detect": {
            "selector": "#cookiescript_injected"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#cookiescript_accept"
            ]
        }
    },
    {
        "name": "Civic Cookie Control",
        "detect": {
            "selector": "#ccc-module, #ccc-notify"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#ccc-notify-accept",
                "#ccc-recommended-settings"
            ]
        }
    },
    {
        "name": "Cookie Information",
        "detect": {
            "selector": "#cookie-information-template-wrapper"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "api": "COOKIEINFORMATION",
            "selectors": []
        }
    },
    {
        "name": "Ketch",
        "detect": {
            "selector": "#lanyard_root div[role='dialog'], #ketch-banner, #ketch-modal"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#ketch-banner-button-primary"
            ]
        }
    },
    {
        "name": "Real Cookie Banner",
        "detect": {
            "selector": "div[consent-skip-blocker=\"1\"][id][data-bg]"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": []
        }
    },
    {
        "name": "Silktide",
        "detect": {
            "selector": "#silktide-wrapper, #silktide-banner"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                ".accept-all"
            ]
        }
    },
    {
        "name": "TYPO3 Cookieman",
        "detect": {
            "selector": "#cookieman-modal"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "[data-cookieman-accept-all]"
            ]
        }
    },
    {
        "name": "tarteaucitron.js",
        "detect": {
            "selector": "#tarteaucitronRoot, #tarteaucitronAlertBig, #tarteaucitronAlertSmall"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "api": "TARTEAUCITRON",
            "selectors": [
                "#tarteaucitronPersonalize2",
                "#tarteaucitronAllAllowed"
            ]
        }
    },
    {
        "name": "Piwik PRO Consent Manager",
        "detect": {
            "selector": "#ppms_cm_popup_overlay, #ppms_cm_bar_overlay"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#ppms_cm_agree-to-all"
            ]
        }
    },
    {
        "name": "GDPR Modal",
        "detect": {
            "selector": "#gdpr-modal #gdpr-consent-content"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": []
        }
    },
    {
        "name": "Drupal EU Cookie Compliance",
        "detect": {
            "selector": ".eu-cookie-compliance-banner"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                ".agree-button"
            ]
        }
    },
    {
        "name": "Evidon",
        "detect": {
            "selector": ".footer .evidon-footer-image"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#_evidon-accept-button"
            ]
        }
    },
    {
        "name": "ST CMP v2",
        "detect": {
            "selector": "#st-cmp-v2, .st-cmp-app"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": []
        }
    },
    {
        "name": "DPDPA-style consent popup (Thai market)",
        "detect": {
            "selector": ".dpdpa--popup"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": []
        }
    },
    {
        "name": "HubSpot",
        "detect": {
            "selector": "#hs-eu-cookie-confirmation"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#hs-eu-confirmation-button"
            ]
        }
    },
    {
        "name": "Adopt",
        "detect": {
            "selector": "#adopt-controller-button"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#adopt-accept-all-button"
            ]
        }
    },
    {
        "name": "AdRoll",
        "detect": {
            "selector": "#adroll_consent_container"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#adroll_consent_accept"
            ]
        }
    },
    {
        "name": "Webflow",
        "detect": {
            "selector": ".fs-cc-components, [fs-cc=banner]"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "[fs-cc=\"allow\"]"
            ]
        }
    },
    {
        "name": "Wix",
        "detect": {
            "selector": "[data-comp-type=cookie-banner-root-wix], [data-hook=ccsu-banner-wrapper]"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "[data-hook=\"consent-banner-apply-button\"]"
            ]
        }
    },
    {
        "name": "TagConcierge",
        "detect": {
            "selector": "#consent-banner-main"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": []
        }
    },
    {
        "name": "Privado",
        "detect": {
            "selector": "#cookie-consent-banner #accept-button"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#accept-button"
            ]
        }
    },
    {
        "name": "Axeptio",
        "detect": {
            "selector": ".axeptio_widget, .axeptio_mount"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#axeptio_btn_acceptAll"
            ]
        }
    },
    {
        "name": "TermsFeed",
        "detect": {
            "selector": ".termsfeed-com---nb"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                ".cc-nb-okagree"
            ]
        }
    },
    {
        "name": "DataGrail",
        "detect": {
            "selector": ".dg-consent-banner"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "button.dg-button.accept_all"
            ]
        }
    },
    {
        "name": "Moove GDPR",
        "detect": {
            "selector": "#moove_gdpr_cookie_info_bar"
        },
        "hideSelector": null,
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                ".moove-gdpr-infobar-allow-all"
            ]
        }
    },
    {
        "name": "XenForo",
        "detect": {
            "selector": ".notice.notice--cookieAdvanced[data-notice-id=\"-1\"]"
        },
        "hideSelector": ".notice.notice--cookieAdvanced[data-notice-id=\"-1\"]",
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [],
            "hideOnly": true
        }
    },
    {
        "name": "Sirdata",
        "detect": {
            "selector": "#sd-cmp"
        },
        "hideSelector": "#sd-cmp",
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "button:last-child > [data-sd-override=\"choiceButtons\"]"
            ]
        }
    },
    {
        "name": "Transcend",
        "detect": {
            "selector": "#transcend-consent-manager"
        },
        "hideSelector": "#transcend-consent-manager",
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                "#consentManagerMainDialog .inner-container button"
            ]
        }
    },
    {
        "name": "Google Funding Choices",
        "detect": {
            "selector": ".fc-consent-root"
        },
        "hideSelector": ".fc-consent-root",
        "action": "EVAL_ACCEPT_ALL",
        "accept": {
            "selectors": [
                ".fc-cta-consent"
            ]
        }
    }
];

    // Opt-in debug logging — reuses the EXACT SAME cookie
    // cookie-clicker-click.js already established for this project
    // (per ARCHITECTURE.md's reuse-not-reinvent principle), so one flag
    // toggles diagnostics for both the manual click interpreter and this
    // generic auto-deny bundle:
    //   document.cookie = 'uBolCookieClickerDebug=1; path=/; max-age=3600'
    // then reload. Plain cookie, not sessionStorage — see that file's own
    // header for why (DevTools console context can default to a
    // sandboxed third-party iframe).
    let DEBUG = false;
    try {
        DEBUG = document.cookie.split('; ').includes('uBolCookieClickerDebug=1');
    } catch {}
    function logDebug(...args) {
        if ( DEBUG === false ) { return; }
        console.info('[uBlock-Dynamic autodeny]', location.hostname, ...args);
    }

    function hasPrecedenceMarker() {
        try {
            return document.documentElement.hasAttribute(PRECEDENCE_MARKER_ATTR);
        } catch {
            return false; // guard: a denied DOM read never blocks the generic fallback
        }
    }

    // (10.4.9) The precedence decision for this frame is still pending (see PRECEDENCE_PENDING_ATTR).
    function isPrecedencePending() {
        try {
            return document.documentElement.hasAttribute(PRECEDENCE_PENDING_ATTR);
        } catch {
            return false; // guard: a denied DOM read never blocks the generic fallback
        }
    }

    // Cosmetic-hide fallback (v8.2.8 — Option A, see NEVER-CONSENT-
    // DESIGN.md's own note on this decision): applied AFTER firing the
    // real reject action above, never instead of it — this never records
    // or implies any consent choice, it's a pure, reversible CSS
    // display:none on the CMP's own banner root element (reusing
    // rule.hideSelector when present, else rule.detect.selector — see
    // rules.json's own header on why these two are sometimes
    // deliberately DIFFERENT: hideSelector (8.2.14) can be broader/less
    // CMP-specific than what's safe to also use for detection, e.g.
    // Sourcepoint's own backdrop on bbc.com using generic class names
    // like '.message-overlay' that would risk false-positive DETECTION
    // on an unrelated site if used for that purpose too).
    function hideBannerContainer(rule) {
        const selector = rule.hideSelector || rule.detect.selector;
        if ( !selector ) { return false; }
        let hidAny = false;
        try {
            const nodes = document.querySelectorAll(selector);
            for ( const node of nodes ) {
                node.style.setProperty('display', 'none', 'important');
                hidAny = true;
            }
        } catch {}
        return hidAny;
    }

    function matchesRule(rule) {
        try {
            if ( rule.detect.global && window[rule.detect.global] !== undefined ) { return true; }
            if ( rule.detect.selector && document.querySelector(rule.detect.selector) ) { return true; }
        } catch {}
        return false;
    }

    function tryOnce() {
        if ( hasPrecedenceMarker() ) {
            logDebug('precedence marker present — a saved rule covers this frame, not firing generic bundle');
            return { precedence: true, matched: [] };
        }
        if ( isPrecedencePending() ) {
            logDebug('precedence decision still pending for this frame — skipping this pass, retrying later');
            return { precedence: false, matched: [] };
        }
        const matched = [];
        for ( const rule of RULES ) {
            if ( matchesRule(rule) === false ) { continue; }
            const fn = FNS[rule.action];
            if ( typeof fn !== 'function' ) {
                logDebug(`matched CMP "${rule.name}" but no action fn "${rule.action}" found — bundle/rules mismatch`);
                continue;
            }
            logDebug(`matched CMP "${rule.name}" — firing ${rule.action}`);
            try { fn(rule); } catch (reason) { logDebug(`${rule.action} threw:`, reason); }
            const cosmeticHide = hideBannerContainer(rule);
            if ( cosmeticHide ) { logDebug(`also cosmetically hid "${rule.name}"'s banner container (Option A fallback)`); }
            matched.push({ name: rule.name, cosmeticHide });
        }
        if ( matched.length === 0 ) { logDebug('no known CMP matched on this pass'); }
        return { precedence: false, matched };
    }

    // GUARD — init/clear/release around every piece of state this file
    // owns: the fast-retry interval, the extended-watch MutationObserver
    // (8.2.21), and its own overall timeout — all torn down together
    // from this single stop(), whichever condition ends the session
    // first (a match, precedence, or either window's own budget
    // expiring). Same convention cookie-clicker-click.js's own
    // stopObserving() documents for its own MutationObserver.
    let attempts = 0;
    let intervalHandle;
    let observerHandle;
    let extendedWatchTimeoutHandle;
    function stop() {
        if ( intervalHandle !== undefined ) {
            clearInterval(intervalHandle);
            intervalHandle = undefined;
        }
        if ( observerHandle !== undefined ) {
            observerHandle.disconnect();
            observerHandle = undefined;
        }
        if ( extendedWatchTimeoutHandle !== undefined ) {
            clearTimeout(extendedWatchTimeoutHandle);
            extendedWatchTimeoutHandle = undefined;
        }
    }

    // Re-injection guard (8.2.21) — mirrors js/scripting/cookie-clicker-
    // picker.js's own self.__uBolCookieClickerPicker sentinel pattern
    // exactly. This file can genuinely be injected twice into the SAME
    // already-loaded frame without a navigation in between — e.g. the
    // person re-opens the action dialog and clicks "Never consent" again
    // on a tab where a previous instance's extended watch is still
    // running. Without this guard, two independent instances would run
    // concurrently in the same frame: each polling/observing and
    // potentially firing a reject action redundantly, wasting resources
    // and risking a double-fire against some CMP's own idempotency-
    // sensitive flow. Tearing down the PREVIOUS instance first, rather
    // than letting both run, keeps exactly one live instance per frame
    // at all times.
    if ( self.__uBolAutodenyBundle ) {
        self.__uBolAutodenyBundle.stop();
    }
    self.__uBolAutodenyBundle = { stop };

    function startExtendedWatch() {
        // MutationObserver — catches a banner that appears well after the
        // fast-retry window gave up, without needing to poll tightly for
        // the whole EXTENDED_WATCH_MS budget. Guarded: if the browser
        // denies observer creation for some reason, this degrades to
        // "no extended watch" rather than throwing into the caller.
        try {
            observerHandle = new MutationObserver(() => {
                const r = tryOnce();
                if ( r.precedence || r.matched.length > 0 ) { stop(); }
            });
            observerHandle.observe(document.documentElement, { childList: true, subtree: true });
        } catch {
            observerHandle = undefined;
        }
        // Hard overall cap — see EXTENDED_WATCH_MS's own comment above on
        // why this must stay finite.
        extendedWatchTimeoutHandle = self.setTimeout(() => {
            logDebug(`gave up after extended watch window (${EXTENDED_WATCH_MS / 1000}s) — no known CMP ever matched`);
            stop();
        }, EXTENDED_WATCH_MS);
    }

    logDebug('bundle injected, running immediate pass');
    const immediateResult = tryOnce();
    if ( immediateResult.precedence === false && immediateResult.matched.length === 0 ) {
        intervalHandle = setInterval(() => {
            attempts += 1;
            const r = tryOnce();
            if ( r.precedence || r.matched.length > 0 ) {
                stop();
                return;
            }
            if ( attempts >= RETRY_MAX_ATTEMPTS ) {
                logDebug(`fast-retry window ended after ${RETRY_MAX_ATTEMPTS} attempts — falling back to a longer, lower-frequency watch (SPA content changes / slow-loading CMP scripts)`);
                stop(); // clears the fast interval only — observer/timeout not yet set
                startExtendedWatch();
            }
        }, RETRY_INTERVAL_MS);
    }
    // Completion value (8.2.7) — collected per-frame by the caller's own
    // executeScript() return value (same InjectionResult mechanism a
    // one-off detection script would rely on for the same reason — see
    // e.g. how js/workflow/cookie-clicker-routes.js's own
    // handleCookieClickerLaunchPicker() used to collect a per-frame
    // result this same way, before that specific detection pass was
    // removed as dead weight in v8.6.2), so
    // js/workflow/cookie-clicker-routes.js's handleCookieClickerAutoDenyStart()
    // can report the REAL immediate-pass outcome back to the on-page
    // toast — not just "the message was sent", which told the person
    // nothing about whether an actual click happened. Only reflects the
    // IMMEDIATE, synchronous pass; a later retry-loop or extended-watch
    // match isn't reflected here, since execution has already returned to
    // the caller by then — the toast's own copy accounts for this (see
    // that file's own comment).
    return immediateResult;
})();
