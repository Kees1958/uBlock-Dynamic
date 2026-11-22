// ── editor-helpers.js ────────────────────────────────────────────────────────
// (audit 10.6.4, B15/C21) Shared CodeMirror-editor helpers for the two editor classes that had
// near-identical copies of the same code: js/ui/filter-editor.js (FilterEditor) and
// dashboard/develop.js (the developer/allow-list editor).
//
// Public interface:
//   normalizeEditorText(text)                  — trims; non-empty text ends with exactly one '\n'
//   replaceEditorDoc(view, text)               — replaces the whole document, then focuses the editor
//   buildIOPanel(ioButtons, onApply, onRevert) — clones template.io-panel, renders i18n + icons,
//                                                wires #apply/#revert; returns { root, config }
//                                                for ioPanel.render(view, config)
//
// Dependencies: dom.js, i18n.js, fa-icons.js (Tier 1 UI only). No state owned by this module.
// ─────────────────────────────────────────────────────────────────────────────

import { dom, qs$ } from './dom.js';
import { faIconsInit } from './fa-icons.js';
import { i18n } from './i18n.js';

// Selector of the shared <template> both editor pages carry for the Apply/Revert panel.
const IO_PANEL_TEMPLATE_SELECTOR = 'template.io-panel';

export function normalizeEditorText(text) {
    text ||= '';
    text = text.trim();
    if ( text !== '' ) { text += '\n'; }
    return text;
}

export function replaceEditorDoc(view, text) {
    view.dispatch({
        changes: {
            from: 0, to: view.state.doc.length,
            insert: text,
        },
    });
    view.focus();
}

export function buildIOPanel(ioButtons, onApply, onRevert) {
    const template = document.querySelector(IO_PANEL_TEMPLATE_SELECTOR);
    const fragment = template.content.cloneNode(true);
    const root = fragment.querySelector('.io-panel');
    i18n.render(root);
    faIconsInit(root);
    root.dataset.io = ioButtons.join(' ');
    const config = {
        dom: root,
        mount: ( ) => {
            dom.on(qs$(root, '#apply'), 'click', onApply);
            dom.on(qs$(root, '#revert'), 'click', onRevert);
        },
    };
    return { root, config };
}
