// ── ui-names.js ──────────────────────────────────────────────────────────────
// (10.5.0) The ONE place for names the user reads in more than one place: the Worry-free feature
// name and the dashboard tabs (label + order + which one opens first). Every page derives its text
// from here (C39a — derived, never transcribed); renaming a feature or a tab is a one-line change.
//
// Read by:
//   dashboard/dashboard.js              — builds the tab bar (order + labels), default pane
//   dashboard/dashboard.html            — [data-ui-name] placeholders, filled by js/ui/ui-names-apply.js
//   dashboard/settings-io.js            — names tabs in the restore status / reset confirmation
//   popup/worry-free-ui.js              — the Worry-free menu label
//   js/workflow/cookie-clicker-routes.js — the "Worry-free paused" in-page notice
//   js/scripting/worry-free-picker.js   — content script, cannot import: keeps its own copy of
//                                         WORRY_FREE_NAME, proven equal by tools/check-ui-name-copies.mjs
//
// Pure data: no imports, no state — nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────

// Feature name (owner, 10.5.0: was "Worry-free safe surfing"; 10.7.1: was "Worry-free surfing").
// UI text only: internal names (WORRY_FREE_*, worryFree* settings and element ids, file names, message types) and
// the Allow list option "@@site$worryfree" keep "worry-free" — they are contracts (stored keys, user rules).
export const WORRY_FREE_NAME = 'Seamless surfing';
// (11.0.0) The per-site cookie-banner tool's name — the Seamless surfing prompt tells that its rules override every mode.
/** @public its only reader is the forced copy in js/scripting/worry-free-picker.js (a content script cannot import), proven equal by tools/check-ui-name-copies.mjs */
export const COOKIE_CLICKER_NAME = 'Cookie consent clicker';
// (11.0.0, owner 2026-11-19) The on-demand cleanup tool's name (js/data/ad-cleaner.js).
/** @public read by the popup (data-ui-name), the context menu, and the forced copy in js/scripting/ad-cleaner.js, proven equal by tools/check-ui-name-copies.mjs */
export const AD_CLEANER_NAME = 'Ad leftover cleaner';
// (11.0.0, owner 2026-11-19) Was "Dynamic DNR filtering" — renamed everywhere in the UI. Internal names (matrix*, ids,
// storage keys, file names) keep the old wording on purpose: they are contracts, not user text.
/** @public read by the popup, the right-click menu, the panel, Manage custom rules and settings import/export */
export const DNR_TRACKING_FILTER_NAME = 'DNR tracking filter';
// (11.1.0, owner) Sentence case like every other tool name (was "Fingerprint Inspector").
export const FINGERPRINT_INSPECTOR_NAME = 'Fingerprint inspector';

// Dashboard tabs, in display order (owner, 10.5.0: Filter (block) lists first, Allow list after
// Manage custom rules, "Privacy & Security" renamed to "Options").
// `pane` is the internal key: it names the <section data-pane> and is the value stored under
// 'dashboard.activePane' — a contract, so it is never renamed with the label (the Options tab
// keeps pane 'security').
export const DASHBOARD_TABS = Object.freeze([
    Object.freeze({ pane: 'filterlists', label: 'Filter (block) lists' }),
    Object.freeze({ pane: 'filters',     label: 'Import ABP rules' }),
    Object.freeze({ pane: 'customrules', label: 'Manage custom rules' }),
    Object.freeze({ pane: 'develop',     label: 'Allow (white) list' }),
    Object.freeze({ pane: 'security',    label: 'Options' }),
]);

// The tab the dashboard opens on when no other tab was remembered: the first tab.
export const DEFAULT_DASHBOARD_PANE = DASHBOARD_TABS[0].pane;

// Label of one tab by its pane key (for text that names a tab, e.g. settings-io.js).
export function tabLabel(pane) {
    const tab = DASHBOARD_TABS.find(t => t.pane === pane);
    if ( tab === undefined ) { throw new Error(`ui-names: unknown dashboard pane "${pane}"`); }
    return tab.label;
}

// Values for [data-ui-name="KEY"] placeholders in HTML (js/ui/ui-names-apply.js).
export const UI_NAMES = Object.freeze({
    worryFree: WORRY_FREE_NAME,
    worryFreeMode: `${WORRY_FREE_NAME} mode`,
    // (11.0.0) worryFreeStartupLabel REMOVED with the "Enable Seamless surfing on startup" option.
    adCleaner: AD_CLEANER_NAME,   // (11.0.0) popup line
    dnrTrackingFilterRules: `${DNR_TRACKING_FILTER_NAME} rules`,   // (11.0.0) Manage custom rules section
    fingerprintInspector: FINGERPRINT_INSPECTOR_NAME,   // (11.1.0) popup line
    cookieClickerRules: `${COOKIE_CLICKER_NAME} rules`,   // (11.1.0) Manage custom rules section (was "Cookie consent-clicker rules")
});
