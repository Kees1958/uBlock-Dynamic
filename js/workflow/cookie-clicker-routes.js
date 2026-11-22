/*
 * cookie-clicker-routes.js — Cookie/consent-clicker message-route adapters
 *
 * Same three-layer split as matrix-routes.js / filter-routes.js (see
 * matrix-routes.js's own header for the full rationale):
 *   Layer 1 — message-routes.js:            POLICY
 *   Layer 2 — this file:                    ADAPTER
 *   Layer 3 — core/cookie-clicker-rules.js: LOGIC (storage)
 *             core/scripting-manager.js:    LOGIC (browser.scripting)
 *
 * This is the ONE place registerCookieClickerContentScripts() is called
 * after a rule mutation — see cookie-clicker-rules.js's own header for
 * why that call deliberately does NOT live inside that core/ module
 * itself (same convention filter-routes.js's handlers already follow for
 * cosmetic rules + registerContentScripts()).
 *
 * Public interface — one function per MSG_* route this feature owns,
 * referenced by background.js's ROUTE_HANDLERS:
 *   handleCookieClickerAddRule, handleCookieClickerPickCancelled,
 *   handleGetCookieClickerRules, handleDeleteCookieClickerRule,
 *   handleClearCookieClickerRules
 *   handleCookieClickerAutoDenyGet, handleCookieClickerAutoDenyStart,
 *   handleCookieClickerAutoDenyCancel, handleCookieClickerAutoDenyExpire
 *   (v8.2 — "Never consent" timed global auto-deny session, delegating to
 *   ../core/cookie-clicker-autodeny-manager.js; see NEVER-CONSENT-
 *   DESIGN.md)
 *   handleCookieClickerLaunchPicker (8.2.17 — moved the toggle-off/
 *   detect/inject sequence here from popup.js's own click handler; see
 *   that function's own header for why)
 */

import { browser } from '../data/ext.js';
import { MSG_COOKIE_CLICKER_PICKER_STOP } from '../data/message-types.js';
import { WORRY_FREE_NAME } from '../data/ui-names.js';
import { securityConfig, saveSecurityConfig } from '../data/config.js';
import { COOKIE_BANNER_SETTING_KEY, cookieBannerActionFor, cookieBannerBundleFor, isCookieBannerAction } from '../data/cookie-banner-action.js';
import { markCookiePromptAnswered } from '../core/seamless-cookie-prompt.js';
import { SEAMLESS_ENABLED_SETTING_KEY, SEAMLESS_OFF_ACTION, SEAMLESS_PROMPT_OFFER_OFF_GLOBAL, isSeamlessSurfingEnabled } from '../data/seamless-switch.js';
import { arePowerToolsShown } from '../data/power-tools.js';
import { getFilteringMode, MODE_NONE } from '../core/mode-manager.js';

import {
    getAllCookieClickerRules,
    addCookieClickerRule,
    countCookieClickerRules,
    deleteCookieClickerRule,
    clearCookieClickerRules,
    COOKIE_CLICKER_RULES_MAX,
} from '../core/cookie-clicker-rules.js';

import { registerCookieClickerContentScripts } from '../core/scripting-manager.js';

import {
    applySeamlessSwitch,
    getAutoDenyState,
    startAutoDeny,
    pauseForPicker,
    resumeAfterPicker,
    expirePickerResumeFallback,
} from '../core/cookie-clicker-autodeny-manager.js';
import { catchExpected, EXPECTED_ERRORS } from '../data/expected-errors.js';

// (10.7.1) AUTO_DENY_BUNDLE_PATH removed: the immediate-apply executeScript call below takes the same bundle the
// session registration uses (scripting-manager.js), from the one shared source js/data/cookie-banner-action.js —
// decline or accept. It used to be a typed copy of scripting-manager.js's directive path, kept equal by hand.

// Start-feedback notice (v9.6.5, see CHANGELOG "picker start feedback").
// The on-page notice script, injected on demand — before the picker files
// on a normal launch, alone when a launch click stops a running session.
const START_NOTICE_SCRIPT_PATH = '/js/scripting/start-notice.js';
// Shown when the Cookie consent clicker button is clicked while a Worry-free
// session is running (10.0.7): the session is only PAUSED for the duration of the pick and
// resumes automatically — see pauseForPicker()/resumeAfterPicker(). UI wording
// ("Worry-free surfing", js/data/ui-names.js), not the internal "Never consent" name.
const SESSION_PAUSED_NOTICE_TEXT = `${WORRY_FREE_NAME} paused while you pick a button — it resumes automatically when you're done.`;

/******************************************************************************/
// Broadcast helper — relays a "stop picking" message to every frame of
// the tab a picker-originated message came from. tabs.sendMessage()
// deliberately called WITHOUT an options.frameId: per the
// chrome.tabs.sendMessage() contract, omitting frameId sends the message
// to every frame in that tab (not just the top one) — exactly the
// broadcast semantics a cross-frame picker session needs, and the reason
// this couldn't just be a direct frame-to-frame call in the first place
// (a content script has no direct channel to a SIBLING frame — only to
// the service worker, which every frame CAN reach).
/******************************************************************************/

// Hostname Chrome reports for a sender URL ('' when absent or unparsable).
function hostnameOf(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

function broadcastPickerStop(tabId) {
    if ( typeof tabId !== 'number' ) { return; }
    // A frame that navigated away or closed between the pick and this broadcast simply won't receive it —
    // expected (TAB_GONE / NO_RECEIVER); any other failure is logged.
    browser.tabs.sendMessage(tabId, { what: MSG_COOKIE_CLICKER_PICKER_STOP })
        .catch(catchExpected('broadcast picker stop', [ EXPECTED_ERRORS.TAB_GONE, EXPECTED_ERRORS.NO_RECEIVER ]));
}

// Runs INSIDE the page (serialized by executeScript's `func`) — must stay
// self-contained: no reference to anything in this module's scope.
function showNoticeText(text) {
    self.uBolStartNotice?.show(text);
}

/******************************************************************************/
// Picker → SW (content-script-sourced — see message-routes.js's
// SENDER_KINDS.CONTENT_SCRIPT gate for these two)
/******************************************************************************/

export async function handleCookieClickerAddRule(request, sender) {
    const { siteHostname, frameHostname, selector, shadowHostSelector, textFilter } = request;
    if ( typeof siteHostname !== 'string' || siteHostname === '' ) {
        return { ok: false, error: 'Missing siteHostname.' };
    }
    if ( typeof frameHostname !== 'string' || frameHostname === '' ) {
        return { ok: false, error: 'Missing frameHostname.' };
    }
    if ( typeof selector !== 'string' || selector === '' ) {
        return { ok: false, error: 'Missing selector.' };
    }
    // F-TRUST-2 (10.7.13): the hostnames in the message come from the
    // content script; trust them only when they match what Chrome itself
    // reports for the sender — the tab's top-level URL and the frame's URL.
    if ( siteHostname !== hostnameOf(sender?.tab?.url) ) {
        return { ok: false, error: 'Site does not match the tab this pick came from.' };
    }
    if ( frameHostname !== hostnameOf(sender?.url) ) {
        return { ok: false, error: 'Frame does not match the frame this pick came from.' };
    }
    const rule = await addCookieClickerRule({ siteHostname, frameHostname, selector, shadowHostSelector, textFilter });
    if ( rule === null ) {
        // addCookieClickerRule() returns null for two distinct reasons
        // (missing fields, already checked above and returned separately;
        // or the RULES_MAX cap — see cookie-clicker-rules.js's own
        // comment on that constant) — by the time execution reaches
        // here, every field has passed the presence checks above, so a
        // null means the cap, or (10.7.13) a field that failed the core
        // module's hostname/length validation. The cap is the only one a
        // real pick can hit, so it gets the distinct, actionable message.
        if ( await countCookieClickerRules() >= COOKIE_CLICKER_RULES_MAX ) {
            return { ok: false, error: `Cookie/consent-clicker rule limit reached (${COOKIE_CLICKER_RULES_MAX}). Delete an existing rule first.` };
        }
        return { ok: false, error: 'Rule rejected: invalid hostname or a field is too long.' };
    }
    // Immediate-apply guard — see cookie-clicker-rules.js's header for
    // why this project's convention is for the WORKFLOW layer (here),
    // not the core storage module, to trigger browser.scripting
    // registration after a mutation.
    await registerCookieClickerContentScripts();
    broadcastPickerStop(sender?.tab?.id);
    await resumeAfterPicker();   // 10.0.7: pick finished -> resume the paused Worry-free session (no-op if none)
    return { ok: true, rule };
}

export async function handleCookieClickerPickCancelled(request, sender) {
    broadcastPickerStop(sender?.tab?.id);
    await resumeAfterPicker();   // 10.0.7: pick cancelled -> resume the paused Worry-free session (no-op if none)
    return { ok: true };
}

/******************************************************************************/
// Dashboard (Manage Custom Rules) → SW (extension-page-sourced — see
// message-routes.js's SENDER_KINDS.EXTENSION_PAGE gate for these four)
/******************************************************************************/

export async function handleGetCookieClickerRules() {
    // Deliberately no per-site filter branch here (unlike, say,
    // getCookieClickerRulesForSite() would have been) — the only current
    // caller (dashboard/custom-rules.js's loadCookieClickerRules()) always
    // wants every rule at once, same as the other three Manage Custom
    // Rules categories' own get* handlers. Add a per-site path back only
    // if a real caller needs one — see this project's own "no
    // speculative unused API surface" convention.
    return getAllCookieClickerRules();
}

export async function handleDeleteCookieClickerRule(request) {
    await deleteCookieClickerRule(request.uid);
    await registerCookieClickerContentScripts();
    return { ok: true };
}

export async function handleClearCookieClickerRules() {
    await clearCookieClickerRules();
    await registerCookieClickerContentScripts();
    return { ok: true };
}

/******************************************************************************/
// Never-consent / cookie-clicker auto-deny (v8.2) — popup -> SW triad,
// same get/start/cancel shape as temp-disable-routes.js's own handlers.
// handleCookieClickerAutoDenyExpire is dispatched internally by
// js/data/alarms.js's processDueJobs() with no `sender` at all — same
// convention handleTempDisableExpire already follows.
/******************************************************************************/

// (10.7.1) Adds `cookieBannerAction` (decline | accept) for the popup's hover text — derived here, not in the popup,
// so the popup never needs the settings object.
export async function handleCookieClickerAutoDenyGet() {
    const state = await getAutoDenyState();
    // (11.0.0) seamlessEnabled: lets the popup line say "off" when an advanced user turned it off.
    return { ...state, cookieBannerAction: cookieBannerActionFor(securityConfig), seamlessEnabled: isSeamlessSurfingEnabled(securityConfig) };
}

export async function handleCookieClickerAutoDenyStart(request, sender) {
    // Unconditional (not debug-gated) — this is the service worker's OWN
    // console (chrome://extensions -> "service worker" inspect link),
    // never the inspected page's console, so it's safe/expected to be
    // quiet in normal operation; kept unconditional specifically because
    // this is the one execution context in the whole D9-D12 flow that had
    // no visibility at all until this fix — see CHANGELOG's 8.2.5 entry
    // for the real investigation this closes a gap in.
    // DEBUG: uncomment for troubleshooting the launch/toggle path — kept
    // (not deleted) specifically because this exact kind of background-
    // side trace logging is what finally diagnosed several real bugs
    // earlier in this feature's development (the dropped-message and
    // "does not start at all" investigations). console.error() calls
    // below stay ACTIVE even in this "production" pass — see this
    // file's own note near the first one for why.
    // console.info('[uBlock-Dynamic] cookieClickerAutoDenyStart received, tabId=', sender?.tab?.id, 'requestedDurationMinutes=', request?.durationMinutes);
    // (10.7.1) The prompt's Accept cookies / Decline cookies button: store the choice FIRST, so the registration
    // inside startAutoDeny() and the immediate apply below both pick the matching bundle. Validated here (C6) — a
    // missing/unknown value keeps the stored choice. Answering also retires the once-after-update prompt.
    const choice = request?.cookieBannerAction;
    // (11.0.0, owner's decision) "Turn Seamless surfing off" — the prompt's fourth choice, only offered (and only
    // accepted) while "I am an advanced user" is on. Off lasts for this browser session only (js/data/seamless-switch.js).
    if ( choice === SEAMLESS_OFF_ACTION ) {
        if ( arePowerToolsShown(securityConfig) === false ) {
            console.warn('[uBlock-Dynamic] cookieClickerAutoDenyStart: "off" refused — only advanced users can turn Seamless surfing off');
            return { active: (await getAutoDenyState()).active === true };
        }
        securityConfig[SEAMLESS_ENABLED_SETTING_KEY] = false;
        await saveSecurityConfig();
        await markCookiePromptAnswered().catch(reason => {
            console.error('[uBlock-Dynamic] cookieClickerAutoDenyStart: could not record the prompt answer:', reason);
        });
        await applySeamlessSwitch(false);
        return { active: false };
    }
    // (11.0.0) Picking a mode also turns Seamless surfing (back) on.
    let changed = securityConfig[SEAMLESS_ENABLED_SETTING_KEY] !== true;
    securityConfig[SEAMLESS_ENABLED_SETTING_KEY] = true;
    if ( isCookieBannerAction(choice) ) {
        if ( securityConfig[COOKIE_BANNER_SETTING_KEY] !== choice ) {
            securityConfig[COOKIE_BANNER_SETTING_KEY] = choice;
            changed = true;
        }
    }
    if ( changed ) { await saveSecurityConfig(); }
    if ( choice !== undefined && isCookieBannerAction(choice) === false ) {
        console.warn('[uBlock-Dynamic] cookieClickerAutoDenyStart: unknown cookieBannerAction ignored:', choice);
    }
    await markCookiePromptAnswered().catch(reason => {
        console.error('[uBlock-Dynamic] cookieClickerAutoDenyStart: could not record the prompt answer:', reason);
    });
    const result = await startAutoDeny();   // (10.7.1) open-ended: no duration any more
    // Immediate-effect guard (FIX, 8.2.3) — same convention this
    // project's own cookie-clicker-picker.js onSave() already documents
    // for a manually-saved rule ("click the just-saved target right now
    // too, in THIS already-open banner, rather than making the user
    // reload the page"). registerCookieClickerAutoDenyContentScriptsImpl()
    // (called inside startAutoDeny(), via scripting-manager.js)
    // registers the bundle for FUTURE matching page loads only —
    // chrome.scripting.registerContentScripts() never retroactively
    // injects into a tab that's already loaded, which is exactly the tab
    // the user is looking at when they click "Never consent" from the
    // in-page dialog. Without this, the session would start correctly
    // but visibly do nothing on the very page that triggered it — the
    // second half of the real bug behind "doesn't work on nbcnews.com /
    // CNN" (the first half was the dropped-message bug fixed in
    // message-routes.js, see that file's own comment on this route).
    const tabId = sender?.tab?.id;
    // SITE-MODE GATE (fix, this pass) — ARCHITECTURE.md's HARD CONSTRAINT:
    // every imperative executeScript() call site must consult the current
    // per-site filtering mode before running. registerCookieClickerAutoDeny-
    // ContentScriptsImpl() (called inside startAutoDeny() above) already
    // gates the FUTURE-page-load registration via buildSiteModeMatchScope(),
    // but this immediate-apply call for the tab the user is ALREADY on had
    // no equivalent guard — turning filtering off for a site (or the same
    // per-hostname MODE_NONE a temp-disable pause also produces) would not
    // have stopped the auto-deny bundle from running immediately on that
    // exact tab. Same pattern already proven at custom-scriptlets.js's
    // injectCustomScriptletsForFrame() and privacy-inspector.js's
    // recordPrivacyInspectorEvent() — sender.url || sender.tab?.url for the
    // frame's own URL (never trust tabId alone), then getFilteringMode().
    const tabUrl = sender?.url || sender?.tab?.url || '';
    let tabHostname = '';
    try { tabHostname = new URL(tabUrl).hostname; } catch {} // benign: an unparsable tab URL leaves tabHostname empty
    const siteModeAllows = tabHostname === ''
        || await getFilteringMode(tabHostname) !== MODE_NONE;
    let autodenyOutcome = { checked: false };
    if ( siteModeAllows && typeof tabId === 'number' && browser.scripting !== undefined ) {
        try {
            const perFrame = await browser.scripting.executeScript({
                files: [ cookieBannerBundleFor(securityConfig) ],
                target: { tabId, allFrames: true },
            });
            // console.info('[uBlock-Dynamic] autodeny immediate-apply executeScript succeeded, tabId=', tabId);
            // (8.2.7/8.2.8) — collapse every frame's own { precedence,
            // matched } completion value (see autodeny-snippets.
            // generated.js's own tail comment) into one summary the
            // on-page toast can show directly — the actual gap earlier
            // rounds needed console log-hunting to close. `matched`
            // entries are `{ name, cosmeticHide }` (8.2.8 — Option A:
            // cosmeticHide reports whether a cosmetic-only fallback hide
            // was ALSO applied after the real reject attempt, for
            // notice-only banner configurations with no real reject
            // action to invoke — see that file's own comment on why this
            // is a hide, never a fake accept).
            const matchedEntries = [];
            const seenNames = new Set();
            let precedenceHit = false;
            for ( const frameResult of perFrame ?? [] ) {
                const r = frameResult?.result;
                if ( !r ) { continue; }
                if ( r.precedence ) { precedenceHit = true; }
                for ( const entry of r.matched ?? [] ) {
                    if ( seenNames.has(entry.name) ) { continue; }
                    seenNames.add(entry.name);
                    matchedEntries.push(entry);
                }
            }
            autodenyOutcome = { checked: true, matchedEntries, precedenceHit };
        } catch (reason) {
            // FIX (8.2.5): this was a silent, empty catch — a real
            // failure here (e.g. a permissions/target error) would
            // previously vanish with zero trace anywhere, in either
            // console. Logged loudly now specifically because this is
            // the exact call site the nbcnews.com investigation needs
            // visibility into; still non-fatal (the session itself IS
            // active either way — see comment above).
            // KEPT ACTIVE (not commented out): this specific error log is
            // what closed the "does not work at all" class of report
            // earlier — a real failure here silently vanishing was the
            // actual bug for several rounds of debugging. Non-fatal
            // either way (the session itself IS active regardless — see
            // comment above).
            console.error('[uBlock-Dynamic] autodeny immediate-apply executeScript FAILED, tabId=', tabId, reason);
            autodenyOutcome = { checked: true, error: String(reason?.message ?? reason) };
        }
    } else {
        // console.info('[uBlock-Dynamic] autodeny immediate-apply SKIPPED — no numeric tabId on sender or browser.scripting unavailable. sender.tab=', sender?.tab);
    }
    return { ...result, autodenyOutcome };
}

// (10.7.1) The Seamless surfing prompt's dismissal — (11.0.0) a click outside the prompt or Escape, which replaced the Cancel button:
// the existing choice is kept, nothing starts, and the prompt counts as answered, so the once-after-update showing is not
// repeated (js/core/seamless-cookie-prompt.js).
export async function handleSeamlessCookiePromptDismiss() {
    try {
        await markCookiePromptAnswered();
    } catch (reason) {
        console.error('[uBlock-Dynamic] seamlessCookiePromptDismiss: could not record the prompt answer:', reason);
    }
    return { ok: true };
}

// (10.7.1) handleCookieClickerAutoDenyCancel / handleCookieClickerAutoDenyExpire REMOVED with the timed sessions:
// nothing sends a cancel any more, and no expiry job is registered (cookie-clicker-autodeny-manager.js).

// Alarm-fired fallback for an abandoned picker (10.0.7) — second independent path (B3b).
export async function handleCookieClickerPickerResumeFallback() {
    return expirePickerResumeFallback();
}

/******************************************************************************/
// (8.2.17) Launch the picker — moved here from popup.js's own
// #gotoCookieClicker click handler. FULL sequence: D6 toggle-off check,
// then D10 one-off detection across all frames, then session-storage
// handoff, then the picker/dialog injection itself.
//
// WHY this moved: a Chrome extension popup closes the instant it loses
// focus — a real, ordinary thing that happens easily (an accidental
// extra click, a window losing focus, etc.), not a rare edge case. This
// entire sequence used to run inside that ephemeral popup window, gated
// behind several `await`s; the detection step's own bounded retry
// (8.2.9, up to ~1.5s across every frame on the page) made that whole
// chain vulnerable to being silently abandoned mid-flight if the popup
// closed before it finished — no error, nothing visibly happened, and
// the person would need to reopen the popup and try again. Real
// reported symptom: "sometimes I have to click a few times before it
// starts."
//
// The background service worker has no equivalent lifetime constraint:
// once this message is dispatched (popup.js now fires it and closes
// immediately, without awaiting a response — see that file's own
// updated handler), this function keeps running to completion
// regardless of whether the popup that sent it still exists.
/******************************************************************************/

// handleGetWorryFreeItemStates() removed — its only consumer,
// js/scripting/worry-free-picker.js, switched from a per-item dynamic
// explanation list to fixed text (per explicit request) and no longer
// needs the individual on/off states this returned. See CHANGELOG and
// this file's own git history if the per-item states are ever needed
// again for something else.

export async function handleCookieClickerLaunchPicker(request) {
    const tabId = request?.tabId;
    // Unconditional (not debug-gated) — this is the service worker's own
    // console, not a page a real user is looking at, so safe to always
    // log here, same posture as handleCookieClickerAutoDenyStart's own
    // entry log. Added specifically because this whole route (8.2.17)
    // had ZERO visibility anywhere if it failed silently — exactly what
    // happened investigating a real "does not start at all" report.
    // console.info('[uBlock-Dynamic] cookieClickerLaunchPicker received, tabId=', tabId);
    if ( typeof tabId !== 'number' ) {
        console.error('[uBlock-Dynamic] cookieClickerLaunchPicker: missing/invalid tabId — request was:', request);
        return { ok: false, error: 'Missing tabId.' };
    }

    // D6 (10.0.7 rewrite) — an active session is PAUSED for the pick, not cancelled, and the launch
    // continues in the same click (no early return). It resumes via handleCookieClickerAddRule /
    // handleCookieClickerPickCancelled, or the 5-minute fallback alarm.
    const autoDenyState = await getAutoDenyState();
    const wasPaused = autoDenyState.active && await pauseForPicker();
    if ( wasPaused ) {
        // These two calls stay INLINE in this function on purpose: tools/check-
        // scripting-site-mode-gating.mjs classifies browser.scripting call
        // sites per enclosing function, and this function is already
        // classified 'exempt' (deliberate, user-initiated, no filtering
        // effect of its own) — the notice is display-only, same shape.
        // Failure (e.g. a restricted page) is a console warning only.
        try {
            await browser.scripting.executeScript({ files: [ START_NOTICE_SCRIPT_PATH ], target: { tabId } });
            await browser.scripting.executeScript({ func: showNoticeText, args: [ SESSION_PAUSED_NOTICE_TEXT ], target: { tabId } });
        } catch (reason) {
            console.warn('[uBlock-Dynamic] cookieClickerLaunchPicker: could not show the session-paused notice, tabId=', tabId, reason);
        }
    }

    // REMOVED (v8.6.2) — the D10 one-off detection pass that used to run
    // here (js/scripting/cookie-clicker-detect.js, executeScript with
    // allFrames: true) was real, reported user-facing latency for zero
    // benefit: its result was written to sessionWrite('cookieClicker.
    // lastDetection', ...) and read back by cookie-clicker-picker.js's
    // own maybeShowActionDialog() — but that file's own comment already
    // documented (since v8.3.14) that it discards the value immediately
    // after reading it, purely for storage-hygiene (clearing a stale
    // key), never actually using cmpFound/cmpName/autoDenyCapable for
    // anything the dialog shows. Confirmed via a full-tree grep before
    // removing (matching this project's own "verify, don't guess"
    // standard) — zero other consumers of that storage key anywhere.
    // Worst case this retry loop added: DETECT_RETRY_MAX_ATTEMPTS (5) *
    // DETECT_RETRY_INTERVAL_MS (300ms) ≈ 1.5s, on EVERY launch where no
    // CMP was present (the common case) — before the picker dialog
    // could even be injected. cookie-clicker-detect.js itself, its
    // CMP_SIGNATURES list, and tools/self-test.mjs's own name-sync check
    // against it are left untouched — that data still has documentary
    // value even with this one call site removed, and touching those is
    // a separable, smaller follow-up if ever wanted, not bundled into
    // this latency fix.

    try {
        await browser.scripting.executeScript({
            files: [
                '/js/scripting/isolated-api.js',
                START_NOTICE_SCRIPT_PATH, // before the picker — it calls self.uBolStartNotice
                '/js/scripting/cookie-clicker-picker.js',
            ],
            target: { tabId, allFrames: true },
        });
        // console.info('[uBlock-Dynamic] cookieClickerLaunchPicker: picker executeScript OK, tabId=', tabId);
    } catch (reason) {
        // console.warn (was console.error, v9.6.5): a failed start is logged
        // for whoever inspects the service worker, deliberately NOT shown to
        // the person — explicit requirement.
        console.warn('[uBlock-Dynamic] cookieClickerLaunchPicker executeScript FAILED, tabId=', tabId, reason);
        return { ok: false, error: String(reason?.message ?? reason) };
    }
    return { ok: true, action: 'launched' };
}

/******************************************************************************/
// Worry-free surfing mode — in-page duration-picker launch (v8.3.19).
// Structurally mirrors handleCookieClickerLaunchPicker() above closely
// (same D6 toggle-off convention, same fire-and-forget-from-popup
// calling posture — popup/popup.js's own #gotoWorryFree handler sends
// this message and closes immediately, same as #gotoCookieClicker's own
// handler already does) — deliberately reused, not reinvented. Simpler
// than the cookie-clicker flow: no per-page CMP detection needed first,
// since this dialog's only job is "let the person pick a duration," not
// "find a specific button on this specific page."
/******************************************************************************/

export async function handleWorryFreeLaunchPicker(request) {
    const tabId = request?.tabId;
    if ( typeof tabId !== 'number' ) {
        console.error('[uBlock-Dynamic] worryFreeLaunchPicker: missing/invalid tabId — request was:', request);
        return { ok: false, error: 'Missing tabId.' };
    }

    // (10.7.1, owner's decision) D6 toggle-off REMOVED for this entry point: the click ALWAYS opens the prompt,
    // also while a session runs, so the cookie-banner choice can be changed (a choice restarts the session with it).
    // (11.0.0) Turning Seamless surfing off is the prompt's own fourth choice, for advanced users only.
    return injectSeamlessPrompt(tabId, 'worryFreeLaunchPicker');
}

// Runs in the page (isolated world) — see injectSeamlessPrompt().
function setPromptOfferOff(globalName, offer) {
    self[globalName] = offer === true;
}

// (10.7.1) The ONE injection of the Seamless surfing prompt — used by the popup launch above and by the
// once-after-update offer (background.js, maybeOfferSeamlessCookiePrompt()). `label` names the caller in the log.
export async function injectSeamlessPrompt(tabId, label) {
    try {
        // (11.0.0) Tell the prompt whether to offer "Turn Seamless surfing off" (advanced users only — the background
        // re-checks when the answer arrives). Set in the prompt's own isolated world; the prompt reads and clears it.
        await browser.scripting.executeScript({
            func: setPromptOfferOff,
            args: [ SEAMLESS_PROMPT_OFFER_OFF_GLOBAL, arePowerToolsShown(securityConfig) ],
            target: { tabId },
        });
        await browser.scripting.executeScript({
            files: [ '/js/scripting/worry-free-picker.js' ],
            target: { tabId },
        });
    } catch (reason) {
        console.error(`[uBlock-Dynamic] ${label} executeScript FAILED, tabId=`, tabId, reason);
        return { ok: false, error: String(reason?.message ?? reason) };
    }
    return { ok: true, action: 'launched' };
}

/******************************************************************************/
