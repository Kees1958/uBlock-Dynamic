// ── power-tools.js ───────────────────────────────────────────────────────────
// (11.0.0, owner's decision 2026-11-19) "I am an advanced user (unhide power tools)" — the ONE place that says which
// tools are power tools and whether they are shown. Like uBlock Origin's old "I am an advanced user": ON for every
// existing user (their saved settings predate the key — js/data/config.js), OFF for a new install.
// When OFF, the power tools are hidden — NOT switched off: rules made with them keep working.
//   popup         — the Seamless surfing, Dynamic DNR filtering and Fingerprint Inspector lines, and Pause filtering
//                   (switching simple mode on ends a running pause); Ad leftover cleaner, Cosmetic element picker,
//                   Cookie consent clicker and Settings dashboard stay (owner 2026-11-19);
//   context menu  — Dynamic DNR filtering and Fingerprint Inspector (the three simple tools stay).
// The dashboard always shows every tab (owner 2026-11-19, second pass — its hiding was removed).
// Switching it OFF also sets Seamless surfing to "accept, else decline" (owner's decision; js/workflow/security-routes.js).
// The Cookie consent clicker, the Ad leftover cleaner and the Cosmetic element picker are never power tools (owner).
// Every popup tool line and context-menu item must be classified here (tools/test-power-tools.mjs).
//
// Public interface:
//   POWER_TOOLS_SETTING_KEY       — the securityConfig key (boolean)
//   POPUP_TOOL_IDS                — { power: [...], always: [...] } popup menu-line element ids
//   POPUP_PAUSE_CONTROL_ID        — the Pause filtering control's element id
//   CONTEXT_MENU_TOOL_IDS         — { power: [...], always: [...] } right-click menu item ids
//   arePowerToolsShown(config)    — securityConfig -> boolean (anything but an explicit true reads as hidden)
//
// Pure data + one pure function: nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────

export const POWER_TOOLS_SETTING_KEY = 'advancedUser';

export const POPUP_TOOL_IDS = Object.freeze({
    power:  Object.freeze([ 'gotoWorryFree', 'gotoMatrixPanel', 'gotoPrivacyInspector' ]),
    always: Object.freeze([ 'gotoAdCleaner', 'gotoPicker', 'gotoCookieClicker', 'gotoSettingsDashboard' ]),
});

// (11.0.0, owner 2026-11-19) The Pause filtering control is hidden in simple mode, always. Switching simple mode on
// ends a running pause (js/workflow/security-routes.js), so a pause can never be left running with no way to end it.
export const POPUP_PAUSE_CONTROL_ID = 'tempDisableSelector';

// Must equal js/workflow/background.js CONTEXT_MENU_IDS values (proven by tools/test-power-tools.mjs).
export const CONTEXT_MENU_TOOL_IDS = Object.freeze({
    power:  Object.freeze([
        'uBolStrippedDynamic.dynamicDnrFiltering',
        'uBolStrippedDynamic.privacyInspector',
    ]),
    always: Object.freeze([
        'uBolStrippedDynamic.adLeftoverCleaner',
        'uBolStrippedDynamic.cosmeticElementPicker',
        'uBolStrippedDynamic.cookieConsentClicker',
    ]),
});

export function arePowerToolsShown(config) {
    return config?.[POWER_TOOLS_SETTING_KEY] === true;
}
