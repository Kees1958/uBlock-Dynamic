/*
 * settings.js — Dashboard initialisation
 *
 * Removes the loading state from the body once the dashboard is ready.
 * userScripts detection removed in v3.12 — the sandbox editor no longer
 * uses the userScripts API so no capability gate is needed here.
 */

import { dom } from '../js/ui/dom.js';
import { sendMessage } from '../js/data/ext.js';

/******************************************************************************/

sendMessage({
    what: 'getOptionsPageData',
}).catch(reason => {
    console.error(reason);
}).finally(() => {
    dom.cl.remove(dom.body, 'loading');
});

/******************************************************************************/
