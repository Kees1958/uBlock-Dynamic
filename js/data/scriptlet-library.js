/*
 * scriptlet-library.js — Single source of truth for the SHARED scriptlet library (after 10.4.4).
 *
 * Why: up to 10.4.4 every filter list's generated rulesets/<id>-scriptlets.js carried its own copy of every
 * scriptlet function it used. 59 of the 67 functions were shipped in several lists at once (about 1.8 MB of
 * the 2.9 MB of scriptlet files in 10.4.4), and every enabled list compiled its own copy again on every page
 * and frame. Same design uBlock Origin Lite uses (its scriptlet-begin.js / scriptlet-end.js per world):
 *
 *   rulesets/scriptlet-library.js      — every scriptlet function used by ANY list, once, keyed by its
 *                                        scriptlet name, published on globalThis[SCRIPTLET_LIBRARY_GLOBAL]
 *   rulesets/<id>-scriptlets.js        — per list: data only (hostnames, rows, arguments) + the lookup; it
 *                                        reads the functions from the library by name
 *   rulesets/scriptlet-library-end.js  — deletes globalThis[SCRIPTLET_LIBRARY_GLOBAL] again
 *
 * All three run in a MAIN-world content-script registration (js/core/scripting-manager.js), in that order,
 * at document_start: they execute one after another before any page script, so the page never sees the
 * library object. A data file that runs without the library (should never happen) does nothing.
 *
 * (10.5.6) Two registrations instead of one, so a page only loads scriptlet data its site can use:
 *   SITES  — the sites the lists name (SCRIPTLET_SITES_FILE): library + every enabled list's full data file + end.
 *   ENTITY — every OTHER page: the entity library (only the functions "name.*" rules call) + each list's
 *            "name.*"-only data file (<id>-scriptlets-entity.js) + end. A "name.*" key (any TLD) cannot be a
 *            Chrome match pattern, so these few rules still go everywhere — but no longer with the full tables.
 * The two never meet on one page (ENTITY excludes every SITES site), and on each page the rules that run are
 * exactly those the single registration ran (tools/check-scriptlet-dispatch-layout.mjs proves the split).
 *
 * Read by: js/core/scripting-manager.js (registration) and tools/build/* (generation, checks), so the build
 * and the runtime can never disagree on a file name or the global's name.
 * Pure data — nothing to initialise, clear or release.
 */

// Generated library file, registered FIRST in the combined scriptlet registration.
export const SCRIPTLET_LIBRARY_FILE = 'rulesets/scriptlet-library.js';

// Generated end file, registered LAST: removes the library global before page scripts can run.
export const SCRIPTLET_LIBRARY_END_FILE = 'rulesets/scriptlet-library-end.js';

// Property name of the library on the page's global object for the few microseconds between the library
// file and the end file. An unguessable-looking constant (not per-build random, so a rebuild with the same
// input stays byte-identical — tools/verify-build-unchanged.mjs).
export const SCRIPTLET_LIBRARY_GLOBAL = '__usd_scriptlets_7f3a9c2e';

// (10.5.6) Generated entity library: only the functions the "name.*" rules of any list call. First file of the
// ENTITY registration (which ends with SCRIPTLET_LIBRARY_END_FILE too — same global, same end file).
export const SCRIPTLET_LIBRARY_ENTITY_FILE = 'rulesets/scriptlet-library-entity.js';

// (10.5.6) Generated per list: its "name.*"-only data file, `rulesets/<id>${SCRIPTLET_ENTITY_DATA_SUFFIX}`.
export const SCRIPTLET_ENTITY_DATA_SUFFIX = '-scriptlets-entity.js';

// (10.5.6) Generated: { "<list id>": [ "<site>", ... ] } — every non-entity dispatch key of each list, i.e. the sites
// the SITES registration is limited to.
export const SCRIPTLET_SITES_FILE = 'rulesets/scriptlet-sites.json';
