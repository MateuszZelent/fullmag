---
title: Microstrip Antenna
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-current-and-excitations-microstrip-antenna)=
# Microstrip Antenna

(python-api-current-and-excitations-microstrip-antenna-problem-statement)=
<!-- (problem-statement)= -->
## Contract
`MicrostripAntenna` models a microstrip antenna used by the antenna field source.

(python-api-current-and-excitations-microstrip-antenna-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Antenna field mathematics belongs to {doc}`../../physics/interactions/oersted-field/index`.

(python-api-current-and-excitations-microstrip-antenna-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All geometric dimensions are metres.

(python-api-current-and-excitations-microstrip-antenna-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Width, thickness, and preview length must be positive; height above magnet is non-negative.

(python-api-current-and-excitations-microstrip-antenna-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `MicrostripAntenna.width` | `float` | required | $\mathrm{m}$ | Positive | Strip width | `width` |
| `MicrostripAntenna.thickness` | `float` | required | $\mathrm{m}$ | Positive | Metal thickness | `thickness` |
| `MicrostripAntenna.height_above_magnet` | `float` | required | $\mathrm{m}$ | Non-negative | Vertical offset | `height_above_magnet` |
| `MicrostripAntenna.preview_length` | `float` | required | $\mathrm{m}$ | Positive | Preview length | `preview_length` |
| `MicrostripAntenna.center_x` / `center_y` | `float` | `0.0` | $\mathrm{m}$ | Finite | In-plane center | `center_x/y` |
| `MicrostripAntenna.current_distribution` | `str` | `"uniform"` | $1$ | Supported | Current distribution | `current_distribution` |

### Complete stage-first context

The antenna is attached to an antenna field source.

```python
# %% Microstrip antenna field source
import fullmag as fm

nm = 1.0e-9

study = fm.study("microstrip_antenna_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

nm = 1.0e-9

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()

antenna = fm.MicrostripAntenna(
    width=2.0e-6,
    thickness=100 * nm,
    height_above_magnet=50 * nm,
    preview_length=10.0e-6,
)
study.antenna_field_source(
    name="stripline",
    antenna=antenna,
    drive=fm.RfDrive(current_a=1.0e-3, frequency_hz=5.0e9),
)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(python-api-current-and-excitations-microstrip-antenna-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`MicrostripAntenna.to_ir()` emits `kind="microstrip"` with geometry and current-distribution
fields.

(python-api-current-and-excitations-microstrip-antenna-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Non-positive dimensions and unsupported current distribution fail immediately.

(python-api-current-and-excitations-microstrip-antenna-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The field source solves the antenna model given the drive and airbox factor.

(python-api-current-and-excitations-microstrip-antenna-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/antenna.py` (`class MicrostripAntenna`).

(python-api-current-and-excitations-microstrip-antenna-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-current-and-excitations-microstrip-antenna-limitations)=
<!-- (limitations)= -->
## Limitations
Executed antenna-solver support is backend-dependent.

(python-api-current-and-excitations-microstrip-antenna-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Antenna reference belongs to the Oersted/antenna pages.

(python-api-current-and-excitations-microstrip-antenna-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Microstrip antenna | `packages/fullmag-py/src/fullmag/model/antenna.py` | `class MicrostripAntenna` | Antenna lowering | Ownership test |
