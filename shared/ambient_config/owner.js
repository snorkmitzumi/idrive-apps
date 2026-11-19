'use strict';
/**
 * owner.js - one of our ambient apps at a time on the lights. Ambient config and Combo (which hosts the same tabs)
 * both drive the body controller's light modules; with both installed their colours would jump as with IterioDev's
 * Comfort tool (others.js). Each app keeps a small file in DIR with its process and when it started; the app started
 * first has the lights, the other leaves them alone (lights.hold) until that one has gone, then takes them.
 * One file per app: /dev/shm is sticky, so an app can't replace another app's file.
 *
 *   const o = new Owner({ log, app: 'combo' }).start();
 *   o.peer -> the app id that has the lights, or null (this one has them)      o.on('change', fn)
 */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const DIR = process.env.MGU_AMBIENT_OWNER_DIR || '/dev/shm';
const PREFIX = 'mgu-ambient-owner.', EVERY_MS = 10000;

/** The process is running (EPERM: it is, under another user). */
function alive(pid) {
    if (!(pid > 0)) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

class Owner extends EventEmitter {
    constructor(o) {
        super();
        this.log = o.log; this.app = o.app; this.pid = o.pid || process.pid;
        this.since = o.since || Date.now(); this.dir = o.dir || DIR;
        this.peer = null; this._timer = null;
    }

    get file() { return path.join(this.dir, PREFIX + this.app + '.json'); }

    start() {
        try { fs.writeFileSync(this.file, JSON.stringify({ pid: this.pid, since: this.since })); } catch (e) {
            if (this.log) this.log.warn('ambient owner: ' + e);
        }
        this.check();
        this._timer = setInterval(() => this.check(), EVERY_MS);
        // gone with the app (MainApp's shutdown, a crash), so a later process with the same pid is not taken for it
        this._bye = () => { try { if (JSON.parse(fs.readFileSync(this.file, 'utf8')).pid === this.pid) fs.unlinkSync(this.file); } catch (e) { /* gone */ } };
        if (this.pid === process.pid) process.on('exit', this._bye);
        return this;
    }

    stop() { clearInterval(this._timer); if (this._bye) { process.removeListener('exit', this._bye); this._bye(); } }

    check() {
        let names = [];
        try { names = fs.readdirSync(this.dir).filter((f) => f.indexOf(PREFIX) === 0 && /\.json$/.test(f)); } catch (e) { names = []; }
        let peer = null, best = null;
        names.forEach((f) => {
            const app = f.slice(PREFIX.length, -5);
            if (app === this.app) return;
            let o = null;
            try { o = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); } catch (e) { return; }
            if (!o || o.pid === this.pid || !alive(o.pid)) return;
            // the one started first has the lights (the same moment: the lower app id)
            const first = o.since < this.since || (o.since === this.since && app < this.app);
            if (first && (!best || o.since < best.since)) { best = o; peer = app; }
        });
        if (peer === this.peer) return;
        this.peer = peer;
        if (this.log) {
            if (peer) this.log.warn('ambient: ' + peer + ' drives the ambient lights: this app leaves them alone');
            else this.log.info('ambient: no other app of ours on the lights: this app drives them');
        }
        this.emit('change');
    }
}

module.exports = { Owner, alive, DIR };
