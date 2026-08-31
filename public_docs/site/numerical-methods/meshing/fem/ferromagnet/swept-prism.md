---
title: "Swept-prism ferromagnet mesh"
description: "Exact P1 layered prism meshing for supported sweepable thin films."
summary: "The strict route produces native prism6 layers and rejects topology, layer, and transition mismatches."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 969efa0941905825ac569d525f4bdaefc059e2af
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-swept-prism)=
# Swept-prism ferromagnet mesh

(swept-prism-problem-statement)=
## Physical problem

The strict route extrudes a triangular source face into native `prism6` layers. A qualified shared domain can use typed `pyramid5` transitions to `tet4`; it does not split prisms into tetrahedra.

(swept-prism-governing-equations)=
## Governing equations

```{math}
:label: eq-swept-prism-layer-planes
N_{\mathrm{planes}}=n+1,\qquad t_c=\mathrm{prism6}\ \text{in the swept body}.
```

(swept-prism-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $n$ | Requested element-layer count | $1$ |
| $N_{\mathrm{planes}}$ | Resolved node-plane count | $1$ |
| $t_c$ | Swept-body cell family | $1$ |
| $c$ | Volume-cell ordinal | $1$ |

(swept-prism-assumptions-and-validity)=
## Assumptions and validity

The native body path is an axis-aligned `Box`, P1, fixed distribution, triangular source, and positive integer layers. Control Room additionally enables authoring only when all layered-prism capabilities are executable and supported counts equal `[1,2,3]`.

(swept-prism-python-api)=
## Python API

```python
# %%
import fullmag as fm

nm = 1e-9
study = fm.study("strict_prism")
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

(swept-prism-problem-ir)=
## ProblemIR

For `topology="prismatic"`, `GeometryMeshHandle.thin_film()` lowers to `mesh_strategy="swept_prism"`, `through_thickness_elements=layers`, `through_thickness_distribution="fixed"`, `through_thickness_symmetric=False`, `sweep_face_meshing="triangular"`, `topology="prismatic"`, `sweep_direction="auto"`, `element_family="prism"`, `transition_policy="pyramid_to_tetrahedra"`, `exact_layer_count=True`, and `order=1`. `PerObjectMeshRecipe` itself accepts distributions `None|fixed|linear|exponential` and directions `None|auto|x|y|z`; `thin_film()` intentionally selects `fixed` and `auto` for strict prismatic authoring. The realization report separately records requested/resolved topology, axis, layers, order, and fallbacks.

All four transition-distance arguments accept the sentinels `airbox_boundary`, `airbox-boundary`, and `auto_boundary`; lowering canonicalizes each to `airbox_boundary`. Perimeter validation also enforces `corner_hmax <= edge_hmax` when both are active and, for a `Box` (including translated boxes), requires `edge_thickness` and `corner_extent` to be strictly smaller than half the shorter in-plane dimension.

(swept-prism-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is the public `thin_film()` call and its lowered object policy. **Resolved execution** must report `prism6`, exact layers, P1, and no fallback. **Validation errors** reject zero/non-integer layers, non-P1 order, recipe distributions outside `None|fixed|linear|exponential`, recipe directions outside `None|auto|x|y|z`, wrong realized family, and wrong layer count. `pyramid_to_tetrahedra` is mandatory when `topology="prismatic"`, not for every prism-family policy. **Unsupported combinations** include `swept_hex` and non-box geometry for explicit native prism strategy. A `tet4` result is failure.

(swept-prism-discrete-realization)=
## Discrete realization

`generate_swept_mesh` dispatches strict prism generation. Its extractor requires `prism6`-only volume cells and `tri3`/`quad4` facets, validates orientation, and checks exact layer planes. Shared transitions retain `pyramid5` and `tet4` types.

| Solver | Device | Status | Reason |
| --- | --- | --- |
| FEM | CPU | source-backed, capability-gated | No runtime receipt is claimed. |
| FEM | GPU | source-backed, capability-gated | No GPU identity or parity result is claimed. |
| FDM | CPU | not applicable | FEM meshing. |
| FDM | GPU | not applicable | FEM meshing. |

(swept-prism-implementation-mapping)=
## Implementation mapping

`GeometryMeshHandle.thin_film` owns public authoring and lowering; `PerObjectMeshRecipe` owns policy validation; `generate_swept_mesh` owns dispatch; `resolveObjectMeshTopologyCapabilities` implements the exact Control Room gate.

(swept-prism-validation)=
## Validation

Focused tests assert exact planes, all axes, prism-only realization, strict wrong-family/layer rejection, no prism splitter, and no swept-hex fallback. They do not establish CPU/GPU runtime qualification or mesh convergence.

(swept-prism-limitations)=
## Limitations

This is not a general sweepability, higher-order, arbitrary UI layer-count, nonuniform exact-layer, GPU parity, or observable-convergence claim.

(swept-prism-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, "Gmsh," *International Journal for Numerical Methods in Engineering* **79** (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, "Micromagnetics and spintronics," *European Physical Journal B* **92** (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(swept-prism-source-code-index)=
## Source-code index

| Path | Stable symbol | Responsibility |
| --- | --- | --- |
| `packages/fullmag-py/src/fullmag/world.py` | `thin_film` | Public prismatic authoring and lowering |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class PerObjectMeshRecipe` | Policy validation |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_swept_mesh` | Native dispatch |
| `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts` | `resolveObjectMeshTopologyCapabilities` | Capability gate |
| `packages/fullmag-py/tests/test_mixed_element_meshing.py` | `test_body_only_box_prism_mesh_has_exact_requested_layers` | Exact layers |
