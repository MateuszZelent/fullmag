---
title: "Periodic FEM airbox mesh"
description: "Paired boundary meshes, periodic representative maps and support boundary for FEM periodic demagnetization."
summary: "A periodic airbox requires geometrically paired boundary meshes, a certified node-equivalence map and a separately qualified periodic Poisson/null-mode formulation. Open-airbox support does not imply periodic support."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "PeriodicBoundaryPair contract, Gmsh periodic surface configuration, periodic mesh certificate and FEM periodic demag capability"
---

(public-docs-numerical-methods-meshing-fem-airbox-periodic-airbox)=
# Periodic FEM airbox mesh

**Last changes: 12:31 24.08.2026**

A periodic airbox requires geometrically paired boundary meshes, a certified node-equivalence map and a separately qualified periodic Poisson/null-mode formulation. Open-airbox support does not imply periodic support.

::::{admonition} Implementation status
:class: important

Periodic pair descriptors and source-visible periodic FEM paths exist, but production qualification is scenario- and lane-dependent. Unsupported pairings or null-mode policies must be rejected; no fallback to open airbox is allowed.
::::

## Scope and purpose

Use this route only for a representative FEM unit cell whose selected boundary surfaces are
related by exact translations. The mesh planner must pair source/destination entities and build a
representative map. This page does not claim universal fully periodic 3-D FEM support.

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
:label: eq-meshing-exchange-length-fem-airbox-periodic-airbox
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

For a translation $\mathbf L$, paired scalar degrees of freedom satisfy at $k=0$

```{math}
:label: eq-periodic-airbox-k0-fem-airbox-periodic-airbox
u(\mathbf r+\mathbf L)=u(\mathbf r).
```

Let $P$ prolong values from periodic representatives to all paired degrees of freedom. A reduced
Poisson system has

```{math}
:label: eq-periodic-airbox-reduced-fem-airbox-periodic-airbox
A_p=P^TAP,\qquad b_p=P^Tb.
```

The mesh certificate must prove that each destination node is the translated image of exactly one
source node within `tolerance_m`, with consistent orientation and region roles. The periodic
scalar-potential system also needs an explicit gauge/zero-mode policy; that is not a meshing
parameter.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| k=0 periodic static unit cell | `periodic_airbox_k0` when qualified | Representative reduction and explicit null-mode policy |
| Open isolated magnet | ordinary open airbox | Different physical Green-function problem |
| Bloch/Floquet k != 0 | separate frequency-domain Floquet contract | Requires complex phase, not simple k=0 identification |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `pair_id` | 1 | required | non-empty unique string | stable identity for one periodic pair |
| `source_marker` | 1 | required | existing semantic marker | source boundary surface |
| `destination_marker` | 1 | required | existing semantic marker | translated destination surface |
| `translation` | m | required | finite 3-vector | source-to-destination lattice translation |
| `tolerance_m` | m | `1e-12` | positive | node/entity matching tolerance |
| `axis_hint` | 1 | unset/helper-derived | `x`, `y`, `z` or supported hint | diagnostic axis label |
| `pairing_policy` | 1 | `node_nearest_within_tolerance` | supported policy | rule used to form node pairs |
| demag policy | 1 | `open` | `periodic_airbox_k0` for this route | selects the reduced periodic scalar-potential operator |

## Python API

**Complete Python example**

```python
import fullmag as fm
from fullmag.meshing.periodic import periodic_x, periodic_y

nm = 1.0e-9
lx = 200 * nm
ly = 100 * nm

# Explicit pair descriptors are useful for inspecting the mesh contract.
pairs = [
    periodic_x("px", source="x_min", destination="x_max", length_m=lx),
    periodic_y("py", source="y_min", destination="y_max", length_m=ly),
]
for pair in pairs:
    print(pair.to_ir())

study = fm.study("periodic_fem_airbox_k0")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(lx, ly, 120 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=5 * nm,
    maximum_element_size=30 * nm,
    maximum_element_growth_rate=1.35,
    grading="geometric",
)
study.pbc(
    x=True,
    y=True,
    z=False,
    demag="periodic_airbox_k0",
)
film = study.geometry(
    fm.Box(size=(lx, ly, 5 * nm), name="unit_cell"),
    name="unit_cell",
)
film.mesh(
    mesh_strategy="free_tetrahedral",
    minimum_element_size=3 * nm,
    maximum_element_size=6 * nm,
    order=1,
    compute_quality=True,
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag()
# Execution is legal only when the active FEM periodic capability is advertised.
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", max_steps=10_000, tolT=1.0e-6)
```

## Control Room workflow

1. Configure the explicit unit-cell geometry and a conforming FEM shared-domain mesh.
2. Add periodic boundary pairs using semantic source/destination markers and exact translations.
3. Select the periodic FEM demag policy only when the active-lane capability is executable.
4. Build and inspect the periodic certificate: entity pairing, node pairing, translation residual,
   orientation, region/marker mapping and representative count.
5. Inspect the solver's gauge/null-mode provenance and periodic seam field continuity.

If the periodic capability is missing or degraded, the UI must disable execution and retain the
authored request/reason. It must not silently select open demagnetization.

## Periodic verification

Check one-to-one pairing, translation residuals, seam continuity, representative-map completeness
and reduced-system residuals. Compare the central cell against an explicitly tiled supercell when
feasible. Verify that open axes retain the intended closure. For dynamics/Bloch studies, validate
the separate phase convention and do not reuse this k=0 certificate as k != 0 evidence.

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

- Wrong translation sign or source/destination order breaks pairing.
- Tolerance too small misses legitimate pairs; too large can create ambiguous nearest matches.
- Pair surfaces must have compatible mesh topology; coordinate proximity alone is insufficient.
- Missing gauge/zero-mode treatment is a solver error even with a valid mesh pair.
- FDM `truncated_images`, FEM `periodic_airbox_k0` and Floquet k != 0 are distinct policies.
- Unsupported periodic execution must fail explicitly, never fall back to an open airbox.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Python periodic pair | [`packages/fullmag-py/src/fullmag/meshing/periodic.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/periodic.py) | `PeriodicBoundaryPair, periodic_x/y/z` |
| Gmsh periodic surfaces | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py) | `_configure_axis_periodic_surfaces` |
| Periodic certificate | [`packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py) | `periodic pairing evidence` |
| Python PBC policy | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/problem.py) | `FdmPbc / common PBC intent` |
| FEM periodic benchmark | [`crates/fullmag-engine/src/fem_pbc_benchmark.rs`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/crates/fullmag-engine/src/fem_pbc_benchmark.rs) | `periodic FEM evidence path` |
| Production matrix verifier | [`scripts/verify_pbc_production_matrix.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/scripts/verify_pbc_production_matrix.py) | `PBC capability verification` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Periodic demagnetization](../../../demag-solvers/periodic-demag.md)
- [Boundary closure](boundary-closure.md)
- [FDM periodic grids](../../fdm/periodic-grids.md)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
