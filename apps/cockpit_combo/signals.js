'use strict';
/**
 * signals.js - the car's SOME/IP fields this screen shows, as M Vitals subscribes them (apps/car_vitals/main.js
 * `watches`, only the fields used here). app.json "signals" lists the same interfaces.
 *
 *   watches(values, engine, sc, log) -> [[interface, { field: fn(value) }], ...]
 *   sc(key, raw) = raw scaled with app.json config.scaling (null for the car's "no value")
 */
const { selectionOf, conditionOf } = require('./kit/car');

// gearbox enum: names or wire numbers (G1 = 3 ... G10 = 12, R = 1, N_OR_P = 2), as in kit/car.js
const GEARS = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10, R: -1, N_OR_P: 0 };
const gearOf = (x) => (typeof x === 'number' ? (x >= 3 && x <= 12 ? x - 2 : x === 1 ? -1 : x === 2 ? 0 : undefined) : GEARS[x]);
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
// MDrive.dataDisplayGearbox: the programme the cluster shows next to the gear
const PROGRAMS = { S_MINUS_PROGRAMM: 'S', M_MINUS_PROGRAMM: 'M', 1: 'S', 2: 'M' };
// BasicDataSet torque split qualifier: valid (or left out) - M Vitals' SPLIT_OK
/*
 * The tyres (M Vitals' tyreP / tyreT): the TPMS sends pressures as 0.1 x raw in the car's own pressure unit and
 * temperatures as the car's degrees + 40 (Vehicle.statusNewCurrentUnitsStatusExt says which). Until the unit is known,
 * each unit's plausible tyre pressures lie apart (bar 0.5-6, psi 7-60, kPa 60-600), so only one fits; psi means deg F.
 */
const PRESS_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI' }, TEMP_UNITS = { 1: 'C', 2: 'F' };
const PRESS_TO_BAR = { BAR: 1, KPA: 0.01, PSI: 1 / 14.5038 };
const TYRES = ['FL', 'FR', 'RL', 'RR'], TYRE_P = [0.5, 6], TYRE_T = [-40, 150];
const unitName = (map, v) => (map[v] || (Object.keys(map).map((k) => map[k]).indexOf(v) >= 0 ? v : null));
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

/** Every object in v (however deeply wrapped) that has key (eDrive's entries()). */
function entries(v, key, out) {
    out = out || [];
    if (v && typeof v === 'object') {
        if (key in v) out.push(v);
        else Object.keys(v).forEach((k) => entries(v[k], key, out));
    }
    return out;
}

function watches(values, engine, sc, log) {
    // the car locked and left (its own state: parked or standby, nobody in it, 1-3) or in use again
    const leftFrom = (v) => {
        const n = conditionOf(v && v.statusConditionVehicle);
        if (n !== undefined) L.condition = n;            // (the trip book: a trip is a drive cycle, trips.js)
        if (n === undefined || L.left === (n <= 3)) return;
        L.left = n <= 3;
        log.info(L.left ? 'the car is locked and left: no reads, so it can sleep' : 'the car is in use again');
    };
    const L = values.live, put = (k, v) => values.put(k, v), seen = {};
    // the M View tab's temperatures from the car (deg C), with the time they came (mview.js: older = read instead)
    const temp = (k, v) => { if (v === null || v === undefined) return; put(k, v); L[k + 'T'] = values.now(); };
    // the engine's temperatures: CDS and DataPowerTrain2 carry the same two (whichever the car sends)
    const engineTemps = (v) => { temp('coolant', sc('engineTemp', v && v.temperatureEngineDrive)); temp('oil', sc('engineTemp', v && v.temperatureEngineOilDrive)); };
    // the first raw values of the doubtful fields go to the log, as M Vitals' logRaw()
    const logRaw = (name, raw) => {
        const key = JSON.stringify(raw), l = seen[name] || (seen[name] = []);
        if (l.length >= 12 || l.indexOf(key) >= 0) return;
        l.push(key); log.info('raw ' + name + ': ' + key);
    };
    const carUnits = { press: null, temp: null, psiSeen: false };
    const tyreP = (raw) => {
        const v = sc('tyrePress', raw);
        if (v === null) return null;
        const k = PRESS_TO_BAR[carUnits.press];
        const bar = k ? v * k : v >= TYRE_P[0] && v <= TYRE_P[1] ? v : v >= 7 && v < 60 ? (carUnits.psiSeen = true, v / 14.5038) : v >= 60 && v <= 600 ? v / 100 : null;
        return bar !== null && bar >= TYRE_P[0] && bar <= TYRE_P[1] ? bar : null;
    };
    const tyreT = (raw) => {
        // deg F only on an imperial car (deg F and psi): a G26 in bar / deg C said deg F in its units (2.4.1), but its
        // TPMS sent deg C + 40 (raw 48 = 8 deg C, as the car's own tyre page showed): read as deg F it came out at -13
        const psi = carUnits.press ? carUnits.press === 'PSI' : carUnits.psiSeen;
        const v = sc('tyreTemp', raw), f = psi && (carUnits.temp ? carUnits.temp === 'F' : true);
        const c = v !== null && f ? (v - 32) * 5 / 9 : v;
        return c !== null && c >= TYRE_T[0] && c <= TYRE_T[1] ? c : null;
    };
    // each tyre's { p (bar), t (deg C), pt (the car's target, bar) } and when it came (L.tyresT)
    const tyre = (field, of, v, f) => {
        const ty = L.tyres || (L.tyres = {});
        TYRES.forEach((w) => { const x = f(v && v[of(w)]); (ty[w] || (ty[w] = {}))[field] = x; });
        L.tyresT = values.now();
    };
    return [
        ['de.bmw.infotainment.vehicle.Vehicle', {
            statusNewCurrentUnitsStatusExt: (v) => {
                const press = unitName(PRESS_UNITS, v && v.unitOfMeasurementAirPressure), temp = unitName(TEMP_UNITS, v && v.unitOfMeasurementTemperature);
                logRaw('units', [v && v.unitOfMeasurementAirPressure, v && v.unitOfMeasurementTemperature]);
                if (press === carUnits.press && temp === carUnits.temp) return;
                carUnits.press = press; carUnits.temp = temp;
                log.info('car units: pressure ' + (press || '?') + ', temperature ' + (temp || '?'));
            },
        }],
        ['de.bmw.infotainment.vehicle.TPMS', {
            statusTyrePressure: (v) => { logRaw('tyre pressure', TYRES.map((w) => v && v['actualValuePressureTyre' + w + 'H'])); tyre('p', (w) => 'actualValuePressureTyre' + w + 'H', v, tyreP); },
            statusTyreTemperature: (v) => { logRaw('tyre temperature', TYRES.map((w) => v && v['actualValueTemperatureTyre' + w + 'H'])); tyre('t', (w) => 'actualValueTemperatureTyre' + w + 'H', v, tyreT); },
            statusTargetTyrePressure: (v) => tyre('pt', (w) => 'targetPressureTyre' + w + 'H', v, tyreP),
        }],
        ['de.bmw.infotainment.vehicle.CDS', {
            statusEngineSpeed2: (v) => put('rpm', sc('rpm', v.actualValueRPMEngineCrankshaft)),
            statusEngineTemperature: (v) => { logRaw('engine temperatures [coolant, oil]', [v && v.temperatureEngineDrive, v && v.temperatureEngineOilDrive]); engineTemps(v); },
        }],
        // the Performance tab: the dyno's acceleration, in g (Virtual Dyno's and Drag Timer's)
        ['de.bmw.infotainment.vehicle.CDS2', { statusLongitudinalAccelerationMassCenter: (v) => {
            const a = sc('accel', v.longitudinalAccelerationCentreOfGravity);
            if (a !== null) put('gLong', a / 9.80665);
        } }],
        ['de.bmw.infotainment.vehicle.Vehicle2', Object.assign({
            statusCarSpeed2: (v) => put('speed', sc('speed', v.speedVehicleCentreOfGravity)),
        }, engine.handlers())],
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
                engineTemps(v);
                const sel = selectionOf(v && v.statusGearSelectionDrive);
                if (!sel) return;
                if (sel.stage !== undefined) L.stage = sel.stage;
                L.gear = sel.gear; values.lastCar = values.now();
            },
        }],
        ['de.bmw.infrastructure.analytics.BasicDataSet', {
            basicDataSet: (v) => {
                logRaw('gearbox oil', v.valueTemperatureTransmissionOil);
                temp('gearbox', sc('gearboxTemp', v.valueTemperatureTransmissionOil));
                const rawSplit = v.valueDistributionLongitudinalTorqueRearAxisFrontAxis, q = v.qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis;
                logRaw('torque split [value, qualifier]', [rawSplit, q]);
                // valid qualifier, not the car's "no value" (0, 65535) and a real share (Engine Config's xdrive_live.js split())
                const split0 = SPLIT_OK(q) && rawSplit !== 0 ? sc('torqueSplitRear', rawSplit) : null;
                const split = typeof split0 === 'number' && split0 >= 0 && split0 <= 100 ? split0 : null;
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
        // the car locked and left (its own state: parked or standby, nobody in it, 1-3): nothing is read, so it can sleep
        // (eDrive 2.9.1); a state this table doesn't know (15: no value) changes nothing
        // (from either of the car's two copies: some cars send only the one without a CRC, Ambient config 2.6.2)
        ['de.bmw.infrastructure.VehicleCondition', {
            VehicleCondition: (v) => leftFrom(v),
            vehicleConditionNoCrc: (v) => leftFrom(v),
        }],
        // the cluster's eDRIVE needle (eDrive's fast power on plug-in hybrids): only logged once, to see whether a mild
        // hybrid sends it at all - if it does, the 48 V power could follow it as fast (apps/edrive/fastkw.js)
        ['de.bmw.infotainment.drivingexcitement.Efficiencytainment2', {
            statusPowerRelativHybrid: (v) => {
                const e = entries(v, 'displayActualValuePowerRelativeDrivingElectric')[0];
                if (!e || L.needleSeen) return;
                L.needleSeen = true;
                log.info('eDRIVE needle: drive ' + e.displayActualValuePowerRelativeDrivingElectric + ', regen ' + e.displayActualValuePowerRelativeRecuperation);
            },
        }],
        // the four wheels' speeds: wheel slip, front axle against rear (Engine Config's xdrive_live.js wheels())
        ['de.bmw.powertrain.Powertrain', {
            ActualValueRPMWheel: (v) => {
                if (!v) return;
                const ok = (x) => typeof x === 'number' && x < 65534;
                const w = { FL: v.actualValueRPMWheelFLH, FR: v.actualValueRPMwheelFRH, RL: v.actualValueRPMWheelRLH, RR: v.actualValueRPMWheelRRH };
                if (Object.keys(w).every((k) => ok(w[k]))) values.wheels(w);
            },
        }],
    ];
}

module.exports = { watches, modeOf, gearOf, TYRES };
