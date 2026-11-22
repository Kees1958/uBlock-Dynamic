// ── exempt-domains.js ─────────────────────────────────────────────────────────
// One place that answers "which sites are exempt from Worry-free?" for the per-site Allow-list option
// ($worryfree), whatever channel the person used to declare it.
//
// Public interface:
//   getEffectiveWorryfreeDomains()   — built-in ∪ trusted payment/sign-in services (data/trusted-service-domains.js) ∪ Allow list tab ∪ ABP-import editor
//   loadBuiltinExemptDomains()       — async; reads the built-in ("@@domain$worryfree" in
//                                      badfilter-quick-fixes.txt) domains from the carrier rules shipped in
//                                      rulesets/ruleset_badfilter_quickfixes.json (10.2.0 —
//                                      core/builtin-exemption-carriers.js); call once per SW start, before
//                                      any consumer applies rules (background.js start())
//   refreshImportedExemptDomains(text) — recompute the ABP-import part from the editor's text
//   stripExemptionOptionLines(text)  — the text WITHOUT the "@@domain$<option>" lines (live AND retired —
//                                      "$saferegions" since 10.3.0), which must never reach the
//                                      network/cosmetic/scriptlet compilers
//
// WHY THIS EXISTS (10.0.0, real report: "@@bbc.com$worryfree" in badfilter-quick-fixes.txt was
// silently dropped while its tooltips promised it worked): an Allow-list option is declared in
// THREE channels — the Allow list tab, the ABP-import editor and the built-in
// badfilter-quick-fixes.txt list — and each used to implement its own subset. Every consumer now
// asks this module, so a channel cannot be forgotten by one of them. tools/check-exemption-channels.mjs
// fails if an option in SITE_MODE_OPTIONS lacks a channel.
//
// Dependencies (must be loaded before this file):
//   data/config.js (worryfreeState), util/site-mode-parser.js,
//   core/builtin-exemption-carriers.js (the carrier rule shape), data/ext.js (runtime.getURL)
//
// State owned by this module:
//   importedDomains {Object} — { worryfree: string[] }, derived from the
//     ABP-import text. Bounded by the number of lines in that text (replaced, never appended to).
//     Lost on SW restart (safe): background.js start() recomputes it right after the config load,
//     before any consumer runs.
//   builtinDomains {Object} — { worryfree: string[] }, read from the shipped
//     quick-fixes ruleset. Bounded by that file (replaced, never appended to). Lost on SW restart (safe):
//     background.js start() reloads it right after the ABP-import recompute. Until it has loaded the
//     built-in part is empty — the same "nothing yet" a fresh install had before the file was read.
// ──────────────────────────────────────────────────────────────────────────────
import { worryfreeState } from '../data/config.js';
import { SITE_MODE_OPTIONS, extractOptionLinesFromText } from '../util/site-mode-parser.js';
import { QUICKFIXES_RULESET_PATH, readExemptionCarrierDomains } from './builtin-exemption-carriers.js';
import { browser } from '../data/ext.js';
import { TRUSTED_SERVICE_DOMAINS } from '../data/trusted-service-domains.js';

let importedDomains = { [SITE_MODE_OPTIONS.WORRYFREE]: [] };
let builtinDomains  = { [SITE_MODE_OPTIONS.WORRYFREE]: [] };

// GUARD — init/clear: replaces the previous result wholesale. A failed read keeps the previous value (logged),
// so a transient error never wipes exemptions that were already loaded this session.
export async function loadBuiltinExemptDomains() {
    try {
        const res = await fetch(browser.runtime.getURL(QUICKFIXES_RULESET_PATH));
        const rules = await res.json();
        if ( !Array.isArray(rules) ) { throw new Error('quick-fixes ruleset is not an array'); }
        builtinDomains = readExemptionCarrierDomains(rules);
    } catch (reason) {
        console.error('[uBlock-Dynamic] exempt-domains/loadBuiltinExemptDomains:', reason);
    }
}

function union(...lists) {
    return [ ...new Set(lists.flat()) ];
}

// GUARD — init/clear: replaces the previous result wholesale, so removing a line from the editor
// (or clearing the text) removes its exemption on the next call, with nothing stranded.
export function refreshImportedExemptDomains(text) {
    const { byOption } = extractOptionLinesFromText(typeof text === 'string' ? text : '');
    importedDomains = {
        [SITE_MODE_OPTIONS.WORRYFREE]:   byOption[SITE_MODE_OPTIONS.WORRYFREE] ?? [],
    };
}

export function stripExemptionOptionLines(text) {
    return typeof text === 'string' ? extractOptionLinesFromText(text).remainingText : '';
}

export function getEffectiveWorryfreeDomains() {
    return union(builtinDomains[SITE_MODE_OPTIONS.WORRYFREE], TRUSTED_SERVICE_DOMAINS, worryfreeState.domains, importedDomains[SITE_MODE_OPTIONS.WORRYFREE]);
}
