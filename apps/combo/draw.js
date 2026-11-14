'use strict';
/**
 * draw.js - the Combo screen: four columns of the same size, in M Vitals' look (kit/runtime/gauges.js).
 *
 *   1  Engine speed over Boost      2  Speed / Power / Torque      3  xDrive      4  48 V battery over 12 V battery
 *
 *   columns() -> [{ x, y, w, h }] x 4
 *   render(cv, t, d, opts)   d: the frame's values (main.js data()); opts: { settings, peak(k), why(k), redline,
 *                            scaleMax, has48, note (a line in the header, e.g. the Reset peaks confirm) }. A missing value shows "--" and, on the battery panels, why.
 * Units as M Vitals (P, T, PW, TQ, V there): the car's bar, deg C, kW, Nm and km/h converted for the settings.
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');

const LEFT = 24, RIGHT = 1576, GAP = 24, HALF_GAP = 16;
const COL_W = (RIGHT - LEFT - 3 * GAP) / 4;           // 370
const GO = '#2fd27a';
/** boostMax setting -> the boost bar's top in bar, in psi and in kPa (M Vitals' BOOST_MAX) */
const BOOST_MAX = { '2.0': [2, 30, 200], '2.5': [2.5, 36, 250], '3.0': [3, 44, 300], '3.5': [3.5, 50, 350] };
/** Pressure units (values arrive in bar): [factor from bar, label, boost decimals] (M Vitals' PRESS; kPa reads whole) */
const PRESS = { bar: [1, 'bar', 2], psi: [14.5038, 'psi', 1], kpa: [100, 'kPa', 0] };
const AWD = { _4WD_STANDARD: '4WD', _4WD_ALTERNATIV: '4WD Sport', _2WD: '2WD', AWDSAND: 'Sand' };

/** The four columns, left to right: same width and height. */
function columns() {
    const out = [];
    for (let i = 0; i < 4; i++) out.push({ x: LEFT + i * (COL_W + GAP), y: G.TOP, w: COL_W, h: G.BOTTOM - G.TOP });
    return out;
}
/** A column cut into a top and a bottom panel (16 px apart), as M Vitals' Engine speed over Boost. */
function halves(c) {
    const h = (c.h - HALF_GAP) / 2;
    return [{ x: c.x, y: c.y, w: c.w, h }, { x: c.x, y: c.y + h + HALF_GAP, w: c.w, h }];
}

/** Unit conversions for the settings (M Vitals'). */
function units(s) {
    const pk = s.get('pressUnit'), pr = PRESS[pk] || PRESS.bar, psi = pk === 'psi', kpa = pk === 'kpa', f = s.get('tempUnit') === 'f', pu = s.get('powerUnit'), tu = s.get('torqueUnit');
    return {
        psi, kpa, P: (b) => (G.isNum(b) ? b * pr[0] : null), pU: pr[1], pDec: pr[2],
        T: (c) => (G.isNum(c) ? (f ? c * 9 / 5 + 32 : c) : null), tU: f ? '°F' : '°C',
        PW: (kw) => (G.isNum(kw) ? kw * ({ kw: 1, hp: 1.34102, ps: 1.35962 }[pu] || 1) : null), pwU: { kw: 'kW', hp: 'hp', ps: 'PS' }[pu] || 'kW',
        TQ: (nm) => (G.isNum(nm) ? nm * ({ nm: 1, lbft: 0.737562, kgm: 1 / 9.80665 }[tu] || 1) : null), tqU: { nm: 'Nm', lbft: 'lb-ft', kgm: 'kgm' }[tu] || 'Nm',
        V: (k) => (G.isNum(k) ? (s.get('speedUnit') === 'mph' ? k * 0.621371 : k) : null), vU: s.get('speedUnit') === 'mph' ? 'mph' : 'km/h',
    };
}
const withUnit = (v, dec, unit) => (G.isNum(v) ? G.fmt(v, dec) + ' ' + unit : '--');
/** A label on the left, its value on the right (one line of a panel). */
function kv(cv, t, x, y, w, label, value, color) {
    cv.text(label, x, y, 18, t.dim, { font: 'bold', spacing: 1.2 });
    cv.text(value, x + w, y, 22, color || (value === '--' ? t.dim : t.text), { align: 'right', font: 'bold' });
}
/** The big number top right of a panel, with its unit (as G.segBar draws it). */
function bigValue(cv, t, x, y, w, text, unit, color) {
    const uw = unit ? cv.textWidth(' ' + unit, 24) : 0;
    cv.text(text, x + w - 22 - uw, y + 58, 52, color || (text === '--' ? t.dim : t.text), { align: 'right', font: 'num' });
    if (unit) cv.text(' ' + unit, x + w - 22, y + 58, 24, t.dim, { align: 'right' });
}

function render(cv, t, d, opts) {
    const s = opts.settings, u = units(s), pk = (k) => (s.get('peaks') ? opts.peak(k) : undefined);
    G.frame(cv, t, [], 0, [d.demo && { text: 'DEMO' }]);
    if (opts.note) cv.text(opts.note, 800, 25, 20, t.warn, { align: 'center', font: 'bold', spacing: 1 });
    const [c1, c2, c3, c4] = columns();
    engineColumn(cv, t, d, u, pk, s, opts, c1);
    speedColumn(cv, t, d, u, pk, s, c2);
    xdriveColumn(cv, t, d, u, pk, s, c3);
    batteryColumn(cv, t, d, u, s, opts, c4);
}

/* ---------- 1: engine speed over boost ---------- */
function engineColumn(cv, t, d, u, pk, s, opts, c) {
    const [a, b] = halves(c), red = opts.redline, max = opts.scaleMax;
    G.panel(cv, t, a.x, a.y, a.w, a.h, 'Engine speed');
    bigValue(cv, t, a.x, a.y, a.w, G.fmt(d.rpm, 0), 'rpm', G.isNum(d.rpm) && d.rpm >= red ? '#ff4a4a' : null);
    kv(cv, t, a.x + 22, a.y + 88, a.w - 44, 'PEAK', withUnit(pk('rpm'), 0, 'rpm'));
    kv(cv, t, a.x + 22, a.y + 112, a.w - 44, 'GEAR · SHIFT AT', (gearText(d) || '--') + ' · ' + withUnit(red, 0, 'rpm'));
    G.segBar(cv, t, a.x + 22, a.y + 126, a.w - 44, 46, {
        panel: false, value: d.rpm, min: 0, max, step: 500, scale: { every: 2000, div: 1000, size: 20, labelY: 30 }, ramp: 'hot', limit: red,
        marks: [{ value: red, color: 'crit' }], peak: pk('rpm'),
    });
    const bmax = BOOST_MAX[s.get('boostMax')] || BOOST_MAX['2.5'], top = u.psi ? bmax[1] : u.kpa ? bmax[2] : bmax[0], dec = u.pDec;
    G.panel(cv, t, b.x, b.y, b.w, b.h, 'Boost');
    bigValue(cv, t, b.x, b.y, b.w, G.fmt(u.P(d.boost), dec), u.pU);
    kv(cv, t, b.x + 22, b.y + 88, b.w - 44, 'TARGET', withUnit(u.P(d.boostTarget), dec, u.pU));
    kv(cv, t, b.x + 22, b.y + 112, b.w - 44, 'PEAK', withUnit(u.P(pk('boost')), dec, u.pU));
    G.segBar(cv, t, b.x + 22, b.y + 126, b.w - 44, 46, {
        panel: false, value: u.P(d.boost), min: 0, max: top, step: u.psi ? 2 : u.kpa ? 12.5 : 0.125, scale: { every: u.psi ? 10 : u.kpa ? 50 : 0.5, decimals: u.psi || u.kpa ? 0 : 1, size: 20, labelY: 30 },
        ramp: 'hot', limit: top * 0.85, marks: [{ value: top * 0.85, color: 'warn' }], peak: u.P(pk('boost')),
    });
}
/** D / S / M + gear (R, N, P alone), as M Vitals' gearText(). */
function gearText(d) {
    const st = d.stage, m = d.gearMode;
    if (st === 'P' || st === 'R' || st === 'N') return st;
    const g = d.gear, letter = m === 'S' || m === 'M' ? m : 'D';
    if (!G.isNum(g)) return st === 'D' ? letter : null;
    if (g < 0) return 'R';
    if (g === 0) return st === 'D' ? letter : 'N';
    return letter + g;
}

/* ---------- 2: speed, power, torque ---------- */
function speedColumn(cv, t, d, u, pk, s, c) {
    const ph = 190;
    G.panel(cv, t, c.x, c.y, c.w, ph, 'Speed');
    const sp = u.V(G.hold('combo.speed', d.speed, 1000 / (s.get('speedRate') || 10)));
    const sw = cv.text(G.fmt(sp, 0), c.x + 22, c.y + 160, 84, G.isNum(sp) ? t.text : t.dim, { font: 'num' });
    cv.text(u.vU, c.x + 30 + sw, c.y + 160, 24, t.dim);
    const gr = gearText(d);
    if (gr) cv.text(gr, c.x + c.w - 22, c.y + 160, 96, gr[0] === 'M' ? t.crit : gr[0] === 'S' ? t.accent : t.text, { align: 'right', font: 'gear' });
    const pw = d.power || {}, tq = s.get('torqueUnit') === 'kgm' ? (s.get('maxTorqueKgm') || 100) : u.TQ(s.get('torqueMax') || 900);
    const py = c.y + ph + 24, gap = 132;
    G.bar(cv, t, c.x, py, c.w, 92, { label: pw.calc ? 'Power (calc)' : 'Power', value: u.PW(pw.kw), unit: u.pwU, max: u.PW(s.get('maxPower')), niceMax: true, ramp: 'hot', peak: u.PW(pk('power')), peakText: true });
    G.bar(cv, t, c.x, py + gap, c.w, 92, { label: 'Torque', value: u.TQ(d.torque), unit: u.tqU, decimals: s.get('torqueUnit') === 'kgm' ? 1 : 0, max: tq, niceMax: false, ramp: 'hot', peak: u.TQ(pk('torque')), peakText: true });   // ends at the setting
}

/* ---------- 3: xDrive ---------- */
function xdriveColumn(cv, t, d, u, pk, s, c) {
    G.panel(cv, t, c.x, c.y, c.w, c.h, 'xDrive');
    if (s.get('xdrive') === 'off') {
        cv.text('RWD', c.x + 22, c.y + 116, 52, t.text, { font: 'bold' });
        cv.text('xDrive card hidden in Settings', c.x + 22, c.y + 150, 18, t.dim);
        return;
    }
    const hot = d.awdQual === 'FUNKTION_NICHT_VERFUEGBAR_FEHLER', sp = d.split || {};
    cv.text(AWD[d.awd] || '--', c.x + 22, c.y + 104, 44, hot ? t.crit : AWD[d.awd] ? t.text : t.dim, { font: 'bold' });
    if (hot) cv.text('DERATED / OFF', c.x + 22, c.y + 134, 20, t.crit, { font: 'bold', spacing: 1.5 });
    else if (sp.from) cv.text(sp.from, c.x + 22, c.y + 134, 18, t.dim);
    kv(cv, t, c.x + 22, c.y + 168, c.w - 44, 'FRONT AXLE', withUnit(u.TQ(sp.nm), 0, u.tqU));
    kv(cv, t, c.x + 22, c.y + 194, c.w - 44, 'FRONT PEAK', withUnit(u.TQ(pk('lmvFront')), 0, u.tqU));
    // wheel slip: the front axle's wheels against the rear's (+ = the front turns faster), above 5 km/h
    kv(cv, t, c.x + 22, c.y + 220, c.w - 44, 'AXLE SLIP', G.isNum(d.slip) ? (d.slip > 0 ? '+' : '') + G.fmt(d.slip, 1) + ' %' : '--');
    const rear = sp.rear;
    G.bar(cv, t, c.x + 22, c.y + 240, c.w - 44, 92, { label: 'Rear', value: rear, unit: '%', ramp: 'hot' });
    G.bar(cv, t, c.x + 22, c.y + 350, c.w - 44, 92, { label: 'Front', value: G.isNum(rear) ? 100 - rear : null, unit: '%', ramp: 'hot' });
}

/* ---------- 4: 48 V battery over 12 V battery ---------- */
function batteryColumn(cv, t, d, u, s, opts, c) {
    const show48 = s.get('battery48') === 'on' || (s.get('battery48') !== 'off' && opts.has48 !== false);
    if (!show48) { battery(cv, t, c, '12 V battery', d.b12, 'b12', u, opts); return; }
    const [a, b] = halves(c);
    battery(cv, t, a, '48 V battery', d.b48, 'b48', u, opts);
    battery(cv, t, b, '12 V battery', d.b12, 'b12', u, opts);
}
const STATE_COLOR = (t, st) => (st === 'CHARGING' ? GO : st === 'SUPPLYING' ? t.warn : t.dim);
function battery(cv, t, box, title, x, key, u, opts) {
    const B = require('./batteries');
    G.panel(cv, t, box.x, box.y, box.w, box.h, title);
    const is48 = key === 'b48', v = x || {}, st = B.state(v.a, is48 ? null : v.v), any = G.isNum(v.soc) || G.isNum(v.v);
    const r = box.x + box.w - 22, l = box.x + 22;
    if (st) cv.text(st, r, box.y + 42, 20, STATE_COLOR(t, st), { align: 'right', font: 'bold', spacing: 1.5 });
    cv.text('CHARGE', l, box.y + 76, 18, t.dim, { font: 'bold', spacing: 1.2 });
    const pw = cv.text(G.fmt(v.soc, 0), l, box.y + 130, 56, G.isNum(v.soc) ? t.text : t.dim, { font: 'num' });
    cv.text('%', l + 6 + pw, box.y + 130, 24, t.dim, { font: 'bold' });
    const sign = (n, dec, unit) => (G.isNum(n) ? (n > 0 ? '+' : '') + G.fmt(n, dec) + ' ' + unit : '--');
    cv.text(withUnit(v.v, is48 ? 1 : 2, 'V') + '  ·  ' + (is48 ? sign(v.kw, 2, 'kW') : sign(v.a, 1, 'A')), r, box.y + 100, 22, any ? t.text : t.dim, { align: 'right', font: 'bold' });
    // the charge as 10 segments, as eDrive's battery icon
    const sy = box.y + 150, sw = (box.w - 44) / 10, f = G.isNum(v.soc) ? G.clamp(v.soc / 100, 0, 1) : 0;
    const col = !G.isNum(v.soc) ? t.tick : v.soc < 25 ? t.crit : v.soc < 45 ? t.warn : GO;
    for (let k = 0; k < 10; k++) cv.roundRect(l + k * sw, sy, sw - 5, 24, 3, f * 10 > k + 0.05 ? col : withAlpha(t.track || '#333', 0.9));
    // under the charge: health and temperature, or why there is nothing to show
    const ht = (G.isNum(v.soh) ? G.fmt(v.soh, 0) + ' %' : '--') + ' · ' + withUnit(u.T(v.temp), 0, u.tU);
    if (any) kv(cv, t, l, box.y + 204, box.w - 44, 'HEALTH · TEMP', ht);
    else cv.text(opts.why(key), l, box.y + 204, 18, t.dim);
}

module.exports = { columns, halves, render, units, gearText, COL_W };
