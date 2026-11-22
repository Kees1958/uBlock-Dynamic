/*
 * eval-snippets.js — Vendored, pinned "reject all" action functions.
 *
 * NOT a fork of duckduckgo/autoconsent (design doc D1/D2) — a starter
 * subset covering common CMPs, authored directly against each CMP's
 * documented/observable public reject-all behavior. Used as DATA ONLY:
 * tools/build-autodeny-bundle.mjs reads the `FNS` object below and
 * inlines it, verbatim, into js/scripting/autodeny-snippets.generated.js
 * alongside the hostname/CMP dispatch table derived from
 * vendor/autoconsent/rules/rules.json — see that file's own header for
 * how the two are kept in sync. This stays a build-time data source,
 * never a runtime-reachable "eval one of these by name" channel.
 *
 * LICENSE — see THIRD_PARTY_LICENSES.md and vendor/autoconsent/rules/
 * rules.json's own `_provenance` field: MIXED, per-entry. Of the
 * original 26, 11 rule entries were adapted from duckduckgo/autoconsent's
 * real code (MPL-2.0 applies); 15 are independently hand-authored (it
 * does not) — corrected from an earlier, miscounted 12/14 split (see
 * THIRD_PARTY_LICENSES.md for the correction note). Batches added since
 * (Consent-O-Matic, DDG batch 4) are additional to this original 26.
 * The "NOT a fork" line above is accurate at the whole-file level but
 * doesn't capture that per-entry split — vendor/autoconsent/LICENSE
 * exists for the MPL-2.0-covered subset, per MPL-2.0 §3.1's own
 * directory-level-notice allowance.
 *
 * Every function below must be self-contained (no closures over anything
 * outside itself) and safe to call blind/unattended, repeatedly, on any
 * page where its CMP's detection signature matched — each wraps its own
 * DOM/API access in try/catch and simply no-ops if the expected
 * button/API isn't present, exactly like DDG's own upstream snippets do.
 */

const FNS = {

    // FIX (8.2.15): every function below now ALSO carries the same
    // generic, regex-based text fallback Sourcepoint/Fides already
    // proved necessary (8.2.13/8.2.12) — a hardcoded selector alone will
    // always be one un-covered publisher deployment away from silently
    // doing nothing, and until now only 2 of 10 CMPs here had any
    // recourse when that happened. Each fallback is scoped to search
    // ONLY within that CMP's own known container (its `detect.selector`
    // from rules.json), never the whole document — same reasoning
    // EVAL_FIDES_REJECT's own comment already gives: an unscoped search
    // risks clicking an unrelated "Reject"-labeled control elsewhere on
    // the page. Same canonical phrase pattern used everywhere for
    // consistency: /\breject\b|\bdisagree\b|\bdecline\b|\bopt.?out\b|do
    // not (consent|agree|accept)/i — duplicated inline in each function
    // rather than shared via an outer const, because
    // tools/build-autodeny-bundle.mjs's own extraction only captures
    // each function's OWN body text (see that script's own header) —
    // every function here must stay fully self-contained.

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

    // Sourcepoint (window._sp_) — used widely by major US publishers,
    // including NBCUniversal properties (nbcnews.com, today.com, cnbc.com)
    // and confirmed on BBC.com — added after a real reported failure on
    // nbcnews.com; this CMP was simply absent from the earlier starter
    // set entirely, not a broken selector.
    //
    // Sourcepoint's actual reject button carries the `sp_choice_type_
    // REJECT_ALL` class in its own generated markup (a documented,
    // stable Sourcepoint convention across publisher-configured
    // campaigns, unlike the surrounding banner's own per-publisher
    // custom styling/text) — tried first. The banner itself commonly
    // renders inside a same-origin-to-itself iframe
    // (`iframe#sp_message_iframe_*`, hosted on Sourcepoint's own
    // `privacy-mgmt.com`); this function runs per-frame (allFrames:true
    // at the registration level — see js/core/scripting-manager.js),
    // so when it runs INSIDE that iframe's own document, the selector
    // matches directly with no cross-frame reach needed.
    //
    // FIX (8.2.13): the text-based fallback used to be an EXACT-MATCH
    // list ('reject all' / 'reject all cookies' / 'i do not consent')
    // — real report: BBC.com runs Sourcepoint (confirmed via
    // window._sp_) but its own custom-configured button reads "I do not
    // agree", which that exact-match list simply never covered. Every
    // publisher configures Sourcepoint's own button copy independently,
    // so an exact-match list will always be one un-covered phrasing away
    // from the next real failure — replaced with a regex covering the
    // common REJECT-shaped phrasings instead (same approach
    // EVAL_FIDES_REJECT below already uses for its own disambiguation).
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

    // Fides (Ethyca) — confirmed present on nytimes.com (real report, not
    // guessed). Real quirk, confirmed against an actual Fides banner
    // sample: the "Opt out of all" (reject) and "Opt in to all" (accept)
    // buttons share the EXACT SAME id ('fides-banner-button-primary')
    // and class ('fides-banner-button fides-banner-button-primary') —
    // there is no stable, distinct selector for "the reject one"
    // specifically. Disambiguated by button TEXT/data-testid instead
    // (same fallback strategy already used for OneTrust/Sourcepoint),
    // scoped to inside the banner/modal container specifically so this
    // never accidentally matches an unrelated button elsewhere on the
    // page that happens to contain the word "reject".
    // (10.7.16, owner's decision 2026-11-19) DECLINE by HIDING ONLY — for a
    // CMP whose reject control cannot be clicked safely unattended. Real
    // report: XenForo forums (malwaretips.com) — its reject link navigates
    // away and back, and a saved click rule looped on it. XenForo consent is
    // opt-in, so a notice left unanswered already means essential cookies
    // only: the decline bundle's own hideBannerContainer() (run right after
    // this) removes the notice, no click, no reload. Accept mode does the
    // same for such a CMP through its rule's accept.hideOnly flag (see
    // EVAL_ACCEPT_ALL) — the owner's decision: XenForo is always declined.
    EVAL_HIDE_ONLY: function() {
        // Intentionally empty: hiding is done by the bundle itself.
    },
    // (11.0.0, owner's report 2026-11-19: bbc.com) Google Funding Choices — Google's own consent dialog (an IAB TCF CMP),
    // shown by bbc.com to EU visitors and by thousands of AdSense / Ad Manager sites. Selectors from DuckDuckGo
    // autoconsent's fundingchoices.json. Its first-layer "Do not consent" button is clicked when the site offers it;
    // DDG's fallback ("Manage options" -> untick -> "Confirm choices") is a multi-step chain across a dialog that opens
    // asynchronously, so it is NOT run unattended here: without the button the bundle's own hideBannerContainer() (run
    // right after this) hides the dialog, and an unanswered TCF dialog means no consent.
    EVAL_GOOGLEFC_REJECT: function() {
        try {
            const btn = document.querySelector('.fc-consent-root .fc-cta-do-not-consent');
            if ( btn ) { btn.click(); }
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

    // Usercentrics — confirmed present on siemens.com (real Inspect-
    // element evidence, not guessed): a custom element
    // '#usercentrics-root' with an OPEN shadow root containing the
    // actual banner UI. This is the FIRST CMP in this vendored set that
    // genuinely needs shadow-DOM-aware traversal for its own reject
    // ACTION (not just the manual picker, which already got this fix in
    // 8.2.11) — plain document.querySelector() cannot see past a shadow
    // boundary at all, open or closed. Safe to reach through here
    // specifically because the root is OPEN (confirmed in the same
    // Inspect-element evidence: '#shadow-root (open)') — `.shadowRoot`
    // returns a real, usable reference for an open root; it would
    // return null for a closed one, same limitation
    // cookie-clicker-click.js's own resolveRuleScope() already documents
    // for the manual-picker/replay side of this same distinction.
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

    // UserWay — confirmed present on global.fujitsu/en-global (real
    // Inspect-element evidence, not guessed). Primarily known as an
    // accessibility-overlay widget provider (cdn.userway.org), but also
    // ships a cookie-consent banner as part of the same suite — a Vue.js
    // app rooted at '#cookie_consent_banner_main_app' (plain light DOM,
    // no shadow root, unlike Usercentrics just above). The reject button
    // carries a genuinely stable, semantic attribute —
    // data-search-key-button="reject_all_text" — rather than a
    // styling-coupled class name, a stronger signal than most of the
    // other CMPs in this set get to rely on.
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

    // Shopify's own NATIVE Customer Privacy cookie banner — not a
    // third-party CMP at all, built directly into Shopify's storefront
    // platform (Settings > Customer privacy > Cookie banner). Real,
    // confirmed selector for the Accept button
    // ('#shopify-pc__banner__btn-accept') found via a live Shopify
    // support thread showing working custom CSS targeting that exact
    // id; the Decline button follows the same documented naming
    // convention — CONFIRMED correct via real Inspect-element evidence
    // (store.pirelli.com) after initially being written from the naming
    // pattern alone.
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

    // ===== ddg-autoconsent-derived entries (8.2.25) =====
    // The functions below are ADAPTED — not copy-pasted — from
    // duckduckgo/autoconsent's own real, tested rule definitions
    // (github.com/duckduckgo/autoconsent, commit
    // 9e4e640df401bb68c7e70d520d1174c133d20658, MPL-2.0). That project
    // expresses each rule as a declarative JSON step-sequence (its own
    // small automation DSL: waitForThenClick, if/then/else branches,
    // xpath text matching across many languages, etc.); each function
    // here is a hand-translated, often DELIBERATELY SIMPLIFIED plain-JS
    // equivalent covering the common path(s), not a mechanical port of
    // every branch DDG's own rule handles — see rules.json's own
    // `_source` field on each entry for exactly which upstream rule file
    // it came from and what was simplified away. Same "vendored as data,
    // adapted into this project's own execution model" posture the
    // header of this file already establishes for the hand-authored
    // entries above; see rules.json's own `_provenance` field for the
    // full attribution statement.

    // TrustArc (upgraded from detection-only, 8.2.24) — real container/
    // button pair straight from DDG's trustarc-newcm.json: the reject
    // link carries class "required" (the accept link carries "call"),
    // both scoped inside the CMP's own named container class.
    EVAL_TRUSTARC_REJECT: function() {
        try {
            const container = document.querySelector('.truste_popframe.trustarc_newcm_container') || document;
            const btn = container.querySelector('a.required');
            if ( btn ) { btn.click(); }
        } catch {}
    },

    // Quantcast Choice / InMobi CMP (upgraded from detection-only,
    // 8.2.24) — simplified from DDG's own considerably more elaborate
    // multi-step rule (quantcast.json): tries the simple '#disagree-btn'
    // case first, then the two-secondary-button summary screen, then
    // falls back to a delayed text-match for a "reject all"-shaped
    // button in common languages (DDG's own rule enumerates many more
    // languages/edge cases than reproduced here).
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

    // iubenda (upgraded from detection-only, 8.2.24) — real one-click
    // reject class straight from DDG's iubenda.json
    // ('.iubenda-cs-reject-btn'), something this session's own earlier
    // web research never surfaced. Falls back to opening the customize
    // panel when that class isn't present (DDG's own rule then
    // continues into a multi-step panel-reject flow; simplified here to
    // just opening the panel, since the generic reject-phrase fallback
    // below would then still apply on a later retry pass).
    EVAL_IUBENDA_REJECT: function() {
        try {
            const btn = document.querySelector('.iubenda-cs-reject-btn');
            if ( btn ) { btn.click(); return; }
            const customize = document.querySelector('.iubenda-cs-customize-btn');
            if ( customize ) { customize.click(); }
        } catch {}
    },

    // ConsentManager (new, 8.2.25) — this session's own web research
    // found real config-API evidence but no working reject action; DDG's
    // consentmanager-ncmp.json confirms a genuine, simple JS API:
    // window.__npcmp('reject'). Falls back to the older __cmp API
    // (setConsent(0)) some deployments may still use.
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

    // Borlabs Cookie (new, 8.2.25) — this session's own web research
    // confirmed the global (window.BorlabsCookie) and container but not
    // a reject selector; DDG's borlabs.json supplies the real one.
    EVAL_BORLABS_REJECT: function() {
        try {
            const btn = document.querySelector('.brlbs-btn-accept-only-essential, a[data-cookie-refuse]');
            if ( btn ) { btn.click(); return; }
            const save = document.querySelector('.brlbs-btn-save, #CookieBoxSaveButton');
            if ( save ) { save.click(); }
        } catch {}
    },

    // CookieFirst (new, 8.2.25) — DDG's cookiefirst.json shows a direct
    // one-click reject in the common case, falling back to opening the
    // "adjust" panel, unchecking every enabled toggle, and saving.
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

    // Cookie Script (new, 8.2.25) — DDG's cookie-script.json shows a
    // direct one-click reject in the common case, falling back to
    // opening the manage panel first.
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

    // Civic Cookie Control (new, 8.2.25) — DDG's civic-cookie-
    // control.json shows a direct one-click reject in the common case,
    // falling back to the dismiss button (DDG's own rule also handles
    // an intermediate "open settings" step, simplified away here).
    EVAL_CIVICCOOKIECONTROL_REJECT: function() {
        try {
            const btn = document.querySelector('.ccc-reject-button');
            if ( btn ) { btn.click(); return; }
            const dismiss = document.querySelector('#ccc-dismiss-button');
            if ( dismiss ) { dismiss.click(); }
        } catch {}
    },

    // Cookie Information (new, 8.2.25) — real JS API straight from
    // DDG's cookieinformation.json (CookieInformation.
    // declineAllCategories()). This session's own web research
    // separately found real, confirmed CSS classes for this same CMP
    // (.coi-banner__decline / .coi-banner__accept, from their own
    // production CSS) — the API call is used instead since it's more
    // direct/reliable than a DOM click, but the class names are real too
    // if a future fallback is ever needed here.
    EVAL_COOKIEINFORMATION_REJECT: function() {
        try {
            if ( typeof window.CookieInformation?.declineAllCategories === 'function' ) {
                window.CookieInformation.declineAllCategories();
            }
        } catch {}
    },

    // Ketch (new, 8.2.25) — significantly simplified from DDG's own
    // considerably more elaborate ketch.json (which handles many more
    // aria-label/class-name variants and an intermediate "disclosure-
    // only banner" case). Covers the common banner-level reject button
    // and the preferences-modal reject-all/uncheck-all+confirm fallback.
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

    // Real Cookie Banner (new, 8.2.25) — this session's own web research
    // found only tutorials, no real markup at all; DDG's real-cookie-
    // banner.json was the only real evidence found for this CMP. Its own
    // container structure has no stable class names at all (WordPress
    // plugin generates near-opaque wrapper divs), so both detection and
    // this action rely on the same structural attribute selector DDG's
    // rule uses, disambiguating reject-vs-accept by text content (the
    // accept link carries an [id], the reject one deliberately does not,
    // per DDG's own rule) plus a language-aware text match.
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

    // Silktide (new, 8.2.25) — genuinely open source
    // (github.com/silktide/consent-manager), confirmed via multiple
    // independent real production deployments (several UK university/
    // government sites, all matching the same '#silktide-wrapper' /
    // '#silktide-banner' / '.st-button' structure) plus Silktide's own
    // public config schema, which documents the real default reject
    // button text ('Reject non-essential') — though that text is
    // configurable per deployment, same risk every text-matched CMP in
    // this set already carries, hence the shared regex fallback too.
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

    // TYPO3 Cookieman (new, 8.4.7) — consent-o-matic's typo3cookieman.json
    // shows per-category checkboxes (marketing/videos) + a save button, no
    // single-click reject shortcut. Uncheck-if-checked (not a blind click,
    // to avoid the opposite mistake of CHECKING an already-unchecked box)
    // then save — same simplification approach as this file's own
    // Cookiebot/CookieFirst-style multi-step entries above.
    EVAL_TYPO3COOKIEMAN_REJECT: function() {
        try {
            document.querySelectorAll('#cookieman-modal input[type="checkbox"]').forEach(cb => {
                if ( cb.checked ) { cb.click(); }
            });
            const save = document.querySelector('#cookieman-modal .save-button');
            if ( save ) { save.click(); }
        } catch {}
    },

    // tarteaucitron.js (new, 8.4.7) — consent-o-matic's tarteaucitron.json
    // shows all 9 of its own consent categories using the exact same pair
    // of class names (.tarteaucitronAllow / .tarteaucitronDeny), just
    // scoped to a different container per category — so clicking every
    // .tarteaucitronDeny on the page (not category-by-category) is a
    // faithful simplification, not a guess.
    EVAL_TARTEAUCITRON_REJECT: function() {
        try {
            document.querySelectorAll('#tarteaucitronRoot .tarteaucitronDeny').forEach(btn => { btn.click(); });
            const save = document.querySelector('.tarteaucitronValidate, .tarteaucitronClosePanel, #tarteaucitronClosePanel');
            if ( save ) { save.click(); }
        } catch {}
    },

    // Piwik PRO Consent Manager (new, 8.4.7) — consent-o-matic's
    // piwikproconsent.json shows 4 named toggle switches (analytics,
    // remarketing, feedback, custom_consent), all stable IDs. Same
    // uncheck-if-checked safety as TYPO3 Cookieman above.
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

    // "GDPR Modal" (new, 8.4.7) — consent-o-matic's gdprmodal.json lists 9
    // named per-service checkboxes (#gdpr-service-twitter, -facebook,
    // -taboola, -nativo, -blueconic, -realm, -parsely, -google-analytics,
    // -chartbeat). Generalized to an attribute-prefix selector
    // (`[id^="gdpr-service-"]`) instead of hardcoding all 9 individually —
    // more robust against a future site adding an unlisted 10th service
    // under the same naming convention, and avoids silently missing one
    // if consent-o-matic's own list is incomplete.
    EVAL_GDPRMODAL_REJECT: function() {
        try {
            document.querySelectorAll('#gdpr-modal input[id^="gdpr-service-"]').forEach(cb => {
                if ( cb.checked ) { cb.click(); }
            });
            const save = document.querySelector('#continue');
            if ( save ) { save.click(); }
        } catch {}
    },

    // Drupal EU Cookie Compliance module (new, 8.4.7) — consent-o-matic's
    // drupalEUCC.json lists 5 named checkbox groups (#cookie-category-
    // functional/-preference/-statistics/-analytics/-social/-advertising),
    // same attribute-prefix generalization as GDPR Modal above.
    EVAL_DRUPALEUCC_REJECT: function() {
        try {
            document.querySelectorAll('.eu-cookie-compliance-banner input[id^="cookie-category-"]').forEach(cb => {
                if ( cb.checked ) { cb.click(); }
            });
            const save = document.querySelector('.eu-cookie-compliance-save-preferences-button');
            if ( save ) { save.click(); }
        } catch {}
    },

    // Evidon (new, 8.4.7) — consent-o-matic's evidon_iframe.json finds
    // each category by matching English text ("Advertising", "Functional",
    // etc.) inside .category-header before toggling that category's own
    // img.category-check.checked. Simplified here to toggle EVERY checked
    // category on the page instead of text-matching specific ones — same
    // "blanket uncheck-all" simplification as GDPR Modal/Drupal EUCC
    // above, and avoids the language-dependency a textFilter-based
    // translation would carry (Evidon deployments aren't all English).
    EVAL_EVIDON_REJECT: function() {
        try {
            document.querySelectorAll('img.category-check.checked').forEach(el => { el.click(); });
            const save = document.querySelector('button#apply-button');
            if ( save ) { save.click(); }
        } catch {}
    },

    // "ST CMP" v2 (new, 8.4.7) — consent-o-matic's stcmpv2.json also
    // text-matches specific category labels before toggling each
    // .st-switch via [data-checked='true']. Same blanket-uncheck
    // simplification as Evidon above: toggle every currently-checked
    // switch, then Save & Exit.
    EVAL_STCMPV2_REJECT: function() {
        try {
            document.querySelectorAll('.st-cmp-app .st-switch[data-checked="true"] span.slider').forEach(el => { el.click(); });
            for ( const el of document.querySelectorAll('.st-cmp-app .st-text') ) {
                if ( /save\s*&?\s*exit/i.test(el.textContent || '') ) { el.click(); break; }
            }
        } catch {}
    },

    // Thai-market DPDPA-style consent popup (new, 8.4.7) — consent-o-
    // matic's designilpdpa.json (the file's own name suggests India's
    // DPDPA, but the actual detector/consent text inside is Thai —
    // confirmed by inspecting the real content, not assumed from the
    // filename) — same text-matched-category pattern, same blanket
    // uncheck-all simplification.
    EVAL_DESIGNILPDPA_REJECT: function() {
        try {
            document.querySelectorAll('.dpdpa--popup input[type="checkbox"]:checked').forEach(cb => { cb.click(); });
            const save = document.querySelector('#pdpa_settings_confirm');
            if ( save ) { save.click(); }
        } catch {}
    },

    // ─────────────────────────────────────────────────────────────────
    // Batch 4 (8.4.9) — sourced from duckduckgo/autoconsent's own
    // rules/autoconsent/*.json (fetched from the `main` branch;
    // GitHub's commit API was rate-limited at fetch time, so this is
    // dated rather than commit-pinned like the original 11 — see
    // THIRD_PARTY_LICENSES.md; corrected from an earlier "12", a
    // miscount that also affected the "10" below, corrected to 11).
    // DDG's own step-sequence format (detectCmp/optOut) translated
    // directly into this file's plain-function style, same as the
    // original 11. All eleven below passed a bulk scan (real optOut
    // action present, no CSS-hash-style fragile selectors) before being
    // individually inspected.
    // ─────────────────────────────────────────────────────────────────

    // HubSpot (new, 8.4.9) — single stable-ID reject button, no fallback needed.
    EVAL_HUBSPOT_REJECT: function() {
        try {
            const btn = document.querySelector('#hs-eu-decline-button');
            if ( btn ) { btn.click(); }
        } catch {}
    },

    // Adopt (new, 8.4.9) — single stable-ID reject button.
    EVAL_ADOPT_REJECT: function() {
        try {
            const btn = document.querySelector('#adopt-reject-all-button');
            if ( btn ) { btn.click(); }
        } catch {}
    },

    // AdRoll (new, 8.4.9) — single stable-ID reject button.
    EVAL_ADROLL_REJECT: function() {
        try {
            const btn = document.querySelector('#adroll_consent_reject');
            if ( btn ) { btn.click(); }
        } catch {}
    },

    // Webflow (new, 8.4.9) — Webflow's own built-in cookie-consent
    // component, ships on any Webflow-built site that enables it.
    // DDG's own fallback (no deny button found) is to just hide the
    // banner cosmetically, not click anything — mirrored here as-is,
    // since that's genuinely the correct behavior for that branch, not
    // a simplification.
    EVAL_WEBFLOW_REJECT: function() {
        try {
            const deny = document.querySelector('[fs-cc=banner] [fs-cc=deny]');
            if ( deny ) { deny.click(); return; }
            const banner = document.querySelector('[fs-cc=banner]');
            if ( banner ) { banner.style.setProperty('display', 'none', 'important'); }
        } catch {}
    },

    // Wix (new, 8.4.9) — Wix's own built-in cookie-consent banner,
    // ships on any Wix-built site that enables it. Same
    // click-or-else-hide pattern as Webflow above.
    EVAL_WIX_REJECT: function() {
        try {
            const decline = document.querySelector('[data-hook=ccsu-banner-decline-all]');
            if ( decline ) { decline.click(); return; }
            const banner = document.querySelector('[data-hook=ccsu-banner-wrapper]');
            if ( banner ) { banner.style.setProperty('display', 'none', 'important'); }
        } catch {}
    },

    // TagConcierge (new, 8.4.9) — direct reject link if visible, else
    // open settings then reject from there.
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

    // Privado (new, 8.4.9) — direct deny button if present, else open
    // manage-settings and save (which defaults to the minimal/denied
    // state without needing any checkbox toggling).
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

    // Axeptio (new, 8.4.9) — DDG's own rule waits for the widget's
    // "needsclick" wrapper before clicking the dismiss button in some
    // deployments, and clicks the dismiss button directly in others.
    // Simplified to: click the wrapper if present (harmless if it's not
    // actually needed), then always try the dismiss button.
    EVAL_AXEPTIO_REJECT: function() {
        try {
            const wrapper = document.querySelector('.axeptio_mount .needsclick');
            if ( wrapper ) { wrapper.click(); }
            const dismiss = document.querySelector('button#axeptio_btn_dismiss,button.ax-discardButton');
            if ( dismiss ) { dismiss.click(); }
        } catch {}
    },

    // TermsFeed (new, 8.4.9) — direct reject button if present, else
    // open the preferences panel, uncheck every currently-checked
    // optional toggle, and save.
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

    // DataGrail (new, 8.4.9) — nested fallback chain, all stable
    // class-based selectors scoped within .dg-consent-banner. Tries the
    // direct reject/accept-some button, then the "browser signal
    // detected, just close" case, then falls back to opening the
    // preferences layer and rejecting from there.
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

    // Moove (new, 8.4.9) — DIRECT PATH ONLY. DDG's own rule has a
    // fallback branch (open settings modal → toggle checkboxes via
    // their own EVAL_MOOVE_0 helper → save) that depends on JS logic
    // defined elsewhere in DDG's codebase, not visible in this rule
    // file alone — simplified away, same "not every edge case" approach
    // already used for this file's earlier DDG-derived entries. Only
    // the direct one-click reject path is implemented; sites that only
    // offer the settings-modal path aren't handled by this entry.
    EVAL_MOOVE_REJECT: function() {
        try {
            const btn = document.querySelector('.moove-gdpr-infobar-reject-btn');
            if ( btn ) { btn.click(); }
        } catch {}
    },

    // ── ACCEPT (10.7.1, owner's decision) ───────────────────────────────────
    // ONE data-driven function for every CMP, used only by the ACCEPT bundle
    // (js/scripting/autoaccept-snippets.generated.js) — which is registered
    // instead of the decline bundle while the person deletes cookies at every
    // browser start (js/data/cookie-banner-action.js). Data per CMP lives in
    // rules.json's `accept` field:
    //   api       — OPTIONAL key into ACCEPT_APIS below: the CMP's own documented
    //               "accept all" call, tried first (most reliable, no DOM).
    //   selectors — the CMP's own accept-all button(s), most specific first.
    //   scope     — 'banner' (default): every DOM search stays INSIDE the CMP's
    //               own root (rule.hideSelector || rule.detect.selector, plus an
    //               open shadowRoot of it); 'document': whole document, ONLY for
    //               CMPs whose banner is its own iframe (Sourcepoint) — same
    //               scope the decline function for that CMP already uses.
    // Text fallback: an EXACT-label match (ACCEPT_LABEL_RE is anchored ^…$), so a
    // longer label such as "Accept only necessary" never matches. Self-contained
    // (no closures over this file), safe to call blind: every access guarded.
    // NOTE: no quote characters inside the regex literal — the bundle builder's
    // brace scanner reads them as string openers (j\u0027accepte is escaped for that).
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

// Node/build-script consumption only — never shipped as-is (the build
// script inlines FNS's function bodies directly into the generated
// bundle; this export exists purely so build-autodeny-bundle.mjs can
// `import` this file under Node without a bundler).
export { FNS };
