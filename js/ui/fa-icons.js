/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2018-present Raymond Hill

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
    Based on uMatrix (https://github.com/gorhill/uMatrix), modified in
    2026 for uBlock-Stripped-Dynamic — see CHANGELOG.md for the changes.
*/

/******************************************************************************/

export const faIconsInit = (( ) => {

    // https://github.com/uBlockOrigin/uBlock-issues/issues/1196
    const svgIcons = new Map([
        // Only two icons are rendered anywhere in the extension:
        //   power-off -> popup status icon
        //   angle-up  -> picker "more/less" buttons (normal + vflipped)
        [ 'angle-up',             { viewBox: '0 0  998  582', path: 'm 998,499 q 0,13 -10,23 l -50,50 q -10,10 -23,10 -13,0 -23,-10 L 499,179 106,572 Q 96,582 83,582 70,582 60,572 L 10,522 Q 0,512 0,499 0,486 10,476 L 476,10 q 10,-10 23,-10 13,0 23,10 l 466,466 q 10,10 10,23 z' } ],
        [ 'power-off',            { viewBox: '0 0 1536 1664', path: 'm 1536,896 q 0,156 -61,298 -61,142 -164,245 -103,103 -245,164 -142,61 -298,61 -156,0 -298,-61 Q 328,1542 225,1439 122,1336 61,1194 0,1052 0,896 0,714 80.5,553 161,392 307,283 q 43,-32 95.5,-25 52.5,7 83.5,50 32,42 24.5,94.5 Q 503,455 461,487 363,561 309.5,668 256,775 256,896 q 0,104 40.5,198.5 40.5,94.5 109.5,163.5 69,69 163.5,109.5 94.5,40.5 198.5,40.5 104,0 198.5,-40.5 Q 1061,1327 1130,1258 1199,1189 1239.5,1094.5 1280,1000 1280,896 1280,775 1226.5,668 1173,561 1075,487 1033,455 1025.5,402.5 1018,350 1050,308 q 31,-43 84,-50 53,-7 95,25 146,109 226.5,270 80.5,161 80.5,343 z m -640,-768 0,640 q 0,52 -38,90 -38,38 -90,38 -52,0 -90,-38 -38,-38 -38,-90 l 0,-640 q 0,-52 38,-90 38,-38 90,-38 52,0 90,38 38,38 38,90 z' } ],
    ]);

    return function(root) {
        const icons = (root || document).querySelectorAll('.fa-icon');
        if ( icons.length === 0 ) { return; }
        const svgNS = 'http://www.w3.org/2000/svg';
        for ( const icon of icons ) {
            if ( icon.firstChild === null || icon.firstChild.nodeType !== 3 ) {
                continue;
            }
            const name = icon.firstChild.nodeValue.trim();
            if ( name === '' ) { continue; }
            const svg = document.createElementNS(svgNS, 'svg');
            svg.classList.add('fa-icon_' + name);
            const details = svgIcons.get(name);
            if ( details === undefined ) {
                let file;
                if ( name.startsWith('ph-') ) {
                    file = 'photon';
                } else if ( name.startsWith('md-') ) {
                    file = 'material-design';
                } else {
                    continue;
                }
                const use = document.createElementNS(svgNS, 'use');
                use.setAttribute('href', `/img/${file}.svg#${name}`);
                svg.appendChild(use);
            } else {
                svg.setAttribute('viewBox', details.viewBox);
                const path = document.createElementNS(svgNS, 'path');
                path.setAttribute('d', details.path);
                svg.appendChild(path);
            }
            icon.replaceChild(svg, icon.firstChild);
            if ( icon.classList.contains('fa-icon-badged') ) {
                const badge = document.createElement('span');
                badge.className = 'fa-icon-badge';
                icon.insertBefore(badge, icon.firstChild.nextSibling);
            }
        }
    };
})();

faIconsInit();
