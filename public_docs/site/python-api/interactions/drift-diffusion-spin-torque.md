---
title: Drift-diffusion spin torque Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Drift-diffusion spin torque

(public-docs-python-api-interactions-drift-diffusion-spin-torque)=
(python-api-interactions-drift-diffusion-spin-torque-problem-statement)=
## Problem statement

Self-consistent spin drift-diffusion links an authored charge-current transport module, per-region spin transport materials, interface/boundary contracts, and a torque coupling record into the LLG effective field.

This page documents the Python authoring contract for `fm.SpinDriftDiffusion`, its companion LLG torque binder `fm.DriftDiffusionSpinTorque`, study registration via `study.spin_transport(...)` and `study.spin_torque(...)`, and all typed material, interface, boundary, solver, and execution helpers. Construction validates region assignments, constitutive parameters, interface orientation, and regime constraints in Python, while `to_ir()` and `to_ir_module()` emit canonical `spin_transport.v1` and `drift_diffusion_spin_torque.v1` `ProblemIR` records before solver planning.

(python-api-interactions-drift-diffusion-spin-torque-governing-equations)=
## Governing equations

Self-consistent spin drift-diffusion couples charge current continuity $\nabla\cdot\mathbf{J}_c = 0$ with spin-accumulation balance $\nabla\cdot\mathbf{J}_s = -\mathbf{S}(\mathbf{m}, \boldsymbol{\mu}_s)$ (or $C_s\,\partial_t \boldsymbol{\mu}_s + \nabla\cdot\mathbf{J}_s = -\mathbf{S}$ in `"transient"` mode) across multilayer domains and spin-mixing interfaces, producing a local angular-momentum transfer torque $\mathbf{T}_{\mathrm{SDD}} \propto \mathbf{m}\times\boldsymbol{\mu}_s$. Constitutive relations, magnetoelectronic circuit theory interface closures, spin-memory-loss reservoirs, and transient closures are documented in {doc}`../../physics/interactions/drift-diffusion-spin-torque/index`.

(python-api-interactions-drift-diffusion-spin-torque-symbols-and-si-units)=
## Symbols and SI units

Top-level `fm.SpinDriftDiffusion` fields (`id`, `current_source_id`, `domain`, `materials`, `interfaces`, `boundaries`, `solver`, `requested_execution`, `mode`) and `fm.DriftDiffusionSpinTorque` links (`id`, `solve_id`, `target`) are dimensionless identifiers or typed collections ($1$). Nested constitutive and interface types carry SI quantities:

- `fm.SpinTransportMaterial`: spin conductivity $\sigma_s$ (`sigma_s_Spm`) in $\mathrm{S\,m^{-1}}$; dimensionless spin polarization $p \in [-1, 1]$ (`polarization_p`, $1$) and spin Hall angle $\theta_{\mathrm{SH}}$ (`theta_sh`, $1$); spin-flip length $\lambda_{\mathrm{sf}}$ (`lambda_sf_m`), exchange length $\lambda_J$ (`lambda_j_m`), and spin-dephasing length $\lambda_\varphi$ (`lambda_phi_m`) in $\mathrm{m}$; optional transient spin capacitance $C_s$ (`spin_capacitance_As_per_V_m3`) in $\mathrm{A\,s\,V^{-1}\,m^{-3}}$ and per-spin density of states $N_{\mathrm{DOS}}$ (`density_of_states_per_spin_Jinv_m3`) in $\mathrm{J^{-1}\,m^{-3}}$ satisfying $C_s = e^2 N_{\mathrm{DOS}}$.
- `fm.MixingConductanceSpinInterface` and `fm.SpinMemoryLossReservoir`: interfacial conductances `g_up_Spm2`, `g_down_Spm2`, `g_r_Spm2`, `g_i_Spm2`, `g_n_Spm2`, `g_f_Spm2`, `g_lattice_Spm2` in $\mathrm{S\,m^{-2}}$; interface normal `normal_to_ferromagnet` unit-normalized ($1$).
- Spin boundary conditions: `SpecifiedSpinPotential.spin_potential_V` in $\mathrm{V}$; `SpecifiedSpinFlux.normal_spin_flux_Apm2` in $\mathrm{A\,m^{-2}}$; `PeriodicSpin.translation_m` in $\mathrm{m}$.

(python-api-interactions-drift-diffusion-spin-torque-assumptions-and-validity)=
## Assumptions and validity

- `id`, `current_source_id`, `domain`, and `materials` must be non-empty, and every entry of `materials` must be a `fm.SpinTransportMaterialAssignment`.
- `mode` must be `"steady"` or `"transient"`. In `"transient"` mode, every assigned `fm.SpinTransportMaterial` must supply physical capacitance metadata (`spin_capacitance_As_per_V_m3` and/or `density_of_states_per_spin_Jinv_m3` together with `capacitance_formula_version="dos_isotropic_nonmagnetic.fullmag.v1"`); when both are given they must satisfy $C_s = e^2 N_{\mathrm{DOS}}$ within `rel_tol=1e-12`.
- All directional vectors on `fm.SurfaceRef`, `fm.TransparentSpinInterface`, and `fm.MixingConductanceSpinInterface` are validated to be finite with norm $> 10^{-12}$ and normalized to unit vectors in Python.
- `fm.MixingConductanceSpinInterface` requires `g_up_Spm2`, `g_down_Spm2`, and `g_r_Spm2` to be finite and $\ge 0$, `g_i_Spm2` to be finite, and `normal_surface`/`ferromagnet_surface` to be supplied together or both omitted.
- Missing charge-current links, invalid boundary specifications, or unsupported runtime/coupling modes fail closed at construction or planning.

(python-api-interactions-drift-diffusion-spin-torque-python-api)=
## Python API

### Constructor or function

`fm.SpinDriftDiffusion(...)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `id` | `str` | `required` | $1$ | non-empty | spin drift-diffusion solve identifier | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `id` |
| `current_source_id` | `str` | `required` | $1$ | non-empty | charge-current source link (`CurrentTransport.name`) | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `current_source_id` |
| `domain` | `Sequence[RegionRef]` | `required` | $1$ | non-empty | spin transport domain regions | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `domain` |
| `materials` | `Sequence[SpinTransportMaterialAssignment]` | `required` | $1$ | non-empty typed assignments | per-region spin transport materials | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `materials` |
| `interfaces` | `Sequence[TransparentSpinInterface \| MixingConductanceSpinInterface]` | `()` | $1$ | typed interface contracts | internal spin interface conditions | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `interfaces` |
| `boundaries` | `Sequence[_SurfaceBoundary \| PeriodicSpin]` | `()` | $1$ | typed boundary contracts | external and periodic spin boundary conditions | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `boundaries` |
| `solver` | `SpinSolverPolicy \| None` | `SpinSolverPolicy()` | $1$ | typed `SpinSolverPolicy` when supplied | linear and reciprocal nonlinear solver policy | FEM/FDM CPU/GPU: IR; resolver-specific | `solver` |
| `requested_execution` | `TransportExecution \| None` | `TransportExecution()` | $1$ | typed `TransportExecution` when supplied | requested discretization, device, precision, and mode | FEM/FDM CPU/GPU: IR; resolver-specific | `requested_execution` |
| `mode` | `str` | `"steady"` | $1$ | `"steady"` or `"transient"`; `"transient"` requires physical capacitance on every material | time regime | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `mode` |

`fm.SpinDriftDiffusion.to_ir(*, coupling: str | None = None)` accepts `coupling="one_way"` (default, emitting `"constitutive_version": "transport_constitutive.one_way.fullmag.v1"`) or `coupling="bidirectional"` (emitting `"transport_constitutive.reciprocal.fullmag.v1"`).

### Torque binder and study registration

To apply the solved spin accumulation as an LLG torque on a magnetic region, bind the `fm.SpinDriftDiffusion` solve ID via `fm.DriftDiffusionSpinTorque(id, solve_id, target)` and register both records on the study with `study.spin_transport(module)` and `study.spin_torque(torque)`:

| Constructor / method | Parameters | Defaults & validation | ProblemIR destination |
|---|---|---|---|
| `fm.DriftDiffusionSpinTorque(id, solve_id, target)` | `id: str`, `solve_id: str`, `target: RegionRef` | `id`, `solve_id` non-empty; `target` is a `fm.RegionRef` | `to_ir_module()` emits `kind="drift_diffusion_spin_torque"`, `schema_version="drift_diffusion_spin_torque.v1"`, `formula_version="transport_torque_angular_momentum.fullmag.v1"` |
| `study.spin_transport(module)` | `module: SpinDriftDiffusion` | registers `fm.SpinDriftDiffusion` on `StudyBuilder` | study `spin_transports` |
| `study.spin_torque(module)` | `module: SpinTorqueModule` | accepts `fm.DriftDiffusionSpinTorque` alongside prescribed STT/SOT modules | study `spin_torques` |

### Companion material, interface, boundary, and solver types

| Type | Key parameters & defaults | Validation / SI notes |
|---|---|---|
| `fm.SpinTransportMaterial` | `sigma_s_Spm`, `polarization_p`, `theta_sh`, `lambda_sf_m`, `lambda_j_m=None`, `lambda_phi_m=None`, `spin_capacitance_As_per_V_m3=None`, `capacitance_formula_version=None`, `density_of_states_per_spin_Jinv_m3=None` | `sigma_s_Spm > 0`, `lambda_sf_m > 0`, `polarization_p` in `[-1, 1]`; optional lengths `> 0` (serialize as `"disabled"` when `None`); capacitance/DOS paired with `"dos_isotropic_nonmagnetic.fullmag.v1"` |
| `fm.SpinTransportMaterialAssignment` | `region: RegionRef`, `material: SpinTransportMaterial` | assigns constitutive spin material to a region |
| `fm.SurfaceRef` | `object_id: str`, `surface_id: str`, `orientation: Sequence[float]` | `object_id`, `surface_id` non-empty; `orientation` finite, non-zero, unit-normalized |
| `fm.TransparentSpinInterface` | `id: str`, `side_a: RegionRef`, `side_b: RegionRef`, `normal_a_to_b: Sequence[float]` | `normal_a_to_b` unit-normalized; emits `kind="transparent"` |
| `fm.MixingConductanceSpinInterface` | keyword-only `id`, `normal_to_ferromagnet`, `normal_side`, `ferromagnet_side`, `g_up_Spm2`, `g_down_Spm2`, `g_r_Spm2`, `g_i_Spm2`, `normal_surface=None`, `ferromagnet_surface=None`, `spin_memory_loss=None` | `g_up_Spm2`, `g_down_Spm2`, `g_r_Spm2 >= 0`; `g_i_Spm2` finite; surfaces paired; emits `kind="mixing_conductance"`, `absorption="full_absorption"`, `formula_version="magnetoelectronic.fullmag.v2"` |
| `fm.SpinMemoryLossReservoir` | `g_n_Spm2`, `g_f_Spm2`, `g_lattice_Spm2`, `formula_version="sml_reservoir.fullmag.v2"` | `g_n_Spm2`, `g_f_Spm2 >= 0`; `g_lattice_Spm2 > 0`; statically eliminated SML reservoir |
| `fm.SpinInsulating` / `fm.HomogeneousSpinPotentialGradient` / `fm.SpinSink` | `id: str`, `surfaces: Sequence[SurfaceRef]` | `surfaces` non-empty; emit `kind="spin_insulating"`, `"homogeneous_spin_potential_gradient"`, `"spin_sink"` |
| `fm.SpecifiedSpinPotential` | `id: str`, `surfaces: Sequence[SurfaceRef]`, `spin_potential_V: Sequence[float]` | 3-component vector in $\mathrm{V}$; emits `kind="specified_spin_potential"` |
| `fm.SpecifiedSpinFlux` | `id: str`, `surfaces: Sequence[SurfaceRef]`, `normal_spin_flux_Apm2: Sequence[float]` | 3-component vector in $\mathrm{A\,m^{-2}}$; emits `kind="specified_spin_flux"` |
| `fm.PeriodicSpin` | `id: str`, `minus_surface: SurfaceRef`, `plus_surface: SurfaceRef`, `translation_m: Sequence[float]` | `translation_m` non-zero 3-vector in $\mathrm{m}$; emits `kind="periodic_spin"` |
| `fm.SpinSolverPolicy` | `engine="auto"`, `relative_tolerance=1e-8`, `absolute_tolerance=0.0`, `max_iterations=500`, `operator_version="fv_spin_upwind_v1"`, `default_external_boundary="spin_insulating"`, `reciprocal_nonlinear=None` | `default_external_boundary` in `{"spin_insulating", "reject_unassigned"}`; emits `"physical_residual_version": "transport_balance_integrated_l2.v1"` |
| `fm.ReciprocalNonlinearSolverPolicy` | `gmres_restart=40`, `max_picard_iterations=4`, `relative_update_tolerance=1e-9`, `eta_transport=0.1` | scaled Picard/GMRES policy for steady reciprocal M2 blocks (`eta_transport` in `(0, 1]`) |
| `fm.TransportExecution` | `discretization="fdm"`, `device="cpu"`, `precision="double"`, `execution_mode="strict"` | `discretization` in `{"fdm", "fem", "auto"}`, `device` in `{"cpu", "gpu", "auto"}`, `precision` in `{"single", "double"}`, `execution_mode` in `{"strict", "extended"}` |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("drift-diffusion-spin-torque-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %%
study.current_transport(
    name="j",
    model="prescribed_density",
    current_density=(1.0e11, 0.0, 0.0),
)
film_region = fm.RegionRef("film")
spin_material = fm.SpinTransportMaterial(
    sigma_s_Spm=1.0e6,
    polarization_p=0.5,
    theta_sh=0.1,
    lambda_sf_m=5.0e-9,
)
sdd = fm.SpinDriftDiffusion(
    id="m1",
    current_source_id="j",
    domain=(film_region,),
    materials=(fm.SpinTransportMaterialAssignment(film_region, spin_material),),
    solver=fm.SpinSolverPolicy(relative_tolerance=1.0e-8, max_iterations=500),
    requested_execution=fm.TransportExecution(discretization="fdm", device="cpu"),
    mode="steady",
)
study.spin_transport(sdd)
torque = fm.DriftDiffusionSpinTorque(
    id="sdd_torque",
    solve_id="m1",
    target=film_region,
)
study.spin_torque(torque)
study.stages.add_run(until=1.0e-12, stage_id="sdd-drive")
canonical_ir = sdd.to_ir()
torque_ir = torque.to_ir_module()
```

(python-api-interactions-drift-diffusion-spin-torque-problem-ir)=
## ProblemIR

`sdd.to_ir()` emits a `"schema_version": "spin_transport.v1"` dictionary containing `"id"`, `"current_source_id"`, `"domain"`, `"mode"`, `"materials"`, `"interfaces"`, `"boundaries"`, `"solver"`, `"requested_execution"`, and `"constitutive_version"` (`"transport_constitutive.one_way.fullmag.v1"` or `"transport_constitutive.reciprocal.fullmag.v1"`). `torque.to_ir_module()` emits `{"kind": "drift_diffusion_spin_torque", "schema_version": "drift_diffusion_spin_torque.v1", "id": ..., "solve_id": ..., "target": ..., "formula_version": "transport_torque_angular_momentum.fullmag.v1"}`.

(python-api-interactions-drift-diffusion-spin-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves region assignments, constitutive materials, interface conditions, boundary conditions, solver policies, and `requested_execution` independently of `resolved execution`. `Validation errors` reject empty identifiers, out-of-range polarizations, unpaired mixing-conductance surfaces, or `"transient"` configurations lacking physical capacitance metadata. `Unsupported combinations` fail closed when a backend lacks a coupled drift-diffusion runtime for the requested regime or discretization.

(python-api-interactions-drift-diffusion-spin-torque-discrete-realization)=
## Discrete realization

The Python contract supplies the constitutive module graph and torque link in `ProblemIR`; coupled elliptic spin-accumulation solves, interface flux assembly, and LLG torque injection are executed by the solver backends across the four execution lanes:

| Backend lane | Authoring & IR | Runtime status & acceleration notes |
|---|---|---|
| FEM CPU | Supported | Finite-element M1/M2 stiff coupled transport solvers with interface flux assembly; see {ref}`numerical-methods-performance-fem-spectral-multiphysics`. |
| FEM GPU | Supported | IR lowering supported; runtime follows FEM transport qualification and fails closed where GPU coupled transport kernels are not yet enabled. |
| FDM CPU | Supported | Finite-volume spin drift-diffusion reference solver (`fv_spin_upwind_v1`) with steady one-way (M1) and reciprocal (M2) Picard/GMRES policies. |
| FDM GPU | Supported | Accelerated CUDA M1 spin transport with binary-search face lookup, CUB block reduction closure, and deferred host materialization; see {ref}`numerical-methods-performance-fdm-transport`. |

(python-api-interactions-drift-diffusion-spin-torque-implementation-mapping)=
## Implementation mapping

The authoritative Python implementations are `packages/fullmag-py/src/fullmag/model/spin_transport.py` (`class SpinDriftDiffusion`, `class DriftDiffusionSpinTorque`, constitutive/interface/boundary/solver classes) and `packages/fullmag-py/src/fullmag/world.py` (`class StudyBuilder` methods `spin_transport` and `spin_torque`). Constructor arguments, constitutive validation, defaults, and `to_ir()` / `to_ir_module()` schemas come directly from those modules.

(python-api-interactions-drift-diffusion-spin-torque-validation)=
## Validation

Focused repository unit tests covering `fm.SpinDriftDiffusion` and `fm.DriftDiffusionSpinTorque` authoring and interface lowering include `test_m1_module_serializes_canonical_typed_contract`, `test_spin_drift_diffusion_transient_requires_physical_capacitance`, and `test_spin_drift_diffusion_interface_round_trip`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-drift-diffusion-spin-torque-limitations)=
## Limitations and Control Room

Self-consistent spin drift-diffusion (`spin_transport`) and transparent/mixing spin interfaces are editable in Control Room via `TransportAuthoringInspector` (`spin-transport` selection route) and `SpinInterfaceInspectorPanel` (`spin-interface`, including FEM shared `tet4` interface facet normal verification), subject to lane readiness (`transport-authoring-validation.v1`). Transient capacitance, reciprocal nonlinear policies, or spatial material closures absent from those forms stay `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| `spin_transport` & `SpinInterface` parameters + transport validation | `TransportAuthoringInspector` & `SpinInterfaceInspectorPanel` | `partial` | `runAuthoringMutationWithHistory` & `transport-authoring-validation.v1` |
| `fm.ReciprocalNonlinearSolverPolicy`, transient capacitance, & parameters without a named UI field | Python DSL | `Python-only` | Author in Python |

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Control Room Spin Transport and Spin Interface inspector panel
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-interactions-drift-diffusion-spin-torque-scientific-bibliography)=
## Scientific bibliography

- T. Valet and A. Fert, “Theory of the perpendicular magnetoresistance in magnetic multilayers,” *Physical Review B* **48**(10), 7099–7113 (1993), [doi:10.1103/PhysRevB.48.7099](https://doi.org/10.1103/PhysRevB.48.7099).
- S. Takahashi and S. Maekawa, “Spin injection and detection in magnetic nanostructures,” *Physical Review B* **67**(5), 052409 (2003), [doi:10.1103/PhysRevB.67.052409](https://doi.org/10.1103/PhysRevB.67.052409).
- C. Abert, M. Ruggeri, F. Bruckner, C. Vogler, G. Hrkac, D. Praetorius, and D. Suess, “A three-dimensional spin-diffusion model for micromagnetics,” *Scientific Reports* **5**(1), 14855 (2015), [doi:10.1038/srep14855](https://doi.org/10.1038/srep14855) | [Open-access Nature PDF](https://www.nature.com/articles/srep14855.pdf).
- C. Abert, M. Ruggeri, F. Bruckner, C. Vogler, A. Manchon, D. Praetorius, and D. Suess, “A self-consistent spin-diffusion model for micromagnetics,” *Scientific Reports* **6**(1), 16 (2016), [doi:10.1038/s41598-016-0019-y](https://doi.org/10.1038/s41598-016-0019-y) | [Open-access Nature PDF](https://www.nature.com/articles/s41598-016-0019-y.pdf).

(python-api-interactions-drift-diffusion-spin-torque-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/spin_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_transport.py#L442) | `class SpinDriftDiffusion` | public spin drift-diffusion module constructor and `spin_transport.v1` IR lowering |
| [`packages/fullmag-py/src/fullmag/model/spin_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_transport.py#L503) | `class DriftDiffusionSpinTorque` | LLG spin-torque binder emitting `drift_diffusion_spin_torque.v1` |
| [`packages/fullmag-py/src/fullmag/model/spin_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_transport.py#L72) | `class SpinTransportMaterial` | constitutive spin conductivity, polarization, lengths, and capacitance validation |
| [`packages/fullmag-py/src/fullmag/model/spin_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_transport.py#L234) | `class MixingConductanceSpinInterface` | magnetoelectronic mixing-conductance and spin-memory-loss interface contract |
| [`packages/fullmag-py/src/fullmag/model/spin_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_transport.py#L409) | `class SpinSolverPolicy` | linear solver tolerances, operator version, and reciprocal nonlinear policy |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py) | `class StudyBuilder` | study registration methods `spin_transport(...)` and `spin_torque(...)` |
