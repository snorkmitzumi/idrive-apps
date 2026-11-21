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
// Ambient config's tabs (shared/ambient_config/ambient_page.js, taken at build time): a stand-in that records what the
// app asks of it; test_ambient_*.js check the real one
const fakeAmb = {
    calls: [], page: 0,
    tabs: () => ['Ambient', 'Animations', 'Modes'],
    draw(cv, t) { cv.text('AMBIENT TAB ' + this.page, 100, 100, 20, t.text); },
    select(i) { this.page = i; this.calls.push('select ' + i); }, tap(x, y) { this.calls.push('tap ' + x + ',' + y); },
    wants: () => true, leave() { this.calls.push('leave'); }, dirty() {}, original() { this.calls.push('original'); },
};
const stubs = {
    './kit/mgu': { run(a) { app = a; } },
    './ambient_page': { background: async (bg, o) => { fakeAmb.calls.push('background ' + JSON.stringify(o)); return {}; },
        mount: (ctx, parts, o) => { fakeAmb.calls.push('mount ' + JSON.stringify({ strobe: o.strobe, names: o.names })); fakeAmb.page = 0; return fakeAmb; } },
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
// the page's buttons (G.button) as the kit's Recorder keeps them, so a check can press one
Canvas.prototype.target = function (x, y, w, h, run, key) { (this.targets || (this.targets = [])).push({ x, y, w, h, run, key: String(key) }); return this; };
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
    ['values', 'signals', 'batteries', 'reads', 'draw', 'demo', 'mview'].forEach((n) => { delete require.cache[path.join(APP, n + '.js')]; });
    require(MAIN);
    const settings = settingsOf(Object.assign({ demo: 'on' }, opts.settings));
    const vis = opts.vis || { shown: true, handlers: [] };
    booted.push(vis);
    const clicks = {};
    let frame = null, last = null, tab = null, tap = null;
    const hidden = [];
    const ctx = {
        ui: { onClick: (k, fn) => { clicks[k] = fn; }, text() {}, image: async () => {}, isVisible: (n) => n === 'MAIN' && vis.shown, onVisible: (fn) => vis.handlers.push(fn), comp: () => ({}) },
        settings, log: opts.log || { info() {}, warn() {}, error() {} }, spec: SPEC, dataDir: dir,
        signals: { watch: opts.watch || (() => Promise.resolve({ available: false })) },
        onTab(fn) { tab = fn; }, hideButton(id) { hidden.push(id); }, onScroll() {}, onTap(fn) { tap = fn; }, loop(n, fps, fn) { frame = fn; },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => { const cv = new Canvas(w, h); cv.own = opts.own !== false; last = cv; return cv; },
    };
    await app.start(ctx);
    return {
        ctx, settings, vis, clicks,
        draw: () => textsOf(() => frame()),
        tab: (i) => textsOf(() => tab(i)), tap: (x, y) => tap(x, y), hidden,
        /** press the page button with this key (drawn on the last frame) */
        press: (key) => { const b = ((last && last.targets) || []).find((x) => x.key === key); assert(b, 'no button ' + key + ': ' + ((last && last.targets) || []).map((x) => x.key).join(' ')); return textsOf(() => b.run()); },
        canvas: () => last,
    };
}

const quiet = { info() {}, warn() {}, error() {} };
const G_isNum = (x) => typeof x === 'number' && isFinite(x);
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
            'xdrive', 'battery48', 'weight', 'body', 'loss', 'ecuTorque', 'distance', 'rollout',
            'carKind', 'follow', 'welcome', 'sportPulse', 'decorWith', 'nightDim', 'keep', 'flashAlerts', 'turnGlow', 'doorRed', 'doorCar', 'hazardRed', 'drive', 'speedUnit', 'pressUnit', 'powerUnit', 'torqueUnit', 'tempUnit', 'theme', 'layout', 'renderer', 'advanced', 'speedRate', 'demo'];
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
    ['final: a unit that went silent is woken again for its back-off retry', async () => {
        // the engine unit doesn't answer for the first 20 s (opened before the engine was started), then does
        const r = await rig({ driving: true, deadUntil: { 18: 20000 } });
        r.start(); await r.run(6 * 60000);
        assert(G_isNum(r.reads.fresh().b12.v), 'the 12 V voltage never came back: ' + JSON.stringify(r.reads.bat.b12));
        r.done();
    }],
    ['final: a 48 V reply in another layout is logged and counts as an answer', async () => {
        const r = await rig({ driving: true, odd48: true });
        r.start(); await r.run(30000);
        assert(r.logged.some((m) => /^raw AA56: 62 AA 56/.test(m)), 'raw reply not logged: ' + r.logged.filter((m) => /AA56/.test(m)));
        assert.notStrictEqual(r.reads.bat.has48, false, 'a battery that answers was given up');
        r.done();
    }],
    ['final: xDrive on Auto, AWD not seen yet: the transfer case is read slowly and marks AWD', async () => {
        const r = await rig({ driving: true });
        r.start(); await r.run(1000);
        assert(r.asked.some((q) => q.key === '25:DB32'), 'transfer case never read before AWD was seen');
        assert.strictEqual(r.values.live.awdSeen, true, '39.5 Nm to the front axle: all-wheel drive');
        r.done();
    }],
    ['final: parked, both battery panels say paused, no old numbers', async () => {
        const r = await rig({ driving: false });
        r.start(); await r.run(11 * 60000);
        const f = r.reads.fresh();
        assert.strictEqual(f.b48, null);
        assert(Object.keys(f.b12).every((k) => f.b12[k] === null), 'old 12 V values shown parked: ' + JSON.stringify(f.b12));
        assert.strictEqual(r.reads.why('b12'), 'paused - parked');
        r.done();
    }],
    ['final: a 12 V battery that never answers says no reply', async () => {
        const r = await rig({ driving: true, dead12: true });
        r.start(); await r.run(10000);
        assert.strictEqual(r.reads.why('b12'), 'no reply');
        r.done();
    }],
    ['2.1: the 12 V voltage that failed 3 times is asked again after 30 s, not 5 min', async () => {
        const r = await rig({ driving: true, dead12: true });
        r.start(); await r.run(2 * 60000);
        const n = r.asked.filter((q) => q.key === '18:F442').length;
        assert(n >= 4, 'the engine unit\'s F442 asked only ' + n + 'x in 2 min');
        assert(r.logged.some((m) => /^v12 0x12 F442: none/.test(m)), 'no candidate logged: ' + r.logged.filter((m) => /^v12/.test(m)).join(' | '));
        r.done();
    }],
    ['2.1: each 12 V candidate\'s reply logged once; the voltage kept a minute', async () => {
        const r = await rig({ driving: true });
        r.start(); await r.run(30000);
        const v = r.logged.filter((m) => /^v12 0x12 F442: reply/.test(m));
        assert.strictEqual(v.length, 1, 'logged ' + v.length + 'x: ' + v.join(' | '));
        const R = r.reads;
        R.bat.b12T.v = R.now() - 40000;
        assert(G_isNum(R.fresh().b12.v), 'a voltage 40 s old not shown');
        R.bat.b12T.v = R.now() - 70000;
        assert.strictEqual(R.fresh().b12.v, null, 'a voltage 70 s old still shown');
        r.done();
    }],
    ['2.3: a G26: refused reads not asked again, the OBD voltage first, no 12 V current at all', async () => {
        const r = await rig({ driving: true, g26: true });
        r.start(); await r.run(60000);
        const n = (k) => r.asked.filter((q) => q.key === k).length;
        assert(n('18:F442') <= 1, 'F442 refused as not supported, asked again: ' + n('18:F442'));
        assert.strictEqual(n('18:5852'), 1, 'the 12 V current asked again after "not supported": ' + n('18:5852'));
        assert.strictEqual(n('18:5854'), 1, 'the 12 V temperature asked again: ' + n('18:5854'));
        assert(n('18:OBD 42') >= 20, 'the OBD voltage asked every 2.5 s: ' + n('18:OBD 42'));
        assert(Math.abs(r.reads.fresh().b12.v - 14.66) < 0.01, 'voltage ' + r.reads.fresh().b12.v);
        assert.strictEqual(r.reads.can('i12'), false, 'no unit gives the 12 V current');
        assert(r.reads.can('v12'), 'the voltage has a unit');
        assert(r.logged.some((m) => /^i12 0x12 5852: not supported \(7F 22 31\), not asked again/.test(m)), r.logged.filter((m) => /i12/.test(m)).join(' | '));
        r.done();
    }],
    ['2.3: the answering candidate is remembered by its key across a restart', async () => {
        const dir = tmp('v12key');
        const r = await rig({ driving: true, g26: true });
        r.reads.file = require('path').join(dir, 'battery.json');
        r.start(); await r.run(10000);
        assert.strictEqual(JSON.parse(fs.readFileSync(r.reads.file, 'utf8')).v12Key, '18:OBD 42');
        r.done();
    }],
    ['2.3: reads wait for the ambient light\'s writes, at most 0.6 s each', async () => {
        let busy = true;
        const r = await rig({ driving: true, g26: true, yieldTo: () => busy });
        r.start(); await r.run(500);
        assert.strictEqual(r.asked.length, 0, 'a read went out while the lights were writing: ' + r.asked.map((q) => q.key).join(' '));
        await r.run(1000);
        assert(r.asked.length > 0, 'never read: the lights may hold the reads only 0.6 s at a time');
        busy = false; r.asked.length = 0;
        await r.run(3000);
        assert(r.asked.length > 2, 'the lights done: reading on');
        r.done();
    }],
    ['2.3: 48 V: the pack voltage where the terminal voltage field does not fit (a G26)', async () => {
        const B = appModule('batteries'), F = SPEC.config.battery.b48[0].fields;
        // the G26's reply from its log
        const g26 = '62 AA 56 00 E8 00 00 00 0E 43 4D FF FF FF FF 02 3E 50 61 12 1E 6E 33 27 50 6A 56 2E 62 60 46'.split(' ').map((x) => parseInt(x, 16));
        const b = B.b48(B.fields(g26, F));
        assert(Math.abs(b.v - 46.38) < 0.01, 'pack voltage ' + b.v);
        assert.strictEqual(b.soc, 80); assert.strictEqual(b.soh, 96);
        assert(Math.abs(b.temp - 7) < 0.01, 'temperature ' + b.temp);
    }],
    ['2.3: no 12 V current on this car: the panel shows the voltage alone', async () => {
        const d = car(); d.b12.a = null;
        const t = await page(d, {}, { no12A: true });
        assert(t.some((x) => /^14\.10 V$/.test(x)), 'the voltage alone: ' + t.filter((x) => / V/.test(x)).join(' | '));
        assert(!t.some((x) => /14\.10 V\s+·/.test(x)), 'still a second value after the voltage');
    }],
    ['2.3: Seats: the position reply shown and logged once; no interface: says so, not asked again', async () => {
        const { Seats } = appModule('seats');
        const logs = [];
        const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error() {} };
        let calls = 0;
        const reply = { outSeatID: 0, statusResponse: 2, seatAxisList: [{ seatAxis: 0, seatMovement: 2, axisPositionValue: 1234 }, { seatAxis: 'AXISSHV', seatMovement: 2, axisPositionValue: 567 }] };
        const signals = { proxy: async () => ({}), call: async (p, m, a) => { calls++; assert.strictEqual(m, 'getCurrentPosition'); assert.deepStrictEqual(a, { inSeatID: 0 }); return reply; } };
        let now = 1000;
        const s = new Seats({ signals, log, now: () => now });
        await s.read(); await s.read();
        assert.deepStrictEqual(s.state.axes.map((a) => [a.axis, a.value]), [['SLV', 1234], ['SHV', 567]]);
        assert.strictEqual(logs.filter((m) => /getCurrentPosition ->/.test(m)).length, 1, 'the same shape logged twice');
        const cv = new Canvas(1600, 520), out = [];
        cv.own = true; const tx = cv.text; cv.text = function (x, ...r2) { out.push(String(x)); return tx.call(this, x, ...r2); };
        s.draw(cv, themes.theme('m_tricolour'));
        assert(out.includes('Forward / back') && out.includes('1234') && out.includes('Height'), out.join(' | '));
        const gone = new Seats({ signals: { proxy: async () => { throw new Error('interface not found in config'); } }, log, now: () => now });
        await gone.read();
        assert.strictEqual(gone.state.available, false);
        gone.poll(); now += 5000; gone.poll();
        assert(!gone.busy, 'asked again with the interface missing');
    }],
    ['2.1: the 12 V panel shows the power into the battery in W, as the 48 V one in kW', async () => {
        const t = await page(car());
        assert(t.some((x) => /14\.10 V\s+·\s+\+23 W/.test(x)), 'no 12 V power: ' + t.filter((x) => / V /.test(x)).join(' | '));
        assert(t.some((x) => /\+0\.50 kW/.test(x)), '48 V kW gone');
        const d = car(); d.b12.a = null;
        const t2 = await page(d);
        assert(t2.some((x) => /14\.10 V\s+·\s+--/.test(x)), 'no current: the power shows --');
    }],
    ['final: all-FF of a signed field is a real value (-0.1 A), not "no value"', async () => {
        const B = appModule('batteries'), F = SPEC.config.battery.b48[0].fields;
        const b = B.b48(B.fields(aa56({ v: 4720, a: -1, temp: 48, soc: 66, soh: 96 }), F));
        assert(Math.abs(b.a - 0.1) < 1e-9, 'current FFFF: ' + b.a);
        assert.strictEqual(B.fields([0x62, 0x40, 0xAD, 0xFF], { soc: { at: 0, bytes: 1 } }).soc, null, 'unsigned FF stays no value');
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
    // as kit/runtime/readonly-diag.js: a unit that didn't answer 5 times in a row is skipped (null, nothing sent) until wake()
    const misses = {}, logged = [];
    const lk = {
        available: true,
        silent: (ecu) => (misses[ecu] || 0) >= 5,
        wake(ecu) { if (ecu === undefined) Object.keys(misses).forEach((k) => { delete misses[k]; }); else delete misses[ecu]; },
        async physical(ecu, sid, data) {
            if (lk.silent(ecu)) return null;
            const key = ecu + ':' + (sid === 0x22 ? data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('') : 'OBD ' + data[0].toString(16).toUpperCase());
            asked.push({ key, t: clock });
            if (gate) await gate;
            const r = clock - t0 < (o.deadUntil && o.deadUntil[ecu] || 0) ? null : answer(ecu, sid, data, o);
            misses[ecu] = r ? 0 : (misses[ecu] || 0) + 1;
            return r;
        },
    };
    if (o.hold) gate = new Promise((res) => { release = () => { gate = null; res(); }; });
    const ui = { vis: o.shown !== false, isVisible: (n) => n === 'MAIN' && ui.vis };
    const reads = new Reads({ link: lk, reader: new DidReader(lk), values, settings, cfg: SPEC.config, ui, log: { info: (m) => logged.push(m), warn: (m) => logged.push(m), error() {} }, now: () => clock, dataDir: tmp('reads-data'),
        active: o.active === false ? () => false : undefined, yieldTo: o.yieldTo });
    // keep the car driving while time moves (the signals would)
    const keep = () => { if (o.driving) { values.put('speed', 50); values.put('rpm', 2000); } };
    const next = () => timers.slice().sort((a, b) => a.at - b.at)[0];
    return {
        reads, values, ui, asked, timers, t0, flush, logged,
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
    if (ecu === 2 && did === 0xAA56) return o.no48 ? null : o.odd48 ? [0x62, 0xAA, 0x56, 0x00, 0x05, 0x12] : aa56({ v: 4720, a: -105, temp: 48, soc: 66, soh: 96 });
    if (o.dead12 && ecu === 18 && [0xF442, 0x5852, 0x40AD, 0x56F0, 0x402B, 0x5853].indexOf(did) >= 0) return null;
    // a G26 M440i's engine unit (its log, Nov 2026): refuses these as not supported, answers the OBD voltage (14.66 V)
    if (o.g26 && ecu === 18 && [0xF442, 0x5852, 0x402B, 0x5853, 0x5854].indexOf(did) >= 0) return [0x7F, 0x22, 0x31];
    if (o.g26 && ecu === 18 && sid === 0x01 && data[0] === 0x42) return [0x41, 0x42, 0x39, 0x44];
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

/* ---------- Combo 1.1.0: what the source apps learned since 1.0 ---------- */
/** The signal handlers by interface (last name part), on a Values with a log that is kept. */
function signalRig(over) {
    const { Values } = appModule('values'), { watches } = appModule('signals');
    const logged = [], log = { info: (m) => logged.push(m), warn: (m) => logged.push(m), error() {} };
    const v = new Values({ settings: settingsOf(over), log, now: () => 1e6, dataDir: tmp('sig11') });
    const S = SPEC.config.scaling;
    const sc = (k, raw) => { const c = S[k]; if (!c || raw == null || raw === c.invalid || (c.invalidFrom != null && raw >= c.invalidFrom)) return null; return raw * c.factor + (c.offset || 0); };
    const w = {};
    watches(v, { handlers: () => ({}) }, sc, log).forEach(([iface, h]) => { w[iface.split('.').pop()] = h; });
    return { v, w, logged };
}
checks.push(
    ['1.1 #1 locked and left: the car\'s own state stops every read', async () => {
        const { v, w } = signalRig();
        w.VehicleCondition.VehicleCondition({ statusConditionVehicle: 'PARKEN_BN_IO' });
        assert.strictEqual(v.live.left, true, 'parked (2): left');
        w.VehicleCondition.VehicleCondition({ statusConditionVehicle: 'FAHREN' });
        assert.strictEqual(v.live.left, false, 'drive-ready: in use');
        const r = await rig({ driving: true });
        r.values.live.left = true;
        r.start(); await r.run(30000);
        assert.strictEqual(r.asked.length, 0, 'read while locked and left: ' + r.asked.map((q) => q.key).join(' '));
        assert.strictEqual(r.reads.why('b48'), 'paused - car locked');
        r.done();
    }],
    ['1.1 #2 a speed over 400 km/h (the car waking up) is not taken', async () => {
        const { v } = signalRig();
        v.put('speed', 120); v.put('speed', 1023.98);
        assert.strictEqual(v.live.speed, 120);
    }],
    ['1.1 #3 the split only between 0 and 100 %', async () => {
        const { v, w } = signalRig();
        w.BasicDataSet.basicDataSet({ valueDistributionLongitudinalTorqueRearAxisFrontAxis: 10500, qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis: 2 });
        assert.strictEqual(v.live.splitRear, undefined, '105 % taken');
        w.BasicDataSet.basicDataSet({ valueDistributionLongitudinalTorqueRearAxisFrontAxis: 6500, qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis: 2 });
        assert(Math.abs(v.live.splitRear - 65) < 1e-9);
    }],
    ['1.1 #4 kPa: boost in kPa, the scale to 250', async () => {
        assert(SPEC.settings.find((s) => s.key === 'pressUnit').options.some((o) => o[0] === 'kpa'), 'no kPa choice');
        const d = car(); d.boost = 1.0; d.boostTarget = 1.2;
        const t = await page(d, { pressUnit: 'kpa' });
        ['100', '120', '250', 'kPa'].forEach((x) => assert(has(t, x), x + ' missing: ' + t.join(' | ')));
        assert(!t.some((x) => /^ ?(bar|psi)$/.test(x.trim())), 'another pressure unit shown');
    }],
    ['1.1 #5 #6 settings: limits in the unit chosen, speed rate 3 fps', async () => {
        const S = {}; SPEC.settings.forEach((s) => { S[s.key] = s; });
        assert.strictEqual(S.maxPower.unitBy, 'powerUnit');
        assert.deepStrictEqual(S.maxPower.units, { hp: { unit: 'hp', mul: 1.34102 }, ps: { unit: 'PS', mul: 1.35962 } });
        assert.strictEqual(S.torqueMax.unitBy, 'torqueUnit');
        assert.deepStrictEqual(S.torqueMax.units, { lbft: { unit: 'lb-ft', mul: 0.737562 } });
        assert(S.speedRate.steps.indexOf(3) >= 0, 'no 3 fps');
    }],
    ['1.1 #7 power and torque peaks as numbers beside their labels (the kit\'s bar)', async () => {
        const t = await page(car());
        assert(t.includes('PEAK 241') && t.includes('PEAK 702'), 'no PEAK numbers: ' + t.filter((x) => /PEAK/.test(x)).join(' | '));
        assert(!t.some((x) => /^PEAK {2}/.test(x)), 'the old PEAK lines under the bars still drawn');
    }],
    ['1.1 #8 saved files are written whole (temp file renamed), none left behind', async () => {
        const { writeWhole } = appModule('store');
        const dir = tmp('whole'), f = path.join(dir, 'x.json');
        writeWhole(f, '{"a":1}');
        assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}');
        const { v } = signalRig();
        v.markAwd(); v.remember('boostFes');
        const r = await rig({ driving: true }); r.start(); await r.run(3000); r.done();
        [v.awdFile, v.seenFile].forEach((x) => assert(fs.existsSync(x), x));
        [path.dirname(v.awdFile)].forEach((d) => assert(!fs.readdirSync(d).some((n) => /\.tmp$/.test(n)), 'a temp file left'));
        ['values.js', 'reads.js'].forEach((n) => assert(!/fs\.writeFileSync\(/.test(fs.readFileSync(path.join(APP, n), 'utf8')), n + ' writes in place'));
    }],
    ['1.1 #9 the eDRIVE needle logged once (does a mild hybrid send it?)', async () => {
        const { w, logged } = signalRig();
        const n = { statusPowerRelativHybrid: { displayActualValuePowerRelativeDrivingElectric: 12, displayActualValuePowerRelativeRecuperation: 0 } };
        w.Efficiencytainment2.statusPowerRelativHybrid(n); w.Efficiencytainment2.statusPowerRelativHybrid(n);
        assert.strictEqual(logged.filter((m) => /eDRIVE needle: drive 12, regen 0/.test(m)).length, 1, logged.join(' | '));
    }],
    ['1.1 #10 wheel slip: front axle against rear, above 5 km/h', async () => {
        const { v, w } = signalRig();
        v.put('speed', 50);
        w.Powertrain.ActualValueRPMWheel({ actualValueRPMWheelFLH: 1010, actualValueRPMwheelFRH: 1010, actualValueRPMWheelRLH: 1000, actualValueRPMWheelRRH: 1000 });
        assert(Math.abs(v.slip() - 1) < 1e-9, 'front 1 % faster: ' + v.slip());
        v.put('speed', 3);
        assert.strictEqual(v.slip(), null, 'below 5 km/h');
        w.Powertrain.ActualValueRPMWheel({ actualValueRPMWheelFLH: 65535, actualValueRPMwheelFRH: 1010, actualValueRPMWheelRLH: 1000, actualValueRPMWheelRRH: 1000 });
        const d = car(); d.slip = 1.04;
        const t = await page(d);
        assert(t.includes('AXLE SLIP') && t.some((x) => /\+1\.0 %/.test(x)), 'slip not drawn: ' + t.join(' | '));
        const t2 = await page(Object.assign(car(), { slip: null }));
        assert(t2.includes('AXLE SLIP') && !t2.some((x) => /NaN|undefined/.test(x)));
    }],
    ['2.0 #1 tabs: Driving, Performance, Seats, M View, then Ambient config\'s three (no Favourites, no Strobe); each tab drawn', async () => {
        fakeAmb.calls = [];
        const b = await boot(tmp('tabs'));
        assert(fakeAmb.calls.indexOf('background {"strobe":false}') >= 0, 'the ambient service without the strobe: ' + fakeAmb.calls.join(' | '));
        assert(fakeAmb.calls.some((c) => /^mount .*"strobe":false.*"names":\["Ambient","Animations","Modes"\]/.test(c)), fakeAmb.calls.join(' | '));
        const t0 = await b.draw();
        ['DRIVING', 'PERFORMANCE', 'SEATS', 'M VIEW', 'AMBIENT'].forEach((x) => assert(t0.includes(x), x + ' missing: ' + t0.join(' | ')));
        assert(!t0.includes('ANIMATIONS') && !t0.includes('MODES'), 'the kit runs the screen: one Ambient tab (Settings fits after it)');
        assert(t0.includes('RESET PEAKS') && b.hidden.indexOf('BTN_RESET') >= 0, 'Reset peaks on the page, not in the bar');
        assert(!t0.includes('FAVOURITES'), 'Favourites still a tab');
        assert(t0.includes('Engine speed'), 'Driving first');
        const t1 = await b.tab(1);
        assert(t1.includes('Dyno') && t1.includes('Drag timer'), 'Performance: ' + t1.join(' | '));
        assert(!t1.includes('Engine speed'), 'Driving still drawn on Performance');
        const t2 = await b.tab(2);
        assert(t2.some((x) => /^Reading only for now/.test(x)) && !t2.includes('Engine speed'), 'Seats: ' + t2.join(' | '));
        const tm = await b.tab(3);
        assert(tm.includes('Engine oil') && tm.includes('Gearbox oil') && tm.includes('Misfires') && tm.includes('Tyres') && tm.includes('Fuel trims & timing') && !tm.includes('Engine oil level') && !tm.some((x) => /NaN|undefined/.test(x)), 'M View: ' + tm.join(' | '));
        const ta = await b.tab(4);
        assert(ta.includes('AMBIENT TAB 0') && ['COLOUR', 'ANIMATIONS', 'MODES'].every((x) => ta.includes(x)), 'Ambient with its sub-tabs: ' + ta.join(' | '));
        await b.press('amb-1');
        const t3 = await b.draw();
        assert(t3.includes('AMBIENT TAB 1') && fakeAmb.calls.indexOf('select 1') >= 0, 'Animations: ' + t3.join(' | '));
        b.tap(300, 300);
        assert(fakeAmb.calls.indexOf('tap 300,300') >= 0, 'a tap on an ambient tab goes to it');
        await b.tab(0);
        assert(fakeAmb.calls.indexOf('leave') >= 0, 'leaving the ambient tabs is told');
        assert.deepStrictEqual(SPEC.screens[0].buttons.map((x) => x[0]), ['BTN_RESET', 'BTN_SETTINGS']);
        assert.strictEqual(SPEC.autostart, true, 'autostart: the ambient light runs with the app closed');
        assert(!SPEC.settings.some((x) => /^strobe|^police|showRate/.test(x.key)), 'no strobe settings');
    }],
    ['2.0 #2 the diagnostic link reads only on the Driving tab', async () => {
        const b = await boot(tmp('reads'), { settings: { demo: 'off' } });
        link.available = true; link.ready = true;
        await b.draw();
        await new Promise((r) => setTimeout(r, 1200));
        assert(link.asked.length > 0, 'nothing read on the Driving tab (the check below would prove nothing)');
        await b.tab(1);
        await new Promise((r) => setTimeout(r, 1500));      // (a read under way when the tab changed ends)
        const before = link.asked.length;
        await new Promise((r) => setTimeout(r, 1200));
        assert.strictEqual(link.asked.length, before, 'read on the Performance tab: ' + link.asked.slice(before).map((a) => a.ecu).join());
        await b.tab(4);
        await new Promise((r) => setTimeout(r, 600));
        assert.strictEqual(link.asked.length, before, 'read on an ambient tab');
    }],
    ['2.0 #3 the bar\'s Reset by tab: peaks, the drag run, the car\'s colour', async () => {
        fakeAmb.calls = [];
        const b = await boot(tmp('reset'));
        await b.tab(1);
        b.clicks.BTN_RESET();
        await b.tab(4);
        b.clicks.BTN_RESET();
        assert(fakeAmb.calls.indexOf('original') >= 0, 'Original colour on the ambient tabs');
        // the kit runs the screen: each tab's own button on the page
        await b.tab(3); await b.press('misfires');
        await b.tab(2); await b.press('seats-again');
        await b.tab(0); await b.press('peaks');
    }],
    ['2.0 #4 dyno: a pull in one gear makes a run (power from m*a*v, torque from power), saved; demo runs not', async () => {
        const { Perf } = appModule('perf');
        const dir = tmp('dyno'), s = settingsOf({ demo: 'off' });
        const p = new Perf({ settings: s, log: quiet, dataDir: dir, engine: null });
        let t = 1000;
        // 3rd gear: 45 rpm per km/h, 0.4 g from 50 km/h
        for (let v = 50; v < 150; v += 0.4 * 9.80665 * 3.6 * 0.05) { p.sample({ rpm: v * 45, speed: v, gLong: 0.4, torque: 400 }, t); t += 50; }
        p.sample({ rpm: 6000, speed: 150, gLong: 0, torque: 0 }, t + 600);
        p.sample({ rpm: 6000, speed: 150, gLong: 0, torque: 0 }, t + 1200);
        const r = p.current();
        assert(r && r.curve.length > 10, 'no run');
        assert(r.peakPrpm >= 6000 && r.peakP > 150000 && r.peakP < 400000, 'peak power ' + r.peakP + ' @ ' + r.peakPrpm);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'perf.json'), 'utf8'));
        assert.strictEqual(saved.dyno.runs.length, 1);
        p.baseline();
        assert(p.store.dyno.baseline && p.store.dyno.baseline.at === r.at, 'baseline pinned');
        p.demo(true);
        assert(!p.current(), 'the demo has its own runs');
        p.demo(false);
        assert.strictEqual(p.current().at, r.at);
    }],
    ['2.0 #5 drag: stop, launch, 0-100 timed and kept as the best', async () => {
        const { Perf } = appModule('perf');
        const dir = tmp('drag'), p = new Perf({ settings: settingsOf({ demo: 'off' }), log: quiet, dataDir: dir, engine: null });
        let t = 1000;
        for (let i = 0; i < 30; i++) { p.speed(t, 0); p.idle(t); t += 50; }
        assert.strictEqual(p.timer.state, 'ready');
        // 0-100 in 5 s, then on to 120 and lift
        for (let i = 1; i <= 120; i++) { t += 50; p.speed(t, Math.min(120, i * 1)); }
        for (let i = 0; i < 20; i++) { t += 50; p.speed(t, 110 - i); }
        const best = p.store.drag.best['0-100'];
        assert(best && Math.abs(best.s - 5) < 0.1, 'best 0-100: ' + JSON.stringify(best));
        assert(JSON.parse(fs.readFileSync(path.join(dir, 'perf.json'), 'utf8')).drag.best['0-100'], 'saved');
    }],
    ['2.0 #6 build: every "include" file exists, and the included ambient service has no strobe on board', async () => {
        Object.keys(SPEC.include).forEach((a) => SPEC.include[a].forEach((f) => assert(fs.existsSync(path.join(ROOT, 'shared', a, f)), a + '/' + f)));
        const src = fs.readFileSync(path.join(ROOT, 'shared', 'ambient_config', 'ambient_page.js'), 'utf8');
        assert(!/^const .*require\('\.\/(strobe|lever)'\)/m.test(src), 'strobe.js or lever.js required at the top: Combo leaves them out');
        // every module the included files require is included too
        const have = new Set(SPEC.include.ambient_config.map((f) => './' + f.replace(/\.js$/, '')));
        SPEC.include.ambient_config.forEach((f) => {
            const code = fs.readFileSync(path.join(ROOT, 'shared', 'ambient_config', f), 'utf8');
            (code.match(/^(?!\s*\/\/).*require\('\.\/[a-z_]+'\)/gm) || []).forEach((line) => {
                const m = line.match(/require\('(\.\/[a-z_]+)'\)/)[1];
                if (m === './strobe' || m === './lever') return;          // (only with the strobe, which Combo leaves out)
                assert(have.has(m), f + ' needs ' + m + ', which "include" leaves out');
            });
        });
    }],
    ['2.4 #1 M View: oil and coolant from the car\'s own signals, no oil level', async () => {
        const { v, w } = signalRig();
        w.CDS.statusEngineTemperature({ temperatureEngineDrive: 48 + 91, temperatureEngineOilDrive: 48 + 104 });
        assert.strictEqual(v.live.coolant, 91); assert.strictEqual(v.live.oil, 104); assert(v.live.oilT > 0);
        w.VehicleInformation.DataPowerTrain2({ temperatureEngineDrive: 48 + 93, temperatureEngineOilDrive: 255 });
        assert.strictEqual(v.live.coolant, 93, 'DataPowerTrain2 carries them too'); assert.strictEqual(v.live.oil, 104, '255 = no value');
        assert(SPEC.signals['de.bmw.infotainment.vehicle.CDS'].statusEngineTemperature);
        assert(!SPEC.signals['de.bmw.infotainment.vehicle.Vehicle2'].statusOilDipstick2, 'no oil level (2.4.2: a B58 measures it its own way)');
    }],
    ['2.4 #2 M View reads: the car\'s values not asked, the gearbox from the EGS, refusals not asked again, misfires per cylinder', async () => {
        const { MView } = appModule('mview'), { DidReader } = require(path.join(KIT, 'dids'));
        const asked = [];
        let clock = 1e6;
        // a G26: the DME answers service 01 and 06, refuses 22 F4xx; the EGS answers 22 6000 (75 deg C)
        const fake = { available: true, async physical(ecu, sid, data) {
            asked.push(ecu + ':' + sid.toString(16) + ':' + data.map((x) => x.toString(16)).join(''));
            if (ecu === 0x18 && sid === 0x22 && data[0] === 0x60 && data[1] === 0) return [0x62, 0x60, 0x00, 115];
            if (ecu === 0x12 && sid === 0x01 && data[0] === 0x0F) return [0x41, 0x0F, 40 + 31];
            if (ecu === 0x12 && sid === 0x06 && data[0] === 0xA0) return [0x46, 0xA0, 0x7E, 0x00, 0x00, 0x00];        // A2..A7
            if (ecu === 0x12 && sid === 0x06 && data[0] >= 0xA2 && data[0] <= 0xA7) {
                const n = data[0] === 0xA4 ? 3 : 0;
                return [0x46, data[0], 0x0B, 0x24, 0, 1, 0, 0, 0xFF, 0xFF, data[0], 0x0C, 0x24, 0, n, 0, 0, 0xFF, 0xFF];
            }
            return [0x7F, sid, 0x31];
        } };
        const values = { live: { oil: 100, oilT: clock, coolant: 90, coolantT: clock }, now: () => clock };
        const logged = [], log = { info: (m) => logged.push(m), warn: (m) => logged.push(m) };
        const m = new MView({ reader: new DidReader(fake), values, cfg: SPEC.config.mview, settings: settingsOf(), log, link: fake, now: () => clock });
        const step = async () => { m.tick(); while (m.busy) await new Promise((r) => setImmediate(r)); clock += 400; values.live.oilT = values.live.coolantT = clock; };
        for (let i = 0; i < 80; i++) await step();
        assert(!asked.some((a) => /^18:1:5c|^18:1:5$|^18:22:f45c/.test(a)), 'oil / coolant asked while the car sends them: ' + asked.join(' '));
        assert.strictEqual(m.temp('gearbox').v, 75); assert.strictEqual(m.temp('gearbox').from, 'EGS');
        assert.strictEqual(m.temp('iat').v, 31);
        assert.strictEqual(m.temp('oil').from, 'car');
        assert.strictEqual(m.mids.length, 6, 'six cylinders from A0');
        assert.deepStrictEqual(m.shown(), [0, 0, 3, 0, 0, 0], 'cylinder 3: 3 misfires');
        assert.strictEqual(asked.filter((a) => a === '24:22:da12').length, 0, 'the first EGS candidate answers: the second not asked');
        assert(asked.filter((a) => a === '18:22:f40f').length <= 1, 'F40F refused once, not asked again');
        m.resetMisfires();
        assert.deepStrictEqual(m.shown(), [0, 0, 0, 0, 0, 0], 'Reset: from now on');
        // drawn without NaN, the misfire in the warn colour's row
        const tx = await textsOf(() => { const cv = new Canvas(1600, 520); cv.own = true; m.draw(cv, themes.theme('m_tricolour')); });
        assert(tx.includes('since Reset') && tx.includes('Tyres') && tx.some((x) => /^75$/.test(x)) && !tx.some((x) => /NaN|undefined/.test(x)), tx.join(' | '));
        // the car's own oil temperature stopped: then the DME is asked (it refuses: not asked again)
        values.live.oilT = 0; const was = asked.length; clock += 60000;
        for (let i = 0; i < 40; i++) { m.tick(); while (m.busy) await new Promise((r) => setImmediate(r)); clock += 400; }
        assert(asked.slice(was).filter((a) => a === '18:1:5c').length === 1, 'oil from the DME once (then refused): ' + asked.slice(was).join(' '));
        assert(/Not given by this car/.test(m.why('oil')));
    }],
    ['2.4 #4 tyres beside xDrive: the car\'s TPMS in its own unit, "2.4/20" per tyre, a low one in the warning colour', async () => {
        const { v, w } = signalRig();
        // a car set to psi: 35 psi (raw 350), its temperatures in deg F + 40 (68 F = 20 C)
        w.Vehicle.statusNewCurrentUnitsStatusExt({ unitOfMeasurementAirPressure: 'PSI', unitOfMeasurementTemperature: 'F' });
        w.TPMS.statusTyrePressure({ actualValuePressureTyreFLH: 348, actualValuePressureTyreFRH: 348, actualValuePressureTyreRLH: 392, actualValuePressureTyreRRH: 65535 });
        w.TPMS.statusTyreTemperature({ actualValueTemperatureTyreFLH: 108, actualValueTemperatureTyreFRH: 110, actualValueTemperatureTyreRLH: 108, actualValueTemperatureTyreRRH: 108 });
        w.TPMS.statusTargetTyrePressure({ targetPressureTyreFLH: 348, targetPressureTyreFRH: 348, targetPressureTyreRLH: 420, targetPressureTyreRRH: 392 });
        const ty = v.live.tyres;
        assert(Math.abs(ty.FL.p - 2.4) < 0.01 && Math.abs(ty.FL.t - 20) < 0.01 && ty.RR.p === null, JSON.stringify(ty));
        assert(SPEC.signals['de.bmw.infotainment.vehicle.TPMS']._optional, 'TPMS optional (a car without it still installs)');
        const d = car(); d.tyres = ty;
        const tx = await page(d);
        ['2.4/20', '2.7/20', '--/20'].forEach((x) => assert(tx.includes(x), x + ' missing: ' + tx.join(' | ')));
        assert(tx.includes('xDrive') && !tx.some((x) => /NaN|undefined/.test(x)));
        // the M View tab's tyre card: pressure, target, temperature per tyre
        const { MView } = appModule('mview');
        const mv = new MView({ reader: { key: () => '' }, values: { live: { tyres: ty, tyresT: Date.now() } }, cfg: SPEC.config.mview, settings: settingsOf(), log: quiet });
        const mt = await textsOf(() => { const cv = new Canvas(1600, 520); cv.own = true; mv.draw(cv, themes.theme('m_tricolour')); });
        assert(mt.includes('2.4') && mt.includes('target 2.4') && mt.includes('20°C') && mt.includes('target 2.9') && !mt.some((x) => /NaN|undefined/.test(x)), mt.join(' | '));
        const t2 = await page(Object.assign(car(), { tyres: null }));
        assert(!t2.some((x) => /^\d\.\d\/\d+$/.test(x)), 'no tyres from the car: nothing drawn');
    }],
    ['2.4 #5 seats: every step logged; a set-up that never comes back is given up, a seat interface not offered is not called', async () => {
        const { Seats } = appModule('seats');
        const logged = [], log = { info: (m) => logged.push(m), warn: (m) => logged.push(m) };
        // never answers (2.3.1 on a G26: not one seat line in the log)
        const hang = new Seats({ signals: { proxy: () => new Promise(() => {}), call: () => new Promise(() => {}) }, log, stepMs: 50 });
        await hang.read();
        assert(logged.some((m) => /seats: asking the car for its seat interface/.test(m)) && logged.some((m) => /seat interface set-up: no answer/.test(m)), logged.join(' | '));
        assert(!hang.busy, 'not left waiting');
        // set up, but the car doesn't offer it: no call, asked again after 30 s
        let calls = 0, clock = 1e6;
        const off = new Seats({ signals: { proxy: async () => ({ isAvailable: () => false }), call: async () => { calls++; return {}; } }, log, now: () => clock, stepMs: 50 });
        await off.read();
        assert.strictEqual(calls, 0); assert(/does not offer/.test(off.state.why) && off.offered === false);
        off.last = clock; clock += 5000; off.poll(); assert(!off.busy, 'asked again before 30 s');
        assert(logged.some((m) => /offered by the car: false/.test(m)));
    }],
    ['2.4 #3 M View: an engine unit without misfire monitors is not asked again; nothing read while locked', async () => {
        const { MView } = appModule('mview'), { DidReader } = require(path.join(KIT, 'dids'));
        const asked = [];
        const fake = { available: true, async physical(ecu, sid, data) { asked.push(sid); return [0x7F, sid, 0x11]; } };
        let clock = 1e6;
        const values = { live: {}, now: () => clock };
        const m = new MView({ reader: new DidReader(fake), values, cfg: SPEC.config.mview, settings: settingsOf(), log: quiet, link: fake, now: () => clock });
        for (let i = 0; i < 120; i++) { m.tick(); while (m.busy) await new Promise((r) => setImmediate(r)); clock += 400; }
        assert(m.misGone, 'misfires given up');
        const n = asked.length;
        for (let i = 0; i < 60; i++) { m.tick(); while (m.busy) await new Promise((r) => setImmediate(r)); clock += 400; }
        assert.strictEqual(asked.length, n, 'asked again after every candidate was refused');
        values.live.left = true; m.misGone = null; m.no = {};
        for (let i = 0; i < 30; i++) { m.tick(); clock += 400; }
        assert.strictEqual(asked.length, n, 'read while the car is locked and left');
    }],
    ['2.4.2 #1 tyres: a car in bar that says deg F still reads its TPMS as deg C + 40; an imperial one as deg F', async () => {
        const T = (a) => ({ actualValueTemperatureTyreFLH: a[0], actualValueTemperatureTyreFRH: a[1], actualValueTemperatureTyreRLH: a[2], actualValueTemperatureTyreRRH: a[3] });
        const eu = signalRig();
        // 2.4.1 on a G26 (bar): raw 48 46 45 44, the car's own page 8 7 6 5 deg C; Combo showed -13..-15
        eu.w.Vehicle.statusNewCurrentUnitsStatusExt({ unitOfMeasurementAirPressure: 'BAR', unitOfMeasurementTemperature: 'F' });
        eu.w.TPMS.statusTyreTemperature(T([48, 46, 45, 44]));
        assert.deepStrictEqual(['FL', 'FR', 'RL', 'RR'].map((k) => eu.v.live.tyres[k].t), [8, 6, 5, 4]);
        assert(eu.logged.some((m) => /raw units: \["BAR","F"\]/.test(m)), 'the raw units logged');
        const us = signalRig();
        us.w.Vehicle.statusNewCurrentUnitsStatusExt({ unitOfMeasurementAirPressure: 'PSI', unitOfMeasurementTemperature: 'F' });
        us.w.TPMS.statusTyreTemperature(T([108, 108, 108, 108]));
        assert.strictEqual(us.v.live.tyres.FL.t, 20, '68 F = 20 C');
    }],
    ['2.4.2 #2 misfires: the read-only link lets service 06 out; a link that blocks it: the UDS form instead, not 06 again', async () => {
        const { check } = require(path.join(KIT, 'readonly-diag'));
        check(0x12, 0x06, [0xA2], false);
        assert.throws(() => check(0x12, 0x06, [0xA2, 0x0C], false), /exactly one PID/);
        assert.throws(() => check(0x12, 0x31, [0x01], false), /not allowed/);
        const { MView } = appModule('mview'), { DidReader } = require(path.join(KIT, 'dids'));
        const asked = [];
        // an older link: 06 never leaves (throws), 22 F6xx answers cylinder misfires
        const fake = { available: true, async physical(ecu, sid, data) {
            asked.push(sid.toString(16) + ':' + data.map((b) => b.toString(16)).join(''));
            if (sid === 0x06) throw new Error('read-only: service 06 is not allowed');
            if (data[1] === 0xA0) return [0x62, 0xF6, 0xA0, 0x40, 0, 0, 0, 1];
            return [0x62, 0xF6, data[1], 0x0B, 0x24, 0, 2, 0, 0, 0xFF, 0xFF, 0x0C, 0x24, 0, 1, 0, 0, 0xFF, 0xFF];
        } };
        let clock = 1e6;
        const m = new MView({ reader: new DidReader(fake), values: { live: {}, now: () => clock }, cfg: SPEC.config.mview, settings: settingsOf(), log: quiet, link: fake, now: () => clock });
        for (let i = 0; i < 200; i++) { m.tick(); while (m.busy) await new Promise((r) => setImmediate(r)); clock += 400; }
        const n06 = asked.filter((a) => a.startsWith('6:')).length;
        assert(n06 <= 2, 'service 06 asked again and again: ' + n06);
        assert(asked.some((a) => a.startsWith('22:f6a')), 'the UDS form asked');
    }],
    ['2.4.2 #3 Seats: Read again starts over after the car said no; the tab line says where it stands', async () => {
        const { Seats } = appModule('seats');
        let ok = false;
        const s = new Seats({ signals: { proxy: async () => { if (!ok) throw new Error('interface not found'); return { isAvailable: () => true }; }, call: async () => ({ statusResponse: 2, seatAxisList: [{ seatAxis: 0, axisPositionValue: 5 }] }) }, log: quiet, stepMs: 50 });
        await s.read();
        assert.strictEqual(s.state.available, false); assert(/not available/.test(s.summary()));
        ok = true; s.again(); s.poll(); while (s.busy) await new Promise((r) => setImmediate(r));
        assert.strictEqual(s.state.available, true); assert(/1 motors/.test(s.summary()));
    }],
    ['2.4.2 M View: fuel trims and timing from the engine unit (OBD 01 06 / 07 / 0E), a trim far from 0 % in the warning colour', async () => {
        const { MView } = appModule('mview'), { DidReader } = require(path.join(KIT, 'dids'));
        const asked = [];
        const fake = { available: true, async physical(ecu, sid, data) {
            asked.push(sid + ':' + data[0]);
            if (sid !== 1) return [0x7F, sid, 0x11];
            const by = { 6: 130, 7: 141, 0x0E: 156, 0x5C: 140, 0x05: 130, 0x0F: 70 }[data[0]];
            return by == null ? [0x7F, 1, 0x12] : [0x41, data[0], by];
        } };
        let clock = 1e6;
        const m = new MView({ reader: new DidReader(fake), values: { live: {}, now: () => clock }, cfg: SPEC.config.mview, settings: settingsOf(), log: quiet, link: fake, now: () => clock });
        for (let i = 0; i < 60; i++) { m.tick(); while (m.busy) await new Promise((r) => setImmediate(r)); clock += 400; }
        assert(Math.abs(m.fuel('stft') - 1.5625) < 1e-6, 'short trim (130 - 128) / 1.28: ' + m.fuel('stft'));
        assert(Math.abs(m.fuel('ltft') - 10.15625) < 1e-6, 'long trim');
        assert.strictEqual(m.fuel('timing'), 14, '156 / 2 - 64');
        const tx = await textsOf(() => { const cv = new Canvas(1600, 520); cv.own = true; m.draw(cv, themes.theme('m_tricolour')); });
        assert(tx.includes('Fuel trims & timing') && tx.includes('+1.6') && tx.includes('+10.2') && tx.includes('14.0') && !tx.some((x) => /NaN|undefined|oil level/i.test(x)), tx.join(' | '));
    }],
    ['2.4.4 Seats: the seat modules found (22 F1 50, then 22 D702), each axis shown, a move and a switch logged, reading only', async () => {
        const { Seats } = appModule('seats');
        const logs = [], log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error() {} };
        const sent = [];
        let slv = 23000, pressed = 0;
        const be = (n) => [n >> 8, n & 255];
        const link = { available: true,
            async discover() { sent.push('22F150'); return new Map([[0x10, '000F01'], [0x12, '00A1B2'], [0x6D, '0F2A31']]); },
            async read(a, did) {
                sent.push(a.toString(16) + ':' + did.toString(16));
                if (a !== 0x6D) return [0x7F, 0x22, 0x31];
                if (did === 0xD702) return [0x62, 0xD7, 0x02].concat(be(slv), be(30000), be(41000), be(20000), be(65535), be(0), be(0), be(0), be(0), be(0), be(0));
                if (did === 0xD708) return [0x62, 0xD7, 0x08, slv > 23000 ? 1 : 0, 0, 0, 0, 3, 3, 3, 3, 0, 0, 0];
                if (did === 0xD712) { const b = new Array(19).fill(0); if (pressed) b[0] = 1; return [0x62, 0xD7, 0x12].concat(b); }
                if (did === 0xD704) return [0x62, 0xD7, 0x04, 1];
                return [0x7F, 0x22, 0x31];
            } };
        let clock = 1e6;
        const s = new Seats({ signals: { proxy: async () => { throw new Error('interface not found'); } }, log, now: () => clock, link, values: { live: {} } });
        const spin = async (n) => { for (let k = 0; k < n; k++) { s.poll(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); clock += 450; } };
        await spin(20);
        const m = s.modules;
        assert.strictEqual(m.state, 'found', m.state + ' ' + m.why);
        assert.deepStrictEqual(m.seats.map((x) => x.addr), [0x6D]);
        assert.deepStrictEqual(m.seats[0].pos.slice(0, 5), [23000, 30000, 41000, 20000, null], 'KHV 65535: no counter');
        assert(logs.some((x) => /^units: 0x10 000F01, 0x12 00A1B2, 0x6D 0F2A31/.test(x)) && logs.some((x) => /seat modules: 0x6D \(0F2A31\) SLV 23000/.test(x)), logs.join(' | '));
        // the driver moves the seat forward with its own switch
        pressed = 1; slv = 23600; await spin(12);
        assert(logs.some((x) => /seat 0x6D: SLV 23000>23600/.test(x)), 'move logged: ' + logs.join(' | '));
        assert(logs.some((x) => /seat 0x6D switch: SLV\+/.test(x)), 'switch logged');
        assert(logs.some((x) => /initialisation OK/.test(x)));
        // only reads: the discovery and 22 to single units
        assert(sent.every((x) => x === '22F150' || /^[0-9a-f]+:d70[248]$|^[0-9a-f]+:d712$/.test(x)), sent.join(' '));
        const cv = new Canvas(1600, 520), out = [];
        cv.own = true; const tx = cv.text; cv.text = function (x, ...r2) { out.push(String(x)); return tx.call(this, x, ...r2); };
        s.draw(cv, themes.theme('m_tricolour'));
        assert(out.includes('Seat module 0x6D  0F2A31') && out.includes('Forward / back') && out.includes('23600') && !out.includes('Headrest height') && !out.some((x) => /NaN|undefined/.test(x)), out.join(' | '));
        assert(/modules 0x6D/.test(s.summary()));
    }],
    ['2.4.5 Seats: a request the transport refuses now and then is asked again; a failed search starts again, not stuck "finding"', async () => {
        const { SeatModules } = appModule('seatmod');
        const logs = [], log = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
        let refuse = 2, discoverFails = 1;
        const link = { available: true,
            async discover() { if (discoverFails-- > 0) throw new Error('transport refused: APP_REQUEST_TEMPORARILY_NOT_ACCEPTED'); return new Map([[0x6D, '0F21F0'], [0x6E, '0F21F0']]); },
            async read(a, did) {
                if (a === 0x6D && did === 0xD702 && refuse-- > 0) throw new Error('transport refused: APP_REQUEST_TEMPORARILY_NOT_ACCEPTED');
                if (did === 0xD702) return [0x62, 0xD7, 0x02].concat(new Array(22).fill(0).map((x, i) => (i % 2 ? 0 : 0x60)));
                return [0x7F, 0x22, 0x31];
            } };
        let clock = 1e6;
        const m = new SeatModules({ link, log, now: () => clock, values: { live: {} } });
        m.tick(); while (m.busy) await new Promise((r) => setTimeout(r, 5));
        assert.strictEqual(m.state, 'none', 'the failed search is over: ' + m.state);
        clock += 6000; m.tick(); while (m.busy) await new Promise((r) => setTimeout(r, 5));
        assert.strictEqual(m.state, 'found', m.state + ' ' + logs.join(' | '));
        assert.deepStrictEqual(m.seats.map((x) => x.addr), [0x6D, 0x6E], 'the refused one asked again');
    }],
    ['2.4.6 the HMI\'s own layout (the kit not running the screen): Ambient config\'s three tabs and the bar\'s Reset, as before', async () => {
        fakeAmb.calls = [];
        const b = await boot(tmp('std'), { own: false });
        const t0 = await b.draw();
        ['AMBIENT', 'ANIMATIONS', 'MODES'].forEach((x) => assert(t0.includes(x), x + ' missing: ' + t0.join(' | ')));
        assert(!t0.includes('RESET PEAKS'), 'no page buttons where the HMI has the bar');
        const t3 = await b.tab(5);
        assert(t3.includes('AMBIENT TAB 1'), 'Animations as a tab: ' + t3.join(' | '));
    }],
);
