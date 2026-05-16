# FEM GPU Exchange-Only Heun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `exchange_only + Heun + lumped_mass` the first verified device-resident FEM GPU hot loop.

**Architecture:** Keep the scope on the existing native FEM GPU scaffolding. Use the already assembled legacy sparse exchange CSR as the temporary GPU operator, upload CSR/mass metadata to `FemGpuState`, execute Heun stages with CUDA kernels, and add explicit device-to-host synchronization only for parity/snapshot copy APIs outside the hot loop.

**Tech Stack:** C++17, CUDA, MFEM native backend, C ABI smoke tests, Rust runner provenance tests, Fullmag physics docs.

---

### Task 1: Planning Artifacts

**Files:**
- Create: `docs/superpowers/specs/2026-05-15-fem-gpu-exchange-only-heun-design.md`
- Create: `docs/superpowers/plans/2026-05-15-fem-gpu-exchange-only-heun.md`

- [x] **Step 1: Record approved narrow GPU hot-loop design**

Expected: spec states `exchange_only + Heun + lumped_mass`, equation
`H_ex = -(2 / (mu0 Ms_i)) * (K_A m)_i / M_lumped_i`, and excludes demag, DMI,
PBC, anisotropy, STT/Oersted, thermal, relaxation, consistent mass, and
partial assembly/libCEED replacement.

### Task 2: RED Gate For Device Source Copy

**Files:**
- Modify: `native/backends/fem/tests/gpu_rk_plan.cpp`
- Modify: `native/backends/fem/include/gpu_state.hpp`
- Modify: `native/backends/fem/src/gpu_state.cpp`

- [x] **Step 1: Add a failing device-source readback test**

Add a test helper that requires a post-GPU-step magnetization readback path to
exist. The test should fail before implementation because no public helper
copies `FemGpuState.m` back to host.

Expected check:

```text
gpu_state_download_magnetization_aos(...) returns true for allocated,
device-source state and reproduces the device m buffer in AOS order.
```

- [x] **Step 2: Run RED**

Run the narrow native smoke if the local native build is available:

```bash
ctest --test-dir native/backends/fem/build -R fem_gpu_rk_plan --output-on-failure
```

Expected before implementation: FAIL at compile or link because
`gpu_state_download_magnetization_aos` is not declared/defined. If the native
build directory or MFEM/CUDA stack is unavailable, record the environment
blocker and still proceed with source-level compilation checks available in
this workspace.

Observed RED: `g++ -std=c++17 -Inative/include -Inative/backends/fem/include
-DFULLMAG_HAS_CUDA_RUNTIME=0 -DFULLMAG_HAS_MFEM_STACK=0 -fsyntax-only
native/backends/fem/tests/gpu_rk_plan.cpp` failed before implementation with
`gpu_state_download_magnetization_aos` not declared.

### Task 3: Device-To-Host Readback Outside Hot Loop

**Files:**
- Modify: `native/backends/fem/include/gpu_state.hpp`
- Modify: `native/backends/fem/src/gpu_state.cpp`
- Modify: `native/backends/fem/include/context.hpp`
- Modify: `native/backends/fem/src/context.cpp`
- Modify: `native/backends/fem/src/api.cpp`

- [x] **Step 1: Add `gpu_state_download_magnetization_aos`**

Implement a helper that:

```text
bool gpu_state_download_magnetization_aos(
    FemGpuState &state,
    std::vector<double> &out_m_xyz,
    TransferAudit &audit,
    std::string &error);
```

Rules:

- returns `true` without changes when `state.allocated == false`,
- fails if device buffers are missing,
- copies `m.x`, `m.y`, `m.z` device arrays to temporary host component arrays,
- interleaves them into `out_m_xyz`,
- records D2H bytes through `record_device_to_host(audit, bytes)`,
- marks `host_state = HostClean` after successful copy,
- leaves `source_of_truth` as `DEVICE_SOURCE_OF_TRUTH` if the device remains authoritative.

- [x] **Step 2: Add context-level sync before field copy**

Add a mutable context helper:

```text
bool context_sync_gpu_magnetization_to_host(Context &ctx, std::string &error);
```

Use it only when:

```text
ctx.gpu_state.allocated &&
ctx.gpu_state.source_of_truth == FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH &&
ctx.gpu_state.host_state == FemGpuSyncState::HostStale
```

This sync is outside the `TransferAuditScopeKind::HotLoop` in the current API
flow, so it must not be used inside RK stage code.

- [x] **Step 3: Wire `fullmag_fem_backend_copy_field_f64`**

Before copying `FULLMAG_FEM_OBSERVABLE_M`, call
`context_sync_gpu_magnetization_to_host(handle->context, handle->last_error)`.
Keep `context_copy_field_f64` read-only after the sync.

### Task 4: Tighten GPU RK Execution Contract

**Files:**
- Modify: `native/backends/fem/src/gpu_rk.cu`
- Modify: `native/backends/fem/src/gpu_rk.cpp`
- Modify: `native/backends/fem/tests/gpu_rk_plan.cpp`

- [x] **Step 1: Preserve explicit source-of-truth promotion**

Keep the existing promotion only when both host and device are clean:

```text
if source != DEVICE && device_state == DeviceClean && host_state == HostClean:
    source = DEVICE
```

Do not upload host data during GPU RK. If the state is host-dirty or mixed, GPU
RK must fail with a clear reason.

- [x] **Step 2: Assert unsupported terms remain blocked**

Extend the smoke test so `gpu_rk_plan_exchange_only` still rejects demag, DMI,
anisotropy, PBC, STT/Oersted, thermal, magnetoelastic, RK4, and consistent
mass before it can report `legacy_sparse_gpu`.

- [x] **Step 3: Ensure stats/provenance distinguish the narrow mode**

The enabled plan must report:

```text
enabled=true
stage_exchange_device_resident=true
exchange_operator_mode=legacy_sparse_gpu
allows_exchange_host_sync=false
uses_cuda_kernels=true
```

### Task 5: Documentation And Audit

**Files:**
- Modify: `docs/physics/0560-all-in-gpu-fem-runtime.md`
- Modify: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
- Modify: `docs/superpowers/plans/2026-05-15-fem-gpu-exchange-only-heun.md`

- [x] **Step 1: Update physics note**

Record that `legacy_sparse_gpu` is a verified first milestone only for
`exchange_only + Heun + lumped_mass` after parity and transfer-audit checks.
Keep demag, DMI, PBC, local terms, relaxation, and partial assembly/libCEED
listed as open.

- [x] **Step 2: Update audit**

Move only the `stage H_ex device-resident for exchange-only Heun` blocker from
open to closed. Do not claim full FEM GPU solver completion.

### Task 6: Verification

**Files:**
- Test: native FEM CTest target `fem_gpu_rk_plan` when available
- Test: Rust runner provenance tests around GPU RK plan

- [x] **Step 1: Run native smoke**

```bash
ctest --test-dir native/backends/fem/build -R fem_gpu_rk_plan --output-on-failure
```

Expected on configured MFEM/CUDA host: PASS. If unavailable locally, record the
exact missing build/environment blocker.

Observed locally:

- `ctest --test-dir native/backends/fem/build -R fem_gpu_rk_plan
  --output-on-failure` could not run because
  `native/backends/fem/build` does not exist in this workspace.
- A source-level fallback executable did pass:
  `g++ ... native/backends/fem/tests/gpu_rk_plan.cpp
  native/backends/fem/src/gpu_rk.cpp native/backends/fem/src/gpu_exchange.cpp
  native/backends/fem/src/gpu_state.cpp -o /tmp/fem_gpu_rk_plan_smoke`, then
  `/tmp/fem_gpu_rk_plan_smoke` printed `FEM gpu_rk_plan smoke PASS`.

- [x] **Step 2: Run source formatting/checks**

```bash
git diff --check
```

Expected: PASS.

Observed: PASS.

- [x] **Step 3: Run targeted Rust tests**

```bash
cargo test -p fullmag-runner gpu_rk_plan -- --nocapture
```

Expected: PASS for runner-side C ABI/provenance mapping.

Observed: the initial command without features matched 0 tests. The real
feature-gated checks passed with `--features fem-gpu`:

- `gpu_rk_plan_info_maps_exchange_only_gate_from_ffi`
- `native_fem_runtime_contract_records_gpu_rk_plan_info`
- `all_in_gpu_request_rejects_unsupported_exchange_operator_mode`
