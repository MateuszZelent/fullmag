# FEM solver optimization remediation ledger

This ledger is the only current remediation state. Historical measurements and
accepted baselines listed below are diagnostic-only until a task records the
same typed mesh, tolerance, source commit, runtime manifest, and decision.

- `audit_base_commit`: `17a7e341477e9b64493b8da0ed3179fd6233ee49`
- `implementation_base_commit`: `eee245ac200bf138d880b793791848106b7386ba`
- `origin_master_at_start`: `eee245ac200bf138d880b793791848106b7386ba`
- `source_drift_reviewed_at`: `2026-08-02T03:35:11+02:00`
- `overlapping_owner_changes`: recorded per task below; no historical finding is
  classified `finding_already_fixed` without a new regression test and runtime
  evidence.

## Source-drift review

The audit base is an ancestor of the implementation base. The changed owners
include FEM typed mesh and contracts, CPU runtime identity, GPU Poisson and
relaxation, GPU state runtime, runner planning/runtime/artifacts, managed
runtime scripts, capability matrix, and `justfile`. The historical re-audit
and `.fullmag/audit-2026-07-29/` are not present in this fresh worktree, so the
review uses the audit-base diff and conservatively requires each overlapping
future task to refresh its scope before implementation.

| Task | owner overlap | classification |
| --- | --- | --- |
| T1 | `backends/fem/gpu/cuda/relaxation`, runner FEM relaxation | task_update_required |
| T2 | `backends/fem/core/fem_mesh.*`, `crates/fullmag-plan/src/mesh.rs` | task_update_required |
| T3 | `backends/fem/gpu/cuda/demag_poisson/*` | task_update_required |
| T4 | GPU relaxation direct-energy and nonlinear-CG owners | task_update_required |
| T5 | GPU state runtime and runner artifacts | task_update_required |
| T6 | CPU MFEM runtime build identity and managed-runtime scripts | task_update_required |
| T7 | `crates/fullmag-runner/src/fem/relax/*`, `backends/fem` tests | task_update_required |
| T8 | GPU relaxation source contracts and transfer audit | task_update_required |
| T9 | LLG qualification registry, exact artifact/runtime binding, runner identity, API/UI diagnostics | scope_refreshed |
| T10 | managed runtime manifest and export scripts | task_update_required |
| T11 | RK transaction owners, native step stats, GPU rollback contracts | scope_refreshed |
| T12 | HYPRE stream interop, demag telemetry, Nsight preflight | scope_refreshed |
| T13 | Nsight capture script and GPU runtime owner | task_update_required |
| T14 | GPU Poisson policy and performance recipes | task_update_required |
| T15 | planner capability/selection and runner artifacts | task_update_required |
| T16 | GPU runtime and `justfile` capture/verification recipes | task_update_required |
| T17 | GPU Poisson, typed mesh, and FEM relaxation owners | task_update_required |
| T18 | runner artifact pipeline, runtime provenance, `justfile` | task_update_required |
| T19 | GPU state runtime, relaxation controls, diagnostics | task_update_required |
| T20 | typed mesh, planner mesh lowering, FEM contracts | task_update_required |
| T21 | runtime selection, source snapshot, managed manifest scripts | task_update_required |
| T22 | capability matrix, runner capabilities, runtime selection | task_update_required |
| T23 | end-to-end FEM performance recipe and artifact provenance | task_update_required |

## Quarantined evidence

| Artifact or artifact set | classification | boundary |
| --- | --- | --- |
| `.fullmag/audit-2026-07-29/**` | `diagnostic_only` | The path is absent from the implementation worktree; every artifact under this historical prefix remains quarantined by prefix and must not be copied, removed, or used as a current baseline. |
| `benchmarks/fem-gpu/accepted/rtx4080-sm89/benchmark.csv` | `diagnostic_only` | Historical accepted baseline; not a same-tolerance, typed-mesh qualification for this ledger. |
| `benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json` | `diagnostic_only` | Historical environment description; no current runtime-manifest binding. |
| `benchmarks/fem-gpu/accepted/rtx4080-sm89/summary.json` | `diagnostic_only` | Historical summary; not a promotion input. |

## Task ledger

Evidence paths are repository-relative and separated by `;`. A non-pending
task requires an exact 40-character source commit. A completed task requires
at least one existing evidence path and cannot be blocked by measurement.

| Task | status | source_commit | runtime_manifest_sha256 | evidence | decision | commit | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T0 | completed | eee245ac200bf138d880b793791848106b7386ba |  | scripts/test_validate_fem_solver_optimization_ledger.py; scripts/validate_fem_solver_optimization_ledger.py | promote | commit follows this ledger closure | Ledger, parser, RED/green tests, and recipe are present. |
| T1 | blocked | 0693557a7a9ce38ac5939f3c2cd42ab0a260f9db |  | scripts/test_validate_fem_relaxation_runtime_log.py; scripts/analysis/fem_gpu_benchmark.py; justfile | blocked_by_measurement | 0693557a7a9ce38ac5939f3c2cd42ab0a260f9db | Typed v2 validator, canonical execution-plan export path, generator, and strict-builder recipe are implemented; source tests pass (`7` focused, `370` module). Immutable v2 generation and managed strict-builder execution remain blocked by the incorrect `/zfn2` durable mount, so no static v2 artifact was copied or fabricated. |
| T2 | blocked | f8c9adc229f5c8322004ffd11d4ab16314da510b |  | scripts/test_validate_fem_relaxation_runtime_log.py; scripts/validate_fem_demag_mesh_airbox_convergence.py; scripts/analysis/fem_gpu_benchmark.py; scripts/analysis/capture_fem_gpu_nsight.py | blocked_by_measurement | f8c9adc229f5c8322004ffd11d4ab16314da510b | Typed topology stats, canonical solver signature v2, explicit input/solver counts, fail-closed file comparison, fixture/convergence/Nsight propagation are implemented. Source gates pass (`374` relaxation tests; `7` convergence tests; `24` capture tests). Managed v2 fixture and runtime benchmark remain blocked by the incorrect `/zfn2` durable mount. |
| T3 | completed | 7208e493a51eba7cfbc10491963d3dd069c391fe |  | scripts/test_validate_fem_relaxation_runtime_log.py; scripts/analysis/fem_gpu_benchmark.py; scripts/verify_fem_relaxation_consistency_semantics.py; justfile | promote | 7208e493a51eba7cfbc10491963d3dd069c391fe | Direct-minimizer pairs now report `coverage_only`, never `pass`, and the separate equilibrium-parity gate fails closed until T4 performs same-tolerance state comparison. Source module tests (`377`), dependency-free host verifier, and managed-container verifier pass. |
| T4 | blocked | 01837fb0c22c60e1152906ea6c0f738d7f5e49d2 |  | scripts/validate_fem_relaxation_equilibrium_parity.py; scripts/test_validate_fem_relaxation_equilibrium_parity.py; scripts/verify_fem_relaxation_equilibrium_parity_semantics.py; scripts/analysis/fem_gpu_benchmark.py; examples/bench_fem_gpu_long.py; examples/assets/fem_performance/equilibrium_qualification_suite_v1.json; docs/physics/0580-canonical-relaxation-equilibrium-contract.md; docs/physics/0580-canonical-relaxation-equilibrium-contract.source-map.json; justfile | blocked_by_measurement | 01837fb0c22c60e1152906ea6c0f738d7f5e49d2 | Same-tolerance comparator, final-magnetization identity, native time-to-tolerance fields, immutable suite contract, recipe, and physics note are implemented; `393` focused/source tests, semantics smoke, and docs validation pass. Qualification is blocked because the required v2 mesh artifacts are absent and managed runtime storage fails the `/zfn2/.../fullmag-native.ext4` mount check; no CPU/GPU equilibrium parity or speedup is claimed. |
| T5 | blocked | 82945da99303a2e04f3d066e3736e98c9b66868f |  | scripts/hash_managed_fem_runtime_sources.py; scripts/test_hash_managed_fem_runtime_sources.py; scripts/validate_managed_fem_runtime_bundle.py; scripts/test_export_fem_gpu_runtime_copy_helpers.py; scripts/analysis/fem_gpu_benchmark.py; scripts/analysis/capture_fem_gpu_nsight.py; scripts/verify_fem_mixed_prism_airbox_runtime.py | blocked_by_measurement | 82945da99303a2e04f3d066e3736e98c9b66868f | Schema-v3 implementation and focused tests pass. Managed `just rebuild-fem-runtime` is blocked because the durable target is backed by `/dev/sdg` instead of `/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4`; rerun the managed build after restoring the documented loop mount. |
| T6 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T7 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T8 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T9 | blocked | aa0e686a93b8e33c5dd79df1ede33c80193657e2 |  | benchmarks/fem-llg/qualification-registry-v1.json; scripts/validate_llg_qualification_registry.py; scripts/test_validate_llg_qualification_registry.py; crates/fullmag-runner/src/timestep_qualification.rs; crates/fullmag-runner/src/lib.rs; crates/fullmag-runner/src/artifacts.rs; crates/fullmag-api/src/schemas/diagnostics.rs; apps/control-room/src/modules/footer/FooterDiagnostics.tsx; docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md | blocked_by_measurement | aa0e686a93b8e33c5dd79df1ede33c80193657e2 | Fail-closed eight-lane registry, exact artifact/source binding, runner/API/UI provenance, and validators are implemented. Focused Python tests (`15`), Rust qualification tests (`6`), registry validation, and diff checks pass. All lanes remain intentionally `unvalidated`; the managed FEM runtime manifest is unavailable because the active alias is broken and `/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4` is absent, so no device qualification or promotion is claimed. |
| T10 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T11 | in_progress | 0ae6c1c991b98d33ae5f0a8fd0be0ea2770b9b3f |  | backends/fem/tests/rk_explicit_contract.cpp; backends/fem/tests/cuda_rk_guard_contract.cpp; backends/fem/tests/rk_transaction_fault_injection_contract.cpp; crates/fullmag-runner/src/solver_profile.rs; scripts/test_capture_fem_gpu_nsight.py; scripts/test_export_fem_gpu_runtime_copy_helpers.py | blocked_by_measurement | 0ae6c1c991b98d33ae5f0a8fd0be0ea2770b9b3f | Dedicated native fault-injection target now asserts the production failpoint inventory, bitwise host rollback, exact capture/restore bytes, and profiler-off zero accounting. Managed rejection smoke, CUDA device execution, and five-repeat profiler-off overhead proof remain blocked by the unavailable `/zfn2` build image and runtime. |
| T12 | in_progress | 5579cf5642d1810695cfe463fa915ba49aef17f8 |  | backends/fem/tests/cuda_demag_timing_contract.cpp; scripts/validate_fem_hypre_device_timing.py; scripts/test_validate_fem_hypre_device_timing.py; scripts/analysis/capture_fem_gpu_nsight.py; scripts/test_capture_fem_gpu_nsight.py; justfile | blocked_by_measurement | 5579cf5642d1810695cfe463fa915ba49aef17f8 | HYPRE host/enqueue/device timing fields and fail-closed Nsight preflight are implemented; 105 focused Python tests across timing/provenance/preflight pass. Managed timing smoke, loaded ABI/native contracts, and authoritative Nsight capture remain unverified because the active runtime/storage path is unavailable. |
| T13 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T14 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T15 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T16 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T17 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T18 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T19 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T20 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T21 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T22 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T23 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
