'use strict';
/**
 * Combo - one screen with the values that are spread over M Vitals and eDrive: engine speed and boost, speed / power /
 * torque, xDrive, and the 48 V and 12 V batteries, in M Vitals' look (design: docs/superpowers/specs/2026-11-08-combo-
 * screen-design.md). Reading only: car signals over SOME/IP, the rest over the kit's read-only diagnostic link.
 */
const mgu = require('./kit/mgu');
const draw = require('./draw');
const Demo = require('./demo');

const W = 1600, H = 520;

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const demo = new Demo();
        const usingDemo = () => settings.get('demo') !== 'off';
        const data = () => Object.assign(demo.sample(), { demo: usingDemo() });

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            draw.render(cv, t, data(), { settings });
            await ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 10, render);
        log.info('started');
    },
});
