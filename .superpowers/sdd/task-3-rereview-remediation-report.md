# Task 3 rereview remediation report

## Result

All four P1 findings in `task-3-rereview-report.md` are remediated.

- FEM topology fingerprints are computed once at stage entry and the cached
  `Option<String>` is threaded through reference FEM, frequency response,
  hysteresis (including saturation, angular, adaptive, minor-loop and settle
  helpers), native direct/LLG relaxation, and finalization callbacks.
- Native relaxation final cached-preview updates carry the cached generation.
- Publisher coalescing moves pending mesh ownership with `take`; legacy full
  snapshots and runtime frames promote nested input with `take` and retain no
  nested owner.
- The source checker classifies the complete `.fem_mesh` inventory (191
  accesses in the managed workspace), rejects unclassified/nested ownership,
  and includes negative mutations for allowlisted owner-loop construction,
  arbitrary `.fem_mesh`, and topology hashing in loops.
- Test-only fingerprint instrumentation proves one evaluation for an unchanged
  stage and exactly one additional evaluation after topology changes.

## Verification

- Host `cargo check -p fullmag-runner -p fullmag-cli -p fullmag-api` — PASS.
- Focused fingerprint, frequency-response, FEM hysteresis, publisher move,
  legacy snapshot promotion, and runtime-frame preservation tests — PASS.
- `bash scripts/verify_fem_mesh_hot_loop_source_contract.sh` — PASS, 191
  `.fem_mesh` accesses classified.
- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime` — PASS
  (577.5 s, fresh feature-gated runtime bundle and complete smoke suite).
- `COMPOSE_PROJECT_NAME=fullmag FULLMAG_BENCH_REPEAT=5 just
  verify-fem-gpu-performance-regression` — PASS (10/10 rows, 25 CPU/GPU
  pairs, accepted baseline and strict residency).
- After final hysteresis cache threading:
  `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-source-contract` —
  PASS; focused hysteresis test, host check, source gate and `git diff --check`
  — PASS.

The first managed runtime attempt was externally timed out after reaching the
smoke suite; it was rerun cleanly to exit 0. Pre-existing runner warnings remain
unchanged.
