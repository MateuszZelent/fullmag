---
title: Airbox Construction And Grading
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: 88c7160080bc1e8519950df283d2dd02087cc3da
source_of_truth: AirboxOptions, Gmsh airbox/grading modules, shared-domain build report, and FEM Poisson demag contract
---

(public-docs-numerical-methods-meshing-airbox)=
# FEM airbox construction and grading

:::{admonition} Airbox error is not mesh error
:class: important

A finite airbox replaces the infinite exterior magnetostatic domain by a bounded computational
domain. Refining the mesh at fixed airbox size can converge to the wrong truncated problem. Airbox
extent, outer boundary condition, near-body resolution, far-field grading, and algebraic Poisson
tolerance require separate convergence controls.
:::

(numerical-methods-airbox-problem-statement)=
## Truncated exterior domain

Let $\Omega_m$ be the magnetic body and $\Omega_a$ the realized magnetic-plus-air domain. The air
region is

```{math}
:label: eq-numerical-airbox-domain
\Omega_{\mathrm{air}}=\Omega_a\setminus\overline{\Omega_m},
\qquad
\Gamma_a=\partial\Omega_a.
```

The scalar potential satisfies

```{math}
:label: eq-numerical-airbox-poisson
\nabla^2u=\nabla\cdot\mathbf M
\quad\text{in }\Omega_m,
\qquad
\nabla^2u=0
\quad\text{in }\Omega_{\mathrm{air}},
\qquad
\mathbf H_{\mathrm d}=-\nabla u.
```

The exact open-boundary condition is posed at infinity. Fullmag instead uses the selected outer
closure on $\Gamma_a$, such as Dirichlet $u=0$ or Robin
$\partial_nu+\beta u=0$. The numerical method is documented in
{doc}`../demag-solvers/fem-poisson-airbox`; this page owns construction and discretization of
$\Omega_a$.

(numerical-methods-airbox-geometry)=
## Airbox geometry

`AirboxOptions` represents either an axis-aligned bounding box or a sphere. Its reviewed defaults
are:

| Field | Default | Meaning |
|---|---:|---|
| `padding_factor` | `3.0` | requested outer scale relative to the magnetic bounding box |
| `shape` | `bbox` | `bbox` or `sphere` |
| `grading_ratio` | `1.3` | target layer-to-layer growth for geometric grading |
| `grading_mode` | `geometric` | `geometric` or legacy `linear` |
| `boundary_marker` | `99` | physical marker for $\Gamma_a$ |
| `size` | `None` | optional explicit SI size triple |
| `center` | `None` | optional explicit SI centre triple |
| `maximum_element_size` | `None` | optional far-field target $h_{a,\max}$ |
| `minimum_element_size` | `None` | optional near/interface target $h_{a,\min}$ |

For magnetic bounding-box side lengths $L_x,L_y,L_z$, the nominal padding-factor intent is
schematically

```{math}
:label: eq-numerical-airbox-padding
L_{a,q}=pL_q,
\qquad q\in\{x,y,z\},
```

centred on the magnetic bounds unless explicit `size`/`center` values select another domain. The
realized build report, not this schematic equation, is authoritative for exact bounds.

The clearance from body to outer boundary is a more useful convergence quantity than padding factor
alone. Define

```{math}
:label: eq-numerical-airbox-clearance
d_q^{-}=x_{m,q}^{\min}-x_{a,q}^{\min},
\qquad
d_q^{+}=x_{a,q}^{\max}-x_{m,q}^{\max}.
```

All six clearances should be recorded. An object displaced inside a large universe can have one
small clearance despite a large total airbox volume.

(numerical-methods-airbox-shape-fallback)=
## Shape realization and degradation

A requested spherical airbox is not guaranteed on every assembly path. The build-report function
`_airbox_shape_status` records a degradation from `sphere` to `bbox` when the shared-domain build
uses `component_aware` or `concatenated_stl_fallback`. This is an explicit requested-versus-actual
change:

- `requested_method="sphere"`;
- `actual_method="bbox"`;
- `status="degraded"`;
- a reason tied to the active GEO shared-domain path.

Strict execution must reject this change when spherical shape is scientifically required. A mesh
that solves successfully inside a box is not evidence that the requested sphere executed.

(numerical-methods-airbox-grading)=
## Geometric grading

A geometrically graded layer sequence can be written

```{math}
:label: eq-numerical-airbox-geometric-layers
h_n=h_0r^n,
\qquad r>1,
```

clamped by near- and far-field targets,

```{math}
:label: eq-numerical-airbox-clamped-size
h(\mathbf x)
=\min\!\left(h_{a,\max},
\max\!\left(h_{a,\min},h_0r^{n(\mathbf x)}\right)\right).
```

The default `grading_ratio=1.3` is a target, not a guarantee that every neighbouring element-size
ratio equals 1.3. Gmsh conformity, geometry, overlapping fields, transition zones, and algorithmic
limits determine the realized distribution.

The legacy linear mode interpolates size with distance rather than using layer-to-layer geometric
growth. Changing `grading_mode` changes the far-field degree-of-freedom distribution and belongs to
mesh identity.

A stable airbox mesh usually requires the smallest air elements at or near the magnetic interface,
where the scalar potential source and field gradients are strongest, and progressively larger
elements farther away. An unbounded jump from fine magnetic elements to coarse air elements can
produce poor tetrahedra and inaccurate field recovery even if the outer boundary is distant.

(numerical-methods-airbox-size-field-composition)=
## Composition with object and interface fields

Airbox targets coexist with object/interface/edge/corner size fields. The effective target is the
minimum active field. The target resolver carries:

- `ResolvedAirboxTarget.hmax`;
- optional `hmin`;
- optional `growth_rate`;
- each object's bulk/interface targets and transition distances.

An explicit fine interface field can dominate airbox grading far beyond the intended layer when its
transition distance or growth is poorly chosen. Conversely, an airbox `hmin` coarser than the
magnetic interface can force abrupt transitions. The build report must therefore show requested and
realized size-field status, not only global node count.

(numerical-methods-airbox-outer-boundary)=
## Outer boundary and gauge compatibility

The mesh exposes one stable outer marker, default `99`, for $\Gamma_a$. The demagnetization
operator selects the closure:

- Dirichlet eliminates/fixes the corresponding scalar-potential degrees of freedom;
- Robin assembles a boundary mass term
  $\int_{\Gamma_a}\beta uv\,\mathrm dS$;
- pure Neumann formulations require an explicit gauge/nullspace treatment.

The marker set, closure kind, Robin coefficient and unit, and gauge policy form one boundary tuple.
Changing only the mesh marker without updating the operator can apply the boundary condition to an
empty or wrong surface.

The outer boundary must be topologically distinct from magnetic surfaces, internal material
interfaces, and periodic seams. Marker collision or missing coverage is a hard error.

(numerical-methods-airbox-error-decomposition)=
## Error decomposition

For a target observable $Q$, write conceptually

```{math}
:label: eq-numerical-airbox-error-decomposition
Q_h-Q_{\infty}
=\varepsilon_{\mathrm{geom}}
+\varepsilon_{\mathrm{mesh}}
+\varepsilon_{\mathrm{airbox}}
+\varepsilon_{\mathrm{bc}}
+\varepsilon_{\mathrm{linear}}
+\varepsilon_{\mathrm{recovery}}.
```

These terms are not generally additive in a rigorous estimator; the equation labels the independent
sources that must be controlled:

- magnetic/outer geometry approximation;
- finite-element discretization;
- finite domain extent;
- Dirichlet/Robin closure model;
- Krylov/direct algebraic error;
- recovery/projection of $-\nabla u$ onto the magnetic field representation.

A small linear residual controls only $\varepsilon_{\mathrm{linear}}$.

(numerical-methods-airbox-python-api)=
## Python API

### Stage-first universe and air-mesh policy

```python
# %% Explicit finite exterior with graded air mesh
import fullmag as fm

nm = 1.0e-9
study = fm.study("graded_airbox")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(1.2e-6, 600 * nm, 550 * nm))
study.universe.mesh(
    minimum_element_size=8 * nm,
    maximum_element_size=100 * nm,
    maximum_element_growth_rate=1.3,
    grading="geometric",
)

film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.mesh(
    minimum_element_size=3 * nm,
    maximum_element_size=5 * nm,
    order=1,
)
film.Ms = 800.0e3
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.demag(model="airbox", variant="robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-10,
    max_iterations=500,
)
```

### Internal generation schema

The meshing layer's typed `AirboxOptions` carries `padding_factor`, `shape`, `grading_ratio`,
`grading_mode`, `boundary_marker`, optional `size`/`center`, and optional airbox `hmax`/`hmin`.
Stage-first authoring may lower universe/mesh controls into this schema. The realized bounds and
build report remain the source of truth.

(numerical-methods-airbox-problem-ir)=
## ProblemIR and provenance

Record at least:

- requested and realized shape;
- requested padding factor or explicit size/centre;
- realized airbox bounds and all six magnetic-to-outer clearances;
- magnetic, air, and shared-domain volumes;
- outer boundary marker and covered face count/area;
- requested/resolved $h_{a,\min}$, $h_{a,\max}$, growth ratio, and grading mode;
- realized element-size and quality statistics by magnetic/air/interface scope;
- build mode, shape status, fallback/degradation reason;
- magnetic-interface marker/topology;
- outer closure, Robin coefficient, gauge/nullspace policy;
- Poisson solver/preconditioner/tolerance and achieved residual;
- mesh and operator digests.

For periodic or Floquet airbox problems, also record periodic-pair and phase certificates. An open
airbox mesh must not be reused as a periodic operator without a new identity.

(numerical-methods-airbox-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Fail or explicitly degrade for:

- nonpositive/nonfinite padding or element sizes;
- invalid shape/grading mode;
- explicit bounds that do not contain every magnetic object with positive clearance;
- missing or colliding outer marker;
- empty/disconnected air region;
- nonconforming magnetic-air interface;
- inverted/collapsed elements;
- requested sphere realized as a box in strict mode;
- unsupported shared-domain swept plus airbox combination;
- missing boundary-condition coverage;
- incompatible periodic/gauge metadata.

The source-visible build report states that an airbox combined-domain swept workflow is not generally
implemented in the ordinary shared-domain swept route. A request must not silently preserve the
`swept` label while producing a free tetrahedral airbox/magnet mesh.

(numerical-methods-airbox-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | source-backed | Gmsh shared magnetic-plus-air mesh and CPU Poisson/BEM-compatible attributes |
| FEM | GPU | mesh source-backed, Poisson-lane gated | same extracted mesh; device solver support depends on operator/preconditioner |
| FDM | CPU | not applicable | open FDM demag uses FFT padding, not a volumetric FEM airbox |
| FDM | GPU | not applicable | open FDM demag uses FFT padding, not a volumetric FEM airbox |

(numerical-methods-airbox-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol/owner |
|---|---|---|
| Airbox request schema | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `class AirboxOptions` |
| Airbox geometry | `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py` | airbox construction owner |
| Grading fields | `packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py` | geometric/linear grading owner |
| Shared-domain target resolution | `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` | `ResolvedAirboxTarget`, `resolve_shared_domain_targets` |
| Shape fallback status | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_airbox_shape_status` |
| Complete build report | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_shared_domain_build_report` |
| Poisson outer operator | `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp` | `initialize_demag_poisson_boundary_operator` |

(numerical-methods-airbox-convergence)=
## Verification and convergence protocol

A defensible study fixes all but one error source at a time:

1. **Linear solve:** tighten tolerance until field/energy changes are negligible at fixed mesh/domain.
2. **Mesh:** refine magnetic/interface/air targets at fixed outer geometry and closure.
3. **Airbox extent:** increase every relevant clearance while holding near-body resolution and
   grading policy comparable.
4. **Closure:** compare Dirichlet and Robin sequences; vary the Robin parameter according to its
   documented model.
5. **Grading:** reduce growth ratio and far-field `hmax` at fixed near-body target and extent.
6. **Geometry shape:** compare box/sphere only when both are actually realized and their clearances
   or volume are normalized meaningfully.
7. **Field recovery:** verify $-\nabla u$ convergence and energy--field variational consistency.

Recommended observables include total demagnetization energy, volume-averaged field, maximum field
in the magnetic body, equilibrium torque, selected eigenfrequencies, and response peaks. Report the
full sequence rather than only the final mesh.

Analytical checks include uniformly magnetized ellipsoids/prisms, zero magnetization, and
manufactured scalar-potential problems with known boundary data.

(numerical-methods-airbox-limitations)=
## Limitations

- A finite airbox is never the exact infinite-domain problem at finite extent.
- `padding_factor=3` is a default, not a universal accuracy guarantee.
- Spherical shape may degrade to a bounding box on specific fallback paths.
- Geometric grading targets do not guarantee exact neighbour ratios.
- A distant outer boundary with a very coarse or poor-quality transition can remain inaccurate.
- Airbox mesh convergence does not establish dynamic-demag or equilibrium convergence.
- Shared-domain swept plus airbox support is scenario-dependent and cannot be assumed.
- Algebraic residual does not bound domain-truncation error.

(numerical-methods-airbox-scientific-bibliography)=
## Scientific bibliography

1. D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE
   Transactions on Magnetics* **26**, 415--417 (1990),
   [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
2. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
3. C. Geuzaine and J.-F. Remacle, “Gmsh: A three-dimensional finite element mesh generator with
   built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in
   Engineering* **79**, 1309--1331 (2009),
   [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(numerical-methods-airbox-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Defaults and fields | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `AirboxOptions` | typed airbox request | source/tests |
| Shape degradation | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_airbox_shape_status` | requested versus actual shape | fallback tests |
| Resolved targets | `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` | `ResolvedAirboxTarget` | airbox hmin/hmax/growth | source/tests |
| Geometry and grading | `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`, `_airbox_grading.py` | module owners | CAD shell and size fields | meshing tests |
| Boundary realization | `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp` | `initialize_demag_poisson_boundary_operator` | Dirichlet/Robin operator | native tests |
