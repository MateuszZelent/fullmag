---
title: Swept-Hex API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-swept-hex)=
# Swept-Hex API

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

| Parameter | Type | Default | Unit | Validation | Meaning |
|---|---|---|---|---|---|
| `mesh_strategy` | `str` | `None` | $1$ | `"auto" \| "free_tetrahedral" \| "swept_prism" \| "swept_hex"` | local recipe topology |
| `sweep_face_meshing` | `Literal["triangular","quadrilateral"]` | `None` | $1$ | consistent with strategy | source faces (`quadrilateral` for hex) |
| `element_family` | `Literal["prism","hex"]` | `None` | $1$ | consistent with strategy | element family (`hex`) |
| `transition_policy` | `Literal["pyramid_to_tetrahedra","reject"]` | `None` | $1$ | prism→pyramid contradicts hex → rejected | transition policy |

Failure behavior: `transition_policy="pyramid_to_tetrahedra"` together with
`swept_hex` → `ValueError` (contradictory combination).

ProblemIR mapping: fields land in the object recipe; no qualified backend
realization exists.

## 5. How to set it in Control Room

```
Model Explorer
└── Objects
    └── <object>
        └── Mesh            → selection kind: object.mesh
```

The **Object Mesh Policy** inspector: the `swept_hex` option appears as
**unsupported/disabled** — the UI gate refuses to save it. Full panel description:
{doc}`../../../frontend/meshing/object-mesh`.

## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | unsupported | no qualified realization |
| FEM | GPU | unsupported | ditto |
| FDM | CPU/GPU | not applicable | use the FDM meshing API ({doc}`../../fdm/index`) |

## 7. Limitations and known pitfalls

- Do not assume "Python accepted it, so it works": representability ≠ production
  qualification.
- Bypassing through advanced recipe JSON ends in a validation error or an explicit
  fallback recorded in the build report.

## 8. Scientific bibliography

No physical claims on this page.

## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| allowed `mesh_strategy` values | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe.mesh_strategy` | name-set validation |
| rejection of the contradictory combination | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe` (hex validation) | validation branch `hex mesh requires mesh_strategy='swept_hex'` |
