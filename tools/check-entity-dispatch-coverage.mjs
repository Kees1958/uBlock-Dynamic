#!/usr/bin/env node
// check-entity-dispatch-coverage.mjs — guards against the recurring bug
// class documented in ARCHITECTURE.md's "HARD CONSTRAINT — every compiled
// hostname dispatch table must account for entity-style (name.*) keys":
// a compiled cosmetic or scriptlet ruleset file contains an ABP entity
// domain-scope key (e.g. "kat.*") but the runtime dispatch mechanism that's
// supposed to read it has no code path that can ever reach it — a rule
// that compiles, ships, and takes up space, but matches nothing, ever.
//
// Found independently in two structurally different mechanisms before this
// check existed:
//   - Cosmetic: hasEntities was hardcoded false, so css-specific.js's own
//     (already-correct) entity-matching branch never ran.
//   - Scriptlet: the generated dispatch loop never derived or tried an
//     entity form of a hostname at all.
//
// This is a static, heuristic check, not a live-DOM/live-match test — it
// verifies the DECLARED coverage signal (hasEntities for cosmetic, the
// presence of the entity-aware dispatch branch for scriptlet), not that
// matching actually succeeds end-to-end. tools/check-cosmetic-specific-
// format-equivalence.mjs (step 16) and this session's own manual
// before/after simulation are what confirmed actual runtime correctness;
// this check exists so that confirmation doesn't have to be repeated by
// hand every time these files are regenerated.
//
// Usage: node tools/check-entity-dispatch-coverage.mjs   (also runs as a
// step of `npm run check` / tools/complete-check.mjs)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodeDispatchSource } from './build/scriptlet-dispatch-layout.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const isMainModule = process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
const RULESETS_DIR = path.join(ROOT, 'rulesets');

// The exact substring the scriptlet dispatch fix emits when (and only
// when) it generated the entity-aware branch — see build-rulesets.mjs's
// buildScriptletFile(). A file with an entity key but without this
// substring means the entity-aware branch was not generated for it.
const SCRIPTLET_ENTITY_MARKER = '.slice(0,j)+".*"';

function checkCosmeticFiles() {
    const violations = [];
    let scanned = 0;
    if ( fs.existsSync(RULESETS_DIR) === false ) { return { violations, scanned }; }
    for ( const name of fs.readdirSync(RULESETS_DIR) ) {
        if ( name.endsWith('-cosmetic-specific.json') === false ) { continue; }
        scanned++;
        let data;
        try {
            data = JSON.parse(fs.readFileSync(path.join(RULESETS_DIR, name), 'utf8'));
        } catch {
            continue; // not this check's job to validate JSON syntax
        }
        const hostnames = Array.isArray(data.hostnames) ? data.hostnames : [];
        const hasEntityKey = hostnames.some(h => typeof h === 'string' && h.endsWith('.*'));
        if ( hasEntityKey && data.hasEntities !== true ) {
            const count = hostnames.filter(h => typeof h === 'string' && h.endsWith('.*')).length;
            violations.push(
                `${name}: contains ${count} entity-style hostname key(s) ` +
                `(e.g. "${hostnames.find(h => h.endsWith('.*'))}") but hasEntities is ` +
                `${JSON.stringify(data.hasEntities)}, not true — these entries can never match.`
            );
        }
    }
    return { violations, scanned };
}

function checkScriptletFiles() {
    const violations = [];
    let scanned = 0;
    if ( fs.existsSync(RULESETS_DIR) === false ) { return { violations, scanned }; }
    for ( const name of fs.readdirSync(RULESETS_DIR) ) {
        if ( name.endsWith('-scriptlets.js') === false ) { continue; }
        scanned++;
        const code = fs.readFileSync(path.join(RULESETS_DIR, name), 'utf8');
        // Dispatch-table keys come from the real decoder of the generated
        // layout (10.1.7: sorted hostname array H), not a text heuristic.
        let keys;
        try {
            keys = [ ...decodeDispatchSource(code).entries.keys() ];
        } catch (e) {
            violations.push(`${name}: not decodable as the scriptlet dispatch layout — ${e.message}`);
            continue;
        }
        const hasEntityKey = keys.some(k => k.endsWith('.*'));
        if ( hasEntityKey && code.includes(SCRIPTLET_ENTITY_MARKER) === false ) {
            const count = keys.filter(k => k.endsWith('.*')).length;
            violations.push(
                `${name}: contains ${count} entity-style dispatch key(s) ` +
                `(e.g. "${keys.find(k => k.endsWith('.*'))}") but the generated dispatch ` +
                `loop has no entity-aware branch — these entries can never match.`
            );
        }
    }
    return { violations, scanned };
}

function run() {
    const cosmetic = checkCosmeticFiles();
    const scriptlet = checkScriptletFiles();
    const allViolations = [ ...cosmetic.violations, ...scriptlet.violations ];

    for ( const v of allViolations ) { console.error(`VIOLATION: ${v}`); }

    if ( allViolations.length > 0 ) {
        console.error(
            `\n${allViolations.length} violation(s) of the entity-dispatch-coverage ` +
            `HARD CONSTRAINT (see ARCHITECTURE.md).`
        );
        return false;
    }

    console.log(
        `OK: every entity-style key in ${cosmetic.scanned} cosmetic-specific file(s) and ` +
        `${scriptlet.scanned} scriptlet file(s) is covered by its dispatch mechanism.`
    );
    return true;
}

if ( isMainModule ) {
    const ok = run();
    process.exit(ok ? 0 : 1);
}

export { checkCosmeticFiles, checkScriptletFiles, run };
