---
title: CPU GPU Parity
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-cpu-gpu-parity)=
# CPU/GPU parity

Parity means the CPU and GPU execution lanes of one backend — or an accelerated GPU realization
versus its baseline GPU or CPU oracle — reproduce the same physical observables within strict
per-interaction tolerances while proving device residency and zero silent fallback to host
computation.

## Governance and historical snapshots

Historical snapshots (including the superseded July 2026 relaxation qualification snapshot) **must
not** be used to promote any lane. Following the August 2026 relaxation audit remediation, universal
four-lane relaxation qualification is governed by the fail-closed matrix gate (`FM-RELAX-017`; see
{doc}`qualification-status`), while the tables below report current, source-verified November 2026
device A/B and CPU/GPU parity campaigns executed inside managed Docker DEV containers in double
precision (`FP64`) unless explicitly marked `FP32`.

## Rigorous GPU residency

A strict GPU claim requires the device to remain the source of truth throughout the solver hot loop
with zero full-vector host compute transfers and zero silent fallback:

- **FEM strict GPU residency counters**:
  `hot_loop_compute_h2d_bytes = 0`, `hot_loop_compute_d2h_bytes = 0`, and
  `hot_loop_compute_host_sync_count = 0` (scalar control readbacks for stopping criteria and
  residual certification are accounted separately from compute transfers). The legacy box500
  enforcement harness is
  [`scripts/analysis/fem_gpu_benchmark.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/analysis/fem_gpu_benchmark.py)
  (`--require-gpu-strict-residency`, `--box500-airbox-interaction-consistency-preset`,
  `just bench-fem-box500-consistency`), whose full managed rerun remains tracked separately from
  the targeted November 2026 A/B suites below.
- **FDM strict GPU execution receipt**:
  `required == executed_device`, `executed_unknown = 0`, `fallback_count = 0`,
  `hot_loop_full_vector_h2d_count = 0`, `hot_loop_full_vector_d2h_count = 0`, and
  `hot_loop_host_compute_count = 0`.

## November 2026 FDM GPU parity campaigns

All FDM CUDA A/B benchmarks below ran on **NVIDIA GeForce RTX 4080 SUPER** ($16\;\mathrm{GiB}$
VRAM, SM 8.9, CUDA runtime 12.6, `cuDSS 0.8.0.10`) inside isolated Docker DEV containers. See
{ref}`numerical-methods-performance-fdm-core` for implementation details.

### FDM GPU core: D2Z/Z2D cuFFT, device-resident PG-BB, and M1 charge (PR #561)

| Suite / workload | Scope and precision | Parity vs reference / baseline | Residency & fallback | Measured speedup & VRAM |
|---|---|---|---|---|
| **Single-layer demag FFT (`D2Z`/`Z2D`, `R2C`/`C2R`)** | 34 executable LLG cases (`Heun`/`RK4`, `FP64`/`FP32`, `50`/`500`/`2000` steps; `256×256×1`, `128×128×2`, `64×64×32`, `pbcxy`, cylinder) | **FP64:** at 50 steps $\Delta E_{\mathrm{total}} / \lvert E_{\mathrm{total}} \rvert = 0.0$ ($\Delta E_{\mathrm{demag}}$ rel. $\le 1.76 \times 10^{-16}$); at 500 steps rel. $\Delta E_{\mathrm{total}} \le 2.63 \times 10^{-14}$ and $\max\lVert \Delta\mathbf{m} \rVert \le 1.22 \times 10^{-8}$. **FP32:** at 50 steps rel. $\Delta E_{\mathrm{total}} \le 2.00 \times 10^{-9}$; at 500 steps $5.40 \times 10^{-6}\text{–}1.29 \times 10^{-4}$ (`pbcxy` + FP32 rejected fail-closed). | Device-resident; `0` fallback | **`1.09×–3.21×`** per-step (`3.21×` on `128×128×2` Heun FP64; `2.47×` on `64×64×32` RK4 FP64); **`12.0%–23.1%`** GPU workspace VRAM saved |
| **Single-layer `native_cuda_pgbb`** | $300\times 300\times 5\;\mathrm{nm}$ (`120×120×2`, `tolT = 1e-7 T`) & `256×256×2` (`200` steps), `strict` and `extended` FP64 | `120×120×2` equilibrium: rel. $\Delta E_{\mathrm{total}} = 5.62 \times 10^{-11}$, rel. $\Delta E_{\mathrm{demag}} = 3.34 \times 10^{-9}$, rel. $\Delta E_{\mathrm{ex}} = 2.38 \times 10^{-8}$, $\max\lVert \Delta\mathbf{m} \rVert = 2.73 \times 10^{-5}$ | `hot_loop_full_vector_h2d = 0`, `d2h = 0`, `host_compute = 0`, `fallback_count = 0`, `required = 0xa7 == executed_device` | **`5.84×–9.65×`** wall speedup (`~11×` relaxation stage: $185.0 \to 15.0\;\mathrm{s}$); **`-23.0%`** workspace VRAM |
| **M1 charge GPU AMG-PCG (6–7 levels)** | 13 C ABI cases (`U`, `M`, `I`, `F`, `Z`, `boundary_ref` & `zero_mean`, `1 485–65 536` cells) + 2 public CLI runs, FP64 (`rtol = 1e-13`) | $\mathrm{rel}\,\max\lvert \Delta V \rvert \le 4.32 \times 10^{-14}$, $\mathrm{rel}\,\max\lvert \Delta J_c \rvert \le 1.77 \times 10^{-12}$, `phys_res` $\le 1.75 \times 10^{-13}$ | `host_fallbacks = 0` | **`1.46×–7.48×`** warm (`4.49×–7.48×` for $16\text{k–}65.5\text{k}$ cells); **`-19.5%`** peak VRAM at `65 536` cells |
| **M1 charge GPU opt-in `cuDSS`** | Same 13 C ABI cases + 2 public CLI runs, FP64 (`FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss`) | $\mathrm{rel}\,\max\lvert \Delta V \rvert \le 4.12 \times 10^{-13}$, $\mathrm{rel}\,\max\lvert \Delta J_c \rvert \le 3.50 \times 10^{-12}$, `phys_res` $= 5.57 \times 10^{-16}\text{–}8.15 \times 10^{-15}$ | `host_fallbacks = 0` | **`1.36×–8.53×`** warm (`8.53×` on `Z_64x32x8`, `7.37×` on `U_128x64x8`) |

### FDM GPU STT, SHE, and coupled M1 spin transport (PR #562)

| Workload (FP64, RTX 4080 SUPER) | Grid | Parity across baseline vs candidate | Kernel & residency counters | Measured speedup |
|---|---|---|---|---|
| **Full SHE M1** (positive & reversed current, 13 / 9 RK4 steps) | $32 \times 16 \times 7$ | **Bit-identical** `m_final`, `V_electric`, `J_charge`, `spin_potential`, `spin_current_tensor`, and `torque_stt` | Zero fallback; zero hot-loop full-vector transfers | **`46×`** CLI wall ($177.58 \to 3.86\;\mathrm{s}$; spin stage median $2675.63 \to 14.27\;\mathrm{ms}$, field recovery $2662.54 \to 1.41\;\mathrm{ms}$) |
| **Full SHE M1** (4 RK4 steps) | $128 \times 64 \times 7$ | **Bit-identical** `m_final` and all 5 M1 transport/torque fields | Zero fallback; zero hot-loop full-vector transfers | **`1.8×`** spin stage ($63.19 \to 34.65\;\mathrm{ms}$; assembly $18.60 \to 0.63\;\mathrm{ms}$) |
| **Pulsed Slonczewski STT & prescribed SOT** (RK45) | $512 \times 256 \times 1$ | **Bit-identical** `m_final` across both pairs | Separate RHS kernel calls reduced **`2569 → 0`** (STT) and **`1463 → 0`** (SOT); zero fallback | Parity-preserving kernel fusion (short-run wall clock neutral on single-layer grid) |

## November 2026 FEM GPU parity campaigns

FEM GPU campaigns cover both **RTX 5050** ($8\;\mathrm{GiB}$, PR #550 `cuDSS` PoC and thin-film
check) and **RTX 4080 SUPER** ($16\;\mathrm{GiB}$ SM 8.9, PR #564, #567, #577, #578) in double
precision (`FP64`). See {ref}`numerical-methods-performance-fem-gpu-demag`,
{ref}`numerical-methods-performance-fem-gpu-kernels`, and
{ref}`numerical-methods-performance-fem-spectral-multiphysics` for architectural details.

### FEM GPU core demagnetization and explicit time-stepping (PR #550 / PR #564)

| Scenario (50 timed steps, FP64, `rtol = 1e-8`, RTX 4080 SUPER unless noted) | Integrator | Reference / comparison | Parity ($\max\lVert \Delta\mathbf{m} \rVert_\infty$, rel. $\lvert \Delta E_{\mathrm{demag}} \rvert$) | Certified residual & residency | Speedup |
|---|---|---|---|---|---|
| **Open-airbox Poisson `cuDSS` PoC** (PR #550, RTX 5050, `14.9k–89.7k` nodes, 20 steps) | Heun | `cuDSS` vs `CG/AMG` | $\max\lVert \Delta\mathbf{m} \rVert_\infty \le 4.7 \times 10^{-10}$, rel. $\Delta E_{\mathrm{demag}} \le 1.7 \times 10^{-11}$; $300\times 300\times 5\;\mathrm{nm}$ prism P1 relaxation final rel. $\Delta E_{\mathrm{total}} = 5.9 \times 10^{-12}$ | `cuDSS` $\le 2.6 \times 10^{-15}$; default path bit-identical | **`11.7×–36×`** per step (`29×` per step on prism P1 relaxation) |
| **Open-airbox Poisson SP4 & medium** (PR #564: `8 208` nodes / `60 791` $P_2$ DOFs and `49 600` nodes / `380 701` $P_2$ DOFs) | Heun, RK4 | `auto` (`cudss_direct`) & `cg_amg` vs baseline | `auto`: $\max\lVert \Delta\mathbf{m} \rVert_\infty \le 2.51 \times 10^{-11}$, rel. $\lvert \Delta E_{\mathrm{demag}} \rvert \le 4.48 \times 10^{-11}$ | `max_res` $= 1.08 \times 10^{-14}\text{–}8.22 \times 10^{-14}$; `0` compute syncs; FSAL `3→2` (Heun), `5→4` (RK4) | **`19.1×–218.4×`** (`auto` `cuDSS`); **`1.24×–2.19×`** (`cg_amg` via FSAL + 2-step predictor) |
| **VRAM budget cap** (`MAX_VRAM_MIB = 32`, `49 600` nodes) | Heun | `auto` fallback vs `cg_amg`; forced `cudss` | `auto → hypre_krylov`: **bit-identical (`0.0` in $\mathbf{m}$ and $E$)** vs `cg_amg`; forced `cudss` rejects (`rc = 2`, zero fallback) | `factorization_started = false`, `cudss_factor_exceeds_vram_budget` | **`1.86×`** vs baseline under `auto` fallback |
| **GPU FEM/BEM open geometry** (`1 183` nodes, `5 184` `tet4`, no airbox) | Heun | Atomic `(u1, u2)` `cuDSS` vs CPU FEM/BEM oracle (`rtol = 1e-10`) | $\max\lVert \Delta\mathbf{m} \rVert_\infty = 4.88 \times 10^{-14}$, rel. $\lvert \Delta E_{\mathrm{demag}} \rvert = 1.54 \times 10^{-14}$, rel. $\lVert \Delta\mathbf{H}_{\mathrm{demag}} \rVert_\infty = 2.27 \times 10^{-13}$ | `max_res` $= 1.10 \times 10^{-23}$; `0` `compute-sanitizer` errors | **`34.6×`** vs GPU AMG, **`19.5×`** vs GPU Jacobi, **`5.4×`** vs CPU ($2.20$ vs $11.97\;\mathrm{ms/step}$) |
| **PBC-reduced Poisson 1D Robin & 2D film pin** (`8 379` nodes, $P_1$) | Heun, RK4 | `auto` (`cudss_direct`) vs baseline | $\max\lVert \Delta\mathbf{m} \rVert_\infty \le 3.51 \times 10^{-11}$, rel. $\lvert \Delta E_{\mathrm{demag}} \rvert \le 1.22 \times 10^{-10}$ | `max_res` $\le 1.87 \times 10^{-14}$; `fsal_reused = true` from step 2 | **`26.8×–35.5×`** (`auto` `cuDSS`); **`1.27×–1.51×`** (`cg_amg`) |

### FEM GPU `pure_prism_p2` and unified CSR DMI (PR #577)

| Component (FP64, RTX 4080 SUPER) | Workload / mesh coverage | Parity vs CPU MFEM / legacy GPU | Verification & sanitizer | Measured speedup |
|---|---|---|---|---|
| **`pure_prism_p2` CPU vs GPU contract** (`fem_pure_prism_p2_gpu_contract`) | Extruded `prism6` + $P_2$ scalar potential with DMI (`cg_amg` and `cuDSS`) | RK4 $\le 10^{-10}$, PGBB $\le 10^{-9}$ CPU vs GPU across both linear-solver strategies | `hot_loop_gather_scatter_bytes = 0` on completed film runs | **`144.8×`** per step (`cuDSS` $38.53\;\mathrm{ms}$ vs `cg_amg` $5\,579.74\;\mathrm{ms}$ at $L=1$, $h = 5.0\;\mathrm{nm}$, $594\,239$ $P_2$ DOFs) |
| **Unified CSR GPU DMI** (`dmi_csr_*`) | 15 configurations: `tet4`, `tet4` periodic 2D ($P^{\mathsf{T}} D P$), `prism6` (`60×60×2`, `120×120×2`), `mixed` (`prism6+pyramid5+tet4`); interfacial oblique, rotated Göbel, and bulk DMI | $h_{\mathrm{rel}} \le 1.12 \times 10^{-15}$, $E_{\mathrm{rel}} \le 4.76 \times 10^{-14}$ vs CPU MFEM ($h_{\mathrm{rel}} \le 4.12 \times 10^{-16}$ vs legacy `tet4` GPU) | `compute-sanitizer --tool memcheck`: **0 errors** | **`780×–4,812×`** vs CPU MFEM on full-scale `tet4` / `prism6` (`180×–4,812×` across all 15 configs); **`1.67×–4.80×`** vs legacy `tet4` GPU |

### FEM GPU Wave 3: `bb_exchange_mass` PGBB, short-range kernels, and Driven Response `cuDSS` (PR #578)

| Track (FP64, RTX 4080 SUPER) | Benchmark scope | Parity & numerical accuracy | Safety & memory gates | Measured speedup |
|---|---|---|---|---|
| **Track 1: GPU PGBB `bb_exchange_mass`** (`auto → exchange_mass` with active exchange) | SP4 `h = 3 nm` (`cuDSS` & `CG+AMG`), ultra-fine `h = 2 nm`, exchange+Zeeman slab | Rel. $\Delta E_{\mathrm{total}} = 2.0 \times 10^{-14}\text{–}9.0 \times 10^{-12}$ vs CPU PGBB; exact step-count match (`39`, `29`, `53`); `0` Armijo monotonicity violations; `max_pcg_res < 1e-10`; bit-identical `none` trajectory | `0` `compute-sanitizer` errors; `-3.0` sync/step (`exchange_mass`), `-2.0` sync/step (`none` + demag) | **`6.18×–10.52×`** fewer PGBB steps; **`2.82×–6.11×`** faster (`2.82×–3.79×` `cuDSS`, `6.11×` `CG+AMG`) |
| **Track 2: Short-range GPU kernels & packed AoS↔SoA** | 3D `tet4` (`33 150` nodes, `180 000` tets), 7 simultaneous interactions (Exchange + iDMI + bDMI + Uniaxial + Cubic + MEL + Zeeman), 50-step RK4 (200 stages) | $\max_{\mathrm{rel}}(\mathbf{m}) = 4.53 \times 10^{-16}$, $\max_{\mathrm{rel}}(\mathbf{H}_{\mathrm{eff}}) = 1.65 \times 10^{-15}$, rel. $\Delta E_{\mathrm{total,ex,ani,mel}} = 0.0$, rel. $\Delta E_{\mathrm{dmi}} = 1.62 \times 10^{-15}$ | `0` `compute-sanitizer` errors; relaxation keeps compensated double-double exchange | **`1.80×`** E2E RK4; **`2.54×`** DMI RK, **`8.02×`** Exchange FMA, **`17.5×`** fused $\mathbf{H}_{\mathrm{eff}}$ (`21→1` launches), **`13.93×`** `state_io`, **`40.5×`** D2H / **`6.30×`** H2D |
| **Track 3: GPU Driven Response `cuDSS`** | Open-airbox $P_2$ (`1 687–42 907` complex DOFs) & `periodic_airbox_k0` (`1 690–4 410` DOFs), $1\text{–}25\;\mathrm{GHz}$ RF sweeps, `rtol = 1e-10` | Complex `vector_tangent_complex` parity `rel_l2` $= 3.04 \times 10^{-11}\text{–}3.08 \times 10^{-11}$ vs GPU GMRES and $5.32 \times 10^{-10}$ vs CPU GMRES; residuals $r_q \le 1.15 \times 10^{-14}$, $r_\phi \le 2.90 \times 10^{-13}$ | `0` perturbed pivots after $2\times 2$ block pre-scaling + 6× Ruiz; `0` `compute-sanitizer` errors; `AUTO` VRAM cap fallback bit-identical (`0.0`), `REQUIRED` fails closed | **`151.3×–454×`** vs CPU GMRES (open-airbox); **`2.89×–4.22×`** vs GPU GMRES (`periodic_airbox_k0`); `42 907` DOFs (`25` freq) in `6.08 s` (`449.6 MiB` VRAM) |

### FEM Multiphysics Wave 2 (PR #567)

| Multiphysics solver (FP64, RTX 4080 SUPER) | Workload | GPU parity vs CPU reference / MUMPS | Speedup vs baseline |
|---|---|---|---|
| **Oersted OE-F1 `GpuHybridFarField`** (`106`-bit `TwoSum` double-double GPU far-field + CPU Duffy singular pairs) | `8×8×8` (`3.15M` pairs, `124.65M` kernel evals, `1 024` targets including vertices/edges/faces) | $\max_{\mathrm{rel}} = 5.59 \times 10^{-17}$ across all `1 024` points (`3 138 698` GPU + `7 030` CPU singular pairs); CPU threaded `W = 1..16` is 0-ULP bit-exact (`memcmp == 0`) | **`18.93×`** vs single-thread baseline (`1.40×` vs 16-thread CPU) |
| **8-terminal charge `cuda_cudss_spd`** | `16×16×8` (`2 601` vertices, 8 disjoint terminals, factor-once multi-RHS) | $\mathrm{err}_V \le 2.04 \times 10^{-12}$, $\mathrm{err}_I \le 4.25 \times 10^{-12}$, `rel_res` $\le 5.26 \times 10^{-14}$ | **`5.82×`** (`8.02×` CPU MUMPS, `7.69×` CPU HYPRE) |
| **Stiff M1/M2 drift-diffusion `cuda_cudss_lu`** | `12×12×12` ($\lambda_J = 0.015 L$, $100\times$ conductivity contrast, AHE) | $\mathrm{err}_{\mathrm{GPU\,vs\,MUMPS}} \le 4.99 \times 10^{-15}$, `res` $\le 5.74 \times 10^{-15}$; converges cleanly where baseline GMRES stalled at 2 000 iterations | **`4.25×`** M1 / **`5.50×`** M2 |

### FEM GPU Open-Airbox Eigensolve (PR #539) and Guarded `cuDSS` Single-$k$ Floquet (PR #558)

- **Open-airbox Robin $k = 0$ GPU eigensolve (PR #539):** Implements the dedicated CUDA `cuDSS`
  augmented sparse adapter (`k0_poisson_airbox_gpu_augmented_cudss`) for FP64 nondissipative exact
  $k = 0$ open-airbox modal solves, combining CUDA Graphs, cuSPARSE/cuSOLVER Ritz projection,
  original-block residual verification, guarded Hermitian inertia window certificates
  (`poisson_airbox_augmented_inertia_window_certificate.v1`), and CUPTI iteration tracing with zero
  compute transfers or allocations in the iteration loop. Forced GPU never falls back to CPU.
- **Guarded `cuDSS` memory admission and single-$k$ Floquet contract (PR #558):** Adds a shared
  post-analysis device memory budget check
  ([`check_device_memory_budget`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_cudss_shift.cpp#L171),
  reserve $M_{\mathrm{reserve}} = \max(512\;\mathrm{MiB}, 0.05 M_{\mathrm{device}})$, fail-closed
  `cudss_peak_memory_budget_exceeded` with zero CPU fallback) together with the native single-$k$
  GPU Floquet adapter
  ([`solve_gpu_floquet_shared_domain`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2168)
  and
  [`solve_floquet_airbox_augmented_ritz`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/modal_augmented_ritz.cu#L830),
  attestation `augmented_floquet_cudss_cuda`). **Qualification boundary:** Native contract tests
  and fail-closed memory admission are implemented in source, whereas end-to-end managed workflow
  qualification, multi-$k$ path sweeps (`KSamplingIR::Path`), and full CPU/GPU dispersion parity
  remain open; public GPU Floquet workflows remain fail-closed until closed.

## What counts as evidence

Compiling CUDA code on a host, loading a CUDA library, or passing a source-only counter check is
not parity proof. Parity is claimed only when executed same-workload CPU and GPU (or baseline and
candidate GPU) artifacts agree within documented tolerances, record their device and source
identities, and prove zero silent fallback.

## Related performance references

- {ref}`numerical-methods-performance` — Performance and computational optimizations overview
- {ref}`numerical-methods-performance-fdm-core` — FDM CUDA FFT, resident PG-BB, M1 transport, and STT/SHE
- {ref}`numerical-methods-performance-fem-gpu-demag` — FEM GPU `cuDSS` Poisson, FEM/BEM, PBC, and `pure_prism_p2`
- {ref}`numerical-methods-performance-fem-gpu-kernels` — FEM GPU `bb_exchange_mass`, CSR DMI, and short-range kernels
- {ref}`numerical-methods-performance-fem-spectral-multiphysics` — FEM Driven Response `cuDSS`, modal eigensolvers, and Wave 2 multiphysics
