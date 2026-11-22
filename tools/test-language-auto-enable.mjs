#!/usr/bin/env node
// test-language-auto-enable.mjs — which language filters switch on at first install (10.4.5), suite step 58.
//
// Drives the REAL js/core/language-auto-enable.js and js/core/country-resolver.js with the REAL shipped data
// (js/data/country-data/*.json) and the REAL built rulesets/ruleset-details.json. Owner's rule: the browser's
// languages first; only when none has a filter, the country (language-tag region, else time zone) and every
// language spoken there. Also: the resolver refuses incomplete rules data (the gap the delivered file had).
// Pure computation over files — nothing to initialise, clear or release beyond the resolver (released at the end).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const resolver = await import(path.join(ROOT, 'js/core/country-resolver.js'));
const { pickLanguageFilters, pickFirstLanguageFilters } = await import(path.join(ROOT, 'js/core/language-auto-enable.js'));

// ── CONFIG ────────────────────────────────────────────────────────────────
const ID = Object.freeze({
    GERMAN: 'ruleset_adguard_german', FRENCH: 'ruleset_adguard_french', ITALIAN: 'ruleset_easylist_italian',
    SPANISH: 'ruleset_adguard_spanish', DUTCH: 'ruleset_adguard_dutch', HUNGARIAN: 'ruleset_hungarian',
    BALKAN: 'ruleset_easylist_bulgarian', BALTIC: 'ruleset_easylist_latvian', NORDIC: 'ruleset_easylist_nordic',
    OTHER_EU: 'ruleset_agbase_overflow_other',
    ENGLISH_OUTSIDE_TOP: 'ruleset_english_outside_top1m',   // (10.7.0) first-language rule
});

function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
const data = {
    countries:     readJson('js/data/country-data/countries.json'),
    languageRules: readJson('js/data/country-data/language-rules.json'),
    timezones:     readJson('js/data/country-data/timezones.json'),
};
const entries = readJson('rulesets/ruleset-details.json');

let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`PASS: ${label}`); }
    catch (err) { failures++; console.log(`FAIL: ${label} — ${err.message}`); }
}
function pick(langs, timeZone = '', uiLanguage = '') {
    const out = pickLanguageFilters(entries, { langs, uiLanguage, timeZone }, resolver);
    return Object.fromEntries([ ...out ].map(([ id, rows ]) => [ id, [ ...rows ].sort() ]));
}

try {
    await check('resolver refuses a rules file without its four tables (the delivered file\'s gap)', async () => {
        const broken = { ...data, languageRules: { ...data.languageRules } };
        delete broken.languageRules.langWorldDefaults;
        await assert.rejects(resolver.initCountryResolver(broken), /langWorldDefaults/);
    });
    await resolver.initCountryResolver(data);

    await check('resolver: the four completed tables work (no throw, sensible answers)', async () => {
        assert.deepEqual(resolver.countriesFromLanguages([ 'nl-BE' ]), [ 'be', 'nl', 'eu' ]);
        assert.ok(resolver.countriesFromLanguages([ 'en' ]).includes('us'));
        assert.deepEqual(resolver.countriesFromLanguages([ 'hu' ]), [ 'hu', 'eu' ]);
    });
    await check('time zone -> country (IANA table, incl. a legacy link name)', async () => {
        assert.equal(resolver.countryFromTimeZone('Europe/Zurich'), 'ch');
        assert.equal(resolver.countryFromTimeZone('Europe/Kiev'), 'ua');
        assert.equal(resolver.countryFromTimeZone('UTC'), null);
    });
    await check('1: a German Swiss browser (de-CH) gets German only — its language has a filter', async () => {
        assert.deepEqual(pick([ 'de-CH', 'de' ]), { [ID.GERMAN]: [] });
    });
    await check('1: every listed language counts (nl + fr)', async () => {
        assert.deepEqual(pick([ 'nl-NL', 'fr' ]), { [ID.DUTCH]: [], [ID.FRENCH]: [] });
    });
    await check('1: combined filter rows — sr -> Serbian, sr-ME -> Montenegro, nb -> Norway, fi -> Finland', async () => {
        assert.deepEqual(pick([ 'sr' ]), { [ID.BALKAN]: [ 'rs' ] });
        assert.deepEqual(pick([ 'sr-ME' ]), { [ID.BALKAN]: [ 'me' ] });
        assert.deepEqual(pick([ 'nb' ]), { [ID.NORDIC]: [ 'no' ] });
        assert.deepEqual(pick([ 'fi' ]), { [ID.BALTIC]: [ 'fi' ] });
        assert.deepEqual(pick([ 'hu' ]), { [ID.HUNGARIAN]: [] });
    });
    await check('2: English browser in Switzerland (time zone) -> German, French, Italian', async () => {
        assert.deepEqual(pick([ 'en' ], 'Europe/Zurich'), { [ID.GERMAN]: [], [ID.FRENCH]: [], [ID.ITALIAN]: [] });
    });
    await check('2: the time zone wins over a tag region (Chrome\'s default en-US on a computer in Zurich)', async () => {
        assert.deepEqual(pick([ 'en-US' ], 'Europe/Zurich', 'en-US'), { [ID.GERMAN]: [], [ID.FRENCH]: [], [ID.ITALIAN]: [] });
    });
    await check('2: a tag region decides only when the zone names no country (en-CH, UTC)', async () => {
        assert.deepEqual(pick([ 'en-CH' ], 'UTC'), { [ID.GERMAN]: [], [ID.FRENCH]: [], [ID.ITALIAN]: [] });
    });
    await check('2: Bosnia and Herzegovina -> its Bosnian, Croatian and Serbian rows', async () => {
        assert.deepEqual(pick([ 'en' ], 'Europe/Sarajevo'), { [ID.BALKAN]: [ 'ba', 'hr', 'rs' ] });
    });
    await check('2: Luxembourg -> French, German and the hidden other-EU bucket (Luxembourgish)', async () => {
        assert.deepEqual(pick([ 'en' ], 'Europe/Luxembourg'), { [ID.OTHER_EU]: [], [ID.FRENCH]: [], [ID.GERMAN]: [] });
    });
    await check('2: official languages only — the US is English (no filter), Puerto Rico gets Spanish', async () => {
        assert.deepEqual(pick([ 'en-US' ], 'America/New_York'), {});
        assert.deepEqual(pick([ 'en-US' ], 'America/Puerto_Rico'), { [ID.SPANISH]: [] });
    });
    // (10.7.0) The English filter for sites outside the top 1M: ONLY when the FIRST browser language is English, and
    // never through the ordinary rule above (it declares `firstLanguage`, not `locales`).
    await check('10.7.0: English filter (outside top 1M) — first language English only, never via the ordinary rule', async () => {
        function firstLang(langs, uiLanguage = '') { return pickFirstLanguageFilters(entries, { langs, uiLanguage }); }
        assert.deepEqual(firstLang([ 'en-GB', 'nl' ]), [ ID.ENGLISH_OUTSIDE_TOP ]);
        assert.deepEqual(firstLang([ 'en' ]), [ ID.ENGLISH_OUTSIDE_TOP ]);
        assert.deepEqual(firstLang([ 'nl', 'en' ]), []);                 // English, but not first
        assert.deepEqual(firstLang([], 'en-US'), [ ID.ENGLISH_OUTSIDE_TOP ]);   // no list: the UI language decides
        assert.deepEqual(firstLang([], ''), []);
        assert.equal(ID.ENGLISH_OUTSIDE_TOP in pick([ 'en-US' ], 'America/New_York'), false);
        assert.equal(ID.ENGLISH_OUTSIDE_TOP in pick([ 'nl', 'en' ], 'Europe/Amsterdam'), false);
    });
    await check('nothing to decide: English in the UK, or no region and an unknown zone', async () => {
        assert.deepEqual(pick([ 'en-GB' ], 'Europe/London'), {});
        assert.deepEqual(pick([ 'en' ], 'UTC'), {});
        assert.deepEqual(pick([], ''), {});
    });
} finally {
    resolver.releaseCountryResolver();   // GUARD (release)
}

if ( failures > 0 ) {
    console.log(`\n${failures} check(s) FAILED.`);
    process.exit(1);
}
console.log('\nPASS: the language filters that switch on at first install follow the owner\'s rule.');
