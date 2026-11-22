/*
 * security-routes.js — Options tab (was Privacy & Security) config message-route adapters
 *
 * Same three-layer split as matrix-routes.js (see that file's own header
 * for the full rationale):
 *   Layer 1 — message-routes.js:  POLICY
 *   Layer 2 — this file:          ADAPTER (request shape <-> plain state mutation)
 *   Layer 3 — data/config.js's securityConfig (the state
 *             itself) + core/scripting-manager.js/core/ruleset-manager.js
 *             (what re-applying a change actually does)
 *
 * Unlike Matrix, there's no single "security-manager.js" this file adapts
 * to — securityConfig is a plain, directly-mutated state
 * object (data/config.js), and applying a change means calling into
 * whichever module the changed key actually affects. That dispatch logic
 * (the *_KEYS sets below) is genuinely part of the adapter layer, not
 * misplaced business logic — it translates "which config key changed"
 * into "which re-apply function needs to run".
 *
 * (10.3.0) The Privacy & Security extra protections, the Worry-free tier
 * cascade and the editable safer-region TLD list were removed (moved to
 * 3P-Matrix), and with them the security DNR slots (updateSecurityRules),
 * the high-risk-site headers and the three familiar-TLD routes.
 *
 * Public interface — one function per MSG_* route this feature owns,
 * referenced by background.js's ROUTE_HANDLERS:
 *   handleGetSecurityConfig, handleSetSecurityConfig
 *   (audit 10.6.4: handleGetSecurityAllowlist/handleSetSecurityAllowlist removed with securityAllowlist)
 */

import {
    securityConfig,
    saveSecurityConfig,
} from '../data/config.js';

import { applySeamlessSwitch, getAutoDenyState } from '../core/cookie-clicker-autodeny-manager.js';
import { reconcileWorryFreeExtraSuppressionRule } from '../core/worry-free-extra-manager.js';
import { registerCookieClickerAutoDenyContentScripts } from '../core/scripting-manager.js';
import { COOKIE_BANNER_ACTIONS, COOKIE_BANNER_SETTING_KEY } from '../data/cookie-banner-action.js';
import { POWER_TOOLS_SETTING_KEY, arePowerToolsShown } from '../data/power-tools.js';
import { SEAMLESS_ENABLED_SETTING_KEY } from '../data/seamless-switch.js';
import { cancelTempDisable, getTempDisableState } from '../core/temp-disable-manager.js';

/******************************************************************************/
// Key → re-apply dispatch, declared once (every key in securityConfig belongs to exactly one set;
// tools/check-message-routing.mjs and the dry-run test exercise the dispatch).
/******************************************************************************/

// (audit 10.6.4, C13b) SECURITY_SCRIPTLET_TOGGLE_KEYS — an empty Set since 10.5.0 (blockPings, its only
// key, was removed outright) kept "in case a security scriptlet is added again" — REMOVED together with
// its two always-false branches below. (The registration function itself, registerSecurityContentScripts(),
// was removed in the same audit.)

// The Worry-free extra filter lists: each one's switch is a session suppression rule
// (worry-free-extra-manager.js), re-derived from the current session state. (10.3.0 bug fix: these keys
// used to fall through to updateSecurityRules(), which never touched the list switches, so toggling a
// list DURING a session only took effect at the next session.)
const WORRY_FREE_LIST_KEYS = new Set([
    'worryFreeAdguardTrackingEnabled', 'worryFreeKees1958Enabled',
    'worryFreePeterloweEnabled', 'worryFreeAdguardRemoveparamEnabled', 'worryFreeHageziEnabled',
]);

// Persisted only, consulted at the next browser.runtime.onStartup (nothing to register right now; see
// history-cleaner.js and cookie-clicker-autodeny-manager.js).
const SECURITY_STARTUP_ONLY_KEYS = new Set([
    'deleteHistoryOnStart', 'clearDownloadsOnStart', 'clearFormDataOnStart', 'clearCacheOnStart',
    'clearCookiesOnStart', 'clearCacheStorageOnStart', 'clearIndexedDbOnStart',
    'clearLocalStorageOnStart', 'clearServiceWorkersOnStart',
]);

// (11.0.0) "I am an advanced user (unhide power tools)" (js/data/power-tools.js). Its own re-apply: switching it OFF ends
// a running pause and sets Seamless surfing to "accept, else decline" (owner's decisions); a running session follows. The
// context menu follows by itself: background.js rebuilds it when the stored securityConfig changes.
const POWER_TOOLS_KEYS = new Set([ POWER_TOOLS_SETTING_KEY ]);
// (11.0.0) Seamless surfing on/off (js/data/seamless-switch.js) — boolean; turning it off needs advanced mode.
const SEAMLESS_SWITCH_KEYS = new Set([ SEAMLESS_ENABLED_SETTING_KEY ]);

async function applyPowerToolsChange(shown) {
    if ( shown !== false ) { return; }
    // (owner 2026-11-19) Simple mode has no Pause filtering control, so a running pause is ended here — otherwise an
    // indefinite pause could not be ended until the option is switched on again.
    if ( (await getTempDisableState())?.active === true ) { await cancelTempDisable(); }
    // (owner 2026-11-19) Simple mode = Seamless surfing always on, in "accept, else decline".
    let changed = false;
    if ( securityConfig[COOKIE_BANNER_SETTING_KEY] !== COOKIE_BANNER_ACTIONS.PREFER_ACCEPT ) {
        securityConfig[COOKIE_BANNER_SETTING_KEY] = COOKIE_BANNER_ACTIONS.PREFER_ACCEPT;
        changed = true;
    }
    if ( securityConfig[SEAMLESS_ENABLED_SETTING_KEY] !== true ) {
        securityConfig[SEAMLESS_ENABLED_SETTING_KEY] = true;
        changed = true;
    }
    if ( changed === false ) { return; }
    await saveSecurityConfig();
    await applySeamlessSwitch(true);                        // starts a session if none runs
    await registerCookieClickerAutoDenyContentScripts();   // a running session switches mode now (no-op without one)
}

/******************************************************************************/

export async function handleGetSecurityConfig() {
    return securityConfig;
}

export async function handleSetSecurityConfig(request) {
    const { key, value } = request;
    if ( Object.hasOwn(securityConfig, key) === false ) {
        console.warn(`[uBlock-Dynamic] setSecurityConfig: unknown key '${key}' — ignored`);
        return;
    }
    // Input validation (C6): a boolean key only takes a boolean (the Options checkboxes send booleans).
    if ( (POWER_TOOLS_KEYS.has(key) || SEAMLESS_SWITCH_KEYS.has(key)) && typeof value !== 'boolean' ) {
        console.warn(`[uBlock-Dynamic] setSecurityConfig: '${key}' must be a boolean — ignored`);
        return;
    }
    if ( SEAMLESS_SWITCH_KEYS.has(key) && value === false && arePowerToolsShown(securityConfig) === false ) {
        console.warn(`[uBlock-Dynamic] setSecurityConfig: '${key}' off refused — only advanced users can turn Seamless surfing off`);
        return;
    }
    securityConfig[key] = value;
    await saveSecurityConfig();
    if ( POWER_TOOLS_KEYS.has(key) ) {
        await applyPowerToolsChange(value);
    } else if ( SEAMLESS_SWITCH_KEYS.has(key) ) {
        await applySeamlessSwitch(value);
    } else if ( WORRY_FREE_LIST_KEYS.has(key) ) {
        const autoDenyState = await getAutoDenyState();
        await reconcileWorryFreeExtraSuppressionRule(autoDenyState?.active === true, 'setSecurityConfig');
    } else if ( SECURITY_STARTUP_ONLY_KEYS.has(key) === false ) {
        console.warn(`[uBlock-Dynamic] setSecurityConfig: '${key}' has no re-apply route — saved only`);
    }
    return securityConfig;
}
