# Options tab — protections reference (uBlock-Stripped-Dynamic; written for v10.3.0, rows updated through v10.5.0 — no Options-tab row changed after that up to v10.6.4, only the 10.5.1 notice wording; tab renamed from "Privacy & Security" in 10.5.0)

Purpose: one row per dashboard checkbox, stating exactly what mechanism
implements it, so this can be checked line-by-line against the Firefox
sibling ("Power Tools for Adblockers") to see where the two diverge —
same mechanism, different mechanism, or missing entirely.

Every entry below is verified against this extension's actual source as
of this document's writing, not against the dashboard tooltip text alone
(tooltip and code were found to disagree in several places earlier this
project's history — see CHANGELOG_HISTORY.md's 9.7.1 entry).

**10.3.0:** this tab was cut down to two rows (Group 0 only) — see the RETIRED section
below for everything that used to follow. **10.5.0:** `blockPings` removed outright, Worry-free's
startup row folded into Group 0 as its first row, and eight opt-in "at browser start" clears added
(downloads, form data, cache, cookies, cacheStorage, indexedDB, localStorage, serviceWorkers),
bringing Group 0 to ten rows plus the "protections moved" notice below it.

**Allow-list exemption (what `$worryfree` exempts):**
- `@@example.com$worryfree` — the site is outside Worry-free altogether: the Worry-free extra filter lists
  *and* every Worry-free protection, for requests made by the site and requests sent to it. The
  always-on Group 0 rows, the default filter lists and your own rules still apply. Network rules also cover
  third-party frames embedded in that site (10.1.3, an allowAllRequests rule on the page); script protections
  inside such frames still follow the per-frame limit.
- `$saferegions` is RETIRED 10.3.0 — see below. `$worryfree` is unaffected.
- **Built-in whitelist (10.2.0):** every WHITE whitelist domain (`js/data/matrix-constants.js` BUILTIN_DOMAINS —
  payment, sign-in, CAPTCHA, apps, libraries, video embeds) is treated as if written as `@@domain$worryfree`. Hosts
  where anyone can publish (GREY_DOMAINS: jsDelivr, unpkg, esm.sh, npm registry, Google Cloud/Firebase Storage)
  are never trusted — every protection applies to them.

**Where `$worryfree` lines can be written (all three work the same):** the Allow list tab, the ABP-import editor
("Import ABP rules" — the lines stay in the editor text and are processed from there, never compiled as network
rules), and the built-in `badfilter-quick-fixes.txt` list. See ARCHITECTURE.md's HARD CONSTRAINT on the three channels.

**Gating vocabulary used below:**
- **Always on** — no Worry-free relationship; active whenever its own
  checkbox is checked, full stop. Every row in Group 0 is this (gating, not default state —
  see each row for whether its checkbox starts checked).

---

## Group 0 — "On startup" (was "Privacy enhancements")

Heading renamed "On startup" (10.5.0) once Worry-free's own startup row (`startWorryFreeOnBrowserStartup`)
was folded into this group as its first row — every row here is a browser-start-time action, so one
heading says that once; row labels below dropped their own "at browser start" suffix for the same
reason (tooltips keep the full wording). Also given its own margin-top (`section[data-pane="security"] > h3:first-child` in
settings.css) — this tab's first element, previously flush against the tab bar with no other tab's
heading getting any top margin either, but the owner asked for air above this one specifically.

### Enable Worry-free surfing.
- **Setting key:** `startWorryFreeOnBrowserStartup`
- **Gating:** always on (when checked); default ON (10.5.0)
- **Mechanism:** `startAutoDeny()` (`js/core/cookie-clicker-autodeny-manager.js`), consulted once per
  genuine browser launch.
- **Scope/limits:** starts a Worry-free session at launch; does not touch the five Worry-free
  filter-list toggles (Filter (block) lists tab).

### Clear browsing history.
- **Setting key:** `deleteHistoryOnStart`
- **Gating:** always on
- **Mechanism:** `js/core/history-cleaner.js` calls
  `browser.browsingData.remove({ since: 0 }, { history: true })` on every
  genuine browser launch (a one-time-per-launch guard prevents it firing
  on every service-worker wake). `since: 0` = clear all history, not a
  rolling window.
- **Scope/limits:** history only. Cookies, cache, passwords, and site
  permissions are never included in the removal call — not merely
  excluded by omission of a flag, the code never asks for them at all.

### Clear list of downloaded files. (10.5.0, default OFF)
- **Setting key:** `clearDownloadsOnStart`
- **Gating:** always on (when checked)
- **Mechanism:** `js/core/history-cleaner.js`'s `clearBrowsingDataOnBrowserStartup()` includes
  `downloads: true` in the same `browser.browsingData.remove({ since: 0 }, ...)` call `deleteHistoryOnStart`
  uses, only when this checkbox is on.
- **Scope/limits:** clears the Downloads-page list of records only — the downloaded files on disk are
  never touched.

### Clear data typed into search/form fields. (10.5.0, default OFF)
- **Setting key:** `clearFormDataOnStart`
- **Gating:** always on (when checked)
- **Mechanism:** same call, `formData: true`.
- **Scope/limits:** remembered autofill values typed into search/form fields. Saved passwords and
  payment/card info are a separate browsingData type (`passwords`) this feature never requests.

### Clear HTTP cache. (10.5.0, default OFF)
- **Setting key:** `clearCacheOnStart`
- **Gating:** always on (when checked)
- **Mechanism:** same call, `cache: true`.
- **Scope/limits:** cached page resources only (images, scripts, stylesheets). Cookies and other site
  storage are untouched.

### Clear cookies. (10.5.0, default OFF)
- **Setting key:** `clearCookiesOnStart`
- **Gating:** always on (when checked)
- **Mechanism:** same call, `cookies: true`.
- **Scope/limits:** every website's cookies — the person is signed out everywhere on the next browser
  start. Saved passwords are a separate browsingData type this feature never requests. The one row in
  this group with a real day-to-day cost, which is why it stays its own explicit opt-in rather than
  folding into `deleteHistoryOnStart`.

### Clear app cache storage. (10.5.0, default OFF)
- **Setting key:** `clearCacheStorageOnStart`
- **Gating:** always on (when checked)
- **Mechanism:** same call, `cacheStorage: true` — the Cache API store used by service workers/PWAs,
  distinct from the ordinary HTTP cache above.
- **Scope/limits:** service-worker/PWA cached responses only.

### Clear site databases (IndexedDB). (10.5.0, default OFF)
- **Setting key:** `clearIndexedDbOnStart`
- **Gating:** always on (when checked)
- **Mechanism:** same call, `indexedDB: true`.
- **Scope/limits:** sites' own IndexedDB databases (shopping carts, offline app data, etc.).

### Clear site storage (localStorage). (10.5.0, default OFF)
- **Setting key:** `clearLocalStorageOnStart`
- **Gating:** always on (when checked)
- **Mechanism:** same call, `localStorage: true`.
- **Scope/limits:** sites' own `localStorage`/`sessionStorage` data.

### Clear site service workers. (10.5.0, default OFF)
- **Setting key:** `clearServiceWorkersOnStart`
- **Gating:** always on (when checked)
- **Mechanism:** same call, `serviceWorkers: true`.
- **Scope/limits:** unregisters sites' own registered service workers; a site that uses one
  re-registers it on the next visit.

---

## RETIRED 10.3.0 — moved to "3P-Matrix — content firewall"

By explicit request, everything below Group 0 is removed from this extension: the
`blockPaymentHandlers`/`blockWebBundles`/`blockDialogSpam` rows that used to sit in
Group 0 alongside `deleteHistoryOnStart`/`blockPings` (the latter itself removed outright in 10.5.0,
see below); the entire "Very low website
breakage risk" group (`blockLocalNetwork`, `blockProtocolHandlers`,
`blockSuspicious3pLinks`, `blockClipboardCommandWrite`, `blockAdultNoEval`); the entire
"Low website breakage risk" group (`blockScpPrivacy`, `blockScpFingerprint`,
`blockScpSecurity`, `blockObfuscatedEval`, `enforceMediumSandboxSafeScripts`); the
already-mostly-RETIRED "Medium website breakage risk" group in full; the two
Worry-free tier checkboxes on the Filter (block) lists tab
(`worryFreeSecurityTldProtectionsEnabled`, `worryFreeSafeRegionsEnabled`) and the
editable "safer region" TLD list; and the `$saferegions` Allow-list/quick-fixes/
ABP-import option. The code behind all of it — `js/core/worry-free-tiers.js`,
`js/core/worry-free-high-risk-headers-manager.js`,
`js/core/worry-free-familiar-tld-manager.js`, `js/core/saferegions-manager.js`,
`js/core/security-ruleset-data.js`, `js/core/matrix-detect.js`,
`js/core/forced-download-detection.js`, 12 of the 13 `js/security/sec-*.js`
scriptlets (`sec-pings.js` survived 10.3.0 but was removed outright in 10.5.0, see below), and their
supporting data files — is deleted outright. Those protections moved to the owner's separate extension,
"3P-Matrix — content firewall" (available in the Chrome Web Store). Full technical
account: CHANGELOG_HISTORY.md's 10.3.0 entry.

**10.5.0, `blockPings` REMOVED OUTRIGHT** (owner's request — low standalone value, most tracking now
goes through `sendBeacon`/`fetch(keepalive)`, which it never touched): `js/security/sec-pings.js`
deleted (the folder is now empty and deleted with it), its `SECURITY_SCRIPTLETS` entry removed from
`js/core/compiled-filters.js` (now an empty array), its `securityConfig`/`securityAllowlist` keys
removed from `js/data/config.js`, and its dashboard row removed. `SECURITY_SCRIPTLETS` and the
`SECURITY_SCRIPTLET_TOGGLE_KEYS` dispatch Set are kept as empty, not deleted, so a future security
scriptlet needs no new plumbing — just a new entry/key.

Kept, unchanged from the rows documented above: `deleteHistoryOnStart`,
the Worry-free filter-list toggles (AdGuard tracking, Kees1958,
Peter Lowe, AdGuard remove-param; Disconnect removed 10.7.1 — Filter (block) lists tab, not this tab, so not
documented in this file), `startWorryFreeOnBrowserStartup` (on this tab since 10.5.0, default ON —
"Enable Worry-free surfing"), and the `$worryfree`
per-site exemption itself in all three channels (Allow list, quick-fixes list,
ABP-import). The "Confirmed Firefox comparison findings" and "Shared mechanisms"
sections that used to follow here (forced-download detection, the `RISK_LOW`
fingerprint signal set, the Worry-free tier hierarchy) covered only retired rows and
are removed with them — nothing in this document's remaining scope (Group 0's rows)
shares a mechanism with anything else. (10.5.0: Group 0 grew to ten rows — Worry-free's own startup
row folded in as the first row, `blockPings` removed, and eight "at browser start" clears added —
history (default on) plus seven opt-in: downloads, form data, cache, cookies, cacheStorage, indexedDB,
localStorage, serviceWorkers — all via the same `browser.browsingData.remove()` call.)

## Known gaps in this document
- Not independently re-verified in a live browser for this write-up — Group 0's rows
  are sourced from the extension's actual 10.3.0/10.5.0 code, not re-checked against a
  live Chrome session.
- No Firefox-sibling comparison has been done for Group 0's rows specifically;
  the comparison work recorded in earlier versions of this document covered only
  the now-retired rows above.
