---
title: Current Transport
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Current transport

(public-docs-python-api-current-and-excitations-current-transport)=
(python-api-current-and-excitations-current-transport-problem-statement)=
## Problem statement

`fm.CurrentTransport` and `study.current_transport(...)` declare charge-current transport modules while keeping prescribed densities, steady Ohmic Poisson solves, reciprocal magnetoresistive Poisson solves, structured source-cut closures, and external-lead antenna current sources explicitly separated.

Construction validates typed charge-transport inputs, boundary combinations, gauge compatibility, solver operator compatibility, and mutual-exclusivity rules in Python; calling `to_ir()` lowers the object into its canonical `ProblemIR` record for study capture and planner validation.

(python-api-current-and-excitations-current-transport-governing-equations)=
## Governing equations

`fm.CurrentTransport` either records a prescribed uniform current density $\mathbf{J}_c$ (`model="prescribed_density"`) or configures steady charge conservation $\nabla\cdot\mathbf{J}_c = 0$ with Ohmic constitutive relation $\mathbf{J}_c = -\sigma\nabla V$ (`model="ohmic_poisson"`). When `coupling="bidirectional"` (or `model="magnetoresistive_poisson"`), conductivity becomes magnetization-dependent via anisotropic magnetoresistance and anomalous Hall components ($\sigma_\parallel$, $\sigma_\perp$, $\sigma_{\mathrm{AHE}}$) and couples reciprocally with spin accumulation as formulated in {doc}`../../physics/interactions/drift-diffusion-spin-torque/index` and {doc}`../../physics/interactions/oersted-field/index`.

(python-api-current-and-excitations-current-transport-symbols-and-si-units)=
## Symbols and SI units

- Charge current density $\mathbf{J}_c$ (`current_density`) and outward normal current density (`outward_current_density_Apm2`) use $\mathrm{A\,m^{-2}}$.
- Electrical conductivities $\sigma$ (`sigma_Spm`, `sigma_parallel_Spm`, `sigma_perpendicular_Spm`, `sigma_AHE_Spm`, `conductivity_s_per_m`) use $\mathrm{S\,m^{-1}}$.
- Electric potential $V$ (`potential_V`) and impressed potential jumps (`potential_jump_V`) use $\mathrm{V}$; cut offsets and lead lengths (`offset_m`, `length_m`) use $\mathrm{m}$.
- Identifiers (`name`, `solve_region`), model/coupling/gauge selectors, and policy metadata are dimensionless ($1$).

(python-api-current-and-excitations-current-transport-assumptions-and-validity)=
## Assumptions and validity

- `model` must be `"prescribed_density"`, `"ohmic_poisson"`, or `"magnetoresistive_poisson"`. `"magnetoresistive_poisson"` requires `coupling="bidirectional"`, and `"bidirectional"` requires an Ohmic/magnetoresistive solve with `sigma_parallel_Spm`, `sigma_perpendicular_Spm`, and `sigma_AHE_Spm` authored on every `fm.ChargeTransportMaterial` plus `ChargeSolverPolicy(engine="block_gmres")`.
- `model="prescribed_density"` requires finite `current_density`; `model="ohmic_poisson"` forbids `current_density` and requires a complete charge contract (`domain`, `materials`, `boundaries` unless using `conservative_current_source`, `external_lead_preparation`, or `structured_current_closure` v2, plus `gauge` and `solver`). Legacy `solve_region` / `conductivity_s_per_m` cannot be mixed with the complete charge contract.
- At most one of `conservative_current_view`, `structured_current_closure`, `conservative_current_source`, or `external_lead_preparation` may be supplied on a single `fm.CurrentTransport` instance; combining two or more raises `ValueError`.
- `fm.EquipotentialCurrentTerminal` requires one-way `ohmic_poisson`, `gauge=fm.ChargePotentialGauge("terminal_reference")`, and cannot be mixed with `fm.VoltageElectrode` or `fm.NormalCurrentElectrode`.
- `conservative_current_source` and `external_lead_preparation` require one-way `ohmic_poisson`, empty `boundaries`, `time_envelope=None` (static precompute), `gauge=fm.ChargePotentialGauge("terminal_reference")`, and `ChargeSolverPolicy(engine="cg", operator_version="fem_charge_conforming_h1_p1.transparent.v1")`.

(python-api-current-and-excitations-current-transport-python-api)=
## Python API

### Constructor or function

`fm.CurrentTransport(*, name, model="prescribed_density", ...)` (and `study.current_transport(...)`)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `name` | `str` | `required` | $1$ | non-empty | module identifier | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `model` | `str` | `"prescribed_density"` | $1$ | `"prescribed_density"`, `"ohmic_poisson"`, or `"magnetoresistive_poisson"` | transport equation family | FEM/FDM CPU/GPU: IR; resolved module | `model` |
| `current_density` | `Sequence[float] \| None` | `None` | $\mathrm{A\,m^{-2}}$ | required for `"prescribed_density"`; forbidden for `"ohmic_poisson"` | prescribed uniform current density | FEM/FDM CPU/GPU: IR; resolved module | `current_density` |
| `solve_region` | `str \| None` | `None` | $1$ | non-empty when supplied; cannot mix with complete charge contract | legacy single-region solve selector | FEM/FDM CPU/GPU: IR; legacy path | `solve_region` |
| `conductivity_s_per_m` | `float \| None` | `None` | $\mathrm{S\,m^{-1}}$ | finite and `> 0` when supplied; cannot mix with complete charge contract | legacy scalar conductivity | FEM/FDM CPU/GPU: IR; legacy path | `conductivity_s_per_m` |
| `coupling` | `str` | `"one_way"` | $1$ | `"one_way"` or `"bidirectional"`; `"bidirectional"` requires Ohmic/magnetoresistive solve and `block_gmres` | charge-spin coupling direction | FEM/FDM CPU/GPU: IR; resolved module | `coupling` |
| `domain` | `Sequence[RegionRef]` | `()` | $1$ | non-empty `RegionRef` sequence for `"ohmic_poisson"` | charge transport domain regions | FEM/FDM CPU/GPU: IR; resolved module | `domain` |
| `materials` | `Sequence[ChargeTransportMaterialAssignment]` | `()` | $\mathrm{S\,m^{-1}}$ | non-empty typed assignments for `"ohmic_poisson"` | per-region charge conductivity assignments | FEM/FDM CPU/GPU: IR; resolved module | `materials` |
| `boundaries` | `Sequence[ChargeBoundary]` | `()` | $\mathrm{V}$, $\mathrm{A\,m^{-2}}$, or $1$ | non-empty unless using `conservative_current_source`, `external_lead_preparation`, or `structured_current_closure` v2 | electrode, terminal, and insulating charge boundaries | FEM/FDM CPU/GPU: IR; resolved module | `boundaries` |
| `gauge` | `ChargePotentialGauge \| None` | `None` | $1$ | required for `"ohmic_poisson"`; `"dirichlet_reference"`, `"zero_mean"`, or `"terminal_reference"` | electric potential reference gauge | FEM/FDM CPU/GPU: IR; resolved module | `gauge` |
| `solver` | `ChargeSolverPolicy \| None` | `None` | $1$ | required for `"ohmic_poisson"`; engine and operator version must match closure/coupling | linear charge solver policy | FEM/FDM CPU/GPU: IR; resolved module | `solver` |
| `time_envelope` | `TimeEnvelope \| None` | `None` | $1$ | canonical `TimeEnvelope` (`ConstantEnvelope`, `SinusoidalEnvelope`, `PulseEnvelope`, `PiecewiseLinearEnvelope`, `SincEnvelope`, `TabulatedEnvelope`); forbidden on static precompute lead/v2 closures | temporal modulation of the transport drive | FEM/FDM CPU/GPU: IR; resolver-specific | `time_envelope` |
| `conservative_current_view` | `ConservativeCurrentView \| None` | `None` | $1$ | mutually exclusive with `structured_current_closure`, `conservative_current_source`, and `external_lead_preparation`; one-way `ohmic_poisson` only | conservative current flux verification view | FEM CPU: IR & conservative view; other lanes fail closed | `conservative_current_view` |
| `structured_current_closure` | `StructuredCurrentClosure \| None` | `None` | $1$ | mutually exclusive with other closure/lead fields; one-way `ohmic_poisson`; v1 requires `fv_charge_harmonic_source_cut_v1`, v2 requires FEM H1 operator and `zero_mean` gauge | closed-loop impressed potential jump source-cut closure | FDM/FEM CPU/GPU: IR; lane-specific operator version | `structured_current_closure` |
| `conservative_current_source` | `ExternalLeadCurrentSource \| None` | `None` | $1$ | mutually exclusive with other closure/lead fields; static one-way FEM H1 `cg` + `terminal_reference` gauge + empty `boundaries` | prepared external-lead conservative current source mesh | FEM CPU: IR & antenna source precompute | `conservative_current_source` |
| `external_lead_preparation` | `ExternalLeadPreparation \| None` | `None` | $1$ | mutually exclusive with other closure/lead fields; static one-way FEM H1 `cg` + `terminal_reference` gauge + empty `boundaries`; extensions must belong to `domain` | declarative external lead extension specification | FEM CPU: IR & antenna lead preparation | `external_lead_preparation` |

### Companion charge materials, boundaries, closures, and external-lead types

| Type / constant | Key parameters & defaults | Validation & role |
|---|---|---|
| `fm.ChargeTransportMaterial` | `sigma_Spm`, `sigma_parallel_Spm=None`, `sigma_perpendicular_Spm=None`, `sigma_AHE_Spm=None` | `sigma_Spm > 0`; anisotropic triplet must be authored together (`sigma_parallel_Spm > 0`, `sigma_perpendicular_Spm > 0`, `sigma_AHE_Spm` finite) and is valid only for `coupling="bidirectional"` |
| `fm.ChargeTransportMaterialAssignment` | `region: RegionRef`, `material: ChargeTransportMaterial` | binds a charge material to a region |
| `fm.VoltageElectrode` | `id`, `surfaces`, `*, potential_V` | Dirichlet potential electrode ($\mathrm{V}$); `kind="voltage_electrode"` |
| `fm.NormalCurrentElectrode` | `id`, `surfaces`, `*, outward_current_density_Apm2` | Neumann normal current-density electrode ($\mathrm{A\,m^{-2}}$); `kind="normal_current_electrode"` |
| `fm.EquipotentialCurrentTerminal` | `id`, `surfaces` | floating equipotential terminal paired with `gauge="terminal_reference"`; `kind="equipotential_current_terminal"` |
| `fm.ChargeInsulating` | `id`, `surfaces` | zero normal current boundary ($\mathbf{J}_c\cdot\mathbf{n}=0$); `kind="insulating"` |
| `fm.ChargePotentialGauge` | `kind` | `"dirichlet_reference"`, `"zero_mean"`, or `"terminal_reference"` |
| `fm.ChargeSolverPolicy` | `engine="cg"`, `relative_tolerance=1e-10`, `absolute_tolerance=0.0`, `max_iterations=10000`, `physical_residual_version="charge_balance_integrated_l2.v1"`, `operator_version="fv_charge_harmonic_v1"` | `cg` allows `fv_charge_harmonic_v1`, `fv_charge_harmonic_source_cut_v1`, `fem_charge_conforming_h1_p1.transparent.v1`; `block_gmres` allows `fdm_coupled_charge_spin_fv_block_gmres.v1`, `fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1` |
| `fm.StructuredCutPlane` | `axis`, `offset_m`, `normal="positive_axis"`, `coordinate_frame="world"` | `axis` in `{"x", "y", "z"}`, `normal` in `{"positive_axis", "negative_axis"}`, `coordinate_frame` in `{"world", "object"}` |
| `fm.ImpressedPotentialJump` | `drive_id`, `potential_jump_V`, `schema_version="impressed_potential_jump.v1"` | finite non-zero potential jump ($\mathrm{V}$) across a closed-loop cut |
| `fm.StructuredCurrentSourceCut` | `source_cut_id`, `circuit_id`, `region`, `plane`, `drive` | binds a cut plane and impressed potential jump to a circuit region |
| `fm.StructuredCurrentClosure` | `closure_id`, `source_cuts`, `*, schema_version="structured_current_closure.v1"`, `kind="closed_geometry"` | v1 uses world-frame cuts for FDM (`fv_charge_harmonic_source_cut_v1`); v2 requires one object-frame `x`/`z` cut for FEM (`prepare(...)` materializes a v2 loop) |
| `fm.ConservativeCurrentView` | keyword-only `stable_vertex_ids`, `boundary_faces`, `identity`, `pins`, `closure`, `algebraic_relative_tolerance`, `physical_relative_gate`, `physical_absolute_gate_a`, `reference_mpi_gather_broadcast=False` | boundary flux conservation verification view; boundary roles given by `fm.CONSERVATIVE_CURRENT_BOUNDARY_ROLES` (`{"insulating_outer", "source_cut", "closure_interface"}`) |
| `fm.TerminalLeadExtension` | `id`, `observation_id`, `object_id`, `boundary_markers`, `length_m`, `outward_direction_xyz`, `conductivity_spm`, `layers=2` | extruded external lead extension attached to conductor terminal markers |
| `fm.ExternalLeadPreparation` | `revision`, `extensions`, `drives`, `schema_version="antenna_external_lead_preparation.v1"` | declarative lead-extension specification for antenna charge precompute |
| `fm.ExternalLeadCurrentSource` | `revision`, `device_stable_vertex_ids`, `lead_mesh`, `lead_stable_vertex_ids`, `lead_conductivity_spm_per_element`, `interface_pairs`, `outer_terminals`, `terminal_observations`, `drives`, `schema_version="conservative_current_source.v1"` | pre-meshed conservative external-lead current source snapshot |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("current-transport-ohmic-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %%
film_region = fm.RegionRef("film")
left_contact = fm.SurfaceRef("film", "x_min", (-1.0, 0.0, 0.0))
right_contact = fm.SurfaceRef("film", "x_max", (1.0, 0.0, 0.0))

transport = study.current_transport(
    name="ohmic_channel",
    model="ohmic_poisson",
    domain=(film_region,),
    materials=(
        fm.ChargeTransportMaterialAssignment(
            film_region,
            fm.ChargeTransportMaterial(sigma_Spm=5.0e6),
        ),
    ),
    boundaries=(
        fm.VoltageElectrode("v_left", (left_contact,), potential_V=0.05),
        fm.VoltageElectrode("v_right", (right_contact,), potential_V=0.0),
    ),
    gauge=fm.ChargePotentialGauge("dirichlet_reference"),
    solver=fm.ChargeSolverPolicy(
        engine="cg",
        relative_tolerance=1.0e-10,
        operator_version="fv_charge_harmonic_v1",
    ),
)
study.stages.add_relax(stage_id="charge-relax", dt=5e-13, max_steps=1)
canonical_ir = transport.to_ir()
```

(python-api-current-and-excitations-current-transport-problem-ir)=
## ProblemIR

`transport.to_ir()` emits a typed dictionary with `"kind": "current_transport"`, `"name"`, `"model"` (lowering `"ohmic_poisson"` with `coupling="bidirectional"` to `"magnetoresistive_poisson"`), `"coupling"`, and whichever optional subfields are authored: `"current_density"`, `"solve_region"`, `"conductivity_s_per_m"`, `"domain"`, `"materials"`, `"boundaries"`, `"gauge"`, `"solver"`, `"time_envelope"`, `"conservative_current_view"`, `"structured_current_closure"`, `"conservative_current_source"`, and `"external_lead_preparation"`.

(python-api-current-and-excitations-current-transport-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing required fields, non-finite vectors, non-positive conductivities, mutually exclusive closure/lead combinations, mismatched solver operator versions, and inconsistent `model`/`coupling` options. `Unsupported combinations` fail closed at the planner or backend boundary.

(python-api-current-and-excitations-current-transport-discrete-realization)=
## Discrete realization

The Python contract supplies transport configuration and canonical `ProblemIR`; discrete finite-volume and finite-element charge-Poisson solves execute across the four lanes as follows:

| Backend lane | Authoring & IR | Runtime status & acceleration notes |
|---|---|---|
| FEM CPU | Supported | Conforming $H^1$ P1 charge Poisson (`fem_charge_conforming_h1_p1.transparent.v1`) with factor-once multi-RHS reuse for antenna port modes and reciprocal M2 blocks; see {ref}`numerical-methods-performance-fem-spectral-multiphysics`. |
| FEM GPU | Supported | IR lowering supported; runtime follows FEM GPU transport qualification and fails closed where unimplemented. |
| FDM CPU | Supported | Finite-volume harmonic-conductivity charge Poisson (`fv_charge_harmonic_v1` and `fv_charge_harmonic_source_cut_v1`) and coupled M2 block-GMRES reference solvers. |
| FDM GPU | Supported | Accelerated CUDA charge Poisson via 6–7 level cooperative AMG-PCG and opt-in cuDSS direct solves; see {ref}`numerical-methods-performance-fdm-transport`. |

(python-api-current-and-excitations-current-transport-implementation-mapping)=
## Implementation mapping

The authoritative Python implementations are `packages/fullmag-py/src/fullmag/model/current_transport.py` (`class CurrentTransport` and all companion charge material, boundary, closure, view, and external-lead dataclasses) and `packages/fullmag-py/src/fullmag/world.py` (`class StudyBuilder` method `current_transport`).

(python-api-current-and-excitations-current-transport-validation)=
## Validation

Focused repository unit tests covering authoring and IR serialization include `test_ohmic_poisson_serializes_complete_charge_contract`, `test_ohmic_poisson_rejects_ambiguous_legacy_definition`, and `test_bidirectional_contract_round_trips_through_script_and_scene`. Live solver execution and device parity require separate backend qualification.

(python-api-current-and-excitations-current-transport-limitations)=
## Limitations and Control Room

Steady and time-modulated electrical current transport records (`current_transport`) are edited in Control Room through `TransportAuthoringInspector` (`current-transport` selection route), which supports closure selection, structured current-source cuts, active-lane capability gating, and readiness validation via `transport-authoring-validation.v1`. Spatial conductivity profiles, `fm.ExternalLeadCurrentSource` snapshots, or closures without exposed UI widgets remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| Current transport parameters, contacts, structured cuts, & validation checks | `Model Explorer -> Current Transport -> <transport>` (`TransportAuthoringInspector`) | `partial` | `runAuthoringMutationWithHistory` and `transport-authoring-validation.v1` request |
| `fm.ExternalLeadCurrentSource`, `fm.ConservativeCurrentView`, & parameters without a named UI field | Python DSL | `Python-only` | Authored directly in Python |

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Control Room TransportAuthoringInspector and SpinAuthoringInspector showing current transport, spin transport, and torque bindings
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-current-and-excitations-current-transport-scientific-bibliography)=
## Scientific bibliography

- T. Valet and A. Fert, “Theory of the perpendicular magnetoresistance in magnetic multilayers,” *Physical Review B* **48**(10), 7099–7113 (1993), [doi:10.1103/PhysRevB.48.7099](https://doi.org/10.1103/PhysRevB.48.7099).
- S. Takahashi and S. Maekawa, “Spin injection and detection in magnetic nanostructures,” *Physical Review B* **67**(5), 052409 (2003), [doi:10.1103/PhysRevB.67.052409](https://doi.org/10.1103/PhysRevB.67.052409).
- C. Abert, M. Ruggeri, F. Bruckner, C. Vogler, A. Manchon, D. Praetorius, and D. Suess, “A self-consistent spin-diffusion model for micromagnetics,” *Scientific Reports* **6**(1), 16 (2016), [doi:10.1038/s41598-016-0019-y](https://doi.org/10.1038/s41598-016-0019-y) | [arXiv:1512.05519](https://arxiv.org/abs/1512.05519).

(python-api-current-and-excitations-current-transport-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/current_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/current_transport.py#L1466) | `class CurrentTransport` | public current-transport constructor, mutual-exclusivity validation, and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/current_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/current_transport.py#L242) | `class ChargeTransportMaterial` | isotropic and bidirectional anisotropic conductivity contract |
| [`packages/fullmag-py/src/fullmag/model/current_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/current_transport.py#L399) | `class ChargePotentialGauge` | electric potential gauge contract (`dirichlet_reference`, `zero_mean`, `terminal_reference`) |
| [`packages/fullmag-py/src/fullmag/model/current_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/current_transport.py#L413) | `class ChargeSolverPolicy` | charge Poisson linear engine (`cg` / `block_gmres`) and operator version validation |
| [`packages/fullmag-py/src/fullmag/model/current_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/current_transport.py#L187) | `class StructuredCurrentClosure` | structured v1/v2 impressed potential-jump source-cut closure |
| [`packages/fullmag-py/src/fullmag/model/current_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/current_transport.py#L925) | `class ConservativeCurrentView` | conservative current boundary-role verification view |
| [`packages/fullmag-py/src/fullmag/model/current_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/current_transport.py#L1293) | `class ExternalLeadPreparation` | declarative external lead extensions for antenna charge precompute |
| [`packages/fullmag-py/src/fullmag/model/current_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/current_transport.py#L1349) | `class ExternalLeadCurrentSource` | pre-meshed conservative external-lead current source snapshot |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py) | `class StudyBuilder` | `study.current_transport(...)` study registration helper |
