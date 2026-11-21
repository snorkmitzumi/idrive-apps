'use strict';
/**
 * seats.js - Combo's Seats tab, stage 1: the driver seat's position, read from the car (reading only).
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
const { withAlpha } = require('./kit/canvas');
const { SeatModules, AXES: MOD_AXES, LO, HI } = require('./seatmod');

const IFACE = 'de.bmw.body.seat.SeatTargetAdjustment', INSTANCE = '1';
const DRIVER = 0, POLL_MS = 2000, CALL_MS = 3000;
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

/** An enum the binding hands back by name or number: its number (names: as the catalog lists them). */
const enumNo = (x, names) => (typeof x === 'number' ? x : names.indexOf(String(x).replace(/^AXIS/, '')));

class Seats {
    constructor(o) {
        this.signals = o.signals; this.log = o.log; this.now = o.now || Date.now; this.stepMs = o.stepMs || STEP_MS;
        this.state = { available: null, why: 'Not asked yet', axes: [], at: 0 };
        this.p = null; this.busy = false; this.last = 0; this.shapes = {};
        // the seat modules themselves over the diagnostic link (seatmod.js), when Combo has one
        this.modules = o.link ? new SeatModules({ link: o.link, log: o.log, now: this.now, values: o.values, yieldTo: o.yieldTo }) : null;
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
        cv.text('Reading only for now: each seat motor\'s position from the seat modules. Moving the seats comes next.', 1556, 80, 16, t.dim, { align: 'right' });
        const m = this.modules;
        if (m && m.state === 'found') m.seats.slice(0, 2).forEach((seat, i) => this.drawSeat(cv, t, seat, 44 + i * 772, 132, 740));
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
        cv.text(iface, 44, 492, 16, t.dim);
    }
    /** One seat module: an axis a row, its counter on a bar (8192..57344), moving / switch pressed beside it. */
    drawSeat(cv, t, seat, x, y, w) {
        const ok = seat.init === 1, initTxt = seat.init === null ? '' : ok ? 'initialised' : seat.init === 0 ? 'not initialised' : 'initialisation not OK';
        cv.text('Seat module 0x' + seat.addr.toString(16).toUpperCase() + (seat.index ? '  ' + seat.index : ''), x, y + 14, 22, t.text, { font: 'bold' });
        if (initTxt) cv.text(initTxt, x + w, y + 14, 16, ok ? t.dim : t.warn, { align: 'right' });
        const rows = MOD_AXES.map((a, i) => ({ a, i })).filter((r) => seat.pos[r.i] !== null || (seat.motor[r.i] !== undefined && seat.motor[r.i] !== 3 && seat.motor[r.i] !== null));
        const bx = x + 250, bw = w - 250 - 130;
        rows.forEach((r, k) => {
            const ry = y + 52 + k * 38, v = seat.pos[r.i], mv = seat.motor[r.i], sw = seat.sw[r.i];
            cv.text(NAMES[r.a] || r.a, x, ry + 6, 18, t.text);
            cv.text(r.a, x + 200, ry + 6, 14, t.dim);
            cv.roundRect(bx, ry - 4, bw, 12, 6, withAlpha(t.track || '#333333', 0.9));
            if (v !== null) { const f = (v - LO) / (HI - LO); cv.roundRect(bx + Math.max(0, Math.min(1, f)) * (bw - 12), ry - 6, 12, 16, 6, mv === 1 || mv === 2 ? t.warn : t.accent); }
            cv.text(v === null ? '--' : String(v), x + w - 40, ry + 6, 18, t.text, { align: 'right', font: 'num' });
            const mark = sw ? sw : mv === 1 ? '+' : mv === 2 ? '-' : '';
            if (mark) cv.text(mark, x + w, ry + 6, 20, t.warn, { align: 'right', font: 'bold' });
        });
    }

}

module.exports = { Seats, AXES, IFACE };
