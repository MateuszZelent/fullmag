# FEM solver optimization remediation ledger

This ledger is the only current remediation state. Historical measurements and
accepted baselines listed below are diagnostic-only until a task records the
same typed mesh, tolerance, source commit, runtime manifest, and decision.

- `audit_base_commit`: `17a7e341477e9b64493b8da0ed3179fd6233ee49`
- `implementation_base_commit`: `eee245ac200bf138d880b793791848106b7386ba`
- `origin_master_at_start`: `eee245ac200bf138d880b793791848106b7386ba`
- `source_drift_reviewed_at`: `2026-08-02T10:46:45+02:00`
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

### Latest user-run diagnostic (2026-08-02, non-authoritative)

The reported GPU PG-BB failure is quarantined because the run does not carry
the current managed-runtime identity or the current PG-BB convergence fields.
Its error string predates the `current_torque_apm`, `torque_tolerance_apm`, and
`torque_confirmation_count` diagnostics introduced in the current source. The
last visible sample was `max_torque_T=5.7349e-9`, while the dirty scenario used
`tolT=5.8349e-9 T`; the corresponding A/m values are approximately
`4.5636884e-3` and `4.6432659e-3`, respectively. The reported energy trial
was exactly one binary64 ULP above the current energy
(`9.62964972193618e-35 J`), not a macroscopic energy increase. Current source
commits `81e973c1`/`102f9954`/`c262fa9d` handle this low-torque sample through
the zero-dt confirmation path and publish the additional diagnostics. This
run therefore proves neither a new solver defect nor a performance result;
repeat it only after the managed runtime is rebuilt from the restored
`/zfn2/.../fullmag-native.ext4` mount.

The second replay supplied on 2026-08-02 has the same representability
signature: `current_energy_j=5.46810637290086942e-19`,
`last_trial_energy_j=5.46810637290087038e-19`,
`gradient_norm_sq=7.67763618169727893e-28`, and
`last_trial_step=1.16712909512976660e-11`. Its error string still omits the
current-source convergence fields, so it is additional stale-runtime evidence,
not an independent Armijo failure. No tolerance or Armijo policy change is
authorized by either replay.

## Task ledger

Evidence paths are repository-relative and separated by `;`. A non-pending
task requires an exact 40-character source commit. A completed task requires
at least one existing evidence path and cannot be blocked by measurement.

| Task | status | source_commit | runtime_manifest_sha256 | evidence | decision | commit | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T0 | completed | eee245ac200bf138d880b793791848106b7386ba |  | scripts/test_validate_fem_solver_optimization_ledger.py; scripts/validate_fem_solver_optimization_ledger.py | promote | commit follows this ledger closure | Ledger, parser, RED/green tests, and recipe are present. |
| T1 | completed | 2456b141422da4da30751c91662e06b420e34932 | 20121b1452b3ee7af4dc8be76c492b0703e299378ef011d7740e2b8427fc5c84 | examples/assets/fem_performance/box500_airbox_exchange_demag_v2.fixture.json; examples/assets/fem_performance/box500_airbox_exchange_demag_v2.mesh.json; examples/assets/fem_performance/amg_qualification_suite_v2.json; examples/assets/fem_performance/box500_airbox_exchange_demag_amg_coarse_v2.mesh.json; examples/assets/fem_performance/box500_airbox_exchange_demag_amg_medium_v2.mesh.json; scripts/test_validate_fem_relaxation_runtime_log.py; scripts/test_capture_fem_gpu_nsight.py; justfile | promote | 2456b141422da4da30751c91662e06b420e34932 | Managed schema-v3 runtime is exact (`clean`, compute capability 8.9, HYPRE 3.1.0, source snapshot `e03f2443c8354d8b900350e1257192c428f1eadcba30028fe7655c1f17f41fec`). The strict `just verify-fem-performance-fixture-v2` gate exits 0 for all coarse/medium/fine typed fixtures; the current solver-mesh group has a stable signature and residual. Focused fixture/typed-mesh tests pass (`64`). |
| T2 | completed | 2456b141422da4da30751c91662e06b420e34932 | 20121b1452b3ee7af4dc8be76c492b0703e299378ef011d7740e2b8427fc5c84 | scripts/test_validate_fem_relaxation_runtime_log.py; scripts/validate_fem_demag_mesh_airbox_convergence.py; scripts/analysis/fem_gpu_benchmark.py; scripts/analysis/capture_fem_gpu_nsight.py; examples/assets/fem_performance/box500_airbox_exchange_demag_v2.fixture.json; examples/assets/fem_performance/amg_qualification_suite_v2.json; justfile | promote | 2456b141422da4da30751c91662e06b420e34932 | Canonical typed topology parsing and solver-mesh signature v2 are exercised by the strict v2 gate on the exact managed runtime. The gate reports separate input/solver identity and stable solver counts/signature; no legacy v1 geometry is used by the active fixture path. |
| T3 | completed | 7208e493a51eba7cfbc10491963d3dd069c391fe |  | scripts/test_validate_fem_relaxation_runtime_log.py; scripts/analysis/fem_gpu_benchmark.py; scripts/verify_fem_relaxation_consistency_semantics.py; justfile | promote | 7208e493a51eba7cfbc10491963d3dd069c391fe | Direct-minimizer pairs now report `coverage_only`, never `pass`, and the separate equilibrium-parity gate fails closed until T4 performs same-tolerance state comparison. Source module tests (`377`), dependency-free host verifier, and managed-container verifier pass. |
| T4 | in_progress | 8b2ff65fe70d811b98d1333c3ad781df81d5213e | 8cb22b2150619bd74ae10015629b98456fce412e5cb00d35262e52d7d64f7a9f | docs/audits/2026-08-02-fem-t4-coarse-parity-measurement.json; scripts/validate_fem_relaxation_equilibrium_parity.py; scripts/test_validate_fem_relaxation_equilibrium_parity.py; scripts/verify_fem_relaxation_equilibrium_parity_semantics.py; scripts/analysis/fem_gpu_benchmark.py; examples/bench_fem_gpu_long.py; examples/assets/fem_performance/equilibrium_qualification_suite_v1.json; docs/physics/0580-canonical-relaxation-equilibrium-contract.md; docs/physics/0580-canonical-relaxation-equilibrium-contract.source-map.json; justfile | blocked_by_measurement | 8b2ff65fe70d811b98d1333c3ad781df81d5213e | Accepted-step/terminal-confirmation telemetry and backend direction provenance are implemented in `8b2ff65f`. Exact clean schema-v3 runtime (`MFEM 4.9`, `HYPRE 3.1.0`, compute capability `8.9`, source snapshot `18fefdef...`) was used for a fresh coarse gate. All 8 rows completed and the typed mesh group passed, but demag PG-BB and NCG fail the 1e-9 final-magnetization gate with max component differences `0.06503967931218391` and `0.005650088291763944`; no parity or speedup is claimed. |
| T5 | completed | 2456b141422da4da30751c91662e06b420e34932 | 20121b1452b3ee7af4dc8be76c492b0703e299378ef011d7740e2b8427fc5c84 | scripts/hash_managed_fem_runtime_sources.py; scripts/test_hash_managed_fem_runtime_sources.py; scripts/validate_managed_fem_runtime_bundle.py; scripts/test_export_fem_gpu_runtime_copy_helpers.py; scripts/analysis/fem_gpu_benchmark.py; scripts/analysis/capture_fem_gpu_nsight.py; scripts/verify_fem_mixed_prism_airbox_runtime.py; justfile | promote | 2456b141422da4da30751c91662e06b420e34932 | Exact managed schema-v3 bundle validated by `just ensure-managed-fem-runtime`: commit `2456b141422da4da30751c91662e06b420e34932`, clean tree, source snapshot `e03f2443c8354d8b900350e1257192c428f1eadcba30028fe7655c1f17f41fec`, manifest SHA `20121b1452b3ee7af4dc8be76c492b0703e299378ef011d7740e2b8427fc5c84`, compute capability 8.9, HYPRE 3.1.0 and binding count 1537. |
| T6 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T7 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T8 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T9 | in_progress | 2456b141422da4da30751c91662e06b420e34932 | 20121b1452b3ee7af4dc8be76c492b0703e299378ef011d7740e2b8427fc5c84 | benchmarks/fem-llg/qualification-registry-v1.json; scripts/validate_llg_qualification_registry.py; scripts/test_validate_llg_qualification_registry.py; crates/fullmag-runner/src/timestep_qualification.rs; crates/fullmag-runner/src/lib.rs; crates/fullmag-runner/src/artifacts.rs; crates/fullmag-api/src/schemas/diagnostics.rs; apps/control-room/src/modules/footer/FooterDiagnostics.tsx; docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md | blocked_by_measurement | 2456b141422da4da30751c91662e06b420e34932 | Fail-closed eight-lane registry and exact artifact/source binding are implemented; focused Python/Rust validators pass. Exact managed runtime is now available, but all lanes remain intentionally `unvalidated` until their managed execution evidence is captured. |
| T10 | pending |  |  |  |  |  | Refresh the overlapping owner scope before implementation. |
| T11 | in_progress | 0ae6c1c991b98d33ae5f0a8fd0be0ea2770b9b3f |  | backends/fem/tests/rk_explicit_contract.cpp; backends/fem/tests/cuda_rk_guard_contract.cpp; backends/fem/tests/rk_transaction_fault_injection_contract.cpp; crates/fullmag-runner/src/solver_profile.rs; scripts/test_capture_fem_gpu_nsight.py; scripts/test_export_fem_gpu_runtime_copy_helpers.py | blocked_by_measurement | 0ae6c1c991b98d33ae5f0a8fd0be0ea2770b9b3f | Dedicated native fault-injection target now asserts the production failpoint inventory, bitwise host rollback, exact capture/restore bytes, and profiler-off zero accounting; the full managed-container native contract gate passed at source revision `f790f6f0`. Managed rejection smoke, CUDA device execution, and five-repeat profiler-off overhead proof remain blocked by the unavailable `/zfn2` build image and runtime. |
| T12 | in_progress | 6c1f028fce580909da88c5e2d206fa611d4fd87d | b0ac7282c0b899a619efa7b4f1ac557adef9fa2edf5c6dbf7f89b1ac82822d08 | docs/audits/2026-08-02-fem-t12-hypre-device-timing.json; backends/fem/tests/cuda_demag_timing_contract.cpp; scripts/validate_fem_hypre_device_timing.py; scripts/test_validate_fem_hypre_device_timing.py; scripts/analysis/capture_fem_gpu_nsight.py; scripts/test_capture_fem_gpu_nsight.py; benchmarks/fem-gpu/accepted/rtx4080-sm89/nsight-v2-environment.json; justfile | blocked_by_measurement | 6c1f028fce580909da88c5e2d206fa611d4fd87d | Managed `just verify-fem-hypre-device-timing` passes coarse/fine with profiler-off zero accounting and profiler-on device elapsed timing. Typed-v2 Nsight compute capture executes 64/64 GPU steps with exact solver-mesh/ProblemIR identity; last `fullmag.demag.hypre_device` range is 75.123418 ms versus profiler 72.482336 ms (3.64%). Full host/UI capture is still blocked because the static Control Room is not built; Nsight reports no CUDA kernel table, so no top-kernel occupancy/bandwidth claim is made. |
| T13 | in_progress | 5d3e9ba9cce600753af00a4870ef29bdf61a0bc7 |  | crates/fullmag-api/src/schemas/diagnostics.rs; apps/control-room/src/kernel/api/generated/openapi-v2.json; apps/control-room/src/kernel/api/generated/openapi-v2-types.ts; apps/control-room/src/modules/footer/FooterDiagnostics.tsx; apps/control-room/src/modules/footer/FooterDiagnostics.test.ts; docs/specs/resource-first-control-room-api-v2.md | blocked_by_measurement | 5d3e9ba9cce600753af00a4870ef29bdf61a0bc7 | Native/Rust RK and HYPRE timing counters now propagate through the API v2/OpenAPI/generated frontend types and profiler UI. API compatibility tests (`5`) and UI tests (`14`) pass; Control Room typecheck and targeted ESLint pass. React Doctor is blocked by a missing optional `oxc-parser` native binding under Node 22.8. Managed runtime timing proof, Nsight capture, and GPU execution remain blocked by the unavailable durable `/zfn2` runtime image. |
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
