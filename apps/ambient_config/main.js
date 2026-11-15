'use strict';
/**
 * Ambient config - any colour on the car's ambient light, animations, and a look for each driving mode.
 * The service and the tabs are in ambient_page.js (Combo hosts the same tabs, without the Strobe); this file puts
 * them on the app's own screen: the tab bar, taps, and a frame whenever a tab moves or changed.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { background, mount } = require('./ambient_page');

const W = 1600, H = 520;

mgu.run({
    background,
    async start(ctx) {
        const { ui, log } = ctx;
        const parts = ctx.background || await background(ctx);
        const page = mount(ctx, parts, { strobe: true, redraw: () => render() });

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            page.draw(cv, t);
            G.frame(cv, t, page.tabs(), page.page, []);
            await ui.image('MAIN_GFX', cv);
        }
        if (ctx.onTap) ctx.onTap((x, y) => page.tap(x, y));
        ctx.onTab((i) => { page.select(i); return render(); });
        // the frame's place changed (the GPU renderer came after the first frame, the layout setting): draw it again,
        // as the tabs draw only when they move or changed
        if (ctx.onLayout) ctx.onLayout(() => page.dirty());
        ctx.loop('MAIN', 8, () => (page.wants() ? render() : null));
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
