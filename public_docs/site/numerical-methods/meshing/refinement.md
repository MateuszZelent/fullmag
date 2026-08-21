---
title: Mesh Refinement And Quality
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: 88c7160080bc1e8519950df283d2dd02087cc3da
source_of_truth: MeshSizeControls, MeshOptions, size-field planner, quality/statistics reports, and realized mesh provenance
---

(public-docs-numerical-methods-meshing-refinement)=
# Mesh refinement, size fields, and convergence

:::{admonition} “Fine” is not a convergence result
:class: important

A preset or nominal `hmax` selects a meshing policy. It does not establish that the target observable
is spatially converged, that the realized mesh satisfies the target everywhere, or that time,
linear-solver, airbox, and equilibrium errors are negligible. Production studies publish the
realized mesh sequence and observable changes.
:::

(numerical-methods-refinement-problem-statement)=
## Refinement dimensions

Fullmag distinguishes several independent limits:

- **FDM $h$ refinement:** reduce Cartesian spacings and rebuild masks/stencils/FFT kernels;
- **FEM $h$ refinement:** reduce element sizes while keeping polynomial order fixed;
- **FEM $p$ refinement:** increase finite-element order on a controlled geometry/mesh;
- **geometry refinement:** improve curved boundaries or CAD tessellation;
- **layer refinement:** increase FDM thickness cells or FEM swept layers;
- **airbox refinement:** enlarge the exterior and refine/graduating its mesh;
- **periodic-image refinement:** increase finite image counts where that approximation is used;
- **frequency/time/algebraic refinement:** separate nonspatial errors required before interpreting a
  mesh sequence.

A result is “mesh converged” only relative to a declared observable, parameter region, and tolerance.

(numerical-methods-refinement-characteristic-scales)=
## Physics-informed starting scales

The exchange length

```{math}
:label: eq-numerical-refinement-exchange-length
\ell_{\mathrm{ex}}
=\sqrt{\frac{2A}{\mu_0M_s^2}}
```

and uniaxial wall parameter

```{math}
:label: eq-numerical-refinement-wall-width
\Delta=\sqrt{\frac{A}{K_{\mathrm{eff}}}}
```

are useful initial estimates. They are not universal cell-size criteria. The shortest relevant scale
can instead come from DMI, interfacial exchange, notches, vortex/skyrmion cores, surface anisotropy,
localized modes, thin layers, current injection, or geometric curvature.

A practical initial target might use several cells/elements across the smallest expected feature,
but the accepted resolution is determined by the convergence sequence, not by a rule-of-thumb
ratio alone.

(numerical-methods-refinement-size-targets)=
## Global and local size controls

The typed size-control surface contains:

| Control | Numerical role |
|---|---|
| `maximum_element_size` | upper target in unconstrained bulk/far field |
| `minimum_element_size` | lower target that prevents uncontrolled overrefinement |
| `maximum_element_growth_rate` | limits requested size growth between neighbouring regions |
| `curvature_factor` | converts local curvature scale to a boundary target |
| `narrow_region_resolution` | requests resolution across small gaps or thin regions |
| `calibrate_for` | names a physics/workflow calibration family |
| `size_preset` | selects a named bundle of growth/curvature/narrow-region defaults |
| per-object/interface/edge/corner fields | localize refinement to physical features |
| ordered `MeshOperation` objects | add free tetrahedral, boundary layer, refine, adapt, swept, or size-field operations |

The effective target is conceptually

```{math}
:label: eq-numerical-refinement-size-field-min
h_{\mathrm{target}}(\mathbf x)
=\min_{s\in\mathcal S(\mathbf x)}h_s(\mathbf x),
```

with growth and mesher constraints applied afterward. Because `min` composition is global through
field overlap, one unexpectedly fine field can dominate much more of the domain than its visual
selector suggests.

(numerical-methods-refinement-calibrations)=
## Calibration and preset vocabulary

`MESH_SIZE_CALIBRATIONS` contains:

- `general_physics`;
- `micromagnetics_static`;
- `micromagnetics_relaxation`;
- `micromagnetics_frequency_domain`;
- `magnetostatics_dominated`;
- `imported_surface_cleanup`.

These names normalize policy defaults; they are not accuracy certifications.

The reviewed preset resolver supplies the following fallback targets when the corresponding value
is not explicitly authored:

| Preset | Growth rate | Curvature factor | Narrow-region resolution |
|---|---:|---:|---:|
| `extremely_fine` | 1.2 | 0.20 | 1.00 |
| `extra_fine` | 1.3 | 0.25 | 0.85 |
| `finer` | 1.4 | 0.40 | 0.70 |
| `fine` | 1.5 | 0.50 | 0.60 |
| `normal` | 1.6 | 0.60 | 0.50 |
| `coarse` | 1.8 | 0.80 | 0.30 |
| `coarser` | 2.0 | 1.00 | 0.20 |
| `extra_coarse` | 2.2 | 1.20 | 0.15 |
| `extremely_coarse` | 2.4 | 1.50 | 0.10 |

An explicit user value has precedence over a preset fallback. The resolved controls are serialized by
`ResolvedMeshSizeControls`; provenance should preserve both requested preset and every resolved
numeric value.

(numerical-methods-refinement-curvature-and-narrow)=
## Curvature and narrow-region fields

For local radius of curvature $R(\mathbf x)$, a curvature target can be viewed schematically as

```{math}
:label: eq-numerical-refinement-curvature
h_{\kappa}(\mathbf x)
\lesssim c_{\kappa}R(\mathbf x),
```

where `curvature_factor` controls $c_{\kappa}$. The exact Gmsh points-per-curve mapping is resolved in
`_gmsh_types.py`; the schematic equation should not be used to reverse-engineer exact element sizes.

Narrow-region controls seek enough elements across a local separation $g$. Conceptually,

```{math}
:label: eq-numerical-refinement-narrow
h_g\lesssim\frac{g}{n_g},
```

with $n_g$ determined by the resolved narrow-region policy. Thin magnetic bodies should generally use
an explicit swept/layer recipe rather than rely only on a generic narrow-gap field.

Selector-based edge/corner/interface fields require native geometric tags. The shared-domain build
report marks them `ignored` when a fallback such as concatenated STL loses the required component
tags. A successful mesh with an ignored field is not the requested refinement.

(numerical-methods-refinement-quality)=
## Mesh-quality metrics

Fullmag's `MeshQualityReport` includes:

- element count;
- signed inverse condition number (SICN): minimum, maximum, mean, 5th percentile, histogram;
- gamma/radius quality: minimum, mean, histogram;
- element volume: minimum, maximum, mean, standard deviation;
- Gmsh average quality;
- optional per-element quality, volume, and tag arrays;
- quality source.

`MeshStatisticsScope` adds node/element/boundary counts, volume totals and ratios, characteristic-size
and edge-length statistics, inverted and degenerate counts, optional SICN/gamma summaries, and
warnings for each region/scope.

The reviewed general warning constants are

```{math}
:label: eq-numerical-refinement-quality-thresholds
\gamma_{\min}^{\mathrm{warn}}=0.08,
\qquad
\operator{SICN}_{p05}^{\mathrm{warn}}=0.1.
```

These are implementation warning thresholds, not universal mathematical guarantees. Any inverted
element or topologically degenerate element is a hard failure regardless of average quality.

A quality average can hide a small population of catastrophic elements. Report the minimum,
lower-tail percentile, histogram, and worst-element locations by metric.

(numerical-methods-refinement-observed-convergence)=
## Observed convergence

For observable $Q_h$ on a geometrically similar sequence with refinement ratio $r>1$, an observed
order estimate is

```{math}
:label: eq-numerical-refinement-observed-order
p_{\mathrm{obs}}
=\frac{\log\left|
(Q_h-Q_{h/r})/(Q_{h/r}-Q_{h/r^2})
\right|}{\log r}.
```

This estimate is meaningful only when:

- the same physical branch/state is compared;
- all meshes resolve the same geometry and boundary problem;
- time, relaxation, linear, and sampling errors are smaller;
- the sequence is inside an asymptotic regime;
- the denominator is not dominated by roundoff or branch switching.

For a monotone sequence with known order $p$, a Richardson extrapolate is

```{math}
:label: eq-numerical-refinement-richardson
Q_{\mathrm{ext}}
\approx Q_{h/r^2}
+\frac{Q_{h/r^2}-Q_{h/r}}{r^p-1}.
```

Use this only when its assumptions are demonstrated. Topological transitions, switching thresholds,
localized modes, and nearly degenerate eigenbranches can make scalar order estimates misleading.

(numerical-methods-refinement-mode-convergence)=
## Fields, modes, and branch-sensitive observables

For fields on different meshes, transfer both to a common comparison space. A weighted relative
error is

```{math}
:label: eq-numerical-refinement-field-error
\varepsilon_h
=\frac{\lVert u_h-u_{\mathrm{ref}}\rVert_W}
{\lVert u_{\mathrm{ref}}\rVert_W}.
```

For complex normalized modes,

```{math}
:label: eq-numerical-refinement-mode-overlap
\mathcal O_h
=\frac{|\langle u_h,u_{\mathrm{ref}}\rangle_W|}
{\lVert u_h\rVert_W\lVert u_{\mathrm{ref}}\rVert_W}.
```

Frequency convergence without overlap can compare different branches. Equilibrium textures should
also compare energy, maximum torque, angular field error, topological charge under the same
discretization definition, and relevant geometric feature location.

(numerical-methods-refinement-study-design)=
## Production convergence protocol

A recommended sequence is:

1. define physical geometry, materials, interactions, boundary conditions, and observable;
2. choose a baseline mesh from physical length scales;
3. tighten time/relaxation/linear-solver tolerances until they do not limit the observable;
4. generate at least three controlled spatial levels;
5. preserve the same branch using continuation and mode-overlap checks;
6. report realized element/cell counts, sizes, quality, region volume, and mesh digest;
7. compare scalar and field observables with explicit norms;
8. refine geometry/order/thickness/airbox independently when relevant;
9. repeat the study for critical parameter extremes, not only one nominal state;
10. set an acceptance threshold before selecting the production mesh.

For hysteretic switching or phase boundaries, mesh convergence should bracket the critical parameter
and quantify threshold shift rather than compare only one trajectory.

(numerical-methods-refinement-python-api)=
## Python API

```python
# %% Explicit size controls and local object refinement
import fullmag as fm

nm = 1.0e-9
study = fm.study("mesh_refinement")
study.engine("fem")
study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
study.universe.mesh(
    calibrate_for="micromagnetics_relaxation",
    size_preset="normal",
    minimum_element_size=8 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.5,
    curvature_factor=0.5,
    narrow_region_resolution=0.6,
)

magnet = study.geometry(fm.Box(300 * nm, 100 * nm, 5 * nm), name="magnet")
magnet.mesh(
    minimum_element_size=2.5 * nm,
    maximum_element_size=5 * nm,
    order=1,
    compute_quality=True,
    per_element_quality=True,
)
```

Typed per-object recipes additionally expose algorithms, optimization, boundary layers, swept
parameters, extra size fields, and an ordered operation sequence. Unsupported operations must be
reported as skipped/ignored/degraded rather than disappearing.

### Public resolution semantics

| Layer | Examples | Precedence/meaning |
|---|---|---|
| explicit local recipe | per-object `hmax`, interface/edge/corner fields | highest local intent |
| workflow per-geometry | frontend/control-room object override | below typed recipe |
| workflow default | global object default | inherited by objects without override |
| study FEM default | `FEM.hmax`, `FEM.order` | lowest object fallback |
| preset fallback | growth/curvature/narrow defaults | used only where numeric control is absent |
| realized mesh | extracted sizes/quality/attributes | authoritative solver input |

(numerical-methods-refinement-problem-ir)=
## ProblemIR and provenance

Store:

- requested calibration, preset, and all explicit numeric controls;
- resolved numeric controls after alias/preset/default resolution;
- every size field's ID, kind, target, source, status, reason, and native field ID;
- ordered mesh operations and requested/actual method;
- mesher algorithms, optimization, smoothing, version, and deterministic inputs;
- build mode, fallback/degradation status;
- mesh digest, region/submesh signatures, order, cell/facet families;
- size, edge, volume, SICN, gamma, inversion, and degeneracy statistics by scope;
- worst-element locations and markers;
- convergence-study level, observable values, transfer/branch correspondence, and acceptance result.

The generated mesh must be retained or content-addressed. Preset name plus `hmax` does not uniquely
identify a triangulation.

(numerical-methods-refinement-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Reject invalid calibration/preset names, nonpositive/nonfinite controls, inconsistent min/max,
invalid growth/curvature/narrow targets, inverted/degenerate topology, missing selectors under strict
intent, and unsupported operations. Report skipped optimizer intent when `optimize_iters>0` but no
optimizer is selected.

A fallback to another 3D meshing algorithm may be accepted only with recorded requested/actual
algorithm and preserved topology/region semantics. A local field ignored after component tags are
lost is degradation, not successful refinement.

(numerical-methods-refinement-discrete-realization)=
## Discrete realization by lane

| Discretization | Device | Status | Refinement realization |
|---|---|---|---|
| FDM | CPU/GPU | implemented | explicit cell-size/count sequence; rebuild masks and all grid-dependent operators |
| FEM | CPU | source-backed | Gmsh size fields, algorithms, quality/statistics, extracted mesh |
| FEM | GPU | mesh source-backed, operator-gated | same extracted mesh; supported element/order families required |

Adaptive `SizeFieldData` exists as a typed nodal target representation, but this page does not claim
a universally qualified automatic solve–estimate–remesh–transfer loop for all Fullmag studies.

(numerical-methods-refinement-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol/owner |
|---|---|---|
| Mesh option and preset vocabulary | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `MeshOptions`, `MESH_SIZE_CALIBRATIONS`, `MESH_SIZE_PRESETS` |
| User-to-resolved controls | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `resolve_user_mesh_size_controls`, `ResolvedMeshSizeControls` |
| Per-object recipe | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe`, `MeshOperation` |
| Size-field composition | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | size-field plan owner |
| Typed public controls | `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py` | mesh-control validation owner |
| Quality and statistics | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `MeshQualityReport`, `MeshStatisticsReport`, `MeshStatisticsScope` |
| Realized status reporting | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_realized_size_field_report`, `_build_mesh_operation_statuses` |
| Nodal adaptation field | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `SizeFieldData` |

(numerical-methods-refinement-validation)=
## Verification requirements

1. Resolve preset/default/override precedence with exact IR round-trip tests.
2. Measure realized element size by each intended scope; do not infer it from authored fields.
3. Validate positive Jacobians, zero inverted/degenerate count, quality tails, and worst elements.
4. Verify selector coverage and requested/applied/ignored/degraded operation statuses.
5. Use analytical/manufactured fields to establish formal interior convergence.
6. Validate geometry volume/area convergence independently of field error.
7. Establish target-observable convergence with at least three levels where possible.
8. Track field/mode correspondence, not only scalar values.
9. Repeat with tighter temporal, relaxation, linear, and airbox settings to exclude error pollution.
10. Compare CPU/GPU on the identical mesh/grid digest.
11. Archive the complete sequence, not only the selected production level.

(numerical-methods-refinement-limitations)=
## Limitations

- Named presets are convenience policies, not accuracy grades.
- `hmax` is a target and may not be the realized maximum in constrained regions.
- Average quality can hide unacceptable tail elements.
- Observed order can be invalidated by branch changes or mixed error sources.
- Curvature and narrow-region fields depend on preserved CAD/component tags.
- Uniform refinement can be prohibitively expensive for nonlocal demag and explicit time integration.
- Typed adaptation fields do not establish a production automatic-adaptivity workflow.
- Mesh convergence at one parameter point does not qualify the entire parameter sweep.

(numerical-methods-refinement-scientific-bibliography)=
## Scientific bibliography

1. S. C. Brenner and L. R. Scott, *The Mathematical Theory of Finite Element Methods*, 3rd ed.,
   Springer, 2008, [doi:10.1007/978-0-387-75934-0](https://doi.org/10.1007/978-0-387-75934-0).
2. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM Classics, 2002,
   [doi:10.1137/1.9780898719208](https://doi.org/10.1137/1.9780898719208).
3. C. Geuzaine and J.-F. Remacle, “Gmsh: A three-dimensional finite element mesh generator with
   built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in
   Engineering* **79**, 1309--1331 (2009),
   [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(numerical-methods-refinement-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Preset values | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `_MESH_SIZE_PRESET_DEFAULTS` | resolved growth/curvature/narrow defaults | source/tests |
| Quality fields | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `MeshQualityReport`, `MeshStatisticsScope` | durable quality/statistics schema | serialization/tests |
| Warning gates | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `GAMMA_MIN_QUALITY_THRESHOLD`, `SICN_P05_QUALITY_THRESHOLD` | reviewed warning thresholds | source/tests |
| Operation outcomes | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_mesh_operation_statuses` | requested versus actual meshing operations | fallback tests |
