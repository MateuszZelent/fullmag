# FEM HYPRE GPU memory-strategy qualification

Date: 2026-07-25  
Scope: Task 10 of `2026-07-20-fem-gpu-end-to-end-performance-remediation.md`  
Decision: **retain the HYPRE baseline allocator**

## Executive result

None of the tested allocator strategies satisfies the promotion contract. CUDA asynchronous allocation reduces the median HYPRE demagnetization apply time by 4.411%, but increases median end-to-end runtime by 1.565%. Umpire reduces the median demagnetization apply time by 4.919%, but increases median end-to-end runtime by 11.316% and median context creation by 11.926%. HYPRE 3.1.0 does not provide `--enable-thrust-async`, so that candidate correctly fails closed.

The active managed runtime must therefore remain the immutable baseline bundle. No allocator candidate is promoted to the default build.

## Qualification contract

A candidate can replace baseline only if it produces at least a 5% improvement in cold setup or steady end-to-end time, keeps the corresponding p95 regression at or below 5%, keeps device-memory growth at or below 10%, and preserves physics, solver convergence, GPU residency, and exact build identity.

The comparison used the same RTX 4080 (`sm_89`), mesh, solver policy, executable and 64-step nonlinear-CG workload for every candidate. Each variant received one warm-up run followed by five measured runs. Demagnetization used CG/AMG with relative tolerance `1e-12`, AMG relaxation type 18, coarsening 8, interpolation 6, and one aggressive-coarsening level.

Fixture: `examples/assets/fem_performance/box500_airbox_exchange_demag_amg_coarse_v1.mesh.json`  
Solver mesh signature: `ffe9595b4f6b6fc44fab022e733f2fbf2457ee8189929859a7f137f65dd10f11`

## Immutable runtime identities

| Variant | Bundle | Status |
|---|---|---|
| baseline | `hypre-baseline-d8fa926ef3c47c7200ef6bbb7b7614aabaa08868dd418edb5a3d5f235ce8686e` | valid schema-v2 bundle |
| cuda_async | `hypre-cuda-async-b1de88891f3f501bfb068b3379bceef6ec57d6045246691dae3a80ba228bfabf` | valid schema-v2 bundle |
| umpire | `hypre-umpire-d4b7e4c94fdc6401abd1926ad2c019b500977788601a38af2dd210281101bdb1` | valid schema-v2 bundle |
| thrust_async | none | unavailable in pinned HYPRE 3.1.0; fail closed |

All valid manifests record HYPRE 3.1.0, MFEM 4.9.0, exact configure flags and config macros, compiled CUDA objects, and `sm_89`. The Umpire candidate uses official `v2024.07.0`. Variant selection is atomic and occurs only after schema-v2 and CUDA-architecture validation.

## Measurements

All times are milliseconds. Percentages are relative to baseline; negative means faster.

| Metric | Baseline | CUDA async | CUDA delta | Umpire | Umpire delta |
|---|---:|---:|---:|---:|---:|
| End-to-end median | 24511.652 | 24895.379 | +1.565% | 27285.512 | +11.316% |
| End-to-end p95 | 24647.038 | 25137.522 | +1.990% | 28090.599 | +13.972% |
| Context-create median | 6276.729 | 6327.710 | +0.812% | 7025.288 | +11.926% |
| Context-create p95 | 6462.015 | 6631.432 | +2.622% | 7597.386 | +17.570% |
| First accepted demag median | 37.524 | 37.582 | +0.155% | 36.529 | -2.651% |
| First accepted demag p95 | 41.535 | 40.491 | -2.513% | 42.681 | +2.759% |
| Demag apply median | 20.181 | 19.291 | -4.411% | 19.189 | -4.919% |
| Demag apply p95 | 23.646 | 22.987 | -2.786% | 20.593 | -12.911% |

Raw end-to-end samples:

- baseline: 24044.114, 24433.216, 24511.652, 24537.591, 24647.038
- cuda_async: 24060.294, 24547.142, 24895.379, 25077.271, 25137.522
- umpire: 25205.475, 26321.544, 27285.512, 27455.646, 28090.599

Generated evidence is under `.fullmag/reports/fem-hypre-variants/`.

## Correctness, residency, and memory

Every measured GPU run completed 64 accepted steps, converged in 18 iterations to final residual `4.97768485520802e-13`, retained the same mesh signature, and passed the strict GPU-residency gate. Hot-loop compute transfers remained zero for H2D and D2H. Reported FEM GPU state allocation was identical for every valid variant: 156074 bytes, giving an observed state-memory delta of 0%.

These timing reports deliberately contain GPU rows only. Their aggregate CPU/GPU-consistency warning means no CPU row was supplied; it is not evidence of a physics mismatch. CPU/GPU parity remains covered by the separate managed demagnetization contract gate.

The state-byte counter does not expose allocator-pool reservations internal to CUDA or Umpire. It proves equal owned solver-state size, not complete process-wide peak VRAM. This limitation cannot rescue a candidate because neither passes the timing threshold.

## Build and packaging corrections

- Added explicit, fail-closed HYPRE memory variants to the managed container path.
- Added exact configure flags and generated config macros to schema-v2 manifests.
- Added immutable hash-addressed bundles and validated atomic selection.
- Moved variant inputs after allocator-independent dependency layers for cache reuse.
- Corrected metadata newline generation and macro parsing, with regression tests.
- Replaced nonexistent Umpire `v2024.07.1` with official `v2024.07.0`.
- Removed only obsolete generated candidate bundles after the filesystem filled; active and evidentiary bundles were preserved.

## Decision by candidate

- `cuda_async`: **no-go**. Hot demag median improves less than 5%; full-run median and p95 regress.
- `umpire`: **no-go**. Hot demag median improves less than 5%; setup and end-to-end regress beyond the allowed budget.
- `thrust_async`: **unavailable/no-go**. HYPRE 3.1.0 lacks the option. Substituting `--enable-thrust-nosync` would change the contract and is forbidden.
- `baseline`: **retained**. It is the only qualified default for Task 10.

## Continuation boundary

Task 10 ends with freshly rebuilt immutable baseline `hypre-baseline-6ba6c06acb8067836187bb6d2f609b198906d727bb8b32ae7e1d8b76b0d82769` selected and schema-v2 validated. The managed demag contract and CPU/GPU correctness, convergence, and strict-residency checks pass. The final accepted-performance gate remains red: GPU wall-time p95 is 5918.739 ms versus accepted 5225.24 ms, a 13.27% regression against the 5% limit. The accepted baseline was not rewritten. Tasks 11–18 are outside this qualification and were not started while closing this task.
