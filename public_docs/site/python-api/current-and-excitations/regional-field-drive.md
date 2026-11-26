---
title: Regional Field Drive
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Regional field drive

(public-docs-python-api-current-and-excitations-regional-field-drive)=
(python-api-current-and-excitations-regional-field-drive-problem-statement)=
## Problem statement

Fullmag provides two typed, region-aware field-drive authoring contracts that inject spatially and temporally modulated applied magnetic induction $\mathbf{B}_{\mathrm{drive}}(\mathbf{x}, t)$ into dynamic LLG stages:

1. **Parametric regional drives (`fm.RegionalFieldDrive`, `fm.GaussianPlaneWaveAntenna`)**: combine a `fm.FieldTarget`, analytical `spatial_profile` (`fm.UniformFieldProfile`, `fm.SincFieldProfile`, `fm.GaussianPlaneWaveFieldProfile`, or `fm.GeometryMaskFieldProfile`), and `TimeDependence` waveform.
2. **Arbitrary-mask field drives (`fm.MaskAntenna`, `fm.VectorMask`, `fm.mask`, `fm.time`, `fm.space_time`, `fullmag.antennas.gaussian_k_source`)**: sum up to `MAX_MASK_TERMS = 8` separable terms $\sum_k \mathbf{M}_k(\mathbf{x})\,g_k(t)$ built from AST-compiled Python mask/time functions or discrete 3D voxel grids (`study.new_vector_mask(...)`), with stage-level lifecycle controls (`study.stages.add_field_drive`, `update_field_drive`, `remove_field_drive`).

Construction validates targets, amplitudes, unit directions, profile parameters, and AST expression safety in Python; calling `to_ir()` emits canonical `ProblemIR` records (`kind="regional"` or `mask_field_drive.v1`).

(python-api-current-and-excitations-regional-field-drive-governing-equations)=
## Governing equations

`fm.RegionalFieldDrive` adds a spatially and temporally modulated applied induction $\mathbf{B}_{\mathrm{drive}}(\mathbf{x}, t) = B_0\,s(\mathbf{x})\,w(t)\,\hat{\mathbf{d}}$ on the selected global, object, or region target, while `fm.MaskAntenna` evaluates $\mathbf{B}_{\mathrm{drive}}(\mathbf{x}, t) = \sum_{k=1}^{K} \mathbf{M}_k(\mathbf{x})\,g_k(t)$ ($K \le 8$) inside its support shape. Both convert to an effective Zeeman field contribution $\mathbf{H}_{\mathrm{drive}} = \mathbf{B}_{\mathrm{drive}} / \mu_0$ inside the Landau–Lifshitz–Gilbert effective field as documented in {doc}`../../physics/interactions/zeeman/index`.

(python-api-current-and-excitations-regional-field-drive-symbols-and-si-units)=
## Symbols and SI units

- Induction amplitude $B_0$ (`amplitude_B_T`) and vector-mask values $\mathbf{M}_k(\mathbf{x})$ use SI tesla ($\mathrm{T}$); downstream effective fields are expressed in $\mathrm{A\,m^{-1}}$.
- Spatial scales (`period_m`, `center_m`, `width_m`, `center_x_m`, `center_y_m`, `carrier_origin_x_m`, `sigma_x_m`, `sigma_y_m`, `fwhm_y_m`, `wavelength_m`, `position`, `cell`, `origin`) use metres ($\mathrm{m}$).
- Carrier frequencies (`frequency_hz`, `frequency`) use $\mathrm{Hz}$; phase angles (`phase_rad`, `spatial_phase_rad`, `carrier_phase_rad`) use $\mathrm{rad}$; time offsets (`t0_s`, `t0`) use $\mathrm{s}$.
- Normalized direction $\hat{\mathbf{d}}$, spatial/temporal envelopes, targets, `time_origin`, `activation`, `enabled`, and `migration` metadata are dimensionless ($1$).

(python-api-current-and-excitations-regional-field-drive-assumptions-and-validity)=
## Assumptions and validity

- On `fm.RegionalFieldDrive`, `id` and `name` must be non-empty strings, `amplitude_B_T` must be finite and non-negative, `direction` must be finite with norm $> 10^{-15}$ (normalized to unit length in Python), `target` must be a `fm.FieldTarget`, `spatial_profile` must be one of the four typed profile classes, `waveform` must provide `to_ir()`, `time_origin` must be `"stage_local"` or `"absolute"`, and `migration` (when supplied) accepts only `{"migrated_from": "prescribed_zeeman_mask"}`.
- On `fm.MaskAntenna`, `frame` must be `"local"` or `"world"`, at most `MAX_MASK_TERMS = 8` terms may be added, all terms must be added before registering the antenna on a study (subsequent `.add(...)` calls raise `fm.MaskFunctionError`), `mask` must be a `fm.MaskFunction` or `fm.VectorMask`, and `time` must be a `fm.TimeFunction` or `None` (static).
- `fm.mask`, `fm.time`, and `fm.space_time` parse the source AST of the decorated Python function via `inspect.getsourcelines`; functions must therefore be defined in a Python source file on disk (not an interactive string passed to `exec()`), or built via `fullmag.antennas.gaussian_k_source(...)` or `study.new_vector_mask(...)`.

(python-api-current-and-excitations-regional-field-drive-python-api)=
## Python API

### Constructor or function

`fm.RegionalFieldDrive(*, id, name, target, amplitude_B_T, direction, spatial_profile, waveform, time_origin="stage_local", activation=None, enabled=True, migration=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `id` | `str` | `required` | $1$ | non-empty | stable drive identifier | FEM/FDM CPU/GPU: IR; resolver-specific | `id` |
| `name` | `str` | `required` | $1$ | non-empty | display name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `target` | `FieldTarget` | `required` | $1$ | typed global, object, or region `FieldTarget` | spatial domain target | FEM/FDM CPU/GPU: IR; resolved field drive | `target` |
| `amplitude_B_T` | `float` | `required` | $\mathrm{T}$ | finite and `>= 0` | magnetic induction amplitude | FEM/FDM CPU/GPU: IR; resolved field drive | `amplitude_B_T` |
| `direction` | `Sequence[float]` | `required` | $1$ | finite with norm `> 1e-15`; unit-normalized | polarization direction | FEM/FDM CPU/GPU: IR; resolved field drive | `direction` |
| `spatial_profile` | `FieldSpatialProfile` | `required` | $1$ | `UniformFieldProfile`, `SincFieldProfile`, `GaussianPlaneWaveFieldProfile`, or `GeometryMaskFieldProfile` | spatial envelope | FEM/FDM CPU/GPU: IR; resolved field drive | `spatial_profile` |
| `waveform` | `TimeDependence` | `required` | $1$ | typed waveform exposing `to_ir()` | temporal waveform | FEM/FDM CPU/GPU: IR; resolved field drive | `waveform` |
| `time_origin` | `str` | `"stage_local"` | $1$ | `"stage_local"` or `"absolute"` | time reference origin | FEM/FDM CPU/GPU: IR; resolved field drive | `time_origin` |
| `activation` | `DriveActivation \| None` | `DriveActivation.all_time_evolution()` | $1$ | typed `DriveActivation` when supplied | stage activation scope | FEM/FDM CPU/GPU: IR; resolved field drive | `activation` |
| `enabled` | `bool` | `True` | $1$ | boolean | drive enable flag | FEM/FDM CPU/GPU: IR; resolved field drive | `enabled` |
| `migration` | `dict[str, str] \| None` | `None` | $1$ | `{"migrated_from": "prescribed_zeeman_mask"}` when supplied | legacy migration provenance tag | FEM/FDM CPU/GPU: IR; provenance metadata | `migration` |

### Targets, profiles, activation, and Gaussian plane-wave helper

| Type | Constructor / factories | Role & validation |
|---|---|---|
| `fm.FieldTarget` | `FieldTarget.global_domain()`, `FieldTarget.object(object_id)`, `FieldTarget.region(object_id, region_id)` | scopes any regional, mask, or solved-antenna drive to the whole study, one object, or one named region |
| `fm.UniformFieldProfile` | `fm.UniformFieldProfile()` | spatially constant envelope (`kind="uniform"`) |
| `fm.SincFieldProfile` | `fm.SincFieldProfile(axis, period_m, center_m=0.0, width_m=None, window="none")` | 1D spatial $\operatorname{sinc}$ profile along normalized `axis`; `window` in `{"none", "hann"}` |
| `fm.GaussianPlaneWaveFieldProfile` | `fm.GaussianPlaneWaveFieldProfile(center_x_m, center_y_m, carrier_origin_x_m, sigma_x_m, sigma_y_m, wavelength_m, carrier_phase_rad=0.0)` | Gaussian-windowed spatial carrier for directional spin-wave launching |
| `fm.GeometryMaskFieldProfile` | `fm.GeometryMaskFieldProfile(object_id, envelope=UniformFieldProfile())` | restricts `envelope` to the spatial mask of an authored geometry object |
| `fm.DriveActivation` | `DriveActivation.all_time_evolution()`, `DriveActivation.stage_ids(stage_ids)` | applies drive to all time-evolution stages or an explicit unique list of stage IDs |
| `fm.GaussianPlaneWaveAntenna` | `(id, amplitude_B_T, frequency_hz, wavelength_m, sigma_x_m, fwhm_y_m, center_x_m=0.0, center_y_m=0.0, carrier_origin_x_m=0.0, spatial_phase_rad=0.0, phase_rad=0.0, t0_s=0.0, target=..., activation=..., time_origin="stage_local", enabled=True)` | `.to_drives()` expands into a quadrature pair `(drive_x, drive_z)` of `fm.RegionalFieldDrive` instances with `.sigma_y_m` derived from `fwhm_y_m` |

### Arbitrary-mask drives, vector masks, and stage lifecycle helpers

| API surface | Signature / methods | Role & constraints |
|---|---|---|
| `study.add_simpleantenna.arbitrary_mask` (also `magnet.add_simpleantenna.arbitrary_mask`, `region.add_simpleantenna.arbitrary_mask`) | `(target, shape, position=(0,0,0), *, frame="local", time_origin="stage_local", activation=None, name=None, id=None) -> MaskAntenna` | creates a `fm.MaskAntenna` bound to a target and support shape (`Box`, `Cylinder`, etc.) |
| `fm.MaskAntenna` | `.add(mask, time=None, *, name=None)`, `.add_space_time(fn, **values)`, `.with_parameters(*, term=None, mask_parameters=None, time_parameters=None)`, `.terms`, `.term_index(term)` | accumulates up to `MAX_MASK_TERMS = 8` separable `mask(x, y, z) * time(t)` terms; emits `mask_field_drive.v1` |
| `fm.VectorMask` / `study.new_vector_mask` | `VectorMask(size, cell, origin=(0,0,0))`; `.size`, `.cell`, `.origin`, `.array`, `.index2coord(ix, iy, iz)`, `.set_vector(ix, iy, iz, vec)`, `.get_vector(ix, iy, iz)`, `.from_data(...)`, `.from_ir(...)` | tabulated 3D voxel field mask in $\mathrm{T}$ for arbitrary numerical antenna profiles |
| `fm.mask`, `fm.time`, `fm.space_time` | `fm.mask(fn, **values) -> MaskFunction`, `fm.time(fn, **values) -> TimeFunction`, `fm.space_time(fn, **values) -> tuple[tuple[MaskFunction, TimeFunction \| None], ...]` | AST-compiles restricted pure-Python spatial/temporal/separable space-time expressions (`fm.MaskFunctionError` on invalid syntax or unavailable source) |
| `fullmag.antennas.gaussian_k_source` | `(study=None, *, amplitude, wavelength, frequency, fwhm_y, center_x, center_y=0.0, sigma_x=None, t0=0.0, n_layers=None, style="function")` | returns ready-to-add `(MaskFunction \| VectorMask, TimeFunction)` quadrature pairs (`style="function"` or `"loop"`) |
| `fm.field_drive(drive)` & `study.field_drives.add(drive)` | module-level `fm.field_drive(drive)` (active study) or `study.field_drives.add(drive)` | registers a `fm.RegionalFieldDrive` or `fm.MaskAntenna` onto the study |
| `study.stages.add_field_drive` / `update_field_drive` / `remove_field_drive` | `add_field_drive(drive, *, stage_id=None)`, `update_field_drive(drive, *, mask_parameters=None, time_parameters=None, term=None, stage_id=None)`, `remove_field_drive(drive_id, *, stage_id=None)` | activates, retunes parameters of, or removes field drives between sequential study stages |

### Stage-first example

```python
# %%
import fullmag as fm
from fullmag.antennas import gaussian_k_source

study = fm.study("regional-and-mask-drive-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
film = study.geometry(fm.Box(size=(200e-9, 40e-9, 5e-9)), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %%
# 1. Parametric regional field drive
regional = fm.RegionalFieldDrive(
    id="sinc_rf",
    name="Broadband sinc excitation",
    target=fm.FieldTarget.object("film"),
    amplitude_B_T=1.0e-3,
    direction=(0.0, 0.0, 1.0),
    spatial_profile=fm.SincFieldProfile(axis=(1.0, 0.0, 0.0), period_m=40.0e-9, window="hann"),
    waveform=fm.SincPulse(cutoff_hz=20.0e9, t0=0.5e-9),
    activation=fm.DriveActivation.all_time_evolution(),
)
study.stages.add_field_drive(regional)

# 2. Directional Gaussian plane-wave quadrature pair
gpw = fm.GaussianPlaneWaveAntenna(
    id="gpw_launcher",
    amplitude_B_T=0.5e-3,
    frequency_hz=10.0e9,
    wavelength_m=200.0e-9,
    sigma_x_m=30.0e-9,
    fwhm_y_m=100.0e-9,
)
for quad_drive in gpw.to_drives():
    study.stages.add_field_drive(quad_drive)

# 3. Arbitrary mask antenna combining VectorMask + gaussian_k_source + parameter update
mask_ant = study.add_simpleantenna.arbitrary_mask(
    film,
    fm.Box(size=(60e-9, 40e-9, 5e-9)),
    id="custom_mask_ant",
)
vm = study.new_vector_mask(
    size=(4, 2, 1),
    cell=(5e-9, 5e-9, 5e-9),
    origin=(0.0, 0.0, 0.0),
)
vm.set_vector(0, 0, 0, (0.0, 0.0, 1.0e-3))
mask_ant.add(vm, name="static_bias_patch")
for idx, (m_fn, t_fn) in enumerate(
    gaussian_k_source(
        amplitude=1.0e-3,
        wavelength=200.0e-9,
        frequency=10.0e9,
        fwhm_y=100.0e-9,
        center_x=0.0,
    )
):
    mask_ant.add(m_fn, t_fn, name=f"k_quad_{idx}")

study.stages.add_field_drive(mask_ant)
study.stages.add_run(until=1.0e-12, stage_id="drive-10ghz")
study.stages.update_field_drive("custom_mask_ant", term="k_quad_0", time_parameters={"frequency": 12.0e9})
study.stages.add_run(until=1.0e-12, stage_id="drive-12ghz")
study.stages.remove_field_drive("custom_mask_ant")
canonical_ir = regional.to_ir()
```

(python-api-current-and-excitations-regional-field-drive-problem-ir)=
## ProblemIR

`regional.to_ir()` emits a typed dictionary with `"kind": "regional"`, `"id"`, `"name"`, `"enabled"`, `"target"`, `"amplitude_B_T"`, normalized `"direction"`, `"spatial_profile"`, `"waveform"`, `"time_origin"`, `"activation"`, and optional `"migration"`. `mask_ant.to_ir()` emits a `"schema_version": "mask_field_drive.v1"` record containing `"target"`, support `"shape"`, `"position_m"`, `"frame"`, `"time_origin"`, `"activation"`, and `"terms"` (each carrying a `"function"` AST or `"vector_mask"` payload and optional `"time"` function).

(python-api-current-and-excitations-regional-field-drive-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves target scope, spatial envelopes, waveforms, mask-function ASTs, vector masks, stage activation windows, and parameter updates in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, negative amplitudes, zero direction vectors, unsupported `time_origin` or `migration` values, exceeding `MAX_MASK_TERMS`, or mutating a `fm.MaskAntenna` after study registration. `Unsupported combinations` fail closed at the planner or backend boundary.

(python-api-current-and-excitations-regional-field-drive-discrete-realization)=
## Discrete realization

The Python contract supplies drive parameters, spatial AST/voxel masks, and canonical `ProblemIR`; discrete sampling and time-dependent Zeeman field evaluation execute across the four lanes as follows:

| Backend lane | Authoring & IR | Runtime status & discretization notes |
|---|---|---|
| FEM CPU | Supported | Evaluates parametric `fm.RegionalFieldDrive`, `fm.GaussianPlaneWaveAntenna`, and `fm.MaskAntenna` terms at mesh nodes/quadrature points during dynamic LLG stages. |
| FEM GPU | Supported | Evaluates qualified regional and mask field drives on GPU dynamic LLG stages; unsupported combinations fail closed. |
| FDM CPU | Supported | Evaluates parametric regional drives, compiled `fm.MaskFunction`/`fm.TimeFunction` terms, and `fm.VectorMask` grids at FDM cell centers. |
| FDM GPU | Supported | Evaluates qualified regional and mask field drives directly on CUDA during dynamic LLG time stepping. |

(python-api-current-and-excitations-regional-field-drive-implementation-mapping)=
## Implementation mapping

The authoritative Python implementations are `packages/fullmag-py/src/fullmag/model/antenna.py` (`class RegionalFieldDrive`, `class GaussianPlaneWaveAntenna`, `class FieldTarget`, `class DriveActivation`, profile classes), `packages/fullmag-py/src/fullmag/model/mask_field_drive.py` (`class MaskAntenna`), `packages/fullmag-py/src/fullmag/model/vector_mask.py` (`class VectorMask`), `packages/fullmag-py/src/fullmag/model/mask_function.py` (`def mask`, `def time`, `class MaskFunction`, `class TimeFunction`, `class MaskFunctionError`), `packages/fullmag-py/src/fullmag/model/space_time.py` (`def space_time`), `packages/fullmag-py/src/fullmag/antennas.py` (`def gaussian_k_source`), and `packages/fullmag-py/src/fullmag/world.py` (`def field_drive`, `class StudyFieldDriveRegistry`, `class StudyBuilder`).

(python-api-current-and-excitations-regional-field-drive-validation)=
## Validation

Focused repository unit tests covering authoring and IR serialization include `test_global_uniform_sinc_drive_has_canonical_wire_shape` and `test_invalid_inputs_fail_closed`. Live solver execution and device parity require separate backend qualification.

(python-api-current-and-excitations-regional-field-drive-limitations)=
## Limitations and Control Room

Localized regional field drives and mask-based drives are authored in Control Room through `RegionalFieldDrivePanel`, `apps/control-room/src/modules/inspector/inspectors/objects/field-drives/FieldDriveSpec.tsx`, `FieldDriveMaskSpec.tsx`, and `apps/control-room/src/modules/inspector/inspectors/study/stages/AddFieldDriveStageSpec.tsx`, supporting `sinc`, `sinusoidal`, and `piecewise_linear` waveforms with SI unit conversion and live `SincPulsePreview` inspection. Custom Python `fm.mask` / `fm.time` / `fm.space_time` callables and raw `fm.VectorMask` arrays remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| Regional target bounds, drive amplitude, direction, stage add-drive, & analytical/piecewise waveforms | `Model Explorer -> Physics / Drives -> <field_drive>` (`FieldDriveSpec.tsx`, `FieldDriveMaskSpec.tsx`, `AddFieldDriveStageSpec.tsx`, `RegionalFieldDrivePanel`) | `partial` | `runAuthoringMutationWithHistory` on `scene_revision` |
| `fm.mask` / `fm.time` / `fm.space_time` AST callables & `fm.VectorMask` arrays | Python DSL | `Python-only` | Authored directly in Python |

```{image} /_static/images/ui/inspector-antenna-rf-and-waveforms.png
:alt: Control Room Field Drive and Antenna RF waveform inspector panel
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-current-and-excitations-regional-field-drive-scientific-bibliography)=
## Scientific bibliography

- E. C. Stoner and E. P. Wohlfarth, “A mechanism of magnetic hysteresis in heterogeneous alloys,” *Philosophical Transactions of the Royal Society of London. Series A, Mathematical and Physical Sciences* **240**(826), 599–642 (1948), [doi:10.1098/rsta.1948.0007](https://doi.org/10.1098/rsta.1948.0007).
- A. Baker et al., “Proposal of a micromagnetic standard problem for ferromagnetic resonance simulations,” *Journal of Magnetism and Magnetic Materials* **421**, 428–439 (2017), [doi:10.1016/j.jmmm.2016.08.009](https://doi.org/10.1016/j.jmmm.2016.08.009) | [arXiv:1603.05419](https://arxiv.org/abs/1603.05419).

(python-api-current-and-excitations-regional-field-drive-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/antenna.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/antenna.py#L1084) | `class RegionalFieldDrive` | typed regional field-drive constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/antenna.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/antenna.py#L1169) | `class GaussianPlaneWaveAntenna` | directional quadrature plane-wave launcher expanding to `RegionalFieldDrive` pairs |
| [`packages/fullmag-py/src/fullmag/model/antenna.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/antenna.py#L314) | `class FieldTarget` | global, object, and region target selector |
| [`packages/fullmag-py/src/fullmag/model/mask_field_drive.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/mask_field_drive.py#L51) | `class MaskAntenna` | arbitrary multi-term separable mask field drive (`mask_field_drive.v1`) |
| [`packages/fullmag-py/src/fullmag/model/vector_mask.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/vector_mask.py#L51) | `class VectorMask` | 3D tabulated voxel magnetic-induction mask |
| [`packages/fullmag-py/src/fullmag/model/mask_function.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/mask_function.py#L195) | `mask` | AST-compiled spatial mask function decorator (`MaskFunction` / `TimeFunction`) |
| [`packages/fullmag-py/src/fullmag/model/space_time.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/space_time.py#L202) | `space_time` | separable space-time expression compiler |
| [`packages/fullmag-py/src/fullmag/antennas.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/antennas.py#L46) | `gaussian_k_source` | ready-made quadrature Gaussian $k$-source mask/time pairs |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py) | `field_drive` | module-level field-drive registration helper |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py) | `class StudyFieldDriveRegistry` | `study.field_drives` registry handle |
