# FEM deterministic delta-potential demag qualification

**Decision:** `no_go`
**Qualification date:** 2026-07-27
**Scope:** strict GPU Poisson airbox demag, P1, double precision, final Task 9/14 AMG policy
**Physics contract:** `docs/physics/0582-fem-deterministic-delta-potential-demag.md`
**Physics-note commit:** `2cb3695a` (`docs: define deterministic FEM delta demag research`)

## 1. Executive decision

The deterministic accepted-endpoint delta-potential prototype is not promoted.
The archived directories labeled baseline and candidate do not persist the
research-mode switch, hashed invocation/environment, or prototype-private
correction, full-residual, and fallback counters. Identical binary/runtime
identities cannot attribute which mode produced a row. Because the prototype is
stripped, this provenance cannot be reconstructed. The archived matrix is
non-reproducible supporting no-go evidence, not qualification evidence.

If the directory labels are taken at face value, their nominal six-stratum GPU
aggregate geometric-mean time-to-tolerance improvement is **15.36%**, but the
same measurements fail mandatory p50/p95 no-regression:

- coarse NCG p50 end-to-end regressed 3.32%;
- coarse NCG p95 demag-apply regressed 2.13%;
- fine NCG p50/p95 end-to-end regressed 4.65%/7.07%;
- fine NCG p50/p95 demag-apply regressed 14.65%/9.03%;
- candidate-labeled fine-mesh rows reported one extra demag solve per repeat.

Row completion, ordinary Poisson residuals, CPU/GPU parity, mesh identity, and
strict GPU residency passed. Full-equation residual/fallback behavior was
observed only in a targeted telemetry smoke and the manufactured oracle, not
across the archived matrix. The provenance gap and nominal regressions each
block promotion. The prototype runtime implementation,
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
4. explicit rejected-token discard, promotion only by the exact accepted token
   on a one-generation advance, rejection of a stale/different token, and
   fail-closed reset on a generation jump.

The oracle is compiled only into `fem_demag_delta_potential_contract`; it is not
linked into the production FEM library.

## 3. Prototype observed in targeted smoke and then removed

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

## 4. Archived labeled matrix: supporting evidence only

Directories labeled baseline and candidate were run serially with identical
ordering:

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

All 144 labeled rows completed with `status=ok`. All GPU rows
reported `execution_engine=fem_native_gpu`,
`fem_data_residency=device_source_of_truth`, `uses_gpu_poisson=True`,
`hypre_execution_policy=device`, and `demag_residency=device`. The GPU MFEM
device was `ceed-cuda:/gpu/cuda/shared`; CPU oracle rows reported `cpu`.

The two labeled directories used the same executable and loaded research build.
CSV identity metadata was constant:

- binary: `/workspace/target/debug/fullmag`;
- runtime manifest SHA-256:
  `ed8a2869032573b9cad68fcdc9091914f1600951f19be39d2735633a7c7167e4`;
- source manifest SHA-256:
  `1faaa42a827f7660c30aeea0e801caa58d4c8a3440e674c8eac9a1289af94eb7`;
- reported FEM library SHA-256:
  `f54cba3751f28e602e449aa865a637cfb4428a18c978c6fa0590a27aef45376f`.

The invocation intended to differ only by a benchmark switch, but that switch,
the complete invocation/environment, and prototype-private counters were not
persisted in the rows or a hashed sidecar. The local-debug identity proves the
binary, not the selected research mode. These rows cannot qualify the research
candidate or production runtime.

## 5. Performance distributions

The following is a reduction of the archived directory labels only. Positive
values mean the directory labeled candidate is faster. Percentiles use linear
interpolation over five rows. The table is not attributable qualification.

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

The geometric mean of the six labeled p50 wall-time ratios is `1.1536277`, or a
nominal **15.36% aggregate improvement**. Missing mode provenance means this
does not pass the aggregate qualification gate. Even if attribution were
assumed, the per-case no-regression failures would still require no-go.

## 6. Trajectory, residual, fallback, and solve evidence

Within every pair of archived directory labels:

- accepted-step counts were identical;
- rejected-attempt counts were identical;
- stop reasons and convergence flags were identical;
- PG-BB stopped on torque at 16/21/40 accepted steps for
  coarse/medium/fine;
- NCG reached `max_steps` at 64 steps for all three meshes;
- rejected attempts were 15/16/17 for PG-BB and zero for NCG;
- final energies and torques agreed within the existing CPU/GPU consistency
  contract.

Across the 30 measured GPU rows per label, the ordinary solver telemetry was:

| Quantity | fresh-zero | candidate |
|---|---:|---:|
| maximum reported ordinary Poisson residual | `6.803e-13` | `4.962e-13` |
| total reported demag solves | 1985 | 1995 |
| total accepted steps | 1345 | 1345 |
| total rejected attempts | 240 | 240 |
| maximum final demag iterations | 23 | 24 |

The candidate-labeled directory reports ten additional solves: one in each of
the five fine PG-BB and five fine NCG rows. This supports no-go if the labels are
accepted, but the absent mode provenance prevents attributing those solves to
delta correction.

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
Their `promotion_eligible=false` result is not an authoritative reduction for
this single-policy experiment. CSV hashes and row/signature checks are
authoritative only for file integrity and ordinary runtime evidence; they do
not recover research-mode attribution. The retained managed recipe now writes
a dedicated mesh/airbox report instead of reusing that incompatible aggregator.

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

The original Task 17 recipe checked row counts and identity but did not prove
Cartesian uniqueness, mesh-observable convergence, or a distinct airbox extent
sweep. Its earlier green result is superseded. The v2 reducer requires each
`(signature, backend, algorithm, repeat, phase)` key exactly once and rejects
malformed CSV/fixture JSON. It reports median final demag energy and maximum
demag field across Task 0 resolutions. Because those performance fixtures are
widely spaced and lack an analytical reference, the `0.90` medium/fine ceiling
is explicitly a nonqualifying trend-integrity check, not a physics convergence
tolerance; quantitative Task 0 mesh convergence remains `not_validated`.

The separate managed airbox sweep uses `1.0x`, `1.5x`, and `2.0x` extents at
fixed `domain_hmax=1e-7 m` and `airbox_hmax=2.5e-7 m`. For final demag energy and
maximum demag field on CPU and GPU, the `1.5x -> 2.0x` relative delta must not
exceed the `1.0x -> 1.5x` delta or the predeclared `0.15` ceiling. These
thresholds were documented before the v2 managed run and will not be tuned to
its result.

The exact managed v2 run executed every row but failed that unchanged airbox
criterion. The Task 0 matrix completed 12/12 warm-up and 60/60 measured rows;
all exact Cartesian keys, runtime gates, fixture identities, and the explicitly
nonqualifying trend-integrity checks passed. Medium-to-fine relative deltas were
`0.819010..0.834537` for final demag energy and `0.836544..0.846338` for maximum
demag field. Those large changes remain trend-only and do not validate mesh
convergence.

Airbox observables and relative changes were:

| Backend | Observable | `1.0x` | `1.5x` | `2.0x` | leading delta | tail delta | Result |
|---|---|---:|---:|---:|---:|---:|---|
| CPU | final `E_demag` (J) | `6.574009e-19` | `5.418359e-19` | `9.797600e-19` | `0.175791` | `0.446971` | fail |
| GPU | final `E_demag` (J) | `6.574268e-19` | `5.418573e-19` | `9.797372e-19` | `0.175791` | `0.446936` | fail |
| CPU | max `H_demag` | `6920.838` | `4170.159` | `12566.842` | `0.397449` | `0.668162` | fail |
| GPU | max `H_demag` | `6920.955` | `4170.219` | `12566.867` | `0.397450` | `0.668158` | fail |

CPU/GPU agreement means this is not classified as a GPU-only execution defect.
The non-monotone extent response fails both the shrinking-tail rule and the
`0.15` ceiling for all four comparisons. The reducer preserved these values in
`.fullmag/reports/fem-demag-mesh-airbox-convergence/qualification-summary.json`
with `status=fail` and `qualification_status=no_go` before exiting 1.

| Gate | Result | Evidence |
|---|---|---|
| demag Poisson contract | pass | The focused contract within the final exact managed convergence command passed on validated managed variant `hypre-baseline-e56db2588e8bcd9d0f46514b2027729eb0fa862ecfd46ee480ef74f90e125a3a`; it built and ran the standalone delta-potential oracle with the production demag contracts. The printed `PCG: No convergence!` belongs to an intentional negative contract case; the recipe passed. |
| FEM relaxation runtime | pass | Exact managed command exited 0; source/mesh ownership, the derivative matrix, GPU PG-BB and NCG, and CPU tangent-plane lanes passed. |
| CPU/GPU consistency smoke | pass | Exact managed command exited 0 with 6/6 rows, three algorithm pairs, and zero consistency, gate, or group failures. |
| demag mesh/airbox convergence | fail / no-go | Exact managed command executed 12/12 warm-up, 60/60 measured Task 0 rows, and 6/6 airbox rows with healthy runtime gates. Exact keys and the nonqualifying mesh trend checks passed. The predeclared airbox criterion failed on energy and maximum field for both CPU and GPU; tail deltas were `0.446936..0.446971` and `0.668158..0.668162`, above both the leading deltas and the `0.15` ceiling. The reducer wrote a structured failure report and the recipe exited 1. |
| GPU performance regression | fail | Exact managed command exited 7. All 10 rows, CPU/GPU consistency, convergence, and strict GPU residency passed, but accepted-baseline p95 wall time failed: CPU 12945.1 ms versus 11094.7 ms (+16.68%) and GPU 5918.72 ms versus 5225.24 ms (+13.27%), both above the 5% ceiling. The accepted baseline was not changed. |

Neither failed gate is a reason to retain or promote the delta-potential
prototype. The accepted-baseline failure is inherited and the airbox sweep is a
new scientific no-go result from the unchanged predeclared threshold. Together
they reinforce the cleanup boundary: the retained commit contains no production
runtime path, and no threshold or accepted performance baseline is updated by
this task.

## 10. Reproduction and future work

A future attempt must begin from a new physics note revision and a new paired,
identity-pinned matrix. It must not reuse these timing distributions for
promotion. A plausible next research direction is reducing correction
bookkeeping and certification overhead specifically on long NCG trajectories,
but any new design must preserve strict Armijo ownership, full-equation
residual certification, same-lane fresh fallback, and production fresh-zero
semantics.
