---
title: "Free tetrahedral ferromagnet mesh"
description: "Unstructured tetrahedral volume meshing for general magnetic geometry."
summary: "Free tetrahedral meshing is the default general-purpose FEM route for curved, boolean and imported magnetic geometry. It prioritizes robust geometry conformity over explicit layer topology."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "MeshOptions, free-tetrahedral dispatch, Gmsh OCC generation, typed tet4 extraction and scoped mesh reports"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-free-tetrahedral)=
# Free tetrahedral ferromagnet mesh

**Last changes: 12:31 24.08.2026**

Free tetrahedral meshing is the default general-purpose FEM route for curved, boolean and imported magnetic geometry. It prioritizes robust geometry conformity over explicit layer topology.

::::{admonition} Implementation status
:class: important

Linear `tet4` generation is implemented for supported primitives, CSG and imported surfaces. Higher-order authoring may exist at the FEM schema level, but the canonical mixed extraction path accepts exact supported element types and must reject unsupported families.
::::

## Scope and purpose

Select this method when geometry is not naturally sweepable, when local refinement is more
important than aligned layer planes, or when a robust fallback-free tetrahedral mesh is preferred.
It is the baseline against which specialized thin-film and swept meshes should be validated.

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
:label: eq-meshing-exchange-length-fem-ferromagnet-free-tetrahedral
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

Each linear tetrahedron maps the reference simplex to physical space by an affine map. Its
Jacobian determinant is proportional to signed volume,

```{math}
:label: eq-tet-signed-volume-fem-ferromagnet-free-tetrahedral
V_K=\frac{1}{6}\det[\mathbf x_1-\mathbf x_0,\mathbf x_2-\mathbf x_0,
\mathbf x_3-\mathbf x_0].
```

Positive orientation is mandatory. Slivers can have positive volume but poor gradient accuracy
and conditioning, so inspect SICN/gamma distributions rather than volume alone. Surface
triangulation quality propagates into the volume mesh.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| General default | 2-D algorithm 6 + 3-D algorithm 1 | Current defaults: Frontal-Delaunay surface, Delaunay volume |
| Lofted ArchWaveguide where Delaunay recovery fails | planner/source fallback to HXT | Generator records the fallback reason explicitly |
| Very large/complex tetrahedralization | HXT when validated | Alternative 3-D algorithm; compare quality and reproducibility |
| Thin film requiring exact planes | use swept prism instead | Free tetrahedra do not certify layer planes |

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

Set **Mesh strategy = Free tetrahedral**. Configure size presets and local refinement before
advanced Gmsh algorithms. Build and inspect cell-family counts: an ordinary free-tetrahedral
realization should report `tet4` volume cells and `tri3` boundary facets for the linear route.

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
:label: eq-meshing-relative-change-fem-ferromagnet-free-tetrahedral
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- Boundary recovery failures should report the attempted and retry algorithm.
- Surface algorithm 8 is sanitized to 6 for source-visible 3-D thin-body volume workflows.
- Inverted/degenerate tetrahedra are build failures.
- A low-quality tail can dominate exchange conditioning even when mean quality is acceptable.
- Imported non-watertight surfaces must fail or be repaired explicitly; volume meshing a visually
  closed surface is not guaranteed.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Free-tet dispatch | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py) | `generate_mesh, generate_box_mesh` |
| Gmsh option application | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py) | `_apply_mesh_options` |
| Tet extraction and orientation | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py) | `tet4 extraction` |
| Object recipe validation | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `PerObjectMeshRecipe` |
| Fallback regression tests | [`packages/fullmag-py/tests/test_meshing_fallbacks.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/tests/test_meshing_fallbacks.py) | `explicit fallback tests` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Thin-film tetrahedral](thin-film-tetrahedral.html)
- [Refinement](../../refinement.html)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).

- H. Si, “TetGen, a Delaunay-based quality tetrahedral mesh generator,” *ACM Transactions on Mathematical Software* **41** (2015), [doi:10.1145/2629697](https://doi.org/10.1145/2629697).
