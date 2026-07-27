# Deterministic FEM delta-potential demag research contract

- Status: research contract; production implementation absent
- Owners: Fullmag FEM demag and relaxation maintainers
- Last updated: 2026-07-27
- Related physics notes: `docs/physics/fem_demag_poisson.md`,
  `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md`,
  `docs/physics/0540-fem-demag-multi-model-architecture.md`,
  `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`
- Related specs: `docs/specs/capability-matrix-v0.md`
- Qualification plan:
  `docs/superpowers/plans/2026-07-20-fem-gpu-end-to-end-performance-remediation.md`

## 1. Problem statement

Every FEM direct-minimizer energy evaluation currently starts the Poisson
demagnetization solve from the deterministic zero vector. That policy makes the
Armijo decision independent of rejected trials, but the Poisson solve dominates
the measured FEM GPU step cost. Consecutive accepted and trial magnetization
states are often close, so linearity permits a different research formulation:
retain only the previous accepted endpoint as a base and solve for the potential
change induced by the new trial.

The experiment must not become an ordinary warm start. A Krylov iterate left by
a rejected trial is not an accepted physical state and is never eligible as the
next base. Every reconstructed trial potential is checked against the complete
trial equation, not only the correction equation. A failed check runs a
deterministic fresh-zero solve before any field, energy, Armijo, or stop decision
may use the result.

This note defines a benchmark-only `fresh_delta_correction` research mode. It is
off by default and has no public selector. Production remains fresh-zero unless
the complete promotion matrix in section 8 passes.

The operator/subsystem boundary is the FEM Poisson-airbox demag strategy. The
experiment does not change magnetostatics, the relaxation algorithm, the direct
energy increment, or public execution selection.

## 2. Physical model

### 2.1 Magnetostatic problem

Let the magnetic body be \(\Omega_m\), the shared magnetic-plus-air domain be
\(D\), and its open outer boundary be \(\Gamma_o\). The magnetization is

\[
\mathbf M(\mathbf r)=M_s(\mathbf r)\mathbf m(\mathbf r)
\quad\text{in }\Omega_m,
\qquad \mathbf M=0\quad\text{in }D\setminus\Omega_m.
\]

The scalar potential \(\phi\) and demagnetizing field are defined by

\[
\nabla^2\phi=\nabla\cdot\mathbf M\quad\text{in }D,
\qquad
\mathbf H_d=-\nabla\phi.
\]

For a test function \(v\), the sign convention used by Fullmag is

\[
\int_D \nabla v\cdot\nabla\phi\,dV
+\int_{\Gamma_o}\beta v\phi\,dS
=\int_{\Omega_m}M_s\mathbf m\cdot\nabla v\,dV,
\]

where the Robin term is present only for the Robin airbox realization.
Dirichlet airbox demag instead imposes \(\phi=0\) on the selected essential
outer-boundary degrees of freedom. Static periodic-airbox demag applies the
same statement in the existing reduced periodic scalar space and then lifts the
solution; the correction must use exactly the same reduced operator and gauge
handling as the fresh solve.

After essential elimination or periodic reduction, the discrete problem is

\[
A\phi(\mathbf m)=b(\mathbf m).
\]

The mesh, boundary variant, periodic equivalence classes, material field, and
solver policy fix \(A\). The right-hand side map \(b\) is linear in
\(M_s\mathbf m\).

### 2.2 Delta-potential derivation

Let \(\mathbf m_k\) be the last accepted endpoint and
\(\mathbf m_t\) a trial state. With one unchanged operator signature,

\[
A\phi_k=b_k=b(\mathbf m_k),
\]

\[
A\,\delta\phi=b_t-b_k
=b(\mathbf m_t)-b(\mathbf m_k),
\]

and

\[
\phi_t=\phi_k+\delta\phi.
\]

In exact arithmetic,

\[
A\phi_t
=A\phi_k+A\delta\phi
=b_k+(b_t-b_k)=b_t.
\]

The method therefore changes only the linear-solve decomposition. It does not
approximate \(\mathbf H_d\), demag energy, or the Armijo condition.

### 2.3 Full-equation residual and prior solve error

The accepted base and correction are numerical solutions. Define their signed
algebraic errors by

\[
e_k=A\widehat\phi_k-b_k,
\qquad
e_\delta=A\widehat{\delta\phi}-(b_t-b_k).
\]

The reconstructed trial residual is

\[
r_t=A(\widehat\phi_k+\widehat{\delta\phi})-b_t
=e_k+e_\delta.
\]

Checking only the correction residual can therefore hide accumulated base
error. Every correction must independently evaluate the full residual

\[
\rho_t=
\begin{cases}
\lVert r_t\rVert_2/\lVert b_t\rVert_2,&\lVert b_t\rVert_2>0,\\
\lVert r_t\rVert_2,&\lVert b_t\rVert_2=0.
\end{cases}
\]

The research threshold is the same resolved fail-closed residual contract used
by the corresponding fresh solve; direct minimizers additionally retain their
qualified \(10^{-12}\) maximum relative tolerance in double precision. An
absolute tolerance, when explicitly configured, is checked by the existing
linear-solve policy as well. The threshold is not loosened to make delta
correction pass.

If \(\rho_t\) is non-finite or exceeds the threshold, the trial potential is
discarded and the backend solves \(A\phi_t=b_t\) from an exact zero iterate.
That fallback is deterministic, increments a dedicated counter, and must pass
the ordinary full fresh-solve validation. Failure of the fallback is a backend
error; no stale or approximate field is published.

### 2.4 Energy and observables

The reconstructed or fallback potential is recovered through the unchanged
field operator:

\[
\mathbf H_{d,t}=-\nabla\phi_t.
\]

Demag energy remains

\[
E_{d,t}=-\frac{\mu_0}{2}
\int_{\Omega_m}M_s\mathbf m_t\cdot\mathbf H_{d,t}\,dV,
\]

with the existing Robin boundary contribution. Direct-minimizer Armijo uses
the existing polarized demag increment and complete interaction-owned energy
increment. Delta correction supplies an endpoint field; it does not change the
strict Armijo inequality, roundoff interval, refinement path, stop criteria, or
accepted energy ownership.

### 2.5 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| \(\mathbf m\) | normalized magnetization direction | `1` |
| \(M_s\) | saturation magnetization | `A/m` |
| \(\mathbf M\) | magnetization | `A/m` |
| \(\phi,\delta\phi\) | scalar magnetic potential and correction | `A` |
| \(\mathbf H_d\) | demagnetizing field | `A/m` |
| \(A\) | boundary-conditioned discrete Poisson operator | implementation-scaled linear operator |
| \(b,\delta b\) | discrete magnetic source and correction source | same discrete unit as \(A\phi\) |
| \(r,e\) | algebraic residual/error vectors | same discrete unit as \(b\) |
| \(\rho\) | normalized full-equation residual | `1` |
| \(E_d\) | demagnetization energy | `J` |
| \(\mu_0\) | vacuum permeability | `N/A^2` |
| \(\beta\) | Robin open-boundary coefficient | `1/m` |

The assembled vector entries include FEM basis-function and integration
scales. Their raw entry unit is intentionally not a public observable; residual
comparison uses the dimensionless normalized norm plus the existing optional
absolute solver tolerance.

### 2.6 Assumptions and validity limits

- The operator signature is unchanged between accepted base and trial. Mesh,
  finite-element order, boundary realization, periodic reduction, material
  ownership, and essential degrees of freedom are part of that signature.
- The source map is linear in the current magnetization for fixed \(M_s\).
- Only P1 double-precision `device_hypre_poisson` is in the initial research
  scope. No FP32 claim is made.
- The accepted base must itself have passed the complete fresh-equation
  residual contract.
- A trial solve becoming numerically available is not evidence that the trial
  was accepted.
- Operator changes, remeshing, stage reset, cancellation, backend reset, or a
  missing accepted base invalidate all correction state and require fresh-zero.
- The formulation is not a substitute for airbox or mesh convergence.

## 3. Accepted-base ownership and rejection semantics

The state machine has three logical records:

1. `accepted_base`: accepted generation, operator signature, accepted
   magnetization source, accepted potential, and its certified full residual;
2. `trial_candidate`: trial generation, reconstructed potential, full residual,
   correction iterations, and whether fresh fallback was used;
3. counters: correction attempts/iterations, full-residual checks, fresh
   fallbacks, and total physical demag solves.

Only an explicit accepted-step transition may promote `trial_candidate` to
`accepted_base`. Rejection, backtracking, line-search refinement, solver error,
or cancellation discards the candidate and leaves the accepted base bytewise
unchanged. A later trial always computes
`b(later_trial)-b(accepted_base)`, never a delta from the rejected trial.

The accepted generation must advance monotonically by the relaxation owner. A
candidate from generation \(k\) can be promoted only when the relaxation state
reports that exact candidate as the accepted endpoint for generation \(k+1\).
Pointer reuse, solver completion, or observing a different magnetization buffer
is not an acceptance signal.

The deterministic reset path clears base and candidate ownership, zeroes the
Hypre initial vector, and leaves the next evaluation on the ordinary fresh-zero
path. Rollback restores both physical device state and delta-potential ownership
metadata.

## 4. Numerical interpretation

### 4.1 FDM

No FDM implementation or behavior changes. FFT demag has a different operator
realization and is outside this experiment.

### 4.2 FEM CPU

The production CPU/MFEM lane remains fresh-zero and is the trajectory and
energy oracle. A manufactured CPU linear-algebra oracle may evaluate the same
\(A\phi_k\), \(A\delta\phi\), and full-residual identities for validation, but
the research task does not add a CPU runtime selector or warm-start policy.

### 4.3 FEM GPU

The research realization belongs under
`backends/fem/gpu/cuda/demag_poisson/`. It reuses the already assembled
boundary-conditioned Hypre operator and source/recovery operators. The accepted
base, correction, reconstruction, full-residual certification, and fallback
stay in double precision on the strict device Poisson path.

The mode is compiled only as benchmark research support, defaults off, and is
enabled only by the managed qualification harness. It is not selected by the
Python DSL, ProblemIR, planner, public environment hints, or normal runtime
defaults. Strict GPU residency and transfer-audit rules remain unchanged.

### 4.4 Hybrid

`hybrid_cpu_poisson` is outside the experiment. No hidden CPU fallback is
allowed. The only fallback is a fresh-zero solve in the same requested strict
GPU realization.

## 5. Boundary conditions and operator signature

The correction and fresh equations must use the same \(A\):

- Dirichlet: the correction has homogeneous zero values on the same essential
  true degrees of freedom because both endpoint potentials satisfy the same
  boundary value;
- Robin: the same \(\beta\) and boundary mass form remain in \(A\); no boundary
  term is omitted from the full residual or energy recovery;
- periodic-airbox: the same periodic reduction, representative mapping,
  essential/open-boundary treatment, and lift are used for base and correction.

The operator signature includes at least mesh identity, row/column structure,
coefficient values, FE order, boundary variant and parameters, periodic mapping,
essential true-DOF set, and resolved linear-solver/preconditioner policy.
Signature mismatch invalidates the base before any correction is attempted.

## 6. API, IR, planner, runtime, and workspace impact

### 6.1 Python API and UI round trip

Impact in research: **none**. `Demag()` and `Relaxation(...)` do not gain a
selector. Python export and Control Room authoring remain unchanged.

### 6.2 ProblemIR

Impact in research: **none**. Delta correction is not physical problem intent
and is not serialized into canonical IR.

### 6.3 Planner and capability matrix

Impact in research: **none**. No capability becomes advertised or legal because
the prototype compiles. The existing `device_hypre_poisson` capability and its
validation status remain unchanged.

### 6.4 Runtime and provenance

Normal runtime impact: **none**. Qualification artifacts must record:

- source and managed runtime identities;
- GPU identity and native library hashes;
- immutable ProblemIR and solver-mesh identities;
- boundary variant, airbox factor, resolved demag/AMG policy and tolerances;
- algorithm, repeat index, stop reason, accepted steps, backtracks, and
  rejection cases;
- mode (`fresh_zero` or research `fresh_delta_correction`);
- correction attempts and iterations, full-residual maximum/trajectory,
  fallback count, total demag solves, and time to the identical torque
  tolerance.

If promoted later, the effective internal policy and counters require a
versioned native/runtime provenance design before production wiring. That design
is intentionally deferred until after qualification.

### 6.5 OpenAPI and unified workspace

Impact in research: **none**. No resource, command, quantity, chart, ribbon,
viewport, inspector, or generated type changes.

## 7. Validation strategy

### 7.1 Manufactured linear-system oracle

Use deterministic symmetric positive-definite matrices with manufactured
\(\phi_k\) and \(\phi_t\). Construct \(b_k=A\phi_k\) and
\(b_t=A\phi_t\), solve fresh and by correction, and check:

- trial potential, full residual, recovered linear observable, and quadratic
  energy agree within declared double-precision tolerances;
- injected base error appears in the full residual as \(e_k+e_\delta\);
- a threshold violation deterministically selects fresh-zero and increments one
  fallback;
- repeated execution produces identical branch decisions and counters.

### 7.2 Relaxation determinism oracle

For PG-BB and NCG fixtures, compare fresh-zero and correction lanes at every
attempt. The exact accepted/rejected Armijo sequence, backtrack count, accepted
step sequence, stop reason, and convergence status must match. Energies, torque,
norm defect, and final magnetization must remain within the existing CPU/GPU
consistency contract. Include an explicit rejection where a completed rejected
candidate is followed by another trial and assert that the second correction
uses the unchanged accepted base.

### 7.3 Mesh and airbox convergence

Run the versioned Task 0 coarse, medium, and fine meshes and vary the airbox
extent with otherwise identical physics. Both fresh and correction modes must
preserve:

- finite, converged Poisson residuals;
- the same solver-mesh identity inside each pair;
- monotone or contract-bounded convergence of demag energy/field observables;
- the existing airbox-convergence acceptance rule;
- no growth of full residual with accepted-step count or backtracking depth.

### 7.4 Managed qualification matrix

The matrix uses one warm-up and five measured repeats for each exact case:

- three versioned mesh sizes;
- required airbox factors;
- CPU fresh-zero oracle and strict GPU fresh-zero/correction pairs;
- PG-BB and NCG;
- ordinary trajectories plus forced backtracking/rejection fixtures;
- identical ProblemIR, stop criteria, torque target, resolved Task 9/14 AMG
  policy, and runtime identity.

Persist correction iterations, fallback count, total demag solves, Poisson
phase timings, accepted steps, rejected attempts, and time to tolerance. Report
p50 and p95 distributions, not only averages.

## 8. Promotion and no-go gates

Promotion is allowed only when every gate passes:

1. all manufactured solutions and full-residual checks pass;
2. the accepted base is never derived from a rejected trial;
3. PG-BB and NCG produce identical Armijo accept/reject decisions, backtrack
   counts, accepted-step sequence, stop reason, and convergence status;
4. energy, torque, norm defect, final magnetization, and CPU/GPU parity remain
   within the existing strict contracts;
5. no non-finite residual and no residual accumulation across accepted steps,
   mesh refinement, or rejection depth;
6. every threshold breach falls back deterministically to same-lane fresh-zero
   and the fallback result passes the ordinary solver contract;
7. strict GPU residency, transfer, solver-policy, and fail-closed gates pass;
8. mesh and airbox convergence are no worse than fresh-zero;
9. time to the identical torque tolerance improves by at least 10% on the
   applicable aggregate objective;
10. every applicable per-case p50 and p95 no-regression gate passes, including
    end-to-end and demag-apply distributions;
11. the independent accepted-baseline performance regression passes or is
    explicitly shown to be a pre-existing accepted-baseline failure with no new
    regression. A pre-existing failure still blocks promotion.

An implementation that saves individual Poisson iterations but does not reduce
time to the same physical tolerance is a no-go.

On no-go, remove the prototype implementation, CMake/runtime selection, feature
switches, and normal-tree policy wiring. Retain only this note, the smallest
oracle/fixture needed to reproduce the result, and the qualification audit. Do
not weaken tolerances, change Armijo ownership, update the accepted performance
baseline, or expose an experimental production selector to manufacture a pass.

## 9. Completeness checklist

- [x] Physical problem, governing equations, signs, units, and BCs documented
- [x] Delta equation, full residual, and prior-solve error derived
- [x] Accepted-base and rejected-trial ownership specified
- [x] CPU/GPU/FDM/hybrid interpretations specified
- [x] Research API and ProblemIR impact explicitly `none`
- [x] Planner, runtime, provenance, OpenAPI, and workspace impact specified
- [x] Manufactured, determinism, mesh, airbox, and performance gates specified
- [ ] Research prototype implemented and RED/GREEN evidence captured
- [ ] Managed qualification matrix executed
- [ ] Promotion or no-go audit published
- [ ] Production wiring (permitted only after every promotion gate passes)

## 10. Known limits and deferred work

- The research scope is P1, double precision, strict GPU Poisson airbox demag.
- No claim is made for FEM/BEM, FMM, mapped exterior shells, FP32, high order,
  or fully periodic 3D.
- Production provenance and policy selection are deliberately deferred until a
  successful qualification.
- A future attempt after no-go must start from a new identity-pinned full matrix;
  it cannot reuse timing or runtime identity from this experiment.

## 11. References

- `docs/physics/fem_demag_poisson.md`
- `docs/physics/0540-fem-demag-multi-model-architecture.md`
- `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`
- `docs/audits/2026-07-20-fem-gpu-solver-performance-audit.md`
- `docs/audits/2026-07-20-fem-amg-relax-policy-qualification.md`
- `docs/audits/2026-07-20-fem-amg-coarse-strategy-qualification.md`
