# FEM multiphysics sparse and parallel linear solvers (Oersted OE-F2, OE-F1, charge/spin transport, and OE-T0 KKT)

- Status: verified reference modernization across 5 build profiles and A/B benchmarks (2026-11-26); C ABI v1/v2/v3 and planner GPU promotion remain deferred
- Owners: Fullmag FEM multiphysics (Oersted and charge/spin transport)
- Last updated: 2026-11-26
- Related A/B audit: `docs/audits/2026-11-26-fem-multiphysics-solvers-ab.md`
- Related physics owners:
  - `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`
  - `docs/physics/0970-spin-hall-drift-diffusion-transport.md`
  - `docs/physics/0980-dynamic-current-and-oersted-coupling.md`
  - `docs/physics/0981-fem-oet0-sparse-kkt.md`
- Related design specification: `docs/superpowers/specs/2026-11-26-fem-multiphysics-solvers-design.md`

(problem-statement)=
## 1. Problem statement

Native FEM multiphysics workflows in Fullmag couple four linear-algebra and
quadrature kernels whose baseline reference implementations hit severe
memory or wall-time walls:

1. **Oersted vector potential (OE-F2)** assembled a dense $(N_{\mathrm{ND}} + N_{H^1})^2$
   saddle-point matrix and dense $H^1$ mass inverse, imposing $O(N^3)$ time,
   $O(N^2)$ RAM, and a hard cap of `4096` Nédélec DOFs and `2048` $H^1$ DOFs.
2. **Direct tetrahedral Biot--Savart quadrature (OE-F1)** evaluated all
   $N_t \cdot N_s$ pairs serially on one CPU thread, accessed `mfem::IntRules`
   inside inner loops, and repeated the full 3-vector quadrature three times in
   `ProjectField`.
3. **Multi-terminal charge transport and coupled M1/M2 spin transport**
   reassembled and re-solved the conductivity stiffness matrix $T - C + 1$
   times across $T$ terminals, rebuilt the reduced quotient matrix on every
   `ChargeTraceWorkspace::solve` call, and applied unpreconditioned
   `GMRESSolver(100)` to nonsymmetric spin-precession and reciprocal systems.
4. **Conservative RT0 current reconstruction (OE-T0 KKT)** solved its sparse
   indefinite KKT block system with `MINRES` preconditioned only by an identity
   operator on the constraint block.

This note documents the unified 3-tier sparse linear solver engine
(`SparseLinearSolver`), symmetric nanometer-scale saddle-point equilibration,
0-ULP deterministic multi-threaded CPU and opt-in 106-bit CUDA far-field
quadrature, and factor-once multi-RHS transport/KKT solvers built strictly on
libraries already linked in `backends/fem/CMakeLists.txt` (PETSc/MUMPS/METIS,
HYPRE BoomerAMG/AMS/ILU, `std::thread`, and CUDA/cuDSS). None of these
numerical realizations alters governing physics, sign conventions, units, or
the public C ABI negative gates.

(governing-equations)=
## 2. Governing equations

### 2.1 Shared equilibrated sparse saddle-point formulation (OE-F2 and OE-T0)

For a symmetric saddle-point operator with SPD or semi-definite top-left block
$A \in \mathbb{R}^{n_A \times n_A}$ and coupling block
$B \in \mathbb{R}^{n_A \times n_B}$ (either the OE-F2 curl-curl/gradient pair
$(K_{\mathrm{curl}}, G)$ or the OE-T0 weighted mass/constraint pair
$(M_f, C_f^{\mathsf{T}})$), nanometer-scale geometries induce
$\|A\| / \|B\| \sim 10^{22}$. Symmetric block equilibration rescales the
Lagrange multiplier $\tilde{p} = \beta^{-1} p$ using

```{math}
:label: multiphysics-equilibrated-saddle
\beta = \frac{\operatorname{mean}_{i:|A_{ii}|>0} |A_{ii}|}{\operatorname{rms}_{B_{ij} \neq 0}(B_{ij})}, \qquad
S_\beta \begin{bmatrix} u \\ \tilde{p} \end{bmatrix} =
\begin{bmatrix} A & \beta B \\ \beta B^{\mathsf{T}} & 0 \end{bmatrix}
\begin{bmatrix} u \\ \tilde{p} \end{bmatrix} =
\begin{bmatrix} f \\ \beta g \end{bmatrix}, \qquad
p = \beta \tilde{p}.
```

Every solve is independently certified against the original unpreconditioned
CSR matrix in extended precision (`long double`):

```{math}
:label: multiphysics-independent-residual
r_{\mathrm{rel}} = \frac{\|b - M x\|_2}{\max(r_{\mathrm{floor}}, \|b\|_2)},
```

with up to $k_{\mathrm{ref}}$ iterative-refinement sweeps on direct factors
whenever $r_{\mathrm{rel}} > \varepsilon_{\mathrm{rel}}$.

### 2.2 $h$-independent AMS/BoomerAMG saddle-point preconditioning for OE-F2

Using the discrete de Rham identity $(K_{\mathrm{curl}} + \gamma M_{\mathrm{ND}})\Pi_\nabla = \gamma G$
with domain diameter $L = \operatorname{diam}(\Omega)$ and scale parameter

```{math}
:label: multiphysics-oersted-ams-preconditioner
\gamma = \frac{1}{\mu_0 L^2}, \qquad
\mathcal{P}_{\mathrm{OE-F2}} = \operatorname{diag}\!\Big(
  \operatorname{AMS}(K_{\mathrm{curl}} + \gamma M_{\mathrm{ND}}),\;
  \operatorname{BoomerAMG}\!\big(\tfrac{\beta^2}{\gamma} L_{H^1}\big)
\Big),
```

solenoidal eigenvalues stay uniformly clustered in $[C_P/(C_P+1), 1)$
independent of $h$, $L$, and $\mu_0$ (including $L = 10^{-7}\,\mathrm{m}$),
while gradient/multiplier eigenvalues remain $\pm 1$.

### 2.3 Far-field / near-singular partition for opt-in CUDA OE-F1 quadrature

For each source tetrahedron $s$ with circumsphere center $c_s$, bounding
radius $R_s$, and target point $x_t$, the direct Biot--Savart integral

```{math}
:label: multiphysics-direct-tetra-partition
H(x_t) = \frac{1}{4\pi} \sum_{s=1}^{N_s} \int_{K_s} \frac{J_s(y) \times (x_t - y)}{\|x_t - y\|_2^3}\,\mathrm{d}V_y
```

routes every near or singular pair satisfying
$\|x_t - c_s\|_2 \le \kappa_{\mathrm{near}} R_s$ ($\kappa_{\mathrm{near}} = 3.0$)
or failing the root-level error gate to authoritative CPU `long double` Duffy
and adaptive octree subdivision, while smooth far-field pairs
$\|x_t - c_s\|_2 > \kappa_{\mathrm{near}} R_s$ are accumulated in ascending
source order using 106-bit double-double (`TwoSum`/`TwoProd`) arithmetic.

### 2.4 Factor-once multi-RHS charge transport and degree-guarded Schur KKT

For $T$ terminals spanning $C$ connected components, the eliminated conductivity
operator $K_\sigma$ is assembled and factored once per call and reused across
$T - C + 1$ right-hand sides via $K_\sigma x^{(k)} = b^{(k)}$. For Tier-2
OE-T0 KKT `MINRES`, rows of $C_f$ with degree $\le 64$ contribute to the
approximate SPD Schur complement while dense terminal rows are diagonalized in
the preconditioner only:

```{math}
:label: multiphysics-oet0-schur-preconditioner
\tilde{S} = \beta^2 \tilde{C}_f \operatorname{diag}(M_f)^{-1} \tilde{C}_f^{\mathsf{T}}.
```

(symbols-and-si-units)=
### 2.5 Symbols and SI units

| Symbol | Meaning | SI unit / condition |
|---|---|---|
| `A` | top-left sparse block operator | $\mathrm{(discrete\;SI)}$ |
| `B` | sparse saddle-point coupling block | $\mathrm{(discrete\;SI)}$ |
| `\beta` | symmetric saddle-point equilibration scalar | $1$ (positive finite ratio) |
| `S_\beta` | symmetrically equilibrated CSR saddle-point matrix | $\mathrm{(discrete\;SI)}$ |
| `u` | primary finite-element solution vector | $\mathrm{T\,m}$ or $\mathrm{RT0\;DOF}$ |
| `p` | physical Lagrange multiplier vector | $\mathrm{A\,m^{-1}}$ or dual flux unit |
| `\tilde{p}` | equilibrated Lagrange multiplier vector | $\beta^{-1}\cdot\text{dual unit}$ |
| `f` | primary block right-hand side | $\mathrm{(discrete\;SI)}$ |
| `g` | constraint block right-hand side | $\mathrm{(discrete\;SI)}$ |
| `M` | general assembled sparse linear system matrix | $\mathrm{(discrete\;SI)}$ |
| `x` | discrete solution vector | $\mathrm{(discrete\;SI)}$ |
| `b` | discrete right-hand-side vector | $\mathrm{(discrete\;SI)}$ |
| `r_{\mathrm{rel}}` | extended-precision independent unpreconditioned relative residual | $1$ |
| `r_{\mathrm{floor}}` | relative-residual denominator floor | $1$ |
| `\varepsilon_{\mathrm{rel}}` | solver relative residual tolerance | $1$ |
| `k_{\mathrm{ref}}` | maximum direct-solver iterative-refinement sweeps | $1$ |
| `\mu_0` | vacuum permeability | $\mathrm{H\,m^{-1}}$ |
| `L` | finite-element mesh bounding-box diameter | $\mathrm{m}$ |
| `\gamma` | AMS solenoidal stabilization weight $\mu_0^{-1} L^{-2}$ | $\mathrm{A\,V^{-1}\,s^{-1}\,m^{-1}}$ |
| `K_{\mathrm{curl}}` | $H(\mathrm{curl})$ stiffness matrix | $\mathrm{A\,T^{-1}\,m^{-1}}$ |
| `M_{\mathrm{ND}}` | Nédélec mass matrix | $\mathrm{m}$ |
| `L_{H^1}` | $H^1$ scalar Laplacian matrix | $\mathrm{m}$ |
| `\mathcal{P}_{\mathrm{OE-F2}}` | block-diagonal AMS/BoomerAMG SPD preconditioner | $\mathrm{(discrete\;SI)}$ |
| `H` | magnetic field intensity | $\mathrm{A\,m^{-1}}$ |
| `J_s` | affine RT0 source current density on tetrahedron $K_s$ | $\mathrm{A\,m^{-2}}$ |
| `x_t` | target evaluation coordinate | $\mathrm{m}$ |
| `c_s` | source tetrahedron bounding-sphere center | $\mathrm{m}$ |
| `R_s` | source tetrahedron bounding-sphere radius | $\mathrm{m}$ |
| `\kappa_{\mathrm{near}}` | near-singular handoff radius multiplier | $1$ |
| `N_s` | source tetrahedron count | $1$ |
| `K_\sigma` | eliminated $H^1$ conductivity stiffness matrix | $\mathrm{S}$ |
| `\tilde{S}` | degree-guarded SPD Schur-complement preconditioner for OE-T0 KKT | $\mathrm{(discrete\;SI)}$ |
| `M_f` | free-DOF RT0 weighted mass matrix | $\mathrm{(discrete\;SI)}$ |
| `\tilde{C}_f` | degree-guarded constraint matrix used only in preconditioner $\tilde{S}$ | $1$ |

(assumptions-and-validity)=
## 3. Assumptions and validity limits

- All solvers operate in binary64 (`double`) with extended-precision
  (`long double` on CPU, 106-bit `DoubleDouble` on CUDA far-field) residual or
  quadrature accumulation.
- Strict CPU/GPU lane separation (`AGENTS.md`): default CPU paths never invoke
  CUDA or cuDSS; explicit GPU opt-in paths (`SparseExecutionTarget::GpuCudss`,
  `DirectTetraExecutionPolicy::GpuHybridFarField`) fail closed with
  `std::runtime_error` when CUDA/cuDSS is absent, VRAM preflight fails, or
  `CUDSS_DATA_INFO != 0` — zero silent CPU fallback.
- Under `FULLMAG_OET0_TSAN=ON` (`FULLMAG_OET0_DISABLE_MPI=1`), PETSc and MPI
  are neither linked nor called; all solves execute on the TSan-clean Tier-3
  MFEM serial lane.
- Under multi-rank MPI (`mpiexec -n 2`), `reference_mpi_gather_*_broadcast`
  explicitly pins single-threaded deterministic `SparseCpuBackendPolicy::MfemSerial`
  for rank-0 SPD charge/lead solves (preventing OpenMP `HypreBoomerAMG` thread-count
  nondeterminism) and `MPI_COMM_SELF` Tier-2 Schur-AMG `MINRES` for constrained
  sparse KKT across both `n=1` and `n=2`, while `SparseLinearSolver` additionally
  guards against collective `PetscInitializeNoArguments()` when `MPI_COMM_WORLD`
  has size $> 1$.
- Under CUDA-enabled HYPRE builds, CPU Tier-2 calls `configure_hypre_host_policy()`
  and requires both `memory_location_host && execution_policy_host` before
  instantiating any HYPRE object.

(python-api)=
## 4. Python API and authoring boundary

No new user-facing Python API, solver enum, or `ProblemIR` schema break is
introduced by Wave 2. Existing stage-first authoring for `CurrentTransport`
and `OerstedField` remains unchanged; the only Rust IR change is raising the
OE-F2 reference DOF caps `ANTENNA_VECTOR_POTENTIAL_MAX_ND_DOFS` (`2_000_000`)
and `ANTENNA_VECTOR_POTENTIAL_MAX_H1_DOFS` (`1_000_000`) in
`crates/fullmag-ir/src/antenna.rs`. Existing C ABI v1/v2/v3 entry points keep
their exact struct sizes and negative `GPU_DOUBLE -> FULLMAG_FEM_ERR_UNAVAILABLE`
gates while appending `resolved_*_solver` telemetry keys inside
`diagnostics_json`.

```python
# %% canonical authoring boundary (unchanged by Wave 2 solver modernization)
import fullmag as fm

study = fm.study("fem_multiphysics_sparse_modernization")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

drive = fm.CurrentTransport(
    name="antenna_drive",
    model="prescribed_density",
    current_density=(2.5e10, 0.0, 0.0),
)
oersted = fm.OerstedField(source="antenna_drive", model="from_current_solution")

assert drive.to_ir()["name"] == "antenna_drive"
assert oersted.to_ir()["source"] == "antenna_drive"
```

(problem-ir)=
### 4.1 Python-to-ProblemIR mapping

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `CurrentTransport.name` | `str` | required | $1$ | non-empty unique identifier | named charge/current source | FEM/FDM authoring | `current_transport[].name` |
| `CurrentTransport.model` | `str` | `prescribed_density` | $1$ | supported transport constitutive model | charge/spin source formulation | FEM/FDM per planner | `current_transport[].model` |
| `OerstedField.source` | `str` | required | $1$ | matches one CurrentTransport.name | current source feeding OE-F1/OE-F2 | FEM/FDM authoring | `oersted[].source` |
| `OerstedField.model` | `str` | `from_current_solution` | $1$ | supported Oersted model | field realization intent | FEM/FDM per planner | `oersted[].model` |
| `ANTENNA_VECTOR_POTENTIAL_MAX_ND_DOFS` | `usize` | `2_000_000` | $1$ | positive bound checked on mesh/space | maximum OE-F2 Nédélec DOFs | FEM CPU sparse lane | `antenna.vector_potential.max_nd_dofs` |
| `ANTENNA_VECTOR_POTENTIAL_MAX_H1_DOFS` | `usize` | `1_000_000` | $1$ | positive bound checked on mesh/space | maximum OE-F2 $H^1$ gauge DOFs | FEM CPU sparse lane | `antenna.vector_potential.max_h1_dofs` |

(round-trip-and-failure-semantics)=
### 4.2 Round-trip and failure semantics

Canonical export and IR round-trips preserve all authored transport and Oersted
fields identically. **Requested intent** is kept strictly separate from
**resolved execution**: runtime diagnostics append the realized solver label
(`resolved_charge_solver`, `resolved_spin_solver`, `resolved_linear_solver`,
`resolved_execution_policy`) inside `diagnostics_json` without changing ABI
struct layouts or error codes, and an explicit GPU request never degrades
silently to CPU. **Validation errors** include non-finalized or non-square CSR
matrices, non-finite inputs, invalid `ChargeTraceWorkspace` potential anchors,
explicit OE-F2 DOF cap violations, non-converged residuals above tolerance, and
`CUDSS_DATA_INFO != 0`. **Unsupported combinations** include explicit
`GpuCudss` or `GpuHybridFarField` requests on builds without CUDA/cuDSS,
`GPU_DOUBLE` requests on C ABI v1/v2/v3 (`FULLMAG_FEM_ERR_UNAVAILABLE`), VRAM
budget preflight exhaustion, and distributed multi-rank PETSc initialization
without collective setup.

(discrete-realization)=
## 5. Numerical realization across backends

### 5.1 FDM

FDM is unaffected by this note; FDM transport and Oersted operators remain
governed by their existing cell-integrated and FFT convolution contracts.

### 5.2 FEM CPU

`SparseLinearSolver` implements a deterministic 3-tier CPU hierarchy:

- **Tier 1 (PETSc + MUMPS + METIS):** active when `FULLMAG_FEM_WITH_SLEPC=1`
  and MPI is enabled and safe (`world_size == 1 || petsc_initialized`). Uses
  `PCCHOLESKY` (with fallback to `PCLU`) for SPD and `PCLU` + `ICNTL(7)=5` +
  `ICNTL(14)=50` for indefinite/nonsymmetric matrices, under
  `petsc_slepc_process_mutex()` with live-graph registration and up to
  `max_refinement_sweeps` `long double` refinement steps.
- **Tier 2 (HYPRE CPU on `MPI_COMM_SELF`):** active when `FULLMAG_FEM_WITH_SLEPC=0`,
  or when `SparseCpuBackendPolicy::Hypre` is explicitly selected. Uses cached
  `HypreBoomerAMG` + `HyprePCG` for SPD, `byNODES` Block-Diagonal `HypreBoomerAMG`
  + GMRES with deterministic `HypreILU(1)` escalation for nonsymmetric M1/M2,
  `HypreAMS` + `HypreBoomerAMG` `MINRES` for OE-F2, and degree-64-guarded
  Schur-AMG `MINRES` for OE-T0 KKT.
- **Tier 3 (MFEM serial):** TSan-safe (`FULLMAG_OET0_DISABLE_MPI=1`) and
  `OMP_NUM_THREADS`-independent deterministic fallback (also pinned for rank-0
  SPD charge/lead solves under `reference_mpi_gather_*_broadcast`) with per-call
  stack-allocated `CGSolver`/`GMRESSolver`/`MINRESSolver` + `GSSmoother` /
  zero-diagonal-safe `SafeAbsDiagPreconditioner`.

OE-F1 (`DirectTetraQuadrature`) pre-extracts flat `QuadratureRuleTable` arrays
once on the main thread and executes 2-level `std::thread` parallelism
(target-level for $N_t \ge 2W$, root-source-level for $N_t < 2W, N_s \ge 128$)
with 0-ULP bit-exact deterministic reduction and 3× single-pass fused
`ProjectField`.

### 5.3 FEM GPU and hybrid

Two opt-in C++ GPU paths are implemented behind strict compile-time and runtime
gates (never selected implicitly by CPU defaults or C ABI v1/v2/v3):

1. `SparseExecutionTarget::GpuCudss`: NVIDIA cuDSS 0.8+ direct SPD Cholesky,
   symmetric indefinite saddle-point LU (full CSR, zero-diagonal-safe), and
   general LU with scalar CSR/RHS normalization, `CUDSS_PIVOT_EPSILON_ALG_SCALED`,
   device iterative refinement (`CUDSS_CONFIG_IR_N_STEPS = 5`),
   `CUDSS_DATA_MEMORY_ESTIMATES` VRAM preflight, `CUDSS_DATA_INFO != 0` and
   `CUDSS_DATA_NPIVOTS` deterministic singular-probe fail-closed checks, and
   host extended-precision verification/refinement.
2. `DirectTetraExecutionPolicy::GpuHybridFarField`: tiled CUDA far-field
   Biot--Savart kernel with 106-bit `DoubleDouble` accumulation in ascending
   source order and sorted CSR handoff of near/singular/unconverged pairs
   ($d_c \le 3 R_s$) to CPU `long double` Duffy subdivision.

(implementation-mapping)=
## 6. Implementation mapping

| Claim | Source path | Symbol |
|---|---|---|
| Shared 3-tier CPU + opt-in cuDSS sparse linear solver class | `backends/fem/cpu/mfem/common/sparse_linear_solver.hpp` | `class SparseLinearSolver` |
| Symmetric nanometer-scale saddle-point equilibration scalar $\beta$ | `backends/fem/cpu/mfem/common/sparse_linear_solver.cpp` | `compute_saddle_point_equilibration_beta` |
| $O(\mathrm{nnz})$ CSR equilibrated saddle-point assembly | `backends/fem/cpu/mfem/common/sparse_linear_solver.cpp` | `assemble_equilibrated_saddle_point_csr` |
| Extended-precision unpreconditioned relative residual check | `backends/fem/cpu/mfem/common/sparse_linear_solver.cpp` | `sparse_independent_relative_residual` |
| Shared sparse solver contract tests (5 profiles + thread safety + cuDSS) | `backends/fem/tests/sparse_linear_solver_contract.cpp` | `main` |
| Opt-in CUDA 106-bit `DoubleDouble` far-field Biot--Savart entry point | `backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu` | `fullmag_cuda_direct_tetra_evaluate_root_farfield` |
| Raised OE-F2 Nédélec DOF cap in Rust IR | `crates/fullmag-ir/src/antenna.rs` | `ANTENNA_VECTOR_POTENTIAL_MAX_ND_DOFS` |
| Raised OE-F2 $H^1$ gauge DOF cap in Rust IR | `crates/fullmag-ir/src/antenna.rs` | `ANTENNA_VECTOR_POTENTIAL_MAX_H1_DOFS` |

(validation)=
## 7. Validation and qualification

Managed 5-profile Docker DEV qualification and A/B benchmarks (`origin/master`
`9ab99132d5` vs candidate `7801f23f25`, RTX 4080 SUPER SM `89-real`, AMD
Threadripper 3960X, MFEM 4.10, HYPRE 3.1.0, PETSc/MUMPS/METIS, cuDSS 0.8.0.10)
completed on 2026-11-26 (full tables in
`docs/audits/2026-11-26-fem-multiphysics-solvers-ab.md`):

- **Profile 1 (non-MFEM CI `native-modal-cabi-contract`):** 8/8 PASS (`0.05 s`).
- **Profile 2 (FEM CPU `SLEPC=OFF`, Tier-2 HYPRE, `OMP_NUM_THREADS=4`):**
  13/13 Wave 2 CTests PASS + 2-rank MPI `n=1` vs `n=2` bit-exact PASS +
  `FULLMAG_OET0_LARGE_MESH=1` 3/3 bit-exact PASS (`6.67 s`).
- **Profile 3 (OE-T0 TSan, `FULLMAG_OET0_TSAN=ON`, `FULLMAG_OET0_DISABLE_MPI=1`):**
  clean `-fsanitize=thread` build/link PASS (runtime execution uses dedicated
  `fem-cpu-tsan` seccomp service).
- **Profile 4 (2-rank MPI byte identity):** `oet0-mpi-n1.bin == oet0-mpi-n2.bin`
  bit-exact PASS on both Profile 2 (`SLEPC=OFF`) and Profile 5 (`SLEPC=ON`)
  under `OMP_NUM_THREADS=4`.
- **Profile 5 (FEM GPU + SLEPc + cuDSS + MPI, `OMP_NUM_THREADS=4`):**
  13/13 Wave 2 CTests PASS (`46.35 s`) + 4/4 `CUDA_VISIBLE_DEVICES=""`
  fail-closed/host-policy tests PASS (`10.68 s`) + `FULLMAG_OET0_LARGE_MESH=1`
  3/3 bit-exact PASS (`5.58 s`).
- **Rust, Python, and static gates:** `fullmag-fem-sys` 53/53, `fullmag-ir`
  289/289, `fullmag-plan` 688/688, `fullmag-runner` default (`antenna` 150/150,
  `oersted` 7/7, `transport` 106/106) and `--features fem-gpu` (`antenna`
  179/179, `oersted` 28/28), 196/196 `pytest` (+23 subtests), 32/32 `unittest`,
  `scripts/check_repo_consistency.py`, and
  `validate_changed_scientific_docs.py --base origin/master --head HEAD` PASS.

Measured A/B highlights (`9ab99132d5` vs `7801f23f25`):

- **OE-F2 (`VectorPotentialSolver`):** `105.5x` speedup on `6x6x6` (`3273.23 ms -> 31.02 ms`
  Tier-1 MUMPS, `err_A = 5.21e-15`; `47.91 ms` / `68.3x` Tier-2 HYPRE AMS,
  `err_A = 1.08e-13`); unlocks `16x16x16` (`31,024` ND DOFs in `1.32 s` T1 /
  `1.98 s` T2) and `20x20x20` (`59,660` ND + `9,261` H1 DOFs in `3.52 s` T1 /
  `3.62 s` T2 at `362 MiB` RSS vs ~`38 GiB` dense).
- **OE-F1 (`DirectTetraQuadrature`):** `13.53x` on `8x8x8` (`3.15M` pairs,
  `15.32 s -> 1.13 s`, `W=16`, 0-ULP `memcmp == 0`), `18.93x` under opt-in
  `GpuHybridFarField` (`0.81 s`, `max_rel_err = 5.59e-17` vs CPU `long double`),
  and `3.00x` fewer kernels / `11.60x` faster fused `ProjectField` (with fixed
  `byVDIM` scatter).
- **Transport M1/M2 and OE-T0 KKT:** `8.02x` (T1) / `7.69x` (T2) / `5.82x`
  (`cuda_cudss_spd`) on 8-terminal `16x16x8` charge; `11.60x` per column in
  `ChargeTraceWorkspace`; `5.50x` (`cuda_cudss_lu`, `0.94 s`, `res <= 1.46e-15`)
  and `5.32x` (T1 MUMPS, `0.97 s`) on stiff `12x12x12` M2 ($\lambda_J = 0.015 L$,
  100x contrast, AHE) where baseline unpreconditioned `GMRES(100)` failed to
  converge (`5.14 s`, `conv=0`); `6.87 s -> 5.64 s` (`1.22x` E2E) on
  `FULLMAG_OET0_LARGE_MESH=1` (`21,600` faces, bit-exact 3/3).

(limitations)=
## 8. Limitations and deferred work

- Promoting `SparseExecutionTarget::GpuCudss` or `DirectTetraExecutionPolicy::GpuHybridFarField`
  into public C ABI v4+, Rust planner capability flags, or Python authoring
  enums is deferred to a separate ABI/planner PR after Phase 2b GPU
  qualification completes.
- Distributed multi-rank MPI factorization (beyond single-rank `MPI_COMM_SELF`
  gather/broadcast) remains deferred.
- `surface_rt0.{hpp,cpp}` exact GMP/MPFR160 analytical reference remains
  intentionally single-threaded and unchanged.

(scientific-bibliography)=
## 9. Scientific bibliography

1. P. R. Amestoy, I. S. Duff, J.-Y. L'Excellent, and J. Koster,
   [A fully asynchronous multifrontal solver using distributed dynamic scheduling](https://doi.org/10.1137/S0895479899358194),
   *SIAM J. Matrix Anal. Appl.* 23(1) (2001), 15--41 (MUMPS sparse direct solver).
2. T. V. Kolev and P. S. Vassilevski,
   [Parallel auxiliary space AMG for $H(\mathrm{curl})$ problems](https://doi.org/10.1515/JNUM.2009.013),
   *J. Numer. Math.* 17(4) (2009), 245--268 (HYPRE AMS preconditioner).
3. M. Benzi, G. H. Golub, and J. Liesen,
   [Numerical solution of saddle point problems](https://doi.org/10.1017/S0962492904000212),
   *Acta Numerica* 14 (2005), 1--137 (equilibration and Schur-complement preconditioning).
4. T. J. Dekker,
   [A floating-point technique for extending the available precision](https://doi.org/10.1007/BF01397083),
   *Numerische Mathematik* 18 (1971), 224--242 (`TwoSum`/`TwoProd` double-double arithmetic).
5. MFEM, [Finite Element Discretization Library](https://mfem.org/), v4.10
   sparse linear algebra and HYPRE/PETSc interfaces.

(source-code-index)=
## 10. Source-code index

| Path | Symbol | Responsibility |
|---|---|---|
| `backends/fem/cpu/mfem/common/sparse_linear_solver.hpp` | `class SparseLinearSolver` | Public API for reusable 3-tier CPU and opt-in cuDSS sparse linear solver |
| `backends/fem/cpu/mfem/common/sparse_linear_solver.cpp` | `compute_saddle_point_equilibration_beta` | Computes symmetric equilibration scalar $\beta$ for nanometer-scale saddle-point blocks |
| `backends/fem/cpu/mfem/common/sparse_linear_solver.cpp` | `assemble_equilibrated_saddle_point_csr` | Assembles $O(\mathrm{nnz})$ equilibrated CSR saddle-point matrix without dense allocation |
| `backends/fem/cpu/mfem/common/sparse_linear_solver.cpp` | `sparse_independent_relative_residual` | Computes extended-precision unpreconditioned CSR residual |
| `backends/fem/tests/sparse_linear_solver_contract.cpp` | `main` | Contract suite for multi-RHS SPD, nanometer saddle-point, nonsymmetric `byNODES`, thread safety, and cuDSS fail-closed semantics |
| `backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu` | `fullmag_cuda_direct_tetra_evaluate_root_farfield` | Opt-in 106-bit `DoubleDouble` CUDA far-field Biot--Savart evaluator with sorted CSR near-pair handoff |
| `crates/fullmag-ir/src/antenna.rs` | `ANTENNA_VECTOR_POTENTIAL_MAX_ND_DOFS` | Raised OE-F2 Nédélec DOF cap (`2_000_000`) matching sparse C++ solver |
| `crates/fullmag-ir/src/antenna.rs` | `ANTENNA_VECTOR_POTENTIAL_MAX_H1_DOFS` | Raised OE-F2 $H^1$ gauge DOF cap (`1_000_000`) matching sparse C++ solver |
