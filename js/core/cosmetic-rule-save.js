// ── cosmetic-rule-save.js ─────────────────────────────────────────────────────
// The one save path for custom cosmetic rules: store them for a hostname and re-register what applies them.
//
// Public interface:
//   saveCustomCosmeticSelectors(hostname, selectors) — stores new selectors for hostname; re-registers the content
//                                                      scripts (plain selectors) and/or recompiles (scriptlets);
//                                                      returns true when something new was stored
//
// Dependencies: core/filter-manager.js (addCustomFilters), core/scripting-manager.js (registerContentScripts),
//   core/compiled-filters.js (updateCompiledFilters), util/utils.js (isScriptlet).
//
// State owned by this module: none — storage is owned by filter-manager.js.
//
// Input trust:
//   saveCustomCosmeticSelectors — callers validate first (the picker route in workflow/filter-routes.js, the
//   "Keep for this site" route in workflow/ad-cleaner-routes.js); hostname comes from trustedHostnameFromSender().
//
// Errors: storage and registration failures propagate to the caller (C5).
//
// (11.0.3, C15) Moved here verbatim from js/workflow/filter-routes.js: two route files use it, and a route file may
// not import another route file — the same fix as core/site-mode-apply.js in 10.7.12. Only workflow/ imports this
// module, so it closes no import cycle.
// ─────────────────────────────────────────────────────────────────────────────

import { isScriptlet } from '../util/utils.js';
import { addCustomFilters } from './filter-manager.js';
import { registerContentScripts } from './scripting-manager.js';
import { updateCompiledFilters } from './compiled-filters.js';

// (11.0.0) The one save path for custom cosmetic rules: store them for the hostname and re-register what applies them.
// Callers validate first (the picker route in js/workflow/filter-routes.js; js/workflow/ad-cleaner-routes.js for
// "Keep for this site").
// Returns true when something new was stored.
export async function saveCustomCosmeticSelectors(hostname, selectors) {
    const modified = await addCustomFilters(hostname, selectors);
    if ( modified !== true ) { return false; }
    const hasScriptletFilters = selectors.some(a => isScriptlet(a));
    const hasPlainFilters = selectors.some(a => isScriptlet(a) === false);
    const promises = [];
    if ( hasPlainFilters ) {
        promises.push(registerContentScripts());
    }
    if ( hasScriptletFilters ) {
        promises.push(
            updateCompiledFilters()
        );
    }
    await Promise.all(promises);
    return true;
}
