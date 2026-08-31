---
title: FEM Build and Quality API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-build-and-quality)=
# FEM Build and Quality API

A production script separates authoring from materialization:

```text
study.build_domain_mesh()
```

Quality requests are authored on object recipes with `compute_quality` and
`per_element_quality`. The resulting mesh report contains requested/resolved topology, operations,
fallbacks, region markers, element families, layer data, quality distributions, and mesh identity.

Do not reconstruct the realized mesh from the Python request after the run; retain the generated
asset and provenance.

(python-api-meshing-fem-build-and-quality-python-api)=
<!-- (python-api)= -->
## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

(python-api-meshing-fem-build-and-quality-problem-statement)=
<!-- (problem-statement)= -->
(python-api-meshing-fem-build-and-quality-governing-equations)=
<!-- (governing-equations)= -->
(python-api-meshing-fem-build-and-quality-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fem-build-and-quality-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

## 1. What it is and when to use it

`study.build_domain_mesh()` materializes the shared FEM domain mesh from the
authored universe, object, region, airbox, and quality policies. Use it before
solver execution when the mesh asset and quality/provenance report are needed.

## 2. Physical and mathematical explanation

Mesh quality is a discretization property, not a new physical interaction.
The realized asset determines the finite-element space, element families,
markers, layer structure, and quality distributions consumed by the solver.

## 3. Example - complete Python script

```python
# %% Build a shared FEM mesh and request quality reports
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_build_quality")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(200 * nm, 100 * nm, 100 * nm))
body = study.geometry(fm.Box(80 * nm, 40 * nm, 4 * nm), name="film")
body.mesh(maximum_element_size=4 * nm, minimum_element_size=2 * nm,
          compute_quality=True, per_element_quality=True)
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.build_domain_mesh()
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", max_steps=100)
```

## 4. Exact API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `StudyBuilder.build_domain_mesh` | `build_domain_mesh() -> StudyBuilder` | n/a | $1$ | Current facade signature; invalid paths or stale fingerprints are rejected | materializes shared domain mesh | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.build` |
| `build_domain_mesh` | `build_domain_mesh() -> None` | n/a | $1$ | Current facade signature; invalid paths or stale fingerprints are rejected | module-level materialization | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.build` |
| `PerObjectMeshRecipe.compute_quality` | `bool \| None` | `None` | $1$ | Current facade signature; invalid paths or stale fingerprints are rejected | aggregate quality request | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.per_geometry[]` |
| `PerObjectMeshRecipe.per_element_quality` | `bool \| None` | `None` | $1$ | Current facade signature; invalid paths or stale fingerprints are rejected | per-element quality request | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.per_geometry[]` |
| `MagnetHandle.mesh` | `mesh(**kwargs) -> MagnetHandle` | inherited | $1$ | Current facade signature; invalid paths or stale fingerprints are rejected | authors object mesh policy | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |

Invalid mesh policy values fail during authoring. Build failure must preserve
the latest successful asset; node, element, and quality data come from the
realized report rather than the request object.

(python-api-meshing-fem-build-and-quality-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The request lowers to the mesh-workflow or discretization subtree; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-build-and-quality-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fem-build-and-quality-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The backend consumes the realized Cartesian or finite-element asset, including topology, markers, quality, and provenance where available.

## 5. How to set it in Control Room

Route: `Model Explorer -> Objects -> <object> -> Mesh -> Quality`, then
`Model Explorer -> Mesh -> Build Shared-Domain Mesh`. Use **Apply** to store
policy and **Build Mesh** to materialize it; report, readiness, and dependent
resources are invalidated until success. See [Control Room capability register](/frontend/capability-register).

## 6. Backend and frontend support

| Lane | Status | Notes |
|---|---|---|
| FEM CPU | authoring implemented | Runtime build and solver qualification are separate gates. |
| FEM GPU | shared-asset dependent | GPU consumes the realized asset. |
| FDM CPU/GPU | not applicable | FDM uses structured grids. |
| Control Room | implemented for advertised fields | Quality and build actions are source-backed. |

(python-api-meshing-fem-build-and-quality-validation)=
<!-- (validation)= -->
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-build-and-quality-limitations)=
<!-- (limitations)= -->
## 7. Limitations and known pitfalls

- A green policy draft is not a green mesh build.
- Do not synthesize quality distributions from authored sizes.
- CPU/GPU comparisons require the same mesh identity/digest.

(python-api-meshing-fem-build-and-quality-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 8. Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element
   mesh generator,” *International Journal for Numerical Methods in Engineering*
   **79**, 1309-1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
2. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM, 2002.

(python-api-meshing-fem-build-and-quality-implementation-mapping)=
<!-- (implementation-mapping)= -->
(python-api-meshing-fem-build-and-quality-source-code-index)=
<!-- (source-code-index)= -->
## 9. Source-code index

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| public build entrypoint | `packages/fullmag-py/src/fullmag/world.py` | `StudyBuilder.build_domain_mesh` | builder delegation |
| module materialization | `packages/fullmag-py/src/fullmag/world.py` | `build_domain_mesh` | mesh state implementation |
| quality fields | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe` | dataclass and IR fields |
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Backend realization is in the relevant `backends/fdm` or `backends/fem` lane named by the page.


### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Realized mesh data, validation, and quality channels. | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `class MeshData` | Realized mesh data, validation, and quality channels. | Source-map validator and focused API tests |
| Mesh realization and provenance report. | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `class MeshRealizationReport` | Mesh realization and provenance report. | Source-map validator and focused API tests |
