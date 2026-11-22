// ── tools/build/site-split.mjs ──────────────────────────────────────────────────────
// (2026-11-09) ONE line-level "route each rule by its sites" splitter, shared by every build step that sends part of
// a list to another list (B15/C21: written once, not once per feature):
//   - antiadblock-country-split.mjs — AdGuard Base anti-adblock rules -> the matching language filter;
//   - english-outside-top-sites.mjs — English / generic-TLD sites outside the CrUX top 1M -> the English filter.
//
// How a line is routed:
//   - cosmetic / scriptlet rule (`hosts##…`, `hosts#%#…`, exceptions too): by its listed hosts;
//   - network rule with a `$domain=` option: by those domains;
//   - anything else (site-less rules, comments, headers): to `siteLessKey`.
// A rule whose sites go to several keys is split: one copy per key, each with only its own sites. Exclusions
// (`~site`) are copied into every copy (same rule as extractCountryOverflow()); a rule listing ONLY exclusions is a
// site-less rule. keyOfHost(host) decides per positive host; it receives the host exactly as written (lower-cased).
//
// Public interface:
//   splitRulesBySite(text, keyOfHost, { siteLessKey }) -> { byKey: Map<key, string[]>, splitRules: number }
// Pure function — nothing to initialise, clear or release.

// ── CONFIG ────────────────────────────────────────────────────────────────────
export const SITE_SPLIT_CONFIG = Object.freeze({
    // hosts + cosmetic/scriptlet operator + body. Hosts never contain # $ / | @.
    SITE_RULE_RE: /^([^#$/|@]*)(#@%#|#%#|#@\?#|#\?#|#@\$#|#\$#|#@#|##)(.*)$/,
    // network rule options: the part after the LAST "$" (a "$" inside a regex body comes before it).
    NETWORK_OPTIONS_RE: /^(.*)\$([^$]*)$/,
    DOMAIN_OPTION: 'domain=',
    NEGATION: '~',
});

function groupHosts(hosts, keyOfHost) {
    const groups = new Map();
    const negated = [];
    for ( const raw of hosts ) {
        const h = raw.trim();
        if ( h === '' ) { continue; }
        if ( h.startsWith(SITE_SPLIT_CONFIG.NEGATION) ) { negated.push(h); continue; }
        const key = keyOfHost(h.toLowerCase());
        if ( !groups.has(key) ) { groups.set(key, []); }
        groups.get(key).push(h);
    }
    return { groups, negated };
}

export function splitRulesBySite(text, keyOfHost, { siteLessKey }) {
    const C = SITE_SPLIT_CONFIG;
    const byKey = new Map();
    let splitRules = 0;
    function emit(key, line) {
        if ( !byKey.has(key) ) { byKey.set(key, []); }
        byKey.get(key).push(line);
    }
    function route(line, hosts, rebuild) {
        const { groups, negated } = groupHosts(hosts, keyOfHost);
        if ( groups.size === 0 ) { emit(siteLessKey, line); return; }
        if ( groups.size > 1 ) { splitRules++; }
        for ( const [ key, own ] of groups ) { emit(key, rebuild([ ...own, ...negated ])); }
    }
    for ( const raw of text.split('\n') ) {
        const line = raw.trim();
        if ( line === '' || line.startsWith('!') || line.startsWith('[') ) { emit(siteLessKey, raw); continue; }
        const site = C.SITE_RULE_RE.exec(line);
        if ( site !== null ) {
            const [ , hostPart, operator, body ] = site;
            if ( hostPart === '' ) { emit(siteLessKey, line); continue; }
            route(line, hostPart.split(','), hosts => `${hosts.join(',')}${operator}${body}`);
            continue;
        }
        const net = C.NETWORK_OPTIONS_RE.exec(line);
        if ( net === null ) { emit(siteLessKey, line); continue; }
        const [ , pattern, optionText ] = net;
        const options = optionText.split(',');
        const at = options.findIndex(o => o.startsWith(C.DOMAIN_OPTION));
        if ( at === -1 ) { emit(siteLessKey, line); continue; }
        route(line, options[at].slice(C.DOMAIN_OPTION.length).split('|'), hosts => {
            const copy = options.slice();
            copy[at] = `${C.DOMAIN_OPTION}${hosts.join('|')}`;
            return `${pattern}$${copy.join(',')}`;
        });
    }
    return { byKey, splitRules };
}
