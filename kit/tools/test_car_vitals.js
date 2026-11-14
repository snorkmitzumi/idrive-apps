'use strict';

// M Vitals' misfire counter Reset against stubbed kit modules (mgu, the diagnostic link) in demo mode: the button on
// the Fuel & ignition page (where the kit runs the screen), its confirm step, the counts from then on, kept across a
// restart, and given up when the engine unit starts a new driving cycle. Nothing is sent to the car.
// Also the pressure units: every page in bar, psi and kPa (the unit shown, the numbers converted, no NaN).
//   node kit/tools/test_car_vitals.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'car_vitals', 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'car_vitals', 'app.json'), 'utf8'));
const { Recorder: Canvas } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));

global.setInterval = () => 0;
let app = null;
// diag: the app's link (the last one made); hold: a promise every read waits for (a slow engine unit), when set
let diag = null, hold = null;
class FakeDiag extends EventEmitter { constructor() { super(); this.available = false; diag = this; } init() {} }
class FakeReader { constructor() { this.raws = {}; this.pick = {}; } static label(c) { return c.did; } key(c) { return c.did; } async value() { if (hold) await hold; return null; } }
const stubs = {
    './kit/mgu': { run(a) { app = a; } },
    './kit/diag': { Diag: FakeDiag, hex: require(path.join(KIT, 'diag')).hex },
    './kit/dids': { DidReader: FakeReader },
};
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

/** One start of M Vitals in demo mode; draw() renders a frame, as the kit running the screen does (own). */
async function boot(dir, over, vis) {
    delete require.cache[MAIN];
    require(MAIN);
    const S = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    S.demo = 'on';
    Object.assign(S, over || {});
    const texts = [];
    let frame = null, last = null;
    // vis (optional): { shown, handlers } - the screen hidden / shown as the kit's ui.onVisible reports it
    vis = vis || { shown: true, handlers: [] };
    const ctx = {
        ui: { onClick() {}, text() {}, image: async () => {}, isVisible: (n) => n === 'MAIN' && vis.shown, onVisible: (fn) => vis.handlers.push(fn) },
        settings: { get: (k) => S[k], onChange() {} },
        log: { info() {}, warn() {}, error() {} }, spec: SPEC, dataDir: dir,
        signals: { watch: () => Promise.resolve({}) },
        onTab(fn) { this.tab = fn; }, hideButton() {}, onScroll() {}, onTap() {}, loop(n, fps, fn) { frame = fn; },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => {
            const cv = new Canvas(w, h), text = cv.text.bind(cv);
            cv.own = true;
            cv.text = (str, ...rest) => { texts.push(String(str)); return text(str, ...rest); };
            last = cv;
            return cv;
        },
    };
    await app.start(ctx);
    return {
        page: async (i) => { texts.length = 0; await ctx.tab(i); return texts.slice(); },
        draw: async () => { texts.length = 0; await frame(); return texts.slice(); },
        press: async (key) => { const tg = last.targets.find((x) => x.key === key); assert(tg, 'a ' + key + ' target on the page'); await tg.run(); },
        targets: () => last.targets.map((x) => x.key),
    };
}

(async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vitals-'));
    try {
        const fuel = ['engine', 'thermal', 'fuel', 'chassis'].indexOf('fuel');
        let b = await boot(dir);
        let t = await b.page(fuel);
        assert(t.includes('this drive') && b.targets().includes('misfire'), 'the Misfires tile with Reset: ' + t.join(' | '));
        // the first press asks (Confirm), the second resets: the counts from now on, kept in misfire.json
        await b.press('misfire');
        assert((await b.draw()).includes('CONFIRM'), 'Reset asks to confirm first');
        assert(!fs.existsSync(path.join(dir, 'misfire.json')), 'nothing reset on the first press');
        await b.press('misfire');
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'misfire.json'), 'utf8'));
        assert(Array.isArray(saved.counts) && saved.counts.length === 6 && saved.t > 0, JSON.stringify(saved));
        t = await b.draw();
        assert(t.some((x) => /^since reset \d\d:\d\d$/.test(x)) && t.includes('0'), 'the counts since the reset: ' + t.join(' | '));
        // kept across a restart of the app
        b = await boot(dir);
        t = await b.page(fuel);
        assert(t.some((x) => /^since reset/.test(x)), 'still since the reset after a restart');
        // a count lower than its base: the engine unit started a new driving cycle - the reset is done with
        fs.writeFileSync(path.join(dir, 'misfire.json'), JSON.stringify({ counts: [5, 5, 5, 5, 5, 5], t: Date.now() }));
        b = await boot(dir);
        t = await b.page(fuel);
        assert(t.includes('this drive') && !fs.existsSync(path.join(dir, 'misfire.json')), 'a new driving cycle: this drive again');
        // hidden: the engine unit's round every 60 s only; shown again right after a hidden round (inside the render
        // loop's 600 ms debounce): a round at once, the 60 s timer replaced
        const timers = [], realSet = global.setTimeout, realClear = global.clearTimeout;
        global.setTimeout = (fn, ms) => { const tm = { fn, ms }; timers.push(tm); return tm; };
        global.clearTimeout = (tm) => { const i = timers.indexOf(tm); if (i >= 0) timers.splice(i, 1); };
        const polls = () => timers.filter((x) => x.fn.name === 'pollFuel');
        try {
            const vis = { shown: false, handlers: [] };
            await boot(dir, null, vis);
            // the first round: in 1 s, or at once when the first frame (the Engine page) kicked it
            assert.strictEqual(polls().length, 1, 'one round scheduled');
            const first = polls()[0];
            timers.splice(timers.indexOf(first), 1);
            await first.fn();
            assert.deepStrictEqual(polls().map((x) => x.ms), [60000], 'hidden: the next round in 60 s');
            vis.shown = true;
            vis.handlers.forEach((fn) => fn('MAIN', true));
            assert.deepStrictEqual(polls().map((x) => x.ms), [0], 'shown again within 600 ms of a round: a round now, the 60 s timer gone');
            const now = polls()[0];
            timers.splice(timers.indexOf(now), 1);
            await now.fn();
            // shown: the shown rate again (400 ms on the Engine page with boost from the engine unit, else 5 s)
            assert(polls().length === 1 && polls()[0].ms <= 5000, 'shown: back to the shown rate: ' + polls().map((x) => x.ms));
            // a fast round (the Engine page, boost from the engine unit) during which the app is hidden: the next one
            // in 60 s, not 400 ms (that would be a full background round just as the other app opens)
            const vis2 = { shown: true, handlers: [] };
            await boot(dir, null, vis2);
            diag.available = true;
            const fastRound = polls().pop();
            timers.length = 0;
            let release;
            hold = new Promise((r) => { release = r; });
            const running = fastRound.fn();
            vis2.shown = false;                    // another app opened while the engine unit answers
            release(); await running; hold = null;
            assert.deepStrictEqual(polls().map((x) => x.ms), [60000], 'hidden during a fast round: the next one in 60 s');
        } finally {
            global.setTimeout = realSet; global.clearTimeout = realClear;
        }
        console.log('M Vitals misfire reset checks passed (confirm, since reset, kept across a restart, a new driving cycle); hidden / shown read rate.');

        // pressure units: the boost dial, the fuel pressures and the tyres in the unit chosen, its numbers converted
        const pages = { engine: 0, fuel, chassis: 3 };
        const shown = {};
        for (const unit of ['bar', 'psi', 'kpa']) {
            fs.rmSync(path.join(dir, 'misfire.json'), { force: true });
            b = await boot(dir, { pressUnit: unit, showBoost: 'on', showHpfp: 'on', showLpfp: 'on', showBoostCtl: 'on', showTyres: 'on' });
            const label = { bar: 'bar', psi: 'psi', kpa: 'kPa' }[unit];
            shown[unit] = {};
            for (const [name, i] of Object.entries(pages)) {
                await b.page(i);
                t = await b.draw();
                assert(!t.some((x) => /NaN|undefined/.test(x)), unit + ' ' + name + ': no NaN / undefined: ' + t.join(' | '));
                assert(t.some((x) => x.trim() === label || x.trim().endsWith(' ' + label)), unit + ' ' + name + ': the unit ' + label + ' shown: ' + t.join(' | '));
                const other = ['bar', 'psi', 'kPa'].filter((u) => u !== label);
                assert(!t.some((x) => other.indexOf(x.trim()) >= 0), unit + ' ' + name + ': no other pressure unit: ' + t.join(' | '));
                shown[unit][name] = t;
            }
        }
        // the boost scale: 0-2.5 bar, 0-36 psi, 0-250 kPa by default (Boost gauge max 2.5)
        assert(shown.kpa.engine.includes('250') && shown.kpa.engine.includes('200'), 'the kPa boost scale ends at 250: ' + shown.kpa.engine.join(' | '));
        assert(shown.bar.engine.includes('2.5'), 'the bar boost scale ends at 2.5: ' + shown.bar.engine.join(' | '));
        console.log('M Vitals pressure unit checks passed (bar, psi, kPa on the Engine, Fuel & ignition and Chassis pages).');

        // issue #154: the power and torque bars show the peak as a number too, beside the marker, only where it fits
        {
            const G = require(path.join(KIT, 'gauges')), th = themes.theme('m_tricolour');
            const drawn = (w, g) => { const cv = new Canvas(1920, 720), out = [], text = cv.text.bind(cv); cv.text = (str, ...r) => { out.push(String(str)); return text(str, ...r); }; G.bar(cv, th, 0, 0, w, 92, g); return out; };
            assert(drawn(466, { label: 'Power', value: 120, unit: 'kW', max: 300, peak: 312.4, peakText: true }).includes('PEAK 312'), 'the peak as a number');
            assert(!drawn(466, { label: 'Power (torque x rpm)', value: 120, unit: 'kW', max: 300, peak: 312, peakText: true }).some((x) => /PEAK/.test(x)), 'left out where the label leaves no room');
            assert(!drawn(1014, { label: 'Power', value: 120, unit: 'kW', max: 300, peak: 312 }).some((x) => /PEAK/.test(x)), 'not without peakText (other apps\' bars as before)');
            assert(!drawn(1014, { label: 'Power', value: 120, unit: 'kW', max: 300, peak: null, peakText: true }).some((x) => /PEAK/.test(x)), 'no peak (markers off): no number');
            await b.page(0);
            const eng = await b.draw();
            assert(eng.some((x) => /^PEAK \d/.test(x)), 'the Engine page shows the power / torque peaks as numbers: ' + eng.filter((x) => /PEAK/.test(x)).join(' | '));
            console.log('M Vitals peak numbers checked (issue #154).');
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
