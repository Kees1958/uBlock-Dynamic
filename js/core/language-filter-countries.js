/*
 * language-filter-countries.js — which COUNTRY rows the person added for a combined language filter (10.4.5).
 *
 * Some small language filters are stored as ONE ruleset but shown in the dashboard as separate countries
 * (owner's decision): the Balkan filter (Albania, Bosnia and Herzegovina, Bulgaria, Croatia, Greece, Kosovo,
 * Montenegro, North Macedonia, Romania, Serbia, Slovenia), the Baltic states filter (Estonia, Finland, Latvia,
 * Lithuania), the Czech & Slovak filter (Czechia, Slovakia) and the Nordic filter (Denmark, Iceland, Norway,
 * Sweden). The country list itself comes from the build (ruleset-details.json `countries`); this
 * module only remembers which of them the person has added, so the dashboard can show exactly those rows.
 * The ruleset stays on while at least one of its countries is added (dashboard/filter-manager-ui.js).
 *
 * Data element (C41):
 *   Created — dashboard "add country", locale auto-enable on first install, the 10.4.5 migration
 *             (static-rulesets.js: retired Lithuanian filter, rows for filters that were on before 10.4.5)
 *   Read    — dashboard rows (MSG_GET_LANGUAGE_FILTER_COUNTRIES)
 *   Updated — dashboard add / remove (MSG_SET_LANGUAGE_FILTER_COUNTRIES), Restore settings (replace)
 *   Deleted — removing the last row empties the entry; "Reset to defaults" clears all extension storage
 *
 * Public interface:
 *   getLanguageFilterCountries()                   — { rulesetId: [countryId, ...] } (a copy)
 *   setLanguageFilterCountries(rulesetId, ids)     — replaces one ruleset's list ([] removes the entry)
 *   addLanguageFilterCountries(rulesetId, ids)     — adds ids to one ruleset's list (no duplicates)
 *   replaceLanguageFilterCountries(map)            — replaces the whole map (Restore settings)
 *
 * Storage: chrome.storage.local, key STORAGE_KEY (through data/ext.js, C4). Every input is validated (C6);
 * a bad entry is dropped with a warning, never stored.
 */

import { localRead, localWrite } from '../data/ext.js';

// ── CONFIG ──────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'languageFilterCountries';
const RULESET_ID_RE = /^ruleset_[a-z0-9_]+$/;    // a static ruleset id
const COUNTRY_ID_RE = /^[a-z]{2,3}$/;            // an ISO country code as used in ruleset-details.json
const MAX_RULESETS = 50;                          // guard: far above the number of combined filters
const MAX_COUNTRIES_PER_RULESET = 40;             // guard: far above the largest group (11)

function sanitizeIds(ids) {
    if ( Array.isArray(ids) === false ) { return []; }
    const clean = [ ...new Set(ids.filter(id => typeof id === 'string' && COUNTRY_ID_RE.test(id))) ];
    return clean.slice(0, MAX_COUNTRIES_PER_RULESET);
}

function sanitizeMap(map) {
    const out = {};
    if ( map === null || typeof map !== 'object' || Array.isArray(map) ) { return out; }
    for ( const [ rulesetId, ids ] of Object.entries(map).slice(0, MAX_RULESETS) ) {
        if ( RULESET_ID_RE.test(rulesetId) === false ) {
            console.warn(`[uBlock-Dynamic] language-filter-countries: invalid ruleset id ignored: ${rulesetId}`);
            continue;
        }
        const clean = sanitizeIds(ids);
        if ( clean.length > 0 ) { out[rulesetId] = clean; }
    }
    return out;
}

async function readMap() {
    try {
        return sanitizeMap(await localRead(STORAGE_KEY));
    } catch (err) {
        console.error('[uBlock-Dynamic] language-filter-countries: read failed:', err);
        return {};
    }
}

async function writeMap(map) {
    try {
        await localWrite(STORAGE_KEY, sanitizeMap(map));
        return true;
    } catch (err) {
        console.error('[uBlock-Dynamic] language-filter-countries: write failed:', err);
        return false;
    }
}

export async function getLanguageFilterCountries() {
    return readMap();
}

export async function setLanguageFilterCountries(rulesetId, ids) {
    if ( typeof rulesetId !== 'string' || RULESET_ID_RE.test(rulesetId) === false ) {
        console.warn('[uBlock-Dynamic] setLanguageFilterCountries: invalid ruleset id', rulesetId);
        return false;
    }
    const map = await readMap();
    const clean = sanitizeIds(ids);
    if ( clean.length === 0 ) { delete map[rulesetId]; } else { map[rulesetId] = clean; }
    return writeMap(map);
}

export async function addLanguageFilterCountries(rulesetId, ids) {
    const map = await readMap();
    return setLanguageFilterCountries(rulesetId, [ ...(map[rulesetId] ?? []), ...sanitizeIds(ids) ]);
}

export async function replaceLanguageFilterCountries(map) {
    return writeMap(map);
}
