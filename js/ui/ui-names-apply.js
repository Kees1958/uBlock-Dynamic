// ── ui-names-apply.js ────────────────────────────────────────────────────────
// (10.5.0) Fills every <span data-ui-name="KEY"></span> in a page from js/data/ui-names.js's
// UI_NAMES, so HTML never carries a typed copy of a feature or tab name (C39a). An unknown key is
// a programming error and is reported loudly instead of leaving an empty span.
//
// No state: runs once per call over the given root; nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────

import { UI_NAMES } from '../data/ui-names.js';

const UI_NAME_SELECTOR = '[data-ui-name]';   // attribute that marks a derived-name placeholder

export function applyUiNames(root = document) {
    for ( const el of root.querySelectorAll(UI_NAME_SELECTOR) ) {
        const key = el.dataset.uiName;
        if ( !Object.hasOwn(UI_NAMES, key) ) {
            console.error(`[uBlock-Dynamic] applyUiNames: unknown data-ui-name "${key}"`);
            continue;
        }
        el.textContent = UI_NAMES[key];
    }
}
