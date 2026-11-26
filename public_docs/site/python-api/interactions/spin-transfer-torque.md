---
title: Spin-Transfer Torque Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Spin-transfer torque

(stt-api-problem-statement)=
## Problem statement

The spin-transfer torque (STT) classes `fm.SlonczewskiSTT`, `fm.ZhangLiSTT`, and `fm.InterfaceCppSTT` (plus `fm.TimeExpression` for time-modulated prescribed Slonczewski current density) are registered on a study via `study.spin_torque(module)` (or flat `fm.spin_torque(module)`). Both legacy object-level fields and canonical versioned module contracts are retained, and mutually exclusive current definitions fail closed.

This page covers the Python authoring contract: construction validates mutually exclusive current definitions, polarization/stack/interface axes, formula-specific constants, and time expressions in Python, while `to_ir_module()` emits the canonical `ProblemIR` module record.

(python-api-interactions-spin-transfer-torque-governing-equations)=
## Governing equations

Slonczewski and interface CPP spin-transfer torques describe damping-like and field-like angular momentum transfer from a spin-polarized current orthogonal or transverse to a fixed polarizer $\hat{\mathbf{p}}$, while Zhang–Li torque models adiabatic $(\mathbf{u}\cdot\nabla)\mathbf{m}$ and non-adiabatic $-\beta\,\mathbf{m}\times(\mathbf{u}\cdot\nabla)\mathbf{m}$ spin drift in smoothly varying magnetization textures. Continuum equations and formula versions (`slonczewski.fullmag.v2`, `zhang_li.fullmag.v1`, `zhang_li.mumax3.v1`) are documented in {doc}`../../physics/interactions/spin-transfer-torque/index`.

(python-api-interactions-spin-transfer-torque-symbols-and-si-units)=
## Symbols and SI units

Prescribed current density (`current_density`) is authored in amperes per square metre ($\mathrm{A\,m^{-2}}$), `free_layer_thickness_m` ($t_F$) in metres ($\mathrm{m}$), and `TimeExpression.event_times_s` in seconds ($\mathrm{s}$). `current_source`, `id`, `target`, `interface_id`, `fixed_layer_position`, `operator_version`, `spin_polarization` ($\hat{\mathbf{p}}$), `stack_normal` ($\hat{\mathbf{n}}_{\mathrm{stack}}$), `interface_normal` ($\hat{\mathbf{n}}_{\mathrm{if}}$), `degree` ($P$), `lambda_asymmetry` ($\Lambda$), `epsilon_prime` ($\epsilon'$), `beta` / `xi` ($\beta$), `lande_g` ($g$), and `TimeExpression` multipliers are dimensionless ($1$).

(python-api-interactions-spin-transfer-torque-assumptions-and-validity)=
## Assumptions and validity

- `current_density` and `current_source` are strictly mutually exclusive across all three STT classes; exactly one must be provided.
- `degree` ($P$) must satisfy $0 < P \le 1$; `lambda_asymmetry` ($\Lambda$) must be finite with $\Lambda \ge 1$; `epsilon_prime` is validated finite on `SlonczewskiSTT` (converted via `float` on `InterfaceCppSTT`); `beta` (and MuMax3/amumax alias `xi`) must satisfy $\beta \ge 0$ (passing conflicting non-zero `beta` and `xi` raises `ValueError`).
- **`SlonczewskiSTT` canonical v2 vs legacy v0 mode**: supplying any of `id`, `target`, `stack_normal`, or `interface_id` activates canonical `slonczewski.fullmag.v2` (`schema_version="slonczewski_torque.v1"`), which requires `id`, `target: RegionRef`, and `stack_normal`, normalizes `spin_polarization` and `stack_normal` via `_normalized_axis` ($\lVert\mathbf{v}\rVert > 10^{-12}$), forbids legacy `fixed_layer_position`, and requires **either** `free_layer_thickness_m > 0` (`slonczewski_thin_layer_homogenized.v1`) **or** `interface_id` (`slonczewski_interface_flux.v1`, never both). In legacy v0 mode, `spin_polarization` uses `as_vector3` (length-3 float conversion only) and `fixed_layer_position` must be `"top"` (default) or `"bottom"`.
- **`TimeExpression`**: requires canonical thin-layer `SlonczewskiSTT` with prescribed `current_density` and `interface_id=None`. `source` must be non-empty ASCII ($\le 1024$ chars); `constants` admits $\le 64$ finite bindings excluding reserved names `t`, `pi`, `e`; `event_times_s` admits $\le 4096$ non-negative strictly increasing finite timestamps.
- **`ZhangLiSTT` canonical v1 vs legacy v0 mode**: supplying any of `id`, `target`, `lande_g`, or `operator_version` activates canonical `zhang_li_torque.v1` requiring `id`, `target: RegionRef`, and positive `lande_g`. `operator_version` must be `"zl_central_reference_v1"` (default in canonical mode, `zhang_li.fullmag.v1`) or `"zl_mumax3_central_v1"` (`zhang_li.mumax3.v1`, which strictly requires `lande_g=2.0`).
- **`InterfaceCppSTT`**: semantic placeholder lowering to `kind="interface_cpp"`; `spin_polarization` and `interface_normal` use `as_vector3`.

(python-api-interactions-spin-transfer-torque-python-api)=
## Python API

### Constructors and study helpers

- `fm.SlonczewskiSTT(current_density=None, spin_polarization=(0.0, 0.0, 1.0), degree=0.4, lambda_asymmetry=1.0, epsilon_prime=0.0, free_layer_thickness_m=None, fixed_layer_position=None, *, current_source=None, id=None, target=None, stack_normal=None, interface_id=None, time_expression=None)`
- `fm.ZhangLiSTT(current_density=None, degree=0.4, beta=0.0, *, xi=None, current_source=None, id=None, target=None, lande_g=None, operator_version=None)`
- `fm.InterfaceCppSTT(current_density=None, spin_polarization=(0.0, 0.0, 1.0), interface_normal=(0.0, 0.0, 1.0), degree=0.4, lambda_asymmetry=1.0, epsilon_prime=0.0, *, current_source=None)`
- `fm.TimeExpression(source, *, constants=None, event_times_s=())`
- `study.spin_torque(module)` (also flat `fm.spin_torque(module)`) and stage toggle `study.stages.set_spin_torque_enabled(module_id=..., enabled=...)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `current_density` | `Sequence[float] \| None` | `None` | $\mathrm{A\,m^{-2}}$ | length-3 vector via `as_vector3`; mutually exclusive with `current_source` | direct prescribed current density vector | FDM CPU/GPU: executable; FEM: IR/planner-gated | `current_density` |
| `current_source` | `str \| None` | `None` | $1$ | non-empty; mutually exclusive with `current_density` | named `CurrentTransport` source identifier | FDM/FEM CPU/GPU: IR; resolver-specific | `current_source` |
| `spin_polarization` | `Sequence[float]` | `(0.0, 0.0, 1.0)` | $1$ | normalized non-zero in canonical `SlonczewskiSTT`; `as_vector3` in legacy/interface mode | fixed-layer polarization direction | FDM CPU/GPU: executable; FEM: IR | `spin_polarization` |
| `degree` | `float` | `0.4` | $1$ | $0 < P \le 1$ | spin polarization efficiency $P$ | FDM CPU/GPU: executable; FEM: IR | `degree` |
| `lambda_asymmetry` | `float` | `1.0` | $1$ | finite $\Lambda \ge 1$ | Slonczewski asymmetry parameter $\Lambda$ | FDM CPU/GPU: executable; FEM: IR | `lambda_asymmetry` |
| `epsilon_prime` | `float` | `0.0` | $1$ | finite scalar | field-like spin-transfer efficiency $\epsilon'$ | FDM CPU/GPU: executable; FEM: IR | `epsilon_prime` |
| `free_layer_thickness_m` | `float \| None` | `None` | $\mathrm{m}$ | strictly positive; required in canonical thin-layer mode, forbidden with `interface_id` | free-layer thickness $d$ | FDM CPU/GPU: executable; FEM: IR | `free_layer_thickness_m` |
| `fixed_layer_position` | `str \| None` | `None` (`"top"` in legacy v0) | $1$ | `"top"` or `"bottom"`; legacy-only (forbidden in canonical v2 mode) | legacy stack ordering controlling torque sign | FDM CPU/GPU: legacy executable path | `fixed_layer_position` |
| `id` | `str \| None` | `None` | $1$ | non-empty; required in canonical `SlonczewskiSTT` and `ZhangLiSTT` | stable torque module identifier | FDM CPU/GPU: executable; FEM: IR | `id` |
| `target` | `RegionRef \| None` | `None` | $1$ | `RegionRef`; required in canonical `SlonczewskiSTT` and `ZhangLiSTT` | target magnetic object or region | FDM CPU/GPU: executable; FEM: IR | `target` |
| `stack_normal` | `Sequence[float] \| None` | `None` | $1$ | finite non-zero normalized unit vector; required in canonical `SlonczewskiSTT` | multilayer stack normal for canonical Slonczewski torque | FDM CPU/GPU: executable; FEM: IR | `stack_normal` |
| `interface_id` | `str \| None` | `None` | $1$ | non-empty when supplied; mutually exclusive with `free_layer_thickness_m` and `time_expression` | selects `slonczewski_interface_flux.v1` realization | FEM/FDM CPU/GPU: IR; planner-gated | `realization.interface_id` |
| `time_expression` | `TimeExpression \| None` | `None` | $1$ | `TimeExpression`; requires canonical thin-layer `SlonczewskiSTT` with prescribed `current_density` | dimensionless multiplier sampled at RK substeps in cumulative seconds | FDM GPU CUDA FP64 RK45 (`extended` mode); other lanes fail closed | `time_expression` |
| `beta` | `float` | `0.0` | $1$ | $\beta \ge 0$ (`ZhangLiSTT`) | non-adiabaticity parameter $\beta$ | FDM CPU/GPU: executable; FEM: IR | `beta` |
| `xi` | `float \| None` | `None` | $1$ | $\xi \ge 0$; MuMax3 alias for `beta`; conflicts if different from non-zero `beta` | alias for Zhang–Li non-adiabaticity parameter | FDM CPU/GPU: lowers into `beta` | `beta` |
| `lande_g` | `float \| None` | `None` | $1$ | strictly positive; required in canonical `ZhangLiSTT` (`2.0` required for `zl_mumax3_central_v1`) | Landé $g$-factor | FDM CPU/GPU: executable; FEM: IR | `lande_g` |
| `operator_version` | `str \| None` | `None` | $1$ | `"zl_central_reference_v1"` or `"zl_mumax3_central_v1"` | canonical Zhang–Li spatial/formula realization | FDM CPU/GPU: executable; FEM: IR | `operator_version` |
| `interface_normal` | `Sequence[float]` | `(0.0, 0.0, 1.0)` | $1$ | length-3 sequence via `as_vector3` (`InterfaceCppSTT`) | CPP interface normal vector | FEM/FDM CPU/GPU: semantic placeholder IR | `interface_normal` |

### `TimeExpression` parameters

| Python name | Type | Default | SI unit | Validation | Meaning | ProblemIR destination |
|---|---|---|---|---|---|---|
| `fm.TimeExpression.source` | `str` | `required` | $1$ | non-empty ASCII string, $\le 1024$ chars | scalar expression of cumulative physical time `t` | `time_expression.source` |
| `fm.TimeExpression.constants` | `Mapping[str, float] \| None` | `None` | $1$ | $\le 64$ finite bindings; valid identifiers excluding `t`, `pi`, `e` | named scalar constants bound in `source` | `time_expression.constants` |
| `fm.TimeExpression.event_times_s` | `Sequence[float]` | `()` | $\mathrm{s}$ | $\le 4096$ non-negative strictly increasing finite timestamps | discontinuity/switching event timestamps for adaptive steppers | `time_expression.event_times_s` |

### Stage-first example

```python
# %% Stage-first canonical Slonczewski and Zhang-Li STT authoring
import fullmag as fm

study = fm.study("stt_canonical_switching")
study.engine("fdm")
study.device("cpu", precision="double")
study.objects.mesh.defaults(cell_size=(4.0e-9, 4.0e-9, 2.0e-9))

free = study.geometry(fm.Box(size=(64.0e-9, 32.0e-9, 2.0e-9)), name="free_layer")
free.Ms = 800.0e3
free.Aex = 13.0e-12
free.alpha = 0.02
free.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag()

# Canonical thin-layer Slonczewski STT with a time-modulated current envelope
pulse_expr = fm.TimeExpression(
    "1.0 if t < t_off else 0.0",
    constants={"t_off": 1.0e-9},
    event_times_s=(1.0e-9,),
)
slonczewski = study.spin_torque(
    fm.SlonczewskiSTT(
        current_density=(0.0, 0.0, 1.0e11),
        spin_polarization=(0.0, 0.0, 1.0),
        degree=0.56,
        lambda_asymmetry=1.5,
        epsilon_prime=0.1,
        free_layer_thickness_m=2.0e-9,
        id="mtj_cpp_stt",
        target=fm.RegionRef("free_layer"),
        stack_normal=(0.0, 0.0, 1.0),
        time_expression=pulse_expr,
    )
)

# Canonical MuMax3-compatible Zhang-Li STT
zhang_li = fm.ZhangLiSTT(
    current_density=(5.0e11, 0.0, 0.0),
    degree=0.7,
    xi=0.05,
    id="cip_zl_stt",
    target=fm.RegionRef("free_layer"),
    lande_g=2.0,
    operator_version="zl_mumax3_central_v1",
)

study.stages.add_relax(stage_id="relax_init", dt=5.0e-13, max_steps=50)
study.stages.add_run(stage_id="switch_pulse", until=2.0e-9)

# %% Canonical ProblemIR inspection
slon_ir = slonczewski.to_ir_module()
zl_ir = zhang_li.to_ir_module()
cpp_ir = fm.InterfaceCppSTT(
    current_density=(0.0, 0.0, 1.0e10),
    spin_polarization=(0.0, 0.0, 1.0),
    interface_normal=(0.0, 0.0, 1.0),
).to_ir_module()
```

(python-api-interactions-spin-transfer-torque-problem-ir)=
## ProblemIR

`to_ir_module()` emits:
- `SlonczewskiSTT`: `"kind": "slonczewski"`, `"formula_version"` (`"slonczewski.fullmag.v2"` or `"slonczewski.legacy_fullmag.v0"`), and in canonical mode `"schema_version": "slonczewski_torque.v1"`, `"id"`, `"target"`, `"stack_normal"`, `"realization"` (`thin_layer_homogenized` or `interface_flux`), and optional `"time_expression"`.
- `ZhangLiSTT`: `"kind": "zhang_li"`, `"formula_version"` (`"zhang_li.fullmag.v1"`, `"zhang_li.mumax3.v1"`, or `"zhang_li.legacy_fullmag.v0"`), and in canonical mode `"schema_version": "zhang_li_torque.v1"`, `"id"`, `"target"`, `"operator_version"`, and `"lande_g"`.
- `InterfaceCppSTT`: `"kind": "interface_cpp"`, `"spin_polarization"`, `"interface_normal"`, `"degree"`, `"lambda_asymmetry"`, `"epsilon_prime"`, and the active current binding.

(python-api-interactions-spin-transfer-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves formula version, realization/operator version, target scope, polarization/stack parameters, `TimeExpression`, and current definitions independently of `resolved execution`. `Validation errors` reject conflicting `current_density`/`current_source`, conflicting `beta`/`xi`, mixing `fixed_layer_position` with canonical `SlonczewskiSTT`, mixing `interface_id` with `free_layer_thickness_m` or `time_expression`, `lande_g != 2.0` under `zl_mumax3_central_v1`, or zero polarization/stack axes in canonical mode. `Unsupported combinations` (such as `InterfaceCppSTT` runtime execution or `time_expression` outside CUDA FP64 RK45 `extended` mode) fail closed at planning.

(python-api-interactions-spin-transfer-torque-discrete-realization)=
## Discrete realization

The Python contract supplies canonical spin-transfer module data in `ProblemIR` only; evaluating localized thin-layer fluxes, Zhang–Li spatial gradients, and LLG torque prefactors is owned by the solver backends. On FDM GPU, PR `#562` fuses prescribed FP64 Slonczewski and Zhang–Li spin torques directly into the CUDA RK45 / LLG right-hand-side kernels (`prescribed_spin_torques_fp64.cuh`), avoiding separate kernel launches and host synchronization; see {ref}`numerical-methods-performance-fdm-transport`.

| Solver | Device | `SlonczewskiSTT` | `ZhangLiSTT` | `InterfaceCppSTT` | Performance reference |
|---|---|---|---|---|---|
| `FDM` | `CPU` | Supported (canonical v2 and legacy v0) | Supported (`zl_central_reference_v1`, `zl_mumax3_central_v1`, legacy v0) | IR placeholder; fails closed at runtime | {ref}`numerical-methods-performance-fdm-transport` |
| `FDM` | `GPU` | Supported; fused FP64 CUDA RK45 (PR `#562`); `time_expression` in `extended` mode | Supported; fused FP64 CUDA RK45 (PR `#562`) | IR placeholder; fails closed at runtime | {ref}`numerical-methods-performance-fdm-transport` |
| `FEM` | `CPU` | IR lowered; planner capability-gated | IR lowered; planner capability-gated | IR placeholder; fails closed at runtime | {doc}`../../physics/interactions/spin-transfer-torque/index` |
| `FEM` | `GPU` | IR lowered; planner capability-gated | IR lowered; planner capability-gated | IR placeholder; fails closed at runtime | {doc}`../../physics/interactions/spin-transfer-torque/index` |

(python-api-interactions-spin-transfer-torque-implementation-mapping)=
## Implementation mapping

- STT classes and `TimeExpression`: `packages/fullmag-py/src/fullmag/model/spin_torque.py` (`class SlonczewskiSTT`, `class ZhangLiSTT`, `class InterfaceCppSTT`, `class TimeExpression`).
- Stage-first registration and toggling: `packages/fullmag-py/src/fullmag/world.py` (`class StudyBuilder` method `spin_torque`, `StudyStagesBuilder.set_spin_torque_enabled`).

(python-api-interactions-spin-transfer-torque-validation)=
## Validation

Focused repository unit tests covering STT authoring and lowering include `test_slonczewski_canonical_defaults_and_legacy_fields`, `test_zhang_li_canonical_contract_and_alias_validation`, and `test_interface_cpp_stt_serializes_to_ir`. Live solver runtime parity and Control Room browser behavior require separate qualification.

(python-api-interactions-spin-transfer-torque-limitations)=
## Limitations and Control Room

Slonczewski ($\Lambda$ asymmetry, $\epsilon'$, polarization, free-layer thickness, fixed-layer orientation) and Zhang–Li ($\beta$ non-adiabaticity) spin-transfer torques are editable in Control Room through `SpinTorqueInspectorPanel` (`apps/control-room/src/modules/inspector/inspectors/objects/transport/SpinTorqueSpec.tsx`), bound to prescribed current densities or an upstream `current_transport` record. `TimeExpression`, `InterfaceCppSTT`, or custom spatially resolved polarizer arrays stay `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| `slonczewski` & `zhang_li` parameters and current binding | `Model Explorer -> Physics -> Spin Torque` (`SpinTorqueInspectorPanel`) | `partial` | `runAuthoringMutationWithHistory` on `scene_revision` |
| Spin interface parameters & FEM orientation verification | `SpinInterfaceInspectorPanel` | `partial` | `verifySpinInterfaceMeshOrientation` & scene transaction |
| `TimeExpression`, `InterfaceCppSTT`, and fields without UI widgets | Python DSL | `Python-only` | Author in Python |

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Control Room Spin-Transfer and Spin-Orbit Torque inspector panel
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-interactions-spin-transfer-torque-scientific-bibliography)=
## Scientific bibliography

- J. C. Slonczewski, “Current-driven excitation of magnetic multilayers,” *Journal of Magnetism and Magnetic Materials* **159**(1-2), L1–L7 (1996), [doi:10.1016/0304-8853(96)00062-5](https://doi.org/10.1016/0304-8853(96)00062-5).
- L. Berger, “Emission of spin waves by a magnetic multilayer traversed by a current,” *Physical Review B* **54**(13), 9353–9358 (1996), [doi:10.1103/PhysRevB.54.9353](https://doi.org/10.1103/PhysRevB.54.9353).
- S. Zhang and Z. Li, “Roles of Nonequilibrium Conduction Electrons on the Magnetization Dynamics of Ferromagnets,” *Physical Review Letters* **93**(12), 127204 (2004), [doi:10.1103/PhysRevLett.93.127204](https://doi.org/10.1103/PhysRevLett.93.127204) | [arXiv:cond-mat/0407174](https://arxiv.org/abs/cond-mat/0407174).

(python-api-interactions-spin-transfer-torque-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L455) | `class SlonczewskiSTT` | Slonczewski CPP spin-transfer torque constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L653) | `class ZhangLiSTT` | Zhang–Li CIP spin-transfer torque constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L790) | `class InterfaceCppSTT` | interface-local CPP torque semantic placeholder and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L96) | `class TimeExpression` | cumulative-time scalar multiplier expression for canonical Slonczewski STT |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | `class StudyBuilder` | `study.spin_torque(...)` registration facade |
