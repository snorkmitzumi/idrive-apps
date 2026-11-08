'use strict';
/**
 * Combo - one screen with the values that are spread over M Vitals and eDrive: engine speed and boost, speed / power /
 * torque, xDrive, and the 48 V and 12 V batteries, in M Vitals' look (design: docs/superpowers/specs/2026-11-08-combo-
 * screen-design.md). Reading only: car signals over SOME/IP, the rest over the kit's read-only diagnostic link.
 *
 * Demo data is all or nothing: on with the setting "Always", or (Auto) while no car signal arrived for 5 s. Once the
 * car is there everything shown is the car's; what it doesn't give (yet) shows "--" with the reason.
 */
const mgu = require('./kit/mgu');
const Engine = require('./kit/engine');
const draw = require('./draw');
const Demo = require('./demo');
const { Values, PEAKS } = require('./values');
const { watches } = require('./signals');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');
const { Reads } = require('./reads');

const W = 1600, H = 520;

mgu.run({
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
        watches(values, engine, sc, log).forEach(([iface, h]) => {
            ctx.signals.watch(iface, '1', h, log).then((s) => {
                values.subs.push(s);
                log.info('signal ' + iface.split('.').pop() + (s.error ? ' error: ' + s.error : ' subscribed'));
            });
        });

        // the diagnostic link: reading only, connected in the background (the screen must not wait for it)
        const link = new ReadOnlyDiag(ctx.signals, log);
        link.init().catch((e) => log.warn('diagnostic link: ' + e));
        const reads = new Reads({ link, reader: new DidReader(link), values, settings, cfg, ui, log, dataDir: ctx.dataDir, active: () => !usingDemo() });
        // shown again (another app was on screen): a round at once
        ui.onVisible((name, v) => { if (name === 'MAIN' && v) reads.opened(); });

        const demo = new Demo();
        demo.setRedline(engine.redline());
        if (engine.onChange) engine.onChange(() => demo.setRedline(engine.redline()));
        // the demo keeps its own peaks, so they never mix with the car's (M Vitals' demoPeak)
        const demoPeaks = new Values({ settings, log });
        const usingDemo = () => settings.get('demo') === 'on'
            || (settings.get('demo') === 'auto' && !values.carPresent() && Date.now() - startT > 5000);
        reads.start();

        /** What draw.render() shows, from the demo or from the car (one shape for both). */
        function data() {
            if (usingDemo()) {
                const s = demo.sample();
                return { demo: true, rpm: s.rpm, boost: s.boost, boostTarget: s.boostTarget, speed: s.speed, gear: s.gear, gearMode: s.gearMode, stage: 'D',
                    power: { kw: s.powerPct / 100 * settings.get('maxPower'), calc: false }, torque: s.torque,
                    split: { rear: s.splitRear, from: null, nm: s.lmvFront }, awd: s.awd, awdQual: s.awdQual, b48: s.b48, b12: s.b12 };
            }
            const L = values.live, bat = reads.fresh();
            return { demo: false, rpm: L.rpm, boost: values.boost().value, boostTarget: L.boostTarget, speed: L.speed,
                gear: L.gear !== undefined ? L.gear : L.gearGuess, gearMode: L.gearMode || L.program || null, stage: L.stage,
                power: values.power(), torque: L.torque, split: values.split(), awd: L.awd, awdQual: L.awdQual, b48: bat.b48, b12: bat.b12, has48: bat.has48 };
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), d = data();
            // peaks raised every frame too, so a held peak drops back while the car sends nothing new (M Vitals)
            const pk = d.demo ? demoPeaks : values, now = { rpm: d.rpm, boost: d.boost, power: d.power.kw, torque: d.torque, lmvFront: d.split.nm };
            PEAKS.forEach((k) => pk.raise(k, now[k]));
            if (!d.demo) reads.shown();          // (a frame of the car's values after the demo: a round at once)
            draw.render(cv, t, d, { settings, peak: (k) => pk.peak(k), why: (k) => reads.why(k), redline: engine.redline(), scaleMax: engine.scaleMax(), has48: d.has48 });
            await ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 10, render);
        log.info('started');
    },
});
