---
title: FDM CPU and CUDA Core Acceleration
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(numerical-methods-performance-fdm-core)=
# FDM CPU and CUDA Core Acceleration

(perf-fdm-core-problem-statement)=
## Scope and purpose

This page documents the core computational optimizations implemented for the regular-grid
finite-difference micromagnetic (`FDM`) solver across both the `FDM GPU` (CUDA) and `FDM CPU`
(Rust/Rayon) lanes. The canonical physical interactions and time-integration/relaxation methods are
owned by {doc}`../demag-solvers/fdm-convolution`, {doc}`../relaxation/projected-gradient`, and
{doc}`../time-integration/index`. Here we detail the numerical-algebraic reformulations, memory
layouts, workspace preflight guards, and hardware-execution contracts that accelerate those
operators without altering their discrete SI definitions.

The page covers seven core mechanisms:

1. **Batched single-layer real-to-complex cuFFT (`D2Z`/`Z2D` FP64 and `R2C`/`C2R` FP32)** for
   open-boundary Newell demagnetization convolution.
2. **Exact cuFFT workspace preflight and multilayer aggregate preflight**, preventing out-of-memory
   leaks before device allocation.
3. **Device-resident single-layer and multilayer projected-gradient Barzilai--Borwein
   (`native_cuda_pgbb`)**, eliminating hot-loop host--device magnetization transfers.
4. **Unbounded material regions via precomputed face-exchange weights** paired with a dedicated
   **uniform-material Laplacian fast path**.
5. **First-Same-As-Last (`FSAL`) stage reuse** for adaptive `rk23`/`rk45` (`DP45`) integrators and
   CUDA conditional-graph batch eligibility.
6. **Versioned mixed-precision storage (`single_storage_fp64_reduction.v1`)** preserving FP64
   energy and torque scalar reductions at half state VRAM.
7. **Rayon-parallel persistent Structure-of-Arrays (`SoA`) loops, row-wise exchange indexing, 3D
   real-to-complex CPU FFT (`R2c3dPlan`), and Newell kernel deduplication (`KernelReuseCatalog`)**
   on `FDM CPU`.

(perf-fdm-core-governing-equations)=
## Scientific and numerical model

### Real-to-complex Hermitian demagnetization convolution

For a padded single-layer grid of dimensions $(P_x, P_y, P_z)$ with real magnetization components
$M_\alpha(\mathbf r)$ ($\alpha \in \{x,y,z\}$), the discrete Fourier transform obeys Hermitian
conjugate symmetry:

```{math}
:label: eq-perf-fdm-hermitian
\widehat M_\alpha(P_x - k_x,\; P_y - k_y,\; P_z - k_z)
= \widehat M_\alpha^{*}(k_x, k_y, k_z),
\qquad
0 \le k_x \le \left\lfloor \frac{P_x}{2} \right\rfloor.
```

Packing all three Cartesian components into a contiguous batched real buffer with inner row stride
$2 s_x$ where $s_x = \lfloor P_x / 2 \rfloor + 1$ allows a single in-place batched real-to-complex
transform (`batch = 3`) in `cufftExecD2Z`/`cufftExecZ2D` (FP64) or `cufftExecR2C`/`cufftExecC2R`
(FP32), evaluating the tensor product solely on the non-redundant half-spectrum $\Omega_{\mathrm{half}}$:

```{math}
:label: eq-perf-fdm-half-spectrum-conv
\widehat H_{\mathrm{d},\alpha}(\mathbf k)
= -\sum_{\beta \in \{x,y,z\}} \widehat N_{\alpha\beta}(\mathbf k)\,\widehat M_\beta(\mathbf k),
\qquad
\mathbf k \in \Omega_{\mathrm{half}},
```

with a single shared Context-owned cuFFT scratch workspace of size
$W_{\mathrm{fft}} = \max(W_{\mathrm{fwd}}, W_{\mathrm{inv}})$. This halves both the active
spectral buffer footprint and the stored six-component symmetric Newell tensor spectra relative to
full complex `Z2Z`/`C2C` transforms while remaining algebraically equivalent up to floating-point
rounding.

### Exact workspace preflight admission

Before committing device allocations for a single-layer CUDA context, cuFFT auto-allocation is
disabled (`cufftSetAutoAllocation(plan, 0)`), exact forward and inverse plan work areas are
queried via `cufftMakePlanMany`, and live free device memory $M_{\mathrm{free}}$ is re-read via
`cudaMemGetInfo` after plan metadata creation. Context initialization proceeds only when the
estimated total workspace $B_{\mathrm{req}}$ satisfies

```{math}
:label: eq-perf-fdm-preflight-budget
B_{\mathrm{req}}
= B_{\mathrm{state}} + B_{\mathrm{kernel}} + \max(W_{\mathrm{fwd}}, W_{\mathrm{inv}}) + B_{\mathrm{aux}}
\le M_{\mathrm{free}} - B_{\mathrm{reserve}},
```

failing closed atomically with `fdm_gpu_workspace_oom_preflight` and zero leaked allocations if
violated.

### Device-resident projected-gradient Barzilai--Borwein retraction

In `native_cuda_pgbb`, each relaxation step evaluates the tangent gradient
$\mathbf g^{(k)} = \mathbf m^{(k)} \times (\mathbf H_{\mathrm{eff}}^{(k)} \times \mathbf m^{(k)})$
and performs the unit-sphere Cayley/normalized trial retraction and Barzilai--Borwein scalar
accumulations directly on the GPU:

```{math}
:label: eq-perf-fdm-pgbb-retract
\mathbf m_{\mathrm{trial}}(\lambda_k)
= \frac{\mathbf m^{(k)} + \lambda_k \mathbf g^{(k)}}
       {\left\|\mathbf m^{(k)} + \lambda_k \mathbf g^{(k)}\right\|_2},
\qquad
\Delta E_k = E(\mathbf m_{\mathrm{trial}}) - E(\mathbf m^{(k)}),
```

eliminating full-vector host--device transfers during the inner Armijo backtracking loop while
preserving strict device-only operator execution receipts (`required == executed_device`).

### Precomputed face-exchange operator for unbounded regions

For heterogeneous media with arbitrarily many regions, the nearest-neighbor exchange effective
field on cell $i$ uses precomputed symmetric face conductances $w_{ij}$ along each Cartesian
neighbor $j \in \mathcal N(i)$:

```{math}
:label: eq-perf-fdm-face-exchange
\mathbf H_{\mathrm{ex},i}
= \frac{2}{\mu_0 M_{s,i}}
  \sum_{j \in \mathcal N(i)}
  \frac{w_{ij}}{\Delta_{ij}^2}\,\bigl(\mathbf m_j - \mathbf m_i\bigr),
\qquad
w_{ij} = \frac{2 A_i A_j}{A_i + A_j}.
```

Precomputing $w_{ij}$ once during grid setup supports unbounded material-region counts without the
$256 \times 256$ lookup-table cap and avoids recomputing harmonic means inside the hot kernel. When
a grid is materially uniform, FullMag dispatches a dedicated `uniform` Laplacian kernel that skips
per-face coefficient fetches entirely.

(perf-fdm-core-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $P_x, P_y, P_z$ | zero-padded FFT grid dimensions along $x, y, z$ | $1$ |
| $s_x$ | non-redundant Hermitian half-spectrum stride $\lfloor P_x/2 \rfloor + 1$ | $1$ |
| $\mathbf M$ | magnetization vector field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{d}}$ | demagnetizing magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\widehat N_{\alpha\beta}$ | Fourier-transformed Newell demagnetization tensor component | $1$ |
| $W_{\mathrm{fwd}}, W_{\mathrm{inv}}$ | exact forward and inverse cuFFT work-area sizes | $\mathrm{B}$ |
| $B_{\mathrm{req}}, M_{\mathrm{free}}$ | required workspace and available free device memory | $\mathrm{B}$ |
| $\mathbf m^{(k)}$ | unit magnetization vector at relaxation iteration $k$ | $1$ |
| $\mathbf g^{(k)}$ | projected tangent gradient of total energy | $\mathrm{A\,m^{-1}}$ |
| $\lambda_k$ | Barzilai--Borwein step parameter | $\mathrm{m\,A^{-1}}$ |
| $E$ | total micromagnetic free energy | $\mathrm{J}$ |
| $\mathbf H_{\mathrm{ex},i}$ | discrete exchange effective field at cell $i$ | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_{s,i}$ | saturation magnetization at cell $i$ | $\mathrm{A\,m^{-1}}$ |
| $w_{ij}$ | harmonic-mean interface exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $\Delta_{ij}$ | center-to-center cell spacing across face $(i,j)$ | $\mathrm{m}$ |

(perf-fdm-core-assumptions-and-validity)=
## Assumptions and validity

- **Single-layer versus multilayer FFT:** Real-to-complex `D2Z`/`Z2D` and `R2C`/`C2R` batching
  applies to single-layer CUDA grids. Multilayer grids with arbitrary inter-layer $z$-offsets
  retain full complex `Z2Z`/`C2C` transforms via `backends/fdm/gpu/cuda/demag/multilayer_convolution.cu`.
- **Precision policy:** `precision="single"` lowers to `single_storage_fp64_reduction.v1`, keeping
  magnetization, effective fields, and FFTs in FP32 while accumulating energies and stopping
  metrics in FP64. Small 2D grids in FP32 (for example `256x256x1`) can be kernel-launch-bound
  rather than memory-bandwidth-bound.
- **FSAL and conditional-graph eligibility:** `FSAL` stage reuse applies to deterministic adaptive
  `rk23` and `rk45` runs without thermal noise or discontinuous drive invalidations. CUDA
  conditional-graph batching additionally requires no active live-observation consumer
  (`adaptive_batch_execution_eligible`).
- **CPU heterogeneous fallback:** On `FDM CPU`, the Rayon-parallel persistent SoA fast path applies
  to uniform single-material grids; heterogeneous multi-material grids currently fall back to AoS
  evaluation.

(perf-fdm-core-python-api)=
## Python API

```python
# %% Configure a GPU FDM study using native_cuda_pgbb and adaptive DP45 FSAL
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_core_acceleration_demo")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.fdm(default_cell=(2.5 * nm, 2.5 * nm, 2.5 * nm))

film = study.geometry(
    fm.Box(size=(300 * nm, 300 * nm, 5 * nm), name="permalloy_film"),
    name="permalloy_film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))

study.demag(enabled=True)
study.stages.add_minimize(
    stage_id="relax_pgbb",
    method="bb",
    tolT=1.0e-7,
    max_steps=50_000,
)
study.solver(
    integrator="rk45",
    dt_initial=1.0e-15,
    dt_min=1.0e-17,
    dt_max=1.0e-12,
    max_err=1.0e-5,
)
study.stages.add_run(until=1.0e-9, stage_id="evolve_rk45")
```

## Parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `study.device(precision=...)` | `str \| None` | `None` | $1$ | `"double"` (`full_double.v1`) or `"single"` (`single_storage_fp64_reduction.v1`) | arithmetic storage and reduction precision policy | FDM CPU/GPU (`single` GPU-oriented) | `backend_policy.precision_policy` |
| `study.fdm(default_cell=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | strictly positive finite 3-tuple `(dx, dy, dz)` | Cartesian cell dimensions setting padded FFT size | FDM CPU/GPU | `backend_policy.discretization_hints.fdm.default_cell` |
| `study.stages.add_minimize(method=...)` | `str` | `"bb"` | $1$ | `"bb"` (PG-BB) or `"ncg"` (nonlinear conjugate gradient) | direct energy minimizer algorithm | FDM CPU/GPU (`bb` uses `native_cuda_pgbb` on CUDA) | `stages[].minimize.method` |
| `study.threads(cpu_threads)` | `int` | host default | $1$ | integer greater than or equal to $1$ | Rayon worker thread budget for `FDM CPU` SoA loops | FDM CPU | `backend_policy.execution.cpu_threads` |

(perf-fdm-core-problem-ir)=
## ProblemIR and provenance

Core FDM optimizations are automatic lane realizations governed by precision, cell sizing, and
stage algorithms; resolved realizations are recorded in execution provenance rather than guessed
from requested parameters:

```json
{
  "backend_policy": {
    "engine": "fdm",
    "device": "gpu",
    "precision_policy": "full_double.v1",
    "discretization_hints": {
      "fdm": {
        "default_cell": [2.5e-9, 2.5e-9, 2.5e-9]
      }
    }
  },
  "provenance": {
    "energy_minimizer_realization": "native_cuda_pgbb",
    "exchange_operator": "uniform",
    "gpu_workspace": {
      "peak_vram_bytes": 38084608
    }
  }
}
```

For host-orchestrated nonlinear conjugate gradient (`method="ncg"`), provenance records
`cuda_fdm_host_tangent_gradient` rather than `native_cuda_pgbb`.

## Control Room workflow

In Control Room, FDM GPU workspace budgets and precision settings are selected in the study
execution and grid configuration inspectors (`MeshRootSpec.tsx` supports 7-smooth FFT grid
snapping and live exchange-length checks). Live diagnostics report workspace peak VRAM
(`gpu_workspace.peak_vram_bytes`), device execution receipts, and whether an adaptive stage is
running with live observation streaming enabled (which intentionally disables CUDA conditional-graph
batching to guarantee immediate frame delivery).

(perf-fdm-core-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Requested intent versus resolved execution:** Requested intent (`engine="fdm"`,
  `device="gpu"`, `precision`, `method="bb"`) is serialized in `ProblemIR`, while resolved
  execution records the realized minimizer (`native_cuda_pgbb` vs `cuda_fdm_host_tangent_gradient`),
  exchange operator (`uniform` vs `faces`), workspace peak bytes, and strict operator bitmask
  receipt (`required == executed_device`).
- **Validation errors:** Non-positive cell dimensions, invalid precision policies, unknown
  minimizer methods, and non-positive thread counts fail validation prior to solver launch.
- **Preflight OOM failure:** Exceeding the available GPU memory budget triggers an atomic
  fail-closed `fdm_gpu_workspace_oom_preflight` diagnostic with zero leaked cuFFT plans or device
  allocations; multilayer creation additionally enforces a hard ceiling of `65,536` allocations.
- **Unsupported combinations:** Requesting strict `device="gpu"` without an eligible CUDA device
  or requesting an unsupported direct minimizer / precision combination fails closed with an
  explicit diagnostic rather than silently falling back to CPU execution.

(perf-fdm-core-discrete-realization)=
## Discrete realization and 4-lane support matrix

| Solver | Device | Status | Realization |
|---|---|---|---|
| `FDM` | `CPU` | implemented | Rayon-parallel persistent SoA loops (`soa_for_each_row_mut`), serial deterministic energy reductions, 3D R2C FFT (`R2c3dPlan`), and analytical Newell `KernelReuseCatalog`. |
| `FDM` | `GPU` | implemented | Batched single-layer `D2Z`/`Z2D` & `R2C`/`C2R` cuFFT, exact workspace preflight, device-resident `native_cuda_pgbb` & multilayer BB, `uniform`/`faces` exchange, FSAL RK23/DP45, and `single_storage_fp64_reduction.v1`. |
| `FEM` | `CPU` | not-applicable | Unstructured FEM uses MFEM sparse assembly rather than Cartesian FFT or SoA voxel grids. |
| `FEM` | `GPU` | not-applicable | Unstructured FEM CUDA optimizations are documented on dedicated FEM performance pages. |

(perf-fdm-core-implementation-mapping)=
## Implementation mapping

Batched real-to-complex cuFFT planning and preflight live in
`backends/fdm/gpu/cuda/runtime/context.cu` and `backends/fdm/gpu/cuda/interactions/demag_fp64.cu`
/ `demag_fp32.cu`; device-resident `native_cuda_pgbb` lives in
`backends/fdm/gpu/cuda/runtime/single_layer_bb.cu` and
`crates/fullmag-runner/src/relaxation/provenance.rs`; adaptive graph eligibility lives in
`crates/fullmag-runner/src/fdm/gpu/cuda/execute.rs`; and `FDM CPU` parallel SoA/FFT/kernel reuse
live in `crates/fullmag-engine/src/fdm/cpu/{soa_par.rs,r2c.rs}` and
`crates/fullmag-fdm-demag/src/descriptors.rs`. All exact declarations are indexed in
{ref}`perf-fdm-core-source-code-index`.

(perf-fdm-core-validation)=
## Validation and verified benchmarks

### Batched single-layer R2C/D2Z cuFFT (RTX 4080 SUPER 16 GiB SM 8.9, CUDA 12.6, 34 cases)

Measured steady-state step time `(s2000 - s50) / 1950` (and `(s500 - s50) / 450` for 3D grids)
against the prior full-complex `Z2Z`/`C2C` implementation, with contract test
`backends/fdm/tests/batched_demag_fft_contract.cpp`:

- `128x128x2` Heun: **3.21x** FP64 (`2.290 -> 0.714 ms/step`), **2.76x** FP32 (`1.352 -> 0.489 ms/step`).
- `64x64x32` FP64: **2.47x** RK4, **2.38x** Heun.
- `256x256x1` RK4 FP64: **1.91x** (FP32 `256x256x1` is launch-bound: `0.372 -> 0.383 ms/step`).
- Peak VRAM (`gpu_workspace.peak_vram_bytes`): reduced **12.0% to 23.1%** across all 15 benchmarked
  geometries.
- Parity: FP64 50-step `rel dE_total = 0`, `rel dE_demag <= 1.76e-16`; 500-step
  `rel dE_total <= 2.63e-14`, `max|dm| <= 1.22e-8`.

### Device-resident `native_cuda_pgbb` (RTX 4080 SUPER, Permalloy `300x300x5 nm` = `120x120x2`)

- Tolerance `tolT = 1e-7 T`: cold wall **5.84x** (`191.67 -> 32.84 s`), warm strict wall **9.65x**
  (`191.67 -> 19.86 s`), relaxation stage heartbeat **~11x** (`185.0 -> 15.0 s`,
  `~11.0 -> ~0.99 ms/step`).
- Transfers & VRAM: hot-loop full-vector H2D/D2H transfers reduced from `61,719 / 112,975`
  (`40.25 GB`) to `0 / 0` (observation reads only: `0 / 31 = 7.60 MB`); peak VRAM **-23.0%**
  (`47.16 -> 36.32 MB`); strict receipt `0xa7 == 0xa7`; energy parity `rel dE_total = 5.623e-11`.
- Larger `256x256x2` grid (200 steps): **1.65x--1.67x** wall speedup, **-23.2%** peak VRAM
  (`214.58 -> 164.82 MB`).

### Unbounded face exchange, FSAL, and `FDM CPU` Rayon SoA

- **Exchange kernels (CUDA):** Uniform Laplacian branch is **1.65x** faster than the legacy 256-region
  LUT (`54.5 vs 88.9 us` at `0.5M` cells; `813 vs 1378 us` at `8.4M` cells). Precomputed FP64 face
  weights support unbounded regions (verified to 1024 grains) at `571.9 vs 571.8 us` (`256x256x64`)
  with `+5%--7%` full-step overhead, avoiding the `1.6x--1.7x` penalty of in-kernel harmonic means.
- **FSAL & conditional graphs:** `19/20` right-hand-side evaluations saved per 20-step deterministic
  adaptive run on RTX 3070 Laptop (CC 8.6), with stream ordering verified on RTX 4080 SUPER.
  Standalone wall-time speedup of CUDA conditional-graph batching versus unbatched adaptive stepping
  is **not verified**.
- **`FDM CPU` Rayon SoA (4 CPU threads, median of 3, bit-identical SHA-256 `m_final`):**
  Exchange-only Heun `256x256x1` **1.83x** (`20.289 -> 11.073 ms/step`), `128x128x32` **2.93x**
  (`162.826 -> 55.577 ms/step`); full demag Heun `128x128x32` **1.29x**
  (`526.144 -> 409.274 ms/step`); RK45 fixed-dt `128x128x32` **1.24x**.

(perf-fdm-core-limitations)=
## Limitations and rejected approaches

- Multilayer CUDA demagnetization does not yet use Hermitian real-to-complex FFTs; it retains
  complex `Z2Z`/`C2C` transforms to handle arbitrary inter-layer $z$-spacings cleanly.
- `FDM CPU` heterogeneous multi-material grids fall back to AoS loops (`+22%` full-step / `+41%`
  exchange-only overhead relative to uniform SoA).
- Very small FP32 2D grids (`256x256x1`) can show neutral or slightly slower wall time under R2C
  due to CUDA kernel-launch latency dominating arithmetic work.
- Nonlinear conjugate gradient (`method="ncg"`) on `FDM GPU` remains host-orchestrated
  (`cuda_fdm_host_tangent_gradient`); prefer `method="bb"` (`native_cuda_pgbb`) for strict
  device-resident relaxation.

(perf-fdm-core-scientific-bibliography)=
## Scientific bibliography

1. A. J. Newell, W. Williams, and D. J. Dunlop, "A generalization of the demagnetizing tensor for
   nonuniform magnetization," *Journal of Geophysical Research* **98**, 9551--9555 (1993),
   [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
2. J. Barzilai and J. M. Borwein, "Two-point step size gradient methods," *IMA Journal of Numerical
   Analysis* **8**, 141--148 (1988), [doi:10.1093/imanum/8.1.141](https://doi.org/10.1093/imanum/8.1.141).
3. L. Exl et al., "LaBonte's method revisited: An effective steepest descent method for
   micromagnetic energy minimization," *Journal of Applied Physics* **115**, 17D118 (2014),
   [doi:10.1063/1.4862839](https://doi.org/10.1063/1.4862839).
4. J. R. Dormand and P. J. Prince, "A family of embedded Runge--Kutta formulae," *Journal of
   Computational and Applied Mathematics* **6**, 19--26 (1980),
   [doi:10.1016/0771-050X(80)90013-3](https://doi.org/10.1016/0771-050X(80)90013-3).
5. NVIDIA Corporation, *cuFFT Library User's Guide*, real-to-complex Hermitian transforms and
   explicit workspace management.

(perf-fdm-core-source-code-index)=
## Where this is implemented

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Exact single-grid cuFFT workspace preflight | `backends/fdm/gpu/cuda/runtime/context.cu` | `context_preflight_single_grid_workspace` | Query exact cuFFT work areas and live VRAM before allocation | `FDM GPU` | Managed CUDA contract & RTX 4080 SUPER A/B |
| Multilayer aggregate workspace preflight | `backends/fdm/gpu/cuda/runtime/context.cu` | `context_preflight_multilayer_workspace_v2` | Checked aggregate VRAM breakdown and 65,536-alloc guard | `FDM GPU` | `multilayer_create_v2_contract.cpp` |
| FP64 real-to-complex demag packing | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `pack_magnetization_fft_fp64_kernel` | Contiguous `2*sx` real packing for batched `D2Z`/`Z2D` | `FDM GPU` | `batched_demag_fft_contract.cpp` |
| FP64 half-spectrum tensor convolution | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `tensor_convolution_fp64_kernel` | Symmetric 6-component Newell contraction on half-spectrum | `FDM GPU` | RTX 4080 SUPER A/B (`rel dE <= 1.76e-16`) |
| FP32 real-to-complex demag packing | `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `pack_magnetization_fft_fp32_kernel` | Batched `R2C`/`C2R` packing under mixed-precision policy | `FDM GPU` | RTX 4080 SUPER A/B (`-12%..-23%` VRAM) |
| GPU Newell tensor assembly | `backends/fdm/gpu/cuda/demag/newell_gpu_fp64.cu` | `newell_fill_fg_kernel` | Device-side analytical Newell kernel evaluation | `FDM GPU` | CUDA contract suite |
| Device-resident single-layer PG-BB driver | `backends/fdm/gpu/cuda/runtime/single_layer_bb.cu` | `context_single_layer_bb` | Zero-hot-transfer GPU Barzilai--Borwein relaxation loop | `FDM GPU` | RTX 4080 SUPER A/B (5.84x--9.65x wall) |
| Device-resident PG-BB retraction kernel | `backends/fdm/gpu/cuda/runtime/single_layer_bb.cu` | `trial_retract_kernel` | Unit-sphere trial retraction on GPU | `FDM GPU` | RTX 4080 SUPER A/B |
| Single-layer PG-BB C ABI entry point | `backends/fdm/api/c_api.cpp` | `fullmag_fdm_backend_single_layer_bb_v1` | Typed C ABI dispatch for `native_cuda_pgbb` | `FDM GPU` | Rust/C++ ABI contract |
| Direct minimizer provenance projection | `crates/fullmag-runner/src/relaxation/provenance.rs` | `cuda_fdm_direct_minimizer_realization` | Distinguish `native_cuda_pgbb` from host NCG | `FDM GPU` | Runner provenance tests |
| Adaptive batch graph eligibility | `crates/fullmag-runner/src/fdm/gpu/cuda/execute.rs` | `adaptive_batch_execution_eligible` | Gate CUDA conditional-graph batching when live consumer inactive | `FDM GPU` | Runner unit contract |
| Parallel persistent SoA row loops | `crates/fullmag-engine/src/fdm/cpu/soa_par.rs` | `soa_for_each_row_mut` | Rayon row-wise iteration eliminating per-cell division | `FDM CPU` | 4-CPU A/B (1.29x--2.93x, SHA-256 parity) |
| CPU 3D real-to-complex FFT plan | `crates/fullmag-engine/src/fdm/cpu/r2c.rs` | `R2c3dPlan` | Half-spectrum real-to-complex 3D FFT on CPU | `FDM CPU` | Engine FFT tests |
| Newell kernel reuse catalog | `crates/fullmag-fdm-demag/src/descriptors.rs` | `KernelReuseCatalog` | Deduplicate symmetric layer-pair Newell spectra | `FDM CPU/GPU` | Demag descriptor tests |
