/*
 * country-language-data.mjs — country → continent → spoken-language reference
 * data. Pure data, no logic.
 *
 * (10.4.5) The data now lives in js/data/country-data/countries.json (read below) — shared with the runtime
 * again for the language-filter auto-enable. Historical note — BUILD-TIME ONLY since 10.3.0 (moved from js/data/): its one runtime
 * consumer, the editable "safer region" TLD list
 * (js/core/worry-free-familiar-tld-manager.js), was removed together with
 * the Privacy & Security extra protections. The build's TLD scoping
 * (tools/build/tld-scope.mjs) still reads COUNTRY_DATA/TERRITORY_DATA.
 * Notes below that mention the familiar-TLD manager describe where this
 * data came from, not a live consumer.
 *
 * Ported from the person's own sibling extension, 3P-Matrix-lite's
 * data/country-data.js (core/tld-engine.js's CONTINENT/WORLDWIDE
 * auto-detection modes), per explicit request to replace this codebase's
 * own browser-language-only default computation with the CONTINENT-level
 * one — see js/core/worry-free-familiar-tld-manager.js's own header for
 * the full feature and exactly which parts of that source were and
 * weren't carried over.
 *
 * Source (per 3P-Matrix-lite's own file): "Countries per continent with
 * languages.docx" (196 sovereign countries). Antarctica is deliberately
 * omitted — no permanent population, and its only entry (.aq, en) would
 * just add noise to every English speaker's list.
 *
 * Data conventions (unchanged from the source):
 *   - Entries are keyed by the country's ccTLD (lowercase, no dot),
 *     grouped under a CONTINENTS value.
 *   - The array lists the BASE language codes spoken there (the "nl" of
 *     "nl-BE"). The region half of the source document's tags is
 *     dropped: it always equals the TLD, with one exception — the UK,
 *     whose region code is "gb" but whose TLD is "uk" (see
 *     REGION_TLD_EXCEPTIONS).
 *   - Codes are stored exactly as the source document has them. Alias
 *     normalisation (nb → no, etc.) happens at lookup time, in
 *     js/core/worry-free-familiar-tld-manager.js, via LANG_ALIASES below
 *     — so this data stays a faithful copy of its source.
 *   - Continent assignment follows the source document: Cyprus and
 *     Russia are Europe, Türkiye/Georgia/Armenia/Azerbaijan/Kazakhstan
 *     are Asia, Central America and the Caribbean are North America.
 *
 * Public interface: CONTINENTS, COUNTRY_DATA, TERRITORY_DATA,
 * REGION_TLD_EXCEPTIONS, LANG_ALIASES, MUTUALLY_INTELLIGIBLE_LANGS,
 * ONE_WAY_INTELLIGIBLE_LANGS, EXPANSION_EXCLUDED_TLDS,
 * TIMEZONE_AREA_DEFAULT, TIMEZONE_PREFIX_EXCEPTIONS, TIMEZONE_EXCEPTIONS
 *
 * Dependencies: none (pure data).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// (10.4.5) SINGLE SOURCE: js/data/country-data/countries.json (the same table 3P Matrix uses — identical to the
// copy that used to be written out here, checked before switching). The extension reads it at runtime
// (js/core/country-resolver.js, language-filter auto-enable); the build reads it here (geographic scope).
const COUNTRIES_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../js/data/country-data/countries.json');
const COUNTRIES = JSON.parse(fs.readFileSync(COUNTRIES_JSON, 'utf8'));
if ( !COUNTRIES?.continents || !COUNTRIES?.countries || !COUNTRIES?.territories ) {
    throw new Error(`country-language-data: ${COUNTRIES_JSON} lacks continents/countries/territories`);
}

// Continent identifiers — the only valid keys of COUNTRY_DATA/TERRITORY_DATA. Compare against these, never
// against bare strings.
export const CONTINENTS = Object.freeze({ ...COUNTRIES.continents });

// Sovereign countries and territories: { continent: { ccTLD: [ base language codes ] } }.
export const COUNTRY_DATA = COUNTRIES.countries;
export const TERRITORY_DATA = COUNTRIES.territories;


// (10.3.0 removal) REGION_TLD_EXCEPTIONS, LANG_ALIASES,
// MUTUALLY_INTELLIGIBLE_LANGS, ONE_WAY_INTELLIGIBLE_LANGS,
// EXPANSION_EXCLUDED_TLDS, TIMEZONE_AREA_DEFAULT,
// TIMEZONE_PREFIX_EXCEPTIONS and TIMEZONE_EXCEPTIONS removed — their
// one consumer, js/core/worry-free-familiar-tld-manager.js (browser
// language/timezone -> "familiar countries" TLD allowlist, a Worry-free
// tier feature), was deleted along with the Privacy & Security tab
// sections and Worry-free tiers it belonged to (see CHANGELOG.md's
// 10.3.0 entry). COUNTRY_DATA/TERRITORY_DATA above stay — tld-scope.mjs
// still reads both directly.
