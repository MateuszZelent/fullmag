---
title: "Imported geometry and FEM mesh assets"
description: "Units, scaling, remeshing, typed topology, markers and validation for imported FEM assets."
summary: "Imported assets are accepted only with explicit units/scale and supported exact linear element families. Surface geometry is normally remeshed; volume meshes preserve typed topology and semantic markers when valid."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "ImportedGeometry contract, meshio/Gmsh readers, typed topology extraction, asset pipeline and import diagnostics"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-imported-mesh)=
# Imported geometry and FEM mesh assets

**Last changes: 12:31 24.08.2026**

Imported assets are accepted only with explicit units/scale and supported exact linear element families. Surface geometry is normally remeshed; volume meshes preserve typed topology and semantic markers when valid.

::::{admonition} Implementation status
:class: important

Imported surface and mesh paths are implemented with explicit validation. Supported canonical linear volume families are `tet4`, `prism6`, `pyramid5` and `hex8`; facets are `tri3` and `quad4`. Unsupported/higher-order element types are rejected rather than truncated by node prefix.
::::

## Scope and purpose

Use imported assets for CAD/STL-derived particles, externally generated meshes and measured
morphologies. Decide whether the file is a **surface geometry to remesh** or a **volume mesh to
ingest**. These are different workflows with different marker and quality obligations.

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
:label: eq-meshing-exchange-length-fem-ferromagnet-imported-mesh
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

Source coordinates $\mathbf x_s$ are mapped into SI metres by a unit factor and optional scalar
or per-axis scale,

```{math}
:label: eq-imported-coordinate-scale-fem-ferromagnet-imported-mesh
\mathbf x_{SI}=\mathbf s\odot(u\,\mathbf x_s).
```

Nonuniform per-axis scaling changes shape and element Jacobians; it is not merely a units
conversion. For a surface-to-volume route, the surface must be watertight, consistently oriented
and free of self-intersections at the mesher tolerance. For a volume mesh, every cell type is
matched exactly to the supported canonical family and local-node permutation.

Physical names `air`, `airbox`, `air_box` and `__air__` are normalized to the canonical air marker
in the current meshio path. Other physical/cell-set markers remain semantic material candidates.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| STL/triangle surface | remesh with free tetrahedral | Builds a valid volume and controlled size field |
| Gmsh/meshio volume with supported linear cells | typed import | Preserves mixed topology and physical markers after validation |
| Higher-order cells | reject or explicitly convert upstream | Current canonical ingress does not silently reduce order |
| Unknown units | stop and define `units`/`scale` | A 1e9 length error invalidates geometry and physics |

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
| `ImportedGeometry.source` | path | required | non-empty accessible source | input CAD/surface/mesh asset |
| `ImportedGeometry.units` | 1 | unset | supported unit name | source-to-SI conversion |
| `ImportedGeometry.scale` | 1 | `1` | positive scalar or positive 3-vector | additional isotropic/anisotropic scale |
| `ImportedGeometry.volume` | 1 | `full` | supported volume selector | selects imported volume semantics |
| `provisional_interface_markers` | marker IDs | unset | declared set | allows only declared unattached provisional facets to be removed during frozen-interface processing |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("imported_fem_mesh_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(600 * nm, 600 * nm, 600 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=10 * nm,
    maximum_element_size=100 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

# The source path is resolved at build time. `units` and `scale` are explicit.
particle = study.geometry(
    fm.ImportedGeometry("particle.stl", units="nm", scale=1.0, name="particle_source"),
    name="particle",
)
particle.mesh(
    mesh_strategy="free_tetrahedral",
    calibrate_for="imported_surface_cleanup",
    size_preset="fine",
    minimum_element_size=2 * nm,
    maximum_element_size=6 * nm,
    algorithm_2d=6,
    algorithm_3d=10,
    order=1,
    optimize="Netgen",
    optimize_iterations=3,
    compute_quality=True,
    per_element_quality=True,
)
particle.Ms = 800.0e3
particle.Aex = 13.0e-12
particle.alpha = 0.05
particle.m = fm.texture.uniform(1.0, 0.0, 0.0)

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

Import the asset through the geometry workflow with explicit source units and scale. Select the
resulting object's **Mesh** node, choose **Imported source**/free-tetrahedral remeshing as
appropriate, then build. In the details panel inspect source hash/stat metadata, normalized bounds,
typed cell/facet families, region-marker map, rejected element types and quality.

## Import verification

Before solving, compare imported SI bounds and volume with an independent expectation; inspect
watertightness/orientation diagnostics; verify marker names and counts; check canonical local-node
order and positive Jacobians; and record a source fingerprint. For remeshed surfaces, refine both
surface and volume targets. For ingested meshes, compare the imported and canonical cell counts
exactly.

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
:label: eq-meshing-relative-change-fem-ferromagnet-imported-mesh
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- Unknown unit or nonpositive scale fails immediately.
- Missing/invalid source path is a build failure.
- Unsupported Gmsh/meshio element types raise a typed rejection with family, dimension, order,
  arity and context.
- Self-intersecting, nonmanifold or open surfaces can fail boundary recovery.
- Physical-group loss is a semantic failure even if nodes/cells load successfully.
- A new file at the same path must invalidate caches through size/mtime/content provenance.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Imported geometry contract | [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/geometry.py) | `ImportedGeometry` |
| Imported-file mesh dispatch | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py) | `generate_mesh_from_file` |
| Typed meshio/Gmsh extraction | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py) | `_read_mesh_file, UnsupportedGmshElementError` |
| Asset materialization/cache | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py) | `imported mesh asset pipeline` |
| Remesh CLI | [`packages/fullmag-py/src/fullmag/meshing/remesh_cli.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/remesh_cli.py) | `import/remesh command` |
| Imported-mesh tests | [`packages/fullmag-py/tests/test_mixed_element_meshing.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/tests/test_mixed_element_meshing.py) | `typed mixed import tests` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Free tetrahedral](free-tetrahedral.html)
- [Mixed elements](mixed-elements.html)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
