// ── tools/build/filter-lists.mjs ──────────────────────────────────────────────────────
// FILTER_LISTS — the declared list of every upstream filter list the build compiles, with its customFetch hooks.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: FILTER_LISTS
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import { WORRY_FREE_EXTRA_LISTS_PRIORITY, WORRY_FREE_EXTRA_LISTS_ALLOWLIST_PRIORITY, WORRY_FREE_ADGUARD_REMOVEPARAM_PRIORITY, BADFILTER_QUICKFIXES_PRIORITY } from '../../js/core/dnr-budgets.js';
import { buildAntiAdmiralSourceText } from './anti-admiral.mjs';
import { ANTIADBLOCK_SPLIT_CONFIG, antiadblockGeneralText } from './antiadblock-country-split.mjs';
import { agBaseBelgianText, agSpanishGenericText, setAgBaseBelgianText, setAgBaseLanguageBucketText, setAgSpanishGenericText, setAgBaseEnglishText, setAntiadblockEnglishText } from './build-state.mjs';
import { englishOutsideTopSitesText, splitAntiadblockEnglish, splitBaseEnglish } from './english-outside-top-sites.mjs';
import { fetchList } from './fetch-helpers.mjs';
import { extractAdultSiteRules, extractForeignRulesSections, extractSpanishGenericAndLusophone } from './tld-scope.mjs';
import { AGBASE_GENERAL_URL_SOURCE, buildTop25AdultSiteRulesText, topAdultSiteDomains } from './adult-site-rules.mjs';
import { ADGUARD_TRACKING_SERVERS_SOURCE, PETERLOWE_SOURCE, buildWorryFreeLists } from './worry-free-extra-lists.mjs';
import { buildSelectedHageziLightText } from './hagezi-light-selection.mjs';
import { KEES1958_SOURCE, buildKees1958SourceText } from './kees1958-source.mjs';
import { TRACKING_ALLOWLIST_SOURCE, buildTrackingAllowlistSourceText } from './tracking-allowlist-source.mjs';
import { buildAnnoyancesSourceText } from './annoyances-sources.mjs';

/******************************************************************************/
// Settings — upstream section files for the rebuilt Spanish / Portuguese lists (10.0.7)
/******************************************************************************/

// AdGuard SpanishFilter sections: same 7 inclusions AdGuard Base uses (general_elemhide and replace excluded).
// Anti-adblock list sources besides AdGuard Base's section (see the ruleset_adguard_antiadblock entry).
const ANTIADBLOCK_POPUPS_URL = 'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/AnnoyancesFilter/Popups/sections/antiadblock.txt';
const ANTIADBLOCK_EASYLIST_ENGLISH_URL = 'https://raw.githubusercontent.com/easylist/antiadblockfilters/master/antiadblockfilters/antiadblock_english.txt';
const SPANISH_SECTIONS_BASE_URL = 'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/SpanishFilter/sections/';
const SPANISH_SECTION_FILES = Object.freeze([ 'adservers', 'adservers_firstparty', 'allowlist', 'antiadblock', 'general_extensions', 'general_url', 'specific' ]);
// EasyList Portuguese: the 7 relevant sub-files (of 14; ~213 real lines).
const PORTUGUESE_SECTIONS_BASE_URL = 'https://raw.githubusercontent.com/easylist/easylistportuguese/master/easylistportuguese/easylistportuguese_';
const PORTUGUESE_SECTION_FILES = Object.freeze([ 'adservers', 'adservers_popup', 'general_block', 'thirdparty', 'thirdparty_popup', 'specific_block', 'specific_block_popup' ]);

// (10.4.6) The Japanese and Korean filters were removed (owner's decision after the Chrome Web Store "remotely hosted
// code" rejection); Japan and South Korea are out of the geographic scope again (tld-scope.mjs GEO_SCOPE).

// EasyList Italian: same 7-file selection as ruleset_easylist_portuguese (same upstream project
// structure — easylist/easylistitaly mirrors easylist/easylistportuguese file-for-file).
const ITALIAN_SECTIONS_BASE_URL = 'https://raw.githubusercontent.com/easylist/easylistitaly/master/easylistitaly/easylistitaly_';
const ITALIAN_SECTION_FILES = Object.freeze([ 'adservers', 'adservers_popup', 'general_block', 'thirdparty', 'thirdparty_popup', 'specific_block', 'specific_block_popup' ]);

/******************************************************************************/
// Filter list definitions
/******************************************************************************/


// ── Combined country filters (10.4.5, owner's decision) ─────────────────────
// Small country filters are STORED as one ruleset but SHOWN in the dashboard as separate rows. A row is labelled
// "<language> language" (owner's decision: languages, no source names — the sources stay in each filter's own entry
// below); only a country where one language label would not fit (several languages: Bosnia and Herzegovina,
// Kosovo) is labelled by its name (`showCountry`). Which rows the person added: js/core/language-filter-countries.js.
// One place per group: the country rows, their browser languages (locale auto-enable), their ccTLDs (the
// group's AdGuard Base overflow bucket) and the language shown. `tlds` may be empty (Kosovo has no ccTLD;
// Montenegro's .me is used worldwide and stays in AdGuard Base).
function countryTable(rows) {
    return Object.freeze(rows.map(c => Object.freeze({ ...c, locales: Object.freeze(c.locales), tlds: Object.freeze(c.tlds) })));
}
const BALKAN_COUNTRIES = countryTable([
    { id: 'al', name: 'Albania',                language: 'Albanian',          locales: [ 'sq' ],              tlds: [ 'al' ] },
    { id: 'ba', name: 'Bosnia and Herzegovina', language: 'Bosnian, Croatian, Serbian', showCountry: true, locales: [ 'bs' ], tlds: [ 'ba' ] },
    { id: 'bg', name: 'Bulgaria',               language: 'Bulgarian',         locales: [ 'bg' ],              tlds: [ 'bg' ] },
    { id: 'hr', name: 'Croatia',                language: 'Croatian',          locales: [ 'hr' ],              tlds: [ 'hr' ] },
    { id: 'gr', name: 'Greece',                 language: 'Greek',             locales: [ 'el' ],              tlds: [ 'gr' ] },
    { id: 'xk', name: 'Kosovo',                 language: 'Albanian, Serbian', showCountry: true, locales: [ 'sq-xk', 'sr-xk' ], tlds: [] },
    { id: 'me', name: 'Montenegro',             language: 'Montenegrin',       locales: [ 'cnr', 'sr-me' ],    tlds: [] },
    { id: 'mk', name: 'North Macedonia',        language: 'Macedonian',        locales: [ 'mk' ],              tlds: [ 'mk' ] },
    { id: 'ro', name: 'Romania',                language: 'Romanian',          locales: [ 'ro' ],              tlds: [ 'ro' ] },
    { id: 'rs', name: 'Serbia',                 language: 'Serbian',           locales: [ 'sr' ],              tlds: [ 'rs' ] },
    { id: 'si', name: 'Slovenia',               language: 'Slovenian',         locales: [ 'sl' ],              tlds: [ 'si' ] },
]);
const BALTIC_STATES_COUNTRIES = countryTable([
    { id: 'ee', name: 'Estonia',   language: 'Estonian',   locales: [ 'et' ], tlds: [ 'ee' ] },
    { id: 'fi', name: 'Finland',   language: 'Finnish',    locales: [ 'fi' ], tlds: [ 'fi' ] },
    { id: 'lv', name: 'Latvia',    language: 'Latvian',    locales: [ 'lv' ], tlds: [ 'lv' ] },
    { id: 'lt', name: 'Lithuania', language: 'Lithuanian', locales: [ 'lt' ], tlds: [ 'lt' ] },
]);
// (10.4.5) Czech & Slovak and Nordic shown as countries too (explicit request). Sweden joins Nordic (its .se rules
// and AdGuard's Swedish section moved from the hidden "other EU" bucket).
const CZECH_SLOVAK_COUNTRIES = countryTable([
    { id: 'cz', name: 'Czechia',  language: 'Czech',  locales: [ 'cs' ], tlds: [ 'cz' ] },
    { id: 'sk', name: 'Slovakia', language: 'Slovak', locales: [ 'sk' ], tlds: [ 'sk' ] },
]);
const NORDIC_COUNTRIES = countryTable([
    { id: 'dk', name: 'Denmark', language: 'Danish',     locales: [ 'da' ],             tlds: [ 'dk' ] },
    { id: 'is', name: 'Iceland', language: 'Icelandic',  locales: [ 'is' ],             tlds: [ 'is' ] },
    { id: 'no', name: 'Norway',  language: 'Norwegian',  locales: [ 'no', 'nb', 'nn' ], tlds: [ 'no' ] },
    { id: 'se', name: 'Sweden',  language: 'Swedish',    locales: [ 'sv' ],             tlds: [ 'se' ] },
]);
// Derived, never hand-kept: the group's AdGuard Base overflow TLDs and the visible filter's locales.
function tldsOfCountries(countries) { return Object.freeze(countries.flatMap(c => c.tlds)); }
function localesOfCountries(countries) { return [ ...new Set(countries.flatMap(c => c.locales)) ]; }

// hufilter (10.4.5): its AdGuard-syntax sections, without annoyances/cookies/self-promotion (not ad blocking).
const HUFILTER_SECTIONS_BASE_URL = 'https://raw.githubusercontent.com/hufilter/hufilter/master/sections/';
const HUFILTER_SECTION_FILES = Object.freeze([
    'ads.txt', 'antiadblock.txt', 'trackers.txt', 'unbreak.txt', 'security.txt',
    'adguard-specific/ads.txt', 'adguard-specific/antiadblock.txt', 'adguard-specific/unbreak.txt',
]);

export const FILTER_LISTS = [
    {
        // (v9.1.1) — SPLIT per explicit request, from the previous single
        // merged ruleset_kees1958 (Kees1958 + Disconnect + Ghostery
        // combined) into independently-selectable lists, so a
        // filter-list issue can be narrowed down to one specific source
        // instead of only being able to toggle everything together. See
        // tools/build/kees1958-source.mjs's own header for the full
        // "why". (Ghostery later removed entirely; Disconnect later
        // re-merged into one combined list — see CHANGELOG for both —
        // so this is no longer three separate lists, just the history of
        // why Kees1958 is independently selectable at all.)
        id:      'ruleset_kees1958',
        name:    'Kees1958 most-used EU+US ads & tracking networks',
        // 10.0.7: moved from always-on Built-in to a Worry-free opt-in (setting
        // worryFreeKees1958Enabled) — "1-on-1 swap" with the annoyances list. It stays an
        // enabled static ruleset; the Worry-free tier priority + a domain-scoped
        // suppression rule (worry-free-extra-manager.js SCOPED_SUPPRESSION_RULES) make it
        // effective only during a Worry-free session with the toggle on.
        // 10.2.0: downloaded by this build itself (tools/build/kees1958-source.mjs) — one process, refreshed
        // on every full update; was a separate pre-step writing tools/data/kees1958-only-source.txt.
        url:     KEES1958_SOURCE.url,
        customFetch: buildKees1958SourceText,
        priority: WORRY_FREE_EXTRA_LISTS_PRIORITY,
        enabled: true,
    },
    // ruleset_disconnect_ads REMOVED entirely, per explicit request —
    // folded into ruleset_disconnect_other below (Advertising category
    // added there, Analytics dropped, title updated) rather than staying
    // its own separate ruleset. See CHANGELOG for the full history.
    // ── Worry-free-gated items (3 since 10.7.1) — per explicit correction: these stay
    // part of the Worry-free session mechanism, NOT default/always-on
    // filters. Each gets its OWN independently-scoped suppression rule
    // (see js/core/worry-free-extra-manager.js's SUPPRESSION_RULES) —
    // condition.requestDomains matching exactly this ruleset's own domain
    // list, not the old unconditional condition:{} shape — specifically
    // so toggling one of these off can never silently suppress a sibling
    // item too (the exact bug class that caused the original six-
    // checkboxes-to-two consolidation; see config.js's own header on
    // worryFreeBlocklistEnabled for that history). priority:
    // WORRY_FREE_EXTRA_LISTS_PRIORITY (below) — already stale even before
    // the AdShield Evolution rename pass (the 9.9.1 ladder moved this
    // ruleset's actual priority here; this comment referenced an older
    // scheme), and the two now-retired rulesets it used to compare
    // against (ruleset_worryfree_extra/_social) were removed back in
    // v9.1.7 — fixing the dangling reference while touching this area.
    // ruleset_disconnect_other (Disconnect Cryptomining + Fingerprinting) REMOVED (10.7.1), owner's
    // decision: its categories mix real fingerprinters with sign-in/payment/captcha code. Module
    // tools/build/disconnect-source.mjs removed with it.
    {
        id:      'ruleset_adguard_tracking_servers',
        name:    'AdGuard tracking servers',
        customFetch: () => buildWorryFreeLists(ADGUARD_TRACKING_SERVERS_SOURCE),
        priority: WORRY_FREE_EXTRA_LISTS_PRIORITY,
        enabled: true,
    },
    // Peter Lowe's list — restored 10.1.1 as a Worry-free opt-in (worryFreePeterloweEnabled), same
    // mechanism as AdGuard tracking servers above: suppression-only, never toggled through
    // setRulesetEnabled(). Retired in 10.0.7 as redundant with HaGeZi Multi light, restored on request.
    {
        id:      'ruleset_peterlowe',
        name:    'Peter Lowe advertising & tracking servers',
        customFetch: () => buildWorryFreeLists(PETERLOWE_SOURCE),
        priority: WORRY_FREE_EXTRA_LISTS_PRIORITY,
        enabled: true,
    },
    // Badfilter quick-fixes (personal $badfilter list) — every line
    // compiled here is expected to carry $badfilter; each becomes an
    // ALLOW rule at BADFILTER_QUICKFIXES_PRIORITY instead of the usual
    // block/no-op handling — see parseBlockRule()'s own comment for the
    // full case-1-vs-case-2 reasoning, and dnr-budgets.js's
    // BADFILTER_QUICKFIXES_PRIORITY comment for why this exact priority
    // ("just above ABP-Import", explicit request) was chosen. Currently
    // empty upstream (placeholder, "Expires: 7 days") — an empty source
    // compiles to zero DNR rules, which is fine, not an error; this entry
    // exists so the mechanism is live and ready the moment the list gets
    // real content, without needing another build-script change then.
    {
        id:      'ruleset_badfilter_quickfixes',
        // (11.0.0, owner) "Bad filter fixes" — was "Badfilter quick fixes": an update depends on the Chrome Web Store
        // review, so it is not quick. Display name only; the ruleset id stays (a contract).
        name:    'Bad filter fixes',
        url:     'https://raw.githubusercontent.com/Kees1958/W3C_annual_most_used_survey_blocklist/refs/heads/master/badfilter-quick-fixes.txt',
        priority: BADFILTER_QUICKFIXES_PRIORITY,
        convertBadfilterToAllow: true,
        badfilterPriority: BADFILTER_QUICKFIXES_PRIORITY,
        // 10.1.8: hand-written list — a line the build cannot use is dropped AND reported (dropped-unsupported-list-lines.txt).
        reportUnsupportedLines: true,
        // 10.2.0: its "@@domain$worryfree" / "@@domain$saferegions" lines ship as carrier allow rules INSIDE
        // this ruleset (js/core/builtin-exemption-carriers.js) instead of a generated JS module — so adding one
        // is a SAFE (skip-review) update like any other line of this list.
        emitExemptionCarriers: true,
        enabled: true,
    },
    // AdGuard and EasyList annoyances (9.9.0; always-on Built-in default since 10.0.7). Seven
    // upstream sources merged into one, gated (top-1M sites) and de-duplicated by
    // buildAnnoyancesSourceText() (tools/build/annoyances-sources.mjs has the full reasoning).
    // 10.0.7: no priority override (falls back to STATIC_FILTER_LIST_PRIORITY), listed in
    // ALWAYS_ON_RULESETS (scripting-manager.js) — the old Worry-free session gating of its
    // hide rules/scriptlets and its suppression rule are RETIRED.
    {
        id:      'ruleset_annoyances',
        name:    'AdGuard and EasyList annoyances (specific websites only)',
        // 10.5.1 (owner's decision): also carries every top-25 adult-site rule (ex hidden ruleset_adguard_base_adult,
        // removed) plus HaGeZi light's hosts on those sites — see tools/build/adult-site-rules.mjs. Appended AFTER
        // the annoyances gates on purpose: those rules are path-only / site-scoped and the gates would drop them.
        customFetch: async () => [ await buildAnnoyancesSourceText(), await buildTop25AdultSiteRulesText() ].join('\n'),
        enabled: true,
    },
    // HaGeZi's Multi LIGHT (v9.7.3) — RESTORED, this time as a normal,
    // always-on DEFAULT filter list (Filter (block) lists tab, enabled
    // out of the box, user can untick it), per explicit request after
    // testing showed it to be very effective.
    //
    // History, so nobody mistakes this for the old arrangement: it first
    // shipped in 8.4.5 as a 5th source merged into the Worry-free "extra
    // blocklist" (Worry-free-gated, TLD-scoped, WORRY_FREE_EXTRA_BLOCKLIST_
    // PRIORITY) — that whole blocklist was retired in 9.1.7. THIS entry
    // keeps the old TLD scoping but is otherwise not that arrangement:
    //   - NOT Worry-free-gated: no suppression rule, no worryFree*Enabled
    //     setting. It is an ordinary static ruleset toggled through
    //     STATIC_RULESET_IDS / setRulesetEnabled(), exactly like
    //     ruleset_antiadmiral and ruleset_adguard_base.
    //   - NOT at the Worry-free tier's priority: no `priority` field, so it
    //     ships at STATIC_FILTER_LIST_PRIORITY like every other default
    //     list, and is beaten by the same allow rules (AdGuard Base
    //     exceptions, Allow (white) list, site-mode OFF) as they are.
    //   - SCOPE (10.0.7): the TLD jurisdiction scoping this entry used to have
    //     was REMOVED entirely, per explicit request. It still goes through
    //     buildWorryFreeLists() (C21 — the proven fetch/dedup/coalesce
    //     mechanism its sibling list ruleset_adguard_tracking_servers uses),
    //     but worryFreeInScope() now only drops IP literals.
    //
    // Format: `||domain^` for every entry (verified against the real
    // file: the only other lines are the `[Adblock Plus]` header and `!`
    // comments), so buildWorryFreeLists()' simple-rule extraction accepts
    // every line. The shared hostname coalescing step in parseList()
    // (CHUNK_SIZE = 4000 domains per requestDomains rule) then turns the
    // in-scope domains into a handful of DNR rules (8 at the time of
    // writing) instead of ~31,650 — this is the "batches of 4000"
    // mechanism, not a new one. fetchList() supplies the fetch guard
    // (non-2xx, <20 bytes, not filter-list-shaped => build aborts).
    // skipCosmetic: pure network list, no cosmetic content to parse.
    // SOURCE (10.5.5, owner's decision): HaGeZi's own Multi light, narrowed to the entries
    // Tracker Radar, the CrUX top sites, the top-25 adult sites or HTTP Archive vouch for —
    // tools/build/hagezi-light-selection.mjs (replaces Chris Buijs' TOP-N version, 10.5.2–10.5.4).
    // The ruleset id is unchanged so a user's stored on/off choice for this row carries over.
    {
        id:      'ruleset_hagezi_light',
        name:    "HaGeZi's Multi light (known trackers on top-N sites)",
        customFetch: buildSelectedHageziLightText,
        // (11.0.0, owner's decision) A Seamless surfing tracker list now, like Kees1958 / Peter Lowe / AdGuard tracking:
        // their priority, suppressed outside a session or when worryFreeHageziEnabled is off. MUST stay before
        // ruleset_tracking_servers_allowlist, which reads this list's written file as one of its parents.
        priority: WORRY_FREE_EXTRA_LISTS_PRIORITY,
        enabled: true,
        skipCosmetic: true,  // Pure hostname-block list — no cosmetic content.
    },
    // (10.7.1, owner's decision) Hidden, always-on AdGuard exceptions for the four Seamless surfing tracker lists (11.0.0: + HaGeZi Light, directly above)
    // (tools/build/tracking-allowlist-source.mjs). MUST stay after ruleset_kees1958, ruleset_adguard_tracking_servers
    // and ruleset_peterlowe: it reads their freshly written files. No dashboard row (not in DEFAULT_FILTER_IDS, no
    // language-filter category), no Worry-free gating: outside a session the three lists are already suppressed, so
    // these allows only matter while they block. Same site gates as anti-adblock: in-scope TLDs (parseList, every
    // list) AND CrUX top-1M sites. Priority: see WORRY_FREE_EXTRA_LISTS_ALLOWLIST_PRIORITY.
    {
        id:      'ruleset_tracking_servers_allowlist',
        name:    'AdGuard tracking-server exceptions (hidden)',
        url:     TRACKING_ALLOWLIST_SOURCE.url,
        customFetch: buildTrackingAllowlistSourceText,
        priority: WORRY_FREE_EXTRA_LISTS_ALLOWLIST_PRIORITY,
        enabled: true,
        popularityFilter: true,
    },
    {
        id:      'ruleset_adguard_base',
        name:    'AdGuard Base (block advertising) filter',
        // RESTORED to the real, official AdGuard source (per explicit
        // instruction — "use this one again"), after the person-
        // maintained "Optimized" mirror (base_optimized.txt) started
        // 404ing (verified thoroughly — see git history/CHANGELOG for
        // that investigation). CHANGELOG's 8.4.5 entry confirms this
        // project used "the raw editorial GitHub source" before ever
        // switching to that mirror — this restores that original
        // approach, not a new one.
        //
        // AdguardTeam/AdguardFilters' BaseFilter/sections/ directory
        // (the real upstream source AdGuard's own FiltersRegistry
        // compiles "AdGuard Base filter" from) is split into 14 files by
        // purpose, not shipped pre-combined. Fetches and concatenates
        // 11 of them — each through fetchList()'s own existing fetch/
        // validate guard, not a bespoke check — with clear section
        // banners between them so a human reading the combined text can
        // still tell which section a rule came from:
        //   adservers / adservers_firstparty — third-party ad-network
        //     domain blocks (bare + first-party variants)
        //   allowlist / allowlist_stealth — exception rules (needed for
        //     correctness; the "stealth" variant covers stealth-mode-
        //     specific exceptions)
        //   antiadblock — (MOVED 2026-11-09 to ruleset_adguard_antiadblock, owner's decision; the note below is
        //     kept as history) anti-adblock-detection circumvention rules;
        //     confirmed via AdGuard's own KnowledgeBase/wiki docs to be
        //     genuinely part of Base Filter's real intended scope, not
        //     a duplicate of this project's separate "Bypass anti-
        //     adblock walls" list (that one targets the GetAdmiral
        //     ad-recovery network specifically, a narrower, different
        //     thing — any incidental rule overlap between the two is
        //     harmlessly deduplicated by this script's own coalescing
        //     logic either way)
        //   banner_sizes — ad-banner-dimension URL patterns
        //   cryptominers — cryptomining-script blocking
        //   general_elemhide / general_extensions / general_url —
        //     generic (not site-specific) cosmetic-hide and URL-pattern
        //     rules
        //   specific — the large per-site rule set (site-specific
        //     cosmetic/network rules)
        //
        // Deliberately EXCLUDED (5 of 14 — up from 3, this release):
        //   allowlist_stealth — stealth-mode-specific exception rules.
        //     Stealth mode is a distinct AdGuard-extension-specific
        //     feature this project doesn't implement, so its exceptions
        //     have nothing to except against — dropped per explicit
        //     request.
        //   general_elemhide — generic (non-domain-specific) cosmetic-
        //     hide rules — dropped per explicit request.
        //   banner_sizes — ad-banner-dimension URL patterns — dropped per
        //     explicit request.
        //   content_blocker.txt — iOS/Safari native content-blocker
        //     JSON format, not applicable to a Chrome MV3 DNR-based
        //     extension.
        //   replace.txt — $replace (response-body modification) rules;
        //     Chrome's declarativeNetRequest API has no equivalent
        //     action type in MV3 at all, so these could never apply
        //     here regardless of format.
        //
        // foreign.txt is now INCLUDED (previously excluded — see
        // CHANGELOG for the prior reasoning, superseded this release):
        // routed by language via extractForeignRulesSections(), not
        // dropped wholesale. See that function's own header for the
        // full routing table.
        //
        // general_url.txt is fetched SEPARATELY from the rest (not part
        // of the SECTIONS loop below) because it needs its own pre-pass —
        // extractAdultSiteRules() pulls out any block whose comment
        // header names one of the known adult sites (see
        // ADULT_SITE_NAME_ALIASES); since 10.5.1 those blocks ship,
        // $domain=-scoped, in ruleset_annoyances. Everything else in
        // general_url.txt (including generic porn/adult-related blocks
        // with no specific site named) is unaffected and stays inline.
        customFetch: async ( ) => {
            const BASE_URL = 'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/BaseFilter/sections/';
            const SECTIONS = [
                [ 'adservers', 'Ad-network domain blocks' ],
                [ 'adservers_firstparty', 'First-party ad-network domain blocks' ],
                [ 'allowlist', 'Allowlist / exception rules' ],
                // (owner's decision, 2026-11-09) 'antiadblock' MOVED to ruleset_adguard_antiadblock (see that
                // entry's url list) so anti-adblock keeps working when AdGuard Base is switched off. Moved, not
                // copied: with both lists on, no rule is loaded twice.
                [ 'cryptominers', 'Cryptomining-script blocking' ],
                [ 'general_extensions', 'Generic extension/procedural rules' ],
                [ 'specific', 'Site-specific rules' ],
                [ 'foreign', 'Foreign rules' ],
            ];
            const parts = [];
            for ( const [ file, label ] of SECTIONS ) {
                const text = await fetchList(`${BASE_URL}${file}.txt`);
                parts.push(`!------------------ ${label} ------------------!`, text);
            }

            // general_url.txt — fetched, top-25 adult-site blocks pulled out. 10.5.1: those blocks ship in
            // ruleset_annoyances (adult-site-rules.mjs runs the same pure extractAdultSiteRules() on the same
            // file); here they are only REMOVED, so nothing ships twice.
            const { remainingText } = extractAdultSiteRules(await fetchList(AGBASE_GENERAL_URL_SOURCE), topAdultSiteDomains());
            parts.push('!------------------ Generic URL-pattern rules ------------------!', remainingText);

            let combined = parts.join('\n');

            // foreign.txt routing (point 8) — pulls Belgian + kept-
            // language content out into module-level state for the
            // sibling FILTER_LISTS entries below to pick up, and returns
            // the main text with the whole Foreign rules section either
            // removed (blacklisted languages) or spliced back in place
            // ('Fixing other filters' only).
            const { text: routedText, belgianText, bucketText } = extractForeignRulesSections(combined);
            setAgBaseBelgianText(belgianText);
            setAgBaseLanguageBucketText(bucketText);
            // (2026-11-09, owner's decision) Rules for English-speaking-country sites outside the CrUX top 1M move
            // to ruleset_english_outside_top1m (english-outside-top-sites.mjs) — moved, not copied.
            const english = splitBaseEnglish(routedText);
            setAgBaseEnglishText(english.english);
            return english.keep;
        },
        // 10.0.7: AdGuard's own $removeparam-derived rules (redirect action — unsafe for
        // Chrome Web Store skip-review) are SPLIT OUT again into the companion list
        // ruleset_adguard_base_removeparam ("AdGuard remove tracking parameters"), which
        // replaces the retired ruleset_kees1958_tracking 1-for-1 (explicit request). It is a
        // Worry-free opt-in (worryFreeAdguardRemoveparamEnabled) at
        // WORRY_FREE_ADGUARD_REMOVEPARAM_PRIORITY, suppressed through the no-tier
        // suppression shape (worry-free-extra-manager.js). The unsafe-rule split still keeps
        // these rules OUT of the main list, so the skip-review protection is unchanged.
        // (10.2.0) Unsafe rules always go to the companion declared in js/data/ruleset-companions.js. (10.7.6) Two
        // for this list: $removeparam -> ruleset_adguard_base_removeparam (REMOVEPARAM_COMPANIONS, own toggle) at the
        // priority below; every other unsafe rule ($redirect to a bundled file) -> ruleset_adguard_base_unsafe
        // (UNSAFE_RULE_COMPANIONS), toggled with this list, at its normal priority.
        removeparamCompanionPriority: WORRY_FREE_ADGUARD_REMOVEPARAM_PRIORITY,
        enabled: true,
        // 10.4.5: the geographic scope (GEO_SCOPE in tld-scope.mjs) applies to EVERY list inside parseList(),
        // so the former AdGuard-Base-only options tldCheckFn/networkTldGate are gone.
        allowGenericDomainQualifier: true,
        // Extract per-country-TLD content into hidden "overflow" rulesets
        // (see extractCountryOverflow() below) instead of shipping it to
        // every AdGuard Base user regardless of whether they need it.
        // Each bucket lists every TLD it owns — some buckets own several
        // TLDs because the corresponding dedicated filter is itself
        // language-scoped, not TLD-scoped (verified empirically: AdGuard's
        // German filter already contains .de/.at/.ch hostnames, French
        // already contains .fr/.be/.ch, Dutch already contains .nl/.be,
        // Dandelion Sprout's "Nordic" filter contains .no/.dk/.is but NOT
        // .se/.fi). A TLD is only ever listed in ONE bucket below — where a
        // TLD's coverage was ambiguous between two dedicated filters (.ch
        // between German/French; .be left unclaimed entirely — see below)
        // the choice was made by which filter's own measured coverage of
        // that TLD was larger, not guessed.
        //
        // 'be' (the TLD, i.e. actual .be-hostname content found anywhere in
        // AG Base's main sections) is still deliberately NOT routed
        // anywhere here: genuinely split between Dutch (Flemish) and
        // French (Walloon) with no single unambiguous TLD-level owner.
        // This is a SEPARATE question from foreign.txt's "Belgian"
        // language subsection (point 8) — that one IS routed as one whole
        // block (agBaseBelgianText, duplicated into Dutch AND French as
        // of 10.0.6 — see those two entries below), because a whole
        // labeled subsection can be moved together even though individual
        // .be hostnames scattered through the rest of AG Base still can't
        // be split the same way.
        countryOverflow: [
            { tlds: [ 'nl' ],             id: 'ruleset_agbase_overflow_dutch',
              name: 'AdGuard Base — Dutch overflow (hidden; auto-enabled with AdGuard Dutch)',
              locales: [] },
            { tlds: [ 'de', 'at', 'ch' ], id: 'ruleset_agbase_overflow_german',
              name: 'AdGuard Base — German overflow (hidden; auto-enabled with AdGuard German)',
              locales: [] },
            { tlds: [ 'fr' ],             id: 'ruleset_agbase_overflow_french',
              name: 'AdGuard Base — French overflow (hidden; auto-enabled with AdGuard French)',
              locales: [] },
            { tlds: [ 'es' ],             id: 'ruleset_agbase_overflow_spanish',
              name: 'AdGuard Base — Spanish overflow (hidden; auto-enabled with AdGuard Spanish)',
              locales: [] },
            { tlds: [ 'it' ],             id: 'ruleset_agbase_overflow_italian',
              name: 'AdGuard Base — Italian overflow (hidden; auto-enabled with EasyList Italian)',
              locales: [] },
            { tlds: [ 'pl' ],             id: 'ruleset_agbase_overflow_polish',
              name: 'AdGuard Base — Polish overflow (hidden; auto-enabled with EasyList Polish)',
              locales: [] },
            { tlds: [ 'pt' ],             id: 'ruleset_agbase_overflow_portuguese',
              name: 'AdGuard Base — Portuguese overflow (hidden; auto-enabled with EasyList Portuguese)',
              locales: [] },
            // (10.4.5) Baltic states filter's AdGuard Base part (id kept from the Latvian filter — storage key).
            { tlds: tldsOfCountries(BALTIC_STATES_COUNTRIES), id: 'ruleset_agbase_overflow_latvian',
              name: 'AdGuard Base — Baltic states overflow (hidden; auto-enabled with Baltic states filter)',
              locales: [] },
            { tlds: tldsOfCountries(CZECH_SLOVAK_COUNTRIES), id: 'ruleset_agbase_overflow_czech_slovak',
              name: 'AdGuard Base — Czech & Slovak overflow (hidden; auto-enabled with EasyList Czech & Slovak)',
              locales: [] },
            // (10.4.5) Balkan filter's AdGuard Base part (id kept from the Bulgarian filter — storage key).
            // Montenegro's .me is NOT listed: it is used worldwide as a generic TLD, so its sites stay in Base.
            { tlds: tldsOfCountries(BALKAN_COUNTRIES), id: 'ruleset_agbase_overflow_bulgarian',
              name: 'AdGuard Base — Balkan overflow (hidden; auto-enabled with Balkan filter)',
              locales: [] },
            { tlds: tldsOfCountries(NORDIC_COUNTRIES), id: 'ruleset_agbase_overflow_nordic',
              name: 'AdGuard Base — Nordic overflow (hidden; auto-enabled with Nordic Filters)',
              locales: [] },
            // (10.4.5) Hungarian filter's AdGuard Base part.
            { tlds: [ 'hu' ],             id: 'ruleset_agbase_overflow_hungarian',
              name: 'AdGuard Base — Hungarian overflow (hidden; auto-enabled with Hungarian filter)',
              locales: [] },
            // Extended-EU countries with no dedicated filter of their own —
            // auto-enabled only via detected browser locale, no visible
            // companion filter to piggyback on (see enableLocaleLanguageFilter()
            // in js/workflow/background.js).
            // (10.4.5) hr/gr/ro/si moved to the Balkan bucket, ee/fi to Baltic states, hu to Hungarian, se to Nordic.
            { tlds: [ 'cy', 'lu', 'mt' ],
              id: 'ruleset_agbase_overflow_other',
              name: 'AdGuard Base — Other extended-EU overflow (hidden; auto-enabled by detected browser locale)',
              // el for Cyprus.
              locales: ['el', 'lb', 'mt'] },
        ],
        // Drop core cosmetic hostname entries (i.e. whatever's left in
        // AG Base's always-on core AFTER countryOverflow above has already
        // pulled out the per-country buckets) that don't appear anywhere in
        // the CrUX top-1M site-popularity snapshot — see
        // filterCosmeticMapByPopularity() below for the "why": AG Base's
        // own TLD gate (KEEP_TLDS) can't distinguish a top-1000 site from
        // an obscure one on the same generic .com/.io/etc TLD, so a large
        // share of the always-on core is long-tail sites most users will
        // never visit. Deliberately does NOT touch: DNR/network rules
        // (Chrome's declarativeNetRequest engine handles rule *count*
        // efficiently regardless of size — the size cost that actually
        // matters is the cosmetic layer's per-hostname JS map), or the
        // countryOverflow buckets above (already opt-in/hidden by default,
        // so they cost nothing until a user explicitly enables one — and
        // global popularity is a poor fit for content a user already
        // opted into for a specific country/language anyway).
        // Deliberately deletes rather than moving to yet another overflow
        // bucket — a conscious inconsistency with countryOverflow's
        // never-delete philosophy, accepted for simplicity/size.
        //
        // REMOVED this release, per explicit request (point 0) — no
        // longer trims cosmetic entries by CrUX top-1M membership at all.
        // Long-tail-site cosmetic coverage is fully restored; the CrUX
        // fetch (~9MB) no longer happens for any list, since this was its
        // only consumer (see build()'s own guard on fetchTopSitesSet()).
    },
    // ── AdGuard Belgian filter (new, point 8) ───────────────────────────────
    // ruleset_adguard_belgian REMOVED (10.0.6, per explicit request).
    // Was: a standalone opt-in filter sourced from AdGuard Base's own
    // "Belgian" foreign.txt subsection (see extractForeignRulesSections()).
    // That subsection has no per-rule marker distinguishing Flemish vs
    // Walloon content, so rather than guess, its content is now
    // DUPLICATED whole into BOTH ruleset_adguard_dutch and
    // ruleset_adguard_french (see each entry's own customFetch, below) —
    // every Belgian rule applies under both language filters, not split.
    // The one entry confirmed NOT genuinely Belgian (a mislabeled
    // Bulgarian dir.bg rule — see extractForeignRulesSections()'s own
    // comment) is dropped before either filter sees it.
    // ruleset_adguard_base_adult (hidden, always-on adult-site rules) + its _unsafe companion REMOVED (10.5.1,
    // owner's decision): every rule now ships in ruleset_annoyances — see tools/build/adult-site-rules.mjs.
    // ── AdGuard language filters ────────────────────────────────────────────
    {
        id:      'ruleset_adguard_dutch',
        name:    'Dutch filter (AdGuard & EasyList)',
        // (10.4.5) dashboard label: "Dutch language" (owner's decision: languages, no source names).
        language: 'Dutch',
        // url kept for display (rulesetDetails' sourceUrl) even though
        // customFetch below does the actual fetching — same convention
        // ruleset_adguard_belgian used to follow.
        url:     'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_8_Dutch/filter.txt',
        // 10.0.6: appends the ex-Belgian-filter content (see this file's
        // own comment above where ruleset_adguard_belgian used to be) —
        // duplicated into German below too, since Belgium has both a
        // Flemish and Walloon audience and the source text itself can't
        // tell them apart. MUST run after ruleset_adguard_base, since
        // agBaseBelgianText is a side effect of that list's own fetch.
        // 10.0.6: also appends antiadblockfilters' own Dutch anti-adblock
        // file (github.com/easylist/antiadblockfilters) — confirmed real,
        // same per-language-file family as ruleset_adguard_antiadblock's
        // own English addition.
        customFetch: async () => {
            const text = await fetchList('https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_8_Dutch/filter.txt');
            const parts = [ text ];
            if ( agBaseBelgianText ) { parts.push(`!------------------ Belgian (ex-ruleset_adguard_belgian, duplicated into Dutch+French) ------------------!`, agBaseBelgianText); }
            parts.push(`!------------------ Anti-adblock (Dutch) ------------------!`, await fetchList('https://raw.githubusercontent.com/easylist/antiadblockfilters/master/antiadblockfilters/antiadblock_dutch.txt'));
            return parts.join('\n');
        },
        category: 'language-filter',
        locales: ['nl'],
        enabled: false,
    },
    {
        id:      'ruleset_adguard_german',
        name:    'German filter (AdGuard & EasyList)',
        // (10.4.5) dashboard label: "German language" (owner's decision: languages, no source names).
        language: 'German',
        url: [
            'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_6_German/filter.txt',
            // Confirmed real (10.0.6) — same antiadblockfilters family.
            'https://raw.githubusercontent.com/easylist/antiadblockfilters/master/antiadblockfilters/antiadblock_german.txt',
        ],
        category: 'language-filter',
        locales: ['de'],
        enabled: false,
    },
    {
        id:      'ruleset_adguard_french',
        name:    'French filter (AdGuard & EasyList)',
        // (10.4.5) dashboard label: "French language" (owner's decision: languages, no source names).
        language: 'French',
        url:     'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_16_French/filter.txt',
        // 10.0.6: see ruleset_adguard_dutch's own identical comment —
        // same Belgian content, duplicated here too, not split — plus
        // antiadblockfilters' own French anti-adblock file.
        customFetch: async () => {
            const text = await fetchList('https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_16_French/filter.txt');
            const parts = [ text ];
            if ( agBaseBelgianText ) { parts.push(`!------------------ Belgian (ex-ruleset_adguard_belgian, duplicated into Dutch+French) ------------------!`, agBaseBelgianText); }
            parts.push(`!------------------ Anti-adblock (French) ------------------!`, await fetchList('https://raw.githubusercontent.com/easylist/antiadblockfilters/master/antiadblockfilters/antiadblock_french.txt'));
            return parts.join('\n');
        },
        category: 'language-filter',
        locales: ['fr'],
        enabled: false,
        // (10.2.0) unsafe rules -> ruleset_adguard_french_removeparam (js/data/ruleset-companions.js)
    },
    {
        id:      'ruleset_adguard_spanish',
        name:    'Spanish filter (AdGuard)',
        // (10.4.5) dashboard label: "Spanish language" (owner's decision: languages, no source names).
        language: 'Spanish',
        // antiadblockfilters/antiadblock_spanish.txt exists as a file but
        // is genuinely EMPTY (0 bytes, confirmed via live fetch, not a
        // transient error) — NOT added (10.0.6). Adding an empty-file URL
        // to the array would fail this list's ENTIRE build (Promise.all
        // rejects on any one empty/failed fetch) and silently fall back
        // to stale carried-over content for everything, not just a no-op.
        // 10.0.7: rebuilt from AdGuard's REAL SpanishFilter/sections/ files (the old build used a single
        // stale mirror). Same 7 inclusions AdGuard Base itself uses; general_elemhide and replace are
        // excluded for the same reasons as there. `url` kept for display (rulesetDetails' sourceUrl).
        url:     'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_9_Spanish/filter.txt',
        customFetch: async () => {
            const sections = {};
            const parts = [];
            for ( const file of SPANISH_SECTION_FILES ) {
                sections[file] = await fetchList(`${SPANISH_SECTIONS_BASE_URL}${file}.txt`);
                parts.push(`!------------------ ${file} ------------------!`, sections[file]);
            }
            // Hand-off to ruleset_easylist_portuguese (MUST run after this entry — array order):
            // the generic sections + every Portuguese-speaking-country-TLD line.
            setAgSpanishGenericText(extractSpanishGenericAndLusophone(sections));
            return parts.join('\n');
        },
        category: 'language-filter',
        locales: ['es'],
        enabled: false,
    },
    // ── EasyList language filters ───────────────────────────────────────────
    {
        id:      'ruleset_easylist_italian',
        name:    'Italian filter (EasyList)',
        // (10.4.5) dashboard label: "Italian language" (owner's decision: languages, no source names).
        language: 'Italian',
        // antiadblockfilters/antiadblock_italian.txt exists but is
        // genuinely EMPTY (0 bytes, confirmed via live fetch) — NOT added
        // (10.0.6). See ruleset_adguard_spanish's identical comment for why.
        // 10.0.7: rebuilt from EasyList Italian's REAL 7 relevant sub-files, same selection as
        // ruleset_easylist_portuguese — the old build used only easylistitaly_adservers.txt alone
        // (the same single-stale-file bug Spanish/Portuguese had before their own 10.0.7 rebuild).
        url:     'https://raw.githubusercontent.com/easylist/easylistitaly/master/easylistitaly/easylistitaly_adservers.txt',
        customFetch: async () => {
            const parts = [];
            for ( const file of ITALIAN_SECTION_FILES ) {
                parts.push(`!------------------ ${file} ------------------!`, await fetchList(`${ITALIAN_SECTIONS_BASE_URL}${file}.txt`));
            }
            return parts.join('\n');
        },
        category: 'language-filter',
        locales: ['it'],
        enabled: false,
    },
    {
        id:      'ruleset_easylist_polish',
        name:    'Polish filter (MajkiIT)',
        // (10.4.5) dashboard label: "Polish language" (owner's decision: languages, no source names).
        language: 'Polish',
        // No matching antiadblockfilters/antiadblock_polish.txt found —
        // not added (10.0.6). See ruleset_adguard_antiadblock's own
        // comment for the confirmed full file list.
        url:     'https://raw.githubusercontent.com/MajkiIT/polish-ads-filter/master/polish-adblock-filters/adblock.txt',
        category: 'language-filter',
        locales: ['pl'],
        enabled: false,
    },
    {
        id:      'ruleset_easylist_portuguese',
        name:    'Portuguese filter (EasyList & AdGuard)',
        // (10.4.5) dashboard label: "Portuguese language" (owner's decision: languages, no source names).
        language: 'Portuguese',
        // No matching antiadblockfilters file found — not added (10.0.6).
        // 10.0.7: rebuilt from EasyList Portuguese's REAL 7 relevant sub-files (the old build used one
        // near-empty mirror file), then appends AdGuard Spanish's generic + Portuguese-speaking-TLD
        // content (agSpanishGenericText, a side effect of ruleset_adguard_spanish's fetch above).
        url:     'https://raw.githubusercontent.com/easylist/easylistportuguese/master/easylistportuguese/easylistportuguese_general_block.txt',
        customFetch: async () => {
            const parts = [];
            for ( const file of PORTUGUESE_SECTION_FILES ) {
                parts.push(`!------------------ ${file} ------------------!`, await fetchList(`${PORTUGUESE_SECTIONS_BASE_URL}${file}.txt`));
            }
            if ( agSpanishGenericText ) {
                parts.push('!------------------ AdGuard Spanish generic + Portuguese-speaking TLDs ------------------!', agSpanishGenericText);
            }
            return parts.join('\n');
        },
        category: 'language-filter',
        locales: ['pt'],
        enabled: false,
    },
    {
        // (10.4.5) Became the BALTIC STATES filter (owner's decision): Estonia, Finland, Latvia, Lithuania in one
        // stored ruleset, shown as separate countries (BALTIC_STATES_COUNTRIES). The id stays (storage key); the
        // retired ruleset_easylist_lithuanian (10.4.5) lives on here; its stored choice is no longer carried over (10.5.0).
        id:      'ruleset_easylist_latvian',
        name:    'Baltic states filter',
        // antiadblockfilters/antiadblock_latvian.txt exists but is
        // genuinely EMPTY (0 bytes, confirmed via live fetch) — NOT added
        // (10.0.6). See ruleset_adguard_spanish's identical comment for why.
        url: [
            'https://raw.githubusercontent.com/Latvian-List/adblock-latvian/master/lists/latvian-list.txt',
            // (10.4.5) from the retired Lithuanian filter. No matching antiadblockfilters file exists (10.0.6).
            'https://raw.githubusercontent.com/EasyList-Lithuania/easylist_lithuania/master/easylistlithuania.txt',
            // (10.4.5, explicit request) Finland
            'https://raw.githubusercontent.com/finnish-easylist-addition/finnish-easylist-addition/master/Finland_adb.txt',
        ],
        category: 'language-filter',
        countries: BALTIC_STATES_COUNTRIES,
        locales: localesOfCountries(BALTIC_STATES_COUNTRIES),
        enabled: false,
    },
    {
        // (10.4.5, explicit request) hufilter (github.com/hufilter/hufilter, CC BY 4.0), its AdGuard-syntax build
        // without annoyances/cookie banners/self-promotion (those are not ad blocking), plus AdGuard Base's
        // Hungarian section and .hu site rules through its hidden companion ruleset_agbase_overflow_hungarian.
        id:      'ruleset_hungarian',
        name:    'Hungarian filter (hufilter & AdGuard)',
        // (10.4.5) dashboard label: "Hungarian language" (owner's decision: languages, no source names).
        language: 'Hungarian',
        url:     HUFILTER_SECTION_FILES.map(f => `${HUFILTER_SECTIONS_BASE_URL}${f}`),
        category: 'language-filter',
        locales: ['hu'],
        enabled: false,
    },
    {
        id:      'ruleset_easylist_czech_slovak',
        name:    'Czech & Slovak filter (EasyList)',
        // antiadblockfilters/antiadblock_czech.txt AND antiadblock_slovak.txt
        // both exist as files but are genuinely EMPTY (0 bytes, confirmed
        // via live fetch) — NOT added (10.0.6). See ruleset_adguard_
        // spanish's identical comment for why an empty-file URL isn't safe
        // to add even as a harmless no-op.
        url:     'https://raw.githubusercontent.com/tomasko126/easylistczechandslovak/master/filters.txt',
        category: 'language-filter',
        // (10.4.5) shown as Czechia and Slovakia (CZECH_SLOVAK_COUNTRIES).
        countries: CZECH_SLOVAK_COUNTRIES,
        locales: localesOfCountries(CZECH_SLOVAK_COUNTRIES),
        enabled: false,
    },
    {
        id:      'ruleset_easylist_nordic',
        name:    'Nordic filter (Dandelion Sprout)',
        // antiadblockfilters has a Finnish file, but this project's
        // Nordic filter covers no/dk/is, not fi (see its locales below
        // and ruleset_agbase_overflow_other's own comment on why) — not a
        // real match, so not added (10.0.6).
        url:     'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/NorwegianList.txt',
        category: 'language-filter',
        // (10.4.5) shown as Denmark, Iceland, Norway and Sweden (NORDIC_COUNTRIES); Finland moved to the Baltic
        // states filter. Sweden's .se rules and AdGuard's Swedish section now come with it.
        countries: NORDIC_COUNTRIES,
        locales: localesOfCountries(NORDIC_COUNTRIES),
        enabled: false,
    },
    {
        // id kept stable (10.0.6 — combined two sources into one, per
        // explicit request) — renaming it would silently orphan any
        // user's existing enabled/disabled choice for this filter, since
        // ruleset ids are the storage key for that setting.
        // (10.4.5) Became the BALKAN filter (owner's decision): one stored ruleset, shown in the dashboard as
        // separate countries (BALKAN_COUNTRIES, each with its own sources). The id stays (storage key).
        id:      'ruleset_easylist_bulgarian',
        name:    'Balkan filter',
        // Two sources combined (array url — fetched in parallel, joined
        // with '\n', same existing mechanism buildWorryFreeLists' own
        // extraUrl pattern and this array-url branch in build-steps.mjs
        // already provide; no new code needed). Measured before
        // combining: the community list is ~830 real rule lines, 7x
        // larger than AdGuard's own ~121 — AdGuard's is smaller but
        // actively issue-tracked (every rule traces to a real AdguardFilters
        // GitHub issue). Combining keeps both rather than picking a winner.
        url: [
            'https://raw.githubusercontent.com/KokichaKolevTM/BG-Adblock-list/main/BG-Adblock-list.txt',
            'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/CyrillicFilters/Bulgarian/sections/filter.txt',
            // (10.4.5) Serbia, Croatia, Bosnia and Herzegovina, Montenegro
            'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/SerboCroatianList.txt',
            // (10.4.5) North Macedonia
            'https://raw.githubusercontent.com/DeepSpaceHarbor/Macedonian-adBlock-Filters/master/Filters',
            // (10.4.5) Romania — the "light" variant, per explicit request
            'https://raw.githubusercontent.com/tcptomato/ROad-Block/master/road-block-filters-light.txt',
        ],
        category: 'language-filter',
        countries: BALKAN_COUNTRIES,
        locales: localesOfCountries(BALKAN_COUNTRIES),
        enabled: false,
    },
    // ── Optional annoyance filters ──────────────────────────────────────────
    {
        id:      'ruleset_adguard_antiadblock',
        // Name kept source-neutral (10.0.6, matching the language-filter
        // simplification — see CHANGELOG), now that this combines two
        // sources rather than being AdGuard-only.
        name:    'AdGuard and EasyList anti-adblock (specific websites only)',
        // Two sources combined (10.0.6, per explicit request) — same
        // array-url mechanism as ruleset_easylist_bulgarian, no new code.
        // The EasyList source is antiadblockfilters' own per-language
        // split (github.com/easylist/antiadblockfilters) — "english" was
        // chosen as the best match for this project's English-primary
        // audience. Confirmed full file list (10.0.6): arabic, chinese,
        // czech, dutch, english, finnish, french, german, hebrew,
        // indonesian, italian, latvian, romanian, russian, slovak,
        // spanish. Of these, dutch/german/french have real content and
        // are also merged into their matching language filter below;
        // czech/slovak/spanish/italian/latvian EXIST but are genuinely
        // EMPTY (0 bytes, confirmed via live fetch) — not merged anywhere,
        // see each matching language filter's own comment; arabic/
        // chinese/finnish/hebrew/indonesian/romanian/russian have no
        // matching language filter in this project at all.
        // (2026-11-09, owner's decision) + AdGuard Base's own anti-adblock section, MOVED here from AdGuard Base's
        // SECTIONS so these rules keep working when AdGuard Base is switched off. Its site-less (generic) hide rules
        // are dropped, as for every list (parseCosmeticRules() skips rules without a domain; owner: generic rules
        // cause too many issues). Its unsafe rules go to this list's own companion, ruleset_adguard_antiadblock_unsafe
        // (js/data/ruleset-companions.js).
        // Same day, owner's decision: like EasyList's per-language anti-adblock files below, its rules for sites of a
        // country that has a language filter go INTO that language filter instead (antiadblock-country-split.mjs,
        // appended per list in build-steps.mjs); this list gets the rest. `url` lists the sources for display and
        // the trust check; customFetch does the actual (split) fetch.
        url: [
            ANTIADBLOCK_SPLIT_CONFIG.SOURCE_URL,
            ANTIADBLOCK_POPUPS_URL,
            ANTIADBLOCK_EASYLIST_ENGLISH_URL,
        ],
        // (2026-11-09) Its site rules for generic-TLD and English-country sites outside the CrUX top 1M go to
        // ruleset_english_outside_top1m instead of being dropped by this list's top-1M limit (owner's decision).
        customFetch: async ( ) => {
            const english = splitAntiadblockEnglish([
                await antiadblockGeneralText(),
                await fetchList(ANTIADBLOCK_POPUPS_URL),
                await fetchList(ANTIADBLOCK_EASYLIST_ENGLISH_URL),
            ].join('\n'));
            setAntiadblockEnglishText(english.english);
            return english.keep;
        },
        enabled: true,   // (v8.3.2) — see CHANGELOG.md's 8.3.2 entry for why
        // (2026-11-09, owner's decision) Site rules only for in-scope TLDs (geographic scope, every list) AND CrUX
        // top-1M sites — scriptlets, hide rules and site-scoped network rules (build-steps.mjs).
        popularityFilter: true,
    },
    // (2026-11-09, owner's decision, 10.7.0) English sites outside the CrUX top 1M — see english-outside-top-sites.mjs.
    // MUST stay after ruleset_adguard_base and ruleset_adguard_antiadblock (it reads their hand-offs). A language
    // filter row, labelled by its name (no `language`), switched on automatically only when the browser's FIRST
    // language is English (`firstLanguage`, js/core/language-auto-enable.js) — at install and once on update.
    {
        id:       'ruleset_english_outside_top1m',
        name:     'English language filter for websites outside top 1 Million',
        // Display / trust check only (customFetch does the fetch): the AdGuard Base section that carries most of
        // these rules, and the anti-adblock sources.
        url: [
            'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/BaseFilter/sections/specific.txt',
            ANTIADBLOCK_SPLIT_CONFIG.SOURCE_URL,
            ANTIADBLOCK_POPUPS_URL,
            ANTIADBLOCK_EASYLIST_ENGLISH_URL,
        ],
        customFetch: englishOutsideTopSitesText,
        category: 'language-filter',
        firstLanguage: 'en',
        enabled:  false,
    },
    // Anti-Admiral (v8.3.2) — dedicated block against getadmiral.com's
    // ad-block-recovery / paywall-circumvention network (branded "Admiral" /
    // "Ad-Shield"), combined + deduplicated at build time from three
    // independent open-source lists that each cover this vendor from a
    // different angle (DNS-blocklist style domain enumeration, EasyPrivacy's
    // own tracking-server rules, and a dedicated uBO filter list). Deliberately
    // NOT sourced via the ordinary string/array `url` field above — those
    // paths only fetch-and-concatenate raw text through the shared ABP-syntax
    // parser below, which would silently mis-handle HaGeZi's plain
    // domain-per-line format (no `||`/`^` markers) as an unanchored substring
    // match instead of a proper hostname block, and would not deduplicate
    // domains repeated across the three sources at all — see
    // buildAntiAdmiralSourceText()'s own header comment for the exact
    // normalize/dedup logic. `customFetch` is a single dedicated escape
    // hatch for this one list; every other entry above still resolves via
    // the ordinary string/array `url` field.
    {
        id:      'ruleset_antiadmiral',
        // (2026-11-09) uBlock Origin added to the name: its Admiral site rules are now part of this list (anti-admiral.mjs).
        name:    'Block Admiral anti-adblock (EasyList, HaGeZi, LanikSJ and uBlock Origin)',
        customFetch: buildAntiAdmiralSourceText,
        enabled: true,
        // (2026-11-09, owner's decision) Same limit as the anti-adblock list. Only the uBO site rules are affected:
        // the Admiral server domains carry no site, and blocked servers are never limited (build-steps.mjs).
        popularityFilter: true,
    },
    // Worry-free extra blocklist (v8.3.6) — the reserved WORRY_FREE_EXTRA_*
    // tier's first real content (see dnr-budgets.js's own header on that
    // tier). Ships at WORRY_FREE_EXTRA_BLOCKLIST_PRIORITY (100 — well below
    // STATIC_FILTER_LIST_PRIORITY, the normal filter-list tier) rather than
    // the default, per this list's own reserved-tier design: normally
    // suppressed by a higher-priority session/dynamic allow rule (not yet
    // built — see this release's own CHANGELOG entry), effective only once
    // that allow rule is removed. `enabled: true` here only controls
    // whether this ruleset is loaded into Chrome's rule engine at all —
    // whether its rules actually WIN for a given request during normal
    // browsing is entirely a question of the (not-yet-built) allow rule's
    // priority and presence, not this flag.
    // RETIRED (v9.1.7) — ruleset_worryfree_extra ("adult-site ad servers +
    // transcend.io") and ruleset_worryfree_social (Disconnect+Ghostery
    // social media list) both removed entirely, per explicit request —
    // not rescoped, not replaced. See dnr-budgets.js's
    // WORRY_FREE_EXTRA_RULES_BASE_ID/WORRY_FREE_SOCIAL_RULES_BASE_ID own
    // retirement comments for the full history.
    //
    // RETIRED (AdShield Evolution rename pass) — ruleset_worryfree_3pblock,
    // ruleset_worryfree_tldallow, ruleset_worryfree_downloadblock, and
    // ruleset_worryfree_download_tldallow (the four static rulesets behind
    // blockScpTldBlock, "Block third-party scripts, frames and downloads
    // outside safer regions") all removed together, per explicit request:
    // all four share the identical condition shape (domainType:
    // 'thirdParty', resourceTypes: ['script','sub_frame']) and are
    // suppressed by the SAME single session rule
    // (WORRY_FREE_3PBLOCK_RULES_BASE_ID in worry-free-extra-manager.js), so
    // all four belong to this one checkbox, confirmed before removing any
    // of them. See CHANGELOG_HISTORY.md for the full entry and
    // dnr-budgets.js's own retirement comments for the ids/priorities this
    // freed up.
    // (10.3.0) ruleset_scp_privacy_block, ruleset_scp_security_block (the Low group's two Permissions-Policy
    // header rulesets) and ruleset_suspicious_hosting (Kees1958 Suspicious websites + HaGeZi DynDNS, the
    // "Block suspicious 3P-requests" domain list) were REMOVED with the Privacy & Security extra protections,
    // which moved to 3P-Matrix. tools/build/suspicious-hosting.mjs went with them.
];
