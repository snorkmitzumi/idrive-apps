'use strict';
// Ambient config 2.6.0: a look per driving-mode variant (Sport+, Comfort+, Eco Pro Individual ...), the group's look
// for a variant without one, only the variants this car has sent on the Driving modes tab (learned, kept), the Sport
// pulse for every Sport variant, and the tab's two columns of compact rows.
//   node kit/tools/test_ambient_modes.js
const path = require('path');
const EventEmitter = require('events');
const APP = path.join(__dirname, '..', '..', 'apps', 'ambient_config');
const { Ambient, modeOf, groupOf, MAX_SHOWN } = require(path.join(APP, 'ambient'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const log = { info() {}, warn() {}, error() {} };
const store = (init) => {
    const values = Object.assign({}, init), fns = [];
    return { values, get: (k) => values[k], set: (k, v) => { values[k] = v; fns.forEach((f) => f(k, v)); }, onChange: (f) => fns.push(f) };
};
const tick = () => new Promise((res) => setImmediate(res));

(async () => {
    // the variants the car sends, each with its group
    const v = (x) => { const r = modeOf(x); return r && r.variant + '/' + r.mode; };
    ok(v(1) === 'sport/sport' && v('SPORT_EXPERT') === 'sportPlus/sport' && v(3) === 'sportInd/sport', 'Sport, Sport+, Sport Individual');
    ok(v('COMFORT') === 'comfort/comfort' && v(5) === 'comfortPlus/comfort' && v('COMFORT_INDIVIDUAL') === 'comfortInd/comfort', 'Comfort, Comfort+, Comfort Individual');
    ok(v('ECO_PRO_EFFICIENT') === 'eco/eco' && v(8) === 'ecoPlus/eco' && v('ECO_PRO_INDIVIDUAL') === 'ecoInd/eco' && v(10) === 'adaptive/adaptive', 'Eco Pro, Eco Pro+, Eco Pro Individual, Adaptive');
    ok(v('BOOST') === 'boost/sport' && v('PHEV_HYBRID_ECO') === 'hybridEco/hybrid' && v(21) === 'electricInd/electric', 'a plug-in hybrid\'s variants');
    ok(groupOf('comfortPlus') === 'comfort' && groupOf('sport') === 'sport', 'groupOf');

    // learning: before the car sent a mode, the groups; then only what it sent, in a fixed order; kept in the settings
    let writes = [];
    const subs = {};
    const signals = { watch: async (iface, inst, h) => { subs[iface] = h; return { proxy: {}, error: null }; },
        set: async (p, f, x) => { writes.push(Number(String(x.controlMenuAmbientePanoramicRoofInteriorLighting).split('_')[1])); } };
    const s = store({ carKind: 'ice', follow: true, restore: true, sport: 3, comfort: 0, eco: 0, adaptive: 0 });
    let t = 0;
    const a = new Ambient({ settings: s, signals, log, now: () => t });
    await a.start();
    const mode = (m) => subs['de.bmw.infotainment.drivingexcitement.FES'].statusFESVehicleDynamicSwitchHMI({ actualValueModeDrivingExperience: m });
    ok(a.modes().join() === 'sport,comfort,eco,adaptive', 'nothing sent yet: the groups');
    mode('COMFORT_PLUS'); mode('SPORT_EXPERT'); mode('COMFORT_PLUS'); await tick();
    ok(a.modes().join() === 'sportPlus,comfortPlus', 'only what the car sent, Sport first: ' + a.modes().join());
    ok(a.mode() === 'comfortPlus', 'the variant now (the last one sent)');
    ok(JSON.stringify(s.values.modesSeen.slice().sort()) === '["comfortPlus","sportPlus"]', 'kept in the settings');
    ok(!a.modes().includes('adaptive') && !a.modes().includes('sport'), 'a mode never sent is not listed (no Adaptive, no plain Sport)');
    const all = ['SPORT_DYNAMIC', 'SPORT_EXPERT', 'SPORT_INDIVIDUAL', 'COMFORT', 'COMFORT_PLUS', 'COMFORT_INDIVIDUAL', 'ECO_PRO_EFFICIENT', 'ECO_PRO_PLUS', 'ECO_PRO_INDIVIDUAL', 'ADAPTIVE'];
    all.forEach(mode); await tick();
    ok(a.modes().join() === 'sport,sportPlus,sportInd,comfort,comfortPlus,comfortInd,eco,ecoPlus,ecoInd,adaptive', 'all ten: ' + a.modes().join());
    ok(a.modes().length <= MAX_SHOWN, 'at most MAX_SHOWN rows');

    // the colour slot: the variant's own, else its group's
    writes = []; t += 5000;
    s.values.sport = 3; s.values.sportPlus = 0;
    mode('COMFORT'); await tick(); t += 5000;
    mode('SPORT_EXPERT'); await tick();
    ok(writes[writes.length - 1] === 3, 'Sport+ without a colour of its own: Sport\'s (' + writes + ')');
    s.values.sportPlus = 7; t += 5000;
    mode('COMFORT'); await tick(); t += 5000;
    mode('SPORT_EXPERT'); await tick();
    ok(writes[writes.length - 1] === 7, 'Sport+ with its own: its own (' + writes + ')');
    a.stop();

    // Control: a variant's look, else its group's; Original colour the same; the pulse once per change into Sport
    const { Control } = require(path.join(APP, 'control'));
    const cs = store({ follow: true, keep: true, welcome: false, sportPulse: true, nightDim: false, flashAlerts: false });
    const fake = { scene: null, overs: {}, show(sc) { this.scene = sc; }, carColour() { this.scene = null; }, dim() {}, flash() {}, overlay() {} };
    const amb = new EventEmitter(); amb._m = 'comfort'; amb.mode = () => amb._m;
    const c = new Control({ settings: cs, lights: fake, ambient: amb, log });
    c.start();
    const look = (rgb, kind) => ({ kind: kind || 'solid', upper: { rgb, bright: 70 }, lower: { rgb, bright: 70 } });
    c.setLook(look([0, 255, 0]));
    c.setModeLook('sport', look([255, 0, 0], 'breathing'));
    amb._m = 'sportPlus'; amb.emit('change');
    ok(fake.scene && fake.scene.kind === 'pulse' && fake.scene.then.upper.rgb.join() === '255,0,0', 'Comfort to Sport+: the pulse, then Sport\'s look');
    ok(c.modeLook('sportPlus') === null && c.inherits('sportPlus') === 'sport', 'Sport+ has no look of its own: it uses Sport\'s');
    amb._m = 'sport'; amb.emit('change');
    ok(fake.scene.kind !== 'pulse', 'Sport+ to Sport: no second pulse (the same group)');
    c.setModeLook('sportPlus', look([255, 128, 0]));
    amb._m = 'sportPlus'; amb.emit('change');
    ok(fake.scene.upper.rgb.join() === '255,128,0' && c.inherits('sportPlus') === null, 'Sport+ with a look of its own');
    c.setModeLook('comfort', 'original');
    amb._m = 'comfortPlus'; amb.emit('change');
    ok(fake.scene === null && c.originalFor('comfortPlus'), 'Comfort on Original colour: Comfort+ too');
    c.setModeLook('comfortPlus', look([0, 0, 255]));
    amb.emit('change'); c.apply();
    ok(fake.scene && fake.scene.upper.rgb.join() === '0,0,255', 'Comfort+ with a look of its own over Comfort\'s Original colour');
    c.stop();

    // the tab: two columns of up to five rows, column by column, every row inside the panel above the toggles
    const { rows } = require(path.join(APP, 'modes_tab'));
    const r8 = rows(['sport', 'sportPlus', 'comfort', 'comfortPlus', 'eco', 'ecoPlus', 'ecoInd', 'adaptive']);
    ok(r8.length === 8 && r8.slice(0, 5).every((r) => r.x === r8[0].x) && r8.slice(5).every((r) => r.x > r8[0].x), 'eight: five in the left column, three in the right');
    ok(r8.every((r) => r.y >= 92 && r.y + r.h <= 432) && r8[1].y > r8[0].y, 'rows inside the panel, above the toggles at 440');
    ok(r8.every((r) => r.w === r8[0].w) && r8[5].x + r8[5].w <= 1560, 'columns of the same width, inside the panel');
    ok(rows(['sport', 'comfort', 'eco', 'adaptive']).length === 4 && rows(new Array(12).fill('sport')).length === MAX_SHOWN, 'four groups; never more than ten');

    console.log('ambient modes: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
