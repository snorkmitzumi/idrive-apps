'use strict';
/**
 * batteries.js - the 48 V and 12 V battery replies as values (pure functions, no I/O).
 *
 *   fields(reply, cfg)  a 62 <DID> <data> reply decoded with app.json fields ({ at, bytes, factor, offset, signed, min, max },
 *                       as eDrive's readFields): all FF = no value (unsigned fields), outside min..max = null, past the reply's end = null
 *   b48(f)              { soc, v, a, kw, soh, temp }: + = into the battery (charging); v the pack voltage where the
 *                       terminal voltage field doesn't fit. The 48 V battery sends its current
 *                       negative while charging (eDrive's config note), so it is turned round here.
 *   state(a, v)         'CHARGING' | 'SUPPLYING' | 'IDLE' | null: from the current (over +1 A / under -1 A), or without
 *                       one from the voltage (13.2 V and up: the 12 V battery is being charged, eDrive's charging())
 *   rawShape(reply)     a key per reply shape (length + first bytes), to log each new one once (AA56 is not confirmed
 *                       on a car yet)
 */
const CHARGE_V = 13.2;
const DATA_AT = 3;                    // 62 hi lo <data>

function fields(reply, cfg) {
    const out = {};
    Object.keys(cfg || {}).forEach((k) => {
        const f = cfg[k], at = DATA_AT + (f.at || 0), n = f.bytes || 1;
        if (!reply || reply.length < at + n) { out[k] = null; return; }
        let raw = 0;
        for (let j = 0; j < n; j++) raw = raw * 256 + reply[at + j];
        if (!f.signed && raw === Math.pow(256, n) - 1) { out[k] = null; return; }  // all FF: no value (signed FF..FF is -1)
        if (f.signed && raw >= Math.pow(2, 8 * n - 1)) raw -= Math.pow(2, 8 * n);
        const v = raw * (f.factor == null ? 1 : f.factor) + (f.offset || 0);
        out[k] = (f.min != null && v < f.min) || (f.max != null && v > f.max) ? null : v;
    });
    return out;
}

const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);

function b48(f) {
    // the terminal voltage, or the pack's where that field doesn't fit (a G26 M440i's first field reads 2-21)
    const v = num(f.v) !== null ? num(f.v) : num(f.pack), raw = num(f.a), a = raw === null ? null : -raw;
    return { soc: num(f.soc), v, a, kw: v !== null && a !== null ? v * a / 1000 : null, soh: num(f.soh), temp: num(f.temp) };
}

function state(a, v) {
    if (num(a) !== null) return a > 1 ? 'CHARGING' : a < -1 ? 'SUPPLYING' : 'IDLE';
    if (num(v) !== null && v >= CHARGE_V) return 'CHARGING';
    return null;
}

function rawShape(reply) { return (reply ? reply.length : 0) + ':' + (reply || []).slice(0, 4).join(','); }

module.exports = { fields, b48, state, rawShape, CHARGE_V };
