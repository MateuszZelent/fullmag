# Native FEM CPU Benchmark Matrix Design

- Status: approved for implementation
- Date: 2026-05-15
- Scope: CPU benchmark harness contract
- Out of scope: GPU optimization, numerical equation changes, collecting real
  benchmark values on this non-MFEM host

## Goal

Make the FEM benchmark harness usable for a CPU-only baseline and make it export
the detailed demag timings required by the latest CPU report.

## Architecture

Keep the existing benchmark problem and analysis script. Add a narrow backend
selection layer:

```text
--backends cpu       -> run only fem_cpu
--backends gpu       -> run only fem_gpu
--backends cpu,gpu   -> current mixed sweep
```

The benchmark result payload and CSV row both carry:

```text
demag_assemble_wall_time_ns
demag_solve_wall_time_ns
demag_recover_wall_time_ns
demag_energy_wall_time_ns
```

For CSV readability, the analysis runner also writes millisecond columns.

For generated-domain demag cases, CSV mesh counts must describe the solver mesh
from `metadata.execution_plan.backend_plan.mesh` when that metadata exists, not
the magnetic-only preset file used as a benchmark token.

When the Fullmag CLI prints a workspace summary instead of forwarding the
Python `BENCHMARK_RESULT`, the runner must load `metadata.json` from the
summary's `artifact_dir` and use that metadata for mesh stats, demag timing,
solver iteration, residual, threading, and provenance columns.

## Validation

Use Python unit tests with fake result objects and fake `metadata.json`:

- benchmark summary includes detailed demag timings,
- runner row carries detailed demag timings from payload or metadata,
- backend resolution accepts CPU-only and rejects unknown names.
- demag rows can prefer execution-plan mesh statistics from `metadata.json`.
- CLI workspace-summary rows can load `metadata.json` from `artifact_dir`.

Then run `py_compile` for the edited scripts.

## Completeness checklist

- [x] `examples/bench_fem_gpu_long.py` emits detailed demag timings.
- [x] `scripts/analysis/fem_gpu_benchmark.py` extracts detailed timings.
- [x] `scripts/analysis/fem_gpu_benchmark.py` accepts CPU-only backend selection.
- [x] `exchange_demag` benchmark authoring uses generated shared-domain mesh.
- [x] `scripts/analysis/fem_gpu_benchmark.py` prefers execution-plan mesh stats.
- [x] `scripts/analysis/fem_gpu_benchmark.py` loads metadata from CLI artifact dirs.
- [x] CPU/harness tests pass.
- [x] Report updated.
