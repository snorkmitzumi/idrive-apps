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
let app = null, link = null, stubDiag = null;
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
    // the read-only link's private Diag (check '4. timing options reach the link')
    if (req === './diag' && stubDiag && parent && /readonly-diag\.js$/.test(parent.filename)) return Object.assign({}, load.call(this, req, parent, isMain), { Diag: stubDiag });
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

// every app started by boot(): hidden after each check, so its diagnostic reader stops (it keeps running otherwise)
const booted = [];
/** One start of the app; draw() renders a frame and returns its texts. */
async function boot(dir, opts) {
    opts = opts || {};
    freshKit();
    delete require.cache[MAIN];
    ['values', 'signals', 'batteries', 'reads', 'draw', 'demo'].forEach((n) => { delete require.cache[path.join(APP, n + '.js')]; });
    require(MAIN);
    const settings = settingsOf(Object.assign({ demo: 'on' }, opts.settings));
    const vis = opts.vis || { shown: true, handlers: [] };
    booted.push(vis);
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
    ['4. hidden: no reads', async () => {
        const r = await rig({ shown: false, driving: true });
        await r.run(60000);
        assert.strictEqual(r.asked.length, 0, r.asked.map((q) => q.key).join(' '));
        r.done();
    }],
    ['4. hidden during a round: nothing scheduled', async () => {
        const r = await rig({ driving: true, hold: true });
        r.start();
        const pending = r.step();                   // a round starts, its first read waits
        r.ui.vis = false;                           // another app opened meanwhile
        r.release(); await pending; await r.flush();
        assert(!r.timers.some((x) => x.ms < 60000), 'a round scheduled while hidden: ' + r.timers.map((x) => x.ms));
        r.done();
    }],
    ['4. shown again: a round at once', async () => {
        const r = await rig({ shown: false, driving: true });
        r.start(); await r.run(60000);
        r.ui.vis = true; r.reads.opened();
        assert(r.timers.some((x) => x.ms === 0), 'no round at once: ' + r.timers.map((x) => x.ms));
        r.done();
    }],
    ['4. parked: reads stop after 10 min', async () => {
        const r = await rig({ driving: false });
        r.start(); await r.run(9 * 60000);
        const n = r.asked.length;
        assert(n > 0, 'reads in the first 10 min');
        await r.run(2 * 60000);
        const late = r.asked.slice(n).filter((q) => q.t > r.t0 + 600000 + 3000);
        assert.strictEqual(late.length, 0, 'reads after 10 min parked: ' + late.map((q) => q.key).join(' '));
        assert.strictEqual(r.reads.why('b48'), 'paused - parked');
        r.done();
    }],
    ['4. tiers: the fast values get most of the link', async () => {
        const r = await rig({ driving: true });
        r.values.put('boostFes', 0.5); r.values.put('boostFes', 0.6);       // the sport display's boost works
        r.values.live.awdSeen = true;
        r.start();
        for (let s = 0; s < 10; s++) { r.values.put('splitRear', 70); await r.run(1000); }
        const n = (k) => r.asked.filter((q) => q.key === k).length;
        assert(n('25:DB32') >= 9 && n('25:DB32') <= 11, 'front-axle torque every 1 s with the car\'s split: ' + n('25:DB32'));
        assert(n('2:AA56') >= 3 && n('2:AA56') <= 5, '48 V every 2.5 s: ' + n('2:AA56'));
        assert.strictEqual(n('18:40AD'), 1, '12 V charge every 30 s');
        assert.strictEqual(n('18:F470'), 0, 'no engine unit boost while the sport display has it');
        assert(r.reads.bat.b48 && r.reads.bat.b48.soc === 66, JSON.stringify(r.reads.bat.b48));
        assert.strictEqual(r.values.live.lmvFront, 39.5);
        r.done();
    }],
    ['4. no 48 V: given up, 12 V full column', async () => {
        const r = await rig({ driving: true, no48: true });
        r.start(); await r.run(20000);
        assert.strictEqual(r.reads.bat.has48, false, 'not given up');
        const n = r.asked.filter((q) => q.key === '2:AA56').length;
        assert(n <= 4, 'asked ' + n + 'x before giving up (another unit answered: 3)');
        await r.run(4 * 60000);
        assert.strictEqual(r.asked.filter((q) => q.key === '2:AA56').length, n, 'asked again within 5 min');
        assert.strictEqual(r.reads.why('b48'), 'no 48 V battery');
        r.done();
    }],
    ['4. demo on screen: no reads', async () => {
        const r = await rig({ driving: true, active: false });
        r.start(); await r.run(30000);
        assert.strictEqual(r.asked.length, 0, r.asked.map((q) => q.key).join(' '));
        r.done();
    }],
    ['4. timing options reach the link', async () => {
        let got = null;
        stubDiag = class { constructor() { this.p = {}; } async init() {} async physical(target, sid, data, timeoutMs, accept, opts) { got = opts; return [0x62, 0xF4, 0x42, 0x37, 0x14]; } };
        delete require.cache[path.join(KIT, 'readonly-diag.js')];
        const { ReadOnlyDiag } = require(path.join(KIT, 'readonly-diag.js'));
        const l = new ReadOnlyDiag({}, quiet);
        await l.physical(0x12, 0x22, [0xF4, 0x42], 1000, null, { pendingTimeoutMs: 1500, retryBaseMs: 150, callTimeoutMs: 2000, other: 1 });
        stubDiag = null;
        assert.deepStrictEqual(got, { pendingTimeoutMs: 1500, retryBaseMs: 150, callTimeoutMs: 2000 });
    }],
    ['5. real values: every column shows the car\'s numbers', async () => {
        const t = await page(car());
        ['4123', '1.27', 'TARGET', '1.35', 'CHARGE', '66', '84', 'CHARGING', 'FRONT AXLE', '4WD Sport', 'POWER', 'TORQUE'].forEach((x) => assert(has(t, x), x + ' missing: ' + t.join(' | ')));
        assert(!t.some((x) => /NaN|undefined|null/.test(x)), t.join(' | '));
    }],
    ['5. missing values: -- and the reason, never NaN', async () => {
        const d = car(); d.b48 = null; d.b12 = { soc: null, v: null, a: null, soh: null, temp: null }; d.boost = null; d.split = { rear: null, from: null };
        const t = await page(d, {}, { why: (k) => (k === 'b48' ? 'reading…' : 'no reply') });
        assert(t.includes('--'), 'no --: ' + t.join(' | '));
        assert(t.some((x) => x.indexOf('reading…') >= 0), 'no reason for the 48 V battery: ' + t.join(' | '));
        assert(!t.some((x) => /NaN|undefined|null/.test(x)), t.join(' | '));
    }],
    ['5. units: psi / °F / hp / lb-ft', async () => {
        const d = car(); d.boost = 1.0; d.b48.temp = 24; d.power = { kw: 100, calc: false }; d.split.nm = 100;
        const t = await page(d, { pressUnit: 'psi', tempUnit: 'f', powerUnit: 'hp', torqueUnit: 'lbft' });
        ['14.5', '75', '134', '74'].forEach((x) => assert(has(t, x), x + ' missing: ' + t.join(' | ')));
        ['psi', 'hp', 'lb-ft'].forEach((x) => assert(has(t, x), x + ' unit missing'));
        assert(t.some((x) => x.indexOf('°F') >= 0), '°F missing');
    }],
    ['5. no 48 V: the 12 V battery takes the column', async () => {
        const t = await page(car(), {}, { has48: false });
        assert(!t.includes('48 V battery'), '48 V panel drawn');
        assert(t.includes('12 V battery'));
    }],
    ['5. RWD: xDrive hidden in Settings', async () => {
        const t = await page(car(), { xdrive: 'off' });
        assert(t.includes('RWD'), t.join(' | '));
        assert(!has(t, 'FRONT AXLE'));
    }],
];

/** Car signals for boot(): the engine speed (rpm) the next statusEngineSpeed2 notification sends. */
function engineSignal(state) {
    return (iface, inst, h) => {
        if (/\.CDS$/.test(iface)) state.send = (rpm) => h.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: rpm * 4 });
        return Promise.resolve({ iface, available: true });
    };
}
checks.push(
    ['6. Reset peaks: asks first, the second press within 6 s clears', async () => {
        const realNow = Date.now;
        let clock = realNow();
        Date.now = () => clock;
        try {
            const sig = {}, b = await boot(tmp('reset'), { settings: { demo: 'off' }, watch: engineSignal(sig) });
            sig.send(6000); sig.send(3000);
            let t = await b.draw();
            assert(t.includes('6000 rpm'), 'the peak shown: ' + t.join(' | '));
            await b.clicks.BTN_RESET();
            t = await b.draw();
            assert(t.includes('6000 rpm'), 'one press reset it');
            assert(t.some((x) => /Press again to reset peaks/.test(x)), 'no confirm note: ' + t.join(' | '));
            clock += 7000; sig.send(3000);
            await b.clicks.BTN_RESET();                  // too late: only asks again
            t = await b.draw();
            assert(t.includes('6000 rpm') || !t.includes('3000 rpm'), 'reset after 7 s');
            clock += 1000;
            await b.clicks.BTN_RESET();
            sig.send(3000);
            t = await b.draw();
            assert(t.includes('3000 rpm') && !t.includes('6000 rpm'), 'not reset: ' + t.join(' | '));
        } finally { Date.now = realNow; }
    }],
    ['6. on a car: no demo once a signal arrives', async () => {
        const sig = {}, b = await boot(tmp('car'), { settings: { demo: 'auto' }, watch: engineSignal(sig) });
        sig.send(4123);
        const t = await b.draw();
        assert(!t.some((x) => /DEMO/.test(x)), 'DEMO shown on a car');
        assert(t.includes('4123'), 'the car\'s rpm: ' + t.join(' | '));
    }],
);

/** A frame of real (not demo) values, as main.js data() hands them to draw.render(). */
function car() {
    return { demo: false, rpm: 4123, boost: 1.27, boostTarget: 1.35, speed: 188, gear: 4, gearMode: 'D', stage: 'D',
        power: { kw: 185, calc: false }, torque: 671, split: { rear: 86, from: null, nm: 118 }, awd: '_4WD_ALTERNATIV', awdQual: 'FUNKTION_VERFUEGBAR_AKTIV',
        b48: { soc: 66, v: 47.2, a: 10.5, kw: 0.4956, soh: 96, temp: 24 }, b12: { soc: 84, v: 14.1, a: 1.6, soh: 92, temp: 19 } };
}
/** The texts of one frame drawn by draw.render(d). */
async function page(d, over, opts) {
    const draw = appModule('draw'), settings = settingsOf(Object.assign({ demo: 'off' }, over));
    const cv = new Canvas(1600, 520), t = themes.theme('m_tricolour');
    const o = Object.assign({ settings, peak: (k) => ({ rpm: 6850, boost: 1.68, power: 241, torque: 702, lmvFront: 433 })[k], why: () => 'reading…',
        redline: 7000, scaleMax: 8000, has48: true }, opts);
    return textsOf(() => draw.render(cv, t, d, o));
}
/** A number or word shown on its own (not as part of a longer number). */
const has = (texts, s) => texts.some((x) => new RegExp('(^|[^0-9.])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^0-9])').test(x));

/**
 * The reader with fake timers and clock, a fake link (every unit answers with sample replies unless told otherwise)
 * and the app's own config. run(ms) fires the timers due within ms, in order, moving the clock.
 */
async function rig(o) {
    const real = { set: global.setTimeout, clear: global.clearTimeout };
    let clock = 1e9;
    const t0 = clock, timers = [];
    global.setTimeout = (fn, ms) => { const tm = { fn, ms, at: clock + (ms || 0) }; timers.push(tm); return tm; };
    global.clearTimeout = (tm) => { const i = timers.indexOf(tm); if (i >= 0) timers.splice(i, 1); };
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res)); };
    const settings = settingsOf(o.settings);
    const { Values } = appModule('values'), { Reads } = appModule('reads');
    const { DidReader } = require(path.join(KIT, 'dids.js'));
    const values = new Values({ settings, log: quiet, now: () => clock, dataDir: tmp('reads') });
    if (o.driving) { values.put('speed', 50); values.put('rpm', 2000); }
    const asked = [];
    let gate = null, release = () => {};
    const lk = {
        available: true,
        async physical(ecu, sid, data) {
            const key = ecu + ':' + (sid === 0x22 ? data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('') : 'OBD ' + data[0].toString(16).toUpperCase());
            asked.push({ key, t: clock });
            if (gate) await gate;
            return answer(ecu, sid, data, o);
        },
    };
    if (o.hold) gate = new Promise((res) => { release = () => { gate = null; res(); }; });
    const ui = { vis: o.shown !== false, isVisible: (n) => n === 'MAIN' && ui.vis };
    const reads = new Reads({ link: lk, reader: new DidReader(lk), values, settings, cfg: SPEC.config, ui, log: quiet, now: () => clock, dataDir: tmp('reads-data'),
        active: o.active === false ? () => false : undefined });
    // keep the car driving while time moves (the signals would)
    const keep = () => { if (o.driving) { values.put('speed', 50); values.put('rpm', 2000); } };
    const next = () => timers.slice().sort((a, b) => a.at - b.at)[0];
    return {
        reads, values, ui, asked, timers, t0, flush,
        start: () => reads.start(),
        release: () => release(),
        step: () => { const tm = next(); timers.splice(timers.indexOf(tm), 1); clock = Math.max(clock, tm.at); return Promise.resolve(tm.fn()); },
        async run(ms) {
            const end = clock + ms;
            for (let guard = 0; guard < 100000; guard++) {
                const tm = next();
                if (!tm || tm.at > end) break;
                timers.splice(timers.indexOf(tm), 1);
                clock = Math.max(clock, tm.at); keep();
                await tm.fn(); await flush();
            }
            clock = end; keep();
        },
        done: () => { global.setTimeout = real.set; global.clearTimeout = real.clear; },
    };
}

/** Sample replies: front-axle torque 39.5 Nm, the 48 V battery (66 %), 12.6 V / +1.6 A, the 12 V charge 84 %. */
function answer(ecu, sid, data, o) {
    const did = sid === 0x22 ? (data[0] << 8) | data[1] : null;
    if (ecu === 25 && did === 0xDB32) return [0x62, 0xDB, 0x32, 0x00, 0x9E, 0x00, 0x02, 0x00, 0x98, 0x00, 0x20];
    if (ecu === 2 && did === 0xAA56) return o.no48 ? null : aa56({ v: 4720, a: -105, temp: 48, soc: 66, soh: 96 });
    if (ecu === 18 && did === 0xF442) return [0x62, 0xF4, 0x42, 12600 >> 8, 12600 & 0xFF];
    if (ecu === 18 && did === 0x5852) { const raw = Math.round((1.6 + 200) / 0.02); return [0x62, 0x58, 0x52, raw >> 8, raw & 0xFF]; }
    if (ecu === 18 && did === 0x40AD) return [0x62, 0x40, 0xAD, 84, 0, 80, 0, 79, 0, 78, 0, 77, 0, 76].concat(new Array(12).fill(0));
    if (ecu === 18 && did === 0x5854) return [0x62, 0x58, 0x54, Math.round((19 + 48) / 0.75)];
    if (ecu === 18 && did === 0x59AA) return [0x62, 0x59, 0xAA, 92];
    if (ecu === 18 && did === 0xF433) return [0x62, 0xF4, 0x33, 100];
    if (ecu === 18 && did === 0x4AB0) { const raw = Math.round(235 / 0.00390625); return [0x62, 0x4A, 0xB0, raw >> 8, raw & 0xFF]; }
    if (sid === 0x22) return [0x7F, 0x22, 0x31];
    return null;
}

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
    const realTimers = { set: global.setTimeout, clear: global.clearTimeout };
    for (const [name, fn] of checks) {
        try { await fn(); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.stack || e)); }
        global.setTimeout = realTimers.set; global.clearTimeout = realTimers.clear;      // a check that failed half-way
        booted.forEach((v) => { v.shown = false; });
    }
    if (failed) { console.log(failed + ' of ' + checks.length + ' Combo checks failed'); process.exit(1); }
    console.log('Combo checks passed (' + checks.length + ').');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

module.exports = { boot, settingsOf, appModule, textsOf, tmp, getLink: () => link, Canvas, themes };
