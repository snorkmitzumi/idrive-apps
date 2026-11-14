'use strict';
/**
 * reads.js - what this screen asks the car over the read-only diagnostic link (kit/runtime/readonly-diag.js), and
 * when. The link takes one request at a time and every app keeps running hidden, so:
 *
 *   - only while the screen is shown (checked again before each read and when the next round is scheduled; a round
 *     at once when it is shown again: opened()),
 *   - only while the car is in use: driving (over 1 km/h or the engine running) and 3 min after, or 10 min after the
 *     screen was opened (as eDrive), so a parked car can sleep; never while the car is locked and left,
 *   - the fast values most often: front-axle torque every 0.5 s (1 s when the car sends its own split), boost from
 *     the engine unit every 0.5 s (only when the sport display has none); the batteries every 2.5 s; the 12 V
 *     charge, boost target and temperature every 30 s; the 12 V health every 30 min,
 *   - a value whose candidates all failed 3 times in a row only every 5 min.
 *
 * The 48 V battery (eDrive's read48()): Auto shows it once it answers (kept in battery.json); one that never answers
 * is given up after 6 tries (3 when another unit answered) and asked again only every 5 min.
 *
 *   const r = new Reads({ link, reader, values, settings, cfg, ui, log, now, dataDir, active })   active(): false = demo, no reads
 *   r.start()  r.shown() (each frame)  r.opened() (screen shown again)  r.inUse()  r.paused()
 *   r.bat = { b48, b48T, b12: { soc, v, a, soh, temp }, b12T, has48 }   r.fresh() -> { b48, b12 } (stale -> null)
 *   r.why(key) -> 'diagnostic link down' | 'paused - parked' | 'no 48 V battery' | 'no reply' | 'reading…'
 */
const fs = require('fs');
const path = require('path');
const B = require('./batteries');
const { writeWhole } = require('./store');

const DIAG = { retryBaseMs: 150, pendingTimeoutMs: 1500, callTimeoutMs: 2000 };
const IDLE_AFTER_MOVE = 3 * 60000, IDLE_AFTER_USER = 10 * 60000, OPENED_GAP = 5000;
const FAST = 500, SPLIT = 1000, BATTERY = 2500, SLOW = 30000, HEALTH = 30 * 60000, BACKOFF = 5 * 60000, LINK_RETRY = 2000;
const BARO_MS = 60000;
// a value this old is not shown any more (the battery panels show the reason instead)
const KEEP = { b48: 15000, v: 15000, a: 15000, soc: 10 * 60000, temp: 2 * 60000, soh: Infinity };

class Reads {
    constructor(o) {
        Object.assign(this, { link: o.link, reader: o.reader, values: o.values, settings: o.settings, ui: o.ui, log: o.log });
        this.now = o.now || (() => Date.now());
        this.active = o.active || (() => true);           // false: nothing to read (the demo is on screen)
        const cfg = o.cfg || {}, dme = cfg.dme || {}, bat = cfg.battery || {};
        // short waits per candidate (M Vitals and eDrive since PR #1); a candidate's own values in app.json win
        const quick = (list, ecu) => (list || []).map((c) => Object.assign({ timeoutMs: 1000, diagOpts: DIAG }, ecu != null && c.ecu == null ? { ecu } : {}, c));
        this.c = {
            front: quick(cfg.xdrive && cfg.xdrive.front), boost: quick(dme.boost, dme.ecu), baro: quick(dme.baro, dme.ecu),
            boostTarget: quick(dme.boostTarget, dme.ecu), b48: quick(bat.b48), v12: quick(bat.v12), i12: quick(bat.i12),
            soc40: quick(bat.soc40), soc12: quick(bat.soc12), soh12: quick(bat.soh12), t12: quick(bat.t12),
        };
        this.bat = { b48: null, b48T: 0, b12: { soc: null, v: null, a: null, soh: null, temp: null }, b12T: {}, has48: null };
        this.file = o.dataDir ? path.join(o.dataDir, 'battery.json') : null;
        this.st = {};
        try { this.st = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch (e) { /* first run */ }
        if (this.st.has48 === true || this.st.has48 === false) this.bat.has48 = this.st.has48;
        if (typeof this.st.v12Pick === 'number') this.reader.pick.v12 = this.st.v12Pick;
        this.last = {}; this.fails = {}; this.miss48 = 0; this.shapes = {};
        this.baro = 101.3; this.baroT = 0;
        this.lastUserT = this.now(); this.lastActiveT = 0; this.lastFrameT = 0;
        this.timer = null; this.busy = false;
        this.items = this.makeItems();
    }

    makeItems() {
        const s = this.settings, v = this.values, c = this.c, r = this.reader;
        // xDrive: Show, or Auto once all-wheel drive was seen; Auto before that: every 30 s, and torque to the front
        // axle marks it (M Vitals: over 20 Nm), as the car may send neither its split nor the drive mode
        const xdriveEvery = () => (s.get('xdrive') === 'off' || !c.front.length ? null
            : s.get('xdrive') === 'auto' && !v.live.awdSeen ? SLOW : v.carSplit() ? SPLIT : FAST);
        const ecusOf = (...lists) => { const out = []; lists.forEach((l) => l.forEach((x) => { if (x.ecu != null && out.indexOf(x.ecu) < 0) out.push(x.ecu); })); return out; };
        const keep12 = (k, x) => { if (x === null || x === undefined) return false; this.bat.b12[k] = x; this.bat.b12T[k] = this.now(); return true; };
        return [
            { key: 'lmvFront', every: xdriveEvery, ecus: ecusOf(c.front),
                read: async () => { const x = await r.value('lmvFront', c.front); if (x === null) return false; v.put('lmvFront', x); if (Math.abs(x) > 20) v.markAwd(); return true; } },
            { key: 'boostDme', ecus: ecusOf(c.boost, c.baro), every: () => (c.boost.length && v.boostFromDme() ? FAST : null),
                read: async () => { await this.freshBaro(); const x = await r.value('boost', c.boost); if (x === null) return false; v.put('boostDme', (x - this.baro) / 100); return true; } },
            { key: 'b48', ecus: ecusOf(c.b48), every: () => (s.get('battery48') === 'off' || !c.b48.length ? null : this.bat.has48 === false && s.get('battery48') === 'auto' ? BACKOFF : BATTERY),
                read: () => this.read48() },
            { key: 'v12', ecus: ecusOf(c.v12), every: () => BATTERY, read: () => this.readV12(keep12) },
            { key: 'i12', ecus: ecusOf(c.i12), every: () => BATTERY, read: async () => keep12('a', await r.value('i12', c.i12)) },
            { key: 'soc40', ecus: ecusOf(c.soc40), every: () => SLOW, read: async () => { const f = await this.readFields('soc40', c.soc40); return !!f && keep12('soc', f.soc); } },
            { key: 'soc12', ecus: ecusOf(c.soc12), every: () => ((this.fails.soc40 || 0) >= 3 ? SLOW : null), read: async () => keep12('soc', await r.value('soc12', c.soc12)) },
            { key: 'boostTarget', ecus: ecusOf(c.boostTarget, c.baro), every: () => (c.boostTarget.length ? SLOW : null),
                read: async () => { await this.freshBaro(); const x = await r.value('boostTarget', c.boostTarget); if (x === null) return false; v.put('boostTarget', (x - this.baro) / 100); return true; } },
            { key: 't12', ecus: ecusOf(c.t12), every: () => SLOW, read: async () => keep12('temp', await r.value('t12', c.t12)) },
            { key: 'soh12', ecus: ecusOf(c.soh12), every: () => HEALTH, read: async () => keep12('soh', await r.value('soh12', c.soh12)) },
        ];
    }

    /* ---------- when ---------- */
    /** Driving, or 3 min after; or 10 min after the screen was opened (eDrive's inUse()). */
    inUse() {
        const now = this.now(), L = this.values.live;
        const engine = typeof L.rpm === 'number' && L.rpm > 400 && now - (L.rpmT || 0) < 5000;
        if ((typeof L.speed === 'number' && L.speed > 1) || engine) this.lastActiveT = now;
        // the car locked and left (its own vehicle state, signals.js): never, so it can sleep (eDrive 2.9.1)
        const use = !L.left && (now - this.lastActiveT < IDLE_AFTER_MOVE || now - this.lastUserT < IDLE_AFTER_USER);
        if (use && this.wasInUse === false) this.wake();          // in use again: units that went quiet get asked again
        this.wasInUse = use;
        return use;
    }
    paused() { return !this.inUse(); }
    /** Each frame: a frame after a pause means the screen was just opened. */
    shown() {
        const now = this.now(), opened = now - this.lastFrameT > OPENED_GAP;
        this.lastFrameT = now;
        if (opened) this.opened();
        else if (this.timer === null && !this.busy) this.schedule(0);
    }
    /** The screen was shown again (or a button pressed): counts as use, and a round at once. */
    opened() { this.lastUserT = this.now(); this.wake(); if (!this.busy) this.schedule(0); }
    /**
     * The read-only link skips a unit that missed 5 replies in a row until it is woken (kit/runtime/readonly-diag.js
     * silent()): asleep or not up yet - e.g. the screen opened before the engine was started. Woken when the screen is
     * opened, when the car is in use again, and before each back-off retry of a value (its own units).
     */
    wake(ecus) {
        if (!this.link.wake) return;
        if (ecus === undefined) this.link.wake(); else ecus.forEach((e) => this.link.wake(e));
    }
    start() { this.schedule(0); }
    /** The next round in ms - only while shown and in use; else nothing until opened() / shown(). */
    schedule(ms) {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        if (!this.active() || !this.ui.isVisible('MAIN') || !this.inUse()) return;
        this.timer = setTimeout(() => { this.timer = null; this.round(); }, ms);
    }
    every(it) { const e = it.every(); return e === null ? null : (this.fails[it.key] || 0) >= 3 ? Math.max(e, BACKOFF) : e; }
    nextDelay() {
        if (!this.link.available) return LINK_RETRY;
        const now = this.now();
        let best = null;
        for (const it of this.items) {
            const e = this.every(it);
            if (e === null) continue;
            const due = Math.max(0, (this.last[it.key] || 0) + e - now);
            if (best === null || due < best) best = due;
        }
        return best === null ? SLOW : Math.max(50, best);
    }
    async round() {
        if (this.busy) return;
        this.busy = true;
        try {
            if (this.link.available) {
                for (const it of this.items) {
                    if (!this.active() || !this.ui.isVisible('MAIN') || !this.inUse()) break;        // hidden, parked or demo meanwhile
                    const e = this.every(it);
                    if (e === null || this.now() - (this.last[it.key] || 0) < e) continue;
                    this.last[it.key] = this.now();
                    if ((this.fails[it.key] || 0) >= 3 && it.ecus) this.wake(it.ecus);      // the back-off retry: really ask
                    let ok = false;
                    try { ok = await it.read(); } catch (err) { this.log.warn(it.key + ': ' + err); }
                    this.fails[it.key] = ok ? 0 : (this.fails[it.key] || 0) + 1;
                    if (this.fails[it.key] === 3) this.log.warn(it.key + ': no answer 3 times, asked every 5 min');
                }
            }
        } catch (err) { this.log.warn('reads: ' + err); }
        this.busy = false;
        this.schedule(this.nextDelay());
    }

    /* ---------- what ---------- */
    async freshBaro() {
        if (this.now() - this.baroT < BARO_MS) return;
        this.baroT = this.now();
        const b = await this.reader.value('baro', this.c.baro);
        if (b !== null) this.baro = b;
    }
    /** A candidate with several fields on one reply (eDrive's readGroup()): { field: value } or null. */
    async readFields(name, list) {
        const start = this.reader.pick[name] || 0;
        for (let k = 0; k < list.length; k++) {
            const i = (start + k) % list.length, c = list[i], names = Object.keys(c.fields || {});
            const p = Object.assign({ ecu: c.ecu, did: c.did, timeoutMs: c.timeoutMs, diagOpts: c.diagOpts }, c.fields[names[0]]);
            await this.reader.read(p);
            const raw = this.reader.raws[this.reader.key(p)];
            if (!raw || !raw.bytes) continue;                                  // no reply
            const bytes = raw.bytes.split(' ').map((x) => parseInt(x, 16));
            // the 48 V layout is not confirmed on a car: every new reply shape to the log, before any plausibility check
            if (name === 'b48') {
                const shape = B.rawShape(bytes);
                if (!this.shapes[shape]) { this.shapes[shape] = 1; this.log.info('raw AA56: ' + raw.bytes); }
            }
            // a positive reply to this identifier is an answer, even when a field doesn't fit (it is then null)
            if (bytes[0] !== 0x62 || ((bytes[1] << 8) | bytes[2]) !== parseInt(c.did, 16)) continue;
            this.reader.pick[name] = i;
            return B.fields(bytes, c.fields);
        }
        return null;
    }
    async read48() {
        const f = await this.readFields('b48', this.c.b48), now = this.now();
        if (f) {
            this.bat.b48 = B.b48(f); this.bat.b48T = now; this.miss48 = 0;
            if (this.bat.has48 !== true) { this.bat.has48 = true; this.save(); this.log.info('48 V battery answers'); }
            return true;
        }
        const other = Object.keys(this.bat.b12T).length > 0 || !!this.values.live.lmvT;
        if (this.bat.has48 !== true && this.settings.get('battery48') === 'auto' && ++this.miss48 >= (other ? 3 : 6) && this.bat.has48 !== false) {
            this.bat.has48 = false; this.save(); this.log.info('no 48 V battery: the 12 V battery gets the whole column');
        }
        return false;
    }
    /** The 12 V voltage: the candidate that answered is asked first, remembered across restarts (eDrive's v12Pick). */
    async readV12(keep12) {
        const v = await this.reader.value('v12', this.c.v12);
        if (v !== null && this.reader.pick.v12 !== this.st.v12Pick) { this.st.v12Pick = this.reader.pick.v12; this.save(); }
        return keep12('v', v);
    }
    save() {
        this.st.has48 = this.bat.has48;
        try { if (this.file) writeWhole(this.file, JSON.stringify(this.st)); } catch (e) { this.log.warn('save: ' + e); }
    }

    /** The values to show now: one too old is null (the panel then shows why). */
    fresh() {
        const now = this.now(), b = this.bat, b12 = {};
        // parked or no link: nothing old is shown, the panels say why instead
        if (!this.link.available || !this.inUse()) { Object.keys(b.b12).forEach((k) => { b12[k] = null; }); return { b48: null, b12, has48: b.has48 }; }
        Object.keys(b.b12).forEach((k) => { b12[k] = b.b12T[k] && now - b.b12T[k] < KEEP[k] ? b.b12[k] : null; });
        return { b48: b.b48T && now - b.b48T < KEEP.b48 ? b.b48 : null, b12, has48: b.has48 };
    }
    why(key) {
        if (!this.link.available) return 'diagnostic link down';
        if (this.values.live.left) return 'paused - car locked';
        if (!this.inUse()) return 'paused - parked';
        if (key === 'b48' && this.bat.has48 === false) return 'no 48 V battery';
        // the 12 V panel's values are read as v12 / i12 / soc40: none of them answers
        if (key === 'b12') return ['v12', 'i12', 'soc40'].every((k) => (this.fails[k] || 0) > 0) ? 'no reply' : 'reading…';
        if ((this.fails[key] || 0) > 0) return 'no reply';
        return 'reading…';
    }
}

module.exports = { Reads };
