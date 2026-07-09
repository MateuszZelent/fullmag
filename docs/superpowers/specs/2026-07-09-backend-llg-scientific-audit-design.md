# Fullmag FEM Time-Domain and Relaxation Scientific Audit Design

- Status: approved for execution; scope overridden on 2026-07-09
- Date: 2026-07-09
- Baseline at design time: `ae03c37795a6dee315e305798139fdf04dab1377`
- Scope owner: Fullmag nonlinear FEM solver and physics documentation
- Change policy: audit artifacts only; no solver fixes in this work package

## Dated Scope Override

On 2026-07-09 the user narrowed the previously approved broad backend audit.
The active work package now covers only standard nonlinear finite-element
micromagnetics in the time domain: static fields and energies, deterministic
and stochastic LLG dynamics, relaxation/minimization algorithms, and the
interactions consumed by those workflows.

The earlier FDM and frequency/modal workstreams are superseded for this audit.
Their existing plans and preliminary evidence may remain as historical files,
but they are not active inputs, do not contribute coverage rows, do not
contribute findings, and must not be used to support the final verdict.

The final filenames retain `backend-llg` only for continuity with the already
approved artifact paths. Their titles and content must identify the result as a
FEM time-domain and relaxation audit.

## Objective

Audit every semantically selected time-domain file under `backends/fem` for
physical and numerical defects in static evaluation,
relaxation/minimization, and full nonlinear time-domain LLG. Audit the
corresponding end-to-end contracts and the exact read-based subset of
repository Markdown that governs or claims behavior for those workflows.

The audit must produce evidence strong enough to answer all of the following:

1. Does each implemented FEM interaction use the documented equation, sign,
   handedness, and SI-unit convention?
2. Is every conservative effective field consistent with its published energy
   and energy density under the discrete FEM mass metric?
3. Are direct torques kept dimensionally and algorithmically separate from
   conservative minimizer gradients?
4. Do time integrators preserve tangency and accepted-state normalization and
   implement their advertised tableaux and adaptive semantics?
5. Are rejected-step, thermal-noise, rollback, final-field freshness, and
   stopping semantics physically and numerically valid?
6. Do CPU/MFEM and strict GPU/CUDA realizations preserve one backend-neutral
   physics contract without silent host fallback?
7. Do tests and managed-runtime artifacts prove the maturity claims made by
   capability and physics documentation?
8. Can a reviewer account for every in-scope backend file and every selected
   FEM time-domain/relaxation document?

## Locked Decisions

The audit is evidence-first: exhaustive static inspection is combined with
focused executable proof. Static-only review cannot establish runtime
reachability, while a benchmark-only review cannot account for unexercised
branches, units, signs, or unsupported combinations.

The compiled-source universe is every file under `backends/fem`. A semantic
scope ledger excludes paths below `frequency_domain` and files outside that
directory which are nevertheless dedicated solely to modal/eigen or
frequency-domain infrastructure. Shared or mixed files remain selected, but
only their time-domain responsibilities receive a verdict. The current tree
contains 454 paths after the directory exclusion and 450 selected paths after
also excluding `cpu/mfem/runtime/eigen_dense.{cpp,hpp}` and the dedicated
`cmake/Find{PETSc,SLEPc}.cmake` frequency-dependency modules. Both counts are
re-frozen after concurrent work stabilizes; the ledger, not a filename
heuristic, is authoritative.

Documentation is not scoped by a keyword-only search. The audit first freezes
the complete Markdown universe (`AGENTS.md` plus every `docs/**/*.md` file),
reads and classifies it, and then publishes coverage only for the exact subset
that governs, describes, plans, validates, or makes maturity claims about the
in-scope FEM workflows. Each exclusion receives a read-based reason in the
ignored selection ledger. The final document denominator is the selected list,
not the complete Markdown universe.

The end-to-end source denominator includes only files that can author,
validate, plan, dispatch, bind, execute, report, or misrepresent in-scope FEM
behavior. Dedicated code for another discretization, frequency/modal analysis,
or unrelated UI behavior is excluded through a read-based caller-scope ledger.

Within the in-scope solver, FEM CPU and FEM GPU are distinct execution lanes.
Lane is not maturity or authority. Reference, production, bootstrap,
compatibility, and validation roles are recorded separately. A nearby CPU
implementation cannot prove GPU behavior, and source-visible GPU code cannot
establish strict-device execution or scientific validation.

The work package reports defects and proposes correction boundaries. It does
not modify solver source, public semantics, capability status, tests, build
recipes, or canonical physics notes. Remediation requires a separate approved
implementation plan and test-driven change set.

## Baseline and Concurrency Protocol

The repository is under concurrent development. A report that mixes source
states is invalid. Each evidence freeze records:

- `git rev-parse HEAD`;
- `git status --short` including untracked paths;
- committed, staged, unstaged, and untracked state;
- the exact non-frequency FEM path list and content hashes;
- the Markdown universe, document selection ledger, selected document list,
  and hashes;
- the caller universe, caller selection ledger, selected caller list, and
  hashes;
- timestamp, command, exit status, log, and artifact path for every executable
  proof.

Committed code and worktree drafts are separate evidence classes. A draft may
expose drift but cannot establish the committed canonical contract. If HEAD or
the worktree changes in an audited subsystem, that subsystem is rechecked and
its anchors, rows, and findings are refreshed before publication.

The scope-override inventory is:

| Tree | Files | Audit role |
|---|---:|---|
| `backends/fem`, complete universe | re-frozen | semantic selection input |
| directory-filtered universe, excluding `frequency_domain` subtrees | 454 | includes four dedicated frequency/eigen support files outside that subtree |
| selected FEM time-domain/static/relaxation subset | 450 | nonlinear FEM core, CPU/GPU implementations, ABI, mixed build surfaces, and time-domain tests |

The count is a planning expectation, not immutable proof. The final annex must
match the re-frozen inventory exactly.

## Authority Order

Conflicts are resolved in this order:

1. accepted governing equations and units in `docs/physics/`;
2. accepted architecture, ADR, specification, and capability contracts;
3. `AGENTS.md` and `docs/architecture/backend-golden-masterplan.md`;
4. public Python DSL and canonical `ProblemIR` semantics;
5. planner, runner, FEM ABI, and runtime provenance;
6. compiled FEM implementation and tests;
7. active plans and worktree drafts;
8. historical plans and ignored reports.

An implementation that disagrees with a higher source is a code defect unless
the higher source is internally inconsistent or physically wrong. In that
case, the audit records a documentation-contract defect and derives both
alternatives rather than silently selecting the implementation as truth.

External references are limited to primary literature, official library
documentation, and official micromagnetic benchmark definitions. External
solver source may inform comparison but is never copied.

## Audit Surfaces

### Nonlinear FEM state, fields, and interactions

The audit covers:

- mesh, magnetic-submesh, state, material, region, mask, and field-buffer
  ownership that directly affects nonlinear FEM physics;
- exchange, all time-domain demagnetization strategies, Zeeman field,
  uniaxial/PMA and cubic anisotropy, interfacial and bulk DMI, thermal Brown
  field, STT, Oersted field, and prescribed-strain magnetoelasticity; SOT is
  checked only as an unsupported FEM capability that must reject truthfully;
- field composition, direct-torque composition, per-interaction energy,
  energy density, total energy, and observable publication;
- heterogeneous material coefficients, nonmagnetic masking, boundary terms,
  normal orientation, weak-form integration, and mass projection;
- CPU/MFEM and GPU/CUDA implementations, residency, transfers, solver policy,
  residuals, gauge handling used by time-domain demag, and strict-device
  rejection/fallback behavior.

### Time integration

The audit covers:

- Gilbert-reduced LLG assembly and direct-torque addition;
- explicit Heun, RK4, BS23/RK23, Dormand-Prince RK45, and generic tableau
  dispatch that is publicly reachable for FEM;
- stage normalization, tangent projection, local/global error norm, adaptive
  acceptance and rejection, step bounds, rollback, accepted-state accounting,
  final-field freshness, time-dependent interactions, and statistics;
- stochastic amplitude, seed/replay behavior, random-field lifetime,
  rejected-step reuse/rescaling, and adaptive stochastic semantics;
- CPU/GPU parity boundaries and every advertised strict-device combination.

### Statics and relaxation

The audit covers:

- static field and energy evaluation;
- overdamped LLG relaxation;
- projected-gradient Barzilai-Borwein, nonlinear conjugate gradient, and
  tangent-plane implicit relaxation;
- tangent projection, FEM mass metric, retraction, line search, gradient
  dimensions, preconditioning, trial-state rollback, demag cache invalidation,
  final-field publication, stopping criteria, and explicit stop reason;
- conservative/nonconservative interaction legality for each minimizer.

### End-to-end contracts

Only in-scope semantics are followed through:

- `packages/fullmag-py`;
- `crates/fullmag-ir`;
- `crates/fullmag-plan`;
- `crates/fullmag-runner`;
- `crates/fullmag-fem-sys`;
- relevant public headers under `native/include`;
- capability, artifact, provenance, and API contracts that expose FEM
  time-domain or relaxation status;
- control-room resources only where they publish in-scope fields, energies,
  torque, stop reasons, warnings, execution lane, or provenance.

This is not a general frontend, geometry, or meshing audit. Such code is in
scope only when it changes the realized weak problem, material/mask assignment,
solver execution, or the truthfulness of an in-scope result.

## Physics and Numerical Checks

Every interaction and workflow is checked against the same minimum contract:

1. physical quantity and governing equation;
2. input and output SI units;
3. sign, chirality, and handedness convention;
4. strong field, weak residual, or direct-torque representation;
5. energy functional and discrete directional derivative where conservative;
6. material heterogeneity and nonmagnetic masking;
7. spatial discretization, quadrature, mass projection, and boundary terms;
8. time, stochastic, minimization, or linear-solver discretization;
9. CPU/GPU realization differences, residency, and fallback legality;
10. observables, telemetry, artifacts, stop reasons, and provenance;
11. public capability legality and rejection behavior;
12. analytical, convergence, cross-lane, and managed-runtime proof.

Dimensional analysis is mandatory. A stable expression with the wrong unit is
a defect even if a fitted time step, step length, or tolerance hides the scale
error in one fixture.

Energy-derived terms must satisfy the discrete counterpart of

`delta E = -mu0 integral Ms H_term dot delta_m dV`

for tangent perturbations under the realized FEM mass/quadrature rule. Direct
torques are excluded from energy-minimizer gradients unless an explicit work
functional is documented and implemented.

## Finding Model

Stable finding families are:

- `FEM-TD-NUM-*` and `FEM-TD-PHY-*`;
- `ABI-*`, `CAP-*`, `DOC-*`, and `VAL-*` for cross-cutting contracts.

Severity is assigned by impact:

| Severity | Meaning |
|---|---|
| P0 | Materially wrong physical result, corrupted state, or false production certification on an ordinary supported in-scope path |
| P1 | Material numerical/physical defect, silent CPU/GPU divergence, invalid fallback, or missing gate plausibly invalidating results |
| P2 | Limited-scope error, misleading diagnostic/provenance, robustness defect, or significant maintainability risk |
| P3 | Documentation hygiene, weak test structure, naming drift, or low-impact hardening issue |

Evidence state is independent of severity:

| Evidence state | Required meaning |
|---|---|
| `proven_static` | The defect follows from complete source and caller analysis |
| `proven_test` | A focused executable regression reproduces the defect |
| `proven_runtime` | The intended FEM lane reproduces it through a repository-managed runtime |
| `physics_validated` | An analytical, convergence, standard-problem, or trusted-reference comparison quantifies impact |
| `risk_requires_test` | Source evidence identifies a credible defect but runtime manifestation remains unproven |
| `documentation_drift` | Selected documents disagree with current code, higher authority, or verified runtime evidence |
| `validation_gap` | A claim lacks proof that actually measures the claimed property |

Every finding must contain:

- concise title and severity;
- affected lane, workflow, and feature;
- expected equation or numerical contract;
- actual implementation behavior;
- dimensional and sign analysis;
- exact current file and line anchors;
- complete public caller and reachability evidence;
- scientific and user-visible impact;
- existing tests and their blind spot or coverage;
- reproducer or exact missing fixture;
- recommended correction boundary;
- required post-fix managed and physical verification;
- confidence and unresolved assumptions.

Absence of a failing test is not evidence of correctness. Source presence is
not public reachability, and public reachability is not physics validation.

## Execution Phases

### Phase 0: Evidence freeze and selection ledgers

- record repository and worktree state;
- enumerate and hash the complete `backends/fem` universe, then publish a
  semantic include/exclude ledger and hash the selected time-domain subset;
- freeze the complete Markdown universe, then produce the read-based relevant
  subset and explicit exclusion ledger;
- freeze the caller universe, then produce the read-based in-scope caller
  subset and explicit exclusion ledger;
- assign every frozen in-scope backend file a subsystem owner and audit status.

Exit criterion: every frozen backend file has one owner; every Markdown and
caller-universe path has an include/exclude disposition; selected counts and
hashes are reproducible.

### Phase 1: Canonical contract extraction

- extract equations, units, signs, boundary conditions, stochastic
  conventions, integrator definitions, relaxation rules, tolerances, and
  validation promises;
- identify contradictions among selected physics notes, capability tables,
  active plans, and implementation comments;
- establish expected contracts before judging code.

Exit criterion: each in-scope feature has one explicit expected contract or a
fully derived documentation finding candidate.

### Phase 2: FEM time-domain and relaxation audit

- review all 450 currently expected semantically selected FEM files and the
  selected public caller chain;
- prove energy-field consistency, tangent/norm handling, minimizer dimensions,
  stochastic semantics, time-dependent stage handling, and CPU/GPU parity
  boundaries;
- inspect strict-device legality, transfers, caches, fallback, observables, and
  provenance;
- build focused checks for every proven or high-confidence candidate.

Exit criterion: every frozen backend row has completed physics, numerics,
reachability, test, and evidence verdicts.

### Phase 3: Documentation, capability, and provenance audit

- classify every selected document by authority and snapshot state;
- verify formulas, path freshness, implementation status, validation claims,
  managed-runtime instructions, and canonical manifest inclusion;
- compare human-readable capability claims with planner/runtime behavior;
- verify requested versus resolved FEM execution and fallback wording.

Exit criterion: every selected document has one coverage row and every conflict
has a finding or explicit historical classification.

### Phase 4: Executable validation

Focused source and semantic tests precede expensive runtime proof. Native FEM
proof uses the container-backed `justfile` route. Host CMake, Cargo, or direct
binaries may diagnose a failure but cannot close an MFEM/CUDA runtime claim.

Candidate repository-managed gates include:

- `just ensure-managed-fem-runtime`;
- `just verify-fem-relaxation-source-contract`;
- `just verify-fem-relaxation-runtime`;
- `just verify-fem-relaxation-convergence`;
- `just verify-fem-relaxation-cpu-gpu-consistency-smoke`;
- additional current `verify-fem-*` or managed headless recipes only after
  their bodies are read and shown to exercise the implicated time-domain
  interaction, integrator, relaxation algorithm, lane, and error condition.

Running a named gate is not automatic proof. A passing source-string contract
cannot close a numerical or physical claim, and a CPU result cannot close a
strict GPU claim.

### Phase 5: Synthesis and completion audit

- challenge and deduplicate findings across source, docs, and runtime;
- rank correction order by physical impact and public reachability;
- state `source_present`, `planner_legal`, `public_executable`,
  `runtime_proven`, and `physics_validated` separately;
- recheck every scope item against final inventories and selection ledgers;
- refresh hashes, exact anchors, counts, and repository state before
  publication.

Exit criterion: no in-scope source, selected document, interaction, integrator,
relaxation algorithm, or deliverable lacks authoritative completion evidence.

## Validation Matrix

| Area | Required proof |
|---|---|
| LLG convention | macrospin precession direction, damping energy decrease, gamma and `mu0` units |
| Norm and tangency | accepted-state norm, tangent RHS, nonmagnetic zeroing, rejected-step rollback |
| Exchange | uniform zero, manufactured or plane-wave field, energy derivative, mesh convergence, heterogeneous coefficients |
| Demag | analytical shape checks, airbox/domain convergence, solver residual/gauge, strategy-specific boundary conditions |
| Zeeman | parallel/antiparallel energy, field sign, time-dependent stage evaluation |
| Anisotropy | easy-axis/easy-plane/cubic minima, axis validation, directional derivative |
| DMI | directional derivative, chirality, spiral pitch, boundary tilt, normal convention |
| Thermal | variance scaling with `dt`, volume, `Ms`, `alpha`, and gamma; seed replay; equilibrium distribution; retry semantics |
| STT | sign, polarization direction, dimensions, masking, direct-torque versus field path |
| SOT capability boundary | FEM authoring/planning requests reject explicitly; no native FEM implementation is inferred |
| Oersted | Ampere-law magnitude, current/time dependence, axis and mesh mapping |
| Magnetoelastic | prescribed-strain energy derivative, shear convention, material heterogeneity |
| Time integration | method order/tableau, adaptive acceptance/rejection, rollback, final-field freshness, all supported integrators |
| Relaxation | conservative-energy decrease where applicable, torque convergence, mass metric, Armijo/step dimensions, stop reason |
| Cross-lane | CPU/GPU comparison on identical FEM mesh, materials, interactions, solver policy, and observables |
| Standard problems | applicable official micromagnetic statics/dynamics problem with FEM mesh refinement and reference data |

Tolerance values must come from canonical notes, analytical discretization
error, convergence, or an accepted primary reference. They are never chosen
after observing output merely to produce a pass.

## Documentation Audit Rules

Each selected document receives one status:

- canonical and current;
- canonical but internally inconsistent;
- active plan;
- worktree draft;
- historical context;
- stale path or ownership;
- stale implementation status;
- unsupported validation claim;
- duplicate or superseded without clear routing.

The separate selection ledger gives every Markdown-universe path either
`include` with an in-scope contract family or `exclude` with a read-based
reason. Excluded documents do not receive final annex rows.

The audit checks at minimum:

- old `native/backends/fem` ownership claims versus current `backends/fem`;
- duplicate physics-note numbering and unclear supersession among selected
  time-domain notes;
- equations and unit symbols across LLG, thermal, energies, interactions, and
  relaxation;
- capability prose/data versus actual planner and runtime behavior;
- `implemented`, `executable`, `production`, and `validated` vocabulary;
- host-only verification instructions that conflict with managed FEM policy;
- ignored historical reports whose in-scope claims have not been revalidated.

## Deliverables

The audit produces two tracked artifacts:

1. `docs/validation/2026-07-09-backend-llg-scientific-audit.md`
   - FEM time-domain/relaxation executive verdict;
   - methodology and evidence snapshot;
   - full P0-P3 finding register;
   - per-lane, per-workflow, and per-interaction conclusions;
   - documentation/capability/provenance drift;
   - validation results and limitations;
   - ordered remediation roadmap;
   - completion audit.
2. `docs/validation/2026-07-09-backend-llg-audit-coverage.md`
   - one row per frozen non-frequency FEM backend file;
   - subsystem, lane, role, review status, findings, tests, and evidence;
   - one row per selected FEM time-domain/relaxation document;
   - selection-ledger metadata proving how both denominators were derived.

The primary report links to the coverage annex. The annex proves breadth; the
report carries scientific reasoning. Neither artifact is stored under the
normally ignored `docs/reports/` tree.

## Failure and Blocker Handling

If a runtime is unavailable, the report records the exact prerequisite and
leaves the affected claim at `risk_requires_test` or `validation_gap`. It does
not infer correctness from compilation or source contracts.

If a managed recipe fails, the full error is read before classification. A
container, driver, dependency, or permission failure is separated from a
solver regression. The same unexplained failure is not retried repeatedly
without changing the hypothesis.

If concurrent changes alter audited files or selection inputs, affected rows
and findings are marked stale and revalidated. The audit never overwrites,
stages, or commits unrelated user changes.

If two canonical documents disagree physically, the report derives both
alternatives, consults primary references, and records the conflict explicitly.

## Acceptance Criteria

The audit is complete only when all of the following are true:

- every file in the final selected `backends/fem` snapshot appears exactly once
  in the coverage annex, and every backend-universe path has one semantic
  include/exclude decision;
- every path in the frozen Markdown universe has an include/exclude decision
  and every included document appears exactly once in the annex;
- every path in the caller universe has an include/exclude decision and every
  included caller is hashed and used where relevant;
- FEM CPU/MFEM and FEM strict GPU/CUDA conclusions keep implementation role and
  maturity separate;
- static evaluation, each relaxation algorithm, deterministic time-domain LLG,
  and stochastic LLG have independent conclusions;
- every active interaction and every supported time integrator has an
  equation/unit/sign, reachability, and test assessment;
- every P0/P1 has complete reachability and either executable proof or an exact
  missing-proof classification;
- all MFEM/CUDA runtime claims use managed, container-backed `just` evidence;
- analytical, convergence, or official benchmarks support every
  `physics_validated` claim;
- capability and provenance conclusions are checked against planner/runtime
  behavior rather than documentation alone;
- final hashes, counts, anchors, and repository state are refreshed;
- neither report contains placeholders, ambiguous maturity claims, or an
  unqualified assertion of production correctness;
- the completion audit maps every objective requirement to authoritative
  evidence.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Concurrent changes invalidate evidence | Freeze and recheck affected paths; keep committed and draft states separate |
| Read-based document selection becomes an undocumented heuristic | Give every Markdown-universe path an include/exclude row and reason |
| Source-string contracts create false confidence | Inspect the measured property and require numerical/physical proof for scientific claims |
| Runtime gates are expensive | Run focused gates first, then the minimum managed scenario that proves the property |
| A fitted tolerance hides a physical defect | Require derivation, convergence, or primary reference |
| CPU/GPU differences are dismissed as precision | Compare equations, coefficients, BCs, device legality, and residency before tolerances |
| Historical reports are treated as current | Use them only as leads and revalidate every retained claim |
| Fix recommendations expand beyond the audit | Keep remediation descriptive and require a separate implementation plan |

## Final Design Decision

The active audit is exhaustive within one bounded solver family: nonlinear FEM
time-domain dynamics, statics, relaxation, and their interactions. It will not
trade breadth for a few passing tests, import evidence from excluded
workstreams, or call executable code scientifically validated without the
corresponding numerical and physical proof.
