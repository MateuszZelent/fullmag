---
title: Spin-Orbit Torque Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Spin-orbit torque

(sot-api-problem-statement)=
## Problem statement

Prescribed spin–orbit torque (SOT) is authored canonically through `fm.PrescribedSpinOrbitTorque` (`prescribed_sot.v1`) paired with a typed target (`fm.RegionRef`), a typed drive (`fm.SignedScalarDrive` with optional `TimeEnvelope`, or `fm.VectorCurrentDrive` bound to a `CurrentTransport` module), and registered via `study.spin_torque(module)`. A deprecated compatibility alias `fm.SpinOrbitTorque(...)` remains available and lowers unconditionally to `PrescribedSpinOrbitTorque`.

This page covers the complete Python authoring contract for prescribed SOT, both drive types, and all canonical `TimeEnvelope` classes.

(python-api-interactions-spin-orbit-torque-governing-equations)=
## Governing equations

Prescribed spin–orbit torque applies damping-like ($\xi_{\mathrm{DL}}$) and field-like ($\xi_{\mathrm{FL}}$) torques proportional to an injected charge current density $\mathbf{J}_c$ over a free layer of thickness $t_F$: $\mathbf{T}_{\mathrm{SOT}} \propto \frac{\hbar}{2 e M_s t_F}\big[\xi_{\mathrm{DL}}\,\mathbf{m}\times(\mathbf{m}\times\hat{\boldsymbol{\sigma}}) + \xi_{\mathrm{FL}}\,\mathbf{m}\times\hat{\boldsymbol{\sigma}}\big]$. Full continuum definitions, sign conventions, and formula versioning are documented in {doc}`../../physics/interactions/spin-orbit-torque/index`.

(python-api-interactions-spin-orbit-torque-symbols-and-si-units)=
## Symbols and SI units

`free_layer_thickness_m` ($t_F$) uses metres ($\mathrm{m}$); `SignedScalarDrive.current_density_Apm2` uses amperes per square metre ($\mathrm{A\,m^{-2}}$). Envelope timestamps (`time_s`, `t_on_s`, `t_off_s`, `center_s`) use seconds ($\mathrm{s}$), frequencies (`frequency_hz`, `bandwidth_hz`) use hertz ($\mathrm{Hz}$), and phase (`phase_rad`) uses radians ($\mathrm{rad}$). `name`, `target`, `xi_dl`, `xi_fl`, unit axes (`sigma`, `drive_direction`, `interface_normal`), and envelope amplitudes/offsets are dimensionless ($1$).

(python-api-interactions-spin-orbit-torque-assumptions-and-validity)=
## Assumptions and validity

- `fm.PrescribedSpinOrbitTorque`: `name` must be non-empty; `target` must be a `RegionRef`; `drive` must be `SignedScalarDrive` or `VectorCurrentDrive`; `xi_dl` and `xi_fl` must be finite; `free_layer_thickness_m` must be strictly positive.
- `fm.SignedScalarDrive`: `current_density_Apm2` must be finite; `sigma` is validated finite with norm $> 10^{-12}$ (`PRESCRIBED_SOT_V1_EPSILON_AXIS`) and normalized to unit vector `sigma_hat`; optional `envelope` must be a canonical `TimeEnvelope`.
- `fm.VectorCurrentDrive`: `current_source` must be non-empty; `drive_direction` and `interface_normal` must each be finite with norm $> 10^{-12}$, are normalized to unit vectors, and must not be parallel ($\lVert\hat{\mathbf{n}}\times\hat{\mathbf{d}}\rVert > 10^{-12}$).
- `fm.SpinOrbitTorque` (deprecated): emits `DeprecationWarning`, requires explicit `target=RegionRef(...)`, and lowers into `PrescribedSpinOrbitTorque`. When `current_source` is given, explicit `drive_direction` and `interface_normal` are required and `spin_polarization` is forbidden.
- `TimeEnvelope` classes validate finite values, `frequency_hz >= 0` (`SinusoidalEnvelope`), `t_off_s > t_on_s` (`PulseEnvelope`), strictly increasing `time_s` (`PiecewiseLinearEnvelope`), required positive `bandwidth_hz` (`SincEnvelope`), and `interpolation in {"linear", "previous"}`, `extrapolation in {"zero", "hold", "error"}` (`TabulatedEnvelope`).

(python-api-interactions-spin-orbit-torque-python-api)=
## Python API

### Constructors, drives, and time envelopes

- `fm.PrescribedSpinOrbitTorque(name, target, drive, *, xi_dl, xi_fl=0.0, free_layer_thickness_m)`
- `fm.SpinOrbitTorque(charge_current_density_a_per_m2=None, damping_like_efficiency=0.0, spin_polarization=None, ferromagnet_thickness_m=1e-9, field_like_efficiency=0.0, *, name="prescribed_sot", target=None, current_source=None, drive_direction=None, interface_normal=None)` *(deprecated alias)*
- `fm.SignedScalarDrive(current_density_Apm2, sigma, envelope=None)`
- `fm.VectorCurrentDrive(current_source, drive_direction, interface_normal)`
- `fm.TimeEnvelope = fm.ConstantEnvelope | fm.SinusoidalEnvelope | fm.PulseEnvelope | fm.PiecewiseLinearEnvelope | fm.SincEnvelope | fm.TabulatedEnvelope` (with control-point record `fm.TimeEnvelopePoint(time_s, value)`)
- `study.spin_torque(module)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `name` | `str` | `required` | $1$ | non-empty | torque module identifier | FDM CPU/GPU: executable; FEM: IR | `id` |
| `target` | `RegionRef` | `required` | $1$ | typed `RegionRef` | free-layer target | FDM CPU/GPU: executable; FEM: IR | `target` |
| `drive` | `SignedScalarDrive \| VectorCurrentDrive` | `required` | $\mathrm{A\,m^{-2}}$ or $1$ | typed scalar or vector current drive | prescribed current or solved current-source drive | FDM CPU/GPU: executable; FEM: IR | `drive` |
| `xi_dl` | `float` | `required` | $1$ | finite | damping-like SOT efficiency $\xi_{\mathrm{DL}}$ | FDM CPU/GPU: executable; FEM: IR | `xi_dl` |
| `xi_fl` | `float` | `0.0` | $1$ | finite | field-like SOT efficiency $\xi_{\mathrm{FL}}$ | FDM CPU/GPU: executable; FEM: IR | `xi_fl` |
| `free_layer_thickness_m` | `float` | `required` | $\mathrm{m}$ | strictly positive | free-layer thickness $t_F$ | FDM CPU/GPU: executable; FEM: IR | `free_layer_thickness_m` |
| `fm.SignedScalarDrive.current_density_Apm2` | `float` | `required` | $\mathrm{A\,m^{-2}}$ | finite scalar | signed charge current density | FDM CPU/GPU: executable; FEM: IR | `drive.current_density_Apm2` |
| `fm.SignedScalarDrive.sigma` | `Sequence[float]` | `required` | $1$ | finite, norm $> 10^{-12}$, normalized | spin polarization unit axis $\hat{\boldsymbol{\sigma}}$ | FDM CPU/GPU: executable; FEM: IR | `drive.sigma_hat` |
| `fm.SignedScalarDrive.envelope` | `TimeEnvelope \| None` | `None` | $1$ | canonical `TimeEnvelope` when supplied | dimensionless time multiplier for scalar drive | FDM CPU/GPU: executable; FEM: IR | `drive.envelope` |
| `fm.VectorCurrentDrive.current_source` | `str` | `required` | $1$ | non-empty `CurrentTransport` name | upstream vector current source identifier | FDM/FEM CPU/GPU: IR; resolver-specific | `drive.current_source_id` |
| `fm.VectorCurrentDrive.drive_direction` | `Sequence[float]` | `required` | $1$ | finite, norm $> 10^{-12}$, non-parallel to `interface_normal`, normalized | reference charge-current projection axis | FDM/FEM CPU/GPU: IR; resolver-specific | `drive.drive_direction` |
| `fm.VectorCurrentDrive.interface_normal` | `Sequence[float]` | `required` | $1$ | finite, norm $> 10^{-12}$, non-parallel to `drive_direction`, normalized | heavy-metal/ferromagnet interface normal | FDM/FEM CPU/GPU: IR; resolver-specific | `drive.interface_normal` |

### `TimeEnvelope` classes

| Class and signature | Validation | SI units | `to_ir()` `kind` |
|---|---|---|---|
| `fm.TimeEnvelopePoint(time_s, value)` | finite `time_s`, `value` | $\mathrm{s}$, $1$ | point element of `piecewise_linear` |
| `fm.ConstantEnvelope(value)` | finite `value` | $1$ | `"constant"` |
| `fm.SinusoidalEnvelope(amplitude, frequency_hz, phase_rad=0.0, offset=0.0)` | finite scalars; `frequency_hz >= 0` | $1$, $\mathrm{Hz}$, $\mathrm{rad}$, $1$ | `"sinusoidal"` |
| `fm.PulseEnvelope(amplitude, t_on_s, t_off_s)` | finite scalars; `t_off_s > t_on_s` | $1$, $\mathrm{s}$, $\mathrm{s}$ | `"pulse"` |
| `fm.PiecewiseLinearEnvelope(points)` | sequence of `TimeEnvelopePoint` with strictly increasing `time_s` | $\mathrm{s}$, $1$ | `"piecewise_linear"` |
| `fm.SincEnvelope(amplitude, center_s=0.0, bandwidth_hz=None, offset=0.0)` | `bandwidth_hz` required $> 0$; finite `amplitude`, `center_s`, `offset` | $1$, $\mathrm{s}$, $\mathrm{Hz}$, $1$ | `"sinc"` |
| `fm.TabulatedEnvelope(artifact_ref, interpolation="linear", extrapolation="error", bandwidth_hz=None)` | non-empty `artifact_ref`; `interpolation in {"linear", "previous"}`; `extrapolation in {"zero", "hold", "error"}`; optional `bandwidth_hz > 0` | $1$ ($\mathrm{Hz}$ for `bandwidth_hz`) | `"tabulated"` |
| `fm.TimeEnvelope` | union type alias of the 6 envelope classes above | $1$ | nested `"envelope"` or `"time_envelope"` |

### Stage-first example

```python
# %% Stage-first prescribed SOT with SignedScalarDrive and PulseEnvelope
import fullmag as fm

study = fm.study("sot_switching_bilayer")
study.engine("fdm")
study.device("cpu", precision="double")
study.objects.mesh.defaults(cell_size=(4.0e-9, 4.0e-9, 2.0e-9))

film = study.geometry(fm.Box(size=(64.0e-9, 64.0e-9, 2.0e-9)), name="cofeb")
film.Ms = 1.0e6
film.Aex = 15.0e-12
film.alpha = 0.05
film.Ku1 = 8.0e5
film.anisU = (0.0, 0.0, 1.0)
film.m = fm.texture.uniform(0.05, 0.0, 0.998)

study.exchange()
study.demag()
study.b_ext(50.0e-3, 0.0, 0.0)

pulse = fm.PulseEnvelope(amplitude=1.0, t_on_s=0.0, t_off_s=1.0e-9)
sot_scalar = study.spin_torque(
    fm.PrescribedSpinOrbitTorque(
        name="sot_pulse",
        target=fm.RegionRef("cofeb"),
        drive=fm.SignedScalarDrive(
            current_density_Apm2=2.0e11,
            sigma=(0.0, 1.0, 0.0),
            envelope=pulse,
        ),
        xi_dl=0.25,
        xi_fl=-0.05,
        free_layer_thickness_m=2.0e-9,
    )
)

study.stages.add_relax(stage_id="relax_init", dt=5.0e-13, max_steps=50)
study.stages.add_run(stage_id="sot_switch", until=2.0e-9)

# %% VectorCurrentDrive linked to a CurrentTransport source
sot_vec = fm.PrescribedSpinOrbitTorque(
    name="sot_from_charge",
    target=fm.RegionRef("cofeb"),
    drive=fm.VectorCurrentDrive(
        current_source="heavy_metal_charge",
        drive_direction=(1.0, 0.0, 0.0),
        interface_normal=(0.0, 0.0, 1.0),
    ),
    xi_dl=0.25,
    xi_fl=0.0,
    free_layer_thickness_m=2.0e-9,
)
canonical_ir = sot_scalar.to_ir_module()
vector_ir = sot_vec.to_ir_module()
```

(python-api-interactions-spin-orbit-torque-problem-ir)=
## ProblemIR

`PrescribedSpinOrbitTorque.to_ir_module()` (and `SpinOrbitTorque.to_ir_module()`) emits a typed `"kind": "prescribed_sot"` module record (`"schema_version": "prescribed_sot.v1"`, `"formula_version": "prescribed_sot.fullmag.v1"`) containing `"id"`, nested `"target"`, `"drive"` (`"signed_scalar"` with normalized `"sigma_hat"` and optional `"envelope"`, or `"vector_current_source"` with `"current_source_id"`, normalized `"drive_direction"`, and normalized `"interface_normal"`), `"xi_dl"`, `"xi_fl"`, and `"free_layer_thickness_m"`.

(python-api-interactions-spin-orbit-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves target references, drive records, `TimeEnvelope` definitions, efficiencies, and thickness in `ProblemIR` independently of `resolved execution`. `Validation errors` reject untyped targets/drives, zero or parallel drive axes, non-positive `free_layer_thickness_m`, invalid envelope bounds, or deprecated alias misuse. `Unsupported combinations` (such as tabulated envelopes or vector-current bindings on unimplemented lanes) fail closed at planning.

(python-api-interactions-spin-orbit-torque-discrete-realization)=
## Discrete realization

The Python contract supplies typed module inputs in `ProblemIR` only; evaluating SOT source terms and LLG torque contributions on FDM grids or FEM meshes is implemented by the solver backends. On FDM GPU, PR `#562` fuses prescribed FP64 SOT directly into the CUDA RK45 / LLG kernels; see {ref}`numerical-methods-performance-fdm-transport`.

| Solver | Device | `PrescribedSpinOrbitTorque` (`SignedScalarDrive` / `VectorCurrentDrive`) | Performance reference |
|---|---|---|---|
| `FDM` | `CPU` | Supported (prescribed scalar & current-source SOT) | {ref}`numerical-methods-performance-fdm-transport` |
| `FDM` | `GPU` | Supported; fused FP64 CUDA RK45 spin torques (PR `#562`) | {ref}`numerical-methods-performance-fdm-transport` |
| `FEM` | `CPU` | IR lowered; planner capability-gated | {doc}`../../physics/interactions/spin-orbit-torque/index` |
| `FEM` | `GPU` | IR lowered; planner capability-gated | {doc}`../../physics/interactions/spin-orbit-torque/index` |

(python-api-interactions-spin-orbit-torque-implementation-mapping)=
## Implementation mapping

- Canonical SOT, drives, deprecated alias, and all `TimeEnvelope` classes: `packages/fullmag-py/src/fullmag/model/spin_torque.py`.
- Study registration facade: `packages/fullmag-py/src/fullmag/world.py` (`class StudyBuilder` method `spin_torque`).

(python-api-interactions-spin-orbit-torque-validation)=
## Validation

Focused repository unit tests covering `PrescribedSpinOrbitTorque` authoring and wire schema include `test_prescribed_sot_canonical_defaults_and_v1_wire_shape`, `test_prescribed_sot_rejects_invalid_target_and_drive_boundaries`, and `test_prescribed_sot_rejects_legacy_migration_payload`. Live solver runtime parity and Control Room browser behavior require separate qualification.

(python-api-interactions-spin-orbit-torque-limitations)=
## Limitations and Control Room

Prescribed spin–orbit torques (`prescribed_sot`: $\xi_{\mathrm{DL}}$, $\xi_{\mathrm{FL}}$, stack normal, bound to prescribed current density or an upstream `current_transport` source) are edited in Control Room through `SpinTorqueInspectorPanel` (`apps/control-room/src/modules/inspector/inspectors/objects/transport/SpinTorqueSpec.tsx`) under `spin-torque` selection, subject to active-lane capability gating. `TabulatedEnvelope` or spatially varying scripted torque coefficients without inspector widgets remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| `prescribed_sot` efficiencies ($\xi_{\mathrm{DL}}$, $\xi_{\mathrm{FL}}$), normal, & current source binding | `Model Explorer -> Physics -> Spin Torque` (`SpinTorqueInspectorPanel`) | `partial` | `runAuthoringMutationWithHistory` on `scene_revision` |
| `TabulatedEnvelope` & spatial torque coefficient maps without UI fields | Python DSL | `Python-only` | Author in Python |

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Control Room Spin Torque (SOT/STT) and Spin Transport inspector panel
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-interactions-spin-orbit-torque-scientific-bibliography)=
## Scientific bibliography

- A. Manchon, J. Zelezný, I. M. Miron, T. Jungwirth, J. Sinova, A. Thiaville, K. Garello, and P. Gambardella, “Current-induced spin-orbit torques in ferromagnetic and antiferromagnetic systems,” *Reviews of Modern Physics* **91**(3), 035004 (2019), [doi:10.1103/RevModPhys.91.035004](https://doi.org/10.1103/RevModPhys.91.035004) | [arXiv:1801.09636](https://arxiv.org/abs/1801.09636).
- L. Liu, O. J. Lee, T. J. Gudmundsen, D. C. Ralph, and R. A. Buhrman, “Current-Induced Switching of Perpendicularly Magnetized Magnetic Layers Using Spin Torque from the Spin Hall Effect,” *Physical Review Letters* **109**(9), 096602 (2012), [doi:10.1103/PhysRevLett.109.096602](https://doi.org/10.1103/PhysRevLett.109.096602) | [arXiv:1110.6846](https://arxiv.org/abs/1110.6846).
- J. Sinova, S. O. Valenzuela, J. Wunderlich, C. H. Back, and T. Jungwirth, “Spin Hall effects,” *Reviews of Modern Physics* **87**(4), 1213–1260 (2015), [doi:10.1103/RevModPhys.87.1213](https://doi.org/10.1103/RevModPhys.87.1213) | [arXiv:1411.3249](https://arxiv.org/abs/1411.3249).

(python-api-interactions-spin-orbit-torque-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L901) | `class PrescribedSpinOrbitTorque` | canonical prescribed SOT constructor and v1 IR lowering |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L1049) | `class SpinOrbitTorque` | deprecated compatibility alias lowering to `PrescribedSpinOrbitTorque` |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L315) | `class SignedScalarDrive` | signed scalar current density and spin-polarization drive |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L363) | `class VectorCurrentDrive` | current-transport source drive with geometric projection axes |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L150) | `class TimeEnvelopePoint` | `(time_s, value)` control point for piecewise-linear envelopes |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L165) | `class ConstantEnvelope` | constant dimensionless multiplier envelope |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L176) | `class SinusoidalEnvelope` | sinusoidal dimensionless multiplier envelope |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L202) | `class PulseEnvelope` | rectangular pulse dimensionless multiplier envelope |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L226) | `class PiecewiseLinearEnvelope` | piecewise-linear dimensionless multiplier envelope |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L242) | `class SincEnvelope` | normalized sinc dimensionless multiplier envelope |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L273) | `class TabulatedEnvelope` | artifact-backed tabulated multiplier envelope |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L305) | `TimeEnvelope` | union type alias of canonical time-envelope classes |
