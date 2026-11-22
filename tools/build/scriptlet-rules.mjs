// ── tools/build/scriptlet-rules.mjs ───────────────────────────────────────────────────
// Scriptlet rule parsing: AG scriptlet rules, scriptlet EXCEPTION rules and their application.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: applyScriptletExceptions, parseScriptletExceptionRules, parseScriptletRules
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).
import { droppedGenericDomainQualifiers, droppedUnsupportedScriptletScopes } from './build-state.mjs';
import { GENERIC_DOMAIN_QUALIFIER_RE, filterGenericDomainQualifier, isTLDKept } from './tld-scope.mjs';

/******************************************************************************/
// AG scriptlet rule parser
// Parses #%#//scriptlet('name', 'arg1', 'arg2'...) lines.
// Returns { hostnames: string[], name: string, args: string[] }[]
/******************************************************************************/

export function parseScriptletRules(text, tldCheckFn = isTLDKept, allowGenericDomainQualifier = false) {
    const rules = [];

    for ( const line of text.split('\n') ) {
        const t = line.trim();
        if ( !t || t.startsWith('!') ) { continue; }

        // Generic form: [$domain=...]#%#//scriptlet(...). ARCHITECTURAL
        // LIMIT, not a TLD-filtering decision: this codebase's scriptlet
        // dispatch is a static hostname→data lookup table built once at
        // build time (see buildScriptletFile()) — there is no per-page
        // regex-matching path a `[$domain=/regex/]` rule could hook into.
        // Every real instance of this shape found in AdGuard Base uses a
        // regex, not an enumerable hostname list (see the comment on
        // GENERIC_DOMAIN_QUALIFIER_RE), so none of them are dispatchable
        // today regardless of TLD. The TLD check still runs — purely to
        // log what a future regex-aware dispatch mechanism could recover
        // — but the rule itself is always dropped here. See
        // droppedGenericDomainQualifiers accumulator below.
        if ( allowGenericDomainQualifier ) {
            const gm = GENERIC_DOMAIN_QUALIFIER_RE.exec(t);
            // Only claim lines that are actually scriptlet-shaped
            // (contain #%#//scriptlet( after the bracket) — otherwise
            // it's some other bracket-qualified syntax (e.g. a #$# CSS-
            // injection rule) this function has no business reporting on;
            // let it fall through unclaimed rather than log a misleading
            // reason for a line that was never a scriptlet rule.
            if ( gm && t.includes('#%#//scriptlet(') ) {
                const kept = filterGenericDomainQualifier(gm[1], tldCheckFn);
                droppedGenericDomainQualifiers.push({
                    line: t,
                    wouldKeep: kept !== null,
                    reason: 'no static dispatch path for regex-scoped generic rules',
                });
                continue;
            }
        }

        // Must contain #%#//scriptlet(
        const sepIdx = t.indexOf('#%#//scriptlet(');
        if ( sepIdx === -1 ) { continue; }

        // Hostnames: everything before #%#
        const hostnamesPart = t.slice(0, sepIdx);
        if ( !hostnamesPart ) { continue; }

        // Unsupported scopes (10.1.7): the dispatch table is keyed by plain
        // hostnames and entities only. Two shapes used to slip through and
        // become dispatch keys that no page hostname can ever equal:
        //   1. a bracket-prefixed scope — `[$path=/tv]youtube.com#%#...`,
        //      `[$url=/re/]...`, or a `[$domain=/re/]` on a list that does
        //      not take the generic form. Never fired; a regex containing
        //      a comma (`{1,3}`) was even cut into several garbage keys.
        //   2. a negated hostname — `~m.rp5.ru`. The key never matched, so
        //      the exclusion was never honoured: the rule still applies to
        //      its other hostnames (including the one the list author
        //      meant to exclude).
        // Both are now dropped HERE, explicitly, and reported. Behaviour of
        // the shipped extension does not change (these keys were dead);
        // supporting the scopes would be a new feature, not done here.
        if ( hostnamesPart.startsWith('[') ) {
            droppedUnsupportedScriptletScopes.push({ kind: 'bracket-modifier', line: t });
            continue;
        }
        const listedHostnames = hostnamesPart.split(',').map(h => h.trim()).filter(Boolean);
        for ( const h of listedHostnames ) {
            if ( h.startsWith('~') ) {
                droppedUnsupportedScriptletScopes.push({ kind: 'negated-hostname', line: t });
            }
        }
        const hostnames = listedHostnames.filter(h => !h.startsWith('~') && tldCheckFn(h));
        if ( hostnames.length === 0 ) { continue; }

        // Scriptlet call: extract content inside scriptlet(...)
        const callStart = sepIdx + '#%#//scriptlet('.length;
        const callEnd   = t.lastIndexOf(')');
        if ( callEnd <= callStart ) { continue; }
        const callContent = t.slice(callStart, callEnd);

        // Parse quoted arguments — handles nested quotes in CSS selectors.
        // e.g. 'div[data-testid="foo"] button' must be one arg.
        const args = [];
        {
            let qi = 0;
            while ( qi < callContent.length ) {
                if ( callContent[qi] === ',' || callContent[qi] === ' ' ) { qi++; continue; }
                if ( callContent[qi] === "'" || callContent[qi] === '"' ) {
                    const q = callContent[qi++];
                    let val = '';
                    while ( qi < callContent.length ) {
                        if ( callContent[qi] === q ) { qi++; break; }
                        val += callContent[qi++];
                    }
                    args.push(val);
                } else {
                    qi++;
                }
            }
        }
        if ( args.length === 0 ) { continue; }

        const [name, ...scriptletArgs] = args;
        if ( !name ) { continue; }

        rules.push({ hostnames, name, args: scriptletArgs });
    }

    return rules;
}

/******************************************************************************/
// Scriptlet EXCEPTION rule parser (item 1 — "SAFE-FILTERS" per-site
// scriptlet exceptions).
//
// Two forms, both living in badfilter-quick-fixes.txt alongside the
// existing $badfilter lines (same "personal corrections to upstream
// lists" category — see that file's own header):
//
//   bbc.com#@#//scriptlet('prevent-element-src-loading','script','pub.doubleverify.com')
//     NAMED — cancels exactly one [name, args] scriptlet directive on
//     that hostname. args must match exactly (same values, same order)
//     against what the upstream list actually compiled for that
//     hostname/name pair, or nothing is cancelled — this is intentional:
//     a near-miss should fail silently closed (nothing removed) rather
//     than guess which directive was meant.
//
//   bbc.com#@#//scriptlet()
//     WILDCARD — cancels EVERY scriptlet directive on that hostname,
//     regardless of name or args. A blunt stopgap, not a first choice
//     (see this project's own discussion on why — it silently swallows
//     any future addition too, not just the one that was broken). Any
//     wildcard exception in use is surfaced as a build-time warning that
//     halts packaging until explicitly confirmed — see the wildcard-
//     warning block near the end of build() below.
//
// Deliberately a SEPARATE function from parseScriptletRules() above,
// not a branch inside it: an exception is not a directive (it produces
// no FNS entry, no dispatch-table row — it only ever REMOVES an entry
// something else already produced), so giving it its own return shape
// keeps that distinction explicit rather than overloading one shape to
// mean two different things.
export function parseScriptletExceptionRules(text) {
    const exceptions = [];
    for ( const line of text.split('\n') ) {
        const t = line.trim();
        if ( !t || t.startsWith('!') ) { continue; }

        const sepIdx = t.indexOf('#@#//scriptlet(');
        if ( sepIdx === -1 ) { continue; }

        const hostnamesPart = t.slice(0, sepIdx);
        if ( !hostnamesPart ) { continue; }
        const hostnames = hostnamesPart.split(',').map(h => h.trim()).filter(Boolean);
        if ( hostnames.length === 0 ) { continue; }

        const callStart = sepIdx + '#@#//scriptlet('.length;
        const callEnd   = t.lastIndexOf(')');
        if ( callEnd < callStart ) { continue; }
        const callContent = t.slice(callStart, callEnd).trim();

        // Empty parens (whitespace-only content) = wildcard form.
        if ( callContent === '' ) {
            for ( const hn of hostnames ) {
                exceptions.push({ hostname: hn, wildcard: true, line: t });
            }
            continue;
        }

        // Named form — same quote-aware argument split as
        // parseScriptletRules() uses for the injection form (see B15 —
        // two parsers of the same underlying call syntax must share the
        // splitting logic or they silently drift; this one is copied
        // from, not re-derived independently of, that one).
        const args = [];
        {
            let qi = 0;
            while ( qi < callContent.length ) {
                if ( callContent[qi] === ',' || callContent[qi] === ' ' ) { qi++; continue; }
                if ( callContent[qi] === "'" || callContent[qi] === '"' ) {
                    const q = callContent[qi++];
                    let val = '';
                    while ( qi < callContent.length ) {
                        if ( callContent[qi] === q ) { qi++; break; }
                        val += callContent[qi++];
                    }
                    args.push(val);
                } else {
                    qi++;
                }
            }
        }
        if ( args.length === 0 ) { continue; }

        const [name, ...scriptletArgs] = args;
        if ( !name ) { continue; }

        for ( const hn of hostnames ) {
            exceptions.push({ hostname: hn, wildcard: false, name, args: scriptletArgs, line: t });
        }
    }
    return exceptions;
}

/******************************************************************************/
// Applies parsed scriptlet exceptions (item 1) against the accumulated
// scriptlet rule set. Pure function — no fs/console access, no reliance
// on build()'s module-scope state — specifically so it can be exercised
// directly by a standalone test driver without needing the rest of the
// build pipeline.
//
// Named exceptions remove one exact [hostname, name, args] match;
// wildcard exceptions remove every directive for that hostname
// regardless of name/args. Both work by filtering `hostnames` on each
// rule, dropping the rule entirely once its hostnames list is empty — a
// rule can list several hostnames, and an exception must only ever
// remove the one(s) it actually names, not the whole rule.
//
// Returns everything the caller needs to both update its own
// allScriptletRules array and report/persist what happened — no
// console.log or fs writes happen in here.
export function applyScriptletExceptions(scriptletRules, exceptions) {
    const namedExceptions = exceptions.filter(e => !e.wildcard);
    const wildcardHostnames = new Set(exceptions.filter(e => e.wildcard).map(e => e.hostname));
    const matchedNamed = new Set();
    const wildcardSuppressedCounts = new Map(); // hostname -> directive count removed

    const filteredRules = [];
    for ( const rule of scriptletRules ) {
        const keptHostnames = rule.hostnames.filter(hn => {
            if ( wildcardHostnames.has(hn) ) {
                wildcardSuppressedCounts.set(hn, (wildcardSuppressedCounts.get(hn) ?? 0) + 1);
                return false;
            }
            const argsJSON = JSON.stringify(rule.args ?? []);
            for ( const ex of namedExceptions ) {
                if ( ex.hostname !== hn ) { continue; }
                if ( ex.name !== rule.name ) { continue; }
                if ( JSON.stringify(ex.args) !== argsJSON ) { continue; }
                matchedNamed.add(ex.line);
                return false;
            }
            return true;
        });
        if ( keptHostnames.length === 0 ) { continue; }
        filteredRules.push(
            keptHostnames.length === rule.hostnames.length ? rule : { ...rule, hostnames: keptHostnames }
        );
    }

    const droppedRuleCount = scriptletRules.length - filteredRules.length;
    const unmatchedNamed = namedExceptions.filter(e => !matchedNamed.has(e.line)).map(e => e.line);
    const wildcardReport = [...wildcardHostnames].map(hostname => ({
        hostname,
        suppressedCount: wildcardSuppressedCounts.get(hostname) ?? 0,
    }));

    return {
        filteredRules,
        wildcardReport,
        unmatchedNamed,
        droppedRuleCount,
        namedCount: namedExceptions.length,
        wildcardCount: wildcardHostnames.size,
    };
}
