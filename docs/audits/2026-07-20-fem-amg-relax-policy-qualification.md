# FEM demag AMG relax-policy qualification

Date executed: 2026-07-25
Authoritative source revision: `71d71feb0a19e1102ca5ec8f0d264ef502962867` plus the final Task 9 working-tree diff
Decision under test: retain AMG relax type `18` or promote type `6`

## Decision

The production default remains `18`. The exact 240-row candidate matrix passed its identity, convergence, trajectory, physics-equivalence, p50, and geometric-mean gates, but failed the mandatory per-case p95 no-regression gate. The fresh independent accepted-baseline performance regression gate passes. Relax type `6` nevertheless remains an explicit experimental environment override through `FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE=6` because every promotion condition is mandatory.

No source-level or partial-runtime result is sufficient to promote the default. Promotion requires both `promotion_eligible: true` in the persisted matrix summary and every managed regression below to pass.

## Policy ownership and provenance

`ResolvedDemagAmgPolicy` in `backends/fem/core/demag_solver_policy.*` is the only native owner of AMG environment parsing and canonical defaults. It resolves:

| Effective field | Default | Optional zero sentinel |
|---|---:|---|
| relax type | 18 | no |
| coarsening | 8 | no |
| interpolation | 6 | no |
| aggressive coarsening | 1 | no |
| strength threshold | 0.0 | yes, unset |
| maximum levels | 0 | yes, unset |

The policy is resolved once into `DemagRuntimeState`. CPU and GPU Hypre solvers consume the same state. Native step, relaxation-step, and snapshot stats export all six effective values through the C ABI. Rust `StepStats` copies those fields and artifact metadata uses the ABI values; it does not read the process environment or recreate native defaults.

Invalid, negative, overflowing, and non-finite environment values fall back to the central default or unset sentinel. The default stays `18` in the implementation under qualification.

## Qualification matrix

The managed recipe is:

```bash
FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES=18,6 \
FULLMAG_BENCH_RELAX_ALGORITHMS=projected_gradient_bb,nonlinear_cg \
FULLMAG_BENCH_REPEAT=5 \
just bench-fem-gpu-demag-amg-profile-sweep
```

The recipe validates the immutable `examples/assets/fem_performance/amg_qualification_suite_v1.json` file and each referenced mesh SHA-256 before execution. It also requires the runtime-reported solver-mesh signature to match the suite entry.

The suite stores the stable runtime execution-plan identity reported for each exact solver mesh, not a raw JSON payload hash. The historical runtime-derived values were stale. An initial raw-payload-hash migration hypothesis passed the coarse case but failed the medium case because `mesh_signature(payload)` and the runtime execution-plan identity are different contracts. The corrected migration retained the committed mesh bytes, SHA-256 values, node counts, and element counts and recorded current managed-runtime identities: coarse `ffe9595b4f6b6fc44fab022e733f2fbf2457ee8189929859a7f137f65dd10f11`, medium `085353a503c3377a241c56a4dda85ee23e3673e45c24fd6d6d6cb5892a4b9a1e`, and fine `20a1851a39da191c61cf50006e72c4b977fa31a5a4cdf2dee1e037e93640d431`. The full recipe retains both the expected-signature and within-sweep stable-signature gates. A focused corruption test also rejects malformed runtime signature metadata before execution.

The measured cross product is:

- three exact solver meshes: coarse, medium, and fine;
- FEM CPU and FEM GPU;
- projected-gradient BB and nonlinear CG;
- native step profiler off and on;
- AMG relax types 18 and 6;
- one unrecorded warm-up plus five measured repeats per case;
- demag relative tolerance `1e-12`;
- fixed 64-step budget with an explicit benchmark-only torque target of `1e-4 T`.

The target is benchmark configuration, not a change to the physical or public relaxation default.

## Promotion gate

Promotion is fail-closed. Type 6 is eligible only if all of the following hold:

1. every measured row is successful and satisfies its recorded demag residual tolerance;
2. every projected-gradient BB row has a complete, valid native accepted-Armijo proof and every nonlinear-CG accepted-energy trajectory is monotone;
3. every exact type-18/type-6 pair for the same case and `repeat_index` has identical configured step budget, benchmark torque target, stop reason, and executed-step completion semantics, each norm defect is at most `1e-9`, and all final scenario energies and torque observables agree within the canonical CPU/GPU consistency tolerances (`energy rtol=1e-6`, `energy atol=1e-30 J`, `torque rtol=1e-6`, `torque atol=1e-9 A/m` and `1e-15 T`);
4. every measured row records the suite's immutable fixture ProblemIR SHA-256 and a valid executed ProblemIR SHA-256; all rows for the same solver mesh and relaxation algorithm must have one executed ProblemIR identity across policies, repeats, CPU/GPU, and profiler off/on;
5. every row's effective solver is `CG`, preconditioner is `AMG`, rtol is exactly `1e-12`, and coarsening/interpolation/aggressive/strength/max-level values equal the declared matrix; only effective relax type may differ inside a policy pair;
6. every paired CPU/GPU parity gate passes on one stable, expected solver mesh;
7. the managed demag Poisson/PCG symmetry contract passes;
8. type 6 p50 demag-apply time is no more than 5% slower than type 18 in every case;
9. type 6 p50 end-to-end time is no more than 5% slower in every case;
10. type 6 p95 end-to-end time is no more than 5% slower in every case;
11. the geometric mean of case-level end-to-end p50 ratios improves by at least 5%.

The evaluator requires exactly 24 case groups and five measured rows per policy in each group. It also requires exactly one row for each policy and `repeat_index` in `0..4`; aggregate distributions cannot hide a duplicate, missing, or physically divergent repeat. The suite's `problem_ir_sha256` is the immutable base-fixture identity, while `executed_problem_ir_sha256` is the exact algorithm-specific runtime identity. Both are persisted; the latter must be identical inside each type-18/type-6 pair. Requested environment values are retained for diagnostics, but policy grouping and promotion use only effective ABI values. For projected-gradient BB, endpoint energy recomputation is diagnostic only: accepted-state subtraction noise reached `8.321139371409497e-22 J`, while all 120 projected-gradient BB rows had native proof available, proof count equal to executed steps, zero invalid proofs, and no invalid-proof details.

## Runtime identity

Managed runtime bundle after the Task 9 rebuild:

- runtime: `fem-gpu-host`;
- variant: `candidate-sm89`;
- GPU: NVIDIA GeForce RTX 4080 SUPER;
- compute capability: 8.9;
- CUDA driver: 591.86;
- runtime bundle manifest SHA-256: `a8cda0303380c02d4c971833e8e31ec701fe5f4af0e95929b0f8cac3b9b9028c`;
- source manifest SHA-256: `92d021622e30757675bce53a79e9c540c760787454707cf28fd6f84e92407bc0`;
- native library SHA-256: `158b82f9415c21ad559119e1b5b29c9e52af9f0e65717a8f4eaffe8f3b749ffb`.

Device execution, per-row runtime identity, exact mesh signatures, timings, convergence, parity, and trajectory evidence must be read from the persisted matrix artifacts; host availability alone is not qualification evidence.

## Evidence

Focused tests completed before the managed matrix:

- initial source-contract RED: Rust artifacts still guessed `FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE` instead of copying the ABI;
- qualification evaluator RED: `amg_relax_policy_qualification_summary` was absent;
- exact external solver-mesh forwarding RED: `FULLMAG_BENCH_DOMAIN_MESH` was not forwarded by `benchmark_mesh_env`;
- projected-gradient BB trajectory evaluator RED: endpoint recomputation rejected valid native Armijo-proven steps because of floating-point subtraction noise;
- projected-gradient BB proof fail-closed RED: missing, incomplete, or invalid native proof was not rejected before the algorithm-aware gate was added;
- paired-policy physics RED: the evaluator exposed no `physics_equivalence_gate_passed` result and accepted type-18/type-6 rows without exact repeat pairing or final-observable comparison;
- focused paired-policy tests cover pass-at-tolerance, configured-budget and torque-target drift, stop-reason drift, unsupported stopping semantics, executed-step drift, norm-defect violation, missing and mismatched energies, torque drift, and duplicate repeat indices;
- the benchmark preserved an explicitly supplied qualified shared-domain mesh instead of silently discarding it when generated-mesh caching was disabled;
- the canonical ProblemIR now inlines the exact shared-domain mesh, so temporary `run-json` execution does not depend on a host-only source path;
- `run-json` now exports last-step wall, exchange, demag, RHS, extra-energy, and snapshot timings required by the exact canonical-IR benchmark path;
- optional unset AMG values read back from CSV are normalized from the empty-string representation to the policy's `None` sentinel;
- report labels preserve explicit numeric zero values instead of displaying them as unset;
- matrix-wide identity rejects different executed ProblemIR hashes across CPU/GPU or profiler off/on even when every local type-18/type-6 pair is internally consistent;
- managed `fullmag-cli` run-json telemetry test: 1 passed, 235 filtered out;
- `just verify-fem-demag-amg-benchmark-contract`: 34 passed, 254 deselected;
- full `scripts/test_validate_fem_relaxation_runtime_log.py`: 288 passed after these harness and identity corrections.

Managed native and runtime evidence is recorded after command completion:

| Command | Result | Authority |
|---|---|---|
| `just verify-fem-demag-amg-policy-contract` | PASS | managed native ABI/provenance |
| `just verify-fem-demag-poisson-contract` | PASS | managed demag/PCG contract |
| qualification matrix recipe | **NO-GO**: 240/240 measured rows plus 48/48 warm-up rows completed; 24/24 exact groups; mandatory p95 gate failed | managed CPU/GPU device qualification |
| `just verify-fem-relaxation-runtime` | PASS | managed relaxation runtime |
| `just verify-fem-relaxation-cpu-gpu-consistency-smoke` | PASS: 6/6 rows, 3/3 CPU/GPU pairs | managed CPU/GPU parity smoke |
| `just verify-fem-gpu-performance-regression` | PASS: 10/10 rows; CPU wall p95 -2.39%; GPU wall p95 +4.96%; allowed +5% | accepted-baseline performance regression |

Matrix artifacts are written under `.fullmag/reports/fem-amg-relax-policy-qualification/`, including warm-up CSVs, six measured CSVs, per-sweep CPU/GPU summaries and Markdown reports, and `qualification-summary.json`. The regenerated summary reports 120/120 exact paired repeats, complete distributions, convergence, accepted-trajectory evidence, cross-policy physics equivalence, CPU/GPU parity, and PCG symmetry. The p50 demag-apply and p50 end-to-end no-regression gates pass, and the candidate-only geometric-mean end-to-end improvement is `11.593830873679444%`. The p95 end-to-end gate fails, so `promotion_eligible` is `false`.

The two p95 violations are both CPU projected-gradient BB cases:

- coarse mesh, profiler off: ratio `1.2371392342712229` (`+23.71%`);
- fine mesh, profiler on: ratio `1.0667232642833957` (`+6.67%`).

These are not hidden by the favorable aggregate. Every GPU case remains within the p95 limit, but the promotion rule is intentionally per-case and fail-closed.

The accepted performance fixture used the same exact fine mesh bytes as the suite but carried the historical runtime execution-plan signature. The fixture and accepted CSV were migrated from that stale identity to the current managed-runtime signature; the accepted environment's derived fixture-manifest SHA-256 was updated accordingly. Mesh bytes, mesh SHA-256, node/element counts, accepted timing samples, and the explicit effective relax policy were not changed.

The accepted-baseline comparison uses effective relax type `6` on both sides. After identity migration, two backend cases were comparable and all 10 current rows passed correctness, strict GPU-residency, control-readback, and performance checks. CPU wall p95 was `10829.393 ms` versus `11094.684 ms` accepted (`-2.39%`), while GPU wall p95 was `5484.353 ms` versus `5225.245 ms` accepted (`+4.96%`). The GPU result is close to, but still inside, the fixed `+5%` limit. The timing baseline was not rewritten or loosened.

## Final promotion result

**NO-GO.** The exact candidate matrix does not qualify relax type `6` because two CPU projected-gradient BB cases exceed the allowed p95 regression, despite an `11.59%` geometric-mean p50 end-to-end improvement and a passing accepted-baseline regression. The central default remains `18`; there is no promotion commit. Later tuning tasks may revisit the policy only through a new complete qualification matrix.
