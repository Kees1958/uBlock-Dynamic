// tools/check-popup-dom-refs.mjs — every #id referenced from popup/*.js
// (via qs$('#id') or dom.on('#id', ...)) actually exists in
// popup/popup.html. Ported from tools/self-test.mjs's check [5/6] (see
// CHANGELOG — self-test.mjs retired; see check-json-syntax.mjs's own
// header for why).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

console.log('=== popup.html ↔ popup JS — every #id referenced in popup/*.js exists in popup.html ===');

const popupHtml = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');
const htmlIds = new Set([ ...popupHtml.matchAll(/id="([^"]+)"/g) ].map(m => m[1]));
const popupJsFiles = fs.readdirSync(path.join(ROOT, 'popup')).filter(f => f.endsWith('.js'));

let failures = 0;
for ( const f of popupJsFiles ) {
    const src = fs.readFileSync(path.join(ROOT, 'popup', f), 'utf8');
    const refs = new Set([
        ...[ ...src.matchAll(/qs\$\('#([A-Za-z0-9_]+)'\)/g) ].map(m => m[1]),
        ...[ ...src.matchAll(/dom\.on\('#([A-Za-z0-9_]+)'/g) ].map(m => m[1]),
    ]);
    for ( const id of refs ) {
        if ( htmlIds.has(id) === false ) {
            failures++;
            console.log(`FAIL: popup/${f} references #${id} — not found in popup.html`);
        }
    }
}

console.log('');
if ( failures > 0 ) {
    console.log(`${failures} broken popup DOM-id reference(s).`);
    process.exitCode = 1;
} else {
    console.log(`PASS: all popup DOM-id references resolve (checked ${popupJsFiles.length} files).`);
}
