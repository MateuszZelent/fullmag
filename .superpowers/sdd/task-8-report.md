# Task 8 report — FEM GPU PG-BB control path and direct increments

Date: 2026-07-25

Status: **IMPLEMENTED_AND_EXACT_RUNTIME_QUALIFIED**. Task 8 passes the final
identity-pinned five-repeat managed production matrix. The implementation
reduces PG-BB host control readbacks to the canonical four-per-accepted-step
base budget and fixes false Armijo failures caused by cancellation in endpoint
energy subtraction.

The detailed numerical and artifact record is in
`.superpowers/sdd/task-8-direct-increment-report.md`.

## Original bottlenecks and failures

GPU PG-BB previously paid redundant host-control synchronization costs:

1. current-state energy terms and gradient norms were read in separate host
   transfers;
2. a trial total was read before the direct Armijo batch read the trial terms
   again;
3. benchmark accounting encoded an obsolete 11-sync ceiling and multiplied
   extra attempts incorrectly;
4. strict Armijo decisions subtracted nearly equal endpoint totals, causing
   representability failures near stationarity even when a direct discrete
   decrement existed.

The historical production fixture therefore exposed both a performance defect
and three numerical failure classes. Merely increasing line-search attempts or
loosening Armijo would have hidden the defect and was rejected.

## Implemented control-path correction

- Current energy terms, both projected-gradient norms and finite/nonnegative
  flags are packed into one device-produced result workspace and consumed by a
  single current-state control readback.
- Normal trials do not perform a standalone total-energy readback. The shared
  direct Armijo batch owns the trial decision and diagnostic snapshot.
- PG-BB telemetry counts the current record, normal trials and direct-energy
  refinement evaluations exactly once.
- The benchmark has one canonical budget owner:

  `initial_syncs + per_step * executed_steps + max(0, total_rhs_evals - 2 * executed_steps)`

  PG-BB uses immutable `per_step=4`; NCG uses immutable `per_step=3`.
- The production recipe forwards repeat count, defaults Task 8 to repeat five,
  and rejects noncanonical readback ceilings.
- Unused recovery implementations containing stale standalone energy readbacks
  were removed after repository-wide reference checks proved they had no
  caller.
- Source contracts reject reintroduction of standalone trial-total readbacks
  in both the helper and accepted-step regions.

The profiler remains opt-in, bounded and allocation-free while disabled.
Task 8 adds a versioned accepted-energy-proof ABI and corresponding artifact
columns; no tolerance, demag fresh-zero, BB curvature or rollback policy was
relaxed.

## Implemented numerical correction

- CPU and GPU Armijo decisions use direct signed energy increments with
  explicit roundoff intervals.
- Energy ownership is exclusive: each enabled interaction contributes through
  either a direct increment or an endpoint-residual increment, never both.
- GPU direct increments cover exchange, Zeeman, uniaxial anisotropy and cubic
  anisotropy. Cubic products/accumulation and tangent projection use shared
  double-double arithmetic where cancellation is material.
- Exchange and uniaxial uncertainty use the actual polarized operands of the
  increment rather than the much larger endpoint-energy scale.
- Acceptance remains fail-closed: the upper increment bound must satisfy the
  strict Armijo right-hand side. Exhausted unrepresentable stationary chords
  roll back and are not recorded as accepted steps.

## TDD and regression evidence

The task was driven by failing contracts for the obsolete readback budget,
missing repeat forwarding, stale helper readbacks, mutable budget parameters,
direct-increment ownership and the historical PG-BB failure classes. The final
focused Python validator result is:

```text
252 passed in 3.12s
```

One full-suite failure found during closure was a defective synthetic fixture:
it cloned a demag row into a non-demag case but changed only
`solver_mesh_signature`, leaving the frozen
`qualification_input_mesh_signature` from the original case. The production
validator correctly rejected it. Updating that single fixture field made the
focused test and then all 252 tests pass; the validator was not weakened.

Managed native contracts pass for:

- source ownership and forbidden-readback regions;
- CUDA direct increment and energy derivatives;
- stage completion and explicit RK regressions;
- real-device relaxation runtime and HYPRE Poisson;
- Zhang-Li skew-tetra CPU/GPU parity.

## Final production result

The authoritative command pins the final captured identity and executes PG-BB
five times per required case/policy/backend combination:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
FULLMAG_BENCH_RELAX_ALGORITHMS=projected_gradient_bb \
FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP=4 \
FULLMAG_BENCH_REPEAT=5 \
FULLMAG_BENCH_TASK8_QUALIFICATION_IDENTITY=.fullmag/reports/task8-qualification/final-dd-identity.json \
FULLMAG_BENCH_OUTPUT=.fullmag/reports/task8-qualification/final-dd-repeat5.csv \
FULLMAG_BENCH_SUMMARY=.fullmag/reports/task8-qualification/final-dd-repeat5-summary.json \
just verify-fem-relaxation-production-benchmark
```

Result:

- 120/120 rows pass;
- 9/9 required CPU/GPU case pairs complete;
- zero consistency, group, gate or runtime-identity failures;
- maximum demag residual `4.993e-13`;
- maximum demag iteration count 31;
- device is NVIDIA GeForce RTX 4080 SUPER, compute capability 8.9;
- MFEM 4.9 and Fullmag HYPRE bindings from bundled HYPRE 3.1.0;
- final native library SHA-256
  `b57830b1ee8f64f9f0fdbade28904cfe1da1992565b254a7ee0419b85b8f69b5`;
- final source manifest SHA-256
  `e45689348c9f10909daca216817366b2e6d4c6fc80a5d02e3abb4cec4439a8fd`;
- final runtime manifest SHA-256
  `4edbd92f41ce304ca1b3b09a6254eda436622487c1ac889fcbde6c674558f007`.

The earlier 95/110 and 360/360 runs used superseded runtime identities or
intermediate code and are not final acceptance evidence.

## Performance conclusion

Task 8 improves the GPU control architecture and closes numerical failures,
but it does not prove speedup on the small qualification mesh. Aggregate CPU
wall time is 73.40 s and GPU wall time 81.01 s across all 60 rows per lane, so
GPU is about 10.4% slower in this launch-dominated case. This is a measured limitation,
not a failed correctness gate.

The next performance work must establish scale-dependent crossover and inspect
GPU timelines/occupancy on larger production meshes. `nvidia-smi` utilization
samples alone cannot separate useful kernels, launch gaps, HYPRE execution and
host waiting.

## Closure conditions

Task 8 may be merged only after:

1. the still-running managed recipe finishes all appended rebuild/export and
   runtime validation gates with exit code zero;
2. an independent diff review reports no blocking correctness or scope issue;
3. the commit excludes the user-owned `.superpowers/sdd/progress.md`;
4. post-merge managed gates are rerun on `master`.

Until all four are satisfied, Task 8 is qualified but not yet integrated.
