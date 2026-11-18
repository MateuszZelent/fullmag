---
title: Regional Field Drive
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Regional field drive

(public-docs-python-api-current-and-excitations-regional-field-drive)=
(python-api-current-and-excitations-regional-field-drive-problem-statement)=
## Problem statement

This is the typed, region-aware field-drive contract; target and waveform remain explicit.

Construction validates typed drive parameters in Python; calling `to_ir()` lowers the object into its canonical `ProblemIR` record for study capture and planner validation.

(python-api-current-and-excitations-regional-field-drive-governing-equations)=
## Governing equations

`RegionalFieldDrive` adds a spatially and temporally modulated applied induction $\mathbf{B}_{\mathrm{drive}}(\mathbf{x}, t) = B_0\,s(\mathbf{x})\,w(t)\,\hat{\mathbf{d}}$ on the selected global, object, or region target, converting to an effective Zeeman field contribution $\mathbf{H}_{\mathrm{drive}} = \mathbf{B}_{\mathrm{drive}} / \mu_0$ inside the Landau–Lifshitz–Gilbert effective field as documented in {doc}`../../physics/interactions/zeeman/index`.

(python-api-current-and-excitations-regional-field-drive-symbols-and-si-units)=
## Symbols and SI units

Induction amplitude $B_0$ (`amplitude_B_T`) uses SI tesla ($\mathrm{T}$); the normalized direction $\hat{\mathbf{d}}$, spatial envelope $s(\mathbf{x})$, temporal waveform $w(t)$, target selectors, time-origin mode, and activation controls are dimensionless ($1$). Downstream effective fields are expressed in $\mathrm{A\,m^{-1}}$.

(python-api-current-and-excitations-regional-field-drive-assumptions-and-validity)=
## Assumptions and validity

`id` and `name` must be non-empty strings, `amplitude_B_T` must be finite and non-negative, `direction` must be finite and non-zero before normalization, and `target`, `spatial_profile`, and `waveform` must be valid typed objects. Invalid or unsupported combinations fail closed during construction or lowering rather than being silently converted.

(python-api-current-and-excitations-regional-field-drive-python-api)=
## Python API

### Constructor or function

`fm.RegionalFieldDrive(*, id, name, target, amplitude_B_T, direction, spatial_profile, waveform, time_origin="stage_local", activation=None, enabled=True, migration=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `id` | `str` | `required` | $1$ | non-empty | stable drive ID | FEM/FDM CPU/GPU: IR; resolver-specific | `id` |
| `name` | `str` | `required` | $1$ | non-empty | display name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `target` | `FieldTarget` | `required` | $1$ | typed global/object/region target | spatial target | FEM/FDM CPU/GPU: IR; resolved field drive | `target` |
| `amplitude_B_T` | `float` | `required` | $\mathrm{T}$ | finite and non-negative | field amplitude | FEM/FDM CPU/GPU: IR; resolved field drive | `amplitude` |
| `direction` | `tuple[float,float,float]` | `required` | $1$ | finite non-zero; normalized | field direction | FEM/FDM CPU/GPU: IR; resolved field drive | `direction` |
| `spatial_profile` | `FieldProfile` | `required` | $1$ | typed profile | spatial envelope | FEM/FDM CPU/GPU: IR; resolved field drive | `profile` |
| `waveform` | `Waveform` | `required` | $1$ | typed waveform with `to_ir` | time envelope | FEM/FDM CPU/GPU: IR; resolved field drive | `waveform` |
| `time_origin` | `str` | `stage_local` | $1$ | `stage_local` or `absolute` | time origin | FEM/FDM CPU/GPU: IR; resolved field drive | `time_origin` |
| `activation` | `Activation or None` | `None` | $1$ | typed activation when supplied | activation window | FEM/FDM CPU/GPU: IR; resolved field drive | `activation` |
| `enabled` | `bool` | `True` | $1$ | boolean | activation flag | FEM/FDM CPU/GPU: IR; resolved field drive | `enabled` |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("public-api-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)
# Author the documented object after the stage exists.
value = fm.RegionalFieldDrive(id="rf", name="rf", target=fm.FieldTarget.global_domain(), amplitude_B_T=1.0e-3, direction=(0.0, 0.0, 1.0), spatial_profile=fm.UniformFieldProfile(), waveform=fm.Constant())
canonical_ir = value.to_ir()
```

In a complete simulation script, register the field drive with the study so it is included in `ProblemIR` capture.

(python-api-current-and-excitations-regional-field-drive-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed dictionary with `"kind": "regional"`, `"id"`, `"name"`, `"enabled"`, `"target"`, `"amplitude_B_T"`, normalized `"direction"`, `"spatial_profile"`, `"waveform"`, `"time_origin"`, and `"activation"`.

(python-api-current-and-excitations-regional-field-drive-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing required fields, non-finite amplitudes or zero direction vectors, and invalid `time_origin` options, while `unsupported combinations` fail closed at the planner or backend boundary.

(python-api-current-and-excitations-regional-field-drive-discrete-realization)=
## Discrete realization

The Python contract supplies drive parameters and canonical `ProblemIR` only; discrete mask/element sampling and time-dependent Zeeman field evaluation are owned by the FEM/FDM backend lanes documented in {doc}`../../physics/interactions/zeeman/index`.

(python-api-current-and-excitations-regional-field-drive-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/antenna.py` (`class RegionalFieldDrive`). Constructor parameters, validation branches, defaults, and `to_ir()` keys follow that class directly.

(python-api-current-and-excitations-regional-field-drive-validation)=
## Validation

Focused repository unit tests covering authoring and IR serialization include `test_global_uniform_sinc_drive_has_canonical_wire_shape` and `test_invalid_inputs_fail_closed`. Live solver execution and device parity require separate backend qualification.

(python-api-current-and-excitations-regional-field-drive-limitations)=
## Limitations and Control Room

Localized or masked regional field drives are authored in Control Room through `RegionalFieldDrivePanel` (`field-drive` selection route), which supports `sinc`, `sinusoidal`, and `piecewise_linear` waveforms with SI unit conversion (`ps`/`ns`, `GHz`/`Hz`, `m`/`nm`, `rad`, `mT`/`T`) and live `SincPulsePreview` inspection. Custom callable expressions or arbitrary coordinate closures remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| Regional target bounds, drive amplitude, direction, & analytical/piecewise waveforms | `Model Explorer -> Physics / Drives -> <field_drive>` (`RegionalFieldDrivePanel`, `SincPulsePreview`) | `partial` | `runAuthoringMutationWithHistory` on `scene_revision` |
| Python callable waveforms or unsupported spatial closures | Python DSL | `Python-only` | Authored directly in Python |

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
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class RegionalFieldDrive` | public constructor and IR lowering |
