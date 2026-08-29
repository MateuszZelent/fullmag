---
title: "Swept and layered FEM meshes"
description: "Layered prism/hex meshing, thickness distributions, transition elements and strict realization certificates."
summary: "Swept meshing extrudes a source surface through a thickness or along a sweep direction. In Fullmag, requested layers and topology are strict scientific intent only when the capability matrix and post-build certificate confirm them."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "SweptMeshControls, PerObjectMeshRecipe validation, Gmsh swept generator, mixed-element extraction and capability matrix"
---

(public-docs-numerical-methods-meshing-swept-meshes)=
# Swept and layered FEM meshes

**Last changes: 12:31 24.08.2026**

Swept meshing extrudes a source surface through a thickness or along a sweep direction. In Fullmag, requested layers and topology are strict scientific intent only when the capability matrix and post-build certificate confirm them.

::::{admonition} Implementation status
:class: important

Exact P1 layered prisms with triangular source faces and 1–3 layers are authorable only when all required capabilities are executable. `swept_hex` is represented in schemas but is disabled in the current Control Room mixed-P1 gate. Generic shared-domain swept execution is not universally supported.
::::

## Scope and purpose

Use a swept mesh when the geometry is sweepable and the through-thickness topology is part of the
physical model—for example thin films, waveguides and layered structures. The page distinguishes
three outcomes: exact layered prism, layered-surface tetrahedral realization, and unsupported or
fallback topology. These outcomes are not interchangeable.

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
:label: eq-meshing-exchange-length-swept-meshes
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

Let $s\in[0,1]$ parameterize thickness from source to destination. Uniform layer planes are

```{math}
:label: eq-swept-uniform-planes-swept-meshes
s_j=\frac{j}{N},\qquad j=0,\ldots,N.
```

For geometric element thicknesses $d_j=d_0q^j$ with $q>0$ and total thickness $t$,

```{math}
:label: eq-swept-geometric-layers-swept-meshes
d_0=t\frac{1-q}{1-q^N}\quad(q\ne1),
\qquad d_0=\frac{t}{N}\quad(q=1).
```

Sweeping each source triangle between adjacent planes produces a `prism6` cell. A prismatic film
embedded in tetrahedral air can require `pyramid5` transition cells. The transition is part of the
finite-element topology and must be supported by assembly, quadrature and every active operator.

A certificate for exact layering should verify $N+1$ node planes, requested plane positions,
prism orientation/Jacobians, cell-family counts, source/destination marker coverage and absence of
unreported tetrahedral replacement.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Box-like thin film; exact layer planes required | `swept_prism` | Current qualified authoring target with triangular source and P1 prism cells |
| Specialized waveguide path returning thickness-aware tetrahedra | `thin_film_tetrahedral` / realized layered tetrahedra | Use actual certificate; do not label tetrahedra as prisms |
| Quadrilateral source and hex cells | `swept_hex` only after capability qualification | Schema presence does not equal executable support |
| Generic multi-object shared domain | free tetrahedral unless a strict mixed mode is advertised | Current swept support is scenario-qualified |

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

In **Thin-Film Sweep Strategy**, select **Swept prism** only when the capability banner enables it.
The UI canonicalizes triangular source faces, P1 order, prism family, exact layer count and the
pyramid-to-tetrahedra transition. The supported layer-count selector is populated from
`mesh.exact_layer_count`; the reviewed Control Room gate requires exactly `[1, 2, 3]`.
**Swept hex** remains disabled until its topology/operator gate is qualified.

## Required realization certificate

For an exact prism request, require: requested and actual method; exact layer count; $N+1$ node
planes; plane coordinates and tolerance; prism/pyramid/tet counts by region; positive reference
and physical Jacobians; complete interface and outer markers; mixed-topology conformity; quality
metric name; and fallback status. A report containing only total element count is insufficient.

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
:label: eq-meshing-relative-change-swept-meshes
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- Non-sweepable geometry must be rejected in strict mode or reported with an explicit fallback.
- Exact layer count with a nonuniform distribution is rejected by the strict Python schema.
- Prism requests require P1, triangular source faces, `swept_prism`, exact layer count and
  `pyramid_to_tetrahedra` in the current mixed route.
- Hex requests require `swept_hex` and quadrilateral source faces and cannot use the pyramid
  transition in the current schema.
- Gmsh surface algorithm 8 is sanitized to algorithm 6 in thin-film 3-D volume workflows because
  the source-visible generator records it as unstable for that context.
- A successful Gmsh call that realizes only tetrahedra does not satisfy an exact prism request.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Python swept contract | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `SweepDistribution, SweptMeshControls, PerObjectMeshRecipe` |
| Swept generator and eligibility | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py) | `classify_sweepability, generate_swept_mesh` |
| Meshing dispatch | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py) | `should_use_swept dispatch` |
| Mixed topology extraction | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py) | `linear tet/prism/pyramid/hex extraction` |
| Control Room capability gate | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts) | `resolveObjectMeshTopologyCapabilities` |
| Mixed build report | [`packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py) | `layer/topology certificate` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Swept prism](fem/ferromagnet/swept-prism.md)
- [Swept hex](fem/ferromagnet/swept-hex.md)
- [Mixed elements](fem/ferromagnet/mixed-elements.md)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Runtime realization is owned by the relevant `backends/fdm` or `backends/fem` implementation; the page must not claim a symbol not named in its implementation mapping.

