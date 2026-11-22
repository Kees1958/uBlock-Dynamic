/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/Kees1958/uBol-stripped

*/

// ── regex-rule-guard.js ──────────────────────────────────────────────────────
// B13: drop every DNR rule whose regexFilter Chrome's own regex engine refuses, BEFORE it is submitted.
// updateDynamicRules()/updateSessionRules() are atomic: one refused regex fails the whole batch — every other rule in it
// is lost too. (11.0.0) Moved out of js/core/ruleset-manager.js so the session-rule manager can use the same proven
// check (C21): a real incident — "\/wp-content\/[a-f0-9]{32}.js" from EasyList's cookie block list exceeded Chrome's
// 2 KB compiled-regex limit and took every cookie-notice and CMP-loader block rule down with it.
//
// Public interface:
//   pruneInvalidRegexRules(rules, rejected = [])  — the rules Chrome accepts; refused ones pushed to `rejected` as
//                                                   { regex, reason } (Chrome's reason, e.g. 'memoryLimitExceeded')
//
// State owned:
//   regexValidationCache {Map} — regex -> true | reason, bounded to REGEX_VALIDATION_CACHE_MAX (delete-then-set
//   refreshes recency, oldest evicted on overflow). In-memory only, lost on SW restart — safe: a cold cache only means
//   re-asking Chrome.
// ─────────────────────────────────────────────────────────────────────────────

import { dnr } from '../data/ext-compat.js';

// Bounded to avoid unbounded growth on repeated sandbox saves; 500 is generous for one user's rules.
const REGEX_VALIDATION_CACHE_MAX = 500;
const regexValidationCache = new Map();

export async function pruneInvalidRegexRules(rulesIn, rejected = []) {
    function validateRegex(regex) {
        return dnr.isRegexSupported({ regex, isCaseSensitive: false }).then(result => {
            // Cache: delete-then-set refreshes recency for FIFO eviction.
            regexValidationCache.delete(regex);
            regexValidationCache.set(regex, result?.reason || true);
            if ( regexValidationCache.size > REGEX_VALIDATION_CACHE_MAX ) {
                regexValidationCache.delete(regexValidationCache.keys().next().value);
            }
            if ( result.isSupported ) { return true; }
            rejected.push({ regex, reason: result?.reason });
            return false;
        });
    }

    const toCheck = [];
    for ( const rule of rulesIn ) {
        if ( rule.condition?.regexFilter === undefined ) {
            toCheck.push(true);
            continue;
        }
        const { regexFilter } = rule.condition;
        const cached = regexValidationCache.get(regexFilter);
        if ( cached !== undefined ) {
            toCheck.push(cached === true);
            if ( cached !== true ) {
                rejected.push({ regex: regexFilter, reason: cached });
            }
            continue;
        }
        toCheck.push(validateRegex(regexFilter));
    }

    const isValid = await Promise.all(toCheck);
    return rulesIn.filter((v, i) => isValid[i]);
}
