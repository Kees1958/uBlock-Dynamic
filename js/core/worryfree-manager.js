// ── worryfree-manager.js ─────────────────────────────────────────────────────
// "@@example.com$worryfree" on the Allow list tab: puts ONE website outside
// Worry-free altogether.
//
// What it exempts (10.3.0 — what is left of Worry-free since the Privacy &
// Security extra protections moved to 3P-Matrix): the Worry-free extra FILTER
// LISTS (8 000), through the three WHOLE-SITE allow rules (SITE_ITEMS below,
// 10.0.0) at WORRY_FREE_SITE_ALLOW_PRIORITY. Cookie-consent dismissal ("Never
// consent") is NOT covered — it never was; it has its own per-site controls.
// (The per-protection allow rules this file used to add for the two Low-group
// headers, WORRYFREE_SCP_PRIVACY/SECURITY_ALLOW_RULE_ID, were retired with
// those protections; their ids stay reserved (dnr-budgets.js RETIRED_PROTECTION_RULE_RANGES).)
//
// Public interface:
//   setWorryfreeDomains(domains)  — replaces the list, persists, re-applies
//   getWorryfreeDomains()         — current list (plain array — JSON-safe, C31)
//   applyWorryfreeRules()         — re-applies the DNR rules from stored state
//
// Dependencies (loaded before this file): data/ext-compat.js (dnr),
//   data/config.js (worryfreeState, saveWorryfreeState), core/dnr-budgets.js
//
// State owned by this module: none in memory — worryfreeState lives in
//   config.js (persisted to chrome.storage.local).
//
// ─────────────────────────────────────────────────────────────────────────────

import { dnr } from '../data/ext-compat.js';
import punycode from '../util/punycode.js';
import { isValidHostnamePattern } from '../util/utils.js';
// (AdShield Evolution rename pass) getAllResourceTypes() now lives in
// worry-free-extra-manager.js — the deleted worry-free-advanced.js was
// only ever its original home, not a conceptual owner; see that file's
// own comment on this function for why.
import { getAllResourceTypes } from './worry-free-extra-manager.js';
import { getEffectiveWorryfreeDomains } from './exempt-domains.js';
import { worryfreeState, saveWorryfreeState } from '../data/config.js';
import {
    WORRYFREE_EXTRA_ALLOW_RULE_ID, WORRYFREE_DOWNLOAD_ALLOW_RULE_ID,
    WORRYFREE_SITE_INITIATOR_ALLOW_RULE_ID, WORRYFREE_SITE_REQUEST_ALLOW_RULE_ID,
    WORRYFREE_SITE_FRAMETREE_ALLOW_RULE_ID,
    WORRY_FREE_SITE_ALLOW_PRIORITY,
} from './dnr-budgets.js';

// RETIRED (AdShield Evolution rename pass) — blockScpTldBlock's two allow
// ids. Removed on every apply (Chrome ignores ids that don't exist); never
// reassigned to a new feature. (The 10.3.0 retirements are only reserved —
// dnr-budgets.js RETIRED_PROTECTION_RULE_RANGES; their start-up clean-up was
// removed in 10.5.0.)
const RETIRED_RULE_IDS = [
    WORRYFREE_EXTRA_ALLOW_RULE_ID,
    WORRYFREE_DOWNLOAD_ALLOW_RULE_ID,
];

// The WHOLE-SITE exemption (10.0.0, owner's decision): "@@site$worryfree" puts the site outside Worry-free
// altogether. Rules at WORRY_FREE_SITE_ALLOW_PRIORITY (9 500 — above the extra lists (8 000) and their
// per-list off-switch (9 000), below the default lists and everything the person owns):
//   - initiator: everything the site's own pages and frames (its subdomains included) request;
//   - request:   everything sent TO the site's hosts, including the navigation to the site itself;
//   - frame tree (10.1.3, "option B"): an allowAllRequests on the site's own page (main_frame), so a request
//     made by an embedded frame of ANOTHER domain (which carries that domain as its initiator) is covered too.
// Resource types come from the browser's own enum (an unknown type would fail the WHOLE update), minus
//   'main_frame' for the initiator rule — a link the person follows OUT of the site is their own choice.
// (10.3.0) 'webbundle' is no longer excluded: it was kept out only so the always-on Web Bundle block could
//   keep applying everywhere, and that block was removed with the Privacy & Security protections.
const SITE_INITIATOR_EXCLUDED_TYPES = Object.freeze([ 'main_frame' ]);
function siteResourceTypes(excluded) {
    return getAllResourceTypes().filter(type => excluded.includes(type) === false);
}
const SITE_ITEMS = [
    { id: WORRYFREE_SITE_INITIATOR_ALLOW_RULE_ID, priority: WORRY_FREE_SITE_ALLOW_PRIORITY,
      condition: () => ({ resourceTypes: siteResourceTypes(SITE_INITIATOR_EXCLUDED_TYPES) }),
      domainsKey: 'initiatorDomains' },
    { id: WORRYFREE_SITE_REQUEST_ALLOW_RULE_ID, priority: WORRY_FREE_SITE_ALLOW_PRIORITY,
      condition: () => ({ resourceTypes: siteResourceTypes([]) }),
      domainsKey: 'requestDomains' },
    { id: WORRYFREE_SITE_FRAMETREE_ALLOW_RULE_ID, priority: WORRY_FREE_SITE_ALLOW_PRIORITY,
      action: 'allowAllRequests',
      condition: () => ({ resourceTypes: [ 'main_frame' ] }),
      domainsKey: 'requestDomains' },
];
const ALL_RULE_IDS = SITE_ITEMS.map(item => item.id);

// GUARD — clear/release: every apply removes ALL of this feature's ids
// first, so an emptied list leaves nothing registered and a shrunk list
// cannot strand a rule for a domain the person deleted.
async function applyRules() {
    // The EFFECTIVE list: the Allow list tab (worryfreeState), the ABP-import editor and the built-in
    // badfilter-quick-fixes.txt lines (exempt-domains.js). getWorryfreeDomains()/setWorryfreeDomains()
    // below stay the Allow list tab's OWN list, so built-in/imported sites never show up in that editor.
    const domains = getEffectiveWorryfreeDomains();
    const addRules = domains.length === 0 ? [] : [
        ...SITE_ITEMS.map(item => ({
            id: item.id,
            priority: item.priority,
            action: { type: item.action ?? 'allow' },
            condition: { [item.domainsKey]: domains, ...item.condition() },
        })),
    ];
    await dnr.updateDynamicRules({ removeRuleIds: [ ...ALL_RULE_IDS, ...RETIRED_RULE_IDS ], addRules }).catch(reason => {
        console.error('[uBlock-Dynamic] worryfree-manager/applyRules:', reason);
    });
}

export function getWorryfreeDomains() {
    return [ ...worryfreeState.domains ];
}

export async function setWorryfreeDomains(domains) {
    // Normalised — trimmed, lowercased, de-duplicated, empties dropped.
    // (11.0.2, audit 11.0.2 finding 5) …and only real site names kept. These go into ONE DNR update, which Chrome
    // refuses as a whole for one bad entry (a non-ASCII name from a hand-edited settings file, say) — every Seamless
    // exemption would stop at once, with only a console line. Non-ASCII names are converted (punycode), the rest is
    // checked like every other hostname (isValidHostnamePattern); '*' is not a site here.
    const candidates = Array.isArray(domains)
        ? domains.map(d => punycode.toASCII(String(d).trim().toLowerCase())).filter(d => d.length > 0)
        : [];
    const refused = candidates.filter(d => d === '*' || isValidHostnamePattern(d) === false);
    if ( refused.length !== 0 ) {
        console.warn('[uBlock-Dynamic] worryfree-manager: not a site name, not saved:', refused.join(', '));
    }
    const normalized = [ ...new Set(candidates.filter(d => refused.includes(d) === false)) ];
    worryfreeState.domains = normalized;
    await saveWorryfreeState();
    await applyRules();
    return getWorryfreeDomains();
}

export async function applyWorryfreeRules() {
    await applyRules();
}
