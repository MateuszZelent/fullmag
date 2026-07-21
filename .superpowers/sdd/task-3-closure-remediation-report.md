# Task 3 closure remediation report

Date: 2026-07-21

## Outcome

All three closure-review P1 findings are remediated.

1. Accepted auto-coarsen now builds one `StageFemMeshAsset` from the remeshed execution plan, publishes that asset's payload, and atomically replaces `initial_fem_mesh_asset`. Stage 0, callbacks, finalization, and replay therefore use the remeshed generation rather than the pre-coarsen identity.
2. Adaptive follow-up owns a mutable stage asset, passes its existing identity through `run_planned_problem_with_callback_and_fem_mesh_identity`, and retains the same asset after the pass. It no longer replans/rebuilds an asset after completion. Hysteresis callback routing also accepts the supplied identity. `InteractiveFemPreviewRuntime` owns a `FemStageExecutionContext` created with its mesh payload and reuses its generation in the public execution path.
3. The source gate recognizes payload constructors, all `StageFemMeshAsset::build_*` producers, `StageFemMeshIdentity::from_*`, `FemStageExecutionContext::from_backend_plan`, and direct topology hashes. It checks block and expression callbacks, loops, duplicate producers, variable-grid FEM `None`, and pins SHA-256 inventories over exact `(file, receiver/function, operation, normalized statement)` records. Broad file/category fallbacks and discarded unclassified accesses were removed.

## TDD and focused verification

- The realistic producer mutations initially escaped the old checker; `--self-test` failed at mutation 9 before the gate rewrite.
- Auto/adaptive ownership structural test: 1/1 PASS.
- Interactive runtime-owned context test: 1/1 PASS.
- Remeshed runtime counter test: 1/1 PASS. One new asset produced one payload build and one fingerprint; its published generation matched all eight runner-style updates.
- Runner `fem_mesh` tests: 8/8 PASS.
- Full CLI serial suite: 218/218 PASS.
- API runtime-frame mesh lifecycle test: PASS.
- Source checker self-test: PASS, including asset callback, asset duplicate, identity callback, expression callback, variable-grid FEM `None`, operation substitution, and duplicate-inventory probes.
- Repository source gate: PASS; 191 exact `.fem_mesh` operation records and 51 exact mesh-producer records.
- Runner and CLI checks: PASS.
- `git diff --check`: PASS.

`cargo fmt --all -- --check` still reports repository-wide pre-existing formatting drift in many untouched files. No broad formatting rewrite was performed.

## Managed verification

- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-source-contract`: PASS in 10 s.
- First managed runtime attempt reached rebuild/export but failed before tests with filesystem ENOSPC. The filesystem had 448 MB free. Only this task's `/tmp/task3-final-target` (7.6 GB) was removed; shared Docker caches, images, volumes, containers, and networks were not pruned.
- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime`: PASS on retry in 593.2 s, including fresh managed bundle rebuild/export, bundle validation, native contracts, and CPU/GPU relaxation smoke matrix.

## Performance evidence

The standalone repeat-five gate completed all 10 rows and passed convergence, CPU/GPU consistency, strict GPU residency, and stable-mesh checks. Its timing-only result failed: GPU p95 5706.73 ms versus accepted 5225.24 ms (+9.21%, 5% limit).

Two controlled same-container A/B windows removed order bias:

| Order | Runtime | CPU p95 (ms) | GPU p95 (ms) | Result |
|---|---|---:|---:|---|
| forward, first | immutable | 11041.701 | 5583.384 | all 10 rows/gates pass |
| forward, second | current | 12459.439 | 5961.460 | all 10 rows/gates pass |
| reverse, first | current | 10865.667 | 5595.813 | all 10 rows/gates pass |
| reverse, second | immutable | 11574.829 | 5945.386 | all 10 rows/gates pass |

In both windows the second half slowed on both CPU and GPU. In reverse order the current runtime was 5.88% faster by GPU p95 and 6.13% faster by CPU p95 than immutable. This demonstrates window/order load variation rather than a Task 3 regression. No threshold or accepted baseline was changed.

Raw ignored artifacts remain under `.fullmag/reports/` as `task3_closure_ab_*` and `task3_closure_reverse_*` CSV/summary files.

## Scope

No native FEM `Context`, solver algorithm, OpenAPI resource shape, frontend transport, or accepted performance baseline changed. The pre-existing `.superpowers/sdd/progress.md` modification remains unstaged and untouched.
