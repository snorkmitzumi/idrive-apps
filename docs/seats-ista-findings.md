# Driving BMW G-series front seats from the head unit: findings

**Author:** snorkmitzumi, 2026. **Car:** G26 M440i xDrive, seat modules FAS_G11 (driver) and BFS_G11 (passenger).
**Licence:** [CC BY-NC 4.0](../LICENSES/CC-BY-NC-4.0.txt). You may share and adapt this write-up for noncommercial
purposes if you credit it and link to this repository. Combo's code that puts it to use is under the PolyForm
Noncommercial licence (see [NOTICE.md](../NOTICE.md)).

This is how Combo moves the front seats: what was learned by watching BMW's workshop software (ISTA) drive the seat
motors over ICOM, and then by testing on the car. Nothing here comes from BMW's software or documents: no ISTA files,
traces, SGBDs or BMW code are included or quoted. The identifier names come from the public
[EdiabasX SGBD reference](https://emdzej.github.io/ediabasx-docs-sgbd/).

> **Warning.** Seat motors are strong enough to hurt someone. Everything below was seen on one car. Other modules,
> variants or software levels may answer differently. Test parked, with the seat empty, and at your own risk.

## The modules

| Address | Module | Seat |
|---|---|---|
| `0x6D` | FAS_G11 | driver |
| `0x6E` | BFS_G11 | passenger |

Both take the same requests. Motors fitted on a G26's seats: SLV (forward / back), SHV (height), LNV (backrest), SNV
(tilt), KHV (headrest). STV, LBV and LKV are not fitted (their state reads `03`, D704 says the motor is missing).

## Reads (`22`)

| DID | What it holds |
|---|---|
| `D702` | the Hall counters: 8 × u16, one per motor (SLV SHV LNV SNV KHV STV LBV LKV), around `0x8000` |
| `D704` | initialisation: data byte 0 must be 1. The learned end stops, as u16 pairs (plus, then minus) per motor, from data byte 48 |
| `D708` | each motor's state: `00` idle, `01` running plus, `02` running minus, `03` not fitted. This also shows moves made with the seat's own switches or memory buttons |
| `D712` | the seat switches: 20 bytes, all zero when nothing is pressed |
| `D70C` | the memory buttons. Writing it only switches a button's LED |

The end stops on the test car's driver seat, in counts from `0x8000`: SLV +526 / −18, SHV +118 / −361, LNV +52 / −1455,
SNV +100 / −110, KHV +132 / −112. Speeds: SLV about 38 counts/s, SHV 62, LNV 59, KHV 80. A motor coasts about a count
after STOP.

## The one write: `2E D7 08`

```
2E D7 08 <motor> <action> <power>
motor:  00 SLV  01 SHV  02 LNV  03 SNV  04 KHV  (05 STV  06 LBV  07 LKV)
action: 00 STOP  01 PLUS  02 MINUS
power:  PWM in %, ISTA sends 64 (100 %)
reply:  6E D7 08
```

What ISTA does, and what turned out to be enough:

- **No diagnostic session, no security access, no tester present.** The module accepts the command in the default
  session and answers positively.
- **A motor runs until it is told to stop.** One kept running for over 8 s until STOP came. So whoever starts a motor
  has to stop it on every way out: at the target, on a switch press, when the car rolls, when the module stops
  answering, and once more when the run ends.
- **Plus** is forward (SLV), up (SHV), backrest upright (LNV) and headrest up (KHV). SNV's direction was not checked.
- ISTA polls `D712` about every 110 ms while a motor runs.

## What the module does with it

- **One diagnostic motor at a time.** Starting a second motor stops the first. The module's own memory recall drives
  two at a time, but the diagnostic command does not. A mover has to detect this (the first motor's state drops to
  `00` when the second starts) and then run the motors one after another.
- **The head unit's transport is busy now and then** and turns requests away (`TEMPORARILY_NOT_ACCEPTED`). Treat that
  as a missed read and send again. Don't end a move on one refusal: the motor is still running.
- **Other traffic on the link gets in the way.** Writes to the body module (Combo's ambient light, a door's red
  blink) crowded the seat reads off the link. Hold them while a seat moves.

## How Combo reaches a position

1. Only when standing still, with the module initialised (`D704` byte 0 = 1), its end stops known and no motor
   running.
2. Every target is kept 3 counts inside the learned end stops.
3. Each motor goes straight to its target. The last stretch is timed from the motor's measured speed. A short move is
   one timed pulse, and how far the pulse went is learned for the next one. Up to three passes correct what is left.
   8 counts is close enough.
4. The coast after STOP is learned per motor, so the motor is stopped that much early.
5. A seat switch, or a motor the run didn't start (the driver's own input, seen in `D708`), ends the run at once.

## What the head unit doesn't offer

The head unit has BMW's own seat interface (`de.bmw.infotainment.misc.SeatFunction`, with the memory buttons and the
module's own recall), but on the test car it is **not offered to apps**. The seat-command proxy
(`SeatCommandProxyCtrl`) is offered, and Combo only reads its status. There is no diagnostic request that starts the
module's own memory recall, so Combo drives the motors itself as described above.

## Never send

These are in the same modules and can lose the seat's learned positions or its setup. Combo refuses them:

| Identifier | What it is |
|---|---|
| `D719` | Hall counter reset |
| `DAFC` | factory defaults |
| routine (`31`) `A703` | initialisation run |
| `D72C` | motor mapping |
| routine (`31`) `4006` | not used by Combo; left alone |

Combo's diagnostic link lets out only reads, plus `2E D7 08` to `0x6D` and `0x6E`.
