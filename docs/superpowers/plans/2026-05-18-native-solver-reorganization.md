# Native Solver Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catalog and reorganize Fullmag native solver implementations so FDM, FEM, CPU/MFEM, GPU/CUDA, and hybrid interop paths have explicit ownership and directory boundaries.

**Architecture:** This is a strangler refactor. First freeze a solver catalog and source-boundary tests, then move one implementation family at a time without changing physics, public C ABI behavior, provenance, telemetry, or validation semantics. `src/` becomes facade/common code; concrete solver realizations live under `cpu/...`, `gpu/...`, or `interop/...`.

**Tech Stack:** CMake, C++17, CUDA `.cu`, MFEM/hypre/libCEED, Fullmag native FDM/FEM C ABI, existing FEM contract tests.

---

## Scope

This plan covers native solver organization under:

- `native/backends/fdm`
- `native/backends/fem`
- shared documentation in `docs/specs`

This plan does not change solver formulas, integrator coefficients, physics contracts, runtime selection vocabulary, Python DSL, OpenAPI, or UI behavior.

## Source Truths

Use these documents as the governing constraints:

- `AGENTS.md`
- `docs/adr/0014-native-fem-backend-modularization.md`
- `docs/specs/native-fem-backend-architecture-v1.md`
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- `docs/specs/capability-matrix-v0.md`

The key rule is: folder moves alone are not success. Every solver lane needs ownership, capability status, tests, and validation mapping.

## Current Problem

Current native solver layout mixes layers:

```text
native/backends/fem/
  core/                       backend-neutral FEM helpers
  cpu/mfem/                   CPU/MFEM implementation
  include/                    shared headers plus GPU headers
  src/                        ABI/common code plus GPU/CUDA code
  tests/

native/backends/fdm/
  include/                    FDM public/native headers
  src/                        ABI/common code plus CUDA implementation
  tests/
```

Concrete examples:

- `native/backends/fem/src/gpu_state.cpp` is GPU/CUDA state code but lives in generic `src/`.
- `native/backends/fem/src/gpu_rk.cu` is CUDA RK implementation but lives in generic `src/`.
- `native/backends/fem/src/kernels.cu` is CUDA kernels but lives beside `api.cpp` and `context.cpp`.
- `native/backends/fem/cpu/mfem/runtime/gpu_state_runtime.cpp` is MFEM-to-CUDA interop/bootstrap, but its name makes it look like GPU solver ownership.
- `native/backends/fdm/src/*.cu` are CUDA implementation files, but FDM does not yet expose a `gpu/cuda` implementation boundary.

## Target Taxonomy

Every solver implementation should be classified by four fields:

```text
discretization: fdm | fem
lane: cpu | gpu | hybrid | reference
engine: rust | mfem | cuda | hypre | libceed | native-cpp
role: api | core | runtime | state | interaction | integrator | solver | transfer | diagnostics
```

Examples:

```text
fem.cpu.mfem.runtime
fem.cpu.mfem.interactions.demag_poisson
fem.gpu.cuda.integrators.explicit_rk
fem.gpu.cuda.kernels.local_terms
fem.hybrid.mfem_cuda.demag_upload
fdm.gpu.cuda.integrators.rk4_fp64
fdm.gpu.cuda.interactions.exchange_fp64
fdm.gpu.cuda.interactions.demag_fp64
```

## Target Directory Layout

### FEM Target

```text
native/backends/fem/
  api/
    c_api.cpp
    context_facade.cpp
    error.cpp
  include/
    context.hpp
    fem_common.hpp
    transfer_audit.hpp
  core/
    fem_field_buffers.hpp/.cpp
    fem_material_fields.hpp/.cpp
    fem_mesh.hpp/.cpp
    fem_plan_fields.hpp/.cpp
    fem_state.hpp/.cpp
  cpu/mfem/
    runtime/
    spaces/
    operators/
    interactions/
    integrators/
    observables/
    interop/
      cuda_state_runtime.hpp/.cpp
  gpu/cuda/
    runtime/
    state/
      gpu_state.hpp/.cpp
    kernels/
      kernels.hpp/.cu
    interactions/
      exchange.hpp/.cpp
      dmi.hpp/.cu
      local_terms.hpp/.cu
    integrators/
      gpu_rk.hpp/.cpp/.cu
    transfer/
      transfer_audit_cuda.hpp/.cpp
  tests/
```

### FDM Target

```text
native/backends/fdm/
  api/
    c_api.cpp
    error.cpp
  include/
    context.hpp
    kernels.hpp
  core/
    context.hpp/.cpp
    constants.hpp
  gpu/cuda/
    runtime/
      device_info.cpp
      context.cu
    kernels/
      reductions_fp64.cu
      newell_gpu_fp32.cu
      newell_gpu_fp64.cu
    interactions/
      exchange_fp32.cu
      exchange_fp64.cu
      exchange_t0_fp64.cu
      exchange_t1_fp64.cu
      demag_boundary_fp64.cu
      demag_fp32.cu
      demag_fp64.cu
    integrators/
      llg_fp32.cu
      llg_fp64.cu
      llg_abm3_fp32.cu
      llg_abm3_fp64.cu
      llg_dp45_fp32.cu
      llg_dp45_fp64.cu
      llg_rk23_fp32.cu
      llg_rk23_fp64.cu
      llg_rk4_fp32.cu
      llg_rk4_fp64.cu
  tests/
```

## Compatibility Policy

During migration, keep forwarding headers when existing includes are widespread.

Example forwarding header:

```cpp
#pragma once

#include "gpu/cuda/state/gpu_state.hpp"
```

Forwarding headers are allowed only for moved internal headers. They must have a removal issue or plan step in the same plan section.

## Task 1: Create Solver Catalog

**Files:**

- Create: `docs/specs/native-solver-catalog-v1.md`
- Create: `native/backends/README.md`

- [ ] **Step 1: Write `docs/specs/native-solver-catalog-v1.md`**

Content:

```markdown
# Native Solver Catalog v1

- Status: canonical catalog
- Related architecture:
  - docs/adr/0014-native-fem-backend-modularization.md
  - docs/specs/native-fem-backend-architecture-v1.md
  - docs/physics/0900-native-fem-operator-contracts-and-validation.md

## Classification Fields

| Field | Values | Meaning |
|---|---|---|
| discretization | fdm, fem | Physical discretization family |
| lane | cpu, gpu, hybrid, reference | Execution lane |
| engine | rust, mfem, cuda, hypre, libceed, native-cpp | Implementation engine |
| role | api, core, runtime, state, interaction, integrator, solver, transfer, diagnostics | Ownership role |
| status | cataloged, moved, validated | Migration status |

## Current Native Backends

| Solver id | Current files | Target owner | Status |
|---|---|---|---|
| fdm.gpu.cuda.api | native/backends/fdm/src/api.cpp, native/backends/fdm/src/error.cpp | native/backends/fdm/api | cataloged |
| fdm.gpu.cuda.runtime | native/backends/fdm/src/context.cu, native/backends/fdm/src/device_info.cpp | native/backends/fdm/gpu/cuda/runtime | cataloged |
| fdm.gpu.cuda.exchange | native/backends/fdm/src/exchange_*.cu | native/backends/fdm/gpu/cuda/interactions | cataloged |
| fdm.gpu.cuda.demag | native/backends/fdm/src/demag_*.cu, native/backends/fdm/src/newell_gpu_*.cu | native/backends/fdm/gpu/cuda/interactions | cataloged |
| fdm.gpu.cuda.integrators | native/backends/fdm/src/llg_*.cu | native/backends/fdm/gpu/cuda/integrators | cataloged |
| fdm.gpu.cuda.reductions | native/backends/fdm/src/reductions_fp64.cu | native/backends/fdm/gpu/cuda/kernels | cataloged |
| fem.api | native/backends/fem/src/api.cpp, native/backends/fem/src/error.cpp | native/backends/fem/api | cataloged |
| fem.core | native/backends/fem/core/* | native/backends/fem/core | cataloged |
| fem.cpu.mfem.runtime | native/backends/fem/cpu/mfem/runtime/* | native/backends/fem/cpu/mfem/runtime | cataloged |
| fem.cpu.mfem.interactions | native/backends/fem/cpu/mfem/interactions/* | native/backends/fem/cpu/mfem/interactions | cataloged |
| fem.cpu.mfem.integrators | native/backends/fem/cpu/mfem/integrators/* | native/backends/fem/cpu/mfem/integrators | cataloged |
| fem.hybrid.mfem_cuda.interop | native/backends/fem/cpu/mfem/runtime/gpu_state_runtime.cpp | native/backends/fem/cpu/mfem/interop | cataloged |
| fem.gpu.cuda.state | native/backends/fem/src/gpu_state.cpp, native/backends/fem/include/gpu_state.hpp | native/backends/fem/gpu/cuda/state | cataloged |
| fem.gpu.cuda.integrators | native/backends/fem/src/gpu_rk.cpp, native/backends/fem/src/gpu_rk.cu, native/backends/fem/include/gpu_rk.hpp | native/backends/fem/gpu/cuda/integrators | cataloged |
| fem.gpu.cuda.exchange | native/backends/fem/src/gpu_exchange.cpp, native/backends/fem/include/gpu_exchange.hpp | native/backends/fem/gpu/cuda/interactions | cataloged |
| fem.gpu.cuda.kernels | native/backends/fem/src/kernels.cu, native/backends/fem/include/kernels.h | native/backends/fem/gpu/cuda/kernels | cataloged |

## Rules

1. Generic `src/` directories may contain ABI facades and shared glue only.
2. A file with CUDA kernels must live under `gpu/cuda`.
3. A file that owns MFEM or hypre object lifetime must live under `cpu/mfem`.
4. A file that bridges MFEM CPU data to CUDA GPU data must live under an explicit `interop` owner.
5. Physics formulas must stay tied to a backend-neutral physics note and tests.
6. Capability status must not say `validated` unless the documented validation gate passes.
```

- [ ] **Step 2: Write `native/backends/README.md`**

Content:

```markdown
# Native Backends

This directory contains native execuction implementations for Fullmag solver families.

Directory rules:

- `fdm/` owns finite-difference native implementations.
- `fem/` owns finite-element native implementations.
- `core/` owns backend-neutral state and helper contracts for a solver family.
- `cpu/<engine>/` owns CPU implementation details for that engine.
- `gpu/<engine>/` owns GPU implementation details for that engine.
- `interop/` owns explicit cross-lane transfer/bootstrap code.
- `api/` owns C ABI facade code.

The canonical catalog is `docs/specs/native-solver-catalog-v1.md`.
```

- [ ] **Step 3: Verify catalog paths exist**

Run:

```bash
rg -n "native/backends/(fdm|fem)" docs/specs/native-solver-catalog-v1.md native/backends/README.md
```

Expected: all current and target solver families are listed.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/native-solver-catalog-v1.md native/backends/README.md
git commit -m "docs: catalog native solver ownership"
```

## Task 2: Add Layout Contract Tests

**Files:**

- Create: `native/backends/fem/tests/solver_layout_contract.cpp`
- Modify: `native/backends/fem/CMakeLists.txt`
- Create: `native/backends/fdm/tests/solver_layout_contract.cpp`
- Modify: `native/backends/fdm/CMakeLists.txt`

- [ ] **Step 1: Add FEM layout contract**

Create `native/backends/fem/tests/solver_layout_contract.cpp`:

```cpp
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::filesystem::path fem_root() {
    const std::filesystem::path this_file(__FILE__);
    return this_file.is_absolute()
        ? this_file.parent_path().parent_path()
        : std::filesystem::current_path() / this_file.parent_path().parent_path();
}

std::string read_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    check(static_cast<bool>(in), "unable to read file");
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

} // namespace

int main() {
    const auto root = fem_root();
    const std::string cmake = read_file(root / "CMakeLists.txt");

    check(cmake.find("gpu/cuda/state/gpu_state.cpp") != std::string::npos,
        "FEM GPU state must be owned under gpu/cuda/state");
    check(cmake.find("gpu/cuda/integrators/gpu_rk.cpp") != std::string::npos,
        "FEM GPU RK C++ planner must be owned under gpu/cuda/integrators");
    check(cmake.find("gpu/cuda/integrators/gpu_rk.cu") != std::string::npos,
        "FEM GPU RK CUDA implementation must be owned under gpu/cuda/integrators");
    check(cmake.find("gpu/cuda/kernels/kernels.cu") != std::string::npos,
        "FEM CUDA kernels must be owned under gpu/cuda/kernels");
    check(cmake.find("cpu/mfem/interop/cuda_state_runtime.cpp") != std::string::npos,
        "FEM MFEM-to-CUDA bootstrap must be owned under cpu/mfem/interop");

    for (const char *stale : {
             "src/gpu_state.cpp",
             "src/gpu_rk.cpp",
             "src/gpu_rk.cu",
             "src/gpu_exchange.cpp",
             "src/kernels.cu",
             "cpu/mfem/runtime/gpu_state_runtime.cpp",
         }) {
        check(cmake.find(stale) == std::string::npos,
            "FEM CMakeLists must not reference stale mixed solver paths");
    }

    return 0;
}
```

- [ ] **Step 2: Register FEM layout contract**

Modify `native/backends/fem/CMakeLists.txt`:

```cmake
add_executable(fem_solver_layout_contract tests/solver_layout_contract.cpp)
add_test(NAME fem_solver_layout_contract COMMAND fem_solver_layout_contract)
```

Place it next to the existing source facade and GPU state contract tests.

- [ ] **Step 3: Run FEM layout contract and observe failure**

Run:

```bash
cmake --build native/build --target fem_solver_layout_contract -j2
env LD_LIBRARY_PATH=/home/kkingstoun/git/fullmag/fullmag/native/build/backends/fem:$LD_LIBRARY_PATH \
  ctest --test-dir native/build/backends/fem -R fem_solver_layout_contract --output-on-failure
```

Expected before moves: FAIL with stale mixed solver path messages.

- [ ] **Step 4: Add FDM layout contract**

Create `native/backends/fdm/tests/solver_layout_contract.cpp`:

```cpp
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::filesystem::path fdm_root() {
    const std::filesystem::path this_file(__FILE__);
    return this_file.is_absolute()
        ? this_file.parent_path().parent_path()
        : std::filesystem::current_path() / this_file.parent_path().parent_path();
}

std::string read_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    check(static_cast<bool>(in), "unable to read file");
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

} // namespace

int main() {
    const auto root = fdm_root();
    const std::string cmake = read_file(root / "CMakeLists.txt");

    check(cmake.find("api/api.cpp") != std::string::npos,
        "FDM C ABI entrypoint must be owned under api");
    check(cmake.find("gpu/cuda/runtime/context.cu") != std::string::npos,
        "FDM CUDA context must be owned under gpu/cuda/runtime");
    check(cmake.find("gpu/cuda/interactions/exchange_fp64.cu") != std::string::npos,
        "FDM CUDA exchange must be owned under gpu/cuda/interactions");
    check(cmake.find("gpu/cuda/interactions/demag_fp64.cu") != std::string::npos,
        "FDM CUDA demag must be owned under gpu/cuda/interactions");
    check(cmake.find("gpu/cuda/integrators/llg_rk4_fp64.cu") != std::string::npos,
        "FDM CUDA RK4 must be owned under gpu/cuda/integrators");

    for (const char *stale : {
             "src/context.cu",
             "src/exchange_fp64.cu",
             "src/demag_fp64.cu",
             "src/llg_rk4_fp64.cu",
         }) {
        check(cmake.find(stale) == std::string::npos,
            "FDM CMakeLists must not reference stale mixed solver paths");
    }

    return 0;
}
```

- [ ] **Step 5: Register FDM layout contract**

Modify `native/backends/fdm/CMakeLists.txt`:

```cmake
add_executable(fdm_solver_layout_contract tests/solver_layout_contract.cpp)
add_test(NAME fdm_solver_layout_contract COMMAND fdm_solver_layout_contract)
```

- [ ] **Step 6: Run FDM layout contract and observe failure**

Run:

```bash
cmake --build native/build --target fdm_solver_layout_contract -j2
ctest --test-dir native/build/backends/fdm -R fdm_solver_layout_contract --output-on-failure
```

Expected before moves: FAIL with stale mixed solver path messages.

- [ ] **Step 7: Commit**

```bash
git add native/backends/fem/tests/solver_layout_contract.cpp native/backends/fem/CMakeLists.txt \
  native/backends/fdm/tests/solver_layout_contract.cpp native/backends/fdm/CMakeLists.txt
git commit -m "test: enforce native solver layout boundaries"
```

## Task 3: Move FEM GPU/CUDA State and Kernels

**Files:**

- Move: `native/backends/fem/src/gpu_state.cpp` -> `native/backends/fem/gpu/cuda/state/gpu_state.cpp`
- Move: `native/backends/fem/include/gpu_state.hpp` -> `native/backends/fem/gpu/cuda/state/gpu_state.hpp`
- Move: `native/backends/fem/src/kernels.cu` -> `native/backends/fem/gpu/cuda/kernels/kernels.cu`
- Move: `native/backends/fem/include/kernels.h` -> `native/backends/fem/gpu/cuda/kernels/kernels.hpp`
- Modify: `native/backends/fem/include/gpu_state.hpp`
- Modify: `native/backends/fem/include/kernels.h`
- Modify: `native/backends/fem/CMakeLists.txt`

- [ ] **Step 1: Create directories**

Run:

```bash
mkdir -p native/backends/fem/gpu/cuda/state native/backends/fem/gpu/cuda/kernels
```

- [ ] **Step 2: Move files with `git mv`**

Run:

```bash
git mv native/backends/fem/src/gpu_state.cpp native/backends/fem/gpu/cuda/state/gpu_state.cpp
git mv native/backends/fem/include/gpu_state.hpp native/backends/fem/gpu/cuda/state/gpu_state.hpp
git mv native/backends/fem/src/kernels.cu native/backends/fem/gpu/cuda/kernels/kernels.cu
git mv native/backends/fem/include/kernels.h native/backends/fem/gpu/cuda/kernels/kernels.hpp
```

- [ ] **Step 3: Add compatibility forwarding headers**

Create `native/backends/fem/include/gpu_state.hpp`:

```cpp
#pragma once

#include "gpu/cuda/state/gpu_state.hpp"
```

Create `native/backends/fem/include/kernels.h`:

```cpp
#pragma once

#include "gpu/cuda/kernels/kernels.hpp"
```

- [ ] **Step 4: Update include paths**

In moved CUDA/C++ files, keep includes simple:

```cpp
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/kernels/kernels.hpp"
```

Files that include old headers may keep old includes during this task because forwarding headers preserve compatibility.

- [ ] **Step 5: Update FEM CMake sources**

Modify `native/backends/fem/CMakeLists.txt` source entries:

```cmake
gpu/cuda/state/gpu_state.cpp
```

and, under `FULLMAG_ENABLE_CUDA`:

```cmake
gpu/cuda/kernels/kernels.cu
```

Remove:

```cmake
src/gpu_state.cpp
src/kernels.cu
```

- [ ] **Step 6: Verify FEM no-CUDA build**

Run:

```bash
cmake --build native/build --target fullmag_fem fem_gpu_state_runtime_contract fem_gpu_rk_plan -j2
env LD_LIBRARY_PATH=/home/kkingstoun/git/fullmag/fullmag/native/build/backends/fem:$LD_LIBRARY_PATH \
  ctest --test-dir native/build/backends/fem -R "fem_(gpu_state_runtime_contract|gpu_rk_plan)$" --output-on-failure
```

Expected: all selected tests PASS.

- [ ] **Step 7: Verify CUDA translation unit syntax**

Run:

```bash
/usr/local/cuda/bin/nvcc -std=c++17 -DFULLMAG_HAS_MFEM_STACK=1 -DFULLMAG_HAS_CUDA_RUNTIME=1 \
  -I native/include -I native/backends/fem -I native/backends/fem/include \
  -c native/backends/fem/gpu/cuda/kernels/kernels.cu -o /tmp/fullmag-fem-kernels-layout.o
```

Expected: command exits 0.

- [ ] **Step 8: Commit**

```bash
git add native/backends/fem native/backends/fem/CMakeLists.txt
git commit -m "refactor: move FEM CUDA state and kernels"
```

## Task 4: Move FEM GPU RK and Exchange

**Files:**

- Move: `native/backends/fem/src/gpu_rk.cpp` -> `native/backends/fem/gpu/cuda/integrators/gpu_rk.cpp`
- Move: `native/backends/fem/src/gpu_rk.cu` -> `native/backends/fem/gpu/cuda/integrators/gpu_rk.cu`
- Move: `native/backends/fem/include/gpu_rk.hpp` -> `native/backends/fem/gpu/cuda/integrators/gpu_rk.hpp`
- Move: `native/backends/fem/src/gpu_exchange.cpp` -> `native/backends/fem/gpu/cuda/interactions/gpu_exchange.cpp`
- Move: `native/backends/fem/include/gpu_exchange.hpp` -> `native/backends/fem/gpu/cuda/interactions/gpu_exchange.hpp`
- Modify: `native/backends/fem/include/gpu_rk.hpp`
- Modify: `native/backends/fem/include/gpu_exchange.hpp`
- Modify: `native/backends/fem/CMakeLists.txt`

- [ ] **Step 1: Create directories**

Run:

```bash
mkdir -p native/backends/fem/gpu/cuda/integrators native/backends/fem/gpu/cuda/interactions
```

- [ ] **Step 2: Move files with `git mv`**

Run:

```bash
git mv native/backends/fem/src/gpu_rk.cpp native/backends/fem/gpu/cuda/integrators/gpu_rk.cpp
git mv native/backends/fem/src/gpu_rk.cu native/backends/fem/gpu/cuda/integrators/gpu_rk.cu
git mv native/backends/fem/include/gpu_rk.hpp native/backends/fem/gpu/cuda/integrators/gpu_rk.hpp
git mv native/backends/fem/src/gpu_exchange.cpp native/backends/fem/gpu/cuda/interactions/gpu_exchange.cpp
git mv native/backends/fem/include/gpu_exchange.hpp native/backends/fem/gpu/cuda/interactions/gpu_exchange.hpp
```

- [ ] **Step 3: Add compatibility forwarding headers**

Create `native/backends/fem/include/gpu_rk.hpp`:

```cpp
#pragma once

#include "gpu/cuda/integrators/gpu_rk.hpp"
```

Create `native/backends/fem/include/gpu_exchange.hpp`:

```cpp
#pragma once

#include "gpu/cuda/interactions/gpu_exchange.hpp"
```

- [ ] **Step 4: Update FEM CMake sources**

Replace source entries:

```cmake
gpu/cuda/interactions/gpu_exchange.cpp
gpu/cuda/integrators/gpu_rk.cpp
```

and, under `FULLMAG_ENABLE_CUDA`:

```cmake
gpu/cuda/integrators/gpu_rk.cu
```

Remove:

```cmake
src/gpu_exchange.cpp
src/gpu_rk.cpp
src/gpu_rk.cu
```

- [ ] **Step 5: Verify no stale FEM GPU paths**

Run:

```bash
rg -n "src/gpu_state|src/gpu_rk|src/gpu_exchange|src/kernels" native/backends/fem
```

Expected: no matches except historical text inside this plan or comments explicitly naming previous paths.

- [ ] **Step 6: Verify FEM contracts**

Run:

```bash
cmake --build native/build --target fem_solver_layout_contract fem_gpu_rk_plan fem_gpu_state_runtime_contract -j2
env LD_LIBRARY_PATH=/home/kkingstoun/git/fullmag/fullmag/native/build/backends/fem:$LD_LIBRARY_PATH \
  ctest --test-dir native/build/backends/fem -R "fem_(solver_layout_contract|gpu_rk_plan|gpu_state_runtime_contract)$" --output-on-failure
```

Expected: all selected tests PASS.

- [ ] **Step 7: Verify CUDA RK syntax**

Run:

```bash
/usr/local/cuda/bin/nvcc -std=c++17 -DFULLMAG_HAS_MFEM_STACK=1 -DFULLMAG_HAS_CUDA_RUNTIME=1 \
  -I native/include -I native/backends/fem -I native/backends/fem/include \
  -c native/backends/fem/gpu/cuda/integrators/gpu_rk.cu -o /tmp/fullmag-fem-gpu-rk-layout.o
```

Expected: command exits 0.

- [ ] **Step 8: Commit**

```bash
git add native/backends/fem native/backends/fem/CMakeLists.txt
git commit -m "refactor: move FEM CUDA RK and exchange"
```

## Task 5: Rename FEM MFEM-to-CUDA Interop Runtime

**Files:**

- Move: `native/backends/fem/cpu/mfem/runtime/gpu_state_runtime.cpp` -> `native/backends/fem/cpu/mfem/interop/cuda_state_runtime.cpp`
- Move: `native/backends/fem/cpu/mfem/runtime/gpu_state_runtime.hpp` -> `native/backends/fem/cpu/mfem/interop/cuda_state_runtime.hpp`
- Modify: `native/backends/fem/cpu/mfem/runtime/gpu_state_runtime.hpp`
- Modify: `native/backends/fem/include/context.hpp`
- Modify: tests that read the runtime source contract
- Modify: `native/backends/fem/CMakeLists.txt`

- [ ] **Step 1: Create directory and move files**

Run:

```bash
mkdir -p native/backends/fem/cpu/mfem/interop
git mv native/backends/fem/cpu/mfem/runtime/gpu_state_runtime.cpp native/backends/fem/cpu/mfem/interop/cuda_state_runtime.cpp
git mv native/backends/fem/cpu/mfem/runtime/gpu_state_runtime.hpp native/backends/fem/cpu/mfem/interop/cuda_state_runtime.hpp
```

- [ ] **Step 2: Add compatibility forwarding header**

Create `native/backends/fem/cpu/mfem/runtime/gpu_state_runtime.hpp`:

```cpp
#pragma once

#include "cpu/mfem/interop/cuda_state_runtime.hpp"
```

- [ ] **Step 3: Update includes**

Replace direct includes:

```cpp
#include "cpu/mfem/runtime/gpu_state_runtime.hpp"
```

with:

```cpp
#include "cpu/mfem/interop/cuda_state_runtime.hpp"
```

Update `native/backends/fem/include/context.hpp` first, then tests and source files.

- [ ] **Step 4: Update contract wording**

In `native/backends/fem/tests/gpu_state_runtime_contract.cpp`, replace text that says GPU-state bootstrap is owned by `gpu_state_runtime.cpp` with text that says MFEM-to-CUDA bootstrap is owned by `cpu/mfem/interop/cuda_state_runtime.cpp`.

- [ ] **Step 5: Update FEM CMake source path**

Replace:

```cmake
cpu/mfem/runtime/gpu_state_runtime.cpp
```

with:

```cmake
cpu/mfem/interop/cuda_state_runtime.cpp
```

- [ ] **Step 6: Verify interop contract**

Run:

```bash
cmake --build native/build --target fem_gpu_state_runtime_contract fem_solver_layout_contract -j2
env LD_LIBRARY_PATH=/home/kkingstoun/git/fullmag/fullmag/native/build/backends/fem:$LD_LIBRARY_PATH \
  ctest --test-dir native/build/backends/fem -R "fem_(gpu_state_runtime_contract|solver_layout_contract)$" --output-on-failure
```

Expected: both tests PASS.

- [ ] **Step 7: Commit**

```bash
git add native/backends/fem
git commit -m "refactor: classify FEM MFEM CUDA interop runtime"
```

## Task 6: Move FEM ABI/Common Sources out of Mixed `src`

**Files:**

- Move: `native/backends/fem/src/api.cpp` -> `native/backends/fem/api/c_api.cpp`
- Move: `native/backends/fem/src/error.cpp` -> `native/backends/fem/api/error.cpp`
- Move: `native/backends/fem/src/context.cpp` -> `native/backends/fem/api/context_facade.cpp`
- Move: `native/backends/fem/src/transfer_audit.cpp` -> `native/backends/fem/core/transfer_audit.cpp`
- Move: `native/backends/fem/src/dmi_weak_residual.cpp` -> `native/backends/fem/core/dmi_weak_residual.cpp`
- Modify: `native/backends/fem/CMakeLists.txt`
- Modify: source facade tests

- [ ] **Step 1: Create API directory**

Run:

```bash
mkdir -p native/backends/fem/api
```

- [ ] **Step 2: Move facade/common files**

Run:

```bash
git mv native/backends/fem/src/api.cpp native/backends/fem/api/c_api.cpp
git mv native/backends/fem/src/error.cpp native/backends/fem/api/error.cpp
git mv native/backends/fem/src/context.cpp native/backends/fem/api/context_facade.cpp
git mv native/backends/fem/src/transfer_audit.cpp native/backends/fem/core/transfer_audit.cpp
git mv native/backends/fem/src/dmi_weak_residual.cpp native/backends/fem/core/dmi_weak_residual.cpp
```

- [ ] **Step 3: Update FEM CMake source paths**

Replace:

```cmake
src/api.cpp
src/context.cpp
src/dmi_weak_residual.cpp
src/error.cpp
src/transfer_audit.cpp
```

with:

```cmake
api/c_api.cpp
api/context_facade.cpp
api/error.cpp
core/dmi_weak_residual.cpp
core/transfer_audit.cpp
```

- [ ] **Step 4: Verify `src/` is empty or absent**

Run:

```bash
find native/backends/fem/src -maxdepth 1 -type f -print
```

Expected: no files.

- [ ] **Step 5: Verify FEM full contract suite**

Run:

```bash
cmake --build native/build --target fullmag_fem -j2
env LD_LIBRARY_PATH=/home/kkingstoun/git/fullmag/fullmag/native/build/backends/fem:$LD_LIBRARY_PATH \
  ctest --test-dir native/build/backends/fem --output-on-failure
```

Expected: all FEM tests PASS.

- [ ] **Step 6: Commit**

```bash
git add native/backends/fem native/backends/fem/CMakeLists.txt
git commit -m "refactor: separate FEM API and core sources"
```

## Task 7: Reorganize FDM CUDA Solver Files

**Files:**

- Move FDM C ABI files from `src/` to `api/`
- Move FDM CUDA runtime files to `gpu/cuda/runtime/`
- Move FDM CUDA interaction kernels to `gpu/cuda/interactions/`
- Move FDM CUDA integrator kernels to `gpu/cuda/integrators/`
- Move FDM reduction/Newell helper kernels to `gpu/cuda/kernels/`
- Modify: `native/backends/fdm/CMakeLists.txt`

- [ ] **Step 1: Create FDM target directories**

Run:

```bash
mkdir -p native/backends/fdm/api native/backends/fdm/core \
  native/backends/fdm/gpu/cuda/runtime \
  native/backends/fdm/gpu/cuda/kernels \
  native/backends/fdm/gpu/cuda/interactions \
  native/backends/fdm/gpu/cuda/integrators
```

- [ ] **Step 2: Move API/runtime files**

Run:

```bash
git mv native/backends/fdm/src/api.cpp native/backends/fdm/api/api.cpp
git mv native/backends/fdm/src/error.cpp native/backends/fdm/api/error.cpp
git mv native/backends/fdm/src/context.cu native/backends/fdm/gpu/cuda/runtime/context.cu
git mv native/backends/fdm/src/device_info.cpp native/backends/fdm/gpu/cuda/runtime/device_info.cpp
```

- [ ] **Step 3: Move FDM interaction kernels**

Run:

```bash
git mv native/backends/fdm/src/exchange_fp32.cu native/backends/fdm/gpu/cuda/interactions/exchange_fp32.cu
git mv native/backends/fdm/src/exchange_fp64.cu native/backends/fdm/gpu/cuda/interactions/exchange_fp64.cu
git mv native/backends/fdm/src/exchange_t0_fp64.cu native/backends/fdm/gpu/cuda/interactions/exchange_t0_fp64.cu
git mv native/backends/fdm/src/exchange_t1_fp64.cu native/backends/fdm/gpu/cuda/interactions/exchange_t1_fp64.cu
git mv native/backends/fdm/src/demag_boundary_fp64.cu native/backends/fdm/gpu/cuda/interactions/demag_boundary_fp64.cu
git mv native/backends/fdm/src/demag_fp32.cu native/backends/fdm/gpu/cuda/interactions/demag_fp32.cu
git mv native/backends/fdm/src/demag_fp64.cu native/backends/fdm/gpu/cuda/interactions/demag_fp64.cu
```

- [ ] **Step 4: Move FDM integrator kernels**

Run:

```bash
git mv native/backends/fdm/src/llg_abm3_fp32.cu native/backends/fdm/gpu/cuda/integrators/llg_abm3_fp32.cu
git mv native/backends/fdm/src/llg_abm3_fp64.cu native/backends/fdm/gpu/cuda/integrators/llg_abm3_fp64.cu
git mv native/backends/fdm/src/llg_dp45_fp32.cu native/backends/fdm/gpu/cuda/integrators/llg_dp45_fp32.cu
git mv native/backends/fdm/src/llg_dp45_fp64.cu native/backends/fdm/gpu/cuda/integrators/llg_dp45_fp64.cu
git mv native/backends/fdm/src/llg_fp32.cu native/backends/fdm/gpu/cuda/integrators/llg_fp32.cu
git mv native/backends/fdm/src/llg_fp64.cu native/backends/fdm/gpu/cuda/integrators/llg_fp64.cu
git mv native/backends/fdm/src/llg_rk23_fp32.cu native/backends/fdm/gpu/cuda/integrators/llg_rk23_fp32.cu
git mv native/backends/fdm/src/llg_rk23_fp64.cu native/backends/fdm/gpu/cuda/integrators/llg_rk23_fp64.cu
git mv native/backends/fdm/src/llg_rk4_fp32.cu native/backends/fdm/gpu/cuda/integrators/llg_rk4_fp32.cu
git mv native/backends/fdm/src/llg_rk4_fp64.cu native/backends/fdm/gpu/cuda/integrators/llg_rk4_fp64.cu
```

- [ ] **Step 5: Move FDM shared CUDA kernels**

Run:

```bash
git mv native/backends/fdm/src/newell_gpu_fp32.cu native/backends/fdm/gpu/cuda/kernels/newell_gpu_fp32.cu
git mv native/backends/fdm/src/newell_gpu_fp64.cu native/backends/fdm/gpu/cuda/kernels/newell_gpu_fp64.cu
git mv native/backends/fdm/src/reductions_fp64.cu native/backends/fdm/gpu/cuda/kernels/reductions_fp64.cu
```

- [ ] **Step 6: Update FDM CMake paths**

Replace every moved `src/...` path in `native/backends/fdm/CMakeLists.txt` with the new path.

Example replacements:

```cmake
api/api.cpp
api/error.cpp
gpu/cuda/runtime/context.cu
gpu/cuda/runtime/device_info.cpp
gpu/cuda/interactions/exchange_fp64.cu
gpu/cuda/interactions/demag_fp64.cu
gpu/cuda/integrators/llg_rk4_fp64.cu
gpu/cuda/kernels/reductions_fp64.cu
```

- [ ] **Step 7: Verify FDM layout contract**

Run:

```bash
cmake --build native/build --target fdm_solver_layout_contract -j2
ctest --test-dir native/build/backends/fdm -R fdm_solver_layout_contract --output-on-failure
```

Expected: `fdm_solver_layout_contract` PASS.

- [ ] **Step 8: Verify FDM tests**

Run:

```bash
ctest --test-dir native/build/backends/fdm --output-on-failure
```

Expected: all configured FDM tests PASS. If CUDA runtime is unavailable, record the exact environment blocker and run at least compile targets that exist in the configured build.

- [ ] **Step 9: Commit**

```bash
git add native/backends/fdm
git commit -m "refactor: organize FDM CUDA solver layout"
```

## Task 8: Update Architecture Docs and Capability References

**Files:**

- Modify: `docs/specs/native-fem-backend-architecture-v1.md`
- Modify: `docs/adr/0014-native-fem-backend-modularization.md` only if the target decision changes
- Modify: `docs/specs/native-solver-catalog-v1.md`
- Modify: `docs/specs/capability-matrix-v0.md` only if any capability status text references stale paths

- [ ] **Step 1: Update FEM architecture layout**

In `docs/specs/native-fem-backend-architecture-v1.md`, make the target layout match actual moved paths:

```text
native/backends/fem/
  api/
  core/
  cpu/mfem/
    interop/
  gpu/cuda/
    runtime/
    state/
    kernels/
    interactions/
    integrators/
    transfer/
```

- [ ] **Step 2: Update solver catalog statuses**

In `docs/specs/native-solver-catalog-v1.md`, change moved entries from `cataloged` to `moved` after tests pass.

- [ ] **Step 3: Search stale path references**

Run:

```bash
rg -n "native/backends/(fdm|fem)/src/(gpu|kernels|exchange|demag|llg|context|api|error)" docs native/backends
```

Expected: no stale references outside migration notes that explicitly say they are historical.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/native-fem-backend-architecture-v1.md docs/specs/native-solver-catalog-v1.md docs/specs/capability-matrix-v0.md
git commit -m "docs: update native solver layout references"
```

## Task 9: Final Verification Gate

**Files:**

- No source files changed in this task.

- [ ] **Step 1: Check moved source references**

Run:

```bash
rg -n "src/gpu_state|src/gpu_rk|src/gpu_exchange|src/kernels|cpu/mfem/runtime/gpu_state_runtime|fdm/src/(exchange|demag|llg|context|device_info|newell|reductions)" native docs
```

Expected: no stale references except this plan or explicit historical migration notes.

- [ ] **Step 2: Build native FEM contracts**

Run:

```bash
cmake --build native/build --target fullmag_fem fem_solver_layout_contract fem_gpu_rk_plan fem_gpu_state_runtime_contract -j2
```

Expected: build exits 0.

- [ ] **Step 3: Run FEM tests**

Run:

```bash
env LD_LIBRARY_PATH=/home/kkingstoun/git/fullmag/fullmag/native/build/backends/fem:$LD_LIBRARY_PATH \
  ctest --test-dir native/build/backends/fem --output-on-failure
```

Expected: all configured FEM tests PASS.

- [ ] **Step 4: Run FDM tests**

Run:

```bash
ctest --test-dir native/build/backends/fdm --output-on-failure
```

Expected: all configured FDM tests PASS. If CUDA hardware or runtime setup blocks execution, record the exact blocked tests and run compile-only targets available in the configured build.

- [ ] **Step 5: Compile moved CUDA FEM translation units**

Run:

```bash
/usr/local/cuda/bin/nvcc -std=c++17 -DFULLMAG_HAS_MFEM_STACK=1 -DFULLMAG_HAS_CUDA_RUNTIME=1 \
  -I native/include -I native/backends/fem -I native/backends/fem/include \
  -c native/backends/fem/gpu/cuda/kernels/kernels.cu -o /tmp/fullmag-fem-kernels-final.o

/usr/local/cuda/bin/nvcc -std=c++17 -DFULLMAG_HAS_MFEM_STACK=1 -DFULLMAG_HAS_CUDA_RUNTIME=1 \
  -I native/include -I native/backends/fem -I native/backends/fem/include \
  -c native/backends/fem/gpu/cuda/integrators/gpu_rk.cu -o /tmp/fullmag-fem-gpu-rk-final.o
```

Expected: both commands exit 0.

- [ ] **Step 6: Check whitespace**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 7: Final commit**

```bash
git add native docs
git commit -m "refactor: complete native solver layout reorganization"
```

## Rollback Plan

Each task is independently revertible by commit.

If a layout move breaks runtime behavior:

1. Revert only the last task commit.
2. Keep `docs/specs/native-solver-catalog-v1.md`.
3. Add the failed path to the catalog with status `blocked`.
4. Record the blocker and the exact failing command in the next plan revision.

## Self-Review

Spec coverage:

- Catalog all current native FDM/FEM solver files: covered by Task 1.
- Prevent future mixed `src/` GPU placement: covered by Task 2.
- Move FEM GPU/CUDA state, kernels, RK, and exchange: covered by Tasks 3 and 4.
- Clarify MFEM-to-CUDA interop ownership: covered by Task 5.
- Separate FEM API/core from solver implementation files: covered by Task 6.
- Reorganize FDM CUDA solver files: covered by Task 7.
- Update long-lived docs and capability references: covered by Task 8.
- Run build/test/source verification: covered by Task 9.

Placeholder scan:

- This plan contains no placeholder markers or unspecified implementation step.

Risk notes:

- FDM tests may require CUDA runtime or device availability depending on the local CMake configuration.
- Full CUDA/MFEM CMake configuration depends on a valid MFEM include/lib prefix. If the managed prefix lacks headers, use the direct `nvcc -c` syntax checks plus no-CUDA contract tests until the environment is repaired.
