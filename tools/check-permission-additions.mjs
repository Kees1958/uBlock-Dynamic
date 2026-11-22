// tools/check-permission-additions.mjs — principle C36 (HARD check).
//
// When an update adds a permission (or host permission) that produces a new
// install warning, Chrome DISABLES the extension for every existing user
// until each one re-approves it; users who never notice simply lose it.
// Nothing else in the build can see this, because the build is correct.
//
// Compares manifest.json against the permissions of the LAST PUBLISHED
// release — recorded by tools/package-release.mjs in
// tools/package-release-state.json (extension.shippedPermissions) at every
// release — not against the previous session's tree.
//
// An addition fails the check unless it is listed, with a reason, in
// tools/permission-approvals.json:
//   { "approved": [ { "key": "permissions", "value": "tabs",
//                     "reason": "…why it is needed…",
//                     "impact": "Existing users must re-approve …" } ] }
// Approving is the release decision to accept that impact (it is also a
// WARNING FOR IMPLEMENTATION IMPACT line per the Ground Rules). Once the
// release ships, the addition is part of the recorded baseline and the
// approval entry is reported as no longer needed.
//
// Outcomes (principle C38): PASS / FINDINGS (fails) / DID NOT RUN (fails —
// e.g. no recorded baseline, unreadable files).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE_PATH = path.join(ROOT, 'tools', 'package-release-state.json');
const APPROVALS_PATH = path.join(ROOT, 'tools', 'permission-approvals.json');
// Same key list package-release.mjs records.
const PERMISSION_KEYS = [ 'permissions', 'host_permissions', 'optional_permissions', 'optional_host_permissions' ];
// Only these can trigger the re-approval prompt; optional ones are asked
// for at runtime and never disable the extension on update.
const PROMPTING_KEYS = new Set([ 'permissions', 'host_permissions' ]);

console.log('=== C36: permissions added since the last published release ===');

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}
function readJson(file, what) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return didNotRun(`cannot read ${what} (${err.message})`); }
}

const state = readJson(STATE_PATH, 'tools/package-release-state.json');
const shipped = state?.extension?.shippedPermissions;
if ( shipped === undefined || PERMISSION_KEYS.some(k => Array.isArray(shipped[k]) === false) ) {
    didNotRun('no recorded baseline (extension.shippedPermissions) in tools/package-release-state.json — package-release.mjs writes it at every release');
}
const manifest = readJson(path.join(ROOT, 'manifest.json'), 'manifest.json');
const approvals = readJson(APPROVALS_PATH, 'tools/permission-approvals.json');
if ( Array.isArray(approvals?.approved) === false ) { didNotRun('tools/permission-approvals.json has no "approved" array'); }

function isApproved(key, value) {
    return approvals.approved.some(a => a.key === key && a.value === value
        && typeof a.reason === 'string' && a.reason.trim() !== '');
}

let unapproved = 0;
for ( const key of PERMISSION_KEYS ) {
    const before = new Set(shipped[key]);
    const now = new Set(manifest[key] ?? []);
    for ( const value of now ) {
        if ( before.has(value) ) { continue; }
        if ( PROMPTING_KEYS.has(key) === false ) {
            console.log(`NOTE: ${key} adds "${value}" — optional, requested at runtime; does not disable the extension on update.`);
        } else if ( isApproved(key, value) ) {
            console.log(`APPROVED: ${key} adds "${value}" (see tools/permission-approvals.json).`);
        } else {
            unapproved += 1;
            console.log(`FAIL: ${key} adds "${value}" since v${state.extension.version} — existing users will have the extension DISABLED until they re-approve it.`);
        }
    }
    for ( const value of before ) {
        if ( now.has(value) === false ) { console.log(`NOTE: ${key} removes "${value}" — always safe to ship.`); }
    }
}
for ( const a of approvals.approved ) {
    if ( (shipped[a.key] ?? []).includes(a.value) ) {
        console.log(`NOTE: approval for ${a.key} "${a.value}" is no longer needed — it already shipped; remove it from tools/permission-approvals.json.`);
    }
}
console.log(`Compared ${PERMISSION_KEYS.length} permission keys against the v${state.extension.version} release.`);
if ( unapproved !== 0 ) {
    console.log(`\n${unapproved} unapproved addition(s). If intended: prefer optional_permissions + permissions.request(); otherwise add an entry with a reason to tools/permission-approvals.json.`);
    process.exit(1);
}
console.log('PASS: no unapproved permission additions.');
