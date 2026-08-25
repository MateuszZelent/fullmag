---
title: "Meshing and spatial discretization"
description: "Production reference for choosing, authoring, building and validating FDM and FEM meshes in Fullmag."
summary: "This chapter defines the complete Fullmag meshing contract: physical resolution, authored intent, realized topology, Control Room workflows, Python API, quality evidence and implementation ownership."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "FDM/FEM discretization schemas, meshing builders, Control Room mesh resources, realization reports and solver capability matrices"
---

(public-docs-numerical-methods-meshing-index)=
# Meshing and spatial discretization

**Last changes: 12:31 24.08.2026**

This chapter defines the complete Fullmag meshing contract: physical resolution, authored intent, realized topology, Control Room workflows, Python API, quality evidence and implementation ownership.

::::{admonition} Implementation status
:class: important

FDM Cartesian grids and FEM tetrahedral/shared-domain workflows are implemented. Swept and mixed-element support is scenario-qualified and capability-gated. The realized mesh report—not the selected UI label—is the final statement of what the solver received.
::::

## Scope and purpose

Use this chapter before selecting an individual mesh generator. Fullmag separates four objects
that are often conflated in simulation software:

- **geometry**: the continuous magnetic bodies and optional exterior universe;
- **mesh intent**: requested cell sizes, topology, selectors, size fields and build mode;
- **mesh realization**: immutable nodes, cells, facets, markers, quality and provenance;
- **solver support**: the element/cell families and boundary semantics accepted by the selected
  backend, device and physical interaction set.

A setting is production-safe only when all four agree. Authoring a prism request does not prove
that prisms were generated; generating a valid CPU mesh does not prove that every GPU operator
supports its cell families.

## Scientific and numerical model

### FDM scientific invariants

An FDM grid stores the magnetization on a Cartesian lattice with cell dimensions
$\Delta x$, $\Delta y$ and $\Delta z$. Cell centers are

```{math}
:label: eq-meshing-fdm-cell-centres-index
\mathbf r_{ijk}=\mathbf r_0+
\left(i+\tfrac12,j+\tfrac12,k+\tfrac12\right)
\odot(\Delta x,\Delta y,\Delta z).
```

The cell size simultaneously controls geometry voxelization, finite-difference exchange and the
accuracy/cost of FFT demagnetization. It must therefore resolve the smallest magnetic length scale,
the smallest geometric feature and the desired boundary accuracy. The exchange-length expression

```{math}
:label: eq-meshing-fdm-exchange-length-index
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}
```

is a useful initial guide, but final values require a grid-refinement study. A one-cell film thickness
is a thickness-averaged discretization; it cannot represent a nonuniform mode across the thickness.


### FEM scientific invariants

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
:label: eq-meshing-exchange-length-index
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

## Cost models

For an FDM grid with $N_xN_yN_z=N$ active lattice sites, local interactions scale approximately
as $O(N)$ and FFT demagnetization as $O(N\log N)$, with padding and periodic-image choices
contributing to memory. For FEM, assembly is approximately linear in the number of cells, while
magnetostatic and linear-solver cost depend strongly on the airbox, polynomial order, conditioning
and preconditioner.

The cheapest valid mesh is therefore not necessarily the one with the fewest entities. A
geometry-conforming FEM mesh may reduce geometric error; a regular FDM grid may enable a much
faster demagnetization operator. The choice must be tied to the observable and backend.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Rectangular film, regular geometry, large dynamics run | `FDM` | Cartesian cells, efficient local stencils and FFT demagnetization |
| Curved surface, imported CAD/STL, irregular boundary | `FEM free tetrahedral` | Geometry-conforming boundary and local refinement |
| Thin extrudable film with certified layer planes | `FEM swept prism` | Explicit through-thickness layers and prism topology when capability-gated |
| Thin film where prism route is unavailable | `FEM thin-film tetrahedral` | Tetrahedra with thickness-aware sizing; verify actual layer sampling |
| Open-boundary FEM demagnetization | `FEM shared domain + airbox` | Conforming magnetic/air domain with an explicit outer-boundary closure |
| Several FDM magnets on different grids | `FDM multilayer_convolution` | Current multi-body production route; shared single-grid authoring is rejected |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `engine` | 1 | `auto` | `fdm`, `fem`, `hybrid`, or backend-resolved | selects the discretization lane and available mesh controls |
| `requested_mode` | 1 | `strict` | execution-mode vocabulary | strict mode rejects unsupported/degraded topology instead of silently replacing it |
| `requested_device` | 1 | `auto` | backend/device capability | device support must cover every realized cell family and interaction |
| `requested_precision` | 1 | `double` | backend-supported precision | affects solver arithmetic, not geometric topology |
| mesh revision | 1 | generated | must match current scene/model revision | prevents a stale mesh from being solved after geometry/policy edits |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9


def build_fdm_study():
    study = fm.study("mesh_choice_fdm")
    study.engine("fdm")
    study.device("cpu", precision="double")
    study.mode("strict")
    study.universe(
        mode="manual",
        size=(160 * nm, 320 * nm, 10 * nm),
        center=(0.0, 0.0, 0.0),
        padding=(0.0, 0.0, 0.0),
    )
    study.cell(5 * nm, 5 * nm, 5 * nm)
    film = study.geometry(
        fm.Box(size=(100 * nm, 300 * nm, 10 * nm), name="fdm_film"),
        name="fdm_film",
    )
    film.Ms = 800.0e3
    film.Aex = 13.0e-12
    film.m = fm.texture.uniform(1.0, 0.0, 0.0)
    study.exchange()
    study.demag()
    study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=10_000, tolA=1.0e-4)
    return study


def build_fem_study():
    study = fm.study("mesh_choice_fem")
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
        minimum_element_size=15 * nm,
        maximum_element_size=80 * nm,
        maximum_element_growth_rate=1.5,
        grading="geometric",
    )
    magnet = study.geometry(
        fm.Ellipsoid(110 * nm, 50 * nm, 20 * nm, name="fem_body"),
        name="fem_body",
    )
    magnet.mesh(
        mesh_strategy="free_tetrahedral",
        minimum_element_size=4 * nm,
        maximum_element_size=8 * nm,
        order=1,
        compute_quality=True,
    )
    magnet.Ms = 800.0e3
    magnet.Aex = 13.0e-12
    magnet.m = fm.texture.uniform(1.0, 0.0, 0.0)
    study.exchange()
    study.demag(realization="poisson_robin")
    study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=10_000, tolT=1.0e-6)
    return study
```

## Control Room workflow

1. Select **Study** and set the requested backend, device, precision and execution mode.
2. For FDM, author the structured grid in the Study Inspector. For FEM, select each object's
   **Mesh** node and author an object-owned policy; select **Universe / Airbox Mesh** for the
   exterior-domain policy.
3. Apply policies before building. A policy edit makes older mesh resources stale by design.
4. Build the selected object mesh or the full shared-domain mesh through the canonical command.
5. Inspect **requested vs. effective vs. realized** values, quality scopes, markers and fallback
   evidence. Do not start the solver while the mesh resource is stale, degraded without approval,
   or incompatible with the active lane.
6. Repeat the simulation on a controlled refinement sequence and report convergence of the
   scientific observable.

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
:label: eq-meshing-relative-change-index
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

Treat the following as blocking unless a study-specific acceptance rule says otherwise:

- missing or stale mesh revision;
- unsupported cell family for the selected operator/device;
- requested/realized topology mismatch without an explicit fallback record;
- negative Jacobian, zero-volume cell or incomplete marker coverage;
- nonconforming magnetic/air interface in a conforming shared-domain solve;
- an FDM cell size that does not resolve the smallest active geometry or magnetic length scale;
- an airbox-convergence result that changes materially when the outer boundary is moved.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Python discretization schemas | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `FDM, FEM, PerObjectMeshRecipe, SweptMeshControls` |
| Gmsh generation and extraction | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py) | `generate_mesh` |
| Mesh data and quality contracts | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py) | `MeshData, MeshQualityReport, MeshOptions` |
| Control Room object mesh authoring | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx) | `ObjectMeshPolicyPanel` |
| Control Room study/FDM authoring | [`apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx) | `StudyInspectorPanel` |
| Rust mesh API schemas | [`crates/fullmag-api/src/schemas/mesh.rs`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/crates/fullmag-api/src/schemas/mesh.rs) | `mesh resource and request schemas` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [FDM grids](fdm-grids.md)
- [FEM shared domain](fem-shared-domain.md)
- [Refinement and convergence](refinement.md)
- [Swept meshes](swept-meshes.md)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).

## Documentation tree

```{toctree}
:maxdepth: 2

fdm/index
fdm-grids
fem/index
airbox
fem-shared-domain
refinement
swept-meshes
```
