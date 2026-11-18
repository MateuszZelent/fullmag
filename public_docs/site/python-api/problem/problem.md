---
title: Problem
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-problem-problem)=
# Problem

(python-api-problem-problem-problem-statement)=
## Contract

`Problem` is the canonical aggregate of magnets, interactions, studies, transport, mechanics,
selections, magnetization constraints, discretization, and requested runtime intent. Stage-first
scripts normally produce this object through the loader; direct construction remains the exact
class API and serialization contract.

(python-api-problem-problem-governing-equations)=
## Governing equations

`Problem` introduces no independent equation. It preserves a typed multiphysics graph whose
individual modules own their equations, signs, units, boundary conditions, and qualification.

(python-api-problem-problem-symbols-and-si-units)=
## Symbols and SI units

Each nested module retains its declared SI units. Names, IDs, policies, selections, activation
rules, and runtime choices are dimensionless semantic/provenance data.

(python-api-problem-problem-assumptions-and-validity)=
## Assumptions and validity

At least one magnet and one active interaction/material anisotropy are required. Exactly one
canonical study or a compatible legacy dynamics/output route must be supplied. All named graph,
selection, constraint, torque, transport, geometry, material, stage, and interface references are
validated before execution.

(python-api-problem-problem-frozen-spins)=
## Frozen-spins constraints (`FrozenSpins`)

`Problem.magnetization_constraints` carries `FrozenSpins` intent as typed contract data that remains explicit through to planning rather than being flattened prematurely into backend masks:

- `selector`: geometry, object, or region selection defining the frozen domain.
- `membership`: static freeze or snapshot-at-activation behavior.
- `reference`: orientation source mode (`capture_current_at_activation`, `initial_state`, or `explicit_field_asset`).
- `stage_ids` / `activation`: stage-scoped applicability controls.

Constraint definitions are validated before planning; unsupported runtime or lane combinations fail closed rather than silently rewriting intent.

### Validation and helper entrypoints

- `class FrozenSpins` (`packages/fullmag-py/src/fullmag/model/constraints.py`): validates inputs in `__init__` and normalizes `reference` and `activation`.
- `ObjectRegion.freeze_spins` (`packages/fullmag-py/src/fullmag/model/structure.py`): constructs `FrozenSpins` for a region (`in_region_selection`).
- `Ferromagnet.freeze_spins` (`packages/fullmag-py/src/fullmag/model/structure.py`): constructs `FrozenSpins` for an object (`in_object_selection`), requiring `object_id`.
- `class Problem` (`packages/fullmag-py/src/fullmag/model/problem.py`): serializes constraints into `ProblemIR`.

### Authoring `FrozenSpins` constraints

```python
from fullmag.model.constraints import FrozenSpins
from fullmag.model.selection import in_object_selection

constraint = FrozenSpins(
    id="film_frozen_capture",
    selector=in_object_selection("film"),
    reference="capture_current_at_activation",
    membership="snapshot_at_activation",
    stage_ids=("run",),
    empty_selection="error",
    inactive_selection="warn_and_intersect",
)
```

### Functions and arguments

| Function | Arguments |
|---|---|
| `FrozenSpins.__init__(*, id, selector, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")` | Full source contract with policy validation and defaults. |
| `ObjectRegion.freeze_spins(*, id=None, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")` | Region helper: default `id` is `<region_id>_frozen`; selector is `in_region_selection`. |
| `Ferromagnet.freeze_spins(*, id, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")` | Object helper: selector is `in_object_selection`; requires explicit `object_id`. |
| `Problem(..., magnetization_constraints=(...))` | Carries constraints into the problem-level field and into IR (`ProblemIR`). |

(python-api-problem-problem-python-api)=
## Python API

| Python | Type | Default | SI unit | Meaning / validation | ProblemIR |
|---|---|---|---|---|---|
| `Problem.name` | `str` | required | $1$ | non-empty problem identity | `problem_meta.name` |
| `Problem.magnets` | `Sequence[Ferromagnet]` | required | mixed | non-empty magnetic objects with unique identities | `magnets` and owned geometry/material records |
| `Problem.energy` | `Sequence[EnergyTerm]` | required | mixed | interaction list; duplicate legality checked | `energy_terms` |
| `Problem.study` | study or `None` | `None` | mixed | canonical study; conflicts with incompatible legacy route | `study` |
| `Problem.dynamics` | `LLG \| None` | `None` | mixed | legacy dynamics input | `study.dynamics` after normalization |
| `Problem.outputs` | sequence or `None` | `None` | mixed | legacy outputs requiring legacy dynamics | `study.sampling.outputs` |
| `Problem.discretization` | `DiscretizationHints \| None` | `None` | mixed | FDM/FEM/hybrid authoring hints | `backend_policy.discretization_hints` |
| `Problem.description` | `str \| None` | `None` | $1$ | optional human description | `problem_meta.description` |
| `Problem.runtime` | `RuntimeSelection` | factory default | $1$ | requested backend/device/precision/mode | `backend_policy` and runtime metadata |
| `Problem.runtime_metadata` | mapping | `{}` | $1$ | user/runtime provenance | `problem_meta.runtime_metadata` |
| `Problem.auxiliary_geometries` | sequence | `()` | mixed | nonmagnetic/helper geometries | `geometry.entries` |
| `Problem.auxiliary_geometry_roles` | mapping | `{}` | $1$ | role mapping; unknown geometry rejected | `geometry.entries[].type` |
| `Problem.current_modules` | sequence | `()` | mixed | current and Oersted source modules | `current_modules` |
| `Problem.field_drives` | sequence | `()` | mixed | regional/time-dependent field drives | `field_drives` |
| `Problem.mask_field_drives` | sequence | `()` | mixed | hand-written mask antennas (`mask_field_drive.v1`) | `mask_field_drives` |
| `Problem.couplings` | sequence | `()` | mixed | explicit coupling graph | `couplings` |
| `Problem.monitors` | sequence | `()` | mixed | planar monitor definitions | `planar_monitors` |
| `Problem.excitation_analysis` | analysis or `None` | `None` | mixed | optional excitation analysis | `excitation_analysis` |
| `Problem.geometry_asset_cache` | mapping | `{}` | $1$ | internal deterministic asset cache | generated `geometry_assets` |
| `Problem.spin_torque` | legacy torque or `None` | `None` | mixed | legacy single-torque input; exclusive with canonical list | normalized torque modules |
| `Problem.spin_torques` | sequence | `()` | mixed | canonical torque modules | `spin_torque_modules` / study runtime contract |
| `Problem.spin_torque_activation` | mapping | `{}` | $1$ | stage-local activation; unknown IDs rejected | stage torque activation |
| `Problem.spin_transports` | sequence | `()` | mixed | canonical spin drift-diffusion modules | `spin_transport_modules` |
| `Problem.temperature` | `float \| None` | `None` | $\mathrm{K}$ | non-negative compatibility temperature; thermal-term consistency checked | `temperature` |
| `Problem.elastic_materials` | sequence | `()` | mixed | elastic constitutive records | `elastic_materials` |
| `Problem.elastic_bodies` | sequence | `()` | mixed | elastic body assignments | `elastic_bodies` |
| `Problem.magnetostriction_laws` | sequence | `()` | mixed | magnetostriction laws | `magnetostriction_laws` |
| `Problem.mechanical_bcs` | sequence | `()` | mixed | mechanical boundary conditions | `mechanical_bcs` |
| `Problem.mechanical_loads` | sequence | `()` | mixed | mechanical loads | `mechanical_loads` |
| `Problem.selections` | `Sequence[SelectionDefinition]` | `()` | $1$ | unique definitions; reference existence, cycles, and complexity validated | canonical selection definitions |
| `Problem.magnetization_constraints` | `Sequence[FrozenSpins]` | `()` | $1$ | typed constraints; selection/object/region/stage references validated | canonical magnetization constraints |
| `Problem.parameters` | `ParameterLibrary \| None` | `None` | mixed | optional versioned SI-normalized authoring parameter library; resolved at construction (unknown references, cycles, dimension conflicts rejected), lowered as authoring metadata only | `parameters` |
| `Problem.pbc` | `FdmPbc \| tuple[bool,bool,bool] \| None` | `None` | $1$ | requested periodic axes and demag policy | `backend_policy.pbc` |


### Antenna collections and auxiliary-object identity

Containers and identifiers are dimensionless; physical parameters of nested objects retain their own
SI units ($\mathrm{m}$, $\mathrm{A}$, $\mathrm{T}$, $\mathrm{Hz}$, $\mathrm{s}$). The table below
does not alter their normalization and does not imply solver execution on all lanes.

| Python | Type | Default | SI | Construction validation | Meaning | Support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Problem.auxiliary_geometry_object_ids` | `Mapping[str, str]` | `{}` | $1$ | non-empty names and IDs; keys belong to auxiliary_geometry_roles; unique object_ids across magnets | immutable auxiliary-entity identity, independent of display name | shared FDM/FEM CPU/GPU authoring; execution follows explicit capabilities | `physics_objects[].object_id` |
| `Problem.antenna_port_modes` | `Sequence[AntennaPortMode]` | `()` | $1$ | AntennaPortMode entries; unique id within collection | port current-basis declarations without automatic solve | shared FDM/FEM CPU/GPU authoring; execution follows explicit capabilities | `antenna_port_modes` |
| `Problem.antenna_field_solve_stages` | `Sequence[AntennaFieldSolveStage]` | `()` | $1$ | AntennaFieldSolveStage entries; unique id within collection | field-solve declarations separated from explicit stage action | shared FDM/FEM CPU/GPU authoring; execution follows explicit capabilities | `antenna_field_solve_stages` |
| `Problem.antenna_target_projections` | `Sequence[AntennaTargetProjection]` | `()` | $1$ | AntennaTargetProjection entries; unique id within collection | requested basis projections onto a selected target | shared FDM/FEM CPU/GPU authoring; execution follows explicit capabilities | `antenna_target_projections` |
| `Problem.solved_antenna_drives` | `Sequence[SolvedAntennaDrive]` | `()` | $1$ | SolvedAntennaDrive entries; unique id within collection | time-domain consumption of a previously solved basis | shared FDM/FEM CPU/GPU authoring; execution follows explicit capabilities | `solved_antenna_drives` |
| `Problem.antenna_spectrum_requests` | `Sequence[AntennaSpectrumRequest]` | `()` | $1$ | AntennaSpectrumRequest entries; unique id within collection | source-spectrum requests rather than magnetization response | shared FDM/FEM CPU/GPU authoring; execution follows explicit capabilities | `antenna_spectrum_requests` |

`Problem.__post_init__` rejects wrong element types and duplicate `id` values. This is not a full
preflight of cross-references between port, solve, projection, and drive declarations: the
IR/planner/runtime boundary must verify that before execution. A valid collection type alone must
never be treated as a solved or available basis.

`auxiliary_geometry_object_ids` maps a display name to an immutable `object_id`; keys must appear
in `auxiliary_geometry_roles`. When omitted, the serializer preserves the `object_id = name`
compatibility fallback. In each `physics_objects[]` entry, `name` stays a separate field,
`geometry_id` references the geometry, and `type` comes from the explicit role. Antenna type or
name never triggers current transport, field solve, projection, or LLG dynamics. An ID dictionary
alone does not create a `physics_objects` record: a record is emitted only for a declared role.

The five collections serialize via `value.to_ir()` to identically named IR fields. Registering a
field-solve declaration is not a stage action: a dedicated stage-first workflow must invoke it
explicitly. A source spectrum is not evidence of an excited magnetization wavevector response; that
requires a separate magnetization analysis.

### Authoring boundary matrix

| Solver | Device | Aggregate contract | Execution qualification |
|---|---|---|---|
| FDM | CPU | shared typed graph and lowering | separate projection/import and LLG qualification |
| FDM | GPU | shared typed graph and lowering | separate CUDA qualification; no CPU fallback |
| FEM | CPU | shared typed graph and lowering | separate native solve, projection, and time evolution |
| FEM | GPU | shared typed graph and lowering | CPU precompute is not GPU solve; device consumption has separate gates |

Source: `packages/fullmag-py/src/fullmag/model/problem.py`, `class Problem` (`__post_init__`
validation and `to_ir` lowering). Field physics and realizations are documented in the
[CPW antenna reference](/python-api/current-and-excitations/cpw-antenna), not in this aggregate API page.

### Canonical stage-first authoring

```python
# %% Build a Problem through the public study API
import fullmag as fm

study = fm.study("problem_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 2e-9))
film = study.geometry(fm.Box(40e-9, 20e-9, 4e-9), name="film")
film.Ms = 8.0e5
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_run(stage_id="run", until=1e-12)
```

(python-api-problem-problem-problem-ir)=
## ProblemIR

The excerpt below comes from lowering the example `study` through the repository loader without
running a solver. Because no antenna collection is declared, each collection stays empty and no
automatic field solve or RF drive appears. The `physics_objects` field is omitted when no auxiliary
roles are declared. This is an excerpt rather than a complete problem snapshot.

```json
{
  "antenna_port_modes": [],
  "antenna_field_solve_stages": [],
  "antenna_target_projections": [],
  "solved_antenna_drives": [],
  "antenna_spectrum_requests": []
}
```

Requested intent remains distinct from planner resolution and execution evidence. The serializer
preserves selections and frozen-spin constraints as typed graph data; it must not flatten them to
backend masks before planning.

(python-api-problem-problem-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves module identities, signs, units, formula/operator versions, selection
graphs, constraint policies, stage activation, and requested runtime. Resolved execution records
the chosen planner realization, concrete meshes/masks, solver, device, precision, and capability
decisions without replacing requested intent. Validation errors reject unknown references, cycles,
duplicates, malformed data, and stale source identities. Unsupported combinations fail closed and
are not silently omitted, converted, or executed on a fallback lane.

(python-api-problem-problem-discrete-realization)=
## Discrete realization

Planners resolve the same `ProblemIR` into FDM/FEM and CPU/GPU execution plans. Representation in
`Problem` is not evidence that every nested module executes on every lane.

(python-api-problem-problem-implementation-mapping)=
## Implementation mapping

`packages/fullmag-py/src/fullmag/model/problem.py`, `class Problem`, owns aggregate validation,
legacy migration, canonical lowering, geometry assets, selections, constraints, and multiphysics
reference integrity.

(python-api-problem-problem-validation)=
## Validation

The documentation ownership test compares this inventory with the live constructor
signature. Runtime qualification remains module- and lane-specific.

(python-api-problem-problem-limitations)=
## Limitations

Some fields are compatibility or internal build inputs. The stage-first API should remain the
primary user surface while direct construction stays fully documented for reproducibility.

(python-api-problem-problem-scientific-bibliography)=
## Scientific bibliography

No independent physical equation is introduced. For micromagnetic discretization and constraint modeling background, see:

1. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

## Control Room support

Status: Control Room authors a study, objects, couplings, and `FrozenSpins` constraints and lowers them to `ProblemIR`; direct standalone `Problem`/`ProblemIR` editing remains Python-only.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| `Problem.magnetization_constraints` (`FrozenSpins`) | `Model Explorer -> Physics / Constraints -> Frozen Spins` (`FrozenSpinsInspectorPanel`, `SelectionExpressionBuilder`) | `partial` | `runAuthoringMutationWithHistory` on `scene_revision`; `FrozenSpinsOverlay` viewport preview |
| `Problem.couplings` & `Problem.field_drives` | `Model Explorer -> Physics -> Couplings / Drives` (`CouplingInspectorPanel`, `RegionalFieldDrivePanel`) | `partial` | `runAuthoringMutationWithHistory` via `MODEL_COUPLINGS_RESOURCE_KEY` / scene deltas |
| `Problem.antenna_*` / `solved_antenna_drives` | `Model Explorer -> Physics Objects -> <antenna>` (`AntennaObjectPanel`, `AntennaFieldSolveAuthoring`) | `partial` | `runAuthoringMutationWithHistory` with pre-solved basis overlays |
| Standalone `Problem` aggregate constructor / raw IR parameters without UI fields | `No standalone Control Room route` | `Python-only` | Authored in Python |

```{image} /_static/images/ui/inspector-physics-couplings-frozen-spins.png
:alt: Control Room Frozen Spins constraint inspector showing frz_edge_pin, Left Edge Pinning, and In region selection for reg_pinning_ring on obj_yig_film
:align: center
:width: 100%
```

Standalone `Problem`/`ProblemIR` authoring and aggregate parameters without inspector panels remain Python-only.
See [Control Room capability register](/frontend/capability-register) and [Physics, Couplings & Frozen Spins Inspectors](/frontend/inspectors/physics-antennas-and-transport).
Frontend source owners: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx` (`StudyInspectorPanel`), `FrozenSpinsInspectorPanel`, and `CouplingInspectorPanel`.

(python-api-problem-problem-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| aggregate API and IR | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/problem.py#L2601) | [`class Problem`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/problem.py#L2601) | graph validation and lowering | signature and round-trip tests |
| selections | `packages/fullmag-py/src/fullmag/model/selection.py` | `SelectionDefinition` | canonical selection graph | selection validation tests |
| constraints | `packages/fullmag-py/src/fullmag/model/constraints.py` | `FrozenSpins` | magnetization constraint semantics | constraint tests |
