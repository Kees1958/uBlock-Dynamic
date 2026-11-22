// ── cmp-loader-block-manager.js ──────────────────────────────────────────────
// (10.7.16, owner's decision 2026-11-19) Keeps the CMP loader blocks (js/data/cmp-loader-blocks.js) in step with
// Seamless surfing: present while a session runs in DECLINE mode, absent otherwise. One session DNR rule per
// CMP_LOADER_BLOCKS entry, ids CMP_LOADER_BLOCK_RULES_BASE_ID + index, priority CMP_LOADER_BLOCK_PRIORITY.
//
// Precedence (standing rule, owner's decision 10.4.9, confirmed 2026-11-19): a site with a saved cookie-clicker
// rule is exempt — its hostnames go into excludedInitiatorDomains, the same site list the decline bundle's own
// excludeMatches uses (scripting-manager.js getCookieClickerRuleSites()).
//
// (11.0.0, owner's decisions 2026-11-19) Also owns Seamless surfing's cookie-notice BLOCK rules (AdGuard Cookie Notices +
// EasyList Cookie specific block, precompiled per mode by tools/build/cookie-notice-sources.mjs — the file names are in
// js/data/cookie-notice-sets.js COOKIE_NOTICE_MODE_FILES): present while a session runs in a mode that has a block file
// (decline, accept-else-decline), with the same exemption (saved-rule sites, added here as excludedInitiatorDomains —
// merged with a rule's own), their own id range (COOKIE_NOTICE_BLOCK_RULES_BASE_ID) and priority
// (COOKIE_NOTICE_BLOCK_PRIORITY). The files are package data: each read once per service-worker life
// (cookieNoticeBlockRulesCache); a failed read is logged and retried on the next pass, never thrown.
//
// Public interface:
//   syncCmpLoaderBlockRules(shouldBlock, exemptSites, cookieNoticeBlockFile) — add/replace or remove the rules:
//       shouldBlock = the CMP loader blocks (decline mode only); cookieNoticeBlockFile = the mode's block-rule file, or
//       null for none; called ONLY from
//       js/core/scripting-manager.js registerCookieClickerAutoDenyContentScriptsImpl(), the one place that already
//       decides whether Seamless surfing's banner bundle is on and in which mode (same two call paths: the
//       session's INIT and RELEASE, plus every re-registration pass, start-up included).
//
// Dependencies: js/data/ext-compat.js (dnr), js/data/cmp-loader-blocks.js, js/core/dnr-budgets.js.
//
// State owned: none in memory. The rules themselves are SESSION rules — the browser drops them at a genuine
// restart, exactly when the Seamless surfing session ends (cookie-clicker-autodeny-manager.js); a service-worker
// restart keeps them, and the next registration pass re-checks them anyway.
//
// GUARDS
//   init    — rules are only ever built from CMP_LOADER_BLOCKS, capped at CMP_LOADER_BLOCK_RULES_MAX ids;
//   clear   — every pass removes ALL ids of the range it does not want present (so a shrunk list leaves nothing
//             behind), and the RELEASE path removes the whole range;
//   churn   — the current rules are read first; when they already equal the wanted set, no DNR write is made;
//   failure — a failed DNR read/write is logged with context and leaves the previous state; never thrown, so it
//             can never stop the banner bundle's own registration that calls this.
// ─────────────────────────────────────────────────────────────────────────────

import { PLAIN_HOSTNAME_RE } from '../util/utils.js';
import { dnr } from '../data/ext-compat.js';
import { pruneInvalidRegexRules } from './regex-rule-guard.js';
import { browser } from '../data/ext.js';
import { CMP_LOADER_BLOCKS } from '../data/cmp-loader-blocks.js';
import { COOKIE_NOTICE_MODE_FILES } from '../data/cookie-notice-sets.js';
import {
    CMP_LOADER_BLOCK_PRIORITY,
    CMP_LOADER_BLOCK_RULES_BASE_ID,
    CMP_LOADER_BLOCK_RULES_MAX,
    COOKIE_NOTICE_BLOCK_PRIORITY,
    COOKIE_NOTICE_BLOCK_RULES_BASE_ID,
    COOKIE_NOTICE_BLOCK_RULES_MAX,
} from './dnr-budgets.js';

// Every id this module may own — both reserved ranges in full, so RELEASE also removes ids a longer list once used.
const OWN_RULE_IDS = Object.freeze([
    ...Array.from({ length: CMP_LOADER_BLOCK_RULES_MAX }, (_, i) => CMP_LOADER_BLOCK_RULES_BASE_ID + i),
    ...Array.from({ length: COOKIE_NOTICE_BLOCK_RULES_MAX }, (_, i) => COOKIE_NOTICE_BLOCK_RULES_BASE_ID + i),
]);
const OWN_RULE_ID_SET = new Set(OWN_RULE_IDS);

// A hostname that can safely go into excludedInitiatorDomains (one malformed entry fails the WHOLE update).
const DNR_DOMAIN_RE = PLAIN_HOSTNAME_RE;   // (11.0.2) shared shape, underscores allowed

function buildLoaderBlockRules(exemptSites) {
    if ( CMP_LOADER_BLOCKS.length > CMP_LOADER_BLOCK_RULES_MAX ) {
        console.error(`[uBlock-Dynamic] cmp-loader-block-manager: ${CMP_LOADER_BLOCKS.length} loader blocks exceed `
            + `CMP_LOADER_BLOCK_RULES_MAX (${CMP_LOADER_BLOCK_RULES_MAX}) — the extra ones are ignored`);
    }
    return CMP_LOADER_BLOCKS.slice(0, CMP_LOADER_BLOCK_RULES_MAX).map((entry, i) => {
        const condition = {
            urlFilter: entry.urlFilter,
            resourceTypes: [ ...entry.resourceTypes ],
        };
        if ( exemptSites.length !== 0 ) { condition.excludedInitiatorDomains = [ ...exemptSites ]; }
        return {
            id: CMP_LOADER_BLOCK_RULES_BASE_ID + i,
            priority: CMP_LOADER_BLOCK_PRIORITY,
            action: { type: 'block' },
            condition,
        };
    });
}

// (11.0.0) The precompiled cookie-notice block rules per file (package data; a file is absent until read, a failed read
// leaves it absent so the next pass retries). Released with the service worker — nothing else holds them.
const cookieNoticeBlockRulesCache = new Map();
// The files this module may read: exactly the block files js/data/cookie-notice-sets.js declares (C6 — a caller can never
// make it fetch anything else).
const COOKIE_NOTICE_BLOCK_FILES = new Set(Object.values(COOKIE_NOTICE_MODE_FILES).map(f => f.blocks).filter(Boolean));
async function readCookieNoticeBlockRules(file) {
    if ( file === null ) { return []; }
    if ( COOKIE_NOTICE_BLOCK_FILES.has(file) === false ) {
        console.warn(`[uBlock-Dynamic] cmp-loader-block-manager: unknown cookie-notice block file ${JSON.stringify(file)} — ignored`);
        return [];
    }
    if ( cookieNoticeBlockRulesCache.has(file) ) { return cookieNoticeBlockRulesCache.get(file); }
    try {
        const rules = await (await fetch(browser.runtime.getURL(`/${file}`))).json();
        // Input validation (C6): only block rules with a condition; the build already enforces the cap.
        const valid = Array.isArray(rules)
            ? rules.filter(r => r?.action?.type === 'block' && r.condition !== null && typeof r.condition === 'object')
            : [];
        cookieNoticeBlockRulesCache.set(file, valid.slice(0, COOKIE_NOTICE_BLOCK_RULES_MAX));
    } catch (reason) {
        console.error(`[uBlock-Dynamic] cmp-loader-block-manager: cannot read the cookie-notice block rules (${file}):`, reason);
        return [];
    }
    return cookieNoticeBlockRulesCache.get(file);
}

function buildCookieNoticeBlockRules(rules, exemptSites) {
    return rules.map((rule, i) => {
        const condition = { ...rule.condition };
        if ( exemptSites.length !== 0 ) {
            condition.excludedInitiatorDomains = [ ...new Set([ ...(condition.excludedInitiatorDomains ?? []), ...exemptSites ]) ];
        }
        return { id: COOKIE_NOTICE_BLOCK_RULES_BASE_ID + i, priority: COOKIE_NOTICE_BLOCK_PRIORITY, action: { type: 'block' }, condition };
    });
}

// Order-independent comparison of the rule sets that matter (id, priority, action and the whole condition, with every
// array sorted — Chrome may return them in another order).
function ruleKey(rule) {
    const c = rule.condition ?? {};
    const condition = Object.keys(c).sort().map(k => [ k, Array.isArray(c[k]) ? [ ...c[k] ].sort() : c[k] ]);
    return JSON.stringify([ rule.id, rule.priority, rule.action?.type, condition ]);
}

// (11.0.0) Regexes already reported as refused this service-worker lifetime — an expected, handled case, logged once
// (info, not an error) instead of on every sync. Bounded by the shipped list's regex rules; lost on SW restart (safe).
const reportedRejectedRegexes = new Set();

export async function syncCmpLoaderBlockRules(shouldBlock, exemptSites = [], cookieNoticeBlockFile = null) {
    // Input validation at the module boundary (C6): only a real boolean switches the block on; only well-formed
    // hostnames are passed on to DNR.
    if ( typeof shouldBlock !== 'boolean' ) {
        console.warn('[uBlock-Dynamic] cmp-loader-block-manager: shouldBlock must be a boolean — treated as false');
        shouldBlock = false;
    }
    const sites = Array.isArray(exemptSites)
        ? [ ...new Set(exemptSites.filter(h => typeof h === 'string' && DNR_DOMAIN_RE.test(h))) ].sort()
        : [];

    const built = [
        ...(shouldBlock ? buildLoaderBlockRules(sites) : []),
        ...buildCookieNoticeBlockRules(await readCookieNoticeBlockRules(typeof cookieNoticeBlockFile === 'string' ? cookieNoticeBlockFile : null), sites),
    ];
    // (11.0.0) GUARD (B13): updateSessionRules() is all-or-nothing — one regex Chrome refuses (real case: EasyList's
    // "\/wp-content\/[a-f0-9]{32}.js" over the 2 KB compiled limit) dropped EVERY rule here. Ask Chrome first, drop
    // only the refused ones, say which.
    const rejected = [];
    const wanted = await pruneInvalidRegexRules(built, rejected);
    for ( const { regex, reason } of rejected ) {
        if ( reportedRejectedRegexes.has(regex) ) { continue; }
        reportedRejectedRegexes.add(regex);   // bounded: at most the shipped list's regex rules (3 today)
        console.info(`[uBlock-Dynamic] cmp-loader-block-manager: regex rule skipped, Chrome refuses it (${reason}): ${regex}`);
    }

    let present;
    try {
        present = (await dnr.getSessionRules()).filter(r => OWN_RULE_ID_SET.has(r.id));
    } catch (reason) {
        console.error('[uBlock-Dynamic] cmp-loader-block-manager: getSessionRules failed:', reason);
        return;
    }
    const presentKeys = present.map(ruleKey).sort();
    const wantedKeys = wanted.map(ruleKey).sort();
    if ( JSON.stringify(presentKeys) === JSON.stringify(wantedKeys) ) { return; }   // churn guard

    try {
        await dnr.updateSessionRules({ removeRuleIds: [ ...OWN_RULE_IDS ], addRules: wanted });
    } catch (reason) {
        console.error('[uBlock-Dynamic] cmp-loader-block-manager: updateSessionRules failed:', reason);
    }
}
