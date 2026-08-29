---
title: "FEM shared-domain meshing"
description: "Conforming assembly of magnetic bodies, interfaces and the exterior air domain."
summary: "A shared-domain mesh is one immutable topology containing all magnetic and air regions required by coupled FEM operators, with conforming interfaces and semantic markers."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "Shared-domain assembly policy, Gmsh OCC fragmentation, typed topology extraction, manifest certificates and solver capability checks"
---

(public-docs-numerical-methods-meshing-fem-shared-domain)=
# FEM shared-domain meshing

**Last changes: 12:31 24.08.2026**

A shared-domain mesh is one immutable topology containing all magnetic and air regions required by coupled FEM operators, with conforming interfaces and semantic markers.

::::{admonition} Implementation status
:class: important

Conforming tetrahedral shared-domain builds are implemented. Mixed prism–pyramid–tetrahedron assembly is supported only in advertised scenarios; generic silent fallback is forbidden in strict mode.
::::

## Scope and purpose

Use a shared-domain build whenever an operator spans more than one geometry or requires an
exterior region. Fullmag assembles geometry, object policies, airbox policy and semantic
selections before generating one mesh. Per-object preview meshes are not substitutes for the
final shared domain because boolean fragmentation can change nodes, facets and markers.

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
:label: eq-meshing-exchange-length-fem-shared-domain
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

Let the computational domain be partitioned as

```{math}
:label: eq-shared-domain-partition-fem-shared-domain
\overline\Omega=\bigcup_{r=0}^{R}\overline\Omega_r,
\qquad \Omega_r\cap\Omega_s=\varnothing\;(r\ne s),
```

with region $r=0$ reserved for air in the canonical realization and positive semantic markers
assigned to magnetic/material regions. For a conforming interface $\Gamma_{rs}$, both adjacent
cells reference the same facet node set. This permits direct assembly of continuous FEM spaces
and unambiguous surface roles.

`SharedMeshAssemblyPolicy` controls interface size relative to object size, conformity and a
coarse airbox factor. These are assembly hints; the manifest must still certify the actual
topology. Boolean OCC fragmentation is performed before meshing so coincident boundaries become
shared entities rather than overlapping duplicate surfaces.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Open-boundary demag with one/many magnets | conforming shared domain | one scalar-potential domain and explicit material interfaces |
| Object-only exchange without exterior solve | object mesh may suffice | shared air region is unnecessary if no coupled operator needs it |
| Mixed prism magnetic film plus tetrahedral air | strict mixed build only when capability advertised | requires pyramidal transition and a mixed-family certificate |
| Imported nonconforming component meshes | reject or remesh into shared domain | ordinary continuous FEM assembly cannot assume duplicated interfaces are conforming |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `interface_hmax_factor` | 1 | `0.5` | strictly in `(0,1]` | interface target relative to object maximum size |
| `enforce_conforming` | 1 | `True` | Boolean | requires a shared-node interface for ordinary shared-domain operators |
| `airbox_hmax_factor` | 1 | `3.0` | positive | coarse exterior target relative to magnetic size |
| object mesh policies | mixed | inherited/object-specific | valid per object | supply local size, topology and selector intent |
| universe/airbox policy | mixed | required for exterior solves | valid enclosure and outer marker | supplies exterior geometry and grading |
| `build_mode` | 1 | planner-resolved | advertised build-mode vocabulary | chooses OCC shared assembly, strict mixed route or documented fallback |

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

### Magnetic-object workflow

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


### Universe / airbox workflow

1. In **Explorer**, select **Universe / Airbox Mesh**.
2. Choose **Domain mode** and enter either explicit **Size X/Y/Z** and **Center X/Y/Z**, or automatic
   **Padding X/Y/Z**.
3. For FEM, set **Maximum element size**, **Minimum element size**, **Maximum element growth rate**,
   **Element grading**, **Curvature factor** and **Narrow-region resolution** as needed.
4. Select **Apply Airbox Policy** to store the universe-owned exterior-domain intent. This makes any
   older shared-domain realization stale.
5. Select **Apply & Build Shared-Domain Mesh** to dispatch `mesh.build-shared-domain`.
6. Inspect the effective configuration, shared-domain manifest, outer-boundary marker, interface
   conformity and mesh-quality scopes. The effective configuration returned by the backend is the
   source of truth.

For FDM, the panel filters FEM-only air-mesh controls and exposes structured-domain geometry only.

After applying object and universe policies, use **Apply & Build Shared-Domain Mesh**. Inspect the
manifest scopes for every object, airbox and interface. An object-level **Build Mesh** is useful
for local debugging but does not certify the final coupled mesh.

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
:label: eq-meshing-relative-change-fem-shared-domain
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- Overlapping magnetic volumes without an explicit material/region rule are invalid.
- Coincident but duplicate interface facets are not conforming; inspect adjacency and orphan
  diagnostics rather than surface coordinates alone.
- Region-marker count must match semantic objects after boolean fragmentation.
- A strict mixed request must fail if it realizes only tetrahedra or loses exact layer planes.
- Fallback is acceptable only when the build mode permits it and the report records request,
  reason, actual method and realized families.
- A solver must reject cell families it does not support even if the mesher produced valid cells.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Shared assembly schema | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `SharedMeshAssemblyPolicy` |
| OCC geometry assembly | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py) | `shared OCC construction` |
| Shared mesh generation | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py) | `shared-domain generators` |
| Typed topology extraction | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py) | `_extract_gmsh_connectivity` |
| Build report/certificate | [`packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py) | `shared-domain build report` |
| Control Room mesh resources | [`apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/kernel/resources/geometryLifecycleResources.ts) | `shared-domain resource hooks` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Shared-domain branch](fem/shared-domain/index.md)
- [Airbox](airbox.md)
- [Mixed elements](fem/ferromagnet/mixed-elements.md)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Runtime realization is owned by the relevant `backends/fdm` or `backends/fem` implementation; the page must not claim a symbol not named in its implementation mapping.

