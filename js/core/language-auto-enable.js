/*
 * language-auto-enable.js — which language filters (and which of their rows) to switch on at first install (10.4.5).
 *
 * Owner's rule:
 *   1. The browser's LANGUAGES first — every tag in its preferred-languages list plus its UI language. Each
 *      language that has a filter switches that filter on (a tag with a region prefers a row declared for the
 *      full tag: "sr-ME" → Montenegro, "sr" → Serbian).
 *   2. Only when NONE of those languages has a filter: the COUNTRY decides — the TIME ZONE first (Europe/Zurich →
 *      Switzerland), and only when the zone names no country (UTC, Etc/*) the first language tag whose region is a
 *      known country ("en-CH" → Switzerland) — and EVERY language spoken there that has a filter is switched on
 *      (Switzerland → German, French, Italian). Time zone first (owner's decision): English Chrome reports "en-US"
 *      almost everywhere, so a tag's region is a weak location signal, found in a real first-install test. A
 *      country's languages are its OFFICIAL ones (countries.json): the United States is English only, Puerto Rico
 *      (its own time zone, America/Puerto_Rico) Spanish and English.
 * Country data and the time-zone table: js/core/country-resolver.js (ported from 3P Matrix).
 *
 * (10.7.0, owner's rule) A filter that declares `firstLanguage` instead of `locales` (the "English language filter for
 * websites outside top 1 Million") follows a separate, stricter rule: on only when the browser's FIRST language is
 * that language — not any language in the list, and never through the country fallback. Decided by
 * pickFirstLanguageFilters(); applied ONCE per install (at install and on the update that introduced it) through
 * FIRST_LANGUAGE_FILTERS_MARKER_KEY (js/workflow/background.js runVersionMigration()), so a user who switches it
 * off later keeps it off.
 *
 * Public interface:
 *   pickLanguageFilters(entries, env, resolver) — pure: Map<rulesetId, string[]> (row ids; [] for a filter
 *                                                  without rows), from the ruleset-details entries that declare
 *                                                  locales (the language filters AND the hidden "other EU" AdGuard
 *                                                  Base bucket, whose only enable path this is), env { langs, uiLanguage,
 *                                                  timeZone } and the initialised resolver functions
 *                                                  { countryFromRegion, countryFromTimeZone, languagesOfCountry }.
 *   pickFirstLanguageFilters(entries, env) — pure: rulesetId[] of the `firstLanguage` filters for the browser's
 *                                            first language (env.langs[0], else env.uiLanguage).
 *   FIRST_LANGUAGE_FILTERS_SINCE / FIRST_LANGUAGE_FILTERS_MARKER_KEY — the one-time step's boundary and marker.
 * Nothing is kept between calls — nothing to initialise, clear or release.
 */

// The version that introduced the first-language rule; the one-time step runs when the stored marker is older.
export const FIRST_LANGUAGE_FILTERS_SINCE = '10.7.0';
// chrome.storage.local key: the extension version that ran the one-time step (absent = never ran).
export const FIRST_LANGUAGE_FILTERS_MARKER_KEY = 'firstLanguageFiltersAppliedIn';

// ── CONFIG ──────────────────────────────────────────────────────────────────
const TAG_SEPARATOR_RE = /[-_]/;   // BCP-47 ("de-CH") and Chrome's "de_CH" spelling
const MAX_TAGS = 20;               // guard: far above any real browser language list

function splitTag(tag) {
    const parts = String(tag || '').toLowerCase().split(TAG_SEPARATOR_RE).filter(Boolean);
    if ( parts.length === 0 ) { return null; }
    return { full: parts.join('-'), lang: parts[0], region: parts.length > 1 ? parts[parts.length - 1] : '' };
}

function hasLocale(locales, value) {
    return Array.isArray(locales) && locales.some(l => String(l).toLowerCase() === value);
}

// Adds to `out` what one language (full tag + bare language) switches on. Returns true when something matched.
function matchLanguage(entries, full, lang, out) {
    let matched = false;
    for ( const entry of entries ) {
        if ( Array.isArray(entry.countries) && entry.countries.length > 0 ) {
            const byFull = full ? entry.countries.filter(c => hasLocale(c.locales, full)) : [];
            const rows = byFull.length > 0 ? byFull : entry.countries.filter(c => hasLocale(c.locales, lang));
            if ( rows.length === 0 ) { continue; }
            const ids = out.get(entry.id) ?? [];
            for ( const r of rows ) { if ( !ids.includes(r.id) ) { ids.push(r.id); } }
            out.set(entry.id, ids);
            matched = true;
        } else if ( hasLocale(entry.locales, full) || hasLocale(entry.locales, lang) ) {
            if ( !out.has(entry.id) ) { out.set(entry.id, []); }
            matched = true;
        }
    }
    return matched;
}

// The browser's first language: the first preferred-language tag, else the UI language. null when neither is known.
function firstLanguageOf(env) {
    const first = Array.isArray(env?.langs) && env.langs.length > 0 ? env.langs[0] : env?.uiLanguage;
    return splitTag(first)?.lang ?? null;
}

export function pickFirstLanguageFilters(entries, env) {
    const lang = firstLanguageOf(env);
    if ( lang === null ) { return []; }
    return (Array.isArray(entries) ? entries : [])
        .filter(e => typeof e?.firstLanguage === 'string' && e.firstLanguage.toLowerCase() === lang)
        .map(e => e.id);
}

export function pickLanguageFilters(entries, env, resolver) {
    const out = new Map();
    const filters = (Array.isArray(entries) ? entries : []).filter(e =>
        (Array.isArray(e?.locales) && e.locales.length > 0) || (Array.isArray(e?.countries) && e.countries.length > 0));
    if ( filters.length === 0 ) { return out; }
    const tags = [ ...(Array.isArray(env?.langs) ? env.langs : []), env?.uiLanguage ]
        .slice(0, MAX_TAGS).map(splitTag).filter(Boolean);

    // 1 — the browser's languages.
    for ( const t of tags ) { matchLanguage(filters, t.full, t.lang, out); }
    if ( out.size > 0 ) { return out; }

    // 2 — no browser language has a filter: the country decides (the time zone, else the region of a tag).
    let country = resolver.countryFromTimeZone(env?.timeZone);
    for ( const t of tags ) {
        if ( country ) { break; }
        if ( t.region !== '' ) { country = resolver.countryFromRegion(t.region); }
    }
    if ( !country ) { return out; }
    for ( const lang of resolver.languagesOfCountry(country) ) { matchLanguage(filters, '', lang, out); }
    return out;
}
