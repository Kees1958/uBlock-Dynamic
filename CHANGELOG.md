# Changelog

Short, per-release summary of what changed — no implementation detail.
Lives in the project's docs (since 10.1.4 it is no longer shipped inside the
extension). The full technical account is CHANGELOG_HISTORY.md.

## 11.0.3
- **All filter lists refreshed** (full update, 2026-11-22).
- **Importing a file that is too large is now refused straight away, with a clear message** (Restore settings,
  Import custom rules, the Import ABP box). The limit is 10 MB: the most this extension can store, so no real
  export is affected. Before, such a file was read in full and failed later.
- Internal tidy-up of how the Ad leftover cleaner saves "Keep for this site" rules; nothing changes for you.
- **Engineering manual v15** (docs): threat model, input limits, rules for adding third-party and new code,
  performance rules for page scripts and the service worker, generated-input tests.

## 11.0.2
- **All filter lists refreshed** (full update, 2026-11-21 morning). The Bad filter fixes list no longer has our two
  CNN scriptlet rules: they got in the way of AdGuard's own CNN rule, which handles CNN's in-video ads by itself.
- **The Cosmetic element picker now also lists the page itself** (`body` and `html`) at the top of its element path,
  as uBlock Origin does since 1.76.5b6. You can use their classes to point at an element, for example
  `body.modal-open .overlay`. A rule that would hide the whole page is refused ("This would hide the whole page").
  A `:style()` rule on them, for example to unlock scrolling, still works.
  Clicking empty page background while picking is now ignored (it used to show two errors on the extensions page).
- **The old name "uBlock Stripped" is gone from the window titles** (DNR tracking filter, Fingerprint Inspector,
  element picker) and the Settings page title: they now say "uBlock Dynamic".
- **Websites with an underscore in their name now work everywhere** (for example `my_site.example.com`). Before,
  the element picker, Cookie consent clicker rules and custom scriptlets could not be saved on them, without a
  message. (AdGuard fixed the same gap recently.)
- **No more "Extension context invalidated." errors after an update or reload.** Pages that were already open
  kept old scripts that failed on their next action; they now stop quietly. The Ad leftover cleaner says
  "Stopped: the extension was updated. Reload the page to run it again."
- **The Allow list takes the site name out of a pasted web address** (`https://www.bbc.com/news` becomes
  `www.bbc.com`). Lines that are not a website name are not saved, and a message after saving lists them.
- Any error the extension does not handle itself is now logged with its name and where it happened, and the
  right-click menu reports its own failures.
- **A Bad filter fix now only cancels the one rule it names.** A fix aimed at a redirect rule used to unblock the
  whole website it names; such a line is now skipped and listed in the build report. The current list has no such
  line, so nothing changes today.

## 11.0.1
- **Fewer broken websites from the tracker lists.** About 70 trackers that websites need — sign-in and payment
  checks, paywalls, consent banners such as InMobi's, video players, page builders — are no longer blocked by
  the tracker lists. The list of such hosts comes from EFF's Privacy Badger and is refreshed with every update.
- **HaGeZi Light is now one of the Seamless surfing tracker lists** (first row, on by default), next to Peter
  Lowe, Kees1958, AdGuard tracking servers and AdGuard tracking parameters. Like them, it only blocks while
  Seamless surfing is on, and you can switch it off on its own.
- "Badfilter quick fixes" is now called **"Bad filter fixes"** (its updates wait for store review, so they are not
  quick).

## 11.0.0
- **Seamless surfing has three modes now; the new default is "Accept, else decline".** Per website it accepts where
  uBD knows how to, and declines everywhere else. "Accept cookies" and "Decline cookies" stay. Everyone is asked once
  more after this update. The prompt shows the three choices stacked (no Cancel button any more — press Escape or click
  outside the prompt to keep your current choice), and the popup line reads "Seamless surfing mode - smart" for the new mode. A
  Cookie consent clicker rule you save for a website always overrides the mode on that website.
- **New option "I am an advanced user (unhide power tools)"**, at the bottom of Options. Off for new installs, on for
  everyone updating. When off, the popup shows only Ad leftover cleaner, Cosmetic element picker, Cookie consent
  clicker and Settings dashboard: Seamless surfing, Pause filtering, DNR tracking filter and Fingerprint Inspector
  are hidden (the last two also from the right-click menu). The dashboard always shows every tab. Rules you made with
  the hidden tools keep working. Switching the option off also ends a running pause and sets Seamless surfing to
  "Accept, else decline".
- **Seamless surfing is always on.** The "Enable Seamless surfing on startup" option is removed: Seamless surfing
  starts on install, after this update and at every browser start. Advanced users can turn it off from its prompt
  ("Turn Seamless surfing off") for the current browser session; the popup line then says "off", and Seamless
  surfing is on again at the next browser start, when they pick a mode, or when they switch to simple mode. The
  prompt has new, shorter texts, one line per choice.
- **"Dynamic DNR filtering" is now called "DNR tracking filter"** everywhere you see it: popup, right-click menu,
  its panel, and its section in Manage custom rules.
- **New: Ad leftover cleaner** (popup and right-click menu). Removes ad leftovers — empty ad boxes and banners — on
  the page you are looking at, only when you ask. It shows how many it removed; Undo shows them again, and "Keep for
  this site" hides them on every later visit (they then appear under Manage custom rules). Uses the general hiding
  rules of EasyList and AdGuard Base (including common banner sizes), respecting both lists' exceptions; on the few
  websites those lists say generic hiding breaks, it does not run and says so.
- **Site-specific cookie handling while Seamless surfing runs**, from three lists, in this order — each only adds
  websites the one before does not already handle:
  1. **AdGuard Cookie Notices** — its clicks and consent cookies, sorted into accept and decline; its hide and block
     rules are used when declining.
  2. **EasyList Cookie (uBlock Origin version)** — only for websites AdGuard does not cover and only for cookie dialogs
     uBD's own clicker does not handle.
  3. **EasyList Cookie hide and block** — only when declining, for websites AdGuard does not cover.
  Left out for safety: rules for dialogs uBD already clicks, rules whose accept/decline meaning is unclear, rules that
  reload the page, and values the scriptlet refuses anyway. Only websites in uBD's usual scope (top 1 million, covered
  countries). Nothing of this runs outside a Seamless surfing session, and a page only receives the part for its own
  website. A saved Cookie consent clicker rule always wins: none of this runs on that website.
- **Google's own cookie dialog (Google Funding Choices) is now handled by Seamless surfing** — shown by bbc.com to
  visitors in Europe and by thousands of other sites: "Consent" is clicked when accepting; when declining, "Do not
  consent" is clicked if the site offers it, otherwise the dialog is hidden (no answer means no consent).
- **"Accept, else decline" also hides dialogs no accept rule answered.** A site's accept rule can be about a different
  dialog than the one it shows (bbc.com: BBC's own banner versus Google's dialog) — the decline hide rules now always
  apply in this mode; only the decline block rules stay off where an accept rule exists, so it can still accept.
- **Seamless surfing now also declines Sirdata and Transcend cookie dialogs by hiding them** (checked live on
  kotaku.com for Sirdata). Their loaders are not blocked: Sirdata's breaks some sites, Transcend's also enforces the
  site's consent.
- **Notes on dialogs Seamless surfing does not click:** Mediavine now uses consentmanager (already handled); Schibsted
  sites (VG, Aftenposten, Aftonbladet…) use Sourcepoint from their own address, so the 10.7.16 Sourcepoint block
  applies there too (vg.no confirmed loading that file); Admiral's dialog comes with Admiral's tag, already stopped;
  Google's consent page stays out.
- **All filter lists refreshed from their sources.**

## 10.7.16
- **Fox News Admiral pop-up stopped at its source:** the Quick-fixes list now stops Fox News's Admiral loader itself
  (`abort-current-inline-script` on its `__apNoHold` marker), so it no longer matters which domain Admiral rotates to.
  None of uBlock Origin's Admiral rules work on Fox News: its loader hides the word "admiral" (URI-encoded).
- **BBC, NRC and other Sourcepoint sites: no consent dialog while Seamless surfing declines banners.** Sourcepoint
  draws its buttons inside its own iframe, where the clicker cannot reach them, so its loader
  (`wrapperMessagingWithoutDetection.js`) is now blocked instead — the same outcome as "I do not agree". Only in
  decline mode (accept mode leaves the dialog), and never on a site with a saved Cookie consent clicker rule (saved
  rules prevail), on the Allow list, switched off or marked `$worryfree`.
- **XenForo forums (e.g. malwaretips.com) recognised by Seamless surfing — always declined by hiding.** The cookie
  notice is hidden in BOTH modes, never clicked: its buttons navigate away and back, which made a saved click rule
  reload malwaretips endlessly. XenForo's own default without an answer is essential cookies only.
- **Known limit, found while testing:** rules added through Import ABP are injected after a page has started, so
  they cannot stop a script that runs early in the page's `<head>` (such as Fox News's Admiral loader). Rules that
  must run first belong in a built-in list (e.g. the Quick-fixes list).
- **All filter lists refreshed from their sources.**

## 10.7.15
- **Pickers react only to you, not to the page:** the Cookie consent clicker picker now sees your clicks before the
  web page can intercept them, and the Worry-free picker's buttons and the element picker's Escape key ignore clicks
  and key presses that a web page fakes.
- **Programming principles (v14):** new rule for anything drawn into a web page, and the security lessons from the
  10.7.13–10.7.14 review.
- **All filter lists refreshed from their sources.**

## 10.7.14
- **No more "nothing can connect" warning in Chrome's extensions page.** The setting that closed uBD to other
  extensions (added in 10.7.13) is removed again: uBD never listened to other extensions or web pages, so it added
  nothing but that warning.
- **All filter lists refreshed from their sources.**

## 10.7.13
- **Element picker and Cookie consent clicker hardened** after reviewing the uBlock Origin picker flaw (uBD was not
  affected): a picked hiding rule can no longer carry extra page styling; Cookie consent clicker rules are only saved
  for the site and frame the pick really came from, with checked names and size limits; that picker now reacts only
  to real mouse clicks and keys, not to clicks a web page fakes.
- **The Matrix panel can no longer be loaded by web pages** (it only ever opens as the extension's own page).
- **Import custom rules and Restore settings use the same checks:** a hiding rule that could carry extra page styling,
  or an invalid Cookie consent clicker rule, in an import file is skipped.
- **Closed to other extensions, stricter page rules:** other extensions can no longer send uBD messages, and the
  extension's own pages refuse plug-ins, forms and page-address tricks.
- **Cookie consent clicker:** a pick on a site whose address contains `_` or is a raw IPv6 address is now refused,
  the same as the element picker already did.
- **Programming principles:** messaging stays in JSON mode on purpose (safest format), and the notes on Chrome's
  rule-match feedback functions were corrected against Chrome's documentation.
- **All filter lists refreshed from their sources.**

## 10.7.12
- **Code tidy-up, no change in what the extension does:** the service worker's main file is organised into numbered
  sections; Save / Restore / Reset settings moved into its own file, and the steps that apply a site's on/off setting
  are now shared by the popup, the Allow list and Restore settings.
- **All filter lists refreshed from their sources.**

## 10.7.11
- **Code tidy-up, no change in what the extension does:** the filter parser is regrouped into clear, numbered
  sections with a reading guide at the top; its code is unchanged.
- **All filter lists refreshed from their sources.**

## 10.7.10
- **Code tidy-up, no change in what the extension does:** the Cookie consent clicker's picker and the Matrix panel
  are organised into clear sections and small functions.
- **All filter lists refreshed from their sources.**

## 10.7.9
- **Clean starting point after a full code audit.** No change in what the extension does.
- **Safer filter compiling:** the background now only accepts the compiler's messages from the extension's own
  compiler page, not from a website's page.
- **Code tidy-up:** the shared filter parser moved to its right place in the code structure; module descriptions,
  colour values and size notes completed.
- **Release packaging fix:** the docs package now carries the current release record instead of the previous one.
- **All filter lists refreshed from their sources.**

## 10.7.8
- **Element picker hardened.** The picker window now opens only when it receives a secret from the extension, so a
  web page can no longer start it on its own (taken over from uBlock Origin Lite).
- **Fewer ads flashing on page load.** Site-specific hiding rules are applied in the page at once instead of waiting
  for the background (uBlock Origin Lite).
- **More sites covered by rules written for "any domain of a site"** (`example.*`): every real domain of that site in
  Chrome's top-sites list is now used, for example a shop's .pl, .hu or .ro domain, instead of a fixed set of 33
  endings.
- **`$removeparam` without a value now removes the whole query** on the address it names (AdGuard's meaning), in the
  built-in lists and the Import ABP box.
- **Filter parsing fixes:** two kinds of malformed hiding rules are now rejected instead of being misread (uBlock
  Origin).
- **Windows high-contrast themes:** checkboxes, radio buttons, switches and the keyboard focus ring stay visible.
- **Quieter console:** routine "page went away" failures while applying hiding rules are no longer logged as errors;
  permission changes are handled one at a time.
- **All filter lists refreshed from their sources.**

## 10.7.7
- **AdGuard credited where its code ships.** Every file with AdGuard Scriptlets code now names AdGuard, the licence
  and the source at the top; the licence documents describe where AdGuard's code is and include a new table showing
  where the extension's code comes from. Scriptlets taken over from uBlock Origin are credited the same way.
- **Licence note corrected:** the Disconnect list (removed in 10.7.1) is no longer listed.
- **Programming principles rewritten as a manual** (Architecture, Security, Performance, Principles, Cooperation) under
  a new name, `Xplainer_Programming_principles_conscript.md`.
- **All filter lists refreshed from their sources.**

## 10.7.6
- **One filter parser.** The built-in lists are now translated by the same parser as the Import ABP box. That fixed
  list rules that were translated wrongly: about 2 500 rules lost their `^` separator (they matched too much), 720 could
  never match, 46 `$~script`-style rules also blocked whole pages, and 17 rules (mostly parameter-strip rules) were
  turned into blocks — e.g. of Prime Video, CNN, Adult Swim, FIFA+, AMC+, RTBF Auvio and Go3 playback. About 160 rules are new
  (mostly Nordic scam pages).
- **New: more list rules are used.** Regex rules that Chrome accepts (251; 106 that Chrome refuses are left out),
  `$redirect` to uBD's own empty script/video (about 350 — the request gets an empty file instead of failing, which
  some sites need), and `$denyallow`, `$to`, `$method` and `$match-case` rules.
- **`$important` list rules now win over the same list's exceptions** (about 230 rules), as their authors intend.
- **Import ABP box:** `$match-case` is now accepted on normal patterns (without capitals); rules that could not be
  applied now say so ("Your rules were saved but could not be applied: …") instead of failing silently.
- **Import ABP box: every line that cannot be used is now commented out with the reason in red beneath it** — also
  network lines (e.g. `$redirect-rule`, a redirect to a file uBD does not include, `$network`, unknown options), cosmetic
  lines (no site, several sites in one line, `#$#`, `#?#`, `$$`) and regexes Chrome refuses. Until now only scriptlet
  and `$popup` lines got this; the others disappeared without a word. The editor shows the reasons right after Save
  (before, only after reopening the dashboard), and rule limits or rules Chrome refuses are shown under the editor.
- **Fixed: Matrix panel and Fingerprint Inspector sessions now really end after 5 minutes**, also when you closed the
  panel tab yourself and the browser is idle. Before, such a session could keep running (the Inspector's probe still
  active) until something woke uBD. A probe left behind by a browser restart is removed too.
- **Filter lists: when Chrome refuses to switch a list on, you now see why** (e.g. too many lists switched on) and the
  switch goes back to off. Before, the switch showed "on" for a list that was not active. A settings restore names such
  lists too.
- **Safer: web pages can no longer reach uBD's session data.** uBD's scripts inside pages could read and change uBD's
  internal state (site modes, session states, the list of sites visited this session); only its own pages can now.
  Nothing visible changes.
- **Fixed: a failed apply of imported rules no longer blocks every later apply** until the browser restarts.
- **All filter lists refreshed from their sources.**
- **File headers:** the 53 source files that began as uBlock Origin / uBO Lite / uMatrix files now carry this
  project's name and copyright line, its home page, and a "based on …, modified in 2026" notice. Raymond Hill's
  copyright line and the GPL notice stay. No code change.

## 10.7.5
- **New: `prevent-popunder` for tab-unders.** `example.com#%#//scriptlet('prevent-popunder', 'adnetwork.com')` (or
  `example.com##+js(prevent-popunder, adnetwork.com)`) in the Import ABP box or the Quick-fixes list: when that site
  turns its own tab into an ad from adnetwork.com (while the video opens in a new tab), uBD sends the tab back to the
  site page. The site page reloads (scroll position is lost). Not applied when filtering is off for that site.
- **New: uBD's own block page.** A page that is blocked as a whole (`$document` / `$all` rules) now shows uBD's page
  ("This page was blocked", the blocked domain, a Close tab button) instead of Chrome's bare error page. A popup tab
  that a page just opened is still closed at once, as since 10.7.3.
- **Import ABP box:** `$popup` / `$popunder` lines are now commented out with the reason (they were dropped silently),
  and every `! Rejected:` line is shown in red. New info text, including the three ways to handle pop-ups and pop-unders.
- **All filter lists refreshed from their sources;** AdGuard scriptlets library updated to 2.6.0.
- Note: these features were first built in a separate 10.7.2 package (tools 2.0.41) next to the published 10.7.2 –
  10.7.4 line; that package was never released. They arrive here, on top of 10.7.4.

## 10.7.4
- **Fixed: on sites named by two or more filter lists, only one list's scriptlets ran** — since 10.6.0, on about
  1 000 sites. Example: CNN's in-video ads came back because the Quick-fixes CNN scriptlets never ran behind AdGuard
  Base's own CNN scriptlets; also billboard.com, deadline.com, androidpolice.com and others. All lists' scriptlets now
  run on every site they name. Cost: on sites that have scriptlets, a few milliseconds more per page load (measured
  8-11 ms); all other sites are unchanged.

## 10.7.3
- **Fixed: trackers such as bat.bing.com and c.bing.com are blocked again.** About 1 270 list lines that only meant
  "don't hide page elements on this site" (`$generichide`, `$genericblock`, `$specifichide`) were turned into "allow
  everything to this site, from every site" — e.g. all of bing.com. They are now ignored, as on import already. Ads a
  list blocks on those sites' own pages can now be blocked too.
- **Fixed ahead of time: filters with `$inline-script`, `$inline-font` or `$webrtc` are ignored** (built-in lists and
  imports alike). Before, an imported `||site^$inline-script` became a block of everything on that site. No current list
  uses them, so nothing changes today.
- **New: a popup tab whose page uBD blocks is closed at once** — no more empty "blocked by an extension" tab, also
  when the popup first opens empty and loads the ad a moment later. Normal links that open a new tab are not touched.
- **Cleanup: 10 cosmetic exception lines that were wrongly turned into (never-matching) network rules are gone.**
- **Options tab:** the note at the bottom now says only the safer-regions protections moved to another extension.
- **All filter lists refreshed from their sources.**

## 10.7.2
- **Fixed: ad popups to hosts the filter lists mark "block everything" (`$all`) now get blocked.** Example: a page
  opening an s.pemsrv.com ad in a new tab. Those list rules were silently dropped before; about 500 are now active
  (AdGuard Base, French, German, Nordic and other language lists). Opening such an address yourself is blocked too, as
  the list authors intend.
- **Fixed: importing a `$popup` filter no longer blocks a whole site.** A line like `*$popup,domain=example.com` used to
  block every request on example.com; `$popup` / `$popunder` filters are now ignored on import, as in the built-in lists.
- **Slightly less work per loaded frame for custom scriptlets** (the allow-list is only consulted when a rule matches).
- **All filter lists refreshed from their sources.**

## 10.7.1
- **"Worry-free surfing" is now called "Seamless surfing"** (screens and texts only; existing settings and your
  `@@example.com$worryfree` Allow list lines keep working unchanged).
- **Seamless surfing can now accept or decline cookie banners.** The Seamless surfing prompt offers Cancel / Accept
  cookies / Decline cookies; the choice is remembered (default: decline) and also used when it starts at browser start.
  The prompt is shown once after this update so you can choose.
- **The popup shows one line: "Seamless surfing mode - accept" or "- decline".** Clicking it reopens the prompt to change
  the choice. The time options (20 min / 60 min / until next session), the countdown and the "don't do purchases or
  banking" warning are removed; Seamless surfing is switched off only with its browser-start option.
- **Disconnect (Cryptomining, Fingerprinting) list removed.** Its categories mixed real fingerprinters with sign-in,
  payment and captcha code; most of its trackers are also in the remaining lists.
- **New hidden list: AdGuard's own exceptions for the Seamless surfing tracker lists** (Kees1958, Peter Lowe, AdGuard
  tracking servers), so pages AdGuard knows those lists break keep working. Only for popular sites in our regions.
- **Fixed:** in rare cases Seamless surfing did not start at browser start.
- **Third-party licences updated** (shorter filter-list section; Disconnect removed).
- **All filter lists refreshed from their sources.**

## 10.7.0
- **New language filter: "English language filter for websites outside top 1 Million".** Ad, tracker and anti-adblock
  rules for less-visited English sites: sites under English-speaking country codes (.uk, .ie, .mt, .ca, .us, .au, .nz
  and other English-speaking countries and territories) from AdGuard Base, and generic-TLD sites (.com, .net, .org …)
  from the anti-adblock list. The rules come out of AdGuard Base and the anti-adblock list, so nothing is loaded twice.
  Rules that keep a site working (allow rules) stay in AdGuard Base for everyone.
- **Switched on automatically when English is the browser's first language** — at install, and once on this update
  for existing users. Switching it off afterwards is respected.
- **Fingerprint Inspector: three new tracking signals**, each with a website-specific Select:
  - "Tracking pings" — links that send a hidden request when clicked. Select removes the ping; the links keep working.
  - "1x1 frames" — invisible frames of at most 1×1 pixel. Select stops frames from that one address on that site.
  - "1x1 and 3x3 images" — tracking pixels, also ones never added to the page. Select stops images from that one
    address on that site.
- **Fingerprint Inspector: the signal checkboxes are ordered low, medium, high risk**, each group ending with an
  "[all low risk]" / "[all medium risk]" / "[all high risk]" marker; Tracking beacons is the last one.
- Includes everything from the unpublished 10.6.5 below.

## 10.6.5 (zipped, never published — included in 10.7.0)
- **Anti-adblock now keeps working when AdGuard Base is switched off.** AdGuard Base's own anti-adblock rules moved into
  the separate "AdGuard and EasyList anti-adblock" list. Rules for sites of a country that has a language filter go into
  that language filter instead (the same way the EasyList per-language anti-adblock files already did), so they follow
  that language filter.
- **The anti-adblock list now only carries site rules for popular sites in our regions** (top 1 million sites, in-scope
  TLDs and country codes). Rules for sites outside that set are left out; rules that are not tied to a site stay.
- **Block Admiral anti-adblock now also includes uBlock Origin's Admiral site fixes** (renamed "Block Admiral anti-adblock
  (EasyList, HaGeZi, LanikSJ and uBlock Origin)").
- **Fixed: hide rules on some sites in the Bulgarian, Latvian and Nordic filters did not work at all.** uBlock Origin-style
  page-script lines were stored as hide rules, which made the browser ignore every hide rule of those sites. They now run
  as the page scripts they are.
- **Fixed: the Matrix panel's BLOCKED/NOT BLOCKED view** now updates after a settings restore, ignores your own rules that
  only block some request types, and respects your own allow (`@@`) rules.
- **Popup:** the red "off" text and the "pause filtering" button are easier to read in light mode.
- **Scriptlets that edit a page's data (the json-edit family) are no longer accepted from any source.** json-prune stays.
- **Clean-up:** the empty leftovers of the removed security scriptlets (including the stored security allowlist, which is
  removed on the first start) and other unused code were removed. An older settings backup still restores.
- **All filter lists refreshed from their sources.**

## 10.6.4
- **Fixed: the Matrix panel could show a domain as "allowed" even when a custom rule you saved via
  "Import ABP rules" was genuinely blocking it.** Real case: `||sentry.io^$domain=nos.nl`, saved and
  confirmed working in Chrome DevTools (status `blocked:other`), still showed sentry.io as not-yet-blocked
  in the Matrix panel, with "No rules... apply to this domain" in its detail view.
- **The blocking itself was never broken** — this was purely the panel's own display. It only ever checked
  the bundled filter lists and its own click-to-override rules; it had no way to see a rule you added
  yourself. Fixed in two places: the per-domain detail view now also lists your own saved rules, and the
  "already blocked" check (used by the SHOW BLOCKED/SHOW ALLOWED filter and the BLOCKED/NOT BLOCKED tooltip)
  now also recognizes them, scoped to the exact site the rule applies to.
- **All bundled filter lists refreshed from upstream** (AdGuard, EasyList, HaGeZi, and the rest) — same
  version number, per explicit request; this is a precompiled-filters-only refresh packaged together with
  the Matrix panel fix above, not a separate release.
- **One personal list issue found, not fixed here**: a line in your own hand-maintained quick-fixes list
  (`badfilter-quick-fixes.txt` on GitHub) — `||cdn-ster-nl.akamaized.net/*.mp4$redirect=noopmp4-1s,domain=nos.nl`
  — isn't valid for that list (it only accepts `$badfilter` lines, not `$redirect=`), so the build correctly
  dropped it and reported it rather than silently ignoring it. Worth fixing at the source if that rule still
  matters to you.
- **No setting, storage key or message type changed.**

## 10.6.3
- **Removed 14 more domains from the built-in whitelist**, following a deeper cross-check against the sibling
  3P-Matrix-lite project's own (more rigorous) whitelist review:
  - Dead services, kept on the list for no reason: `bluejeans.com`, `skype.com`, `chime.aws`, `starplus.com`.
  - User-upload / content risk, same class as the 10.6.2 fix: `slack.com`, `whatsapp.net`, `telegram.org`,
    `roblox.com`.
  - Redundant or pointing at the wrong host: `accounts.youtube.com` (already covered by `youtube.com`),
    `pingidentity.com` (actual sign-in runs on `pingone.com`).
  - Overly broad with no real effect: `gov.br`, `sii.cl`, `afip.gob.ar`, `sat.gob.mx` — each covers thousands
    of unrelated government sites, and their tax/ID checks run server-side, never in the browser.
- **Not removed**: ~30 official gaming-publisher domains (Xbox, EA, Nintendo, etc.) and 3 messaging apps
  (WhatsApp, Signal, Viber) that the 3P-Matrix-lite review also flagged. Those were rejected there only because
  they don't fit as *embeddable widgets on another site* — uBD's whitelist covers trusted apps visited
  directly, a broader and still-correct category for uBD's own purpose, so they stay.
- **No setting, storage key or message type changed.**

## 10.6.2
- **Removed 6 domains from the built-in whitelist (full filter-list bypass + Worry-free exemption) that no
  longer belong there:** `discord.com`, `discordapp.com`, `discordapp.net`, `itch.io`, `steamcommunity.com`,
  and OpenAI's `openai.com`/`auth.openai.com`/`auth0.openai.com`.
- **Why:** these were all ported years ago from the sibling 3P-Matrix-lite project's own built-in whitelist.
  3P-Matrix has since deliberately removed the first five for real, specific reasons — Discord's attachment
  and media CDNs serve arbitrary user-uploaded files unchecked (a real malware report), itch.io lets anyone
  upload executables, and steamcommunity.com is a user-generated, heavily-phished gaming domain. `openai.com`
  was dropped from 3P-Matrix's "Identity / SSO" treatment because it isn't a sign-in/CAPTCHA/video/library
  domain at all — it never fit that bypass category to begin with.
- **`discord.gg` is unaffected** — it's an invite-link shortener only, with no attachment/media delivery, so
  the reason for removing the other three Discord hosts doesn't apply to it.
- **Effect:** these 7 domains (6 hosts plus the two OpenAI subdomains) are now scanned like any other site
  instead of auto-trusted. This is a protection tightening, not a regression — no setting, storage key or
  message type changed.

## 10.6.1
- **"Privacy Inspector" wording fix: the "Privacy (scriptlet) rules" section in Manage Custom Rules is now
  "Anti-fingerprinting scriptlets"** — this was missed in the earlier "Privacy Inspector" → "Fingerprint Inspector"
  rename. Text only; nothing about how the rules work changed.
- **HaGeZi list relabelled**: "HaGeZi's Multi light (known trackers & top sites)" → "HaGeZi's Multi light (known
  trackers on top-N sites)".
- **Top-25 adult-site protection now also covers HaGeZi's own tracker/ad hosts on those sites** (e.g.
  ads.pornhub.com), shipped in the always-on annoyances list — previously these were only blocked while HaGeZi's
  Multi light was separately enabled; now the protection applies either way.
- **No setting, storage key or message type changed.**

## 10.6.0
- **Performance: pages load faster on sites your filter lists don't specifically target.** Scriptlet protection now
  loads in three parts instead of one — only the one list's own data for a site it actually names, a much smaller
  part for everywhere else, and (new) each enabled filter list keeps to its own data instead of sharing one
  combined file. Measured about 75-85% less script data loaded on an average (non-targeted) page; a site that IS
  specifically targeted (e.g. one with an anti-adblock script) is unaffected. The Matrix panel also no longer keeps
  watching network requests while closed, so the extension can go idle between uses.
- **Performance: the toolbar icon updates once per navigation instead of twice** (previously two separate checks
  could occasionally disagree, which could show the wrong icon or momentarily hide the block count).
- **Performance: custom scriptlet rules (Custom Rules editor, ABP-import, Fingerprint Inspector) no longer cost the
  extension a large one-time parse on every browser start.** The ~600 KB combined scriptlet library now loads only
  the one small file an actual rule needs, exactly when it's needed.
- **Already-open tabs now pick up scriptlet protection right after a browser restart or an update**, instead of only
  on their next reload.
- **No setting, rule or behaviour changed** — same protection, loaded more efficiently.

## 10.5.5
- **HaGeZi list: back to HaGeZi's own Multi light, narrowed to known trackers and top sites** (replaces Chris Buijs'
  TOP-N version). Renamed in the Filter (block) lists tab to "HaGeZi's Multi light (known trackers & top sites)".
  **Behaviour you will see:** this row blocks about 25,500 domains instead of about 34,100 (7 DNR rules instead of 9),
  and catches more of the trackers real pages load; your on/off choice for the row is kept.
- **Full filter update:** every filter list refreshed from its live source.

## 10.5.4
- **Full filter update (normal review):** every filter list refreshed from its live source, including the hide rules,
  scriptlets and AdGuard remove-param rules that the 10.5.3 SAFE update had to leave out. No setting changes.
- **"Privacy Inspector" is now called "Fingerprint Inspector" in the UI** (popup menu, right-click menu, the panel's
  title, warning line and "paused" text). UI only: code, file names, message types and storage keys keep the old
  `privacy-inspector` names, so nothing changes for saved rules.

## 10.5.3
- **SAFE filter update (skip-review) against the published 10.5.2:** network rules refreshed from their live sources
  for AdGuard Base, AdGuard German, annoyances, Anti-Admiral, Quick-fixes, HaGeZi Multi light (TOP-N) and Peter Lowe.
  Hide rules, scriptlets and AdGuard remove-param changes wait for the next normal release.

## 10.5.2
- **HaGeZi list replaced by Chris Buijs' curated TOP-N version of HaGeZi's Multi light**, renamed in the Filter (block)
  lists tab to "HaGeZi's Multi light (TOP-N curated only DNR)". **Behaviour you will see:** this row blocks about 33,600
  domains instead of about 71,000 (9 DNR rules instead of 18); your on/off choice for the row is kept. Credited in
  THIRD_PARTY_LICENSES.md.
- **Full filter update:** every filter list refreshed from its live source.

## 10.5.1
- **The hidden, always-on "AdGuard Base — adult-site network rules" list is removed.** Every rule it had (AdGuard's and
  EasyList's rules for the top-25 adult sites, the `_xa/ads` rules and the third-party websocket block on those sites,
  plus its hide rules) now ships in **"AdGuard and EasyList annoyances"** instead. **Behaviour you will see:** nothing
  while annoyances is ticked (the default); unticking annoyances now also switches these adult-site rules off.
- **Options tab notice clarified:** it now says which protections moved — the Worry-free protections and the
  safer-regions protections are in "3P Matrix — content firewall"; Worry-free surfing here still enables the extra
  filter lists and cookie-consent dismissal. The same text is shown when the Allow list drops a `$saferegions` line.
- **Full filter update:** every filter list refreshed from its live source.

## 10.5.0
- **Options tab tidied:** the "Worry-free surfing" and "Security enhancements" headings are removed.
- **"Block sending (tracking) ping" removed** — low standalone value (most tracking now goes through
  mechanisms it never covered).
- **"Enable Worry-free surfing" moved into the same group as the "at browser start" clears below it**,
  which is now headed **"On startup"** (was "Safe privacy enhancements", then "Privacy enhancements").
  Row labels no longer repeat "at browser start" since the heading already says it once.
- **Eight opt-in "at browser start" clears**, each its own checkbox (OFF by default, remembered,
  included in settings export/import): list of downloaded files, data typed into search/form fields,
  HTTP cache (renamed from "cache" to make clear it's the page cache, not cookies or site storage),
  cookies (you'll be signed out everywhere on the next start), app cache storage (service-worker/PWA
  storage — distinct from HTTP cache), site databases (IndexedDB), site storage (localStorage), and
  site service workers. Passwords are never touched by any of these.
- **Startup reliability fix:** the "clear ... at browser start" and Worry-free-startup features
  depended solely on `browser.runtime.onStartup`, which can fail to fire on some restarts.
  `chrome.storage.session` (cleared only on a genuine browser close) now backs it up as a second,
  independent trigger.
- **Disconnect's "Advertising" category dropped** from the "Disconnect" Worry-free list, now labelled
  "Disconnect (Cryptomining, Fingerprinting)". **Behaviour you will see:** about 315 ad-tech companies (roughly
  445 domains) that were not already blocked by any other list you have enabled are no longer blocked via this
  toggle (Cryptomining and Fingerprinting protection is unchanged). Full filter update run afterwards, including
  Kees1958.
- **Name:** "uBlock Dynamic — ad blocker" (same dash as "3P Matrix — content firewall").
- **"Worry-free safe surfing" is now called "Worry-free surfing"** everywhere (popup, dashboard, in-page notices).
- **Dashboard tabs:** "Filter (block) lists" is the first tab and opens by default; order is now Filter (block) lists,
  Import ABP rules, Manage custom rules, Allow (white) list, Options. "Privacy & Security" is renamed **Options**.
- **"Enable Worry-free surfing at browser startup" moved to the Options tab**, without the "(I understand that it can
  break website functionality)" note. **It is now ON by default, also for everyone updating from an older version,
  whatever was set before** (and when restoring a settings file from before 10.5.0). Switching it off afterwards sticks.
  **Behaviour you will see:** after the next browser restart Worry-free surfing starts on its own.
- **Full filter update:** every filter list refreshed from its live source.
- **Lighter browser start:** a normal browser start is no longer handled as if the extension had just been updated.
- **Old upgrade code removed** (for versions before 10.0.7, 10.3.0 and 10.4.5). **Behaviour you will see:** only when
  updating from such an old version or restoring a settings file made with one — old choices for retired filter lists
  (e.g. Lithuanian) are no longer carried over, and there is no "protections moved to 3P-Matrix" pop-up on restore.
  Unknown settings in storage or in a restored file are simply ignored and cleaned up.
- **Privacy Inspector:** the "Device & network" tooltip no longer mentions a 5-signal threshold that no longer exists;
  the timer's start value follows the real session length. Its timers (and the Matrix panel's) now stop when the
  session ends.
- Docs: programming principles updated — a principles check (eight gate items) before every release package
  (prepared as 10.4.10, never packaged; included here).
- Source: 10.4.10 working tree = 10.4.9 + docs (tools 2.0.27).

## 10.4.9
- **Full filter update (normal review):** every filter list refreshed from its live source, including the hide rules,
  scriptlets and the AdGuard remove-tracking-parameters list that the SAFE updates 10.4.7/10.4.8 left out.
- **Geographic scope:** `.su` (old Soviet Union code, mostly Russian sites) is now out of scope like `.ru`; ten
  overseas territories outside Europe, the Americas and Australia/New Zealand are out of scope as a separate category
  (Réunion, Mayotte, New Caledonia, French Polynesia, Wallis & Futuna, French Southern Territories, American Samoa,
  Guam, Northern Mariana Islands, Pitcairn). The kept generic-use codes and territories are now listed explicitly
  (adds .io, .cc, .sh, .ac, .nu as generic). **Behaviour you will see:** no blocking or hiding on those sites any
  more (HaGeZi Multi light: 73 fewer domains). Full overview: `GEOGRAPHIC_SCOPE.md` (new, docs).
- **Adult sites:** the always-on adult list is now the owner's ranked top 25 (freepornvideos.xxx added). EasyList
  adult rules that name one of these 25 sites are included even when the general shape check would drop them
  (4 rules today, incl. EasyList's websocket block on pornhub, redtube, tube8 and youporn; a regex and a `$rewrite`
  rule cannot be compiled). **New:** websockets to OTHER domains are blocked on all 25 sites (ad networks push ads
  over them); the sites' own live cams and chat keep working.
- **Language filters: cookie banners hidden.** EasyList Cookie International's per-language hide rules are now part of
  each language filter (no separate setting; on when that language filter is on): about 2,800 rules for 26 languages,
  out-of-scope languages left out. Not limited to the top-1M sites (owner's decision: non-English sites rarely reach
  it). Banners are hidden without answering them; a Cookie consent clicker rule still clicks a hidden banner.
- **Cookie consent clicker rules always win over Worry-free's auto-decline.** On every site with a clicker rule (yours or
  built-in) the auto-decline no longer runs, also not in that site's consent-banner frames. No delay on other sites.
- Source: 10.4.8 (tools 2.0.27).

## 10.4.8
- **SAFE filter update (skip-review).** Ten filter lists refreshed (network rules only): AdGuard tracking servers,
  Peter Lowe, annoyances, HaGeZi Multi light, AdGuard Base, AdGuard German, AdGuard Spanish, EasyList Nordic,
  AdGuard anti-adblock, Anti-Admiral. Hide rules, scriptlets and the AdGuard remove-tracking-parameters list are not
  part of a SAFE update and follow with the next normal release. Source: 10.4.7 (tools 2.0.26).

## 10.4.7
- **SAFE filter update (skip-review test).** Only the Kees1958 most-used EU+US ads & tracking networks list
  was refreshed (454 → 515 domains); every other file is byte-identical to the published 10.4.6.
  Accepted by the Chrome Web Store as a skip-review update — the first one. Source: 10.4.6 (tools 2.0.26).

## 10.4.6
- **Chrome Web Store rejection fixed (remotely hosted code, "Blue Argon").** An AdGuard French rule for supersoluce.com
  created a `<script>` that loaded code from cdn.viously.com. Such rules are no longer shipped or run.
- **New scriptlet policy, enforced in the build, the check suite and the extension itself:**
  scriptlets that need trust (`trusted-*`) only from AdGuard's own filter lists; no scriptlet that creates a
  `<script>` with code; no scriptlet that inserts an external URL into a page.
  **Behaviour you will see:** 114 site-specific scriptlet rules fewer (71 trusted rules from non-AdGuard sources,
  41 code rules, 2 external-URL rules); on some of those sites an anti-adblock notice or a banner may return.
  Own rules (Custom Rules, ABP import) with a `trusted-*` scriptlet are refused, and an existing one no longer runs.
- **Japanese and Korean filters removed**; Japan and South Korea are out of the geographic scope again (also in
  AdGuard Base and every other list), and Japanese/Korean services were removed from the built-in whitelists.
  A stored on/off choice for the two filters is cleaned up.
- **Bug fix:** a filter list's scriptlet file that was no longer generated stayed in the package
  (`ruleset_adguard_balkan-scriptlets.js` in 10.4.5); the build now removes such files.
- Correction to 9.8.0: that entry said AdGuard's `trusted-*` scriptlets were not accepted. That was not true — the
  exclusion list was never enforced and did not name them. It is enforced from 10.4.6 on.
- All filter lists refreshed. Source: 10.4.5 (rebuilt, tools 2.0.25).

## 10.4.5
- **Scriptlets load faster: one shared scriptlet library instead of a copy per filter list.** Every scriptlet
  function (65 from AdGuard, 2 of the project's own) now ships once; each filter list keeps only its own site data,
  and all enabled lists run in one registration. Scriptlet files 2.91 MB -> 1.10 MB; per page and frame about
  32.5 -> 24.4 ms with the default lists, 36.8 -> 23.8 ms with one language list on (node/V8 timing). Proven to make
  exactly the same scriptlet calls as before on every one of 52,398 tested hostnames (same filter data).
- **Bug fix: the `prevent-element-src-loading` scriptlet works again.** It received a number as its name, which made
  its marker step fail with an error. **Behaviour you will see:** on the 488 sites the filter lists use it for
  (227 rules), the specific ad images, scripts or frames it targets are now blocked.
- **Geographic scope re-installed (owner's decision).** Rules are kept only for websites in Europe (except Moldova,
  Belarus, Ukraine and Russia), North, Central and South America, Australia, New Zealand, South Korea and Japan —
  in every filter list, for hide rules, scriptlets and network rules (ad servers on out-of-scope country domains too).
  Domains used worldwide stay: .tv .to .ws .fm .pw .st .la .so .ly. Domain names in a non-Latin script are dropped,
  except Japanese, Korean, Cyrillic and Greek; non-Latin country domains (.рф …) follow their country.
  **Behaviour you will see:** about 2,900 blocked domains and 1,900 sites with hide rules fewer (mostly Russia,
  Ukraine, India, Turkey, Indonesia).
- **Balkan filter** (replaces the Bulgarian filter, which keeps working for anyone who had it on): Albania, Bosnia and
  Herzegovina, Bulgaria, Croatia, Greece, Kosovo, Montenegro, North Macedonia, Romania, Serbia and Slovenia, each shown
  as its own country ("Country (language)") in the Language filters list. New sources: Dandelion Sprout's Serbo-Croatian List, Macedonian
  adBlock Filters, ROad-Block (light), plus AdGuard Base's sections for these countries.
- **Baltic states filter** (replaces the Latvian and Lithuanian filters; an "on" choice for either carries over):
  Estonia, Finland, Latvia and Lithuania, each shown as its own country. New source: Finnish EasyList addition.
- **Czech & Slovak** and **Nordic** filters are now also shown per country: Czechia, Slovakia; Denmark, Iceland,
  Norway, Sweden (Sweden's own rules moved into the Nordic filter). Anyone who had them on gets all their rows.
- **Language filters are listed by language** ("German language", "Albanian language" …), without source names;
  only Bosnia and Herzegovina and Kosovo, where several languages are spoken, are listed by country name.
- **First install picks language filters from all the browser's languages**, not only its interface language. Only
  when none of them has a filter, the country (from the time zone, else a language tag's region) decides, and every
  language spoken there is switched on (an English browser in Switzerland gets German, French and Italian). Only a
  country's OFFICIAL languages count: a US browser no longer switches on the Spanish filter (Spanish isn't official
  there); a browser in Puerto Rico does, plus English.
- **New Hungarian filter** (hufilter & AdGuard).
  **Korean filter** now also carries AdGuard's own Korean rules.
- **Full filter-data refresh** (all lists re-fetched; Tracker Radar not refreshed).
- Tools 2.0.24 (shared scriptlet library, geographic scope, combined country filters, and their checks). The
  10.4.5 packages first handed over (with tools 2.0.23) were never published and are replaced by this rebuild.

## 10.4.4
- **Full filter-data refresh, full normal-review release** — every pending list re-fetched and recompiled:
  Peter Lowe, HaGeZi Light, AdGuard Base/German/French/Spanish/Japanese, EasyList Korean, Polish, Nordic,
  AdGuard anti-adblock, Block Admiral — including cosmetic (CSS hide-rule) and scriptlet data, and the unsafe-rule
  companions (`ruleset_adguard_base_removeparam`, `ruleset_adguard_french_removeparam`,
  `ruleset_adguard_japanese_unsafe`, `ruleset_easylist_korean_unsafe`) that a SAFE-only update has to leave out.
  Supersedes the 10.4.1–10.4.3 line of attempts, none of which were ever accepted by the real Chrome Web Store as
  a skip-review submission (see `SAFE_UPDATE_INVESTIGATION.md` in the project docs) — this is deliberately a full,
  normal-review release so that, once published, it becomes a confirmed, Google-verified baseline for the next
  SAFE-update attempt.
- **Stable, content-derived DNR rule ids** (`tools/build/list-parser.mjs`) — rule ids were previously assigned by
  array position, so a single upstream list edit could shift the id of every rule after it even when their content
  never changed (measured: an 8-rule net change in `ruleset_adguard_base.json` showed as 6752 added + 6744
  removed — 77% of the file). Ids are now a deterministic hash of each rule's own condition+action, so an
  unchanged rule keeps the same id release after release. Does not change extension behavior — ids carry no
  matching semantics in DNR — only what a future release's diff looks like.
- Tools 2.0.22 (the id-stability fix above).

## 10.4.2
- **Routine filter-data refresh** — every upstream filter list re-fetched and recompiled against current content.
  No code or mechanism changes; `tools/` itself is untouched this round. Notable upstream movement: French DNR
  rules 4435→4437, Spanish 1176→1177, Portuguese 443→444, Block Admiral (HaGeZi/EasyList/LanikSJ) picked up 2 more
  distinct domains.

## 10.4.1
- **Extension name changed** from "uBlock Dynamic" to "uBlock Dynamic - ad blocker", by explicit request.
- **Adult-site rule sources no longer stack on the same site.** When AdGuard's own `general_url.txt` already has a
  dedicated rule block for a given adult-site domain, the three uAssets general-purpose lists' matching content for
  that same domain is now skipped — avoiding two differently-sourced rule sets (competing cosmetic selectors,
  overlapping-but-not-identical network rules) targeting the same site at once. AdGuard's own coverage always wins;
  only sites with no AdGuard-direct coverage get content from the uAssets sources. Every other matched site is
  unaffected. No real conflicts existed in this build's actual data (confirmed: the sites AdGuard already covers
  and the sites the three uAssets sources matched didn't overlap), but the guard is in place for the next upstream
  refresh where they might.
- Tools 2.0.21: `tld-scope.mjs`'s `extractAdultSiteRules()` now also returns `coveredDomains`; `extractDomainScopedAdultRules()` gains an optional `skipDomains` parameter; `filter-lists.mjs` wires the two together.

## 10.4.0
- **`fullvideosporn.com` added to the adult-sites list** (hidden, always-on `ruleset_adguard_base_adult`), by
  explicit request.
- **AdGuard Base's hidden adult-site ruleset now also pulls in domain-matched content from three
  uBlockOrigin/uAssets general-purpose lists** (`filters.txt`, `ubol-filters.txt`, `filters-2026.txt`) — these lists
  are not adult-specific (YouTube fixes, misc site patches), so only the lines that actually target a curated
  adult-site domain are kept; everything else in them is discarded and never shipped. Wildcard host entries
  (`pornhub.*`) are resolved to their real domain (`pornhub.com`) before matching.
- **Bug fix, found and fixed before this ever shipped:** the matching above initially also pulled in uBO's native
  `##+js(name, args)` scriptlet-call syntax, which this codebase's cosmetic parser cannot distinguish from an
  ordinary (non-functional) CSS selector — it only recognizes AdGuard's `#%#//scriptlet(...)` marker. Those lines
  are now skipped (reported at build time), instead of silently compiling as inert text. Plain cosmetic hide-rules
  and network rules from the same three lists are unaffected.
- **Note:** EasyList's own `easylist_adult/adult_specific_block.txt` was investigated as a fourth candidate source
  but was not added here — it already feeds `ruleset_annoyances` whole (not domain-filtered) via the existing
  Worry-free "AdGuard and EasyList annoyances (specific websites only)" mechanism; adding it again here would have
  duplicated that, not extended it.
- Tools 2.0.20: `tld-scope.mjs` gains `extractDomainScopedAdultRules()`; `adult-sites.mjs` gains the new domain;
  `filter-lists.mjs` wires the three new sources into `ruleset_adguard_base`'s existing adult-rule pre-pass.

## 10.3.0
- **Several Worry-free and Privacy & Security protections removed — moved to a separate extension.** On the Filter
  (block) lists tab, the two tier checkboxes ("Enable the extra Worry-free safe surfing protections" and "Enable the
  extra 'safer regions' protections additionally") and the per-domain exceptions note below them are gone. On the
  Privacy & Security tab, everything from "Security enhancements" onward is gone: payment-handler blocking, Web
  Bundle blocking, dialog-scam blocking, the whole "Very low website breakage risk" group (local-network access,
  protocol handlers, suspicious 3P-requests, ClickFix clipboard, strict eval+fingerprint block on high-risk sites),
  the whole "Low website breakage risk" group (microphone/camera/screen/clipboard, Bluetooth/Serial/HID/USB,
  fingerprinting, obfuscated-eval, page-redirect/dialog blocking outside safer regions), and the editable "safer
  region" TLD list. **Behaviour you will see:** those checkboxes and the TLD editor are gone from both tabs; a
  settings file restored from an older version that still has one of them switched on shows a one-time popup saying
  the protections moved to "3P-Matrix — content firewall" (available in the Chrome Web Store), and an update from an
  older install quietly cleans up any leftover block rules from these protections the first time it starts.
- **Kept, unchanged:** "Clear browsing history at browser start" and "Block sending (tracking) ping" (still under
  "Safe privacy enhancements"), the five Worry-free filter-list toggles (AdGuard tracking, Disconnect, Kees1958,
  Peter Lowe, AdGuard remove-param) and "Automatically start a Worry-free session every time the browser starts" —
  and the `$worryfree` per-site exemption itself, in the Allow list, quick-fixes list and ABP-import editor alike.
- **`$saferegions` retired from the Allow list, quick-fixes list and ABP-import editor.** `$worryfree` lines are
  unaffected. **Behaviour you will see:** a saved `@@domain$saferegions` line is silently dropped on the next save,
  with a status message naming how many lines were removed and that the protections moved to 3P-Matrix.
- **Bug fix, found while rewriting the Worry-free routes for this change:** the five Worry-free filter-list toggles
  now take effect immediately when switched — before, a toggle only applied starting with the next Worry-free
  session, so switching one off mid-session kept blocking until you restarted the session.
- **Matrix panel** now states, in capitals, that its filtering only ever applies to the website you are currently on
  — it was never global, but nothing on the panel said so.
- Tools 2.0.19: test and check scripts across the suite updated for the above removal (parser, DNR-rule, CRUD-lifecycle
  and dry-run coverage re-scoped to what still exists); no build-output change.

## 10.2.1
- **Disconnect is now downloaded by every filter update** (before, it came from a file a manual step had to refresh — it was
  out of date). From now on a skip-review (SAFE) filter update refreshes it too.
- **DuckDuckGo Tracker Radar refreshed** (Matrix panel "Known tracker" column: 2,034 domains, was 2,103), now with a
  one-command refresh for every normal release.
- **AdGuard filters keep their own redirect rules.** Every list AdGuard curates (AdGuard Base with its hidden country parts
  and adult-site rules, AdGuard anti-adblock, the AdGuard language filters) has its own companion for unsafe rules, so none
  is dropped. **Behaviour you will see:** on go3.ee (an Estonian streaming site) AdGuard's video-ad redirect rule now works.
- **Privacy & Security tab:** the Bluetooth/Serial/HID/USB row moved up to second place in the Low group; "Block pop-ups
  and page redirects" is now called "Block page redirects and dialog pop-ups" (it never blocked pop-up windows; it blocks
  frames redirecting the page and alert/confirm/prompt dialogs). Tooltips corrected: the high-risk (adult) row described a
  third-party block that no longer exists; the fingerprinting row now lists all five details it protects (including the
  NFC reader); obfuscated payloads names the pages and the internal whitelist it skips; small additions on three more rows;
  spelling ("country codes", "TLDs").
- All filter lists refreshed. Normal release (new rulesets), not a SAFE update.
- Tools 2.0.18: Disconnect fetched by the main build (manual pre-step removed), `npm run update:tracker-radar`.

## 10.2.0
- **One whitelist, one treatment.** Every trusted whitelist site (payment, sign-in, CAPTCHA, apps, JS libraries, video
  embeds) is now also outside Worry-free altogether, as if written as `@@site$worryfree`. **Behaviour you will see:** about
  45 library and video-embed domains (BBC, Vimeo, Twitch, JW Player, Brightcove, YouTube image hosts and others) no longer
  get any Worry-free protection, also inside their frames — before, they were allowed past the filter lists but the
  Worry-free protections still applied, which broke them.
- **New GREY list** for hosts where anyone can publish code or files (jsDelivr, unpkg, esm.sh, the npm registry, Google
  Cloud Storage, Firebase Storage): they are no longer trusted. **Behaviour you will see:** a file there that a filter
  list or protection blocks is now really blocked; the sites themselves are not blocked.
- **googleapis.com is no longer whitelisted as a whole.** Only `ajax.`, `maps.`, `translate.` and `fonts.googleapis.com`
  stay trusted. **Behaviour you will see:** filter rules for Google ad and telemetry APIs (`googleads.`, `imasdk.`,
  `telemetry.` … `.googleapis.com`) now work — fewer video ads; the lists' own exceptions keep video players working.
- The regional sign-in and payment services (DigiD, iDEAL, BankID, PayPay, Toss, Mercado Pago …) and the Microsoft/Apple
  sign-in hosts joined the whitelist itself. **Behaviour you will see:** the five Microsoft/Apple sign-in hosts are now
  allowed automatically in the Matrix panel (were "review first", yellow).
- **"Block suspicious 3P-requests" now also uses HaGeZi DynDNS** next to Kees1958 Suspicious websites (about 1 600
  free-hosting/DDNS domains instead of 561). It is a precompiled ruleset now, so future refreshes can be skip-review updates.
- **Skip-review (SAFE) updates for all filters:** a SAFE update refreshes every safe filter list at once and leaves
  everything else byte-for-byte the published version; packaging checks the result automatically. Unsafe rules (redirect,
  header rules) live in separate companion rulesets for AdGuard Base, remove-parameters, all country filters and the
  Quick-fixes list; other lists may not carry them (dropped with a warning — none today). Quick-fixes `$worryfree` /
  `$saferegions` lines are now part of the list's own ruleset, so adding one is a SAFE update too.
- The Kees1958 EU+US list is now downloaded by every full update (before, a separate manual step could leave it stale).
- **All filter lists refreshed** from their live sources (Disconnect and Tracker Radar not refreshed: both need a separate
  manual input). This is a normal release, not a SAFE update (code changed and rulesets were added).
- Tools 2.0.17: new suite steps 54 (whitelist levels) and 55 (unsafe rules only in companions).

## 10.1.9
- **CNN video ads: the two Quick-fixes rules now ship.** Your Quick-fixes list lines `cnn.com#%#//scriptlet('disable-fave-ssai')` and `cnn.com#%#//scriptlet('stub-window-object', 'AdFuel', 'queueRegistry,destroySlots', '500')` are compiled into a new file, `ruleset_badfilter_quickfixes-scriptlets.js`. You tested both through ABP-Import first.
- **Behaviour you will see:** on cnn.com, video clips and live streams come without stitched-in ads, and CNN's ad-slot manager stops creating display-ad slots. Nothing changes on other sites.
- **All filter lists refreshed** from their live sources (Tracker Radar not refreshed). This is a normal release, not a skip-review "safe" update: the new scriptlet file is not one of the rule files Chrome allows in a skip-review update.
- Tools 2.0.16: a SAFE (skip-review) filter build now prints a "NOT INCLUDED" report listing the scriptlet and hide rules it cannot ship; suite step 53 checks it.

## 10.1.8
- **New scriptlet `disable-fave-ssai` for CNN video ads.** AdGuard stops CNN's server-side video ads with a raw-JavaScript rule plus a response-rewrite rule; neither can run here. The new named scriptlet does the same job: write `cnn.com#%#//scriptlet('disable-fave-ssai')` in your Quick-fixes list and it ships in the next filter build.
- **New scriptlet `stub-window-object`** for the third dropped CNN rule (a small stub that replaces `window.AdFuel` shortly after the page loads): `cnn.com#%#//scriptlet('stub-window-object', 'AdFuel', 'queueRegistry,destroySlots', '500')`. It is generic: name of the global object, its method names, and a delay.
- **Behaviour you will see:** nothing changes until those lines are added to the list. After that, video clips and live streams on cnn.com should come without stitched-in ads, and CNN's ad-slot manager (AdFuel) stops creating display-ad slots. Not yet verified on the live site.
- Scriptlets written by this project (not only AdGuard's) can now be used by any shipped list, for example the Quick-fixes list, and are also available in Custom rules.
- **Quick-fixes list: lines the build cannot use are now dropped and reported** (`dropped-unsupported-list-lines.txt`, plus a
  warning at the end of the build): raw-JavaScript rules, CSS injection, procedural filters, HTML filtering, and network
  rules with modifiers such as `$replace`/`$csp`/`$redirect`. Before, they vanished without a word (some even turned into a
  useless network rule). Other lists are not affected.
- Tools 2.0.15: suite step 51 checks that such a rule ships and runs only on its sites; step 52 checks the dropped-and-reported behaviour.

## 10.1.7
- **Smaller, faster scriptlet data.** The 11 scriptlet files are stored in a compact shared layout (each rule once, a sorted
  host list instead of a large lookup table). Together they shrink from 3.95 MB to 2.85 MB (AdGuard Base: 1.92 MB to 0.93 MB)
  and load faster on each page (about 60 ms down to about 20 ms for AdGuard Base in a Node test; real Chrome not yet measured).
- **Behaviour you will see:** none on almost every site. On web.de, 3c.web.de and manager-magazin.de the first scriptlet rule
  of the list no longer runs twice per page (it ran twice before; once is what was intended).
- 30 list entries that could never match any site (path-limited `[$path=...]` scopes, `[$url=...]`, regex scopes and
  `~host` exclusions) are no longer carried; they never fired, so nothing changes. The build now reports them in
  `dropped-unsupported-scriptlet-scopes.txt`.
- Tools 2.0.14: new suite step 50 proves the new layout against a plain reference lookup (fuzzed) and checks every shipped file.

## 10.1.6
- **One shared whitelist for well-known apps.** Meeting and chat apps (Zoom, Teams, Meet, Webex, Discord, Slack, WhatsApp,
  Telegram, Signal and more, plus Japanese, Korean and Brazilian ones), gaming platforms (Steam, Epic, Xbox, PlayStation,
  Nintendo, Riot, Roblox and regional ones) and streaming services (YouTube, Netflix, Twitch, Spotify and regional ones) are
  now on the built-in whitelist AND exempt from every Worry-free and safer-regions protection, as if typed as `@@domain$worryfree`.
- **Behaviour you will see:** on those sites the Worry-free extra ad/tracker lists and protections no longer apply, and their
  scripts and frames embedded on other sites are no longer blocked by filter lists.
- **Language filter names now show their real source** instead of "community": Polish (MajkiIT), Latvian (Latvian List), Lithuanian and Czech & Slovak (EasyList), Nordic (Dandelion Sprout), Bulgarian (BG Adblock & AdGuard).
- **Korean filter is now List-KR + YousList** ("Korean filter (List-KR & YousList)"), built from List-KR's own source files; replaces the AdGuard-labelled filterslists-KO list. About 2% fewer rules (2,681 vs 2,730), 162 site scripts, 1,877 sites with hiding rules.
- The separate "streaming and game services" exception of the obfuscated-payload block is gone; the list above covers it.

## 10.1.5
- "Block access to the local network" no longer blocks **this computer** (`localhost`, `127.x`, `::1`, `0.0.0.0`), so local
  helper apps and dev servers keep working. Your router, NAS, printer and other LAN devices stay blocked.
- The IPv6 form of those LAN addresses (`[::ffff:192.168.1.1]`, previously a way around the block) is now blocked too.
- "Block pop-ups and page redirects" (outside safer regions) no longer bans `eval()` / `new Function()`, which broke legitimate sites. Obfuscated `eval()` stays blocked by its own item.
- "Block obfuscated payloads" now skips major streaming and game services of Japan, Korea and South America (matching the language filter lists added earlier), so they keep working.
- Payment, bank, wallet and sign-in services (PayPal, Stripe, Google/Microsoft/Apple sign-in, ChatGPT sign-in, CAPTCHAs, plus Japan, Korea, Brazil and South America) are now exempt from ALL Worry-free and safer-regions protections, as if typed as `@@domain$worryfree`, so payments and logins are not broken. Sign-in hosts only, never whole sites such as facebook.com.
- 10.1.4 was never published; its changes (changelogs moved out of the extension package, safe-update verifier) ship in this version.

## 10.1.4
- **Nothing changes in what the extension does.** Packaging only: the changelog files are no longer inside the extension
  package, so a filter-list-only update can be submitted through the Chrome Web Store's skip-review ("safe update") path.
  Until now every release edited `CHANGELOG.md` inside the package, which made every release ineligible.
- New tool `verify-safe-update` proves a finished update qualifies (only the manifest version and safe rules in the declared
  filter lists differ from the last published package).
- The style-guide lint no longer reports the three already-verified amber warning-text colours as problems.

## 10.1.3
- **New Worry-free item "Block access to the local network"** replaces the motion-sensor block (Chrome's "Local network"
  permission: websites may not reach other devices in your home or office network, such as your router, printer or NAS,
  or programs on this computer). It blocks requests from websites to localhost, `.local`/`.lan`/`.internal` names and
  private IP ranges. Pages that are themselves on your local network are not affected.
- **Allow list now also covers embedded frames for the network protections**: with `@@site$worryfree`, third-party
  frames embedded in that site are no longer blocked by Worry-free network rules. Script protections inside such
  frames still follow the per-frame limit.
- A security rule that Chrome could not compile used to switch off all security rules at once; it is now skipped alone.

## 10.1.2
- **Japanese filter label corrected** to "Japanese filter (AdGuard & Yuki2718)" (it still showed "community").
- **Annoyances list renamed** to "AdGuard and EasyList annoyances (specific websites only)".
- **All filter lists refreshed** against their current upstream sources; none failed. Only small changes (AdGuard Base,
  German, Spanish, Portuguese, Admiral, annoyances).

## 10.1.1
- **Save/Restore Settings now also covers which filter lists are on/off** (Built-in toggles, added
  Language filters, Worry-free list toggles) — this was never part of a backup before. Restoring an
  older backup now also re-runs the 10.0.7 migration against it, so a pre-10.0.7 backup's retired-list
  choices carry over correctly instead of being silently skipped.
- **Language filter names now show their real source** (e.g. "Dutch filter (AdGuard & EasyList)",
  "Korean filter (AdGuard & YousList)") instead of a source-neutral name.
- **Korean filter now uses AdGuard's maintained filterslists-KO ("Classic") instead of List-KR, and also includes YousList.**
  List-KR's old addresses may stop working; AdGuard itself switched to this fork. About 5.8x more Korean rules than before,
  including Korean site-specific scripts; still off unless Korean is your language or you switch it on.
- **Peter Lowe's list is back** as a Worry-free option ("Peter Lowe advertising & tracking servers"), directly below Kees1958.
- **Worry-free ad/tracking lists now block third-party requests only**: AdGuard tracking servers and Peter Lowe no longer
  block a site that is itself on those lists (Kees1958 and Disconnect already worked this way).
- **Three block-list names clarified**: "AdGuard Base (block advertising) filter", "AdGuard and EasyList anti-adblock
  (specific websites only)" and "Block Admiral anti-adblock (EasyList, HaGeZi and LanikSJ)".
- **Worry-free section text clarified**: now says plainly that anti-tracking filters are enabled by
  default during a session, instead of a vaguer "you can enable additional filters" phrasing.
- Language-filter toggle switches made smaller with spacing between rows — the previous size/spacing
  looked out of place next to the rest of the settings page.

## 10.1.0
- **Extension renamed to "uBlock Dynamic"** (manifest short_name and the `extName` locale message).
- **Filter-list dashboard reorganised.** Peter Lowe's list, the EasyList general-ads/third-party lists, the three
  EasyList site-specific lists and the Kees1958 tracking-params list are retired (their useful content already
  lives elsewhere — anti-adblock sources are now combined, and EasyList's adult-specific content is folded into
  the "AdGuard and EasyList annoyances" list). "AdGuard and EasyList annoyances" moves from a Worry-free opt-in to
  an always-on Built-in default — it's broadly useful, not something that should only run during a timed session.
  The Kees1958 EU+US list moves the other way, from Built-in to Worry-free opt-in. The retired tracking-params list
  is replaced 1-for-1 by a new "AdGuard remove tracking parameters" list, split out of AdGuard Base. Existing
  users' saved choices for the retired lists — including a previously-disabled Kees1958 EU+US list — are migrated
  to their closest equivalent on upgrade.
- **Save/Restore Settings now includes the "familiar TLDs" (safer-region) allowlist** — previously editable on the
  dashboard but silently left out of backup/restore, so restoring a backup lost this list.
- **AdGuard Spanish and EasyList Portuguese filters rebuilt from their real upstream sources** (previous builds used
  a stale, near-empty mirror) and the Portuguese filter's TLD coverage is extended to every Portuguese-speaking
  country/territory, not just Brazil.
- **Cookie-Consent-Clicker now pauses Worry-free instead of being blocked by it.** Launching the element picker
  while a Worry-free session is active now pauses that session and resumes it automatically once the pick finishes
  or is cancelled, with a 5-minute fallback resume in case the picker is abandoned.
- **The 5-eyes/EU+ jurisdiction restriction is removed.** AdGuard Base and the Worry-free extra lists no longer
  skip cosmetic/scriptlet rules or source domains based on country — every TLD is now treated the same. This means
  more blocking and a larger ruleset for AdGuard Base than before.
- **EasyList Italian filter rebuilt from its real upstream sources**, same fix as Spanish/Portuguese above (the old
  build fetched a single file instead of the list's real sub-files).
- **New Japanese and Korean filters.** Japanese combines AdGuard's own Japanese filter with a real community
  supplement; no genuine standalone "EasyList Japan" exists. Korean uses List-KR, the de-facto standard
  community list (already EasyList-syntax; AdGuard has no Korean filter of its own to combine with it).

## 10.0.6
- The Belgian filter is retired. Its content (real Belgian ad-network rules) is now duplicated into both the Dutch
  and French filters instead — Belgium has both a Flemish and Walloon audience, and the source can't tell them
  apart. A mislabeled Bulgarian rule that had been sitting under the "Belgian" section in AdGuard's own upstream
  data is dropped rather than carried into either filter.
- Every language filter's name is simplified (e.g. "EasyList Italian" -> "Italian filter") — the AdGuard/EasyList
  source distinction no longer shows, since several filters now combine more than one source.
- Bulgarian filter now combines two independent sources instead of one.
- The anti-adblock filter now combines AdGuard's and EasyList's anti-adblock-circumvention sources.
- Dutch, German and French filters each also combine a matching EasyList anti-adblock source.
- All filter lists refreshed (live full build against current upstream sources).

## 10.0.5
- One shared, build-generated catalog (`rulesets/ruleset-details.json`'s new `category`/`locales` fields) now drives
  every place that needs a ruleset's human name or its locale auto-enable trigger — the dashboard's language-filter
  dropdown, the Matrix panel's "more info" rule-summary line, and the browser-locale auto-enable logic.
- Fixed: the Matrix panel's expanded rule-summary line showed raw internal ids (e.g. `ruleset_easylist_adult_specific`)
  instead of a readable name.
- The Belgian filter's region-specific auto-enable (`nl-BE`/`fr-BE`/`de-BE`) is now expressed as data on its own
  entry instead of a hand-coded special case in `background.js`.
- A new country or language filter added in `tools/build/filter-lists.mjs` now needs no dashboard or background.js
  edit to appear and auto-enable correctly — verified byte-for-byte against the old hardcoded locale map for all
  26 previously-supported locales plus the 3 Belgian region cases, and a build-time guard now fails the build if any
  ruleset is missing a name, a valid category, or a locales array.
- All filter lists refreshed (live full build against current upstream sources).
- Tools-only: `buildWorryFreeLists()` now aborts the build if any of its 5 sources (EasyList adult/third-party, AdGuard tracking servers, Peter Lowe, HaGeZi Multi light) ever contains cosmetic or scriptlet syntax — this function only ever parsed network/domain rules and previously had no way to notice such a line, so it would silently vanish. None of the 5 currently contain any; this guards against a future upstream change doing so unnoticed. Does not affect extension content — no behavior change for users.

## 10.0.4
- **One shared set of default generic TLDs.** The Privacy & Security default list, the Worry-free build scope and
  the filter-list build (which cosmetic and scriptlet rules are kept) now all read the same 18 generic TLDs:
  `com net org info biz io co ai shop store site online tech app cloud tv gov edu`.
- Filter lists therefore now also keep rules for `.biz .ai .shop .store .site .online .tech .cloud .gov .edu`.
- **`.dev` is no longer treated as generic by the filter lists** (it was not in the Privacy & Security set).
- The compiled filter rulesets are regenerated at the next filter refresh, not by this version bump alone.

## 10.0.3
- Renamed back to **uBlock Stripped — Dynamic Filtering**. The AdShield Evolution name from 0.0.2 is dropped after
  Chrome Web Store review advised against a name change.
- Version number moves to **10.0.3** instead of the 0.0.x test numbering.
- No other change.

## 0.0.3
- The "safer region" default list now expands to your whole continent (countries that speak one of your
  browser's languages, or a closely related one), not just the countries your browser's languages name
  directly. Replaces 0.0.2's browser-only default — "restore TLD's" now gives you the wider list.

## 0.0.2
- Renamed to **AdShield Evolution — Dynamic Filtering**.
- Simplified popup: one flat list, no "Quick Access"/"Power tools" sections or More/Less toggle. Filter
  lists, Allow list, custom rules, ABP import and Privacy & Security are now reached via one "Settings
  dashboard" item.
- "Safer region" TLD/country-code list is now editable (Privacy & Security tab), with a button to restore
  the built-in default. That default is no longer just the countries your browser's own language
  settings name — it now also includes every other country on your own continent that speaks one of
  those languages (or a closely related one), the same "Continent" default 3P-Matrix-lite uses.

## 0.0.1
- Fresh release lineage: starts at 0.0.1, with no in-place upgrade path from any earlier version. Every
  install of this version is a clean install — there is no settings or data migration to run.
- No user-visible feature change. Internal cleanup only: removed one-time upgrade code that no longer
  applies (see CHANGELOG_HISTORY.md for the full account) and corrected several stale internal comments.

## 10.0.2
- **`.gov` and `.edu` are now safer regions** (54 TLDs). Websites on them are skipped by the Low and Medium protections, like the other safer-region TLDs. Both are TLDs with
  vetted registration (only government bodies and accredited educational institutions can register them).
- The same list also decides which domains of the Worry-free extra filter lists are used, so 15 `.gov`/`.edu` tracker domains (for example `ad.umassmed.edu`, `go.dhs.gov`)
  are now in those lists.
- All filter lists refreshed live (HaGeZi Light +5,300 domains, AdGuard Base, Peter Lowe, EasyList, Anti-Admiral, the annoyances list); none failed.

## 10.0.1
- **`@@bbc.com$worryfree` now fixes sites the Worry-free lists break.** A site written as `@@example.com$worryfree` is now outside Worry-free altogether: the Worry-free
  filter lists and every Worry-free protection. (Since 9.9.1 neither `$worryfree` nor `$saferegions` could exempt a site from those lists, which stopped BBC video.)
  `@@example.com$saferegions` keeps covering only the protections outside safe regions.
- **Both options now work in all three places** you can write them: the Allow list tab, the Import ABP rules editor and the built-in quick-fixes list (`bbc.com` is built in).
- **Settings backup** now includes the Allow list's `$saferegions` and `$worryfree` lines (they were silently left out of an export before).
- Changing an exemption now takes effect immediately for the page scripts too, not only at the next Worry-free session.
- All filter lists refreshed.
- Wording: "safe regions" is now called **"safer regions"** in the dashboard (the 52 country and common TLDs the extra protections leave alone — a subset chosen to exclude
  abuse-heavy TLDs such as .club and .xyz, so "safer" is a true comparison). The `@@example.com$saferegions` line you type is unchanged.
- Every Privacy & Security label now ends with a full stop, and a few labels were tidied ("outside safer regions").
- (This 10.0.1 package was rebuilt once, with the wording changes above; an earlier 10.0.1 package without them was handed over first.)

## 10.0.0
- **Four new protections** on the Privacy & Security tab:
  - Block websites from installing payment handlers (always on).
  - Block access to motion sensors (accelerometer, gyroscope, magnetometer), Worry-free only.
  - Block installing protocol handlers, such as the offer to open e-mail links with a website, Worry-free only.
  - Block querying local fonts on websites outside the safe regions (advanced tier).
- Every group now has five protections, ordered privacy-related first, security-related second.
- "Block obfuscated payloads outside safe-regions" moved to the Low group, so it now also needs the "safe regions" box.
- The Medium "third-party content" block now lets stylesheets and fonts through, so pages keep their look.
- "@@example.com$worryfree" now also exempts a site from "Block suspicious 3P-requests", and the Low and Medium protections
  say they can be exempted with "@@example.com$saferegions".
- All protection labels and tooltips were rewritten in plain words that describe the effect.

## 9.9.1
- **The Worry-free extra filter lists now actually block what they list.** When the Medium
  ("advanced") protections were on, an internal exemption for ordinary domains (.com, .net, .org
  and so on) outranked those lists, so most of their ad and tracker hosts were let through on
  exactly the sites people visit most. Measured on the shipped rules: 27% of their rules applied
  before, 100% now. If you saw ad pop-ups on a site while the lists were ticked, this was why.
- The whole internal rule-priority order was renumbered to make that correct by construction:
  your Allow list and "Pause filtering" stay above everything, then the built-in whitelist, the
  badfilter quick fixes, the Matrix panel, your own imported rules, the default filter lists, and
  then the Worry-free lists above the remaining Worry-free protections.
- Tracking parameters (utm_*, gclid) are now stripped from page addresses only, not from embedded
  frames. Stripping them inside a frame kept ad frames loading that a filter list wanted blocked.
- Removed, on high-risk (adult) websites, the blanket block of third-party scripts and frames. It
  made an exception for any address containing "cdn", which let through about 1,800 ad hosts your
  own filter lists block. The eval block, the permission lockdown (camera, microphone, USB and so
  on) and the fingerprinting protections for those sites are unchanged.
- All filter lists refreshed.

## 9.9.0
- New Worry-free filter list, the last row after Disconnect: **AdGuard and EasyList annoyances
  (newsletter, notification and promo prompts)**. On by default. During a Worry-free session it
  hides in-page newsletter boxes, notification prompts and promo overlays on about 6,700 popular
  sites and blocks their vendor hosts. Outside a Worry-free session it does nothing, and you can
  untick it in the Filter lists tab. It does not close new-tab popups.
- Sites you exempt with `@@domain$worryfree` are skipped by it too.
- All upstream filter lists refreshed. Small upstream changes in AdGuard Base, German, Spanish and
  anti-adblock, HaGeZi Multi light, Disconnect, the Bulgarian list and Anti-Admiral.

## 9.8.1
- Small red warning texts (the Matrix/Privacy Inspector stop banner, Exit button,
  Block column header, blocked-rule labels, the expired timer and the delete
  hover in Custom Rules) are now a slightly darker red in light mode, so they
  are easier to read. Dark mode looks the same.

## 9.8.0
- Custom Rules and ABP-import now accept several scriptlet names that were
  previously rejected as "unknown": short aliases like `set`, `rc`, `ra`,
  `aeld`, `nostif`, `cookie-remover` (and about 50 similar short forms),
  plus four scriptlets not previously available at all: `prevent-dialog`,
  `bab-defuser`/`nobab`, `freeze-element-property`, and `href-sanitizer`'s
  `urlskip` alias.
- Some scriptlet names are deliberately still not accepted: AdGuard's
  `trusted-*` family (restricted by AdGuard's own policy to their own
  vetted filters) and `prevent-clipboard-write` (carries the same
  restriction upstream, despite its plain name).

## 9.7.9
- Worry-free extra blocklists (Disconnect, AdGuard tracking servers, Easylist
  advertising servers, the two EasyList site/third-party lists, Peter Lowe)
  now also block third-party scripts and frames. Before, the safe-region
  exemptions let most of those through, so only images and requests were
  blocked. Unticking a list, or switching Worry-free off, still turns it off.
  Some sites that relied on such scripts or embeds may lose content.
- All filter lists refreshed.

## 9.7.8
- Two more EasyList lists added to Worry-free, controlled by the existing
  "Easylist advertising servers" checkbox: site-specific advertising rules
  (includes eporner.com's ad endpoints) and third-party advertising servers.
  Country-code domains outside your covered regions are left out.
- Fix: Allow-list style rules written as "~third-party" or "~first-party"
  were treated as having no restriction, which made some rules block more
  than intended. They are now honoured.
- All filter lists refreshed.

## 9.7.7
- New protection (Privacy & Security, Worry-free): blocks a website from
  silently putting a command line on your clipboard — the automated step
  of a "ClickFix" attack, where a page shows a fake CAPTCHA or error and
  asks you to paste the copied text into the Run box or a terminal.
  Ordinary copy buttons on developer documentation keep working. It never
  reads your clipboard; it only inspects what a page tries to write.
  Blocks silently, recording a console message.
- The two high-risk (adult) website protections are now one checkbox:
  "Enforce strict EVAL block and safe-regions protections on high-risk
  (adult) websites." If you had unticked exactly one of the two, the new
  single checkbox will be ticked — untick it if that is not what you want.
- New Allow list line: "@@example.com$worryfree" exempts one website from
  the Worry-free protections on the Privacy & Security tab.
- A mistyped Allow list option line (for example "$worryfre") is now
  reported and ignored, instead of silently becoming a stray entry.

## 9.7.6
- Anti-fingerprinting and security protections hardened: a page can no
  longer switch them off from its own scripts, and they now also apply
  inside blank frames a page creates for itself.
- The Allow list is now checked when it is read back, so one damaged
  entry can no longer stop the whole list from working.
- Behind-the-scenes code-quality, tooling and reliability work; no other
  change in how the extension behaves.

## 9.7.5
- Real bug fix: restoring a saved settings file now replaces the ABP/
  sandbox filter text with the backup's version instead of appending
  another copy on top of what was already there.
- Real bug fix: the toolbar icon could stay stuck on an old state (or
  keep showing a block count) after a bulk Allow-list save or a
  Settings restore — it now updates correctly for every open tab
  affected.
- Refreshed all filter lists.

## 9.7.4
- Updated the licence notices (`LICENSE.txt` and `THIRD_PARTY_LICENSES.md`)
  so they list everything the extension bundles and the licence each part
  is under. No change in how the extension behaves.

## 9.7.3
- New built-in filter list, on by default: HaGeZi's Multi light. It blocks
  known ad, tracker and telemetry domains. Untick it under Filter (block)
  lists if you don't want it.
- Refreshed all filter lists.
- The info text on the Filter (block) lists tab now describes which
  domains are left out of the lists.
- Behind-the-scenes code-quality and reliability fixes; no change in how
  the extension behaves.

## 9.7.2
- Toolbar icon changed to mint green.

## 9.7.1
- Corrected several inaccurate descriptions on the Privacy & Security tab.
- Download blocking now catches more forced downloads, for both
  first-party and third-party sites.
- Refreshed all filter lists.
