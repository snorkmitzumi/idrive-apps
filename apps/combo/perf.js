'use strict';
/**
 * perf.js - Combo's Performance tab: Virtual Dyno on the left half, Drag Timer on the right, on one screen, fed with
 * the values Combo already has (no signal subscribed twice). The sums are Virtual Dyno's and Drag Timer's
 * (apps/dyno/main.js, apps/draggy/main.js), copied so this app can be tuned on its own:
 *
 *   Dyno   accelerate hard (> 0.12 g) in one gear (rpm / speed steady) across 1500 rpm or more; when you lift the
 *          pull is a run: wheel power = m*a*v + air drag + rolling resistance, crank = wheel / (1 - drivetrain
 *          loss), torque = power / engine angular speed. The last 20 runs kept; one can be pinned as the baseline,
 *          drawn behind and compared with.
 *   Drag   stop -> READY, launch -> timed from the first movement (or one foot), splits interpolated between speed
 *          samples (kit/run_timer.js); the best time per split kept (one-foot rollout apart).
 * Saved in data/perf.json; demo runs are shown but never saved.
 *
 *   const p = new Perf({ settings, log, dataDir, engine })
 *   p.sample(d, tMs)     d = { rpm, speed (km/h), gLong (g), torque (Nm) }: a new value from the car
 *   p.speed(tMs, kmh)    a new speed: the drag timer        p.idle(tMs)   the clock (the timer arms when stopped 1 s)
 *   p.demo(on)           demo data on / off (a clean timer, the demo's own runs)
 *   p.draw(cv, t)        the tab        p.resetRun()  p.resetBest()  p.resetDyno()  p.baseline()
 */
const fs = require('fs');
const path = require('path');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { RunTimer } = require('./kit/run_timer');
const { writeWhole } = require('./store');

const BIN = 100, MIN_SPAN = 1500;
const CDA = { coupe: 0.62, wagon: 0.72, suv: 0.95 }, RHO = 1.2, CRR = 0.013;
const GO = '#2fd27a';
const MPH = 1.609344;
const SPLITS = {
    kmh: [{ key: '0-50', label: '0-50 km/h', from: 0, to: 50 }, { key: '0-100', label: '0-100 km/h', from: 0, to: 100 },
        { key: '100-200', label: '100-200 km/h', from: 100, to: 200 }, { key: '0-200', label: '0-200 km/h', from: 0, to: 200 }],
    mph: [{ key: '0-30mph', label: '0-30 mph', from: 0, to: 30 * MPH }, { key: '0-60mph', label: '0-60 mph', from: 0, to: 60 * MPH },
        { key: '60-130mph', label: '60-130 mph', from: 60 * MPH, to: 130 * MPH }, { key: '0-100mph', label: '0-100 mph', from: 0, to: 100 * MPH }],
};
const DIST = { qm: { key: 'qm', label: '1/4 mile', dist: 402.336 }, em: { key: 'em', label: '1/8 mile', dist: 201.168 }, m1000: { key: 'm1000', label: '1000 m', dist: 1000 } };
const STATE = { wait: ['STOP TO ARM', 'dim'], ready: ['READY - LAUNCH', 'go'], run: ['TIMING', 'accent'], done: ['FINISHED', 'text'] };
const PU = { hp: [745.7, 'hp'], ps: [735.5, 'PS'], kw: [1000, 'kW'] };
// torque: [factor from Nm, unit, decimals]
const TU = { nm: [1, 'Nm', 0], lbft: [0.73756, 'lb-ft', 0], kgm: [1 / 9.80665, 'kgm', 1] };

/** Demo: a launch from standing, through the gears to ~205 km/h, braking, standing (Drag Timer's 28 s lap, with rpm). */
class PerfDemo {
    constructor() { this.t0 = Date.now(); this.prev = null; }
    speed(now) {
        const t = ((now - this.t0) / 1000) % 28;
        if (t < 3) return 0;
        if (t < 17) return 262 * (1 - Math.exp(-(t - 3) / 9.4));
        const top = 262 * (1 - Math.exp(-14 / 9.4));
        return t < 23 ? Math.max(0, top * (1 - (t - 17) / 6)) : 0;
    }
    sample(now) {
        const v = this.speed(now), p = this.prev, dt = p ? (now - p.t) / 1000 : 0;
        const g = dt > 0 ? (v - p.v) / 3.6 / dt / 9.80665 : 0;
        // rpm per km/h by gear; up a gear at 6800 rpm
        const K = [110, 70, 48, 37, 30];
        let gear = 0;
        while (gear < K.length - 1 && v * K[gear] > 6800) gear++;
        const rpm = Math.max(900, v * K[gear]);
        const torque = g > 0.05 ? Math.round(560 * (1 - Math.pow((rpm - 3800) / 5200, 2))) : 40;
        this.prev = { t: now, v };
        return { rpm, speed: v, gLong: g, torque };
    }
}

class Perf {
    constructor(o) {
        this.settings = o.settings; this.log = o.log; this.engine = o.engine;
        this.file = o.dataDir ? path.join(o.dataDir, 'perf.json') : null;
        this.saved = { dyno: { runs: [], baseline: null }, drag: { best: {}, runs: [] } };
        try { const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); Object.assign(this.saved.dyno, s.dyno || {}); Object.assign(this.saved.drag, s.drag || {}); } catch (e) { /* first start */ }
        this.demoStore = { dyno: { runs: [], baseline: null }, drag: { best: {}, runs: [] } };
        this.isDemo = false;
        this.live = { power: null, state: 'idle', until: 0, rpm: null, gLong: null, speed: null };
        this.pull = null; this.lastT = 0; this.lastRun = null; this.cleared = false;
        this.peakG = 0; this.newBest = {};
        this.newTimer();
    }

    get store() { return this.isDemo ? this.demoStore : this.saved; }
    save() {
        if (this.isDemo || !this.file) return;
        try { writeWhole(this.file, JSON.stringify(this.saved)); } catch (e) { this.log.warn('perf: save: ' + e); }
    }

    /* ---------- drag timer ---------- */
    splits() { return SPLITS[this.settings.get('speedUnit')] .concat([DIST[this.settings.get('distance')] || DIST.qm]); }
    bestKey(k) { return k + (this.settings.get('rollout') ? '@ro' : ''); }
    newTimer() {
        this.peakG = 0; this.newBest = {};
        this.timer = new RunTimer(this.splits(), {
            rollout: this.settings.get('rollout'),
            onLaunch: () => { this.peakG = 0; this.newBest = {}; },
            onDone: (run) => {
                const st = this.store.drag;
                this.newBest = {};
                Object.keys(run.result).forEach((k) => {
                    const b = st.best[this.bestKey(k)];
                    if (!b || run.result[k] < b.s) { st.best[this.bestKey(k)] = { s: run.result[k], at: run.at, trap: run.trap[k] }; this.newBest[k] = true; }
                });
                st.runs.unshift(Object.assign({ unit: this.settings.get('speedUnit') }, run));
                st.runs = st.runs.slice(0, 30);
                this.save();
                this.log.info('drag run ' + JSON.stringify(run.result));
            },
        });
    }
    speed(t, kmh) {
        this.live.speed = kmh;
        this.timer.feed(t, kmh);
    }
    idle(t) { this.timer.idle(t); }
    demo(on) {
        on = !!on;
        if (on === this.isDemo) return;
        this.isDemo = on; this.pull = null; this.lastRun = null; this.cleared = false;
        this.live = { power: null, state: 'idle', until: 0, rpm: null, gLong: null, speed: null };
        this.newTimer();
    }
    resetRun() { this.timer.reset(); this.peakG = 0; this.newBest = {}; }
    resetBest() { const st = this.store.drag; st.best = {}; st.runs = []; this.save(); this.log.info('best times cleared'); }

    /* ---------- dyno ---------- */
    sample(d, t) {
        if (G.isNum(d.rpm)) this.live.rpm = d.rpm;
        if (G.isNum(d.gLong)) { this.live.gLong = d.gLong; if (this.timer.state === 'run') this.peakG = Math.max(this.peakG, d.gLong); }
        if (t - this.lastT < 40) return;
        if (!G.isNum(d.rpm) || !G.isNum(d.speed) || !G.isNum(d.gLong)) return;
        this.lastT = t;
        const s = this.settings, v = d.speed / 3.6, a = d.gLong * 9.80665;
        const m = s.get('weight'), cda = CDA[s.get('body')] || 0.65;
        const wheel = m * a * v + 0.5 * RHO * cda * v * v * v + CRR * m * 9.80665 * v;
        const crank = wheel / (1 - s.get('loss') / 100);
        const hard = d.gLong > 0.12 && d.speed > 15 && d.rpm > 1200;
        this.live.power = hard ? crank : null;
        if (hard) {
            if (!this.pull) { this.pull = { segs: [], start: Date.now() }; this.live.state = 'pull'; }
            const k = d.rpm / d.speed;
            let seg = this.pull.segs[this.pull.segs.length - 1];
            if (!seg || Math.abs(k - seg.k) / seg.k > 0.04) { seg = { k, pts: [] }; this.pull.segs.push(seg); }
            seg.k += (k - seg.k) * 0.1;
            seg.pts.push({ rpm: d.rpm, p: crank, v: d.speed, ecu: G.isNum(d.torque) ? d.torque : null });
            this.pull.lastHard = t;
        } else if (this.pull && t - this.pull.lastHard > 500) this.finishPull();
    }
    finishPull() {
        const p = this.pull; this.pull = null;
        if (!p) return;
        // the tallest gear that spans enough rpm: least wheelspin
        const best = p.segs.map((s) => {
            const r = s.pts.map((x) => x.rpm);
            return { s, span: r.length ? Math.max.apply(null, r) - Math.min.apply(null, r) : 0 };
        }).filter((x) => x.span >= MIN_SPAN && x.s.pts.length > 15).sort((a, b) => a.s.k - b.s.k)[0];
        if (!best) { this.live.state = 'short'; this.live.until = Date.now() + 4000; return; }
        const run = this.analyse(best.s.pts, p.start), st = this.store.dyno;
        st.runs.unshift(run); st.runs = st.runs.slice(0, 20);
        this.save();
        this.lastRun = run; this.cleared = false; this.live.state = 'done'; this.live.until = Date.now() + 6000;
        this.log.info('dyno run ' + Math.round(run.peakP / 745.7) + ' hp @' + run.peakPrpm + ', ' + Math.round(run.peakT) + ' Nm @' + run.peakTrpm);
    }
    /** Samples binned by rpm, smoothed, torque from power. */
    analyse(pts, start) {
        const bins = {};
        pts.forEach((x) => { const b = Math.round(x.rpm / BIN) * BIN; (bins[b] = bins[b] || []).push(x); });
        const raw = Object.keys(bins).map(Number).sort((a, b) => a - b).map((k) => {
            const e = bins[k].filter((x) => G.isNum(x.ecu));
            return { rpm: k, p: bins[k].reduce((a, x) => a + x.p, 0) / bins[k].length, ecu: e.length ? e.reduce((a, x) => a + x.ecu, 0) / e.length : null };
        });
        const curve = raw.map((c, i) => {
            const win = raw.slice(Math.max(0, i - 2), i + 3), p = win.reduce((a, x) => a + x.p, 0) / win.length;
            return { rpm: c.rpm, p: Math.max(0, p), t: Math.max(0, p / (c.rpm * Math.PI / 30)), ecu: c.ecu };
        });
        const pk = curve.reduce((a, c) => (c.p > a.p ? c : a), curve[0]), tk = curve.reduce((a, c) => (c.t > a.t ? c : a), curve[0]);
        return { at: start, curve, peakP: pk.p, peakPrpm: pk.rpm, peakT: tk.t, peakTrpm: tk.rpm,
            weight: this.settings.get('weight'), loss: this.settings.get('loss'), v0: pts[0].v, v1: pts[pts.length - 1].v };
    }
    current() {
        const st = this.store.dyno;
        return this.cleared ? null : this.lastRun && st.runs.indexOf(this.lastRun) >= 0 ? this.lastRun : st.runs[0] || null;
    }
    /** Pin the run shown as the baseline; pressed on the baseline itself, no baseline. */
    baseline() {
        const st = this.store.dyno, r = this.current();
        if (!r) return;
        st.baseline = st.baseline && st.baseline.at === r.at ? null : r;
        this.save();
        this.log.info(st.baseline ? 'baseline pinned' : 'baseline cleared');
    }
    /** The power and torque shown go blank until the next pull (saved runs stay). */
    resetDyno() { this.cleared = true; this.lastRun = null; }

    /* ---------- drawing ---------- */
    units() {
        const s = this.settings, pu = PU[s.get('powerUnit')] || PU.kw, tu = TU[s.get('torqueUnit')] || TU.nm, mph = s.get('speedUnit') === 'mph';
        return { pw: (w) => (G.isNum(w) ? w / pu[0] : null), pU: pu[1], tq: (nm) => (G.isNum(nm) ? nm * tu[0] : null), tU: tu[1], tDec: tu[2],
            V: (k) => (G.isNum(k) ? (mph ? k / MPH : k) : null), vU: mph ? 'mph' : 'km/h', mph };
    }

    draw(cv, t, opts) {
        opts = opts || {};
        this.drawDyno(cv, t, this.units(), opts);
        this.drawDrag(cv, t, this.units(), opts);
    }

    /** A label, a big number with its unit, a line under it; the change against the baseline right of it. */
    stat(cv, t, x, y, label, val, unit, sub, col, delta, dec) {
        dec = dec || 0;
        cv.text(label, x, y, 20, t.dim, { font: 'bold', spacing: 2 });
        const vw = cv.text(G.fmt(val, dec), x, y + 60, 64, G.isNum(val) ? col : t.dim, { font: 'num' });
        cv.text(unit, x + vw + 8, y + 60, 22, t.dim);
        if (sub) cv.text(sub, x, y + 88, 20, t.dim, { font: 'bold', spacing: 1 });
        if (G.isNum(delta) && Math.abs(delta) >= 0.5 / Math.pow(10, dec)) {
            cv.text((delta > 0 ? '+' : '') + delta.toFixed(dec), x + 300, y + 60, 28, delta > 0 ? GO : t.crit, { align: 'right', font: 'num' });
        }
    }

    drawDyno(cv, t, u, opts) {
        const st = this.store.dyno, cur = this.current(), base = st.baseline, now = Date.now();
        const sh = G.panel(cv, t, 24, 44, 764, 468, this.live.state === 'pull' ? 'Dyno - recording' : 'Dyno'), ex = sh.y + sh.h - G.BOTTOM;
        if (this.live.state === 'pull') cv.circle(196, 66, 8, Math.floor(now / 300) % 2 ? t.crit : withAlpha(t.crit, 0.3));
        else {
            G.button(cv, t, 788 - 20 - 120, 56, 120, 40, 'Reset', () => { this.resetDyno(); return opts.redraw && opts.redraw(); }, { key: 'dyno-reset', busy: !cur, confirm: true });
            G.button(cv, t, 788 - 20 - 120 - 12 - 160, 56, 160, 40, base && cur && base.at === cur.at ? 'Unpin' : 'Baseline',
                () => { this.baseline(); return opts.redraw && opts.redraw(); }, { key: 'dyno-base', busy: !cur, primary: !!(base && cur && base.at === cur.at) });
        }
        if (this.live.state === 'pull') {
            this.stat(cv, t, 48, 112, 'POWER NOW', u.pw(this.live.power), u.pU, G.fmt(this.live.rpm, 0) + ' rpm  ·  ' + G.fmt(this.live.gLong, 2) + ' g', t.accent);
            cv.text('keep it pinned...', 420, 172, 22, t.dim);
        } else {
            const vs = cur && base && cur !== base && cur.at !== base.at;
            this.stat(cv, t, 48, 112, 'POWER', cur ? u.pw(cur.peakP) : null, u.pU, cur ? '@ ' + cur.peakPrpm + ' RPM' : null, t.accent, vs ? u.pw(cur.peakP) - u.pw(base.peakP) : null);
            this.stat(cv, t, 420, 112, 'TORQUE', cur ? u.tq(cur.peakT) : null, u.tU, cur ? '@ ' + cur.peakTrpm + ' RPM' : null, t.accent2, vs ? u.tq(cur.peakT) - u.tq(base.peakT) : null, u.tDec);
        }
        this.plot(cv, t, u, 104, 254, 600, 194 + ex, [cur, base]);
        // the line under the graph: what the dyno is doing, else crank / wheel power and the baseline
        let msg = cur ? 'crank (' + cur.loss + ' % loss)  ·  wheels ' + Math.round(u.pw(cur.peakP * (1 - cur.loss / 100))) + ' ' + u.pU : 'waiting for a pull';
        let col = t.dim;
        if (this.live.state === 'done' && now < this.live.until) { msg = 'NEW RUN RECORDED'; col = GO; }
        if (this.live.state === 'short' && now < this.live.until) { msg = 'pull too short'; col = t.warn; }
        if (base) msg += '   ·   baseline ' + Math.round(u.pw(base.peakP)) + ' ' + u.pU;
        cv.text(msg, 48, 496 + ex, 18, col, { font: 'bold', spacing: 0.5 });
    }

    plot(cv, t, u, x, y, w, h, runs) {
        const rMin = 1000, rMax = this.engine ? this.engine.value('rpmScale', { diesel: 6000, petrol: 8000 }) : 8000;
        const all = runs.filter(Boolean).reduce((a, r) => a.concat(r.curve), []);
        const nice = (v, step) => Math.max(step, Math.ceil(v / step) * step);
        const pMax = nice(Math.max(150, ...all.map((c) => u.pw(c.p) * 1.12)), 50);
        const tMax = nice(Math.max(u.tU === 'kgm' ? 15 : 150, ...all.map((c) => Math.max(u.tq(c.t), u.tq(c.ecu) || 0) * 1.12)), u.tU === 'kgm' ? 5 : 50);
        const X = (r) => x + (G.clamp(r, rMin, rMax) - rMin) / (rMax - rMin) * w;
        const YP = (v) => y + h - (v / pMax) * h, YT = (v) => y + h - (v / tMax) * h;
        for (let i = 0; i <= 4; i++) {
            const yy = y + (i / 4) * h;
            cv.fillRect(x, yy, w, 1, withAlpha(t.tick, 0.3));
            cv.text(String(Math.round(pMax * (1 - i / 4))), x - 10, yy + 7, 18, t.accent, { align: 'right' });
            cv.text(String(Math.round(tMax * (1 - i / 4))), x + w + 10, yy + 7, 18, t.accent2);
        }
        for (let r = 1000; r <= rMax; r += 1000) {
            cv.fillRect(X(r), y, 1, h, withAlpha(t.tick, 0.2));
            cv.text(String(r / 1000), X(r), y + h + 22, 18, t.dim, { align: 'center' });
        }
        cv.text(u.pU.toUpperCase(), x - 10, y - 12, 18, t.accent, { align: 'right', font: 'bold', spacing: 1 });
        cv.text(u.tU.toUpperCase(), x + w + 10, y - 12, 18, t.accent2, { font: 'bold', spacing: 1 });
        cv.text('x1000 RPM', x + w, y - 12, 16, t.dim, { align: 'right', font: 'bold', spacing: 1 });
        const line = (run, key, Y, conv, c, width) => {
            const pts = run.curve.filter((p) => G.isNum(p[key])).map((p) => [X(p.rpm), Y(conv(p[key]))]);
            if (pts.length > 1) cv.polyline(pts, width, c);
            return pts;
        };
        const cur = runs[0], base = runs[1];
        if (base && (!cur || base.at !== cur.at)) {
            line(base, 'p', YP, u.pw, withAlpha(t.dim, 0.7), 2.5);
            line(base, 't', YT, u.tq, withAlpha(t.dim, 0.5), 2);
        }
        if (cur) {
            const pp = line(cur, 'p', YP, u.pw, t.accent, 4);
            if (pp.length > 1) cv.fillUnder(pp, y + h, withAlpha(t.accent, 0.12));
            line(cur, 't', YT, u.tq, t.accent2, 3);
            if (this.settings.get('ecuTorque')) line(cur, 'ecu', YT, u.tq, withAlpha(t.text, 0.55), 2);
            const pk = [X(cur.peakPrpm), YP(u.pw(cur.peakP))], tk = [X(cur.peakTrpm), YT(u.tq(cur.peakT))];
            cv.circle(pk[0], pk[1], 7, t.text); cv.circle(pk[0], pk[1], 4, t.accent);
            cv.circle(tk[0], tk[1], 7, t.text); cv.circle(tk[0], tk[1], 4, t.accent2);
        } else {
            cv.text('No pull yet', x + w / 2, y + h / 2 - 8, 28, t.dim, { align: 'center', font: 'bold' });
            cv.text('Full throttle in 3rd gear from ~2000 rpm to the limiter, on a flat road', x + w / 2, y + h / 2 + 24, 18, t.dim, { align: 'center' });
        }
    }

    drawDrag(cv, t, u, opts) {
        const tm = this.timer, now = Date.now(), st = this.store.drag;
        const sh = G.panel(cv, t, 812, 44, 764, 468, 'Drag timer' + (this.settings.get('rollout') ? ' (rollout)' : '')), ex = sh.y + sh.h - G.BOTTOM;
        G.button(cv, t, 1576 - 20 - 150, 56, 150, 40, 'Reset best', () => { this.resetBest(); return opts.redraw && opts.redraw(); }, { key: 'drag-best', confirm: true });
        G.button(cv, t, 1576 - 20 - 150 - 12 - 150, 56, 150, 40, 'Reset run', () => { this.resetRun(); return opts.redraw && opts.redraw(); }, { key: 'drag-reset', confirm: true });
        const [stTxt, stCol] = STATE[tm.state], col = stCol === 'go' ? GO : t[stCol];
        // speed (at the setting's rate, as Drag Timer) and the clock, left
        const sp = u.V(G.hold('perf-speed', this.live.speed, 1000 / (this.settings.get('speedRate') || 10)));
        cv.text(G.fmt(sp, 0), 1080, 212, 120, G.isNum(sp) ? t.text : t.dim, { align: 'right', font: 'num' });
        cv.text(u.vU, 1090, 212, 24, t.dim);
        const el = tm.elapsed(now), mid = Math.round(ex / 2);
        cv.text(G.isNum(el) ? el.toFixed(2) : '--.--', 1060, 324 + mid, 80, tm.state === 'run' ? t.text : tm.endAt !== undefined ? t.accent2 : t.dim, { align: 'right', font: 'num' });
        cv.text('s', 1070, 324 + mid, 28, t.dim);
        cv.roundRect(836, 352 + mid, 320, 44, 8, withAlpha(col, 0.18));
        if (tm.state === 'ready') cv.roundRect(836, 352 + mid, 320, 44, 8, withAlpha(GO, 0.35 + 0.25 * Math.sin(now / 160)));
        cv.text(stTxt, 996, 383 + mid, 24, col, { align: 'center', font: 'bold', spacing: 3 });
        cv.text('PEAK ' + (this.peakG > 0 ? this.peakG.toFixed(2) : '-.--') + ' g', 836, 496 + ex, 20, t.dim, { font: 'bold', spacing: 1 });
        if (G.isNum(this.live.rpm)) cv.text(Math.round(this.live.rpm) + ' rpm', 1156, 496 + ex, 20, t.dim, { align: 'right', font: 'bold', spacing: 1 });
        // the splits, right: this run, the best, the change
        cv.fillRect(1176, 112, 1, 384 + ex, withAlpha(t.tick, 0.35));
        const sp5 = this.splits(), rowH = (408 + ex) / sp5.length;
        sp5.forEach((s, i) => {
            const y = Math.round(104 + i * rowH), r = tm.result[s.key], b = st.best[this.bestKey(s.key)];
            cv.text(s.label, 1196, y + 18, 20, t.dim, { font: 'bold', spacing: 0.5 });
            cv.text(G.isNum(r) ? r.toFixed(2) : '--.--', 1524, y + 44, 40, G.isNum(r) ? t.text : withAlpha(t.dim, 0.6), { align: 'right', font: 'num' });
            cv.text('s', 1530, y + 44, 20, t.dim);
            let sub = b ? 'best ' + b.s.toFixed(2) : 'no best yet', subCol = t.dim;
            if (G.isNum(r) && this.newBest[s.key]) { sub = 'NEW BEST'; subCol = GO; } else if (G.isNum(r) && b) {
                const d = r - b.s; sub = (d >= 0 ? '+' : '') + d.toFixed(2) + ' vs ' + b.s.toFixed(2); subCol = d <= 0 ? GO : t.dim;
            }
            if (s.dist && G.isNum(tm.trapSpeed[s.key])) sub = '@ ' + Math.round(u.V(tm.trapSpeed[s.key])) + ' ' + u.vU + '  ' + sub;
            cv.text(sub, 1196, y + 44, 18, subCol, { font: 'label' });
            if (i < sp5.length - 1) cv.fillRect(1196, Math.round(104 + (i + 1) * rowH) - 12, 356, 1, withAlpha(t.tick, 0.3));
        });
    }
}

module.exports = { Perf, PerfDemo, SPLITS, DIST };
