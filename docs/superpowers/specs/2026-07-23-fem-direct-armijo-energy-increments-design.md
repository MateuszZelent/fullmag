# FEM direct Armijo energy increments design

- Date: 2026-07-23
- Status: approved in conversation; written-spec review pending
- Scope: native FEM CPU/MFEM and CUDA projected-gradient BB energy differences
- Related plan: `docs/superpowers/plans/2026-07-20-fem-gpu-end-to-end-performance-remediation.md`, Task 8
- Related physics: `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`

## 1. Decision

Replace cancellation-prone endpoint-total subtraction in FEM PG-BB Armijo
evaluation with term-complete direct discrete energy increments. Preserve the
existing strict Armijo inequality, BB1/BB2 and restart policy, fresh-zero demag
contract, rollback, physical tolerances, energy monotonicity, ABI, and the
canonical four-control-sync GPU budget.

This is a numerical-evaluation correction. It does not introduce an energy
tolerance, accept a representable uphill step, reinterpret numerical
stagnation as convergence, or change the authored micromagnetic problem.

## 2. Failure being corrected

The GPU exchange-plus-Zeeman case has endpoint totals near `-2e-17 J` and a
correct direct exchange decrement near `-2.1e-39 J`. Binary64 subtraction of
the endpoint totals rounds that decrement away. The current composition then
subtracts an endpoint delta for a term that is replaced by a direct increment,
adds the correct direct increment back, and can report a small positive value
instead of the physical negative increment.

The existing forward-error bound is incomplete because it is derived from the
already cancelled residual rather than the magnitudes of the operands that
formed it. It can therefore claim resolution near `1e-52 J` while one ULP of
the endpoint total is approximately `3e-33 J`.

CPU exchange-only cases have the same structural defect: exchange remains in
endpoint-energy subtraction even when physical descent is many orders below
endpoint accumulation error. Coarse aliased validation textures expose this
problem but do not justify weakening Armijo or inventing an absolute gradient
threshold.

## 3. Numerical contract

For every enabled energy term `q`, exactly one owner classifies its trial
increment:

1. `direct`: a discrete polarized/local identity computes `Delta E_q` and an
   absolute-term forward-error scale;
2. `endpoint_residual`: endpoint values are subtracted explicitly and their
   operand magnitudes contribute to a conservative subtraction bound;
3. `unsupported`: execution fails closed before an Armijo decision.

No term may be omitted or counted in both the direct and residual sets.

### 3.1 CPU exchange

For the symmetric discrete exchange operator `K_A`, use

```text
Delta E_exchange = (m_trial - m_base)^T K_A (m_trial + m_base)
```

with the normalization already present in the canonical CPU exchange-energy
owner. Accumulate both the signed increment and a componentwise absolute-term
sum. Validate the sign and factor against endpoint energy at resolvable scales
and a long-double small-matrix oracle near the nullspace.

### 3.2 GPU term composition

The direct Armijo batch owns the complete classification of
`GpuFinalScalarSlot` energy terms. Terms already covered by direct exchange,
local, drive, DMI, or polarized demag increments do not participate in an
endpoint-total residual. Any remaining endpoint term contributes its explicit
`trial_q - base_q` and an error bound derived from
`abs(trial_q) + abs(base_q)`.

For a production binary64 retraction, define the representable chord

```text
s = R_m(lambda p)_fp - m.
```

The right-hand side uses the current ambient energy gradient and the chord
that the implementation actually produced:

```text
armijo_rhs = c1 * < -H_eff(m), s >_E
           = -c1 * mu0 * sum_i Ms_i V_i H_eff_i(m) . s_i.
```

This is not an energy tolerance. A zero or non-descent chord is rejected, and
an unchanged chord remains ineligible for acceptance. In exact arithmetic,
`s = lambda p + O(lambda^2)` for a tangent direction at a unit state, so this
rule converges to the classical `lambda * c1 * phi_prime_0` contract. In
binary64 it excludes derivative contributions from components that the
normalization retraction did not representably change.

CUDA PG-BB snapshots `H_eff(m)` once into persistent algorithm-owned device
storage before entering the backtracking loop. Every trial chord uses that
accepted-state snapshot even after trial evaluation overwrites the live field.
The workspace participates in ordinary device-byte accounting and backend
teardown; the line-search hot loop adds no allocation, vector readback,
synchronization, or demag solve.

The composed interval is compared with this strict representable-chord
right-hand side:

```text
armijo_rhs < 0 and upper_bound <= armijo_rhs -> accept
armijo_rhs >= 0                              -> reject
lower_bound > armijo_rhs                     -> reject
otherwise                                    -> refine or fail closed
```

Resolved uphill increments remain rejected. Ambiguity is never converted into
acceptance. A refinement may recompute only the uncertain owner; when no
supported refinement can shrink the interval, state is restored and the stage
remains non-converged.

## 4. Ownership and data flow

- CPU direct exchange belongs under `backends/fem/cpu/mfem/interactions/` and
  is consumed by the CPU PG-BB workflow.
- GPU term classification and composition remain in the CUDA relaxation/direct
  increment subsystem.
- Workflow decisions remain in CPU/GPU PG-BB owners.
- `Context::relaxation` owns one bounded `AcceptedEnergyProof` record for the
  most recently accepted direct-minimizer step. It is algorithm telemetry, not
  a second physics owner, and is cleared when no accepted proof exists.
- The versioned native ABI exposes that record through
  `fullmag_fem_backend_take_accepted_energy_proof_v1`; Rust consumes it once
  and persists the exact accepted increment, uncertainty bound and Armijo
  right-hand side.
- Existing packed PG-BB metrics and Armijo result buffers are reused. CUDA
  reduces the ambient-gradient chord product on device and includes its scalar
  in an existing trial decision batch; no trial vector is copied to the host
  and no baseline host synchronization is added.

## 5. Public-contract impact

- Python DSL: none.
- ProblemIR and normalization: none.
- Planner and capability language: none.
- OpenAPI, resources, UI, and script round-trip: none.
- Runtime ABI and artifacts: the additive, versioned accepted-energy-proof ABI
  and solver-step columns are required so validation uses the decision made by
  the native solver rather than reconstructing it from rounded endpoint
  energies.
- Provenance: benchmark reports pin source manifest, runtime manifest, loaded
  `libfullmag_fem` hash, fixture/mesh identity, device, precision, and policy.

## 6. Failure handling

- Non-finite operands or bounds fail closed.
- Missing or duplicate energy-slot ownership fails a source/runtime contract.
- A resolved uphill trial is rejected exactly as before.
- An unresolved finite-precision interval triggers supported refinement or
  fails as numerical stagnation/non-convergence after rollback.
- No fixed joule window, relative-total-energy window, absolute raw-gradient
  threshold, or silent fixture substitution is permitted.

## 7. Validation

### 7.1 RED/GREEN numerical tests

1. Manufactured endpoint totals near `-2e-17 J` with a direct decrement near
   `-2.1e-39 J` must not reconstruct a positive residual.
2. Retained GPU exchange-plus-Zeeman components must produce a negative
   combined increment and satisfy strict Armijo.
3. CPU polarized exchange must match a long-double oracle near a nullspace and
   endpoint subtraction at resolvable scales.
4. One-ULP and larger resolved uphill trials must remain rejected.
5. Every enabled final energy slot must be classified exactly once.
6. Rollback, finite checks, direct refinement, BB/restart, and four-sync
   accounting remain covered.
7. A representably non-unit pinned state must prove that exact tangent
   projection removes the longitudinal residual while the representable chord
   omits an unchanged Zeeman component; CPU and real CUDA must produce the
   same negative chord RHS and strict decision.
8. At an ordinary scale where every retraction component is representable,
   the chord RHS must converge to the classical
   `lambda * c1 * phi_prime_0` value with the expected first-order error.

### 7.2 Identity-pinned focused A/B

Reuse one explicit mesh and initial-state artifact for pre-fix and candidate
runtimes. Pin commit, source/runtime manifests, loaded native-library hash,
mesh signature, magnetic-node map, material/interaction fields, sampled `m`,
GPU identity, precision, OpenMP count, and demag policy. Run one repeat of CPU
exchange-only, CPU exchange-plus-uniaxial, and GPU exchange-plus-Zeeman PG-BB.

Candidate acceptance requires strict direct-decrement evidence, no resolved
uphill acceptance, correct rollback, and unchanged GPU readback accounting.

### 7.3 Managed production acceptance

Run the repository-managed source, runtime, and exact five-repeat Task 8
benchmark gates. The final matrix must have complete CPU/GPU pairs, monotone
accepted trajectories, no control-readback overrun, and artifacts identifying
the exact final runtime and native-library hashes.

## 8. Fixture validity

The existing two-x-coordinate helical fixture aliases one full period to an
almost uniform nodal state; the uniaxial easy-axis configuration is also a
stationary saddle for the sampled magnetization. Solver correctness is fixed
first without silently changing these fixtures. A later validation-only change
may add a versioned noncommensurate/nonstationary fixture, with a new identity
and baseline, but may not replace the Task 8 comparison in place.

## 9. Rejected alternatives

- Endpoint-total double-double/compensated reduction: costly and does not
  remove structural cancellation introduced by term replacement.
- Noise-window uphill acceptance: scale dependent and violates monotonicity.
- Absolute gradient threshold: dimensionally and mesh-scale dependent.
- Numerical-stagnation classification alone: honest fallback but does not fix
  the wrong energy difference or complete Task 8 acceptance.

## 10. Completeness checklist

- [x] Physical/numerical objective and SI energy units documented.
- [x] FEM CPU/GPU ownership documented.
- [x] FDM/hybrid impact documented as none.
- [x] Python/ProblemIR/planner/API/UI impact documented as none.
- [x] Failure and rollback semantics documented.
- [x] Identity-pinned and managed validation defined.
- [x] Four-sync performance invariant preserved.
- [x] Implementation and managed qualification completed.
