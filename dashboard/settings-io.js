/*******************************************************************************

    uBlock-Stripped-Dynamic — Filter (block) lists tab: Save/Restore settings

    Broader than "Manage custom rules"' own Export/Import
    (MSG_EXPORT_CUSTOM_RULES/MSG_IMPORT_CUSTOM_RULES, dashboard/custom-rules.js)
    — this covers the FULL configuration (enabled filter lists, Privacy &
    Security settings, per-feature allowlists, site modes/Allow list) PLUS
    the same custom-rules payload AND the Import ABP rules tab's own raw
    sandbox-filter text (sandboxFilters), both nested inside, so one file
    is a complete backup. Same Blob/createObjectURL export pattern and
    hidden-file-input import pattern as custom-rules.js's own
    exportCustomRules()/importCustomRulesFromFile() — reused here (C21),
    not reinvented.

    Public interface: none — this file only wires #exportAllSettings/
    #importAllSettings/#importAllSettingsFile/#resetAllSettings, same
    posture as filter-manager-ui.js's own event-wiring-only files.

    Dependencies (must be loaded before this file): js/ui/dom.js,
    js/data/ext.js, js/data/message-types.js, js/data/ui-names.js.

    State owned by this module: none — every read/write goes through the
    background service worker via sendMessage(), same as custom-rules.js.

*******************************************************************************/

import { dom, qs$ } from '../js/ui/dom.js';
import { sendMessage } from '../js/data/ext.js';
import { formatSandboxApplyNotice } from '../js/data/editor-annotations.js';
import {
    MSG_EXPORT_ALL_SETTINGS,
    MSG_IMPORT_ALL_SETTINGS,
    MSG_RESET_ALL_SETTINGS,
} from '../js/data/message-types.js';
import { DNR_TRACKING_FILTER_NAME, tabLabel } from '../js/data/ui-names.js';
import { loadRulesetDetailsMap } from '../js/data/ruleset-details-loader.js';
import { DOWNLOAD_URL_REVOKE_DELAY_MS, RESTORE_PAGE_RELOAD_DELAY_MS } from '../js/data/timing-constants.js';
import { checkImportFileSize } from '../js/util/input-limits.js';

/******************************************************************************/

const elStatus = qs$('#settingsIoStatus');

function showStatus(message, isError = false) {
    elStatus.textContent = message;
    elStatus.classList.toggle('error', isError);
    elStatus.hidden = false;
}

/******************************************************************************/

async function exportAllSettings() {
    const result = await sendMessage({ what: MSG_EXPORT_ALL_SETTINGS });
    if ( !result?.ok ) {
        showStatus('Save failed — see the background service worker console for details.', true);
        return;
    }
    const json = JSON.stringify(result, null, 2);
    const blob = new Blob([ json ], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const a = dom.create('a');
    a.href = url;
    a.download = `uBlock-Dynamic-settings-${date}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Released after the click has had time to actually start the
    // download — revoking immediately can race the browser's own
    // download-start on some platforms (same reasoning as
    // custom-rules.js's own exportCustomRules()).
    self.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_REVOKE_DELAY_MS);
    showStatus('Settings saved.');
}

async function importAllSettingsFromFile(file) {
    // (11.0.2, C49) Size checked before the file is read or parsed.
    const sizeCheck = checkImportFileSize(file);
    if ( sizeCheck.ok === false ) {
        showStatus(`Restore failed — ${sizeCheck.error}.`, true);
        return;
    }
    let payload;
    try {
        const text = await file.text();
        payload = JSON.parse(text);
    } catch (reason) {
        showStatus(`Restore failed — not valid JSON (${reason.message}).`, true);
        return;
    }
    const result = await sendMessage({ what: MSG_IMPORT_ALL_SETTINGS, payload });
    if ( !result?.ok ) {
        showStatus(`Restore failed — ${result?.error ?? 'unknown error'}.`, true);
        return;
    }
    const { applied, customRules } = result;
    const parts = [];
    // (10.1.0) "filter lists" corrected to mean the actual filter-list on/off choices
    // (enabledRulesetOverrides) — rulesetConfig itself only holds general settings
    // (auto-reload, badge count, permissions), never the filter lists themselves; that
    // label was stale since before this field existed and would have doubly-misled once
    // enabledRulesetOverrides was added alongside it.
    if ( applied?.rulesetConfig ) { parts.push('general settings'); }
    if ( applied?.enabledRulesetOverrides ) { parts.push('filter lists'); }
    // (10.5.0) Tab names come from js/data/ui-names.js (C39a), never typed here.
    if ( applied?.securityConfig ) { parts.push(`${tabLabel('security')} settings`); }
    if ( applied?.siteModes || applied?.filteringModeDetails || applied?.exemptionLists ) { parts.push(tabLabel('develop')); }
    if ( applied?.sandboxFilters ) { parts.push(tabLabel('filters')); }
    if ( customRules?.ok ) {
        const c = customRules.counts;
        const ruleParts = [];
        if ( c.matrixOverrides > 0 ) { ruleParts.push(`${c.matrixOverrides} ${DNR_TRACKING_FILTER_NAME} rule${c.matrixOverrides === 1 ? '' : 's'}`); }
        if ( c.cosmeticHostnames > 0 ) { ruleParts.push(`${c.cosmeticHostnames} cosmetic hostname${c.cosmeticHostnames === 1 ? '' : 's'}`); }
        if ( c.cookieClickerRules > 0 ) { ruleParts.push(`${c.cookieClickerRules} cookie consent-clicker rule${c.cookieClickerRules === 1 ? '' : 's'}`); }
        if ( c.scriptletRules > 0 ) { ruleParts.push(`${c.scriptletRules} Privacy rule${c.scriptletRules === 1 ? '' : 's'}`); }
        if ( ruleParts.length > 0 ) { parts.push(`custom rules (${ruleParts.join(', ')})`); }
    }
    // (10.7.6) Everything the restore could not fully apply is listed in ONE status line (C22): filter lists Chrome
    // refused to switch (audit 10.7.5 D-9) and the restored ABP rules' notice (same as the Import ABP box). With an
    // error the page stays open (no automatic reload) so the message can be read.
    const notes = [];
    let hasError = false;
    if ( Array.isArray(applied?.rulesetsRefused) && applied.rulesetsRefused.length !== 0 ) {
        const names = await loadRulesetDetailsMap();
        notes.push(`These filter lists could not be switched: ${applied.rulesetsRefused.map(r => `"${names.get(r.id)?.name ?? r.id}" (${r.error})`).join(', ')}.`);
        hasError = true;
    }
    if ( result.sandboxCompile ) {
        const notice = formatSandboxApplyNotice(result.sandboxCompile, await sendMessage({ what: 'getSandboxFilters' }));
        if ( notice ) { notes.push(notice.text); hasError ||= notice.isError; }
    }
    const summary = parts.length > 0 ? `Restored: ${parts.join(', ')}.` : 'Nothing to restore — the file had no recognizable settings.';
    showStatus([ summary, ...notes ].join(' '), hasError);
    if ( hasError ) { return; }
    // (10.5.0) The 10.3.0 "protections moved to 3P-Matrix" restore alert was removed with the rest of the
    // pre-10.3.0 conversion code; unknown settings in a backup are dropped by the background (pickKnownKeys).
    // A full reload is the simplest correct way to reflect a restore
    // that can touch every tab's own rendered state at once (filter
    // lists, Options checkboxes, Allow list entries) —
    // matches this project's own "eventually consistent, re-read on
    // next open" posture elsewhere, just applied immediately here since
    // the person is already looking at this exact page.
    self.setTimeout(() => self.location.reload(), RESTORE_PAGE_RELOAD_DELAY_MS);
}

async function resetAllSettings() {
    const result = await sendMessage({ what: MSG_RESET_ALL_SETTINGS });
    if ( !result?.ok ) {
        showStatus(`Reset failed — ${result?.error ?? 'unknown error'}.`, true);
        return;
    }
    showStatus('Reset to defaults. Reloading\u2026');
    // The extension itself reloads shortly after this response (see
    // handleResetAllSettings()'s own comment) — this page's own context
    // goes with it. Nothing further to do here; the person will see
    // Chrome's own "this page is no longer available" state briefly,
    // same as after any extension reload.
}

/******************************************************************************/
// Event handlers
/******************************************************************************/

dom.on('#exportAllSettings', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    exportAllSettings();
});

dom.on('#importAllSettings', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    qs$('#importAllSettingsFile').click();
});

dom.on('#importAllSettingsFile', 'change', async ev => {
    const file = ev.target.files?.[0];
    ev.target.value = ''; // reset so selecting the SAME file again still fires 'change'
    if ( !file ) { return; }
    await importAllSettingsFromFile(file);
});

dom.on('#resetAllSettings', 'click', async ev => {
    if ( ev.isTrusted !== true ) { return; }
    // Strong, explicit confirm — this is irreversible and broader than
    // "Delete all rules" (same tab's own destructive action, custom
    // rules only): every setting AND every custom rule, back to exactly
    // what a fresh install would have. No "are you sure" shortcut.
    const confirmed = confirm(
        'Reset EVERYTHING to defaults? This has the same effect as installing the extension from scratch: ' +
        `every filter list, ${tabLabel('security')} setting, allowlist, the ${tabLabel('develop')}, the ${tabLabel('filters')} text, and every custom rule ` +
        `(cosmetic, ${DNR_TRACKING_FILTER_NAME}, cookie consent-clicker, Privacy/scriptlet) will be erased. ` +
        'The extension will reload immediately after. This cannot be undone — consider using "Save settings" first.'
    );
    if ( !confirmed ) { return; }
    await resetAllSettings();
});

/******************************************************************************/
