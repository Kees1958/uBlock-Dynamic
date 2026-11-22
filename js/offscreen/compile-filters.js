/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2026-present Raymond Hill

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
    Based on uBlock Origin (https://github.com/gorhill/uBlock), modified in
    2026 for uBlock-Stripped-Dynamic — see CHANGELOG.md for the changes.
*/

/******************************************************************************/
//
// Architecture note: files under js/offscreen/ run inside the extension's
// offscreen document (compile-filters.html), a separate execution context
// from both the service worker and any page. They communicate with the SW
// only via chrome.runtime messaging, never via direct import. Outside the
// five-tier ui/workflow/core/util/data dependency model — see
// ARCHITECTURE.md.
//
/******************************************************************************/

import * as sfp from '../core/static-filtering-parser.js';
import { explainValidationDrop, minimizeRules, minimizeRuleset, validateRules } from '../core/ubo-parser.js';
import { makeCosmeticScripts } from './make-cosmetic-filters.js';
import { explainNetworkRejection, normalizeAbpNetworkLine, parseNetworkFilter } from '../core/ubo-parser.js';
import { safeReplace } from './safe-replace.js';

/******************************************************************************/

const browser = (self.browser || self.chrome);

const resourceTypes = await browser.runtime.sendMessage({
    what: 'compileFilters:getResourceTypes'
});

/******************************************************************************/


/******************************************************************************/

export function compileCosmeticFilter(parser, output) {
    const { compiled, exception } = parser.result;
    if ( compiled === undefined ) { return; }
    const sanitized = sanitizeCompiledCosmeticFilter(compiled);
    const matches = [];
    const excludeMatches = [];
    for ( const { hn, not, bad } of parser.getExtFilterDomainIterator() ) {
        if ( bad ) { continue; }
        if ( not && exception ) { continue; }
        if ( not || exception ) {
            excludeMatches.push(hn);
        } else if ( hn === '*' ) {
            if ( parser.options.trustedSource !== true ) { continue; }
            matches.length = 0;
            matches.push('*');
        } else {
            if ( matches[0] === '*' ) { continue; }
            matches.push(hn);
        }
    }
    // This should not happen
    if ( matches.length === 0 && excludeMatches.length === 0 ) { return; }
    // Only negated hostnames => generic cosmetic filter
    if ( exception === false ) {
        if ( matches.length === 0 && excludeMatches.length !== 0 ) { return; }
    }
    const details = output.get(sanitized) ?? {};
    if ( details.matches === undefined ) {
        details.matches = [];
        details.excludeMatches = [];
        output.set(sanitized, details);
    }
    if ( matches.length ) {
        if ( matches.includes('*') ) {
            details.matches = [ '*' ];
        } else if ( details.matches.includes('*') === false ) {
            details.matches.push(...matches);
        }
    }
    if ( excludeMatches.length ) {
        details.excludeMatches.push(...excludeMatches);
    }
}

function sanitizeCompiledCosmeticFilter(compiled) {
    if ( compiled.startsWith('{') === false ) { return compiled; }
    const parsed = JSON.parse(compiled);
    parsed.raw = undefined;
    return JSON.stringify(parsed);
}

/******************************************************************************/

export function compileFilters(listid, text, context = {}) {
    if ( Boolean(text) === false ) { return; }

    const parser = new sfp.AstFilterParser(context);

    const unminimizedRules = [];
    const specificCosmeticDetails = new Map();
    // (10.7.6) Every network line that yields no rule, with the reason — the Import ABP box comments it out and
    // shows the reason in red beneath it (js/core/filter-manager.js annotateRejectedSandboxLines()).
    const rejectedLines = [];

    const lines = text.split(/\n/).map(a => a.trim());
    const filterStats = {
       total: 0,
       accepted: 0,
       rejected: 0,
    };
    for ( const line of lines ) {
        parser.parse(normalizeAbpNetworkLine(line));   // (10.7.6) same dialect normalisation as the build
        if ( parser.hasError() ) {
            if ( parser.isNetworkFilter() ) { rejectedLines.push({ line, reason: explainNetworkRejection(line, true) }); }
            continue;
        }
        // Scriptlet rules (+js()) are silently skipped — the userScripts
        // permission has been removed and scriptlet output is not registered.
        if ( parser.isScriptletFilter() ) { continue; }
        if ( parser.isCosmeticFilter() ) {
            if ( parser.hasOptions() === false ) { continue; }
            compileCosmeticFilter(parser, specificCosmeticDetails);
            continue;
        }
        if ( parser.isNetworkFilter() ) {
            filterStats.total += 1;
            const rule = parseNetworkFilter(parser, {
                resourceTypes,
            });
            // (10.7.6) A rule validateRules() will drop is reported on its own line now, not lost after minimising.
            const dropReason = rule ? explainValidationDrop(rule) : null;
            if ( rule && dropReason !== null ) {
                filterStats.rejected += 1;
                rejectedLines.push({ line, reason: dropReason });
            } else if ( rule ) {
                unminimizedRules.push(rule);
                filterStats.accepted += 1;
            } else {
                filterStats.rejected += 1;
                rejectedLines.push({ line, reason: explainNetworkRejection(line) });
            }
            continue;
        }
    }

    let minimizedRules = minimizeRuleset(unminimizedRules);
    minimizedRules = minimizeRules(minimizedRules);
    minimizedRules = validateRules(minimizedRules);
    const regexRuleCount = minimizedRules.reduce((a, b) => {
        return b.condition.regexFilter ? a+1 : a;
    }, 0);

    return {
        filterStats,
        ruleStats: {
            total: minimizedRules.length,
            plain: minimizedRules.length - regexRuleCount,
            regex: regexRuleCount,
        },
        dnrRules: minimizedRules,
        specificCosmeticDetails,
        rejectedLines,
    };
}

/******************************************************************************/

export async function toMv3Data(rulesetid, compiledData) {
    const isolated = [];

    if ( Boolean(compiledData) === false ) { return; }

    if ( compiledData.specificCosmeticDetails.size ) {
        const result = makeCosmeticScripts(rulesetid, compiledData.specificCosmeticDetails);
        if ( result ) {
            const [
                cssAPI,
                isolatedAPI,
                proceduralAPI,
                template,
            ] = await Promise.all([
                fetch('../scripting/css-api.js').then(response => response.text()),
                fetch('../scripting/isolated-api.js').then(response => response.text()),
                fetch('../scripting/css-procedural-api.js').then(response => response.text()),
                fetch('./css-compiled.template.js').then(response => response.text()),
            ]);
            const code = [
                cssAPI,
                isolatedAPI,
                proceduralAPI,
                safeReplace(template, 'self.$cssSpecificData$', JSON.stringify(result.data)),
            ].join('\n');
            const hostnames = result.data.hasEntities || result.data.regexes.length
                ? '*'
                : result.data.hostnames;
            isolated.push({
                id: `${rulesetid}-css-specific`,
                code,
                hostnames,
            });
        }
    }

    const output = {}
    if ( compiledData.dnrRules.length ) {
        output.dnrRules = minimizeRuleset(compiledData.dnrRules);
        output.dnrRules = minimizeRules(output.dnrRules);
        output.dnrRules = validateRules(output.dnrRules);
    }
    if ( isolated.length ) {
        output.isolated = isolated;
    }

    return output;
}

/******************************************************************************/

async function compileSandboxFilters() {
    const text = await browser.runtime.sendMessage({
        what: 'compileFilters:getUserList'
    });
    if ( Boolean(text) === false ) { return; }
    return compileFilters('sandbox', text, {
        localSource: true,
        nativeCssHas: true,
        trustedSource: true,
    });
}

/******************************************************************************/

(async ( ) => {
    const sandboxResult = await compileSandboxFilters();
    const sandboxCompiled = await toMv3Data('sandbox', sandboxResult) ?? {};
    const msg = {
        what: 'compileFilters:result',
        sandbox: {},
    };
    if ( sandboxCompiled.isolated?.length ) {
        msg.sandbox.ISOLATED = sandboxCompiled.isolated;
    }
    if ( sandboxResult?.rejectedLines?.length ) {
        msg.sandbox.rejectedLines = sandboxResult.rejectedLines;   // (10.7.6) annotated in the editor
    }
    if ( sandboxCompiled.dnrRules?.length ) {
        msg.sandbox.dnrRules = sandboxCompiled.dnrRules;
    }
    // (11.0.2, audit 11.0.2 finding 4) Logged, not unhandled. The worker's own timeout (js/core/compiled-filters.js)
    // still tells the person the rules could not be applied.
    await browser.runtime.sendMessage(msg);
})().catch(reason => {
    console.error('[uBlock-Dynamic] offscreen compiler: result not delivered:', reason);
});

/******************************************************************************/
