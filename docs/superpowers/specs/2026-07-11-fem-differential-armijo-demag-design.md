# FEM Differential Armijo Demag Qualification Design

Date: 2026-07-11

## Objective

Restore FEM projected-gradient BB with Poisson-airbox demagnetization only if
CPU and GPU can certify the existing strict Armijo condition at the final
backtracking steps. The method must not accept an uphill step, introduce a
user-facing tolerance, silently substitute NCG, or alter the public relaxation
algorithm vocabulary.

## Observed numerical failure

The transported Riemannian BB secant fixes the geometric defect in the BB
history, but production qualification still rejects two demag cases at the
minimum step `9.53674316406249957e-13 m/A`. The failed comparisons differ by
`1.70e-31 J` on GPU and `1.23e-30 J` on CPU while the reported total energy is
of order `1e-17 J`. The present implementation forms both total energies and
then subtracts them implicitly in

\[
 E(m_1) \le E(m_0) + c_1\lambda\langle p,g\rangle_E.
\]

That scalar comparison loses the small physical decrement in an unrelated
large energy offset. It cannot distinguish a true line-search rejection from
rounding in the aggregate observable.

## Canonical acceptance contract

Let `m0` be the accepted state, `m1` a retracted trial state, `p` the descent
direction, and `lambda` the trial step in `m/A`. The acceptance condition is
unchanged, but is evaluated in difference form:

\[
 \Delta E = E(m_1)-E(m_0),
 \qquad
 \Delta E \le c_1\lambda\langle p,g\rangle_E,
 \qquad c_1=10^{-4}.
\]

The right-hand side remains in joules because the energy metric is

\[
 \langle a,b\rangle_E = \mu_0\sum_i M_{s,i}V_i\,a_i\cdot b_i.
\]

`Delta E` is accumulated directly from local or polarized energy differences;
the implementation must never obtain it by subtracting published total-energy
scalars. Exact monotone recovery likewise uses `Delta E <= 0`, not a
tolerance window.

## Interaction realization

For local and exchange interactions, evaluate a per-node or per-element
difference `e(m1)-e(m0)` before reduction. The reduction also accumulates the
absolute term sum used to bound floating-point summation.

For linear Poisson demagnetization, retain the existing energy convention

\[
 E_d(m)=-\frac{\mu_0}{2}\sum_i M_{s,i}V_i\,m_i\cdot H_d(m)_i.
\]

With freshly evaluated endpoint fields `H0` and `H1`, accumulate the
polarized increment directly:

\[
 \Delta E_d=-\frac{\mu_0}{2}\sum_i M_{s,i}V_i\,(m_{1,i}-m_{0,i})
 \cdot (H_{0,i}+H_{1,i}).
\]

This is the discrete quadratic-energy identity for a self-adjoint demag
operator. Robin airbox boundary energy is included as the corresponding
quadratic boundary-form difference, not as a difference of cached scalar
totals. CPU and GPU must use the same convention, magnetic-node mask, `Ms`,
lumped mass, and deterministic reduction contract.

## Uncertainty and refinement

The normal line-search evaluation has no additional Poisson solve: it saves
the accepted demag field and computes the trial field already required for the
fresh trial snapshot. It returns a finite `Delta E`, absolute-term sum, and a
conservative roundoff bound for the difference reduction.

If the Armijo threshold lies outside the resulting interval, accept or reject
without extra work. If it intersects the interval, rerun the current and
trial demag snapshots from deterministic fresh initial states with a stricter
internal solver tolerance and recompute the direct difference. Acceptance
requires strict Armijo in both the ordinary and refined evaluations. A refined
disagreement or remaining overlap is a line-search rejection with diagnostic
telemetry, never a convergence result and never an accepted uphill step.

The tightened solve is internal and only legal if it is at least as strict as
the requested/effective tolerance. It must preserve the native device lane,
demag realization, precision, and provenance. The exact tighter tolerance and
attempt count are implementation-owned constants documented in diagnostics,
not Python or UI controls.

## Scope and ownership

The numerical owner is `backends/fem/cpu/mfem/relaxation` for CPU and
`backends/fem/gpu/cuda/relaxation` for CUDA. Demag energy identities remain in
the existing Poisson energy owners; no solver policy is placed in Rust runner,
`Context`, `mfem_bridge.cpp`, Python DSL, ProblemIR, OpenAPI, or the Control
Room.

The current planner and UI quarantine remains valid during implementation.
No public schema, Python export, or inspector parameter changes are required.
If, and only if, qualification passes, the existing capability entry may be
promoted without adding a new vocabulary item. Requested PG-BB must remain
PG-BB in provenance; NCG is not a fallback.

## Validation

1. A manufactured CPU test demonstrates a nonzero `Delta E` below the ULP of
   two large endpoint totals, and proves direct difference Armijo accepts the
   physically descending trial.
2. CUDA reduction parity uses the same non-collinear fields, heterogeneous
   `Ms`, inactive nodes, and direct polarized demag identity.
3. A source/behavior test proves ambiguous intervals trigger exactly one
   refinement and cannot be accepted when the refined evaluation disagrees.
4. Existing non-demag PG-BB, NCG-with-demag, LLG, norm, tangent-gradient, and
   torque contracts remain green.
5. Managed container-backed native contracts and a freshly rebuilt CPU/GPU
   production benchmark must pass with strict Armijo on every accepted step.
6. The qualification artifact records ordinary/refined `Delta E`, Armijo
   threshold, interval bound, refinement count, final demag residual, and
   device/realization provenance.

## Completeness checklist

- [ ] CPU and CUDA use direct energy increments rather than endpoint total subtraction.
- [ ] Demag polarization and Robin boundary forms share one documented sign/unit convention.
- [ ] Ambiguity has bounded refinement and fail-closed behavior.
- [ ] No algorithm/device/precision/demag fallback is introduced.
- [ ] Planner and UI quarantine is removed only after managed CPU/GPU qualification.
- [ ] Physics, capability, validation, and provenance documentation agree with runtime behavior.

## Deferred work

Formal a-posteriori energy-norm certification from a Poisson residual requires
a verified lower spectral bound for each demag matrix and is not claimed here.
This design instead requires agreement of deterministic fresh strict solves
and fails closed when the numerical oracle remains inconclusive.
