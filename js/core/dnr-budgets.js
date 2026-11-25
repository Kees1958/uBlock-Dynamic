/*
 * dnr-budgets.js — Single source of truth for all DNR rule ID ranges,
 *                  capacities, priorities, and storage caps.
 *
 * Chrome allows 30 000 safe dynamic rules (declarativeNetRequest).
 * All allocations are defined here; no module should declare its own
 * copy of these numbers.
 *
 * Dynamic DNR allocation (total ≤ 30 000):
 *   6 000 000 – 6 004 999   RETIRED (was Monitor block rules) — left
 *                            unused, not reassigned; see below      0 slots
 *   7 000 000 – 7 000 020   Security toggle rules                  21 slots (10.2.0: +17..+20 Suspicious-hosting exceptions)
 *   8 000 000 +             Trusted directives (few)               < 10 slots
 *   9 000 000 +             Sandbox compiled DNR rules            5 000 slots
 *  10 000 000 – 10 004 999  Dynamic DNR Rules (per-site overrides)  5 000 slots
 *  11 000 000 – 11 000 001  CRITICAL RESOURCE global exemption        2 slots
 *  12 000 000                RETIRED (was Global Privacy Control) —
 *                            migration-only constant kept; see below 0 slots
 *  13 000 000 +               Worry-free extra: session allow rule     < 10 slots
 *                            (suppresses reserved-tier static content
 *                            below during default-mode browsing)
 *                                                                ──────────────
 *                                                    Total used   10 023  (19 977 headroom)
 *
 * Note: Chrome's hard cap is 30 000; "safe" here means the numbers
 * chosen leave no gap risk between ranges. 6 005 000–6 005 001 (formerly
 * "Suspicious hosting / DDNS") was reclaimed in 7.0.0 when that feature
 * was removed — left unused rather than reassigned, since a stale
 * dynamic-rule ID from a pre-7.0.0 install now means something
 * unambiguously retired if ever seen again, instead of colliding with a
 * newer, different feature that happened to reuse the same slot.
 *
 * 6 000 000 – 6 004 999 (formerly Monitor block rules, backing the
 * standalone "DDG Tracker Radar" session-monitor feature) was retired the
 * same way in the uBlock-Stripped-Dynamic fork, for the same reason: that
 * feature was removed (superseded by the Matrix panel — see CHANGELOG),
 * and its ID range is left permanently unused rather than handed to a
 * different feature. (10.0.3) A migration step in background.js's
 * runVersionMigration() used to clean up any lingering rules in this
 * range plus the retired `monitorBlockRules` storage key for anyone who
 * happened to install an interim 0.x build that still had
 * block-monitor.js active; that step was removed along with every other
 * pre-10.0.3 upgrade step — see CHANGELOG_HISTORY.md's 10.0.3 entry.
 *
 * "3P DDNS & Free hosting" and "Block suspicious 3P-links" (added in the
 * uBlock-Stripped-Dynamic fork) deliberately do NOT reuse that retired
 * slot, for the same reason it was left retired rather than reassigned —
 * they slot into the EXISTING Security toggle range (7 000 000+) instead,
 * as securitySlots entries — see ruleset-manager.js for the full ID map
 * (punycode, IP-literal, port-allow, port-block, DDNS-domains,
 * DDNS-regex). As of the DDNS-regex slot (+13), this 14-slot range is
 * now fully allocated — a new Security-tier rule needs a new ID range,
 * not a squeeze into this one.
 *
 * Undo mechanism: MATRIX_RULES_ALL_PRIORITY / MATRIX_RULES_CODE_PRIORITY
 * (below) are deliberately set HIGHER
 * than every Security toggle priority, so a Matrix panel Allow override
 * naturally outranks the DDNS/suspicious-3P-links block rules via DNR's
 * own priority resolution — no manual excludedRequestDomains exemption
 * list needed (an earlier version of this file had one; removed once the
 * override model became per-site-scoped, since a flat global exemption
 * list stopped making sense once "allowed on site A" and "allowed on site
 * B" became different facts — see matrix-block-rules.js's header for the
 * full per-site design).
 *
 * Dynamic DNR Rules (10 000 000+) is a NEW top-level range, not a
 * reuse of the retired Monitor range — even though both are "user/
 * session-created block rules" in spirit, keeping a fresh, never-reused
 * range makes the "is this ID from the current feature or a ghost of a
 * removed one" question always unambiguous, the same reasoning as every
 * other retirement in this file.
 *
 * 12 000 000 (formerly Global Privacy Control, the Sec-GPC request-header
 * DNR rule) was retired the same way: the feature itself was removed —
 * its DNR rule's required broad scope (first-party AND third-party,
 * unlike every other Security toggle here) made Chrome's icon badge
 * count deeply misleading whenever it was on, since Chrome counts
 * modifyHeaders matches (what this rule was) the same as real
 * block/redirect matches. No fix existed that was both accurate and
 * simple enough to justify for a single toggle, so the toggle was
 * removed rather than shipped with that known side effect — see
 * CHANGELOG for the full history. This slot is left permanently unused,
 * not reassigned, for the same unambiguous-ghost-ID reason as every
 * other retirement above.
 *
 * Storage caps (chrome.storage.local, 10 MB quota):
 *   Custom cosmetic rules   10 000  (site.* keys, ~200 bytes each → ~2 MB max)
 *   Matrix overrides         5 000  (matrixOverrides — per (site, domain) pairs, see MATRIX_OVERRIDES_MAX below)
 *   Sandbox ABP import       5 000  (DNR rules after compilation; cosmetic/scriptlet rules are storage-only)
 *
 * Public interface: all exports are numeric constants. No logic, no state.
 */

/*
 * ──────────────────────────────────────────────────────────────────────────
 *  DNR PRIORITY TABLE — the ONE place the whole priority order is written
 *  (re-numbered in 9.9.1 — the ladder below was specified by the owner)
 * ──────────────────────────────────────────────────────────────────────────
 * Chrome rule: the HIGHEST priority wins; on a tie an allow beats a block.
 * An allow at a higher priority also cancels lower-priority modifyHeaders
 * rules. Per-constant comments elsewhere explain WHY; this table is the
 * order. Change a number below only together with its constant.
 * tools/check-dnr-priority-order.mjs asserts this exact order and these numbers.
 * Listed HIGHEST → LOWEST. "static" = shipped ruleset, "session" = session
 * rule, "dynamic" = dynamic rule.
 *
 *  Priority   Constant                                     Kind        What it is
 *  ---------  -------------------------------------------  ----------  ------------------------------------------
 *  1 000 000  TRUSTED_DIRECTIVE_PRIORITY                   dynamic     Pause / Allow-list directive (allowAllRequests)
 *    800 000  BUILTIN_WHITELIST_RULES_PRIORITY             dynamic     Built-in whitelist
 *    600 000  BADFILTER_QUICKFIXES_PRIORITY                static      Badfilter quick-fix allows
 *    400 000  MATRIX_RULES_ALL_PRIORITY (+1 = _CODE)       dynamic     Matrix panel rules
 *    200 000  USER_RULES_PRIORITY (+10 block, +11 redirect, +30 allow)  dynamic  ABP-import / custom rules
 *     10 000  STATIC_FILTER_LIST_PRIORITY                  static      Default filter lists: block; (11.1.3) +1 $redirect,
 *                                                                      +2 @@ allow, +3 $important (STATIC_*_PRIORITY_OFFSET)
 *      9 500  WORRY_FREE_SITE_ALLOW_PRIORITY               dynamic     "@@site$worryfree": that site is outside Worry-free
 *                                                                      altogether (the extra lists AND every protection below)
 *      9 200  CMP_LOADER_BLOCK_PRIORITY                    session     (10.7.16) CMP loader block while Seamless surfing
 *                                                                      DECLINES banners (js/core/cmp-loader-block-manager.js)
 *      9 200  COOKIE_NOTICE_BLOCK_PRIORITY                 session     (11.0.0) cookie-notice block rules, same manager,
 *                                                                      same rule (decline only, saved-rule sites excluded)
 *      9 000  WORRY_FREE_EXTRA_ALLOW_PRIORITY              session     Per-list off-switch for the extra lists
 *      8 000  WORRY_FREE_EXTRA_LISTS_PRIORITY              static      The Worry-free extra lists (AdGuard tracking,
 *                                                                      Kees1958, Peter Lowe; Disconnect removed 10.7.1)
 *      8 000  WORRY_FREE_EXTRA_LISTS_ALLOWLIST_PRIORITY    static      (10.7.1) Hidden, always-on AdGuard @@ exceptions for
 *                                                                      those three lists — same number on purpose: on a tie
 *                                                                      an allow beats a block, and it stays below 9 000/10 000
 *  (1 000-1 002 SECURITY_RULES_/PORT_/LOCAL_NETWORK_PRIORITY — RETIRED 10.3.0: the Privacy & Security
 *            security-toggle rules moved to 3P-Matrix. 900 HIGH_RISK_HEADERS_PRIORITY — RETIRED 10.3.0 too.
 *            Not reused — see RETIRED_PROTECTION_RULE_RANGES at the end of this file.)
 *  (300-320  ADVANCED_3P_BLOCK/FORCED_DOWNLOAD_BLOCK/HEADER/ALLOW_PRIORITY — RETIRED, AdShield Evolution
 *            rename pass: the Medium tier's first-party-downloads and third-party-block rows, and the
 *            tier checkbox itself, are gone. Not reused — see CHANGELOG_HISTORY.md.)
 *  (170/180  SANDBOX_SAFE_SCRIPTS_HEADER/ALLOW_PRIORITY — RETIRED 10.3.0, the Low group's pop-up/redirect row.)
 *  140-165    (RETIRED band, NOT to be reused)             —           Old advanced tier, removed v9.6.8
 *  (120-135  SCP_PRIVACY_* / SCP_SECURITY_* — RETIRED 10.3.0, the Low group's two Permissions-Policy headers.)
 *  (110-115  WORRY_FREE_DOWNLOAD_BLOCKLIST/TLD_ALLOW/SUPPRESS_PRIORITY — RETIRED, AdShield Evolution rename
 *            pass: blockScpTldBlock ("Block third-party scripts, frames and downloads") removed entirely,
 *            per explicit request. Not reused — see CHANGELOG_HISTORY.md.)
 *  101        WORRY_FREE_EXTRA_TLD_ALLOW_PRIORITY          static      Safe-TLD allows for the blanket 3P block
 *  100        WORRY_FREE_EXTRA_BLOCKLIST_PRIORITY          static      Blanket 3P block (third-party script/frame)
 *  (1 900 000-1 900 002 were the strict 3P block and its two allows — RETIRED 9.9.1, see below; not reused)
 *
 * Ordering rules this table encodes (enforced by tools/check-dnr-priority-order.mjs
 * and tools/check-dnr-id-ranges.mjs where noted there):
 *   - The Worry-free extra lists (8 000) outrank EVERYTHING Worry-free: every TLD allow
 *     (101/111/121/131/320), every Privacy/Security item (120-135) and the whole Medium
 *     tier (300-320) — so a safe-domain exemption can never hide a host the extra lists
 *     block. (Before 9.9.1 they sat at 170, BELOW the Medium tier's safe-domain band at
 *     320, which cancelled them on every .com/.net/.org host.)
 *   - "@@site$worryfree" (9 500, two dynamic allows in worryfree-manager.js) puts a site outside
 *     Worry-free altogether: it outranks the extra lists (8 000) AND their per-list off-switch (9 000), so
 *     everything Worry-free does below it is cancelled for that site, and sits BELOW the default lists
 *     (10 000), so the person's own default-list/Matrix/custom rules still apply. "@@site$saferegions"
 *     stays BELOW the extra lists (it exempts only the protections outside safe regions, never the lists).
 *   - The per-list off-switch (9 000) outranks the list it switches off (8 000) and sits
 *     BELOW the default lists (10 000), so switching an extra list off can never unblock
 *     a host that a default list blocks. ACCEPTED trade-off: because it also outranks the
 *     Medium tier and the security-toggle rules, a switched-off list's hosts skip those too.
 *   - Default filter lists (10 000) outrank all Worry-free rules and the security-toggle
 *     rules, so an `@@` exception in a list always wins over them.
 *   - The adult-site headers (900) sit BELOW the default lists and the security toggles, above the
 *     Medium tier: a filter-list `@@` exception (10 000) CAN cancel them, deliberately — same stance
 *     as the security toggles, an allow exception in a list is written on purpose and should win.
 *   - The security-toggle rules (1 000) outrank the whole Low/Medium tier (<= 320): a
 *     suspicious-host block is not cancelled by a safe-domain exemption.
 */

// ── RETIRED: Monitor block rules (was 6 000 000–6 004 999) ──────────────────
// (10.0.3) No longer imported by background.js — the one-time upgrade
// migration that used these two constants to clean up any lingering rules
// from a pre-7.0.0 install was itself removed in 10.0.3, along with every
// other pre-10.0.3 migration step (see CHANGELOG_HISTORY.md's 10.0.3 entry:
// this release starts a fresh lineage with no in-place upgrade path). Kept
// here, not deleted, purely as the permanent ID-reservation record
// check-dnr-id-ranges.mjs reads to stop a future feature from reusing this
// range by accident — see the header above for why the range itself stays
// retired rather than reassigned.
/** @public read by tools/check-dnr-id-ranges.mjs for the permanent-ID-reservation collision check; no import consumer since the 10.0.3 migration removal */
export const MONITOR_RULES_RETIRED_BASE_ID = 6_000_000;
/** @public read by tools/check-dnr-id-ranges.mjs for the permanent-ID-reservation collision check; no import consumer since the 10.0.3 migration removal */
export const MONITOR_RULES_RETIRED_MAX_DNR = 5_000;

// ── Security toggle rules ────────────────────────────────────────────────────
export const SECURITY_RULES_BASE_ID  = 7_000_000;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
export const SECURITY_RULES_PRIORITY = 1_000;      // 9.9.1 ladder: was 1 500 000   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
// "Block suspicious 3P-links"' non-standard-port check needs two rules at
// two different priorities (RE2 has no negative lookahead, so "block any
// port except these four" can't be one regex — see the removed matrix-detect.js's
// header). The allow rule for the 4 permitted ports MUST outrank the
// block-any-port rule below it, or DNR would just apply whichever one
// happens later; +1 is enough since nothing else in the Security tier
// needs to sit between them.
// (audit 10.6.4, C13b) SECURITY_PORT_BLOCK_PRIORITY — an unused alias of SECURITY_RULES_PRIORITY for a rule retired
// in 10.3.0 — removed. A priority is not an exclusive resource, so nothing needs reserving here.
/** @public read by name from the LADDER list in tools/check-dnr-priority-order.mjs's priority-order check (A2) — a string-keyed B[name] lookup, invisible to Knip's static import analysis. */
export const SECURITY_PORT_ALLOW_PRIORITY = SECURITY_RULES_PRIORITY + 1;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
// "Block access to the local network" must outrank the port-ALLOW rule above: that rule allows any
// third-party URL with an explicit standard port (https://192.168.1.1:443/...), which would otherwise
// punch straight through the local-network block.
/** @public Reserved/retired DNR priority — never reassigned; permanent reservation per this file's header (RETIRED_PROTECTION_RULE_RANGES convention), not currently resolved by name in any check script. */
export const SECURITY_LOCAL_NETWORK_PRIORITY = SECURITY_RULES_PRIORITY + 2;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
// "Block suspicious 3P-requests", pattern d) — free hosting & DDNS (10.2.0). The domain list moved from two
// dynamic slots (+10 domains, +13 the byethost* regex) into the STATIC ruleset ruleset_suspicious_hosting
// (js/data/security-rulesets.js), whose rules carry SECURITY_RULES_PRIORITY. The two old ids are RETIRED —
// never reassigned (a pre-10.3.0 install may still hold them: the 10.3.0 leftover clean-up was removed in 10.5.0).
/** @public read by tools/check-dnr-id-ranges.mjs for the permanent-ID-reservation collision check */
export const SUSPICIOUS_HOSTING_RETIRED_RULE_IDS = Object.freeze([ SECURITY_RULES_BASE_ID + 10, SECURITY_RULES_BASE_ID + 13 ]);   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
// Per-site exceptions for that ruleset: a static rule cannot exclude initiators per site, so each ruleset rule
// gets one dynamic ALLOW mirror scoped (initiatorDomains) to the sites on the protection's own allowlist.
// Same priority as the block rules — an allow wins a tie — so it outranks nothing the dynamic rule's
// excludedInitiatorDomains did not already skip, except the lower Low-tier header rules (100-180) for those
// exact requests. Ids +17 .. +17+MAX-1; the ruleset has 2 rules today (1 domain chunk + 1 regex).
/** @public read by tools/check-dnr-id-ranges.mjs via a dynamic import() of this module (budgetsModule.SUSPICIOUS_HOSTING_EXCEPTION_BASE_ID) — property access through a runtime import() target Knip cannot trace statically. */
export const SUSPICIOUS_HOSTING_EXCEPTION_BASE_ID  = SECURITY_RULES_BASE_ID + 17;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
/** @public read by tools/check-dnr-id-ranges.mjs via a dynamic import() of this module (budgetsModule.SUSPICIOUS_HOSTING_EXCEPTION_MAX) — same untraceable runtime property access as SUSPICIOUS_HOSTING_EXCEPTION_BASE_ID above. */
export const SUSPICIOUS_HOSTING_EXCEPTION_MAX      = 4;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
// (audit 10.6.4, C13b) SUSPICIOUS_HOSTING_EXCEPTION_PRIORITY — unused alias of SECURITY_RULES_PRIORITY, removed (see above).

// ── Trusted directives (allowAllRequests for OFF-mode sites) ─────────────────
// Real footprint: exactly 2 ids (TRUSTED_DIRECTIVE_BASE_ID+0, a dynamic
// allowAllRequests rule; +1, a session rule) — both literal offsets inside
// dnr.setAllowAllRules()'s own implementation (data/ext-compat.js), not at
// the one call site (ruleset-manager.js) that only ever passes the base id.
// tools/check-dnr-id-ranges.mjs derives this from that source directly.
export const TRUSTED_DIRECTIVE_BASE_ID  = 8_000_000;
export const TRUSTED_DIRECTIVE_PRIORITY = 1_000_000;   // 9.9.1 ladder: was 2 000 000 — the top of everything

// ── Sandbox compiled DNR rules ───────────────────────────────────────────────
export const USER_RULES_BASE_ID  = 9_000_000;
export const USER_RULES_PRIORITY = 200_000;       // 9.9.1 ladder: was 1 000 000. Rules carry their own small offsets (+10 block, +11 redirect, +30 allow): 200 010–200 099
// Real-world ABP imports with standard filters already active rarely exceed
// a few hundred network rules. 5 000 is a generous ceiling that still leaves
// the bulk of the 30 000 budget free for monitor and future use.
export const USER_RULES_MAX      = 5_000;
// Mirrors chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES exactly —
// a real, separate, SMALLER cap than USER_RULES_MAX above, evaluated
// independently by Chrome for dynamic+session rules combined. A design gap
// flagged (not fixed) in an earlier release: an "Import ABP rules" input
// heavy on regex-based filters could exceed this 1000 cap while still
// under the 5000-rule USER_RULES_MAX budget, and Chrome's own
// updateDynamicRules() rejects the WHOLE batch atomically when this
// happens — updateUserRules() (ruleset-manager.js) now proactively counts
// regexFilter-bearing rules against this constant BEFORE submitting, same
// "keep the first N, report the rest as dropped" pattern already used for
// USER_RULES_MAX overflow, so the failure mode is a specific, actionable
// message instead of one generic caught error for the whole import.
export const MAX_NUMBER_OF_REGEX_RULES = 1_000;

// (10.7.6, audit 10.7.5 D-9) Chrome's limits on STATIC rulesets — mirrors chrome.declarativeNetRequest's own constants
// of the same names. Checked at build time by tools/check-dnr-ruleset-limits.mjs; at run time Chrome's refusal of
// updateEnabledRulesets() is reported to the person (static-rulesets.js setRulesetEnabled() -> dashboard).
/** @public read by tools/check-dnr-ruleset-limits.mjs (step 78) — Chrome's limit, kept here with the other DNR budgets */
export const MAX_NUMBER_OF_STATIC_RULESETS = 100;            // rulesets the manifest may declare
/** @public read by tools/check-dnr-ruleset-limits.mjs (step 78) — Chrome's limit, kept here with the other DNR budgets */
export const MAX_NUMBER_OF_ENABLED_STATIC_RULESETS = 50;     // rulesets switched on at the same time
/** @public read by tools/check-dnr-ruleset-limits.mjs (step 78) — Chrome's limit, kept here with the other DNR budgets */
export const GUARANTEED_MINIMUM_STATIC_RULES = 30_000;       // static rules always available to this extension
                                                             // (more only from a global pool shared by all extensions)

// Badfilter quick fixes: a personal $badfilter list, compiled at build time into a STATIC ruleset.
// 9.9.1 ladder: 600 000 — above the Matrix panel (400 000), your ABP-import/custom rules (200 000),
// the default lists (10 000) and everything Worry-free, because the list exists to correct all of
// them; below only the built-in whitelist (800 000) and the pause list (1 000 000).
export const BADFILTER_QUICKFIXES_PRIORITY = 600_000;   // 9.9.1 ladder: was USER_RULES_PRIORITY + 1 (an expression); now an absolute number

// ── 3P Matrix (block/allow) rules — per-SITE, per-domain overrides created
// from the Matrix panel (uBlock-Stripped-Dynamic fork). Own top-level
// range, deliberately NOT shared with Monitor's — see this file's header
// for why the two stay separate even though both are "user/session-
// created block rules".
//
// PER-SITE, not global: matches the panel's actual behavior (blocking
// badsite.com while browsing example.org does NOT block it on other.com —
// confirmed against the real 3P-Matrix-lite source, which is global, and
// explicitly NOT what this fork does; see CHANGELOG for the back-and-forth
// that settled this). Each rule's condition carries BOTH
// initiatorDomains: [site] AND requestDomains: [domain].
export const MATRIX_RULES_BASE_ID  = 10_000_000;
export const MATRIX_RULES_MAX_DNR  = 5_000;        // IDs 10 000 000 – 10 004 999
// Higher than every Security toggle priority (1 000 / 1 001) — see this file's "Undo mechanism" note
// above for why that ordering matters (9.9.1 ladder: Matrix 400 000).
// Two sub-tiers: CODE_PRIORITY slightly above ALL_PRIORITY so an explicit
// 3P-code decision takes precedence over a broader 3P-all decision for
// the resource types the two overlap on (script/frame) — if a
// domain somehow has both set to conflicting actions, the more specific
// one (code) wins, matching ordinary "more specific rule wins" intuition.
export const MATRIX_RULES_ALL_PRIORITY  = 400_000;     // 9.9.1 ladder: was 1 600 000
export const MATRIX_RULES_CODE_PRIORITY = 400_001;     // 9.9.1 ladder: was 1 600 001

// CRITICAL RESOURCE global exemption — BUILTIN_DOMAINS (see matrix-constants.js) auto-allowed
// everywhere. 9.9.1 ladder: 800 000 — ABOVE the Matrix panel (400 000), so the automatic whitelist
// beats a deliberate Matrix Block click, and above every list and Security toggle; below only the
// pause list (1 000 000). Two rules, not one: BUILTIN_DOMAINS encodes PER-RESOURCE-TYPE exemptions
// (some domains are frame-only or script-only — see js/core/builtin-whitelist-rules.js), so one
// rule is scoped to script and one to sub_frame, each with its own requestDomains list.
export const BUILTIN_WHITELIST_RULES_BASE_ID  = 11_000_000;
export const BUILTIN_WHITELIST_RULES_PRIORITY = 800_000;   // 9.9.1 ladder: was 1 550 000

// Built-in, non-user-configurable, DOMAIN-SCOPED exceptions for known
// upstream filter-list miscategorizations (v9.3.0) — architecturally
// DIFFERENT from BUILTIN_WHITELIST_RULES above, which is a GLOBAL "allow
// everywhere" trust list (a CDN legitimately used by countless unrelated
// sites, e.g. jsdelivr.net). This one is for the opposite shape of
// problem: a domain that is genuinely a tracker/third-party-embed
// SOMEWHERE, but is ALSO a specific site's own first-party
// infrastructure (e.g. redditstatic.com — Reddit's own asset CDN,
// wrongly caught in Disconnect's/Ghostery's tracker categories) — an
// unconditional global allow would be too broad (it would also exempt
// the domain when genuinely embedded as third-party elsewhere); a
// blanket safety-filter exclusion (removing it from every source list
// entirely — the previous approach, tools/data/top1m-tracker-
// crossref.json's reviewList) is too broad in the OTHER direction (loses
// the legitimate block everywhere else). condition.initiatorDomains
// (ABP equivalent: `$domain=`) is the correct scope: allow ONLY when the
// page itself is the specific site this domain serves.
//
// Applies uniformly regardless of which specific default-filter or
// worry-free checkbox is on/off — this sits above all of them (see
// js/core/builtin-fix-exceptions.js's own priority comment) and is not
// itself user-configurable, matching "not visible for users" per
// explicit request.
export const BUILTIN_FIX_EXCEPTIONS_BASE_ID = 11_000_002;

// ── RETIRED: Global Privacy Control (was 12 000 000) ─────────────────────
// Global Privacy Control was removed as a feature — see the retired-range
// note for 12 000 000 near the top of this file for why, and CHANGELOG
// for the full history. (10.0.3) The one-time migration that used these
// two constants to find and remove any lingering Sec-GPC modifyHeaders
// rule is itself removed, same as MONITOR_RULES_RETIRED_BASE_ID above —
// kept here, not deleted, purely as the permanent ID-reservation record.
/** @public read by tools/check-dnr-id-ranges.mjs for the permanent-ID-reservation collision check; no import consumer since the 10.0.3 migration removal */
export const GPC_RULES_RETIRED_BASE_ID = 12_000_000;

// ── RETIRED: "Block login-with" (was SECURITY_RULES_BASE_ID + 11/+12) ────
// "Block login-with" was removed as a feature (v8.5.7) — see CHANGELOG
// for the full history. Unlike GPC above, these two IDs were never a
// separate dedicated range — they sat inside the main security-slots
// numbering (SECURITY_RULES_BASE_ID + 11 and +12) — so the retired base
// is expressed relative to that same constant rather than a fresh round
// number, to keep the actual historical IDs correct in this permanent
// record. (10.0.3) The one-time migration that used these two constants
// to find and remove any leftover dynamic rule is itself removed, same
// as the two retired ranges above — kept here, not deleted, purely as
// the permanent ID-reservation record.
/** @public read by tools/check-dnr-id-ranges.mjs for the permanent-ID-reservation collision check; no import consumer since the 10.0.3 migration removal */
export const LOGIN_WITH_RULES_RETIRED_BASE_ID = SECURITY_RULES_BASE_ID + 11;
/** @public read by tools/check-dnr-id-ranges.mjs for the permanent-ID-reservation collision check; no import consumer since the 10.0.3 migration removal */
export const LOGIN_WITH_RULES_RETIRED_MAX_DNR = 2;

// ── Static filter-list priority ─────────────────────────────────────────────────
// Every compiled default ruleset (AdGuard Base, EasyList variants, HaGeZi, Kees1958, antiadblock,
// antiadmiral, … — see tools/build/filter-lists.mjs) carries this priority, blocks AND `@@` exceptions.
// History: 1 (implicit) → 1 000 (v8.3.6, to open room below) → 10 000 (9.9.1 ladder, specified by the owner).
// The room below is now used by the Worry-free extra lists (8 000), their off-switch (9 000) and the
// security-toggle rules (1 000); the adult-site headers (11 000) sit just above.
export const STATIC_FILTER_LIST_PRIORITY = 10_000;   // 9.9.1 ladder: was 1 000

// (11.1.3, owner's decision) The order WITHIN one static list's tier, as uBO and AdGuard apply it and as the user-rule
// tier already does (+10 block, +11 redirect, +30 allow): block < $redirect < "@@" exception < "$important". Each
// kind gets its own step above ITS OWN list's priority, so the order never depends on Chrome's tie-break (on equal
// priority Chrome lets a block beat a redirect, which left $redirect rules dead wherever any list blocked the same
// request — e.g. Ad-Shield's loader redirected to an empty script under HaGeZi's block of the same host). Highest step
// 10 003 for the default lists, 8 003 for the Worry-free extra lists (still below their 9 000 off-switch), never near
// the next tier up. Applied by tools/build/rule-parsers.mjs parseBlockRule(). $removeparam redirects stay at the
// list's own priority (a blocked request needs no parameters stripped).
export const STATIC_REDIRECT_PRIORITY_OFFSET  = 1;   // $redirect=<bundled file>: above the plain blocks
export const STATIC_EXCEPTION_PRIORITY_OFFSET = 2;   // "@@" exceptions (allow / allowAllRequests): above redirects
// (10.7.6) "$important" in a static list: above that tier's "@@" exceptions (AdGuard's meaning) and nothing else.
// Was 1 until 11.1.3, when exceptions still shared the list's own priority.
export const STATIC_IMPORTANT_PRIORITY_OFFSET = 3;

// ── Worry-free extra blocklist (v8.3.6 — RESERVED, not yet wired to any
// v8.3.7 — RESERVED tier now BUILT: reserved-tier extra blocklist (v8.3.6)
// plus a TLD-based default-deny/allowlist 3P script+frame block, modeled
// directly on 3P-Matrix-lite's own proven Level-3 mechanism (blanket
// third-party block + per-TLD allow rules override it — NOT a TLD
// blacklist enumeration; confirmed by reading that project's own
// rule-builder.js before building this, not assumed from its feature
// name). See tools/build-rulesets.mjs's buildWorryFreeExtraBlocklist-
// SourceText() for the TLD-safe-list content itself.
//
// RE-SPACED (v9.6.0) — every item below now gets its own 10-wide window
// (block/allow near the bottom, its own SUPPRESS priority near the top of
// that window) instead of the old back-to-back numbering (100/110/120…).
// This is the same fix already proven for 5 other Worry-free items
// (AdGuard tracking/Easylist/Peter Lowe/Disconnect/Ghostery, see
// CHANGELOG's "five items given real, independently-safe suppression
// rules") — an unconditional allow at one shared ceiling can't
// distinguish "just this item" from "everything at this tier," so
// turning one item off could silently suppress an unrelated sibling that
// was still on. Those 5 items have a fixed domain list to scope their
// suppression rule to (condition.requestDomains); these items don't (a
// blanket 3P block, a CSP-sandbox download block, a Permissions-Policy
// header) — so the equivalent fix here is a priority WINDOW instead: each
// item's own SUPPRESS priority sits strictly between that item's own
// rule(s) and the next item's, so it can only ever outrank its own item.
// (AdShield Evolution rename pass) RETIRED — were blockScpTldBlock's
// "blanket 3P block" component's two priorities (ruleset_worryfree_3pblock
// / ruleset_worryfree_tldallow, confirmed via their condition shape —
// domainType thirdParty, resourceTypes script+sub_frame — matching the
// SAME suppression rule, WORRY_FREE_3PBLOCK_RULES_BASE_ID above, that
// also covers the download-block component). The checkbox itself and
// every mechanism behind it were removed per explicit request — see
// CHANGELOG_HISTORY.md for the full entry. Kept here, unused, per this
// file's own convention for retired priorities.
/** @public Reserved/retired DNR priority — never reassigned; see tools/check-dnr-id-ranges.mjs's Worry-free band scan. */
export const WORRY_FREE_EXTRA_BLOCKLIST_PRIORITY = 100;
/** @public Reserved/retired DNR priority — never reassigned; see tools/check-dnr-id-ranges.mjs's Worry-free band scan. */
export const WORRY_FREE_EXTRA_TLD_ALLOW_PRIORITY = 101;
// Slot 105 (this item's SUPPRESS priority in the window scheme above) is
// reserved but unused: WORRY_FREE_EXTRA_SUPPRESS_PRIORITY was exported and
// never read anywhere, so it was removed (audit 9.7.5). Re-add it here, at
// 105, if this item ever gets a suppression rule.

// (AdShield Evolution rename pass) RETIRED — were blockScpTldBlock's own
// three priorities (static block, static TLD-allow, session suppress).
// The checkbox itself and every mechanism behind it were removed per
// explicit request — see CHANGELOG_HISTORY.md for the full entry. Kept
// here, unused, per this file's own convention for retired priorities
// (see RETIRED_ADVANCED_PRIORITY_MIN/MAX below, the precedent this
// follows). Not reassigned to a new feature, so a stale rule at one of
// these priorities (impossible here anyway — v0.0.1 never shipped these
// rules to a real install) stays unambiguous to identify if ever seen.
/** @public Reserved/retired DNR priority — never reassigned; see tools/check-dnr-id-ranges.mjs's Worry-free band scan. */
export const WORRY_FREE_DOWNLOAD_BLOCKLIST_PRIORITY = 110;
/** @public Reserved/retired DNR priority — never reassigned; see tools/check-dnr-id-ranges.mjs's Worry-free band scan. */
export const WORRY_FREE_DOWNLOAD_TLD_ALLOW_PRIORITY = 111;
/** @public Reserved/retired DNR priority — never reassigned; see tools/check-dnr-id-ranges.mjs's Worry-free band scan. */
export const WORRY_FREE_DOWNLOAD_SUPPRESS_PRIORITY  = 115;

// ── Worry-free extra AD/TRACKER LISTS priority (v9.7.9; moved to 8 000 in 9.9.1) ──────────────
// The extra lists (AdGuard tracking servers, Kees1958, Peter Lowe — the lists that remain Worry-free
// opt-ins since 10.0.7) must be able to block
// anything the Worry-free tiers below them would let through. Required order, low → high:
//   blanket 3P block and its TLD allows (100-111)
//   < Privacy/Security headers and their allows/off-switches (120-135)
//   < Medium tier (300-320), including its safe-domain band
//   < security-toggle rules (1 000)
//   < THESE LISTS (8 000)
//   < per-list off-switch (9 000), so unticking a list still turns it off
//   < default filter lists (10 000), so a default-list `@@` exception still wins.
// WHY 8 000 (9.9.1): at 170 (9.7.9) they beat the Low-tier TLD allows, but the Medium tier's safe-domain
// band (320, allow, ALL resource types) outranked them — measured on the shipped rules, only 27% of the
// lists' rules still applied to .com/.net/.org hosts whenever the Medium tier was on.
export const WORRY_FREE_EXTRA_LISTS_PRIORITY = 8_000;   // 9.9.1 ladder: was 170 (below the Medium-tier band at 320)
// (10.7.1) ruleset_tracking_servers_allowlist — AdGuard SpywareFilter allowlist.txt exceptions that hit a domain
// of Kees1958 / Peter Lowe / AdGuard tracking servers (tools/build/tracking-allowlist-source.mjs). EQUAL to the
// extra lists, never above: DNR has no per-ruleset allow, so an allow here wins over every block at <= 8 000
// (the three extra lists — the intent — and the removeparam pair at 500/501) and over nothing at the default
// lists (10 000) or above. tools/check-dnr-priority-order.mjs asserts the equality.
/** @alias Named role: the hidden allow list sits at exactly the extra lists' priority (tie -> allow wins); both names are imported. */
export const WORRY_FREE_EXTRA_LISTS_ALLOWLIST_PRIORITY = WORRY_FREE_EXTRA_LISTS_PRIORITY;
// (10.0.7) ruleset_adguard_base_removeparam ("AdGuard remove tracking parameters") — a pure $removeparam
// (redirect-action) list with no domain list to scope a suppression rule to. Its priority pair sits
// deliberately LOW: below the per-list off-switch (9 000), the Worry-free extras (8 000) and any
// default-list `@@` exception (10 000) — all of which still take precedence — because this is a narrow,
// single-purpose suppression. The suppression rule (+1) beats the list itself while the toggle is off.
export const WORRY_FREE_ADGUARD_REMOVEPARAM_PRIORITY = 500;
export const WORRY_FREE_ADGUARD_REMOVEPARAM_SUPPRESS_PRIORITY = 501;
// The retired advanced-tier priority band (see the RETIRED note by the SCP
// constants). Declared so tools/check-dnr-priority-order.mjs can assert that
// nothing is placed inside it, instead of the band living only in comments.
export const RETIRED_ADVANCED_PRIORITY_MIN = 140;
export const RETIRED_ADVANCED_PRIORITY_MAX = 165;

// (AdShield Evolution rename pass) RETIRED — was blockScpTldBlock's
// SECOND, independent mechanism (a forced-download block, shared probe
// with the Advanced tier's own row 1 — see RESPONSE_HEADERS_SUPPORT_
// PROBE_RULE_ID below, which stays, since the probe itself is still
// used elsewhere... actually: both of its only two consumers,
// blockScpTldBlock here and the Advanced tier's row 1, were removed in
// the same pass — see forced-download-detection.js's own header for
// whether that module is still live). Kept here, unused, per this
// file's own convention for retired ids.
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const WORRY_FREE_DOWNLOAD_HEADER_BLOCK_RULE_ID = 13_000_021;

// SCP (Sandboxed Content Permissions) tier — Privacy & Security tab's
// "Low website breakage risk" group, items 1/2 (mic/camera/screen-
// capture/clipboard-read; Bluetooth/Serial/HID/USB/local-network). These block
// rules cover the WEBSITE (main_frame) and every frame (sub_frame), first- or
// third-party, outside the safe-region TLD list — judged by the real top-level
// domain of the page/frame (tools/build-rulesets.mjs safeRegionTldUrlFilter()).
// No domainType restriction (CHANGELOG bug #5): SCP must also restrict a
// site's own first-party permission requests. (9.6.8 briefly restricted them to
// third-party frames; reverted in 9.6.9.)
export const SCP_PRIVACY_BLOCKLIST_PRIORITY  = 120;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
export const SCP_PRIVACY_TLD_ALLOW_PRIORITY  = 121;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
export const SCP_PRIVACY_SUPPRESS_PRIORITY   = 125;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)

export const SCP_SECURITY_BLOCKLIST_PRIORITY = 130;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
export const SCP_SECURITY_TLD_ALLOW_PRIORITY = 131;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
export const SCP_SECURITY_SUPPRESS_PRIORITY  = 135;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)

// RETIRED (v9.6.8): the advanced ("Medium") tier — priorities 140–165 (two
// header items at 140–155, the block-all-3P item at 160–165) — was removed
// entirely. The band 140–165 is left unused and is NOT to be reassigned to a
// new feature (same convention as the retired ids below). NOTE: CHANGELOG
// 9.6.8 records the retirement but gives no reason; the stated rationale
// ("a stale rule left by an older version stays unambiguous to identify") is
// carried over from the retired-ID convention (CHANGELOG 9.2.1 / 9.7.7). The
// extra lists therefore use 8 000 (170 before 9.9.1), not a number inside this band.

// Whole-tier ceiling — suppresses EVERYTHING below at once, only during
// default-mode browsing (no active Worry-free session at all). Distinct
// from every *_SUPPRESS_PRIORITY above, which each suppress only their
// own single item while a session IS active. Bumped 150 -> 200 to clear
// the re-spaced band above; 9.9.1: 200 -> 9 000, between the extra lists (8 000) and the default lists
// (10 000). Only ever referenced by name elsewhere in the codebase, never the literal number.
// "@@site$worryfree" (10.0.0, owner's decision): the site is outside Worry-free ALTOGETHER — the extra lists
// (8 000) and every Worry-free protection below them. Just above the per-list off-switch (9 000) and just
// below the default lists (10 000), so the person's own default-list/Matrix/custom rules and the Allow-list
// directive still apply. "@@site$saferegions" deliberately stays BELOW the extra lists: it only exempts the
// protections outside safe regions, never the filter lists. Only referenced by name (worryfree-manager.js).
export const WORRY_FREE_SITE_ALLOW_PRIORITY = 9_500;

// (10.7.16, owner's decision 2026-11-19) CMP loader blocks — js/data/cmp-loader-blocks.js, kept in step with
// Seamless surfing's DECLINE mode by js/core/cmp-loader-block-manager.js. SESSION rules (reset with the browser,
// exactly like the Seamless surfing session that owns them; re-added at start-up while the session still runs).
// Priority 9 200: below the default lists (10 000), so a curated list @@ for a CMP loader still wins; below
// "@@site$worryfree" (9 500), so a site the person put outside Worry-free is left alone; far below the Allow-list
// / site-off directive (1 000 000), the person's own rules and the Quick-fixes list.
// ID CHECK: 20_000_000 verified free — every *_BASE_ID / *_RULE_ID in this file is below 20_000_000.
export const CMP_LOADER_BLOCK_PRIORITY = 9_200;
export const CMP_LOADER_BLOCK_RULES_BASE_ID = 20_000_000;
export const CMP_LOADER_BLOCK_RULES_MAX = 10;   // one id per CMP_LOADER_BLOCKS entry; room to grow

// (11.0.0, owner's decisions 2026-11-19) Cookie-notice BLOCK rules — AdGuard Cookie Notices + EasyList Cookie specific
// block, precompiled by tools/build/cookie-notice-sources.mjs into COOKIE_NOTICE_BLOCK_FILE (js/data/cookie-notice-sets.js)
// and loaded as SESSION rules by js/core/cmp-loader-block-manager.js only while Seamless surfing DECLINES banners, with
// every saved cookie-clicker rule site in excludedInitiatorDomains (saved rules prevail). Same priority band as the CMP
// loader blocks and for the same reasons (a curated @@, "@@site$worryfree", the Allow list and site-off still win).
// The MAX is a build-time guard (the build fails above it) and the size of the reserved id range; Chrome allows
// 5 000 session rules in total and uBD's other session rules are a handful.
// ID CHECK: 20_100_000 – 20_102_999 verified free (CMP loader blocks end at 20_000_009; nothing else at or above 20 000 000).
export const COOKIE_NOTICE_BLOCK_PRIORITY = 9_200;
export const COOKIE_NOTICE_BLOCK_RULES_BASE_ID = 20_100_000;
export const COOKIE_NOTICE_BLOCK_RULES_MAX = 3_000;

export const WORRY_FREE_EXTRA_ALLOW_PRIORITY = 9_000;   // 9.9.1 ladder: was 200. Just above the extras (8 000), just BELOW the default lists (10 000)

// ID range for the WORRY_FREE_EXTRA_ALLOW_PRIORITY (160) allow rule — a
// SESSION-scoped DNR rule (chrome.declarativeNetRequest.updateSessionRules),
// added on install/startup and removed for the duration of a Worry-free
// session, re-added when that session ends or expires. Session (not
// dynamic) chosen deliberately: this rule's whole purpose is "present by
// default, absent during an active session" — a session rule cleanly
// resets to nothing on browser restart, matching "default mode" being the
// browser's own natural resting state, with no separate re-add-on-startup
// logic needed the way a dynamic rule would require.
// RETIRED (v9.1.7) — was the unconditional (condition:{}) suppression
// rule for the "extra filters" ruleset (adult-site ad servers +
// transcend.io). That ruleset and this suppression rule are both removed
// entirely, per explicit request — not rescoped, not replaced. Kept as a
// constant, unused, per this file's own convention for retired ids (see
// MONITOR_RULES_RETIRED_BASE_ID's header note). (10.0.3) A stale rule at
// this id from an older version used to be cleaned up by the range-based
// orphan cleanup in background.js's runVersionMigration() (v9.1.5); that
// cleanup step was removed along with every other pre-10.0.3 upgrade
// step — see CHANGELOG_HISTORY.md's 10.0.3 entry — so nothing references
// this constant anymore, now not even for cleanup.
/** @public retired DNR range — read by name from source by tools/check-dnr-id-ranges.mjs (keeps the band reserved); background.js's unused import of it was removed in the 10.6.4 audit. */
export const WORRY_FREE_EXTRA_RULES_BASE_ID = 13_000_000;

// RETIRED (v9.6.0 suppression-rule rebuild — see worry-free-extra-
// manager.js's own header for the full incident writeup): these 6 ids
// (WORRY_FREE_TLDALLOW_RULES_BASE_ID, WORRY_FREE_DOWNLOADBLOCK_RULES_
// BASE_ID, WORRY_FREE_DOWNLOAD_TLDALLOW_RULES_BASE_ID, SCP_PRIVACY_
// TLDALLOW_RULES_BASE_ID, SCP_SECURITY_TLDALLOW_RULES_BASE_ID, and
// below, the three advanced-tier *_TLDALLOW_* ids, removed in v9.6.8) used
// to each back their own SEPARATE suppression-rule entry (one per
// ruleset file: a block ruleset AND its own TLD-allow ruleset each got
// one). The rebuild consolidated to ONE suppression rule per TOGGLEABLE
// ITEM instead (using only the corresponding *_BLOCK_RULES_BASE_ID),
// since a single condition-scoped allow at that item's own priority
// correctly suppresses both of that item's rulesets at once — no need
// for two. Kept as unused constants, per this file's own convention for
// retired ids (see MONITOR_RULES_RETIRED_BASE_ID's header note) — not
// reassigned to a new feature, so an old stale session rule at one of
// these ids (from a pre-rebuild version) is unambiguous to identify.
// (AdShield Evolution rename pass) RETIRED — was blockScpTldBlock's own
// session suppression-rule id ("Block third-party scripts, frames and
// downloads outside safer regions", the Low group's own 3P/download
// block). The checkbox itself, its static block ruleset, its TLD-allow
// ruleset, and its second ("forced-download") mechanism were all removed
// per explicit request — see CHANGELOG_HISTORY.md for the full entry.
// Kept here, unused, per this file's own convention for retired ids (see
// MONITOR_RULES_RETIRED_BASE_ID's header note).
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const WORRY_FREE_3PBLOCK_RULES_BASE_ID = 13_000_001;
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const WORRY_FREE_TLDALLOW_RULES_BASE_ID = 13_000_002;
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const WORRY_FREE_DOWNLOADBLOCK_RULES_BASE_ID = 13_000_003;
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const WORRY_FREE_DOWNLOAD_TLDALLOW_RULES_BASE_ID = 13_000_004;

// New independent suppression rules (Privacy &
// Security redesign) — SCP privacy/security, same "own ruleset, own
// suppression rule" treatment, same reasoning: a blanket modifyHeaders
// action and its own allow-with-exceptions override are two different
// rule shapes each, not one feature split for UI convenience. Both
// pairs gated by blockScpPrivacy/blockScpSecurity as settingKey, with
// blockScpFingerprint as their shared groupMasterKey (see
// worry-free-extra-manager.js's SUPPRESSION_RULES and config.js's own
// comments on these three keys).
//
// ID CHECK: 13_000_005 through 13_000_010 are already taken by
// WORRY_FREE_SOCIAL_RULES_BASE_ID (retired) / WORRY_FREE_ADGUARD_
// TRACKING/EASYLIST_ADSERVERS/PETERLOWE/DISCONNECT_OTHER_RULES_BASE_ID
// / WORRY_FREE_GHOSTERY_OTHER_RULES_RETIRED_BASE_ID below — confirmed
// by listing every numeric constant in this file before picking these
// four, not assumed from the visually-nearby WORRY_FREE_DOWNLOAD_
// TLDALLOW_RULES_BASE_ID (13_000_004) alone, which is what caused a
// real collision on the first attempt at this addition.
const SCP_PRIVACY_BLOCK_RULES_BASE_ID      = 13_000_011;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const SCP_PRIVACY_TLDALLOW_RULES_BASE_ID   = 13_000_012;
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const SCP_SECURITY_BLOCK_RULES_BASE_ID     = 13_000_013;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const SCP_SECURITY_TLDALLOW_RULES_BASE_ID  = 13_000_014;

// RETIRED (v9.6.8) — the advanced ("Medium") tier's six session-rule ids,
// 13_000_015 through 13_000_020 (SCP_PRIVACY_MEDIUM_BLOCK/TLDALLOW,
// SCP_SECURITY_MEDIUM_BLOCK/TLDALLOW, WORRY_FREE_3P_BLOCK_ALL/TLDALLOW_ALL),
// are permanently unused: the feature was removed. Session rules are cleared
// on every extension update, so nothing stale can survive; the range is not
// to be reassigned to a new feature.
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const ADVANCED_TIER_RETIRED_BASE_ID = 13_000_015;

// RETIRED (v9.1.7) — was the unconditional (condition:{}) suppression
// rule for the Disconnect+Ghostery social media block ruleset (sixth
// independent suppression rule, v8.6.12 — see tools/build-social-media-
// list.mjs). That ruleset and this suppression rule are both removed
// entirely, per explicit request — not rescoped, not replaced. Same
// retirement reasoning as WORRY_FREE_EXTRA_RULES_BASE_ID above.
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const WORRY_FREE_SOCIAL_RULES_BASE_ID = 13_000_005;

// Seventh through eleventh independent suppression rules (v9.1.4) — five
// new, individually-toggleable worry-free items (AdGuard tracking
// servers, EasyList advertising servers, Peter Lowe's, Disconnect
// Analytics+Cryptomining+Fingerprinting combined, Ghostery Analytics+
// Video+AdultAdvertising combined). ARCHITECTURALLY DIFFERENT from the
// six above: each of these gets a suppression rule SCOPED to its own
// ruleset's exact domain list (condition.requestDomains), not the
// unconditional condition:{} shape every rule above uses — see
// worry-free-extra-manager.js's own header for why the unconditional
// shape is a real correctness hazard once items are independently
// toggleable (the exact reason the original six checkboxes were
// consolidated to two), and why these five instead get the properly-
// scoped version rather than joining that consolidation.
export const WORRY_FREE_ADGUARD_TRACKING_RULES_BASE_ID  = 13_000_006;
// RETIRED (10.0.7): ruleset_easylist_adservers (EasyList advertising servers) was removed, per explicit
// request. Its id is kept, unused, and never reassigned.
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const WORRY_FREE_EASYLIST_ADSERVERS_RULES_RETIRED_BASE_ID = 13_000_007;
// RESTORED (10.1.1): ruleset_peterlowe (Peter Lowe's list) was retired in 10.0.7 as redundant with HaGeZi
// Multi light and is back as a Worry-free opt-in, per explicit request. It takes its OWN former id again
// (same ruleset, same purpose, so no other meaning is attached to the number).
export const WORRY_FREE_PETERLOWE_RULES_BASE_ID          = 13_000_008;
// RETIRED (10.7.1): ruleset_disconnect_other (Disconnect Cryptomining + Fingerprinting) was removed, per
// explicit request. Its id is kept, unused, and never reassigned; worry-free-extra-manager.js removes a
// leftover session rule with this id (RETIRED_SUPPRESSION_RULE_IDS).
export const WORRY_FREE_DISCONNECT_OTHER_RULES_RETIRED_BASE_ID = 13_000_009;

// RETIRED (this release) — was the domain-scoped suppression rule for
// ruleset_ghostery_other (v9.1.4's SCOPED_SUPPRESSION_RULES entry,
// worryFreeGhosteryOtherEnabled). That ruleset and this suppression rule
// are both removed entirely, per explicit request — not rescoped, not
// replaced. Same retirement reasoning as WORRY_FREE_EXTRA_RULES_BASE_ID/
// WORRY_FREE_SOCIAL_RULES_BASE_ID above; kept here, unused, so this id
// number is never reassigned to something else.
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const WORRY_FREE_GHOSTERY_OTHER_RULES_RETIRED_BASE_ID = 13_000_010;

// Domain-scoped suppression rules for the two EasyList site-specific lists
// added this release. They share ONE dashboard checkbox and ONE settingKey
// with ruleset_easylist_adservers (worryFreeEasylistAdserversEnabled — the
// three lists are governed together, per explicit request), but each
// ruleset still needs its OWN suppression rule: a suppression rule's
// condition mirrors exactly one ruleset's own domains, and an earlier
// shared-unconditional-allow design had precisely the "can't tell this
// item from its siblings" gap this file's own history documents fixing.
// ID CHECK — 13_000_022/023. Picking an id in this band needs BOTH of:
//   1. not equal to any existing *_BASE_ID / *_RULE_ID constant here
//      (13_000_000..014 and 13_000_021 are taken), and
//   2. outside 13_000_015..020, the band ADVANCED_TIER_RETIRED_BASE_ID
//      stands for — retired with the v9.6.8 advanced-tier removal and
//      asserted empty by tools/test-core-modules-dry-run.mjs, so those
//      six ids are unusable even though no constant names five of them.
// Both were got wrong here on the way: 13_000_011/012 collided with
// SCP_PRIVACY_BLOCK/TLDALLOW (caught by check-dnr-id-ranges.mjs's
// uniqueness check) and 13_000_016/017 landed inside the retired band
// (caught by the dry-run). The band is neither contiguous nor
// highest-id-is-the-end, so read the whole file rather than continuing
// from the last constant that happens to be nearby.
// RETIRED (10.0.7): ruleset_easylist_adult_specific (its content now lives in ruleset_annoyances) and
// ruleset_easylist_thirdparty were removed. Ids kept, unused, never reassigned.
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const WORRY_FREE_EASYLIST_ADULT_SPECIFIC_RULES_RETIRED_BASE_ID = 13_000_022;
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const WORRY_FREE_EASYLIST_THIRDPARTY_RULES_RETIRED_BASE_ID     = 13_000_023;

// RETIRED (10.0.7): the domain-scoped suppression rule for ruleset_annoyances. That list is now an
// always-on Built-in default (no Worry-free gating), so it has no suppression rule any more. The id is
// kept, unused, and never reassigned.
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const WORRY_FREE_ANNOYANCES_RULES_RETIRED_BASE_ID = 13_000_024;

// (10.0.7) Suppression ids for the two lists that moved INTO the Worry-free opt-in rows.
// ID CHECK — 13_000_025/026: read the whole band above first (13_000_000..024 taken/retired,
// 13_000_015..020 unusable); 025 and 026 are the next free ids, confirmed by grep + check-dnr-id-ranges.
//   025 — ruleset_kees1958: domain-scoped suppression (worryFreeKees1958Enabled)
//   026 — ruleset_adguard_base_removeparam: no-tier suppression (worryFreeAdguardRemoveparamEnabled)
export const WORRY_FREE_KEES1958_RULES_BASE_ID = 13_000_025;
export const WORRY_FREE_ADGUARD_REMOVEPARAM_RULES_BASE_ID = 13_000_026;
// (11.0.0, owner's decision) HaGeZi Light moved from the always-on default lists into the Seamless surfing tracker
// lists. ID CHECK — 027: the next free id after 026 (grep of the whole 13_000_0xx band + check-dnr-id-ranges).
//   027 — ruleset_hagezi_light: domain-scoped suppression (worryFreeHageziEnabled)
export const WORRY_FREE_HAGEZI_RULES_BASE_ID = 13_000_027;


// (10.0.3) Declared separately from GPC_RULES_RETIRED_BASE_ID above (a
// pre-existing layout, not something this pass changed) — same permanent
// ID-reservation record, same reason: see GPC_RULES_RETIRED_BASE_ID's own
// comment, near the top of this file.
/** @public read by tools/check-dnr-id-ranges.mjs for the permanent-ID-reservation collision check; no import consumer since the 10.0.3 migration removal */
export const GPC_RULES_RETIRED_MAX_DNR = 1;

// ── RETIRED (9.9.1): Strict 3P block for high-risk sites (was v8.4.10) ───────────────
// Removed in 9.9.1 by decision. It blocked ALL third-party frames, and all third-party scripts
// except ones whose hostname contained "cdn" (plus a spankbang.com/sb-cd.com exception), on the
// 24 high-risk sites during a Worry-free session, at priority 1 900 000-1 900 002. Why it went:
// the "cdn" exception was a hostname SUBSTRING test, not "the site's own CDN", and its allow
// rule outranked every filter list, so 1 787 hostnames that the shipped lists block (for example
// kinkadservercdn.com, ad-serve.b-cdn.net) were force-allowed on those sites. The eval block,
// Permissions-Policy headers and fingerprint mitigation for the same sites are UNCHANGED.
// The band 14 000 000-14 999 999 and the three priorities are now permanently retired — never
// reassign them to a new feature. STRICT_3P_RULES_BASE_ID stays exported ONLY so
// tools/check-dnr-id-ranges.mjs keeps the band reserved; nothing builds rules here any more.
// (audit 10.6.4: this comment used to name a background.js upgrade migration that cleared lingering
// session rules in the band — that migration was removed with every pre-10.0.3 step, so it was stale.)
/** @public retired DNR range — read by tools/check-dnr-id-ranges.mjs. */
export const STRICT_3P_RULES_BASE_ID = 14_000_000;
/** @public retired id, kept named so tools/check-dnr-id-ranges.mjs keeps the band reserved and collision-checked; never reassign. */
export const STRICT_3P_RETIRED_RULE_ID_1 = 14_000_000;   // was the third-party FRAME block
/** @public retired id, see STRICT_3P_RETIRED_RULE_ID_1. */
export const STRICT_3P_RETIRED_RULE_ID_2 = 14_000_001;   // was the third-party SCRIPT block
/** @public retired id, see STRICT_3P_RETIRED_RULE_ID_1. */
export const STRICT_3P_RETIRED_RULE_ID_3 = 14_000_002;   // was the "cdn"-hostname script allow
/** @public retired id, see STRICT_3P_RETIRED_RULE_ID_1. */
export const STRICT_3P_RETIRED_RULE_ID_4 = 14_000_003;   // was the spankbang.com / sb-cd.com allow

// $saferegions dynamic rules (v9.6.0) — per-domain exemptions entered on
// the Allow (white) list tab (see site-mode-parser.js's
// extractOptionLinesFromText()), applied at RUNTIME via
// dnr.updateDynamicRules() rather than baked into a static ruleset at
// build time (unlike badfilter-quick-fixes.txt's own $saferegions
// entries, which ARE build-time). One fixed rule per protected item —
// NOT one per domain: condition.requestDomains accepts an array, same
// proven shape builtin-whitelist-rules.js and worry-free-extra-manager.js's
// SCOPED_SUPPRESSION_RULES already use — so all of a person's
// $saferegions domains fit in one rule per item, rebuilt (remove+re-add)
// whenever the domain list changes. Each of the 4 ACTIVE items reuses
// that SAME item's own existing TLD_ALLOW_PRIORITY constant (no new
// priorities needed) and the same condition shape (domainType/
// resourceTypes) as that item's own static per-TLD allow rule — see
// saferegions-manager.js. (Was 7 before v9.6.8 retired the advanced
// tier's 3 — offsets 4-6 stay reserved-but-unused there, not reassigned;
// see that file's own RETIRED_RULE_IDS. This comment said "7" for a
// while after that retirement — corrected here, tools/check-dnr-id-
// ranges.mjs now derives the real count from source instead of trusting
// a number here at all.)
// ID CHECK: 15_000_000 verified free — confirmed by listing every
// *_BASE_ID constant in this file first, not assumed from proximity to
// STRICT_3P_RULES_BASE_ID alone (see the two ID CHECK notes above this
// one for why that assumption already caused a real collision once).
/** @public DNR range definition — read from source by tools/check-dnr-id-ranges.mjs. */
export const SAFEREGIONS_DYNAMIC_RULES_BASE_ID = 15_000_000;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
// v9.7.1: the 4 active + 3 retired-but-reserved ids used to be computed
// as SAFEREGIONS_DYNAMIC_RULES_BASE_ID + offset in saferegions-manager.js,
// with the offsets themselves as bare numbers in a data array — same
// B1 violation as STRICT_3P_RULES above, fixed the same way: named here,
// as plain literals, so tools/check-dnr-id-ranges.mjs can derive the real
// footprint by scanning this file's own exports instead of parsing an
// arbitrary array-literal shape out of saferegions-manager.js (which is
// exactly the kind of pattern a future refactor could silently break —
// this file's earlier "might be under-counting" safety net existed
// specifically because of that fragility, and is no longer needed here).
// (AdShield Evolution rename pass) RETIRED — were the $saferegions dynamic
// exemption rules for blockScpTldBlock's two components (3P block,
// download block). The checkbox itself and every mechanism behind it
// were removed per explicit request — see CHANGELOG_HISTORY.md for the
// full entry. Dynamic rules PERSIST across browser restarts and
// extension updates, so an install that set $saferegions domains before
// this pass may still have these two registered — saferegions-manager.js
// removes them on every apply (Chrome ignores ids that don't exist), same
// RETIRED_RULE_IDS treatment as the v9.6.8 advanced-tier retirement
// below. Kept here, unused, per this file's own convention.
/** @public Reserved/retired DNR id — never reassigned; cleaned up by saferegions-manager.js's RETIRED_RULE_IDS. */
export const SAFEREGIONS_EXTRA_TLD_ALLOW_RULE_ID        = 15_000_000;
/** @public Reserved/retired DNR id — never reassigned; cleaned up by saferegions-manager.js's RETIRED_RULE_IDS. */
export const SAFEREGIONS_DOWNLOAD_TLD_ALLOW_RULE_ID     = 15_000_001;
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const SAFEREGIONS_SCP_PRIVACY_TLD_ALLOW_RULE_ID  = 15_000_002;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const SAFEREGIONS_SCP_SECURITY_TLD_ALLOW_RULE_ID = 15_000_003;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
// RETIRED (v9.6.8): belonged to the advanced ("Medium") tier (two header
// items + the block-all-3P item), which was removed. Dynamic rules
// PERSIST across browser restarts and extension updates, so an install
// that ran v9.6.0-9.6.7 with $saferegions domains may still have these
// three registered — saferegions-manager.js removes them on every apply
// (Chrome ignores ids that don't exist). Numbered rather than named for
// what they used to protect: which of the two retired header items was
// privacy vs. security at these specific offsets isn't independently
// re-confirmed here, and a guessed specific name would be worse than an
// honest generic one. Never reassign these three to a new feature.
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const SAFEREGIONS_RETIRED_ADVANCED_RULE_ID_1 = 15_000_004;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const SAFEREGIONS_RETIRED_ADVANCED_RULE_ID_2 = 15_000_005;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const SAFEREGIONS_RETIRED_ADVANCED_RULE_ID_3 = 15_000_006;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)

// (Priorities 1 900 000–1 900 002 belonged to the retired strict 3P block — see the RETIRED note
// above the STRICT_3P_* ids. Left unused, not reassigned. HIGH_RISK_HEADERS_PRIORITY below stays.)

// ── High-risk-site Permissions-Policy headers (v9.6.4) ─────────────────────
// The two Permissions-Policy header protections (privacy: camera/mic/
// screen-capture/clipboard; security: Bluetooth/Serial/HID/USB/local-
// network) applied to the 24 high-risk sites (the list the retired strict 3P
// block also covered) — the "Enforce safe-regions protections on high-risk
// websites" checkbox on the Privacy & Security tab (storage key
// blockAdultFingerprinting, unchanged). See js/core/worry-free-high-risk-
// headers-manager.js for the full account.
//
// ID range: 16_000_000 is the next unused top-level range after
// SAFEREGIONS_DYNAMIC_RULES_BASE_ID (15_000_000) — verified by listing
// every *_BASE_ID constant in this file, not assumed. 2 slots used
// (privacy, security); 10 reserved so check-dnr-id-ranges.mjs's
// pairwise-overlap check has a conservative upper bound.
export const HIGH_RISK_HEADERS_RULES_BASE_ID = 16_000_000;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
/** @public DNR range definition — read from source by tools/check-dnr-id-ranges.mjs. */
export const HIGH_RISK_HEADERS_RULES_SLOTS   = 10;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)

// ── $worryfree per-domain exemptions (this release) ──────────────────────────
// "@@example.com$worryfree" on the Allow list exempts ONE website from the
// Worry-free protections on the Privacy & Security tab — both halves: the
// Worry-free scriptlets (handled by excludeMatches in compiled-filters.js,
// no DNR id needed) and the Worry-free DNR blocklists (these allow rules).
//
// DELIBERATELY ITS OWN RANGE, not the retired 13_000_002-13_000_004 ids
// (see the RETIRED note above): those may still be registered in a real
// browser profile from a pre-rebuild version, so reusing them would make a
// stale rule indistinguishable from a current one — exactly what that note
// says never to do.
//
// NOT the same thing as SAFEREGIONS_* above, which exempts a REQUEST
// DESTINATION (requestDomains) from the safe-regions-scoped protections.
// These exempt the SITE THE USER IS ON (initiatorDomains for the
// third-party blockers, main_frame/sub_frame for the header items), which
// is what "exempt this website" means to the person typing it.
//
// ID CHECK (this file's own convention): 18_000_000 verified free against
// every *_BASE_ID and *_RULE_ID constant in this file — the highest
// previously used range is 17_000_xxx (advanced tier). Uniqueness is also
// enforced mechanically by tools/check-dnr-id-ranges.mjs.
/** @public DNR range definition — read from source by tools/check-dnr-id-ranges.mjs. */
export const WORRYFREE_DYNAMIC_RULES_BASE_ID = 18_000_000;
/** @public DNR range definition — read from source by tools/check-dnr-id-ranges.mjs. */
export const WORRYFREE_DYNAMIC_RULES_SLOTS = 10;   // 5 used, 5 reserved
// One per Worry-free DNR item, mirroring the SAFEREGIONS_* set one-for-one
// so the two stay comparable at a glance (C21).
// (AdShield Evolution rename pass) RETIRED — were blockScpTldBlock's two
// $worryfree per-site exemption rules (3P block, download block). The
// checkbox itself and every mechanism behind it were removed per explicit
// request — see CHANGELOG_HISTORY.md for the full entry. Dynamic rules
// PERSIST across browser restarts and extension updates, so an install
// that set a $worryfree exemption before this pass may still have these
// two registered — worryfree-manager.js now removes them on every apply
// too (RETIRED_RULE_IDS, same treatment saferegions-manager.js already
// had for its own v9.6.8 retirement). Kept here, unused, per this file's
// own convention.
/** @public Reserved/retired DNR id — never reassigned; cleaned up by worryfree-manager.js's RETIRED_RULE_IDS. */
export const WORRYFREE_EXTRA_ALLOW_RULE_ID        = 18_000_000;
/** @public Reserved/retired DNR id — never reassigned; cleaned up by worryfree-manager.js's RETIRED_RULE_IDS. */
export const WORRYFREE_DOWNLOAD_ALLOW_RULE_ID     = 18_000_001;
const WORRYFREE_SCP_PRIVACY_ALLOW_RULE_ID  = 18_000_002;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
const WORRYFREE_SCP_SECURITY_ALLOW_RULE_ID = 18_000_003;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
// The whole-site exemption (WORRY_FREE_SITE_ALLOW_PRIORITY): two rules, because DNR cannot express
// "requests made BY this site OR sent TO it" in one condition.
export const WORRYFREE_SITE_INITIATOR_ALLOW_RULE_ID = 18_000_004;   // what the site's own pages/frames request
export const WORRYFREE_SITE_REQUEST_ALLOW_RULE_ID   = 18_000_005;   // requests sent to the site's hosts
// Option B (10.1.3): an allowAllRequests rule on the site's own page (main_frame) so the whole frame tree —
// embedded third-party frames included — is outside the network protections at WORRY_FREE_SITE_ALLOW_PRIORITY.
export const WORRYFREE_SITE_FRAMETREE_ALLOW_RULE_ID = 18_000_006;

// ── Familiar-TLD editor (new feature) — dynamic TLD-allow rules ─────────────
// js/core/worry-free-familiar-tld-manager.js — the "safer region" TLD/
// country-code list on the Privacy & Security tab, now user-editable
// (textarea + Cancel/restore/update), persisted to storage and regenerated
// as DYNAMIC DNR rules here. Replaces the two former STATIC rulesets
// (ruleset_scp_privacy_tldallow / ruleset_scp_security_tldallow, each a
// fixed per-TLD allow list baked in at build time) — a static ruleset
// cannot be changed at runtime at all, so an editable list requires
// dynamic rules. The SAME priority each purpose's block rule already used
// (SCP_PRIVACY_TLD_ALLOW_PRIORITY / SCP_SECURITY_TLD_ALLOW_PRIORITY,
// above) is reused as-is — only the MECHANISM changed, not the priority
// relationship to the block rule it exempts.
// ID range: 1 000 wide per purpose (same headroom convention as every
// other per-item TLD-allow band in this file, e.g. SAFEREGIONS_SANDBOX_
// SAFE_SCRIPTS_TLD_ALLOW_RULES_BASE_ID above) — comfortably more than the
// 18 unconditional generic TLDs plus every plausible country-code
// addition a person might type, with room to spare.
export const WORRY_FREE_FAMILIAR_SCP_PRIVACY_TLD_ALLOW_RULES_BASE_ID  = 19_000_000;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const WORRY_FREE_FAMILIAR_SCP_SECURITY_TLD_ALLOW_RULES_BASE_ID = 19_001_000;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
export const WORRY_FREE_FAMILIAR_TLD_RULES_END_ID = 19_002_000;   // exclusive   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)

// ── RETIRED (AdShield Evolution rename pass) — was the shared forced-
// download-detection probe (v9.7.1) ──────────────────────────────────────
// js/core/forced-download-detection.js's checkResponseHeadersConditionSupported()
// was called by BOTH the Advanced tier's row 1 (worry-free-advanced-
// manager.js, first-party) and blockScpTldBlock (worry-free-extra-
// manager.js, third-party) — one probe, one cached result, shared rather
// than each caller probing independently (B15/C21). Both of those
// consumers were removed in this pass (see CHANGELOG_HISTORY.md), leaving
// forced-download-detection.js itself with zero callers — that module is
// deleted too. Kept here, unused, per this file's own convention for
// retired ids.
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const RESPONSE_HEADERS_SUPPORT_PROBE_RULE_ID = 16_500_000;

// Adult-site Permissions-Policy headers (session rules). 9.9.1 ladder: 900 — BELOW the default lists
// (10 000) and the security toggles (1 000), ABOVE the whole Medium tier (<= 320), so a safe-domain
// exemption cannot cancel the header but a deliberate filter-list `@@` exception can (owner's call,
// same stance as the security toggles). A person's own Allow-list entry or "Pause filtering" still
// wins outright, as does any of their own rules. Outside the 100-199 Worry-free/SCP band on
// purpose: these rules have no per-item suppression rule at all (the checkbox adds/removes the rules
// themselves), so there is no priority window to protect — the simplification that avoids the 9.6.0
// cross-suppression bug class entirely for this feature.
/** @public read by name in tools/check-dnr-id-ranges.mjs (constNum, source-text regex) and from the LADDER list in tools/check-dnr-priority-order.mjs (A2) — both resolve this constant by name from raw source/B[name], invisible to Knip's static import analysis. */
export const HIGH_RISK_HEADERS_PRIORITY      = 900;   // 9.9.1 ladder: BELOW the default lists (10 000) and the security toggles (1 000), above the Medium tier (<= 320)   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)

// ── Advanced ("Medium website breakage risk") tier — v9.7.0, mostly retired AdShield Evolution rename pass ──
// Was three rows (first-party downloads, sandbox "safe scripts", third-party
// block) plus the "advanced" Worry-free tier checkbox that gated them. Per
// explicit request: the first-party-downloads and third-party-block rows,
// their shared exemption band, and the "advanced" tier checkbox itself are
// all REMOVED — js/core/worry-free-advanced.js and
// worry-free-advanced-manager.js (the files that implemented them) are
// deleted; js/core/worry-free-tiers.js no longer has an ADVANCED tier at
// all. See CHANGELOG_HISTORY.md for the full entry.
//
// The sandbox-"safe scripts" row is NOT removed — the same checkbox, same
// storage key (storage keys are contracts), same protection, continues to
// exist. It MOVED instead: out of the (now-gone) Medium group and into the
// Low group ("website breakage risk" tier `safeRegions`), as that group's
// new last row. Its own ids and priorities below are RENAMED to reflect
// that new home, not retired — this is the same feature continuing, not a
// different one reusing an old number. See js/core/worry-free-extra-
// manager.js for where its rule-building logic now lives (ported out of
// the deleted worry-free-advanced-manager.js) and js/core/worry-free-
// tiers.js for the tier it now declares.
//
// RETIRED (this pass) — kept as named constants, never reassigned, per
// this file's own convention: the first-party-downloads row's two ids, the
// third-party-block row's id, and the three priorities that existed only
// to order this tier's three rows relative to EACH OTHER (an ordering that
// no longer applies now that only one row remains, which needs no internal
// ordering against siblings that no longer exist).
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const ADVANCED_FIRST_PARTY_DOWNLOAD_BLOCK_RULE_ID = 17_000_000;
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const ADVANCED_THIRD_PARTY_BLOCK_RULE_ID          = 17_000_002;
/** @public Reserved/retired DNR id — never reassigned; uniqueness enforced by tools/check-dnr-id-ranges.mjs, which reads it from source. */
export const ADVANCED_FORCED_DOWNLOAD_BLOCK_RULE_ID       = 17_000_004;
/** @public Reserved/retired DNR priority — never reassigned; see tools/check-dnr-id-ranges.mjs's Worry-free band scan. */
export const ADVANCED_3P_BLOCK_PRIORITY = 300;
/** @public Reserved/retired DNR priority — never reassigned; see tools/check-dnr-id-ranges.mjs's Worry-free band scan. */
export const ADVANCED_FORCED_DOWNLOAD_BLOCK_PRIORITY = 305;
/** @public Reserved/retired DNR priority — never reassigned; see tools/check-dnr-id-ranges.mjs's Worry-free band scan. */
export const ADVANCED_HEADER_PRIORITY   = 310;
/** @public Reserved/retired DNR priority — never reassigned; see tools/check-dnr-id-ranges.mjs's Worry-free band scan. */
export const ADVANCED_ALLOW_PRIORITY    = 320;

// RENAMED (this pass, same feature, same ids) — the sandbox-"safe scripts"
// row's own footprint, now a Low-group (tier safeRegions) item instead of
// a Medium-group (tier advanced) one. Still a SESSION rule (built/removed
// directly from isActive + tier + checkbox, same shape it always had) —
// NOT converted to the static-ruleset-plus-suppression-rule shape its new
// Low-group siblings (blockScpPrivacy/blockScpSecurity) use, since nothing
// asked for that and the existing session-rule mechanism, just re-homed
// and re-gated, is already fully correct for this protection. Still needs
// its OWN exemption band (a session rule, unlike blockScpPrivacy/
// blockScpSecurity's static rulesets, has no separate always-present
// TLD-allow ruleset to lean on) — same shape as before: one allow rule per
// safe-region TLD plus one allow rule for $saferegions domains.
export const SANDBOX_SAFE_SCRIPTS_RULES_BASE_ID = 17_000_000;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
/** @public read by name (constNum, source-text regex) in tools/check-dnr-id-ranges.mjs's sandbox-safe-scripts id-containment check — invisible to Knip's static import analysis. */
export const SANDBOX_SAFE_SCRIPTS_RULE_ID        = 17_000_001;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
/** @public read by name (constNum, source-text regex) in tools/check-dnr-id-ranges.mjs's sandbox-safe-scripts id-containment check — invisible to Knip's static import analysis. */
export const SANDBOX_SAFE_SCRIPTS_ALLOW_RULE_ID  = 17_000_003;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
/** @public read by name (constNum, source-text regex) in tools/check-dnr-id-ranges.mjs's sandbox-safe-scripts id-containment check — invisible to Knip's static import analysis. */
export const SANDBOX_SAFE_SCRIPTS_TLD_ALLOW_RULES_BASE_ID = 17_001_000;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
export const SANDBOX_SAFE_SCRIPTS_RULES_END_ID            = 17_002_000;   // exclusive   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
// NEW priorities (this pass) — deliberately NOT a rename of the retired
// ADVANCED_HEADER_PRIORITY/ADVANCED_ALLOW_PRIORITY (310/320): this item
// now sits in the 100-199 Worry-free/SCP band with its own siblings
// instead, for the same "every item gets its own 10-wide window, grouped
// by tier" readability this band has followed since the v9.6.0 RE-SPACED
// rebuild. The next free window after SCP_SECURITY's (130-139) is
// 140-149 — but 140-165 is the permanently-retired old advanced-tier band
// (RETIRED_ADVANCED_PRIORITY_MIN/MAX below — NOT reused), so this item's
// window starts at the next one after that, 170-179. Relation: header
// (170) < allow (180), same "the exemption band must outrank the rule it
// exempts" relation every other item in this band follows.
export const SANDBOX_SAFE_SCRIPTS_HEADER_PRIORITY = 170;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)
export const SANDBOX_SAFE_SCRIPTS_ALLOW_PRIORITY  = 180;   // RETIRED 10.3.0 — reserved, never reassign (RETIRED_PROTECTION_RULE_RANGES)

// ── Storage-only caps (no DNR budget consumed) ───────────────────────────────
export const CUSTOM_COSMETIC_MAX = 10_000;  // picker + sandbox ## rules across all site.* keys
// Custom scriptlet rules (custom-scriptlets.js's addCustomScriptletRule() —
// Privacy Inspector "Select"/sandbox-authored/imported rules). Was
// completely uncapped until the security-audit pass that added this
// constant — CUSTOM_COSMETIC_MAX's sibling for the scriptlet-rule store,
// same "storage-only, no DNR rule involved" reasoning.
export const CUSTOM_SCRIPTLET_MAX = 10_000;
// Matrix allow/block overrides — per (site, domain) pair, each with
// independent 3P-all / 3P-code scope fields (see matrix-block-rules.js).
// Storage-only cap; DNR budget is tracked separately by MATRIX_RULES_MAX_DNR
// above (up to 2 DNR rules per pair that actually has an active override).
export const MATRIX_OVERRIDES_MAX = 5_000;

// ── RETIRED (10.3.0): Privacy & Security extra protections ──────────────────
// The "Security enhancements", "Very low" and "Low" groups, the two Worry-free tier checkboxes, the
// editable safer-region TLD list and "$saferegions" were removed — the protections moved to the
// separate 3P-Matrix extension. Every DNR id they ever used is listed here, ONCE, as half-open ranges
// [from, to). They stay RESERVED for good: until 10.5.0 a start-up clean-up removed leftovers inside
// them; that conversion code was removed in 10.5.0 (owner), so an id here must never be reused. The individual constants above
// stay declared (tagged "RETIRED 10.3.0") as permanent reservations: never reassign these ids.
// Static rulesets need no entry: ruleset_scp_privacy_block, ruleset_scp_security_block and
// ruleset_suspicious_hosting are gone from the manifest, so Chrome drops them on the update.
/** @public consumed by tools/check-dnr-id-ranges.mjs (permanent reservation) */
export const RETIRED_PROTECTION_RULE_RANGES = Object.freeze([
    Object.freeze({ from: SECURITY_RULES_BASE_ID,              to: SECURITY_RULES_BASE_ID + 21,   what: 'security-toggle rules (+0..+20)' }),
    Object.freeze({ from: SCP_PRIVACY_BLOCK_RULES_BASE_ID,     to: SCP_SECURITY_TLDALLOW_RULES_BASE_ID + 1, what: 'Low-group header off-switches (13 000 011..014)' }),
    Object.freeze({ from: SAFEREGIONS_DYNAMIC_RULES_BASE_ID,   to: SAFEREGIONS_DYNAMIC_RULES_BASE_ID + 7, what: '$saferegions allows (15 000 000..006)' }),
    Object.freeze({ from: HIGH_RISK_HEADERS_RULES_BASE_ID,     to: HIGH_RISK_HEADERS_RULES_BASE_ID + HIGH_RISK_HEADERS_RULES_SLOTS, what: 'high-risk-site headers' }),
    Object.freeze({ from: RESPONSE_HEADERS_SUPPORT_PROBE_RULE_ID, to: RESPONSE_HEADERS_SUPPORT_PROBE_RULE_ID + 1, what: 'response-header support probe' }),
    Object.freeze({ from: SANDBOX_SAFE_SCRIPTS_RULES_BASE_ID,  to: SANDBOX_SAFE_SCRIPTS_RULES_END_ID, what: 'pop-up/redirect row + its exemption band' }),
    Object.freeze({ from: WORRYFREE_SCP_PRIVACY_ALLOW_RULE_ID, to: WORRYFREE_SCP_SECURITY_ALLOW_RULE_ID + 1, what: '$worryfree allows of the two Low-group headers' }),
    Object.freeze({ from: WORRY_FREE_FAMILIAR_SCP_PRIVACY_TLD_ALLOW_RULES_BASE_ID, to: WORRY_FREE_FAMILIAR_TLD_RULES_END_ID, what: 'safer-region TLD allows' }),
]);
