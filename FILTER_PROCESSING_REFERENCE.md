# Filter processing reference — what happens to each filter, and where

This document answers, per filter: what gets dropped or added, when that
happens, whether the result is a Chrome Web Store "safe rule" (eligible
for skip-review updates) or requires manual review, which module
implements it, and which module the build actually calls to make it
happen.

Everything described here runs **once, at build time, on a developer's
own machine** (`node tools/build-rulesets.mjs`), before packaging. **It
never runs in the user's browser.** At runtime, the extension only reads
the already-compiled JSON files this process produces — the one runtime
exception, and the only one, is noted in §3.

**Chrome's own "safe rule" definition** (verified directly against
Chrome's developer documentation, not assumed): a rule is *safe* — and
therefore update-without-review eligible — if and only if its
`action.type` is `block`, `allow`, `allowAllRequests`, or `upgradeScheme`.
Anything else (`redirect`, `modifyHeaders`, `removeHeaders`) is *unsafe*
and forces manual review for that update.

---

## 1. Universal processing — applies to every filter list below, no exceptions

Before any list-specific treatment, every fetched filter list passes
through the same shared parsing/compilation step
(`tools/build-rulesets.mjs`'s `parseList()`, called once per list from
`build()`).

| What | Detail |
|---|---|
| **Platform directives (11.1.4)** | Applied at download, before any parsing, for every list (`tools/build/list-directives.mjs`, called from `fetchListText()`): AdGuard `!+ PLATFORM(…)` / `!+ NOT_PLATFORM(…)` hints and `!#if` blocks. AdGuard sources are answered as AdGuard's own Chrome MV3 build (`ext_chromium_mv3`; defines `adguard`, `adguard_ext_chromium_mv3`), other sources as uBO Lite on Chromium. Left-out lines: `dropped-platform-rules.txt`. |
| **One network parser (10.7.6)** | Every network line is translated by the SAME parser the Import ABP box uses — `js/core/static-filtering-parser.js` + `parseNetworkFilter()` in `js/core/ubo-parser.js`, owned by this project (no longer tracked against upstream uBO). The build keeps only its own decisions around it in `tools/build/rule-parsers.mjs` (`translateNetworkLine()`: badfilter/exemption lines, wildcard sites, which rule kinds a static list ships). `parseOptions()` / `patternToUrlFilter()` named in older rows below no longer exist. Proven by suite step 74 (`tools/test-network-translation.mjs`). |
| **Regex patterns `/…/` (10.7.6)** | Shipped as `regexFilter` ONLY when Chrome's own `isRegexSupported()` accepts the regex (RE2 memory limit; a case-insensitive regex can fail where the case-sensitive one passes). Verdicts are cached in `tools/regex-support-verdicts.json`; a regex without a verdict starts a headless Chrome once per build (`CHROME_PATH`, puppeteer-core), and is DROPPED when there is no Chrome. Every drop is listed in `dropped-regex-rules.txt`. More than 800 regex rules in one ruleset is a build warning; above Chrome's 1 000 the build stops. Module: `tools/build/regex-support.mjs`; steps 12 and 75. |
| **`$redirect=` (10.7.6)** | Only to a file the extension bundles: `noop.js` (`noopjs`, `abp-resource:blank-js`) `noop-1s.mp4` (`noopmp4-1s`, `abp-resource:blank-mp4`) and, since 11.0.4, `optimizely.js` (uBO's Optimizely surrogate), and since 11.1.4 `google-ima.js` (`ubo-google-ima.js`, AdGuard's `google-ima3`; uBO's Google IMA SDK surrogate) — `js/core/redirect-resources.js`. Any other target drops the line. Unsafe for skip-review, so it lands in the list's unsafe companion (AdGuard Base: `ruleset_adguard_base_unsafe`, new in 10.7.6, toggled with the list; its `$removeparam` rules stay in `ruleset_adguard_base_removeparam`). Same priority as a block: where another rule blocks the same request, the block wins. `$redirect-rule=` is not translated (DNR cannot express "only if something else blocked it"). |
| **`$denyallow=`, `$to=`, `$method=`, `$match-case` (10.7.6)** | Translated: `excludedRequestDomains`, `requestDomains` (narrowed by the geographic scope like the sites), `requestMethods`, `isUrlFilterCaseSensitive`. A rule without a URL target is kept only in the `$denyallow` shape with sites (`*$script,3p,denyallow=…,domain=site`); any other target-less rule is dropped (C13c). `$match-case` on a plain pattern WITH upper-case letters is dropped (the parser lower-cases plain patterns). |
| **Priority order within a list (10.7.6 / 11.1.3, owner's decisions)** | Every rule is raised above its OWN list's priority by its kind (`js/core/dnr-budgets.js`, `staticPriorityOffset()` in `tools/build/rule-parsers.mjs`): plain block +0, `$redirect` +1 (`STATIC_REDIRECT_PRIORITY_OFFSET`), `@@` exception +2 (`STATIC_EXCEPTION_PRIORITY_OFFSET`), `$important` +3 (`STATIC_IMPORTANT_PRIORITY_OFFSET`) — 10 000 / 10 001 / 10 002 / 10 003 for the default lists. This is uBO's and AdGuard's order and the user-rule tier's (+10/+11/+30). Until 11.1.3 blocks, redirects and exceptions shared the list priority, and Chrome's tie-break (allow > block > redirect) made a `$redirect` dead wherever any list blocked the same request (24 shipped redirects, e.g. Ad-Shield's loader redirected to an empty script under HaGeZi's block). `$removeparam` stays at +0 (a blocked request needs no parameters stripped). `$important` rules are never coalesced into the list-priority domain lists; `@@…$important` stays a plain allow. Checked by `tools/check-dnr-priority-order.mjs` (C2). |
| **Not translated (owner's decision, 10.7.6)** | `$csp=` / `$permissions=` (header rules, ~50 lines; their `@@` exceptions cannot be expressed without lifting every block), `$header=` (~6), `$network` (AdGuard blocks an IP for every domain resolving to it — DNR only sees URLs), `$urltransform` (3; rewrites addresses), `$redirect-rule` (~184; DNR cannot make a rule depend on another rule blocking). |
| **`$badfilter` handling** | Dropped, not compiled into any rule, and logged to `dropped-badfilters.txt` for manual review — **except** in `ruleset_badfilter_quickfixes` (see §2.6), where it's converted into an `allow` rule instead. Module: `parseBlockRule()`. |
| **`$cookie`, `$popup`, `$popunder`** | The whole rule is dropped — these options aren't recognized/supported, so the rule can never mean what it said. Module: `parseOptions()`. |
| **`$generichide`, `$genericblock`, `$specifichide`, `$inline-script`, `$inline-font`** (10.7.3) | The whole rule is dropped — they only act ON a page (element hiding / generic blocking off, or the page's own inline code via CSP) and have no network meaning. Before 10.7.3 they were skipped, which turned e.g. `@@||bing.com^$generichide` into an allow of every bing.com request from every site. Same as the runtime import parser. Module: `parseOptions()` (`PAGE_ONLY_OPTIONS`). |
| **Cosmetic / scriptlet lines** (10.7.3 marker fix) | Never network rules: any line with `##`, `#?#`, `#$#`, `#%#`, `#$?#` or their exception forms `#@#`, `#@?#`, `#@$#`, `#@%#`, `#@$?#` leaves `parseBlockRule()` (`COSMETIC_MARKER_RE`). Generic cosmetic exceptions (no site) are dropped; site-specific `#@#` exceptions subtract from that site's hide rules (`cosmetic-data.mjs`). |
| **`$all`** (10.7.2) | Every resource type, the page itself (`main_frame`: a tab or popup window) included — so a host the list marks `$all` is also blocked when it opens as a popup. `~all` drops the rule. Not coalesced (it carries `resourceTypes`). `$popup` stays dropped: DNR cannot tell a popup from a link click (`popup-popunder-abp-import-voorstel.md` Part 4). Module: `parseOptions()`. |
| **`$removeparam`** | Compiles to a `redirect`-action rule (Chrome's only mechanism for stripping a query parameter) — **unsafe** by Chrome's definition. Kept inline by default; see §2.7/§2.8 for the two lists that treat this specially. (10.7.8) Without a value it removes the whole query (`transform.query = ''`, AdGuard's meaning) — only when the line names an address; `$removeparam` on its own or with only `$domain=` is refused, because it would strip the query of every page. Module: `parseNetworkFilter()` (`js/core/ubo-parser.js`), `parseRemoveparamRules()`. |
| **`$domain=name.*` (10.7.8)** | DNR has no wildcard sites. The build replaces `name.*` with every in-scope domain called `name` that the CrUX top-1M snapshot contains (`topSiteDomainsByName()`, `tools/build/crux-top-sites.mjs`; second-level forms such as `name.co.uk` included; out-of-scope TLDs left out by `isTLDKept()`). Before 10.7.8: 33 guessed TLDs, each checked against the same snapshot. No match: the token is dropped (`dropped-wildcard-domains.txt`); expansions are listed in `expanded-wildcard-domains.txt`. Hiding rules and scriptlets keep `name.*` and match it in the page. |
| **Generic (no-domain) cosmetic rules** | Dropped — a bare `##selector` with no hostname prefix is never compiled. A bracket-qualified variant, `[$domain=...]##selector`/`[$domain=...]#%#//scriptlet(...)`, is handled specially for `ruleset_adguard_base` only — see §2.5. Module: `parseCosmeticRules()` / `parseScriptletRules()`. |
| **Geographic scope (10.4.5) — every list, every rule kind** | `GEO_SCOPE` / `OUT_OF_SCOPE_CCTLDS` / `isTLDKept()` in `tools/build/tld-scope.mjs` (one place). In scope: Europe except Moldova, Belarus, Ukraine and Russia (Turkey, Georgia, Armenia, Azerbaijan count as Asia); the Americas (North, Central incl. Caribbean, South); in Asia/Oceania only Australia, New Zealand, South Korea and Japan. A blacklist of ccTLDs derived from `COUNTRY_DATA`/`TERRITORY_DATA`: generic TLDs, `.eu`, unknown ccTLDs (`io`, `ai`, `cc` …) and the worldwide-used `tv to ws fm pw st la so` are kept. Cosmetic/scriptlet hostnames outside the scope are removed (parsers); network rules are dropped when their target host (`\|\|host`, ad servers too) is outside it, and lose their out-of-scope sites in `initiatorDomains` (dropped when none is left) — `applyGeoScopeToNetworkRule()` in `list-parser.mjs`. Guarded by suite step 56 (`tools/check-geo-scope.mjs`). The older notes below that mention `KEEP_TLDS`, `AGBASE_COUNTRY_BLACKLIST`, `networkTldGate` or `agBaseTldKeep()` describe removed mechanisms. |
| **Unknown/unrecognized scriptlet names** | A scriptlet rule whose name doesn't match a real AdGuard corelib function (checked against the plain name, and the `ubo-`/`abp-` prefixed alias forms) produces no dispatch entry — silently, safely dropped. Module: `buildScriptletFile()`. |
| **uBO scriptlet syntax (10.6.5)** | `site##+js(name, …)` / `site#@#+js(…)` lines are converted before any parsing to AdGuard's `site#%#//scriptlet('ubo-name', …)` (exceptions: `#@#//scriptlet(…)`) by `tools/build/ubo-scriptlet-syntax.mjs`, so they run as scriptlets. Until 10.6.4 they reached the cosmetic parser as an invalid "+js(…)" selector, which made the browser drop every hide rule of their site. `parseCosmeticRules()` also skips any `#+js(` line as a second guard; suite step 59 fails if one reaches a cosmetic file. |
| **Scriptlet policy (rules A–D)** | `js/data/scriptlet-policy.js`: trusted scriptlets only from AdGuard sources (A), no code as argument (B), no inserted external URL (C), and (10.6.5) never the uBO json-edit family (D). (11.1.3, owner's decision) Rule A's **safe replacements** (`safeReplacementFor()`, applied by the trust gate in `tools/build/fetch-helpers.mjs` to uBO and AdGuard syntax): a refused rule with exactly a known harmless shape is rewritten instead of dropped — `trusted-replace-argument` blanking a `setAttribute` value → `blank-setattribute-value`; `trusted-set-local/session-storage-item, key, $now$` → `set-storage-item-now`; `trusted-set-attr` on a `data-*` attribute with a plain word → `set-data-attr` (project scriptlets, `js/resources/ubo-patch-scriptlets-source.mjs`); a trusted setter with a plain word or small number → its non-trusted AdGuard twin (`set-cookie`, `set-local-storage-item`, `set-session-storage-item`, `set-constant`, `set-attr`), which applies only its own safe values. Replaced lines are listed in `dropped-policy-scriptlets.txt` under their own reason. Own rules (Custom Rules, ABP import) are still refused, with a message naming the safe equivalent. |
| **Domain coalescing** | Many individual whole-domain block rules get bundled into one rule's `requestDomains` array, to stay under Chrome's rule-count budget. Applies only to plain `block`-action, no-option whole-hostname rules. Module: the coalescing step inside `parseList()`. |

Two lists opt out of parts of this: `ruleset_kees1958_tracking` sets
`skipCosmetic: true` (it has no cosmetic content at all, so cosmetic/
scriptlet parsing is skipped outright — see §2.9).

**Call chain for this shared step:** `node tools/build-rulesets.mjs` →
`build()` → `parseList()` → (`parseBlockRule()` → `parseOptions()` /
`patternToUrlFilter()`) + `parseCosmeticRules()` + `parseScriptletRules()`
→ (later) `buildScriptletFile()`.

---

## 2. Per-filter detail

### 2.1 Kees1958 most-used EU+US ads & tracking networks (`ruleset_kees1958`)

- **a) Dropped/enriched:** nothing beyond §1's universal processing.
  Previously cross-referenced against a popularity/tracker-crossref
  safety filter; that filtering was removed per explicit request — used
  exactly as Kees1958 publishes it.
- **b) When:** build time only.
- **c) Safe/unsafe:** 100% safe (`block` rules only).
- **d) Modules:** `tools/build/kees1958-source.mjs` (fetch + transform, 10.2.0), `tools/build-rulesets.mjs` (compile).
- **e) Build calls:** `build-rulesets.mjs`'s `build()` → `customFetch: buildKees1958SourceText()` (live download, every
  "||domain^…" line → "||domain^$third-party", at least 300 domains or the list is kept from the previous build) →
  `parseList()`. Until 10.1.9 a separate manual pre-step (`build-adtracking-sources.mjs`, removed in 10.2.1) wrote
  `tools/data/kees1958-only-source.txt` and a "full update" silently reused it.

### 2.2 Disconnect — REMOVED 10.7.1

`ruleset_disconnect_other` (Cryptomining + Fingerprinting) and its build module `tools/build/disconnect-source.mjs` are
removed (owner's decision: Disconnect's categories mix real fingerprinters with sign-in, payment and captcha code). Its
Worry-free suppression id 13_000_009 stays reserved; a left-over session rule is removed by
`worry-free-extra-manager.js` (`RETIRED_SUPPRESSION_RULE_IDS`, tested by `tools/test-disconnect-retired.mjs`).

### 2.2a AdGuard tracking-server exceptions (`ruleset_tracking_servers_allowlist`) — added 10.7.1

- **a) Dropped/enriched:** only the `@@` network rules from AdGuard's SpywareFilter `allowlist.txt` whose host IS a domain
  blocked by Kees1958, Peter Lowe or AdGuard tracking servers (or a subdomain of one) — read from those three lists'
  files written earlier in the SAME build. Rules for Android apps (`$app=`) are dropped; wildcard hosts are not matched.
  Site lists go through the geographic scope (every list) and the CrUX top-1M limit (`popularityFilter`).
  `@@…$redirect=` lines are dropped by the parser (they only cancel a redirect).
- **b) When:** build time only. Hidden, always on (no dashboard row, no setting); only matters while the three lists
  block, i.e. during a Seamless surfing session.
- **c) Safe/unsafe:** 100% safe (allow rules only), priority `WORRY_FREE_EXTRA_LISTS_ALLOWLIST_PRIORITY` (8 000, equal to
  the lists — a tie goes to the allow; asserted by `tools/check-dnr-priority-order.mjs` section D).
- **d) Module:** `tools/build/tracking-allowlist-source.mjs`.
- **e) Build calls:** FILTER_LISTS entry after the three parents → `customFetch: buildTrackingAllowlistSourceText()` →
  `parseList()` → popularity filter.

### 2.3 AdGuard tracking servers / EasyList advertising servers / Peter Lowe's list (`ruleset_adguard_tracking_servers`, `ruleset_easylist_adservers`, `ruleset_peterlowe`)

Grouped together — all three get identical treatment via the same function.

- **a) Dropped/enriched:** domains dropped if their TLD isn't generic or
  5-eyes/EU/extended-EU (same shared `GENERIC_TLDS` set as §1's `KEEP_TLDS`, applied here to the
  *network* rule directly, not just cosmetic/scriptlet — the one place
  in this whole pipeline where TLD gating touches a block rule). Note:
  `ruleset_easylist_adservers` no longer merges EasyList's own
  `easylist_adservers.txt` — as of this release it uses **only**
  `easylist_adult/adult_adservers.txt`, per explicit request; the
  dashboard label is unchanged.
- **b) When:** build time only.
- **c) Safe/unsafe:** 100% safe.
- **d) Module:** `tools/build-rulesets.mjs` — `buildWorryFreeLists()` (renamed this release from `buildSingleSourceBlocklistText`; pure rename, same logic).
- **e) Build calls:** `build()` → `customFetch: () => buildWorryFreeLists(SOURCE)` → `fetchList()`/`fetchHostsFormatList()` → `worryFreeInScope()`/`isTLDKept()` per domain → `parseList()`.

### 2.4 Badfilter quick fixes (`ruleset_badfilter_quickfixes`)

- **a) Dropped/enriched:** the *only* list where `$badfilter` is
  **converted, not dropped** — each `$badfilter` line becomes an
  `allow` rule at `BADFILTER_QUICKFIXES_PRIORITY` (600 000 since 9.9.1: above
  the Matrix panel, the sandbox/"Import ABP rules" tier and every list; below
  the built-in whitelist and the pause list). Currently empty upstream (a live placeholder).
- **b) When:** build time only.
- **c) Safe/unsafe:** safe (`allow` rules); any unsafe network rule goes to `ruleset_badfilter_quickfixes_unsafe`
  (10.2.0, declared even while empty). Its scriptlet lines are page code (`-scriptlets.js`, normal release only).
- **c2) Per-site exemptions (10.2.0):** its `@@domain$worryfree` lines ship as ONE carrier
  allow rule inside this ruleset (`js/core/builtin-exemption-carriers.js`: main_frame
  allow at 9 500 — a subset of an allow the extension already applies, so no network change). The runtime
  reads the domains back at SW start (`exempt-domains.js loadBuiltinExemptDomains()`). Was
  `js/generated/exempt-domains-generated.mjs` — adding an exemption to this list is now a SAFE (skip-review)
  update. (10.3.0: `$saferegions` is RETIRED here too — a `@@domain$saferegions` line in this list now
  compiles to nothing and is reported in `dropped-unsupported-list-lines.txt`, same as every other channel.)
- **d) Module:** `tools/build-rulesets.mjs` — the `convertBadfilterToAllow` branch in `parseBlockRule()`; carriers in `stepCompileLists()` (`emitExemptionCarriers`).
- **e) Build calls:** `build()` → direct `url` fetch → `parseList()` (with `convertBadfilterToAllow: true` passed through) → `parseBlockRule()`.

### 2.5 AdGuard Base filter (`ruleset_adguard_base`)

The most heavily processed list — rearchitected this release around a
different underlying model for the country/region question specifically
(blacklist instead of allowlist), scoped to this list only; every other
list in this document is unaffected.

- **a) Dropped/enriched:**
  - 9 of 14 real upstream section files fetched directly (down from 11 —
    `allowlist_stealth`, `general_elemhide`, `banner_sizes` newly
    excluded this release, per explicit request; `content_blocker.txt`/
    `replace.txt` still excluded as before, not applicable to MV3 DNR).
    `foreign.txt` — previously excluded entirely — is now fetched and
    processed via a dedicated routing step (see below), not just dropped
    or included wholesale. `general_url.txt` is fetched separately, as
    its own pre-pass (see the adult-ruleset entry below).
  - `$removeparam`-derived rules still **dropped entirely**
    (`dropRemoveparam: true`), unchanged from before.
  - **Country-code BLACKLIST**, not the shared `KEEP_TLDS` allowlist —
    `AGBASE_COUNTRY_BLACKLIST` (212 codes, derived programmatically from
    the ISO 3166-1 alpha-2 list, minus 5-eyes/EU/extended-EU/four
    already-generic-elsewhere ccTLDs: `io`/`co`/`tv`/`ai`). Applied via a
    new pluggable `tldCheckFn` parameter on `parseCosmeticRules()`/
    `parseScriptletRules()` (reused, not forked) — every other list still
    calls these with the default `isTLDKept()`.
  - **Network rules are now also TLD-gated** — new territory; previously
    only cosmetic/scriptlet rules were TLD-filtered anywhere in this
    project for AG Base specifically (§2.3's lists already did this for
    network rules, but AG Base's own network content never was). New
    `networkTldGate` option on `parseList()`/`parseBlockRule()`, extracts
    the target hostname from `||hostname^...`-shaped patterns and drops
    on a blacklisted TLD. **Accepted trade-off:** some ad-serving
    infrastructure hosted on non-keep ccTLDs, used globally rather than
    just locally, stops being blocked (measured ~1–1.5% of rules in a
    sample section).
  - **`[$domain=...]` generic cosmetic/scriptlet rules** — previously
    silently mis-parsed as a bogus literal hostname (happened to fail the
    TLD check and get dropped, for the wrong reason). Now explicitly
    recognized (`GENERIC_DOMAIN_QUALIFIER_RE`,
    `filterGenericDomainQualifier()`). Real content only ever uses a
    regex inside the brackets (`[$domain=/7tv\d+\.com$/]`) — the literal
    trailing TLD is extracted (`extractTldFromDomainRegex()`) and gated
    against the blacklist. **Architectural limit, not a filtering
    decision:** this codebase's cosmetic/scriptlet dispatch is a static
    hostname-keyed lookup table built once at build time — there is no
    per-page regex-matching path a regex-scoped rule could attach to, so
    every one of these is still dropped regardless of what the TLD check
    says, same functional outcome as before. Logged (not silently
    discarded) to `dropped-generic-domain-qualifiers.txt`, with a
    `wouldKeep` flag reflecting the TLD check alone, so a future
    regex-aware dispatch mechanism has something to work from. A
    plain-pipe-list bracket form is also handled (strip blacklisted
    entries, drop if empty) for forward-compatibility, though none exist
    in real content as of this writing.
  - **`foreign.txt` language routing** (`extractForeignRulesSections()`,
    replacing the old drop-only `stripForeignRulesSection()`) — routes
    each language subsection by name via `LANGUAGE_TO_DESTINATION`.
    Non-Belgian kept languages route into **existing**
    `ruleset_agbase_overflow_*` buckets (Bulgarian, Czech & Slovak,
    Nordic, Latvian, Lithuanian, Italian, Polish, "other") — merged in
    via a second `parseList()` pass over each bucket's routed text (same
    blacklist `tldCheckFn`, DNR ids renumbered to stay unique) inside
    `build()`'s own per-list loop, right after the TLD-based
    `extractCountryOverflow()` step below. "Belgian" routes to its own
    new filter (§2.5a). "Fixing other filters" (a maintenance
    subsection, not a language) stays inline in the main list.
    Everything else — the blacklisted-language majority — is dropped,
    same end state as the old exclude-the-whole-file approach, just
    reached via language-name blacklist matching instead of file-level
    exclusion.
    **Direct answer to "does AG Base drop any country/language
    partitions":** yes. `foreign.txt` upstream currently has 36+
    language subsections (confirmed by live fetch, 10.3.0); only the 19
    named in `LANGUAGE_TO_DESTINATION` above are routed anywhere. Every
    other subsection is silently dropped, unconditionally, for every
    user, regardless of locale — confirmed dropped as of this writing:
    Albanian, Arabian, Armenian, Azerbaijani, Bengali, Bosnian, Burmese,
    Georgian, Hebrew, Hindi, Indian, Indonesian, Khmer, Korean,
    Macedonian, Malaysian, Moldovian, Mongolian, Montenegrin, Nepali,
    Persian, Philippines, Serbian, Singhalese, Swahili, Sinhalese and
    Tamil, Tatar, Thai, Uzbek, Vietnamese. This is a **blacklist by
    omission**, not a region/jurisdiction check — nothing in this
    mechanism tests which countries are "in scope" (that separate
    mechanism, the AG-Base-only TLD blacklist/`agBaseTldKeep()`, was
    retired in 10.0.7 and now keeps every TLD — see the note at the top
    of this entry). A language only ships if someone has explicitly
    added it to `LANGUAGE_TO_DESTINATION` with a real destination
    bucket; everything else is dropped by default, not by design intent
    around any specific country list.
  - **(10.4.5) Combined country filters (owner's decision):** small country filters are STORED as one ruleset and
    SHOWN in the dashboard as separate countries, labelled "Country (language)"; the country tables live once in
    `tools/build/filter-lists.mjs` (`BALKAN_COUNTRIES`, `BALTIC_STATES_COUNTRIES`, `CZECH_SLOVAK_COUNTRIES`,
    `NORDIC_COUNTRIES` — rows, language, browser languages, ccTLDs) and reach the dashboard through
    `ruleset-details.json` `countries`.
    - **Balkan filter** (id `ruleset_easylist_bulgarian`, kept: storage key): Albania, Bosnia and Herzegovina,
      Bulgaria, Croatia, Greece, Kosovo, Montenegro, North Macedonia, Romania, Serbia, Slovenia. Sources: BG Adblock,
      AdGuard Bulgarian, Dandelion Sprout's Serbo-Croatian List, Macedonian adBlock Filters, ROad-Block (light);
      AdGuard Base's Albanian, Bosnian, Bulgarian, Croatian, Greek, Macedonian, Montenegrin, Romanian, Serbian and
      Slovenian sections and its `.al .ba .bg .hr .gr .mk .ro .rs .si` site rules go to its hidden bucket
      `ruleset_agbase_overflow_bulgarian` (`.me` stays in Base: used worldwide).
    - **Baltic states filter** (id `ruleset_easylist_latvian`, kept): Estonia, Finland, Latvia, Lithuania. Sources:
      Latvian List, EasyList Lithuania, Finnish EasyList addition; AdGuard Base's Estonian, Finnish, Latvian and
      Lithuanian sections and `.ee .fi .lv .lt` site rules in `ruleset_agbase_overflow_latvian`. The former
      `ruleset_easylist_lithuanian` (+ its bucket) is retired. (Until 10.5.0 a stored "on" choice was moved
      here; that carry-over was removed with the old conversion code — the stored choice is now pruned.)
    - **Hungarian filter** (`ruleset_hungarian`, new): hufilter's AdGuard-syntax sections (without annoyances,
      cookie banners, self-promotion) + AdGuard Base's Hungarian section and `.hu` site rules
      (`ruleset_agbase_overflow_hungarian`).
    - **Czech & Slovak** shown as Czechia, Slovakia; **Nordic** as Denmark, Iceland, Norway, Sweden — Sweden's `.se`
      rules and AdGuard's Swedish section moved into the Nordic bucket. The hidden "other EU" bucket keeps only
      Cyprus, Luxembourg, Malta.
    - **Korean**: AdGuard Base's Korean section now goes to the Korean filter (was dropped).
    - Which country rows a person added: `js/core/language-filter-countries.js` (Save/Restore, reset, locale
      auto-enable, suite step 57).
    - Dashboard labels: "<language> language" (`language` field), country name only for `showCountry` rows.
    - First install: `js/core/language-auto-enable.js` + `js/core/country-resolver.js` with
      `js/data/country-data/*.json` (single source of the country → languages table, also read by the build).
  - **Country-overflow bucketing** (`extractCountryOverflow()`) —
    unchanged mechanism, still TLD-based, still the same 11 buckets; now
    also receives merged foreign.txt content per the point above.
  - **Popularity filter REMOVED** this release, per explicit request —
    `popularityFilter` / `filterCosmeticMapByPopularity()` no longer
    applied to this list at all. Long-tail-site cosmetic coverage fully
    restored; the ~9MB CrUX fetch no longer runs for any list (this was
    its only consumer).
  - **Adult-site rules pulled out** — see §2.5b; not dropped, re-homed
    into a new hidden companion ruleset.
- **b) When:** build time only.
- **c) Safe/unsafe:** 100% safe (`block`/`allow` only).
- **d) Modules:** `tools/build-rulesets.mjs` —
  `AGBASE_COUNTRY_BLACKLIST`/`isAgBaseBlacklistedTld()`/`agBaseTldKeep()`,
  `extractTldFromDomainRegex()`/`filterGenericDomainQualifier()`,
  `extractNetworkTargetHostname()`, `extractForeignRulesSections()`,
  `extractCountryOverflow()` (unchanged), `extractAdultSiteRules()`.
- **e) Build calls:** `build()` → `customFetch` (multi-section fetch +
  concatenate, `general_url.txt` pre-pass via `extractAdultSiteRules()`,
  `foreign.txt` routing via `extractForeignRulesSections()`) →
  `parseList()` (with `tldCheckFn`/`allowGenericDomainQualifier`/
  `networkTldGate` all set) → `extractCountryOverflow()` → per-bucket
  foreign.txt merge → writes `ruleset_adguard_base.json` + 11
  `ruleset_agbase_overflow_*.json` companion files. Sibling `FILTER_LISTS`
  entries that consume module-level state this `customFetch` populates as a
  side effect must run after this entry (order-dependent). (10.5.1: the
  `general_url.txt` adult-site blocks are only REMOVED here; they ship in
  `ruleset_annoyances` — see §2.5b.)

> **(10.2.1) Unsafe rules of AdGuard Base** go to `ruleset_adguard_base_removeparam`; those that land in one of its 13
> hidden country-overflow buckets go to that bucket's own `<bucket>_unsafe` companion (enabled together with the bucket).
> (`ruleset_adguard_base_adult_unsafe` was removed in 10.5.1 with its parent.) AdGuard anti-adblock has
> `ruleset_adguard_antiadblock_unsafe`. See `js/data/ruleset-companions.js`.

### 2.5a AdGuard Belgian filter (`ruleset_adguard_belgian`) — new this release

- **a) Dropped/enriched:** sourced entirely from AG Base's own
  `foreign.txt` "Belgian" subsection (see §2.5) — not split by
  Flemish/Walloon/German-Belgian, since the upstream subsection is one
  undivided block with no per-rule marker indicating which of the three
  it targets. Nothing else beyond §1's universal processing.
- **b) When:** build time only.
- **c) Safe/unsafe:** 100% safe.
- **d) Module:** `tools/build-rulesets.mjs` — `customFetch: async () =>
  agBaseBelgianText`.
- **e) Build calls:** `build()` → `parseList()`. Visible, opt-in
  (disabled by default) — unlike the hidden overflow buckets, no
  existing companion filter to piggyback on. Auto-enabled by detected
  browser locale specifically for the `BE` region (`nl-BE`/`fr-BE`/
  `de-BE`) — `enableLocaleLanguageFilter()` (`js/workflow/background.js`)
  extended to check the region subtag for this one entry, on top of
  whatever the language subtag alone already triggers (plain Dutch/
  French/German). Real build output: 4 DNR rules, 1 cosmetic hostname —
  small, reflecting the real upstream subsection's own size.

### 2.5b Top-25 adult-site rules — shipped in `ruleset_annoyances` since 10.5.1

Until 10.5.0 these rules were the hidden, always-on `ruleset_adguard_base_adult` (+ an always-empty `_unsafe`
companion). Both are REMOVED (10.5.1, owner's decision); the same rules are now appended to the annoyances list
(§2.11) by `tools/build/adult-site-rules.mjs` → `buildTop25AdultSiteRulesText()`.

- **a) Sources** (each through `fetchList()`'s guard — one failing aborts the build):
  1. AdGuard Base `general_url.txt`: `extractAdultSiteRules()` finds comment-header-delimited blocks whose header
     names one of the 25 sites (`ADULT_SITE_NAME_ALIASES` / direct domain match) and rewrites them `$domain=`-scoped
     to that site. Blocks that mention adult content generically, with no site named, stay in AdGuard Base unscoped.
     `ruleset_adguard_base` runs the same function on its own fetch only to remove the matched blocks.
  2. Own rules: `*/_xa/ads`, `*/_xa/ads_batch?ads=` and third-party websockets (`|ws`, 10.4.9), `$domain=` all 25.
  3. uBlockOrigin/uAssets `filters.txt`, `ubol-filters.txt`, `filters-2026.txt` (GPL-3.0): only lines whose own host
     text names one of the 25 sites (`extractDomainScopedAdultRules()` — cosmetic host prefix, `$domain=` list or
     `||host` prefix; other co-listed hosts dropped; `pornhub.*` resolved to the curated domain; `!#if` blocks
     skipped; `##+js(` lines skipped and counted). Sites AdGuard (1) already covers are skipped.
  4. EasyList adult: top-25 rules the annoyances shape gate would drop (path-only, regex, `$websocket,domain=`),
     narrowed to those sites; rules annoyances already ships unchanged are not repeated.
  - HaGeZi Multi light's hosts on these sites are deliberately NOT copied in (owner, 10.5.1): HaGeZi already blocks
    them while it is enabled.
  - The site list is `tools/build/adult-sites.mjs`'s `ADULT_SITE_DOMAINS` (25, guarded), read through
    `topAdultSiteDomains()`.
- **b) When:** build time; at runtime they behave as part of annoyances (always-on Built-in default, user can untick).
- **c) Safe/unsafe:** annoyances has no unsafe companion, so an unsafe rule from these sources would be dropped with a
  build warning (none at 10.5.1 — the old companion was empty).
- **d) Modules:** `tools/build/adult-site-rules.mjs`; `extractAdultSiteRules()`, `extractDomainScopedAdultRules()`,
  `matchAdultSiteHeader()` in `tools/build/tld-scope.mjs`; `tools/build/filter-lists.mjs` (annoyances entry).
- **e) Build calls:** annoyances `customFetch` → `buildAnnoyancesSourceText()` (gated) + `buildTop25AdultSiteRulesText()`
  (ungated) → `parseList()`. 10.5.1 build: 18 network rules and 58 hide rules carried over unchanged.

### 2.6 AdGuard/EasyList language filters (12 lists: Dutch, German, French, Spanish, Italian, Polish, Portuguese, Latvian, Lithuanian, Czech/Slovak, Nordic, Bulgarian)

Grouped together — identical treatment except French (see below).
**Disabled by default** (opt-in, unlike every other list in this
document).

- **a) Dropped/enriched:** nothing beyond §1 — no TLD gating (unlike
  §2.3), no popularity filter, no country-overflow of their own (they
  *are* one destination for AdGuard Base's overflow content, via
  `RULESET_COMPANIONS`).
- **b) When:** build time only.
- **c) Safe/unsafe (10.2.0):** every country filter (these 12 plus Japanese and Korean) has a declared unsafe-rule
  companion (`js/data/ruleset-companions.js` UNSAFE_RULE_COMPANIONS): French `ruleset_adguard_french_removeparam`,
  the others `<id>_unsafe` — declared even while empty, enabled together with the parent (RULESET_COMPANIONS). The
  main file is always safe-only, so its refresh is a SAFE update. At 10.2.0: French 1, Japanese 1, Korean 4 unsafe
  (redirect) rules — Japanese and Korean used to keep them in the MAIN file, which blocked every SAFE refresh.
- **d) Modules:** `tools/build-rulesets.mjs` (plain `parseList()`), plus `splitUnsafeRules()` in `build-steps.mjs`.
- **e) Build calls:** `build()` → direct `url` fetch → `parseList()` → unsafe rules filtered into the companion file.

### 2.7 Kees1958 most-used tracking parameters (`ruleset_kees1958_tracking`)

- **a) Dropped/enriched:** nothing dropped — this list *is* a pure
  `$removeparam` list by design, nothing else. `skipCosmetic: true` (no
  cosmetic content exists in the source, so §1's cosmetic/scriptlet step
  is skipped outright rather than running over nothing).
- **b) When:** build time only.
- **c) Safe/unsafe:** **unsafe** — every rule is `redirect`-action by
  nature of what `$removeparam` compiles to. This is the one list where
  that's simply unavoidable, not something split out or dropped.
- **d) Module:** `tools/build-rulesets.mjs` — plain `parseList()`.
- **e) Build calls:** `build()` → direct `url` fetch → `parseList()`.

### 2.8 AdGuard and EasyList anti-adblock (`ruleset_adguard_antiadblock`) — reworked 10.6.5 / 10.7.0

- **a) Sources:** AdGuard Base's own `antiadblock` section (moved out of AdGuard Base, 10.6.5), AdGuard Annoyances
  Popups `antiadblock`, EasyList `antiadblock_english`.
- **b) Routing (build time):**
  1. AdGuard Base's section is split by country (`tools/build/antiadblock-country-split.mjs`): rules for sites
     of a country with a language filter are appended to that language filter (TLD → filter map read from AdGuard
     Base's `countryOverflow` buckets and `RULESET_COMPANIONS`); multi-country rules are split per country.
  2. Of the rest, site rules for sites OUTSIDE the CrUX top 1M under a generic TLD or an English-speaking country
     code go to `ruleset_english_outside_top1m` (§2.13). Allow rules (`@@`) never move; exceptions are copied.
  3. `popularityFilter`: the remaining site rules (hide rules, scriptlets, site-scoped network rules) are kept only
     for CrUX top-1M sites; site-less rules are never limited. Geographic scope as in §1.
- **c) Safe/unsafe:** unsafe rules go to `ruleset_adguard_antiadblock_unsafe`.
- **d) Modules:** `filter-lists.mjs` (customFetch), `antiadblock-country-split.mjs`, `english-outside-top-sites.mjs`,
  `site-split.mjs`, `crux-top-sites.mjs`.

### 2.9 Anti-Admiral (`ruleset_antiadmiral`)

- **a) Dropped/enriched:** three independent upstream sources (HaGeZi
  domain list, EasyPrivacy's Admiral-specific rules, a dedicated uBO
  list) merged and **deduplicated** — a domain appearing in more than
  one source is only compiled once. Normalizes HaGeZi's plain
  domain-per-line format (no `||`/`^` markers) into a proper hostname
  block, since the shared ABP-syntax parser would otherwise treat it as
  an unanchored substring match. (10.6.5) Plus uBlock Origin's Admiral
  SITE rules (scriptlets/hide rules naming "admiral", from uAssets
  filters, filters-2025/2026, annoyances-others), trust-gated on the
  selected lines only; limited to CrUX top-1M sites (`popularityFilter`).
  The Admiral and Ad-Shield server domains are never limited.
  (11.1.3, owner's decision) Plus uBlock Origin's WHOLE "Admiral" and
  "Ad-Shield" sections of uAssets `filters-general.txt` (between
  `! SECTION: <name>` and `! !SECTION: <name>`): Admiral (getadmiral.com)
  and Ad-Shield (html-load.com / content-loader.com / error-report.com)
  are two different vendors, and blocking Ad-Shield's loader without its
  site rules made its fallback reload pages in a loop (tomshardware.com).
  uBO's `!#if` preprocessor is answered as uBO Lite on Chromium (the
  project's own copy of uBO's preparser, `js/core/filter-parser-helpers.js`;
  no HTML filtering, so a section's `!#else` branch is taken). A missing
  section fails the build. Same trust gate (with rule A's safe
  replacements) and every later gate.
- **b) When:** build time only.
- **c) Safe/unsafe:** (11.1.3) unsafe rules (the sections' `$redirect`
  rules) go to `ruleset_antiadmiral_unsafe`; the main file stays safe.
- **d) Module:** `tools/build/anti-admiral.mjs` — `buildAntiAdmiralSourceText()`, `selectAdmiralSiteRules()`, `selectUassetsSectionRules()`, `pruneForUbol()`. Test: `tools/test-anti-admiral-sections.mjs` (step 95).
- **e) Build calls:** `customFetch: buildAntiAdmiralSourceText` → `parseList()`.

### 2.13 English language filter for websites outside top 1 Million (`ruleset_english_outside_top1m`) — added 10.7.0

- **a) Sources (hand-offs, build-state.mjs):** AdGuard Base's rules for English-speaking-country sites
  (`ENGLISH_SPEAKING_CCTLDS`) outside the CrUX top 1M — MOVED out of AdGuard Base; and the anti-adblock list's
  generic-TLD/English-country site rules outside the top 1M (§2.8 b2). Allow rules (`@@`) never move;
  cosmetic/scriptlet exceptions are kept in their list AND copied here. No top-1M limit (that is its purpose).
- **b) Runtime:** off by default; switched on once per install when the browser's FIRST language is English
  (`firstLanguage: 'en'`, `pickFirstLanguageFilters()`, marker `firstLanguageFiltersAppliedIn`).
- **c) Safe/unsafe:** unsafe rules go to `ruleset_english_outside_top1m_unsafe`.
- **d) Modules:** `english-outside-top-sites.mjs`, `site-split.mjs`. Must stay after AdGuard Base and the
  anti-adblock list in FILTER_LISTS.

---

### 2.10 HaGeZi's Multi light (`ruleset_hagezi_light`) — added 9.7.3

A normal, always-on **default** filter list (Filter (block) lists tab, enabled out of the box, user can untick it). Sits between Kees1958's tracking-parameters list and AdGuard Base in both `manifest.json` and the dashboard row order.

- **a) Dropped/enriched:** only the exact simple shape `||domain^` is taken (that is 100% of the upstream file's rules; the `[Adblock Plus]` header and `!` comments are skipped). Then (10.5.5) only the entries the selection keeps (see **Source** below). Then the **geographic scope** that applies to every list (see `GEOGRAPHIC_SCOPE.md`): every generic TLD is kept (`.com`, `.net`, `.org`, `.xyz`, `.top` …, plus the country codes used as generic: `.io`, `.tv`, `.cc` …); only country codes outside the scope are dropped (1,118 of 26,623 in 10.5.5). The surviving domains are merged by the shared coalescing step into `requestDomains` rules of at most 4,000 domains each (7 rules in 10.5.5). (Until 10.0.7 a fixed list of about 15 generic TLDs was used here — retired.)
- **b) When:** build time only.
- **c) Safe/unsafe:** 100% safe (`block` rules only).
- **d) Module:** `tools/build-rulesets.mjs` — `buildWorryFreeLists()`, reused (not forked) from §2.3 even though this list is *not* Worry-free-gated: no suppression rule, no `worryFree*Enabled` setting, default `STATIC_FILTER_LIST_PRIORITY`, toggled through `STATIC_RULESET_IDS`/`setRulesetEnabled()` like `ruleset_antiadmiral`. (The function's name still says "WorryFree" for historical reasons.)
- **e) Build calls:** `build()` → `customFetch: buildSelectedHageziLightText` (10.5.5, `tools/build/hagezi-light-selection.mjs`) → `buildWorryFreeLists(HAGEZI_LIGHT_SOURCE)` → selection → `fetchList()` → `worryFreeInScope()` per domain → `parseList()` (`skipCosmetic: true`) → hostname coalescing (`CHUNK_SIZE = 4000`).
- **Source (10.5.5):** HaGeZi's own `adblock/light.txt` again, narrowed by `hagezi-light-selection.mjs`: an entry ships when DuckDuckGo Tracker Radar lists it or a parent (9 regions, no cutoff), it or a parent is a CrUX top-100,000 site, it is on one of the top-25 adult sites, or it or a subdomain was a third-party request on ≥ 50 pages in the newest 3 HTTP Archive snapshots ('.' is the only label boundary). 79,665 entries → 26,623 kept → 25,505 in scope → 7 rules. Shown as "HaGeZi's Multi light (known trackers & top sites)". (10.5.2–10.5.4: Chris Buijs' TOP-N version — HaGeZi light ∩ Tranco top 250,000 — 33,598 in scope, 9 rules.)
- **History:** first shipped in 8.4.5 inside the (since retired, 9.1.7) Worry-free "extra blocklist"; restored in 9.7.3 as a standalone default list. Licence: GPL-3.0 — see `THIRD_PARTY_LICENSES.md`.

### 2.11 AdGuard and EasyList annoyances (specific websites only) (`ruleset_annoyances`) — added 9.9.0

One Worry-free **extra** list (originally the last row after Disconnect; Disconnect removed 10.7.1) merged from six upstream annoyance
lists. It hides in-page prompts, applies a few scriptlets and blocks a few vendor hosts. It does
**not** block new-tab popups: `$popup`/popunder rules are out of scope and `parseBlockRule()` drops
them, so none are carried.

- **a) Dropped/enriched:** sources are AdGuard `popups_specific`, `push-notifications_general`,
  `subscriptions_specific` and EasyList fanboy `notifications`, `newsletter`, `annoyance` (all
  `*_specific_hide` lists). Gates, applied in `tools/build/annoyances-sources.mjs`:
  per-site rules (hide, hide-exception, scriptlet) are kept **only** when the site's TLD is in the
  §1 `KEEP_TLDS` set **and** the site is in the CrUX top-1M — for every TLD, generic or country
  code; `popups_specific` is additionally category-filtered (kept: newsletter, cookie-flag,
  notification, chat, survey, login-wall, promo; dropped: "Sign in with Google", app-install,
  generic modal, unclassifiable elements, and all its network rules); network rules are kept only
  as `||literalhost…` rules whose host is in scope (no top-1M test for a blocked vendor host) —
  path-only patterns, wildcard hosts and any `^` followed by more pattern are dropped, because
  the runtime suppression rule (below) can only be scoped by a literal host. Procedural (`#?#`),
  CSS-inject (`#$#`) and HTML-filtering (`$$`) rules are not carried: the parser cannot use them.
  Rules are expanded to one line per site and exact duplicates across the six lists removed
  (about 3%). No per-country partitions: measured, one list is smaller than a partitioned one.
- **b) When:** the list is built at build time, but it only *takes effect* during a Worry-free
  session and only while its checkbox (`worryFreeAnnoyancesEnabled`, default on) is ticked.
  Network rules: the usual `requestDomains`-scoped suppression allow rule at
  `WORRY_FREE_EXTRA_ALLOW_PRIORITY` (`js/core/worry-free-extra-manager.js`, id
  `WORRY_FREE_ANNOYANCES_RULES_BASE_ID`). Hide rules and scriptlets: registered as content
  scripts only while `getWorryFreeAnnoyancesGate()` (`js/core/compiled-filters.js`) is open —
  `scripting-manager.js` gates both registration functions on it, the session start/end hooks in
  `cookie-clicker-autodeny-manager.js` re-run them, and `@@domain$worryfree` sites are added to
  `excludeMatches`. When the gate closes, the hide-rule data is also removed from storage.
  Network rules of every extra list: a `@@domain$worryfree` site is exempt through a dynamic allow rule at
  `WORRY_FREE_SITE_ALLOW_PRIORITY` (9 500, `js/core/worryfree-manager.js`).
  **Where `@@domain$worryfree` may be written (10.0.0):** the Allow list tab, the ABP-import
  editor, and the built-in `badfilter-quick-fixes.txt` (`rule-parsers.mjs` returns `{ worryfreeExempt,
  domain }` — no DNR rule of its own). All three are
  merged by `js/core/exempt-domains.js`; `tools/check-exemption-channels.mjs` fails if a channel is missing.
  (10.3.0: `$saferegions` is RETIRED — it no longer exempts anything; a `@@domain$saferegions` line in any of
  the three channels now compiles to nothing. `js/generated/safe-region-tld-excludes.mjs` is deleted.)
- **c) Safe/unsafe:** **not** in the "safe" class — it carries scriptlets and hide rules, so it
  cannot ride a skip-review submission (only its 171 `block` network rules are DNR-safe).
- **d) Modules:** `tools/build/annoyances-sources.mjs` (gate + merge), `tools/build/filter-lists.mjs`
  (entry), `js/core/scripting-manager.js`, `js/core/compiled-filters.js`,
  `js/core/worry-free-extra-manager.js`, `js/workflow/security-routes.js`,
  `js/core/cookie-clicker-autodeny-manager.js` (session hooks).
- **e) Build calls:** `build()` → `customFetch` → `buildAnnoyancesSourceText()` (`fetchList()` × 6 →
  `gateAnnoyanceLines()` → merge/de-dupe) + `buildTop25AdultSiteRulesText()` (§2.5b, appended ungated, 10.5.1) →
  `parseList()`. Tests: `tools/test-annoyances-source.mjs`
  (gate), `tools/test-annoyances-suppression.mjs` (network rules), `tools/test-annoyances-registration.mjs`
  (hide rules + scriptlets), `tools/test-worryfree-exemption.mjs` section 4 (pure gate).
- **Size (9.9.0 build):** 13,747 merged lines → 171 network rules (269 hosts), 329 scriptlets,
  6,741 sites with 8,193 unique hide selectors, about 601 KB.
- **Known limits:** category selection is keyword matching on rule text, so it is approximate;
  per-site selectors go stale as sites change; about 22 of its blocked hosts also sit in other
  extra lists, so unticking annoyances while such a list stays ticked leaves those hosts
  suppressed for the session.

### 2.12 Suspicious free hosting & DDNS domains — RETIRED 10.3.0

This section (`ruleset_suspicious_hosting`, added 10.2.0, security-owned — Kees1958
"Suspicious websites" + HaGeZi DynDNS, built by `tools/build/suspicious-hosting.mjs`,
switched on/off by "Block suspicious 3P-requests") described a feature that has been
removed outright along with the Worry-free tiers and Privacy & Security tab's extra
protections (moved to the owner's separate "3P-Matrix — content firewall" extension —
see CHANGELOG_HISTORY.md's 10.3.0 entry). The ruleset no longer ships: it is not in
`manifest.json`'s `rule_resources`, `tools/build/suspicious-hosting.mjs`,
`js/data/security-rulesets.js` and `js/core/security-ruleset-data.js` are deleted, and
`$saferegions` quick-fixes lines that referenced it now compile to nothing (reported in
`dropped-unsupported-list-lines.txt`, same as every other channel — see §2.4's c2).

## 3. Worry-free security rules (not filter lists — included for completeness)

`ruleset_worryfree_3pblock`, `ruleset_worryfree_tldallow`,
`ruleset_worryfree_downloadblock`, `ruleset_worryfree_download_tldallow`
are categorically different from everything above: they're not derived
from any upstream filter list at all. Each is a **synthetic ruleset**
(`customFetch` literally returns a comment placeholder — *"no upstream
source"*) whose real content is generated entirely in code, by a
dedicated function per list (`buildWorryFree3pBlockRule()`,
`buildWorryFreeTldAllowRules()`, `buildWorryFreeDownloadBlockRule()`,
`buildWorryFreeDownloadTldAllowRules()`), reflecting the Security &
Privacy panel's own toggle settings, not any third-party data.

**`ruleset_worryfree_downloadblock` is unsafe** — it uses a
`modifyHeaders` rule to append a CSP `sandbox` directive to
third-party script/sub_frame responses. **Corrected (10.0.3): not the
only other one** — at the time, two more shipped rulesets also carried a
`modifyHeaders` rule: `ruleset_scp_privacy_block` (appended a
`Permissions-Policy` header, the Low-breakage-risk group's `blockScpPrivacy`)
and `ruleset_scp_security_block` (same mechanism, `blockScpSecurity`). **Both
are RETIRED 10.3.0** along with the rest of the Low-breakage-risk group — see
protections.md's RETIRED section. So this one, plus the two `$removeparam`-
derived cases in §2.6/§2.7, now make three unsafe rulesets total in the
entire static-ruleset set — not five.

**Runtime note (the one exception to "everything happens at build
time"):** these four rulesets' actual *content* is still fixed at build
time like everything else, but whether they take effect at all is also
gated by a **runtime-only** mechanism — a higher-priority
session/dynamic allow rule suppresses them unless a Worry-Free session
is actually active. That suppression logic lives in
`js/core/worry-free-extra-manager.js`, not in any build script.

---

## Summary table

| Filter | Safe/unsafe | Build-time treatment beyond §1 | Primary module |
|---|---|---|---|
| Kees1958 (main) | Safe | None (crossref removed); downloaded by the main build since 10.2.0 | `tools/build/kees1958-source.mjs` |
| ~~Disconnect~~ | — | REMOVED 10.7.1 | — |
| AdGuard tracking-server exceptions (hidden, 10.7.1) | Safe | Only `@@` rules hitting the three tracker lists; geographic scope + CrUX top-1M | `tools/build/tracking-allowlist-source.mjs` |
| AdGuard tracking servers | Safe | TLD gating on network rules | `build-rulesets.mjs` (`buildWorryFreeLists`) |
| EasyList adservers | Safe | TLD gating; adult_adservers.txt only | `build-rulesets.mjs` (`buildWorryFreeLists`) |
| Peter Lowe's list | Safe | TLD gating | `build-rulesets.mjs` (`buildWorryFreeLists`) |
| AdGuard and EasyList annoyances | **Not safe** (scriptlets + hide rules) | Six lists merged; top-1M + `KEEP_TLDS` for every TLD; host-anchored network rules only; session-gated at runtime | `tools/build/annoyances-sources.mjs` |
| Badfilter quick fixes | Safe (+ `_unsafe` companion) | `$badfilter` → `allow` (unique); `$worryfree` → carrier allow rule (10.2.0; `$saferegions` RETIRED 10.3.0) | `build-rulesets.mjs` (`parseBlockRule`) |
| AdGuard Base | Safe | Blacklist TLD model (cosmetic+scriptlet+network), foreign.txt language routing, generic-$domain= handling, popularity filter removed, 5 sections excluded | `build-rulesets.mjs` (see §2.5) |
| **AdGuard Belgian** *(new)* | Safe | Sourced from AG Base's own foreign.txt "Belgian" subsection; opt-in, locale-auto-enabled for BE region | `build-rulesets.mjs` (see §2.5a) |
| Language filters (all 14) | Safe (+ unsafe-rule companion each, 10.2.0) | None (opt-in only) | `build-rulesets.mjs` (`splitUnsafeRules`) |
| **Kees1958 tracking params** | **Unsafe** | Pure `$removeparam` list by design | `build-rulesets.mjs` |
| AdGuard anti-adblock | Safe | None | `build-rulesets.mjs` |
| Anti-Admiral (Admiral and Ad-Shield) | Safe; unsafe in `_unsafe` companion (11.1.3) | 3-source merge + dedup, uAssets keyword rules and whole Admiral/Ad-Shield sections | `tools/build/anti-admiral.mjs` (`buildAntiAdmiralSourceText`) |
| **HaGeZi's Multi light** *(9.7.3)* | Safe | Selection (Tracker Radar, top sites, adult top 25, HTTP Archive — 10.5.5) + geographic scope; always-on default, not Worry-free-gated | `build-rulesets.mjs` (`buildSelectedHageziLightText`) |
| ~~AdGuard Base — adult-site rules (hidden)~~ | — | REMOVED 10.5.1: its rules ship in the annoyances list (§2.5b) | — |
| Worry-free 3P-block / TLD-allow | Safe | Synthetic, code-generated | `js/core/worry-free-extra-manager.js`-gated at runtime |
| **Worry-free download-block** | **Unsafe** | `modifyHeaders` CSP sandbox | Same as above |
| Worry-free download TLD-allow | Safe | Synthetic, code-generated | Same as above |
