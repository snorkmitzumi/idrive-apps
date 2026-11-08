# Combo Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new app `apps/combo/` ("Combo") with one 1600 × 520 screen in M Vitals' look: four equal columns (Engine speed + Boost · Speed / Power / Torque · xDrive · 48 V + 12 V battery), real car data, configurable settings.

**Architecture:** Car signals (SOME/IP, copied from M Vitals' watches) feed a small value store with peaks; a read scheduler asks the engine unit, the transfer case and the batteries over the kit's read-only diagnostic link, only while the screen is shown and the car is in use; a draw module renders the four columns with the kit's gauges. Demo (all or nothing) only while no car signal arrived.

**Tech Stack:** Node.js app on the kit runtime (`kit/runtime/*`: mgu, gauges, engine, car, readonly-diag, dids, canvas), plain node test scripts in `kit/tools/`.

**Spec:** [docs/superpowers/specs/2026-11-08-combo-screen-design.md](../specs/2026-11-08-combo-screen-design.md) (mockup next to it). Read it before any task.

## Global Constraints

- Runs on the car's **Node 8**: no `?.`, `??`, `Promise.prototype.finally`, `catch {` without a binding, object spread `{...x}` (use `Object.assign`). `async` / `await` are fine.
- Reading only: every diagnostic request goes through `kit/runtime/readonly-diag.js` (`ReadOnlyDiag`), never `Diag` directly.
- No diagnostic request while `ui.isVisible('MAIN')` is false, re-checked when the next round is scheduled; a round at once when MAIN becomes visible.
- No diagnostic request while parked and unused: in use = speed > 1 km/h or engine running (rpm > 400 within 5 s), and 3 min after (`IDLE_AFTER_MOVE = 180000`), or 10 min after MAIN was shown (`IDLE_AFTER_USER = 600000`).
- Short waits on every candidate: `timeoutMs: 1000`, `diagOpts: { retryBaseMs: 150, pendingTimeoutMs: 1500, callTimeoutMs: 2000 }`; a candidate's own values in `app.json` win.
- A value whose candidates all fail 3 times in a row: read only every 5 min after that.
- Demo all or nothing: demo only when setting `demo` = `on`, or `auto` and no car signal arrived and the provider is not available for 5 s (M Vitals' `carPresent()` rule). Never a demo number on a real car; a missing value shows `--` with a reason.
- Signs: both batteries + = into the battery (charging), − = out (supplying); the 48 V current from AA56 is turned round. |I| ≤ 1 A = IDLE.
- Screen: 1600 × 520, `G.TOP` = 44, `G.BOTTOM` = 512 (plus `cv.extra` below on the car: `G.pageBottom(cv)`). Four columns: x = 24, 418, 812, 1206, each 370 wide (gap 24), same height.
- Settings keys, labels, choices and defaults as in the spec's "Settings" tables (copied from `apps/car_vitals/app.json` / `apps/edrive/app.json` where marked).
- `loggingId` `OAA3` (free; the build checks nothing, so grep `apps/*/app.json` before committing).
- Every test file is a plain node script that exits 0 on pass, 1 on failure, and is listed in `.github/workflows/app-tests.yml`.

## Review Focus

1. **A car without a 48 V battery** (12 V only): after the 48 V battery missed 6 reads in a row (3 when another unit answered), nothing more is asked of ECU 2 until every 5 min, and the 12 V panel takes the whole column (with `battery48` = Auto). → Task 4 test `no 48 V: given up, 12 V full column`.
2. **App hidden in the middle of a round** (the owner opens another app while a read is pending): the next round is scheduled at the hidden rate (none), not 0.5 s. → Task 4 test `hidden during a round: nothing scheduled`.
3. **A short or odd AA56 reply** (layout not confirmed on a car): fields past the reply's end are `null`, never `NaN`, and nothing throws; the raw reply goes to the log once per new length. → Task 3 test `short AA56 reply`.
4. **Units other than the defaults** (psi, °F, hp, lb-ft): every number on the screen, including the new ones (front-axle Nm, peaks, battery temperatures, boost target), is converted. → Task 5 test `units: psi / °F / hp / lb-ft`.
5. **Car parked, screen left on** (charging, waiting): reads stop after 10 min unused, and the battery panels say `paused - parked` instead of a stale number. → Task 4 test `parked: reads stop after 10 min`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/combo/app.json` | id, title, version `1.0.0`, `loggingId` `OAA3`, `iconGlyph` `gauge`, `signals`, `screens`, `settings`, `config` (scaling, dme, xdrive, battery candidate lists) |
| `apps/combo/main.js` | `mgu.run({ start(ctx) })`: wires signals, values, reads, draw, buttons, settings |
| `apps/combo/values.js` | the value store: `put`, peaks with hold, boost source choice, power, xDrive split, data() for drawing |
| `apps/combo/signals.js` | the SOME/IP watch list (copied from M Vitals' `watches`, only the fields this screen uses) |
| `apps/combo/batteries.js` | parse the 48 V and 12 V replies into values with signs and state |
| `apps/combo/reads.js` | the diagnostic read scheduler: tiers, visibility / in-use gating, back-off, 48 V detection |
| `apps/combo/draw.js` | the four columns, drawn with `kit/runtime/gauges.js` |
| `apps/combo/demo.js` | demo values for every field `draw.js` uses |
| `kit/runtime/readonly-diag.js` | modify: `physical()` passes timing options on |
| `kit/tools/test_combo.js` | all tests for the app |
| `.github/workflows/app-tests.yml`, `.gitignore`, `README.md` | test listed; `.superpowers/` ignored; one row in the apps table |

---

### Task 1: The app's skeleton: app.json, demo, four equal empty columns

**Files:**
- Create: `apps/combo/app.json`, `apps/combo/main.js`, `apps/combo/demo.js`, `apps/combo/draw.js`, `kit/tools/test_combo.js`
- Modify: `.github/workflows/app-tests.yml` (add `- run: node kit/tools/test_combo.js` after `test_car_vitals`), `.gitignore` (add `.superpowers/` under "editor and tool folders")

**Interfaces:**
- Produces: `draw.columns() -> [{ x, y, w, h }] ×4` (x 24 / 418 / 812 / 1206, y `G.TOP`, w 370, h `G.BOTTOM - G.TOP`); `draw.render(cv, t, d, opts)` (this task: frame + four panels titled `Engine speed`, `Speed`, `xDrive`, `48 V battery`); `Demo#sample() -> data` with keys `rpm, boost, boostTarget, speed, gear, gearMode, powerPct, torque, powerCalc, splitRear, awd, awdQual, lmvFront, b48 {soc, v, a, kw, soh, temp}, b12 {soc, v, a, soh, temp}`.
- `app.json` `screens`: `[{ name: 'MAIN', kind: 'canvas', title: 'Combo', buttons: [['BTN_RESET', 'Reset peaks'], ['BTN_SETTINGS', 'Settings']] }]`.
- `app.json` `settings`: exactly the keys of the spec's Settings tables, in that order, copied from `apps/car_vitals/app.json` for those marked M Vitals; new: `torqueMax` (number, unit Nm, steps 400 / 500 / 600 / 700 / 900, default 900), `battery48` (choice auto / on / off, labels Auto / Show / Hide, default auto).
- `app.json` `signals`: from `apps/car_vitals/app.json`: `CDS.statusEngineSpeed2`, `Vehicle2` (`statusCarSpeed2`, `statusVehiclePartType`), `FES` (all three), `VehicleInformation` (both), `BasicDataSet`, `MDrive` (both), `InternalTasu` (as is).
- `app.json` `config`: `scaling` (copy M Vitals' whole `config.scaling`), `dme` (copy M Vitals' `ecu`, `boost`, `baro`, `boostTarget`), `xdrive` (copy M Vitals' `config.xdrive`), `battery` (copy eDrive's `b48`, `v12`, `i12`, `soc40`, `soc12`, `soh12`, `t12`).

- [ ] **Step 1: Write the failing test** in `kit/tools/test_combo.js`, stubbing `./kit/mgu` and `./kit/readonly-diag` the way `kit/tools/test_car_vitals.js` stubs M Vitals' modules (demo `on`, ctx with `ui.isVisible`, `ui.onVisible`, `ui.onClick`, `loop`, `canvas`):
  - `columns`: `draw.columns()` has 4 entries, all `w === 370`, all the same `h`, x = `[24, 418, 812, 1206]`.
  - `skeleton`: booting the app and drawing one frame records the texts `Engine speed`, `Boost`, `Speed`, `xDrive`, `48 V battery`, `12 V battery`, and `DEMO`.
  - `app.json`: `loggingId` is `OAA3` and no other `apps/*/app.json` uses it; every setting key from the spec's tables is present.
- [ ] **Step 2: Run it**: `node kit/tools/test_combo.js`. Expected: FAIL (cannot find `apps/combo/main.js`).
- [ ] **Step 3: Write** `app.json` as above, `demo.js` (a loop like `apps/car_vitals/demo.js`, plus the battery and `lmvFront` fields), `draw.js` with `columns()` and a `render()` drawing `G.frame` and `G.panel` per column (column 1 and 4 as two stacked panels of half height minus the gap), `main.js` booting `Display` via `mgu.run` with `ctx.loop('MAIN', 10, render)` and demo data only.
- [ ] **Step 4: Run** `node kit/tools/test_combo.js`. Expected: PASS. Also `python3 kit/tools/check_signals.py` if `reference/someip-interfaces.json` exists locally (it is not in git; skip otherwise).
- [ ] **Step 5: Commit** `apps/combo/ kit/tools/test_combo.js .github/workflows/app-tests.yml .gitignore` as `Combo 1.0.0: the app's skeleton, four equal columns, demo`.

### Task 2: Car signals and the value store

**Files:**
- Create: `apps/combo/values.js`, `apps/combo/signals.js`
- Modify: `apps/combo/main.js` (subscribe the watches, `data()` from the store), `kit/tools/test_combo.js`

**Interfaces:**
- Consumes: `Demo#sample()` (Task 1), `kit/runtime/engine.js` `Engine`, `kit/runtime/car.js` `GearGuess`, `selectionOf`.
- Produces: `new Values({ settings, log, now })` with
  - `put(key, value)` (plausibility ranges from M Vitals' `RANGE` for the keys used; `MOVE` / trusted for `boostFes`, `boostDme`),
  - `raise(key, value)` / `peak(key)`: M Vitals' `raise()` rule with `peakHold` (0 = until `resetPeaks()`), keys `rpm boost power torque lmvFront`,
  - `resetPeaks()`,
  - `boost() -> { value, from: 'fes'|'dme'|null }` (setting `boostSource`, M Vitals' `updBoost`),
  - `power() -> { kw, calc }` (M Vitals' `power()`),
  - `split() -> { rear, from, nm }` (M Vitals' `xdriveSplit()`, `SPLIT_STALE = 10000`),
  - `carPresent() -> bool`, `lastCar` (ms),
  - `live` (the raw fields: `rpm, rpmT, speed, gear, gearGuess, gearMode, stage, torque, powerPct, powerCalc, boostFes, boostDme, boostTarget, baro, splitRear, awd, awdQual, awdSeen, lmvFront, lmvT`).
- `signals.js`: `watches(values, engine, sc, log) -> [[iface, { field: fn }]]`: M Vitals' entries for CDS (rpm only), Vehicle2 + `engine.handlers()`, FES, VehicleInformation, BasicDataSet (split only), MDrive; `markAwd` stored in `dataDir/awd.json` as M Vitals.

- [ ] **Step 1: Write the failing tests**:
  - `peak hold`: with `peakHold` 15, `raise('rpm', 6000)` then `raise('rpm', 3000)` at +10 s keeps 6000; at +16 s it is 3000; with `peakHold` 0 it stays 6000 until `resetPeaks()`.
  - `boost source`: `boostSource` `auto`, `boostFes` changed by ≥ 0.03 → `boost().from === 'fes'`; only `boostDme` → `'dme'`; `fes` setting with only `boostDme` → `value === null`.
  - `power`: `powerPct` 50, `maxPower` 215 → `kw === 107.5`; `powerSource` `calc`, torque 500 Nm at 4000 rpm → `kw` ≈ 209.4.
  - `split`: fresh `splitRear` 70 → `{ rear: 70 }`; split stale (11 s) and `lmvFront` 4 Nm → `rear === 100, from: 'transfer case: clutch open'`.
  - `signals`: feeding M Vitals' raw shapes through `watches()` (`statusEngineSpeed2 { actualValueRPMEngineCrankshaft: 16000 }` with the copied scaling) gives `live.rpm === 4000`.
- [ ] **Step 2: Run**: `node kit/tools/test_combo.js`. Expected: FAIL (no `values.js`).
- [ ] **Step 3: Implement** `values.js` and `signals.js` by copying the named M Vitals code (each copied function gets a `// from apps/car_vitals/main.js <name>()` comment), and use them in `main.js`: `data()` = demo sample when demo, else `values` (Global Constraints: demo rule).
- [ ] **Step 4: Run**: `node kit/tools/test_combo.js`. Expected: PASS.
- [ ] **Step 5: Commit** as `Combo 1.0.0: car signals, peaks, boost source, power, xDrive split`.

### Task 3: Battery replies: values, signs, state

**Files:**
- Create: `apps/combo/batteries.js`
- Modify: `kit/tools/test_combo.js`

**Interfaces:**
- Produces:
  - `fields(reply: number[], fieldsCfg) -> { name: number|null }`: eDrive's `readFields` decoding (`apps/edrive/main.js` `readFields`, bytes from offset 3), all-FF = null, out of min..max = null, past the end = null.
  - `b48(f) -> { soc, v, a, kw, soh, temp }` with `a = -f.a` (+ = charging) and `kw = v × a / 1000`.
  - `state(a, v) -> 'CHARGING'|'SUPPLYING'|'IDLE'|null`: a > 1 → CHARGING, a < −1 → SUPPLYING, else IDLE; `a` null: v ≥ 13.2 → CHARGING (12 V only, eDrive `charging()`), else null.
  - `rawShape(reply) -> string` (the reply's length and first 4 bytes, for log-once).

- [ ] **Step 1: Write the failing tests** with sample replies built from eDrive's `config.battery.b48` field layout:
  - `AA56 decode`: a reply with v raw 4720 (47.20 V), a raw −105 (−10.5 A), soc 66, soh 96, temp raw 48 (24 °C) → `b48(...)` = `{ soc: 66, v: 47.2, a: 10.5, kw: 0.4956, soh: 96, temp: 24 }` (kw to 4 decimals), `state(10.5)` = `CHARGING`.
  - `short AA56 reply`: a reply cut after the current → `soc`, `soh`, `temp` null, no `NaN` in any field, no throw.
  - `12 V without current`: `state(null, 14.1)` = `CHARGING`, `state(null, 12.4)` = `null`, `state(0.5)` = `IDLE`, `state(-6)` = `SUPPLYING`.
- [ ] **Step 2: Run**: `node kit/tools/test_combo.js`. Expected: FAIL (no `batteries.js`).
- [ ] **Step 3: Implement** `batteries.js` as pure functions (no I/O).
- [ ] **Step 4: Run**: `node kit/tools/test_combo.js`. Expected: PASS.
- [ ] **Step 5: Commit** as `Combo 1.0.0: 48 V and 12 V battery values, signs and state`.

### Task 4: Diagnostic reads: tiers, gating, back-off

**Files:**
- Create: `apps/combo/reads.js`
- Modify: `kit/runtime/readonly-diag.js:92-99` (`physical(target, sid, data, timeoutMs, accept, opts)` passes `{ retryBaseMs, pendingTimeoutMs, callTimeoutMs }` from `opts` on to the private `Diag#physical`; nothing else from `opts`), `apps/combo/main.js` (start the reader), `kit/tools/test_combo.js`

**Interfaces:**
- Consumes: `Values` (Task 2: `put`, `live`, `raise`), `batteries.fields / b48 / state / rawShape` (Task 3), `kit/runtime/dids.js` `DidReader`.
- Produces: `new Reads({ link, reader, values, settings, cfg, ui, log, now })` with
  - `start()` (schedules with the global `setTimeout`, so tests replace it as `test_edrive.js` does),
  - `shown()` (call on every frame and on `ui.onVisible('MAIN', true)`: user activity + a round at once when not busy),
  - `inUse() -> bool`, `paused() -> bool` (not in use),
  - `bat -> { b48: {…}|null, b48T, b12: { soc, v, a, soh, temp }, b12T: {key: ms}, has48: true|false|null }`,
  - `why(key) -> string` (`reading…`, `paused - parked`, `no 48 V battery`, `no reply`, `diagnostic link down`).
- Tiers (one request at a time, each round reads what is due, then schedules the next round at the smallest remaining delay, re-checking visibility then):
  - 500 ms: `lmvFront` when `values.split()` has no fresh car split; `boostDme` when `values.boost()` would use the engine unit;
  - 1000 ms: `lmvFront` when the car sends its split;
  - 2500 ms: 48 V (`b48`, one request), 12 V voltage (`v12`, keep the candidate that answered, eDrive's `readVolt` order), 12 V current (`i12`);
  - 30000 ms: `soc40` (else `soc12` when `soc40` failed 3×), `boostTarget`, `baro`, `t12`;
  - 1800000 ms: `soh12`.
  - `xdrive` = `off`, or `auto` while `values.live.awdSeen` is false: no `lmvFront`.
  - Every new `batteries.rawShape()` of the AA56 reply is logged once: `log.info('raw AA56: ' + bytes)`. `battery48` = `off`: no `b48`; `auto`: eDrive's detection (`read48`: `has48 = true` on the first answer, `false` after 6 misses or 3 when another unit answered; kept in `dataDir/battery.json`; while `false`, once every 5 min).

- [ ] **Step 1: Write the failing tests** with fake timers (as `kit/tools/test_edrive.js`), a fake link counting requests per `ecu:DID`, and a fake clock:
  - `hidden: no reads`: MAIN not visible → after 60 s of timers, 0 requests.
  - `hidden during a round: nothing scheduled`: a read held open, MAIN hidden, read released → no pending round timer below 60 s.
  - `shown again: a round at once`: hidden 60 s, then `shown()` → a 0 ms round timer.
  - `parked: reads stop after 10 min`: speed 0, rpm 0, shown at t=0 → requests until 10 min, none after; `why('b48') === 'paused - parked'`.
  - `tiers`: shown, driving, car split fresh, sport display boost fresh → over 10 s: `25:DB32` ≈ 10, `2:AA56` = 4 ± 1, `18:40AD` = 1, `18:F470` (boost) = 0.
  - `no 48 V: given up, 12 V full column`: ECU 2 never answers, 12 V answers → `has48 === false` after 3 misses, then `2:AA56` not asked for 5 min.
  - `timing options reach the link`: `ReadOnlyDiag#physical` with `opts.pendingTimeoutMs` 1500 passes it to the private `Diag#physical` (stub `Diag` in the test).
- [ ] **Step 2: Run**: `node kit/tools/test_combo.js`. Expected: FAIL (no `reads.js`).
- [ ] **Step 3: Implement** `reads.js` (copy eDrive's `readVolt` ordering and `read48` detection with source comments) and the `readonly-diag.js` change.
- [ ] **Step 4: Run** `node kit/tools/test_combo.js` and `node kit/tools/test_live_data.js` (the other user of `ReadOnlyDiag`). Expected: both PASS.
- [ ] **Step 5: Commit** as `Combo 1.0.0: diagnostic reads only while shown and in use, by tier; read-only link passes its timing options on`.

### Task 5: The four columns, drawn with real values

**Files:**
- Modify: `apps/combo/draw.js`, `apps/combo/main.js` (pass `values`, `reads`, settings into `render`), `kit/tools/test_combo.js`

**Interfaces:**
- Consumes: `values.data()`, `values.peak(k)`, `values.boost()`, `values.power()`, `values.split()`, `reads.bat`, `reads.why(k)`, `engine.redline()`, `engine.scaleMax()`.
- Produces: `render(cv, t, d, opts)` where `d` = `{ rpm, boost, boostTarget, speed, gear, gearMode, power, powerCalc, torque, split: { rear, from, nm }, awd, awdQual, b48, b12, demo }` and `opts = { settings, peak(k), why(k), redline, scaleMax, has48 }`.
- Content per column, as the spec's Goals 3 and the mockup:
  - 1: `G.segBar` Engine speed (min 0, max `scaleMax`, `limit` redline) with PEAK and `GEAR · SHIFT AT` lines; `G.segBar` Boost (max from `boostMax`, M Vitals' `BOOST_MAX`) with TARGET and PEAK lines.
  - 2: speed + gear (M Vitals' `speedCard` content), `G.bar` Power (max `maxPower`) and Torque (max `torqueMax`, kgm: `maxTorqueKgm`), each with its peak.
  - 3: mode text (M Vitals' `AWD` names, `DERATED / OFF` in `t.crit`), `FRONT AXLE` and `FRONT PEAK` (Nm in the torque unit), REAR / FRONT % bars; `xdrive` `off` (or Auto with no AWD ever seen): the panel shows `RWD` only.
  - 4: 48 V panel above 12 V panel: label `CHARGE`, % big, state word (CHARGING `GO` green / SUPPLYING `t.warn` / IDLE `t.dim`), voltage, 48 V kW / 12 V A, `HEALTH · TEMP`, a 10-segment charge bar; a missing value: `--` and `opts.why(key)` in `t.dim`. With `has48 === false` or `battery48` `off`: the 12 V panel fills the column.

- [ ] **Step 1: Write the failing tests** (drawing into the kit's `Recorder` canvas, collecting texts as `test_car_vitals.js` does):
  - `real values`: a `d` with rpm 4123, boost 1.27, target 1.35, b48 soc 66 a 10.5, b12 soc 84 → texts include `4123`, `1.27`, `TARGET`, `1.35`, `CHARGE`, `66`, `84`, `CHARGING`, `FRONT AXLE`.
  - `missing values`: `b48` null and `why('b48')` = `reading…` → texts include `--` and `reading…`, and no `NaN` / `undefined` text anywhere.
  - `units: psi / °F / hp / lb-ft`: boost 1.0 bar → `14.5`; 48 V temp 24 °C → `75`; power 100 kW → `134`; front-axle 100 Nm → `74` (lb-ft).
  - `no 48 V`: `has48 === false` → no `48 V battery` text, `12 V battery` present.
  - `RWD`: `xdrive` `off` → `RWD` present, no `FRONT AXLE`.
- [ ] **Step 2: Run**: `node kit/tools/test_combo.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the drawing (M Vitals' unit helpers `P`, `T`, `PW`, `TQ`, `V` copied into `draw.js`).
- [ ] **Step 4: Run**: `node kit/tools/test_combo.js`. Expected: PASS. Render the demo to a PNG once (`node kit/tools/preview.js combo` if it supports the app; else skip) and compare it with the mockup by eye.
- [ ] **Step 5: Commit** as `Combo 1.0.0: the four columns with the car's values, peaks and reasons`.

### Task 6: Buttons, settings changes, docs

**Files:**
- Modify: `apps/combo/main.js`, `README.md` (one row in the apps table after **M Vitals**, and the app in the install list if the README has one), `kit/tools/test_combo.js`

**Interfaces:**
- Consumes: `values.resetPeaks()`, `reads.shown()`, `Engine#onChange`.
- Produces: `BTN_RESET`: the first press shows `Press again to reset peaks` for 6 s (`CONFIRM_MS = 6000`); a second press within it calls `values.resetPeaks()`. `settings.onChange`: `boostSource` → re-pick boost; `redline` / `rpmScale` / `engine` → the demo's redline (as M Vitals).

- [ ] **Step 1: Write the failing tests**:
  - `reset peaks`: a peak of 6000 rpm, one press → still 6000 and the confirm text shown; second press within 6 s → peak cleared; a second press after 7 s only asks again.
  - `boot on a car`: demo `auto`, a fake signal delivers rpm within 5 s → no `DEMO` text, rpm shown.
- [ ] **Step 2: Run**: `node kit/tools/test_combo.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the handlers and the README row (what the screen shows, read-only, where its values come from).
- [ ] **Step 4: Run every test**: `for t in kit/tools/test_*.js; do node "$t" >/dev/null 2>&1 || echo "FAIL $t"; done`. Expected: only `test_diagnostic_ru.js` and `test_diagnostic_zh.js` fail (they need `dist/`, they fail on `main` too).
- [ ] **Step 5: Commit** as `Combo 1.0.0: Reset peaks, settings, README`.
