# Native FEM DMI Weak-Residual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace native FEM DMI strong-form/nodal averaging with weak-residual assembly plus lumped mass projection.

**Architecture:** Add an MFEM-free helper for DMI residual math, protect it with native formula tests, then refactor `mfem_bridge.cpp` to use the helper inside existing element loops. Public API, IR, planner, and observables stay unchanged.

**Tech Stack:** C++17 native backend, MFEM bridge integration, Rust reference tests for cross-checking, Fullmag physics docs.

---

### Task 1: Physics And Design Artifacts

**Files:**
- Create: `docs/physics/0813-native-fem-dmi-weak-residual.md`
- Create: `docs/superpowers/specs/2026-05-15-native-fem-dmi-weak-residual-design.md`
- Create: `docs/superpowers/plans/2026-05-15-native-fem-dmi-weak-residual.md`

- [x] **Step 1: Record equations and scope**

Expected: documents define `R_iDMI`, `R_bDMI`, `H_i = -g_i/(mu0 Ms_i M_lumped_i)`, API/IR no-change scope, and deferred libCEED/CUDA work.

### Task 2: RED Native Formula Test

**Files:**
- Create: `native/backends/fem/tests/dmi_weak_residual.cpp`
- Modify: `native/backends/fem/CMakeLists.txt`

- [x] **Step 1: Add formula test before helper exists**

Create a test that includes `dmi_weak_residual.hpp` and calls:

```cpp
fullmag::fem::dmi_accumulate_interfacial_residual(...);
fullmag::fem::dmi_accumulate_bulk_residual(...);
fullmag::fem::dmi_project_lumped_field(...);
```

The test fixture uses one unit tetra with non-uniform `m` and non-uniform
perturbation `v`. It checks:

```text
-mu0 Ms sum_i V_i H_i . v_i == R_DMI(m; v)
```

for interfacial and bulk DMI.

- [x] **Step 2: Run RED**

Run:

```bash
g++ -std=c++17 -Inative/include -Inative/backends/fem/include \
  -DFULLMAG_HAS_CUDA_RUNTIME=0 -DFULLMAG_HAS_MFEM_STACK=0 \
  -fsyntax-only native/backends/fem/tests/dmi_weak_residual.cpp
```

Expected: FAIL because `dmi_weak_residual.hpp` or the called helper functions
do not exist.

### Task 3: Native DMI Math Helper

**Files:**
- Create: `native/backends/fem/include/dmi_weak_residual.hpp`
- Create: `native/backends/fem/src/dmi_weak_residual.cpp`
- Modify: `native/backends/fem/CMakeLists.txt`

- [x] **Step 1: Implement helper signatures**

Add an MFEM-free helper with fixed-size arrays:

```cpp
namespace fullmag::fem {

struct DmiElementData {
    double m_q[3];
    double grad_m[3][3];
    double shape;
    double grad_shape[3];
    double weight;
};

void dmi_accumulate_interfacial_residual(
    const DmiElementData &data,
    const double n_hat[3],
    double d,
    double residual[3]);

void dmi_accumulate_bulk_residual(
    const DmiElementData &data,
    double d,
    double residual[3]);

bool dmi_project_lumped_field(
    const double *residual_xyz,
    const double *lumped_mass,
    const double *ms_field,
    uint64_t node_count,
    double uniform_ms,
    double *out_h_xyz,
    std::string &error);

} // namespace fullmag::fem
```

- [x] **Step 2: Run formula test**

Build and run:

```bash
g++ -std=c++17 -Inative/include -Inative/backends/fem/include \
  -DFULLMAG_HAS_CUDA_RUNTIME=0 -DFULLMAG_HAS_MFEM_STACK=0 \
  native/backends/fem/tests/dmi_weak_residual.cpp \
  native/backends/fem/src/dmi_weak_residual.cpp \
  -o /tmp/fem_dmi_weak_residual_smoke
/tmp/fem_dmi_weak_residual_smoke
```

Expected: PASS and print `FEM dmi_weak_residual smoke PASS`.

### Task 4: MFEM Bridge Refactor

**Files:**
- Modify: `native/backends/fem/src/mfem_bridge.cpp`

- [x] **Step 1: Refactor interfacial DMI**

Replace direct strong-form field accumulation in `compute_interfacial_dmi_field`
with:

```text
residual_xyz[gdof*3 + comp] += dmi residual contribution
```

Then call `dmi_project_lumped_field(...)` with `ctx.mfem_lumped_mass`,
`ctx.Ms_field`, `ctx.material.saturation_magnetisation`, and `h_dmi_xyz`.

- [x] **Step 2: Refactor bulk DMI**

Apply the same residual-plus-projection path to `compute_bulk_dmi_field`.

- [x] **Step 3: Preserve existing energy calculations**

Keep the current energy density calculations for reported scalar energy in this
slice. The field discretization changes; energy reporting remains the existing
quadrature integral.

### Task 5: Documentation And Audit

**Files:**
- Modify: `docs/physics/0813-native-fem-dmi-weak-residual.md`
- Modify: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
- Modify: `docs/superpowers/plans/2026-05-15-native-fem-dmi-weak-residual.md`

- [x] **Step 1: Mark native CPU/MFEM DMI baseline complete**

Update docs to say native CPU/MFEM DMI now uses weak residual plus lumped
projection, while libCEED/CUDA QFunction remains open.

### Task 6: Verification

**Files:**
- Test: native formula smoke
- Test: Rust DMI oracle tests

- [x] **Step 1: Run native formula smoke**

```bash
/tmp/fem_dmi_weak_residual_smoke
```

Expected: PASS.

- [x] **Step 2: Run Rust DMI tests**

```bash
cargo test -p fullmag-engine dmi -- --nocapture
```

Expected: PASS.

- [x] **Step 3: Run source checks**

```bash
git diff --check
```

Expected: PASS.

Additional host check:

```bash
scripts/check_mfem_host_env.sh
```

Result on this workstation: blocked, `MFEMConfig.cmake` / `mfem-config.cmake`
not found. Full MFEM runtime parity must be rerun on an MFEM-equipped host.
