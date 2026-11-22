// ── tools/build/third-party-credits.mjs ───────────────────────────────────────
// The credit notices the build writes into generated files that carry third-party code. One place for the
// wording, so every generated file names its source the same way and THIRD_PARTY_LICENSES.md stays the full record.
//
// Public interface:
//   THIRD_PARTY_CREDITS                — source names, URLs and licences (constants)
//   adguardScriptletFileNotice(version)— header comment for one AdGuard scriptlet file (js/generated/custom-scriptlets/)
//   UBO_PATCH_SCRIPTLET_NOTICE         — header comment for one hand-ported uBO scriptlet file (js/generated/custom-scriptlets/u*.js)
//   SCRIPTLET_LIBRARY_NOTICE           — header comment for the shared scriptlet library files (rulesets/scriptlet-library*.js)
//   corelibsCreditFields()             — the credit fields stored in js/resources/ag-scriptlets-corelibs.json
//
// Dependencies: none. Pure constants and string builders.
//
// NOTE: the notices are `/*! … */` comments — the form minifiers keep — and contain no "*/" of their own.

export const THIRD_PARTY_CREDITS = Object.freeze({
    ADGUARD_SCRIPTLETS_NAME:    'AdGuard Scriptlets',                          // npm @adguard/scriptlets
    ADGUARD_SCRIPTLETS_URL:     'https://github.com/AdguardTeam/Scriptlets',   // upstream repository
    ADGUARD_SCRIPTLETS_LICENSE: 'GPL-3.0',                                     // verified against the repository LICENSE
    ADGUARD_AUTHOR:             'by the AdGuard team (AdguardTeam)',           // authors as the repository names them; no copyright line is invented
    UBO_NAME:                   'uBlock Origin',                               // source of the hand-ported scriptlets (C40)
    UBO_URL:                    'https://github.com/gorhill/uBlock',           // upstream repository
    UBO_LICENSE:                'GPL-3.0-or-later',                            // uBlock Origin's licence
    UBO_COPYRIGHT:              'Copyright (C) Raymond Hill',                  // copyright holder of uBlock Origin
    CREDITS_DOC:                'THIRD_PARTY_LICENSES.md',                     // the full attribution record
});

const C = THIRD_PARTY_CREDITS;

export function adguardScriptletFileNotice(version) {
    const v = typeof version === 'string' && version !== '' ? ` ${version}` : '';
    return `/*! ${C.ADGUARD_SCRIPTLETS_NAME}${v} (${C.ADGUARD_SCRIPTLETS_URL}) ${C.ADGUARD_AUTHOR}, ` +
           `${C.ADGUARD_SCRIPTLETS_LICENSE}. Bundled unchanged by uBlock-Stripped-Dynamic; see ${C.CREDITS_DOC}. */\n`;
}

export const UBO_PATCH_SCRIPTLET_NOTICE =
    `/*! Adapted from ${C.UBO_NAME} (${C.UBO_URL}), ${C.UBO_COPYRIGHT}, ${C.UBO_LICENSE}; ` +
    `hand-ported by uBlock-Stripped-Dynamic (js/resources/ubo-patch-scriptlets-source.mjs); see ${C.CREDITS_DOC}. */\n`;

export const SCRIPTLET_LIBRARY_NOTICE =
    `/*! Scriptlet functions from ${C.ADGUARD_SCRIPTLETS_NAME} (${C.ADGUARD_SCRIPTLETS_URL}) ${C.ADGUARD_AUTHOR}, ` +
    `${C.ADGUARD_SCRIPTLETS_LICENSE}; and scriptlets adapted from ${C.UBO_NAME} (${C.UBO_URL}), ${C.UBO_COPYRIGHT}, ` +
    `${C.UBO_LICENSE}. Bundled by uBlock-Stripped-Dynamic; see ${C.CREDITS_DOC}. */\n`;

export function corelibsCreditFields() {
    return {
        source:  `${C.ADGUARD_SCRIPTLETS_NAME} (${C.ADGUARD_SCRIPTLETS_URL}); hand-ported scriptlets adapted from ${C.UBO_NAME} (${C.UBO_URL})`,
        license: `${C.ADGUARD_SCRIPTLETS_LICENSE} (${C.ADGUARD_SCRIPTLETS_NAME}); ${C.UBO_LICENSE} (${C.UBO_NAME})`,
        credits: C.CREDITS_DOC,
    };
}
