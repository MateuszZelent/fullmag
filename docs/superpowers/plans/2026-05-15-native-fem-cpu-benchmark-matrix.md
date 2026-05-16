# Native FEM CPU Benchmark Matrix Implementation Plan

**Goal:** Make the existing FEM benchmark harness collect CPU-only baseline rows
and carry detailed Poisson-demag timings.

**Architecture:** Keep the existing benchmark script, add backend selection and
phase-timing extraction. Do not change solver equations or GPU runtime code.

---

### Task 1: Physics And Design Artifacts

**Files:**
- Create: `docs/physics/0818-native-fem-cpu-benchmark-matrix.md`
- Create: `docs/superpowers/specs/2026-05-15-native-fem-cpu-benchmark-matrix-design.md`
- Create: `docs/superpowers/plans/2026-05-15-native-fem-cpu-benchmark-matrix.md`

- [x] **Step 1: Record benchmark-only contract**

Expected: docs state no physics changes and define CPU-only benchmark needs.

### Task 2: RED Tests

**Files:**
- Modify: `packages/fullmag-py/tests/test_fem_benchmark_config.py`

- [x] **Step 1: Add failing tests**

Tests must assert:

- benchmark summary emits detailed demag timing fields,
- analysis runner row exposes detailed demag timing milliseconds,
- `resolve_backends("cpu")` returns CPU-only,
- `exchange_demag` authoring uses generated shared-domain mesh,
- metadata execution-plan mesh stats override magnetic-only input mesh stats.
- CLI workspace-summary rows load `metadata.json` from `artifact_dir`.

- [x] **Step 2: Run RED**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_fem_benchmark_config.py \
  -k "demag_phase_timing or resolve_backends"
```

Expected: fail before implementation.

### Task 3: Implement Benchmark Contract

**Files:**
- Modify: `examples/bench_fem_gpu_long.py`
- Modify: `scripts/analysis/fem_gpu_benchmark.py`

- [x] **Step 1: Emit detailed timing fields**

`BENCHMARK_RESULT` carries the four detailed demag timing fields when present.

- [x] **Step 2: Extract detailed timing fields**

CSV rows include millisecond columns for assemble, solve, recover, and energy.

- [x] **Step 3: Add CPU-only backend selection**

`--backends cpu` runs only the CPU lane.

- [x] **Step 4: Keep demag on shared-domain mesh**

`exchange_demag` no longer passes the magnetic-only preset mesh directly to the
FEM demag solve. It requests a generated shared-domain mesh with air and forces
the FEM runtime target.

- [x] **Step 5: Prefer actual solver mesh stats**

CSV rows keep the benchmark token path but replace mesh name/counts with
`metadata.execution_plan.backend_plan.mesh` when runtime metadata is available.

- [x] **Step 6: Load metadata from CLI artifact dirs**

When the CLI prints a workspace summary instead of a Python `BENCHMARK_RESULT`,
the analysis runner parses `artifact_dir` and loads `metadata.json` from that
directory before filling demag timing and provenance columns.

### Task 4: Report Update

**Files:**
- Modify: `docs/reports/15.05.2026/fem-cpu-module-implementation-report.md`

- [x] **Step 1: Mark harness source-level closure**

Report must say the CPU benchmark harness can carry demag timings, while real
demag solve values are blocked locally by Open MPI/PMIx socket initialization.

### Task 5: Verification

- [x] **Step 1: Run targeted tests**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_fem_benchmark_config.py \
  -k "shared_domain_mesh_contract or demag_phase_timing or resolve_backends or execution_plan_mesh_stats or metadata_from_cli_artifact_dir"
```

- [x] **Step 2: Compile scripts**

```bash
python3 -m py_compile examples/bench_fem_gpu_long.py scripts/analysis/fem_gpu_benchmark.py
```

- [x] **Step 3: Run source checks**

```bash
git diff --check
```

- [x] **Step 4: Run CPU preflight and smoke**

```bash
python3 scripts/analysis/fem_gpu_benchmark.py --preflight-only --backends cpu
python3 scripts/analysis/fem_gpu_benchmark.py --backends cpu --meshes coarse \
  --scenarios exchange_only --integrators heun --steps 1 \
  --output /tmp/fullmag_fem_cpu_benchmark_smoke.csv --require-mfem-stack
```

Expected locally: preflight finds the prebuilt native FEM library and
`exchange_only` produces an `ok` CPU row.

- [x] **Step 5: Confirm sandbox demag runtime blocker**

```bash
FULLMAG_BENCH_MESH=examples/assets/box_40x20x10_coarse.mesh.json \
FULLMAG_BENCH_SCENARIO=exchange_demag \
FULLMAG_BENCH_INTEGRATOR=heun \
FULLMAG_BENCH_STEPS=1 \
FULLMAG_BENCH_DT=1e-13 \
FULLMAG_FEM_EXECUTION=cpu \
.fullmag/local/bin/fullmag examples/bench_fem_gpu_long.py --headless
```

Expected locally: shared-domain materialization and `fem_cpu_native` resolution
succeed; Open MPI/PMIx fails during `MPI_Init_thread` because the sandbox cannot
open the required socket.

- [x] **Step 6: Confirm unsandboxed CPU demag smoke and CSV**

```bash
python3 scripts/analysis/fem_gpu_benchmark.py --backends cpu --meshes coarse \
  --scenarios exchange_demag --integrators heun --steps 1 \
  --output /tmp/fullmag_fem_cpu_demag_benchmark_smoke.csv --require-mfem-stack
```

Expected outside the sandbox: row has `status=ok`, `mesh_name=study_domain`,
demag phase timing columns, `demag_actual_iterations`, and
`demag_final_residual_norm`.
