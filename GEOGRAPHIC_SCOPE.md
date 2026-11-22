# Geographic scope — which domains the filters keep

One gate for every filter list and every rule kind (network, cosmetic, scriptlet). A hostname whose TLD is
**out of scope** is removed from the build output. Network rules are dropped when their target host is out
of scope, and their site list loses every out-of-scope site.

- **Source of truth:** `GEO_SCOPE` in `tools/build/tld-scope.mjs`. This document describes it; the code decides.
- **Model:** a blacklist. Generic TLDs (`com`, `net`, `org`, `xyz` …) are always kept. A country code is out of
  scope only when it is listed or derived as out of scope below.
- **Status:** since 10.4.9 (.su, the overseas-territory category and the explicit lists are new in 10.4.9).

## In scope

| Area | Rule |
|---|---|
| Europe | Every country **except** Belarus (.by), Moldova (.md), Russia (.ru), Ukraine (.ua) |
| North and Central America, incl. the Caribbean | Every country |
| South America | Every country |
| Asia/Oceania | Only Australia (.au) and New Zealand (.nz) |
| Generic TLDs | All (`com`, `net`, `org`, `app`, `xyz` …) |
| Non-Latin names | Only Cyrillic (Bulgarian, Serbian, Macedonian) and Greek scripts are kept, besides Latin |

**Countries and territories from the country data, in scope:**
- Europe (41): Andorra, Albania, Austria, Bosnia & Herzegovina, Belgium, Bulgaria, Switzerland, Cyprus,
  Czechia, Germany, Denmark, Estonia, Spain, Finland, France, Greece, Croatia, Hungary, Ireland, Iceland,
  Italy, Liechtenstein, Lithuania, Luxembourg, Latvia, Monaco, Montenegro, North Macedonia, Malta,
  Netherlands, Norway, Poland, Portugal, Romania, Serbia, Sweden, Slovenia, Slovakia, San Marino,
  United Kingdom, Vatican City. Territories: Faroe Islands (.fo), Isle of Man (.im).
- North and Central America (23): Antigua & Barbuda, Barbados, Bahamas, Belize, Canada, Costa Rica,
  Cuba, Dominica, Dominican Republic, Grenada, Guatemala, Honduras, Haiti, Jamaica, St Kitts & Nevis, St Lucia,
  Mexico, Nicaragua, Panama, El Salvador, Trinidad & Tobago, United States, St Vincent & Grenadines.
  Territories: Aruba (.aw), Curaçao (.cw), Greenland (.gl), Puerto Rico (.pr).
- South America (12): Argentina, Bolivia, Brazil, Chile, Colombia, Ecuador, Guyana, Peru, Paraguay, Suriname,
  Uruguay, Venezuela.
- Oceania: Australia (.au), New Zealand (.nz).

## Country codes used as generic — kept (`GENERIC_USE_CCTLDS`)

Out-of-scope countries, or codes the country data does not know, whose TLD is used worldwide as a
generic name (streaming, short links, analytics, tech):

Tuvalu (.tv), Tonga (.to), Samoa (.ws), Micronesia (.fm), Palau (.pw), São Tomé & Príncipe (.st), Laos (.la),
Somalia (.so), Libya (.ly), British Indian Ocean Territory (.io), Cocos Islands (.cc), St Helena (.sh),
Ascension Island (.ac), Niue (.nu).

## Territories not in the country data — kept (`UNLISTED_TERRITORIES_IN_SCOPE`)

Territories of in-scope countries that lie in Europe, the Americas or the Australia/New Zealand region:

- Europe: European Union (.eu), Åland (.ax), Guernsey (.gg), Jersey (.je), Gibraltar (.gi).
- Americas (incl. Caribbean): Anguilla (.ai), Bermuda (.bm), Cayman Islands (.ky), Montserrat (.ms),
  Turks & Caicos (.tc), British Virgin Islands (.vg), US Virgin Islands (.vi), Guadeloupe (.gp), Martinique (.mq),
  French Guiana (.gf), St Pierre & Miquelon (.pm), Sint Maarten (.sx), Bonaire/St Eustatius/Saba (.bq),
  Falkland Islands (.fk), South Georgia (.gs).
- Australia / New Zealand: Christmas Island (.cx), Norfolk Island (.nf), Heard & McDonald Islands (.hm),
  Cook Islands (.ck), Tokelau (.tk).

Former Dutch Caribbean: Aruba (.aw), Curaçao (.cw), Sint Maarten (.sx) and Bonaire/St Eustatius/Saba (.bq) are
all in scope. (.an, Netherlands Antilles, was retired in 2015.)

## Out of scope

- **Europe:** Belarus, Moldova, Russia, Ukraine (`EXCLUDED_IN_KEPT_CONTINENTS`).
- **Soviet Union (.su)** — still in use, mostly by Russian sites; treated like .ru (`EXCLUDED_UNLISTED_CCTLDS`).
- **Overseas territories outside Europe, the Americas and Australia/New Zealand**
  (`OVERSEAS_TERRITORIES_OUT_OF_SCOPE`, a separate category so they are easy to bring back):
  Réunion (.re), Mayotte (.yt), New Caledonia (.nc), French Polynesia (.pf), Wallis & Futuna (.wf),
  French Southern Territories (.tf), American Samoa (.as), Guam (.gu), Northern Mariana Islands (.mp),
  Pitcairn (.pn).
- **Every country of Africa, Asia and Oceania** not named above as in scope or generic, incl. Hong Kong (.hk) and
  Macao (.mo). Turkey, Georgia, Armenia and Azerbaijan count as Asia in the country data.
- **Non-Latin names** in any script other than Latin, Cyrillic and Greek, and the non-Latin ccTLDs of
  out-of-scope countries (.рф, .укр, .бел, .қаз, .мон, Chinese, Korean).

## How to change the scope

All changes are made in `GEO_SCOPE` (`tools/build/tld-scope.mjs`), then a full filter rebuild.

| To … | Do |
|---|---|
| Include an overseas territory again | Move its code from `OVERSEAS_TERRITORIES_OUT_OF_SCOPE` to `UNLISTED_TERRITORIES_IN_SCOPE` |
| Exclude a European/American country | Add its code to `EXCLUDED_IN_KEPT_CONTINENTS` |
| Include a country of another continent | Add its code to `KEPT_COUNTRIES` |
| Keep a country code used as generic | Add it to `GENERIC_USE_CCTLDS` |
| Exclude a code the country data does not know | Add it to `EXCLUDED_UNLISTED_CCTLDS` |

The build refuses a scope with a mistake in it: a hand-listed unknown code that is in the country data, a code
in two lists, a generic-use code of an in-scope continent, or an excluded country not on a kept continent.

**Known limit:** a country code that is unknown to the country data and in none of the lists is kept by default.
There is no complete official ccTLD list offline to check this against.

**Release type:** removing domains from the network rulesets alone qualifies for a SAFE (skip-review) update.
If a scope change also changes a scriptlet or hide-rule file, that update needs a normal review release.
