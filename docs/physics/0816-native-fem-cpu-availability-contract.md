# Native FEM CPU Availability Contract

- Status: implementation note
- Owners: Fullmag core
- Last updated: 2026-05-15
- Related specs:
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/runtime-engine-naming-v0.md`
- Related report:
  - `docs/reports/15.05.2026/fem-cpu-module-implementation-report.md`

## 1. Problem statement

The production FEM CPU lane is `fem_cpu_native`: the MFEM/hypre time-domain
runtime using the CPU device. Its availability must be decided by the presence
of the native FEM CPU stack, not by CUDA runtime visibility or GPU device
probing.

The current CPU optimization phase needs a stable CPU baseline before any GPU
comparison. A CPU-capable MFEM/hypre build with no CUDA device must therefore
advertise:

```text
native_fem_cpu_available = true
native_fem_gpu_available = false
```

and time-domain FEM CPU resolution must still select `fem_cpu_native`.

## 2. Physical model

This change does not alter equations, field definitions, material units,
boundary conditions, or solver tolerances. It changes only the runtime
capability contract used before execution.

## 3. Execution semantics

### 3.1 CPU lane

`native_fem_cpu_available` means:

- the native FEM library was built with the MFEM stack required by the CPU
  time-domain backend,
- `fem_cpu_native` may execute CPU FEM time-domain plans,
- CUDA runtime support, visible CUDA devices, and MFEM CUDA device support are
  not prerequisites.

The current runtime family for this lane is:

```text
native_fem_runtime_family = mfem_cpu_legacy_sparse
native_fem_assembly_mode = legacy_sparse
```

### 3.2 GPU lane

`native_fem_gpu_available` remains separate and requires the GPU-specific
conditions: CUDA runtime, MFEM CUDA device support, visible selected GPU, and
any requested CEED support. GPU unavailability may fall back to CPU only when
`native_fem_cpu_available` is true and the request is not a strict forced GPU
request.

### 3.3 Failure behavior

- `FULLMAG_FEM_EXECUTION=cpu` must fail clearly if
  `native_fem_cpu_available=false`.
- `FULLMAG_FEM_EXECUTION=gpu` / `all_in_gpu` must fail when GPU is unavailable.
- Non-forced `gpu` or `auto` may fall back to `fem_cpu_native` only when
  `native_fem_cpu_available=true`.
- A launcher built without the native FEM FFI stack must not advertise local
  time-domain FEM availability.

## 4. API, IR, planner, and provenance impact

- Python API: no change.
- `ProblemIR`: no schema change.
- Planner: no physics legality change.
- Runtime/capability vocabulary: distinguish CPU and GPU native FEM
  availability explicitly.
- Provenance: existing `resolved_engine_id`, `fem_assembly_mode`, requested
  device, and fallback reason remain the evidence for resolved execution.

## 5. Validation strategy

Local tests can validate the decision logic without MFEM by injecting synthetic
availability records:

1. CPU available + GPU unavailable selects `fem_cpu_native` for CPU requests.
2. CPU available + GPU unavailable lets non-forced GPU requests fall back to
   `fem_cpu_native`.
3. CPU unavailable + GPU unavailable fails instead of pretending a CPU fallback
   exists.
4. The public `is_native_fem_time_domain_available()` is an alias for the CPU
   availability probe, not for the GPU probe.

Full runtime smoke for `exchange_only` and `exchange_demag` still requires a
host with MFEM/hypre.

## 6. Completeness checklist

- [x] Native FFI availability keeps CPU and GPU fields independent.
- [x] Rust wrapper exposes a CPU availability probe.
- [x] Time-domain FEM availability uses the CPU probe.
- [x] Dispatch fallback to CPU is allowed only when CPU is available.
- [x] CLI local engine resolution uses CPU availability for `fem_cpu_native`.
- [x] CPU report and capability matrix reflect the split.
- [x] Local logic tests pass.
- [ ] MFEM-host runtime smoke remains explicitly deferred when MFEM is absent.

## 7. Deferred work

- Full native CPU smoke on an MFEM/hypre host.
- CPU benchmark matrix from the FEM CPU implementation report.
- Demag hot-path profile and optimization after CPU availability is reliable.
