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
## Frozen-spin constraints

`Problem.magnetization_constraints` carries `FrozenSpins` intent as stage-first, typed contract
data:

- `selector`: geometry/object/region selection used for the frozen region.
- `membership`: static freeze or snapshot-at-activation behavior.
- `reference`: source orientation mode (`capture_current_at_activation`, `initial_state`,
  `explicit_field_asset`).
- `stage_ids` / `activation`: stage-scoped applicability controls.

Constraint definitions are validated before planning. Unsupported runtime/lane combinations must fail
closed rather than silently rewrite intent.

## Standard entry: Frozen-spins (source-first, argument-complete)

### Wprowadzenie

`Problem.magnetization_constraints` przechowuje instancje `FrozenSpins` jako część intencji
kontrakcyjnej problemu. Kontrakt pozostaje typowany aż do warstwy planera i nie jest
redukowany do masek backendowych wcześniej.

### Bezpośredni dowód z kodu

- `class FrozenSpins` (`packages/fullmag-py/src/fullmag/model/constraints.py`) waliduje wejście w
  `__init__` i normalizuje `reference`/`activation`.
- `ObjectRegion.freeze_spins(...)` (`packages/fullmag-py/src/fullmag/model/structure.py`) buduje
  `FrozenSpins` dla regionu (`in_region_selection`).
- `Ferromagnet.freeze_spins(...)` (`packages/fullmag-py/src/fullmag/model/structure.py`) buduje
  `FrozenSpins` dla obiektu (`in_object_selection`), wymaga `object_id`.
- `Problem` (`packages/fullmag-py/src/fullmag/model/problem.py`) serializuje constrainty do IR.

### Implementacja w Pythonie (source-first)

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

### Funkcje i argumenty (z podpisów)

| Funkcja | Argumenty |
|---|---|
| `FrozenSpins.__init__(*, id, selector, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")` | W pełnym kontrakcie źródłowym z walidacją polityk i domyślnymi wartościami. |
| `ObjectRegion.freeze_spins(*, id=None, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")` | Wrapper regionowy: domyślny `id` to `<region_id>_frozen`, selector to `in_region_selection`. |
| `Ferromagnet.freeze_spins(*, id, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")` | Wrapper obiektowy: selector to `in_object_selection`, twardy wymóg `object_id`. |
| `Problem(..., magnetization_constraints=(...))` | Przenosi constraints do pola problem-level i potem do IR (`ProblemIR`). |

### Referencje kodowe

- `packages/fullmag-py/src/fullmag/model/constraints.py:137`
- `packages/fullmag-py/src/fullmag/model/constraints.py:148`
- `packages/fullmag-py/src/fullmag/model/structure.py:516`
- `packages/fullmag-py/src/fullmag/model/structure.py:769`
- `packages/fullmag-py/src/fullmag/model/problem.py`

### Bibliografia

- Abert, C. “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

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

## Control Room crosswalk

Status: The Control Room authors a study and lowers it to ProblemIR; direct Problem/IR editing is not exposed.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `No standalone Control Room route` | `not implemented` | No supported frontend transaction |
| Parameters without a named UI field | `No standalone Control Room route` | `not implemented` | Python-only until implemented |

frontend support is not implemented for standalone Problem/ProblemIR authoring.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx (StudyInspectorPanel)`.

## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| aggregate API and IR | `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | graph validation and lowering | signature/source-map/round-trip tests |
| selections | `packages/fullmag-py/src/fullmag/model/selection.py` | `SelectionDefinition` | canonical selection graph | selection validation tests |
| constraints | `packages/fullmag-py/src/fullmag/model/constraints.py` | `FrozenSpins` | magnetization constraint semantics | constraint tests |
