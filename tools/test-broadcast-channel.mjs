#!/usr/bin/env node
// tools/test-broadcast-channel.mjs — (11.1.6) the service worker's ONE sending BroadcastChannel, against the REAL
// js/data/broadcast.js and Node's real BroadcastChannel (C42):
//   Initiate — nothing is opened by loading the module; the first send opens exactly one channel
//   Perform  — many sends reuse that channel, and a listener on the same name receives every message, in order
//   Release  — releaseBroadcastChannel() closes it; a second release is a no-op; a send after it opens a fresh one
//   Single source — no channel name typed anywhere but js/data/broadcast.js
// Exit 0 = pass, 1 = failed assertion, 2 = could not run (C38).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
globalThis.self = globalThis;   // the extension modules expect a worker global

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
const MODULE = 'js/data/broadcast.js';
const SEND_COUNT = 50;                                     // enough sends to show reuse
const DELIVERY_TIMEOUT_MS = 2000;                          // how long the listener may take to see every message
const NAME_USERS = Object.freeze([ 'matrix/matrix-panel.js', 'privacy/privacy-inspector.js' ]);
const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_DID_NOT_RUN = 2;

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if ( !ok ) { failures += 1; }
}
function didNotRun(msg) { console.log(`DID NOT RUN: ${msg}`); process.exit(EXIT_DID_NOT_RUN); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

if ( typeof globalThis.BroadcastChannel !== 'function' ) { didNotRun('this Node has no BroadcastChannel'); }

// ── Spy: counts the channels the module opens and closes (the real class does the messaging) ──────
const RealChannel = globalThis.BroadcastChannel;
const opened = [];
let closedCount = 0;
globalThis.BroadcastChannel = class extends RealChannel {
    constructor(name) { super(name); opened.push(name); }
    close() { closedCount += 1; super.close(); }
};

let mod;
try {
    mod = await import(pathToFileURL(path.join(ROOT, MODULE)).href);
} catch ( err ) {
    didNotRun(`cannot import ${MODULE} (${err.message})`);
}
const listener = new RealChannel(mod.BROADCAST_CHANNEL_NAME);   // a panel listening on the same name
const received = [];
const allReceived = new Promise(resolve => {
    listener.onmessage = ev => { received.push(ev.data); if ( received.length === SEND_COUNT ) { resolve(true); } };
});

try {
    check('loading the module opens nothing', opened.length === 0, JSON.stringify(opened));
    for ( let i = 0; i < SEND_COUNT; i++ ) { mod.broadcastMessage({ seq: i }); }
    check(`${SEND_COUNT} sends open exactly ONE channel, on the shared name`,
        opened.length === 1 && opened[0] === mod.BROADCAST_CHANNEL_NAME, JSON.stringify(opened));
    let timer;
    const delivered = await Promise.race([
        allReceived,
        new Promise(resolve => { timer = setTimeout(( ) => resolve(false), DELIVERY_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    check('the listener receives every message, in order',
        delivered === true && received.every((m, i) => m.seq === i), `${received.length}/${SEND_COUNT}`);
    mod.releaseBroadcastChannel();
    mod.releaseBroadcastChannel();
    check('release closes it once; a second release is a no-op', closedCount === 1, `closed ${closedCount}`);
    mod.broadcastMessage({ seq: 'after-release' });
    check('a send after release opens a fresh channel', opened.length === 2, JSON.stringify(opened));
} finally {
    mod.releaseBroadcastChannel();   // release: an open channel would keep Node running
    listener.close();
}

for ( const rel of NAME_USERS ) {
    const src = read(rel);
    check(`${rel} uses the shared channel name`,
        /new BroadcastChannel\(BROADCAST_CHANNEL_NAME\)/.test(src) && /import \{ BROADCAST_CHANNEL_NAME \} from '\.\.\/js\/data\/broadcast\.js'/.test(src)
            && /['"]uBOL['"]/.test(src) === false);
}

process.exit(failures === 0 ? EXIT_PASS : EXIT_FAIL);
