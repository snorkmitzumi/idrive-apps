'use strict';
/**
 * modes_tab.js - where the Driving modes tab puts its rows: two columns of compact rows (up to five each, column by
 * column), so every driving mode this car has (Ambient's modes(), at most MAX_SHOWN) shows at once, above the
 * tab's toggles.
 *
 *   rows(modes) -> [{ m, x, y, w, h }]
 */
const { MAX_SHOWN } = require('./ambient');

const LEFT = 40, RIGHT = 1560, GAP = 24, TOP = 92, ROW_H = 62, STEP = 66, PER_COLUMN = 5;
const COL_W = (RIGHT - LEFT - GAP) / 2;

function rows(modes) {
    return (modes || []).slice(0, MAX_SHOWN).map((m, i) => ({
        m, x: LEFT + Math.floor(i / PER_COLUMN) * (COL_W + GAP), y: TOP + (i % PER_COLUMN) * STEP, w: COL_W, h: ROW_H,
    }));
}

module.exports = { rows, COL_W, ROW_H };
