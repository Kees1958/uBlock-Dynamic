/*
 * matrix-panel.js — "Dynamic DNR filtering" panel frontend
 *
 * Column/header/row-rendering approach adapted from 3P-Matrix-lite's own
 * ui/matrix-panel.js (grouped column model, two-row header, one row per
 * domain, click-to-override mini-squares) but reworked per explicit
 * design feedback into two MODES rather than a flat Allow/Block split:
 *
 *   - "Block mode" (default — the mode switch set to SHOW ALLOWED): the
 *     panel filters to show ONLY domains NOT already blocked, so only
 *     domains still worth blocking are listed. The BLOCK/3P-all / 3P-code
 *     cells read BLOCK — clicking sets a 'block' override. Default
 *     because finding new domains worth blocking is the more common
 *     first action.
 *   - "Allow mode" (switch set to SHOW BLOCKED): the panel filters the
 *     OTHER way — it shows ONLY domains already blocked elsewhere
 *     (static filter lists or a prior override),
 *     since those are the only domains an ALLOW click could meaningfully
 *     change. The same two cells now read ALLOW — clicking sets an
 *     'allow' override instead. Useful for carving out exceptions on a
 *     site that's broken by over-blocking.
 *
 * The filter is ALWAYS active (in both modes) — it isn't an optional
 * "show all" toggle, it's a mode-dependent relevance filter: ALLOW mode
 * (SHOW BLOCKED) hides what ISN'T already blocked, BLOCK mode (SHOW
 * ALLOWED) hides what IS. See isEntryHiddenForMode() below for the
 * single source of truth for this.
 *
 * The two columns (3P-all / 3P-code) are ALWAYS present; only their
 * header label (BLOCK vs ALLOW) and what a click writes depend on the
 * current mode. An override, once set, keeps showing its own color
 * (red=block, green=allow) regardless of which mode you're currently
 * viewing in — only NEW clicks are mode-dependent.
 *
 * Overrides are PER-SITE (confirmed against real 3P-Matrix-lite, which is
 * global — deliberately different here): blocking badsite.com while
 * browsing example.org does not block it on other.com. See
 * js/core/matrix-block-rules.js's header for the full design.
 *
 * Renames from 3P-Matrix-lite's original column labels (per this fork's
 * spec — see CHANGELOG):
 *   INTERNAL WHITELIST + LEVEL MODE -> merged back into one column
 *     ("known DDG Tracker" breakage-risk verdict) in an earlier version
 *     of this panel. REMOVED entirely this release, per explicit
 *     request — judged obsolete now that Worry-Free mode's additional
 *     filtering already stops most trackers, making the old breakage-
 *     risk hint largely redundant. Replaced by a much simpler "more
 *     info" indicator (see infoMarkerState() below) showing only
 *     whether this domain has more than one matching filter rule worth
 *     looking at — no risk judgment implied.
 *     (11.1.0, owner's request) A breakage-risk column is BACK, as "Break
 *     risk", on new evidence: built-in whitelist = high, a tracker-list
 *     allow exception (AdGuard / EFF Privacy Badger) = medium, DDG Tracker
 *     Radar = low, none = unknown — see js/core/breakage-risk.js. Same
 *     badges and reason tooltips as the Fingerprint Inspector.
 *   SCRIPT/FRAME (separate Allow/Block columns) -> one informational
 *     "3P CODE" checkmark column (uses 3P script and/or frame requests,
 *     yes/no — not clickable) plus the new BLOCK/ALLOW 3P-all/3P-code
 *     columns described above.
 *
 * ── LAYOUT (10.7.9, reorganised — no behaviour change) ─────────────────
 *    1. Imports                    10. Cell rendering
 *    2. Config                     11. Rows (render, upsert, visibility pass, stats)
 *    3. DOM references             12. Rule-detail pipeline (pure)
 *    4. Panel state                13. Rule-detail rows (fetch, expand, collapse)
 *    5. Mode                       14. Table click handlers + mode switch
 *    6. Column model               15. Session clock, poll and close
 *    7. Intro text                 16. REFRESH button
 *    8. Header                     17. Broadcast messages
 *    9. Block verdict + visibility 18. Bootstrap
 */

/* ══════════════════════════════════════════════════════════════
   1. IMPORTS
   ══════════════════════════════════════════════════════════════ */

// theme.js (dark/light/mobile/desktop classes on <html>) is now loaded via
// a <script> tag in matrix-panel.html, same as every other panel in this
// extension (dashboard/popup/picker/Privacy Inspector) — standardized to
// one mechanism, not a JS import here and a script tag everywhere else.

import { dom, qs$ } from '../js/ui/dom.js';
import { sendMessage } from '../js/data/ext.js';
import { BROADCAST_CHANNEL_NAME } from '../js/data/broadcast.js';   // the SW -> panel channel's ONE name
import { loadRulesetDetailsMap } from '../js/data/ruleset-details-loader.js';
import { isDescendantHostnameOfIter } from '../js/util/utils.js';
import { DEFAULT_SESSION_TIMEOUT_MS } from '../js/data/timing-constants.js';
import { DNR_TRACKING_FILTER_NAME, WORRY_FREE_NAME } from '../js/data/ui-names.js';
import { RISK_HIGH, RISK_MEDIUM, RISK_LOW } from '../js/data/scriptlet-rule-labels.js';
import { RISK_BADGE, RISK_UNKNOWN, DOMAIN_RISK_REASON } from '../js/data/risk-badge.js';
import {
    MSG_MATRIX_ENTRY,
    MSG_MATRIX_CLOSED,
    MSG_START_MATRIX,
    MSG_STOP_MATRIX,
    MSG_GET_MATRIX_DATA,
    MSG_MATRIX_SET_OVERRIDE,
    MSG_MATRIX_SET_OVERRIDES,
    MSG_RELOAD_MATRIX_TAB,
    MSG_GET_DOMAIN_RULE_DETAIL,
} from '../js/data/message-types.js';

/* ══════════════════════════════════════════════════════════════
   2. CONFIG  —  every constant, threshold and fixed text, declared once
   ══════════════════════════════════════════════════════════════ */

const TIMEOUT_MS = DEFAULT_SESSION_TIMEOUT_MS;

// (10.5.0) "More info" colour tiers — how many matching filter rules a domain has. The ONE place for
// the threshold: the marker colour (infoTierForCount) and both help texts derive from it (C39a; the
// texts used to type "1" / "2 or more" / "0=grey, 1=cyaan" as literals).
const INFO_TIER_NONE = 'grey';           // no matching rule (or not fetched yet)
const INFO_TIER_SINGLE = 'cyan';         // exactly INFO_TIER_SINGLE_COUNT matching rule(s)
const INFO_TIER_MULTIPLE = 'orange';     // more than INFO_TIER_SINGLE_COUNT — worth a look
const INFO_TIER_SINGLE_COUNT = 1;
// Tier -> CSS class, written out literally so the CSS class cross-reference (suite step 11) can match each
// class to its rule in matrix-panel.css.
const INFO_TIER_CLASS = Object.freeze({ [INFO_TIER_NONE]: 'fill-grey', [INFO_TIER_SINGLE]: 'fill-cyan', [INFO_TIER_MULTIPLE]: 'fill-orange' });
const INFO_TIER_CLASSES = Object.freeze(Object.values(INFO_TIER_CLASS));

// Column type/key -> display label override. The `type`/`key` values
// themselves MUST stay exactly aligned with js/core/matrix-panel.js's
// TYPE_BUCKET values (that's the core/front-end contract entry.types is
// matched against in renderCell()) even when the label shown to the user
// reads differently for brevity — e.g. the 'stylesheet' bucket displays
// as 'CSS', 'fetch/xhr' as 'XHR'. Add future label-only renames here,
// never by changing the bucket key/type itself.
const COLUMN_LABEL_OVERRIDES = Object.freeze({
    stylesheet: 'CSS',
    'fetch/xhr': 'XHR',
});

// Scope statement, shown first and in capitals (10.3.0, same treatment as the sister extension's own
// Matrix panel): every BLOCK/ALLOW click here is stored per site (matrix-block-rules.js is per-site), so a
// person must never read a click as a global rule. Declared once, here.
const SITE_SCOPE_TEXT = Object.freeze({
    prefix: `${DNR_TRACKING_FILTER_NAME.toUpperCase()} APPLIES TO THE CURRENT WEBSITE ONLY`,
    unknownHost: 'this website',
});

const FILTER_EXPLANATION_BY_MODE = Object.freeze({
    block: 'showing domains not yet blocked',
    allow: 'showing only already-blocked domains — hover a domain to see why',
});

// Whitelist level (10.2.0 — see js/data/matrix-constants.js's "Whitelist
// levels" block). Informational only: it never changes the verdict,
// which already reflects what the level does at the network level.
const WHITELIST_LEVEL_NOTES = Object.freeze({
    white: `WHITE list: trusted — allowed over the filter lists and outside ${WORRY_FREE_NAME}`,
    grey:  'GREY list: anyone can publish here — filter lists and protections apply',
});

// (11.1.0) BREAK RISK column — same badges as the Fingerprint Inspector (js/data/risk-badge.js), one verdict per
// domain from js/core/breakage-risk.js. Legend order (low first) and the advice sentence are declared once, here.
const BREAK_RISK_LEGEND_ORDER = Object.freeze([ RISK_LOW, RISK_MEDIUM, RISK_HIGH, RISK_UNKNOWN ]);
const BREAK_RISK_LEGEND_WORD = Object.freeze({
    [RISK_LOW]: 'low', [RISK_MEDIUM]: 'medium', [RISK_HIGH]: 'high', [RISK_UNKNOWN]: 'unknown',
});

// (11.1.0, owner's request) Bulk buttons by Break risk — the Fingerprint inspector's Block low risk / Block medium /
// Block all, for domains. Cumulative thresholds (Medium = low + medium). ⚪ unknown only through the "All" button
// (owner). BLOCK mode climbs from low risk up; ALLOW mode (repairing a broken website) works from high risk down.
// Each writes the current mode's action as a 3P-all override for every VISIBLE row in its levels that does not have
// it yet — the same override a click on that row's 3P-all square writes, for this website only. Same button colours
// as the Inspector (css/panel-shared.css).
const BULK_SCOPE = 'all';
const BULK_ALL_LEVELS = BREAK_RISK_LEGEND_ORDER;   // every level, ⚪ unknown included
const BULK_BUTTONS_BY_MODE = Object.freeze({
    block: Object.freeze([
        { levels: [ RISK_LOW ], label: 'Block low risk', className: 'monitor-btn-blocklow',
            title: 'Block all third-party requests (3P-all) on this website from every listed low-risk domain' },
        { levels: [ RISK_LOW, RISK_MEDIUM ], label: 'Block medium', className: 'monitor-btn-blockmedium',
            title: 'Block all third-party requests (3P-all) on this website from every listed low- or medium-risk domain' },
        { levels: BULK_ALL_LEVELS, label: 'Block all', className: 'monitor-btn-blockall',
            title: 'Block all third-party requests (3P-all) on this website from every listed domain, including high and unknown risk' },
    ]),
    allow: Object.freeze([
        { levels: [ RISK_HIGH ], label: 'Allow high risk', className: 'monitor-btn-blockall',
            title: 'Allow all third-party requests (3P-all) on this website from every listed high-risk domain' },
        { levels: [ RISK_HIGH, RISK_MEDIUM ], label: 'Allow medium', className: 'monitor-btn-blockmedium',
            title: 'Allow all third-party requests (3P-all) on this website from every listed high- or medium-risk domain' },
        { levels: BULK_ALL_LEVELS, label: 'Allow all', className: 'monitor-btn-blocklow',
            title: 'Allow all third-party requests (3P-all) on this website from every listed domain, including low and unknown risk' },
    ]),
});

// (11.1.0, owner's wording) Intro legend: one bullet per informational column, each on ONE line at the panel window's
// width (js/core/panel-window.js PANEL_WINDOW_CONFIG.WIDTH — re-measure if a bullet grows). Tier values, colours and
// badges are read from their own constants, never retyped.
const LEGEND_TITLE = 'Explanation of information shown:';

// Expand-column marker glyphs (closed / open) and the type-column check marks.
const EXPAND_MARKER_CLOSED = '▶';
const EXPAND_MARKER_OPEN = '▼';
const CHECK_MARK_YES = '✓';
// Known tracker cell values (renderTrackerCell) — the legend names them too.
const CHECK_TRACKER_YES = 'Y';
const CHECK_TRACKER_NO = 'N';
const CHECK_MARK_NO = '—';

// mini-square state -> fill class (miniSquareCell()). Written out literally so the CSS class
// cross-reference (suite step 11) can match each class to its rule in matrix-panel.css.
const MINI_SQUARE_FILL_CLASS = Object.freeze({
    green: 'fill-green',
    red: 'fill-red',
    yellow: 'fill-yellow',
    cyan: 'fill-cyan',
    orange: 'fill-orange',
    grey: 'fill-grey',
});

// Session clock: display refresh interval and the "almost expired" warning window.
const CLOCK_TICK_MS = 500;
const CLOCK_WARNING_MS = 60000;

const STOP_MESSAGE_TIMEOUT_MS = 1500;

// Poll safety net — same 15s interval / reasoning as privacy-inspector.js's
// own PRIVACY_INSPECTOR_POLL_MS.
const MATRIX_POLL_MS = 15000;


/* ══════════════════════════════════════════════════════════════
   3. DOM REFERENCES
   ══════════════════════════════════════════════════════════════ */

const elHost = qs$('#panelHost');
const elStats = qs$('#panelStats');
const elTimer = qs$('#timerDisplay');
const elExit = qs$('#btnExit');
const elRefresh = qs$('#btnRefresh');
const elThead = qs$('#matrixThead');
const elBody = qs$('#entryBody');
const elEmpty = qs$('#emptyState');
const showBlockedToggle = qs$('#matrixShowBlockedToggle');
const elIntro = qs$('#monitorHelp');
const elLegend = qs$('#matrixLegend');   // (11.1.0, owner) below the yellow advice banner
const elBulkButtons = qs$('#matrixBulkButtons');

/* ══════════════════════════════════════════════════════════════
   4. PANEL STATE
   ══════════════════════════════════════════════════════════════ */

let clock = null;       // the session clock's setInterval handle
let currentHost = '';   // the monitored site, set once the snapshot arrives
let pollHandle = null;  // the poll safety net's setInterval handle
let refreshInFlight = false; // re-entrancy guard: a rapid double-click must not fire two overlapping tab reloads
let bulkInFlight = false;    // (11.1.0) re-entrancy guard: a second bulk click must not start an overlapping batch

// Column model (section 6) — rebuilt by buildHeader() whenever the mode changes.
let columnGroups = buildColumnGroups();
let columns = flattenColumns(columnGroups);

// Row rendering — one row per domain (rowRegistry keyed by domain, not by
// requestId — see js/core/matrix-panel.js's header for why this fork's
// entries are per-domain, matching the actual matrix-grid data model).
const rowRegistry = new Map(); // domain -> <tr>
const entryRegistry = new Map(); // domain -> latest entry object

// Expand-column state (per explicit request) — which domains currently
// have their raw-rule detail row open, and the <tr> element itself so it
// can be removed on collapse. This Map's keys ARE the source of truth
// for whether a domain is "expanded" — renderExpandCell()
// checks membership directly rather than a separate boolean flag, so
// there's only one place this state can drift out of sync with itself.
const expandedDetailRows = new Map(); // domain -> <tr> (the detail row)
// Per-domain cache of the PROCESSED rule-detail lines (relevance-
// filtered, grouped, truncated — see processDomainRules() below), keyed
// by domain. Was raw-rules-only, fetched purely on click; now ALSO
// drives the expand arrow's own color (bold = 2+ distinct lines, grey =
// 0 or 1), which means it has to be known before the first click, not
// only after — see ensureDomainDetailFetched() below for the eager,
// once-per-domain-as-it-first-appears fetch this requires. Still only
// invalidated by REFRESH (handleRefreshClick() below), not on every
// ordinary collapse — same reasoning as before, unchanged.
const detailCache = new Map(); // domain -> array of PROCESSED display lines
// Prevents firing a second concurrent fetch for a domain that's already
// mid-fetch (e.g. upsertEntry() re-rendering the same row on every poll
// tick before the first fetch has resolved).
const pendingDetailFetches = new Set(); // domains currently being fetched

// Raw ruleset id -> human name, same source the Filter Blocklists page
// itself reads (10.0.5 — see ruleset-details-loader.js's header). Filled by
// loadRulesetNames() at bootstrap; rulesetDisplayName() falls back to the
// raw id until then.
let rulesetNameMap = new Map();

/* ══════════════════════════════════════════════════════════════
   5. MODE
   ══════════════════════════════════════════════════════════════ */

// Current mode — derived live from the switch, not cached, so it's
// always accurate at click time. The switch's CHECKED state is labeled
// "SHOW BLOCKED" and maps to 'allow' mode (filter shows only
// already-blocked domains); UNCHECKED (default) is labeled "SHOW
// ALLOWED" and maps to 'block' mode (filter shows only not-yet-blocked
// domains). See this file's header for the full mode semantics.
function currentMode() {
    return showBlockedToggle.checked ? 'allow' : 'block';
}

// The override action a click writes in the current mode.
function currentModeAction() {
    return currentMode() === 'block' ? 'block' : 'allow';
}

/* ══════════════════════════════════════════════════════════════
   6. COLUMN MODEL
   ══════════════════════════════════════════════════════════════ */

// Groups, not a flat list. flattenColumns() derives the flat per-cell list
// renderRow() uses, so header and body are generated from one shared source
// of truth. Rebuilt (buildColumnGroups() called again) whenever the mode
// changes, since the BLOCK/ALLOW group's label is mode-dependent.
function buildColumnGroups() {
    const groups = [];
    const mode = currentMode();
    const groupLabel = mode === 'block' ? 'BLOCK' : 'ALLOW';

    // Leftmost, per explicit request — the row-detail expand toggle.
    // See renderExpandCell() and the expandedDetailRows Map (section 4)
    // for the full mechanism. Deliberately its own single-column
    // group (no shared header label) — it's a UI affordance, not
    // informational content like every other column here.
    groups.push({ label: '', subs: [
        { key: 'expand', kind: 'expand', label: '',
            title: 'Click to show the raw filter rules matching this domain (no final blocked/allowed verdict — see the panel\'s own note)' },
    ] });

    // Per explicit request: replaces the old "known DDG Tracker"
    // breakage-risk column (removed — judged obsolete now that Worry-
    // Free mode's additional filtering already stops most trackers, see
    // CHANGELOG). Positioned right after the expand column, before
    // "Domains connected" — same rule-count signal the expand arrow
    // itself used to color (see the CHANGELOG entry on why that was
    // folded into this dedicated column instead of staying on the arrow).
    groups.push({ label: '', subs: [
        { key: 'info', kind: 'info', label: [ 'More', 'info' ],
            title: `Grey = no matching filter rule for this domain. Cyan = exactly ${INFO_TIER_SINGLE_COUNT}. Orange = ${INFO_TIER_SINGLE_COUNT + 1} or more (worth a look). Click the arrow in the first column to see them. Not a final blocked/allowed verdict.` },
    ] });

    // Restored DDG Tracker Radar lookup (see CHANGELOG for its prior
    // removal and js/core/tracker-radar-lookup.js for the restoration) —
    // a plain Y/N presence check against the bundled dataset, distinct
    // from the old breakage-risk verdict this same dataset used to power.
    groups.push({ label: '', subs: [
        { key: 'tracker', kind: 'tracker', label: [ 'Known', 'tracker' ],
            title: 'Y if this domain matches an entry in the bundled DuckDuckGo Tracker Radar dataset, N otherwise. Informational only — not a block/allow verdict.' },
    ] });

    // (11.1.0, owner's request) Break risk — right of "Known tracker", before "Domains connected".
    groups.push({ label: '', subs: [
        { key: 'breakRisk', kind: 'breakRisk', label: [ 'Break', 'risk' ],
            title: 'How likely blocking this domain is to break the website. Hover a badge for the reason.' },
    ] });

    groups.push({ label: 'Domains connected', subs: [
        { key: 'domain', kind: 'domain', label: 'Domains connected' },
    ] });

    // The interactive group — one clickable cell per sub-column (not split
    // Allow/Block halves like the old SCRIPT/FRAME columns). Positioned
    // right after "Domains connected" — the panel's primary action.
    groups.push({ label: groupLabel, subs: [
        { key: 'scope-all', kind: 'scope', scope: 'all', label: '3P-all',
            title: `Click to ${mode === 'block' ? 'block' : 'allow'} ALL third-party requests from this domain on ${currentHost || 'this site'}` },
        { key: 'scope-code', kind: 'scope', scope: 'code', label: '3P-code',
            title: `Click to ${mode === 'block' ? 'block' : 'allow'} only this domain's third-party script/frame requests on ${currentHost || 'this site'}` },
    ] });

    for ( const t of [ 'image', 'media', 'stylesheet' ] ) {
        const label = COLUMN_LABEL_OVERRIDES[t] ?? t;
        const sub = { key: t, kind: 'single', type: t, label };
        // 'image' now directly follows the BLOCK/ALLOW group — a bolder
        // separator than the ordinary thin group-start line marks that
        // boundary specifically (the panel's primary action vs. the
        // informational columns after it), not every group boundary.
        if ( t === 'image' ) { sub.boldSeparator = true; }
        groups.push({ label, subs: [ sub ] });
    }

    // Informational only — NOT clickable. Two separate columns (not one
    // merged "3P CODE" column, an earlier version of this file had) so a
    // domain that only does frames (no scripts), or vice versa, is
    // distinguishable at a glance — useful context for deciding whether
    // clicking 3P-code above would actually do anything for THIS domain.
    groups.push({ label: 'script', subs: [
        { key: 'usesScript', kind: 'usesType', type: 'script', label: 'script',
            title: 'Informational: checked if this domain has made a third-party script request — not clickable' },
    ] });
    groups.push({ label: 'frame', subs: [
        { key: 'usesFrame', kind: 'usesType', type: 'frame', label: 'frame',
            title: 'Informational: checked if this domain has made a third-party frame request — not clickable' },
    ] });

    for ( const t of [ 'fetch/xhr', 'other' ] ) {
        const label = COLUMN_LABEL_OVERRIDES[t] ?? t;
        groups.push({ label, subs: [ { key: t, kind: 'single', type: t, label } ] });
    }

    return groups;
}

function flattenColumns(groups) {
    const flat = [];
    groups.forEach((g, gi) => {
        g.subs.forEach((sub, si) => {
            flat.push({ ...sub, groupStart: gi > 0 && si === 0 });
        });
    });
    return flat;
}

/* ══════════════════════════════════════════════════════════════
   7. INTRO TEXT
   ══════════════════════════════════════════════════════════════ */

// Fully dynamic, not static markup (see matrix-panel.html's own comment on
// #monitorHelp for why): the wording actually differs between block mode
// and allow mode (BLOCK vs ALLOW, "MODE" label), not just a couple of
// swapped words, so this rebuilds the whole banner from a per-mode template
// rather than trying to patch a handful of spans in place. Built with
// dom.create()/textContent (no innerHTML).
//
// FILTER_EXPLANATION_BY_MODE (section 2) is the one source of truth for the
// filter-explanation sentence shown per mode (see isEntryHiddenForMode() for
// the actual filter logic this describes). ALLOW mode additionally points at
// the domain column's own hover tooltip (see blockReasonTitle()) — that's
// exactly where ALLOW mode is most useful (reviewing already-blocked
// domains). SITE_SCOPE_TEXT is shown first and in capitals (10.3.0): every
// BLOCK/ALLOW click here is stored per site (matrix-block-rules.js is
// per-site), so a person must never read a click as a global rule.
function appendBold(parent, text) {
    const strong = dom.create('strong');
    strong.textContent = text;
    parent.appendChild(strong);
}

function appendText(parent, text) {
    parent.appendChild(document.createTextNode(text));
}

function updateIntroText() {
    const mode = currentMode();
    const action = mode === 'block' ? 'BLOCK' : 'ALLOW';

    elIntro.textContent = '';
    appendBold(elIntro, `${SITE_SCOPE_TEXT.prefix} (${currentHost || SITE_SCOPE_TEXT.unknownHost}).`);
    appendText(elIntro, ' ');
    appendBold(elIntro, `${action} MODE`);
    appendText(elIntro, ` (${FILTER_EXPLANATION_BY_MODE[mode]}): `);
    appendText(elIntro, 'click the square under ');
    appendBold(elIntro, '3P-ALL');
    appendText(elIntro, ` to `);
    appendBold(elIntro, action);
    appendText(elIntro, ' all third-party requests from that domain, or ');
    appendBold(elIntro, '3P-CODE');
    appendText(elIntro, ' to only ');
    appendBold(elIntro, action);
    appendText(elIntro, ' third-party scripts and frames from that domain.');

    const title = dom.create('p');
    title.className = 'intro-legend-title';
    title.textContent = LEGEND_TITLE;
    const list = dom.create('ul');
    list.className = 'intro-legend';
    const badges = BREAK_RISK_LEGEND_ORDER.map(level => `${RISK_BADGE[level].glyph} ${BREAK_RISK_LEGEND_WORD[level]}`).join(', ');
    for ( const line of [
        `More info shows how many filter rules apply (0=${INFO_TIER_NONE}, ${INFO_TIER_SINGLE_COUNT}=${INFO_TIER_SINGLE}, more=${INFO_TIER_MULTIPLE}).`,
        `Known tracker shows whether the domain is in the DuckDuckGo Tracker Radar dataset (${CHECK_TRACKER_YES}/${CHECK_TRACKER_NO}).`,
        `Break risk shows the risk of blocking that domain (${badges}).`,
    ] ) {
        const item = dom.create('li');
        item.textContent = line;
        list.appendChild(item);
    }
    elLegend.textContent = '';
    elLegend.append(title, list);
}

/* ══════════════════════════════════════════════════════════════
   8. HEADER
   ══════════════════════════════════════════════════════════════ */

// Two real rows: row 1 holds a rowspan=2 single header (1-sub groups) or a
// colspan group header; row 2 holds only the sub-headers of multi-column
// groups (BLOCK/ALLOW's 3P-all / 3P-code).
function setLabel(th, label) {
    if ( Array.isArray(label) ) {
        for ( const line of label ) {
            const span = dom.create('span');
            span.className = 'th-line';
            span.textContent = line;
            th.appendChild(span);
        }
    } else {
        th.textContent = label;
    }
}

// A 1-sub group: one header cell spanning both rows.
function buildSingleHeaderCell(sub, isGroupStart) {
    const th = dom.create('th');
    setLabel(th, sub.label);
    th.rowSpan = 2;
    if ( sub.title ) { th.title = sub.title; }
    if ( sub.kind === 'domain' ) { th.classList.add('th-domain'); }
    if ( sub.boldSeparator ) { th.classList.add('group-start-bold'); }
    else if ( isGroupStart ) { th.classList.add('group-start'); }
    return th;
}

// A multi-sub group: its label cell (row 1) and one sub-header per column (row 2).
function appendGroupHeaderCells(group, isGroupStart, row1, row2) {
    const th = dom.create('th');
    setLabel(th, group.label);
    th.colSpan = group.subs.length;
    if ( isGroupStart ) { th.classList.add('group-start'); }
    row1.appendChild(th);
    group.subs.forEach((sub, si) => {
        const subTh = dom.create('th');
        setLabel(subTh, sub.label);
        if ( sub.title ) { subTh.title = sub.title; }
        if ( si === 0 ) { subTh.classList.add('group-start'); }
        row2.appendChild(subTh);
    });
}

function buildHeader() {
    updateIntroText(); // mode-dependent, same triggers as the column header below
    renderBulkButtons(); // (11.1.0) mode-dependent too
    columnGroups = buildColumnGroups();
    columns = flattenColumns(columnGroups);

    const row1 = dom.create('tr');
    const row2 = dom.create('tr');

    columnGroups.forEach((g, gi) => {
        const isGroupStart = gi > 0;
        if ( g.subs.length === 1 ) {
            row1.appendChild(buildSingleHeaderCell(g.subs[0], isGroupStart));
        } else {
            appendGroupHeaderCells(g, isGroupStart, row1, row2);
        }
    });

    elThead.textContent = '';
    elThead.appendChild(row1);
    elThead.appendChild(row2);
}

/* ══════════════════════════════════════════════════════════════
   9. BLOCK VERDICT + ROW VISIBILITY
   ══════════════════════════════════════════════════════════════ */

// "Already blocked" composition for the mode-relevance filter — see
// js/core/matrix-panel.js's header for what each flag means. (10.3.0: the
// two Privacy & Security live-predicate flags — suspicious 3P-link pattern
// and DDNS/free-hosting list — were removed with that protection, and with
// them the securityConfig cache that gated them.)
function isAlreadyBlocked(entry) {
    // An explicit override always wins over automatic classification —
    // that's the whole point of an override — checked FIRST, in EITHER
    // direction, before any automatic-block signal below. Previously
    // only the 'block' case was checked, so a domain with an active
    // ALLOW override still displayed as "already blocked" (still showed
    // up in SHOW BLOCKED mode) even though the DNR rule itself was
    // correctly letting it through — the actual network behavior was
    // fine, only this panel-side classification was stale. Same
    // domain-level granularity the pre-existing 'block' check already
    // used (either scope, not resource-type-precise) — kept consistent
    // rather than introducing a different precision level for one
    // direction and not the other.
    if ( entry.override?.all === 'allow' || entry.override?.code === 'allow' ) { return false; }
    if ( entry.override?.all === 'block' || entry.override?.code === 'block' ) { return true; }
    if ( entry.staticallyBlocked ) { return true; }
    // BUG FIX (10.6.4): a domain blocked only by the user's own
    // "Import ABP rules" sandbox rule used to fall through to `false`
    // here — invisible to both this verdict and the SHOW ALLOWED/SHOW
    // BLOCKED filter, even though the DNR rule itself was genuinely
    // blocking the request. See js/core/matrix-panel.js's
    // refreshUserRuleBlockCache() for the real case this closes.
    if ( entry.userRuleBlocked ) { return true; }
    return false;
}

// Single source of truth for "should this row be hidden in THIS mode".
// Previously the filter only ever hid already-blocked domains, and was
// simply switched off (never hiding anything) in allow mode. Changed so
// the filter is unconditional in both modes, just pointed in opposite
// directions — this is the one place that direction is decided, so
// applyRowVisibility() and its whitelisted-child bypass (below) both stay
// correct automatically if this ever changes again:
//   - BLOCK mode: hide domains ALREADY blocked (only unblocked domains —
//     i.e. actual blocking candidates — are worth listing).
//   - ALLOW mode: hide domains NOT already blocked (only already-blocked
//     domains — i.e. actual allow/exception candidates — are worth
//     listing).
function isEntryHiddenForMode(entry, mode) {
    return mode === 'block' ? isAlreadyBlocked(entry) : !isAlreadyBlocked(entry);
}

function blockReasonTitle(entry) {
    const reasons = [];
    if ( entry.staticallyBlocked ) { reasons.push('bundled filter list'); }
    if ( entry.userRuleBlocked ) { reasons.push('your custom rule (Import ABP rules)'); }
    if ( entry.override?.all === 'block' ) { reasons.push('3P-all blocked (your override, this site)'); }
    if ( entry.override?.code === 'block' ) { reasons.push('3P-code blocked (your override, this site)'); }
    if ( entry.override?.all === 'allow' ) { reasons.push('3P-all allowed (your override, this site)'); }
    if ( entry.override?.code === 'allow' ) { reasons.push('3P-code allowed (your override, this site)'); }

    // Top-line verdict uses isAlreadyBlocked() itself — same override
    // precedence, so this tooltip can never disagree with what SHOW
    // BLOCKED / SHOW ALLOWED is doing with this exact row. Always
    // returned (never ''), including when reasons is empty, so hovering
    // a domain with nothing going on still confirms "yes, checked,
    // genuinely nothing here" instead of a silent no-tooltip that looks
    // indistinguishable from the tooltip just not working.
    const verdict = isAlreadyBlocked(entry) ? 'BLOCKED' : 'NOT BLOCKED';
    const headline = reasons.length === 0
        ? `${verdict} — no matching filter or override`
        : `${verdict} — ${reasons.join(', ')}`;
    return headline + whitelistLevelNote(entry);
}

function whitelistLevelNote(entry) {
    const level = entry.criticalResource?.level ?? null;
    const note = level !== null ? WHITELIST_LEVEL_NOTES[level] : undefined;
    if ( note === undefined ) { return ''; }
    const reason = level === 'grey' && entry.criticalResource.greyReason
        ? ` (${entry.criticalResource.greyReason})`
        : '';
    return `\n${note}${reason}`;
}

function applyRowVisibility(row, entry) {
    const mode = currentMode();
    let hidden = isEntryHiddenForMode(entry, mode);
    // A parent domain can be filtered-out under the current mode while a
    // WHITELISTED subdomain of it legitimately isn't (e.g. in BLOCK mode,
    // a filter list blocks jwplayer.com as a whole domain rule, but not
    // entitlements.jwplayer.com specifically, which is itself CRITICAL
    // RESOURCE-whitelisted) — if that child would still be shown, the
    // parent must be shown too, or the child's "└" indentation ends up
    // attached to whatever unrelated row happens to be visible above it.
    // Scoped specifically to WHITELISTED children (not any child that
    // merely passes the current mode's filter for other reasons) — the
    // parent needs to reappear because a critical resource needs it as
    // context, not as a general rule about hidden parents. Only
    // top-level entries carry .subdomains, so this is a no-op for child
    // rows themselves.
    if ( hidden && Array.isArray(entry.subdomains) ) {
        const anyWhitelistedChildVisible = entry.subdomains.some(sub =>
            sub.criticalResource.whitelisted &&
            !isEntryHiddenForMode(sub, mode)
        );
        if ( anyWhitelistedChildVisible ) { hidden = false; }
    }
    row.classList.toggle('row-hidden', hidden);
}

/* ══════════════════════════════════════════════════════════════
   10. CELL RENDERING  —  one function per column kind
   ══════════════════════════════════════════════════════════════ */

function miniSquareCell(state, title) {
    const td = dom.create('td');
    const square = dom.create('span');
    square.className = 'mini-square';
    const fillClass = MINI_SQUARE_FILL_CLASS[state];
    if ( fillClass !== undefined ) { square.classList.add('filled', fillClass); }
    if ( title ) { td.title = title; }
    td.appendChild(square);
    return td;
}

// "More info" indicator — three tiers now, per explicit request:
// grey for zero matching rules, cyan for exactly one, orange for
// multiple (worth a look). Same underlying signal the expand arrow
// itself used to be colored by (see CHANGELOG for why that moved here
// instead) — reads from the same detailCache the arrow's eager fetch
// already populates, not a second, separate computation.
// (10.5.0) One tier decision for both the first render and the in-place recolour (was two copies).
function infoTierForCount(count) {
    if ( count === 0 ) { return INFO_TIER_NONE; }
    if ( count === INFO_TIER_SINGLE_COUNT ) { return INFO_TIER_SINGLE; }
    return INFO_TIER_MULTIPLE;
}

function infoMarkerState(domain) {
    const lines = detailCache.get(domain);
    // Not-yet-fetched (undefined) also reads as grey — a reasonable
    // placeholder until ensureDomainDetailFetched()'s eager fetch
    // resolves and corrects it in place, not just a coincidence of the
    // zero-rules case sharing the same check.
    return infoTierForCount(Array.isArray(lines) ? lines.length : 0);
}

function renderExpandCell(col, entry) {
    const td = dom.create('td');
    td.className = 'td-expand clickable';
    td.dataset.domain = entry.domain;
    const isOpen = expandedDetailRows.has(entry.domain);
    const marker = dom.create('span');
    marker.className = 'expand-marker';
    marker.textContent = isOpen ? EXPAND_MARKER_OPEN : EXPAND_MARKER_CLOSED;
    td.appendChild(marker);
    // Fire-and-forget — idempotent (checks cache/pending state
    // itself), safe to call on every render. This is what makes the
    // "more info" square's color eventually correct even before the
    // first click — see ensureDomainDetailFetched()'s own comment
    // for why this eager fetch is necessary at all.
    ensureDomainDetailFetched(entry.domain);
    return td;
}

function renderInfoCell(col, entry) {
    const td = miniSquareCell(infoMarkerState(entry.domain), col.title);
    td.className = 'td-info';
    td.dataset.domain = entry.domain; // ensureDomainDetailFetched's post-fetch update targets this
    if ( col.groupStart ) { td.classList.add('group-start'); }
    return td;
}

function renderTrackerCell(col, entry) {
    const td = dom.create('td');
    td.className = 'td-tracker';
    td.textContent = entry.ddgTracker ? CHECK_TRACKER_YES : CHECK_TRACKER_NO;
    td.title = entry.ddgTracker
        ? 'Matches a domain in the bundled DuckDuckGo Tracker Radar dataset'
        : 'Not found in the bundled DuckDuckGo Tracker Radar dataset';
    return td;
}

// (11.1.0) A row from before this field existed (a session persisted by 11.0.4) has no breakageRisk: ⚪ unknown.
function renderBreakRiskCell(col, entry) {
    const level = RISK_BADGE[entry.breakageRisk] !== undefined ? entry.breakageRisk : RISK_UNKNOWN;
    const td = dom.create('td');
    td.className = 'td-break-risk';
    td.textContent = RISK_BADGE[level].glyph;
    td.title = DOMAIN_RISK_REASON[level];
    td.setAttribute('role', 'img');
    td.setAttribute('aria-label', `${RISK_BADGE[level].srLabel}: ${DOMAIN_RISK_REASON[level]}`);
    return td;
}

function renderDomainCell(col, entry) {
    const td = dom.create('td');
    td.className = 'td-domain';
    td.textContent = entry.domain;
    td.title = blockReasonTitle(entry);
    return td;
}

// 'single' (one request type) and 'usesType' (informational script/frame)
// columns: a check mark if this domain made a 3P request of col.type.
// 'usesType' is informational only — two separate columns rather than one
// merged "3P CODE" check (an earlier version of this file had) so a domain
// that only does frames, or only scripts, is distinguishable at a glance.
// Only 'single' columns carry boldSeparator (buildColumnGroups()).
function renderTypeCheckCell(col, entry) {
    const td = dom.create('td');
    if ( col.boldSeparator ) { td.classList.add('group-start-bold'); }
    else if ( col.groupStart ) { td.classList.add('group-start'); }
    const has = entry.types.includes(col.type);
    const span = dom.create('span');
    span.className = 'td-check' + (has ? '' : ' empty');
    span.textContent = has ? CHECK_MARK_YES : CHECK_MARK_NO;
    td.appendChild(span);
    return td;
}

function renderScopeCell(col, entry) {
    const td = dom.create('td');
    td.className = (col.groupStart ? 'group-start ' : '') + 'td-half clickable';
    td.dataset.domain = entry.domain;
    td.dataset.scope = col.scope;

    const currentOverride = entry.override?.[col.scope] ?? null;
    const square = dom.create('span');
    square.className = 'mini-square';
    if ( currentOverride === 'block' ) { square.classList.add('filled', 'fill-red'); }
    else if ( currentOverride === 'allow' ) { square.classList.add('filled', 'fill-green'); }
    td.appendChild(square);
    return td;
}

// Column kind -> cell renderer (the `kind` values buildColumnGroups() assigns).
const CELL_RENDERERS = Object.freeze({
    expand: renderExpandCell,
    info: renderInfoCell,
    tracker: renderTrackerCell,
    breakRisk: renderBreakRiskCell,
    domain: renderDomainCell,
    single: renderTypeCheckCell,
    usesType: renderTypeCheckCell,
    scope: renderScopeCell,
});

function renderCell(col, entry) {
    const render = CELL_RENDERERS[col.kind];
    return render !== undefined ? render(col, entry) : dom.create('td');
}

/* ══════════════════════════════════════════════════════════════
   11. ROWS  —  render, upsert, visibility pass, stats
   ══════════════════════════════════════════════════════════════ */

function renderRow(entry, preserveVisibilityFrom, isChildRow) {
    const tr = dom.create('tr');
    if ( isChildRow ) { tr.classList.add('row-child'); }
    for ( const col of columns ) {
        tr.appendChild(renderCell(col, entry));
    }
    if ( preserveVisibilityFrom ) {
        // Keep whatever hidden/shown state the row already had — used
        // when a click just changed this entry's override, so the row
        // doesn't vanish out from under the user's cursor the instant
        // they act on it. See refreshMatrixView() for where the
        // deferred re-evaluation actually happens (the REFRESH button).
        tr.classList.toggle('row-hidden', preserveVisibilityFrom.classList.contains('row-hidden'));
    } else {
        applyRowVisibility(tr, entry);
    }
    return tr;
}

// Renders/updates a domain's own row, AND — for CRITICAL RESOURCE-
// whitelisted domains with observed subdomains — the child rows for each
// of those subdomains directly beneath it (see js/core/matrix-panel.js's
// maybeTrackSubdomain()/newEntry() comments for why this is scoped to
// whitelisted domains only). Child sub-entries are plain entry objects
// too (see newSubdomainEntry() in the core module) — rendered through the
// exact same renderRow()/renderCell() pipeline as any top-level row, not
// a parallel/simplified code path, so every column kind (informational
// markers, clickable scope cells) already works correctly for them with
// zero extra cases here.
function upsertEntry(entry, options = {}) {
    elEmpty.hidden = true;
    entryRegistry.set(entry.domain, entry);
    const existingRow = rowRegistry.get(entry.domain);
    const newRow = renderRow(entry, options.skipVisibilityUpdate ? existingRow : null, false);
    if ( existingRow ) {
        existingRow.replaceWith(newRow);
    } else if ( options.fragment ) {
        options.fragment.appendChild(newRow);
    } else {
        elBody.appendChild(newRow);
    }
    rowRegistry.set(entry.domain, newRow);

    // Child rows — only top-level entries carry a .subdomains array
    // (subdomain sub-entries themselves don't), so this is naturally a
    // no-op when upsertEntry() is called again for an existing child row
    // (e.g. after a click on that child row's own scope cell).
    if ( Array.isArray(entry.subdomains) ) {
        upsertSubdomainRows(entry.subdomains, newRow, options);
    }

    if ( !options.deferStats ) { renderStats(); updateBulkButtons(); }
}

// Renders/updates each subdomain's child row directly beneath its parent row.
function upsertSubdomainRows(subdomains, parentRow, options) {
    let afterEl = parentRow; // insert each new child directly after the previous row in this parent's chain, starting with the parent itself
    for ( const subEntry of subdomains ) {
        entryRegistry.set(subEntry.domain, subEntry);
        const existingSubRow = rowRegistry.get(subEntry.domain);
        const newSubRow = renderRow(subEntry, options.skipVisibilityUpdate ? existingSubRow : null, true);
        if ( existingSubRow ) {
            existingSubRow.replaceWith(newSubRow);
        } else {
            afterEl.after(newSubRow);
        }
        rowRegistry.set(subEntry.domain, newSubRow);
        afterEl = newSubRow;
    }
}

// Re-evaluates every row's visibility against its CURRENT entry state —
// the only place applyRowVisibility() runs for entries a click already
// changed (see upsertEntry's skipVisibilityUpdate above). Called directly
// by the mode switch (toggling it is already an explicit "re-evaluate
// now" action), and by handleRefreshClick() below as the REFRESH button's
// list-side half — see that function's own comment for the other half
// (reloading the actual tab).
function refreshMatrixView() {
    for ( const [ domain, row ] of rowRegistry ) {
        const entry = entryRegistry.get(domain);
        if ( entry ) { applyRowVisibility(row, entry); }
    }
    updateBulkButtons();
}

function renderStats() {
    const domainCount = entryRegistry.size;
    let requestTypeCount = 0;
    for ( const entry of entryRegistry.values() ) { requestTypeCount += entry.types.length; }
    elStats.textContent = `${domainCount} domain${domainCount === 1 ? '' : 's'} · ${requestTypeCount} connection${requestTypeCount === 1 ? '' : 's'}`;
}

/* ══════════════════════════════════════════════════════════════
   12. RULE-DETAIL PIPELINE  —  pure processing of the raw rules
   ══════════════════════════════════════════════════════════════ */

// Expand-column — raw rule detail (per explicit request; see
// js/core/domain-rule-detail.js's own header for what this deliberately
// does and does not resolve).
//
// Processing pipeline, applied client-side to the raw rules the backend
// returns (the backend itself is unchanged — still "everything that
// mentions this domain", no site-awareness at all; filtering by
// relevance to the CURRENT site is inherently a view concern, since
// currentHost already lives here, not in a stateless on-demand backend
// call):
//   1. RELEVANCE FILTER — drop any rule that plainly does not apply to
//      the site being viewed (its initiatorDomains doesn't include this
//      site or an ancestor of it, or its excludedInitiatorDomains does).
//      Dropped, not shown greyed-out, not summarized into a count — per
//      explicit request, confirmed directly: a rule that can't apply
//      here isn't information about here.
//   2. GROUP near-duplicates — rules identical in every way except WHICH
//      sites they're scoped to (the exact AdGuard antiadblock pattern
//      that motivated this: dozens of ||imasdk.googleapis.com/.../ima3.js
//      rules, same ruleset/action/priority, each scoped to 1-3 different
//      sites) collapse into one summarized line with a count.
//   3. TRUNCATE long initiatorDomains lists on whatever's left ungrouped
//      — show only the entry that actually matched this site, "+N more"
//      instead of the full list.
// The RESULT of this pipeline (not the raw rule count) is what decides
// both the "more info" square's color and whether the "not a final
// verdict" disclaimer is worth showing at all — see infoMarkerState()
// (section 10) and buildDetailRow() (section 13).

function hostMatchesDomainList(host, list) {
    if ( !host || !Array.isArray(list) || list.length === 0 ) { return false; }
    return list.includes(host) || isDescendantHostnameOfIter(host, list);
}

function isRuleRelevantToSite(rule, host) {
    if ( !host ) { return true; } // no site context yet (shouldn't normally happen) — don't filter blind
    if ( hostMatchesDomainList(host, rule.excludedInitiatorDomains) ) { return false; }
    if ( Array.isArray(rule.initiatorDomains) && rule.initiatorDomains.length > 0 ) {
        return hostMatchesDomainList(host, rule.initiatorDomains);
    }
    return true; // no domain scoping at all on this rule — always relevant
}

// Everything EXCEPT initiatorDomains/excludedInitiatorDomains — those
// are exactly what differs between "duplicate" rules (see this section's
// own header comment).
function ruleGroupKey(rule) {
    return [
        rule.ruleset, rule.action, rule.priority, rule.urlFilter,
        rule.requestDomainsCount,
        (rule.resourceTypes ?? []).join(','),
        (rule.excludedResourceTypes ?? []).join(','),
        rule.domainType,
    ].join('|');
}

// Which single entry in rule.initiatorDomains is the reason this rule
// survived the relevance filter — host itself if present verbatim,
// otherwise whichever ancestor of host matched. Falls back to the first
// entry only if something unexpected slips through (shouldn't happen,
// since this is only ever called on a rule that already passed
// isRuleRelevantToSite()).
function matchingInitiatorEntry(rule, host) {
    const list = rule.initiatorDomains;
    if ( !Array.isArray(list) ) { return null; }
    if ( list.includes(host) ) { return host; }
    let hn = host;
    while ( hn ) {
        const pos = hn.indexOf('.');
        if ( pos === -1 ) { break; }
        hn = hn.slice(pos + 1);
        if ( list.includes(hn) ) { return hn; }
    }
    return list[0] ?? null;
}

function rulesetDisplayName(id) {
    return rulesetNameMap.get(id)?.name ?? id;
}

function ruleSummaryLine(rule, host) {
    const parts = [ rule.action.toUpperCase() ];
    if ( rule.urlFilter ) { parts.push(rule.urlFilter); }
    if ( rule.requestDomainsCount ) { parts.push(`(1 of ${rule.requestDomainsCount} domains in a combined rule)`); }
    if ( rule.domainType ) { parts.push(`[${rule.domainType}]`); }
    if ( Array.isArray(rule.initiatorDomains) ) {
        if ( rule.initiatorDomains.length > 1 ) {
            const shown = matchingInitiatorEntry(rule, host);
            const remaining = rule.initiatorDomains.length - 1;
            parts.push(`only on: ${shown}${remaining > 0 ? ` (+${remaining} more)` : ''}`);
        } else {
            parts.push(`only on: ${rule.initiatorDomains.join(', ')}`);
        }
    }
    if ( rule.excludedInitiatorDomains ) { parts.push(`except on: ${rule.excludedInitiatorDomains.join(', ')}`); }
    if ( rule.resourceTypes ) { parts.push(`types: ${rule.resourceTypes.join(', ')}`); }
    if ( rule.excludedResourceTypes ) { parts.push(`except types: ${rule.excludedResourceTypes.join(', ')}`); }
    parts.push(`(${rulesetDisplayName(rule.ruleset)}, priority ${rule.priority ?? '?'})`);
    return parts.join('  ');
}

function groupSummaryLine(rule, count) {
    const parts = [ rule.action.toUpperCase() ];
    if ( rule.urlFilter ) { parts.push(rule.urlFilter); }
    parts.push(`(${count} similar rules, ${rulesetDisplayName(rule.ruleset)}, priority ${rule.priority ?? '?'})`);
    return parts.join('  ');
}

// The one function both the eager background fetch and the click-to-
// expand path call — guarantees they can never process the same raw
// data two different ways.
function processDomainRules(rawRules, host) {
    const relevant = rawRules.filter(r => isRuleRelevantToSite(r, host));
    const groups = new Map(); // groupKey -> rule[]
    for ( const rule of relevant ) {
        const key = ruleGroupKey(rule);
        const bucket = groups.get(key);
        if ( bucket ) { bucket.push(rule); } else { groups.set(key, [ rule ]); }
    }
    const lines = [];
    for ( const bucket of groups.values() ) {
        if ( bucket.length === 1 ) {
            lines.push({ action: bucket[0].action, text: ruleSummaryLine(bucket[0], host), grouped: false, priority: bucket[0].priority ?? 0 });
        } else {
            lines.push({ action: bucket[0].action, text: groupSummaryLine(bucket[0], bucket.length), grouped: true, priority: bucket[0].priority ?? 0 });
        }
    }
    // Highest priority first — same "most useful reading order" reasoning
    // as before, not a resolved verdict.
    lines.sort((a, b) => b.priority - a.priority);
    return lines;
}

/* ══════════════════════════════════════════════════════════════
   13. RULE-DETAIL ROWS  —  fetch, expand, collapse
   ══════════════════════════════════════════════════════════════ */

// Fetches a domain's raw rules, processes them and caches the result.
// (10.7.9) The one fetch both the eager background fetch and the
// click-to-expand path use — was two copies of the same three lines.
async function fetchProcessedDomainRules(domain) {
    const rawRules = await sendMessage({ what: MSG_GET_DOMAIN_RULE_DETAIL, domain });
    const lines = processDomainRules(Array.isArray(rawRules) ? rawRules : [], currentHost);
    detailCache.set(domain, lines);
    return lines;
}

// Eager, once-per-domain fetch — needed because the "more info" square's
// OWN color has to be known before the first click, not only after (see
// this section's own header, and the CHANGELOG entry this session's
// design discussion is recorded in). Idempotent: safe to call on every
// render of every row — does nothing once cached, and the
// pendingDetailFetches guard stops a second concurrent fetch for a
// domain whose first fetch hasn't resolved yet (upsertEntry() re-renders
// every row on each poll tick, well before a typical fetch — a local,
// non-network file read — has had time to resolve).
async function ensureDomainDetailFetched(domain) {
    if ( detailCache.has(domain) ) { return; }
    if ( pendingDetailFetches.has(domain) ) { return; }
    pendingDetailFetches.add(domain);
    try {
        const lines = await fetchProcessedDomainRules(domain);
        recolorInfoSquare(domain, lines.length);
    } finally {
        pendingDetailFetches.delete(domain);
    }
}

// Update just this row's "more info" square in place — deliberately
// NOT a full upsertEntry() re-render, which would call renderCell()
// again, which calls ensureDomainDetailFetched() again — cache hit stops
// that second call from doing anything, but there's no reason to pay
// for a full row rebuild just to recolor one square.
function recolorInfoSquare(domain, ruleCount) {
    const row = rowRegistry.get(domain);
    const square = row?.querySelector('.td-info .mini-square');
    if ( square ) {
        square.classList.remove(...INFO_TIER_CLASSES);
        square.classList.add(INFO_TIER_CLASS[infoTierForCount(ruleCount)]);
    }
}

function buildDetailRow(domain, lines) {
    const tr = dom.create('tr');
    tr.className = 'row-detail';
    const td = dom.create('td');
    td.colSpan = columns.length;

    if ( lines.length === 0 ) {
        const empty = dom.create('div');
        empty.className = 'detail-empty';
        empty.textContent = 'No rules in the currently enabled filter lists apply to this domain on this site.';
        td.appendChild(empty);
    } else {
        // Disclaimer only earns its place when there's genuine ambiguity
        // to warn about — one line, alone, has nothing to disclaim (per
        // explicit request/example: a single rule with this paragraph
        // above it was confusing, not informative).
        if ( lines.length > 1 ) {
            const note = dom.create('div');
            note.className = 'detail-note';
            note.textContent = 'Raw matching rules — not a final blocked/allowed verdict. Priority order shown (highest first), but which rule actually applies for a specific request isn\'t resolved here.';
            td.appendChild(note);
        }
        const list = dom.create('ul');
        list.className = 'detail-rule-list';
        for ( const line of lines ) {
            const li = dom.create('li');
            li.className = `detail-rule detail-rule-${line.action}` + (line.grouped ? ' detail-rule-grouped' : '');
            li.textContent = line.text;
            list.appendChild(li);
        }
        td.appendChild(list);
    }

    tr.appendChild(td);
    return tr;
}

async function expandDomainDetail(domain) {
    const lines = detailCache.get(domain) ?? await fetchProcessedDomainRules(domain);
    const domainRow = rowRegistry.get(domain);
    if ( !domainRow ) { return; } // row disappeared (e.g. cleared) before the round-trip finished
    // Idempotent: if this domain's detail row is already open (e.g. a
    // REFRESH-triggered re-fetch — see handleRefreshClick() below —
    // calling this again for an already-expanded row), replace the
    // existing row's content in place rather than inserting a second
    // one alongside it.
    const existingDetailRow = expandedDetailRows.get(domain);
    const detailRow = buildDetailRow(domain, lines);
    if ( existingDetailRow ) { existingDetailRow.replaceWith(detailRow); }
    else { domainRow.after(detailRow); }
    expandedDetailRows.set(domain, detailRow);
}

function collapseDomainDetail(domain) {
    const detailRow = expandedDetailRows.get(domain);
    if ( detailRow ) { detailRow.remove(); }
    expandedDetailRows.delete(domain);
    // Cache is intentionally NOT cleared here — collapsing and
    // re-expanding the same domain a moment later should be instant, not
    // a redundant re-fetch. The cache is only ever invalidated by
    // REFRESH (handleRefreshClick() below), which is this panel's own
    // existing, explicit "re-evaluate everything now" action — the right
    // place for "this might be stale" to be resolved deliberately,
    // rather than defeating the cache's whole purpose on every ordinary
    // collapse click.
}

// Sets a domain row's expand arrow (closed / open).
function setExpandMarker(domain, open) {
    const marker = rowRegistry.get(domain)?.querySelector('.td-expand .expand-marker');
    if ( marker ) { marker.textContent = open ? EXPAND_MARKER_OPEN : EXPAND_MARKER_CLOSED; }
}

/* ══════════════════════════════════════════════════════════════
   14. TABLE CLICK HANDLERS + MODE SWITCH
   ══════════════════════════════════════════════════════════════ */

// Event delegation on the tbody, so re-rendering a row on every update
// never requires re-attaching per-cell listeners.

// Expand-column click: toggles the raw-rule detail row.
async function onExpandCellClick(ev) {
    const cell = ev.target.closest('.td-expand.clickable');
    if ( !cell ) { return; }
    const { domain } = cell.dataset;
    const marker = cell.querySelector('.expand-marker');
    if ( expandedDetailRows.has(domain) ) {
        collapseDomainDetail(domain);
        if ( marker ) { marker.textContent = EXPAND_MARKER_CLOSED; }
    } else {
        // Set the marker to open state immediately (don't wait for the
        // round-trip) — the click itself is the user's intent, and a
        // slow/failed fetch shouldn't leave the arrow looking unclicked.
        if ( marker ) { marker.textContent = EXPAND_MARKER_OPEN; }
        await expandDomainDetail(domain);
    }
}

// Click-to-override on a 3P-all / 3P-code cell.
async function onScopeCellClick(ev) {
    const cell = ev.target.closest('.td-half.clickable');
    if ( !cell ) { return; }
    const { domain, scope } = cell.dataset;
    const entry = entryRegistry.get(domain);
    const currentOverride = entry?.override?.[scope] ?? null;
    // The action a click writes depends on the CURRENT mode (block mode ->
    // 'block', allow mode -> 'allow') — see this file's header for the
    // full mode semantics. Clicking a cell already at that exact action
    // clears it; clicking anything else (empty, or the opposite action)
    // sets/overwrites it to the current mode's action — this lets a user
    // switch a domain from blocked to allowed just by toggling mode and
    // clicking again, without needing to clear first.
    const modeAction = currentModeAction();
    const newAction = currentOverride === modeAction ? null : modeAction;
    const resp = await sendMessage({ what: MSG_MATRIX_SET_OVERRIDE, domain, scope, action: newAction });
    if ( !resp?.ok ) { return; }
    if ( entry ) {
        entry.override = entry.override ?? { all: null, code: null };
        entry.override[scope] = newAction;
        upsertEntry(entry, { skipVisibilityUpdate: true });
    }
}

// (11.1.0) Bulk buttons by Break risk — see BULK_BUTTONS_BY_MODE (Config).
// A row qualifies when it is visible in the current mode, its risk is one of the button's levels, and its 3P-all
// override is not yet the current mode's action. A row persisted without a risk reads as unknown (renderBreakRiskCell).
function bulkTargets(levels) {
    const action = currentModeAction();
    const targets = [];
    for ( const [ domain, row ] of rowRegistry ) {
        const entry = entryRegistry.get(domain);
        if ( !entry || row.classList.contains('row-hidden') ) { continue; }
        const level = RISK_BADGE[entry.breakageRisk] !== undefined ? entry.breakageRisk : RISK_UNKNOWN;
        if ( !levels.includes(level) || entry.override?.[BULK_SCOPE] === action ) { continue; }
        targets.push(entry);
    }
    return targets;
}

function renderBulkButtons() {
    elBulkButtons.textContent = '';
    for ( const spec of BULK_BUTTONS_BY_MODE[currentMode()] ) {
        const button = dom.create('button');
        button.type = 'button';
        button.classList.add('monitor-btn', spec.className);
        button.textContent = spec.label;
        button.title = spec.title;
        button.addEventListener('click', ( ) => { onBulkButtonClick(spec.levels); });
        elBulkButtons.appendChild(button);
    }
    updateBulkButtons();
}

// Disabled while a batch runs, or while the button has nothing to do.
function updateBulkButtons() {
    const specs = BULK_BUTTONS_BY_MODE[currentMode()];
    elBulkButtons.querySelectorAll('button').forEach((button, i) => {
        button.disabled = bulkInFlight || bulkTargets(specs[i].levels).length === 0;
    });
}

async function onBulkButtonClick(levels) {
    if ( bulkInFlight ) { return; }
    const targets = bulkTargets(levels);
    if ( targets.length === 0 ) { return; }
    const action = currentModeAction();
    bulkInFlight = true;   // GUARD (init): no overlapping batch
    updateBulkButtons();
    try {
        const changes = targets.map(entry => ({ domain: entry.domain, scope: BULK_SCOPE, action }));
        const resp = await sendMessage({ what: MSG_MATRIX_SET_OVERRIDES, changes });
        if ( !resp?.ok ) { return; }
        // Same local update as one click (onScopeCellClick): the rows keep their place until REFRESH.
        for ( const entry of targets ) {
            entry.override = entry.override ?? { all: null, code: null };
            entry.override[BULK_SCOPE] = action;
            upsertEntry(entry, { skipVisibilityUpdate: true, deferStats: true });
        }
        renderStats();
    } finally {
        bulkInFlight = false;   // GUARD (release): always re-enabled, also after a failed send
        updateBulkButtons();
    }
}

function onModeSwitchChange() {
    // BUG FIX (real, screenshotted report): applyRowVisibility() (called
    // via refreshMatrixView() below) only toggles the 'row-hidden' class
    // on each DOMAIN row — it never touches a currently-open detail row,
    // which is a separate DOM sibling (see expandDomainDetail()) not
    // covered by that visibility pass at all. Left open across a mode
    // switch, a detail row whose own domain row just became hidden stays
    // visibly rendered, immediately under whatever row is now visible
    // above it — reading as "belonging" to the wrong domain, since
    // nothing about its position changed even though its actual owner
    // disappeared. Collapsing everything before the switch is simpler
    // and safer than trying to keep open detail rows in sync with a
    // visibility set that's about to change out from under them — the
    // underlying "raw matching rules" content is also worth re-showing
    // fresh anyway, since which rules are relevant can itself read
    // differently once BLOCK/ALLOW mode's own labeling changes.
    for ( const domain of [ ...expandedDetailRows.keys() ] ) {
        collapseDomainDetail(domain);
        setExpandMarker(domain, false);
    }
    buildHeader();
    refreshMatrixView();
}

/* ══════════════════════════════════════════════════════════════
   15. SESSION CLOCK, POLL AND CLOSE
   ══════════════════════════════════════════════════════════════ */

// Clock — same format()/tick() shape as privacy-inspector.js's own.
function format(ms) {
    const seconds = Math.ceil(Math.max(0, ms) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function startClock(startTime, elapsed) {
    clearInterval(clock);
    function tick() {
        const remaining = TIMEOUT_MS - elapsed - (Date.now() - startTime);
        elTimer.textContent = format(remaining);
        elTimer.classList.toggle('warning', remaining <= CLOCK_WARNING_MS && remaining > 0);
        elTimer.classList.toggle('expired', remaining <= 0);
        if ( remaining <= 0 ) {
            clearInterval(clock);
            stopMatrixAndCloseWindow();
        }
    }
    tick();
    clock = setInterval(tick, CLOCK_TICK_MS);
}

async function stopMatrixAndCloseWindow() {
    stopPoll();
    try {
        await Promise.race([
            sendMessage({ what: MSG_STOP_MATRIX }),
            new Promise(resolve => setTimeout(resolve, STOP_MESSAGE_TIMEOUT_MS)),
        ]);
    } catch {
        // sendMessage() already swallows its own retry failures — this
        // catch is defensive, same reasoning as privacy-inspector.js's
        // identical guard.
    }
    window.close();
}

// Poll safety net — an independent second path to closing (B3b): asks the
// background every MATRIX_POLL_MS whether the session still exists.
function startPoll() {
    stopPoll();
    pollHandle = setInterval(async () => {
        const snap = await sendMessage({ what: MSG_GET_MATRIX_DATA });
        if ( !snap ) { stopPoll(); window.close(); }
    }, MATRIX_POLL_MS);
}

function stopPoll() {
    if ( pollHandle !== null ) {
        clearInterval(pollHandle);
        pollHandle = null;
    }
}

/* ══════════════════════════════════════════════════════════════
   16. REFRESH BUTTON
   ══════════════════════════════════════════════════════════════ */

// Re-evaluates the panel's own row list immediately (no round-trip needed
// for that part, see refreshMatrixView()), AND reloads the actual monitored
// tab so an override set since the tab last loaded — in EITHER direction,
// new blocks and new allows alike — takes visible effect. See
// MSG_RELOAD_MATRIX_TAB's own doc comment in message-types.js for why a
// plain override write isn't enough by itself on a page that's already
// loaded.
async function handleRefreshClick() {
    if ( refreshInFlight ) { return; }
    refreshInFlight = true;
    elRefresh.disabled = true; // visible feedback + belt-and-suspenders alongside the flag above
    refreshMatrixView();
    // Expand-column detail cache (per explicit request) — REFRESH is
    // this panel's own existing "re-evaluate everything now" action, so
    // it's the natural place to invalidate detailCache too (see
    // collapseDomainDetail()'s own comment for why an ordinary collapse
    // deliberately does NOT do this). Any row currently expanded gets
    // its content re-fetched and replaced immediately, not left showing
    // stale data until manually closed and reopened.
    const openDomains = [ ...expandedDetailRows.keys() ];
    detailCache.clear();
    for ( const domain of openDomains ) { expandDomainDetail(domain); }
    try {
        const resp = await sendMessage({ what: MSG_RELOAD_MATRIX_TAB });
        if ( !resp?.ok ) {
            // Previously silently ignored — a background-side failure
            // (no active session, tab already closed, etc.) looked
            // identical to "nothing happens" from here. Now at least
            // discoverable via the panel's own DevTools console.
            console.error(`[uBlock-Dynamic] REFRESH: tab reload failed — ${resp?.error ?? 'no response'}`);
        }
    } finally {
        elRefresh.disabled = false;
        refreshInFlight = false;
    }
}

/* ══════════════════════════════════════════════════════════════
   17. BROADCAST MESSAGES
   ══════════════════════════════════════════════════════════════ */

function onBroadcastMessage(event) {
    const message = event.data;
    if ( message?.what === MSG_MATRIX_ENTRY ) {
        upsertEntry(message.entry);
        return;
    }
    if ( message?.what === MSG_MATRIX_CLOSED ) {
        clearInterval(clock);
        stopPoll();
        broadcastChannel.close();
        window.close();
    }
}

/* ══════════════════════════════════════════════════════════════
   18. BOOTSTRAP
   ══════════════════════════════════════════════════════════════ */

function loadRulesetNames() {
    loadRulesetDetailsMap().then(map => { rulesetNameMap = map; });
}

// Empties every per-session registry and the table body.
function resetPanelState() {
    elBody.textContent = '';
    rowRegistry.clear();
    entryRegistry.clear();
    expandedDetailRows.clear();
    detailCache.clear();
    pendingDetailFetches.clear();
}

// Renders a session snapshot from the background and starts the session's timers.
function renderSnapshot(snapshot) {
    currentHost = snapshot.session.host;
    elHost.textContent = currentHost;
    buildHeader(); // refresh — column tooltips now name the real site
    resetPanelState();
    const fragment = document.createDocumentFragment();
    for ( const entry of snapshot.entries ) { upsertEntry(entry, { fragment, deferStats: true }); }
    elBody.appendChild(fragment);
    renderStats();
    updateBulkButtons();   // (11.1.0) rows are in the DOM now, so their visibility can be read
    startClock(snapshot.session.startTime, snapshot.session.timeElapsed);
    startPoll();
}

// The session snapshot for this panel; starts a session first when none exists.
async function fetchOrStartSession() {
    let snapshot = await sendMessage({ what: MSG_GET_MATRIX_DATA });
    if ( !snapshot ) {
        // No session yet for this tab — start one. The popup normally starts
        // the session before opening this panel, so this is a defensive
        // fallback path, not the common case.
        const tabIdParam = new URLSearchParams(location.search).get('tabId');
        await sendMessage({
            what: MSG_START_MATRIX,
            tabId: tabIdParam ? Number(tabIdParam) : undefined,
        });
        snapshot = await sendMessage({ what: MSG_GET_MATRIX_DATA });
    }
    return snapshot;
}

loadRulesetNames();
elBody.addEventListener('click', onExpandCellClick);
elBody.addEventListener('click', onScopeCellClick);
showBlockedToggle.addEventListener('change', onModeSwitchChange);
elRefresh.addEventListener('click', handleRefreshClick);
elExit.addEventListener('click', stopMatrixAndCloseWindow);

const broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
broadcastChannel.onmessage = onBroadcastMessage;

buildHeader(); // immediate, generic tooltip text — refreshed once currentHost is known

const snapshot = await fetchOrStartSession();
if ( !snapshot ) {
    window.close();
} else {
    renderSnapshot(snapshot);
}
