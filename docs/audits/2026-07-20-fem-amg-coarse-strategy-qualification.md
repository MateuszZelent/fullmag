# FEM demag AMG coarse-strategy qualification

Date executed: 2026-07-26

Scope: Task 14 of `docs/superpowers/plans/2026-07-20-fem-gpu-end-to-end-performance-remediation.md`

Authoritative source revision: `96d486f680a9d1add11b673e089734e0d6304a55` plus the Task 14 documentation-only commit

Decision: **NO-GO — retain the byte-identical Task 9 AMG policy**

## Executive result

No tested AMG/coarse-solve candidate satisfies the complete promotion contract. The search executed the six prescribed axes sequentially and changed exactly one policy field at a time. It completed `2040/2040` measured rows successfully after `408/408` viable warm-up rows; relax type `7` was additionally stopped after its first four warm-up rows returned a non-finite demagnetization residual. Every measured candidate preserved the exact matrix identity, CPU oracle, convergence, trajectory, physics-equivalence, CPU/GPU parity, GPU-runtime legality, and PCG-symmetry contracts. None simultaneously delivered at least 5% profiler-off geometric-mean end-to-end improvement and kept every p50 and p95 demag-apply and end-to-end case within the 5% regression budget.

The production policy therefore remains:

| Field | Retained value |
|---|---:|
| relax type | `18` |
| coarsening | `8` (PMIS) |
| interpolation | `6` |
| aggressive-coarsening levels | `1` |
| strength threshold | unset; HYPRE default applies |
| maximum levels | unset; HYPRE default applies |

`backends/fem/core/demag_solver_policy.hpp` and `backends/fem/core/demag_solver_policy.cpp` are unchanged from the Task 9 baseline. Their SHA-256 values during this decision were respectively `bf1c4ab8c9456c7830e759f7d2d88248f3a7458350509d0f7df19d5c0f6cd635` and `9d617d821e2405425c95c3e093fb452ab51ddc5b7edc81aa99ae42a547969668`. No size-class selector and no runtime autotuner were added.

## Qualification contract

Promotion is fail-closed. A candidate must satisfy all of the following:

1. at least 5% geometric-mean improvement in profiler-off case-level end-to-end p50;
2. no case-level demag-apply p50 regression greater than 5%;
3. no case-level end-to-end p50 regression greater than 5%;
4. no case-level demag-apply p95 regression greater than 5%;
5. no case-level end-to-end p95 regression greater than 5%;
6. exact five-repeat distributions with no missing or duplicate repeat;
7. exact fixture, executed ProblemIR, mesh, solver-policy, and profiler identity;
8. converged CG/AMG at `rtol=1e-12`, accepted trajectory evidence, and cross-policy physics equivalence;
9. full FEM CPU oracle and paired FEM CPU/GPU parity;
10. strict device execution and residency for every FEM GPU row;
11. a symmetric, GPU-supported AMG cycle that is legal as a PCG preconditioner.

The profiler-off matrix is the primary performance decision. Profiler-on rows provide attribution and are also required not to expose a tail regression; profiler instrumentation is not used to claim a production speedup. The objective is measured demagnetization apply and full end-to-end time, not iteration count alone.

## Immutable matrix

Every viable policy was measured over the same cross product:

- three exact solver meshes: coarse, medium, and fine;
- FEM CPU and FEM GPU;
- projected-gradient BB and nonlinear CG;
- native step profiler off and on;
- five measured repeats per policy and case;
- fixed 64-step workload and benchmark-only torque target `1e-4 T`;
- demagnetization solver `CG`, preconditioner `AMG`, and relative tolerance `1e-12`.

The runtime mesh signatures were:

| Size | Solver mesh signature |
|---|---|
| coarse | `ffe9595b4f6b6fc44fab022e733f2fbf2457ee8189929859a7f137f65dd10f11` |
| medium | `085353a503c3377a241c56a4dda85ee23e3673e45c24fd6d6d6cb5892a4b9a1e` |
| fine | `20a1851a39da191c61cf50006e72c4b977fa31a5a4cdf2dee1e037e93640d431` |

Each candidate first received one exact warm-up repeat across the 24-case cross product. Only a complete, valid warm-up advanced to repeat-five measurement. The axes were run in the plan order, and because no axis produced a qualified winner, every later axis inherited the unchanged Task 9 policy rather than a merely faster but unqualified predecessor.

## PCG legality and upstream GPU boundary

The smoother catalog was evaluated before timing:

| Relax type | PCG decision | Measurement decision |
|---:|---|---|
| `18` | symmetric, GPU-supported | retained baseline |
| `6` | symmetric, GPU-supported | measured |
| `7` | symmetric, GPU-supported | warm-up only; runtime residual became `-nan` |
| `3`, `4`, `11`, `12` | nonsymmetric with the configured one-value cycle | rejected before measurement |
| `16` | no Task 14 PCG-legality proof | rejected before measurement |

The task did not silently replace CG with GMRES. That would change the solver and trajectory contract and requires a separate qualification.

Coarsening `8` is PMIS and `10` is HMIS. Upstream HYPRE GPU guidance lists PMIS for the device path and conditions broader choices on unified-memory support. The managed HYPRE configuration has `HYPRE_USING_DEVICE_MEMORY=1` and `HYPRE_USING_UNIFIED_MEMORY` undefined. HMIS was therefore not assumed supported from a source catalog: it was admitted only to the strict managed runtime/device/residency preflight. Its successful execution is bounded evidence for these runs, not a general upstream support claim.

`max_levels` is the repository's only exposed coarse-termination control. There is no independent coarse-size-cutoff knob, so no such control or result is invented here. An unset strength threshold and max-level count mean that HYPRE's defaults apply; the run log reports threshold `0.25` and maximum levels `25` for the retained policy.

## Sequential axis evidence

Artifacts are under `.fullmag/reports/fem-amg-coarse-strategy-qualification/<axis>/`. Each SHA-256 below identifies the corresponding `qualification-summary.json`. Percentages are profiler-off geometric-mean end-to-end improvements relative to the inherited baseline; negative values are regressions. Gate order in the compact column is apply p50 / end-to-end p50 / apply p95 / end-to-end p95.

| Axis | Warm-up | Measured | Candidate result | No-regression gates | Summary SHA-256 |
|---|---:|---:|---|---|---|
| relax type | `48/48` viable, plus `0/4` for type `7` | `240/240` | type `6`: `+11.225137054%` | pass / pass / pass / **fail** | `153bd22b221dfc4dd14e9fea9536d824f1bbb84cb91fc70171f3901f14076260` |
| coarsening | `48/48` | `240/240` | HMIS `10`: `+3.493051125%` | pass / pass / pass / **fail** | `0e4937da4c08025c453d43313064be96d4036dce7e4b730bd2c44b8e5265e2f6` |
| interpolation | `96/96` | `480/480` | `3`: `-0.636159996%`; `14`: `-0.809859085%`; `15`: `-0.515272515%` | all four **fail** for every candidate | `5eddc37f13dd1e965ddbb5f74e271160f4fa93a870870d58ebf921a162cbaaf5` |
| aggressive coarsening | `48/48` | `240/240` | `0`: `+2.629027554%` | all four **fail** | `2ed15856be9db17c07802ee6de1a8b0958cd3a4d6b361d02c4865bc77e291138` |
| strength threshold | `72/72` | `360/360` | `0.5`: `-6.639797528%`; `0.8`: `-6.667482205%` | all four **fail** for both candidates | `2cbee3c9daf31555dd590729cca6c4a832839b74039e88b8aac265c69b794c30` |
| maximum levels | `96/96` | `480/480` | `4`: `+0.537615442%`; `8`: `+0.165172773%`; `12`: `+1.130881833%` | all four **fail** for every candidate | `d8741c811e736fe62f6a01c8fc7cd3d5f447061d985626bafa4687a5e412b33c` |

### Relax type

Type `7` was legal on symmetry grounds but failed the first coarse/profiler-off warm-up after four CPU/GPU projected-gradient BB rows. CG reported two iterations and residual `-nan`; the preflight status was `fail`, so the remaining 20 warm-up cases and every measured repeat were correctly skipped.

Type `6` passed every p50 and demag-apply p95 gate and improved the profiler-off geometric mean by `11.225137054%`. It still failed promotion because coarse/GPU/projected-gradient-BB/profiler-on end-to-end p95 was `1.212763840` times baseline (`+21.276%`). The worst apply p95 was `1.030757443`, within budget. Favorable aggregate speedup cannot override a mandatory per-case tail failure.

### Coarsening

HMIS `10` improved the profiler-off geometric mean by only `3.493051125%`, below the 5% objective, and its coarse/CPU/nonlinear-CG/profiler-off end-to-end p95 ratio was `1.138676850` (`+13.868%`). Its worst apply p95 ratio was `1.029678510`. The retained PMIS `8` remains the baseline.

### Interpolation

All three alternatives regressed the aggregate and all four tail/median gates:

| Candidate | Worst apply p50 | Worst end-to-end p50 | Worst apply p95 | Worst end-to-end p95 |
|---:|---:|---:|---:|---:|
| `3` | `1.146840774` | `1.069440797` | `3.481470591` | `1.431551600` |
| `14` | `1.097390863` | `1.056440201` | `1.239778459` | `1.091795293` |
| `15` | `1.166781742` | `1.100498483` | `1.267925752` | `1.147061474` |

The extreme interpolation-`3` apply p95 came from coarse/GPU/nonlinear-CG/profiler-off. No interpolation candidate is eligible.

### Aggressive coarsening

Disabling aggressive coarsening (`0`) improved the aggregate by `2.629027554%`, below threshold. Worst ratios were apply p50 `1.277299600` (coarse/CPU/nonlinear-CG/off), end-to-end p50 `1.156766046` (fine/GPU/nonlinear-CG/on), apply p95 `1.478712637` (fine/GPU/projected-gradient-BB/on), and end-to-end p95 `1.350108282` (coarse/GPU/projected-gradient-BB/off).

### Strength threshold

Both explicit thresholds regressed the aggregate and every no-regression gate:

| Candidate | Worst apply p50 | Worst end-to-end p50 | Worst apply p95 | Worst end-to-end p95 |
|---:|---:|---:|---:|---:|
| `0.5` | `1.387340088` | `1.246790148` | `1.857242036` | `1.459374963` |
| `0.8` | `1.346874532` | `1.226304618` | `2.137635962` | `1.530222077` |

### Maximum levels / coarse termination

Every bounded max-level count improved the aggregate by less than 2% and failed every no-regression gate:

| Candidate | Worst apply p50 | Worst end-to-end p50 | Worst apply p95 | Worst end-to-end p95 |
|---:|---:|---:|---:|---:|
| `4` | `1.103493809` | `1.086873182` | `1.350944654` | `1.604722730` |
| `8` | `1.235461244` | `1.254988614` | `1.202368668` | `1.274030340` |
| `12` | `1.080799292` | `1.141721893` | `1.266480195` | `1.416586667` |

## Attribution boundary

Task 13's opt-in NVTX instrumentation remains runtime-verified but authoritative Nsight attribution is blocked. The fresh capability-enabled Nsight Systems capture exported all eight required NVTX IDs but `0` unique CUDA kernels. The bounded Nsight Compute access probe reached device 0 and failed with `ERR_NVGPUCTRPERM`, even with effective container `SYS_ADMIN`. Consequently this task does not fabricate occupancy, launch-latency, kernel, reduction, or coarse-level attribution. It reports only the managed benchmark's measured apply/end-to-end distributions and already-qualified phase telemetry.

The accepted-performance regression also has an inherited boundary. Task 9's last accepted comparison was green at GPU p95 `5484.353 ms` versus accepted `5225.245 ms` (`+4.96%`). Task 10's retained rebuilt HYPRE/MFEM bundle first recorded the persistent red state at GPU p95 `5918.739 ms` (`+13.27%`). Later controlled evidence did not prove Task 14 to be its cause, and this no-go does not rewrite the accepted baseline or weaken the 5% limit.

## Restored-tree sweep rerun

The first restored-tree run of `bench-fem-gpu-demag-amg-profile-sweep` failed closed at `160/240` measured rows and `32/48` warm-ups. The medium-mesh, FEM CPU, nonlinear-CG, profiler-on, relax-`18`, repeat-`2` row returned process status `1`: CG reached the `500`-iteration limit and the independent residual certification was `288528.21618801664` against `rtol=1e-12`. The same warm-up and repeats `0`, `1`, `3`, and `4` converged in 31 iterations with residual `8.40975e-13`; the exact corresponding repeat also passed in all six earlier Task 14 axis runs. This is a numerical outlier, not a harness timeout, OOM, signal, parser error, or a qualified production-policy change.

The failure evidence is preserved under `.fullmag/reports/task14-gate1-first-failure/`: `medium-profiler-on.csv` has SHA-256 `cdf4c48530057ae85efd021a4ab23c3dbcb2e7372d1811b8f134d98f795ed48e`, and `medium-profiler-on-summary.json` has SHA-256 `efc78616fda81c99c78ce0b7ee53588c452d71131cf46218b7fb47a64eeaeca9`.

One unchanged, clean, complete rerun then passed all `48/48` warm-ups and `240/240` measured rows. Its legacy qualifier reported `promotion_eligible=true`, `+22.337389339%` profiler-off geometric-mean improvement, and passed its implemented p50 apply, p50 end-to-end, and p95 end-to-end gates; the qualification-summary SHA-256 is `e2597719ef74762929df6c8574129ff9d6383bacbc04e42d72bd365afb17a786`. That legacy schema has no demag-apply p95 gate. Recomputing the mandatory Task 14 apply-p95 comparison from its distributions gives a worst ratio of `1.139663247` (coarse/GPU/nonlinear-CG/profiler-on), so it is not Task 14 eligible. The independent Task 14 relax-axis matrix also failed mandatory end-to-end p95 at `1.212763840`. The initial numerical failure plus these tail failures make the restored-tree result unstable and do not override the NO-GO.

## Final managed verification

The final verification is run after restoring the temporary qualification harness, so it tests the committed production tree rather than Task 14-only instrumentation.

| Exact command | Result |
|---|---|
| `COMPOSE_PROJECT_NAME=fullmag just bench-fem-gpu-demag-amg-profile-sweep` | **PASS on one unchanged complete rerun** (`48/48` warm-ups, `240/240` measured); the first run failed one numerical row as recorded above. The legacy pass does not satisfy Task 14's mandatory apply-p95 gate. |
| `COMPOSE_PROJECT_NAME=fullmag just verify-fem-demag-poisson-contract` | **PASS** (exit `0`); the printed non-convergent PCG line belongs to an expected negative fixture. |
| `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime` | **PASS** (exit `0`); CPU/GPU managed smokes and all supported relaxation-algorithm contracts completed. |
| `COMPOSE_PROJECT_NAME=fullmag just verify-fem-frequency-domain-native-contract` | **PASS** (exit `0`); all ten native contract targets built and executed. Existing `snprintf` truncation warnings were emitted during compilation. |
| `COMPOSE_PROJECT_NAME=fullmag just verify-fem-gpu-performance-regression` | **FAIL** (exit `7`) only on the unchanged 5% accepted-baseline wall-time gate. All `10/10` rows passed execution, convergence, CPU/GPU consistency, strict GPU residency, mesh stability, and identity. CPU p50 was `19951.854 ms` versus `10407.728 ms` (`+91.7023%`), and p95 was `20696.848 ms` versus `11094.684 ms` (`+86.55%`). GPU p50 was `10281.428 ms` versus `5186.222 ms` (`+98.2450%`), and p95 was `11182.882 ms` versus `5225.245 ms` (`+114.02%`). The pinned device was `NVIDIA GeForce RTX 4080 SUPER`, UUID `GPU-fcb9fbf1-8284-37c7-af5b-76bcbf2d2937`, compute capability `8.9`, with `fem_native_gpu` execution. This is the inherited accepted-performance red boundary; Task 14 made no production-code change and does not claim to fix it. |

## Final decision

**NO-GO.** There is no qualified fixed policy and no stable size-dependent set of winners from which a bounded setup-facts selector could be justified. The Task 9 policy stays byte-identical, no selector or autotuner is added, and the accepted performance baseline and 5% thresholds remain unchanged. A future attempt must begin from a new complete, identity-pinned qualification and must not combine individually unqualified axes.
