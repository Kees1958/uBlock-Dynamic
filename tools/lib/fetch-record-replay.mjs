/*******************************************************************************

    uBlock-Stripped-Dynamic — fetch record/replay for build verification

    Purpose (phase 2 of the tools rework): prove that restructuring
    tools/build-rulesets.mjs changes NOTHING in its output. Upstream filter
    lists change constantly, so two live builds a minute apart can differ;
    comparing outputs is only meaningful when both runs read identical input.

    Loaded as a preload, never imported by the build itself:
        FETCH_RR_MODE=record FETCH_RR_DIR=/path node --import ./tools/lib/fetch-record-replay.mjs tools/build-rulesets.mjs
        FETCH_RR_MODE=replay FETCH_RR_DIR=/path node --import ./tools/lib/fetch-record-replay.mjs tools/build-rulesets.mjs

    record — performs every real fetch and saves status, content-type and
             the exact body bytes, keyed by URL.
    replay — serves every fetch from the recording; a URL that was not
             recorded is an ERROR (never a silent live fetch), so a replay
             run can only ever see the recorded input.

*******************************************************************************/

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const MODE = process.env.FETCH_RR_MODE;
const DIR = process.env.FETCH_RR_DIR;
const VALID_MODES = new Set([ 'record', 'replay' ]);

if ( VALID_MODES.has(MODE) === false || typeof DIR !== 'string' || DIR === '' ) {
    throw new Error('fetch-record-replay: set FETCH_RR_MODE=record|replay and FETCH_RR_DIR=<directory>');
}
fs.mkdirSync(DIR, { recursive: true });

function keyFor(url) { return crypto.createHash('sha256').update(String(url)).digest('hex'); }

const realFetch = globalThis.fetch;

globalThis.fetch = async function recordReplayFetch(url, options) {
    const key = keyFor(url);
    const metaPath = path.join(DIR, `${key}.json`);
    const bodyPath = path.join(DIR, `${key}.body`);
    if ( MODE === 'replay' ) {
        if ( fs.existsSync(metaPath) === false ) {
            throw new Error(`fetch-record-replay: no recording for ${url} — replay never fetches live`);
        }
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return new Response(fs.readFileSync(bodyPath), {
            status: meta.status,
            headers: { 'content-type': meta.contentType ?? 'application/octet-stream' },
        });
    }
    const resp = await realFetch(url, options);
    const body = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(bodyPath, body);
    fs.writeFileSync(metaPath, JSON.stringify({ url: String(url), status: resp.status, contentType: resp.headers.get('content-type') }));
    return new Response(body, { status: resp.status, headers: { 'content-type': resp.headers.get('content-type') ?? 'application/octet-stream' } });
};
