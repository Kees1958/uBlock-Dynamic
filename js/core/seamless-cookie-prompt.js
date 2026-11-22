// ── seamless-cookie-prompt.js ────────────────────────────────────────────────
// (10.7.1, owner's decision) Show the Seamless surfing prompt ONCE after this update (and once after a fresh
// install), so every person learns that cookie banners can be accepted or declined — most sessions start by
// themselves at browser start and never show the prompt otherwise.
//
// "Once" means: until the person ANSWERS it — clicks one of the mode buttons or Cancel. Being shown is not
// enough (audit B12: a short auto-dismissing dialog shown once can be missed for good). To avoid nagging, it is
// offered at most once per browser session while still unanswered.
//
// Markers (its own version marker, never
// rulesetConfig.version):
//   COOKIE_PROMPT_ANSWERED_MARKER_KEY (storage.local)   — the extension version in which it was answered
//   COOKIE_PROMPT_OFFERED_SESSION_KEY (storage.session) — true once offered in this browser session
// Marker lifecycle (C41): Created by markCookiePromptAnswered() (start or dismiss message from the prompt) /
// markCookiePromptOffered() (background, right before injecting); Read by isCookiePromptDue(); Deleted by "Reset to
// defaults" (storage.local.clear — the prompt is then offered once more) and, for the session key, by the browser
// at session end.
//
// Public interface: isCookiePromptDue(), markCookiePromptOffered(), markCookiePromptAnswered()
// Dependencies: js/data/ext.js (storage), js/util/version-compare.js (isVersionOlderThan — one comparator).
// State owned: none in memory — both markers live in storage, so a service-worker restart changes nothing.
// ─────────────────────────────────────────────────────────────────────────────
import { browser, localRead, localWrite, sessionRead, sessionWrite } from '../data/ext.js';
import { isVersionOlderThan } from '../util/version-compare.js';

// The version that introduced the choice. An answer recorded in an older version (or none) makes it due.
// (10.7.9, audit 10.7.8) Module-private: nothing outside this file reads it (dead-export check, step 10).
// (11.0.0, owner's decision 2026-11-19) Raised to 11.0.0: the third mode ("accept, else decline") is new, so everyone is
// asked ONCE more after updating — an answer given in 10.7.1–10.7.16 no longer counts.
const COOKIE_PROMPT_SINCE = '11.0.0';
const COOKIE_PROMPT_ANSWERED_MARKER_KEY = 'seamlessCookiePromptAnsweredIn';
const COOKIE_PROMPT_OFFERED_SESSION_KEY = 'seamlessCookiePromptOffered';

export async function isCookiePromptDue() {
    try {
        const [ answeredIn, offered ] = await Promise.all([
            localRead(COOKIE_PROMPT_ANSWERED_MARKER_KEY),
            sessionRead(COOKIE_PROMPT_OFFERED_SESSION_KEY),
        ]);
        return isVersionOlderThan(answeredIn, COOKIE_PROMPT_SINCE) && offered !== true;
    } catch (reason) {
        console.error('[uBlock-Dynamic] seamless-cookie-prompt/isCookiePromptDue:', reason);
        return false;   // GUARD: a failed read never shows the prompt (it is retried on the next page load)
    }
}

export async function markCookiePromptOffered() {
    return sessionWrite(COOKIE_PROMPT_OFFERED_SESSION_KEY, true);
}

export async function markCookiePromptAnswered() {
    return localWrite(COOKIE_PROMPT_ANSWERED_MARKER_KEY, browser.runtime.getManifest().version);
}
