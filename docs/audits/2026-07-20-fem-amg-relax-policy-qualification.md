# FEM demag AMG relax-policy qualification

Date executed: 2026-07-25
Authoritative source revision: `425f488ac0363555e3ab4115462f82e81a306b58` plus the Task 9 working-tree diff
Decision under test: retain AMG relax type `18` or promote type `6`

## Decision

The production default remains `18`. The exact candidate matrix passed, but the independent accepted-baseline performance regression gate failed. Relax type `6` therefore remains an explicit experimental environment override through `FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE=6`.

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
4. every paired CPU/GPU parity gate passes on one stable, expected solver mesh;
5. the managed demag Poisson/PCG symmetry contract passes;
6. type 6 p50 demag-apply time is no more than 5% slower than type 18 in every case;
7. type 6 p50 end-to-end time is no more than 5% slower in every case;
8. type 6 p95 end-to-end time is no more than 5% slower in every case;
9. the geometric mean of case-level end-to-end p50 ratios improves by at least 5%.

The evaluator requires exactly 24 case groups and five measured rows per policy in each group. It also requires exactly one row for each policy and `repeat_index` in `0..4`; aggregate distributions cannot hide a duplicate, missing, or physically divergent repeat. Requested environment values are retained for diagnostics, but policy grouping and promotion use only effective ABI values. For projected-gradient BB, endpoint energy recomputation is diagnostic only: accepted-state subtraction noise reached `8.321139371409497e-22 J`, while all 120 projected-gradient BB rows had native proof available, proof count equal to executed steps, zero invalid proofs, and no invalid-proof details.

## Runtime identity

Managed runtime bundle after the Task 9 rebuild:

- runtime: `fem-gpu-host`;
- variant: `candidate-sm89`;
- GPU: NVIDIA GeForce RTX 4080 SUPER;
- compute capability: 8.9;
- CUDA driver: 591.86;
- source manifest SHA-256: `08078a64d5b453da337a4c8fb19599791a7ac8707416fbf045c5e10cc0fac83a`.

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
- `just verify-fem-demag-amg-benchmark-contract`: 21 passed, 251 deselected after the paired-policy review correction;
- full `scripts/test_validate_fem_relaxation_runtime_log.py`: 272 passed after the paired-policy correction.

Managed native and runtime evidence is recorded after command completion:

| Command | Result | Authority |
|---|---|---|
| `just verify-fem-demag-amg-policy-contract` | PASS | managed native ABI/provenance |
| `just verify-fem-demag-poisson-contract` | PASS | managed demag/PCG contract |
| qualification matrix recipe | PASS: 240/240 measured rows plus 48/48 warm-up rows; 24/24 exact groups | managed CPU/GPU device qualification |
| `just verify-fem-relaxation-runtime` | PASS | managed relaxation runtime |
| `just verify-fem-relaxation-cpu-gpu-consistency-smoke` | PASS: 6/6 rows, 3/3 CPU/GPU pairs | managed CPU/GPU parity smoke |
| `just verify-fem-gpu-performance-regression` | **FAIL**: CPU wall p95 +92.85%; GPU wall p95 +96.04%; allowed +5% | accepted-baseline performance regression |

Matrix artifacts are written under `.fullmag/reports/fem-amg-relax-policy-qualification/`, including warm-up CSVs, six measured CSVs, per-sweep CPU/GPU summaries and Markdown reports, and `qualification-summary.json`. The regenerated summary reports 120/120 exact paired repeats, complete distributions, convergence, accepted-trajectory evidence, cross-policy physics equivalence, CPU/GPU parity, PCG symmetry, and all three no-regression gates as true. Its candidate-only geometric-mean end-to-end improvement is `21.070222924596216%`, so the matrix-local result is `promotion_eligible: true`.

The accepted performance fixture used the same exact fine mesh bytes as the suite but carried the historical runtime execution-plan signature. The fixture and accepted CSV were migrated from that stale identity to the current managed-runtime signature; the accepted environment's derived fixture-manifest SHA-256 was updated accordingly. Mesh bytes, mesh SHA-256, node/element counts, accepted timing samples, and the explicit effective relax policy were not changed.

The accepted-baseline comparison is not evidence that relax type `6` caused the branch-wide slowdown: both the accepted rows and current performance-regression rows explicitly use effective relax type `6`. After identity migration, two cases were comparable and all 10 current rows passed correctness and strict GPU-residency checks, but CPU wall p95 was `21395.9 ms` versus `11094.7 ms` accepted (`+92.85%`) and GPU wall p95 was `10243.6 ms` versus `5225.24 ms` (`+96.04%`). The timing baseline was not rewritten or loosened.

## Final promotion result

**NO-GO.** The exact candidate matrix supports relax type `6`, but the required branch-wide accepted-baseline performance regression is red. The central default remains `18`; there is no promotion commit. A separate root-cause investigation must recover the accepted production performance before promotion can be reconsidered.
