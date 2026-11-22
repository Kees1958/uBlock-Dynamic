// ── cookie-banner-action.js ──────────────────────────────────────────────────
// (10.7.1, owner's decision) The ONE place that decides what Seamless surfing does with a cookie banner, as the person
// chose in the Seamless surfing prompt (js/scripting/worry-free-picker.js). Stored as one securityConfig key;
// independent of every cookie clean-up setting. Also used when a session starts by itself at browser start (no prompt
// then): the last choice applies.
// (11.0.0, owner's decision 2026-11-19) Three modes; the new default PREFER_ACCEPT — "accept, else decline": per site
// accept where uBD has an accept rule, decline otherwise (js/data/cookie-notice-sets.js has what each mode runs). The
// generic click bundle accepts in that mode; the Sourcepoint loader block stays DECLINE-only. A Cookie consent clicker
// rule the person saves for a site overrides every mode on that site.
//
// Public interface:
//   COOKIE_BANNER_ACTIONS             — the three modes (frozen enum; PREFER_ACCEPT is the default)
//   DEFAULT_COOKIE_BANNER_ACTION      — (11.0.0) the default mode, also for an unknown stored value
//   COOKIE_BANNER_BUNDLES             — mode -> the generated MAIN-world bundle that performs it
//   COOKIE_BANNER_SETTING_KEY         — the securityConfig key holding the choice
//   isCookieBannerAction(value)       — input guard for a choice arriving in a message (C6)
//   cookieBannerActionFor(config)     — securityConfig -> mode (an unknown stored value reads as DECLINE)
//   cookieBannerBundleFor(config)     — securityConfig -> bundle path
//
// Read by: js/core/scripting-manager.js (session registration), js/workflow/cookie-clicker-routes.js (immediate
//   apply on the current tab, saving the choice, the popup's hover text).
// Bundle paths must match tools/build-autodeny-bundle.mjs BUNDLES (proven by tools/check-autoconsent-cmp-consistency.mjs).
//
// Pure data + pure functions: no imports, no state — nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────

export const COOKIE_BANNER_ACTIONS = Object.freeze({
    PREFER_ACCEPT: 'prefer-accept',
    ACCEPT:        'accept',
    DECLINE:       'decline',
});

// The mode an unknown or missing stored value reads as (and the default in js/data/config.js).
export const DEFAULT_COOKIE_BANNER_ACTION = COOKIE_BANNER_ACTIONS.PREFER_ACCEPT;

const ACCEPT_BUNDLE = '/js/scripting/autoaccept-snippets.generated.js';
export const COOKIE_BANNER_BUNDLES = Object.freeze({
    [COOKIE_BANNER_ACTIONS.PREFER_ACCEPT]: ACCEPT_BUNDLE,   // generic CMPs: the bundle accepts; site rules decide the rest
    [COOKIE_BANNER_ACTIONS.ACCEPT]:        ACCEPT_BUNDLE,
    [COOKIE_BANNER_ACTIONS.DECLINE]:       '/js/scripting/autodeny-snippets.generated.js',
});

// The securityConfig key holding the person's choice (default in js/data/config.js).
export const COOKIE_BANNER_SETTING_KEY = 'seamlessCookieBannerAction';

export function isCookieBannerAction(value) {
    return Object.values(COOKIE_BANNER_ACTIONS).includes(value);
}

export function cookieBannerActionFor(config) {
    const stored = config?.[COOKIE_BANNER_SETTING_KEY];
    return isCookieBannerAction(stored) ? stored : DEFAULT_COOKIE_BANNER_ACTION;
}

export function cookieBannerBundleFor(config) {
    return COOKIE_BANNER_BUNDLES[cookieBannerActionFor(config)];
}
