'use strict';
/**
 * oldcombo.js - is the old Combo (this app before 2.8.0, installed under the id "combo") still running beside Cockpit?
 *
 * For the head unit, Cockpit (cockpit_combo) is another app: updating installs it next to the old Combo, which stays
 * installed and starts with the car too. Two apps answering one door would send the same seat its motor commands at
 * once, so while the old one runs, Cockpit's easy entry leaves the seats to it (seats.js blocked()).
 *
 * The old Combo's ambient light keeps a claim on the lights in /dev/shm while it runs (owner.js: its process id, the
 * file readable by every app): a claim whose process is alive is the old Combo running. An old Combo with its Ambient
 * tab switched off writes none, so it is not seen (the README says: uninstall Combo first).
 *
 *   const old = oldCombo({ dir, now })     old.running() -> true / false, looked at again at most every CHECK_MS
 */
const fs = require('fs');
const path = require('path');
const { alive, DIR } = require('./owner');

const FILE = 'mgu-ambient-owner.combo.json', CHECK_MS = 10000;

function oldCombo(o) {
    o = o || {};
    const file = path.join(o.dir || DIR, FILE), now = o.now || Date.now;
    let at = -Infinity, seen = false;
    return {
        running() {
            if (now() - at < CHECK_MS) return seen;
            at = now();
            let c = null;
            try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { c = null; }
            const was = seen;
            seen = !!(c && c.pid !== process.pid && alive(c.pid));
            if (seen !== was && o.log) {
                if (seen) o.log.warn('the old Combo app is running: Cockpit leaves easy entry to it (uninstall Combo)');
                else o.log.info('the old Combo app is no longer running: easy entry is Cockpit\'s again');
            }
            return seen;
        },
    };
}

module.exports = { oldCombo, FILE };
