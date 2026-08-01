# FEM GPU Direct-Minimizer Exchange-Mass Preconditioning

- Status: measured no-go; no production implementation or selector retained
- Owners: Fullmag FEM backend
- Last updated: 2026-07-26
- Related physics notes:
  - `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- Related specs:
  - `docs/specs/native-fem-backend-architecture-v1.md`
  - `docs/specs/capability-matrix-v0.md`

## 1. Problem statement

The strict FEM GPU nonlinear conjugate-gradient (NCG) minimizer currently uses
the tangent energy gradient without a device-side approximation of the local
exchange stiffness. On refined or exchange-dominated meshes this can increase
the number of accepted steps, Armijo trials, and expensive demagnetizing-field
solves needed to reach the unchanged physical stopping tolerance.

This note records the contract that was used to evaluate a bounded,
device-resident exchange-mass preconditioner for the strict GPU NCG path. The
preconditioner is an optimization of the search
direction only. It must not redefine energy, the Armijo condition, accepted
state, convergence tolerance, or any reported physical observable. It becomes
an automatic production choice only after the literal qualification gate in
Section 7 passes. The measured candidates did not pass, so the experimental
runtime implementation and selector were removed. This note remains as the
scientific design and no-go record; it does not describe a reachable production
feature.

## 2. Physical and numerical model

### 2.1 Governing equations

Let `g` be the raw tangent energy gradient in the existing direct-minimizer
field convention. For nonnegative `lambda`, define

```text
P_lambda = diag(M_s M_lumped) + lambda * (2/mu0) K_A
z = Pi_T(m) P_lambda^{-1} diag(M_s M_lumped) g
```

`K_A` is the scalar heterogeneous-exchange FEM stiffness operator already
uploaded as the production exchange CSR. The same scalar operator is applied
independently to the three Cartesian components. `Pi_T(m)` is the nodal
tangent projection

```text
Pi_T(m) v = v - (m . v) m.
```

For the direct minimizer, `lambda` is the finite, nonnegative, bounded accepted
step parameter derived from `step_m_per_a`. It is part of the resolved
preconditioner parameters and operator signature. No trial step may silently
change the operator used to form an already accepted NCG history vector.

### 2.2 Symbols and SI units

| Quantity | Symbol | SI unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| saturation magnetization | `M_s` | `A/m` |
| lumped nodal volume | `M_lumped` | `m^3` |
| vacuum permeability | `mu0` | `N/A^2` |
| exchange stiffness matrix | `K_A` | `J` |
| raw and preconditioned gradients | `g`, `z` | `A/m` |
| step/preconditioner weight | `lambda` | `m/A` |
| mass diagonal | `M_s M_lumped` | `A m^2` |
| weighted exchange term | `lambda (2/mu0) K_A` | `A m^2` |
| right-hand side | `diag(M_s M_lumped) g` | `A^2 m` |

Thus both terms of `P_lambda` have unit `A m^2`, and applying its inverse to
the right-hand side returns `z` in `A/m`.

### 2.3 SPD condition, magnetic mask, and invalid input

On the active magnetic subspace, `P_lambda` is symmetric positive definite
provided that:

1. every active node has finite `M_s > 0` and finite `M_lumped > 0`;
2. `lambda` is finite and nonnegative;
3. the uploaded heterogeneous-exchange operator `K_A` is symmetric positive
   semidefinite under its documented boundary and material policy.

Nodes outside the magnetic mask, including zero-`M_s` airbox nodes, are
excluded from the active solve. Their right-hand side, work vectors, and output
are exactly zero. A masked node never divides by `M_s M_lumped`. A non-finite
or nonpositive active mass, invalid operator entry, invalid fixed-CG scalar, or
non-finite output sets a device finite flag. That flag is folded into the
existing final per-step scalar readback and causes strict GPU execution to fail
closed; it must not trigger CPU fallback, an extra scalar copy, or acceptance
of a degraded direction.

If a valid right-hand side is already zero, fixed CG keeps the solution and
remaining iterates at zero without treating exact convergence as an error.

### 2.4 Relation to the CPU preconditioner

The CPU direct minimizer remains the backend-neutral numerical oracle for
energy, stopping, and tangent-gradient semantics. Its MFEM realization uses a
consistent `M_s`-weighted mass action and a converged host linear solve of the
mass-plus-exchange system.

The GPU realization intentionally differs only in its bounded numerical
approximation: it uses the uploaded lumped mass and exactly four or eight
device-side CG iterations. Manufactured problems compare that approximation
against a dense CPU solve of the *same lumped operator*. CPU/GPU relaxation
qualification continues to compare physical energies, torque/stopping state,
magnetization, and norm defect; it does not require identical intermediate NCG
directions from the two mass realizations.

## 3. Resolved strategy contract

The internal resolved strategy vocabulary is exactly:

| Token | Operation |
|---|---|
| `none` | Preserve the unpreconditioned tangent gradient, `z = g`. |
| `diagonal_mass` | Apply the mass-only diagonal inverse; algebraically this is `lambda = 0`, so active-node `z = Pi_T(m) g`. It exists as an instrumented device baseline, not as a claimed exchange preconditioner. |
| `lumped_exchange_mass_cg4` | Solve the lumped exchange-mass system with exactly four device CG iterations. |
| `lumped_exchange_mass_cg8` | Solve the lumped exchange-mass system with exactly eight device CG iterations. |
| `stagnation_triggered_cg8` | Resolve to `none` normally and use the exact CG8 operation on the next gradient after an existing NCG restart or a rejected-trial sequence that exhausts the current backtrack budget; it reads only already-host-visible restart/Armijo state. |

The automatic selector may resolve independently by qualified mesh-size range.
It may legally select `none` for the small problem. Environment/test overrides
may force one of the five tokens for qualification, but are not public physics
inputs and must be rejected if misspelled. Unqualified strategies must not
remain reachable in a production binary after a no-go decision.

NCG retains the raw gradient `g` for the Armijo slope and physical stopping
test. The preconditioned vector `z` is used only in the NCG search-direction
recurrence. Restart uses `-z`; Polak-Ribiere uses the existing mass-weighted
preconditioned form with denominator `g_old . z_old`, and descent remains
checked against raw `g`. Strict Armijo acceptance and the accepted energy are
unchanged.

## 4. Device residency, cache, and synchronization

`ExchangeMassPreconditionerState` owns only bounded device work vectors and a
bounded operator signature. Fixed CG executes all four or eight iterations on
the established CUDA stream with device-resident scalar recurrences. It has no
host convergence criterion and performs no per-iteration device-to-host copy,
stream synchronization, or allocation.

The finite flag is one additional value in the existing accepted-step final
readback. Therefore CG4 and CG8 add exactly zero host scalar synchronizations
and do not change the strict NCG per-step scalar-readback budget.

The cached operator signature contains:

- the exact bounded `step_m_per_a`/`lambda` bit pattern;
- the mesh signature, including node count and uploaded exchange CSR identity,
  dimensions, nonzero count, and generation;
- the material signature, including active-mask, `M_s`, lumped-mass, exchange
  coefficient identity, and generation.

A step, mesh signature, or material signature change invalidates the cache and
records one miss when the operator is next used. Exact signature reuse records
one hit. Invalidation never downloads or rebuilds the CSR on the host. The
uploaded exchange CSR, lumped mass, active mask, tangent gradient, and bounded
step are the only operator inputs.

## 5. Energy, convergence, and backend semantics

The preconditioner does not change:

- any interaction energy or effective field;
- fresh-zero strict demagnetizing solves for candidate evaluations;
- the raw-gradient Armijo directional derivative or sufficient-decrease rule;
- accepted-state energy ownership or rollback;
- the torque-based stop condition or its tolerance;
- unit-length projection and norm-defect limits;
- GPU fail-closed behavior, device residency, or existing synchronization
  budgets.

FDM has no implementation impact. FEM CPU keeps its existing consistent-mass
preconditioner. Hybrid execution receives no new behavior. The optimization is
owned by the strict FEM GPU direct-minimizer runtime and shares only the
backend-neutral equations, signs, units, energy, and observable contracts.

## 6. API, IR, planner, runtime, and provenance impact

### 6.1 Python API and ProblemIR

Python API impact: `none`.

ProblemIR impact: `none`.

Users continue to request a physical relaxation study and explicit execution
device. Preconditioner strategy is a resolved runtime optimization, not a
physical model parameter. Canonical Python export and UI-authored ProblemIR
therefore do not contain any of the internal strategy tokens.

### 6.2 Planner and capability matrix

The planner adds no public capability. The candidate is legal only for the
already-supported strict, double-precision FEM GPU direct NCG lane with the
uploaded production exchange CSR. Other relaxers, devices, precisions, and
unsupported FEM configurations resolve to their existing behavior rather than
silently changing lanes.

### 6.3 Runtime, artifacts, diagnostics, and provenance

During the rejected experiment, native step stats and benchmark provenance
exposed the resolved values:

```text
relaxation_preconditioner_strategy
relaxation_preconditioner_iterations
relaxation_preconditioner_lambda_m_per_a
relaxation_preconditioner_wall_time_ns
relaxation_preconditioner_cache_hits
relaxation_preconditioner_cache_misses
```

`strategy` was one exact token from Section 3. `iterations` was `0`, `4`, or
`8` for the operation actually used by the sampled step. `lambda_m_per_a` was
the finite bounded coefficient actually used. These experimental fields are
not retained in the production runtime, ABI, OpenAPI, or generated frontend
types. The qualification harness keeps only the schema needed to reject stale
or incomplete evidence.

Requested physical intent and resolved execution provenance remain separate.
Artifacts must be sufficient to reconstruct which strategy and parameters
produced a timing/qualification sample without presenting that strategy as a
portable physical input.

## 7. Validation and qualification plan

### 7.1 Manufactured operator tests

For small SPD matrices assembled from a positive mass diagonal and symmetric
positive-semidefinite exchange matrix:

1. run the device operator and fixed CG4/CG8;
2. compare operator products and fixed-iteration vectors against an independent
   dense CPU oracle using the same initial zero vector and recurrence;
3. compare against the exact dense solution to verify residual improvement from
   CG4 to CG8 without pretending fixed CG must converge exactly;
4. cover `lambda = 0`, exchange-null modes, masked/zero-`M_s` nodes,
   heterogeneous mass and exchange, zero RHS, and invalid active mass;
5. assert tangent output and finite-flag behavior;
6. assert no new host scalar synchronization for CG4 or CG8.

### 7.2 Physics and cross-backend gates

Each strategy must preserve:

- monotone accepted energy under strict Armijo;
- the existing energy-directional-derivative contract;
- accepted-state/fresh-zero demag accounting;
- the torque stopping tolerance;
- maximum magnetization norm defect;
- CPU/GPU energy, magnetization, and stopping parity;
- strict residency and the existing exact NCG scalar-readback budget.

Qualification evidence is valid only when both sweeps match the immutable
execution identity supplied to the validator: active managed runtime/source/
native-library hashes; accepted GPU UUID, name, and compute capability; exact
per-resolution mesh byte hash, runtime mesh signature, node/element counts;
and the executed canonical ProblemIR hash for the fixed Task 11 workload.
Requested values cannot substitute for values reported by the execution
payload.

The CPU/GPU parity artifact must declare `observable=m`, unit `1`, and a final
step equal to the executed relaxation step. Its content hash must be present,
its vector count must equal the pinned solver-mesh node count, and both CPU and
GPU final torques must be finite and no greater than the requested 8000 A/m
tolerance.

### 7.3 Five-strategy performance matrix

Run `none`, `diagonal_mass`, `lumped_exchange_mass_cg4`,
`lumped_exchange_mass_cg8`, and `stagnation_triggered_cg8` on the same coarse,
medium, and fine managed FEM GPU scenarios with sufficient repeats for p50 and
p95. For every strategy and size report:

- time-to-tolerance;
- accepted steps;
- Armijo trials;
- demagnetizing solves;
- preconditioner wall time;
- HYPRE wall time;
- energy monotonicity;
- maximum norm defect;
- CPU/GPU parity.

### 7.4 Literal go/no-go rule

A strategy may become an automatic default only when, relative to `none`:

1. p50 time-to-tolerance improves by at least 10% on at least two of the three
   sizes;
2. no size has p50 time-to-tolerance worse by more than 5%;
3. p95 time-to-tolerance is not worse by more than 5% on any size;
4. every physics, parity, residency, synchronization, and fail-closed gate
   passes.

The small-problem selector may choose `none`. If no candidate satisfies all
four conditions, the decision is no-go: remove the runtime implementation and
selection code, retain this note plus the no-go report/evidence, and do not
leave a dead feature flag.

### 7.5 Managed verification

Final evidence uses the repository-owned managed/container commands:

```bash
just verify-fem-exchange-runtime
just verify-fem-relaxation-source-contract
just verify-fem-relaxation-runtime
just verify-fem-relaxation-cpu-gpu-consistency-smoke
just verify-fem-gpu-performance-regression
```

Host builds and synthetic source checks are diagnostic only and cannot replace
these runtime and device-identity-pinned gates.

### 7.6 Measured outcome and evidence status

The 2026-07-26 experiment produced all 75 requested GPU rows and selected no
strategy. The strengthened post-review validator classifies that historical
matrix as `invalid`, not as a valid qualifying `no_go`, because:

- the `none` baseline did not reach the torque tolerance on the fine mesh and
  is therefore ineligible as a time-to-tolerance reference;
- CPU/GPU magnetization, energy, and stop-state parity was not captured as the
  required separate six-row baseline under the same runtime and mesh identity;
- accepted-step, cumulative Armijo-trial, cumulative demag-solve, cumulative
  preconditioner-time, and cumulative HYPRE-time fields were not all recorded;
- every `stagnation_triggered_cg8` row reported zero resolved iterations and
  zero preconditioner wall time, so that candidate was a measured no-op.
- the historical rows did not capture the accepted GPU UUID, solver-mesh byte
  hashes, or executed canonical ProblemIR hashes required by the immutable
  execution-identity contract.

This is still a literal production no-go: no candidate is promoted, and the
experimental implementation, selector, ABI fields, and runtime tests remain
removed. The immutable raw CSV, corrected fail-closed JSON, and hashes are in
`docs/audits/evidence/task-11/`. The full interpretation and managed gate
ledger are in `.superpowers/sdd/task-11-report.md`.

## 8. Completeness checklist

- [x] Physical problem and governing equations
- [x] Symbols and SI units
- [x] SPD, mask, zero-`M_s`, and fail-closed semantics
- [x] FDM, FEM CPU, FEM GPU, and hybrid interpretations
- [x] Python API impact (`none`)
- [x] ProblemIR impact (`none`)
- [x] Planner and capability-matrix impact
- [x] Runtime, artifact, diagnostics, and provenance impact
- [x] Validation and literal go/no-go plan
- [x] Five-strategy managed measurement captured and preserved
- [x] Literal no-go decision recorded; no strategy promoted
- [x] Experimental implementation and production selector removed
- [ ] Valid cumulative-work and separate CPU/GPU parity qualification evidence

## 9. Known limits and deferred work

- The candidate is limited to the strict FEM GPU direct NCG lane, double
  precision, P1 operator contract, and already-supported exchange CSR.
- Higher-order FEM, periodic exchange variants outside the current uploaded
  contract, mixed precision, other minimizers, and time integration require
  separate numerical and qualification records.
- A more adaptive Krylov tolerance, host convergence test, AMG hierarchy, or
  learned selector is explicitly out of scope because it would change the
  synchronization, memory, and qualification contract.
- Production thresholds and mesh-size selector boundaries remain unavailable;
  the historical matrix is invalid qualification evidence and cannot justify
  either.

## 10. References

- J. Nocedal and S. J. Wright, *Numerical Optimization*, second edition,
  Springer, 2006.
- R. E. Bank and D. J. Rose, "Parameter selection for Newton-like methods
  applicable to nonlinear partial differential equations," *SIAM Journal on
  Numerical Analysis* 17(6), 1980.
- `docs/audits/evidence/task-11/task-11-relaxation-preconditioner.csv`
- `docs/audits/evidence/task-11/task-11-relaxation-preconditioner-qualification.json`
- `.superpowers/sdd/task-11-report.md`
