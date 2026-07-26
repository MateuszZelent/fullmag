# Task 11 FEM GPU relaxation preconditioner qualification

Date: 2026-07-26

Status: **NO-GO — no strategy is promoted and no production selection path is retained.**

## Decision

The literal qualification matrix completed, but none of the four candidate strategies met the performance and physical qualification contract. Task 11 therefore ends as a measured no-go. The default FEM GPU relaxation path remains unchanged.

The retained changes are limited to:

- the physics/design note,
- the exact benchmark matrix and fail-closed validator,
- synthetic validator tests,
- the managed `just` qualification recipe,
- this report.

The experimental owner, native implementation, runtime selector, ABI/API fields, generated bindings, and runtime tests were removed after the no-go decision. No candidate strategy is auto-selected or production-executable from the retained source.

## Qualification contract

The gate requires all of the following:

1. exactly 75 unique rows: 5 strategies x 3 mesh sizes x 5 repeats,
2. FEM GPU native execution with `nonlinear_cg`, exchange plus demag, fixed 64-step budget, and 8000 A/m torque tolerance,
3. finite physical observables, monotone accepted energy, bounded magnetization norm defect, zero prohibited hot-loop compute/exchange host synchronizations, and convergence by the torque stop,
4. final-energy and final-torque parity against the `none` baseline,
5. at least 10% p50 time-to-tolerance improvement on at least two of three mesh sizes,
6. no p50 or p95 regression greater than 5% on any size.

The exact strategies were:

- `none`,
- `diagonal_mass`,
- `lumped_exchange_mass_cg4`,
- `lumped_exchange_mass_cg8`,
- `stagnation_triggered_cg8`.

## Managed runtime evidence

The qualification ran through the repository-managed FEM GPU runtime path. The managed release export completed and validated a schema-v2 `hypre-baseline` bundle before the matrix ran.

Captured runtime identity from the CSV:

- runtime manifest SHA-256: `9377ad32bc08279eee8218b61007407974cd13e0c7599462f07abf05376db29a`,
- source manifest SHA-256: `e04b5d6066cf058222f4a5b3623765542227eec5b287bbd9ef7c46df219b5afc`,
- `libfullmag_fem` SHA-256: `c936d6cc9add692d9b1178ea9d10f3bc8267d321f045370453c5f9f488741a64`,
- execution engine: `fem_native_gpu`,
- assembly/execution mode: `legacy_sparse` / `all_in_gpu_legacy_sparse`,
- data residency: `device_source_of_truth`,
- MFEM device: `ceed-cuda:/gpu/cuda/shared`,
- hypre execution policy: `device`,
- demag preconditioner/provider: `AMG` / `mfem_hypre_boomeramg`,
- device compute capability observed during managed export: 8.9.

The CSV records `uses_cuda_kernels=true` and `uses_gpu_poisson=true`. A later host-side `nvidia-smi` probe was blocked by the sandbox, but the post-cleanup managed runtime explicitly reported `NVIDIA GeForce RTX 4080 SUPER`, compute capability 8.9, driver 13010, and CUDA runtime 12040. No UUID was recorded, so this report does not infer one.

## Literal result

Command:

```bash
just verify-fem-gpu-relaxation-preconditioner-qualification
```

Observed matrix result:

- rows: 75/75,
- runtime row status: 75 `ok`, 0 failed,
- matrix identity: complete,
- distinct stable solver-mesh signatures: 3,
- validator status: `no_go`,
- promoted strategy: `null`,
- validator exit code: 20, intentionally fail-closed for no-go.

Positive percentages below mean faster than `none`; negative percentages mean a regression.

| Strategy | Coarse p50 / p95 | Medium p50 / p95 | Fine p50 / p95 | Sizes with at least 10% p50 gain |
|---|---:|---:|---:|---:|
| `diagonal_mass` | -1.255% / -2.014% | +2.688% / +0.710% | -0.375% / -1.600% | 0/3 |
| `lumped_exchange_mass_cg4` | -5.390% / -41.010% | -1.802% / +3.321% | -2.061% / +0.983% | 0/3 |
| `lumped_exchange_mass_cg8` | -8.792% / -15.180% | +1.566% / +5.479% | -4.613% / -3.468% | 0/3 |
| `stagnation_triggered_cg8` | -3.026% / -4.702% | +7.763% / +5.590% | -0.585% / +1.842% | 0/3 |

No candidate reached the required 10% p50 improvement on any mesh size. CG4 and CG8 also exceeded the allowed 5% regression boundary on the coarse mesh. Several CG candidates failed final energy and/or torque parity against `none`.

All five strategies, including `none`, exhausted 64 steps without reaching the 8000 A/m torque stop on the fine mesh. That is an independent physical qualification failure and means the measured fine timings are not time-to-tolerance results.

## Validator correction

The first validator run incorrectly rejected negative `final_e_total_j` values. Negative total magnetic energy is physically valid for this problem; validity requires a finite value, not a non-negative one. The validator was corrected to require only finite total energy, synthetic coverage was retained, and the captured CSV was revalidated.

The corrected validator still returned exit code 20 with `status=no_go` and `promoted_strategy=null`. Therefore the no-go is not caused by the corrected energy-sign bug.

## Evidence locations

- benchmark CSV: `.fullmag/reports/task-11-relaxation-preconditioner.csv` (local ignored runtime artifact),
- corrected validator JSON: `/tmp/task-11-relaxation-preconditioner-qualification.json` (transient local artifact),
- original managed validator output: `.fullmag/reports/task-11-relaxation-preconditioner-qualification.json` (superseded because it contains the pre-correction energy-sign diagnostic),
- harness and validator: `scripts/analysis/fem_gpu_benchmark.py`,
- focused tests: `scripts/test_validate_fem_relaxation_runtime_log.py`,
- managed recipe: `just verify-fem-gpu-relaxation-preconditioner-qualification`,
- physics/design note: `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md`.

The retained recipe is the exact future qualification gate. Because the candidate owner and selector were intentionally removed, re-running it on the retained baseline is expected to fail closed until a new candidate implementation explicitly supplies all five requested/resolved strategy identities and telemetry fields.

## Post-cleanup verification

Observed after removing the production experiment:

| Command | Result |
|---|---|
| `python3 -m py_compile scripts/analysis/fem_gpu_benchmark.py scripts/test_validate_fem_relaxation_runtime_log.py` | PASS |
| `python3 -m pytest -q scripts/test_validate_fem_relaxation_runtime_log.py` | PASS, 291 tests |
| `just verify-fem-relaxation-source-contract` | PASS after clean C++/CUDA rebuild; semantic mesh ownership and full energy-derivative matrix passed |
| `just ensure-managed-fem-runtime` | PASS; clean release build completed in 17m35s and schema-v2 `hypre-baseline` bundle validated |
| `just verify-fem-relaxation-runtime` | PASS; clean managed bundle validated GPU `llg_overdamped`, `projected_gradient_bb`, and `nonlinear_cg`, plus CPU `llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg`, and `tangent_plane_implicit` |
| `git diff --check` | PASS |

The post-cleanup active managed variant is `hypre-baseline-47b182f02495898418b7a0ccc3599e8bcb47866d4e1fb76179af7a82e8197534`. This is distinct from the rejected candidate qualification bundle and proves that the final runtime smokes did not reuse the experimental native implementation.

## Continuation boundary

Do not promote diagonal mass, fixed-CG exchange mass, or stagnation-triggered CG8 from this experiment. A future attempt needs a materially different preconditioner or solver formulation and must rerun the same literal 75-case matrix. It must also address the fine-mesh inability to reach the torque tolerance within 64 steps before any time-to-tolerance claim can qualify.
