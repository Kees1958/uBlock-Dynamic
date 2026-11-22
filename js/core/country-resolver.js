// ── country-resolver.js ───────────────────────────────────────────────────────
// Which countries (ccTLDs) and which continent belong to this browser — ported (10.4.5) from 3P Matrix's
// standalone country-resolver.js (itself extracted from its core/tld-engine.js and core/safer-regions.js,
// 3P Matrix 4.3.4), so both extensions answer this the same way (C21). Data: js/data/country-data/
// countries.json, language-rules.json, timezones.json.
//
// Changes against the 3P Matrix original, nothing else:
//   - project code style; data files are read from js/data/country-data/;
//   - the four tables the delivered language-rules.json lacked (regionPairings, langWorldDefaults,
//     langDefaultCountry, euLangs) are now present in that file, so steps 1–3 below no longer throw;
//   - three additions for uBlock Stripped's language-filter auto-enable (js/core/language-auto-enable.js):
//     countryFromRegion(), countryFromTimeZone() (timezones.json `zoneCountry`, generated from the IANA tz
//     database — a zone now CAN name a country, used only when no language tag has a region) and
//     languagesOfCountry().
//
// How the country is determined (3P Matrix's own order):
//   1. Browser language tags. A tag WITH a region decides the country directly: "nl-BE" → be, "en-GB" → uk
//      (regionTldExceptions), plus companion countries (regionPairings: en-IE → also uk).
//   2. A bare tag (no region): a world language adds its most-read countries (langWorldDefaults: "en" → uk,
//      us, ie, au, ca, nz); another language its one safe default (langDefaultCountry: "nl" → nl).
//   3. Any EU official language → also "eu".
// Home continent = the first language tag whose region is a known country; if none, the IANA time zone:
// exact zone → prefix → area ("Europe/…"). UTC / Etc/* / Antarctica → unknown (no guess).
//
// Public interface:
//   initCountryResolver(data?)        — load the tables (fetches the JSON when data is omitted;
//                                       pass { countries, languageRules, timezones } to skip fetch)
//   releaseCountryResolver()          — clear the lookups (free memory); init again to reuse
//   isCountryResolverReady()          — tables loaded
//   browserEnvironment()              — Promise<{ langs, uiLanguage, timeZone }> from the browser (guarded)
//   countriesFromLanguages(langs)     — steps 1–3: string[] of ccTLDs (+ "eu")
//   continentFromTimeZone(timeZone)   — continent id or null
//   homeContinent(langs, timeZone)    — continent id or null (language region first, then zone)
//   resolveCountries(mode, langs, timeZone) — AUTO_MODE result: string[] of ccTLDs
//   detectForThisBrowser(mode?)       — all of the above for the current browser
//   countryFromRegion(region)         — (added) region subtag → ccTLD, or null
//   countryFromTimeZone(timeZone)     — (added) IANA zone → ccTLD, or null
//   languagesOfCountry(ccTld)         — (added) normalised base languages spoken there ([] if unknown)
// All functions after init are pure (input → output); only browserEnvironment() reads the browser.
// Resources: `tables` (lookup maps) — created by initCountryResolver(), released by releaseCountryResolver().
// ─────────────────────────────────────────────────────────────────────────────

// ── Settings (one place) ─────────────────────────────────────────────────────
// Where the JSON files live, relative to this module.
const DATA_FILES = Object.freeze({
    countries:     '../data/country-data/countries.json',
    languageRules: '../data/country-data/language-rules.json',
    timezones:     '../data/country-data/timezones.json',
});

// How far the language-based expansion reaches (3P Matrix uses CONTINENT).
const AUTO_MODE = Object.freeze({   // (audit 10.6.4) un-exported: only used inside this module
    NONE:      0,   // nothing
    BROWSER:   1,   // only the countries named by the language tags (steps 1–3)
    CONTINENT: 2,   // BROWSER + every country on the home continent speaking a browser language
    WORLDWIDE: 3,   // BROWSER + every country anywhere speaking a browser language
});
const DEFAULT_MODE = AUTO_MODE.CONTINENT;

const LANG_TAG_MIN_PARTS = 2;              // "nl-NL" = language + region
const TAG_SEPARATOR = '-';                 // BCP-47 subtag separator
const ZONE_SEPARATOR = '/';                // IANA "Area/City"
const REGION_RE = /^[a-z]{2,3}$/;          // usable region subtag (excludes "419" etc.)
const EU_TLD = 'eu';

// ── State (initialised by initCountryResolver, cleared by releaseCountryResolver) ─────────
let tables = null;     // { countryIndex, regionToTld, related, norm, rules, excluded, euLangs, tz } or null

// ── Init / release guards ────────────────────────────────────────────────────
async function fetchJson(rel) {
    const url = new URL(rel, import.meta.url);
    const res = await fetch(url);
    if ( !res.ok ) { throw new Error(`country-resolver: ${rel} → HTTP ${res.status}`); }
    return res.json();
}

function requireReady() {
    if ( !tables ) { throw new Error('country-resolver: call initCountryResolver() first'); }
    return tables;
}

export async function initCountryResolver(data) {
    releaseCountryResolver();                               // guard: never build on top of old tables
    const d = data || {
        countries:     await fetchJson(DATA_FILES.countries),
        languageRules: await fetchJson(DATA_FILES.languageRules),
        timezones:     await fetchJson(DATA_FILES.timezones),
    };
    if ( !d || !d.countries || !d.languageRules || !d.timezones ) { throw new Error('country-resolver: incomplete data'); }
    const rules = d.languageRules;
    for ( const key of [ 'regionTldExceptions', 'langAliases', 'mutuallyIntelligibleLangs', 'oneWayIntelligibleLangs',
        'expansionExcludedTlds', 'regionPairings', 'langWorldDefaults', 'langDefaultCountry', 'euLangs' ] ) {
        if ( rules[key] === undefined ) { throw new Error(`country-resolver: language-rules.json lacks "${key}"`); }
    }
    function norm(tag) { const b = String(tag || '').toLowerCase().split(TAG_SEPARATOR)[0]; return rules.langAliases[b] || b; }

    const countryIndex = new Map();                          // ccTLD → { continent, langs:Set }
    const regionToTld = { ...rules.regionTldExceptions };    // region subtag → ccTLD
    for ( const group of [ d.countries.countries, d.countries.territories ] ) {
        for ( const [ continent, byTld ] of Object.entries(group || {}) ) {
            for ( const [ tld, langs ] of Object.entries(byTld) ) {
                countryIndex.set(tld, { continent, langs: new Set(langs.map(norm)) });
                if ( !(tld in regionToTld) ) { regionToTld[tld] = tld; }
            }
        }
    }
    const related = new Map();                               // language → Set of readable languages
    function relate(a, b) { if ( a === b ) { return; } if ( !related.has(a) ) { related.set(a, new Set()); } related.get(a).add(b); }
    for ( const g of rules.mutuallyIntelligibleLangs ) { const m = g.map(norm); m.forEach(a => m.forEach(b => relate(a, b))); }
    for ( const [ a, b ] of rules.oneWayIntelligibleLangs ) { relate(norm(a), norm(b)); }

    tables = { countryIndex, regionToTld, related, norm, rules,
               excluded: new Set(rules.expansionExcludedTlds), euLangs: new Set(rules.euLangs), tz: d.timezones };
}

export function releaseCountryResolver() {
    if ( !tables ) { return; }
    tables.countryIndex.clear();
    tables.related.clear();
    tables.excluded.clear();
    tables.euLangs.clear();
    tables = null;
}

/** @public kept from 3P Matrix's resolver: same API in both extensions */
export function isCountryResolverReady() { return tables !== null; }

// ── Browser input (the only impure part, every read guarded) ────────────────
export async function browserEnvironment() {
    let langs = [];
    try {
        if ( globalThis.chrome && chrome.i18n && chrome.i18n.getAcceptLanguages ) { langs = (await chrome.i18n.getAcceptLanguages()) || []; }
        else if ( globalThis.navigator && navigator.languages ) { langs = Array.from(navigator.languages); }
    } catch { langs = []; }                                  // guard: no language API → no guess
    let uiLanguage = '';
    try { uiLanguage = (globalThis.chrome && chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || ''; }
    catch { uiLanguage = ''; }                               // guard (added): no UI-language API → none
    let timeZone = '';
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch { timeZone = ''; }                                 // guard: Intl unavailable → no guess
    return { langs, uiLanguage, timeZone };
}

// ── Logic ────────────────────────────────────────────────────────────────────
function addOnce(list, v) { if ( v && !list.includes(v) ) { list.push(v); } }

/** @public kept from 3P Matrix's resolver: same API in both extensions */
export function countriesFromLanguages(langs) {
    const t = requireReady(), r = t.rules, out = [];
    let euLang = false;
    for ( const tag of langs || [] ) {
        const parts = String(tag).toLowerCase().split(TAG_SEPARATOR);
        const lang = parts[0];
        if ( t.euLangs.has(lang) ) { euLang = true; }
        if ( parts.length >= LANG_TAG_MIN_PARTS ) {
            const region = parts[parts.length - 1];
            if ( REGION_RE.test(region) ) { addOnce(out, t.regionToTld[region] || region); }   // en-GB → uk
            for ( const c of r.regionPairings[`${lang}-${region}`] || [] ) { addOnce(out, c); }
        } else if ( r.langWorldDefaults[lang] ) {
            for ( const c of r.langWorldDefaults[lang] ) { addOnce(out, c); }
        } else if ( r.langDefaultCountry[lang] ) {
            addOnce(out, r.langDefaultCountry[lang]);
        }
    }
    if ( euLang ) { addOnce(out, EU_TLD); }
    return out;
}

/** @public kept from 3P Matrix's resolver: same API in both extensions */
export function continentFromTimeZone(timeZone) {
    const tz = requireReady().tz;
    if ( !timeZone || typeof timeZone !== 'string' ) { return null; }
    if ( tz.exceptions[timeZone] ) { return tz.exceptions[timeZone]; }
    for ( const prefix of Object.keys(tz.prefixExceptions) ) {
        if ( timeZone.startsWith(prefix) ) { return tz.prefixExceptions[prefix]; }
    }
    return tz.areaDefault[timeZone.split(ZONE_SEPARATOR)[0]] || null;
}

/** @public kept from 3P Matrix's resolver: same API in both extensions */
export function homeContinent(langs, timeZone) {
    const t = requireReady();
    for ( const tag of langs || [] ) {
        const parts = String(tag).toLowerCase().split(TAG_SEPARATOR);
        if ( parts.length < LANG_TAG_MIN_PARTS ) { continue; }    // no region subtag
        const info = t.countryIndex.get(t.regionToTld[parts[parts.length - 1]]);
        if ( info ) { return info.continent; }                // first usable region wins
    }
    return continentFromTimeZone(timeZone);                  // fallback only
}

/** @public kept from 3P Matrix's resolver: same API in both extensions */
export function resolveCountries(mode, langs, timeZone) {
    const t = requireReady();
    if ( mode === AUTO_MODE.NONE ) { return []; }
    const result = countriesFromLanguages(langs);
    if ( mode === AUTO_MODE.BROWSER ) { return result; }
    let continent = null;
    if ( mode === AUTO_MODE.CONTINENT ) {
        continent = homeContinent(langs, timeZone);
        if ( !continent ) { return result; }                  // guard: continent unknown → no expansion
    }
    const spoken = new Set();
    for ( const tag of langs || [] ) {
        const l = t.norm(tag);
        spoken.add(l);
        for ( const rel of t.related.get(l) || [] ) { spoken.add(rel); }
    }
    for ( const [ tld, info ] of t.countryIndex ) {
        if ( continent && info.continent !== continent ) { continue; }
        if ( t.excluded.has(tld) || result.includes(tld) ) { continue; }
        for ( const l of info.langs ) { if ( spoken.has(l) ) { result.push(tld); break; } }
    }
    return result;
}

/** @public kept from 3P Matrix's resolver: same API in both extensions */
export async function detectForThisBrowser(mode = DEFAULT_MODE) {
    if ( !isCountryResolverReady() ) { await initCountryResolver(); }
    const { langs, timeZone } = await browserEnvironment();
    return { langs, timeZone, continent: homeContinent(langs, timeZone), countries: resolveCountries(mode, langs, timeZone) };
}

// ── Added for uBlock Stripped (10.4.5) ──────────────────────────────────────
// Region subtag of a language tag ("ch" of "de-CH") → ccTLD, only when it is a known country/territory.
export function countryFromRegion(region) {
    const t = requireReady();
    const r = String(region || '').toLowerCase();
    if ( !REGION_RE.test(r) ) { return null; }
    const tld = t.regionToTld[r];
    return tld && t.countryIndex.has(tld) ? tld : null;
}

// IANA time zone → ccTLD (timezones.json `zoneCountry`, from the IANA tz database). UTC/Etc → null.
export function countryFromTimeZone(timeZone) {
    const zones = requireReady().tz.zoneCountry ?? {};
    if ( typeof timeZone !== 'string' || timeZone === '' ) { return null; }
    return Object.hasOwn(zones, timeZone) ? zones[timeZone] : null;
}

// Base languages spoken in a country (normalised through langAliases), in the data's order.
export function languagesOfCountry(ccTld) {
    const info = requireReady().countryIndex.get(String(ccTld || '').toLowerCase());
    return info ? [ ...info.langs ] : [];
}
