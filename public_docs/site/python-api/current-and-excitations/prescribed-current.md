---
title: Prescribed Current
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Prescribed current

(public-docs-python-api-current-and-excitations-prescribed-current)=
(python-api-current-and-excitations-prescribed-current-problem-statement)=
## Problem statement

A prescribed-density `fm.CurrentTransport` module records a spatially uniform current density directly via `model="prescribed_density"`; it is not a silent replacement for a solved Ohmic Poisson problem (see {doc}`current-transport` for full Poisson, structured closure, and external-lead contracts).

Construction validates typed current parameters and optional temporal modulation (`time_envelope`) in Python; calling `to_ir()` lowers the object into its canonical `ProblemIR` record for study capture and planner validation.

(python-api-current-and-excitations-prescribed-current-governing-equations)=
## Governing equations

With `model="prescribed_density"`, `fm.CurrentTransport` defines a spatially uniform charge current density $\mathbf{J}_c(t) = w(t)\,(J_x, J_y, J_z)$ directly without solving the charge conservation PDE $\nabla\cdot(\sigma\nabla V)=0$, where $w(t) = 1$ unless an explicit `time_envelope` is supplied. Downstream modules consume $\mathbf{J}_c(t)$ for spin-transfer torque, spin-orbit torque, spin drift-diffusion, or Oersted field evaluation as documented in {doc}`../../physics/interactions/spin-transfer-torque/index`, {doc}`../../physics/interactions/spin-orbit-torque/index`, and {doc}`../../physics/interactions/oersted-field/index`.

(python-api-current-and-excitations-prescribed-current-symbols-and-si-units)=
## Symbols and SI units

Prescribed charge current density $\mathbf{J}_c$ is authored as a three-component Cartesian vector in $\mathrm{A\,m^{-2}}$; module identifiers (`name`), `model`, `coupling`, and normalized envelope amplitudes (`time_envelope`) are dimensionless ($1$).

(python-api-current-and-excitations-prescribed-current-assumptions-and-validity)=
## Assumptions and validity

- `name` must be non-empty, `current_density` must be a three-component numeric vector when `model="prescribed_density"`, and `coupling` must be `"one_way"` (`"bidirectional"` requires `model="ohmic_poisson"` and raises `ValueError`).
- When supplied, `time_envelope` must be one of the canonical `TimeEnvelope` classes (`fm.ConstantEnvelope`, `fm.SinusoidalEnvelope`, `fm.PulseEnvelope`, `fm.PiecewiseLinearEnvelope`, `fm.SincEnvelope`, or `fm.TabulatedEnvelope`).
- Contradictory options fail closed during construction or lowering rather than silently converting to an Ohmic solve.

(python-api-current-and-excitations-prescribed-current-python-api)=
## Python API

### Constructor or function

`fm.CurrentTransport(*, name, model="prescribed_density", current_density=..., coupling="one_way", time_envelope=None)` (or `study.current_transport(...)`)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `name` | `str` | `required` | $1$ | non-empty | transport module identifier referenced by downstream torque/Oersted modules | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `model` | `str` | `"prescribed_density"` | $1$ | `"prescribed_density"` for uniform prescribed current | current closure model | FEM/FDM CPU/GPU: IR; resolved module | `model` |
| `current_density` | `Sequence[float]` | `required` for `"prescribed_density"` | $\mathrm{A\,m^{-2}}$ | 3-component vector required for `"prescribed_density"` | uniform prescribed charge current density | FEM/FDM CPU/GPU: IR; resolved module | `current_density` |
| `coupling` | `str` | `"one_way"` | $1$ | `"one_way"` ( `"bidirectional"` forbidden for `"prescribed_density"` ) | coupling direction | FEM/FDM CPU/GPU: IR; resolved module | `coupling` |
| `time_envelope` | `TimeEnvelope \| None` | `None` | $1$ | canonical `TimeEnvelope` instance when supplied | temporal envelope modulating $\mathbf{J}_c(t)$ | FEM/FDM CPU/GPU: IR; resolver-specific | `time_envelope` |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("prescribed-current-stt-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
film = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %%
drive_current = study.current_transport(
    name="j_drive",
    model="prescribed_density",
    current_density=(1.0e11, 0.0, 0.0),
    time_envelope=fm.PulseEnvelope(amplitude=1.0, t_on_s=0.0, t_off_s=2.0e-9),
)
study.spin_torque(
    fm.ZhangLiSTT(
        current_source="j_drive",
        degree=0.56,
        beta=0.04,
        id="zl_stt",
        target=fm.RegionRef("film"),
        lande_g=2.0,
    )
)
study.stages.add_run(until=1.0e-12, stage_id="stt-pulse")
canonical_ir = drive_current.to_ir()
```

(python-api-current-and-excitations-prescribed-current-problem-ir)=
## ProblemIR

`drive_current.to_ir()` emits a typed dictionary with `"kind": "current_transport"`, `"name"`, `"model": "prescribed_density"`, `"current_density"`, `"coupling": "one_way"`, and optional `"time_envelope"`.

(python-api-current-and-excitations-prescribed-current-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing current-density vectors, malformed envelope types, and incompatible `coupling="bidirectional"` settings, while `unsupported combinations` fail closed at the planner or backend boundary.

(python-api-current-and-excitations-prescribed-current-discrete-realization)=
## Discrete realization

The Python contract supplies the uniform current density and optional temporal envelope in `ProblemIR`; discrete evaluation of downstream torque or magnetic field terms executes across the four lanes as follows:

| Backend lane | Authoring & IR | Runtime status & discretization notes |
|---|---|---|
| FEM CPU | Supported | Supplies prescribed current density to FEM spin-torque, spin drift-diffusion, and Oersted modules where qualified. |
| FEM GPU | Supported | IR lowering supported; runtime follows FEM GPU transport/torque qualification. |
| FDM CPU | Supported | Direct executable prescribed-density path feeding Zhang–Li STT, Slonczewski STT, prescribed SOT, and M1 spin drift-diffusion. |
| FDM GPU | Supported | Executable GPU prescribed-density path feeding fused FP64 CUDA RK45 spin-torque kernels and CUDA M1 spin transport; see {ref}`numerical-methods-performance-fdm-transport`. |

(python-api-current-and-excitations-prescribed-current-implementation-mapping)=
## Implementation mapping

The authoritative Python implementations are `packages/fullmag-py/src/fullmag/model/current_transport.py` (`class CurrentTransport`) and `packages/fullmag-py/src/fullmag/world.py` (`class StudyBuilder` method `current_transport`).

(python-api-current-and-excitations-prescribed-current-validation)=
## Validation

Focused repository unit tests covering authoring and IR serialization include `test_prescribed_density_serializes_to_ir` and `test_oersted_field_from_current_solution_serializes_to_ir`. Live solver execution and device parity require separate backend qualification.

(python-api-current-and-excitations-prescribed-current-limitations)=
## Limitations and Control Room

Prescribed current densities and upstream current-transport bindings for spin-torque (`SpinAuthoringInspector`: `zhang_li`, `slonczewski`, `prescribed_sot`) and Oersted calculations are configurable in Control Room via `TransportAuthoringInspector` and `SpinAuthoringInspector`. Spatially varying scripted current-density arrays without an exposed UI control remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| Prescribed current density vector / waveform & downstream torque binding | `TransportAuthoringInspector` & `SpinAuthoringInspector` | `partial` | `runAuthoringMutationWithHistory` on `scene_revision` |
| Arbitrary array or callable prescribed current profiles | Python DSL | `Python-only` | Authored directly in Python |

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Control Room Transport and Spin Torque inspectors configuring prescribed current sources and SOT/STT parameters
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-current-and-excitations-prescribed-current-scientific-bibliography)=
## Scientific bibliography

- T. Valet and A. Fert, “Theory of the perpendicular magnetoresistance in magnetic multilayers,” *Physical Review B* **48**(10), 7099–7113 (1993), [doi:10.1103/PhysRevB.48.7099](https://doi.org/10.1103/PhysRevB.48.7099).
- S. Takahashi and S. Maekawa, “Spin injection and detection in magnetic nanostructures,” *Physical Review B* **67**(5), 052409 (2003), [doi:10.1103/PhysRevB.67.052409](https://doi.org/10.1103/PhysRevB.67.052409).

(python-api-current-and-excitations-prescribed-current-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/current_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/current_transport.py#L1466) | `class CurrentTransport` | public prescribed-density constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py) | `class StudyBuilder` | `study.current_transport(...)` study registration helper |
