'use strict';
/**
 * signals.js - the car's SOME/IP fields this screen shows, as M Vitals subscribes them (apps/car_vitals/main.js
 * `watches`, only the fields used here). app.json "signals" lists the same interfaces.
 *
 *   watches(values, engine, sc, log) -> [[interface, { field: fn(value) }], ...]
 *   sc(key, raw) = raw scaled with app.json config.scaling (null for the car's "no value")
 */
const { selectionOf } = require('./kit/car');

// gearbox enum: names or wire numbers (G1 = 3 ... G10 = 12, R = 1, N_OR_P = 2), as in kit/car.js
const GEARS = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10, R: -1, N_OR_P: 0 };
const gearOf = (x) => (typeof x === 'number' ? (x >= 3 && x <= 12 ? x - 2 : x === 1 ? -1 : x === 2 ? 0 : undefined) : GEARS[x]);
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
// MDrive.dataDisplayGearbox: the programme the cluster shows next to the gear
const PROGRAMS = { S_MINUS_PROGRAMM: 'S', M_MINUS_PROGRAMM: 'M', 1: 'S', 2: 'M' };
// BasicDataSet torque split qualifier: valid (or left out) - M Vitals' SPLIT_OK
const SPLIT_OK = (q) => q === undefined || q === null || q === 2 || q === 10 ||
    q === 'SIGNALWERT_IST_GUELTIG' || q === 'SIGNALWERT_IST_GUELTIG__REKALIBRIERUNGSBEDARF';

/** M Vitals' modeOf(): D / S / M / P / R / N from the gearbox status, whatever the car names its fields. */
function modeOf(o) {
    for (const k of Object.keys(o || {})) {
        if (k === 'statusActualGearDrive' || /StageDrive/.test(k) || !/select|lever|position|program|mode|range|manual|sport|tip/i.test(k)) continue;
        const v = o[k];
        if (v === true || v === 1) { if (/manual|tip/i.test(k)) return 'M'; if (/sport/i.test(k)) return 'S'; continue; }
        const x = String(v).toUpperCase();
        if (/NOT|INACTIVE|INVALID|SIGNAL|UNKNOWN|OFF|NO_/.test(x)) continue;
        if (/MANU|TIPP|^M$|^M_|_M$|^M\d/.test(x)) return 'M';
        if (/SPORT|^S$|_S$|^DS$/.test(x)) return 'S';
        if (/PARK|^P$/.test(x)) return 'P';
        if (/REVERSE|^R$/.test(x)) return 'R';
        if (/NEUTRAL|^N$/.test(x)) return 'N';
        if (/DRIVE|^D$|^D_|_D$/.test(x)) return 'D';
    }
    return null;
}

function watches(values, engine, sc, log) {
    const L = values.live, put = (k, v) => values.put(k, v), seen = {};
    // the first raw values of the doubtful fields go to the log, as M Vitals' logRaw()
    const logRaw = (name, raw) => {
        const key = JSON.stringify(raw), l = seen[name] || (seen[name] = []);
        if (l.length >= 12 || l.indexOf(key) >= 0) return;
        l.push(key); log.info('raw ' + name + ': ' + key);
    };
    return [
        ['de.bmw.infotainment.vehicle.CDS', { statusEngineSpeed2: (v) => put('rpm', sc('rpm', v.actualValueRPMEngineCrankshaft)) }],
        ['de.bmw.infotainment.vehicle.Vehicle2', Object.assign({ statusCarSpeed2: (v) => put('speed', sc('speed', v.speedVehicleCentreOfGravity)) }, engine.handlers())],
        ['de.bmw.infotainment.drivingexcitement.FES', {
            statusSwitchDriveDynamicSport2: (v) => { logRaw('FES boost', v.displayBoostPressure); put('boostFes', sc('boost', v.displayBoostPressure)); },
            // the HMI's sport display: power / torque in % of the car's maximum
            statusVehicleDynamicEngine: (v) => { put('powerPct', sc('sportPct', v.displaySportEnginePower)); put('torquePct', sc('sportPct', v.displaySportEngineTorque)); },
            // negative = engine braking: shown as 0
            statusActualValueTorque2: (v) => { const tq = sc('torque', v.actualValueTorqueCrankshaft); put('torque', tq === null ? null : Math.max(0, tq)); },
        }],
        ['de.bmw.infrastructure.VehicleInformation', {
            statusGearboxDrive: (v) => {
                const g = gearOf(v && v.statusActualGearDrive);
                if (g !== undefined) { L.gear = g; values.lastCar = values.now(); }
                L.stage = STAGES[v && v.statusActualStageDrive];
                L.gearMode = modeOf(v);
            },
            // cars that never send statusGearboxDrive: P / R / N / gear from here
            DataPowerTrain2: (v) => {
                const sel = selectionOf(v && v.statusGearSelectionDrive);
                if (!sel) return;
                if (sel.stage !== undefined) L.stage = sel.stage;
                L.gear = sel.gear; values.lastCar = values.now();
            },
        }],
        ['de.bmw.infrastructure.analytics.BasicDataSet', {
            basicDataSet: (v) => {
                const rawSplit = v.valueDistributionLongitudinalTorqueRearAxisFrontAxis, q = v.qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis;
                logRaw('torque split [value, qualifier]', [rawSplit, q]);
                const split = SPLIT_OK(q) ? sc('torqueSplitRear', rawSplit) : null;
                if (typeof split === 'number' && split > 0) put('splitRear', split);
                if (typeof split === 'number' && split > 1 && split < 97) values.markAwd();     // torque going to the front axle
            },
        }],
        ['de.bmw.infotainment.misc.MDrive', {
            statusMSystem: (v) => {
                L.awd = v.statusAllWheelSetup; L.awdQual = v.qualifierFunctionAllWheel; values.lastCar = values.now();
                if (/^_4WD|SAND/.test(String(L.awd))) values.markAwd();
            },
            dataDisplayGearbox: (v) => { L.program = PROGRAMS[v && v.displayProgramGearbox] || null; },
        }],
    ];
}

module.exports = { watches, modeOf, gearOf };
