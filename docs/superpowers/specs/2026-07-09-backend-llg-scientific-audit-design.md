# Fullmag Backend LLG Scientific Audit Design

- Status: approved design, awaiting written-spec review
- Date: 2026-07-09
- Baseline at design time: `ae03c37795a6dee315e305798139fdf04dab1377`
- Scope owner: Fullmag solver and physics documentation
- Change policy: audit artifacts only; no solver fixes in this work package

## Objective

Audit the complete compiled solver tree under `backends/` for physical and
numerical defects in static relaxation, nonlinear time-domain LLG, and
linearized frequency-domain LLG. Audit the corresponding end-to-end contracts
and documentation so that every conclusion distinguishes source presence,
public executability, runtime proof, and validated physics.

The audit must produce evidence strong enough to answer all of the following:

1. Does each implemented interaction use the documented equation, sign, and SI
   unit convention?
2. Is every reported energy consistent with its effective field or direct
   torque?
3. Do relaxation and time integrators preserve the unit-sphere constraint and
   implement their advertised numerical method?
4. Are adaptive-step, rejected-step, thermal-noise, and stopping semantics
   physically and numerically valid?
5. Do CPU and GPU realizations preserve one backend-neutral physics contract?
6. Are modal and driven frequency-domain operators consistent with the
   canonical phasor, eigenvalue, damping, excitation, and observable
   conventions?
7. Do tests and runtime artifacts prove the claims made by capability and
   physics documentation?
8. Can a reviewer account for every source file and every relevant document?

## Locked Decisions

The audit uses the evidence-first strategy approved in the preceding design
review. It combines exhaustive static inspection with focused executable proof.
Neither a static-only review nor a benchmark-only review is sufficient.

The scope includes frequency-domain and eigensolver code. Linearized LLG is a
distinct solver family, but it is part of the requested dynamics audit.

The scope includes the end-to-end caller chain outside `backends/` when it can
alter, suppress, mislabel, or silently fall back from backend physics. The
compiled numerical implementation remains owned by `backends/fdm` and
`backends/fem`.

The four device/discretization lanes are FDM CPU, FDM GPU, FEM CPU, and FEM
GPU. Lane is not maturity or authority. Within a lane, a reference oracle,
production implementation, bootstrap path, and validation adapter are recorded
separately. In particular, Rust CPU reference behavior cannot prove native GPU
behavior, and a small dense FEM oracle cannot inherit production status from an
MFEM/SLEPc path or confer production status on it.

The work package reports defects and proposes corrections. It does not modify
solver source, public semantics, capability status, or canonical physics notes.
Any remediation requires a separate approved implementation plan and
test-driven change set.

## Baseline and Concurrency Protocol

The repository is under concurrent development. A report that mixes two source
states is invalid. Each audit run therefore records:

- `git rev-parse HEAD`;
- `git status --short`;
- committed, staged, unstaged, and untracked paths;
- the timestamp and command for every executable proof;
- the exact artifact path used for every runtime conclusion.

Committed code and worktree drafts are separate evidence classes. Untracked or
staged documents may be inspected for drift, but they cannot establish the
canonical committed contract. If HEAD changes in a way that touches an audited
subsystem, that subsystem is rechecked against the new revision before its
findings are finalized.

The design-time inventory contains 605 files and 158,205 lines under
`backends/`:

| Tree | Files | Lines | Audit role |
|---|---:|---:|---|
| `backends/fdm` | 49 | 21,020 | compiled native FDM, principally CUDA |
| `backends/fem` | 556 | 137,185 | MFEM/hypre/libCEED CPU/GPU, ABI, tests, frequency domain |

The inventory is recomputed at the final evidence freeze. The design-time
documentation search identifies 252 candidate Markdown files. Every candidate
is classified rather than assumed normative.

## Authority Order

Conflicts are resolved in this order:

1. governing physics equations and units in accepted `docs/physics/` notes;
2. accepted architecture, ADR, specification, and capability contracts;
3. `AGENTS.md` and `docs/architecture/backend-golden-masterplan.md`;
4. public Python DSL and canonical `ProblemIR` semantics;
5. planner, runner, ABI, and runtime provenance;
6. compiled implementation and tests;
7. active plans and worktree drafts;
8. historical plans and ignored reports.

An implementation that disagrees with a higher source is a code defect unless
the higher source is internally inconsistent or physically wrong. In that case
the audit records a documentation-contract defect and does not silently select
the implementation as truth.

External references are limited to primary literature, official solver
manuals, official library documentation, and official micromagnetic benchmark
definitions. External solver source may inform comparison but is never copied.

## Audit Surfaces

### FDM

The FDM audit covers:

- native C ABI creation, validation, stepping, state I/O, errors, and telemetry;
- CUDA context ownership, streams, reductions, snapshots, and device state;
- FP64 and FP32 exchange, demagnetization, anisotropy, DMI, Zeeman, thermal,
  STT, SOT, Oersted, and multilayer interactions;
- Newell tensor generation, spectral convolution, padding, PBC, boundary
  corrections, masks, volume fractions, and region coefficients;
- Heun, RK4, BS23/RK23, Dormand-Prince RK45, ABM3, FSAL, fixed and adaptive
  stepping, rejected-step rollback, and statistics;
- multilayer staged integrators and convolution;
- parity against the trusted Rust CPU reference under
  `crates/fullmag-engine/src/fdm`;
- native tests, planner legality, runtime selection, artifacts, and capability
  claims.

### FEM nonlinear time domain and statics

The FEM time-domain audit covers:

- core mesh, state, material, mask, region, and field-buffer ownership;
- CPU/MFEM and GPU/CUDA exchange, demag strategies, Zeeman, anisotropy, DMI,
  thermal Brown field, STT, Oersted, and prescribed-strain magnetoelasticity;
- field composition, direct-torque composition, per-interaction energy,
  energy density, total energy, and observable publication;
- explicit Heun, RK4, BS23/RK23, RK45, tableau dispatch, stage normalization,
  adaptive control, final-field freshness, and accepted-state accounting;
- overdamped LLG, projected-gradient Barzilai-Borwein, nonlinear conjugate
  gradient, and tangent-plane implicit relaxation;
- tangent projection, FEM mass metric, retraction, line search, gradient units,
  preconditioning, rollback, and stopping criteria;
- CPU/GPU residency, host-device transfers, demag linear-solver policy,
  residuals, gauge, and provenance;
- native ABI validation, strict-device rejection, runner orchestration, and
  capability claims.

### FEM frequency domain and eigenmodes

The frequency-domain audit covers:

- equilibrium handoff and recomputation of `H_eff0`;
- tangent-frame construction, transport, periodic/Floquet pairing, and frame
  gauge;
- `exp(+i omega t)` phasor convention and `lambda = i omega` modal mapping;
- stiffness, gyrotropic/mass, damping, excitation, dynamic-demag, DMI,
  anisotropy, exchange, and Zeeman operator terms;
- dense reference, matrix-free GMRES, sparse-direct, field-split, Schur,
  contour, SLEPc shift-invert, modal reduction, and GPU adapters;
- real/complex block algebra, target and spectral transform selection,
  residual reconstruction, Poisson constraint, scalar-potential gauge,
  normalization, orthogonality, mode pairing, deduplication, and window
  completeness;
- susceptibility, absorbed power, linewidth, phase, and artifact semantics;
- cancellation, partial artifacts, progress, capability gating, and CPU/GPU
  provenance.

### End-to-end contracts

The audit follows affected semantics through:

- `packages/fullmag-py`;
- `crates/fullmag-ir`;
- `crates/fullmag-plan`;
- `crates/fullmag-runner`;
- `crates/fullmag-fdm-sys` and `crates/fullmag-fem-sys`;
- `native/include`;
- generated or manually maintained capability, artifact, and API contracts;
- control-room resources only where they publish backend status, fields,
  observables, warnings, or provenance.

This is not a general frontend visual audit. UI code is in scope only when it
can misrepresent solver physics or validation status.

## Physics and Numerical Checks

Every interaction and workflow is checked against the same minimum contract:

1. physical quantity and governing equation;
2. input and output SI units;
3. sign and handedness convention;
4. field, weak residual, or direct-torque representation;
5. energy functional and discrete directional derivative where applicable;
6. material heterogeneity and nonmagnetic masking;
7. spatial discretization and boundary conditions;
8. time, stochastic, or solver discretization;
9. CPU/GPU and FDM/FEM realization differences;
10. observables, telemetry, artifacts, and provenance;
11. capability legality and fallback behavior;
12. analytical, convergence, cross-backend, and runtime proof.

Dimensional analysis is mandatory. A numerically stable expression with the
wrong physical unit is a defect even if a fitted step length or tolerance hides
the scale error in one fixture.

Energy-derived terms must satisfy the discrete counterpart of

`delta E = -mu0 integral Ms H_term dot delta_m dV`

for tangent perturbations. Direct torques are excluded from energy-minimizer
gradients unless an explicit work functional is documented and implemented.

## Finding Model

Each finding receives a stable identifier:

- `FDM-NUM-*` or `FDM-PHY-*`;
- `FEM-TD-NUM-*` or `FEM-TD-PHY-*`;
- `FEM-FD-NUM-*` or `FEM-FD-PHY-*`;
- `ABI-*`, `CAP-*`, `DOC-*`, or `VAL-*` for cross-cutting contracts.

Severity is assigned by impact:

| Severity | Meaning |
|---|---|
| P0 | Produces materially wrong physical results, corrupts state, or falsely certifies a production result on an ordinary supported path |
| P1 | Material numerical/physical defect, silent lane divergence, invalid fallback, or missing gate that can plausibly invalidate results |
| P2 | Limited-scope error, misleading diagnostic/provenance, robustness defect, or significant maintainability risk |
| P3 | Documentation hygiene, weak test structure, naming drift, or low-impact hardening issue |

Evidence state is independent of severity:

| Evidence state | Required meaning |
|---|---|
| `proven_static` | The defect follows directly from complete source and caller analysis |
| `proven_test` | A focused executable regression reproduces the defect |
| `proven_runtime` | The intended native lane reproduces it through the repository-managed runtime |
| `physics_validated` | An analytical, convergence, standard-problem, or trusted-reference comparison quantifies the physical impact |
| `risk_requires_test` | Source evidence identifies a credible defect but does not prove runtime manifestation |
| `documentation_drift` | Documents disagree with current code, higher authority, or verified runtime evidence |
| `validation_gap` | A claim cannot be supported because the required proof is absent or does not test the claimed property |

Every finding must contain:

- concise title and severity;
- affected lane, workflow, and feature;
- expected equation or numerical contract;
- actual implementation behavior;
- dimensional and sign analysis;
- exact file and line anchors;
- caller and reachability evidence;
- user-visible and scientific impact;
- current tests and why they miss or catch the defect;
- minimal reproducer or required fixture;
- recommended correction boundary;
- verification required after correction;
- confidence and unresolved assumptions.

Absence of a failing test is not evidence of correctness. Source presence is
not evidence of public reachability, and public reachability is not physics
validation.

## Execution Phases

### Phase 0: Evidence freeze and coverage manifest

- record the repository state;
- enumerate every file under `backends/`;
- classify generated, compatibility, implementation, test, and embedded-doc
  files;
- map each source to a subsystem owner and audit status;
- enumerate and classify all relevant documentation.

Exit criterion: every backend file and candidate document has one coverage row
and no unclassified path remains.

### Phase 1: Canonical contract extraction

- extract equations, units, signs, BCs, stochastic conventions, integrator
  definitions, solver tolerances, and validation promises;
- identify contradictions among physics notes, capability tables, plans, and
  implementation comments;
- establish the expected contract before judging code.

Exit criterion: each audited feature has one explicit expected contract or an
open documentation defect.

### Phase 2: FDM static and dynamic audit

- review all 49 native FDM files and their Rust/ABI callers;
- compare FP32 with FP64 and native GPU with the Rust CPU reference;
- construct focused checks for all proven and high-confidence findings;
- identify unsupported combinations that must reject rather than execute.

Exit criterion: all FDM files, interactions, integrators, tests, and public
claims have a completed audit row.

### Phase 3: FEM time-domain and relaxation audit

- review FEM core, CPU/MFEM, GPU/CUDA, ABI, and non-frequency tests;
- prove energy-field consistency, tangent/norm handling, minimizer units,
  stochastic semantics, and CPU/GPU parity boundaries;
- inspect strict-device and fallback behavior.

Exit criterion: every nonlinear time-domain and relaxation subsystem has a
completed physics, numerics, reachability, and validation assessment.

### Phase 4: FEM frequency-domain and modal audit

- review every frequency-domain source, header, test, and embedded document;
- verify algebra and observables with hand-derived macrospin and small-matrix
  oracles;
- test selected-spectrum targeting with more than one separated eigenfrequency;
- distinguish synthetic/dense oracles from assembled production paths.

Exit criterion: driven and modal families each have independent correctness and
maturity conclusions for CPU and GPU.

### Phase 5: Documentation, capability, and provenance audit

- classify normative, active, historical, ignored, staged, and untracked docs;
- verify path freshness, formulas, implementation status, validation claims,
  and canonical manifest inclusion;
- compare Markdown and machine-readable capability matrices;
- verify requested versus resolved execution and fallback wording.

Exit criterion: every relevant document is classified and every contradiction
has a finding or explicit historical exemption.

### Phase 6: Executable validation

Focused source tests precede expensive runtime proof. Native FEM proof uses the
container-backed `justfile` route. Host CMake or Cargo commands may diagnose a
failure but cannot close an MFEM/CUDA runtime claim.

Candidate repository-managed gates include:

- `just verify-fem-relaxation-source-contract`;
- `just verify-fem-relaxation-runtime`;
- `just verify-fem-relaxation-convergence`;
- `just verify-fem-relaxation-cpu-gpu-consistency-smoke`;
- `just verify-fem-frequency-domain-native-contract`;
- `just verify-fem-frequency-domain-contract`;
- `just verify-fem-frequency-domain-runtime-suite`;
- `just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc`;
- `just verify-fem-frequency-domain-eigen-runtime`;
- `just ensure-managed-fem-runtime` followed by the matching managed headless
  scenario;
- native FDM parity and smoke targets selected from the current build graph;
- `just run-fdm-cpu-smoke` and relevant FDM headless workflows for public
  reachability.

Running every listed gate is not automatic proof. Before execution, the audit
checks that the gate exercises the implicated formula, lane, precision,
interaction, and error condition. A passing source-string contract cannot
close a numerical or physical claim.

### Phase 7: Synthesis and completion audit

- consolidate duplicate findings across code, docs, and runtime;
- rank correction order by physical impact and reachability;
- state implemented, executable, runtime-proven, and physics-validated status
  separately;
- recheck every explicit scope item against the final coverage manifest;
- rerun exact line anchors and repository status before publication.

Exit criterion: no requested subsystem, source file, document, test class, or
deliverable lacks authoritative completion evidence.

## Validation Matrix

The audit defines or evaluates at least these proof classes:

| Area | Required proof |
|---|---|
| LLG convention | macrospin precession direction, damping energy decrease, gamma and `mu0` units |
| Norm and tangency | accepted-state norm, tangent RHS, nonmagnetic zeroing, rejected-step rollback |
| Exchange | uniform zero, sinusoidal/plane-wave field, energy convergence, heterogeneous coefficient check |
| Demag | Newell tensor oracle, prism/sphere/ellipsoid checks, airbox convergence, PBC seam and supercell comparison |
| Zeeman | parallel/antiparallel energy and static susceptibility sign |
| Anisotropy | easy-axis/easy-plane/cubic minima and directional derivative |
| DMI | directional derivative, chirality, spiral pitch, boundary tilt, normal convention |
| Thermal | variance scaling with `dt`, volume, `Ms`, `alpha`, and gamma; seed replay; Boltzmann macrospin; retry semantics |
| STT/SOT | sign, polarization direction, dimensional scale, direct-torque versus field path |
| Oersted | Ampere-law magnitude and arbitrary-axis rotation |
| Magnetoelastic | prescribed-strain energy derivative and shear convention |
| Time integration | method order, tableau, FSAL validity, adaptive acceptance/rejection, final-field freshness |
| Relaxation | monotone conservative energy where applicable, torque convergence, Armijo dimensional consistency |
| Driven response | zero-frequency susceptibility sign, resonance phase, positive dissipated power, residual reconstruction |
| Eigenmodes | Kittel frequency, positive branch, target selection, residual, normalization, orthogonality, window completeness |
| Cross-backend | FDM CPU/GPU, FEM CPU/GPU, and meaningful FDM/FEM convergence with stated projection |
| Standard problems | applicable official micromagnetic standard problems, including dynamic problem 4 |

Tolerance values must come from the canonical note, analytical discretization
error, convergence study, or a documented reference. They are not selected
after observing the output merely to make a test pass.

## Documentation Audit Rules

Each document receives one status:

- canonical and current;
- canonical but internally inconsistent;
- active plan;
- worktree draft;
- historical context;
- stale path or ownership;
- stale implementation status;
- unsupported validation claim;
- duplicate or superseded without clear routing;
- unrelated to the audited solver scope.

The audit checks at minimum:

- old `native/backends/*` paths versus current `backends/*` ownership;
- duplicate physics-note numbering and unclear supersession;
- equations and unit symbols across LLG, thermal, energy, and frequency notes;
- capability Markdown versus JSON and actual planner behavior;
- active-plan canonical manifests and full-read lists;
- `implemented`, `executable`, `production`, and `validated` vocabulary;
- host-only verification instructions that conflict with managed FEM policy;
- ignored `docs/reports/` claims that have not been revalidated against the
  current tree.

## Deliverables

The approved audit produces two tracked artifacts:

1. `docs/validation/2026-07-09-backend-llg-scientific-audit.md`
   - executive verdict;
   - methodology and evidence snapshot;
   - full P0-P3 finding register;
   - per-lane and per-workflow conclusions;
   - documentation/capability drift;
   - validation results and limitations;
   - ordered remediation roadmap;
   - completion audit.
2. `docs/validation/2026-07-09-backend-llg-audit-coverage.md`
   - one row per backend file;
   - subsystem, owner, lane, reviewed status, findings, tests, and evidence;
   - one row per relevant document with its authority and drift status.

The primary report links to the coverage annex. The annex proves breadth; the
report carries the scientific reasoning. Neither artifact is stored under the
normally ignored `docs/reports/` tree.

## Failure and Blocker Handling

If a runtime is unavailable, the report records the exact missing prerequisite
and leaves the affected claim at `risk_requires_test` or `validation_gap`. It
does not infer correctness from compilation or source contracts.

If a managed recipe fails, the full error is read before classification. A
container, driver, dependency, or permission failure is separated from a
solver regression. The same unexplained failure is not retried repeatedly
without changing the hypothesis.

If concurrent changes alter audited files, their findings are marked stale and
revalidated against the new snapshot. The audit never overwrites, stages, or
commits unrelated user changes.

If two canonical documents disagree physically, the report derives both
alternatives, consults primary references, and records the conflict explicitly.
It does not resolve the conflict by popularity or by whichever formula the
current test happens to encode.

## Acceptance Criteria

The audit is complete only when all of the following are true:

- every file under the final `backends/` snapshot appears in the coverage
  annex;
- every relevant document is classified;
- all four device/discretization lanes and every reference, bootstrap,
  production, and validation role within them are explicit;
- static relaxation, nonlinear time-domain LLG, driven response, and modal
  eigensolve have independent conclusions;
- every active interaction and integrator has an equation/unit/sign and test
  assessment;
- every P0/P1 claim has complete reachability evidence and either an executable
  reproducer or an explicit missing-proof classification;
- managed FEM runtime evidence is used for all MFEM/CUDA runtime claims;
- official or analytical benchmarks support physics-validation claims;
- capability and provenance conclusions are checked against planner/runtime
  behavior rather than documentation alone;
- final line anchors and repository state are refreshed;
- the primary report contains no placeholder, ambiguous maturity claim, or
  unqualified assertion of production correctness;
- the completion audit maps every objective requirement to authoritative
  evidence.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Concurrent changes invalidate evidence | Freeze and recheck per subsystem; record committed and worktree states separately |
| Huge contract tests create false confidence | Inspect what each assertion measures and add numerical oracles where source-string checks are insufficient |
| Runtime gates are expensive | Run focused gates first, then the minimum managed scenario that proves the implicated behavior |
| A fitted tolerance hides a physical defect | Require derivation, convergence, or external reference for each tolerance |
| CPU/GPU differences are dismissed as precision | Compare equations, coefficients, BCs, and feature gates before numerical tolerances |
| Historical reports are treated as current | Classify them as leads only and revalidate every retained claim |
| A synthetic oracle is promoted as production FEM | Record assembly source, mesh, operator provenance, and real runtime lane in every conclusion |
| Fix recommendations expand beyond the audit | Keep remediation descriptive; implementation starts only under a separate approved plan |

## Final Design Decision

The audit will be exhaustive, evidence-first, and split into a scientific
finding report plus a complete coverage annex. It will not trade breadth for a
small set of passing tests, and it will not call executable code validated
without the corresponding numerical and physical evidence.
