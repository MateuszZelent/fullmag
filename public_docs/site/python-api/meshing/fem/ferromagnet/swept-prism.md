---
title: Swept-Prism API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-swept-prism)=
# Swept-Prism API

## 1. What it is and when to use it

`object.mesh.thin_film(..., topology="prismatic")` requests a strict swept-prism
mesh through the object thickness: exactly `layers` P1 element layers, a fixed
distribution, triangular source faces, and a pyramid-to-tetrahedra transition into
the surrounding shared-domain mesh.

When to use it:

- thin-film structures where the vertical magnetization profile matters
  (bilayers, interface damping),
- you need a **guaranteed** number of element layers through the thickness,
- you want predictable topology (prisms) instead of adaptive tetrahedra.

When to pick something else: no exact-layer requirement →
{doc}`thin-film-tetrahedral`; non-sweepable geometries → {doc}`free-tetrahedral`.

Impact on the simulation: exact layers give controlled discretization of the
normal gradient; cost grows linearly with `layers`.

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
study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

## 4. Exact API

Canonical path: `object.mesh.thin_film(topology="prismatic", ...)`
(`GeometryMeshHandle.thin_film`, prismatic branch). Full parameter table:
{doc}`thin-film-tetrahedral` (section 4). Mode-specific fields:

| Parameter | Enforced values | Meaning |
|---|---|---|
| `topology` | `"prismatic"` | selects the prism mode |
| `order` | `1` (P1) | linear order only |
| `exact_layers` | `True` in strict (`False` only in extended) | require the exact layer count |
| `transition` | `"pyramid_to_tetrahedra"` | transition into domain tetrahedra |
| `layers` | positive integer | prism layer count |

The equivalent advanced recipe (`PerObjectMeshRecipe`) must set consistently:
`mesh_strategy="swept_prism"`, `through_thickness_elements=layers`,
`through_thickness_distribution="fixed"`, `sweep_face_meshing="triangular"`,
`element_family="prism"`, `transition_policy="pyramid_to_tetrahedra"`,
`exact_layer_count=True`, `topology="prismatic"`. Missing companion fields fail
validation.

Failure behavior: `order != 1`, `exact_layers=False` in strict mode,
`transition != "pyramid_to_tetrahedra"` → `ValueError`; an incomplete advanced
recipe → recipe validation `ValueError`.

ProblemIR mapping: canonicalization happens inside the helper (section 9); the IR
already sees a consistent `swept_prism` recipe.

## 5. How to set it in Control Room

```
Model Explorer
└── Objects
    └── <object>
        └── Mesh            → selection kind: object.mesh
```

The **Object Mesh Policy** inspector: the *Thin-Film Sweep Strategy* group —
selecting `swept_prism` canonicalizes the exact-layered-prism fields (P1,
triangular source faces, fixed distribution, exact layer count, prism family,
`pyramid_to_tetrahedra`). The UI gate accepts only layer counts advertised by
`mesh.exact_layer_count`; `swept_hex` remains disabled.

**Apply Object Policy** writes the recipe; **Build Mesh** materializes the mesh.
Full panel description: {doc}`../../../frontend/meshing/object-mesh`.

## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | implemented | Gmsh swept; exact layers for sweepable geometries |
| FEM | GPU | capability-gated | identical content-addressed mesh |
| FDM | CPU/GPU | not applicable | use the FDM meshing API ({doc}`../../fdm/index`) |

## 7. Limitations and known pitfalls

- The mode requires sweepable geometry (opposite source/target faces); complex
  solids fall out — use {doc}`free-tetrahedral`.
- The prism→pyramid→tetrahedron transition introduces pyramid elements at the
  object boundary; account for them when interpreting mesh quality.
- `exact_layers=False` is available only in extended mode and should never appear
  in production scripts.

## 8. Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh,” *Int. J. Numer. Methods Eng.* **79**, 1309–1331 (2009).

## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| canonical helper and strict validation | `packages/fullmag-py/src/fullmag/world.py` | `GeometryMeshHandle.thin_film` | validation in method body |
| canonicalization to swept_prism | `packages/fullmag-py/src/fullmag/world.py` | `GeometryMeshHandle.thin_film` (prismatic branch) | `candidate.*` assignments in code |
| advanced recipe consistency | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe` (swept validation) | recipe validation tests |
| typed swept controls | `packages/fullmag-py/src/fullmag/model/discretization.py` | `SweptMeshControls` | validation tests |
