# Task 1 report

Status: DONE

## Implemented

- Added accepted ADR 0018 for algorithm-specific relaxation semantics.
- Added the complete TDD implementation plan.
- Corrected the plan so the optional StudyIR dynamics migration updates every Rust consumer atomically.
- Committed only the ADR and plan in 92af46dd and the atomic-migration correction in 623cb3a6.

## Verification

- Document diff checks: pass.
- Placeholder scan: pass; the only matched words are inside the scan command itself.
- Control Room baseline: 305 files, 2738 tests passed.
- Planner baseline: 169 passed, 1 unrelated frequency-domain test failed at tests::fem_frequency_response_rejects_unsupported_production_slice_cases.
- Python baseline: 625 tests, 620 passed, 4 unrelated frequency/example tests failed, 1 skipped. Failures concern dispersion k-path scale and periodic-antidot frequency-response example policy.
- Managed FEM source/derivative contract: fresh PASS after the concurrent export ended via just verify-fem-time-domain-native-contract. It rebuilt and ran fem_stt_contract, fem_cuda_tetra_gradient_contract, fem_relaxation_source_contract, and fem_relaxation_energy_derivative_contract; Zhang-Li skew-tetra and the seven-interaction derivative matrix passed.

## TDD evidence

Not applicable: this task adds decision/plan documents and records baseline behavior; it changes no production behavior.

## Files changed

- docs/adr/0018-algorithm-specific-relaxation-contract.md
- docs/superpowers/plans/2026-07-10-canonical-relaxation-contract.md

## Self-review

- Confirmed the plan covers Python, IR/planner, runtime completion, FDM, FEM, API/OpenAPI, Control Room, documentation, and final qualification.
- Found and fixed an atomicity flaw before execution: changing StudyIR::Relaxation.dynamics without downstream consumers would have left committed workspace compile failures.

## Concerns

- The shared branch and worktree are under concurrent frequency-domain and FEM runtime development. Later tasks must record per-task bases and stage only owned paths.
- Baseline suites contain unrelated failures; completion evidence must distinguish them from relaxation regressions.

## Review-fix evidence

- Commit badf899e removes every bare-name plus --exact Rust command, requires output proving one intended test ran, and therefore prevents false RED evidence from zero tests.
- Task 4 now stages its fullmag-api consumers atomically.
- Task 12 now names scripts/check_relaxation_contract_docs.py and scripts/test_check_relaxation_contract_docs.py, with exact RED/GREEN commands and staging.
- Task 2 now requires focused relaxation GREEN plus no new failures relative to the four recorded unrelated Python baseline failures.
- Fresh managed FEM command: just verify-fem-time-domain-native-contract; exit 0 in 5.2 seconds.
