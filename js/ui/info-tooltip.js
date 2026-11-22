/*******************************************************************************

    info-tooltip.js — shared "ⓘ" dropdown info panel.

    Renders a single info-icon button at the end of a filter bar (e.g.
    Monitor's or Privacy Inspector's #monitorTypeFilters) which, on click,
    opens a small dropdown panel listing label/explanation pairs — one row
    per filter-bar entry (resource type, detection category, ...).

    Used by both monitor/monitor-panel.js and privacy/privacy-inspector.js —
    kept here as the single place this component is defined, rather than
    duplicating the open/close/positioning logic in each panel.

*******************************************************************************/

/******************************************************************************/
// Config — single source of truth for this component's own literals.
/******************************************************************************/

const ARIA_LABEL   = 'More information';
const ICON_GLYPH   = 'ⓘ';
const ESCAPE_KEY    = 'Escape';

/******************************************************************************/

// Appends one "ⓘ" dropdown-info button + panel to `container`.
//   container — the filter-bar element the button is appended to (last child)
//   items     — [ { label, text }, ... ] rendered as the panel's rows
//
// Returns { close } so a caller can force the panel shut (e.g. when its own
// parent view is being torn down) — otherwise the panel manages its own
// open/close state and listener lifecycle entirely on its own.
export function createInfoDropdown(container, items) {
    if ( !container ) { return null; }
    if ( !Array.isArray(items) || items.length === 0 ) { return null; }

    const wrap = document.createElement('span');
    wrap.className = 'info-dropdown-wrap';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'info-dropdown-toggle';
    button.setAttribute('aria-label', ARIA_LABEL);
    button.setAttribute('aria-expanded', 'false');
    button.textContent = ICON_GLYPH;

    const panel = document.createElement('div');
    panel.className = 'info-dropdown-panel';
    panel.hidden = true;

    for ( const { label, text } of items ) {
        const row = document.createElement('div');
        row.className = 'info-dropdown-row';
        const term = document.createElement('strong');
        term.textContent = label;
        const desc = document.createElement('span');
        desc.textContent = text;
        row.append(term, desc);
        panel.append(row);
    }

    // ── Guard: outside-click / Escape listeners exist ONLY while the panel
    // is open. Attached on open(), detached on close() — never left
    // dangling on the document once the panel is shut.
    let outsideClickHandler = null;
    let escapeHandler = null;

    function close() {
        panel.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        if ( outsideClickHandler ) {
            document.removeEventListener('click', outsideClickHandler, true);
            outsideClickHandler = null;
        }
        if ( escapeHandler ) {
            document.removeEventListener('keydown', escapeHandler);
            escapeHandler = null;
        }
    }

    function open() {
        panel.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        outsideClickHandler = event => {
            if ( wrap.contains(event.target) ) { return; }
            close();
        };
        escapeHandler = event => {
            if ( event.key === ESCAPE_KEY ) { close(); }
        };
        // capture: true so a click on an ancestor that itself stops
        // propagation (e.g. a row's own click handler) still reaches this
        // listener and closes the panel.
        document.addEventListener('click', outsideClickHandler, true);
        document.addEventListener('keydown', escapeHandler);
    }

    button.addEventListener('click', event => {
        event.stopPropagation();
        if ( panel.hidden ) { open(); } else { close(); }
    });

    wrap.append(button, panel);
    container.append(wrap);

    return { close };
}
