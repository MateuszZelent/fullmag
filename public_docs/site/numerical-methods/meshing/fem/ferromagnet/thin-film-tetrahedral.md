---
title: "Thin-film tetrahedral ferromagnet mesh"
description: "Thickness-aware tetrahedral meshing for thin magnetic films and waveguides."
summary: "Thin-film tetrahedral meshing keeps tetrahedral solver topology while applying thickness-aware sizing and source/destination logic. It does not by itself certify exact prism layers."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "Thin-film mesh strategy, swept eligibility/classification, tetrahedral realization report and object policy resource"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-thin-film-tetrahedral)=
# Thin-film tetrahedral ferromagnet mesh

**Last changes: 12:31 24.08.2026**

Thin-film tetrahedral meshing keeps tetrahedral solver topology while applying thickness-aware sizing and source/destination logic. It does not by itself certify exact prism layers.

::::{admonition} Implementation status
:class: important

The strategy is authorable and can produce thickness-aware tetrahedral realizations, including specialized layered-surface paths. Exact layer planes and prism topology must be read from the realized certificate, not inferred from `through_thickness_elements`.
::::

## Scope and purpose

Use this route for geometrically thin magnetic bodies when tetrahedral topology is desired or the
exact mixed-prism route is unavailable. It is especially useful for thin films, strips and
waveguides whose thickness requires explicit resolution but whose in-plane geometry is irregular.

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
:label: eq-meshing-exchange-length-fem-ferromagnet-thin-film-tetrahedral
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

Define aspect ratio $\eta=t/L_{\parallel}$, with thickness $t$ and a representative in-plane
length $L_{\parallel}$. Thin-film meshing should prevent a single poorly shaped tetrahedron from
spanning a thickness while having a much larger in-plane edge. A requested count $N_t$ gives the
nominal thickness scale

```{math}
:label: eq-thin-tet-thickness-target-fem-ferromagnet-thin-film-tetrahedral
h_t\approx\frac{t}{N_t}.
```

The actual tetrahedral plane structure depends on geometry and generator. `through_thickness_elements`
is therefore a sizing/strategy input unless the realized report explicitly certifies exact planes.
Tetrahedra can represent thickness gradients but may introduce diagonal orientation bias; compare
at least two meshes and, when relevant, rotate/reseed the surface triangulation.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Thin irregular body | `thin_film_tetrahedral` | Thickness-aware tetrahedra without mixed-family requirement |
| Exact uniform layer planes needed | `swept_prism` | Provides a strict layer certificate when qualified |
| One thickness-averaged degree of freedom | one nominal thickness layer only with justification | Cannot resolve perpendicular standing modes |
| Dynamic/thickness-asymmetric study | two or more thickness samples plus convergence | Resolves nonuniform thickness variation |

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
| `mesh_strategy` | 1 | `auto` | `thin_film_tetrahedral` | selects thickness-aware tetrahedral planning |
| `through_thickness_elements` | layers | unset/strategy default | positive integer | nominal thickness resolution; not automatically an exact plane certificate |
| `through_thickness_distribution` | 1 | `fixed` | supported distribution vocabulary | requests uniform or graded thickness sizing |
| `through_thickness_element_ratio` | 1 | `1` | positive | ratio for graded thickness sizing |
| `through_thickness_symmetric` | 1 | `False` | Boolean | symmetrizes supported nonuniform grading |
| `sweep_direction` | 1 | `auto` | `auto`, `x`, `y`, `z` | identifies the thin direction/source-destination relation |
| `topology` | 1 | `tetrahedral` | must remain tetrahedral for this page | declares realized family expectation |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("thin_film_tetrahedral_reference")
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
    fm.Box(size=(600 * nm, 200 * nm, 10 * nm), name="film"),
    name="film",
)
film.mesh(
    mesh_strategy="thin_film_tetrahedral",
    minimum_element_size=3 * nm,
    maximum_element_size=8 * nm,
    through_thickness_elements=2,
    through_thickness_distribution="fixed",
    sweep_direction="auto",
    topology="tetrahedral",
    order=1,
    algorithm_2d=6,
    algorithm_3d=1,
    compute_quality=True,
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

Select **Thin-film tetrahedral** in **Thin-Film Sweep Strategy**, choose the nominal
through-thickness element count and verify the resolved thin direction. After build, inspect
actual tetrahedron counts and thickness-coordinate distribution. Do not label the result as an
exact layered mesh unless the report contains an exact plane certificate.

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
:label: eq-meshing-relative-change-fem-ferromagnet-thin-film-tetrahedral
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- Automatic thin-direction detection can be ambiguous for rotated or nearly isotropic bodies;
  set `sweep_direction` or semantic faces explicitly.
- A requested count that is incompatible with `hmin`, geometry tolerance or surface mesh can be
  normalized or fail; inspect effective and realized values.
- Thickness-spanning slivers can dominate exchange error; inspect quality by z/thickness slice.
- If actual topology includes prisms/pyramids, the result belongs to the mixed/swept certificate,
  not this pure-tetrahedral interpretation.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Thin-film recipe validation | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `PerObjectMeshRecipe.mesh_strategy` |
| Sweepability classification | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py) | `classify_sweepability` |
| Generator dispatch | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py) | `generate_mesh` |
| Object mesh authoring | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx) | `Thin-Film Sweep Strategy` |
| Quality scope | [`apps/control-room/src/modules/inspector/panels/ScopedMeshQualityPanels.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ScopedMeshQualityPanels.tsx) | `object quality distribution` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Swept prism](swept-prism.md)
- [Free tetrahedral](free-tetrahedral.md)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
