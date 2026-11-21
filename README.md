<h1 align="center">Combo</h1>

<p align="center">
  <b>Driving data, performance timing, engine health, seats and the ambient light: one app for the BMW MGU head unit (iDrive 7).</b><br>
  Drawn by its own GPU renderer at 60 fps; reads the car without changing anything in it.
</p>

<p align="center">
  <img src="docs/screens/combo_driving.png" alt="Combo's Driving tab: engine speed, boost, speed and gear, power and torque, xDrive split with the tyres, the 48 V and 12 V batteries" width="100%">
</p>

Combo puts the apps used most into tabs of one app, so the head unit runs one process and one diagnostic link instead
of several. It is this repository's only app: a fork of
[cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps), whose kit (renderer,
runtime, build tools) it is built with. The source repo's own guide (how the head unit works, building, writing your own
app) is in [KIT.md](KIT.md).

**Version 2.5.0.** Developed and tested on a G26 M440i xDrive (B58 with the 48 V mild hybrid, ZF 8HP).

---

## Contents

- [The tabs](#the-tabs)
- [Screen layouts and controls](#screen-layouts-and-controls)
- [Settings](#settings)
- [Install](#install)
- [What Combo reads, and what it doesn't do](#what-combo-reads-and-what-it-doesnt-do)
- [Reporting a problem: the QR log](#reporting-a-problem-the-qr-log)
- [Development](#development)
- [Credits and licences](#credits-and-licences)

---

## The tabs

### Driving

The car's live values in four columns of the same size, in M Vitals' look:

- **Engine speed and boost:** with their peaks, the gear and shift point, and the DME's boost target.
- **Speed, power and torque:** with peaks.
- **xDrive:** the mode, the rear / front split, the torque to the front axle (from the transfer case), the wheel slip
  front against rear, and each tyre's pressure and temperature (`2.7/9`). A tyre more than 0.2 bar under the car's
  target is shown in the warning colour.
- **The batteries:** the 48 V battery of a mild hybrid (charge, charging / supplying, voltage, power, health,
  temperature) over the 12 V battery (charge, voltage, power, health, temperature). A car without 48 V gives the
  column to the 12 V battery.

### Performance

<img src="docs/screens/combo_performance.png" alt="Performance: Virtual Dyno beside the Drag timer" width="100%">

- **Virtual Dyno:** a pull in one gear gives power and torque over rpm (from mass × acceleration × speed), with a
  baseline to compare against.
- **Drag timer:** waits for a standing start, then times the splits (0–50, 0–100, 100–200, 0–200 km/h, ¼ mile) and
  keeps your best times. Optional one-foot rollout.

### Seats

<img src="docs/screens/combo_seats.png" alt="Seats: each motor's position from the driver's and passenger's seat modules" width="100%">

Reading only for now. Combo finds the front seat modules and shows each motor's position on its travel (forward /
back, height, backrest, tilt, thigh support), whether it is moving, and the seat's own switches. On a G26 these are
0x6D (driver) and 0x6E (passenger). Memory 1–3 and easy entry come once the motor command has been confirmed on a car.

### M View

<img src="docs/screens/combo_mview.png" alt="M View: the tyres, engine oil, coolant, gearbox oil, intake air, misfires per cylinder, fuel trims and timing" width="100%">

The engine's and gearbox's health at a glance:

- **Tyres:** pressure against the car's target, and temperature.
- **Temperatures:** engine oil, coolant, gearbox oil and intake air, each with its maximum this drive and a trace.
- **Misfires:** per cylinder this driving cycle, from the engine's own on-board monitors. *Reset misfires* counts
  from then on; nothing is cleared in the car.
- **Fuel trims and timing:** short and long-term fuel trim, and ignition advance. A long-term trim 10 % from zero
  is shown yellow, 20 % red.

### Ambient

<img src="docs/screens/combo_ambient.png" alt="Ambient: the colour ring and brightness, with the side rail open on Colour, Animations and Modes" width="100%">

Any colour on the ambient light, with animations and a look for each driving mode. This is Ambient config's code,
taken from the source repo at build time.

- **Colour:** the whole car or upper / lower lights separately, with brightness.
- **Animations:** moving scenes.
- **Modes:** a look for each driving mode (Sport, Comfort, Eco Pro, Adaptive).
- **Signals:** the turn signals blink the door lines at an even pace of their own, and an open door can show red.

The ambient light runs from the car's start with the app closed. With Ambient config installed too, the app started
first drives the lights and the other leaves them alone.

## Screen layouts and controls

Settings > Screen > **Screen layout** picks one of three:

| Layout | Looks like | Tabs | Reset, Settings |
|---|---|---|---|
| **Full screen** (default) | Combo draws the whole screen | in the header; Ambient's three pages in a side rail | a side rail on the left; Settings is the header's last tab |
| **Map style** | BMW's map: no tabs, the header names the page | a left side bar | a right side bar |
| **Standard** | BMW's own title and bottom bar | in the page | BMW's bottom bar, hidden 5 s after the last touch |

**Map style:**

<img src="docs/screens/combo_map_pages.png" alt="Map style with the left bar open: the pages" width="49%"> <img src="docs/screens/combo_map_actions.png" alt="Map style with the right bar open: Reset misfires and Settings" width="49%">

**Side bars, by touch:** a slim handle on the page's edge opens a bar. It hides again 5 s after the last touch.

**Side bars, with the iDrive controller:**

- Push **left** for the left bar, push **right** for the right bar (map style). The knob lands on the page you're on.
- Turn to move, press to choose.
- Push the other way to close it.
- A bar opened with the controller stays open until you close it or choose something.

**Elsewhere:** the controller moves along the tabs and the page's buttons as in BMW's own apps. BACK leaves the app.

## Settings

<img src="docs/screens/combo_settings.png" alt="Settings in five groups" width="100%">

Five groups:

| Group | What it holds |
|---|---|
| **Gauges** | engine type, redline, rev scale, boost and torque scales, power and boost sources, peak markers and hold, xDrive card, 48 V battery |
| **Dyno & drag** | weight, body shape, drivetrain loss, the ECU torque overlay, the drag split, one-foot rollout |
| **Ambient light** | decor lights with upper or lower, night dimming, your colour back at each start, the car's own door warning, steering wheel side |
| **Units** | speed, pressure, power, torque, temperature |
| **Screen** | colour theme, layout, bottom bar (Standard), renderer, demo data |

**QR log** is at the bottom of Settings (see below).

## Install

You need:

- **A BMW with the MGU head unit (iDrive 7)**, with the MGU Store on it. Root access is needed to install the Store.
  This project does not provide it.
- **From the Store:** the GPU renderer (`idrive7-renderd`, 2.1.18 or newer) and the controller gate
  (`mgu-inputgate`, 1.1.0 or newer). Both come from the source repo.

Then add this repository to the MGU Store (it reads [`mgu-repo.json`](mgu-repo.json)) and install **Combo**. The Store
builds it from this repository's `main` branch, so a merged change is its next version. Combo starts with the car
(the ambient light needs it running) and shows up in *All apps*.

**Demo data** (Settings > Screen) is on while the car sends nothing, so the screens can be tried parked.

## What Combo reads, and what it doesn't do

- **Car signals** over SOME/IP: speed, rpm, gear, torque, temperatures, tyres, driving mode, doors, turn signals, and
  so on.
- **The diagnostic link, read-only:** Combo's link only lets reads out:
  - UDS `22` (read by identifier);
  - OBD `01`, `06` and `09` (current data, on-board monitor results, vehicle information).

  Anything else (sessions, writes, routines, clearing faults) is refused before it leaves the head unit. It is used
  for the values the car doesn't send: front axle torque, battery details, gearbox oil, misfires, fuel trims, the seat
  positions.
- **Reads only while the tab that needs them is on screen,** and none once the car is locked and left, so a parked car
  can sleep.
- **The ambient light is the one thing written:** through the body module, as BMW's own menu does. *Original colour*
  gives the car its own colours back.
- **The seats are read, never moved,** for now.

## Reporting a problem: the QR log

Settings > **QR log** shows the app's recent log as a few QR codes. Photograph every page; the decoder turns the
photos back into the log:

```bash
pip install zxing-cpp pillow
```

```bash
python3 kit/tools/qrlog_decode.py photo1.jpg photo2.jpg ...
```

The log names what the car answered, which reads it refused, and the app's version.

## Development

The code is in [`apps/combo/`](apps/combo). The ambient light's code is in
[`shared/ambient_config/`](shared/ambient_config), and the kit is in [`kit/`](kit).

| File | What it does |
|---|---|
| `main.js` | the tabs, the layouts, the side bars |
| `draw.js` | the Driving tab |
| `perf.js` | Performance |
| `seats.js`, `seatmod.js` | Seats |
| `mview.js` | M View |
| `signals.js` | the car's signals |
| `reads.js` | the diagnostic reads |
| `values.js` | values and peaks |
| `app.json` | settings, signals and read candidates |

Tests run with Node.js, no car needed:

```bash
node kit/tools/test_combo.js
```

```bash
node kit/tools/test_runtime.js
```

```bash
for t in kit/tools/test_*.js; do node "$t" | tail -1; done
```

The head unit runs Node 8: no `?.`, `??`, object spread, `catch {` or `.finally` in the app's code. Building a package
yourself needs BMW's app SDK from your own unit; see [KIT.md](KIT.md).

## Credits and licences

- **Kit, renderer and source apps:** [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps),
  MIT licence (see [LICENSE](LICENSE)). Combo is built on its kit and takes Ambient config's code from it. M Vitals,
  Virtual Dyno and Drag Timer are the source of its Driving and Performance tabs.
- **Seat module identifiers:** from the public [EdiabasX SGBD reference](https://emdzej.github.io/ediabasx-docs-sgbd/)
  (FAS_G11 / BFS_G11).
- **No code** from IterioDev's apps (PolyForm Strict) is used.
- BMW, iDrive and the car's own software, fonts and texts belong to BMW. This is an unofficial project, not affiliated
  with BMW. Use it at your own risk.
