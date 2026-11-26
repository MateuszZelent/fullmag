---
title: Swept-Prism API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-swept-prism)=
# Swept-Prism API

(python-api-meshing-fem-ferromagnet-swept-prism-symbols-and-si-units)=
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fem-ferromagnet-swept-prism-assumptions-and-validity)=
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

(python-api-meshing-fem-ferromagnet-swept-prism-problem-statement)=
## 1. What it is and when to use it

`object.mesh.thin_film(..., topology="prismatic")` (or `object.mesh.swept(..., face_meshing="triangular")`)
requests a strict swept-prism mesh through the object thickness: exactly `layers` element layers,
a fixed distribution, triangular source faces, and either:

- `transition="pyramid_to_tetrahedra"` (default) — prism layers inside the film connected through a
  conforming pyramid layer to surrounding airbox tetrahedra (with the Chebyshev mixed-tet untangler
  preventing same-side tet inversion for `layers >= 2`); or
- `transition="pure_prism"` — pure-prism thin-film shared domain (zero pyramids/tetrahedra) where
  magnetization remains P1 nodal while the native FEM solver automatically elevates the scalar
  magnetic potential $\phi$ to quadratic `H1_WedgeElement(2)` (P2) via `pure_prism_p2` on both CPU
  and GPU (including CSR DMI, CG+AMG, and cuDSS Poisson; see
  {ref}`numerical-methods-performance-fem-gpu-demag`).

When to use it:

- thin-film structures where the vertical magnetization profile matters
  (bilayers, interface damping),
- you need a **guaranteed** number of element layers through the thickness,
- you want predictable topology (prisms) instead of adaptive tetrahedra.

When to pick something else: no exact-layer requirement →
{doc}`thin-film-tetrahedral`; non-sweepable geometries → {doc}`free-tetrahedral`.

Impact on the simulation: exact layers give controlled discretization of the
normal gradient; cost grows linearly with `layers`.

(python-api-meshing-fem-ferromagnet-swept-prism-governing-equations)=
## 2. Physical and mathematical explanation

This page introduces no equation of its own; it establishes a topological
contract. For $N_{\mathrm{layers}}$ layers and film thickness
$t_{\mathrm{film}}$, the prism height along the normal is exactly:

$$
h_{\perp} = \frac{t_{\mathrm{film}}}{N_{\mathrm{layers}}},
$$

in contrast to tetrahedral mode, where $h_\perp$ is only a target. Discretization
of normal derivatives (e.g. interlayer exchange energy) therefore has a constant,
known step $\Delta z = h_\perp$.

| Symbol | Meaning | SI unit |
|---|---|---|
| $h_{\perp}$ | prism height along the normal | $\mathrm{m}$ |
| $t_{\mathrm{film}}$ | object thickness | $\mathrm{m}$ |
| $N_{\mathrm{layers}}$ | exact prism layer count | $1$ |

## 3. Example — complete Python script

```python
# %% Exact layered prism mesh through film thickness
import fullmag as fm

nm = 1.0e-9

study = fm.study("swept_prism_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(1200 * nm, 600 * nm, 550 * nm))
study.universe.mesh(
    minimum_element_size=8 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.Ms = 8.0e5            # A/m
film.Aex = 1.3e-11         # J/m
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh.thin_film(
    minimum_element_size=3 * nm,
    maximum_element_size=5 * nm,
    layers=2,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)

study.exchange()
study.demag(model="airbox", variant="robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", algorithm="projected_gradient_bb", tolT=1.0e-6)
```

(python-api-meshing-fem-ferromagnet-swept-prism-python-api)=
## 4. Exact API

Canonical path: `object.mesh.thin_film(topology="prismatic", ...)`
(`GeometryMeshHandle.thin_film`, prismatic branch). Full parameter table:
{doc}`thin-film-tetrahedral` (section 4). Mode-specific fields:

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `topology` | `str \| None` | `None` | $1$ | `"prismatic"` | selects the prism mode | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `order` | `int \| None` | `None` | $1$ | `1` (P1 magnetization; `transition="pure_prism"` automatically elevates scalar potential $\phi$ to P2 `H1_WedgeElement(2)` via `pure_prism_p2`) | user-authored magnetization basis order | FEM CPU/GPU (`tet4`/mixed P1 and `pure_prism_p2`); FDM not applicable | `mesh_workflow` |
| `exact_layers` | `bool \| None` | `None` | $1$ | `True` in strict (`False` only in extended) | require the exact layer count | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `transition` | `Literal["pyramid_to_tetrahedra", "pure_prism", "reject"] \| None` | `"pyramid_to_tetrahedra"` | $1$ | `"pyramid_to_tetrahedra"` or `"pure_prism"` for `topology="prismatic"` (`"reject"` also accepted on `SweptMeshControls` / `swept()`) | transition into surrounding domain (`"pyramid_to_tetrahedra"` uses Chebyshev mixed-tet untangler for `layers >= 2`; `"pure_prism"` activates `pure_prism_p2`) | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `layers` | `int \| None` | `None` | $1$ | positive integer | prism layer count | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |

The equivalent advanced recipe (`PerObjectMeshRecipe`) must set consistently:
`mesh_strategy="swept_prism"`, `through_thickness_elements=layers`,
`through_thickness_distribution="fixed"`, `sweep_face_meshing="triangular"`,
`element_family="prism"`, `transition_policy="pyramid_to_tetrahedra"` or
`transition_policy="pure_prism"`, `exact_layer_count=True`, `topology="prismatic"`.
Missing companion fields fail validation.

Failure behavior: `order != 1`, `exact_layers=False` in strict mode,
`transition not in {"pyramid_to_tetrahedra", "pure_prism"}` for `topology="prismatic"`
→ `ValueError`; an incomplete advanced recipe → recipe validation `ValueError`.

ProblemIR mapping: canonicalization happens inside the helper (section 9); the IR
already sees a consistent `swept_prism` recipe.

(python-api-meshing-fem-ferromagnet-swept-prism-problem-ir)=
## ProblemIR
The request lowers to the mesh-workflow or discretization subtree; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-ferromagnet-swept-prism-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fem-ferromagnet-swept-prism-discrete-realization)=
## Discrete realization
The backend consumes the realized Cartesian or finite-element asset, including topology, markers, quality, and provenance where available.

## 5. How to set it in Control Room

```
Model Explorer
└── Objects
    └── <object>
        └── Mesh            → selection kind: object.mesh
```

The **Object Mesh Policy** inspector (`ObjectMeshInspectorSpecPanel` in
`apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx`):
the *Thin-Film Sweep Strategy* group — selecting `swept_prism` canonicalizes
the exact-layered-prism fields (triangular source faces, fixed distribution,
exact layer count, prism family, `pyramid_to_tetrahedra` or `pure_prism`
transition). The UI gate accepts only layer counts advertised by
`mesh.exact_layer_count`; `swept_hex` remains disabled.

**Apply Object Policy** writes the recipe; **Build Mesh** materializes the mesh.
Full panel description: {doc}`../../../../frontend/meshing/object-mesh`.

(python-api-meshing-fem-ferromagnet-swept-prism-implementation-mapping)=
## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | implemented | Gmsh swept; exact layers for sweepable geometries |
| FEM | GPU | capability-gated | identical content-addressed mesh |
| FDM | CPU/GPU | not applicable | use the FDM meshing API ({doc}`../../fdm/index`) |

(python-api-meshing-fem-ferromagnet-swept-prism-validation)=
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-ferromagnet-swept-prism-limitations)=
## 7. Limitations and known pitfalls

- The mode requires sweepable geometry (opposite source/target faces); complex
  solids fall out — use {doc}`free-tetrahedral`.
- The prism→pyramid→tetrahedron transition introduces pyramid elements at the
  object boundary; account for them when interpreting mesh quality.
- `exact_layers=False` is available only in extended mode and should never appear
  in production scripts.

(python-api-meshing-fem-ferromagnet-swept-prism-scientific-bibliography)=
## 8. Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh,” *Int. J. Numer. Methods Eng.* **79**, 1309–1331 (2009).

(python-api-meshing-fem-ferromagnet-swept-prism-source-code-index)=
## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| swept-prism object policy and lowering | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | [`class PerObjectMeshRecipe`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | recipe validation tests |
| canonical helper and strict validation | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1681) | [`class GeometryMeshHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1681) (`thin_film`, `swept`) | validation in method body |
| typed swept controls | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L413) | [`class SweptMeshControls`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L413) | validation tests |
| Chebyshev mixed-tet untangler (`layers >= 2`) | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L2250) | [`_chebyshev_center_3d`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L2250) | pure_prism and mixed-tet untangler tests |
