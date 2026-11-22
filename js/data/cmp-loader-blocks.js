// ── cmp-loader-blocks.js ─────────────────────────────────────────────────────
// (10.7.16, owner's decision 2026-11-19) Recognized CMPs whose consent dialog is handled by BLOCKING the CMP's own
// loader script, instead of clicking a button in it. The one place these loaders are listed.
//
// Why a block instead of a click: Sourcepoint draws its dialog inside its own cross-origin iframe
// (cdn.privacy-mgmt.com). The click bundles recognize Sourcepoint in the page, but its buttons live in that
// iframe, so on sites like bbc.com and nrc.nl nothing gets clicked. Blocking the loader means the dialog never
// appears and the site gets no answer — the same outcome as declining.
//
// When it applies (owner's decisions 2026-11-19, enforced by js/core/cmp-loader-block-manager.js):
//   - only while Seamless surfing is active AND set to DECLINE cookie banners (js/data/cookie-banner-action.js);
//     in ACCEPT mode the dialog is left alone so it can be accepted;
//   - on every site, EXCEPT a site with a saved cookie-clicker rule (standing rule: saved rules prevail) and
//     anything whose own higher-priority allow wins (Allow list, site turned off, "@@site$worryfree", a
//     default-list @@) — see CMP_LOADER_BLOCK_PRIORITY in js/core/dnr-budgets.js.
//
// Entry fields:
//   cmp           — display name; matches that CMP's `name` in vendor/autoconsent/rules/rules.json
//   urlFilter     — DNR urlFilter for the loader script (path-anchored, so a self-hosted copy is covered too)
//   resourceTypes — DNR resource types the block covers (script only: nothing else of the CMP is touched)
// At most CMP_LOADER_BLOCK_RULES_MAX entries (js/core/dnr-budgets.js) — one DNR rule id each.
//
// Pure data: no imports, no state — nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────

export const CMP_LOADER_BLOCKS = Object.freeze([
    Object.freeze({
        cmp: 'Sourcepoint',
        // Sourcepoint's standard consent-message loader; confirmed by the owner on bbc.com and nrc.nl. Path-anchored,
        // so a first-party copy (e.g. Schibsted's cmp.<site> hosts) is covered too — 11.0.0: vg.no
        // confirmed loading cmp.vg.no/unified/wrapperMessagingWithoutDetection.js.
        urlFilter: '/wrapperMessagingWithoutDetection.js^',
        resourceTypes: Object.freeze([ 'script' ]),
    }),
]);
