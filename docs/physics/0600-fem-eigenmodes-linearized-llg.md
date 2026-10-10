# 0600. FEM Eigenmodes from Linearized LLG

Status: MVP public reference path  
Applies to: `StudyIR::Eigenmodes`, `BackendPlanIR::FemEigen`, CPU reference runner

This note covers the `modal_eigen` study product only. Driven harmonic solves
belong to the separate `driven_response` product and use `(i omega B - A) q = b`
rather than the modal generalized eigensystem `A q = lambda B q`.

The canonical backend-neutral `L`/`B_alpha`/`A_omega` dictionary, typed units,
eigenvalue mapping, residual rules, and truthful CPU/GPU lane names are frozen
in `0831-fem-dynamic-pencil-modal-response-and-krylov.md`. This note retains the
public reference workflow and must not redefine that contract.

## Scope

This note defines the first executable FEM eigenmode workflow in Fullmag.
It is intentionally narrower than the long-term MFEM/SLEPc target:

- equilibrium state `m0` is taken from the provided initial state, a saved artifact, or an accepted upstream relaxation-stage handoff,
- a relaxed-initial-state k path reuses one immutable accepted relaxation handoff at every sample; the eigen path does not run its own overdamped relaxation,
- the eigenproblem is solved on the merged FEM magnetic mesh,
- the current executable path exports spectrum, mode fields, and V2 dispersion artifacts,
- the solver is CPU reference quality, not the final production eigensolver.

The production target for large geometries is not the dense reference solver.
Large FEM eigenmode studies must be formulated as sparse frequency-window
queries: for example, "return up to 20 modes in 100 MHz..5 GHz".  The public
authoring contract must therefore preserve both the requested mode count and
the requested frequency interval in SI units.  The backend may use a wider
internal search interval for robustness, but artifacts and provenance must
report the user-requested window and the resolved numerical search policy.

## Physical model

We linearize magnetization dynamics around an equilibrium state `m0(r)` with `|m0| = 1`:

`m(r, t) = m0(r) + dm(r, t)`

with the tangent-space constraint:

`m0 . dm = 0`

For the MVP, Fullmag constructs a local tangent basis `(e1, e2)` at each active FEM node and represents perturbations in that reduced basis. This avoids the non-physical radial component that would appear in an unconstrained `3N` formulation.

The executable reference path currently retains the following field contributions:

- exchange
- demag
- zeeman / external field
- uniaxial anisotropy (first- and second-order)
- cubic anisotropy (first-order)
- interfacial DMI
- bulk DMI
- surface anisotropy (boundary-face mass term)

Spin torques and Bloch-periodic complex operators remain future work.

## Operator variants

Two operator formulations are available (selected via `EigenOperatorIR`):

### Scalar projected operator (`LinearizedLlg`)

The default and historically first path. The perturbation at each node is
represented by a single scalar amplitude in a local e1 tangent direction.
This yields an `N × N` generalized eigenproblem and is accurate when the
equilibrium is approximately uniform.

### Full 2×2 Herring–Kittel block operator (`Full2x2`)

The full tangent-plane formulation. At each node the perturbation is
represented by two scalar amplitudes `(u1, u2)` in the `(e1, e2)` tangent
basis, yielding a `2N × 2N` generalized eigenproblem. This correctly
captures cross-coupling between tangent-plane components and is required
for non-uniform equilibria (vortices, skyrmions, domain walls).

See `docs/physics/0600-fem-eigenmodes.md` for the block-matrix equations.

## Discrete operator

The current dense/reference solver assembles:

- a consistent scalar mass matrix on the active FEM nodes,
- a projected scalar stiffness-like operator built from exchange plus the field component parallel to `m0`,
- a tangent-basis lift from reduced nodal amplitudes back to vector mode fields.

This is an MVP reference generalized eigenproblem:

`K u = lambda M u`

followed by a frequency mapping:

`omega = gamma * mu0 * max(lambda, 0)`

`f = omega / (2 pi)`

Fullmag's public `gamma` parameter is the internal LLG constant
`gamma0 = mu0 * gamma_SI` with units `rad s^-1 (A/m)^-1`, historically also
written as `m/(A s)`. Therefore frequency artifacts must report both constants:
`gamma0_rad_s_per_A_m = gamma0` and `gamma_rad_s_T = gamma0 / mu0`. The
frequency mapping above is equivalently `omega = gamma0 * max(lambda, 0)` when
`lambda` is an effective-field eigenvalue in `A/m`.

This real symmetric reference problem is not the production gyrotropic modal
contract for general frequency-domain FEM. It is valid only as a small
effective-field/reference lane for the explicitly documented MVP scope. The
production modal/eigenfrequency contract must use the tangent LLG convention
from `docs/physics/0700-frequency-domain-linearized-llg.md`:

```text
L q = lambda B_alpha q
lambda = i omega
```

or, for an energy-Hessian gyrotropic form with the canonical
`exp(i omega t)` phasor:

```text
K phi = -i omega G phi
G_t(p, q) = integral (mu0 * Ms / gamma0) * eta dot (m0 x xi) dV
```

The documentation must not promote a real pencil `K phi = omega G phi` unless
the operator has been explicitly transformed into a real Hamiltonian or
symplectic form and the transform, signs, norm, and eigenvalue-to-frequency
mapping are stated. Before SLEPc/shift-invert promotion, a 2-DOF macrospin test
without MFEM must prove:

- undamped sign and magnitude `omega = gamma0 * H0`,
- the positive-frequency branch,
- the conjugate partner,
- residual consistency for the selected pencil,
- damping sign and linewidth mapping when damping is included.

## Nonzero-k Floquet dynamic demag-k payload boundary

For native FEM CPU admission, the existing Rust convention is the componentwise bound below. The selected vector must contain exactly three finite components.

```{math}
:label: eq-0600-floquet-gamma-admission
\operatorname{class}_{\Gamma}(\mathbf{k}) =
\begin{cases}
\mathrm{invalid}, & \exists i \in \{x,y,z\}: \neg \operatorname{finite}(k_i),\\
\Gamma, & \max_{i \in \{x,y,z\}} |k_i| \le \varepsilon_{\Gamma,\mathrm{comp}},\\
\mathrm{nonzero}, & \max_{i \in \{x,y,z\}} |k_i| > \varepsilon_{\Gamma,\mathrm{comp}},
\end{cases}
\qquad
\varepsilon_{\Gamma,\mathrm{comp}} = 10^{-12}\,\mathrm{rad\,m^{-1}}.
```

Here $i$ indexes $x$, $y$, and $z$; $\operatorname{finite}$ tests one IEEE floating-point component, and $\max$ takes the largest component magnitude. The boundary is closed, so both signed values at the threshold classify as $\Gamma$. Three components each below the threshold remain $\Gamma$ even when their Euclidean norm exceeds the threshold.

Payload selection retains the existing request contract: a nonnull raw pointer with a positive length takes precedence; a null pointer or nonpositive raw length uses the declared fixed-size vector when present. A selected vector with the wrong length or a nonfinite component is invalid and cannot fall back. Where the legacy request permits an omitted vector, that omission retains implicit $\Gamma$ behavior.

A zero-length raw slice is omitted even when its pointer is nonnull, as can occur for Rust `Some(&[])`; its storage is never dereferenced. If a fixed-size vector is declared, the existing fallback selects it; otherwise the request retains implicit $\Gamma$ behavior.

This threshold controls native CPU admission and routing only. It does not round, replace, or rewrite the requested components in diagnostics or operator inputs. Existing physical squared-wave-number finite and overflow checks continue to use those requested components. The generic Floquet airbox operator remains usable at $\Gamma$; the nonzero-$k$ admission gate does not wrap its mathematical domain.

For a Bloch/Floquet modal problem with nonzero wavevector `k`, the tangent
operator is partitioned as

```text
K_total(k) = K_local_and_exchange(k) + K_demag(k).
```

`K_demag(k)` is the linear dynamic demagnetizing-field contribution evaluated
at the same Bloch wavevector and represented in the same real block form and
local tangent basis as `K_local_and_exchange(k)`. Its matrix entries therefore
carry the same operator units and sign convention as the supplied modal
stiffness matrix; it is added directly before solving
`K_total(k) phi = -i omega G phi`.

The narrow native CPU bridge may consume a caller-supplied dense
`dynamic_demag_k` tangent matrix only when all of the following are true:

- the request is `Full2x2`, nonzero-k, Floquet, and has accepted periodic-pair
  metadata;
- the matrix has exactly `tangent_dof_count^2` finite block-real values;
- the declared payload kind is `dynamic_demag_k_operator`;
- the base Bloch/Floquet stiffness and the demag matrix share the same tangent
  DOF ordering, phase convention `exp(i omega t)`, and periodic-pair map.

This is an explicit operator-input contract for native numerical validation.
It remains separate from the production shared-domain path. The current
sources also contain a native CPU shared-domain Floquet/airbox assembly for
constructing `K_demag(k)` from mesh and airbox data, together with the
real-frequency rotated SLEPc pencil. That implementation is selected only by
the strict planner prerequisites and is still distinct from a qualified
runtime result. Python and `ProblemIR` may express
`magnetostatic_bc="floquet_airbox"`, while unsupported combinations fail in
planning rather than silently falling back; the current snapshot has no
managed or physical qualification for this lane.

Sparse/matrix-free and assembled MFEM dynamic-demag-k operators are therefore
source-visible but not promoted. Promotion still requires solver telemetry,
residual checks, analytical controls, and managed convergence evidence.

For a mixed shared-domain request with an explicit dense descriptor, the
caller-supplied `K`, `G`, and `M` remain the authoritative physical matrices;
the shared-domain provider supplies `K_demag(k)` and retains its scalar-
potential reconstruction blocks for certification of the original coupled
descriptor.
If the provider reduces the magnetic tangent problem to $q_{\mathbb{C}}$
complex degrees of freedom, the caller's dense descriptor uses the doubled
real-split ordering $[\operatorname{Re}(q),\operatorname{Im}(q)]$ and the
dimension below:

```{math}
:label: eq-0600-floquet-mixed-dense-real-split-extent
n_{\mathbb{R}} = 2q_{\mathbb{C}},
\qquad
N_{\mathrm{dense}} = n_{\mathbb{R}}^2 = 4q_{\mathbb{C}}^2.
```

`K`, `G`, `M`, and `K_demag(k)` must use that same $n_{\mathbb{R}}$-dimensional
basis and ordering; `K_demag(k)` also follows the declared phase and sign
convention of the magnetic stiffness. Native admission validates the caller
dimension against the provider's $2q_{\mathbb{C}}$ real-split basis and checks
the provider matrix extent before it attaches `K_demag(k)` or enables potential
reconstruction. A legacy dense descriptor whose declared dimension is only
$q_{\mathbb{C}}$ is a validation error: the implementation does not pad or
reinterpret it and does not replace caller `K`, `G`, or `M` with provider-owned
`A_qq`, `B_qq`, or positive tangent mass. A request without an explicit dense
descriptor retains the separate payload-only sparse shared-domain route.

Validation for this bridge requires a zero-matrix equivalence check, a nonzero
matrix frequency-shift check against the same dense block-real oracle, shape
and finite-value rejection tests, and an explicit planner/runtime gate for
requests whose shared-domain Floquet implementation lacks the required
managed evidence.

## Poisson-airbox `k=0` modal eigensolve implementation

The active implementation contract for full-coupled Poisson-airbox `k=0`
modal eigensolve is:

`docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`.

The earlier plan 18 remains supporting implementation history for the PA-E1
dense full-coupled algebraic oracle and staged CPU/GPU work. Synthetic
Poisson-airbox payloads validate algebra only and cannot carry a production
periodic-airbox claim.

The current native GPU modal exception is narrower: the K0 no-demag macrospin
Kittel field sweep may use `gpu_dense_k0_macrospin_modal_eigen`, where
cuSolverDN solves the dense generalized field problem and the runner maps the
positive field eigenvalue to `lambda = i omega`. This does not implement
nonzero-k Floquet modal GPU, dynamic demag-k, or a broad sparse/matrix-free GPU
modal eigensolver.

The small-reference implementation uses a dense symmetric reduction:

1. Cholesky factorization of `M`
2. transformed symmetric eigen solve
3. back-lift to generalized eigenvectors

This is appropriate for the small reference cases used to validate semantics
and artifacts, but it is not the scalable eigensolver architecture.  The
transitional runner may use sparse LOBPCG for real-valued problems above the
dense threshold, but LOBPCG remains a bridge.  The production FEM eigen backend
must use PETSc/SLEPc-style sparse or matrix-free eigensolvers with spectral
targeting:

- Krylov-Schur, Arnoldi, LOBPCG, Jacobi-Davidson, or equivalent EPS methods for
  exterior modes;
- shift-invert or Cayley spectral transformations for interior modes near a
  target frequency;
- FEAST / contour-integral style interval solvers for frequency-window queries
  when the user asks for modes in a band;
- PETSc/hypre/MFEM linear solves and preconditioners for shifted systems;
- matrix-free `y = A x` operator application whenever assembled matrices would
  dominate memory.

Dense diagonalization is allowed only as a reference/validation lane.  It must
not be marketed as the route for COMSOL-class large-object eigenmode studies.

## Equilibrium handling

`StudyIR::Eigenmodes.equilibrium` supports three sources:

- `provided`
- `artifact`
- `relaxed_initial_state`

For `relaxed_initial_state`, the runner consumes an accepted relaxation-stage handoff. In the staged CLI workflow, the handoff is resolved from a completed and accepted upstream Relax stage and binds its equilibrium, fields, mesh, and static-physics identity. This marker does not ask the eigen runner to perform an inline relaxation. A direct runner call without the accepted handoff fails closed before the eigensolve.

A `KSamplingIR::Path` with `relaxed_initial_state` uses that same accepted `m0`
and handoff for every k sample. The path keeps the declared first point,
including a nonzero first k; it does not insert a Gamma point. The Floquet
reduction and dynamic linearized operator are rebuilt for each sample's k,
while the common equilibrium handoff remains fixed. Each single-k
continuation is accepted only when its artifact reports zero relaxation
steps; the path summary reports zero for its first sample. This records
execution provenance; it does not independently establish physical stationarity.

The current public staged-builder spelling is `study.stages.add_relax(...)`, followed by `study.stages.add_eigenmodes(..., equilibrium_source="relax", k_sampling=fm.KPath(...))`. For example, the current Python constructors are:

```python
study.stages.add_relax(
    stage_id="relax", algorithm="llg_overdamped",
    dt=RELAX_DT_S, relax_alpha=0.5, max_steps=RELAX_MAX_STEPS, tolA=1.0,
).autosave(
    fm.StageAutosave(
        target="results", layout="separate", format="zarr",
        fields=(fm.FieldAutosave("m", every_steps=100),),
    )
)
study.stages.add_eigenmodes(
    equilibrium_source="relax",
    k_sampling=fm.KPath(
        points=[fm.KPoint("K1", (1.0e6, 0.0, 0.0)),
                fm.KPoint("K2", (2.0e6, 0.0, 0.0))],
        samples_per_segment=[1],
    ),
    bc=fm.FloquetBC(["x_faces"],
                    phase_convention="exp_minus_i_k_dot_delta_r"),
)
```

This is a source-level API excerpt matching `StudyStagesBuilder.add_relax`, `KPath`, `KPoint`, `StageAutosave`, and `FloquetBC`; it was not executed or physically qualified for this documentation change. The existing full workflow example is `examples/fem_de_smoke_numeric.py`.


## Candidate construction admission after PETSc GMRES

In the FEM Floquet shifted-KSP path, a successful `KSPBuildSolution` call is not by itself a valid candidate. The live `KSPConvergedReason` must be checked immediately after the build and before any candidate residual probe.

PETSc v3.24.6 documents why: `KSPGMRESBuildSoln` can set `KSP_DIVERGED_BREAKDOWN` and return `PETSC_SUCCESS`, while `KSPBuildSolution_GMRES` returns the builder call status. See the [PETSc 3.24.6 GMRES implementation](https://raw.githubusercontent.com/petsc/petsc/v3.24.6/src/ksp/ksp/impls/gmres/gmres.c#L263-L311) and its [solution-builder wrapper](https://raw.githubusercontent.com/petsc/petsc/v3.24.6/src/ksp/ksp/impls/gmres/gmres.c#L387-L402).

The convergence callback must evaluate `KSPConvergedDefault` into a local reason. PETSc 3.24.6 [KSPBuildSolution](https://raw.githubusercontent.com/petsc/petsc/v3.24.6/src/ksp/ksp/interface/itfunc.c#L2564-L2576) copies the stored solution when the live KSP reason is no longer `KSP_CONVERGED_ITERATING`; writing a provisional positive reason through the callback pointer therefore bypasses construction of the current candidate. The callback publishes a positive reason only after constructing that live candidate and applying the unchanged true-residual gate. The managed failure probe on commit `4fd43b894` recorded positive post-build reason 3 with zero solution/action and nonzero RHS; this identifies the ordering defect rather than the negative-builder path. The corrected callback still requires fresh managed execution.

If the post-build reason is negative, preserve it and leave candidate probes and their norms unavailable; do not run `MatMult` or norm queries for that candidate. Propagate errors from the reason query, and do not issue follow-up queries after a hard error. A measured zero is not a missing-data sentinel: zero right-hand side and zero solution remain legal data. This admission guard does not change residual tolerances or matrix policy.

The standalone zero-operator GMRES test is registered in .github/workflows/shifted-ksp-true-convergence.yml and runs against distro PETSc; the managed Floquet CMake/CTest path is also registered. The standalone workflow [37941002371](https://github.com/MateuszZelent/fullmag/actions/runs/37941002371) passed the real PETSc 3.19.6 regression on commit `4fd43b894ec96c266dbed34a52aa431b46a5c53f`, including the intentional callback exercise against a live failed GMRES solve. The live-candidate regression also passed with managed PETSc 3.24.6 in workflow [37945455810](https://github.com/MateuszZelent/fullmag/actions/runs/37945455810), on commit `39442244cfd3cc4b401251f9bfd574c6cf9647c1`. This qualifies the bounded callback regression in that stack; the full profile still failed its production-provenance and near-pole cases. Neither result qualifies a physical eigenproblem.

## Opt-in evidence for a withheld shifted-KSP candidate

After the live-candidate ordering correction, the managed subwindow-10 probe has a nonzero candidate and a true residual above its requested linear threshold. This is not evidence for lowering that threshold. Additional measurements are opt-in through the existing Schur-action/dense-oracle diagnostics and are bounded to at most 512 real-split magnetic and 512 real-split potential coordinates.

Capture is attached immediately after the successful true-probe `MatMult` and before its action vector is changed into `b-Ax`. Its callback ordinal and iteration must match that exact true probe. First read the actual production Poisson RHS and potential, measuring the algebraic residual `P phi - rhs_phi`, where production already uses `rhs_phi = -A_phiq q`. This adds no production Poisson solve. Compare that candidate's shifted action with an already materialized exact shifted matrix only when available, undoing its separate normalization by dividing by the recorded preconditioner normalization scale.

Replay and additivity use an isolated diagnostic workspace and its own identically configured PREONLY/LU, MAT_SHIFT_NONE Poisson solver; they must not reuse the production Poisson KSP, mutate its work vectors or error buffer, alter convergence reasons, poll cancellation or feed the gate. Production-versus-isolated replay and isolated repeatability are distinct measurements; equality on one candidate does not prove global operator equality. Setup/capture failures have explicit availability/error fields. Scratch teardown failure is a separate operational safety failure: preserve the callback/observer owner and quarantine its graph. Keep any earlier KSP/EPS hard reason; if teardown is the first failure after a physically accepted solve, report an explicit diagnostic-cleanup solve error and clear canonical accepted outputs. This does not change the physical residual gate or its convergence reason. The callback and bounded scratch share the convergence-context owner and remain retained with an unsafe EPS graph; later failure JSON is cache-only and performs no PETSc queries after a hard solver error.

The existing dense oracle also records up to four raw/rotated eigenvalue entries and complex spectral distances from the shift before positivity/window filtering, with actual count and truncation explicit. Distance is the Euclidean norm of the rotated real offset and imaginary component, reported in rad/s and divided by 2 pi in Hz; it is not only the real-axis frequency offset. It describes the nearby spectrum, not the identity of the failing Krylov candidate. These measurements do not change physics, solver policy, tolerances, windows or fallback. Their implementation and actual managed execution remain **NOT VERIFIED** until the corresponding sources and named evidence are available.

## Cancellation at the EPS stopping boundary

The native Floquet EPS stopping callback preserves errors from `EPSStoppingBasic` and negative EPS divergence reasons. For an iterating or successfully converged iteration, it polls the explicit cancellation callback before admitting completion. An observed request records `EPS_CONVERGED_USER` and the terminal `cancelled` result, including when the request is visible only on the final successful iteration. The existing post-solve cancellation check remains a separate safeguard; a post-solve poll alone does not prove that EPS stopped with `EPS_CONVERGED_USER`.

This control-plane priority does not change the eigenproblem, residual gates, Krylov dimensions or iteration budgets. The persistent and one-shot real EPS regressions both require the user stop reason. Execution of the corrected stopping callback remains **NOT VERIFIED** until the managed Floquet CI reports those assertions passing.

## PETSc/SLEPc process runtime boundary

FEM CPU and FEM GPU modal calls share PETSc/SLEPc process state. The implementation contract in [ADR 0055](../adr/0055-petsc-slepc-process-serialization.md) requires one nonrecursive operation boundary across Gamma, Floquet, Poisson-airbox modal families, sparse-direct and GPU initialization/finalization. PA-E3 subwindows borrow the active operator under their outer boundary; they must not acquire a second lock.

An owned runtime shutdown is terminal. After `PetscFinalized`, entrypoints must reject use instead of relying on an initialization flag or attempting reinitialization. Externally initialized runtime is not finalized by Fullmag. An unsafe retained PETSc graph quarantines the shared runtime: owned GPU finalization must fail closed rather than finalize underneath those graph references. A healthy reusable CPU Floquet context also fences global finalization while its PETSc graph remains alive between solves. Its cleanup runs under the process boundary. GPU cleanup checks `PetscFinalized` before destroying any cached PETSc object, including externally initialized runtime and exit callbacks; query failure or an already finalized runtime leaves those handles untouched. This ownership policy changes no eigenproblem, normalization, residual gate or lane resolution. The shared owner source and six lane bindings passed independent source review. A managed CTest contract is prepared for real Gamma/Floquet entrypoints with `MPI_THREAD_SERIALIZED`, sequential-versus-concurrent frequency/residual checks and fail-closed use after finalization. Workflow [37959833852](https://github.com/MateuszZelent/fullmag/actions/runs/37959833852) on commit `bee2ef37b7e6e310fa91c8467012b9c2d1a444e3` passed the bounded actual Gamma/Floquet concurrency contract and the real KSP regression; the full profile had two passing and two failing tests. PA-E3 recursion, GPU execution and broader MPI initialization remain separate **NOT VERIFIED** gates. Global quarantine must also refuse every new entry before any PETSc query, under the same process owner. The additional pre-initialization cross-family refusal and isolated terminal-failure processes are registered for hosted execution, not yet runtime-qualified.

## Normalization and modal fields

The runner currently supports:

- `unit_l2`
- `unit_max_amplitude`

Mode artifacts export:

- `real`
- `imag`
- `amplitude`
- `phase`

The current circular polarization export is a tangent-basis reconstruction convenience for visualization. It should be treated as a reference visualization product contract, not yet as a full non-Hermitian modal analysis package.

## Branch identity at crossings and degeneracies

`KSamplingIR::Path` solves each sample independently, so the order and phase
of eigenvectors returned by a solver are not branch identity.  The tracker
compares only modes represented in the same active magnetic FEM basis.  The
mass weights are the positive per-node FE weights supplied with the reduced
vectors; they are applied to every Cartesian component at that node.  Airbox
degrees of freedom and vectors on a different mesh are not part of this
metric.

A `bias_field_sweep` with `KSamplingIR::Single([0,0,0])` also uses this
tracker, with the ordered physical bias-field samples as its continuation
axis.  Each field value is solved independently at Gamma; mode order and phase
from the eigensolver do not identify a branch across field values.  The public
IR planner currently requires the exact zero vector for this sweep.  The
internal sample descriptor and published spectrum/mode/branch metadata retain
the declared `k_vector`, while published samples also retain their declared
`external_field_a_per_m` and sample identity.  This does not author or imply a
k path.  Branch selection is applied after tracking the accepted samples, so
a selected branch can refer to different raw mode indices at different field
values.  Ordinary Gamma solves without a bias-field sweep do not acquire
branch tracking from this rule.  An explicit dispersion request or eigen
diagnostics that request tracking or overlaps uses the same physical-field
tracking axis.

The single-field publisher retains candidate vectors internally so the shared
mass-metric tracker can compare all accepted modes.  These tracking candidates
are not all public outputs: the requested mode/branch selector is applied
after tracking, and only selected spectrum rows, requested diagnostic records,
and requested field or potential artifacts are retained for publication.  On
cancellation, pause, or failure, branch tracking and selection apply to the
completed accepted prefix that the sweep merger already publishes; the
interrupted terminal sample does not become a branch point.  This preserves
the existing terminal-prefix contract and does not define a resume policy.

For a reduced vector $v$, the internal mass-normalized representation is

```{math}
:label: eq-eigenmode-branch-mass-normalization
\widetilde v = \frac{M^{1/2}v}{\lVert M^{1/2}v\rVert_2},
\qquad
M=\operatorname{diag}(w_1,w_1,w_1,\ldots,w_n,w_n,w_n),
\qquad w_i>0.
```

The implementation orthonormalizes each previous and current candidate group
in this metric.  If $U$ and $V$ are the resulting bases of the same rank
$r$, it computes

```{math}
:label: eq-eigenmode-branch-principal-angles
C=U^\ast V=P\,\Sigma\,Q^\ast,
\qquad
\cos\theta_j=\sigma_j(C),
\qquad
s_{\mathrm{sub}}=\min_{1\leq j\leq r}\cos\theta_j .
```

The minimum principal-angle cosine is the geometric continuity criterion; a
single raw-vector overlap is not used to certify a degenerate group.  The
Procrustes transport

```{math}
:label: eq-eigenmode-branch-procrustes-transport
R=Q P^\ast,
\qquad
V R\ \text{is the current basis transported closest to }U,
```

provides a private frame for the next path sample.  A Hungarian assignment on
$|R_{ij}|$ gives stable raw-mode slots for the next step.  Individual labels
inside a degenerate subspace remain gauge-dependent; the published branch
point therefore leaves `overlap_prev` empty for a subspace edge and keeps the
subspace decision in the internal confidence/diagnostic path until the V2
artifact extension defines explicit principal-angle fields.

The tracker forms candidate groups from numerical complex-frequency proximity,
not a physical degeneracy classification.  With real and imaginary
frequencies in Hz, the current private policy is

```{math}
:label: eq-eigenmode-branch-degeneracy-policy
\delta_f=
\sqrt{(f_r-f'_r)^2+(f_i-f'_i)^2}
\leq
10^{-6}\,\mathrm{Hz}
 +10^{-4}\max\!\left(
 \sqrt{f_r^2+f_i^2},
 \sqrt{(f'_r)^2+(f'_i)^2},
 1\,\mathrm{Hz}\right).
```

The relative term is about 1 MHz at 10 GHz, in addition to the 1e-6 Hz
absolute term.  This numerical heuristic can therefore group physically
distinct nearby bands; it does not establish physical degeneracy.  It remains
private while the versioned IR/artifact contract has no authored tolerance.
The independent replay description in
`docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md` uses the
same anchored complex-frequency policy.  Replay and the source-level
regression do not qualify its scientific use; qualification remains
NOT VERIFIED.

A candidate group at a split transition still requires the mass-weighted
principal-angle test.  That test measures geometric continuity between
candidate subspaces; it does not prove physical degeneracy.  An ambiguous
boundary, unequal rank, invalid vector, mismatched positive mass diagonal,
or different last sample causes the candidate to be rejected and leaves
ordinary overlap matching or branch restart in control.

The present implementation is scoped to right eigenvectors in a common FEM
coordinate basis.  It is phase-invariant and can transport a rotated basis,
but it does not yet remove a known Bloch envelope phase before comparison and
does not claim a left/right biorthogonal metric for strongly non-Hermitian
damped pencils.  Those cases require explicit phase-frame and left/right
fields in a later versioned contract.

The numerical owner is
`crates/fullmag-runner/src/eigen/tracking_subspace.rs::mass_weighted_subspace_transport`;
assignment and restart policy remain in
`crates/fullmag-runner/src/eigen/tracking.rs::track_branches`.  Regression
coverage includes rotated mass-weighted degenerate bases,
split–degenerate–split crossings, unequal-rank rejection, and rejection of
frames retained from different last samples in
`crates/fullmag-runner/src/eigen/tracking.rs::tests`.
The bias-field adapter is owned by
`crates/fullmag-runner/src/fem/eigen_path.rs::track_bias_field_sweep_samples`,
and the accepted-prefix publication boundary by
`crates/fullmag-runner/src/fem/eigen_sweep.rs::execute_bias_field_sweep_with_publication`.
Their source-level regression must exercise the native single-sample publisher,
the shared artifact parser, tracking, branch selection, and final sweep writer;
hosted verification remains pending until the required CI lane runs.

## Artifact contract

The runner writes:

- `eigen/spectrum.v2.json`
- `eigen/branches.v2.json` when branch tracking is available
- `eigen/dispersion.csv`
- `eigen/spectrum.json`
- `eigen/modes/mode_XXXX.json`
- `eigen/dispersion/branch_table.csv`
- `eigen/dispersion/path.json`
- `eigen/metadata/eigen_summary.json`
- `eigen/metadata/normalization.json`
- `eigen/metadata/equilibrium_source.json`

The V2 artifact contract is defined in
`docs/specs/frequency-domain-artifacts-v2.md`. These artifacts are consumed by
the Analyze UI and by the v2 API resources under
`/v2/sessions/current/analysis/eigen/*`.

Production-scale artifacts must additionally record the spectral search
contract:

- requested frequency window in Hz (`frequency_min_hz`, `frequency_max_hz`);
- requested mode cap (`count`);
- resolved eigensolver family (`krylov_schur`, `lobpcg`, `jacobi_davidson`,
  `feast`, `shift_invert`, or equivalent);
- spectral transform and shift/window actually used;
- linear solver and preconditioner used by shifted systems;
- residual tolerance, maximum iterations, converged mode count, and final
  residuals;
- whether modes outside the requested window were computed only as internal
  guard modes and filtered before publication.

## Production large-object solver requirement

For large structures, the correct user-level question is not "compute the first
N eigenvectors of the full dense operator".  It is:

```python
study.stages.add_eigenmodes(
    count=20,
    target="frequency_window",
    frequency_min=100e6,
    frequency_max=5e9,
    equilibrium_source="relax",
)
```

The SI contract is:

- `frequency_min` and `frequency_max` are in Hz;
- both bounds must be finite and positive;
- `frequency_min < frequency_max`;
- `count` is a maximum number of accepted modes returned from that window;
- if fewer modes exist in the interval, the solver returns fewer modes and
  reports `stop_reason="window_exhausted"`;
- if the iteration cap or tolerance stops the solve first, the solver reports a
  partial result with residual diagnostics instead of pretending success.

Dispersion validation should mirror the common experimental/theoretical workflow
instead of defaulting to an exhaustive sweep over every k direction. Production
acceptance must include narrow one-dimensional film sweeps in both standard
geometries:

- Damon-Eshbach (DE): in-plane `k` perpendicular to the equilibrium
  magnetization;
- backward-volume (BV): in-plane `k` parallel to the equilibrium magnetization.

Domyślny preset `ThinFilmDEBVDispersionValidation` zachowuje
`max_k_rad_per_m=3e6` i `frequency_window_hz=(0, 5e9)` w jednostkach SI.
Nie są to uniwersalne granice fizyczne modelu. Użytkownik może podać dowolne
skończone dodatnie maksimum wektora falowego oraz skończone, uporządkowane
okno częstotliwości z nieujemnym minimum. Oba parametry przechodzą bez
zmiany do `runtime_metadata.dispersion_validation` i planu FEM.

To rozróżnienie jest istotne dla benchmarku C1: jego zakres nie mieści się w
historycznym presecie. Dla filmu o okresie $a=200\,\mathrm{nm}$ używa się
`max_k_rad_per_m=pi/(200e-9)` oraz okna obejmującego co najmniej
$0$--$15\,\mathrm{GHz}$;
wartości te muszą być jawnie podane w konfiguracji benchmarku. C0 z wyłączonym
dynamicznym demagiem jest osobnym testem kontrolnym i nie dowodzi zgodności
operatora demagnetyzacji dla C1.

Porównanie KS n=0 dotyczy jednorodnej warstwy, równowagi w płaszczyźnie,
modu podstawowego o prawie jednorodnym profilu po grubości oraz odpowiedniej
orientacji BV lub DE. Walidator wymaga dodatniej zgodności kierunku pola z
magnetyzacją i odrzuca niezerowe DMI, anizotropię oraz niejednorodne Ms/A,
których ta postać wzoru nie zawiera. Nie kwalifikuje antydotów, modów wyższych ani dowolnie
grubych warstw. Zakres zależy od grubości, materiału, pola i hybrydyzacji modów;
samo zaakceptowanie parametrów przez planner nie dowodzi stosowalności.
Wymagane są zgodność częstości z zadanym `max_relative_error`, kontrola profilu
modu oraz zbieżność siatki i zewnętrznej granicy magnetostatycznej.
Przykład `examples/fem_eigenmodes_dispersion_de_bv_low_k.py` ma film
20 nm i po 2 mikrometry powietrza z obu stron (domena 4.02 mikrometra).
Poprzednia domena 40 nm dawała po 10 nm powietrza i silnie zmieniała kontrolę
Gamma z granicą Dirichleta. Większy odstęp zmniejsza ten błąd brzegowy,
lecz nie zastępuje numerycznego sprawdzenia zbieżności.

Skończony airbox należy porównywać z odpowiednią korektą lub granicą zbieżności,
a nie utożsamiać z otwartą przestrzenią. Dla C1 grubość wynosi 10 nm,
maksimum na odcinku Gamma-X wynosi pi/(200 nm), a okno musi obejmować
częstość Kittela około 9.31 GHz. Odcinki ukośne wymagają osobnego modelu
kątowego; nie wolno oznaczać ich jako BV albo DE.

Dlatego trzy liczby widoczne na wykresach nie są zamienne: kontrola C0 bez
demagu ma około $2.800264\,\mathrm{GHz}$, analityczna granica otwartego filmu
C1 w punkcie $\Gamma$ ma około $9.309814\,\mathrm{GHz}$, a wstępny natywny
solve C1 z periodycznym airboxem dał $8.906582\,\mathrm{GHz}$. Ta ostatnia
wartość pochodzi z diagnostycznej siatki 391-węzłowej z jednym elementem po
grubości i około $1\,\mu\mathrm{m}$ powietrza; jej residual był mały, ale
nie przeszła certyfikacji okna/zbieżności. Różnica nie jest dowodem błędu
analityki ani solvera, dopóki nie zostanie powtórzona kampania zbieżności
siatki, liczbą warstw i airboxem. Jako diagnostyczna wskazówka, przeliczenie tej jednej liczby na skalarnego
Kittela daje efektywny $N_z\approx0.9068$. Dla modelu
$N_z=1-t/(t+2d)$ oznacza to efektywną odległość granicy Dirichleta
$d\approx48.7\,\mathrm{nm}$ od każdej powierzchni filmu; bezpośrednio dla
$d=50\,\mathrm{nm}$ model daje około $8.916623\,\mathrm{GHz}$. Jest to
zgodne ze skalą starego wyniku i nie jest zgodne z deklarowanym w C1
$d=2\,\mu\mathrm{m}$, dla którego oczekujemy $N_z\approx0.997506$ i
$9.299250\,\mathrm{GHz}$. Wniosek z preview jest więc węższy: artefakt miał
efektywną geometrię lub dyskretyzację normalną odpowiadającą znacznie
mniejszemu airboxowi (ewentualnie jego bounds nie były tymi z konfiguracji),
albo nie rozwiązywał poprawnie profilu po grubości. Residual nie wykrywa takiej
niespójności fizycznej; trzeba odczytać rzeczywiste bounds z `DomainFrameIR` i
wykonać sweep paddingu oraz liczby warstw.

Aktualizacja diagnostyczna z 2026-10-01: pilot Γ t3 na MFEM 4.10
(runtime SHA `e78a25bac0f95c1190821524545803e4311b8ef9`, build #193)
zachował dodatni mod $9.299249697068405$ GHz z full backward error
$2.01\cdot10^{-13}$. Przy produkcyjnej konwencji
$\mu_0=4\pi\cdot10^{-7}$ i powyższej geometrii jednorodna analityka finite
airbox daje $9.299249697068401$ GHz. Nie był to sukces pełnego okna:
14 z 50 podokien podało `slepc_diverged`; wynik końcowy ma
`window_complete=false`. Nie dowodzi to nonzero-k, kompletności widma
ani kwalifikacji bieżącego brancha. Szczegóły, source identity, residuale
oraz błąd metadanej $\mu_0$ zapisano w
[raporcie wyniku Γ](../audits/2026-10-01-mfem410-gamma-window-outcome.md).

Współczynnik P00 jest obliczany stabilnie: dla małego bezwymiarowego argumentu
`x=|k|*t` używane jest rozwinięcie `x/2-x^2/6+x^3/24-x^4/120+x^5/720`,
a poza nim `1+expm1(-x)/x`. Granica w zerze wynosi zero. Generator CSV
importuje `scripts/verify_fem_frequency_domain_eigen_artifacts.py::p00_demag_factor`,
aby współczynnik i częstość korzystały z tej samej realizacji. Rust stosuje tę
samą postać w `eigen/artifacts/modal_manifest.rs::kalinikos_slab_n0_frequency_hz`.
Test `test_frequency_is_continuous_at_gamma` sprawdza częstość BV i DE,
nie tylko pomocniczy współczynnik. To kontrola referencji analitycznej,
nie dowód wykonania FEM.

This is the route to COMSOL-class behavior: sparse operators, spectral targeting,
preconditioned shifted solves, and clear diagnostics.  The UI must expose this
as a first-class eigenmode target, not as an advanced hidden backend knob.

## Live progress contract

Production eigensolve progress is solver progress, not time-step telemetry.
The control room should show:

- assembly phase and DOF count;
- requested frequency window and requested mode cap;
- resolved eigensolver and spectral transform;
- Krylov/FEAST outer iteration;
- shifted linear-solve iterations where applicable;
- residual norm and converged mode count;
- last checkpoint or last emitted artifact;
- clear dense-path warning when no internal iteration telemetry exists.

### Jawna polityka wykonania natywnego CPU

Obecny adapter publikuje `execution_policy=petsc_sequential_cpu`,
`execution_scope=single_process_shared_memory`, `communicator=PETSC_COMM_SELF`
oraz `scalability_scope=single_process_only`. Sparse/matrix-free nie oznacza
w tej realizacji obliczeń rozproszonych MPI. Polityka jest obecnie ustalona
przez adapter, a nie wybierana przez dowolne opcje użytkownika.

Dla dynamicznego demagu Floqueta rozwiązanie potencjału używa PREONLY/LU,
a układ przesunięty GMRES/Jacobi. Manifest rozdziela `poisson_ksp_*` od
`ksp_*` układu przesuniętego. Wartości tolerancji i limitów odczytuje
`KSPGetTolerances`; zachowano domyślną tolerancję absolutną PETSc.
`poisson_iteration_semantics=preonly_factorization_no_iterative_convergence`
wyjaśnia, że tolerancje Poissona nie dowodzą iteracyjnej zbieżności PREONLY.
Weryfikacja wymaga nadal residualu oryginalnego operatora.

Domyślnie plan nie narzuca po stronie runnera limitu iteracji: brak
`runtime_metadata.modal_solver_policy` deleguje do domyślnych wartości
PETSc/SLEPc. Jeżeli plan poda `residual_tolerance`, `max_outer_iterations`
lub `max_linear_iterations`, są to wartości żądane; diagnostyka natywna
publikuje osobno wartości rzeczywiście rozwiązane przez EPS/KSP. Ta ścieżka
jest zintegrowana w źródłach, lecz nie została jeszcze potwierdzona w
managed runtime dla benchmarku C0/C1/A1.

Jawny `solver_policy` z przynajmniej jednym niepustym polem jest kontraktem
sterowania natywnym PETSc/SLEPc. Referencyjne ścieżki dense/LOBPCG nie
implementują tych nadpisań: planner i runtime mają odrzucić taką kombinację
przed bootstrapem Relax, callbackami i publikacją artefaktów. Pusty lub
all-null policy odpowiada brakowi nadpisania. Sama obecność policy nie może
zmienić równania referencyjnego ani automatycznie przełączyć rodziny solvera.
Requested controls pozostają w intencji użytkownika; odmowa nie jest cichym
fallbackiem. Implementacja tej bramki przeszła niezależne SOURCE review oraz hosted regresje GHA37979402458/Rust113985786699: planner i actual reference Single/path/all-null tests PASS. To nie kwalifikuje native provider ani fizycznych wyników.

Początkowy komunikat postępu ma `max_iterations=None`, dopóki callback
natywnego solvera nie dostarczy rozwiązanego limitu. Nie publikuje stałej 300.
Mapowanie: `slepc_modal_eigen.hpp::SLEPcTinyGyrotropicModalEigenResult`,
`modal/floquet_modal_solver.cpp::solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context`,
`production_cpu_modal_eigen.cpp::solve_sparse_production_modal_payload`
w `backends/fem/cpu/frequency_domain/` oraz
`crates/fullmag-runner/src/fem/eigen_native_window.rs::execute_native_modal_window`.
Kontrakt parsera i przekazywania limitu przechodzi w CI; nie jest to jednak
dowód wykonania pełnego managed MFEM/SLEPc dla bieżącego C1/A1. Taki dowód
wymaga osobnego receiptu runtime oraz artefaktów z poprawnym niezerowym `k`.

## Current limitations

Stan źródeł dla tej noty należy identyfikować w checkoutcie przez
`git rev-parse HEAD` oraz `git status --short`; historyczne SHA z wcześniejszych
checkpointów nie są dowodem bieżącej implementacji. W tym worktree sprawdzono
źródła 2026-09-14, a dowody managed runtime i kwalifikacji fizycznej są opisane
oddzielnie w planie checkpointu.

- FEM CPU ma zintegrowaną ścieżkę shared-domain MFEM/Floquet i sparse SLEPc;
  samo istnienie tej ścieżki nie dowodzi wykonania ani poprawności demag-k.
- Eksport obejmuje diagnostykę residuali, normę masową, rekonstrukcję
  potencjału i pole elementowe. Ich kompletność i wartości wymagają kontroli
  na rzeczywistym wyniku modelu C0/C1/A1.
- Nie ma potwierdzonej w tym checkpointcie pełnej kwalifikacji B4–B6:
  Kittel/KS, 61 punktów i 8 gałęzi oraz zbieżność siatki/airboxa/liczby modów.
- Referencja analityczna jest oddzielnym produktem. Jej poprawne wartości
  nie kwalifikują FEM ani nie zastępują zaakceptowanej równowagi numerycznej.
- Wyniki FDM CPU, FDM GPU i FEM GPU nie są kwalifikowane przez tę ścieżkę
  FEM CPU. Obsługa 2.5D pozostaje osobnym kontraktem.
- Interaktywne snapshoty podglądu FEM eigen nie są obsługiwane.

## Acceptance expectations for this phase

The MVP is considered correct when:

- `Problem(..., study=fm.Eigenmodes(...))` lowers into `StudyIR::Eigenmodes`,
- FEM planning produces `BackendPlanIR::FemEigen`,
- the runner exports the eigen artifact family,
- Analyze can open spectrum, saved modes, and dispersion rows without reconstructing semantics from ad hoc UI logic,
- `KSamplingIR::Path` uses the same open/closed segment semantics in Python,
  ProblemIR validation, runtime expansion, and `eigen/dispersion.csv`: open
  paths have `len(points)-1` segments, closed paths have `len(points)` segments
  with the final segment returning to the first point, and both publish
  `sum(samples_per_segment)+1` samples,
- validation rejects mixing time outputs with eigen outputs.

## Contract index for this page

(problem-statement)=
The page defines the FEM modal product and its separation from the analytic
dispersion oracle. A requested nonzero wave vector is solved by the selected
FEM lane; the analytic frequency is a postsolve comparison value.

(governing-equations)=
```{math}
:label: eq-0600-modal-pencil
L q = \lambda B_\alpha q, \qquad \lambda = \mathrm{i}\omega,
\qquad f = \operatorname{Re}(\omega)/(2\pi).
```

```{math}
:label: eq-0600-p00-reference
P_{00}(x)=1+\frac{\exp(-x)-1}{x}, \qquad x=|k|t,
\qquad P_{00}(0)=0.
```

(symbols-and-si-units)=
| Token | Meaning | SI unit |
|---|---|---|
| $q$ | tangent-plane modal coefficients | $1$ |
| $\lambda$ | generalized eigenvalue | $\mathrm{s^{-1}}$ |
| $B_\alpha$ | gyrotropic/mass operator | $\mathrm{m^3}$ |
| $\omega$ | angular frequency | $\mathrm{rad\,s^{-1}}$ |
| $f$ | cyclic frequency | $\mathrm{Hz}$ |
| $\delta_f$ | complex-frequency distance used for private candidate grouping | $\mathrm{Hz}$ |
| $f_r$ | real component of complex frequency | $\mathrm{Hz}$ |
| $f_i$ | imaginary component of complex frequency | $\mathrm{Hz}$ |
| $f'_r$ | real component of comparison complex frequency | $\mathrm{Hz}$ |
| $f'_i$ | imaginary component of comparison complex frequency | $\mathrm{Hz}$ |
| $P_{00}$ | thin-film demagnetizing factor | $1$ |
| $k$ | in-plane wave vector magnitude | $\mathrm{rad\,m^{-1}}$ |
| $\mathbf{k}$ | selected three-component Bloch/Floquet wavevector | $\mathrm{rad\,m^{-1}}$ |
| $k_i$ | wavevector component for $i \in \{x,y,z\}$ | $\mathrm{rad\,m^{-1}}$ |
| $\varepsilon_{\Gamma,\mathrm{comp}}$ | closed componentwise Gamma-admission threshold | $\mathrm{rad\,m^{-1}}$ |
| $q_{\mathbb{C}}$ | number of complex reduced tangent degrees of freedom before real splitting | $1$ |
| $n_{\mathbb{R}}$ | number of scalar coordinates in the doubled real-split tangent basis | $1$ |
| $N_{\mathrm{dense}}$ | scalar entry count of one square real-split $K$, $G$, $M$, or $K_{\mathrm{demag}}$ matrix | $1$ |
| $t$ | film thickness | $\mathrm{m}$ |

(assumptions-and-validity)=
The Kittel/KS comparison assumes a uniform in-plane equilibrium, a matching
film geometry, and the declared finite or open magnetostatic boundary. It does
not qualify higher modes, textured equilibria, or an unverified airbox. The
small-$x$ series is a numerical reference only; it never substitutes for the
FEM solve.

(python-api)=
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `study.stages.add_eigenmodes.count` | `int` | `required` | $1$ | positive integer | maximum accepted modal count | FEM CPU/GPU authoring; runtime-qualified per lane | `studies[].eigenmodes.count` |

```python
# %%
import fullmag as fm

study = fm.study("fem_eigenmodes_contract")
study.engine("fem")
study.stages.add_eigenmodes(count=4, include_demag=True)
```

(problem-ir)=
The Python request lowers to `StudyIR::Eigenmodes`, then to
`BackendPlanIR::FemEigen`. Requested mode count, frequency window, k sampling,
boundary model, and execution lane remain explicit in the IR and provenance.

(round-trip-and-failure-semantics)=
Round-trip serialization preserves requested intent and resolved execution.
Validation errors reject non-finite ranges, incomplete equilibrium handoff,
unsupported combinations, and synthetic K0 reference requests mixed with
`dispersion_validation`. An unavailable lane returns a capability error and
does not silently fall back to an analytic or CPU implementation.

(discrete-realization)=
FEM CPU uses the tangent-space operator and the native sparse modal adapter;
FEM GPU is a separate lane. FDM lanes are outside this page's realization.
Residuals, accepted mode count, mesh identity, phase metadata, and analytic
comparison fields are published per sample.

(implementation-mapping)=
The stable implementation identities are listed in the source index below.
They cover public authoring, planning, numerical execution, and the shared
small-argument analytic reference.

(validation)=
Source contracts check P00 continuity and the FEM/analytic product split.
Runtime acceptance additionally requires finite non-empty modal rows, residual
and phase certificates, Kittel/KS checks, and mesh, airbox, and mode-count
convergence. Those runtime gates remain separate from source tests.

(limitations)=
The current checkout has no new managed receipt for the full C0/C1/A1 campaign.
The 61-sample path, eight physical branches, browser proof, and release
qualification therefore remain `NOT VERIFIED`.

(scientific-bibliography)=
Kalinikos and Slavin, *Theory of dipole-exchange spin wave spectrum for
ferromagnetic films*, J. Phys. C 19 (1986), DOI:10.1088/0022-3719/19/35/7013.

(source-code-index)=
| Path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/study.py` | `class Eigenmodes` | Validate public modal parameters. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem_eigen` | Lower the FEM eigen study and enforce capability policy. |
| `crates/fullmag-plan/src/fem.rs` | `fem_eigen_solver_policy_has_native_path` | Reject ignored controls on structurally selected reference families. |
| `crates/fullmag-runner/src/fem/eigen_execution.rs` | `validate_modal_solver_policy_admission` | Gate controls before progress/handoff/artifacts while retaining no/all-null compatibility. |
| `crates/fullmag-runner/src/fem/eigen_path.rs` | `execute_fem_eigen_path` | Execute k samples and publish postsolve comparisons. |
| `crates/fullmag-plan/src/validate.rs` | `validate_eigen_outputs` | Admit branch selectors for a Gamma bias-field sweep while retaining ordinary single-Gamma rejection. |
| `crates/fullmag-runner/src/fem/eigen_path.rs` | `track_bias_field_sweep_samples` | Track accepted publisher modes on the physical field axis and apply requested public selection. |
| `crates/fullmag-runner/src/fem/eigen_sweep.rs` | `execute_bias_field_sweep_with_publication` | Preserve accepted-prefix publication while invoking field-axis tracking for explicit tracking consumers. |
| `crates/fullmag-runner/src/fem/eigen_path.rs` | `bias_field_branch_selection_tracks_native_publisher_artifacts_before_publication` | Regress swapped raw/frequency order, selected mode/potential binaries, raw-index compatibility, and unknown-branch rejection; hosted test pending. |
| `backends/fem/core/petsc_slepc_runtime.cpp` | `petsc_slepc_process_mutex` | Own one nonrecursive PETSc/SLEPc operation boundary for CPU/GPU, with unsafe retained-graph shutdown protection. |
| `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | `stop_native_floquet_eps` | Preserve negative EPS reasons and poll cancellation on the final successful iteration. |
| `backends/fem/cpu/frequency_domain/floquet_k_classification.hpp` | `classify_components` | Apply the finite, componentwise Rust-compatible Gamma admission class without changing authored wavevector values. |
| `crates/fullmag-runner/src/fem/eigen_constants.rs` | `GAMMA_K_TOLERANCE_RAD_PER_M` | Define the SI componentwise Gamma threshold used by Rust FEM eigen reduction and policy checks. |
| `crates/fullmag-plan/src/fem.rs` | `FEM_EIGEN_POLICY_GAMMA_K_TOLERANCE_RAD_PER_M` | Define the matching componentwise threshold used by Rust FEM eigen-policy resolution. |
| `crates/fullmag-runner/src/fem/eigen_reduction.rs` | `is_gamma_k_sampling` | Apply the Rust componentwise finite-value Gamma rule and retain omitted-k Gamma behavior. |
| `crates/fullmag-runner/src/fem/eigen_reduction.rs` | `gamma_threshold_agrees_with_single_k_policy` | Regress Rust Gamma boundary, subthreshold, and non-finite single-k classification. |
| `crates/fullmag-runner/src/native_fem/frequency_domain.rs` | `GAMMA_POINT_K_COMPONENT_ABS_TOLERANCE_RAD_PER_M` | Define the matching threshold used while the Rust native FEM planner resolves Floquet k. |
| `crates/fullmag-runner/src/native_fem/frequency_domain.rs` | `solve_native_modal_eigen` | Dispatch to the FFI conversion that maps Rust optional k slices to pointer/count, including empty slices with zero count. |
| `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `modal_request_floquet_k_classification` | Preserve invalid payload errors and route only the shared nonzero class to nonzero-k Floquet providers. |
| `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | `modal_request_has_invalid_floquet_k` | Keep malformed direct Floquet requests as validation errors before route fallback. |
| `backends/fem/tests/frequency_domain/floquet_modal_solver_test.cpp` | `void floquet_admission_uses_rust_gamma_threshold` | Regress the closed Gamma boundary and matching dense/sparse admissions. |
| `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp` | `void modal_gamma_cabi_route_preserves_authored_k` | Assert public C ABI Gamma routing and preservation of the requested wavevector in diagnostics. |
| `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp` | `void production_cpu_modal_eigen_direct_entry_validates_floquet_k` | Regress direct-entry validation, empty raw slices, fixed fallback, and legacy non-Floquet requests. |
| `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `solve_modal_eigen_contract` | Validate mixed shared-domain dense requests against the provider's full doubled real-split dimension while retaining caller `K/G/M`. |
| `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp` | `void modal_shared_domain_floquet_mixed_dense_real_split_contract` | Exercise caller-owned `K/G/M`, provider `K_demag`, full descriptor residuals, dimension rejection, and K sensitivity through the C ABI. |
| `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | `prepare_candidate_operator_diagnostic` | Prepare the bounded isolated Poisson workspace and attach its owner to the true-probe callback; hosted candidate measurements observed, full solve unqualified. |
| `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | `capture_candidate_shifted_lu_comparison` | Observe isolated current/NONE LU on the actual RHS with source-calibrated operator residual; hosted comparison observed, full production solve still fails. |
| `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | `capture_candidate_live_pc_observation` | Observe borrowed live PC on private RHS/vectors and isolated Schur action; source reviewed, hosted execution pending. |
| `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | `bool copy_bounded_petsc_type_name` | Own bounded type-name snapshots through callback cleanup and DTO copy/move; overflow stays unavailable. |
| `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp` | `void modal_nonzero_k_floquet_shared_domain_nearest_reports_shifted_ksp_diagnostics` | Run the live-PC fault contract in an independent CLI process without resetting the permanent unsafe latch. |
| `backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp` | `run_floquet_candidate_diagnostic_capture_transaction` | Stop callback on uncertain handler push/pop; preserve honest partial diagnostic completeness. |
| `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | `run_floquet_dense_original_oracle` | Record bounded raw/rotated eigenvalues and shift distances before window filtering, with explicit truncation. |
| `backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp` | `floquet_shifted_true_convergence_test` | Guard candidate admission after PETSc GMRES solution building; preserve negative reason and unavailable probes. |
| `packages/fullmag-py/src/fullmag/world.py` | `add_relax` | Author a separate upstream Relax stage for a relaxed-initial-state eigen study. |
| `crates/fullmag-cli/src/orchestrator.rs` | `accepted_relax_handoff_for_eigen_stage` | Resolve the accepted Relax-stage handoff; direct runner calls without it fail closed. |
| `crates/fullmag-runner/src/fem/eigen_tests.rs` | `relaxed_path_source_fixture_handoff_is_reused_for_each_nonzero_k_sample_without_per_sample_relaxation` | Source-fixture regression for one reused handoff across nonzero k samples; not physical or runtime qualification. |
| `scripts/verify_fem_frequency_domain_eigen_artifacts.py` | `p00_demag_factor` | Stable analytic P00 reference. |
| `crates/fullmag-runner/src/eigen/tracking_subspace.rs` | `frequencies_are_degenerate` | Apply the private absolute-plus-relative complex-frequency grouping bound. |
| `crates/fullmag-runner/src/eigen/tracking.rs` | `frequency_clusters_use_anchored_complex_distance_and_additive_tolerance` | Regress anchored grouping, complex distance, and additive/relative tolerance boundaries; does not qualify physical degeneracy. |


## Jawna metryka tiny-validation SLEPc

Adapter `slepc_tiny_validation_result` jest ograniczony do referencyjnego
problemu o dokładnie dwóch współrzędnych stycznych. Jego macierz
giroskopowa w pencil nie jest dodatnią metryką normowania modów. W tym
zadanym problemie algebraicznym dodatnią metrykę definiuje się jawnie jako
macierz jednostkową w współrzędnych toy:

```{math}
:label: eq-0600-tiny-reference-metric
M_{\mathrm{toy}}=I_2,\qquad
\lVert q\rVert_{M_{\mathrm{toy}}}^{2}=q^{\dagger}M_{\mathrm{toy}}q.
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $M_{\mathrm{toy}}$ | jawna dodatnia metryka referencyjnego problemu dwuwymiarowego | $1$ |
| $I_2$ | macierz jednostkowa o wymiarze dwa | $1$ |
| $q$ | współrzędne trybu w zadanej bazie toy, zgodne z tabelą symboli strony | $1$ |

To definicja ograniczonego fixture referencyjnego, nie zastępnik macierzy
masy FEM. Adapter przekazuje ją jako rzeczywiste dane wejściowe SLEPc;
wspólny solver nadal odrzuca brakującą lub niepoprawną dodatnią metrykę
produkcji. Nie dodaje się fallbacku identity w generic production, nie
zmienia się pencil K/G, konwencji czasowej, progu residualu ani wyboru
CPU/GPU. Tiny-validation nie kwalifikuje demag, siatki ani dyspersji FEM.

Publiczny Python/ProblemIR nie otrzymuje nowego parametru. Kontrakt dotyczy
istniejącego adaptera CABI: jawne tiny input przy `auto_select` zachowuje
dotychczasowy validation dispatch. Zachowujemy też dotychczasowy routing
`production_cpu` z tiny fixture do validation; nie jest to produkcyjny solver
CPU. Jawne `production_gpu` razem z tiny fixture jest sprzecznym żądaniem i
zostaje odrzucone przed wywołaniem toy solvera. Błąd zachowuje
`resolved_execution_target=production_gpu` i `fallback_state=none`, bez
przekierowania na validation lub CPU. Target requestu jest nadal przekazywany
przez istniejący v15 C ABI tail; GPU regresja używa wymaganego v20 result
envelope. Nie dodaje się pól ani migracji C ABI. FDM CPU/GPU i produkcyjny FEM
GPU nie korzystają z referencyjnej metryki.

GHA37915874849 wykazało wcześniejszą odmowę macrospin validation; source trace
wskazał wtedy nieprzekazaną metrykę do strict SLEPc preparation. Obecna
regresja `modal_shift_invert_finds_macrospin_mode` zachowuje pozytywny AUTO
fixture. `modal_v20_tiny_validation_rejects_forced_production_gpu` sprawdza
konflikt GPU/tiny przez C ABI bez wywoływania toy solvera i bez fallbacku.
Oba źródłowe kontrakty wymagają wykonania w GitHub Actions. Runtime i
kwalifikacja naukowa nowych źródeł pozostają **NOT VERIFIED**.

| Source ID | Path + symbol | Odpowiedzialność |
|---|---|---|
| source-tiny-slepc-reference-metric | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` :: `slepc_tiny_validation_result` | jawna metryka wyłącznie dwuwymiarowej validation lane |
| source-tiny-validation-dispatch-regression | `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp` :: `main` (wywołuje `modal_shift_invert_finds_macrospin_mode` i `modal_v20_tiny_validation_rejects_forced_production_gpu`) | pozytywny AUTO tiny CABI solve i forced GPU conflict rejection przez v20; GHA NOT VERIFIED |
| source-tiny-gpu-conflict-guard | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` :: `solve_modal_eigen_contract` | odrzuca forced production GPU z tiny fixture przed toy validation, zachowując resolved GPU i fallback none |

## Diagnostyka LU dokładnego shifted operatora — plan dowodu

Managed37973910821 dla provenance fixture ma rzeczywisty residual3.30355e-10 przy wymaganiu2.41258e-14. Oracle odsuwa shift od najbliższego eigenpole o0.893984 rad/s; ten fixture nie jest dowodem near-pole. Actual-vector Poisson/replay/linearity oraz zgodność dokładnej shifted matrix są bliskie roundoff. Nie wynika z tego możliwość obniżenia gate ani wyboru innej fizyki.

Kolejny opt-in bounded workspace ma porównać osobne LU na tej samej dokładnej shifted matrix i tym samym rzeczywistym RHS: obecna żądana polityka MAT_SHIFT_NONZERO oraz MAT_SHIFT_NONE, z identycznym reorder. Dla każdego wariantu mierzymy actual residual względem niezmienionego operatora i RHS, rozwiązanie oraz repeatability; wszystkie skale normalizacji i requested factor shift muszą być jawne. Requested shift nie dowodzi rzeczywistej perturbacji faktoryzacji. Wektory i factor workspace są własne; pomiary zachodzą przed hard EPS error, bez produkcyjnych workbuffers ani final-query po error.

To diagnostyka FEM CPU/PETSc ograniczona do istniejącego opt-in tiny bound; FDM i GPU runtime nie są kwalifikowane. Publiczny Python/ProblemIR i tolerancje pozostają bez zmian. Failure/unsafe teardown zachowuje fail-closed quarantine i unavailable metryki, nie pozorny sukces. Dopiero hosted rzeczywisty callback i residual comparison mogą uzasadnić zmianę bounded preconditionera. Implementacja diagnostyki, przewaga jednej polityki i poprawne production eigenpairs: NOT VERIFIED.

### Źródłowy kontrakt porównania LU

Implementacja i niezależny pełny SOURCE review obejmują opt-in capture przed mutacją residualu. Źródłowo $P_{\mathrm{norm}}=T A_{\mathrm{shift}}$; rozwiązanie $P_{\mathrm{norm}}y=b$ jest porównywane z operatorem przy $x_A=T y$. S jest wcześniejszą wspólną normalizacją pencil i nie jest stosowane drugi raz w tym przekształceniu. Normy są diagnostyką współrzędnych wewnętrznych KSP, nie nowym obserwablem fizycznym; ratio residual/RHS oraz residual/threshold są bezwymiarowe. Requested factor shift nadal nie jest zmierzoną perturbacją.

Push/pop handler failure propaguje się do quarantine przed dalszymi działaniami callbacku. Stan measured wymaga kompletnego własnego workspace, wszystkich dostępnych norm i zerowych error codes; częściowe pomiary nie udają sukcesu. Regresje używają rzeczywiście stosowanych transaction/completeness helpers oraz istniejących rzeczywistych callback fixtures. Local runtime/compile nie wykonano. Hosted LU metrics obserwowano w GHA37983196239; poprawne production eigenpairs tego fixture pozostają NOT VERIFIED.


### Pomiar LU na rzeczywistym RHS — wynik i granice diagnozy

[GHA37983196239](https://github.com/MateuszZelent/fullmag/actions/runs/37983196239)
na commicie `364d1fc7a2ca9cdcfb7686f06d57b6e27f140d56` wykonał
porównanie w `capture_candidate_shifted_lu_comparison`. Dla tego samego
RHS callbacku w subwindow10 obie izolowane polityki NONZERO/NONE dały
identyczny wynik: względny residual operatora `5.150782251730459e-16`,
stosunek do niezmienionego progu KSP `0.005150782251730459`.
Produkcyjny kandydat GMRES miał stosunek `13693.015524958842`;
modal provenance zakończył się błędem EPS91, a cały przebieg dał 5/6
testów PASS. Obie wielkości są bezwymiarowymi miarami układu wewnętrznego.
Nie stanowią residualu zaakceptowanego fizycznego modu.

Wynik nie uzasadnia zmiany polityki LU, progu ani okna wyszukiwania.
Dotychczasowe porównanie używa osobnych faktorów i nie mierzy działania
preconditionera rzeczywiście zainstalowanego w produkcyjnym GMRES.
Następny pomiar ma już implementację po pełnym SOURCE review; kompilacja i hosted wykonanie pozostają NOT VERIFIED. Ma porównać działanie
tego żywego PC na prywatnej kopii RHS z izolowanymi faktorami oraz sprawdzić
niezmienność kandydata przed i po obserwatorze. Musi zachować istniejącą
kalibrację $P_{\mathrm{norm}}=T A_{\mathrm{shift}}$ i $x_A=T y$,
availability każdej normy oraz checked cleanup. Nie wolno wykonywać
kolejnego solve na żywym KSP ani zmieniać jego konfiguracji w obserwatorze.

Mnożenie przez $T$ dotyczy diagnostycznego direct solve. Nie jest poprawką
końcowej rekonstrukcji prawego GMRES, która musi być zgodna z operatorem
bazy Kryłowa. Punkt odniesienia implementacyjnego: PETSc 3.24.6
[`KSPBuildSolution_GMRES`](https://github.com/petsc/petsc/blob/v3.24.6/src/ksp/ksp/impls/gmres/gmres.c)
oraz `floquet_shifted_true_convergence_test` w pliku wskazanym w indeksie
źródeł tej strony. Zakres dotyczy diagnostyki FEM CPU; nie rozszerza
publicznego Python/ProblemIR, FDM CPU/GPU ani kwalifikacji FEM GPU.


### Kontrakt źródłowy live-PC — SOURCE PASS, hosted pomiar wymagany

`capture_candidate_live_pc_observation` pożycza żywy KSP tylko na czas
callbacku. Metadane obejmują jego PC/Pmat, stronę oraz rzeczywisty
`KSPGetDiagonalScale`. Obie aplikacje PC i ich residuals używają prywatnej
kopii RHS. Akcja operatora przy diagnostycznym rozwiązaniu direct korzysta
z `apply_isolated_candidate_shifted_action` na izolowanym kontekście
Schura; porównanie jawnej macierzy Pmat jest osobnym pomiarem.
Pierwotne phi/action są kopiowane przed obserwatorem, a produkcyjne
phi buffers muszą pozostać niezmienione. Nie zastępujemy akcji operatora
residualem samej macierzy jawnej.

Nazwy typów są kopiowane przez `copy_bounded_petsc_type_name` do własnych
ograniczonych buforów DTO; overflow oznacza unavailable, bez pożyczonych
wskaźników po cleanup/refill. Każdy pomiar zachowuje własną availability
i null przy braku dowodu. Błąd PCApply/reapply jest fatalny: checked handler
transaction, callback error, hard EPS error i istniejący retained
graph/process-unsafe owner. Nie wykonujemy dalszego admission ani
pomiarów po tym błędzie. Nie zmieniono progów, okien ani solver policy.

CTest `modal_eigen_live_pc_apply_fault_quarantine` uruchamia
`fem_modal_eigen_contract --floquet-live-pc-apply-fault-quarantine-probe`
w świeżym procesie. Poprzednie hard-error fixtures nie mogą być
poprzednikiem tej próby w jednym procesie; latch nie jest resetowany.
Istniejący hosted profil obejmuje siedem testów, zachowując poprzednie sześć.
Root profile AST i delimiter/diff checks oraz niezależny pełny SOURCE
review PASS nie są kompilacją. Wartości nowych metryk i rzeczywiste
osiągnięcie fault hooka wymagają GHA. Copy/move regression potwierdza
własność DTO; near-pole ścieżka sama nie kwalifikuje zdrowego teardown.

To bounded opt-in diagnostyka FEM CPU, nie nowe publiczne Python/ProblemIR
ani obserwable fizyczne. Normy dotyczą wewnętrznych współrzędnych
numerycznych, a ratios są bezwymiarowe. Poprawny produkcyjny wynik
eigen/dispersion i kwalifikacja pozostałych realizacji nadal wymagają
odrębnych bramek opisanych wcześniej na tej stronie.
