# FEM GPU Direct-Minimizer Exchange-Mass Preconditioning

- Status: the historical FEM GPU NCG experiment remains invalid qualification/no-go. The separate FEM GPU projected-gradient BB cooperative-PCG path and typed Study policy now have source, but end-to-end GPU and scientific qualification remain NOT VERIFIED; no production promotion is claimed.
- Owners: Fullmag FEM backend
- Last updated: 2026-11-11 (historical NCG result remains dated 2026-07-26)
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

(scientific-bibliography)=
## 10. References

- J. Nocedal and S. J. Wright, *Numerical Optimization*, second edition,
  Springer, 2006.
- R. E. Bank and D. J. Rose, "Parameter selection for Newton-like methods
  applicable to nonlinear partial differential equations," *SIAM Journal on
  Numerical Analysis* 17(6), 1980.
- `docs/audits/evidence/task-11/task-11-relaxation-preconditioner.csv`
- `docs/audits/evidence/task-11/task-11-relaxation-preconditioner-qualification.json`
- `.superpowers/sdd/task-11-report.md`

## 11. Candidate FEM GPU projected-gradient BB exchange-mass realization

This section records a separate, bounded candidate for the FEM GPU
`projected_gradient_bb` path. Sections 1–10 preserve the historical NCG
proposal, measurements, and no-go decision. The fixed-CG, lumped-mass
operators and strategy tokens in those sections do not specify this BB
implementation. Public IR policy, CUDA kernel, and StudyBuilder sources exist
in the task branch. Source presence is not GPU runtime, physics-parity, or
performance qualification.

(problem-statement)=
### 11.1 Problem statement and governing equations

(governing-equations)=
The CPU projected-gradient BB path provides the operator and unit convention
for this optimization. The GPU realization must use the same consistent
finite-element mass and exchange forms. For P1 basis functions on the magnetic
domain, define

```{math}
:label: fem-gpu-bb-consistent-forms
 (M_{M_s})_{ij} = \int_{\Omega_m} M_s\,\phi_i\phi_j\,\mathrm{d}V,
 \qquad
 (K_A)_{ij} = \int_{\Omega_m} A\,\nabla\phi_i\cdot\nabla\phi_j\,\mathrm{d}V.
```

Clamp the BB step used by the operator to the existing direct-minimizer
preconditioner bounds, `10^{-12}` to `10^{-6}\,\mathrm{m\,A^{-1}}`. For the
resulting `\lambda_{\mathrm{BB}}`, the three Cartesian components use the same
scalar system:

```{math}
:label: fem-gpu-bb-step-bounds
 \lambda_{\mathrm{BB}} = \min\!\left(\lambda_{\max},
 \max\!\left(\lambda_{\min},\lambda_{\mathrm{raw}}\right)\right),
 \qquad
 \lambda_{\min}=10^{-12}\,\mathrm{m\,A^{-1}},\quad
 \lambda_{\max}=10^{-6}\,\mathrm{m\,A^{-1}}.
```

```{math}
:label: fem-gpu-bb-exchange-mass-system
 \left(M_{M_s} + \frac{2\lambda_{\mathrm{BB}}}{\mu_0}K_A\right)\mathbf{z}
 = M_{M_s}\mathbf{g},
 \qquad
 \mathbf{d}=\Pi_T(\mathbf{m})\mathbf{z}
 = \mathbf{z}-(\mathbf{m}\cdot\mathbf{z})\mathbf{m}.
```

```{math}
:label: fem-gpu-bb-independent-residual
 \mathbf{b}=M_{M_s}\mathbf{g},\qquad
 \mathbf{r}=\left(M_{M_s}+\frac{2\lambda_{\mathrm{BB}}}{\mu_0}K_A\right)
 \mathbf{z}-\mathbf{b},\qquad
 \|\mathbf{r}\|_2\leq 10^{-8}\|\mathbf{b}\|_2
 \quad(\mathbf{b}\ne\mathbf{0}),
 \qquad
 \mathbf{r}=\mathbf{0}\quad(\mathbf{b}=\mathbf{0}).
```

Here `\mathbf{g}` remains the original physical tangent energy gradient;
`\mathbf{z}` is used to form the search direction after tangent projection.
`\lambda_{\mathrm{BB}}` is the accepted BB step (`step_m_per_a`), and the
exchange factor is exactly `2\lambda_{\mathrm{BB}}/\mu_0`, as in the CPU
operator helper. This is the consistent-mass form, not the lumped-mass form
used by the historical NCG experiment above.

(symbols-and-si-units)=
### 11.2 Symbols and SI units

| Quantity | Exact symbol | Meaning | SI unit |
|---|---|---|---|
| Reduced magnetization | `$\mathbf{m}$` | Nodal unit-length magnetization | `$1$` |
| Saturation magnetization | `$M_s$` | Saturation magnetization field | `$\mathrm{A\,m^{-1}}$` |
| Exchange stiffness | `$A$` | Scalar exchange coefficient | `$\mathrm{J\,m^{-1}}$` |
| Vacuum permeability | `$\mu_0$` | Vacuum permeability | `$\mathrm{N\,A^{-2}}$` |
| Consistent Ms mass matrix | `$M_{M_s}$` | FEM mass matrix weighted by saturation magnetization | `$\mathrm{A\,m^2}$` |
| Exchange stiffness matrix | `$K_A$` | Scalar weak exchange stiffness | `$\mathrm{J}$` |
| BB step | `$\lambda_{\mathrm{BB}}$` | Accepted step used in the exchange weight | `$\mathrm{m\,A^{-1}}$` |
| Raw tangent gradient | `$\mathbf{g}$` | Physical energy gradient before preconditioning | `$\mathrm{A\,m^{-1}}$` |
| Preconditioned vector | `$\mathbf{z}$` | Solution of the exchange-mass system | `$\mathrm{A\,m^{-1}}$` |
| Projected search direction | `$\mathbf{d}$` | Search direction after tangent projection | `$\mathrm{A\,m^{-1}}$` |
| Tangent projector | `$\Pi_T(\mathbf{m})$` | Projection onto the nodal tangent plane | `$1$` |
| P1 basis function | `$\phi_i$` | Scalar FEM nodal basis function | `$1$` |
| Global basis indices | `$i,j$` | Row and column nodal basis indices | `$1$` |
| Spatial gradient | `$\nabla$` | Derivative with respect to position | `$\mathrm{m^{-1}}$` |
| Magnetic domain | `$\Omega_m$` | Domain integrated for magnetic exchange/mass | `$\mathrm{m^3}$` |
| Volume measure | `$\mathrm{d}V$` | FEM volume integration measure | `$\mathrm{m^3}$` |
| Unclamped BB step | `$\lambda_{\mathrm{raw}}$` | Step supplied by the current BB state | `$\mathrm{m\,A^{-1}}$` |
| Minimum preconditioner step | `$\lambda_{\min}$` | Existing lower bound for the operator step | `$\mathrm{m\,A^{-1}}$` |
| Maximum preconditioner step | `$\lambda_{\max}$` | Existing upper bound for the operator step | `$\mathrm{m\,A^{-1}}$` |
| Preconditioner right-hand side | `$\mathbf{b}$` | Mass-weighted physical gradient | `$\mathrm{A^2\,m}$` |
| True linear residual | `$\mathbf{r}$` | Unpreconditioned residual of the assembled system | `$\mathrm{A^2\,m}$` |

The mass matrix and weighted exchange matrix both have units
`\mathrm{A\,m^2}`; the right-hand side has units `\mathrm{A^2\,m}`. The
solution therefore has units `\mathrm{A\,m^{-1}}`.

(assumptions-and-validity)=
### 11.3 Assumptions, validity, and backend matrix

The candidate is limited to the existing FEM GPU projected-gradient
BB legality envelope and its current exchange operator. It does not widen
periodic-boundary support: existing FEM GPU PBC admission and restrictions
remain unchanged. When an already-supported periodic reduced-node projection
is present, the candidate applies the existing device periodic projection
after the scalar solve, then the existing free-node-mask and nodal tangent
projection. This does not claim a new periodic mass/stiffness assembly.
The typed Study setting is a solver policy, not a physical parameter. It is
accepted only for explicit FEM GPU `projected_gradient_bb`; other combinations
remain rejected by existing validation. The requested policy is retained in IR
separately from the resolved solver and execution provenance.

| Solver | Device | Status for this preconditioner | Boundary |
|---|---|---|---|
| FEM | CPU | Existing reference | Consistent-mass exchange form and `step_m_per_a` scaling are owned by the current CPU minimizer helpers. |
| FEM | GPU | Implemented in source, unqualified | Typed Study/IR policy and cooperative device PCG sources exist; managed execution, parity, and performance remain NOT VERIFIED. |
| FDM | CPU | Not applicable | This contract is the FEM consistent-mass weak form; FDM operator semantics are not changed. |
| FDM | GPU | Not applicable | This contract is the FEM consistent-mass weak form; FDM operator semantics are not changed. |

(discrete-realization)=
### 11.4 GPU realization and unchanged physical behavior

The target architecture uses `backends/fem/gpu/cuda/relaxation/bb_exchange_mass.cpp`
as a host setup bridge for the assembled MFEM mass and exchange forms.
`bb_exchange_mass_kernels.{cu,hpp}` owns a persistent cooperative CUDA PCG
workflow over their immutable device CSR representations. Device Jacobi,
reductions, `alpha`/`beta` updates, residual checks for iteration control, and
convergence decisions stay inside the cooperative device launch. The inner
relative tolerance is `1e-10`, and the iteration limit is `512`; failure to
converge within that bound is explicit. The finite cap bounds the persistent
kernel runtime; it is not a claim to repair CUDA error 719. Lack of
cooperative-launch support also fails explicitly. No per-iteration scalar
reaches the host and there is no CPU solver fallback.

The independent final true-residual certificate applies the relative limit
from Section 11.1 for every nonzero component RHS; an exactly zero RHS must
produce an exactly zero solution and residual. There is no absolute residual
floor for this GPU preconditioner, so a tiny nonzero RHS cannot pass with large
relative error. Underflowed or overflowed norm-square calculations,
non-finite values, non-convergence, or a failed residual check are explicit
errors. This stricter preconditioner check is distinct from the historical CPU
preconditioner absolute tolerance and does not change the existing strict
Poisson solve or its independent certification. The final certificate performs
one transfer from device to host; there is no CPU solve or fallback. Record
actual launch support, solver identity `cooperative_device_pcg`, iteration
count, residual, and transfer audit in execution provenance. The outer
BB/Armijo scalar controller and HYPRE Poisson host control remain host-
controlled; the existing Poisson `rtol` and iteration limit are unchanged.
This does not claim the whole relaxation step is fully GPU controlled.

Keep the original physical gradient for torque, stopping, and BB curvature.
If the proposed GPU direction fails the existing physical energy-weighted
`g·z > 0` descent check, restart from the raw GPU gradient, as on CPU. Preserve
the existing representable-chord Armijo path, fresh-zero Poisson trial
evaluation, independent Poisson certification, energy ownership, and
accepted-state semantics. The preconditioner changes only the search
direction.

(python-api)=
### 11.5 API, ProblemIR, validation errors, and provenance

The typed Study policy is `StudyBuilder.fem_bb_preconditioner(policy)`, with
`policy` in `auto`, `none`, or `exchange_mass`; it is a required argument.
It is an internal solver policy, not a physical model field. The canonical
SP4 authoring workload remains
`tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`.

The Python method validates this finite set of strings and lowers it to the
typed `FemGpuBbPreconditionerIR` request. There is no global environment
variable selector.

```python
# %%
from pathlib import Path

import fullmag as fm

study = fm.study("mumag_sp4_fem_relax_projected_gradient_bb")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.interactive(True)
study.wait_for_solve(True)
study.fem_bb_preconditioner(policy="auto")

study.universe(
    mode="manual",
    size=(1200e-9, 600e-9, 550e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=10e-9,
    maximum_element_size=110e-9,
    maximum_element_growth_rate=1.9,
    grading="geometric",
)
film = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh.thin_film(
    minimum_element_size=3e-9,
    maximum_element_size=3e-9,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=600,
)
study.mesh.save_or_load(
    Path(__file__).resolve().with_suffix(".fullmag-mesh")
)
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=100_000,
    tolT=5.8349e-9,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=["step", "mx", "my", "mz", "e_ex", "e_demag", "e_total", "max_torque_T"],
        ),
        fields=[],
    )
)
study.stages.add_save_state(
    artifact_name="relaxed_m.zarr",
    format="zarr",
    dataset="m",
)
```

This is the full SP4 authoring shape with `policy="auto"`. It parses and the
StudyBuilder method is present in source; this documentation task does not run
the scenario or managed GPU runtime. Its runtime, parity, and performance
support remain unqualified. The method-free repository SP4 scenario remains
the existing executable reference.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR mapping |
|---|---|---|---|---|---|---|---|
| `StudyBuilder.fem_bb_preconditioner.policy` | `str` | required | `1` | `auto`, `none`, or `exchange_mass`; requires explicit FEM GPU `projected_gradient_bb`, otherwise lowering rejects it | Requested FEM GPU BB direction policy | Strict FEM GPU `projected_gradient_bb`; other lanes unsupported | `FemHintsIR.gpu_bb_preconditioner` → `FemPlanIR.gpu_bb_preconditioner` |

(problem-ir)=
The IR enum is `FemGpuBbPreconditionerIR::{Auto,None,ExchangeMass}` and the
planner validates its solver/backend scope before copying the request into
`FemPlanIR`. `auto` preserves the requested intent; resolved execution records
the actual solver (`cooperative_device_pcg` when the exchange-mass candidate is
selected), device identity, and residual/iteration diagnostics. `none` is the
raw device tangent-gradient baseline; `exchange_mass` requests the candidate
explicitly. These values are serialized solver intent and provenance, not
physical model parameters.

(round-trip-and-failure-semantics)=
The method and native setting are being wired in the task branch. Unknown
mode strings and unsupported combinations are validation errors and must fail
closed. There is no process-global environment selector. The managed
scientific recipe must run baseline and candidate as isolated Studies with
explicit modes and retain the exact requested and resolved values, source,
binary, mesh, initial state, and actual GPU identity in each receipt.

(validation)=
### 11.6 Validation and qualification gates

1. Native manufactured tests compare GPU assembly and solve against an
   independent tiny dense oracle. Cover tangent projection; active/inactive
   masks; heterogeneous `M_s` and `A`; BB-step scaling; zero right-hand side;
   cache reuse and invalidation; residual acceptance/rejection; non-finite and
   non-converged failures; and descent restart behavior.
2. Compare CPU and GPU on the same frozen SP4 R2 mesh, source, ProblemIR,
   materials, and initial state. Require torque agreement within `1e-6`,
   relative agreement of `E_total` within `1e-9` and each nonzero energy
   component within `2e-6` (zero components within `1e-30 J`),
   and preserve the CPU reference target `E_total = 6.23101634685e-19 J`.
   Retain complete Zarr output and provenance for every run.
3. Benchmark at least five alternating baseline/candidate repetitions after a
   warm-up, with CUPTI disabled and identical hardware, resource limits,
   binary, mesh, and initial state. Benchmark against CPU as a separate lane.
   Report distributions and cost to the same stopping result; do not promise a
   speedup before measurement. “GPU faster than CPU” is a measured conclusion,
   not an acceptance assumption.
4. Keep all native builds and managed GPU runs on the scientific managed
   recipe. Source tests, dense oracles, and source presence do not qualify GPU
   execution. Preserve the existing energy, torque, residual, and full-Zarr
   evidence requirements.

(limitations)=
### 11.7 Limitations and source-code index

No production promotion or qualification threshold has been chosen. This
section records the candidate contract; it is not evidence that the module
compiles, runs on a GPU, preserves SP4 parity, or improves performance. Native
GPU regression tests and managed SP4 measurements remain required.

(implementation-mapping)=
(source-code-index)=
| Claim | Repository path | Stable symbol / anchor | Lane | Evidence status |
|---|---|---|---|---|
| Consistent mass-plus-exchange operator and accepted-step coefficient | `backends/fem/cpu/mfem/relaxation/relaxation_math.hpp` | `assemble_exchange_mass_preconditioner_for_step` | FEM CPU reference | Implemented interface; implementation in `.cpp` |
| Exact `2/mu0` exchange scale per BB step | `backends/fem/src/relaxation_operator_units.hpp` | `exchange_hessian_scale_from_step_m_per_a` | FEM CPU reference | Implemented source |
| Existing BB step input sanitization | `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` | `sanitized_relaxation_step_size` | FEM CPU reference | Implemented source |
| CPU preconditioned-gradient and projected-gradient BB ownership | `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` | `exchange_mass_preconditioned_gradient` | FEM CPU reference | Implemented source |
| CPU projected-gradient BB step and Armijo integration | `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp` | `run_projected_gradient_bb_step` | FEM CPU reference | Implemented source |
| Manufactured SI operator oracle | `backends/fem/tests/relaxation_operator_contract.cpp` | `main` | FEM CPU test | Source test |
| SP4 authoring and existing comparison workload | `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py` | `study` | FEM CPU/GPU request | Existing scenario; not GPU preconditioner evidence |
| MFEM device workspace construction and immutable operator upload | `backends/fem/gpu/cuda/relaxation/bb_exchange_mass.cpp` | `gpu_bb_exchange_mass_create` | FEM GPU | Implemented source; runtime unqualified |
| Operator lifecycle cache preparation | `backends/fem/gpu/cuda/relaxation/bb_exchange_mass.cpp` | `gpu_bb_exchange_mass_prepare` | FEM GPU | Implemented source; runtime unqualified |
| Existing device periodic and tangent projections | `backends/fem/gpu/cuda/relaxation/pgbb_kernels.cu` | `fullmag_cuda_relax_project_tangent_field` | FEM GPU | Existing source; unchanged |
| Existing device periodic representative projection | `backends/fem/gpu/cuda/relaxation/pgbb_kernels.cu` | `fullmag_cuda_relax_project_static_periodic_field` | FEM GPU | Existing source; unchanged |
| Requested preconditioner enum and resolved IR fields | `crates/fullmag-ir/src/mesh_hints.rs` | `FemGpuBbPreconditionerIR` | FEM GPU request | Implemented IR source |
| Typed FEM hints and planned `ProblemIR` destination | `crates/fullmag-ir/src/mesh_hints.rs` | `FemHintsIR` | FEM GPU request | Implemented IR source |
| Resolved FEM plan destination | `crates/fullmag-ir/src/plan.rs` | `FemPlanIR` | FEM GPU plan | Implemented IR source |
| Backend and algorithm legality validation | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM GPU planning | Implemented planner source |
| Cooperative device PCG recurrence and convergence | `backends/fem/gpu/cuda/relaxation/bb_exchange_mass_kernels.cu` | `gpu_bb_pcg_launch` | FEM GPU | Implemented source; runtime unqualified |
| StudyBuilder policy entry point | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | FEM GPU request | Implemented source; runtime unqualified |
| Native context policy setter | `backends/fem/src/api.cpp` | `fullmag_fem_backend_set_gpu_bb_preconditioner` | FEM GPU runtime | Implemented source; runtime unqualified |
