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

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'cockpit_combo');
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
// the ambient service's parts main.js switches (Settings > Tabs > Ambient): each call kept in fakeAmb.calls
const fakeParts = () => ({
    lights: { hold: (k, on) => { if (k === 'off') fakeAmb.calls.push('hold off ' + on); return Promise.resolve(); }, carColour: () => fakeAmb.calls.push('carColour') },
    control: { apply: () => fakeAmb.calls.push('apply') },
    owner: { since: 0, start() { fakeAmb.calls.push('owner start'); }, stop() { fakeAmb.calls.push('owner stop'); } },
});
const stubs = {
    './kit/mgu': { run(a) { app = a; } },
    './ambient_page': { background: async (bg, o) => { fakeAmb.calls.push('background ' + JSON.stringify(o)); return fakeParts(); },
        mount: (ctx, parts, o) => { fakeAmb.calls.push('mount ' + JSON.stringify({ strobe: o.strobe, names: o.names })); fakeAmb.page = 0; return fakeAmb; } },
    './kit/readonly-diag': { ReadOnlyDiag: FakeLink, MAX_DIDS: 8, seatMotors: (l) => (target, motor, action, pwm) => l.physical(target, 0x2E, [0xD7, 0x08, motor, action, pwm]) },
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
    let frame = null, last = null, tab = null, tap = null, tilt = null;
    const hidden = [], opened = [], rates = [];
    const ctx = {
        ui: { onClick: (k, fn) => { clicks[k] = fn; }, text() {}, image: async () => {}, isVisible: (n) => n === 'MAIN' && vis.shown, onVisible: (fn) => vis.handlers.push(fn), comp: () => ({}) },
        settings, log: opts.log || { info() {}, warn() {}, error() {} }, spec: SPEC, dataDir: dir,
        signals: { watch: opts.watch || (() => Promise.resolve({ available: false })) },
        onTab(fn) { tab = fn; }, onTilt(fn) { tilt = fn; }, mapStyle: () => !!opts.map, openSettings() { opened.push('settings'); }, hideButton(id) { hidden.push(id); }, onScroll() {}, onTap(fn) { tap = fn; }, loop(n, fps, fn) { frame = fn; return { fps: (r) => rates.push(r) }; },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => { const cv = new Canvas(w, h); cv.own = opts.own !== false; last = cv; return cv; },
    };
    await app.start(ctx);
    return {
        ctx, settings, vis, clicks, rates,
        draw: () => textsOf(() => frame()),
        tab: (i) => textsOf(() => tab(i)), tap: (x, y) => tap(x, y), hidden, opened, tilt: (d) => tilt(d),
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
        // 2.8.0: a prefixed id, as the MGU Store asks (it was "combo"); the name in the app list short
        assert.strictEqual(SPEC.id, 'cockpit_combo'); assert.strictEqual(SPEC.title, 'Cockpit');
        const others = fs.readdirSync(path.join(ROOT, 'apps')).filter((d) => d !== 'cockpit_combo' && fs.existsSync(path.join(ROOT, 'apps', d, 'app.json')))
            .map((d) => JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', d, 'app.json'), 'utf8')).loggingId);
        assert(others.indexOf('OAA3') < 0, 'OAA3 used by another app');
        const want = ['tabPerformance', 'tabSeats', 'tabMView', 'tabTrips', 'tabAmbient', 'engine', 'redline', 'rpmScale', 'boostMax', 'boostSource', 'maxPower', 'powerSource', 'torqueMax', 'maxTorqueKgm', 'peaks', 'peakHold',
            'xdrive', 'battery48', 'weight', 'body', 'loss', 'ecuTorque', 'distance', 'rollout',
            'carKind', 'follow', 'welcome', 'sportPulse', 'decorWith', 'nightDim', 'keep', 'flashAlerts', 'turnGlow', 'doorRed', 'doorCar', 'hazardRed', 'drive', 'easyEntry', 'speedUnit', 'pressUnit', 'powerUnit', 'torqueUnit', 'tempUnit', 'theme', 'layout', 'barHide', 'frameRate', 'renderer', 'advanced', 'speedRate', 'demo'];
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
    ['2.0 #1 tabs: Driving, Performance, Seats, M View, Trips, then Ambient config\'s three (no Favourites, no Strobe); each tab drawn', async () => {
        fakeAmb.calls = [];
        const b = await boot(tmp('tabs'));
        assert(fakeAmb.calls.indexOf('background {"strobe":false}') >= 0, 'the ambient service without the strobe: ' + fakeAmb.calls.join(' | '));
        assert(fakeAmb.calls.some((c) => /^mount .*"strobe":false.*"names":\["Ambient","Animations","Modes"\]/.test(c)), fakeAmb.calls.join(' | '));
        const t0 = await b.draw();
        ['DRIVING', 'PERFORMANCE', 'SEATS', 'M VIEW', 'AMBIENT'].forEach((x) => assert(t0.includes(x), x + ' missing: ' + t0.join(' | ')));
        assert(!t0.includes('ANIMATIONS') && !t0.includes('MODES'), 'the kit runs the screen: one Ambient tab (Settings fits after it)');
        assert(!t0.includes('RESET PEAKS') && b.hidden.indexOf('BTN_RESET') >= 0, 'Reset peaks not in the bar, the rail closed');
        const tr = await b.press('rail');
        assert(tr.includes('RESET PEAKS'), 'the rail opened: Reset peaks in it: ' + tr.join(' | '));
        await b.press('rail-close');
        assert(!t0.includes('FAVOURITES'), 'Favourites still a tab');
        assert(t0.includes('Engine speed'), 'Driving first');
        const t1 = await b.tab(1);
        assert(t1.includes('Dyno') && t1.includes('Drag timer'), 'Performance: ' + t1.join(' | '));
        assert(!t1.includes('Engine speed'), 'Driving still drawn on Performance');
        const t2 = await b.tab(2);
        assert(t2.some((x) => /^Only while the car stands still/.test(x)) && !t2.includes('Engine speed'), 'Seats: ' + t2.join(' | '));
        const tm = await b.tab(3);
        assert(tm.includes('Engine oil') && tm.includes('Gearbox oil') && tm.includes('Misfires') && tm.includes('Tyres') && tm.includes('Fuel trims & timing') && !tm.includes('Engine oil level') && !tm.some((x) => /NaN|undefined/.test(x)), 'M View: ' + tm.join(' | '));
        const ta = await b.tab(5);
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
    ['2.7.0 tabs switched off (Settings > Tabs): gone from the tabs and the bars, the next tab at its place', async () => {
        fakeAmb.calls = [];
        // the platform's start without screens: Ambient off starts no ambient service (owner.js: no claim on the lights)
        assert.strictEqual(await app.background({ settings: settingsOf({ tabAmbient: false }) }), null);
        assert.deepStrictEqual(fakeAmb.calls, [], 'Ambient off: nothing of the ambient service started');
        const b = await boot(tmp('tabs-off'), { settings: { tabSeats: false, tabAmbient: false } });
        assert(!fakeAmb.calls.some((c) => /^background|^mount/.test(c)), 'Ambient off: not mounted: ' + fakeAmb.calls.join(' | '));
        const t0 = await b.draw();
        ['DRIVING', 'PERFORMANCE', 'M VIEW'].forEach((x) => assert(t0.includes(x), x + ' missing: ' + t0.join(' | ')));
        assert(!t0.includes('SEATS') && !t0.includes('AMBIENT'), 'Seats and Ambient still tabs: ' + t0.join(' | '));
        const t2 = await b.tab(2);
        assert(t2.includes('Engine oil') && t2.includes('Misfires'), 'place 2 is M View now: ' + t2.join(' | '));
        assert.strictEqual(b.rates[b.rates.length - 1], 5, 'M View drawn at its own rate');
        // map style: the left bar without them
        const m = await boot(tmp('tabs-off-map'), { map: true, settings: { tabSeats: false, tabAmbient: false, tabPerformance: false } });
        await m.draw(); m.tilt('W');
        const tl = await m.draw(), keys = (m.canvas().targets || []).map((q) => q.key);
        assert(tl.includes('Driving') && tl.includes('M View') && !tl.includes('Seats') && !tl.includes('Performance') && !tl.includes('Colour'), tl.join(' | '));
        assert(keys.indexOf('nav-3') >= 0 && keys.indexOf('nav-2') < 0 && keys.indexOf('nav-1') < 0, keys.join());
        // their settings hidden with them
        const S = settingsOf({ tabSeats: false, tabAmbient: false });
        const shown = (k) => { const x = SPEC.settings.find((q) => q.key === k); return !x.when || Object.keys(x.when).every((w) => [].concat(x.when[w]).indexOf(S.get(w)) >= 0); };
        assert(!shown('easyEntry') && !shown('follow') && shown('weight') && shown('theme'), 'the Seats and Ambient light groups hidden');
    }],
    ['2.7.0 tabs switched off and on while Combo runs: the tab shown gives way to Driving; Ambient off gives the lights back, then writes nothing', async () => {
        fakeAmb.calls = [];
        const b = await boot(tmp('tabs-live'));
        await b.tab(2);
        b.settings.set('tabSeats', false);
        const t = await b.draw();
        assert(t.includes('GEAR · SHIFT AT') && !t.includes('SEATS'), 'Seats switched off while shown: Driving: ' + t.join(' | '));
        b.settings.set('tabSeats', true);
        assert((await b.draw()).includes('SEATS'), 'Seats back');
        await b.tab(5);
        b.settings.set('tabAmbient', false);
        assert(fakeAmb.calls.indexOf('carColour') >= 0, 'the lights given back at once: ' + fakeAmb.calls.join(' | '));
        assert(fakeAmb.calls.indexOf('hold off true') < 0, 'held only once the give-back is out');
        const t4 = await b.draw();
        assert(t4.includes('GEAR · SHIFT AT') && !t4.includes('AMBIENT'), 'Ambient switched off while shown: Driving: ' + t4.join(' | '));
        await new Promise((r) => setTimeout(r, 3100));
        assert(fakeAmb.calls.indexOf('hold off true') >= 0 && fakeAmb.calls.indexOf('owner stop') >= 0, 'then no writes, the lights free for another app: ' + fakeAmb.calls.join(' | '));
        fakeAmb.calls = [];
        b.settings.set('tabAmbient', true);
        assert.deepStrictEqual(fakeAmb.calls, ['hold off false', 'owner start', 'apply'], 'on again: writing, claimed anew, the look put on');
        assert((await b.draw()).includes('AMBIENT'), 'Ambient back');
    }],
    ['2.7.0 Ambient off at the start, switched on later: the service starts then', async () => {
        fakeAmb.calls = [];
        const b = await boot(tmp('amb-later'), { settings: { tabAmbient: false } });
        b.settings.set('tabAmbient', true);
        await new Promise((r) => setTimeout(r, 20));
        assert(fakeAmb.calls.indexOf('background {"strobe":false}') >= 0 && fakeAmb.calls.some((c) => /^mount/.test(c)), fakeAmb.calls.join(' | '));
        assert((await b.draw()).includes('AMBIENT'));
    }],
    ['2.9.0 trips: a drive cycle from the car\'s state, distance from the speed or the odometer, fuel with a refuel, resumed after a short stop', async () => {
        const { Trips, END_MS, RESUME_MS, IDLE_MS } = appModule('trips');
        let clock = Date.UTC(2026, 10, 25, 8, 0, 0);
        const lines = [], log = { info: (m) => lines.push(m), warn: (m) => lines.push('WARN ' + m) };
        const dir = tmp('trips'), mk = (o) => new Trips(Object.assign({ dataDir: dir, log, now: () => clock }, o));
        const run = (tb, s, kmh, cond) => { for (let i = 0; i < s; i++) { clock += 1000; tb.tick({ speed: kmh, condition: cond }); } };
        let tb = mk();
        run(tb, 5, 0, 5);
        assert(!tb.current, 'living, not ready to drive: no trip');
        run(tb, 1, 0, 10);
        assert(tb.current, 'ready to drive: a trip');
        tb.fuel(40);
        run(tb, 600, 60, 10);                                        // 10 minutes at 60 km/h
        tb.fuel(35); tb.fuel(55); tb.fuel(50);                        // 5 l used, a refuel to 55, 5 l more
        run(tb, 30, 0, 12);                                          // ending drive readiness...
        assert(tb.current, 'not ended at once');
        run(tb, END_MS / 1000 + 1, 0, 5);
        assert(!tb.current && tb.trips.length === 1, 'ended once out of drive readiness for END_MS');
        let x = tb.trips[0];
        assert(Math.abs(x.km - 10) < 0.2 && x.kmFrom === 'speed' && x.top === 60 && Math.abs(x.movingS - 600) <= 2, JSON.stringify(x));
        assert(x.fuel === 10 && x.refuelled && x.per100 === null, 'fuel before and after the refuel, no consumption under 20 km: ' + JSON.stringify(x));
        // driven again within RESUME_MS: the same trip goes on (an engine-off stop)
        clock += RESUME_MS - 120000; run(tb, 1, 0, 10);                     // (3 min from leaving drive readiness: 91 s gone already)
        assert(tb.current && tb.current.start === x.start && tb.trips.length === 0, 'resumed: ' + tb.trips.length);
        run(tb, 900, 80, 10); run(tb, END_MS / 1000 + 1, 0, 5);
        x = tb.trips[0];
        assert(tb.trips.length === 1 && Math.abs(x.km - 30) < 0.3 && x.per100 !== null && x.top === 80, 'one trip, 30 km, consumption now: ' + JSON.stringify(x));
        // the odometer, when the car sends it, counts the distance
        clock += RESUME_MS + 1000; tb.odometer(1000); run(tb, 1, 0, 10); run(tb, 300, 100, 10); tb.odometer(1009); run(tb, END_MS / 1000 + 1, 0, 5);
        assert(tb.trips.length === 2 && tb.trips[0].km === 9 && tb.trips[0].kmFrom === 'odometer', JSON.stringify(tb.trips[0]));
        // a G26 (2.9.1): the first reading bogus (1024), the real one later; the odometer first read mid-trip
        clock += RESUME_MS + 1000; run(tb, 1, 0, 10); run(tb, 600, 60, 10); tb.odometer(1024, 'SecureMileage'); run(tb, 600, 60, 10); tb.odometer(35748, 'SecureMileage'); tb.odometer(99, 'Kombi'); run(tb, END_MS / 1000 + 1, 0, 5);
        assert(tb.trips[0].kmFrom === 'speed' && Math.abs(tb.trips[0].km - 20) < 0.3, 'an odometer that disagrees with the speed: the speed\'s 20 km: ' + JSON.stringify(tb.trips[0]));
        assert(lines.some((m) => /trips: ended, 20\.0 km \(speed\).*odometer \d+ > 35748/.test(m)) && lines.some((m) => /odometer SecureMileage 35748 km/.test(m)) && lines.some((m) => /odometer from SecureMileage/.test(m)) && tb.odoSrc === 'SecureMileage', lines.slice(-4).join(' | '));
        {
            const tm = new Trips({ dataDir: tmp('trips-mid'), log, now: () => clock });
            run(tm, 1, 0, 10); run(tm, 300, 72, 10); tm.odometer(35748); run(tm, 600, 72, 10); tm.odometer(35760); run(tm, END_MS / 1000 + 1, 0, 5);
            assert(tm.trips[0].kmFrom === 'odometer' && tm.trips[0].km === 18, 'first read 6 km in: 6 km + the odometer\'s 12: ' + JSON.stringify(tm.trips[0]));
        }
        // a few metres (woken and parked again): not kept
        clock += RESUME_MS + 1000; run(tb, 1, 0, 10); run(tb, 5, 5, 10); run(tb, END_MS / 1000 + 1, 0, 5);
        assert.strictEqual(tb.trips.length, 3, 'a trip under 0.2 km not kept');
        // the app stopped mid-trip: resumed by the next start within RESUME_MS, else ended at its last save
        clock += RESUME_MS + 1000; run(tb, 1, 0, 10); run(tb, 120, 90, 10); tb.save();
        const started = tb.current.start;
        tb = mk(); clock += 60000; run(tb, 1, 0, 10);
        assert(tb.current && tb.current.start === started, 'resumed after the app restarted');
        run(tb, 60, 90, 10); tb.save();
        tb = mk(); clock += RESUME_MS + 60000; run(tb, 1, 0, 10);
        assert(tb.current && tb.current.start !== started && tb.trips[0].start === started && Math.abs(tb.trips[0].km - 4.5) < 0.2, 'too late: the old one ended, a new one: ' + JSON.stringify(tb.trips[0]));
        // a car that sends no state: moving starts it, IDLE_MS standing ends it
        const nd = tmp('trips-nostate'); let t2 = new Trips({ dataDir: nd, log, now: () => clock });
        run(t2, 10, 0, undefined); assert(!t2.current, 'standing, no state: no trip');
        run(t2, 120, 50, undefined); assert(t2.current, 'moving: a trip');
        run(t2, IDLE_MS / 1000 + 2, 0, undefined); assert(!t2.current && t2.trips.length === 1, 'standing IDLE_MS: ended');
        // the month, and the tab (km and mph) with nothing undefined
        const m = tb.months()[0];
        assert(m.key === '2026-11' && m.trips >= 4 && m.km > 40, JSON.stringify(m));
        const draw = async (tr, unit) => { tr.settings = { get: (k) => (k === 'speedUnit' ? unit : null) }; return textsOf(() => tr.draw(new Canvas(1600, 520), themes.theme('m_tricolour'))); };
        for (const u of ['kmh', 'mph']) {
            const tx = await draw(tb, u);
            assert((u === 'mph' || (tx.includes('This trip') && tx.includes('This month'))) && !tx.some((q) => /NaN|undefined|null|^0 l$/.test(q)), u + ': ' + tx.join(' | '));      // (titles cached after the first draw)
            assert(tx.some((q) => (u === 'mph' ? / mi$/ : / km$/).test(q)), u + ' distance unit: ' + tx.join(' | '));
        }
        const empty = await draw(new Trips({ log, now: () => clock }), 'kmh');
        assert(empty.includes('No trip yet') && !empty.some((q) => /NaN|undefined/.test(q)), empty.join(' | '));
    }],
    ['2.9.0 since refuelling: a refuel (also a litre at a time at the pump, or while the app was off) starts a count: distance, fuel, consumption', async () => {
        const { Trips } = appModule('trips');
        let clock = Date.UTC(2026, 10, 25, 8, 0, 0);
        const lines = [], log = { info: (m) => lines.push(m), warn: (m) => lines.push('WARN ' + m) };
        const dir = tmp('refuel'), mk = () => new Trips({ dataDir: dir, log, now: () => clock });
        const run = (tb, s, kmh, cond) => { for (let i = 0; i < s; i++) { clock += 1000; tb.tick({ speed: kmh, condition: cond }); } };
        let tb = mk();
        tb.fuel(20); tb.fuel(21); tb.fuel(20);
        assert.strictEqual(tb.sinceRefuel(), null, 'no refuel seen yet');
        const empty = await textsOf(() => tb.draw(new Canvas(1600, 520), themes.theme('m_tricolour')));
        assert(empty.includes('Counts from the next refuel'), empty.join(' | '));
        // at the pump, the app running: the level climbs a litre at a time to 55
        tb.odometer(1000);
        for (let l = 21; l <= 55; l++) { clock += 5000; tb.fuel(l); }
        let r = tb.sinceRefuel();
        assert(r && r.fuel === 0 && r.km === 0 && lines.filter((m) => /refuelled/.test(m)).length === 1, 'one refuel, counted from the full tank: ' + JSON.stringify(r) + ' ' + lines.join(' | '));
        // driven 450 km (odometer), 30 l used: 6.7 l/100
        run(tb, 1, 0, 10); run(tb, 16200, 100, 10); tb.odometer(1450); tb.fuel(40); tb.fuel(25); run(tb, 62, 0, 5);
        r = tb.sinceRefuel();
        assert(r.km === 450 && r.kmFrom === 'odometer' && r.fuel === 30 && r.per100 === 6.7, JSON.stringify(r));
        // kept across a restart
        tb.save(); tb = mk(); tb.odometer(1450); tb.fuel(25);
        r = tb.sinceRefuel();
        assert(r && r.km === 450 && r.fuel === 30, 'after a restart: ' + JSON.stringify(r));
        // refuelled while the app wasn't running: the first level against the last one known
        tb.save(); tb = mk(); clock += 3600000; tb.odometer(1452); tb.fuel(52);
        r = tb.sinceRefuel();
        assert(r && r.fuel === 0 && r.km === 0, 'a refuel between two starts: ' + JSON.stringify(r));
        // without the odometer: the speed's distance; consumption only from 20 km
        const d2 = tmp('refuel-speed'), t2 = new Trips({ dataDir: d2, log, now: () => clock });
        t2.fuel(15); t2.fuel(50); run(t2, 1, 0, 10); run(t2, 360, 100, 10); t2.fuel(49);
        r = t2.sinceRefuel();
        assert(r.kmFrom === 'speed' && Math.abs(r.km - 10) < 0.2 && r.fuel === 1 && r.per100 === null, '10 km: no consumption yet: ' + JSON.stringify(r));
        // a refuel during a trip, a litre at a time: the trip's fuel is what went before it and after it
        t2.fuel(40); for (let l = 41; l <= 58; l++) t2.fuel(l); t2.fuel(55);
        assert.strictEqual(t2.closed(t2.current).fuel, 13, 'trip fuel: 50 > 40, then 58 > 55: ' + JSON.stringify(t2.closed(t2.current)));
        const tx = await textsOf(() => t2.draw(new Canvas(1600, 520), themes.theme('m_tricolour')));
        assert(tx.some((q) => /^from 20 km$/.test(q)) || tx.some((q) => /l\/100$/.test(q)), tx.join(' | '));
        assert(!tx.some((q) => /NaN|undefined|null/.test(q)), tx.join(' | '));
    }],
    ['2.9.0 the Trips tab: between M View and Ambient, End trip, off in Settings > Tabs', async () => {
        const b = await boot(tmp('tripstab'));
        const t4 = await b.tab(4);
        assert(t4.includes('TRIPS') && (t4.includes('No trip yet') || t4.includes('Last trip') || t4.includes('This trip')), t4.join(' | '));
        assert.strictEqual(b.rates[b.rates.length - 1], 1, 'Trips drawn once a second');
        b.settings.set('tabTrips', false);
        const t = await b.draw();
        assert(!t.includes('TRIPS') && t.includes('GEAR · SHIFT AT'), 'switched off: gone, Driving shown: ' + t.join(' | '));
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
        await b.tab(5);
        await new Promise((r) => setTimeout(r, 600));
        assert.strictEqual(link.asked.length, before, 'read on an ambient tab');
    }],
    ['2.0 #3 the bar\'s Reset by tab: peaks, the drag run, the car\'s colour', async () => {
        fakeAmb.calls = [];
        const b = await boot(tmp('reset'));
        await b.tab(1);
        b.clicks.BTN_RESET();
        await b.tab(5);
        b.clicks.BTN_RESET();
        assert(fakeAmb.calls.indexOf('original') >= 0, 'Original colour on the ambient tabs');
        // the kit runs the screen: each tab's own button on the page
        // the kit runs the screen: each tab's own action in the side rail (a handle on the left edge opens it)
        await b.tab(3); await b.draw(); await b.press('rail'); await b.press('misfires');
        await b.tab(2); await b.draw(); await b.press('rail'); await b.press('seats-again');
        await b.tab(0); await b.draw(); await b.press('rail'); await b.press('peaks');
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
    ['2.9.4 log upload: off by default, nothing without upload.json or internet; each upload the new lines only, a VIN masked, the token never logged', async () => {
        const { LogUpload, newLines } = require(path.join(KIT, 'logupload'));
        const data = tmp('up'), file = path.join(data, 'cockpit_combo.log'), logged = [];
        const log = { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) };
        const line = (t, m) => '2026-11-26T10:00:' + t + '.000Z INFO ' + m + '\n';
        fs.writeFileSync(file + '.1', line('01', 'old one'));
        fs.writeFileSync(file, line('02', 'starting WBA12345678901234 here') + '    at a stack line\n' + line('03', 'drive'));
        const puts = [];
        let on = false, status = 201;
        const fake = (cfg, f, body, lookup) => { puts.push({ cfg, f, body, lookup }); return Promise.resolve({ status, text: '{}' }); };
        const lease = path.join(data, 'lease.json');
        const up = new LogUpload({ file, dataDir: data, app: 'cockpit_combo', version: '2.9.4', log, enabled: () => on, put: fake, leases: [lease] });
        assert.strictEqual(await up.send('t'), 'off', 'off by default');
        on = true;
        assert.strictEqual(await up.send('t'), 'no config');
        fs.writeFileSync(path.join(data, 'upload.json'), JSON.stringify({ repo: 'me/cockpit-logs', token: 'github_pat_SECRET' }));
        assert.strictEqual(await up.send('t'), 'offline', 'no mgu-uplink lease');
        assert(/No internet/.test(up.status()));
        fs.writeFileSync(lease, JSON.stringify({ dns: ['1.1.1.1'] }));
        assert.strictEqual(await up.send('car stopped'), 'sent');
        assert.strictEqual(puts.length, 1);
        assert.strictEqual(puts[0].f, 'logs/cockpit_combo/2026-11/2026-11-26T10-00-01-2.9.4.log');
        assert.strictEqual(typeof puts[0].lookup, 'function', 'names resolved through the lease\'s DNS');
        const txt = Buffer.from(puts[0].body.content, 'base64').toString();
        assert(/old one/.test(txt) && /at a stack line/.test(txt) && /<VIN>/.test(txt) && !/WBA12345678901234/.test(txt), txt);
        assert(!puts[0].body.branch, 'the default branch');
        assert.strictEqual(await up.send('t'), 'nothing', 'nothing new');
        fs.appendFileSync(file, line('09', 'parked'));
        status = 403;
        assert.strictEqual(await up.send('t'), 'failed');
        status = 201;
        const up2 = new LogUpload({ file, dataDir: data, app: 'cockpit_combo', version: '2.9.4', log, enabled: () => true, put: fake, leases: [lease] });
        assert.strictEqual(await up2.send('start'), 'sent', 'the state kept over a restart');
        const txt2 = Buffer.from(puts[2].body.content, 'base64').toString();
        assert(/parked/.test(txt2) && !/drive/.test(txt2), 'only the lines after the last sent: ' + txt2);
        assert(!logged.some((m) => /SECRET/.test(m)), 'the token never in the log');
        assert.deepStrictEqual(newLines(file, '2026-11-26T10:00:05.000Z'), [line('09', 'parked').trim()]);
        // 2.9.5: GitHub took an earlier try but its answer was lost: the same name is refused (422), so once more under
        // a name of its own instead of failing for good
        fs.appendFileSync(file, line('20', 'again'));
        let n = 0;
        const up3 = new LogUpload({ file, dataDir: data, app: 'cockpit_combo', version: '2.9.5', log, enabled: () => true, leases: [lease],
            put: (cfg, f) => { puts.push({ f }); return Promise.resolve({ status: n++ ? 201 : 422, text: 'sha' }); } });
        const before = puts.length;
        assert.strictEqual(await up3.send('t'), 'sent', 'not stuck on a name that is taken');
        assert(/T10-00-\d\d-2\.9\.5-\d{6}\.log$/.test(puts[before + 1].f) && puts[before].f !== puts[before + 1].f, puts[before + 1].f);
        assert.strictEqual(await up3.send('t'), 'nothing');
        // the rotated file is read only while the current one does not reach back to the last line sent
        fs.writeFileSync(file + '.1', line('30', 'stale: later than the mark, but the current file starts before it'));
        assert.deepStrictEqual(newLines(file, '2026-11-26T10:00:05.000Z').map((l) => l.slice(30)), ['parked', 'again']);
        assert.strictEqual(newLines(file, '').length, 6, 'all of both when nothing was sent yet');
        // the settings row asks for the status each frame: upload.json is not read from the disk each time
        const reads = [], readFileSync = fs.readFileSync;
        fs.readFileSync = function (f) { reads.push(String(f)); return readFileSync.apply(fs, arguments); };
        try { for (let k = 0; k < 50; k++) up3.status(); } finally { fs.readFileSync = readFileSync; }
        assert(reads.filter((f) => /upload\.json$/.test(f)).length <= 1, 'read ' + reads.length + ' times for 50 frames');
        // a kit feature: app.json "logUpload" -> build.py adds the setting (off) and the Store's internet (mgu-uplink)
        assert.strictEqual(SPEC.logUpload, true);
        const py = require('child_process').spawnSync('python3', ['-c', 'import json,sys; sys.path.insert(0, sys.argv[1]); import build; '
            + 's = build.kit_features(json.load(open(sys.argv[2]))); u = [x for x in s["settings"] if x["key"] == "uploadLogs"]; '
            + 'print(json.dumps([s.get("internet"), len(u), u[0]["default"], u[0]["group"]]))', path.join(ROOT, 'kit', 'tools'), path.join(APP, 'app.json')], { encoding: 'utf8' });
        assert.deepStrictEqual(JSON.parse(py.stdout), [true, 1, false, 'Log upload'], py.stderr);
    }],
    ['2.9.7 the Store\'s renderer (mgu-render) before the community socket: an older renderer beside it never gets the app', async () => {
        const env = Object.assign({}, process.env); delete env.MGU_RENDERD_SOCKET;
        const r = require('child_process').spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(process.argv[1]).SOCKETS))', path.join(KIT, 'renderd.js')], { env, encoding: 'utf8' });
        assert.deepStrictEqual(JSON.parse(r.stdout), ['/run/mgu-render/render.sock', '/run/mgu-renderd/renderd.sock'], r.stderr);
    }],
    ['2.9.6 phone sign-in: GitHub\'s device flow (waits, slows down), the logs repository found, tokens renewed and refused, the sheet', async () => {
        const { GitHubAuth, signInSheet } = require(path.join(KIT, 'ghauth'));
        const { LogUpload } = require(path.join(KIT, 'logupload'));
        const data = tmp('auth'), logged = [], log = { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) };
        let now = 1e12, polls = 0, refused = false;
        const waits = [];
        const reply = (o, status) => Promise.resolve({ status: status || 200, text: JSON.stringify(o) });
        const calls = [];
        const http = (req) => {
            calls.push(req.method + ' ' + req.host + req.path.split('?')[0] + (req.body ? ' ' + req.body : ''));
            if (req.path === '/login/device/code') return reply({ device_code: 'DEV', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
            if (req.path === '/login/oauth/access_token' && /device_code/.test(req.body)) {
                polls++;
                return reply(polls === 1 ? { error: 'authorization_pending' } : polls === 2 ? { error: 'slow_down', interval: 10 }
                    : { access_token: 'ghu_A', expires_in: 28800, refresh_token: 'ghr_A', refresh_token_expires_in: 15897600 });
            }
            if (req.path === '/login/oauth/access_token' && /refresh_token/.test(req.body)) return refused ? reply({ error: 'bad_refresh_token' }) : reply({ access_token: 'ghu_B', expires_in: 28800, refresh_token: 'ghr_B', refresh_token_expires_in: 15897600 });
            if (req.path === '/user') return reply({ login: 'snorkmitzumi' });
            if (req.path.indexOf('/user/installations?') === 0) return reply({ installations: [{ id: 7 }] });
            if (req.path.indexOf('/user/installations/7/repositories') === 0) return reply({ repositories: [{ full_name: 'snorkmitzumi/notes' }, { full_name: 'snorkmitzumi/cockpit-logs' }] });
            return reply({}, 404);
        };
        const file = path.join(data, 'upload-auth.json');
        const a = new GitHubAuth({ file, clientId: 'Iv23test', log, http, now: () => now, wait: (ms, fn) => { waits.push(ms); return setTimeout(fn, 0); } });
        let enabled = false;
        const sh = signInSheet({ auth: a, send: () => Promise.resolve('sent'), enabled: () => enabled, enable: () => { enabled = true; } });
        const cv = () => new Canvas(1600, 520);
        let tx = await textsOf(() => sh.draw(cv(), themes.theme('m_tricolour')));
        assert(tx.includes('Sign in with GitHub') && !tx.some((x) => /NaN|undefined/.test(x)), tx.join(' | '));
        sh.press();                                                     // Sign in with GitHub
        for (let k = 0; k < 20 && !(a.flow && a.flow.phase === 'done'); k++) await new Promise((r) => setTimeout(r, 5));
        assert.strictEqual(a.flow.phase, 'done', JSON.stringify(a.flow));
        assert.deepStrictEqual(waits, [5000, 5000, 10000], 'polled at the interval, slower after slow_down');
        assert(calls.some((c) => /client_id=Iv23test/.test(c)) && !calls.some((c) => /client_secret/.test(c)), 'the client id only, no secret');
        assert.deepStrictEqual(a.signedIn(), { login: 'snorkmitzumi', repo: 'snorkmitzumi/cockpit-logs' }, 'the repository named ...logs');
        assert(enabled, 'signing in switches Upload logs on');
        assert.strictEqual((fs.statSync(file).mode & 0o777).toString(8), '600', 'the tokens readable by the app only');
        assert(!logged.some((m) => /ghu_|ghr_/.test(m)), 'no token in the log');
        // while the code shows: the code and the page to open on the phone
        const b = new GitHubAuth({ file: path.join(data, 'b.json'), clientId: 'Iv23test', log, http, now: () => now, wait: () => 0 });
        b.start(); await new Promise((r) => setTimeout(r, 5));
        tx = await textsOf(() => signInSheet({ auth: b, send: () => null, enabled: () => true, enable: () => {} }).draw(cv(), themes.theme('m_tricolour')));
        assert(tx.includes('WDJB-MJHT') && tx.includes('github.com/login/device') && tx.includes('Cancel'), tx.join(' | '));
        b.cancel();
        // signed in: the sheet offers Send now and Sign out
        tx = await textsOf(() => sh.draw(cv(), themes.theme('m_tricolour')));
        assert(tx.includes('Send now') && tx.includes('Sign out') && tx.some((x) => /snorkmitzumi\/cockpit-logs/.test(x)), tx.join(' | '));
        // the token: as it is while it lasts, renewed near its end (the new pair kept), signed out when GitHub refuses
        assert.strictEqual(await a.token(), 'ghu_A');
        now += 28800 * 1000 - 60000;
        assert.strictEqual(await a.token(), 'ghu_B');
        assert.strictEqual(new GitHubAuth({ file, clientId: 'x', log, http }).a.refresh, 'ghr_B', 'the renewed tokens saved');
        now += 28800 * 1000; refused = true;
        assert.strictEqual(await a.token(), null);
        assert(!a.signedIn() && !fs.existsSync(file), 'signed out');
        // the upload with a sign-in instead of upload.json
        refused = false; polls = 2;
        const c = new GitHubAuth({ file: path.join(data, 'c.json'), clientId: 'Iv23test', log, http, now: () => now, wait: (ms, fn) => setTimeout(fn, 0) });
        c.start();
        for (let k = 0; k < 20 && !(c.flow && c.flow.phase === 'done'); k++) await new Promise((r) => setTimeout(r, 5));
        const lease = path.join(data, 'lease.json'); fs.writeFileSync(lease, JSON.stringify({ dns: ['1.1.1.1'] }));
        const lf = path.join(data, 'app.log'); fs.writeFileSync(lf, '2026-11-26T10:00:01.000Z INFO hello\n');
        const puts = [];
        const up = new LogUpload({ file: lf, dataDir: data, app: 'cockpit_combo', version: '2.9.6', log, enabled: () => true, leases: [lease], auth: c,
            put: (cfg, f) => { puts.push(cfg); return Promise.resolve({ status: 201, text: '{}' }); } });
        assert(/^On, to snorkmitzumi\/cockpit-logs/.test(up.status()), up.status());
        assert.strictEqual(await up.send('t'), 'sent');
        assert.strictEqual(puts[0].repo, 'snorkmitzumi/cockpit-logs'); assert(/^ghu_/.test(puts[0].token));
        // no app id and no upload.json: says what it needs
        assert(/upload\.json/.test(new LogUpload({ file: lf, dataDir: tmp('none'), app: 'x', version: '1', log, enabled: () => true }).status()));
    }],
    ['2.9.3 tyres: a car with no units event (G26) reads deg C unless its own pressures are psi; one odd value latches nothing', async () => {
        const T = (a) => ({ actualValueTemperatureTyreFLH: a[0], actualValueTemperatureTyreFRH: a[1], actualValueTemperatureTyreRLH: a[2], actualValueTemperatureTyreRRH: a[3] });
        const P = (a) => ({ actualValuePressureTyreFLH: a[0], actualValuePressureTyreFRH: a[1], actualValuePressureTyreRLH: a[2], actualValuePressureTyreRRH: a[3] });
        const eu = signalRig();
        // 2.9.2 on the G26: raw 47 (7 deg C) shown as -14 after an odd pressure value had latched psi
        eu.w.TPMS.statusTargetTyrePressure({ targetPressureTyreFLH: 300, targetPressureTyreFRH: 27, targetPressureTyreRLH: 27, targetPressureTyreRRH: 27 });
        eu.w.TPMS.statusTyrePressure(P([300, 27, 27, 27]));
        eu.w.TPMS.statusTyreTemperature(T([47, 47, 47, 46]));
        assert.deepStrictEqual(['FL', 'FR', 'RL', 'RR'].map((k) => eu.v.live.tyres[k].t), [7, 7, 7, 6]);
        const us = signalRig();
        us.w.TPMS.statusTyrePressure(P([410, 410, 400, 400]));
        us.w.TPMS.statusTyreTemperature(T([108, 108, 108, 108]));
        assert.strictEqual(us.v.live.tyres.FL.t, 20, 'a psi car: 68 F = 20 C');
        us.w.TPMS.statusTyrePressure(P([27, 27, 27, 27]));
        us.w.TPMS.statusTyreTemperature(T([47, 47, 47, 47]));
        assert.strictEqual(us.v.live.tyres.FL.t, 7, 'taken again with each reading');
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
        assert(logs.some((x) => /seat 0x6D: SLV 23000>23600 \(\+600 in \d\.\d s\)/.test(x)), 'move logged once settled: ' + logs.join(' | '));
        assert(logs.some((x) => /seat 0x6D motors: SLV\+/.test(x)), 'the motor running logged');
        assert(logs.some((x) => /seat 0x6D switch: SLV\+/.test(x)), 'switch logged');
        assert(logs.some((x) => /initialisation OK/.test(x)));
        // only reads: the discovery and 22 to single units
        assert(sent.every((x) => x === '22F150' || /^[0-9a-f]+:d70[248]$|^[0-9a-f]+:d712$/.test(x)), sent.join(' '));
        const cv = new Canvas(1600, 520), out = [];
        cv.own = true; const tx = cv.text; cv.text = function (x, ...r2) { out.push(String(x)); return tx.call(this, x, ...r2); };
        s.draw(cv, themes.theme('m_tricolour'));
        // without the seat writer: the seat drawn, no arrows, no memory
        assert(out.includes('Driver seat') && !out.includes('Fore / aft') && !out.includes('SAVE') && !out.some((x) => /NaN|undefined/.test(x)), out.join(' | '));
        assert(!(cv.targets || []).some((x) => /^seat-/.test(x.key)), 'nothing to press');
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
        const t3 = await b.tab(6);
        assert(t3.includes('AMBIENT TAB 1'), 'Animations as a tab: ' + t3.join(' | '));
    }],
    ['2.4.10 the side rail with the controller: pushed left opens it (the knob on its first row), right closes it', async () => {
        const b = await boot(tmp('tilt'));
        await b.tab(3); await b.draw();
        assert.strictEqual(b.tilt('W'), 'misfires', 'M View: the knob onto Reset misfires');
        const t1 = await b.draw();
        assert(t1.includes('RESET MISFIRES'), 'the rail open: ' + t1.join(' | '));
        assert.strictEqual(b.tilt('W'), true, 'open: left again is taken (not back, which leaves the app)');
        assert.strictEqual(b.tilt('E'), true, 'right closes it');
        const t2 = await b.draw();
        assert(!t2.includes('RESET MISFIRES'), 'closed');
        assert.strictEqual(b.tilt('E'), null, 'closed: right is the kit\'s');
        await b.tab(5);
        assert.strictEqual(b.tilt('E'), true, 'the Ambient tab opened it by itself the first time: right closes it');
        assert.strictEqual(b.tilt('W'), 'amb-0', 'Ambient: the knob onto Colour');
    }],
    ['2.5.0 map style: the pages in a left bar, the tab\'s action and Settings in a right one, no tabs needed', async () => {
        fakeAmb.calls = [];
        const b = await boot(tmp('map'), { map: true });
        await b.draw();
        assert.strictEqual(b.tilt('W'), 'nav-0', 'pushed left: the pages, the knob on Driving');
        const tl = await b.draw();
        // 2.6.9: as BMW's map draws its menu - a row a page, its name as written, no Hide row (a touch on the page closes it)
        ['Driving', 'Performance', 'Seats', 'M View', 'Ambient', 'Colour', 'Animations', 'Modes'].forEach((x) => assert(tl.includes(x), x + ' missing: ' + tl.join(' | ')));
        assert(!tl.some((x) => /hide/i.test(x)), 'no Hide row: ' + tl.join(' | '));
        assert((b.canvas().targets || []).some((q) => q.key === 'rail-close' && q.x >= 394), 'the dimmed page closes it');
        await b.press('nav-3');
        const tm = await b.draw();
        assert(tm.includes('this drive') && !tm.includes('COLOUR'), 'M View shown, the bar closed: ' + tm.join(' | '));
        assert(['rail', 'rail-r'].every((k) => (b.canvas().targets || []).some((q) => q.key === k)), 'a handle each side');
        // 2.5.2: the handles are touch places only (nothing drawn, as BMW's map), an open bar covers a whole column
        const rr = Canvas.prototype.roundRect, slim = [];
        Canvas.prototype.roundRect = function (x, y, w, h) { if (w === 10 && h === 120) slim.push(x); return rr.apply(this, arguments); };
        try { await b.draw(); } finally { Canvas.prototype.roundRect = rr; }
        assert.deepStrictEqual(slim, [], 'no handle drawn in map style');
        assert.strictEqual(b.tilt('E'), 'misfires', 'pushed right: the knob on Reset misfires');
        const tr = await b.draw();
        // 2.6.9: a narrow column as BMW's map's, each action's icon over its name; the page beside it closes it
        const hide = (b.canvas().targets || []).find((q) => q.key === 'rail-r-close');
        assert(hide && hide.x === 0 && hide.w >= 1380, 'the dimmed page closes the right bar: ' + JSON.stringify(hide));
        const col = (b.canvas().targets || []).find((q) => q.key === 'settings');
        assert(col && col.w <= 210 && col.x + col.w >= 1580, 'a narrow column at the right edge: ' + JSON.stringify(col));
        assert(tr.includes('Reset misfires') && tr.includes('Settings'), 'the right bar: ' + tr.join(' | '));
        assert.strictEqual(b.tilt('W'), true, 'pushed left: the right bar closes');
        await b.draw(); await b.press('rail-r'); await b.press('settings');
        assert.deepStrictEqual(b.opened, ['settings'], 'Settings from the right bar');
        await b.draw(); await b.press('rail'); await b.press('amb-2');
        const ta = await b.draw();
        assert(ta.includes('AMBIENT TAB 2') && fakeAmb.calls.indexOf('select 2') >= 0, 'Ambient\'s Modes from the left bar: ' + ta.join(' | '));
    }],
    ['2.5.1 Driving with room below the page (no bar): the panels share it, none ends in a strip, none gets it twice', async () => {
        freshKit();
        const G = require(path.join(KIT, 'gauges'));
        delete require.cache[path.join(APP, 'draw.js')];
        const draw = require(path.join(APP, 'draw.js'));
        const bottoms = [], panel = G.panel;
        G.panel = function (cv, t, x, y, w, h, title) { const r = panel.apply(this, arguments); bottoms.push([title, Math.round(r.y + r.h)]); return r; };
        try {
            const cv = new Canvas(1600, 520); cv.extra = 49;
            draw.render(cv, themes.theme('m_tricolour'), car(), { settings: settingsOf(), peak: () => null, why: () => '', redline: 7000, scaleMax: 8000, has48: true, tabs: [], sel: 0 });
            const by = (n) => (bottoms.find((b) => b[0] === n) || [])[1];
            ['Boost', 'xDrive', '12 V battery'].forEach((n) => assert(Math.abs(by(n) - (512 + 49)) <= 1, n + ' to the screen\'s bottom: ' + JSON.stringify(bottoms)));
            assert(by('Engine speed') > 270 && by('Engine speed') < 512, 'the upper panel grew by its share: ' + by('Engine speed'));
            assert(!bottoms.some((b) => b[1] > 512 + 50), 'none got the room twice: ' + JSON.stringify(bottoms));
        } finally { G.panel = panel; }
    }],
    ['2.5.1 M View with room below the page: both rows of tiles the same height, down to the screen\'s bottom', async () => {
        const { MView } = appModule('mview');
        const G = require(path.join(KIT, 'gauges'));
        const tiles = [], stat = G.stat;
        G.stat = function (cv, t, x, y, w, h, o) { tiles.push([o.label, y, h, cv.extra]); return stat.apply(this, arguments); };
        try {
            const m = new MView({ reader: { key: () => '' }, values: { live: {} }, cfg: SPEC.config.mview, settings: settingsOf(), log: quiet });
            const cv = new Canvas(1600, 520); cv.extra = 49;
            m.draw(cv, themes.theme('m_tricolour'), { demo: true });
            const h = tiles.map((x) => x[2]);
            assert(h.length === 4 && h.every((x) => x === h[0]) && h[0] > 228, 'the same height, taller: ' + JSON.stringify(tiles));
            assert(Math.abs(tiles[2][1] + tiles[2][2] - 561) <= 1, 'the lower row to the bottom: ' + JSON.stringify(tiles));
            assert(tiles.every((x) => !x[3]), 'drawn with the kit\'s stretch off');
            assert.strictEqual(cv.extra, 49, 'the room given back afterwards');
        } finally { G.stat = stat; }
    }],
);

// 2.6.0 seat memory: a seat module simulated as the G26's (ISTA's trace, 2026-11-22): the motors move at the speeds
// measured on the car while 2E D7 08 says so, until a STOP; D704 the real reply (initialised, the learned end stops)
const D704_G26 = [0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x02, 0x02, 0x02, 0x02, 0x02,
    0x02, 0x02, 0x00, 0x02, 0x01, 0x02, 0x02, 0x05, 0x06, 0x06, 0x06, 0x09, 0x05, 0x05, 0x0C, 0x0C, 0x09, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x02,
    0x02, 0x02, 0x02, 0x02, 0x02, 0x82, 0x0E, 0x7F, 0xEE, 0x80, 0x76, 0x7E, 0x97, 0x80, 0x34, 0x7A, 0x51, 0x80, 0x64, 0x7F, 0x92, 0x80, 0x84, 0x7F,
    0x90, 0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01];
function seatRig(o) {
    o = o || {};
    const C = 32768, SPEED = [38, 62, 59, 40, 80];
    const st = { n: 0, clock: 1e6, pos: [C + 345, C - 355, C - 380, C + 93, C - 9], run: [0, 0, 0, 0, 0], frac: [0, 0, 0, 0, 0], sent: [], maxAtOnce: 0, sw: false, init: 1, stuck: -1 };
    const step = (ms) => {
        for (let i = 0; i < 5; i++) {
            if (!st.run[i] || i === st.stuck) continue;
            st.frac[i] += SPEED[i] * ms / 1000 * (st.run[i] === 1 ? 1 : -1);
            const n = Math.trunc(st.frac[i]); st.pos[i] += n; st.frac[i] -= n;
        }
        st.clock += ms;
    };
    const be = (n) => [n >> 8, n & 255];
    const reply = (a, did) => {
        if (did === 0xD702) return [0x62, 0xD7, 0x02].concat(...st.pos.map(be), be(C), be(C), be(C));
        if (did === 0xD708) return [0x62, 0xD7, 0x08].concat(st.run, [3, 3, 3, 0, 0, 0, 0]);
        if (did === 0xD712) { const b = new Array(17).fill(0); if (st.sw) b[0] = 1; return [0x62, 0xD7, 0x12].concat(b); }
        if (did === 0xD704) { const d = D704_G26.slice(); d[0] = st.init; return [0x62, 0xD7, 0x04].concat(d); }
        return [0x7F, 0x22, 0x31];
    };
    const link = { available: true, async discover() { return new Map([[0x6D, '0F2A31']]); },
        async read(a, did) {
            step(25 + (o.jitter ? rnd() * o.jitter : 0)); st.sent.push('22 ' + did.toString(16).toUpperCase());
            if (o.busy && ++st.n % o.busy === 0) { st.refused = (st.refused || 0) + 1; throw new Error('transport refused: APP_REQUEST_TEMPORARILY_NOT_ACCEPTED'); }
            return a === 0x6D ? reply(a, did) : null;
        } };
    let seed = o.seed || 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const motor = async (a, m, act, pwm) => {
        step(20 + (o.jitter ? rnd() * o.jitter : 0));
        st.sent.push('2E ' + a.toString(16).toUpperCase() + ' ' + m + ' ' + act + ' ' + pwm);
        if (o.refuse) return [0x7F, 0x2E, 0x22];
        if (o.maxMotors && act !== 0 && !st.run[m] && st.run.filter((x) => x).length >= o.maxMotors) return [0x7F, 0x2E, 0x22];
        if (o.single && act !== 0) st.run = st.run.map((x, j) => (j === m ? x : 0));      // one motor at a time: the next one stops the last
        if (o.coast && act === 0 && st.run[m]) st.pos[m] += (st.run[m] === 1 ? 1 : -1) * o.coast;   // goes on after its STOP (load, the link's delay)
        if (o.busy && ++st.n % o.busy === 0) { st.refused = (st.refused || 0) + 1; throw new Error('transport refused: APP_REQUEST_TEMPORARILY_NOT_ACCEPTED'); }
        st.run[m] = act;
        st.maxAtOnce = Math.max(st.maxAtOnce, st.run.filter((x) => x).length);
        return [0x6E, 0xD7, 0x08];
    };
    const values = { live: { speed: 0 } };
    const logs = [], log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push('ERROR ' + m) };
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'seatmem-'));
    const { SeatModules } = appModule('seatmod'), { SeatMover } = appModule('seatmove');
    const modules = new SeatModules({ link, log, now: () => st.clock, values });
    modules.seats = [{ addr: 0x6D, index: '0F2A31', pos: st.pos.concat([C, C, C]), motor: [], sw: [], init: 1, at: 0 }];
    modules.state = 'found';
    const sleep = async (ms) => { step(ms); if (o.during) o.during(st); };
    const mover = new SeatMover({ motor, modules, values, log, now: () => st.clock, sleep, dataDir: dir });
    return { st, mover, modules, values, logs, dir, C, link, motor };
}
const writes = (st) => st.sent.filter((x) => x.startsWith('2E'));

checks.push(
    ['2.6.0 seat memory: the link lets out 2E D7 08 to 0x6D / 0x6E alone, handed out once; a STOP is not dropped by cancel()', async () => {
        const sent = [];
        stubDiag = class { constructor() { this.p = {}; } async init() {} async physical(target, sid, data) { sent.push([target, sid].concat(data)); return [0x6E, 0xD7, 0x08]; } };
        delete require.cache[path.join(KIT, 'readonly-diag.js')];
        const R = require(path.join(KIT, 'readonly-diag.js'));
        stubDiag = null;
        R.checkSeat(0x6D, [0xD7, 0x08, 4, 1, 100]);
        R.checkSeat(0x6E, [0xD7, 0x08, 0, 0, 1]);
        [[0x6F, [0xD7, 0x08, 0, 1, 100]], [0x12, [0xD7, 0x08, 0, 1, 100]], [0x6D, [0xD7, 0x19, 0, 1, 100]], [0x6D, [0xDA, 0xFC, 0, 1, 100]],
            [0x6D, [0xD7, 0x08, 5, 1, 100]], [0x6D, [0xD7, 0x08, 0, 3, 100]], [0x6D, [0xD7, 0x08, 0, 1, 0]], [0x6D, [0xD7, 0x08, 0, 1, 101]], [0x6D, [0xD7, 0x08, 0, 1]],
            [0x6D, [0xD7, 0x08, 0, 1, 100, 0]]].forEach(([a, d]) => assert.throws(() => R.checkSeat(a, d), /seat motors/, JSON.stringify([a, d])));
        // the reading check still refuses every write
        assert.throws(() => R.check(0x6D, 0x2E, [0xD7, 0x08, 0, 1, 100], false), /not allowed/);
        const l = new R.ReadOnlyDiag({}, quiet);
        await l.init();
        const motor = R.seatMotors(l);
        assert.throws(() => R.seatMotors(l), /already handed out/, 'a second writer');
        // (a function, not the promise: Node 8's assert.rejects takes only that - the car's Node, the CI's node8-runtime job)
        await assert.rejects(() => motor(0x6F, 0, 1, 100), /not a front seat module/);
        await assert.rejects(() => motor(0x6D, 7, 1, 100), /bad motor/);
        assert.strictEqual(sent.length, 0, 'nothing refused was sent');
        const go = motor(0x6D, 0, 1, 100), read = l.read(0x6D, 0xD702), stop = motor(0x6D, 0, 0, 100);
        l.cancel();
        await go;                         // (a start may be dropped: the run's own stop follows anyway)
        assert.strictEqual(await read, undefined, 'a read is dropped by cancel()');
        assert.deepStrictEqual(await stop, [0x6E, 0xD7, 0x08], 'the stop still went');
        assert(sent.some((x) => x.join(',') === [0x6D, 0x2E, 0xD7, 0x08, 0, 0, 100].join(',')), JSON.stringify(sent));
    }],
    ['2.6.0 seat memory: a saved position recalled - every motor at once, straight there, each stopped at its target, nothing else written', async () => {
        const r = seatRig(), { st, mover, C } = r;
        assert(await mover.save(0x6D, '1'));
        const saved = st.pos.slice();
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'seatmem.json'), 'utf8'))['6D']['1'], saved, 'kept in seatmem.json');
        // the seat moved elsewhere with its own switches
        st.pos = [C + 150, C - 200, C - 900, C + 20, C + 100];
        const res = await mover.recall(0x6D, '1');
        assert(res.ok, res.why + ' | ' + r.logs.join(' | '));
        st.pos.forEach((v, i) => assert(Math.abs(v - saved[i]) <= 8, 'axis ' + i + ': ' + (v - saved[i])));
        assert(st.run.every((x) => x === 0), 'every motor stopped');
        assert(st.maxAtOnce >= 4, 'the motors together, not one after another: ' + st.maxAtOnce);
        const w = writes(st);
        assert(w.length && w.every((x) => /^2E 6D [0-4] [012] 100$/.test(x)), w.join(' | '));
        assert(r.logs.some((x) => /Memory 1 reached in \d+\.\d s \(SLV \d+>\d+ \dx \d+\.\d s/.test(x)), 'each motor in the end line: ' + r.logs.join(' | '));
        // each motor started was stopped afterwards, once more on the way out
        [0, 1, 2, 3, 4].forEach((i) => { const mine = w.filter((x) => x.split(' ')[2] === String(i)); if (mine.length) assert(/ 0 100$/.test(mine[mine.length - 1]), 'axis ' + i + ' ends with STOP: ' + mine.join(',')); });
        assert(r.logs.some((x) => /seat 0x6D: Memory 1 reached in \d+\.\d s/.test(x)), r.logs.join(' | '));
        assert(!mover.run && !r.modules.paused, 'the run is over, the modules read again');
    }],
    ['2.6.0 seat memory: a seat switch, the car rolling or the driver\'s own motor ends a move at once, its motors stopped', async () => {
        for (const [what, during, why] of [
            ['switch', (st) => { if (st.clock > 1e6 + 900) st.sw = true; }, /a seat switch was pressed/],
            ['rolling', null, /the car is moving/],
            ['own motor', (st) => { if (st.clock > 1e6 + 900) st.run[1] = 1; }, /moved by hand/],
        ]) {
            let r;
            const o = { during: (st) => { if (during) during(st); if (what === 'rolling' && st.clock > 1e6 + 900) r.values.live.speed = 6; } };
            r = seatRig(o);
            const { st, mover, C } = r;
            mover.mem['6D'] = { '2': [C + 345, C - 355, C + 20, C + 93, C - 9] };
            st.pos[2] = C - 1300;                 // the backrest far off: a long move, interrupted
            const res = await mover.recall(0x6D, '2');
            assert(!res.ok && why.test(res.why), what + ': ' + res.why);
            assert(st.run.every((x, i) => x === 0 || (what === 'own motor' && i === 1)), what + ': motors left running ' + st.run);
            assert(st.pos[2] < C - 1100, what + ': stopped soon, not at the target (' + (st.pos[2] - C) + ')');
        }
    }],
    ['2.6.0 seat memory: not started when moving, locked, not initialised or refused; the target kept inside the end stops', async () => {
        let r = seatRig();
        r.mover.mem['6D'] = { '1': [32768 + 400, 32768 - 355, 32768 - 380, 32768 + 93, 32768 - 9] };
        r.values.live.speed = 30;
        assert(/stands still/.test((await r.mover.recall(0x6D, '1')).why) && !writes(r.st).length, 'driving');
        r.values.live.speed = undefined;
        assert(/No speed/.test((await r.mover.recall(0x6D, '1')).why) && !writes(r.st).length, 'no speed known');
        // the car "locked and left" (as it reports itself right after switching off, while the door opens): no block
        r.values.live.speed = 0; r.values.live.left = true;
        assert((await r.mover.recall(0x6D, '1')).ok, 'locked and left is no reason');
        r.values.live.left = false;
        r = seatRig(); r.st.init = 0; r.mover.mem['6D'] = { '1': [32768 + 400, 32768 - 355, 32768 - 380, 32768 + 93, 32768 - 9] };
        assert(/not initialised/.test((await r.mover.recall(0x6D, '1')).why) && !writes(r.st).length, 'not initialised');
        assert(/not saved/.test((await r.mover.recall(0x6D, '3')).why), 'an empty slot');
        r = seatRig({ refuse: true }); r.mover.mem['6D'] = { '1': [32768 + 400, 32768 - 355, 32768 - 380, 32768 + 93, 32768 - 9] };
        const ref = await r.mover.recall(0x6D, '1');
        assert(!ref.ok && /not started \(refused 22\)/.test(ref.why), ref.why);
        // beyond the learned end stop (SLV +526): kept MARGIN inside it
        r = seatRig(); r.mover.mem['6D'] = { '1': [32768 + 900, 32768 - 355, 32768 - 380, 32768 + 93, 32768 - 9] };
        await r.mover.recall(0x6D, '1');
        assert(Math.abs(r.st.pos[0] - (32768 + 526 - 3)) <= 8, 'clamped: ' + (r.st.pos[0] - 32768));
        // a motor that doesn't move: stopped
        r = seatRig(); r.st.stuck = 2; r.mover.mem['6D'] = { '1': [32768 + 345, 32768 - 355, 32768 - 900, 32768 + 93, 32768 - 9] };
        const st = await r.mover.recall(0x6D, '1');
        assert(/LNV does not move/.test(st.why) && r.st.run.every((x) => !x), st.why);
    }],
    ['2.7.0 the Seats tab off: a door opening moves no seat, and a move under way stops', async () => {
        const r = seatRig(), { st, mover, C } = r;
        mover.mem['6D'] = { E: [C + 30, null, C - 900, null, null] };
        const { Seats } = appModule('seats');
        const S2 = settingsOf({ tabSeats: false });
        const s = new Seats({ signals: { proxy: async () => { throw new Error('interface not found'); } }, log: quiet, now: () => st.clock, values: r.values, link: r.link, motor: r.motor, settings: S2, enabled: () => S2.get('tabSeats') !== false });
        s.modules.seats = r.modules.seats; s.modules.state = 'found'; s.mover.mem = mover.mem; s.mover.sleep = mover.sleep;
        const settle = async () => { for (let k = 0; k < 400 && (s.mover.run || k < 3); k++) await new Promise((res) => setImmediate(res)); await s.entryQueue; };
        s.doors([]); s.doors(['driver front']); await settle();
        assert.strictEqual(writes(st).length, 0, 'moved with the Seats tab off');
        let ended = null;
        s.mover.run = { addr: 0x6D, slot: 'E' };
        s.off(); ended = s.mover.run.end;
        assert(/Seats tab was switched off/.test(ended), 'a move under way stopped: ' + ended);
    }],
    ['2.6.2 easy entry: only a front door opening moves a seat (to its easy entry position); the engine never does; Back by hand', async () => {
        const r = seatRig(), { st, mover, C } = r;
        const drive = st.pos.slice();
        mover.mem['6D'] = { E: [C + 30, null, C - 900, null, null] };
        const { Seats } = appModule('seats');
        const S2 = settingsOf();
        const s = new Seats({ signals: { proxy: async () => { throw new Error('interface not found'); } }, log: quiet, now: () => st.clock, values: r.values, link: r.link, motor: r.motor, settings: S2 });
        s.modules.seats = r.modules.seats; s.modules.state = 'found'; s.mover.mem = mover.mem; s.mover.sleep = mover.sleep;
        const settle = async () => { for (let k = 0; k < 400 && (s.mover.run || k < 3); k++) await new Promise((res) => setImmediate(res)); await s.entryQueue; };
        // the first report (Combo starting) with the door open: nothing moves
        s.doors(['driver front']); await settle();
        assert.strictEqual(writes(st).length, 0, 'a door open at start did not just open');
        // the driver's door opens with the engine off: to the easy entry position, only the axes saved there; the seat module not searched
        // for yet (the Seats tab never open): asked at its usual address
        s.modules.seats = []; s.modules.state = 'idle'; s.modules.link = Object.assign({}, r.link, { available: true });
        s.doors([]); s.doors(['driver front']); await settle();
        assert(s.modules.seats.some((x) => x.addr === 0x6D), 'the seat module taken at 0x6D');
        assert(Math.abs(st.pos[0] - (C + 30)) <= 8 && Math.abs(st.pos[2] - (C - 900)) <= 8 && st.pos[1] === drive[1], 'to the entry position: ' + st.pos.map((v) => v - C));
        assert.deepStrictEqual(s.mover.slots(0x6D).R, drive, 'the driving position kept');
        assert(s.mover.entered(0x6D));
        // closed and opened again (getting in): already there, nothing moves, the driving position still the one kept
        s.doors([]); const n = writes(st).length; s.doors(['driver front']); await settle();
        assert.strictEqual(writes(st).length, n, 'already at the entry position: not moved');
        assert.deepStrictEqual(s.mover.slots(0x6D).R, drive);
        // the tab: 1, 2, Easy entry, Back, Save
        const draw = () => { const cv = new Canvas(1600, 520), out = []; cv.own = true; const tx = cv.text; cv.text = function (x, ...a) { out.push(String(x)); return tx.call(this, x, ...a); }; s.draw(cv, themes.theme('m_tricolour')); return { cv, out }; };
        const press = (c, key) => { const b = c.targets.find((x) => x.key === key); assert(b, key + ' not pressable: ' + c.targets.map((x) => x.key).join(',')); return b.run(); };
        let { cv, out } = draw();
        ['1', '2', 'EASY ENTRY', 'BACK', 'SAVE'].forEach((x) => assert(out.includes(x), x + ' missing: ' + out.join(' | ')));
        // the engine started and stopped again and again (start-stop at a light, the engine switched off): nothing moves
        assert(typeof s.watchEngine !== 'function', 'no engine watch');
        const n2 = writes(st).length;
        for (const rpm of [700, 0, 750, 0, 800]) { r.values.live.rpm = rpm; r.values.live.rpmT = st.clock; st.clock += 3000; await settle(); }
        assert.strictEqual(writes(st).length, n2, 'the engine moved a seat');
        // Back (by hand): to the driving position
        ({ cv, out } = draw());
        press(cv, 'seat-109-back'); await settle();
        st.pos.forEach((v, i) => assert(Math.abs(v - drive[i]) <= 8, 'back: axis ' + i + ' ' + (v - drive[i])));
        assert(!s.mover.entered(0x6D), 'entry over');
        // with the engine running a door opened still takes the seat there (only the door counts)
        r.values.live.rpm = 700; r.values.live.rpmT = st.clock;
        s.doors([]); s.doors(['driver front']); await settle();
        assert(Math.abs(st.pos[0] - (C + 30)) <= 8, 'engine on, door opened: easy entry');
        // the setting off: nothing
        assert((await s.mover.back(0x6D)).ok);
        const m2 = writes(st).length;
        S2.set('easyEntry', false); s.doors([]); s.doors(['driver front']); await settle();
        assert.strictEqual(writes(st).length, m2, 'switched off: no easy entry');
        ({ cv, out } = draw());
        assert(out.includes('EASY ENTRY') && !out.includes('3') && !out.includes('BACK'), out.join(' | '));
        // Save then 2 keeps the position in 2
        assert(!cv.targets.some((x) => x.key === 'seat-109-2'), 'an empty slot is not pressable');
        press(cv, 'seat-109-save');
        ({ cv, out } = draw());
        assert(out.some((x) => /^Press 1, 2 or Easy entry/.test(x)), out.join(' | '));
        press(cv, 'seat-109-2');
        for (let k = 0; k < 20 && !s.mover.slots(0x6D)['2']; k++) await new Promise((res) => setImmediate(res));
        assert.deepStrictEqual(s.mover.slots(0x6D)['2'], st.pos, 'saved in 2');
    }],
    ['2.6.5 an uneven link (each request 25-80 ms as ISTA saw the seat module, every fourth turned away): ten recalls, each motor within 8 counts (the tolerance)', async () => {
        for (const seed of [7, 11, 23]) {
            const r = seatRig({ jitter: 55, busy: 4, seed }), { st, mover, C } = r;
            const places = [[C + 150, C - 200, C - 900, C + 20, C + 100], [C + 500, C + 100, C - 100, C - 90, C - 100], [C + 10, C - 340, C - 1400, C + 80, C + 120]];
            for (let k = 0; k < 10; k++) {
                const want = places[k % places.length];
                mover.mem['6D'] = { '1': want };
                const res = await mover.recall(0x6D, '1');
                assert(res.ok, 'seed ' + seed + ' run ' + k + ': ' + res.why);
                st.pos.forEach((v, i) => assert(Math.abs(v - want[i]) <= 8, 'seed ' + seed + ' run ' + k + ' axis ' + i + ': ' + (v - want[i])));
                assert(st.run.every((x) => !x), 'run ' + k + ': a motor left running');
            }
        }
    }],
    ['2.6.5 a very uneven link (25-200 ms a request): no runaway, every motor stopped, each within 20 counts', async () => {
        for (const seed of [7, 11, 23, 99]) {
            const r = seatRig({ jitter: 175, busy: 4, seed }), { st, mover, C } = r;
            const places = [[C + 150, C - 200, C - 900, C + 20, C + 100], [C + 500, C + 100, C - 100, C - 90, C - 100], [C + 10, C - 340, C - 1400, C + 80, C + 120]];
            for (let k = 0; k < 6; k++) {
                const want = places[k % places.length];
                mover.mem['6D'] = { '1': want };
                await mover.recall(0x6D, '1');
                st.pos.forEach((v, i) => assert(Math.abs(v - want[i]) <= 20, 'seed ' + seed + ' run ' + k + ' axis ' + i + ': ' + (v - want[i])));
                assert(st.run.every((x) => !x), 'a motor left running');
            }
        }
    }],
    ['2.6.2 a module that takes two motors at once: the third turned away waits, the move still gets there; 2.6.1\'s Memory 3 is Easy entry', async () => {
        const r = seatRig({ maxMotors: 2 }), { st, mover, C } = r;
        const want = [C + 150, C - 200, C - 900, C + 20, C + 100];
        mover.mem['6D'] = { '1': want };
        const res = await mover.recall(0x6D, '1');
        assert(res.ok, res.why + ' | ' + r.logs.join(' | '));
        st.pos.forEach((v, i) => assert(Math.abs(v - want[i]) <= 8, 'axis ' + i + ': ' + (v - want[i])));
        assert(r.logs.some((x) => /turned away with 2 running: 2 at once from now/.test(x)), r.logs.join(' | '));
        const { SeatMover } = appModule('seatmove');
        fs.writeFileSync(path.join(r.dir, 'seatmem.json'), JSON.stringify({ '6D': { '1': want, '3': [1, 2, 3, 4, 5] } }));
        const m2 = new SeatMover({ motor: r.motor, modules: r.modules, values: r.values, log: quiet, dataDir: r.dir });
        assert.deepStrictEqual(m2.slots(0x6D).E, [1, 2, 3, 4, 5]);
        assert(!m2.slots(0x6D)['3'], 'no Memory 3 any more');
    }],
    ['2.6.1 a busy transport (every third request turned away) doesn\'t end a move; the modules don\'t log the move again', async () => {
        const r = seatRig({ busy: 3 }), { st, mover, C } = r;
        const target = [C + 150, C - 200, C - 900, C + 20, C + 100];
        mover.mem['6D'] = { '1': target };
        const res = await mover.recall(0x6D, '1');
        assert(res.ok, res.why + ' | ' + r.logs.join(' | '));
        st.pos.forEach((v, i) => assert(Math.abs(v - target[i]) <= 8, 'axis ' + i + ': ' + (v - target[i])));
        assert(st.refused > 5, 'requests were turned away: ' + st.refused);
        // the seat modules' reads go on: nothing logged about this move
        const before = r.logs.length;
        for (let k = 0; k < 6; k++) { r.modules.busy = false; r.modules.last = 0; r.modules.tick(); for (let j = 0; j < 20; j++) await new Promise((res2) => setImmediate(res2)); st.clock += 1500; }
        const extra = r.logs.slice(before).filter((x) => /seat 0x6D(:| motors)/.test(x));
        assert(!extra.length, 'logged again: ' + extra.join(' | '));
        // a hold starts at once from the modules' last read, no reads first
        r.modules.seats[0].at = st.clock; r.modules.seats[0].motor = [0, 0, 0, 0, 0, 3, 3, 3]; r.modules.seats[0].pos = st.pos.concat([C, C, C]);
        const n = st.sent.length;
        const h = mover.hold(0x6D, 4, 1);
        for (let k = 0; k < 3; k++) await new Promise((res2) => setImmediate(res2));
        assert(/^2E 6D 4 1/.test(st.sent[n]), 'the first request is the motor: ' + st.sent.slice(n, n + 3).join(', '));
        mover.release(); await h;
        assert(st.run.every((x) => !x));
    }],
);

checks.push(
    ['2.6.1 hold to move: the motor runs while held, a STOP the moment it is let go; never past the end stop; 10 s at most', async () => {
        // let go after ~1 s
        let r = seatRig({ during: (st) => { if (st.clock > 1e6 + 1000 && !st.let) { st.let = true; r.mover.release(); } } });
        let { st, mover, C } = r;
        const kh0 = st.pos[4];
        let res = await mover.hold(0x6D, 4, 1);
        assert(res.ok && res.why === 'Let go', res.why);
        assert(st.pos[4] > kh0 + 30 && st.pos[4] < kh0 + 120, 'the headrest went up a little: ' + (st.pos[4] - kh0));
        assert(st.run.every((x) => !x), 'stopped');
        const w = writes(st);
        assert(w[0] === '2E 6D 4 1 100' && w.slice(1).every((x) => x === '2E 6D 4 0 100'), w.join(' | '));
        assert(r.logs.some((x) => /seat 0x6D: KHV\+ held \d+\.\d s, \d+>\d+$/.test(x)), r.logs.join(' | '));
        // the height down at -355, its end stop -361: no further than MARGIN from it
        r = seatRig(); ({ st, mover, C } = r);
        res = await mover.hold(0x6D, 1, 2);
        assert(res.ok && /end of its travel/.test(res.why), res.why);
        assert(st.pos[1] >= C - 361 + 3 - 2, 'past the end stop: ' + (st.pos[1] - C));
        r = seatRig(); ({ st, mover, C } = r);
        st.pos[1] = C - 300;
        res = await mover.hold(0x6D, 1, 2);
        assert(res.ok && /end of its travel/.test(res.why) && st.pos[1] < C - 340, res.why + ' at ' + (st.pos[1] - C));
        assert(st.pos[1] >= C - 361 + 3 - 2, 'from further up, past the end stop: ' + (st.pos[1] - C));
        // never let go (a lost touch): 10 s, then stopped
        r = seatRig(); ({ st, mover, C } = r);
        st.pos[2] = C - 1300;
        res = await mover.hold(0x6D, 2, 1);
        assert(/Held 10 s/.test(res.why) && st.run.every((x) => !x), res.why);
        // the driver's own switch meanwhile: stopped
        r = seatRig({ during: (st2) => { if (st2.clock > 1e6 + 700) st2.run[0] = 2; } }); ({ st, mover } = r);
        res = await mover.hold(0x6D, 4, 2);
        assert(!res.ok && /moved by hand/.test(res.why) && st.run[4] === 0, res.why);
        // driving: not started
        r = seatRig(); r.values.live.speed = 20;
        res = await r.mover.hold(0x6D, 4, 1);
        assert(!res.ok && !writes(r.st).length, res.why);
    }],
    ['2.6.1 Seats tab: a seat drawn with an arrow pair by each part; a finger down holds, sliding off or up lets go', async () => {
        const r = seatRig(), { st, C } = r;
        const { Seats } = appModule('seats');
        const sent = [];
        const s = new Seats({ signals: { proxy: async () => { throw new Error('interface not found'); } }, log: quiet, now: () => st.clock, values: r.values, link: r.link,
            motor: async (a, m, act, pwm) => { sent.push([a, m, act]); return r.motor(a, m, act, pwm); } });
        s.modules.seats = r.modules.seats; s.modules.state = 'found';
        s.mover.sleep = async (ms) => { st.clock += ms; await new Promise((res) => setImmediate(res)); };
        const draw = () => { const cv = new Canvas(1600, 520), out = []; cv.own = true; const tx = cv.text; cv.text = function (x, ...a) { out.push(String(x)); return tx.call(this, x, ...a); }; s.draw(cv, themes.theme('m_tricolour')); return { cv, out }; };
        const { cv, out } = draw();
        ['Driver seat', 'Headrest', 'Backrest', 'Height', 'Tilt', 'Fore / aft', 'Save, then Easy entry: the seat moves there when its door opens'].forEach((x) => assert(out.includes(x), x + ' missing: ' + out.join(' | ')));
        assert.strictEqual(s.holds.length, 10, 'five pairs');
        assert(['SLV+', 'SLV-', 'KHV+', 'KHV-'].every((k) => cv.targets.some((x) => x.key === 'seat-109-' + k)), 'the controller can press them');
        const up = s.holds.find((h) => h.axis === 4 && h.dir === 1);
        assert(s.touch(1, up.x + 3, up.y - 2), 'a finger on the arrow takes the touch');
        for (let k = 0; k < 30; k++) await new Promise((res) => setImmediate(res));
        assert.strictEqual(st.run[4], 1, 'the headrest runs while held');
        assert(s.touch(2, up.x + 10, up.y));
        assert.strictEqual(st.run[4], 1, 'a small slide keeps it');
        s.touch(2, up.x + 120, up.y);
        for (let k = 0; k < 30 && st.run[4]; k++) await new Promise((res) => setImmediate(res));
        assert.strictEqual(st.run[4], 0, 'slid off: stopped');
        for (let k = 0; k < 60 && s.mover.run; k++) await new Promise((res) => setImmediate(res));
        assert(!s.mover.run, 'the hold ended');
        assert(!s.touch(1, 5, 5), 'a touch elsewhere is the kit\'s');
        // up on the arrow (no slide)
        const back = s.holds.find((h) => h.axis === 2 && h.dir === 2);
        s.touch(1, back.x, back.y);
        for (let k = 0; k < 30; k++) await new Promise((res) => setImmediate(res));
        assert.strictEqual(st.run[2], 2, 'the backrest reclines while held');
        s.touch(3, back.x, back.y);
        for (let k = 0; k < 30 && st.run[2]; k++) await new Promise((res) => setImmediate(res));
        assert.strictEqual(st.run[2], 0, 'let go: stopped');
        assert(sent.every((x) => x[0] === 0x6D && x[2] <= 2), JSON.stringify(sent));
    }],
);

checks.push(
    ['2.6.3 seat functions probe: BMW\'s seat interfaces listened to, each new value logged once (capped), nothing written', async () => {
        const { probe, SEAT_FUNCTION, PROXY } = appModule('seatprobe');
        const calls = [], subs = {};
        const signals = {
            watch: async (iface, inst, handlers) => { calls.push('watch ' + iface.split('.').pop() + ' ' + inst); subs[iface] = handlers; return { available: iface === SEAT_FUNCTION, error: null }; },
            call: () => { throw new Error('nothing may be called'); }, setValue: () => { throw new Error('nothing may be written'); },
        };
        const logs = [], log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
        const p = probe(signals, log);
        for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual(calls, ['watch SeatFunction 1', 'watch SeatCommandProxyCtrl Inst1']);
        assert(Object.keys(subs[SEAT_FUNCTION]).indexOf('statusSeatAdjustmentDR') >= 0 && subs[PROXY].seatProxySeatOperationStatus);
        const dr = subs[SEAT_FUNCTION].statusSeatAdjustmentDR;
        dr({ operationMemoryButtonDR: 'TASTE_1_GEDRUECKT' }); dr({ operationMemoryButtonDR: 'TASTE_1_GEDRUECKT' }); dr({ operationMemoryButtonDR: 'KEINE_AKTION' });
        assert.strictEqual(logs.filter((x) => /statusSeatAdjustmentDR/.test(x)).length, 2, 'a value again is not logged again: ' + logs.join(' | '));
        assert(logs.some((x) => /seat functions: SeatFunction set up, offered by the car: true/.test(x)) && logs.some((x) => /seat proxy set up, offered by the car: false/.test(x)), logs.join(' | '));
        assert.strictEqual(p.summary(), 'SeatFunction available, 2 values; seat proxy not offered');
        for (let k = 0; k < 200; k++) subs[SEAT_FUNCTION].statusSeatAdjustment({ n: k });
        assert(logs.filter((x) => /^seat functions: status/.test(x)).length <= 80, 'capped');
    }],
);

checks.push(
    ['2.6.4 frame rates: each tab drawn only as often as it needs (gauges at the setting, Seats 10, M View 5, Ambient on change)', async () => {
        const b = await boot(tmp('rates'));
        assert.strictEqual(b.rates[b.rates.length - 1], 30, 'Driving: 30 by default: ' + b.rates);
        await b.tab(1); assert.strictEqual(b.rates[b.rates.length - 1], 30, 'Performance');
        await b.tab(2); assert.strictEqual(b.rates[b.rates.length - 1], 10, 'Seats');
        await b.tab(3); assert.strictEqual(b.rates[b.rates.length - 1], 5, 'M View');
        await b.tab(5); assert.strictEqual(b.rates[b.rates.length - 1], 0, 'Ambient: as fast as the renderer, while it changes');
        await b.tab(0); b.settings.set('frameRate', '60'); assert.strictEqual(b.rates[b.rates.length - 1], 60, 'the setting');
        b.settings.set('frameRate', '15'); assert.strictEqual(b.rates[b.rates.length - 1], 15);
    }],
    ['2.6.4 the kit\'s loop: fps(n) caps it with the GPU renderer too (a still page was drawn 60 times a second)', async () => {
        // kit/runtime/mgu.js's loop, run on a stand-in for its display and ui: the renderer ticks at 60 fps, every frame unchanged
        const src = fs.readFileSync(path.join(KIT, 'mgu.js'), 'utf8');
        const body = src.slice(src.indexOf('        loop(stateName, fps, fn) {'), src.indexOf('\n        },\n    };\n', src.indexOf('        loop(stateName, fps, fn) {')) + 10);
        const tickers = [], display = { active: () => true, gpu: { waiting: false }, onTick: (fn) => tickers.push(fn) };
        const ui = { onVisible() {}, isVisible: () => true, timing: { png: 0, push: 0 } };
        // eslint-disable-next-line no-new-func
        const make = new Function('display', 'ui', 'log', 'return {' + body.trim().replace(/,\s*$/, '') + '}');
        const run = async (fps) => {
            let n = 0;
            const lp = make(display, ui, quiet).loop('MAIN', 10, async () => { n++; });
            if (fps) lp.fps(fps);
            const iv = setInterval(() => tickers.forEach((t) => t()), 16);
            await new Promise((r) => setTimeout(r, 1000));
            clearInterval(iv); lp.stop(); tickers.length = 0;
            return n;
        };
        const free = await run(0), capped = await run(10);
        assert(free > 40, 'without a cap: the renderer\'s pace (' + free + ' in 1 s)');
        assert(capped >= 8 && capped <= 12, 'capped at 10: ' + capped + ' in 1 s');
    }],
);

checks.push(
    ['2.6.6 a module that runs one motor at a time (the next start stops the last): found out, then each motor straight to its target, kept', async () => {
        const r = seatRig({ single: true }), { st, mover, C } = r;
        const want = [C + 150, C - 200, C - 900, C + 20, C + 100];
        mover.mem['6D'] = { E: want };
        const res = await mover.recall(0x6D, 'E', 'Easy entry');
        assert(res.ok, res.why + ' | ' + r.logs.join(' | '));
        st.pos.forEach((v, i) => assert(Math.abs(v - want[i]) <= 8, 'axis ' + i + ': ' + (v - want[i])));
        assert(r.logs.some((x) => /stopped when another started: one motor at a time from now on/.test(x)), r.logs.join(' | '));
        assert.strictEqual(mover.slots(0x6D).atOnce, 1, 'kept for the next start of the app');
        // the next run: one motor at a time from the start, each started once (no stop-and-go)
        const again = [C + 345, C - 355, C - 380, C + 93, C - 9];
        mover.mem['6D'].E = again;
        const n = writes(st).length;
        const res2 = await mover.recall(0x6D, 'E', 'Easy entry');
        assert(res2.ok, res2.why);
        st.pos.forEach((v, i) => assert(Math.abs(v - again[i]) <= 8, 'again axis ' + i + ': ' + (v - again[i])));
        const starts = writes(st).slice(n).filter((x) => / [12] 100$/.test(x));
        const per = {}; starts.forEach((x) => { const k = x.split(' ')[2]; per[k] = (per[k] || 0) + 1; });
        assert(Object.keys(per).every((k) => per[k] <= 2), 'each motor started once or twice (a correction): ' + JSON.stringify(per));
        assert(r.logs.some((x) => /Easy entry reached in .* \(SLV \d+>\d+ 1x/.test(x)), r.logs.slice(-2).join(' | '));
    }],
    ['2.6.6 Clear: a seat\'s saved positions gone (pressed twice), the one-motor limit kept; nothing to clear: not pressable', async () => {
        const r = seatRig(), { st, C } = r;
        const { Seats } = appModule('seats');
        const s = new Seats({ signals: { proxy: async () => { throw new Error('interface not found'); } }, log: quiet, now: () => st.clock, values: r.values, link: r.link, motor: r.motor, settings: settingsOf(), dataDir: r.dir });
        s.modules.seats = r.modules.seats; s.modules.state = 'found';
        s.mover.mem['6D'] = { '1': [C, C, C, C, C], E: [C, C, C, C, C], R: [C, C, C, C, C], entered: true, atOnce: 1 };
        const draw = () => { const cv = new Canvas(1600, 520), out = []; cv.own = true; const tx = cv.text; cv.text = function (x, ...a) { out.push(String(x)); return tx.call(this, x, ...a); }; s.draw(cv, themes.theme('m_tricolour')); return { cv, out }; };
        let { cv, out } = draw();
        assert(out.includes('CLEAR'), out.join(' | '));
        const press = (c, key) => { const b = c.targets.find((x) => x.key === key); assert(b, key + ' not pressable'); return b.run(); };
        press(cv, 'seat-109-clear');
        assert(s.mover.slots(0x6D)['1'], 'the first press only asks');
        ({ cv, out } = draw());
        assert(out.includes('CONFIRM'), 'it asks: ' + out.join(' | '));
        press(cv, 'seat-109-clear');
        assert.deepStrictEqual(s.mover.slots(0x6D), { atOnce: 1 }, 'gone, the limit kept');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'seatmem.json'), 'utf8'))['6D'], { atOnce: 1 }, 'in the file too');
        ({ cv, out } = draw());
        assert(!cv.targets.some((x) => x.key === 'seat-109-clear'), 'nothing left to clear: not pressable');
    }],
);

checks.push(
    ['2.6.6 a seat move holds the ambient light\'s writes (its door blink crowded the seat out) until it ends; waits for its write under way', async () => {
        const firstWrite = async (light) => {
            const r = seatRig(), { st, mover, C } = r, calls = [];
            const t0 = st.clock;
            let at = null;
            const motor = mover.motor;
            mover.motor = (...a) => { if (at === null) at = st.clock - t0; return motor(...a); };
            mover.quietOthers = (on) => { calls.push(on); return on ? light() : null; };
            mover.mem['6D'] = { E: [C + 150, C - 200, C - 380, C + 93, C - 9] };
            const res = await mover.recall(0x6D, 'E', 'Easy entry');
            return { res, at, calls };
        };
        // the light quiet at once: the motors start straight away; held first, let go last
        const quick = await firstWrite(() => Promise.resolve());
        assert(quick.res.ok, quick.res.why);
        assert(quick.at < 500, 'first motor after ' + quick.at + ' ms (the seat read first, no wait for the light)');
        assert.deepStrictEqual([quick.calls[0], quick.calls[quick.calls.length - 1]], [true, false], 'held, then let go: ' + quick.calls);
        // a write of the light's that never ends: the motors wait for it 3 s, then go anyway
        const stuck = await firstWrite(() => new Promise(() => {}));
        assert(stuck.res.ok, 'not stuck on the light: ' + stuck.res.why);
        assert(stuck.at >= 3000, 'no motor while the light\'s write is under way: ' + stuck.at + ' ms');
    }],
);

checks.push(
    ['2.6.7 seat modules the link marked silent (no answer 5 times: the car asleep) are woken by the search; Read again searches anew', async () => {
        const { SeatModules } = appModule('seatmod');
        const be = (n) => [n >> 8, n & 255];
        let awake = false, sent = 0;
        // as kit/runtime/readonly-diag.js: 5 without an answer in a row, then skipped (null, nothing sent) until wake()
        const misses = {};
        const link = { available: true,
            silent: (a) => (misses[a] || 0) >= 5, wake: (a) => { delete misses[a]; },
            async discover() { return new Map([[0x6D, '0F21F0'], [0x6E, '0F21F0']]); },
            async read(a, did) {
                if (link.silent(a)) return null;
                sent++;
                if (!awake) { misses[a] = (misses[a] || 0) + 1; return null; }
                misses[a] = 0;
                if (did === 0xD702) return [0x62, 0xD7, 0x02].concat(be(33113), be(32410), be(32390), be(32861), be(32758), be(32768), be(32768), be(32768));
                return [0x7F, 0x22, 0x31];
            } };
        let clock = 1e6;
        const m = new SeatModules({ link, log: quiet, now: () => clock, values: { live: {} } });
        const settle = async () => { for (let k = 0; k < 50 && m.busy; k++) await new Promise((r) => setTimeout(r, 1)); };
        m.tick(); await settle();
        assert.strictEqual(m.state, 'none', 'asleep: none found');
        // (the polls and a seat run before took it to 5 misses: the link skips it now)
        misses[0x6D] = misses[0x6E] = 5;
        assert(link.silent(0x6D) && link.silent(0x6E), 'the link has marked them silent');
        // the car wakes; the next search (a minute later) wakes the units it asks
        awake = true; clock += 61000;
        m.tick(); await settle();
        assert.strictEqual(m.state, 'found', 'found again: ' + m.state + ' ' + m.why);
        assert.deepStrictEqual(m.seats.map((x) => x.addr), [0x6D, 0x6E]);
        // Read again: a search at once
        m.again(); assert.strictEqual(m.state, 'idle');
        m.tick(); await settle();
        assert.strictEqual(m.state, 'found');
    }],
);

checks.push(
    ['2.6.7 easy entry: the door closed again takes the seat back (1.5 s later, still closed); opened again meanwhile: not; mid-move: stopped, then back', async () => {
        const r = seatRig(), { st, mover, C } = r;
        const drive = st.pos.slice();
        mover.mem['6D'] = { E: [C + 30, null, C - 900, null, null] };
        const { Seats } = appModule('seats');
        const s = new Seats({ signals: { proxy: async () => { throw new Error('interface not found'); } }, log: quiet, now: () => st.clock, values: r.values, link: r.link, motor: r.motor, settings: settingsOf() });
        s.modules.seats = r.modules.seats; s.modules.state = 'found'; s.mover.mem = mover.mem; s.mover.sleep = mover.sleep;
        const settle = async () => { for (let k = 0; k < 400 && (s.mover.run || k < 3); k++) await new Promise((res) => setImmediate(res)); await s.entryQueue; };
        const wait = (ms) => new Promise((res) => setTimeout(res, ms));
        s.doors([]);                                            // (the first report)
        s.doors(['driver front']); await settle();
        assert(Math.abs(st.pos[2] - (C - 900)) <= 8 && s.mover.entered(0x6D), 'at the entry position');
        // closed, opened again within 1.5 s (still getting in): nothing moves
        const n = writes(st).length;
        s.doors([]); await wait(300); s.doors(['driver front']); await wait(1600); await settle();
        assert.strictEqual(writes(st).length, n, 'opened again before 1.5 s: not moved');
        // closed for good: back to the driving position
        s.doors([]); await wait(1700); await settle();
        st.pos.forEach((v, i) => assert(Math.abs(v - drive[i]) <= 8, 'back: axis ' + i + ' ' + (v - drive[i])));
        assert(!s.mover.entered(0x6D));
        // closed while the entry move still goes: it stops, then back
        st.pos[2] = drive[2];
        const fast = s.mover.sleep;
        s.mover.sleep = async (ms) => { await wait(4); return fast(ms); };     // (a move that takes real time, to close the door in)
        s.doors(['driver front']);
        await wait(60);
        assert(s.mover.run && s.mover.run.slot === 'E', 'easy entry under way');
        s.doors([]); await wait(1800);
        s.mover.sleep = fast;
        for (let k = 0; k < 100 && (s.mover.run || s.mover.entered(0x6D)); k++) { await settle(); await wait(20); }
        st.pos.forEach((v, i) => assert(Math.abs(v - drive[i]) <= 8, 'back after a stopped entry: axis ' + i + ' ' + (v - drive[i])));
        assert(st.run.every((x) => !x), 'every motor stopped');
    }],
);

checks.push(
    ['2.6.7 a seat that goes on after its STOP (load, the link\'s delay): the coast learned, from the second move each motor started once', async () => {
        const r = seatRig({ single: true, coast: 15 }), { st, mover, C } = r;
        const a = [C + 345, C - 355, C - 380, C + 93, C - 9], b = [C + 256, C - 165, C - 380, C - 24, C - 9];
        const starts = [];
        for (let k = 0; k < 5; k++) {
            const want = k % 2 ? a : b;
            mover.mem['6D'] = Object.assign(mover.mem['6D'] || {}, { E: want });
            const n = writes(st).length;
            const res = await mover.recall(0x6D, 'E', 'Easy entry');
            assert(res.ok, 'move ' + k + ': ' + res.why);
            st.pos.forEach((v, i) => assert(Math.abs(v - want[i]) <= 8, 'move ' + k + ' axis ' + i + ': ' + (v - want[i])));
            const per = {};
            writes(st).slice(n).filter((x) => / [12] 100$/.test(x)).forEach((x) => { const i = x.split(' ')[2]; per[i] = (per[i] || 0) + 1; });
            starts.push(per);
        }
        const most = (per) => Math.max.apply(null, Object.keys(per).map((k) => per[k]));
        // (without the coast every motor needs a correction: twice each)
        starts.slice(1).forEach((per, k) => assert(most(per) === 1, 'move ' + (k + 1) + ': ' + JSON.stringify(per) + ' (all: ' + JSON.stringify(starts) + ')'));
        assert(mover.slots(0x6D).coast.some((c) => c >= 8), 'a coast learned: ' + mover.slots(0x6D).coast);
    }],
);

checks.push(
    ['2.6.8 the log: written in RAM (no eMMC write a line), copied to the eMMC on demand, copied back after a restart; no RAM: the eMMC', async () => {
        const src = fs.readFileSync(path.join(KIT, 'mgu.js'), 'utf8');
        const a = src.indexOf('const LOG_DISK = '), b = src.indexOf('// The SDK can swallow');
        assert(a > 0 && b > a, 'the logging part of mgu.js');
        const part = src.slice(a, b);
        const load = (ram, data) => {
            const env = Object.assign({}, process.env, { MGU_LOG_RAM: ram });
            // eslint-disable-next-line no-new-func
            return new Function('fs', 'path', 'SPEC', 'DATA_DIR', 'process', 'setInterval', part + '\nreturn { LOG_FILE, LOG_DISK, fileLog, copyLog };')(
                fs, path, { id: 'cockpit_combo' }, data, { env, getuid: process.getuid }, () => ({ unref() {} }));
        };
        const ram = tmp('ram'), data = tmp('data');
        const L = load(ram, data);
        assert(L.LOG_FILE.indexOf(ram) === 0, 'the log in RAM: ' + L.LOG_FILE);
        for (let k = 0; k < 50; k++) L.fileLog('INFO', 'line ' + k);
        assert(/line 49/.test(fs.readFileSync(L.LOG_FILE, 'utf8')), 'written');
        assert(!fs.existsSync(L.LOG_DISK), 'nothing on the eMMC yet');
        L.copyLog();
        assert.strictEqual(fs.readFileSync(L.LOG_DISK, 'utf8'), fs.readFileSync(L.LOG_FILE, 'utf8'), 'the copy on the eMMC, whole');
        assert(!fs.existsSync(L.LOG_DISK + '.tmp'), 'no temp file left');
        // the head unit started again: RAM empty, the copy from the eMMC first, then on
        const ram2 = tmp('ram2');
        const L2 = load(ram2, data);
        L2.fileLog('INFO', 'after the restart');
        const t = fs.readFileSync(L2.LOG_FILE, 'utf8');
        assert(/line 49/.test(t) && /after the restart$/m.test(t), 'the old log kept, the new line after it');
        // no RAM to write in: the eMMC as before
        const L3 = load('/nonexistent-dir/x', data);
        assert.strictEqual(L3.LOG_FILE, L3.LOG_DISK, 'falls back to the eMMC');
    }],
);
