'use strict';
/**
 * rail.js - Combo's side bars in map style, drawn as BMW's own map draws its menus (2.6.9, from a G26's map):
 *   left   a panel from the screen's edge, the whole height: one row a page, its icon and name, thin lines between
 *          rows; the page shown filled orange-red with a brighter line under it; the ambient pages as smaller rows
 *   right  a narrow column: each action's icon over its name
 * No Hide row (BMW's map has none): a touch on the dimmed page, or the controller pushed back, closes a bar.
 *
 *   drawBar(cv, t, { side, x0, top, bot, w, rows, run, close, dim })
 *     rows: [label, run, { key, primary, sub, head, confirm }] or null (a gap); run(row) presses one
 */
const { withAlpha } = require('./kit/canvas');

// BMW's selection: orange to red, a brighter line under it (as its map's menu)
const SEL_A = '#e2531e', SEL_B = '#b9261d', SEL_LINE = '#ff4a2e';
const CONFIRM_MS = 5000;
const armed = {};

/** A small line icon for a row, by its key. */
function icon(cv, key, cx, cy, s, c) {
    const lw = Math.max(1.5, s * 0.09);
    const ring = (r, a0, a1) => cv.arc(cx, cy, r - lw, r, a0, a1, c);
    if (/^nav-0$/.test(key)) {                                   // Driving: a gauge and its needle
        ring(s * 0.5, 225, 495);
        cv.line(cx, cy, cx + s * 0.28, cy - s * 0.22, lw * 1.2, c);
        cv.circle(cx, cy, lw * 1.2, c);
    } else if (/^nav-1$|perf-run/.test(key)) {                   // Performance: a stopwatch
        ring(s * 0.42, 0, 360);
        cv.fillRect(cx - s * 0.08, cy - s * 0.62, s * 0.16, s * 0.12, c);
        cv.line(cx, cy, cx, cy - s * 0.24, lw * 1.2, c);
    } else if (/^nav-2$|seats-again/.test(key)) {                // Seats: a seat from the side (cushion, backrest, headrest)
        cv.fill([[cx - s * 0.46, cy + s * 0.06], [cx + s * 0.16, cy + s * 0.1], [cx + s * 0.2, cy + s * 0.3], [cx - s * 0.42, cy + s * 0.28]], c);
        cv.fill([[cx + s * 0.04, cy + s * 0.12], [cx + s * 0.14, cy - s * 0.34], [cx + s * 0.32, cy - s * 0.3], [cx + s * 0.24, cy + s * 0.18]], c);
        cv.fill([[cx + s * 0.16, cy - s * 0.44], [cx + s * 0.18, cy - s * 0.56], [cx + s * 0.36, cy - s * 0.52], [cx + s * 0.33, cy - s * 0.4]], c);
    } else if (/^nav-3$|misfires/.test(key)) {                   // M View: an M
        cv.text('M', cx, cy + s * 0.3, s * 0.9, c, { align: 'center', font: 'bold' });
    } else if (/^nav-4$/.test(key)) {                            // Ambient: a light with its rays
        cv.circle(cx, cy, s * 0.2, c);
        for (let k = 0; k < 8; k++) {
            const a = k * Math.PI / 4, r0 = s * 0.32, r1 = s * 0.48;
            cv.line(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, lw, c);
        }
    } else if (/^amb-0$/.test(key)) {                            // Colour: a ring
        ring(s * 0.42, 0, 360); cv.circle(cx, cy, s * 0.16, c);
    } else if (/^amb-1$/.test(key)) {                            // Animations: a wave
        const pts = [];
        for (let k = 0; k <= 16; k++) pts.push([cx - s * 0.48 + k * s * 0.06, cy + Math.sin(k / 16 * Math.PI * 2) * s * 0.26]);
        cv.polyline(pts, lw * 1.3, c);
    } else if (/^amb-2$/.test(key)) {                            // Modes: sliders
        [-0.24, 0, 0.24].forEach((dy, k) => {
            cv.line(cx - s * 0.42, cy + dy * s, cx + s * 0.42, cy + dy * s, lw, c);
            cv.circle(cx + [-0.2, 0.18, -0.05][k] * s, cy + dy * s, s * 0.08, c);
        });
    } else if (/settings/.test(key)) {                           // Settings: a gear
        ring(s * 0.3, 0, 360);
        for (let k = 0; k < 8; k++) {
            const a = k * Math.PI / 4;
            cv.line(cx + Math.cos(a) * s * 0.3, cy + Math.sin(a) * s * 0.3, cx + Math.cos(a) * s * 0.46, cy + Math.sin(a) * s * 0.46, lw * 1.6, c);
        }
    } else if (/peaks/.test(key)) {                              // Reset peaks: a circular arrow
        ring(s * 0.4, 40, 330);
        cv.fill([[cx + s * 0.3, cy - s * 0.42], [cx + s * 0.44, cy - s * 0.16], [cx + s * 0.16, cy - s * 0.18]], c);
    } else {
        cv.circle(cx, cy, s * 0.14, c);
    }
}

/** A row's own confirm (a reset): the first press asks, a second within CONFIRM_MS runs it. */
function press(row, run, redraw) {
    const o = row[2] || {};
    if (!o.confirm) return run(row);
    const k = o.key || row[0];
    if (armed[k] && Date.now() - armed[k] < CONFIRM_MS) { delete armed[k]; return run(row); }
    armed[k] = Date.now();
    if (redraw) setTimeout(redraw, CONFIRM_MS + 50);
    return null;
}
const isArmed = (row) => { const o = row[2] || {}, k = o.key || row[0]; return !!(o.confirm && armed[k] && Date.now() - armed[k] < CONFIRM_MS); };

function drawBar(cv, t, o) {
    const { side, x0, top, bot, w } = o;
    // the page behind dimmed; a touch on it closes the bar
    if (o.dim) cv.fillRect(side === 'L' ? x0 + w : 0, 0, side === 'L' ? cv.w - x0 - w : x0, bot + 4, withAlpha('#000000', 0.45));
    // the panel: BMW's grey, a light edge where it meets the page
    cv.gradientRect(x0, top, w, bot - top, [[0, '#4a4a4f'], [1, '#2c2c30']]);
    cv.fillRect(x0, top, w, 2, withAlpha('#ffffff', 0.28));
    cv.fillRect(side === 'L' ? x0 + w - 1.5 : x0, top, 1.5, bot - top, withAlpha('#ffffff', 0.2));
    const rows = o.rows.filter(Boolean);
    if (side === 'L') {
        // one row a page: its icon and name, a thin line under each; the ambient pages smaller, set in
        const main = rows.filter((r) => !r[2].sub).length, subs = rows.length - main;
        const room = bot - top - 4, mh = Math.min(66, Math.floor(room / (main + subs * 0.72))), sh = Math.floor(mh * 0.72);
        let y = top + 2;
        rows.forEach((r) => {
            const sub = !!r[2].sub, h = sub ? sh : mh, sel = r[2].primary && !r[2].head, ask = isArmed(r);
            if (sel || ask) {
                cv.gradientRect(x0, y, w - 1.5, h, [[0, withAlpha(ask ? t.crit || SEL_B : SEL_A, 0.96)], [1, withAlpha(SEL_B, 0.96)]]);
                cv.fillRect(x0, y + h - 3, w - 1.5, 3, SEL_LINE);
            } else cv.fillRect(x0 + (sub ? 64 : 16), y + h - 1, w - (sub ? 80 : 32), 1, withAlpha('#ffffff', 0.13));
            const ix = x0 + (sub ? 70 : 36), is = sub ? 22 : 30, tc = sel || ask ? '#ffffff' : withAlpha('#ffffff', 0.92);
            icon(cv, r[2].key || '', ix, y + h / 2, is, tc);
            cv.text(ask ? 'Press again to confirm' : r[0], x0 + (sub ? 98 : 72), y + h / 2 + (sub ? 7 : 9), sub ? 19 : 25, tc);
            cv.target(x0, y, w, h, () => press(r, o.run, o.redraw), r[2].key || r[0], 0);
            y += h;
        });
    } else {
        // a narrow column: each action's icon over its name (two lines at most)
        let y = top + 10;
        const h = 92;
        rows.forEach((r) => {
            const ask = isArmed(r);
            if (ask) { cv.gradientRect(x0, y, w - 1.5, h, [[0, withAlpha(t.crit || SEL_B, 0.96)], [1, withAlpha(SEL_B, 0.96)]]); cv.fillRect(x0, y + h - 3, w, 3, SEL_LINE); }
            icon(cv, r[2].key || '', x0 + w / 2, y + 32, 30, '#ffffff');
            const words = String(ask ? 'Press again' : r[0]).split(' '), lines = [''];
            words.forEach((wd) => { const l = lines[lines.length - 1], n = l ? l + ' ' + wd : wd; if (cv.textWidth(n, 16) > w - 16 && l) lines.push(wd); else lines[lines.length - 1] = n; });
            lines.slice(0, 2).forEach((l, k) => cv.text(l, x0 + w / 2, y + 66 + k * 18, 16, withAlpha('#ffffff', 0.92), { align: 'center' }));
            cv.target(x0, y, w, h, () => press(r, o.run, o.redraw), r[2].key || r[0], 0);
            y += h + 6;
        });
    }
    if (o.close) cv.target(side === 'L' ? x0 + w : 0, top, side === 'L' ? cv.w - x0 - w : x0, bot - top, o.close, side === 'L' ? 'rail-close' : 'rail-r-close', 0);
}

module.exports = { drawBar, icon };
