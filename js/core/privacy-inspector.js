// ── privacy-inspector.js (core) ─────────────────────────────────────────────────
// Fingerprint Inspector session state and event collection (service worker side).
// ─────────────────────────────────────────────────────────────────────────────
import { browser, sessionRead, sessionWrite } from '../data/ext.js';
import { broadcastMessage } from '../data/broadcast.js';
import { MSG_PRIVACY_INSPECTOR_ENTRY, MSG_PRIVACY_INSPECTOR_CLOSED } from '../data/message-types.js';
import { DEFAULT_SESSION_TIMEOUT_MS, SESSION_DEADLINE_ALARMS } from '../data/timing-constants.js';
import { createSessionDeadline } from './session-deadline.js';
import {
    registerContentScriptsSafely,
    unregisterContentScriptsByIds,
} from './scripting-manager.js';
import { catchExpected, EXPECTED_ERRORS } from '../data/expected-errors.js';

const SESSION_TIMEOUT_MS = DEFAULT_SESSION_TIMEOUT_MS;
const FIFO_MAX = 100;
const PROBE_IDS = [ 'privacy-inspector-probe', 'privacy-inspector-bridge' ];

// Single storage key for session + entries together (one write per mutation,
// per project convention, rather than two separate storage calls).
const STORAGE_KEY = 'privacyInspectorState';

// ── Why this module uses chrome.storage.session instead of plain variables ──
// MV3 background service workers are killed by the browser after ~30s of
// inactivity and restarted on the next event — at which point every
// module-level `let` resets. The probe/bridge content scripts are registered
// with persistAcrossSessions: true, so *they* keep firing across a restart —
// but a plain `let session = null` here would silently forget an in-progress
// inspection had ever started, causing recordPrivacyInspectorEvent() to
// reject every subsequent event. chrome.storage.session is the browser's own
// purpose-built fix for exactly this: in-memory-only (cleared on browser
// exit, never touches disk) but *does* survive a service-worker restart.
//
// hydrated/hydration below make sure every exported function waits for the
// one-time restore from storage before it reads or mutates `session`/
// `entries`, so a message arriving right after a restart doesn't race ahead
// of the restore and see stale (empty) state.
let session = null;
let entries = [];
let hydrated = false;
// The 5-minute session timeout while the worker is awake. NOT persisted across a SW restart (setTimeout handles
// can't be) — (10.7.6) the deadline alarm below (js/core/session-deadline.js) is what survives the worker sleeping.
let sessionTimeoutHandle = null;
const hydration = (async ( ) => {
    const stored = await sessionRead(STORAGE_KEY);
    if ( stored ) {
        session = stored.session ?? null;
        entries = Array.isArray(stored.entries) ? stored.entries : [];
    }
    hydrated = true;
})();

async function ensureHydrated() {
    if ( !hydrated ) { await hydration; }
}

async function persist() {
    await sessionWrite(STORAGE_KEY, { session, entries });
}

function hostMatches(host, candidate) {
    return candidate === host || candidate.endsWith(`.${host}`);
}

async function unregisterProbe() {
    await unregisterContentScriptsByIds(PROBE_IDS);
}

async function registerProbe(host) {
    await unregisterProbe();
    const matches = [ `*://${host}/*`, `*://*.${host}/*` ];
    const result = await registerContentScriptsSafely([
        {
            id: PROBE_IDS[0],
            js: [ '/privacy/privacy-probe.js' ],
            matches,
            runAt: 'document_start',
            world: 'MAIN',
            allFrames: true,
            // Some fingerprinting scripts render into a dynamically-created
            // iframe with no `src` (so its own URL is about:blank) — without
            // this, Chrome only matches a frame by its own URL, and such a
            // frame never matches our host-based `matches` patterns even
            // with allFrames: true, so the probe silently never reaches it.
            // matchOriginAsFallback makes Chrome fall back to the frame's
            // *creator's* origin for matching in exactly that case.
            matchOriginAsFallback: true,
        },
        {
            id: PROBE_IDS[1],
            js: [ '/privacy/privacy-bridge.js' ],
            matches,
            runAt: 'document_start',
            world: 'ISOLATED',
            allFrames: true,
            matchOriginAsFallback: true,
        },
    ]);
    if ( result.ok !== true ) {
        console.error('[uBlock-Dynamic] Privacy Inspector: probe registration failed, probe will not fire for this session:', result.error);
    }
}

function scheduleSessionTimeout(remainingMs) {
    clearSessionTimeoutHandle();
    sessionTimeoutHandle = setTimeout(
        () => { stopPrivacyInspector('timeout'); },
        remainingMs
    );
}

function clearSessionTimeoutHandle() {
    if ( sessionTimeoutHandle !== null ) {
        clearTimeout(sessionTimeoutHandle);
        sessionTimeoutHandle = null;
    }
}

export async function startPrivacyInspector(tabId, host) {
    await ensureHydrated();
    // 'clash' — if a session was already running (e.g. Privacy Inspector
    // started from a second tab), its panel now gets properly notified to
    // close via the broadcast below, instead of being silently abandoned
    // to poll a session that's about to disappear out from under it. This
    // case was completely unhandled before — block-monitor.js's own
    // startMonitor() has always done the equivalent (see its own 'clash'
    // handling) but this module never had a parallel for it.
    await stopPrivacyInspector('clash');
    entries = [];
    session = {
        tabId,
        host,
        phase: 'running',
        startTime: Date.now(),
        timeElapsed: 0,
    };
    await persist();
    scheduleSessionTimeout(SESSION_TIMEOUT_MS);
    await deadline.arm(SESSION_TIMEOUT_MS);
    await registerProbe(host);
    await browser.tabs.reload(tabId).catch(catchExpected('reload inspected tab', [ EXPECTED_ERRORS.TAB_GONE ]));
}

// reason forwarded to the panel via broadcast so it can show the right
// message — mirrors block-monitor.js's endSession(reason). Only actually
// broadcasts if there was a session to close: called unconditionally from
// startPrivacyInspector() above as internal cleanup, where "nothing was
// running" is the common case and shouldn't produce a stray broadcast.
export async function stopPrivacyInspector(reason = 'user') {
    await ensureHydrated();
    const hadSession = session !== null;
    clearSessionTimeoutHandle();
    await deadline.disarm();   // GUARD (release): no timer or alarm outlives the session
    await unregisterProbe();
    session = null;
    entries = [];
    await persist();
    if ( hadSession ) {
        broadcastMessage({ what: MSG_PRIVACY_INSPECTOR_CLOSED, reason });
    }
}

export async function pausePrivacyInspector() {
    await ensureHydrated();
    if ( !session || session.phase !== 'running' ) { return; }
    session.timeElapsed += Date.now() - session.startTime;
    session.startTime = null;
    session.phase = 'paused';
    clearSessionTimeoutHandle();
    await deadline.disarm();   // a paused session has no running deadline; resume arms it again
    await persist();
    await unregisterProbe();
}

export async function resumePrivacyInspector() {
    await ensureHydrated();
    if ( !session ) { return; }
    entries = [];
    session.phase = 'running';
    session.startTime = Date.now();
    await persist();
    scheduleSessionTimeout(SESSION_TIMEOUT_MS - session.timeElapsed);
    await deadline.arm(SESSION_TIMEOUT_MS - session.timeElapsed);
    await registerProbe(session.host);
    await browser.tabs.reload(session.tabId).catch(catchExpected('reload inspected tab', [ EXPECTED_ERRORS.TAB_GONE ]));
}

export async function getPrivacyInspectorData() {
    await ensureHydrated();
    if ( !session ) { return null; }
    const elapsed = session.timeElapsed + (
        session.phase === 'running' && session.startTime !== null
            ? Date.now() - session.startTime
            : 0
    );
    if ( elapsed >= SESSION_TIMEOUT_MS ) {
        await stopPrivacyInspector('timeout');
        return null;
    }
    return { session: { ...session }, entries: [ ...entries ] };
}

export async function recordPrivacyInspectorEvent(sender, detail) {
    await ensureHydrated();
    if ( !session || session.phase !== 'running' ) { return; }
    if ( sender.tab?.id !== session.tabId ) { return; }
    const frameUrl = sender.url || sender.tab?.url || '';
    let frameHost = '';
    try { frameHost = new URL(frameUrl).hostname; } catch {} // benign: an unparsable frame URL leaves frameHost empty
    if ( frameHost && !hostMatches(session.host, frameHost) ) { return; }
    const entry = {
        elapsed: `${Math.max(0, Date.now() - session.startTime)} ms`,
        category: String(detail?.category || 'other'),
        api: String(detail?.api || ''),
        details: String(detail?.details || ''),
        url: String(detail?.url || frameUrl),
        host: frameHost || session.host,
    };
    entries.push(entry);
    if ( entries.length > FIFO_MAX ) { entries.shift(); }
    await persist();
    broadcastMessage({ what: MSG_PRIVACY_INSPECTOR_ENTRY, entry });
}

/******************************************************************************/
// Deadline alarm (10.7.6) — js/core/session-deadline.js: armed with a session, cleared when it pauses or ends; wakes
// the worker at the deadline even when the panel was closed. Replaces the 10.5.0 setInterval watchdog, which died
// with the sleeping worker (audit 10.7.5, D-1).
/******************************************************************************/

const deadline = createSessionDeadline({
    alarms: browser.alarms,
    alarmName: SESSION_DEADLINE_ALARMS.PRIVACY_INSPECTOR,
    timeoutMs: SESSION_TIMEOUT_MS,
    ensureHydrated,
    getSession: () => session,
    onTimeout: () => stopPrivacyInspector('timeout'),
    // persistAcrossSessions defaults to true: the probe outlives chrome.storage.session after a browser restart.
    releaseOrphans: unregisterProbe,
});

// background.js onAlarm: true when it was this session's deadline.
export function handlePrivacyInspectorDeadlineAlarm(alarmName) {
    return deadline.handleAlarm(alarmName);
}

// Called once at SW boot by background.js: a running session gets its alarm, no session releases a left-over probe.
export function reconcilePrivacyInspectorDeadline() {
    return deadline.reconcile();
}
