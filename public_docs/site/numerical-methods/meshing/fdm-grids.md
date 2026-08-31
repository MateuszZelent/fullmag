---
title: "FDM Cartesian grids"
description: "Scientific, authoring, ProblemIR, and execution contract for Cartesian finite-difference grids in Fullmag."
summary: "FDM grids sample each magnetic body on a regular Cartesian lattice and can transfer native-grid fields through a planner-resolved common convolution grid."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 88c7160080bc1e8519950df283d2dd02087cc3da
source_of_truth: "FDMGrid, FDM, and FDMDemag Python schemas; FdmHintsIR and FdmDemagHintsIR; FDM planner and runtime"
---

(public-docs-numerical-methods-meshing-fdm-grids)=
# FDM Cartesian grids

FDM represents magnetization on cell-centred Cartesian grids. A body can inherit the study default
cell size or own a native grid. Multi-body demagnetization can additionally use a common convolution
grid selected by the planner; that grid does not replace the native body grids.

::::{admonition} Implementation status
:class: important

Single-grid FDM is available on CPU and on capability-gated GPU routes. Public multi-body execution
uses `multilayer_convolution`; requesting `single_grid` for more than one magnetic body fails closed.
Backend eligibility is established by planning, not by the authored strategy name alone.
::::

(fdm-grids-problem-statement)=
## Physical problem

Let a magnetic region occupy a bounded subset of a rectangular Cartesian universe. Fullmag stores
one magnetization vector per active FDM cell. The rectangular allocation also contains inactive
cells outside the magnetic support. Geometry voxelization determines the active/material mask and,
when boundary correction is requested and supported, a magnetic volume fraction.

The cell spacing controls geometry occupancy, local finite-difference operators, FFT demagnetization
kernels, allocation size, and the shortest represented wavelength. It must resolve the smallest
relevant geometric and magnetic length scales. A one-cell film thickness is a thickness-averaged
model and cannot resolve a nonuniform thickness mode.

(fdm-grids-governing-equations)=
## Governing grid equations

For cell-boundary origin $\mathbf x_0$, native spacings $(h_x,h_y,h_z)$, and zero-based indices,

```{math}
:label: eq-numerical-fdm-grid-centre
\mathbf x_{ijk}=\mathbf x_0+
\left(\left(i+\tfrac12\right)h_x,
      \left(j+\tfrac12\right)h_y,
      \left(k+\tfrac12\right)h_z\right).
```

The rectangular allocation has cell volume and count

```{math}
:label: eq-numerical-fdm-grid-volume
V_{\mathrm{cell}}=h_xh_yh_z,
\qquad N=N_xN_yN_z.
```

With a binary active/material mask, the following is the documentary volume identity derived from
the resolved mask and spacing:

```{math}
:label: eq-numerical-fdm-grid-binary-volume
V_{m,h}=V_{\mathrm{cell}}
\sum_{i=0}^{N_x-1}\sum_{j=0}^{N_y-1}\sum_{k=0}^{N_z-1}\chi_{ijk}.
```

If a supported boundary-correction route supplies cell fractions, the corresponding documentary
volume identity is

```{math}
:label: eq-numerical-fdm-grid-fractional-volume
V_{m,h}=V_{\mathrm{cell}}
\sum_{i=0}^{N_x-1}\sum_{j=0}^{N_y-1}\sum_{k=0}^{N_z-1}\phi_{ijk}.
```

The native grid of magnetic body $r$ is the implementation tuple

```{math}
:label: eq-numerical-fdm-grid-per-magnet
\mathcal G_r=\left(\mathbf x_{0,r},(N_{x,r},N_{y,r},N_{z,r}),
(h_{x,r},h_{y,r},h_{z,r}),\chi^{(r)}\right).
```

For multilayer convolution, source and target identities must remain distinct. For every source
layer $s$, the CPU runtime pushes magnetization to that layer's common transform layout and performs
one forward FFT. For every ordered pair $(r,s)$, a destination/source binding selects the pair tensor
from the kernel catalog and accumulates into target $r$. Finally, each target is negated, inverse
transformed, cropped, and pulled to its native grid:

```{math}
:label: eq-numerical-fdm-grid-common-transfer
\widehat{\mathbf M}_{c,s}
  =\mathcal F_c\!\left[\mathcal P_s\mathbf M_s\right],
\qquad
\widehat{\mathbf H}_{c,r}
  =-\sum_s\widehat{\mathbf N}_{rs}\widehat{\mathbf M}_{c,s},
\qquad
\mathbf H_r
  =\mathcal R_r\mathcal F_c^{-1}\!\left[\widehat{\mathbf H}_{c,r}\right].
```

Local interaction pages own exact field stencils and boundary equations. On an interior uniform axis,

```{math}
:label: eq-numerical-fdm-grid-central-first
\left.\frac{\partial u}{\partial x}\right|_i
=\frac{u_{i+1}-u_{i-1}}{2h_x}+\mathcal O(h_x^2),
```

```{math}
:label: eq-numerical-fdm-grid-central-second
\left.\frac{\partial^2u}{\partial x^2}\right|_i
=\frac{u_{i+1}-2u_i+u_{i-1}}{h_x^2}+\mathcal O(h_x^2).
```

Here $\widehat{\mathbf N}_{rs}$ is selected by the ordered binding with `dst_layer = r` and
`src_layer = s`. Catalog deduplication may let several ordered bindings reuse one stored tensor, but
it does not merge source magnetizations or target accumulators. For $L$ layers, one refresh performs
$L$ forward FFTs, $L^2$ ordered-pair accumulations, and $L$ inverse FFTs when all pairs are present.

The first-derivative formula is realized for interior active neighbours by
`multilayer_dmi_field_kernel`; missing/inactive neighbours are clamped to the centre and DMI boundary
corrections are applied separately. The second-derivative formula is the uniform-material fast path
of `exchange_field_fp64_kernel`; its general path uses per-neighbour exchange coefficients, active
masks, and periodic wrap or clamped Neumann neighbours. The displayed formulas therefore do not
define cut-cell, interface, or boundary treatment.

(fdm-grids-symbols-and-si-units)=
## Symbols and SI units

| ID | Symbol | Meaning | SI unit |
| --- | --- | --- | --- |
| `x` | $\mathbf x_{ijk}$ | cell centre | $\mathrm{m}$ |
| `x0` | $\mathbf x_0$ | cell-boundary origin | $\mathrm{m}$ |
| `h` | $h_x,h_y,h_z$ | native cell spacings | $\mathrm{m}$ |
| `Vcell` | $V_{\mathrm{cell}}$ | cell volume | $\mathrm{m^3}$ |
| `Vmh` | $V_{m,h}$ | discrete magnetic volume | $\mathrm{m^3}$ |
| `Nxyz` | $N_x,N_y,N_z$ | cell counts | $1$ |
| `N` | $N$ | total rectangular allocation | $1$ |
| `chi` | $\chi_{ijk}$ | binary active/material mask | $1$ |
| `phi` | $\phi_{ijk}$ | magnetic volume fraction | $1$ |
| `Gr` | $\mathcal G_r$ | native grid owned by magnet r | $1$ |
| `Mc` | $\widehat{\mathbf M}_{c,s}$ | source-layer magnetization spectrum on the common transform grid | $\mathrm{A\,m^{-1}}$ |
| `Mr` | $\mathbf M_s$ | magnetization on native source grid s | $\mathrm{A\,m^{-1}}$ |
| `Hc` | $\widehat{\mathbf H}_{c,r}$ | accumulated target-layer field spectrum on the common transform grid | $\mathrm{A\,m^{-1}}$ |
| `Hr` | $\mathbf H_r$ | field restricted to native target grid r | $\mathrm{A\,m^{-1}}$ |
| `P` | $\mathcal P_s$ | source push and insertion into its common transform layout | implementation-dependent |
| `R` | $\mathcal R_r$ | target crop and pull to its native grid | implementation-dependent |
| `F` | $\mathcal F_c$ | common-layout discrete Fourier transform | $1$ |
| `Nrs` | $\widehat{\mathbf N}_{rs}$ | FFT-domain demag tensor for ordered target/source pair $(r,s)$ | $1$ |
| `r` | $r$ | target-layer index | $1$ |
| `s` | $s$ | source-layer index | $1$ |
| `u` | $u$ | generic grid scalar component | quantity-dependent |

(fdm-grids-assumptions-and-validity)=
## Assumptions and validity

- Spacings are finite, strictly positive SI lengths; grids are axis-aligned and Cartesian.
- Cell counts are positive integers resolved from geometry, spacing, and planner policy.
- Geometry smaller than a cell can disappear or change occupancy under a sub-cell translation.
- A demag kernel is tied to grid shape, spacing, boundary policy, and precision.
- `common_cells`, `common_cells_xy`, and `common_cell_size` are alternative common-grid requests,
  not native-grid cell sizes.
- Grid refinement establishes adequacy for the reported observable.
- The centre and volume equations are grid definitions. `resolved_fdm_cell_centers` implements the
  centre coordinates; `FdmPlanIR` carries the resolved shape, spacing, masks, and origin from which
  the volume identities are derived. `FDMGrid` itself validates spacing only.
- `compute_boundary_geometry` realizes $\phi_{ijk}$ by fixed $4^3$ SDF sub-sampling per cell for the
  boundary-correction geometry route; the volume sum is a documented derived quantity, not a claim
  that every backend computes a standalone `V_mh` scalar.

(fdm-grids-python-api)=
## Python API

### Complete canonical example

The ordinary public route is mesh-owned. This example uses a default native spacing, one body
override, and a common convolution spacing required by unequal native grids.

```python
# %% Imports and study
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_grid_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
study.universe.mesh(cell_size=(1 * nm, 1 * nm, 1 * nm))

# %% Magnetic bodies and native grids
bottom = study.geometry(
    fm.Box(size=(80 * nm, 40 * nm, 2 * nm)).translate((0.0, 0.0, -2 * nm)),
    name="bottom",
)
top = study.geometry(
    fm.Box(size=(80 * nm, 40 * nm, 2 * nm)).translate((0.0, 0.0, 2 * nm)),
    name="top",
)
top.mesh(cell_size=(4 * nm, 4 * nm, 2 * nm))

# %% Materials and initial state
for body in (bottom, top):
    body.Ms = 800.0e3
    body.Aex = 13.0e-12
    body.alpha = 0.02
    body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %% Physics and stage
study.exchange()
study.demag()
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="llg_overdamped",
    dt=1.0e-13,
    tolA=1.0e-4,
    max_steps=5_000,
)
```

`study.fdm(...)` and `fm.fdm(...)` remain callable for explicit `FDM`/`FDMDemag` policy, but emit
`DeprecationWarning` for ordinary grid authoring. Prefer `body.mesh(cell_size=...)`,
`study.objects.mesh.defaults(cell_size=...)`, `study.universe.mesh(cell_size=...)`, and
`study.demag()`. The advanced policy route remains necessary for explicit common counts, FFT backend,
or boundary floor/distance fields that have no canonical mesh call.

### Exhaustive grid and demag parameter contract

| Python field | Type | Default | SI unit | Validation | Meaning | Backend support | Python-to-ProblemIR mapping |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FDMGrid.cell` | `tuple[float,float,float]` | required | $\mathrm{m}$ | exactly three finite positive values | per-magnet native spacing | FDM CPU; GPU capability-gated | `backend_policy.discretization_hints.fdm.per_magnet.<name>.cell` |
| `FDM.cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | legacy input is exclusive with default_cell; three finite positive values when set | legacy constructor input and read-only alias of default_cell | FDM CPU/GPU compatibility surface | both `.fdm.cell` and `.fdm.default_cell` |
| `FDM.default_cell` | `tuple[float,float,float] \| None` | `None` | $\mathrm{m}$ | exactly three finite positive values; default_cell or per_magnet is required | default native spacing | FDM CPU/GPU | both `.fdm.default_cell` and compatibility `.fdm.cell` |
| `FDM.per_magnet` | `dict[str,FDMGrid] \| None` | `None` | $1$ | nonblank string keys and FDMGrid values; default_cell or per_magnet is required | object-owned native grids | FDM CPU; multi-body GPU capability-gated | `.fdm.per_magnet` |
| `FDM.demag` | `FDMDemag \| None` | `None` | $1$ | expected FDMDemag when set; FDM has no explicit runtime isinstance check | nested demag authoring policy | FDM | `.fdm.demag`, omitted for None |
| `FDM.boundary_correction` | `str \| None` | `None` | $1$ | none, volume, or full | requested boundary correction | interaction/device gated; multilayer accepts None or none | `.fdm.boundary_correction`, omitted for None |
| `FDM.boundary_phi_floor` | `float \| None` | `None` | $1$ | strictly in (0,1) | requested minimum boundary volume fraction | boundary-correction gated; current multilayer unsupported | `.fdm.boundary_phi_floor`, omitted for None |
| `FDM.boundary_delta_min` | `float \| None` | `None` | $\mathrm{m}$ | Direct FDM rejects only values < 0: NaN and +Inf pass; Scene/script requires a finite number; FdmHintsIR does not revalidate; the single-grid planner forwards the value | requested minimum geometric distance | boundary-correction gated; current multilayer unsupported | `.fdm.boundary_delta_min`, omitted for None |
| `FDM.projection_policy` | `str \| None` | `None` | $1$ | None or unit_sphere | projected-RK state constraint request | FDM time-integrator policy | `.fdm.projection_policy`, omitted for None |
| `FDMDemag.strategy` | `str` | `auto` | $1$ | auto, single_grid, or multilayer_convolution | nonlocal grid strategy | FDM; multi-body single_grid unsupported | `.fdm.demag.strategy` |
| `FDMDemag.mode` | `str` | `auto` | $1$ | auto, two_d_stack, or three_d | common-grid dimensionality | FDM multilayer | `.fdm.demag.mode` |
| `FDMDemag.common_cells` | `tuple[int,int,int] \| None` | `None` | $1$ | positive triple; auto or three_d; exclusive with other common-grid forms | explicit 3D common-grid dimensions | FDM multilayer | `.fdm.demag.common_cells`, omitted for None |
| `FDMDemag.common_cells_xy` | `tuple[int,int] \| None` | `None` | $1$ | positive pair; auto or two_d_stack; exclusive with other common-grid forms | explicit in-plane dimensions | FDM multilayer | `.fdm.demag.common_cells_xy`, omitted for None |
| `FDMDemag.common_cell_size` | `tuple[float,float,float] \| None` | `None` | $\mathrm{m}$ | Python: positive finite triple and exclusive with counts; ProblemIR also rejects explicit two_d_stack | requested common spacing | FDM multilayer | `.fdm.demag.common_cell_size`, omitted for None |
| `FDMDemag.fft_backend` | `str` | `auto` | $1$ | auto, rustfft, fftw, mkl, or cufft | requested FFT realization | demag/device gated; no silent fallback | `.fdm.demag.fft_backend` |
| `FDMDemag.explain` | `bool` | `True` | $1$ | direct construction does not type-check; Scene/script overrides require Boolean | human-readable plan explanation request | authoring and Scene/script round-trip only | not serialized into ProblemIR |
| `FDMDemag.allow_single_grid_fallback` | `bool \| None` | `None` | $1$ | every non-None value is rejected as a removed option | compatibility-only rejected input | unsupported | no ProblemIR mapping; rejected before lowering |
| `body.mesh(cell_size=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three finite positive values; exclusive with FEM mesh controls | canonical per-body native spacing | FDM CPU; GPU capability-gated | `.fdm.per_magnet.<canonical-name>.cell` |
| `study.objects.mesh.defaults(cell_size=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three finite positive values; exclusive with FEM mesh controls | canonical default native spacing | FDM CPU/GPU | both `.fdm.default_cell` and compatibility `.fdm.cell` |
| `study.universe.mesh(cell_size=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three finite positive values; exclusive with FEM universe controls | canonical common convolution spacing | FDM multilayer | creates `.fdm.demag` with auto strategy/mode/fft_backend and `.common_cell_size` |

The canonical paths do not merely alias one another. `body.mesh` records a named override;
`study.objects.mesh.defaults` records the inherited default; and `study.universe.mesh` constructs an
`FDMDemag(common_cell_size=...)` request. During Problem construction, every magnetic body must have
an override or default, and unequal effective native spacings require the universe common spacing.
The `FDM` constructor's legacy `cell=` input and `cell` property both resolve to `default_cell`.

(fdm-grids-problem-ir)=
## ProblemIR contract

Authored intent is stored at `backend_policy.discretization_hints.fdm`:

```json
{
  "cell": [2e-9, 2e-9, 2e-9],
  "default_cell": [2e-9, 2e-9, 2e-9],
  "per_magnet": {"top": {"cell": [4e-9, 4e-9, 2e-9]}},
  "demag": {
    "strategy": "auto",
    "mode": "auto",
    "fft_backend": "auto",
    "common_cell_size": [1e-9, 1e-9, 1e-9]
  }
}
```

`cell` is a compatibility mirror of `default_cell`; Python emits both when a default exists.
Optional fields are omitted when unset. `projection_policy` is emitted when requested.
`FDMDemag.explain` is deliberately absent, while `allow_single_grid_fallback` cannot reach lowering
because every non-`None` value is rejected. Canonical `body.mesh` lowers by canonical magnet name to
`per_magnet.<name>.cell`; `study.objects.mesh.defaults` lowers to both default/compatibility cell
fields; `study.universe.mesh` creates a demag object with `strategy="auto"`, `mode="auto"`,
`fft_backend="auto"`, and the authored `common_cell_size`.

ProblemIR records requested intent, not execution. Single-grid planning resolves `FdmPlanIR`.
Multilayer planning resolves `FdmMultilayerPlanIR` with common counts, per-layer native grid, spacing,
origin, masks, convolution descriptors, transfer kind, grid certificate, and `planner_summary`.
The summary preserves `requested_strategy`/`requested_mode` separately from
`selected_strategy`/`resolved_mode`.

(fdm-grids-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

### Requested intent

Python `to_ir()` preserves known grid and demag values. `auto` remains authored intent until planning.
Scene/script export additionally retains `FDMDemag.explain`.

### Resolved execution

The planner selects grid counts, origins, transfers, precision policy, and the certificate. ``plan_fdm_fft`` only validates FFT-request compatibility and stores ``requested_backend``; concrete FFT ``resolved_backend`` and ``executed_backend`` values belong to runtime receipts.
Runtime consumes the resolved plan. `common_cell_size` remains recorded as
`requested_common_cell_size` while resolved `common_cells` and layer descriptors are authoritative.

### Validation errors

Validation is layered and the boundaries are intentional:

- Direct Python `FDMGrid`/`FDM` construction validates vector shape/positivity, the legacy
  `cell`/`default_cell` conflict, per-magnet names and values, projection token, boundary fields, and
  the requirement for a default or per-magnet grid. `FDM.demag` is type-annotated but `FDM` does not
  perform an explicit `isinstance` check.
- Direct `FDMDemag` construction validates strategy, mode, FFT token, positive integer counts,
  positive `common_cell_size`, count conflicts, and count/mode combinations. It does not runtime-check
  that `explain` is Boolean. It also permits `common_cell_size` with explicit `mode="two_d_stack"`,
  so successful Python construction is not proof of valid ProblemIR.
- Scene/script override parsing additionally requires `fdm.demag.explain` to be Boolean and validates
  input container/number shapes before constructing the Python policy.
- ProblemIR deserialization denies unknown demag fields and `FdmDemagHintsIR.validate` rechecks
  strategy, mode, FFT backend, positivity, and mutual exclusion. It additionally rejects
  `common_cell_size` with explicit `mode="two_d_stack"`.
- Canonical mesh calls validate a finite positive three-vector and reject mixing `cell_size` with FEM
  mesh controls. Problem construction rejects missing body spacing and unequal native spacings
  without `study.universe.mesh(cell_size=...)`.
- Planning rejects nonrepresentable/capability-ineligible intent before runtime allocation. The
  checked CPU multilayer runtime then verifies descriptor counts, field/mask lengths, scratch grids,
  identity-transfer extents, and ordered pair/catalog indices.

### Unsupported combinations

- Multi-body `single_grid` is rejected; use `multilayer_convolution` or `strategy="auto"`.
- Unequal native spacing requires `study.universe.mesh(cell_size=...)` in canonical authoring.
- Current multilayer planning rejects boundary correction other than `None`/`none` and rejects
  `boundary_phi_floor` or `boundary_delta_min`.
- ProblemIR rejects `common_cell_size` combined with explicit `mode="two_d_stack"` even though direct
  `FDMDemag` construction currently permits that pair.
- A non-`auto` FFT backend requires active demag and successful capability planning.
- `allow_single_grid_fallback` has been removed and is rejected rather than ignored.

(fdm-grids-discrete-realization)=
## Discrete realization

Each body grid owns origin, shape, spacing, active mask, region mask, and material data. Allocation
size is $N_xN_yN_z$ even when only a subset is magnetic. Supported boundary correction can replace
binary occupancy by fractional volume and corrected local operators.

`compute_newell_kernels` constructs a cell-geometry-dependent Newell tensor and `FftWorkspace` owns
single-grid spectra/cache state. CPU multilayer execution is owned by
`MultilayerDemagRuntime::compute_demag_fields_checked`. Its persistent workspace stores separate
`m_fft[s]` and `h_fft[r]` arrays. `build_kernel_catalog_incrementally` consumes
`KernelCatalogSpec::pair_bindings`, materializes each unique tensor at most once, and retains every
ordered `src_layer`/`dst_layer` binding. Runtime performs a forward transform per source, calls
`accumulate_tensor_convolution` for every binding into the selected target accumulator, then negates,
inverse-transforms, crops, and pulls each target field. `VolumeWeightedTransfer` or identity transfer
realizes $\mathcal P_s$ and $\mathcal R_r$; these symbols do not promise arbitrary interpolation.

(fdm-grids-implementation-mapping)=
## Implementation mapping

| Layer | Stable owner | Contract |
| --- | --- | --- |
| Python schemas | `packages/fullmag-py/src/fullmag/model/discretization.py` — `class FDMGrid`, `class FDM`, `class FDMDemag` | signatures, validation, `to_ir()` |
| Native-grid authoring | `packages/fullmag-py/src/fullmag/world.py` — `class GeometryMeshHandle`, `class StudyObjectsMeshDefaultsHandle` | body/default spacing |
| Common-grid authoring | `packages/fullmag-py/src/fullmag/world.py` — `class StudyUniverseHandle` | universe spacing |
| Script/Scene round-trip | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` — `def _fdm_from_overrides`, `def _export_fdm` | parsing and export |
| ProblemIR | `crates/fullmag-ir/src/mesh_hints.rs` — `pub struct FdmHintsIR`, `pub struct FdmDemagHintsIR` | wire schema and validation |
| Planner | `crates/fullmag-plan/src/fdm.rs` — `pub(crate) fn plan_fdm_multilayer` | requested/resolved grids and policy |
| Resolved cell centres | `crates/fullmag-plan/src/fdm.rs` — `resolved_fdm_cell_centers` | evaluates centre coordinates from origin, indices, and spacing |
| Fractional boundary geometry | `crates/fullmag-plan/src/boundary_geometry.rs` — `compute_boundary_geometry` | computes $\phi$ using $4^3$ SDF sub-samples and boundary metadata |
| Resolved single-grid schema | `crates/fullmag-ir/src/plan.rs` — `FdmPlanIR` | owns shape, spacing, origin, masks, and certificate behind documentary volume identities |
| Resolved multilayer schema | `crates/fullmag-ir/src/mesh_hints.rs` — `FdmMultilayerPlanIR` | owns per-layer native/common grid and transfer descriptors |
| Pair-kernel catalog | `crates/fullmag-engine/src/multilayer.rs` — `build_kernel_catalog_incrementally`; `crates/fullmag-fdm-demag/src/descriptors.rs` — `KernelCatalogSpec` | binds every ordered source/target pair to a reusable tensor |
| CPU multilayer demag | `crates/fullmag-engine/src/multilayer.rs` — `compute_demag_fields_checked` | separate source FFT, pair accumulation, target inverse/pull |
| CUDA first derivative | `backends/fdm/gpu/cuda/interactions/multilayer_dmi.cu` — `multilayer_dmi_field_kernel` | centred interior derivatives plus DMI boundary handling |
| CUDA second derivative | `backends/fdm/gpu/cuda/interactions/exchange_fp64.cu` — `exchange_field_fp64_kernel` | uniform Laplacian and region/PBC/active-mask paths |
| Demag tensor | `crates/fullmag-fdm-demag/src/newell.rs` — `pub fn compute_newell_kernels` | Newell kernels |
| CPU FFT | `crates/fullmag-engine/src/fdm/cpu/fft.rs` — `pub struct FftWorkspace` | spectra and cache |

(fdm-grids-validation)=
## Validation and convergence

Source tests cover canonical lowering, common-grid conflicts, FFT request preservation,
Python/Scene/script/ProblemIR round-trip, and fail-closed IR validation. CPU runtime tests additionally
check three forward FFTs, nine ordered-pair accumulations, and three inverse FFTs for three layers,
plus equality of the catalog result with a sum of separate pair runs. These tests do not prove a
study is grid converged. Use at least three grid levels with geometry, materials, solver tolerances,
initial state, and output sampling fixed. Report cell sizes, resolved shapes, active-cell counts,
backend/device/precision, grid fingerprint, and convergence of the scientific observable.

(fdm-grids-limitations)=
## Limitations

- Cartesian voxelization is stair-stepped without supported boundary correction.
- A common grid can increase memory; explicit counts remain subject to budget checks.
- Canonical authoring exposes spacing, not explicit native counts or origins.
- The centred-difference equations do not specify interface, cut-cell, or periodic stencils.
- Source-backed capability does not replace a runtime receipt for the selected lane.

(fdm-grids-scientific-bibliography)=
## Scientific bibliography

- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
  Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for
  nonuniform magnetization,” *Journal of Geophysical Research* **98** (1993), 9551–9555,
  [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
- A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *Journal of Applied
  Physics* **83** (1998), 3432–3434, [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York (1963).

## Related documentation

- [FDM overview](fdm/index.md)
- [Boundary correction](fdm/boundary-correction.md)
- [Multi-magnet grids](fdm/multi-magnet-grids.md)
- [Periodic grids](fdm/periodic-grids.md)
- [Physics interactions](../../physics/interactions/index.md)

## Runtime ownership and validation boundaries

### Shifted source/target pair tensor

`build_kernel_catalog_incrementally` invokes the builder supplied by its caller and deduplicates the returned tensors; it is not the owner of shifted-pair geometry or Newell mathematics. In the active CPU reference path, `build_multilayer_demag_runtime` derives independent source and destination cell sizes and the destination-minus-source XYZ offset for each ordered pair, then calls `compute_shifted_kernel_pair`. That checked alias delegates to `try_compute_shifted_kernel_pair`, whose mathematical owner is `try_compute_newell_kernels_shifted_pair`; the latter evaluates the real-space six-component tensor for the independent source/target cells and offset before `fft_newell_to_kernel` transforms it. This is the implementation evidence for the ordered `N_rs` pair kernel. The equal-cell `compute_newell_kernels` branch alone is not evidence for unequal or shifted pairs.

### FFT request versus runtime execution

`plan_fdm_fft` checks the authoring request against planner-visible compatibility constraints and creates `FdmFftPlanIR` with only `requested_backend`. `FdmFftPlanIR` has no FFT `resolved_backend` or `executed_backend`; the `CommonPlanMeta.resolved_backend` field describes the overall execution backend and must not be interpreted as an FFT realization.

At execution time, `resolve_cpu_fft_execution_for_demag` maps `auto` or `rustfft` to RustFFT and writes all three FFT receipt fields. The CUDA multilayer runtime writes the same receipt contract in `device_resident_multilayer_provenance` for cuFFT and in `assisted_multilayer_provenance` for host RustFFT assistance. `FdmFftExecutionProvenance` is the artifact schema carrying `requested_backend`, `resolved_backend`, and `executed_backend`. Therefore a concrete FFT implementation is resolved and recorded only by the runtime that actually executes it.

### Exact `boundary_delta_min` acceptance boundary

| Entry/stage | Exact behavior | What reaches the next stage |
|---|---|---|
| Direct Python `FDM(...)` | If non-`None`, the constructor checks only `boundary_delta_min < 0.0`. Negative finite values and `-Inf` are rejected; `NaN` and `+Inf` pass because the comparison is false. | The accepted value is emitted unchanged by `FDM.to_ir()`. |
| Scene/script overrides | `_fdm_number` first converts the value with `float(...)` and then requires `math.isfinite`. It rejects `NaN`, `+Inf`, and `-Inf`; a finite negative value reaches `FDM(...)` and is rejected there. | Only `None` or a finite nonnegative value survives this route. |
| IR (`FdmHintsIR`) | The field is `Option<f64>` and `FdmHintsIR` has no equivalent finite/nonnegative validator. This statement concerns typed IR validation; a particular JSON parser can impose its own syntax restrictions before IR construction. | No IR-layer normalization or range check is applied. |
| Single-grid planner | `plan_fdm` copies `FdmHintsIR.boundary_delta_min` directly into `FdmPlanIR.boundary_delta_min`. | The planner preserves the supplied value; it does not resolve or validate it. |
| Multilayer planner | Any specified `boundary_delta_min` is rejected because the current multilayer plan cannot represent boundary-correction controls. | No multilayer runtime plan is produced for that request. |

(fdm-grids-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
| --- | --- | --- |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | native-grid spacing validation and serialization |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | complete FDM hint policy and lowering |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | demag policy and direct-constructor validation |
| `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | canonical per-body cell size |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyObjectsMeshDefaultsHandle` | canonical default cell size |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseHandle` | canonical common convolution spacing |
| `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_export_fdm` | Scene/script round-trip state |
| `crates/fullmag-ir/src/mesh_hints.rs` | `FdmHintsIR` | ProblemIR FDM hints |
| `crates/fullmag-ir/src/mesh_hints.rs` | `FdmDemagHintsIR` | ProblemIR demag validation |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` | multilayer plan resolution |
| `crates/fullmag-plan/src/fdm.rs` | `resolved_fdm_cell_centers` | implemented cell-centre coordinates |
| `crates/fullmag-ir/src/plan.rs` | `FdmPlanIR` | resolved single-grid shape, spacing, origin, and masks |
| `crates/fullmag-ir/src/mesh_hints.rs` | `FdmMultilayerPlanIR` | resolved per-layer and common-grid descriptors |
| `crates/fullmag-plan/src/boundary_geometry.rs` | `compute_boundary_geometry` | fractional boundary geometry |
| `crates/fullmag-engine/src/multilayer.rs` | `build_kernel_catalog_incrementally` | unique tensors and ordered pair bindings |
| `crates/fullmag-fdm-demag/src/descriptors.rs` | `KernelCatalogSpec` | canonical ordered pair catalog specification |
| `crates/fullmag-engine/src/multilayer.rs` | `compute_demag_fields_checked` | CPU source FFT, pair accumulation, target inverse/pull |
| `backends/fdm/gpu/cuda/interactions/multilayer_dmi.cu` | `multilayer_dmi_field_kernel` | implemented centred first derivatives |
| `backends/fdm/gpu/cuda/interactions/exchange_fp64.cu` | `exchange_field_fp64_kernel` | implemented centred second derivatives |
| `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels` | cell-dependent Newell tensor |
| `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `FftWorkspace` | single-grid CPU spectra/cache |
| `packages/fullmag-py/tests/test_fdm_multilayer_contract.py` | `test_mesh_cell_size_lowers_per_object_and_common_domain` | canonical lowering test |
| `crates/fullmag-ir/tests/ir_tests.rs` | `fdm_demag_hints_round_trip_preserves_known_wire_values` | IR round-trip test |

### Round-2 ownership additions

| Contract | Runtime owner | Evidence boundary |
|---|---|---|
| Ordered shifted-pair call site | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs::build_multilayer_demag_runtime` | Derives source/destination cells and XYZ offset, then calls the pair builder. |
| Checked shifted-pair kernel | `crates/fullmag-fdm-demag/src/shifted_kernel.rs::compute_shifted_kernel_pair` | Public checked alias used by the runner. |
| Shifted-pair Newell mathematics | `crates/fullmag-fdm-demag/src/newell.rs::try_compute_newell_kernels_shifted_pair` | Computes the unequal/shifted six-component real-space tensor. |
| FFT request planning | `crates/fullmag-plan/src/fdm.rs::plan_fdm_fft` | Validates compatibility and stores only the request. |
| FFT request IR | `crates/fullmag-ir/src/plan.rs::FdmFftPlanIR` | Contains only `requested_backend`. |
| CPU FFT resolution/execution | `crates/fullmag-runner/src/fdm/cpu/reference/fft_backend.rs::resolve_cpu_fft_execution_for_demag` | Resolves RustFFT and fills the runtime receipt. |
| CUDA device-resident FFT receipt | `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs::device_resident_multilayer_provenance` | Records cuFFT as resolved and executed. |
| CUDA-assisted FFT receipt | `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs::assisted_multilayer_provenance` | Records assisted RustFFT as resolved and executed. |
| FFT receipt schema | `crates/fullmag-runner/src/types.rs::FdmFftExecutionProvenance` | Owns requested, resolved, and executed FFT fields. |
| Scene finite-number guard | `packages/fullmag-py/src/fullmag/runtime/script_builder.py::_fdm_number` | Rejects all nonfinite scene/script values. |
| Single-grid forwarding | `crates/fullmag-plan/src/fdm.rs::plan_fdm` | Copies `boundary_delta_min` without an equivalent check. |

## Scope and purpose

This page defines the public contract for Cartesian FDM grid construction. It is an authoring and implementation reference: the Python example, the serialized ProblemIR description, the implementation mapping, and the adjacent source map are the source-backed contract. A capability marked partial or not evaluated is not presented as a production guarantee.

## Scientific and numerical model

The mesh or grid is a discrete approximation of the continuous domain. For a Cartesian partition, each spacing satisfies `Delta_i = L_i / N_i`; for a geometry-dependent FEM mesh, the requested local target is bounded by the active bulk, interface, boundary, and topology constraints. In compact form, `h_target(x) = min(h_bulk(x), h_interface(x), h_boundary(x))`. Length quantities use SI metres (`m`); counts, orders, and topology labels are dimensionless.

The equations and assumptions in the earlier physical-problem and governing-equations sections state the model-specific specialization. This section does not introduce a conversion from FEM to FDM, a hidden topology conversion, or a silent CPU fallback.

## Parameters

The exact callable and argument names are the ones shown in the `## Python API` section above. For this page the parameter family is cell_size, grid dimensions, origin, and periodicity. Use the documented defaults, validation rules, and ProblemIR lowering exactly as shown; do not replace a canonical argument with an unlisted alias. Numerical lengths must be supplied in metres, and invalid positive-length, count, order, periodicity, or topology constraints must fail closed rather than being silently repaired.

## Control Room workflow

In Control Room, select the engine and mesh workflow, enter the same values as the Python authoring example, inspect the planned mesh or grid report, and only then submit the run. The UI is a projection of the public contract: a missing control is not evidence that the backend accepts the option, and a visible control is not evidence that a production lane is enabled. When the page or capability register marks a field partial or not evaluated, keep the workflow explicitly bounded to the implemented path.

## Diagnostics and failure semantics

A valid request must preserve the declared geometry, units, element or cell topology, and backend lane. Reject non-finite or non-positive lengths, invalid counts and orders, incompatible periodic or shared-boundary data, and unsupported topology combinations at the owning validation layer. Reports should retain requested and resolved values, source identity, and any capability gate. No diagnostic may hide a failed mesh realization by substituting another discretization.

## Where this is implemented

The existing implementation-mapping and source-code-index sections identify the exact public authoring, ProblemIR, planner, realization, and runtime owners for this topic. The adjacent `.source-map.json` file is the machine-readable source of truth for those paths, symbols, responsibilities, backend matrix, and reviewed revision. Claims in this page must be updated together with that map when an owner moves.