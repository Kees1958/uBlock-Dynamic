// ── tools/build/country-overflow.mjs ──────────────────────────────────────────────────
// Country-TLD overflow extraction — per-country-TLD content pulled out of a list.
//
// Moved VERBATIM out of tools/build-rulesets.mjs (phase 2 module split, 9.8.x);
// the only edits are import/export lines, the setter calls listed in
// build-state.mjs, and two data-file URLs. A replayed build is byte-identical
// (tools/verify-build-unchanged.mjs).
//
// Public interface: extractCountryOverflow
// Dependencies: see the imports below (strictly acyclic; no module imports one that imports it).


/******************************************************************************/
// Country-TLD overflow extraction — pulls per-country-TLD content out of a
// filter list's DNR rules and cosmetic map into separate buckets, rather
// than dropping it (compare stripForeignRulesSection() above, which drops).
// Used to split AdGuard Base's mixed-country content into hidden "overflow"
// rulesets that auto-enable alongside a matching dedicated country filter
// (see data/ruleset-companions.js, added when this is wired up at runtime)
// or a locale-detected default.
//
// IMPORTANT: every domain-bearing condition field (domains, initiatorDomains,
// requestDomains — whether from the specially COALESCED pure-hostname-block
// rules described in parseList()'s "Coalesce pure hostname block rules"
// step, or from an ordinary rule's own condition) can itself mix domains
// from many countries in one array. A first version of this function only
// split the coalesced case and moved *whole* non-coalesced rules if *any*
// domain matched — that silently broke allow-exception rules with large
// mixed-country initiatorDomains lists (e.g. a 200-domain allowlist rule
// got moved to the Polish-only overflow because ONE of its 200 domains was
// .pl, dropping the other 199 domains' protection from AG Base whenever the
// overflow ruleset isn't enabled). Fixed: every inclusion field is now split
// per-rule, per-field, regardless of rule shape — one rule in, one "kept"
// copy plus up to one copy per target TLD out, each with only the domains
// that belong there.
//
// EXCLUSION fields (excludedDomains, excludedInitiatorDomains,
// excludedRequestDomains) are deliberately left untouched and copied as-is
// into every resulting copy of a rule (via the object spread below) — an
// exclusion is "this rule doesn't apply here" and is unrelated to which
// bucket the rule's *inclusion* domains route into; splitting or dropping
// an exclusion would change what the rule matches, not just where it ships.
//
// Scriptlet rules are intentionally NOT handled here (left in the source
// list untouched): AG Base's scriptlet entries share one function call
// across many hostnames, so extracting a single TLD means splitting
// hostname arrays *within* shared entries. Measured: the extractable
// byte savings for Polish scriptlets is under 2% of AG Base's scriptlet
// file size — not worth the added complexity for the current scope.
/******************************************************************************/

function tldOf(hostname) {
    return hostname.split('.').pop().toLowerCase();
}

// Fields that INCLUDE domains a rule applies to. Only these are split by
// TLD and used to route a rule's copies. Exclusion fields are never listed
// here — see the IMPORTANT note above.
const DNR_INCLUSION_DOMAIN_FIELDS = [ 'domains', 'initiatorDomains', 'requestDomains' ];

// overflowDefs: array of { tlds: string[], id: string }. Several TLDs may
// share one bucket id (e.g. German's overflow bucket owns de/at/ch) — see
// the countryOverflow config comment on the AdGuard Base FILTER_LISTS entry
// for why. Each TLD must appear in at most one bucket.
export function extractCountryOverflow(dnrRules, cosmeticMap, overflowDefs) {
    const tldToBucket = new Map();
    for ( const def of overflowDefs ) {
        for ( const tld of def.tlds ) { tldToBucket.set(tld, def.id); }
    }
    const bucketIds = overflowDefs.map(d => d.id);
    const extractedByBucket = new Map(bucketIds.map(id => [id, { dnrRules: [], cosmeticMap: new Map() }]));

    // ── DNR rules ────────────────────────────────────────────────────────
    const remainingDnrRulesUnnumbered = [];
    for ( const rule of dnrRules ) {
        const cond = rule.condition ?? {};
        const presentFields = DNR_INCLUSION_DOMAIN_FIELDS.filter(f => Array.isArray(cond[f]));

        if ( presentFields.length === 0 ) {
            // No inclusion-domain field at all — nothing to route on, stays
            // in the source list untouched (this also correctly leaves
            // exclusion-only rules, e.g. { excludedInitiatorDomains, urlFilter },
            // in place — see the IMPORTANT note above).
            remainingDnrRulesUnnumbered.push(rule);
            continue;
        }

        // Split every present inclusion field independently by bucket.
        const keptCond     = { ...cond };
        const perBucketCond      = new Map(bucketIds.map(id => [id, { ...cond }]));
        const perBucketHasDomains = new Map(bucketIds.map(id => [id, false]));
        let keptHasDomains = false;

        for ( const field of presentFields ) {
            const kept = [];
            const byBucket = new Map();  // bucketId -> domains[] for this field
            for ( const d of cond[field] ) {
                const bucketId = tldToBucket.get(tldOf(d));
                if ( bucketId !== undefined ) {
                    if ( !byBucket.has(bucketId) ) { byBucket.set(bucketId, []); }
                    byBucket.get(bucketId).push(d);
                } else {
                    kept.push(d);
                }
            }
            if ( kept.length > 0 ) {
                keptCond[field] = kept;
                keptHasDomains = true;
            } else {
                delete keptCond[field];
            }
            for ( const [bucketId, bucketCond] of perBucketCond ) {
                const domainsForBucket = byBucket.get(bucketId);
                if ( domainsForBucket && domainsForBucket.length > 0 ) {
                    bucketCond[field] = domainsForBucket;
                    perBucketHasDomains.set(bucketId, true);
                } else {
                    delete bucketCond[field];
                }
            }
        }

        if ( keptHasDomains ) {
            remainingDnrRulesUnnumbered.push({ ...rule, condition: keptCond });
        }
        for ( const [bucketId, bucketCond] of perBucketCond ) {
            if ( perBucketHasDomains.get(bucketId) ) {
                extractedByBucket.get(bucketId).dnrRules.push({ ...rule, condition: bucketCond });
            }
        }
    }

    // Renumber both remaining and each extracted set starting at 1 — DNR
    // rule ids only need to be unique *within* a single ruleset file.
    const remainingDnrRules = remainingDnrRulesUnnumbered.map((r, i) => ({ ...r, id: i + 1 }));
    for ( const [, bucket] of extractedByBucket ) {
        bucket.dnrRules = bucket.dnrRules.map((r, i) => ({ ...r, id: i + 1 }));
    }

    // ── Cosmetic map (Map<hostname, Set<selector>>) — no splitting needed;
    // each entry already belongs to exactly one hostname. ─────────────────
    const remainingCosmeticMap = new Map();
    for ( const [hostname, selectors] of cosmeticMap ) {
        const bucketId = tldToBucket.get(tldOf(hostname));
        if ( bucketId !== undefined ) {
            extractedByBucket.get(bucketId).cosmeticMap.set(hostname, selectors);
        } else {
            remainingCosmeticMap.set(hostname, selectors);
        }
    }

    return { remainingDnrRules, remainingCosmeticMap, extractedByBucket };
}
