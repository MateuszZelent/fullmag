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
| `Problem.auxiliary_geometries` | sequence | `()` | mixed | nonmagnetic/helper geometries | shapes in `geometry.entries[]` |
| `Problem.auxiliary_geometry_roles` | mapping | `{}` | $1$ | role mapping; unknown geometry rejected | non-antenna roles in separate `physics_objects[]`; antenna ownership retained by module/runtime metadata |
| `Problem.current_modules` | sequence | `()` | mixed | current and Oersted source modules | `current_modules` |
| `Problem.field_drives` | sequence | `()` | mixed | regional/time-dependent field drives | `field_drives` |
| `Problem.couplings` | sequence | `()` | mixed | explicit coupling graph | `couplings` |
| `Problem.monitors` | sequence | `()` | mixed | planar monitor definitions | `planar_monitors` |
| `Problem.excitation_analysis` | analysis or `None` | `None` | mixed | optional excitation analysis | `excitation_analysis` |
| `Problem.geometry_asset_cache` | mapping | `{}` | $1$ | internal deterministic asset cache | generated `geometry_assets` |
| `Problem.spin_torque` | legacy torque or `None` | `None` | mixed | legacy single-torque input; exclusive with canonical list | normalized torque modules |
| `Problem.spin_torques` | sequence | `()` | mixed | canonical torque modules | `spin_torque_modules` / study runtime contract |
| `Problem.spin_torque_activation` | mapping | `{}` | $1$ | stage-local activation; unknown IDs rejected | stage torque activation |
| `Problem.spin_transports` | sequence | `()` | mixed | canonical spin drift-diffusion modules | `spin_transport_modules` |
| `Problem.temperature` | `float \| None` | `None` | K | non-negative compatibility temperature; thermal-term consistency checked | `temperature` |
| `Problem.elastic_materials` | sequence | `()` | mixed | elastic constitutive records | `elastic_materials` |
| `Problem.elastic_bodies` | sequence | `()` | mixed | elastic body assignments | `elastic_bodies` |
| `Problem.magnetostriction_laws` | sequence | `()` | mixed | magnetostriction laws | `magnetostriction_laws` |
| `Problem.mechanical_bcs` | sequence | `()` | mixed | mechanical boundary conditions | `mechanical_bcs` |
| `Problem.mechanical_loads` | sequence | `()` | mixed | mechanical loads | `mechanical_loads` |
| `Problem.selections` | `Sequence[SelectionDefinition]` | `()` | $1$ | unique definitions; reference existence, cycles, and complexity validated | canonical selection definitions |
| `Problem.magnetization_constraints` | `Sequence[FrozenSpins]` | `()` | $1$ | typed constraints; selection/object/region/stage references validated | canonical magnetization constraints |
| `Problem.pbc` | `FdmPbc \| tuple[bool,bool,bool] \| None` | `None` | $1$ | requested periodic axes and demag policy | `backend_policy.pbc` |

### Canonical stage-first authoring

```python
# %% Build a Problem through the public study API
import fullmag as fm

study = fm.study("problem_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
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

Requested intent remains distinct from planner resolution and execution evidence. The serializer
preserves selections and frozen-spin constraints as typed graph data; it must not flatten them to
backend masks before planning. Auxiliary shapes remain ordinary `geometry.entries[]`; for every
non-antenna entry in `auxiliary_geometry_roles`, lowering emits a separate `physics_objects[]`
record. The role is not serialized as `geometry.entries[].type`.

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

The documentation ownership test compares this inventory and source map with the live constructor
signature. Runtime qualification remains module- and lane-specific.

(python-api-problem-problem-limitations)=
## Limitations

Some fields are compatibility or internal build inputs. The stage-first API should remain the
primary user surface while direct construction stays fully documented for reproducibility.

(python-api-problem-problem-scientific-bibliography)=
## Scientific bibliography

No independent physical equation is introduced.

(python-api-problem-problem-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| aggregate API and IR | `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | graph validation and lowering | signature/source-map/round-trip tests |
| selections | `packages/fullmag-py/src/fullmag/model/selection.py` | `SelectionDefinition` | canonical selection graph | selection validation tests |
| constraints | `packages/fullmag-py/src/fullmag/model/constraints.py` | `FrozenSpins` | magnetization constraint semantics | constraint tests |
