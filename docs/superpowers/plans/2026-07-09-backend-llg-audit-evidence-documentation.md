# Backend LLG Audit Evidence and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze a reproducible audit snapshot, derive the expected scientific contracts before judging code, classify every repository Markdown document, and map every backend maturity claim to executable code and validation evidence.

**Architecture:** Build deterministic inventories in `.fullmag/audits/2026-07-09-backend-llg/snapshot/`, then write a contract ledger and a claim ledger in `.fullmag/audits/2026-07-09-backend-llg/contracts/`. The three solver workstreams consume those ledgers; the synthesis workstream publishes their conclusions.

**Tech Stack:** Git, ripgrep, POSIX text tools, Markdown, Fullmag Python DSL/ProblemIR/planner/runner sources, physics notes, ADR/spec/capability documents.

## Global Constraints

- This plan reads and classifies evidence only; it must not edit canonical docs, solver code, tests, examples, generated contracts, or capabilities.
- Use the authority order from `docs/superpowers/specs/2026-07-09-backend-llg-scientific-audit-design.md`; a lower layer never silently overrides a higher layer.
- Every Markdown file under `docs/` is a candidate and receives one document coverage row, even when the final classification is `unrelated`.
- Embedded Markdown under `backends/` remains owned by its backend workstream because it is also part of the complete backend-file inventory.
- A worktree draft may expose drift but cannot establish the committed canonical contract.
- Separate requested intent from resolved backend/runtime, and separate `implemented`, `public_executable`, `runtime_proven`, and `physics_validated` claims.
- Resolve disputed equations with primary literature or official project/library documentation; record the source and derivation, not just a URL.
- Preserve unrelated worktree changes and write intermediate evidence only below the ignored `.fullmag/audits/2026-07-09-backend-llg/` root.

---

### Task 1: Verify and Extend the Frozen Snapshot

**Files:**
- Verify: `.fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt`
- Verify: `.fullmag/audits/2026-07-09-backend-llg/snapshot/status.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/document-state.tsv`
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/document-sha256.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-files.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-sha256.txt`

**Interfaces:**
- Consumes: master-plan snapshot and current repository tree.
- Produces: complete document and caller-chain inventories used by later tasks.

- [ ] **Step 1: Assert snapshot identity**

Run:

```bash
test "$(cat .fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt)" = "$(git rev-parse HEAD)"
git status --porcelain=v1 --untracked-files=all
```

Expected: the identity test exits 0. If HEAD differs, repeat the master snapshot task before using any existing line anchor or conclusion.

- [ ] **Step 2: Inventory every repository Markdown candidate**

Run:

```bash
printf '%s\n' AGENTS.md > .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt
find docs -type f -name '*.md' -printf '%p\n' >> .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt
LC_ALL=C sort -u -o .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt
wc -l .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt
```

Expected: the output is the exact number of rows required in the document section of the final coverage annex; no candidate is discarded by a keyword heuristic.

- [ ] **Step 3: Record each candidate's Git state**

Run:

```bash
while IFS= read -r path; do if ! git ls-files --error-unmatch "$path" >/dev/null 2>&1; then state=untracked; else staged=0; unstaged=0; git diff --cached --quiet -- "$path" || staged=1; git diff --quiet -- "$path" || unstaged=1; if [ "$staged" -eq 1 ] && [ "$unstaged" -eq 1 ]; then state=staged+unstaged; elif [ "$staged" -eq 1 ]; then state=staged; elif [ "$unstaged" -eq 1 ]; then state=unstaged; else state=committed; fi; fi; printf '%s\t%s\n' "$path" "$state"; done < .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt > .fullmag/audits/2026-07-09-backend-llg/snapshot/document-state.tsv
while IFS= read -r path; do sha256sum "$path"; done < .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt > .fullmag/audits/2026-07-09-backend-llg/snapshot/document-sha256.txt
wc -l .fullmag/audits/2026-07-09-backend-llg/snapshot/document-state.tsv
```

Expected: the count exactly matches `document-candidates.txt`; each path has one state.

- [ ] **Step 4: Inventory the out-of-backend caller chain**

Run:

```bash
rg --files packages/fullmag-py crates/fullmag-ir crates/fullmag-plan crates/fullmag-runner crates/fullmag-fdm-sys crates/fullmag-fem-sys native/include apps/control-room | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-files.txt
while IFS= read -r path; do sha256sum "$path"; done < .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-files.txt > .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-sha256.txt
```

Expected: the inventory includes the Python DSL, ProblemIR, planner, runner, both native bindings, public ABIs, and control-room sources. UI files are inspected only when they publish solver fields, observables, capability, warnings, or provenance.

### Task 2: Build the Authority and Contract Source Map

**Files:**
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/authority-map.md`

**Interfaces:**
- Consumes: document candidates and project authority hierarchy.
- Produces: exact source set from which scientific contracts are derived.

- [ ] **Step 1: Read the canonical governance and backend architecture completely**

Read:

```text
AGENTS.md
docs/architecture/backend-golden-masterplan.md
docs/specs/native-fdm-backend-architecture-v1.md
docs/specs/native-fem-backend-architecture-v1.md
docs/specs/capability-matrix-v0.md
docs/specs/runtime-distribution-and-managed-backends-v1.md
```

Record in `authority-map.md` the exact section headings governing lane ownership, managed runtime, validation status, fallbacks, and requested-versus-resolved provenance.

- [ ] **Step 2: Read the common LLG, unit, and observable contracts completely**

Read:

```text
docs/physics/units.md
docs/physics/llg_conventions.md
docs/physics/0200-llg-exchange-reference-engine.md
docs/physics/0530-shared-relaxation-stop-and-field-refresh-semantics.md
docs/physics/0870-active-observable-and-energy-availability.md
docs/physics/0890-energy-density-observables.md
```

Record the exact equation form, gamma convention, `mu0` placement, SI units, energy-field derivative, norm/tangency rule, nonmagnetic masking, stopping rule, and final-field freshness rule.

- [ ] **Step 3: Read every interaction-family canonical note**

Read all listed files, including duplicate-numbered alternatives rather than choosing one silently:

```text
docs/physics/0400-fdm-exchange-demag-zeeman.md
docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md
docs/physics/0420-fdm-dipolar-demag-foundations.md
docs/physics/0421-fdm-multilayer-convolution-demag.md
docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md
docs/physics/0440-fdm-interfacial-dmi.md
docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md
docs/physics/0460-fdm-bulk-dmi.md
docs/physics/0470-fem-bulk-dmi-mfem-gpu.md
docs/physics/0570-fem-cubic-anisotropy-axis-validation.md
docs/physics/0700-shared-magnetoelastic-semantics.md
docs/physics/0710-fdm-magnetoelastic-small-strain.md
docs/physics/0720-fem-magnetoelastic-small-strain-mfem-gpu.md
docs/physics/0820-shared-spin-torque-family-and-stno-artifact-workflow.md
docs/physics/0830-prescribed-current-transport-and-source-bound-spin-torque.md
docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md
docs/physics/0850-native-fem-stt-and-generalized-oersted-from-prescribed-current.md
docs/physics/0860-fdm-generalized-oersted-from-prescribed-current.md
docs/physics/fem_anisotropy_uniaxial.md
docs/physics/fem_anisotropy_cubic.md
docs/physics/fem_thermal.md
docs/physics/fem_thermal_brown.md
```

For each family, record field or direct-torque form, energy functional when conservative, material coefficients, interface/boundary conditions, volume or mass weighting, and unsupported combinations.

- [ ] **Step 4: Read the relaxation and frequency-domain contracts completely**

Read:

```text
docs/physics/0500-fdm-relaxation-algorithms.md
docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md
docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md
docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md
docs/physics/0540-fem-demag-multi-model-architecture.md
docs/physics/0600-fem-eigenmodes-linearized-llg.md
docs/physics/0600-fem-eigenmodes.md
docs/physics/0700-frequency-domain-linearized-llg.md
docs/physics/0828-fem-frequency-domain-floquet-demag.md
docs/physics/0830-fem-poisson-airbox-modal-eigen.md
docs/physics/frequency_domain_solver_physics.md
docs/specs/eigenmode-artifacts-v1.md
docs/specs/frequency-domain-artifacts-v2.md
```

Record contradictions explicitly, including duplicate numbering, phasor/eigenvalue convention, damping sign, excitation sign, power sign, spectral target, scalar-potential gauge, normalization, and completeness semantics.

- [ ] **Step 5: Write the authority map**

Use one row per source:

```text
Path | Authority rank | Contract families | Snapshot state | Internal contradictions | Supersedes/is superseded by | Notes
```

Expected: every source used to judge code has an explicit rank and snapshot state; duplicate or contradictory sources are not silently collapsed.

### Task 3: Derive the Scientific Contract Ledger

**Files:**
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/contract-ledger.md`

**Interfaces:**
- Consumes: `authority-map.md` and primary references required to resolve contradictions.
- Produces: expected contracts used by all three solver audits.

- [ ] **Step 1: Create one complete contract row per required feature**

Use this column order:

```text
Contract ID | Feature | Governing equation | Input SI units | Output SI units | Sign/handedness | Energy derivative or direct torque | Spatial/temporal discretization | BC/gauge/mask | FDM/FEM interpretation | CPU/GPU interpretation | Canonical sources | Contradictions/open question
```

Required feature rows are: common Gilbert LLG; precession; damping; norm/tangent projection; exchange; demag/Newell convolution; Poisson-airbox demag; periodic demag; Zeeman; uniaxial anisotropy; cubic anisotropy; interfacial DMI; bulk DMI; thermal Brown field; STT; SOT; Oersted; prescribed-strain magnetoelasticity; Heun; RK4; BS23/RK23; Dormand-Prince RK45; ABM3; adaptive acceptance/rejection; stochastic retry; overdamped LLG; projected-gradient BB; nonlinear CG; tangent-plane implicit relaxation; driven linearized LLG; modal generalized eigenproblem; dynamic demag; Floquet pairing; scalar-potential gauge; absorbed power; susceptibility; linewidth; modal normalization; orthogonality; deduplication; spectral-window completeness.

- [ ] **Step 2: Perform dimensional checks independently of implementation**

For every row, reduce coefficients to base SI dimensions and verify that:

```text
H_eff is A/m
dm/dt is 1/s
energy density is J/m^3
total energy is J
modal lambda is 1/s
angular frequency is rad/s, with radians dimensionless
absorbed power is W
```

Record the full dimensional chain when `gamma`, `gamma0`, or `mu0` can be placed in more than one convention. Do not accept a fitted time step or line-search scale as evidence that inconsistent units cancel.

- [ ] **Step 3: Resolve external-reference needs**

Use official or primary sources for only the disputed contract. At minimum, consult the official NIST µMAG Standard Problem 4 definition for dynamic sign/time-series expectations, the SLEPc manual for target/selection semantics, Brown's stochastic magnetization derivation for thermal variance, and the published adaptive stochastic-LLG method used by Fullmag's claimed retry semantics.

Record for each external source: bibliographic identity, stable URL/DOI, exact equation or solver rule used, Fullmag contract row affected, and whether the source resolves or merely exposes a conflict.

- [ ] **Step 4: Validate ledger completeness**

Run:

```bash
rg -n '^\| (LLG|INT|RK|RELAX|FD)-[A-Z0-9-]+ ' .fullmag/audits/2026-07-09-backend-llg/contracts/contract-ledger.md
rg -n 'T[B]D|TO[D]O|FIXM[E]|PLACEH[O]LDER|unknown without explanatio[n]' .fullmag/audits/2026-07-09-backend-llg/contracts/contract-ledger.md
```

Expected: every required feature has one row; the placeholder search prints nothing. A genuine unresolved contract is written as a `DOC-*` finding candidate with both alternatives derived.

### Task 4: Map Public Reachability, Capability, and Provenance Claims

**Files:**
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/reachability-map.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/claim-ledger.tsv`

**Interfaces:**
- Consumes: end-to-end source inventory and contract ledger.
- Produces: caller chains and machine-checkable claim inventory for solver findings.

- [ ] **Step 1: Trace each public solver selection from DSL to ABI**

Search:

```bash
rg -n 'discretization|device|precision|execution_mode|strict|extended|hybrid|fdm|fem|relax|integrator|frequency|eigen|driven' packages/fullmag-py crates/fullmag-ir crates/fullmag-plan crates/fullmag-runner crates/fullmag-fdm-sys crates/fullmag-fem-sys native/include
```

For each workflow, write the exact chain `Python DSL -> ProblemIR -> validation/normalization -> planner -> runner -> sys binding -> C ABI -> backend entry point`, including rejection and fallback branches.

- [ ] **Step 2: Trace status, artifacts, and observables back out**

Search:

```bash
rg -n 'artifact|provenance|resolved|requested|capabil|fallback|warning|energy|torque|field|suscept|power|linewidth|eigen|residual' crates/fullmag-plan crates/fullmag-runner crates/fullmag-session crates/fullmag-api apps/control-room docs/specs docs/validation
```

Inspect UI sources only where a resource can relabel implementation, validation, lane, energy, field, power, mode, residual, or fallback status.

- [ ] **Step 3: Build the claim ledger**

Use tab-separated fields:

```text
Claim ID<TAB>source path and line<TAB>exact claim paraphrase<TAB>lane<TAB>workflow<TAB>claimed maturity<TAB>public caller chain<TAB>runtime gate<TAB>physics validation<TAB>verdict<TAB>finding ID
```

Assign a unique `CLAIM-####` ID to every statement containing `implemented`, `supported`, `production`, `validated`, `parity`, `GPU`, `CPU`, `fallback`, `strict`, `native`, or equivalent maturity language in a relevant document or machine-readable capability source.

- [ ] **Step 4: Prove claim rows are evidence-backed**

Every non-historical claim must name an exact public caller chain, a runtime gate or explicit missing gate, and a physics-validation artifact or explicit missing artifact. A source-string test may occupy the runtime-gate field only when the claim itself is about source layout rather than numerical behavior.

### Task 5: Classify Every Document Candidate

**Files:**
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/document-rows.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/document-findings.md`

**Interfaces:**
- Consumes: document candidate/state inventories, authority map, contract ledger, claim ledger.
- Produces: one complete annex row per candidate plus `DOC-*` and `CAP-*` finding records.

- [ ] **Step 1: Read and classify each candidate**

For every path in `document-candidates.txt`, inspect the title, status, ownership, referenced source paths, equations, capability claims, validation claims, and supersession links. Write one row using the master document schema. `unrelated` requires a one-clause reason such as `frontend layout only` or `meshing geometry only`; it is not a shortcut for an unread file.

- [ ] **Step 2: Run targeted drift searches as cross-checks**

Run:

```bash
rg -n 'native/backends|frequency-domain-fem-masterplan-2026-06-11|host cargo|host cmake|docker compose|production[- ]ready|fully validated|CPU/GPU parity|silent fallback|exp\([-+]?i|lambda *=|absorbed power|gamma0|mu0' docs AGENTS.md
rg -n '^# .*0600|^# .*0700|^# .*0830|^# .*0870' docs/physics
```

Expected: every relevant hit maps to a document row and, when contradictory or stale, to a `DOC-*` or `CAP-*` candidate.

- [ ] **Step 3: Write complete finding records**

Use the master finding template. Documentation findings must quote no more text than necessary, identify the higher authority or verified implementation that conflicts, and distinguish stale wording from a physically wrong equation.

- [ ] **Step 4: Verify one-to-one document coverage**

Run:

```bash
sed -n 's/^| `\([^`]*\)`.*/\1/p' .fullmag/audits/2026-07-09-backend-llg/contracts/document-rows.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/contracts/covered-documents.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt .fullmag/audits/2026-07-09-backend-llg/contracts/covered-documents.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/contracts/covered-documents.txt
```

Expected: both commands print nothing. Missing or duplicate document rows block downstream synthesis.

### Task 6: Close the Evidence/Documentation Workstream

**Files:**
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/workstream-summary.md`

**Interfaces:**
- Consumes: all workstream evidence.
- Produces: a self-contained handoff to the three solver workstreams and final synthesis.

- [ ] **Step 1: Record the workstream verdict**

Include snapshot HEAD, worktree state hash, document candidate count, classification counts, contract IDs, open contract contradictions, claim count by lane/maturity, `DOC-*`/`CAP-*` finding candidates, and exact evidence paths.

- [ ] **Step 2: Run integrity checks**

Run:

```bash
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/authority-map.md
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/contract-ledger.md
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/reachability-map.md
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/claim-ledger.tsv
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/document-rows.md
rg -n 'T[B]D|TO[D]O|FIXM[E]|PLACEH[O]LDER|not yet revie[w]ed' .fullmag/audits/2026-07-09-backend-llg/contracts
```

Expected: all `test -s` commands pass and the placeholder search prints nothing.

- [ ] **Step 3: Do not commit ignored evidence**

Run:

```bash
git status --short --untracked-files=all
```

Expected: `.fullmag/audits/` does not appear because it is ignored; no tracked file was changed by this workstream.
