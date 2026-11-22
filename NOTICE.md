# Licences in this repository

Different parts of this repository are under different licences:

| Part | Licence | File |
|---|---|---|
| **Combo** (`apps/combo/`): the app, its seat memory, easy entry and seat-motor control | PolyForm Noncommercial 1.0.0, © 2026 snorkmitzumi | [apps/combo/LICENSE](apps/combo/LICENSE) |
| **The seat findings** ([docs/seats-ista-findings.md](docs/seats-ista-findings.md)) | CC BY-NC 4.0, © 2026 snorkmitzumi | [LICENSES/CC-BY-NC-4.0.txt](LICENSES/CC-BY-NC-4.0.txt) |
| **Everything else**: the kit (`kit/`, except `kit/renderd/`), `shared/`, the build tools, KIT.md, and the changes this fork made to them | MIT, © cauliflowermossgrape and contributors | [LICENSE](LICENSE) |
| Doom (`third_party/doomgeneric/`) | GPL-2.0 | [its LICENSE](third_party/doomgeneric/LICENSE) |
| The GPU renderer (`kit/renderd/`), a separate program Combo draws through | GPL-3.0-or-later, © Robert Nisipeanu and IterioDev; its parts from the first renderer also MIT | [kit/renderd/LICENSE](kit/renderd/LICENSE), [LICENSE.mgu-renderd](kit/renderd/LICENSE.mgu-renderd) |
| Fonts (Noto Sans SC and others) | SIL Open Font License and others | next to each font in `kit/runtime/fonts/` |

## What the noncommercial licences mean

You may use, change and share Combo and the seat findings for any **noncommercial** purpose: on your own car, for
research or study, or as a hobby. Keep the copyright notice and the licence with every copy.

**Commercial use needs written permission** from snorkmitzumi. That includes selling Combo or a changed version,
charging to install it, shipping it in a product, or using the seat findings in a paid product or service. Ask through
the repository's issues on GitHub.

## Code that stays MIT

Combo is built with the kit of [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
and adapts code from its apps: M Vitals, Virtual Dyno and Drag Timer (the Driving, Performance and M View tabs' looks,
sums and thresholds), and Ambient config (included at build time from `shared/ambient_config/`). That code keeps its
MIT licence. Anything taken from the upstream repository itself can still be used under MIT. The noncommercial
licence covers what this fork wrote. [apps/combo/NOTICE](apps/combo/NOTICE) lists the MIT parts and ships with the
app.

The facts about how the seat modules answer (identifiers, byte layouts, the motor command) are not anyone's
property. The licences cover this repository's code and write-up, not those facts.

## Not BMW

BMW, iDrive, ISTA, ICOM and the car's own software, fonts and texts belong to BMW AG. This is an unofficial project,
not made, endorsed or supported by BMW. The repository contains no BMW software, no app SDK (`oap-sdk` is extracted
from your own head unit and never distributed), and no ISTA files, SGBDs or ISTA traces. The seat identifiers are named
as in the public [EdiabasX SGBD reference](https://emdzej.github.io/ediabasx-docs-sgbd/). No code from IterioDev's apps
(PolyForm Strict) is used in Combo.

## No warranty

Combo moves the front seats with their own motors and writes to the car's ambient light. It is provided as is, without
warranty of any kind, as the licences say. You use it on your own car at your own risk.

This page summarises the licences. If it and a licence text differ, the licence text applies.
