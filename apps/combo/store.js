'use strict';
/**
 * store.js - this app's small state files (awd.json, seen.json, battery.json), written whole or not at all: a temp
 * file renamed over the old one, so a reader or a power cut never sees half a file (as kit/runtime/engine.js does
 * since upstream's writeWhole).
 *
 *   writeWhole(file, text)
 */
const fs = require('fs');

function writeWhole(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

module.exports = { writeWhole };
