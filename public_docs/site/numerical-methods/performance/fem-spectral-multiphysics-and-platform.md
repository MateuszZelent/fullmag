---
title: FEM Eigensolvers, Driven Response, Multiphysics, and Runtime Systems
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(numerical-methods-performance-fem-spectral-multiphysics)=
# FEM Eigensolvers, Driven Response, Multiphysics, and Runtime Systems

(perf-fem-spectral-problem-statement)=
## Scope and purpose

This page documents FullMag's computational optimizations for frequency-domain spectral solvers
(modal eigenmodes and driven linear susceptibility), coupled finite-element multiphysics solvers
(Oersted fields, ohmic charge, drift-diffusion `M1`/`M2` spin transport, and conservative `OE-T0`
saddle-point systems), and cross-cutting runtime, meshing, storage, and live-visualization
subsystems. Canonical method definitions live in {doc}`../eigensolvers/index`,
{doc}`../frequency-domain/index`, and {doc}`../meshing/index`.

Five optimization groups are covered:

1. **Exact augmented $(q,\phi)$ sparse shift-invert via MUMPS/METIS + right-preconditioned FGMRES**
   and **SLEPc Krylov subspace (`ncv`) sizing** on `FEM CPU`, plus **guarded GPU cuDSS modal
   shifts** (open-airbox `K0` and single-`k` Floquet with exact-shift inertia caching and lifted
   GPU QR).
2. **Factor-once 2x2 block-prescaled, Ruiz-equilibrated GPU cuDSS driven frequency response**
   (`FrequencyResponseSolverPolicy`), reusing symbolic analysis once across an entire frequency
   sweep while independently certifying unscaled $(r_q, r_\phi)$ residuals.
3. **Wave 2 multiphysics sparse and parallel solver modernization:** unified 3-tier CPU + opt-in
   `cuDSS` `SparseLinearSolver` (`MUMPS`/`HYPRE`/`MFEM`) with nanometer saddle-point equilibration
   for `OE-F2` vector-potential, factor-once multi-RHS charge, stiff `M1`/`M2` transport, and
   Schur-AMG `OE-T0` KKT, plus 0-ULP parallel and opt-in 106-bit `DoubleDouble` CUDA far-field
   `OE-F1` quadrature with fused `ProjectField`.
4. **Adaptive multi-process dispersion pool** bypassing process-global PETSc/SLEPc serialization
   under cgroup/affinity-aware CPU and RAM budgets, alongside frequency-domain cotree-tree gauge
   `FIT` antenna solves.
5. **Cross-cutting platform accelerations:** compact $O(1)$ canonical FEM marker maps, vectorized
   `tet4` face statistics, batched Zarr field autosave metadata (`ZarrFieldMetadataBatch`),
   streaming large-run manifest hashing (`hash_regular_file_snapshot`), bounded 64 MiB binary
   dataset slices, and off-main-thread live FDM viewport color workers.

(perf-fem-spectral-governing-equations)=
## Scientific and numerical model

### Exact augmented $(q, \phi)$ shift-invert eigenmodes (CPU MUMPS & GPU cuDSS)

Linearized LLG modal analysis around an equilibrium $\mathbf m_0$ couples nodal tangent spin
amplitudes $\mathbf q$ to dynamic scalar potential $\delta\phi$. Eliminating $\delta\phi$ via a
nested Schur-complement `MatShell` with a magnetic-only preconditioner stalls or diverges on thin
films because dynamic demagnetization dominates the spectrum. Factorizing the full augmented
shifted pencil directly via sparse MUMPS/METIS LU (CPU) or guarded `cuDSS` (GPU) as an exact right
preconditioner for FGMRES converges in 1--2 iterations:

```{math}
:label: eq-perf-fem-augmented-shift
K_{\sigma}
\begin{pmatrix}\mathbf q \\ \delta\phi\end{pmatrix}
=
\begin{pmatrix}
s A_{qq}^{\mathrm{R}} + c\,J(B_{qq}) & s A_{q\phi}^{\mathrm{R}} \\
A_{\phi q}^{\mathrm{R}} & P_{g}^{\mathrm{R}}
\end{pmatrix}
\begin{pmatrix}\mathbf q \\ \delta\phi\end{pmatrix}
=
\begin{pmatrix}\mathbf r_q \\ \mathbf 0\end{pmatrix},
\qquad
c = \sigma m_s.
```

Here $K_{\sigma}$ is a mixed-unit $2\times 2$ sparse block operator whose magnetic rows are
scaled by $s$ and whose lower rows enforce the gauge-fixed magnetostatic potential equation
($P_g^{\mathrm{R}}$); its $\mathbf q$-block Schur complement equals the shifted real-split
eigenmode operator $S_\sigma$. On `FEM GPU`, `CudssModalShift` enforces the post-analysis VRAM
admission bound
$M_{\mathrm{budget}} = M_{\mathrm{free}} - \max(512\,\mathrm{MiB}, 0.05\,M_{\mathrm{device}})$
(`check_device_memory_budget`) before factorizing, caches exact-shift inertia counts across
bisection probes inside `count_airbox_augmented_window`, and uses lifted GPU QR to eliminate
redundant Poisson solves. On `FEM CPU`, raising single-shift SLEPc subspace size from $2 n_{\mathrm{ev}}$
to $\min(n, \max(2 n_{\mathrm{ev}}, n_{\mathrm{ev}} + 15))$ (`bounded_krylov_dimensions`) cuts
implicit restarts by more than $7\times$ at minimal memory overhead.

### Factor-once 2x2 block-prescaled Ruiz-equilibrated cuDSS driven response

In driven linear frequency response over frequencies $\{\omega_k\}_{k=1}^{N_\omega}$, the coupled
complex non-Hermitian system exhibits severe off-diagonal scale asymmetry ($\sim 10^{25}$ between
magnetic susceptibility and scalar-potential rows). FullMag assembles the sparsity pattern once,
applies exact $2\times 2$ block geometric pre-scaling followed by 6-pass Ruiz equilibration
$D_r \mathcal A(\omega_k) D_c$, runs `CUDSS_PHASE_ANALYSIS` **once per sweep**, and updates only
the $4 N_{m,\mathrm{eff}}$ frequency-dependent diagonal entries on GPU at each $\omega_k$
(`launch_driven_response_update_omega_entries`):

```{math}
:label: eq-perf-fem-driven-ruiz
D_r
\begin{pmatrix}
A_{qq} + \mathrm{i}\omega_k G(\alpha) & A_{q\phi} \\
A_{\phi q} & P_{\phi\phi}
\end{pmatrix}
D_c
\begin{pmatrix}\tilde{\mathbf q} \\ \widetilde{\delta\phi}\end{pmatrix}
= D_r \begin{pmatrix}\mathbf b_q \\ \mathbf 0\end{pmatrix},
\qquad
r_q = \frac{\|\mathbf b_q - A_{qq}\mathbf q - \mathrm{i}\omega_k G(\alpha)\mathbf q - A_{q\phi}\delta\phi\|_2}{\|\mathbf b_q\|_2}.
```

In {eq}`eq-perf-fem-driven-ruiz`, $G(\alpha)$ carries the $\gamma_0^{-1}$ LLG prefactor (unit
$\mathrm{A\,m^{-1}\,s}$ in field-normalized rows) so $\omega_k G(\alpha)$ and $A_{qq}$ share
identical magnetic-field units ($\mathrm{A\,m^{-1}}$). Unscaled residuals $(r_q, r_\phi)$ are
independently certified on GPU via Blue/LAPACK scaled-norm multi-block `cub::BlockReduce`
(`launch_driven_response_unscaled_residual_cert`), guaranteeing that equilibration never masks
algebraic error.

### Nanometer saddle-point equilibration and hybrid `DoubleDouble` Oersted quadrature

In `OE-F2` vector-potential and `OE-T0` conservative current saddle-point solves on nanometer
meshes, $\|A\| / \|B\| \sim 10^{22}$ destroys standard unscaled sparse pivoting and multigrid
smoothers. Symmetric block equilibration (`compute_saddle_point_equilibration_beta`,
`assemble_equilibrated_saddle_point_csr`) rescales the Lagrange multiplier block by the clamped
linear scale ratio $\beta_{\mathrm{eq}} = \operatorname{clamp}(a_{\mathrm{scale}} / b_{\mathrm{rms}},
10^{-100}, 10^{100})$, where $a_{\mathrm{scale}}$ is the mean nonzero diagonal magnitude $|A_{ii}|$
(falling back to the RMS nonzero magnitude of $A$) and $b_{\mathrm{rms}}$ is the RMS nonzero
magnitude of $B$:

```{math}
:label: eq-perf-fem-saddle-equil
\begin{pmatrix}
A & \beta_{\mathrm{eq}} B^{\mathsf T} \\
\beta_{\mathrm{eq}} B & 0
\end{pmatrix}
\begin{pmatrix}\mathbf u \\ \beta_{\mathrm{eq}}^{-1}\mathbf p\end{pmatrix}
=
\begin{pmatrix}\mathbf f \\ \beta_{\mathrm{eq}} \mathbf g\end{pmatrix},
\qquad
\beta_{\mathrm{eq}} = \operatorname{clamp}\!\left(\frac{a_{\mathrm{scale}}}{b_{\mathrm{rms}}},\; 10^{-100},\; 10^{100}\right),
```

enabling $h$-independent `HYPRE` AMS+BoomerAMG, `MUMPS`/METIS, and opt-in `cuDSS` LU solves across
tens of thousands of Nedelec/H1 DOFs. For direct Biot--Savart tetrahedral quadrature (`OE-F1`),
far-field source-target pairs ($d_c > 3 R_s$) execute either across deterministic 0-ULP CPU worker
threads (`std::thread`) or opt-in 106-bit `DoubleDouble` CUDA kernels
(`fullmag_cuda_direct_tetra_evaluate_root_farfield`), while near-singular pairs ($d_c \le 3 R_s$)
hand off cleanly to CPU `long double` Duffy quadrature.

(perf-fem-spectral-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $s, m_s$ | real-split augmented-pencil operator and mass-block scalings | $1$ |
| $\mathbf q$ | nodal transverse magnetization perturbation vector | $1$ |
| $\delta\phi$ | dynamic magnetic scalar potential perturbation | $\mathrm{A}$ |
| $\sigma$ | spectral shift parameter in the real-split augmented pencil | $\mathrm{rad\,s^{-1}}$ |
| $\omega_k$ | angular excitation frequency $2\pi f_k$ | $\mathrm{rad\,s^{-1}}$ |
| $D_r, D_c$ | left and right block-plus-Ruiz equilibration diagonal scalings | $1$ |
| $G(\alpha)$ | damped gyrotropic frequency-response operator block ($\gamma_0^{-1}$-scaled) | $\mathrm{A\,m^{-1}\,s}$ |
| $r_q, r_\phi$ | independently certified unscaled magnetic and potential relative residuals | $1$ |
| $\beta_{\mathrm{eq}}$ | clamped linear nanometer saddle-point equilibration factor $a_{\mathrm{scale}}/b_{\mathrm{rms}}$ | $1$ |
| $d_c, R_s$ | tetrahedron centroid separation and source circumradius | $\mathrm{m}$ |
| $M_{\mathrm{budget}}$ | cuDSS post-analysis VRAM admission budget | $\mathrm{B}$ |

(perf-fem-spectral-assumptions-and-validity)=
## Assumptions and validity

- **GPU Floquet eigensolve scope:** Guarded GPU cuDSS Floquet modal shifts currently admit single
  signed Bloch vectors (`KSamplingIR::Single` with `KPoint` and `magnetostatic_bc="floquet_airbox"`,
  `operator="full_2x2"`, `damping_policy="ignore"`); multi-point `KPath` requests are rejected by
  this narrow GPU slice and run on CPU (or via the multi-process pool).
- **Adaptive dispersion process pool:** Multi-process k-point parallelism (`EigenKProcessPool`,
  `AdaptiveAdmission`) is implemented in source to bypass the process-global PETSc/SLEPc mutex,
  but end-to-end multi-run wall-time speedup and parity qualification are **not verified**.
- **FIT full-wave antenna reference:** Frequency-domain cotree-tree gauge + symmetric row scaling
  avoids explicit nanometer CFL time-step collapse, but remains a CPU FP64 research reference with
  no GPU FIT lane.
- **Wave 2 multiphysics tiering:** Tier 1 (`PETSc/MUMPS/METIS`), Tier 2 (`HYPRE` on
  `MPI_COMM_SELF`), Tier 3 (TSan-safe serial `MFEM`), and opt-in `SparseExecutionTarget::GpuCudss`
  share independent `long double` residual verification (`sparse_independent_relative_residual`).

(perf-fem-spectral-python-api)=
## Python API

```python
# %% Configure FEM GPU driven frequency response (auto cuDSS) and K0 eigenmodes
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_spectral_cudss_demo")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(160 * nm, 160 * nm, 160 * nm))

sphere = study.geometry(
    fm.Box(size=(40 * nm, 40 * nm, 40 * nm), name="nanomagnet"),
    name="nanomagnet",
)
sphere.Ms = 8.0e5
sphere.Aex = 1.3e-11
sphere.alpha = 0.01
sphere.m = fm.init.UniformMagnetization((0.0, 0.0, 1.0))

study.b_ext(0.0, 0.0, 0.1)
study.demag(model="airbox", variant="robin")
study.fem_demag_solver(gpu_strategy="auto", rtol=1.0e-8)

study.stages.add_minimize(
    stage_id="equilibrium",
    method="bb",
    tolT=1.0e-7,
    max_steps=5_000,
)
study.stages.add_eigenmodes(
    stage_id="modes_k0",
    count=4,
    target="nearest",
    target_frequency=2.8e9,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    damping_policy="ignore",
)
study.stages.add_frequency_response(
    frequencies_hz=[1.0e9, 5.0e9, 10.0e9, 15.0e9, 20.0e9],
    excitation_field_au_per_m=(1.0, 0.0, 0.0),
    include_demag=True,
    equilibrium_source="relax",
    damping_policy="include",
    solver_method="auto",
    solver_rtol=1.0e-10,
)
```

## Parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FrequencyResponseSolverPolicy.method` | `str \| None` | `None` | $1$ | `"auto"`, `"dense_reference"`, `"cpu_sparse_direct"`, `"full_coupled_field_split"`, `"schur_reduced"`, `"modal_reduced"`, `"gpu_operator_host_krylov"`, `"gpu_device_krylov"`, or `"gpu_sparse_direct"` | driven frequency-response linear solver strategy | FEM CPU/GPU (`gpu_sparse_direct` on CUDA) | `stages[].frequency_response.solver.method` |
| `study.stages.add_eigenmodes(target=...)` | `str` | `"lowest"` | $1$ | `"lowest"`, `"nearest"`, or `"window"` (`nearest` requires positive `target_frequency`) | modal shift-invert selection target | FEM CPU/GPU | `stages[].eigenmodes.target.kind` |
| `FULLMAG_K0_AUGMENTED_SHIFT` | `env int` | `1` | $1$ | `1` (augmented MUMPS+FGMRES) or `0` (legacy nested Schur) | opt-out toggle for exact augmented `K0` CPU shift-invert | FEM CPU runtime env | `provenance.shifted_preconditioner_kind` |
| `FULLMAG_FEM_DRIVEN_CUDSS_MAX_VRAM_MIB` | `env int` | device auto | $\mathrm{MiB}$ | positive MiB ceiling for driven-response cuDSS factor budget | explicit VRAM cap for GPU driven-response cuDSS | FEM GPU runtime env | `provenance.resolved_solver_method` |

(perf-fem-spectral-problem-ir)=
## ProblemIR and provenance

Frequency-response solver policies lower into `stages[].frequency_response.solver` and execute via
`fullmag_fem_frequency_domain_solve_driven_response_v14`, attesting equilibration, VRAM budget,
pivot counts, and independent unscaled residuals:

```json
{
  "stages": [
    {
      "kind": "frequency_response",
      "solver": {
        "method": "auto",
        "rtol": 1e-10
      }
    }
  ],
  "provenance": {
    "resolved_solver_method": "gpu_sparse_direct_cudss",
    "direct_solver_package": "nvidia_cudss",
    "gpu_device_resident_solver": true,
    "symbolic_analysis_count": 1,
    "numeric_factorization_count": 25,
    "max_magnetic_relative_residual_l2": 1.15e-14,
    "max_poisson_relative_residual_l2": 1.45e-14,
    "shifted_preconditioner_kind": "k0_augmented_exact_shift_mumps"
  }
}
```

## Control Room workflow

Control Room streams field and table autosaves via batched Zarr metadata writes
(`ZarrFieldMetadataBatch`), hashes large run outputs with bounded streaming I/O
(`hash_regular_file_snapshot`), serves bounded 64 MiB materialized dataset slices (`FMDS`), and
keeps interactive FDM 3D viewports responsive by building target color arrays on an off-main-thread
worker, reusing mesh topology, coalescing obsolete color jobs, scoping live field fetches to
visible layers, and deferring heavy hover picks until the pointer settles.

(perf-fem-spectral-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Requested intent versus resolved execution:** Requested intent
  (`FrequencyResponseSolverPolicy.method="auto"`, modal `target`, and multiphysics solver tier) is
  recorded independently from resolved execution (`resolved_solver_method="gpu_sparse_direct_cudss"`
  with `direct_solver_package="nvidia_cudss"` vs Krylov, `k0_augmented_exact_shift_mumps`,
  `cuda_cudss_lu`, factor VRAM, `symbolic_analysis_count`, `numeric_factorization_count`, and
  independently certified `max_magnetic_relative_residual_l2` /
  `max_poisson_relative_residual_l2`).
- **Validation errors:** Negative/missing `target_frequency` under `target="nearest"`, invalid
  `solver_method` tokens, `KSamplingIR::Path` on the narrow single-`k` GPU Floquet slice, and
  invalid VRAM caps raise explicit validation errors prior to solve.
- **Unsupported combinations:** Exceeding `M_budget` under GPU modal cuDSS fails closed with
  `cudss_peak_memory_budget_exceeded` (never falling back to CPU); explicit `gpu_sparse_direct`
  over budget fails closed without factorizing; perturbed pivots or unscaled residuals exceeding
  `rtol` are flagged explicitly rather than silently accepted.

(perf-fem-spectral-discrete-realization)=
## Discrete realization and 4-lane support matrix

| Solver | Device | Status | Realization |
|---|---|---|---|
| `FEM` | `CPU` | implemented | Augmented $(q,\phi)$ MUMPS/METIS + FGMRES shift-invert, SLEPc `ncv` sizing, Wave 2 3-tier sparse multiphysics (`MUMPS`/`HYPRE`/`MFEM`) with saddle equilibration, 0-ULP parallel `OE-F1` + fused `ProjectField`, `CompactMarkerMap`, and adaptive dispersion pool. |
| `FEM` | `GPU` | implemented | Guarded GPU cuDSS modal shifts (open-airbox `K0` & single-`k` Floquet), factor-once 2x2-prescaled Ruiz cuDSS driven response, opt-in `cuda_cudss_lu` multiphysics (`OE-F2`/charge/`M1`/`M2`), and opt-in 106-bit `DoubleDouble` CUDA `OE-F1` far-field. |
| `FDM` | `CPU` | implemented | Shared platform runtime optimizations: batched `ZarrFieldMetadataBatch` autosave, streaming `hash_regular_file_snapshot`, `FMDS` slices, and frequency-domain cotree-tree `FIT` antenna reference. |
| `FDM` | `GPU` | implemented | Shared platform runtime optimizations plus off-main-thread live FDM viewport color workers, topology reuse, and visible-layer scoped field fetches. |

(perf-fem-spectral-implementation-mapping)=
## Implementation mapping

CPU augmented modal shift-invert and SLEPc `ncv` sizing live in
`backends/fem/cpu/frequency_domain/{modal_augmented_shift_solver.hpp,poisson_airbox_schur_matshell.cpp,modal/floquet_modal_solver.cpp}`;
guarded GPU cuDSS modal shifts and inertia caching in
`backends/fem/gpu/frequency_domain/{modal_cudss_shift.cpp,modal_augmented_window_count.cpp}`;
factor-once Ruiz-equilibrated GPU driven response in
`backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu` and `backends/fem/src/api.cpp`;
Wave 2 sparse multiphysics and CUDA `DoubleDouble` `OE-F1` in
`backends/fem/cpu/mfem/common/sparse_linear_solver.{hpp,cpp}` and
`backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu`; and cross-cutting
marker/autosave/hashing systems in `backends/fem/core/fem_marker_map.hpp`,
`crates/fullmag-runner/src/artifact_pipeline.rs`, and
`crates/fullmag-workspace-inspect/src/manifest.rs`. See
{ref}`perf-fem-spectral-source-code-index`.

(perf-fem-spectral-validation)=
## Validation and verified benchmarks

### FEM CPU & GPU modal eigensolvers

- **Exact augmented $(q,\phi)$ MUMPS/METIS + FGMRES (16-core Docker DEV):**
  - `K0` real-split `4,824` (`phi = 5,244`): Poisson solves `9,886 -> 228`, EPS time
    `28.7 -> 2.7 s` (**10.6x**), total `132 -> 21.7 s` (**6.1x**).
  - `K0` real-split `10,816` (`phi = 11,352`): magnetic-only PC failed to converge in `> 3,300 s`
    versus augmented `K_tau + FGMRES` in `14.2 s` EPS / `54.7 s` total (**> 60x**).
  - Floquet `q = 644` and `2,412`: magnetic LU failed (`EPSSolve 91`), whereas `K_tau` converged
    cleanly (`15.9 s` and `65.9 s`).
- **SLEPc default `ncv` sizing (16-core Docker DEV, `n = 10,816`):** Restarts cut `30 -> 4`, EPS
  time reduced **30%--45%** (`14.9 -> 10.0 s` at `ncv = 17`, `+1.3 MiB`; `8.2 s` at `ncv = 24`).
- **Guarded GPU cuDSS modal shifts (RTX 4080 SUPER, archived `K0` sphere 1.56 GHz checkpoint,
  single run):** CPU PETSc/SLEPc `125.61 s` vs GPU cuDSS `82.71 s` (including startup &
  recertification; 5 inertia factorizations + 5 cache hits), frequency rel diff `5.0e-15`,
  phase-aligned profile overlap `1.0`, GPU residual `6.3e-12`. Single-`k` GPU Floquet passes native
  GPU pencil contract (`gpu_floquet_modal_pencil_contract.cpp`); full managed benchmark campaign is
  **not verified**.

### Factor-once Ruiz-equilibrated GPU cuDSS driven response (RTX 4080 SUPER, 1--25 GHz, $\alpha = 0.01$, `rtol = 1e-10`)

- **Open-airbox P2 Robin (`1,687` complex DOFs):** **151.3x** faster than CPU GMRES over 8
  frequencies (`31,473.6 -> 208.0 ms`) and **454x** faster amortized ms/frequency across 25
  frequencies (`3,934.2 -> 8.66 ms/freq`; CPU GMRES stalled at 9 GHz), parity `5.32e-10`.
- **`periodic_airbox_k0`:** **4.22x** (`1,690` DOF, parity `3.08e-11`) and **2.89x** (`4,410` DOF,
  parity `3.04e-11`) versus GPU GMRES.
- **Scale test (`42,907` complex DOFs):** `25/25` frequencies completed in **`6.08 s`** (`449.6 MiB`
  VRAM, `1` symbolic analysis, `0` perturbed pivots, unscaled `r_q <= 1.15e-14`,
  `r_phi <= 1.45e-14`).

### Wave 2 multiphysics sparse & parallel solvers (Threadripper 3960X + RTX 4080 SUPER, 5 build profiles PASS)

- **`OE-F2` (`VectorPotentialSolver`):** `6x6x6`: **105.5x** Tier 1 MUMPS (`3,273.2 -> 31.02 ms`,
  `err_A = 5.21e-15`) and **68.3x** Tier 2 HYPRE AMS (`47.91 ms`). Unlocks `16x16x16` (`31,024` ND
  DOFs in `1.32 s` T1 / `1.98 s` T2) and `20x20x20` (`68,921` DOFs in `3.52 s` T1 / `3.62 s` T2 at
  **`362 MiB` RSS vs ~`38 GiB` dense**, ~105x RAM reduction). IR caps raised to `2,000,000` ND DOFs
  and `1,000,000` H1 DOFs.
- **`OE-F1` (`DirectTetraQuadrature`, `8x8x8`, `3.15M` pairs):** **13.53x** CPU `W = 16`
  (`15.32 -> 1.13 s`, bit-exact `memcmp == 0`) and **18.93x** opt-in `GpuHybridFarField`
  (`0.81 s`, `max_rel_err = 5.59e-17`). Fused single-pass `ProjectField`: **3.00x** fewer kernels
  and **11.60x** faster (`8.19 -> 0.71 s`).
- **Charge, stiff `M1`/`M2`, and `OE-T0`:** 8-terminal `16x16x8` charge **8.02x** T1 / **7.69x** T2
  / **5.82x** GPU cuDSS (`ChargeTraceWorkspace` **11.60x/column**); stiff `M1`/`M2`
  ($\lambda_J = 0.015 L$, 100x contrast, AHE): **4.25x** `M1` / **5.50x** `M2` (`cuda_cudss_lu`
  `0.94 s`, T1 MUMPS `0.97 s` — converging where baseline GMRES(100) diverged at 2000 iters);
  `OE-T0` large mesh **1.22x** E2E (`6.87 -> 5.64 s`, bit-exact 3/3).

(perf-fem-spectral-limitations)=
## Limitations and rejected approaches

- **Adaptive dispersion process pool:** Implemented in source (`EigenKProcessPool`) but multi-run
  speedup and parity benchmarks are **not verified**.
- **GPU Floquet dispersion:** Multi-`k` path sweeps (`KPath`) are not yet admitted by the single-`k`
  GPU Floquet cuDSS path.
- **Main magnetic `FEM CPU` parallelism:** The main magnetic `FEM CPU` time/relaxation lane
  continues to run on `MPI_COMM_SELF` with legacy sparse CSR assembly rather than distributed
  `ParMesh` MPI, OpenMP, or libCEED partial assembly.

(perf-fem-spectral-scientific-bibliography)=
## Scientific bibliography

1. M. d'Aquino, C. Serpico, G. Miano, and C. Forestiere, "A novel formulation for the numerical
   computation of magnetization modes in complex micromagnetic systems," *Journal of Computational
   Physics* **228**, 6130--6149 (2009),
   [doi:10.1016/j.jcp.2009.05.026](https://doi.org/10.1016/j.jcp.2009.05.026).
2. V. Hernandez, J. E. Roman, and V. Vidal, "SLEPc: A scalable and flexible toolkit for the
   solution of eigenvalue problems," *ACM Transactions on Mathematical Software* **31**, 351--362
   (2005), [doi:10.1145/1089014.1089019](https://doi.org/10.1145/1089014.1089019).
3. P. R. Amestoy, I. S. Duff, J.-Y. L'Excellent, and J. Koster, "A fully asynchronous multifrontal
   solver using distributed dynamic scheduling," *SIAM Journal on Matrix Analysis and Applications*
   **23**, 15--41 (2001), [doi:10.1137/S0895479899358194](https://doi.org/10.1137/S0895479899358194).
4. D. Ruiz, "A scaling algorithm to equilibrate both rows and columns norms in matrices," *Rutherford
   Appleton Laboratory Technical Report* RAL-TR-2001-034 (2001).
5. T. V. Kolev and P. S. Vassilevski, "Parallel auxiliary space AMG for H(curl) problems," *Journal
   of Computational Mathematics* **27**, 604--623 (2009).

(perf-fem-spectral-source-code-index)=
## Where this is implemented

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Exact augmented `K0` MUMPS shift-invert | `backends/fem/cpu/frequency_domain/modal_augmented_shift_solver.hpp` | `create_augmented_shift_solver` | Build augmented `(q, phi)` MUMPS/METIS right PC for FGMRES | `FEM CPU` | 16-core DEV A/B (10.6x--60x+) |
| SLEPc default `ncv` sizing | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` | `bounded_krylov_dimensions` | Size single-shift Krylov subspace to cut restarts `30->4` | `FEM CPU` | 16-core DEV A/B (30%--45% EPS) |
| Exact augmented Floquet shift-invert | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | `create_native_floquet_augmented_shift_solver` | Augmented MUMPS/METIS shift solver for Bloch modes | `FEM CPU` | Converges where magnetic LU fails |
| Guarded GPU modal cuDSS VRAM admission | `backends/fem/gpu/frequency_domain/modal_cudss_shift.cpp` | `check_device_memory_budget` | Enforce post-analysis VRAM budget before modal factorization | `FEM GPU` | `gpu_augmented_modal_pencil_contract.cpp` |
| Exact-shift GPU inertia cache | `backends/fem/gpu/frequency_domain/modal_augmented_window_count.cpp` | `count_airbox_augmented_window` | Reuse exact scaled-shift inertia counts across bisection | `FEM GPU` | RTX 4080 SUPER K0 sphere run |
| Per-frequency GPU omega update | `backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu` | `launch_driven_response_update_omega_entries` | Update `4*N_{m,eff}` diagonal entries per sweep frequency | `FEM GPU` | RTX 4080 SUPER A/B (up to 454x) |
| Unscaled Blue/LAPACK residual cert | `backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu` | `launch_driven_response_unscaled_residual_cert` | Independently verify unscaled `(r_q, r_phi)` on GPU | `FEM GPU` | `r <= 1.45e-14` @ 42.9k DOFs |
| Driven response v14 C ABI | `backends/fem/src/api.cpp` | `fullmag_fem_frequency_domain_solve_driven_response_v14` | Factor-once 2x2-prescaled Ruiz cuDSS driven-response entry | `FEM GPU` | RTX 4080 SUPER A/B |
| Unified 3-tier + cuDSS multiphysics solver | `backends/fem/cpu/mfem/common/sparse_linear_solver.hpp` | `class SparseLinearSolver` | Unified MUMPS/HYPRE/MFEM/cuDSS solver across Wave 2 PDEs | `FEM CPU/GPU` | 5 build profiles + Wave 2 A/B |
| Nanometer saddle equilibration factor | `backends/fem/cpu/mfem/common/sparse_linear_solver.cpp` | `compute_saddle_point_equilibration_beta` | Cure `10^22` saddle-point block scale mismatch | `FEM CPU/GPU` | `OE-F2` 105.5x & `OE-T0` 1.22x |
| Equilibrated saddle CSR assembly | `backends/fem/cpu/mfem/common/sparse_linear_solver.cpp` | `assemble_equilibrated_saddle_point_csr` | Build scaled CSR saddle system for MUMPS/HYPRE/cuDSS | `FEM CPU/GPU` | `~105x` RAM cut @ 68.9k ND DOFs |
| 106-bit `DoubleDouble` CUDA `OE-F1` | `backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu` | `fullmag_cuda_direct_tetra_evaluate_root_farfield` | Opt-in GPU far-field Biot--Savart quadrature (`d_c > 3 R_s`) | `FEM GPU` | 18.93x speedup (`5.59e-17` parity) |
| Compact $O(1)$ canonical marker map | `backends/fem/core/fem_marker_map.hpp` | `class CompactMarkerMap` | Map canonical mesh markers to compact MFEM attributes | `FEM CPU/GPU` | `regional_marker_map_contract.cpp` |
| Batched Zarr field metadata autosave | `crates/fullmag-runner/src/artifact_pipeline.rs` | `ZarrFieldMetadataBatch` | Coalesce per-snapshot Zarr metadata writes on stage saves | All 4 lanes | Runner artifact pipeline tests |
| Streaming run manifest attestation | `crates/fullmag-workspace-inspect/src/manifest.rs` | `hash_regular_file_snapshot` | Stream SHA-256 hashing for large multi-GB output runs | All 4 lanes | Workspace inspect tests |
