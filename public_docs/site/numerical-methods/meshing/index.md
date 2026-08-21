---
title: Meshing
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: meshing terminal pages, mesh source modules, and source revision 88c7160080bc1e8519950df283d2dd02087cc3da
---

(public-docs-numerical-methods-meshing-root)=
# Spatial discretization and meshing

:::{admonition} The mesh is part of the numerical model
:class: important

A mesh request is not display metadata. It determines the discrete geometry, degrees of freedom,
cell/element volumes, material assignment, interaction operators, demagnetizing boundary problem,
solver conditioning, and reproducibility of every result. Requested controls and the realized mesh
must be stored separately.
:::

## FDM and FEM represent different discrete spaces

| Property | FDM | FEM |
|---|---|---|
| Geometry | Cartesian cells and active masks | conforming elements fitted to a shared geometric domain |
| Magnetization location | cell centres | finite-element degrees of freedom, normally nodal for the documented P1 representation |
| Local derivatives | finite-difference stencils | weak-form element matrices and quadrature |
| Demagnetization | cell-averaged tensor convolution | scalar potential on airbox or FEM/BEM boundary operator |
| Curved boundaries | stair-stepped or fraction/mask approximation | explicitly approximated by boundary elements and geometry order |
| Refinement | change cell spacings/counts | local $h$ refinement, grading, element order, swept layers |
| Primary provenance | origin, counts, spacing, mask, common FFT grid | mesh digest, elements, order, attributes, boundary markers, periodic pairs |

A result transferred between these spaces is a new discrete state; see
{doc}`../interpolation-and-state-transfer/index`.

## Resolution scales from the physics

Mesh selection should be driven by the shortest relevant magnetic and geometric scales. Common
estimates include the exchange length

```{math}
:label: eq-meshing-root-exchange-length
\ell_{\mathrm{ex}}
=\sqrt{\frac{2A}{\mu_0M_s^2}}
```

and, for a uniaxial wall model, the characteristic wall parameter

```{math}
:label: eq-meshing-root-wall-width
\Delta=\sqrt{\frac{A}{K_{\mathrm{eff}}}}.
```

These are starting scales, not universal acceptance rules. DMI, magnetostatic edge structure,
interfaces, notches, surface anisotropy, localized modes, and the target observable can require
finer resolution. Conversely, resolving a nominal exchange length does not prove geometry,
airbox, time-step, or algebraic-solver convergence.

A production study declares an observable and demonstrates convergence as the spatial resolution is
refined while all other numerical policies are controlled.

## FDM Cartesian grids

For origin $\mathbf x_0$, spacings $(h_x,h_y,h_z)$, and integer indices $(i,j,k)$,

```{math}
:label: eq-meshing-root-fdm-centre
\mathbf x_{ijk}=\mathbf x_0+
\left((i+\tfrac12)h_x,(j+\tfrac12)h_y,(k+\tfrac12)h_z\right),
```

with

```{math}
:label: eq-meshing-root-fdm-volume
V_{\mathrm{cell}}=h_xh_yh_z,
\qquad
N=N_xN_yN_z.
```

### Grid ownership

Fullmag distinguishes:

- a default object cell size;
- per-object native cell-size overrides;
- the active/material mask on each native grid;
- a requested common convolution-grid resolution for multilayer/nonlocal demagnetization where
  applicable.

A common convolution grid is a numerical communication space, not a second physical magnetization
mesh. Interpolation/restriction to that grid must not silently overwrite the object-owned state.

The public cell-size validators require exactly three finite positive SI lengths. Object extents and
requested cell sizes must satisfy the documented divisibility/compatibility rules; grid declaration
does not perform an unlabelled resampling.

### Staircase error

A Cartesian mask approximates a curved boundary by cells. The resulting geometry error changes
volume, surface normal, local exchange connectivity, and demagnetizing charge. For a convergence
study, report both nominal cell size and realized magnetic volume. Rotating a curved body relative
to the grid can be a useful anisotropy-of-discretization test.

### Thin films

One cell through thickness is a thickness-averaged FDM model. It does not resolve a nonuniform
through-thickness profile. Whether one cell is sufficient depends on the interaction set and target
observable; DMI, surface anisotropy, standing thickness modes, and strongly nonuniform stray fields
can require multiple cells.

See {doc}`fdm-grids` for the exact public fields and source map.

## FEM shared-domain mesh

Fullmag assembles one conforming solver mesh from the universe and all objects. Three layers of
information remain distinct:

1. **universe intent:** enclosing domain, airbox extents, coarse/far-field size policy;
2. **object intent:** local element bounds, thin-film/swept recipe, interface refinement;
3. **realized mesh:** nodes, elements, attributes, boundary markers, periodic pairs, quality
   metrics, and digest actually consumed by the solver.

For basis functions $\phi_a$,

```{math}
:label: eq-meshing-root-fem-field
m_q^h(\mathbf x)=\sum_am_{q,a}\phi_a(\mathbf x),
\qquad q\in\{x,y,z\}.
```

Conformity means neighbouring elements share the same geometric interface and compatible trace
degrees of freedom. Overlapping object meshes, disconnected duplicate interfaces, missing physical
attributes, or nonmatching periodic faces are solver errors even if the viewport appears correct.

### Magnetic and nonmagnetic regions

A shared FEM mesh may include magnetic bodies and nonmagnetic air. Magnetization degrees of freedom,
material coefficients, scalar-potential unknowns, and integration domains are selected by region
attributes. The airbox must not be interpreted as a zero-$M_s$ magnetic body unless the operator
explicitly uses that representation.

### Geometry and element order

The discrete error contains both field-approximation error and geometry-approximation error. Raising
the finite-element polynomial order without improving a piecewise-planar curved boundary may leave
geometry error dominant. Provenance should therefore record geometry order separately from field
order when the meshing backend distinguishes them.

The assembly/extraction anchors are
`packages/fullmag-py/src/fullmag/meshing/_gmsh_infra.py` and
`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`. See
{doc}`fem-shared-domain`.

## Airbox construction and grading

FEM scalar-potential demagnetization truncates the exterior to a bounded airbox
$\Omega_a=\Omega_m\cup\Omega_{\mathrm{air}}$. Airbox extent and mesh grading are independent
accuracy parameters.

Let $d(\mathbf x)$ be distance from the magnetic body. A graded target size can be viewed
schematically as

```{math}
:label: eq-meshing-root-airbox-grading
h(\mathbf x)
=\min\!\left(h_{\max},
\max\!\left(h_{\min},h_0g(d(\mathbf x))\right)\right),
```

where $g$ grows with distance subject to a maximum neighbouring-size ratio. This is a conceptual
model; the exact Gmsh size-field composition is owned by
`packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py` and
`_gmsh_airbox.py`.

A useful airbox study varies:

- distance from every magnetic body to the outer boundary;
- outer closure (`dirichlet` or `robin`);
- near-body/interface resolution;
- far-field maximum size and growth rate;
- algebraic linear-solver tolerance.

Changing all five simultaneously prevents attribution of the observed error. The mesh build report
must include realized bounds, air volume, boundary attributes, size statistics, and element count.
See {doc}`airbox` and {doc}`../demag-solvers/fem-poisson-airbox`.

## Swept and thin-film meshes

For an extrudable thin body, a swept mesh creates a structured sequence of layers through thickness.
If thickness $t$ is divided into $n_z$ uniform layers,

```{math}
:label: eq-meshing-root-swept-layer
h_z=\frac{t}{n_z}.
```

A geometric distribution with ratio $r$ instead uses layer sizes
$h_{z,j}=h_{z,0}r^j$ constrained to sum to $t$. The requested layer count, distribution, sweep
direction, topology, transition elements, and realized layer coordinates must be recorded.

Prismatic or hexahedral layers can reduce element count and avoid poorly shaped tetrahedra in very
thin geometries. They are not automatically more accurate: invalid extrusion, twisted faces,
collapsed layers, or highly anisotropic in-plane elements can still degrade the operator.

Fullmag's documented public recipe includes `layers`, `topology`, `exact_layers`, `transition`, and
`order`. Construction is owned by `_gmsh_swept.py`; typed policy objects include
`SweptMeshControls` and `SweepDistribution`. Unsupported geometry must fail or use an explicitly
reported free-mesh route, not silently claim an exact swept topology. See {doc}`swept-meshes`.

## Refinement and size fields

Fullmag exposes COMSOL-style size semantics including minimum/maximum element size, maximum growth
rate, grading, curvature control, narrow-region resolution, object overrides, and interface/swept
recipes. The authoring values are targets. The realized mesh may be constrained by geometry,
conformity, transition topology, and mesher algorithms.

### $h$-, $p$-, and model refinement

- **$h$ refinement:** reduce element/cell size while keeping element order fixed;
- **$p$ refinement:** increase finite-element polynomial order at fixed geometric mesh;
- **model refinement:** enlarge the airbox, increase FDM periodic image counts, resolve thickness,
  or improve curved geometry.

These limits are independent. Reporting “mesh converged” after only one type can be misleading.

### Observed convergence

For an observable $Q_h$ and a refinement ratio $r>1$, an observed order estimate based on three
levels is

```{math}
:label: eq-meshing-root-observed-order
p_{\mathrm{obs}}
=\frac{
\log\left|\left(Q_h-Q_{h/r}\right)/
\left(Q_{h/r}-Q_{h/r^2}\right)\right|}
{\log r},
```

provided the sequence is in an asymptotic regime and the denominator is not dominated by solver,
time, or roundoff error. Nonmonotone or branch-changing observables require a different analysis.

Size-field construction is anchored in
`packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` and
`packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`. See {doc}`refinement`.

## Element-quality requirements

A production mesh report should contain more than node and element counts.

### Tetrahedra

For a mapping Jacobian $J_e$, require positive orientation

```{math}
:label: eq-meshing-root-positive-jacobian
\det J_e>0
```

at all required points. Also report a scaled Jacobian or radius-ratio metric, minimum dihedral
angle, maximum aspect ratio, and the number of elements near configured warning/rejection limits.
Near-zero positive volume can be as harmful as an inverted element.

### Prisms and hexahedra

Check Jacobian sign throughout the element, warpage, skewness, layer thickness, face orientation,
and transition conformity. A valid corner Jacobian does not guarantee a valid high-order or warped
cell everywhere.

### Interfaces and periodic pairs

Verify:

- every magnetic/nonmagnetic interface has the intended adjacent region IDs;
- external and internal boundary markers are disjoint where required;
- no duplicate coincident nodes create disconnected traces;
- periodic face pairs have one-to-one compatible topology, translation vectors, orientation, and
  phase-loop closure;
- element and boundary attributes survive extraction into the native solver mesh.

## Public authoring examples

### FDM

```python
# %% Object-owned Cartesian resolution
study = fm.study("fdm_mesh")
study.engine("fdm")
study.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 5e-9))
film = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="film")
film.mesh(cell_size=(1e-9, 1e-9, 5e-9))
```

### FEM shared domain and swept film

```python
# %% Coarse airbox, resolved magnetic film, one conforming solver mesh
study = fm.study("fem_mesh")
study.engine("fem")
study.universe(mode="manual", size=(1.2e-6, 600e-9, 550e-9))
study.universe.mesh(
    minimum_element_size=10e-9,
    maximum_element_size=110e-9,
    maximum_element_growth_rate=1.9,
    grading="geometric",
)
film = study.geometry(fm.Box(500e-9, 125e-9, 3e-9), name="film")
film.mesh.thin_film(
    minimum_element_size=3e-9,
    maximum_element_size=3e-9,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)
```

Requested controls lower into mesh intent. The native/Gmsh build and extraction produce the
authoritative realized mesh and build report.

## Provenance schema

At minimum record:

| Common | FDM-specific | FEM-specific |
|---|---|---|
| geometry and material digests | origin, counts, spacings | node/element counts by type/order |
| requested and resolved backend | active and material masks | region and boundary attributes |
| length-unit normalization | native and common-grid ownership | mesh and boundary digests |
| bounding box and magnetic volume | FFT padding and periodic axes | airbox bounds and outer markers |
| precision and generation version | per-object resampling metadata | Gmsh version/options and extraction path |
| validation status and failure reason | cell-centre convention | quality histograms and periodic-pair certificate |

For reproducibility, save or content-address the realized mesh. Re-running a mesher from only high-
level size targets can produce a different triangulation after tool-version or option changes.

## Validation programme

1. **Geometry:** compare requested and realized bounds, volume, surface area, object separation, and
   region connectivity.
2. **Topology:** reject inverted/collapsed elements, invalid FDM dimensions, duplicate interfaces,
   and incomplete periodic pairs.
3. **Attributes:** verify every solver integration domain and boundary condition receives the
   intended marker.
4. **Field-space sanity:** interpolate constants and affine fields; verify exactness expected from
   the discrete space.
5. **Operator sanity:** constant-state exchange should vanish under compatible free boundaries;
   mass/volume reductions must reproduce known integrals.
6. **Convergence:** refine the correct spatial/model parameter while maintaining tighter time and
   algebraic errors.
7. **Backend identity:** CPU/GPU comparisons consume the same serialized grid/mesh digest.
8. **Round trip:** exported scripts preserve requested controls; build reports preserve realized
   topology separately.

## Implementation source index

| Responsibility | Repository path | Stable owner |
|---|---|---|
| FDM grid schema | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` |
| Shared Gmsh assembly | `packages/fullmag-py/src/fullmag/meshing/_gmsh_infra.py` | assembly infrastructure |
| Native extraction | `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | mesh extraction |
| Airbox geometry | `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py` | airbox construction |
| Airbox grading | `packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py` | graded size policy |
| Swept topology | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | swept construction |
| Swept public controls | `packages/fullmag-py/src/fullmag/model/discretization.py` | `SweptMeshControls`, `SweepDistribution` |
| Size-field composition | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | size-field plan |
| Mesh control types | `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py` | mesh-control validation |

## Limitations

- Cartesian FDM stair-steps curved boundaries and does not reproduce an arbitrary FEM geometry
  exactly.
- High-order FEM fields do not remove low-order geometry error automatically.
- Airbox grading does not replace airbox-extent and boundary-condition convergence.
- Swept meshing is geometry-dependent and can require explicit transition elements or rejection.
- Authoring targets do not prove the realized minimum/maximum size or quality distribution.
- This documentation does not claim automatic a posteriori error estimation or production adaptive
  remeshing unless a terminal workflow explicitly qualifies it.
- A mesh that renders correctly can still have invalid topology, attributes, or periodic algebra.

## Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh: A three-dimensional finite element mesh generator with
   built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in
   Engineering* **79**, 1309--1331 (2009),
   [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
2. R. Anderson et al., “MFEM: A modular finite element methods library,” *Computers & Mathematics
   with Applications* **81**, 42--74 (2021),
   [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).
3. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
4. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for
   nonuniform magnetization,” *Journal of Geophysical Research* **98**, 9551--9555 (1993),
   [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).

```{toctree}
:maxdepth: 1

fdm-grids
fem-shared-domain
airbox
swept-meshes
refinement
```
