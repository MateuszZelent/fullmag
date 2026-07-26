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
