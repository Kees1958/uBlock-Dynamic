/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2026-present Raymond Hill

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
 * alarms.js — Chrome alarms scheduling for deferred background jobs
 *
 * Public interface:
 *   resetJobsAlarm()    — schedules the next 'deferredJobs' alarm
 *   processDueJobs(fn)  — runs any jobs whose scheduled time has passed
 *   registerJob(name, when) — adds a job to the deferred queue
 *   DEFERRED_JOBS_ALARM_NAME — the alarm name background.js's onAlarm listener routes
 *
 * Persisted: job queue in chrome.storage.local
 */


import {
    browser,
    localRead, localRemove, localWrite,
} from './ext.js';

/******************************************************************************/
// Configuration — one place (11.0.2, audit 11.0.2 finding 6). Values unchanged.
/******************************************************************************/

// The one alarm that wakes the worker for due jobs. Also the storage key of the queue (same string since uBOL; kept —
// a stored queue must stay readable). background.js's onAlarm listener routes this name.
export const DEFERRED_JOBS_ALARM_NAME = 'deferredJobs';
const DEFERRED_JOBS_STORAGE_KEY = 'deferredJobs';

// A job alarm is never set sooner than this: Chrome may delay shorter alarms anyway, and nothing queued here is urgent.
const DEFERRED_JOBS_MIN_DELAY_MS = 5 * 60 * 1000;

/******************************************************************************/

// (11.0.2, audit 11.0.2 finding 4) Callers await this, so a failed alarm call reaches their caller instead of
// becoming an unhandled rejection.
function setupJobsAlarm(jobs) {
    if ( Boolean(jobs?.length) === false ) {
        return browser.alarms.clear(DEFERRED_JOBS_ALARM_NAME);
    }
    const when = Math.max(jobs[0].time, Date.now() + DEFERRED_JOBS_MIN_DELAY_MS);
    return browser.alarms.create(DEFERRED_JOBS_ALARM_NAME, { when });
}

export async function registerJob(name, time) {
    const jobs = await localRead(DEFERRED_JOBS_STORAGE_KEY) || [];
    const job = jobs.find(a => a.name === name);
    if ( job ) {
        job.time = time;
    } else {
        jobs.push({ name, time });
    }
    jobs.sort((a, b) => a.time - b.time);
    await setupJobsAlarm(jobs);
    return localWrite(DEFERRED_JOBS_STORAGE_KEY, jobs);
}

export async function removeJob(name) {
    // GUARD (10.7.1): the queue key is deleted once empty (processDueJobs/removeJob below), so "nothing stored" is a
    // normal state — read it as an empty queue. It used to throw here, which could abort a caller's later steps
    // (e.g. clearAutoDenyOnBrowserStartup() before the browser-start auto-start) whenever the queue was empty.
    const before = await localRead(DEFERRED_JOBS_STORAGE_KEY) ?? [];
    const after = before.filter(a => a.name !== name);
    if ( after.length === before.length ) { return; }
    await setupJobsAlarm(after);
    if ( after.length ) {
        return localWrite(DEFERRED_JOBS_STORAGE_KEY, after);
    }
    return localRemove(DEFERRED_JOBS_STORAGE_KEY);
}

export async function processDueJobs(dispatcher) {
    const jobs = await localRead(DEFERRED_JOBS_STORAGE_KEY);
    if ( Boolean(jobs?.length) === false ) { return; }
    const now = Date.now();
    let i = 0;
    while ( i < jobs.length ) {
        if ( jobs[i].time > now ) { break; }
        i += 1;
    }
    const toProcess = jobs.slice(0, i);
    const toDefer = jobs.slice(i);
    if ( toDefer.length ) {
        await setupJobsAlarm(toDefer);
        await localWrite(DEFERRED_JOBS_STORAGE_KEY, toDefer);
    } else {
        await localRemove(DEFERRED_JOBS_STORAGE_KEY);
    }
    await Promise.all(toProcess.map(a => dispatcher({ what: a.name })));
}

export async function resetJobsAlarm() {
    const jobs = await localRead(DEFERRED_JOBS_STORAGE_KEY);
    await setupJobsAlarm(jobs);
}
