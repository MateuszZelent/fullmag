# FEM Frequency-Domain Masterplan Hardening Design

## Status

- Date: 2026-07-10
- Decision: approved
- Scope: FEM frequency-driven response and modal eigensolve on CPU and GPU,
  for `k=0` and nonzero-k Floquet problems
- Excluded: a production FDM frequency-domain implementation
- Existing scoped design retained:
  `2026-07-09-real-fem-poisson-airbox-modal-design.md`

## Objective

Rebuild `docs/plans/active/fd_sovler_masterplan/` into a decision-complete,
implementation-ready specification. A competent implementer must be able to
follow the package from the public Python model through `ProblemIR`, planning,
native FEM assembly, CPU/GPU solver selection, artifacts, API resources and
validation without choosing undocumented signs, units, boundary semantics,
fallbacks or production claims.

Documentation cannot by itself guarantee a correct production solver. It must
instead define independent numerical and physical gates that prevent a solver
from being labelled production before the evidence exists.

## Current Problems To Correct

The current V5 package contains valuable material but is not yet a closed
production specification:

1. `documentation_manifest.json` and the generated full pack omit the later
   audit file 19.
2. Plan 18 is an append-only implementation diary. It simultaneously contains
   corrected BC-dependent gauge semantics and older unconditional mean-zero
   instructions.
3. Canonical files use an undefined `gamma` where fields are in `A/m`; the
   required coefficient is `gamma0 = mu0 * abs(gamma)`.
4. The beginning of the GPU readiness audit reports GPU K0 as unsupported,
   while a later appendix records the narrow GPU no-demag K0 gate as closed.
5. The real PETSc/SLEPc modal path targets a real `omega_target` although the
   documented eigenvalues satisfy `lambda = i*omega`.
6. The package mixes normative design, implementation status, runtime evidence
   and historical commands in the same files.
7. The public Python, `ProblemIR`, planner, native ABI, artifacts and UI
   contracts are not connected by one field-by-field traceability table.
8. A narrow executable or validated slice can be mistaken for qualification of
   an entire CPU/GPU, modal/driven or demag capability.

## Source-Of-Truth Architecture

The source hierarchy remains:

1. `docs/physics/` for equations, signs, SI units, assumptions and validation.
2. `docs/architecture/`, `docs/specs/` and ADRs for ownership and public
   architecture.
3. `docs/plans/active/fd_sovler_masterplan/` for the ordered implementation
   contract and current evidence.
4. Code and runtime artifacts for implemented and verified status.

The masterplan manifest classifies every included document as one of:

```text
normative
implementation_status
validation
historical
```

Only `normative` files may define target behavior. Status files may report
what exists but may not redefine physics. Historical files are excluded from
the canonical read order and the generated full pack.

### Package Restructure

- Keep `00_README_CANONICAL_FULL_READ.md` as the entrypoint, but replace its
  dated patch summary with the source hierarchy, scope and current status
  matrix pointer.
- Update `documentation_manifest.json` to include every canonical document,
  its role and generation order.
- Keep files 02 through 14 as focused normative chapters, after correcting
  their semantics and removing stale status claims.
- Keep the Kittel document as a validation specification.
- Reclassify completed implementation plans and dated readiness reports as
  supporting evidence or history.
- Replace plan 18 with the current production implementation contract. Preserve
  its append-only predecessor under `old/` for historical traceability.
- Convert audit 19 into a finding register with explicit states:
  `open`, `resolved_in_docs`, `implemented`, and `runtime_verified`.
- Add a machine-readable readiness matrix and a human-readable production
  definition of done.
- Treat the full pack as a generated snapshot only. It is never an independent
  source of truth.

## Closed Physics And Numerical Contract

### Units And Phasor Convention

All effective fields are in `A/m`. The precession coefficient is:

```text
gamma0 = mu0 * abs(gamma)  [rad s^-1 per (A/m)]
```

The canonical phasor and modal convention is:

```text
m(r,t) = m0(r) + Re(delta_m(r) * exp(+i*omega*t))
lambda = i*omega
frequency_hz = Re(omega)/(2*pi)
```

Every document and artifact must distinguish `gamma`, `gamma0`, angular
frequency and cyclic frequency.

### Operator Sign Dictionary

One normative table maps the projected linearized LLG to all representations:

```text
L q = lambda B q                 modal, lambda = i*omega
(i*omega*B - L) q = b            driven
b = T^T[-gamma0 * (m0 x delta_h)]
K phi = -i*omega*G phi           energy-Hessian gyrotropic form
B = -G                            when L=K uses the physical energy Hessian
```

The table defines every symbol, unit, scaling and transformation into the
real-split representation. A single 2x2 macrospin example must derive modal
frequency, driven resonance, chirality, damping and absorbed-power sign.

For `exp(+i*omega*t)` and interaction energy `-mu0*M dot H_drive`, the exported
observable is explicitly `absorbed_by_magnetization`:

```text
p_abs = -0.5 * mu0 * Ms * omega
        * Im(conj(h_drive) dot delta_m).
```

### Equilibrium And Linearization

The mandatory flow is:

```text
accepted EquilibriumArtifact
  -> LinearizationState
  -> tangent frames and operator signatures
  -> frequency-domain planner
```

The artifact carries `m0`, `h_eff0`, `h_demag0`, optional `phi0`, mesh,
material, physics and boundary signatures, stop reason and equilibrium
residuals. Static demag contributes to `h_eff0`; dynamic demag is the
Frechet derivative applied to `delta_m`. They share a provenance key but are
not interchangeable.

### Poisson-Airbox, Boundary Conditions And Gauge

For `delta_H_demag = -grad(delta_phi)` on the shared magnetic-plus-air domain:

```text
int_D grad(psi) dot grad(delta_phi) dV
+ beta int_Gamma_open psi*delta_phi dS
= int_Omega_m Ms*delta_m dot grad(psi) dV.
```

The validated BC tuple is closed:

```text
poisson_robin, beta > 0 -> gauge_policy=none
poisson_dirichlet       -> gauge_policy=none
pure_neumann            -> gauge_policy=mean_zero_augmented
```

Only pure Neumann has a constant nullspace and a gauge row. Gauge weights are
assembled from the active scalar FE space and quadrature; they are not required
to be strictly positive on eliminated or inactive DOFs.

### Full Descriptor, Schur And Finite Modes

The physical coupled definition is:

```text
[A_qq A_qphi] [q  ] = lambda [B_qq 0] [q  ]
[A_phiq P   ] [phi]          [0    0] [phi]
```

Pure Neumann adds the multiplier `eta` and the gauge row. Schur reduction is a
derived representation and may be selected only after full-vs-reduced
certification.

The modal specification defines how infinite descriptor eigenvalues are
filtered, how finite positive-frequency branches are selected, how conjugate
pairs are handled and how the full `phi`/`eta` state is reconstructed.

For a real PETSc build, the spectral target `sigma=i*omega_target` is represented
by an explicit real-split transformed pencil. A real scalar shift
`sigma=omega_target` is forbidden for the imaginary-axis spectrum.

The first self-adjoint qualification lane uses `alpha=0`. With Gilbert damping
or another nonconservative torque, the pencil is explicitly non-Hermitian. The
solver must then preserve complex eigenvalues, use right and, where required
for projections, left eigenvectors, and report biorthogonality and complex
frequency/linewidth conventions. It may not reuse a symmetric eigensolver.

### Residual And Scaling Contract

Modal and driven solvers report separately scaled blockwise backward errors:

```text
eps_q
eps_phi
eps_gauge
eps_full = max(eps_q, eps_phi, eps_gauge)
```

The reconstructed full-descriptor residual is the acceptance metric. A backend
reported residual is diagnostic only and may never replace or cap it. Driven
solves additionally report tracked Krylov and recomputed true unpreconditioned
residuals using the same block scaling.

### Periodic And Floquet Assembly

The v1 production topology is x/y periodic with open-z Poisson airbox. Fully
three-dimensional periodic `k=0` demag remains outside scope until a
macroscopic-field convention is selected.

The primary nonzero-k implementation uses matched-mesh complex constraint
matrices for magnetic and scalar-potential fields:

```text
q_full   = C_m(k) q_reduced
phi_full = C_phi(k) phi_reduced
A(k)     = C(k)^H A C(k).
```

Both fields use the same `exp(-i*k dot R)` seam convention. Constraint building
operates on complete corner/edge equivalence classes, not independent duplicate
pair equations. Tangent transfer uses `T_dst^T R T_src` before the Bloch phase.

An envelope formulation using `grad_k/div_k` is an alternative backend only
after it passes matrix/action equivalence against the constraint formulation.

## End-To-End Implementation Flow

```text
Python DSL / UI
  -> ProblemIR
  -> validation and capability resolution
  -> EquilibriumArtifact and LinearizationState
  -> periodic/Floquet certificate
  -> shared operator assembly
  -> FrequencySolvePlanner
  -> exactly one solver engine
  -> full residual certification
  -> artifacts, API resources and UI
```

The implementation plan must include field-by-field traceability for both
`modal_eigen` and `driven_response`, including defaults, SI units, validation,
serialization, FFI layout, ownership and rejection behavior.

### CPU Engine Order

1. Dense Cartesian and tangent oracles.
2. Real shared-domain P1 MFEM block assembly.
3. Sparse-direct diagnostic oracle.
4. SLEPc selected-spectrum full descriptor and certified Schur solve.
5. Driven full-coupled field-split solve.
6. Certified Schur-reduced solve.
7. Modal, rational or recycling acceleration for frequency sweeps.
8. Nonzero-k constraint assembly and dynamic demag-k.

### GPU Engine Order

1. CPU/GPU parity on identical assembled blocks.
2. Persistent device operator and Poisson contexts.
3. Device shifted solve and preconditioner.
4. Driven device-resident GMRES/FGMRES.
5. Modal device-resident Krylov-Schur/Arnoldi with restart and multiple modes.
6. Nonzero-k complex constraint/operator parity.
7. Production performance and transfer audit.

PETSc/SLEPc/MFEM/hypre/libCEED are preferred over a new large in-house Krylov
implementation. Host control and bounded scalar reductions are permitted, but
matrix and vector state must not migrate to the host per iteration when the
lane claims device residency.

### Planner Invariants

- Explicit requested device and solver method are evaluated before heuristic
  preferences.
- CPU intent cannot be converted to GPU by a default preference flag.
- Strict GPU never falls back to CPU.
- Non-strict fallback is explicit in the plan and provenance.
- Sparse-direct availability cannot preempt a forced GPU request.
- A solver engine is selectable only when its required equilibrium, mesh,
  operator, residual and preconditioner certificates are valid for the current
  problem signature.
- Nonzero-k with demag cannot reuse the `k=0` operator.

## Status And Production Claims

Each capability cell records independent axes:

```text
implementation_state:
  absent | contract_only | source_visible | executable

validation_state:
  unvalidated | algebra_validated | physics_validated | production_qualified
```

Every nontrivial status also carries `validated_scope`. For example, a GPU
no-demag K0 macrospin gate cannot promote GPU Poisson-airbox modal support.

The readiness matrix covers:

```text
modal_eigen | driven_response
CPU | GPU
k=0 | nonzero-k
no demag | Poisson-airbox/dynamic demag
```

Requested and resolved execution, fallback, precision, algebra, solver family,
preconditioner, residency and validation scope are recorded in artifacts.

## Production Validation Matrix

Production qualification requires all applicable gates:

1. Manufactured Poisson solutions for Robin, Dirichlet and pure Neumann.
2. Sphere or ellipsoid demag sign, field and energy checks.
3. K0 Larmor, anisotropy and independent thin-film Kittel field sweeps.
4. At least three mesh levels and a separate airbox-padding convergence sweep.
5. Dense, sparse, full-coupled and Schur action/solution parity.
6. Modal frequency against the driven-response resonance peak.
7. Periodic against Floquet at `k=0`.
8. Exchange `k^2`, Damon-Eshbach and backward-volume nonzero-k dispersion.
9. Nonuniform-equilibrium derivative and tangent-frame gauge-invariance tests.
10. CPU/GPU parity from identical physical input and assembled operators.
11. Full residual, mode orthogonality or biorthogonality and spectral-window
    completeness.
12. No hidden fallback and complete artifacts/provenance.
13. Bounded memory/time scaling and GPU transfer/residency audit.

Analytical expected values are verifier inputs only. They must never build the
physical operator being validated.

## Error Handling

Unsupported or uncertified requests fail with exact, stable reasons. The
planner rejects whenever it already has enough information; the backend rejects
only conditions discoverable during assembly or solve. No path silently
changes `k`, demag model, boundary condition, device, precision, equilibrium or
solver algebra.

Failed and interrupted runs retain requested/resolved plans, partial progress,
the latest true residual, stop reason and available diagnostic artifacts.

## Documentation Verification For This Work

This documentation hardening pass is text-only. It will not run builds, tests
or solver workloads. Verification is limited to static review of:

- source hierarchy and manifest coverage;
- internal links and file roles;
- symbol, sign, unit and status consistency;
- target-vs-current wording;
- absence of unresolved choices in normative documents;
- alignment with the current public and native code vocabulary.

Runtime claims remain unchanged unless existing repository evidence is cited.

## Acceptance Criteria

The documentation work is complete when:

1. Every normative file has one role and no historical status diary.
2. All audit findings have an explicit state and disposition.
3. The manifest and full pack include the complete canonical set.
4. `gamma0`, phasor, modal/driven, gauge, spectral target and residual contracts
   are internally consistent.
5. CPU/GPU and `k=0`/nonzero-k algorithms are explicit enough to implement
   without an unresolved scientific decision.
6. Python, IR, planner, native ABI, artifacts, API and UI fields are traceable.
7. Production qualification is impossible from a narrow or synthetic result.
8. Historical evidence remains available but cannot override normative text.
