---
title: "Swept-hexahedral ferromagnet mesh"
description: "Authoring contract and current support boundary for swept hex8 magnetic meshes."
summary: "The Python schema can represent a quadrilateral-source swept `hex8` request, but the current Control Room capability gate marks swept hex as unsupported. Do not present it as an executable production mesh."
status: unsupported
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "SweptMeshControls validation and active mesh capability matrix"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-swept-hex)=
# Swept-hexahedral ferromagnet mesh

**Last changes: 12:31 24.08.2026**

The Python schema can represent a quadrilateral-source swept `hex8` request, but the current Control Room capability gate marks swept hex as unsupported. Do not present it as an executable production mesh.

::::{admonition} Implementation status
:class: important

Schema-level vocabulary exists. Current Control Room resolves `sweptHex.enabled = false` with status `unsupported` because the mixed-P1 hex route has not passed qualification. This page intentionally provides a contract-inspection example rather than a runnable solver example.
::::

## Scope and purpose

This page documents the intended semantics and explicit support boundary so users do not mistake
a serialized option for an executable mesh. Hexahedra require a quadrilateral source mesh,
consistent destination topology, valid orientation and operator support for `hex8`.

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
:label: eq-meshing-exchange-length-fem-ferromagnet-swept-hex
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

Sweeping a conforming quadrilateral source element between two planes produces an eight-node
hexahedron. Compared with prisms, hexes can align all three parametric directions with the film,
but source-surface recombination and transition into tetrahedral surroundings are more restrictive.

The current `SweptMeshControls` contract forbids the prism-specific
`pyramid_to_tetrahedra` transition for `element_family="hex"`. Therefore a future production route
must either keep a conforming all-hex region with a separately qualified transition or reject the
mixed surroundings. None of that is implied by the present schema object.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Need executable thin-film layers now | `swept_prism` when enabled | Current reviewed production target |
| Need ordinary robust mesh | `free_tetrahedral` | Implemented baseline |
| Researching future hex contract | serialize `SweptMeshControls` only | Useful for tests/design, not solver execution |

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

**Complete contract-inspection example (not an executable mesh claim)**

```python
from fullmag.model.discretization import SweepDistribution, SweptMeshControls

# Contract-only example. This validates/serializes the requested authoring
# object; it is not a claim that the current Control Room can execute hex8.
controls = SweptMeshControls(
    sweep_direction="z",
    element_family="hex",
    transition_policy="reject",
    exact_layer_count=True,
    distribution=SweepDistribution(kind="uniform", num_layers=2),
)
print(controls.to_ir())

# A production study must query the capability matrix before attempting to
# attach a swept_hex object policy. The reviewed Control Room gate disables it.
```

## Control Room workflow

**Swept hex is disabled.** The UI must show the capability reason and must not allow Apply/Build to
construct a `swept_hex` request through normal controls. Use the capability/resource inspector to
review status. Do not bypass the disabled control with Advanced JSON unless developing and testing
an explicit backend capability; strict validation should still reject unsupported execution.

## Qualification required before enabling

A future implementation needs: quadrilateral source/destination conformity; exact layer-plane
certificate; positive `hex8` Jacobians; transition policy; complete typed extraction; CPU/GPU
assembly support for every active interaction; quality metrics appropriate to hexes; regression
fixtures; Control Room capability evidence; and observable convergence against a tetra/prism
reference.

## Diagnostics and failure semantics

- Current expected behavior is an explicit unsupported/capability error, not tetrahedral fallback.
- `element_family="hex"` requires a quadrilateral source and `swept_hex` strategy.
- `pyramid_to_tetrahedra` is invalid for the current hex schema.
- Presence of `hex8` in imported-mesh extraction does not qualify generated swept-hex assembly or
  solver execution.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Schema vocabulary | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `SweptMeshControls, PerObjectMeshRecipe` |
| Typed imported `hex8` ingress | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py) | `hex8 mapping` |
| Control Room disabled gate | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts) | `sweptHex capability option` |
| Mixed-element tests | [`packages/fullmag-py/tests/test_mixed_element_meshing.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/tests/test_mixed_element_meshing.py) | `typed mixed topology tests` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Swept prism](swept-prism.html)
- [General swept meshes](../../swept-meshes.html)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
