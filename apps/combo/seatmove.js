'use strict';
/**
 * seatmove.js - the front seats moved by their own motors: memory 1-3, easy entry, and one motor while a control is held.
 *
 * The one write Combo sends (kit/readonly-diag.js seatMotors(): nothing else gets through), as ISTA does it on a G26
 * (its trace, 2026-11-22): 2E D7 08 <motor> <action> 64 to 0x6D / 0x6E, no session, no security access, no tester
 * present; the module answers 6E D7 08 and the motor runs until a STOP (00) comes. So every motor started here is
 * stopped here: when it is at its target, on every way out (a seat switch, the car rolling, the module no longer
 * answering, a motor that doesn't move, too long), and once more on the way out of a run.
 *
 * Reads (22): D702 the Hall counters (position), D708 each motor's state (00 off, 01 plus, 02 minus, 03 not fitted:
 * a move made with the seat's own switches or memory buttons shows there too), D712 the seat switches, D704 the
 * initialisation (byte 0: 1 = initialised) and the learned end stops (seatmod.js limitsOf()).
 *
 * The head unit's transport turns a request away now and then while it is busy ("temporarily not accepted": 2.6.0 on a
 * G26 ended three runs of five on it): such a read is only missed (the next round asks again), a motor command is sent
 * again; a run ends only when the module hasn't answered for MISS_MS. Few requests a round for that reason: the position
 * every round, the motors every other one, the switches every fourth.
 *
 * The rules:
 *   - only standing (speed known and at most MAX_KMH), the seat initialised, its end
 *     stops known, no motor running when it starts
 *   - each target kept MARGIN counts inside the learned end stops
 *   - every motor that has to move at once, straight to the target (fewer if the module turns one away); the last stretch
 *     timed from the motor's speed, short moves as one timed pulse that learns from how far it went; PASSES corrections
 *   - a seat switch or a motor this run didn't start (the driver's own) ends the run at once: their switches win
 *
 * Easy entry (setting easyEntry): its own saved position ('E'). entry(addr) - the seat's door opened - keeps where the
 * seat is as 'R' and takes it to the easy entry position; back(addr) - Back pressed, nothing else - takes it back to 'R'.
 *
 *   const m = new SeatMover({ motor, modules, values, log, now, sleep, dataDir })
 *   m.recall(addr, slot)     slot '1' '2', 'E' (easy entry) or 'R' (the position before easy entry)
 *   m.entry(addr) / m.back(addr) / m.entered(addr)
 *   m.save(addr, slot)       the seat's position now into a slot
 *   m.hold(addr, axis, dir)  one motor while a control is held (dir PLUS / MINUS): it runs until release(), at most
 *                            HOLD_MS, never past the learned end stop (MARGIN), the same ways out as a recall
 *   m.release()              the control let go: STOP at once
 *   m.stop()                 the run ends (its motors stopped)
 *   m.run                    null, or { addr, slot, why } while it goes;  m.last: how the last one ended
 *   m.slots(addr)            { '1': [5 counters] | undefined, ... }
 */
const fs = require('fs');
const path = require('path');
const { hex } = require('./kit/diag');
const { AXES, limitsOf } = require('./seatmod');
const { writeWhole } = require('./store');

const POS = 0xD702, MOTOR = 0xD708, SWITCH = 0xD712, INIT = 0xD704;
const STOP = 0, PLUS = 1, MINUS = 2, PWM = 100;
const FITTED = 5;                    // SLV SHV LNV SNV KHV: the motors a G26's seats have (STV LBV LKV: 03, not fitted)
const ORDER = [0, 2, 3, 1, 4];       // SLV, LNV, SNV, SHV, KHV: the module's own recall order (two at once)
const AT_ONCE = 5;                   // every motor that has to move, at once (2.6.1's two at a time looked like a replay of
                                     // the driver's own steps); fewer when the module turns one away (atOnce, learned)
const TOL = 4;                       // counts: at the target
const MARGIN = 3;                    // counts kept from a learned end stop (a G26 memory position was 6 from one)
const LEAD_S = 0.12;                 // at least this many seconds of a motor's speed: where it is stopped before the target
const PASSES = 5;                    // corrections of an axis that stopped short or went past
const PULSE_PART = 0.75;             // a correction pulse goes this part of the way: from one side, closer each time, rather
                                     // than past and back (a stop's delay on the link varies by a tenth of a second and more)
const START_MS = 1500;               // a motor that hasn't moved MOVED counts by then: something holds it
const MOVED = 3;
const SPEEDS = [38, 62, 59, 40, 80]; // counts / s, each motor as measured on a G26 (until this seat's own are measured)
const STOP_LAT_MS = 50;              // from a STOP sent to the motor standing (the transport, ~1 count of coast)
const PULSE_S = 0.5;                 // a move this short (at the motor's speed): one timed pulse, no reads in between
const ROOM = 10;                     // a hold with less travel left than this: not started (it would coast past)
const SLOWEST = 20;                  // counts / s, for the time allowed (measured 38-80 on a G26)
const MAX_RUN_MS = 60000;              // a whole run at most (the backrest end to end: ~25 s on a G26; each motor has its own limit)
const MAX_KMH = 2;
const MISS_MS = 2500;                // no answer from the module this long: the run ends
const MISS_WAIT_MS = 120;            // after a read turned away: this long before the next
const TICK_MS = 100;                 // at least this between two rounds of reads (2.6.5: 40, and the head unit's controller
                                     // stopped answering during a move; the last stretch is timed, so fewer reads do)
const MOTOR_EVERY = 2, SWITCH_EVERY = 4;
const SETTLE_MS = 300;
const RECENT_MS = 700;               // a motor stopped this long ago may still read as running
const FRESH_MS = 1500;               // the seat modules' last reads this recent: a hold starts from them, at once
const TRIES = 4;                     // a motor command turned away: sent again this often
const SLOTS = ['1', '2', 'E', 'R'];
const ENTRY = 'E';                   // easy entry: its own saved position (2.6.1 used Memory 3: taken over)
const HOLD_MS = 10000;               // a control held longer: stopped (a lost "finger up" can't run a motor for long)

const A = (a) => '0x' + hex(a);
const u16 = (b, i) => (b && b.length > i + 1 ? b[i] * 256 + b[i + 1] : null);
const data = (u, did) => (u && u[0] === 0x62 && u[1] === (did >> 8) && u[2] === (did & 0xFF) ? u.slice(3) : null);
const posOf = (d) => { const p = []; for (let i = 0; i < FITTED; i++) p.push(u16(d, i * 2)); return p; };

class SeatMover {
    constructor(o) {
        this.motor = o.motor; this.modules = o.modules; this.values = o.values || { live: {} }; this.log = o.log;
        this.now = o.now || Date.now; this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.file = o.dataDir ? path.join(o.dataDir, 'seatmem.json') : null;
        this.mem = {};
        try { this.mem = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch (e) { /* none saved yet */ }
        // (2.6.1: Memory 3 was the entry position - it is Easy entry's own now, and there is no Memory 3)
        Object.keys(this.mem).forEach((k) => { const m = this.mem[k]; if (m && m['3']) { if (!m.E) m.E = m['3']; delete m['3']; } });
        this.run = null; this.last = null;
        // the other writers on the diagnostic link held while a seat moves (main.js: the ambient light - a door opened
        // starts its red door blink, whose writes crowded the seat out: 2.6.5 on a G26, every easy entry "stopped answering")
        this.quietOthers = o.quietOthers || null;
        this.speeds = {};            // address -> each motor's speed as measured in this seat's moves (counts / s)
        this.gains = {};             // address -> each motor's pulse time per count, as the pulses moved it (1: as its speed says)
        this.atOnce = {};            // address -> motors the module took at once (when it turned one more away)
    }
    /** Motors this seat's module takes at once (learned: turned one away, or stopped one when the next started). */
    most(addr) { const k = hex(addr), m = this.mem[k]; return this.atOnce[k] || (m && m.atOnce) || AT_ONCE; }
    /** The seat's saved positions gone (Clear): memory 1 and 2, easy entry, the position kept before it. */
    clear(addr) {
        if (this.run) return false;
        const k = hex(addr), m = this.mem[k] || {};
        this.mem[k] = m.atOnce ? { atOnce: m.atOnce } : {};
        this.write();
        this.log.info('seat ' + A(addr) + ': saved positions cleared');
        this.last = { addr, slot: 'clear', ok: true, why: 'Saved positions cleared' };
        return true;
    }
    /** A motor's pulse time per count against its speed (1 at first). */
    gain(addr, i) { const g = this.gains[hex(addr)]; return g && g[i] ? g[i] : 1; }
    taught(addr, i, want, moved) {
        const k = hex(addr), g = this.gains[k] || (this.gains[k] = []);
        const was = g[i] || 1, f = moved >= 1 ? Math.max(0.6, Math.min(2, want / moved)) : 2;
        g[i] = Math.max(0.5, Math.min(4, was * f));
    }
    /** A motor's speed (counts / s): as measured on this seat, else as on a G26. */
    speed(addr, i) { const s = this.speeds[hex(addr)]; return s && s[i] ? s[i] : SPEEDS[i]; }
    learn(addr, i, v, secs) {
        if (!(v > 5 && v < 300) || secs < 0.6) return;
        const k = hex(addr), s = this.speeds[k] || (this.speeds[k] = []);
        s[i] = s[i] ? s[i] * 0.5 + v * 0.5 : v;
    }

    slots(addr) { return this.mem[hex(addr)] || {}; }
    seat(addr) { return this.modules && this.modules.seats.find((s) => s.addr === addr) || null; }
    /** The seat went to its entry position (and has a position to go back to). */
    entered(addr) { const m = this.slots(addr); return !!(m.entered && m.R); }

    /** Why a move can't start now (null: it can). */
    blocked(addr) {
        const L = this.values.live;
        if (!this.motor) return 'No diagnostic link';
        if (typeof L.speed !== 'number') return 'No speed from the car yet';
        if (L.speed > MAX_KMH) return 'Only while the car stands still';
        const s = this.seat(addr);
        if (!s) return 'Seat module not found';
        if (s.init !== null && s.init !== undefined && s.init !== 1) return 'The seat is not initialised';
        return null;
    }

    keep(addr, slot, pos, extra) {
        const k = hex(addr);
        this.mem[k] = Object.assign({}, this.mem[k], { [slot]: pos }, extra || {});
        this.write();
    }
    /** The seat's position now into a slot (from a fresh read). */
    async save(addr, slot) {
        if (SLOTS.indexOf(slot) < 0 || this.run) return false;
        let d = null;
        try { d = data(await this.modules.read(addr, POS), POS); } catch (e) { d = null; }
        if (!d || d.length < FITTED * 2) { this.last = { addr, slot, ok: false, why: 'Position not read' }; return false; }
        const pos = posOf(d);
        this.keep(addr, slot, pos);
        this.log.info('seat ' + A(addr) + ': ' + this.name(slot) + ' saved: ' + pos.map((v, i) => AXES[i] + ' ' + v).join(' '));
        this.last = { addr, slot, ok: true, why: this.name(slot) + ' saved', saved: true };
        return true;
    }
    write() { if (this.file) { try { writeWhole(this.file, JSON.stringify(this.mem)); } catch (e) { this.log.warn('seat memory not written: ' + e.message); } } }
    name(slot) { return slot === 'R' ? 'Driving position' : slot === 'E' ? 'Easy entry' : 'Memory ' + slot; }

    /** The run ends: its motors stopped (the loop does it at its next round, and its way out once more). */
    stop(why) { if (this.run && !this.run.end) this.run.end = why || 'Stopped'; }

    /** Easy entry: where the seat is kept as 'R', the seat to its easy entry position (nothing when it is there already, or none is saved). */
    async entry(addr) {
        const to = this.slots(addr)[ENTRY];
        if (!to || this.run) return null;
        if (!this.seat(addr) && this.modules && this.modules.adopt) await this.modules.adopt(addr);
        if (this.blocked(addr)) { this.log.info('seat ' + A(addr) + ': easy entry not started: ' + this.blocked(addr)); return null; }
        let d = null;
        try { d = data(await this.modules.read(addr, POS), POS); } catch (e) { d = null; }
        if (!d) return null;
        const pos = posOf(d);
        if (to.every((v, i) => v === null || pos[i] === null || Math.abs(pos[i] - v) <= TOL * 3)) return null;
        this.keep(addr, 'R', pos, { entered: true });
        return this.recall(addr, ENTRY, 'Easy entry');
    }
    /** After easy entry: back to the position kept before it. */
    async back(addr) {
        if (!this.entered(addr) || this.run) return null;
        if (!this.seat(addr) && this.modules && this.modules.adopt) await this.modules.adopt(addr);
        const r = await this.recall(addr, 'R');
        if (r && r.ok) { const k = hex(addr); this.mem[k] = Object.assign({}, this.mem[k], { entered: false }); this.write(); }
        return r;
    }

    /** A seat to a slot's position. Resolves when it ended: { ok, why }. */
    async recall(addr, slot, label) {
        if (this.run) return { ok: false, why: 'A move is running' };
        const name = label || this.name(slot);
        const target = this.slots(addr)[slot];
        const no = !target ? name + ' is not saved' : this.blocked(addr);
        if (no) { this.last = { addr, slot, ok: false, why: no }; this.log.info('seat ' + A(addr) + ': ' + name + ' not started: ' + no); return this.last; }
        const run = this.begin(addr, slot, name + '...');
        let result;
        try { result = await this.go(run, target, name); } catch (e) { result = { ok: false, why: 'Stopped: ' + (e && e.message || e) }; }
        await this.end(run);
        this.last = Object.assign({ addr, slot }, result);
        this.log.info('seat ' + A(addr) + ': ' + name + ' ' + (result.ok ? 'reached' : 'ended: ' + result.why) + ' in ' + ((this.now() - run.t0) / 1000).toFixed(1) + ' s'
            + (result.sum ? ' (' + result.sum + ')' : ''));
        return this.last;
    }
    begin(addr, slot, why) {
        const run = this.run = { addr, slot, why, started: [], t0: this.now(), goodAt: this.now(), end: null };
        if (this.modules) this.modules.paused = true;
        run.quiet = this.quietOthers ? Promise.resolve().then(() => this.quietOthers(true)).catch(() => {}) : Promise.resolve();
        return run;
    }
    /** Until the other writers are quiet (the write they had under way done), at most ms. */
    async waitQuiet(run, ms) {
        if (!this.quietOthers) return;
        let done = false;
        run.quiet.then(() => { done = true; });
        for (let t = 0; !done && t < ms; t += 50) await this.sleep(50);
        run.goodAt = this.now();
    }
    async end(run) {
        await this.stopAll(run);
        if (this.quietOthers) Promise.resolve().then(() => this.quietOthers(false)).catch(() => {});
        // the seat modules' reads go on from where the seat is now: the moves of this run not logged again by them
        const s = this.seat(run.addr);
        if (s) { s.quiet = true; s.at = 0; }           // (its motor states as this run last read them: not current any more)
        if (this.modules) this.modules.paused = false;
        this.run = null;
    }

    /** One read; a refused or missing one is only a miss, until the module hasn't answered for MISS_MS. */
    async get(run, did) {
        let d = null;
        // (no retries in the transport: a read it turns away would hold the queue; the next round asks again instead)
        try { d = data(await this.modules.link.read(run.addr, did, 600, { maxRetries: 0 }), did); } catch (e) { d = null; }
        if (d) { run.goodAt = this.now(); return d; }
        if (this.now() - run.goodAt > MISS_MS) throw new Error('the seat module stopped answering');
        await this.sleep(MISS_WAIT_MS);
        return null;
    }
    /** A motor command, sent again when the transport turns it away; a start that never goes through ends the run. */
    async cmd(run, i, action) {
        let u = null;
        for (let k = 0; k < TRIES && !(u && u[0] === 0x6E); k++) {
            if (k) await this.sleep(MISS_WAIT_MS);
            try { u = await this.motor(run.addr, i, action, PWM); } catch (e) { u = null; }
            if (u && u[0] === 0x7F && u[2] !== 0x21 && u[2] !== 0x78) break;        // refused for good (not busy)
        }
        const ok = !!(u && u[0] === 0x6E);
        if (action !== STOP && !ok) { const e = new Error(AXES[i] + ' not started (' + (u ? 'refused ' + hex(u[2] || 0) : 'no answer') + ')'); e.refused = !!u; throw e; }
        if (action !== STOP && run.started.indexOf(i) < 0) run.started.push(i);
        return ok;
    }
    /** Every motor this run started: STOP (again). */
    async stopAll(run) {
        for (const i of run.started) {
            let ok = false;
            try { ok = await this.cmd(run, i, STOP); } catch (e) { ok = false; }
            if (!ok) this.log.error('seat ' + A(run.addr) + ': STOP for ' + AXES[i] + ' not confirmed');
        }
    }

    /** Why the run must end now (null: go on). */
    reason(run) {
        if (run.end) return run.end;
        const L = this.values.live;
        if (typeof L.speed !== 'number' || L.speed > MAX_KMH) return 'Stopped: the car is moving';
        if (this.now() - run.t0 > MAX_RUN_MS) return 'Stopped: took too long';
        return null;
    }

    /** The seat's initialisation and end stops: the seat modules' (read every 10 s), else read now. */
    async limits(run) {
        const s = this.seat(run.addr);
        if (s && s.init === 1 && s.limits && s.limits.length) return { init: 1, limits: s.limits };
        const l = limitsOf(await this.get(run, INIT) || await this.get(run, INIT));
        if (s && l.init !== null) { s.init = l.init; s.limits = l.limits; }
        return l;
    }
    /** The motors' states and the positions now (fresh reads). */
    async state(run) {
        let m = null, p = null;
        for (let k = 0; k < 6 && !m; k++) m = await this.get(run, MOTOR);
        for (let k = 0; k < 6 && !p; k++) p = await this.get(run, POS);
        return { m, pos: p ? posOf(p) : null };
    }

    async go(run, want, name) {
        const addr = run.addr;
        await this.waitQuiet(run, 3000);
        const init = await this.limits(run);
        if (init.init !== 1) return { ok: false, why: 'The seat is not initialised' };
        const st = await this.state(run);
        if (!st.m || !st.pos) return { ok: false, why: 'The seat module did not answer' };
        const m0 = st.m, pos = st.pos;
        if (m0.slice(0, FITTED).some((x) => x === PLUS || x === MINUS)) return { ok: false, why: 'A seat motor is running' };
        // each target inside the learned end stops; an axis not fitted, without end stops, or not where they say: left alone
        const target = [];
        for (let i = 0; i < FITTED; i++) {
            const lim = init.limits[i], v = want[i], p = pos[i];
            if (m0[i] === 3 || v === null || v === undefined || p === null || !lim || p < lim.minus - 40 || p > lim.plus + 40) { target.push(null); continue; }
            target.push(Math.max(lim.minus + MARGIN, Math.min(lim.plus - MARGIN, v)));
        }
        const passes = {}, stopped = {}, stoppedDir = {}, pulses = [], stats = {}, from = pos.slice();
        const stat = (i) => stats[i] || (stats[i] = { starts: 0, ms: 0 });
        // each motor that moved, for the log: where from and to (and the target when not on it), starts, time it ran
        const summary = () => ORDER.filter((i) => stats[i]).map((i) => AXES[i] + ' ' + from[i] + '>' + pos[i] + (Math.abs(pos[i] - target[i]) > TOL ? ' (want ' + target[i] + ')' : '')
            + ' ' + stats[i].starts + 'x ' + (stats[i].ms / 1000).toFixed(1) + ' s').join(', ');
        let todo = ORDER.filter((i) => target[i] !== null && Math.abs(target[i] - pos[i]) > TOL);
        const running = new Map();
        let round = 0, settleUntil = 0, lastRead = this.now(), roundS = LEAD_S;
        this.log.info('seat ' + A(addr) + ': ' + name + ': ' + (todo.length ? todo.map((i) => AXES[i] + ' ' + pos[i] + '>' + target[i]).join(' ') : 'already there'));
        for (;;) {
            const why = this.reason(run);
            if (why) return { ok: false, why, sum: summary() };
            // the next motors (every one that has to move, as many as the module takes at once)
            const most = this.most(addr);
            while (running.size < most && todo.length && this.now() >= settleUntil) {
                const i = todo.shift(), dir = target[i] > pos[i] ? PLUS : MINUS;
                const d = Math.abs(target[i] - pos[i]), v = this.speed(addr, i), g = this.gain(addr, i);
                if (!running.size && d / v * g <= PULSE_S) {
                    // a short move (a correction, or a small one), alone: run for the time it takes, then STOP - no read can
                    // be late for it; how far it went teaches the next pulse (a motor's start eats some of a short one)
                    await this.cmd(run, i, dir);
                    const ms = Math.max(30, d * (d > TOL ? PULSE_PART : 1) / v * g * 1000 - STOP_LAT_MS);
                    await this.sleep(ms);
                    await this.cmd(run, i, STOP);
                    stopped[i] = this.now(); stoppedDir[i] = dir;
                    pulses.push({ i, from: pos[i], d: d * (d > TOL ? PULSE_PART : 1) });
                    stat(i).starts++; stat(i).ms += ms;
                    settleUntil = this.now() + 150;
                    continue;
                }
                if (d / v * g <= PULSE_S) { todo.push(i); if (todo.every((k) => Math.abs(target[k] - pos[k]) / this.speed(addr, k) * this.gain(addr, k) <= PULSE_S)) break; continue; }
                try { await this.cmd(run, i, dir); } catch (e) {
                    // turned away with others running: the module takes no more at once - this one after them
                    if (!e.refused || !running.size) throw e;
                    this.atOnce[hex(addr)] = running.size;
                    this.keep(addr, 'atOnce', running.size);
                    this.log.info('seat ' + A(addr) + ': ' + AXES[i] + ' turned away with ' + running.size + ' running: ' + running.size + ' at once from now');
                    todo.unshift(i);
                    break;
                }
                stat(i).starts++;
                running.set(i, { dir, from: pos[i], t0: this.now(), at: this.now(), was: pos[i], v, allow: Math.min(MAX_RUN_MS, 2000 + d / SLOWEST * 1000) });
            }
            if (!running.size && !todo.length) {
                // settled: anything still off is corrected, PASSES times at most
                await this.sleep(SETTLE_MS);
                const d = await this.get(run, POS);
                if (!d) continue;
                const now = posOf(d);
                for (let i = 0; i < FITTED; i++) pos[i] = now[i];
                this.show(addr, pos);
                // the pulses since the last look: how far each went against how far it was meant to
                pulses.splice(0).forEach((q) => this.taught(addr, q.i, q.d, Math.abs(pos[q.i] - q.from)));
                const off = ORDER.filter((i) => target[i] !== null && Math.abs(target[i] - pos[i]) > TOL && (passes[i] = (passes[i] || 0) + 1) <= PASSES);
                if (!off.length) {
                    const miss = ORDER.filter((i) => target[i] !== null && Math.abs(target[i] - pos[i]) > TOL);
                    const sum = summary();
                    return miss.length ? { ok: false, why: 'Not quite there: ' + miss.map((i) => AXES[i] + ' ' + (pos[i] - target[i])).join(' '), sum }
                        : { ok: true, why: name + ' reached', sum };
                }
                todo = off;
                continue;
            }
            await this.sleep(TICK_MS);
            round++;
            // the motors every other round (the driver's own move), the switches every fourth, the position last: a stop is
            // decided on the newest position
            const m = round % MOTOR_EVERY === 0 ? await this.get(run, MOTOR) : null;
            if (round % SWITCH_EVERY === 0) {
                const w = await this.get(run, SWITCH);
                if (w && w.some((b) => b !== 0)) { run.end = 'Stopped: a seat switch was pressed'; continue; }
            }
            if (m) {
                // (a motor stopped a moment ago may still show as running in the next read or two)
                const other = m.slice(0, FITTED).some((x, i) => (x === PLUS || x === MINUS) && !(this.now() - (stopped[i] || -1e9) < RECENT_MS && x === stoppedDir[i])
                    && (!running.has(i) || running.get(i).dir !== x));
                if (other) { run.end = 'Stopped: the seat was moved by hand'; continue; }
            }
            const d = await this.get(run, POS);
            if (!d) continue;
            const now = this.now();
            roundS = Math.max(LEAD_S, Math.min(0.6, (now - lastRead) / 1000));
            lastRead = now;
            const np = posOf(d);
            for (let i = 0; i < FITTED; i++) pos[i] = np[i];
            this.show(addr, pos, m);
            // a motor the module stopped while one started after it kept going: its diagnostic control runs one motor at a
            // time (2.6.4 on a G26: the motors went one after the other, like the driver's own steps). That one again later,
            // not counted as a try; this seat one motor at a time from now on (kept in seatmem.json)
            if (m) {
                for (const [i, r] of Array.from(running.entries())) {
                    const left = (target[i] - pos[i]) * (r.dir === PLUS ? 1 : -1);
                    const later = Array.from(running.entries()).some(([j, q]) => j !== i && q.t0 > r.t0);
                    if (m[i] !== STOP || left <= TOL || !later || now - r.t0 < 300) continue;
                    running.delete(i);
                    todo.unshift(i);
                    if (this.most(addr) !== 1) {
                        this.atOnce[hex(addr)] = 1;
                        this.keep(addr, 'atOnce', 1);
                        this.log.info('seat ' + A(addr) + ': ' + AXES[i] + ' stopped when another started: one motor at a time from now on');
                    }
                }
            }
            for (const [i, r] of Array.from(running.entries())) {
                const p = pos[i], dt = (now - r.at) / 1000;
                if (dt > 0 && p !== r.was) { const v = Math.abs(p - r.was) / dt; r.v = r.v * 0.5 + v * 0.5; }
                r.was = p; r.at = now;
                const left = (target[i] - p) * (r.dir === PLUS ? 1 : -1);
                const stoppedBySeat = m && m[i] === STOP && now - r.t0 > 500;
                // at the target before the next look: the rest of the way timed from its speed, then STOP (a read that comes
                // late on a busy link then can't carry it past)
                const eta = left / Math.max(5, r.v);
                if (left <= 1 || stoppedBySeat || eta <= roundS + 0.05) {
                    if (!stoppedBySeat && left > 1) await this.sleep(Math.max(0, eta * 1000 - STOP_LAT_MS));
                    this.learn(addr, i, r.v, (now - r.t0) / 1000);
                    stat(i).ms += this.now() - r.t0;
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

    /**
     * One motor while a control is held. It starts at once from the seat modules' last reads when they are recent (2.6.0
     * read three things first: a short hold on a busy link barely moved). Resolves when it stopped: { ok, why } (ok: let
     * go, or the end of its travel).
     */
    async hold(addr, i, dir) {
        if (this.run) return { ok: false, why: 'A move is running' };
        if (!(i >= 0 && i < FITTED) || (dir !== PLUS && dir !== MINUS)) return { ok: false, why: 'No such control' };
        const no = this.blocked(addr);
        if (no) { this.last = { addr, slot: 'hold', ok: false, why: no }; return this.last; }
        const run = this.begin(addr, 'hold', AXES[i] + (dir === PLUS ? '+' : '-'));
        run.axis = i; run.dir = dir;
        let result, from = null, to = null;
        try {
            const s = this.seat(addr), fresh = s && s.at && this.now() - s.at < FRESH_MS && s.motor && s.motor.length && s.pos[i] !== null;
            const init = await this.limits(run);
            const st = fresh ? { m: s.motor, pos: s.pos.slice(0, FITTED) } : await this.state(run);
            const lim = init.limits[i];
            if (init.init !== 1) result = { ok: false, why: 'The seat is not initialised' };
            else if (!st.m || !st.pos) result = { ok: false, why: 'The seat module did not answer' };
            else if (st.m[i] === 3) result = { ok: false, why: AXES[i] + ' is not fitted' };
            else if (st.m.slice(0, FITTED).some((x) => x === PLUS || x === MINUS)) result = { ok: false, why: 'A seat motor is running' };
            else if (!lim) result = { ok: false, why: AXES[i] + ': end stops not known' };
            else {
                from = to = st.pos[i];
                const room = dir === PLUS ? lim.plus - MARGIN - from : from - (lim.minus + MARGIN);
                result = room < ROOM ? { ok: true, why: 'At the end of its travel' } : await this.held(run, i, dir, lim, from, (p) => { to = p; });
            }
        } catch (e) {
            result = { ok: false, why: 'Stopped: ' + (e && e.message || e) };
        }
        await this.end(run);
        this.last = Object.assign({ addr, slot: 'hold' }, result);
        this.log.info('seat ' + A(addr) + ': ' + AXES[i] + (dir === PLUS ? '+' : '-') + ' held ' + ((this.now() - run.t0) / 1000).toFixed(1) + ' s'
            + (from !== null ? ', ' + from + '>' + to : '') + (result.why && result.why !== 'Let go' ? ': ' + result.why : ''));
        return this.last;
    }
    async held(run, i, dir, lim, from, moved) {
        await this.waitQuiet(run, 300);
        if (run.end === 'Let go') return { ok: true, why: 'Let go' };
        await this.cmd(run, i, dir);
        // let go while the start was on its way: release()'s STOP follows it, and end() sends one more
        if (run.end === 'Let go') return { ok: true, why: 'Let go' };
        const t0 = this.now();
        let v = this.speed(run.addr, i), was = from, at = t0, round = 0, lastRead = t0;
        for (;;) {
            if (run.end === 'Let go') return { ok: true, why: 'Let go' };
            const why = this.reason(run);
            if (why) return { ok: false, why };
            if (this.now() - t0 > HOLD_MS) return { ok: true, why: 'Held ' + HOLD_MS / 1000 + ' s: stopped, press again to go on' };
            await this.sleep(TICK_MS);
            round++;
            const m = round % MOTOR_EVERY === 0 ? await this.get(run, MOTOR) : null;
            if (run.end === 'Let go') return { ok: true, why: 'Let go' };
            if (m && m.slice(0, FITTED).some((x, k) => (x === PLUS || x === MINUS) && (k !== i || x !== dir))) return { ok: false, why: 'Stopped: the seat was moved by hand' };
            const d = await this.get(run, POS);
            if (run.end === 'Let go') return { ok: true, why: 'Let go' };
            if (!d) continue;
            const p = u16(d, i * 2), now = this.now();
            const roundS = Math.max(LEAD_S, Math.min(0.6, (now - lastRead) / 1000));
            lastRead = now;
            if (now > at && p !== was) { const nv = Math.abs(p - was) / ((now - at) / 1000); v = v * 0.5 + nv * 0.5; }
            was = p; at = now; moved(p);
            this.show(run.addr, posOf(d), m);
            const room = dir === PLUS ? lim.plus - MARGIN - p : p - (lim.minus + MARGIN);
            // the end stop before the next look: the rest timed, then stopped there
            if (room <= Math.max(1, v * (roundS + 0.05))) {
                if (room > 1) await this.sleep(Math.max(0, room / Math.max(5, v) * 1000 - STOP_LAT_MS));
                return { ok: true, why: 'At the end of its travel' };
            }
            if (m && m[i] === STOP && now - t0 > 500) return { ok: true, why: 'Stopped by the seat' };
            if (Math.abs(p - from) < MOVED && now - t0 > START_MS) return { ok: false, why: 'Stopped: ' + AXES[i] + ' does not move' };
        }
    }
    /** The control let go: the motor stopped now (not at the loop's next round), the run ends. */
    release() {
        const r = this.run;
        if (!r || r.slot !== 'hold' || r.end) return;
        r.end = 'Let go';
        Promise.resolve().then(() => this.motor(r.addr, r.axis, STOP, PWM)).catch(() => {});
    }

    /** The tab's picture follows the move (the modules' own reads are paused meanwhile). */
    show(addr, pos, m) {
        const s = this.seat(addr);
        if (!s) return;
        for (let i = 0; i < FITTED; i++) if (pos[i] !== null) s.pos[i] = pos[i];
        if (m) s.motor = AXES.map((a, i) => (m.length > i ? m[i] : null));
        s.at = this.now();
    }
}

module.exports = { SeatMover, limitsOf, ORDER, MARGIN, TOL, MAX_KMH, PLUS, MINUS, HOLD_MS, ENTRY };
