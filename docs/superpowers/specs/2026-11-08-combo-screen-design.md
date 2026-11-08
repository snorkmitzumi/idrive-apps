# Combo screen: one page with engine, xDrive and the hybrid batteries

**Date:** 2026-11-08
**Status:** design, waiting for approval
**Mockup:** [2026-11-08-combo-screen-mockup.html](2026-11-08-combo-screen-mockup.html) (open in a browser; the dashed yellow outlines only mark what was added during the design, they are not part of the look)

## Intent

The owner drives a **G26 with a 48 V mild hybrid** and xDrive. Today, the values they want to watch together are spread
over separate apps and pages, and only one app is on screen at a time (no multitasking):

- engine speed and boost on M Vitals' **Engine** page,
- speed, gear, power and torque in the right column of the same page,
- the xDrive mode and front / rear split on M Vitals' **Chassis** page,
- the 48 V battery and the 12 V battery on eDrive's **48 V system** page.

They want **one new app with one screen** that shows all of this at a glance, in M Vitals' look.

## Goals

1. A new, separate app (its own tile) with a single screen, 1600 × 520 like the other apps.
2. **M Vitals' Engine page is the base**: its look (panels with the blue / blue / red tab and the line over them, segment
   bars, big numbers with a dim unit, header with the app name and DEMO badge, the slim bar at the bottom; its buttons:
   see "Behaviour details") and its values.
3. **Four columns of equal width and height** (the owner's words: "widgets should be same width and height"):
   1. **Engine speed** panel over a **Boost** panel (the Engine page's left part, narrowed to one column).
      - Engine speed: rpm now, a segment bar with the redline zone, **peak rpm**, **gear and the shift point** (rpm).
      - Boost: bar now, a segment bar, **target boost** (from the engine unit) and **peak boost**.
   2. **Speed / Power / Torque**, as the Engine page's right column: speed with the gear beside it, power and torque as
      bars, each with its **peak**.
   3. **xDrive**, as on the Chassis page: the mode (e.g. "4WD Sport", DERATED / OFF in red when the car says so), rear
      and front % bars, and the **torque to the front axle now** and its **peak** (Nm, from the transfer case).
   4. **Battery**, split top / bottom into two panels:
      - **48 V battery**: **CHARGE** in % (labelled, big), CHARGING / SUPPLYING, voltage, power (kW), **health and
        temperature**, a battery-segment bar of the charge.
      - **12 V battery**: **CHARGE** in % (labelled, big), CHARGING / SUPPLYING, voltage, current (A), **health and
        temperature**, a battery-segment bar of the charge.
4. **Real data from the car**, read the same way M Vitals and eDrive read it (SOME/IP signals through `kit/runtime/car.js`
   and the apps' own signal watches, UDS through the kit's diagnostic link and `DidReader` candidate lists in `app.json`
   `config`). It is a working app, not a mock screen.
5. **Settings the owner can change** in the HMI's settings menu, so the gauges match the car (scales, redline, units,
   sources): see "Settings" below.
6. Demo data only as a fallback when the car doesn't answer (setting "Demo data": Auto / Always / Never, as every app
   here), so the screen can be shown and tested off the car.

## Non-goals

- No more pages, no page tabs (one screen). No home-screen widget.
- No writes to the car of any kind (no xDrive switching, no fault or adaptation resets). Reading only. (Resetting this
  app's own peaks is fine: it touches nothing in the car.)
- No changes to M Vitals or eDrive: they stay as they are (see "How it gets made").
- No new values beyond the ones above; no history traces, charge logs or trip totals.

## Anti-goals (would make it a failure even if it works)

- **Slowing the other apps down.** The diagnostic link takes one request at a time and the apps keep running hidden
  (README "the app keeps running hidden"). This app must not read anything over the diagnostic link while it is hidden,
  and must be gentle while shown (see "Reading").
- **Keeping the car awake.** Like eDrive: no diagnostic reads while parked and unused (no speed, engine off, the screen
  not opened for a while).
- Looking like a different app: it must read as part of M Vitals' family.

## Constraints from the repo

- Apps are separate packages: `kit/tools/build.py` copies an app's own folder plus `kit/runtime` into it. **One app
  cannot `require()` another app's files.** Shared code lives in `kit/runtime/` (car.js, engine.js, gauges.js, dids.js,
  diag.js, readonly-diag.js, sim.js, ...).
- Node 8 on the car (no `Promise.finally`, see existing code), the kit's `mgu.run({ start(ctx) })` app shape,
  `ctx.loop('MAIN', fps, render)` (only runs while visible), `ui.isVisible('MAIN')` / `ui.onVisible`.
- `app.json`: `id`, `title`, `version`, `vendor`, a unique `loggingId` (used so far: OA93..OAA2, check before picking),
  `iconGlyph` or `icon.png`, `signals` (checked against the car's catalog by `kit/tools/check_signals.py`), `screens`,
  `settings`, `config`.
- Tests are plain node scripts in `kit/tools/test_*.js`, listed in `.github/workflows/app-tests.yml`.

## Where each value comes from (all already read by M Vitals or eDrive today)

| Value | Source | Used today by |
|---|---|---|
| rpm, speed, gear, torque | SOME/IP signals via `kit/runtime/car.js` (`rpm`, `speed`, `gear`, `torque`) | M Vitals, Redline |
| power | sport display % × max power, else torque × rpm (`kit/runtime/engine.js` / M Vitals `power()`) | M Vitals |
| boost now | sport display signal (`FES`), else the engine unit (UDS `config.dme.boost`, baro subtracted) | M Vitals |
| boost target | engine unit, `config.dme.boostTarget` (4AB0 / F470 / OBD 70, baro subtracted) | M Vitals |
| shift point | the redline setting (M Vitals' `redline` / `engine.redline()`) | M Vitals, Redline |
| xDrive mode, DERATED | signal `MDrive` (`statusAllWheelSetup`, `qualifierFunctionAllWheel`) | M Vitals |
| front / rear % | the car's split signal; else front-axle torque / (engine torque × gear ratio) | M Vitals `xdriveSplit()` |
| front-axle torque | transfer case LMV 0x19, UDS 22 DB32 (`config.xdrive.front`) | M Vitals |
| 48 V: charge, V, A, power, health, temp | battery BATT48 ECU 2, UDS 22 AA56 (`config.battery.b48` in eDrive) | eDrive |
| 48 V charging / supplying | sign of the 48 V current (negative = charging, per eDrive's config note) | eDrive |
| 12 V charge % | engine unit 18, 22 40AD (`soc40`), else 56F0 (`soc12`) | eDrive |
| 12 V voltage | `config.battery.v12` candidates (F442, OBD 42, ...), keep the one that answers | eDrive |
| 12 V current | engine unit 22 5852 / 402B (`i12`) | eDrive |
| 12 V health, temp | engine unit 22 59AA (`soh12`), 22 5854 (`t12`) | eDrive |
| 12 V charging / supplying | current in (> +1 A), or without a current: voltage ≥ 13.2 V (eDrive `charging()`) | eDrive |

The 48 V layout (AA56) is marked in eDrive as "not yet confirmed on a car": this G26 will be the first check, so the
raw replies must be easy to see (log them once per new shape, as M Vitals does with `logRaw`).

## Reading (the diagnostic link)

- A read-only link: `kit/runtime/readonly-diag.js` (refuses anything but UDS 22 and OBD 01 / 09 before it reaches the
  car), with `kit/runtime/dids.js` on top. Short waits on every candidate, as after PR #1: about 1 s per reply, busy
  retried after 150–600 ms, "response pending" 1.5 s.
- Only while the screen is visible (`ui.isVisible('MAIN')`), checked again when scheduling the next round; a round at once
  when it becomes visible again. Nothing over the diagnostic link while hidden.
- Not while parked and unused, as eDrive: only while driving (speed > 1 km/h or engine running, and 3 min after), or for
  10 min after the screen was opened.
- Rates while shown (the builder may tune them; the point is that the fast values get most of the link):
  - fast, about every 0.5 s: front-axle torque when the car's own split signal is missing (it then also gives the
    front / rear %, as M Vitals' `xdriveSplit()`), boost from the engine unit (only when the sport display has none);
  - about every 1 s: front-axle torque when the car does send its split (the FRONT AXLE / FRONT PEAK rows are wanted on
    this screen, unlike M Vitals, which reads it only without a split). The % bars then come from the car's split, the Nm
    rows from the transfer case. With the xDrive setting on Hide: no transfer-case reads at all;
  - every 2–3 s: 48 V battery (one request, AA56), 12 V voltage and current;
  - every 30 s: 12 V charge (40AD), boost target, outside air pressure for boost;
  - every 30 min: 12 V health.
  - A value whose candidates all fail 3 times in a row: only every 5 min after that (as eDrive), so a unit that isn't
    there doesn't hold the link.
- Signals (rpm, speed, gear, torque, sport display, xDrive mode / split) need no reads and update as the car sends them.

## How it gets made

These are calls made during the design (by Claude, not decided with the owner), and can be changed:

- **A new app folder `apps/combo/`**, title **"Combo"** (placeholder name; easy to rename), its own `loggingId`
  (first free after OAA2) and an icon from `kit/icons` / `iconGlyph: "gauge"`.
- **Reuse the kit, copy the small bits.** The values' readers are copied from M Vitals and eDrive into the new app (with a
  comment pointing at the original), and the candidate lists copied into the new app's `app.json` `config`. M Vitals and
  eDrive are not refactored: moving their code into `kit/runtime` would touch two working apps for one new one (the
  owner asked earlier for "not too much refactoring"). If the copies grow, moving them to the kit is a later step.
- **Drawing with the kit's gauges** (`kit/runtime/gauges.js`: `G.panel`, `G.segBar`, `G.bar`, `G.frame`, ...), the same
  calls M Vitals uses, so the look matches; sizes scaled to a 1/4-width column. The screen uses the GPU renderer when it
  is there and the PNG path otherwise, as all apps do (`ctx.loop`).
- **Settings**: see the next section. Same keys, labels, choices and defaults as M Vitals / eDrive where the setting is the
  same thing, so they behave and read alike.
- **Tests** in `kit/tools/test_combo.js` (demo render of the page, no diagnostic reads while hidden, read-only link,
  values parsed from sample replies), added to `app-tests.yml`.
- `.superpowers/` (the design session's mockup files) is added to `.gitignore`.

## Behaviour details settled after the review (Claude's calls)

- **Peaks** work as in M Vitals: a peak follows new highs and drops back to the current value after "Peak hold"
  (default 15 s; 0 = held until Reset peaks). Peaks for rpm, boost, power, torque and front-axle torque. Kept in memory
  only (not across restarts).
- **The slim bar** has **RESET PEAKS** (two presses, as M Vitals' confirm pattern) and **SETTINGS**. NEXT PAGE /
  PREVIOUS PAGE are left out: there is one page.
- **Demo is all or nothing, never mixed with the car.** Demo data = Auto: the whole screen is demo only while no car
  signal has arrived (M Vitals' rule: `kit/runtime/car.js` `carPresent()`, after 5 s). Once the car is there, everything
  is real; a value the car doesn't give (yet) shows "--" with a short reason in its place ("reading…", "paused - parked",
  "no 48 V battery", "no reply"), never a made-up number. Always: all demo. Never: no demo. The DEMO badge shows exactly
  when the demo is on.
- **Signs.** Both batteries: **+ = into the battery (charging), − = out of it (supplying)**, for current and power, the
  same way eDrive's 12 V page shows the 12 V current. The 48 V current from AA56 is negative while charging (eDrive's
  config note), so the 48 V figures are turned round for display. Charging / supplying: above +1 A / below −1 A; between
  them IDLE. Because AA56's layout is not yet confirmed on a car, the raw AA56 reply is logged once per new shape, so a
  wrong sign or offset shows up in the log on the G26's first run.

## Settings

Chosen from M Vitals' and eDrive's settings (their `app.json` "settings"), keeping only what this screen uses. Unless
marked new, key, label, choices and default are copied from the app named, and the code behind them is the same.

**Gauges (match the car)**

| Key | Label | Choices / default | From | What it does here |
|---|---|---|---|---|
| `engine` | Engine | Auto (from the car) / Diesel / Petrol; Auto | M Vitals | rpm scale and redline profile (`kit/runtime/engine.js`) |
| `redline` | Redline | 0 = Auto, 4000 … rpm; 0 | M Vitals | red zone of the rpm bar and the "shift at" rpm |
| `rpmScale` | Rev scale up to | 0 = Auto, 5000 … 10000; 0 | M Vitals | top of the rpm bar |
| `boostMax` | Boost gauge max | 2.0 / 2.5 / 3.0 … bar; 2.5 | M Vitals | top of the boost bar |
| `boostSource` | Boost from | Auto (first that works) / Sport display / Engine unit; Auto | M Vitals | where boost comes from |
| `maxPower` | Max power (100% on sport display) | 100 … kW; 215 | M Vitals | power from the sport display %, and the power bar's top |
| `powerSource` | Power from | Sport display / Torque x rpm; Sport display | M Vitals | power value |
| `torqueMax` | Torque gauge max | **new**: 400 / 500 / 600 / 700 / 900 Nm; 900 (M Vitals' fixed scale) | new | top of the torque bar (a G26 M440i's 500 Nm fills only half of 900) |
| `maxTorqueKgm` | Torque gauge max (kgm) | as M Vitals, only with torque in kgm | M Vitals | top of the torque bar in kgm |
| `peaks` | Show peak markers | on / off; on | M Vitals | peak markers and the PEAK lines |
| `peakHold` | Peak hold | 5 / 10 / 15 / 30 / 60 s; 15 | M Vitals | how long a peak is held |

**Panels and sources**

| Key | Label | Choices / default | From | What it does here |
|---|---|---|---|---|
| `xdrive` | xDrive card | Auto / Show / Hide (RWD); Auto | M Vitals | Hide: no transfer-case reads, the column shows "RWD" |
| `battery48` | 48 V battery | **new**: Auto / Show / Hide; Auto | new (eDrive's `hybrid` does this for a whole app) | Auto: shown once the 48 V battery answers; Hide (or none found): no 48 V reads, the 12 V panel takes the whole column |

**Units**

| Key | Label | Choices / default | From |
|---|---|---|---|
| `speedUnit` | Speed unit | km/h / mph; km/h | M Vitals |
| `pressUnit` | Pressure unit | bar / psi; bar | M Vitals |
| `powerUnit` | Power unit | kW / hp / PS; kW | M Vitals |
| `torqueUnit` | Torque unit | Nm / lb-ft / kgm; Nm | M Vitals |
| `tempUnit` | Temperature unit | Celsius / Fahrenheit; Celsius | M Vitals / eDrive |

**Screen (the kit handles these, every app lists them)**

| Key | Label | Choices / default | From |
|---|---|---|---|
| `theme` | Colour theme | M Red / M Tricolour / Ice White …; M Tricolour | M Vitals / eDrive |
| `layout` | Screen layout | Full screen / Standard; Full screen | M Vitals / eDrive |
| `renderer` | Renderer | GPU 60 fps / Software; GPU | M Vitals / eDrive |
| `speedRate` | Speed display rate | as M Vitals, under Advanced | M Vitals |
| `advanced` | Advanced settings | off | M Vitals |
| `demo` | Demo data | Auto / Always / Never; Auto | all apps |

Left out on purpose (they belong to pages this screen doesn't have): M Vitals' start page, tyre, thermal, fuel and
ignition settings, oil warning, G-force; eDrive's range, price, charge log, scan and widget settings. eDrive's
diagnostics-page read intervals (`poll`, `slowPoll`) are not settings here: the rates in "Reading" are fixed.

## Left to the builder

- Exact pixel layout inside each column, font sizes, segment counts, as long as the four columns are equal and it
  matches the mockup and M Vitals' look.
- Exact polling intervals within the ranges above.
- Demo data shape (reuse `kit/runtime/sim.js` for the driving values, a simple loop for xDrive and the batteries).
- Whether a value missing on this car (e.g. no 12 V current) leaves "--" or a short reason, as M Vitals' tiles do.
