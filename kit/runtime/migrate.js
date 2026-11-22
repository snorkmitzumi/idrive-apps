'use strict';
/**
 * migrate.js - an app that got a new id takes what it saved under its old id, once.
 *
 * For the head unit a new id is a new app, with an empty data folder of its own; the app under the old id stays
 * installed beside it, its data with it (Cockpit was Combo, id "combo", until 2.7.0). app.json:
 *   "migrateFrom": { "id": "combo", "files": ["settings.json", "seatmem.json", ...] }
 *
 * The head unit keeps each app in a folder of its own beside the others (.../oap_<uid>/, its source/package.json
 * naming it, its saved files in data/). The old app is found by that name, and the files it has are copied into this
 * app's data folder while this one has saved no settings yet. Nothing here is overwritten and nothing of the old app is
 * changed. A folder the head unit doesn't let this app read: logged, nothing copied, asked again at the next start.
 *
 *   migrate({ from, files, appRoot, dataDir, log }) -> { done, copied: [names], from: folder | null, why }
 */
const fs = require('fs');
const path = require('path');

/** The other app's folder, by the name in its source/package.json, or null. */
function findApp(parent, id, self) {
    let names = [];
    try { names = fs.readdirSync(parent); } catch (e) { return { dir: null, why: 'apps folder not readable (' + (e.code || e.message) + ')' }; }
    let denied = 0;
    for (const n of names) {
        const dir = path.join(parent, n);
        if (path.resolve(dir) === path.resolve(self)) continue;
        let pkg = null;
        try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'source', 'package.json'), 'utf8')); } catch (e) {
            if (e.code === 'EACCES' || e.code === 'EPERM') denied++;
            continue;
        }
        if (pkg && pkg.name === id) return { dir, why: null };
    }
    return { dir: null, why: denied ? 'not found (' + denied + ' app folders not readable)' : 'not installed' };
}

/** A file copied whole or not at all (a temp file renamed over it). */
function copyWhole(src, dst) {
    const tmp = dst + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, fs.readFileSync(src));
    fs.renameSync(tmp, dst);
}

function migrate(o) {
    const log = o.log || { info() {}, warn() {} };
    const files = o.files || [];
    if (!o.from || !files.length) return { done: false, copied: [], from: null, why: 'nothing to migrate' };
    // this app has saved settings already: it is set up, nothing taken
    if (fs.existsSync(path.join(o.dataDir, 'settings.json'))) return { done: false, copied: [], from: null, why: 'already set up' };
    const found = findApp(path.dirname(path.resolve(o.appRoot)), o.from, o.appRoot);
    if (!found.dir) {
        log.info('migrate: ' + o.from + ' ' + found.why + ': nothing taken from it (this app\'s data: ' + o.dataDir + ')');
        return { done: false, copied: [], from: null, why: found.why };
    }
    const data = path.join(found.dir, 'data'), copied = [], failed = [];
    for (const f of files) {
        const src = path.join(data, f), dst = path.join(o.dataDir, f);
        if (fs.existsSync(dst)) continue;
        try { copyWhole(src, dst); copied.push(f); } catch (e) {
            if (e.code !== 'ENOENT') failed.push(f + ' (' + (e.code || e.message) + ')');
        }
    }
    if (failed.length) log.warn('migrate: from ' + o.from + ' (' + found.dir + ') not readable: ' + failed.join(', ') + '; this app\'s data: ' + o.dataDir);
    if (copied.length) log.info('migrate: from ' + o.from + ' (' + found.dir + '): ' + copied.join(', '));
    else if (!failed.length) log.info('migrate: ' + o.from + ' found (' + found.dir + '), nothing saved there');
    return { done: copied.length > 0, copied, from: found.dir, why: failed.length ? 'not readable' : null };
}

module.exports = { migrate, findApp };
