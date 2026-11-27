'use strict';
/**
 * trips.js - Cockpit's trip book (2.9.0, a prototype): each drive kept with its distance, time, top and average speed
 * and the fuel it used, the month's totals, and a Trips tab.
 *
 * A trip is one drive cycle: it starts when the car is ready to drive (its own state, VehicleCondition 8 / 10) or moves
 * (a car that sends no state), and ends once the car has left that state for END_MS (or stood still IDLE_MS without a
 * state). Started again within RESUME_MS of its end (the engine off at a fuel station, a stall), the same trip goes on.
 *
 * Distance: the car's odometer when it sends one (start to end, whole km), else the speed added up each second.
 * Fuel: the tank's level (litres) at the start against the end; a rise of REFUEL_L or more is a refuel, and what was
 * used before it counts too. A trip's fuel and consumption only from MIN_FUEL_KM on (the tank's level moves in whole
 * litres: a short trip read 0, 1 or 2 l by rounding and slosh). The month's fuel: what the tank's lowest level since
 * the last refuel went down by in that month (monthFuel), not the trips' rounded litres added up (3.1.1).
 *
 * Trips kept from before 2.9.1 whose distance no car could drive in their time (two odometers mixed: 34724 km in a
 * 41 min trip) are dropped as they load (plausible()).
 *
 * Since refuelling: a rise of REFUEL_L or more in the tank's level, during a trip or between two (the level at a start
 * against the last one known), starts a new count: the distance since (odometer or speed), the fuel since (the level
 * just after the refuel less the level now) and the consumption, from MIN_FUEL_KM on.
 *
 * Kept in trips.json in the app's data folder (at most KEEP trips, newest first): saved when a trip ends, every
 * SAVE_MS while one runs, and as the app exits; a trip running when the app stopped is resumed if the car is driven
 * again within RESUME_MS of its last save, else ended there.
 *
 *   const tb = new Trips({ dataDir, log, now, settings, localTime })   localTime: localtime.js, for the times shown and the months
 *   tb.tick({ speed, condition })     once a second: the speed (km/h) and the car's state (Car.conditionOf) now
 *   tb.odometer(km)  tb.fuel(litres)  the car's values as they come (null: not given)
 *   tb.current  tb.trips  tb.months()  tb.sinceRefuel()  tb.endNow()  tb.save()  tb.draw(cv, t)
 */
const fs = require('fs');
const path = require('path');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { writeWhole } = require('./store');

const END_MS = 60000, RESUME_MS = 3 * 60000, IDLE_MS = 10 * 60000, SAVE_MS = 5 * 60000;
const MAX_GAP_S = 5;                 // a gap in the speed longer than this adds nothing (the head unit was busy, asleep)
const MOVING_KMH = 3, REFUEL_L = 3, MIN_FUEL_KM = 20, KEEP = 1000;
const DRIVE = (n) => n === 8 || n === 10;
const isNum = (x) => typeof x === 'number' && isFinite(x);

class Trips {
    constructor(o) {
        this.log = o.log || { info() {}, warn() {} };
        this.now = o.now || Date.now;
        this.settings = o.settings || { get: () => null };
        // the local time of a moment (a Date read with getUTC*): the car's (localtime.js), else the head unit's own zone
        this.at = o.localTime ? (ms) => o.localTime.at(ms) : (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
        this.file = o.dataDir ? path.join(o.dataDir, 'trips.json') : null;
        this.trips = []; this.current = null;
        this.odo = null; this.litres = null; this.sawState = false; this.monthFuel = {};
        this.offAt = null; this.idleAt = null; this.lastT = null; this.savedAt = 0;
        this.load();
        if (this.dirty) { this.dirty = false; this.save(); }
    }

    load() {
        if (!this.file) return;
        let d = null;
        try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { d = null; }
        if (!d) return;
        this.trips = Array.isArray(d.trips) ? d.trips.filter((x) => x && isNum(x.start)) : [];
        const bad = this.trips.filter((x) => !plausible(x));
        if (bad.length) {
            this.trips = this.trips.filter(plausible);
            this.log.warn('trips: ' + bad.length + ' trip(s) dropped, a distance no car drives in its time: ' + bad.map((x) => x.km + ' km in ' + Math.round((x.end - x.start) / 60000) + ' min').join(', '));
            this.dirty = true;
        }
        if (d.monthFuel && typeof d.monthFuel === 'object') Object.keys(d.monthFuel).forEach((k) => { if (isNum(d.monthFuel[k])) this.monthFuel[k] = d.monthFuel[k]; });
        if (d.since && isNum(d.since.at)) this.since = d.since;
        if (isNum(d.level)) this.lastLevel = d.level;
        // a trip running when the app last stopped: resumed below if the car is driven again soon, else ended there
        if (d.current && isNum(d.current.start)) this.paused = d.current;
    }
    save() {
        if (!this.file) return;
        try { writeWhole(this.file, JSON.stringify({ v: 1, current: this.current, since: this.since || null, level: isNum(this.lastLevel) ? this.lastLevel : null, monthFuel: this.monthFuel, trips: this.trips.slice(0, KEEP) })); this.savedAt = this.now(); } catch (e) { this.log.warn('trips: ' + e.message); }
    }

    /**
     * The car's odometer in km (whole km), as it comes (src: which signal, for the log). Its count is used only where it
     * agrees with the speed's (odoKm()): on a G26 the first reading was 1024 km against a real 35748 (2.9.1).
     */
    odometer(km, src) {
        if (!isNum(km) || km <= 0 || km >= 16777214) return;
        const seen = this.odoSeen || (this.odoSeen = {}), k = src || 'odometer', n = seen[k] || { n: 0, last: null };
        if (n.last !== km && n.n < 8) { n.n++; this.log.info('trips: odometer ' + k + ' ' + km + ' km'); }
        n.last = km; seen[k] = n;
        // one source at a time, SecureMileage first: two signals' readings mixed in one count gave 1024 > 35748 (2.9.1)
        if (this.odoSrc && k !== this.odoSrc) {
            if (k !== ODO_FIRST) return;
            this.log.info('trips: odometer from ' + k + ' (not ' + this.odoSrc + ')');
            const c0 = this.current;
            if (c0) { c0.odo0 = km; c0.kmAtOdo0 = c0.kmSum; }
            if (this.since) { this.since.odo0 = km; this.since.kmAtOdo0 = this.since.kmSum || 0; }
        }
        this.odoSrc = k;
        this.odo = km; this.odoAt = this.now();
        if (this.since && !isNum(this.since.odo0)) { this.since.odo0 = km; this.since.kmAtOdo0 = this.since.kmSum || 0; }
        const c = this.current;
        if (c) { if (!isNum(c.odo0)) { c.odo0 = km; c.kmAtOdo0 = c.kmSum; } c.odo1 = km; }
    }
    /**
     * The fuel in the tank, litres, as it comes. A refuel: the level REFUEL_L or more over the lowest one since the last
     * refuel (also when it climbs a litre at a time, the app running at the pump); the level is then followed up while
     * it rises, so the count starts from the full tank.
     */
    fuel(l) {
        if (!isNum(l) || l < 0 || l > 250) return;
        if (this.litres === null) this.log.info('trips: fuel in the tank ' + l + ' l');
        this.litres = l;
        // since refuelling (the last level known kept across restarts: a refuel while the app wasn't running counts too)
        // (the last level known: what the tank lost while the app wasn't running counts for the month too)
        if (!isNum(this.floor)) this.floor = isNum(this.lastLevel) ? this.lastLevel : l;
        if (this.filling && this.since && l > this.floor) {
            this.since.level = Math.max(this.since.level, l); this.floor = l;            // still filling up: the count from the top
        } else if (l >= this.floor + REFUEL_L) {
            this.log.info('trips: refuelled ' + this.floor + ' > ' + l + ' l: counting since refuelling');
            this.since = { at: this.now(), level: l, kmSum: 0, odo0: isNum(this.odo) ? this.odo : null };
            this.filling = true; this.floor = l;
            this.save();
        } else if (l < this.floor) {
            // the month's fuel: only a new lowest level counts, so the level going down and up again (slosh, a slope) adds nothing
            const k = monthKey(this.at(this.now()));
            this.monthFuel[k] = (this.monthFuel[k] || 0) + (this.floor - l);
            this.floor = l; this.filling = false;
        }
        this.lastLevel = l;
        // this trip's fuel: what the tank lost, before and after a refuel on the way
        const c = this.current;
        if (!c) return;
        if (!isNum(c.fuel0)) { c.fuel0 = l; c.fuelBase = l; c.fuelUsed = 0; c.fuelLow = l; c.fuelLast = l; return; }
        if (c.filling && l > c.fuelLow) { c.fuelBase = Math.max(c.fuelBase, l); c.fuelLow = l; }
        else if (l >= c.fuelLow + REFUEL_L) {
            c.fuelUsed += Math.max(0, c.fuelBase - c.fuelLow); c.refuelled = true; c.filling = true; c.fuelBase = l; c.fuelLow = l;
        } else if (l < c.fuelLow) { c.fuelLow = l; c.filling = false; }
        c.fuelLast = l;
    }

    /** Once a second: the speed (km/h, null: none) and the car's state (1-12, undefined: none). */
    tick(o) {
        const now = this.now(), speed = isNum(o.speed) ? o.speed : null, cond = o.condition;
        if (isNum(cond)) this.sawState = true;
        const ready = this.sawState ? DRIVE(cond) : speed !== null && speed > MOVING_KMH;
        if (ready) {
            this.offAt = null;
            if (!this.current) this.begin(now);
        } else if (this.current && this.sawState && this.offAt === null) this.offAt = now;
        const c = this.current;
        if (!c) return;
        // distance and times from the speed
        if (speed !== null) {
            const dt = this.lastT === null ? 0 : (now - this.lastT) / 1000;
            if (dt > 0 && dt <= MAX_GAP_S) {
                c.kmSum += speed * dt / 3600;
                if (this.since) this.since.kmSum = (this.since.kmSum || 0) + speed * dt / 3600;
                if (speed > MOVING_KMH) c.movingS += dt;
            }
            if (speed > c.top) c.top = speed;
            this.lastT = now;
            if (!this.sawState) { if (speed > MOVING_KMH) this.idleAt = null; else if (this.idleAt === null) this.idleAt = now; }
        }
        c.end = now;
        if ((this.offAt !== null && now - this.offAt >= END_MS) || (!this.sawState && this.idleAt !== null && now - this.idleAt >= IDLE_MS)) this.finish(this.offAt || this.idleAt);
        else if (now - this.savedAt >= SAVE_MS) this.save();
    }

    begin(now) {
        const last = this.trips[0], p = this.paused;
        this.paused = null;
        // the same trip again: one paused as the app stopped, or the last one, ended a short while ago
        const r = this.lastRaw, back = p && now - p.end <= RESUME_MS ? p : !p && r && now - r.end <= RESUME_MS ? r : null;
        if (p && !back) this.trips.unshift(this.closed(p));
        if (back && back === r && this.lastKept && last && last.start === r.start) this.trips.shift();   // (its summary: made again at its end)
        this.lastRaw = null;
        this.current = back || { start: now, end: now, kmSum: 0, movingS: 0, top: 0 };
        this.lastT = null; this.idleAt = null;
        // the odometer count from the reading the car gave as it woke (ODO_FRESH_MS), else from the first one in this trip
        // (odometer()): last night's reading, before a km counted after that trip ended, gave a parked start 1.0 km (3.1.1)
        if (isNum(this.odo) && !isNum(this.current.odo0) && now - this.odoAt <= ODO_FRESH_MS) this.current.odo0 = this.odo;
        if (isNum(this.litres) && !isNum(this.current.fuel0)) this.fuel(this.litres);
        this.log.info('trips: ' + (back ? 'the trip goes on' : 'a trip began'));
    }
    /** The trip ended (at `at`): kept with its summary. */
    finish(at) {
        const c = this.current;
        if (!c) return;
        c.end = at || this.now();
        this.current = null; this.offAt = null; this.idleAt = null; this.lastT = null;
        const s = this.closed(c);
        this.lastRaw = c; this.lastKept = s.km >= 0.2;
        // a few metres in the drive (the car woken and parked again): not kept
        if (this.lastKept) {
            this.trips.unshift(s);
            this.log.info('trips: ended, ' + s.km.toFixed(1) + ' km (' + s.kmFrom + ') in ' + Math.round((s.end - s.start) / 60000) + ' min' + (isNum(s.fuel) ? ', ' + s.fuel + ' l' : '')
                + '; speed ' + c.kmSum.toFixed(1) + ' km, odometer ' + (isNum(c.odo0) ? c.odo0 + ' > ' + c.odo1 + ' from ' + (c.kmAtOdo0 || 0).toFixed(1) + ' km in' : 'none'));
        }
        this.save();
    }
    endNow() { if (this.current) this.finish(this.now()); }

    /** A trip's summary: km (the odometer's where it agrees with the speed's, else the speed's), fuel used, consumption. */
    closed(c) {
        const odo = odoKm(c.odo0, c.odo1, c.kmAtOdo0, c.kmSum);
        const km = odo !== null ? odo : Math.round(c.kmSum * 10) / 10;
        const fuel = isNum(c.fuel0) ? c.fuelUsed + Math.max(0, c.fuelBase - c.fuelLast) : null;
        return { start: c.start, end: c.end, km, kmFrom: odo !== null ? 'odometer' : 'speed', movingS: Math.round(c.movingS), top: Math.round(c.top),
            fuel, per100: isNum(fuel) && km >= MIN_FUEL_KM ? Math.round(fuel / km * 1000) / 10 : null, refuelled: !!c.refuelled };
    }
    /** Since the last refuel seen: { at, km, kmFrom, fuel, per100 }, or null (none seen yet). */
    sinceRefuel() {
        const r = this.since;
        if (!r) return null;
        const odo = odoKm(r.odo0, this.odo, r.kmAtOdo0, r.kmSum || 0);
        const km = odo !== null ? odo : Math.round((r.kmSum || 0) * 10) / 10;
        const fuel = isNum(this.lastLevel) ? Math.max(0, r.level - this.lastLevel) : null;
        return { at: r.at, km, kmFrom: odo !== null ? 'odometer' : 'speed', fuel, per100: isNum(fuel) && km >= MIN_FUEL_KM ? Math.round(fuel / km * 1000) / 10 : null };
    }
    /** The running trip's summary, or the last one's. */
    shown() { return this.current ? Object.assign(this.closed(this.current), { live: true }) : this.trips[0] || null; }

    /** This month and the ones before: { key 'YYYY-MM', trips, km, hours, fuel (litres: monthFuel, else the trips') }, newest first. */
    months() {
        const m = {};
        this.trips.concat(this.current ? [this.closed(this.current)] : []).forEach((x) => {
            const k = monthKey(this.at(x.start));
            const a = m[k] || (m[k] = { key: k, trips: 0, km: 0, hours: 0, fuel: 0 });
            a.trips++; a.km += x.km; a.hours += (x.end - x.start) / 3600000; if (isNum(x.fuel)) a.fuel += x.fuel;
        });
        // the tank's own count where there is one (the trips' fuel: whole litres each, rounded up and down)
        Object.keys(m).forEach((k) => { if (isNum(this.monthFuel[k])) m[k].fuel = this.monthFuel[k]; });
        return Object.keys(m).sort().reverse().map((k) => m[k]);
    }

    /* ---------- the tab ---------- */
    draw(cv, t) {
        const mi = this.settings.get('speedUnit') === 'mph', D = (km) => (mi ? km * 0.621371 : km), dU = mi ? 'mi' : 'km', vU = mi ? 'mph' : 'km/h';
        const s = this.shown(), ex = cv.extra || 0;
        // left: the trip running (or the last one), big
        G.panel(cv, t, 24, 44, 620, 468 + ex, s && s.live ? 'This trip' : 'Last trip');
        if (!s) {
            cv.text('No trip yet', 334, 230, 30, t.dim, { align: 'center', font: 'bold' });
            cv.text('A trip begins when the car is ready to drive.', 334, 270, 18, t.dim, { align: 'center' });
        } else {
            const mins = Math.max(0, (s.end - s.start) / 60000), avg = mins > 0 ? s.km / (mins / 60) : null;
            cv.text(when(this.at(s.start)) + (s.live ? '' : '  -  ' + clock(this.at(s.end))), 624, 82, 20, t.dim, { align: 'right', font: 'bold' });      // (the title's row)
            big(cv, t, 44, 190, G.fmt(D(s.km), 1), dU, 96);
            cv.text(s.kmFrom === 'odometer' ? 'from the odometer' : 'from the speed', 44, 222, 16, t.dim);
            const rows = [['Time', dur(mins)], ['Average speed', isNum(avg) ? G.fmt(D(avg), 0) + ' ' + vU : '--'], ['Top speed', s.top ? G.fmt(D(s.top), 0) + ' ' + vU : '--'],
                ['Fuel used', !isNum(s.fuel) ? 'not given by the car' : s.km >= MIN_FUEL_KM ? litres(s.fuel) + (s.refuelled ? ' (refuelled)' : '') : 'from ' + MIN_FUEL_KM + ' km'],
                ['Consumption', isNum(s.per100) ? (mi ? G.fmt(235.215 / s.per100, 1) + ' mpg' : G.fmt(s.per100, 1) + ' l/100 km') : isNum(s.fuel) ? 'from ' + MIN_FUEL_KM + ' km' : '--']];
            rows.forEach(([k, v], i) => {
                const y = 286 + i * 44 + i * ex / 6;
                cv.fillRect(44, y - 30, 580, 1, withAlpha(t.tick, 0.5));
                cv.text(k, 44, y, 22, t.dim, { font: 'bold' });
                cv.text(v, 624, y, 26, v === '--' || /^not |^from /.test(v) ? t.dim : t.text, { align: 'right', font: 'bold' });
            });
        }
        // right top: the last trips
        const listH = 300 + ex / 2;
        G.panel(cv, t, 656, 44, 920, listH, 'Trips');
        const list = this.trips.slice(0, Math.floor((listH - 92) / 38));
        if (!list.length) cv.text('Ended trips show here', 676, 130, 20, t.dim);
        list.forEach((x, i) => {
            const y = 130 + i * 38, mins = (x.end - x.start) / 60000;
            cv.text(when(this.at(x.start)), 676, y, 20, t.text);
            cv.text(G.fmt(D(x.km), 1) + ' ' + dU, 1040, y, 22, t.text, { align: 'right', font: 'bold' });
            cv.text(dur(mins), 1200, y, 20, t.dim, { align: 'right' });
            cv.text(isNum(x.per100) ? (mi ? G.fmt(235.215 / x.per100, 1) + ' mpg' : G.fmt(x.per100, 1) + ' l/100') : '', 1380, y, 20, t.dim, { align: 'right' });
            cv.text('top ' + G.fmt(D(x.top), 0), 1556, y, 20, t.dim, { align: 'right' });
        });
        // right bottom: this month, and since refuelling (side by side)
        const my = 44 + listH + 12, mh = 468 + ex - listH - 12, mo = this.months()[0], pw = 454;
        G.panel(cv, t, 656, my, pw, mh, 'This month');
        const key = monthKey(this.at(this.now()));
        const a = mo && mo.key === key ? mo : { trips: 0, km: 0, hours: 0, fuel: 0 };
        cells(cv, t, 676, my, [['Trips', String(a.trips)], ['Distance', G.fmt(D(a.km), 0) + ' ' + dU], ['Fuel', a.fuel ? G.fmt(a.fuel, 0) + ' l' : '--']], !!a.trips);
        const rx = 656 + pw + 12, r = this.sinceRefuel();
        G.panel(cv, t, rx, my, 1576 - rx, mh, 'Since refuelling');
        if (!r) cv.text('Counts from the next refuel', rx + 20, my + 100, 20, t.dim);
        else {
            cv.text(when(this.at(r.at)), 1556, my + 34, 18, t.dim, { align: 'right', font: 'bold' });
            cells(cv, t, rx + 20, my, [['Distance', G.fmt(D(r.km), 0) + ' ' + dU], ['Fuel', isNum(r.fuel) ? litres(r.fuel) : '--'],
                ['Consumption', isNum(r.per100) ? (mi ? G.fmt(235.215 / r.per100, 1) + ' mpg' : G.fmt(r.per100, 1) + ' l/100') : 'from ' + MIN_FUEL_KM + ' ' + dU]], true);
        }
    }
}

/** A panel's row of labelled values, 145 px apart. */
function cells(cv, t, x, y, items, on) {
    items.forEach(([k, v], i) => {
        cv.text(k, x + i * 145, y + 76, 18, t.dim, { font: 'bold' });
        cv.text(v, x + i * 145, y + 112, v.length > 10 ? 24 : 30, on && !/^--$|^from /.test(v) ? t.text : t.dim, { font: 'num' });
    });
}
/**
 * The distance by the odometer (odo0 first read when the speed had counted kmAt0 of it), or null where it doesn't agree
 * with the speed's within ODO_AGREE (at least 2 km) - a reading the car got wrong - or has counted no whole km yet, or
 * where the speed has counted less than ODO_MIN_KM (a whole km of the odometer against a car that hardly moved).
 */
const ODO_AGREE = 0.2, ODO_FIRST = 'SecureMileage', ODO_MIN_KM = 0.5, ODO_FRESH_MS = 2 * 60000;
function odoKm(odo0, odo1, kmAt0, kmSum) {
    if (!isNum(odo0) || !isNum(odo1) || odo1 - odo0 < 1 || !(kmSum >= ODO_MIN_KM)) return null;
    const part = odo1 - odo0, speedPart = kmSum - (kmAt0 || 0);
    if (Math.abs(part - speedPart) > Math.max(2, speedPart * ODO_AGREE)) return null;
    return Math.round((part + (kmAt0 || 0)) * 10) / 10;
}
function big(cv, t, x, y, text, unit, size) {
    const w = cv.text(text, x, y, size, t.text, { font: 'num' });
    cv.text(' ' + unit, x + w, y, 30, t.dim);
}
const two = (n) => String(n).padStart(2, '0');
/** A kept trip a car could have driven: at most its top speed (and PLAUSIBLE_KMH on average) over its time, plus 2 km. */
const PLAUSIBLE_KMH = 300;
function plausible(x) {
    if (!isNum(x.km) || !isNum(x.end)) return false;
    const h = Math.max(0, x.end - x.start) / 3600000;
    return x.km <= Math.min(PLAUSIBLE_KMH, Math.max(isNum(x.top) ? x.top : 0, 30)) * h + 2;
}
// (d: a Date whose getUTC* parts are the local time: Trips#at())
function monthKey(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
function clock(d) { return two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()); }
function when(d) { return d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + '  ' + clock(d); }
// (the tank's level comes in whole litres: under one is "<1 l", not 0)
function litres(l) { return l < 1 ? '<1 l' : G.fmt(l, 0) + ' l'; }
function dur(mins) { const m = Math.round(mins); return m >= 60 ? Math.floor(m / 60) + ' h ' + two(m % 60) + ' min' : m + ' min'; }

module.exports = { Trips, END_MS, RESUME_MS, IDLE_MS, MIN_FUEL_KM, REFUEL_L };
