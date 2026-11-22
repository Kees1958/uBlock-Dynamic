// ── cookie-notice-sets.js ────────────────────────────────────────────────────
// (11.0.0, owner's decisions 2026-11-19) Seamless surfing's site-specific cookie-notice handling — the ONE place
// for the names the build (tools/build/cookie-notice-sources.mjs, cookie-notice-write.mjs) and the runtime
// (js/core/scripting-manager.js, js/core/cmp-loader-block-manager.js) share.
//
// Three stages, built in this order, each skipping the sites an earlier stage already answers:
//   1. AdGuard Cookie Notices (cookies_specific)  — scriptlets split into ACCEPT and DECLINE; its hide and block rules
//      are decline rules. Its sites per mode form the stage-1 domain set.
//   2. EasyList Cookie uBO (easylist_cookie_specific_uBO) — scriptlets for sites NOT in that set, only for CMPs uBD's
//      own click bundle does not handle, split the same way.
//   3. EasyList Cookie specific hide + specific block — decline rules, sites not in the stage-1 decline set.
// What each Seamless surfing mode (js/data/cookie-banner-action.js) gets — COOKIE_NOTICE_MODE_FILES:
//   decline        — the decline scriptlets + every decline hide and block rule;
//   accept         — the accept scriptlets, no hide or block rule;
//   prefer-accept  — (11.0.0, "accept, else decline") per site its accept scriptlets, else its decline ones; every
//                    decline hide rule (a dialog no accept rule answered still goes — bbc.com shows Google Funding
//                    Choices while its accept rule answers BBC's own banner); the decline block rules only for sites
//                    without accept scriptlets, since a blocked loader cannot be accepted (precomputed by the build).
// Everything runs ONLY during a Seamless surfing session, in the person's chosen mode:
//   - scriptlets: one MAIN-world registration (COOKIE_NOTICE_SCRIPTLET_CS_ID) carrying the cookie library, the mode's
//     data file and the end file, matched to that file's sites only — no other page receives anything;
//   - hide rules: one ISOLATED registration per non-empty shard of the mode's hide family (COOKIE_NOTICE_HIDE_CS_ID-<n>),
//     each matched to its own sites only;
//   - block rules: SESSION rules (js/core/cmp-loader-block-manager.js), not a static ruleset, so the saved-rule sites
//     can be excluded at run time.
// Sites with a saved Cookie consent clicker rule are excluded from all three (standing rule: saved rules prevail):
// excludeMatches for the registrations, excludedInitiatorDomains for the block rules. The build only precompiles;
// which sites are excluded is decided at every registration pass (session start/end, any clicker-rule change).
//
// Pure data + pure functions: nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────
import { COOKIE_BANNER_ACTIONS } from './cookie-banner-action.js';

// Registration ids (must not collide with any other content-script id): the scriptlet set of the current mode (MAIN
// world), and the hide shards (ISOLATED world, through js/scripting/css-api.js -> the background's insertCSS, which a
// page's CSP cannot block) — `${COOKIE_NOTICE_HIDE_CS_ID}-<shard>`.
export const COOKIE_NOTICE_SCRIPTLET_CS_ID = 'ubol-cookie-notice-scriptlets';
export const COOKIE_NOTICE_HIDE_CS_ID = 'ubol-cookie-notice-hide';

// Page-global name of the cookie library (NOT the shared SCRIPTLET_LIBRARY_GLOBAL: this registration can run on the same
// page as the SITES registration — see tools/build/scriptlet-dispatch-layout.mjs, `libGlobal`).
export const COOKIE_NOTICE_LIBRARY_GLOBAL = '__usd_cookie_scriptlets_3b8e1d47';

// Generated files (rulesets/). Names deliberately NOT ending in "-scriptlets.js": the build's orphan clean-up owns that
// suffix for per-list data files (build-steps.mjs stepCleanOrphans()).
export const COOKIE_NOTICE_LIBRARY_FILE     = 'rulesets/cookie-notice-library.js';
export const COOKIE_NOTICE_LIBRARY_END_FILE = 'rulesets/cookie-notice-library-end.js';
// { scriptlets: { <mode>: [ site, … ] }, hide: { <family>: [ [ site, … ] per shard ] } } — each file's match patterns.
export const COOKIE_NOTICE_SITES_FILE = 'rulesets/cookie-notice-sites.json';

// Hide rules are sharded by site (cookieNoticeHideShardOf()) so a page receives only the ~1/32 of its family's table
// its site is in (a whole family is ~750 KB for ~11,750 sites). Each selector is its own CSS rule, so one the browser
// cannot parse never cancels the others.
export const COOKIE_NOTICE_HIDE_SHARDS = 32;
export function cookieNoticeHideFile(family, shard) {
    return `rulesets/cookie-notice-hide-${family}-${String(shard).padStart(2, '0')}.js`;
}
// Shard of a site key: a stable string hash (FNV-1a, 32 bit) modulo the shard count — build time only; the runtime reads
// the shard lists from COOKIE_NOTICE_SITES_FILE.
export function cookieNoticeHideShardOf(site) {
    let h = 0x811c9dc5;
    for ( let i = 0; i < site.length; i++ ) { h = Math.imul(h ^ site.charCodeAt(i), 0x01000193) >>> 0; }
    return h % COOKIE_NOTICE_HIDE_SHARDS;
}

// Per mode: its scriptlet data file, its hide family (null = no hide rules) and its block-rule file (null = none).
// Block files hold precompiled DNR rules WITHOUT ids — cmp-loader-block-manager.js numbers them in their reserved range
// (js/core/dnr-budgets.js COOKIE_NOTICE_BLOCK_*) and adds the saved-rule sites as exclusions.
export const COOKIE_NOTICE_MODE_FILES = Object.freeze({
    [COOKIE_BANNER_ACTIONS.PREFER_ACCEPT]: Object.freeze({
        scriptlets: 'rulesets/cookie-notice-prefer-accept.js',
        hideFamily: COOKIE_BANNER_ACTIONS.DECLINE,   // every decline hide rule — the same files, not a copy
        blocks:     'rulesets/cookie-notice-block-prefer-accept.json',
    }),
    [COOKIE_BANNER_ACTIONS.ACCEPT]: Object.freeze({
        scriptlets: 'rulesets/cookie-notice-accept.js',
        hideFamily: null,
        blocks:     null,
    }),
    [COOKIE_BANNER_ACTIONS.DECLINE]: Object.freeze({
        scriptlets: 'rulesets/cookie-notice-decline.js',
        hideFamily: COOKIE_BANNER_ACTIONS.DECLINE,
        blocks:     'rulesets/cookie-notice-block-decline.json',
    }),
});
