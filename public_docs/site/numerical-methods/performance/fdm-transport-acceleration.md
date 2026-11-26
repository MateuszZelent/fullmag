---
title: FDM CUDA Charge and Spin Transport Acceleration
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(numerical-methods-performance-fdm-transport)=
# FDM CUDA Charge and Spin Transport Acceleration

(perf-fdm-transport-problem-statement)=
## Scope and purpose

This page documents the CUDA acceleration stack for coupled finite-difference (`FDM GPU`) charge
transport (`M1` steady ohmic Poisson), drift-diffusion spin transport (`M1` steady spin
accumulation and spin-Hall/interfacial spin-transfer torque), and prescribed local spin torques
(`SlonczewskiSTT` and `PrescribedSpinOrbitTorque`). Canonical transport equations live under
{doc}`../../physics/interactions/drift-diffusion-spin-torque/index` and
{doc}`../../physics/interactions/spin-transfer-torque/index`.

Four production optimizations are covered:

1. **Multi-block cooperative 6--7 level geometric AMG-PCG W-cycle and opt-in cuDSS direct Cholesky
   charge solver** with rank-1 center-cell pinning and GPU iterative refinement for `zero_mean`
   Neumann gauges.
2. **$O(\log N)$ binary-search boundary/interface lookup and multi-block CUB closure diagnostics**
   for `FDM GPU` M1 steady spin transport (removing the legacy 4096-cell serial diagnostic cap).
3. **Deferred accepted-endpoint steady-spin observation materialization**, keeping full 288-byte
   flux/reaction/interface observation arrays off intermediate Runge--Kutta substeps.
4. **Fused FP64 RK45 prescribed STT/SOT effective-field and LLG RHS kernel**, eliminating separate
   torque kernel launches while transparently documenting its demag-FFT-bound wall-time behavior.

(perf-fdm-transport-governing-equations)=
## Scientific and numerical model

### Multilevel geometric AMG-PCG and gauge-projected cuDSS charge solve

On a regular conducting cell grid, steady ohmic charge conservation yields a symmetric
positive-(semi)definite finite-volume system for the scalar electric potential $V$:

```{math}
:label: eq-perf-fdm-charge-fv
\mathbf L_{\sigma}\mathbf V = \mathbf b_q,
\qquad
\mathbf J_c = -\sigma\,\nabla_h V.
```

The default GPU solver builds a 6--7 level $2 \times 2 \times 2$ geometric Galerkin RAP hierarchy
directly on the GPU (`assign_geometric_aggregates_kernel`, `build_geometric_rap_kernel`) and solves
{eq}`eq-perf-fdm-charge-fv` via a multi-block cooperative W-cycle AMG-preconditioned conjugate
gradient kernel (`charge_pcg_device_amg_kernel`). When all boundaries on a connected component are
Neumann/insulating (`zero_mean` gauge), cooperative connected-component labeling projects out the
per-component constant nullspace.

When `FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss` is explicitly requested and the post-analysis
peak factor estimate fits within the device budget, FullMag pins one interior center cell per
floating component ($V_{i_\star}=0$) to obtain a nonsingular SPD lower-triangular CSR matrix
$\widetilde{\mathbf L}_{\sigma} = \mathbf L \mathbf L^{\mathsf T}$, performs factor-once cuDSS
Cholesky factorization with GPU iterative refinement, and applies the zero-mean shift on the
device:

```{math}
:label: eq-perf-fdm-charge-cudss-ir
\mathbf r^{(k)} = \mathbf b_q - \mathbf L_{\sigma} \mathbf V^{(k)},
\qquad
\widetilde{\mathbf L}_{\sigma} \Delta \mathbf V^{(k)} = \mathbf r^{(k)},
\qquad
\mathbf V \leftarrow \mathbf V - \langle \mathbf V \rangle_{\Omega_c}.
```

### $O(\log N)$ face/interface lookup and multi-block spin closure diagnostics

In steady M1 drift-diffusion spin transport, cell-to-face reaction and interfacial spin-mixing
conductance fluxes require querying exterior boundary faces and magnetic/nonmagnetic interfaces.
Stably sorting boundary and interface descriptor tables by canonical face index reduces lookup cost
per face from $O(N_{\mathrm{face}})$ linear scans to $O(\log N_{\mathrm{face}})$ binary search.
Torque closure across volumetric exchange/dephasing spin-reaction sinks $(\mathbf s_{J,i},
\mathbf s_{\phi,i})$ and incident mixing-conductance absorbed fluxes $\mathbf Q_{\mathrm{abs},f}$
(together with interface flux balance $|\mathbf Q_{\mathrm{from}} - \mathbf Q_{\mathrm{to}} -
\mathbf Q_{\mathrm{abs}}|$) is verified across arbitrarily large grids via multi-block
`cub::BlockReduce` and bit-encoded `atomicMax`:

```{math}
:label: eq-perf-fdm-spin-closure
\varepsilon_{\mathrm{closure}}
= \max_{i \in \Omega_m}
  \left\|
    \boldsymbol\tau_{\mathrm{total},i}
    - c_{\tau,i}\!\left(
        \mathbf s_{J,i} + \mathbf s_{\phi,i}
        + \frac{1}{V_i}\sum_{f \in \partial i} A_f \mathbf Q_{\mathrm{abs},f}
      \right)
  \right\|_{\infty},
\qquad
c_{\tau,i} = -\frac{\gamma_e \hbar}{2 e M_{s,i}}.
```

### Deferred accepted-endpoint observation materialization and fused FP64 local torques

During coupled CUDA LLG integration, every RK substep solves the exact steady-spin equation and
applies absorbed spin torque, but pins only the accepted endpoint $(\mathbf m_n, \boldsymbol\mu_{s,n},
\mathbf b_{s,n})$ on device. Full 288-byte per-cell/per-interface observation records are
materialized lazily once per observed accepted endpoint (`materialize_accepted_spin`), with
rejected trial substeps discarded without reconstruction and zero additional spin solves.

For local prescribed spin torques (`SlonczewskiSTT` and `PrescribedSpinOrbitTorque`), the FP64
DP45 integrator inlines `add_prescribed_spin_torques_fp64` inside the templated effective-field and
LLG RHS kernel:

```{math}
:label: eq-perf-fdm-fused-rhs
\frac{\mathrm d\mathbf m}{\mathrm dt}
= -\frac{\gamma_0}{1+\alpha^2}
  \Bigl[
    \mathbf m \times \mathbf H_{\mathrm{eff}}
    + \alpha\,\mathbf m \times (\mathbf m \times \mathbf H_{\mathrm{eff}})
  \Bigr]
  + \boldsymbol\tau_{\mathrm{STT}}(\mathbf m)
  + \boldsymbol\tau_{\mathrm{SOT}}(\mathbf m),
```

combining field composition, LLG damping/precession, and local spin-torque evaluation in one device
kernel launch.

(perf-fdm-transport-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf L_{\sigma}$ | discrete finite-volume ohmic conductivity operator | $\mathrm{A\,V^{-1}}$ |
| $V$ | scalar electric potential | $\mathrm{V}$ |
| $\mathbf b_q$ | discrete current-boundary source vector | $\mathrm{A}$ |
| $\sigma$ | electrical conductivity | $\mathrm{S\,m^{-1}}$ |
| $\mathbf J_c$ | charge current density | $\mathrm{A\,m^{-2}}$ |
| $\Omega_c$ | connected conducting component | $\mathrm{m^3}$ |
| $N_{\mathrm{face}}$ | count of boundary or mixing-conductance interface faces | $1$ |
| $\varepsilon_{\mathrm{closure}}$ | maximum per-cell spin-torque volume--surface closure residual | $\mathrm{s^{-1}}$ |
| $\boldsymbol\tau_{\mathrm{total},i}$ | total spin torque in magnetic cell $i$ | $\mathrm{s^{-1}}$ |
| $c_{\tau,i}$ | spin-torque prefactor $-\gamma_e\hbar/(2 e M_{s,i})$ | $\mathrm{m^3\,A^{-1}\,s^{-1}}$ |
| $\mathbf s_{J,i}, \mathbf s_{\phi,i}$ | volumetric exchange and dephasing spin-reaction sinks | $\mathrm{A\,m^{-3}}$ |
| $V_i$ | cell volume | $\mathrm{m^3}$ |
| $A_f$ | interface face area | $\mathrm{m^2}$ |
| $\mathbf Q_{\mathrm{abs},f}$ | absorbed interfacial spin flux across mixing face $f$ | $\mathrm{A\,m^{-2}}$ |
| $\gamma_0$ | gyromagnetic ratio $\mu_0 \gamma$ | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha$ | Gilbert damping parameter | $1$ |
| $\mathbf H_{\mathrm{eff}}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |

(perf-fdm-transport-assumptions-and-validity)=
## Assumptions and validity

- **Default vs opt-in charge linear solver:** `cg_device_amg_wcycle_v1` is the default `FDM GPU`
  charge solver with lower VRAM footprint and fast cold startup. Opt-in cuDSS
  (`FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss`) trades higher device factor memory and one-time
  cold factorization latency for near-machine-precision residuals ($10^{-16}$--$10^{-15}$) and
  faster warm solves on stiff or floating-gauge geometries.
- **Steady-spin cadence scope:** Deferred observation materialization applies to CUDA LLG stages
  bound to M1 steady spin transport. Standalone steady-spin ABI calls continue to publish complete
  observation arrays immediately upon return.
- **Fused local torque wall-time dominance:** Fusing prescribed FP64 STT/SOT removes thousands of
  separate RHS launches, but total wall time on large open-boundary grids remains dominated by
  demagnetization cuFFT rather than local torque evaluation.

(perf-fdm-transport-python-api)=
## Python API

```python
# %% Configure FDM GPU ohmic charge and M1 steady spin drift-diffusion with RK4
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_gpu_m1_transport_demo")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.fdm(default_cell=(2.0 * nm, 2.0 * nm, 1.0 * nm))

hm = study.conductor(
    fm.Box(size=(64 * nm, 32 * nm, 4 * nm), name="heavy_metal"),
    name="heavy_metal",
)
fm_layer = study.geometry(
    fm.Box(size=(64 * nm, 32 * nm, 2 * nm), name="ferromagnet").translate((0.0, 0.0, 3.0 * nm)),
    name="ferromagnet",
)
fm_layer.Ms = 1.0e6
fm_layer.Aex = 1.5e-11
fm_layer.alpha = 0.02
fm_layer.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

hm_ref = fm.RegionRef("heavy_metal")
fm_ref = fm.RegionRef("ferromagnet")

charge = study.current_transport(
    name="bilayer_charge",
    model="ohmic_poisson",
    domain=(hm_ref, fm_ref),
    materials=(
        fm.ChargeTransportMaterialAssignment(
            region=hm_ref,
            material=fm.ChargeTransportMaterial(sigma_Spm=5.0e5),
        ),
        fm.ChargeTransportMaterialAssignment(
            region=fm_ref,
            material=fm.ChargeTransportMaterial(sigma_Spm=6.0e5),
        ),
    ),
    boundaries=(
        fm.VoltageElectrode(
            id="left_lead",
            surfaces=(fm.SurfaceRef("heavy_metal", "x_min", (-1.0, 0.0, 0.0)),),
            potential_V=0.05,
        ),
        fm.VoltageElectrode(
            id="right_lead",
            surfaces=(fm.SurfaceRef("heavy_metal", "x_max", (1.0, 0.0, 0.0)),),
            potential_V=0.0,
        ),
    ),
    gauge=fm.ChargePotentialGauge("dirichlet_reference"),
    solver=fm.ChargeSolverPolicy(engine="cg", relative_tolerance=1.0e-12),
)

study.spin_transport(
    fm.SpinDriftDiffusion(
        id="bilayer_she",
        current_source_id="bilayer_charge",
        domain=(hm_ref, fm_ref),
        materials=(
            fm.SpinTransportMaterialAssignment(
                region=hm_ref,
                material=fm.SpinTransportMaterial(
                    sigma_s_Spm=5.0e5,
                    polarization_p=0.0,
                    theta_sh=-0.25,
                    lambda_sf_m=3.5e-9,
                ),
            ),
            fm.SpinTransportMaterialAssignment(
                region=fm_ref,
                material=fm.SpinTransportMaterial(
                    sigma_s_Spm=6.0e5,
                    polarization_p=0.6,
                    theta_sh=0.0,
                    lambda_sf_m=5.0e-9,
                    lambda_j_m=1.2e-9,
                    lambda_phi_m=2.0e-9,
                ),
            ),
        ),
        solver=fm.SpinSolverPolicy(engine="auto", relative_tolerance=1.0e-8),
        mode="steady",
    )
)

study.solver(integrator="rk4", fix_dt=5.0e-14)
study.stages.add_run(until=5.0e-12, stage_id="she_dynamics")
```

## Parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `CurrentTransport.model` | `str` | `"prescribed_density"` | $1$ | `"prescribed_density"`, `"ohmic_poisson"`, or `"magnetoresistive_poisson"` | charge transport PDE formulation | FDM/FEM CPU/GPU (`ohmic_poisson` accelerated on CUDA) | `current_transport[].model` |
| `CurrentTransport.gauge` | `ChargePotentialGauge \| None` | `None` | $1$ | `"dirichlet_reference"`, `"zero_mean"`, or `"terminal_reference"` | electrostatic potential gauge policy | FDM/FEM CPU/GPU | `current_transport[].gauge` |
| `SpinDriftDiffusion.mode` | `str` | `"steady"` | $1$ | `"steady"` (M1/M2) or `"transient"` (M3) | steady elliptic vs transient IMEX spin transport | FDM CPU/GPU (`steady` CUDA accelerated) | `spin_transport[].mode` |
| `FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER` | `env str` | unset (`amg`) | $1$ | case-insensitive `"cudss"` opts in; all other tokens resolve to `"cg_device_amg_wcycle_v1"` | override CUDA M1 charge linear solver | FDM GPU runtime env | `provenance.linear_solver_realization` |
| `FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES` | `env int` | device auto | $\mathrm{B}$ | positive byte budget capping cuDSS factor estimate; invalid values fail closed | explicit VRAM budget cap for opt-in cuDSS charge | FDM GPU runtime env | `provenance.linear_solver_realization` |

(perf-fdm-transport-problem-ir)=
## ProblemIR and provenance

Charge and spin transport definitions serialize under `current_transport[]` and `spin_transport[]`,
while the resolved CUDA linear solver realization is attested in stage provenance:

```json
{
  "current_transport": [
    {
      "name": "bilayer_charge",
      "model": "ohmic_poisson",
      "gauge": "dirichlet_reference"
    }
  ],
  "spin_transport": [
    {
      "id": "bilayer_she",
      "current_source_id": "bilayer_charge",
      "mode": "steady"
    }
  ],
  "provenance": {
    "linear_solver_realization": "cg_device_amg_wcycle_v1"
  }
}
```

When `FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss` succeeds preflight,
`linear_solver_realization` attests `"cudss_direct_cholesky_opt_in"`.

## Control Room workflow

Control Room surfaces M1 charge and steady-spin field observations (`V_electric`, `J_charge`,
`spin_potential`, `spin_current_tensor`, `torque_stt`) on accepted cadence snapshots. Because
steady-spin observation reconstruction is deferred to observed accepted endpoints, requesting live
magnetization previews without subscribing to full spin-current tensors avoids unnecessary 288-byte
record reconstruction during high-frequency RK stepping.

(perf-fdm-transport-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Requested intent versus resolved execution:** Requested intent (`ohmic_poisson`, `gauge`,
  `SpinDriftDiffusion(mode="steady")`, and optional `FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss`)
  is stored separately from resolved execution (`cg_device_amg_wcycle_v1` vs
  `cudss_direct_cholesky_opt_in`, iteration count, residual norm, and spin closure residual).
- **Validation errors:** Incomplete charge boundary contracts, incompatible gauge declarations,
  and malformed or non-positive `FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES` values
  raise explicit validation errors before execution. For `FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER`,
  only case-insensitive `"cudss"` opts into cuDSS direct Cholesky; any other token (or unset)
  resolves cleanly to the default `"cg_device_amg_wcycle_v1"`.
- **Unsupported combinations:** Requesting `FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss` when cuDSS
  support is not compiled or when the post-analysis factor estimate exceeds
  `FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES` fails closed prior to factorization;
  strict GPU transport runs never fall back silently to CPU solvers and report 0 hot-loop
  full-vector host transfers.

(perf-fdm-transport-discrete-realization)=
## Discrete realization and 4-lane support matrix

| Solver | Device | Status | Realization |
|---|---|---|---|
| `FDM` | `CPU` | implemented | Reference CPU finite-volume M1 charge and steady spin solvers used as parity oracle. |
| `FDM` | `GPU` | implemented | Multi-block 6--7 level cooperative AMG-PCG & opt-in cuDSS charge, binary-search M1 spin lookup & CUB closure, deferred accepted-endpoint spin observations, and fused FP64 RK45 STT/SOT. |
| `FEM` | `CPU` | not-applicable | Unstructured FEM charge and M1/M2 transport use the Wave 2 3-tier sparse solver stack documented on the FEM multiphysics page. |
| `FEM` | `GPU` | not-applicable | Unstructured FEM opt-in GPU transport uses `cuda_cudss_lu` on assembled MFEM CSR blocks rather than Cartesian finite-volume grids. |

(perf-fdm-transport-implementation-mapping)=
## Implementation mapping

Cooperative geometric AMG-PCG and cuDSS charge kernels live in
`backends/fdm/gpu/cuda/transport/charge/{device_solver.cu,cudss_solver.cpp}` with runner provenance
in `crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs`. Parallelized M1 spin lookup,
multi-block CUB closure, and deferred observation materialization live in
`backends/fdm/gpu/cuda/transport/spin/device_solver.cu` and
`backends/fdm/gpu/cuda/transport/context.cu`. Fused FP64 RK45 STT/SOT kernels live in
`backends/fdm/gpu/cuda/integrators/prescribed_spin_torques_fp64.cuh` and
`backends/fdm/gpu/cuda/interactions/demag_fp64.cu`. See {ref}`perf-fdm-transport-source-code-index`.

(perf-fdm-transport-validation)=
## Validation and verified benchmarks

### CUDA M1 charge solver (RTX 4080 SUPER, 13 ABI cases `U/M/I/F/Z`, `rtol = 1e-13`)

Verified across six native GPU contract suites (`gpu_m1_charge_{uniform,layered,scalability,boundary_mutation,snapshot,transfer_audit}_v1_contract.cpp`):

- **Default 6--7 level cooperative AMG-PCG:** warm solve median speedup **1.46x to 7.48x**. On
  `U_128x64x8` (65,536 cells): `492.86 -> 65.87 ms` (**7.48x**), PCG iterations `57 -> 30`, peak
  VRAM **-19.5%** (`24.01 -> 19.32 MB`). On floating-gauge `Z_64x32x8`: cold **21.75x**
  (`1015.23 -> 46.68 ms`), warm **6.35x**. Parity `rel max|dV| <= 4.32e-14`.
- **Opt-in cuDSS Cholesky (`FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss`):** warm solve speedup
  **1.36x to 8.53x** (`Z_64x32x8`: `141.49 -> 16.58 ms`, **8.53x**; `U_128x64x8`:
  `492.86 -> 66.88 ms`, **7.37x**), physical residual `5.57e-16` to `8.15e-15`, at the cost of
  factor VRAM (`58.2 MB` at 16k cells, `194.6 MB` at 65.5k cells) and one-time cold factorization
  (`2,162 ms` at 65.5k cells).

### CUDA M1 spin lookup, CUB closure, & deferred observations (RTX 4080 SUPER, beta-W/CoFeB)

Verified with `gpu_m1_spin_operator_parity_v1_contract.cpp`,
`gpu_m1_spin_sparse_dispatch_v1_contract.cpp` (up to `1,048,576` cells within 512 MiB external /
2 GiB total VRAM envelope), and `gpu_m1_spin_sparse_performance_v1_contract.cu`:

- `32x16x7` (13 RK4 steps, `+I`): CLI wall **46.0x** (`177.58 -> 3.86 s`), spin stage median
  **187.5x** (`2675.63 -> 14.27 ms`), field reconstruction + closure diagnostics **1888x**
  (`2662.54 -> 1.41 ms`). Reversed current (9 steps): CLI **34.8x** (`123.72 -> 3.56 s`), spin
  stage **181.5x** (`2678.85 -> 14.76 ms`).
- `128x64x7` (4 RK4 steps): spin stage median **1.82x** (`63.19 -> 34.65 ms`), assembly + hashing
  **29.5x** (`18.60 -> 0.63 ms`); remaining dominant stages are GMRES (`17.47 ms`) and
  materialization (`11.12 ms`).
- Parity: bit-identical `m_final`, `V_electric`, `J_charge`, `spin_potential`,
  `spin_current_tensor`, and `torque_stt`; 0 fallbacks; 0 hot-loop full-vector transfers.
- Deferred accepted-endpoint observation reconstruction (`materialize_accepted_spin`) is verified
  for field parity and checkpoint contracts; standalone multi-run wall-time A/B speedup is **not
  verified**.

### Fused FP64 RK45 prescribed STT/SOT (RTX 4080 SUPER, `512x256x1` RK45)

Verified with `local_pipeline_fusion_cuda_contract.cu` and `sot_rhs_contract.cpp`:

- Separate RHS kernel stages eliminated: **2569 -> 0** (STT) and **1463 -> 0** (active SOT), with
  bit-identical `m_final`.
- End-to-end wall time on these short open-boundary runs is neutral (`18.19 -> 18.41 s` STT;
  `48.30 -> 48.57 s` SOT) because demagnetization cuFFT dominates total step cost.

(perf-fdm-transport-limitations)=
## Limitations and rejected approaches

- Opt-in cuDSS charge factorization incurs significant cold setup latency (`2.16 s` at `65,536`
  cells) and super-linear factor memory growth; keep the default cooperative AMG-PCG solver unless
  repeated solves on a fixed conductivity mesh amortize factorization cost.
- On large M1 spin grids (`128x64x7` and above), GPU GMRES iteration cost becomes the primary
  remaining bottleneck once lookup and closure diagnostics are parallelized.
- Fused FP64 local spin-torque kernels do not accelerate demag-dominated grids where cuFFT accounts
  for the majority of step time.

(perf-fdm-transport-scientific-bibliography)=
## Scientific bibliography

1. C. Abert, M. Ruggeri, F. Bruckner, C. Vogler, G. Hrkac, D. Praetorius, and D. Suess, "A
   three-dimensional spin-diffusion model for micromagnetics," *Scientific Reports* **5**, 14855
   (2015), [doi:10.1038/srep14855](https://doi.org/10.1038/srep14855).
2. J. C. Slonczewski, "Current-driven excitation of magnetic multilayers," *Journal of Magnetism
   and Magnetic Materials* **159**, L1--L7 (1996),
   [doi:10.1016/0304-8853(96)00062-5](https://doi.org/10.1016/0304-8853(96)00062-5).
3. A. Manchon et al., "Current-induced spin-orbit torques in ferromagnetic and antiferromagnetic
   systems," *Reviews of Modern Physics* **91**, 035004 (2019),
   [doi:10.1103/RevModPhys.91.035004](https://doi.org/10.1103/RevModPhys.91.035004).
4. NVIDIA Corporation, *cuDSS Direct Sparse Solver Library Documentation* and *CUB Cooperative
   Primitives*.

(perf-fdm-transport-source-code-index)=
## Where this is implemented

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Geometric $2\times2\times2$ aggregate assignment | `backends/fdm/gpu/cuda/transport/charge/device_solver.cu` | `assign_geometric_aggregates_kernel` | Build 6--7 level coarse hierarchy on GPU | `FDM GPU` | RTX 4080 SUPER A/B (up to 7.48x) |
| Device Galerkin RAP assembly | `backends/fdm/gpu/cuda/transport/charge/device_solver.cu` | `build_geometric_rap_kernel` | Exact coarse-level matrix assembly on GPU | `FDM GPU` | 6 M1 charge GPU contracts |
| Multi-block cooperative AMG-PCG solve | `backends/fdm/gpu/cuda/transport/charge/device_solver.cu` | `charge_pcg_device_amg_kernel` | Cooperative W-cycle AMG-PCG linear solve | `FDM GPU` | RTX 4080 SUPER A/B (`rel max\|dV\| <= 4.32e-14`) |
| Cooperative zero-mean component labeling | `backends/fdm/gpu/cuda/transport/charge/device_solver.cu` | `label_reference_components_coop_kernel` | Identify floating conducting components on GPU | `FDM GPU` | `Z_64x32x8` cold 21.75x / warm 6.35x |
| cuDSS lower-triangular CSR assembly | `backends/fdm/gpu/cuda/transport/charge/device_solver.cu` | `assemble_cudss_lower_csr_kernel` | Assemble center-pinned SPD matrix for cuDSS | `FDM GPU` | RTX 4080 SUPER A/B (up to 8.53x) |
| Opt-in cuDSS policy gate | `backends/fdm/gpu/cuda/transport/charge/cudss_solver.cpp` | `charge_cudss_direct_requested` | Parse `FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss` | `FDM GPU` | Charge cuDSS contracts |
| cuDSS VRAM preflight guard | `backends/fdm/gpu/cuda/transport/charge/cudss_solver.cpp` | `check_charge_cudss_factor_fits` | Enforce device budget before factorization | `FDM GPU` | Fail-closed budget contract |
| Charge solver provenance resolution | `crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs` | `resolve_charge_linear_solver_realization` | Attest `cg_device_amg_wcycle_v1` vs `cudss_direct_cholesky_opt_in` | `FDM GPU` | Runner provenance tests |
| Multi-block M1 spin field materialization | `backends/fdm/gpu/cuda/transport/spin/device_solver.cu` | `materialize_cells_kernel` | Parallel cell-level spin flux/torque reconstruction | `FDM GPU` | RTX 4080 SUPER A/B (1888x field+closure) |
| Parallel CUB spin closure diagnostics | `backends/fdm/gpu/cuda/transport/spin/device_solver.cu` | `measure_materialized_closure_kernel` | Multi-block `cub::BlockReduce` closure check beyond 4096 cells | `FDM GPU` | `gpu_m1_spin_sparse_dispatch_v1_contract.cpp` |
| Deferred accepted-endpoint observation materialization | `backends/fdm/gpu/cuda/transport/context.cu` | `materialize_accepted_spin` | Lazily construct full 288-byte spin observations once per observed endpoint | `FDM GPU` | `gpu_m1_spin_operator_parity_v1_contract.cpp` |
| Inline FP64 prescribed STT/SOT helper | `backends/fdm/gpu/cuda/integrators/prescribed_spin_torques_fp64.cuh` | `add_prescribed_spin_torques_fp64` | Device-inline Slonczewski STT and prescribed SOT terms | `FDM GPU` | `local_pipeline_fusion_cuda_contract.cu` |
| Fused FP64 effective-field and local spin RHS | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `launch_effective_field_and_local_spin_rhs_fp64` | Single-launch field composition, LLG RHS, and STT/SOT | `FDM GPU` | RTX 4080 SUPER A/B (0 separate RHS launches) |
