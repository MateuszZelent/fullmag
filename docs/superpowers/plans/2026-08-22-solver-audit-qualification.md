# Solver Audit Qualification And Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Połączyć cztery lane'y naprawione w osobnych planach z jednym fail-closed manifestem kwalifikacji i raportem końcowym dla wszystkich 52 findingów.

**Architecture:** Receipts są niemutowalne, source-bound i rozdzielają `requested`, `resolved` oraz `executed`. Validator buduje status z dowodów, a nie z ręcznie wpisanego `capability-matrix`. Każdy lane zachowuje własną realizację, lecz używa wspólnego schematu accepted-state, provenance i qualification scope.

**Tech Stack:** Python 3, JSON/JSON Schema-style validators, repository `justfile`, Rust/C++/CUDA receipts, Sphinx/physics source maps, Git tree hashes.

## Global Constraints

- Nie promować żadnego backendu na podstawie samego source contract, compile, planu ani pojedynczego testu.
- Receipts muszą zawierać commit, tree/diff hash, komendę, runtime image, device, precision, scope, tolerancje i artifact hashes.
- Dirty unrelated worktree (`external_solvers/3`) pozostaje nienaruszone; validator nie może go automatycznie czyścić.
- Managed/container `just` jest jedynym dowodem native FEM/CUDA.
- Brak sprzętu jest jawnie zapisanym `NOT VERIFIED`, nie sukcesem ani blockerem solvera.

---

### Task 1: Wspólny schemat receipt i validator

**Files:**
- Create: `scripts/solver_qualification_receipt.py`
- Create: `scripts/validate_solver_qualification_evidence.py`
- Create: `scripts/test_validate_solver_qualification_evidence.py`
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `docs/specs/capability-matrix-v0.json`

**Interfaces:**
- Consumes: lane receipts and final execution provenance.
- Produces: stable `SolverQualificationReceipt` schema and statuses `qualified`, `implemented_unvalidated`, `development`, `not_verified`.

- [ ] **Step 1: Write red Python fixtures.** Reject empty scope, stale commit/tree, wrong device/precision, missing artifact hash, fallback in strict mode, failed sanitizer and mismatched requested/resolved/executed.
- [ ] **Step 2: Run `python3 -m pytest scripts/test_validate_solver_qualification_evidence.py -q`; each fixture must fail for its intended reason.
- [ ] **Step 3: Implement validator and deterministic receipt hashing; never infer a missing field.
- [ ] **Step 4: Add runner final provenance record with mandatory requested/resolved/executed fields and nullable fallback reason; add serde round-trip tests.
- [ ] **Step 5: Run validator, Rust artifact/dispatch tests and current capability matrix; downgrade rows lacking receipts instead of claiming production.
- [ ] **Step 6: Commit `feat: add source-bound solver qualification receipts`.

### Task 2: Manifest-driven cross-lane matrix

**Files:**
- Create: `scripts/verify_solver_audit_matrix.py`
- Create: `scripts/test_verify_solver_audit_matrix.py`
- Modify: `justfile`
- Create: `docs/validation/2026-08-22-solver-audit-matrix.json`
- Modify: `docs/reviews/2026-08-20-public-interactions/gpt_pro/audit_1/REVIEW_CHECKLIST.md`

**Interfaces:**
- Consumes: FDM CPU/GPU and FEM CPU/GPU receipts keyed by finding, lane, integrator, layout, precision, interaction, mesh and oracle.
- Produces: one deterministic matrix verdict and per-finding evidence paths.

- [ ] **Step 1: Write red matrix tests.** Missing one required scope, mixed source hashes, duplicate receipt, wrong oracle or incomplete retry/restart evidence must fail.
- [ ] **Step 2: Run matrix tests; record all absent current scopes as expected `not_verified`.
- [ ] **Step 3: Implement manifest validation, source/tree/hash matching and deterministic JSON output.
- [ ] **Step 4: Add `just verify-solver-audit-matrix`; it calls only lane-specific managed recipes and preserves stdout/stderr/device identity.
- [ ] **Step 5: Run the matrix after lane plans complete; no manual status edit may bypass the validator.
- [ ] **Step 6: Commit `test: add full solver audit qualification matrix`.

### Task 3: Scientific docs and source-map closure

**Files:**
- Modify: `docs/physics/0406-thermal-noise.md`
- Modify: `docs/physics/0440-fdm-interfacial-dmi.md`
- Modify: `docs/physics/0460-fdm-bulk-dmi.md`
- Modify: `docs/physics/0823-native-fem-cpu-pbc-demag-reduced-warm-start.md`
- Modify: `docs/physics/0970-fdm-remediation-physical-contract.md`
- Modify: `docs/physics/0980-fem-llg-time-domain-integrators.md`
- Create/modify corresponding `*.source-map.json` files when present
- Modify: `docs/specs/capability-matrix-v0.md`

**Interfaces:**
- Consumes: final implementation symbols and receipts.
- Produces: equations/units/assumptions, FDM/FEM/CPU/GPU realization limits and no stale claim of implemented warm-start/qualification.

- [ ] **Step 1: Write red documentation/source-map validator fixtures for stale symbols, missing backend separation, missing units and contradictory qualification claims.
- [ ] **Step 2: Run the docs validators and identify exact stale sections, especially FEM PBC warm-start.
- [ ] **Step 3: Update notes only to describe implemented semantics and explicit deferred/unsupported scopes; include path-plus-symbol mapping and bibliography where required.
- [ ] **Step 4: Run scientific documentation validators, source-map checks and Sphinx docs build.
- [ ] **Step 5: Commit `docs: align solver physics and qualification evidence`.

### Task 4: Final managed gates and report

**Files:**
- Modify: `justfile`
- Create: `docs/reviews/2026-08-20-public-interactions/gpt_pro/audit_1/FINAL_REMEDIATION_REPORT.md`
- Create: `docs/reviews/2026-08-20-public-interactions/gpt_pro/audit_1/FINAL_REMEDIATION_REPORT.json`

**Interfaces:**
- Consumes: current-tree source map, all unit/native tests and immutable managed receipts.
- Produces: Polish row-by-row report for all 52 findings with status, cause, files/symbols, tests, gate and evidence artifact.

- [ ] **Step 1: Run all focused lane tests and `git diff --check`; do not summarize a test whose scope is narrower than the finding.
- [ ] **Step 2: Run managed FDM CPU/GPU and FEM CPU/GPU recipes, including sanitizer/Nsight where required; preserve exact blockers as `NOT VERIFIED`.
- [ ] **Step 3: Run `just verify-solver-audit-matrix`; validate source/tree/device/precision binding.
- [ ] **Step 4: Generate Polish Markdown/JSON report directly from validator output; include `CONFIRMED`, `PARTIALLY CONFIRMED`, `NOT VERIFIED`, `CLOSED` only with evidence.
- [ ] **Step 5: Independent review: one numerical reviewer checks equations/trajectory/rollback; one architecture reviewer checks strict residency/provenance/capability.
- [ ] **Step 6: Re-run changed tests after review fixes and commit `docs: publish solver audit remediation evidence`.

### Task 5: Completion audit

- [ ] Verify every audit entry has exactly one current status and no duplicate/missing ID.
- [ ] Verify every `CLOSED`/qualified claim links to a receipt whose source/tree hash matches current HEAD and whose scope covers the claim.
- [ ] Verify unresolved hardware lanes remain explicit and that no docs/capability row contradicts the report.
- [ ] Only after this evidence review may the active goal be marked complete.
