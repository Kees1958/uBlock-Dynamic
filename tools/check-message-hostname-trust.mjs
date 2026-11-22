// New check (C28, Xplainer_Programming_principles_conscript.md) — the
// message-derived hostname/domain trust-boundary pattern
// (sender.url || sender.tab?.url instead of trusting request.hostname
// directly) has now been independently implemented three times in this
// codebase (privacy-inspector.js, cookie-clicker-routes.js,
// filter-routes.js) — per C25, that's the threshold for a standing
// constraint AND an automated check, not another one-off fix next time.
//
// Scope: request.hostname / request.site specifically — identity-like
// claims about "what page is this request coming from". Deliberately
// NOT request.domain in general: matrix-routes.js's handleMatrixSetOverride()
// is a real, confirmed-correct counter-example — request.domain there is
// "which third-party domain the user chose to override", ordinary
// UI-selected data with no identity claim, while the actual identity
// value ("site") is already correctly server-derived via
// getCurrentSessionSite(). Flagging request.domain broadly would produce
// exactly that kind of false positive.
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

console.log('=== Message-derived hostname/site trust boundary check (C28) ===');

// ── Documented allowlist — classified, not silently skipped ────────────
// Each entry names the handler, the file, and WHY it's exempt. A new,
// unclassified hit fails by default (C25's own prescribed shape).
const ALLOWLIST = {
    // EXTENSION_PAGE-only (message-routes.js), and the sending UI code
    // (popup.js) derives hostname via browser.tabs.query() — Chrome's own
    // tabs API, reflecting the real, browser-recorded tab URL. A page
    // cannot influence what chrome.tabs.query() reports for its own tab
    // (unlike document.baseURI, which it can rewrite) — genuinely
    // different, already-trustworthy source, not the same gap.
    'handleSiteModeGet':  'EXTENSION_PAGE sender; hostname sourced via browser.tabs.query() in popup.js, not page-influenceable state.',
    'handleSiteModeSet':  'EXTENSION_PAGE sender; hostname sourced via browser.tabs.query() in popup.js, not page-influenceable state.',
    'handleGetFilteringMode': 'EXTENSION_PAGE sender; hostname sourced via browser.tabs.query() in popup.js, not page-influenceable state.',
    'handleSetFilteringMode': 'EXTENSION_PAGE sender; hostname sourced via browser.tabs.query() in popup.js, not page-influenceable state.',
    // EXTENSION_PAGE-only, and the value is a session host the
    // BACKGROUND ITSELF issued to the panel earlier (privacy-
    // inspector.js's currentHost = snapshot.session.host) — the panel is
    // echoing back server-issued data, not inventing new identity data.
    // Lower priority than the 3 real fixes: could be hardened to
    // re-derive server-side (matching matrix-routes.js's
    // getCurrentSessionSite() pattern) instead of trusting the echo, but
    // the EXTENSION_PAGE trust boundary already gates who can send this
    // at all — not a live gap, a possible future hardening.
    'handleApplyPrivacyExtras': 'EXTENSION_PAGE sender; hostname echoes a value the background itself issued to the panel (session.host) — not client-invented. Could be hardened to re-derive server-side (see handleMatrixSetOverride\'s getCurrentSessionSite() pattern) but is not a live gap today.',
    // CONTENT_SCRIPT sender (genuinely untrusted origin) — the one real
    // exception where the sender itself is NOT extension-trusted, kept
    // in the allowlist deliberately rather than fixed, because the
    // actual operation is READ-ONLY and low-impact: it returns which of
    // the user's OWN configured scriptlet rules match a given hostname,
    // for display in Privacy Inspector. Worst case if a page spoofs its
    // own hostname (<base href>): it learns whether the user has a
    // scriptlet rule configured for a hostname of the page's choosing —
    // minor disclosure of the user's own rule configuration, not
    // browsing history, not a write, not a spoofing/redirect vector like
    // the 3 real fixes were. Already has a sender.id check
    // (sender?.id !== runtime.id) as its own defense-in-depth.
    'handleGetMatchingScriptletRules': 'CONTENT_SCRIPT sender (genuinely untrusted) but read-only/display-only — worst case is minor disclosure of the user\'s own rule configuration, not a write or spoofing vector. Deliberately not hardened further; revisit if this handler ever gains a write path.',
    // EXTENSION_PAGE-only, and hostname here isn't an identity claim
    // about "what page is this request from" at all — it's a record
    // identifier: "Manage Custom Rules" dashboard lists the user's OWN
    // already-stored cosmetic rules (fetched via MSG_GET_CUSTOM_COSMETIC_
    // RULES, itself a trusted round-trip with no page involvement), the
    // user clicks Delete on one row, and that row's own displayed
    // hostname is echoed back to say which stored rule to remove. No
    // content-script or page DOM is anywhere in this flow — a page
    // cannot influence which of the extension's own already-saved rules
    // shows up as deletable, so there's no spoofable "current page"
    // value to derive from sender in the first place. Same shape as
    // matrix-routes.js's request.domain in handleMatrixSetOverride()
    // (ordinary UI-selected data, not an identity claim) — this check's
    // scope is deliberately request.hostname/site specifically because
    // those names usually DO mean "what page is this," but this is the
    // one confirmed exception where the field name doesn't match that
    // meaning.
    'handleDeleteCosmeticRule': 'EXTENSION_PAGE sender; hostname is a record identifier (which of the user\'s own already-stored rules to delete), echoed from the dashboard\'s own prior GET round-trip, not derived from any page-influenceable source at all — no spoofable "current page" value exists in this flow to derive from sender.',
};

const routesDir = path.join(ROOT, 'js/workflow');
const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('-routes.js'));

let ok = true;
let checkedCount = 0;

for ( const file of routeFiles ) {
    const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
    // Match each exported handler function and its body (up to the next
    // top-level `export` or end of file) — good enough for this
    // codebase's consistent one-function-per-block route-file style,
    // same trade-off this project's other regex-based checks
    // (check-scripting-site-mode-gating.mjs etc.) already accept.
    const fnPattern = /export async function (handle\w+)\s*\(([^)]*)\)\s*\{/g;
    let match;
    const fnStarts = [];
    while ( (match = fnPattern.exec(src)) !== null ) {
        fnStarts.push({ name: match[1], params: match[2], start: match.index });
    }
    for ( let i = 0; i < fnStarts.length; i++ ) {
        const { name, params, start } = fnStarts[i];
        const end = i + 1 < fnStarts.length ? fnStarts[i + 1].start : src.length;
        const body = src.slice(start, end);
        const usesIdentityField =
            /\brequest\??\.(hostname|site)\b/.test(body) ||
            /\{[^}]*\b(hostname|site)\b[^}]*\}\s*=\s*request\b/.test(body);
        if ( !usesIdentityField ) { continue; }
        checkedCount++;
        const hasSenderDerivation = /sender\??\.(url|tab)\b/.test(body) || /getCurrentSessionSite\(\)/.test(body);
        if ( hasSenderDerivation ) {
            console.log(`PASS: ${name} (${file}) — derives from sender/session, not request.hostname/site directly.`);
            continue;
        }
        if ( ALLOWLIST[name] ) {
            console.log(`PASS (allowlisted): ${name} (${file}) — ${ALLOWLIST[name]}`);
            continue;
        }
        ok = false;
        console.log(`FAIL: ${name} (${file}, params: ${params}) reads request.hostname/site with no sender.url/sender.tab derivation and no allowlist entry. Either derive the trusted value from sender (see js/util/trusted-sender.js's trustedHostnameFromSender() for the proven pattern) or add a classified, reasoned allowlist entry above — not a silent pass.`);
    }
}

console.log(`\nChecked ${checkedCount} handler(s) reading request.hostname/site across ${routeFiles.length} route file(s).`);
console.log(ok ? 'PASS: message-hostname-trust check' : 'FAIL: message-hostname-trust check');
process.exitCode = ok ? 0 : 1;
