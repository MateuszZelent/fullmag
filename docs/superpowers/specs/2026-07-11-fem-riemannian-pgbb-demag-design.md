# FEM Riemannian PG-BB Demag Qualification Design

Date: 2026-07-11

## Objective

Repair the FEM projected-gradient Barzilai--Borwein method so its secant
history is geometrically valid on the nodal unit-sphere manifold, then decide
whether FEM PG-BB with demagnetization can be restored as a production
capability using the same strict physical qualification gates as FEM NCG.

The change must not weaken Armijo acceptance, hide an energy increase, loosen
the demagnetization solver policy, substitute NCG, or silently change the
requested algorithm.

## Current failure and root-cause hypothesis

Each active FEM magnetization node satisfies

\[
  m_i \in S^2, \qquad \lVert m_i \rVert = 1.
\]

The full optimization space is therefore a product of nodal spheres. The
current CPU and CUDA PG-BB implementations construct the secant pair as

\[
  s_k = m_{k+1} - m_k, \qquad
  y_k = g_{k+1} - g_k.
\]

This subtracts tangent gradients that belong to different tangent spaces and
uses an ambient chord as the step vector. After the first accepted step, the
BB curvature products can therefore include normal components caused by the
rotation of the tangent plane. FEM NCG does not have this defect: it projects
the previous gradient and search direction into the new tangent space before
forming its PR+ history.

The hypothesis is that this inconsistent BB history generates unreliable
spectral step sizes after multiple accepted steps. Demagnetization then
exposes the defect because the requested Armijo decrement eventually becomes
smaller than both the finite-accuracy Poisson energy oracle and the binary64
resolution of the total-energy difference.

## Chosen algorithm

Use a projection-based vector transport associated with the existing nodal
normalization retraction. For every active node, transport an ambient vector
`v` from the previous tangent space to the new one with

\[
  \mathcal T_{m_k \rightarrow m_{k+1}}(v)
  = P_{m_{k+1}}v
  = v - (m_{k+1}\cdot v)m_{k+1}.
\]

Construct the new-tangent-space secant pair as

\[
  \tilde s_k = P_{m_{k+1}}(m_{k+1}-m_k),
\]

\[
  \tilde y_k = g_{k+1} - P_{m_{k+1}}g_k.
\]

Then retain the existing physical energy metric

\[
  \langle a,b\rangle_E
  = \mu_0\sum_i M_{s,i}V_i\,a_i\cdot b_i
\]

and compute BB1/BB2 from

\[
  \lambda_{BB1} =
  \frac{\langle\tilde s,\tilde s\rangle_E}
       {\langle\tilde s,\tilde y\rangle_E},
  \qquad
  \lambda_{BB2} =
  \frac{\langle\tilde s,\tilde y\rangle_E}
       {\langle\tilde y,\tilde y\rangle_E}.
\]

This preserves the existing `m/A` step unit, dimension-aware curvature guard,
BB1/BB2 alternation, clamp range, and reset policy. Inactive nodes remain zero
contributors. CPU and CUDA must use the same equations and decision policy.

The projection transport is selected instead of a geodesic logarithm and
parallel transport because it matches the existing retraction, is already the
transport used by NCG, has no singular antipodal branch, and provides the
smallest source change that restores tangent-space consistency.

## Rejected approaches

### Transport only the previous gradient

This fixes `y` but leaves the ambient chord `s` outside the new tangent space.
It is not a complete Riemannian secant pair and would leave CPU/GPU behavior
dependent on normal-component cancellation.

### Loosen Armijo or add an energy-noise acceptance window

This changes the physical acceptance contract and can accept a truly uphill
step. It treats the terminal symptom rather than the inconsistent BB history.
Strict Armijo and exact nonincrease recovery remain unchanged.

### Replace PG-BB with NCG when demagnetization is active

This is a hidden algorithm fallback and violates requested/resolved execution
provenance. NCG remains the explicitly selectable production alternative.

## Test strategy

### Red test: tangent-space secant contract

Add a focused native test using at least two non-collinear unit
magnetizations and tangent gradients. It must demonstrate that the current
ambient `s` and `y` have a nonzero normal component at `m_{k+1}`, while the
transported pair satisfies

\[
  |m_{k+1}\cdot\tilde s| \le C\epsilon,
  \qquad
  |m_{k+1}\cdot\tilde y| \le C\epsilon.
\]

The test must also verify CPU-reference BB products and step decisions for
both BB1 and BB2, including heterogeneous `M_s`, inactive nodes, invalid
curvature reset, and physical units.

Before the implementation is added, the new contract test must fail for the
missing transport behavior. After the implementation, the same test must
pass. The fix must be temporarily reverted once to prove that the regression
test fails for the original behavior.

### CPU/CUDA parity contract

Extend the CUDA relaxation source/runtime contract so the kernel receives the
new magnetization and projects both the chord and previous gradient before
reduction. Compare CUDA reduction results with the CPU reference on the same
small fixture within a reduction-order-aware binary64 tolerance.

### Algorithmic control experiment

On the production demag fixture, record for every accepted PG-BB step:

- transported `ss`, `sy`, and `yy`,
- selected BB1/BB2 candidate and clamped step,
- Armijo slope and requested decrement,
- actual total-energy change,
- demag solver iterations and final relative residual,
- maximum tangent defect of `s` and `y`.

Run three controlled variants with identical initial state, mesh, materials,
demag policy, and `rtol=1e-12`:

1. the original ambient secant computation as the failing baseline;
2. transported Riemannian BB;
3. projected steepest descent with BB history disabled.

The instrumentation must be opt-in or test-local and must not add allocations,
logging, or synchronization to the normal disabled runtime path.

### Production qualification

Use repository-managed, container-backed `just` recipes. Host builds and
direct binaries are diagnostic only and cannot qualify the capability.

Qualification requires:

1. focused CPU unit/source contracts pass;
2. focused CUDA source and parity contracts pass;
3. the production FEM relaxation benchmark completes on CPU and GPU;
4. every accepted step satisfies strict Armijo or exact nonincrease recovery;
5. magnetization norm preservation and tangent-gradient validity pass;
6. CPU/GPU final energy, torque, and stop reason remain within the existing
   qualification tolerances;
7. demag uses deterministic fresh Poisson initial state and effective
   `rtol<=1e-12`;
8. no hidden device, algorithm, precision, or demag fallback occurs;
9. existing NCG, LLG, and PG-BB-without-demag regression gates remain green.

## Capability decision

The planner and Control Room quarantine remain in force during development.
They may be removed only after the full CPU/GPU production qualification
passes from a freshly rebuilt managed runtime.

If qualification passes, update the canonical capability matrix, validation
report, planner tests, UI capability/Inspector tests, and provenance language
to mark FEM CPU/CUDA PG-BB with demag production-qualified at effective
`rtol<=1e-12`. Missing tolerance must resolve canonically to `1e-12`; an
explicitly looser tolerance must fail before runtime. No other execution lane
changes status.

If any required production case still fails, retain the quarantine and report
the first failing step together with transported curvature, Armijo, and demag
oracle evidence. Do not compensate by changing the line-search acceptance
contract.

## Documentation ownership

Before implementation, update the publication-style physics note
`docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md` so the transported
secant pair is canonical. Reconcile
`docs/physics/0580-canonical-relaxation-equilibrium-contract.md` if it contains
the ambient-history formulation.

If capability status changes, also update:

- `docs/specs/capability-matrix-v0.md` and its JSON representation;
- `docs/architecture/backend-golden-masterplan.md`;
- `docs/validation/2026-07-11-relaxation-qualification-matrix.md`;
- OpenAPI/generated frontend types only if the existing capability vocabulary
  cannot express the restored lane.

## Scope boundaries

This work does not change the public algorithm name, stage schema, stop
criteria, torque definition, time semantics, demag formulation, Poisson
preconditioner, precision policy, or NCG implementation. It does not introduce
a general manifold library. Shared helpers are permitted only when both CPU
and CUDA tests need an identical scalar contract and the helper reduces actual
duplication.

## Success criterion

The problem is fixed only if the transported secant contract has a verified
red/green regression test and the managed CPU/GPU production benchmark with
demagnetization completes without an Armijo failure. Source plausibility or a
single accepted step is insufficient.
