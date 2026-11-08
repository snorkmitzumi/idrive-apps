'use strict';
/**
 * draw.js - the Combo screen: four columns of the same size, in M Vitals' look (kit/runtime/gauges.js).
 *
 *   1  Engine speed over Boost      2  Speed / Power / Torque      3  xDrive      4  48 V battery over 12 V battery
 *
 *   columns() -> [{ x, y, w, h }] x 4;   render(cv, t, d, opts)
 */
const G = require('./kit/gauges');

const LEFT = 24, RIGHT = 1576, GAP = 24, HALF_GAP = 16;
const COL_W = (RIGHT - LEFT - 3 * GAP) / 4;           // 370

/** The four columns, left to right: same width and height. */
function columns() {
    const out = [];
    for (let i = 0; i < 4; i++) out.push({ x: LEFT + i * (COL_W + GAP), y: G.TOP, w: COL_W, h: G.BOTTOM - G.TOP });
    return out;
}
/** A column cut into a top and a bottom panel (16 px apart), as M Vitals' Engine speed over Boost. */
function halves(c) {
    const h = (c.h - HALF_GAP) / 2;
    return [{ x: c.x, y: c.y, w: c.w, h }, { x: c.x, y: c.y + h + HALF_GAP, w: c.w, h }];
}

function render(cv, t, d, opts) {
    G.frame(cv, t, [], 0, [d && d.demo && { text: 'DEMO' }]);
    const [c1, c2, c3, c4] = columns(), [rpmBox, boostBox] = halves(c1), [b48Box, b12Box] = halves(c4);
    G.panel(cv, t, rpmBox.x, rpmBox.y, rpmBox.w, rpmBox.h, 'Engine speed');
    G.panel(cv, t, boostBox.x, boostBox.y, boostBox.w, boostBox.h, 'Boost');
    G.panel(cv, t, c2.x, c2.y, c2.w, c2.h, 'Speed');
    G.panel(cv, t, c3.x, c3.y, c3.w, c3.h, 'xDrive');
    G.panel(cv, t, b48Box.x, b48Box.y, b48Box.w, b48Box.h, '48 V battery');
    G.panel(cv, t, b12Box.x, b12Box.y, b12Box.w, b12Box.h, '12 V battery');
}

module.exports = { columns, halves, render, COL_W };
