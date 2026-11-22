'use strict';
/**
 * seatprobe.js - does the car let Combo listen to BMW's own seat interfaces? Reading only: nothing is sent to them.
 *
 * From the head unit's interface catalog (reference/someip-interfaces.json):
 *   de.bmw.infotainment.misc.SeatFunction (instance 1), what BMW's seat menu talks to:
 *     statusSeatAdjustment            the seat's memory: recall of M1-M3 (AUFRUF_M1 ...), storing, cancelled; the axes moving
 *     statusSeatAdjustmentDR / PS     the driver's / passenger's own switches, the memory buttons 1, 2, 3 and M among them
 *     statusConfigSMFAMode            the car's own settings: entry / exit assistance (easy entry), seat and mirrors after
 *                                     unlocking or opening the door, the memory display
 *     operationSeatMenuDR / PS        the seat menu button
 *     statusRemoteControlSeatAdjustmentDRPS
 *     (its controlSeatAdjustment - MEMORY_1 .. MEMORY_3, the seat module's own recall - is not used: a later version, once
 *     a car's log shows the interface answers)
 *   com.harman...SeatCommandProxyCtrl (instance Inst1): seatProxySeatOperationStatus, the head unit's own seat-motor
 *     proxy (start / alive / stop operation; only its status read here)
 *
 * Each value is logged when it changes (the same value not again), at most LOG_MAX lines; how each interface came up once.
 *
 *   const p = probe(ctx.signals, log)
 *   p.summary()     'SeatFunction available, 3 values; seat proxy not offered' (for the Seats tab's log line)
 */
const SEAT_FUNCTION = 'de.bmw.infotainment.misc.SeatFunction';
const PROXY = 'com.harman.infotainment.systeminfrastructure.seatcommandproxy.seatcommandproxy.SeatCommandProxyCtrl';
const FIELDS = ['statusSeatAdjustment', 'statusSeatAdjustmentDR', 'statusSeatAdjustmentPS', 'statusConfigSMFAMode',
    'operationSeatMenuDR', 'operationSeatMenuPS', 'statusRemoteControlSeatAdjustmentDRPS'];
const LOG_MAX = 80;

function probe(signals, log) {
    const last = {}, state = { fn: null, proxy: null, values: 0 };
    let lines = 0;
    const seen = (name) => (v) => {
        let s;
        try { s = JSON.stringify(v); } catch (e) { s = String(v); }
        if (last[name] === s) return;
        last[name] = s;
        state.values++;
        if (lines < LOG_MAX) { lines++; log.info('seat functions: ' + name + ' ' + (s && s.length > 400 ? s.slice(0, 400) + '...' : s)); }
    };
    const handlers = {};
    FIELDS.forEach((f) => { handlers[f] = seen(f); });
    const up = (what, key) => (res) => {
        state[key] = res;
        log.info('seat functions: ' + what + (res.error ? ' not set up: ' + res.error : ' set up, offered by the car: ' + res.available));
    };
    Promise.resolve().then(() => signals.watch(SEAT_FUNCTION, '1', handlers, log)).then(up('SeatFunction', 'fn'))
        .catch((e) => log.warn('seat functions: SeatFunction: ' + (e && e.message || e)));
    Promise.resolve().then(() => signals.watch(PROXY, 'Inst1', { seatProxySeatOperationStatus: seen('seatProxySeatOperationStatus') }, log)).then(up('seat proxy', 'proxy'))
        .catch((e) => log.warn('seat functions: seat proxy: ' + (e && e.message || e)));
    const one = (res, name) => (!res ? name + ' asking' : res.error ? name + ' not set up' : name + (res.available ? ' available' : ' not offered'));
    return {
        state,
        summary: () => one(state.fn, 'SeatFunction') + ', ' + state.values + ' values; ' + one(state.proxy, 'seat proxy'),
    };
}

module.exports = { probe, SEAT_FUNCTION, PROXY, FIELDS };
