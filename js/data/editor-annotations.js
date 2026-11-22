// ── editor-annotations.js ────────────────────────────────────────────────────
// Text markers the Import ABP editor shares between the service worker (which writes them) and the dashboard
// editor (which colours them). One place, so the writer and the colouring can never disagree (B2).
//
// Public interface:
//   REJECTED_LINE_PREFIX — first characters of the comment line written beneath a refused line
//                          (js/core/custom-scriptlets.js syncScriptletRulesFromSandboxText()); the editor shows
//                          such lines in the error colour (js/ui/filter-editor.js, 10.7.2).
//   countRejectedLines(text)              — (10.7.6) how many refused lines a box text holds
//   formatSandboxApplyNotice(result, text) — (10.7.6) the ONE notice after a save / file import / restore
//   formatRulesNotAppliedMessage(error)   — (10.7.6) "saved, but could not be applied"
//
// Pure data and pure functions: nothing to initialise, clear or release.

export const REJECTED_LINE_PREFIX = '! Rejected: ';

// (10.7.6) How many lines of the box are refused — each is commented out with "! Rejected: <reason>" beneath it.
export function countRejectedLines(text) {
    return String(text ?? '').split(/\r\n|\r|\n/).filter(l => l.trimStart().startsWith(REJECTED_LINE_PREFIX.trim())).length;
}

// (10.7.6) The ONE notice after a save, a file import or a settings restore of the Import ABP box (C22): from the
// background's report (sandboxApplyReport() in background.js) and the stored text. null = nothing to say.
//   { text, isError } — isError when rules are not (all) active; the refused-lines count is information.
export function formatSandboxApplyNotice(result, storedText) {
    if ( result?.ok === false ) {
        return { text: formatRulesNotAppliedMessage(result.error ?? 'unknown error'), isError: true };
    }
    const errors = Array.isArray(result?.applyErrors) ? result.applyErrors : [];
    if ( result?.noRulesActive === true ) {
        return { text: `Chrome refused your network rules: ${errors.join('; ')}. None of your imported network rules are active.`, isError: true };
    }
    if ( errors.length !== 0 ) {
        return { text: `Some rules could not be applied: ${errors.join('; ')}.`, isError: true };
    }
    const refused = countRejectedLines(storedText);
    if ( refused !== 0 ) {
        return { text: `${refused} line${refused === 1 ? '' : 's'} cannot be used — each is commented out with the reason in red beneath it.`, isError: false };
    }
    return null;
}

// (10.7.6, C5) The one user-visible text for "saved, but the network rules could not be applied".
// Also used by settings-io.js for a restored backup, so both entry points say the same thing (C22).
export function formatRulesNotAppliedMessage(error) {
    return `Your rules were saved but could not be applied: ${error}. The previous rules stay active.`;
}
