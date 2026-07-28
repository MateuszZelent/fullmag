# FEM GPU end-to-end performance remediation closure

Date: 2026-07-28

Plan: `docs/superpowers/plans/2026-07-20-fem-gpu-end-to-end-performance-remediation.md`

Native qualification revision under test: `b991148d8c27fd2e5a36e8dd3c6adc55fe6fa60a`

Device: NVIDIA GeForce RTX 4080 SUPER, compute capability 8.9

## Final verdict

- **Task 18: NOT_QUALIFIED**
- **Promotion: NO_PROMOTION**
- **Gate 8: PASS**
- **Gate 9: NO_PROMOTION**
- **Gate 10: NOT_PROMOTED**
- Accepted performance baseline: unchanged and not promoted.
- Independent final source review: PASS, no actionable findings after two
  persistence-race corrections and re-review.

This closes the evidence ledger without claiming that the complete remediation
goal is validated. The candidate restores valid nonlinear-CG accepted-energy
proofs and does not regress GPU p95 against its immediately preceding
same-source lane. That result is attribution evidence, not promotion evidence.
The mandatory demagnetization policy gate is red, both same-source lanes remain
red against the committed accepted p95 limit, a qualified final Nsight trace is
absent, and same-time-to-same-tolerance remains unqualified. The final
end-to-end surface matrix did complete and pass; it removes the former surface
publication blocker but does not override the native promotion failures.

## Evidence rules and immutable boundaries

- Managed/container-backed `just` recipes are the native FEM authority. Host
  tests are supporting diagnostics only.
- The same-source Gate 10 baseline is numerical revision `1cb60fb3`, with only
  export-image tooling `18a5626a` and pairing harness `b991148d` applied. The
  candidate is exact revision `b991148d`, whose numerical delta is `13ff4fbb`.
- Each Gate 10 lane used one warm-up and five measured repeats, sequentially on
  the same host and pinned Docker image.
- Gate 9 and Gate 10 threshold failures were retained. No threshold, tolerance,
  accepted data, or default solver policy was weakened.
- Post-qualification exporter, pairing, and persistence hardening commits are
  source/tooling fixes. Their focused tests and API/frontend contracts pass.
  The persistence hardening additionally has a fresh managed persist-on proof
  at exact source commit `0ad2f528`; the native performance gates and complete
  216-row surface matrix were not rerun at those revisions.
- Protected/user-owned files and generated runtime outputs are excluded from
  the closure commit.

## Accepted baseline integrity

The three accepted files are byte-identical to `HEAD` and were not staged:

| File | SHA-256 |
|---|---|
| `benchmarks/fem-gpu/accepted/rtx4080-sm89/benchmark.csv` | `5e639e2a1c682747e21e3ed4f3da7bd7bc8b261e5562594862c0c0cd93e04a2e` |
| `benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json` | `8346f0ddd3d85df294a672d132d9508c01eb3256c0a5c6fc6ab1e2a3d2cd17ef` |
| `benchmarks/fem-gpu/accepted/rtx4080-sm89/summary.json` | `707fd408c121c633ccff2cccb621c053bbb6f6230bc5a2611d5a6bc51bd01b0f` |

The committed accepted distributions remain:

| Backend | Wall p50 / p95 / stddev (ms) | Demag apply p50 / p95 / stddev (ms) |
|---|---:|---:|
| FEM CPU | `10407.728 / 11094.684 / 317.883617` | `113.389081 / 122.522337 / 4.727097` |
| FEM GPU | `5186.222 / 5225.245 / 39.843093` | `54.967739 / 56.574542 / 2.132638` |

## Managed runtime identities

After all native qualification A/B lanes, the active alias in the original
task worktree remains restored to:

`fem-gpu-variants/hypre-baseline-69c8f5aba47c02da7f4581147fad5245d023165cbf42ea190a760a50651f08b4`

The manifest SHA-256 is the suffix
`69c8f5aba47c02da7f4581147fad5245d023165cbf42ea190a760a50651f08b4`.
It is schema v2, baseline allocator, CUDA 12.4, MFEM 4.9, HYPRE 3.1.0,
libCEED 0.12.0, and Docker image
`sha256:9a99bfb02afa5b0c9744797ab66fb03e05520368e0a3a652fc49b917ffcdb8bf`.
Fullmag FEM, MFEM, and HYPRE contain native `sm_89`; HYPRE validation reports
1536 bindings. The relevant library hashes are:

| Artifact | SHA-256 |
|---|---|
| `libfullmag_fem.so.0.1.0` | `dab56d9509a31d5af402df95508915a081976360c2d45c9fccc85f8124e2b404` |
| `libHYPRE-3.1.0.so` | `d2699a93ff310c7990583ca1b639254d5fa8bea462bef7599d8325bd1456f853` |
| `libmfem.so.4.9.0` | `16cdc246b93d436076de24d9d9024e355d25456e6d89138a995d14930b2f2898` |
| `libceed.so` | `58531e367d3fe20a342a645ac754765fa95d016bd4f3ba9e1bc3b875845b41dc` |

The post-hardening persistence proof used a fresh runtime built in the clean
reordered worktree `/tmp/task18-closure-reorder`. Its active alias was:

`fem-gpu-variants/hypre-baseline-479117149ec7c23a9fa84e5e4bf865e875b324d186c3564bd8bb35658432c9e8`

The manifest SHA-256 is the suffix `479117...`; its source-manifest SHA-256 is
`91527a16d8695b02b3ce0a06f018097f77d9609c619bd4efb115933901a42882`.
The build worktree HEAD was `1bece233bee3c5327f6a955d1f25a02bc41a64d3`,
and both the committed delta from `0ad2f528` plus the working-tree delta were
closure-audit-only. The executable source under test therefore maps exactly to
source commit `0ad2f528716ff483810fd2b4ea3ebe2d839c2efe`; the closure commit is
not part of the runtime behavior.

`env COMPOSE_PROJECT_NAME=fullmag just ensure-managed-fem-runtime` returned
exit 0 and validated schema v2, compute capability 8.9, 1536 HYPRE bindings,
and `libHYPRE-3.1.0.so`. The immutable image ID is
`sha256:9a99bfb02afa5b0c9744797ab66fb03e05520368e0a3a652fc49b917ffcdb8bf`;
compatibility-tag observation reported `drift_observed=false`, and the unique
per-export build tag was removed after publication. Fresh artifact hashes are:

| Artifact | SHA-256 |
|---|---|
| managed launcher | `4a47ee13f5c2f1ae0d58ccbfe071085a443bfdb4b7ddf8a76cac668e3be58de1` |
| FEM worker | `8668acaae4077ee648b59743e7d3361a968dd2da41750848d09e53553ae91494` |
| API | `6e49a2534f1902fb4aca923434d035c4001b44759b85f09f543809d1225aa57b` |
| PyO3 core | `c0ac9e67d689bd58cbcd7e40fc32d2725ca68435d4d8674120e886e30a7d3bb8` |

This fresh variant is evidence scoped to the clean reordered worktree. It was
not installed over the original task worktree's restored `69c8...` alias.

The pre-existing backup alias remains
`fem-gpu-variants/recovered-pre-task6-sm52-5e39b07df83af81208b656c8a5a2aabc6edc430152caf0f33bb5bcb1301ca684`.

## Task 0-17 closure ledger

`validated` below applies only to the named scope. It never means the full
Task 18 objective or NIST-class physical qualification is complete.

| Task | Status | Commits | Managed commands | Durable evidence | Distribution / performance result | Physics / parity result | Remaining scope |
|---:|---|---|---|---|---|---|---|
| 0 | `validated` | `32acc87a`, `79f08acf` | `just verify-fem-gpu-performance-regression` | `examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json`; accepted/reference directories | Frozen repeat-five CPU/GPU p50, p95, stddev shown above | Stable fixture, mesh, stop-condition, and observable identity | Accepted data must remain frozen until a complete promotion gate passes |
| 1 | `validated` | `21fd0cb2`, `00ade3be`, `3e0ca3d5`, `d8ff727b`, `36aa06dd`; hardening `0ad2f528` | `just verify-fem-relaxation-runtime`; persist-on preview lanes | profiler JSONL, diagnostics, and Task 1 review reports | Historical five measured runs contain 535 JSONL samples with all named and total/per-step gap values zero; fresh post-hardening managed lane adds 107 measured samples and acknowledges `107/107` persistence jobs | Bounded opt-in profiler and fail-closed asynchronous persistence contracts pass; not a physics qualification | Distribution is the measured persisted `full_cache/c10/interactive_no_browser` lane, not a promotion distribution; full matrix was not rerun after `0ad2f528` |
| 2 | `production_executable` | `4e42d36e`, `d40ea448` | frontend/API generation, hygiene, typecheck, lint, tests | OpenAPI v2, generated client, footer telemetry tests | Solver/end-to-end/published and current/delta/cumulative semantics separated | Resource-first API/UI contract passes | No new performance promotion claim |
| 3 | `production_executable` | `e69d415f`, `18f5ac06`, `e1e42135`, `93fb8d6e`, `3b227add`, `0abea3aa`, `fe1bb99f` | `just verify-fem-relaxation-source-contract`; production benchmark | Task 3 reports and managed benchmark mesh-group evidence | One stable solver-mesh group; per-step topology/fingerprint work removed | Remesh/adaptive/interactive identity ownership covered | Full cross-surface memory profiling remains outside the evidence |
| 4 | `validated` | `30cbe0c2`, `2263eac9`, `7599f789` | managed relaxation/runtime and publication tests | Task 4 reports, publisher/profile diagnostics, final surface matrix | Move ingest, lightweight heartbeat, bounded worker publication; final callback max `1.243325 ms`, schedule-fence max `1.461273 ms`, combined max `1.601668 ms`, zero callback wall outliers | Revision-safe compare-and-commit behavior passes | No performance promotion claim |
| 5 | `validated` | `ad67da90`, `09f00cce`, `156322e8`, `c2c65ad6`, `b9d15d6f`; hardening `0ad2f528` | `just verify-fem-preview-surface-matrix`; preview energy/round-trip contracts | `.fullmag/reports/fem-preview-surface-matrix/20260727-194811/summary.json`; `.fullmag/reports/task-18-closure/20260728-post-persistence-runtime-proof/` | Final matrix PASS: 36 warm-ups plus 180 measured rows; fresh managed persist-on lane PASS: one warm-up plus one measured row | Exact cross-surface `m` and terminal `H_demag` evidence; post-hardening persistence completion is managed-runtime API truth | Complete matrix predates `0ad2f528`; the fresh managed proof is intentionally focused to `full_cache/c10/interactive_no_browser` |
| 6 | `validated` | `8beba83e` | `just rebuild-fem-runtime`; `just ensure-managed-fem-runtime` | `.fullmag/reports/fem-gpu-runtime-architecture-ab/20260723-task6-v9-final`; schema-v2 manifests | Packaging/integrity task; no solver timing promotion | Native `sm_89`, loader identity, hashes, collision/stale-address and HYPRE binding gates pass | None for bundle integrity; performance is evaluated separately |
| 7 | `validated` | `21a63684`, `fbc14172` | `just verify-fem-relaxation-source-contract`; production benchmark | Task 7 report and managed runtime logs | NCG: 128 logical RHS and 193 synchronizations for 64 steps, exact limit 195; 3 control sync/step baseline | Fresh endpoint and monotone accepted-state contracts pass | Does not by itself qualify time to tolerance |
| 8 | `validated` | `b1e37dde`, `7c44dd22`, `fd3a3463`, `7ad30ac7`, `b15a9240`, `677d7ccf`, `2c086344`, `b0467c8d`, `74708483`, `0f990741`, `ce88229d`, `7fc672df`, `7d20569e`; merge `425f488a` | source contract and `just verify-fem-relaxation-production-benchmark` | `.fullmag/reports/task8-qualification/final-post-review-*`; Task 18 Gate 8 log | PG-BB exact 4 control sync/step; fresh Task 18 matrix passed 360/360 rows | Direct signed Armijo increments, exclusive energy ownership, CPU/GPU derivative and representability contracts pass | Task 18 remains globally unqualified despite the scoped algorithm result |
| 9 | `no_go` | `5ed238a9`, `e9a06c04`, `91dd5684` | AMG policy/benchmark contracts, profile sweep, demag and performance gates | `docs/audits/2026-07-20-fem-amg-relax-policy-qualification.md`; `.fullmag/reports/fem-amg-relax-policy-qualification/qualification-summary.json` | Type 6 candidate gmean p50 improvement `11.5938%`, but CPU PG-BB p95 violations `+23.71%` and `+6.67%` | 240/240 rows, exact policy pairs, parity and trajectories passed | Default remains relax type 18; final Gate 9 is `NO_PROMOTION` |
| 10 | `no_go` | `05dfec97` | `just build-all-fem-hypre-memory-variants`; managed variant A/B and restore | `docs/audits/2026-07-20-fem-hypre-memory-strategy-qualification.md`; `.fullmag/reports/fem-hypre-variants/` | CUDA async end-to-end p50/p95 `+1.565%/+1.990%`; Umpire `+11.316%/+13.972%`; neither promotes | 64 steps, residual `4.978e-13`, strict residency and zero hot-loop compute transfers | Baseline allocator retained |
| 11 | `no_go` | `066c49f5`, `0cc26d08`, `fed934f2`, `f7128675` | `just verify-fem-gpu-relaxation-preconditioner-qualification`; managed runtime/source gates | `docs/audits/evidence/task-11/task-11-relaxation-preconditioner.csv`; `docs/audits/evidence/task-11/task-11-relaxation-preconditioner-qualification.json`; `docs/audits/evidence/task-11/SHA256SUMS`; `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md` | No strategy reached 10% p50 improvement on any of three sizes; coarse CG4/CG8 p95 regressions exceeded 5% | Corrected evidence is `status=invalid`; required final-magnetization parity is missing | No implementation/selector retained; no strategy promoted |
| 12 | `deferred` | `9358808e`, `ebf711d6`, `575d6f1f` | `just verify-fem-gpu-host-thread-policy-qualification`; managed A/B restore | `.fullmag/reports/task-12-host-thread-policy/qualification.json`; `.fullmag/reports/task12-review-runtime-ab-task10-current-v2/` | Historical v1 candidates missed 5% p50 contract; controlled Task10/current p50 `25702.351/25910.452 ms`, p95 `26623.422/26227.533 ms` | v1 evidence is invalid under fail-closed v2 identity/telemetry contract | Deliberate thread-1 default retained without qualification |
| 13 | `deferred` | `4fb57146`, `96d486f6` | `just capture-fem-gpu-nsight`; full managed relaxation verification after restore | `.fullmag/reports/task-13-nsight/task13-box500-airbox-ncg-sm89-v1/summary.json`; Task 13 report | No qualified kernel distribution: current summary is `unavailable`; prior capability-enabled capture reported zero unique kernel rows and `ERR_NVGPUCTRPERM` | Default-OFF NVTX/runtime contract passes | Obtain `status=captured`, kernel rows, occupancy/bandwidth/launch/stall metrics on a capable host |
| 14 | `no_go` | `2b7d966a` | `just bench-fem-gpu-demag-amg-profile-sweep`; demag/runtime/performance gates | `docs/audits/2026-07-20-fem-amg-coarse-strategy-qualification.md`; `.fullmag/reports/fem-amg-coarse-strategy-qualification/` | 48/48 warm-ups and 240/240 measured rerun rows; no axis passed complete p50/p95/apply gate | Solver policy remains byte-identical to Task 9 | No coarse strategy or autotuner promoted |
| 15 | `implemented` | `2d08af31`, `56addae3`, `43bb49b3`, `340cbfde`, `530fdf8e`, `b12a7aae` | crossover source/runtime/API/frontend gates | `docs/adr/0021-fem-runtime-crossover-policy.md`; `benchmarks/fem-gpu/crossover/rtx4080-sm89.json` | Checked profile deliberately has `qualified:false`; no production distribution is activated | Explicit CPU/GPU remains pinned/fail-closed; `auto` is availability-first | Authoritative loaded-runtime identity and a fresh qualified multi-size profile are missing |
| 16 | `no_go` | `0fbe268e` | Task 13 capture prerequisite and documentation checks | `docs/audits/2026-07-20-fem-gpu-cuda-graphs-evaluation.md` | No kernel-attribution evidence, so no graph/fusion performance experiment was authorized | Production code/default unchanged | Reconsider only after a qualified Task 13 trace |
| 17 | `no_go` | `2cb3695a`, `1110c66d`, `86400973`, `ed78f306` | delta oracle/convergence, demag, relaxation and performance gates | `docs/physics/0582-fem-deterministic-delta-potential-demag.md`; `docs/audits/2026-07-20-fem-delta-potential-demag-qualification.md`; `.fullmag/reports/fem-delta-potential-qualification/` | Non-attributable archived aggregate p50 `+15.36%`, but coarse/fine NCG regress; accepted gate failed CPU p95 `+16.68%`, GPU p95 `+13.27%` | Convergence/physics qualification returned no-go; production prototype and switches removed | Research may restart only with reproducible identity and full convergence/parity evidence |

## Task 18 remediation commits

The final-qualification work added these scoped fixes before the A/B:

1. `3e05babb` — bound adaptive FEM exchange fixture.
2. `d22358af` — normalize unset FEM field grids.
3. `7023b560` — bound preview matrix API lifecycles.
4. `09df6134` — qualify persisted preview profiles.
5. `d0cd7350` — pin normalized grid mesh access.
6. `1cb60fb3` — preserve NCG failure diagnostics.
7. `13ff4fbb` — use direct Armijo increments for NCG.
8. `18a5626a` — pin managed export image identity.
9. `b991148d` — pair CPU/GPU demag policies exactly.
10. `66dcc124` — isolate managed export builds from mutable compatibility-tag races.
11. `7768e353` — reject structurally partial requested demag-policy tuples.
12. `0ad2f528` — publish and fail closed on asynchronous profile persistence completion.

## Final gate ledger

### Native gates

| Gate | Command | Result | Authoritative artifact |
|---:|---|---|---|
| 1 | `just verify-fem-relaxation-source-contract` | PASS | `.fullmag/reports/task-18-closure/20260727-final/native-01-relaxation-source-contract.log` |
| 2 | `just verify-fem-exchange-runtime` | PASS on corrected rerun | `.fullmag/reports/task-18-closure/20260727-final/native-02-exchange-runtime-rerun.log` |
| 3 | `just verify-fem-demag-poisson-contract` | PASS | `.fullmag/reports/task-18-closure/20260727-final/native-03-demag-poisson-contract.log` |
| 4 | `just verify-fem-time-domain-native-contract` | PASS | `.fullmag/reports/task-18-closure/20260727-final/native-04-time-domain-native-contract.log` |
| 5 | `just verify-fem-frequency-domain-native-contract` | PASS | `.fullmag/reports/task-18-closure/20260727-final/native-05-frequency-domain-native-contract.log` |
| 6 | `just verify-fem-relaxation-runtime` | PASS | `.fullmag/reports/task-18-closure/20260727-final/native-06-relaxation-runtime.log` |
| 7 | `just verify-fem-relaxation-cpu-gpu-consistency-smoke` | PASS, 6/6 rows | `.fullmag/reports/task-18-closure/20260727-final/native-07-relaxation-cpu-gpu-consistency-smoke.log` |
| 8 | `env COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-production-benchmark` | **PASS**, exit 0; 360/360 rows, 27 completed case groups, `pair_count=900`; appended clean build and Zhang-Li runtime/convergence gate passed | `.fullmag/reports/task-18-closure/20260728-same-source-ab/gate08-post-task18-fixes.log` (SHA-256 `d2adb3cf0f8fe1208af7d95a8f20ff9331587fcf01f3384da86f399ffed8b7a5`) |
| 9 | `env COMPOSE_PROJECT_NAME=fullmag just verify-fem-gpu-demag-performance-benchmark` | **NO_PROMOTION**, exit 4; 54/54 rows, 27 CPU/GPU policy pairings and core summary passed, policy performance gate failed | `.fullmag/reports/task-18-closure/20260727-final/gate09-after-policy-pairing.log` |
| 10 | `env COMPOSE_PROJECT_NAME=fullmag FULLMAG_BENCH_REPEAT=5 just verify-fem-gpu-performance-regression` | **NOT_PROMOTED**, exit 7; 10/10 rows and correctness/residency passed, committed accepted p95 gate failed | `.fullmag/reports/task-18-closure/20260728-same-source-ab/{baseline,candidate}/` |

The old Gate 8 log ending with exit 8 is superseded by the fresh Gate 8 run
above. The first Gate 2 run and first Gate 9/10 attempts are also preserved but
are not the authoritative final result.

The appended Gate 8 clean managed build completed in 17m39s. Its temporary
runtime manifest was `445cc00464a40d3d85b80635029805fc0629856fe21c95ae4a32651a03bb51f0`.
The Zhang-Li validator passed CPU/GPU parity and reported time-step order
`2.0000893511` and mesh order `1.8064680027`. After the recipe, the active alias
was restored to the exact `69c8...` pre-run bundle and
`just ensure-managed-fem-runtime` returned exit 0 with compute capability 8.9
and 1536 HYPRE bindings. No Fullmag Compose containers remained.

After persistence hardening, `env COMPOSE_PROJECT_NAME=fullmag just
rebuild-fem-runtime` was rerun from the clean reordered worktree. A first
attempt using the default Compose project stopped before export because Docker
could not allocate another network from its predefined address pools. The
authoritative retry used `COMPOSE_PROJECT_NAME=fullmag`; its complete release
build finished in `17m58s`, the container-side export completed, both bundle
validations passed, and publication returned exit 0. The subsequent
`ensure-managed-fem-runtime` proof is the fresh `479117...` identity documented
above. The earlier same-project attempt had completed its build but failed
host finalization with `No space left on device`; the exact cleanup and
recovery are recorded below rather than hidden.

### Frontend/API gates

| Command | Result | Artifact |
|---|---|---|
| API generation through isolated `corepack pnpm` target | PASS at qualification revision | `.fullmag/reports/task-18-closure/20260727-final/frontend-01-generate-api-isolated-target.log` |
| `pnpm --dir apps/control-room check:api-hygiene` | PASS | `.fullmag/reports/task-18-closure/20260727-final/frontend-02-check-api-hygiene.log` |
| `pnpm --dir apps/control-room typecheck` | PASS | `.fullmag/reports/task-18-closure/20260727-final/frontend-03-typecheck.log` |
| `pnpm --dir apps/control-room lint` | PASS, zero warnings | `.fullmag/reports/task-18-closure/20260727-final/frontend-04-lint.log` |
| `TMPDIR=/tmp pnpm --dir apps/control-room test` | PASS: 3765 passed, 1 skipped | `.fullmag/reports/task-18-closure/20260727-final/frontend-05-test.log` |
| `pnpm --dir apps/control-room audit:compute-performance` | PASS | `.fullmag/reports/task-18-closure/20260727-final/frontend-06-audit-compute-performance.log` |

The direct `pnpm` API-generation launcher was unavailable and two intermediate
attempts failed for tool/permission reasons. The isolated-target `corepack`
run is the final authoritative generation result; those failed logs are kept
for transparency.

The first Task 18 preview-surface attempt is preserved at
`.fullmag/reports/task-18-closure/20260727-final/e2e-preview-surface-matrix.log`
and ended on an HTTP 500. It is superseded, not hidden, by the authoritative
PASS at `.fullmag/reports/fem-preview-surface-matrix/20260727-194811/`:
36 warm-ups plus 180 measured rows (`216/216`), 37 API lifecycles with at most
6 rows each, exact final `m` and terminal `H_demag` equivalence, 60 live async
rows, 60 terminal H_demag/Zarr rows, callback max `1.243325 ms`, schedule-fence
max `1.461273 ms`, combined max `1.601668 ms`, and zero callback wall outliers.

The historical explicit persist-on lane is
`.fullmag/reports/task-18-closure/20260727-final/profiler-on-persist-on/`.
It passed one warm-up plus five measured repeats. Callback max was
`0.363444 ms`, callback-plus-fence max `1.210014 ms`, with zero wall outliers.
Every repeat persisted 107 JSONL samples. Across the five measured artifacts,
all 525 named interval-gap values and all 535 total/per-step gap values are
zero.

Source commit `0ad2f528` subsequently made sink completion/failure revisioned
API truth and requires `completed == enqueued > 0` for every interactive row.
Its fresh managed proof is:

`.fullmag/reports/task-18-closure/20260728-post-persistence-runtime-proof/`

It passed one warm-up plus one measured
`full_cache/c10/interactive_no_browser` row in one API lifecycle. The measured
row reports `persist_enqueued_count=107`, `persist_completed_count=107`,
`persistence_failed=false`, and nonempty artifact refs
`["diagnostics/solver_profile.jsonl"]`. The warm-up passed the same live
fail-closed contract. Both `r0` and `r1` artifacts contain 107 independently
JSON-parsed JSONL records. The measured row reports callback max `0.232664 ms`,
schedule-fence max `0.375512 ms`, combined max `0.550345 ms`, and zero callback
wall outliers. Exact final `m` delta is zero, and terminal `H_demag` equals the
Zarr payload hash. The report and raw-row SHA-256 values are respectively
`e3c99ca0f936fa5b2497ab21f5e7922f5812d7702c5bd235443b51a21660602b`
and
`2edf53a76d62a7b9b1cca436f93abbd20960ae9327ebc3b15a0dd12c4710313c`.

The script's shared preflight requires `apps/control-room/out/index.html` even
for no-browser rows. The run temporarily linked the existing task-worktree
7.8 MB static export only to satisfy that input check; the selected surface was
`interactive_no_browser`, no browser was launched, and the temporary symlink
was removed immediately after the proof. Focused CLI, API, and 29 harness tests
also pass. The complete managed surface matrix was not rerun after the
hardening; this fresh lane closes the counter/sink-completion proof only.

Post-qualification closure verification also passed: exporter helper tests
`39/39`; selected CPU/GPU consistency tests `22/22`; CLI persistence tests
`4/4`, final sink success/failure `2/2`, and immediate-sink ordering `1/1`;
API schema `2/2` and resource route `1/1`; canonical OpenAPI JSON/type/client
generation; API hygiene, Control Room typecheck and zero-warning lint. The
generated client and paths did not change; JSON and TypeScript schemas changed
additively for `persistence_failed`, `persist_enqueued_count`, and
`persist_completed_count`.

## Gate 10 sequential same-source A/B

Durable directory:
`.fullmag/reports/task-18-closure/20260728-same-source-ab/`.

### Identity

| Item | Baseline | Candidate |
|---|---|---|
| Numerical revision | `1cb60fb376293200709c319a12d87e390a5592fa` | `b991148d8c27fd2e5a36e8dd3c6adc55fe6fa60a` with numerical delta `13ff4fbb` |
| Exact executed HEAD | synthetic `0101d5ca79daf01d87be0543053f0db409320469` | `b991148d8c27fd2e5a36e8dd3c6adc55fe6fa60a` |
| Git tree | `df19d8ac084d73e966e6dfbf6edc0708174764fa` | `7c363626dabcf02e87cd29e4b2145ee7249220aa` |
| Runtime manifest | `8fcac1436d94601fc00e435f9a25dbe892f00c421b828c30e7a9594b7800179f` | `a27eb7b0b56edb6c88448d507df533883d66e7c2ccaca4c8f2a6205441df06c0` |
| Docker image | `sha256:9a99bfb02afa5b0c9744797ab66fb03e05520368e0a3a652fc49b917ffcdb8bf` | same |
| Fixture / environment / accepted CSV | `66b7134acf264ebfc1614ee8d4d62a69940489e1be876387d83a68c729236792` / `8346f0ddd3d85df294a672d132d9508c01eb3256c0a5c6fc6ab1e2a3d2cd17ef` / `5e639e2a1c682747e21e3ed4f3da7bd7bc8b261e5562594862c0c0cd93e04a2e` | byte-identical |

### Distributions and attribution

| Metric | Baseline p50 / p95 / stddev (ms) | Candidate p50 / p95 / stddev (ms) | Candidate relative to baseline p50 / p95 |
|---|---:|---:|---:|
| CPU wall | `11346.946 / 11871.477 / 235.922114` | `12020.148 / 12143.339 / 375.811659` | `+5.932892% / +2.290044%` |
| GPU wall | `5881.373 / 5995.255 / 84.303128` | `5749.713 / 5963.388 / 132.490278` | `-2.238593% / -0.531537%` |
| CPU demag apply | see lane ledger | see lane ledger | `+5.864012% / -3.016785%` |
| GPU demag apply | see lane ledger | see lane ledger | `-3.686540% / -1.252490%` |

Paired CPU/GPU wall speedup geometric mean improved from `1.9477315562` to
`2.0369529805` (`+4.580786507%`). Paired demag-apply speedup geometric mean
improved from `2.2268743185` to `2.3226904975` (`+4.302720556%`). Normalized
final observable summaries are byte-identical at
`f56805a049aee93152a0a48414c1a8170bcd59181a9955b77f43ebe58bba3402`.

The direct NCG fix restored valid accepted-energy evidence:

| Proof/residency signal | Baseline | Candidate |
|---|---:|---:|
| Accepted-energy proof count per GPU repeat | `0,0,0,0,0` | `64,64,64,64,64` |
| Invalid accepted-energy proofs, all GPU repeats | `320` | `0` |
| Compute/exchange hot-loop H2D, D2H, host sync | all zero | all zero |
| GPU engine / state / demag residency | `fem_native_gpu` / device source of truth / device | same |

This isolates attribution: the candidate GPU lane is slightly faster than the
immediately preceding baseline lane at p50 and p95, so the accepted-baseline GPU
failure is not attributed to `13ff4fbb` by this experiment. It does not change
promotion: baseline accepted-regression p95 is CPU `+7.00%`, GPU `+14.74%`;
candidate is CPU `+9.45%`, GPU `+14.13%`. Both exceed the fixed 5% limit.

Limitations: neither lane sampled clock or power traces; there is one sequential
pass; and the clean-build FDM library hash differed despite no FDM source delta.
The FEM benchmark does not load that FDM library, but the reproducibility gap is
recorded rather than hidden.

## Task 18 requirement-by-requirement decision

| Requirement | Evidence-backed result |
|---|---|
| Native `sm_89` and schema-v2 bundle integrity | PASS |
| No post-init topology hash/deep mesh clone | PASS for implemented ownership/source/runtime gates |
| Host gap p50 below 20 ms or fully attributed | PASS for the authoritative measured persisted lane: named gap p50/p95/max are all `0 ns`; total/per-step gaps are also all zero |
| NCG 3 and PG-BB 4 control sync per accepted baseline step | PASS for the named managed benchmark scope |
| End-to-end p50 improvement and no p95 regression over 5% | FAIL against accepted; no promotion |
| Same time to the same tolerance | NOT_QUALIFIED; fixed-step evidence is not a time-to-tolerance proof |
| API/UI truthful rate and delta/cumulative semantics | PASS |
| Preview, artifacts, and physics gates | PASS for the final 216/216 surface matrix and named native/physics gates; post-qualification persistence counters have a fresh focused managed-runtime proof, not a complete matrix rerun |
| Final candidate Nsight kernel/counter trace | MISSING / BLOCKED |
| Accepted baseline promotion | NO_PROMOTION; files unchanged |

## Cleanup and review boundary

Earlier closure cleanup removed only dangling builder cache with
`docker builder prune -f`: reclaimable build cache changed from `19.76 GB` to
`0 B`. The before/after records are under
`.fullmag/reports/task-18-closure/20260727-final/`. Two verified abandoned
staging directories were also removed.

The post-hardening export initially had only `1,356,558,336` bytes free. Two
exact, unused Docker objects were removed: dangling image
`sha256:806f823d24b593e459285b73127f16e8d600f7d5f677dad031d9d962de981f1a`
and detached volume `fem-gpu-end-to-end-remediation_target-cache`. The image
had zero unique bytes, and the volume's reported logical `3.193 GB` did not
release host filesystem blocks; no broad image, volume, or BuildKit prune was
performed. The preserved `fullmag_target-cache` contained the completed build
needed for retry.

The exact host cache `.fullmag/task6-cargo-target` was then verified as a
root-owned Cargo debug target: apparent size `4,538,425,635` bytes, no source
references outside itself, and no open files. Removing only that reproducible
cache increased free space from `1,356,423,168` to `5,910,593,536` bytes, a
measured recovery of `4,554,170,368` bytes. This allowed the successful export
and left sufficient margin for the approximately 1.48 GB staging bundle.

No runtime variant, active runtime alias, local-live tree, accepted data, or
evidence directory was deleted. The fresh 3.13 MB focused evidence directory
was copied byte-identically from the temporary reordered worktree into the
original task worktree before temporary cleanup.

The intended closure commit contains only this audit. In particular it excludes
`.superpowers/sdd/progress.md`, the untracked historical handoff, generated
`next-env.d.ts`, exchange CSV output, and `run_output/` artifacts.

Author self-review result: **SELF_REVIEW_PASS**. Independent final source
review after exporter, pairing, persistence-ordering, and disabled-row fixes:
**PASS — NO_ACTIONABLE_FINDINGS**.
