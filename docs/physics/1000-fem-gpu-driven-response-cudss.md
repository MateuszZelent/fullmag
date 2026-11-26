# FEM GPU. Direct sparse frequency-domain driven response (cuDSS)

Status `implemented / VRAM-guarded / qualified on RTX 4080 SUPER` (see [2026-11-26-fem-pgbb-kernels-dr-ab.md](../audits/2026-11-26-fem-pgbb-kernels-dr-ab.md)). Branch
`codex/fem-pgbb-kernels-dr-20261126`. The realization is governed by the public solver method policy
`FrequencyResponseSolverPolicy.method` (`"auto"`, `"gpu_sparse_direct"`, `"gpu_operator_host_krylov"`, default `"auto"`),
delivered to the native frequency-domain solver via `fullmag_fem_frequency_domain_gpu_direct_options` and
`fullmag_fem_frequency_domain_solve_driven_response_v14`, paired with one-time CSR demag operator export through
`fullmag_fem_backend_export_demag_poisson_sparse_blocks`.

(problem-statement)=
## Scope

This note covers the guarded GPU sparse direct linear solver (NVIDIA `cuDSS`, general complex double precision
`CUDA_C_64F`) for FEM frequency-domain driven response (`study.stages.add_frequency_response(...)`). Instead of
running host-orchestrated complex GMRES with repeated demag Poisson evaluations at every Krylov iteration and every
frequency point $\omega_k$, the direct solver assembles the coupled magnetic-tangent and magnetostatic scalar-potential
system $Z_{\mathrm{aug}}(\omega_k)$ in CSR format, applies six-pass Ruiz equilibration once, runs one symbolic
analysis (`CUDSS_PHASE_ANALYSIS`) across the entire frequency sweep, verifies a VRAM budget preflight before starting
factorization, updates only the $4 N_{m,\mathrm{eff}}$ frequency-dependent diagonal entries on the GPU per $\omega_k$,
factorizes and solves on device, and certifies every frequency point independently against the unscaled coupled
equations.

| Realization | Scope of this note | Evidence |
|---|---|---|
| FEM CPU | Not changed; host GMRES / Schur-reduced Krylov solvers remain unchanged | Source unchanged |
| FEM GPU | Guarded `auto` / `gpu_sparse_direct` / `gpu_operator_host_krylov` dispatch using 1x symbolic analysis `cuDSS` general complex LU with 2x2 block geometric pre-scaling + 6-pass Ruiz equilibration, VRAM preflight, independent GPU residual certification, and explicit fallback provenance across open, no-demag, and $k=0$ periodic airbox problems | Qualified on RTX 4080 SUPER (SM `89-real`, Docker DEV): `fem_driven_response_cudss_contract` (+ `compute-sanitizer --tool memcheck` 0 errors), non-MFEM CI 10/10, Rust `frequency_response` (55/55 default + 67/67 `fem-gpu`), Python round-trip PASS; `151.3×–454×` vs CPU GMRES (open P2 Robin), `2.89×–4.22×` vs GPU GMRES (`periodic_airbox_k0`), scales to `42,907` DOFs in `6.08 s` (`449.6 MiB`, 0 perturbed pivots, `r_q <= 1.15e-14`, `r_phi <= 1.45e-14`); see `docs/audits/2026-11-26-fem-pgbb-kernels-dr-ab.md` |
| FDM CPU | Not applicable | FDM uses structured-grid operators without FEM sparse CSR assembly |
| FDM GPU | Not applicable | FDM uses structured-grid operators without FEM sparse CSR assembly |

(governing-equations)=
## Equations

For each drive frequency $f_k$ with angular frequency $\omega_k = 2\pi f_k$ and convention sign
$\sigma_{\mathrm{conv}} \in \{+1, -1\}$ (`+1` for $\mathrm{e}^{+\mathrm{i}\omega t}$, `-1` for
$\mathrm{e}^{-\mathrm{i}\omega t}$), the linearized Landau–Lifshitz–Gilbert equation in the local tangent basis
$(e_1, e_2)$ coupled to the discrete magnetostatic Poisson equation forms the non-Hermitian sparse linear system:

```{math}
:label: eq-driven-augmented-system
Z_{\mathrm{aug}}(\omega_k)\begin{bmatrix} q \\ \delta\phi \end{bmatrix}
=
\begin{bmatrix}
K_{qq} + \sigma_{\mathrm{conv}}\,\mathrm{i}\omega_k M_{qq} & K_{q\phi} \\
-R_{\phi q} & P
\end{bmatrix}
\begin{bmatrix} q \\ \delta\phi \end{bmatrix}
=
\begin{bmatrix} f \\ 0 \end{bmatrix}
```

Here $K_{qq}$ assembles the real linearized exchange, Zeeman, uniaxial anisotropy, and interfacial/bulk DMI stiffness
blocks, $M_{qq}$ is the $2 \times 2$-block-diagonal precession and Gilbert damping mass matrix (with $M_{00} = M_{11} = \alpha$,
$M_{01} = -1$, $M_{10} = +1$ at each magnetic node), $P$ is the boundary-conditioned (or periodic-reduced) FEM
Poisson stiffness matrix, $R_{\phi q} = R_{\phi m} E_{\mathrm{lift}}$ maps tangent magnetization perturbations to the
Poisson right-hand side with all essential Dirichlet rows (`ess_tdofs`) explicitly zeroed, and
$K_{q\phi} = R_{\gamma_0} E_{\mathrm{lift}}^{\mathsf T} G_{\mathrm{rec}}$ maps $\delta\phi$ to the demagnetizing
contribution in the tangent LLG residual using the exact recovery matrices $G_{\mathrm{rec}}$ and per-node LLG rotation
$R_{\gamma_0}$ (`2x2` blocks scaling $\delta h_{\mathrm{demag}}$ by $\gamma_0$). For no-demag problems, the
$\delta\phi$ block is omitted and $Z_{\mathrm{aug}}(\omega_k) = K_{qq} + \sigma_{\mathrm{conv}}\,\mathrm{i}\omega_k M_{qq}$.

Because the magnetic rows ($O(10^9\text{--}10^{12})\,\mathrm{rad\,s^{-1}}$), magnetostatic Poisson rows
($O(10^{-8}\text{--}10^{-4})\,\mathrm{m}$), and off-diagonal coupling blocks ($K_{q\phi} \sim O(10^{13})$ vs.
$-R_{\phi q} \sim O(10^{-12})$) can span up to 25 orders of magnitude with strong off-diagonal asymmetry alongside
unit-diagonal `ess_tdofs` rows, exact $2 \times 2$ block geometric pre-scaling equalizes the four block infinity scales
(computing interior Poisson stiffness from multi-nonzero rows so unit-diagonal Dirichlet rows do not mask interior
entries) before six passes of Ruiz row/column infinity-norm equilibration compute positive real diagonal scaling
matrices $(D_r, D_c)$ from $|Z_{\mathrm{aug}}(\omega_{\mathrm{ref}})|$ at a reference sweep frequency
$\omega_{\mathrm{ref}}$ prior to symbolic analysis:

```{math}
:label: eq-driven-ruiz-equilibration
\hat{Z}_{\mathrm{aug}}(\omega_k) = D_r Z_{\mathrm{aug}}(\omega_k) D_c,\qquad
\hat{Z}_{\mathrm{aug}}(\omega_k) y = D_r b,\qquad
x = D_c y
```

For static $k = 0$ magnetic periodicity (including `periodic_airbox_k0`), magnetic equivalence classes are compressed
using row averaging $C_{\mathrm{per}}$ (weight $1/|C_r|$) and prolongation $L_{\mathrm{per}}$, while periodic
magnetostatic potentials are lifted from the reduced Poisson DOFs via $P_{\mathrm{pbc}}$:

```{math}
:label: eq-driven-static-periodic-reduction
Z_{\mathrm{red}}(\omega_k) =
\begin{bmatrix} C_{\mathrm{per}} & 0 \\ 0 & I \end{bmatrix}
Z_{\mathrm{aug}}(\omega_k)
\begin{bmatrix} L_{\mathrm{per}} & 0 \\ 0 & I \end{bmatrix},\qquad
q = L_{\mathrm{per}} q_{\mathrm{red}},\qquad
\delta\phi = P_{\mathrm{pbc}}\delta\phi_{\mathrm{red}}
```

Factorization starts only when the post-analysis peak device memory reported by `cuDSS` fits the device budget derived
from free VRAM and optional environment caps:

```{math}
:label: eq-driven-memory-budget
M_{\mathrm{margin}} = \max\!\left(M_0,\ \frac{M_{\mathrm{total}}}{20}\right),\qquad
B_{\mathrm{cap}} = \min\!\left(B_{\mathrm{bytes}},\ 2^{20} B_{\mathrm{MiB}}\right),\qquad
B = \min\!\left(M_{\mathrm{free}} - M_{\mathrm{margin}},\ B_{\mathrm{cap}}\right),\qquad
\hat{M}_{\mathrm{peak}} \le B
```

After every solve on $\hat{Z}_{\mathrm{aug}}(\omega_k)$, a fused device kernel recovers $x = D_c y = [q;\, \delta\phi]$
and certifies both blocks independently against the unscaled system without duplicating the CSR matrix on GPU:

```{math}
:label: eq-driven-residual-certification
r_q = f - (K_{qq} + \sigma_{\mathrm{conv}}\,\mathrm{i}\omega_k M_{qq})q - K_{q\phi}\delta\phi,\qquad
r_\phi = R_{\phi q} q - P\delta\phi,\qquad
\rho_q = \frac{\lVert r_q\rVert_2}{\max(\lVert f\rVert_2,\, \tau_{\mathrm{abs}})} \le \tau_{\mathrm{rel}},\qquad
\rho_\phi = \frac{\lVert r_\phi\rVert_2}{\max(\lVert R_{\phi q} q\rVert_2,\, \lVert P\delta\phi\rVert_2,\, a_\phi / \tau_{\mathrm{rel}})} \le \tau_{\mathrm{rel}}
```

When a divergence-free magnetic mode produces $R_{\phi q} q = 0$ and $\delta\phi = 0$, the Poisson denominator uses a
scale-aware roundoff floor so machine-noise residuals do not trigger false failures:

```{math}
:label: eq-driven-poisson-atol-floor
a_\phi = 10^{-14}\max\!\left(\lVert P\rVert_\infty\lVert\delta\phi\rVert_2,\ \lVert R_{\phi q}\rVert_\infty\lVert q\rVert_2,\ 10^{-300}\right)
```

(symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
|---|---|---|
| $Z_{\mathrm{aug}}(\omega_k)$ | Unscaled coupled frequency-domain linear operator at angular frequency $\omega_k$ | $\mathrm{rad\,s^{-1}}$ |
| $Z_{\mathrm{red}}(\omega_k)$ | Static-periodic reduced coupled operator formed by $C_{\mathrm{per}}$ and $L_{\mathrm{per}}$ | $\mathrm{rad\,s^{-1}}$ |
| $\hat{Z}_{\mathrm{aug}}(\omega_k)$ | Ruiz-equilibrated complex sparse matrix passed to `cuDSS` | $1$ |
| $\omega_k$ | Drive angular frequency $2\pi f_k$ at sweep index $k$ | $\mathrm{rad\,s^{-1}}$ |
| $\sigma_{\mathrm{conv}}$ | Harmonic phase convention sign ($+1$ for $\mathrm{e}^{+\mathrm{i}\omega t}$, $-1$ for $\mathrm{e}^{-\mathrm{i}\omega t}$) | $1$ |
| $K_{qq}$ | Linearized magnetic tangent stiffness operator (exchange, Zeeman, anisotropy, DMI) | $\mathrm{rad\,s^{-1}}$ |
| $M_{qq}$ | Block-diagonal LLG precession and Gilbert damping mass operator | $1$ |
| $K_{q\phi}$ | Magnetostatic-to-magnetic coupling block $R_{\gamma_0} E_{\mathrm{lift}}^{\mathsf T} G_{\mathrm{rec}}$ | $\mathrm{rad\,s^{-1}\,A^{-1}}$ |
| $R_{\phi q}$ | Magnetization-to-Poisson right-hand side operator with `ess_tdofs` rows explicitly zeroed | $\mathrm{A\,m}$ |
| $P$ | Boundary-conditioned or periodic-reduced FEM magnetostatic Poisson stiffness matrix | $\mathrm{m}$ |
| $q$ | Complex magnetic tangent perturbation vector in the local $(e_1, e_2)$ basis | $1$ |
| $q_{\mathrm{red}}$ | Static-periodic reduced magnetic tangent perturbation vector | $1$ |
| $\delta\phi$ | Complex dynamic magnetostatic scalar potential perturbation vector | $\mathrm{A}$ |
| $\delta\phi_{\mathrm{red}}$ | Reduced periodic scalar potential perturbation vector | $\mathrm{A}$ |
| $f$ | Complex tangent drive vector in LLG frequency-domain units | $\mathrm{rad\,s^{-1}}$ |
| $b$ | Stacked augmented right-hand side vector $[f;\, 0]$ | $\mathrm{rad\,s^{-1}}$ |
| $x$ | Unscaled augmented solution vector $[q;\, \delta\phi] = D_c y$ | $1$ |
| $y$ | Equilibrated solution vector returned by `cuDSS` | $1$ |
| $D_r$ | Positive real diagonal left Ruiz equilibration matrix | $1$ |
| $D_c$ | Positive real diagonal right Ruiz equilibration matrix | $1$ |
| $C_{\mathrm{per}}$ | Static-periodic row-averaging restriction matrix (weight $1/|C_r|$ per equivalence class) | $1$ |
| $L_{\mathrm{per}}$ | Static-periodic prolongation matrix mapping class representatives to magnetic nodes | $1$ |
| $P_{\mathrm{pbc}}$ | Periodic prolongation matrix mapping reduced Poisson DOFs to full airbox nodes | $1$ |
| $r_q$ | Unscaled magnetic block algebraic residual vector | $\mathrm{rad\,s^{-1}}$ |
| $r_\phi$ | Unscaled Poisson block algebraic residual vector | $\mathrm{A\,m}$ |
| $\rho_q$ | Relative Euclidean residual of the magnetic block | $1$ |
| $\rho_\phi$ | Relative Euclidean residual of the Poisson block | $1$ |
| $\tau_{\mathrm{rel}}$ | Relative residual tolerance certifying both magnetic and Poisson blocks | $1$ |
| $\tau_{\mathrm{abs}}$ | Absolute residual floor for the magnetic residual denominator | $\mathrm{rad\,s^{-1}}$ |
| $a_\phi$ | Scale-aware divergence-free floor for the Poisson residual denominator | $\mathrm{A\,m}$ |
| $M_{\mathrm{free}}$ | Free GPU memory reported by `cudaMemGetInfo` after symbolic analysis | $\mathrm{B}$ (byte) |
| $M_{\mathrm{total}}$ | Total GPU memory reported by `cudaMemGetInfo` | $\mathrm{B}$ (byte) |
| $M_0$ | Minimum safety margin, $536\,870\,912$ bytes (512 MiB) | $\mathrm{B}$ (byte) |
| $M_{\mathrm{margin}}$ | Device memory margin reserved for runtime allocations and display stability | $\mathrm{B}$ (byte) |
| $B_{\mathrm{bytes}}$ | Optional byte cap from `FULLMAG_FEM_DRIVEN_CUDSS_BUDGET_BYTES`; $+\infty$ when unset | $\mathrm{B}$ (byte) |
| $B_{\mathrm{MiB}}$ | Optional MiB cap from `FULLMAG_FEM_DRIVEN_CUDSS_MAX_VRAM_MIB`; $+\infty$ when unset | $1$ |
| $B_{\mathrm{cap}}$ | Combined optional VRAM cap $\min(B_{\mathrm{bytes}},\, 2^{20} B_{\mathrm{MiB}})$ | $\mathrm{B}$ (byte) |
| $B$ | Effective device memory budget available to `cuDSS` factorization | $\mathrm{B}$ (byte) |
| $\hat{M}_{\mathrm{peak}}$ | Peak device memory estimated by `cuDSS` after `CUDSS_PHASE_ANALYSIS` | $\mathrm{B}$ (byte) |

(assumptions-and-validity)=
## Assumptions and validity

- **General non-Hermitian complex LU (`CUDSS_MTYPE_GENERAL`, `CUDA_C_64F`):** The coupled LLG + Poisson operator
  $Z_{\mathrm{aug}}(\omega_k)$ is complex non-Hermitian and non-symmetric because of precession, DMI, and the opposite
  signs of $K_{q\phi}$ and $-R_{\phi q}$. `cuDSS` therefore runs general complex LU factorization in double precision.
- **Exact sparsity invariance across frequency:** All $4 N_{m,\mathrm{eff}}$ frequency-dependent diagonal $2 \times 2$
  blocks of $\sigma_{\mathrm{conv}}\,\mathrm{i}\omega_k M_{qq}$ are explicitly reserved in the CSR pattern during
  assembly even when a magnetic node has zero local stiffness $K_{\mathrm{loc}} = 0$. Consequently, symbolic analysis
  (`CUDSS_PHASE_ANALYSIS`) executes strictly once per sweep (`symbolic_analysis_count == 1`), and each frequency point
  updates only those $4 N_{m,\mathrm{eff}}$ entries on device before `CUDSS_PHASE_FACTORIZATION` and `CUDSS_PHASE_SOLVE`.
- **No silent fallback on numerical failure:** A singular operator (for example, undamped $\alpha = 0$ exact resonance
  causing `CUDSS_DATA_INFO != 0`), a non-finite solution, or an uncertified residual violating
  {eq}`eq-driven-residual-certification` **always** fails closed with `solve_error` — even under `solver_method="auto"`.
- **No silent fallback under forced `gpu_sparse_direct`:** When `solver_method="gpu_sparse_direct"` (`Required`),
  missing `cuDSS` support, unavailable Poisson sparse blocks, nonzero-k Floquet boundaries, or an over-budget VRAM
  estimate fails hard with zero fallback to Krylov or CPU.
- **Scope:** Supports open airbox Poisson demag (`poisson_robin`, `poisson_dirichlet`), no-demag GPU frequency
  response (open and static $k=0$ periodic, including exchange, Zeeman, uniaxial anisotropy, and interfacial/bulk DMI),
  and $k = 0$ periodic airbox (`periodic_airbox_k0`) with reduced periodic Poisson lifting and exact `G_rec` tangent
  demag field recovery. Nonzero-k Floquet boundaries and Fredkin–Koehler FEM/BEM demag are outside direct-solver scope
  (falling back to Krylov under `"auto"` and failing hard under `"gpu_sparse_direct"`).

(python-api)=
## Python API

The public `solver_method` parameter on `study.stages.add_frequency_response(...)` (backed by
`FrequencyResponseSolverPolicy`) accepts `"gpu_sparse_direct"` alongside `"auto"` and `"gpu_operator_host_krylov"`:

```python
# %% Study, engine, device and mode
import fullmag as fm

study = fm.study("fem_gpu_driven_response_cudss")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="auto", size=(600e-9, 600e-9, 120e-9), center=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=40e-9)
study.interactive(False)

# %% Geometry, material and mesh
film = study.geometry(fm.Box(size=(200e-9, 200e-9, 10e-9)), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
film.mesh(maximum_element_size=5e-9, order=1)

# %% Interactions and driven frequency-response stage
study.demag(realization="poisson_robin")
study.b_ext(50e-3, 0.0, 0.0)
study.build_domain_mesh()
study.stages.add_frequency_response(
    frequencies_hz=[4.0e9, 6.0e9, 8.0e9, 10.0e9],
    solver_method="gpu_sparse_direct",
    solver_rtol=1e-10,
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    include_demag=True,
    equilibrium_source="relax",
    damping_policy="include",
)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| FrequencyResponseSolverPolicy.method | str \| None | None | 1 | auto, dense_reference, cpu_sparse_direct, full_coupled_field_split, schur_reduced, modal_reduced, gpu_operator_host_krylov, gpu_device_krylov, or gpu_sparse_direct | Linear solver method selection (`auto` prefers GPU cuDSS when eligible and within VRAM budget; `gpu_sparse_direct` forces cuDSS with hard failure on unavailability or over-budget) | FEM GPU (`gpu_sparse_direct`), FEM CPU/GPU (`auto`) | stages[*].solver_policy.method |
| FrequencyResponseSolverPolicy.preconditioner | str \| None | None | 1 | auto, graph_demag_coarse, demag_coarse, block_jacobi, or none | Krylov preconditioner used on CPU or on GPU Krylov fallback (unused when `gpu_sparse_direct_cudss` executes) | FEM CPU/GPU | stages[*].solver_policy.preconditioner |
| FrequencyResponseSolverPolicy.rtol | float \| None | None | 1 | positive finite value | Relative Euclidean residual tolerance certifying both magnetic and Poisson blocks (defaults to $10^{-10}$ for `cuDSS` direct certification when unspecified) | FEM CPU/GPU | stages[*].solver_policy.rtol |
| FrequencyResponseSolverPolicy.max_iterations | int \| None | None | 1 | at least 1 | Krylov iteration limit (direct solves complete in one factorization and solve per frequency) | FEM CPU/GPU | stages[*].solver_policy.max_iterations |
| FrequencyResponseSolverPolicy.restart_iterations | int \| None | None | 1 | at least 1 | GMRES restart basis size for Krylov fallback | FEM CPU/GPU | stages[*].solver_policy.restart_iterations |

(problem-ir)=
## ProblemIR

The stage `solver_policy` fragment emitted by `study.stages.add_frequency_response(solver_method="gpu_sparse_direct", solver_rtol=1e-10, ...)`
serializes into `FrequencyResponseStageIR.solver_policy` (`crates/fullmag-ir/src/study.rs::FrequencyResponseSolverMethodIR::GpuSparseDirect`):

```json
{"method": "gpu_sparse_direct", "rtol": 1e-10}
```

When `solver_method` is omitted or `"auto"`, the runner maps `requested_device == Gpu` to
`FULLMAG_FEM_FREQUENCY_DOMAIN_GPU_DIRECT_POLICY_AUTO`; `"gpu_sparse_direct"` maps to
`FULLMAG_FEM_FREQUENCY_DOMAIN_GPU_DIRECT_POLICY_REQUIRED`; and `"gpu_operator_host_krylov"` maps to
`FULLMAG_FEM_FREQUENCY_DOMAIN_GPU_DIRECT_POLICY_DISABLED`.

(round-trip-and-failure-semantics)=
## Round trip and failure semantics

- **Requested intent vs. resolved execution:**
  - `requested_solver_method` preserves the user's **requested intent** (`"auto"`, `"gpu_sparse_direct"`, or
    `"gpu_operator_host_krylov"`).
  - `resolved_solver_method` records the **resolved execution** backend (`"gpu_sparse_direct_cudss"` when `cuDSS`
    executed, or `"gpu_operator_host_krylov"` when `"auto"` fell back or direct solving was disabled), propagated from
    native diagnostics into `response/diagnostics/solver.v1.json`, `response/diagnostics.v1.json`,
    `frequency_domain/manifest.v1.json`, and `response/frequency_points/frequency_XXXX.json`.
  - When `"gpu_sparse_direct_cudss"` executes, artifacts also publish `direct_solver_package="nvidia_cudss"`,
    `matrix_type="general_complex_f64"`, `symbolic_analysis_count`, `numeric_factorization_count`,
    `estimated_peak_device_bytes`, `device_budget_bytes`, `max_magnetic_relative_residual_l2`,
    `max_poisson_relative_residual_l2`, and `gpu_device_resident_solver=true`.
  - When `"auto"` falls back to Krylov, `solver_fallback_reason` records the exact cause
    (`"cudss_unavailable"`, `"vram_budget_exceeded"`, `"cudss_memory_estimate_unavailable"`,
    `"demag_sparse_blocks_unavailable"`, `"nonzero_k_floquet_unsupported"`).
- **Environment caps:** `FULLMAG_FEM_DRIVEN_CUDSS_BUDGET_BYTES` (positive integer bytes) and
  `FULLMAG_FEM_DRIVEN_CUDSS_MAX_VRAM_MIB` (positive integer MiB, checked for `uint64_t` overflow) combine via
  $\min$ in {eq}`eq-driven-memory-budget`.
- **Validation errors**: malformed or overflowing `FULLMAG_FEM_DRIVEN_CUDSS_BUDGET_BYTES` /
  `FULLMAG_FEM_DRIVEN_CUDSS_MAX_VRAM_MIB` values, invalid `solver_method` strings, ABI mismatches on
  `fullmag_fem_demag_poisson_sparse_blocks` or `fullmag_fem_frequency_domain_gpu_direct_options`, singular matrices
  (`CUDSS_DATA_INFO != 0`), non-finite solutions, or uncertified residuals failing
  {eq}`eq-driven-residual-certification` **always** fail closed — even under `solver_method="auto"`.
- **Unsupported combinations**: requesting `solver_method="gpu_sparse_direct"` on CPU (`requested_device="cpu"`),
  with nonzero-k Floquet boundaries (`magnetostatic_bc="floquet_airbox"` or nonzero-k `spin_wave_bc="floquet"`),
  with non-Poisson Fredkin–Koehler demag, without `cuDSS` compiled in, or when the estimated VRAM peak exceeds
  {eq}`eq-driven-memory-budget` fails hard with zero silent fallback to Krylov or CPU. Under `"auto"`, GPU nonzero-k
  Floquet, Fredkin–Koehler demag, missing `cuDSS`, and over-budget VRAM fall back explicitly to
  `gpu_operator_host_krylov` with `solver_fallback_reason`.

(discrete-realization)=
## Discrete realization and residency

1. **One-time sparse block export:** For GPU Poisson demag (`poisson_robin`, `poisson_dirichlet`, and
   `periodic_airbox_k0`), `export_demag_poisson_sparse_blocks` extracts `periodic_reduced_ready ? periodic_matrix : poisson_bc_op`
   for $P$, copies `rhs_{x,y,z}` with all `ess_tdofs` rows explicitly emptied/zeroed, copies `recovery_{x,y,z}`
   ($G_{\mathrm{rec}}$), and exports `magnetic_node_indices` and `periodic_reduced_node` in sorted 0-based `uint32_t`
   CSR format.
2. **Coupled CSR assembly and static-periodic reduction:** `solve_driven_response_gpu_cudss` assembles $K_{qq}$,
   $K_{q\phi} = R_{\gamma_0} E_{\mathrm{lift}}^{\mathsf T} G_{\mathrm{rec}}$, $-R_{\phi q}$ (skipping any `ess_tdofs`
   row defensively), and $P$ into a single sorted 0-based complex CSR matrix, applying {eq}`eq-driven-static-periodic-reduction`
   when static $k=0$ periodicity is active and explicitly reserving all $4 N_{m,\mathrm{eff}}$ diagonal mass/damping slots.
3. **Block geometric pre-scaling and six-pass Ruiz equilibration:** Seeds the $\delta\phi$ row and column scales from
   exact $2 \times 2$ block geometric ratios on $|Z_{\mathrm{aug}}(\omega_{\mathrm{ref}})|$ (measuring interior
   Poisson stiffness separately from single-entry `ess_tdofs` rows to eliminate $10^{25}$ off-diagonal asymmetry),
   refines $(D_r, D_c)$ with six Ruiz passes, stores scaled base entries and diagonal index/value maps, and uploads the
   CSR pattern and base arrays once to the GPU.
4. **One-time symbolic analysis and VRAM preflight:** Executes `CUDSS_PHASE_ANALYSIS` once, queries
   `CUDSS_DATA_MEMORY_ESTIMATES` and `cudaMemGetInfo`, and checks {eq}`eq-driven-memory-budget`. Over-budget plans
   release all `cuDSS` and device allocations before `CUDSS_PHASE_FACTORIZATION` starts.
5. **Per-frequency sweep loop:** For each $\omega_k$: checks cancellation, runs `launch_driven_response_update_omega_entries`
   to update only the $4 N_{m,\mathrm{eff}}$ scaled diagonal entries in place on GPU, binds values via
   `cudssMatrixSetValues`, runs `CUDSS_PHASE_FACTORIZATION` (checking `CUDSS_DATA_INFO == 0`) and `CUDSS_PHASE_SOLVE`,
   runs `launch_driven_response_unscaled_residual_cert` (Blue/LAPACK scaled-norm multi-block `cub::BlockReduce`
   recovering $x = D_c y$ and certifying {eq}`eq-driven-residual-certification` with a single scalar D2H readback),
   lifts static-periodic $q_{\mathrm{red}} \to q$ and $\delta\phi_{\mathrm{red}} \to \delta\phi$, recovers tangent
   demag field $\delta h_{\mathrm{demag}} = E_{\mathrm{lift}}^{\mathsf T} G_{\mathrm{rec}} \delta\phi$ when requested,
   and emits progress telemetry.

(implementation-mapping)=
## Implementation mapping

- `backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.cpp::export_demag_poisson_sparse_blocks` and
  `destroy_demag_poisson_sparse_blocks` export sorted 0-based CSR Poisson blocks ($P$, `ess_tdofs`-zeroed $R_{\phi m}$,
  $G_{\mathrm{rec}}$, `magnetic_node_indices`, `periodic_reduced_node`) and release owned host storage.
- `backends/fem/gpu/frequency_domain/driven_response_cudss.cpp::solve_driven_response_gpu_cudss` implements coupled CSR
  assembly, six-pass Ruiz equilibration, 1x `CUDSS_PHASE_ANALYSIS`, VRAM preflight {eq}`eq-driven-memory-budget`,
  per-frequency factorization/solve, independent residual certification, periodic lifting, and `G_rec` demag recovery.
- `backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu::launch_driven_response_update_omega_entries` and
  `launch_driven_response_unscaled_residual_cert` perform in-place diagonal $\omega_k$ updates and fused multi-block
  unscaled residual certification without duplicating the GPU CSR matrix.
- `backends/fem/src/frequency_domain/driven_response_solver.cpp::solve_mfem_production_gpu_problem` and
  `solve_periodic_airbox_dynamic_demag_mfem_phi_consistency_schur` dispatch GPU open, no-demag, and
  `periodic_airbox_k0` sweeps through `cuDSS` before Krylov fallback and publish full JSON diagnostics.
- `backends/fem/src/api.cpp::fullmag_fem_frequency_domain_solve_driven_response_v14` and
  `fullmag_fem_backend_export_demag_poisson_sparse_blocks` (declared in `native/include/fullmag_fem.h` via
  `fullmag_fem_frequency_domain_solve_driven_response_v14`, mirrored in `crates/fullmag-fem-sys/src/lib.rs` via
  `fullmag_fem_demag_poisson_sparse_blocks`) provide the frozen C/Rust ABI seams.
- `crates/fullmag-ir/src/study.rs::FrequencyResponseSolverMethodIR`,
  `crates/fullmag-runner/src/native_fem/frequency_domain.rs::export_demag_poisson_sparse_blocks_raw`,
  `crates/fullmag-runner/src/frequency_response.rs::frequency_response_solver_method_rejection_reason`,
  `crates/fullmag-runner/src/frequency_response.rs::resolve_native_frequency_response_solver_provenance`, and
  `packages/fullmag-py/src/fullmag/model/study.py::class FrequencyResponseSolverPolicy` wire public configuration,
  policy validation, one-time sparse block export, and artifact provenance end to end.

(validation)=
## Validation

**Plan.**

1. Native GPU direct-solver contract suite (`backends/fem/tests/frequency_domain/driven_response_cudss_contract.cpp`):
   - Policy, environment-cap validation (bad/zero/overflow env vars fail closed under `Auto`), nonzero-k Floquet
     rejection vs. fallback, and missing sparse-block handling (portable across CPU-only and GPU builds).
   - No-demag 10-frequency sweep with exchange, Zeeman, uniaxial anisotropy, DMI, and zero-$K_{\mathrm{loc}}$ node
     parity against dense complex oracle (`symbolic_analysis_count == 1`, `numeric_factorization_count == 10`, pageable
     readback parity under `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1`).
   - Coupled airbox $10^{20}$ block-scale disparity, $10^{25}$ open-airbox asymmetric-coupling block geometric
     pre-scaling with uncoupled airbox rows, and `ess_tdofs` zeroing verified against dense Schur oracle
     ($\rho_q, \rho_\phi \le 10^{-11}$, max relative solution error $< 10^{-10}$).
   - Divergence-free mode Poisson residual floor {eq}`eq-driven-poisson-atol-floor` verification.
   - Tight VRAM budget (`FULLMAG_FEM_DRIVEN_CUDSS_BUDGET_BYTES=1`) verifying clean `Auto` fallback with zero
     factorizations (`numeric_factorization_count == 0`, `fallback_reason == "vram_budget_exceeded"`) vs. hard
     `Required` failure.
   - Singular $\alpha = 0$ exact-resonance matrix verifying fail-closed `solve_error` even under `Auto`.
   - `periodic_airbox_k0` reduced periodic Poisson lifting (`periodic_reduced_node`) and `G_rec` tangent `h_demag`
     recovery parity.
2. Rust policy and provenance unit tests (`crates/fullmag-runner/src/frequency_response.rs`): verify
   `gpu_sparse_direct` GPU-only and non-Floquet policy checks plus `gpu_sparse_direct_cudss` and `auto` fallback
   artifact patching across `solver.v1.json`, `manifest.v1.json`, and `frequency_0000.json`.
3. Python API round-trip test (`packages/fullmag-py/tests/test_api.py`): verifies `solver_method="gpu_sparse_direct"`
   serialization to `ProblemIR` and script rewrite round-trip.
4. Docker DEV RTX 4080 SUPER qualification (build + `fem_driven_response_cudss_contract` + multi-frequency open and
   `periodic_airbox_k0` parity vs. Krylov reference) pending coordinator validation phase.

**Results (qualified on RTX 4080 SUPER, SM `89-real`, Docker DEV, `311062d617` vs `9ab99132d5`, `docs/audits/2026-11-26-fem-pgbb-kernels-dr-ab.md`):**
- **Contract, non-MFEM, and memory safety:** `fem_driven_response_cudss_contract` (including `test_asymmetric_1e25_open_airbox_block_prescaling`, `compute-sanitizer --tool memcheck` **0 errors**), `fem_driven_response_contract`, `fem_frequency_domain_contract`, non-MFEM CI (`10/10 PASS`), Rust `fullmag-fem-sys` (`54/54`), `fullmag-ir` (`289/289`), `fullmag-plan` (`688/688`), `fullmag-runner` (`frequency_response` `55/55` default + `67/67` `fem-gpu`), and Python round-trip test (`test_api.py`) all **PASS**.
- **Open-airbox P2 Robin (`3A_open_small`, `1,687` complex DOFs, $\alpha = 0.01$, $\mathrm{rtol} = 10^{-10}$):** 8-frequency sweep `208.02 ms` vs `31,473.60 ms` CPU GMRES (**`151.3×`** E2E; `216.44 ms` = `8.66 ms/freq` over 25 frequencies = **`454×`** amortized ms/freq; `1` analysis / `25` factorizations; `11.7 MiB` peak VRAM; 8-frequency `vector_tangent_complex` parity **`5.32e-10`**).
- **2D periodic airbox `k=0` (`3C_periodic_k0`, `1,690` DOFs & `3C_periodic_k0_large`, `4,410` DOFs, 25 frequencies):** **`692.69 ms`** vs `2,919.94 ms` GPU GMRES (**`4.22×`**, parity **`3.08e-11`**) and **`1,248.18 ms`** vs `3,603.07 ms` (**`2.89×`**, parity **`3.04e-11`**); `vram_cap_auto` (`1 MiB`) triggers clean explicit fallback with `0.000e+00` parity vs GPU GMRES.
- **Large open-airbox P2 Robin scaling (25 frequencies `1–25 GHz`, 2×2 block geometric pre-scaling + 6-pass Ruiz):** `7,987` DOFs in `965.26 ms` (`63.6 MiB`), `21,991` DOFs in `2,690.40 ms` (`203.8 MiB`, `r_q = 3.01e-15`, `r_phi = 1.02e-14`), `42,907` DOFs in **`6,076.59 ms`** (`449.6 MiB`, `r_q = 1.15e-14`, `r_phi = 1.45e-14`), **25/25 PASS**, `1` symbolic analysis / `25` numeric factorizations, **`0` perturbed pivots**; `vram_cap_req` (`1 MiB`, `Required`) fails closed before factorization with `cudss_peak_memory_budget_exceeded` (`1 / 0`).

(limitations)=
## Limitations

- Single-GPU, single-process, `FP64` complex (`CUDA_C_64F`) only; multi-GPU distribution is not implemented.
- Nonzero-k Floquet/Bloch boundaries (`floquet_airbox` and nonzero-k `spin_wave_bc="floquet"`) and Fredkin–Koehler
  FEM/BEM demag are outside current direct-solver scope (`Auto` falls back to `gpu_operator_host_krylov`;
  `gpu_sparse_direct` fails hard).
- Symbolic analysis (`CUDSS_PHASE_ANALYSIS`) executes before `cuDSS` reports `CUDSS_DATA_MEMORY_ESTIMATES`, so an
  extremely large mesh could still exhaust device memory during analysis prior to the factorization budget check.
- Equilibration scaling $(D_r, D_c)$ is computed once at a single reference frequency $\omega_{\mathrm{ref}}$; sweeps
  spanning extreme frequency ratios rely on independent unscaled residual certification {eq}`eq-driven-residual-certification`
  to fail closed if conditioning degrades.

(scientific-bibliography)=
## Bibliography

- D. Ruiz, "A scaling algorithm to equilibrate both rows and columns norms in matrices", Technical Report RAL-TR-2001-034,
  Rutherford Appleton Laboratory (2001).
- T. A. Davis, *Direct Methods for Sparse Linear Systems*, SIAM (2006),
  [doi:10.1137/1.9780898718881](https://doi.org/10.1137/1.9780898718881).
- J. L. Blue, "A portable Fortran program to find the Euclidean norm of a vector", ACM Trans. Math. Softw. 4(1) (1978)
  15–23, [doi:10.1145/355769.355771](https://doi.org/10.1145/355769.355771).
- [NVIDIA cuDSS documentation](https://docs.nvidia.com/cuda/cudss/), general complex LU (`CUDSS_MTYPE_GENERAL`,
  `CUDA_C_64F`) and `CUDSS_DATA_MEMORY_ESTIMATES` preflight interface.
- [Note 0997](0997-fem-gpu-poisson-direct-cudss.md) documents the shared `cuDSS` VRAM safety budget discipline for
  time-domain demag Poisson and FEM/BEM solves.

(source-code-index)=
## Source-code index

| Path | Symbol | Responsibility | Lane and evidence |
|---|---|---|---|
| `backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.cpp` | `export_demag_poisson_sparse_blocks` | Exports open or periodic-reduced Poisson matrix $P$, `ess_tdofs`-zeroed $R_{\phi m}$, $G_{\mathrm{rec}}$, and node maps as sorted CSR | FEM GPU; contract test |
| `backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.cpp` | `destroy_demag_poisson_sparse_blocks` | Releases owned CSR buffers attached to exported Poisson sparse blocks | FEM GPU; contract test |
| `backends/fem/gpu/frequency_domain/driven_response_cudss.cpp` | `solve_driven_response_gpu_cudss` | Coupled CSR assembly, Ruiz equilibration, 1x cuDSS analysis, VRAM preflight, per-frequency LU solve, certification, and lifting | FEM GPU; contract test |
| `backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu` | `launch_driven_response_update_omega_entries` | In-place GPU update of the $4 N_{m,\mathrm{eff}}$ frequency-dependent diagonal mass/damping entries | FEM GPU; contract test |
| `backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu` | `launch_driven_response_unscaled_residual_cert` | Fused multi-block GPU unscaling $x = D_c y$ and Blue-norm residual certification for magnetic and Poisson blocks | FEM GPU; contract test |
| `backends/fem/src/frequency_domain/driven_response_solver.cpp` | `solve_mfem_production_gpu_problem` | Routes open and no-demag production GPU sweeps through cuDSS before Krylov fallback with explicit diagnostics | FEM GPU; contract test |
| `backends/fem/src/frequency_domain/driven_response_solver.cpp` | `solve_periodic_airbox_dynamic_demag_mfem_phi_consistency_schur` | Routes `periodic_airbox_k0` GPU sweeps through cuDSS with periodic lifting and `G_rec` demag recovery | FEM GPU; contract test |
| `backends/fem/src/api.cpp` | `fullmag_fem_frequency_domain_solve_driven_response_v14` | C ABI entry point delivering `gpu_direct_policy` and optional exported Poisson sparse blocks | FEM GPU; ABI |
| `backends/fem/src/api.cpp` | `fullmag_fem_backend_export_demag_poisson_sparse_blocks` | C ABI entry point exporting sparse Poisson CSR blocks from an initialized FEM backend | FEM GPU; ABI |
| `native/include/fullmag_fem.h` | `fullmag_fem_frequency_domain_solve_driven_response_v14` | Public C ABI declaration of v14 driven response solve, direct options, and sparse Poisson block export | FEM GPU; ABI |
| `crates/fullmag-fem-sys/src/lib.rs` | `fullmag_fem_demag_poisson_sparse_blocks` | Rust FFI layout-verified mirror of exported Poisson CSR blocks and v14 direct options | FEM GPU; mirror test |
| `crates/fullmag-ir/src/study.rs` | `FrequencyResponseSolverMethodIR` | Canonical `ProblemIR` solver method enum including `GpuSparseDirect` | FEM; unit test |
| `crates/fullmag-runner/src/native_fem/frequency_domain.rs` | `export_demag_poisson_sparse_blocks_raw` | Invokes C ABI Poisson sparse-block export on `NativeFemBackend` and wires v14 solve dispatch | FEM GPU; unit test |
| `crates/fullmag-runner/src/frequency_response.rs` | `frequency_response_solver_method_rejection_reason` | Validates `gpu_sparse_direct` GPU-only and non-Floquet requirements fail-closed | FEM; unit test |
| `crates/fullmag-runner/src/frequency_response.rs` | `resolve_native_frequency_response_solver_provenance` | Extracts resolved solver method, cuDSS telemetry, and auto-fallback reason for artifact patching | FEM; unit test |
| `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponseSolverPolicy` | Public Python frequency-response solver policy accepting `gpu_sparse_direct` | FEM CPU/GPU; unit test |
