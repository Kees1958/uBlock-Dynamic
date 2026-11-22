/*******************************************************************************

    uBlock-Stripped-Dynamic — Custom Rules dashboard pane
    Renders cosmetic rules (site.* from storage) and DNR block rules
    (created by the block monitor), with per-rule delete and clear-all.

    DESIGN NOTE — why the three categories show different hostname
    formats for what may be "the same site" (e.g. cosmetic/scriptlet
    show "www.ad.nl", Dynamic DNR shows "ad.nl"): this is deliberate on
    both sides, not an inconsistency to fix.
      - Cosmetic (element picker, picker.js) and Privacy/scriptlet
        (Privacy Inspector) rules store the EXACT hostname the page had
        at creation time, unnormalized — see picker.js's own
        `toolOverlay.url.hostname` usage. Precision is the point: a
        cosmetic selector is tied to that specific page's DOM structure,
        so keeping the exact hostname (rather than broadening it) avoids
        a rule silently applying to some other subdomain of the same
        site that may have a completely different layout.
      - Dynamic DNR overrides are deliberately stored keyed by eTLD+1 —
        see js/core/matrix-block-rules.js's own header comment ("site =
        eTLD+1 of the page being browsed"). A DNR override decides
        whether to block/allow a THIRD-PARTY domain, a coarser,
        subdomain-independent decision where site-wide scope is the
        actually-wanted behavior, not a side effect.
      - Trade-off this creates: matchesFromHostname() (js/util/utils.js)
        registers a stored hostname plus its OWN subdomains only, never
        its parent — so a cosmetic rule stored under "www.ad.nl" won't
        automatically also fire on bare "ad.nl" (or vice versa) if a
        site happens to redirect between the two. Deliberately left
        as-is rather than normalizing cosmetic/scriptlet hostnames to
        eTLD+1 too: that would fix the cross-hostname-variant matching
        gap, but at the cost of the exact-hostname precision described
        above. Revisit only if that redirect scenario turns out to be a
        real, recurring problem in practice — see this same discussion
        for the "register both the exact hostname and its eTLD+1
        wildcard, but keep storing/showing the exact one" middle-ground
        option, not yet implemented.
      - Cookie/consent-clicker rules follow the SAME exact-hostname
        convention as Cosmetic (siteHostname = the page's own hostname
        at pick time, unnormalized) — for the identical reason: a
        picked selector is tied to that specific page's DOM, precision
        over broad matching. See js/core/cookie-clicker-rules.js's own
        header for the (siteHostname, frameHostname) pair this category
        additionally stores, which the other three don't need.

*******************************************************************************/

import { dom, qs$ } from '../js/ui/dom.js';
import { browser, sendMessage } from '../js/data/ext.js';
import { DNR_TRACKING_FILTER_NAME } from '../js/data/ui-names.js';   // (11.0.0) was "Dynamic DNR"
import {
    describeScriptletRule,
    getScriptletRuleRisk,
    getScriptletRuleApi,
} from '../js/data/scriptlet-rule-labels.js';
import {
    RISK_BADGE,
    RISK_UNKNOWN,
    UNKNOWN_RISK_REASON_RULE as UNKNOWN_RISK_REASON,
} from '../js/data/risk-badge.js';
import {
    MSG_GET_CUSTOM_COSMETIC_RULES,
    MSG_DELETE_COSMETIC_RULE,
    MSG_GET_MATRIX_BLOCK_RULES,
    MSG_DELETE_MATRIX_BLOCK_RULE,
    MSG_GET_PRIVACY_SCRIPTLET_RULES,
    MSG_DELETE_PRIVACY_SCRIPTLET_RULE,
    MSG_EXPORT_CUSTOM_RULES,
    MSG_IMPORT_CUSTOM_RULES,
    MSG_DELETE_FILTERED_CUSTOM_RULES,
    MSG_GET_COOKIE_CLICKER_RULES,
    MSG_DELETE_COOKIE_CLICKER_RULE,
} from '../js/data/message-types.js';
import { DOWNLOAD_URL_REVOKE_DELAY_MS } from '../js/data/timing-constants.js';
import { checkImportFileSize } from '../js/util/input-limits.js';

/******************************************************************************/
// (audit 10.6.4, B15) The "created" date cell and the ✕ delete button were written out by hand,
// identically, in every rule-list renderer below. One builder each now.

function createRuleDateCell(createdAt) {
    const dateEl = dom.create('span');
    dateEl.className = 'rule-created-date';
    dateEl.textContent = createdAt;
    dateEl.title = `Created ${createdAt}`;
    return dateEl;
}

// data — the dataset entries the list's click handler reads back ({ uid } or { hostname, selector })
function createRuleDeleteButton(data, title = 'Delete this rule') {
    const btn = dom.create('button');
    btn.className = 'rule-delete-btn';
    btn.type = 'button';
    btn.textContent = '✕';
    btn.title = title;
    Object.assign(btn.dataset, data);
    return btn;
}

/******************************************************************************/

function isPaneActive() {
    return document.body.dataset.pane === 'customrules';
}

/******************************************************************************/
// Domain filter — one text field, filters all three rule sections
// (cosmetic, Dynamic DNR, scriptlet) by a "contains" match. '' (the
// default) means show everything; set from the #customRulesDomainFilter
// input's own event listener near the bottom of this file.
/******************************************************************************/

let domainFilter = '';

function matchesFilter(text) {
    if ( domainFilter === '' ) { return true; }
    return String(text ?? '').toLowerCase().includes(domainFilter);
}

/******************************************************************************/
// Cosmetic rules rendering
/******************************************************************************/

// Display-only decode for procedural cosmetic selectors. Element-picker
// rules land in "site.*" storage in one of two shapes (see
// js/core/filter-manager.js's own isProcedural()/isCSS() helpers, same
// "starts with '{'" test used here so this file doesn't grow a second,
// competing definition of "procedural"):
//   - a plain CSS selector string ("div.ad-banner") — returned as-is; or
//   - a procedural selector, JSON-encoded for the compact runtime task
//     format js/scripting/css-procedural-api.js's PSelector/PSelectorRoot
//     actually consumes (has-text(), matches-css(), etc. compiled into a
//     `tasks` array instead of literal syntax).
// That compiled JSON always carries the ORIGINAL, human-readable filter
// syntax straight back in its own `raw` field — set once, at compile
// time, in js/core/ext-selector-compiler.js's compile() (`out.compiled.raw
// = raw` right before the JSON.stringify()) — so recovering it for
// display here is just JSON.parse + read `.raw`, not a second
// implementation of the task-name-to-syntax mapping.
// Guard: deliberately returns the raw stored string on ANY parse failure
// or missing `.raw` (unexpected/future compiled shape) rather than
// throwing or hiding the rule — every stored rule stays visible either
// way, worst case as the compiled JSON instead of the friendlier syntax.
// Deliberately DISPLAY-ONLY: callers keep using the untouched `selector`
// (still raw JSON for procedural entries) for the delete button's
// `dataset.selector` — see renderCosmeticRules() below — so this can't
// change what actually gets matched against storage on delete.
function describeCosmeticSelector(selector) {
    if ( selector.startsWith('{') === false ) { return selector; }
    try {
        const parsed = JSON.parse(selector);
        if ( typeof parsed.raw === 'string' && parsed.raw !== '' ) {
            return parsed.raw;
        }
    } catch {
        // Malformed/unrecognized JSON — fall through, see guard comment above.
    }
    return selector;
}

function renderCosmeticRules(allFilters) {
    const list = qs$('#cosmeticRulesList');
    const emptyMsg = qs$('#cosmeticEmpty');

    Array.from(list.children).forEach(child => {
        if ( child !== emptyMsg ) { child.remove(); }
    });

    const nonEmpty = allFilters.filter(([, selectors]) => selectors.length > 0);

    if ( nonEmpty.length === 0 ) {
        emptyMsg.textContent = 'No cosmetic rules saved.';
        emptyMsg.style.display = '';
        return;
    }

    // Each group IS one domain (hostname), so the filter just keeps or
    // drops whole groups — no need to filter inside a group.
    const visible = nonEmpty.filter(([hostname]) => matchesFilter(hostname));
    if ( visible.length === 0 ) {
        emptyMsg.textContent = 'No cosmetic rules match this filter.';
        emptyMsg.style.display = '';
        return;
    }
    emptyMsg.style.display = 'none';

    for ( const [hostname, entries] of visible ) {
        for ( const { selector, createdAt } of entries ) {
            // One flat row per selector, domain repeated on every row —
            // matches the Dynamic DNR / Privacy (scriptlet) rows' shape
            // now (see renderMatrixRules() / renderScriptletRules()
            // below), replacing the previous "hostname heading + indented
            // selector rows" grouping. Per feedback: cosmetic rules
            // should also be one line each, with the domain column the
            // same fixed width as the other two categories', so all
            // three sections' domain columns actually line up.
            const row = dom.create('div');
            row.className = 'dnr-rule-row';

            const domainEl = dom.create('span');
            // 'dnr-domain' (fixed-width column, scoped below to
            // #cosmeticRulesList — same 11em value the other two
            // categories already use) + 'rule-domain' (shared bold
            // treatment) — same two-class pattern already used for the
            // scriptlet hostname column, see custom-rules.css section 4a
            // and 5b.
            domainEl.className = 'dnr-domain rule-domain';
            domainEl.textContent = hostname;
            domainEl.title = hostname;

            const text = dom.create('span');
            text.className = 'cosmetic-selector-text';
            // Displayed text is DECODED (see describeCosmeticSelector()'s
            // own comment above); .title and the delete button's
            // dataset both keep the RAW stored string — so a procedural
            // rule now reads as e.g. "div.ad:has-text(Advertisement)"
            // instead of its compiled JSON, without changing what's
            // actually compared/removed in storage on delete.
            text.textContent = describeCosmeticSelector(selector);
            text.title = selector;

            const dateEl = createRuleDateCell(createdAt);

            const btn = createRuleDeleteButton({ hostname, selector });

            row.appendChild(domainEl);
            row.appendChild(text);
            row.appendChild(dateEl);
            row.appendChild(btn);
            list.appendChild(row);
        }
    }
}

let cosmeticRulesRaw = []; // last-fetched rules, re-filtered locally on every filter keystroke — see the #customRulesDomainFilter 'input' listener below

async function loadCosmeticRules() {
    const allFilters = await sendMessage({ what: MSG_GET_CUSTOM_COSMETIC_RULES });
    cosmeticRulesRaw = Array.isArray(allFilters) ? allFilters : [];
    renderCosmeticRules(cosmeticRulesRaw);
}

/******************************************************************************/
// Cookie/consent-clicker rule rendering
//
// Deliberately byte-for-byte the SAME row shape as the cosmetic rows
// just above (domain, selector text, date, delete) — this feature IS
// conceptually "the cosmetic element picker, but for clicking instead of
// hiding", so its Manage Custom Rules row should read the same way, per
// feedback asking for exactly that resemblance. The one addition:
// when a rule's button lives in a DIFFERENT frame than the site itself
// (a cross-origin CMP iframe — see COOKIE-CLICKER-DESIGN.md for why that
// case exists at all), the selector text carries a small "via
// <frameHostname>" suffix so that distinction stays visible without
// needing a whole extra column that every OTHER row would just leave
// blank.
/******************************************************************************/

// Duplicated from js/scripting/cookie-clicker-click.js's own
// BUILTIN_SITE_RULES keys — see this file's own renderCookieClickerRules()
// comment (collisionWarning) for why this is a duplicated constant, not
// a shared import.
const BUILTIN_COOKIE_CLICKER_SITES = new Set([ 'myprivacy.dpgmedia.nl' ]);

function renderCookieClickerRules(rules) {
    const list = qs$('#cookieClickerRulesList');
    const emptyMsg = qs$('#cookieClickerEmpty');

    Array.from(list.children).forEach(child => {
        if ( child !== emptyMsg ) { child.remove(); }
    });

    if ( !rules || rules.length === 0 ) {
        emptyMsg.textContent = 'No cookie consent-clicker rules saved.';
        emptyMsg.style.display = '';
        return;
    }

    const visible = rules.filter(rule => matchesFilter(rule.siteHostname) || matchesFilter(rule.frameHostname));
    if ( visible.length === 0 ) {
        emptyMsg.textContent = 'No cookie consent-clicker rules match this filter.';
        emptyMsg.style.display = '';
        return;
    }
    emptyMsg.style.display = 'none';

    for ( const rule of visible ) {
        const row = dom.create('div');
        row.className = 'dnr-rule-row';

        const domainEl = dom.create('span');
        // Same two-class pattern (fixed-width column + shared bold
        // treatment) #cosmeticRulesList's own domain column uses — see
        // custom-rules.css section 4/4a and this list's own
        // #cookieClickerRulesList .dnr-domain rule.
        domainEl.className = 'dnr-domain rule-domain';
        domainEl.textContent = rule.siteHostname;
        domainEl.title = rule.siteHostname;

        const text = dom.create('span');
        // Reuses .cosmetic-selector-text unchanged (monospace, ellipsis,
        // flexible width) — the class name is a holdover from that
        // section, but the styling it provides ("a CSS-selector-shaped
        // string in a flexible middle column") is exactly what this row
        // needs too, so a second, visually-identical class was not
        // worth introducing.
        text.className = 'cosmetic-selector-text';
        const viaSuffix = rule.frameHostname !== rule.siteHostname ? ` (via ${rule.frameHostname})` : '';
        // Collision guard — a real, previously-invisible confusion: a
        // manually-saved rule for the same site as a BUILT-IN one
        // (js/scripting/cookie-clicker-click.js's own BUILTIN_SITE_RULES)
        // silently races it, with no signal anywhere that this was even
        // possible. Duplicated list here rather than shared — cookie-
        // clicker-click.js is a plain, non-module content script (no
        // import/export at all, top-level await only), this file IS a
        // module; same "independent copies, no shared import surface
        // between execution contexts" posture already established for
        // STORAGE_KEY/COOKIE_CLICKER_STORAGE_KEY (see cookie-clicker-
        // click.js's own comment on that constant). Keep in sync by hand
        // if BUILTIN_SITE_RULES's keys ever change.
        const collisionWarning = BUILTIN_COOKIE_CLICKER_SITES.has(rule.siteHostname)
            ? ' \u26A0\uFE0F also has a built-in rule'
            : '';
        text.textContent = rule.selector + viaSuffix + collisionWarning;
        text.title = rule.textFilter
            ? `${rule.selector}${viaSuffix} — text filter: "${rule.textFilter}"`
            : `${rule.selector}${viaSuffix}`;
        if ( collisionWarning !== '' ) {
            text.classList.add('rule-has-builtin-collision');
            // (11.0.0, owner) No internal code references in user-facing hover text.
            text.title += ' — this site also has a built-in Cookie consent clicker rule. Both work independently: whichever button appears first is clicked, so your rule may not be needed, or may click before the built-in one.';
        }

        const dateEl = createRuleDateCell(rule.createdAt);

        const btn = createRuleDeleteButton({ uid: rule.uid });

        row.appendChild(domainEl);
        row.appendChild(text);
        row.appendChild(dateEl);
        row.appendChild(btn);
        list.appendChild(row);
    }
}

let cookieClickerRulesRaw = []; // last-fetched rules, re-filtered locally on every filter keystroke — see the #customRulesDomainFilter 'input' listener below

async function loadCookieClickerRules() {
    const rules = await sendMessage({ what: MSG_GET_COOKIE_CLICKER_RULES });
    cookieClickerRulesRaw = Array.isArray(rules) ? rules : [];
    renderCookieClickerRules(cookieClickerRulesRaw);
}

/******************************************************************************/
// DNR block rules rendering
/******************************************************************************/

/******************************************************************************/
// 3P Matrix block rules rendering
//
// Deliberately simpler than the old DNR rules renderer this replaces (no
// tracker badge, no scope badge, no edit-scope — see matrix-block-rules.js's
// header: ONE override per domain, ANY resource type, no per-site scoping
// concept to render). Domain is the uid — deleting a row calls
// setMatrixOverride(domain, null), which re-allows that domain.
/******************************************************************************/

function renderMatrixRules(rules) {
    const list = qs$('#matrixRulesList');
    const emptyMsg = qs$('#matrixEmpty');

    Array.from(list.children).forEach(child => {
        if ( child !== emptyMsg ) { child.remove(); }
    });

    if ( !rules || rules.length === 0 ) {
        emptyMsg.textContent = `No ${DNR_TRACKING_FILTER_NAME} rules saved.`;
        emptyMsg.style.display = '';
        return;
    }

    // Matches on EITHER field — the site the override is scoped to, or
    // the third-party domain it blocks/allows — so typing a domain finds
    // it whichever role it plays (see matchesFilter()'s own header).
    const visible = rules.filter(rule => matchesFilter(rule.site) || matchesFilter(rule.domain));
    if ( visible.length === 0 ) {
        emptyMsg.textContent = `No ${DNR_TRACKING_FILTER_NAME} rules match this filter.`;
        emptyMsg.style.display = '';
        return;
    }
    emptyMsg.style.display = 'none';

    for ( const rule of visible ) {
        const row = dom.create('div');
        row.className = 'dnr-rule-row';

        // Overall row action for the domain-cell tooltip and the dot
        // below: if both scopes agree, name it directly; if they differ
        // (e.g. all=block, code=allow — an unusual but valid
        // combination), say "mixed" rather than guessing which one the
        // user cares about more.
        const actions = new Set([ rule.all, rule.code ].filter(Boolean));
        const rowAction = actions.size === 1 ? [ ...actions ][0] : 'mixed';

        // Column 1 — the site this override is scoped to ("on
        // foxnews.com"). Fixed 11em width — deliberately the SAME value
        // as #scriptletRulesList .dnr-domain's own fixed width below,
        // per feedback asking for the two sections' domain columns to
        // line up. See .dnr-rule-site in custom-rules.css for the actual
        // width rule and why a fixed value (not the old flex: 45 1 0%)
        // was needed for that alignment to hold.
        const siteEl = dom.create('span');
        // 'rule-domain' = shared bold treatment for "the domain a rule
        // applies to" (here: the site the override is scoped to), same
        // token used by the cosmetic and scriptlet rows — see
        // custom-rules.css section 4a. Deliberately NOT added to
        // `target` below (the third-party tracker domain, a different
        // column with a different meaning — see that rule's own comment
        // in custom-rules.css).
        siteEl.className = 'dnr-rule-site rule-domain';
        siteEl.textContent = `on ${rule.site}`;
        siteEl.title = `Scoped to ${rule.site} only — not applied on other sites`;

        // Column 2 — the rule-action dot (red = block, green = allow,
        // split = mixed). Wrapped in .scriptlet-risk-badge — the EXACT
        // same class the scriptlet rows use for their own dot/badge
        // column (see renderScriptletRules() below) — not a lookalike
        // copy, so this column's width/centering can't drift out of
        // alignment with that one even if either gets tweaked later.
        // Previously this dot lived bundled inside .dnr-rule-actions
        // together with the label text as one flex item; split into its
        // own top-level column here so it lines up with the scriptlet
        // dot column specifically, per feedback, rather than floating at
        // whatever x position the combined group happened to start at.
        const dot = dom.create('span');
        dot.className = `rule-action-dot rule-action-dot-${rowAction}`;
        dot.title = rowAction === 'mixed'
            ? `Mixed: 3P-all is ${rule.all}, 3P-code is ${rule.code}`
            : `This override ${rowAction === 'block' ? 'blocks' : 'allows'} ${rule.domain} on ${rule.site}`;
        const dotCol = dom.create('span');
        dotCol.className = 'scriptlet-risk-badge';
        dotCol.appendChild(dot);

        // Column 3 — action + scope label(s) ("BLOCK 3P-ALL"), in the
        // same column position scriptlet rows use for their technical
        // API label (#scriptletRulesList .scriptlet-api-label) — same
        // 15em fixed width (see #matrixRulesList .scriptlet-rule-label
        // in custom-rules.css), so that whatever comes next lines up
        // with scriptlet rows' description column too (see target,
        // below). The two override scopes can legitimately differ (see
        // rowAction above), so this can't just be a single shared word.
        const sides = [];
        if ( rule.all ) { sides.push(`${rule.all.toUpperCase()} 3P-ALL`); }
        if ( rule.code ) { sides.push(`${rule.code.toUpperCase()} 3P-CODE`); }
        const sidesEl = dom.create('span');
        sidesEl.className = 'scriptlet-rule-label';
        sidesEl.textContent = sides.join(' · ');
        sidesEl.title = sides.join(', ');

        // Column 4 — the third-party domain being blocked/allowed, in
        // the same column position scriptlet rows use for their
        // plain-language description (#scriptletRulesList's nameEl,
        // below) — the one flexible, "whatever's left" column in the
        // row now that columns 1-3 are all fixed-width and matched to
        // their scriptlet-row counterparts (see custom-rules.css's
        // #matrixRulesList .dnr-domain: flex: 1 1 auto).
        const target = dom.create('span');
        target.className = 'dnr-domain';
        target.textContent = rule.domain;
        target.title = `${rule.domain} — ${rowAction} while browsing ${rule.site}`;

        const dateEl = createRuleDateCell(rule.createdAt);

        const btn = createRuleDeleteButton(
            { uid: rule.uid },
            `Delete this rule (removes the override — ${rule.domain} on ${rule.site} returns to normal handling)`,
        );

        // Row order: site, dot, label, target domain, date, delete — a
        // flat, six-top-level-child structure that deliberately mirrors
        // renderScriptletRules()'s row (domain, risk badge, API label,
        // description, date, delete) child-for-child, not just
        // column-width-for-column-width. Same class (.dnr-rule-row) on
        // both, so the shared `gap` between children is identical too —
        // matching child count AND matching fixed widths together is
        // what makes column 4 (target) actually start at the same x as
        // scriptlet rows' description column, not just an approximation.
        row.appendChild(siteEl);
        row.appendChild(dotCol);
        row.appendChild(sidesEl);
        row.appendChild(target);
        row.appendChild(dateEl);
        row.appendChild(btn);
        list.appendChild(row);
    }
}

let matrixRulesRaw = []; // last-fetched rules, re-filtered locally on every filter keystroke — see the #customRulesDomainFilter 'input' listener below

async function loadMatrixRules() {
    const rules = await sendMessage({ what: MSG_GET_MATRIX_BLOCK_RULES });
    matrixRulesRaw = Array.isArray(rules) ? rules : [];
    renderMatrixRules(matrixRulesRaw);
}


/******************************************************************************/
// Privacy Inspector scriptlet rules rendering
// List + delete only, per design — no inline editing here. Rules are
// created exclusively through Privacy Inspector's "Select" mitigation
// button; this pane is read/delete visibility for them, not an editor.
/******************************************************************************/

function renderScriptletRules(rules) {
    const list = qs$('#scriptletRulesList');
    const emptyMsg = qs$('#scriptletEmpty');

    Array.from(list.children).forEach(child => {
        if ( child !== emptyMsg ) { child.remove(); }
    });

    if ( !rules || rules.length === 0 ) {
        emptyMsg.textContent = 'No Anti-fingerprinting scriptlets saved.';
        emptyMsg.style.display = '';
        return;
    }

    const visible = rules.filter(rule => matchesFilter(rule.hostname));
    if ( visible.length === 0 ) {
        emptyMsg.textContent = 'No Anti-fingerprinting scriptlets match this filter.';
        emptyMsg.style.display = '';
        return;
    }
    emptyMsg.style.display = 'none';

    for ( const rule of visible ) {
        const row = dom.create('div');
        row.className = 'dnr-rule-row';

        const hostEl = dom.create('span');
        // 'rule-domain' = shared bold treatment for "the domain a rule
        // applies to", same token used by the cosmetic and DNR rows —
        // see custom-rules.css section 4a.
        hostEl.className = 'dnr-domain rule-domain';
        hostEl.textContent = rule.hostname;
        hostEl.title = rule.hostname;

        const nameEl = dom.create('span');
        nameEl.className = 'scriptlet-rule-label';
        const argsText = Array.isArray(rule.args) && rule.args.length > 0
            ? `(${rule.args.join(', ')})`
            : '';
        const technical = `${rule.name}${argsText}`;
        // Layman's-term label, same phrasing the Monitor (Privacy
        // Inspector) already uses for this exact signal — see
        // js/data/scriptlet-rule-labels.js's header for why this exists:
        // without it, a rule the user created by clicking "Select"/"Block
        // All" on e.g. "Clipboard access" in the Monitor showed up here as
        // the unrecognizable raw scriptlet call instead. Falls back to the
        // technical form unchanged for rule shapes with no Monitor
        // equivalent (sandbox-hand-authored scriptlet rules).
        const friendly = describeScriptletRule(rule);
        nameEl.textContent = friendly ?? technical;
        nameEl.title = friendly
            ? `${technical} — ${rule.hostname}##+js(${[rule.name, ...(rule.args || [])].join(', ')})`
            : `${rule.hostname}##+js(${[rule.name, ...(rule.args || [])].join(', ')})`;

        // Breakage-risk badge — 🔴/🟡/🟢 for rule shapes this module has
        // evidence-based risk data for (see that module's header), ⚪ for
        // anything else (e.g. sandbox-hand-authored rules) — always shown,
        // never omitted, so "no data" reads as deliberate rather than a
        // missing/broken badge.
        const risk = getScriptletRuleRisk(rule);
        const badge = risk ? RISK_BADGE[risk.level] : RISK_BADGE[RISK_UNKNOWN];
        const riskEl = dom.create('span');
        riskEl.className = 'scriptlet-risk-badge';
        riskEl.textContent = badge.glyph;
        riskEl.title = risk ? risk.reason : UNKNOWN_RISK_REASON;
        riskEl.setAttribute('role', 'img');
        riskEl.setAttribute('aria-label', badge.srLabel + ': ' + (risk ? risk.reason : UNKNOWN_RISK_REASON));

        // Technical API name — the exact value Privacy Inspector's own
        // live Monitor table shows for this same signal (e.g. 'readText',
        // 'getContext'), requested alongside the friendly label above so
        // a rule can still be cross-referenced against a Monitor entry
        // directly, not just by its plain-language description. null for
        // rule shapes with no Monitor equivalent (sandbox-hand-authored
        // rules) — but the element itself is ALWAYS created and appended
        // (with a neutral '—' placeholder when there's no api value),
        // never conditionally omitted: this is a middle column, sitting
        // between the risk badge and the friendly-label column, so
        // skipping it for some rows would shift the friendly label's
        // start position on exactly those rows — the same "optional
        // middle column" misalignment bug already fixed elsewhere in this
        // file, just in this list instead. Same "always shown, never omitted, so
        // 'no data' reads as deliberate" reasoning as the risk badge above.
        const api = getScriptletRuleApi(rule);
        const apiEl = dom.create('span');
        apiEl.className = 'scriptlet-api-label';
        apiEl.textContent = api ?? '—';
        apiEl.title = api ? `API: ${api}` : 'No Monitor-equivalent API value for this rule';

        const dateEl = createRuleDateCell(rule.createdAt);

        const btn = createRuleDeleteButton({ uid: rule.uid });

        row.appendChild(hostEl);
        row.appendChild(riskEl);
        row.appendChild(apiEl);
        row.appendChild(nameEl);
        row.appendChild(dateEl);
        row.appendChild(btn);
        list.appendChild(row);
    }
}

let scriptletRulesRaw = []; // last-fetched rules, re-filtered locally on every filter keystroke — see the #customRulesDomainFilter 'input' listener below

async function loadScriptletRules() {
    const rules = await sendMessage({ what: MSG_GET_PRIVACY_SCRIPTLET_RULES });
    scriptletRulesRaw = Array.isArray(rules) ? rules : [];
    renderScriptletRules(scriptletRulesRaw);
}

/******************************************************************************/
// Toolbar — combined actions across ALL THREE sections at once (Delete
// all / Export / Import), separate from each section's own per-section
// Clear all button, which stays scoped to just that one section.
/******************************************************************************/

const elToolbarStatus = qs$('#customRulesToolbarStatus');

function showToolbarStatus(message, isError = false) {
    elToolbarStatus.textContent = message;
    elToolbarStatus.classList.toggle('error', isError);
    elToolbarStatus.hidden = false;
}

function reloadAllRuleSections() {
    loadCosmeticRules();
    loadCookieClickerRules();
    loadMatrixRules();
    loadScriptletRules();
}

const elDeleteAllBtn = qs$('#deleteAllCustomRules');

// Keeps the button's own label honest about what it will actually do —
// "smart delete" scoped to the current filter is easy to misread as
// "delete all" if the label never changes to say otherwise.
function updateDeleteAllButtonLabel() {
    elDeleteAllBtn.textContent = domainFilter === ''
        ? 'Delete all rules'
        : `Delete rules matching "${domainFilter}"`;
}

async function exportCustomRules() {
    const result = await sendMessage({ what: MSG_EXPORT_CUSTOM_RULES });
    if ( !result?.ok ) {
        showToolbarStatus('Export failed — see the background service worker console for details.', true);
        return;
    }
    const json = JSON.stringify(result, null, 2);
    const blob = new Blob([ json ], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const a = dom.create('a');
    a.href = url;
    a.download = `uBlock-Dynamic-custom-rules-${date}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Released after the click has had time to actually start the
    // download — revoking immediately can race the browser's own
    // download-start on some platforms.
    self.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_REVOKE_DELAY_MS);
    showToolbarStatus('Exported all custom rules.');
}

async function importCustomRulesFromFile(file) {
    // (11.0.2, C49) Size checked before the file is read or parsed.
    const sizeCheck = checkImportFileSize(file);
    if ( sizeCheck.ok === false ) {
        showToolbarStatus(`Import failed — ${sizeCheck.error}.`, true);
        return;
    }
    let payload;
    try {
        const text = await file.text();
        payload = JSON.parse(text);
    } catch (reason) {
        showToolbarStatus(`Import failed — not valid JSON (${reason.message}).`, true);
        return;
    }
    const result = await sendMessage({ what: MSG_IMPORT_CUSTOM_RULES, payload });
    if ( !result?.ok ) {
        showToolbarStatus(`Import failed — ${result?.error ?? 'unknown error'}.`, true);
        return;
    }
    const { counts, errors } = result;
    const parts = [];
    if ( counts.matrixOverrides > 0 ) { parts.push(`${counts.matrixOverrides} ${DNR_TRACKING_FILTER_NAME} rule${counts.matrixOverrides === 1 ? '' : 's'}`); }
    if ( counts.cosmeticHostnames > 0 ) { parts.push(`${counts.cosmeticHostnames} cosmetic hostname${counts.cosmeticHostnames === 1 ? '' : 's'}`); }
    if ( counts.cookieClickerRules > 0 ) { parts.push(`${counts.cookieClickerRules} cookie consent-clicker rule${counts.cookieClickerRules === 1 ? '' : 's'}`); }
    if ( counts.scriptletRules > 0 ) { parts.push(`${counts.scriptletRules} Privacy rule${counts.scriptletRules === 1 ? '' : 's'}`); }
    const summary = parts.length > 0 ? `Imported: ${parts.join(', ')}.` : 'Nothing new to import.';
    const errorNote = errors.length > 0 ? ` (${errors.length} rule${errors.length === 1 ? '' : 's'} skipped — invalid.)` : '';
    showToolbarStatus(summary + errorNote, errors.length > 0 && parts.length === 0);
    reloadAllRuleSections();
}

/******************************************************************************/
// Event handlers
/******************************************************************************/

// Domain filter — re-renders all three sections from their already-cached
// raw data (cosmeticRulesRaw/matrixRulesRaw/scriptletRulesRaw), so typing
// never needs a round-trip to the background for this.
dom.on('#customRulesDomainFilter', 'input', ev => {
    domainFilter = ev.target.value.trim().toLowerCase();
    renderCosmeticRules(cosmeticRulesRaw);
    renderCookieClickerRules(cookieClickerRulesRaw);
    renderMatrixRules(matrixRulesRaw);
    renderScriptletRules(scriptletRulesRaw);
    updateDeleteAllButtonLabel();
});

dom.on('#deleteAllCustomRules', 'click', async ev => {
    if ( ev.isTrusted !== true ) { return; }
    // Confirm dialog text reflects the ACTUAL scope about to be deleted —
    // "everything" when no filter is active, or exactly which filter
    // otherwise, so this can't be misread as always meaning "everything"
    // regardless of what's currently searched.
    const scopeText = domainFilter === ''
        ? `ALL custom rules — Cosmetic, Cookie consent-clicker, ${DNR_TRACKING_FILTER_NAME}, and Anti-fingerprinting scriptlets`
        : `all custom rules matching "${domainFilter}" — Cosmetic, Cookie consent-clicker, ${DNR_TRACKING_FILTER_NAME}, and Anti-fingerprinting scriptlets`;
    if ( !confirm(`Delete ${scopeText}? This cannot be undone.`) ) { return; }
    const result = await sendMessage({ what: MSG_DELETE_FILTERED_CUSTOM_RULES, filter: domainFilter });
    if ( !result?.ok ) {
        showToolbarStatus('Delete failed — see the background service worker console for details.', true);
        return;
    }
    const { counts } = result;
    const parts = [];
    if ( counts.matrixOverrides > 0 ) { parts.push(`${counts.matrixOverrides} ${DNR_TRACKING_FILTER_NAME} rule${counts.matrixOverrides === 1 ? '' : 's'}`); }
    if ( counts.cosmeticHostnames > 0 ) { parts.push(`${counts.cosmeticHostnames} cosmetic hostname${counts.cosmeticHostnames === 1 ? '' : 's'}`); }
    if ( counts.cookieClickerRules > 0 ) { parts.push(`${counts.cookieClickerRules} cookie consent-clicker rule${counts.cookieClickerRules === 1 ? '' : 's'}`); }
    if ( counts.scriptletRules > 0 ) { parts.push(`${counts.scriptletRules} Privacy rule${counts.scriptletRules === 1 ? '' : 's'}`); }
    showToolbarStatus(parts.length > 0 ? `Deleted: ${parts.join(', ')}.` : 'Nothing matched — nothing deleted.');
    reloadAllRuleSections();
});

dom.on('#exportCustomRules', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    exportCustomRules();
});

dom.on('#importCustomRules', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    qs$('#importCustomRulesFile').click();
});

dom.on('#importCustomRulesFile', 'change', async ev => {
    const file = ev.target.files?.[0];
    ev.target.value = ''; // reset so selecting the SAME file again still fires 'change'
    if ( !file ) { return; }
    await importCustomRulesFromFile(file);
});

dom.on('#cosmeticRulesList', 'click', '.rule-delete-btn', async ev => {
    const { hostname, selector } = ev.target.dataset;
    if ( !hostname || !selector ) { return; }
    await sendMessage({ what: MSG_DELETE_COSMETIC_RULE, hostname, selector });
    loadCosmeticRules();
});

dom.on('#cookieClickerRulesList', 'click', '.rule-delete-btn', async ev => {
    const { uid } = ev.target.dataset;
    if ( !uid ) { return; }
    await sendMessage({ what: MSG_DELETE_COOKIE_CLICKER_RULE, uid });
    loadCookieClickerRules();
});

dom.on('#matrixRulesList', 'click', '.rule-delete-btn', async ev => {
    const { uid } = ev.target.dataset;
    if ( !uid ) { return; }
    await sendMessage({ what: MSG_DELETE_MATRIX_BLOCK_RULE, uid });
    loadMatrixRules();
});

dom.on('#scriptletRulesList', 'click', '.rule-delete-btn', async ev => {
    const { uid } = ev.target.dataset;
    if ( !uid ) { return; }
    await sendMessage({ what: MSG_DELETE_PRIVACY_SCRIPTLET_RULE, uid });
    loadScriptletRules();
});

/******************************************************************************/
// Load when the pane becomes active
/******************************************************************************/

function onPaneChange() {
    if ( !isPaneActive() ) { return; }
    loadCosmeticRules();
    loadCookieClickerRules();
    loadMatrixRules();
    loadScriptletRules();
}

new MutationObserver(onPaneChange).observe(document.body, {
    attributes: true,
    attributeFilter: [ 'data-pane' ],
});

// Auto-refresh when rules change while the pane is open — e.g. when the
// picker adds a cosmetic rule, the cookie consent-clicker picker saves a
// new rule, the Matrix panel's Block action saves a new override, or
// Privacy Inspector's Select button creates a scriptlet rule.
browser.storage.onChanged.addListener((changes, area) => {
    if ( area !== 'local' ) { return; }
    if ( !isPaneActive() ) { return; }
    const keys = Object.keys(changes);
    if ( keys.some(k => k.startsWith('site.') || k === 'matrixOverrides') ) {
        loadCosmeticRules();
        loadMatrixRules();
    }
    if ( keys.includes('cookieClicker.rules') ) {
        loadCookieClickerRules();
    }
    if ( keys.includes('customScriptletRules') ) {
        loadScriptletRules();
    }
});

onPaneChange();
updateDeleteAllButtonLabel();
