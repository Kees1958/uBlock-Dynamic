/*
 * matrix-constants.js — Ported 3P-Matrix-lite static data for the Matrix panel
 *
 * Public interface:
 *   MULTI_PART_SUFFIXES  — common multi-part public suffixes (etldPlusOne)
 *   MATRIX_RESOURCE_TYPES — full third-party webRequest resource type list
 *   MATRIX_CAP            — max FIFO entries per tab session
 *   MATRIX_BULK_OVERRIDES_MAX — max changes in one bulk override message (11.1.0)
 *   BUILTIN_DOMAINS        — domain -> {script, frame} whitelist (CRITICAL
 *                             RESOURCE column, green marker)
 *   SIGNAL_DOMAINS          — domain -> {script, frame} "commonly needed for
 *                             login, review before blocking" list (CRITICAL
 *                             RESOURCE column, yellow marker) — NEVER
 *                             auto-allowed, informational only
 *   BUILTIN_DOMAIN_CATEGORY — domain -> human-readable category, for tooltips
 *   WHITELIST_LEVEL         — frozen enum { WHITE, GREY } (10.2.0)
 *   GREY_DOMAINS            — domain -> reason; hosts where anyone can publish
 *                             (no allow, no Worry-free exemption — see the
 *                             "Whitelist levels" block at the bottom)
 *
 * 10.1.6: BUILTIN_DOMAINS / BUILTIN_DOMAIN_CATEGORY are the ONE unified whitelist. They are the ported core
 * below PLUS the meeting / gaming / streaming apps of data/app-whitelist-domains.js (merged at the bottom of
 * this file). data/trusted-service-domains.js derives the Worry-free whitelist from the same categories.
 * 10.2.0: every BUILTIN_DOMAINS entry is WHITE and gets ONE treatment (filter-list allow + full Worry-free
 * exemption) — the category filter in trusted-service-domains.js is gone. Hosts where anyone can publish are
 * GREY_DOMAINS instead, never BUILTIN_DOMAINS. See "Whitelist levels" at the bottom of this file.
 *
 * Ported verbatim (core part) from 3P-Matrix-lite's data/constants.js (the source this
 * fork's Matrix panel is based on) — same data, same categorization
 * decisions, same header commentary preserved inline below. Not re-derived;
 * this is a direct port of already-reviewed data, not new curation.
 *
 * No level/mode/TLD-engine constants ported (EU_LANGS, CDN_HOST_REGEX,
 * GENERIC_BLOCKED_TLDS, WORLD_BLOCKED_TLDS) — this fork's Matrix panel is
 * observation + CRITICAL RESOURCE/DDG-Tracker labeling + explicit per-domain
 * Allow/Block, not 3P-Matrix-lite's separate L1-L5 protection-level system,
 * so porting that machinery here would be dead weight, not a real feature.
 */


import {
    APP_WHITELIST_DOMAINS, APP_WHITELIST_FLAGS,
} from './app-whitelist-domains.js';

// Common multi-part public suffixes — single source of truth used by
// tld-engine.js (_etldPlusOne) and popup.js (getApexDomain).
// Anything not in this list falls back to the standard "last two labels" rule.
export const MULTI_PART_SUFFIXES = [
  "co.uk","org.uk","ac.uk","gov.uk","co.jp","co.kr","co.nz","co.za",
  "com.au","net.au","org.au","com.br","com.cn","com.mx","com.tr",
  "co.in","co.id","com.sg"
];


// webRequest resource types Show Matrix observes — the FULL third-party
// resource set (same as RP_3P above), not a narrow subset. This is
// deliberately everything: images, media (video/audio), stylesheets, fonts,
// plugins/objects, pings, and "other", matching how classic uMatrix showed
// every kind of third-party connection in its matrix view, not just
// script/frame/xhr/websocket. Kept as its own constant (rather than
// importing RP_3P directly) since the two lists could diverge later even
// though they're identical today.
export const MATRIX_RESOURCE_TYPES = [
  "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webbundle", "other"
];

// Max FIFO entries per tab (same cap value/reasoning as MONITOR_CAP in
// block-monitor.js — kept as a separate constant since the two features are

// independent modules and may need to diverge later).
export const MATRIX_CAP = 100;

// (11.1.0) Input limit (C49) for MSG_MATRIX_SET_OVERRIDES — the tracking filter's bulk Block/Allow buttons. One change
// per visible row: at most MATRIX_CAP domain rows plus the subdomain rows of whitelisted domains under them. Generous
// on purpose (a real session stays far below it); a larger message is refused whole, never half-applied.
export const MATRIX_BULK_OVERRIDES_MAX = MATRIX_CAP * 5;

// REMOVED (audit after 9.7.5): MATRIX_DURATION — never imported anywhere.
// The Matrix panel's session length comes from DEFAULT_SESSION_TIMEOUT_MS
// in js/data/timing-constants.js (see js/core/matrix-panel.js), which had
// already superseded this duplicate.

const BUILTIN_DOMAINS_CORE = {
  // Payment — core / international
  "adyen.com": { script: true, frame: true },
  // JS libraries
  "ajax.microsoft.com": { script: true, frame: false },
  // CAPTCHA / bot protection
  "altcha.org": { script: true, frame: true },
  // Digital wallets
  "apple-pay-gateway-nc-pod.apple.com": { script: true, frame: true },
  "apple-pay-gateway.apple.com": { script: true, frame: true },
  // CAPTCHA / bot protection
  "arkoselabs.com": { script: true, frame: true },
  // Public broadcasters commonly embedded in EU/UK
  "arte.tv": { script: true, frame: true },
  // Payment — core / international
  "assets.braintreegateway.com": { script: true, frame: true },
  // Identity / SSO — Auth-as-a-service
  "auth0.com": { script: true, frame: true },
  // Payment — core / international
  "authorize.net": { script: true, frame: true },
  // Payment — North America
  "bambora.com": { script: true, frame: true },
  // Payment — Benelux
  "bancontact.com": { script: true, frame: true },
  // Open Banking
  "banked.com": { script: true, frame: true },
  // Public broadcasters commonly embedded in EU/UK
  "bbc.co.uk": { script: true, frame: true },
  "bbc.com": { script: true, frame: true },
  // News publisher video players (proprietary embed domains)
  "bcove.video": { script: true, frame: true },
  // Payment — North America
  "beanstream.com": { script: true, frame: true },
  // Payment — Benelux
  "billink.nl": { script: true, frame: true },
  // Payment — Spain / Portugal
  "bizum.es": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "brightcove.com": { script: true, frame: true },
  // Payment — Benelux
  "buckaroo.nl": { script: true, frame: true },
  // CAPTCHA / bot protection
  "captcha.eu": { script: true, frame: true },
  // Payment — Benelux
  "ccv.eu": { script: true, frame: true },
  // Payment — core / international
  "cdn.checkout.com": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "cdn.jwplayer.com": { script: true, frame: true },
  // News publisher video players (proprietary embed domains)
  "cdn.jwpltx.com": { script: true, frame: true },
  // CAPTCHA / bot protection
  "challenges.cloudflare.com": { script: true, frame: true },
  // Payment — core / international
  "checkout.com": { script: true, frame: true },
  "checkout.stripe.com": { script: true, frame: true },
  "checkoutshopper-live.adyen.com": { script: true, frame: true },
  // CAPTCHA / bot protection
  "client-api.arkoselabs.com": { script: true, frame: true },
  // Video infrastructure / delivery
  "cloudflarestream.com": { script: true, frame: true },
  // Payment — North America
  "clover.com": { script: true, frame: true },
  // Payment — Benelux
  "cm.com": { script: true, frame: true },
  // JS libraries
  "code.jquery.com": { script: true, frame: false },
  // Payment — Czech / Slovakia
  "comgate.cz": { script: true, frame: true },
  // Payment — DACH
  "computop.com": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "content.jwplatform.com": { script: true, frame: true },
  // Payment — core / international
  "cybersource.com": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "dailymotion.com": { script: true, frame: true },
  "dmcdn.net": { script: true, frame: true },
  // Payment — North America
  "elavon.com": { script: true, frame: true },
  // News publisher video players (proprietary embed domains)
  "embed.mychannels.video": { script: true, frame: true },
  // Payment — DACH
  "eps-ueberweisung.at": { script: true, frame: true },
  // JS libraries
  // Payment — Romania
  "euplatesc.ro": { script: true, frame: true },
  // Payment — Baltics
  "every-pay.com": { script: true, frame: true },
  // Live streaming
  "ext-twitch.tv": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "f.vimeocdn.com": { script: true, frame: true },
  "fast.wistia.com": { script: true, frame: true },
  // Payment — North America
  "fiserv.com": { script: true, frame: true },
  "fisglobal.com": { script: true, frame: true },
  // Fraud prevention — commonly loaded as iframes during checkout flows
  "forter.com": { script: true, frame: true },
  // CAPTCHA / bot protection
  "friendlycaptcha.com": { script: true, frame: true },
  "geetest.com": { script: true, frame: true },
  // News publisher video players (proprietary embed domains)
  "geo.dailymotion.com": { script: true, frame: true },
  // Payment — Nordics
  "getswish.se": { script: true, frame: true },
  // Payment — UK / Ireland
  "gocardless.com": { script: true, frame: true },
  // CAPTCHA / bot protection
  // Video embeds — established hosted platforms only
  // Digital wallets
  "googlepay.com": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "googlevideo.com": { script: true, frame: true },
  // Payment — Czech / Slovakia
  "gopay.com": { script: true, frame: true },
  // CAPTCHA / bot protection
  "gstatic.com": { script: true, frame: true },
  "hcaptcha.com": { script: false, frame: true },
  // Payment — DACH
  "heidelpay.com": { script: true, frame: true },
  // Payment — North America
  "helcim.com": { script: true, frame: true },
  // Payment — core / international
  "hooks.stripe.com": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "i.vimeocdn.com": { script: true, frame: true },
  // Payment — Benelux
  "ideal-checkout.nl": { script: true, frame: true },
  "ingenico.com": { script: true, frame: true },
  // Payment — core / international
  "js.braintreegateway.com": { script: true, frame: false },
  // CAPTCHA / bot protection
  "js.hcaptcha.com": { script: true, frame: false },
  // Payment — Benelux
  "js.mollie.com": { script: true, frame: true },
  // Payment — core / international
  "js.squareup.com": { script: true, frame: false },
  "js.stripe.com": { script: true, frame: false },
  "js.stripe.network": { script: true, frame: false },
  // JS libraries
  // Live streaming
  "jtvnw.net": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "jwpcdn.com": { script: true, frame: true },
  "jwplatform.com": { script: true, frame: true },
  "jwplayer.com": { script: true, frame: true },
  // Enterprise/education video
  "kaltura.com": { script: true, frame: true },
  // Payment — core / international
  "klarna.com": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "loom.com": { script: true, frame: true },
  "loomcdn.com": { script: true, frame: true },
  // Payment — France
  "lyra.com": { script: true, frame: true },
  // Payment — core / international
  "m.stripe.network": { script: true, frame: true },
  // Payment — Baltics
  "makecommerce.net": { script: true, frame: true },
  // Payment — Nordics
  "mobilepay.dk": { script: true, frame: true },
  // Payment — Benelux
  "mollie.com": { script: true, frame: true },
  // Payment — North America
  "moneris.com": { script: true, frame: true },
  // Payment — Benelux
  "multi-safepay.com": { script: true, frame: true },
  // Video infrastructure / delivery
  "mux.com": { script: true, frame: true },
  // Payment — Romania
  "netopia-payments.com": { script: true, frame: true },
  // Payment — Italy
  "nexi.it": { script: true, frame: true },
  // Payment — Benelux
  "noda.live": { script: true, frame: true },
  // Identity / SSO — Auth-as-a-service
  "okta.com": { script: true, frame: true },
  "onelogin.com": { script: true, frame: true },
  // Payment — Benelux
  "onlinepaymentplatform.nl": { script: true, frame: true },
  // Payment — UK / Ireland
  "opayo.co.uk": { script: true, frame: true },
  // Enterprise/education video
  "panopto.com": { script: true, frame: true },
  // Digital wallets
  "pay.google.com": { script: true, frame: true },
  // Payment — Benelux
  "pay.nl": { script: true, frame: true },
  // Payment — France
  "paybox.com": { script: true, frame: true },
  // Payment — DACH
  "payone.com": { script: true, frame: true },
  // Payment — core / international
  "paypal.com": { script: true, frame: true },
  "paypalobjects.com": { script: true, frame: true },
  // Payment — France
  "payplug.com": { script: true, frame: true },
  // Payment — Poland
  "payu.com": { script: true, frame: true },
  "payu.pl": { script: true, frame: true },
  // Open Banking
  "plaid.com": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "play.vidyard.com": { script: false, frame: true },
  // Live streaming
  "player.twitch.tv": { script: false, frame: true },
  // Video embeds — established hosted platforms only
  "player.vimeo.com": { script: false, frame: true },
  "players.brightcove.net": { script: true, frame: true },
  // Payment — Benelux
  "plugandpay.io": { script: true, frame: true },
  // Payment — Italy
  "postepay.it": { script: true, frame: true },
  // Payment — Benelux
  "pronamicpay.com": { script: true, frame: true },
  // Payment — Poland
  "przelewy24.pl": { script: true, frame: true },
  // Payment — DACH
  "ratepay.com": { script: true, frame: true },
  // CAPTCHA / bot protection
  "recaptcha.net": { script: true, frame: true },
  // Payment — Spain / Portugal
  "redsys.es": { script: true, frame: true },
  // JS libraries
  // Fraud prevention — commonly loaded as iframes during checkout flows
  "riskified.com": { script: true, frame: true },
  // Payment — DACH
  "riverty.com": { script: true, frame: true },
  // Other embeddable platforms
  "rumble.com": { script: true, frame: true },
  // Payment — UK / Ireland
  "sagepay.com": { script: true, frame: true },
  // Payment — Italy
  "satispay.com": { script: true, frame: true },
  // Fraud prevention — commonly loaded as iframes during checkout flows
  "seon.io": { script: true, frame: true },
  "sift.com": { script: true, frame: true },
  "signifyd.com": { script: true, frame: true },
  // Payment — Nordics
  "siirto.fi": { script: true, frame: true },
  // Payment — Benelux
  "sisow.nl": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "sproutvideo.com": { script: true, frame: true },
  // CAPTCHA / bot protection
  "static.geetest.com": { script: true, frame: true },
  // Payment — Nordics
  "swish.nu": { script: true, frame: true },
  // Other embeddable platforms
  "ted.com": { script: true, frame: true },
  // Payment — Benelux
  "tikkie.nl": { script: true, frame: true },
  // Open Banking
  "tink.com": { script: true, frame: true },
  // Payment — Poland
  "tpay.com": { script: true, frame: true },
  // Open Banking
  "truelayer.com": { script: true, frame: true },
  "trustly.com": { script: true, frame: true },
  // CAPTCHA / bot protection
  "turnstile.cloudflare.com": { script: true, frame: true },
  // Payment — DACH
  "twint.ch": { script: true, frame: true },
  // JS libraries
  // Payment — DACH
  "unzer.com": { script: true, frame: true },
  // Payment — core / international
  "verifone.cloud": { script: true, frame: true },
  "verifone.com": { script: true, frame: true },
  // Video infrastructure / delivery
  "videodelivery.net": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "vimeocdn.com": { script: true, frame: true },
  // Payment — Nordics
  "vipps.no": { script: true, frame: true },
  "vippsmobilepay.com": { script: true, frame: true },
  // Open Banking
  "vyne.co.uk": { script: true, frame: true },
  // Payment — Nordics
  "walleypay.com": { script: true, frame: true },
  // Payment — Benelux
  "wero-wallet.eu": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "wistia.com": { script: true, frame: true },
  "wistia.net": { script: true, frame: true },
  // Identity / SSO — Auth-as-a-service
  "workos.com": { script: true, frame: true },
  // Payment — Benelux
  "worldline.com": { script: true, frame: true },
  // Payment — core / international
  "worldpay.com": { script: true, frame: true },
  "x.klarnacdn.net": { script: true, frame: true },
  // Video embeds — established hosted platforms only
  "youtu.be": { script: true, frame: true },
  "youtube-nocookie.com": { script: true, frame: true },
  "youtube.com": { script: true, frame: true },
  "ytimg.com": { script: true, frame: true },
  // ── Added 10.2.0 (one whitelist, one treatment) ─────────────────────────────────────────────────────────
  // Fine-grained Google API hosts (replacing the former whole-domain googleapis.com entry, which is now
  // GREY — see GREY_DOMAINS below), sign-in hosts, and the regional payment / ID services that used to
  // live only in data/trusted-service-domains.js (EXTRA_TRUSTED_DOMAINS). fonts.googleapis.com serves
  // stylesheets only, so neither DNR allow flag applies; it is listed for the WHITE marker and the
  // Worry-free exemption.
  "ajax.googleapis.com": { script: true, frame: false },
  "maps.googleapis.com": { script: true, frame: false },
  "translate.googleapis.com": { script: true, frame: false },
  "fonts.googleapis.com": { script: false, frame: false },
  "accounts.google.com": { script: true, frame: true },
  "login.microsoftonline.com": { script: true, frame: true },
  "login.live.com": { script: true, frame: true },
  "login.windows.net": { script: true, frame: true },
  "appleid.apple.com": { script: true, frame: true },
  "idmsa.apple.com": { script: true, frame: true },
  "duosecurity.com": { script: true, frame: true },
  "cardinalcommerce.com": { script: true, frame: true },
  "digid.nl": { script: true, frame: true },
  "eherkenning.nl": { script: true, frame: true },
  "ideal.nl": { script: true, frame: true },
  "mitid.dk": { script: true, frame: true },
  "bankid.com": { script: true, frame: true },
  "itsme-id.com": { script: true, frame: true },
  "pagbank.com.br": { script: true, frame: true },
  "pagseguro.com.br": { script: true, frame: true },
  "cielo.com.br": { script: true, frame: true },
  "getnet.com.br": { script: true, frame: true },
  "bb.com.br": { script: true, frame: true },
  "itau.com.br": { script: true, frame: true },
  "bradesco.com.br": { script: true, frame: true },
  "nubank.com.br": { script: true, frame: true },
  "mercadopago.com.br": { script: true, frame: true },
  "mercadopago.com.ar": { script: true, frame: true },
  "mercadopago.com.mx": { script: true, frame: true },
  "mercadopago.cl": { script: true, frame: true },
  "mercadopago.com.co": { script: true, frame: true },
  "transbank.cl": { script: true, frame: true },
  "pse.com.co": { script: true, frame: true },
  // (10.6.3, 3P-Matrix-lite cross-check) gov.br, sii.cl, afip.gob.ar and sat.gob.mx removed: gov.br is an
  // umbrella covering thousands of unrelated Brazilian government sites, not one service, and all four are
  // tax/ID-verification portals whose actual lookups run on the merchant's server, never in the browser — so
  // the script/frame bypass they were given here never did anything useful. Pure unnecessary attack surface.
};

// "Signal list" — domains commonly needed for "Login with X" flows, but
// deliberately NOT auto-allowed anywhere (unlike BUILTIN_DOMAINS above).
// These are broad, multi-purpose platforms (Facebook, GitHub, LinkedIn,
// Apple/Microsoft account domains) where blanket global whitelisting would
// be a much bigger privacy trade-off than the narrow-purpose auth-as-a-
// service providers above — blocking them by default is the right call,
// but the user should still be able to SEE that a domain is commonly
// needed for login, with better context than they'd otherwise have, and
// make the one-click decision themselves. Never generates a DNR rule —
// see core/rule-classifier.js's isSignalDomain() and the INTERNAL
// WHITELIST column's yellow state in Show Matrix.

// Apple/Microsoft account domains) where blanket global whitelisting would
// be a much bigger privacy trade-off than the narrow-purpose auth-as-a-
// service providers above — blocking them by default is the right call,
// but the user should still be able to SEE that a domain is commonly
// needed for login, with better context than they'd otherwise have, and
// make the one-click decision themselves. Never generates a DNR rule —
// see core/rule-classifier.js's isSignalDomain() and the INTERNAL
// WHITELIST column's yellow state in Show Matrix.
export const SIGNAL_DOMAINS = {
  // Identity / SSO — Microsoft
  "account.microsoft.com": { script: false, frame: true },
  // Identity / SSO — Apple
  // Identity / SSO — Meta/Facebook
  "connect.facebook.net": { script: true, frame: false },
  "facebook.com": { script: false, frame: true },
  // Identity / SSO — GitHub
  "github.com": { script: false, frame: true },
  // Identity / SSO — Apple
  // Identity / SSO — LinkedIn
  "linkedin.com": { script: false, frame: true },
  // Identity / SSO — Microsoft
};

// Category lookup, kept separate from the script/frame flags above for
// readability — covers BOTH BUILTIN_DOMAINS and SIGNAL_DOMAINS (shared,
// since a domain is never in both). Used only for the INTERNAL WHITELIST
// column's explanatory tooltip in Show Matrix ("why was this domain
// trusted/flagged") — never consulted for the actual allow/block decision.
const BUILTIN_DOMAIN_CATEGORY_CORE = {
  // Identity / SSO — Microsoft
  "account.microsoft.com": "Identity / SSO — Microsoft",
  // Payment — core / international
  "adyen.com": "Payment — core / international",
  // JS libraries
  "ajax.microsoft.com": "JS libraries",
  // CAPTCHA / bot protection
  "altcha.org": "CAPTCHA / bot protection",
  // Digital wallets
  "apple-pay-gateway-nc-pod.apple.com": "Digital wallets",
  "apple-pay-gateway.apple.com": "Digital wallets",
  // Identity / SSO — Apple
  "appleid.apple.com": "Identity / SSO — Apple",
  // CAPTCHA / bot protection
  "arkoselabs.com": "CAPTCHA / bot protection",
  // Public broadcasters commonly embedded in EU/UK
  "arte.tv": "Public broadcasters commonly embedded in EU/UK",
  // Payment — core / international
  "assets.braintreegateway.com": "Payment — core / international",
  // Identity / SSO — Auth-as-a-service
  "auth0.com": "Identity / SSO — Auth-as-a-service",
  // Payment — core / international
  "authorize.net": "Payment — core / international",
  // Payment — North America
  "bambora.com": "Payment — North America",
  // Payment — Benelux
  "bancontact.com": "Payment — Benelux",
  // Open Banking
  "banked.com": "Open Banking",
  // Public broadcasters commonly embedded in EU/UK
  "bbc.co.uk": "Public broadcasters commonly embedded in EU/UK",
  "bbc.com": "Public broadcasters commonly embedded in EU/UK",
  // News publisher video players (proprietary embed domains)
  "bcove.video": "News publisher video players (proprietary embed domains)",
  // Payment — North America
  "beanstream.com": "Payment — North America",
  // Payment — Benelux
  "billink.nl": "Payment — Benelux",
  // Payment — Spain / Portugal
  "bizum.es": "Payment — Spain / Portugal",
  // Video embeds — established hosted platforms only
  "brightcove.com": "Video embeds — established hosted platforms only",
  // Payment — Benelux
  "buckaroo.nl": "Payment — Benelux",
  // CAPTCHA / bot protection
  "captcha.eu": "CAPTCHA / bot protection",
  // Payment — Benelux
  "ccv.eu": "Payment — Benelux",
  // Payment — core / international
  "cdn.checkout.com": "Payment — core / international",
  // Video embeds — established hosted platforms only
  "cdn.jwplayer.com": "Video embeds — established hosted platforms only",
  // News publisher video players (proprietary embed domains)
  "cdn.jwpltx.com": "News publisher video players (proprietary embed domains)",
  // CAPTCHA / bot protection
  "challenges.cloudflare.com": "CAPTCHA / bot protection",
  // Payment — core / international
  "checkout.com": "Payment — core / international",
  "checkout.stripe.com": "Payment — core / international",
  "checkoutshopper-live.adyen.com": "Payment — core / international",
  // CAPTCHA / bot protection
  "client-api.arkoselabs.com": "CAPTCHA / bot protection",
  // Video infrastructure / delivery
  "cloudflarestream.com": "Video infrastructure / delivery",
  // Payment — North America
  "clover.com": "Payment — North America",
  // Payment — Benelux
  "cm.com": "Payment — Benelux",
  // JS libraries
  "code.jquery.com": "JS libraries",
  // Payment — Czech / Slovakia
  "comgate.cz": "Payment — Czech / Slovakia",
  // Payment — DACH
  "computop.com": "Payment — DACH",
  // Identity / SSO — Meta/Facebook
  "connect.facebook.net": "Identity / SSO — Meta/Facebook",
  // Video embeds — established hosted platforms only
  "content.jwplatform.com": "Video embeds — established hosted platforms only",
  // Payment — core / international
  "cybersource.com": "Payment — core / international",
  // Video embeds — established hosted platforms only
  "dailymotion.com": "Video embeds — established hosted platforms only",
  "dmcdn.net": "Video embeds — established hosted platforms only",
  // Payment — North America
  "elavon.com": "Payment — North America",
  // News publisher video players (proprietary embed domains)
  "embed.mychannels.video": "News publisher video players (proprietary embed domains)",
  // Payment — DACH
  "eps-ueberweisung.at": "Payment — DACH",
  // JS libraries
  // Payment — Romania
  "euplatesc.ro": "Payment — Romania",
  // Payment — Baltics
  "every-pay.com": "Payment — Baltics",
  // Live streaming
  "ext-twitch.tv": "Live streaming",
  // Video embeds — established hosted platforms only
  "f.vimeocdn.com": "Video embeds — established hosted platforms only",
  // Identity / SSO — Meta/Facebook
  "facebook.com": "Identity / SSO — Meta/Facebook",
  // Video embeds — established hosted platforms only
  "fast.wistia.com": "Video embeds — established hosted platforms only",
  // Payment — North America
  "fiserv.com": "Payment — North America",
  "fisglobal.com": "Payment — North America",
  // Fraud prevention — commonly loaded as iframes during checkout flows
  "forter.com": "Fraud prevention — commonly loaded as iframes during checkout flows",
  // CAPTCHA / bot protection
  "friendlycaptcha.com": "CAPTCHA / bot protection",
  "geetest.com": "CAPTCHA / bot protection",
  // News publisher video players (proprietary embed domains)
  "geo.dailymotion.com": "News publisher video players (proprietary embed domains)",
  // Payment — Nordics
  "getswish.se": "Payment — Nordics",
  // Identity / SSO — GitHub
  "github.com": "Identity / SSO — GitHub",
  // Payment — UK / Ireland
  "gocardless.com": "Payment — UK / Ireland",
  // CAPTCHA / bot protection
  // Video embeds — established hosted platforms only
  // Digital wallets
  "googlepay.com": "Digital wallets",
  // Video embeds — established hosted platforms only
  "googlevideo.com": "Video embeds — established hosted platforms only",
  // Payment — Czech / Slovakia
  "gopay.com": "Payment — Czech / Slovakia",
  // CAPTCHA / bot protection
  "gstatic.com": "CAPTCHA / bot protection",
  "hcaptcha.com": "CAPTCHA / bot protection",
  // Payment — DACH
  "heidelpay.com": "Payment — DACH",
  // Payment — North America
  "helcim.com": "Payment — North America",
  // Payment — core / international
  "hooks.stripe.com": "Payment — core / international",
  // Video embeds — established hosted platforms only
  "i.vimeocdn.com": "Video embeds — established hosted platforms only",
  // Payment — Benelux
  "ideal-checkout.nl": "Payment — Benelux",
  // Identity / SSO — Apple
  "idmsa.apple.com": "Identity / SSO — Apple",
  // Payment — Benelux
  "ingenico.com": "Payment — Benelux",
  // Payment — core / international
  "js.braintreegateway.com": "Payment — core / international",
  // CAPTCHA / bot protection
  "js.hcaptcha.com": "CAPTCHA / bot protection",
  // Payment — Benelux
  "js.mollie.com": "Payment — Benelux",
  // Payment — core / international
  "js.squareup.com": "Payment — core / international",
  "js.stripe.com": "Payment — core / international",
  "js.stripe.network": "Payment — core / international",
  // JS libraries
  // Live streaming
  "jtvnw.net": "Live streaming",
  // Video embeds — established hosted platforms only
  "jwpcdn.com": "Video embeds — established hosted platforms only",
  "jwplatform.com": "Video embeds — established hosted platforms only",
  "jwplayer.com": "Video embeds — established hosted platforms only",
  // Enterprise/education video
  "kaltura.com": "Enterprise/education video",
  // Payment — core / international
  "klarna.com": "Payment — core / international",
  // Identity / SSO — LinkedIn
  "linkedin.com": "Identity / SSO — LinkedIn",
  // Identity / SSO — Microsoft
  "login.live.com": "Identity / SSO — Microsoft",
  "login.microsoftonline.com": "Identity / SSO — Microsoft",
  "login.windows.net": "Identity / SSO — Microsoft",
  // Video embeds — established hosted platforms only
  "loom.com": "Video embeds — established hosted platforms only",
  "loomcdn.com": "Video embeds — established hosted platforms only",
  // Payment — France
  "lyra.com": "Payment — France",
  // Payment — core / international
  "m.stripe.network": "Payment — core / international",
  // Payment — Baltics
  "makecommerce.net": "Payment — Baltics",
  // Payment — Nordics
  "mobilepay.dk": "Payment — Nordics",
  // Payment — Benelux
  "mollie.com": "Payment — Benelux",
  // Payment — North America
  "moneris.com": "Payment — North America",
  // Payment — Benelux
  "multi-safepay.com": "Payment — Benelux",
  // Video infrastructure / delivery
  "mux.com": "Video infrastructure / delivery",
  // Payment — Romania
  "netopia-payments.com": "Payment — Romania",
  // Payment — Italy
  "nexi.it": "Payment — Italy",
  // Payment — Benelux
  "noda.live": "Payment — Benelux",
  // Identity / SSO — Auth-as-a-service
  "okta.com": "Identity / SSO — Auth-as-a-service",
  "onelogin.com": "Identity / SSO — Auth-as-a-service",
  // Payment — Benelux
  "onlinepaymentplatform.nl": "Payment — Benelux",
  // Payment — UK / Ireland
  "opayo.co.uk": "Payment — UK / Ireland",
  // Enterprise/education video
  "panopto.com": "Enterprise/education video",
  // Digital wallets
  "pay.google.com": "Digital wallets",
  // Payment — Benelux
  "pay.nl": "Payment — Benelux",
  // Payment — France
  "paybox.com": "Payment — France",
  // Payment — DACH
  "payone.com": "Payment — DACH",
  // Payment — core / international
  "paypal.com": "Payment — core / international",
  "paypalobjects.com": "Payment — core / international",
  // Payment — France
  "payplug.com": "Payment — France",
  // Payment — Poland
  "payu.com": "Payment — Poland",
  "payu.pl": "Payment — Poland",
  // Open Banking
  "plaid.com": "Open Banking",
  // Video embeds — established hosted platforms only
  "play.vidyard.com": "Video embeds — established hosted platforms only",
  // Live streaming
  "player.twitch.tv": "Live streaming",
  // Video embeds — established hosted platforms only
  "player.vimeo.com": "Video embeds — established hosted platforms only",
  "players.brightcove.net": "Video embeds — established hosted platforms only",
  // Payment — Benelux
  "plugandpay.io": "Payment — Benelux",
  // Payment — Italy
  "postepay.it": "Payment — Italy",
  // Payment — Benelux
  "pronamicpay.com": "Payment — Benelux",
  // Payment — Poland
  "przelewy24.pl": "Payment — Poland",
  // Payment — DACH
  "ratepay.com": "Payment — DACH",
  // CAPTCHA / bot protection
  "recaptcha.net": "CAPTCHA / bot protection",
  // Payment — Spain / Portugal
  "redsys.es": "Payment — Spain / Portugal",
  // JS libraries
  // Fraud prevention — commonly loaded as iframes during checkout flows
  "riskified.com": "Fraud prevention — commonly loaded as iframes during checkout flows",
  // Payment — DACH
  "riverty.com": "Payment — DACH",
  // Other embeddable platforms
  "rumble.com": "Other embeddable platforms",
  // Payment — UK / Ireland
  "sagepay.com": "Payment — UK / Ireland",
  // Payment — Italy
  "satispay.com": "Payment — Italy",
  // Fraud prevention — commonly loaded as iframes during checkout flows
  "seon.io": "Fraud prevention — commonly loaded as iframes during checkout flows",
  "sift.com": "Fraud prevention — commonly loaded as iframes during checkout flows",
  "signifyd.com": "Fraud prevention — commonly loaded as iframes during checkout flows",
  // Payment — Nordics
  "siirto.fi": "Payment — Nordics",
  // Payment — Benelux
  "sisow.nl": "Payment — Benelux",
  // Video embeds — established hosted platforms only
  "sproutvideo.com": "Video embeds — established hosted platforms only",
  // CAPTCHA / bot protection
  "static.geetest.com": "CAPTCHA / bot protection",
  // Payment — Nordics
  "swish.nu": "Payment — Nordics",
  // Other embeddable platforms
  "ted.com": "Other embeddable platforms",
  // Payment — Benelux
  "tikkie.nl": "Payment — Benelux",
  // Open Banking
  "tink.com": "Open Banking",
  // Payment — Poland
  "tpay.com": "Payment — Poland",
  // Open Banking
  "truelayer.com": "Open Banking",
  "trustly.com": "Open Banking",
  // CAPTCHA / bot protection
  "turnstile.cloudflare.com": "CAPTCHA / bot protection",
  // Payment — DACH
  "twint.ch": "Payment — DACH",
  // JS libraries
  // Payment — DACH
  "unzer.com": "Payment — DACH",
  // Payment — core / international
  "verifone.cloud": "Payment — core / international",
  "verifone.com": "Payment — core / international",
  // Video infrastructure / delivery
  "videodelivery.net": "Video infrastructure / delivery",
  // Video embeds — established hosted platforms only
  "vimeocdn.com": "Video embeds — established hosted platforms only",
  // Payment — Nordics
  "vipps.no": "Payment — Nordics",
  "vippsmobilepay.com": "Payment — Nordics",
  // Open Banking
  "vyne.co.uk": "Open Banking",
  // Payment — Nordics
  "walleypay.com": "Payment — Nordics",
  // Payment — Benelux
  "wero-wallet.eu": "Payment — Benelux",
  // Video embeds — established hosted platforms only
  "wistia.com": "Video embeds — established hosted platforms only",
  "wistia.net": "Video embeds — established hosted platforms only",
  // Identity / SSO — Auth-as-a-service
  "workos.com": "Identity / SSO — Auth-as-a-service",
  // Payment — Benelux
  "worldline.com": "Payment — Benelux",
  // Payment — core / international
  "worldpay.com": "Payment — core / international",
  "x.klarnacdn.net": "Payment — core / international",
  // Video embeds — established hosted platforms only
  "youtu.be": "Streaming services — video",
  "youtube-nocookie.com": "Streaming services — video",
  "youtube.com": "Streaming services — video",
  "ytimg.com": "Video embeds — established hosted platforms only",
  // ── Added 10.2.0 — see the matching block in BUILTIN_DOMAINS_CORE above ──
  "ajax.googleapis.com": "Google API hosts (owner-published only)",
  "maps.googleapis.com": "Google API hosts (owner-published only)",
  "translate.googleapis.com": "Google API hosts (owner-published only)",
  "fonts.googleapis.com": "Google API hosts (owner-published only)",
  "accounts.google.com": "Identity / SSO — Google",
  "duosecurity.com": "Identity / SSO — Auth-as-a-service",
  "cardinalcommerce.com": "Payment — card 3-D Secure",
  "digid.nl": "Payment / ID — Europe (national schemes)",
  "eherkenning.nl": "Payment / ID — Europe (national schemes)",
  "ideal.nl": "Payment / ID — Europe (national schemes)",
  "mitid.dk": "Payment / ID — Europe (national schemes)",
  "bankid.com": "Payment / ID — Europe (national schemes)",
  "itsme-id.com": "Payment / ID — Europe (national schemes)",
  "pagbank.com.br": "Payment / ID — Brazil",
  "pagseguro.com.br": "Payment / ID — Brazil",
  "cielo.com.br": "Payment / ID — Brazil",
  "getnet.com.br": "Payment / ID — Brazil",
  "bb.com.br": "Payment / ID — Brazil",
  "itau.com.br": "Payment / ID — Brazil",
  "bradesco.com.br": "Payment / ID — Brazil",
  "nubank.com.br": "Payment / ID — Brazil",
  "mercadopago.com.br": "Payment / ID — Brazil",
  "mercadopago.com.ar": "Payment / ID — Spanish-speaking South America",
  "mercadopago.com.mx": "Payment / ID — Spanish-speaking South America",
  "mercadopago.cl": "Payment / ID — Spanish-speaking South America",
  "mercadopago.com.co": "Payment / ID — Spanish-speaking South America",
  "transbank.cl": "Payment / ID — Spanish-speaking South America",
  "pse.com.co": "Payment / ID — Spanish-speaking South America",
};

// ── Unified whitelist: core (above) + meeting / gaming / streaming apps ──────────────────────────────────────
// GUARD: the core list wins on a duplicate (an app entry never overrides a core entry's flags or category);
// tools/check-exemption-channels.mjs fails if any duplicate exists, so this is only a safety net.
function mergeAppDomains(core) {
    const merged = { ...core };
    for ( const domains of Object.values(APP_WHITELIST_DOMAINS) ) {
        for ( const domain of domains ) {
            if ( Object.hasOwn(merged, domain) ) { continue; }
            merged[domain] = { ...APP_WHITELIST_FLAGS };
        }
    }
    return Object.freeze(merged);
}

function mergeAppCategories(core) {
    const merged = { ...core };
    for ( const [ category, domains ] of Object.entries(APP_WHITELIST_DOMAINS) ) {
        for ( const domain of domains ) {
            if ( Object.hasOwn(merged, domain) ) { continue; }
            merged[domain] = category;
        }
    }
    return Object.freeze(merged);
}

export const BUILTIN_DOMAINS = mergeAppDomains(BUILTIN_DOMAINS_CORE);
export const BUILTIN_DOMAIN_CATEGORY = mergeAppCategories(BUILTIN_DOMAIN_CATEGORY_CORE);

// ── Whitelist levels (10.2.0) ────────────────────────────────────────────────────────────────────────────────
// ONE whitelist, TWO explicit levels, declared here and nowhere else:
//
//   WHITE — BUILTIN_DOMAINS above. Hosts where ONLY the owner publishes content. One treatment for every entry:
//           its third-party scripts/frames are allowed over the filter lists (core/builtin-whitelist-rules.js,
//           per the entry's own script/frame flags) AND it is outside Worry-free altogether, exactly as if typed
//           as "@@domain$worryfree" (data/trusted-service-domains.js → core/exempt-domains.js).
//   GREY  — GREY_DOMAINS below. Hosts where ANYONE can publish files or code (package CDNs, cloud upload
//           storage). Trusted as a service, never its content: NO allow over the filter lists and NO
//           Worry-free exemption — the filter lists and every protection apply to them as written. GREY never
//           touches filter rules. Its only effects: the Matrix panel's grey marker, a build WARNING when a
//           protection list would block a GREY host as a whole (tools/build/suspicious-hosting.mjs), and
//           tools/check-whitelist-levels.mjs refusing any such host as WHITE.
//
// A domain is in at most one level (checked by tools/check-whitelist-levels.mjs).
export const WHITELIST_LEVEL = Object.freeze({
    WHITE: 'white',
    GREY:  'grey',
});

// domain -> why anyone can publish there (shown as the Matrix panel's grey-marker tooltip).
export const GREY_DOMAINS = Object.freeze({
    'jsdelivr.net':                   'Package CDN — serves any npm or GitHub package anyone publishes',
    'unpkg.com':                      'Package CDN — serves any npm package anyone publishes',
    'esm.sh':                         'Package CDN — serves any npm package anyone publishes',
    'registry.npmjs.org':             'Package registry — anyone can publish',
    'storage.googleapis.com':         'Google Cloud Storage — anyone can host files',
    'firebasestorage.googleapis.com': 'Firebase Storage — anyone can host files',
});
