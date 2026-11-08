'use strict';

// Combo (apps/combo) against stubbed kit modules (mgu, the read-only diagnostic link) and, where a check needs it,
// a clock and timers moved by hand. No SDK, vehicle or capture needed:
//   node kit/tools/test_combo.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'combo');
const MAIN = path.join(APP, 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const { Recorder: Canvas } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));

// the app's link: the last ReadOnlyDiag made (tests drive its replies through link.answer)
let app = null, link = null;
class FakeLink extends EventEmitter {
    constructor() { super(); this.available = false; this.ready = false; this.asked = []; this.answer = () => null; link = this; }
    async init() { return this; }
    silent() { return false; }
    wake() {}
    cancel() {}
    async physical(ecu, sid, data, timeoutMs, accept, opts) {
        this.asked.push({ ecu, sid, data: data.slice(), opts });
        return this.answer(ecu, sid, data);
    }
}
const stubs = {
    './kit/mgu': { run(a) { app = a; } },
    './kit/readonly-diag': { ReadOnlyDiag: FakeLink, MAX_DIDS: 8 },
};
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
// every text drawn (the page's and the cached layers' - panel titles, bar labels) goes to `sink` while it is set;
// the kit's gauges are loaded fresh per boot / module, so their layer cache is empty and titles are drawn again
let sink = null;
const textOf = Canvas.prototype.text;
Canvas.prototype.text = function (str, ...rest) { if (sink) sink.push(String(str)); return textOf.call(this, str, ...rest); };
const freshKit = () => { delete require.cache[path.join(KIT, 'gauges.js')]; };
const appModule = (name) => { freshKit(); const f = path.join(APP, name + '.js'); delete require.cache[f]; return require(f); };
/** Texts drawn by fn() (sync or async). */
async function textsOf(fn) { const out = []; sink = out; try { await fn(); } finally { sink = null; } return out; }

/** Settings as in app.json, with overrides. */
function settingsOf(over) {
    const S = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    Object.assign(S, over || {});
    const handlers = [];
    return { S, get: (k) => S[k], set: (k, v) => { S[k] = v; handlers.forEach((fn) => fn(k, v)); }, onChange: (fn) => handlers.push(fn) };
}

/** One start of the app; draw() renders a frame and returns its texts. */
async function boot(dir, opts) {
    opts = opts || {};
    freshKit();
    delete require.cache[MAIN];
    ['values', 'signals', 'batteries', 'reads', 'draw', 'demo'].forEach((n) => { delete require.cache[path.join(APP, n + '.js')]; });
    require(MAIN);
    const settings = settingsOf(Object.assign({ demo: 'on' }, opts.settings));
    const vis = opts.vis || { shown: true, handlers: [] };
    const clicks = {};
    let frame = null, last = null;
    const ctx = {
        ui: { onClick: (k, fn) => { clicks[k] = fn; }, text() {}, image: async () => {}, isVisible: (n) => n === 'MAIN' && vis.shown, onVisible: (fn) => vis.handlers.push(fn), comp: () => ({}) },
        settings, log: opts.log || { info() {}, warn() {}, error() {} }, spec: SPEC, dataDir: dir,
        signals: { watch: opts.watch || (() => Promise.resolve({ available: false })) },
        onTab() {}, hideButton() {}, onScroll() {}, onTap() {}, loop(n, fps, fn) { frame = fn; },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => { const cv = new Canvas(w, h); cv.own = true; last = cv; return cv; },
    };
    await app.start(ctx);
    return {
        ctx, settings, vis, clicks,
        draw: () => textsOf(() => frame()),
        canvas: () => last,
    };
}

const quiet = { info() {}, warn() {}, error() {} };
const tmp = (name) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'combo-' + name + '-'));

const checks = [
    ['1. columns: four of the same size', async () => {
        const draw = appModule('draw'), cols = draw.columns();
        assert.strictEqual(cols.length, 4);
        assert.deepStrictEqual(cols.map((c) => c.x), [24, 418, 812, 1206]);
        assert(cols.every((c) => c.w === 370 && c.h === cols[0].h && c.y === cols[0].y), JSON.stringify(cols));
    }],
    ['1. skeleton: every panel drawn, demo badge', async () => {
        const b = await boot(tmp('skel'));
        const t = await b.draw();
        ['Engine speed', 'Boost', 'Speed', 'xDrive', '48 V battery', '12 V battery'].forEach((x) => assert(t.includes(x), x + ' missing: ' + t.join(' | ')));
        assert(t.some((x) => /DEMO/i.test(x)), 'no DEMO badge: ' + t.join(' | '));
    }],
    ['1. app.json: its own loggingId, every setting of the design', async () => {
        assert.strictEqual(SPEC.loggingId, 'OAA3');
        const others = fs.readdirSync(path.join(ROOT, 'apps')).filter((d) => d !== 'combo' && fs.existsSync(path.join(ROOT, 'apps', d, 'app.json')))
            .map((d) => JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', d, 'app.json'), 'utf8')).loggingId);
        assert(others.indexOf('OAA3') < 0, 'OAA3 used by another app');
        const want = ['engine', 'redline', 'rpmScale', 'boostMax', 'boostSource', 'maxPower', 'powerSource', 'torqueMax', 'maxTorqueKgm', 'peaks', 'peakHold',
            'xdrive', 'battery48', 'speedUnit', 'pressUnit', 'powerUnit', 'torqueUnit', 'tempUnit', 'theme', 'layout', 'renderer', 'advanced', 'speedRate', 'demo'];
        assert.deepStrictEqual(SPEC.settings.map((s) => s.key), want);
    }],
    ['2. peak hold: kept for peakHold s, 0 = until Reset peaks', async () => {
        const { Values } = appModule('values');
        let clock = 1e6;
        const s = settingsOf({ peakHold: 15 });
        const v = new Values({ settings: s, log: quiet, now: () => clock, dataDir: tmp('peak') });
        v.raise('rpm', 6000); clock += 10000; v.raise('rpm', 3000);
        assert.strictEqual(v.peak('rpm'), 6000, 'held within 15 s');
        clock += 6000; v.raise('rpm', 3000);
        assert.strictEqual(v.peak('rpm'), 3000, 'dropped back after 15 s');
        s.S.peakHold = 0;
        v.raise('rpm', 6500); clock += 600000; v.raise('rpm', 2000);
        assert.strictEqual(v.peak('rpm'), 6500, 'peakHold 0: held');
        v.resetPeaks();
        assert.strictEqual(v.peak('rpm'), undefined, 'Reset peaks clears it');
    }],
    ['2. boost source: sport display once it moves, else the engine unit; the setting wins', async () => {
        const { Values } = appModule('values');
        const s = settingsOf({ boostSource: 'auto' });
        let v = new Values({ settings: s, log: quiet, now: () => 1e6, dataDir: tmp('boost') });
        v.put('boostFes', 0.5); v.put('boostFes', 0.6);
        assert.deepStrictEqual(v.boost(), { value: 0.6, from: 'fes' });
        v = new Values({ settings: s, log: quiet, now: () => 1e6, dataDir: tmp('boost2') });
        v.put('boostDme', 0.8); v.put('boostDme', 0.9);
        assert.deepStrictEqual(v.boost(), { value: 0.9, from: 'dme' });
        s.S.boostSource = 'fes';
        assert.strictEqual(v.boost().value, null, 'Sport display asked, only the engine unit has it');
    }],
    ['2. power: sport display % x max power, or torque x rpm', async () => {
        const { Values } = appModule('values');
        const s = settingsOf({ maxPower: 215 });
        const v = new Values({ settings: s, log: quiet, now: () => 1e6, dataDir: tmp('pw') });
        v.put('powerPct', 50);
        assert.deepStrictEqual(v.power(), { kw: 107.5, calc: false });
        s.S.powerSource = 'calc';
        v.put('torque', 500); v.put('rpm', 4000);
        const p = v.power();
        assert(p.calc && Math.abs(p.kw - 500 * 4000 / 9549) < 1e-9, JSON.stringify(p));
    }],
    ['2. split: the car\'s own, else the transfer case', async () => {
        const { Values } = appModule('values');
        let clock = 1e6;
        const v = new Values({ settings: settingsOf(), log: quiet, now: () => clock, dataDir: tmp('split'), gearRatios: [] });
        v.put('splitRear', 70);
        assert.strictEqual(v.split().rear, 70);
        clock += 11000;
        v.put('lmvFront', 4);
        assert.deepStrictEqual(v.split(), { rear: 100, from: 'transfer case: clutch open', nm: 4 });
    }],
    ['2. signals: the car\'s raw fields scaled as in M Vitals', async () => {
        const { Values } = appModule('values'), { watches } = appModule('signals');
        const v = new Values({ settings: settingsOf(), log: quiet, now: () => 1e6, dataDir: tmp('sig') });
        const S = SPEC.config.scaling;
        const sc = (k, raw) => { const c = S[k]; if (!c || raw == null || raw === c.invalid || (c.invalidFrom != null && raw >= c.invalidFrom)) return null; return raw * c.factor + (c.offset || 0); };
        const engine = { handlers: () => ({}) };
        const w = {};
        watches(v, engine, sc, quiet).forEach(([iface, h]) => { w[iface.split('.').pop()] = h; });
        w.CDS.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 16000 });
        assert.strictEqual(v.live.rpm, 4000);
        w.MDrive.statusMSystem({ statusAllWheelSetup: '_4WD_STANDARD', qualifierFunctionAllWheel: 'FUNKTION_VERFUEGBAR_AKTIV' });
        assert.strictEqual(v.live.awd, '_4WD_STANDARD');
        assert.strictEqual(v.live.awdSeen, true, 'all-wheel drive remembered');
        assert(v.carPresent(), 'a value from the car');
    }],
    ['3. AA56 decode: the 48 V battery, + = charging', async () => {
        const B = appModule('batteries'), F = SPEC.config.battery.b48[0].fields;
        const r = aa56({ v: 4720, a: -105, temp: 48, soc: 66, soh: 96 });
        const b = B.b48(B.fields(r, F));
        assert.deepStrictEqual(Object.assign({}, b, { kw: +b.kw.toFixed(4) }), { soc: 66, v: 47.2, a: 10.5, kw: 0.4956, soh: 96, temp: 24 });
        assert.strictEqual(B.state(b.a), 'CHARGING');
    }],
    ['3. short AA56 reply: missing fields are null, never NaN', async () => {
        const B = appModule('batteries'), F = SPEC.config.battery.b48[0].fields;
        const r = aa56({ v: 4720, a: -105, temp: 48, soc: 66, soh: 96 }).slice(0, 3 + 4);
        const f = B.fields(r, F), b = B.b48(f);
        ['soc', 'soh', 'temp'].forEach((k) => assert.strictEqual(b[k], null, k));
        assert(Object.keys(f).every((k) => f[k] === null || isFinite(f[k])), JSON.stringify(f));
        assert(Object.keys(b).every((k) => b[k] === null || isFinite(b[k])), JSON.stringify(b));
        assert.strictEqual(B.rawShape(r), B.rawShape(r.slice()), 'same shape, same key');
        assert.notStrictEqual(B.rawShape(r), B.rawShape(aa56({ v: 4720 })), 'a longer reply is a new shape');
    }],
    ['3. state: current first, else the 12 V charging voltage', async () => {
        const B = appModule('batteries');
        assert.strictEqual(B.state(null, 14.1), 'CHARGING');
        assert.strictEqual(B.state(null, 12.4), null);
        assert.strictEqual(B.state(0.5), 'IDLE');
        assert.strictEqual(B.state(-6), 'SUPPLYING');
        assert.strictEqual(B.state(null, null), null);
    }],
];

/** A 62 AA 56 reply with eDrive's BATT48 layout: v (0, 2 bytes), a (2, s16), temp (4, s16), soc (14), soh (26). */
function aa56(o) {
    const data = new Array(32).fill(0);
    const w16 = (at, x) => { x = x & 0xFFFF; data[at] = x >> 8; data[at + 1] = x & 0xFF; };
    if (o.v != null) w16(0, o.v);
    if (o.a != null) w16(2, o.a);
    if (o.temp != null) w16(4, o.temp);
    if (o.soc != null) data[14] = o.soc;
    if (o.soh != null) data[26] = o.soh;
    return [0x62, 0xAA, 0x56].concat(data);
}

(async () => {
    let failed = 0;
    for (const [name, fn] of checks) {
        try { await fn(); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.stack || e)); }
    }
    if (failed) { console.log(failed + ' of ' + checks.length + ' Combo checks failed'); process.exit(1); }
    console.log('Combo checks passed (' + checks.length + ').');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

module.exports = { boot, settingsOf, appModule, textsOf, tmp, getLink: () => link, Canvas, themes };
