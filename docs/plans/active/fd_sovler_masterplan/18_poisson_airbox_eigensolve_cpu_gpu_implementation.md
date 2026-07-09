---
title: Poisson-airbox k=0 eigensolve CPU/GPU implementation ULTRAPLAN
version: COMSOL-aligned v5.3 PA-E ULTRAPLAN
canonical_path: docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md
status: production_implementation_contract_for_PA_E1_and_staged_contract_for_PA_E2_PA_E3_PA_E4_GPU
created_from: v5 full-read canonical masterplan, Kittel D2, GPU readiness audit, PA-E decision document, and Micromagnetics Module User's Guide V2.13
last_updated: 2026-07-09
supersedes:
  - docs/plans/active/fd_sovler_masterplan/18_posion_+airbox_eigesolve_cpu_gpu_implementation.md
  - docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md drafts before v5.3
  - poisson_airbox_eigensolve_cpu_gpu_doc_v2/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md
scope:
  - modal_eigen
  - k0
  - dynamic_demag
  - poisson_airbox
  - dense_oracle
  - cpu_sparse_slepc
  - schur_matshell
  - gpu_parity
  - kittel_demag_validation
related_docs:
  - docs/plans/active/fd_sovler_masterplan/00_README_CANONICAL_FULL_READ.md
  - docs/plans/active/fd_sovler_masterplan/02_physics_contract.md
  - docs/plans/active/fd_sovler_masterplan/03_relaxed_texture_linearization.md
  - docs/plans/active/fd_sovler_masterplan/04_mesh_periodic_floquet_airbox.md
  - docs/plans/active/fd_sovler_masterplan/05_algebra_and_operator_representations.md
  - docs/plans/active/fd_sovler_masterplan/06_solver_tree_planner_and_lanes.md
  - docs/plans/active/fd_sovler_masterplan/07_api_abi_artifacts.md
  - docs/plans/active/fd_sovler_masterplan/08_backend_algorithms_and_status.md
  - docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md
  - docs/plans/active/fd_sovler_masterplan/10_patch_queue_current_status.md
  - docs/plans/active/fd_sovler_masterplan/11_runtime_telemetry_performance.md
  - docs/plans/active/fd_sovler_masterplan/12_adr_decisions.md
  - docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md
  - docs/plans/active/fd_sovler_masterplan/16_implementation_plan_Kittel_D2.md
  - docs/plans/active/fd_sovler_masterplan/17_eigen_k0_gpu_readiness_audit.md
---

# Poisson-airbox `k=0` eigensolve CPU/GPU implementation — ULTRAPLAN

## 0. Executive summary

This document is the implementation contract for the Poisson-airbox `k=0` modal/eigen path. It is deliberately stricter than the previous draft. Its purpose is to let an implementation agent start from this file and produce the first correct patch without needing to infer hidden conventions.

The current mandatory next patch is:

```text
PA-E1 — dense full-coupled algebraic Poisson-airbox eigen oracle
```

Implementation status note from 2026-07-08: PA-E1 algebra, the PA-E2 public
CSR block ABI seam, and the first PA-E4b runner payload seam have progressed
past the original "next patch" wording above. The runner now builds a structured
K0-3 `periodic_airbox_k0` validation payload with CSR `A_qq`, `A_qphi`,
`A_phiq`, `A_phiphi`, and `B_qq` blocks from mesh periodic pair evidence.
`A_phiphi` is weighted by airbox periodic-pair length, `B_qq` is weighted by
lumped magnetic element volume, and `A_qphi/A_phiq` now use a mesh-derived
coupling scale from magnetic pair mass divided by airbox pair length instead
of constant demag/Poisson source entries. The mean-zero gauge vector
`phi_mean_weights` is also geometry-derived: each airbox periodic pair
contributes weight proportional to its pair length, split over its two phi
DOFs and normalized to one. This is still a wired validation payload and
ABI/runtime seam, not the final shared-domain MFEM weak-form Poisson-airbox
assembler and not GPU parity.

Native validation status note from 2026-07-08: PA-E1 dense oracle and PA-E2
CPU SLEPc now explicitly reject invalid mean-zero gauge weights before solving.
Gauge weights must be finite, strictly positive, and normalized to sum to one;
violations report `poisson_airbox_eigen_requires_mean_zero_gauge` with a
`positive normalized` diagnostic. PA-E3 Schur MatShell fixtures now also carry
the same `periodic_mesh_certificate.v5` pair-count metadata required by PA-E2.
PA-E3 Schur certification now also rejects missing, nonpositive, nonfinite, or
non-normalized `phi_mean_weights` before constructing the certificate key, with
`poisson_airbox_schur_requires_mean_zero_gauge` and a `positive normalized`
diagnostic.

PA-E1 must not change public ABI, Rust IR, Python DSL, UI/OpenAPI, or GPU runtime. It must prove the algebra first:

```text
full-coupled descriptor pencil
mean-zero augmented Poisson gauge
Schur elimination
full residual reconstruction
positive-frequency eigenvalue convention
sign-flip negative tests
artifact schema for oracle diagnostics
```

Only after PA-E1 is green may the project move to:

```text
PA-E2 — CPU sparse/full-coupled SLEPc monolithic SeqAIJ
PA-E3 — CPU Schur MatShell / explicit certified Schur path
PA-E4 — Kittel K0-3 thin-film demag gate
PA-G1..G5 — GPU parity-first path, then true device modal eigensolver
```

The physics source of truth is the COMSOL-aligned v5 contract:

```text
m(r,t) = m0(r) + Re(delta_m(r) exp(+i omega t))
delta_m in C^3
m0 · delta_m = 0
internal tangent representation: delta_m_i = T_i q_i, q_i in C^2
```

The Poisson-airbox eigen source of truth is the full coupled block problem:

```text
[ A_qq      A_qphi   ] [q  ] = lambda [ B_qq 0 ] [q  ]
[ A_phiq    A_phiphi ] [phi]          [ 0    0 ] [phi]
```

with gauge augmentation for `phi`. Schur is derived from this problem, not the primary definition.

---

## 1. Non-negotiable repository governance

### 1.1. Canonical file path

The only active file path is:

```text
docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md
```

The typo path must not exist in active docs:

```text
docs/plans/active/fd_sovler_masterplan/18_posion_+airbox_eigesolve_cpu_gpu_implementation.md
```

Required patch command:

```bash
git mv \
  docs/plans/active/fd_sovler_masterplan/18_posion_+airbox_eigesolve_cpu_gpu_implementation.md \
  docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md
```

If the canonical file already exists, remove the typo file and verify there is only one active plan:

```bash
find docs/plans/active/fd_sovler_masterplan -maxdepth 1 -name '18_*poisson*airbox*eigen*.md' -print
find docs/plans/active/fd_sovler_masterplan -maxdepth 1 -name '18_*posion*' -print
```

Expected:

```text
one canonical poisson file
zero typo posion files
```

### 1.2. Physics docs pointers

Add short pointers, not duplicated content, to:

```text
docs/physics/0600-fem-eigenmodes-linearized-llg.md
docs/physics/0700-frequency-domain-linearized-llg.md
```

Required text:

```markdown
## Poisson-airbox `k=0` modal eigensolve implementation

The active implementation contract for full-coupled Poisson-airbox `k=0` modal eigensolve is:

`docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`

That document is normative for PA-E1 dense full-coupled algebraic oracle and staged for CPU sparse/SLEPc, Schur MatShell, Kittel demag validation, and GPU parity/runtime.
```

Acceptance:

```bash
rg -n "18_poisson_airbox_eigensolve_cpu_gpu_implementation" docs/physics docs/plans/active/fd_sovler_masterplan
```

### 1.3. Just gate naming

After PA-E1 implementation, add:

```text
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
```

This gate is not required before implementation. It is required before claiming PA-E1 complete.

---

## 2. Current repository facts and implementation constraints

### 2.1. Existing modal/eigen infrastructure

Relevant integration points:

```text
backends/fem/include/frequency_domain/modal_eigen_request.hpp
backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp
backends/fem/cpu/frequency_domain/slepc_modal_eigen.hpp
backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp
backends/fem/include/frequency_domain/dense_full_coupled_oracle.hpp
backends/fem/include/frequency_domain/dense_poisson_airbox_eigen_oracle.hpp       # new preferred
backends/fem/cpu/frequency_domain/dense_poisson_airbox_eigen_oracle.cpp          # new preferred
backends/fem/tests/frequency_domain/poisson_airbox_eigen_oracle_test.cpp         # new preferred
```

Existing modal infrastructure already covers SLEPc-style eigenvalue reporting with:

```text
eigenvalue_real
eigenvalue_imag
omega_rad_s = eigenvalue_imag
frequency_hz = eigenvalue_imag / (2*pi)
positive branch = eigenvalue_imag > 0
```

PA-E1 must preserve this convention. It must not refactor all modal artifacts to a new eigenvalue token.

### 2.2. Existing Kittel gate status

The no-demag K0-1 Kittel field sweep is already a strong proof for macrospin/Larmor scaling, branch selection, mass-weighted uniformity, and artifact verification. The demag K0-3 gate is not complete and must not be claimed until the Poisson-airbox eigensolve path is implemented and verified.

### 2.3. Current GPU status

Current production GPU terminology is intentionally transitional:

```text
gpu_operator_host_krylov: host Krylov with GPU-backed operators/preconditioners
gpu_device_krylov: true device-resident solver state and Krylov basis
```

For modal/eigen Poisson-airbox, GPU is not a PA-E1 implementation target. GPU work starts only after CPU/dense algebra and CPU sparse/SLEPc are correct.

---

## 3. Physical model for Poisson-airbox `k=0` modal eigensolve

### 3.1. Canonical frequency-domain LLG

Use the phasor convention:

```text
m(r,t) = m0(r) + delta_m(r) exp(+i omega t)
```

The linearized equation is:

```text
i omega delta_m
  = - gamma m0 x delta_h_eff
    - gamma delta_m x h_eff0
    + i omega alpha m0 x delta_m
    + linearized source/operator terms
```

For the first Poisson-airbox eigen gates:

```text
alpha = 0
external dynamic drive = absent
STT = disabled
DMI = disabled
EASA = disabled
anisotropy = disabled unless explicitly testing K0-2
uniform Ms
uniform m0 for first Kittel/demag gates
k = 0
```

### 3.2. Tangent representation

For each magnetic node:

```text
T_i = [e1_i, e2_i] in R^(3x2)
delta_m_i = T_i q_i
q_i in C^2
```

The public mode output must still be Cartesian:

```text
dmX_real, dmX_imag
dmY_real, dmY_imag
dmZ_real, dmZ_imag
m0_dot_delta_m_real/im
```

The tangent `q` is internal and belongs in provenance/debug artifacts.

### 3.3. Dynamic demag through scalar potential

Dynamic demag is represented by a scalar potential `delta_phi`:

```text
delta_H_demag = -grad(delta_phi)
```

For v1 PA-E1/PA-E2, use this weak form as the canonical sign convention:

```text
Find delta_phi such that, for all scalar test functions psi:

∫_Omega_air grad(psi) · grad(delta_phi) dV
  = ∫_Omega_mag grad(psi) · (Ms delta_m) dV
```

In block form, with `delta_m = T q`:

```text
P phi = C q
```

where:

```text
P_ij = ∫_Omega_air grad(psi_i) · grad(psi_j) dV
C_ik = ∫_Omega_mag grad(psi_i) · (Ms T_k) dV
```

The full Poisson row is written as:

```text
P phi - C q = 0
```

so the canonical block signs for the full coupled pencil are:

```text
A_phiphi = P
A_phiq   = -C
```

The feedback from potential to magnetic equation is:

```text
delta_H_demag = -G phi
magnetic contribution = -gamma m0 x delta_H_demag
                      = +gamma m0 x (G phi)
```

After tangent projection:

```text
A_qphi phi = T^T [ + gamma m0 x (G phi) ]
```

The exact row/column sign must be pinned by PA-E1 sign-flip tests. Any future FEM assembly must match the PA-E1 sign convention.

### 3.4. Scalar domain, provenance, and gauge / nullspace

The scalar-potential perturbation lives on the full shared domain

```text
D = Omega_m union Omega_air
```

and the current PA-E1/PA-E4b payload provenance must stay explicit:

```text
assembly_kind = synthetic_algebraic_oracle
production_periodic_airbox_claim = false
```

The first real FEM production candidate changes `assembly_kind` to
`mfem_weak_form_shared_domain` only after the shared-domain weak form, accepted
equilibrium provenance, and validation matrix are green.

Gauge policy depends on the outer boundary condition:

```text
outer_boundary_kind = poisson_robin | poisson_dirichlet | pure_neumann
gauge_policy = none | mean_zero_augmented
gauge_reason = coercive_outer_boundary | pure_neumann_nullspace
```

Robin with positive `beta` and Dirichlet have no scalar-potential nullspace and
therefore use:

```text
gauge_policy = none
```

Only pure Neumann uses the augmented mean-zero system:

```text
[ P  c ][phi] = [rhs]
[ cT 0 ][eta]   [0  ]
```

The tuple is closed and validated before SLEPc setup:

```text
poisson_robin | poisson_dirichlet
  -> gauge_policy = none
  -> gauge_reason = coercive_outer_boundary

pure_neumann
  -> gauge_policy = mean_zero_augmented
  -> gauge_reason = pure_neumann_nullspace
```

Until the real shared-domain weak-form assembler lands, PA-E2 accepts only
`assembly_kind=synthetic_algebraic_oracle`. A request claiming
`mfem_weak_form_shared_domain` must be rejected rather than recorded as
production provenance without the corresponding assembly.

where `c` contains quadrature/lumped weights representing the mean functional.

Debug-only policy:

```text
pin_first_dof
```

`pin_first_dof` must not be used for production oracle gates because it is ordering-dependent.

### 3.5. Descriptor eigen-pencil

The full coupled descriptor pencil is:

```text
A_full x = lambda B_full x
x = [q; phi; eta]
```

with:

```text
A_full =
[ A_qq      A_qphi      0 ]
[ A_phiq    A_phiphi    c ]
[ 0         cT          0 ]

B_full =
[ B_qq      0           0 ]
[ 0         0           0 ]
[ 0         0           0 ]
```

`B_full` is singular by design because Poisson/gauge rows are algebraic constraints. For PA-E1, do not solve this full descriptor eigenproblem directly unless the chosen dense solver supports singular descriptor pencils. Instead:

1. Eliminate `phi` through the gauge-augmented Poisson solve.
2. Build or apply the Schur-reduced magnetic pencil.
3. Solve the magnetic generalized eigenproblem.
4. Reconstruct `[q, phi, eta]` and verify the full descriptor residual.

### 3.6. Schur-eliminated magnetic pencil

For a magnetic vector `q`:

```text
phi(q), eta(q) = solve([P c; cT 0], [C q; 0])
```

Then:

```text
S q = A_qq q + A_qphi phi(q)
```

Because `A_phiq = -C`, this is equivalent to:

```text
S = A_qq - A_qphi P_gauge^{-1} A_phiq
```

with the sign convention above. PA-E1 must implement both expressions and prove they agree.

The eigenproblem is:

```text
S q = lambda B_qq q
```

Positive-frequency mode selection follows current modal artifact convention:

```text
omega_rad_s  = imag(lambda)
frequency_hz = imag(lambda) / (2*pi)
accept only imag(lambda) > 0 for the primary positive branch
```

---

## 4. Explicit decisions for the 28 implementation questions

This section is normative. If an implementation task conflicts with any earlier draft, this section wins.

| ID | Decision |
|---:|---|
| Q1 | This document is an implementation contract for PA-E1 and a staged plan for PA-E2+. |
| Q2 | PA-E1 uses synthetic dense matrices, not a real MFEM mesh. |
| Q3 | A purely algebraic oracle without MFEM is accepted and preferred for PA-E1. |
| Q4 | Keep current modal artifact convention: `frequency_hz = imag(lambda)/(2*pi)`. Do not refactor all modal artifacts. |
| Q5 | `A_qq` is the magnetic operator without dynamic demag. PA-E1 may use minimal stiffness/gyrotropic toy blocks. |
| Q6 | `alpha=0` is mandatory for PA-E1, PA-E2, and PA-E4 gates. Damping is later work. |
| Q7 | v1 default uses real-split / real PETSc-compatible algebra. Complex PETSc is optional later. |
| Q8 | PA-E2 default sparse path is monolithic `SeqAIJ`, not `MatNest`. |
| Q9 | Production gauge default is `mean_zero_augmented`, not `MatNullSpace`, for the first dense/sparse direct path. |
| Q10 | `pin_first_dof` remains debug-only. |
| Q11 | Real `periodic_airbox_k0` requires magnetic and airbox pair maps. Synthetic PA-E1 may use a synthetic/no-mesh certificate. |
| Q12 | PA-E1 may use synthetic/no-mesh certificate. PA-E2/PA-E4 FEM must consume real `periodic_mesh_certificate.v5`. |
| Q13 | Add internal backend-only `PoissonAirboxEigenBlockProblem`. Do not extend public `ModalEigenRequest` in PA-E1. |
| Q14 | No ABI bump in PA-E1. ABI bump only when public C ABI layout changes. |
| Q15 | Keep public lane as `production_cpu` initially; emit detailed `solver_adapter` / `solver_model` in JSON. |
| Q16 | No Python DSL `demag_kind="periodic_airbox_k0"` knob in PA-E1. Add later after PA-E2/PA-E4 evidence. |
| Q17 | Use existing `validation/kittel_k0_pbc/` directory for K0-3; distinguish by `case_id` and `demag_kind`. |
| Q18 | K0-3 initial expected formula may use `sqrt(H0(H0+Ms))` only for ideal in-plane thin film; artifacts must also support `M_eff` from numeric demag/convergence. |
| Q19 | First PA-E1 gate is synthetic algebraic. First PA-E4 CI gate should be macrospin/dense demag-factor, then small FEM film, then full shared-domain airbox. |
| Q20 | `2e-2` is acceptable only as an initial FEM-airbox smoke threshold. A convergence table must set final production thresholds. |
| Q21 | PA-E2 should create `poisson_airbox_modal_eigen.cpp`; `production_cpu_modal_eigen.cpp` remains a thin dispatcher. |
| Q22 | Schur MatShell is explicit/certified first, not auto-selected by default. |
| Q23 | GPU-G1 should use a frequency-domain operator provider API, even if it reuses lower-level time-domain Poisson kernels internally. |
| Q24 | Strict periodic GPU demag remains gated. No silent fallback. |
| Q25 | `gpu_operator_host_modal` compatibility is hidden developer/CI lane, not user-facing production UI until parity gates pass. |
| Q26 | Non-k0/Floquet with dynamic demag must fail in planner if enough metadata exists; otherwise native must fail with exact unsupported reason. |
| Q27 | PA-E1 requires minimal native contract test and oracle JSON. Full artifact verifier may come in PA-E2/PA-E4, but JSON schema starts in PA-E1. |
| Q28 | First implementation scope is limited to `k=0`, P1/dense synthetic, double, `alpha=0`, uniform `Ms`, uniform `m0`, no DMI/aniso/STT/EASA. |

---

## 5. PA-E1 implementation contract

### 5.1. Files to add

Add:

```text
backends/fem/include/frequency_domain/dense_poisson_airbox_eigen_oracle.hpp
backends/fem/cpu/frequency_domain/dense_poisson_airbox_eigen_oracle.cpp
backends/fem/tests/frequency_domain/poisson_airbox_eigen_oracle_test.cpp
```

Optionally add if your test layout prefers separate helpers:

```text
backends/fem/cpu/frequency_domain/dense_complex_linalg.hpp
backends/fem/cpu/frequency_domain/dense_complex_linalg.cpp
```

Do not change:

```text
ModalEigenRequest public layout
Rust FFI structs
Python DSL
OpenAPI/UI
GPU runtime
```

### 5.2. CMake / build integration

Add the new `.cpp` to the same native test/static library target that already builds dense frequency-domain oracle tests.

Typical CMake fragment:

```cmake
target_sources(fullmag_fem_frequency_domain PRIVATE
  cpu/frequency_domain/dense_poisson_airbox_eigen_oracle.cpp
)

target_sources(frequency_domain_contract_tests PRIVATE
  tests/frequency_domain/poisson_airbox_eigen_oracle_test.cpp
)
```

If the repo uses manually enumerated source lists, keep the patch minimal and alphabetical if possible.

### 5.3. Just gate

Add after tests exist:

```make
verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle:
	just ensure-managed-fem-runtime
	docker compose --profile fem-gpu run --rm \
	  fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_poisson_airbox_eigen_oracle_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:$${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_poisson_airbox_eigen_oracle_contract'
```

Use the repository managed FEM runtime route for this gate. The target name is
mandatory.

---

## 6. PA-E1 API: internal-only dense oracle header

Use exact-ish names. Implementation may adapt namespace style, but semantic fields are mandatory.

```cpp
#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

constexpr std::uint32_t kDensePoissonAirboxEigenOracleAbiVersion = 1;

struct DenseComplexVectorView {
    const double* real = nullptr;
    const double* imag = nullptr; // nullable means zero imaginary input only where explicitly documented
    std::uint64_t count = 0;
};

struct DenseMutableComplexVectorView {
    double* real = nullptr;
    double* imag = nullptr;
    std::uint64_t count = 0;
};

struct DenseRealMatrixView {
    const double* values_row_major = nullptr;
    std::uint64_t row_count = 0;
    std::uint64_t column_count = 0;
};

struct DensePoissonAirboxEigenOracleProblem {
    std::uint32_t abi_version = kDensePoissonAirboxEigenOracleAbiVersion;
    std::uint64_t struct_size = sizeof(DensePoissonAirboxEigenOracleProblem);

    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;

    // Dense real row-major blocks for PA-E1. Complex blocks may be added later.
    DenseRealMatrixView A_qq{};       // q x q
    DenseRealMatrixView A_qphi{};     // q x phi
    DenseRealMatrixView A_phiq{};     // phi x q
    DenseRealMatrixView A_phiphi{};   // phi x phi
    DenseRealMatrixView B_qq{};       // q x q

    // Mean-zero gauge weights. Length = phi_dof_count.
    const double* phi_mean_weights = nullptr;
    std::uint64_t phi_mean_weights_count = 0;

    // Optional deterministic test vector for Schur apply/residual checks.
    DenseComplexVectorView test_q{};

    // Optional expected Kittel/demag sanity for synthetic 2x2 case.
    double expected_positive_frequency_hz = 0.0;
    double expected_frequency_relative_tolerance = 1.0e-10;

    double relative_tolerance = 1.0e-10;
    double absolute_tolerance = 1.0e-12;

    const char* gauge_policy = "mean_zero_augmented";
    const char* eigenvalue_convention = "lambda_imag_positive_frequency";
    const char* phasor_convention = "exp_plus_i_omega_t";
    const char* demag_kind = "synthetic_poisson_airbox_k0";
    const char* test_id = "pa_e1_dense_poisson_airbox_eigen_oracle";

    // Strict v1 scope flags.
    bool require_alpha_zero = true;
    bool require_k0 = true;
    bool synthetic_no_mesh = true;
};

struct DensePoissonAirboxEigenOracleResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::ok;
    char error_message[256]{};

    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    std::uint64_t augmented_phi_dof_count = 0;

    double schur_apply_relative_error = 0.0;
    double schur_explicit_symmetry_check = 0.0;
    double full_residual_reconstruction_relative_error = 0.0;
    double poisson_constraint_relative_residual = 0.0;
    double gauge_mean_abs = 0.0;
    double sign_flip_relative_error = 0.0;

    double eigenvalue_real = 0.0;
    double eigenvalue_imag = 0.0;
    double omega_rad_s = 0.0;
    double frequency_hz = 0.0;
    double eigen_residual_relative = 0.0;
    double expected_positive_frequency_hz = 0.0;
    double relative_frequency_error = 0.0;

    bool gauge_augmented = false;
    bool schur_certified = false;
    bool full_residual_certified = false;
    bool positive_frequency_branch_found = false;

    char diagnostics_json[8192]{};
};

FrequencyDomainStatus solve_dense_poisson_airbox_eigen_oracle(
    const DensePoissonAirboxEigenOracleProblem& problem,
    DensePoissonAirboxEigenOracleResult* out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
```

### 6.1. Header validation rules

The function must return `validation_error` if:

```text
out_result == nullptr
abi_version != 1
struct_size < required minimum
q_dof_count == 0
phi_dof_count == 0
any matrix has wrong shape
A_phiphi is missing
B_qq is missing
phi_mean_weights missing or wrong length
gauge_policy != mean_zero_augmented
phasor_convention != exp_plus_i_omega_t
eigenvalue_convention != lambda_imag_positive_frequency
```

Do not accept `pin_first_dof` in PA-E1 production oracle. It may be a separate debug helper, but not this gate.

---

## 7. Dense linalg fragments for PA-E1

### 7.1. Complex number and matrix utilities

Use `std::complex<double>` internally even if input matrices are real. This makes the eigen/residual code explicit.

```cpp
using Complex = std::complex<double>;

struct ComplexDenseMatrix {
    std::uint64_t rows = 0;
    std::uint64_t cols = 0;
    std::vector<Complex> a; // row-major

    Complex& operator()(std::uint64_t r, std::uint64_t c) noexcept {
        return a[static_cast<std::size_t>(r * cols + c)];
    }
    const Complex& operator()(std::uint64_t r, std::uint64_t c) const noexcept {
        return a[static_cast<std::size_t>(r * cols + c)];
    }
};

ComplexDenseMatrix make_complex_from_real(DenseRealMatrixView view) {
    ComplexDenseMatrix m{view.row_count, view.column_count, {}};
    m.a.resize(static_cast<std::size_t>(view.row_count * view.column_count));
    for (std::uint64_t i = 0; i < view.row_count * view.column_count; ++i) {
        m.a[static_cast<std::size_t>(i)] = Complex(view.values_row_major[i], 0.0);
    }
    return m;
}
```

### 7.2. Matrix multiply

```cpp
ComplexDenseMatrix matmul(const ComplexDenseMatrix& A, const ComplexDenseMatrix& B) {
    if (A.cols != B.rows) {
        return {};
    }
    ComplexDenseMatrix C{A.rows, B.cols, {}};
    C.a.assign(static_cast<std::size_t>(A.rows * B.cols), Complex{});
    for (std::uint64_t i = 0; i < A.rows; ++i) {
        for (std::uint64_t k = 0; k < A.cols; ++k) {
            const Complex aik = A(i, k);
            if (aik == Complex{}) continue;
            for (std::uint64_t j = 0; j < B.cols; ++j) {
                C(i, j) += aik * B(k, j);
            }
        }
    }
    return C;
}

std::vector<Complex> matvec(const ComplexDenseMatrix& A, const std::vector<Complex>& x) {
    std::vector<Complex> y(static_cast<std::size_t>(A.rows), Complex{});
    if (A.cols != x.size()) {
        return {};
    }
    for (std::uint64_t i = 0; i < A.rows; ++i) {
        Complex sum{};
        for (std::uint64_t j = 0; j < A.cols; ++j) {
            sum += A(i, j) * x[static_cast<std::size_t>(j)];
        }
        y[static_cast<std::size_t>(i)] = sum;
    }
    return y;
}
```

### 7.3. Gaussian solve with pivoting

```cpp
bool solve_dense_complex_linear_system(
    ComplexDenseMatrix A,
    std::vector<Complex> b,
    std::vector<Complex>& x,
    double singular_tolerance,
    char error_message[256]) noexcept
{
    const std::uint64_t n = A.rows;
    if (A.rows != A.cols || b.size() != n) {
        std::strncpy(error_message, "dense solve shape mismatch", 255);
        return false;
    }

    for (std::uint64_t k = 0; k < n; ++k) {
        std::uint64_t pivot = k;
        double pivot_abs = std::abs(A(k, k));
        for (std::uint64_t r = k + 1; r < n; ++r) {
            const double candidate = std::abs(A(r, k));
            if (candidate > pivot_abs) {
                pivot_abs = candidate;
                pivot = r;
            }
        }
        if (!(pivot_abs > singular_tolerance) || !std::isfinite(pivot_abs)) {
            std::strncpy(error_message, "dense solve singular matrix", 255);
            return false;
        }
        if (pivot != k) {
            for (std::uint64_t c = 0; c < n; ++c) {
                std::swap(A(k, c), A(pivot, c));
            }
            std::swap(b[static_cast<std::size_t>(k)], b[static_cast<std::size_t>(pivot)]);
        }
        const Complex diag = A(k, k);
        for (std::uint64_t c = k; c < n; ++c) A(k, c) /= diag;
        b[static_cast<std::size_t>(k)] /= diag;

        for (std::uint64_t r = 0; r < n; ++r) {
            if (r == k) continue;
            const Complex factor = A(r, k);
            if (std::abs(factor) == 0.0) continue;
            for (std::uint64_t c = k; c < n; ++c) {
                A(r, c) -= factor * A(k, c);
            }
            b[static_cast<std::size_t>(r)] -= factor * b[static_cast<std::size_t>(k)];
        }
    }
    x = std::move(b);
    return true;
}
```

### 7.4. Norms

```cpp
double complex_l2_norm(const std::vector<Complex>& x) noexcept {
    long double sum = 0.0L;
    for (const Complex& z : x) {
        sum += static_cast<long double>(std::norm(z));
    }
    return std::sqrt(static_cast<double>(sum));
}

double relative_error(const std::vector<Complex>& a, const std::vector<Complex>& b) noexcept {
    if (a.size() != b.size()) return std::numeric_limits<double>::infinity();
    std::vector<Complex> d(a.size());
    for (std::size_t i = 0; i < a.size(); ++i) d[i] = a[i] - b[i];
    const double denom = std::max(1.0e-300, complex_l2_norm(b));
    return complex_l2_norm(d) / denom;
}
```

---

## 8. Gauge augmentation implementation

### 8.1. Build augmented Poisson matrix

Given `P = A_phiphi` and weights `c`, create:

```text
P_aug = [P c; cT 0]
```

Code fragment:

```cpp
ComplexDenseMatrix build_mean_zero_augmented_poisson(
    const ComplexDenseMatrix& P,
    const double* weights,
    std::uint64_t weight_count)
{
    const std::uint64_t n = P.rows;
    ComplexDenseMatrix A{n + 1, n + 1, {}};
    A.a.assign(static_cast<std::size_t>((n + 1) * (n + 1)), Complex{});

    for (std::uint64_t r = 0; r < n; ++r) {
        for (std::uint64_t c = 0; c < n; ++c) {
            A(r, c) = P(r, c);
        }
    }
    for (std::uint64_t i = 0; i < n; ++i) {
        const Complex w(weights[i], 0.0);
        A(i, n) = w;
        A(n, i) = w;
    }
    A(n, n) = Complex{};
    return A;
}
```

### 8.2. Solve `phi(q)`

With canonical `A_phiq = -C`, the Poisson row is:

```text
A_phiq q + P phi + c eta = 0
```

So RHS for the augmented solve is:

```text
rhs_aug = [-A_phiq q; 0]
```

Code fragment:

```cpp
bool solve_phi_for_q(
    const ComplexDenseMatrix& P_aug,
    const ComplexDenseMatrix& A_phiq,
    const std::vector<Complex>& q,
    std::vector<Complex>& phi,
    Complex& eta,
    char error_message[256]) noexcept
{
    const std::uint64_t phi_n = A_phiq.rows;
    std::vector<Complex> rhs(static_cast<std::size_t>(phi_n + 1), Complex{});
    const std::vector<Complex> phiq = matvec(A_phiq, q);
    if (phiq.size() != phi_n) {
        std::strncpy(error_message, "A_phiq q shape mismatch", 255);
        return false;
    }
    for (std::uint64_t i = 0; i < phi_n; ++i) {
        rhs[static_cast<std::size_t>(i)] = -phiq[static_cast<std::size_t>(i)];
    }
    rhs[static_cast<std::size_t>(phi_n)] = Complex{};

    std::vector<Complex> solution;
    if (!solve_dense_complex_linear_system(P_aug, rhs, solution, 1.0e-14, error_message)) {
        return false;
    }
    phi.assign(solution.begin(), solution.begin() + static_cast<std::ptrdiff_t>(phi_n));
    eta = solution[static_cast<std::size_t>(phi_n)];
    return true;
}
```

### 8.3. Gauge check

```cpp
Complex weighted_mean(
    const std::vector<Complex>& phi,
    const double* weights)
{
    Complex value{};
    for (std::size_t i = 0; i < phi.size(); ++i) {
        value += weights[i] * phi[i];
    }
    return value;
}
```

Acceptance:

```text
abs(weighted_mean(phi)) <= 1e-12 initially
```

---

## 9. Schur construction and apply

### 9.1. Matrix-free Schur apply

```cpp
std::vector<Complex> apply_schur(
    const ComplexDenseMatrix& A_qq,
    const ComplexDenseMatrix& A_qphi,
    const ComplexDenseMatrix& P_aug,
    const ComplexDenseMatrix& A_phiq,
    const std::vector<Complex>& q,
    char error_message[256])
{
    std::vector<Complex> phi;
    Complex eta{};
    if (!solve_phi_for_q(P_aug, A_phiq, q, phi, eta, error_message)) {
        return {};
    }
    std::vector<Complex> y = matvec(A_qq, q);
    std::vector<Complex> feedback = matvec(A_qphi, phi);
    if (y.size() != feedback.size()) {
        std::strncpy(error_message, "A_qphi phi shape mismatch", 255);
        return {};
    }
    for (std::size_t i = 0; i < y.size(); ++i) {
        y[i] += feedback[i];
    }
    return y;
}
```

### 9.2. Explicit Schur build

Build Schur column-by-column using `apply_schur` on basis vectors. This avoids coding an explicit inverse and keeps gauge handling identical.

```cpp
ComplexDenseMatrix build_explicit_schur_by_columns(
    const ComplexDenseMatrix& A_qq,
    const ComplexDenseMatrix& A_qphi,
    const ComplexDenseMatrix& P_aug,
    const ComplexDenseMatrix& A_phiq,
    char error_message[256])
{
    const std::uint64_t n = A_qq.rows;
    ComplexDenseMatrix S{n, n, {}};
    S.a.assign(static_cast<std::size_t>(n * n), Complex{});
    for (std::uint64_t col = 0; col < n; ++col) {
        std::vector<Complex> e(static_cast<std::size_t>(n), Complex{});
        e[static_cast<std::size_t>(col)] = Complex(1.0, 0.0);
        std::vector<Complex> y = apply_schur(A_qq, A_qphi, P_aug, A_phiq, e, error_message);
        if (y.size() != n) {
            return {};
        }
        for (std::uint64_t row = 0; row < n; ++row) {
            S(row, col) = y[static_cast<std::size_t>(row)];
        }
    }
    return S;
}
```

### 9.3. Schur apply certification

Given a deterministic `q_test`:

```cpp
std::vector<Complex> y_apply = apply_schur(A_qq, A_qphi, P_aug, A_phiq, q_test, err);
ComplexDenseMatrix S = build_explicit_schur_by_columns(A_qq, A_qphi, P_aug, A_phiq, err);
std::vector<Complex> y_explicit = matvec(S, q_test);
result.schur_apply_relative_error = relative_error(y_apply, y_explicit);
result.schur_certified = result.schur_apply_relative_error <= problem.relative_tolerance;
```

Acceptance:

```text
<= 1e-10 for PA-E1
```

---

## 10. Full residual reconstruction

For a candidate eigenpair `(lambda, q)`, reconstruct `phi` and `eta` from `q`:

```text
A_phiq q + A_phiphi phi + c eta = 0
cT phi = 0
```

Then compute full descriptor residual:

```text
r_q   = A_qq q + A_qphi phi - lambda B_qq q
r_phi = A_phiq q + A_phiphi phi + c eta
r_eta = cT phi
```

Blockwise backward errors:

```text
eps_q = ||r_q|| /
  (||A_qq q|| + ||A_qphi phi|| + |lambda| ||B_qq q|| + floor)

eps_phi = ||r_phi|| /
  (||A_phiq q|| + ||A_phiphi phi|| + ||c eta|| + floor)

eps_gauge = |cT phi| / (||c|| ||phi|| + floor)

eps_full = max(eps_q, eps_phi, eps_gauge)
```

Required result and artifact fields:

```text
slepc_reported_backward_error
reconstructed_full_descriptor_backward_error = eps_full
reconstruction_vs_slepc_ratio
magnetic_block_backward_error = eps_q
poisson_block_backward_error = eps_phi
gauge_constraint_backward_error = eps_gauge
```

The SLEPc value is diagnostic only. It must never replace, cap, or be combined
with `eps_full` through `min(...)`. A conjugated candidate is valid only as the
pair `(conj(lambda), conj(x))`; the positive-frequency branch must not test
`conj(x)` against the unchanged positive `lambda`.

Acceptance:

```text
reconstructed_full_descriptor_backward_error <= tolerance
magnetic_block_backward_error <= tolerance
poisson_block_backward_error <= tolerance
gauge_constraint_backward_error <= tolerance
```

---

## 11. Dense 2x2 eigen solve for PA-E1

PA-E1 does not need a general dense generalized eigensolver for arbitrary `q_dof_count`. It needs enough to test the first toy pencil. Start with `q_dof_count = 2`.

General later path:

```text
q_dof_count > 2 -> use existing SLEPc dense helper or add a separate dense generalized solver
```

### 11.1. Solve `S q = lambda B q` for `2x2`

For `B = I`, solve ordinary eigenvalues of `S`:

```cpp
bool solve_2x2_standard_eigen(
    const ComplexDenseMatrix& S,
    Complex lambda[2],
    std::array<Complex,2> vec[2])
{
    if (S.rows != 2 || S.cols != 2) return false;
    const Complex a = S(0,0), b = S(0,1), c = S(1,0), d = S(1,1);
    const Complex tr = a + d;
    const Complex det = a*d - b*c;
    const Complex disc = std::sqrt(tr*tr - Complex(4.0,0.0)*det);
    lambda[0] = Complex(0.5,0.0)*(tr + disc);
    lambda[1] = Complex(0.5,0.0)*(tr - disc);

    for (int k = 0; k < 2; ++k) {
        const Complex l = lambda[k];
        // Solve (S-lI)v=0. Choose the more stable row.
        if (std::abs(b) + std::abs(a-l) > std::abs(d-l) + std::abs(c)) {
            vec[k] = { b, l - a };
        } else {
            vec[k] = { l - d, c };
        }
        const double n = std::sqrt(std::norm(vec[k][0]) + std::norm(vec[k][1]));
        if (!(n > 0.0) || !std::isfinite(n)) return false;
        vec[k][0] /= n;
        vec[k][1] /= n;
    }
    return true;
}
```

For non-identity `B`, PA-E1 may transform through a dense solve:

```text
B^{-1} S q = lambda q
```

only for tiny `2x2` and only if `B` is nonsingular. If `B` is the existing gyrotropic matrix and not identity, implement a tiny generalized solver or use current SLEPc tiny helper in PA-E1b.

### 11.2. Positive branch selection

```cpp
bool select_positive_frequency_branch(
    const Complex lambda[2],
    const std::array<Complex,2> vec[2],
    Complex& out_lambda,
    std::vector<Complex>& out_q)
{
    int best = -1;
    double best_imag = -std::numeric_limits<double>::infinity();
    for (int k = 0; k < 2; ++k) {
        const double im = std::imag(lambda[k]);
        if (im > 0.0 && im > best_imag) {
            best = k;
            best_imag = im;
        }
    }
    if (best < 0) return false;
    out_lambda = lambda[best];
    out_q = {vec[best][0], vec[best][1]};
    return true;
}
```

---

## 12. Synthetic matrices for required tests

### 12.1. PA-E1 Zeeman-like no-demag toy

Use:

```text
q_dof_count = 2
phi_dof_count = 1 or 2
A_qq = [ 0       -omega0 ]
       [ omega0   0      ]
B_qq = I
A_qphi = 0
A_phiq = 0
P = singular Laplacian-like block with mean-zero augmentation
```

Expected eigenvalues:

```text
lambda = ± i omega0
frequency_hz = omega0/(2*pi)
```

### 12.2. Demag-factor synthetic Kittel toy

To mimic in-plane thin-film Kittel without FEM:

```text
H1 = gamma0 * H0
H2 = gamma0 * (H0 + M_eff)
A_eff = [ 0       -gamma0 * H2 ]
        [ gamma0 * H1   0     ]
B = I
```

Expected:

```text
omega = gamma0 * sqrt(H0 * (H0 + M_eff))
```

Represent the `M_eff` correction through Schur:

```text
A_qq = [0, -gamma0*H0; gamma0*H0, 0]
A_qphi, A_phiq, P chosen so that A_qphi P^{-1} C modifies only the H2 branch.
```

The test must record that this is:

```text
demag_model = synthetic_demag_factor
```

not real `periodic_airbox_k0`.

### 12.3. Sign-flip negative test

Build a case where correct Schur gives expected frequency, then flip one coupling sign:

```text
A_qphi -> -A_qphi
```

Expected:

```text
relative_frequency_error > 1e-2
or full_residual_reconstruction_relative_error > 1e-6
```

The negative test must fail if both signs are accidentally flipped and hide the error. Therefore include at least one test where the direct expected Kittel frequency is checked.

---

## 13. PA-E1 test plan with RED/GREEN checklist

### 13.1. Test names

Use exact or very similar names:

```cpp
TEST(PoissonAirboxEigenOracle, RejectsMissingGaugeWeights)
TEST(PoissonAirboxEigenOracle, MeanZeroAugmentedGaugeSolvesSingularPoisson)
TEST(PoissonAirboxEigenOracle, SchurApplyMatchesExplicitSchur)
TEST(PoissonAirboxEigenOracle, FullResidualReconstructionMatchesReducedEigenpair)
TEST(PoissonAirboxEigenOracle, PositiveFrequencyBranchMatchesToyGyrotropicPencil)
TEST(PoissonAirboxEigenOracle, SignFlipBreaksSyntheticDemagKittelFrequency)
TEST(PoissonAirboxEigenOracle, EmitsOracleDiagnosticsJson)
```

### 13.2. Required acceptance thresholds

```text
schur_apply_relative_error <= 1e-10
full_residual_reconstruction_relative_error <= 1e-10
poisson_constraint_relative_residual <= 1e-10
gauge_mean_abs <= 1e-12
relative_frequency_error <= 1e-10 for synthetic toy
```

### 13.3. Minimal C++ test fragment

```cpp
TEST(PoissonAirboxEigenOracle, PositiveFrequencyBranchMatchesToyGyrotropicPencil)
{
    constexpr double two_pi = 6.283185307179586476925286766559;
    const double f0 = 2.0e9;
    const double omega0 = two_pi * f0;

    const double Aqq[4] = {
        0.0, -omega0,
        omega0, 0.0,
    };
    const double Bqq[4] = {
        1.0, 0.0,
        0.0, 1.0,
    };

    // Two-potential-node Laplacian with constant nullspace.
    const double P[4] = {
        1.0, -1.0,
        -1.0, 1.0,
    };
    const double Aqphi[4] = {0.0, 0.0, 0.0, 0.0}; // q x phi = 2x2
    const double Aphiq[4] = {0.0, 0.0, 0.0, 0.0}; // phi x q = 2x2
    const double weights[2] = {0.5, 0.5};
    const double q_re[2] = {1.0, 0.0};
    const double q_im[2] = {0.0, 0.0};

    DensePoissonAirboxEigenOracleProblem p{};
    p.q_dof_count = 2;
    p.phi_dof_count = 2;
    p.A_qq = DenseRealMatrixView{Aqq, 2, 2};
    p.A_qphi = DenseRealMatrixView{Aqphi, 2, 2};
    p.A_phiq = DenseRealMatrixView{Aphiq, 2, 2};
    p.A_phiphi = DenseRealMatrixView{P, 2, 2};
    p.B_qq = DenseRealMatrixView{Bqq, 2, 2};
    p.phi_mean_weights = weights;
    p.phi_mean_weights_count = 2;
    p.test_q = DenseComplexVectorView{q_re, q_im, 2};
    p.expected_positive_frequency_hz = f0;
    p.expected_frequency_relative_tolerance = 1e-10;

    DensePoissonAirboxEigenOracleResult r{};
    ASSERT_EQ(solve_dense_poisson_airbox_eigen_oracle(p, &r), FrequencyDomainStatus::ok)
        << r.error_message;
    EXPECT_TRUE(r.positive_frequency_branch_found);
    EXPECT_LT(r.relative_frequency_error, 1e-10);
    EXPECT_LT(r.full_residual_reconstruction_relative_error, 1e-10);
    EXPECT_LT(r.gauge_mean_abs, 1e-12);
}
```

---

## 14. PA-E1 diagnostics JSON schema

The oracle must emit a small JSON string. This is not a full artifact writer yet, but it must be machine-parseable.

```json
{
  "schema_version": "poisson_airbox_eigen_oracle.v1",
  "status": "passed",
  "study_product": "modal_eigen",
  "test_id": "pa_e1_dense_poisson_airbox_eigen_oracle",
  "scope": "synthetic_dense_algebraic_oracle",
  "phasor_convention": "exp_plus_i_omega_t",
  "eigenvalue_convention": "lambda_imag_positive_frequency",
  "demag_kind": "synthetic_poisson_airbox_k0",
  "gauge_policy": "mean_zero_augmented",
  "alpha": 0.0,
  "k_vector_rad_per_m": [0.0, 0.0, 0.0],
  "q_dof_count": 2,
  "phi_dof_count": 2,
  "augmented_phi_dof_count": 3,
  "metrics": {
    "schur_apply_relative_error": 0.0,
    "full_residual_reconstruction_relative_error": 0.0,
    "poisson_constraint_relative_residual": 0.0,
    "gauge_mean_abs": 0.0,
    "eigen_residual_relative": 0.0,
    "relative_frequency_error": 0.0
  },
  "eigenpair": {
    "eigenvalue_real": 0.0,
    "eigenvalue_imag": 12566370614.359172,
    "omega_rad_s": 12566370614.359172,
    "frequency_hz": 2000000000.0,
    "positive_frequency_branch_found": true
  },
  "certification": {
    "schur_certified": true,
    "full_residual_certified": true,
    "production_periodic_airbox_claim": false
  }
}
```

Rules:

```text
Do not claim demag_kind=periodic_airbox_k0 for synthetic PA-E1.
Use synthetic_poisson_airbox_k0 or synthetic_demag_factor.
Do not claim gpu_device or CPU sparse.
Do not claim MFEM assembly.
```

---

## 15. PA-E1 implementation sequence for Codex

Implement exactly in this order.

### Task 0 — documentation cleanup

```text
- rename typo path to canonical path;
- add two physics-doc pointers;
- keep old path out of active docs;
- do not touch C++ yet.
```

Acceptance:

```bash
test -z "$(find docs/plans/active/fd_sovler_masterplan -maxdepth 1 -type f -name '*posion*' -print)"
rg -n "18_poisson_airbox_eigensolve_cpu_gpu_implementation" docs/plans/active docs/physics
```

### Task 1 — header skeleton

```text
- add dense_poisson_airbox_eigen_oracle.hpp;
- define problem/result structs;
- define solve function declaration;
- add no implementation yet.
```

Acceptance:

```bash
just verify-fem-frequency-domain-native-contract
```

or the relevant native contract compile target.

### Task 2 — RED tests

Add test file with failing tests for:

```text
- missing gauge weights;
- positive-frequency toy;
- Schur apply;
- full residual reconstruction;
- diagnostics JSON.
```

Run selected test and see failure due missing implementation.

### Task 3 — validation-only implementation

Implement shape/field validation. Make `RejectsMissingGaugeWeights` pass.

### Task 4 — dense linalg and mean-zero gauge

Implement:

```text
- Gaussian complex solve;
- mean-zero augmented Poisson;
- solve_phi_for_q;
- gauge residual.
```

Make gauge test pass.

### Task 5 — Schur apply and explicit Schur

Implement:

```text
- apply_schur;
- build_explicit_schur_by_columns;
- compare on q_test.
```

Make Schur test pass.

### Task 6 — 2x2 positive-frequency eigen branch

Implement minimal `q_dof_count=2` eigen solve. Make Kittel toy pass.

### Task 7 — full residual reconstruction

Implement descriptor residual. Make reconstruction test pass.

### Task 8 — diagnostics JSON

Emit `poisson_airbox_eigen_oracle.v1`. Make JSON test pass.

### Task 9 — just gate

Add:

```text
verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
```

Run it.

### Task 10 — documentation status update

Update:

```text
10_patch_queue_current_status.md
09_validation_certification_benchmarks.md
18_poisson_airbox_eigensolve_cpu_gpu_implementation.md
```

Record exact command and result.

---

## 16. PA-E2 CPU sparse/full-coupled SLEPc plan

PA-E2 is not part of PA-E1, but this section removes the next major ambiguities.

### 16.1. New files

```text
backends/fem/include/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp
backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp
backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
```

### 16.2. Internal descriptor

```cpp
struct PoissonAirboxEigenBlockProblem {
    std::uint32_t abi_version = 1;
    std::uint64_t struct_size = sizeof(PoissonAirboxEigenBlockProblem);

    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;

    CsrMatrixView A_qq;
    CsrMatrixView A_qphi;
    CsrMatrixView A_phiq;
    CsrMatrixView A_phiphi;
    CsrMatrixView B_qq;

    const double* phi_mean_weights = nullptr;
    std::uint64_t phi_mean_weights_count = 0;

    const char* gauge_policy = "mean_zero_augmented";
    const char* demag_kind = "periodic_airbox_k0";
    const char* phasor_convention = "exp_plus_i_omega_t";
    const char* eigenvalue_convention = "lambda_imag_positive_frequency";
    const char* solver_adapter = "k0_poisson_airbox_cpu_full_coupled_slepc";

    bool k0_only = true;
    bool alpha_zero_required = true;
    bool symmetric_mesh_certificate_required = true;
    bool real_fem_blocks = true;
};
```

### 16.3. Monolithic SeqAIJ assembly

Use full augmented size:

```text
nq = q_dof_count
np = phi_dof_count
ng = 1
N = nq + np + ng
```

Offsets:

```cpp
const PetscInt q0 = 0;
const PetscInt p0 = static_cast<PetscInt>(nq);
const PetscInt g0 = static_cast<PetscInt>(nq + np);
```

Assembly sketch:

```cpp
Mat A = nullptr;
Mat B = nullptr;
MatCreateSeqAIJ(PETSC_COMM_SELF, N, N, estimated_nnz, nullptr, &A);
MatCreateSeqAIJ(PETSC_COMM_SELF, N, N, estimated_nnz_B, nullptr, &B);

insert_csr_block(A, q0, q0, problem.A_qq);
insert_csr_block(A, q0, p0, problem.A_qphi);
insert_csr_block(A, p0, q0, problem.A_phiq);
insert_csr_block(A, p0, p0, problem.A_phiphi);

for (PetscInt i = 0; i < np; ++i) {
    const PetscScalar w = static_cast<PetscScalar>(problem.phi_mean_weights[i]);
    MatSetValue(A, p0 + i, g0, w, INSERT_VALUES);
    MatSetValue(A, g0, p0 + i, w, INSERT_VALUES);
}

insert_csr_block(B, q0, q0, problem.B_qq);

MatAssemblyBegin(A, MAT_FINAL_ASSEMBLY);
MatAssemblyEnd(A, MAT_FINAL_ASSEMBLY);
MatAssemblyBegin(B, MAT_FINAL_ASSEMBLY);
MatAssemblyEnd(B, MAT_FINAL_ASSEMBLY);
```

### 16.4. SLEPc setup default

```cpp
EPS eps = nullptr;
EPSCreate(PETSC_COMM_SELF, &eps);
EPSSetOperators(eps, A, B);
EPSSetProblemType(eps, EPS_GNHEP);

ST st = nullptr;
EPSGetST(eps, &st);
STSetType(st, STSINVERT);

KSP ksp = nullptr;
STGetKSP(st, &ksp);
KSPSetType(ksp, KSPPREONLY);
PC pc = nullptr;
KSPGetPC(ksp, &pc);
PCSetType(pc, PCLU);

EPSSetWhichEigenpairs(eps, EPS_TARGET_IMAGINARY);
EPSSetTarget(eps, PetscScalar(0.0, target_omega_rad_s));
EPSSetTolerances(eps, tolerance, max_iterations);
EPSSetDimensions(eps, requested_mode_count * 2, PETSC_DEFAULT, PETSC_DEFAULT);
EPSSetFromOptions(eps);
EPSSolve(eps);
```

If PETSc is a real build and cannot create complex target, use the existing repository convention for imaginary eigenvalue targeting. Do not introduce a separate complex-PETSc requirement for PA-E2.

### 16.5. PA-E2 acceptance

```text
- tiny sparse matrix equals PA-E1 dense oracle frequency;
- full descriptor residual is recomputed from returned eigenvector;
- gauge mean is small;
- positive branch selected;
- output JSON says solver_adapter=k0_poisson_airbox_cpu_full_coupled_slepc;
- no public ABI bump.
```

---

## 17. PA-E3 Schur MatShell plan

### 17.1. Status

Schur MatShell is an explicit/certified backend first. It must not be auto-selected until certificates pass.

### 17.2. MatShell apply

```text
MatMult(S_shell, q, y):
  tmp_phi_rhs = -A_phiq q
  phi = solve_mean_zero_poisson(tmp_phi_rhs)
  y = A_qq q + A_qphi phi
```

### 17.3. Certification before use

Required per problem:

```text
S_shell vs PA-E1/PA-E2 reference on sampled vectors
full residual reconstruction on sampled eigenvectors
Schur certificate key includes mesh/material/m0/h_eff0/static_demag/boundary/k/gauge/operator versions
```

### 17.4. Auto-selection policy

Initial policy:

```text
never auto-select Schur MatShell unless request explicitly asks for schur_reduced and certificate is accepted.
```

Later policy after enough evidence:

```text
planner may choose schur_reduced only if certificate accepted and runtime eta thresholds are good.
```

---

## 18. PA-E4 Kittel K0-3 demag validation

### 18.1. Directory policy

Use existing directory:

```text
validation/kittel_k0_pbc/
```

Do not create `validation/kittel_k0_pbc_demag/`.

Distinguish cases by:

```json
{
  "case_id": "K0-3",
  "demag_kind": "periodic_airbox_k0",
  "model": "thin_film_inplane_fmr"
}
```

### 18.2. Staged implementation

```text
K0-3a synthetic demag-factor toy, no FEM airbox
K0-3b small FEM film, 1 layer, shared-domain airbox
K0-3c mesh-convergence table
K0-3d production CI threshold tightening
```

### 18.3. Formula policy

Ideal in-plane film formula:

```text
f = gamma0/(2*pi) * sqrt(H0 * (H0 + M_eff))
```

For first synthetic ideal case:

```text
M_eff = Ms
```

For FEM airbox convergence:

```text
M_eff = Ms * N_eff
```

where `N_eff` must be measured or reported through numerical demag convergence. Do not hard-code `M_eff = Ms` for arbitrary finite airbox/mesh cases unless the geometry actually matches the ideal thin-film limit.

### 18.4. Threshold policy

Initial smoke:

```text
relative_frequency_error <= 2e-2
```

Final production threshold after convergence:

```text
relative_frequency_error <= value justified by convergence table
```

The convergence table must report:

```text
mesh resolution
airbox size
phi dof count
Poisson residual
relative Kittel frequency error
estimated M_eff
```

---

## 19. GPU plan: parity-first, runtime later

### 19.1. GPU-G1 standalone Poisson parity

Goal:

```text
same RHS Cq, same gauge, same phi, same delta_H_demag as CPU for tiny/medium cases
```

Required:

```text
device-resident phi buffer
device-resident RHS buffer
no silent CPU fallback
explicit execution_policy=device
explicit memory_location=device
```

Artifact fields:

```json
{
  "gpu_poisson_parity": {
    "status": "passed",
    "max_relative_phi_error": 0.0,
    "max_relative_field_error": 0.0,
    "h2d_count": 0,
    "d2h_count": 0,
    "fallback_used": false
  }
}
```

### 19.2. GPU-G2 Schur apply parity

Compare:

```text
S_gpu(q) vs S_cpu(q)
```

for deterministic vectors:

```text
basis vectors
random seed vectors
modal candidate vectors
```

Threshold initial:

```text
relative_error <= 1e-6
```

### 19.3. GPU-G3 shift-invert parity

Only after G1/G2. Compare shift-invert action:

```text
(A - sigma B)^-1 B v
```

CPU vs GPU.

### 19.4. GPU-G4 hidden compatibility lane

Allowed label:

```text
gpu_operator_host_modal_eigen_compatibility
```

Policy:

```text
hidden CI/developer lane only;
not exposed in UI as production;
artifact must say gpu_device_resident_modal_eigensolver=false.
```

### 19.5. GPU-G5 true device modal eigensolver

Only after:

```text
G1/G2/G3 pass
CPU sparse/full-coupled reference exists
Schur certificate exists
no per-iteration host roundtrip
device eigensolver or shift-invert loop exists
```

### 19.6. GPU-G5a tiny dense device eigensolver contract

The first allowed GPU-G5 slice is intentionally narrow:

```text
input: tiny full-coupled Poisson-airbox modal pencil descriptor
solver: dense inverse-iteration shift-invert loop in CUDA
scope: contract/provenance/runtime proof only
not yet: sparse production Krylov-Schur, large mesh, public UI lane
```

Required artifact:

```text
eigen/diagnostics/gpu_modal_poisson_airbox_eigensolver.v1.json
```

Required provenance:

```text
schema_version = gpu_modal_poisson_airbox_eigensolver.v1
study_product = modal_eigen
execution_lane = gpu_device_modal_eigen_dense_contract
solver_adapter = gpu_dense_poisson_airbox_modal_eigen_contract
solver_library = cuda_dense_inverse_iteration
demag_kind = periodic_airbox_k0
gauge_policy = mean_zero_augmented
phasor_convention = exp_plus_i_omega_t
frequency_response_proxy = false
gpu_device_resident_modal_eigensolver = true
cpu_fallback = disabled
fallback_used = false
per_iteration_h2d_count = 0
per_iteration_d2h_count = 0
```

Initial acceptance:

```text
relative_reference_frequency_error <= 1e-8
full_descriptor_relative_residual <= 1e-8
```

### 19.7. GPU-G5b CSR device descriptor apply foundation

GPU-G5b starts the sparse/matrix-free production path by applying the full
coupled modal descriptor on the GPU:

```text
input: full augmented vector x = [q, phi, eta]
operator: A*x for the full-coupled Poisson-airbox modal pencil
matrix source: CSR blocks A_qq, A_qphi, A_phiq, A_phiphi plus gauge weights
not yet: sparse shift-invert linear solve or Krylov-Schur eigen iteration
```

Required artifact:

```text
eigen/diagnostics/gpu_modal_poisson_airbox_descriptor_apply.v1.json
```

Required provenance:

```text
schema_version = gpu_modal_poisson_airbox_descriptor_apply.v1
study_product = modal_eigen
execution_lane = gpu_device_modal_descriptor_apply_contract
solver_family = modal_eigen
operator_family = full_coupled_poisson_airbox_modal_pencil
algebraic_action = A*x
matrix_format = csr_device_apply
frequency_response_proxy = false
gpu_device_resident_operator_apply = true
cpu_fallback = disabled
fallback_used = false
per_iteration_h2d_count = 0
per_iteration_d2h_count = 0
```

This is the operator-apply foundation for a later sparse/matrix-free GPU modal
eigensolver. It must not be described as a full GPU-G5 production eigensolver
until the sparse shift-invert/Krylov-Schur loop exists and is validated.

---

## 20. Planner / unsupported behavior

### 20.1. `k=0` support matrix

| Case | PA-E1 | PA-E2 | PA-E3 | PA-E4 | GPU |
|---|---:|---:|---:|---:|---:|
| synthetic dense Poisson-airbox eigen | supported | n/a | n/a | n/a | n/a |
| CPU sparse full-coupled `k=0` | no | supported | optional | used | no |
| CPU Schur `k=0` | no | no | explicit/certified | optional | no |
| GPU Poisson parity | no | no | no | no | G1 |
| GPU full modal runtime | no | no | no | no | G5 only |
| non-k0/Floquet dynamic demag | unsupported | unsupported | unsupported | unsupported | unsupported |

### 20.2. Unsupported reasons

Use exact reason strings:

```text
poisson_airbox_eigen_pa_e1_synthetic_only
poisson_airbox_eigen_requires_mean_zero_gauge
poisson_airbox_eigen_requires_alpha_zero_v1
poisson_airbox_eigen_requires_k0_v1
poisson_airbox_eigen_requires_periodic_mesh_certificate
poisson_airbox_eigen_requires_airbox_pair_map
poisson_airbox_eigen_requires_full_coupled_blocks
poisson_airbox_eigen_cpu_slepc_not_implemented
poisson_airbox_eigen_schur_uncertified
poisson_airbox_eigen_gpu_parity_not_available
poisson_airbox_eigen_nonzero_k_dynamic_demag_unsupported
```

### 20.3. Planner Rust/native behavior

If Rust planner has enough metadata to know the case is unsupported, fail early. If only native has enough detail, native must return exact `unsupported_reason`.

Do not silently fall back to no-demag, CPU, or dense if request says `periodic_airbox_k0` and the backend cannot honor it.

Implementation note from 2026-07-08: the native PA-E2 modal-eigen path now
requires and emits a minimal `periodic_mesh_certificate.v5` descriptor through
the modal-eigen C ABI tail. The descriptor carries the certificate schema plus
positive magnetic and airbox pair counts, rejects missing certificate metadata
with `poisson_airbox_eigen_requires_periodic_mesh_certificate`, and is covered
by `just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc` plus
`just verify-fem-frequency-domain-native-contract`. This is certificate
plumbing for PA-E2; it is not yet real shared-airbox small-film matrix assembly
or accepted `G_pair` consumption for the production solver.

Follow-up implementation note from 2026-07-08: PA-E2 now also rejects
`periodic_airbox_k0` descriptors whose demag feedback is effectively
decoupled. Both `A_qphi` and `A_phiq` must contain at least one nonzero CSR
entry, otherwise validation returns
`poisson_airbox_eigen_requires_full_coupled_blocks`. This prevents a no-demag
or metadata-only payload from being reported as full-coupled Poisson-airbox.
The managed `just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc`
gate covers this negative case. Real FEM/shared-airbox assembly remains the
next production requirement.

Runner follow-up from 2026-07-08: the native CPU modal-window path now admits
K0-3 validation requests with `demag_kind=periodic_airbox_k0` only when the
runner can build and attach a `poisson_airbox_block_problem` payload. A first
PA-E4b macrocell/Kittel payload builder is wired into
`NativeModalEigenRequest`; it produces nonzero `A_qphi` and `A_phiq` CSR
blocks and routes the request to the native full-coupled Poisson-airbox SLEPc
adapter instead of the ordinary Full2x2 shift-invert adapter. The builder now
requires positive magnetic and airbox periodic pair counts derived from the
plan mesh element markers and periodic node pairs; it no longer promotes
missing pair maps by substituting synthetic `1/1` counts. It also requires a
positive `air_box_config.factor` and positive mesh extent before claiming a
Poisson-airbox payload. The payload dimensions now scale with the real pair
maps (`q_dof_count = 2 * magnetic_pair_count`,
`phi_dof_count = 2 * airbox_pair_count`) instead of staying fixed at the toy
`2/2` size. `A_phiphi` now uses geometry-dependent weights from airbox
periodic-pair lengths instead of a unit-weight topological ring, and `B_qq`
now uses lumped magnetic element volumes instead of unit diagonal masses. This
is still a small block validation payload, not the final shared-domain MFEM
mesh/material/equilibrium CSR assembler.

---

## 21. Artifact schema for PA-E2/PA-E4

### 21.1. Solver diagnostics

```json
{
  "schema_version": "poisson_airbox_eigensolve.v1",
  "study_product": "modal_eigen",
  "status": "ready",
  "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
  "execution_lane": "production_cpu",
  "resolved_execution_lane": "production_cpu",
  "phasor_convention": "exp_plus_i_omega_t",
  "eigenvalue_convention": "lambda_imag_positive_frequency",
  "demag_kind": "periodic_airbox_k0",
  "k_vector_rad_per_m": [0.0, 0.0, 0.0],
  "gauge_policy": "mean_zero_augmented",
  "alpha": 0.0,
  "operator_blocks": {
    "q_dof_count": 0,
    "phi_dof_count": 0,
    "augmented_phi_dof_count": 0,
    "a_qq_nnz": 0,
    "a_qphi_nnz": 0,
    "a_phiq_nnz": 0,
    "a_phiphi_nnz": 0,
    "b_qq_nnz": 0
  },
  "mesh_certificate": {
    "schema_version": "periodic_mesh_certificate.v5",
    "certificate_status": "accepted",
    "magnetic_pair_map_sha256": "sha256:...",
    "airbox_pair_map_sha256": "sha256:...",
    "tangent_frame_transfer_artifact_status": "accepted_native_certificate_consumed"
  },
  "residuals": {
    "max_eigen_residual_relative": 0.0,
    "max_full_descriptor_residual_relative": 0.0,
    "max_poisson_constraint_residual_relative": 0.0,
    "max_gauge_mean_abs": 0.0
  }
}
```

### 21.2. Kittel summary reuse

`validation/kittel_k0_pbc/summary.v1.json` must include:

```json
{
  "schema_version": "frequency_domain_kittel_k0_validation.v1",
  "status": "passed",
  "case_id": "K0-3",
  "test_id": "kittel_k0_pbc_thinfilm_demag_inplane",
  "demag_kind": "periodic_airbox_k0",
  "expected_formula": "gamma0_over_2pi_sqrt_H0_H0_plus_Meff",
  "m_eff_policy": "ideal_ms|numeric_demag_factor|fitted_from_convergence",
  "max_relative_frequency_error": 0.0
}
```

---

## 22. Minimal Python verifier fragment

Add later, but schema starts in PA-E1.

```python
def verify_poisson_airbox_eigen_oracle(path: Path) -> None:
    data = json.loads(path.read_text())
    require(data["schema_version"] == "poisson_airbox_eigen_oracle.v1")
    require(data["phasor_convention"] == "exp_plus_i_omega_t")
    require(data["eigenvalue_convention"] == "lambda_imag_positive_frequency")
    require(data["gauge_policy"] == "mean_zero_augmented")
    require(data["certification"]["production_periodic_airbox_claim"] is False)

    metrics = data["metrics"]
    require(metrics["schur_apply_relative_error"] <= 1e-10)
    require(metrics["full_residual_reconstruction_relative_error"] <= 1e-10)
    require(metrics["poisson_constraint_relative_residual"] <= 1e-10)
    require(metrics["gauge_mean_abs"] <= 1e-12)
    require(metrics["relative_frequency_error"] <= 1e-10)

    eig = data["eigenpair"]
    require(eig["positive_frequency_branch_found"] is True)
    require(eig["eigenvalue_imag"] > 0.0)
    require(abs(eig["frequency_hz"] - eig["omega_rad_s"] / (2.0 * math.pi)) <= 1e-6)
```

---

## 23. Code review checklist

Before merging PA-E1, verify:

```text
[ ] typo doc path removed from active docs
[ ] physics docs point to canonical 18 file
[ ] no public C ABI layout changed
[ ] no Rust FFI layout changed
[ ] no Python DSL behavior changed
[ ] new dense oracle is internal-only
[ ] mean_zero_augmented is default and required
[ ] pin_first_dof is not accepted by PA-E1 production oracle
[ ] alpha is fixed to zero in test cases
[ ] k=0 is explicit in JSON
[ ] synthetic cases do not claim real periodic_airbox_k0 production coverage
[ ] sign-flip negative test exists
[ ] Schur apply vs explicit Schur test exists
[ ] full residual reconstruction test exists
[ ] positive-frequency branch test exists
[ ] diagnostics JSON is machine-parseable
[ ] just gate exists and passes
```

---

## 24. Done definition for PA-E1

PA-E1 is complete only when all are true:

```text
1. canonical doc path fixed;
2. physics doc pointers added;
3. dense_poisson_airbox_eigen_oracle.hpp/cpp exist;
4. oracle validates shapes and gauge policy;
5. mean-zero augmented Poisson solve works;
6. Schur explicit/apply agreement test passes;
7. full residual reconstruction test passes;
8. positive-frequency toy eigen test passes;
9. sign-flip negative test catches wrong sign;
10. oracle emits poisson_airbox_eigen_oracle.v1 diagnostics;
11. just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle passes;
12. patch queue docs updated with exact command and result.
```

Not part of PA-E1:

```text
real MFEM block extraction
CPU sparse/SLEPc production path
Schur MatShell
K0-3 real airbox Kittel gate
GPU parity/runtime
public ABI fields
Python DSL demag knob
```

### 24.1. PA-E1 implementation evidence - 2026-07-08

PA-E1 is implemented at the native synthetic dense algebraic oracle level.

Implemented files:

```text
backends/fem/include/frequency_domain/dense_poisson_airbox_eigen_oracle.hpp
backends/fem/cpu/frequency_domain/dense_poisson_airbox_eigen_oracle.cpp
backends/fem/tests/frequency_domain/poisson_airbox_eigen_oracle_test.cpp
```

Gate:

```text
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
```

Observed result:

```text
passed
cmake --build native/build --target fem_poisson_airbox_eigen_oracle_contract
[100%] Built target fem_poisson_airbox_eigen_oracle_contract
native/build/backends/fem/fem_poisson_airbox_eigen_oracle_contract exited 0
```

Covered by the native contract:

```text
mean_zero_augmented gauge required
pin_first_dof rejected
singular Poisson block solved through gauge augmentation
Schur apply equals explicit Schur
full descriptor residual reconstructs the reduced eigenpair
positive-frequency branch uses imag(lambda) > 0
frequency_hz = imag(lambda)/(2*pi)
synthetic demag-factor Kittel-like toy passes with the correct sign
sign-flip negative test fails the expected demag frequency
production demag_kind=periodic_airbox_k0 is rejected by PA-E1
diagnostics JSON emits poisson_airbox_eigen_oracle.v1
```

Scope boundary:

```text
This PA-E1 evidence does not claim real periodic_airbox_k0 production modal
coverage. PA-E2 CPU sparse/SLEPc, PA-E3 Schur MatShell, PA-E4 K0-3 thin-film
demag validation, and GPU parity/runtime remain future gates.
```

---

## 25. PA-E2 done definition

PA-E2 is complete only when:

```text
1. internal PoissonAirboxEigenBlockProblem exists;
2. monolithic SeqAIJ A/B assembly works;
3. mean_zero_augmented sparse gauge works;
4. SLEPc solves the tiny sparse problem;
5. returned eigenvectors reconstruct full residual;
6. PA-E2 sparse result matches PA-E1 dense oracle;
7. no public ABI bump unless public struct layout changes;
8. solver diagnostics emit solver_adapter=k0_poisson_airbox_cpu_full_coupled_slepc;
9. just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc exists and passes.
```

### 25.1. PA-E2 implementation evidence - 2026-07-08

PA-E2 is implemented at the native tiny sparse/full-coupled SLEPc contract
level.

Implemented files:

```text
backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp
backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp
backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
```

Gate:

```text
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
```

Observed result:

```text
passed
cmake --build native/build --target fem_poisson_airbox_modal_eigen_slepc_contract
[100%] Built target fem_poisson_airbox_modal_eigen_slepc_contract
native/build/backends/fem/fem_poisson_airbox_modal_eigen_slepc_contract exited 0
```

Covered by the native contract:

```text
internal PoissonAirboxEigenBlockProblem exists
monolithic SeqAIJ A/B assembly works
mean_zero_augmented sparse gauge works
SLEPc solves the tiny sparse full-coupled descriptor problem
returned eigenvector reconstructs the full descriptor residual
PA-E2 sparse frequency matches the PA-E1 dense oracle
diagnostics emit solver_adapter=k0_poisson_airbox_cpu_full_coupled_slepc
PA-E2 rejects PA-E1 synthetic demag_kind values
```

Regression evidence:

```text
just verify-fem-frequency-domain-native-contract
passed after PA-E2
```

Scope boundary:

```text
This PA-E2 evidence does not claim K0-3 real thin-film demag validation, real
FEM-airbox mesh extraction, Python/API/IR exposure, or GPU modal parity/runtime.
Those remain PA-E4 and PA-G gates after PA-E3.
```

---

## 26. PA-E3 done definition

PA-E3 is complete only when:

```text
1. Schur MatShell implements S(q) = A_qq q + A_qphi phi(q);
2. Poisson setup is reused;
3. Schur MatShell matches full-coupled sparse reference;
4. certificate key is emitted;
5. uncertified Schur is rejected by planner;
6. certified Schur can be selected only explicitly;
7. just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell exists and passes.
```

### 26.1. PA-E3 implementation evidence - 2026-07-08

PA-E3 is implemented at the native tiny Schur MatShell certification contract
level.

Implemented files:

```text
backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp
backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp
backends/fem/tests/frequency_domain/poisson_airbox_schur_matshell_test.cpp
```

Gate:

```text
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell
```

Observed result:

```text
passed
cmake --build native/build --target fem_poisson_airbox_schur_matshell_contract
[100%] Built target fem_poisson_airbox_schur_matshell_contract
native/build/backends/fem/fem_poisson_airbox_schur_matshell_contract exited 0
```

Covered by the native contract:

```text
PETSc MatShell creation for Schur-reduced magnetic operator
S(q) = A_qq q + A_qphi phi(q)
mean_zero_augmented Poisson setup reuse
Schur-specific positive normalized phi_mean_weights validation before certificate key construction
sampled MatShell-vs-explicit Schur apply agreement
PA-E3 Schur eigenfrequency matches PA-E2 full-coupled sparse reference
full descriptor residual reconstruction from Schur eigenvector
Schur certificate key emission with mesh/material/m0/h_eff0/static_demag/boundary/k/gauge/operator signatures
planner rejects implicit Schur auto-selection
planner selects schur_reduced only for explicit certified requests
```

Regression evidence:

```text
just verify-fem-frequency-domain-native-contract
passed after PA-E3
```

Scope boundary:

```text
This PA-E3 evidence does not claim K0-3 real thin-film demag validation, real
FEM-airbox mesh extraction, Python/API/IR exposure, or GPU modal parity/runtime.
Those remain PA-E4 and PA-G gates.
```

---

## 27. PA-E4 done definition

PA-E4 is complete only when:

```text
1. K0-3 synthetic demag-factor test passes;
2. K0-3 small FEM film test exists;
3. periodic mesh certificate is consumed;
4. airbox pair map is consumed;
5. phi gauge is mean_zero_augmented;
6. convergence table exists;
7. validation/kittel_k0_pbc/summary.v1.json and points.v1.csv include case_id=K0-3;
8. just verify-fem-frequency-domain-eigen-k0-kittel-demag-cpu exists and passes.
```

### 27.1. PA-E4a implementation evidence - 2026-07-08

Implemented the first K0-3 staged gate as a synthetic demag-factor reference,
not as real periodic Poisson-airbox demag:

```text
case_id: K0-3
demag_kind: synthetic_demag_factor
model: thin_film_in_plane
formula: f = gamma0/(2*pi) * sqrt(H0 * (H0 + M_eff))
M_eff: Ms for the synthetic ideal thin-film gate only
production_periodic_airbox_claim: false
```

Code-level changes:

```text
packages/fullmag-py/src/fullmag/model/eigen.py
  K0KittelFieldSweepValidation now accepts optional case_id and demag_kind.

crates/fullmag-ir/src/plan.rs
crates/fullmag-plan/src/fem.rs
  FemEigenK0KittelValidationIR carries optional case_id/demag_kind and validates
  supported demag_kind tokens.

crates/fullmag-runner/src/eigen/types.rs
crates/fullmag-runner/src/dispatch.rs
  Added reference_k0_kittel_synthetic_demag_factor for the narrow PA-E4a path:
  case_id=K0-3, demag_kind=synthetic_demag_factor, model=thin_film_in_plane,
  include_demag=true, Floquet k=0 samples.

crates/fullmag-runner/src/eigen/artifacts.rs
  validation/kittel_k0_pbc/summary.v1.json and points.v1.csv now carry
  case_id/demag_kind metadata. The synthetic gate explicitly reports
  production_periodic_airbox_claim=false.

scripts/verify_fem_frequency_domain_eigen_artifacts.py
  Added --require-k0-kittel-demag. It implies the K0 field sweep check and
  requires K0-3 demag metadata in metadata.json, summary.v1.json, and
  points.v1.csv.

examples/fem_eigen_k0_kittel_thinfilm_demag.py
just verify-fem-frequency-domain-eigen-k0-kittel-demag-cpu
  Added the PA-E4a example and managed-runtime gate entry point.
```

Verification completed in this session:

```text
PYTHONPYCACHEPREFIX=/tmp/fullmag-pycache python3 -m py_compile \
  packages/fullmag-py/src/fullmag/model/eigen.py \
  scripts/verify_fem_frequency_domain_eigen_artifacts.py \
  scripts/test_verify_fem_frequency_domain_eigen_artifacts.py \
  examples/fem_eigen_k0_kittel_thinfilm_demag.py

python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel'
  12 passed

PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_api.py -k 'k0_kittel'
  4 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-plan \
  fem_eigen_carries_k0_kittel_validation_from_runtime_metadata
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner \
  k_path_manifest_and_auxiliary_artifacts_carry_k0_kittel_validation
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner \
  k0_kittel_synthetic_demag_factor_single_k_matches_thin_film_formula
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-plan \
  fem_eigen_allows_k0_kittel_synthetic_demag_factor_floquet_path
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-plan \
  fem_eigen_floquet_dynamic_demag_is_rejected
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner \
  k0_kittel_synthetic_demag_factor_path_bypasses_floquet_dynamic_demag_gate
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner \
  runner_rejects_floquet_dynamic_demag_gate
  1 passed
```

Container-backed gate status:

```text
just verify-fem-frequency-domain-eigen-k0-kittel-demag-cpu
  passed through the managed FEM runtime route
  script: examples/fem_eigen_k0_kittel_thinfilm_demag.py
  verifier: scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-k0-kittel-demag
```

This means PA-E4a is implemented and verified through the authoritative managed
FEM runtime gate for the synthetic-demag K0-3 slice. The planner and runner now
allow only gamma-only K0-3 `synthetic_demag_factor` Floquet field sweeps to
bypass the generic Floquet dynamic-demag guard; ordinary nonzero-k Floquet
dynamic demag remains rejected. PA-E4 as a whole remains incomplete until the
small real FEM film/shared-airbox fixture, periodic mesh certificate
consumption, airbox pair-map consumption, mean-zero phi gauge evidence, and
convergence table are implemented and verified.

### 27.2. PA-E4b/c verifier hardening evidence - 2026-07-08

The K0-3 artifact verifier now distinguishes the synthetic-demag gate from the
real periodic-airbox gate. `demag_kind=synthetic_demag_factor` remains the PA-E4a
contract. `demag_kind=periodic_airbox_k0` is accepted only when the artifacts
also prove real-airbox evidence:

```text
--require-k0-kittel-demag
  accepts either the PA-E4a synthetic-demag K0-3 contract or a fully evidenced
  periodic_airbox_k0 contract.

--require-k0-kittel-periodic-airbox-demag
  requires the K0-3 contract and additionally requires
  demag_kind=periodic_airbox_k0, so synthetic K0-3 artifacts cannot satisfy the
  narrow PA-E4b periodic-airbox CPU gate.
```

```text
summary.v1.json demag block:
  assembly_kind = synthetic_algebraic_oracle
  outer_boundary_kind = pure_neumann
  gauge_policy = mean_zero_augmented
  gauge_reason = pure_neumann_nullspace
  phi_dof_count > 0
  poisson_constraint_relative_residual <= 1e-8
  magnetic_pair_count > 0
  airbox_pair_count > 0
  production_periodic_airbox_claim = false

validation/kittel_k0_pbc/convergence.v1.csv:
  case_id
  demag_kind
  mesh_resolution_m
  airbox_size_m
  phi_dof_count
  poisson_residual_relative
  relative_kittel_frequency_error
  effective_magnetisation_A_per_m
```

Focused verifier tests now cover both sides:

```text
python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel'
  10 passed
```

This verifier/contract hardening slice now protects the narrow PA-E4b CPU
solver result. It prevents any implementation from passing
`periodic_airbox_k0` by only renaming the synthetic gate.

### 27.3. PA-E4 public/runtime guard evidence - 2026-07-08

The public/runtime path now rejects premature K0-3 `periodic_airbox_k0` use:

```text
packages/fullmag-py/src/fullmag/model/eigen.py
  Public K0KittelFieldSweepValidation.demag_kind accepts only:
    none
    synthetic_demag_factor

crates/fullmag-plan/src/fem.rs
  Raw runtime metadata with demag_kind=periodic_airbox_k0 is rejected with a
  PA-E4b-specific message instead of planning an unsupported runtime.

crates/fullmag-runner/src/eigen/artifacts.rs
  Manually constructed PathSolveResult artifacts with
  demag_kind=periodic_airbox_k0 are rejected unless the PA-E4b path provides
  real FEM-airbox metrics. The generic/synthetic K0 branch writer cannot emit
  production periodic-airbox claims.
```

Focused verification:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_api.py -k 'k0_kittel'
  5 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-plan \
  fem_eigen_carries_k0_kittel_validation_from_runtime_metadata
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner \
  k0_kittel_artifacts_reject_periodic_airbox_without_real_metrics
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner \
  eigen_artifacts_write_k0_kittel_summary_and_points
  1 passed

python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel'
  10 passed
```

This keeps `periodic_airbox_k0` available in the verifier schema and prevents
generic/synthetic paths from making a production claim. The narrow managed
PA-E4b CPU route now produces the required periodic-airbox metrics; broader
public/runtime exposure remains gated by the wider production and GPU criteria
below.

### 27.4. PA-E4b runtime artifact slot evidence - 2026-07-08

The runner now has an internal structured slot for future real K0-3
Poisson-airbox demag evidence:

```text
crates/fullmag-runner/src/eigen/types.rs
  K0KittelPeriodicAirboxDemagMetrics
  PathSolveResult.k0_kittel_periodic_airbox_demag
```

`validation/kittel_k0_pbc` artifacts can now accept
`demag_kind=periodic_airbox_k0` only when this structured metrics object is
present and validates:

```text
mesh_resolution_m > 0
airbox_size_m > 0
phi_dof_count > 0
augmented_phi_dof_count > phi_dof_count
poisson_constraint_relative_residual <= 1e-8
magnetic_pair_count > 0
airbox_pair_count > 0
effective_magnetisation_A_per_m > 0
effective_magnetisation_A_per_m matches the Kittel validation metadata
relative_kittel_frequency_error >= 0
```

When accepted, the artifact writer emits:

```text
validation/kittel_k0_pbc/summary.v1.json
validation/kittel_k0_pbc/points.v1.csv
validation/kittel_k0_pbc/convergence.v1.csv
```

Focused diagnostic verification:

```text
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner \
  k0_kittel_artifacts_reject_periodic_airbox_without_real_metrics
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner \
  k0_kittel_artifacts_accept_periodic_airbox_with_real_metrics
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner \
  eigen_artifacts_write_k0_kittel_summary_and_points
  1 passed

python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel'
  10 passed
```

Follow-up implementation status from 2026-07-09:

```text
The narrow managed K0-3 periodic-airbox CPU modal/eigen route now fills this
runtime/artifact seam from a real managed example:

just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-cpu
  passed

.fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts
  eigen/diagnostics/solver.v1.json:
    solver_model = k0_poisson_airbox_cpu_full_coupled_slepc
    solver_family = k0_poisson_airbox_full_coupled
    resolved_solver_family = k0_poisson_airbox_full_coupled
    solver_adapter = k0_poisson_airbox_cpu_full_coupled_slepc
    demag_kind = periodic_airbox_k0
    assembly_kind = synthetic_algebraic_oracle
    execution_lane = production_cpu
    production_solver_available = true
    production_periodic_airbox_claim = false
    poisson_constraint_relative_residual = 0
    relative_reference_frequency_error = 0
  eigen/metadata/eigen_summary.json:
    equilibrium_source.kind = relaxed_initial_state
    equilibrium_source.handoff = stage_continuation
  validation/kittel_k0_pbc/convergence.v1.csv:
    present with demag_kind=periodic_airbox_k0, phi_dof_count=28,
    poisson_residual_relative=0, relative_kittel_frequency_error=0
```

This closes the narrow PA-E4b CPU K0/Kittel periodic-airbox artifact path. It is
not a real shared-domain FEM assembly, not GPU PA-G, not nonzero-k Floquet
dynamic demag, and not broad production-v1 modal sweep coverage. Synthetic
PA-E4b evidence remains an algebraic oracle until `assembly_kind` is promoted
to `mfem_weak_form_shared_domain` and the capability matrix is updated in lockstep.

Follow-up convergence gate from 2026-07-09:

```text
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu
  passed

The target runs the same real managed FEM example twice, with separate artifact
roots:
  coarse: FULLMAG_K0_KITTEL_MAG_HMAX_NM=24
  fine:   FULLMAG_K0_KITTEL_MAG_HMAX_NM=20

scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py then requires:
  solver_model = k0_poisson_airbox_cpu_full_coupled_slepc
  resolved_solver_family = k0_poisson_airbox_full_coupled
  solver_adapter = k0_poisson_airbox_cpu_full_coupled_slepc
  demag_kind = periodic_airbox_k0
  execution_lane = production_cpu
  at least two distinct mesh_resolution_m values
  poisson_residual_relative <= 1e-8
  max_relative_frequency_error <= 5e-2

Observed in the managed run:
  sample_count = 2
  mesh_resolution_m = [2.0e-8, 2.4e-8]
  max_relative_error = 3.148738282545299e-11
  max_poisson_residual = 0
```

Follow-up provenance hardening from 2026-07-09:

```text
The K0-3 periodic-airbox artifact verifiers now reject bundles where
solver_adapter=k0_poisson_airbox_cpu_full_coupled_slepc is paired with a
reference solver_model. Both the single-run verifier and the convergence
verifier require:
  solver_model = k0_poisson_airbox_cpu_full_coupled_slepc
  resolved_solver_family = k0_poisson_airbox_full_coupled

The runner path-level diagnostics now emit these values for the PA-E4b CPU
route instead of preserving `reference_full_2x2_tangent` from the multi-k
PathSolveResult shell.

Verified:
  just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-cpu
  just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu
  python3 -m pytest scripts/test_frequency_domain_runtime_targets.py \
    scripts/test_verify_fem_frequency_domain_runtime_artifacts.py \
    scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -q
    396 passed
```

### 27.5. PA-E4b modal-eigen ABI payload evidence - 2026-07-08

The modal-eigen native ABI now has a Poisson-airbox full-coupled block payload
instead of only a direct C++ test entry point:

```text
FullmagFemModalEigenRequest:
  poisson_airbox_block_enabled
  poisson_airbox_q_dof_count
  poisson_airbox_phi_dof_count
  poisson_airbox_a_qq_csr
  poisson_airbox_a_qphi_csr
  poisson_airbox_a_phiq_csr
  poisson_airbox_a_phiphi_csr
  poisson_airbox_b_qq_csr
  poisson_airbox_phi_mean_weights
  poisson_airbox_phi_mean_weights_count
  poisson_airbox_target_frequency_hz
  poisson_airbox_expected_reference_frequency_hz
```

The Rust wrapper carries the same payload as
`NativeModalEigenPoissonAirboxBlockProblem`, maps it into the FFI request, and
all existing modal-eigen calls explicitly set the payload to `None`.

The C++ API bridge maps the ABI tail into `ModalEigenRequest`, and
`solve_modal_eigen_contract(...)` dispatches
`poisson_airbox_block_enabled != 0` to
`solve_poisson_airbox_modal_eigen_cpu_slepc(...)`.

Focused verification:

```text
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-fem-sys \
  modal_eigen_request_abi_exposes_poisson_airbox_tail_layout
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner \
  native_cpu_modal_window_accepts_explicit_gamma_single_k
  1 passed

just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
  passed after managed runtime rebuild

just verify-fem-frequency-domain-native-contract
  passed after managed runtime rebuild
```

`fem_modal_eigen_contract` now includes a public C ABI test proving that a
`FullmagFemModalEigenRequest` Poisson-airbox payload reaches the full-coupled
SLEPc adapter and emits `demag_kind=periodic_airbox_k0` with
`gauge_policy=mean_zero_augmented`. The PA-E2 result JSON now also carries
`q_dof_count`, `phi_dof_count`, `augmented_phi_dof_count`,
`poisson_constraint_relative_residual`, and
`relative_reference_frequency_error`, so the runner does not need to infer
Poisson-airbox metrics from the request payload.

Follow-up seam evidence:

```text
crates/fullmag-runner/src/fem_eigen.rs
  NativePoissonAirboxK0MetricsInput
  native_poisson_airbox_k0_metrics_from_result_json(...)

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner \
  native_poisson_airbox
  2 passed

just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
  passed after managed runtime rebuild

just verify-fem-frequency-domain-native-contract
  passed
```

The runner mapping accepts only
`solver_adapter=k0_poisson_airbox_cpu_full_coupled_slepc` and
`demag_kind=periodic_airbox_k0`, and it rejects generic modal/SLEPc JSON. This
is the tested bridge from PA-E2 native output to the
`K0KittelPeriodicAirboxDemagMetrics` artifact slot.

This still does not assemble the real small-film shared-domain matrices from
mesh/material state. The next production step is to build that matrix payload
from the FEM periodic-airbox model and feed the resulting PA-E2 metrics into
`PathSolveResult.k0_kittel_periodic_airbox_demag`.

Follow-up runner path evidence:

```text
crates/fullmag-runner/src/dispatch.rs
  eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts(...)
  eigen_path_periodic_airbox_k0_metrics_input_from_plan(...)
```

The multi-k eigen path now collects real PA-E2 `periodic_airbox_k0` metrics
from each native single-k solver artifact and stores the aggregated worst-case
Poisson residual / Kittel error in
`PathSolveResult.k0_kittel_periodic_airbox_demag`. It derives only structural
metadata already present in the FEM eigen plan: `hmax`, `air_box_config`,
periodic node pairs split by magnetic/airbox element markers, and declared
`effective_magnetisation`. Missing diagnostics, missing airbox metadata, zero
pair counts, or generic modal solver JSON still block the PA-E4b claim.

Focused verification:

```text
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner k0_kittel
  22 passed

python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel'
  included in the full verifier suite below

python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -q
  133 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner --lib
  466 passed
```

This now has a wired macrocell/Kittel PA-E4b payload for the native
Poisson-airbox adapter, and the payload requires real magnetic and airbox
periodic pair maps from the plan mesh plus positive airbox geometry metadata.
The narrow managed CPU K0/Kittel periodic-airbox route is implemented and
verified. The remaining production scope is broader validation and promotion:
accepted certificate consumption, larger shared-domain fixtures, GPU parity, and
nonzero-k Floquet dynamic-demag are still open.

---

## 28. GPU done definition

GPU Poisson-airbox modal eigensolve is production-ready only when:

```text
1. CPU PA-E1/PA-E2/PA-E3/PA-E4 are green;
2. GPU Poisson solve matches CPU phi and delta_H;
3. GPU Schur apply matches CPU Schur;
4. GPU shift-invert action matches CPU;
5. GPU lane reports device-resident buffers;
6. no per-iteration D2H/H2D in inner loop;
7. no silent fallback;
8. hidden gpu_operator_host_modal compatibility lane remains clearly labeled if used;
9. public UI/Python exposes GPU modal only after true runtime is implemented;
10. CPU/GPU Kittel K0-3 parity gate passes.
```

### 28.1. GPU gating evidence - 2026-07-09

The narrow no-demag GPU K0/Kittel modal slice remains executable through:

```text
just verify-fem-frequency-domain-eigen-k0-kittel-gpu-runtime
```

This is not a Poisson-airbox demag GPU implementation. It validates only the
`gpu_dense_k0_macrospin_modal_eigen` no-demag path and its GPU provenance.

For PA-G safety, forced GPU modal K0/Kittel with `periodic_airbox_k0` demag now
has an explicit negative managed gate:

```text
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-gpu-gated
```

That gate requires the run to fail with a diagnostic stating that GPU modal
K0/Kittel with demag is unavailable until Poisson-airbox GPU parity/runtime
passes and that CPU fallback is disabled. This protects Q24 and item 7 above:
strict periodic GPU demag remains gated and cannot silently report CPU work as a
GPU modal Poisson-airbox result. The gate also writes a machine-readable
unsupported-boundary artifact:

```text
.fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-gpu-gated/unsupported_boundary.v1.json
```

The same managed gate validates that artifact with:

```text
python3 scripts/verify_fem_gpu_modal_poisson_airbox_unsupported_boundary.py \
  .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-gpu-gated/unsupported_boundary.v1.json
```

Required fields:

```json
{
  "schema_version": "gpu_modal_poisson_airbox_unsupported_boundary.v1",
  "lane": "gpu_modal_poisson_airbox_k0",
  "case_id": "K0-3",
  "demag_kind": "periodic_airbox_k0",
  "requested_device": "gpu",
  "gpu_device_resident_modal_eigensolver": false,
  "cpu_fallback": "disabled",
  "status": "unsupported_until_pa_g_parity_runtime"
}
```

Verified on 2026-07-09:

```text
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-gpu-gated
  passed
  diagnostic contains:
    GPU modal K0/Kittel with demag
    CPU fallback
    disabled
  unsupported_boundary.v1.json contains:
    lane=gpu_modal_poisson_airbox_k0
    gpu_device_resident_modal_eigensolver=false
    cpu_fallback=disabled
```

Follow-up PA-G1 artifact-contract slice on 2026-07-09:

```text
scripts/verify_fem_gpu_poisson_parity_artifact.py
scripts/test_verify_fem_gpu_poisson_parity_artifact.py
```

This validator defines the machine-readable artifact contract required before a
future GPU Poisson parity implementation can be promoted:

```json
{
  "schema_version": "gpu_poisson_parity.v1",
  "lane": "gpu_poisson_airbox_k0",
  "execution_policy": "device",
  "memory_location": "device",
  "fallback_used": false,
  "gpu_poisson_parity": {
    "status": "passed",
    "max_relative_phi_error": "<= 1e-6",
    "max_relative_field_error": "<= 1e-6",
    "h2d_count": 0,
    "d2h_count": 0,
    "fallback_used": false
  }
}
```

Verified:

```text
python3 -m pytest scripts/test_verify_fem_gpu_poisson_parity_artifact.py -q
  4 passed
python3 -m py_compile scripts/verify_fem_gpu_poisson_parity_artifact.py scripts/test_verify_fem_gpu_poisson_parity_artifact.py
  passed
```

This is only the PA-G1 artifact/verifier contract. It does not claim that a
device-resident GPU Poisson parity runtime, GPU Schur parity, GPU shift-invert,
or true GPU modal eigensolver exists.

Follow-up PA-G1 runtime artifact evidence on 2026-07-09:

```text
just verify-fem-frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime
  passed with FULLMAG_FMR_RESPONSE_RTOL=1e-8

.fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_poisson_parity.v1.json:
  schema_version = gpu_poisson_parity.v1
  lane = gpu_poisson_airbox_k0
  execution_policy = device
  memory_location = device
  fallback_used = false
  gpu_poisson_parity.status = passed
  max_relative_phi_error = 5.353355861550261e-10
  max_relative_field_error = 5.112761456182738e-10
  h2d_count = 0
  d2h_count = 0
```

This promotes PA-G1 from verifier-only to a real managed runtime parity
artifact for the small periodic-airbox frequency-response fixture. It still
does not implement GPU Schur parity, GPU shift-invert, or a true GPU modal
Poisson-airbox eigensolver.

Follow-up PA-G2 runtime artifact evidence on 2026-07-09:

```text
The same managed target now also writes and verifies:

.fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_schur_apply_parity.v1.json:
  schema_version = gpu_schur_apply_parity.v1
  lane = gpu_poisson_airbox_k0
  execution_policy = device
  memory_location = device
  fallback_used = false
  gpu_schur_apply_parity.status = passed
  vector_set = deterministic_frequency_response_probe
  max_relative_schur_apply_error = 5.840773106872843e-11
  complex_operator_relative_l2_error = 5.840773106872843e-11
  real_stiffness_relative_l2_error = 4.37096199539583e-11
  imag_stiffness_relative_l2_error = 4.9811840538123526e-11
  real_mass_relative_l2_error = 0
  imag_mass_relative_l2_error = 0
  demag_tangent_relative_l2_error = 4.8057496817348875e-11
```

This closes a small PA-G2 Schur-apply parity artifact/runtime slice for the
frequency-response operator probe. It is not yet GPU shift-invert parity and
not a true GPU modal Poisson-airbox eigensolver.

Follow-up PA-G3a shifted linear-solve action parity evidence on 2026-07-09:

```text
The same managed target now also writes and verifies:

.fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_shifted_solve_action_parity.v1.json:
  schema_version = gpu_shifted_solve_action_parity.v1
  lane = gpu_poisson_airbox_k0
  execution_policy = device
  memory_location = device
  fallback_used = false
  gpu_shifted_solve_action_parity.status = passed
  operator_family = frequency_response_shifted_linear_solve
  rhs_family = dynamic_field_phasor
  full_modal_shift_invert_claim = false
  max_relative_action_error = 1.4213110688388042e-09
  magnetization_response_relative_l2_error = 5.013823814612709e-10
  component_amplitude_relative_l2_error = 1.837908524546982e-10
  component_phase_max_abs_error_rad = 1.4213110688388042e-09
```

Verified with:

```text
FULLMAG_FMR_RESPONSE_RTOL=1e-8 just verify-fem-frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime
python3 scripts/verify_fem_gpu_shifted_solve_action_parity_artifact.py \
  .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_shifted_solve_action_parity.v1.json
```

This closes a narrow PA-G3a shifted linear-solve action parity artifact/runtime
slice for the frequency-response operator. It deliberately sets
`full_modal_shift_invert_claim=false`: it is not yet the modal eigensolver
operation `(A - sigma B)^-1 Bv`, not GPU Krylov-Schur, and not a true GPU modal
Poisson-airbox eigensolver.

Follow-up PA-G3b CPU modal shift-invert action reference on 2026-07-09:

```text
backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp
backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp
backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
```

The CPU Poisson-airbox descriptor path now exposes and tests a direct reference
action for the actual modal operation:

```text
(A - sigma B)^-1 Bv
```

The implementation builds the full coupled augmented-gauge descriptor from the
existing PA-E2 CSR blocks, applies the complex shift to `B_qq`, solves the
small complex dense reference system, returns the `q` component, and reports:

```text
schema_version = poisson_airbox_modal_shift_invert_action.v1
operator_family = full_modal_shift_invert
algebraic_action = (A - sigma B)^-1 Bv
solver_adapter = k0_poisson_airbox_cpu_full_coupled_shift_invert_reference
full_modal_shift_invert_claim = true
shifted_system_relative_residual <= 1e-10 in the contract fixture
```

Verified with:

```text
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
```

This closes only the CPU reference half needed for PA-G3. It does not yet
compare CPU/GPU shift-invert actions, does not implement GPU Krylov-Schur, and
does not promote GPU modal Poisson-airbox eigensolve.

Follow-up PA-G3c true modal shift-invert parity artifact contract on
2026-07-09:

```text
scripts/verify_fem_gpu_modal_shift_invert_action_parity_artifact.py
scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py
```

This validator defines the artifact that will be required for true PA-G3:

```text
schema_version = gpu_modal_shift_invert_action_parity.v1
lane = gpu_poisson_airbox_k0
execution_policy = device
memory_location = device
fallback_used = false
operator_family = full_modal_shift_invert
algebraic_action = (A - sigma B)^-1 Bv
rhs_family = modal_mass_times_vector
cpu_reference_schema_version = poisson_airbox_modal_shift_invert_action.v1
gpu_action_schema_version = gpu_modal_shift_invert_action.v1
full_modal_shift_invert_claim = true
per_iteration_h2d_count = 0
per_iteration_d2h_count = 0
max_relative_action_error <= 1e-6
q_response_relative_l2_error <= 1e-6
shifted_system_relative_residual_cpu <= 1e-6
shifted_system_relative_residual_gpu <= 1e-6
```

The validator intentionally rejects PA-G3a/frequency-response proxy artifacts:

```text
operator_family = frequency_response_shifted_linear_solve
rhs_family = dynamic_field_phasor
full_modal_shift_invert_claim = false
```

Verified:

```text
python3 -m pytest scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py -q
  4 passed
python3 -m py_compile \
  scripts/verify_fem_gpu_modal_shift_invert_action_parity_artifact.py \
  scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py
  passed
```

This closes only the PA-G3 artifact contract. It does not produce the GPU
modal action yet and does not compare CPU/GPU true modal shift-invert output.

Follow-up PA-G3d CPU modal-contract shift-invert action artifact producer on
2026-07-09:

```text
backends/fem/include/frequency_domain/modal_eigen_request.hpp
backends/fem/src/frequency_domain/modal_eigen_solver.cpp
backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
```

The native modal contract now has an explicit Poisson-airbox action-producer
mode guarded by:

```text
poisson_airbox_shift_invert_action_enabled = 1
```

For the existing PA-E2 CSR full-coupled descriptor it calls the PA-G3b CPU
reference operation:

```text
(A - sigma B)^-1 Bv
```

and, when `write_partial_artifacts=1`, writes:

```text
<output_directory>/eigen/diagnostics/poisson_airbox_modal_shift_invert_action.v1.json
```

with:

```text
schema_version = poisson_airbox_modal_shift_invert_action.v1
operator_family = full_modal_shift_invert
algebraic_action = (A - sigma B)^-1 Bv
solver_adapter = k0_poisson_airbox_cpu_full_coupled_shift_invert_reference
full_modal_shift_invert_claim = true
```

Verified RED/GREEN with:

```text
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
```

The verified RED failure before implementation was:

```text
FAIL: PA-G3b modal contract result must point at the shift-invert action artifact
```

The GREEN run rebuilt the managed FEM runtime, rebuilt
`fem_poisson_airbox_modal_eigen_slepc_contract`, and exited with status 0.
Additional artifact verifier checks:

```text
python3 -m pytest \
  scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py \
  scripts/test_verify_fem_gpu_shifted_solve_action_parity_artifact.py \
  scripts/test_frequency_domain_runtime_targets.py -q
  69 passed

python3 -m py_compile \
  scripts/verify_fem_gpu_modal_shift_invert_action_parity_artifact.py \
  scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py

git diff --check
```

This closes a CPU modal-contract producer slice needed before the GPU action
producer. It still does not produce `gpu_modal_shift_invert_action.v1`, does
not compare CPU/GPU true modal shift-invert output, does not implement GPU
Krylov-Schur, and does not promote GPU modal Poisson-airbox eigensolve.

Follow-up PA-G3e public native seam for the CPU action producer on 2026-07-09:

```text
native/include/fullmag_fem.h
crates/fullmag-fem-sys/src/lib.rs
backends/fem/src/api.cpp
crates/fullmag-runner/src/native_fem/frequency_domain.rs
crates/fullmag-runner/src/fem_eigen.rs
backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp
```

The C ABI `FullmagFemModalEigenRequest` and Rust raw FFI
`FullmagFemModalEigenRequest` now expose the modal Poisson-airbox action tail:

```text
poisson_airbox_shift_invert_action_enabled
poisson_airbox_shift_sigma_real
poisson_airbox_shift_sigma_imag
poisson_airbox_shift_action_vector_real
poisson_airbox_shift_action_vector_imag
poisson_airbox_shift_action_vector_count
```

`fullmag_fem_modal_eigen_solve` maps those fields into the internal
`ModalEigenRequest`. The safe Rust wrapper exposes them as:

```text
NativeModalEigenPoissonAirboxBlockProblem::shift_invert_action
NativeModalEigenPoissonAirboxShiftInvertAction
```

The existing K0/Kittel production eigensolve payload keeps
`shift_invert_action=None`, so normal modal eigensolve behavior is unchanged.

Verified:

```text
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test \
  -p fullmag-fem-sys \
  modal_eigen_request_abi_exposes_poisson_airbox_tail_layout
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test \
  -p fullmag-runner k0_kittel --lib
  23 passed

docker compose --profile fem-gpu run --rm fem-gpu bash -lc \
  'cd /workspace && cmake --build native/build --target fem_modal_eigen_contract && \
   LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} \
   native/build/backends/fem/fem_modal_eigen_contract'
  passed

just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
  passed
```

Attempted broader gate:

```text
just verify-fem-frequency-domain-native-contract
```

It rebuilt the managed FEM runtime and built `fem_modal_eigen_contract`, but the
full sequence failed earlier in `fem_frequency_domain_contract` with:

```text
FAIL: production CPU MFEM demag callback is invoked for the linearity self-check and stiffness applications
```

That failure is in the driven-response MFEM demag callback invocation-count
test, not in the modal Poisson-airbox C ABI action path above.

Follow-up native-contract gate repair on 2026-07-09:

The failure above was caused by a stale driven-response test expectation. The
MFEM demag tangent linearity probe had been extended from four provider
applications to six provider applications:

```text
a, b, a+b, scale*a, repeat(a), zero-after-nonzero
```

but `frequency_domain_contract.cpp` still expected the old callback count and
the production CPU diagnostics path still emitted only the older additivity and
homogeneity fields. The test now expects:

```text
6 + 2 * (iteration_count + 1)
```

and the production CPU diagnostics path uses
`demag_tangent_linearity_diagnostics_json(...)`, so it publishes the extended
repeat and zero-after-nonzero diagnostics.

Verified:

```text
docker compose --profile fem-gpu run --rm fem-gpu bash -lc \
  'cd /workspace && cmake --build native/build --target fem_frequency_domain_contract && \
   LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} \
   native/build/backends/fem/fem_frequency_domain_contract'
  passed

just verify-fem-frequency-domain-native-contract
  passed
```

Follow-up PA-G3f GPU modal shift-invert action producer/parity on 2026-07-09:

```text
backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu
backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
justfile
scripts/verify_fem_gpu_modal_shift_invert_action_parity_artifact.py
```

The native GPU frequency-domain code now exposes a hidden/developer PA-G3f
action producer for the true modal operation:

```text
(A - sigma B)^-1 Bv
```

The contract test builds the same tiny full-coupled Poisson-airbox descriptor
used by the PA-E2 CPU/SLEPc contract, applies the CPU reference action, applies
the GPU action, compares `q`, and writes:

```text
.fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/
  eigen/diagnostics/poisson_airbox_modal_shift_invert_action.v1.json
  eigen/diagnostics/gpu_modal_shift_invert_action.v1.json
  gpu_modal_shift_invert_action_parity.v1.json
```

The GPU action artifact is deliberately not the PA-G3a frequency-response
proxy. It reports:

```text
schema_version = gpu_modal_shift_invert_action.v1
lane = gpu_poisson_airbox_k0
execution_policy = device
memory_location = device
operator_family = full_modal_shift_invert
algebraic_action = (A - sigma B)^-1 Bv
rhs_family = modal_mass_times_vector
full_modal_shift_invert_claim = true
frequency_response_proxy = false
per_iteration_h2d_count = 0
per_iteration_d2h_count = 0
```

Verified with:

```text
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
  passed

python3 -m pytest \
  scripts/test_frequency_domain_runtime_targets.py \
  scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py -q
  66 passed

git diff --check
  passed
```

Representative parity metrics from the managed artifact:

```text
max_relative_action_error = 7.727016304571709e-17
q_response_relative_l2_error = 7.727016304571709e-17
shifted_system_relative_residual_cpu = 6.674284868174013e-27
shifted_system_relative_residual_gpu = 4.5324665183683945e-17
```

This closes the PA-G3 true action-parity slice for the tiny contract
descriptor. It still does not implement GPU Krylov-Schur, a production
large-workload GPU modal eigensolver, or public GPU K0/Kittel demag execution.
The strict public GPU modal periodic-airbox gate must remain unsupported until
the later GPU-G4/G5 work is complete.

Follow-up PA-G3g modal-eigen ABI/contract seam for hidden GPU shift-invert
action on 2026-07-09:

```text
backends/fem/include/frequency_domain/modal_eigen_request.hpp
native/include/fullmag_fem.h
crates/fullmag-fem-sys/src/lib.rs
crates/fullmag-runner/src/native_fem/frequency_domain.rs
backends/fem/src/api.cpp
backends/fem/src/frequency_domain/modal_eigen_solver.cpp
backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp
```

The hidden PA-G3f GPU action is now reachable through the modal-eigen
contract/ABI, not only through a direct native test symbol. The C ABI request
tail includes:

```text
poisson_airbox_shift_invert_action_enabled
poisson_airbox_shift_invert_action_device  # 0 = CPU reference, 1 = hidden GPU action
poisson_airbox_shift_sigma_real
poisson_airbox_shift_sigma_imag
poisson_airbox_shift_action_vector_real
poisson_airbox_shift_action_vector_imag
poisson_airbox_shift_action_vector_count
```

The new modal C ABI contract test requests device `1`, writes
`eigen/diagnostics/gpu_modal_shift_invert_action.v1.json`, and requires:

```text
solver_adapter = gpu_device_dense_modal_shift_invert_action_contract
operator_family = full_modal_shift_invert
algebraic_action = (A - sigma B)^-1 Bv
rhs_family = modal_mass_times_vector
frequency_response_proxy = false
gpu_device_resident_modal_eigensolver = false
```

Verified after the ABI seam landed:

```text
just verify-fem-frequency-domain-native-contract
  passed

just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
  passed

python3 -m pytest \
  scripts/test_frequency_domain_runtime_targets.py \
  scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py -q
  66 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-fem-sys \
  modal_eigen_request_abi_exposes_poisson_airbox_tail_layout
  1 passed

git diff --check
  passed
```

This closes the PA-G3g contract seam only. It deliberately keeps
`gpu_device_resident_modal_eigensolver=false`; the next production gap is still
the real GPU eigensolver loop over this action, not another proxy result.

Follow-up GPU-G4 hidden compatibility provenance on 2026-07-09:

The PA-G3f/PA-G3g GPU action now carries the GPU-G4 hidden compatibility lane
label in both the modal C ABI result and the generated GPU action artifact:

```text
execution_lane = gpu_operator_host_modal_eigen_compatibility
solver_adapter = gpu_device_dense_modal_shift_invert_action_contract
operator_family = full_modal_shift_invert
algebraic_action = (A - sigma B)^-1 Bv
rhs_family = modal_mass_times_vector
frequency_response_proxy = false
gpu_device_resident_modal_eigensolver = false
```

The RED test failed before the provenance patch with:

```text
FAIL: modal C ABI GPU action result must identify the hidden GPU-G4 compatibility lane
```

Verified after the patch:

```text
focused container modal contract
  docker compose --profile fem-gpu run --rm fem-gpu bash -lc \
    'cd /workspace && cmake --build native/build --target fem_modal_eigen_contract && \
     LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} \
     native/build/backends/fem/fem_modal_eigen_contract'
  passed

just verify-fem-frequency-domain-native-contract
  passed

just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
  passed

python3 -m pytest \
  scripts/test_frequency_domain_runtime_targets.py \
  scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py -q
  66 passed

git diff --check
  passed
```

This is still a hidden/developer compatibility lane. It is intentionally not
public production GPU modal eigensolve and still does not close GPU-G5.

Follow-up GPU-G5a tiny dense device modal eigensolver contract on 2026-07-09:

The first GPU-G5 slice now solves the tiny full-coupled Poisson-airbox modal
pencil with a CUDA dense inverse-iteration loop. This is no longer only a
single shift-invert action: the kernel iterates on device, computes the
generalized Rayleigh quotient, emits an eigenfrequency, and reports the full
descriptor residual. It is still intentionally a tiny dense contract, not a
production sparse/Krylov-Schur modal eigensolver for large meshes.

Current GPU-G5a evidence:

```text
files:
  backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu
  backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
  justfile
  scripts/test_frequency_domain_runtime_targets.py
  scripts/verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py
  scripts/test_verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py

artifact:
  .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/
    eigen/diagnostics/gpu_modal_poisson_airbox_eigensolver.v1.json

artifact metrics:
  eigen_frequency_hz = 2011901211.0259216
  relative_reference_frequency_error = 1.1850411829116929e-16
  full_descriptor_relative_residual = 3.735334638019538e-15

required provenance:
  schema_version: gpu_modal_poisson_airbox_eigensolver.v1
  execution_lane: gpu_device_modal_eigen_dense_contract
  solver_adapter: gpu_dense_poisson_airbox_modal_eigen_contract
  solver_library: cuda_dense_inverse_iteration
  frequency_response_proxy: false
  gpu_device_resident_modal_eigensolver: true
  cpu_fallback: disabled
  fallback_used: false
  per_iteration_h2d_count: 0
  per_iteration_d2h_count: 0
```

The RED link failure before the implementation was:

```text
undefined reference to fullmag_fem_frequency_domain_solve_modal_poisson_airbox_gpu_dense_eigensolver
```

Verified after the patch:

```text
focused container fem_poisson_airbox_modal_eigen_slepc_contract
  passed

just verify-fem-frequency-domain-native-contract
  passed

just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
  passed, including semantic validation of gpu_modal_poisson_airbox_eigensolver.v1.json

python3 -m pytest \
  scripts/test_verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py \
  scripts/test_frequency_domain_runtime_targets.py -q
  68 passed

python3 -m pytest \
  scripts/test_frequency_domain_runtime_targets.py \
  scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py -q
  66 passed

git diff --check
  passed
```

This closes only GPU-G5a. The remaining GPU-G5 production work is a sparse or
matrix-free device modal eigensolver path suitable for real meshes, with public
planner/runtime selection only after its provenance and validation gates pass.

Follow-up GPU-G5b CSR device modal descriptor apply foundation on 2026-07-09:

The modal Poisson-airbox GPU path now has a device CSR apply for the
full-coupled descriptor operator `A*x` on the augmented vector `[q, phi, eta]`.
This is the first sparse/matrix-free foundation needed by a production GPU
modal eigensolver. It is deliberately not a sparse shift-invert solve and not
yet a Krylov-Schur eigensolver.

Current GPU-G5b evidence:

```text
files:
  backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu
  backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
  justfile
  scripts/test_frequency_domain_runtime_targets.py
  scripts/verify_fem_gpu_modal_poisson_airbox_descriptor_apply_artifact.py
  scripts/test_verify_fem_gpu_modal_poisson_airbox_descriptor_apply_artifact.py

artifact:
  .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/
    eigen/diagnostics/gpu_modal_poisson_airbox_descriptor_apply.v1.json

artifact metrics:
  input_l2_norm = 1.5970676253684437
  output_l2_norm = 14250292096.377323

required provenance:
  schema_version: gpu_modal_poisson_airbox_descriptor_apply.v1
  execution_lane: gpu_device_modal_descriptor_apply_contract
  solver_family: modal_eigen
  operator_family: full_coupled_poisson_airbox_modal_pencil
  algebraic_action: A*x
  matrix_format: csr_device_apply
  frequency_response_proxy: false
  gpu_device_resident_operator_apply: true
  cpu_fallback: disabled
  fallback_used: false
  per_iteration_h2d_count: 0
  per_iteration_d2h_count: 0
```

The RED link failure before the implementation was:

```text
undefined reference to fullmag_fem_frequency_domain_apply_modal_poisson_airbox_gpu_descriptor
```

Verified after the patch:

```text
focused container fem_poisson_airbox_modal_eigen_slepc_contract
  passed

just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
  passed, including semantic validation of gpu_modal_poisson_airbox_descriptor_apply.v1.json

python3 -m pytest \
  scripts/test_verify_fem_gpu_modal_poisson_airbox_descriptor_apply_artifact.py \
  scripts/test_frequency_domain_runtime_targets.py -q
  68 passed
```

This closes only GPU-G5b as an operator-apply foundation. Remaining production
GPU modal work still requires a device sparse shifted solve and eigen iteration
over this descriptor path.

---

## 29. Common failure modes and exact diagnosis

| Symptom | Likely cause | Required diagnostic |
|---|---|---|
| eigenfrequency off by `2*pi` | Hz/rad/s confusion | compare `omega_rad_s` and `frequency_hz` formula |
| eigenfrequency off by `mu0` | A/m vs Tesla confusion | output `H0_A_per_m`, `mu0_H0_T`, `gamma0`, `gamma_bar` |
| no positive branch | sign of `A_qq` or B convention | positive-frequency branch test |
| full residual large but Schur residual small | reconstruction or gauge error | full descriptor residual breakdown |
| Poisson residual large | wrong `A_phiq` sign/shape or gauge | `poisson_constraint_relative_residual` |
| Kittel demag term wrong | wrong feedback sign or demag-factor assumption | sign-flip negative test plus K0-3 convergence |
| GPU parity fails only on periodic | missing airbox pair map / seam constraint | periodic certificate and `delta_phi` seam diagnostics |
| Schur MatShell converges but full system fails | Schur certificate incomplete | full-vs-reduced residual reconstruction |
| Codex extends public ABI in PA-E1 | scope violation | reject patch; use internal descriptor only |

---

## 30. Final implementation instruction for Codex

Start with exactly this patch stack:

```text
Patch 18A-doc-clean:
  rename typo path;
  add physics pointers;
  no code.

Patch PA-E1a-header-red-tests:
  add dense oracle header;
  add RED tests;
  no solver logic.

Patch PA-E1b-linalg-gauge-schur:
  implement dense linalg, mean-zero gauge, Schur apply, explicit Schur.

Patch PA-E1c-eigen-residual-json:
  implement 2x2 positive branch, full residual reconstruction, diagnostics JSON.

Patch PA-E1d-just-doc-status:
  add just gate;
  update patch queue with command output.
```

Do not combine PA-E1 with:

```text
PA-E2 sparse SLEPc
PA-E3 Schur MatShell
PA-E4 Kittel demag FEM
GPU parity/runtime
public ABI change
Python DSL demag knob
```

This is the shortest path to a correct production foundation.

---

# Appendix A — exact artifact examples

## A.1. PA-E1 oracle diagnostics success

```json
{
  "schema_version": "poisson_airbox_eigen_oracle.v1",
  "status": "passed",
  "study_product": "modal_eigen",
  "test_id": "pa_e1_dense_poisson_airbox_eigen_oracle",
  "scope": "synthetic_dense_algebraic_oracle",
  "phasor_convention": "exp_plus_i_omega_t",
  "eigenvalue_convention": "lambda_imag_positive_frequency",
  "demag_kind": "synthetic_poisson_airbox_k0",
  "gauge_policy": "mean_zero_augmented",
  "alpha": 0.0,
  "k_vector_rad_per_m": [0.0, 0.0, 0.0],
  "q_dof_count": 2,
  "phi_dof_count": 2,
  "augmented_phi_dof_count": 3,
  "metrics": {
    "schur_apply_relative_error": 2.1e-16,
    "full_residual_reconstruction_relative_error": 3.4e-16,
    "poisson_constraint_relative_residual": 1.2e-16,
    "gauge_mean_abs": 0.0,
    "eigen_residual_relative": 4.0e-16,
    "relative_frequency_error": 1.0e-15
  },
  "eigenpair": {
    "eigenvalue_real": 0.0,
    "eigenvalue_imag": 12566370614.359172,
    "omega_rad_s": 12566370614.359172,
    "frequency_hz": 2000000000.0,
    "positive_frequency_branch_found": true
  },
  "certification": {
    "schur_certified": true,
    "full_residual_certified": true,
    "production_periodic_airbox_claim": false
  }
}
```

## A.2. PA-E1 validation error example

```json
{
  "schema_version": "poisson_airbox_eigen_oracle.v1",
  "status": "validation_error",
  "reason": "poisson_airbox_eigen_requires_mean_zero_gauge",
  "message": "PA-E1 dense Poisson-airbox eigen oracle requires gauge_policy=mean_zero_augmented"
}
```

---

# Appendix B — exact negative test specification

```text
Given:
  A_qq, B_qq, A_qphi, A_phiq, P, c

Correct:
  P phi = C q
  A_phiq = -C
  S = A_qq + A_qphi phi(q)

Negative mutation:
  A_phiq_mut = +C

Expected:
  frequency error exceeds threshold or full residual reconstruction fails.
```

The test must include expected physical frequency so a double sign flip cannot accidentally pass.

---

# Appendix C — scope wall for future implementers

If you are implementing PA-E1 and need any of the following, stop and split the patch:

```text
ModalEigenRequest public field additions
Rust FFI struct layout changes
Python DSL demag_kind addition
MFEM mesh extraction
PETSc/SLEPc runtime changes
GPU kernels
HYPRE configuration
periodic mesh certificate ingestion
Kittel K0-3 real FEM fixture
```

PA-E1 is synthetic dense algebra only. That is intentional.


---

# Appendix D — implementation work breakdown with review owners

| Work item | Patch | Owner role | Review focus |
|---|---|---|---|
| canonical file rename | 18A-doc-clean | docs | no duplicate active docs |
| physics docs pointers | 18A-doc-clean | docs/physics | no duplicated stale spec |
| dense oracle header | PA-E1a | native C++ | internal-only, no ABI bump |
| validation RED tests | PA-E1a | native tests | tests fail for missing impl |
| dense linalg | PA-E1b | native C++ | pivoting, finite checks, shape checks |
| mean-zero gauge | PA-E1b | native C++ | no pin-first in production path |
| Schur apply | PA-E1b | native C++ | signs, dimensions |
| full residual | PA-E1c | native C++ | descriptor residual scaling |
| positive branch | PA-E1c | modal/eigen | imag(lambda)>0 convention |
| diagnostics JSON | PA-E1c | artifacts | schema parses, no false production claim |
| just target | PA-E1d | build/CI | deterministic and small |
| patch queue update | PA-E1d | docs | command output recorded |

---

# Appendix E — exact PA-E1 pseudocode

```cpp
FrequencyDomainStatus solve_dense_poisson_airbox_eigen_oracle(
    const DensePoissonAirboxEigenOracleProblem& p,
    DensePoissonAirboxEigenOracleResult* r) noexcept
{
    zero_result(r);
    VALIDATE(p, r);

    auto Aqq = make_complex_from_real(p.A_qq);
    auto Aqphi = make_complex_from_real(p.A_qphi);
    auto Aphiq = make_complex_from_real(p.A_phiq);
    auto P = make_complex_from_real(p.A_phiphi);
    auto Bqq = make_complex_from_real(p.B_qq);
    auto Paug = build_mean_zero_augmented_poisson(P, p.phi_mean_weights, p.phi_dof_count);

    auto qtest = load_q_or_default(p.test_q, p.q_dof_count);
    auto y_apply = apply_schur(Aqq, Aqphi, Paug, Aphiq, qtest, r->error_message);
    auto S = build_explicit_schur_by_columns(Aqq, Aqphi, Paug, Aphiq, r->error_message);
    auto y_explicit = matvec(S, qtest);
    r->schur_apply_relative_error = relative_error(y_apply, y_explicit);

    auto eigen = solve_tiny_positive_frequency_eigen(S, Bqq, p);
    if (!eigen.ok) return fail(...);

    std::vector<Complex> phi;
    Complex eta;
    solve_phi_for_q(Paug, Aphiq, eigen.q, phi, eta, r->error_message);
    auto full = compute_full_descriptor_residual(Aqq, Aqphi, Aphiq, P, Bqq,
                                                 p.phi_mean_weights,
                                                 eigen.lambda,
                                                 eigen.q, phi, eta);
    r->full_residual_reconstruction_relative_error = full.relative_full;
    r->poisson_constraint_relative_residual = full.relative_phi;
    r->gauge_mean_abs = full.gauge_abs;

    r->eigenvalue_real = eigen.lambda.real();
    r->eigenvalue_imag = eigen.lambda.imag();
    r->omega_rad_s = eigen.lambda.imag();
    r->frequency_hz = eigen.lambda.imag() / (2.0 * pi);
    r->relative_frequency_error = compare_expected_if_present(p, r->frequency_hz);

    r->schur_certified = r->schur_apply_relative_error <= p.relative_tolerance;
    r->full_residual_certified = r->full_residual_reconstruction_relative_error <= p.relative_tolerance;
    r->positive_frequency_branch_found = true;

    write_diagnostics_json(p, *r);

    return all_required_metrics_pass(*r, p) ? FrequencyDomainStatus::ok
                                           : FrequencyDomainStatus::solve_error;
}
```

---

# Appendix F — reviewer checklist for mathematical signs

The reviewer must inspect these identities in code:

```text
1. Poisson row is P phi - C q = 0.
2. A_phiq stores -C.
3. solve_phi_for_q solves P phi + c eta = -A_phiq q.
4. apply_schur computes A_qq q + A_qphi phi.
5. full residual computes A_phiq q + P phi + c eta.
6. eigen residual computes S q - lambda B q.
7. frequency_hz = imag(lambda)/(2*pi).
```

Any implementation with a different convention must rename its fields or add an explicit adapter and tests. Silent sign changes are forbidden.

---

# Appendix G — exact staged `just` targets

```make
verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle:
	just ensure-managed-fem-runtime
	docker compose --profile fem-gpu run --rm \
	  fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_poisson_airbox_eigen_oracle_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:$${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_poisson_airbox_eigen_oracle_contract'

verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc:
	just ensure-managed-fem-runtime
	docker compose --profile fem-gpu run --rm \
	  fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_poisson_airbox_modal_eigen_slepc_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:$${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_poisson_airbox_modal_eigen_slepc_contract'

verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell:
	just ensure-managed-fem-runtime
	docker compose --profile fem-gpu run --rm \
	  fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_poisson_airbox_schur_matshell_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:$${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_poisson_airbox_schur_matshell_contract'

verify-fem-frequency-domain-eigen-k0-kittel-demag-cpu:
	@echo "[PA-E4] Kittel K0-3 thin-film demag CPU gate"
	python3 examples/fem_eigen_k0_kittel_thinfilm_demag.py
	python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py \
	  --require-k0-kittel-field-sweep \
	  --require-k0-kittel-demag \
	  .fullmag/reports/frequency-domain-eigen-k0-kittel-demag/artifacts

verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-gpu-gated:
	just ensure-managed-fem-runtime
	# Run examples/fem_eigen_k0_kittel_periodic_airbox_gpu_gated.py and
	# require a nonzero exit with "GPU modal K0/Kittel with demag",
	# "CPU fallback", and "disabled" in the combined log.

verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu:
	just ensure-managed-fem-runtime
	# Run examples/fem_eigen_k0_kittel_periodic_airbox.py twice under the
	# managed FEM container with coarse/fine mesh sizing env vars, verify each
	# artifact root with --require-k0-kittel-periodic-airbox-demag, then run
	# scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py across both
	# roots.
```

Do not add the later targets to default CI until each is deterministic.

---

# Appendix H — migration table for future public ABI changes

| Future public concept | Internal PA-E1/PA-E2 source | First public patch allowed | ABI bump? |
|---|---|---:|---:|
| modal demag kind | `PoissonAirboxEigenBlockProblem.demag_kind` | after PA-E2 + PA-E4 | yes, if C ABI field |
| periodic airbox pair hashes | mesh certificate artifact | after native runtime consumes certificate | maybe JSON-only first |
| full-coupled modal backend selector | `solver_adapter` JSON | after PA-E2 | no if JSON-only |
| Schur modal selector | Schur certificate state | after PA-E3 | maybe if public request option |
| GPU modal selector | GPU parity status | after G3/G5 | yes if public enum changes |
| Kittel demag validation | K0-3 metadata | after PA-E4 | Python/Rust API change |

---

# Appendix I — final warning

The most dangerous false success is:

```text
A synthetic or host-only path emits demag_kind=periodic_airbox_k0 and production_gpu/gpu_device labels even though it did not consume real periodic airbox pair maps, did not solve real Poisson, and did not keep eigen/Krylov state on device.
```

The artifact schema must make that impossible.
