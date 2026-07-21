# Task 4 rereview remediation: preview cache revision contract

Date: 2026-07-21

## Findings addressed

This follow-up addresses both findings in
`task-4-rereviewer-report.md` without amending either prior Task 4 commit.

1. A publisher clone taken outside the workspace lock could be committed after
   a newer clear or replacement and resurrect/overwrite stale preview state.
2. The coalesced-wake test asserted an uncontrolled worker scheduling outcome.

## Revision and ownership semantics

`LocalLiveWorkspaceState` now owns a monotonic `preview_cache_revision`.
Clear, replacement, upsert, and every runner ingest containing preview data
advance the revision. `take_publish_delta_parts` captures the revision beside
the moved preview allocations.

The publisher still clones the one persistent cache copy outside the state
lock. On re-entry it performs compare-and-commit:

- if the revision is unchanged, the clone becomes persistent cache state;
- if clear occurred, the revision differs and old A cannot be resurrected;
- if newer B arrived, the revision differs, A cannot overwrite B, and B stays
  pending for its own publication;
- a rejected stale `Vec<LivePreviewField>` is returned from the comparison,
  the lock is released, and only then is the heavy allocation dropped.

The callback remains move-only for preview fields. No JSON materialization or
persistent preview clone was reintroduced into the callback.

## Deterministic TDD evidence

Two barrier-controlled tests force the exact unsafe interleavings:

- `stale_preview_commit_cannot_resurrect_cache_after_clear` forces
  `take A -> clear -> commit A`;
- `stale_preview_commit_cannot_overwrite_newer_pending_field` forces
  `take A -> ingest B -> commit A`.

Mutation RED was observed by disabling only the revision comparison: both
tests failed because stale A appeared in `preview_fields`. After restoring the
comparison, both tests passed and verified revision 2, no stale persistent A,
and preserved pending B where applicable.

The coalesced-wake test now creates the existing worker behind a start barrier.
Two `replace` calls fill/coalesce the bounded wake channel before releasing the
worker, so `coalesced_wake_count >= 1` is deterministic and the assertion was
not weakened.

## Verification

- focused stale-commit tests: 2/2 PASS after mutation RED;
- coalesced-wake test alone: PASS;
- full `fullmag-cli` suite, three consecutive serial runs: 230/230 PASS each;
- runner solver-profile suite: 17/17 PASS;
- semantic/native FEM source contract: PASS, 191 accesses and 64 producers;
- managed FEM runtime: PASS after a fresh release rebuild/export (8m26s), with
  the supported GPU smoke matrix and all CPU smoke algorithms validated.

The source inventory digest changed to
`0ea86f9f59622874e94af8818f84f380ce3dd83b751d95a6722a0f48971e21bd`
only because `preview_cache_revision: 0` was added to protected containing
workspace struct literals. Mesh operations and producer counts did not change.

## Performance evidence

The standalone repeat-5 run passed all 10 numerical rows, convergence,
CPU/GPU consistency, stable mesh, and strict GPU residency. It failed only the
historical wall-time threshold because one noisy GPU sample raised p95 to
6337.148 ms (+21.28% versus accepted 5225.24 ms); GPU p50 was 5535.078 ms.
The accepted baseline was not changed.

A controlled same-container forward/reverse A/B used the same fixture,
arguments, warmup, five CPU repetitions, five GPU repetitions, and strict
gates. Real executable SHA-256 values were:

- immutable: `540d7e6bf7e798862753852141b0971585421e6e871f8ab75a8226fb3875f8b7`;
- current: `12abf257b60a4fbb7bcbb3bd3c6f8ca7b4e6ae4520a96f86c71eddd5c8810abd`.

| Order | Runtime | CPU p50 | CPU p95 | GPU p50 | GPU p95 | Result |
|---|---|---:|---:|---:|---:|---|
| forward first | immutable | 10719.835 ms | 10865.726 ms | 5413.321 ms | 5774.563 ms | 10/10 PASS |
| forward second | current | 10660.813 ms | 10697.303 ms | 5431.275 ms | 5577.976 ms | 10/10 PASS |
| reverse first | current | 10701.908 ms | 10920.605 ms | 5431.762 ms | 5685.214 ms | 10/10 PASS |
| reverse second | immutable | 10713.406 ms | 10828.082 ms | 5314.253 ms | 5449.972 ms | 10/10 PASS |

Forward order favored current GPU p95 by 3.40%; reverse order favored immutable
by 4.32%. Both differences are inside 5%, change direction with order, and the
CPU values are similarly close. This resolves the standalone miss as
environment/order variance rather than a repeatable regression from the
revision fix.

NVIDIA telemetry covered idle P8 at 43-49 C, 14.46-15.20 W, 210/405 MHz and
active/post-run P2 at 50-56 C, 69.45-72.29 W, 2760-2775/11251 MHz. There was no
thermal or power-limit signature. Raw ignored results remain under
`.fullmag/reports/task4_r2_ab_{forward,reverse}_*.{csv,json}`.

## Scope

No solver equation, MFEM/hypre/CUDA configuration, native `Context`, API wire
shape, or accepted performance baseline changed. The parent-owned
`.superpowers/sdd/progress.md` remains outside this follow-up.
