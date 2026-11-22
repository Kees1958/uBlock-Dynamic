/*******************************************************************************

    uBlock-Stripped-Dynamic — Allow list editor (dashboard Allow list tab)

    The CodeMirror editor shows and edits a plain list of domains for which
    filtering is turned off (allow-listed). One domain per line.

    Internally these map to siteModes entries with mode 0 (no-filtering).
    All other domains remain at the default mode 1 (basic / on).

    Also supports one other, unrelated line shape: "@@domain$worryfree" — a
    per-domain exemption from Worry-free (see worryfree-manager.js), NOT a
    no-filtering entry. Extracted separately before the plain domain-list
    parsing ever sees it — see site-mode-parser.js's
    extractOptionLinesFromText(). (10.3.0) "@@domain$saferegions" lines are a
    retired option: a save drops them and says so (retiredOptionLinesMessage()).

*******************************************************************************/

import {
    siteModesFromText,
    textFromSiteModes,
    extractOptionLinesFromText,
    SITE_MODE_OPTIONS,
    textFromWorryfree,
} from '../util/site-mode-parser.js';
import { sendMessage } from '../data/ext.js';
import { retiredOptionLinesMessage } from '../data/retired-protections.js';

// (11.0.2, audit 11.0.2 finding 5) Lines that are not a website name are not saved; the notice after saving lists
// them, so a line vanishing from the editor is never a silent surprise (same posture as the retired-option notice).
const REFUSED_LINES_SHOWN_MAX = 10;   // longer lists end with "…and N more"
function refusedLinesMessage(refused) {
    if ( refused.length === 0 ) { return ''; }
    const shown = refused.slice(0, REFUSED_LINES_SHOWN_MAX).map(line => `  ${line}`);
    const more = refused.length > REFUSED_LINES_SHOWN_MAX ? [ `  …and ${refused.length - REFUSED_LINES_SHOWN_MAX} more` ] : [];
    return [ 'These lines are not website names, so they were not saved:', ...shown, ...more,
        'Write one website name per line, for example: example.com' ].join('\n');
}

/******************************************************************************/

export class ModeEditor {
    constructor(editor) {
        this.editor = editor;
        this.bc = null;
    }

    on() {}
    off() {}

    async getText() {
        // $worryfree domains fetched alongside the no-filtering list and
        // re-injected as their own lines — a saved $worryfree entry must
        // round-trip back into the editor on reload the same way a
        // no-filtering domain does, or it would look like it silently
        // vanished. Fetched in parallel: two independent, unrelated reads.
        const [ siteModes, worryfreeDomains ] = await Promise.all([
            sendMessage({ what: 'siteModeGetAll' }),
            sendMessage({ what: 'worryfreeGetAll' }),
        ]);
        // sendMessage() resolves to `undefined` when every retry attempt
        // failed (SW not ready, messaging error, etc.) — indistinguishable
        // by value from a legitimate empty {} response otherwise. Throwing
        // here (instead of defaulting to {}) lets the caller (develop.js)
        // tell the difference and refuse to show an editable-and-savable
        // blank editor that could silently overwrite the real stored list.
        if ( siteModes === undefined ) {
            throw new Error('siteModeGetAll: no response from background');
        }
        // worryfreeGetAll failing is treated more leniently than
        // siteModeGetAll above — an empty/missing $worryfree list is a
        // normal, common state (most people never use it), so falling back
        // to [] here (rather than throwing and blocking the whole editor
        // from loading) is the right default; siteModes failing is the one
        // that must never be silently papered over, since THAT list is what
        // the editor could accidentally overwrite as empty.
        const domainsText = textFromSiteModes(siteModes);
        const worryfreeText = textFromWorryfree(Array.isArray(worryfreeDomains) ? worryfreeDomains : []);
        return worryfreeText + domainsText;
    }

    async saveEditorText(editor) {
        const rawText = editor.getEditorText();
        // ONE extraction pass for every option line — see
        // site-mode-parser.js's own note on why this is a single shared
        // parser (B15). The REMAINING text (every other line, unchanged)
        // goes through the plain domain-list path.
        const { byOption, remainingText, ignoredRetiredCount } = extractOptionLinesFromText(rawText);
        const worryfreeDomains = byOption[SITE_MODE_OPTIONS.WORRYFREE];
        const refusedLines = [];
        const siteModes = siteModesFromText(remainingText, refusedLines);
        const [ saved, savedWorryfree ] = await Promise.all([
            sendMessage({ what: 'siteModeSetAll', siteModes }),
            sendMessage({ what: 'worryfreeSetAll', domains: worryfreeDomains }),
        ]);
        // Same undefined-means-failure distinction as getText() above:
        // handleSiteModeSetAll (background.js) always resolves with an
        // object on success — {} only for a genuinely empty list, never
        // undefined — so undefined here means the message itself failed.
        // Report failure rather than silently marking the editor "saved".
        if ( saved === undefined ) {
            console.error('[uBlock-Dynamic] Allow list editor: save failed — no response from background');
            return false;
        }
        // worryfreeSetAll failing doesn't block reporting the siteModes save
        // as successful (that part DID save correctly) — but the displayed
        // text afterward must reflect what's ACTUALLY stored, not what was
        // typed, so a failed save doesn't leave the editor showing lines
        // that didn't actually persist.
        const effectiveWorryfree = savedWorryfree !== undefined ? savedWorryfree : [];
        if ( savedWorryfree === undefined ) {
            console.error('[uBlock-Dynamic] Allow list editor: $worryfree save failed — no response from background');
        }
        editor.setEditorText(
            textFromWorryfree(effectiveWorryfree) +
            textFromSiteModes(saved)
        );
        // (10.3.0) Retired "$saferegions" lines were dropped above (never saved): say so once, so the line
        // vanishing from the editor is not a silent surprise.
        const notice = [ retiredOptionLinesMessage(ignoredRetiredCount), refusedLinesMessage(refusedLines) ]
            .filter(text => text !== '').join('\n\n');
        if ( notice !== '' ) { self.alert(notice); }
        return true;
    }

    updateView(editor, firstLine, lastLine) {
        // No inline validation needed — plain domain list
    }

    // No newlineAssistant: plain list needs no auto-indentation prefix
}
