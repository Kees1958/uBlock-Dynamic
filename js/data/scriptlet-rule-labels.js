/*
 * scriptlet-rule-labels.js — plain-language names AND breakage-risk
 * indicators for Privacy Inspector signals/mitigations, shared between
 * the Privacy Inspector panel (privacy/privacy-inspector.js) and the
 * dashboard's "Manage custom rules" pane (dashboard/custom-rules.js).
 *
 * Why this exists (UX bug it fixes): the Monitor already shows every
 * signal using a layman's-term label ("WebGL Graphics access", "Hidden
 * canvas drawing test", etc.) — LOGICAL_LABELS below. But a rule created
 * via the Monitor's own "Select"/"Block All" buttons is stored as a raw
 * scriptlet call — e.g. {name: 'abort-on-property-read',
 * args: ['navigator.clipboard.readText']} — and the dashboard's custom-
 * rules list used to render exactly that technical shape verbatim, with
 * no indication of which of these mitigations are more likely to break a
 * site. describeScriptletRule()/getScriptletRuleRisk() below close both
 * gaps by pattern-matching a stored rule's {name, args} back to (a) the
 * same LOGICAL_LABELS phrase the Monitor used to create it, and (b) a
 * risk tier — one direction of a mapping that already exists in the
 * other direction as privacy-inspector.js's own CATEGORY_SCRIPTLET_MAP.
 *
 * ── Risk tier rationale ──────────────────────────────────────────────────
 * Two objective, code-visible criteria, not a guess per rule:
 *   1. Mechanism: abort-on-property-read/nowebrtc THROW on read/use,
 *      which breaks any unguarded call site outright — this project has
 *      two confirmed real-site breakages from exactly that mechanism
 *      (sendBeacon abort broke bnr.nl; hardwareConcurrency/deviceMemory/
 *      maxTouchPoints abort broke nos.nl — see CATEGORY_SCRIPTLET_MAP's
 *      own comments in privacy-inspector.js, both since removed from
 *      Monitor's offered mitigations for exactly that reason). By
 *      contrast, prevent-canvas returns null instead of throwing — code
 *      that feature-detects canvas support (very common) degrades
 *      gracefully instead of crashing.
 *   2. How common legitimate (non-fingerprinting) use of the underlying
 *      API is on ordinary sites — a throw on a widely-used API (clipboard,
 *      timezone formatting) is far more likely to hit real page code than
 *      the same throw on a rarely-used one (NFC, Idle Detection).
 * 'low' tier entries are still shown with a badge (not omitted) per
 * explicit request — a confirmed-safe indicator is as useful as a
 * confirmed-risky one, not just an absence of warning.
 *
 * Public interface:
 *   LOGICAL_LABELS              — category -> plain-language string
 *                                  (moved here verbatim from
 *                                  privacy-inspector.js, which now imports
 *                                  it from here instead of declaring its
 *                                  own copy)
 *   describeScriptletRule(rule) — {name, args} -> plain-language string,
 *                                  or null if this isn't a rule shape any
 *                                  known Privacy Inspector mitigation
 *                                  produces (e.g. a sandbox-hand-authored
 *                                  rule like `##+js(noeval)`) — callers
 *                                  should fall back to showing the raw
 *                                  technical name+args in that case.
 *   getScriptletRuleRisk(rule)  — {name, args} -> {level, reason} where
 *                                  level is 'high'|'medium'|'low', or null
 *                                  for an unrecognized rule shape (same
 *                                  fallback case as above — no risk data
 *                                  exists for a rule this module doesn't
 *                                  recognize, so no badge should be shown,
 *                                  not a misleading default).
 *   getScriptletRuleApi(rule)   — {name, args} -> the exact technical API
 *                                  name/list Privacy Inspector's own live
 *                                  Monitor table would show for this same
 *                                  signal (e.g. 'readText', 'getContext,
 *                                  toDataURL, toBlob, getImageData'), or
 *                                  null for an unrecognized rule shape.
 */

/******************************************************************************/
// LOGICAL_LABELS — plain-language name for what's actually happening,
// understandable without knowing any of the underlying API names. See
// privacy-inspector.js's TECHNICAL_LABELS for the paired technical name,
// shown alongside this one in that panel's "ⓘ" explanation dropdown.
/******************************************************************************/

export const LOGICAL_LABELS = {
    webrtc: 'WebRTC IP address leak',
    webgl: 'WebGL graphics access',
    canvas: 'Hidden canvas drawing test',
    'webgl-fingerprint': 'Graphics card fingerprint',
    audio: 'Audio sound card fingerprint',
    'tz-fingerprint': 'Time zone check',
    'navigator-plugins': 'Installed plugins list',
    device: 'Battery status tracking',
    idle: 'Idle activity tracking',
    nfc: 'NFC wireless tap access',
    clipboard: 'Clipboard access',
    beacon: 'Silent beacon tracking',
    permissions: 'Permission snooping',
    'legit-signals': 'Device & network check',
    // (10.7.0) Tracking elements — page elements, not API calls (privacy-probe.js "Tracking elements").
    'tracking-ping': 'Link click pings',
    'tracking-frame': 'Hidden 1x1 tracking frame',
    'tracking-pixel': 'Tracking pixel image',
};

/******************************************************************************/
// Config — single source of truth for the three risk-tier identifiers,
// so both this module and every consumer (dashboard/custom-rules.js)
// reference the same three literal strings instead of retyping them.
/******************************************************************************/

export const RISK_HIGH = 'high';
export const RISK_MEDIUM = 'medium';
export const RISK_LOW = 'low';

/******************************************************************************/
// Rule table — stored rule shape -> {label, risk, reason}. Mirrors
// privacy-inspector.js's CATEGORY_SCRIPTLET_MAP exactly (same scriptlet
// names, same args shapes), just walked in the opposite direction. Kept
// as an ordered list (not a plain object keyed by name) because several
// entries share the same scriptlet `name` and are only distinguished by
// `args[0]` — first match wins. label and risk are read together (one
// table, not two lists that could drift out of sync with each other).
/******************************************************************************/

function arg0(args) { return (Array.isArray(args) && typeof args[0] === 'string') ? args[0] : ''; }

// Several entries below cover more than one arg0 value (clipboard's four
// methods, plugins/mimeTypes, audio's two constructors) whose Monitor
// 'api' value is always just the last dotted segment of that same arg0 —
// e.g. 'navigator.clipboard.readText' -> 'readText'. One shared helper
// instead of hand-writing that per entry, so the value can't drift from
// the args it's actually being derived from.
function lastSegment(args) { return arg0(args).split('.').pop(); }
// (10.7.0) Second argument — prevent-element-src-loading's URL match.
function arg1(args) { return (Array.isArray(args) && typeof args[1] === 'string') ? args[1] : ''; }

const RULE_INFO = [
    // (10.7.0) Tracking elements (privacy-inspector.js CATEGORY_SCRIPTLET_MAP: tracking-ping/-frame/-pixel).
    { name: 'remove-attr', match: a => arg0(a) === 'ping',
      label: LOGICAL_LABELS['tracking-ping'],
      risk: RISK_LOW,
      reason: 'Only removes the ping attribute from links: the link itself still opens normally, only the extra tracking request on click is not sent.',
      api: ( ) => 'a[ping]' },
    { name: 'prevent-element-src-loading', match: a => arg0(a) === 'img',
      label: LOGICAL_LABELS['tracking-pixel'],
      risk: RISK_LOW,
      reason: 'Stops only images from this one address on this site. A 1x1 or 3x3 image is invisible, so nothing on the page changes.',
      api: a => `img ${arg1(a)}` },
    { name: 'prevent-element-src-loading', match: a => arg0(a) === 'iframe',
      label: LOGICAL_LABELS['tracking-frame'],
      risk: RISK_MEDIUM,
      reason: 'Stops only frames from this one address on this site. Usually tracking, but some sign-in services use a hidden frame to check whether you are still logged in.',
      api: a => `iframe ${arg1(a)}` },
    { name: 'nowebrtc', match: ( ) => true,
      label: LOGICAL_LABELS.webrtc,
      risk: RISK_HIGH,
      reason: 'Breaks video/voice calling and any other WebRTC-based feature entirely — the connection attempt throws instead of falling back.',
      api: ( ) => 'RTCPeerConnection' },

    // Untangled this session (see CHANGELOG) — 'webgl' and 'canvas' used
    // to share one combined entry below (no contextType arg, blocking
    // everything at once). Each now has its own contextType-scoped
    // prevent-canvas call (see CATEGORY_SCRIPTLET_MAP in
    // privacy-inspector.js) and its own risk rating. The old combined,
    // no-arg entry is KEPT below as a fallback, matched only when
    // neither of these two more-specific entries matches first (order
    // matters — first match wins) — a rule saved before this change
    // still gets a sensible risk badge instead of falling through to
    // "no data available".
    { name: 'prevent-canvas', match: a => arg0(a) === 'webgl',
      label: 'WebGL graphics access',
      risk: RISK_HIGH,
      reason: 'Blocks WebGL/WebGL2 context creation outright. Real, common uses beyond fingerprinting — WebGL-based games, 3D visualizations, map renderers, some video effects — stop working entirely, not just degrade.',
      api: ( ) => 'getContext' },
    { name: 'prevent-canvas', match: a => arg0(a) === '2d',
      label: 'Canvas drawing access',
      risk: RISK_MEDIUM,
      reason: 'Returns null instead of throwing for the 2D context specifically, so most feature-detecting code degrades gracefully — but canvas also has real, non-fingerprinting 2D uses (image editors, chart libraries, simple games) that can stop working.',
      api: ( ) => 'getContext, toDataURL, toBlob, getImageData' },
    // prevent-canvas is written with no contextType arg (blocks every
    // canvas context type at once) by three different Monitor categories
    // (webgl, canvas, webgl-fingerprint — see CATEGORY_SCRIPTLET_MAP's
    // own comment on why one rule covers all three). None of LOGICAL_LABELS'
    // three individual phrasings is fully accurate alone once applied as
    // a block, so this gets its own combined phrase instead of picking
    // one of the three arbitrarily. Same reasoning for `api`: this one
    // rule actually intercepts four distinct methods at once (see
    // privacy-probe.js's canvasBlocked-gated wrapMethod calls) — listing
    // all four here is more accurate than picking just one.
    { name: 'prevent-canvas', match: ( ) => true,
      label: 'Canvas & WebGL fingerprinting blocked',
      risk: RISK_MEDIUM,
      reason: 'Returns null instead of throwing, so most feature-detecting code degrades gracefully — but canvas also has real, non-fingerprinting uses (image editors, games, chart libraries) that can stop working.',
      api: ( ) => 'getContext, toDataURL, toBlob, getImageData' },

    { name: 'abort-on-property-read', match: a => arg0(a) === 'navigator.permissions.query',
      label: LOGICAL_LABELS.permissions,
      risk: RISK_MEDIUM,
      reason: 'Throws on read. Some sites check permission status as part of a normal camera/microphone/location prompt flow.',
      api: ( ) => 'query' },
    { name: 'abort-on-property-read', match: a => arg0(a) === 'Intl.DateTimeFormat.prototype.resolvedOptions',
      label: LOGICAL_LABELS['tz-fingerprint'],
      risk: RISK_HIGH,
      reason: 'Throws on read. Timezone/locale-aware date formatting is extremely common and rarely guarded against a throw here.',
      api: ( ) => 'resolvedOptions' },
    { name: 'abort-on-property-read', match: a => arg0(a) === 'IdleDetector',
      label: LOGICAL_LABELS.idle,
      risk: RISK_LOW,
      reason: 'Idle Detection is a rare, niche API — very unlikely to be used by ordinary site code you depend on.',
      api: ( ) => 'IdleDetector' },
    { name: 'abort-on-property-read', match: a => arg0(a) === 'NDEFReader',
      label: LOGICAL_LABELS.nfc,
      risk: RISK_LOW,
      reason: 'Web NFC is a rare, niche API outside dedicated NFC-reader apps — very unlikely to be used by ordinary site code you depend on.',
      api: ( ) => 'NDEFReader' },
    { name: 'abort-on-property-read', match: a => arg0(a) === 'OfflineAudioContext' || arg0(a) === 'AudioContext',
      label: LOGICAL_LABELS.audio,
      risk: RISK_MEDIUM,
      reason: 'Throws on use. Web Audio also has legitimate playback/processing uses beyond audio fingerprinting.',
      api: lastSegment },
    { name: 'abort-on-property-read', match: a => arg0(a).startsWith('navigator.clipboard.'),
      label: LOGICAL_LABELS.clipboard,
      risk: RISK_HIGH,
      reason: 'Throws on read. Breaks copy/paste features on any site whose UI relies on the Clipboard API (e.g. "Copy link" buttons).',
      api: lastSegment },
    { name: 'abort-on-property-read', match: a => arg0(a) === 'navigator.plugins' || arg0(a) === 'navigator.mimeTypes',
      label: LOGICAL_LABELS['navigator-plugins'],
      risk: RISK_LOW,
      reason: 'NPAPI plugins have been gone from browsers for years — almost no legitimate site code still reads this.',
      api: lastSegment },
    { name: 'abort-on-property-read', match: a => arg0(a) === 'navigator.getBattery',
      label: LOGICAL_LABELS.device,
      risk: RISK_LOW,
      reason: 'Firefox and Safari removed the Battery Status API entirely, so sites that depend on it already have to handle it being absent.',
      api: lastSegment },

    // "Auto-privacy extras" — not tied to a single Monitor category/Select
    // button like everything above; these two are added automatically,
    // together, when "Block All" is clicked (see custom-scriptlets.js's
    // AUTO_PRIVACY_RULES / applyPrivacyExtrasForHost()). Exact args are
    // fixed/hardcoded there (never user-varied), so match on the full
    // args array, not just arg0. Also, unlike every entry above, these
    // two are never actually reported through privacy-probe.js's live
    // report() mechanism at all — Block All applies them silently as a
    // fixed pair, they don't appear as their own Monitor table rows — so
    // `api` here is the closest natural analog (the property/event name
    // itself) rather than a value ever literally shown in the Monitor.
    { name: 'set-constant', match: a => arg0(a) === 'name',
      label: 'Window name tracking blocked',
      risk: RISK_LOW,
      reason: 'Silently keeps window.name empty instead of throwing. Rare in modern sites — window.name as a data-passing technique was mostly superseded by postMessage years ago.',
      api: ( ) => 'name' },
    { name: 'prevent-addEventListener', match: a => arg0(a) === 'visibilitychange',
      label: 'Tab visibility tracking blocked',
      risk: RISK_MEDIUM,
      reason: 'Silently no-ops instead of throwing, so nothing crashes — but visibilitychange is also legitimately used to pause video/audio or reduce work when a tab is hidden, which will simply stop happening.',
      api: ( ) => 'visibilitychange' },

    // Added — previously MISSING from this table entirely, which is
    // exactly why the Monitor and "Manage custom rules" disagreed:
    // privacy-inspector.js's own CATEGORY_RISK_OVERRIDE hardcoded these
    // two categories to 'high' for its LIVE badge (see that override's
    // own reasoning, copied into these two reasons below), but a SAVED
    // rule of the same shape had no matching entry here at all, so
    // getScriptletRuleRisk() returned null for it and the dashboard's
    // "Manage custom rules" list fell back to the ⚪ unknown badge
    // instead. Adding the real entries here (matching the override's own
    // level+reason exactly) fixes the divergence at its root — both
    // views now read the same table, so they can't drift apart again
    // the way an unmirrored override always eventually does (see this
    // project's own reuse-a-proven-fix principle). The override itself
    // is removed from privacy-inspector.js as part of this same fix.
    { name: 'abort-on-property-read', match: a => arg0(a) === 'navigator.sendBeacon',
      label: LOGICAL_LABELS.beacon,
      risk: RISK_HIGH,
      reason: 'Blocking this already confirmed breakage on a real site (bnr.nl) — sendBeacon is commonly called unguarded for analytics and crash/error reporting alike. You can still select it — this red badge is the warning.',
      api: lastSegment },
    { name: 'abort-on-property-read', match: a => [
          'navigator.hardwareConcurrency', 'navigator.deviceMemory',
          'navigator.maxTouchPoints', 'navigator.connection', 'navigator.getGamepads',
      ].includes(arg0(a)),
      label: LOGICAL_LABELS['legit-signals'],
      risk: RISK_HIGH,
      reason: 'Blocking these already confirmed breakage on a real site (nos.nl) — hardwareConcurrency/deviceMemory/maxTouchPoints are read unguarded by worker-pool sizing and adaptive-quality logic. You can still select it — this red badge is the warning.',
      api: lastSegment },
];

/******************************************************************************/

function findRuleInfo(rule) {
    if ( !rule || typeof rule.name !== 'string' ) { return null; }
    for ( const entry of RULE_INFO ) {
        if ( entry.name !== rule.name ) { continue; }
        try {
            if ( entry.match(rule.args) ) { return entry; }
        } catch { /* benign: malformed args on a hand-edited rule — fall through (11.1.0: module now in the SW graph via breakage-risk.js) */ }
    }
    return null;
}

// rule: {name, args}. Returns a plain-language string for any rule shape
// a known Privacy Inspector mitigation produces, or null for anything
// else (e.g. a sandbox-hand-authored scriptlet rule with no Monitor
// equivalent — noeval, set-constant, prevent-addEventListener, etc.).
// Callers should fall back to the raw technical name+args in the null
// case, not hide the rule or show a blank label.
export function describeScriptletRule(rule) {
    return findRuleInfo(rule)?.label ?? null;
}

// rule: {name, args}. Returns {level, reason} for any rule shape a known
// Privacy Inspector mitigation produces, or null for anything else — see
// describeScriptletRule()'s comment above for the same fallback case.
// Callers should show no risk badge at all in the null case, not a
// default/guessed level.
export function getScriptletRuleRisk(rule) {
    const info = findRuleInfo(rule);
    return info ? { level: info.risk, reason: info.reason } : null;
}

// rule: {name, args}. Returns the exact technical API name (or, for
// prevent-canvas, comma-separated names — see that entry's own comment)
// Privacy Inspector's live Monitor table would show for this signal, or
// null for anything else — same fallback case as the two functions above.
export function getScriptletRuleApi(rule) {
    const info = findRuleInfo(rule);
    return info ? info.api(rule.args) : null;
}

