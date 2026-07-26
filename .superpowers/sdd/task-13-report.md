# Task 13 report — opt-in FEM GPU NVTX and repeatable Nsight capture

## Status

**IMPLEMENTED and runtime-verified; authoritative Nsight qualification remains BLOCKED.**

The default-OFF managed bundle is fresh, validator-green, binary-inspected, and passed the complete managed FEM relaxation gate. The opt-in capture is fail-closed and the prior diagnostic ON capture remains unqualified for two independent host-profiler blockers:

1. Nsight Systems recorded all eight required NVTX IDs but exported no CUDA kernel rows (`0` unique kernels).
2. The bounded Nsight Compute access probe reached device 0 and returned the exact error `ERR_NVGPUCTRPERM`.

No current `summary.json.status="captured"` evidence exists. Tasks 16 and 17 therefore remain a **no-go**; range visibility and a green runtime gate do not substitute for kernel attribution and GPU performance counters.

This report is included in the commit with subject `perf: add opt-in FEM GPU Nsight instrumentation`.

## Implemented scope

- Added native, allocation-free NVTX ranges behind `FULLMAG_ENABLE_NVTX`, default `OFF` in CMake, Cargo/native propagation, the exporter, and runtime manifest provenance.
- Added exactly these stable phase IDs:
  - `fem.relax.ncg.step`
  - `fem.relax.armijo`
  - `fem.demag.rhs`
  - `fem.demag.hypre.apply`
  - `fem.demag.recovery`
  - `fem.preview.snapshot`
  - `fem.host.callback`
  - `fem.host.publish`
- Gated the native start/end wrapper definitions themselves on `FULLMAG_ENABLE_NVTX`. OFF native and worker artifacts contain neither wrapper symbols nor phase strings.
- Kept `fem.preview.snapshot` alive from snapshot initiation through asynchronous wait/copy/materialization. Its process-range ID is owned by the pending job and safely ends on the materializer thread.
- Added CUDA memcpy events to the Nsight SQLite timeline and reports separate `preview_with_kernels`, `preview_with_memcpy`, and combined `preview_with_gpu` overlap totals.
- Added managed Nsight Systems and Nsight Compute tooling plus `just capture-fem-gpu-nsight`, with same-image preflight before and after the ON rebuild and atomic restoration of the previous active runtime alias.
- Added a fixed run ID, fixture identity, exact `cuda_api_sum,cuda_gpu_kern_sum,nvtx_sum` reports, deterministic CSV/SQLite artifacts, and fail-closed summaries.
- Read Pass A and Pass B execution identity from their actual `fixture.csv` rows. Pass A must exactly match the fixture ProblemIR, mesh, workload tuple, requested steps, and all 64 executed steps; early completion is recorded and rejected.
- Run the bounded NCU access probe unconditionally before top-five profiling. Every selected-kernel pass has its own 120-second outer timeout and persists exact `ERR_*` codes.
- Require finite numeric metrics for each top-five kernel: achieved occupancy, DRAM/memory bandwidth or throughput, launch-grid dimensions, and warp-stall metrics. Section presence, theoretical occupancy, compute-only throughput, unrelated launch statistics, and nonnumeric values are rejected.
- Added a private runtime-helper sidecar with the SHA-256 of the exact canonical exported ProblemIR, outside the replaceable simulation output directory.
- Replaced indentation-coupled native source assertions with whitespace-independent semantic checks.

## TDD and focused regression evidence

Reviewer remediation started with eight focused RED failures covering wrapper gating, snapshot lifetime, memcpy overlap, actual Pass A identity, unconditional probe ordering, strict metric parsing, exact NCU error retention, and whitespace-independent source checks. Final focused results:

```text
PYTHONPATH=packages/fullmag-py/src \
  python3 -m pytest -q scripts/test_capture_fem_gpu_nsight.py
24 passed

PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q \
  packages/fullmag-py/tests/test_fem_benchmark_config.py \
  -k 'executed_problem_ir_sha256 or runtime_helper_writes_hash_of_exact_exported_problem_ir or analysis_benchmark_rejects_missing_or_malformed_problem_ir_sidecar or script_identity_sidecar_is_outside_replaceable_simulation_output or emit_summary'
9 passed, 253 deselected

bash -n scripts/export_fem_gpu_runtime.sh
PASS

python3 -m py_compile \
  packages/fullmag-py/src/fullmag/runtime/helper.py \
  scripts/analysis/capture_fem_gpu_nsight.py \
  scripts/analysis/fem_gpu_benchmark.py \
  examples/bench_fem_gpu_long.py
PASS

git diff --check
PASS
```

An earlier broad diagnostic run of `test_fem_benchmark_config.py` produced `235 passed, 1 skipped, 26 failed`. Those failures cover pre-existing broader benchmark/native-layout contracts outside Task 13. They were not treated as a pass and were not used as the acceptance gate for this change.

## Prior diagnostic ON capture

Command:

```text
just capture-fem-gpu-nsight
```

Managed tool and bundle identity at capture time:

- Nsight Systems `2024.1.1.0`
- Nsight Compute `2024.1.1.0` build `33998838`
- Docker image ID `sha256:4806867d78b8e94207f6266cb2fa7bafc3778ae69f1bfae1e7659f209b099f59`
- ON manifest SHA-256 `188fdb3c390ecf1b78236c36f76eacbfb52275dacf506db835f784e26298f3d3`
- ON `libfullmag_fem` SHA-256 `9b02ee912d3f9d02c3c34ab50e33e2f0799513a4419208088d9b3f9a70e252bd`
- `instrumentation.nvtx_enabled=true`
- run ID `task13-box500-airbox-ncg-sm89-v1`

Actual execution identities read from the capture CSVs:

| Identity | Pass A compute/run-json | Pass B script/interactive |
|---|---|---|
| ProblemIR SHA-256 | `403afa1214681d3317e23b14f4095dfea6141197cea813655c07d24104fbcc08` | `c66097ebe9def3e9f18bed90553960b5b86a0df0ad8bb6d86b948cba53e24001` |
| Solver mesh SHA-256 | `9c410c3b02cc86d3a832b923f13b5f9b0ec18c4be2babda148697c6dbc9c105a` | same |
| Solver mesh signature | `20a1851a39da191c61cf50006e72c4b977fa31a5a4cdf2dee1e037e93640d431` | same |
| Scenario | `box500_airbox_exchange_demag` | same |
| Integrator | `heun` | same |
| Relaxation | `nonlinear_cg` | same |
| Timestep policy | `fixed` | same |
| Requested/executed steps | `64 / 64` | `64 / 64` |

The ProblemIR hashes intentionally differ because Pass B retains inspected script-authoring provenance. Equivalence is enforced by exact solver-mesh identity and the complete execution tuple; equality is not fabricated.

Observed range counts in that diagnostic capture:

| Range | Compute count | Host count |
|---|---:|---:|
| `fem.relax.ncg.step` | 64 | 64 |
| `fem.relax.armijo` | 64 | 64 |
| `fem.demag.rhs` | 67 | 67 |
| `fem.demag.hypre.apply` | 67 | 67 |
| `fem.demag.recovery` | 67 | 67 |
| `fem.preview.snapshot` | — | 77 |
| `fem.host.callback` | — | 130 |
| `fem.host.publish` | — | 9 |

The persisted summary is `status="failed"` with exact blockers:

```text
compute nsys reported only 0 unique kernels
ncu access probe failed: ERR_NVGPUCTRPERM
```

Artifacts remain under:

```text
.fullmag/reports/task-13-nsight/task13-box500-airbox-ncg-sm89-v1/
```

This capture predates the reviewer hardening of snapshot lifetime, transfer-overlap accounting, actual Pass A validation, and strict NCU metrics. It is retained as diagnostic evidence only and is not presented as qualification of the final code. A new full capture was not repeated because the same image/host still lacks kernel rows and performance-counter permission; the harness remains fail-closed.

## Export-cache defect and symbol hardening

An early nominal OFF export was invalid: its manifest said `nvtx_enabled=false`, but it reused the ON FEM library and retained Task 13 strings. The exporter now:

1. rejects OFF builds that inherit `RUSTFLAGS` containing `fullmag_enable_nvtx`;
2. uses `cargo +nightly clean -p fullmag-fem-sys --release`;
3. asserts zero stale FEM native artifacts after the targeted clean;
4. requires exactly one native FEM build artifact before copying;
5. checks ON phase strings and native-defined/worker-undefined wrappers;
6. forbids OFF phase strings and wrapper symbols across native and worker artifacts;
7. requires the worker dependency on `libfullmag_fem.so.0` and rejects unbundled `libnvToolsExt`/`libnvtx` dependencies.

## Final default-OFF managed proof

Exact commands:

```text
just rebuild-fem-runtime
python3 scripts/validate_managed_fem_runtime_bundle.py \
  --runtime-root .fullmag/runtimes/fem-gpu-host
```

Published identity:

- active variant/manifest SHA-256: `9702a516351700943e31ede31cfebb6833372d63b83cb079219033594880da29`
- source manifest SHA-256: `60b3ee60ba17e9c5ad074d60266c46113441160d8faebb13a2ae93c2658fb099`
- Docker image ID: `sha256:4806867d78b8e94207f6266cb2fa7bafc3778ae69f1bfae1e7659f209b099f59`
- `instrumentation.nvtx_enabled=false`
- OFF `libfullmag_fem` SHA-256: `b2afa1c3550e4b275f04c8138aed160dce782dddc7e594ac4872d38e6938f0f0`
- worker SHA-256: `2d30ecd7b4cd0f29e133737f2c78cd7a898fc7e737fb9cc14d5518517cf7ea4d`
- requested CUDA architectures: `80-real;89-real;90-real;90-virtual`
- validated device: NVIDIA compute capability `8.9`
- HYPRE binding count: `1536`

Independent `strings`, `nm -D`, and `readelf` inspection of the published OFF native library and worker:

```text
fem.relax.ncg.step       0
fem.relax.armijo         0
fem.demag.rhs            0
fem.demag.hypre.apply    0
fem.demag.recovery       0
fem.preview.snapshot     0
fem.host.callback        0
fem.host.publish         0
nm wrapper symbols       0
readelf wrapper symbols  0
NVTX dynamic symbols     0
ScopedRange symbols      0
NVTX shared dependencies 0
worker NEEDED            libfullmag_fem.so.0
```

The ON and final OFF native-library hashes differ.

## Authoritative relaxation verification

Command:

```text
just verify-fem-relaxation-runtime
```

The first sandboxed invocation stopped before container execution because Docker access was denied. The same exact recipe was immediately rerun with the managed Docker permission and passed with exit `0`:

- semantic mesh-ownership source contract passed;
- native relaxation source, energy-derivative, stage-completion, and explicit-RK contracts passed;
- the fresh OFF bundle remained validator-green and was not rebuilt as stale;
- GPU `llg_overdamped`, `projected_gradient_bb`, and `nonlinear_cg` executed on `NVIDIA GeForce RTX 4080 SUPER`, compute capability 8.9, with resolved engine `fem_native_gpu` and four accepted steps;
- CPU `llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg`, and `tangent_plane_implicit` logs validated;
- terminal output: `FEM relaxation runtime smoke completed`.

## Remaining work and handoff

1. Enable NVIDIA performance-counter access for the managed container/host.
2. Diagnose why Nsight Systems 2024.1.1 exports NVTX and CUDA API data but no CUDA kernel table for these managed passes.
3. Rerun `just capture-fem-gpu-nsight` with the same fixed run ID and require `summary.json.status="captured"` with exactly five kernels and all four numeric NCU metric groups per kernel.
4. Only then may Tasks 16 and 17 use this capture as performance evidence.

Two isolated, non-active staging directories remain from interrupted earlier exporter attempts:

```text
.fullmag/runtimes/fem-gpu-host.staging.2510713
.fullmag/runtimes/fem-gpu-host.staging.3512455
```

They are not referenced by the active alias and were not broadly deleted because cleanup is outside this task's proof boundary.

Worktree discipline:

- `.superpowers/sdd/progress.md` was preserved as pre-existing modified controller state.
- `docs/audits/2026-07-25-fem-gpu-performance-remediation-session-handoff.md` was preserved as pre-existing untracked state.
- Only Task 13 files are staged in the required commit; no push is performed.
