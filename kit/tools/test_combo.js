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
];

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
