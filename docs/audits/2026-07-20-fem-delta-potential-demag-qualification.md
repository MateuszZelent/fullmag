# FEM deterministic delta-potential demag qualification

**Decision:** `no_go`
**Qualification date:** 2026-07-27
**Scope:** strict GPU Poisson airbox demag, P1, double precision, final Task 9/14 AMG policy
**Physics contract:** `docs/physics/0582-fem-deterministic-delta-potential-demag.md`
**Physics-note commit:** `2cb3695a` (`docs: define deterministic FEM delta demag research`)

## 1. Executive decision

The deterministic accepted-endpoint delta-potential prototype is not promoted.
The paired six-stratum GPU aggregate geometric-mean time-to-tolerance
improvement was **15.36%**, so the aggregate `>=10%` gate passed. Promotion
still fails because the precommitted contract requires p50 and p95
no-regression in every applicable stratum:

- coarse NCG p50 end-to-end regressed 3.32%;
- coarse NCG p95 demag-apply regressed 2.13%;
- fine NCG p50/p95 end-to-end regressed 4.65%/7.07%;
- fine NCG p50/p95 demag-apply regressed 14.65%/9.03%;
- candidate fine-mesh rows used one extra demag solve per repeat.

Correctness, finite-residual, accepted/rejected-step ownership, CPU/GPU parity,
mesh identity, and strict GPU residency checks passed. Those passes do not
override a failed performance gate. The prototype runtime implementation,
selector, environment switches, telemetry, accepted-state buffers, and normal
`fullmag_fem` CMake linkage were removed. No solver policy was changed.

## 2. Scientific contract and TDD evidence

The note was committed before implementation. It fixes the candidate equation

```text
A phi_k       = b(m_k)
A delta_phi   = b(m_trial) - b(m_k)
phi_trial     = phi_k + delta_phi
```

and requires certification against the full equation
`A phi_trial - b(m_trial)`, with same-lane fresh-zero fallback on any threshold
breach. Only the last candidate followed by exactly one accepted-generation
advance may become the next base; rejected trials and ambiguous generation
jumps fail closed.

The initial managed RED run failed at compilation because
`gpu/cuda/demag_poisson/delta_potential.hpp` did not exist. After implementing
the oracle and research prototype, the focused managed contract was GREEN:

```bash
COMPOSE_PROJECT_NAME=fullmag just verify-fem-demag-poisson-contract-focused
```

The retained standalone fixture covers:

1. manufactured fresh solve versus delta correction for one unchanged SPD
   operator;
2. identical energy, strict Armijo decision, and stop reason;
3. full-equation residual detection of inherited base error and exactly one
   fresh fallback;
4. rejected-trial isolation, final-candidate promotion on a one-generation
   advance, and fail-closed reset on a generation jump.

The oracle is compiled only into `fem_demag_delta_potential_contract`; it is not
linked into the production FEM library.

## 3. Prototype that was qualified and then removed

The research-only implementation was default-off and activated only by a
benchmark environment switch. It:

- stored accepted RHS and accepted potential in dedicated device buffers;
- formed `delta_b = b_trial - b_accepted` on the Hypre device vector;
- used a fresh-zero correction solve, then reconstructed the full potential;
- evaluated the full `A phi_trial - b_trial` residual;
- performed a deterministic ordinary fresh-zero solve when the correction or
  full residual failed;
- promoted only a candidate associated with the immediately preceding accepted
  generation;
- counted correction solves, correction iterations, full residual checks, and
  fallbacks.

This description is historical evidence, not a production capability. No
runtime selector remains after the no-go cleanup.

## 4. Qualification matrix

Baseline and candidate lanes were run serially with identical ordering:

```bash
FULLMAG_BENCH_USE_LOCAL_DEBUG=1 \
FULLMAG_BENCH_FEM_DEMAG_FRESH_DELTA_CORRECTION=<0|1> \
FULLMAG_BENCH_REPEAT=5 \
FULLMAG_BENCH_STEPS=64 \
FULLMAG_BENCH_CASE_TIMEOUT_S=600 \
COMPOSE_PROJECT_NAME=fullmag \
just verify-fem-demag-mesh-airbox-convergence
```

Each lane contained 72 rows: 12 warm-up rows and 60 measured rows. The measured
matrix was:

- versioned Task 0 coarse, medium, and fine mesh/airbox fixtures;
- CPU fresh-zero oracle and GPU lane;
- PG-BB and NCG;
- one warm-up and five measured repeats;
- CG/AMG, relative tolerance `1e-12`, relax type 6, coarsening 8,
  interpolation 6, aggressive coarsening 1;
- torque target `1e-4 T`, maximum 64 accepted steps.

Exact solver-mesh identities:

| Resolution | Nodes | Elements | Solver-mesh signature |
|---|---:|---:|---|
| coarse | 52 | 149 | `ffe9595b4f6b6fc44fab022e733f2fbf2457ee8189929859a7f137f65dd10f11` |
| medium | 153 | 473 | `085353a503c3377a241c56a4dda85ee23e3673e45c24fd6d6d6cb5892a4b9a1e` |
| fine | 1200 | 5138 | `20a1851a39da191c61cf50006e72c4b977fa31a5a4cdf2dee1e037e93640d431` |

All 144 baseline-plus-candidate rows completed with `status=ok`. All GPU rows
reported `execution_engine=fem_native_gpu`,
`fem_data_residency=device_source_of_truth`, `uses_gpu_poisson=True`,
`hypre_execution_policy=device`, and `demag_residency=device`. The GPU MFEM
device was `ceed-cuda:/gpu/cuda/shared`; CPU oracle rows reported `cpu`.

The candidate and baseline used the same executable and loaded research build;
only the benchmark switch differed. CSV identity metadata was constant:

- binary: `/workspace/target/debug/fullmag`;
- runtime manifest SHA-256:
  `ed8a2869032573b9cad68fcdc9091914f1600951f19be39d2735633a7c7167e4`;
- source manifest SHA-256:
  `1faaa42a827f7660c30aeea0e801caa58d4c8a3440e674c8eac9a1289af94eb7`;
- reported FEM library SHA-256:
  `f54cba3751f28e602e449aa865a637cfb4428a18c978c6fa0590a27aef45376f`.

The research matrix deliberately used the container-built local debug binary
so the unpromoted switch could be compared without exporting it into the
managed production bundle. Therefore it is qualification evidence for a
research candidate, not production runtime validation.

## 5. Performance distributions

Positive values mean the candidate is faster. Percentiles use linear
interpolation over the five measured GPU repeats.

| Mesh | Algorithm | wall p50 | wall p95 | demag apply p50 | demag apply p95 |
|---|---|---:|---:|---:|---:|
| coarse | PG-BB | +19.01% | +18.56% | +66.13% | +69.31% |
| coarse | NCG | **-3.32%** | +3.33% | +18.91% | **-2.13%** |
| medium | PG-BB | +25.76% | +20.16% | +50.71% | +47.07% |
| medium | NCG | +9.24% | +1.64% | +11.53% | +10.75% |
| fine | PG-BB | +28.10% | +31.64% | +44.73% | +44.05% |
| fine | NCG | **-4.65%** | **-7.07%** | **-14.65%** | **-9.03%** |

Raw GPU p50 wall times in milliseconds:

| Mesh | Algorithm | fresh-zero | candidate |
|---|---|---:|---:|
| coarse | PG-BB | 2989.236 | 2420.887 |
| coarse | NCG | 3612.313 | 3732.158 |
| medium | PG-BB | 5883.169 | 4367.747 |
| medium | NCG | 6741.861 | 6118.798 |
| fine | PG-BB | 14899.245 | 10713.151 |
| fine | NCG | 10661.637 | 11157.204 |

The geometric mean of the six baseline/candidate p50 wall-time ratios is
`1.1536277`, or **15.36% aggregate improvement**. This passes the aggregate
threshold but cannot compensate for failed per-case no-regression gates.

## 6. Trajectory, residual, fallback, and solve evidence

For every paired GPU stratum:

- accepted-step counts were identical;
- rejected-attempt counts were identical;
- stop reasons and convergence flags were identical;
- PG-BB stopped on torque at 16/21/40 accepted steps for
  coarse/medium/fine;
- NCG reached `max_steps` at 64 steps for all three meshes;
- rejected attempts were 15/16/17 for PG-BB and zero for NCG;
- final energies and torques agreed within the existing CPU/GPU consistency
  contract.

Across the 30 measured GPU rows:

| Quantity | fresh-zero | candidate |
|---|---:|---:|
| maximum reported demag residual | `6.803e-13` | `4.962e-13` |
| total reported demag solves | 1985 | 1995 |
| total accepted steps | 1345 | 1345 |
| total rejected attempts | 240 | 240 |
| maximum final demag iterations | 23 | 24 |

The ten additional candidate solves are one extra solve in each of the five
fine PG-BB and five fine NCG repeats. This is another no-regression concern,
although the distribution failures are already sufficient for no-go.

A separate deterministic telemetry smoke on the same GPU runtime reported:

```text
correction_solves=5
correction_iterations=125
full_residual_checks=5
fallbacks=0
max_full_relative_residual=4.2395320262688001e-13
```

The corresponding two-step candidate and baseline trajectories were identical
within printed precision. Candidate end-to-end improvement was 9.64% and demag
apply improvement was 8.66%, both below the promotion threshold. The retained
manufactured fallback fixture separately forces a base-error breach and proves
exactly one deterministic fresh solve. No claim is made that the zero fallback
count from the telemetry smoke represents every full-matrix call; the full
matrix did not persist prototype-private counters in its CSV schema.

## 7. Evidence files and integrity

The full research artifacts are intentionally ignored runtime evidence under:

```text
.fullmag/reports/fem-delta-potential-qualification/baseline-full/
.fullmag/reports/fem-delta-potential-qualification/candidate-full/
```

Measured CSV SHA-256 values:

| Lane | coarse | medium | fine |
|---|---|---|---|
| baseline | `e4a16e78e329beecbc76ab03f4771053a1ed8fe93abc7dbc9f54176654fa7336` | `863af94930a099d39d4f1227ceda316c8b06868a6d5333487d1f962071278059` | `291e80608952abde78e8bdd0a16ae04a4ba7a2b2c37042a761b195ffaebbb14f` |
| candidate | `ebd1c4797062eb42aea447799b661aa1d23ed11e3dce304c27d00ac4c3a83639` | `0eda0ee6f3687022949942c1436ee0c9da9aa440df8854de541602dc79e2b207` | `6c5599b6efea3cc96b2b6cb9e0886ff60724aa0fba7ebec83a8f38b40587cf6a` |

The archived `qualification-summary.json` files were produced during research
by an older AMG-policy aggregator that expected both relax types 18 and 6.
Their `promotion_eligible=false` result is not the authoritative reduction for
this single-policy experiment. The CSVs, exact row/signature checks, and the
distributions in this audit are authoritative. The retained general managed
recipe now writes a dedicated mesh/airbox summary instead of reusing that
incompatible aggregator.

## 8. No-go cleanup boundary

Removed after qualification:

- `backends/fem/gpu/cuda/demag_poisson/delta_potential.hpp/.cpp`;
- all production stage-compute calls;
- accepted RHS/potential device buffers and Hypre wrappers;
- correction/residual/fallback counters and telemetry;
- benchmark feature switches and normal launcher environment propagation;
- linkage into the normal `fullmag_fem` source list;
- every runtime-selection path for `fresh_delta_correction`.

Retained:

- the publication-style physics note;
- the standalone manufactured oracle/ownership/fallback fixture;
- its focused managed CMake/`just` test wiring;
- the generally applicable managed Task 0 mesh/airbox convergence recipe;
- this audit and ignored raw evidence.

`backends/fem/core/demag_solver_policy.hpp/.cpp` were not modified. Production
fresh-zero behavior remains unchanged.

## 9. Final post-cleanup verification

The required final commands are run only after the prototype removal:

```bash
COMPOSE_PROJECT_NAME=fullmag just verify-fem-demag-poisson-contract
COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime
COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-cpu-gpu-consistency-smoke
COMPOSE_PROJECT_NAME=fullmag just verify-fem-demag-mesh-airbox-convergence
COMPOSE_PROJECT_NAME=fullmag just verify-fem-gpu-performance-regression
```

Fresh post-cleanup results:

| Gate | Result | Evidence |
|---|---|---|
| demag Poisson contract | pass | Exact managed command exited 0 after rebuilding and validating managed variant `hypre-baseline-644b0469a61bf6bcacd8e31c359fb62038a250a62f4db821ff4fb621b5e12531`; the focused suite built and ran the standalone delta-potential oracle with the production demag contracts. The printed `PCG: No convergence!` belongs to an intentional negative contract case; the recipe passed. |
| FEM relaxation runtime | pass | Exact managed command exited 0; source/mesh ownership, the derivative matrix, GPU PG-BB and NCG, and CPU tangent-plane lanes passed. |
| CPU/GPU consistency smoke | pass | Exact managed command exited 0 with 6/6 rows, three algorithm pairs, and zero consistency, gate, or group failures. |
| demag mesh/airbox convergence | pass | Corrected exact managed rerun exited 0 with 72/72 rows: each exact coarse/medium/fine fixture recorded 4/4 warmup and 20/20 measured rows (CPU/GPU, PG-BB/NCG, five repeats, 64-step cap). `qualification-summary.json` parses with `status=pass` and `measured_repeat_count=5`. An earlier run also completed 72/72 but was not counted because the new summary serializer emitted a literal `\n`; the serializer was fixed and the whole exact gate rerun. |
| GPU performance regression | fail | Exact managed command exited 7. All 10 rows, CPU/GPU consistency, convergence, and strict GPU residency passed, but accepted-baseline p95 wall time failed: CPU 12945.1 ms versus 11094.7 ms (+16.68%) and GPU 5918.72 ms versus 5225.24 ms (+13.27%), both above the 5% ceiling. The accepted baseline was not changed. |

The last failure is an inherited repository-wide accepted-baseline gate, not a
reason to retain or promote the delta-potential prototype. It reinforces the
no-go boundary: the retained commit contains no production runtime path, and
no accepted performance baseline is updated by this task.

## 10. Reproduction and future work

A future attempt must begin from a new physics note revision and a new paired,
identity-pinned matrix. It must not reuse these timing distributions for
promotion. A plausible next research direction is reducing correction
bookkeeping and certification overhead specifically on long NCG trajectories,
but any new design must preserve strict Armijo ownership, full-equation
residual certification, same-lane fresh fallback, and production fresh-zero
semantics.
