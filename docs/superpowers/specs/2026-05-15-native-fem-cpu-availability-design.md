# Native FEM CPU Availability Split Design

- Status: approved for implementation
- Date: 2026-05-15
- Scope: local runtime/capability resolution for `fem_cpu_native`
- Out of scope: GPU optimization, CUDA kernels, libCEED QFunctions, MFEM-host
  runtime smoke, benchmark execution

## Goal

Make `fem_cpu_native` availability independent from native FEM GPU/CUDA
availability so the CPU FEM module can be benchmarked and diagnosed on its own
contract.

## Architecture

Keep the C ABI struct fields `native_fem_cpu_available` and
`native_fem_gpu_available` as the source of truth. The Rust wrapper will expose
separate probes:

```text
is_native_fem_cpu_available()
is_native_fem_gpu_available()
is_native_fem_time_domain_available()
```

`is_native_fem_time_domain_available()` must follow CPU availability because the
time-domain CPU lane is `fem_cpu_native`. GPU availability remains a separate
predicate for choosing `fem_native_gpu`.

## Dispatch Rules

- Requested CPU: select `FemEngine::CpuNative` only when CPU availability is
  true; otherwise fail with a native FEM CPU diagnostic.
- Requested GPU / all-in-GPU: select GPU only when GPU availability is true;
  forced GPU still fails if unavailable.
- Non-forced GPU fallback and auto fallback: use CPU only if CPU availability is
  true.
- CPU fallback must not be reported when both CPU and GPU native FEM are
  unavailable.

## Files

- `native/backends/fem/src/api.cpp`: keep CPU availability true after MFEM stack
  detection even when CUDA support is absent; make `fullmag_fem_is_available`
  mean any native FEM lane is available.
- `crates/fullmag-runner/src/native_fem.rs`: add CPU probe and make GPU probe
  use the GPU-specific field.
- `crates/fullmag-runner/src/lib.rs`: export CPU probe and make time-domain FEM
  availability use it.
- `crates/fullmag-runner/src/dispatch.rs`: use CPU availability before selecting
  or falling back to `FemEngine::CpuNative`.
- `crates/fullmag-cli/src/main.rs`: local script/runtime resolution already
  consumes `is_native_fem_time_domain_available`; it should inherit the CPU
  probe behavior.
- `docs/specs/capability-matrix-v0.md`: record the split.
- `docs/reports/15.05.2026/fem-cpu-module-implementation-report.md`: update P0
  status.

## Validation

Because this workstation lacks MFEM/hypre, the implementation must use pure
dispatch tests with synthetic availability records plus local source checks.
Runtime smoke remains blocked until an MFEM/hypre host is available.

## Completeness Checklist

- [x] CPU-only synthetic availability resolves CPU FEM.
- [x] GPU-unavailable synthetic availability falls back to CPU only when CPU is
  available.
- [x] No-native synthetic availability fails instead of reporting CPU fallback.
- [x] Public time-domain FEM availability follows CPU probe.
- [x] Docs report CPU-only scope and MFEM-host blocker.
