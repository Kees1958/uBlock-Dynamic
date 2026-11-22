# Chrome MV3 Extension — Engineering Manual

*Programming principles, audit checklist and working agreement for uBlock-Stripped-Dynamic (shared with its sibling
projects 3P Matrix and DownloadSentinel). Content version v15 — v14 plus a threat model, input limits, intake rules
for third-party and new code, performance rules for page scripts and the worker, and generated-input tests; see
Appendix B.*

> **Trigger phrase:** *"Full extension audit"* — then upload the extension zip. See [How to run a full audit](#how-to-run-a-full-audit).

---

## How to use this manual

**Reading order.** The manual follows the order in which a change is designed and delivered:

| Part | Chapters | Answers the question |
|---|---|---|
| **I — Architecture** | 1 Structure & modules · 2 State & lifecycle · 3 Errors & consistency · 4 Data & filter processing · 5 User interface | How is the code built? |
| **II — Security** | 6 Trust boundaries · 7 Store, permissions & release security | What may never be trusted or exposed? |
| **III — Performance** | 8 Memory, data structures & service-worker cost | What keeps it fast and bounded? |
| **IV — Principles** | 9 Forbidden practices · 10 Engineering principles · 11 Verification · 12 Automated check suite | How do we know it is right? |
| **V — Cooperation** | 13 Working with the owner · 14 Release process | How do we work together and ship? |
| **Appendices** | A ID index · B Version history of this manual | Where is rule X? What changed? |

**Identifiers never change.** Every rule keeps the ID it has always had — A1–A9 (UI), B1–B15 (code quality),
C1–C59 (architecture and process; C43–C46 unused here), F-* (forbidden practices), G1–G8 (pre-zip gate). Code comments, the changelogs and
the check scripts cite these IDs, so the chapters regroup rules by topic but never renumber them. Appendix A maps every
ID to its chapter. "Part D" (the automated check suite) and "the Ground Rules" are kept as names because other files
use them: Part D is Chapter 12, the Ground Rules are Chapters 13–14.

**How each rule is written.** *Rule* — what to do. *Why* — the failure it prevents, usually a real incident.
*Checklist* — what to verify. *Project status* — how uBlock-Stripped-Dynamic implements it today, where that differs
from the generic text. *Check* (v15, new rules first) — how compliance is verified: a suite step number, "manual", or
"planned" (a planned check is not a check until it runs — C38). A *Metric* line is added only where something is
actually measured. Worked examples are kept short; the full technical history is in `CHANGELOG_HISTORY.md`.

**New rules never weaken old ones (v15).** A rule added later may tighten or extend an existing rule, never relax it;
where two rules seem to conflict, the stricter one applies until the owner decides. New rules join the existing
chapters with new IDs — no topic gets a second home.

**Which changelog.** Wherever this manual says "the CHANGELOG" or "a CHANGELOG entry", it means
`CHANGELOG_HISTORY.md` (the technical record). The short `CHANGELOG.md` never holds a root cause (B4).

---

## How to run a full audit

When the trigger phrase is used, apply this manual to the uploaded extension as an audit covering architecture,
security, performance, HTML/CSS structure and code quality.

1. **State the source.** Name the exact version worked from (`Working from v10.7.6`) and confirm it is the latest
   verified, complete tree — not a partial export (Chapter 14, G1).
2. **Change nothing yet.** Do not change logic or behaviour; reorganise, extract, isolate, document and flag only.
   Do not rename message types, storage keys or public API functions (they are contracts between modules), and never
   silently change settings defaults or storage keys (existing users' saved settings depend on them).
3. **Report all findings first**, so the owner decides what to apply (Chapter 13).
4. **Apply one file at a time.** After every file change, verify HTML validity and run `node --check` on all JS.
5. **Run the pre-zip gate** (Chapter 14) before asking permission to package anything.

---
# Part I — Architecture

## Chapter 1 — Structure & modules

### C1. One module, one responsibility

Every module file has one clearly stated purpose. A file that handles more than one concern (for example UI rendering
and storage writes) is split.

### C2. No direct cross-module state access

Module A never reads or writes a variable owned by module B; B exposes a getter or command function.

```javascript
// Wrong
import { sessionState } from './monitor.js';
if (sessionState.active) { ... }

// Correct
import { isMonitorActive } from './monitor.js';
if (isMonitorActive()) { ... }
```

### C12. Clean API boundaries between modules

Every call between modules goes through an explicit, named function:
- A getter when A needs B's data (`getLoggerWindowId()`); a command function when A needs B to act (`startLogger(config)`).
- Arguments are plain data — never live references to internal state objects.
- Every public function validates its inputs (C6).

### C3. Message routing — one listener, one route table

All `chrome.runtime.onMessage` handling goes through one router. No scattered `addListener` calls that each handle a
subset of messages.

**Project status (10.7.6, audit D-3) — a route table, not a `switch`.** One `runtime.onMessage` listener in
`background.js` hands every message to `dispatchRoutedMessage()` (`js/workflow/message-routes.js`). The declarative
`MESSAGE_ROUTES` table states per message whether the extension must be initialised and which senders may send it
(`SENDER_KINDS`, `isTrustedSender()`), next to a handler table. That is stronger than a `switch`: the sender rule is
written next to every message. An extra listener is allowed only when it is (a) temporary and removed in `finally`
(the `compileFilters:` listener in `js/core/compiled-filters.js`), or (b) in its own page or content-script context
(e.g. `js/scripting/cookie-clicker-picker.js`). Checked by C20a.

**Why the sender rule matters (3P Matrix 5.0.6, its C46):** `sender.id === chrome.runtime.id` is also true for every
content script the extension injects, so a same-id check does not tell an extension page from a content script inside
a web page. A router without per-message sender kinds lets any content script reach settings import, reset or trust
decisions. uBD has had `SENDER_KINDS` since 10.7.6; 3P Matrix gained the same gate in 5.0.6.

### C31. Extension messages are JSON-serialized — plain data only across `sendMessage`/`Port`

By default, Chrome's `runtime.sendMessage`, `tabs.sendMessage` and `Port.postMessage` serialize as JSON, not structured
clone (Firefox uses structured clone — easy to miss when porting to the Firefox sibling). Since **Chrome 148** an
extension can opt in to structured clone with the manifest key `"message_serialization": "structured_clone"`; without
that key, and on any Chrome before 148, JSON stays the format.

**uBD deliberately stays in JSON mode — because it is the safer format, not for old-Chrome support:** the manifest
has no `message_serialization` key. JSON lets exactly five kinds of value across the boundary (string, number,
boolean, null, plain object/array), and every handler a page's content script can reach validates against that set
(C6, F-TRUST-2). Structured clone would also let `Map`, `Set`, `Date`, `RegExp`, `Error`, binary buffers, `BigInt` and
self-referencing graphs through — more shapes every handler must expect, and heavier graphs a sender can build to
make copying or walking costly. Neither format carries functions or methods. What structured clone gains (no silent
loss) is robustness, which the rule below and step 38 already provide. Do not opt in without revisiting this
reasoning first. Step 33 fails if the key appears.

Nothing throws in JSON mode; the value arrives changed:

| `Map` / `Set` | `{}` — every entry lost |
| `Date` | ISO string |
| `undefined` property value | property missing |
| `NaN` / `Infinity` | `null` |
| class instance | plain object, methods gone |

**Rule:** convert to JSON-safe data at the send site (`Object.fromEntries(map)`, `[...set]`, `date.getTime()`) and
rebuild at the receive site — the same single-boundary conversion B14 requires for storage.

**Checklist:**
- [ ] No `Map`, `Set`, `Date`, class instance or `undefined`-valued field the receiver depends on, in any payload or
      handler response.
- [ ] When a collection is converted to `Map` (B14), grep every message that carries it before calling it finished.

*Status at 9.7.5: no message passes a `new Map`/`new Set` literal; payloads assembled from a `Map` elsewhere were not
individually audited (open item). Suite step 38 checks every response in unpacked builds.*

### C4. Storage access — one layer

All `chrome.storage` reads and writes go through one storage utility module. No direct `chrome.storage.local.get/set`
in feature modules.

### C15. Five-tier folder structure

```
extension-root/
├── ui/           Tier 1 — User interface
├── workflow/     Tier 2 — Workflow & orchestration
├── core/         Tier 3 — Core feature logic
├── util/         Tier 4 — Shared utilities & helpers
└── data/         Tier 5 — Data, storage & external services
```

Dependencies flow only downward:

```
ui/       →  workflow/, core/, util/, data/
workflow/ →  core/, data/, util/
core/     →  util/, data/
util/     →  (nothing — self-contained)
data/     →  (nothing inside the extension — only external APIs)
```

An upward or sideways dependency is a violation: flag it and propose the move.

**Project status (10.7.6):** the real tier map, and why `scripting/`, `offscreen/`, `generated/` and `resources/` sit
outside it, are defined in `ARCHITECTURE.md` — that file is the reference, this principle the rule. Two refinements
decided there: `data/` may import a **zero-import** `util/` helper (a file that imports nothing can never close a
cycle), and a helper that calls a browser API belongs in `core/`, not `util/` (`panel-window.js` moved for that
reason).

**Check:** cycles — step 26 (madge); direction — step 93 (`tools/check-tier-direction.mjs`, 11.0.3). Step 26 alone
let a sideways import through twice: the audit of 11.0.2 found `workflow/ad-cleaner-routes.js` importing
`workflow/filter-routes.js`, the route-to-route shape fixed in 10.7.12. Fixed in 11.0.3 the same way —
`trustedHostnameFromSender()` moved to `util/trusted-sender.js`, `saveCustomCosmeticSelectors()` to
`core/cosmetic-rule-save.js` — and step 93 now fails any upward import, any import of a workflow/ file other than by
`background.js`, and any util/ import not listed. 

**util/ → util/ exception (owner's decision, 2026-11-22).** A util/ file may import another util/ file **that imports
nothing**, under three conditions together: (1) the target imports nothing (it can never close a cycle — re-checked by
step 93 every run); (2) the alternative would break or contradict another rule — e.g. copying a constant, against B2's
one source of truth; (3) the owner discussed and approved that specific import. Each approved import is listed with its
reason in step 93's `UTIL_IMPORT_EXCEPTIONS`; anything unlisted fails. Approved so far: the three 11.0.2 imports that
share one hostname limit/shape and one punycode converter (`popunder-parser.js`, `site-mode-parser.js` →
`utils.js`, `punycode.js`).

### C16. Service-worker load order

**Project status (10.7.6, audit D-2) — static `import`.** The service worker is an ES module
(`"background": { "type": "module" }`): `importScripts()` does not exist there and dynamic `import()` is not allowed
(C33, step 36). Every module is loaded with static `import`, the import graph follows C15's tier direction, and nothing
is loaded conditionally (C7). The import graph decides load order, so a module may rely only on what it imports.

*Original classic-worker form, kept for reference:* load files bottom-up by tier in one `importScripts()` call, each
commented with its tier and exports; wrap optional modules in `try { importScripts('core/dev-tools.js'); } catch(e) {}`.

```javascript
importScripts(
  'data/message-types.js', 'data/constants.js', 'data/state-storage.js',   // Tier 5
  'util/tld-utils.js',                                                       // Tier 4
  'core/tld-engine.js', 'core/rule-builder.js', 'core/site-rules.js',        // Tier 3
);
```

### C17. Page-context load order

Page scripts load in bottom-up tier order, mirroring the service worker for shared files. Never duplicate a constant
or function in a page script that already exists in a shared file.

**Project status (10.7.6, audit D-12) — module scripts: order matters, position does not.** Every extension page loads
`type="module"` scripts, which run after parsing wherever the tag stands. The order between tags (and each module's
imports) still matters; "bottom of `<body>`" is not needed.

### C7. Feature isolation

A feature that is not always active is:
- isolated in its own module file;
- switched by a setting or a run-time check — **never by a load that may fail** (project status 10.7.6: `importScripts`
  does not exist in the module worker and dynamic `import()` is forbidden, step 36);
- completely removable by excluding its file — no stubs or dead code paths left behind.

### C9. Naming conventions

| Kind | Convention | Example |
|---|---|---|
| Files | `kebab-case.js` | `session-deadline.js` |
| Module-level constants | `UPPER_SNAKE_CASE` | `SESSION_TIMEOUT_MS` |
| Functions | `camelCase`, verb first | `startLogging()`, `buildRules()` |
| State variables | `camelCase`, noun | `loggerWindowId`, `activeTabId` |
| State vectors | `camelCase`, noun or `…State` | `session`, `swLifecycle`, `pipelineState` |
| Phase enums | `UPPER_SNAKE_CASE` frozen object | `SESSION_PHASES`, `SW_PHASES` |
| Message types | `UPPER_SNAKE_CASE` string constant | `const MSG_START_LOGGING = 'START_LOGGING'` |
| CSS classes | `kebab-case` | `slider-zone` |

Flag every deviation and propose the corrected name.

### C9a. Named functions use the `function` keyword

A function that is given a name — a top-level declaration, or an inner function assigned so it can be referred to —
is written `function name(…) { … }` (or `async function`), never `const name = (…) => { … }` or
`const name = function(…) { … }`.

**Why:** the project's text-based checks find "which function contains this call" by the `function name(` shape. An
arrow or function expression is identical at run time but invisible to such a scanner, so one new call site written
that way silently defeats the classification. *Status after the 9.7.5 audit:* steps 14 and 31 now parse the code
(`tools/lib/scripting-call-sites.mjs`, espree) and resolve arrows, expressions and methods — proven against an
ungated arrow call site the old scanner missed. The rule stays: step 30 still finds handlers by
`export async function handle…`, and one declaration style keeps every scanner simple. (The Semgrep cross-check once
cited for this never ran and was removed — C38.)

**Scope:** short anonymous callbacks passed as an argument (`dom.on('#id', 'click', ev => …)`, `.then(r => …)`,
array callbacks) are unaffected — they have no name to look up.

**Enforcement:** ESLint `func-style: ['error', 'declaration']` catches top-level `const name = () => {}`. It does not
cover `obj.prop = function() {…}` without its own name — flag those by hand.
(`registerContentScripts.register = async function register() {…}` already names itself and is correct.)

### C10. Module header

Every module starts with a header block:

```javascript
// ── module-name.js ────────────────────────────────────────────────────────────
// One-sentence description of what this module does.
//
// Public interface:
//   startXxx(args)   — description
//   stopXxx()        — description
//
// Dependencies:
//   background.js: RULE_ACTIONS, applyState
//
// State owned by this module:
//   session  {Object} — state vector; see SESSION_PHASES; lost on SW restart (safe: UI re-requests)
//   entries  {Array}  — FIFO capture buffer, max FIFO_MAX entries; lost on SW restart (safe)
//
// Input trust (v15 — modules that take outside input only):
//   handleImport(text) — UNTRUSTED (file); size checked first (C49), lines validated by parseLine()
//
// Errors (v15 — same modules):
//   returns { ok: false, error } on bad input; storage failures propagate to the caller (C5)
//
// NOTE: any important constraint, e.g. "only works in unpacked extensions"
```

The two v15 lines are required only for a module that receives data from a page, a file, a message, storage written by
a page-visible context, or the network. Prose, not a machine-readable schema: the header must stay readable and cheap
to keep true. Upstream-derived files keep their own header shape but gain the project header (owner's decision,
2026-11-14).

### C11. Single-purpose functions

Every function does exactly one thing and is named after it:
- The name is a verb phrase that fully describes the effect.
- If it takes more than one paragraph to describe, split it.
- A function does not both compute a value and apply a side effect — split into a pure computation and an application.
- A function longer than ~30 lines is a candidate for splitting.

**Standing decision (10.7.6, owner):** `background.js` (~2,000 lines) and the long functions (183 over 30 lines) are
**not split for size alone.** History: the 10.6.0 per-list scriptlet split was reverted in 10.7.4 (an order/timing
failure visible only in a real browser); the `scripting-manager.js` split stopped because separate files would each
get their own copy of the shared lock; `CHANGELOG_HISTORY.md`'s "REFACTOR STATUS — background.js monolith split" lists
what must stay. Allowed: a **verbatim** move of a function that uses no `background.js` state, with module load order
proven identical before and after and every check that locates code by file text re-pointed. A long function is split
only when it is being changed for a real reason anyway.

**Revision (10.7.12, owner):** the no-split stance was revisited for the large modules. `background.js` was first
regrouped in place (numbered sections, a reading map, code token-identical), then its settings handlers moved to
`js/workflow/settings-routes.js` (about 2,060 → about 1,500 lines). The move followed the rule above (verbatim
functions, no top-level statements, identical load order), plus one structural fix: the site-mode procedures that
Restore settings shares with the Allow list editor and the popup moved down to `js/core/site-mode-apply.js`, because a
route file must not import another route file (C15). The few call sites that changed were proven by a black-box
comparison of the whole worker before and after (same messages in, identical extension-API calls, replies, startup
sequence and final state), with injected faults to show the comparison catches a real difference. The context menu
stays in `background.js`: it launches three features, so it is a coordinator like `onMessage`.

### B5. Architectural ceilings

Add comments where the design has scaling limits (flat in-memory Maps that would need namespacing for multi-profile
use, API rate limits, …) so future developers know the boundaries. Document; do not refactor.

### C18. Module removal checklist

**Service worker:**
- [ ] Remove the `import` line (classic workers: the `importScripts()` entry).
- [ ] Remove all calls to the module's public functions and references to its exported variables.
- [ ] Remove its message-type constants from `data/message-types.js` and its route/handler entries.

**Page contexts:**
- [ ] Remove its `<script src>` tags, its calls from popup/options code, and UI elements that existed only for it.

**Other modules:**
- [ ] Search every remaining file for the deleted module's exported names.
- [ ] Check whether a remaining module was only useful because it served the deleted feature.

**Manifest:**
- [ ] Remove permissions only it required, and its `web_accessible_resources` entries.

### C20. Cross-reference audit — declared files vs files on disk

Every file path declared anywhere must exist, and every file meant to be loaded must be declared somewhere. Dangling
references and orphaned files both mean an incomplete removal or a failed rename.

**Where paths are declared:**
- `manifest.json` — `declarative_net_request.rule_resources[].path`, `background.service_worker`,
  `content_scripts[].js`, `web_accessible_resources[].resources`, `icons`
- service-worker imports
- `<script src>` and `<link href>` in every HTML file
- `rulesets/scriptlet-files.json` and `rulesets/cosmetic-files.json` (`file` of every entry)
- every `chrome.scripting.registerContentScripts()` / `executeScript()` call that names a file

**Checklist:**
- [ ] Every declared path resolves to a real file.
- [ ] Every `.js`, `.json`, `.css`, `.html` in the extension is referenced somewhere, or documented as a build-time-only
      tool (e.g. `tools/build-rulesets.mjs`).
- [ ] No malformed directory entries in the zip (brace-expansion artifacts such as `{js/`).
- [ ] Re-run after any rename or deletion, before packaging.

```bash
# 1. Paths declared in the manifest
python3 -c "
import json, pathlib
m = json.load(open('manifest.json'))
paths = [r['path'] for r in m.get('declarative_net_request', {}).get('rule_resources', [])]
for r in m.get('web_accessible_resources', []): paths.extend(r.get('resources', []))
paths.append(m.get('background', {}).get('service_worker', ''))
for p in paths:
    if not pathlib.Path(p.lstrip('/')).exists(): print(f'MISSING: {p}')
"
# 2. Paths in scriptlet-files.json and cosmetic-files.json
python3 -c "
import json, pathlib
for fname in ['rulesets/scriptlet-files.json', 'rulesets/cosmetic-files.json']:
    try:
        for e in json.load(open(fname)):
            if not pathlib.Path(e['file'].lstrip('/')).exists(): print(f'MISSING ({fname}): {e[\"file\"]}')
    except FileNotFoundError: print(f'NOT FOUND: {fname}')
"
# 3. Unreferenced files — grep each filename across all declaration locations
```

C18 is the *process* for a deliberate removal; C20 is the *verification* after any change (C19's
`web_accessible_resources` bullets are a subset of it). Automated as suite step 8.

#### C20a. Message-type routing — every message type is wired

A `MSG_*` constant can be declared, exported and commented to look important, and be imported by nothing — no missing
file, no failed import, just a dead name. The automated check found exactly this once: an orphaned constant whose name
nearly duplicated a live one.

Every exported `MSG_*` constant is one of two kinds:
- **Request/response** (`runtime.sendMessage`): needs a route entry *and* a dispatch handler.
- **Broadcast-only** (`BroadcastChannel`): bypasses the route table by design; needs at least one `.onmessage` reader.

```python
import re
msg = dict(re.findall(r"export const (MSG_\w+)\s*=\s*'([^']+)'", open('js/data/message-types.js', encoding='utf-8').read()))
routes = open('js/workflow/message-routes.js', encoding='utf-8').read()
bg = open('js/workflow/background.js', encoding='utf-8').read()
broadcast_only = {'MSG_MONITOR_ENTRY', 'MSG_MONITOR_CLOSED', 'MSG_PRIVACY_INSPECTOR_ENTRY', 'MSG_PRIVACY_INSPECTOR_CLOSED'}  # maintained explicitly
print('Missing route:',   [n for n in msg if n not in broadcast_only and f'[{n}]' not in routes] or 'none')
print('Missing handler:', [n for n in msg if n not in broadcast_only and f'[{n}]' not in bg] or 'none')
```

**Checklist:**
- [ ] Every non-broadcast `MSG_*` has a route entry and a handler; every broadcast-only one has a reader.
- [ ] Re-run after adding *or renaming* a message type (a rename that misses the handler fails silently).
- [ ] Two near-identical names (differing only by `SET_`/`UPDATE_`) get a manual look — that is how the orphan arose.

Automated as suite step 7.

---

## Chapter 2 — State & lifecycle

### B3. Document state, guards and timers

A reference comment block at the top of the service worker covers:
- **State overview** — in memory vs persisted, and what happens on a service-worker restart.
- **State guards** — flags that prevent stale state, with file and line.
- **Race-condition guards** — how timing between async operations is handled.
- **Endless-loop guards** — what prevents event-triggered loops.
- **Timer reference** — every `setTimeout`/`setInterval`/`chrome.alarms` value, what it guards, its variable name.

### B3a. State vectors — the swimming-lane pattern

A module with a multi-phase lifecycle, or one that can be inconsistent mid-operation, owns **one named state vector**:
process identity, the current phase as an explicit enum, and every field that belongs to the phase. Nothing is
scattered over module variables that must be kept in sync by hand.

```javascript
// ── STATE VECTOR ──────────────────────────────────────────────
const SESSION_PHASES = Object.freeze({
    IDLE:     'idle',      // no session active
    STARTING: 'starting',  // reload fired; waiting for navigation commit
    RUNNING:  'running',   // listener active, capturing
    PAUSED:   'paused',    // listener removed; data preserved
});

let session = {
    owner:         'block-monitor',  // who owns this vector
    phase:         SESSION_PHASES.IDLE,
    tabId:         null,
    host:          null,
    startTime:     null,
    timeElapsed:   0,
    timeoutHandle: null,             // belongs to the session, not the module
};

// Guard: log and refuse an unexpected transition.
function assertPhase(expected, caller) {
    const ok = Array.isArray(expected) ? expected.includes(session.phase) : session.phase === expected;
    if ( !ok ) {
        console.warn(`[${session.owner}] ${caller}: expected '${[].concat(expected).join('|')}', got '${session.phase}' — ignoring`);
    }
    return ok;
}
```

Add the lifecycle diagram to the module header:

```
[idle] ──startMonitor()──► [starting] ──onCommitted──► [running] ◄────────────┐
                                                          │                    │
                                       ┌──────────────────┼──────────────┐     │
                                    timeout          stopMonitor    pauseMonitor│
                                       ▼                  ▼              ▼     │
                                    [idle]             [idle]        [paused]  │
                                                                         │     │
                                                                  resumeMonitor┘
```

**Apply it to** every module with a multi-step session (monitor, recorder, scanner) and to the service-worker startup
lane, replacing scattered booleans with one `swLifecycle` vector:

```javascript
// js/data/config.js
export const SW_PHASES = Object.freeze({
    BOOTING:  'booting',   // loadRulesetConfig() in progress
    STARTING: 'starting',  // startSession() in progress
    READY:    'ready',     // fully initialised
    ERROR:    'error',     // start() threw
});
export const swLifecycle = {
    owner: 'background', phase: SW_PHASES.BOOTING,
    startPhase: null,      // sub-step of STARTING: 'migration'|'locale'|'permissions'|'scripts'|'finalising'
    errorReason: null, firstRun: false, wakeupRun: false, firstAlarm: false,
};
export const process = swLifecycle;  // backward-compat alias for existing process.firstRun call sites

// background.js — each step sets its phase, so a hang is pinpointed in devtools
async function start() {
    swLifecycle.phase = SW_PHASES.BOOTING;
    await loadRulesetConfig();
    swLifecycle.phase = SW_PHASES.STARTING;
    await startSession();
}
const isFullyInitialized = start().then(() => {
    swLifecycle.phase = SW_PHASES.READY; swLifecycle.startPhase = null;
}).catch(reason => {
    swLifecycle.phase = SW_PHASES.ERROR; swLifecycle.errorReason = String(reason);
    console.error(`[uBOL] startup failed at startPhase='${swLifecycle.startPhase}':`, reason);
    swLifecycle.startPhase = null;
});
```

Where the pattern is not yet applied, leave a `// ── FUTURE IMPROVEMENT` comment describing the vector it would get
(e.g. a `pipelineState` with phases `idle | compiling | registering | error` for a compile/register pipeline).

### B3b. Self-closing timed-session panels — two independent paths

A timed session (a 5-minute monitoring window, an inspection mode) with its own panel or tab that must close itself
needs its own audit, even when B3a is applied.

**Failure mode:** the panel's own countdown calling `window.close()` is the only way the tab closes. It works while
the tab is focused, then fails exactly where users are — a tab left in the background, where Chrome throttles timers.
The result is a stale, empty panel and no error anywhere.

**Required pattern — redundant paths to the same end:**
1. **The background owns the deadline**, not the panel, converging on one `endSession(reason)`.
2. **A broadcast on expiry** (`BroadcastChannel`) the moment the background ends the session.
3. **An independent poll** in the panel (e.g. every 15 s): "is my session still valid?" — not dependent on the
   broadcast arriving or the display timer surviving throttling.
4. The visible countdown may still close the panel as a first line of defence, but never as the only one.

```javascript
// Panel — independent poll; does not depend on the broadcast or its own throttled clock.
const POLL_MS = 15000;
let pollHandle = null;
function startPoll() {
    stopPoll();
    pollHandle = setInterval(async () => {
        const snap = await sendMessage({ what: MSG_GET_SESSION_DATA });
        if ( !snap ) { stopPoll(); window.close(); }
    }, POLL_MS);
}
function stopPoll() { if ( pollHandle !== null ) { clearInterval(pollHandle); pollHandle = null; } }
broadcastChannel.onmessage = event => {
    if ( event.data?.what !== MSG_SESSION_CLOSED ) { return; }
    stopPoll(); window.close();
};
```

**Project status (10.7.6, audit D-1) — the background deadline is a `chrome.alarms` alarm.** The earlier text
prescribed a primary `setTimeout` plus a `setInterval` watchdog in the service worker. Both die with the worker when
Chrome stops it after ~30 s idle; with the panel closed by its X, a session could run on indefinitely. The deadline
is now an alarm (`js/core/session-deadline.js`): kept by Chrome, it wakes the worker at the deadline. It is armed on
start/resume, cleared on pause/stop, and reconciled at worker boot (which also releases resources a session left
registered in Chrome). An in-memory `setTimeout` only adds exact timing while awake. General rule: F-SW-1.

**Checklist:**
- [ ] Every feature with a session timeout and a self-closing panel is identified.
- [ ] The deadline lives in the background as an alarm, not only in the panel.
- [ ] The panel has an independent poll, not only a broadcast listener.
- [ ] Sibling features solving the same problem use the *same* mechanism (C21).
- [ ] Every timer, poll and channel is cleared on every close path (B10).

### B7. Service-worker restart survival

For every piece of in-memory state:
- If it is lost on a restart, is that intentional and safe?
- If it must survive, is it persisted to `storage.session` or `storage.local` and restored at startup?
- Is there a race between the restore finishing and event listeners firing?

### B8. Stateless vs stateful constants

Classify every module-scope `const`/`let`/`var`:
- **Stateless** — a pure constant, never mutated.
- **Stateful, initialised from storage** — has a correct default and is never used before the load completes.
- **Stateful, in memory only** — intentionally ephemeral; document why losing it on restart is safe.

Flag any stateful value used before it is initialised.

### B9. Settings default coverage

For every key in the settings defaults:
- It works correctly on first install.
- A new key has a backwards-compatible default for existing users.
- The options page loads, shows and saves it — no orphaned settings, no UI fields that are never persisted.

### C8. Lifecycle management

A module that acquires resources owns their cleanup: it has an explicit `stop()`/`cleanup()`, the background calls it
when appropriate, and timers live in a named variable of that module (preferably inside its state vector) and are
cleared in `stop()`.

### B10. Resource release audit

Every resource acquired is explicitly released when its lifecycle ends:
- **Event listeners** added dynamically are removed when no longer needed.
- **Timers** — every handle is stored (ideally in the owning state vector) and cleared.
- **Storage** — an entry deleted from memory is deleted from storage too.
- **Window references** are nulled when the window closes.
- **AbortControllers** — `abort()` is called and the controller dropped when a fetch completes, times out or is cancelled.
- **Per-item resources** (downloads, requests, scans) are released when the item's lifecycle ends.
- **Resources registered in Chrome** (content scripts with `persistAcrossSessions`, alarms, rules) never outlive the
  state that owns them: release on every end path and reconcile at worker start — no owner state, no resource (F-SW-3).

### C13. Consistent state on every code path

The system is valid after every operation, not only on the happy path. Audit the **success, failure, timeout,
cancellation and service-worker-restart** paths of every operation. Use the state vector (B3a) so `phase` is always
authoritative; an `assertPhase()` guard at each transition makes an inconsistent state explicit and logged. Flag any
flag set to `true` at the start of an operation that may never be reset on failure.

### C14. Atomic state transitions

State that must change together is written together.

```javascript
// Wrong — a restart between the two calls leaves inconsistent state
chrome.storage.local.set({ logging: false });
setTimeout(() => chrome.storage.local.set({ logs: [] }), 3000);

// Correct — one atomic write
chrome.storage.local.set({ logging: false, logs: [], logStartTime: null });

// In memory: reset every field of the vector synchronously, before any async call
session.phase = SESSION_PHASES.IDLE; session.tabId = null; session.host = null;
session.startTime = null; session.timeElapsed = 0;
broadcastMessage({ what: MSG_MONITOR_CLOSED, reason });
```

Flag any place where related storage keys are written in separate `set()` calls.

### C13b. Dead guards and stale state

Guards, branches, flags, migrations and feature sets are audited to confirm they still protect something real.
- **Guard liveness:** every `if (FEATURE_ENABLED)` / `if (mode === X)` / `if (SET.has(id))` has a live path where it is
  false. A guard set whose members were all removed goes, with all code that reads it.
- **Completeness:** every enum value, phase and flag is both assigned and read somewhere reachable.
- **Migrations** that fold legacy values are checked against the real version history; a migration from a value that
  never shipped is dead from day one.
- **Removal:** a removed feature's identifier is gone from source definitions, manifests, registration files, UI maps,
  message handlers, background initialisation and migration code.

**Rule of thumb:** what cannot be shown to affect observable behaviour today is dead code and is removed — not kept
"for future use".

### C32. Storage schema versioning

Every stored key is a contract with every existing install. When a key's name or shape must change, the change needs
a migration — and ad-hoc migrations per module cannot answer whether every user's storage reached the current shape.

**Pattern:**
- One stored `schemaVersion`, its current value declared in one constants file.
- One ordered list of idempotent steps (`{ from: 3, to: 4, run: async () => … }`), one shape change each.
- Run from one place: `runtime.onInstalled` (`reason === 'update'`) **and** a startup comparison of stored vs current
  version — `onInstalled` alone does not re-fire after a step that threw halfway.
- A failed step leaves `schemaVersion` at the last completed step, is logged with `from`/`to`, and retries next start.

**Checklist:**
- [ ] Every renamed/reshaped key since the last release has a migration step, not an inline copy in a feature module.
- [ ] `schemaVersion` is written in the same `set()` as the step's last change (C14).
- [ ] Each step is tested against storage in the *old* shape, not only a fresh install — and, per G6, in a real browser
      from what the old version really stored, across a restart.

*Status at 9.7.5 (verified by reading the code — C24):* `runVersionMigration()` in `background.js` runs at startup
whenever the stored version differs from the manifest's, as one idempotent pass (retired keys in
`RETIRED_SECURITY_CONFIG_KEYS`, orphaned session-rule ranges cleared by id band). A valid alternative to numbered
steps. Open: it is one ~500-line function and records no per-step progress.

### C33. No dynamic `import()` in the service worker — lazy data is fetched

The HTML specification disallows dynamic `import()` in a service worker in every browser; it throws every time. Static
`import` is fine; `importScripts()` exists only in classic workers.

**Why it survives review:** wrapped in a `.catch()` for "graceful degradation", the guaranteed failure becomes a silent
one. This project shipped exactly that: the Tracker Radar dataset never loaded on any install for several releases,
and the only symptom was a column that always read "no" (see `js/core/tracker-radar-lookup.js`).

**Rule:**
- Lazily needed data ships as JSON and is loaded with `fetch(browser.runtime.getURL(path))` on first use — the pattern
  `scripting-manager.js` and `tracker-radar-lookup.js` already use (C21).
- Code the worker needs is imported statically; if its cost matters, make that module's top level cheaper.
- A `.catch()` on a data-loading path logs with context (C5), never swallows.

Enforced by suite step 36 (no `ImportExpression` in the worker's static import graph). F-SW-2.

### B12. One-time-only UX flags

A storage-backed "shown once, never again" flag (onboarding hints, intro popups, first-run tips) can make a feature
look broken forever for exactly the users who needed it — with no error anywhere.

```javascript
async function maybeShowIntro() {             // the pattern to detect
    if ( await localRead('feature.introSeen') ) { return; }
    showIntroUI();
    localWrite('feature.introSeen', true);    // set when SHOWN, not when read and understood
}
```

**Why it is a bug:** a popup with a few-second auto-dismiss is easily missed (tab not focused, accidental click); after
that one showing it is gone for that profile, through every future version. Real instance: a picker's explanatory
intro with a 3-second auto-dismiss — a user who missed it reasonably concluded the feature had regressed.

**Checklist:**
- [ ] For every "shown once" flag: can the user see the content again on purpose?
- [ ] If not, and the content explains how to use the feature: show it every time (preferred if brief), add a
      permanent "?" affordance, or make the single showing long / non-auto-dismissing.
- [ ] An auto-dismiss under ~5 s combined with "shown once ever" is a strong candidate for this bug.
- [ ] The flag's key is feature-prefixed and not shared with unrelated code.

---

## Chapter 3 — Error handling

### C5. Errors are propagated, declared or reported — never swallowed

Every `async` function either returns a rejected promise (the caller handles it) or catches, logs with context and
returns a safe default. Never an empty `catch {}`.

**Rules added in 10.7.6 (audit of 10.7.5):**

1. **Expected errors are declared once.** Routine, harmless browser failures — the tab closed mid-update
   (`No tab with id`), a content script already unregistered, no message receiver, an unscriptable page — are named
   classes with the browser's real text in `js/data/expected-errors.js` (`EXPECTED_ERRORS`). Handle with
   `.catch(catchExpected('<what was attempted>', [ EXPECTED_ERRORS.X ], fallback))`: declared classes are dropped,
   **everything else is logged with that context**, and the caller continues with the same fallback. A new routine
   error gets a new class (with a test of its real message), never a bare `.catch(() => {})`.
2. **`// benign: <reason>` is only for local parse fallbacks** (`try { new URL(x) } catch {}` where the empty value is
   the handling). Anything touching a browser API or storage uses rule 1.
3. **A failure the user caused is reported where the user acted.** When a save, import or restore cannot be fully
   applied, the background returns `{ ok: false, error }` and the page shows a plain-words notice next to the control —
   e.g. "Your rules were saved but could not be applied: … The previous rules stay active." — in every channel that
   triggers the same work (editor save, file import, settings restore; C22/C41). A control that did not take effect is
   set back. Not a browser notification: that needs the `notifications` permission, which would disable the extension
   for existing users (C36). Automatic background work with no user action behind it is logged only.
4. **No raw promise-chain locks.** `p = p.then(fn)` as a lock leaves `p` rejected after one failure, so every later
   step is skipped silently until the worker restarts. Use `createLock()` (`js/util/async-lock.js`): each step runs
   after the previous one settled, and each caller still sees its own failure. Real 10.7.5 instances:
   `loadRulesetConfig`/`saveRulesetConfig`, custom-filter storage, cosmetic rule dates, the ABP compiler.

**Why:** the 10.7.5 audit found a failed ABP-import compile swallowed completely (the dashboard looked successful and
the old rules stayed active), ~30 more `.catch(() => {})`/empty `catch {}` sites in service-worker code, and — found by
the new test, not by reading — the four raw locks above. It was the third audit in a row with silent swallows, so per
C25 it got a standing check.

**Enforced by** step 72 (`tools/check-silent-catch.mjs`: walks the worker's real import graph; fails on an ignoring
`.catch()`, an unmarked empty `catch {}`, or a raw `x = x.then(…)` lock — 53 findings on 10.7.5) and step 73
(`tools/test-error-reporting.mjs`: expected classes against real browser messages, unexpected errors logged, the
ABP-import failure reported, a later call still running after a failure — fails on 10.7.5, C42). Related user-input
rules: F-ERR-2, F-ERR-3 (a line that cannot be used is commented out with `! Rejected: <reason>`).

---

## Chapter 4 — Data & filter processing

### B1. Centralise magic numbers

Every threshold, score, penalty, bonus and timing value is a named constant in one config section at the top of its
module, with a comment explaining it. **Owner's standing rule:** variables, switches and magic numbers of a module are
declared in one place, commented.

DNR rule-id ranges, slot capacities and storage caps live in one dedicated module (`dnr-budgets.js`) that every consumer
imports — never a local copy. Checked by suite step 9 (range collisions and documented sizes).

### B2. Eliminate duplicated constants

An array, set or list copied across files moves to one shared module that every consumer imports; each consumer gets a
comment pointing at the source of truth.

### B2a. Constants hard-coded in HTML — render them from JS

A JS constant reproduced as text in a page (`options.html`, `popup.html`) diverges the moment the constant changes.

```html
<!-- Wrong — a hand-typed copy of BUILTIN_DO_NOT_CHECK_DOMAINS -->
<p>Built-in defaults: <span class="mono">chromewebstore.google.com</span>, <span class="mono">drive.google.com</span></p>
```

**Fix:** move the constant to a shared module loaded by both contexts; replace the HTML with an empty placeholder
(`<span id="builtinDomains"></span>  <!-- populated from APP.BUILTIN_DO_NOT_CHECK_DOMAINS by OptionsPage.js -->`);
fill it on load by creating elements and setting `textContent` (never HTML text with values — F-SINK-1).

```javascript
function renderBuiltinDomains() {
    const span = document.getElementById('builtinDomains');
    if ( !span ) { return; }
    const domains = APP.BUILTIN_DO_NOT_CHECK_DOMAINS || [];
    span.replaceChildren(...domains.flatMap((d, i) => {
        const el = document.createElement('span');
        el.className = 'mono';
        el.textContent = d;
        return [ el, i < domains.length - 1 ? ', ' : '.' ];
    }));
}
```

**Checklist:**
- [ ] Search every HTML file for inline lists of domains, error codes, extensions, thresholds or any value that is also
      a JS constant.
- [ ] Changing the JS constant alone updates the page — no HTML edit needed.

B2 is JS-to-JS duplication, B2a JS-to-HTML; C39a generalises both to every derived value, tests included.

### B15. One parser per syntax — consolidate near-duplicate parsers

Two parsers of the same concept in two syntaxes (two filter dialects, two config formats) drift, and the drift is
usually not in the real syntax difference but in an incidental step — an argument splitter, whitespace handling, a
validation — that one copy happens to do better. The same input then gives two results depending on how it was
written.

**When two parsers/handlers for one concept exist:**
- [ ] List the genuine syntax differences (a marker, a delimiter, a keyword).
- [ ] List every other step each copy does (splitting, quoting, trimming, validation, errors). Any mismatch there is drift.
- [ ] Where only a marker differs, merge: one regex with the alternation isolated to the marker, one shared
      implementation of everything else.
- [ ] A capability one format gains by the merge is flagged as a real capability change, not absorbed silently.
- [ ] Every "try format A, then format B" caller now calls the merged function.

**Worked example:** a filter-import feature accepted scriptlets as `##+js(...)` and `//scriptlet(...)` through two
parsers. One split arguments quote-aware; the other used `.split(',')` and mis-split a quoted comma. They also disagreed
on comma-separated hostname lists. Merging fixed the comma bug and gave the second syntax multi-hostname support.

**Project status (10.7.6) — ONE network parser.** The build had its own network-filter parser next to the ABP-import
parser (a vendored copy of upstream uBO's). A per-line differential run over every built-in list (88,338 lines) showed
~6,000 disagreements, the build wrong in nearly every case (lost `^` separators, `$removeparam` compiled as a block,
unknown options swallowed into the pattern). Owner's decision: one parser — the vendored one, now owned by this project
and adapted to the ABP/AdGuard dialect, no longer tracked against upstream. The build keeps only its own decisions
*around* it (which rule kinds a static list ships). Every changed rule was explained before the switch
(`tools/compare-rulesets.mjs`); each fix is an assertion in suite step 74, run against both consumers. F-PARSE-1.

### B13. Chrome DNR `regexFilter` constraints and ruleset limits

`condition.regexFilter` is constrained in ways JavaScript regex knowledge does not cover, enforced by Chrome at
rule-apply time and invisible to any JS syntax check:

- **RE2, not PCRE/JS.** No lookahead `(?=…)`/`(?!…)`, lookbehind `(?<=…)`/`(?<!…)`, or backreferences `\1`–`\9`,
  `\k<name>`. A pattern that works as a JS `RegExp` can still be rejected as a DNR rule.
- **ASCII only.** DNR matches the already punycode/percent-encoded URL; a literal non-ASCII character is invalid.
- **`MAX_NUMBER_OF_REGEX_RULES` = 1,000**, counted separately for (a) dynamic + session rules together and (b) each
  static ruleset. Staying under a feature's own rule cap does not mean staying under this one. `updateDynamicRules()`
  is atomic, so exceeding it rejects the **whole** batch — thousands of valid non-regex rules included.
- **RE2's memory limit** (`memoryLimitExceeded`) cannot be predicted by any static check.

**The authoritative check is `chrome.declarativeNetRequest.isRegexSupported()`** — Chrome's own RE2 engine, which also
reports patterns that are "too complex". A static pre-flight (below) is a sanity check, not a replacement.

**Static rulesets have their own limits** (10.7.6, D-9): at most **100 declared** rulesets, **50 enabled** at once, and a
**30,000-rule guaranteed** static budget. They are named constants in `js/core/dnr-budgets.js`
(`MAX_NUMBER_OF_STATIC_RULESETS`, `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS`, `GUARANTEED_MINIMUM_STATIC_RULES`), checked
against the shipped manifest (step 78). A refused `updateEnabledRulesets()` is **returned** and shown where the person
acted, and the switch is set back — never only logged (F-DNR-2, F-ERR-2).

**Checklist:**
- [ ] Every static `regexFilter` literal is ASCII-only and free of RE2-unsupported syntax.
- [ ] Every dynamically built `regexFilter` (e.g. from an ABP import) passes `isRegexSupported()` before
      `updateDynamicRules()`/`updateSessionRules()`; refused patterns are dropped and **reported with Chrome's reason**,
      never left to fail the whole batch.
- [ ] Where a feature's own rule cap exceeds 1,000 and many rules can be regex, regex rules are counted against the
      1,000 cap before submission — or the generic batch error is a documented, deliberate choice.
- [ ] Ruleset counts stay within the 100 / 50 / 30,000 limits.

```javascript
// Static pre-flight — catches gross RE2-incompatible constructs and non-ASCII before Chrome sees them.
// NOT a substitute for isRegexSupported() (a different regex engine with different acceptance rules).
const RE2_UNSUPPORTED = [
    { pattern: /\(\?=/,   label: 'positive lookahead (?=...)' },
    { pattern: /\(\?!/,   label: 'negative lookahead (?!...)' },
    { pattern: /\(\?<=/,  label: 'positive lookbehind (?<=...)' },
    { pattern: /\(\?<!/,  label: 'negative lookbehind (?<!...)' },
    { pattern: /\\[1-9]/, label: 'backreference (\\1-\\9)' },
    { pattern: /\\k</,    label: 'named backreference (\\k<name>)' },
];
function checkRegexFilterPattern(regexSource) {
    const problems = [];
    const nonAscii = [ ...regexSource ].filter(ch => ch.charCodeAt(0) > 127);
    if ( nonAscii.length > 0 ) { problems.push(`non-ASCII character(s): ${nonAscii.join(', ')}`); }
    for ( const { pattern, label } of RE2_UNSUPPORTED ) {
        if ( pattern.test(regexSource) ) { problems.push(label); }
    }
    return problems;  // empty = no static red flags
}
```

**Project status (10.7.6) — regex rules in static rulesets.** The authoritative-check rule applies at build time too:
a filter-list regex ships only with a cached "supported" verdict from Chrome's `isRegexSupported()`
(`tools/build/regex-support.mjs`, verdicts in `tools/regex-support-verdicts.json`; a headless Chrome starts only for
regexes without a verdict). No Chrome to ask means **dropped and reported, never shipped unverified** — 82 of the first
106 refusals were `memoryLimitExceeded`, invisible to any syntax check. Owner's limits: a warning above 800 regex rules
in one ruleset; above Chrome's 1,000 the build stops. Suite steps 12 and 75. F-DNR-1.

### C13a. Data-set and build-time consistency guards

Every external input, generated file and configuration data set is validated before it is consumed. Bad data that is
accepted, compiled or shipped without a warning is never acceptable.

**Build time:**
- Every fetch checks the response is non-empty, plausibly sized and shaped like the expected format — a GitHub 404 page
  or CDN error must never compile into a filter list — and contains expected markers (`!`, `||`, `##`).
- Every generated file is cross-checked against its source definition (a ruleset id declared in the source is in the
  manifest and vice versa).
- On any validation failure the build exits non-zero with a clear message; it never falls back to stale or partial output.

**Run time:**
- A JSON file read at run time is checked for null, expected shape and a minimum of entries before use.
- A registration call that names a file (`registerContentScripts`, `updateEnabledRulesets`) confirms the file exists.

**Cross-file:** ruleset ids agree across build source definitions → manifest `rule_resources` → `static-rulesets.js` →
`scriptlet-files.json` → `cosmetic-files.json` → UI display-name maps. Removing a feature means cleaning all of them
(`ruleset_adguard_cookies` once stayed in the manifest after leaving the build script).

### C13c. Overly broad DNR rules are dropped at build time

A rule that blocks all resources of a type on a named site without URL specificity amounts to "disable this website",
breaking CDN scripts, player SDKs and APIs even where the filter author meant only ad networks.

A rule is overly broad when **all three** hold: `action.type === "block"`; `urlFilter` is a trivially wide anchor
(`|https://`, `|http://`, `|https:`, `|http:`, `|http*://*?`); and `domainType === "thirdParty"` with a non-empty
`initiatorDomains`. The bare `|http*://*?` (any URL with a query string) is dropped on its own.

```javascript
// ── OVERLY_BROAD_URL_FILTERS ──────────────────────────────────
// urlFilter values that match virtually every URL. Combined with domainType=thirdParty and a non-empty
// initiatorDomains they disable all third-party requests on the listed sites. Known to break: xvideos.com,
// mediafire.com, jkanime.net, and any site loading CDN-hosted player SDKs or APIs from third-party origins.
const OVERLY_BROAD_URL_FILTERS = new Set([
    '|http*://*?',  // any URL with a query string
    '|https://',    // every HTTPS URL
    '|http://',     // every HTTP URL
    '|https:',      // same without trailing slash
    '|http:',       // same without trailing slash
]);
const beforeBroad = validated.length;
validated = validated.filter(r => {
    if ( r.action?.type !== 'block' ) { return true; }
    const cond = r.condition ?? {};
    const uf = cond.urlFilter ?? '';
    if ( uf === '|http*://*?' ) { return false; }
    if ( OVERLY_BROAD_URL_FILTERS.has(uf) && cond.domainType === 'thirdParty' &&
         Array.isArray(cond.initiatorDomains) && cond.initiatorDomains.length > 0 ) { return false; }
    return true;
});
if ( validated.length !== beforeBroad ) { process.stdout.write(`(dropped ${beforeBroad - validated.length} overly-broad) `); }
```

**Checklist:**
- [ ] The patterns are a named, commented constant, not inline literals.
- [ ] The guard runs after the ASCII/space validity filter and before hostname coalescing.
- [ ] The number dropped is printed at build time.
- [ ] Both shapes are covered (the bare query-string catch-all and the anchor + third-party + sites combination).
- [ ] No hard-coded site exceptions inside the guard — a real need is a separate, named per-site override.
- [ ] The pattern set is reviewed when upstream lists add rules of this class.

C13a guards against bad *input*; C13c against valid syntax that is too destructive to ship. F-DNR-4.

---

## Chapter 5 — User interface

### A1. CSS in numbered sections

Every stylesheet is a sequence of labelled sections, one per UI component, in the order the components appear in the
HTML:

```css
/* ══════════════════════════════════════════════════════════════
   3. SLIDER ZONE  —  level number, name, range slider, ticks
   ══════════════════════════════════════════════════════════════ */
```

Typical order: 1 reset & variables · 2 body & typography · 3 header · 4 navigation/toolbar · 5 main content (one
sub-section per block) · 6 forms, inputs, buttons · 7 tags, chips, badges · 8 modals, tooltips, overlays ·
9 animations & keyframes.

### A4. HTML section comments

A comment before every major HTML block matches the CSS section: `<!-- ── 3. SLIDER ZONE ── -->`.

### A2. Design tokens in CSS variables

Every colour, size, spacing value or font used more than once is a `:root` variable in section 1; rules reference the
variables, never raw hex values or repeated spacing.

```css
:root {
  --bg: #0F1117;  --surface: #181C26;  --border: #252A38;  --muted: #C0C7D4;  --bright: #FFFFFF;
  --accent: #4ADE80;  --red: #F87171;  --yellow: #FFD84D;  --pad: 16px;  --radius: 6px;
}
```

### A3. One consistent left edge

The standard horizontal padding (commonly `16px`) is `--pad`. Flag content that does not align with it, children that
push text further right, and containers with `padding-left: 0` whose children re-add padding inconsistently.

### A5. Orphaned CSS

Flag every rule whose selector matches no element. A selector for an element JS adds is flagged
"JS-injected, verify manually", not removed. (Suite step 11 cross-checks classes both ways.)

### A6. Inline styles

For every `style="…"`: static → a class in the CSS; set by JS → leave it, with `<!-- set dynamically by JS -->`;
a one-off nudge → an `/* Overrides */` sub-section at the end of the CSS with a comment.

### A7. CSS consistency

- Every font family uses the same variable or string.
- Every colour in the file is in `:root`.
- Border, radius and transition values used more than twice are variables.
- No section holds rules that belong to another section.

### A8. Light/dark contrast is computed, not eyeballed

Every text colour, border and faded element (`opacity`, `color-mix(…, transparent)`, partial-alpha tokens) meets a
minimum contrast against its real background **in both light and dark mode**. The reviewer usually sees only their own
mode, and the two themes' real token values differ enough that the same opacity gives very different contrast.

**Required check:**
- [ ] For each new or changed faded value, identify the real foreground and background tokens in both modes.
- [ ] Compute the composited colour (`alpha*fg + (1-alpha)*bg` per channel) and its WCAG contrast ratio in both modes —
      a number, not an impression.
- [ ] Minimum **3:1** for large text and UI components (placeholder glyphs, icon-only controls), **4.5:1** for body and
      data text. Below 3:1 in *either* mode fails.
- [ ] On a failure, reuse a value already proven in both modes (A9, C21) instead of guessing a new one.
- [ ] State both computed ratios in the fix.

**Worked example:** an empty-cell placeholder ("—") at `color-mix(in srgb, currentColor 25%, transparent)` measured
1.62:1 (light) and 2.03:1 (dark) — unreadable in both, yet it looked "intentionally subtle". A sibling element already
used 55%, measured 3.80:1 / 4.88:1; the fix reused that exact value.

### A9. Light and dark style guides — consult and maintain

`STYLE_GUIDE_LIGHT.md` and `STYLE_GUIDE_DARK.md` catalogue every verified token, proven-safe opacity and component
colour pattern in use, each with its computed contrast ratio. A8 is the check; these files are its reference and its
record.

- [ ] Before introducing a colour, opacity or `color-mix()` value, look up the guide and reuse a verified value for the
      same purpose.
- [ ] A genuinely new value is computed in both modes (A8) and **added to both guides** before the work is finished.
- [ ] A value found failing is fixed in the guide too, so it is not proposed again.
- [ ] A widely used token never verified (e.g. tuned for one mode only) is recorded as a known gap, even when not the
      bug at hand.

**Why a guide and not "the codebase is the reference":** grep finds *usage*, not *verification*. `--color-green` and
`--color-amber` were used as text colours in several places before it turned out they passed WCAG only in dark mode.

---

# Part II — Security

## Chapter 6 — Trust boundaries

### C48. Threat model — who can attack, what they can reach, which rule stops it

Security rules are only complete against a stated set of attackers. This table is that set for an MV3 content blocker.
Every row points at the rules that cover it, so a new feature is checked against the rows it touches, and a row with
no rule is a gap to close. STRIDE letters classify the attack: **S**poofing, **T**ampering, **R**epudiation,
**I**nformation disclosure, **D**enial of service, **E**levation of privilege.

| Source | What it can do | STRIDE | Covered by |
|---|---|---|---|
| A web page (and any script it loads) | Forge DOM events; replace builtins in the MAIN world; send messages through a content script it controls; read and write page-visible storage; remove in-page UI; feed huge or hostile DOM to a scan | S T D E | C28, C35, C47, C54, F-TRUST-1…4, steps 76, 81 |
| A file the person imports (Restore settings, custom rules, Import ABP box) | Oversized input; text that escapes a stylesheet; rules that fail a whole DNR batch; regexes Chrome refuses | T D | C49, F-TRUST-3, B13, F-ERR-3, steps 75, 77, 81 |
| A filter-list source fetched at build time | Rules that disable whole sites; remotely hosted code through scriptlets; out-of-scope or malformed content | T E | C13a, C13c, C37, scriptlet policy (step 59) |
| Third-party code we include (uBO/uBOL ports, AdGuard scriptlets, vendor libraries, dev dependencies) | Bugs and unsafe patterns that arrive already written; a poisoned package version | T E | C51, C40, C37 |
| Another extension | Message us | S | No `externally_connectable`, no `onMessageExternal` (C19); C28 sender check |
| The publishing account or the build machine | Push a malicious update to every user | T E | C37, C36, pre-zip gate G1–G8 |
| Our own logs, storage and error text | Disclose browsing data | I | C50, `PRIVACY_POLICY.md` |

**Rule:**
- A change that adds an input, a message type, an injected script, a permission or a third-party file names the rows it
  touches in its changelog entry, and the rules it satisfies for each.
- A new attack source, or a row whose "covered by" cell would be empty, is added here before the feature ships.

**Check:** manual (the changelog entry); the referenced steps check the individual rules.

### C6. Validate input at module boundaries

Every exported function that accepts external input — from messages, storage or DOM events — validates it before
acting. Invalid input is rejected with a logged warning, never silently ignored.

**One validator per data type (v15).** Each kind of outside data (a stored setting, a custom rule, an Allow-list line,
an import payload, a message payload) has exactly one validating function, and every entry path calls it — the same
reasoning as F-TRUST-3 and B15. Validators are hand-written in the project's own code: **no schema-validation library**,
because the extension has zero runtime dependencies and a library would add third-party code (C51) on the most exposed
path. A validator checks type, range, length, allowed values, required fields and unknown fields, in that order, and
rejects with a reason the person can read (F-ERR-2).

### C49. Limit untrusted input before reading it

Bounded collections (B6) protect memory over time; this rule protects every single entry point. A crafted file or
message must not be able to make the extension spend unbounded memory or CPU.

**Rule:**
- Every place where outside data enters has a named limit, declared once (B1): file size, message size, number of lines
  or rules, line length, nesting depth, regex count (B13), fetch time and response size at build time.
- **Check the size before reading or parsing.** For a file, compare `file.size` with the limit *before* `file.text()`;
  for a string, check `.length` before `JSON.parse` or splitting; for a list, check the count before looping over it.
- Over the limit, refuse the whole input with a reason the person can see (F-ERR-2), never truncate silently (F-ERR-3).
- Limits are set well above real use (measure the largest real input, then add headroom), so a limit never breaks a
  genuine user. A limit that a real user hits is a bug in the limit.

**Checklist:**
- [ ] Every `file.text()`, `JSON.parse` of outside text, and message handler that accepts a list or a string has a
      limit checked first.
- [ ] The limit constant states the measured real maximum it was based on.

**Project status (11.0.2):** file imports met. Restore settings (`dashboard/settings-io.js`), Import custom rules
(`dashboard/custom-rules.js`) and the Import ABP box file load (`dashboard/filter-manager-ui.js`) call
`checkImportFileSize()` (`js/util/input-limits.js`) before `file.text()`. The limit is 10 MiB, derived from
`chrome.storage.local`'s own quota without `unlimitedStorage`: a larger file can never be an export of this extension and
could not be stored anyway. Line-level limits exist (`popunder-parser.js` `MAX_LIST_LENGTH`, `cookie-clicker-rules.js`
`RULE_FIELD_MAX_LENGTH`, hostname length). **Open:** no per-message size limit in the router — content scripts send
CSS text of unmeasured size, so a limit needs the real maximum measured first (this rule's own last bullet); until then
none is set rather than a guessed one that could break cosmetic filtering.
**Check:** step 92 (whole-file reads); messages — manual.

### C28. Never trust a hostname from a message — derive it from the sender

A handler that uses `request.hostname` (or `.domain`, `.site`) for anything security- or storage-relevant — a lookup
key, an allow/deny decision, which stored data is read or written — trusts a value the sending context chose. For a
content-script message that value often comes from page-readable state such as `document.baseURI`, which a page can
rewrite (`<base href="…">`). `sender.url` and `sender.tab?.url` are filled in by Chrome from its own record and cannot
be altered by page content.

- Prefer `sender.url` when the sender is the page's own content script (its frame URL *is* the page).
- Prefer `sender.tab?.url` when the sender is a trusted extension-origin context relaying data about a page it does not
  run in (e.g. a picker UI in its own iframe — there `sender.url` is the iframe's extension URL).

**Worked example:** `filter-routes.js`'s `handleAddCustomFilters()`/`handleInjectCustomFilters()` trusted
`request.hostname`. On the picker path it came from `document.baseURI`, read by a page-context script
(`tool-overlay.js`) and relayed into the picker iframe. A page that set `<base href="https://victim.example.com/">`
before the picker fired could read, write or apply another domain's custom filters. Fixed by deriving the hostname from
the sender, porting the mechanism already proven in `privacy-inspector.js` and `cookie-clicker-routes.js` — three
independent occurrences, so per C25 it became a standing check.

**Checklist for a handler that reads a hostname-shaped field from `request.*`:**
- [ ] What is it used for? A storage key, an allow/deny check, any per-site behaviour → continue.
- [ ] Trace its origin on the sending side: can the page influence it before it arrives?
- [ ] If so, replace it with `sender.url || sender.tab?.url` (tab first for a relay iframe), the proven pattern.
- [ ] If it is genuinely display-only, say so explicitly.

**Trusted senders (10.7.6, D-4):** trust only "no sender at all" (internal) or our own extension id **and** origin —
never "an origin is missing" (`isTrustedSender(sender, extensionOrigin, extensionId)` in `message-routes.js`).

**Enforced by** step 30 (`tools/check-message-hostname-trust.mjs`: every `handle*` in `js/workflow/*-routes.js` that
reads a hostname-shaped `request.*` field pairs it with a sender derivation or sits on the check's allowlist with a
reason; a new unclassified hit fails) and step 76. F-TRUST-2.

### Storage visible to pages (10.7.6, audit D-5)

`storage.session` stays at Chrome's default access level (`TRUSTED_CONTEXTS`). Never open it to content scripts
(`TRUSTED_AND_UNTRUSTED_CONTEXTS`) for a convenience cache: a content script runs in every page, and the area holds the
extension's own state (site modes, session states, sites visited). Data a content script must share goes in
`storage.local` — readable by content scripts by default, so treat everything there as page-visible — or by message.
Checked by step 76. F-TRUST-1.

### B11. Trust lists that skip a safety check

A hard-coded list that makes the extension **skip a safety check** is a security boundary. Too broad a list is a gap,
not a convenience.

```javascript
// Every entry here gets zero scrutiny
const BUILTIN_DO_NOT_CHECK_DOMAINS = [
    'chromewebstore.google.com',
    'drive.google.com',     // ← user-controlled content: must NOT be here
    'onedrive.live.com',    // ← user-controlled content: must NOT be here
    'sharepoint.com',       // ← org-controlled: borderline
];
```

| Category | Who controls the content? | May bypass checks? |
|---|---|---|
| Platform-vetted stores | The platform reviews every upload | Yes |
| User-controlled cloud storage (Drive, OneDrive, iCloud, Dropbox) | Any user | **No** |
| Org-controlled hosting (SharePoint, Confluence) | Any org member | Only as a *user* allowlist default, not built in |

**Checklist:**
- [ ] For every built-in entry: who controls the content at that URL? If "any user", remove it.
- [ ] A removed entry with a legitimate use becomes a pre-filled default in the user-editable list, with a comment.
- [ ] Every built-in entry has a comment saying why it is trusted (`// Google-reviewed; every upload is vetted`).

**Late-revealed file types.** When the file type is unknown at download start (Google Drive's redirect chain hides the
name until completion), gating only at `onCreated` passes everything from such hosts:
- [ ] Re-evaluate at completion (`onChanged`) with the confirmed name from `chrome.downloads.search()`.
- [ ] A type unknown at start but dangerous at completion is flagged.
- [ ] Concealing the file type is itself a risk signal in scoring.

B11 is about *which* entries belong; B2a about defining the list once and rendering it everywhere.

### C35. MAIN-world scripts run in hostile territory

Scripts registered with `world: "MAIN"` (scriptlets, autodeny snippets, security-toggle scriptlets) share the page's
JavaScript realm. The page can replace any global at any time — `Array.prototype.includes`, `JSON.parse`, `fetch`,
`Function.prototype.call`, `EventTarget.prototype.addEventListener`.

**Rule:**
- Capture every builtin the script relies on in its first statements (`const { apply } = Reflect; const jsonParse =
  JSON.parse;`) and call only those afterwards — the technique uBO's own scriptlet library uses (`safe-self`).
- Every Proxy handler is declared with `__proto__: null` (Proxy looks traps up through the handler's prototype chain),
  and regexes run through the captured native `exec` (`test`/`match` look up replaceable properties internally).
- Nothing secret, privileged or identifying crosses into the MAIN world — no extension ids as auth, no settings beyond
  what the script needs, no message channel the page could reuse.
- Anything read from the page (a DOM attribute, a global) is untrusted input (as in C28).

**Checklist:**
- [ ] Every MAIN-world file captures its builtins before first use.
- [ ] No MAIN-world message is acted on by the isolated world or the worker without validation.

*Status (audit after 9.7.5):* all 12 `js/security/sec-*.js` files audited; three bypass classes fixed — page-replaceable
builtins called at protection time; replaceable `Reflect.apply`/`construct` and `Function.prototype.call`/`apply`
receiving the unprotected original; Proxy handlers with an ordinary prototype (one line of page code,
`Object.prototype.get = t => …`, obtained the original of any Proxy-based protection). The protections also register in
blank/srcdoc frames (`matchOriginAsFallback`). Accepted gap: a script that creates a blank frame and reads it in the
same synchronous step. AdGuard-generated scriptlets are third-party code and out of scope. Enforced by step 35
(`tools/test-security-scriptlet-tamper.mjs`, proven with `--expect-fail`: all 21 tamper cases were real bypasses).

### C47. UI drawn into a web page is in hostile territory — real decisions only, and the page can remove it

A dialog, picker bubble or prompt that a content script adds to a page's DOM shares that DOM with the page's scripts. A
closed shadow root hides the dialog's **inside**, not its **host element**, and does not stop events the page itself
dispatches.

**Rule:**
- Every handler that acts on a user decision (a button click, Escape, a pick) checks `event.isTrusted` — a page can
  dispatch synthetic clicks and keys and call `.click()`.
- Listeners that must see an event before the page can stop it are on **`window`, capture phase**, added before the
  page's own (at injection). A page's `window` capture listener runs before a `document` capture listener and can
  `stopImmediatePropagation()` it away.
- Assume the page can remove or hide the host. Where hiding the warning is exactly what an attacking page wants, use
  the extension's own page instead (3P Matrix 5.0.6 moved its fake sign-in warning to its warning page for this reason).
  Where removal only cancels the user's own action (a picker the user opened, a dialog that holds a form), in-page is
  fine — say so in the file header.

**Audit checklist:**
- [ ] Every click/keydown handler in content-script UI checks `isTrusted` (a `trustedOnly()`-style wrapper or an inline
      guard)
- [ ] Every interception listener (click, keydown, mouseover, submit, paste, focusin) is on `window`, capture
- [ ] For every in-page UI, the header says what happens if the page removes it

*Status at 10.7.15: `isTrusted` in the cookie-clicker picker's handlers and dialog buttons since 10.7.13; fixed for
10.7.15 — the cookie-clicker picker's mouseover/click/keydown moved from `document` to `window` capture, the
Worry-free in-page picker's buttons and the element-picker overlay's Escape key act on real input only. All three
UIs are tools the user opened: a page removing them only ends the user's own session. Enforced by step 81.*

**`isTrusted` is not authority (v15).** It proves the event came from real input; it does not prove the action is
allowed. A real click can still be steered by the page (a lure, an overlay). Every action a content script asks for is
validated again in the service worker against the sender (C28) and the current state — the content script reports a
decision, it never grants one.

### C34. `web_accessible_resources` — narrow `matches`, `use_dynamic_url`

A web-accessible resource at a fixed `chrome-extension://<id>/path` can be probed by any matching site to learn the
extension is installed — a fingerprinting vector, a contradiction for a privacy tool. `use_dynamic_url: true` serves it
from a per-session random URL.

**Rule:** every entry scopes `matches` as narrowly as the feature allows, lists only files that must be page-reachable,
and sets `use_dynamic_url: true`. A resource listed "just in case" is attack surface.

*Status at 9.7.5:* both entries set `use_dynamic_url: true` and list 2 resources each; both use `<all_urls>`, as needed
for resources injected on arbitrary sites.

### F-SINK-1 — HTML is never built from values

Building HTML text with values (`innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write` with a variable, function
result or page text) is forbidden, as is hand-written HTML escaping. Fixed markup only (UPPER_CASE constants at most);
every value is set afterwards with `textContent`, `setAttribute` or a property (`title`, `hidden`, `dataset`). Enforced
by step 79. See Chapter 9.

### F-URL-1 — Never navigate to a URL whose scheme was not checked (v15)

A URL that came from a page, a file, a message or storage is used as a navigation target (`tabs.update`, `tabs.create`,
`location`, a link the extension builds) only after `new URL()` parsed it and its protocol is in an allowlist
(`http:`/`https:`, or the extension's own page built with `runtime.getURL`). `javascript:`, `data:`, `blob:`, `file:`
and anything else are refused.

*Project status (11.0.2, by grep):* already followed — the block page navigates only to its own extension URL with an
encoded hostname (`block-page.js`, `WEB_PROTOCOLS`), the tab-under guard returns early unless the stored site URL has a
web hostname (`tab-under-guard.js`), and every `reloadTab()` caller passes no URL (a plain reload). **Check:** manual; a static scan is cheap
to add if a fourth navigation site appears.

### C50. Logs and error text disclose nothing the person would not expect (v15)

Error reporting must help the developer without becoming a record of the person's browsing.

**Rule:**
- Diagnostics go to the console only. Security-relevant refusals (an untrusted sender, a rejected import line, a refused
  regex) are logged with the `[uBlock-Dynamic]` prefix and the step (C5), and **never stored** as an event log —
  storing them adds a browsing record and a collection that grows (B6).
- Log a hostname or a rule, not a full URL (paths and queries carry tokens and search terms), and never page content,
  form values, cookies, or the person's full filter text.
- An error shown to the person names what failed and what to do, not internals (stack traces, storage keys, file paths).
- Third-party code keeps its own logging only if it follows the same limits; otherwise it is silenced at the adapter
  (C51).

**Checklist:**
- [ ] No `console.*` call with `.url`, `location.href` or a whole request object as an argument.
- [ ] No storage key that accumulates log or event entries.

**Project status (11.0.2, grep):** no console call found passing a URL property directly; not exhaustive (a URL can
hide inside a template string). **Check:** *planned* — extend the step-72 scanner with the URL-argument pattern.

---

## Chapter 7 — Store, permissions & release security

### C19. Store-readiness and permission audit

| Permission | Works in a store build? | Note |
|---|---|---|
| `declarativeNetRequest` | Yes | Install warning |
| `declarativeNetRequestWithHostAccess` | Yes | No install warning; needs `host_permissions` |
| `declarativeNetRequestFeedback` | **Debug only** | Chrome describes it as enabling debugging features for unpacked extensions. Banned here by project policy; that declaring it gets a submission rejected is not documented by Chrome, so don't cite that as the reason |

The gated APIs must be named, not just the permission. What Chrome's DNR reference actually says (checked 2026-11):

| API | Chrome's restriction |
|---|---|
| `onRuleMatchedDebug` | Unpacked extensions with `declarativeNetRequestFeedback` only |
| `testMatchOutcome` | Unpacked extensions only (development aid) |
| `getMatchedRules` | Needs `declarativeNetRequestFeedback`, **or** `activeTab` granted for the `tabId` in the filter; quota-limited per interval unless called from a user gesture |

So `getMatchedRules` is **not** universally unpacked-only: with `activeTab` it works in a packed install, but only for
the one tab the user invoked the extension on, and only while that grant lasts. uBD bans all three by **project
policy** (ARCHITECTURE.md, HARD CONSTRAINT): uBD does not declare `activeTab`, every feature that needs "was this
blocked?" must work on every tab without a user gesture, and the two unpacked-only APIs would pass every developer test
and do nothing for real users. `testMatchOutcome` and `getMatchedRules` are not "safe alternatives" to
`onRuleMatchedDebug`. Where a packed-safe reimplementation already exists (e.g. "does this rule match this request"
from bundled data), reuse it (C21). F-DNR-3.

**Store build checklist:**
- [ ] No `declarativeNetRequestFeedback` in the manifest.
- [ ] No call to `onRuleMatchedDebug`, `testMatchOutcome` or `getMatchedRules` — grep all three names.
- [ ] No `webRequest`/`webRequestBlocking` unless justified.
- [ ] No unused `host_permissions`.
- [ ] Every `web_accessible_resources` file exists.
- [ ] The version is higher than the last published one.
- [ ] No `content_security_policy` allowing `unsafe-eval` or `unsafe-inline`.
- [ ] An explicit extension-page CSP, tighter than Chrome's default (`script-src 'self' 'wasm-unsafe-eval'; object-src
      'self'`): `script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`. No `wasm-unsafe-eval`
      (uBD runs no WebAssembly); no `frame-ancestors` (web pages must be able to frame `picker/picker.html`). Before
      adding a page that needs a form, a `<base>` or WebAssembly, change this line and the step-81 constant first.
- [ ] No `onMessageExternal`/`onConnectExternal` listener and no `externally_connectable` key: without the key no web
      page can message uBD, and other extensions get no answer. An empty `"ids": []` shipped in 10.7.13 and was dropped in 10.7.14:
      Chrome then warns that nothing can connect, and filling the list just to silence it would be a fake entry.

Automated as step 33 (permissions ↔ API usage) and step 37 (permission additions).

**Every permission states why (v15).** Step 33 proves each permission is *used*; this table says what it is *for*, so
a reviewer (or the Web Store) can judge whether it is the least needed. Kept here and updated in the same change that
adds or removes a permission.

| Permission | Why uBD needs it | Main users |
|---|---|---|
| `declarativeNetRequest` | Network filtering itself | `ruleset-manager.js`, `filter-manager.js` |
| `scripting` | Cosmetic filters, scriptlets and the page tools | `scripting-manager.js` |
| `storage` | Settings and rules | `data/ext.js` |
| `alarms` | Deadlines longer than the worker's idle time (F-SW-1) | `data/alarms.js`, `session-deadline.js` |
| `offscreen` | Compiling the Import ABP box in a page context | `compiled-filters.js` |
| `contextMenus` | The right-click items | `background.js` |
| `webNavigation` | Block page, closing blocked popups, the tab-under guard, per-navigation custom scriptlets | `block-page.js`, `blocked-popup-closer.js`, `tab-under-guard.js`, `custom-scriptlets.js` |
| `webRequest` | Observing (never blocking) requests while the Matrix panel is open | `core/matrix-panel.js` |
| `browsingData` | Clear browsing history at start | `history-cleaner.js` |
| host `<all_urls>` | A content blocker runs on every site | — |

Optional permissions (C36) are preferred for a **new** feature that not everyone uses; converting an existing required
permission to optional is itself a behaviour change and needs the owner's decision.

### C36. A permission added in an update can disable the extension for every user

An update that adds a permission (or host permission) with a *new* install warning makes Chrome disable the extension
for every existing user until each re-approves it on the extensions page. Users who do not notice lose it. No build
check sees this — the build is correct; the cost is retention.

**Rule:**
- A permission added in an update is a `WARNING FOR IMPLEMENTATION IMPACT:` item: *existing users will have the
  extension disabled until they re-approve it.*
- Prefer `optional_permissions`/`optional_host_permissions` with `permissions.request()` at the moment of use for
  feature-specific needs — they never trigger the disable.
- Removing a permission is always safe.

**Checklist:**
- [ ] Diff `permissions` and `host_permissions` against the last *published* manifest before every release.
- [ ] Any addition is optional, or flagged and explicitly approved (`tools/permission-approvals.json`, step 37).

*Status at 9.7.5:* no optional permissions declared; `<all_urls>` is inherent to a content blocker.

### C37. The release pipeline is attack surface

A malicious *update* compromises users as effectively as a vulnerable one, and needs only access to the publishing
account. The Cyberhaven incident (December 2024): a phished Chrome Web Store developer account pushed a malicious update
to an extension's existing users; the extension's code had done nothing wrong.

**Rule:**
- The developer account uses 2-step verification, ideally a hardware key; OAuth prompts claiming to be the Web Store are
  phishing until verified out of band.
- Dev dependencies are pinned by lockfile and installed with `npm ci`, never `npm install`, for any release build.
- Filter lists fetched at build time are validated before compiling (C13a) — they ship to every user like code.
- A release zip is built from a known, checked tree by `tools/package-release.mjs`, never by hand, so what was checked
  is provably what shipped.
- *(v15)* The release notes name the SHA-256 of each zip (already recorded in `package-release-state.json`), so the
  owner can confirm the file uploaded is the file checked.
- *(v15)* `npm audit` runs before a tools release as an **informational** step (it reports advisories for dev
  dependencies; nothing of it ships to users). A finding is read and decided, never silenced.
- *(v15)* A new or changed dev dependency is a third-party intake (C51): name, version, why, and the lockfile diff in
  the changelog. A package whose name is one letter off a known one is checked against the registry before installing.
- *(v15)* Every external data file (filter list, Tracker Radar, CrUX, AdGuard core library) records where it came from
  and when — the source URL in the build definition, the fetch date or pinned version in the changelog or its lock
  file (`adguard-scriptlets.lock.json`).

**Not adopted, with reason:** an SBOM (the lockfile already is the inventory, and the extension has no runtime
dependencies); signed release metadata (the Web Store signs what it distributes); reproducible builds (filter lists are
fetched live by design — `tools/verify-build-unchanged.mjs` covers the code path with recorded downloads).

---

# Part III — Performance

## Chapter 8 — Memory, data structures & service-worker cost

**The execution model this chapter assumes.** An MV3 service worker is stopped after ~30 seconds idle and restarts cold;
a content script gets a fresh V8 isolate on every navigation. Almost no per-request or per-navigation code runs often
enough before its context resets to reach V8's higher optimisation tiers, so assume most extension code runs
interpreted or lightly optimised. Favour fixes that help at every tier, and keep startup work small. Related rules in
other chapters: lazy data is fetched, not imported (C33); deadlines longer than the idle time are alarms (B3b, F-SW-1);
DNR rule, regex and ruleset budgets (B13); one `background.js` is kept, not split for size (C11).

### B14. `Map`, not a plain object, for dynamically keyed collections

A plain object used as a dictionary — keys added at run time from arbitrary strings (hostnames, ids) — falls out of
V8's fast "hidden class" mode into a hash-table "dictionary mode" once it collects enough dynamic keys (roughly 20–30;
not a documented contract), permanently for that object. **Deleting a property** triggers the same fallback regardless
of key count. Dictionary mode slows property lookup at every tier, including the interpreter — which is why it matters
even in code that never gets hot.

```javascript
// Both triggers in one object, plus an O(N) allocation per size check
let entriesByDomain = {};
entriesByDomain[hostname] = entry;                         // dynamic key
delete entriesByDomain[otherHostname];                     // deletion
if ( Object.keys(entriesByDomain).length >= CAP ) { … }    // allocates a full key array just to read .length
```

`Object.keys(x).length` in a loop up to a cap of N costs O(N²) wasted copies over the object's life (100 keys → ~5,000)
for what `Map.size` answers in O(1).

**Fix:** use `Map` for any collection keyed by arbitrary run-time strings that grows to dozens of entries or has entries
removed. `Map` is hash-backed from the start, `.size` is O(1), and iteration is insertion order (plain objects iterate
integer-like keys — e.g. an all-digit hostname — first, regardless of insertion).

**Storage and messaging boundary:** `chrome.storage` and extension messages accept only JSON-safe values (C31). Convert
at exactly the read/write site (`Object.fromEntries(map)` / `new Map(Object.entries(obj))`, recursively for nested maps)
and keep `Map` everywhere else.

**Checklist:**
- [ ] Every dynamically keyed plain object that grows beyond a small fixed schema, or has deletions, becomes a `Map`.
- [ ] Hot paths first (per request, per keystroke, per frame); infrequent user-action paths too, for consistency.
- [ ] `Object.keys(x).length`/`Object.values(x)` used for size or full iteration become `.size`/`.values()`.
- [ ] Every persisted `Map` has one explicit, tested conversion at its read/write site.

**Measure, don't ban on theory (v15).** B14 is the exception backed by a known, cross-tier engine behaviour. Other
"faster construct" claims (`for` vs `forEach`, string building styles, closure counts) are not rules: a change made
for speed alone states the measured gain on the relevant Chrome version and a realistic input, or it is not made.
Readability and the one-style rules (C9a) win when no gain is measured.

### B6. Bounded collections

Every `Map`, `Set`, `Array` and `Object` that grows over time has a maximum size or TTL, and a cleanup path (event,
periodic sweep, or worker restart). Without both, it is a memory leak: propose FIFO eviction, a TTL map or a sweep, and
document the bound next to the declaration.

**A cap constant existing is not the cap being enforced** — grep the constant's *usage*, not just its declaration.
Real incident: `MATRIX_OVERRIDES_MAX` (`dnr-budgets.js`) was declared and documented but imported nowhere;
`setMatrixOverride()` and `importMatrixOverrides()` (`matrix-block-rules.js`) wrote to the `Map` with no count check, fed
by untrusted bulk-import data. The dead-export checker had flagged the constant; the real bug was one level deeper, found
only by asking "what happens when this fills up?".

**The bound comment also states the cost (v15).** For a collection on a hot path (per request, per navigation, per
mutation), the comment next to the declaration gives the expected size, the maximum, and how it is looked up — e.g.
`// a few entries, max MAX_WATCHED_TABS (50); lookup by tab id O(1); pruned on every event`. A linear scan over a
collection that can reach thousands, inside a per-request or per-mutation path, is a finding; an O(N²) pass is allowed
only on an explicit user action with N bounded by a named limit.

### C53. Page scripts do the least work at the least moment (v15)

Every injected script runs again on every navigation, in every matching frame, on every site. A small cost here is
paid millions of times; a cost in the service worker is paid once per wake-up.

**Rule:**
- Inject only where needed: the narrowest `matches`, a site-mode gate (C25), and no frame injection a feature does not
  use (`allFrames`, `matchAboutBlank` only when required).
- `runAt: document_idle` unless the feature must act before the page does (scriptlets that patch globals, cosmetic CSS
  that prevents a flash): then `document_start`, and the file says why in its header.
- Startup work is bounded: no full-document scan, no large data set parsed, no storage read that is not needed on this
  site, at injection. Data used only on a few sites is selected per site at registration (as the scriptlet dispatch
  already does), not filtered in the page.
- No lazy loading by dynamic `import()` in page scripts as a size fix: it adds a load that can fail (C7, C33); reduce
  what is injected instead.

**Metric:** per injected file, bytes and number of imports; compared with the previous release.
**Check:** *planned* — a static footprint report in the suite that fails on growth above a declared threshold unless
the changelog names the reason. Real page-load timing stays on request (C56).

### C54. DOM work and MutationObserver: narrow, batched, released (v15)

A page script that watches the DOM runs on the page's busiest moments. On a dynamic site a careless observer is the
extension's biggest cost, and the page controls how much DOM it creates (C48).

**Rule:**
- Observe the smallest subtree and the fewest mutation types that work (`attributeFilter`, no `subtree` unless needed).
- In the callback, process only the added nodes, never re-scan the whole document; queue work and run it once per frame
  or idle period, with a **per-run work limit** (nodes or milliseconds, named constant) and continuation for the rest.
- The extension's own DOM changes must not re-trigger its own work (mark own nodes, or disconnect while writing).
- Read layout (`offsetHeight`, `getBoundingClientRect`) before writing, not interleaved; build new nodes in a
  `DocumentFragment` and insert once.
- Every observer has an owner and a `disconnect()` on every end path (B10): feature switched off, session ended, tool
  closed, extension gone (the 11.0.2 context guard). A page-lifetime observer is allowed only for a feature that is
  on for the whole page, and the header says so.

**Checklist:**
- [ ] Each `new MutationObserver` names its owner, its scope and its end path in a comment.
- [ ] No callback calls `querySelectorAll` on `document` without a work limit.

**Check:** manual; *planned* — extend the B10 resource scan to pair each observer with a `disconnect()` or a
page-lifetime comment.

### C55. The service worker starts cold, often — keep the start small (v15)

**Rule:**
- No work at module top level beyond declarations: no storage reads, no parsing, no rule rebuilds at import time.
- Start-up reads only the keys it needs (`localRead(key)`), never the whole storage area.
- Configuration loading and feature start-up are separate steps of the start lane (B3a `swLifecycle`); a feature that is
  off does no start-up work.
- Large data is fetched when first needed and cached in memory for the life of the worker (C33), not parsed at start.
- Event listeners stay registered at top level (Chrome requirement) — they wait on the start promise, they do not
  delay it.

**Check:** manual; the start-up lane's phases make a slow step visible in DevTools.

### C56. Performance is measured against a baseline, not judged by eye (v15)

**Rule:**
- Before a performance budget exists, record a baseline: page-script bytes (C53), worker start time, and page-load time
  with and without the extension on a fixed set of representative pages (simple, heavy, very dynamic). Report median
  and the 95th percentile, not the mean.
- After the baseline, changes are compared with it. A regression above the declared threshold blocks the release until
  the owner accepts it with a reason — a **relative** gate, never a hard millisecond number in this manual (hardware
  and Chrome versions vary).
- Real-browser measurement runs only after asking the owner (Chapter 11); static size checks run in the suite.

**Check:** *planned* (baseline not yet recorded).

---

# Part IV — Principles

## Chapter 9 — Forbidden practices (quick reference)

A practice listed here is never written, whatever the reason or deadline — the same standing as the magic-number rule
(B1). Each entry names what is forbidden, what to do instead, and where it is enforced. The rules apply to any Chrome
MV3 extension; "Origin" says where this project learned it. **Owner's rule (10.7.6):** every applied fix that can be
stated as a general rule is added here.

| ID | Forbidden | Instead | Enforced by | Origin |
|---|---|---|---|---|
| **F-SINK-1** | Building HTML text with values: `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` with a variable, function result or page text inside — and hand-written HTML escaping. | Fixed markup only (UPPER_CASE constants at most); every other value set afterwards with `textContent`, `setAttribute` or a property (`title`, `hidden`, `dataset`). | Step 79 | 10.7.6, D-10 / B-3 |
| **F-ERR-1** | Swallowing an error: an empty `catch {}`, `.catch(() => {})`, or a catch that only returns a default. | Ignore only a declared expected error class (`js/data/expected-errors.js`); log everything else with context. A pure parse fallback is marked `// benign: <why>`. | Step 72 (C5) | 10.7.6, B-1/B-2 |
| **F-ERR-2** | A failure the person caused (a save, an import, a switch) reported only to the developer console. | Return `{ ok: false, error }` and show it where the person acted; a control that did not take effect is set back. | Steps 73, 77, 78 (C5 rule 3) | 10.7.6, D-9 / Import ABP |
| **F-ERR-3** | Dropping user input silently — a line, rule or setting accepted on screen that does nothing. | Keep it visible and say why: in an editor, comment the line out with `! Rejected: <reason>` beneath it. | Step 77 | 10.7.2 / 10.7.6 |
| **F-LOCK-1** | A promise chain used as a lock (`p = p.then(fn)`): one rejection blocks every later call. | `createLock()` (`js/util/async-lock.js`), which keeps running after a failure. | Step 72 (C5 rule 4) | 10.7.6 |
| **F-SW-1** | A service-worker deadline longer than the worker's idle time (~30 s) kept only in `setTimeout`/`setInterval`. | `chrome.alarms` (it wakes the worker); an in-memory timer may add exact timing while awake. | Step 64 (B3b) | 10.7.6, D-1 |
| **F-SW-2** | `importScripts()` or dynamic `import()` in a module service worker; loading a feature by a load that may fail. | Static `import` in tier order; switch features by a setting or run-time check. | Step 36 (C7, C16, C33) | 10.7.6, D-2 |
| **F-SW-3** | A resource registered in Chrome (content script with `persistAcrossSessions`, alarm, rule) that outlives the state that owns it. | Release it on every end path, and reconcile at worker start: no owner state, no resource. | Steps 64, 66 (B10) | 10.7.6, D-1 |
| **F-TRUST-1** | Opening `storage.session` to content scripts (`TRUSTED_AND_UNTRUSTED_CONTEXTS`), or keeping extension state where page scripts can write it. | Session storage stays trusted-only; data a content script needs goes to `storage.local` (treat as page-visible) or by message. | Step 76 | 10.7.6, D-5 |
| **F-TRUST-4** | Content-script UI that acts on a synthetic event (no `isTrusted` check), or an interception listener on `document` that a page's own `window` capture listener can stop first. | `isTrusted` on every user decision; interception listeners on `window`, capture (C47). | Step 81 | 10.7.13–10.7.15 |
| **F-TRUST-3** | Storing page- or file-supplied text that a stylesheet will contain without checking it cannot escape (`{ } ; @`, line breaks), or checking it on one entry path (the picker) but not another (Import, Restore). | One shared check at the one merge every path passes through (`computeUpdatedSelectors()` + `isSafePickedSelector()`; cookie rules: `areRuleFieldsValid()`). | Step 81 | 10.7.13–10.7.14 |
| **F-TRUST-2** | Trusting a message because something is missing (no origin), or trusting message content for a hostname. | Trust only "no sender at all" (internal) or your own extension id AND origin; derive hostnames from `sender.url` / `sender.tab.url`. | Step 76 (C28) | 10.7.6, D-4 |
| **F-DNR-1** | Shipping or submitting a `regexFilter` without Chrome's `isRegexSupported()` verdict, or above 1,000 regex rules per ruleset / dynamic set. | Ask Chrome (cache the verdict), drop and report what it refuses, count against `MAX_NUMBER_OF_REGEX_RULES`. | Steps 12, 75 (B13) | 10.7.6 |
| **F-DNR-2** | Treating Chrome's ruleset limits (100 declared, 50 enabled, 30,000 guaranteed rules) as unlimited. | Named constants, a build check, and a reported refusal at run time. | Step 78 | 10.7.6, D-9 |
| **F-DNR-3** | DNR match-feedback APIs (`onRuleMatchedDebug`, `testMatchOutcome` — unpacked only; `getMatchedRules` — feedback permission or a per-tab `activeTab` grant) or `declarativeNetRequestFeedback` in shipped code. | A packed-safe reimplementation from bundled data. | C19, step 33 | earlier |
| **F-DNR-4** | Broad block rules that disable a site's third-party traffic (`|https://` + third-party + sites). | Drop them at build time. | C13c | earlier |
| **F-PARSE-1** | Two parsers (or handlers) for the same syntax maintained side by side. | One parser; the consumers keep only their own decisions around it. | Step 74 (B15) | 10.7.6, one parser |
| **F-CONST-1** | Magic numbers, and copies of the same constant or text in several files (JS or HTML). | One named, commented constant in one place; other files import it. | B1, B2, B2a, steps 50/62 | earlier |
| **F-VERIFY-1** | Claiming a check passed when it did not run, or raising a concern as a finding without checking the code. | A check that did not run has failed (C38); verify first or ask (C24). | C24, C38 | earlier |
| **F-INPUT-1** | Reading or parsing outside input (`file.text()`, `JSON.parse`, a message list) before checking its size. | A named limit checked first; over it, refuse the whole input with a visible reason. | Step 92 (C49) | 11.0.2 audit |
| **F-URL-1** | Navigating to a URL from a page, file, message or storage without checking its scheme. | `new URL()` + protocol allowlist (`http:`/`https:` or the extension's own page). | Manual | v15 |
| **F-LOG-1** | Logging full URLs, page content, form values or the person's filter text; storing security or error events. | Console only, hostname or rule only, nothing stored. | C50 (check planned) | v15 |
| **F-3P-1** | Adding third-party code or data that was not read in full, has no recorded source and version, or has an unchecked licence. | The C51 intake: read, pinned, licensed, held to the same rules or listed as an exception with a reason. | C51, step 59 | v15 |
| **F-NEW-1** | Calling new code "done" without a test that fails without it, or adding a new call site to a scanner's shape without classifying it. | A fault-verified test (C42); every new call site classified in the scanner's allowlist (C25). | C52, C42 | v15 |
| **F-DOM-1** | A MutationObserver callback that re-scans the whole document, or an observer with no owner and no `disconnect()` path. | Process added nodes only, with a per-run work limit; disconnect on every end path. | C54 (check planned) | v15 |
| **F-DEP-1** | A runtime library added to the extension (including a schema validator) without the owner's decision. | Hand-written project code, one validator per data type (C6). | Manual (C51) | v15 |

---

## Chapter 10 — Engineering principles

### C21. Reuse a proven solution — don't reinvent

When two features solve the same problem and one has a **proven** solution — a documented history of being tested
against a real failure (a bug report, a CHANGELOG entry saying what broke and why the fix works) — the other adopts it.
A second, different answer to an already-solved problem is a new, unproven implementation and a second place for the
same bug to hide.

**Checklist:**
- [ ] For any hardening or fix added to one feature, search for features solving the same kind of problem (session
      timeouts, cleanup, messaging, error surfacing) and check whether they have or lack it.
- [ ] Port the existing mechanism — same constants, same shape — adjusted only for genuinely different constraints.
- [ ] Comment at the point of reuse naming the feature and file it came from, so the next audit finds both.
- [ ] A CHANGELOG entry showing a bug class was already fixed elsewhere is a signal to port that fix.

**Worked example — two self-closing panels:** one panel had gone through two rounds of "stale empty tab" bugs; a sibling
built independently had the stronger design (background-owned expiry, broadcast on expiry, independent poll). The fix
ported the sibling's exact mechanism to the weaker panel, keeping its existing fix as an additional layer — additive
hardening, not a third design.

### C22. Cross-variant consistency is a standing rule

"Make X the same across levels / variants / tiers" (protection levels, plan tiers, roles, platforms) is a **standing
constraint for the rest of the engagement**, not a fix for the one spot that was pointed at. Fixing only the reported
instance makes the owner find every other one, which reads — correctly — as the same mistake repeated.

**Required pattern:**
1. Grep the whole codebase for every branch on that axis (`if (level`, `level ===`, `tier ===`, …).
2. Classify each hit: **intentional and still correct** (comment why at the site) or **accidental** (fix now, same pass).
3. Report both lists — changed, and left alone with the reason.
4. Treat one reported inconsistency as evidence the whole module needs the sweep.

- [ ] Apply "same layout / same mechanism" fixes with the shared component already used elsewhere (C21).
- [ ] Re-run the sweep whenever the same instruction resurfaces in the session.

**Worked example:** a panel rendered different columns per level, and a level-dependent info line used two mechanisms
(an input `placeholder` for one level, a separate element for another). Each inconsistency was reported and fixed
separately, three times. One sweep on the first report would have fixed all of them.

C21 asks "has this problem been solved better elsewhere?"; C22 asks "does every occurrence of this axis get the same
treatment?". The same holds for channels: a feature reachable through several entry points works in all of them (C41).

### C23. Check version history before touching a mechanism

Before changing a *mechanism* — session timeouts, tab/window lifecycle, cleanup, retries, anything once called
"hardened", "guard" or "fix" — search `CHANGELOG_HISTORY.md` for it first. A mechanism with prior fix entries has
already proven easy to get wrong.

- [ ] Name the mechanism in plain terms ("the popup window this button opens", "the session countdown").
- [ ] Grep the history for its name, symptom words ("stale", "hang", "leak", "duplicate", "reappear", "empty") and the
      functions/files involved.
- [ ] Read prior entries fully and note the **root cause**, not just what the fix changed.
- [ ] Treat an existing adjacent fix as a floor to build on, not a box that doesn't apply.
- [ ] State which entries were checked and what they showed.

**Worked example:** a "ghost tab" fix in a window-opening function checked for extra tabs at the moment the window
promise resolved. A new "empty tab reappears" report on another panel turned out to be a tab Chrome adds slightly
*later* — a timing gap in a correct approach. The fix was a second, delayed check on top of the first.

### C25. A bug class that recurs gets a standing constraint and an automated check

Once the same bug class has been fixed independently **three or more times** across features, the codebase's shape
invites it: new call sites are written by matching surrounding code, with nothing signalling the known failure. Another
careful one-off patch changes nothing about that. C23 does not help either — re-implementation at a new call site never
looks like "touching the documented mechanism".

**Required response:**
1. Fix the newest occurrence with the proven pattern (C21).
2. Add or extend a **HARD CONSTRAINT** entry in `ARCHITECTURE.md` naming the general pattern and every proven mechanism
   that satisfies it.
3. Write a static check that finds every call site of the bug's general shape and fails on any not on a classified
   allowlist (gated / downstream of another gate / exempt with a stated reason). New unclassified sites fail by default.
4. Wire it into the suite (Chapter 12).
5. Prove it catches the class: inject a synthetic instance, confirm it fails, revert.

**Worked example:** a site-mode bypass — a `browser.scripting` call running even when filtering was off for the site —
was fixed three times in three subsystems (precompiled scriptlets, cosmetic rules, security-toggle scriptlets). A fourth
occurrence surfaced from a live report in a subsystem that dispatched scriptlets per navigation — different enough that
no keyword search connected it. The response was a HARD CONSTRAINT plus a check classifying every `browser.scripting`
call site (step 14), verified by injecting a fake ungated call.

### C39. An agreed feature ships working end-to-end — not as inert scaffolding

"Implement X" means X does something for the user the moment it ships. A setting, gate or check for a capability the
codebase does not yet have is scaffolding — a different deliverable — and a setting that changes nothing when turned on
is a bug in waiting, indistinguishable from a real one once the conversation that explains it is gone. Every mechanical
check still passes on such code, which is what makes it easy to ship.

**Required practice:**
- [ ] Before agreeing, list every precondition not already true in the code today (a missing library scriptlet, an
      unbuilt upstream feature, data that doesn't exist) and say so *before* building.
- [ ] If one is missing, choose: (a) build the precondition first; (b) hold the feature; or (c) build a narrower version
      that is complete on its own terms. Never (d): build the full mechanism and call it "ready and waiting".
- [ ] A dashboard setting has at least one reachable path where toggling it changes real behaviour, verified.
- [ ] A precondition found missing mid-implementation is reported before continuing.

**Worked example:** a plan to allow 11 `trusted-*` scriptlets in custom rules behind a new off-by-default setting was
proposed as "scaffolding" before checking the scriptlet library — which contained none of them, and rejected unknown
names before the setting was ever consulted. Caught by checking the precondition first.

#### C39a. End-to-end means every consumer — derived values are computed, never transcribed

A change that reaches the user in some places and leaves stale copies elsewhere is worse than no change: the updated
places convince everyone it is complete, so the stale copy is never looked for. The root cause is always a value
**transcribed** instead of **derived** — a count, number, level, range or threshold typed into HTML, a JS string, a
loop bound, an `<option>` list or a test expectation.

**Required practice:**
- [ ] **Derive, don't transcribe — tests included.** UI values that exist as a constant or registry field are rendered
      from it (3P Matrix: `ui/derived-text.js`, `data-derived="KEY"` placeholders; loops over `LEVEL_MIN … LEVEL_MAX`).
      Tests import expected values from the constants — a typed copy passes against a stale value. Goal: no literal
      outside the single source of truth / magic-number section of each module (B1).
- [ ] **Inventory before changing.** Grep the constant/key **and** its current literal and display forms (`11`,
      `"protection 11"`, `"5 outside"`, `−30`) across JS, HTML, CSS, docs and tests. The fix is the whole list.
- [ ] **Fix the class.** One reported instance is a sample; sweep, then report what was found, changed and left (why).
- [ ] **Mechanical guard (C25):** a static check fails on unclassified transcribed values (step 50/62).
- [ ] **Verify by changing the source:** changing the constant alone updates every page.

**Worked example (3P Matrix 4.2 → 4.2.3):** adding protection 11 renumbered 11–15 to 12–16; registry, list and counts
were updated, so it looked done. Left behind: "(5 outside safer regions)" typed as a literal, "(protection 11)",
"protection 10", "score −30", "level 1/3" in HTML, an `<option>1…5</option>` list and a `for (n = 1; n <= 5 …)` loop.
The audit reported one; the sweep found nine sites (18 check hits). The migration test was rewritten to import its
expected values. *Lesson:* an upgrade test starts from what the OLD version really stored, schema number included.

### C40. Hand-porting a missing upstream scriptlet — limits decided up front

When a missing precondition is a single upstream scriptlet, it may be ported by hand from a proven source (adapted, as
in `THIRD_PARTY_LICENSES.md`'s "adapted from `duckduckgo/autoconsent`" entries) instead of waiting for the vendored
library — within limits decided before starting.

**Hand-port only when all hold:**
- The function is small and self-contained — no shared engine or dependency chain to inline and verify.
- It has a real, current use: a user hit it, or shipped list content references it — verified via the build's own
  missing-scriptlet warning (`buildTrimmedCorelibs` in `tools/build-rulesets.mjs`), never assumed.
- A build check prefers the real upstream version as soon as the vendored library has it, and flags the port as
  redundant.

**Drop it, and document why, when:**
- The source is a large shared engine behind many variants (ceiling: a source file of more than a few hundred lines of
  shared parsing/matching logic). Measure the real dependency chain, not the file's own line count.
- It belongs to a restricted class upstream itself guards (AdGuard's `trusted-*` family) **and** nothing shipped needs it.

**Worked example:** an ABP-import rejection revealed 30 scriptlet names missing from the vendored library. Five small,
user-hit gaps were hand-ported (`prevent-dialog`, `bab-defuser`/`nobab`, `freeze-element-property`, `urlskip`);
`prevent-clipboard-write` carried upstream's `requiresTrust: true` despite its ordinary name and joined the restricted
set; ten names sharing a 1,575-line engine (`json-edit.js`) and `mpegdash-prune` (needing a 329-line XHR engine) were
dropped; the 17 `trusted-*` names were dropped because nothing shipped used them. Twice in that pass a hand-typed list
was wrong (a miscount, then four invented names) — regenerate such lists from source, never retype. The redundancy
check fired on its first run: `href-sanitizer` had arrived upstream meanwhile, so the port was narrowed to `urlskip`.

### C41. CRUD for every data element, Initiate → Perform → End for every process

Two lifecycle questions are asked for everything a change introduces, when it is introduced.

**Data elements — CRUD.** Anything holding state or a declaration (a config key, a stored list, an allowlist entry, a
generated constant, a dynamic-rule id, a derived in-memory value). All four letters need a real path reaching every
dependent:

| Letter | Question | A finding looks like |
|---|---|---|
| **C**reated | From where — default, UI, import, build, every channel a tooltip or label promises? | A channel that silently drops it |
| **R**ead | Is it consumed by behaviour, by every consumer that should see it? | A key nothing reads; a consumer reading one channel's copy |
| **U**pdated | Can it change, and do dependents re-apply? | A change that only takes effect at the next session |
| **D**eleted | Can it be removed, leaving nothing stranded (storage, DNR rules, registrations, memory, backups)? | Rules still registered after removal; a value never exported |

Two non-obvious readings: **Read includes the backup** (a value the export never reads is lost on the next machine), and
**Created includes every channel** (three places to declare an option are three Creates — C22 applies).

**Processes — Initiate · Perform · End.** Guards in the code (B3a, B10, C13, C14) are necessary but say nothing about
whether the steps connect. One test per process drives the *real* functions through:
- **Initiate** — from *every* entry point (UI, import, startup, a built-in list).
- **Perform** — assert the observable *effect* (the rule exists with the right priority and domains), not that a
  function was called.
- **End** — every way it ends: removal, empty or corrupt input, failure, expiry, version update, and a **service-worker
  restart**; assert nothing is left behind and that what should survive is restored.

**Required practice:**
- [ ] A new data element gets its CRUD row (in the response or changelog) — four paths, or a written reason a letter
      does not apply. Silence is not acceptable.
- [ ] A new process gets its Initiate/Perform/End test, registered in `tools/check-crud-lifecycle.mjs`'s
      `PROCESS_REGISTRY`. A new `*-manager.js` in neither `PROCESS_REGISTRY` nor `LEGACY_UNAUDITED` fails the check.
- [ ] `LEGACY_UNAUDITED` is a debt list, counted every run; a *new* module is never added to it.
- [ ] A missing letter or step gets a test that fails without the fix (C25 step 5).

**Worked example (10.0.0 → 10.0.1):** `@@domain$worryfree` was promised by tooltips everywhere. Created: only one of three
channels worked. Read: consumers each read one channel's state. Updated: a list change refreshed DNR rules but not the
content-script `excludeMatches`. Deleted/backup: the option lines were never exported. Every existing check passed.
Enforced by step 49.

### C51. Third-party code enters through one gate (v15)

Code and data we did not write — uBO/uBOL ports, AdGuard scriptlets and core library, vendor libraries (`lib/`,
`vendor/`), filter lists, dev dependencies — bring their bugs and their unsafe patterns with them, already written and
easy to trust because they come from a respected project. Most of this codebase's audits found at least one defect that
arrived this way. The gate keeps them out, or at least visible.

**Rule — before third-party code or data is added or updated:**
1. **Read it in full.** Nothing ships that nobody read. For an update, read the diff against the version we have.
2. **Pin it.** Source URL plus exact version or commit, recorded in a lock file or the changelog
   (`adguard-scriptlets.lock.json` is the model). No "latest", no fetch at run time (step 59, MV3).
3. **Licence checked** and recorded in `THIRD_PARTY_LICENSES.md` in the same change.
4. **Same rules, or a listed exception.** The code meets this manual (F-SINK-1, F-ERR-1, C35, C50…), or each deviation
   is listed — in the relevant check's allowlist or the file header — with a reason, never silently exempted by folder.
   Upstream-derived files carry the project header (2026-11-14 decision).
5. **One adapter.** Project code reaches third-party code through one module that validates what goes in and what comes
   out (inputs, return shapes, thrown errors) and catches its exceptions (C52). A second call site goes through the same
   adapter (B15).
6. **Behaviour proven here.** A port or update gets a test in our suite for the behaviour we rely on, written from the
   upstream's documented behaviour or its own test cases — the upstream's tests passing upstream prove nothing here (C42).
7. **No new runtime dependency** without the owner's decision (F-DEP-1). Hand-ported scriptlets also follow C40.

**Checklist:**
- [ ] Changelog entry names: what, from where, which version, licence, which C48 rows it touches, and the exceptions.
- [ ] The update diff was read, not only the new version run.

**Check:** step 59 (no remote code), step 80 (upstream ports), manual for the rest.

### C52. New code enters through the same gate — and a failure stays contained (v15)

Most defects that reached a release were in new code that passed every existing check because no check knew it existed
yet (C25, C39, C41). The gate below turns "it passes the suite" into "the suite knows about it".

**Before writing:**
- Search `tools/`, the changelog and sibling features for an existing solution (C21, C23); reuse beats rewrite.
- Name the C48 rows the change touches, and its inputs with their limits (C49).

**While writing:**
- Every variable, switch and magic number of the module in its one commented constants section (B1, owner's standing
  rule); every new resource with an init guard, a clear path and a release path (G4, B10).
- The module header gains its Input trust and Errors lines if it takes outside input (C10).

**Before calling it done:**
- A committed test that fails without the change (C42), covering the failure, timeout and cancel paths, not only success
  (C13), and the worker-restart path for anything stateful (C41).
- Every scanner whose shape the new code matches classifies it: a new `browser.scripting` call (step 14), message type
  (step 7), DNR range (step 9), `*-manager.js` (step 49), injected file (C53). An unclassified new call site is a
  failure, never a silent pass.
- Run the suite only when packaging (owner's rule) — but the new test runs when written.

**Fault containment — a defect in one feature must not take the others down:**
- Every top-level entry point (message handler, event listener, alarm, injected script start) catches and logs with the
  feature's name (C5); one feature's exception never reaches another feature's code path.
- Per-item loops (per tab, per ruleset, per rule) isolate failures per item and report the failed items, as the open-tabs
  catch-up does (step 68) — one bad item does not stop the rest.
- When a feature fails at start, it is marked off and reported; the extension keeps filtering ("keep working is the
  rule", Chapter 13).

**Check:** steps 7, 9, 14, 49, 68, 72; manual for the rest.

### C57. Known limits and debts are written down in one place (v15)

A temporary solution becomes permanent the moment nobody remembers why it exists.

**Rule:** every known limitation, accepted gap or postponed fix gets one entry in `TECH_DEBT.md` (docs zip): an id
(`TD-n`), what it is, the risk in plain words, the modules affected, the workaround, the proposed fix and its status. Code
keeps its local comment (`FUTURE IMPROVEMENT`, B5 ceiling, `LEGACY_UNAUDITED`) and names the `TD-n` id; the register is
the index, the comment is the detail. A closed entry stays, marked closed with the version.

**Check:** manual; *planned* — a check that every `TD-n` mentioned in code exists in the register and vice versa.
**Project status:** register not yet created; first entries come from the existing `FUTURE IMPROVEMENT` comments,
B5 ceilings, `LEGACY_UNAUDITED` and the open items of the audits.

---

## Chapter 11 — Verification

### C38. A check that did not run has not passed

Every automated check has three outcomes, and the suite tells them apart:

| Outcome | Meaning | Effect |
|---|---|---|
| **PASS** | Ran to completion, found nothing | Passes |
| **FINDINGS** | Ran to completion, found something | A hard check fails; an *informational* check reports and passes |
| **DID NOT RUN** | Crashed, missing, timed out, or no report | **Always fails** |

"Informational" describes what findings mean — never permission not to run. A silently skipped check is worse than none:
"nothing" reads as "clean".

**Incident (audit after 9.7.5):** Knip (step 17) was informational, always exited 0 and was wrapped in a
`try { … } catch {}`. It had crashed on **every** run (its stylelint plugin could not read `.stylelintrc.mjs`). Once
fixed, its first run found 3 unused files, 4 unused dependencies and 113 unused exports. The same swallow wrapped all five
informational steps; Semgrep (step 29) had never run because "not installed" counted as a pass. Part of the cause was
review behaviour: the crash was summarised as "a tooling issue, not your code" and left alone.

**Rules:**
1. Never swallow execution errors — no `try/catch` that ignores the outcome, no unconditional `process.exitCode = 0`.
   An informational script exits 0 when it *completed* and non-zero when it could not.
2. Require positive evidence of completion (a parseable report, a non-zero count of items scanned), not the exit code
   alone — Knip exits 1 both for findings and for crashing.
3. Prove each new check in all three directions: injected violation → FINDINGS; tool prevented from running → DID NOT
   RUN; clean tree → PASS.
4. A crash or "did not run" line in suite output is a finding about the suite; fix it in the same pass.
5. A step whose tool cannot run in the standard environment is not part of the suite — install it as a declared
   dependency, or move the step out as a documented standalone script.
6. Exceptions live next to what they excuse, with a verified written reason (`knip.jsonc`; `/** @public <reason> */`
   at the export). Of ten constants first assumed "read by the range check", only two were.

**Checklist:**
- [ ] Every suite step goes through `run()` (no bare `try/catch` wrappers).
- [ ] Every informational script exits non-zero when it did not complete, and that path has been demonstrated.
- [ ] No step depends on an undeclared tool.

### C42. A name in chat is not a test

A feature is unverified until its own, newly written, committed assertion fails without the fix.

- **Ad-hoc verification is not a test.** A `node -e` one-liner, a manual trace, "I checked it and it returns X" is real
  evidence in the moment, but not repeatable — it never earns the words "tested" or "verified" alone.
- **An existing check's PASS does not transfer.** A green `site-scorer` step says only that its own cases pass; if none
  exercises the new code, its colour says nothing about it. Read the cases before citing a check.

**Required practice:**
- [ ] A feature is not called "done" in the turn that introduces it unless a committed test exercising its new logic
      exists. Otherwise the status is "written, not yet verified" — said plainly.
- [ ] Before citing a check's PASS, confirm it contains a case that would fail without the feature.
- [ ] Every new test is fault-verified: break the new logic, see red, restore.
- [ ] A coined name for a behaviour ("throwaway pattern") is written next to the test that proves it.

**Worked example (3P Matrix 4.4.9):** an active-threat host feature was "verified" by typing URLs into a `node -e` script
while `site-scorer` reported PASS — truthfully, with no case for either new export. The owner caught it by asking what the
passing check actually tested.

### F-VERIFY-1 and G6

A check that did not run has failed, and a concern is verified against the code before being raised (C24, Chapter 13).
The automated suite passing is necessary but not sufficient: the extension must also actually load and start its service
worker, and a storage migration must be run in a real browser against what the old version stored (G6, Chapter 14).
**Owner's rule:** tests in a real Chrome (Puppeteer / Chrome for Testing) are run only after asking the owner each time.

### C58. Parsers and validators are tested with generated input — and against their previous version (v15)

Hand-picked examples test what the author thought of. The inputs that break a parser are the ones nobody thought of.

**Rule:**
- **Generated input.** Every parser, validator and import path that takes outside input (C48 rows 1–2: filter lines,
  Allow-list lines, hostnames, import payloads, message payloads) gets a test that generates many valid and invalid
  inputs and asserts properties that must always hold: never throws, never hangs (a time limit per input), output
  within its limits, rejected input carries a reason, valid input round-trips (parse → serialise → parse gives the
  same result).
- **Fixed seed.** The generator uses a fixed seed so the suite stays deterministic (C38: a check that sometimes fails is
  not a check). A wider random run with a new seed can be started on request; a failing input it finds becomes a fixed
  test case.
- **Differential runs.** A change to a parser or the build is compared with the previous version on the same input:
  `tools/verify-build-unchanged.mjs` (recorded downloads), `tools/compare-rulesets.mjs`, step 74 (build and ABP import
  agree). Every difference is classified as intended (named in the changelog) or a bug.

**Check:** step 74 and the differential tools today; generated-input tests *planned* (first targets: the Allow-list
line parser, the popunder parser, the network-filter parser, Restore settings).

### C59. The minimum Chrome version is a contract (v15)

`minimum_chrome_version` (128 at 11.0.2) promises that every API the code calls exists there.

**Rule:**
- An API or option newer than the minimum is used only behind a feature check with a working fallback, or the minimum
  is raised in the same change — raising it is a `WARNING FOR IMPLEMENTATION IMPACT` (users on older Chrome stop
  receiving updates).
- The header of a module using such an API names the Chrome version it needs.

**Check:** *planned* — a static list of version-gated APIs the project uses, checked against the manifest minimum.

---

## Chapter 12 — Automated check suite (Part D)

Chapters 1–11 are principles applied while writing and reviewing. This chapter is the standing procedure that **runs**
the mechanical subset in one pass before packaging — a floor, not a replacement for judgment (A8/A9 contrast choices,
B11 trust decisions). Run with `npm run check` or `node tools/complete-check.mjs`; `node tools/pre-zip.mjs` rebuilds and
runs it (G6).

**Why it is automated, not occasional — three incidents:**
- A message type (`MSG_RELOAD_MATRIX_TAB`) had a handler but no route — both files looked right, the failure was a silent
  no-op found only in live testing (C20a).
- An unclosed CSS comment swallowed a whole rule; brace counting cannot see that, a parser can.
- The same site-mode bypass was written and fixed four times before anyone saw the pattern (C25, step 14).

**Cross-cutting rule for feature-logic steps (6, 13–16 and every test-*.mjs):** drive the real exported functions with
only external dependencies (storage, DNR, scripting) mocked — never a hand-written copy of the algorithm, which can never
catch drift from the real one.

### Steps

1. **Syntax** — `node --check` on every extension JS file.
2. **ESLint** — the project rule set (`npm run lint`).
3. **CSS structure** — brace balance *and* comment balance.
4. **HTML structure** — every file parses.
5. **JSDOM dry-run** — renders the real HTML, checks every element id the JS references exists, parses all CSS with a real
   parser, and imports and executes each page's JS as a live module against the DOM with extension APIs mocked.
6. **Functional smoke test** — modules with non-trivial state exercised end to end against mocked storage (create,
   update, delete, import/merge, clear).
7. **Message routing (C20a).**
8. **Manifest and file references (C20)**; 8a: static ruleset id cross-reference (C13a).
9. **DNR rule-id ranges** — pairwise overlap, and actual offset usage in the generating code against each documented size.
10. **Dead exports** *(informational)* — shared-layer exports with no importer.
11. **CSS class cross-reference** — every class used in JS/HTML has a rule (reverse direction informational).
12. **`regexFilter` constraints (B13)** — RE2-incompatible syntax, ASCII, static count against 1,000, runtime
    `isRegexSupported()` path still wired.
13. **Exception/cancellation-rule logic** *(one per syntax with this shape)* — same-level and parent/child cancels in both
    directions, sibling isolation, no-match no-op, fast path without exceptions; against the live functions.
14. **Recurring bug-class scan (C25)** — every call site of the shape, classified against a justified allowlist; new
    unclassified sites fail. Parses code (`tools/lib/scripting-call-sites.mjs`).
15. **Second instance of #13** — the `hostname#@#selector` cosmetic exception, through its own API surface.
16. **Differential format equivalence** — the storage-backed cosmetic lookup against the old embedded format across every
    real generated ruleset; accepted exceptions named.
17. **Whole-tree unused files/exports** *(informational, Knip)* — entry points loaded by string path, `<script src>` or as
    a CLI binary must be declared, or they read as dead.
18. **Unused/missing dependencies** — CLI-invoked tools need a documented exemption.
19. **Version congruence** — manifest, `package.json`, `tools/package-release-state.json` and both changelogs agree;
    every tools version has at least a one-line mention in `CHANGELOG_HISTORY.md`. `package-release.mjs` writes the tools
    version into `package.json` itself; never hand-edit it.
20. **Style-guide-derived lint rules** *(informational)* — project-specific rules encoding A9's verified values; verify a
    generic preset's signal-to-noise before adopting it.
21–23. **Checks rehomed from a retired stopgap script** — duplicates retired, real coverage ported to named scripts.
24–25. **End-to-end scripts with real assertions** — output for a human to read is a demo, not a check; a check must
    terminate deterministically; assertions must check the right moment (an "initial value" assertion once ran after a
    wait that had already changed it).
26. **Dependency cycles** — a real cycle is always a violation; tier *direction* still needs project knowledge.
27. **Duplicate code** *(informational)* — clone detection finds B15 drift as it happens.
28. **Coverage** *(informational, no threshold)* — real instrumentation; an arbitrary percentage gate would be a fake signal.
29. *(Removed after 9.7.5)* — a Semgrep cross-check that never ran (C38); its purpose moved into steps 14 and 31.
30. **Message-derived hostname trust (C28)** — `check-message-hostname-trust.mjs`.
31. **Scripting batch registration (C25)** — `check-scripting-batch-calls.mjs`: no per-directive (un)registration loop
    outside `registerOrUpdateContentScripts()`.
32. **Entity dispatch coverage** — `check-entity-dispatch-coverage.mjs`: every compiled dispatch table reaches its
    entity-style (`name.*`) keys.
33. **Manifest permissions ↔ API usage (C19)** — `check-manifest-permissions.mjs`: fails on a used API without its
    permission (the 8.6.0 incident), a declared unused permission, an unclassified permission, or banned DNR
    permission/APIs. Scans the `browser`, `chrome` and `webext` roots (the first version missed `webext` and reported
    `declarativeNetRequest` unused — caught by running it on the real tree before trusting it). Blind spot:
    computed-property access. Proven able to fail with injected faults.
34. **Optimization-change dry-run** — `test-optimization-dry-run.mjs`; it existed unwired until 9.7.3, and once wired it
    never exited (open handle) — a check that is unwired or cannot finish protects nothing.
35. **MAIN-world scriptlet tamper resistance (C35)** — `test-security-scriptlet-tamper.mjs`.
36. **No dynamic `import()` in the service worker (C33)** — `check-sw-no-dynamic-import.mjs`.
37. **No unapproved permission additions (C36)** — `check-permission-additions.mjs` against the last published release.
38. **JSON-lossy message responses (C31)** — `test-json-safe.mjs`.
39. *(Retired)* — ClickFix clipboard corpus; `test-clickfix-clipboard.mjs` was deleted when the protection moved to 3P Matrix.
40. **`$worryfree` per-site exemption** — `test-worryfree-exemption.mjs`, every channel and the End/restart paths (C41).
41. **Worry-free priority order** — `check-dnr-priority-order.mjs` (ARCHITECTURE.md HARD CONSTRAINT).
42. **uBO-patch scriptlets (C40)** — `test-ubo-patch-scriptlets.mjs`.
43–45. **Worry-free annoyances list** — source gate (`test-annoyances-source.mjs`); network rules suppressed outside a
    session (`test-annoyances-suppression.mjs`); hide rules and scriptlets registered only during a session
    (`test-annoyances-registration.mjs`).
46. *(Retired)* — strict 3P block retirement guard; `test-strict-3p-retired.mjs` was deleted with the last of that code.
47. **9.9.1 priority-ladder migration** — `test-priority-ladder-migration.mjs`.
48. **Per-site Allow-list options in all three channels** — `check-exemption-channels.mjs` (fault-verified, three gaps).
49. **CRUD / lifecycle (C41)** — `check-crud-lifecycle.mjs`.
50. **Scriptlet dispatch layout** — `check-scriptlet-dispatch-layout.mjs`.
51. **Project-own scriptlets ship** — `check-project-scriptlets-shipping.mjs`.
52. **Unsupported list lines reported** — `check-unsupported-list-lines.mjs`.
53. **SAFE-update report** — `check-safe-update-report.mjs`.
54. **Whitelist levels** — `check-whitelist-levels.mjs`.
55. **Safe/unsafe ruleset split** — `check-unsafe-split.mjs`.
56. **Geographic scope** — `check-geo-scope.mjs`.
57. **Language-filter country rows** — `test-language-filter-countries.mjs`.
58. **First-install language filters** — `test-language-auto-enable.mjs`.
59. **MV3 compliance and scriptlet policy** — `check-mv3-compliance.mjs`.
60. **UI names from one source** — `check-ui-name-copies.mjs`: content-script copies the platform forces are proven
    equal to the source; retired names fail; no typed tab bar.
61. **Options tab, tab order, Worry-free startup default** — `test-options-tab-and-worryfree-default.mjs`.
62. **Derived UI values (C39a)** — `check-derived-literals.mjs` (found a typed "5:00" and a stale tooltip).
63. **Settings keep only known keys** — `test-settings-known-keys.mjs`.
64. **Session deadline alarm (B3b)** — `test-session-deadline.mjs`.
65. **HaGeZi Multi light selection** — sources, label boundaries, rank cut-off, wiring.
66. **Matrix panel request listener** — lives exactly as long as its session (B10).
67. **Scriptlet site scope** — SITES/ENTITY pattern split and registration diffing (B10, C24).
68. **Open-tabs catch-up** — eligibility gate, per-tab fault tolerance, missing-data fallback (C24).
69. **Disconnect removed** — no leftovers, retired suppression rule released (10.7.1).
70. **Seamless-surfing cookie-banner choice** — stored, followed by the session, prompt offered once (10.7.1).
71. **Pop-up / pop-under handling and block page** — prevent-popunder, `$popup` refusal, send-back, block page (10.7.5).
72. **Silent errors and raw promise locks (C5)** — `check-silent-catch.mjs`.
73. **Error reporting (C5, C42)** — `test-error-reporting.mjs`.
74. **Network translation — one parser (B15)** — `test-network-translation.mjs` (29 fail on 10.7.5).
75. **Regex support verdicts (B13)** — `test-regex-support.mjs`.
76. **What a page's content script can reach (C28, F-TRUST)** — `test-storage-sender-trust.mjs`.
77. **Import ABP rejections shown (F-ERR-3)** — `test-import-rejections.mjs`.
78. **Static ruleset limits (B13, F-DNR-2)** — `check-dnr-ruleset-limits.mjs`.
79. **HTML sinks (F-SINK-1)** — `check-html-sinks.mjs` (4 findings on 10.7.5).
80. **Upstream ports (10.7.8)** — `test-upstream-ports.mjs`: picker secret, serialized permission changes, parser
    fixes, immediate site-specific hiding, `$domain=name.*` from the CrUX snapshot, value-less `$removeparam`,
    page-injection expected errors, high-contrast rules (16 failures + a crash on 10.7.7).
81. **Picker hardening (10.7.13, 10.7.14)** — `test-picker-hardening.mjs`: picked selectors cannot escape the
    injected stylesheet (picker, Import and Restore alike), cookie-clicker rule validation on pick and import and the
    sender cross-check, `isTrusted` in the cookie-clicker picker, the matrix panel not web-accessible, the
    extension-page CSP tightened, no listener for other extensions or web pages; (10.7.15, C47) picker listeners on
    `window` capture, `isTrusted` on the Worry-free picker's buttons and the element-picker overlay's Escape.
82. **CMP loader blocks (C41)** — `test-cmp-loader-block.mjs`: decline mode only, saved-rule sites exempt, released
    with the session.
83. **Cookie-notice sets** — `test-cookie-notice-sets.mjs`: per mode, own library, saved clicker rules prevail.
84. **Power tools option** — `test-power-tools.mjs`: classification, new/existing default, untick sets smart.
85. **Ad leftover cleaner** — `test-ad-cleaner.mjs`: data, page-script lifecycle, launch and keep routes.
86. **Seamless surfing always on** — `test-seamless-always-on.mjs`: default, off only for advanced users, start, prompt.
87. **Hover text has no internal code references** — `check-hover-text-no-code-refs.mjs`.
88. **Privacy Badger unbreak** — `test-privacy-badger-unbreak.mjs`: needed hosts excepted for the tracker lists only.
89. **Hostname shape (11.0.2)** — `test-hostname-shape.mjs`: every hostname check accepts underscores, one shared shape.
90. **Page scripts survive an extension reload (11.0.2)** — `test-content-script-context.mjs`.
91. **Live smoke test in real Chrome** — `e2e-live-smoke.mjs`; skipped without Chrome, run only after asking the owner.
92. **Input size before reading (C49, F-INPUT-1)** — `check-input-size-limits.mjs`: every whole-file read is gated by
    `checkImportFileSize()` or classified with a reason; the helper is driven with edge sizes. Proven: an injected
    ungated read, a broken limit and removed gates each fail it.
93. **Tier direction (C15)** — `check-tier-direction.mjs`: downward imports only; only `background.js` imports a
    workflow/ file; util/ imports only listed zero-import targets; no tier file imports scripting/ or offscreen/ code.
    Proven: an injected route-to-route import, an upward import, a new util/ import and an exception target that gains
    an import each fail it.

*Sibling-project numbering.* In 3P Matrix's suite, step 50 is "derived UI values" (`check-derived-literals.mjs`,
ported here as step 62) and step 51 is "shipped terms + MAIN-world constant copies" (`check-shipped-terms.mjs`; its rule
— a value the platform forces you to copy is declared once per file and proven equal to the source — is applied here by
step 60). 3P Matrix's suite also checks list freshness: each shipped third-party data list names its source, licence and
rebuild tool in `data-sources.json`, and a list marked `updateOn: "minor"` must be rebuilt every minor release.

### Keeping the suite honest

- [ ] A new stateful module gets a functional smoke test (step 6), not only a syntax check.
- [ ] A new message type passes step 7 before it is assumed wired.
- [ ] A new DNR-rule-producing feature adds its base id and size to step 9.
- [ ] A false positive in an informational check goes on that check's own documented allowlist (like C20a's
      broadcast-only set), with the false-positive class named in the check's file.
- [ ] A new option, setting or process gets its C41 row and a `PROCESS_REGISTRY` test.
- [ ] A new exception/cancellation syntax gets its own step-13 instance.
- [ ] A change to a single source of truth runs the C39a inventory and step 62 in the same pass; new UI values are
      derived, new tests import their expected values.
- [ ] A bug class crossing three occurrences (C25) gets the HARD CONSTRAINT *and* a step-14-style scan in the same pass.
- [ ] The suite passes as gate item G6 before every version that will be zipped.
- [ ] A check producing persistent false positives is narrowed or fixed, never ignored.
- [ ] A devDependency invoked as a CLI binary is added to the unused-dependency exemptions at the same time.
- [ ] A new root-level tool config file (`knip.jsonc`, `.depcheckrc.json`, `.stylelintrc.mjs`) is registered to the
      tools artifact.
- [ ] A claimed improvement of a newer check over an older one is proven with a synthetic case before it is trusted.
- [ ] Any change to the build scripts is verified with `tools/verify-build-unchanged.mjs` (`record` before, `verify`
      after; it replays recorded downloads so upstream changes cannot hide or fake a difference; standalone by design).
- [ ] Every `tools/check-*`, `test-*` and `e2e_*` script is invoked by the suite or documented as standalone — compare
      the directory against the step list whenever a script is added (step 34 was found this way).
- [ ] When a source directory is added, renamed or removed, `eslint.config.mjs` globs are updated in the same pass (a
      stale `'monitor/**'` once left `matrix/` and `privacy/` under none of the project's rules).

**Planned checks (v15) — not steps until they exist and run (C38):** a per-message size limit
(C49, after measuring), URL arguments in console calls (C50), page-script footprint (C53), observer ownership (C54), generated-input
tests (C58), minimum-Chrome API list (C59), technical-debt register cross-reference (C57), `npm audit` informational
(C37). Each is proven in three directions (C38 rule 3) when it is added.

---

# Part V — Cooperation

## Chapter 13 — Working with the owner

The owner decides; Claude proposes, implements what was asked, and reports. These rules come from real sessions where
the opposite cost time.

### Scope: do what was asked

- **Do only what was asked.** No logic or behaviour change beyond the request, no renamed message types, storage keys or
  public API functions, no silently changed defaults (Ground Rules).
- **Findings before fixes.** In an audit, report every finding first so the owner decides what to apply. When a
  discrepancy is noticed during other work, discuss and propose (at most 5 lines) before repairing it.
- **Apply a proven fix everywhere.** Once a fix is agreed for one instance of a problem, fix every other instance of the
  same problem the same way without asking again, and report it afterwards (C21, C22). After any fix, look for similar
  situations and propose fixing them.
- **Never fake a workaround.** If the real solution cannot be done, say so plainly and stop; never substitute invented
  data or a pretend fix.

### C29. Ask before pursuing an alternative approach

A clear request is built as asked. A different, "better" or "safer" way to reach the same goal that occurs mid-work is
worth raising — by stating it and waiting, not by building it instead. The owner may already know it and have reasons
(an existing policy, a weighed trade-off, urgency); a substituted result removes that choice and costs a second round.

- [ ] Identify the literal thing asked for, not just the goal behind it.
- [ ] If an alternative forms, stop before writing code for it; state it and ask.
- [ ] If the owner confirms the original ask, build that, and do not re-raise the same alternative.
- [ ] "I already thought about this and chose differently" is a complete answer.

**Worked example:** asked to re-enable a specific Select mitigation (`abort-on-property-read`) for two Privacy Inspector
categories, the session researched a "safer" `set-constant` substitute instead. The owner: "NO, do what I ask" — the red
High-risk badge is the intended warning, as for every other High-risk category in that panel.

### C26. A placement instruction is literal

"Between X and Y", "above the line that says Z", a named landmark — that is a literal location, not a category. Grouping
a new control with similar ones, inside an existing gated section, can be well reasoned and still wrong.

- [ ] With two named anchors, find both in the file and place the change literally between them.
- [ ] With no anchor, pick a reasonable spot, state where, and note the assumption.
- [ ] If the literal placement conflicts with a structural convention (a locked section, a bulk action that would now
      include it), surface the conflict and ask.
- [ ] Afterwards, state where the change actually landed. Once a literal placement has been given, check later related
      requests in the session against it.

**Worked example:** a new checkbox asked for "in between existing ones" was placed with similar toggles inside a gated
section; the intended spot was between two named elements outside it, in a different style. It had to be redone.

### C24. Verify a concern before raising it as a finding

Thinking ahead and naming second-order effects is encouraged. What is not acceptable is presenting a hypothesis as a
confirmed risk ("this will break X for anyone who did Y") when the one grep that would confirm or kill it was not done.
The owner cannot tell a verified concern from an unverified one by its wording, and may build defensive machinery for a
scenario that cannot occur.

- [ ] Identify the mechanism the concern depends on (a UI control, a code path, a stored key).
- [ ] Read or grep the code: does it exist, is it reachable, does it behave as assumed?
- [ ] Confirmed → state it as a finding, with what was checked. Not yet checked → phrase it as a question and say so.
      Refuted → say so and drop it.

**Worked example:** a ruleset-id rename was flagged as orphaning users who had disabled that ruleset. The persistence
mechanism was real, but no UI control could ever disable that ruleset — one grep showed it. The concern had already
cost a round of discussion and a proposed migration.

### Contradicting requests — "keep working" is the rule (owner, 10.4.9)

When a request, or two requests together, would have contradicting effects — blocking more but breaking a feature, a
speed gain that costs a capability — do not pick a side silently and do not apply it first. Report the contradiction in
**at most 5 lines**, in terms of what the user will notice (what stops working, what gets slower or bigger), and let the
owner decide. Default when the intent is clear: the option that keeps sites and features working.
*Example:* "block websockets on all adult sites" would also cut live cams and chat; the owner chose third-party
websockets only.

### Flag real behaviour changes — and only those

Before applying a change that removes a capability, alters what the user sees, or has an effect beyond what was asked,
state it in one capitalised line: `WARNING FOR IMPLEMENTATION IMPACT: <what the user will see or lose, in plain terms>`.
Describe the *result* the owner will see ("you will get two separate bars stacked, not one"), not only the mechanism.
**Do not add this flag for anything that does not change what the extension does or what the user loses** — an
irrelevant warning hides the real ones.

### Questions and decisions

When asking the owner to decide, explain the impact on functionality in at most 3 lines — what changes for users. For a
direct question, answer briefly instead of explaining the implementation.

### Reporting

- **One management summary, once, when the work is finished — at most 10 lines.** No running commentary, no step
  recaps, no re-listed files or check output: long reports exhaust the conversation and force compaction, which loses
  context. The summary states what was done, the version, whether all checks passed, any `WARNING FOR IMPLEMENTATION
  IMPACT` line, and what needs the owner's decision. Detail goes in `CHANGELOG_HISTORY.md`.
- Exceptions: the up-front findings summary of an audit, the pre-zip gate report (one line per gate item), and a direct
  question.
- **Before calling a change "done"**, state which other consumers of the same fact or logic were checked — C39a's
  inventory, C41's CRUD letters, C21's reuse, C25's recurring-class check — not only after the owner finds a gap.
  *Incident (DownloadSentinel 4.5.0):* a live-campaign host list was wired into the site-visit warning and zipped;
  nobody checked the download-interception path, the only other place that scores a URL's host, and a direct download
  of the exact malware link tested went unflagged. Every principle that would have caught it was already written down.
  The gate is a step, not a document.

### C30. On interruption, checkpoint the plan

When the owner interrupts multi-step work (a correction, a new instruction, "stop"), the state of the plan is most at
risk of being lost.
- [ ] Note the full plan and how far execution got before handling the interruption.
- [ ] After handling it, say explicitly if the original task is unfinished.
- [ ] Offer to continue with the remaining steps in short, plain terms, and wait for confirmation before resuming.

### Real-browser tests

Tests in a real Chrome (Puppeteer / Chrome for Testing) are run only after asking the owner, each time.

---

## Chapter 14 — Release process

### Work from the right source

- **Always work from the exact source tree that already contains the latest verified functionality.** Never rebuild from
  an older version or another branch: that silently reintroduces fixed bugs or removes finished features (**regression by
  source rollback**). The same holds for a *partial* export (a "code-only" build, a submission package without docs)
  treated as if it were the whole project.
- **State the exact source version** before starting (`Working from v10.7.6`).
- **If the latest verified tree is unavailable, stop and ask for it.** Never recreate the project from an older release.
- **Before packaging, confirm every previously completed feature still exists.** A passing build or syntax check is not
  enough.

### Multi-artifact packaging integrity

**Incident:** the release is split on purpose into an extension package, a docs package and sometimes a stripped
"code-only" export. The code-only export, built once correctly, became the default starting point for later sessions
because it happened to be on hand — and nothing recorded that it was a subset. Three minor versions (8.2.0 → 8.3.0)
shipped without `tools/build-rulesets.mjs` and the verification suite; a real site-mode-gating bug reached all of them
because the check that would have caught it was absent, not just skipped.

**Rules:**
- When a source tree is split into several artifacts, keep one explicit, versioned manifest of what belongs in each and
  why each exclusion is deliberate — one place a fresh session reads first (`tools/package-release.mjs` and
  `tools/package-release-state.json`).
- Before working from an uploaded zip, check whether it declares itself partial. If its completeness is unknown, say so
  and ask.
- A partial export is never a new primary copy: the next full release reconciles it against the last complete tree.

### Exactly three release zips, each rebuilt only when its own content changed

| Zip | Contents | Goes to |
|---|---|---|
| `uBlock-Stripped-Dynamic-<version>-extension.zip` | Runtime code only — everything the manifest declares or the code imports, plus the files a user or licence needs, declared once in `tools/package-release.mjs`: `LICENSE.txt` and `THIRD_PARTY_LICENSES.md`. No project-history documentation (guarded, not checked by hand). | Chrome Web Store |
| `uBlock-Stripped-Dynamic-tools-<version>.zip` | Build, verification, lint and test suite (`tools/*.mjs`, `package.json`, `package-lock.json`, `eslint.config.mjs`, tool configs). Needed to regenerate filter lists and run the suite. | Never uploaded |
| `uBlock-Stripped-Dynamic-<version>-docs.zip` | `CHANGELOG.md`, `CHANGELOG_HISTORY.md`, `ARCHITECTURE.md`, `PRIVACY_POLICY.md`, the style guides, this manual, other project-history files. | Never uploaded |

- **Neither changelog is inside the extension zip (since 10.1.4):** every release edits them, and an edited file inside
  the package disqualifies Chrome Web Store skip-review.
- **Only rebuild and re-version a zip whose own content changed.** A patch touching only `js/` reuses the last tools and
  docs zips; say so plainly. Per-artifact "last changed at version X" is tracked in one declared place
  (`package-release-state.json`).
- State per release which zips changed and which are carried over. Hand back only the zips that changed.

### C27. Packaging conventions

- **A skip-review (SAFE) update must be byte-identical to the last published zip** except the manifest version and the
  `rule_resources` file(s) being refreshed — documentation included. The Store diffs the whole package: editing
  `CHANGELOG.md` inside it once disqualified skip-review (and every release, until 10.1.4 moved it to the docs zip).
  A scoped release also limits its `rule_resources` changes to lists whose companion files did not move, checked file by
  file. `tools/verify-safe-update.mjs <previous-extension.zip> <new-extension.zip>` checks the two finished zips.
- **The zip's filename carries the version; the folder inside does not.** Everything extracts to one plain folder
  (`uBlock-Stripped-Dynamic/`), so IDE workspaces, "Load unpacked" and shell aliases keep working across releases.

### Versions

- **Always bump the version before packaging** — `manifest.json` for the extension (and the docs version); the tools
  version is computed by `tools/package-release.mjs` and written into `package.json` by it (never hand-edited; step 19).
  Every zip corresponds to exactly one version; two different zips never share one. A documentation-only change that is
  packaged is bumped too; one that is not packaged rides along with the next real bump.
- **Only bump if the extension actually loaded.** *Incident (8.6.0):* a permission dropped from `manifest.json` during
  an unrelated cleanup; every automated check passed, but the service worker never registered. The suite passing does
  not replace confirming the extension starts.
- **A version that shipped broken is fixed in place**, at the same version number that was meant to work — not stacked
  as a new release on a version that never functioned.
- **Wording corrections** (GUI labels, spacing, text) never bump the version; they are corrected in place at the current
  version.

### B4. Two changelogs, two audiences

| File | Ships in | Reader | Content | Written |
|---|---|---|---|---|
| `CHANGELOG.md` | Docs zip | Users | A short summary of *what* changed — never how: no file names, mechanisms or internal identifiers. | For **every** zipped version, before zipping. |
| `CHANGELOG_HISTORY.md` | Docs zip | Developer, next session | The technical record: what, **why**, how, known limitations, the source version worked from, which zips changed. Root causes live here (C21, C23, C25). | **Only for big changes** — a feature, a bug-class fix, a refactor, a batch of principle fixes. |

- [ ] Every zipped version has a `CHANGELOG.md` entry; step 19 fails if its top entry does not match the manifest.
- [ ] Every **tools** version appears in `CHANGELOG_HISTORY.md` at least as a one-line `**tools X.Y.Z:** <what>` (14
      tools bumps once shipped with no record at all; step 19 enforces it).
- [ ] A big change's technical entry is written **before** the zip; "is this big enough" is decided explicitly — when
      unsure, write it.
- [ ] Behaviour-visible changes carry the `WARNING FOR IMPLEMENTATION IMPACT:` line in the technical entry, and appear in
      plain words in the user entry.

### Every code change includes a full filter update

Whenever the extension's code changes, the release includes a full filter refresh (`node tools/build-rulesets.mjs`). A
SAFE filter update (skip-review) changes only the named safe rulesets (`tools/build-safe-filters.mjs`).

### Never hand over a loose file

A fix to any file of the extension, tools or docs artifact is applied to the working tree, and what goes back is the
corresponding versioned zip — never the changed file on its own, however small. A loose file is an untracked copy no
state file knows about; the next session cannot tell whether it was applied or superseded. When a fix is made outside a
release, say so and ask whether to package it now or leave it in the working tree for the next release.

### Pre-zip principles gate (owner's rule, 10.4.10)

**Rule:** before any zip is built — extension, tools or docs, a one-line fix included — the session applies this manual
and then checks, item by item, that it did, and reports the result **before asking permission to zip**. Every item gets
a verdict and evidence (a file and line, a check's output, a grep count), never a bare "yes". An item that could not be
checked is `NOT CHECKED`, never `PASS` (C38). Any `FAIL` or `NOT CHECKED` on G1–G7 means no zip until it is fixed or
the owner explicitly accepts it. An item that does not apply is `N/A` with the reason.

| Gate | What is checked | Rules |
|---|---|---|
| **G1 Source** | Exact source version stated; it is the latest verified tree (no partial export); no completed feature lost | Chapter 14 "Work from the right source", multi-artifact integrity |
| **G2 Scope & impact** | Only what was asked was changed; every real behaviour change carries a `WARNING FOR IMPLEMENTATION IMPACT` line; contradicting requests were reported; no unrequested alternative built | Chapter 13, C26, C29 |
| **G3 Structure** | One module, one responsibility; named functions use `function`; every variable, switch and magic number of a touched module is in its one commented constants section; UI and test values derived | C1, C9a, C11, B1, B2, B2a, B8, C39a |
| **G4 Guards & resources** | Every new state, timer, listener, port, cache or storage key has an init guard, a clear/reset path and a release path on every exit path (error and worker restart included); removed features leave no storage or listeners behind | B3, B3a, B6, B7, B10, C8, C13, C13b, C18 |
| **G5 Consumers** | Inventory of every other consumer of the changed fact or logic, named in the report; CRUD letters and Initiate → Perform → End checked; sibling features and sibling projects considered | C39a, C41, C21, C22, C25 |
| **G6 Verification** | `node tools/pre-zip.mjs` exits 0 (rebuild + full suite); new logic has its own committed, fault-verified test; the extension was actually loaded and its service worker started; a storage migration is run in a real browser against what the OLD version stored, then across a browser restart (10.5.0: unit tests passed while the real run showed a gate field was never saved). Reloading a changed unpacked folder on the same profile can keep running old service-worker code — seed the old storage instead | C38, C42, "only bump if it loaded" |
| **G7 Packaging** | Version bumped everywhere it is tracked; only zips whose content changed are rebuilt; `CHANGELOG.md` (and `CHANGELOG_HISTORY.md` for big changes) written first; no docs in the extension zip; no loose files | Three release zips, B4, C27 |
| **G8 Permission** | The owner was asked and said yes — the gate report accompanies the question | "Ask before creating a zip" |

**Report format** (one line per gate item):
`PRINCIPLES GATE <version>: G1 PASS (worked from 10.7.5, full tree) · G2 PASS · G3 N/A (docs only) · … → READY TO ZIP — permission?`

**Why:** an incident (DownloadSentinel 4.5.0, Chapter 13) showed every relevant principle written down and none run at
the moment the word "done" was used. The gate puts the check at the one moment every change passes through — the zip.

### Release checklist

- [ ] Source version confirmed and stated in the release notes; it is the latest verified source.
- [ ] No previously completed functionality regressed.
- [ ] Full filter update done (code changes).
- [ ] Changelogs written; versions bumped.
- [ ] Pre-zip gate run and reported; the owner said yes.
- [ ] `tools/package-release.mjs` built the zips; `tools/check-version-sync.mjs` passes afterwards.
- [ ] Only the changed zips are handed back.

---

# Appendices

## Appendix A — ID index

| ID | Title | Chapter |
|---|---|---|
| A1 | CSS in numbered sections | 5 |
| A2 | Design tokens in CSS variables | 5 |
| A3 | One consistent left edge | 5 |
| A4 | HTML section comments | 5 |
| A5 | Orphaned CSS | 5 |
| A6 | Inline styles | 5 |
| A7 | CSS consistency | 5 |
| A8 | Light/dark contrast is computed | 5 |
| A9 | Light and dark style guides | 5 |
| B1 | Centralise magic numbers | 4 |
| B2 | Eliminate duplicated constants | 4 |
| B2a | Constants hard-coded in HTML | 4 |
| B3 | Document state, guards and timers | 2 |
| B3a | State vectors — swimming lanes | 2 |
| B3b | Self-closing timed-session panels | 2 |
| B4 | Two changelogs, two audiences | 14 |
| B5 | Architectural ceilings | 1 |
| B6 | Bounded collections | 8 |
| B7 | Service-worker restart survival | 2 |
| B8 | Stateless vs stateful constants | 2 |
| B9 | Settings default coverage | 2 |
| B10 | Resource release audit | 2 |
| B11 | Trust lists that skip a safety check | 6 |
| B12 | One-time-only UX flags | 2 |
| B13 | DNR `regexFilter` constraints and ruleset limits | 4 |
| B14 | `Map` for dynamically keyed collections | 8 |
| B15 | One parser per syntax | 4 |
| C1 | One module, one responsibility | 1 |
| C2 | No direct cross-module state access | 1 |
| C3 | Message routing — one listener, one route table | 1 |
| C4 | Storage access — one layer | 1 |
| C5 | Errors propagated, declared or reported | 3 |
| C6 | Validate input at module boundaries | 6 |
| C7 | Feature isolation | 1 |
| C8 | Lifecycle management | 2 |
| C9 | Naming conventions | 1 |
| C9a | Named functions use `function` | 1 |
| C10 | Module header | 1 |
| C11 | Single-purpose functions (and the no-split decision) | 1 |
| C12 | Clean API boundaries | 1 |
| C13 | Consistent state on every path | 2 |
| C13a | Data-set and build-time consistency guards | 4 |
| C13b | Dead guards and stale state | 2 |
| C13c | Overly broad DNR rules dropped | 4 |
| C14 | Atomic state transitions | 2 |
| C15 | Five-tier folder structure | 1 |
| C16 | Service-worker load order | 1 |
| C17 | Page-context load order | 1 |
| C18 | Module removal checklist | 1 |
| C19 | Store-readiness and permission audit | 7 |
| C20 | Declared files vs files on disk | 1 |
| C20a | Message-type routing | 1 |
| C21 | Reuse a proven solution | 10 |
| C22 | Cross-variant consistency | 10 |
| C23 | Check version history first | 10 |
| C24 | Verify a concern before raising it | 13 |
| C25 | Recurring bug class → constraint + check | 10 |
| C26 | A placement instruction is literal | 13 |
| C27 | Packaging conventions | 14 |
| C28 | Hostname from the sender, not the message | 6 |
| C29 | Ask before an alternative approach | 13 |
| C30 | Checkpoint the plan on interruption | 13 |
| C31 | Messages are JSON-serialized (JSON mode pinned) | 1 |
| C32 | Storage schema versioning | 2 |
| C33 | No dynamic `import()` in the service worker | 2 |
| C34 | `web_accessible_resources` scope | 6 |
| C35 | MAIN-world scripts run in hostile territory | 6 |
| C47 | UI drawn into a web page is in hostile territory | 6 |
| C36 | Added permissions disable existing installs | 7 |
| C37 | Release pipeline security | 7 |
| C38 | A check that did not run has not passed | 11 |
| C39 | Features ship working end-to-end | 10 |
| C39a | Every consumer; derived, not transcribed | 10 |
| C40 | Hand-porting upstream scriptlets | 10 |
| C41 | CRUD and Initiate → Perform → End | 10 |
| C42 | A name in chat is not a test | 11 |
| C48 | Threat model | 6 |
| C49 | Limit untrusted input before reading it | 6 |
| C50 | Logs and error text disclose nothing unexpected | 6 |
| C51 | Third-party code enters through one gate | 10 |
| C52 | New code gate and fault containment | 10 |
| C53 | Page scripts: least work, least moment | 8 |
| C54 | DOM work and MutationObserver | 8 |
| C55 | Service-worker cold start | 8 |
| C56 | Performance against a baseline | 8 |
| C57 | Technical-debt register | 10 |
| C58 | Generated-input and differential tests | 11 |
| C59 | Minimum Chrome version is a contract | 11 |
| F-* | Forbidden practices (v15 added F-INPUT-1, F-URL-1, F-LOG-1, F-3P-1, F-NEW-1, F-DOM-1, F-DEP-1) | 9 |
| G1–G8 | Pre-zip principles gate | 14 |
| Part D | Automated check suite (steps 1–93) | 12 |

There is no C19a and no C28a; C29–C30 and C38–C42 were added after the original A/B/C series. C43–C46 are not used in
this copy (3P Matrix's C46 is its sender-kind rule); C48–C59 were added in v15. If the 3P Matrix copy already uses any
of C48–C59, the two copies must be reconciled before merging.

---

## Appendix B — Version history of this manual

Since v13 the file is `Xplainer_Programming_principles_conscript.md` (owner's rename); before that it was
`Xplainer_Programming_principles_audit_v5.md`, the name older changelog entries still use. `tools/package-release.mjs`
(`DOC_FILES`) lists it.

- **v15 (after the 11.0.2 audit)** — From an external review of v14, weighed against one condition: nothing may make
  the code less robust or less future-proof. Added: C48 threat model (attack sources mapped to existing rules); C49
  input limits checked before reading (real gap: three file imports read whole files unchecked); C50 logs disclose
  nothing unexpected; F-URL-1 scheme check before navigation (already followed); C51 third-party intake gate and C52
  new-code gate with fault containment (owner's request: keep defects from entering with third-party or new code);
  steps 92–93 check the file imports and tier direction; C53–C56 page-script footprint, DOM/MutationObserver work, worker cold start, baseline-relative performance; C57
  technical-debt register; C58 generated-input (fixed seed) and differential tests; C59 minimum Chrome version. Refined:
  C6 (one hand-written validator per data type), C10 (Input trust / Errors header lines), C15 (direction check
  planned), C19 (a reason per permission), C37 (zip hashes, `npm audit`, dependency and data provenance), C47
  (`isTrusted` is not authority), B6 (cost in the bound comment), B14 (measure, don't ban on theory); a *Check* line
  for new rules; new rules may tighten, never relax. **Not adopted, with reason:** a JSON-schema library and lazy
  loading (new runtime code / a load that can fail), stored security event logs (a browsing record), hard millisecond
  budgets (flaky; relative gate instead), a transparency dashboard (new feature surface), SBOM and signed metadata
  (lockfile and Web Store signing cover them), six new chapters (rules would get two homes). Checks marked *planned*
  are not steps yet.
- **v14 (10.7.13–10.7.15)** — After the uBO picker UXSS review (GHSA-cmqw-9r2w-6wv2; uBD was not affected) and the
  MalwareTips review of C19/C31: C31 rewritten (JSON messaging kept because it is the safer format; Chrome 148's
  structured-clone opt-in not used, step 33 fails on the key); C19 corrected against Chrome's DNR reference
  (`getMatchedRules` also works with an `activeTab` grant — the ban is project policy; the "rejected for declaring the
  feedback permission" claim removed); C19 checklist gained the explicit extension-page CSP and "no empty
  `externally_connectable`" (shipped in 10.7.13, Chrome warned that nothing can connect, removed in 10.7.14); F-TRUST-3
  (stylesheet-escape guard on every entry path); new C47 and F-TRUST-4 (in-page UI: `isTrusted`, `window`-capture
  listeners), applied in 10.7.15; C3 notes the sender-kind rule 3P Matrix adopted as its C46 in 5.0.6.
- **v13 (10.7.6, after release)** — Restructured into five parts in design-and-delivery order: Architecture, Security,
  Performance, Principles, Cooperation; release-process rules gathered in one chapter; an ID index added. Every ID kept.
  Two internal contradictions resolved in favour of how the project works today: B4's table placed `CHANGELOG.md` inside
  the extension zip (it has been in the docs zip since 10.1.4), and B2a's example built HTML text from values (now
  `textContent`, per F-SINK-1). The owner's standing working rules already in force (wording fixes do not bump the
  version, every code change includes a full filter update, real-Chrome tests only after asking, no irrelevant impact
  warnings, short decision questions) are written into Chapters 13–14.
- **v12 (10.7.6, audit of 10.7.5)** — Chapter 0 Forbidden practices (now Chapter 9). B13 extended with Chrome's static
  ruleset limits (100 / 50 / 30,000; step 78). Project-status notes on C3, C7, C16, C17 (ES-module worker, route table,
  module page scripts). Storage visible to pages and sender trust (step 76). B3b: the background deadline is an alarm.
  B15/B13: one network parser; regex rules gated by Chrome at build time. C5 extended: declared expected errors, failures
  shown where the user acted, no raw promise-chain locks (steps 72–73).
- **v11 (10.4.10)** — Pre-zip principles gate G1–G8 (owner: act on the principles and check before each zip). The 3P
  Matrix and uBlock-Stripped-Dynamic copies merged. G6 extended: migrations proven in a real browser from the old
  version's storage and across a restart. Part D numbering of the two projects reconciled.
- **v10 (3P Matrix 4.2.3)** — C39a: end-to-end means every consumer; derived values everywhere, tests included
  (`check-derived-literals.mjs`). Shipped terms and MAIN-world constant copies. Data-list register and freshness gate.
  Upgrade tests start from what the old version really stored.
- **v9** — C41: CRUD for every data element, Initiate → Perform → End for every process (`check-crud-lifecycle.mjs`,
  step 49). Part D re-synced (steps 39–49).
- **v8** — C38: a check that did not run has not passed (the Knip incident). C31–C37 from a pass over Chrome extension
  best practices, each with a status line verified by grep at 9.7.5.
- **v7** — Two-tier changelog policy made explicit (B4). Zip contents corrected to match `package-release.mjs`. Steps 33
  (permissions ↔ API usage, the 8.6.0 lesson) and 34 (an unwired dry-run) added; unwired checks and stale lint globs added
  to the maintenance checklist.
- **v6** — Part D fully re-synced with the real suite (16 → 29 steps). Maintenance checklist extended for informational
  checks, CLI-invoked dependencies and tool config files; a claimed improvement of a newer check must be proven with a
  synthetic case. Lesson: renumbering a list without grepping for references *into* it leaves the document stale
  elsewhere.
- **v5** — Multi-artifact packaging integrity (the code-only export incident, 8.2.0–8.3.0). Exactly three release zips,
  each rebuilt only when its content changed. "Regression by source rollback" extended to partial exports.
