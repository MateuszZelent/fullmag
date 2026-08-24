---
title: "Mixed-element FEM meshes"
description: "Typed tet4, prism6, pyramid5 and hex8 topology, transitions and solver qualification."
summary: "A mixed mesh stores every volume and facet family explicitly. Fullmag currently uses the prism–pyramid–tetrahedron combination for qualified layered-film/shared-airbox scenarios; generic mixed support is not assumed."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "Typed MeshData topology, mixed-element extraction, exact-layer certificate, solver capability matrix and mixed tests"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-mixed-elements)=
# Mixed-element FEM meshes

**Last changes: 12:31 24.08.2026**

A mixed mesh stores every volume and facet family explicitly. Fullmag currently uses the prism–pyramid–tetrahedron combination for qualified layered-film/shared-airbox scenarios; generic mixed support is not assumed.

::::{admonition} Implementation status
:class: important

Canonical linear families are represented as `tet4`, `prism6`, `pyramid5`, `hex8`, with `tri3`/`quad4` facets. Generation and solver execution are scenario-qualified. Imported `hex8` parsing does not establish swept-hex solver support.
::::

## Scope and purpose

Use this page to understand the final solver-facing topology when a layered prism region connects
to tetrahedral surroundings or when an external mixed mesh is imported. A mixed mesh is not a
rectangular connectivity array; it requires cell type, offsets, flattened node indices and
family-aware local facets/quadrature.

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
:label: eq-meshing-exchange-length-fem-ferromagnet-mixed-elements
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

The canonical topology is stored as

```text
cell_types[c]
cell_offsets[c:c+2]
cell_nodes[cell_offsets[c]:cell_offsets[c+1]]
```

so arity is family-dependent. Local facets are family-specific: a `prism6` has two triangular and
three quadrilateral faces; a `pyramid5` has one quadrilateral and four triangular faces; a `tet4`
has four triangular faces; a `hex8` has six quadrilateral faces. Interface adjacency must be
constructed from complete sorted facet node sets, not from a tetra-only assumption.

Fullmag keeps explicit Gmsh-to-canonical node permutations even where the current mapping is
identity. This prevents a future family/order from accidentally inheriting prefix or ordering
assumptions.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Layered prism magnet + tetrahedral air | `prism6 + pyramid5 + tet4` | Current target mixed transition when capabilities permit |
| Pure tetrahedral shared domain | `tet4` | Most broadly supported baseline |
| Imported valid mixed linear mesh | typed ingress | Preserves exact families after validation |
| Higher-order/missing family support | reject | No prefix truncation or silent family replacement |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
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
| `cell_types` | 1 | realized | one canonical type per volume cell | selects shape, arity, facets, quadrature and assembly |
| `cell_offsets` | indices | realized | monotone length `n_cells+1` | indexes flattened connectivity |
| `cell_nodes` | node indices | realized | valid node IDs and exact arity by family | canonical local-node connectivity |
| `facet_types` | 1 | realized | `tri3` or `quad4` | typed boundary/interface facets |
| `facet_roles` | 1 | realized | supported semantic roles | outer/interface/periodic/provisional ownership |
| family capability | 1 | backend-reported | all realized types executable | gates assembly and every active interaction |

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

Request mixed topology through **Swept prism**, not through an untyped generic checkbox. After
build, inspect family counts by object/air/interface and the exact-layer/transition certificate.
The active-lane capability panel must list every realized family. If any family is unsupported,
execution remains disabled even when the mesh quality report is otherwise valid.

## Mixed-topology verification

Verify exact family counts, local-node orientation, positive Jacobians at family-appropriate
points, complete facet adjacency, region markers, transition conformity and operator support.
Validate mixed assembly against a tetrahedral decomposition/reference on a manufactured field or
a converged micromagnetic observable. Record the quality metric name because tet and prism/hex
quality numbers are not automatically interchangeable.

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
:label: eq-meshing-relative-change-fem-ferromagnet-mixed-elements
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- Any code path assuming four nodes per cell is invalid for mixed topology.
- Unsupported exact element type raises an ingress/build error.
- A quadrilateral interface facet cannot be matched to one triangle without an explicit
  transition/subdivision certificate.
- `hex8` ingress support is not a generation or solver qualification claim.
- Missing per-family quadrature/device kernel must block the active interaction.
- A mixed request realized as all tetrahedra is a fallback or failure, never exact success.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Canonical mixed types | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py) | `SUPPORTED_VOLUME_ELEMENTS, SUPPORTED_BOUNDARY_ELEMENTS` |
| Exact extraction/permutations | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py) | `_GMSH_TO_FULLMAG_NODE_PERMUTATION, _CELL_LOCAL_FACETS` |
| Mixed generator | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py) | `prism/transition generation` |
| Mixed certificate | [`packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py) | `family/layer/conformity report` |
| Capability gate | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts) | `mixed-P1 capability resolution` |
| Regression tests | [`packages/fullmag-py/tests/test_mixed_element_meshing.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/tests/test_mixed_element_meshing.py) | `mixed topology tests` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Swept prism](swept-prism.html)
- [Imported mesh](imported-mesh.html)
- [Shared-domain conformity](../shared-domain/assembly-and-conformity.html)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
