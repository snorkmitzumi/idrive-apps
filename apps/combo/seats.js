'use strict';
/**
 * seats.js - Combo's Seats tab: both front seats' positions from their seat modules, and memory 1-3 and easy entry
 * (seatmove.js drives the motors: standing only, any seat switch stops it).
 *
 * BMW's own seat interface on the head unit (de.bmw.body.seat.SeatTargetAdjustment, from the unit's SOME/IP catalog):
 * getCurrentPosition(seat) -> each motor's position. Its setTargetPosition(seat, [axis, position]...) moves every
 * motor at once to a position (memory 1-3, easy entry), but takes a hashValue the catalog doesn't explain: it comes in
 * a later version, once a car's log has shown what the position reply looks like and that the car lets an app ask.
 *
 *   const s = new Seats({ signals, log, now })
 *   s.poll()             while the tab shows: a read every POLL_MS (one at a time)
 *   s.state              { available: null | true | false, why, axes: [{ axis, name, value, movement }], at }
 *   s.draw(cv, t)        the tab, under the host's tab bar
 */
const G = require('./kit/gauges');
const { withAlpha, mix } = require('./kit/canvas');
const { SeatModules, AXES: MOD_AXES, LO, HI } = require('./seatmod');
const { SeatMover } = require('./seatmove');

const IFACE = 'de.bmw.body.seat.SeatTargetAdjustment', INSTANCE = '1';
const DRIVER = 0, POLL_MS = 2000, CALL_MS = 3000;
const NUDGE_MS = 600;               // the controller pressed on an arrow: the motor this long
// a step that doesn't finish in this long is given up (2.3.1 on a G26: the tab opened three times, not one seat line
// in the log - a set-up or call that never came back); an interface the car doesn't offer: asked again after RETRY_MS
const STEP_MS = 8000, RETRY_MS = 30000;
/** p, or a rejection after ms (the native call itself can't be stopped: it is only no longer waited for). */
const within = (p, ms, what) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(what + ': no answer in ' + Math.round(ms / 1000) + ' s')), ms);
    if (t.unref) t.unref();
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});
// the seat's motors, by the catalog's SeatAxis numbers (German abbreviations as BMW names them)
const AXES = ['SLV', 'SNV', 'SHV', 'STV', 'LNV', 'LKV', 'LBV', 'KHV', 'KTV', 'FNV', 'MNV'];
const NAMES = { SLV: 'Forward / back', SNV: 'Seat tilt', SHV: 'Height', STV: 'Thigh support', LNV: 'Backrest angle',
    LKV: 'Upper backrest', LBV: 'Backrest width', KHV: 'Headrest height', KTV: 'Headrest depth', FNV: 'Footrest', MNV: 'MNV' };
const STATUS = { 0: 'CONDITION_NOT_CORRECT', 1: 'ERROR_HARDWARE', 2: 'OK' };

/** A closed outline with its corners rounded (Chaikin's corner cutting, twice). */
function smooth(pts) {
    let p = pts;
    for (let k = 0; k < 2; k++) {
        const q = [];
        p.forEach((a, i) => { const b = p[(i + 1) % p.length]; q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); });
        p = q;
    }
    return p;
}
/** An enum the binding hands back by name or number: its number (names: as the catalog lists them). */
const enumNo = (x, names) => (typeof x === 'number' ? x : names.indexOf(String(x).replace(/^AXIS/, '')));

class Seats {
    constructor(o) {
        this.signals = o.signals; this.log = o.log; this.now = o.now || Date.now; this.stepMs = o.stepMs || STEP_MS;
        this.state = { available: null, why: 'Not asked yet', axes: [], at: 0 };
        this.p = null; this.busy = false; this.last = 0; this.shapes = {};
        // the seat modules themselves over the diagnostic link (seatmod.js), when Combo has one
        this.modules = o.link ? new SeatModules({ link: o.link, log: o.log, now: this.now, values: o.values, yieldTo: o.yieldTo }) : null;
        // memory 1-3 and easy entry: with the link's seat writer only (kit/readonly-diag.js seatMotors)
        this.settings = o.settings || null; this.values = o.values || { live: {} };
        this.mover = this.modules && o.motor ? new SeatMover({ motor: o.motor, modules: this.modules, values: o.values, log: o.log, now: this.now, dataDir: o.dataDir }) : null;
        this.saving = null;          // { addr, until }: Save pressed, the next slot pressed takes the position
        this.holds = []; this.holding = null;
    }

    /** While the tab shows: the position again every POLL_MS. */
    poll() {
        if (this.modules) this.modules.tick();
        if (this.busy || this.state.available === false) return;
        if (this.now() - this.last < (this.offered === false ? RETRY_MS : POLL_MS)) return;
        this.last = this.now();
        this.read().catch((e) => this.log.warn('seats: ' + e));
    }

    async read() {
        this.busy = true;
        try {
            // each step to the log once (where it stops, when it does)
            if (!this.p) {
                this.step('asking the car for its seat interface (' + IFACE.split('.').pop() + ' ' + INSTANCE + ')');
                this.p = await within(Promise.resolve().then(() => this.signals.proxy(IFACE, INSTANCE)), this.stepMs, 'seat interface set-up');
                this.step('seat interface set up, offered by the car: ' + (this.p && this.p.isAvailable ? this.p.isAvailable() : 'unknown'));
            }
            // not offered (yet): no call (it would only wait), asked again after RETRY_MS
            if (this.p && this.p.isAvailable && !this.p.isAvailable()) {
                this.offered = false;
                this.state = Object.assign({}, this.state, { why: 'The car does not offer its seat interface to apps (asked again every 30 s)' });
                return;
            }
            this.offered = true;
            this.step('calling getCurrentPosition');
            const r = await within(this.signals.call(this.p, 'getCurrentPosition', { inSeatID: DRIVER }, CALL_MS), this.stepMs, 'getCurrentPosition');
            this.take(r);
        } catch (e) {
            const why = String(e && e.message || e);
            // the interface not in this app's config (the installer took it out: the car's catalog lacks it) or not
            // offered by the car: not asked again this run
            const gone = /not found|no such|unknown interface|not available|ENOENT|not a function/i.test(why);
            this.state = Object.assign({}, this.state, { available: gone ? false : this.state.available, why });
            if (this.state.why !== this._lastWhy) { this._lastWhy = this.state.why; this.log.warn('seats: ' + why); }
        } finally { this.busy = false; }
    }

    /** Read again (the tab's button): from the start, also after the car said no (its steps to the log again). */
    again() { if (this.busy) return; this.state = Object.assign({}, this.state, { available: null }); this.p = null; this.offered = undefined; this.last = 0; this.steps = {}; this._lastWhy = null; }

    /** Where it stands, for the log line of the tab opening. */
    summary() {
        const s = this.state;
        const m = this.modules, mods = m ? 'modules ' + (m.state === 'found' ? m.seats.map((x) => '0x' + x.addr.toString(16).toUpperCase()).join(' ') : m.state) + '; ' : '';
        return mods + (this.busy ? 'a step running, ' : '') + (s.available === true ? s.axes.length + ' motors' : s.available === false ? 'not available' : 'not read yet') + (s.why ? ': ' + s.why : '');
    }

    step(what) { if (!this.steps) this.steps = {}; if (!this.steps[what]) { this.steps[what] = true; this.log.info('seats: ' + what); } }

    /** The reply as the tab shows it; each new shape of it to the log (how the car numbers the positions). */
    take(r) {
        const shape = JSON.stringify(r, (k, v) => (k === 'axisPositionValue' ? 'n' : v));
        if (!this.shapes[shape]) { this.shapes[shape] = true; this.log.info('seats: getCurrentPosition -> ' + JSON.stringify(r)); }
        const st = r && r.statusResponse !== undefined ? (typeof r.statusResponse === 'number' ? STATUS[r.statusResponse] : String(r.statusResponse)) : null;
        const list = r && Array.isArray(r.seatAxisList) ? r.seatAxisList : [];
        const axes = list.map((a) => {
            const n = enumNo(a.seatAxis, AXES), axis = AXES[n] || String(a.seatAxis);
            return { axis, name: NAMES[axis] || axis, value: typeof a.axisPositionValue === 'number' ? a.axisPositionValue : null, movement: a.seatMovement };
        });
        this.state = { available: true, why: st === 'OK' || st === null ? (axes.length ? null : 'The car sent no seat motors') : st, axes, at: this.now() };
    }

    draw(cv, t) {
        G.panel(cv, t, 24, 44, 1552, 468, 'Seats');
        cv.text(this.mover ? 'Only while the car stands still. The seat\'s own switches stop any move.' : 'Reading only: each seat motor\'s position from the seat modules.', 1556, 80, 16, t.dim, { align: 'right' });
        const m = this.modules;
        this.holds = [];                 // the arrows drawn this frame, for touch()
        // (a seat module easy entry took at its usual address shows too, before the search)
        if (m && (m.state === 'found' || m.seats.length)) m.seats.slice(0, 2).forEach((seat, i) => this.drawSeat(cv, t, seat, 44 + i * 772, 118, 740));
        else if (this.state.available === true && this.state.axes.length) {
            // no seat module found, but BMW's interface answers: its positions
            this.state.axes.forEach((ax, i) => {
                const x = 44 + (i % 2) * 760, y = 176 + Math.floor(i / 2) * 52;
                cv.text(ax.name, x, y, 22, t.text, { font: 'bold' });
                cv.text(ax.value === null ? '--' : String(ax.value), x + 700, y, 24, t.text, { align: 'right', font: 'num' });
                cv.text(ax.axis, x + 300, y, 16, t.dim);
            });
        } else {
            const what = !m ? 'No diagnostic link' : m.state === 'finding' ? 'Asking every unit which ones are seat modules...'
                : m.state === 'none' ? (m.why || 'No seat module answered') : 'Waiting for the diagnostic link...';
            cv.text(what, 44, 190, 22, m && m.state === 'none' ? t.warn : t.text, { font: 'bold' });
        }
        // BMW's own seat interface on the head unit (SOME/IP): one line
        const s = this.state;
        const iface = s.available === true && s.axes.length ? 'BMW seat interface: ' + s.axes.length + ' motors' : s.available === false ? 'BMW seat interface: not available to apps' : 'BMW seat interface: ' + (s.why || 'asking');
        // (not with the seat modules found and memory under them: their notes take that line)
        if (!(this.mover && m && (m.state === 'found' || m.seats.length))) cv.text(iface, 44, 492, 16, t.dim);
    }
    /**
     * One seat: a side view of it (front to the left) whose parts follow the seat's positions on their learned travel,
     * a pair of arrows by each part (held: that motor moves, seatmove.js hold()), memory 1-3 / Save / Easy entry under it.
     */
    drawSeat(cv, t, seat, x, y, w) {
        const a = seat.addr, mv = this.mover, run = mv && mv.run;
        const name = a === 0x6D ? 'Driver seat' : a === 0x6E ? 'Passenger seat' : 'Seat 0x' + a.toString(16).toUpperCase();
        cv.text(name, x, y + 14, 22, t.text, { font: 'bold' });
        const no = mv ? mv.blocked(a) : null, last = mv && mv.last && mv.last.addr === a ? mv.last : null;
        const saving = this.saving && this.saving.addr === a && this.now() < this.saving.until;
        const note = seat.init !== null && seat.init !== 1 ? 'The seat is not initialised' : run && run.addr === a ? (run.slot === 'hold' ? 'Moving while you hold' : run.why)
            : run ? 'The other seat is moving' : saving ? 'Press 1, 2 or Easy entry to keep the seat\'s position there' : no || (last && last.why && last.why !== 'Let go' ? last.why
                : mv && this.easyEntry() && !mv.slots(a).E ? 'Save, then Easy entry: the seat moves there when its door opens' : mv ? 'Hold an arrow to move the seat' : '');
        cv.text(note, x, y + 40, 16, (run && run.addr === a) || saving || (last && !last.ok && !no && !run) || (seat.init !== null && seat.init !== 1) ? t.warn : t.dim);
        const cx = x + 340, fy = y + 306;
        this.drawPicture(cv, t, seat, cx, fy);
        if (mv && cv.own) {
            const can = !no && !run && seat.init === 1;
            const held = run && run.addr === a && run.slot === 'hold' ? run : null;
            const pair = (i, label, p1, p2, lx, ly, align) => {
                if (seat.motor[i] === 3) return;
                this.arrow(cv, t, seat, i, 1, p1, can, held);
                this.arrow(cv, t, seat, i, 2, p2, can, held);
                cv.text(label, lx, ly, 16, t.dim, { align: align || 'left' });
            };
            // plus is forward / up / upright / front up (a G26's switches, 2026-11-22: SLV SHV LNV KHV pressed in that order)
            pair(4, 'Headrest', [cx + 222, fy - 262, 'up'], [cx + 222, fy - 212, 'down'], cx + 254, fy - 231);
            pair(2, 'Backrest', [cx + 194, fy - 148, 'left'], [cx + 250, fy - 148, 'right'], cx + 282, fy - 142);
            pair(1, 'Height', [cx + 222, fy - 84, 'up'], [cx + 222, fy - 34, 'down'], cx + 254, fy - 53);
            pair(3, 'Tilt', [cx - 170, fy - 130, 'up'], [cx - 170, fy - 80, 'down'], cx - 202, fy - 99, 'right');
            pair(0, 'Fore / aft', [cx - 200, fy - 18, 'left'], [cx - 144, fy - 18, 'right'], cx - 232, fy - 12, 'right');
            this.drawMemory(cv, t, seat, x + 70, y + 326, w - 70);
        }
    }

    /** A round arrow button; held (touch): the motor runs until the finger lifts. The controller's press: a short nudge. */
    arrow(cv, t, seat, i, dir, p, can, held) {
        const [bx, by, way] = p, R = 24, on = held && held.axis === i && held.dir === dir;
        cv.circle(bx, by, R, on ? withAlpha(t.warn, 0.9) : withAlpha('#ffffff', can ? 0.1 : 0.04));
        cv.arc(bx, by, R - 1.5, R, 0, 360, withAlpha('#ffffff', can || on ? 0.35 : 0.12));
        const k = 8, c = on ? '#ffffff' : can ? t.text : withAlpha('#ffffff', 0.25);
        const tri = { up: [[bx - k, by + k * 0.5], [bx + k, by + k * 0.5], [bx, by - k * 0.7]], down: [[bx - k, by - k * 0.5], [bx + k, by - k * 0.5], [bx, by + k * 0.7]],
            left: [[bx + k * 0.5, by - k], [bx + k * 0.5, by + k], [bx - k * 0.7, by]], right: [[bx - k * 0.5, by - k], [bx - k * 0.5, by + k], [bx + k * 0.7, by]] }[way];
        cv.fill(tri, c);
        this.holds.push({ x: bx, y: by, r: R + 8, addr: seat.addr, axis: i, dir });
        if (can) cv.target(bx - R, by - R, 2 * R, 2 * R, () => this.nudge(seat.addr, i, dir), 'seat-' + seat.addr + '-' + MOD_AXES[i] + (dir === 1 ? '+' : '-'));
    }

    /** The seat drawn from the side, front to the left (a sport seat's outline, smoothed); a part whose motor runs in the warning colour. */
    drawPicture(cv, t, seat, cx, fy) {
        const f = (i) => {
            const v = seat.pos[i], l = seat.limits && seat.limits[i];
            return v === null || v === undefined || !l ? 0.5 : Math.max(0, Math.min(1, (v - l.minus) / (l.plus - l.minus)));
        };
        const runs = (i) => seat.motor[i] === 1 || seat.motor[i] === 2;
        const bg = t.bg || '#000000';
        const body = mix(bg, '#ffffff', 0.2), face = mix(bg, '#ffffff', 0.27), edge = mix(bg, '#ffffff', 0.42), dark = mix(bg, '#ffffff', 0.1);
        const hot = mix(bg, t.warn, 0.7), hotFace = mix(bg, t.warn, 0.9);
        const part = (i, pts, inner) => {
            const o = smooth(pts);
            cv.fill(o, runs(i) ? hot : body);
            if (inner) cv.fill(smooth(inner), runs(i) ? hotFace : face);
            cv.stroke(o.concat([o[0]]), 1.5, runs(i) ? hotFace : edge);
        };
        const dx = -(f(0) - 0.5) * 50, dy = -(f(1) - 0.5) * 24, tilt = (f(3) - 0.5) * 16;
        const yC = fy - 64 + dy, Fx = cx - 116 + dx, Rx = cx + 58 + dx;
        // the rail (fixed), the frame under the cushion (up and down with the height)
        cv.roundRect(cx - 130, fy - 9, 250, 9, 4.5, runs(0) ? hot : dark);
        cv.fill([[cx - 70 + dx, fy - 9], [cx + 52 + dx, fy - 9], [cx + 40 + dx, yC + 2], [cx - 58 + dx, yC + 2]], runs(1) ? hot : dark);
        // the backrest about its pivot behind the cushion: upright at the plus end, reclined at the minus end (drawn up to 34 degrees)
        const ang = (6 + (1 - f(2)) * 28) * Math.PI / 180, u = [Math.sin(ang), -Math.cos(ang)], n = [Math.cos(ang), Math.sin(ang)];
        const P = [Rx - 12, yC - 12], at = (d, sx) => [P[0] + u[0] * d + n[0] * sx, P[1] + u[1] * d + n[1] * sx];
        const L = 150;
        // the headrest on two posts first (behind the backrest's top)
        const hr = L + 30 + f(4) * 24;
        [-4, 10].forEach((sx) => { const p0 = at(L - 8, sx), p1 = at(hr - 14, sx); cv.line(p0[0], p0[1], p1[0], p1[1], 3, runs(4) ? hot : edge); });
        part(4, [at(hr - 16, -16), at(hr - 18, 18), at(hr + 14, 22), at(hr + 26, 8), at(hr + 22, -14), at(hr + 8, -20)],
            [at(hr - 10, -11), at(hr - 11, 8), at(hr + 14, 10), at(hr + 18, -10)]);
        // the backrest: lumbar and shoulder bolsters at the front (left), straight back
        part(2, [at(-4, -18), at(22, -27), at(60, -24), at(96, -15), at(126, -17), at(L, -12), at(L + 6, 4), at(L - 2, 20), at(100, 28), at(40, 32), at(0, 30)],
            [at(14, -18), at(58, -16), at(118, -9), at(L - 6, -4), at(L - 10, 8), at(60, 12), at(14, 10)]);
        // the cushion over the backrest's foot: its front raised by the tilt, a thigh bolster at the front
        part(3, [[Fx - 2, yC - 22 - tilt], [Fx + 10, yC - 33 - tilt], [Fx + 70, yC - 30 - tilt * 0.6], [Rx - 6, yC - 26], [Rx + 8, yC - 12], [Rx, yC + 4], [Fx + 40, yC + 4 - tilt * 0.3], [Fx + 6, yC - 4 - tilt * 0.8]],
            [[Fx + 16, yC - 24 - tilt], [Fx + 70, yC - 22 - tilt * 0.6], [Rx - 12, yC - 18], [Rx - 14, yC - 8], [Fx + 60, yC - 6 - tilt * 0.5], [Fx + 18, yC - 10 - tilt * 0.8]]);
    }

    /** The controller's press on an arrow: the motor for a moment (touch holds it instead). */
    nudge(addr, i, dir) {
        if (!this.mover || this.mover.run) return null;
        this.mover.hold(addr, i, dir).catch((e) => this.log.warn('seat: ' + e));
        setTimeout(() => this.mover.release(), NUDGE_MS);
        return null;
    }

    /** A touch (ctx.onTouch): down on an arrow holds its motor (true: the whole gesture is the seat's), moved off it or up lets go. */
    touch(phase, x, y) {
        if (phase === 1) {
            const h = this.holds.find((b) => (x - b.x) * (x - b.x) + (y - b.y) * (y - b.y) <= b.r * b.r);
            if (!h || !this.mover || this.mover.run || this.mover.blocked(h.addr)) return false;
            this.holding = h;
            this.mover.hold(h.addr, h.axis, h.dir).catch((e) => this.log.warn('seat: ' + e));
            return true;
        }
        const h = this.holding;
        if (!h) return false;
        const off = (x - h.x) * (x - h.x) + (y - h.y) * (y - h.y) > (h.r + 30) * (h.r + 30);
        if (phase === 3 || off) { this.holding = null; this.mover.release(); }
        return true;
    }

    /** Memory 1 and 2, Easy entry (its position: Save, then Easy entry), Back after it, Save; while this seat goes to a position: Stop. */
    drawMemory(cv, t, seat, x, y, w) {
        const mv = this.mover, a = seat.addr, slots = mv.slots(a), run = mv.run, H = 46;
        const saving = this.saving && this.saving.addr === a && this.now() < this.saving.until;
        if (run && run.addr === a && run.slot !== 'hold') {
            G.button(cv, t, x, y, w - 70, H, 'Stop', () => { mv.stop('Stopped'); return null; }, { key: 'seat-stop-' + a, primary: true, color: t.crit });
            return;
        }
        const no = mv.blocked(a) || (run ? 'busy' : null);
        const go = (slot) => () => {
            if (this.saving && this.saving.addr === a && this.now() < this.saving.until) { this.saving = null; mv.save(a, slot).catch((e) => this.log.warn('seat save: ' + e)); return null; }
            mv.recall(a, slot).catch((e) => this.log.warn('seat recall: ' + e));
            return null;
        };
        let bx = x;
        ['1', '2', 'E'].forEach((k) => {
            const e = k === 'E';
            bx += G.button(cv, t, bx, y, e ? 190 : 80, H, e ? 'Easy entry' : k, go(k), { key: 'seat-' + a + '-' + k, primary: saving, busy: !saving && (!slots[k] || !!no) }) + 12;
        });
        // after easy entry: back to where the seat was (also by itself once the engine starts)
        if (mv.entered(a) && !saving) bx += G.button(cv, t, bx, y, 130, H, 'Back', () => { mv.back(a).catch((e) => this.log.warn('seat back: ' + e)); return null; }, { key: 'seat-' + a + '-back', busy: !!no }) + 12;
        G.button(cv, t, bx, y, 130, H, saving ? 'Cancel' : 'Save', () => { this.saving = saving ? null : { addr: a, until: this.now() + 8000 }; return null; },
            { key: 'seat-' + a + '-save', color: saving ? t.warn : undefined, busy: !!run });
    }

    /** Setting easyEntry (on unless switched off): a front door opened moves its seat to its easy entry position. */
    easyEntry() { return !this.settings || this.settings.get('easyEntry') !== false; }

    /**
     * The doors open now (DoorsWindowsRoofMirrors, as the ambient light reads them): a front door that just opened takes
     * its seat to its easy entry position while the engine is off.
     */
    doors(open) {
        // (the first report, as Combo starts: a door open already then did not just open)
        const first = this.open === undefined, was = this.open || [];
        this.open = open || [];
        if (first) return;
        if (!this.mover || !this.easyEntry() || this.engineOn()) return;
        [['driver front', 0x6D], ['passenger front', 0x6E]].forEach(([d, a]) => {
            if (this.open.indexOf(d) < 0 || was.indexOf(d) >= 0) return;
            this.entryQueue = (this.entryQueue || Promise.resolve()).then(() => this.mover.entry(a)).catch((e) => this.log.warn('easy entry: ' + e));
        });
    }
    engineOn() { const L = this.values && this.values.live || {}; return typeof L.rpm === 'number' && L.rpm > 300 && this.now() - (L.rpmT || 0) < 3000; }
    /** Each half second (main.js): the engine started after easy entry - the seats back to where they were. */
    watchEngine() {
        const on = this.engineOn(), was = this.wasOn;
        this.wasOn = on;
        if (!this.mover || !on || was) return;
        [0x6D, 0x6E].forEach((a) => {
            if (!this.mover.entered(a)) return;
            this.entryQueue = (this.entryQueue || Promise.resolve()).then(() => this.mover.back(a)).catch((e) => this.log.warn('easy entry back: ' + e));
        });
    }

}

module.exports = { Seats, AXES, IFACE };
