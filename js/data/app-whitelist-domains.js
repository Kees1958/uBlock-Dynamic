// ── app-whitelist-domains.js ─────────────────────────────────────────────────
// Well-known meeting/chat apps, gaming platforms and streaming services, declared ONCE, as part of the ONE
// unified whitelist (10.1.6).
//
// One list, two effects (no second copy anywhere):
//   1. Matrix built-in whitelist — merged into BUILTIN_DOMAINS / BUILTIN_DOMAIN_CATEGORY by
//      data/matrix-constants.js, so core/builtin-whitelist-rules.js allows these domains' third-party scripts and
//      frames over the filter lists (priority BUILTIN_WHITELIST_RULES_PRIORITY) and the Matrix panel marks them.
//   2. Worry-free whitelist — every whitelist entry is in data/trusted-service-domains.js (10.2.0: one whitelist,
//      one treatment, no category filter), so each domain is exempt from every Worry-free and safer-regions
//      protection, exactly as if typed as "@@domain$worryfree".
//
// This replaces the old eval-only STREAMING_GAMING_EXCLUDES list (core/compiled-filters.js), which is removed:
// a whole-site Worry-free exemption already covers the obfuscated-eval block.
//
// STANDING RULE: when a language / region filter list is added, add that area's meeting, gaming and streaming
// services HERE in the same release (and its payment / bank / sign-in services to the whitelist in
// matrix-constants.js — 10.2.0: the separate EXTRA_TRUSTED_DOMAINS list is gone).
//
// Entries are registrable domains (or a deliberate host such as chzzk.naver.com); they match the domain and all of
// its subdomains. List an app's own domains only — never a CDN shared with other sites and never a whole portal
// whose main business is not the app. YouTube's own domains live in matrix-constants.js (category "Streaming
// services — video") because they pre-date this list.
//
// Validated by tools/check-exemption-channels.mjs: lower-case hostnames, no duplicates inside this list, none
// shared with the Matrix core list.
//
// Pure data, built once at import: nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────

// Flags given to every app entry: allow third-party scripts and frames (same meaning as BUILTIN_DOMAINS).
export const APP_WHITELIST_FLAGS = Object.freeze({ script: true, frame: true });

const APP_CATEGORY_MEETING   = 'Meeting and chat apps';
const APP_CATEGORY_GAMING    = 'Gaming platforms';
const APP_CATEGORY_STREAMING = 'Streaming services';

export const APP_WHITELIST_DOMAINS = Object.freeze({
    [APP_CATEGORY_MEETING]: Object.freeze([
        // International
        'zoom.us', 'zoom.com', 'zoomgov.com', 'teams.microsoft.com', 'teams.live.com', 'meet.google.com',
        'webex.com', 'whereby.com', 'discord.gg',
        'gotomeeting.com', 'goto.com', 'jitsi.org', 'meet.jit.si', '8x8.vc',
        'whatsapp.com', 'signal.org', 'livestorm.co', 'daily.co',
        'viber.com',
        // (10.4.6) Japan and Korea removed — out of the geographic scope again, with their filters.
        // (10.6.2) discord.com, discordapp.com and discordapp.net removed — not a meeting app, and its
        // attachment/media CDNs serve arbitrary user-uploaded files unchecked (3P-Matrix-lite 4.5.6 decision,
        // real malware report 2026-11-04). discord.gg (invite links only, no attachment delivery) is unaffected
        // and stays.
        // (10.6.3, same 3P-Matrix-lite cross-check) slack.com removed — files.slack.com is a user-upload CDN,
        // the same hole as Discord's attachment hosts. whatsapp.net removed — WhatsApp's own media/CDN host,
        // user-uploaded files (whatsapp.com itself, the app, is unaffected). telegram.org removed — flagged on
        // this user's own DownloadSentinel malware-delivery list. bluejeans.com, skype.com and chime.aws removed
        // — all three services are discontinued (Verizon folded BlueJeans; Microsoft retired Skype May 2025;
        // Amazon ended Chime support 2026-02-20), so the entries were dead weight, not a security issue.
        // Brazil / South America
        'conferenciaweb.rnp.br',
    ]),
    [APP_CATEGORY_GAMING]: Object.freeze([
        // International
        'steampowered.com', 'epicgames.com', 'battle.net', 'blizzard.com', 'xbox.com',
        'xboxlive.com', 'playstation.com', 'playstation.net', 'nintendo.com', 'ea.com', 'ubisoft.com',
        'riotgames.com', 'rockstargames.com', 'gog.com', 'minecraft.net', 'mojang.com',
        // (10.6.2) steamcommunity.com and itch.io removed — both user-generated/self-publish platforms
        // (most-phished gaming domain; anyone can upload executables), not official publisher sites like the
        // rest of this list (3P-Matrix-lite 4.5.6 decision).
        // (10.6.3) roblox.com removed — same reason: user-generated games, a common malware/scam lure, not an
        // official-publisher-only site like the rest of this list.
        // International publishers based in Japan / Korea / China (kept: their .com sites serve every region).
        // (10.4.6) The Japan- and Korea-only domains (.co.jp, cygames) were removed — out of the geographic scope.
        'square-enix.com', 'capcom.com', 'konami.com', 'sega.com', 'bandainamcoent.com',
        'nexon.com', 'ncsoft.com', 'netmarble.com', 'krafton.com', 'pubg.com', 'pearlabyss.com', 'smilegate.com',
        'hoyoverse.com', 'mihoyo.com',
        // South America
        'garena.com',
    ]),
    [APP_CATEGORY_STREAMING]: Object.freeze([
        // International
        'netflix.com', 'primevideo.com', 'disneyplus.com', 'hulu.com', 'max.com', 'twitch.tv', 'spotify.com',
        'paramountplus.com', 'peacocktv.com', 'crunchyroll.com', 'dazn.com', 'plex.tv',
        // (10.4.6) Japan and Korea removed — out of the geographic scope again, with their filters.
        // South America (globoplay only: globo.com itself is a news portal)
        'globoplay.globo.com', 'clarovideo.com', 'vix.com',
        // (10.6.3) starplus.com removed — Disney folded Star+ into Disney+ in Latin America in 2024; the
        // service is discontinued, so the entry was dead weight.
    ]),
});
