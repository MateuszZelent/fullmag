---
title: "Swept-prism ferromagnet mesh"
description: "Exact P1 layered prism meshing for sweepable thin magnetic bodies."
summary: "The swept-prism route extrudes a triangular source mesh into `prism6` layers and, in qualified shared domains, connects them to tetrahedra using `pyramid5` transition cells."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "Exact layered-prism capability gate, swept generator, mixed-element certificate and solver cell-family support"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-swept-prism)=
# Swept-prism ferromagnet mesh

**Last changes: 12:31 24.08.2026**

The swept-prism route extrudes a triangular source mesh into `prism6` layers and, in qualified shared domains, connects them to tetrahedra using `pyramid5` transition cells.

::::{admonition} Implementation status
:class: important

Control Room enables this route only when four capability IDs are executable and exact layer counts `[1,2,3]` are advertised. The strict contract requires P1, triangular source faces, fixed exact layers, prism family and pyramid-to-tetrahedra transition. Generic geometry/shared-domain support is not implied.
::::

## Scope and purpose

Select swept prisms when the through-thickness layer structure is scientifically relevant and the
magnetic body is sweepable between paired source/destination faces. This page is the detailed
user procedure for the route referenced by the general swept-mesh chapter.

## Scientific and numerical model

### Scientific invariants

A finite-element mesh is not only a visualization asset. It defines the trial/test spaces used by
exchange, anisotropy, DMI, magnetostatic and dynamic operators. The following conditions are therefore
part of the numerical contract:

1. Every magnetic volume has an unambiguous region marker and every exterior-air volume has the
   canonical air role.
2. Interfaces used by coupled operators are conforming, or an explicitly supported nonconforming
   coupling operator is selected. Fullmag's ordinary shared-domain path expects conformity.
3. Cell orientation is valid: the element mapping has a positive Jacobian at all required evaluation
   points. Inverted or collapsed cells are build failures, not warnings to ignore.
4. Requested topology, polynomial order, layer count and mesh-size controls are compared with the
   realized mesh. A topology change is legal only when the build mode permits fallback and the report
   names the actual method and reason.
5. Mesh convergence is assessed on physical observables—energy, average magnetization, switching
   field, eigenfrequency, linewidth or field error—not only on element count.

For exchange-dominated variation, a useful *starting* scale is the magnetostatic exchange length

```{math}
:label: eq-meshing-exchange-length-fem-ferromagnet-swept-prism
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

A `prism6` is formed by corresponding source-triangle vertices on two neighboring layer planes.
With $N$ volume layers, an exact uniform realization contains $N+1$ node planes. For local
in-plane triangle area $A_T$ and layer thickness $d_j$, the ideal signed cell volume is

```{math}
:label: eq-prism-cell-volume-fem-ferromagnet-swept-prism
V_{T,j}=A_Td_j
```

up to the physical mapping for nonparallel surfaces. The reference-to-physical Jacobian must be
positive at all required integration points. In a prism-to-tetrahedron transition, pyramids are
not optional decoration: they reconcile quadrilateral prism faces with triangular tetrahedral
faces while preserving conformity.

The exact-layer certificate should compare actual plane coordinates with requested coordinates
under a scale-aware tolerance and should count cells by family and region.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| One layer / thickness-averaged film | 1 prism layer | Two node planes; still validate whether the physical model permits uniform thickness |
| Resolve linear thickness variation | 2 prism layers | Three node planes and one interior plane |
| Resolve additional thickness structure | 3 prism layers | Current reviewed authoring maximum; four node planes |
| More than 3 layers | not enabled by current Control Room gate | Requires expanded capability evidence before authoring |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `maximum_element_size` | m | required for direct FEM generation | positive finite | coarse upper target; local size fields may request smaller elements |
| `minimum_element_size` | m | unset | positive and not greater than the maximum | lower size clamp for local refinement and curvature sizing |
| `maximum_element_growth_rate` | 1 | preset/backend dependent | positive | limits requested growth between neighboring size zones |
| `calibrate_for` | 1 | unset | named calibration family | selects physics-aware preset calibration |
| `size_preset` | 1 | unset | extremely fine through extremely coarse | fills common size/growth/curvature controls before explicit overrides |
| `size_factor` | 1 | `1` | positive | multiplies preset-derived target sizes |
| `curvature_factor` | 1 | unset | positive when set | controls curvature-driven refinement; smaller values generally refine more |
| `narrow_region_resolution` | 1 | unset | positive when set | requests additional resolution in narrow geometric gaps/features |
| `order` | 1 | `1` | positive integer; topology/device support may be narrower | finite-element polynomial order |
| `algorithm_2d` | Gmsh ID | `6` | supported Gmsh 2-D algorithm number | surface triangulation before volume meshing |
| `algorithm_3d` | Gmsh ID | `1` | supported Gmsh 3-D algorithm number | volume tetrahedralization algorithm |
| `smoothing_steps` | passes | `1` | non-negative integer | post-generation node smoothing |
| `optimize` | 1 | unset | Gmsh optimizer name | optional quality optimization; does not replace convergence checks |
| `optimize_iterations` | passes | `1` | positive integer | number of optimizer passes |
| `compute_quality` | 1 | `True` in Control Room defaults | Boolean | requests aggregate quality metrics |
| `per_element_quality` | 1 | `True` in Control Room defaults | Boolean | requests per-element quality arrays and scoped distributions |
| `mesh_strategy` | 1 | `auto` | `swept_prism` or `swept_hex` for explicit requests | selects the swept topology family |
| `through_thickness_elements` | layers | strategy/backend dependent | positive integer; Control Room exact prism gate advertises 1–3 | number of volume-element layers across thickness |
| `through_thickness_distribution` | 1 | `fixed` / uniform exact route | `fixed`, `uniform`, `arithmetic`, `geometric` by authoring layer | controls layer-plane spacing |
| `through_thickness_element_ratio` | 1 | `1` | positive | growth ratio for nonuniform distributions |
| `through_thickness_symmetric` | 1 | `False` | Boolean | mirrors nonuniform grading about the midplane when supported |
| `sweep_face_meshing` | 1 | strategy-derived | `triangular` or `quadrilateral` | source-surface topology |
| `sweep_direction` | 1 | `auto` | `auto`, `x`, `y`, `z` | axis used to identify source/destination faces |
| `sweep_source`, `sweep_destination` | 1 | auto selectors | semantic selector strings/descriptors | explicit paired sweep faces |
| `element_family` | 1 | strategy-derived | `prism` or `hex` | requested volume-element family |
| `topology` | 1 | strategy-derived | `prismatic` or `tetrahedral` in current object policy | topology declaration checked against all swept fields |
| `transition_policy` | 1 | `reject` or route-derived | `pyramid_to_tetrahedra` or `reject` | connects prism layer to tetrahedral surroundings when qualified |
| `exact_layer_count` | 1 | `False` | Boolean; exact prism route requires true | turns layer count into a strict certificate requirement |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("swept_prism_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(800 * nm, 400 * nm, 200 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=15 * nm,
    maximum_element_size=100 * nm,
    maximum_element_growth_rate=1.6,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(600 * nm, 200 * nm, 6 * nm), name="film"),
    name="film",
)
film.mesh(
    minimum_element_size=4 * nm,
    maximum_element_size=8 * nm,
    mesh_strategy="swept_prism",
    topology="prismatic",
    through_thickness_elements=2,
    through_thickness_distribution="fixed",
    through_thickness_symmetric=False,
    sweep_face_meshing="triangular",
    sweep_direction="auto",
    element_family="prism",
    transition_policy="pyramid_to_tetrahedra",
    exact_layer_count=True,
    order=1,
    algorithm_2d=6,
    algorithm_3d=1,
    maximum_element_growth_rate=1.2,
    smoothing_steps=4,
    optimize="Netgen",
    optimize_iterations=4,
    compute_quality=True,
    per_element_quality=True,
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 1.0e-4, 0.0)

study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="llg_overdamped",
    tolA=1.0e-4,
    max_steps=20_000,
)
```

## Control Room workflow

1. In **Explorer**, select the magnetic object's **Mesh** child (the object mesh-policy route).
2. In **Inspector → Object Mesh Policy**, enable **Use object policy** when an object-specific override
   is required.
3. Configure the relevant groups: **Mesh Size Presets**, **Element Size Parameters**,
   **Thin-Film Sweep Strategy**, **Interface and Transition Refinement**, **Backend Mesh Parameters**,
   **Core Relaxation**, **Manual Size Field**, and **Edge and Corner Refinement**.
4. Select **Apply Object Policy**. This stores authoring intent and invalidates mesh resources whose
   revision no longer matches the model.
5. Select **Build Mesh**. If the draft is dirty, the panel applies it first and dispatches the canonical
   `mesh.build-selected` command.
6. Open the **Quality** and **History** tabs. Compare requested and realized values, then inspect the
   scoped size/quality distributions and the raw build report before running a solver.

The read-only effective values come from backend resources. They must not be reconstructed from the
current form fields because presets, capability gates and backend normalization can change the
resolved configuration.

### Exact Control Room settings

1. Select the object's **Mesh** node and enable its object policy.
2. In **Thin-Film Sweep Strategy**, choose **Swept prism**. The option is disabled unless the
   capability matrix advertises `mesh.topology.mixed_p1`, `mesh.swept.prism`,
   `mesh.transition.pyramid_tet` and `mesh.exact_layer_count` as executable.
3. Choose **Through-thickness elements = 1, 2, or 3**. The reviewed gate requires exactly these
   advertised values.
4. Keep **Source face meshing = triangular**, **Topology = prismatic**, **Element family = prism**,
   **Exact layer count = true**, **Order = 1**, and **Transition = pyramid to tetrahedra**.
5. Apply and build. In **Quality / History**, verify `actual_method`, layer planes, prism/pyramid/tet
   counts, positive Jacobians and `fallback=false` for a strict request.

## Acceptance checklist

A strict swept-prism mesh is accepted only when all of the following hold:

- the requested object and selected source/destination faces are recorded;
- the certificate reports exactly `N` prism layers and `N+1` node planes;
- every prism has positive orientation/Jacobian and the requested material marker;
- source/destination and side facets are complete;
- a shared-domain transition reports valid `pyramid5` cells when used;
- no unreported `tet4` replacement occurs inside the exact prism region;
- the active solver/device supports `prism6`, `pyramid5` and any surrounding `tet4` cells;
- observables converge with in-plane size and thickness-layer count.

## Verification, quality and provenance

After every build, inspect the **realized** resource rather than assuming that the authored request
was applied. The production check is:

- geometry and mesh revisions match the current model;
- requested and realized discretization/topology/order are recorded;
- node, element and boundary-facet counts are nonzero for every required region;
- region and boundary markers cover the complete topology;
- inverted and degenerate element counts are zero;
- interface diagnostics report no orphan, coincident, nonmanifold or unmatched facets;
- local size distributions are consistent with the intended edge/interface/core grading;
- any fallback or degradation has an explicit reason and an actual method;
- a mesh-refinement sequence demonstrates convergence of the scientific observable.

`MeshQualityReport` exposes signed inverse condition number (SICN), gamma/radius quality, volume
statistics and optional per-element arrays. The source constants `gamma_min=0.08` and
`SICN p05=0.1` are implementation gates for named report paths; they are not universal physical
acceptance thresholds for every element family or study.

## Mesh-convergence protocol

A production result should include at least three discretizations. Refine only the parameter under
study while holding geometry, material parameters, solver tolerances, initial state and output
sampling fixed. Let $Q_h$ denote the observable for characteristic size $h$. Report

```{math}
:label: eq-meshing-relative-change-fem-ferromagnet-swept-prism
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- A geometry classified as non-sweepable is a strict build failure.
- `exact_layer_count=true` with nonuniform distribution is rejected by the Python contract.
- Missing capability IDs or a layer-count list different from `[1,2,3]` disables authoring.
- A tetrahedral result is not a successful prism result even if the total element count is valid.
- Negative prism/pyramid Jacobians or unmatched transition faces are blocking.
- `order>1` is outside the reviewed exact mixed-P1 route.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Swept object policy validation | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `PerObjectMeshRecipe strict layered validation` |
| Prism generation | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py) | `generate_swept_mesh` |
| Canonical node ordering | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py) | `Gmsh Prism 6 to prism6 mapping` |
| Capability gate | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts) | `resolveObjectMeshTopologyCapabilities` |
| Reference script | [`examples/permalloy_film_relax_1000x500x10nm.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/examples/permalloy_film_relax_1000x500x10nm.py) | `swept prism FEM benchmark` |
| Mixed topology tests | [`packages/fullmag-py/tests/test_mixed_element_meshing.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/tests/test_mixed_element_meshing.py) | `prism/pyramid/tet tests` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [General swept meshes](../../swept-meshes.html)
- [Mixed elements](mixed-elements.html)
- [Swept hex](swept-hex.html)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
