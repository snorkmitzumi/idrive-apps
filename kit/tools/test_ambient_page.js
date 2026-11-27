'use strict';
// Ambient config's service and tabs as a host gets them (shared/ambient_config/ambient_page.js: Ambient config and Combo),
// and owner.js (one of our ambient apps at a time on the lights). No car: the diagnostic link and the signals stubbed.
//   node kit/tools/test_ambient_page.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'shared', 'ambient_config');
const OWNERS = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ambient-owner-'));
process.env.MGU_AMBIENT_OWNER_DIR = OWNERS;
process.env.MGU_AMBIENT_FLASH = path.join(OWNERS, 'flash.json');
process.env.MGU_AMBIENT_COMFORT = path.join(OWNERS, 'no-comfort.sock');

// the body controller never answers (lights: none found); every request counted
let asked = 0;
class FakeDiag { constructor() { this.quiet = false; } async init() { return this; } async physical() { asked++; return null; } }
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/diag') return { Diag: FakeDiag };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { Recorder: Canvas } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const { background, mount, TABS } = require(path.join(APP, 'ambient_page'));
const { Owner, alive } = require(path.join(APP, 'owner'));

const quiet = { info() {}, warn() {}, error() {} };
const SPEC = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
function settingsOf(over) {
    const S = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    Object.assign(S, over || {});
    const fns = [];
    return { S, get: (k) => S[k], set: (k, v) => { S[k] = v; fns.forEach((f) => f(k, v)); }, onChange: (f) => fns.push(f) };
}
const signals = { watch: async () => ({ available: false }) };
const bgOf = (id, over) => ({ log: quiet, settings: settingsOf(over), signals, spec: { id }, dataDir: null });
const texts = (page, t) => { const out = [], cv = new Canvas(1600, 520); cv.own = true; const tx = cv.text; cv.text = function (s, ...r) { out.push(String(s)); return tx.call(this, s, ...r); }; page.draw(cv, t); return out; };

const checks = [
    ['owner: the app started first has the lights, the other leaves them until it has gone', async () => {
        const dir = fs.mkdtempSync(path.join(OWNERS, 'o-'));
        const a = new Owner({ log: quiet, app: 'ambient_config', since: 1000, dir }).start();
        // a second app, started later, in another process (here: this test's parent, alive)
        const b = new Owner({ log: quiet, app: 'combo', since: 2000, dir, pid: process.ppid }).start();
        assert.strictEqual(a.peer, null, 'the first keeps the lights');
        assert.strictEqual(b.peer, 'ambient_config', 'the second leaves them');
        // the first one's process gone: the second takes them
        fs.writeFileSync(path.join(dir, 'mgu-ambient-owner.ambient_config.json'), JSON.stringify({ pid: 999999, since: 1000 }));
        b.check();
        assert.strictEqual(b.peer, null, 'a dead owner does not count');
        a.stop(); b.stop();
        assert(alive(process.pid) && !alive(999999) && !alive(0));
    }],
    ['page: Combo\'s service has no strobe, its tabs draw, a peer holds the lights', async () => {
        const parts = await background(bgOf('combo'), { strobe: false });
        assert.strictEqual(parts.strobe, null, 'no strobe');
        assert.deepStrictEqual(parts.checks(), []);
        const settings = settingsOf({ strobe: true });       // (the setting on: still no Strobe tab without one)
        let redraws = 0;
        const page = mount({ settings, log: quiet }, parts, { strobe: false, names: ['Ambient', 'Animations', 'Modes', 'Favourites'], redraw: () => { redraws++; } });
        assert.deepStrictEqual(page.tabs(), ['Ambient', 'Animations', 'Modes', 'Favourites']);
        const t = themes.theme('m_tricolour');
        for (let i = 0; i < 4; i++) {
            page.select(i);
            assert.strictEqual(page.page, i);
            const tx = texts(page, t);
            assert(tx.length > 3 && !tx.some((x) => /undefined|NaN/.test(x)), 'tab ' + i + ': ' + tx.join(' | '));
        }
        assert(page.wants() === false || page.wants() === true);
        // a finger on the colour ring (Colour tab): the colour follows it, the gesture is the page's; off the ring: not
        page.select(0);
        assert.strictEqual(page.touch(1, 290 + 160, 288), true, 'a finger down on the ring taken');
        assert.strictEqual(page.touch(3, 290, 288 + 160), true, 'its lift taken');
        const hue = (rgb) => require(path.join(APP, 'scenes')).hueOf(rgb);
        assert(Math.abs(hue(parts.control.look().upper.rgb) - 180) < 20, 'the colour where the finger let go: ' + JSON.stringify(parts.control.look().upper));
        assert.strictEqual(page.touch(1, 20, 20), false, 'a finger off the ring and dial: the kit has it');
        page.original();
        assert.strictEqual(parts.control.on(), false, 'Original colour: the car\'s own');
        assert(parts.owner && parts.owner.peer === null, 'the only one of ours: it has the lights');
        assert(!parts.lights.held, 'not held');
        // another of ours started earlier and alive: the writes are held, and the tabs say so
        fs.writeFileSync(path.join(OWNERS, 'mgu-ambient-owner.ambient_config.json'), JSON.stringify({ pid: process.ppid, since: 1 }));
        parts.owner.check();
        await new Promise((r) => setTimeout(r, 20));
        assert.strictEqual(parts.owner.peer, 'ambient_config');
        assert(parts.lights.held, 'the lights left alone');
        page.select(1);
        assert(texts(page, t).some((x) => /The Ambient config app/.test(x)), 'the Animations tab says who has the lights');
        fs.unlinkSync(path.join(OWNERS, 'mgu-ambient-owner.ambient_config.json'));
        parts.owner.check();
        assert(!parts.lights.held, 'taken again once it has gone');
    }],
    ['page: Ambient config keeps its Strobe tab (with the setting on)', async () => {
        const bg = bgOf('ambient_config', { strobe: true });
        const parts = await background(bg);
        assert(parts.strobe, 'strobe made');
        const page = mount({ settings: bg.settings, log: quiet }, parts, { strobe: true, redraw: () => {} });
        assert.deepStrictEqual(page.tabs(), TABS.concat(['Strobe']));
        page.select(4);
        // (panel titles go to a cached layer: the tab's own lines)
        assert(texts(page, themes.theme('m_tricolour')).includes('Only for use on private property.'));
        page.leave();
    }],
];

// a check waiting on something that never comes: Node would end with code 0 and no summary (see test_combo.js)
let running = 'before the first check';
process.on('beforeExit', () => {
    if (running === null) return;
    console.log('FAIL the checks stopped in "' + running + '": it waits on something that never comes');
    process.exit(1);
});
(async () => {
    let failed = 0;
    for (const [name, fn] of checks) {
        running = name;
        try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.stack || e)); }
    }
    running = null;
    console.log('ambient page: ' + checks.length + ' checks, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})();
