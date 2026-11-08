'use strict';
/**
 * values.js - what the car has sent (signals) and what was read (diagnostic link), with plausibility, peaks and the
 * choices M Vitals makes between sources. Copied from apps/car_vitals/main.js (named per function), so the two
 * apps show the same numbers.
 *
 *   const v = new Values({ settings, log, now, dataDir, gearRatios })
 *   v.put(key, value)   v.raise(key, value)   v.peak(key)   v.resetPeaks()
 *   v.boost() -> { value, from }   v.power() -> { kw, calc }   v.split() -> { rear, from, nm }
 *   v.carPresent()   v.live (raw fields)   v.subs (signal subscriptions, for carPresent)
 */
const fs = require('fs');
const path = require('path');
const { GearGuess } = require('./kit/car');

const isNum = (x) => typeof x === 'number' && isFinite(x);
// plausible ranges: outside = the car's "no data" marker (M Vitals' RANGE, the keys used here)
const RANGE = { rpm: [0, 12000], boostFes: [-1, 4], boostDme: [-1, 4], boostTarget: [-1, 4] };
// sources some cars never fill (stuck at one number): they count once they changed this much (M Vitals' MOVE)
const MOVE = { boostFes: 0.03, boostDme: 0.03 };
const SPLIT_STALE = 10000;            // the car's split this old no longer counts (M Vitals)
const LMV_FRESH = 3000;               // a front-axle torque this old no longer counts (M Vitals)
const PEAKS = ['rpm', 'boost', 'power', 'torque', 'lmvFront'];

class Values {
    constructor(opts) {
        this.settings = opts.settings; this.log = opts.log;
        this.now = opts.now || (() => Date.now());
        this.gearRatios = opts.gearRatios || [];
        this.live = { awdSeen: false };
        this.peaks = {}; this.peakAt = {};
        this.first = {}; this.moved = {};
        this.lastCar = 0; this.splitAt = 0;
        this.subs = [];
        this.guess = new GearGuess();
        this.awdFile = opts.dataDir ? path.join(opts.dataDir, 'awd.json') : null;
        this.seenFile = opts.dataDir ? path.join(opts.dataDir, 'seen.json') : null;
        this.seen = {};
        try { this.live.awdSeen = !!JSON.parse(fs.readFileSync(this.awdFile, 'utf8')).seen; } catch (e) { /* not yet */ }
        try { this.seen = JSON.parse(fs.readFileSync(this.seenFile, 'utf8')) || {}; } catch (e) { /* not yet */ }
    }

    /** A value from the car (from M Vitals' put()): plausible ones are kept, peaks raised, the gear guessed. */
    put(k, v) {
        if (v === null || v === undefined || !isFinite(v)) return;
        this.lastCar = this.now();
        const r = RANGE[k];
        if (r && (v < r[0] || v > r[1])) return;
        if (MOVE[k] != null) {
            if (this.first[k] === undefined) this.first[k] = v;
            else if (!this.moved[k] && Math.abs(v - this.first[k]) >= MOVE[k]) { this.moved[k] = true; this.remember(k); }
        }
        const L = this.live;
        L[k] = v;
        if (k === 'rpm') L.rpmT = this.now();
        if (k === 'lmvFront') L.lmvT = this.now();
        if (k === 'splitRear') this.splitAt = this.now();
        if (k === 'rpm' || k === 'torque') {
            // crankshaft torque x speed, when the car sends no sport-display power (M Vitals)
            if (isNum(L.torque) && isNum(L.rpm)) L.powerCalc = Math.max(0, L.torque * L.rpm / 9549);
        }
        if ((k === 'rpm' || k === 'speed') && isNum(L.rpm) && isNum(L.speed)) {
            const g = this.guess.feed(L.rpm, L.speed);
            L.gearGuess = L.speed < 3 ? null : g;        // nothing at a standstill: P, N and D look the same
        }
        if (k === 'boostFes' || k === 'boostDme') { const b = this.boost().value; if (b !== null) this.raise('boost', b); }
        else if (PEAKS.indexOf(k) >= 0) this.raise(k, v);
    }

    /** A value counts once it changed this session or the car is known to send it (M Vitals' trusted()). */
    trusted(k) { return MOVE[k] == null || !!this.moved[k] || !!this.seen[k]; }
    remember(k) {
        if (this.seen[k]) return;
        this.seen[k] = true;
        this.log.info('real data from the car: ' + k);
        try { if (this.seenFile) fs.writeFileSync(this.seenFile, JSON.stringify(this.seen)); } catch (e) { this.log.warn('seen save: ' + e); }
    }
    /** All-wheel drive seen (M Vitals' markAwd): kept, so Auto shows xDrive from the start next time. */
    markAwd() {
        if (this.live.awdSeen) return;
        this.live.awdSeen = true;
        this.log.info('all-wheel drive detected');
        try { if (this.awdFile) fs.writeFileSync(this.awdFile, JSON.stringify({ seen: true })); } catch (e) { this.log.warn('awd save: ' + e); }
    }

    /** M Vitals' raise(): a peak follows new highs; peakHold s after it was last raised it drops back (0 = until reset). */
    raise(k, v) {
        if (!isNum(v)) return;
        const now = this.now(), hold = (this.settings.get('peakHold') || 0) * 1000;
        if (this.peaks[k] === undefined || v >= this.peaks[k] || (hold > 0 && now - (this.peakAt[k] || 0) > hold)) { this.peaks[k] = v; this.peakAt[k] = now; }
    }
    peak(k) { return this.peaks[k]; }
    resetPeaks() { this.peaks = {}; this.peakAt = {}; }

    /** M Vitals' updBoost(): the setting's source; Auto: the sport display if it works, else the engine unit. */
    boost() {
        const src = this.settings.get('boostSource'), L = this.live;
        const fes = isNum(L.boostFes) ? L.boostFes : null, dme = isNum(L.boostDme) ? L.boostDme : null;
        if (src === 'fes') return { value: fes, from: fes === null ? null : 'fes' };
        if (src === 'dme') return { value: dme, from: dme === null ? null : 'dme' };
        if (fes !== null && this.trusted('boostFes')) return { value: fes, from: 'fes' };
        if (dme !== null && this.trusted('boostDme')) return { value: dme, from: 'dme' };
        return { value: null, from: null };
    }
    /** Boost still needed from the engine unit (M Vitals' boostFromDme(), without its config check). */
    boostFromDme() {
        const src = this.settings.get('boostSource');
        return src === 'dme' || (src !== 'fes' && !(isNum(this.live.boostFes) && this.trusted('boostFes')));
    }

    /** M Vitals' power(): the sport display's % x max power, else torque x rpm. */
    power() {
        const L = this.live;
        if (this.settings.get('powerSource') !== 'calc' && isNum(L.powerPct)) return { kw: L.powerPct / 100 * this.settings.get('maxPower'), calc: false };
        return { kw: isNum(L.powerCalc) ? L.powerCalc : null, calc: true };
    }

    /** The car's own split is fresh (then the transfer case only gives the Nm). */
    carSplit() { return isNum(this.live.splitRear) && this.now() - this.splitAt < SPLIT_STALE; }
    /** M Vitals' xdriveSplit(): the car's split, else the transfer case against what the gearbox puts out, else 2WD. */
    split() {
        const L = this.live, now = this.now();
        const nm = isNum(L.lmvFront) && now - (L.lmvT || 0) < LMV_FRESH ? L.lmvFront : undefined;
        if (this.carSplit()) return nm === undefined ? { rear: L.splitRear, from: null } : { rear: L.splitRear, from: null, nm };
        if (nm !== undefined) {
            const ratio = this.gearRatios[(L.gear || 0) - 1];
            const input = isNum(L.torque) && ratio ? L.torque * ratio : null;
            if (nm <= 5) return { rear: 100, from: 'transfer case: clutch open', nm };
            if (input > 50) return { rear: 100 - Math.max(0, Math.min(100, nm / input * 100)), from: 'transfer case, estimated', nm };
            return { rear: null, from: 'transfer case', nm };
        }
        if (L.awd === '_2WD') return { rear: 100, from: '2WD mode' };
        return { rear: null, from: null };
    }

    /** The car is there: a value arrived, or a signal's provider is available (M Vitals' carPresent()). */
    carPresent() { return this.lastCar > 0 || this.subs.some((s) => s.available); }
}

module.exports = { Values, isNum, PEAKS };
