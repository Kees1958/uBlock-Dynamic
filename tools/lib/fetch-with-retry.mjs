/*******************************************************************************

    uBlock-Stripped-Dynamic — shared download helper for the build scripts
    (tools/build-rulesets.mjs, tools/build-tracker-radar.mjs,
    and the source modules under tools/build/)

    Why this exists (tools audit after 9.7.5, item 2): none of the ~10
    fetch() calls across the build scripts had a timeout, so one upstream
    server that accepts the connection and then stalls hung the whole
    filter update indefinitely, with no error. And one transient failure
    (a CDN hiccup, a rate-limit blip) aborted the whole run.

    Contract:
      withRetry(label, attemptFn)
        Runs attemptFn(signal) up to 1 + FETCH_RETRY_COUNT times.
        `signal` aborts after FETCH_TIMEOUT_MS — pass it to fetch() so
        the timeout also covers reading the response body, not only the
        headers. The WHOLE attempt is retried (download + the caller's own
        content validation), because a CDN error page can arrive with
        HTTP 200 and only fail validation.
        Resolves with attemptFn's result, or rejects with an Error whose
        message names the label, every attempt, and each failure reason.

      fetchWithTimeout(url, signal)
        fetch() with the given signal; throws on a non-2xx status.

    What happens after a final failure is the CALLER's policy, not this
    module's (build-rulesets.mjs carries the previous build of that list
    over and warns at the end; see its own comments).

*******************************************************************************/

// ── CONFIG — every tunable in one place ──────────────────────────────────
// Per attempt, covering headers AND body. Generous: the largest upstream
// lists are several MB and a slow-but-working mirror must not be cut off.
export const FETCH_TIMEOUT_MS = 60_000;
// Extra attempts after the first one (per explicit requirement: at least 1).
export const FETCH_RETRY_COUNT = 1;
// Pause before a retry, so a momentary upstream blip has time to clear.
export const FETCH_RETRY_DELAY_MS = 5_000;

function describeError(err) {
    if ( err?.name === 'TimeoutError' || err?.name === 'AbortError' ) {
        return `timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
    }
    return err?.message ?? String(err);
}

export async function fetchWithTimeout(url, signal) {
    const resp = await fetch(url, { signal });
    if ( !resp.ok ) { throw new Error(`HTTP ${resp.status} fetching ${url}`); }
    return resp;
}

export async function withRetry(label, attemptFn) {
    const failures = [];
    const attempts = 1 + FETCH_RETRY_COUNT;
    for ( let attempt = 1; attempt <= attempts; attempt++ ) {
        try {
            return await attemptFn(AbortSignal.timeout(FETCH_TIMEOUT_MS));
        } catch (err) {
            failures.push(`attempt ${attempt}: ${describeError(err)}`);
            if ( attempt < attempts ) {
                process.stdout.write(`\n  (${label}: ${describeError(err)} — retrying in ${FETCH_RETRY_DELAY_MS / 1000}s) `);
                await new Promise(resolve => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
            }
        }
    }
    throw new Error(`${label} failed after ${attempts} attempts — ${failures.join('; ')}`);
}
