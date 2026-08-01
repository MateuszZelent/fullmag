# Task 2 remediation report: truthful throughput review closure

## Scope

This follow-up closes the three P1 findings from
`.superpowers/sdd/task-2-reviewer-report.md` against Task 2 commit
`4e42d36e290d911e302fc54721137827d439d791`.

The remediation changes diagnostics and presentation semantics only. It does
not change the native FEM numerical algorithm and does not claim a solver
speedup. The pre-existing `.superpowers/sdd/progress.md` modification was not
edited and remains excluded from staging and commit.

## P1 closure

### Successful-publication throughput

- The first successful endpoint in a run establishes the zero-count boundary.
- Later same-run monotonic endpoints advance the window by
  `step - first_successful_step`; coalesced progress such as `10 -> 13` counts
  three successfully published steps.
- Duplicate and out-of-order endpoints do not advance the window.
- A run-id change resets the closed publication window and establishes a new
  zero-count boundary.
- The normal publisher and channel-close drain now use one injected publish
  cycle with identical delta-to-full-snapshot fallback behavior.
- The final drain records success only after the HTTP result, reattaches the
  resulting diagnostics, and sends one authoritative full snapshot when the
  diagnostic revision changed. A failed delta plus failed fallback neither
  advances the counter nor claims final diagnostic visibility.

### Time to tolerance

- `time_to_tolerance_seconds` now consumes the complete canonical
  `StageExecutionRecord` instead of a reason/status projection.
- A duration is present only for a completed, converged record whose reason,
  metric kind, and canonical metric name form a coherent torque or energy
  tolerance tuple.
- Metric value and threshold must both exist, be finite and non-negative, and
  satisfy `metric_value <= threshold`; the timestamp span must also be present
  and ordered.
- Gradient/numerical-stagnation records fail closed. The current canonical
  metric vocabulary has no genuine gradient-tolerance metric and therefore
  cannot distinguish it truthfully from numerical stagnation.

### Footer counter deltas

- Artifact-writer and GPU-sync deltas are calculated only from an immediately
  retained predecessor with increasing step and sample timestamp.
- A lone or ring-truncated sample reports `delta unavailable` while preserving
  the cumulative values.
- Decreasing cumulative counters report `delta reset`; they are no longer
  clamped to a fabricated zero.
- Reversed or out-of-order samples report unavailable deltas.
- Existing enqueue-now, queue-current/max, and cumulative labels are retained.

## TDD evidence

RED verification was observed before production changes:

- CLI tests did not compile because the injected publish-cycle/final-drain
  helpers and endpoint-aware `record_success` contract did not exist.
- API tests did not compile because the previous five-argument duration helper
  could not qualify a canonical completion record.
- Five focused footer assertions failed, exposing the fabricated first-sample
  delta, hidden reset, and reversed-input subtraction.

GREEN focused verification after remediation:

- `cargo test -p fullmag-cli live_workspace::tests`: 24 passed.
  This includes endpoint `10 -> 13`, duplicate/out-of-order/run reset, direct
  delta success, full-snapshot recovery, both-sync failure, and authoritative
  final-drain visibility.
- API tolerance-duration table tests: 2 passed. The tables cover valid torque
  and energy records plus every supported non-tolerance reason/status, missing
  fields, non-finite/negative/above-threshold values, metric mismatches,
  missing/reversed timestamps, and gradient/numerical stagnation.
- Focused footer diagnostics and telemetry tests: 24 passed, including adjacent
  monotonic, lone/ring-truncated, reset, and reversed/out-of-order cases.

## Broader verification

- Full `fullmag-cli` suite: 216 passed.
- Control Room typecheck: passed.
- Control Room lint with zero warnings: passed.
- Full Control Room suite: 390 files passed, 1 skipped; 3734 tests passed,
  1 skipped.
- Full `fullmag-api` suite: 667 of 668 passed. The sole failure remains
  `router_v2::tests::display_patch_accepts_partial_update`; it expects
  `presentation.vector_glyphs=true` while current base behavior returns false.
  It also fails in isolation and is outside the Task 2 diff.
- `git diff --check`: passed.
- Final authoritative native gate after the last source change:
  `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime`: passed
  with exit code 0 in 537.5 seconds. It detected the changed
  `live_workspace.rs`, rebuilt and validated the managed FEM runtime bundle,
  and completed the GPU and CPU FEM relaxation smoke.

## Completion assessment

All three reviewer P1 findings are closed in implementation, tests, and the
resource-first ADR/spec contract. The result is production executable and
verified through the managed runtime path. It makes the diagnostic surface
truthful; it is not evidence that the numerical solver itself is faster.
