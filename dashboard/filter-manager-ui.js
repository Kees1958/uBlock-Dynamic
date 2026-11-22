// ── filter-manager-ui.js ────────────────────────────────────────────────────────
// Dashboard "Filter (block) lists" and "Import ABP rules" tabs: the ABP-import editor (save, file import/export,
// "saved but not applied" notice) and the filter-list / language-filter toggles.
// ─────────────────────────────────────────────────────────────────────────────
import { sendMessage } from '../js/data/ext.js';
import { formatSandboxApplyNotice } from '../js/data/editor-annotations.js';
import { dom, qs$ } from '../js/ui/dom.js';
import { loadRulesetDetailsMap } from '../js/data/ruleset-details-loader.js';
import { WORRY_FREE_NAME } from '../js/data/ui-names.js';
import { checkImportFileSize } from '../js/util/input-limits.js';

/******************************************************************************/

async function startsSandboxEditor() {
    if ( startsSandboxEditor.editor ) { return; }

    const { FilterEditor } = await import('../js/ui/filter-editor.js');

    const SandboxFilterEditor = class extends FilterEditor {
        async saveContent() {
            if ( this.contentChanged() === false ) { return; }
            const result = await sendMessage({ what: 'setSandboxFilters', text:  this.getContent() });
            // (10.7.6) Show what was STORED: refused lines come back commented out with "! Rejected: <reason>"
            // beneath (red). Until now the editor kept the typed text, so the reason only appeared after the
            // dashboard was reopened — a refused line looked accepted.
            const stored = await sendMessage({ what: 'getSandboxFilters' });
            if ( typeof stored === 'string' && stored !== this.getContent() ) { this.setContent(stored); }
            reportSandboxApplyResult(result, stored);
            await super.saveContent();
        }
        async loadContent() {
            const text = await sendMessage({ what: 'getSandboxFilters' });
            await super.loadContent(text);
        }
        updateView(...args) {
            super.updateView(...args);
            const count = this.getContent().split('\n').reduce((n, line) => {
                const t = line.trim();
                if ( t === '' ) { return n; }
                if ( t.charAt(0) === '!' || t.charAt(0) === '#' ) { return n; }
                return n + 1;
            }, 0);
            dom.text('#sandboxRuleCount', count !== 0 ? `${count}` : '');
        }
    }

    startsSandboxEditor.editor = new SandboxFilterEditor(qs$('#sandboxEditor .cm-container'));
    await startsSandboxEditor.editor.loadContent();
}

export async function initSandboxEditor() {
    return startsSandboxEditor();
}

startsSandboxEditor();

/******************************************************************************/
// Import ABP rules tab — Export/Import for the sandbox editor's own raw
// text. Same Blob/download + hidden-file-input pattern as custom-rules.js's
// exportCustomRules()/importCustomRulesFromFile() (C21) — .txt, not JSON,
// since this is plain filter-list text, not a structured payload.
//
// Import APPENDS rather than replaces — never destroys existing content
// on import, only adds to it (with a separator comment marking where the
// imported text starts) — explicit design choice given the destructive-
// replace shape is the more failure-prone one for a raw-text editor like
// this. Goes through the editor's own public API only (setContent()/
// loadContent() — see js/ui/filter-editor.js) — never a raw DOM write to
// the CodeMirror container, which would desync the editor's own internal
// view state from what's actually rendered.
/******************************************************************************/

const elSandboxIoStatus = qs$('#sandboxIoStatus');

function showSandboxIoStatus(message, isError = false) {
    elSandboxIoStatus.textContent = message;
    elSandboxIoStatus.classList.toggle('error', isError);
    elSandboxIoStatus.hidden = false;
}

// (10.7.6) countRejectedLines() / formatSandboxApplyNotice() / formatRulesNotAppliedMessage() live in
// js/data/editor-annotations.js (pure, shared with settings-io.js and testable in Node).

// Shows the failure next to the editor; a later successful save clears an earlier failure notice
// (an ordinary info notice, e.g. "Exported ABP rules.", is left alone).
function reportSandboxApplyResult(result, storedText) {
    const notice = formatSandboxApplyNotice(result, storedText);
    if ( notice !== null ) {
        showSandboxIoStatus(notice.text, notice.isError);
        return;
    }
    if ( elSandboxIoStatus.classList.contains('error') ) {
        elSandboxIoStatus.hidden = true;
        elSandboxIoStatus.classList.remove('error');
    }
}

async function exportSandboxFilters() {
    const text = await sendMessage({ what: 'getSandboxFilters' });
    const blob = new Blob([ text ?? '' ], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    const a = dom.create('a');
    a.href = url;
    a.download = `uBlock-Dynamic-abp-import-${date}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    self.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_REVOKE_DELAY_MS);
    showSandboxIoStatus('Exported ABP rules.');
}

async function importSandboxFiltersFromFile(file) {
    // (11.0.2, C49) Size checked before the file is read.
    const sizeCheck = checkImportFileSize(file);
    if ( sizeCheck.ok === false ) {
        showSandboxIoStatus(`Import failed — ${sizeCheck.error}.`, true);
        return;
    }
    let importedText;
    try {
        importedText = await file.text();
    } catch (reason) {
        showSandboxIoStatus(`Import failed — could not read the file (${reason.message}).`, true);
        return;
    }
    importedText = (importedText ?? '').trim();
    if ( importedText === '' ) {
        showSandboxIoStatus('Nothing to import — the file was empty.', true);
        return;
    }
    const existingText = (await sendMessage({ what: 'getSandboxFilters' }) ?? '').trim();
    const mergedText = existingText === ''
        ? importedText
        : `${existingText}\n\n! ── Imported ${new Date().toISOString().slice(0, 10)} ──\n${importedText}`;
    const result = await sendMessage({ what: 'setSandboxFilters', text: mergedText });
    // Refresh the editor's own displayed content from the now-confirmed
    // backend state — treats the editor as a view of that state, same
    // as its own initial loadContent() call above.
    await startsSandboxEditor.editor?.loadContent();
    const notice = formatSandboxApplyNotice(result, await sendMessage({ what: 'getSandboxFilters' }));
    if ( notice?.isError ) {
        showSandboxIoStatus(notice.text, true);
        return;
    }
    showSandboxIoStatus(`Imported ABP rules (appended to existing rules).${notice ? ` ${notice.text}` : ''}`);
}

dom.on('#exportSandboxFilters', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    exportSandboxFilters();
});

dom.on('#importSandboxFilters', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    qs$('#importSandboxFiltersFile').click();
});

dom.on('#importSandboxFiltersFile', 'change', async ev => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if ( !file ) { return; }
    await importSandboxFiltersFromFile(file);
});

/******************************************************************************/
// Static ruleset toggles + language filter dropdown
/******************************************************************************/

import {
    MSG_GET_ENABLED_RULESETS,
    MSG_SET_RULESET_ENABLED,
    MSG_GET_LANGUAGE_FILTER_COUNTRIES,
    MSG_SET_LANGUAGE_FILTER_COUNTRIES,
} from '../js/data/message-types.js';
import { DOWNLOAD_URL_REVOKE_DELAY_MS } from '../js/data/timing-constants.js';

// (10.7.6, audit 10.7.5 D-9) Every filter-list switch goes through here: Chrome can refuse to switch a list on (too
// many lists on, or the static rule budget used up). The refusal is shown above the lists and the caller sets its
// switch back — before, it was only logged and the switch showed "on" for a list that was not active.
// Returns true when the list is now in the requested state.
const elFilterListsStatus = qs$('#filterListsStatus');
async function requestRulesetEnabled(id, enabled) {
    const result = await sendMessage({ what: MSG_SET_RULESET_ENABLED, id, enabled });
    if ( result?.ok === false ) {
        const name = (await loadRulesetDetails()).get(id)?.name ?? id;
        elFilterListsStatus.textContent = `"${name}" could not be switched ${enabled ? 'on' : 'off'}: ${result.error}`;
        elFilterListsStatus.classList.add('error');
        elFilterListsStatus.hidden = false;
        return false;
    }
    elFilterListsStatus.hidden = true;   // a later success clears an earlier refusal
    return true;
}

// The individually-selectable "default" filter lists, in panel row order (10.1.1: ids only). The
// DISPLAY NAME of each row now comes from the central names in ruleset-details.json (generated from
// tools/build/filter-lists.mjs), the same source the language filters and the DNR monitor use, so a
// rename is made once, in the build config. The id list itself stays hand-maintained on purpose: these
// are a curated subset of always-visible rows (no add/remove dropdown) that also feed the aggregate
// summary line (updateDefaultFiltersSummary()), and most other 'default'-category rulesets (e.g.
// ruleset_peterlowe) have no row here. Folding that into a generated list would need an explicit
// "show in this panel" flag per entry, which is a real option but not one this change made unasked.
const DEFAULT_FILTER_IDS = Object.freeze([
    // Row order in the panel = order here. (11.0.0) ruleset_hagezi_light moved to the Seamless surfing tracker rows
    // (worryFreeHageziToggle), owner's decision.
    'ruleset_adguard_base',
    // (10.0.7) always-on Built-in default, moved out of the Worry-free rows.
    'ruleset_annoyances',
    'ruleset_adguard_antiadblock',
    'ruleset_antiadmiral',
    'ruleset_badfilter_quickfixes',
]);

// Language-filter labels (10.0.5): no longer a hand-maintained map here —
// every id's display name, and the full set of ids to show at all, now
// comes from ruleset-details.json's `category: 'language-filter'`
// entries (see tools/build/build-steps.mjs). A new country/language
// filter added to tools/build/filter-lists.mjs appears here automatically
// on the next build — no edit to this file or dashboard.html required.

/******************************************************************************/

// ── Combined language filters (10.4.5, owner's decision) ───────────────────
// A combined filter (Balkan, Baltic states — ruleset-details.json `countries`) is ONE stored ruleset shown as
// separate countries. The dropdown lists every country; adding one turns the shared ruleset on and shows that
// country's row; the ruleset stays on until the last of its countries is removed (×). A row's switch is the
// shared ruleset's switch, so every row of the same filter always shows the same state.
// Which countries were added lives in the service worker (js/core/language-filter-countries.js).
const COUNTRY_OPTION_SEPARATOR = '|';   // dropdown value of a country: "<ruleset id>|<country id>"

function languageOptionValue(id, countryId) {
    return countryId ? `${id}${COUNTRY_OPTION_SEPARATOR}${countryId}` : id;
}

// (10.4.5, owner's decision) Rows are named by LANGUAGE ("German language"), without source names; a country row
// that covers several languages (Bosnia and Herzegovina, Kosovo — `showCountry`) by the country's name.
const LANGUAGE_LABEL_SUFFIX = ' language';
function languageRowLabel(entry, country) {
    if ( country ) { return country.showCountry === true || !country.language ? country.name : `${country.language}${LANGUAGE_LABEL_SUFFIX}`; }
    return entry?.language ? `${entry.language}${LANGUAGE_LABEL_SUFFIX}` : (entry?.name ?? '');
}

// Every switch of the same ruleset shows the same (shared) state.
function syncLanguageRowSwitches(id, enabled) {
    for ( const cb of document.querySelectorAll(`#languageFilterRows .ruleset-toggle[data-ruleset="${id}"]`) ) {
        cb.checked = enabled;
    }
}

// The country ids currently shown for one ruleset (the DOM is the dashboard's view of the stored list).
function shownCountryIds(id) {
    return [ ...document.querySelectorAll(`#languageFilterRows .language-filter-row[data-ruleset="${id}"]`) ]
        .map(row => row.dataset.country).filter(Boolean);
}

// Render one language filter row with a toggle and a remove (×) button. `country` is set for a country row of
// a combined filter, undefined for an ordinary language filter (and for a combined filter that is on without
// any stored country row — shown as one row under its own name so its state is never hidden).
function renderLanguageFilterRow(id, entry, enabled, country) {
    const container = qs$('#languageFilterRows');
    if ( !container ) { return; }

    const row = document.createElement('div');
    row.className = 'static-filter-row language-filter-row';
    row.dataset.ruleset = id;
    if ( country ) { row.dataset.country = country.id; }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'static-filter-name';
    nameSpan.textContent = languageRowLabel(entry, country) || id;
    if ( country ) {
        nameSpan.title = `Part of the ${entry?.name ?? id}: one filter for ${(entry?.countries ?? []).map(c => c.name).join(', ')}.`;
    }

    // Toggle — the (shared) ruleset's own switch.
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'static-filter-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'ruleset-toggle';
    cb.dataset.ruleset = id;
    cb.checked = enabled;
    cb.addEventListener('change', async () => {
        cb.disabled = true;
        if ( await requestRulesetEnabled(id, cb.checked) === false ) { cb.checked = !cb.checked; }
        cb.disabled = false;
        syncLanguageRowSwitches(id, cb.checked);
        updateLanguageFiltersSummary();
    });
    const track = document.createElement('span');
    track.className = 'toggle-track';
    const thumb = document.createElement('span');
    thumb.className = 'toggle-thumb';
    track.appendChild(thumb);
    toggleLabel.append(cb, track);

    // Remove button — removes the row; the ruleset is turned off when no row of it is left.
    const removeBtn = document.createElement('button');
    removeBtn.className = 'language-filter-remove';
    removeBtn.title = country ? `Remove ${country.name}` : 'Remove this language filter';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', async () => {
        row.remove();
        const opt = qs$(`#languageFilterSelect option[value="${languageOptionValue(id, country?.id)}"]`);
        if ( opt ) { opt.disabled = false; }
        if ( Array.isArray(entry?.countries) ) {
            const left = shownCountryIds(id);
            await sendMessage({ what: MSG_SET_LANGUAGE_FILTER_COUNTRIES, rulesetId: id, countryIds: left });
            if ( left.length === 0 ) {
                // Last country gone: the shared filter goes off, and a leftover group row (if any) goes too.
                for ( const other of document.querySelectorAll(`#languageFilterRows .language-filter-row[data-ruleset="${id}"]`) ) { other.remove(); }
                await requestRulesetEnabled(id, false);
            }
        } else {
            await requestRulesetEnabled(id, false);
        }
        updateLanguageFiltersSummary();
    });

    row.append(nameSpan, toggleLabel, removeBtn);
    container.appendChild(row);

    // Mark dropdown option as already added
    const opt = qs$(`#languageFilterSelect option[value="${languageOptionValue(id, country?.id)}"]`);
    if ( opt ) { opt.disabled = true; }
}

// Sums rawLineCount/ruleCount across only the language filter rows
// currently in the DOM AND toggled on — same shape as
// updateDefaultFiltersSummary()/updateWorryFreeFiltersSummary(), same
// rawLineCount-not-domainCount reasoning (see updateDefaultFiltersSummary()'s
// own inline comment). A language filter can be added-then-toggled-off
// without being removed (the switch vs. the × button are two different
// actions), so this checks .checked, not just row presence.
async function updateLanguageFiltersSummary() {
    const el = qs$('#languageFiltersSummary');
    if ( !el ) { return; }
    const details = await loadRulesetDetails();
    let rawLines = 0;
    let rules = 0;
    const counted = new Set();   // (10.4.5) several country rows can share one ruleset: count it once
    for ( const cb of document.querySelectorAll('#languageFilterRows .ruleset-toggle') ) {
        if ( cb.checked !== true || counted.has(cb.dataset.ruleset) ) { continue; }
        counted.add(cb.dataset.ruleset);
        const entry = details.get(cb.dataset.ruleset);
        if ( !entry ) { continue; }
        rawLines += entry.rawLineCount ?? 0;
        rules    += entry.ruleCount ?? 0;
    }
    if ( rawLines === 0 && rules === 0 ) {
        el.textContent = '';
        return;
    }
    el.textContent = `Total of ${rawLines.toLocaleString()} raw filter lines blocked with ` +
        `DNR ${rules.toLocaleString()} rules `;
    const marker = document.createElement('span');
    marker.className = 'static-filter-footnote-marker';
    marker.textContent = '(hover over for info)';
    marker.title = 'Only counts the language filters enabled above, in addition to the built-in filter lists\' own totals.';
    el.appendChild(marker);
}

/******************************************************************************/
// Default filter rows + aggregate "N domains blocked with N rules" summary
/******************************************************************************/

// ruleset-details.json is a build-time-generated, bundled extension file
// (tools/build-rulesets.mjs writes it fresh every build — domainCount/
// paramCount/ruleCount are real numbers from what was actually shipped,
// not estimated). Fetch-and-cache moved to js/data/ruleset-details-
// loader.js (10.0.5) — the Matrix panel needs the same data (ruleset id
// -> human name, for its "more info" rule-summary line) and previously
// had no path to it at all; this is the single shared implementation
// both pages now import, rather than a second hand-copied fetch (C21).
// The BUG FIX this used to document in place (v9.2.0 — cache the
// in-flight PROMISE, not a not-yet-populated Map, so two concurrent
// callers can't race) carried over unchanged into the shared module.
const loadRulesetDetails = loadRulesetDetailsMap;

// Render one default-filter row — plain checkbox + label, same markup
// shape as the Worry-free section's static rows (not the toggle-switch
// styling — that's kept only for language filters, which are dynamically
// added/removed from a dropdown and pair naturally with a switch + remove
// button; these 7 are permanent, always-visible rows, so a plain
// checkbox matches the rest of this panel instead).
function renderDefaultFilterRow(id, enabled, name) {
    const container = qs$('#defaultFilterRows');
    if ( !container ) { return; }

    const row = document.createElement('div');
    row.className = 'static-filter-row';
    row.dataset.ruleset = id;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = `defaultFilter_${id}`;
    cb.className = 'ruleset-toggle';
    cb.dataset.ruleset = id;
    cb.checked = enabled;
    // Wiring (message send + summary refresh) happens once, uniformly,
    // in initRulesetToggles()'s own `.ruleset-toggle` loop below — not
    // here, to avoid double-attaching a change listener to the same
    // checkbox (this row is appended to the DOM before that loop runs,
    // so it's already included in it).

    const nameLabel = document.createElement('label');
    nameLabel.className = 'static-filter-name';
    nameLabel.htmlFor = cb.id;
    nameLabel.textContent = name ?? id;   // central name (ruleset-details.json); raw id only if it is missing

    row.append(cb, nameLabel);
    container.appendChild(row);
}

// Sums rawLineCount/ruleCount across only the CURRENTLY-ENABLED default
// filters (not all 7 unconditionally) — "blocked" should reflect what's
// actually active right now, and this is meant to double as a live
// debugging aid: toggle a list off, watch the totals drop, confirm which
// source a given number of lines/rules came from. Deliberately
// rawLineCount, NOT domainCount — see this function's own inline comment
// below for why domainCount was misleading for a list like AdGuard Base.
async function updateDefaultFiltersSummary() {
    const el = qs$('#defaultFiltersSummary');
    if ( !el ) { return; }
    const details = await loadRulesetDetails();
    let rawLines = 0;
    let rules = 0;
    for ( const id of DEFAULT_FILTER_IDS ) {
        const cb = document.querySelector(`#defaultFilterRows .ruleset-toggle[data-ruleset="${id}"]`);
        if ( !cb || cb.checked !== true ) { continue; }
        const entry = details.get(id);
        if ( !entry ) { continue; }
        rawLines += entry.rawLineCount ?? 0;
        rules    += entry.ruleCount ?? 0;
    }
    // "Raw filter lines" vs "DNR rules" — deliberately NOT domainCount,
    // per explicit request: domainCount only counts the coalesced-
    // domain-shaped subset of rules (ruleset_adguard_base has 8,949 DNR
    // rules but only 1,314 domainCount, since most of its rules are
    // per-URL-path patterns, not plain domain blocks — domainCount was
    // silently understating it). rawLineCount is honest for ANY list
    // shape: every non-comment, non-header line actually fetched from
    // upstream, computed once at build time (tools/build-rulesets.mjs),
    // never re-derived here.
    el.textContent = `Total of ${rawLines.toLocaleString()} raw filter lines blocked with ` +
        `DNR ${rules.toLocaleString()} rules `;
    // Native title-attribute tooltip — same mechanism matrix/matrix-
    // panel.js already uses for its own hover explanations (td.title =
    // ...), not a custom dropdown component (C21: reused, not a second,
    // different-looking mechanism for the same job).
    const marker = document.createElement('span');
    marker.className = 'static-filter-footnote-marker';
    marker.textContent = '(hover over for info)';
    marker.title = 'For performance reasons, generic (cosmetic) rules are dropped. Rules are kept only for websites in Europe (except Moldova, Belarus, Ukraine and Russia), the Americas, Australia and New Zealand. '
        + 'This extension uses AdGuard\'s way of organizing filter lists and uBO-lite\'s way of applying them — almost all of AdGuard\'s functionality, with uBO-lite\'s speed and memory usage.';
    el.appendChild(marker);
}

/******************************************************************************/

async function initRulesetToggles() {
    const enabled = await sendMessage({ what: MSG_GET_ENABLED_RULESETS });
    const enabledSet = new Set(Array.isArray(enabled) ? enabled : []);

    // Default filter rows — always visible, individually toggleable.
    const defaultDetails = await loadRulesetDetails();
    for ( const id of DEFAULT_FILTER_IDS ) {
        renderDefaultFilterRow(id, enabledSet.has(id), defaultDetails.get(id)?.name);
    }
    updateDefaultFiltersSummary();

    // Core static filter checkboxes (always-visible rows in HTML)
    for ( const cb of document.querySelectorAll('.ruleset-toggle') ) {
        cb.checked  = enabledSet.has(cb.dataset.ruleset);
        cb.disabled = false;

        cb.addEventListener('change', async () => {
            cb.disabled = true;
            if ( await requestRulesetEnabled(cb.dataset.ruleset, cb.checked) === false ) { cb.checked = !cb.checked; }
            cb.disabled = false;
            // No-op for any checkbox outside #defaultFilterRows (guarded
            // inside updateDefaultFiltersSummary() itself via the
            // DEFAULT_FILTER_IDS lookup) — cheap enough to just
            // always call rather than branch on which row this is.
            updateDefaultFiltersSummary();
        });
    }

    // Language filters — the full catalog now comes from ruleset-
    // details.json's category: 'language-filter' entries (10.0.5), not a
    // hardcoded id/name map here. A new country filter added at build
    // time (tools/build/filter-lists.mjs) shows up here with no edit to
    // this file or dashboard.html.
    const details = await loadRulesetDetails();
    const languageEntries = [ ...details.values() ].filter(e => e.category === 'language-filter');

    // Dropdown — one flat, alphabetical list of language names (10.0.6,
    // per explicit request: "only show language filters"). Previously
    // grouped into AdGuard/EasyList optgroups by id prefix, but that
    // distinction stopped being meaningful once a filter's content can
    // combine more than one source (see ruleset_easylist_bulgarian's own
    // comment — its id keeps the 'easylist' prefix for storage-key
    // stability even though it's no longer EasyList-only content, which
    // is exactly why grouping by id prefix would now be actively
    // misleading, not just redundant).
    // (10.4.5) A combined filter contributes one option PER COUNTRY (its countries are what people look for),
    // never one for the filter itself.
    const select = qs$('#languageFilterSelect');
    if ( select ) {
        const options = languageEntries.flatMap(entry => Array.isArray(entry.countries)
            ? entry.countries.map(c => ({ value: languageOptionValue(entry.id, c.id), label: languageRowLabel(entry, c) }))
            : [ { value: entry.id, label: languageRowLabel(entry) } ]);
        options.sort((a, b) => a.label.localeCompare(b.label));
        for ( const o of options ) {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            select.appendChild(opt);
        }

        select.addEventListener('change', async () => {
            const [ id, countryId ] = select.value.split(COUNTRY_OPTION_SEPARATOR);
            if ( !id ) { return; }
            select.value = '';
            const entry = details.get(id);
            const country = (entry?.countries ?? []).find(c => c.id === countryId);
            // (10.7.6) Switch the list on FIRST: when Chrome refuses, nothing else changes (no row, no stored country).
            if ( await requestRulesetEnabled(id, true) === false ) { return; }
            if ( country ) {
                // A leftover group row (on without stored countries) is replaced by the country rows.
                qs$(`#languageFilterRows .language-filter-row[data-ruleset="${id}"]:not([data-country])`)?.remove();
                await sendMessage({ what: MSG_SET_LANGUAGE_FILTER_COUNTRIES, rulesetId: id, countryIds: [ ...shownCountryIds(id), country.id ] });
            }
            renderLanguageFilterRow(id, entry, true, country);
            syncLanguageRowSwitches(id, true);
            updateLanguageFiltersSummary();
        });
    }

    // Render rows for any language filters already enabled (e.g. after reload). A combined filter shows its
    // stored country rows; with none stored it shows one row under its own name.
    const storedCountries = await sendMessage({ what: MSG_GET_LANGUAGE_FILTER_COUNTRIES }) ?? {};
    for ( const entry of languageEntries ) {
        if ( enabledSet.has(entry.id) === false ) { continue; }
        const countries = Array.isArray(entry.countries)
            ? entry.countries.filter(c => (storedCountries[entry.id] ?? []).includes(c.id))
            : [];
        if ( countries.length === 0 ) {
            renderLanguageFilterRow(entry.id, entry, true);
            continue;
        }
        for ( const country of countries ) { renderLanguageFilterRow(entry.id, entry, true, country); }
    }
    updateLanguageFiltersSummary();
}

initRulesetToggles();

// "Block login-with" — feature removed entirely in v8.5.7, per explicit
// request (see CHANGELOG). Previously (v8.3.16) only its manual checkbox
// had been removed while the underlying toggle stayed driven
// automatically by Worry-free mode; now the whole mechanism is gone —
// see js/core/ruleset-manager.js and js/core/dnr-budgets.js's
// LOGIN_WITH_RULES_RETIRED_BASE_ID for the migration cleanup this left
// behind for existing installs.

/******************************************************************************/
// Worry-free section checkboxes (v8.5.8: generalized from the single
// "Enable ... at browser startup" wiring, v8.5.5, to cover all four rows
// now that each is independently toggleable) — all plain securityConfig
// keys, all reuse the existing getSecurityConfig/setSecurityConfig
// message routes rather than new plumbing per checkbox. Each one's own
// default already lives in config.js itself — this function just
// reflects whatever that default (or the person's own saved choice) is,
// never assumes one here.
/******************************************************************************/

// (10.3.0) The two Worry-free TIER checkboxes (worryFreeSecurityTldProtectionsToggle /
// blockScpFingerprintFilterListToggle) that used to head this list were removed with the Privacy &
// Security extra protections (moved to 3P-Matrix), and with them the tier cascade redraw and their
// tooltips below.
const WORRY_FREE_TOGGLE_IDS = [
    // Four independently-toggleable blocklist items (was five —
    // worryFreeGhosteryOtherToggle removed along with ruleset_ghostery_other
    // entirely, see CHANGELOG) — each with its own genuinely domain-scoped
    // suppression rule, safe to list here as ordinary independent
    // settingKey checkboxes — see js/core/worry-free-extra-manager.js's
    // own header. Also drive the summary line (see
    // WORRY_FREE_BLOCKLIST_RULESET_IDS/updateWorryFreeFiltersSummary
    // below) since they're the only worry-free items that map to a real
    // ruleset with its own domainCount/ruleCount.
    [ 'worryFreeHageziToggle', 'worryFreeHageziEnabled' ],                                  // 11.0.0 — moved here from the default rows
    [ 'worryFreeAdguardTrackingToggle', 'worryFreeAdguardTrackingEnabled' ],
    [ 'worryFreeKees1958Toggle', 'worryFreeKees1958Enabled' ],                              // 10.0.7 — moved here from Built-in
    [ 'worryFreePeterloweToggle', 'worryFreePeterloweEnabled' ],                            // 10.1.1 — Peter Lowe's list restored
    [ 'worryFreeAdguardRemoveparamToggle', 'worryFreeAdguardRemoveparamEnabled' ],          // 10.0.7 — replaces Kees1958 tracking params
    // (Gate 3, unlockAdvancedOptionsToggle, removed in v9.6.8 with the advanced tier.)
    // (10.5.0) startWorryFreeOnBrowserStartupToggle moved to the Options tab, where
    // dashboard/security.js saves it with every other [data-setting] row — listing it here too
    // would save it twice.
];

// Checkbox element id -> the static ruleset id whose domainCount/
// ruleCount it drives — the 5 blocklist items only (Options,
// TLD-protection, anti-fingerprint, and browser-startup aren't backed by
// a ruleset with a domain/rule count, so they're excluded here, same
// reasoning updateDefaultFiltersSummary() applies to DEFAULT_FILTER_IDS).
// A checkbox may drive MORE THAN ONE ruleset (arrays below): the EasyList
// item governs three lists together — the ad-server list plus the two
// site-specific lists added this release — so its displayed counts must
// sum all three, or the panel would understate what the checkbox does.
const WORRY_FREE_BLOCKLIST_RULESET_IDS = {
    worryFreeHageziToggle:           [ 'ruleset_hagezi_light' ],   // (11.0.0) moved here from the default rows
    worryFreeAdguardTrackingToggle:  [ 'ruleset_adguard_tracking_servers' ],
    worryFreeKees1958Toggle:         [ 'ruleset_kees1958' ],
    worryFreePeterloweToggle:        [ 'ruleset_peterlowe' ],
    worryFreeAdguardRemoveparamToggle: [ 'ruleset_adguard_base_removeparam' ],
};

// Same shape as updateDefaultFiltersSummary() above, scoped to just the
// 5 worry-free blocklist items and their own numbers. rawLineCount, not
// domainCount — same reasoning as updateDefaultFiltersSummary()'s own
// inline comment (these 5 happen to be mostly plain domain lists so the
// gap is small here, but using the same metric everywhere avoids a
// silent inconsistency between panels).
async function updateWorryFreeFiltersSummary() {
    const el = qs$('#worryFreeFiltersSummary');
    if ( !el ) { return; }
    const details = await loadRulesetDetails();
    let rawLines = 0;
    let rules = 0;
    for ( const [ elementId, rulesetIds ] of Object.entries(WORRY_FREE_BLOCKLIST_RULESET_IDS) ) {
        const cb = qs$(`#${elementId}`);
        if ( !cb || cb.checked !== true ) { continue; }
        for ( const rulesetId of rulesetIds ) {
            const entry = details.get(rulesetId);
            if ( !entry ) { continue; }
            rawLines += entry.rawLineCount ?? 0;
            rules    += entry.ruleCount ?? 0;
        }
    }
    el.textContent = `Total of ${rawLines.toLocaleString()} raw filter lines blocked with ` +
        `DNR ${rules.toLocaleString()} rules `;
    const marker = document.createElement('span');
    marker.className = 'static-filter-footnote-marker';
    marker.textContent = '(hover over for info)';
    marker.title = `Only active during a ${WORRY_FREE_NAME} session, and only for the items checked above.`;
    el.appendChild(marker);
}

async function initWorryFreeToggles() {
    const config = await sendMessage({ what: 'getSecurityConfig' });
    for ( const [ elementId, settingKey ] of WORRY_FREE_TOGGLE_IDS ) {
        const cb = qs$(`#${elementId}`);
        if ( !cb ) { continue; }
        cb.checked = config?.[settingKey] === true;
        cb.addEventListener('change', async ( ) => {
            cb.disabled = true;
            try {
                await sendMessage({ what: 'setSecurityConfig', key: settingKey, value: cb.checked });
            } finally {
                cb.disabled = false;
            }
            if ( elementId in WORRY_FREE_BLOCKLIST_RULESET_IDS ) {
                updateWorryFreeFiltersSummary();
            }
        });
    }
    updateWorryFreeFiltersSummary();
}

initWorryFreeToggles();

// (10.3.0) The editable familiar-TLD ("safer region") list editor was removed with the feature.
