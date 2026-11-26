---
title: Problem IR
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-problem-problem-ir)=
# Problem IR

(python-api-problem-problem-ir-problem-statement)=
## Contract
This page records the canonical `ProblemIR` schema emitted by FullMag's public Python lowering path
(`ir_version` `"0.3.0"`); it does not redefine solver physics. Every stage-first script authored
with `fm.study(...)` lowers into this versioned, SI-normalized JSON payload before planning or
native execution.

(python-api-problem-problem-ir-governing-equations)=
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-problem-problem-ir-symbols-and-si-units)=
## Symbols and SI units
Every physical scalar, vector, and coordinate stored in `ProblemIR` uses canonical SI base and
derived units ($\mathrm{m}$, $\mathrm{s}$, $\mathrm{A\,m^{-1}}$, $\mathrm{J\,m^{-1}}$,
$\mathrm{J\,m^{-3}}$, $\mathrm{J\,m^{-2}}$, $\mathrm{T}$, $\mathrm{Hz}$); $1$ denotes
dimensionless identifiers, versions, flags, and normalized unit vectors.

(python-api-problem-problem-ir-assumptions-and-validity)=
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-problem-problem-ir-python-api)=
## Python API
No constructor parameters are owned by this conceptual page.

### Authoring-to-IR inspection

Public examples do not construct `fm.Problem(...)` directly. Lowering is inspected through the
individual object-level `to_ir()` fragments that the builder composes or by loading a stage-first
script with `fm.load_problem_from_script(...)` and calling `loaded.problem.to_ir(...)`.

```python
# %% Complete stage-first study plus object-level lowering fragments
import fullmag as fm

nm = 1.0e-9

study = fm.study("ir_inspection_study")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 50 * nm, 10 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-12)

# Object-level lowering fragments used by the canonical ProblemIR build:
geometry_ir = fm.Box(100 * nm, 50 * nm, 10 * nm).to_ir()
state_ir = fm.init.UniformMagnetization((1.0, 0.0, 0.0)).to_ir()
assert geometry_ir["kind"] == "box"
assert state_ir["kind"] == "uniform"
```

(python-api-problem-problem-ir-problem-ir)=
## ProblemIR

Loading the stage-first study above with `fm.load_problem_from_script(...)` and calling
`loaded.problem.to_ir(include_geometry_assets=False)` produces the following canonical `ProblemIR`
structure (with `problem_meta.runtime_metadata.model_builder` omitted here for brevity):

```json
{
  "ir_version": "0.3.0",
  "problem_meta": {
    "name": "ir_inspection_study",
    "description": null,
    "script_language": "python",
    "script_source": null,
    "script_api_version": "0.3.0",
    "serializer_version": "0.3.0",
    "entrypoint_kind": "direct",
    "source_hash": null,
    "runtime_metadata": {
      "interactive_session_requested": false,
      "script_api_surface": "study",
      "runtime_selection": {
        "backend": "fdm",
        "device": "cpu",
        "gpu_count": 0,
        "device_index": null,
        "cpu_threads": null,
        "execution_mode": "strict",
        "execution_precision": "double",
        "parallel_execution": {
          "mode": "serial",
          "max_cpu_percent": 90.0,
          "max_memory_percent": 80.0,
          "memory_reserve_bytes": 1073741824,
          "max_workers": null,
          "threads_per_worker": 1
        }
      }
    },
    "backend_revision": null,
    "seeds": []
  },
  "geometry": {
    "entries": [
      {
        "name": "film_geom",
        "kind": "box",
        "size": [1e-07, 5e-08, 1e-08]
      }
    ]
  },
  "geometry_assets": null,
  "regions": [
    {
      "name": "film",
      "geometry": "film_geom"
    }
  ],
  "object_regions": [],
  "materials": [
    {
      "name": "mat_film",
      "saturation_magnetisation": 800000.0,
      "exchange_stiffness": 1.3e-11,
      "damping": 0.02,
      "uniaxial_anisotropy": null,
      "uniaxial_anisotropy_k2": null,
      "anisotropy_axis": null,
      "cubic_anisotropy_kc1": null,
      "cubic_anisotropy_kc2": null,
      "cubic_anisotropy_kc3": null,
      "cubic_anisotropy_axis1": null,
      "cubic_anisotropy_axis2": null,
      "interfacial_dmi": null,
      "bulk_dmi": null,
      "ms_field": null,
      "a_field": null,
      "alpha_field": null,
      "ku_field": null,
      "ku2_field": null,
      "kc1_field": null,
      "kc2_field": null,
      "kc3_field": null,
      "dind_field": null,
      "dbulk_field": null
    }
  ],
  "material_parameter_fields": [],
  "magnets": [
    {
      "object_id": null,
      "name": "film",
      "region": "film",
      "material": "mat_film",
      "initial_magnetization": {
        "kind": "uniform",
        "value": [1.0, 0.0, 0.0]
      },
      "mesh_recipe": null,
      "absorbing_boundary": null
    }
  ],
  "selections": [],
  "magnetization_constraints": [],
  "energy_terms": [
    { "kind": "exchange" },
    { "kind": "demag", "realization": "auto" }
  ],
  "physics_graph": {
    "schema_version": "physics_graph.v1",
    "scene_revision": 0,
    "modules": [],
    "edges": []
  },
  "study": {
    "kind": "time_evolution",
    "dynamics": {
      "kind": "llg",
      "gyromagnetic_ratio": 221100.0,
      "integrator": "auto",
      "fixed_timestep": null
    },
    "sampling": { "outputs": [] }
  },
  "backend_policy": {
    "requested_backend": "fdm",
    "execution_precision": "double",
    "discretization_hints": {
      "fdm": {
        "cell": [2e-09, 2e-09, 5e-09],
        "default_cell": [2e-09, 2e-09, 5e-09]
      },
      "fem": null,
      "hybrid": null
    }
  },
  "validation_profile": {
    "execution_mode": "strict"
  }
}
```

### Top-level `ProblemIR` sections

| Top-level key | Meaning |
| --- | --- |
| `ir_version`, `problem_meta` | Schema version, script provenance, source hash, runtime selection metadata, and model-builder sync manifest |
| `geometry`, `geometry_assets`, `regions`, `object_regions` | Parametric/imported geometry records, optional cached mesh assets, and owner-scoped regions |
| `materials`, `material_parameter_fields`, `magnets` | Constitutive magnetic records, typed spatial parameter overrides, and ferromagnet bindings |
| `energy_terms`, `couplings`, `current_modules`, `field_drives`, `spin_transport_modules`, `physics_graph` | Interaction graph, drives, transport, and resolved module dependency graph |
| `study`, `backend_policy`, `validation_profile` | Stage/dynamics definition, requested backend/precision/discretization hints, and strict/extended/hybrid mode |

(python-api-problem-problem-ir-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is preserved in Python and `ProblemIR`. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-problem-problem-ir-discrete-realization)=
## Discrete realization

| Solver | Device | `ProblemIR` consumption | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Shared schema parsed by Rust `fullmag-ir` and planned onto structured grids | Module- and observable-specific qualification applies |
| FDM | GPU | Shared schema parsed by Rust `fullmag-ir`; planner verifies CUDA capability | No silent CPU fallback in `strict` mode |
| FEM | CPU | Shared schema parsed by Rust `fullmag-ir` and planned onto unstructured meshes | Meshing and operator qualification apply separately |
| FEM | GPU | Shared schema parsed by Rust `fullmag-ir`; planner verifies CUDA/cuDSS capability | Separate executed-device parity gates apply |

(python-api-problem-problem-ir-implementation-mapping)=
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/problem.py` (`class Problem`).

(python-api-problem-problem-ir-validation)=
## Validation
Tests compare this inventory with live Python signatures and verify JSON round-trips against `crates/fullmag-ir`.

(python-api-problem-problem-ir-limitations)=
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-problem-problem-ir-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

## Control Room support

Status: Control Room authors a study in the workspace and lowers it to `ProblemIR`; direct `Problem`/`ProblemIR` editing remains Python-only.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `No standalone Control Room route` | `Python-only` | Authored in Python |
| Parameters without a named UI field | `No standalone Control Room route` | `Python-only` | Authored in Python |

Standalone `Problem` and `ProblemIR` authoring remains Python-only.
See [Control Room capability register](/frontend/capability-register) for the UI support matrix.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx` (`StudyInspectorPanel`).

(python-api-problem-problem-ir-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | [`class Problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | Canonical Python API behavior | Ownership and API contract tests |
