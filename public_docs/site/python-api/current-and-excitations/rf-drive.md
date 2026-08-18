---
title: RF Drive
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-current-and-excitations-rf-drive)=
# RF Drive

(python-api-current-and-excitations-rf-drive-problem-statement)=
<!-- (problem-statement)= -->
## Contract
`RfDrive` specifies the current amplitude and waveform that excite an antenna or field source.

(python-api-current-and-excitations-rf-drive-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Antenna-field mathematics belongs to {doc}`../../physics/interactions/oersted-field/index` and the
antenna field-source lane.

(python-api-current-and-excitations-rf-drive-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Current is in amperes; frequency in hertz; phase in radians.

(python-api-current-and-excitations-rf-drive-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
A positive frequency and a typed waveform are validated.

(python-api-current-and-excitations-rf-drive-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `RfDrive.current_a` | `float` | required | $\mathrm{A}$ | Finite float | Drive current | `current_a` |
| `RfDrive.frequency_hz` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive | Sinusoid frequency | waveform |
| `RfDrive.phase_rad` | `float` | `0.0` | $\mathrm{rad}$ | Finite | Sinusoid phase | waveform |
| `RfDrive.waveform` | `TimeDependence \| None` | `None` | typed | Explicit waveform | waveform |

### Complete stage-first context

RF drive is attached to an antenna field source.

```python
# %% RF drive for an antenna source
import fullmag as fm

nm = 1.0e-9

study = fm.study("rf_drive_api_example")
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

drive = fm.RfDrive(current_a=1.0e-3, frequency_hz=2.0e9, phase_rad=0.0)
antenna = fm.MicrostripAntenna(
    width=2.0e-6,
    thickness=100.0e-9,
    height_above_magnet=50.0e-9,
    preview_length=10.0e-6,
)
study.antenna_field_source(name="stripline", antenna=antenna, drive=drive)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(python-api-current-and-excitations-rf-drive-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`RfDrive.to_ir()` emits `current_a` and optional waveform; `frequency_hz`/`phase_rad` lower to a
sinusoidal waveform.

(python-api-current-and-excitations-rf-drive-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Non-positive frequency and untyped waveform fail immediately.

(python-api-current-and-excitations-rf-drive-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The drive is consumed by the antenna field-source solver.

(python-api-current-and-excitations-rf-drive-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/antenna.py` (`class RfDrive`).

(python-api-current-and-excitations-rf-drive-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-current-and-excitations-rf-drive-limitations)=
<!-- (limitations)= -->
## Limitations
Executed antenna-solver support is backend-dependent; planner resolution is authoritative.

(python-api-current-and-excitations-rf-drive-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Antenna-field references belong to the Oersted/antenna pages.

(python-api-current-and-excitations-rf-drive-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| RF drive | `packages/fullmag-py/src/fullmag/model/antenna.py` | `class RfDrive` | Drive lowering | Ownership test |
