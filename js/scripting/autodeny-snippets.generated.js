/*
 * autodeny-snippets.generated.js — BUILD-TIME GENERATED, DO NOT EDIT BY HAND.
 * Mode: decline ("reject all") — the bundle registered while the person does NOT delete cookies at every
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
    EVAL_ONETRUST_REJECT: function() {
        try {
            const btn = document.querySelector(
                '#onetrust-reject-all-handler, .ot-pc-refuse-all-handler, #onetrust-pc-btn-handler.reject-all-handler'
            );
            if ( btn ) { btn.click(); return; }
            if ( typeof window.OneTrust?.RejectAll === 'function' ) {
                window.OneTrust.RejectAll();
                return;
            }
            const scope = document.querySelector('#onetrust-banner-sdk, #onetrust-consent-sdk') || document;
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            for ( const el of scope.querySelectorAll('button, [role="button"], a') ) {
                const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                if ( rejectRe.test(label) ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_COOKIEBOT_REJECT: function() {
        try {
            const btn = document.querySelector(
                '#CybotCookiebotDialogBodyButtonDecline, .CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll, #CybotCookiebotDialogBodyLevelButtonDecline'
            );
            if ( btn ) { btn.click(); return; }
            if ( typeof window.Cookiebot?.decline === 'function' ) {
                window.Cookiebot.decline();
                return;
            }
            const scope = document.querySelector('#CybotCookiebotDialog') || document;
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            for ( const el of scope.querySelectorAll('button, [role="button"], a') ) {
                const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                if ( rejectRe.test(label) ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_KLARO_REJECT: function() {
        try {
            const btn = document.querySelector('.cm-btn-decline, .cn-decline, .klaro .cm-btn.cm-btn-danger');
            if ( btn ) { btn.click(); return; }
            const manager = window.klaro?.getManager?.();
            if ( manager && typeof manager.changeAll === 'function' ) {
                manager.changeAll(false);
                manager.saveAndApplyConsents?.();
                return;
            }
            const scope = document.querySelector('.klaro') || document;
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            for ( const el of scope.querySelectorAll('button, [role="button"], a') ) {
                const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                if ( rejectRe.test(label) ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_COOKIEYES_REJECT: function() {
        try {
            const btn = document.querySelector(
                '.cky-btn-reject, #cookie_action_close_header_reject, .cky-btn.cky-btn-reject'
            );
            if ( btn ) { btn.click(); return; }
            const scope = document.querySelector('#cookie-law-info-bar, .cky-consent-container') || document;
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            for ( const el of scope.querySelectorAll('button, [role="button"], a') ) {
                const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                if ( rejectRe.test(label) ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_COMPLIANZ_REJECT: function() {
        try {
            const btn = document.querySelector('.cmplz-deny, .cmplz-btn.cmplz-deny');
            if ( btn ) { btn.click(); return; }
            const scope = document.querySelector('#cmplz-cookiebanner-container') || document;
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            for ( const el of scope.querySelectorAll('button, [role="button"], a') ) {
                const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                if ( rejectRe.test(label) ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_OSANO_REJECT: function() {
        try {
            const btn = document.querySelector('.osano-cm-denyAll, .osano-cm-button--type_denyAll');
            if ( btn ) { btn.click(); return; }
            if ( typeof window.Osano?.cm?.denyAll === 'function' ) {
                window.Osano.cm.denyAll();
                return;
            }
            const scope = document.querySelector('.osano-cm-dialog') || document;
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            for ( const el of scope.querySelectorAll('button, [role="button"], a') ) {
                const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                if ( rejectRe.test(label) ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_TERMLY_REJECT: function() {
        try {
            const btn = document.querySelector('.t-declineAllButton, #decline-all');
            if ( btn ) { btn.click(); return; }
            // No confirmed real container selector for Termly yet (unlike
            // the others above) — deliberately scoped to `document` here
            // rather than guessing at a container id, so this fallback
            // stays honest about that gap instead of pretending a
            // confidence level it doesn't have.
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            for ( const el of document.querySelectorAll('button, [role="button"], a') ) {
                const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                if ( rejectRe.test(label) ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_DIDOMI_REJECT: function() {
        try {
            if ( typeof window.Didomi?.setUserDisagreeToAll === 'function' ) {
                window.Didomi.setUserDisagreeToAll();
                window.Didomi.notice?.hide?.();
                return;
            }
            const btn = document.querySelector('#didomi-notice-disagree-button');
            if ( btn ) { btn.click(); return; }
            const scope = document.querySelector('#didomi-host') || document;
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            for ( const el of scope.querySelectorAll('button, [role="button"], a') ) {
                const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                if ( rejectRe.test(label) ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_SOURCEPOINT_REJECT: function() {
        try {
            const btn = document.querySelector(
                'button.sp_choice_type_REJECT_ALL, .sp_choice_type_REJECT_ALL, button[title="Reject All"]'
            );
            if ( btn ) { btn.click(); return; }
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            const candidates = document.querySelectorAll('button, [role="button"]');
            for ( const el of candidates ) {
                const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                if ( rejectRe.test(label) ) {
                    el.click();
                    return;
                }
            }
        } catch {}
    
    },
    EVAL_FIDES_REJECT: function() {
        try {
            const scope = document.querySelector('#fides-banner, #fides-modal') || document;
            const candidates = scope.querySelectorAll('button');
            for ( const el of candidates ) {
                const label = ((el.getAttribute('data-testid') || '') + ' ' + (el.textContent || '')).toLowerCase();
                const isReject = /opt.?out|reject|decline/.test(label);
                const isAccept = /opt.?in|accept/.test(label);
                if ( isReject && !isAccept ) {
                    el.click();
                    return;
                }
            }
        } catch {}
    
    },
    EVAL_USERCENTRICS_REJECT: function() {
        try {
            const root = document.querySelector('#usercentrics-root');
            const shadow = root?.shadowRoot;
            if ( !shadow ) { return; } // closed root, or not actually present — nothing reachable
            const btn = shadow.querySelector('[data-testid="uc-deny-all-button"], button[data-testid$="deny-all-button"]');
            if ( btn ) { btn.click(); return; }
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bdeny\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            for ( const el of shadow.querySelectorAll('button, [role="button"]') ) {
                const label = (el.textContent || el.getAttribute('data-testid') || '').trim();
                if ( rejectRe.test(label) ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_USERWAY_REJECT: function() {
        try {
            const btn = document.querySelector(
                '[data-search-key-button="reject_all_text"], .cookie_consent-consent_banner__action-reject-all button'
            );
            if ( btn ) { btn.click(); return; }
            const scope = document.querySelector('#cookie_consent_banner_main_app') || document;
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bdeny\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            for ( const el of scope.querySelectorAll('button, [role="button"]') ) {
                const label = (el.textContent || el.getAttribute('data-search-key-button') || '').trim();
                if ( rejectRe.test(label) ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_SHOPIFY_REJECT: function() {
        try {
            const btn = document.querySelector('#shopify-pc__banner__btn-decline');
            if ( btn ) { btn.click(); return; }
            const scope = document.querySelector('#shopify-pc__banner') || document;
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bdeny\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            for ( const el of scope.querySelectorAll('button, [role="button"], a') ) {
                const label = (el.textContent || el.getAttribute('aria-label') || '').trim();
                if ( rejectRe.test(label) ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_TRUSTARC_REJECT: function() {
        try {
            const container = document.querySelector('.truste_popframe.trustarc_newcm_container') || document;
            const btn = container.querySelector('a.required');
            if ( btn ) { btn.click(); }
        } catch {}
    
    },
    EVAL_QUANTCAST_REJECT: function() {
        try {
            const disagree = document.querySelector('#disagree-btn');
            if ( disagree ) { disagree.click(); return; }
            const secondaryBtns = document.querySelectorAll('.qc-cmp2-summary-buttons > button[mode="secondary"]');
            if ( secondaryBtns.length >= 2 ) { secondaryBtns[1].click(); return; }
            if ( secondaryBtns.length === 1 ) {
                secondaryBtns[0].click();
                self.setTimeout(() => {
                    try {
                        const rejectRe = /reject all|alle verwerpen|rifiuta tutto|tout refuser|alle ablehnen|bloquear todo|rejeitar todos|odrzu\u0107 wszystko/i;
                        for ( const el of document.querySelectorAll('.qc-cmp2-main button') ) {
                            if ( rejectRe.test(el.textContent || '') ) { el.click(); return; }
                        }
                    } catch {}
                }, 300);
            }
        } catch {}
    
    },
    EVAL_IUBENDA_REJECT: function() {
        try {
            const btn = document.querySelector('.iubenda-cs-reject-btn');
            if ( btn ) { btn.click(); return; }
            const customize = document.querySelector('.iubenda-cs-customize-btn');
            if ( customize ) { customize.click(); }
        } catch {}
    
    },
    EVAL_CONSENTMANAGER_REJECT: function() {
        try {
            if ( typeof window.__npcmp === 'function' ) {
                window.__npcmp('reject');
                return;
            }
            if ( typeof window.__cmp === 'function' ) {
                window.__cmp('setConsent', 0);
            }
        } catch {}
    
    },
    EVAL_BORLABS_REJECT: function() {
        try {
            const btn = document.querySelector('.brlbs-btn-accept-only-essential, a[data-cookie-refuse]');
            if ( btn ) { btn.click(); return; }
            const save = document.querySelector('.brlbs-btn-save, #CookieBoxSaveButton');
            if ( save ) { save.click(); }
        } catch {}
    
    },
    EVAL_COOKIEFIRST_REJECT: function() {
        try {
            const btn = document.querySelector('button[data-cookiefirst-action=reject]');
            if ( btn ) { btn.click(); return; }
            const adjust = document.querySelector('button[data-cookiefirst-action=adjust]');
            if ( adjust ) {
                adjust.click();
                self.setTimeout(() => {
                    try {
                        document.querySelectorAll('button[data-cookiefirst-accent-color=true][role=checkbox]:not([disabled])')
                            .forEach(el => { if ( el.getAttribute('aria-checked') === 'true' ) { el.click(); } });
                        const save = document.querySelector('button[data-cookiefirst-action=save]');
                        if ( save ) { save.click(); }
                    } catch {}
                }, 500);
            }
        } catch {}
    
    },
    EVAL_COOKIESCRIPT_REJECT: function() {
        try {
            const btn = document.querySelector('#cookiescript_reject');
            if ( btn ) { btn.click(); return; }
            const manage = document.querySelector('#cookiescript_manage');
            if ( manage ) {
                manage.click();
                self.setTimeout(() => {
                    try {
                        const rejectInPanel = document.querySelector('#cookiescript_reject');
                        if ( rejectInPanel ) { rejectInPanel.click(); }
                    } catch {}
                }, 400);
            }
        } catch {}
    
    },
    EVAL_CIVICCOOKIECONTROL_REJECT: function() {
        try {
            const btn = document.querySelector('.ccc-reject-button');
            if ( btn ) { btn.click(); return; }
            const dismiss = document.querySelector('#ccc-dismiss-button');
            if ( dismiss ) { dismiss.click(); }
        } catch {}
    
    },
    EVAL_COOKIEINFORMATION_REJECT: function() {
        try {
            if ( typeof window.CookieInformation?.declineAllCategories === 'function' ) {
                window.CookieInformation.declineAllCategories();
            }
        } catch {}
    
    },
    EVAL_KETCH_REJECT: function() {
        try {
            const rejectBtn = document.querySelector(
                "#lanyard_root button[aria-label^='Reject' i], #ketch-banner button[aria-label^='Reject' i], #ketch-banner-button-tertiary"
            );
            if ( rejectBtn ) { rejectBtn.click(); return; }
            const secondary = document.querySelector(
                "#lanyard_root div[class*=buttons] > button[class*=secondaryButton], #lanyard_root button[class*=buttons-secondary], #ketch-banner-button-secondary"
            );
            if ( secondary ) {
                secondary.click();
                self.setTimeout(() => {
                    try {
                        const rejectAll = document.querySelector(
                            "#lanyard_root button[class*=rejectButton], #lanyard_root button[class*=rejectAllButton], #ketch-modal button[aria-label='Reject All'], #ketch-purposes-modal button[aria-label='Reject All']"
                        );
                        if ( rejectAll ) { rejectAll.click(); }
                        else {
                            document.querySelectorAll("#lanyard_root input[type=checkbox][role=switch][aria-checked=true]:not(:disabled)")
                                .forEach(el => el.click());
                        }
                        const confirm = document.querySelector(
                            "#lanyard_root button[class*=confirmButton], #ketch-modal button[aria-label='Confirm'], #ketch-purposes-modal button[aria-label='Confirm']"
                        );
                        if ( confirm ) { confirm.click(); }
                    } catch {}
                }, 500);
            }
        } catch {}
    
    },
    EVAL_REALCOOKIEBANNER_REJECT: function() {
        try {
            const container = document.querySelector('div[consent-skip-blocker="1"][id][data-bg]');
            if ( !container ) { return; }
            const candidates = container.querySelectorAll('a[role=button]:not([id])');
            const rejectRe = /\bwithout\b|\bohne\b|\bablehnen\b|\breject\b|\bdecline\b/i;
            for ( const el of candidates ) {
                if ( rejectRe.test(el.textContent || '') ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_SILKTIDE_REJECT: function() {
        try {
            const scope = document.querySelector('#silktide-wrapper, #silktide-banner') || document;
            const exactRe = /reject non-essential/i;
            for ( const el of scope.querySelectorAll('button, [role="button"], a') ) {
                if ( exactRe.test(el.textContent || '') ) { el.click(); return; }
            }
            const rejectRe = /\breject\b|\bdisagree\b|\bdecline\b|\bopt.?out\b|do not (consent|agree|accept)/i;
            for ( const el of scope.querySelectorAll('button, [role="button"], a') ) {
                const label = (el.textContent || el.getAttribute('aria-label') || '').trim();
                if ( rejectRe.test(label) ) { el.click(); return; }
            }
        } catch {}
    
    },
    EVAL_TYPO3COOKIEMAN_REJECT: function() {
        try {
            document.querySelectorAll('#cookieman-modal input[type="checkbox"]').forEach(cb => {
                if ( cb.checked ) { cb.click(); }
            });
            const save = document.querySelector('#cookieman-modal .save-button');
            if ( save ) { save.click(); }
        } catch {}
    
    },
    EVAL_TARTEAUCITRON_REJECT: function() {
        try {
            document.querySelectorAll('#tarteaucitronRoot .tarteaucitronDeny').forEach(btn => { btn.click(); });
            const save = document.querySelector('.tarteaucitronValidate, .tarteaucitronClosePanel, #tarteaucitronClosePanel');
            if ( save ) { save.click(); }
        } catch {}
    
    },
    EVAL_PIWIKPRO_REJECT: function() {
        try {
            [
                '#consent-switcher--analytics',
                '#ppms_cm_consent_switcher_toggle--remarketing',
                '#consent-switcher--feedback',
                '#consent-switcher--custom_consent',
            ].forEach(sel => {
                const el = document.querySelector(sel);
                if ( el && el.classList.contains('checked') ) { el.click(); }
            });
            const save = document.querySelector('#ppms_cm_save-choices');
            if ( save ) { save.click(); }
        } catch {}
    
    },
    EVAL_GDPRMODAL_REJECT: function() {
        try {
            document.querySelectorAll('#gdpr-modal input[id^="gdpr-service-"]').forEach(cb => {
                if ( cb.checked ) { cb.click(); }
            });
            const save = document.querySelector('#continue');
            if ( save ) { save.click(); }
        } catch {}
    
    },
    EVAL_DRUPALEUCC_REJECT: function() {
        try {
            document.querySelectorAll('.eu-cookie-compliance-banner input[id^="cookie-category-"]').forEach(cb => {
                if ( cb.checked ) { cb.click(); }
            });
            const save = document.querySelector('.eu-cookie-compliance-save-preferences-button');
            if ( save ) { save.click(); }
        } catch {}
    
    },
    EVAL_EVIDON_REJECT: function() {
        try {
            document.querySelectorAll('img.category-check.checked').forEach(el => { el.click(); });
            const save = document.querySelector('button#apply-button');
            if ( save ) { save.click(); }
        } catch {}
    
    },
    EVAL_STCMPV2_REJECT: function() {
        try {
            document.querySelectorAll('.st-cmp-app .st-switch[data-checked="true"] span.slider').forEach(el => { el.click(); });
            for ( const el of document.querySelectorAll('.st-cmp-app .st-text') ) {
                if ( /save\s*&?\s*exit/i.test(el.textContent || '') ) { el.click(); break; }
            }
        } catch {}
    
    },
    EVAL_DESIGNILPDPA_REJECT: function() {
        try {
            document.querySelectorAll('.dpdpa--popup input[type="checkbox"]:checked').forEach(cb => { cb.click(); });
            const save = document.querySelector('#pdpa_settings_confirm');
            if ( save ) { save.click(); }
        } catch {}
    
    },
    EVAL_HUBSPOT_REJECT: function() {
        try {
            const btn = document.querySelector('#hs-eu-decline-button');
            if ( btn ) { btn.click(); }
        } catch {}
    
    },
    EVAL_ADOPT_REJECT: function() {
        try {
            const btn = document.querySelector('#adopt-reject-all-button');
            if ( btn ) { btn.click(); }
        } catch {}
    
    },
    EVAL_ADROLL_REJECT: function() {
        try {
            const btn = document.querySelector('#adroll_consent_reject');
            if ( btn ) { btn.click(); }
        } catch {}
    
    },
    EVAL_WEBFLOW_REJECT: function() {
        try {
            const deny = document.querySelector('[fs-cc=banner] [fs-cc=deny]');
            if ( deny ) { deny.click(); return; }
            const banner = document.querySelector('[fs-cc=banner]');
            if ( banner ) { banner.style.setProperty('display', 'none', 'important'); }
        } catch {}
    
    },
    EVAL_WIX_REJECT: function() {
        try {
            const decline = document.querySelector('[data-hook=ccsu-banner-decline-all]');
            if ( decline ) { decline.click(); return; }
            const banner = document.querySelector('[data-hook=ccsu-banner-wrapper]');
            if ( banner ) { banner.style.setProperty('display', 'none', 'important'); }
        } catch {}
    
    },
    EVAL_TAGCONCIERGE_REJECT: function() {
        try {
            const direct = document.querySelector('#consent-banner-modal a[href="#reject"]');
            if ( direct ) { direct.click(); return; }
            const settings = document.querySelector('#consent-banner-modal a[href="#settings"]');
            if ( settings ) { settings.click(); }
            const reject = document.querySelector('#consent-banner-settings a[href="#reject"]');
            if ( reject ) { reject.click(); }
        } catch {}
    
    },
    EVAL_PRIVADO_REJECT: function() {
        try {
            const deny = document.querySelector('#cookie-consent-banner #deny-button');
            if ( deny ) { deny.click(); return; }
            const manage = document.querySelector('#cookie-consent-banner #manage-settings-button');
            if ( manage ) { manage.click(); }
            const save = document.querySelector('#manage-cookies #save-button');
            if ( save ) { save.click(); }
        } catch {}
    
    },
    EVAL_AXEPTIO_REJECT: function() {
        try {
            const wrapper = document.querySelector('.axeptio_mount .needsclick');
            if ( wrapper ) { wrapper.click(); }
            const dismiss = document.querySelector('button#axeptio_btn_dismiss,button.ax-discardButton');
            if ( dismiss ) { dismiss.click(); }
        } catch {}
    
    },
    EVAL_TERMSFEED_REJECT: function() {
        try {
            const direct = document.querySelector('.cc-nb-reject');
            if ( direct ) { direct.click(); return; }
            const openPrefs = document.querySelector('.cc-nb-changep');
            if ( openPrefs ) { openPrefs.click(); }
            document.querySelectorAll('input[cookie_consent_toggler="true"]:checked').forEach(cb => { cb.click(); });
            const save = document.querySelector('.cc-cp-foot-save');
            if ( save ) { save.click(); }
        } catch {}
    
    },
    EVAL_DATAGRAIL_REJECT: function() {
        try {
            const scope = document.querySelector('.dg-consent-banner');
            if ( !scope ) { return; }
            const direct = scope.querySelector('button.dg-button.reject_all, button.dg-button.accept_some');
            if ( direct ) { direct.click(); return; }
            if ( scope.querySelector('.dg-browser-signal-notice') ) {
                const openLayer = scope.querySelector('button.dg-button.open_layer');
                if ( openLayer ) {
                    openLayer.click();
                    const layerReject = scope.querySelector('button.dg-button.reject_all, button.dg-button.accept_some, button.dg-button.essential_only, button.dg-button.custom');
                    if ( layerReject ) { layerReject.click(); return; }
                }
                const close = scope.querySelector('button.dg-header-close');
                if ( close ) { close.click(); }
                return;
            }
            const openLayer = scope.querySelector('button.dg-button.open_layer');
            if ( openLayer ) {
                openLayer.click();
                const layerReject = scope.querySelector('button.dg-button.reject_all, button.dg-button.accept_some, button.dg-button.essential_only');
                if ( layerReject ) { layerReject.click(); }
            }
        } catch {}
    
    },
    EVAL_MOOVE_REJECT: function() {
        try {
            const btn = document.querySelector('.moove-gdpr-infobar-reject-btn');
            if ( btn ) { btn.click(); }
        } catch {}
    
    },
    EVAL_HIDE_ONLY: function() {
        // Intentionally empty: hiding is done by the bundle itself.
    
    },
    EVAL_GOOGLEFC_REJECT: function() {
        try {
            const btn = document.querySelector('.fc-consent-root .fc-cta-do-not-consent');
            if ( btn ) { btn.click(); }
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
        "action": "EVAL_ONETRUST_REJECT"
    },
    {
        "name": "Cookiebot",
        "detect": {
            "global": "Cookiebot",
            "selector": "#CybotCookiebotDialog"
        },
        "hideSelector": null,
        "action": "EVAL_COOKIEBOT_REJECT"
    },
    {
        "name": "Klaro",
        "detect": {
            "global": "klaro",
            "selector": ".klaro .cm-modal"
        },
        "hideSelector": null,
        "action": "EVAL_KLARO_REJECT"
    },
    {
        "name": "CookieYes",
        "detect": {
            "global": "CookieYes",
            "selector": "#cookie-law-info-bar, .cky-consent-container"
        },
        "hideSelector": null,
        "action": "EVAL_COOKIEYES_REJECT"
    },
    {
        "name": "Complianz",
        "detect": {
            "global": "complianz",
            "selector": "#cmplz-cookiebanner-container"
        },
        "hideSelector": null,
        "action": "EVAL_COMPLIANZ_REJECT"
    },
    {
        "name": "Osano",
        "detect": {
            "global": "Osano",
            "selector": ".osano-cm-dialog"
        },
        "hideSelector": null,
        "action": "EVAL_OSANO_REJECT"
    },
    {
        "name": "Termly",
        "detect": {
            "global": "displayPreferenceModal",
            "selector": "#termly-code-snippet-support"
        },
        "hideSelector": null,
        "action": "EVAL_TERMLY_REJECT"
    },
    {
        "name": "Didomi",
        "detect": {
            "global": "Didomi",
            "selector": "#didomi-host"
        },
        "hideSelector": null,
        "action": "EVAL_DIDOMI_REJECT"
    },
    {
        "name": "Sourcepoint",
        "detect": {
            "global": "_sp_",
            "selector": "[id^='sp_message_container_'], iframe[id^='sp_message_iframe_']"
        },
        "hideSelector": "[id^='sp_message_container_'], iframe[id^='sp_message_iframe_'], .message-overlay, .message-container",
        "action": "EVAL_SOURCEPOINT_REJECT"
    },
    {
        "name": "Fides",
        "detect": {
            "global": "Fides",
            "selector": "#fides-banner, #fides-modal, #fides-overlay"
        },
        "hideSelector": null,
        "action": "EVAL_FIDES_REJECT"
    },
    {
        "name": "Usercentrics",
        "detect": {
            "selector": "#usercentrics-root"
        },
        "hideSelector": null,
        "action": "EVAL_USERCENTRICS_REJECT"
    },
    {
        "name": "UserWay",
        "detect": {
            "selector": "#cookie_consent_banner_main_app"
        },
        "hideSelector": null,
        "action": "EVAL_USERWAY_REJECT"
    },
    {
        "name": "Shopify",
        "detect": {
            "selector": "#shopify-pc__banner"
        },
        "hideSelector": null,
        "action": "EVAL_SHOPIFY_REJECT"
    },
    {
        "name": "TrustArc",
        "detect": {
            "global": "truste",
            "selector": ".truste_popframe.trustarc_newcm_container"
        },
        "hideSelector": null,
        "action": "EVAL_TRUSTARC_REJECT"
    },
    {
        "name": "Quantcast Choice / InMobi CMP",
        "detect": {
            "global": "__cmp",
            "selector": "#qc-cmp2-container"
        },
        "hideSelector": null,
        "action": "EVAL_QUANTCAST_REJECT"
    },
    {
        "name": "iubenda",
        "detect": {
            "global": "_iub",
            "selector": "#iubenda-cs-banner"
        },
        "hideSelector": null,
        "action": "EVAL_IUBENDA_REJECT"
    },
    {
        "name": "ConsentManager",
        "detect": {
            "selector": "#ncmp__tool .ncmp__banner.ncmp__active"
        },
        "hideSelector": null,
        "action": "EVAL_CONSENTMANAGER_REJECT"
    },
    {
        "name": "Borlabs Cookie",
        "detect": {
            "global": "BorlabsCookie",
            "selector": "._brlbs-block-content, .brlbs-cmpnt-dialog, #BorlabsCookieBox"
        },
        "hideSelector": null,
        "action": "EVAL_BORLABS_REJECT"
    },
    {
        "name": "CookieFirst",
        "detect": {
            "selector": "#cookiefirst-root, .cookiefirst-root"
        },
        "hideSelector": null,
        "action": "EVAL_COOKIEFIRST_REJECT"
    },
    {
        "name": "Cookie Script",
        "detect": {
            "selector": "#cookiescript_injected"
        },
        "hideSelector": null,
        "action": "EVAL_COOKIESCRIPT_REJECT"
    },
    {
        "name": "Civic Cookie Control",
        "detect": {
            "selector": "#ccc-module, #ccc-notify"
        },
        "hideSelector": null,
        "action": "EVAL_CIVICCOOKIECONTROL_REJECT"
    },
    {
        "name": "Cookie Information",
        "detect": {
            "selector": "#cookie-information-template-wrapper"
        },
        "hideSelector": null,
        "action": "EVAL_COOKIEINFORMATION_REJECT"
    },
    {
        "name": "Ketch",
        "detect": {
            "selector": "#lanyard_root div[role='dialog'], #ketch-banner, #ketch-modal"
        },
        "hideSelector": null,
        "action": "EVAL_KETCH_REJECT"
    },
    {
        "name": "Real Cookie Banner",
        "detect": {
            "selector": "div[consent-skip-blocker=\"1\"][id][data-bg]"
        },
        "hideSelector": null,
        "action": "EVAL_REALCOOKIEBANNER_REJECT"
    },
    {
        "name": "Silktide",
        "detect": {
            "selector": "#silktide-wrapper, #silktide-banner"
        },
        "hideSelector": null,
        "action": "EVAL_SILKTIDE_REJECT"
    },
    {
        "name": "TYPO3 Cookieman",
        "detect": {
            "selector": "#cookieman-modal"
        },
        "hideSelector": null,
        "action": "EVAL_TYPO3COOKIEMAN_REJECT"
    },
    {
        "name": "tarteaucitron.js",
        "detect": {
            "selector": "#tarteaucitronRoot, #tarteaucitronAlertBig, #tarteaucitronAlertSmall"
        },
        "hideSelector": null,
        "action": "EVAL_TARTEAUCITRON_REJECT"
    },
    {
        "name": "Piwik PRO Consent Manager",
        "detect": {
            "selector": "#ppms_cm_popup_overlay, #ppms_cm_bar_overlay"
        },
        "hideSelector": null,
        "action": "EVAL_PIWIKPRO_REJECT"
    },
    {
        "name": "GDPR Modal",
        "detect": {
            "selector": "#gdpr-modal #gdpr-consent-content"
        },
        "hideSelector": null,
        "action": "EVAL_GDPRMODAL_REJECT"
    },
    {
        "name": "Drupal EU Cookie Compliance",
        "detect": {
            "selector": ".eu-cookie-compliance-banner"
        },
        "hideSelector": null,
        "action": "EVAL_DRUPALEUCC_REJECT"
    },
    {
        "name": "Evidon",
        "detect": {
            "selector": ".footer .evidon-footer-image"
        },
        "hideSelector": null,
        "action": "EVAL_EVIDON_REJECT"
    },
    {
        "name": "ST CMP v2",
        "detect": {
            "selector": "#st-cmp-v2, .st-cmp-app"
        },
        "hideSelector": null,
        "action": "EVAL_STCMPV2_REJECT"
    },
    {
        "name": "DPDPA-style consent popup (Thai market)",
        "detect": {
            "selector": ".dpdpa--popup"
        },
        "hideSelector": null,
        "action": "EVAL_DESIGNILPDPA_REJECT"
    },
    {
        "name": "HubSpot",
        "detect": {
            "selector": "#hs-eu-cookie-confirmation"
        },
        "hideSelector": null,
        "action": "EVAL_HUBSPOT_REJECT"
    },
    {
        "name": "Adopt",
        "detect": {
            "selector": "#adopt-controller-button"
        },
        "hideSelector": null,
        "action": "EVAL_ADOPT_REJECT"
    },
    {
        "name": "AdRoll",
        "detect": {
            "selector": "#adroll_consent_container"
        },
        "hideSelector": null,
        "action": "EVAL_ADROLL_REJECT"
    },
    {
        "name": "Webflow",
        "detect": {
            "selector": ".fs-cc-components, [fs-cc=banner]"
        },
        "hideSelector": null,
        "action": "EVAL_WEBFLOW_REJECT"
    },
    {
        "name": "Wix",
        "detect": {
            "selector": "[data-comp-type=cookie-banner-root-wix], [data-hook=ccsu-banner-wrapper]"
        },
        "hideSelector": null,
        "action": "EVAL_WIX_REJECT"
    },
    {
        "name": "TagConcierge",
        "detect": {
            "selector": "#consent-banner-main"
        },
        "hideSelector": null,
        "action": "EVAL_TAGCONCIERGE_REJECT"
    },
    {
        "name": "Privado",
        "detect": {
            "selector": "#cookie-consent-banner #accept-button"
        },
        "hideSelector": null,
        "action": "EVAL_PRIVADO_REJECT"
    },
    {
        "name": "Axeptio",
        "detect": {
            "selector": ".axeptio_widget, .axeptio_mount"
        },
        "hideSelector": null,
        "action": "EVAL_AXEPTIO_REJECT"
    },
    {
        "name": "TermsFeed",
        "detect": {
            "selector": ".termsfeed-com---nb"
        },
        "hideSelector": null,
        "action": "EVAL_TERMSFEED_REJECT"
    },
    {
        "name": "DataGrail",
        "detect": {
            "selector": ".dg-consent-banner"
        },
        "hideSelector": null,
        "action": "EVAL_DATAGRAIL_REJECT"
    },
    {
        "name": "Moove GDPR",
        "detect": {
            "selector": "#moove_gdpr_cookie_info_bar"
        },
        "hideSelector": null,
        "action": "EVAL_MOOVE_REJECT"
    },
    {
        "name": "XenForo",
        "detect": {
            "selector": ".notice.notice--cookieAdvanced[data-notice-id=\"-1\"]"
        },
        "hideSelector": ".notice.notice--cookieAdvanced[data-notice-id=\"-1\"]",
        "action": "EVAL_HIDE_ONLY"
    },
    {
        "name": "Sirdata",
        "detect": {
            "selector": "#sd-cmp"
        },
        "hideSelector": "#sd-cmp",
        "action": "EVAL_HIDE_ONLY"
    },
    {
        "name": "Transcend",
        "detect": {
            "selector": "#transcend-consent-manager"
        },
        "hideSelector": "#transcend-consent-manager",
        "action": "EVAL_HIDE_ONLY"
    },
    {
        "name": "Google Funding Choices",
        "detect": {
            "selector": ".fc-consent-root"
        },
        "hideSelector": ".fc-consent-root",
        "action": "EVAL_GOOGLEFC_REJECT"
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
