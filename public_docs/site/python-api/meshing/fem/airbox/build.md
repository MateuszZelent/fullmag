---
title: Airbox Build API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-airbox-build)=
# Airbox Build API

## 1. What it is and when to use it

`study.build_domain_mesh()` explicitly materializes the shared domain mesh
(universe + objects + regions) **before** the stage graph executes.

When to use it:

- you want to validate the mesh and its quality before paying for a simulation,
- the script saves/loads a mesh artifact (`study.mesh.save/load`),
- you control invalidation points after geometry/policy edits.

Impact on the simulation: building is not a scientific certificate — success means
a mesh was generated; qualification comes from inspecting the report and quality.

## 2. Physical and mathematical explanation

No equation of its own; the operation creates the discrete space shared by all
operators. The key invariants are mesh conformity at object/air interfaces and
correct region markers. Element quality is assessed through statistics (e.g.
SICN/Jacobian measures) recorded in the report.

| Concept | Meaning | SI unit |
|---|---|---|
| conformity | no gaps/overlaps between regions | $1$ |
| region markers | region identifiers inside the mesh | $1$ |
| quality statistics | element quality measure distributions | $1$ |

## 3. Example — complete Python script

```python
# %% Explicit mesh build before stages
import fullmag as fm

nm = 1.0e-9

study = fm.study("airbox_build_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
study.universe.mesh(
    minimum_element_size=8 * nm,
    maximum_element_size=100 * nm,
    maximum_element_growth_rate=1.3,
    grading="geometric",
)

film = study.geometry(fm.Box(300 * nm, 100 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh(minimum_element_size=2.5 * nm, maximum_element_size=5 * nm,
          compute_quality=True)

study.exchange()
study.demag(model="airbox", variant="robin")

# Materialize the shared-domain mesh now (not lazily at first stage):
study.build_domain_mesh()

# Optional persistence of the realized mesh:
# study.mesh.save("run_output/domain_mesh.fmsh")

study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

## 4. Exact API

| Method | Signature | Meaning |
|---|---|---|
| `study.build_domain_mesh()` | `StudyBuilder.build_domain_mesh()` | materializes the shared domain mesh |
| `study.build_mesh()` | `StudyBuilder.build_mesh()` | legacy mesh build entry point |
| `study.mesh.save(path)` | `StudyMeshHandle.save` | save the mesh artifact |
| `study.mesh.load(path)` | `StudyMeshHandle.load` | load the artifact; authoring-consistency validation |
| `study.mesh.save_or_load(path)` | `StudyMeshHandle.save_or_load` | cache: load when consistent, otherwise save |

Failure behavior / invalidation:

- geometry, object/region policy, or universe changes invalidate the realization,
- `study.mesh(...)` without a realized mesh → API migration error (pointing to the
  correct facade),
- topology/authoring fingerprint mismatch on `load` →
  `MeshConfigurationMismatch` with a difference list.

ProblemIR mapping: realization and the build report land in provenance; requested
intent stays separate from resolved execution.

## 5. How to set it in Control Room

```
Model Explorer
└── Universe / Airbox      → selection kinds: airbox.*
    └── Mesh Build          → selection kind: airbox.mesh.build
```

The **Airbox Mesh Build** inspector (`AirboxMeshBuildLanePanel`) runs the build;
the Quality/History tabs show the realized report. In the object panel,
**Build Mesh** executes `mesh.build-selected`. Full build lifecycle description:
{doc}`../../../frontend/meshing/build-lifecycle`; reports and quality:
{doc}`../../../frontend/meshing/quality-and-reports`.

## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | implemented | Gmsh/import → host/MFEM structures |
| FEM | GPU | capability-gated | identical content-addressed mesh |
| FDM | CPU/GPU | not applicable | the FDM grid is built without an explicit build step |

## 7. Limitations and known pitfalls

- Build success ≠ scientific qualification: always inspect the report and quality
  distributions.
- Do not reconstruct the realized mesh from the Python request after the run —
  retain the generated asset and provenance.

## 8. Scientific bibliography

No page-specific physical claims; airbox physics: {doc}`index`.

## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| explicit domain build | `packages/fullmag-py/src/fullmag/world.py` | `StudyBuilder.build_domain_mesh`, `build_domain_mesh` | module function implementation |
| artifact persistence | `packages/fullmag-py/src/fullmag/world.py` | `StudyMeshHandle.save/load/save_or_load`, `MeshPersistenceResult` | facade implementation |
| quality result | `packages/fullmag-py/src/fullmag/world.py` | `GeometryMeshHandle.quality` | method signature |
