// check-unsafe-split.mjs — every shipped MAIN filter ruleset holds safe rules only (10.2.0).
//
// Chrome Web Store skip-review ("SAFE" update) accepts a changed ruleset only when every added/changed/removed
// rule is a safe rule (tools/build/safe-update-rules.mjs). The owner's rule: unsafe rules (redirect, which
// $removeparam/$redirect compile to, and modifyHeaders) live ONLY in the companions declared in
// js/data/ruleset-companions.js UNSAFE_RULE_COMPANIONS, so a refresh of any main list stays SAFE. Checks the
// SHIPPED files and manifest, not the build code:
//   1. every declared companion exists in manifest.json (an empty [] file is fine — it is the home for later);
//   2. no ruleset outside the companions holds an unsafe rule, except the project-own header rulesets
//      (UNSAFE_BY_DESIGN_RULESET_IDS below — their rules ARE modifyHeaders and are never filter-list content);
//   3. a companion is never enabled while its parent ships disabled (manifest defaults stay in step).
// Pure read of the tree — nothing to initialise, clear or release.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { isSafeRule } from './build/safe-update-rules.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── Configuration (the only place these live) ───────────────────────────────
// Project-own header rulesets (tools/build/filter-lists.mjs `unsafeByDesign`). A new id here needs a reason.
const UNSAFE_BY_DESIGN_RULESET_IDS = Object.freeze([ 'ruleset_scp_privacy_block', 'ruleset_scp_security_block' ]);

let ok = true;
function check(label, pass, detail = '') {
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
    if ( !pass ) { ok = false; }
}

console.log('=== Safe/unsafe split of the shipped rulesets ===');
const { ALL_UNSAFE_COMPANION_PAIRS } = await import(pathToFileURL(path.join(ROOT, 'js/data/ruleset-companions.js')).href);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const resources = manifest.declarative_net_request?.rule_resources ?? [];
const byId = new Map(resources.map(r => [ r.id, r ]));
const companions = new Set(ALL_UNSAFE_COMPANION_PAIRS.map(([ , companion ]) => companion));   // (10.7.6) both companion maps

const missing = [ ...companions ].filter(id => !byId.has(id));
check('every declared unsafe-rule companion is a manifest ruleset', missing.length === 0, missing.join(', '));

const offenders = [];
let unsafeInCompanions = 0;
for ( const res of resources ) {
    const rules = JSON.parse(fs.readFileSync(path.join(ROOT, res.path.replace(/^\//, '')), 'utf8'));
    const unsafe = rules.filter(r => !isSafeRule(r));
    if ( companions.has(res.id) ) { unsafeInCompanions += unsafe.length; continue; }
    if ( UNSAFE_BY_DESIGN_RULESET_IDS.includes(res.id) ) { continue; }
    if ( unsafe.length > 0 ) { offenders.push(`${res.id} (${unsafe.length}: ${[ ...new Set(unsafe.map(r => r.action?.type)) ].join('/')})`); }
}
check('no main filter ruleset holds an unsafe rule', offenders.length === 0, offenders.join('; '));

const outOfStep = ALL_UNSAFE_COMPANION_PAIRS
    .filter(([ parent, companion ]) => byId.has(parent) && byId.has(companion) && byId.get(companion).enabled && !byId.get(parent).enabled)
    .map(([ parent, companion ]) => `${companion} on, ${parent} off`);
check('no companion is enabled by default while its parent is not', outOfStep.length === 0, outOfStep.join(', '));

console.log(`${resources.length} rulesets, ${companions.size} declared companions holding ${unsafeInCompanions} unsafe rule(s).`);
console.log(ok ? 'PASS: every main filter ruleset is safe-only.' : 'FAIL: see above.');
console.log('');
process.exitCode = ok ? 0 : 1;
