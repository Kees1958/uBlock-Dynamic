/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2022-present Raymond Hill

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
/*
 * deep-compare.js — Structural equality helper
 *
 * Public interface:
 *   deepEquals(a, b) — returns true if a and b are structurally identical (deep equality)
 *
 * No state. No dependencies. Pure utility.
 */


export function deepEquals(a, b) {
    switch ( typeof a ) {
    case 'undefined':
    case 'boolean':
    case 'number':
    case 'string':
        return a === b;
    }
    // case 'object':
    if ( typeof b !== 'object' ) { return false; }
    if ( a === null || b === null ) { return a === b; }
    if ( Array.isArray(a) || Array.isArray(b) ) {
        if ( Array.isArray(a) === false || Array.isArray(b) === false ) { return false; }
        if ( a.length !== b.length ) { return false; }
        for ( let i = 0; i < a.length; i++ ) {
            if ( deepEquals(a[i], b[i]) === false ) { return false; }
        }
        return true;
    }
    const akeys = Object.keys(a);
    const bkeys = Object.keys(b);
    if ( akeys.length !== bkeys.length ) { return false; }
    for ( const k of akeys ) {
        if ( deepEquals(a[k], b[k]) === false ) { return false; }
    }
    return true;
}

