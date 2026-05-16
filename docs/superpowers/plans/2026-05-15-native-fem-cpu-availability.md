# Native FEM CPU Availability Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `fem_cpu_native` availability independent from native FEM GPU/CUDA availability.

**Architecture:** Preserve the existing C ABI availability struct, but consume its CPU and GPU fields separately. Dispatch may choose or fall back to CPU only when the CPU field is true; GPU availability remains GPU-specific.

**Tech Stack:** Rust runner/CLI, native FEM C ABI, Fullmag capability docs.

---

### Task 1: Physics And Design Artifacts

**Files:**
- Create: `docs/physics/0816-native-fem-cpu-availability-contract.md`
- Create: `docs/superpowers/specs/2026-05-15-native-fem-cpu-availability-design.md`
- Create: `docs/superpowers/plans/2026-05-15-native-fem-cpu-availability.md`

- [x] **Step 1: Record CPU-only availability contract**

Expected: docs distinguish `native_fem_cpu_available` from `native_fem_gpu_available`, state no physics equations change, and mark MFEM-host runtime smoke as deferred on this workstation.

### Task 2: RED Dispatch And Public Probe Tests

**Files:**
- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `crates/fullmag-runner/src/lib.rs`

- [x] **Step 1: Add failing dispatch tests**

Add tests that construct synthetic native FEM availability records:

```rust
fn native_fem_availability_for_test(
    cpu: bool,
    gpu: bool,
    reason: &str,
) -> native_fem::GpuAvailability {
    native_fem::GpuAvailability {
        available: gpu,
        built_with_mfem_stack: cpu || gpu,
        built_with_cuda_runtime: gpu,
        built_with_ceed: false,
        native_fem_cpu_available: cpu,
        native_fem_gpu_available: gpu,
        mfem_cuda_available: gpu,
        hypre_gpu_available: false,
        libceed_used_hot_path: false,
        visible_cuda_device_count: if gpu { 1 } else { 0 },
        requested_gpu_index: -1,
        resolved_gpu_index: if gpu { 0 } else { -1 },
        reason: reason.to_string(),
    }
}
```

The tests must prove:

```rust
cpu_fem_policy_uses_cpu_availability_without_gpu()
gpu_fem_fallback_requires_cpu_availability()
auto_fem_without_any_native_availability_fails()
```

- [x] **Step 2: Run RED**

```bash
cargo test -p fullmag-runner cpu_availability -- --nocapture
```

Expected: FAIL because the CPU availability helper / injected dispatch helper does not exist yet.

### Task 3: Rust Availability Split

**Files:**
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `crates/fullmag-runner/src/lib.rs`

- [x] **Step 1: Add CPU probe**

Implement:

```rust
pub(crate) fn is_cpu_available() -> bool {
    native_availability().native_fem_cpu_available
}
```

Keep:

```rust
pub(crate) fn is_gpu_available() -> bool {
    native_availability().native_fem_gpu_available
}
```

and export:

```rust
pub fn is_native_fem_cpu_available() -> bool
pub fn is_native_fem_time_domain_available() -> bool
```

with time-domain availability delegated to CPU availability.

### Task 4: Dispatch CPU Fallback Guard

**Files:**
- Modify: `crates/fullmag-runner/src/dispatch.rs`

- [x] **Step 1: Extract availability-aware resolver**

Production `resolve_fem_engine_with_trail()` should call the extracted helper
with live native availability. Tests should call the same helper with synthetic
availability.

- [x] **Step 2: Guard CPU selection**

Requested CPU and non-forced fallback to CPU must fail when
`native_fem_cpu_available=false`.

### Task 5: Native ABI Semantics

**Files:**
- Modify: `native/backends/fem/src/api.cpp`

- [x] **Step 1: Preserve CPU availability when CUDA is absent**

When MFEM stack exists but CUDA runtime does not, leave
`native_fem_cpu_available=1`, `native_fem_gpu_available=0`, and return a reason
that says CPU is available while GPU is unavailable.

- [x] **Step 2: Make generic availability mean any native FEM lane**

`fullmag_fem_is_available()` should return true when either CPU or GPU native
FEM is available.

### Task 6: Docs And Report

**Files:**
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/reports/15.05.2026/fem-cpu-module-implementation-report.md`
- Modify: `docs/physics/0816-native-fem-cpu-availability-contract.md`
- Modify: `docs/superpowers/specs/2026-05-15-native-fem-cpu-availability-design.md`
- Modify: `docs/superpowers/plans/2026-05-15-native-fem-cpu-availability.md`

- [x] **Step 1: Mark P0 source-level closure**

Docs should say CPU availability is separated source-side, while MFEM-host
runtime smoke remains blocked on this workstation.

### Task 7: Verification

**Files:**
- Test: `crates/fullmag-runner`
- Test: native source check

- [x] **Step 1: Run focused tests**

```bash
cargo test -p fullmag-runner cpu_availability -- --nocapture
```

Expected: PASS.

- [x] **Step 2: Run CLI local resolution tests**

```bash
cargo test -p fullmag-cli local_engine_resolution -- --nocapture
```

Expected: PASS.

- [x] **Step 3: Run source checks**

```bash
git diff --check
```

Expected: PASS.

- [x] **Step 4: Record MFEM-host blocker**

```bash
scripts/check_mfem_host_env.sh
```

Expected on this workstation: FAIL with missing `MFEMConfig.cmake` /
`mfem-config.cmake`; do not claim full native runtime parity locally.
