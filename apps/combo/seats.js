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
    }

    /** While the tab shows: the position again every POLL_MS. */
    poll() {
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
        return (this.busy ? 'a step running, ' : '') + (s.available === true ? s.axes.length + ' motors' : s.available === false ? 'not available' : 'not read yet') + (s.why ? ': ' + s.why : '');
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
        G.panel(cv, t, 24, 44, 1552, 468, 'Driver seat');
        const s = this.state;
        cv.text('Reading only for now: the seat\'s position as the car reports it.', 44, 96, 20, t.dim);
        cv.text('Memory 1-3 and easy entry come in the next version, once your car\'s log shows these values.', 44, 124, 20, t.dim);
        if (s.available === false || !s.axes.length) {
            cv.text(s.available === false ? 'The car\'s seat interface is not available to apps:' : s.available === null ? 'Asking the car...' : 'No seat position yet:', 44, 190, 22, s.available === false ? t.warn : t.text, { font: 'bold' });
            if (s.why) cv.text(s.why, 44, 222, 18, t.dim);
            return;
        }
        s.axes.forEach((a, i) => {
            const x = 44 + (i % 2) * 760, y = 176 + Math.floor(i / 2) * 52;
            cv.text(a.name, x, y, 22, t.text, { font: 'bold' });
            cv.text(a.value === null ? '--' : String(a.value), x + 700, y, 24, t.text, { align: 'right', font: 'num' });
            cv.text(a.axis, x + 300, y, 16, t.dim);
        });
        if (s.why) cv.text(s.why, 44, 492, 18, t.warn);
        else cv.text('Updated ' + Math.max(0, Math.round((this.now() - s.at) / 1000)) + ' s ago', 44, 492, 16, t.dim);
    }
}

module.exports = { Seats, AXES, IFACE };
