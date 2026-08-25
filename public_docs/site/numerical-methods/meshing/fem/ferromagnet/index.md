---
title: "FEM ferromagnet meshes"
description: "Selection guide and common contract for magnetic-object FEM meshes."
summary: "The magnetic mesh resolves the vector magnetization and local interactions inside each ferromagnetic region. Topology, order, size fields and region markers must match the active physics and solver lane."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "PerObjectMeshRecipe, Gmsh object generators, object policy resources and realized scoped quality reports"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-index)=
# FEM ferromagnet meshes

**Last changes: 12:31 24.08.2026**

The magnetic mesh resolves the vector magnetization and local interactions inside each ferromagnetic region. Topology, order, size fields and region markers must match the active physics and solver lane.

::::{admonition} Implementation status
:class: important

Free tetrahedral and thickness-aware tetrahedral authoring are available. Exact prism authoring is capability-gated; swept hex is not currently production executable in Control Room.
::::

## Scope and purpose

Choose a magnetic topology based on geometry, expected magnetization variation and backend
support. Every page in this branch uses the same workflow: author object intent, apply it, build,
inspect the realized mesh and perform an observable-based convergence study.

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
:label: eq-meshing-exchange-length-fem-ferromagnet-index
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

For first-order nodal FEM, the magnetization approximation on cell $K$ is

```{math}
:label: eq-fem-magnetization-interpolation-fem-ferromagnet-index
\mathbf m_h|_K(\mathbf r)=\sum_{a\in K}N_a(\mathbf r)\,\mathbf m_a.
```

Exchange accuracy depends on gradients of these shape functions and therefore on cell size,
aspect ratio, orientation and polynomial order. Magnetostatic accuracy additionally depends on
the representation of magnetic boundaries and the shared exterior domain.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| General curved/CSG body | Free tetrahedral | Most robust topology |
| Thin body without exact prism requirement | Thin-film tetrahedral | Thickness-aware tetrahedral sizing |
| Sweepable thin film with exact layers | Swept prism | Certified P1 prism layers when enabled |
| Hexahedral volume request | Swept hex—currently unsupported | Do not select until capability is qualified |
| External CAD/STL/mesh | Imported mesh | Explicit source units, scale, markers and supported families |
| Prism/pyramid/tet solver mesh | Mixed elements | Scenario-qualified strict shared-domain path |

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
study = fm.study("free_tetrahedral_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(500 * nm, 300 * nm, 160 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=20 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

magnet = study.geometry(
    fm.Ellipsoid(110 * nm, 50 * nm, 20 * nm, name="ellipsoid"),
    name="ellipsoid",
)
magnet.mesh(
    mesh_strategy="free_tetrahedral",
    minimum_element_size=4 * nm,
    maximum_element_size=8 * nm,
    maximum_element_growth_rate=1.35,
    algorithm_2d=6,
    algorithm_3d=1,
    order=1,
    smoothing_steps=3,
    optimize="Netgen",
    optimize_iterations=3,
    compute_quality=True,
    per_element_quality=True,
)
magnet.Ms = 800.0e3
magnet.Aex = 13.0e-12
magnet.alpha = 0.02
magnet.m = fm.texture.uniform(1.0, 0.0, 0.0)

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
:label: eq-meshing-relative-change-fem-ferromagnet-index
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

A magnetic mesh can be valid geometrically yet unsupported by the selected interaction. Inspect the active-lane capability matrix for polynomial order and every realized cell family before execution.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Object mesh recipe | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `PerObjectMeshRecipe` |
| Gmsh generators | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py) | `generate_mesh` |
| Swept generator | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py) | `generate_swept_mesh` |
| Object policy model | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts) | `ObjectMeshPolicyDraft` |
| Scoped quality panels | [`apps/control-room/src/modules/inspector/panels/ScopedMeshQualityPanels.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ScopedMeshQualityPanels.tsx) | `scoped mesh quality` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).## Documentation tree

    ```{toctree}
    :maxdepth: 2

    free-tetrahedral
thin-film-tetrahedral
swept-prism
swept-hex
boundary-layers
imported-mesh
mixed-elements
    ```
