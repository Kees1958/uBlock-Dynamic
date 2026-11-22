/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2014-present Raymond Hill

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
    Based on uBlock Origin Lite (https://github.com/gorhill/uBlock), modified in
    2026 for uBlock-Stripped-Dynamic — see CHANGELOG.md for the changes.
*/

import { dom } from './dom.js';

/******************************************************************************/

{
    const mql = self.matchMedia('(prefers-color-scheme: dark)');
    const theme = mql instanceof Object && mql.matches === true
        ? 'dark'
        : 'light';
    dom.cl.toggle(dom.html, 'dark', theme === 'dark');
    dom.cl.toggle(dom.html, 'light', theme !== 'dark');
}

{
    const mql = self.matchMedia('(hover: hover)');
    const isTouchScreen = mql.matches !== true;
    dom.cl.toggle(dom.html, 'mobile', isTouchScreen);
    dom.cl.toggle(dom.html, 'desktop', isTouchScreen === false);
}
