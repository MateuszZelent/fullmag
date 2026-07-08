# S4: Native GPU FEM Backend — MFEM + libCEED + hypre

- Etap: **S4** (po S1, S3)
- Priorytet: **HIGH** — główny cel planu FEM
- Docelowy katalog: `native/backends/fem/`
- Powiązane fizyka: `docs/physics/0410`, `0430`, `0490`

## Status na 2026-03-24

- `S4.0 scaffold` jest już w repo:
  - `native/include/fullmag_fem.h`
  - `native/backends/fem/` jako kompilowalny target `fullmag_fem`
  - `crates/fullmag-fem-sys`
  - `fullmag-runner` z `FULLMAG_FEM_EXECUTION=cpu|auto|gpu`
- `S4.1 data-path scaffold` też jest już zrobiony:
  - `fullmag_fem_backend_create(...)` waliduje plan i kopiuje mesh + `m0` do natywnego `FemContext`
  - `fullmag_fem_backend_copy_field_f64(...)` działa dla `m`, `H_ex`, `H_demag`, `H_ext`, `H_eff`
  - `fullmag_fem_backend_get_device_info(...)` zwraca prawdziwe metadata backendu/scaffoldu
  - Rust ma testy `NativeFemBackend` potwierdzające create/copy/device-info seam
- `S4.2 MFEM import seam` jest przygotowany:
  - `native/backends/fem/CMakeLists.txt` umie wejść w `find_package(MFEM CONFIG REQUIRED)` przy `FULLMAG_USE_MFEM_STACK=ON`
  - przy takim buildzie `create(...)` próbuje zbudować `mfem::Mesh`, `H1_FECollection` i `FiniteElementSpace`
  - to nadal nie uruchamia jeszcze operatorów exchange/demag, ale zamyka pierwszy realny krok `MeshIR -> native MFEM objects`
- `S4.3 exchange-operator seam` jest przygotowany:
  - backend utrzymuje komponentowe bufory `m_x/m_y/m_z` i `GridFunction` dla magnetyzacji
  - składany jest pierwszy assembled exchange path `DiffusionIntegrator + MassIntegrator`
  - przy buildzie z MFEM `create(...)` próbuje policzyć początkowe `H_ex` i `H_eff`
  - obecne ograniczenie: tylko siatka jednorodnie magnetyczna; multi-region / selective magnetic mask w native MFEM nie są jeszcze podpięte
- `S4.4 native step` jest już rozpisany w kodzie:
  - przy buildzie z MFEM `fullmag_fem_backend_step(...)` wykonuje Heun dla `exchange`, `Demag` i `H_ext`
  - `Demag` jest realizowane przez **mesh-native Poisson-airbox FEM demag**
    (`FEM shared-domain mesh with air -> scalar potential solve -> sampled H_demag at FEM nodes`)
  - liczone są: `H_ex`, `H_demag`, `H_eff`, `E_ex`, `E_demag`, `E_ext`, `E_total`, `max|H_eff|`, `max|H_demag|`, `max|dm/dt|`
  - nadal brak: pełne libCEED partial assembly, GPU parity gate i kompletne walidacje multi-region
- `S4.5 guarded parity harness` jest już dopięty:
  - `crates/fullmag-runner/src/native_fem.rs` ma test porównujący `native FEM exchange-only` z `CPU reference FEM`
  - test uruchamia się tylko wtedy, gdy natywny backend został zbudowany z MFEM; na hostach bez MFEM kończy się uczciwym `skip`
  - build natywnego FEM można teraz przełączyć przez `FULLMAG_USE_MFEM_STACK=ON`
- Bez MFEM ten backend nadal uczciwie zwraca `unavailable`, a `auto` spada do CPU reference.
- Od tego miejsca kolejne prace w S4 mają iść już przez istniejący ABI/FFI/dispatch seam, a nie przez dalsze planowanie „na sucho”.

### Build notes

- Host bez MFEM:
  - `cargo +nightly test -p fullmag-runner --features fem-gpu native_fem`
  - backend buduje scaffold i parity test kończy się `skip`
- Host z MFEM:
  - `FULLMAG_USE_MFEM_STACK=ON cargo +nightly test -p fullmag-runner --features fem-gpu native_fem -- --nocapture`
  - jeśli MFEM jest instalowane poza standardowym prefixem, ustaw `CMAKE_PREFIX_PATH`
- Repo-level container path:
  - `make fem-gpu-build`
  - `make fem-gpu-check`
  - `make fem-gpu-test`
  - `docker/fem-gpu/Dockerfile` jest teraz kanonicznym obrazem dev/test dla docelowego stacku `MFEM + libCEED + hypre + CUDA`

---

## 1. Cele etapu

1. **C++/CUDA backend** realizujący te same oddziaływania co CPU reference (Exchange + Demag + Zeeman + LLG Heun).
2. **Architektura MFEM + libCEED**: matrix-free operators z GPU partial assembly dla exchange, klasyczny CG+AMG (hypre) dla demag Poisson.
3. **C ABI interface** (`fullmag_fem.h`) analogiczny do `fullmag_fdm.h` — łącznik Rust↔C++.
4. **Rust FFI crate** `fullmag-fem-sys` — binduje C ABI, dispatch z runnera.
5. **Parity z CPU reference** < 0.1% relative error.

---

## 2. Architektura stosu

```
┌────────────────────────────────────────────────────────────┐
│  Rust Runner (fullmag-runner)                              │
│    ↓ FFI via fullmag-fem-sys                               │
├────────────────────────────────────────────────────────────┤
│  fullmag_fem.h — C ABI                                    │
│    fullmag_fem_backend_create(desc) → handle               │
│    fullmag_fem_backend_step(handle) → stats                │
│    fullmag_fem_backend_copy_field(handle, buf)             │
│    fullmag_fem_backend_destroy(handle)                     │
├────────────────────────────────────────────────────────────┤
│  api.cpp — dispatch layer                                  │
│    owns FemContext, translates C ABI to C++ calls           │
├──────────────────────┬─────────────────────────────────────┤
│  FemContext          │                                      │
│  ├── mfem::Mesh      │  Mesh management                    │
│  ├── mfem::H1_FECollection │  FE space P1                 │
│  ├── mfem::FiniteElementSpace │  DOF layout                │
│  ├── ExchangeOperator│  libCEED partial assembly            │
│  ├── DemagSolver     │  hypre CG + AMG                      │
│  ├── ZeemanOperator  │  Trivial uniform field               │
│  ├── LLGHeunIntegrator │  Time stepping                     │
│  └── DeviceVector[mx,my,mz,hx,hy,hz] │  GPU memory        │
├──────────────────────┴─────────────────────────────────────┤
│  MFEM 4.7        │  libCEED 0.12     │  hypre 2.30         │
│  ├── Mesh        │  ├── CeedOperator │  ├── HYPRE_PCG       │
│  ├── GridFunction│  ├── CeedQFunction│  ├── HYPRE_BoomerAMG │
│  ├── BilinearForm│  ├── CeedBasis    │  └── HYPRE_ParCSR    │
│  └── LinearForm  │  └── CeedElemRestr│                      │
├──────────────────┴────────────────────┴─────────────────────┤
│  CUDA 11.8+: cuSPARSE, cuSOLVER, thrust                   │
└────────────────────────────────────────────────────────────┘
```

---

## 3. C ABI — `fullmag_fem.h`

```c
/* native/include/fullmag_fem.h */

#ifndef FULLMAG_FEM_H
#define FULLMAG_FEM_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---------- Enums ---------- */

typedef enum {
    FULLMAG_FEM_PRECISION_F32 = 0,
    FULLMAG_FEM_PRECISION_F64 = 1,
} fullmag_fem_precision;

typedef enum {
    FULLMAG_FEM_INTEGRATOR_HEUN = 0,
    FULLMAG_FEM_INTEGRATOR_SSPRK3 = 1,
    FULLMAG_FEM_INTEGRATOR_RK4 = 2,
    FULLMAG_FEM_INTEGRATOR_DOPRI54 = 3,
} fullmag_fem_integrator;

typedef enum {
    FULLMAG_FEM_OBSERVABLE_MX = 0,
    FULLMAG_FEM_OBSERVABLE_MY = 1,
    FULLMAG_FEM_OBSERVABLE_MZ = 2,
    FULLMAG_FEM_OBSERVABLE_HX = 3,
    FULLMAG_FEM_OBSERVABLE_HY = 4,
    FULLMAG_FEM_OBSERVABLE_HZ = 5,
} fullmag_fem_observable;

typedef enum {
    FULLMAG_FEM_SOLVER_CG = 0,
    FULLMAG_FEM_SOLVER_GMRES = 1,
} fullmag_fem_linear_solver;

typedef enum {
    FULLMAG_FEM_PRECOND_NONE = 0,
    FULLMAG_FEM_PRECOND_JACOBI = 1,
    FULLMAG_FEM_PRECOND_AMG = 2,
} fullmag_fem_preconditioner;

/* ---------- Mesh descriptor ---------- */

typedef struct {
    /* Node coordinates (n_nodes × 3), row-major, meters. */
    const double* nodes;
    uint32_t n_nodes;

    /* Tetrahedral connectivity (n_elements × 4), 0-based. */
    const uint32_t* elements;
    uint32_t n_elements;

    /* Per-element material marker. */
    const uint32_t* element_markers;

    /* Boundary face connectivity (n_boundary_faces × 3), 0-based. */
    const uint32_t* boundary_faces;
    uint32_t n_boundary_faces;

    /* Per-face boundary marker. */
    const uint32_t* boundary_markers;

    /* Node boundary markers (0=interior, 1=boundary). */
    const uint8_t* node_markers;
} fullmag_fem_mesh_desc;

/* ---------- Material descriptor ---------- */

typedef struct {
    double ms;           /* Saturation magnetisation [A/m] */
    double a_exchange;   /* Exchange stiffness [J/m] */
    double alpha;        /* Gilbert damping */
    double gamma;        /* Gyromagnetic ratio [rad/(s·T)] */
} fullmag_fem_material_desc;

/* ---------- Solver config ---------- */

typedef struct {
    fullmag_fem_linear_solver solver;
    fullmag_fem_preconditioner preconditioner;
    double rtol;
    uint32_t max_iter;
} fullmag_fem_solver_config;

/* ---------- Plan descriptor ---------- */

typedef struct {
    fullmag_fem_mesh_desc mesh;
    fullmag_fem_material_desc material;

    uint32_t fe_order;                /* Polynomial order (1, 2, ...) */
    fullmag_fem_precision precision;
    fullmag_fem_integrator integrator;

    /* Enabled interactions */
    int enable_exchange;
    int enable_demag;

    /* External field [A/m] */
    double external_field[3];

    /* Demag solver config */
    fullmag_fem_solver_config demag_solver;

    /* Air-box factor (0 = no air box) */
    double air_box_factor;

    /* Initial magnetisation per node: [mx0,my0,mz0, mx1,my1,mz1, ...] */
    const double* initial_magnetization;

    /* Time step [s] */
    double dt;
} fullmag_fem_plan_desc;

/* ---------- Step statistics ---------- */

typedef struct {
    uint64_t step;
    double time;
    double energy_exchange;
    double energy_demag;
    double energy_zeeman;
    double avg_mx, avg_my, avg_mz;
    double max_torque;
    uint32_t demag_cg_iterations;
    double demag_cg_residual;
} fullmag_fem_step_stats;

/* ---------- Device info ---------- */

typedef struct {
    char device_name[256];
    uint64_t total_memory;
    uint64_t free_memory;
    int cuda_device_id;
    int compute_capability_major;
    int compute_capability_minor;
} fullmag_fem_device_info;

/* ---------- Opaque handle ---------- */

typedef struct fullmag_fem_backend* fullmag_fem_handle;

/* ---------- API functions ---------- */

/**
 * Create FEM backend from plan descriptor.
 * Returns NULL on failure (check fullmag_fem_last_error).
 */
fullmag_fem_handle fullmag_fem_backend_create(
    const fullmag_fem_plan_desc* desc
);

/**
 * Perform one LLG time step.
 * Returns 0 on success, non-zero on error.
 */
int fullmag_fem_backend_step(
    fullmag_fem_handle handle,
    fullmag_fem_step_stats* stats
);

/**
 * Copy field data from GPU to host buffer.
 * Buffer must have at least n_nodes doubles.
 */
int fullmag_fem_backend_copy_field_f64(
    fullmag_fem_handle handle,
    fullmag_fem_observable observable,
    double* buffer,
    size_t buffer_len
);

/**
 * Get device information.
 */
int fullmag_fem_backend_get_device_info(
    fullmag_fem_handle handle,
    fullmag_fem_device_info* info
);

/**
 * Get last error message (thread-local).
 */
const char* fullmag_fem_last_error(void);

/**
 * Destroy backend and free all resources.
 */
void fullmag_fem_backend_destroy(fullmag_fem_handle handle);

#ifdef __cplusplus
}
#endif

#endif /* FULLMAG_FEM_H */
```

---

## 4. C++ Implementation Structure

### 4.1 Katalog

```
native/backends/fem/
├── CMakeLists.txt
├── include/
│   ├── context.hpp           # FemContext class
│   ├── exchange_operator.hpp # Exchange via libCEED
│   ├── demag_solver.hpp      # Demag Poisson via hypre
│   ├── llg_integrator.hpp    # Heun stepper on GPU
│   └── device_vectors.hpp    # Managed GPU vector wrapper
├── src/
│   ├── api.cpp               # C ABI implementation
│   ├── context.cpp           # FemContext: init mesh, spaces, operators
│   ├── exchange_operator.cpp # Exchange assembly + libCEED QFunction
│   ├── exchange_qfunction.h  # libCEED QFunction for exchange (device code)
│   ├── demag_solver.cpp      # Poisson solver with hypre
│   ├── llg_integrator.cu     # LLG RHS + Heun step (CUDA kernel)
│   ├── reductions.cu         # Energy, torque, average reductions
│   └── error.cpp             # Thread-local error handling
└── tests/
    ├── smoke_test.cpp        # Basic create/step/destroy
    ├── parity_test.cpp       # GPU vs CPU reference comparison
    └── convergence_test.cpp  # Demag thin plate demagnetization factor
```

### 4.2 CMakeLists.txt

```cmake
cmake_minimum_required(VERSION 3.24)
project(fullmag_fem_backend LANGUAGES CXX CUDA)

# Dependencies
find_package(MFEM REQUIRED)
find_package(CEED REQUIRED)      # libCEED
find_package(HYPRE REQUIRED)
find_package(CUDAToolkit REQUIRED)

# Library
add_library(fullmag_fem_backend SHARED
    src/api.cpp
    src/context.cpp
    src/exchange_operator.cpp
    src/demag_solver.cpp
    src/llg_integrator.cu
    src/reductions.cu
    src/error.cpp
)

target_include_directories(fullmag_fem_backend PUBLIC
    include/
    ${CMAKE_SOURCE_DIR}/include/     # fullmag_fem.h
)

target_link_libraries(fullmag_fem_backend
    MFEM::mfem
    CEED::ceed
    HYPRE::HYPRE
    CUDA::cudart
    CUDA::cusparse
)

set_target_properties(fullmag_fem_backend PROPERTIES
    CUDA_ARCHITECTURES "80;86;89;90"  # Ampere, Ada, Hopper
    CXX_STANDARD 17
    CUDA_STANDARD 17
)

# Tests
if(BUILD_TESTING)
    add_executable(fem_smoke_test tests/smoke_test.cpp)
    target_link_libraries(fem_smoke_test fullmag_fem_backend)

    add_executable(fem_parity_test tests/parity_test.cpp)
    target_link_libraries(fem_parity_test fullmag_fem_backend)
endif()
```

---

### 4.3 FemContext — klasa główna

```cpp
// native/backends/fem/include/context.hpp

#pragma once
#include "fullmag_fem.h"
#include <mfem.hpp>
#include <ceed.h>
#include <memory>
#include <vector>

namespace fullmag::fem {

class ExchangeOperator;
class DemagSolver;

class FemContext {
public:
    explicit FemContext(const fullmag_fem_plan_desc& desc);
    ~FemContext();

    // Perform one time step
    fullmag_fem_step_stats step();

    // Copy field to host
    void copy_field(fullmag_fem_observable obs, double* buffer, size_t len) const;

    // Device info
    fullmag_fem_device_info device_info() const;

    // Accessors
    int n_nodes() const { return fespace_->GetNDofs(); }

private:
    // MFEM mesh and FE space
    std::unique_ptr<mfem::Mesh> mesh_;
    std::unique_ptr<mfem::H1_FECollection> fec_;
    std::unique_ptr<mfem::FiniteElementSpace> fespace_;

    // Magnetization grid functions (3 scalar fields on device)
    std::unique_ptr<mfem::GridFunction> mx_, my_, mz_;

    // Effective field (3 scalar fields on device)
    std::unique_ptr<mfem::GridFunction> hx_, hy_, hz_;

    // Operators
    std::unique_ptr<ExchangeOperator> exchange_;
    std::unique_ptr<DemagSolver> demag_;

    // Material
    fullmag_fem_material_desc material_;
    double external_field_[3];

    // Integrator state
    fullmag_fem_integrator integrator_type_;
    double dt_;
    uint64_t current_step_;
    double current_time_;

    // Scratch vectors for Heun
    mfem::Vector k1x_, k1y_, k1z_;
    mfem::Vector k2x_, k2y_, k2z_;
    mfem::Vector m_star_x_, m_star_y_, m_star_z_;

    // Node volumes (lumped mass)
    mfem::Vector node_volumes_;

    // Flags
    bool enable_exchange_;
    bool enable_demag_;

    // Internal methods
    void compute_heff(const mfem::Vector& mx, const mfem::Vector& my, const mfem::Vector& mz,
                      mfem::Vector& hx, mfem::Vector& hy, mfem::Vector& hz);
    void llg_rhs(const mfem::Vector& mx, const mfem::Vector& my, const mfem::Vector& mz,
                 const mfem::Vector& hx, const mfem::Vector& hy, const mfem::Vector& hz,
                 mfem::Vector& dmx, mfem::Vector& dmy, mfem::Vector& dmz);
    void normalize(mfem::Vector& mx, mfem::Vector& my, mfem::Vector& mz);
    void heun_step();

    // Statistics
    double compute_exchange_energy() const;
    double compute_demag_energy() const;
    double compute_max_torque() const;
    void compute_averages(double& avg_mx, double& avg_my, double& avg_mz) const;
};

} // namespace fullmag::fem
```

---

### 4.4 Exchange Operator — libCEED partial assembly

```cpp
// native/backends/fem/include/exchange_operator.hpp

#pragma once
#include <mfem.hpp>
#include <ceed.h>

namespace fullmag::fem {

/**
 * Exchange field operator using libCEED for matrix-free GPU evaluation.
 *
 * H_ex = (2A / μ₀Ms) M_L^{-1} K m
 *
 * Where K is the stiffness matrix assembled via libCEED partial assembly:
 *   K_ij = ∫ ∇φ_i · ∇φ_j dV
 *
 * libCEED evaluation avoids explicit matrix storage:
 *   K*v is computed as: P^T B^T W D B P v
 *   where P = element restriction, B = basis eval, W = quadrature weights, D = metric
 */
class ExchangeOperator {
public:
    ExchangeOperator(mfem::FiniteElementSpace& fespace,
                     const mfem::Vector& node_volumes,
                     double a_exchange,
                     double mu0_ms);

    /// Apply exchange operator: hx += H_ex_x, etc.
    void apply(const mfem::Vector& mx, const mfem::Vector& my, const mfem::Vector& mz,
               mfem::Vector& hx, mfem::Vector& hy, mfem::Vector& hz);

    /// Compute exchange energy: E = A ∫|∇m|² dV
    double energy(const mfem::Vector& mx, const mfem::Vector& my, const mfem::Vector& mz) const;

private:
    Ceed ceed_;
    CeedOperator stiffness_op_;   // libCEED operator for K*v
    CeedVector u_ceed_, v_ceed_;  // Input/output CeedVectors

    double prefactor_;  // 2A / (μ₀Ms)

    mfem::Vector inv_node_volumes_;  // 1 / M_L diagonal
    mfem::Vector scratch_;

    int n_dofs_;
};

} // namespace fullmag::fem
```

**libCEED QFunction for exchange (device code):**

```c
// native/backends/fem/src/exchange_qfunction.h
// This runs on GPU via libCEED.

#include <ceed/ceed.h>

/// QFunction for Laplacian stiffness:
///   v = w * J^{-T} ∇u · J^{-T} ∇v * det(J)
///
/// In libCEED terms:
///   Input:  ∇u (gradient of trial function in physical coords)
///   Output: ∇v (gradient of test function weighted by quadrature + geometry)
CEED_QFUNCTION(f_apply_stiffness)(void *ctx, CeedInt Q,
                                   const CeedScalar *const *in,
                                   CeedScalar *const *out) {
    // in[0] = ∇u at Q quadrature points (Q × dim)
    // out[0] = ∇v at Q quadrature points (weighted)
    const CeedScalar *ug = in[0];
    CeedScalar *vg = out[0];

    // For Laplacian: output = input (identity in physical coords)
    // Geometry (Jacobian, weights) is handled by libCEED's element restriction + basis
    CeedPragmaSIMD
    for (CeedInt i = 0; i < Q; i++) {
        // 3D: copy all 3 gradient components
        vg[i + Q*0] = ug[i + Q*0];
        vg[i + Q*1] = ug[i + Q*1];
        vg[i + Q*2] = ug[i + Q*2];
    }

    return 0;
}
```

---

### 4.5 Demag Solver — hypre CG + AMG

```cpp
// native/backends/fem/include/demag_solver.hpp

#pragma once
#include <mfem.hpp>
#include <memory>

namespace fullmag::fem {

/**
 * FEM demagnetizing field solver.
 *
 * Solves: -Δu = -∇·M  (scalar potential Poisson)
 *         u = 0 on ∂Ω_air
 * Then:   H_d = -∇u    (restricted to magnetic nodes)
 *
 * Uses hypre BoomerAMG preconditioned CG.
 */
class DemagSolver {
public:
    DemagSolver(mfem::FiniteElementSpace& fespace,
                const mfem::Array<int>& boundary_dofs,
                const mfem::Vector& node_volumes,
                double ms,
                double rtol = 1e-10,
                int max_iter = 5000);

    /// Compute demagnetizing field from magnetization.
    /// Modifies hx, hy, hz (adds H_d contribution).
    void solve(const mfem::Vector& mx, const mfem::Vector& my, const mfem::Vector& mz,
               mfem::Vector& hx, mfem::Vector& hy, mfem::Vector& hz);

    /// Energy: E_d = -(1/2) μ₀ ∫ H_d · M dV
    double energy() const;

    /// CG iteration count (last solve)
    int last_iterations() const { return last_iter_; }
    double last_residual() const { return last_res_; }

private:
    mfem::FiniteElementSpace& fespace_;
    double ms_;

    // Assembled stiffness (Poisson operator)
    std::unique_ptr<mfem::BilinearForm> poisson_form_;
    std::unique_ptr<mfem::SparseMatrix> poisson_matrix_;

    // Solver stack
    std::unique_ptr<mfem::HypreBoomerAMG> amg_;
    std::unique_ptr<mfem::HyprePCG> cg_;

    // Boundary DOFs for Dirichlet
    mfem::Array<int> ess_dofs_;

    // Solution and RHS vectors
    mfem::Vector u_, rhs_;

    // Gradient recovery
    std::unique_ptr<mfem::GridFunction> grad_u_x_, grad_u_y_, grad_u_z_;

    // Stats
    int last_iter_;
    double last_res_;
    double last_energy_;
};

} // namespace fullmag::fem
```

**Implementacja kluczowych metod:**

```cpp
// native/backends/fem/src/demag_solver.cpp

#include "demag_solver.hpp"

namespace fullmag::fem {

DemagSolver::DemagSolver(mfem::FiniteElementSpace& fespace,
                         const mfem::Array<int>& boundary_dofs,
                         const mfem::Vector& node_volumes,
                         double ms, double rtol, int max_iter)
    : fespace_(fespace), ms_(ms), ess_dofs_(boundary_dofs),
      last_iter_(0), last_res_(0.0), last_energy_(0.0)
{
    int n = fespace.GetNDofs();
    u_.SetSize(n);
    u_ = 0.0;
    rhs_.SetSize(n);

    // Assemble Poisson stiffness matrix
    poisson_form_ = std::make_unique<mfem::BilinearForm>(&fespace);
    poisson_form_->AddDomainIntegrator(new mfem::DiffusionIntegrator());
    poisson_form_->Assemble();

    // Apply essential (Dirichlet) BC
    poisson_form_->FormSystemMatrix(ess_dofs_, *poisson_matrix_);

    // Setup hypre solver (device-aware if MFEM built with CUDA)
    auto* hypre_mat = new mfem::HypreParMatrix(
        /* serial → parallel wrapper for single-process case */
    );

    amg_ = std::make_unique<mfem::HypreBoomerAMG>(*hypre_mat);
    amg_->SetPrintLevel(0);

    cg_ = std::make_unique<mfem::HyprePCG>(*hypre_mat);
    cg_->SetTol(rtol);
    cg_->SetMaxIter(max_iter);
    cg_->SetPrintLevel(0);
    cg_->SetPreconditioner(*amg_);
}

void DemagSolver::solve(
    const mfem::Vector& mx, const mfem::Vector& my, const mfem::Vector& mz,
    mfem::Vector& hx, mfem::Vector& hy, mfem::Vector& hz)
{
    int n = fespace_.GetNDofs();

    // Assemble RHS: f_i = -Ms ∫ ∇φ_i · m dV
    // Using LinearForm with VectorGridFunctionCoefficient
    mfem::VectorGridFunctionCoefficient m_coeff;
    // ... set m_coeff from mx, my, mz ...

    mfem::LinearForm rhs_form(&fespace_);
    // Integrator: -∫ ∇φ · M dV (DivergenceFormIntegrator equivalent)
    rhs_form.Assemble();
    rhs_ = rhs_form;

    // Apply Dirichlet BC to RHS
    poisson_form_->FormLinearSystem(ess_dofs_, u_, rhs_, /* ... */);

    // Solve K*u = f
    cg_->Mult(rhs_, u_);
    cg_->GetNumIterations(last_iter_);
    // last_res_ = cg_->GetFinalNorm();

    // Recover H_d = -∇u
    // ... gradient recovery to nodes ...

    // Add to output
    for (int i = 0; i < n; i++) {
        hx[i] += /* -du/dx at node i */;
        hy[i] += /* -du/dy at node i */;
        hz[i] += /* -du/dz at node i */;
    }
}

} // namespace fullmag::fem
```

---

### 4.6 LLG CUDA Kernels

```cuda
// native/backends/fem/src/llg_integrator.cu

#include <cuda_runtime.h>

namespace fullmag::fem {

/// LLG RHS kernel: dm/dt = -γ/(1+α²) [m×H + α m×(m×H)]
__global__ void llg_rhs_kernel(
    const double* __restrict__ mx,
    const double* __restrict__ my,
    const double* __restrict__ mz,
    const double* __restrict__ hx,
    const double* __restrict__ hy,
    const double* __restrict__ hz,
    double* __restrict__ dmx,
    double* __restrict__ dmy,
    double* __restrict__ dmz,
    double prefactor,  // -γ/(1+α²)
    double alpha,
    int n)
{
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;

    double mx_i = mx[i], my_i = my[i], mz_i = mz[i];
    double hx_i = hx[i], hy_i = hy[i], hz_i = hz[i];

    // m × H
    double txhx = my_i * hz_i - mz_i * hy_i;
    double txhy = mz_i * hx_i - mx_i * hz_i;
    double txhz = mx_i * hy_i - my_i * hx_i;

    // m × (m × H)
    double txxhx = my_i * txhz - mz_i * txhy;
    double txxhy = mz_i * txhx - mx_i * txhz;
    double txxhz = mx_i * txhy - my_i * txhx;

    dmx[i] = prefactor * (txhx + alpha * txxhx);
    dmy[i] = prefactor * (txhy + alpha * txxhy);
    dmz[i] = prefactor * (txhz + alpha * txxhz);
}


/// Heun predictor: m* = m + dt * k1
__global__ void heun_predict_kernel(
    const double* __restrict__ mx,
    const double* __restrict__ my,
    const double* __restrict__ mz,
    const double* __restrict__ k1x,
    const double* __restrict__ k1y,
    const double* __restrict__ k1z,
    double* __restrict__ ms_x,
    double* __restrict__ ms_y,
    double* __restrict__ ms_z,
    double dt,
    int n)
{
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;

    ms_x[i] = mx[i] + dt * k1x[i];
    ms_y[i] = my[i] + dt * k1y[i];
    ms_z[i] = mz[i] + dt * k1z[i];

    // Normalize
    double norm = sqrt(ms_x[i]*ms_x[i] + ms_y[i]*ms_y[i] + ms_z[i]*ms_z[i]);
    if (norm > 1e-30) {
        double inv = 1.0 / norm;
        ms_x[i] *= inv;
        ms_y[i] *= inv;
        ms_z[i] *= inv;
    }
}


/// Heun corrector: m_{n+1} = m_n + (dt/2)(k1 + k2), then normalize
__global__ void heun_correct_kernel(
    double* __restrict__ mx,
    double* __restrict__ my,
    double* __restrict__ mz,
    const double* __restrict__ k1x,
    const double* __restrict__ k1y,
    const double* __restrict__ k1z,
    const double* __restrict__ k2x,
    const double* __restrict__ k2y,
    const double* __restrict__ k2z,
    double dt,
    int n)
{
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;

    double half_dt = 0.5 * dt;
    mx[i] += half_dt * (k1x[i] + k2x[i]);
    my[i] += half_dt * (k1y[i] + k2y[i]);
    mz[i] += half_dt * (k1z[i] + k2z[i]);

    // Normalize
    double norm = sqrt(mx[i]*mx[i] + my[i]*my[i] + mz[i]*mz[i]);
    if (norm > 1e-30) {
        double inv = 1.0 / norm;
        mx[i] *= inv;
        my[i] *= inv;
        mz[i] *= inv;
    }
}


/// Max torque reduction
__global__ void max_torque_kernel(
    const double* __restrict__ mx,
    const double* __restrict__ my,
    const double* __restrict__ mz,
    const double* __restrict__ hx,
    const double* __restrict__ hy,
    const double* __restrict__ hz,
    double* __restrict__ block_max,
    int n)
{
    extern __shared__ double sdata[];
    int tid = threadIdx.x;
    int i = blockIdx.x * blockDim.x + threadIdx.x;

    double local_max = 0.0;
    if (i < n) {
        double tx = my[i]*hz[i] - mz[i]*hy[i];
        double ty = mz[i]*hx[i] - mx[i]*hz[i];
        double tz = mx[i]*hy[i] - my[i]*hx[i];
        local_max = sqrt(tx*tx + ty*ty + tz*tz);
    }

    sdata[tid] = local_max;
    __syncthreads();

    // Block reduction for max
    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s && sdata[tid + s] > sdata[tid]) {
            sdata[tid] = sdata[tid + s];
        }
        __syncthreads();
    }

    if (tid == 0) {
        block_max[blockIdx.x] = sdata[0];
    }
}


/// Volume-weighted average reduction
__global__ void volume_average_kernel(
    const double* __restrict__ field,
    const double* __restrict__ volumes,
    double* __restrict__ block_sum,
    int n)
{
    extern __shared__ double sdata[];
    int tid = threadIdx.x;
    int i = blockIdx.x * blockDim.x + threadIdx.x;

    double local_sum = 0.0;
    if (i < n) {
        local_sum = field[i] * volumes[i];
    }

    sdata[tid] = local_sum;
    __syncthreads();

    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) {
            sdata[tid] += sdata[tid + s];
        }
        __syncthreads();
    }

    if (tid == 0) {
        block_sum[blockIdx.x] = sdata[0];
    }
}

} // namespace fullmag::fem
```

---

### 4.7 api.cpp — C ABI implementation

```cpp
// native/backends/fem/src/api.cpp

#include "fullmag_fem.h"
#include "context.hpp"
#include <cstring>

using namespace fullmag::fem;

// Thread-local error message
static thread_local char g_last_error[1024] = "";

static void set_error(const char* msg) {
    strncpy(g_last_error, msg, sizeof(g_last_error) - 1);
    g_last_error[sizeof(g_last_error) - 1] = '\0';
}

extern "C" {

fullmag_fem_handle fullmag_fem_backend_create(const fullmag_fem_plan_desc* desc) {
    try {
        auto* ctx = new FemContext(*desc);
        return reinterpret_cast<fullmag_fem_handle>(ctx);
    } catch (const std::exception& e) {
        set_error(e.what());
        return nullptr;
    }
}

int fullmag_fem_backend_step(fullmag_fem_handle handle, fullmag_fem_step_stats* stats) {
    try {
        auto* ctx = reinterpret_cast<FemContext*>(handle);
        *stats = ctx->step();
        return 0;
    } catch (const std::exception& e) {
        set_error(e.what());
        return -1;
    }
}

int fullmag_fem_backend_copy_field_f64(
    fullmag_fem_handle handle,
    fullmag_fem_observable observable,
    double* buffer,
    size_t buffer_len)
{
    try {
        auto* ctx = reinterpret_cast<FemContext*>(handle);
        ctx->copy_field(observable, buffer, buffer_len);
        return 0;
    } catch (const std::exception& e) {
        set_error(e.what());
        return -1;
    }
}

int fullmag_fem_backend_get_device_info(
    fullmag_fem_handle handle,
    fullmag_fem_device_info* info)
{
    try {
        auto* ctx = reinterpret_cast<FemContext*>(handle);
        *info = ctx->device_info();
        return 0;
    } catch (const std::exception& e) {
        set_error(e.what());
        return -1;
    }
}

const char* fullmag_fem_last_error(void) {
    return g_last_error;
}

void fullmag_fem_backend_destroy(fullmag_fem_handle handle) {
    delete reinterpret_cast<FemContext*>(handle);
}

} // extern "C"
```

---

## 5. Rust FFI — `fullmag-fem-sys`

### 5.1 Nowy crate

```
crates/fullmag-fem-sys/
├── Cargo.toml
├── build.rs       # Find and link libfullmag_fem_backend.so
└── src/
    └── lib.rs     # Raw FFI bindings + safe wrapper
```

### 5.2 `Cargo.toml`

```toml
[package]
name = "fullmag-fem-sys"
version = "0.1.0"
edition = "2021"

[build-dependencies]
cc = "1"        # For finding libs
pkg-config = "0.3"

[dependencies]
fullmag-ir = { path = "../fullmag-ir" }
```

### 5.3 `src/lib.rs` (raw FFI + safe wrapper)

```rust
//! FFI bindings to the native FEM GPU backend.

#![allow(non_camel_case_types)]

use std::ffi::{c_char, c_double, c_int, c_void, CStr};
use std::ptr;

// --- Raw FFI types ---

#[repr(C)]
pub struct fullmag_fem_mesh_desc {
    pub nodes: *const c_double,
    pub n_nodes: u32,
    pub elements: *const u32,
    pub n_elements: u32,
    pub element_markers: *const u32,
    pub boundary_faces: *const u32,
    pub n_boundary_faces: u32,
    pub boundary_markers: *const u32,
    pub node_markers: *const u8,
}

#[repr(C)]
pub struct fullmag_fem_material_desc {
    pub ms: c_double,
    pub a_exchange: c_double,
    pub alpha: c_double,
    pub gamma: c_double,
}

#[repr(C)]
pub struct fullmag_fem_solver_config {
    pub solver: c_int,
    pub preconditioner: c_int,
    pub rtol: c_double,
    pub max_iter: u32,
}

#[repr(C)]
pub struct fullmag_fem_plan_desc {
    pub mesh: fullmag_fem_mesh_desc,
    pub material: fullmag_fem_material_desc,
    pub fe_order: u32,
    pub precision: c_int,
    pub integrator: c_int,
    pub enable_exchange: c_int,
    pub enable_demag: c_int,
    pub external_field: [c_double; 3],
    pub demag_solver: fullmag_fem_solver_config,
    pub air_box_factor: c_double,
    pub initial_magnetization: *const c_double,
    pub dt: c_double,
}

#[repr(C)]
pub struct fullmag_fem_step_stats {
    pub step: u64,
    pub time: c_double,
    pub energy_exchange: c_double,
    pub energy_demag: c_double,
    pub energy_zeeman: c_double,
    pub avg_mx: c_double,
    pub avg_my: c_double,
    pub avg_mz: c_double,
    pub max_torque: c_double,
    pub demag_cg_iterations: u32,
    pub demag_cg_residual: c_double,
}

#[repr(C)]
pub struct fullmag_fem_device_info {
    pub device_name: [c_char; 256],
    pub total_memory: u64,
    pub free_memory: u64,
    pub cuda_device_id: c_int,
    pub compute_capability_major: c_int,
    pub compute_capability_minor: c_int,
}

pub type fullmag_fem_handle = *mut c_void;

// --- Raw FFI functions ---

extern "C" {
    pub fn fullmag_fem_backend_create(desc: *const fullmag_fem_plan_desc) -> fullmag_fem_handle;
    pub fn fullmag_fem_backend_step(handle: fullmag_fem_handle, stats: *mut fullmag_fem_step_stats) -> c_int;
    pub fn fullmag_fem_backend_copy_field_f64(handle: fullmag_fem_handle, observable: c_int, buffer: *mut c_double, len: usize) -> c_int;
    pub fn fullmag_fem_backend_get_device_info(handle: fullmag_fem_handle, info: *mut fullmag_fem_device_info) -> c_int;
    pub fn fullmag_fem_last_error() -> *const c_char;
    pub fn fullmag_fem_backend_destroy(handle: fullmag_fem_handle);
}

// --- Safe wrapper ---

pub struct NativeFemBackend {
    handle: fullmag_fem_handle,
    n_nodes: usize,
}

impl NativeFemBackend {
    /// Create backend from FemPlanIR.
    pub fn new(plan: &fullmag_ir::FemPlanIR) -> Result<Self, String> {
        let desc = plan_to_desc(plan);
        let handle = unsafe { fullmag_fem_backend_create(&desc) };
        if handle.is_null() {
            let err = last_error();
            return Err(format!("Failed to create FEM backend: {}", err));
        }
        Ok(Self {
            handle,
            n_nodes: plan.mesh.n_nodes(),
        })
    }

    /// Perform one time step.
    pub fn step(&self) -> Result<fullmag_fem_step_stats, String> {
        let mut stats = unsafe { std::mem::zeroed() };
        let ret = unsafe { fullmag_fem_backend_step(self.handle, &mut stats) };
        if ret != 0 {
            return Err(format!("Step failed: {}", last_error()));
        }
        Ok(stats)
    }

    /// Copy magnetization component to host.
    pub fn copy_field(&self, obs: c_int) -> Result<Vec<f64>, String> {
        let mut buf = vec![0.0_f64; self.n_nodes];
        let ret = unsafe {
            fullmag_fem_backend_copy_field_f64(
                self.handle, obs, buf.as_mut_ptr(), self.n_nodes
            )
        };
        if ret != 0 {
            return Err(format!("copy_field failed: {}", last_error()));
        }
        Ok(buf)
    }
}

impl Drop for NativeFemBackend {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { fullmag_fem_backend_destroy(self.handle) };
        }
    }
}

fn last_error() -> String {
    unsafe {
        let ptr = fullmag_fem_last_error();
        if ptr.is_null() {
            "unknown error".into()
        } else {
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        }
    }
}

fn plan_to_desc(plan: &fullmag_ir::FemPlanIR) -> fullmag_fem_plan_desc {
    // Convert FemPlanIR to C ABI struct
    // (implementation details: pointer setup from Vec data)
    todo!("Implement conversion")
}
```

---

## 6. MFEM + libCEED konfiguracja GPU

### 6.1 MFEM build z CUDA

```bash
# Build MFEM with CUDA support
cd third_party/mfem
mkdir build && cd build
cmake .. \
    -DMFEM_USE_CUDA=YES \
    -DCUDA_ARCH=sm_80 \
    -DMFEM_USE_CEED=YES \
    -DCEED_DIR=/path/to/libceed \
    -DMFEM_USE_MPI=NO \        # Single-process for now
    -DMFEM_USE_METIS=NO \
    -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
```

### 6.2 libCEED build z CUDA

```bash
cd third_party/libceed
make CUDA_DIR=/usr/local/cuda \
     OPT='-O3' \
     CUDA_ARCH='sm_80' \
     -j$(nproc)
```

### 6.3 hypre build z CUDA

```bash
cd third_party/hypre/src
./configure --with-cuda \
            --with-gpu-arch=80 \
            --enable-shared \
            --without-MPI
make -j$(nproc)
```

---

## 7. Testy S4

| Test | Opis | Kryterium |
|------|------|-----------|
| `fem_smoke_create_destroy` | Create + destroy bez crash | exit 0 |
| `fem_smoke_single_step` | 1 step na prostym mesh | stats populated |
| `fem_exchange_uniform` | H_ex = 0 dla uniform m | $\|H_{ex}\| < \epsilon$ |
| `fem_demag_thin_plate` | N_z ≈ 1 dla cienkiej płyty | $\|N_z - 1\| < 0.15$ |
| `fem_parity_exchange` | GPU vs CPU ref exchange energy | < 0.1% diff |
| `fem_parity_full` | GPU vs CPU ref full simulation 100 steps | max_torque < 0.1% diff |
| `fem_heun_norm` | $\|m\| = 1$ po 1000 kroków | defect < 1e-6 |
| `fem_cg_convergence` | CG converges w < 1000 iter | iterations < 1000 |
| `fem_energy_decrease` | Relaxation: energy decreases | monotonic |
| `fem_device_info` | get_device_info poprawne | name non-empty |

---

## 8. Kryteria akceptacji S4

| # | Kryterium |
|---|-----------|
| 1 | `fullmag_fem_backend_create/step/destroy` cycle works na GPU |
| 2 | Exchange via libCEED matches CPU reference < 0.1% |
| 3 | Demag via hypre CG+AMG converges in < 500 iterations |
| 4 | LLG Heun on GPU preserves norm to 1e-6 |
| 5 | FULLMAG_FEM_BACKEND=gpu end-to-end simulation |
| 6 | Step throughput: > 100 steps/s on A100 for 50k-node mesh |
| 7 | CMake build succeeds with MFEM+libCEED+hypre+CUDA |

---

## 9. Ryzyka

| Ryzyko | Wpływ | Mitigacja |
|--------|-------|-----------|
| MFEM z CUDA trudny do skompilowania | Blokuje S4 | Docker image z prebuilt MFEM |
| libCEED P1 tet QFunction nie testowany | Złe wyniki exchange | Walidacja na znanym problemie (uniform m → H=0) |
| hypre single-process z CUDA | Ograniczona skala | Wystarczy na Phase 1; MPI w Phase 2 |
| Duże air-boxy (>100k nodes) → wolny CG | Bottleneck demag | AMG preconditioning; future FEM-BEM |
| Interplay MFEM device memory + thrust | Memory leak | RAII wrappers; valgrind/cuda-memcheck |
