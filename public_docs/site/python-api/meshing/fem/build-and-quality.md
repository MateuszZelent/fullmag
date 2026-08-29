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

## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

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

| Parameter/function | Signature or type | Default | Meaning |
|---|---|---|---|
| `StudyBuilder.build_domain_mesh` | `build_domain_mesh() -> StudyBuilder` | n/a | materializes shared domain mesh |
| `build_domain_mesh` | `build_domain_mesh() -> None` | n/a | module-level materialization |
| `PerObjectMeshRecipe.compute_quality` | `bool \| None` | `None` | aggregate quality request |
| `PerObjectMeshRecipe.per_element_quality` | `bool \| None` | `None` | per-element quality request |
| `MagnetHandle.mesh` | `mesh(**kwargs) -> MagnetHandle` | inherited | authors object mesh policy |

Invalid mesh policy values fail during authoring. Build failure must preserve
the latest successful asset; node, element, and quality data come from the
realized report rather than the request object.

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

## 7. Limitations and known pitfalls

- A green policy draft is not a green mesh build.
- Do not synthesize quality distributions from authored sizes.
- CPU/GPU comparisons require the same mesh identity/digest.

## 8. Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element
   mesh generator,” *International Journal for Numerical Methods in Engineering*
   **79**, 1309-1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
2. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM, 2002.

## 9. Source-code index

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| public build entrypoint | `packages/fullmag-py/src/fullmag/world.py` | `StudyBuilder.build_domain_mesh` | builder delegation |
| module materialization | `packages/fullmag-py/src/fullmag/world.py` | `build_domain_mesh` | mesh state implementation |
| quality fields | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe` | dataclass and IR fields |
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Backend realization is in the relevant `backends/fdm` or `backends/fem` lane named by the page.

