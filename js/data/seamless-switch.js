// ── seamless-switch.js ───────────────────────────────────────────────────────
// (11.0.0, owner's decisions 2026-11-19) Seamless surfing is ALWAYS on — the "Enable Seamless surfing on startup"
// option is removed. It starts on install, on update and at EVERY browser start. Only an advanced user can turn it
// off, and only for the current browser session: the Seamless surfing prompt shows a "Turn Seamless surfing off"
// choice while "I am an advanced user" is on (the popup line is hidden in simple mode anyway). The next browser start
// switches it back on (js/workflow/background.js onStartup); so do picking a mode in the prompt and switching to
// simple mode.
//
// Public interface:
//   SEAMLESS_ENABLED_SETTING_KEY   — securityConfig key (boolean, default true; js/data/config.js)
//   SEAMLESS_OFF_ACTION            — the prompt's "off" choice value (js/scripting/worry-free-picker.js keeps a copy,
//                                    proven equal by tools/test-seamless-always-on.mjs)
//   SEAMLESS_PROMPT_OFFER_OFF_GLOBAL — page global the launch sets to tell the prompt to show the off choice
//   isSeamlessSurfingEnabled(config) — anything but an explicit false reads as ON
//
// Pure data + one pure function: nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────

export const SEAMLESS_ENABLED_SETTING_KEY = 'seamlessSurfingEnabled';
export const SEAMLESS_OFF_ACTION = 'off';
export const SEAMLESS_PROMPT_OFFER_OFF_GLOBAL = '__usd_seamless_offer_off_5d2a90';

export function isSeamlessSurfingEnabled(config) {
    return config?.[SEAMLESS_ENABLED_SETTING_KEY] !== false;
}
