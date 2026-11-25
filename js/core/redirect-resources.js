/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2015-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/Kees1958/uBol-stripped
    Based on uBlock Origin (https://github.com/gorhill/uBlock), modified in
    2026 for uBlock-Stripped-Dynamic — see CHANGELOG.md for the changes.
*/

/******************************************************************************/

// The resources referenced below are found in ./web_accessible_resources/
//
// Only the $redirect= targets this extension bundles (any other target drops the line, in the build and in
// the Import ABP box alike — both read this table through js/core/ubo-parser.js):
//   - noop.js        (dpgmedia.nl/dpgmedia.com$redirect=noop.js)
//   - noop-1s.mp4    (cdn-ster-nl.akamaized.net/*.mp4$redirect=noopmp4-1s, on nos.nl)
//   - optimizely.js  (11.0.4, uBO e68e05cde0) surrogate for cdn.optimizely.com/js/<id>.js and
//                    /public/…_edge_helper.js: a working but empty window.optimizely, no experiments,
//                    no cookies/storage, no beacons. Used from the owner's Quick-fixes list.
//   - google-ima.js  (11.1.3, uBO b8a305e) surrogate for imasdk.googleapis.com/js/sdkloader/ima3.js: a working
//                    google.ima API that never loads an ad, so the player starts the video itself. Aliases are
//                    uBO's own names and AdGuard's (`google-ima3`, e.g. AdGuard Base's bbc.com video-ad rule).

export default new Map([
    [ 'noop.js', {
        alias: [ 'noopjs', 'abp-resource:blank-js' ],
        data: 'text',
    } ],
    [ 'noop-1s.mp4', {
        alias: [ 'noopmp4-1s', 'abp-resource:blank-mp4' ],
        data: 'blob',
    } ],
    [ 'optimizely.js', {
        data: 'text',
    } ],
    [ 'google-ima.js', {
        alias: [ 'ubo-google-ima.js', 'google-ima3' ],
        data: 'text',
    } ],
]);
