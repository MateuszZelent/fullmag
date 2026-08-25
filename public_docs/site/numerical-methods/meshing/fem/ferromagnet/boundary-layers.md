---
title: "FEM boundary-layer mesh controls"
description: "Targeted anisotropic mesh layers adjacent to selected surfaces or curves."
summary: "Boundary-layer controls request stacked near-boundary elements on explicitly selected entities. They are useful only when the active formulation has a boundary-normal scale that must be resolved."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "mesh_controls.boundary_layers, Gmsh field application, semantic selector resolution and realized layer report"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-boundary-layers)=
# FEM boundary-layer mesh controls

**Last changes: 12:31 24.08.2026**

Boundary-layer controls request stacked near-boundary elements on explicitly selected entities. They are useful only when the active formulation has a boundary-normal scale that must be resolved.

::::{admonition} Implementation status
:class: important

Boundary-layer authoring and semantic/tag targets are source-backed. A terminology inconsistency remains: the Python helper argument is `first_layer_thickness`, while the serialized key is `boundary_layer_thickness` and current UI wording has described total physical thickness. Until unified, inspect the normalized field plan and realized layer thicknesses.
::::

## Scope and purpose

Use boundary layers selectively—for example to resolve a surface-localized coupled field,
magnetoelastic boundary effect or imported near-surface structure. They are not automatically
required by standard exchange or demagnetization, and they can introduce extreme aspect ratios
and poor conditioning when used without a physical reason.

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
:label: eq-meshing-exchange-length-fem-ferromagnet-boundary-layers
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

For a first layer thickness $d_0$, stretching ratio $q>0$ and $N$ layers, the nominal layer
thicknesses are

```{math}
:label: eq-boundary-layer-thicknesses-fem-ferromagnet-boundary-layers
d_j=d_0q^j,\qquad j=0,\ldots,N-1,
```

with total nominal stack thickness

```{math}
:label: eq-boundary-layer-total-fem-ferromagnet-boundary-layers
D=\sum_{j=0}^{N-1}d_j=
\begin{cases}
Nd_0,&q=1,\\
d_0(1-q^N)/(1-q),&q\ne1.
\end{cases}
```

This distinction is exactly why the current naming inconsistency matters: interpreting the input
as $D$ rather than $d_0$ changes every layer. The realized report must state actual layer widths
and the normalization chosen by the backend.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Known boundary-normal physical scale | boundary layers | Targets resolution normal to an explicit surface |
| General edge singularity | edge-distance refinement | Usually safer than forcing anisotropic layers |
| Thin entire body | thin-film or swept strategy | Global thickness topology is clearer than local boundary layers |
| No boundary-local physics | do not add layers | Avoids unnecessary aspect-ratio and conditioning penalties |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `boundary_layer_count` / `count` | layers | unset | integer >= 1 | number of requested near-boundary layers |
| `first_layer_thickness` (helper) | m | required | positive | documented Python helper meaning; current serialization uses `boundary_layer_thickness` |
| `boundary_layer_thickness` (IR/UI key) | m | unset | positive | ambiguous legacy/current naming; verify normalized and realized semantics |
| `boundary_layer_stretching` / `stretching` | 1 | `1.2` | positive | ratio of successive nominal layer thicknesses |
| `target_surface_tags` | Gmsh tags | `[]` | integer list | direct surface targets; less stable across geometry revisions |
| `target_curve_tags` | Gmsh tags | `[]` | integer list | direct curve targets |
| `target_surfaces` | selectors | `[]` | validated semantic selectors | preferred surface selection |
| `target_curves` | selectors | `[]` | validated semantic selectors | preferred curve selection |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_boundary_layer_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(500 * nm, 300 * nm, 200 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=12 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(300 * nm, 120 * nm, 10 * nm), name="film"),
    name="film",
)
layer_controls = fm.mesh.boundary_layers(
    count=3,
    first_layer_thickness=1.0 * nm,
    stretching=1.25,
    target_surfaces=[
        fm.mesh.nearest_surface_to_point(
            point=(0.0, 0.0, 5 * nm),
            geometry="film",
            count=1,
        )
    ],
)
film.mesh(
    mesh_strategy="free_tetrahedral",
    minimum_element_size=1.0 * nm,
    maximum_element_size=8 * nm,
    maximum_element_growth_rate=1.3,
    order=1,
    compute_quality=True,
    **layer_controls,
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

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

Configure **Boundary Layers** under the object policy, target surfaces/curves through semantic
selectors, then apply and build. Until the thickness terminology is unified, compare the form
value with the effective JSON, normalized field plan and actual layer-width report. A successful
selector must report the matched entity IDs and geometry revision.

## Verification

Verify selector cardinality, layer count, actual normal thicknesses, stretching ratio, cell
orientation and aspect-ratio/quality distributions. Compare the target observable with a simpler
isotropically refined mesh. Boundary layers are accepted only if they reduce the relevant error
without introducing solver instability or an unsupported element family.

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
:label: eq-meshing-relative-change-fem-ferromagnet-boundary-layers
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- The helper rejects an empty target set.
- A selector resolving zero or multiple unintended entities must block or request user action.
- High stretching or a very small first layer can generate collapsed/poorly conditioned cells.
- The thickness-key inconsistency is a documentation and API audit finding, not a value to guess.
- Regenerate after every geometry revision because tags and nearest-entity results can change.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Python boundary-layer helper | [`packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py) | `boundary_layers` |
| Semantic nearest selectors | [`packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py) | `nearest_surface_to_point, nearest_curve_to_point` |
| Object policy validation | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `PerObjectMeshRecipe boundary-layer fields` |
| Gmsh field application | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py) | `boundary layer application` |
| Control Room draft | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts) | `boundaryLayer* fields` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Refinement](../../refinement.html)
- [Selectors and attributes](../shared-domain/selectors-and-attributes.html)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
