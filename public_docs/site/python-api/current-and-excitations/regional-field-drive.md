---
title: Regional Field Drive
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-current-and-excitations-regional-field-drive)=
# Regional Field Drive

(python-api-current-and-excitations-regional-field-drive-problem-statement)=
<!-- (problem-statement)= -->
## Contract
`RegionalFieldDrive` declares a spatially regional, time-dependent magnetic-field drive.

(python-api-current-and-excitations-regional-field-drive-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
The drive contributes a prescribed B-field to the effective field; the field equations belong to
the Zeeman/antenna contracts.

(python-api-current-and-excitations-regional-field-drive-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Amplitude is a flux density in tesla; profile lengths are in metres; time origins in seconds.

(python-api-current-and-excitations-regional-field-drive-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Non-negative amplitude, finite direction, and a typed profile/waveform are validated.

(python-api-current-and-excitations-regional-field-drive-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `RegionalFieldDrive.id` / `name` | `str` | required | $1$ | Non-empty | Identity | `id`, `name` |
| `RegionalFieldDrive.target` | `FieldTarget` | required | $1$ | Typed target | Field target | `target` |
| `RegionalFieldDrive.amplitude_B_T` | `float` | required | $\mathrm{T}$ | Non-negative | Amplitude | `amplitude_B_T` |
| `RegionalFieldDrive.direction` | `tuple[float,float,float]` | required | $1$ | Finite length-3 | Drive direction | `direction` |
| `RegionalFieldDrive.spatial_profile` | `FieldSpatialProfile` | required | mixed | Typed profile | Spatial profile | `spatial_profile` |
| `RegionalFieldDrive.waveform` | `TimeDependence` | required | mixed | Typed waveform | Time waveform | `waveform` |
| `RegionalFieldDrive.time_origin` | `str` | `"stage_local"` | $1$ | Supported origin | Time origin | `time_origin` |
| `RegionalFieldDrive.activation` | `DriveActivation` | all-time | $1$ | Typed | Stage activation | `activation` |

### Complete stage-first context

Regional drives are registered as field-drive modules and activated by stages.

```python
# %% Uniform regional field drive
import fullmag as fm

nm = 1.0e-9

study = fm.study("regional_field_drive_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()

drive = fm.RegionalFieldDrive(
    id="antenna_drive",
    name="antenna_drive",
    target=fm.FieldTarget.global_domain(),
    amplitude_B_T=1.0e-3,
    direction=(0.0, 1.0, 0.0),
    spatial_profile=fm.UniformFieldProfile(),
    waveform=fm.Sinusoidal(frequency_hz=2.0e9, phase_rad=0.0),
)
study.stages.add_field_drive(drive)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(python-api-current-and-excitations-regional-field-drive-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The drive lowers to a `"kind": "regional"` field-drive entry with target, amplitude, direction,
profile, waveform, origin, and activation.

(python-api-current-and-excitations-regional-field-drive-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Negative amplitude, malformed direction, and untyped profile/waveform fail immediately.

(python-api-current-and-excitations-regional-field-drive-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The drive evaluates at cell/node locations according to the target and profile.

(python-api-current-and-excitations-regional-field-drive-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/antenna.py` (`class RegionalFieldDrive`).

(python-api-current-and-excitations-regional-field-drive-validation)=
<!-- (validation)= -->
## Validation
Ownership and field-drive tests compare this inventory with live signatures.

(python-api-current-and-excitations-regional-field-drive-limitations)=
<!-- (limitations)= -->
## Limitations
A regional drive is not a hidden parameter of `Zeeman`; it has its own output and source map.

(python-api-current-and-excitations-regional-field-drive-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Field-drive physics belongs to the Zeeman/antenna pages.

(python-api-current-and-excitations-regional-field-drive-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Regional drive | `packages/fullmag-py/src/fullmag/model/antenna.py` | `class RegionalFieldDrive` | Drive lowering | Ownership test |
