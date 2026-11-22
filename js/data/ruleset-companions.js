/*
 * ruleset-companions.js — Single source of truth for which hidden
 * companion ruleset(s) accompany each visible dedicated filter. Two kinds
 * of companion exist:
 *   1. "AG Base overflow" rulesets — see tools/build-rulesets.mjs's
 *      countryOverflow config for how these are built.
 *   2. Unsafe-rule companions ("_removeparam" / "_unsafe", 10.2.0:
 *      UNSAFE_RULE_COMPANIONS below) — the unsafe (redirect/modifyHeaders)
 *      rules split out of an otherwise safe list, so routine content
 *      refreshes of the safe majority qualify for skip-review.
 * Both kinds are applied at runtime the same way — see
 * js/core/static-rulesets.js's setRulesetEnabled().
 *
 * Enabling a key here also enables every ruleset id in its value array;
 * disabling the key disables them too. This keeps AdGuard Base's
 * per-country content (extracted at build time so it isn't shipped/matched
 * for every user regardless of need) in sync with the visible filter a
 * user actually toggles, without the dashboard needing to know these
 * hidden rulesets exist — see dashboard/filter-manager-ui.js's display-name
 * map, which intentionally has no entry for any *_overflow_* id.
 *
 * ruleset_agbase_overflow_other has no entry here (and no visible-filter
 * companion): it holds extended-EU countries with no dedicated filter of
 * their own, so it's only ever enabled directly, via detected browser
 * locale (see enableLocaleLanguageFilter() in js/workflow/background.js).
 */

// ── Unsafe-rule companions (10.2.0) ─────────────────────────────────────────
// Chrome Web Store skip-review ("SAFE" update) accepts only safe rule actions (block, allow,
// allowAllRequests, upgradeScheme — tools/build/safe-update-rules.mjs) in a changed ruleset. Every list
// that may compile UNSAFE rules (redirect — what $removeparam/$redirect compile to — or modifyHeaders) has
// them written to its own companion ruleset declared HERE, so a refresh of the list's safe main file still
// qualifies. The owner's rule: every list AdGuard itself curates (10.2.1 — AdGuard Base with its hidden
// country-overflow buckets, AdGuard anti-adblock, the AdGuard language filters), the
// remaining country filters and the quick-fixes list have a companion. Not AdGuard tracking servers (the build
// keeps only plain ||domain^ lines, so it can never carry one) and not the annoyances list (AdGuard and
// EasyList merged — owner's decision). An unsafe rule produced by ANY other list is dropped with a warning
// (tools/build/build-steps.mjs). A companion is declared even while empty ([]), so a list that starts
// producing unsafe rules later needs no manifest change.
//
// parent id -> companion id. Ids that shipped before 10.2.0 keep their name (_removeparam) — they are stored
// in people's settings; new ones end in _unsafe.
export const UNSAFE_RULE_COMPANIONS = Object.freeze({
    // (10.7.6) AdGuard Base's own unsafe companion — its $redirect rules (bundled noop files), toggled WITH the
    // list. Its $removeparam rules go to REMOVEPARAM_COMPANIONS below instead (own toggle); until 10.7.6 that
    // was this entry, when $removeparam was the only unsafe rule the list could produce.
    ruleset_adguard_base:          'ruleset_adguard_base_unsafe',
    ruleset_adguard_french:        'ruleset_adguard_french_removeparam',
    ruleset_badfilter_quickfixes:  'ruleset_badfilter_quickfixes_unsafe',
    ruleset_adguard_dutch:         'ruleset_adguard_dutch_unsafe',
    ruleset_adguard_german:        'ruleset_adguard_german_unsafe',
    ruleset_adguard_spanish:       'ruleset_adguard_spanish_unsafe',
    ruleset_easylist_italian:      'ruleset_easylist_italian_unsafe',
    ruleset_easylist_polish:       'ruleset_easylist_polish_unsafe',
    ruleset_easylist_portuguese:   'ruleset_easylist_portuguese_unsafe',
    ruleset_easylist_latvian:      'ruleset_easylist_latvian_unsafe',
    ruleset_easylist_czech_slovak: 'ruleset_easylist_czech_slovak_unsafe',
    ruleset_easylist_nordic:       'ruleset_easylist_nordic_unsafe',
    ruleset_easylist_bulgarian:    'ruleset_easylist_bulgarian_unsafe',
    ruleset_hungarian:             'ruleset_hungarian_unsafe',             // (10.4.5)
    ruleset_english_outside_top1m: 'ruleset_english_outside_top1m_unsafe', // (10.7.0) AdGuard Base's unsafe rules for those sites
    // (10.2.1) every other ruleset AdGuard curates — AdGuard Base's hidden parts and AdGuard anti-adblock.
    ruleset_adguard_antiadblock:          'ruleset_adguard_antiadblock_unsafe',
    ruleset_agbase_overflow_dutch:        'ruleset_agbase_overflow_dutch_unsafe',
    ruleset_agbase_overflow_german:       'ruleset_agbase_overflow_german_unsafe',
    ruleset_agbase_overflow_french:       'ruleset_agbase_overflow_french_unsafe',
    ruleset_agbase_overflow_spanish:      'ruleset_agbase_overflow_spanish_unsafe',
    ruleset_agbase_overflow_italian:      'ruleset_agbase_overflow_italian_unsafe',
    ruleset_agbase_overflow_polish:       'ruleset_agbase_overflow_polish_unsafe',
    ruleset_agbase_overflow_portuguese:   'ruleset_agbase_overflow_portuguese_unsafe',
    ruleset_agbase_overflow_latvian:      'ruleset_agbase_overflow_latvian_unsafe',
    ruleset_agbase_overflow_czech_slovak: 'ruleset_agbase_overflow_czech_slovak_unsafe',
    ruleset_agbase_overflow_bulgarian:    'ruleset_agbase_overflow_bulgarian_unsafe',
    ruleset_agbase_overflow_nordic:       'ruleset_agbase_overflow_nordic_unsafe',
    ruleset_agbase_overflow_other:        'ruleset_agbase_overflow_other_unsafe',
    ruleset_agbase_overflow_hungarian:    'ruleset_agbase_overflow_hungarian_unsafe',   // (10.4.5)
});

// (10.7.6) Removeparam companions — a list listed here sends its $removeparam rules (redirect with a
// queryTransform) to this ruleset, switched by its OWN setting, and every other unsafe rule to its
// UNSAFE_RULE_COMPANIONS entry above. Only AdGuard Base: "AdGuard remove tracking parameters", a Worry-free
// opt-in (worry-free-extra-manager.js no-tier suppression rule), at its own priority (filter-lists.mjs
// removeparamCompanionPriority). The id predates 10.2.0 and is stored in people's settings — kept.
export const REMOVEPARAM_COMPANIONS = Object.freeze({
    ruleset_adguard_base: 'ruleset_adguard_base_removeparam',
});

// Unsafe companions switched by their OWN setting, never together with their parent — derived, never hand-kept.
export const UNSAFE_COMPANIONS_WITH_OWN_TOGGLE = Object.freeze(Object.values(REMOVEPARAM_COMPANIONS));

// (10.7.6) parent -> companion pairs of BOTH maps: every ruleset that may hold unsafe rules by design, for the
// tools that must know them all (check-unsafe-split.mjs, build-safe-filters.mjs). Derived, never hand-kept.
export const ALL_UNSAFE_COMPANION_PAIRS = Object.freeze([
    ...Object.entries(UNSAFE_RULE_COMPANIONS), ...Object.entries(REMOVEPARAM_COMPANIONS),
].map(pair => Object.freeze(pair)));

// AG Base country-TLD overflow buckets that belong to a visible filter (see the header above).
const OVERFLOW_COMPANIONS = Object.freeze({
    ruleset_adguard_dutch:         [ 'ruleset_agbase_overflow_dutch' ],
    ruleset_adguard_german:        [ 'ruleset_agbase_overflow_german' ],
    ruleset_adguard_french:        [ 'ruleset_agbase_overflow_french' ],
    ruleset_adguard_spanish:       [ 'ruleset_agbase_overflow_spanish' ],
    ruleset_easylist_italian:      [ 'ruleset_agbase_overflow_italian' ],
    ruleset_easylist_polish:       [ 'ruleset_agbase_overflow_polish' ],
    ruleset_easylist_portuguese:   [ 'ruleset_agbase_overflow_portuguese' ],
    ruleset_easylist_latvian:      [ 'ruleset_agbase_overflow_latvian' ],
    ruleset_easylist_czech_slovak: [ 'ruleset_agbase_overflow_czech_slovak' ],
    ruleset_easylist_bulgarian:    [ 'ruleset_agbase_overflow_bulgarian' ],
    ruleset_easylist_nordic:       [ 'ruleset_agbase_overflow_nordic' ],
    ruleset_hungarian:             [ 'ruleset_agbase_overflow_hungarian' ],   // (10.4.5)
});

// Derived, never hand-kept: overflow buckets + the unsafe companion of each parent (unless it has its own toggle),
// FLATTENED: a companion's own companions belong to the parent too (Dutch filter -> its overflow bucket -> that
// bucket's unsafe companion), because setRulesetEnabled() cascades exactly one level. Bounded: the maps are finite
// and a `seen` set stops any cycle.
function buildRulesetCompanions() {
    const direct = {};
    for ( const [ parent, ids ] of Object.entries(OVERFLOW_COMPANIONS) ) { direct[parent] = [ ...ids ]; }
    for ( const [ parent, companion ] of Object.entries(UNSAFE_RULE_COMPANIONS) ) {
        if ( UNSAFE_COMPANIONS_WITH_OWN_TOGGLE.includes(companion) ) { continue; }
        (direct[parent] ??= []).push(companion);
    }
    const out = {};
    for ( const parent of Object.keys(direct) ) {
        const seen = new Set();
        const queue = [ ...direct[parent] ];
        while ( queue.length > 0 ) {
            const id = queue.shift();
            if ( seen.has(id) || id === parent ) { continue; }
            seen.add(id);
            queue.push(...(direct[id] ?? []));
        }
        out[parent] = Object.freeze([ ...seen ]);
    }
    return Object.freeze(out);
}

export const RULESET_COMPANIONS = buildRulesetCompanions();
