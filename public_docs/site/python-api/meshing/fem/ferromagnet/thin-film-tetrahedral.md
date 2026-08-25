---
title: Thin-Film Tetrahedral API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-thin-film-tetrahedral)=
# Thin-Film Tetrahedral API

## 1. What it is and when to use it

`object.mesh.thin_film(...)` requests a thickness-aware tetrahedral mesh: the
element size along the film normal is derived from the geometry thickness and the
requested `layers` count, instead of being left to the generic `free_tetrahedral`
algorithm.

When to use it:

- the object is clearly thin-film-like (thickness $\ll$ lateral dimensions),
  e.g. a 5 nm film on a substrate,
- you want thickness-controlled resolution (`layers`) without the full prismatic
  topology,
- you do not need guaranteed node planes or prisms.

When to pick something else:

| Need | Use |
|---|---|
| ordinary mesh without through-thickness control | {doc}`free-tetrahedral` |
| exact prism layers through the thickness | {doc}`swept-prism` |
| importing a prebuilt mesh | {doc}`imported-mesh` |

Impact on the simulation: elements that are too coarse through the film thickness
underestimate exchange energy and distort vertical magnetization profiles; the
tetrahedral mode treats `layers` as a **resolution request**, not a guarantee —
verify the realized subdivision in the mesh report
({doc}`../../../frontend/meshing/quality-and-reports`).

## 2. Physical and mathematical explanation

This page introduces no physical equation of its own; it selects the discrete
space of linear elements (`order=1`) for the exchange, demagnetization, and Zeeman
operators. The only quantitative relation is the target element size along the
normal:

$$
h_{\perp} \;\approx\; \frac{t_{\mathrm{film}}}{N_{\mathrm{layers}}},
$$

where $t_{\mathrm{film}}$ — object geometry thickness ($\mathrm{m}$),
$N_{\mathrm{layers}}$ — requested element layer count (dimensionless).
For the `tetrahedral` topology this value is an element-size target
(`minimum_element_size`), not a topological contract; the realization may deviate
after Gmsh adaptation.

| Symbol | Meaning | SI unit |
|---|---|---|
| $h_{\perp}$ | target element size along the normal | $\mathrm{m}$ |
| $t_{\mathrm{film}}$ | object thickness (from geometry) | $\mathrm{m}$ |
| $N_{\mathrm{layers}}$ | requested number of element layers | $1$ |

## 3. Example — complete Python script

```python
# %% Thin-film tetrahedral mesh for a Permalloy film
import fullmag as fm

nm = 1.0e-9

study = fm.study("thin_film_tetrahedral_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# Universe / airbox sizing
study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
study.universe.mesh(
    minimum_element_size=8 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

# Ferromagnetic film with thickness-aware tetrahedral meshing
film = study.geometry(fm.Box(300 * nm, 100 * nm, 5 * nm), name="film")
film.Ms = 800.0e3          # A/m
film.Aex = 13.0e-12        # J/m
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh.thin_film(
    minimum_element_size=1.25 * nm,   # ~ t/4 through-thickness target
    maximum_element_size=5 * nm,
    layers=4,
    topology="tetrahedral",
    order=1,
    compute_quality=True,
)

study.exchange()
study.demag(model="airbox", variant="robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

## 4. Exact API

Signature: `object.mesh.thin_film(**kwargs)` — all arguments are keyword-only;
defined in `packages/fullmag-py/src/fullmag/world.py`
(`GeometryMeshHandle.thin_film`).

| Parameter | Type | Default | Unit | Validation | Meaning |
|---|---|---|---|---|---|
| `maximum_element_size` / `hmax` | `float \| str \| None` | `None` | $\mathrm{m}$ | finite positive; aliases must agree | maximum element size |
| `minimum_element_size` / `hmin` | `float \| str \| None` | `None`; when absent — derived from thickness and `layers` | $\mathrm{m}$ | finite positive | minimum element size (through-thickness target) |
| `order` | `int \| None` | `None` | $1$ | `>= 1`; prismatic forces `1` | element order |
| `curvature_factor` | `float \| None` | `None` | $1$ | positive | curvature fitting control |
| `narrow_region_resolution` | `float \| None` | `None` | $1$ | positive | narrow-region resolution |
| `layers` | `int` | `1` | $1$ | positive | requested layer count through the thickness |
| `topology` | `"tetrahedral" \| "prismatic" \| None` | `None` (= legacy tetrahedral) | $1$ | only these names | through-thickness topology |
| `exact_layers` | `bool \| None` | `None` | $1$ | only with `topology="prismatic"` | require the exact layer count |
| `transition` | `"pyramid_to_tetrahedra" \| "reject" \| None` | `None` | $1$ | only with `topology="prismatic"` | transition to surrounding tetrahedra |
| `interface_maximum_element_size`, `surface_maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive | refinement at interfaces/surfaces |
| `interface_thickness`, `surface_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive | interface/surface zone thickness |
| `transition_distance`, `surface_transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | non-negative | size-transition distance |
| `edge_maximum_element_size`, `edge_thickness`, `edge_transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive/non-negative | edge refinement |
| `corner_maximum_element_size`, `corner_extent`, `corner_transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive/non-negative | corner refinement |

Failure behavior:

- any `topology` other than `tetrahedral`/`prismatic` → `ValueError`,
- `exact_layers`/`transition` without `topology="prismatic"` → `ValueError`,
- `topology="prismatic"` with `order != 1` or `exact_layers=False` in strict mode →
  `ValueError` (extended mode allows `exact_layers=False`),
- contradictory size aliases (`hmax` vs `maximum_element_size`) → `ValueError`.

ProblemIR mapping: fields land in the canonical object recipe
(`PerObjectMeshRecipe`). For `topology="prismatic"` the helper canonicalizes the
request into `mesh_strategy="swept_prism"` with
`through_thickness_elements=layers`,
`through_thickness_distribution="fixed"`, `sweep_face_meshing="triangular"`,
the `prism` family, and `transition_policy="pyramid_to_tetrahedra"`.

## 5. How to set it in Control Room

Path in the model explorer tree:

```
Model Explorer
└── Objects
    └── <object>            (e.g. "film")
        └── Mesh            → selection kind: object.mesh
```

Selecting the `Mesh` node opens the **Object Mesh Policy** inspector
(`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`;
registered as `object-mesh-policy` in
`apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`).

Panel groups relevant to this mode:

| Panel group | Fields |
|---|---|
| Element Size Parameters | `maximum_element_size`, `minimum_element_size`, `order` |
| Thin-Film Sweep Strategy | `mesh_strategy`, layer count, `topology`, transition |
| Interface and Transition Refinement | interface size/thickness, transition distance |
| Edge and Corner Refinement | edge/corner targets |
| Backend Mesh Parameters | `compute_quality`, Gmsh algorithms |

Transaction: **Apply Object Policy** writes the recipe and invalidates mesh
resources; **Build Mesh** executes `mesh.build-selected` (applying a dirty draft
first). Full panel description: {doc}`../../../frontend/meshing/object-mesh`.

## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | implemented | Gmsh free-tet with a through-thickness target; report is authoritative |
| FEM | GPU | capability-gated | identical content-addressed mesh; element/order coverage gated |
| FDM | CPU/GPU | not applicable | use the FDM meshing API ({doc}`../../fdm/index`) |

Page status: `partial` — `layers` is a resolution request; the realized route may
not keep exact node planes. Always check the build report.

## 7. Limitations and known pitfalls

- `layers` does not guarantee node planes in tetrahedral mode — the exact-layer
  contract applies only to `topology="prismatic"` with `exact_layers=True`.
- A very small `minimum_element_size` relative to lateral dimensions can generate
  a very large element count; start from the $h_\perp \approx t/N$ target.
- In strict mode contradictory intents end in a validation error, never in a
  silent topology replacement.

## 8. Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh,” *Int. J. Numer. Methods Eng.* **79**, 1309–1331 (2009).
2. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM, 2002.

## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| helper signature and validation | `packages/fullmag-py/src/fullmag/world.py` | `GeometryMeshHandle.thin_film` | validation in method body; meshing tests |
| prismatic → swept_prism canonicalization | `packages/fullmag-py/src/fullmag/world.py` | `GeometryMeshHandle.thin_film` (prismatic branch) | recipe round-trip tests |
| object recipe and strategies | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe.mesh_strategy` | strategy validation tests |
| $h_\perp = t/N$ target | `packages/fullmag-py/src/fullmag/world.py` | `GeometryMeshHandle.thin_film` (tetrahedral branch) | `body_hmin` derived from `classify_sweepability().thickness` |
