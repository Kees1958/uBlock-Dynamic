# Architecture — folder tiers

## Related standing reference docs

- **`FILTER_PROCESSING_REFERENCE.md`** — per-filter-list build-time
  processing detail (what gets dropped/enriched, safe vs. unsafe rule
  types, module/call-chain). Kept in sync with `tools/build-rulesets.mjs`
  — update it in the same pass as any change to that script's
  `FILTER_LISTS` processing, not as an afterthought (this file went
  stale once already — see its own git history / the CHANGELOG entry
  that rewrote it for the AdGuard Base blacklist-model rearchitecture).
- **`STYLE_GUIDE_LIGHT.md`** / **`STYLE_GUIDE_DARK.md`** — verified
  contrast-ratio catalog for design tokens (see A8/A9).

## Naming note — "Fingerprint Inspector" (UI) = Privacy Inspector (code), 10.5.4

The panel the user sees as **"Fingerprint Inspector"** (popup menu, right-click menu, panel title/texts) is the
feature called **Privacy Inspector** everywhere in the code and in these docs: `privacy/privacy-inspector.*`,
`js/core/privacy-inspector.js`, `js/workflow/privacy-inspector-routes.js`, the `MSG_*_PRIVACY_INSPECTOR` message
types, the `privacy-inspector` rule-source tag and the context-menu id. Renamed in the UI only (owner's request,
10.5.4): message types, storage keys and file names are contracts and were deliberately not renamed.

## The five-tier model (SW / dashboard / popup dependency graph)

Files under `js/ui/`, `js/workflow/`, `js/core/`, `js/util/`, `js/data/`
follow a strict five-tier dependency model. Dependencies may only flow
**downward**:

```
ui/       →  workflow/, core/, util/, data/
workflow/ →  core/, data/, util/
core/     →  util/, data/
util/     →  (nothing — self-contained; approved exceptions only, see below)
data/     →  util/ zero-import pure helpers only (10.7.6) — otherwise only external APIs
```

- **ui/** — dashboard/popup/picker-adjacent presentation helpers (DOM,
  i18n, theming, filter-editor rendering) used by the page contexts.
- **workflow/** — `background.js`, the service-worker orchestrator. Wires
  together core modules in response to extension lifecycle/events. The
  message handlers live in `*-routes.js` files beside it. A route file
  imports only core/, data/ and util/ — never another route file; only
  `background.js` imports the route files. (10.7.12: the settings handlers
  moved to `settings-routes.js`; the site-mode procedures that Restore
  settings shares with the Allow list editor and the popup moved down to
  `core/site-mode-apply.js` so no route file needs another.)
  (11.0.3: the same fix again for the Ad leftover cleaner — `trustedHostnameFromSender()` moved to
  `util/trusted-sender.js`, `saveCustomCosmeticSelectors()` to `core/cosmetic-rule-save.js`. Enforced since then
  by suite step 93, `tools/check-tier-direction.mjs`.)
- **core/** — feature logic (rulesets, filtering modes, block-monitor,
  scripting-manager, etc.), and the shared filter parser
  (`static-filtering-parser.js`, `ubo-parser.js` and their helpers), which
  the dashboard, picker, offscreen compiler and build all use — moved here
  from ui/ in 10.7.9 (audit 10.7.8), verbatim.
- **util/** — pure, stateless helpers with no dependencies inside the
  extension. Because a util/ file imports nothing, data/ may use one
  (`deep-compare.js`, `async-lock.js`) without any risk of a circular
  import (10.7.6). A helper that calls a browser API is not a util/ file:
  `panel-window.js` moved to core/ for that reason (10.7.6).
  **Exception (owner's decision, 2026-11-22):** a util/ file may import another util/ file **that imports
  nothing** — such an import can never close a cycle, for the same reason data/ may. It is allowed only when the
  alternative would break or contradict another rule (e.g. copying a constant, against B2's one source of truth), and
  only after the owner has discussed and approved that specific import. Each approved import is listed with its reason
  in `UTIL_IMPORT_EXCEPTIONS` in `tools/check-tier-direction.mjs` (suite step 93); any other util/ import fails the
  suite, and a listed one fails too if its target ever gains an import. Approved so far (11.0.2 hostname limit/shape
  shared once, B2): `popunder-parser.js → utils.js`, `site-mode-parser.js → utils.js`,
  `site-mode-parser.js → punycode.js`.
- **data/** — constants, storage access, message-type definitions,
  browser-API compatibility shims.


**Dashboard tabs and UI names (10.5.0).** The tab order and labels (Filter (block) lists · Import ABP
rules · Manage custom rules · Allow (white) list · Options), the default tab (the first), and the
Worry-free feature name ("Worry-free surfing") live only in `js/data/ui-names.js`. `dashboard.js` builds
the tab bar from it; HTML and popup text use `[data-ui-name]` placeholders (`js/ui/ui-names-apply.js`).
A tab's `pane` key is a stored contract and never follows a label rename (Options keeps `security`). The
one content-script copy (`worry-free-picker.js`) is guarded by `tools/check-ui-name-copies.mjs`.

## Why `scripting/`, `offscreen/`, `generated/`, `resources/` sit outside this model

Four additional top-level folders exist under `js/` that are **not**
part of the five-tier model above, and this is intentional rather than
an oversight (the former fifth, `security/`, is gone — see below):

- **`js/scripting/`** — code injected by `chrome.scripting.executeScript()`
  into the *page* context (content-script world), not loaded by the
  service worker's own module graph. Examples: `picker.js`,
  `ad-cleaner.js` (11.0.0, repurposed from uBOL's `css-generic.js`), `tool-overlay.js`.
- **`js/security/`** — individual security scriptlets. (10.3.0) Twelve were removed with the
  Privacy & Security tab's extra protections (`sec-noeval.js`, `sec-nowebrtc.js`, etc.); the last
  survivor, `sec-pings.js`, was removed outright in 10.5.0 (owner's request) — the folder is now empty
  and deleted. See CHANGELOG_HISTORY.md's 10.3.0 and 10.5.0 entries. Re-create this folder if a
  security scriptlet is ever added again; each file was a self-contained unit registered
  independently, not a module imported by another tier.
- **`js/offscreen/`** — code that runs inside the extension's offscreen
  document (`compile-filters.html`), a separate execution context from
  both the service worker and any page. It communicates with the SW only
  via `chrome.runtime` messaging, never via direct import.
- **`js/generated/`** (10.7.6 documented) — build OUTPUT of `tools/build-rulesets.mjs`
  (`custom-scriptlets-dispatch.mjs` and the per-scriptlet files). Never edited by hand;
  regenerated by every full build. Excluded from ESLint for that reason.
- **`js/resources/`** (10.7.6 documented) — bundled third-party DATA the build and the
  extension read: the AdGuard scriptlets core library (`ag-scriptlets-corelibs.json`) and the
  hand-ported uBO patch scriptlets (`ubo-patch-scriptlets-source.mjs`, C40). Data, not a layer.

The execution-context folders above represent **separate execution contexts**, not
additional layers in the SW's own dependency graph. `core/scripting-manager.js`
(tier 3) is the sole bridge: it knows the *paths* of files in
`scripting/`/`security/` to register, but never imports their code
directly. Similarly, `core/compiled-filters.js` knows how to launch and
message the `offscreen/` document but doesn't import its code either.

Because of this, the downward-dependency rule doesn't apply *between*
these folders and the five tiers — it applies *within* each execution
context independently. Within `js/scripting/` and `js/security/`, files
are intentionally flat and independent (each is registered/injected on
its own). Within `js/offscreen/`, `compile-filters.js` is the entry point
that loads the other offscreen helpers.

See `js/workflow/background.js`'s STATE/GUARDS/TIMERS reference comment
for how the SW tracks the lifecycle of scripting registrations and the
offscreen document.

## DESIGN PRINCIPLE — once a solution is proven, sibling features must reuse it, not reinvent it

When two features solve the same underlying problem, and one of them has a
solution that's actually been proven correct — meaning it has a documented
history of being tested against a real failure mode, not just "looks right
on first read" — the other must adopt that same solution. Building a
second, different-looking answer to a problem this codebase has already
solved once is not an improvement; it's a new, unproven implementation of
something that didn't need re-deciding, and a second place for the same
class of bug to hide.

**Worked example — the empty-tab bug, Privacy Inspector vs. Tracker
Radar's DDG Tracker Radar monitor:**

Both features open a tab that must reliably close itself when its
session's time limit expires. Privacy Inspector's version of this had
*two* separate documented rounds of "stale empty tab" bugs (see
`CHANGELOG.md`, `6.0.7` and its later regression) before converging on:
a hard `Promise.race` timeout around the stop message
(`STOP_MESSAGE_TIMEOUT_MS`, `privacy/privacy-inspector.js`), and
carefully making sure `resume()` actually restarts the countdown clock.
That's a real, tested fix — but it was still a *single* mechanism: one
client-side clock, in one tab, is the only thing that ever decides to
close it.

Tracker Radar's `monitor-panel.js`/`block-monitor.js` was built
independently and ended up with something structurally stronger for the
exact same problem: the **background** is authoritative for expiry (a
primary `setTimeout` *plus* a `watchdogHandle` `setInterval` fallback for
SW restarts wiping the primary one), broadcasting `MSG_MONITOR_CLOSED`
the moment it fires — which the panel reacts to immediately, not on its
own timer — *and* an independent 15s poll as a second, unrelated safety
net. Two independent paths to the same guarantee, neither depending on
the tab's own JS timers surviving browser throttling for the full
session length.

When this was noticed, the fix was not to invent a third design for
Privacy Inspector — it was to port Tracker Radar's exact mechanism over:
`js/core/privacy-inspector.js` gained the same
`sessionTimeoutHandle`/`watchdogHandle` pair and `MSG_PRIVACY_INSPECTOR_CLOSED`
broadcast (mirroring `MSG_MONITOR_CLOSED`), and
`privacy/privacy-inspector.js` gained the same independent poll
(mirroring `monitor-panel.js`'s `refresh()`/`SESSION_POLL_MS`). (10.5.0: the two `watchdogHandle`
intervals were merged into `js/util/session-watchdog.js` — started with a session and at SW boot,
released when the session ends or no session is running; suite step 64. 10.7.6: replaced by a `chrome.alarms`
deadline in `js/core/session-deadline.js` — the interval died with the sleeping worker, an alarm wakes it; armed with
a session, cleared on pause/stop, reconciled at boot, which also releases a left-over Inspector probe. (audit of 10.6.4: the same
reasoning merged the storage-mirrored timed state of temporary disable and cookie-clicker auto-deny into
`js/util/persisted-timed-state.js`, and the two CodeMirror editors' shared code into `js/ui/editor-helpers.js`.)) — same
constants, same shape, same comments explaining why, adjusted only for
this module's own `chrome.storage.session`-based persistence. The
original client-side-clock fix stayed in place too, as a third layer,
not replaced — this is additive hardening, not a rewrite.

**The rule going forward:** before building a new mechanism for a
problem, check whether a sibling feature already has one — especially
one with CHANGELOG history showing it was actually hardened against a
real failure, not merely written once and assumed correct. If it does,
port it (adjusted only for genuinely different constraints, like storage
strategy), don't design a fresh alternative next to it.

## HARD CONSTRAINT — no remotely hosted code; scriptlets follow js/data/scriptlet-policy.js (10.4.6)

Chrome Web Store rejected the package ("Blue Argon") over a filter-list scriptlet that created a `<script>` loading
code from a CDN. A filter list is DATA from a third party; under Manifest V3 everything that runs must be in the
package and readable. The single policy (`js/data/scriptlet-policy.js`) is enforced at four points that all import it
— never a copy: the build (per-source trust gate in `tools/build/fetch-helpers.mjs`, per-rule gate in
`tools/build/build-steps.mjs`), the suite (`tools/check-mv3-compliance.mjs`, step 59), the extension input
(`js/core/custom-scriptlets.js`) and run time (guard in `rulesets/scriptlet-library.js`, re-check before executeScript).
- Trusted scriptlets (`trusted-*`, uBO requiresTrust names) only from AdGuard Team sources; never own rules.
  (11.1.3) A refused rule of a known harmless shape is replaced by a safe equivalent instead of dropped
  (`safeReplacementFor()`; project scriptlets or the non-trusted AdGuard twin) — never by loosening rule A.
- No code as an argument; no external URL inserted into a page.
- A documented decision that no code reads is not enforcement (the 9.8.0 exclusion constant was exactly that).
- New code that loads anything from a URL (script, module, importScripts, CSP) fails step 59.

## HARD CONSTRAINT — the DNR priority ladder lives in one place and is asserted exactly (9.9.1)

`js/core/dnr-budgets.js` holds **the** priority table (a comment block at the top) and every
priority constant. Nothing else may carry a priority number. The ladder, highest first:

| Priority | Tier |
|---|---|
| 1,000,000 | Pause / Allow-list directive (`TRUSTED_DIRECTIVE_PRIORITY`) |
| 800,000 | Built-in whitelist |
| 600,000 | Badfilter quick fixes |
| 400,000 (+1) | Matrix panel |
| 200,000 (+10/+11/+30) | ABP-import / custom rules |
| 10,000 | Default filter lists (blocks and `@@` exceptions) |
| 9,500 | `@@site$worryfree` — the site is outside Worry-free altogether (extra lists and every protection below) |
| 9,000 | Per-list off-switch of the Worry-free extra lists |
| 8,000 | Worry-free extra lists |
| 1,000 (+1) | Security-toggle rules |
| 900 | Adult-site Permissions-Policy headers |
| 300–320 | Medium (advanced) tier, including its safe-domain exemption band |
| 100–135 | Low tier (blanket third-party block, download block, Permissions-Policy headers) |

**Why it is a hard constraint.** Chrome applies the single highest-priority matching rule, and an
`allow` cancels everything below it. Before 9.9.1 the extra lists (170) sat below the Medium tier's
safe-domain band (an `allow` for every request type on every safe domain ending, at 320), so on
`.com`/`.net`/`.org` hosts only 27% of the lists' rules applied whenever the Medium tier was on.
The priority check of 9.7.9 had never looked at the Medium tier, so it stayed green.

**How it is enforced.** `tools/check-dnr-priority-order.mjs` (suite step 41) asserts the exact numbers
and the strict order of the whole ladder (A2) and the shipped rulesets/outcomes (B/C). `tools/check-dnr-id-ranges.mjs`
asserts the relations that follow from it. A new tier or a changed number goes into `dnr-budgets.js` **and**
into the `LADDER` list of that check, in the same change. (10.3.0: the Medium tier and its real-builder
scenario check (old section D) are retired along with every Worry-free tier — see CHANGELOG_HISTORY.md's
10.3.0 entry; the sandbox-safe-scripts row that was the Medium tier's one surviving piece is covered by
section A's relational checks instead, same as its new safer-regions-tier siblings were before they too
were retired.)

**What `$worryfree` means for the ladder (10.0.0).** `@@site$worryfree` = the site is outside Worry-free
altogether: two dynamic `allow` rules at 9,500 (requests made *by* the site, requests sent *to* it; every
resource type except `webbundle`, and `main_frame` for the first) beat the extra lists and every protection.
`$saferegions` is RETIRED 10.3.0 — it used to mean "treat as a safe region" (allows at 101–131, deliberately
below the extra lists at 8,000, which it had to never cancel); that whole band and the protections it
exempted are gone. Before 10.0.0 `$worryfree` also sat at 101–131, so after the 9.9.1 ladder it could not
exempt a site from an extra list (found via bbc.com video) — fixed by giving it its own 9,500 priority.
`tools/test-worryfree-exemption.mjs` section 6 proves it against the shipped lists with the precedence model.

**Dynamic rules keep the priority they were written with across an update**, so a future re-numbering
needs the real rule-building functions (`updateUserRules()`, `updateSecurityRules()`, etc.) to actually
rewrite stale entries onto the current ladder rather than leaving them at whatever priority they were
first written with — `tools/test-priority-ladder-migration.mjs` (step 47) proves this self-correcting
property with rules seeded at stale (pre-9.9.1) numbers. (10.0.3: the 9.9.1→10.0.3 one-time migration
step that used to do this explicitly, `runVersionMigration()`'s `reapplyDynamicRulesForPriorityLadder`,
was removed along with every other pre-10.0.3 upgrade step — see CHANGELOG_HISTORY.md's 10.0.3 entry;
this codebase starts a fresh release lineage with no in-place upgrade path.)

**Accepted trade-off (historical, pre-10.3.0):** the per-list off-switch (9,000) used to sit above the Medium
tier, so a switched-off extra list's own hosts also skipped the Medium rows. Moot since 10.3.0 — the Medium
tier is retired.

## HARD CONSTRAINT — CRUD for every data element, Initiate → Perform → End for every process (C41, 10.0.1)

Every option, setting or stored/derived value introduced gets four paths — **C**reated (every channel), **R**ead (actually consumed, including by the settings
backup), **U**pdated (dependents re-apply), **D**eleted (nothing stranded) — and every process gets a test that drives the real functions through Initiate → Perform → End
(removal, empty/corrupt input, service-worker restart). Full statement and worked example: `Xplainer_Programming_principles_conscript.md` C41.
`tools/check-crud-lifecycle.mjs` (suite step 49) enforces what is mechanical: toggles, per-site options, rule ids, and a default-deny registry of process modules
(`PROCESS_REGISTRY` with test labels; `LEGACY_UNAUDITED` is a counted debt list). Found by it in 10.0.1: the Allow list's `$saferegions`/`$worryfree` lines were never part
of the settings export/import.

## HARD CONSTRAINT — every per-site Allow-list option works in all three channels (10.0.0)

`@@domain$worryfree` can be declared in **three** places, and it must work in every one of them — a tooltip,
an editor and a build list that disagree read as "it does not work":

| Channel | Where | Processed by |
|---|---|---|
| Allow list tab | dashboard Allow list editor | `site-mode-parser.js` → `worryfree-manager.js` |
| Built-in quick-fixes list | `badfilter-quick-fixes.txt` (upstream, rebuilt by `build-rulesets.mjs`) | `tools/build/rule-parsers.mjs` → (10.2.0) one carrier allow rule per option inside `rulesets/ruleset_badfilter_quickfixes.json` (`js/core/builtin-exemption-carriers.js`) → `exempt-domains.js` `loadBuiltinExemptDomains()` at SW start |
| ABP-import editor | dashboard "Import ABP rules" | `js/core/exempt-domains.js` (derived from the stored text; stripped from the compiler input; re-applied by `reapplyExemptionRules()`) |

(10.3.0: `@@domain$saferegions` is RETIRED in all three channels, alongside the protections it exempted —
`js/core/saferegions-manager.js` and `getEffectiveSaferegionsDomains()` are deleted; `SITE_MODE_OPTIONS` now
has exactly one key, `worryfree`; a `$saferegions` line is dropped on save/import with a status message
instead of being parsed. See CHANGELOG_HISTORY.md's 10.3.0 entry.)

**Why it is a hard constraint.** Before 10.0.0 `$worryfree` existed only in the Allow list tab: a line in the
quick-fixes list was silently dropped by the build parser (`@@bbc.com$worryfree` did nothing while the tooltips
promised it), and the ABP-import editor never processed it. Same bug class as the scripting-gating
constraint below: a feature added at one entry point and forgotten at its siblings.

**The rule.** Every consumer asks `exempt-domains.js` for the *effective* list (`getEffectiveWorryfreeDomains()`),
never a single channel's state; the Allow list editor's own lists stay user-only so built-in/imported sites
never leak into it. **How it is enforced:**
`tools/check-exemption-channels.mjs` (suite step 48) iterates `SITE_MODE_OPTIONS` and fails if an option lacks a
build-parser branch, a generated constant, an effective getter, compile-input stripping, an editor highlight or its
startup/save/import wiring, or if a consumer reads a raw state list again. A NEW option goes into
`SITE_MODE_OPTIONS` **and** into that check's two maps in the same change; `tools/test-worryfree-exemption.mjs`
proves the behaviour for `$worryfree`.

## HARD CONSTRAINT — every `browser.scripting` call site must be site-mode-gated

Four separate, previously-undetected bugs (see `CHANGELOG.md`) were all the
exact same mistake in different files: a call into the `browser.scripting`
API that ran unconditionally, with no awareness of per-site filtering mode
at all — so turning a site OFF (or a temp-disable pause) stopped DNR
network blocking but left that call's own JS injection running anyway.

- `registerScriptletContentScriptsImpl()` and
  `registerCosmeticContentScriptsImpl()` (`js/core/scripting-manager.js`) —
  both originally used `matches: ['*://*/*']` unconditionally.
- `prepareSecurityScriptletDirectives()` (`js/core/compiled-filters.js`) —
  same gap for the Security & Privacy sec-* scriptlets.
- `injectCustomScriptletsForFrame()` (`js/core/custom-scriptlets.js`) — the
  4th occurrence, in the ABP-import scriptlet dispatch path, found only
  after a user reported that whitelisting a site didn't stop an imported
  scriptlet from running on it.

**The rule going forward:** any new or modified call to
`browser.scripting.registerContentScripts()`, `updateContentScripts()`, or
`executeScript()` MUST consult the current per-site filtering mode before
running, using one of the two existing, proven mechanisms — never a third:
- Declarative registration (`matches`/`excludeMatches` arrays, the shape
  `browser.scripting.registerContentScripts()`/`updateContentScripts()`
  take) → `buildSiteModeMatchScope()` (`js/core/compiled-filters.js`).
- Imperative per-call dispatch (`executeScript()`, called per-navigation
  with a specific `tabId`/`hostname` already in hand) →
  `getFilteringMode(hostname) === MODE_NONE` (`js/core/mode-manager.js`),
  as an early-return guard before the call.

Per the reuse-not-reinvent principle above: do not write a third check for
this. `tools/check-scripting-site-mode-gating.mjs` (part of `npm run
check`) enforces this automatically — see that file for exactly what it
looks for and how to satisfy it for a genuinely new call site.

## STANDING PRINCIPLE — retiring a session-rule band needs an explicit clear on the next version bump

Chrome's `declarativeNetRequest` session rules (`updateSessionRules()`) do **not** clear on a Chrome Web
Store auto-update — only on a genuine browser restart (MDN: "not persisted across browser sessions," but
an auto-update does not restart the browser process at all). Each manager's own `reconcile()`-style
function only ever knows about its *current* version's own id list — if a future version renumbers or
retires a session-rule band, the old rule has no code path left that would ever remove it. It just sits
there, silently, on any install that updated without restarting — a real, previously-confirmed incident
in this project's own history (see CHANGELOG_HISTORY.md's pre-0.0.1 entries for the 9.9.1 strict-3P
retirement and the id-range-based `clearOrphanedWorryFreeSessionRules()` fix it required, both since
removed as part of this lineage's 0.0.1 fresh start — see that version's own entry).

**The rule going forward:** the version that retires or renumbers a session-rule band must also add a
RANGE-based (not current-id-list-based) clear for that exact band to the startup path, so it also catches
ids from a version whose source a later session has no visibility into. This is forward-looking
documentation, not currently-running code — nothing in this lineage has retired a session-rule band yet,
so there is nothing to clear today. When the day comes that one is, port the shape from the removed
`clearOrphanedWorryFreeSessionRules()` (findable in this project's own pre-0.0.1 history) rather than
reinventing it — per this document's own reuse-not-reinvent principle, above.

## HARD CONSTRAINT — never reintroduce unpacked-only DNR feedback APIs

`chrome.declarativeNetRequest.onRuleMatchedDebug`,
`chrome.declarativeNetRequest.testMatchOutcome`, and
`chrome.declarativeNetRequest.getMatchedRules` are **permanently banned**
from this codebase, in background, content script, dashboard, popup, or
monitor code alike. No exceptions, no "just for a debug build," no
"feature-detect and fall back."

**Why:** Chrome restricts all three (checked against Chrome's DNR
reference, 2026-11). `onRuleMatchedDebug` and `testMatchOutcome` work in
*unpacked* extensions only. `getMatchedRules` needs either the
`declarativeNetRequestFeedback` permission (a debugging permission) or
an `activeTab` grant for the one tab named in the filter, and is
quota-limited outside a user gesture. A real user installing from the
Chrome Web Store gets a packed extension: the first two silently never
fire, and the third would work only on a tab the user just clicked the
extension on. uBD declares neither `activeTab` nor the feedback
permission, and its "was this blocked?" features must work on every tab
without a gesture. So the ban is a **project decision** built on those
Chrome limits: any code path built on these APIs works for a developer
testing unpacked and does nothing (or almost nothing) for every actual
user — the worst kind of latent bug, because it passes every manual dev
test and fails in production.

**History:** an earlier version of this extension (`6.4.0`) *did* use
`onRuleMatchedDebug` in `js/core/block-monitor.js` as its blocked-status
signal. It was correct and worked well for local testing, and just as
silently useless for every packed install. It was removed and replaced
by two packed-extension-safe alternatives:
  - `js/core/static-block-check.js` — reads the extension's own bundled
    `rulesets/*.json` files directly (data already shipped, no
    restricted API) to catch whole-domain bundled-filter blocks. Known,
    documented, accepted limitation: whole-domain rules only, not
    path/pattern-specific ones.
  - The Block Monitor's own `blockedRules` check (`monitor/monitor-panel.js`)
    — tracks the tool's *own* saved custom rules client-side instead of
    asking Chrome for live match feedback.

Neither replacement is a like-for-like substitute — each only covers
the slice of "was this blocked?" that can be answered without the
banned APIs. That is an accepted, deliberate tradeoff: a documented
partial signal that works for real users beats a complete signal that
only works for developers. If a future gap is found in either
replacement (e.g. path-specific bundled rules, or url-kind custom
rules), the fix is to extend the packed-safe replacement's own JS
logic — never to reach for `onRuleMatchedDebug`/`testMatchOutcome`/
`getMatchedRules` as a shortcut back to "the real signal," no matter
how much simpler that would be to write.

## HARD CONSTRAINT — batch `browser.scripting` (un)registration, never one call per directive

Three independent occurrences of the identical shape, found during a
performance audit of the cosmetic-injection pipeline:
`registerScriptletContentScriptsImpl()`, `registerCosmeticContentScriptsImpl()`,
and `registerSecurityContentScriptsImpl()` (all `js/core/scripting-manager.js`)
each looped over their own array of content-script directives calling
`browser.scripting.registerContentScripts([directive])` /
`updateContentScripts([directive])` **once per directive** — for N
rulesets that's up to 2N separate native-API round trips (each one an
IPC hop to the browser process) on every registration pass, where 2
batched calls (one `registerContentScripts(allNewDirectives)`, one
`updateContentScripts(allChangedDirectives)`) would do. None of the
three were wrong in isolation; each was written by matching the shape
of whatever registration function existed first, with nothing at the
point of writing signaling that a bulk-write cost class (see OPTIMIZE.md
3.1–3.3, a different subsystem hitting the identical "N times instead
of once" shape) applied here too.

**The fix:** a shared `registerOrUpdateContentScripts()` helper
(`js/core/scripting-manager.js`, declared once, right after
`withRegistrationLock()`) splits a wanted-directives array into
updates vs new registrations against the caller's own `existingMap`,
then issues at most one batched `updateContentScripts()` call and one
batched `registerContentScripts()` call. Both native calls are atomic
across their own array argument — one bad directive rejects the WHOLE
call, same as `updateDynamicRules()` (B13's own atomicity note) — so on
rejection the helper falls back to one-call-per-directive for **just
that batch**, reproducing the exact original per-item behavior (and
per-item error labels) as a safety net rather than losing every
directive in a batch over one bad one.

**The rule going forward:** any `*ContentScriptsImpl()` function in
`js/core/scripting-manager.js` that registers or updates more than one
content-script directive per pass MUST route through
`registerOrUpdateContentScripts()` — never a new per-directive loop
calling the native APIs directly. `tools/check-scripting-batch-calls.mjs`
(part of `npm run check`) fails the build if a new per-directive
`registerContentScripts`/`updateContentScripts` loop is added outside
that helper.

## HARD CONSTRAINT — every compiled hostname dispatch table must account for entity-style (`name.*`) keys

Found independently, in the identical shape, in **two structurally
different** static dispatch mechanisms: `tools/build-rulesets.mjs`'s
`buildCosmeticSpecificData()` (compact cosmetic format) and
`buildScriptletFile()` (per-ruleset scriptlet dispatch). Both compile a
hostname → rule-data table from source filter-list rules, and both
source pipelines pass ABP's entity domain-scope convention
(`kat.*##selector`, "match this name on any TLD") straight through as a
literal Map/table key with no special handling — `parseCosmeticRules()`
and the scriptlet-rule collector both just comma-split a rule's domain
list and store each token as-is.

That alone isn't the bug — the bug is each dispatch mechanism's OWN
runtime lookup silently never finding these keys:

- **Cosmetic** (`js/scripting/css-specific.js`): the entity-matching
  branch (`isolatedAPI.contexts.entities` — real, correct, working code)
  only runs `if (data.hasEntities)`. The build script hardcoded that
  flag to `false` unconditionally, with a comment claiming "nothing in
  this pipeline currently produces an entity-style hostname key" — false,
  contradicted by the real shipped data (416 such entries across 11
  rulesets at the time this was found).
- **Scriptlet** (generated dispatch loop, embedded directly in each
  `<ruleset>-scriptlets.js`): walks REAL parent-domain strings only
  (`www.kat.com` → `kat.com`) and never derived or tried an entity form
  at any point — there was no gate to fix here, the lookup logic itself
  needed a new branch. 611 dead entries found at the time of the fix.

Both are the same underlying failure: a real, shipping rule that
matches literally nothing, ever — not a rare edge case, a rule that
silently does nothing from the moment it's compiled. Confirmed end-to-
end (not just "the flag is now true"): simulated a real page hostname
against the real compiled data and the real matching algorithm
before/after the fix.

**The fix, once found, was cheap in both cases** — the cosmetic side
already had a *proven, working* reference implementation to port from
rather than invent: `js/offscreen/make-cosmetic-filters.js` (the
sandbox ABP-import compiler, a sibling pipeline) already computed this
correctly (`hasEntities ||= hn.endsWith('.*')`) — see C21. The scriptlet
side had no existing reference to port, so it got a small, new,
conditionally-generated dispatch branch (only emitted for a ruleset
that actually has an entity key, so a ruleset without one pays zero
extra runtime cost).

**The rule going forward:** any new or modified hostname-keyed dispatch
table — cosmetic, scriptlet, or any future rule type compiled the same
way — MUST either (a) reject/normalize an entity-style domain token at
parse time with a clear, deliberate reason, or (b) make sure whatever
runtime lookup reads that table actually has a code path that can reach
an entity-style key. "The key exists in the compiled data" is not
evidence it's reachable — each of the two real instances above compiled
and shipped for a real, unknown-length period of time with the entries
present and permanently unreachable, and nothing about the file size or
build success signaled it. `tools/check-entity-dispatch-coverage.mjs`
(part of `npm run check`) statically verifies both known dispatch
mechanisms account for every entity-style key their own compiled output
contains — see that script's own header for what it does and does not
catch, and extend it rather than adding a third silent gap if a new
dispatch mechanism is ever added.



A two-column layout that decides which column an element belongs to
purely by *where it sits in the markup* (odd/even, nth-child, "every
other one") looks clean and needs zero extra markup — right up until
someone removes, adds, or reorders a single row on one side. Every row
after that point silently shifts into the wrong column. Nothing errors,
nothing lints, nothing shows up in a diff as obviously wrong — the bug
is purely visual, and only surfaces when a human actually looks at the
rendered page.

**Where this happened:** `dashboard/dashboard.html`'s Security & Privacy
tab (`#security-columns`) used to rely on exactly this — `.security-row`
elements alternated security/privacy/security/privacy in document order,
and `dashboard/settings.css` used `nth-child`/`nth-last-child` parity to
decide both which column a row landed in *and* which row closed off each
column's bottom border. It worked, silently, for as long as both columns
happened to have the same number of rows and nobody removed one from
only one side. Removing "Block free hosting & DDNS domains" (security
column) and the old "Auto-apply window name and tab protection" toggle
(privacy column) in `7.0.0` would have broken this immediately — the
two removals landed at different depths in the alternating sequence, so
simply deleting both rows would have shifted several *other*, untouched
rows into the wrong column with no error anywhere.

**The fix:** every `.security-row` now declares its own column
explicitly via a `data-column="security"|"privacy"` attribute, and the
CSS (`settings.css`) reads that attribute directly — `grid-column: 2` for
`data-column="privacy"`, nothing implied by position. The "last row in
this column gets a bottom border" rule was rewritten the same way, using
`:has()` to ask "does any *later* row share my own `data-column` value?"
instead of counting from the end of the whole list. Column placement and
row count on one side can now change freely without affecting the other.

**The rule going forward:** if a layout needs to know which group an
element belongs to — a column, a category, a phase — that grouping must
be a real, explicit attribute or class on the element itself. Document
order (`nth-child`, array index, "the third and sixth item") is allowed
to control *visual sequence*, but must never be the only thing encoding
*which group something is in*. If removing or reordering one item could
silently relabel a different, unrelated item, the grouping isn't
explicit enough yet.

---

## Scriptlets — one shared library, data-only list files, ONE registration (after 10.4.4)

Ported from uBlock Origin Lite's `scriptlet-begin.js` / `scriptlet-end.js` design (C21), not reinvented.
Constants: `js/data/scriptlet-library.js` (read by both the runtime and the build).

- `rulesets/scriptlet-library.js` — every scriptlet function used by ANY list, once, keyed by its scriptlet
  name; publishes them on one non-enumerable global. `rulesets/scriptlet-library-end.js` deletes that global.
- `rulesets/<id>-scriptlets.js` — per list: only the names it uses, its dispatch data and the lookup; it calls
  `LIB[name]`. Format, encoder, renderers and decoders: `tools/build/scriptlet-dispatch-layout.mjs`.
- `js/core/scripting-manager.js` registers ONE MAIN-world directive `ag-scriptlets-main`: library, every enabled
  list's data file (manifest order), end file. Files of one registration run in that order at `document_start`,
  before any page script, so the page never sees the library. The per-list `ag-scriptlets-<id>` registrations of
  10.4.4 and older are unregistered by the first pass (prefix match).
- Each call gets `{ name: <scriptlet name>, uniqueId: "<list id>:<row>" }`: two lists' identical rules both still
  run (keep-twice), and the name is a valid attribute name for `prevent-element-src-loading` (a bare number,
  passed up to 10.4.4, makes its `setAttribute()` throw).
- Carry-over of a list whose download failed: its data file's names are added to the new library; a carried-over
  file from before this layout stops the build (it cannot be mixed in).
- Guards: `tools/check-scriptlet-dispatch-layout.mjs` (suite step 50) runs library + data + end together (fuzz
  against a reference walk), checks the shipped library publishes exactly the names the data files call and the
  end file removes it. Measured on 10.4.4 filter data: scriptlet files 2.91 MB -> 1.10 MB; default lists
  ~32.5 -> ~24.4 ms cold per page and frame (node/V8), one language list on ~36.8 -> ~23.8 ms; identical calls
  on all 52,398 probed hostnames.
- A changed library or data file is page code, never a `rule_resources` file: it always needs a normal release.

## Declared manifest permissions — why each one exists (C19)

Every permission in `manifest.json` is listed here with the reason it is
declared and where the code that needs it lives. **Enforced, not just
documented:** `tools/check-manifest-permissions.mjs` (complete-check step
33) fails if shipped code calls a permission-gated `browser.*`/`chrome.*`
API whose permission is not declared (the 8.6.0 failure: a permission
silently dropped, every other check green, service worker never started),
if a declared permission is never used, if a declared permission is not
classified in that script, or if the store-banned
`declarativeNetRequestFeedback` / `onRuleMatchedDebug` /
`testMatchOutcome` / `getMatchedRules` appear (see the HARD CONSTRAINT
above). Adding a permission therefore means adding a row here **and** an
entry in that script's `NAMESPACE_TO_PERMISSION` (or
`NO_NAMESPACE_PERMISSIONS`, with the reasoning).

| Permission | Why it is needed | Main code |
|---|---|---|
| `declarativeNetRequest` | All network blocking: the static filter-list rulesets and every dynamic/session rule. | `js/data/ext-compat.js` (`dnr`), `js/core/*-manager.js` |
| `scripting` | Registering/injecting content scripts (scriptlets, cosmetic rules, security scriptlets, cookie-clicker, custom filters). Every call site is site-mode-gated — see that HARD CONSTRAINT. | `js/core/scripting-manager.js`, `js/workflow/*-routes.js` |
| `storage` | Settings, custom rules, per-site modes, ruleset overrides, session state. | `js/data/ext.js` |
| `alarms` | The `deferredJobs` alarm behind the deferred-jobs queue: timed jobs that must survive a service-worker restart (temporary-disable expiry, cookie-clicker auto-deny expiry). | `js/data/alarms.js`, `js/core/temp-disable-manager.js`, `js/core/cookie-clicker-autodeny-manager.js` |
| `webNavigation` | `onCommitted` per navigation: toolbar icon for the site mode, and dispatch of custom scriptlets to each committed frame. `onCreatedNavigationTarget` + `onErrorOccurred` (10.7.3): close a tab a page opened when Chrome blocks its page load. | `js/workflow/background.js`, `js/core/blocked-popup-closer.js` |
| `contextMenus` | The extension's context-menu entries. | `js/workflow/background.js` |
| `offscreen` | An offscreen document (reason `WORKERS`) that compiles custom/imported filters, because a service worker cannot dynamically import modules. | `js/data/ext-offscreen.js`, `js/offscreen/compile-filters.js` |
| `browsingData` | The "Clear browsing history at browser start" option. Only ever asks for `history`, never cookies/cache/passwords. | `js/core/history-cleaner.js` |
| `webRequest` | **Observation only, never blocking** (there is no `webRequestBlocking`): one `onBeforeRequest` listener that lets the Matrix panel list the third-party hosts a page contacts during its timed session. It returns immediately unless a Matrix session is running for that exact tab. The DNR match-feedback APIs cannot do this job — they are unpacked-only (see the HARD CONSTRAINT above). | `js/core/matrix-panel.js` |

`host_permissions` is `<all_urls>`: filtering and content-script
registration apply to every site, and there is no narrower set that would
still be a general-purpose blocker.

## HARD CONSTRAINT — the extension zip must stay safe-update-eligible (10.1.4)

A rule-list-only release can go through the Chrome Web Store's skip-review
("safe update") path only if the new package differs from the last published
one in **nothing** but `manifest.json`'s `version` and safe rules inside
rulesets declared in `rule_resources`. Chrome diffs the whole package, not
just the files the extension loads.

- **No documentation file may live in the extension zip.** `CHANGELOG.md` and
  `CHANGELOG_HISTORY.md` are in `DOC_FILES` (`tools/package-release.mjs`), and
  `guardNoLeakedFiles()` refuses to build an extension zip containing either.
  Only the licence notices (`LICENSE.txt`, `THIRD_PARTY_LICENSES.md`) ship, and
  they change only when the licences do. Before 10.1.4 the brief `CHANGELOG.md`
  shipped inside the extension and — because every release must add an entry
  to it (`check-version-sync.mjs`) — no release could ever qualify.
- **Build (10.2.0):** `node tools/build-safe-filters.mjs --baseline <last-published-extension.zip> [<listId> …]`
  — refreshes EVERY safe filter ruleset (or only the named ones) and sets every other file back to the
  published bytes. Refuses to run when the working tree's code is not the published code (unreleased work
  would otherwise be lost or shipped). Reports what it leaves out (unsafe companions, scriptlet/hide files).
- **Baseline = the last PUBLISHED zip (10.4.7).** `--baseline` must be the extension zip of the version the
  Chrome Web Store dashboard shows as "Gepubliceerd", never a zip that was only submitted or was rebuilt under
  the same version number. Every attempt against an uncertain baseline (10.4.1–10.4.3) was refused; the first
  attempt against a confirmed one (10.4.7 on 10.4.6) was accepted.
- **Prove:** packaging (`npm run package`) runs `tools/verify-safe-update.mjs` against that baseline
  automatically after a SAFE build and fails the release if the zip does not qualify; it can also be run by
  hand: `node tools/verify-safe-update.mjs <previous-extension.zip> <new-extension.zip>`.
  The definition of a "safe" rule lives once, in `tools/build/safe-update-rules.mjs`.
- **Filter data never lives in code (10.2.0).** Every list the build downloads ships as a declared
  `rule_resources` file: the quick-fixes `$worryfree` lines are carrier allow rules in the quick-fixes ruleset
  (was `js/generated/exempt-domains-generated.mjs`). A list's scriptlet and hide rules remain page code and
  always need a normal release. (10.3.0: the free-hosting/DDNS list's static ruleset, `ruleset_suspicious_hosting`,
  is itself RETIRED along with the "Block suspicious 3P-requests" protection it backed — gone from the manifest
  entirely, not just disabled; `$saferegions` quick-fixes lines compile to nothing and are reported in
  `dropped-unsupported-list-lines.txt`, same treatment as the other two channels. See CHANGELOG_HISTORY.md's
  10.3.0 entry.)
- **Unsafe rules only in declared companions (10.2.0).** `js/data/ruleset-companions.js`
  `UNSAFE_RULE_COMPANIONS` names the companion of every list AdGuard curates (10.2.1, owner's rule: AdGuard
  controls its own lists — AdGuard Base `_removeparam`, its 13 hidden overflow buckets, its adult-site rules,
  AdGuard anti-adblock, the AdGuard language filters), the EasyList country filters and the quick-fixes list
  (`_removeparam` for French, `_unsafe` for the others — declared even while empty). Deliberately none for
  AdGuard tracking servers (only plain `||domain^` lines are kept) or the annoyances list (AdGuard + EasyList
  merged). Any other list's unsafe rule is dropped with a build WARNING. Suite step 55 (`tools/check-unsafe-split.mjs`)
  fails if a main filter ruleset ships an unsafe rule.

## HARD CONSTRAINT — one whitelist, two levels: WHITE and GREY (10.2.0; was the 10.1.5/10.1.6 standing rule)

**One whitelist, one place:** `js/data/matrix-constants.js` (`BUILTIN_DOMAINS` core + the apps of
`js/data/app-whitelist-domains.js`, merged there). Two explicit levels (`WHITELIST_LEVEL`):

- **WHITE** — hosts where ONLY the owner publishes (payment, bank, sign-in, CAPTCHA, apps, libraries, video
  embeds, the fine-grained Google API hosts). ONE treatment for every entry: its third-party scripts/frames are
  allowed over the filter lists (`builtin-whitelist-rules.js`, per its own script/frame flags) AND it is outside
  Worry-free altogether, as `@@domain$worryfree` (`trusted-service-domains.js` = every WHITE domain, no
  category filter). Before 10.2.0 only some categories got the Worry-free half — libraries and video embeds
  (bbc.com among them) got a half-exemption, which read as "the whitelist does not work".
- **GREY** — hosts where ANYONE can publish (`GREY_DOMAINS`: jsdelivr.net, unpkg.com, esm.sh,
  registry.npmjs.org, storage.googleapis.com, firebasestorage.googleapis.com). Trusted as a service, never its
  content: no filter-list allow, no Worry-free exemption — GREY never touches filter rules. Effects: the
  Matrix panel's tooltip, a build WARNING when a protection list would block a GREY host as a whole.
- **No whole-domain googleapis.com** — too broad (it overrode ad/telemetry API blocks). Only fine-grained hosts.

**Why it is a hard constraint.** A user-content host on WHITE lets any uploaded script pass every filter and
protection (B11). `tools/check-whitelist-levels.mjs` (suite step 54) fails on: a WHITE entry equal to, inside or
containing a known anyone-can-publish platform (`USER_CONTENT_HOSTS`), a domain in two levels, a WHITE entry
missing from the Worry-free list, a trusted GREY entry, or a whole-domain googleapis.com.

**Standing rule:** when a language/region filter list is added, add that area's payment, bank, sign-in,
meeting, gaming and streaming services to the whitelist (core list or `app-whitelist-domains.js`) in the same
release — never to a second list. Whole portals (e.g. `globo.com`, `facebook.com`) and shared CDNs are not
listed. The per-toggle `securityAllowlist` stays the escape hatch.

## Known gap — nine design/analysis docs referenced in code but not in any of the three zips (found during the 10.0.3 baggage-removal pass)

Comment references to the following nine documents exist in the shipped
code (code comments, never user-visible), but none of the nine is present
in the extension, tools, or docs zip as received. This is the same
"derived export missing files on purpose vs. never written at all"
ambiguity the Ground Rules' own Multi-artifact packaging integrity section
warns about — recorded here factually, per that section's convention,
rather than silently working around it or inventing replacement content.
The comments that cite them were left as-is (not rewritten or stripped):
each one is still informative on its own (it states a decision and the
reason), just without a pointer to the fuller account. If any of the nine
is ever recovered, diff it against nothing — there is no reconstruction to
compare it to — and restore it to the docs zip's `DOC_FILES` list in
`tools/package-release.mjs`.

| Document | Referenced from (file count) |
|---|---|
| `uBol-stripped-code-review.md` | 8 files — the STATE/GUARDS header convention in several core/ and util/ modules cites this as its origin |
| `COOKIE-CLICKER-DESIGN.md` | 7 files — cookie-clicker scriptlet/picker/routes design history |
| `Security_evaluatie.md` | 3 files — the "Medium finding #1/#2" trust-boundary audit this document's own C28-adjacent fixes cite |
| `Custom-Rule-Scriptlets-Plan.md` | 2 files |
| `REFACTOR_PLAN.md` | 2 files — distinct from the `CHANGELOG_HISTORY.md` "REFACTOR STATUS" block, which is a real, current, in-file status tracker, not this missing document |
| `dispatcher-refactor-plan.md` | 2 files — the message-routing refactor's own design rationale |
| `NEVER-CONSENT-DESIGN.md` | 1 file — the v8.2 global auto-deny session design |
| `PORTING_9_4_9_ISSUES_FOUND.md` | 1 file — already separately marked in `OPTIMIZE.md` as "a working note, not shipped in any release artifact," so this one is a known, accepted gap rather than a surprise |
| `TEST_PLAN.md` | 1 file |

Two further references — `Injection-architecture-evaluation.md` in
`js/data/ddns-freehosting-list.js` and `js/core/matrix-detect.js` — were
corrected in 10.0.3 to the real file, `Xplainer_Injection-architecture-evaluation.md`
(present in this docs zip): both were a missing-prefix typo, not a lost
document, so no entry for that one is in the table above.
