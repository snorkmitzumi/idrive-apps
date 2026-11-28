'use strict';
/**
 * profile.js - a CPU profile and a memory report of the running app, asked for over SSH (3.1.4). BMW's app manager
 * starts the app's Node with its own flags, so no --prof: Node's inspector records the profile from inside instead.
 *
 *   kill -USR2 <the app's pid>
 *
 * records SECONDS (60 s) of CPU profile, then writes into the app's data folder:
 *   cpu-<time>.cpuprofile   Chrome DevTools / speedscope (Performance > Load profile)
 *   mem-<time>.json         memory before and after a full collection, V8's heap and its spaces
 * The last KEEP of each are kept. A second signal while one is recorded is ignored. A Node built without the
 * inspector gets the memory report only. Nothing runs until the signal comes.
 *
 *   install({ dir, log, seconds })
 */
const fs = require('fs');
const path = require('path');
const v8 = require('v8');

const SECONDS = 60, KEEP = 3, MB = 1048576;

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const mb = (m) => { const o = {}; Object.keys(m).forEach((k) => { o[k] = Math.round(m[k] / MB * 10) / 10; }); return o; };

/** The memory now, then again after a full collection (the app's Node runs with --expose-gc). */
function memory() {
    const before = process.memoryUsage();
    let after = null;
    if (typeof global.gc === 'function') { try { global.gc(); after = process.memoryUsage(); } catch (e) { after = null; } }
    let spaces = null;
    try { spaces = v8.getHeapSpaceStatistics().map((s) => ({ space: s.space_name, usedMB: Math.round(s.space_used_size / MB * 10) / 10, sizeMB: Math.round(s.space_size / MB * 10) / 10 })); } catch (e) { spaces = null; }
    return { node: process.version, uptimeS: Math.round(process.uptime()), beforeMB: mb(before), afterCollectionMB: after ? mb(after) : null, heap: mb(v8.getHeapStatistics()), spaces };
}

/** Only the newest KEEP files that start with prefix stay. */
function prune(dir, prefix) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.indexOf(prefix) === 0).sort(); } catch (e) { return; }
    names.slice(0, Math.max(0, names.length - KEEP)).forEach((n) => { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* gone */ } });
}

function write(dir, name, text, log) {
    const file = path.join(dir, name);
    try { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); return file; } catch (e) { log.warn('profile: ' + name + ' not written: ' + (e && e.message || e)); return null; }
}

function install(o) {
    const dir = o.dir, log = o.log, seconds = o.seconds || SECONDS;
    let inspector = null;
    try { inspector = require('inspector'); } catch (e) { inspector = null; }
    let busy = false;
    const report = (t) => {
        const f = write(dir, 'mem-' + t + '.json', JSON.stringify(memory(), null, 1) + '\n', log);
        prune(dir, 'mem-');
        if (f) log.info('profile: memory report ' + f);
    };
    const run = () => {
        if (busy) { log.info('profile: one is being recorded already'); return; }
        const t = stamp(new Date());
        if (!inspector || typeof inspector.Session !== 'function') { log.info('profile: this Node has no inspector, the memory report only'); report(t); return; }
        busy = true;
        const s = new inspector.Session();
        // the session closed on the next turn, never inside one of its own callbacks: Node 8 crashed there (SIGSEGV /
        // abort, about every second time)
        const done = (why) => setImmediate(() => { try { s.disconnect(); } catch (e) { /* closed */ } busy = false; if (why) log.warn('profile: ' + why); report(t); });
        try { s.connect(); } catch (e) { done('no inspector session: ' + (e && e.message || e)); return; }
        s.post('Profiler.enable', (e1) => {
            if (e1) { done('Profiler.enable: ' + e1.message); return; }
            s.post('Profiler.start', (e2) => {
                if (e2) { done('Profiler.start: ' + e2.message); return; }
                log.info('profile: recording ' + seconds + ' s of CPU');
                const tm = setTimeout(() => {
                    s.post('Profiler.stop', (e3, res) => {
                        if (e3 || !res || !res.profile) { done('Profiler.stop: ' + (e3 ? e3.message : 'no profile')); return; }
                        const f = write(dir, 'cpu-' + t + '.cpuprofile', JSON.stringify(res.profile), log);
                        prune(dir, 'cpu-');
                        if (f) log.info('profile: CPU profile ' + f);
                        done(null);
                    });
                }, seconds * 1000);
                if (tm.unref) tm.unref();
            });
        });
    };
    process.on('SIGUSR2', run);
    return { run, memory };
}

module.exports = { install, memory, SECONDS, KEEP };
