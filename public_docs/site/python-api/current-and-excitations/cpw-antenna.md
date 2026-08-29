---
title: CPW Antenna
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-current-and-excitations-cpw-antenna)=
# CPW Antenna

(python-api-current-and-excitations-cpw-antenna-problem-statement)=
<!-- (problem-statement)= -->
## Contract
`CPWAntenna` models a coplanar-waveguide antenna used by the antenna field source.

(python-api-current-and-excitations-cpw-antenna-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Antenna field mathematics belongs to {doc}`../../physics/interactions/oersted-field/index`.

(python-api-current-and-excitations-cpw-antenna-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All geometric dimensions are in metres; positions are metres.

(python-api-current-and-excitations-cpw-antenna-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Positive signal width, gap, ground width, thickness, and preview length are validated;
height above magnet is non-negative.

(python-api-current-and-excitations-cpw-antenna-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `CPWAntenna.signal_width` | `float` | required | $\mathrm{m}$ | Positive | Signal trace width | `signal_width` |
| `CPWAntenna.gap` | `float` | required | $\mathrm{m}$ | Positive | Signal-ground gap | `gap` |
| `CPWAntenna.ground_width` | `float` | required | $\mathrm{m}$ | Positive | Ground width | `ground_width` |
| `CPWAntenna.thickness` | `float` | required | $\mathrm{m}$ | Positive | Metal thickness | `thickness` |
| `CPWAntenna.height_above_magnet` | `float` | required | $\mathrm{m}$ | Non-negative | Vertical offset | `height_above_magnet` |
| `CPWAntenna.preview_length` | `float` | required | $\mathrm{m}$ | Positive | Preview length | `preview_length` |
| `CPWAntenna.center_x` / `center_y` | `float` | `0.0` | $\mathrm{m}$ | Finite | In-plane center | `center_x/y` |
| `CPWAntenna.current_distribution` | `str` | `"uniform"` | $1$ | Supported | Current distribution | `current_distribution` |

### Complete stage-first context

The antenna is attached to an antenna field source.

```python
# %% CPW antenna field source with RF drive
import fullmag as fm

nm = 1.0e-9

study = fm.study("cpw_antenna_api_example")
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

antenna = fm.CPWAntenna(
    signal_width=200 * nm,
    gap=100 * nm,
    ground_width=2.0e-6,
    thickness=100 * nm,
    height_above_magnet=50 * nm,
    preview_length=10.0e-6,
)
study.antenna_field_source(
    name="cpw",
    antenna=antenna,
    drive=fm.RfDrive(current_a=1.0e-3, frequency_hz=5.0e9),
)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(python-api-current-and-excitations-cpw-antenna-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`CPWAntenna.to_ir()` emits `kind="cpw"` with the geometry and current-distribution fields.

(python-api-current-and-excitations-cpw-antenna-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Non-positive dimensions and unsupported current distribution fail immediately.

(python-api-current-and-excitations-cpw-antenna-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The field source solves the antenna model given the drive and airbox factor.

(python-api-current-and-excitations-cpw-antenna-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/antenna.py` (`class CPWAntenna`).

(python-api-current-and-excitations-cpw-antenna-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-current-and-excitations-cpw-antenna-limitations)=
<!-- (limitations)= -->
## Limitations
Executed antenna-solver support is backend-dependent.

(python-api-current-and-excitations-cpw-antenna-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Antenna reference belongs to the Oersted/antenna pages.

(python-api-current-and-excitations-cpw-antenna-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Field-drive and transport panels cover a partial subset of the excitation API.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> Add field drive / Transport` | `partial` | Submit drive/transport draft; affected stage and field resources are invalidated |
| Parameters without a named UI field | `Model Explorer -> Stages -> Add field drive / Transport` | `TODO` | Python-only until implemented |

TODO: frontend support for excitation parameters without a named drive/transport field.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspector.tsx (TransportAuthoringInspector)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| CPW antenna | `packages/fullmag-py/src/fullmag/model/antenna.py` | `class CPWAntenna` | Antenna lowering | Ownership test |
