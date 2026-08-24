---
title: "Shared-domain assembly and conformity"
description: "Boolean fragmentation, region partition, shared interfaces and conformity checks."
summary: "A conforming shared mesh represents each physical interface once, with common facet nodes referenced by adjacent regions. This is the default contract for coupled FEM operators in Fullmag."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "OCC shared assembly, typed facet adjacency, region/facet roles and shared-domain certificate"
---

(public-docs-numerical-methods-meshing-fem-shared-domain-assembly-and-conformity)=
# Shared-domain assembly and conformity

**Last changes: 12:31 24.08.2026**

A conforming shared mesh represents each physical interface once, with common facet nodes referenced by adjacent regions. This is the default contract for coupled FEM operators in Fullmag.

::::{admonition} Implementation status
:class: important

Conforming tetrahedral shared-domain assembly is source-backed. Nonconforming mortar/contact coupling is not implied by ordinary mesh import or coincident surfaces.
::::

## Scope and purpose

Use this page when two materials touch, a magnet is embedded in an airbox, or several geometry
objects participate in one FEM solve. The objective is a partition—not overlapping meshes and not
two independently meshed surfaces that merely occupy the same coordinates.

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
:label: eq-meshing-exchange-length-fem-shared-domain-assembly-and-conformity
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

For an internal facet $F=\partial K_r\cap\partial K_s$, conforming topology means both cells
reference the same global node IDs for $F$. The adjacency degree is two for an ordinary manifold
internal facet and one for an exterior facet. A discrete continuous field then has one nodal value
on the interface, while material coefficients can remain region-dependent.

The assembly pipeline performs geometry boolean fragmentation before meshing, assigns physical
groups, extracts typed cells/facets, reconstructs adjacency and derives roles such as outer,
interface, periodic and provisional. Orphan/nonmanifold facets are reported explicitly.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Magnet embedded in airbox | conforming fragment-and-mesh | Required by ordinary scalar-potential assembly |
| Two magnets separated by air | one shared exterior domain | Cross demag field is represented continuously |
| Two touching material regions | shared interface + distinct region markers | Coefficients can jump while topology remains conforming |
| Independent imported meshes | remesh/merge with certificate | Coincident coordinates alone are not conformity |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `enforce_conforming` | 1 | `True` | Boolean | requires shared-node interfaces |
| `interface_hmax_factor` | 1 | `0.5` | `0 < value <= 1` | refines shared interfaces relative to object hmax |
| `airbox_hmax_factor` | 1 | `3.0` | positive | coarse exterior target relative to object size |
| region marker | 1 | generated | unique semantic mapping | selects material/physics coefficients |
| boundary marker/role | 1 | generated | complete and unambiguous | selects outer/interface/periodic conditions |
| geometry tolerance | m | backend derived | scale-aware | controls boolean and coincidence classification |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("shared_domain_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(700 * nm, 500 * nm, 260 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=12 * nm,
    maximum_element_size=90 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

left = study.geometry(
    fm.Box(size=(180 * nm, 80 * nm, 10 * nm), name="left_geom").translate(
        (-120 * nm, 0.0, 0.0)
    ),
    name="left",
)
right = study.geometry(
    fm.Box(size=(180 * nm, 80 * nm, 10 * nm), name="right_geom").translate(
        (120 * nm, 0.0, 0.0)
    ),
    name="right",
)
for body, direction in ((left, (1.0, 0.0, 0.0)), (right, (0.0, 1.0, 0.0))):
    body.mesh(
        mesh_strategy="free_tetrahedral",
        minimum_element_size=4 * nm,
        maximum_element_size=8 * nm,
        interface_maximum_element_size=6 * nm,
        interface_thickness=15 * nm,
        transition_distance="airbox_boundary",
        transition_growth=1.4,
        order=1,
        compute_quality=True,
    )
    body.Ms = 800.0e3
    body.Aex = 13.0e-12
    body.alpha = 0.02
    body.m = fm.texture.uniform(*direction)

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

1. Apply every object mesh policy and the Universe airbox policy.
2. Use **Apply & Build Shared-Domain Mesh** rather than relying on object previews.
3. In **Mesh Details**, inspect region inventory, interface inventory and facet-role counts.
4. Check conformity/orphan/nonmanifold diagnostics and the scoped quality report for each side of
   every interface.
5. Confirm that material and physics selections resolve to the intended region markers before run.

## Conformity certificate

Require a complete cell-to-facet adjacency, exactly one geometric interface role per intended
pair, zero unmatched/coincident duplicates, positive cell Jacobians and complete region ownership.
For an interface field, compare traces/normals from both sides. For demag, check continuity of the
scalar-potential representation and the expected normal-flux jump from magnetization.

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

## Diagnostics and failure semantics

- Adjacency degree 0 indicates an orphan facet; >2 indicates a nonmanifold facet unless explicitly
  modeled.
- Two facets with different nodes but coincident coordinates are duplicate/nonconforming.
- Boolean fragmentation can split one authored surface into several entities; semantic recovery
  must retain ownership.
- Overlapping volume cells or ambiguous region markers are blocking.
- A valid object mesh can become invalid after shared boolean assembly; inspect the final mesh.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| OCC shared assembly | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py) | `geometry fragmentation and physical groups` |
| Shared generator | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py) | `shared-domain generation` |
| Facet adjacency/roles | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py) | `_derive_facet_roles` |
| Orphan diagnostics | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py) | `collect_orphan_entity_diagnostics` |
| Conformity report | [`packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py) | `conformity certificate` |
| Mesh summary API | [`crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs) | `shared-domain summary/manifest` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Build modes and fallbacks](build-modes-and-fallbacks.html)
- [Selectors and attributes](selectors-and-attributes.html)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
