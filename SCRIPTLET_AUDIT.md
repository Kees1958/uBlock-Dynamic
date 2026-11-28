# Scriptlet semantics audit

Standing record of the scriptlet audit required at every major version (programming-principles doc, "Scriptlet
semantics audit at every major version"). Newest audit on top. Each finding: what differs, which rules, what it does
to the user, and its status.

## 11.1.6 — first full audit (owner's request 2026-11-28, after the Fox News / Admiral report)

**Scope.** 6,803 scriptlet rules, 93 scriptlet names, in the shipped lists of the 2026-11-28 build; @adguard/scriptlets
2.6.0; compared with uBlock Origin (gorhill/uBlock master, 2026-11-28) and uBO Lite's scriptlet registration.
246 rules carry a uBO name (`ubo-…`): Anti-Admiral 189, Bulgarian 24, Nordic 17, Latvian 16.

**Method.** (1) every rule's argument count against its function's real parameter count (espree parse; transpiled
defaults counted as `arguments[N]`); (2) uBO named arguments and uBO-only values against what the AdGuard function does
with them, read in its source; (3) uBO-origin behaviour against uBO's own source; (4) observers with a time limit in every
AdGuard function used; (5) injection settings against uBO Lite's `scripting-manager.js`; (6) names without a function.
Timing and frame findings reproduced in real Chrome (`tools/e2e-scriptlets.mjs`).

| # | Finding | Rules | Effect for the user | Status |
|---|---|---|---|---|
| 1 | AdGuard `remove-node-text` judges a node only when it is added (an inline script's text arrives later) and stops watching after 10 s | 306 (also uBO `rmnt`) | Anti-adblock starters (Fox News Admiral) run although a rule matches | **Fixed 11.1.6** — uBD's own function |
| 2 | AdGuard `trusted-replace-node-text` is built the same way (10 s observer) | 104 | Same class: a rule that should rewrite a script can miss it | **Fixed 11.1.6** — the same uBD function, replace mode by the rule's name (tests 100, 101) |
| 3 | Build reads AdGuard-syntax arguments without escapes: `\'` ends the value, the rest becomes extra arguments | 7 seen (remove-attr 1, trusted-replace-node-text 4, abort-current-inline-script 1, remove-node-text 1) | Those rules run with a cut-off argument (most do nothing, some match more) | **Fixed 11.1.6** — one shared reader/writer, `js/util/scriptlet-args.js`, for the build and the user's rules; the uBO→AdGuard conversion no longer drops arguments holding both quote kinds (test 102) |
| 4 | uBO named arguments other than `rmnt`'s are passed on unchanged: `ra … asap, quitAfter, 10` → AdGuard makes one pass only; `set … runAt, interactive` → AdGuard reads `runAt` as a value wrapper (ignored, runs at start); `json-prune-fetch-response … propsToMatch, X` → AdGuard takes the word `propsToMatch` as the pattern | 9 + 5 + 1 (Anti-Admiral / Ad-Shield) | Ad-Shield's `onerror` recovery can survive; the `propsToMatch` rule never matches | **Fixed 11.1.6** — `js/data/ubo-scriptlet-args.js`: `ra`/`rc` behaviour words + `quitAfter`→`stay`, `set` `runAt` (timing, dropped) and `as`→wrapper, `json-prune-*-response` named→positional (test 97) |
| 5 | uBO-only values for `set`: `{}`, `function() {}` — AdGuard's `set-constant` returns on an unknown value | 3 | Those rules do nothing | **Fixed 11.1.6** — `{}` `[]` `''` translated; `function() {}` refused: uBO itself ignores it (its value table, set-constant.js), so the rule never worked anywhere (test 97) |
| 6 | uBO `acs` third argument (`context`: the script's `src` must match) has no AdGuard equivalent; AdGuard's function only acts on inline scripts | 1 | Rule does nothing | **Fixed 11.1.6** — refused with a reason in the build report (test 97) |
| 7 | Names: `ubo-prevent-setTimeout` (uBO alias of `no-setTimeout-if`) not resolved although AdGuard has it; `ubo-rpnt` is uBO's TRUSTED `replace-node-text` but is reported as "missing" instead of going through the trust policy; `ubo-golem.de.js` has no equivalent | 1 + 5 + 1 | One working rule lost; five rules mis-reported | **Fixed 11.1.6** — `prevent-setTimeout/-setInterval/-requestAnimationFrame` uBO spellings mapped; `rpnt`/`replace-node-text` added to the trust policy (rule A) — its 40 uAssets lines now show as trusted drops (none ever ran); `golem.de.js` stays reported (site-specific, no equivalent) |
| 8 | Scriptlet registrations lack `matchOriginAsFallback: true` (uBO Lite sets it) | all | No scriptlets in `about:blank` / `srcdoc` / `blob:` frames a page creates — where anti-adblock code can fetch clean, un-hooked browser functions | **Fixed 11.1.6** — `matchOriginAsFallback` on the list and cookie-notice scriptlet registrations, AND the generated lookup reads the site from the frame's inherited origin when it has no hostname (without that, the frames got the scriptlets but no rules); compared field in `directiveUpdate`, so existing installs re-register (test 101, fault-verified) |
| 10 | Found in the 11.1.6 build log: the top-25 adult-site rule path skips uBO-syntax scriptlet lines (`skipped 2351 "##+js(...)" … not yet supported`) instead of converting them like every other list (tools/build/ubo-scriptlet-syntax.mjs) | up to 2,786 lines | uBO scriptlet fixes for those sites never reach uBD | Open — next release (outside the 11.1.6 approval) |
| 9 | Minor: `abort-on-property-write` (Hungarian) passes a second argument the function ignores | 1 | None found | Accepted |

**Checked and equal.** World (MAIN), `allFrames`, `document_start` match uBO Lite. AdGuard-native rules run AdGuard's own
functions, so apart from findings 3 and 8 they behave as in AdGuard. uBO `nowoif … obj` and `no-fetch-if … length:N` are
understood by AdGuard's functions.

**Decision recorded (finding 8, owner 2026-11-28).** The cookie clicker, cookie-notice hide CSS and the Never-consent
bundle keep their registration (no `matchOriginAsFallback`): CMP banners live in frames with a real address —
@duckduckgo/autoconsent 18.14.0: 16 of 1,606 CMP rules run in a frame, every one an https page; Sourcepoint's frames are
`*.sp-prod.net` pages. CMPs use about:blank only for the empty TCF locator frames (`__tcfapiLocator`), where there is
nothing to click or hide. Revisit with a concrete site where a banner escapes.

**Reporting change from finding 7.** The trust gate runs on every downloaded uBO line before the Admiral selection, so
the "trusted scriptlet from a non-AdGuard source" count rose 83 → 123 (40 `rpnt` lines). No shipped rule changed: those
lines never ran (5 were skipped as "missing", the rest were never selected).

**Implementation impact of findings 1-8 (11.1.6).** Rules that silently did nothing now act: remove/replace-node-text
on scripts arriving in pieces or added later, Ad-Shield's `onerror` removal keeps watching, 3 uBO `set` values work,
1 `json-prune-fetch-response` rule matches, 7 AdGuard rules read their full argument, and every list and cookie-notice
scriptlet also runs in about:blank / srcdoc frames of its site.

**Implementation impact of finding 1 (already shipped in 11.1.6).** AdGuard-native `remove-node-text` rules now act on
scripts that arrive in pieces and on nodes added after 10 s — more than AdGuard itself does, the same as uBO.
