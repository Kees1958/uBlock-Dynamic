// .stylelintrc.mjs — deliberately does NOT extend stylelint-config-standard.
// A prior spot-check (see CHANGELOG.md) found the standard preset produces
// almost entirely formatting-preference noise (blank-line conventions this
// project doesn't follow) with no mapping to this project's actual audit
// checklist (Part A of the audit doc). Only this project's own two custom
// rules are enabled — both directly encode real, computed content from
// STYLE_GUIDE_LIGHT.md / STYLE_GUIDE_DARK.md, per A9's own requirement that
// the style guides be the reference these checks run against.
import verifiedColorMixOpacity from './tools/stylelint-plugins/verified-color-mix-opacity.mjs';
import noUnsafeStatusColorAsText from './tools/stylelint-plugins/no-unsafe-status-color-as-text.mjs';

export default {
    plugins: [ verifiedColorMixOpacity, noUnsafeStatusColorAsText ],
    rules: {
        'ubol/verified-color-mix-opacity': true,
        'ubol/no-unsafe-status-color-as-text': true,
    },
};
