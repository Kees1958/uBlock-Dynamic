// ── tools/build/annoyances-sources.mjs ────────────────────────────────────────
// Source text for ruleset_annoyances — the Worry-free "AdGuard and EasyList
// annoyances" list: seven upstream annoyance sources merged into ONE list, gated
// and de-duplicated at build time. Since 10.0.7 it is an always-on Built-in default list
// (no longer a Worry-free opt-in).
//
// Public interface:
//   buildAnnoyancesSourceText()   — download the seven sources, gate, de-dupe; returns ABP text
//                                   (the FILTER_LISTS entry's customFetch)
//   gateAnnoyanceLines(lines, o)  — pure gate for ONE list's lines (unit-tested, no network)
//   ANNOYANCE_SOURCES             — the six plain upstream lists (name + url), declared once;
//                                   the 7th (EasyList adult-specific) goes through buildWorryFreeLists()
//
// Dependencies: fetch-helpers.mjs (fetchList), build-state.mjs (topSitesSet — the CrUX
//   top-1M set stepInit fetches before any list is compiled), crux-top-sites.mjs
//   (isPopularHostname), tld-scope.mjs (isTLDKept), worry-free-extra-lists.mjs
//   (buildWorryFreeLists + EASYLIST_ADULT_SPECIFIC_SOURCE — the 7th source, C21 reuse).
//
// State owned by this module: none (pure functions; the only input state is topSitesSet).
//
// WHY THESE GATES (measured on the real lists, 9.8.x tools audit; see CHANGELOG_HISTORY 9.9.0):
//   - Per-site rules (hide rules, scriptlets) are kept ONLY for a site that is inside the
//     in-scope TLD set AND in the CrUX top-1M. Rules for sites nobody visits cost download
//     size and give no benefit.
//   - Network rules must be host-anchored with a LITERAL host (`||host…`). This ruleset is
//     suppressed outside Worry-free sessions by a requestDomains-scoped allow rule
//     (worry-free-extra-manager.js); a rule with no literal host (path-only pattern, or a
//     `*` in the host) cannot be suppressed that way and would block outside a session.
//   - Only ONE upstream list (AdGuard popups_specific) is category-filtered: it is a broad
//     "everything popup-like" list, and only the newsletter / notification / promo /
//     cookie-flag / survey / login-wall / chat prompts were wanted from it. The other five
//     lists are already about exactly those prompts.
//   - `$popup` / popunder rules are NOT carried: parseBlockRule() drops them (popups are
//     out of scope by decision). This list only hides in-page elements, applies
//     scriptlets and blocks hosts — it never closes new-tab popups.
import { fetchList } from './fetch-helpers.mjs';
import { topSitesSet } from './build-state.mjs';
import { isPopularHostname } from './crux-top-sites.mjs';
import { isTLDKept } from './tld-scope.mjs';
import { EASYLIST_ADULT_SPECIFIC_SOURCE, buildWorryFreeLists } from './worry-free-extra-lists.mjs';

/******************************************************************************/
// Settings — the ONLY place these values live.
/******************************************************************************/

const ADGUARD_POPUPS_BASE = 'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/AnnoyancesFilter/Popups/sections/';
const EASYLIST_FANBOY_BASE = 'https://raw.githubusercontent.com/easylist/easylist/master/fanboy-addon/';

// The six upstream lists. `categoryFilter: true` = keep only rules whose body matches one of
// KEPT_CATEGORIES (see siteRuleCategory()).
export const ANNOYANCE_SOURCES = Object.freeze([
    { name: 'AdGuard popups_specific',            url: `${ADGUARD_POPUPS_BASE}popups_specific.txt`,            categoryFilter: true  },
    { name: 'AdGuard push-notifications_general', url: `${ADGUARD_POPUPS_BASE}push-notifications_general.txt`, categoryFilter: false },
    { name: 'AdGuard subscriptions_specific',     url: `${ADGUARD_POPUPS_BASE}subscriptions_specific.txt`,     categoryFilter: false },
    { name: 'EasyList fanboy notifications',      url: `${EASYLIST_FANBOY_BASE}fanboy_notifications_specific_hide.txt`, categoryFilter: false },
    { name: 'EasyList fanboy newsletter',         url: `${EASYLIST_FANBOY_BASE}fanboy_newsletter_specific_hide.txt`,    categoryFilter: false },
    { name: 'EasyList fanboy annoyance',          url: `${EASYLIST_FANBOY_BASE}fanboy_annoyance_specific_hide.txt`,     categoryFilter: false },
]);

// Category detection for the category-filtered list: the first matching entry wins (order
// matters — e.g. a "cookie" rule mentioning "popup" is a cookie rule). Keyword matching on
// the rule body is approximate by nature; it is the only way to select by category.
const CATEGORY_KEYWORDS = Object.freeze([
    [ 'google-signin', /credential|accounts\.google|gsi|google.*(one.?tap|signin)|g_id/ ],
    [ 'newsletter',    /newsletter|subscribe|subscription|signup|sign-up|email-capture|mailing/ ],
    [ 'cookie',        /cookie|consent|gdpr|privacy-banner|onetrust|cmp/ ],
    [ 'notification',  /notification|push|onesignal|web-push/ ],
    [ 'app-install',   /app-banner|smartbanner|install-app|get-the-app|download-app|appbanner|open-in-app/ ],
    [ 'chat',          /chat|intercom|drift|zendesk|livechat|crisp|tawk/ ],
    [ 'survey',        /survey|feedback|nps|qualtrics|hotjar/ ],
    [ 'login-wall',    /paywall|regwall|login-wall|register|metered|premium/ ],
    [ 'promo',         /promo|discount|offer|coupon|deal|sale|special/ ],
    [ 'modal',         /modal|overlay|popup|pop-up|lightbox|dialog|backdrop|interstitial/ ],
]);
// The categories wanted from the category-filtered list (everything else — sign-in prompts,
// app-install banners, generic modals, unclassifiable site elements — is left out).
const KEPT_CATEGORIES = Object.freeze(new Set([ 'newsletter', 'cookie', 'notification', 'chat', 'survey', 'login-wall', 'promo' ]));

// GUARD: a build that produces fewer merged lines than this has almost certainly lost a
// source (format change, wrong URL that still returned a filter-list-looking page).
const MIN_MERGED_LINES = 1000;
// GUARD: every single source must contribute at least this many lines after gating.
const MIN_LINES_PER_SOURCE = 1;

/******************************************************************************/
// Rule shapes
/******************************************************************************/

// `hosts` + operator + body. Only the operators the build pipeline actually turns into output
// are kept: ## (hide), #@# (hide exception), #%# (scriptlet). Deliberately NOT kept, because
// parseCosmeticRules() skips them anyway (cosmetic-data.mjs): #?# procedural and #$# CSS-inject
// rules; and `$$` HTML filtering, which has no MV3 equivalent. Carrying them would only bloat
// the merged text, never the shipped output.
const SITE_RULE_RE = /^([^#$/|@]*)(##|#@#|#%#)(.*)$/;
// Host-anchored network rule with a LITERAL host, see the header for why. The host is read the
// SAME way the runtime suppression code reads it (hostFromUrlFilter() in worry-free-extra-
// manager.js): everything after `||` up to the first `^`, `/` or `?` (plus `$`, which in a
// SOURCE line starts the options and is gone from the compiled urlFilter). It must then be a
// plain hostname — anything else in that span (`*`, `|`, `:port`) means the runtime code could
// not scope a suppression rule to it, so the rule is not carried.
// ONE MORE trap, found by the first real build: patternToUrlFilter() (rule-parsers.mjs) compiles
// EVERY `^` into `|`. `||host^` is fine (the trailing `|` is stripped), but a `^` FOLLOWED by more
// pattern — e.g. `||ryobitools.eu^*/NewsletterPopup-` — compiles to `||ryobitools.eu|*/…`, whose
// host span then contains `|*` and cannot be suppressed. So a `^` right after the host must be
// the end of the pattern or the start of the `$options`.
const NETWORK_HOST_TERMINATORS = [ '^', '/', '?', '$' ];
const PLAIN_HOSTNAME_RE = /^[a-z0-9.-]+$/i;
function literalHostOfNetworkRule(line) {
    if ( !line.startsWith('||') ) { return null; }
    const rest = line.slice(2);
    const end = Math.min(...NETWORK_HOST_TERMINATORS.map(ch => {
        const i = rest.indexOf(ch);
        return i === -1 ? rest.length : i;
    }));
    const host = rest.slice(0, end);
    if ( !PLAIN_HOSTNAME_RE.test(host) ) { return null; }
    if ( rest[end] === '^' ) {
        const afterCaret = rest.slice(end + 1);
        if ( afterCaret !== '' && !afterCaret.startsWith('$') ) { return null; }
    }
    return host;
}

export function siteRuleCategory(body) {
    const text = body.toLowerCase();
    for ( const [ category, rx ] of CATEGORY_KEYWORDS ) {
        if ( rx.test(text) ) { return category; }
    }
    return 'other';
}

/******************************************************************************/
// Gate for ONE list — pure: everything it needs is passed in.
//   lines : the list's lines
//   opts  : { topSites: Set<string>, categoryFilter: boolean }
// Returns the gated, per-site-expanded lines (one line per site, so identical rules that
// several lists carry for the same site are byte-identical and de-duplicate exactly).
/******************************************************************************/

export function gateAnnoyanceLines(lines, { topSites, categoryFilter }) {
    if ( !(topSites instanceof Set) || topSites.size === 0 ) {
        throw new Error('gateAnnoyanceLines: topSites (CrUX top-1M) is empty or missing');
    }
    function siteOk(hostname) { return isTLDKept(hostname) && isPopularHostname(hostname, topSites); }
    const out = [];
    for ( const raw of lines ) {
        const line = raw.trim();
        if ( line === '' || line.startsWith('!') || line.startsWith('[') ) { continue; }
        const site = SITE_RULE_RE.exec(line);
        if ( site !== null ) {
            const [ , hostList, operator, body ] = site;
            if ( hostList === '' ) { continue; }             // generic (no-site) rule: dropped by the parser anyway
            if ( categoryFilter && !KEPT_CATEGORIES.has(siteRuleCategory(body)) ) { continue; }
            for ( const host of hostList.split(',') ) {
                const h = host.trim().toLowerCase();
                if ( h === '' || h.startsWith('~') ) { continue; }
                if ( siteOk(h) ) { out.push(`${h}${operator}${body}`); }
            }
            continue;
        }
        if ( categoryFilter ) { continue; }                   // network rules are not category-selected
        if ( line.includes('#') || line.includes('$$') ) { continue; }          // a cosmetic/procedural/HTML-filter rule shape we do not carry
        const networkHost = literalHostOfNetworkRule(line);
        if ( networkHost === null ) { continue; }             // path-only / wildcard-host / other: cannot be suppressed
        if ( isTLDKept(networkHost.toLowerCase()) ) { out.push(line); }   // vendor host: TLD scope only, top-1M is meaningless here
    }
    return out;
}

/******************************************************************************/
// Build entry point (the FILTER_LISTS customFetch).
/******************************************************************************/

export async function buildAnnoyancesSourceText() {
    const merged = new Set();
    const perSource = [];
    for ( const source of ANNOYANCE_SOURCES ) {
        const text = await fetchList(source.url);            // throws on empty / non-filter-list responses
        const gated = gateAnnoyanceLines(text.split('\n'), { topSites: topSitesSet, categoryFilter: source.categoryFilter });
        if ( gated.length < MIN_LINES_PER_SOURCE ) {
            throw new Error(`annoyances: source '${source.name}' produced no rules after gating — its format may have changed (${source.url})`);
        }
        let added = 0;
        for ( const line of gated ) {
            if ( !merged.has(line) ) { merged.add(line); added++; }
        }
        perSource.push(`${source.name}: ${gated.length} gated, ${added} new`);
    }
    // 7th source (10.0.7): EasyList's adult-specific content, folded in when the standalone
    // ruleset_easylist_adult_specific list was retired. Fetched/gated through the existing
    // buildWorryFreeLists() pipeline (C21) — NOT gateAnnoyanceLines(), which would drop its
    // path-anchored network rules — and merged with its own minimum-lines guard.
    const adultText = await buildWorryFreeLists(EASYLIST_ADULT_SPECIFIC_SOURCE);
    const adultLines = adultText.split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('!'));
    if ( adultLines.length < MIN_LINES_PER_SOURCE ) {
        throw new Error(`annoyances: source '${EASYLIST_ADULT_SPECIFIC_SOURCE.name}' produced no rules — its format may have changed (${EASYLIST_ADULT_SPECIFIC_SOURCE.url})`);
    }
    let adultAdded = 0;
    for ( const line of adultLines ) {
        if ( !merged.has(line) ) { merged.add(line); adultAdded++; }
    }
    perSource.push(`${EASYLIST_ADULT_SPECIFIC_SOURCE.name}: ${adultLines.length} gated, ${adultAdded} new`);
    if ( merged.size < MIN_MERGED_LINES ) {
        throw new Error(`annoyances: only ${merged.size} merged lines (expected at least ${MIN_MERGED_LINES}) — a source is probably broken`);
    }
    console.log(`\n[annoyances] ${merged.size} merged lines — ${perSource.join('; ')}`);
    return [ ...merged ].sort().join('\n') + '\n';
}
