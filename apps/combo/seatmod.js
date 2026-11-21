'use strict';
/**
 * seatmod.js - the front seats' modules read over the diagnostic link (reading only: UDS 22).
 *
 * BMW's seat modules (FAS_G11 driver, BFS_G11 passenger; their SGBD as the public EdiabasX reference lists it):
 *   22 D702  HALLZAEHLER   each axis's Hall counter, 8 x u16 (8192..57344): SLV SHV LNV SNV KHV STV LBV LKV
 *   22 D708  MOTOR         each motor's state, 8 x u8: 0 off, 1 plus, 2 minus, 3 not fitted / coded, 4 invalid
 *   22 D712  SCHALTER_SV   the seat's own switches, 16 x u8 (each axis plus, minus): 1 = pressed
 *   22 D704  INITIALISIERUNG_SITZ  first byte: 0 not initialised, 1 initialised, FF initialisation not OK
 * (2E D708 <motor> <STOP|PLUS|MINUS> <PWM %> drives a motor: not sent - this link only reads.)
 *
 * Which units are seat modules: every unit is asked who it is (22 F1 50 to all), then 22 D702; the ones that answer
 * with the counters are seat modules (the address differs between cars). Each move is logged ("seat 0x6D: SLV
 * 23011>23480"), so a car's log shows which axis is which and how far it moves.
 *
 *   const m = new SeatModules({ link, log, now, values, yieldTo })
 *   m.tick()          while the Seats tab shows: the next read when one is due
 *   m.state           'idle' | 'finding' | 'found' | 'none';  m.seats = [{ addr, index, pos, motor, sw, init, at }]
 */
const { hex } = require('./kit/diag');

const AXES = ['SLV', 'SHV', 'LNV', 'SNV', 'KHV', 'STV', 'LBV', 'LKV'];
const POS = 0xD702, MOTOR = 0xD708, SWITCH = 0xD712, INIT = 0xD704;
const LO = 8192, HI = 57344, MOVED = 20;
const POLL_MS = 400, INIT_MS = 10000, FIND_AGAIN_MS = 60000, YIELD_MS = 600, YIELD_STEP = 50, LOG_MAX = 120;

const A = (a) => '0x' + hex(a);
const u16 = (b, i) => (b.length > i + 1 ? b[i] * 256 + b[i + 1] : null);
/** The reply's data after 62 <DID>, or null (a refusal, another reply, none). */
const data = (u, did) => (u && u[0] === 0x62 && u[1] === (did >> 8) && u[2] === (did & 0xFF) ? u.slice(3) : null);
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
        if (this.busy || !this.link || !this.link.available || this.values.live.left) return;
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
        return go().catch((e) => { this.why = String(e && e.message || e); this.log.warn('seat modules: ' + this.why); })
            .then(() => { this.busy = false; });
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
        for (const a of list) {
            const u = await this.link.read(a, POS, 800);
            const d = data(u, POS);
            if (d && d.length >= 16) seats.push({ addr: a, index: units.get(a) || '', pos: positions(d), motor: [], sw: [], init: null, at: this.now(), logged: positions(d), loggedAt: 0 });
        }
        this.seats = seats;
        this.state = seats.length ? 'found' : 'none';
        this.log.info('seat modules: ' + (seats.length ? seats.map((s) => A(s.addr) + (s.index ? ' (' + s.index + ')' : '') + ' ' + this.show(s.pos)).join('; ') : 'none answered 22 D702 (asked again in a minute)'));
        if (!seats.length) this.why = 'No unit answered with seat positions (22 D702)';
    }

    /** The next seat's counters, and in turn its motors, switches and initialisation. */
    async poll() {
        const s = this.seats[this.turn % this.seats.length];
        const step = Math.floor(this.turn / this.seats.length) % 3;
        this.turn++;
        const d = data(await this.link.read(s.addr, POS, 800), POS);
        if (d) { s.pos = positions(d); s.at = this.now(); this.moved(s); }
        if (step === 1) { const m = data(await this.link.read(s.addr, MOTOR, 800), MOTOR); if (m) s.motor = AXES.map((a, i) => (m.length > i ? m[i] : null)); }
        if (step === 2) {
            const w = data(await this.link.read(s.addr, SWITCH, 800), SWITCH);
            if (w) { const was = s.sw; s.sw = AXES.map((a, i) => (w[i * 2] === 1 ? '+' : w[i * 2 + 1] === 1 ? '-' : '')); this.pressed(s, was); }
        }
        if (s.init === null || this.now() - (s.initAt || 0) >= INIT_MS) {
            const n = data(await this.link.read(s.addr, INIT, 800), INIT);
            s.initAt = this.now();
            if (n && n.length) { if (s.init !== n[0]) this.log.info('seat ' + A(s.addr) + ': initialisation ' + ({ 0: 'not done', 1: 'OK', 255: 'not OK' }[n[0]] || hex(n[0]))); s.init = n[0]; }
        }
    }

    /** A move to the log once it has gone MOVED counts and 2 s since the last line of that seat. */
    moved(s) {
        const ch = AXES.map((a, i) => (s.pos[i] !== null && s.logged[i] !== null && Math.abs(s.pos[i] - s.logged[i]) >= MOVED ? a + ' ' + s.logged[i] + '>' + s.pos[i] : null)).filter(Boolean);
        if (!ch.length || this.now() - s.loggedAt < 2000) return;
        this.line('seat ' + A(s.addr) + ': ' + ch.join(' '));
        s.logged = s.pos.slice(); s.loggedAt = this.now();
    }
    pressed(s, was) {
        const on = AXES.map((a, i) => (s.sw[i] && s.sw[i] !== (was && was[i]) ? a + s.sw[i] : null)).filter(Boolean);
        if (on.length) this.line('seat ' + A(s.addr) + ' switch: ' + on.join(' '));
    }
    line(m) { if (this.lines < LOG_MAX) { this.lines++; this.log.info(m); } }
    show(pos) { return AXES.map((a, i) => (pos[i] === null ? null : a + ' ' + pos[i])).filter(Boolean).join(' '); }
}

module.exports = { SeatModules, AXES, positions, LO, HI };
