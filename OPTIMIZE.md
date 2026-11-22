# Performance optimization tracker

Working document, same genre as the `Xplainer_*` files — analysis and
an implementation plan, not end-user documentation. Findings are from
direct code inspection (exact file/function/line cited for each), not
guesses. Status is updated as items are implemented; nothing below is
implemented yet unless marked otherwise.

Priorities and sequencing were set explicitly:
- **Priority 1 — running process.** Background/registration-pipeline
  costs that apply on every page load and every service-worker cold
  start, regardless of which feature the user touches.
- **Priority 2 — powertools** (Element Picker, Matrix panel/Dynamic
  DNR, Privacy Inspector).
- **Priority 3 — ad hoc user-initiated actions** (Save/Restore
  Settings, Manage Custom Rules import/export, bulk Allow-list save).

Within each priority, items are ordered by expected performance impact.

---

## Priority 1 — Running process

### 1.1 — `registerContentScripts()` does a blanket wipe-and-rebuild on every call — STATUS: ✅ IMPLEMENTED

**Where:** `registerContentScripts.register()` in
`js/core/scripting-manager.js` (~874).

**Mechanism:** calls `browser.scripting.unregisterContentScripts()`
with no `ids` filter (line 898) — unregisters *every* registered
content script — then re-registers all five namespaced groups
(security scriptlets, AdGuard scriptlet injection, AdGuard cosmetic
injection, cookie-clicker, cookie-clicker auto-deny) plus the
`css-user` custom-filter directive built by `registerCustomFilters()`
(`js/core/filter-manager.js` ~551). **All five namespaced groups
already have real existing-vs-wanted diff logic of their own** —
verified by reading each one fully, not assumed: the two originally
found (`registerScriptletContentScriptsImpl()`,
`registerCosmeticContentScriptsImpl()`, full-set id diffing) plus three
more confirmed the same day (`registerSecurityContentScriptsImpl()`,
full-set id diffing; `registerCookieClickerContentScriptsImpl()` and
`registerCookieClickerAutoDenyContentScriptsImpl()`, single-directive
existence checks). The blanket wipe defeats all five identically, not
just the two originally cited.

**Correction to the original finding — the wipe is load-bearing for
one path, not pure waste:** `registerCustomFilters()` builds its
`css-user` directive and only ever does `context.toAdd.push(directive)`
— it has **no existence check, no `updateContentScripts()` path, and
no unregister path of its own**. If the custom-filter set becomes empty
(e.g. the user deletes their last custom cosmetic rule), the function
returns early and pushes nothing — it never unregisters the
previously-registered `css-user` script. And the outer function's own
handling of `context.toAdd` (~922) calls the raw
`browser.scripting.registerContentScripts(toAdd)` — never
`updateContentScripts()` — which throws "duplicate script id" if
`css-user` is already registered from a prior cycle. **Removing the
blanket wipe without first giving `registerCustomFilters()` its own
diff/removal logic would leave stale `css-user` registrations behind
forever, or start throwing duplicate-id errors on every custom-filter
change.** CHANGELOG history (~13611) confirms the wipe itself is
inherited from the upstream uBOL 3.9 base, not something this fork
added — every past fix in this area (the three-group re-registration
fix, the later security-scripts fix) added *more* re-registration after
the wipe rather than removing the wipe, because nothing before had
verified whether every group could actually survive its removal.

**Why it matters:** this function is the common path for nearly every
settings change — site-mode toggles, permission changes, picker rule
additions, sandbox saves, Settings restore. A single small change
currently forces a full unregister+re-register of every scriptlet,
cosmetic, and custom-filter directive.

**Fix direction (revised):**
1. Give `registerCustomFilters()` its own existing-vs-wanted diff for
   the single `css-user` id — same shape as
   `registerCookieClickerContentScriptsImpl()`'s single-directive
   pattern (check existing, `updateContentScripts()` if present and
   still wanted, `unregisterContentScripts()` if no longer wanted,
   `registerContentScripts()` if new).
2. Only then remove the blanket `unregisterContentScripts()` call in
   `registerContentScripts.register()`, since every path it currently
   compensates for will correctly self-manage.
3. Update this file's own header comment (~24–58), which currently
   documents the blanket wipe as intentional design, to match.

**Implemented (`js/core/scripting-manager.js`):**
1. Gave `registerCustomFilters()`'s `css-user` directive its own
   existing-vs-wanted diff (single-directive pattern, matching
   `registerCookieClickerContentScriptsImpl()`) — verified as a
   behavior-neutral no-op with the wipe still in place before proceeding.
2. Removed the blanket `unregisterContentScripts()` call entirely.
   `withRegistrationLock()` is kept around the five-group batch — it
   still guards against a race between this batch and any of the same
   five groups' own public wrappers being called concurrently, which was
   always the lock's actual job, independent of the wipe.
3. Updated the file's own header comment to describe the diff-based
   behavior instead of the removed wipe.

Full `npm run check` suite passes with no regressions.

**Sequencing note:** do this first — items 1.3 and 1.4 below build on
the shared `context` mechanism this fix will touch, and are easier to
verify once this lands. Step 1 above (giving `registerCustomFilters()`
its own diff logic) is the riskier part and should be verified in
isolation — with the blanket wipe still in place — before step 2
removes the wipe.

---

### 1.2 — Tracker Radar dataset eagerly loaded on every SW cold start — STATUS: ✅ IMPLEMENTED (revised approach)

**Where:** `js/data/tracker-radar-data.js` (248 KB, 2,103 entries),
formerly statically imported via `tracker-radar-lookup.js` →
`js/core/matrix-panel.js` → `js/workflow/background.js` (the service
worker's own entry graph).

**Original fix direction (dynamic `import()` inside the lookup
function) did not fit this call site — verified before implementing,
not assumed:** `isKnownTracker()` has exactly one consumer,
`js/core/matrix-panel.js`, called synchronously from a live
`browser.webRequest` listener that fires on every network request
while a Matrix session is active. Making the lookup itself async would
have rippled into that per-request hot path — a net loss for exactly
what this priority bucket protects.

**Revised approach — load once at session start, not per-lookup:**
measured the actual cost first — 24ms to dynamically import and parse
the dataset (measured directly, ESM `import()`, same engine Chrome
uses). `startMatrix()` (`js/core/matrix-panel.js`) is the function that
runs when a Matrix session begins — already async, already does several
setup steps, and finishes with `browser.tabs.reload(tabId)`, a tab
reload that takes far longer than 24ms before the first real
third-party request can arrive. Kicking off the dataset load at the
very start of `startMatrix()`, unawaited, lets it run in parallel with
everything else — by the time any real request reaches the lookup
function, the dataset is essentially always already loaded, with zero
async ripple into the lookup itself.

**Implemented:**
- `tracker-radar-lookup.js`: replaced the static `import` with a new
  exported `preloadTrackerRadarData()` — dynamically imports the
  dataset once (cached via a module-level promise, so a second Matrix
  session in the same SW lifetime reuses the same load rather than
  re-fetching) and populates a module-level `trackerRadarDomains`
  object. `lookupTracker()`/`isKnownTracker()` stay fully synchronous,
  reading from that object — `{}` (no matches) until the preload
  resolves, degrading safely rather than throwing if ever called
  before that.
- `matrix-panel.js`: `startMatrix()` now calls
  `preloadTrackerRadarData()` (fire-and-forget, first line of the
  function) instead of relying on a static top-of-file import.

Cold service-worker starts where the Matrix panel is never opened in
that lifetime now never load this dataset at all — the original goal —
without adding any async cost to the per-request path.

Full `npm run check` suite passes.

---

### 1.3 — `buildSiteModeMatchScope()` computed independently up to 4× per registration cycle — STATUS: ✅ IMPLEMENTED

**Where:** `js/core/compiled-filters.js` (~426, the function itself);
called independently from `registerScriptletContentScriptsImpl()`,
`registerCosmeticContentScriptsImpl()`,
`registerCookieClickerContentScriptsImpl()`, and
`registerCookieClickerAutoDenyContentScriptsImpl()` in
`js/core/scripting-manager.js`.

**Correction to the original finding:** the original write-up named
`registerSecurityContentScriptsImpl()` as the fourth caller — verified
while implementing and that was wrong; it doesn't call
`buildSiteModeMatchScope()` at all. The actual fourth caller is
`registerCookieClickerAutoDenyContentScriptsImpl()`.

**Mechanism:** each of the four functions independently calls
`buildSiteModeMatchScope()` for an identical result — four computations
of the same thing per registration cycle.

**Why not the shared `context` object:** all four are also called
independently via their own public wrappers from many other places
(e.g. `cookie-clicker-routes.js` calling
`registerCookieClickerContentScripts()` directly when a single rule is
added) — verified by checking every external call site before
implementing, not assumed. A shared `context` object only exists inside
`registerContentScripts.register()`'s own batch, so it can't be relied
on by those independent callers.

**Implemented:** each of the four functions now takes an optional
`precomputedScope` parameter — used if provided, else computed exactly
as before (`precomputedScope ?? await buildSiteModeMatchScope()`).
Independent callers pass nothing, so their behavior is unchanged. The
batch in `registerContentScripts.register()` now computes the scope
once and passes it to all four.

---

### 1.4 — `scriptlet-files.json`/`cosmetic-files.json` re-fetched and re-parsed on every registration call — STATUS: ✅ IMPLEMENTED

**Where:** `js/core/scripting-manager.js` — `fetch(browser.runtime.getURL('/rulesets/scriptlet-files.json'))`
and the equivalent for `cosmetic-files.json`.

**Mechanism:** both are static, build-time-generated manifests that
only change on a new extension version, but neither
`registerScriptletContentScriptsImpl()` nor
`registerCosmeticContentScriptsImpl()` cached the parsed result.

**Implemented:** added `scriptletFilesCache`/`cosmeticFilesCache`
module-level variables (same "acceptable to lose on SW restart, cheap
to reload once" posture as `mode-manager.js`'s
`readFilteringModeDetails.cache`) — each fetch now only happens once
per SW lifetime instead of once per registration call.

Full `npm run check` suite passes with no regressions for both 1.3 and
1.4.

---

### 1.5 — `writeFilteringModeDetails()` writes the same data to storage twice per call — STATUS: ✅ IMPLEMENTED

**Where:** `js/core/mode-manager.js`.

**Mechanism:** an unawaited `localWrite`/`sessionWrite` pair was
immediately followed by an identical second `localWrite`/`sessionWrite`
pair of the same data, inside the `Promise.all` that also fetches the
default filtering mode for the broadcast.

**Implemented:** removed the first (unawaited) pair; the remaining pair
is awaited alongside the default-mode lookup in the same `Promise.all`
as before. `node --check` and full `npm run check` suite pass.

---

## Priority 2 — Powertools

Element Picker (`js/scripting/picker.js`) was checked — it's
click/event-driven with no polling or bulk-render step. Nothing found
there.

### 2.1 — Privacy Inspector's initial snapshot load: O(n²), not just O(n) — STATUS: ✅ IMPLEMENTED

**Where:** `privacy/privacy-inspector.js` — the load loop and
`appendRow()`.

**Mechanism:** each `appendRow()` call appended directly to the live
DOM (`body.append(row)`) AND called `updateBlockAllAvailability()`,
which itself ran two full O(n) scans over the growing row set via
`blockableRowsUpToRisk()` (called twice), each doing a real per-row
`computeRisk()` call. Bulk-loading N entries was therefore O(n²) real
computation, not just O(n) DOM cost.

**Implemented:** split `appendRow()` into `buildRow()` (builds and
returns a detached `<tr>`, no DOM attachment or finalize calls) and a
thin `appendRow()` wrapper that does the single-row append + finalize,
preserving the live single-entry update path exactly as before. The
bulk-load loop now builds all rows into one `DocumentFragment`, appends
it once, then calls `updateEmpty()`/`updateBlockAllAvailability()` once
for the whole batch instead of once per row.

---

### 2.2 — Matrix panel's initial snapshot load: N individual live-DOM appends — STATUS: ✅ IMPLEMENTED

**Where:** `matrix/matrix-panel.js` — the load loop and `upsertEntry()`.

**Correction to the original finding:** the original write-up said this
was "DOM-only... no compounding O(n²) computation on top" — wrong,
caught while implementing. `upsertEntry()` also calls `renderStats()`
at the end, which iterates the *entire* `entryRegistry` to sum
connection counts across all domains. Bulk-loading N entries was
therefore also O(n²), the same class of issue as 2.1, not the milder
DOM-only case originally described.

**Implemented:** `upsertEntry()` now accepts an optional `fragment`
(append target for the top-level row, used instead of the live
`elBody`) and `deferStats` flag (skips the `renderStats()` call). Child-
row insertion via `afterEl.after()` needed no change — it works
correctly whether `afterEl`'s current parent is the live `elBody` or an
in-progress fragment. The bulk-load loop now passes both, appends the
completed fragment once, and calls `renderStats()` once for the whole
batch. The live single-entry update path (the other caller) passes
neither option, so its behavior is unchanged.

Full `npm run check` suite passes for both 2.1 and 2.2.

---

## Priority 3 — Ad hoc user-initiated actions

### 3.1 — Bulk Allow-list save/import: N sequential storage round-trips + N native DNR rebuilds — STATUS: ✅ IMPLEMENTED

**Where:** `handleSiteModeSetAll()` in `js/workflow/mode-routes.js`,
calling `setFilteringMode()` in `js/core/mode-manager.js` once per
hostname.

**Mechanism:** each call did a full read of the entire filtering-mode
map, mutated one hostname, wrote the entire map back via
`writeFilteringModeDetails()` — which calls
`chrome.declarativeNetRequest.setAllowAllRules()`, a real native DNR
rebuild, every time. For N hostnames, that was N full round-trips and N
native rebuilds instead of one of each.

**Implemented:** added `setFilteringModeBulk(entries)` to
`mode-manager.js` — reads the filtering-mode map once, applies every
`[hostname, level]` pair to that same in-memory object via the exact
same `applyFilteringMode()` pure mutator `setFilteringMode()` itself
uses (not a re-implementation — the original bug-fix comment on this
function was specifically cautious about a second copy of that
hierarchy/subtree-pruning logic, so this reuses it instead), then
writes once. `handleSiteModeSetAll()` now builds the full list of
`[hostname, level]` changes and calls this once instead of looping over
`setFilteringMode()`.

---

### 3.2 — Custom-rules import loops: full read-modify-write per item, not per batch — STATUS: ✅ IMPLEMENTED

**Where:** `handleImportCustomRules()` in `js/workflow/background.js`
— two sub-cases in the same function:
- `addCustomScriptletRule()` (`js/core/custom-scriptlets.js`): a full
  read of the *entire* scriptlet-rules array, an O(n) dedup scan, and a
  full write of the entire array back — once per rule imported.
- `importCosmeticFilters()` (`js/core/filter-manager.js`): a full read
  of the entire cosmetic-rule-dates map and a full write back — once
  per hostname imported.

**Implemented (same shape for both, kept as separate functions rather
than one, since scriptlet rules and cosmetic filters are unrelated
storage):**
- `custom-scriptlets.js`: extracted `validateScriptletRuleCandidate()`
  (pure — name/hostname/args checks and candidate shaping) out of
  `addCustomScriptletRule()`, which now uses it and is otherwise
  unchanged — same public contract, same single-rule callers (Privacy
  Inspector's Select button, the internal auto-privacy path) unaffected.
  Added `importCustomScriptletRules(rules, source)`: reads the stored
  array once, validates and dedups every rule against that same array
  in memory via the shared helper, writes once at the end.
- `filter-manager.js`: same pattern — extracted
  `applyCosmeticImportForHostname()` out of `importCosmeticFilters()`
  (unchanged public contract, still used nowhere else). Added
  `importCosmeticFiltersBulk(entriesByHostname)`: reads the shared
  cosmetic-rule-dates map once, applies every hostname via the shared
  helper, writes once.
- `background.js`: `handleImportCustomRules()` now calls both bulk
  functions instead of looping over the single-item ones. Updated the
  function's own header comment, which was already stale (referenced
  the pre-fix per-item delegation).

Extracting shared helpers in both files (rather than writing the bulk
path as a second, independent implementation) avoids the two versions
of each validation/apply step ever drifting apart — the specific
failure mode this codebase's own B15 principle warns about.

Full `npm run check` suite passes for both 3.1 and 3.2.

---

### 3.3 — Cosmetic bulk-import: N full corpus scans + N full index rebuilds, one layer deeper than 3.2's own fix — STATUS: ✅ IMPLEMENTED

**Where:** `importCosmeticFiltersBulk()` in `js/core/filter-manager.js`.

**Mechanism:** 3.2 above batched the shared cosmetic-rule-dates
read/write, but `importCosmeticFiltersBulk()` still delegated to
`applyCosmeticImportForHostname()` → `addCustomFilters()` once per
hostname. Each of those per-item calls independently re-read the
*entire* `site.*` corpus for its own global-cap check
(`getAllCustomFilters()`) and, via `writeToStorage()`, triggered a full
`refreshCustomFilterIndex()` rebuild (another full corpus scan +
sandbox re-parse + full index rebuild) on every single write. For N
hostnames in one import: up to 2N full corpus scans instead of ~2 — a
cost layered underneath 3.2's own dates-map fix, invisible from
`writeToStorage()`'s own call site since it looks like a plain storage
write.

Found not by re-auditing this codebase but by porting 3.1/3.2 to a
sibling extension (AdShield Extra) and tracing one layer deeper than
3.2's own worked example — see `PORTING_9_4_9_ISSUES_FOUND.md` item 8
(a working note, not shipped in any release artifact).

**Implemented:** read the `site.*` corpus ONCE into an in-memory
snapshot, apply every hostname against it via a new pure
`computeUpdatedSelectors()` helper extracted out of `addCustomFilters()`
itself (not a second copy of its dedup/cap logic — B15), keeping a
running total in sync instead of re-scanning storage per hostname, then
batch every changed key through a new `writeManyToStorage()` sibling to
`writeToStorage()`, which rebuilds the index once for the whole batch
instead of once per key. `addCustomFilters()`'s own single-item
behavior and `importCosmeticFilters()`'s single-hostname path are
untouched.

**Verified:** two tests added to `tools/test-core-modules-dry-run.mjs`
— a bulk-vs-sequential equivalence check, and a call-count regression
test asserting exactly 2 full-corpus reads for a 4-hostname batch (was
8 under the pre-fix path — confirmed by temporarily reverting to the
old implementation and observing the test fail with that exact number).
Shipped in v9.5.0.

---

### 3.4 — Content-script registration: one native `browser.scripting` call per directive instead of one per batch — STATUS: ✅ IMPLEMENTED

**Where:** `js/core/scripting-manager.js` —
`registerScriptletContentScriptsImpl()`, `registerCosmeticContentScriptsImpl()`,
and `registerSecurityContentScriptsImpl()`.

**Mechanism:** all three independently looped over their own array of
"wanted" content-script directives calling
`browser.scripting.registerContentScripts([directive])` /
`updateContentScripts([directive])` once per directive, instead of
batching the whole array into one call each. For N rulesets, up to 2N
separate native-API calls (each an IPC round trip to the browser
process) on every registration pass — a site-mode change, a ruleset
toggle, or extension startup. Found independently, in the identical
shape, three separate times in this one file before the pattern itself
was noticed.

**Implemented:** a shared `registerOrUpdateContentScripts()` helper
(declared once, right after `withRegistrationLock()`) splits a
wanted-directives array into updates-vs-new against the caller's own
`existingMap`, then issues at most one batched `updateContentScripts()`
call and one batched `registerContentScripts()` call. Both native calls
are atomic across their own array argument (one bad directive rejects
the WHOLE call, same as `updateDynamicRules()`'s documented atomicity)
— on rejection, the helper falls back to one-call-per-directive for
just that batch, reproducing the exact original per-item behavior as a
safety net rather than a behavior change.

Concrete before/after: cosmetic filters (26 ruleset files) went from up
to ~52 native calls to 2; scriptlets (6 files) from ~12 to 2; Privacy &
Security toggles (14 rules) from ~28 to 2.

Because this recurred three independent times, this also got a
standing HARD CONSTRAINT (`ARCHITECTURE.md`) and an automated check
(`tools/check-scripting-batch-calls.mjs`, Part D step 31 of
`complete-check.mjs`) that fails the build if a new per-directive loop
reappears outside the shared helper — verified by temporarily
reintroducing the old per-item loop into a scratch copy and confirming
the check failed, then reverting. Shipped in v9.5.1.

---

### 3.5 — Reintroducing the CrUX top-1M cosmetic popularity filter — CONSIDERED, REJECTED (no code change)

**Context:** a prior session removed a CrUX top-1M popularity filter
that trimmed AdGuard Base's cosmetic-specific "core" hostname list down
to only globally-popular sites (`fetchTopSitesSet()` /
`filterCosmeticMapByPopularity()` in `tools/build-rulesets.mjs` — code
still present, but no `FILTER_LISTS` entry currently sets
`popularityFilter: true`, so it never runs). Removal reason at the
time: combined with the old `KEEP_TLDS` allowlist, it was
independently trimming legitimate long-tail cosmetic coverage.

**Re-evaluated this session** after two architecture changes since
removal: (a) AG Base's TLD model moved from an allowlist (`KEEP_TLDS`)
to a blacklist (`AGBASE_COUNTRY_BLACKLIST`), and (b) cosmetic injection
moved from a large-chunk to a small-chunk delivery model
(`js/scripting/css-specific.js`'s binary-search extraction — only the
selectors matching the current hostname are ever injected into a page,
regardless of total table size).

**Measured against today's real, current data** (not the historical
numbers from when it was removed):

- Reapplying the filter today would cut **5,462 of 11,104 plain
  hostnames (49.2%)** from AG Base's cosmetic-specific core — in line
  with the ~40–50% cuts measured historically before removal. The TLD
  blacklist change didn't move this number: popularity (traffic rank)
  and TLD/country are independent axes, and a real, legitimate site
  simply not being globally top-1M-popular is unaffected by which TLDs
  are allowed through.
- The resulting compiled file (simulated directly against the real
  885,593-byte `ruleset_adguard_base-cosmetic-specific.json`, including
  selector/selector-list dedup, not just hostname count) would shrink
  to **581,136 bytes (−34.4%)** — smaller than the hostname-count cut
  alone suggests, since many selectors are shared across hostnames and
  survive even when a long-tail hostname using them is dropped.
- Real `JSON.parse` timing on both actual payloads (V8, 1000-iteration
  average): **2.17 ms (885 KB) vs. 1.46 ms (581 KB) — a 0.71 ms
  difference.** That's the per-page-load cost this file's read
  actually adds; the `chrome.storage.local.get()` IPC round-trip that
  precedes the parse almost certainly costs more than this difference,
  and it isn't on any rendering-critical path.

**Decision: not worth reintroducing.** The small-chunk injection
architecture already made the strongest performance argument for this
filter moot (per-page *injected* CSS was never going to scale with
table size once binary-search extraction landed) — that only leaves the
parse-time argument, which measures out to well under a millisecond.
There is no remaining performance case, and the original,
coverage-based objection (cutting real ad-hiding rules for real,
if less globally-popular, sites) is untouched by either architecture
change. Reintroducing it would recreate the exact complaint that got it
removed, for negligible measured benefit.

---

## Summary table

| # | Priority | Location | Cost shape | Status |
|---|---|---|---|---|
| 1.1 | P1 | `scripting-manager.js` — `registerContentScripts.register()` | Full wipe + rebuild of 5 groups per call | ✅ Implemented |
| 1.2 | P1 | `tracker-radar-lookup.js` / `matrix-panel.js` | Was: dataset parsed on every SW cold start | ✅ Implemented (session-start preload) |
| 1.3 | P1 | `compiled-filters.js` — `buildSiteModeMatchScope()` | Same computation done 4× per cycle | ✅ Implemented |
| 1.4 | P1 | `scripting-manager.js` — file-manifest fetches | Re-fetch + re-parse of static data every call | ✅ Implemented |
| 1.5 | P1 | `mode-manager.js` — `writeFilteringModeDetails()` | 2× redundant storage writes per call | ✅ Implemented |
| 2.1 | P2 | `privacy-inspector.js` — initial snapshot load | Was: O(n²), DOM + repeated risk recomputation | ✅ Implemented |
| 2.2 | P2 | `matrix-panel.js` — initial snapshot load | Was: O(n²), DOM + repeated renderStats() | ✅ Implemented |
| 3.1 | P3 | `mode-routes.js` — `handleSiteModeSetAll()` | Was: N storage round-trips + N native DNR rebuilds | ✅ Implemented |
| 3.2 | P3 | `background.js` — `handleImportCustomRules()` | Was: N full read-modify-writes instead of 1 | ✅ Implemented |
| 3.3 | P3 | `filter-manager.js` — `importCosmeticFiltersBulk()` | Was: 2N full corpus scans + index rebuilds | ✅ Implemented |
| 3.4 | P3 | `scripting-manager.js` — 3 registration functions | Was: 2N native `browser.scripting` calls instead of 2 | ✅ Implemented |
| 3.5 | P3 | `build-rulesets.mjs` — CrUX top-1M cosmetic filter | 34% file-size cut, ~0.7ms parse saving, real coverage cost | ❌ Considered, rejected |

