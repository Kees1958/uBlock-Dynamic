// ── privacy-inspector.js ────────────────────────────────────────────────────────
// Fingerprint Inspector panel page ("Privacy Inspector" in code): shows the events the probe reports for the
// inspected tab, grouped by risk, and lets the user apply or remove a scriptlet mitigation per event.
// ─────────────────────────────────────────────────────────────────────────────
// theme.js (dark/light/mobile/desktop classes on <html>) is now loaded via
// a <script> tag in privacy-inspector.html, same as every other panel in
// this extension (dashboard/popup/picker/Matrix panel) — standardized to
// one mechanism, not a JS import here and a script tag everywhere else.

import { createInfoDropdown } from '../js/ui/info-tooltip.js';
import { sendMessage } from '../js/data/ext.js';
import { DEFAULT_SESSION_TIMEOUT_MS } from '../js/data/timing-constants.js';
import { LOGICAL_LABELS, getScriptletRuleRisk, RISK_HIGH, RISK_MEDIUM, RISK_LOW } from '../js/data/scriptlet-rule-labels.js';
import { RISK_BADGE, RISK_UNKNOWN, UNKNOWN_RISK_REASON_SIGNAL } from '../js/data/risk-badge.js';
import {
    MSG_STOP_PRIVACY_INSPECTOR,
    MSG_PAUSE_PRIVACY_INSPECTOR,
    MSG_RESUME_PRIVACY_INSPECTOR,
    MSG_GET_PRIVACY_INSPECTOR_DATA,
    MSG_PRIVACY_INSPECTOR_ENTRY,
    MSG_PRIVACY_INSPECTOR_CLOSED,
    MSG_ADD_PRIVACY_SCRIPTLET_RULE,
    MSG_APPLY_PRIVACY_EXTRAS,
    MSG_GET_PRIVACY_SCRIPTLET_RULES,
} from '../js/data/message-types.js';

// ── Category → scriptlet mitigation mapping ─────────────────────────────────
// Single source of truth for which Privacy Inspector categories currently
// have a working "Select" mitigation, and which scriptlet (+ args) to write
// via addCustomScriptletRule() when the user clicks it. A category with no
// entry here keeps its "Select" button disabled (see appendRow()).
//
// beacon USED TO use abort-on-property-read on navigator.sendBeacon here,
// on the assumption it was low breakage risk ("no legitimate use beyond
// analytics/exit-pings"). That assumption was wrong — confirmed breaking
// bnr.nl (see the CATEGORY_SCRIPTLET_MAP comment next to 'beacon' below for
// the specific mechanism). sendBeacon is widely used for crash/error
// reporting too, often called unguarded, so it's detection-only now, same
// treatment as the 'legit-signals' properties below. Block Monitor's
// separate "Create custom DNR rule" feature still offers a 'ping'
// resourceType option for a destination-scoped block, which doesn't carry
// this risk (it targets specific request destinations, not every call
// site in the page's own code).
//
// Currently wired: webrtc, canvas/webgl (untangled this session — see
// CHANGELOG. Previously shared one blanket prevent-canvas call with no
// contextType arg, blocking every canvas context type at once, because
// blocking getContext() entirely also prevents the downstream
// toDataURL()/toBlob()/getImageData() reads filed under 'canvas'. Now
// each passes its own contextType arg — 'webgl' blocks WebGL/WebGL2/
// experimental-webgl only, 'canvas' blocks 2D only — independently
// selectable and independently risk-rated). webgl-fingerprint shares
// webgl's mitigation (blocking WebGL context creation necessarily also
// prevents the WEBGL_debug_renderer_info extension read, since that
// read needs a WebGL context first) — NOT yet its own surgical,
// narrower mitigation; that would need a new custom security-scriptlet
// (like sec-adult-fingerprint.js), not a real-scriptlet args tweak like
// this one, and hasn't been built.
// permissions uses the same generic abort-on-property-read mechanism beacon
// used to. clipboard and audio are functions, not static {name, args}
// objects — clipboard's read/write need different property-path targets
// (navigator.clipboard.readText vs .writeText, etc.), and audio's target
// depends on whether OfflineAudioContext or the regular AudioContext
// actually fired (privacy-probe.js reports both under the 'audio'
// category) — so both depend on entry.api, not just the category.
const CATEGORY_SCRIPTLET_MAP = {
    webrtc: { name: 'nowebrtc', args: [] },
    // Untangled this session (previously both shared one blanket
    // {name:'prevent-canvas', args:[]} call blocking every canvas
    // context type at once). prevent-canvas's real, documented
    // contextType argument scopes the block to just that type —
    // 'webgl' now only blocks WebGL/WebGL2/experimental-webgl context
    // creation, 'canvas' only blocks the 2D context. Each is now
    // independently classifiable in the Break-risk table (see
    // scriptlet-rule-labels.js's RULE_INFO) instead of forced to share
    // one risk level just because they shared one rule.
    webgl: { name: 'prevent-canvas', args: [ 'webgl' ] },
    canvas: { name: 'prevent-canvas', args: [ '2d' ] },
    // Restored per explicit request — Select re-enabled for beacon/
    // legit-signals using this codebase's own standard mechanism for
    // every other category (abort-on-property-read), same as before
    // these were disabled after confirmed breakage on nos.nl/bnr.nl.
    // Deliberately NOT a safer non-throwing alternative — the red High-
    // risk badge (CATEGORY_RISK_OVERRIDE below) is the warning, matching
    // how every other High-risk category here already works (WebRTC/
    // WebGL/Time zone/Clipboard all use hard-blocking mechanisms too,
    // with only the badge as the warning, no extra disabling on top).
    beacon: { name: 'abort-on-property-read', args: [ 'navigator.sendBeacon' ] },
    permissions: { name: 'abort-on-property-read', args: [ 'navigator.permissions.query' ] },
    audio: entry => ({ name: 'abort-on-property-read', args: [ entry.api || 'OfflineAudioContext' ] }),
    clipboard: entry => ({ name: 'abort-on-property-read', args: [ `navigator.clipboard.${entry.api}` ] }),
    'webgl-fingerprint': { name: 'prevent-canvas', args: [ 'webgl' ] },
    'tz-fingerprint': { name: 'abort-on-property-read', args: [ 'Intl.DateTimeFormat.prototype.resolvedOptions' ] },
    'navigator-plugins': entry => ({ name: 'abort-on-property-read', args: [ `navigator.${entry.api}` ] }),

    // device now only ever reports getBattery (see privacy-probe.js) —
    // hardwareConcurrency/deviceMemory/maxTouchPoints/connection/
    // getGamepads are tracked separately under 'legit-signals' (below),
    // restored to Select-able status per the same explicit request as
    // beacon above.
    device: entry => ({ name: 'abort-on-property-read', args: [ `navigator.${entry.api}` ] }),
    idle: { name: 'abort-on-property-read', args: [ 'IdleDetector' ] },
    nfc: { name: 'abort-on-property-read', args: [ 'NDEFReader' ] },
    // Restored per explicit request — see beacon's own comment above for
    // the full reasoning (same "red badge is the warning" decision).
    // getGamepads is a method, not a property — abort-on-property-read
    // still applies the same way as it does to sendBeacon above (throws
    // on read of the function reference itself, not on invocation).
    'legit-signals': entry => ({ name: 'abort-on-property-read', args: [ `navigator.${entry.api}` ] }),
    // (10.7.0) Tracking elements — per site, like every Select. A ping is removed from the links (the link still
    // works); a tiny frame / pixel image is stopped by its exact address (no query string), so only that one
    // tracking endpoint is affected, first- or third-party alike. No address -> no Select.
    'tracking-ping': { name: 'remove-attr', args: [ 'ping', 'a[ping]', 'asap stay' ] },
    'tracking-frame': entry => elementSrcRule('iframe', entry.details),
    'tracking-pixel': entry => elementSrcRule('img', entry.details),
};

// (10.7.0) prevent-element-src-loading's match: the reported address without query string or fragment (those
// usually carry per-visit ids, so the bare address is what repeats). null = not a web address -> no Select.
function elementSrcRule(tag, url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if ( u.protocol !== 'https:' && u.protocol !== 'http:' ) { return null; }
    return { name: 'prevent-element-src-loading', args: [ tag, `${u.origin}${u.pathname}` ] };
}

// Single source of truth for computing an entry's risk — used by
// appendRow() (the live Break-risk badge) AND blockableRowsUpToRisk()
// below (the tiered block buttons), so the two can never drift apart
// from each other. Goes straight through getScriptletRuleRisk() now —
// the same shared table dashboard/custom-rules.js reads — no
// category-specific override branch anymore (see that table's own
// comment on legit-signals/beacon for why one isn't needed: this
// panel's Monitor and the dashboard's "Manage custom rules" list read
// the exact same risk data for every category now, not just most of
// them).
function computeRisk(entry, mapping) {
    return mapping ? getScriptletRuleRisk(mapping) : null;
}

function scriptletMappingFor(entry) {
    const mapping = CATEGORY_SCRIPTLET_MAP[entry.category];
    if ( typeof mapping === 'function' ) { return mapping(entry); }
    return mapping;
}

const CATEGORIES = [
    'webrtc', 'webgl', 'webgl-fingerprint', 'canvas', 'audio',
    'tz-fingerprint', 'navigator-plugins', 'device', 'idle', 'nfc',
    'clipboard', 'beacon', 'permissions', 'legit-signals',
    'tracking-ping', 'tracking-frame', 'tracking-pixel',   // (10.7.0)
];

// FILTER_GROUPS — controls what checkboxes appear in the "Show:" bar, and
// which real CATEGORIES value(s) each one toggles. Every group here is a
// plain 1:1 wrapper around a single category, checked by default — see
// each group's own comment below for the two exceptions that used to be
// merged pairs ('webgl'/'webgl-fingerprint' and 'beacon'/'legit-signals')
// and were un-merged this session, once their mitigations/risk ratings
// stopped being identical to each other. Add more multi-category groups
// here, not by special-casing the checkbox loop or the change handler
// below — both are written to work off this list generically.
//
// ORDER — Low, then Medium, then High risk (per explicit request),
// matching the same tiers computeRisk()/RISK_ORDER use for the block
// buttons above. Every group here has a single, unambiguous tier — no
// group mixes categories from two different risk levels, so ordering by
// group (not by individual category) is unambiguous. If a future group
// is added spanning two tiers, it belongs in whichever tier is its
// LOWER (more permissive) member, consistent with the block buttons'
// own "Low/Medium is a threshold, not an exact match" reasoning above.
// (10.7.0, owner's request) Every group declares its `tier`; the checkbox bar shows a "[all … risk]" marker after
// the last group of each tier (TIER_MARKERS below). The tracking elements are placed by their own risk, and
// Tracking beacons is the last High-risk group.
const FILTER_GROUPS = [
    // ── Low risk ──
    { key: 'navigator-plugins', categories: [ 'navigator-plugins' ], tier: RISK_LOW },
    { key: 'device', categories: [ 'device' ], tier: RISK_LOW },
    { key: 'idle', categories: [ 'idle' ], tier: RISK_LOW },
    { key: 'nfc', categories: [ 'nfc' ], tier: RISK_LOW },
    { key: 'tracking-ping', categories: [ 'tracking-ping' ], tier: RISK_LOW },
    { key: 'tracking-pixel', categories: [ 'tracking-pixel' ], tier: RISK_LOW },
    // ── Medium risk ──
    { key: 'canvas', categories: [ 'canvas' ], tier: RISK_MEDIUM },
    { key: 'audio', categories: [ 'audio' ], tier: RISK_MEDIUM },
    { key: 'permissions', categories: [ 'permissions' ], tier: RISK_MEDIUM },
    { key: 'tracking-frame', categories: [ 'tracking-frame' ], tier: RISK_MEDIUM },
    // ── High risk ──
    { key: 'webrtc', categories: [ 'webrtc' ], tier: RISK_HIGH },
    // Untangled this session (see CHANGELOG) — was one merged checkbox
    // ("WebGL GPU fingerprint") spanning both categories, which hid the
    // fact that they now have independent mitigations/risk ratings (see
    // CATEGORY_SCRIPTLET_MAP above). Split into two so the checkbox bar
    // actually reflects that. Labels fall back to SHORT_LABELS (no
    // explicit `label` needed) — 'WebGL GPU access' for webgl, 'WebGL
    // GPU fingerprint' for webgl-fingerprint, already distinct.
    { key: 'webgl', categories: [ 'webgl' ], tier: RISK_HIGH },
    { key: 'webgl-fingerprint', categories: [ 'webgl-fingerprint' ], tier: RISK_HIGH },
    { key: 'tz-fingerprint', categories: [ 'tz-fingerprint' ], tier: RISK_HIGH },
    { key: 'clipboard', categories: [ 'clipboard' ], tier: RISK_HIGH },
    // Untangled this session (see CHANGELOG) — was one merged checkbox
    // ("Legitimate signals") spanning both categories, hidden by default
    // (defaultChecked:false) since neither had a Select mitigation and
    // there was nothing actionable to show. Per explicit follow-up
    // request, both are now checked by default like every other group —
    // now that they're properly classified (High risk) and explained by
    // fingerprintWarningBanner below, hiding them by default no longer fits
    // the rest of this session's design (a real signal a user should see
    // by default, not an edge case to opt into). Labels fall back to
    // SHORT_LABELS — 'Tracking beacons' for beacon, 'Device & network'
    // for legit-signals.
    { key: 'legit-signals', categories: [ 'legit-signals' ], tier: RISK_HIGH },
    { key: 'beacon', categories: [ 'beacon' ], tier: RISK_HIGH },   // (10.7.0) last, owner's request
];

// (10.7.0) The marker shown after the last group of each tier in the checkbox bar.
const TIER_MARKERS = Object.freeze({
    [RISK_LOW]: '[all low risk]',
    [RISK_MEDIUM]: '[all medium risk]',
    [RISK_HIGH]: '[all high risk]',
});

// TECHNICAL_LABELS — the underlying API/technique name. Used only in the
// "ⓘ" explanation dropdown (alongside LOGICAL_LABELS below), never shown
// on its own in the live monitor — an average user has no reason to know
// what "WebGL" or "tz-fingerprint" means to understand what's happening.
const TECHNICAL_LABELS = {
    webrtc: 'WebRTC', webgl: 'WebGL', canvas: 'Canvas', clipboard: 'Clipboard',
    history: 'History', beacon: 'Beacon', permissions: 'Permissions', audio: 'Audio',
    'webgl-fingerprint': 'GPU-fingerprint', 'tz-fingerprint': 'Time zone', 'navigator-plugins': 'Plugins',
    device: 'Battery', idle: 'Idle detection', nfc: 'NFC',
    'legit-signals': 'Legitimate-use signals',
    'tracking-ping': 'Hyperlink auditing (ping)', 'tracking-frame': '1x1 iframe', 'tracking-pixel': '1x1 / 3x3 image',
};

// LOGICAL_LABELS now lives in js/data/scriptlet-rule-labels.js (imported
// above) — single source of truth shared with dashboard/custom-rules.js's
// describeScriptletRule(), which maps a stored rule back to this same
// phrasing. See that module's header for the full rationale.

// SHORT_LABELS — used only for the "Show:" filter checkboxes. Most people
// click "Block All" without reading the filter bar closely, so it doesn't
// need the fuller phrasing LOGICAL_LABELS uses for the actual table rows
// (where someone IS reading closely, deciding whether to Select something)
// — a shorter bar also wraps less. Every category must have an entry here
// (falls back to LOGICAL_LABELS if one's ever missing, so nothing renders
// blank, but that fallback defeats the point — keep this list complete).
const SHORT_LABELS = {
    webrtc: 'WebRTC IP leak',
    webgl: 'WebGL GPU access',
    'webgl-fingerprint': 'GPU fingerprint',
    canvas: 'Canvas drawing',
    audio: 'Audio fingerprint',
    'tz-fingerprint': 'Time zone',
    'navigator-plugins': 'Installed plugins',
    device: 'Battery status',
    idle: 'Idle tracking',
    nfc: 'NFC wireless tap',
    clipboard: 'Clipboard access',
    beacon: 'Tracking beacons',
    permissions: 'Permission snooping',
    'legit-signals': 'Device & network',
    'tracking-ping': 'Tracking pings',
    'tracking-frame': '1x1 frames',
    'tracking-pixel': '1x1 and 3x3 images',
};

// Single source of truth for the "ⓘ" dropdown's explanation text — one
// entry per CATEGORIES value, shown next to that category's own label.
const CATEGORY_INFO = {
    webrtc: 'Opens a direct peer-to-peer connection, which can leak your real IP address, even behind a VPN.',
    webgl: 'Requests a canvas drawing context (2D or WebGL). Neutral on its own — precedes the actual canvas or GPU reads below.',
    canvas: 'Reads the pixel/image content of a canvas element. Classic canvas-fingerprinting technique.',
    clipboard: 'Reads or writes the system clipboard.',
    beacon: 'Sends a background request (navigator.sendBeacon), typically on page exit, for analytics — but also commonly used for crash/error reporting. No Select mitigation is offered here: sendBeacon is often called unguarded (no feature-detection), and abort-on-property-read throwing on read broke a real site (confirmed on bnr.nl). Use Block Monitor\u2019s DNR rule option instead for a destination-scoped block. Counts toward the aggregate signal banner at the top of this panel, alongside the device/network signals below.',
    permissions: 'Checks the status of a browser permission (e.g. camera, microphone, location).',
    audio: 'Creates an AudioContext to measure subtle audio-processing differences between devices. A recognisable silent technique, typical of audio fingerprinting.',
    'webgl-fingerprint': 'Specifically requests the GPU vendor/renderer string via the WEBGL_debug_renderer_info extension. Used almost exclusively for fingerprinting.',
    'tz-fingerprint': 'Reads this system\u2019s timezone setting. A light signal on its own, often combined with other techniques.',
    'navigator-plugins': 'Reads the (in modern browsers, almost always empty) plugin or MIME-type list. Barely any legitimate use left, so a strong fingerprinting signal.',
    device: 'Reads battery level and charging status. Firefox and Safari removed this API entirely — battery level plus charging time turned out to be a precise cross-session fingerprint, with no comparably strong legitimate use case (unlike gamepad presence, CPU core count, memory, touch points, or network info, none of which are tracked here anymore).',
    idle: 'Uses the Idle Detection API to monitor whether you\u2019re actively using your device. Almost no legitimate use outside a handful of explicit presence-status apps.',
    nfc: 'Accesses the Web NFC API (near-field communication). Virtually no legitimate use on an ordinary web page outside a dedicated NFC-reader app.',
    'legit-signals': 'Reads CPU core count, device memory, touch-point support, network connection info, or gamepad presence. Each of these has genuine, common, non-fingerprinting uses (worker-pool sizing, adaptive video quality, touch/gamepad UI) — no Select mitigation is offered here, since blocking any of them broke real sites. Tracked anyway, together with the Beacon, Audio, and Time zone categories, because reading several of these together is a recognisable fingerprinting pattern even though no single one is.',
    // (10.7.0) Tracking elements.
    'tracking-ping': 'A link carries a ping attribute: clicking it also sends a separate background request to a tracking address. Select removes the ping from this site\u2019s links; the links keep working.',
    'tracking-frame': 'An invisible frame of at most 1\u00d71 pixel loads another address \u2014 a common way to sync tracking cookies. Select stops frames from that one address on this site. Some sign-in services use such a frame to check your session.',
    'tracking-pixel': 'An image of 1\u00d71 or 3\u00d73 pixels is loaded \u2014 a tracking pixel: the image is invisible, its request reports your visit. Select stops images from that one address on this site.',
};
const TIMEOUT_MS = DEFAULT_SESSION_TIMEOUT_MS;
// (10.5.0, B1) Countdown clock units and refresh — named once.
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const CLOCK_SECONDS_DIGITS = 2;   // "4:05", not "4:5"
const CLOCK_TICK_MS = 500;        // refresh twice a second so the display never skips a second
const body = document.querySelector('#monitorBody');
const empty = document.querySelector('#monitorEmpty');
const host = document.querySelector('#monitorHost');
const timer = document.querySelector('#monitorTimer');
timer.textContent = format(TIMEOUT_MS);   // (10.5.0) derived start value — was a typed "5:00" in the HTML (C39a)
const pauseButton = document.querySelector('#monitorPause');
const blockAllButton = document.querySelector('#monitorBlockAll');
const blockLowButton = document.querySelector('#monitorBlockLow');
const blockMediumButton = document.querySelector('#monitorBlockMedium');
const exitButton = document.querySelector('#monitorExit');
const resumeButton = document.querySelector('#monitorResume');
const pausedBanner = document.querySelector('#monitorPausedBanner');
const pauseIndicator = document.querySelector('#monitorPauseIndicator');
const typeFilters = document.querySelector('#monitorTypeFilters');
const actionHead = document.querySelector('th.col-block');
let paused = false;
let clock = null;
// Tracks the site this session is inspecting — read by blockAll() after its
// batch finishes, to tell the background worker which host to (maybe)
// apply the auto-privacy extras to. Set once from the initial snapshot;
// a Privacy Inspector session never changes host mid-session.
let currentHost = '';
// Categories whose group defaults to unchecked (see FILTER_GROUPS) start
// OUT of the active set — their rows are hidden until someone opts in,
// not shown-then-immediately-filterable.
const active = new Set(
    FILTER_GROUPS.filter(g => g.defaultChecked !== false).flatMap(g => g.categories)
);

// ── Applied-mitigation tracking ─────────────────────────────────────────────
// Set of "hostname|name|args" keys with an already-existing Privacy-Inspector
// scriptlet rule — used to hide entries whose mitigation has already been
// applied entirely (see applyRowVisibility()), mirroring Block Monitor's own
// already-blocked-row treatment (monitor/monitor-panel.js). Previously this
// showed a red strikethrough via the shared .monitor-row--blocked class
// instead of hiding — changed for consistency with Block Monitor and because
// the strikethrough was hard to read once the dark-mode fix made it visible.
let appliedRules = new Set();

// ── Block All row registry ──────────────────────────────────────────────────
// Maps each <tr class="monitor-row"> currently in the table to the
// { entry, mapping } pair used to build its own "Select" rule (see
// appendRow() below). This is the single source of truth blockAll() reads
// to know what it can act on — it never re-derives entry/mapping from the
// DOM. Only rows with a resolvable scriptletMapping are registered (rows
// with no available mitigation are never candidates for Block All either,
// same restriction as their own "Select" button being disabled).
// GUARD: explicitly cleared in resume() whenever body is emptied, so it can
// never hold a reference to a row that no longer exists in the DOM.
const rowRegistry = new Map();

function clearRowRegistry() {
    rowRegistry.clear();
}

function appliedRuleKey(hostname, name, args) {
    return `${hostname}|${name}|${(args || []).join(',')}`;
}

// Re-fetches the authoritative rule list. Called on initial load and again
// after resume() (a rule may have just been added), so appendRow() always
// checks against current data rather than a stale snapshot taken once.
async function refreshAppliedRules() {
    const rules = await sendMessage({ what: MSG_GET_PRIVACY_SCRIPTLET_RULES });
    appliedRules = new Set(
        (Array.isArray(rules) ? rules : []).map(r => appliedRuleKey(r.hostname, r.name, r.args))
    );
}

for ( const [ index, group ] of FILTER_GROUPS.entries() ) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = group.defaultChecked !== false;
    input.dataset.categories = group.categories.join(',');
    const text = group.label ?? SHORT_LABELS[group.categories[0]] ?? LOGICAL_LABELS[group.categories[0]];
    label.append(input, document.createTextNode(` ${text}`));
    typeFilters.append(label);
    // (10.7.0) "[all … risk]" after the last group of a tier, then a line break so each tier gets its own row
    // (a tier never shares a line with the next one; the last tier needs no break).
    if ( FILTER_GROUPS[index + 1]?.tier !== group.tier && TIER_MARKERS[group.tier] ) {
        const marker = document.createElement('span');
        marker.className = 'type-filter-tier';
        marker.textContent = TIER_MARKERS[group.tier];
        typeFilters.append(marker);
        if ( index + 1 < FILTER_GROUPS.length ) {
            const rowBreak = document.createElement('span');
            rowBreak.className = 'type-filter-row-break';
            rowBreak.setAttribute('aria-hidden', 'true');
            typeFilters.append(rowBreak);
        }
    }
}

// Most logical names above already restate their technical term plainly
// (e.g. "WebRTC IP address leak" already says "WebRTC") — appending
// "(WebRTC)" after that would just repeat the same word. Only categories
// where the technical term is genuinely NOT restated in the logical name
// get the "(Technical)" suffix in the explanation dropdown/reference table.
// Single place for this decision, per this project's config-in-one-place
// convention — add a category here if its logical name changes and stops
// restating the technical term, or remove one that starts restating it.
const SHOW_TECHNICAL_SUFFIX = new Set([ 'webgl-fingerprint' ]);

function explanationLabel(category) {
    return SHOW_TECHNICAL_SUFFIX.has(category)
        ? `${LOGICAL_LABELS[category]} (${TECHNICAL_LABELS[category]})`
        : LOGICAL_LABELS[category];
}

// Sorted alphabetically by the plain-language name, not CATEGORIES' order —
// the explanation list reads top-to-bottom the same way a user would look
// something up, not in whatever order the underlying detection code
// happens to fire in. Technical name goes in parentheses after, not before
// — and only where it isn't already redundant (see explanationLabel above).
createInfoDropdown(
    typeFilters,
    CATEGORIES
        .slice()
        .sort((a, b) => LOGICAL_LABELS[a].localeCompare(LOGICAL_LABELS[b]))
        .map(category => ({
            label: explanationLabel(category),
            text: CATEGORY_INFO[category],
        }))
);

typeFilters.addEventListener('change', event => {
    const categoriesAttr = event.target.dataset.categories;
    if ( !categoriesAttr ) { return; }
    for ( const type of categoriesAttr.split(',') ) {
        if ( event.target.checked ) { active.add(type); } else { active.delete(type); }
    }
    for ( const row of body.querySelectorAll('tr.monitor-row') ) {
        applyRowVisibility(row);
    }
    updateFingerprintWarningBanner();
    updateEmpty(); updateBlockAllAvailability();
});

// Single source of truth for a row's hidden state — combines the two
// independent reasons a row can be hidden (its category is unchecked in
// the type-filter bar, OR it's already covered by an applied scriptlet
// rule) so neither can accidentally override the other. Mirrors Block
// Monitor's applyRowVisibility() (monitor/monitor-panel.js) — see
// CHANGELOG: an already-mitigated event is hidden entirely rather than
// shown struck-through, for the same reason Block Monitor's already-blocked
// rows are hidden rather than struck-through.
function applyRowVisibility(row) {
    row.hidden = !active.has(row.dataset.type) || row.dataset.mitigated === '1';
}

function updateEmpty() {
    empty.hidden = body.querySelector('tr.monitor-row:not([hidden])') !== null;
}
function format(ms) {
    const seconds = Math.ceil(Math.max(0, ms) / MS_PER_SECOND);
    return `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(CLOCK_SECONDS_DIGITS, '0')}`;
}
// GUARD: a hard timeout race, not just .catch() error handling — the
// previous version of this code only protected against sendMessage()
// REJECTING (e.g. "receiving end does not exist"), on the assumption that
// covered every failure mode. It didn't: MV3 service workers go dormant
// after ~30s idle, and this is a 5-minute countdown, so by the time it
// hits zero the service worker is almost always asleep and has to wake up
// to handle the stop message. There's a documented Chromium bug where, if
// the service worker terminates at exactly the wrong moment mid-wakeup,
// the message port can die without ever firing reject — the promise just
// hangs forever, and .catch()/.finally() attached to a promise that never
// settles never runs either. Confirmed as the actual cause of stale empty
// Privacy Inspector tabs being left open past the countdown, not fixed by
// the earlier .catch()+.finally() version despite that version's own
// comment claiming window.close() was guaranteed. Promise.race against a
// fixed timeout makes window.close() genuinely unconditional: it fires
// either when the stop message settles OR after STOP_MESSAGE_TIMEOUT_MS,
// whichever comes first, regardless of whether the message ever resolves.
const STOP_MESSAGE_TIMEOUT_MS = 1500;

async function stopInspectorAndCloseWindow() {
    stopPoll();
    try {
        await Promise.race([
            sendMessage({ what: MSG_STOP_PRIVACY_INSPECTOR }),
            new Promise(resolve => setTimeout(resolve, STOP_MESSAGE_TIMEOUT_MS)),
        ]);
    } catch {
        // sendMessage() itself already swallows its own retry failures and
        // resolves with undefined rather than rejecting (see ext.js) — this
        // catch is just defensive, in case that ever changes.
    }
    window.close();
}

function startClock(startTime, elapsed) {
    clearInterval(clock);
    function tick() {
        const remaining = TIMEOUT_MS - elapsed - (Date.now() - startTime);
        timer.textContent = format(remaining);
        // Session timed out while this panel was sitting open — stop it
        // properly (unregisters the probe) and close the now-stale window,
        // same sequence as clicking Exit, instead of leaving a blank/frozen
        // panel behind at 0:00. See stopInspectorAndCloseWindow() above for
        // why this needs a hard timeout, not just error handling.
        if ( remaining <= 0 ) {
            clearInterval(clock);
            stopInspectorAndCloseWindow();
        }
    }
    tick(); clock = setInterval(tick, CLOCK_TICK_MS);
}
// Aggregate fingerprinting-signal warning banner. Retargeted this
// session, per explicit request (see CHANGELOG) — used to fire once a
// 5-distinct-signal aggregate threshold was reached, gated on the
// "Legitimate signals"/"Beacon" checkboxes being checked, with text
// describing that count. Now fires for ANY High-risk row regardless of
// category (webrtc/webgl/clipboard/tz-fingerprint qualify too, not just
// legit-signals/beacon), with different, more general guidance text —
// no longer a signal-count readout, a general strategy tip. No longer
// gated on any specific filter-bar checkbox — High-risk categories are
// mostly visible by default, so a checkbox-visibility gate no longer
// matches this broader trigger. The old counting apparatus
// (legitSignalsSeen/thresholdReached/noteLegitSignal(), 5-signal
// threshold) is gone entirely, not left half-used — nothing else read
// it. "Seen once, stays shown" for the rest of the session.
const fingerprintWarningBanner = document.querySelector('#fingerprintWarningBanner');
let hasHighRiskSignal = false;

function updateFingerprintWarningBanner() {
    if ( fingerprintWarningBanner.hidden === !hasHighRiskSignal ) { return; }
    if ( hasHighRiskSignal ) {
        fingerprintWarningBanner.textContent =
            'Start with blocking low or medium risk fingerprints. When a website breaks, ' +
            'try blocking individual signals one by one.';
    }
    fingerprintWarningBanner.hidden = !hasHighRiskSignal;
}

function buildRow(entry) {
    const row = document.createElement('tr');
    row.className = 'monitor-row'; row.dataset.type = entry.category;

    // Computed here (not further down, where it used to live) since the
    // new Break risk cell needs it before the details/action cells are
    // built — same {name, args} shape used to decide the row's own
    // mitigated/Select-button state below, just needed earlier now.
    const scriptletMapping = scriptletMappingFor(entry);

    const cells = [ entry.elapsed, LOGICAL_LABELS[entry.category] || entry.category, entry.api ];
    for ( const [ index, value ] of cells.entries() ) {
        const cell = document.createElement('td');
        cell.className = [ 'col-elapsed', 'col-type', 'col-domain' ][index];
        cell.textContent = value;
        row.append(cell);
    }

    // Break risk — live, per-signal breakage-risk assessment computed
    // BEFORE any rule exists, by feeding this entry's own hypothetical
    // scriptlet mapping (scriptletMapping, same shape a "Select" click
    // would actually create) into the same evidence-based risk table a
    // saved rule is scored against (js/data/scriptlet-rule-labels.js).
    //
    // CATEGORY_RISK_OVERRIDE (module scope, above) takes precedence for
    // legit-signals/beacon — see its own comment for why: no
    // scriptletMapping exists for either, so the normal lookup always
    // returned null, which used to display as "no data available" even
    // though this project's own history has CONFIRMED, real-site
    // breakage for both under the same mechanism/evidence standard
    // RULE_INFO uses to justify High elsewhere.
    const risk = computeRisk(entry, scriptletMapping);
    const riskBadge = risk ? RISK_BADGE[risk.level] : RISK_BADGE[RISK_UNKNOWN];
    // Per explicit request: this banner (the red aggregate one, at the
    // top of the panel) used to fire once a 5-signal aggregate threshold
    // was reached (see updateFingerprintWarningBanner()'s own comment for
    // the full history). Retargeted to fire for ANY High-risk row,
    // regardless of category — webrtc/webgl/clipboard/tz-fingerprint all
    // qualify now too, not just legit-signals/beacon. Checked here,
    // unconditionally, right after risk is computed — not inside the
    // button-disabled branch below, since High-risk categories WITH a
    // working Select button should trigger this too.
    if ( risk?.level === RISK_HIGH ) {
        hasHighRiskSignal = true;
        updateFingerprintWarningBanner();
    }
    const riskCell = document.createElement('td');
    riskCell.className = 'col-break-risk';
    riskCell.textContent = riskBadge.glyph;
    riskCell.title = risk ? risk.reason : UNKNOWN_RISK_REASON_SIGNAL;
    riskCell.setAttribute('role', 'img');
    riskCell.setAttribute('aria-label', riskBadge.srLabel + ': ' + (risk ? risk.reason : UNKNOWN_RISK_REASON_SIGNAL));
    row.append(riskCell);

    const detailsCell = document.createElement('td');
    detailsCell.className = 'col-details';
    detailsCell.textContent = entry.details || entry.url || '';
    detailsCell.title = entry.url || '';
    row.append(detailsCell);

    // Already mitigated — hide the row entirely rather than showing it
    // struck-through, consistent with Block Monitor's already-blocked rows
    // (see applyRowVisibility() above and CHANGELOG). dataset.mitigated is
    // the single source of truth for this "hidden reason", kept separate
    // from the type-filter checkboxes' own reason (see applyRowVisibility()).
    row.dataset.mitigated = scriptletMapping &&
        appliedRules.has(appliedRuleKey(entry.host, scriptletMapping.name, scriptletMapping.args))
        ? '1' : '';
    applyRowVisibility(row);

    // Only rows with a working mitigation are candidates for Block All —
    // mirrors the "Select" button's own disabled/enabled split below.
    if ( scriptletMapping ) { rowRegistry.set(row, { entry, mapping: scriptletMapping }); }

    const action = document.createElement('td'); action.className = 'col-block'; action.hidden = !paused;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'cr-select-btn'; button.textContent = 'Select';
    if ( scriptletMapping ) {
        button.title = `Block this on ${entry.host} via the "${scriptletMapping.name}" scriptlet`;
        button.addEventListener('click', () => createScriptletRule(entry, scriptletMapping));
    } else {
        button.disabled = true;
        button.title = 'No precise website-specific protection is available for this event';
    }
    action.append(button); row.append(action);
    return row;
}

function appendRow(entry) {
    body.append(buildRow(entry));
    updateEmpty(); updateBlockAllAvailability();
}

// Single point of contact with the background worker for writing one
// Privacy-Inspector scriptlet rule — used by both the per-row "Select"
// button (createScriptletRule) and the "Block All" button (blockAll), so
// the request shape is defined exactly once. Does not resume() itself:
// callers decide when the panel should refresh (once per click for
// Select, once total after the whole batch for Block All).
async function addScriptletRule(entry, mapping) {
    const rule = { hostname: entry.host, name: mapping.name, args: mapping.args };
    return sendMessage({ what: MSG_ADD_PRIVACY_SCRIPTLET_RULE, rule });
}
async function createScriptletRule(entry, mapping) {
    const result = await addScriptletRule(entry, mapping);
    if ( result?.ok !== true ) { return; }
    await resume();
}

// Block All is only actionable while paused AND at least one currently
// visible row (i.e. not hidden by a type filter or already mitigated —
// see applyRowVisibility()) has a resolvable mitigation registered. Called
// after every row add/removal and after every visibility change, so the
// button's enabled state never drifts from what it would actually act on.
// Block All is only actionable while paused AND at least one currently
// visible row (i.e. not hidden by a type filter or already mitigated —
// see applyRowVisibility()) has a resolvable mitigation registered. Called
// after every row add/removal and after every visibility change, so the
// button's enabled state never drifts from what it would actually act on.
//
// Block Low Risk / Block Medium share this same "at least one blockable
// row" gate, ADDITIONALLY requiring at least one row at or under their
// own risk threshold — see blockableRowsUpToRisk() below. Ordinal, not a
// Set membership check: RISK_ORDER gives Low/Medium/High a numeric rank
// so "Low or Medium" is a single <= comparison, not an OR of two
// separate category-list checks that could drift out of sync with each
// other as categories are added.
const RISK_ORDER = { [RISK_LOW]: 0, [RISK_MEDIUM]: 1, [RISK_HIGH]: 2 };

function blockableRowsUpToRisk(maxLevel) {
    const targets = [];
    for ( const [ row, target ] of rowRegistry ) {
        if ( row.hidden ) { continue; }
        const risk = computeRisk(target.entry, target.mapping);
        // No risk data (RISK_ORDER[undefined] is undefined) never
        // qualifies for a tiered button — only "Block All" (which
        // doesn't filter by risk at all) can act on an Unknown-risk row.
        if ( risk && RISK_ORDER[risk.level] <= RISK_ORDER[maxLevel] ) { targets.push(target); }
    }
    return targets;
}

function updateBlockAllAvailability() {
    let hasBlockableRow = false;
    for ( const row of rowRegistry.keys() ) {
        if ( row.hidden ) { continue; }
        hasBlockableRow = true; break;
    }
    blockAllButton.disabled = !paused || !hasBlockableRow;
    blockLowButton.disabled = !paused || blockableRowsUpToRisk(RISK_LOW).length === 0;
    blockMediumButton.disabled = !paused || blockableRowsUpToRisk(RISK_MEDIUM).length === 0;
}

// Shared batch-write core for all three block buttons — takes the
// already-filtered target list and the button that triggered it, so
// blockAll()/blockLowRisk()/blockMedium() are each a one-line call
// instead of three near-identical copies of this same sequential-write/
// re-entrancy-guard/resume dance (see B15 — consolidate near-duplicates,
// don't maintain them in parallel).
async function blockTargets(targets, triggerButton) {
    if ( triggerButton.disabled ) { return; }
    triggerButton.disabled = true;
    try {
        for ( const { entry, mapping } of targets ) {
            await addScriptletRule(entry, mapping);
        }
        if ( targets.length > 0 ) {
            await sendMessage({ what: MSG_APPLY_PRIVACY_EXTRAS, hostname: currentHost });
        }
    } finally {
        await resume();
    }
}

// Writes a rule for every currently visible, blockable row in one batch,
// then refreshes the panel once. Sequential (not Promise.all) — each write
// goes through the background worker's own storage read-modify-write cycle
// (addCustomScriptletRule()), so serializing avoids concurrent writers
// racing on the same stored array. Re-entrancy guard (disabling the button
// for the duration) is needed because the sequential awaits otherwise leave
// a window where a second click could start an overlapping batch.
//
// After the whole batch succeeds, sends ONE MSG_APPLY_PRIVACY_EXTRAS for
// this session's host — this (not the per-row "Select" button) is what
// triggers applyPrivacyExtrasForHost() in custom-scriptlets.js, which now
// applies unconditionally (7.0.0 removed the old manual dashboard toggle
// this used to be gated on).
async function blockAll() {
    const targets = [];
    for ( const [ row, target ] of rowRegistry ) {
        if ( row.hidden ) { continue; }
        targets.push(target);
    }
    await blockTargets(targets, blockAllButton);
}

// Cumulative by design (a risk THRESHOLD, not an exact-tier filter) — per
// explicit request, "Block Medium" blocks Low+Medium together, not Medium
// alone. Consistent with how the three button colours already read as an
// escalating scale (green -> yellow -> red), not three independent,
// unrelated buckets.
async function blockLowRisk() {
    await blockTargets(blockableRowsUpToRisk(RISK_LOW), blockLowButton);
}

async function blockMedium() {
    await blockTargets(blockableRowsUpToRisk(RISK_MEDIUM), blockMediumButton);
}

function setPaused(value) {
    paused = value;
    pausedBanner.hidden = !value; pauseIndicator.hidden = !value;
    pauseButton.hidden = value; actionHead.hidden = !value;
    for ( const cell of body.querySelectorAll('td.col-block') ) { cell.hidden = !value; }
    if ( value ) { clearInterval(clock); }
    updateBlockAllAvailability();
}
async function pause() { await sendMessage({ what: MSG_PAUSE_PRIVACY_INSPECTOR }); setPaused(true); }
async function resume() {
    await sendMessage({ what: MSG_RESUME_PRIVACY_INSPECTOR });
    await refreshAppliedRules();
    body.textContent = ''; clearRowRegistry(); setPaused(false);
    // BUG FIX (regression of the 6.0.7 "stale empty tab" fix): setPaused(true)
    // in pause() clears the countdown interval (see setPaused()'s own
    // `if (value) { clearInterval(clock); }`), but nothing here ever
    // restarted it afterwards — resuming left the on-screen countdown
    // frozen and, more importantly, permanently disabled the
    // auto-close-at-timeout logic living inside startClock()'s tick() for
    // the rest of the session (that logic only runs while `clock`'s
    // interval is alive). Since every normal "Select"/"Block All"
    // interaction goes through pause() then resume() — see blockAll()'s
    // `finally { await resume(); }` above, and #monitorHelp's own
    // instructions ("Pause the inspector, then use Select...") — this
    // silently broke auto-close on the single most common user flow, not
    // some rare edge case, which is why it kept resurfacing as "stale
    // empty tabs" despite the earlier fix.
    // Re-fetch a fresh snapshot rather than reuse any locally-cached
    // startTime/timeElapsed: resumePrivacyInspector() resets
    // session.startTime server-side while carrying session.timeElapsed
    // forward unchanged (see js/core/privacy-inspector.js), so the
    // snapshot is the only authoritative source for those two values —
    // same one the initial-load path below already relies on, not a
    // second, parallel way of getting this data that could drift from it.
    const snapshot = await sendMessage({ what: MSG_GET_PRIVACY_INSPECTOR_DATA });
    if ( !snapshot ) {
        // Session expired in the background in the instant between
        // resumePrivacyInspector() resetting startTime and this fetch —
        // extremely narrow window, but same "no session, no reason for
        // this panel to still be open" handling as the initial-load path
        // below (`if (!snapshot) window.close();`), for consistency.
        stopPoll();
        window.close();
    } else if ( snapshot.session.phase === 'running' ) {
        startClock(snapshot.session.startTime, snapshot.session.timeElapsed);
    }
}
// Independent poll — second safety net alongside the broadcast listener
// below, mirroring monitor-panel.js's own refresh()/SESSION_POLL_MS
// exactly (same 15s interval, same "ask the background directly" check).
// Catches the case neither the client-side clock (this file's own
// startClock()/tick()) nor the MSG_PRIVACY_INSPECTOR_CLOSED broadcast
// manage to close this tab — e.g. if this tab's own timers got throttled
// by the browser while backgrounded, which is the plausible mechanism
// for exactly the "stale empty tab" bug this file has already had two
// documented rounds of fixes for (see stopInspectorAndCloseWindow()'s own
// comment above, and CHANGELOG 6.0.7 / its regression fix) — those
// rounds hardened the client-side clock path itself, but never added an
// independent path that doesn't depend on this tab's own timers firing
// at all, which is what this poll (and the broadcast listener below) are
// for.
const PRIVACY_INSPECTOR_POLL_MS = 15000;
let pollHandle = null;
function startPoll() {
    stopPoll();
    pollHandle = setInterval(async () => {
        const snap = await sendMessage({ what: MSG_GET_PRIVACY_INSPECTOR_DATA });
        if ( !snap ) { stopPoll(); window.close(); }
    }, PRIVACY_INSPECTOR_POLL_MS);
}
// GUARD: always stop any previous poll before closing — same discipline
// as monitor-panel.js's own stopPoll(), so a lingering interval can never
// keep firing sendMessage() calls into a background session that's
// already gone (self.close() would eventually discard it anyway once the
// tab actually closes, but an explicit clear is the same "release
// resources, don't just let the tab teardown implicitly handle it"
// convention this codebase already follows elsewhere).
function stopPoll() {
    if ( pollHandle !== null ) {
        clearInterval(pollHandle);
        pollHandle = null;
    }
}

pauseButton.addEventListener('click', pause);
blockAllButton.addEventListener('click', blockAll);
blockLowButton.addEventListener('click', blockLowRisk);
blockMediumButton.addEventListener('click', blockMedium);
resumeButton.addEventListener('click', resume);
exitButton.addEventListener('click', stopInspectorAndCloseWindow);

const broadcastChannel = new BroadcastChannel('uBOL');
broadcastChannel.onmessage = event => {
    const message = event.data;
    if ( message?.what === MSG_PRIVACY_INSPECTOR_ENTRY ) {
        if ( !paused ) { appendRow(message.entry); }
        return;
    }
    if ( message?.what === MSG_PRIVACY_INSPECTOR_CLOSED ) {
        // The background already tore down the session and told us why —
        // no need to round-trip another stop message through
        // stopInspectorAndCloseWindow() (that function exists for the
        // opposite direction: telling the background to stop). Just clean
        // up this tab's own resources and close.
        clearInterval(clock);
        stopPoll();
        broadcastChannel.close();
        window.close();
    }
};

const snapshot = await sendMessage({ what: MSG_GET_PRIVACY_INSPECTOR_DATA });
if ( !snapshot ) { window.close(); } else {
    currentHost = snapshot.session.host;
    host.textContent = currentHost;
    await refreshAppliedRules();
    const fragment = document.createDocumentFragment();
    for ( const entry of snapshot.entries ) { fragment.append(buildRow(entry)); }
    body.append(fragment);
    updateEmpty(); updateBlockAllAvailability();
    setPaused(snapshot.session.phase === 'paused');
    if ( snapshot.session.phase === 'running' ) { startClock(snapshot.session.startTime, snapshot.session.timeElapsed); }
    startPoll();
}
