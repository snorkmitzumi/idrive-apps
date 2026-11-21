'use strict';
/**
 * mview.js - Combo's M View tab: the engine's and gearbox's health at a glance.
 *
 *   Engine oil, coolant    the car's own signals (signals.js); while it sends none, the engine unit (OBD 5C / 05)
 *   Gearbox oil            the car's BasicDataSet, else the gearbox unit (EGS 0x18, 22 6000 as on a ZF 8HP)
 *   Intake air             the engine unit (OBD 0F)
 *   Fuel trims, timing     the engine unit (OBD 06 / 07 short and long term trim bank 1, 0E ignition advance)
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
const { withAlpha } = require('./kit/canvas');

const TEMP_MS = 5000, MISFIRE_MS = 10000, CAR_FRESH = 10000, KEEP = 30000, HIST_MS = 2000, HIST_N = 150;
const YIELD_MS = 600, YIELD_STEP = 50, CALL_MS = 1500;
const TEMPS = ['oil', 'coolant', 'gearbox', 'iat'];
// the Fuel trims & timing card (engine unit, OBD 01 06 / 07 / 0E): trims in %, the advance in degrees
const FUEL = ['stft', 'ltft', 'timing'];
// a trim the engine unit has to hold this far from 0 % means air or fuel is off (a leak, an injector, a sensor)
const TRIM_WARN = 10, TRIM_CRIT = 20;
const GO = '#2fd27a';
// a healthy engine counts a few each drive (the engine unit flags misfires at ~1-2 % of revolutions): the total in
// yellow from MIS_WARN, red from MIS_CRIT, a cylinder from MIS_CYL_WARN (M Vitals' thresholds)
const MIS_WARN = 100, MIS_CRIT = 500, MIS_CYL_WARN = 50;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const hexOf = (x) => parseInt(String(x), 16);

class MView {
    constructor(o) {
        Object.assign(this, { reader: o.reader, values: o.values, settings: o.settings, log: o.log, link: o.link || null });
        this.now = o.now || Date.now;
        this.yieldTo = o.yieldTo || null;
        const cfg = o.cfg || {}, quick = (l) => (l || []).map((c) => Object.assign({ timeoutMs: CALL_MS }, c));
        this.c = { oil: quick(cfg.oil), coolant: quick(cfg.coolant), iat: quick(cfg.iat), gearbox: quick(cfg.egs), stft: quick(cfg.stft), ltft: quick(cfg.ltft), timing: quick(cfg.timing) };
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
    /** A fuel trim or the timing while fresh, else null. */
    fuel(k) { return isNum(this.read[k]) && this.now() - (this.readT[k] || 0) < KEEP ? this.read[k] : null; }
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
    /** The next value to read: a temperature the car doesn't send, a fuel trim / the timing, or the next cylinder's misfires. */
    due(now) {
        for (const k of TEMPS) {
            if (this.carFresh(k) || !this.live(this.c[k]).length) continue;
            if (now - (this.last[k] || 0) >= TEMP_MS) return k;
        }
        for (const k of FUEL) if (this.live(this.c[k]).length && now - (this.last[k] || 0) >= TEMP_MS) return k;
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
        // refused by the unit, or not let out by the read-only link (a kit before 2.4.2): the UDS form instead
        if (!recs && (refused(raw) || blocked(raw))) {
            if (!this.misDid) { this.misDid = true; this.log.info('misfires: service 06 refused, asking 22 F6xx'); recs = await r.monitor(e, mid, true); this.logOnce('misfire ' + r.monitorKey(e, mid, true), r.raws[r.monitorKey(e, mid, true)]); }
            if (!recs && refused(r.raws[r.monitorKey(e, mid, true)])) { this.misGone = 'The engine unit gives no misfire counts'; this.log.info('misfires: ' + this.misGone + ', not asked again'); return; }
        }
        if (!recs) return;
        const pick = (tid) => { const x = recs.find((q) => q.tid === tid); return x ? x.value : null; };
        this.counts[i] = pick(this.mis.tid); this.avg[i] = pick(this.mis.avgTid); this.misT = this.now();
    }

    /* ---------- the tab ---------- */
    /*
     * Left to right: the tyres (M Vitals' Chassis card, narrower), the four temperatures in two columns, then the
     * misfires (M Vitals' Fuel & ignition card: the total, a cell per cylinder) over the fuel trims and the ignition timing.
     */
    draw(cv, t, o) {
        const demo = !!(o && o.demo), U = require('./draw').units(this.settings || { get: () => null });
        const D = demo ? demoValues(this.now()) : null, T = (c) => U.T(c);
        this.drawTyres(cv, t, 24, 44, 452, 468, D ? D.tyres : this.tyres(), U);
        const tile = (k, label, x, y, zones) => {
            const x0 = D ? { v: D[k], from: 'demo' } : this.temp(k);
            const pk = D ? null : this.peak[k], why = x0 ? null : this.why(k);
            G.stat(cv, t, x, y, 300, 228, {
                label, value: x0 ? T(x0.v) : null, unit: U.tU, decimals: 0, size: 72, zones,
                history: D ? [] : (this.hist[k] || []).map(T),
                sub: why || ((isNum(pk) ? 'Max ' + Math.round(T(pk)) + U.tU + '  ·  ' : '') + 'from ' + x0.from),
            });
        };
        const hot = (warn, crit, cold) => [{ from: T(crit), to: 9999, color: 'crit' }, { from: T(warn), to: T(crit), color: 'warn' }].concat(cold != null ? [{ from: -999, to: T(cold), color: 'cold' }] : []);
        tile('oil', 'Engine oil', 488, 44, hot(130, 145, 70));
        tile('coolant', 'Coolant', 800, 44, hot(110, 118, 60));
        tile('gearbox', 'Gearbox oil', 488, 284, hot(110, 125, 50));
        // (intake air: 74 deg C parked in traffic is heat soak, not a fault - warn from 65, red from 80)
        tile('iat', 'Intake air', 800, 284, hot(65, 80));
        this.drawMisfires(cv, t, 1112, 44, 464, 300, D);
        this.drawFuel(cv, t, 1112, 356, 464, 156, D);
    }
    /** The car's tyres while fresh (signals.js L.tyres), else null. */
    tyres() { const L = this.values.live; return L.tyresT && this.now() - L.tyresT < 5 * 60000 ? L.tyres : null; }
    why(k) {
        if (this.link && !this.link.available) return 'Diagnostic link down';
        if (this.values.live.left) return 'Paused: car locked';
        if (!this.live(this.c[k]).length) return 'Not given by this car';
        return this.last[k] ? 'No reply' : 'Reading…';
    }
    /** Top-down car, each tyre's pressure against the car's target, its temperature under it (M Vitals' drawTyres). */
    drawTyres(cv, t, x, y, w, h, ty, U) {
        G.panel(cv, t, x, y, w, h, 'Tyres');
        const cx = x + w / 2, top = y + 64, bh = h - 84, bw = 104, dec = U.psi || U.kpa ? 0 : 1;
        cv.roundRect(cx - bw / 2, top, bw, bh, 40, withAlpha(t.track, 0.9));
        cv.strokeRoundRect(cx - bw / 2, top, bw, bh, 40, 3, t.tick);
        cv.roundRect(cx - bw / 2 + 14, top + bh * 0.24, bw - 28, 28, 10, withAlpha(t.tick, 0.45));
        cv.roundRect(cx - bw / 2 + 18, top + bh * 0.70, bw - 36, 22, 8, withAlpha(t.tick, 0.35));
        cv.text('FRONT', cx, top + 32, 18, t.dim, { align: 'center', font: 'bold', spacing: 1 });
        const tyw = 26, tyh = 72;
        [['FL', -1, top + 26], ['FR', 1, top + 26], ['RL', -1, top + bh - 26 - tyh], ['RR', 1, top + bh - 26 - tyh]].forEach(([k, side, tyY]) => {
            const v = (ty && ty[k]) || {}, pr = U.P(v.p), tgt = U.P(v.pt), temp = v.t;
            let pc = isNum(pr) ? t.text : t.dim;
            if (isNum(v.p) && isNum(v.pt) && v.pt > 0) { const r = v.p / v.pt; pc = r < 0.85 ? t.crit : r < 0.93 || r > 1.15 ? t.warn : GO; }
            const tc = !isNum(temp) ? t.tick : temp < 20 ? t.cold : temp > 105 ? t.crit : temp > 90 ? t.warn : t.accent;
            const tx0 = side < 0 ? cx - bw / 2 - tyw - 6 : cx + bw / 2 + 6;
            cv.roundRect(tx0, tyY, tyw, tyh, 8, tc);
            for (let i = 1; i < 4; i++) cv.fillRect(tx0 + 5, tyY + i * tyh / 4, tyw - 10, 2, withAlpha(t.bg, 0.35));
            const al = side < 0 ? 'right' : 'left', lx = side < 0 ? tx0 - 14 : tx0 + tyw + 14, py = tyY + 44;
            const uw = cv.textWidth(' ' + U.pU, 20);
            const pw = cv.text(isNum(pr) ? G.fmt(pr, dec) : '--', lx + (side < 0 ? -uw : 0), py, 48, pc, { align: al, font: 'num' });
            cv.text(' ' + U.pU, side < 0 ? lx : lx + pw, py, 20, t.dim, { align: al });
            cv.text(isNum(tgt) ? 'target ' + G.fmt(tgt, dec) : 'no target', lx, py + 26, 18, t.dim, { align: al });
            cv.text(isNum(temp) ? G.fmt(U.T(temp), 0) + U.tU : '--' + U.tU, lx, py + 56, 24, isNum(temp) ? tc : t.dim, { align: al, font: 'bold' });
        });
        if (!ty) cv.text('No tyre values from the car yet', cx, y + h - 14, 18, t.dim, { align: 'center' });
    }
    /** The total this drive, big and coloured, a cell per cylinder along the bottom (M Vitals' misfireTile). */
    drawMisfires(cv, t, x, y, w, h, D) {
        G.panel(cv, t, x, y, w, h, 'Misfires');
        if (!D && this.misGone) { cv.text(this.misGone, x + 18, y + 120, 20, t.dim); return; }
        const counts = D ? D.mis : this.shown(), n = D ? 6 : (this.mids ? this.mids.length : this.mis.cylinders);
        const ok = !!D || (this.misT > 0 && counts.some(isNum));
        const total = ok ? counts.reduce((a, c) => a + (isNum(c) ? c : 0), 0) : null;
        const col = !ok ? t.dim : total === 0 ? GO : total < MIS_WARN ? t.text : total < MIS_CRIT ? t.warn : t.crit;
        const tw = cv.text(ok ? String(total) : '--', x + 18, y + 128, 88, col, { font: 'num' });
        const avg = D ? [] : this.avg.filter(isNum);
        const sub = !ok ? (!this.mids ? 'Asking the engine unit…' : this.link && !this.link.available ? 'Diagnostic link down' : 'Reading…')
            : this.base ? 'since Reset' : 'this drive';
        cv.text(sub, x + 30 + tw, y + 128, 22, t.dim);
        if (avg.length) cv.text('10-drive average ' + avg.reduce((a, b) => a + b, 0), x + w - 18, y + 40, 18, t.dim, { align: 'right' });
        const gap = 8, cw = (w - 36 - gap * (n - 1)) / n, ch = 82, cy = y + h - 18 - ch;
        for (let i = 0; i < n; i++) {
            const c = counts[i], cx = x + 18 + i * (cw + gap), hit = isNum(c) && c >= MIS_CYL_WARN;
            cv.roundRect(cx, cy, cw, ch, 8, withAlpha(hit ? t.warn : t.track, hit ? 0.18 : 0.9));
            cv.text(String(i + 1), cx + cw / 2, cy + 28, 22, t.dim, { align: 'center', font: 'bold' });
            cv.text(isNum(c) ? String(c) : '-', cx + cw / 2, cy + ch - 12, 34, !isNum(c) ? t.dim : hit ? t.warn : t.text, { align: 'center', font: 'num' });
        }
    }
    /** Short and long term fuel trim (%), ignition advance (degrees), side by side. */
    drawFuel(cv, t, x, y, w, h, D) {
        G.panel(cv, t, x, y, w, h, 'Fuel trims & timing');
        const cw = (w - 36) / 3;
        [['stft', 'Short trim', '%'], ['ltft', 'Long trim', '%'], ['timing', 'Timing', '°']].forEach((c, i) => {
            const k = c[0], v = D ? D[k] : this.fuel(k), cx = x + 18 + i * cw, trim = k !== 'timing';
            const a = isNum(v) ? Math.abs(v) : 0, col = !isNum(v) ? t.dim : trim && a >= TRIM_CRIT ? t.crit : trim && a >= TRIM_WARN ? t.warn : t.text;
            cv.text(c[1], cx, y + 84, 18, t.dim, { font: 'bold' });
            const txt = !isNum(v) ? '--' : (trim && v > 0 ? '+' : '') + G.fmt(v, 1);
            cv.text(txt, cx, y + 138, 40, col, { font: 'num' });
            if (isNum(v)) cv.text(c[2], cx + cv.textWidth(txt, 40, { font: 'num' }) + 4, y + 138, 20, t.dim);
        });
        if (!D && !FUEL.some((k) => isNum(this.fuel(k)))) cv.text(FUEL.every((k) => !this.live(this.c[k]).length) ? 'Not given by this car' : this.why('stft'), x + w - 18, y + 40, 16, t.dim, { align: 'right' });
    }
}

/** A request the read-only link didn't send (kit/runtime/readonly-diag.js check()). */
const blocked = (raw) => !!(raw && !raw.bytes && /read-only:/.test(raw.why || ''));

/** A reply the unit refused as not supported: 7F <sid> 11 / 12 / 31. */
function refused(raw) {
    if (!raw || !raw.bytes) return false;
    const b = raw.bytes.split(' ').map((x) => parseInt(x, 16));
    return b[0] === 0x7f && [0x11, 0x12, 0x31].indexOf(b[2]) >= 0;
}

/** The demo's values (Combo's demo setting): a warm engine, no misfires. */
function demoValues(now) {
    const s = Math.sin(now / 9000);
    return { oil: 102 + 4 * s, coolant: 92 + 2 * s, gearbox: 81 + 3 * s, iat: 34 + 3 * s, stft: 1.6 * s, ltft: -2.3, timing: 14 + 4 * s, mis: [0, 0, 0, 0, 0, 0],
        tyres: { FL: { p: 2.3, t: 31, pt: 2.5 }, FR: { p: 2.3, t: 31, pt: 2.5 }, RL: { p: 2.5, t: 34, pt: 2.7 }, RR: { p: 2.6, t: 34, pt: 2.7 } } };
}

module.exports = { MView, refused };
