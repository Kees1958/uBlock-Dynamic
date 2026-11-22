// ── tools/build/tracker-radar-source.mjs ─────────────────────────────────────────────
// DuckDuckGo Tracker Radar: where it lives and which crawl regions this project reads (10.5.5).
// Single source for tools/build-tracker-radar.mjs (js/data/tracker-radar-data.json) and
// tools/build/hagezi-light-selection.mjs (which HaGeZi Multi light entries ship).
//
// Public interface: TRACKER_RADAR_REPO, TRACKER_RADAR_BRANCH, TRACKER_RADAR_REGIONS
// Pure data: nothing to initialise, clear or release.

export const TRACKER_RADAR_REPO = 'https://github.com/duckduckgo/tracker-radar.git';
export const TRACKER_RADAR_BRANCH = 'main';
// The 9 regions DuckDuckGo crawls (domains/<REGION>/<domain>.json).
export const TRACKER_RADAR_REGIONS = Object.freeze([ 'US', 'GB', 'DE', 'FR', 'NL', 'NO', 'CH', 'CA', 'AU' ]);
