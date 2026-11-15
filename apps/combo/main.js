'use strict';
/**
 * Combo - the apps used most, as tabs of one app, so the head unit runs one app (one process, one diagnostic link)
 * in place of several:
 *
 *   Driving      engine speed and boost, speed / power / torque, xDrive, the 48 V and 12 V batteries, in M Vitals'
 *                look (design: docs/superpowers/specs/2026-11-08-combo-screen-design.md); draw.js
 *   Performance  Virtual Dyno on the left half, Drag Timer on the right (perf.js)
 *   Ambient, Animations, Modes, Favourites
 *                Ambient config's tabs (its Colour, Animations, Driving modes and Favourites; not the Strobe), the
 *                same code, taken from apps/ambient_config at build time (app.json "include", ambient_page.js)
 *
 * The ambient light runs from the platform's start (app.json "autostart"), as Ambient config does: the look and the
 * driving modes work with the app closed. With Ambient config installed too, the one started first drives the
 * lights and the other leaves them alone (owner.js).
 * Reading only, for the Driving and Performance tabs: car signals over SOME/IP, the rest over the kit's read-only
 * diagnostic link - only while the Driving tab is on screen.
 *
 * Demo data is all or nothing: on with the setting "Always", or (Auto) while no car signal arrived for 5 s. Once the
 * car is there everything shown is the car's; what it doesn't give (yet) shows "--" with the reason.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Engine = require('./kit/engine');
const draw = require('./draw');
const Demo = require('./demo');
const { Values, PEAKS } = require('./values');
const { watches } = require('./signals');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');
const { Reads } = require('./reads');
const { Perf, PerfDemo } = require('./perf');
const ambientPage = require('./ambient_page');

const W = 1600, H = 520;
const TABS = ['Driving', 'Performance'];
// Ambient config's tabs under names that say what they are next to Driving and Performance
const AMBIENT_TABS = ['Ambient', 'Animations', 'Modes', 'Favourites'];
const DRIVING = 0, PERF = 1, AMBIENT = 2;

/** The ambient light, without screens (and the start with them): Ambient config's service, without the strobe. */
const background = (bg) => ambientPage.background(bg, { strobe: false });

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const cfg = (ctx.spec && ctx.spec.config) || {};
        const S = cfg.scaling || {};
        const sc = (k, raw) => {
            const c = S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid || (c.invalidFrom != null && raw >= c.invalidFrom)) return null;
            return raw * c.factor + (c.offset || 0);
        };
        const engine = new Engine({ settings, dataDir: ctx.dataDir, log });
        const values = new Values({ settings, log, dataDir: ctx.dataDir, gearRatios: (cfg.xdrive && cfg.xdrive.gearRatios) || [] });
        const startT = Date.now();
        // tab: DRIVING, PERF or AMBIENT (then amb.page says which of its tabs)
        let tab = DRIVING;

        // the ambient light: its tabs, over the service background() started (a failure leaves the other tabs working)
        let amb = null;
        try {
            const parts = ctx.background || await background(ctx);
            amb = ambientPage.mount(ctx, parts, { strobe: false, names: AMBIENT_TABS, redraw: () => render() });
        } catch (e) { log.error('ambient light: ' + (e && e.stack || e)); }

        watches(values, engine, sc, log).forEach(([iface, h]) => {
            ctx.signals.watch(iface, '1', h, log).then((s) => {
                values.subs.push(s);
                log.info('signal ' + iface.split('.').pop() + (s.error ? ' error: ' + s.error : ' subscribed'));
            });
        });

        const demo = new Demo();
        demo.setRedline(engine.redline());
        if (engine.onChange) engine.onChange(() => demo.setRedline(engine.redline()));
        // the demo keeps its own peaks, so they never mix with the car's (M Vitals' demoPeak)
        const demoPeaks = new Values({ settings, log });
        const usingDemo = () => settings.get('demo') === 'on'
            || (settings.get('demo') === 'auto' && !values.carPresent() && Date.now() - startT > 5000);

        // the diagnostic link: reading only, connected in the background (the screen must not wait for it); it reads
        // only while the Driving tab shows (the other tabs need nothing from it: no load on the link meanwhile)
        const link = new ReadOnlyDiag(ctx.signals, log);
        link.init().catch((e) => log.warn('diagnostic link: ' + e));
        const reads = new Reads({ link, reader: new DidReader(link), values, settings, cfg, ui, log, dataDir: ctx.dataDir,
            active: () => tab === DRIVING && !usingDemo() });
        // shown again (another app was on screen): a round at once
        ui.onVisible((name, v) => { if (name === 'MAIN' && v && tab === DRIVING) reads.opened(); });
        reads.start();

        // the Performance tab: the car's values as they come (each speed times the drag run), the demo's at 20 Hz;
        // the timer's clock runs with the tab hidden too, so a launch is caught from any tab
        const perf = new Perf({ settings, log, dataDir: ctx.dataDir, engine });
        const perfDemo = new PerfDemo();
        const SAMPLE = { rpm: 1, speed: 1, gLong: 1, torque: 1 };
        values.onPut = (k, v) => {
            if (perf.isDemo || !SAMPLE[k]) return;
            const now = Date.now(), L = values.live;
            if (k === 'speed') perf.speed(now, v);
            perf.sample({ rpm: L.rpm, speed: L.speed, gLong: L.gLong, torque: L.torque }, now);
        };
        setInterval(() => {
            const now = Date.now();
            perf.demo(usingDemo());
            if (!perf.isDemo) { perf.idle(now); return; }
            const d = perfDemo.sample(now);
            perf.speed(now, d.speed);
            perf.sample(d, now);
        }, 50);
        settings.onChange((k) => { if (k === 'speedUnit' || k === 'distance' || k === 'rollout') perf.newTimer(); });

        /** What draw.render() shows, from the demo or from the car (one shape for both). */
        function data() {
            if (usingDemo()) {
                const s = demo.sample();
                return { demo: true, rpm: s.rpm, boost: s.boost, boostTarget: s.boostTarget, speed: s.speed, gear: s.gear, gearMode: s.gearMode, stage: 'D',
                    power: { kw: s.powerPct / 100 * settings.get('maxPower'), calc: false }, torque: s.torque,
                    split: { rear: s.splitRear, from: null, nm: s.lmvFront }, slip: s.slip, awd: s.awd, awdQual: s.awdQual, b48: s.b48, b12: s.b12 };
            }
            const L = values.live, bat = reads.fresh();
            return { demo: false, rpm: L.rpm, boost: values.boost().value, boostTarget: L.boostTarget, speed: L.speed,
                gear: L.gear !== undefined ? L.gear : L.gearGuess, gearMode: L.gearMode || L.program || null, stage: L.stage,
                power: values.power(), torque: L.torque, split: values.split(), slip: values.slip(), awd: L.awd, awdQual: L.awdQual, b48: bat.b48, b12: bat.b12, has48: bat.has48 };
        }

        const tabs = () => TABS.concat(amb ? amb.tabs() : []);
        const sel = () => (tab === AMBIENT ? AMBIENT + amb.page : tab);

        // the bar's Reset button, by tab: Reset peaks (Driving: the first press asks, a second one within CONFIRM_MS
        // clears them, M Vitals' confirm pattern), Reset run (Performance), Original colour (the ambient tabs)
        const CONFIRM_MS = 6000;
        let confirmUntil = 0;
        const resetLabel = () => ui.text('BTN_RESET', tab === DRIVING ? 'Reset peaks' : tab === PERF ? 'Reset run' : 'Original colour');
        ui.onClick('BTN_RESET', () => {
            if (tab === PERF) { perf.resetRun(); return render(); }
            if (tab === AMBIENT) { if (amb) { amb.original(); amb.dirty(); } return render(); }
            reads.opened();                                  // a button press counts as using the screen
            if (Date.now() > confirmUntil) { confirmUntil = Date.now() + CONFIRM_MS; return render(); }
            confirmUntil = 0;
            values.resetPeaks(); demoPeaks.resetPeaks();
            log.info('peaks reset');
            return render();
        });
        // a new boost source: its peak starts over (M Vitals)
        settings.onChange((k) => { if (k === 'boostSource') { delete values.peaks.boost; delete demoPeaks.peaks.boost; } });

        /** A tab picked on the tab bar (touch or controller): i counts Driving, Performance, then the ambient tabs. */
        function pick(i) {
            const was = tab;
            if (i >= AMBIENT && amb) { tab = AMBIENT; amb.select(i - AMBIENT); } else tab = i === PERF ? PERF : DRIVING;
            if (was === AMBIENT && tab !== AMBIENT) amb.leave();
            if (tab === DRIVING && was !== DRIVING) reads.opened();          // back on Driving: a round at once
            if (tab !== was) { log.info('tab ' + tabs()[sel()]); resetLabel(); }
            return render();
        }
        ctx.onTab((i) => pick(i));
        // the frame's place changed (the GPU renderer came after the first frame): the ambient tabs draw again too
        if (ctx.onLayout) ctx.onLayout(() => { if (amb) amb.dirty(); });
        if (ctx.onTap) ctx.onTap((x, y) => (tab === AMBIENT && amb ? amb.tap(x, y) : null));

        function drawDriving(cv, t) {
            const d = data();
            // peaks raised every frame too, so a held peak drops back while the car sends nothing new (M Vitals)
            const pk = d.demo ? demoPeaks : values, now = { rpm: d.rpm, boost: d.boost, power: d.power.kw, torque: d.torque, lmvFront: d.split.nm };
            PEAKS.forEach((k) => pk.raise(k, now[k]));
            if (!d.demo) reads.shown();          // (a frame of the car's values after the demo: a round at once)
            draw.render(cv, t, d, { settings, peak: (k) => pk.peak(k), why: (k) => reads.why(k), redline: engine.redline(), scaleMax: engine.scaleMax(), has48: d.has48,
                note: Date.now() <= confirmUntil ? 'Press again to reset peaks' : null, tabs: tabs(), sel: sel() });
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            if (tab === DRIVING) drawDriving(cv, t);
            else if (tab === PERF) {
                perf.draw(cv, t, { redraw: () => render() });
                G.frame(cv, t, tabs(), sel(), [perf.isDemo && { text: 'DEMO' }, settings.get('rollout') && { text: 'ROLLOUT 1 FT', color: 'dim' }]);
            } else {
                amb.draw(cv, t);
                G.frame(cv, t, tabs(), sel(), []);
            }
            await ui.image('MAIN_GFX', cv);
        }
        // Driving and Performance follow the car each frame; the ambient tabs only while they move or changed
        ctx.loop('MAIN', 10, () => (tab !== AMBIENT || amb.wants() ? render() : null));
        resetLabel();
        log.info('started' + (amb ? '' : ' (without the ambient light)'));
    },
});
