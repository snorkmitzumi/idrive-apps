'use strict';
/**
 * mview.js - Combo's M View tab: the engine's and gearbox's health at a glance.
 *
 *   Engine oil, coolant    the car's own signals (signals.js); while it sends none, the engine unit (OBD 5C / 05)
 *   Gearbox oil            the car's BasicDataSet, else the gearbox unit (EGS 0x18, 22 6000 as on a ZF 8HP)
 *   Intake air             the engine unit (OBD 0F)
 *   Oil level              the car's own measurement (Vehicle2.statusOilDipstick2)
 *   Misfires               per cylinder this driving cycle, from the engine unit's on-board monitors (OBD service 06,
 *                          mid A2 = cylinder 1 ...; 22 F6xx when it refuses service 06); Reset counts from now on,
 *                          nothing is cleared in the car
 *
 * Reads only while the tab shows and the car is not locked and left, one request at a time, after the ambient light's
 * writes (yieldTo). A candidate the unit refuses as not supported (7F xx 11 / 12 / 31) is not asked again this run.
 *
 *   const m = new MView({ reader, values, cfg: app.json config.mview, settings, log, now, yieldTo, link })
 *   m.tick()            each frame while the tab shows (and not the demo): the next read when one is due
 *   m.resetMisfires()   counts from now on
 *   m.draw(cv, t, { demo })
 */
const G = require('./kit/gauges');

const TEMP_MS = 5000, MISFIRE_MS = 10000, CAR_FRESH = 10000, KEEP = 30000, HIST_MS = 2000, HIST_N = 150;
const YIELD_MS = 600, YIELD_STEP = 50, CALL_MS = 1500;
const LEVELS = { MOTOROELSTAND_UNTER_MINIMUM: 'Below min', MOTOROELSTAND_AM_MINIMUM: 'At min', MOTOROELSTAND_1_4: '1/4',
    MOTOROELSTAND_2_4: '2/4', MOTOROELSTAND_3_4: '3/4', MOTOROELSTAND_4_4: '4/4', MOTOROELSTAND_5_4: 'Overfilled',
    MOTOROELSTAND_UEBERFUELLT: 'Overfilled', MOTOROELSTAND_OK: 'OK', SERVICEFUNKTION_AKTIV: 'Measuring' };
const LEVEL_NO = { 0: 'MOTOROELSTAND_UNTER_MINIMUM', 1: 'MOTOROELSTAND_AM_MINIMUM', 2: 'MOTOROELSTAND_1_4', 3: 'MOTOROELSTAND_2_4',
    4: 'MOTOROELSTAND_3_4', 5: 'MOTOROELSTAND_4_4', 6: 'MOTOROELSTAND_5_4', 7: 'MOTOROELSTAND_UEBERFUELLT', 13: 'MOTOROELSTAND_OK', 14: 'SERVICEFUNKTION_AKTIV' };
const TEMPS = ['oil', 'coolant', 'gearbox', 'iat'];
const isNum = (x) => typeof x === 'number' && isFinite(x);
const hexOf = (x) => parseInt(String(x), 16);

/** The car's oil level enum (by name or number) as shown, or null. */
function oilLevel(x) {
    const name = typeof x === 'number' ? LEVEL_NO[x] : x;
    return LEVELS[name] || null;
}

class MView {
    constructor(o) {
        Object.assign(this, { reader: o.reader, values: o.values, settings: o.settings, log: o.log, link: o.link || null });
        this.now = o.now || Date.now;
        this.yieldTo = o.yieldTo || null;
        const cfg = o.cfg || {}, quick = (l) => (l || []).map((c) => Object.assign({ timeoutMs: CALL_MS }, c));
        this.c = { oil: quick(cfg.oil), coolant: quick(cfg.coolant), iat: quick(cfg.iat), gearbox: quick(cfg.egs) };
        const m = cfg.misfire || {};
        this.mis = { ecu: m.ecu == null ? 0x12 : m.ecu, tid: hexOf(m.tid || '0C'), avgTid: hexOf(m.avgTid || '0B'), cylinders: m.cylinders || 6 };
        // the monitor ids to ask (cylinder 1 = A2), the form the unit answers (service 06, or 22 F6xx: did), none left
        this.mids = null; this.misDid = false; this.misGone = null;
        this.counts = []; this.avg = []; this.misT = 0; this.base = null; this.next = 0;
        this.read = {}; this.readT = {}; this.no = {}; this.pick = {}; this.last = {}; this.peak = {}; this.hist = {}; this.histT = 0;
        this.busy = false; this.logged = {};
    }

    /* ---------- the values shown ---------- */
    /** A temperature (deg C): the car's own while it comes, else the one read; null when neither is fresh. */
    temp(k) {
        const L = this.values.live, now = this.now();
        if (isNum(L[k]) && now - (L[k + 'T'] || 0) < CAR_FRESH) return { v: L[k], from: 'car' };
        if (isNum(this.read[k]) && now - (this.readT[k] || 0) < KEEP) return { v: this.read[k], from: k === 'gearbox' ? 'EGS' : 'DME' };
        return null;
    }
    carFresh(k) { const L = this.values.live; return isNum(L[k]) && this.now() - (L[k + 'T'] || 0) < CAR_FRESH; }
    /** The counts shown: since Reset (until the engine unit starts a new driving cycle: a count under its base). */
    shown() {
        const c = this.counts, b = this.base;
        if (!b || !c.length) return c;
        if (c.some((x, i) => isNum(x) && isNum(b[i]) && x < b[i])) { this.base = null; this.log.info('misfires: a new driving cycle, the reset is done with'); return c; }
        return c.map((x, i) => (isNum(x) ? x - (b[i] || 0) : x));
    }
    resetMisfires() { this.base = this.counts.slice(); this.log.info('misfires: counted from now on'); }

    /* ---------- when ---------- */
    tick() {
        const now = this.now();
        this.record(now);
        if (this.busy || (this.link && !this.link.available) || this.values.live.left) return;
        const due = this.due(now);
        if (!due) return;
        this.last[due] = now;
        this.busy = true;
        this.run(due).catch((e) => this.log.warn('mview ' + due + ': ' + e)).then(() => { this.busy = false; });
    }
    /** The next value to read: a temperature the car doesn't send, or the next cylinder's misfires. */
    due(now) {
        for (const k of TEMPS) {
            if (this.carFresh(k) || !this.live(this.c[k]).length) continue;
            if (now - (this.last[k] || 0) >= TEMP_MS) return k;
        }
        if (this.misGone === null && now - (this.last.misfire || 0) >= MISFIRE_MS / Math.max(1, this.mis.cylinders)) return 'misfire';
        return null;
    }
    async run(k) {
        if (this.yieldTo) {
            const t0 = this.now();
            while (this.yieldTo() && this.now() - t0 < YIELD_MS) await new Promise((res) => setTimeout(res, YIELD_STEP));
        }
        if (k === 'misfire') return this.readMisfire();
        const v = await this.ask(k, this.c[k]);
        if (v !== null) { this.read[k] = v; this.readT[k] = this.now(); }
    }
    /** Each value's history for its trace (one point every HIST_MS) and its peak this run. */
    record(now) {
        TEMPS.forEach((k) => { const x = this.temp(k); if (x && (!isNum(this.peak[k]) || x.v > this.peak[k])) this.peak[k] = x.v; });
        if (now - this.histT < HIST_MS) return;
        this.histT = now;
        TEMPS.forEach((k) => { const h = this.hist[k] || (this.hist[k] = []), x = this.temp(k); h.push(x ? x.v : null); if (h.length > HIST_N) h.shift(); });
    }

    /* ---------- what ---------- */
    live(list) { return (list || []).filter((c) => !this.no[this.reader.key(c)]); }
    /** The first candidate that answers (the one that answered last first); one refused as not supported: left out. */
    async ask(name, list) {
        const live = this.live(list), pk = this.pick[name];
        const order = live.filter((c) => this.reader.key(c) === pk).concat(live.filter((c) => this.reader.key(c) !== pk));
        for (const c of order) {
            const v = await this.reader.read(c), key = this.reader.key(c), raw = this.reader.raws[key];
            this.logOnce(name + ' ' + key, raw);
            if (refused(raw) && !this.no[key]) { this.no[key] = true; this.log.info('mview ' + name + ' ' + key + ': not supported (' + raw.bytes + '), not asked again'); }
            if (v !== null) { this.pick[name] = key; return v; }
        }
        return null;
    }
    logOnce(k, raw) {
        if (!raw) return;
        const what = raw.bytes ? 'reply ' + raw.bytes.split(' ').length + ' bytes' : 'none (' + (raw.why || '') + ')';
        if (this.logged[k] === what) return;
        this.logged[k] = what;
        this.log.info('mview ' + k + ': ' + (raw.bytes ? 'reply ' + raw.bytes : what));
    }
    /** One cylinder per call (the next in turn): its counts this driving cycle and the 10-cycle average. */
    async readMisfire() {
        const r = this.reader, e = this.mis.ecu;
        if (!this.mids) {
            // which monitors the unit has (A0's bit map); a unit that doesn't say: cylinders 1..n
            let ids = await r.supported(e, 0xA0, false);
            this.logOnce('misfire A0', r.raws[r.monitorKey(e, 0xA0, false)]);
            if (!ids) { ids = await r.supported(e, 0xA0, true); this.logOnce('misfire F6A0', r.raws[r.monitorKey(e, 0xA0, true)]); if (ids) this.misDid = true; }
            const cyl = (ids || []).filter((x) => x >= 0xA2 && x <= 0xAD);
            this.mids = cyl.length ? cyl : Array.from({ length: this.mis.cylinders }, (x, i) => 0xA2 + i);
            this.log.info('misfires: cylinders ' + this.mids.length + (ids ? ' (the engine unit lists them' + (this.misDid ? ', over 22 F6xx)' : ')') : ' (from app.json)'));
            this.mis.cylinders = this.mids.length;
            return;
        }
        const i = this.next % this.mids.length, mid = this.mids[i];
        this.next++;
        let recs = await r.monitor(e, mid, this.misDid);
        const raw = r.raws[r.monitorKey(e, mid, this.misDid)];
        this.logOnce('misfire ' + r.monitorKey(e, mid, this.misDid), raw);
        if (!recs && refused(raw)) {
            if (!this.misDid) { this.misDid = true; this.log.info('misfires: service 06 refused, asking 22 F6xx'); recs = await r.monitor(e, mid, true); this.logOnce('misfire ' + r.monitorKey(e, mid, true), r.raws[r.monitorKey(e, mid, true)]); }
            if (!recs && refused(r.raws[r.monitorKey(e, mid, true)])) { this.misGone = 'The engine unit gives no misfire counts'; this.log.info('misfires: ' + this.misGone + ', not asked again'); return; }
        }
        if (!recs) return;
        const pick = (tid) => { const x = recs.find((q) => q.tid === tid); return x ? x.value : null; };
        this.counts[i] = pick(this.mis.tid); this.avg[i] = pick(this.mis.avgTid); this.misT = this.now();
    }

    /* ---------- the tab ---------- */
    draw(cv, t, o) {
        const demo = !!(o && o.demo), f = this.settings && this.settings.get('tempUnit') === 'f';
        const u = (c) => (isNum(c) ? (f ? c * 1.8 + 32 : c) : null), unit = f ? '°F' : '°C', T = (c) => (f ? c * 1.8 + 32 : c);
        const D = demo ? demoValues(this.now()) : null;
        const tile = (k, label, x, y, zones) => {
            const x0 = D ? { v: D[k], from: 'demo' } : this.temp(k);
            const pk = D ? null : this.peak[k], why = x0 ? null : this.why(k);
            G.stat(cv, t, x, y, 380, 228, {
                label, value: x0 ? u(x0.v) : null, unit, decimals: 0, size: 72, zones,
                history: D ? [] : (this.hist[k] || []).map(u),
                sub: why || ((isNum(pk) ? 'Max ' + Math.round(u(pk)) + unit + '  ·  ' : '') + 'from ' + x0.from),
            });
        };
        const hot = (warn, crit, cold) => [{ from: T(crit), to: 9999, color: 'crit' }, { from: T(warn), to: T(crit), color: 'warn' }].concat(cold != null ? [{ from: -999, to: T(cold), color: 'cold' }] : []);
        tile('oil', 'Engine oil', 24, 44, hot(130, 145, 70));
        tile('coolant', 'Coolant', 412, 44, hot(110, 118, 60));
        tile('gearbox', 'Gearbox oil', 24, 284, hot(110, 125, 50));
        tile('iat', 'Intake air', 412, 284, hot(55, 70));
        this.drawRight(cv, t, D);
    }
    why(k) {
        if (this.link && !this.link.available) return 'Diagnostic link down';
        if (this.values.live.left) return 'Paused: car locked';
        if (!this.live(this.c[k]).length) return 'Not given by this car';
        return this.last[k] ? 'No reply' : 'Reading…';
    }
    drawRight(cv, t, D) {
        const x = 800, w = 776;
        G.panel(cv, t, x, 44, w, 468, 'Misfires this drive');
        const L = this.values.live;
        const lvl = D ? '4/4' : (L.oilLevelT && this.now() - L.oilLevelT < 10 * 60000 ? oilLevel(L.oilLevel) : null);
        cv.text('OIL LEVEL', x + 400, 82, 18, t.dim, { font: 'bold', spacing: 2 });
        cv.text(lvl || '--', x + w - 24, 84, 26, lvl === 'Below min' || lvl === 'At min' || lvl === 'Overfilled' ? t.warn : lvl ? t.text : t.dim, { align: 'right', font: 'bold' });
        const counts = D ? D.mis : this.shown(), n = D ? 6 : (this.mids ? this.mids.length : this.mis.cylinders);
        if (!D && this.misGone) { cv.text(this.misGone, x + 24, 150, 22, t.dim); return; }
        const top = 120, rowH = Math.min(52, 330 / n), max = Math.max(10, ...counts.filter(isNum));
        let total = 0;
        for (let i = 0; i < n; i++) {
            const y = top + i * rowH, c = counts[i];
            if (isNum(c)) total += c;
            cv.text('Cyl ' + (i + 1), x + 24, y + 28, 22, t.text, { font: 'bold' });
            G.bar(cv, t, x + 120, y + 6, w - 260, 30, { head: false, value: isNum(c) ? c : null, min: 0, max, smooth: false,
                color: isNum(c) && c > 0 ? 'warn' : undefined });
            cv.text(isNum(c) ? String(c) : '--', x + w - 24, y + 30, 26, isNum(c) && c > 0 ? t.warn : isNum(c) ? t.text : t.dim, { align: 'right', font: 'num' });
        }
        const avg = D ? [] : this.avg.filter(isNum), y = top + n * rowH + 24;
        const sub = D ? 'Demo' : !this.mids ? 'Asking the engine unit…' : !this.misT ? (this.link && !this.link.available ? 'Diagnostic link down' : 'Reading…')
            : 'Total ' + total + (this.base ? ' since Reset' : '') + (avg.length ? '  ·  10-drive average ' + avg.reduce((a, b) => a + b, 0) : '');
        cv.text(sub, x + 24, Math.min(y, 492), 20, t.dim);
    }
}

/** A reply the unit refused as not supported: 7F <sid> 11 / 12 / 31. */
function refused(raw) {
    if (!raw || !raw.bytes) return false;
    const b = raw.bytes.split(' ').map((x) => parseInt(x, 16));
    return b[0] === 0x7f && [0x11, 0x12, 0x31].indexOf(b[2]) >= 0;
}

/** The demo's values (Combo's demo setting): a warm engine, no misfires. */
function demoValues(now) {
    const s = Math.sin(now / 9000);
    return { oil: 102 + 4 * s, coolant: 92 + 2 * s, gearbox: 81 + 3 * s, iat: 34 + 3 * s, mis: [0, 0, 0, 0, 0, 0] };
}

module.exports = { MView, oilLevel, refused };
