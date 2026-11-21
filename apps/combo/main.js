'use strict';
/**
 * Combo - the apps used most, as tabs of one app, so the head unit runs one app (one process, one diagnostic link)
 * in place of several:
 *
 *   Driving      engine speed and boost, speed / power / torque, xDrive, the 48 V and 12 V batteries, in M Vitals'
 *                look (design: docs/superpowers/specs/2026-11-08-combo-screen-design.md); draw.js
 *   Performance  Virtual Dyno on the left half, Drag Timer on the right (perf.js)
 *   Seats        the driver seat's position from the car (seats.js; reading only for now: memory 1-3 and easy entry
 *                next, once a car's log shows the position reply)
 *   M View       engine oil, coolant, gearbox oil and intake air temperatures, fuel trims and timing, misfires per cylinder
 *                (mview.js; read only while the tab shows)
 *   Ambient, Animations, Modes
 *                Ambient config's tabs (its Colour, Animations and Driving modes; not Favourites, not the Strobe), the
 *                same code, taken from shared/ambient_config at build time (app.json "include", ambient_page.js)
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
const { withAlpha } = require('./kit/canvas');
const Engine = require('./kit/engine');
const draw = require('./draw');
const Demo = require('./demo');
const { Values, PEAKS } = require('./values');
const { watches } = require('./signals');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');
const { Reads } = require('./reads');
const { Perf, PerfDemo } = require('./perf');
const { Seats } = require('./seats');
const { MView } = require('./mview');
const ambientPage = require('./ambient_page');

const W = 1600, H = 520;
const TABS = ['Driving', 'Performance', 'Seats', 'M View'];
// Ambient config's tabs under names that say what they are next to Driving and Performance (its Favourites left out:
// M View took its place, 2.4.0)
const AMBIENT_TABS = ['Ambient', 'Animations', 'Modes'];
const DRIVING = 0, PERF = 1, SEATS = 2, MVIEW = 3, AMBIENT = 4;

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
        // tab: DRIVING, PERF, SEATS, MVIEW or AMBIENT (then amb.page says which of its tabs)
        let tab = DRIVING;

        // the ambient light: its tabs, over the service background() started (a failure leaves the other tabs working)
        let amb = null, ambLights = null;
        try {
            const parts = ctx.background || await background(ctx);
            ambLights = parts.lights;
            amb = ambientPage.mount(ctx, parts, { strobe: false, names: AMBIENT_TABS, redraw: () => render() });
        } catch (e) { log.error('ambient light: ' + (e && e.stack || e)); }

        watches(values, engine, sc, log).forEach(([iface, h]) => {
            // (the tyres also read every 10 s: BMW's own app only ever reads them, so a car may not notify them)
            ctx.signals.watch(iface, '1', h, log, /\.TPMS$/.test(iface) ? { pollMs: 10000 } : undefined).then((s) => {
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
            active: () => tab === DRIVING && !usingDemo(),
            // the ambient light's writes go first (the gateway takes one request at a time)
            yieldTo: () => !!(ambLights && ambLights._running && !ambLights.held) });
        // shown again (another app was on screen): a round at once
        ui.onVisible((name, v) => { if (name === 'MAIN' && v && tab === DRIVING) reads.opened(); });
        reads.start();

        // the Performance tab: the car's values as they come (each speed times the drag run), the demo's at 20 Hz;
        // the timer's clock runs with the tab hidden too, so a launch is caught from any tab
        const perf = new Perf({ settings, log, dataDir: ctx.dataDir, engine });
        // the Seats tab: the driver seat's position from the car, read only while the tab shows (seats.js)
        const seats = new Seats({ signals: ctx.signals, log, link, values, yieldTo: () => !!(ambLights && ambLights._running && !ambLights.held) });
        // the M View tab: temperatures, fuel trims and timing, misfires; its reads only while the tab shows (mview.js)
        const mview = new MView({ reader: new DidReader(link), values, cfg: cfg.mview, settings, log, link,
            yieldTo: () => !!(ambLights && ambLights._running && !ambLights.held) });
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
                    split: { rear: s.splitRear, from: null, nm: s.lmvFront }, slip: s.slip, awd: s.awd, awdQual: s.awdQual, b48: s.b48, b12: s.b12, tyres: s.tyres };
            }
            const L = values.live, bat = reads.fresh();
            return { demo: false, rpm: L.rpm, boost: values.boost().value, boostTarget: L.boostTarget, speed: L.speed,
                gear: L.gear !== undefined ? L.gear : L.gearGuess, gearMode: L.gearMode || L.program || null, stage: L.stage,
                power: values.power(), torque: L.torque, split: values.split(), slip: values.slip(), awd: L.awd, awdQual: L.awdQual, b48: bat.b48, b12: bat.b12, has48: bat.has48,
                tyres: L.tyresT && Date.now() - L.tyresT < 5 * 60000 ? L.tyres : null };
        }

        // where the kit runs the screen (full layout, mgu-render; cv.own): Ambient config's three tabs are one Ambient tab
        // with its pages as sub-tabs, so Settings fits in the header as its last tab; each tab's Reset is on its page and
        // the bottom bar is gone (2.4.6). Elsewhere (the HMI's own bar and title) as before.
        let owned = false;
        const tabs = () => TABS.concat(!amb ? [] : owned ? [owned && ctx.mapStyle && ctx.mapStyle() ? 'Ambient · ' + ['Colour', 'Animations', 'Modes'][amb.page || 0] : 'Ambient'] : amb.tabs());
        const sel = () => (tab === AMBIENT ? AMBIENT + (owned ? 0 : amb.page) : tab);
        if (ctx.hideButton) ctx.hideButton('BTN_RESET');

        // the bar's Reset button, by tab: Reset peaks (Driving: the first press asks, a second one within CONFIRM_MS
        // clears them, M Vitals' confirm pattern), Reset run (Performance), Original colour (the ambient tabs)
        const CONFIRM_MS = 6000;
        let confirmUntil = 0;
        const resetLabel = () => ui.text('BTN_RESET', tab === DRIVING ? 'Reset peaks' : tab === PERF ? 'Reset run' : tab === SEATS ? 'Read again' : tab === MVIEW ? 'Reset misfires' : 'Original colour');
        ui.onClick('BTN_RESET', () => {
            if (tab === PERF) { perf.resetRun(); return render(); }
            if (tab === SEATS) { seats.again(); seats.poll(); return render(); }
            if (tab === MVIEW) { mview.resetMisfires(); return render(); }
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

        /** A tab picked on the tab bar (touch or controller): i counts Driving, Performance, Seats, M View, then the ambient tabs. */
        function pick(i) {
            const was = tab;
            if (i >= AMBIENT && amb) { tab = AMBIENT; if (!owned) amb.select(i - AMBIENT); } else tab = i === PERF ? PERF : i === SEATS ? SEATS : i === MVIEW ? MVIEW : DRIVING;
            if (was === AMBIENT && tab !== AMBIENT) amb.leave();
            if (tab === DRIVING && was !== DRIVING) reads.opened();          // back on Driving: a round at once
            if (tab !== was) { railOpen = null; if (owned && !mapped() && tab === AMBIENT && !railShown) { railShown = true; railOpen = 'L'; railT = Date.now(); } log.info('tab ' + (tab === AMBIENT ? AMBIENT_TABS[amb.page] : tabs()[sel()]) + (tab === SEATS ? ' (seats: ' + seats.summary() + ')' : '')); resetLabel(); }
            return render();
        }
        ctx.onTab((i) => pick(i));
        // the frame's place changed (the GPU renderer came after the first frame): the ambient tabs draw again too
        if (ctx.onLayout) ctx.onLayout(() => { if (amb) amb.dirty(); });
        // the ambient tabs: a finger dragged on the colour ring or the brightness dial (kit's onTouch), else a tap
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => (tab === AMBIENT && amb && !onRail(x, y) ? amb.touch(phase, x, y) : false));
        if (ctx.onTap) ctx.onTap((x, y) => (tab === AMBIENT && amb && !onRail(x, y) ? amb.tap(x, y) : null));      // (no tap follows a gesture onTouch took)

        function drawDriving(cv, t) {
            const d = data();
            // peaks raised every frame too, so a held peak drops back while the car sends nothing new (M Vitals)
            const pk = d.demo ? demoPeaks : values, now = { rpm: d.rpm, boost: d.boost, power: d.power.kw, torque: d.torque, lmvFront: d.split.nm };
            PEAKS.forEach((k) => pk.raise(k, now[k]));
            if (!d.demo) reads.shown();          // (a frame of the car's values after the demo: a round at once)
            draw.render(cv, t, d, { settings, peak: (k) => pk.peak(k), why: (k) => reads.why(k), redline: engine.redline(), scaleMax: engine.scaleMax(), has48: d.has48,
            no12A: !d.demo && !reads.can('i12'),
                note: Date.now() <= confirmUntil ? 'Press again to reset peaks' : null, tabs: tabs(), sel: sel() });
        }

        /*
         * Side bars where the kit runs the screen. Full screen (2.4.8): one rail on the left with the tab's own actions
         * (Ambient's three pages, each tab's Reset; the strip over the cards is under the kit's header there). Map style
         * (2.5.0, layout "map", as BMW's map): no tabs in the header - the left bar has the pages (Ambient's three under
         * it), the right one the tab's action and Settings. A handle on the edge opens a bar by touch (hidden again
         * RAIL_HIDE_MS after the last touch), the controller pushed left / right too (open until pushed back or a row
         * is pressed). The full layout's rail opens by itself the first time the Ambient tab shows, so its pages are found.
         */
        // EDGE: where the page shows from (the kit's full layout trims 12 px each side, display.js FULL.src)
        const RAIL_W = 300, MAP_W = 340, RAIL_HIDE_MS = 5000, RAIL_TOP = 50, EDGE = 12;
        let railOpen = null, railT = 0, railShown = false, railByKnob = false;      // railOpen: null, 'L' or 'R'
        const mapped = () => owned && !!(ctx.mapStyle && ctx.mapStyle());
        const barW = () => (mapped() ? MAP_W : RAIL_W);
        const openRail = (side, knob) => { railOpen = side || null; railByKnob = !!(side && knob); railT = Date.now(); if (amb && tab === AMBIENT) amb.dirty(); return render(); };
        /** The tab's own actions: [label, run, { primary, confirm, key }] */
        function actionRows() {
            const rows = [];
            if (tab === DRIVING) rows.push(['Reset peaks', () => { values.resetPeaks(); demoPeaks.resetPeaks(); log.info('peaks reset'); return openRail(null); }, { key: 'peaks', confirm: true }]);
            else if (tab === PERF) rows.push(['Reset run', () => { perf.resetRun(); return openRail(null); }, { key: 'perf-run' }]);
            else if (tab === SEATS) rows.push(['Read again', () => { seats.again(); seats.poll(); return openRail(null); }, { key: 'seats-again' }]);
            else if (tab === MVIEW) rows.push(['Reset misfires', () => { mview.resetMisfires(); return openRail(null); }, { key: 'misfires' }]);
            return rows;
        }
        const ambRows = (sub) => AMBIENT_TABS.map((n, k) => [n === 'Ambient' ? 'Colour' : n, () => {
            if (tab !== AMBIENT) pick(AMBIENT);
            if (amb.page !== k) { amb.select(k); amb.dirty(); log.info('tab ' + n); }
            return openRail(null);
        }, { key: 'amb-' + k, primary: tab === AMBIENT && amb.page === k, sub }]);
        /** A bar's rows (null: a line between groups). */
        function railRows(side) {
            if (!mapped()) return side !== 'L' ? [] : tab === AMBIENT && amb ? ambRows(false) : actionRows();
            if (side === 'L') {
                const rows = TABS.map((n, i) => [n, () => { pick(i); return openRail(null); }, { key: 'nav-' + i, primary: tab === i }]);
                if (amb) { rows.push(['Ambient', () => { pick(AMBIENT); return openRail(null); }, { key: 'nav-' + AMBIENT, primary: tab === AMBIENT, head: true }]); ambRows(true).forEach((r) => rows.push(r)); }
                return rows;
            }
            const rows = actionRows();
            if (rows.length) rows.push(null);
            rows.push(['Settings', () => { openRail(null); if (ctx.openSettings) ctx.openSettings(); return null; }, { key: 'settings' }]);
            return rows;
        }
        /** Where the controller goes when a bar opens: the row of the page shown, else the first. */
        const knobRow = (side) => { const rows = railRows(side).filter(Boolean); const on = rows.find((r) => r[2].primary && !r[2].head) || rows[0]; return on ? on[2].key : true; };
        // the controller: pushed left / right opens that side's bar (the knob on its row), pushed back closes it
        if (ctx.onTilt) ctx.onTilt((dir) => {
            if (!owned) return null;
            if (!mapped()) {
                if (!railRows('L').length) return null;
                if (dir === 'W' && !railOpen) { openRail('L', true); return knobRow('L'); }
                if (dir === 'W' && railOpen) return true;          // (already open: not "back", which would leave the app)
                if (dir === 'E' && railOpen) { openRail(null); return true; }
                return null;
            }
            if (dir === 'W') { if (railOpen === 'R') { openRail(null); return true; } if (!railOpen) { openRail('L', true); return knobRow('L'); } return true; }
            if (dir === 'E') { if (railOpen === 'L') { openRail(null); return true; } if (!railOpen) { openRail('R', true); return knobRow('R'); } return true; }
            return null;
        });
        /** A touch on an open bar or a handle is the bar's, not the page's (the colour ring under it). */
        const onRail = (x, y) => owned && (railOpen === 'L' ? x < barW() + EDGE : railOpen === 'R' ? x > W - barW() - EDGE
            : (y > 190 && y < 350 && (x < EDGE + 44 || (mapped() && x > W - EDGE - 44))));
        function drawRail(cv, t) {
            // (opened with the controller: open until it is pushed back or a row is pressed)
            if (railOpen && !railByKnob && Date.now() - railT > RAIL_HIDE_MS) { railOpen = null; if (amb && tab === AMBIENT) amb.dirty(); }
            const handle = (side) => {
                if (!railRows(side).length) return;
                // in the margin beside the cards that the kit shows (it trims x < 12 and > 1588: 2.5.0's right one was cut off)
                const x = side === 'L' ? EDGE : W - EDGE - 10;
                cv.roundRect(x, 210, 10, 120, 5, withAlpha('#ffffff', 0.42));
                cv.target(side === 'L' ? EDGE : W - EDGE - 44, 190, 44, 160, () => openRail(side), side === 'L' ? 'rail' : 'rail-r');
            };
            if (!railOpen) { handle('L'); if (mapped()) handle('R'); return; }
            const side = railOpen, rows = railRows(side), bw = barW(), x0 = side === 'L' ? EDGE : W - bw - EDGE;
            const bot = 516 + (cv.extra || 0);         // (down into the room below the page, as the cards)
            cv.roundRect(x0, RAIL_TOP, bw, bot - RAIL_TOP, 12, t.bg);
            cv.roundRect(x0, RAIL_TOP, bw, bot - RAIL_TOP, 12, withAlpha('#ffffff', 0.05));
            cv.strokeRoundRect(x0, RAIL_TOP, bw, bot - RAIL_TOP, 12, 1.5, withAlpha('#ffffff', 0.18));
            let y = RAIL_TOP + 18;
            const big = rows.length <= 4;
            rows.forEach((r) => {
                if (!r) { y += 10; cv.fillRect(x0 + 24, y - 6, bw - 48, 1, withAlpha('#ffffff', 0.15)); return; }
                const sub = r[2].sub, h = sub ? 40 : big ? 56 : 46, ix = x0 + 20 + (sub ? 30 : 0);
                G.button(cv, t, ix, y, bw - 40 - (sub ? 30 : 0), h, r[0], () => { railT = Date.now(); return r[1](); }, r[2]);
                y += h + (sub ? 6 : 10);
            });
            // close: a row of its own at the bottom (or wait: it hides by itself)
            G.button(cv, t, x0 + 20, bot - 18 - 44, bw - 40, 44, side === 'L' ? '<  Hide' : 'Hide  >', () => openRail(null), { key: side === 'L' ? 'rail-close' : 'rail-r-close' });
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            if (!!cv.own !== owned) { owned = !!cv.own; if (amb && tab === AMBIENT) amb.dirty(); }
            if (tab === DRIVING) drawDriving(cv, t);
            else if (tab === MVIEW) {
                const demoOn = usingDemo();
                if (!demoOn) mview.tick();
                mview.draw(cv, t, { demo: demoOn });
                G.frame(cv, t, tabs(), sel(), [demoOn && { text: 'DEMO' }]);
            } else if (tab === SEATS) {
                seats.poll();
                seats.draw(cv, t);
                G.frame(cv, t, tabs(), sel(), []);
            } else if (tab === PERF) {
                perf.draw(cv, t, { redraw: () => render() });
                G.frame(cv, t, tabs(), sel(), [perf.isDemo && { text: 'DEMO' }, settings.get('rollout') && { text: 'ROLLOUT 1 FT', color: 'dim' }]);
            } else {
                amb.draw(cv, t);
                G.frame(cv, t, tabs(), sel(), []);
            }
            if (owned) drawRail(cv, t);
            await ui.image('MAIN_GFX', cv);
        }
        // Driving and Performance follow the car each frame; the ambient tabs only while they move or changed
        ctx.loop('MAIN', 10, () => (tab !== AMBIENT || amb.wants() || railOpen ? render() : null));
        resetLabel();
        log.info('started' + (amb ? '' : ' (without the ambient light)'));
    },
});
