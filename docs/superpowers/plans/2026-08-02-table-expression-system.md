# Fullmag Table Expression System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace independent global/per-object magnetization reductions with one typed MuMax-style table-expression system whose values are identical in table TXT, v2 Analysis rows, global Telemetry, and explicitly requested object columns.

**Architecture:** Python quantity handles lower to typed `TableExpressionIR` entries. The runner resolves those entries into a `TableExpressionPlan`, evaluates global and object scopes through backend-owned weighted reducers, and publishes one `TableSample` to every table/telemetry sink. FDM and FEM retain separate numerical realizations but share the exact `Ms * measure` reduction contract.

**Tech Stack:** Python dataclasses and ProblemIR, Rust runner/API/CLI, C++ MFEM FEM CPU, CUDA FEM/FDM kernels, v2 OpenAPI schemas, Vitest, pytest, Cargo tests, managed `just` FEM verification.

## Global Constraints

- Global `m` is always the default table expression and is averaged over active ferromagnetic material only.
- The canonical normalized-magnetization weighting is `Ms * physical_measure`; the result is dimensionless.
- Object expressions use realized object ownership and integration measures; node-count averaging and zero-vector skipping are forbidden.
- TXT, v2 table rows, Analysis, and global Footer Telemetry consume one evaluated `TableSample`; no consumer recomputes `m`.
- HTTP v2 remains the browser source of truth; websocket remains invalidation-only.
- Native FEM build and runtime proof start with repository-managed `just` recipes; host Cargo/CMake runs are diagnostics only.
- Existing dirty paths `external_solvers/3`, `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`, and the pre-existing texture-comparison plan remain untouched.

---

### Task 1: Freeze the physical and expression contract

**Files:**
- Modify: `docs/physics/0910-table-autosave-observables.md`
- Modify: `docs/adr/0019-regional-field-drive-and-stage-time-semantics.md` only if its reduction wording conflicts with the new contract
- Test: `packages/fullmag-py/tests/test_table_expression_contract.py` (create)

**Interfaces:**
- Produces the normative equation, units, scope rules, and test fixtures used by all later tasks.

- [ ] **Step 1: Add RED contract tests for the pure expression vocabulary**

Create tests asserting that global `m`, `m.comp("y")`, object `disk.m`, object `disk.m.comp("y")`, and object magnitude have stable expression IDs, units, scopes, and weighting metadata.

- [ ] **Step 2: Run the new Python test file and verify it fails because the expression types do not exist**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python -m pytest packages/fullmag-py/tests/test_table_expression_contract.py -q
```

Expected: collection or assertion failures naming the missing table-expression contract.

- [ ] **Step 3: Update the canonical physics note**

Document:

```text
<m>_S = sum_i(Ms_i * measure_i * m_i) / sum_i(Ms_i * measure_i)
```

Define global and object scopes, zero-vector inclusion, airbox exclusion, FEM shared-node ownership, dimensionless units, and `|<m>|` versus `<|m|>`.

- [ ] **Step 4: Re-run the contract test and record the remaining missing implementation names**

Do not weaken the assertions to match current behavior.

### Task 2: Implement typed Python table expressions and object handles

**Files:**
- Create: `packages/fullmag-py/src/fullmag/model/table_expressions.py`
- Modify: `packages/fullmag-py/src/fullmag/model/study.py`
- Modify: `packages/fullmag-py/src/fullmag/model/structure.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/model/__init__.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Test: `packages/fullmag-py/tests/test_table_expression_contract.py`

**Interfaces:**
- `TableExpression`: immutable typed expression with `to_ir()`, `expression_id`, `scope`, `unit`, `dimension`, and `expanded_columns()`.
- `TableVectorExpression.comp(component: str | int) -> TableScalarExpression`.
- `TableVectorExpression.magnitude() -> TableScalarExpression`.
- `TableExpression` accepts only canonical `m`; scalar handles such as `E_total` lower to existing scalar IDs.
- `TimeEvolution.tableadd(expression)` and `Relaxation.tableadd(expression)` return immutable study copies and preserve the existing cadence.
- `table_add` aliases `tableadd`.
- `Ferromagnet.m` returns an object-scoped table quantity reference without changing `m0` initial-state semantics.
- Flat `MagnetHandle.m` remains assignable; `tableadd()` resolves its owner identity into the same object-scoped reference.

- [ ] **Step 1: Add failing API tests**

Cover:

```python
study = fm.TimeEvolution(dynamics=fm.LLG(), outputs=[]).table_autosave(t_sampl=1e-12)
study = study.tableadd(disk.m)
study = study.tableadd(disk.m.comp("y"))
```

Assert vector expansion, duplicate rejection, stable IDs, and `disk.m` not changing `disk.m0`.

- [ ] **Step 2: Implement the immutable expression dataclasses**

Use stable object IDs, canonical component names `x/y/z`, `unit="1"`, `dimension="normalized_magnetization"`, and `weighting="magnetic_moment"`.

- [ ] **Step 3: Add study-level `tableadd` and default-global behavior**

Keep global `step,t,mx,my,mz,e_total,max_torque` in every default table. Existing string `quantities` remain readable and are normalized into global expressions. New object expressions append rather than replace global columns.

- [ ] **Step 4: Run the focused Python tests**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python -m pytest packages/fullmag-py/tests/test_table_expression_contract.py packages/fullmag-py/tests/test_table_autosave.py -q
```

Expected: all focused expression and existing table-autosave tests pass.

### Task 3: Lower expressions into ProblemIR and script round-trip

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/model/study.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/lib.rs` only if the public IR re-export requires it
- Test: `packages/fullmag-py/tests/test_table_expression_contract.py`
- Test: `packages/fullmag-py/tests/test_api.py`

**Interfaces:**
- `TableAutosaveIR.expressions: Vec<TableExpressionIR>` with compatibility `quantities`.
- `TableExpressionIR::MagnetizationAverage { quantity, scope, object_id, component, reduction }`.
- `TableAutosaveIR::resolved_expressions()` returns the expanded, duplicate-free canonical list.

- [ ] **Step 1: Add RED round-trip tests**

Assert Python -> IR -> loader -> Python preserves global/object scope, object ID, component, magnitude, cadence, and stable column IDs. Assert unknown object IDs and duplicate expanded columns fail before execution.

- [ ] **Step 2: Add serde fields and canonical normalization**

Deserialize old `quantities` into global scalar expressions. Serialize new expressions explicitly. Preserve old scripts without inventing object IDs from display labels.

- [ ] **Step 3: Update canonical script export**

Export object expressions as `study.tableadd(disk.m)` / `.comp("y")` where the source object is available; otherwise emit the stable IR expression form with a safe diagnostic rather than a misleading global column.

- [ ] **Step 4: Run Python and IR tests**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python -m pytest packages/fullmag-py/tests/test_table_expression_contract.py packages/fullmag-py/tests/test_table_autosave.py packages/fullmag-py/tests/test_api.py -q
```

### Task 4: Add runner table-expression planning and sample publication

**Files:**
- Create: `crates/fullmag-runner/src/table_expressions.rs`
- Modify: `crates/fullmag-runner/src/lib.rs`
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-runner/src/table_autosave.rs`
- Modify: `crates/fullmag-runner/src/artifact_pipeline.rs`
- Modify: `crates/fullmag-runner/src/autosave_txt.rs`
- Test: `crates/fullmag-runner/src/table_expressions.rs` (unit tests)
- Test: `crates/fullmag-runner/src/table_autosave.rs`

**Interfaces:**
- `TableExpressionPlan`: expanded columns, scope descriptors, metadata, and backend capability requirements.
- `TableSample`: `step`, `time`, accepted-state coordinate, and `BTreeMap<column_id, f64>` values.
- `TableStore::append_if_due(&TableSample)` and `append_final_if_needed(&TableSample)`.
- `StepStats` keeps global scalar compatibility fields, but table values come from the sample map; `per_object_scalars` is not consulted by `TableStore`.

- [ ] **Step 1: Add RED runner tests with hand-calculated samples**

Use values `(1,0,0)`, `(0,1,0)`, `(0,0,1)` and weights `(1,2,7)` to assert global/object component values, zero-vector denominator behavior, stable expansion order, and identical values supplied to TXT and in-memory rows.

- [ ] **Step 2: Implement plan expansion and metadata**

Make vector expressions expand deterministically to component columns. Include `scope`, `object_id`, `expression_id`, `unit`, `dimension`, `reduction`, and `weighting` in the schema.

- [ ] **Step 3: Change table sinks to consume `TableSample`**

Remove direct `StepStats.mx/my/mz` recomputation from table code. Write TXT headers and `schema.json` with units and scope metadata.

- [ ] **Step 4: Run runner unit tests**

Run with a writable dedicated target:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/table-expression-runner CARGO_INCREMENTAL=0 cargo test -p fullmag-runner table_expressions table_autosave
```

### Task 5: Make FDM reductions implement the shared contract

**Files:**
- Modify: `crates/fullmag-runner/src/scalar_metrics.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference/outputs.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native/observables.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/artifacts.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer/double_precision.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer/single_precision.rs`
- Modify: `crates/fullmag-runner/src/fdm/multilayer.rs`
- Modify: matching production FDM observable owner under `backends/fdm` where current compiled telemetry owns the reduction
- Test: existing FDM scalar metric tests plus new shared reducer tests

**Interfaces:**
- `reduce_magnetic_moment(values, weights, active_mask) -> ReducedVector` includes every active finite state value, including zero vectors.
- `evaluate_fdm_table_expressions(plan, state) -> TableSample` evaluates global and requested object scopes from active cell/region masks.

- [ ] **Step 1: Add failing tests for varying `Ms`, inactive cells, object masks, and active zero vectors**
- [ ] **Step 2: Replace zero-skipping uniform averages in table/telemetry paths**
- [ ] **Step 3: Route all FDM CPU/GPU precision lanes through the shared contract**
- [ ] **Step 4: Verify FDM source-layout and scalar tests**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/table-expression-fdm CARGO_INCREMENTAL=0 cargo test -p fullmag-runner scalar_metrics fdm
```

### Task 6: Implement scope-correct native FEM CPU/GPU reductions

**Files:**
- Create: `backends/fem/cpu/mfem/runtime/table_expression_reduction.hpp`
- Create: `backends/fem/cpu/mfem/runtime/table_expression_reduction.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/step_metrics.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/step_metrics.hpp`
- Create: `backends/fem/gpu/cuda/observables/table_expression_reductions.cu`
- Create: `backends/fem/gpu/cuda/observables/table_expression_reductions.hpp`
- Modify: `backends/fem/gpu/cuda/observables/observable_kernels.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_magnetization_reductions.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_stats_publication.cpp`
- Modify: `backends/fem/src/api.cpp` and `native/include/fullmag_fem.h` only for the new scoped observable ABI
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Test: `backends/fem/tests/table_expression_reduction_contract.cpp` (create)
- Test: `crates/fullmag-runner/src/fem_reference.rs` existing weighted-average tests

**Interfaces:**
- Native backend API accepts a resolved scope descriptor based on object/element ownership, not a raw node list.
- CPU and GPU return weighted component numerators plus one moment denominator; publication divides once.
- Scope weight construction uses the realized FEM element ownership and `Ms` field. Shared nodes receive element-owned contributions.

- [ ] **Step 1: Add RED C++ source contract tests**

Reject the existing node-count C ABI as an authoritative table/object reducer. Assert the new reducer uses scope ownership, `Ms`, measure, and a denominator.

- [ ] **Step 2: Implement CPU scope measure and reduction**

Reuse existing MFEM lumped integration infrastructure without adding cross-cutting physics state to `Context`. Keep reduction ownership in the observables runtime module.

- [ ] **Step 3: Implement GPU scope reduction with CPU-equivalent inputs**

Ensure active zero vectors contribute to `MomentWeight` and that GPU publication uses the same numerator/denominator contract.

- [ ] **Step 4: Remove native object node-average publication**

`attach_native_object_average_m` must consume the new scoped reducer or stop publishing object values when no expression requests them; it must not call `fullmag_fem_backend_average_m_for_nodes_f64` for authoritative table data.

- [ ] **Step 5: Run managed native contract gates**

Inspect the repo `justfile`, then run the matching container-backed FEM contract recipes, including:

```bash
just verify-fem-material-element-ms-contract
just verify-fem-dg0-step-metrics-contract
just verify-fem-relaxation-runtime
```

Use the actual recipe output and managed runtime identity as evidence; host compilation is not final proof.

### Task 7: Publish one sample through CLI, API, Analysis, and Telemetry

**Files:**
- Modify: `crates/fullmag-cli/src/types.rs`
- Modify: `crates/fullmag-cli/src/live_workspace.rs`
- Modify: `crates/fullmag-cli/src/orchestrator.rs`
- Modify: `crates/fullmag-api/src/types.rs`
- Modify: `crates/fullmag-api/src/session.rs`
- Modify: `crates/fullmag-api/src/schemas/tables.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/tables.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs`
- Modify: `apps/control-room/src/modules/footer/FooterTelemetry.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/chartTableModel.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/tableRowsAdapter.ts`
- Modify: `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`
- Test: `crates/fullmag-cli/src/live_workspace.rs`
- Test: `apps/control-room/src/modules/footer/FooterTelemetry.test.tsx` and Analysis table tests

**Interfaces:**
- `ScalarRow` carries expanded expression values and sample provenance while preserving existing global fields.
- `TableColumnMeta` exposes scope, object ID, expression ID, and weighting.
- Footer global values always read the global scalar sample; object values are explicitly scoped.

- [ ] **Step 1: Add RED equality tests**

For a single sample, assert that TXT row values, API table row values, Analysis adapter values, and Footer global values equal bit-for-bit within serialization tolerance and carry the same step/time/expression ID.

- [ ] **Step 2: Extend scalar row/API schema and session upsert**

Preserve same-step replacement and monotonic-step behavior for the expanded value map.

- [ ] **Step 3: Remove object-metric fallback from global Footer magnetization**

Display an explicit unavailable state if the global table sample is absent. Keep selected-object display separate.

- [ ] **Step 4: Run API and frontend tests**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/table-expression-api CARGO_INCREMENTAL=0 cargo test -p fullmag-api object_metrics_endpoint table_rows -- --nocapture
env TMPDIR=/tmp pnpm --dir apps/control-room test -- --run src/modules/analysis-plots src/modules/footer
pnpm --dir apps/control-room typecheck
```

### Task 8: Independent scientific validation and completion gates

**Files:**
- Create: `tests/validation/table_expression_validation.py`
- Create: `tests/validation/fixtures/table_expression_reference.json`
- Modify: `docs/physics/0910-table-autosave-observables.md` with final evidence
- Modify: `docs/audits/2026-08-02-table-txt-analysis-telemetry-magnetization-audit.md` with implementation results

- [ ] **Step 1: Build a reference calculator independent of Fullmag table values**

Read saved mesh/connectivity/material/state artifacts and calculate global/object numerator and denominator directly. Do not import the production reducer.

- [ ] **Step 2: Validate analytical fixtures**

Use uniform fields, opposing domains, varying `Ms`, unequal FEM measures, shared nodes, inactive airbox, and active zero-vector cases. Assert expected values for all components and magnitude.

- [ ] **Step 3: Validate a real FDM and native FEM run**

Compare `table.txt`, v2 rows, Footer global sample, and independent reference at identical `(step,time)`. For native FEM use managed container-backed runtime and record backend/device/build identity.

- [ ] **Step 4: Run complete targeted gates**

Run Python, Rust runner/API, frontend tests/typecheck, `git diff --check`, and all relevant managed `just` recipes. Classify source, compile, unit, managed runtime, device, and scientific reference evidence separately.

- [ ] **Step 5: Perform the completion audit**

Search for remaining authoritative calls to `average_m_for_nodes`, `apply_average_m_to_step_stats`, object node-count averaging, and Footer object fallback. No remaining path may independently redefine table/global telemetry semantics.
