# Backend LLG Audit FEM Frequency Domain and Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit every FEM frequency-domain backend file and its public caller/artifact chain for physical, algebraic, spectral, numerical, validation, and maturity defects in driven response and modal eigensolve.

**Architecture:** Own every `backends/fem/**/frequency_domain/**` path, derive the complex and real-block equations independently, then inspect equilibrium/tangent operators, driven CPU/GPU engines, modal CPU/GPU engines, Poisson-airbox constraints, observables, planners, tests, and managed runtime artifacts. Synthetic/dense oracles, assembled production FEM, and GPU adapters retain separate evidence identities.

**Tech Stack:** C++20, MFEM, PETSc/SLEPc, hypre, CUDA, dense/sparse/Krylov/contour/shift-invert solvers, Rust planner/runner/bindings, C ABI, repository container-backed `just` recipes.

## Global Constraints

- Audit only: do not edit frequency source, tests, examples, ABI, planners, docs, capability tables, or runtime recipes.
- Every frozen backend path containing `/frequency_domain/` receives exactly one coverage row.
- Shared non-frequency core/API files remain owned by the FEM time/relaxation plan; cite their row and exact anchors without duplicating coverage.
- Fix the expected phasor and eigenvalue convention from the frozen canonical docs before judging implementation; if canonical docs conflict, record a `DOC-*` finding and derive both alternatives.
- Driven response and modal eigensolve require independent CPU/GPU conclusions. Success in one family cannot certify the other.
- Dense/synthetic algebra is an oracle only for the algebra it constructs; it cannot certify MFEM assembly, mesh/BC/gauge, SLEPc targeting, device residency, or public runtime reachability.
- Record requested device/solver, resolved engine, assembly kind, operator source, boundary/gauge, proof mode, and fallback for every runtime artifact.
- Native FEM/MFEM/CUDA/PETSc/SLEPc proof starts with matching repository `just` recipes. Host builds/direct binaries cannot close native claims.
- Seed findings below are preliminary hypotheses from a read-only pass. Re-anchor on the frozen HEAD and retain only complete current evidence.
- Write intermediate evidence only below `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/` and preserve unrelated changes.

---

### Task 1: Partition and Classify the Frequency-Domain Source Set

**Files:**
- Read: `.fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/files.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/coverage-rows.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/metadata.md`

**Interfaces:**
- Consumes: frozen inventory and scientific contract ledger.
- Produces: exhaustive frequency work queue and annex fragment.

- [ ] **Step 1: Assert snapshot and extract deterministic ownership**

Run:

```bash
test "$(cat .fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt)" = "$(git rev-parse HEAD)"
rg '^backends/fem/.*/frequency_domain/' .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt > .fullmag/audits/2026-07-09-backend-llg/fem-frequency/files.txt
wc -l .fullmag/audits/2026-07-09-backend-llg/fem-frequency/files.txt
```

Expected: identity passes; the count later equals the number of unique frequency coverage rows.

- [ ] **Step 2: Assign source roles before assigning maturity**

Use exact path groups:

```text
backends/fem/include/frequency_domain/**: public/internal contracts and embedded docs
backends/fem/src/frequency_domain/**: shared operator, equilibrium, planner-facing, result/progress logic
backends/fem/cpu/frequency_domain/**: CPU dense, MFEM, Krylov, sparse-direct, field-split, contour, SLEPc, and modal engines
backends/fem/gpu/cuda/frequency_domain/**: GPU operator/engine/adapters
backends/fem/tests/frequency_domain/**: validation contracts and native tests
```

For each file, classify `reference`, `production`, `bootstrap`, `validation`, `compatibility`, `generated`, or `embedded_doc` from its callers and build registration, not its filename.

- [ ] **Step 3: Create and verify one initial row per path**

Run after writing rows:

```bash
sed -n 's/^| `\(backends\/fem\/[^`]*\/frequency_domain\/[^`]*\)`.*/\1/p' .fullmag/audits/2026-07-09-backend-llg/fem-frequency/coverage-rows.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/fem-frequency/covered-files.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/fem-frequency/files.txt .fullmag/audits/2026-07-09-backend-llg/fem-frequency/covered-files.txt
```

Expected: no output.

### Task 2: Derive and Lock the Frequency-Domain Algebra

**Files:**
- Read: `.fullmag/audits/2026-07-09-backend-llg/contracts/contract-ledger.md`
- Read: `docs/physics/0600-fem-eigenmodes-linearized-llg.md`
- Read: `docs/physics/0600-fem-eigenmodes.md`
- Read: `docs/physics/0700-frequency-domain-linearized-llg.md`
- Read: `docs/physics/0828-fem-frequency-domain-floquet-demag.md`
- Read: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- Read: `docs/physics/frequency_domain_solver_physics.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/algebra-oracle.md`

**Interfaces:**
- Consumes: frozen canonical docs and common LLG convention.
- Produces: hand-derived oracle for all operator/solver audits.

- [ ] **Step 1: Derive the tangent linearization from nonlinear LLG**

Starting from the frozen common LLG convention, derive equilibrium conditions, tangent basis, constrained perturbation, stiffness/Jacobian `L`, gyrotropic/mass operator `B`, damping, excitation, and dynamic demag. Track every sign, `i`, `omega`, gamma, `mu0`, Ms, and unit.

- [ ] **Step 2: Derive driven and modal equations under the chosen phasor**

Write the exact complex driven equation, generalized eigenproblem, relation between lambda and physical frequency/damping, positive-frequency branch, and the corresponding real 2x2 block system. Expand the block multiplication explicitly so a global RHS/solution sign cannot hide behind notation.

- [ ] **Step 3: Derive observables independently**

Derive susceptibility, phase, absorbed power, linewidth, residual norm, Poisson constraint residual, scalar-potential gauge residual, modal normalization, orthogonality/biorthogonality, conjugate pairing, deduplication, and interval/window completeness. State which quantities must be nonnegative and under what damping/phasor convention.

- [ ] **Step 4: Derive two minimal independent oracles**

1. A damped macrospin with an analytic complex response, resonance phase, positive absorbed power, and eigenvalues.
2. A separated two-frequency small matrix whose requested target/window selects different modes depending on real versus imaginary spectral targeting.

Record exact matrices, eigenpairs, response vectors, and residuals in `algebra-oracle.md`; these numbers must be computed from the derivation, not copied from implementation tests.

- [ ] **Step 5: Record unresolved canonical conflicts as findings**

If current committed docs disagree on `exp(+i omega t)` versus `exp(-i omega t)`, lambda mapping, power sign, or operator side, do not choose silently. Write a complete `DOC-*` candidate and identify which implementation alternatives each convention would make correct.

### Task 3: Audit Equilibrium, Tangent Frames, and Operator Terms

**Files:**
- Read: `backends/fem/include/frequency_domain/equilibrium_state.hpp`
- Read: `backends/fem/include/frequency_domain/linearization_state.hpp`
- Read: `backends/fem/include/frequency_domain/tangent_frame.hpp`
- Read: `backends/fem/include/frequency_domain/operator_contract.hpp`
- Read: `backends/fem/include/frequency_domain/operator_terms.hpp`
- Read: `backends/fem/src/frequency_domain/equilibrium_state.cpp`
- Read: `backends/fem/src/frequency_domain/linearization_state.cpp`
- Read: `backends/fem/src/frequency_domain/tangent_frame.cpp`
- Read: `backends/fem/src/frequency_domain/operator_contract.cpp`
- Read: `backends/fem/src/frequency_domain/operator_terms.cpp`
- Read: `backends/fem/src/frequency_domain/anisotropy_operator.cpp`
- Read: `backends/fem/src/frequency_domain/zeeman_operator.cpp`
- Read: `backends/fem/cpu/frequency_domain/mfem_*`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/operator-notes.md`

**Interfaces:**
- Consumes: algebra oracle and nonlinear equilibrium state contract.
- Produces: per-term assembly/apply, frame, BC, and device verdicts.

- [ ] **Step 1: Audit equilibrium handoff and H_eff0 freshness**

Trace accepted relaxed magnetization, material fields, mesh/domain revisions, active mask, H_eff0 recomputation, equilibrium torque/residual, cache invalidation, and artifact provenance. A frequency solve must not silently linearize around stale fields or a different lane's state.

- [ ] **Step 2: Audit tangent frame construction and transport**

Verify orthonormality, handedness, deterministic gauge, singular-axis handling, nonmagnetic nodes, periodic/Floquet partner transport, phase convention, mesh symmetry certificate, and CPU/GPU representation. Test whether frame changes alter physical spectra/response beyond the documented gauge transform.

- [ ] **Step 3: Audit every operator term**

For exchange, anisotropy, Zeeman/equilibrium projection, DMI, damping, gyrotropic/mass, dynamic demag, and Poisson coupling, compare strong/weak form, sign, units, coefficient/mask treatment, BC/interface terms, complex/Floquet phase, transpose/adjoint behavior, assembled versus matrix-free apply, and CPU/GPU parity.

- [ ] **Step 4: Audit operator contracts against actual implementation**

Trace every advertised `apply`, `apply_adjoint`, sparse payload, block split, Schur action, shifted solve, device Krylov, and signature/hash field to a caller and consumer. Unused validation flags or hashes cannot certify an operator.

### Task 4: Audit Driven Response Engines and Observables

**Files:**
- Read: `backends/fem/include/frequency_domain/driven_response_solver.hpp`
- Read: `backends/fem/include/frequency_domain/excitation.hpp`
- Read: `backends/fem/src/frequency_domain/driven_response_solver.cpp`
- Read: `backends/fem/src/frequency_domain/excitation.cpp`
- Read: `backends/fem/cpu/frequency_domain/dense_driven_response.cpp`
- Read: `backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp`
- Read: `backends/fem/cpu/frequency_domain/engines/**`
- Read: `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/driven-notes.md`

**Interfaces:**
- Consumes: algebra oracle and operator verdicts.
- Produces: independent CPU/GPU driven-response correctness and maturity verdicts.

- [ ] **Step 1: Trace excitation sign and units**

Derive the tangent projection of the physical microwave field/current source, its complex amplitude/phase, units, mask/region support, and RHS sign. Trace DSL/IR/ABI input through excitation assembly into every engine.

- [ ] **Step 2: Revalidate the global driven-sign seed hypothesis**

Preliminary hypothesis: the declared contract is `(i omega B - L) x = b`, while dense and production real-split CPU engines may solve `(L - i omega B) x = b`, producing `-x`; GPU local L/B applies may be correct but feed the same host block solve.

Compare the exact implemented complex equation and expanded real blocks with `algebra-oracle.md`. Test the zero-frequency susceptibility sign and analytic macrospin response. Retain a P0 only if the public supported path returns the globally negated physical solution.

- [ ] **Step 3: Revalidate absorbed-power sign and cancellation**

Preliminary hypothesis: power code may use the opposite sign from the current phasor document, so a globally negated response can accidentally produce a plausible positive/negative power. Derive power directly from time averaging; test phase, damping dependence, positivity, and energy balance without using the response solver's own sign convention as oracle.

- [ ] **Step 4: Audit each CPU engine independently**

For dense reference, matrix-free GMRES, sparse direct, field-split, Schur, and modal reduction, inspect operator/RHS, preconditioning, stopping norm, complex block layout, residual reconstruction, failure/cancellation/partial artifacts, and provenance. Record whether it is synthetic, assembled MFEM, bootstrap, or production.

- [ ] **Step 5: Audit Poisson residual and gauge diagnostics**

Preliminary hypothesis: a block Poisson residual can report zero when `rhs_phi` is zero regardless of an invalid phi. Verify numerator/denominator definition for zero RHS, manufactured nonzero phi, gauge projection, constraint reconstruction, and whether convergence gates use the reported diagnostic.

- [ ] **Step 6: Audit GPU driven response**

Trace device assembly/apply, Krylov/preconditioner ownership, host/device transfers, CSR/data construction, convergence, strict-device resolution, fallback, result download, and artifact provenance. Host solves inside a GPU-labeled path must be explicit; driven GPU status cannot imply modal GPU status.

### Task 5: Audit Modal Eigensolvers, Targeting, Constraints, and Mode Semantics

**Files:**
- Read: `backends/fem/include/frequency_domain/modal_*`
- Read: `backends/fem/include/frequency_domain/dense_*eigen*`
- Read: `backends/fem/include/frequency_domain/planner/**`
- Read: `backends/fem/src/frequency_domain/modal_eigen_solver.cpp`
- Read: `backends/fem/cpu/frequency_domain/dense_poisson_airbox_eigen_oracle.cpp`
- Read: `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp`
- Read: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- Read: `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`
- Read: `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`
- Read: `backends/fem/cpu/frequency_domain/contour_*`
- Read: `backends/fem/cpu/frequency_domain/mode_*`
- Read: `backends/fem/cpu/frequency_domain/window_partition.*`
- Read: `backends/fem/gpu/cuda/frequency_domain/**`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/modal-notes.md`

**Interfaces:**
- Consumes: modal algebra oracle and operator verdicts.
- Produces: CPU/GPU modal correctness, targeting, proof, and maturity verdicts.

- [ ] **Step 1: Audit the generalized eigenproblem and branch mapping**

Trace `A x = lambda B x` or equivalent through dense, SLEPc, contour, Schur, shift-invert, and GPU paths. Verify lambda-to-frequency/damping mapping, positive branch selection, conjugate pairing, sorting, and artifact units.

- [ ] **Step 2: Revalidate SLEPc target-axis behavior**

Preliminary hypothesis: lambda is imaginary for positive physical frequency but SLEPc uses `EPS_TARGET_MAGNITUDE` with a real `+omega` target, which cannot distinguish separated modes by imaginary frequency. Compare PETSc scalar type, `EPSSetTarget`, `EPSWhich`, spectral transform, and post-filter. Run the two-frequency oracle; record whether the requested mode is selected.

- [ ] **Step 3: Audit proof identity and production assembly**

Every successful result must say whether matrices/operators came from a synthetic fixture, dense algebra, assembled real FEM mesh, or production matrix-free path; include mesh, BC, gauge, assembly kind, and proof mode. Revalidate the hypothesis that PA-E2 or equivalent artifacts can satisfy production booleans with synthetic algebra or caller-supplied self-certifying flags.

- [ ] **Step 4: Audit residual reconstruction and conjugation**

Preliminary hypotheses: full residual may use `min(reconstructed, SLEPc-reported)` and hide a failed reconstruction; a vector may be conjugated without conjugating lambda. Recompute `||A x-lambda B x||` independently from the emitted pair, including Poisson constraint and gauge, and never replace it with the smaller of two definitions.

- [ ] **Step 5: Audit contour/window completeness**

Inspect quadrature, interval partition, tolerance floors, rank/count estimator, duplicate removal, edge modes, cluster handling, retry/subdivision, and proof that a window is complete. Revalidate whether completeness is circularly inferred from returned modes or a tolerance floor hides requested accuracy.

- [ ] **Step 6: Audit normalization, orthogonality, and deduplication**

Verify physical normalization metric, phase convention, right/left or biorthogonal modes for non-Hermitian damping, degenerate clusters, conjugate partners, mode overlap, and dedup thresholds. A right-mode-only comparison cannot certify biorthogonality.

- [ ] **Step 7: Audit GPU modal realization**

Record maximum DOFs, dense/sparse construction, convergence criterion, iteration cap, shifted-solve/apply allocations, per-iteration transfers, eigenvector output, residual reconstruction, device residency, and fallback. Revalidate preliminary concerns about a tiny fixed-size dense path, fixed iterations without convergence, per-apply CSR allocation, unused signature/linearization checks, absent eigenvectors, and dense-first sparse payload construction.

- [ ] **Step 8: Audit capability resolution order**

Trace request validation and planner branches before any early `ok`. Revalidate whether modal capability can return success before strict device, Floquet, nonzero-k, or engine checks, and whether `prefer_existing_host_krylov` fabricates GPU requested/available status. Compare requested and resolved provenance in emitted artifacts.

### Task 6: Audit Frequency Tests and Embedded Documentation

**Files:**
- Read: `backends/fem/tests/frequency_domain/**`
- Read: `backends/fem/include/frequency_domain/docs/**`
- Read: `backends/fem/CMakeLists.txt`
- Read: `scripts/test_frequency_domain_math_contract_docs.py`
- Read: `scripts/test_frequency_domain_runtime_targets.py`
- Read: `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`
- Read: `scripts/test_verify_fem_frequency_domain_runtime_artifacts.py`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/test-matrix.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/embedded-doc-notes.md`

**Interfaces:**
- Consumes: driven/modal findings and build registrations.
- Produces: exact proof/blind-spot map for every frequency test and embedded audit doc.

- [ ] **Step 1: Classify every test and artifact verifier**

Use columns:

```text
Test path | CMake/just target | Solver family | Lane/device | Synthetic or assembled fixture | Exact assertion | Independent oracle | Tolerance origin | Public caller | Result | Blind spots | Finding IDs
```

Source-string checks, self-declared JSON booleans, and shared-formula dense fixtures cannot be labeled physical validation.

- [ ] **Step 2: Inspect all bypass and self-certification branches**

Search tests, artifact writers, verifiers, and solver results for `validated`, `certified`, `proof`, `residual`, `assembled`, `production`, `gpu`, `available`, `requested`, and environment-controlled bypasses. Trace every boolean to the numerical calculation that earns it.

- [ ] **Step 3: Classify embedded docs as backend files and scientific claims**

Each embedded Markdown/Zone.Identifier path keeps its backend coverage row. For actual Markdown, assess formula/status drift against current committed physics docs, implementation, and runtime evidence. Zone.Identifier metadata is classified as an orphan/packaging artifact with an explicit note, not silently skipped.

- [ ] **Step 4: Verify canonical plan-manifest inclusion**

Check `docs/plans/active/fd_sovler_masterplan/00_README_CANONICAL_FULL_READ.md`, `14_sources_traceability.md`, and neighboring status files for every active frequency audit/plan, including file 19. A missing full-read entry is documentation drift unless the current HEAD has repaired it.

### Task 7: Run Managed Frequency-Domain Evidence Gates

**Files:**
- Read: `justfile`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/commands.tsv`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/runtime-evidence.md`

**Interfaces:**
- Consumes: test matrix and high-severity finding candidates.
- Produces: managed native source/runtime/artifact evidence.

- [ ] **Step 1: Inspect recipe bodies and establish the managed runtime**

Run:

```bash
just ensure-managed-fem-runtime
just inspect-managed-fem-frequency-domain-deps
```

Expected: current runtime manifest plus actual PETSc/SLEPc dependency versions/availability, or a fully recorded environment failure.

- [ ] **Step 2: Run common and native contract gates separately**

Run:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-contract
just verify-fem-frequency-domain-gpu
just verify-fem-frequency-domain-runtime-suite
```

Expected: full logs and artifacts retained; map each passing assertion to `test-matrix.md`. A source/JSON contract does not close algebra or physical validation by itself.

- [ ] **Step 3: Run driven-response runtime evidence**

Run:

```bash
just verify-fem-frequency-response-runtime
```

Expected: record resolved engine/device, assembly kind, frequencies, residuals, susceptibility/phase/power artifacts, and whether an independent macrospin/sign oracle is asserted. If not, retain the corresponding validation gap.

- [ ] **Step 4: Run modal oracle and production-path gates separately**

Run:

```bash
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell
just verify-fem-frequency-domain-eigen-runtime
```

Expected: each result is labeled synthetic/dense, assembled CPU/SLEPc, GPU action, Schur action, or public runtime. Do not merge their proof status. Record exact artifacts, requested/resolved lane, DOFs, mesh/BC/gauge, eigenpairs, independent residual, target/window, normalization, and completeness evidence.

- [ ] **Step 5: Apply conservative evidence states**

Use `proven_test` only when a focused independent oracle reproduces the exact issue; `proven_runtime` only for the intended public managed lane; and `physics_validated` only for analytic/convergence/benchmark evidence. A runtime that faithfully emits the wrong signed algebra is not validated.

### Task 8: Close Frequency Coverage and Handoff

**Files:**
- Finalize: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/coverage-rows.md`
- Finalize: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/findings.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/workstream-summary.md`

**Interfaces:**
- Consumes: all operator, driven, modal, test, documentation, and runtime evidence.
- Produces: synthesis-ready frequency-domain verdict.

- [ ] **Step 1: Finalize every owned row**

Every row must have `Reviewed=yes`, contract/reachability/test/evidence verdicts, finding IDs or `none`, and a meaningful role note. Embedded docs and metadata files are reviewed rather than excluded.

- [ ] **Step 2: Consolidate every mandatory seed hypothesis**

Explicitly close, retain, or downgrade: driven global sign; absorbed-power sign/cancellation; synthetic-versus-real proof identity; SLEPc target axis; self-certifying PA-E2/bypass gates; residual `min` and vector/lambda conjugation; zero-RHS Poisson residual; fabricated GPU planner status; early capability success; contour tolerance/completeness; tiny/fixed GPU modal path; per-apply allocation/transfers; unused validation signatures; absent eigenvector proof; right-only dedup/orthogonality; dense-first sparse construction; and active-plan manifest drift.

- [ ] **Step 3: Verify exhaustive unique coverage**

Run:

```bash
sed -n 's/^| `\(backends\/fem\/[^`]*\/frequency_domain\/[^`]*\)`.*/\1/p' .fullmag/audits/2026-07-09-backend-llg/fem-frequency/coverage-rows.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/fem-frequency/covered-files.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/fem-frequency/files.txt .fullmag/audits/2026-07-09-backend-llg/fem-frequency/covered-files.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/fem-frequency/covered-files.txt
rg -n '\| no \||T[B]D|TO[D]O|FIXM[E]|PLACEH[O]LDER|not yet revie[w]ed' .fullmag/audits/2026-07-09-backend-llg/fem-frequency
```

Expected: all comparisons/searches print nothing.

- [ ] **Step 4: Write independent family/lane verdicts**

Summarize CPU driven, GPU driven, CPU modal, GPU modal, equilibrium/tangent handoff, local operators, dynamic demag/Poisson, Floquet/periodic, dense/synthetic oracles, assembled production FEM, targeting, residual/gauge, normalization/orthogonality/completeness, observables/artifacts, implemented/public-executable/runtime-proven/physics-validated maturity, P0–P3 counts, and blockers.

- [ ] **Step 5: Confirm no tracked files changed**

Run:

```bash
git status --short --untracked-files=all
```

Expected: workstream evidence is ignored and unrelated changes remain untouched.
