'use strict';
/**
 * localtime.js - the car's local time for what Cockpit shows (3.1.2). The head unit's own clock runs on UTC, so a
 * Date's local hours there are UTC: the Trips tab showed a 13:29 start as 12:29 in Poland.
 *
 * The offset from UTC comes from the head unit's AutoTime.current (the local date and time as the HMI shows them):
 * that time less the UTC time now, to the nearest 15 minutes, at most 14 h either way. It is kept in localtime.json in
 * the app's data folder, so the times are local from the start, before the car sends it again. Without one (a car that
 * doesn't offer AutoTime to apps, before the first reading): the head unit's own time zone, UTC on the car.
 *
 *   const lt = new LocalTime({ dataDir, log, now })
 *   lt.fromLocal({ date: { day, month, year }, time: { hour, minute, second } })   AutoTime.current as it comes
 *   lt.offsetMs(ms)      the offset now (ms)
 *   lt.at(ms)            a Date whose getUTC* parts are the local time of ms
 */
const fs = require('fs');
const path = require('path');

const STEP_MS = 15 * 60000, MAX_MS = 14 * 3600000;

class LocalTime {
    constructor(o) {
        o = o || {};
        this.log = o.log || { info() {}, warn() {} };
        this.now = o.now || Date.now;
        this.file = o.dataDir ? path.join(o.dataDir, 'localtime.json') : null;
        this.off = null;
        if (this.file) {
            try {
                const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (d && typeof d.offsetMs === 'number' && Math.abs(d.offsetMs) <= MAX_MS) this.off = d.offsetMs;
            } catch (e) { /* none yet */ }
        }
    }

    /** AutoTime.current: { date: { day, month, year }, time: { hour, minute, second } }. Returns the offset taken, or null. */
    fromLocal(v) {
        const d = v && v.date, t = v && v.time;
        const n = (x) => (typeof x === 'number' && isFinite(x) ? x : NaN);
        const y = n(d && d.year), mo = n(d && d.month), da = n(d && d.day), h = n(t && t.hour), mi = n(t && t.minute), s = n(t && t.second);
        if (!(y >= 2000 && y < 2200 && mo >= 1 && mo <= 12 && da >= 1 && da <= 31 && h >= 0 && h < 24 && mi >= 0 && mi < 60)) return null;
        const local = Date.UTC(y, mo - 1, da, h, mi, s >= 0 && s < 60 ? s : 0);
        const off = Math.round((local - this.now()) / STEP_MS) * STEP_MS;
        if (Math.abs(off) > MAX_MS) { this.log.warn('local time: ' + JSON.stringify(v) + ' is ' + Math.round(off / 60000) + ' min from UTC: not taken'); return null; }
        if (off !== this.off) {
            this.log.info('local time: UTC' + fmt(off) + (this.off === null ? '' : ' (was UTC' + fmt(this.off) + ')'));
            this.off = off;
            if (this.file) { try { fs.writeFileSync(this.file, JSON.stringify({ offsetMs: off })); } catch (e) { this.log.warn('local time: ' + e.message); } }
        }
        return off;
    }

    /** The offset from UTC (ms): the car's, else the head unit's own time zone at ms. */
    offsetMs(ms) { return this.off !== null ? this.off : -new Date(ms == null ? this.now() : ms).getTimezoneOffset() * 60000; }
    /** A Date whose getUTC* parts read the local time of ms. */
    at(ms) { return new Date(ms + this.offsetMs(ms)); }
}

function fmt(off) {
    const m = Math.round(off / 60000), a = Math.abs(m);
    return (m < 0 ? '-' : '+') + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : '');
}

module.exports = { LocalTime };
