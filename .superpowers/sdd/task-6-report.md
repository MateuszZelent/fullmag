# Task 6 report — CUDA architecture and managed bundle integrity

Date: 2026-07-23

Status: implementation and required verification complete. Independent review of the final validator and A/B artifact passed; final whole-diff review and commit remain.

## Delivered contract

- `FULLMAG_CUDA_ARCHITECTURES` is tracked by the Rust build script and propagated to CMake.
- The exported Fullmag matrix is `80-real;89-real;90-real;90-virtual`.
- The HYPRE matrix is `60 70 80 89 90`.
- Managed runtime manifest schema v2 records resolved paths, SHA-256, SONAME, CUDA cubins/PTX, build versions, requested/effective architectures, loader evidence, and runtime GPU diagnostics.
- Validation is fail-closed and treats `libfullmag_fem` and the actually loaded HYPRE as separate native-`sm_89` requirements.
- Runtime bundles are immutable, hash-addressed variants with explicit validate/select/restore recipes.
- Variant validation rejects any directory whose basename differs from `<manifest.variant>-<sha256(manifest.json)>`; only unpublished staging may opt out explicitly. An export collision must also match the complete staged bundle byte-for-byte before staging is discarded.
- The historical pre-Task-6 bundle and its schema-v2 derivative remain preserved; active runtime selection is a symlink and the original directory backups were not deleted.
- Cold/steady A/B uses one independent, hash-addressed CLI harness, identical physical Task 0 input, separate empty CUDA caches for cold samples, and raw per-case stdout/stderr evidence.
- The CLI metric is named `first_accepted_step_demag_solver_apply_wall_time_ms`. It is the first nonzero accepted-step demag-solver aggregate available through the legacy-compatible ABI; it is not a literal single solver application and may contain multiple applications.

## Runtime identities

- GPU: NVIDIA GeForce RTX 4080 SUPER, compute capability 8.9.
- Baseline variant: `.fullmag/runtimes/fem-gpu-variants/recovered-pre-task6-sm52-5e39b07df83af81208b656c8a5a2aabc6edc430152caf0f33bb5bcb1301ca684`.
- Baseline manifest SHA-256: `5e39b07df83af81208b656c8a5a2aabc6edc430152caf0f33bb5bcb1301ca684`.
- Candidate variant: `.fullmag/runtimes/fem-gpu-variants/candidate-sm89-ff742e009be49910badfe25bbe866889a27861bf95e09b3b7e52b5e47342f7ef`.
- Candidate manifest SHA-256: `ff742e009be49910badfe25bbe866889a27861bf95e09b3b7e52b5e47342f7ef`.
- Common harness: `.fullmag/runners/fem-gpu-task6/d03dfe915d84ed10cdb7b427c0d819cdff22d9de87274452f95eda369c8ead0b/fullmag-fem-gpu-bin`.
- Composite harness ID: `d03dfe915d84ed10cdb7b427c0d819cdff22d9de87274452f95eda369c8ead0b`.
- Harness manifest SHA-256: `445ca57e47fd12348d618fcf70655a457edb55db87ffcff1d9b61d728a5eeb1a`.
- Harness worker SHA-256: `04ef104568127c9996f14bfeee9c4892f54a8a7ab38c5837fd236d8643ec6a3e`.
- Task 0 physical mesh SHA-256: `9c410c3b02cc86d3a832b923f13b5f9b0ec18c4be2babda148697c6dbc9c105a`.
- Localized ProblemIR SHA-256: `ec36a24123cfa8d1d84e6da0987628e5da537c63fc5de44d91d15e1bd1c8ac25`.
- Public Fullmag FEM C ABI: 59 symbols, identical between variants.

Baseline code objects:

- Fullmag FEM: `sm_52`, PTX `compute_52`.
- HYPRE 3.1.0: `sm_60`, `sm_70`, `sm_80`, `sm_90`; no native `sm_89`.

Candidate code objects:

- Fullmag FEM: `sm_80`, `sm_89`, `sm_90`, PTX `compute_90`.
- HYPRE 3.1.0: `sm_60`, `sm_70`, `sm_80`, `sm_89`, `sm_90`.
- MFEM 4.9: `sm_80`, `sm_89`, `sm_90`, PTX `compute_90`.

The old Fullmag library therefore required PTX JIT for the RTX 4080 SUPER, whereas the candidate contains native `sm_89` code in both Fullmag and the loaded HYPRE. The measured cold improvement is consistent with lower architecture/JIT startup overhead, but this bundle-level A/B does not isolate architecture selection as the sole cause.

## Authoritative A/B result

Artifact:

`.fullmag/reports/fem-gpu-runtime-architecture-ab/20260723-task6-v9-final`

The exact Task 0 box500 airbox exchange-plus-demag workload ran NCG with AMG relax type 6 for 64 steps. There are five cold and five steady samples per variant: 20 valid rows total. Every row completed 64 steps, returned the expected status, used the exact manifest identity, physical mesh hash, and localized ProblemIR hash.

| Metric | Baseline cold p50 / p95 | Candidate cold p50 / p95 | p50 change | Baseline steady p50 / p95 | Candidate steady p50 / p95 | p50 change |
|---|---:|---:|---:|---:|---:|---:|
| backend create | 5722.524 / 6130.149 ms | 5458.605 / 5761.145 ms | -4.6% | 5492.287 / 5862.871 ms | 5359.900 / 5383.686 ms | -2.4% |
| first accepted-step demag solver apply aggregate | 166.912 / 180.488 ms | 128.503 / 141.316 ms | -23.0% | 124.323 / 159.914 ms | 124.210 / 128.221 ms | -0.1% |
| whole 64-step process | 21521.114 / 22923.291 ms | 21220.858 / 22453.799 ms | -1.4% | 20543.139 / 21910.344 ms | 21004.238 / 21337.575 ms | +2.2% |

Interpretation:

- The bundle comparison shows a cold/startup improvement: backend-create p50 improves by 4.6%, the first accepted-step demag aggregate by 23.0%, and whole-process p50 by 1.4%.
- Steady-state backend-create p50 improves by 2.4% and the demag aggregate is effectively unchanged, but whole-process p50 is 2.2% slower. This is not a meaningful steady-throughput gain.
- Packaging correctness and native `sm_89` coverage are proven. The timing result supports, but does not by itself prove, reduced PTX-JIT/startup overhead as the causal explanation.
- Further steady-state improvement requires the later synchronization, solver/operator, API, and workload-scaling tasks.

## Harness and infrastructure defects found and fixed

The earlier comparisons were rejected rather than reported:

1. Historical Task 0 ProblemIR identity included an absolute container path. The final harness localizes that identity in an unmeasured preflight while preserving the exact physical mesh hash, node/element counts, solver policy, and 64 executed steps.
2. The first CLI telemetry path did not expose backend-create and accepted-step demag aggregate fields to the benchmark CSV.
3. The initial metric was incorrectly described as a literal first solver application. The final ABI-neutral contract names it as an accepted-step aggregate and explicitly documents that it may contain multiple solves.
4. Script execution and `run-json` emit different terminal summary shapes (`workspace_dir` versus `output_dir`). The parser supports both and retains raw case output.
5. Warm-up used an unwritable legacy `.fullmag/local-live/history`; every benchmark process receives its own writable workspace under the temporary run directory.
6. The common harness is independent of both runtime variants, hash-addressed, and tied to the source candidate manifest without modifying that bundle.
7. A rebuild compiled but could not export because the filesystem had only about 0.96 GB free. With explicit user authorization, cleanup removed unused dangling Docker image references, reclaimable BuildKit cache, and eight inactive reproducible `/tmp` build-target directories from Tasks 5/6 and prior runner work. No Docker volumes, active images/services, or preserved runtime variants were removed; free space rose to about 22 GB and the managed rebuild then completed.
8. A subsequent Cargo network slowdown recovered without adding persistent configuration or weakening reproducibility.
9. Final review found that a valid payload could be placed under a stale variant address and that an export collision did not compare the staged payload. Default address validation, exact collision comparison, and negative regression tests now close both holes.
10. The HYPRE provider validator previously accepted zero or one worker-visible HYPRE without proving that it was the manifest-selected library. It now rejects zero and wrong-singleton traces; multiple-library traces retain the stronger `LD_BIND_NOW` binding proof.
11. The exported README described the old staging-only flow and then documented a path that disappeared after publication. It now uses the stable active alias. A subsequent review caught unescaped Markdown backticks executing the alias path inside the heredoc; the generated final README was inspected after escaping them.

Failed/interrupted report directories remain as RED evidence and are not used for the final result.

## Verification evidence

- Task 6 Python/source suites after final immutable-address and HYPRE-provider regression tests: `163 passed`.
- Focused CLI diagnostic test `run_json_summary_reports_create_and_first_accepted_step_demag_apply_aggregate`: passed.
- Focused runner StepStats-to-diagnostics and API backward-compatibility tests: passed.
- Control Room typecheck: passed.
- Control Room lint with `--max-warnings=0`: passed.
- Control Room tests: `392 passed, 1 skipped` files; `3765 passed, 1 skipped` tests.
- Final validator: passed on RTX 4080 SUPER, CC 8.9. It found 1536 HYPRE bindings and proved every public binding resolved to the candidate `libHYPRE-3.1.0.so`; native `sm_89` exists in Fullmag and HYPRE.
- Independent artifact audit recomputed the v9 metrics exactly, confirmed all 20 rows, identities, 59-symbol ABI parity, active-candidate restoration, and manifest freshness.
- `git diff --check`: passed.
- `just verify-fem-demag-poisson-contract`: passed in the managed FEM/CUDA container. Its expected `PCG No convergence` rejection-contract case returned overall success.
- `just verify-fem-time-domain-native-contract`: passed in the managed FEM/CUDA container.
- `just verify-fem-frequency-domain-native-contract`: passed in the managed FEM/CUDA container.
- `just verify-fem-relaxation-runtime`: passed all required GPU and CPU relaxation lanes, including GPU LLG-overdamped, PG-BB, and NCG with device-resident HYPRE.
- The final active runtime resolves to candidate `ff742e009be4...42f7ef`; every managed ensure step revalidated it without rebuilding, proving watched-input freshness.

## Preserved recovery artifacts

- Raw legacy bundle: `.fullmag/runtimes/fem-gpu-variants/recovered-pre-task6-sm52-1a2e4e6d3def`.
- Schema-v2 baseline: `.fullmag/runtimes/fem-gpu-variants/recovered-pre-task6-sm52-5e39b07df83af81208b656c8a5a2aabc6edc430152caf0f33bb5bcb1301ca684`.
- Original directory backup: `.fullmag/runtimes/fem-gpu-host.directory-backup.20260723T114208Z`.
- Original variant-link backup: `.fullmag/runtimes/fem-gpu-host.variant-link-backup.20260723T114147Z`.

## Remaining closure work

- Final whole-diff specification and quality review after this report update.
- Stage only Task 6 files, excluding `.superpowers/sdd/progress.md` and generated runtime/report artifacts.
- Commit after all review findings are resolved.
