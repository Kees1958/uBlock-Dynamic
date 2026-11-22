// ── trusted-service-domains.js ───────────────────────────────────────────────
// The Worry-free side of the ONE whitelist: every WHITE entry (data/matrix-constants.js BUILTIN_DOMAINS) is
// exempt from EVERY Worry-free and safer-regions protection, exactly as if each were typed on the Allow list as
// "@@domain$worryfree" (= "this site is outside Worry-free altogether": scriptlets, DNR blocklists, extra filter
// lists, security header rules). Merged into getEffectiveWorryfreeDomains() (js/core/exempt-domains.js).
//
// 10.2.0 — one whitelist, one treatment (owner's decision): this file used to pick only some whitelist
// categories (payment, sign-in, CAPTCHA, apps) and add its own EXTRA_TRUSTED_DOMAINS list on top, so a
// whitelisted library or video embed (bbc.com, Vimeo, …) got the filter-list allow but NOT the Worry-free
// exemption — a half-exemption that read as "the whitelist does not work". Now:
//   - the category filter is gone: TRUSTED_SERVICE_DOMAINS is simply every WHITE domain;
//   - the former EXTRA_TRUSTED_DOMAINS (sign-in hosts, regional payment / ID services) moved INTO the
//     whitelist itself (matrix-constants.js, "Added 10.2.0" block), so they are declared in one place;
//   - hosts where anyone can publish are GREY_DOMAINS (matrix-constants.js), never WHITE, and therefore never
//     here — the protections keep applying to them.
//
// STANDING RULE: when a language / region filter list is added, add that area's payment, bank, sign-in,
// meeting, gaming and streaming services to the whitelist (matrix-constants.js / app-whitelist-domains.js) in
// the same release — never as a separate list here.
//
// Pure data, built once at import: nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────
import { BUILTIN_DOMAINS } from './matrix-constants.js';

export const TRUSTED_SERVICE_DOMAINS = Object.freeze(Object.keys(BUILTIN_DOMAINS));
