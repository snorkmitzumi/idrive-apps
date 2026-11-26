#!/usr/bin/env node
'use strict';
/*
 * A calibration picture in the in-page box (embed), for the full-screen template test: exactly the box's size, a
 * 12 px border in a colour per edge (top red, bottom green, left blue, right yellow), a white line at y 88 (where
 * BMW's strip ends), a magenta one at y 632 (where the stock box ends), and a faint grid every 100 px with a brighter
 * line every 200. A photo then shows where the HMI puts the box and what of it is cut off.
 *
 * Run as root on the head unit while an in-page app's page is in front (the MGU Store): the box goes to the newest
 * app shown, and root is not held back by the foreground gate. Stops by itself after SECONDS (default 60).
 *   node calib.js [SECONDS]
 */
const path = require('path');
const { RenderClient, imageOp } = require(process.env.MGU_RENDER_CLIENT || '/var/opt/mgu-render/current/mgu_render_client.js');

const SECONDS = Number(process.argv[2]) || 60;
const log = { info: (m) => console.log(m), warn: (m) => console.log('WARN ' + m), error: (m) => console.log('ERROR ' + m), debug() {} };
const C = { bg: 1, grid: 2, grid2: 3, top: 4, bottom: 5, left: 6, right: 7, l88: 8, l632: 9, centre: 10 };
const PAL = { 0: [0, 0, 0], 1: [24, 28, 40], 2: [50, 56, 72], 3: [90, 98, 120], 4: [230, 30, 30], 5: [30, 200, 60], 6: [40, 90, 240], 7: [240, 220, 30], 8: [255, 255, 255], 9: [230, 40, 230], 10: [0, 220, 220] };

function picture(w, h) {
    const px = Buffer.alloc(w * h, C.bg);
    const rect = (x, y, rw, rh, c) => {
        for (let yy = Math.max(0, y); yy < Math.min(h, y + rh); yy++) px.fill(c, yy * w + Math.max(0, x), yy * w + Math.min(w, x + rw));
    };
    for (let x = 0; x < w; x += 100) rect(x, 0, x % 200 ? 1 : 2, h, x % 200 ? C.grid : C.grid2);
    for (let y = 0; y < h; y += 100) rect(0, y, w, y % 200 ? 1 : 2, y % 200 ? C.grid : C.grid2);
    rect(0, 88, w, 3, C.l88);
    rect(0, 632, w, 3, C.l632);
    rect(Math.floor(w / 2) - 40, Math.floor(h / 2) - 40, 80, 80, C.centre);    // the box's centre
    rect(0, 0, w, 12, C.top);
    rect(0, h - 12, w, 12, C.bottom);
    rect(0, 0, 12, h, C.left);
    rect(w - 12, 0, 12, h, C.right);
    return px;
}

const gpu = new RenderClient('calib', log);
let box = null;
gpu.on('ready', (screen, info) => {
    log.info('ready: screen ' + JSON.stringify(screen) + ', modes ' + JSON.stringify(info.modes) + ', embed box ' + JSON.stringify(info.embedBox) + ', app area ' + JSON.stringify(info.appArea));
    if (info.modes.indexOf('embed') < 0) { log.warn('no in-page drawing offered now: open the MGU Store first'); }
    gpu.mode(info.modes.indexOf('embed') >= 0 ? 'embed' : 'layer');
    box = gpu.mode() === 'embed' ? info.embedBox : info.appArea;
    gpu.place({ x: box.x, y: box.y, w: box.w, h: box.h, scale: 1, ox: 0, oy: 0 });
    const pal = Buffer.alloc(768);
    Object.keys(PAL).forEach((k) => PAL[k].forEach((v, j) => { pal[k * 3 + j] = v; }));
    gpu.pixmap(1, box.w, box.h, 'index8', 'nearest');
    gpu.palette(1, pal);
    gpu.pixels(1, [{ x: 0, y: 0, w: box.w, h: box.h }], picture(box.w, box.h));
    gpu.show(true);
    send();
    log.info('drawing ' + box.w + 'x' + box.h + ' at ' + box.x + ',' + box.y + ' (' + gpu.mode() + ') for ' + SECONDS + ' s');
});
gpu.on('state', (s) => log.info('state ' + JSON.stringify(s)));
const send = () => { if (box) gpu.frameWords(imageOp(1, 0, 0, box.w, box.h, 0)); };
gpu.on('tick', send);
setInterval(send, 500);              // at least a frame a second: a quiet app is hidden after 3 s
gpu.connect();
setTimeout(() => { log.info('done'); gpu.close(); process.exit(0); }, SECONDS * 1000);
