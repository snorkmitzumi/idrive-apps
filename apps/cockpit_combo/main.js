'use strict';
/**
 * Combo - the apps used most, as tabs of one app, so the head unit runs one app (one process, one diagnostic link)
 * in place of several:
 *
 *   Driving      engine speed and boost, speed / power / torque, xDrive, the 48 V and 12 V batteries, in M Vitals'
 *                look (design: docs/superpowers/specs/2026-11-08-combo-screen-design.md); draw.js
 *   Performance  Virtual Dyno on the left half, Drag Timer on the right (perf.js)
 *   Seats        both front seats' positions from their seat modules, memory 1-3 and easy entry (seats.js, seatmove.js:
 *                standing only, the seat's own switches stop a move)
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
const { ReadOnlyDiag, seatMotors } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');
const { Reads } = require('./reads');
const { Perf, PerfDemo } = require('./perf');
const { Seats } = require('./seats');
const { drawBar } = require('./rail');
const { probe } = require('./seatprobe');
const { MView } = require('./mview');
const { Trips } = require('./trips');
const { LocalTime } = require('./localtime');
const ambientPage = require('./ambient_page');

const W = 1600, H = 520;
const TABS = ['Driving', 'Performance', 'Seats', 'M View', 'Ambient', 'Trips'];      // by id (Ambient's own names: AMBIENT_TABS)
// Ambient config's tabs under names that say what they are next to Driving and Performance (its Favourites left out:
// M View took its place, 2.4.0)
const AMBIENT_TABS = ['Ambient', 'Animations', 'Modes'];
const DRIVING = 0, PERF = 1, SEATS = 2, MVIEW = 3, AMBIENT = 4, TRIPS = 5;     // (Trips shows before Ambient: shownIds())
// the tabs Settings > Tabs switches off (2.7.0; Driving always there): an app beside Combo doing the same job (Ambient
// config, another seats app) gets it to itself, and an unused tab costs nothing - Seats off reads no seat and moves none
// (no easy entry), Ambient off gives the lights back and leaves them alone (owner.js: another app of ours takes them)
const TAB_KEYS = { [PERF]: 'tabPerformance', [SEATS]: 'tabSeats', [MVIEW]: 'tabMView', [TRIPS]: 'tabTrips', [AMBIENT]: 'tabAmbient' };
const isOn = (settings, id) => !TAB_KEYS[id] || !settings || settings.get(TAB_KEYS[id]) !== false;
const AMB_OFF_MS = 3000;             // Ambient switched off: the give-back's writes go out this long, then none at all

/** The ambient light, without screens (and the start with them): Ambient config's service, without the strobe; none with the Ambient tab off. */
const ambientService = (bg) => ambientPage.background(bg, { strobe: false });
const background = (bg) => (isOn(bg.settings, AMBIENT) ? ambientService(bg) : Promise.resolve(null));

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
        let loop = null;                 // the frame loop (ctx.loop's handle), set at the end of start-up

        const enabled = (id) => isOn(settings, id);
        // the ambient light: its tabs, over the service background() started (a failure leaves the other tabs working);
        // with the Ambient tab off, none until it is switched on
        let amb = null, ambLights = null, ambParts = ctx.background || null, ambOff = null;
        async function ambientUp() {
            if (amb || !enabled(AMBIENT)) return;
            try {
                if (!ambParts) ambParts = await ambientService(ctx);
                ambLights = ambParts.lights;
                amb = ambientPage.mount(ctx, ambParts, { strobe: false, names: AMBIENT_TABS, redraw: () => render() });
            } catch (e) { log.error('ambient light: ' + (e && e.stack || e)); }
        }
        await ambientUp();
        /** The Ambient tab switched on or off: off gives every light back to the car, then writes nothing and lets another app of ours have them. */
        function ambientSwitched() {
            clearTimeout(ambOff); ambOff = null;
            if (enabled(AMBIENT)) {
                if (!ambParts) return ambientUp().then(() => render()).catch((e) => log.error('ambient light: ' + e));
                ambParts.lights.hold('off', false);
                // (started again as a new one: an app of ours that took the lights meanwhile keeps them)
                if (ambParts.owner && ambParts.ownerOff) { ambParts.ownerOff = false; ambParts.owner.since = Date.now(); ambParts.owner.start(); }
                ambParts.control.apply();
                log.info('ambient: switched on');
                return null;
            }
            if (!ambParts) return null;
            log.info('ambient: switched off, the lights given back to the car');
            ambParts.lights.carColour();
            ambOff = setTimeout(() => {
                ambOff = null;
                if (enabled(AMBIENT)) return;
                ambParts.lights.hold('off', true).catch((e) => log.warn('ambient: hold: ' + e));
                if (ambParts.owner && !ambParts.ownerOff) { ambParts.ownerOff = true; ambParts.owner.stop(); }
            }, AMB_OFF_MS);
            return null;
        }

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
        // (memory 1-3 and easy entry: the link's one write, seat motors to 0x6D / 0x6E, handed to the Seats tab alone)
        const seats = new Seats({ signals: ctx.signals, log, link, motor: seatMotors(link), values, settings, dataDir: ctx.dataDir, enabled: () => enabled(SEATS), yieldTo: () => !!(ambLights && ambLights._running && !ambLights.held),
            // while a seat moves the ambient light writes nothing (its red door blink took the link from the seat)
            quietOthers: (on) => (ambLights && ambLights.hold ? ambLights.hold('seats', on) : null) });
        // easy entry: only a front door opening takes its seat to its easy entry position (seats.js doors()); back by hand
        const DOOR_FIELDS = { statusDoorSwitchDRD: 'driver front', statusDoorSwitchPSD: 'passenger front' };
        // BMW's own seat functions, listened to (reading only): does the car let an app hear its memory buttons? (seatprobe.js)
        // (only with the Seats tab on: asked once it is)
        let seatProbe = null;
        const probeSeats = () => { if (!seatProbe && enabled(SEATS)) seatProbe = probe(ctx.signals, log); };
        probeSeats();
        ctx.signals.watch('de.bmw.body.DoorsWindowsRoofMirrors', '1', { CentralLockingSystemAndPanelStatus: (v) => seats.doors(Object.keys(DOOR_FIELDS)
            .filter((k) => v && (v[k] === 1 || /_OFFEN$/.test(String(v[k])))).map((k) => DOOR_FIELDS[k])) }, log)
            .catch((e) => log.warn('doors: ' + (e && e.message || e)));
        // the M View tab: temperatures, fuel trims and timing, misfires; its reads only while the tab shows (mview.js)
        const mview = new MView({ reader: new DidReader(link), values, cfg: cfg.mview, settings, log, link,
            yieldTo: () => !!(ambLights && ambLights._running && !ambLights.held) });
        // the trip book (trips.js, 2.9.0): each drive cycle from the car's own state, its distance from the odometer or the
        // speed, its fuel from the tank's level; recorded whether the Trips tab shows or not (not with the tab switched off)
        // the car's local time (the head unit's clock is UTC): from the HMI's AutoTime, kept across starts
        const localTime = new LocalTime({ dataDir: ctx.dataDir, log });
        const trips = new Trips({ dataDir: ctx.dataDir, log, settings, localTime });
        // ...and as the car stops (ready to drive -> not, the trip book's test) the log goes to the owner's GitHub repository:
        // the kit's log upload (app.json "logUpload", 2.9.4), which itself sends after a start, when switched on and from its row
        let wasReady = null;
        setInterval(() => {
            const c = values.live.condition;
            if (enabled(TRIPS)) trips.tick({ speed: values.live.speed, condition: c });
            if (!ctx.logUpload || typeof c !== 'number') return;
            const ready = c === 8 || c === 10;
            if (wasReady && !ready) setTimeout(() => ctx.logUpload.send('car stopped'), 5000);
            wasReady = ready;
        }, 1000);
        process.on('exit', () => { if (enabled(TRIPS)) trips.save(); });
        settings.onChange((k) => { if (k === TAB_KEYS[TRIPS] && !enabled(TRIPS)) trips.endNow(); });
        // the car's odometer and the fuel in the tank, where the car offers them to apps (each logged once as it first comes,
        // to see on a car which ones it sends); read every minute too, as a car may only notify a change
        const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null), firstSeen = {};
        const raw = (name) => (v) => { if (!firstSeen[name]) { firstSeen[name] = true; let s; try { s = JSON.stringify(v); } catch (e) { s = String(v); } log.info('trips signal ' + name + ': ' + (s && s.length > 300 ? s.slice(0, 300) + '...' : s)); } };
        const tripWatch = (iface, handlers) => ctx.signals.watch(iface, '1', handlers, log, { pollMs: 60000 }).then((r) => log.info('trips signal ' + iface.split('.').pop() + (r.error ? ' not set up: ' + r.error : ' offered by the car: ' + r.available)))
            .catch((e) => log.warn('trips signal ' + iface.split('.').pop() + ': ' + (e && e.message || e)));
        // (each source's latest value, for the status line below)
        const lastOf = {}, seenOf = (k, x) => { lastOf[k] = x; return x; };
        tripWatch('de.bmw.infrastructure.SecureMileage', { mileage: (v) => { raw('SecureMileage')(v); const km = seenOf('SecureMileage', num(v && v.currentMileage)); if (km !== null && km > 0) trips.odometer(km, 'SecureMileage'); } });
        // the instrument cluster's tank status carries the odometer too (mileageKilometre: 77761 km on a G26 that reads
        // 77761, 2.9.6). VehicleModel.MileageVehicle, read before, is no odometer: 6925, 7181, 7437 a second apart
        let fuelKombi = false;
        ctx.signals.watch('com.harman.infotainment.systeminfrastructure.autotime.autotime.AutoTime', 'Inst1', { current: (v) => { raw('AutoTime current')(v); localTime.fromLocal(v); } }, log, { pollMs: 600000 })
            .then((r) => log.info('local time: AutoTime ' + (r.error ? 'not set up: ' + r.error : 'offered by the car: ' + r.available))).catch((e) => log.warn('local time: ' + (e && e.message || e)));
        tripWatch('de.bmw.infotainment.KombiIF', { statusTimeDate: (v) => raw('Kombi statusTimeDate')(v), timeDateUTC: (v) => raw('Kombi timeDateUTC')(v), statusRangeTankStatus: (v) => {
            raw('RangeTankStatus')(v);
            const l = seenOf('RangeTankStatus', num(v && v.fluidLevelFuelTank)), km = seenOf('Kombi mileage', num(v && v.mileageKilometre));
            if (l !== null && l < 255) { fuelKombi = true; trips.fuel(l); }
            if (km !== null && km > 0 && km < 16777214) trips.odometer(km, 'Kombi');
        } });
        tripWatch('de.bmw.infotainment.lsc.LSCDataSink', { mileageRange: (v) => { raw('LSC mileageRange')(v); const l = seenOf('LSC mileageRange', num(v && v.fluidLevelFuelTank)); if (!fuelKombi && l !== null && l < 255) trips.fuel(l); }, fuelSupply: (v) => raw('LSC fuelSupply')(v) });
        // every 10 minutes, what was only logged at the start (the QR log keeps the newest lines): whether the renderer
        // can draw in-page (BMW's popups over the app) and the odometer and fuel values per source
        setInterval(() => {
            const g = ctx.display && ctx.display.gpu, info = g && g.info;
            log.info('status: renderer ' + (info ? JSON.stringify(info) : g ? 'connected, no mgu-render/1 info' : 'none (software)') + '; trips odometer ' + (trips.odoSrc || 'none')
                + ' ' + JSON.stringify(lastOf) + (trips.current ? '; trip ' + trips.closed(trips.current).km + ' km' : ''));
        }, 600000);
        // the trip computer's own average: logged as it changes (up to 12 times a run), to learn whether it carries the real
        // consumption while driving (it read all 0 at each start so far) and could replace the tank's whole litres
        let avgSeen = 0, avgLast = null;
        tripWatch('de.bmw.infotainment.resetlogic.ResetLogic', { averageConsumption: (v) => {
            let s; try { s = JSON.stringify(v); } catch (e) { s = String(v); }
            if (s === avgLast || avgSeen >= 12) return;
            avgLast = s; avgSeen++;
            log.info('trips signal ResetLogic averageConsumption (' + avgSeen + '): ' + (s && s.length > 300 ? s.slice(0, 300) + '...' : s));
        } });
        const perfDemo = new PerfDemo();
        const SAMPLE = { rpm: 1, speed: 1, gLong: 1, torque: 1 };
        values.onPut = (k, v) => {
            if (perf.isDemo || !SAMPLE[k] || !enabled(PERF)) return;
            const now = Date.now(), L = values.live;
            if (k === 'speed') perf.speed(now, v);
            perf.sample({ rpm: L.rpm, speed: L.speed, gLong: L.gLong, torque: L.torque }, now);
        };
        setInterval(() => {
            if (!enabled(PERF)) return;
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
        /** The tabs switched on, by id: Driving, Performance, Seats, M View (Ambient after them, ambOn()). */
        const shownIds = () => [DRIVING, PERF, SEATS, MVIEW, TRIPS].filter(enabled);
        const ambOn = () => !!amb && enabled(AMBIENT);
        const tabs = () => shownIds().map((i) => TABS[i]).concat(!ambOn() ? [] : owned ? ['Ambient'] : amb.tabs());
        const sel = () => { const ids = shownIds(); return tab === AMBIENT ? ids.length + (owned ? 0 : amb.page) : Math.max(0, ids.indexOf(tab)); };
        if (ctx.hideButton) ctx.hideButton('BTN_RESET');

        // the bar's Reset button, by tab: Reset peaks (Driving: the first press asks, a second one within CONFIRM_MS
        // clears them, M Vitals' confirm pattern), Reset run (Performance), Original colour (the ambient tabs)
        const CONFIRM_MS = 6000;
        let confirmUntil = 0;
        const resetLabel = () => ui.text('BTN_RESET', tab === DRIVING ? 'Reset peaks' : tab === PERF ? 'Reset run' : tab === SEATS ? 'Read again' : tab === MVIEW ? 'Reset misfires' : tab === TRIPS ? 'End trip' : 'Original colour');
        ui.onClick('BTN_RESET', () => {
            if (tab === PERF) { perf.resetRun(); return render(); }
            if (tab === SEATS) { seats.again(); seats.poll(); return render(); }
            if (tab === MVIEW) { mview.resetMisfires(); return render(); }
            if (tab === TRIPS) { trips.endNow(); return render(); }
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

        /** The frame rate the tab shown needs (0: as fast as the renderer, the ambient tabs: they draw only while they change). */
        function rateOf() { return tab === DRIVING || tab === PERF ? Number(settings.get('frameRate')) || 30 : tab === SEATS ? 10 : tab === MVIEW ? 5 : tab === TRIPS ? 1 : 0; }
        function setRate() { if (loop && loop.fps) loop.fps(rateOf()); }

        /** The tab at place i of the tab bar (the tabs switched on, then the ambient ones): { id, page }. */
        function at(i) {
            const ids = shownIds();
            return i < ids.length ? { id: ids[i] } : ambOn() ? { id: AMBIENT, page: i - ids.length } : { id: DRIVING };
        }
        /** A tab picked, by id (page: which of the ambient tabs, on the HMI's own bar); one switched off: Driving. */
        function pick(id, page) {
            const was = tab;
            if (!enabled(id) || (id === AMBIENT && !amb)) id = DRIVING;
            tab = id;
            if (tab === AMBIENT && !owned && page !== undefined) amb.select(page);
            if (was === AMBIENT && tab !== AMBIENT) amb.leave();
            if (tab === DRIVING && was !== DRIVING) reads.opened();          // back on Driving: a round at once
            if (tab !== was) { setRate(); railOpen = null; if (owned && !mapped() && tab === AMBIENT && !railShown) { railShown = true; railOpen = 'L'; railT = Date.now(); } log.info('tab ' + (tab === AMBIENT ? AMBIENT_TABS[amb.page] : tabs()[sel()]) + (tab === SEATS ? ' (seats: ' + seats.summary() + '; ' + (seatProbe ? seatProbe.summary() : 'seat functions not asked') + ')' : '')); resetLabel(); }
            return render();
        }
        ctx.onTab((i) => { const a = at(i); return pick(a.id, a.page); });
        // a tab switched on or off (Settings > Tabs): the one shown, switched off, gives way to Driving
        settings.onChange((k) => {
            if ([PERF, SEATS, MVIEW, TRIPS, AMBIENT].every((id) => TAB_KEYS[id] !== k)) return;
            if (k === TAB_KEYS[SEATS]) { if (enabled(SEATS)) probeSeats(); else seats.off(); }
            if (k === TAB_KEYS[AMBIENT]) ambientSwitched();
            log.info('tabs: ' + tabs().join(', '));
            if (!enabled(tab)) pick(DRIVING).catch((e) => log.error('tab', e)); else if (amb) amb.dirty();
        });
        // the frame's place changed (the GPU renderer came after the first frame): the ambient tabs draw again too
        if (ctx.onLayout) ctx.onLayout(() => { if (amb) amb.dirty(); });
        // the ambient tabs: a finger dragged on the colour ring or the brightness dial (kit's onTouch), else a tap
        // the Seats tab: a finger held on an arrow moves that seat motor until it lifts (seats.js touch())
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => (tab === AMBIENT && amb && !onRail(x, y) ? amb.touch(phase, x, y)
            : tab === SEATS && (phase !== 1 || !onRail(x, y)) ? seats.touch(phase, x, y) : false));
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
        // MAP_W: one Driving column and half the gaps beside it (draw.js columns: 370 wide, 24 apart), so no card shows beside a bar
        const RAIL_W = 300, MAP_W = 394, MAP_R_W = 200, RAIL_HIDE_MS = 5000, RAIL_TOP = 50, EDGE = 12;
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
            else if (tab === TRIPS && trips.current) rows.push(['End trip', () => { trips.endNow(); return openRail(null); }, { key: 'trip-end', confirm: true }]);
            return rows;
        }
        const ambRows = (sub) => AMBIENT_TABS.map((n, k) => [n === 'Ambient' ? 'Colour' : n, () => {
            if (tab !== AMBIENT) pick(AMBIENT);
            if (amb.page !== k) { amb.select(k); amb.dirty(); log.info('tab ' + n); }
            return openRail(null);
        }, { key: 'amb-' + k, primary: tab === AMBIENT && amb.page === k, sub }]);
        /** A bar's rows (null: a line between groups). */
        function railRows(side) {
            if (!mapped()) return side !== 'L' ? [] : tab === AMBIENT && ambOn() ? ambRows(false) : actionRows();
            if (side === 'L') {
                const rows = shownIds().map((i) => [TABS[i], () => { pick(i); return openRail(null); }, { key: 'nav-' + i, primary: tab === i }]);
                if (ambOn()) { rows.push(['Ambient', () => { pick(AMBIENT); return openRail(null); }, { key: 'nav-' + AMBIENT, primary: tab === AMBIENT, head: true }]); ambRows(true).forEach((r) => rows.push(r)); }
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
        const onRail = (x, y) => owned && (railOpen === 'L' ? x < barW() + EDGE : railOpen === 'R' ? x > W - (mapped() ? MAP_R_W : barW()) - EDGE
            : (y > 190 && y < 350 && (x < EDGE + 44 || (mapped() && x > W - EDGE - 44))));
        function drawRail(cv, t) {
            // (opened with the controller: open until it is pushed back or a row is pressed)
            if (railOpen && !railByKnob && Date.now() - railT > RAIL_HIDE_MS) { railOpen = null; if (amb && tab === AMBIENT) amb.dirty(); }
            const handle = (side) => {
                if (!railRows(side).length) return;
                // in the margin beside the cards that the kit shows (it trims x < 12 and > 1588: 2.5.0's right one was cut off)
                // map style (2.5.2): nothing drawn, as BMW's map - the controller pushed left / right, or a touch on the edge
                const x = side === 'L' ? EDGE : W - EDGE - 10;
                if (!mapped()) cv.roundRect(x, 210, 10, 120, 5, withAlpha('#ffffff', 0.42));
                // (map style: the controller on it shows a slim chevron at the edge, not a ring round it - the kit's 'hint')
                cv.target(side === 'L' ? EDGE : W - EDGE - 44, 190, 44, 160, () => openRail(side), side === 'L' ? 'rail' : 'rail-r', mapped() ? 'hint' : undefined);
            };
            if (!railOpen) { handle('L'); if (mapped()) handle('R'); return; }
            const side = railOpen, rows = railRows(side), bot = 516 + (cv.extra || 0);         // (down into the room below the page, as the cards)
            if (mapped()) {
                // map style (2.6.9): BMW's own menus as its map draws them (rail.js) - the left one from the screen's edge,
                // the right one a narrow column; the kit shows x 12..1588 of the page, so the panels start at its edges
                const w = side === 'L' ? MAP_W : MAP_R_W, x0 = side === 'L' ? EDGE : W - w - EDGE;
                drawBar(cv, t, { side, x0, top: 34, bot, w, rows, dim: true, redraw: () => render(),
                    run: (r) => { railT = Date.now(); return r[1](); }, close: () => openRail(null) });
                return;
            }
            const bw = barW(), x0 = side === 'L' ? EDGE : W - bw - EDGE;
            // map style: from the page's top (the kit shows y >= 38), over the cards' coloured top lines too
            const top = mapped() ? 38 : RAIL_TOP;
            // the page behind a map-style bar dimmed: the bar is over it, not beside it
            if (mapped()) cv.fillRect(side === 'L' ? x0 + bw : 0, 0, W - bw - EDGE, bot + 4, withAlpha('#000000', 0.45));
            cv.roundRect(x0, top, bw, bot - top, 12, t.bg);
            cv.roundRect(x0, top, bw, bot - top, 12, withAlpha('#ffffff', 0.05));
            cv.strokeRoundRect(x0, top, bw, bot - top, 12, 1.5, withAlpha('#ffffff', 0.18));
            let y = top + 18;
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
            drawn++;
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
            } else if (tab === TRIPS) {
                trips.draw(cv, t);
                G.frame(cv, t, tabs(), sel(), [trips.current && { text: 'RECORDING' }]);
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
        loop = ctx.loop('MAIN', 10, () => (tab !== AMBIENT || amb.wants() || railOpen ? render() : null));
        // how often each tab is drawn (2.6.4: with the GPU renderer every tab was drawn 60 times a second, a still one too,
        // which slowed the head unit): the gauges at the frameRate setting, Seats 10 (its picture follows a move), M View 5
        // (its values change every few seconds); the ambient tabs as fast as the renderer while they change (the colour
        // ring under a finger), else not at all
        setRate();
        settings.onChange((k) => { if (k === 'frameRate') setRate(); });
        // once a minute in the log (the QR log keeps it): the app's CPU share, its memory and the frames it drew
        let cpu0 = process.cpuUsage(), t0 = Date.now(), drawn = 0;
        setInterval(() => {
            const c = process.cpuUsage(cpu0), now = Date.now(), m = process.memoryUsage(), s = (now - t0) / 1000;
            log.info('perf: cpu ' + Math.round((c.user + c.system) / 10 / (now - t0)) + '%, rss ' + Math.round(m.rss / 1048576) + ' MB, heap ' + Math.round(m.heapUsed / 1048576)
                + ' MB, ' + (drawn / s).toFixed(1) + ' frames/s drawn (' + (tab === AMBIENT ? 'Ambient' : TABS[tab]) + ' at ' + (rateOf() || 'renderer') + ')');
            cpu0 = process.cpuUsage(); t0 = now; drawn = 0;
        }, 60000);
        resetLabel();
        log.info('started' + (amb ? '' : enabled(AMBIENT) ? ' (without the ambient light)' : ' (the Ambient tab switched off)') + '; tabs: ' + tabs().join(', '));
    },
});
