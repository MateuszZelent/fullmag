---
title: FEM Ferromagnet Mesh API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-root)=
# FEM Ferromagnet Mesh API

## 1. What it is and when to use it

Object mesh policy is **owned by the object**: every magnetic object carries its
own recipe (`PerObjectMeshRecipe`) that overrides study-level defaults. This is the
"per-object mesh config" layer of the three-layer FEM mesh doctrine (universe →
object → shared solver mesh).

Mode selection:

| Need | Page |
|---|---|
| ordinary unstructured mesh | {doc}`free-tetrahedral` |
| thin film, through-thickness target | {doc}`thin-film-tetrahedral` |
| exact prism layers (P1) | {doc}`swept-prism` |
| swept hexes (non-production) | {doc}`swept-hex` |
| surface refinement | {doc}`boundary-layers` |
| external prebuilt mesh | {doc}`imported-mesh` |

Impact on the simulation: the object recipe controls local gradient resolution
(exchange, domain walls, interfaces) independently per object; the final mesh
remains one conforming shared-domain mesh.

## 2. Physical and mathematical explanation

An authoring layer, not a physical model. The object recipe selects the discrete
space locally for that object; cross-object consistency is provided by the shared
solver mesh. Size the elements with respect to the exchange length:

$$
l_{\mathrm{ex}} = \sqrt{\frac{2A}{\mu_0 M_s^2}},
$$

where $A$ — exchange stiffness ($\mathrm{J\,m^{-1}}$), $M_s$ — saturation
magnetization ($\mathrm{A\,m^{-1}}$).

| Symbol | Meaning | SI unit |
|---|---|---|
| $l_{\mathrm{ex}}$ | exchange length | $\mathrm{m}$ |
| $A$ | exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |

## 3. Example — complete Python script

```python
# %% Object-owned mesh policy overview
import fullmag as fm

nm = 1.0e-9

study = fm.study("ferromagnet_mesh_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
study.universe.mesh(
    minimum_element_size=8 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

film = study.geometry(fm.Box(300 * nm, 100 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

# Ordinary unstructured policy:
film.mesh(minimum_element_size=2.5 * nm, maximum_element_size=5 * nm, order=1)
# ...or explicit thin-film topology:
# film.mesh.thin_film(layers=4, topology="tetrahedral", maximum_element_size=5 * nm)

study.exchange()
study.demag(model="airbox", variant="robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

## 4. Exact API

Three authoring levels:

1. **Ordinary** — `object.mesh(**kwargs)`: sizes, order, quality, boundary layers
   ({doc}`free-tetrahedral`).
2. **Topology helper** — `object.mesh.thin_film(...)`: tetrahedral or prismatic
   through the thickness ({doc}`thin-film-tetrahedral`, {doc}`swept-prism`).
3. **Advanced** — a direct `PerObjectMeshRecipe`: full control of strategy,
   ordered operations, size fields, and swept controls.

Every mode has its own command, required companion fields, and capability
boundary; disallowed combinations end in validation errors, never in silent
replacement.

ProblemIR mapping: the object recipe (`PerObjectMeshRecipe`) is the canonical
representation; the study supplies only lowest-precedence defaults.

## 5. How to set it in Control Room

```
Model Explorer
└── Objects
    └── <object>
        └── Mesh            → selection kind: object.mesh
```

The **Object Mesh Policy** inspector (`ObjectMeshPolicyPanel.tsx`) groups all
authoring levels: size presets, element size parameters, thin-film strategy,
interface/edge refinement, backend parameters, advanced JSON, and the
Quality/History tabs. Full description: {doc}`../../../../frontend/meshing/object-mesh`.

## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | implemented | all modes except `swept_hex` |
| FEM | GPU | capability-gated | identical content-addressed mesh |
| FDM | CPU/GPU | not applicable | per-magnet grids: {doc}`../../fdm/per-magnet-grids` |

## 7. Limitations and known pitfalls

- An object recipe does not create a separate mesh — the final solver mesh is one
  conforming mesh; cross-object conflicts are resolved by build policy.
- Study-level defaults have the lowest precedence against object recipes.

## 8. Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh,” *Int. J. Numer. Methods Eng.* **79**, 1309–1331 (2009).

## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| ordinary facade and helper | `packages/fullmag-py/src/fullmag/world.py` | `GeometryMeshHandle.__call__`, `GeometryMeshHandle.thin_film` | method signatures |
| object recipe | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe` | validation tests |
| ordered operations | `packages/fullmag-py/src/fullmag/world.py` | `_MeshOperationSpec` | class definition |
| typed swept controls | `packages/fullmag-py/src/fullmag/model/discretization.py` | `SweptMeshControls` | validation tests |

```{toctree}
:maxdepth: 2

../../../discretization/per-object-meshing
free-tetrahedral
thin-film-tetrahedral
swept-prism
swept-hex
boundary-layers
imported-mesh
```
