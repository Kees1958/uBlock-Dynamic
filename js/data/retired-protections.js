// ── retired-protections.js ───────────────────────────────────────────────────
// The ONE place that names what the 10.3.0 removal retired: the Privacy & Security tab's extra
// protections (the "Security", "Very low" and "Low" groups), the two Worry-free tier checkboxes, the
// editable "safer region" TLD list and the "$saferegions" Allow-list option. Those protections moved
// to the owner's separate extension "3P Matrix — content firewall".
//
// (10.5.0) The upgrade clean-up for installs older than 10.3.0 was removed (owner's clean-up of old
// conversion code): the retired key lists, core/retired-protections-cleanup.js and the restore alert
// are gone. Unknown stored/restored settings keys are now dropped generically (data/config.js
// pickKnownKeys()). What is left here is live UI text.
//
// Read by:
//   dashboard/security.js               — renders PROTECTIONS_MOVED_NOTICE on the Options tab
//   js/ui/mode-editor.js                — tells the person when a save dropped "$saferegions" lines
//
// Pure data: one import (the feature name, single source ui-names.js), no state — nothing to initialise,
// clear or release.
// ─────────────────────────────────────────────────────────────────────────────

import { WORRY_FREE_NAME } from './ui-names.js';

// Shown on the Options tab (last line of the tab) and inside retiredOptionLinesMessage() —
// one string, so the two places can never say different things (B2a).
// (10.5.1, owner's request) Names WHICH protections moved — the Worry-free extra filter lists and
// cookie auto-deny stay here. (10.7.3, owner's request) Only the safer-regions protections are named.
// Extension name as 3P Matrix's own manifest spells it.
export const PROTECTIONS_MOVED_NOTICE =
    'The safer-regions protections have moved to another extension, '
    + '"3P Matrix — content firewall" (available in the Chrome Web Store). '
    + `${WORRY_FREE_NAME} here still enables the extra filter lists and cookie-consent dismissal.`;

// Shown by the Allow list editor (js/ui/mode-editor.js) when a save dropped retired "$saferegions" lines.
// Pure: count → message. Unknown/invalid count → ''.
export function retiredOptionLinesMessage(count) {
    if ( Number.isInteger(count) === false || count <= 0 ) { return ''; }
    const lines = count === 1 ? '1 "@@domain$saferegions" line was' : `${count} "@@domain$saferegions" lines were`;
    return `${lines} removed: that option is no longer supported. ${PROTECTIONS_MOVED_NOTICE}`;
}
