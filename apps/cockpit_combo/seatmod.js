'use strict';
/**
 * seatmod.js - the front seats' modules read over the diagnostic link (reading only: UDS 22).
 *
 * BMW's seat modules (FAS_G11 driver, BFS_G11 passenger; their SGBD as the public EdiabasX reference lists it):
 *   22 D702  HALLZAEHLER   each axis's Hall counter, 8 x u16 (8192..57344): SLV SHV LNV SNV KHV STV LBV LKV
 *   22 D708  MOTOR         each motor's state, 8 x u8: 0 off, 1 plus, 2 minus, 3 not fitted / coded, 4 invalid
 *   22 D712  SCHALTER_SV   the seat's own switches, 16 x u8 (each axis plus, minus): 1 = pressed
 *   22 D704  INITIALISIERUNG_SITZ  first byte: 0 not initialised, 1 initialised, FF initialisation not OK
 * (2E D708 <motor> <STOP|PLUS|MINUS> <PWM %> drives a motor: sent only by seatmove.js, the seat memory.)
 *
 * Which units are seat modules: every unit is asked who it is (22 F1 50 to all), then 22 D702; the ones that answer
 * with the counters are seat modules (the address differs between cars). Each move is logged once it has settled ("seat 0x6D: SLV
 * 23011>23480 (+469 in 1.6 s)") and each change of the motors running ("seat 0x6D motors: SLV+"), so a car's log shows which axis is which and how far it moves.
 *
 *   const m = new SeatModules({ link, log, now, values, yieldTo })
 *   m.tick()          while the Seats tab shows: the next read when one is due
 *   m.state           'idle' | 'finding' | 'found' | 'none';  m.seats = [{ addr, index, pos, motor, sw, init, at }]
 */
const { hex } = require('./kit/diag');

const AXES = ['SLV', 'SHV', 'LNV', 'SNV', 'KHV', 'STV', 'LBV', 'LKV'];
const USUAL = [0x6D, 0x6E];
const POS = 0xD702, MOTOR = 0xD708, SWITCH = 0xD712, INIT = 0xD704;
const LO = 8192, HI = 57344, MOVED = 3, SETTLED_MS = 1200, TRIES = 4, RETRY_MS = 300, FAILED_AGAIN_MS = 5000;
const POLL_MS = 400, INIT_MS = 10000, FIND_AGAIN_MS = 60000, YIELD_MS = 600, YIELD_STEP = 50, LOG_MAX = 120;

const A = (a) => '0x' + hex(a);
const u16 = (b, i) => (b.length > i + 1 ? b[i] * 256 + b[i + 1] : null);
/** The reply's data after 62 <DID>, or null (a refusal, another reply, none). */
const data = (u, did) => (u && u[0] === 0x62 && u[1] === (did >> 8) && u[2] === (did & 0xFF) ? u.slice(3) : null);
/** D704: initialised (byte 0 is 1), and each fitted motor's learned end stops { plus, minus } (null: none / not plausible). */
const LIMITS_AT = 48, FITTED = 5;
function limitsOf(d) {
    if (!d || !d.length) return { init: null, limits: [] };
    const limits = [];
    for (let i = 0; i < FITTED; i++) {
        const plus = u16(d, LIMITS_AT + i * 4), minus = u16(d, LIMITS_AT + i * 4 + 2);
        limits.push(plus !== null && minus !== null && plus !== 0xFFFF && minus !== 0 && plus - minus >= 12 ? { plus, minus } : null);
    }
    return { init: d[0], limits };
}
/** D702's counters: an axis outside 8192..57344 has none (null). */
function positions(d) {
    return AXES.map((a, i) => { const v = u16(d, i * 2); return v !== null && v >= LO && v <= HI ? v : null; });
}

class SeatModules {
    constructor(o) {
        this.link = o.link; this.log = o.log; this.now = o.now || Date.now; this.values = o.values || { live: {} };
        this.yieldTo = o.yieldTo || null;
        this.state = 'idle'; this.why = null; this.seats = []; this.units = null;
        this.busy = false; this.last = 0; this.foundAt = 0; this.turn = 0; this.lines = 0;
    }

    tick() {
        const now = this.now();
        // (paused while seatmove.js drives a seat: it reads the positions itself, faster)
        if (this.busy || this.paused || !this.link || !this.link.available || this.values.live.left) return;
        if (this.state === 'idle' || (this.state === 'none' && now - this.foundAt >= FIND_AGAIN_MS)) return this.run(() => this.find());
        if (this.state === 'found' && now - this.last >= POLL_MS) { this.last = now; return this.run(() => this.poll()); }
        return undefined;
    }
    run(fn) {
        this.busy = true;
        const go = async () => {
            if (this.yieldTo) { const t0 = this.now(); while (this.yieldTo() && this.now() - t0 < YIELD_MS) await new Promise((r) => setTimeout(r, YIELD_STEP)); }
            return fn();
        };
        return go().catch((e) => {
            this.why = String(e && e.message || e); this.log.warn('seat modules: ' + this.why);
            // a search that failed part way (2.4.4 on a G26: one refused request left it "finding" for good): again soon
            if (this.state === 'finding') { this.state = 'none'; this.foundAt = this.now() - FIND_AGAIN_MS + FAILED_AGAIN_MS; }
        })
            .then(() => { this.busy = false; });
    }

    /**
     * One read, tried again when the transport refuses it now and then ("temporarily not accepted"): the reply or null.
     * A seat module the link marked silent (5 reads in a row without an answer: the car asleep, or a busy stretch) is
     * woken first - nothing else wakes it (2.6.6 on a G26: "No unit answered with seat positions" from then on).
     */
    async read(a, did) {
        if (this.link.silent && this.link.wake && this.link.silent(a)) this.link.wake(a);
        for (let i = 0; i < TRIES; i++) {
            try { return (await this.link.read(a, did, 800)) || null; } catch (e) { if (i === TRIES - 1) throw e; }
            await new Promise((r) => setTimeout(r, RETRY_MS));
        }
        return null;
    }
    /** Every unit asked who it is, then for its seat counters. */
    async find() {
        this.state = 'finding'; this.why = null;
        const units = await this.link.discover();
        this.foundAt = this.now();
        if (!units || !units.size) { this.state = 'none'; this.why = 'No unit answered (asked again in a minute)'; this.log.info('seat modules: no unit answered 22 F1 50'); return; }
        const list = Array.from(units.keys()).sort((a, b) => a - b);
        this.units = list;
        // the units in lines of 12 (a log line is kept short)
        for (let i = 0; i < list.length; i += 12) this.log.info('units: ' + list.slice(i, i + 12).map((a) => A(a) + (units.get(a) ? ' ' + units.get(a) : '')).join(', '));
        const seats = [];
        // the seat modules' usual addresses first (0x6D driver, 0x6E passenger on a G26): the others only when neither answers
        const first = list.filter((a) => USUAL.indexOf(a) >= 0), rest = list.filter((a) => USUAL.indexOf(a) < 0);
        for (const a of first.concat(rest)) {
            if (seats.length && first.indexOf(a) < 0) break;
            let u = null;
            try { u = await this.read(a, POS); } catch (e) { this.log.info('seat modules: ' + A(a) + ' not read (' + (e && e.message || e) + ')'); }
            const d = data(u, POS);
            if (d && d.length >= 16) seats.push({ addr: a, index: units.get(a) || '', pos: positions(d), motor: [], sw: [], init: null, at: this.now() });
        }
        this.seats = seats;
        this.state = seats.length ? 'found' : 'none';
        this.log.info('seat modules: ' + (seats.length ? seats.map((s) => A(s.addr) + (s.index ? ' (' + s.index + ')' : '') + ' ' + this.show(s.pos)).join('; ') : 'none answered 22 D702 (asked again in a minute)'));
        if (!seats.length) this.why = 'No unit answered with seat positions (22 D702)';
    }

    /** Search again from the start (the tab's Read again): the seat modules asked again, woken first. */
    again() { if (this.busy) return; this.state = 'idle'; this.why = null; }

    /** The next seat's counters, and in turn its motors, switches and initialisation. */
    async poll() {
        const s = this.seats[this.turn % this.seats.length];
        const step = Math.floor(this.turn / this.seats.length) % 2;
        this.turn++;
        // after one of seatmove.js's moves (s.quiet): from where the seat is now, that move not logged again
        const quiet = !!s.quiet;
        const d = data(await this.read(s.addr, POS), POS);
        if (d) { s.pos = positions(d); s.at = this.now(); if (quiet) { s.last = s.pos.slice(); s.from = s.pos.map(() => null); s.since = s.pos.map(() => 0); } else this.moved(s); }
        // the motors each round (which one runs, which way: an axis named by its own motor), the switches every other
        const m = data(await this.read(s.addr, MOTOR), MOTOR);
        if (m) { const was = this.running(s); s.motor = AXES.map((a, i) => (m.length > i ? m[i] : null)); const now = this.running(s); if (now !== was && !quiet) this.line('seat ' + A(s.addr) + ' motors: ' + (now || 'stopped')); }
        if (quiet && d) s.quiet = false;
        if (step === 1) {
            const w = data(await this.read(s.addr, SWITCH), SWITCH);
            if (w) { const was = s.sw; s.sw = AXES.map((a, i) => (w[i * 2] === 1 ? '+' : w[i * 2 + 1] === 1 ? '-' : '')); this.pressed(s, was); }
        }
        if (s.init === null || this.now() - (s.initAt || 0) >= INIT_MS) {
            const n = data(await this.read(s.addr, INIT), INIT);
            s.initAt = this.now();
            if (n && n.length >= LIMITS_AT + FITTED * 4) s.limits = limitsOf(n).limits;
            if (n && n.length) { if (s.init !== n[0]) this.log.info('seat ' + A(s.addr) + ': initialisation ' + ({ 0: 'not done', 1: 'OK', 255: 'not OK' }[n[0]] || hex(n[0]))); s.init = n[0]; }
        }
    }

    /**
     * A seat module at its usual address, without the search (easy entry when the Seats tab hasn't been open yet): the
     * unit asked for its counters; it joins the seats when it answers. Resolves with the seat, or null.
     */
    async adopt(addr) {
        const had = this.seats.find((s) => s.addr === addr);
        if (had) return had;
        if (!this.link || !this.link.available) return null;
        const d = data(await this.read(addr, POS).catch(() => null), POS);
        if (!d || d.length < 16) return null;
        const s = { addr, index: '', pos: positions(d), motor: [], sw: [], init: null, at: this.now() };
        this.seats.push(s);
        this.log.info('seat modules: ' + A(addr) + ' answered at its usual address ' + this.show(s.pos));
        return s;
    }

    /** The motors running now, e.g. 'SLV+ SNV-' ('' none). */
    running(s) { return AXES.map((a, i) => (s.motor[i] === 1 ? a + '+' : s.motor[i] === 2 ? a + '-' : null)).filter(Boolean).join(' '); }
    /** Each axis's move to the log once it has settled (SETTLED_MS without a change): where from, where to, how long. */
    moved(s) {
        const now = this.now();
        if (!s.from) { s.from = s.pos.map(() => null); s.since = s.pos.map(() => 0); s.last = s.pos.slice(); }
        AXES.forEach((a, i) => {
            const v = s.pos[i];
            if (v === null || s.last[i] === null) { s.last[i] = v; return; }
            if (Math.abs(v - s.last[i]) >= MOVED) { if (s.from[i] === null) { s.from[i] = s.last[i]; s.t0 = s.t0 || []; s.t0[i] = now; } s.since[i] = now; s.last[i] = v; }
            else if (s.from[i] !== null && now - s.since[i] >= SETTLED_MS) {
                this.line('seat ' + A(s.addr) + ': ' + a + ' ' + s.from[i] + '>' + v + ' (' + (v - s.from[i] > 0 ? '+' : '') + (v - s.from[i]) + ' in ' + ((s.since[i] - s.t0[i]) / 1000).toFixed(1) + ' s)');
                s.from[i] = null;
            }
        });
    }
    pressed(s, was) {
        const on = AXES.map((a, i) => (s.sw[i] && s.sw[i] !== (was && was[i]) ? a + s.sw[i] : null)).filter(Boolean);
        if (on.length) this.line('seat ' + A(s.addr) + ' switch: ' + on.join(' '));
    }
    line(m) { if (this.lines < LOG_MAX) { this.lines++; this.log.info(m); } }
    show(pos) { return AXES.map((a, i) => (pos[i] === null ? null : a + ' ' + pos[i])).filter(Boolean).join(' '); }
}

module.exports = { SeatModules, AXES, positions, limitsOf, LO, HI };
