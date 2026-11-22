'use strict';
/**
 * seatmove.js - seat memory 1-3 and easy entry: a front seat driven to a stored position by its own motors.
 *
 * The one write Combo sends (kit/readonly-diag.js seatMotors(): nothing else gets through), as ISTA does it on a G26
 * (its trace, 2026-11-22): 2E D7 08 <motor> <action> 64 to 0x6D / 0x6E, no session, no security access, no tester
 * present; the module answers 6E D7 08 and the motor runs until a STOP (00) comes. So every motor started here is
 * stopped here: when it is at its target, on every way out (a seat switch, the car rolling, a read that fails, a
 * motor that doesn't move, too long), and once more on the way out of a run.
 *
 * Reads (22): D702 the Hall counters (position), D708 each motor's state (00 off, 01 plus, 02 minus, 03 not fitted:
 * a move made with the seat's own switches or memory buttons shows there too), D712 the seat switches, D704 the
 * initialisation (byte 0: 1 = initialised) and the learned end stops (from byte 48: plus, minus as u16, per motor).
 *
 * The rules:
 *   - only standing (speed known and at most MAX_KMH), the car not locked and left, the seat initialised, its end
 *     stops plausible, no motor running when it starts
 *   - each target kept MARGIN counts inside the learned end stops
 *   - at most two motors at once, in the module's own recall order (fore / aft with the backrest, then tilt, height,
 *     headrest); a motor is stopped LEAD_S of its speed before the target (it coasts ~1 count), corrected PASSES times
 *   - a seat switch or a motor this run didn't start (the driver's own) ends the run at once: their switches win
 *
 *   const m = new SeatMover({ motor, modules, values, log, now, sleep, dataDir })
 *   m.recall(addr, slot)     slot '1' '2' '3' or 'E' (easy entry: the position before it is kept as 'R', back with recall(addr, 'R'))
 *   m.save(addr, slot)       the seat's position now into a slot
 *   m.stop()                 the run ends (its motors stopped)
 *   m.run                    null, or { addr, slot, why, done } while it goes;  m.last: how the last one ended
 *   m.slots(addr)            { '1': [5 counters] | undefined, ... }
 */
const fs = require('fs');
const path = require('path');
const { hex } = require('./kit/diag');
const { AXES } = require('./seatmod');
const { writeWhole } = require('./store');

const POS = 0xD702, MOTOR = 0xD708, SWITCH = 0xD712, INIT = 0xD704;
const STOP = 0, PLUS = 1, MINUS = 2, PWM = 100;
const FITTED = 5;                    // SLV SHV LNV SNV KHV: the motors a G26's seats have (STV LBV LKV: 03, not fitted)
const ORDER = [0, 2, 3, 1, 4];       // SLV, LNV, SNV, SHV, KHV: the module's own recall order (two at once)
const AT_ONCE = 2;
const TOL = 4;                       // counts: at the target
const MARGIN = 3;                    // counts kept from a learned end stop (a G26 memory position was 6 from one)
const LIMITS_AT = 48;                // D704: the end stops from this data byte
const LEAD_S = 0.12;                 // a motor stopped this many seconds of its speed before the target
const PASSES = 3;                    // corrections of an axis that stopped short or went past
const START_MS = 1200;               // a motor that hasn't moved MOVED counts by then: something holds it
const MOVED = 3;
const SLOWEST = 20;                  // counts / s, for the time allowed (measured 38-80 on a G26)
const MAX_RUN_MS = 25000;
const MAX_KMH = 2;
const MISSES = 3;                    // reads in a row without an answer: the run ends
const TICK_MS = 40;                  // at least this between two rounds of reads
const SWITCH_EVERY = 3;              // D712 every third round (D708 every round shows a switch's motor anyway)
const SETTLE_MS = 300;
const RECENT_MS = 600;               // a motor stopped this long ago may still read as running
const SLOTS = ['1', '2', '3', 'E', 'R'];

const A = (a) => '0x' + hex(a);
const u16 = (b, i) => (b && b.length > i + 1 ? b[i] * 256 + b[i + 1] : null);
const data = (u, did) => (u && u[0] === 0x62 && u[1] === (did >> 8) && u[2] === (did & 0xFF) ? u.slice(3) : null);

/** D704: initialised (byte 0 is 1), and each fitted motor's learned end stops { plus, minus } (null: none / not plausible). */
function limitsOf(d) {
    if (!d || !d.length) return { init: null, limits: [] };
    const limits = [];
    for (let i = 0; i < FITTED; i++) {
        const plus = u16(d, LIMITS_AT + i * 4), minus = u16(d, LIMITS_AT + i * 4 + 2);
        limits.push(plus !== null && minus !== null && plus !== 0xFFFF && minus !== 0 && plus - minus >= 4 * MARGIN ? { plus, minus } : null);
    }
    return { init: d[0], limits };
}

class SeatMover {
    constructor(o) {
        this.motor = o.motor; this.modules = o.modules; this.values = o.values || { live: {} }; this.log = o.log;
        this.now = o.now || Date.now; this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.file = o.dataDir ? path.join(o.dataDir, 'seatmem.json') : null;
        this.mem = {};
        try { this.mem = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch (e) { /* none saved yet */ }
        this.run = null; this.last = null;
    }

    slots(addr) { return this.mem[hex(addr)] || {}; }
    seat(addr) { return this.modules && this.modules.seats.find((s) => s.addr === addr) || null; }

    /** Why a move can't start now (null: it can). */
    blocked(addr) {
        const L = this.values.live;
        if (!this.motor) return 'No diagnostic link';
        if (L.left) return 'The car is locked';
        if (typeof L.speed !== 'number') return 'No speed from the car yet';
        if (L.speed > MAX_KMH) return 'Only while the car stands still';
        const s = this.seat(addr);
        if (!s) return 'Seat module not found';
        if (s.init !== null && s.init !== 1) return 'The seat is not initialised';
        return null;
    }

    /** The seat's position now into a slot (from a fresh read). */
    async save(addr, slot) {
        if (SLOTS.indexOf(slot) < 0 || this.run) return false;
        const d = data(await this.modules.read(addr, POS), POS);
        if (!d || d.length < FITTED * 2) { this.last = { addr, slot, ok: false, why: 'Position not read' }; return false; }
        const pos = [];
        for (let i = 0; i < FITTED; i++) pos.push(u16(d, i * 2));
        const k = hex(addr);
        this.mem[k] = Object.assign({}, this.mem[k], { [slot]: pos });
        this.write();
        this.log.info('seat ' + A(addr) + ': ' + this.name(slot) + ' saved: ' + pos.map((v, i) => AXES[i] + ' ' + v).join(' '));
        this.last = { addr, slot, ok: true, why: this.name(slot) + ' saved', saved: true };
        return true;
    }
    write() { if (this.file) { try { writeWhole(this.file, JSON.stringify(this.mem)); } catch (e) { this.log.warn('seat memory not written: ' + e.message); } } }
    name(slot) { return slot === 'E' ? 'Easy entry' : slot === 'R' ? 'Driving position' : 'Memory ' + slot; }

    /** The run ends: its motors stopped (the loop does it at its next round, and its way out once more). */
    stop(why) { if (this.run && !this.run.end) this.run.end = why || 'Stopped'; }

    /** A seat to a slot's position. Resolves when it ended: { ok, why }. */
    async recall(addr, slot) {
        if (this.run) return { ok: false, why: 'A move is running' };
        const target = this.slots(addr)[slot];
        const no = !target ? this.name(slot) + ' is not saved' : this.blocked(addr);
        if (no) { this.last = { addr, slot, ok: false, why: no }; this.log.info('seat ' + A(addr) + ': ' + this.name(slot) + ' not started: ' + no); return this.last; }
        const run = this.run = { addr, slot, why: this.name(slot) + '...', started: [], t0: this.now(), end: null };
        if (this.modules) this.modules.paused = true;
        let result;
        try {
            // easy entry: the position before it kept, to go back to (only when not already there)
            if (slot === 'E') {
                const d = data(await this.modules.read(addr, POS), POS);
                if (d && target.some((v, i) => v !== null && Math.abs(u16(d, i * 2) - v) > TOL * 3)) await this.saveQuiet(addr, 'R', d);
            }
            result = await this.go(run, target);
        } catch (e) {
            result = { ok: false, why: 'Stopped: ' + (e && e.message || e) };
        } finally {
            await this.stopAll(run);
            if (this.modules) this.modules.paused = false;
            this.run = null;
        }
        this.last = Object.assign({ addr, slot }, result);
        this.log.info('seat ' + A(addr) + ': ' + this.name(slot) + ' ' + (result.ok ? 'reached' : 'ended: ' + result.why) + ' in ' + ((this.now() - run.t0) / 1000).toFixed(1) + ' s');
        return this.last;
    }
    async saveQuiet(addr, slot, d) {
        const pos = [];
        for (let i = 0; i < FITTED; i++) pos.push(u16(d, i * 2));
        const k = hex(addr);
        this.mem[k] = Object.assign({}, this.mem[k], { [slot]: pos });
        this.write();
    }

    /** One read (a missed or refused one counts towards MISSES). */
    async get(run, did) {
        const d = data(await this.modules.link.read(run.addr, did, 600), did);
        if (d) { run.misses = 0; return d; }
        run.misses = (run.misses || 0) + 1;
        if (run.misses >= MISSES) throw new Error('the seat module stopped answering');
        return null;
    }
    /** A motor command; a refused or unanswered start ends the run. */
    async cmd(run, i, action) {
        const u = await this.motor(run.addr, i, action, PWM);
        const ok = !!(u && u[0] === 0x6E);
        if (action !== STOP && !ok) throw new Error(AXES[i] + ' not started (' + (u ? 'refused ' + hex(u[2] || 0) : 'no answer') + ')');
        if (action !== STOP && run.started.indexOf(i) < 0) run.started.push(i);
        return ok;
    }
    /** Every motor this run started: STOP (again), each tried up to 3 times. */
    async stopAll(run) {
        for (const i of run.started) {
            let ok = false;
            for (let k = 0; k < 3 && !ok; k++) { try { ok = await this.cmd(run, i, STOP); } catch (e) { ok = false; } }
            if (!ok) this.log.error('seat ' + A(run.addr) + ': STOP for ' + AXES[i] + ' not confirmed');
        }
    }

    /** Why the run must end now (null: go on). */
    reason(run) {
        if (run.end) return run.end;
        const L = this.values.live;
        if (L.left) return 'Stopped: the car was locked';
        if (typeof L.speed !== 'number' || L.speed > MAX_KMH) return 'Stopped: the car is moving';
        if (this.now() - run.t0 > MAX_RUN_MS) return 'Stopped: took too long';
        return null;
    }

    async go(run, want) {
        const addr = run.addr;
        // the seat as it is: initialised, its end stops, no motor running
        const init = limitsOf(await this.get(run, INIT));
        if (init.init !== 1) return { ok: false, why: 'The seat is not initialised' };
        const m0 = await this.get(run, MOTOR);
        if (!m0) return { ok: false, why: 'Motor state not read' };
        if (m0.slice(0, FITTED).some((x) => x === PLUS || x === MINUS)) return { ok: false, why: 'A seat motor is running' };
        const p0 = await this.get(run, POS);
        if (!p0) return { ok: false, why: 'Position not read' };
        const pos = [];
        for (let i = 0; i < FITTED; i++) pos.push(u16(p0, i * 2));
        // each target inside the learned end stops; an axis not fitted, without end stops, or not where they say: left alone
        const target = [];
        for (let i = 0; i < FITTED; i++) {
            const lim = init.limits[i], v = want[i], p = pos[i];
            if (m0[i] === 3 || v === null || v === undefined || p === null || !lim || p < lim.minus - 40 || p > lim.plus + 40) { target.push(null); continue; }
            target.push(Math.max(lim.minus + MARGIN, Math.min(lim.plus - MARGIN, v)));
        }
        const passes = {}, stopped = {}, stoppedDir = {};
        let todo = ORDER.filter((i) => target[i] !== null && Math.abs(target[i] - pos[i]) > TOL);
        const running = new Map();
        let round = 0, settleUntil = 0;
        run.why = this.name(run.slot) + '...';
        this.log.info('seat ' + A(addr) + ': ' + this.name(run.slot) + ': ' + (todo.length ? todo.map((i) => AXES[i] + ' ' + pos[i] + '>' + target[i]).join(' ') : 'already there'));
        for (;;) {
            const why = this.reason(run);
            if (why) return { ok: false, why };
            // the next motors (at most AT_ONCE)
            while (running.size < AT_ONCE && todo.length && this.now() >= settleUntil) {
                const i = todo.shift(), dir = target[i] > pos[i] ? PLUS : MINUS;
                await this.cmd(run, i, dir);
                const d = Math.abs(target[i] - pos[i]);
                running.set(i, { dir, from: pos[i], t0: this.now(), at: this.now(), was: pos[i], v: 0, allow: Math.min(MAX_RUN_MS, 1500 + d / SLOWEST * 1000) });
            }
            if (!running.size && !todo.length) {
                // settled: anything still off is corrected, PASSES times at most
                await this.sleep(SETTLE_MS);
                const d = await this.get(run, POS);
                if (!d) continue;
                for (let i = 0; i < FITTED; i++) pos[i] = u16(d, i * 2);
                this.show(addr, pos);
                const off = ORDER.filter((i) => target[i] !== null && Math.abs(target[i] - pos[i]) > TOL && (passes[i] = (passes[i] || 0) + 1) <= PASSES);
                if (!off.length) {
                    const miss = ORDER.filter((i) => target[i] !== null && Math.abs(target[i] - pos[i]) > TOL);
                    return miss.length ? { ok: false, why: 'Not quite there: ' + miss.map((i) => AXES[i] + ' ' + (pos[i] - target[i])).join(' ') } : { ok: true, why: this.name(run.slot) + ' reached' };
                }
                todo = off;
                continue;
            }
            await this.sleep(TICK_MS);
            round++;
            // the motors first, the position last: a stop is decided on the newest position
            const m = await this.get(run, MOTOR);
            const d = await this.get(run, POS);
            if (round % SWITCH_EVERY === 0) {
                const w = await this.get(run, SWITCH);
                if (w && w.some((b) => b !== 0)) { run.end = 'Stopped: a seat switch was pressed'; continue; }
            }
            if (m) {
                // the driver's own: a motor running that this run didn't start, or one going the other way
                // (a motor stopped a moment ago may still show as running in the next read or two)
                const other = m.slice(0, FITTED).some((x, i) => (x === PLUS || x === MINUS) && !(this.now() - (stopped[i] || -1e9) < RECENT_MS && x === stoppedDir[i])
                    && (!running.has(i) || running.get(i).dir !== x));
                if (other) { run.end = 'Stopped: the seat was moved by hand'; continue; }
            }
            if (!d) continue;
            const now = this.now();
            for (let i = 0; i < FITTED; i++) pos[i] = u16(d, i * 2);
            this.show(addr, pos, m);
            for (const [i, r] of Array.from(running.entries())) {
                const p = pos[i], dt = (now - r.at) / 1000;
                if (dt > 0 && p !== r.was) { const v = Math.abs(p - r.was) / dt; r.v = r.v ? r.v * 0.5 + v * 0.5 : v; }
                r.was = p; r.at = now;
                const left = (target[i] - p) * (r.dir === PLUS ? 1 : -1);
                const stoppedBySeat = m && m[i] === STOP && now - r.t0 > 400;
                if (left <= Math.max(1, r.v * LEAD_S) || stoppedBySeat) {
                    await this.cmd(run, i, STOP);
                    stopped[i] = this.now(); stoppedDir[i] = r.dir;
                    running.delete(i);
                    settleUntil = now + 150;
                    continue;
                }
                if (Math.abs(p - r.from) < MOVED && now - r.t0 > START_MS) { run.end = 'Stopped: ' + AXES[i] + ' does not move'; break; }
                if (now - r.t0 > r.allow) { run.end = 'Stopped: ' + AXES[i] + ' took too long'; break; }
            }
        }
    }
    /** The tab's bars follow the move (the modules' own reads are paused meanwhile). */
    show(addr, pos, m) {
        const s = this.seat(addr);
        if (!s) return;
        for (let i = 0; i < FITTED; i++) if (pos[i] !== null) s.pos[i] = pos[i];
        if (m) s.motor = AXES.map((a, i) => (m.length > i ? m[i] : null));
        s.at = this.now();
    }
}

module.exports = { SeatMover, limitsOf, ORDER, MARGIN, TOL, MAX_KMH };
