---
title: Swept-Hex API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-swept-hex)=
# Swept-Hex API

(python-api-meshing-fem-ferromagnet-swept-hex-python-api)=
<!-- (python-api)= -->
## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

(python-api-meshing-fem-ferromagnet-swept-hex-problem-statement)=
<!-- (problem-statement)= -->
(python-api-meshing-fem-ferromagnet-swept-hex-governing-equations)=
<!-- (governing-equations)= -->
(python-api-meshing-fem-ferromagnet-swept-hex-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fem-ferromagnet-swept-hex-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

## 1. What it is and when to use it

`mesh_strategy="swept_hex"` represents a swept hexahedral mesh: quadrilateral
source faces and the `hex` element family in an object recipe.

When to use it: **never in production today.** Python representability is not a
production qualification — Control Room exposes this option as unsupported, and
the prism-to-pyramid combination is contradictory and rejected.

This page documents the API boundary: what is representable, what validation
accepts, and what realization does not guarantee.

## 2. Physical and mathematical explanation

No physical model of its own; this page describes only the topological contract of
the recipe. The contradictory contract (pyramid→tetrahedra transition for hexes)
is rejected by validation — no correct realization of that transition exists in
the current shared-domain mesh pipeline.

## 3. Example — complete Python script

No working production example exists. Recipe-level representation:

```python
# %% NOT PRODUCTION: representable recipe only; UI exposes this as unsupported
# PerObjectMeshRecipe(
#     mesh_strategy="swept_hex",
#     sweep_face_meshing="quadrilateral",
#     element_family="hex",
# )
```

For real thin-film scenarios use {doc}`swept-prism`.

## 4. Exact API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mesh_strategy` | `str` | `None` | $1$ | `"auto" \| "free_tetrahedral" \| "swept_prism" \| "swept_hex"` | local recipe topology | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `sweep_face_meshing` | `Literal["triangular","quadrilateral"]` | `None` | $1$ | consistent with strategy | source faces (`quadrilateral` for hex) | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `element_family` | `Literal["prism","hex"]` | `None` | $1$ | consistent with strategy | element family (`hex`) | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `transition_policy` | `Literal["pyramid_to_tetrahedra","reject"]` | `None` | $1$ | prism→pyramid contradicts hex → rejected | transition policy | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |

Failure behavior: `transition_policy="pyramid_to_tetrahedra"` together with
`swept_hex` → `ValueError` (contradictory combination).

ProblemIR mapping: fields land in the object recipe; no qualified backend
realization exists.

(python-api-meshing-fem-ferromagnet-swept-hex-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The request lowers to the mesh-workflow or discretization subtree; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-ferromagnet-swept-hex-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fem-ferromagnet-swept-hex-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The backend consumes the realized Cartesian or finite-element asset, including topology, markers, quality, and provenance where available.

## 5. How to set it in Control Room

```
Model Explorer
└── Objects
    └── <object>
        └── Mesh            → selection kind: object.mesh
```

The **Object Mesh Policy** inspector: the `swept_hex` option appears as
**unsupported/disabled** — the UI gate refuses to save it. Full panel description:
{doc}`../../../../frontend/meshing/object-mesh`.

## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | unsupported | no qualified realization |
| FEM | GPU | unsupported | ditto |
| FDM | CPU/GPU | not applicable | use the FDM meshing API ({doc}`../../fdm/index`) |

(python-api-meshing-fem-ferromagnet-swept-hex-validation)=
<!-- (validation)= -->
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-ferromagnet-swept-hex-limitations)=
<!-- (limitations)= -->
## 7. Limitations and known pitfalls

- Do not assume "Python accepted it, so it works": representability ≠ production
  qualification.
- Bypassing through advanced recipe JSON ends in a validation error or an explicit
  fallback recorded in the build report.

(python-api-meshing-fem-ferromagnet-swept-hex-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 8. Scientific bibliography

No physical claims on this page.

(python-api-meshing-fem-ferromagnet-swept-hex-implementation-mapping)=
<!-- (implementation-mapping)= -->
(python-api-meshing-fem-ferromagnet-swept-hex-source-code-index)=
<!-- (source-code-index)= -->
## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| allowed `mesh_strategy` values | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe.mesh_strategy` | name-set validation |
| rejection of the contradictory combination | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe` (hex validation) | validation branch `hex mesh requires mesh_strategy='swept_hex'` |
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Backend realization is in the relevant `backends/fdm` or `backends/fem` lane named by the page.


### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Swept-hex object policy and lowering. | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class PerObjectMeshRecipe` | Swept-hex object policy and lowering. | Source-map validator and focused API tests |
