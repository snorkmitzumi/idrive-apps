'use strict';
/**
 * Demo values for every field the screen shows (setting "Demo data"; Auto: only while no car signal arrived).
 * A 24 s lap of pulls and lifts, like M Vitals' demo, plus the transfer case and both batteries.
 */
class Demo {
    constructor() { this.t0 = Date.now(); this.red = 7000; }
    /** The redline the pulls rev to (7000 = the petrol drive). */
    setRedline(rpm) { this.red = rpm; }
    sample() {
        const t = (Date.now() - this.t0) / 1000, cyc = t % 24;
        const pull = cyc < 9 ? cyc / 9 : cyc < 12 ? 1 - (cyc - 9) / 3 : 0.25 + 0.15 * Math.sin(cyc);
        const gear = Math.floor((cyc < 9 ? cyc : 9) / 2.2) % 4;
        const rpm = 1500 + ((pull * 4 + gear * 0.7) % 1) * (this.red - 1400) * Math.max(0.4, pull);
        const torque = Math.round(120 + pull * 380);
        const lift = cyc >= 9 && cyc < 12;                       // lifting off: the 48 V battery takes the braking energy
        const a48 = lift ? 28 + 6 * Math.sin(t * 3) : -6 - 22 * pull;
        return {
            rpm, speed: 40 + pull * 160 + 10 * Math.sin(t / 5), gear: gear + 1, gearMode: pull > 0.9 ? 'S' : 'D',
            boost: Math.max(0, pull * 1.7 - 0.15 + 0.05 * Math.sin(t * 3)), boostTarget: Math.max(0, pull * 1.75 - 0.1),
            powerPct: Math.round(pull * 100), torque, powerCalc: torque * rpm / 9549,
            splitRear: 62 + 25 * pull, awd: pull > 0.9 ? '_4WD_ALTERNATIV' : '_4WD_STANDARD', awdQual: 'FUNKTION_VERFUEGBAR_AKTIV',
            slip: pull > 0.8 ? 1.5 * Math.sin(t * 2) : 0.2 * Math.sin(t),     // front axle against rear, %
            lmvFront: Math.round(40 + 380 * pull * (1 - (62 + 25 * pull) / 100) * 2),
            b48: { soc: 66 + 4 * Math.sin(t / 40), v: 47.4 + a48 * 0.02, a: a48, kw: (47.4 + a48 * 0.02) * a48 / 1000, soh: 96, temp: 24 + 2 * Math.sin(t / 200) },
            b12: { soc: 84, v: lift ? 14.6 : 14.1, a: lift ? 18 : 1.6, soh: 92, temp: 19 },
        };
    }
}
module.exports = Demo;
