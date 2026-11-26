---
title: FEM GPU Relaxation Preconditioning and Short-Range Kernels
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(numerical-methods-performance-fem-gpu-kernels)=
# FEM GPU Relaxation Preconditioning and Short-Range Kernels

(perf-fem-gpu-kernels-problem-statement)=
## Scope and purpose

Once direct `cuDSS` demagnetization shrinks scalar-potential solves from hundreds of milliseconds
to single-digit milliseconds, relaxation iteration counts and short-range kernel/transfer overhead
dominate `FEM GPU` wall time. This page documents the qualified Wave 1 and Wave 3 optimizations
that address those remaining bottlenecks while preserving discrete variational derivatives and
energy monotonicity:

1. **Qualified cooperative-PCG exchange-mass preconditioning (`bb_exchange_mass`)** for `FEM GPU`
   projected-gradient Barzilai--Borwein (`PG-BB`), promoted to default under `policy="auto"` when
   exchange is active, together with **PGBB host--GPU synchronization reduction** (`-3.0`
   syncs/step) and fused trial-energy reuse (`3 -> 1` reductions).
2. **Unified preassembled skew-symmetric CSR GPU DMI** across `tet4`, `prism6`, and mixed meshes
   (bulk, interfacial, Goebel rotated, and periodic $P^{\mathsf T} D P$) with zero global
   `atomicAdd` and polarized Armijo energy differences.
3. **Template-gated intermediate RK reduction elision** and deadlock-free predicated
   `cub::BlockReduce` DMI energy reduction plus lazy drive-buffer zeroing.
4. **Dual-path CSR exchange kernels:** hardware FP64 fused multiply-add (`Compensated=false`) on
   explicit RK stages versus software double-double accumulation (`Compensated=true`) retained on
   relaxation Armijo evaluations.
5. **Single-launch order-preserving fused effective-field composition (`H_eff`)**, collapsing
   `21--28` sequential vector launches into 1 launch with 0-ULP Oersted parity.
6. **Contiguous device AoS--SoA pack/unpack transfers**, replacing strided `cudaMemcpy2D` calls at
   zero extra VRAM by reusing the persistent download buffer.

(perf-fem-gpu-kernels-governing-equations)=
## Scientific and numerical model

### Exchange-mass preconditioned Barzilai--Borwein direction

Unpreconditioned `PG-BB` on fine finite-element meshes suffers from exchange-stiffness conditioning
$\kappa \propto h^{-2}$, inflating relaxation step counts as mesh size $h \to 0$. Using the exact
consistent magnetization-weighted mass matrix $M_{M_s}$ and exchange stiffness matrix $K_A$ in SI
units, FullMag computes the preconditioned search direction $\mathbf z^{(k)}$ by solving

```{math}
:label: eq-perf-fem-bb-precond
\left(M_{M_s} + \frac{2\lambda_k}{\mu_0}\,K_A\right)\mathbf z^{(k)}
= M_{M_s}\,\mathbf g^{(k)},
\qquad
\mathbf d^{(k)} = \Pi_{T_{\mathbf m^{(k)}}}\!\bigl(\mathbf z^{(k)}\bigr),
```

where $\lambda_k$ is the sanitized Barzilai--Borwein step parameter, $\Pi_{T_{\mathbf m}}$ projects
onto the nodal tangent space orthogonal to $\mathbf m^{(k)}$, and the operator is solved on GPU by
a single persistent cooperative CUDA PCG launch (`gpu_bb_pcg_launch`, inner relative residual
tolerance `rtol = 1e-10`, maximum 512 iterations, zero per-iteration host synchronizations). The
resulting descent dot product $\langle \mathbf g^{(k)}, \mathbf d^{(k)} \rangle$ is returned in the
same fused readback (`gpu_bb_exchange_mass_solve_and_project`); if a solved direction ever fails
the physical descent check, the runtime safeguards by falling back to the raw projected gradient
for that step.

In addition, accepting a trial state reuses the already-reduced trial component energies inside the
step-statistics finalizer (`gpu_rk_finalize_step_stats_control_readback_with_scalar_tail_reuse_energy`),
fusing 3 scalar energy reductions into 1 and cutting host--GPU synchronizations per `PG-BB` step
from `7 -> 4` (or `6 -> 3`, saving `-3.0` syncs/step with `exchange_mass` and `-2.0` syncs/step
with `none`).

### Unified skew-symmetric CSR GPU DMI and dual-path exchange

Assembling the discrete Dzyaloshinskii--Moriya bilinear form once on the MFEM mesh yields a
skew-symmetric nodal edge-vector CSR operator $\mathbf D_{ij} = -\mathbf D_{ji}$ (extended to
periodic seams via $P^{\mathsf T} D P$). The nodal DMI effective field and energy evaluate without
element-level scatter or global `atomicAdd`:

```{math}
:label: eq-perf-fem-dmi-csr
\mathbf H_{\mathrm{DMI},i}
= -\frac{1}{\mu_0 M_{s,i} V_i}
  \sum_{j \in \mathcal N(i)} \mathbf D_{ij} \times \mathbf m_j,
\qquad
E_{\mathrm{DMI}}
= -\frac{\mu_0}{2} \sum_{i \in \Omega_m} V_i M_{s,i}\,\mathbf m_i \cdot \mathbf H_{\mathrm{DMI},i}.
```

For CSR exchange (`fullmag_cuda_legacy_sparse_exchange_xyz`), explicit Runge--Kutta substeps use
hardware FP64 FMA (`Compensated=false`) because global time-integration accuracy is governed by
truncation error, whereas `PG-BB`/`NCG` energy-difference evaluations retain software double-double
accumulation (`Compensated=true`) to prevent catastrophic cancellation in tiny Armijo steps.

### Single-launch order-preserving fused $H_{\mathrm{eff}}$ and packed AoS--SoA transfers

Instead of launching 21--28 separate per-term/per-component vector-add kernels,
`fullmag_cuda_accumulate_heff_fused_xyz` sums all active interaction buffers into
$\mathbf H_{\mathrm{eff}}$ in one fused kernel while preserving exact deterministic addition order
and IEEE rounding (`__dmul_rn` / `__dadd_rn`):

```{math}
:label: eq-perf-fem-fused-heff
\mathbf H_{\mathrm{eff},i}
= \mathbf H_{\mathrm{ex},i}
+ \mathbf H_{\mathrm{ani},i}
+ \mathbf H_{\mathrm{DMI},i}
+ \mathbf H_{\mathrm{d},i}
+ \mathbf H_{\mathrm{ext},i}
+ \mathbf H_{\mathrm{Oe},i}
+ \mathbf H_{\mathrm{mel},i}
+ \mathbf H_{\mathrm{th},i}.
```

To eliminate strided PCIe transactions (`cudaMemcpy2D`) during state/field I/O, GPU device kernels
(`fullmag_cuda_pack_soa_to_aos`, `fullmag_cuda_unpack_aos_to_soa`) transpose between internal
Structure-of-Arrays component buffers and contiguous host Array-of-Structures buffers on device
prior to a single contiguous `cudaMemcpyAsync`, reusing the persistent `aos_device` scratch buffer
with `0 B` extra VRAM.

(perf-fem-gpu-kernels-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $M_{M_s}$ | consistent magnetization-weighted FEM mass matrix | $\mathrm{A\,m^2}$ |
| $K_A$ | exchange stiffness matrix $\int A_{\mathrm{ex}}\nabla\varphi_i\cdot\nabla\varphi_j\,\mathrm{d}V$ | $\mathrm{J}$ |
| $\lambda_k$ | Barzilai--Borwein step size | $\mathrm{m\,A^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\mathbf g^{(k)}$ | nodal projected gradient at relaxation step $k$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf z^{(k)}, \mathbf d^{(k)}$ | preconditioned and tangent-projected search direction | $\mathrm{A\,m^{-1}}$ |
| $\mathbf D_{ij}$ | skew-symmetric CSR DMI edge-coupling vector | $\mathrm{J}$ |
| $V_i$ | lumped nodal magnetic volume | $\mathrm{m^3}$ |
| $M_{s,i}$ | nodal saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{DMI},i}$ | nodal DMI effective field | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm{DMI}}$ | total Dzyaloshinskii--Moriya interaction energy | $\mathrm{J}$ |
| $\mathbf H_{\mathrm{eff},i}$ | fused nodal effective magnetic field | $\mathrm{A\,m^{-1}}$ |

(perf-fem-gpu-kernels-assumptions-and-validity)=
## Assumptions and validity

- **Cooperative launch requirement:** `bb_exchange_mass` requires a CUDA device with
  `cudaDevAttrCooperativeLaunch == 1` and assembled MFEM P1 mass/exchange forms. Under
  `policy="auto"`, missing preconditions record an explicit `direction_fallback_reason`
  (`exchange_disabled`, `mfem_forms_unavailable`, or `cooperative_launch_unsupported`) while
  preserving `requested_direction_policy = "auto"`.
- **Policy scope:** `study.fem_bb_preconditioner(...)` applies strictly to `FEM GPU`
  projected-gradient Barzilai--Borwein (`method="bb"`). There is no process-global environment
  override; the policy round-trips through canonical Python scripts, SceneDocument, and `ProblemIR`.
- **Intermediate RK reduction elision:** Intermediate Runge--Kutta stages pass `nullptr` for energy
  and max-sigma reduction buffers, evaluating full energies only on accepted observation or
  relaxation steps where required.

(perf-fem-gpu-kernels-python-api)=
## Python API

```python
# %% Configure FEM GPU relaxation with qualified bb_exchange_mass preconditioning and CSR DMI
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_gpu_bb_precond_and_dmi_demo")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(400 * nm, 400 * nm, 80 * nm))

film = study.geometry(
    fm.Box(size=(200 * nm, 200 * nm, 3 * nm), name="sp4_film"),
    name="sp4_film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.Dind = 1.5e-3
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.2, 0.0))

study.demag(model="airbox", variant="robin")
study.fem_demag_solver(gpu_strategy="auto", rtol=1.0e-8)
study.fem_bb_preconditioner("auto")

study.stages.add_minimize(
    stage_id="relax_bb_precond",
    method="bb",
    tolT=1.0e-6,
    max_steps=10_000,
)
study.solver(integrator="rk4", fix_dt=1.0e-13)
study.stages.add_run(until=5.0e-12, stage_id="rk4_shortrange")
```

## Parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `study.fem_bb_preconditioner(policy)` | `str` | `"auto"` | $1$ | `"auto"`, `"none"`, or `"exchange_mass"`; invalid values raise `ValueError` | FEM GPU PG-BB exchange-mass preconditioner policy | FEM GPU (`PG-BB` only) | `backend_policy.discretization_hints.fem.gpu_bb_preconditioner` |
| `study.stages.add_minimize(method=...)` | `str` | `"bb"` | $1$ | `"bb"` required for `fem_bb_preconditioner` | direct energy minimization algorithm | FEM CPU/GPU | `stages[].minimize.method` |
| `body.Dind` | `float` | `0.0` | $\mathrm{J\,m^{-2}}$ | finite real scalar | interfacial DMI constant assembled into unified CSR GPU DMI | FDM/FEM CPU/GPU (`tet4`/`prism6`/mixed) | `materials[].dmi_interfacial` |
| `body.Dbulk` | `float` | `0.0` | $\mathrm{J\,m^{-2}}$ | finite real scalar | bulk DMI constant assembled into unified CSR GPU DMI | FDM/FEM CPU/GPU (`tet4`/`prism6`/mixed) | `materials[].dmi_bulk` |

(perf-fem-gpu-kernels-problem-ir)=
## ProblemIR and provenance

Requested preconditioner policy serializes into `FemGpuBbPreconditionerIR` inside `FemHintsIR` and
resolves into `FemPlanIR`. After execution,
`apply_native_fem_gpu_bb_preconditioner_runtime_provenance` queries
`fullmag_fem_backend_get_gpu_bb_preconditioner_status` and records exact runtime telemetry:

```json
{
  "backend_policy": {
    "discretization_hints": {
      "fem": {
        "gpu_bb_preconditioner": "auto"
      }
    }
  },
  "provenance": {
    "requested_direction_policy": "auto",
    "resolved_direction_policy": "device_exchange_mass_preconditioned",
    "direction_policy_source": "discretization_hints.fem.gpu_bb_preconditioner",
    "direction_fallback_reason": null,
    "resolved_linear_solver": "cooperative_device_pcg",
    "resolved_preconditioner": "device_jacobi"
  }
}
```

## Control Room workflow

In Control Room, `fem_bb_preconditioner` round-trips through the SceneDocument and exported Python
scripts without mutating material parameters. During `PG-BB` relaxation, live telemetry shows step
counts, Armijo backtracking acceptance, and resolved preconditioner status; packed AoS--SoA
transfers keep live field snapshot downloads fast (`13.93x` faster `state_io`).

(perf-fem-gpu-kernels-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Requested intent versus resolved execution:** `requested_direction_policy` (`"auto"`,
  `"none"`, or `"exchange_mass"`) is attested independently from `resolved_direction_policy`,
  `direction_fallback_reason`, PCG residual norm, and Armijo monotonicity counts.
- **Validation errors:** Unknown preconditioner policy strings, attaching `fem_bb_preconditioner`
  to non-`PG-BB` minimizers or non-FEM engines, or non-finite exchange/DMI constants raise
  validation errors before planning completes.
- **Unsupported combinations:** Explicit `policy="exchange_mass"` fails closed with
  `FULLMAG_FEM_ERR_UNAVAILABLE` if cooperative launch or MFEM P1 mass/exchange forms are
  unavailable (zero silent fallback). Non-finite or non-converged inner PCG solves fail closed or
  trigger the raw-gradient descent safeguard with explicit diagnostic counters.

(perf-fem-gpu-kernels-discrete-realization)=
## Discrete realization and 4-lane support matrix

| Solver | Device | Status | Realization |
|---|---|---|---|
| `FEM` | `GPU` | implemented | Persistent cooperative PCG `bb_exchange_mass` (`auto` default), PGBB sync/energy fusion, unified CSR GPU DMI (`tet4`/`prism6`/mixed), dual-path FMA/DD exchange, single-launch fused $H_{\mathrm{eff}}$, and packed AoS--SoA transfers. |
| `FEM` | `CPU` | implemented | Reference consistent exchange-mass preconditioned `PG-BB` (`exchange_mass_preconditioned_gradient`) and MFEM CPU DMI/exchange forms. |
| `FDM` | `CPU` | not-applicable | Cartesian FDM uses stencil operators rather than unstructured FEM mass/stiffness CSR matrices. |
| `FDM` | `GPU` | not-applicable | Cartesian FDM CUDA uses `native_cuda_pgbb` and stencil kernels documented on the FDM core page. |

(perf-fem-gpu-kernels-implementation-mapping)=
## Implementation mapping

Cooperative PCG `bb_exchange_mass` workspace setup, operator caching, and kernel dispatch live in
`backends/fem/gpu/cuda/relaxation/{bb_exchange_mass.cpp,bb_exchange_mass_kernels.cu}` with C ABI
hooks in `backends/fem/src/api.cpp`, IR/provenance in `crates/fullmag-ir/src/mesh_hints.rs` and
`crates/fullmag-runner/src/relaxation/provenance.rs`, and PGBB trial-energy reuse in
`backends/fem/gpu/cuda/integrators/rk/rk_step_stats.cu`. Unified CSR GPU DMI lives in
`backends/fem/gpu/cuda/interactions/dmi/{dmi_csr_operator.cpp,dmi_csr_kernels.cu}`; dual-path CSR
exchange in `backends/fem/gpu/cuda/exchange/exchange_kernels.cu`; fused $H_{\mathrm{eff}}$ in
`backends/fem/gpu/cuda/fields/vector_field_kernels.cu`; and packed AoS--SoA kernels in
`backends/fem/gpu/cuda/transfer/transfer_kernels.cu`. See
{ref}`perf-fem-gpu-kernels-source-code-index`.

(perf-fem-gpu-kernels-validation)=
## Validation and verified benchmarks

### Qualified `bb_exchange_mass` & PGBB sync reduction (RTX 4080 SUPER, `compute-sanitizer --tool memcheck` 0 errors)

All native, Rust (`relaxation::provenance` 9/9), and Python (`test_fem_gpu_bb_preconditioner.py`
17/17) contract suites pass, including `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1`:

- **SP4 `h = 3 nm` + airbox (`7,800` nodes / `1,952` mag, `cuDSS`):** `39` vs `241` PGBB steps
  (**6.18x** fewer, matching CPU `39 == 39`), `46` vs `309` demag solves, `505.80 ms`
  (`exchange_mass`) / `683.87 ms` (`auto`) vs `1,424.85 ms` (**2.08x--2.82x** wall; **28.5x** vs
  CPU PGBB), host syncs `286 -> 170` (`-3.0/step`), `dE/|E| = 9.0e-12` vs CPU,
  `max_pcg_res = 9.997e-11`, `0` Armijo violations.
- **SP4 `h = 3 nm` + airbox (`CG+AMG`):** `auto -> exchange_mass` achieves **6.11x** wall speedup
  (`38.37 s` vs `234.28 s`, `39` vs `214` steps); `policy="none"` is bit-exact with `-2.00`
  syncs/step (`1,203 -> 776`).
- **Ultra-fine `h = 2 nm` + airbox (`cuDSS`):** `29` vs `305` steps (**10.52x** fewer, matching CPU
  `29 == 29`), `564.51 ms` vs `2,138.17 ms` (**3.79x** wall, **24.0x** vs CPU),
  `dE/|E| = 2.0e-14`, `max_pcg_res = 9.982e-11`.
- **Pure slab `h = 2 nm` (no demag):** `53` vs `322` steps (**6.08x** fewer), `263.15 ms` vs
  `877.05 ms` (**3.33x**), `dE/|E| = 2.8e-12`; `policy="none"` bit-exact with `-1.00` sync/step
  (`1,408 -> 1,086`).

### Unified CSR GPU DMI, short-range kernels, fused $H_{\mathrm{eff}}$, and packed transfers (RTX 4080 SUPER)

- **Unified CSR GPU DMI (15 configs, parity `h_rel <= 1.12e-15`, `E_rel <= 4.76e-14`):**
  **1.67x--2.51x** faster than legacy `tet4` GPU DMI with energy (**3.33x--4.80x** field-only RK),
  and **1,953x--4,812x** faster than CPU MFEM on `prism6_120x120x2` (`0.035--0.091 ms` vs
  `168.5--190.8 ms` CPU).
- **Short-range RK4 benchmark (`33,150` nodes / `180,000` TET4, all 7 short-range terms):**
  - 50-step RK4 end-to-end: **1.80x** (`498.56 -> 277.46 ms`, `max_rel(m) = 4.53e-16`, `dE_tot = 0`).
  - Exchange RK FMA vs double-double: **8.02x** (`0.4144 -> 0.0517 ms`).
  - DMI RK (reduction elided): **2.54x** (`0.7873 -> 0.3095 ms`, **2.17x** with `BlockReduce` energy).
  - Single-launch fused $H_{\mathrm{eff}}$: **17.5x** (`0.2275 -> 0.0130 ms`, `21 -> 1` launches,
    0-ULP Oersted parity).
  - Packed AoS--SoA transfers: `state_io` **13.93x** (`73.62 -> 5.28 ms`), micro-transfers
    **40.5x** D2H (`7.88 -> 0.194 ms`) and **6.30x** H2D (`1.09 -> 0.173 ms`), `0 B` extra VRAM.

(perf-fem-gpu-kernels-limitations)=
## Limitations and rejected approaches

- Outer Armijo backtracking and Barzilai--Borwein scalar step control remain host-orchestrated on
  `FEM GPU` (`4` host syncs/step remain for `exchange_mass` due to Armijo acceptance and demag
  control).
- The historical lumped-mass NCG CG4/CG8 preconditioner was rejected (`NO-GO`) in formal
  remediation and superseded by consistent-mass `bb_exchange_mass`.
- `bb_exchange_mass` currently supports MFEM P1 magnetization spaces on CUDA devices supporting
  cooperative grid launches.

(perf-fem-gpu-kernels-scientific-bibliography)=
## Scientific bibliography

1. J. Barzilai and J. M. Borwein, "Two-point step size gradient methods," *IMA Journal of Numerical
   Analysis* **8**, 141--148 (1988), [doi:10.1093/imanum/8.1.141](https://doi.org/10.1093/imanum/8.1.141).
2. M. Ruggeri, "Preconditioned Barzilai--Borwein methods for micromagnetic energy minimization,"
   *Journal of Computational Physics* (consistent mass-plus-exchange preconditioning).
3. I. Dzyaloshinskii, "A thermodynamic theory of 'weak' ferromagnetism of antiferromagnetics,"
   *Journal of Physics and Chemistry of Solids* **4**, 241--255 (1958); T. Moriya, *Physical
   Review* **120**, 91 (1960).
4. B. Goebel, A. Mook, J. Henk, and I. Mertig, "Overcoming the speed limit in skyrmion racetrack
   devices by suppressing the skyrmion Hall effect," *Physical Review B* **99**, 020405(R) (2019).
5. T. J. Dekker, "A floating-point technique for extending the available precision," *Numerische
   Mathematik* **18**, 224--242 (1971), [doi:10.1007/BF01397083](https://doi.org/10.1007/BF01397083).

(perf-fem-gpu-kernels-source-code-index)=
## Where this is implemented

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| StudyBuilder policy entry point | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | Expose `fem_bb_preconditioner` policy authoring | Public API | `test_fem_gpu_bb_preconditioner.py` (17/17) |
| IR preconditioner enum | `crates/fullmag-ir/src/mesh_hints.rs` | `FemGpuBbPreconditionerIR` | Typed `auto`/`none`/`exchange_mass` IR representation | `FEM GPU` | `fullmag-ir` (289/289) |
| Runtime provenance projection | `crates/fullmag-runner/src/relaxation/provenance.rs` | `apply_native_fem_gpu_bb_preconditioner_runtime_provenance` | Attest resolved policy, fallback reason, and PCG telemetry | `FEM GPU` | `relaxation::provenance` (9/9) |
| Cooperative PCG workspace creation | `backends/fem/gpu/cuda/relaxation/bb_exchange_mass.cpp` | `gpu_bb_exchange_mass_create` | Upload immutable consistent mass & exchange CSR operators | `FEM GPU` | `memcheck` 0 errors |
| Single-sync solve & tangent projection | `backends/fem/gpu/cuda/relaxation/bb_exchange_mass.cpp` | `gpu_bb_exchange_mass_solve_and_project` | Execute cooperative PCG, tangent projection, and descent dot | `FEM GPU` | RTX 4080 SUPER A/B (up to 10.52x fewer steps) |
| Persistent cooperative PCG kernel | `backends/fem/gpu/cuda/relaxation/bb_exchange_mass_kernels.cu` | `gpu_bb_pcg_launch` | Zero-per-iter-sync device PCG with subnormal-safe residual | `FEM GPU` | `max_pcg_res < 1e-10` |
| Trial-energy reuse finalizer | `backends/fem/gpu/cuda/integrators/rk/rk_step_stats.cu` | `gpu_rk_finalize_step_stats_control_readback_with_scalar_tail_reuse_energy` | Fuse `3->1` energy reductions and save `-3.0` syncs/step | `FEM GPU` | RTX 4080 SUPER A/B |
| Native preconditioner policy setter | `backends/fem/src/api.cpp` | `fullmag_fem_backend_set_gpu_bb_preconditioner` | Apply requested policy to native FEM GPU context | `FEM GPU` | `fullmag-fem-sys` (54/54) |
| Unified CSR GPU DMI assembly | `backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.cpp` | `build_gpu_dmi_csr_from_mfem` | Build skew-symmetric edge-vector CSR across `tet4`/`prism6`/mixed | `FEM GPU` | 15-config parity `<= 1.12e-15` |
| Unified CSR GPU DMI kernel | `backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.cu` | `fullmag_cuda_dmi_csr_field_energy` | Zero-atomic DMI field with template-gated `BlockReduce` energy | `FEM GPU` | 1,953x--4,812x vs CPU prism |
| Dual-path CSR exchange dispatch | `backends/fem/gpu/cuda/exchange/exchange_kernels.cu` | `fullmag_cuda_legacy_sparse_exchange_xyz` | Fast FMA on RK stages vs double-double on relaxation | `FEM GPU` | RTX 4080 SUPER A/B (8.02x FMA) |
| Single-launch fused `H_eff` kernel | `backends/fem/gpu/cuda/fields/vector_field_kernels.cu` | `fullmag_cuda_accumulate_heff_fused_xyz` | Collapse 21--28 launches into 1 with 0-ULP Oersted parity | `FEM GPU` | RTX 4080 SUPER A/B (17.5x) |
| Contiguous device SoA-to-AoS pack | `backends/fem/gpu/cuda/transfer/transfer_kernels.cu` | `fullmag_cuda_pack_soa_to_aos` | Eliminate strided `cudaMemcpy2D` D2H downloads at 0 B VRAM | `FEM GPU` | RTX 4080 SUPER A/B (40.5x D2H) |
| Contiguous device AoS-to-SoA unpack | `backends/fem/gpu/cuda/transfer/transfer_kernels.cu` | `fullmag_cuda_unpack_aos_to_soa` | Eliminate strided `cudaMemcpy2D` H2D uploads at 0 B VRAM | `FEM GPU` | RTX 4080 SUPER A/B (6.30x H2D) |
