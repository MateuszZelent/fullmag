---
title: FDM Convolution
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-demag-solvers-fdm-convolution)=
# FDM tensor convolution and FFT demagnetization

(numerical-methods-demag-fdm-problem-statement)=
## Scope and purpose

The canonical demagnetizing interaction is documented in
{doc}`../../physics/interactions/demagnetization/fdm-convolution`. This page owns the FDM
realization: a Cartesian cell grid, a cell-averaged Newell demagnetization tensor, zero-padded
open-boundary convolution, Hermitian half-spectrum GPU cuFFT transforms (`D2Z`/`Z2D` in FP64 and
`R2C`/`C2R` in FP32) with exact cuFFT workspace preflight, and a field/energy reduction with one
shared physical convention.

(numerical-methods-demag-fdm-governing-equations)=
## Scientific and numerical model

The cell-averaged field is the tensor convolution

```{math}
:label: eq-numerical-demag-fdm-field
H_{\mathrm d,p,i}=-\sum_q\sum_jN^{\mathrm{cell}}_{pq,ij}M_{q,j}.
```

The energy is reduced from the accepted field and magnetization:

```{math}
:label: eq-numerical-demag-fdm-energy
E_{\mathrm d}=-\frac{\mu_0}{2}\sum_pV_p\,
\mathbf M_p\cdot\mathbf H_{\mathrm d,p}.
```

The open-boundary FFT implementation embeds the finite convolution in a padded domain:

```{math}
:label: eq-numerical-demag-fdm-fft
\widehat{\mathbf H}_{\mathrm d}
=-\widehat{\mathbf N}^{\mathrm{cell}}\widehat{\mathbf M},
\qquad
\mathbf H_{\mathrm d}=\mathcal F^{-1}\left[\widehat{\mathbf H}_{\mathrm d}\right].
```

Because both $\mathbf M$ and $\mathbf N^{\mathrm{cell}}$ are real-valued, the single-layer CUDA
implementation exploits Hermitian conjugate symmetry along the fastest FFT axis ($s_x = N_{\mathrm{fft},x}/2 + 1$),
executing batched in-place real-to-complex (`D2Z` in FP64, `R2C` in FP32) and complex-to-real
(`Z2D` in FP64, `C2R` in FP32) cuFFT plans (`batch = 3`) sharing a single Context-owned cuFFT work
area of size $\max(W_{\mathrm{fwd}}, W_{\mathrm{inv}})$. This halves single-layer FFT scratch and
kernel spectrum storage without altering the real-space convolution operator.

For single-layer mixed-boundary geometries (one lateral periodic axis and one open lateral axis),
distant cell lags satisfy $r \ge 40\max(h_x, h_y, h_z)$ and switch from direct Newell differences
(which lose precision in binary64 as $r^3$ differences cancel toward $r^{-3}$) to the exact
point-dipole pair limit in [`compute_single_layer_mixed_newell_kernels`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs#L5).

(numerical-methods-demag-fdm-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $H_{\mathrm d,p,i}$ | field component $i$ in destination cell $p$ | $\mathrm{A\,m^{-1}}$ |
| $N^{\mathrm{cell}}_{pq,ij}$ | cell-averaged demagnetization tensor | $1$ |
| $M_{q,j}$ | source-cell magnetization component | $\mathrm{A\,m^{-1}}$ |
| $\mathbf M_p$ | magnetization in destination cell | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm d,p}$ | demagnetizing field in destination cell | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $V_p$ | destination-cell volume | $\mathrm{m^3}$ |
| $\widehat{\mathbf H}_{\mathrm d}$ | FFT-domain demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\widehat{\mathbf N}^{\mathrm{cell}}$ | FFT of the tensor kernel | $1$ |
| $\widehat{\mathbf M}$ | FFT of packed magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathcal F$ | discrete Fourier transform | $1$ |
| $p,q$ | destination and source cell indices | $1$ |
| $i,j$ | Cartesian component indices | $1$ |

(numerical-methods-demag-fdm-assumptions-and-validity)=
## Assumptions and validity

- The mesh is Cartesian and each active cell has a defined volume and magnetization mask.
- Open boundaries require zero padding to prevent circular wrap-around. A periodic FFT without the
  periodic demag policy is a different boundary-value problem.
- The cell-averaged Newell tensor is exact for the chosen rectangular-cell discretization; it does
  not remove grid, geometry-mask, or finite-precision error.
- GPU FP32 (`R2C`/`C2R`) and FP64 (`D2Z`/`Z2D`) are separate precision lanes. FP32 is intentionally
  gated off for CUDA periodic demagnetization (`pbcxy`).
- Exact cuFFT workspace preflight ([`context_preflight_single_grid_workspace`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/context.cu#L140)) queries the
  actual cuFFT workspace byte requirement before committing device allocations and rejects
  over-budget grids fail-closed with `fdm_gpu_workspace_oom_preflight`.
- Multilayer convolution uses an explicit multilayer policy with an authored or planner-resolved
  common scratch layout (`Z2Z`/`C2C` multilayer workspaces remain separate from the single-layer
  `D2Z`/`R2C` path). A failed common-grid resolution must not silently fall back to a single-grid
  approximation.
- Omitting both `common_cells` and `common_cells_xy` delegates scratch-grid selection to Fullmag's
  planner-auto policy. The authored `ProblemIR` has no `common_cells*` fields, while the resolved
  union-scratch layout is recorded separately in plan/provenance.
- Fullmag `mode="two_d_stack"` requires one native Z cell per layer; use `three_d` for native
  through-thickness cells.

(numerical-methods-demag-fdm-python-api)=
## Python API

```python
# %% Configure FDM demagnetization as a stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_demag_convolution")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
film = study.geometry(
    fm.Box(size=(100 * nm, 20 * nm, 5 * nm), name="film"),
    name="film",
)
film.mesh(cell_size=(2 * nm, 2 * nm, 5 * nm))
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.demag()
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk45",
    dt_initial=1.0e-15,
    dt_min=1.0e-17,
    dt_max=1.0e-14,
    max_err=1.0e-7,
    tolT=1.0e-6,
    max_steps=50_000,
)
```

## Parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `body.mesh(cell_size=...)` | `Sequence[float]` | required unless a default exists | $\mathrm{m}$ | exactly three finite positive values; object extents must divide exactly | native Cartesian cell size of one magnetic object | FDM CPU/GPU authoring; execution is lane-gated | `backend_policy.discretization_hints.fdm.per_magnet.<object>.cell` |
| `study.objects.mesh.defaults(cell_size=...)` | `Sequence[float]` | `None` | $\mathrm{m}$ | exactly three finite positive values | default native cell size for objects without overrides | FDM CPU/GPU authoring | `backend_policy.discretization_hints.fdm.default_cell` |
| `study.universe.mesh(cell_size=...)` | `Sequence[float]` | planner-selected | $\mathrm{m}$ | exactly three finite positive values; common extents must divide exactly | requested non-physical common convolution-grid resolution | FDM multilayer CPU/GPU authoring; execution is lane-gated | `backend_policy.discretization_hints.fdm.demag.common_cell_size` |
| `study.demag()` | interaction request | disabled until called | $1$ | one demagnetizing interaction per study | requests demagnetization without exposing its numerical storage layout | FDM and FEM | `energy_terms[kind=demag]` |
| `study.mode("strict")` | execution policy | backend default | $1$ | supported mode literal | forbids rounding, fallback, or silent replacement of an invalid requested discretization | all backends | `runtime_selection.mode` |

The older `study.fdm(...)`, `FDMGrid`, and `FDMDemag` forms are migration adapters, not the
canonical authoring surface. For heterogeneous layers, common-XY versus full-3D behavior, and the
complete 2 nm / 5 nm / 10 nm example, see
{doc}`../../physics/interactions/demagnetization/multilayer-convolution`.

(numerical-methods-demag-fdm-problem-ir)=
## ProblemIR and provenance

The physical request remains `Demag`; the FDM policy is nested under
`backend_policy.discretization_hints.fdm`:

```json
{
  "energy_terms": [{"kind": "demag"}],
  "backend_policy": {
    "discretization_hints": {
      "fdm": {
        "default_cell": [2e-9, 2e-9, 5e-9],
        "per_magnet": {
          "film": {"cell": [2e-9, 2e-9, 5e-9]}
        },
        "demag": {"strategy": "auto", "mode": "auto"}
      }
    }
  }
}
```

Normalization records requested strategy and mode. Planning resolves grid dimensions, FFT padding,
mask, precision, and exact cuFFT workspace memory budget; those resolved values and
`gpu_workspace.peak_vram_bytes` belong to execution provenance and must not be inferred from `auto`
after the run.

(numerical-methods-demag-fdm-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

Script export preserves the stage-first study and object-owned discretization policy. The round
trip reports validation errors for invalid cell sizes, malformed common grids, and over-budget GPU
workspaces (`fdm_gpu_workspace_oom_preflight`). The unsupported combinations are explicit: FEM
requests, periodic axes without the periodic demag policy, and FP32 periodic CUDA runs are rejected
by the planner or setup preflight; they do not silently become an open single-grid CPU run.
Requested intent, resolved execution, and provenance are recorded separately.

(numerical-methods-demag-fdm-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | reference | Newell tensor preparation (including single-layer mixed dipolar images), CPU FFT convolution, and field/energy reduction |
| FDM | GPU | implemented | Batched in-place Hermitian half-spectrum cuFFT (`D2Z`/`Z2D` FP64, `R2C`/`C2R` FP32), shared cuFFT work area, exact workspace preflight, and device-resident field/energy kernels; RTX 4080 SUPER A/B verified |
| FEM | CPU | not-applicable | Scalar-potential FEM is documented in {doc}`fem-poisson-airbox` and {doc}`fem-bem` |
| FEM | GPU | not-applicable | Scalar-potential FEM GPU is documented in {doc}`fem-poisson-airbox` and {doc}`fem-bem` |

CPU and GPU share the Newell tensor convention, sign, and energy definition. The single-layer GPU
lane compresses padded complex arrays to the Hermitian half-spectrum (`sx = fft_nx / 2 + 1`, real
pitch `2 * sx`), preserving the public C ABI by slicing full complex spectra at upload time when
host spectra are supplied.

(numerical-methods-demag-fdm-implementation-mapping)=
## Implementation mapping

Public `Demag` policy normalization, per-magnet grid configuration, Rust CPU Newell kernel
construction (including mixed-boundary single-layer images) and tensor convolution, exact CUDA
cuFFT workspace preflight, and FP64/FP32 half-spectrum CUDA field kernels are mapped in
{ref}`numerical-methods-demag-fdm-source-code-index`.

(numerical-methods-demag-fdm-validation)=
## Validation

- **Newell self-term, symmetry, and mixed-layer stability:** Cell-averaged Newell tensors and
  mixed single-layer distant point-dipole transitions are validated against independent cell-volume
  quadrature and reflection/Nyquist parity checks.
- **RTX 4080 SUPER A/B verification (`D2Z`/`Z2D` FP64 and `R2C`/`C2R` FP32 vs legacy `Z2Z`/`C2C`):**
  Across 15 fixed-`dt` LLG geometries (`256×256×1`, `128×128×2`, `64×64×32`, `pbcxy` `128×128×2`,
  cylinder `128×128×2`; Heun and RK4; FP64 and FP32), half-spectrum cuFFT with shared workspace
  achieves **`1.09×–3.21×`** per-step speedup (`128×128×2` Heun `(s2000-s50)/1950`: **`3.21×`** FP64
  and **`2.76×`** FP32; `64×64×32` RK4/Heun FP64: **`2.47×`/`2.38×`**; `256×256×1` RK4/Heun FP64:
  **`1.91×`/`1.09×`**) and **`12.0–23.1%`** `gpu_workspace.peak_vram_bytes` reduction.
- **FP64/FP32 numerical parity:** Across all 8 FP64 geometries, 50-step trajectories agree with
  `rel dE_total = 0.00e+00` (`rel dE_demag <= 1.76e-16`), and 500-step trajectories maintain
  **`rel dE_total <= 2.63e-14`** and `max |dm| <= 1.22e-8`. Across all 7 open/cylinder FP32
  geometries, 50-step trajectories keep `rel dE_total <= 2.00e-9`.
- **Exact cuFFT preflight:** Verified in `multilayer_create_v2_contract` and single-grid strict
  GPU execution (`hot_loop_full_vector_h2d_count = 0`, `hot_loop_full_vector_d2h_count = 0`,
  `fallback_count = 0`).

See {ref}`numerical-methods-performance-fdm-core` for full benchmark tables and PG-BB relaxation
measurements.

(numerical-methods-demag-fdm-limitations)=
## Limitations

This page does not claim arbitrary non-Cartesian geometry exactness, universal FP32 long-horizon
trajectory equivalence (single-precision FFT rounding drifts nonlinear LLG phases over hundreds of
steps), or periodic physics from ordinary zero-padded convolution. Multilayer GPU workspaces retain
separate `Z2Z`/`C2C` plans, and CUDA FP32 periodic demagnetization remains intentionally gated off.

(numerical-methods-demag-fdm-scientific-bibliography)=
## Scientific bibliography

- A. J. Newell, W. Williams and D. Dunlop, “A method for computing the demagnetizing factors for rectangular ferromagnetic prisms,” *Journal of Geophysical Research* 98 (1993), DOI: [10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
- J. M. D. Coey, *Magnetism and Magnetic Materials*, Cambridge University Press, 2010.
- Canonical physics owner: {doc}`../../physics/interactions/demagnetization/fdm-convolution`.
- Performance reference: {ref}`numerical-methods-performance-fdm-core`.

(numerical-methods-demag-fdm-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| FDM policy | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L51) | [`class FDMDemag`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L51) | public strategy and grid controls | public API | Python tests |
| Mesh authoring | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1681) | [`class GeometryMeshHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1681) | object-owned cell-size authoring | public API | Python tests |
| Stage lowering | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3419) | [`relax_stage`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3419) | stage-first lowering | public API | Python tests |
| Newell kernel | [`crates/fullmag-fdm-demag/src/newell.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell.rs#L596) | [`compute_newell_kernels`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell.rs#L596) | cell-averaged demag tensor | CPU/reference | Rust tests |
| Mixed single-layer kernel | [`crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs#L5) | [`compute_single_layer_mixed_newell_kernels`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs#L5) | distant point-dipole guarded mixed-boundary single-layer tensor | FDM CPU/GPU host builder | Rust tests |
| FFT product | [`crates/fullmag-fdm-demag/src/multiply.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/multiply.rs#L25) | [`accumulate_tensor_convolution`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/multiply.rs#L25) | tensor-vector product | CPU/reference | Rust tests |
| CPU kernel spectra | [`crates/fullmag-engine/src/fdm/cpu/fft.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L681) | [`compute_newell_kernel_spectra`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L681) | FFT kernel spectra | CPU/reference | Rust tests |
| CPU field | [`crates/fullmag-engine/src/fdm/cpu/fields/demag.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/demag.rs#L8) | [`demag_field_from_vectors`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/demag.rs#L8) | CPU field calculation | FDM CPU | engine tests |
| GPU workspace preflight | [`backends/fdm/gpu/cuda/runtime/context.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/context.cu#L140) | [`context_preflight_single_grid_workspace`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/context.cu#L140) | exact cuFFT workspace byte preflight | FDM GPU | CUDA contracts |
| GPU FP64 field | [`backends/fdm/gpu/cuda/interactions/demag_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L671) | [`launch_demag_field_fp64`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L671) | CUDA FP64 D2Z/Z2D half-spectrum field kernel dispatch | FDM GPU | RTX 4080 SUPER A/B verified |
| GPU FP32 field | [`backends/fdm/gpu/cuda/interactions/demag_fp32.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp32.cu#L643) | [`launch_demag_field_fp32`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp32.cu#L643) | CUDA FP32 R2C/C2R half-spectrum field kernel dispatch | FDM GPU | RTX 4080 SUPER A/B verified |
