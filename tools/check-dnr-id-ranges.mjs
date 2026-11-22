// New check (this session): DNR rule-ID range collision detection.
// dnr-budgets.js documents non-overlapping 1,000,000-wide ranges for each
// DNR-rule-producing feature — this verifies that holds, AND cross-checks
// the actual offset usage in ruleset-manager.js/builtin-whitelist-rules.js
// against each range's own documented slot count, since a comment and the
// code it describes can drift apart silently (same failure mode B4/C10
// warn about generally — this is that check applied specifically to the
// one place a drift here would be genuinely dangerous: two features
// writing to the same DNR rule ID).
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');
const budgetsSrc = fs.readFileSync(path.join(ROOT, 'js/core/dnr-budgets.js'), 'utf8');

function constNum(name) {
    const m = budgetsSrc.match(new RegExp(`export const ${name}\\s*=\\s*([\\d_]+)`));
    return m ? Number(m[1].replace(/_/g, '')) : undefined;
}

// Ranges with an explicit exported MAX/count — checked for pairwise
// overlap directly against each other.
const ranges = [
    { name: 'MONITOR_RULES_RETIRED', base: constNum('MONITOR_RULES_RETIRED_BASE_ID'), size: constNum('MONITOR_RULES_RETIRED_MAX_DNR') },
    { name: 'USER_RULES',            base: constNum('USER_RULES_BASE_ID'),            size: constNum('USER_RULES_MAX') },
    { name: 'MATRIX_RULES',          base: constNum('MATRIX_RULES_BASE_ID'),          size: constNum('MATRIX_RULES_MAX_DNR') },
    { name: 'BUILTIN_WHITELIST_RULES', base: constNum('BUILTIN_WHITELIST_RULES_BASE_ID'), size: 2 }, // documented as exactly 2 rules, no exported count constant
    // (10.7.16) CMP loader blocks — session rules, one id per js/data/cmp-loader-blocks.js entry.
    { name: 'CMP_LOADER_BLOCK_RULES', base: constNum('CMP_LOADER_BLOCK_RULES_BASE_ID'), size: constNum('CMP_LOADER_BLOCK_RULES_MAX') },
    // v9.7.1 correction: this used to be a hardcoded `size: 10`, captioned
    // "Reserved (v8.3.6), not yet built" — false by the time this range had
    // 20+ real ids in it (SCP items, retired-but-reserved advanced-tier ids,
    // the domain-scoped items, and now WORRY_FREE_DOWNLOAD_HEADER_BLOCK_
    // RULE_ID at 13_000_021). A hand-typed size on a range that keeps
    // gaining new named ids is exactly the "comment drifts from the code it
    // describes" failure this file's own header warns about — this one was
    // a plain guess with no derivation at all. Fixed the same way
    // SECURITY_RULES already was, and TRUSTED_DIRECTIVE now is too: derived
    // from real usage, not trusted from a comment — see the computation
    // just below, which this entry is pushed from (not declared inline in
    // this array) for the same reason SECURITY_RULES isn't either.
    // High-risk-site Permissions-Policy header rules (v9.6.4) — 2 slots
    // used, HIGH_RISK_HEADERS_RULES_SLOTS reserved.
    { name: 'HIGH_RISK_HEADERS_RULES', base: constNum('HIGH_RISK_HEADERS_RULES_BASE_ID'), size: constNum('HIGH_RISK_HEADERS_RULES_SLOTS') },
    // Sandbox-safe-scripts row session rules (AdShield Evolution rename pass —
    // renamed from the old 3-row "Advanced-tier session rules (v9.7.0)" entry,
    // now just 1 row rule + 1 $saferegions allow + the TLD exemption band, one
    // contiguous [BASE, END) range; see CHANGELOG_HISTORY.md for the full entry).
    { name: 'SANDBOX_SAFE_SCRIPTS_RULES', base: constNum('SANDBOX_SAFE_SCRIPTS_RULES_BASE_ID'), size: constNum('SANDBOX_SAFE_SCRIPTS_RULES_END_ID') - constNum('SANDBOX_SAFE_SCRIPTS_RULES_BASE_ID') },
    // Editable familiar-TLD list (new feature) — two 1 000-wide dynamic-rule
    // purposes (SCP privacy, SCP security), combined into one [BASE, END)
    // range for overlap checking, same as the range above.
    { name: 'WORRY_FREE_FAMILIAR_TLD', base: constNum('WORRY_FREE_FAMILIAR_SCP_PRIVACY_TLD_ALLOW_RULES_BASE_ID'), size: constNum('WORRY_FREE_FAMILIAR_TLD_RULES_END_ID') - constNum('WORRY_FREE_FAMILIAR_SCP_PRIVACY_TLD_ALLOW_RULES_BASE_ID') },
    // SECURITY_RULES, WORRY_FREE_EXTRA_RULES, STRICT_3P_RULES, SAFEREGIONS_
    // DYNAMIC_RULES, and TRUSTED_DIRECTIVE have no exported *_MAX constant —
    // each sized below from actual code usage instead of a hand-typed number.
];

console.log('=== DNR rule-ID range collision check ===');

let ok = true;

// ── Cross-check SECURITY_RULES' actual usage against its documented size ──
const rsSrc = fs.readFileSync(path.join(ROOT, 'js/core/ruleset-manager.js'), 'utf8');
const securityOffsets = [ ...rsSrc.matchAll(/SECURITY_RULES_BASE_ID\s*\+\s*(\d+)/g) ].map(m => Number(m[1]));
const securityBase = constNum('SECURITY_RULES_BASE_ID');
// (10.2.0) The Suspicious-hosting exception mirrors are a block of ids declared in dnr-budgets.js
// (BASE_ID + MAX), not literal "+N" offsets in ruleset-manager.js — read from the real module so the
// block's LAST id counts, not just its first.
const budgetsModule = await import(pathToFileURL(path.join(ROOT, 'js/core/dnr-budgets.js')).href);
securityOffsets.push(budgetsModule.SUSPICIOUS_HOSTING_EXCEPTION_BASE_ID + budgetsModule.SUSPICIOUS_HOSTING_EXCEPTION_MAX - 1 - securityBase);
const securityMaxOffsetUsed = securityOffsets.length > 0 ? Math.max(...securityOffsets) : -1;
const documentedSecuritySlots = 21; // from dnr-budgets.js's own header comment — kept in sync manually, this line is what needs updating if that comment changes
console.log(`SECURITY_RULES: base ${securityBase}, actual max offset used +${securityMaxOffsetUsed} (${securityMaxOffsetUsed + 1} slots), header comment claims ${documentedSecuritySlots} slots.`);
if ( securityMaxOffsetUsed + 1 > documentedSecuritySlots ) {
    ok = false;
    console.log(`FAIL: SECURITY_RULES actually uses more slots (${securityMaxOffsetUsed + 1}) than dnr-budgets.js's header documents (${documentedSecuritySlots}) — could be about to collide with the next range.`);
} else if ( securityMaxOffsetUsed + 1 < documentedSecuritySlots ) {
    console.log(`NOTE: header comment says ${documentedSecuritySlots} slots but only ${securityMaxOffsetUsed + 1} are actually used — not a collision risk (usage is UNDER budget), but the comment has drifted from the code and is worth tightening.`);
}
ranges.push({ name: 'SECURITY_RULES', base: securityBase, size: documentedSecuritySlots });

// ── Generic derivation for any BASE_ID-anchored range whose per-id
//    offsets are themselves named, literal constants in dnr-budgets.js
//    (v9.7.1 convention — see B1/C21 in the project's own audit notes: a
//    DNR rule id is data this file should hold directly, not something a
//    consumer computes and a check script has to reverse-engineer from a
//    usage pattern). Scans this file's own exports for every constant
//    whose LITERAL VALUE falls inside the range's 1,000,000-wide window
//    (this file's header documents that convention for every range) and
//    takes the real maximum. Works uniformly for WORRY_FREE_EXTRA_RULES,
//    STRICT_3P_RULES, and SAFEREGIONS_DYNAMIC_RULES — before v9.7.1's
//    refactor each of the latter two needed its own bespoke, fragile scan
//    of a DIFFERENT file's usage pattern (an offset expression, a data
//    array); now they don't, because the numbers live here.
function deriveRangeFromNamedConstants(baseName) {
    const base = constNum(baseName);
    const neighborhoodIds = [ ...budgetsSrc.matchAll(/export const (\w+)\s*=\s*([\d_]+);/g) ]
        .map(([ , name, digits ]) => ({ name, value: Number(digits.replace(/_/g, '')) }))
        .filter(({ value }) => value >= base && value < base + 1_000_000);
    const maxValue = neighborhoodIds.length > 0 ? Math.max(...neighborhoodIds.map(c => c.value)) : base;
    return { base, count: neighborhoodIds.length, maxValue, size: maxValue - base + 1 };
}

for ( const baseName of [ 'WORRY_FREE_EXTRA_RULES_BASE_ID', 'STRICT_3P_RULES_BASE_ID', 'SAFEREGIONS_DYNAMIC_RULES_BASE_ID', 'WORRYFREE_DYNAMIC_RULES_BASE_ID' ] ) {
    const name = baseName.replace(/_BASE_ID$/, '');
    const { base, count, maxValue, size } = deriveRangeFromNamedConstants(baseName);
    console.log(`${name}: base ${base}, ${count} named ids found, real max value ${maxValue} (${size} slots) — computed from source, no hand-typed size to drift.`);
    ranges.push({ name, base, size });
}

// ── TRUSTED_DIRECTIVE — different shape from the three above: its per-id
//    offsets genuinely belong in data/ext-compat.js, not dnr-budgets.js
//    (dnr.setAllowAllRules() is a reusable, base-agnostic utility — its
//    id-offset contract is a property of THAT function, not of
//    TRUSTED_DIRECTIVE specifically; duplicating the same two numbers
//    into dnr-budgets.js as a second representation would itself be a
//    B15-style drift risk between two files instead of one). v9.7.1: both
//    offsets are now named, literal exports there
//    (SET_ALLOW_ALL_RULES_DYNAMIC_RULE_OFFSET /
//    SET_ALLOW_ALL_RULES_SESSION_RULE_OFFSET) — read directly by name
//    instead of regex-matching this function's body for `id + <digit>`
//    usage, which is exactly the kind of pattern a future refactor of
//    that function could silently break without any test catching it.
const extCompatSrc = fs.readFileSync(path.join(ROOT, 'js/data/ext-compat.js'), 'utf8');
function extCompatConstNum(name) {
    const m = extCompatSrc.match(new RegExp(`export const ${name}\\s*=\\s*([\\d_]+)`));
    return m ? Number(m[1].replace(/_/g, '')) : undefined;
}
const trustedBase = constNum('TRUSTED_DIRECTIVE_BASE_ID');
const trustedOffsets = [
    extCompatConstNum('SET_ALLOW_ALL_RULES_DYNAMIC_RULE_OFFSET'),
    extCompatConstNum('SET_ALLOW_ALL_RULES_SESSION_RULE_OFFSET'),
].filter(n => n !== undefined);
if ( trustedOffsets.length < 2 ) {
    ok = false;
    console.log('FAIL: could not find SET_ALLOW_ALL_RULES_DYNAMIC_RULE_OFFSET/SESSION_RULE_OFFSET in data/ext-compat.js — dnr.setAllowAllRules() may have been refactored; this check needs updating, not silently trusted.');
}
const trustedMaxOffsetUsed = trustedOffsets.length > 0 ? Math.max(...trustedOffsets) : 0;
const trustedRealSize = trustedMaxOffsetUsed + 1;
console.log(`TRUSTED_DIRECTIVE: base ${trustedBase}, offsets [${trustedOffsets.join(', ')}] found in data/ext-compat.js (${trustedRealSize} slots) — computed from named declarations, not a usage-pattern scan.`);
ranges.push({ name: 'TRUSTED_DIRECTIVE', base: trustedBase, size: trustedRealSize });

// ── Pairwise overlap check across all ranges ───────────────────────────
for ( let i = 0; i < ranges.length; i++ ) {
    for ( let j = i + 1; j < ranges.length; j++ ) {
        const a = ranges[i], b = ranges[j];
        if ( a.base === undefined || b.base === undefined ) { continue; }
        const aEnd = a.base + a.size - 1;
        const bEnd = b.base + b.size - 1;
        const overlap = a.base <= bEnd && b.base <= aEnd;
        if ( overlap ) {
            ok = false;
            console.log(`FAIL: ${a.name} [${a.base}-${aEnd}] overlaps ${b.name} [${b.base}-${bEnd}]`);
        }
    }
}

// ── Priority-window invariants (added 9.6.4 after the 9.6.0 suppression-rule
// cross-contamination bug) ────────────────────────────────────────────────
// Worry-free/SCP items each own a 10-wide priority window (100–199): the
// item's block/allow near the bottom, its own SUPPRESS priority at the
// top. That is the ONLY thing stopping one item's suppression rule from
// outranking a sibling's rules (see dnr-budgets.js "RE-SPACED" comment).
// Nothing used to check it mechanically — a new constant dropped into an
// existing window, or two constants sharing a value, would pass every
// other check. Invariants enforced here:
//   1. every *_PRIORITY constant in the band has a unique value;
//   2. each 10-wide window holds at most one *_SUPPRESS_PRIORITY, and it
//      is the highest value in that window;
//   3. HIGH_RISK_HEADERS_PRIORITY (no suppression rule by design) lies
//      OUTSIDE the band and below TRUSTED_DIRECTIVE_PRIORITY.
const BAND_LO = 100, BAND_HI = 199;
const bandConsts = [ ...budgetsSrc.matchAll(/export const (\w+_PRIORITY)\s*=\s*([\d_]+)\s*;/g) ]
    .map(m => ({ name: m[1], value: Number(m[2].replace(/_/g, '')) }))
    .filter(c => c.value >= BAND_LO && c.value <= BAND_HI);
const seenValues = new Map();
for ( const c of bandConsts ) {
    if ( seenValues.has(c.value) ) {
        ok = false;
        console.log(`FAIL: priority ${c.value} is declared twice in the Worry-free band: ${seenValues.get(c.value)} and ${c.name}`);
    }
    seenValues.set(c.value, c.name);
}
const windows = new Map();
for ( const c of bandConsts ) {
    const w = Math.floor(c.value / 10);
    if ( windows.has(w) === false ) { windows.set(w, []); }
    windows.get(w).push(c);
}
for ( const [ w, consts ] of windows ) {
    const suppress = consts.filter(c => c.name.endsWith('_SUPPRESS_PRIORITY'));
    const maxValue = Math.max(...consts.map(c => c.value));
    if ( suppress.length > 1 ) {
        ok = false;
        console.log(`FAIL: priority window ${w * 10}-${w * 10 + 9} holds ${suppress.length} SUPPRESS priorities (${suppress.map(c => c.name).join(', ')}) — one window per item.`);
    }
    if ( suppress.length === 1 && suppress[0].value !== maxValue ) {
        ok = false;
        console.log(`FAIL: ${suppress[0].name} (${suppress[0].value}) is not the highest priority in its window ${w * 10}-${w * 10 + 9} — it could outrank a sibling's rules.`);
    }
}
console.log(`Priority windows: ${windows.size} windows, ${bandConsts.length} constants in ${BAND_LO}-${BAND_HI}.`);
const highRiskHeadersPriority = constNum('HIGH_RISK_HEADERS_PRIORITY');
const trustedPriority = constNum('TRUSTED_DIRECTIVE_PRIORITY');
if ( highRiskHeadersPriority === undefined ) {
    ok = false;
    console.log('FAIL: HIGH_RISK_HEADERS_PRIORITY not found in dnr-budgets.js.');
} else if ( highRiskHeadersPriority >= BAND_LO && highRiskHeadersPriority <= BAND_HI ) {
    ok = false;
    console.log(`FAIL: HIGH_RISK_HEADERS_PRIORITY (${highRiskHeadersPriority}) sits inside the Worry-free band ${BAND_LO}-${BAND_HI}.`);
} else if ( trustedPriority !== undefined && highRiskHeadersPriority >= trustedPriority ) {
    ok = false;
    console.log(`FAIL: HIGH_RISK_HEADERS_PRIORITY (${highRiskHeadersPriority}) is not below TRUSTED_DIRECTIVE_PRIORITY (${trustedPriority}) — a person's own Allow list entry could no longer win.`);
}

// ── Sandbox-safe-scripts row priority RELATIONS and id containment ──────────
// (AdShield Evolution rename pass) Replaces the old "Advanced-tier (v9.7.0)
// priority RELATIONS and id containment" section — that tier's own 3P-block,
// forced-download-block and header/allow relations across THREE rows no
// longer apply now that only ONE row (sandbox-safe-scripts) remains, moved
// to the safeRegions tier; see CHANGELOG_HISTORY.md for the full entry. What
// still matters: header < allow (an allow only cancels LOWER priorities, so
// the exemption band must outrank the row it exempts) — same relation every
// other item in the 100-199 Worry-free band already has, checked generically
// above for THIS row too, since its two priorities (170/180) fall inside
// that band. This section adds only what the generic band check does not
// cover: the explicit header-vs-allow ordering, and id containment within
// this row's own reserved range.
const sbox = {
    header: constNum('SANDBOX_SAFE_SCRIPTS_HEADER_PRIORITY'),
    allow:  constNum('SANDBOX_SAFE_SCRIPTS_ALLOW_PRIORITY'),
};
if ( Object.values(sbox).some(v => v === undefined) ) {
    ok = false;
    console.log('FAIL: a sandbox-safe-scripts priority constant is missing from dnr-budgets.js:', JSON.stringify(sbox));
} else if ( sbox.header >= sbox.allow ) {
    ok = false;
    console.log('FAIL: SANDBOX_SAFE_SCRIPTS_HEADER_PRIORITY must be below SANDBOX_SAFE_SCRIPTS_ALLOW_PRIORITY (the exemption band must outrank the row it exempts).');
}
const advBase = constNum('SANDBOX_SAFE_SCRIPTS_RULES_BASE_ID');
const advEnd = constNum('SANDBOX_SAFE_SCRIPTS_RULES_END_ID');
const advIds = [
    'SANDBOX_SAFE_SCRIPTS_RULE_ID', 'SANDBOX_SAFE_SCRIPTS_ALLOW_RULE_ID',
    'SANDBOX_SAFE_SCRIPTS_TLD_ALLOW_RULES_BASE_ID',
].map(name => [ name, constNum(name) ]);
for ( const [ name, value ] of advIds ) {
    if ( value === undefined || value < advBase || value >= advEnd ) {
        ok = false;
        console.log(`FAIL: ${name} (${value}) is not inside [SANDBOX_SAFE_SCRIPTS_RULES_BASE_ID ${advBase}, END ${advEnd}).`);
    }
}
if ( new Set(advIds.map(([ , v ]) => v)).size !== advIds.length ) {
    ok = false;
    console.log('FAIL: two advanced-tier rule ids are equal.');
}
console.log('Sandbox-safe-scripts row priority relations and id containment checked.');

// ── Every *_BASE_ID / *_RULE_ID value is unique (audit after 9.7.5) ─────
// dnr-budgets.js keeps retired and reserved single ids as named constants
// (e.g. ADVANCED_TIER_RETIRED_BASE_ID, WORRY_FREE_SOCIAL_RULES_BASE_ID) so
// they are never handed to a new feature. Its own "ID CHECK" comment
// records a real collision caused by picking a new id without listing every
// existing constant. Until now that protection was manual; this makes it
// mechanical: any two id constants with the same value fail the check.
{
    // A RANGE START legitimately shares its value with the first single id
    // inside that range (overlap/containment is checked above). Range
    // starts are taken from `ranges` itself — this file's one list of
    // ranges — not guessed from name suffixes. Uniqueness is required
    // among the remaining SINGLE ids.
    const rangeStartNames = new Set(ranges.map(r => `${r.name}_BASE_ID`));
    function isRangeStart(name) { return rangeStartNames.has(name); }
    const idConsts = [ ...budgetsSrc.matchAll(/export const (\w+_(?:BASE_ID|RULE_ID))\s*=\s*([\d_]+)/g) ]
        .map(m => [ m[1], Number(m[2].replace(/_/g, '')) ])
        .filter(([ name ]) => isRangeStart(name) === false);
    const byValue = new Map();
    for ( const [ name, value ] of idConsts ) {
        if ( byValue.has(value) === false ) { byValue.set(value, []); }
        byValue.get(value).push(name);
    }
    for ( const [ value, names ] of byValue ) {
        if ( names.length > 1 ) {
            ok = false;
            console.log(`FAIL: DNR id ${value} is claimed by more than one constant: ${names.join(', ')}.`);
        }
    }
    console.log(`Id uniqueness: ${idConsts.length} single-id *_BASE_ID / *_RULE_ID constants, every value distinct${ok ? '' : ' — NO, see above'}.`);
}

if ( ok ) { console.log('PASS: no overlapping DNR rule-ID ranges found.'); }
console.log('');
process.exitCode = ok ? 0 : 1;
