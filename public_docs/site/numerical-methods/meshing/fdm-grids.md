---
title: FDM Grids
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: 88c7160080bc1e8519950df283d2dd02087cc3da
source_of_truth: fullmag.model.discretization FDM/FDMGrid/FDMDemag schemas and resolved FDM runtime provenance
---

(public-docs-numerical-methods-meshing-fdm-grids)=
# FDM Cartesian grids

:::{admonition} A cell size is an operator parameter
:class: important

Changing an FDM cell size changes the sampled geometry, cell volume, exchange/DMI stencils,
material interfaces, demagnetization tensor, FFT dimensions, stability limit, and discrete energy.
It is not a visualization-resolution setting. Requested cell sizes and the realized integer grid
must both be preserved.
:::

(numerical-methods-fdm-grids-problem-statement)=
## Discrete state and coordinate convention

Fullmag represents each native FDM magnetization field on a cell-centred Cartesian tensor grid. For
origin $\mathbf x_0$, integer indices $(i,j,k)$, and spacings $(h_x,h_y,h_z)$,

```{math}
:label: eq-numerical-fdm-grid-centre
\mathbf x_{ijk}
=\mathbf x_0+
\left((i+\tfrac12)h_x,(j+\tfrac12)h_y,(k+\tfrac12)h_z\right).
```

The cell volume and total rectangular allocation are

```{math}
:label: eq-numerical-fdm-grid-volume
V_{\mathrm{cell}}=h_xh_yh_z,
\qquad
N=N_xN_yN_z.
```

The rectangular allocation is not necessarily the magnetic domain. An active/material mask selects
cells occupied by each magnetic object, and optional boundary fractions represent partially filled
cells. Consequently, production provenance distinguishes:

- allocation bounds and integer dimensions;
- cell-centre origin and spacings;
- active and material masks;
- magnetic volume implied by the selected boundary policy;
- memory/component ordering;
- periodic and convolution-padding metadata.

(numerical-methods-fdm-grid-geometry-sampling)=
## Geometry sampling and staircase error

A geometry indicator $\mathbf 1_{\Omega_m}(\mathbf x)$ may be sampled at cell centres for a binary
mask. The corresponding discrete magnetic volume is

```{math}
:label: eq-numerical-fdm-grid-binary-volume
V_{m,h}=V_{\mathrm{cell}}
\sum_{i,j,k}\chi_{ijk},
\qquad
\chi_{ijk}\in\{0,1\}.
```

With a volume fraction $\phi_{ijk}\in[0,1]$,

```{math}
:label: eq-numerical-fdm-grid-fractional-volume
V_{m,h}=V_{\mathrm{cell}}
\sum_{i,j,k}\phi_{ijk}.
```

Binary masks staircase curved or oblique boundaries. This changes volume, surface normal,
exchange connectivity, interfacial DMI, and magnetostatic surface charge. A cell-refinement study
should therefore report both the nominal spacing and the realized magnetic volume. Rotating the
same curved body relative to the grid is a useful diagnostic for discretization anisotropy.

The public `FDM.boundary_correction` vocabulary is:

| Value | Public intent | Additional parameters |
|---|---|---|
| `none` | ordinary binary/uncorrected boundary treatment | none |
| `volume` | T0 volume-fraction correction | `boundary_phi_floor` may limit very small active fractions |
| `full` | T1 full embedded/cut-boundary correction | `boundary_phi_floor` and optional `boundary_delta_min` stabilize the corrected stencil |

This vocabulary records requested intent. The resolved runtime must report whether the selected
interactions and device lane actually used the requested correction. A source-visible field in the
Python schema is not proof that every interaction kernel implements it.

`boundary_phi_floor` is validated in $(0,1)`. `boundary_delta_min` is a nonnegative SI length. The
latter is not a dimensionless tuning coefficient and must be compared with the minimum native cell
spacing.

(numerical-methods-fdm-grid-native-and-common)=
## Native object grids and the demagnetization communication grid

Fullmag permits a default native cell size and per-magnet overrides. For magnet $r$,

```{math}
:label: eq-numerical-fdm-grid-per-magnet
\mathcal G_r
=\left(\mathbf x_{0,r},\mathbf N_r,\mathbf h_r,\chi_r\right).
```

Local interactions act on the magnet's native state. A multilayer demagnetization solver may also
introduce a common convolution grid $\mathcal G_c$. This common grid is a numerical communication
space for the nonlocal field; it is not ownership of the physical state and must not silently
replace $\mathcal G_r$.

A generic transfer can be written

```{math}
:label: eq-numerical-fdm-grid-common-transfer
\mathbf M_c=\mathcal P_{r\to c}\mathbf M_r,
\qquad
\mathbf H_r=\mathcal R_{c\to r}\mathbf H_c,
```

where $\mathcal P$ and $\mathcal R$ are explicitly defined prolongation/restriction operators. Their
normalization, masks, cell volumes, and adjoint/energy properties belong to the multilayer-demag
contract. Grid declaration alone does not establish conservative transfer.

The `FDMDemag` public policy separates:

| Field | Values | Meaning |
|---|---|---|
| `strategy` | `auto`, `single_grid`, `multilayer_convolution` | whether all magnets share one state/convolution grid or communicate through a multilayer path |
| `mode` | `auto`, `two_d_stack`, `three_d` | common in-plane stack model or full 3D common convolution |
| `common_cells` | positive integer triple | explicit 3D common-grid dimensions |
| `common_cells_xy` | positive integer pair | explicit in-plane dimensions for `two_d_stack` |
| `common_cell_size` | positive SI length triple | target common-grid spacing instead of counts |
| `explain` | Boolean | request a human-readable plan; not a numerical parameter |

`common_cells`, `common_cells_xy`, and `common_cell_size` are mutually constrained. An explicit
common cell size cannot be combined with explicit counts. `common_cells_xy` is legal only for
`auto` or `two_d_stack`; `common_cells` is rejected with `two_d_stack`.

The former `allow_single_grid_fallback` input is explicitly rejected. A requested multilayer
convolution cannot silently become a single-grid solve.

(numerical-methods-fdm-grid-stencils)=
## Local finite-difference operators

For a smooth scalar component $u$ on a uniform interior grid, the centred first and second
derivatives are

```{math}
:label: eq-numerical-fdm-grid-central-first
\left.\partial_xu\right|_{i,j,k}
\approx\frac{u_{i+1,j,k}-u_{i-1,j,k}}{2h_x},
```

```{math}
:label: eq-numerical-fdm-grid-central-second
\left.\partial_{xx}u\right|_{i,j,k}
\approx\frac{u_{i+1,j,k}-2u_{i,j,k}+u_{i-1,j,k}}{h_x^2}.
```

The complete exchange, DMI, and boundary stencils are interaction-owned; these equations illustrate
why grid spacing enters the operator. At material boundaries, active-mask boundaries, PBC seams,
and cut cells, the interior formula is replaced by the interaction's declared boundary realization.
A documentation page for the grid must not invent a universal ghost-cell policy.

The largest exchange eigenvalues scale approximately as $h_{\min}^{-2}$, so refining the grid also
reduces the stable step size of explicit LLG integrators. Spatial and temporal convergence must be
studied independently.

(numerical-methods-fdm-grid-demag)=
## Demagnetization grid and FFT embedding

The FDM demagnetizing field uses a cell-averaged Newell tensor whose geometry depends on
$(h_x,h_y,h_z)$. For an open boundary, the tensor convolution is embedded in a sufficiently padded
FFT grid. The following are distinct dimensions:

- native state dimensions $N_x\times N_y\times N_z$;
- magnetic active-mask extent;
- padded open-convolution dimensions;
- periodic-image or periodic-lattice dimensions;
- optional multilayer common-grid dimensions.

All must enter cache identity. Reusing a kernel spectrum after changing cell size, padding,
periodicity, common grid, or precision is invalid. See {doc}`../demag-solvers/fdm-convolution` and
{doc}`../demag-solvers/periodic-demag`.

(numerical-methods-fdm-grid-thin-films)=
## Thin-film resolution

A one-cell-thick FDM film stores one thickness-averaged magnetization vector per in-plane cell. It
can be appropriate when the state is demonstrably uniform through thickness for the target
observable. It does not resolve:

- perpendicular standing spin-wave profiles;
- asymmetric surface anisotropy or surface DMI across thickness;
- strongly nonuniform thickness-dependent demagnetizing fields;
- depth-dependent current/torque or material layers;
- a vortex core or domain wall whose three-dimensional structure varies across the film.

A thickness study increases $N_z$ while preserving the physical thickness and refining time-step
control. Comparing one and two layers alone is rarely enough to establish an asymptotic trend.

(numerical-methods-fdm-grids-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf x_{ijk}$ | cell centre | $\mathrm m$ |
| $\mathbf x_0$ | cell-boundary origin | $\mathrm m$ |
| $h_x,h_y,h_z$ | native cell spacings | $\mathrm m$ |
| $N_x,N_y,N_z$ | rectangular cell counts | $1$ |
| $V_{\mathrm{cell}}$ | cell volume | $\mathrm{m^3}$ |
| $\chi_{ijk}$ | binary active/material mask | $1$ |
| $\phi_{ijk}$ | magnetic volume fraction | $1$ |
| $\mathcal G_r$ | native grid of magnet $r$ | $1$ |
| $\mathcal G_c$ | common convolution grid | $1$ |
| $\mathcal P,\mathcal R$ | grid-transfer operators | implementation-dependent |

(numerical-methods-fdm-grids-python-api)=
## Python API

### Normal stage-first authoring

```python
# %% Default grid plus a finer native grid for one object
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_grid_contract")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(4 * nm, 4 * nm, 1 * nm))

free = study.geometry(fm.Box(200 * nm, 80 * nm, 1 * nm), name="free")
free.mesh(cell_size=(2 * nm, 2 * nm, 1 * nm))
free.Ms = 800.0e3
free.Aex = 13.0e-12
free.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.stages.add_relax(
    stage_id="grid_contract",
    algorithm="projected_gradient_bb",
    max_steps=100,
    tolT=1.0e-6,
)
```

### Explicit discretization schema

```python
# %% Typed native-grid and multilayer-demag policy
fdm = fm.FDM(
    default_cell=(4 * nm, 4 * nm, 1 * nm),
    per_magnet={
        "free": fm.FDMGrid(cell=(2 * nm, 2 * nm, 1 * nm)),
        "reference": fm.FDMGrid(cell=(4 * nm, 4 * nm, 1 * nm)),
    },
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="two_d_stack",
        common_cells_xy=(512, 512),
        explain=True,
    ),
    boundary_correction="volume",
    boundary_phi_floor=0.05,
)
```

### Public schema

| Python field | Default | Validation | Meaning | IR |
|---|---:|---|---|---|
| `FDMGrid.cell` | required | exactly three finite positive SI lengths | one magnet's native spacing | `per_magnet.<name>.cell` |
| `FDM.default_cell` | `None` | exactly three finite positive SI lengths | inherited native spacing | `fdm.default_cell` and compatibility `fdm.cell` |
| `FDM.per_magnet` | `None` | nonempty string keys, `FDMGrid` values | object-specific native grids | `fdm.per_magnet` |
| `FDM.demag` | `None` | `FDMDemag` | nonlocal common-grid policy | `fdm.demag` |
| `FDM.boundary_correction` | `None` | `none`, `volume`, or `full` | requested boundary correction | `fdm.boundary_correction` |
| `FDM.boundary_phi_floor` | `None` | strictly between zero and one | minimum usable fraction | `fdm.boundary_phi_floor` |
| `FDM.boundary_delta_min` | `None` | nonnegative SI length | lower geometric distance for full correction | `fdm.boundary_delta_min` |
| `FDMDemag.strategy` | `auto` | supported enum | single/native versus multilayer path | `fdm.demag.strategy` |
| `FDMDemag.mode` | `auto` | supported enum | 2D stack or full 3D | `fdm.demag.mode` |
| `FDMDemag.common_cells` | `None` | positive integer triple | explicit 3D common dimensions | `fdm.demag.common_cells` |
| `FDMDemag.common_cells_xy` | `None` | positive integer pair | explicit common in-plane dimensions | `fdm.demag.common_cells_xy` |
| `FDMDemag.common_cell_size` | `None` | positive SI length triple | requested common spacing | `fdm.demag.common_cell_size` |

At least one of `default_cell`/legacy `cell` or `per_magnet` is required. Supplying both legacy
`cell` and `default_cell` is rejected.

(numerical-methods-fdm-grids-problem-ir)=
## ProblemIR and execution provenance

The authoring schema stores requested intent. The planner/runtime must add the realized grid:

- object name and native-grid owner;
- origin, dimensions, spacing, physical and padded bounds;
- allocation ordering and component layout;
- active/material mask and optional volume/face-fraction digests;
- realized magnetic cell count and volume;
- boundary-correction variant and supported interaction matrix;
- common-grid dimensions/spacing and native/common transfer policy;
- FFT padding, periodic axes, image counts, and kernel-spectrum digest;
- requested/resolved CPU/GPU lane and precision;
- rejected/fallback status and exact reason.

A content hash should include floating-point cell sizes in a canonical SI representation, not a
rounded display string.

(numerical-methods-fdm-grids-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Script export preserves default and per-magnet cell sizes, multilayer strategy, common-grid request,
and boundary-correction parameters. Validation errors include:

- nonpositive/nonfinite spacing;
- missing all native-grid specifications;
- empty object names or non-`FDMGrid` overrides;
- conflicting common-grid counts and spacing;
- `common_cells_xy` with `three_d`;
- `common_cells` with `two_d_stack`;
- invalid boundary-fraction/distance values;
- incompatible object extents or unresolved native/common-grid mapping;
- unsupported interaction/device/boundary-correction combination.

The planner must not round an incompatible geometry, resample a native state, discard a per-object
override, or use the removed single-grid fallback without an explicit resolved plan and provenance.

(numerical-methods-fdm-grids-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | source-backed | cell-centred native grids, masks, CPU operators, CPU FFT plan |
| FDM | GPU | source-backed with capability gates | same semantic grid with device arrays and lane-specific kernels |
| FEM | CPU | not applicable | use the conforming FEM shared-domain mesh |
| FEM | GPU | not applicable | use the conforming FEM shared-domain mesh |

Semantic grid identity must be equal before CPU/GPU physics is compared. Different padding,
precision, active masks, or common-grid transfer invalidates a parity claim.

(numerical-methods-fdm-grids-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Per-magnet native spacing | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` |
| Complete FDM intent and boundary correction | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` |
| Multilayer/common-grid policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` |
| Newell cell tensor | `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels` |
| Open/periodic kernel spectra | `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_newell_kernel_spectra`, `compute_periodic_newell_kernel_spectra` |
| Cross-backend Cartesian metadata consumer | `crates/fullmag-engine/src/fem_solution_transfer.rs` | `transfer_vector_field` |

Interaction pages own their stencils and boundary equations. This page owns grid coordinates,
ownership, sampling, and provenance.

(numerical-methods-fdm-grids-validation)=
## Verification and convergence

1. **Coordinate reconstruction:** verify first/last cell centres and allocation bounds analytically.
2. **Volume:** compare binary/fractional discrete volume with analytical geometry under refinement.
3. **Constant field:** local derivative operators vanish under compatible free/periodic boundaries.
4. **Affine/quadratic fields:** verify formal interior stencil order independently of masks.
5. **Mask invariance:** object translation by an integer number of cells produces translated masks
   and observables.
6. **Rotation sensitivity:** quantify staircase anisotropy for oblique/curved bodies.
7. **Demag identity:** kernel spectrum cache changes whenever grid geometry or boundary policy changes.
8. **Native/common transfer:** constant-field preservation, coverage, volume weighting, and transfer
   counters for every magnet.
9. **Thickness refinement:** converge observables with increasing $N_z$ where thickness variation is
   physically relevant.
10. **CPU/GPU parity:** identical serialized grid/mask/kernel digests, then compare fields, energy,
    torque, and accepted-step observables.
11. **Coupled convergence:** refine space while separately tightening time-step and algebraic
    tolerances.

Useful observables include total energy, maximum torque, switching time, resonance frequency,
magnetic volume, demagnetizing-field norm, and topological charge. A visually smooth texture is not
a convergence criterion.

(numerical-methods-fdm-grids-limitations)=
## Limitations

- Cartesian grids staircase arbitrary curved boundaries unless an explicitly qualified cut-cell
  correction is used.
- Per-magnet native grids require a separately validated nonlocal transfer for coupled demag.
- A one-cell film is thickness-averaged, not three-dimensionally resolved.
- Uniform-grid refinement can become memory- and explicit-time-step limited.
- Public boundary-correction fields do not prove universal kernel coverage.
- Grid declaration does not guarantee a conservative native/common transfer.
- Requested cell sizes do not by themselves identify integer dimensions, masks, FFT padding, or the
  realized physical volume.

(numerical-methods-fdm-grids-scientific-bibliography)=
## Scientific bibliography

1. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for
   nonuniform magnetization,” *Journal of Geophysical Research* **98**, 9551--9555 (1993),
   [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
2. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(numerical-methods-fdm-grids-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Native grid validation | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDMGrid.__init__` | positive SI cell triple | Python source/tests |
| FDM policy validation | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDM.__init__` | defaults, overrides, boundary parameters | Python source/tests |
| Common-grid legality | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDMDemag.__post_init__` | strategy/mode/count constraints and removed fallback | Python source/tests |
| IR lowering | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDM.to_ir`, `FDMDemag.to_ir` | canonical request | ownership/round-trip tests |
