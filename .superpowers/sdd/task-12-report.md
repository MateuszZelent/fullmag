# Task 12 report: FEM GPU host OpenMP policy qualification

Status: **DONE_WITH_CONCERNS**

The host-runtime policy is implemented and qualified, and the selected GPU automatic default is deliberately one OpenMP thread. All functional, native, managed-runtime, device-identity, and 1/2/4/8 qualification checks passed. The required accepted-baseline performance gate remains red because the current accumulated runtime is persistently slower than the accepted RTX 4080 baseline; the baseline and the 5% threshold were not changed.

## Implemented contract

- Renamed the shared native helper to `configure_fem_host_runtime_threads` and call it once before the CPU/GPU device branch.
- Kept CUDA stream creation exclusively inside the GPU branch.
- Explicit GPU requests remain exact: requested 4 resolves to effective 4.
- GPU `auto` now resolves to effective 1 even when the managed launcher exports the CPU-oriented `FULLMAG_CPU_THREADS_AUTO_RESOLVED=8` hint.
- CPU `auto` still honors the external CPU resolution hint.
- Replaced the former GPU bypass reason with the public, FFI-stable `gpu-default-one` resolved-policy reason.
- Preserved Hypre device execution; no execution-policy fallback or CPU demag substitution was introduced.
- Added the managed `verify-fem-gpu-host-thread-policy-qualification` recipe and a strict JSON qualifier.
- Added compatibility in the accepted-baseline comparison key only: a legacy blank `requested_relaxation_preconditioner_strategy` is semantically normalized to `none`. The accepted CSV was not rewritten.

## TDD evidence

### RED

1. Python contract initially failed with `AttributeError` because `gpu_host_thread_contract_failures` did not exist.
2. The native contract initially failed to compile because the renamed helper and public policy symbols did not exist.
3. After managed performance telemetry exposed the launcher interaction, the new native test failed with:

   ```text
   FAIL: qualified GPU host policy overrides external CPU auto resolution
   ```

   The observed automatic GPU value was effective 8.
4. The accepted-baseline compatibility test failed only at tuple index 6: current `none` versus legacy empty string.

### GREEN

- `python3 -m pytest -q scripts/test_validate_fem_relaxation_runtime_log.py` -> `332 passed`.
- `just verify-fem-time-domain-native-contract` -> exit 0 after the final native policy change.
- The native GPU-auto test now observes effective 1 and the `gpu-default-one` reason; explicit GPU 4 still observes effective 4.
- `git diff --check` -> exit 0 before report generation.

## Managed runtime identity

The runtime was rebuilt through `just ensure-managed-fem-runtime`, not with a host-first build. The schema-v2 bundle validator reported:

- runtime: `fem-gpu-host`
- variant: `hypre-baseline`
- GPU compute capability: `8.9`
- Hypre provider: bundled `libHYPRE-3.1.0.so`
- Hypre binding count: `1536`

The managed relaxation gate identified `NVIDIA GeForce RTX 4080 SUPER`, `device_hypre_poisson`, and `hypre_gpu_policy=device`.

## Exact A/B matrix

Recipe: `just verify-fem-gpu-host-thread-policy-qualification`

- thread counts: 1, 2, 4, 8
- profiler: off, on
- surface: headless, interactive
- one warmup for every combination: 16 warmups
- five measured repeats for every combination: 80 measured rows
- completion: 96/96 executions successful; 80/80 measured rows accepted
- every measured row retained `fem_demag_operator_mode=device_hypre_poisson` and `hypre_execution_policy=device`
- qualifier: `.fullmag/reports/task-12-host-thread-policy/qualification.json`
- schema: `fullmag.fem_gpu.host_thread_policy_qualification.v1`

The promotion thresholds were at least 5% end-to-end p50 improvement in every profiler/surface case, no p95 regression above 5%, and no increase in CPU oversubscription.

| Threads | End-to-end p50 improvement: headless off / interactive off / headless on / interactive on | p95 violations | Oversubscription result | Decision |
|---:|---|---|---|---|
| 1 | baseline | none | process-level diagnostic true in all four baseline cases | deliberate baseline |
| 2 | +3.006% / -8.046% / +2.147% / -1.786% | interactive/off +11.505% | false in all four cases; no increase versus baseline | reject |
| 4 | +1.312% / -9.622% / -1.432% / -5.138% | interactive/off +9.625% | false in all four cases; no increase versus baseline | reject |
| 8 | +2.416% / -3.222% / -4.479% / -0.188% | interactive/on +9.760% | false in all four cases; no increase versus baseline | reject |

No candidate achieved the 5% p50 contract. The qualifier therefore returned:

```json
{
  "status": "pass",
  "decision": "retain-deliberate-default-one",
  "resolved_default_threads": 1,
  "expected_measured_row_count": 80,
  "observed_measured_row_count": 80,
  "failures": []
}
```

The one-thread `host_cpu_oversubscribed` signal is process-level, derived from child-process CPU time versus effective OpenMP threads; it includes control-plane, publisher, and writer activity and is not an OpenMP-only counter. The promotion rule is no *increase*, and every candidate reduced that signal to false.

## Measurement semantics

- create/setup: exact `backend_create_wall_time_ms`
- steady solver: exact `step_wall_time_ms`
- writer contention: exact artifact metadata `artifact_writer_job_wall_time_ms`
- callback/publisher gap: `callback_gap_estimate_ms`, the non-negative end-to-end residual after create and native step timings, divided by executed steps
- host CPU use: child-process `getrusage` CPU time divided by wall time

The callback gap is intentionally labelled an estimate. It includes callback, publisher, control-plane, and unclassified end-to-end work; it is not a direct callback span. No claim of an exact publisher-only measurement is made.

## Required verification gates

### Passing

- `just verify-fem-time-domain-native-contract` -> exit 0.
- `just verify-fem-relaxation-runtime` -> exit 0 after the final schema-v2 managed rebuild. GPU `llg_overdamped`, `projected_gradient_bb`, and `nonlinear_cg` smokes completed; CPU `tangent_plane_implicit` completed.
- A/B qualification recipe -> pass with deliberate default 1.
- Managed accepted-baseline runs: every scientific row, CPU/GPU consistency check, stable mesh signature, strict GPU residency check, demag convergence check, and device-Hypre identity check passed.

### Persistent concern

`just verify-fem-gpu-performance-regression` remains red only on accepted-baseline wall-time p95. The final cooled rerun reported:

- current CPU p50/p95: 11420.640 / 12182.982 ms; accepted CPU p95 11094.684 ms; p95 regression +9.81%
- current GPU p50/p95: 5857.703 / 6278.925 ms; accepted GPU p95 5225.245 ms; p95 regression +20.17%
- exact current GPU telemetry in all five rows: requested 40, effective 1, `hypre_execution_policy=device`, `host_cpu_oversubscribed=false`
- 10/10 rows otherwise `ok`; CPU/GPU consistency summary `status=pass`

An immediately preceding run had current GPU p50/p95 5786.052 / 6436.007 ms, so the failure persisted after the GPU cooled to 41 C, 14.35 W, P8. The threshold was not weakened and the accepted baseline was not refreshed. NVIDIA's official benchmark methodology notes that warmup, sufficient repeats, cool-down, and clock monitoring are needed to control GPU clock variability; the exact cooled rerun was the only non-mutating remedy attempted. Hypre's documentation independently confirms that device memory/execution policy is separate from host OpenMP configuration.

References:

- https://docs.nvidia.com/cutlass/latest/media/docs/cpp/gemm_performance_measurement_methodology_guidelines.html
- https://hypre.readthedocs.io/en/latest/solvers-boomeramg.html#memory-locations-and-execution-policies

## Continuation

Treat the accepted-baseline p95 failure as a cross-task performance investigation. Do not promote 2/4/8 based on these data, do not rewrite the accepted baseline from this task, and do not weaken the 5% gate. A follow-up should profile why the current accumulated runtime is slower than the accepted snapshot while preserving the validated one-thread policy and device-Hypre identity.

## Review remediation and superseding status

The original v1 qualification above is retained as historical execution evidence, but its promotion conclusion is superseded. Review found that it did not pin the complete runtime/device/workload identity, normalized the CPU-use diagnostic by each candidate's effective thread count, and used a calculated callback residual plus cumulative writer service time instead of exact callback/publication/contention signals. Those gaps are now closed fail-closed in schema v2:

- every row must carry one identical runtime manifest, source manifest, `libfullmag_fem` hash, GPU UUID/model/compute capability, solver mesh signature, and host CPU capacity;
- every row must be the exact 32-step PG-BB/double/CG-AMG-`1e-12`/AMG6/device-Hypre/device-resident workload;
- candidate process CPU time and average-core-count p50 and p95 may not increase at all relative to the corresponding thread-1 profiler/surface baseline;
- qualification requires exact cumulative step-interval, native-solver, publisher-replace, publish-lag, artifact-enqueue-block, and artifact-queue-depth signals;
- the fabricated `callback_gap_estimate_ms` and cumulative writer-service proxy are no longer qualification metrics;
- each of the four managed matrix invocations captures the current GPU identity directly.

Adversarial tests mutate runtime, GPU, mesh, scenario, step count, algorithm, precision, tolerance, and Hypre execution policy one at a time. Every mutation returns `status=invalid`, retains thread 1, and makes all candidates ineligible. A separate adversarial test sets the old normalized oversubscription flag to false while increasing raw CPU use; the candidate is rejected on raw p50/p95. Missing any exact cumulative signal also makes the whole qualification invalid.

The already-captured 80-row v1 matrix lacks GPU identity and the exact cumulative publisher/publish-lag/enqueue/queue signals. It must therefore be treated as **invalid/no promotion** under v2. It still supports the operational observation that no tested candidate had a compelling end-to-end result, but it no longer qualifies any default. The implemented automatic GPU policy remains the conservative deliberate value 1.

## Accepted-regression root-cause trace

The accepted and current performance rows use the same physical fixture, solver mesh signature `20a1851a39da191c61cf50006e72c4b977fa31a5a4cdf2dee1e037e93640d431`, canonical ProblemIR `403afa1214681d3317e23b14f4095dfea6141197cea813655c07d24104fbcc08`, NCG 64-step workload, CG/AMG6 policy at `1e-12`, device Hypre, and effective GPU OpenMP count 1. Their runtime identities are not the same:

| Identity | Accepted | Current |
|---|---|---|
| source snapshot/manifest | Git `bb46eac50415096d1805b30bab836f1260308863`; runtime manifest `65e02cbed5dc...` | source manifest `575996134af7...`; runtime manifest `692ee072525f...` |
| `libfullmag_fem` | `5c91c5e63d6...` | `5c63211f614c...` |
| HYPRE | `44f0d0e6a87b...` | `d2699a93ff31...` |
| MFEM | `1619251a4da3...` | `16cdc246b93d...` |

The regression is visible inside solver phases, not only in unclassified end-to-end time. Accepted to current p95 changes are:

- CPU demag solve: `122.591087` -> `143.391417` ms, about `+16.97%`;
- CPU demag apply: `122.522337` -> `143.318203` ms, about `+16.97%`;
- CPU assemble: `16.456374` -> `22.126492` ms, about `+34.46%`;
- CPU recover: `6.569447` -> `8.800722` ms, about `+33.97%`;
- GPU demag solve/apply: `56.574542` -> `66.667010` ms, about `+17.84%`.

The last recorded accepted-performance pass before this persistent red state is Task 9 (`5ed238a9` plus its identity closure), with GPU p95 `5484.353` ms, `+4.96%` and still inside the unchanged 5% gate. The first persistent recorded red state is Task 10 commit `05dfec97`, whose Docker dependency-layer change rebuilt HYPRE/MFEM and whose final retained bundle reported GPU p95 `5918.739` ms, `+13.27%`. This chronology identifies the inherited boundary, not a proven single compiler-level cause.

To isolate Task 12, a controlled immutable A/B used one common runner SHA-256 `00fd6bfeffa6c8b04e82ee1c586172acde8d4041132d6463dc637f902c83ee4d`, one RTX 4080, one localized fixture/ProblemIR, and two schema-v2 bundles with identical HYPRE `d2699a93...`, MFEM `16cdc246...`, libCEED `58531e36...`, and public C ABI:

| Metric | Task 10 final `6ba6c06a...` | Current `692ee072...` | Current delta |
|---|---:|---:|---:|
| steady wall p50 | `25702.351` ms | `25910.452` ms | `+0.81%` |
| steady wall p95 | `26623.422` ms | `26227.533` ms | `-1.49%` |
| steady create p95 | `5838.651` ms | `5884.849` ms | `+0.79%` |

The current Task 12 bundle improves the controlled end-to-end p95 relative to the already-red Task 10 bundle. Task 12 is therefore not the source of the accepted-baseline regression. The raw ignored A/B evidence is under `.fullmag/reports/task12-review-runtime-ab-task10-current-v2/`, and the script restored and revalidated the current candidate bundle afterward.

An exact green-Task9 versus Task10 causal bisect is not available: the exact green Task 9 runtime bundle was not retained, and the nearest earlier preserved Task 8 bundle has a different public C ABI because `fullmag_fem_backend_take_accepted_energy_proof_v1` was added later. Reverting Task 10 packaging or replacing dependency binaries without an exact matched-runtime proof would be unsafe and outside Task 12. No baseline, threshold, packaging policy, or solver policy was changed.

## Formal final status

**BLOCKED / DONE WITH CONCERNS.** The host-thread implementation and reviewed fail-closed v2 qualifier are implemented and focused-tested. Production qualification is blocked because current rows do not yet publish every required exact cumulative signal, and the mandatory accepted-performance gate remains inherited-red from the Task 10 runtime boundary. Task 13 owns the deeper dependency/runtime root-cause trace; no candidate thread count, accepted baseline, or packaging change is promoted here.
