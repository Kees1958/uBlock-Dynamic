/*******************************************************************************

    uBlock-Stripped-Dynamic — tool-overlay secret
    Copyright (C) 2026-present Kees1958

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/Kees1958/uBol-stripped

*/

// ── tool-overlay-secret.js ────────────────────────────────────────────────────
// One random secret per browser session that the page-side overlay script (js/scripting/tool-overlay.js) passes
// to the tool frame (js/ui/tool-overlay-ui.js) in its 'startOverlay' message. The frame starts only when the
// secret matches, so a web page that copies the frame's URL and posts its own 'startOverlay' cannot drive the
// element picker. Ported from uBlock Origin Lite (gorhill/uBlock ead588a, 2026-11-03); here the secret also
// survives a service-worker restart (storage.session, trusted contexts only), so a restart between the page side
// and the frame asking for it cannot make the two disagree.
//
// Public interface:
//   getToolOverlaySecret() — the session's secret (created on first use)
//
// State owned by this module:
//   toolOverlaySecret {string|null} — in-memory copy; lost on SW restart, restored from storage.session
//
// Dependencies: ../data/ext.js (sessionRead, sessionWrite).

import { sessionRead, sessionWrite } from '../data/ext.js';

const TOOL_OVERLAY_SECRET_CONFIG = Object.freeze({
    STORAGE_KEY: 'toolOverlaySecret',   // storage.session key; session storage is closed to content scripts (F-TRUST-1)
});

let toolOverlaySecret = null;
let pendingSecret = null;               // guard: concurrent first calls share one creation

async function loadOrCreateSecret() {
    const stored = await sessionRead(TOOL_OVERLAY_SECRET_CONFIG.STORAGE_KEY);
    if ( typeof stored === 'string' && stored !== '' ) { return stored; }
    const created = self.crypto.randomUUID();
    await sessionWrite(TOOL_OVERLAY_SECRET_CONFIG.STORAGE_KEY, created);
    return created;
}

export async function getToolOverlaySecret() {
    if ( toolOverlaySecret !== null ) { return toolOverlaySecret; }
    pendingSecret ??= loadOrCreateSecret().finally(( ) => { pendingSecret = null; });
    toolOverlaySecret = await pendingSecret;
    return toolOverlaySecret;
}
