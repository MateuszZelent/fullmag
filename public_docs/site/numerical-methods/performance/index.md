---
title: Computational Optimizations and Hardware Acceleration
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(numerical-methods-performance)=
# Computational Optimizations and Hardware Acceleration

:::{admonition} Four-lane evidence discipline
:class: important

FullMag separates physical model definitions from numerical realizations and hardware execution
lanes (`FDM CPU`, `FDM GPU`, `FEM CPU`, and `FEM GPU`). Every optimization documented in this
section is anchored to concrete source declarations, explicit algebraic or memory-layout
invariants, fail-closed preflight and provenance contracts, and measured A/B parity and runtime
evidence on identified hardware. Where a mechanism is implemented in source or covered only by
unit/contract tests without a multi-run wall-time benchmark, this documentation marks runtime
speedup as **not verified** rather than extrapolating.
:::

## Acceleration architecture across the four execution lanes

Micromagnetic and multiphysics workloads in FullMag span four distinct computational bottlenecks:

1. **Long-range magnetostatics (demagnetization):** FFT convolution on Cartesian grids (`FDM`) and
   elliptic scalar-potential solves (`FEM` open/periodic Poisson airbox and hybrid `FEM/BEM`
   Fredkin--Koehler).
2. **Stiff relaxation and explicit time integration:** Exchange-stiffness conditioning
   $\kappa \propto h^{-2}$ in projected-gradient Barzilai--Borwein (`PG-BB`) minimization,
   repeated right-hand-side evaluations across Runge--Kutta stages, and host--device
   synchronization overhead.
3. **Coupled transport and multiphysics operators:** Steady charge Poisson, drift-diffusion spin
   transport (`M1`/`M2`), Oersted vector-potential (`OE-F2`) and direct Biot--Savart quadrature
   (`OE-F1`), and conservative saddle-point (`OE-T0`) systems.
4. **Spectral and linear-response workflows:** Shift-invert eigenmode extraction (`K0` and
   Floquet) and multi-frequency driven susceptibility sweeps across coupled magnetization and
   dynamic scalar-potential blocks.

FullMag accelerates each bottleneck through lane-specific algorithms that preserve SI definitions,
discrete variational identities, and requested-versus-resolved provenance:

| Execution lane | Primary computational bottlenecks addressed | Key production optimizations |
|---|---|---|
| `FDM CPU` | Cache/indexing overhead in regular-grid loops, FFT cost | Rayon-parallel persistent SoA hot loops with serial deterministic energy reductions, row-wise exchange indexing, 3D real-to-complex FFT (`R2c3dPlan`), and analytical Newell kernel deduplication (`KernelReuseCatalog`). |
| `FDM GPU` | Single-layer FFT memory/bandwidth, host-round-trip `PG-BB`, M1 charge/spin solves | Batched single-layer `D2Z`/`Z2D` and `R2C`/`C2R` cuFFT, exact cuFFT workspace preflight, device-resident `native_cuda_pgbb`, unbounded precomputed face-exchange weights and uniform fast path, FSAL RK23/DP45, 6--7 level cooperative geometric AMG-PCG and opt-in cuDSS charge solver, $O(\log N)$ binary-search M1 spin lookup and multi-block CUB closure diagnostics, deferred accepted-endpoint spin observation materialization, and fused FP64 RK45 STT/SOT kernels. |
| `FEM CPU` | Nested Schur eigenmode solves, dense Oersted/multiphysics solves, multi-`k` dispersion throughput | Exact augmented $(q,\phi)$ sparse MUMPS/METIS shift-invert with right-preconditioned FGMRES, SLEPc `ncv` sizing, 3-tier sparse multiphysics solver (`MUMPS`/`HYPRE`/`MFEM`) with nanometer saddle-point equilibration, 0-ULP parallel `OE-F1` quadrature with fused `ProjectField`, factor-once multi-RHS charge transport, compact $O(1)$ canonical marker maps, and adaptive multi-process dispersion pool. |
| `FEM GPU` | Iterative HYPRE launch latency on Poisson/FEM-BEM, thin-film `tet P2` DOF explosion, unpreconditioned `PG-BB`, short-range kernel launch overhead, Krylov driven-response stalls | Three-state `auto`/`cg_amg`/`cudss` direct Cholesky demag (open Poisson, 1D/2D PBC Poisson, atomic FEM/BEM pair) with VRAM preflight, multi-block CUB residual certification, BoomerAMG coarse relax type 18, explicit RK FSAL `k0` reuse and two-step linear potential predictor, `pure_prism_p2` shared-domain wedge discretization, unified preassembled CSR GPU DMI, qualified cooperative PCG `bb_exchange_mass` preconditioning with host-sync reduction, dual-path FMA/double-double CSR exchange, single-launch fused $H_{\mathrm{eff}}$, contiguous device AoS--SoA packing, guarded GPU cuDSS modal shifts (open-airbox `K0` and single-`k` Floquet), factor-once Ruiz-equilibrated cuDSS driven response, and opt-in 106-bit `DoubleDouble` CUDA `OE-F1` far-field. |

## Master summary of verified A/B speedups

All speedup ratios below are sourced from controlled A/B campaigns on identified hardware with
verified numerical parity against the unmodified baseline or CPU reference. They are workload- and
hardware-specific measurements, not universal scaling guarantees.

| Subsystem & optimization | Lane | Hardware & representative workload | Verified A/B speedup | Parity / memory note | Detailed page |
|---|---|---|---|---|---|
| Batched `D2Z`/`Z2D` & `R2C`/`C2R` single-layer cuFFT | `FDM GPU` | RTX 4080 SUPER, `128x128x2` Heun / `64x64x32` RK4 | **3.21x** FP64, **2.76x** FP32 / **2.47x** FP64 | `-12.0%` to `-23.1%` peak VRAM; 50-step `rel dE_total = 0` | {doc}`fdm-gpu-and-cpu-acceleration` |
| Device-resident `native_cuda_pgbb` | `FDM GPU` | RTX 4080 SUPER, `120x120x2` Permalloy (`tolT = 1e-7 T`) | **5.84x** cold, **9.65x** warm (**~11x** relax stage) | Hot-loop transfers `40.25 GB -> 0 B`; `-23.0%` VRAM; `rel dE = 5.62e-11` | {doc}`fdm-gpu-and-cpu-acceleration` |
| Rayon-parallel persistent SoA & row-wise exchange | `FDM CPU` | 4-thread CPU, `128x128x32` Heun (exchange-only / full) | **2.93x** exchange-only / **1.29x** full demag | Bit-identical SHA-256 `m_final` | {doc}`fdm-gpu-and-cpu-acceleration` |
| Multi-block 6--7 level cooperative AMG-PCG & opt-in cuDSS charge | `FDM GPU` | RTX 4080 SUPER, `128x64x8` (65,536 cells) / `64x32x8` | **7.48x** AMG-PCG / **8.53x** opt-in cuDSS warm | `-19.5%` VRAM (AMG); `rel max\|dV\| <= 4.32e-14` | {doc}`fdm-transport-acceleration` |
| Binary-search M1 spin lookup & multi-block CUB closure | `FDM GPU` | RTX 4080 SUPER, `32x16x7` / `128x64x7` beta-W/CoFeB | **46.0x** CLI (**187.5x** spin stage, **1888x** field+closure) / **1.82x** stage | Bit-identical fields; removes 4096-cell diagnostic cap | {doc}`fdm-transport-acceleration` |
| Auto-cuDSS direct demag (open Poisson, PBC, atomic FEM/BEM) | `FEM GPU` | RTX 4080 SUPER, `8,208` / `49,600` nodes P2; `1,183` FEM/BEM | **218.4x** (8k Heun), **20.36x** (49.6k Heun), **34.6x** FEM/BEM vs GPU AMG | `max\|dm\| <= 5.97e-12` (open) / `4.88e-14` (FEM/BEM vs CPU); fail-closed VRAM guard | {doc}`fem-gpu-demag-and-time-stepping` |
| Explicit RK FSAL `k0` reuse & two-step linear potential predictor | `FEM GPU` | RTX 4080 SUPER (`cg_amg` lane), `49,600` nodes P2 | **1.87x** Heun (`-48.0%` PCG iters), **2.19x** RK4 (`-53.9%` iters) | Zero overhead no-op under `cuDSS` | {doc}`fem-gpu-demag-and-time-stepping` |
| `pure_prism_p2` thin-film wedge P2 discretization | `FEM GPU` | RTX 4080 SUPER, `300x300x5 nm` film (`L=1,2`, `h=5 nm`) | **246x** meshing vs `tet P2`; **144.8x** vs `cg_amg`; **~197x** vs `tet P2` | **5.76x** fewer DOFs than `tet P2`; Aharoni error `-0.60%` vs `-30.11%` mixed P1 | {doc}`fem-gpu-demag-and-time-stepping` |
| Qualified cooperative PCG `bb_exchange_mass` & sync reduction | `FEM GPU` | RTX 4080 SUPER, SP4 `h=3 nm` & `h=2 nm` + airbox | **6.18x--10.52x** fewer steps; **2.82x--3.79x** wall (`cuDSS`), **6.11x** (`CG+AMG`) | Matches CPU step count identically (`24.0x--28.5x` vs CPU); `memcheck` 0 errors | {doc}`fem-gpu-relaxation-and-kernels` |
| Unified CSR GPU DMI, FMA exchange, fused $H_{\mathrm{eff}}$, packed AoS--SoA | `FEM GPU` | RTX 4080 SUPER, `33,150` nodes / `180,000` TET4 & `120x120x2` prism | **1.80x** 50-step RK4 E2E; **8.02x** Exch FMA; **17.5x** $H_{\mathrm{eff}}$; **40.5x** D2H; **1,953x--4,812x** prism DMI vs CPU | `max_rel(m) = 4.53e-16`; 0-ULP Oersted accumulation; `0 B` extra transfer VRAM | {doc}`fem-gpu-relaxation-and-kernels` |
| Augmented $(q,\phi)$ MUMPS/METIS + FGMRES shift-invert | `FEM CPU` | 16-core Docker DEV, `4,824` / `10,816` `K0` & Floquet | **10.6x** EPS (**6.1x** total) at 4.8k; **>60x** at 10.8k (`54.7 s` vs `>3300 s`) | Converges on Floquet cases where magnetic-only PC fails | {doc}`fem-spectral-multiphysics-and-platform` |
| Guarded GPU cuDSS driven frequency response (factor-once + Ruiz) | `FEM GPU` | RTX 4080 SUPER, 1--25 GHz, `1,687` to `42,907` complex DOFs | **151.3x** vs CPU GMRES (8 freqs), **454x** amortized ms/freq; **2.89x--4.22x** vs GPU GMRES | Scales to `42,907` DOFs (`6.08 s` for 25 freqs, `449.6 MiB`); `r <= 1.45e-14` | {doc}`fem-spectral-multiphysics-and-platform` |
| Wave 2 sparse/parallel multiphysics (`OE-F2`, `OE-F1`, charge, `M1`/`M2`) | `FEM CPU/GPU` | Threadripper 3960X + RTX 4080 SUPER | **105.5x** `OE-F2` (`~105x` RAM cut); **18.93x** `OE-F1` hybrid GPU; **8.02x** charge; **5.50x** stiff `M2` | Converges on stiff `M1`/`M2` where baseline GMRES(100) diverged; `memcmp == 0` CPU `OE-F1` | {doc}`fem-spectral-multiphysics-and-platform` |

## Fail-closed preflight and provenance discipline

Performance optimizations in FullMag follow three strict engineering contracts:

1. **Pre-allocation memory preflight:** Both CUDA cuFFT (`FDM`) and cuDSS direct Cholesky/LU
   solvers (`FDM` charge, `FEM` demag, `FEM` modal eigensolve, `FEM` driven response) query exact
   device workspace or post-analysis peak factor estimates before allocating large device buffers,
   retaining an explicit VRAM reserve and failing closed without partial leaks when over budget.
2. **Requested intent versus resolved execution:** Public policies such as
   `FemLinearSolverPolicy(gpu_strategy="auto")`, `study.fem_bb_preconditioner("auto")`, and
   `FrequencyResponseSolverPolicy(method="auto")` distinguish user intent from the runtime
   realization. Any graceful fallback under `auto` records an explicit machine-readable fallback
   reason in execution provenance, whereas explicit strict selections (`"cudss"`,
   `"exchange_mass"`, `"gpu_sparse_direct"`) fail closed rather than silently substituting another
   solver.
3. **Zero silent CPU fallback on GPU lanes:** Strict GPU requests never fall back silently to CPU
   routines; operator execution receipts verify that every active term executed on the intended
   device lane.

## Evidence-based rejected and deferred optimizations

Maintaining scientific fidelity requires documenting candidate optimizations that were evaluated
and intentionally rejected or deferred rather than shipped:

| Candidate optimization | Target lane | Decision | Verified engineering rationale |
|---|---|---|---|
| Deterministic delta-potential demagnetization (`phi = phi_0 + dphi`) | `FEM GPU` | **Rejected (NO-GO)** | Failed p95 wall-time, attribution, and parity gates in formal remediation closure; removed from production. |
| HYPRE async / Umpire memory pools & BoomerAMG relax type 6 | `FEM GPU` | **Rejected (NO-GO)** | Did not clear p95 speedup or stability gates; coarse-level residency is instead solved by BoomerAMG relax type 18 and direct `cuDSS`. |
| Historical lumped-mass NCG CG4/CG8 preconditioner | `FEM GPU` | **Rejected (NO-GO)** | Superseded by consistent-mass cooperative PCG `bb_exchange_mass` on `PG-BB`, which matches CPU step counts exactly. |
| CUDA Graph capture around `FEM GPU` explicit RK + `cuDSS` | `FEM GPU` | **Deferred** | cuDSS `0.8.0.10` performs internal stack-backed small H2D transfers during `CUDSS_PHASE_SOLVE`, and residual certification branches on host telemetry. |
| Automated CPU/GPU runtime crossover dispatch (`rtx4080-sm89.json`) | `FEM CPU/GPU` | **Unqualified (`qualified: false`)** | Dispatch infrastructure exists, but crossover profiles are intentionally unqualified; availability-first explicit device selection remains canonical. |
| Distributed `ParMesh` MPI / OpenMP / libCEED partial assembly for main magnetic FEM | `FEM CPU` | **Not implemented** | Main magnetic `FEM CPU` lane runs on `MPI_COMM_SELF` with legacy sparse CSR assembly. |

## Optimization reference pages

```{toctree}
:maxdepth: 1

fdm-gpu-and-cpu-acceleration
fdm-transport-acceleration
fem-gpu-demag-and-time-stepping
fem-gpu-relaxation-and-kernels
fem-spectral-multiphysics-and-platform
```
