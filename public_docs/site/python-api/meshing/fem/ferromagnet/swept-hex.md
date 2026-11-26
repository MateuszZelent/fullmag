---
title: Swept-Hex API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-swept-hex)=
# Swept-Hex API

(python-api-meshing-fem-ferromagnet-swept-hex-symbols-and-si-units)=
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fem-ferromagnet-swept-hex-assumptions-and-validity)=
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

(python-api-meshing-fem-ferromagnet-swept-hex-problem-statement)=
## 1. What it is and when to use it

`mesh_strategy="swept_hex"` represents a swept hexahedral mesh: quadrilateral
source faces and the `hex` element family in an object recipe.

When to use it: **never in production today.** Python representability is not a
production qualification — Control Room exposes this option as unsupported, and
both `"pyramid_to_tetrahedra"` and `"pure_prism"` transitions contradict the
`hex` element family and are rejected immediately at authoring time.

This page documents the API boundary: what is representable, what validation
accepts, and what realization does not guarantee. For production thin-film FEM
GPU and CPU meshes, see {doc}`swept-prism` and
{ref}`numerical-methods-performance-fem-gpu-demag`.

(python-api-meshing-fem-ferromagnet-swept-hex-governing-equations)=
## 2. Physical and mathematical explanation

No physical model of its own; this page describes only the topological contract of
the recipe. Contradictory transition contracts (`"pyramid_to_tetrahedra"` and
`"pure_prism"` for `hex`) are rejected by validation — no conforming realization
of those transitions exists in the current shared-domain mesh pipeline.

## 3. Example — complete Python script

The block below is valid stage-first authoring that constructs a representable
`swept_hex` recipe without calling `study.build_domain_mesh()`, because
shared-domain realization for `swept_hex` currently fails closed (unsupported in
production).

```python
# %% Non-production authoring contract: representable swept_hex intent only
import fullmag as fm
from fullmag.model import PerObjectMeshRecipe

nm = 1.0e-9

study = fm.study("swept_hex_authoring_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(400 * nm, 200 * nm, 150 * nm))
study.universe.mesh(maximum_element_size=50 * nm)

film = study.geometry(fm.Box(120 * nm, 60 * nm, 4 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

# Representable swept_hex intent (transition="reject" is required; pyramid_to_tetrahedra
# and pure_prism raise ValueError). Realization/build is intentionally omitted because
# swept_hex has no production-qualified shared-domain backend executor yet.
film.mesh.swept(
    elements=2,
    distribution="fixed",
    face_meshing="quadrilateral",
    sweep_direction="z",
    transition="reject",
    exact_layers=True,
)
recipe = PerObjectMeshRecipe(
    mesh_strategy="swept_hex",
    through_thickness_elements=2,
    through_thickness_distribution="fixed",
    sweep_face_meshing="quadrilateral",
    sweep_direction="z",
    element_family="hex",
    transition_policy="reject",
    exact_layer_count=True,
)
assert recipe.to_ir()["transition_policy"] == "reject"

study.exchange()
study.demag(model="airbox", variant="robin")
study.stages.add_relax(stage_id="equilibrium", algorithm="projected_gradient_bb", tolT=1.0e-6)
```

For real thin-film scenarios use {doc}`swept-prism`.

(python-api-meshing-fem-ferromagnet-swept-hex-python-api)=
## 4. Exact API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mesh_strategy` | `str \| None` | `None` | $1$ | `"auto" \| "free_tetrahedral" \| "thin_film_tetrahedral" \| "swept_prism" \| "swept_hex"` | local recipe topology | FEM CPU/GPU (authoring only for `swept_hex`); FDM not applicable | `mesh_workflow` |
| `sweep_face_meshing` | `Literal["triangular", "quadrilateral"] \| None` | `None` | $1$ | consistent with strategy (`"quadrilateral"` required for `hex`) | source faces (`quadrilateral` for hex) | FEM CPU/GPU (authoring only for `swept_hex`); FDM not applicable | `mesh_workflow` |
| `element_family` | `Literal["prism", "hex"] \| None` | `None` | $1$ | consistent with strategy (`"hex"` requires `swept_hex` and `"quadrilateral"`) | element family (`hex`) | FEM CPU/GPU (authoring only for `swept_hex`); FDM not applicable | `mesh_workflow` |
| `transition_policy` | `Literal["pyramid_to_tetrahedra", "pure_prism", "reject"] \| None` | `None` | $1$ | `hex` rejects both `"pyramid_to_tetrahedra"` and `"pure_prism"` (only `"reject"` is valid) | transition policy | FEM CPU/GPU (authoring only for `swept_hex`); FDM not applicable | `mesh_workflow` |

Failure behavior: `transition_policy="pyramid_to_tetrahedra"` or
`transition_policy="pure_prism"` together with `swept_hex` / `element_family="hex"`
→ `ValueError` (contradictory combination).

ProblemIR mapping: fields land in the object recipe; no qualified backend
realization exists.

(python-api-meshing-fem-ferromagnet-swept-hex-problem-ir)=
## ProblemIR
The request lowers to the mesh-workflow or discretization subtree; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-ferromagnet-swept-hex-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fem-ferromagnet-swept-hex-discrete-realization)=
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

(python-api-meshing-fem-ferromagnet-swept-hex-implementation-mapping)=
## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | unsupported | no qualified realization |
| FEM | GPU | unsupported | ditto |
| FDM | CPU/GPU | not applicable | use the FDM meshing API ({doc}`../../fdm/index`) |

(python-api-meshing-fem-ferromagnet-swept-hex-validation)=
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-ferromagnet-swept-hex-limitations)=
## 7. Limitations and known pitfalls

- Do not assume "Python accepted it, so it works": representability ≠ production
  qualification.
- Bypassing through advanced recipe JSON ends in a validation error or an explicit
  fallback recorded in the build report.

(python-api-meshing-fem-ferromagnet-swept-hex-scientific-bibliography)=
## 8. Scientific bibliography

No physical claims on this page.

(python-api-meshing-fem-ferromagnet-swept-hex-source-code-index)=
## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| swept-hex object policy and lowering | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | [`class PerObjectMeshRecipe`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | validation tests |
| allowed `mesh_strategy` values | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe.mesh_strategy` | name-set validation |
| rejection of contradictory transitions (`pyramid_to_tetrahedra`, `pure_prism`) | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L964) | `PerObjectMeshRecipe` / `SweptMeshControls` (hex validation) | validation branch `hex mesh contradicts ...` |
