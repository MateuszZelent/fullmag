# Task 11 FEM GPU relaxation preconditioner qualification

Date: 2026-07-26

Status: **MEASURED NO-GO / INVALID QUALIFICATION — no strategy is promoted and no production selection path is retained.**

The review-remediation addendum below supersedes the earlier `status=no_go`
interpretation. The raw 75-row experiment is preserved, but the strengthened
contract correctly classifies it as `status=invalid` because mandatory
cumulative-work, separate CPU/GPU parity, and immutable execution-identity
evidence is absent.

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

## Review-remediation addendum

Date: 2026-07-26

### Corrected evidence classification

The strengthened validator preserves two separate facts:

1. The experiment executed all 75 requested managed FEM GPU rows with stable
   three-mesh and common runtime identities.
2. Those rows do not constitute a valid qualification matrix.

The corrected immutable JSON reports:

- `status=invalid`,
- `row_count=75`, `expected_row_count=75`,
- `matrix_complete=true`,
- `baseline_eligible=false`,
- `cpu_gpu_parity.status=missing`,
- `promoted_strategy=null`,
- validator exit code 20.

The `none` baseline is validated physically before any timing distribution can
become a reference. Its five fine-mesh rows stopped at the 64-step limit rather
than at the torque tolerance, so no candidate timing can qualify against it.
This closes the original loophole where an invalid baseline could still anchor
a promotion decision.

### Fail-closed contract added after review

The retained qualification harness now rejects:

- any workload other than exact double-precision, 64-step, 8000 A/m NCG on
  `box500_airbox_exchange_demag` with CG/AMG, `rtol=1e-12`, AMG relax type 6;
- CPU execution, non-CUDA/non-HYPRE execution, wrong device residency, mixed
  runtime/source/library identity, or unstable per-mesh solver identity;
- nonzero compute/exchange synchronization or transfer counters, and NCG
  control-scalar readbacks beyond the canonical cumulative-RHS budget;
- missing accepted-step, cumulative Armijo-trial, cumulative demag-solve,
  cumulative preconditioner-time, or cumulative HYPRE-time evidence;
- a `stagnation_triggered_cg8` strategy without a positive all-run apply count;
- missing or mismatched separate CPU/GPU `none` rows for all three meshes,
  including final magnetization vectors, final energy, convergence/stop state,
  runtime identity, and solver-mesh identity.

Synthetic RED cases were observed for an invalid `none` baseline, CPU engine,
wrong scenario, 999 control synchronizations, mixed runtime identity, mixed
mesh identity, every missing cumulative field, a zero-apply triggered strategy,
missing parity, magnetization mismatch, and parity runtime drift. The final
focused suite is 326/326 passing.

The final reviewer pass added an immutable execution-identity boundary. Future
qualification runs must provide both the existing three-resolution fixture
suite and the accepted RTX 4080 environment. The validator now requires every
matrix row and every parity row to match:

- the active managed runtime manifest, source manifest, and native-library
  SHA-256 values;
- the accepted GPU UUID, device name, and compute capability for GPU rows;
- the fixture-suite mesh byte hash, runtime mesh signature, node count, and
  element count for each resolution;
- the Task 11-specific canonical ProblemIR SHA-256 generated for the exact
  64-step, `dt=1e-13` s, 8000 A/m, CG/AMG workload;
- the scenario, integrator, timestep policy, algorithm, and precision reported
  by the executed payload rather than values copied from the request.

The pinned fixture-suite SHA-256 is
`ac4f48dfc17baf092329be65b3baef454cb318e09efa258bf4091011ce0618e8`;
the accepted-environment SHA-256 is
`8346f0ddd3d85df294a672d132d9508c01eb3256c0a5c6fc6ab1e2a3d2cd17ef`.
Neither source artifact was modified. The historical CSV predates this
identity capture: it has no GPU UUID, solver-mesh byte hash, or executed
ProblemIR hash. The immutable corrected JSON therefore records
`qualification_identity=null` and the explicit failure `immutable Task 11
qualification identity is missing`; it does not retrofit current identity onto
old measurements.

### Historical work and timing fields

The following values are medians across the five historical repeats. `Steps`
is the executed direct-minimizer step count and therefore the best available
accepted-step count in this artifact. `RHS` is cumulative. `Demag`,
`preconditioner ms`, and `HYPRE ms` are explicitly last-step samples, not
cumulative totals. `Norm max` is the maximum across repeats.

| Strategy | Mesh | Steps | Cumulative RHS | Demag (last step) | Preconditioner ms (last step) | HYPRE apply ms (last step) | Norm max | Torque-stop rows |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `none` | coarse | 59 | 118 | 1 | 0.000000 | 11.549830 | 1.110223e-16 | 5/5 |
| `none` | medium | 60 | 120 | 1 | 0.000000 | 29.854353 | 2.220446e-16 | 5/5 |
| `none` | fine | 64 | 128 | 1 | 0.000000 | 60.742667 | 2.220446e-16 | 0/5 |
| `diagonal_mass` | coarse | 59 | 118 | 1 | 0.135051 | 10.407017 | 1.110223e-16 | 5/5 |
| `diagonal_mass` | medium | 60 | 120 | 1 | 0.141202 | 27.370811 | 2.220446e-16 | 5/5 |
| `diagonal_mass` | fine | 64 | 128 | 1 | 0.117158 | 58.797984 | 2.220446e-16 | 0/5 |
| `lumped_exchange_mass_cg4` | coarse | 59 | 118 | 1 | 1.405370 | 11.562685 | 2.220446e-16 | 5/5 |
| `lumped_exchange_mass_cg4` | medium | 64 | 128 | 1 | 1.304446 | 28.395965 | 2.220446e-16 | 5/5 |
| `lumped_exchange_mass_cg4` | fine | 64 | 128 | 1 | 1.218500 | 61.930505 | 2.220446e-16 | 0/5 |
| `lumped_exchange_mass_cg8` | coarse | 59 | 118 | 1 | 2.644478 | 12.000929 | 1.110223e-16 | 5/5 |
| `lumped_exchange_mass_cg8` | medium | 60 | 120 | 1 | 2.352723 | 26.715052 | 2.220446e-16 | 5/5 |
| `lumped_exchange_mass_cg8` | fine | 64 | 128 | 1 | 2.341522 | 60.571858 | 2.220446e-16 | 0/5 |
| `stagnation_triggered_cg8` | coarse | 59 | 118 | 1 | 0.000000 | 11.027692 | 1.110223e-16 | 5/5 |
| `stagnation_triggered_cg8` | medium | 60 | 120 | 1 | 0.000000 | 28.865756 | 2.220446e-16 | 5/5 |
| `stagnation_triggered_cg8` | fine | 64 | 128 | 1 | 0.000000 | 63.802141 | 2.220446e-16 | 0/5 |

The historical CSV has no explicit cumulative Armijo-trial count, cumulative
demag total, cumulative preconditioner wall time, or cumulative HYPRE wall
time. Reporting the last-step fields as totals would be false, so the corrected
validator marks every affected row invalid. Future runs expose accepted steps
and cumulative demag work from `solver_steps.csv`, but still fail closed unless
the runtime supplies the remaining cumulative fields.

All 15 `stagnation_triggered_cg8` samples report zero resolved iterations and
zero sampled preconditioner wall time. Its measured behavior is therefore a
no-op. Because these old fields are last-step snapshots and no cumulative apply
counter was captured, they also cannot prove that an earlier step applied CG8;
the strengthened contract rejects the strategy instead of inferring success.

### CPU/GPU parity boundary

No Task 11 CPU/GPU parity artifact was captured under the candidate runtime for
the coarse, medium, and fine `none` baselines. In particular, the historical
CSV contains no final magnetization vectors. Candidate energy/torque comparison
against GPU `none` rows is not CPU/GPU field parity. The corrected qualification
is therefore invalid.

The updated recipe generates a separate six-row CPU/GPU CSV and captures
`m_final.json` values before each temporary run directory is removed. The
validator requires numerical final-magnetization and energy parity plus exact
stop state and common runtime/mesh identity before it evaluates candidate
timings. It also requires the captured artifact to declare `observable=m`,
unit `1`, a nonnegative step equal to `executed_steps`, a valid content
SHA-256, and a vector count equal to the pinned solver-mesh node count. Both CPU
and GPU rows must report a finite final torque no greater than 8000 A/m.

The general clean-runtime command
`just verify-fem-relaxation-cpu-gpu-consistency-smoke` passed, but its current
direct-minimizer policy does not compare final magnetization fields. It is
supporting runtime smoke evidence only and does not repair the missing Task 11
candidate-runtime parity evidence.

### Immutable evidence

Committed artifacts:

- `docs/audits/evidence/task-11/task-11-relaxation-preconditioner.csv`
  - SHA-256 `f8695edb588022adf0be2c2cba86a761793b8305a24cca9af2fe43735100f55d`
- `docs/audits/evidence/task-11/task-11-relaxation-preconditioner-qualification.json`
  - SHA-256 `693ab2916f55f95007bcbe695461022220fbff7e70cc724a4b25086643bff49e`
- `docs/audits/evidence/task-11/SHA256SUMS`

The committed CSV is byte-identical to the original ignored runtime artifact.
`cd docs/audits/evidence/task-11 && sha256sum -c SHA256SUMS` passes.

### Fresh managed gate ledger

All runs first validated the clean managed
`hypre-baseline-47b182f02495898418b7a0ccc3599e8bcb47866d4e1fb76179af7a82e8197534`
bundle with compute capability 8.9.

| Command | Result | Evidence / failure |
|---|---|---|
| `just verify-fem-exchange-runtime` | **FAIL**, exit 1 | All three sinusoidal validation launches were rejected during planning: `llg.adaptive_timestep.dt_max is required for executable adaptive dynamics`; numerical exchange comparison did not run. |
| `just verify-fem-relaxation-cpu-gpu-consistency-smoke` | **PASS** | 6/6 rows, 3/3 paired cases, zero reported consistency/gate/group failures. This is not Task 11 magnetization parity, as explained above. |
| `just verify-fem-gpu-performance-regression` | **FAIL**, exit 7 | 10/10 current rows completed and the strict-residency/consistency summary passed, but the accepted baseline produced zero comparable case keys. The accepted rows have an empty preconditioner-strategy token; current rows use `none`. |

The performance gate's current and accepted solver-mesh signatures are both
`20a1851a39da191c61cf50006e72c4b977fa31a5a4cdf2dee1e037e93640d431`.
The non-comparability is specifically the newly explicit strategy token, not a
mesh mismatch. For diagnosis only, the current versus accepted p95 wall times
were:

- FEM CPU: 13241.121 ms versus 11094.684 ms, +19.35%;
- FEM GPU: 6706.854 ms versus 5225.245 ms, +28.35%.

Those manual comparisons also exceed the 5% regression limit, but they are not
reported as a passing or formally comparable accepted-baseline gate.

### Final production boundary

The review fixes change only the qualification harness, tests, managed recipe,
physics note, report, and immutable evidence. They do not restore the rejected
native preconditioner, runtime selector, ABI/API fields, or generated bindings.
The outcome remains literal: no strategy is promoted and the production FEM
GPU relaxation path stays on the clean `none` baseline.
