---
title: "Mixed-element FEM meshes"
description: "Typed tet4, prism6, pyramid5 and hex8 topology."
summary: "Mixed topology is preserved as typed CSR data and never silently coerced to tet4."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 969efa0941905825ac569d525f4bdaefc059e2af
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-mixed-elements)=
# Mixed-element FEM meshes

(mixed-elements-problem-statement)=
## Physical problem

This FEM contract carries linear `tet4`, `prism6`, `pyramid5`, and imported `hex8` cells explicitly. A family is solver input, not display metadata; preserving `hex8` at ingress does not qualify an executable swept-hex solver.

(mixed-elements-governing-equations)=
## Governing equations

Variable-arity connectivity is stored in typed CSR form:

```{math}
:label: eq-mixed-elements-csr
o_{c+1}-o_c=a(t_c),\qquad K_c=\mathrm{cell\_nodes}[o_c:o_{c+1}].
```

(mixed-elements-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $c$ | Volume-cell ordinal | $1$ |
| $o_c$ | Start offset of cell $c$ | $1$ |
| $t_c$ | Canonical cell family of cell $c$ | $1$ |
| $a(t_c)$ | Family node arity | $1$ |
| $K_c$ | Local node-index sequence | $1$ |

(mixed-elements-assumptions-and-validity)=
## Assumptions and validity

The carrier is linear typed topology: 4, 6, 5, and 8 nodes for `tet4`, `prism6`, `pyramid5`, and `hex8`. `pyramid5` is a prism--tet transition family, not a prism replacement. Mixed compatibility views fail rather than converting to tetrahedra.

(mixed-elements-python-api)=
## Python API

```python
# %%
import fullmag as fm

nm = 1e-9
study = fm.study("mixed_film")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(100 * nm, 80 * nm, 65 * nm), center=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=40 * nm, minimum_element_size=15 * nm, growth_rate=1.3, grading="geometric")

# %%
film = study.geometry(fm.Box(size=(24 * nm, 12 * nm, 1 * nm), name="film"), name="film")
film.mesh.thin_film(
    maximum_element_size=3 * nm,
    minimum_element_size=1 * nm,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)
film.Ms = 800e3
film.Aex = 13e-12
film.m = fm.texture.uniform(1.0, 1e-4, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", algorithm="llg_overdamped", tolA=1e-4, max_steps=20_000, dt=1e-13)
```

`GeometryMeshHandle.thin_film` is the supported public authoring callable for this strict route:

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hmax` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive finite number or `auto`; overridden by `maximum_element_size` | Compatibility maximum-size alias | FEM capability-gated; FDM N/A | `maximum_element_size` |
| `hmin` | `float \| None` | `None` | $\mathrm{m}$ | positive; overridden by `minimum_element_size`; resolved minimum must not exceed numeric maximum | Compatibility minimum-size alias | FEM capability-gated; FDM N/A | `minimum_element_size` |
| `maximum_element_size` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive finite number or `auto`; takes precedence over `hmax` | In-plane size ceiling | FEM capability-gated; FDM N/A | `maximum_element_size` |
| `minimum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive; takes precedence over `hmin`; must not exceed numeric maximum | Lower size bound | FEM capability-gated; FDM N/A | `minimum_element_size` |
| `order` | `int \| None` | `None` | $1$ | prismatic topology accepts only `None` or `1` and lowers to P1 | FEM polynomial order | FEM capability-gated; FDM N/A | `order` |
| `curvature_factor` | `float \| None` | `None` | $1$ | float-convertible; downstream recipe requires a positive value when set | Curvature-refinement strength | FEM capability-gated; FDM N/A | `curvature_factor` |
| `narrow_region_resolution` | `float \| None` | `None` | $1$ | float-convertible; downstream recipe requires a positive value when set | Narrow-region refinement strength | FEM capability-gated; FDM N/A | `narrow_region_resolution` |
| `layers` | `int` | `1` | $1$ | bool rejected; integer at least 1 | Requested element-layer count | FEM capability-gated; FDM N/A | `through_thickness_elements` |
| `topology` | `Literal["tetrahedral", "prismatic"] \| None` | `None` | $1$ | one of `None`, `tetrahedral`, `prismatic` | Thin-film topology | FEM capability-gated; FDM N/A | `topology` |
| `exact_layers` | `bool \| None` | `None` | $1$ | Boolean; only valid with prismatic topology; strict prismatic rejects `False` outside extended mode | Strict layer-count intent | FEM capability-gated; FDM N/A | `exact_layer_count` |
| `transition` | `Literal["pyramid_to_tetrahedra", "reject"] \| None` | `None` | $1$ | only valid with prismatic topology; prismatic resolves or requires `pyramid_to_tetrahedra` | Shared-domain transition | FEM capability-gated; FDM N/A | `transition_policy` |
| `interface_maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive; used unless `surface_maximum_element_size` is set | Interface size ceiling | FEM capability-gated; FDM N/A | `interface_hmax` |
| `surface_maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive; takes precedence over `interface_maximum_element_size` | Surface alias for interface size | FEM capability-gated; FDM N/A | `interface_hmax` |
| `interface_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive; used unless `surface_thickness` is set | Interface refinement-shell thickness | FEM capability-gated; FDM N/A | `interface_thickness` |
| `surface_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive; takes precedence over `interface_thickness` | Surface alias for interface shell | FEM capability-gated; FDM N/A | `interface_thickness` |
| `transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | number at least 0 or `airbox_boundary`, `airbox-boundary`, `auto_boundary`; sentinels normalize to `airbox_boundary`; used unless surface alias is set | Interface-to-core transition distance | FEM capability-gated; FDM N/A | `transition_distance` |
| `surface_transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | number at least 0 or `airbox_boundary`, `airbox-boundary`, `auto_boundary`; sentinels normalize to `airbox_boundary`; takes precedence over `transition_distance` | Surface alias for transition distance | FEM capability-gated; FDM N/A | `transition_distance` |
| `edge_maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive; must be paired with `edge_thickness` | Edge size ceiling | FEM capability-gated; FDM N/A | `edge_hmax` |
| `edge_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive; paired with `edge_maximum_element_size`; for Box geometry smaller than half the shorter in-plane dimension | Edge refinement-shell thickness | FEM capability-gated; FDM N/A | `edge_thickness` |
| `edge_transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive number or `airbox_boundary`, `airbox-boundary`, `auto_boundary`; sentinels normalize to `airbox_boundary`; requires the edge pair | Edge-to-core transition distance | FEM capability-gated; FDM N/A | `edge_transition_distance` |
| `corner_maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive; paired with `corner_extent`; when edge size is set must not exceed `edge_maximum_element_size` | Corner size ceiling | FEM capability-gated; FDM N/A | `corner_hmax` |
| `corner_extent` | `float \| None` | `None` | $\mathrm{m}$ | positive; paired with `corner_maximum_element_size`; for Box geometry smaller than half the shorter in-plane dimension | Corner refinement extent | FEM capability-gated; FDM N/A | `corner_extent` |
| `corner_transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive number or `airbox_boundary`, `airbox-boundary`, `auto_boundary`; sentinels normalize to `airbox_boundary`; requires the corner pair | Corner-to-core transition distance | FEM capability-gated; FDM N/A | `corner_transition_distance` |

(mixed-elements-problem-ir)=
## ProblemIR

For `topology="prismatic"`, `thin_film()` lowers the request to `mesh_strategy="swept_prism"`, `through_thickness_elements=layers`, `through_thickness_distribution="fixed"`, `through_thickness_symmetric=False`, `sweep_face_meshing="triangular"`, `sweep_direction="auto"`, `element_family="prism"`, `transition_policy="pyramid_to_tetrahedra"`, `exact_layer_count=True`, and `order=1`. The underlying `PerObjectMeshRecipe` accepts `through_thickness_distribution` values `None`, `fixed`, `linear`, or `exponential`, and `sweep_direction` values `None`, `auto`, `x`, `y`, or `z`; those broader values are not additional arguments to `thin_film()`.

All four transition-distance arguments accept the sentinels `airbox_boundary`, `airbox-boundary`, and `auto_boundary`; lowering canonicalizes each to `airbox_boundary`. Perimeter validation also enforces `corner_hmax <= edge_hmax` when both are active and, for a `Box` (including translated boxes), requires `edge_thickness` and `corner_extent` to be strictly smaller than half the shorter in-plane dimension.

(mixed-elements-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is the `thin_film()` call and lowered object policy. **Resolved execution** is the typed `MeshData` and realization report. **Validation errors** reject invalid CSR arity, invalid recipe distribution/direction, and any prismatic request whose transition is not `pyramid_to_tetrahedra`. That transition is mandatory because `topology="prismatic"`; it is not an unconditional rule for every policy whose family happens to be `prism`. **Unsupported combinations** include a solver/device lacking a realized family. No `prism6`, `pyramid5`, or `hex8` is silently replaced by `tet4`.

(mixed-elements-discrete-realization)=
## Discrete realization

`_MESHIO_VOLUME_TYPES` maps `tetra`, `wedge`/`prism`, `pyramid`, and `hexahedron` to canonical types; `_CELL_LOCAL_FACETS` supplies the local `tri3`/`quad4` faces.

| Solver | Device | Status | Reason |
| --- | --- | --- | --- |
| FEM | CPU | source-backed, capability-gated | Active execution must accept every realized family. |
| FEM | GPU | source-backed, capability-gated | No GPU runtime or parity evidence is claimed. |
| FDM | CPU | not applicable | FEM mesh topology. |
| FDM | GPU | not applicable | FEM mesh topology. |

(mixed-elements-implementation-mapping)=
## Implementation mapping

`GeometryMeshHandle.thin_film` is the public authoring callable. `PerObjectMeshRecipe` owns the lowered policy. `MeshData` owns canonical typed variable-arity CSR, while the extraction maps preserve typed volume and facet families. `test_mesh_data_accepts_canonical_mixed_typed_csr` asserts typed mixed CSR and rejects tetra-only compatibility access.

(mixed-elements-validation)=
## Validation

Focused tests cover typed CSR, arity, offsets, node indices, facets, and Gmsh prism ordering. This is source/test evidence, not an executed CPU/GPU solver qualification.

(mixed-elements-limitations)=
## Limitations

Imported `hex8` preservation does not establish hex assembly, a qualified transition, CPU/GPU execution, or observable convergence.

(mixed-elements-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, "Gmsh," *International Journal for Numerical Methods in Engineering* **79** (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, "Micromagnetics and spintronics," *European Physical Journal B* **92** (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(mixed-elements-source-code-index)=
## Source-code index

| Path | Stable symbol | Responsibility |
| --- | --- | --- |
| `packages/fullmag-py/src/fullmag/world.py` | `thin_film` | Public prismatic authoring and lowering |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class PerObjectMeshRecipe` | Lowered recipe validation and IR |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `class MeshData` | Canonical typed variable-arity CSR |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | `_MESHIO_VOLUME_TYPES` | Canonical volume families |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | `_CELL_LOCAL_FACETS` | Typed local facets |
| `packages/fullmag-py/tests/test_mixed_element_meshing.py` | `test_mesh_data_accepts_canonical_mixed_typed_csr` | No coercion regression |
