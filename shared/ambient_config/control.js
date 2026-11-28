'use strict';
/**
 * control.js - which colour is on: the driver's own look (Colour and Animations tabs), a driving mode's look,
 * or the car's own colour.
 *
 *   look      the driver's look: { kind, upper: { rgb, bright }, lower: { rgb, bright }, speed }
 *   on        the look is on (false: the car's own colour)
 *   mode_<m>  a driving mode's look, 'original' (BMW's original colour in that mode), or null (nothing picked:
 *             the driver's look, or the car's)
 *   favs      up to six saved looks
 * Settings: follow (looks by driving mode), welcome (a sweep at each start), sportPulse (red for 1.5 s when
 * Sport is picked), nightDim (half the brightness at night), keep (the look back at each start), flashAlerts
 * (Redline's shift flash and other apps', from the file FLASH_FILE: { rgb, ms } written whole).
 * The car locked and left (parked or standby, nobody in it: away(true)): every light back to the car's own and nothing
 * renewed; someone back in (living, ignition, driving): the look again, with the welcome sweep when it is on.
 * Over the look (or the car's own colour), with their settings switched on (both off by default): turn(side) - while a turn signal is on, that side's
 * front door line sweeps green front to back like a car's dynamic indicator, then goes dark (sweep(); setting turnGlow; hazards: both sides; not with
 * the car locked and left); doors(open) - an open door's line blinks red until it closes (setting doorRed; not with
 * the car locked and left, so a door left open does not keep the body module awake); with the hazards on (setting
 * hazardRed) every light pulses red, bright then dim, in place of the turn glow (not with the car locked and left). Left is
 * the driver's side on a left-hand drive car.
 */
const fs = require('fs');
const { groupOf } = require('./ambient');

const FLASH_FILE = process.env.MGU_AMBIENT_FLASH || '/dev/shm/mgu-ambient-flash.json';
const FAVS = 6;
const DEFAULT_LOOK = { kind: 'solid', upper: { rgb: [120, 60, 255], bright: 80 }, lower: { rgb: [120, 60, 255], bright: 80 }, speed: 2 };
const NIGHT = 0.5;
const GLOW = [0, 230, 60], RED = [255, 0, 0];
/* The blinks keep their own pace, not the car's indicator: each half (on, then dark) lasts at least BLINK_MS / 2 from
 * when it began and is never skipped. A half is written once (one side's door lines: two writes, ~400 ms through the
 * gateway); until Combo 2.4.0 the halves were 330 ms on a fixed clock, shorter than those writes, so the light showed
 * whichever half a frame happened to start in: on and off of uneven lengths. Now about 65 a minute, every half alike.
 * A blink: on, then dark (the light on at no brightness: black, not the car's own colour); a pulse (the hazards' red on
 * every light): bright, then dim. */
const BLINK_MS = 900, PULSE_DIM = 15;
/** A half-by-half clock: lit(t) for t in ms since the blink began, flipping once BLINK_MS / 2 has passed in a half. */
const halves = () => {
    let on = true, since = 0;
    return (t) => {
        if (t < since) { on = true; since = 0; }                       // (began again)
        if (t - since >= BLINK_MS / 2) { on = !on; since = t; }
        return on;
    };
};
const blink = (rgb) => { const lit = halves(); return (t) => (lit(t) ? { rgb, bright: 100 } : { rgb: [0, 0, 0], bright: 0 }); };
const pulse = (rgb) => { const lit = halves(); return (t) => ({ rgb, bright: lit(t) ? 100 : PULSE_DIM }); };
/* The turn glow as a dynamic indicator (Cockpit 3.1.1): a line's sections light one after another, front to back, SWEEP_STEP_MS
 * apart, stay lit to SWEEP_ON_MS, then all go dark, every SWEEP_MS. A G26's front door line has two strips, each its own
 * light: "door line" (section 0) and "door line 2" (section 1). Each write changes one light, so a side's sweep is the
 * blink's four writes (on, on, dark, dark; ~200 ms each through the gateway), in the order the sections light - no more
 * traffic than the blink, which lit the strips one after another anyway. With the hazards (both sides) every time is
 * doubled: twice the writes. A line of one strip lights at once, a blink as before. Cockpit 3.1.4: 1400 ms, the second
 * strip 400 ms after the first, lit to 900 ms (was 1000 / 250 / 600): the four writes took ~800 of the 1000 ms, so one
 * slow write put every later step late and the sweep went unevenly; now each step has room for a write and a slow one. */
const SWEEP_MS = 1400, SWEEP_STEP_MS = 400, SWEEP_ON_MS = 900;
const sectionOf = (l) => (l && / door line 2$/i.test(String(l.name || '')) ? 1 : 0);
const sweep = (rgb, sides) => {
    const k = Math.max(1, sides || 1);
    return (t, on, light) => {
        const p = t % (SWEEP_MS * k);
        return p >= sectionOf(light) * SWEEP_STEP_MS * k && p < SWEEP_ON_MS * k ? { rgb, bright: 100 } : { rgb: [0, 0, 0], bright: 0 };
    };
};
// the car's indicator off this long before the glow stops: its signal's short gaps don't restart the blink
const TURN_GRACE_MS = 1500;
const DOORS = ['driver front', 'driver rear', 'passenger front', 'passenger rear'];
/* The lights by a side of the car (x across the cabin picture: the driver's side 0) and by a door. */
const sideOf = (l) => (l.x <= 0.15 ? 'driver' : l.x >= 0.85 ? 'passenger' : null);
const doorOf = (l) => {
    const n = String(l.name || '').toLowerCase(), side = /^driver/.test(n) ? 'driver' : /^passenger/.test(n) ? 'passenger' : null;
    if (!side || n.indexOf('door') < 0) return null;
    if (/ front door/.test(n) || / rear door/.test(n)) return side + (/ front door/.test(n) ? ' front' : ' rear');
    return side + (l.y < 0.5 ? ' front' : ' rear');        // the door's backlit decor: by where it sits
};
/* A door's line light. The turn glow and an open door's red blink only these (one write each a frame, ~2.4 blinks a
 * second on the car against ~0.8 with every light of a side); a car whose side or door has none blinks all of them.
 * Not a line's second strip (a G26's "door line 2"): with both strips a side had twice the writes, so the blink went
 * half as fast and the strips lit visibly one after another (#169). The second strip keeps the look's colour. */
const isLine = (l) => / door line$/i.test(String(l.name || ''));
// the body module's own open-door warnings (TAB_INNENLICHT_FUNKTIONSMODI), each door's mode; seconds a write lasts
const CAR_DOOR_MODE = { 'driver front': 0x23, 'driver rear': 0x24, 'passenger front': 0x25, 'passenger rear': 0x26 };
const CAR_DOOR_S = 4, CAR_DOOR_RENEW_MS = 3000;
const linesOf = (all, pick) => (l) => pick(l) && (isLine(l) || !all().some((x) => pick(x) && isLine(x)));
/* The turn glow: a side's front door line, the whole of it (a G26's two strips, "door line" and "door line 2"), the one
 * the driver sees; the rear door keeps the look. Two writes a side, as the first strips of both doors were, so the
 * same pace - but the whole line lights, not its front half (Cockpit 2.8.2). A side without a front door line: its door
 * lines, or all its lights (linesOf). */
const isFrontLine = (l) => / front door line( 2)?$/i.test(String(l.name || ''));
const turnLightsOf = (all, sides) => (l) => {
    const s = sideOf(l);
    if (sides.indexOf(s) < 0) return false;
    return all().some((x) => sideOf(x) === s && isFrontLine(x)) ? isFrontLine(l) : linesOf(all, (x) => sideOf(x) === s)(l);
};

const copy = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const valid = (l) => !!l && typeof l === 'object' && !!l.upper && Array.isArray(l.upper.rgb) && !!l.lower && Array.isArray(l.lower.rgb);

class Control {
    constructor(o) {
        this.settings = o.settings; this.lights = o.lights; this.ambient = o.ambient; this.log = o.log;
        this._grace = o.turnGraceMs == null ? TURN_GRACE_MS : o.turnGraceMs; this._turnOff = null;
        this._mode = null; this._night = false; this._away = false; this._shown = null; this._flashAt = 0; this._poll = null;
        this._turn = null; this._doors = [];
        this._carDoors = {}; this._carDoorTimer = null; this._carDoorNo = false; this._carOwn = '';
    }

    look() { const l = this.settings.get('look'); return valid(l) ? copy(l) : copy(DEFAULT_LOOK); }
    on() { return !!this.settings.get('on'); }
    /** A mode's (variant's) own look, or null. */
    modeLook(m) { const l = this.settings.get('mode_' + m); return valid(l) ? copy(l) : null; }
    /** The mode's own setting is BMW's original colour. */
    modeOriginal(m) { return this.settings.get('mode_' + m) === 'original'; }
    /** The group a variant takes its look from, when it has nothing of its own (Sport+ -> 'sport'), else null. */
    inherits(m) {
        const g = groupOf(m), own = this.settings.get('mode_' + m);
        return g !== m && !valid(own) && own !== 'original' ? g : null;
    }
    /** The look a mode shows: its own, else its group's (null: none picked). */
    lookFor(m) { const g = this.inherits(m); return this.modeLook(g || m); }
    /** The mode shows BMW's original colour: its own setting, else its group's. */
    originalFor(m) { const g = this.inherits(m); return this.modeOriginal(g || m); }
    favs() { const f = this.settings.get('favs'); return Array.isArray(f) ? f.filter(valid).slice(0, FAVS) : []; }

    /** The look on now (null: the car's colour), and why: 'mode' or 'own'. */
    target() {
        if (this._away) return { look: null, why: 'away' };
        const follow = this.settings.get('follow') !== false && this._mode;
        if (follow && this.originalFor(this._mode)) return { look: null, why: 'mode' };
        const m = follow ? this.lookFor(this._mode) : null;
        if (m) return { look: m, why: 'mode' };
        return this.on() ? { look: this.look(), why: 'own' } : { look: null, why: 'car' };
    }

    start() {
        if (this.settings.get('keep') === false) this.settings.set('on', false);
        this._mode = this.ambient ? this.ambient.mode() : null;
        const t = this.target();
        if (this.settings.get('welcome') && t.look) this._show(Object.assign(copy(t.look), { kind: 'welcome', then: t.look }));
        else this.apply();
        if (this.ambient) this.ambient.on('change', () => this.mode(this.ambient.mode()));
        this._poll = setInterval(() => this._flashFile(), 300);
    }

    stop() { clearInterval(this._poll); clearTimeout(this._carDoorTimer); }

    /** The driving mode changed. */
    mode(m) {
        if (m === this._mode) return;
        const was = this._mode;
        this._mode = m;
        const t = this.target();
        // into any Sport variant from another group (Comfort to Sport+, not Sport to Sport+)
        if (groupOf(m) === 'sport' && was && groupOf(was) !== 'sport' && this.settings.get('sportPulse')) {
            this._show(Object.assign(copy(t.look || this.look()), { kind: 'pulse', then: t.look }));
            return;
        }
        this.apply();
    }

    /** The car locked and left (true), or someone back in (false). */
    away(on) {
        on = !!on;
        if (on === this._away) return;
        this._away = on;
        this.log.info('ambient: ' + (on ? 'the car is parked: the car\'s own light' : 'someone is in the car: our colour again'));
        this.signals();
        const t = this.target();
        if (!on && this.settings.get('welcome') && t.look) this._show(Object.assign(copy(t.look), { kind: 'welcome', then: t.look }));
        else this.apply();
    }

    /** The turn signals: 'left', 'right', 'both' (hazards) or null. */
    turn(side) {
        side = side || null;
        if (this._turnOff) { clearTimeout(this._turnOff); this._turnOff = null; }
        if (!side && this._turn && this._grace > 0) {
            this._turnOff = setTimeout(() => { this._turnOff = null; this._turn = null; this.signals(); }, this._grace);
            if (this._turnOff.unref) this._turnOff.unref();
            return;
        }
        this._turn = side; this.signals();
    }
    /** The doors open: some of DOORS. */
    doors(open) { this._doors = (open || []).filter((d) => DOORS.indexOf(d) >= 0); this.signals(); }
    /** The turn signal's glow, the hazards' red pulse and the open doors' red, as the settings and the car say now. */
    signals() {
        const rhd = this.settings.get('drive') === 'rhd', side = (s) => (s === 'left') !== rhd ? 'driver' : 'passenger';
        const hazard = this.settings.get('hazardRed') === true && !this._away && this._turn === 'both';
        if (hazard !== this._hazard) {
            this._hazard = hazard;
            this.lights.overlay('hazard', hazard ? () => true : null, pulse(RED));
        }
        const turn = this.settings.get('turnGlow') === true && !this._away && !hazard ? this._turn : null;
        const sides = turn === 'both' ? ['driver', 'passenger'] : turn ? [side(turn)] : [];
        const all = () => this.lights.lights || [];
        const key = sides.join();
        if (key !== this._glow) {
            this._glow = key;
            this.lights.overlay('turn', sides.length ? turnLightsOf(all, sides) : null, sweep(GLOW, sides.length));
        }
        this._carDoor();
        // our red blink: the open doors the car's own warning doesn't show
        const doors = this.settings.get('doorRed') === true && !this._away ? this._doors.filter((d) => !this._carDoors[d]) : [];
        if (doors.join() !== this._red) {
            this._red = doors.join();
            this.lights.overlay('doors', doors.length ? linesOf(all, (l) => doors.indexOf(doorOf(l)) >= 0) : null, blink(RED));
        }
    }

    /**
     * Setting doorCar (a test, off by default): an open door shows the body module's own open-door warning, started
     * with one write (BDC_G05's _INNENLICHT_FUNKTIONSMODI, 2E 48 04 <mode> <seconds>): the body module drives the
     * lights itself, in step and at its own pace. For CAR_DOOR_S seconds, renewed while the door stays open, so it
     * ends by itself soon after the door closes. A body module that refuses it: logged, our red blink instead.
     */
    _carDoor() {
        const want = this.settings.get('doorCar') === true && !this._away && !this._carDoorNo ? this._doors : [];
        Object.keys(this._carDoors).forEach((d) => { if (want.indexOf(d) < 0) delete this._carDoors[d]; });
        want.forEach((d) => { if (!(d in this._carDoors)) { this._carDoors[d] = true; this._sendCarDoor(d, true); } });
        // the doors' lights (both strips, the handle) are the car's while its warning runs: ours would cover it (#169)
        const own = Object.keys(this._carDoors).sort().join();
        if (own !== this._carOwn) {
            this._carOwn = own;
            const doors = Object.assign({}, this._carDoors);
            this.lights.carOwn('carDoor', own ? (l) => !!doors[doorOf(l)] : null);
        }
        clearTimeout(this._carDoorTimer); this._carDoorTimer = null;
        if (want.length) this._carDoorTimer = setTimeout(() => { want.filter((d) => this._carDoors[d]).forEach((d) => this._sendCarDoor(d, false)); this._carDoor(); }, CAR_DOOR_RENEW_MS);
    }
    _sendCarDoor(door, first) {
        const mode = CAR_DOOR_MODE[door];
        this.lights.command([0x48, 0x04, mode, CAR_DOOR_S]).then((r) => {
            const ok = !!r && r[0] === 0x6e;
            if (first || !ok) this.log.info('door warning (car): ' + door + ' ' + (ok ? 'started' : r ? 'refused (' + r.map((x) => x.toString(16)).join(' ') + ')' : 'no answer'));
            if (ok || !(door in this._carDoors)) return;
            // refused or no answer: our own red blink for the doors from now on (until the setting is switched again)
            this._carDoorNo = true; this._carDoors = {}; this._carOwn = ''; this.lights.carOwn('carDoor', null);
            this.log.warn('door warning (car): the body module did not take it, our red blink instead');
            this.signals();
        });
    }
    /** doorCar switched: the car's warning asked for again. */
    carDoorSetting() { this._carDoorNo = false; this.signals(); }

    night(on) { this._night = !!on; this.lights.dim(on && this.settings.get('nightDim') !== false ? NIGHT : 1); }

    apply() {
        const t = this.target();
        if (t.look) this._show(t.look); else { this._shown = null; this.lights.carColour(); }
    }

    _show(scene) {
        const key = JSON.stringify(scene);
        if (key === this._shown && this.lights.scene) return;
        this._shown = key;
        this.lights.show(scene);
    }

    /** By hand: change the driver's look (a part of it) and put it on. */
    setLook(patch) {
        const l = Object.assign(this.look(), copy(patch));
        this.settings.set('look', l);
        this.settings.set('on', true);
        this.apply();
        return l;
    }

    carColour() { this.settings.set('on', false); this.apply(); }

    /** A driving mode's look; 'original': BMW's original colour; null: nothing picked. */
    setModeLook(m, look) { this.settings.set('mode_' + m, look === 'original' ? look : look ? copy(look) : null); this.apply(); }

    /** Saves the look in the first free place (all six taken: instead of the oldest). */
    saveFav() {
        const f = this.favs();
        f.push(this.look());
        while (f.length > FAVS) f.shift();
        this.settings.set('favs', f);
        return f.length - 1;
    }
    useFav(i) { const f = this.favs()[i]; if (f) this.setLook(f); }
    dropFav(i) { const f = this.favs(); f.splice(i, 1); this.settings.set('favs', f); }

    _flashFile() {
        let st;
        try { st = fs.statSync(FLASH_FILE); } catch (e) { return; }
        if (st.mtimeMs <= this._flashAt) return;
        const first = !this._flashAt;
        this._flashAt = st.mtimeMs;
        if (first && Date.now() - st.mtimeMs > 2000) return;       // one left from before
        if (this.settings.get('flashAlerts') === false) return;
        try {
            const f = JSON.parse(fs.readFileSync(FLASH_FILE, 'utf8'));
            if (Array.isArray(f.rgb) && f.rgb.length === 3) this.lights.flash(f.rgb, Math.max(1000, Math.min(3000, Number(f.ms) || 1200)));
        } catch (e) { /* half-written: the next write */ }
    }
}

module.exports = { Control, DEFAULT_LOOK, FLASH_FILE, FAVS, NIGHT, DOORS, GLOW, RED, BLINK_MS, SWEEP_MS, SWEEP_STEP_MS, SWEEP_ON_MS, blink, pulse, sweep, sideOf, doorOf };
