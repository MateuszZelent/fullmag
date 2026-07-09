# FEM Time-Domain Audit Evidence and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze reproducible FEM time-domain audit inputs, derive the expected scientific contracts before judging code, select the exact relevant document and caller subsets by reading their frozen universes, and map every in-scope maturity claim to executable code and validation evidence.

**Architecture:** Freeze the complete Markdown and possible-caller universes in `.fullmag/audits/2026-07-09-backend-llg/snapshot/`, then create explicit include/exclude ledgers and hash the selected subsets. Write authority, contract, reachability, claim, and selected-document ledgers under `.fullmag/audits/2026-07-09-backend-llg/contracts/`. The FEM time/relaxation and synthesis workstreams consume only these approved inputs.

**Tech Stack:** Git, ripgrep, POSIX text tools, Markdown, Fullmag Python DSL/ProblemIR/planner/runner sources, FEM bindings, physics notes, ADR/spec/capability documents.

## Scope Override — 2026-07-09

This active plan covers only nonlinear FEM in the time domain, static
field/energy evaluation, relaxation/minimization, and their interactions. The
previously planned work for another discretization and for frequency/modal FEM
is excluded. Preliminary evidence from those historical workstreams must not be
imported into the selected document set, caller map, claim ledger, finding set,
or final reports.

## Global Constraints

- This plan reads and classifies evidence only; it must not edit canonical docs, solver code, tests, examples, generated contracts, or capabilities.
- Use the authority order from `docs/superpowers/specs/2026-07-09-backend-llg-scientific-audit-design.md`; a lower layer never silently overrides a higher layer.
- Freeze the complete Markdown universe, but publish coverage only for the exact read-based FEM time-domain/relaxation subset.
- Give every Markdown-universe path one `include` or `exclude` selection row with a concrete reason derived from reading the file. Keyword-only inclusion/exclusion is invalid.
- Build an equivalent read-based ledger for possible end-to-end source files. Include only paths that can author, validate, plan, dispatch, bind, execute, report, or misrepresent an in-scope FEM workflow.
- Embedded Markdown below the in-scope backend tree remains owned by the FEM time/relaxation workstream because it is already part of the backend denominator.
- A worktree draft may expose drift but cannot establish the committed canonical contract.
- Separate requested intent from resolved runtime and separate `source_present`, `planner_legal`, `public_executable`, `runtime_proven`, and `physics_validated`.
- Resolve disputed equations with primary literature or official project/library documentation; record the derivation and affected contract, not only a URL.
- Preserve unrelated worktree changes and write intermediate evidence only below the ignored audit root.

---

### Task 1: Verify and Extend the Frozen Snapshot

**Files:**
- Verify: `.fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt`
- Verify: `.fullmag/audits/2026-07-09-backend-llg/snapshot/status.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe-sha256.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/document-scope.tsv`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/contracts/selected-document-files.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/contracts/selected-document-file-sha256.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-universe.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-universe-sha256.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-scope.tsv`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/contracts/selected-caller-files.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/contracts/selected-caller-file-sha256.txt`

**Interfaces:**
- Consumes: master-plan backend snapshot and current repository tree.
- Produces: complete universes, read-based selection ledgers, and exact selected inputs used downstream.

- [ ] **Step 1: Assert snapshot identity**

Run:

```bash
test "$(cat .fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt)" = "$(git rev-parse HEAD)"
git status --porcelain=v1 --untracked-files=all | cmp - .fullmag/audits/2026-07-09-backend-llg/snapshot/status.txt
git diff --binary HEAD | cmp - .fullmag/audits/2026-07-09-backend-llg/snapshot/head-to-worktree.patch
git diff --cached --binary | cmp - .fullmag/audits/2026-07-09-backend-llg/snapshot/staged.patch
git diff --binary | cmp - .fullmag/audits/2026-07-09-backend-llg/snapshot/unstaged.patch
sha256sum --check .fullmag/audits/2026-07-09-backend-llg/snapshot/worktree-state.sha256
```

Expected: all comparisons exit 0. If HEAD or the recorded tracked/worktree
state differs, repeat the master snapshot task before using existing anchors,
hashes, or conclusions.

- [ ] **Step 2: Freeze and hash the complete Markdown universe**

Run:

```bash
printf '%s\n' AGENTS.md > .fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe.txt
find docs -type f -name '*.md' ! -path 'docs/validation/2026-07-09-backend-llg-scientific-audit.md' ! -path 'docs/validation/2026-07-09-backend-llg-audit-coverage.md' -printf '%p\n' >> .fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe.txt
LC_ALL=C sort -u -o .fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe.txt .fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe.txt
while IFS= read -r p; do sha256sum "$p"; done < .fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe.txt > .fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe-sha256.txt
wc -l .fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe.txt
```

Expected: the universe contains every repository Markdown input exactly once.
Its count is selection provenance, not the final document-row denominator.

- [ ] **Step 3: Read every Markdown file and write the scope ledger**

Read each path in `document-universe.txt` from first line through EOF. Identify
its purpose, authority, formulas, solver family, validation claims, and
supersession status. Write one tab-separated row:

```text
Path<TAB>Snapshot class<TAB>Scope decision<TAB>Read-based reason
```

Do not add a header row. Determine `Snapshot class` as `untracked` when
`git ls-files --error-unmatch -- "$p"` fails; otherwise combine
`git diff --cached --quiet -- "$p"` and `git diff --quiet -- "$p"` into
`committed`, `staged`, `unstaged`, or `staged+unstaged`.

Use `include` only when the document governs, describes, plans, validates, or
makes a maturity/provenance claim about nonlinear FEM time-domain dynamics,
statics, relaxation, or an interaction consumed by those workflows. Use
`exclude` for documents dedicated to excluded solver families or unrelated
product areas. The reason must name the actual subject and why it cannot affect
the in-scope verdict.

- [ ] **Step 4: Derive and hash the exact selected document denominator**

Run:

```bash
cut -f1 .fullmag/audits/2026-07-09-backend-llg/snapshot/document-scope.tsv | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/contracts/scoped-document-universe.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe.txt .fullmag/audits/2026-07-09-backend-llg/contracts/scoped-document-universe.txt
awk -F '\t' '$3 == "include" {print $1}' .fullmag/audits/2026-07-09-backend-llg/snapshot/document-scope.tsv | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/contracts/selected-document-files.txt
awk -F '\t' 'NF < 4 || $2 !~ /^(committed|staged|unstaged|staged\+unstaged|untracked)$/ || ($3 != "include" && $3 != "exclude") || $4 == "" {bad=1} END {exit bad}' .fullmag/audits/2026-07-09-backend-llg/snapshot/document-scope.tsv
while IFS= read -r p; do sha256sum "$p"; done < .fullmag/audits/2026-07-09-backend-llg/contracts/selected-document-files.txt > .fullmag/audits/2026-07-09-backend-llg/contracts/selected-document-file-sha256.txt
wc -l .fullmag/audits/2026-07-09-backend-llg/contracts/selected-document-files.txt
```

Expected: `comm` prints nothing; schema check exits 0; the reported count is
the exact final document-row denominator.

- [ ] **Step 5: Freeze the possible end-to-end source universe**

Run:

```bash
rg --files apps/control-room packages/fullmag-py crates/fullmag-ir crates/fullmag-plan crates/fullmag-runner crates/fullmag-fdm-sys crates/fullmag-fem-sys native/include examples crates/fullmag-cli crates/fullmag-engine crates/fullmag-authoring crates/fullmag-quantities | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-universe.txt
while IFS= read -r p; do sha256sum "$p"; done < .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-universe.txt > .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-universe-sha256.txt
test "$(wc -l < .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-universe.txt)" -eq 1328
test "$(sha256sum .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-universe.txt | cut -d ' ' -f1)" = dc7264dfdcdf5866734c3fb4b257e132d2212342f50d342896492e67911840e2
```

Expected: the universe contains exactly the 1,328 paths classified by the
published reachability map. The `fullmag-fdm-sys` root is present only so every
possible public binding path receives an explicit exclusion/inclusion row; its
presence never imports FDM physics into the audit.

- [ ] **Step 6: Read/classify the caller universe and derive the selected callers**

For each universe path, inspect its role and content. Write:

```text
Path<TAB>Scope decision<TAB>Read-based reason
```

Do not add a header row.

Include a file only if it can change or report an in-scope FEM equation,
material/mask, interaction, integrator, relaxation algorithm, capability,
requested/resolved lane, strict-device rejection, artifact, observable, stop
reason, warning, or provenance. Exclude assets and code dedicated to excluded
solver families or unrelated UI behavior.

Then run:

```bash
cut -f1 .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-scope.tsv | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/contracts/scoped-caller-universe.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-universe.txt .fullmag/audits/2026-07-09-backend-llg/contracts/scoped-caller-universe.txt
awk -F '\t' '$2 == "include" {print $1}' .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-scope.tsv | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/contracts/selected-caller-files.txt
awk -F '\t' 'NF < 3 || ($2 != "include" && $2 != "exclude") || $3 == "" {bad=1} END {exit bad}' .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-scope.tsv
while IFS= read -r p; do sha256sum "$p"; done < .fullmag/audits/2026-07-09-backend-llg/contracts/selected-caller-files.txt > .fullmag/audits/2026-07-09-backend-llg/contracts/selected-caller-file-sha256.txt
```

Expected: `comm` prints nothing; schema check exits 0; each selected path has
one hash and a concrete in-scope role.

### Task 2: Build the Authority and Contract Source Map

**Files:**
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/authority-map.md`

**Interfaces:**
- Consumes: selected documents and project authority hierarchy.
- Produces: exact source set from which in-scope scientific contracts are derived.

- [ ] **Step 1: Read canonical governance and FEM architecture completely**

Read at minimum:

```text
AGENTS.md
docs/architecture/backend-golden-masterplan.md
docs/specs/native-fem-backend-architecture-v1.md
docs/specs/capability-matrix-v0.md
docs/specs/runtime-distribution-and-managed-backends-v1.md
```

Record exact section headings governing FEM CPU/GPU ownership, managed runtime,
validation vocabulary, strict-device behavior, fallback, and requested-versus-
resolved provenance.

- [ ] **Step 2: Read common LLG, unit, energy, and observable contracts**

Read at minimum:

```text
docs/physics/units.md
docs/physics/llg_conventions.md
docs/physics/0200-llg-exchange-reference-engine.md
docs/physics/0530-shared-relaxation-stop-and-field-refresh-semantics.md
docs/physics/0870-active-observable-and-energy-availability.md
docs/physics/0890-energy-density-observables.md
docs/physics/material-parameter-observables.md
```

Record equation form, gamma convention, `mu0` placement, SI units,
energy-field derivative, norm/tangency rule, masking, stop reason, and
final-field freshness.

- [ ] **Step 3: Read every selected interaction-family contract**

The required minimum set is:

```text
docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md
docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md
docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md
docs/physics/0470-fem-bulk-dmi-mfem-gpu.md
docs/physics/0570-fem-cubic-anisotropy-axis-validation.md
docs/physics/0700-shared-magnetoelastic-semantics.md
docs/physics/0720-fem-magnetoelastic-small-strain-mfem-gpu.md
docs/physics/0800-fem-static-pbc-demag.md
docs/physics/0810-fem-static-pbc-dmi.md
docs/physics/0812-fem-dmi-weak-residual-proof-fixture.md
docs/physics/0813-native-fem-dmi-weak-residual.md
docs/physics/0820-shared-spin-torque-family-and-stno-artifact-workflow.md
docs/physics/0830-prescribed-current-transport-and-source-bound-spin-torque.md
docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md
docs/physics/0850-native-fem-stt-and-generalized-oersted-from-prescribed-current.md
docs/physics/0870-fem-bem-demag-open-boundary.md
docs/physics/fem_anisotropy_uniaxial.md
docs/physics/fem_anisotropy_cubic.md
docs/physics/fem_demag_fem_bem.md
docs/physics/fem_demag_poisson.md
docs/physics/fem_dmi.md
docs/physics/fem_exchange.md
docs/physics/fem_magnetoelastic.md
docs/physics/fem_oersted.md
docs/physics/fem_thermal.md
docs/physics/fem_thermal_brown.md
```

For each family, record field or direct-torque form, energy when conservative,
material coefficients, weak form, boundary/interface terms, mass/quadrature
weighting, masking, CPU/GPU support, and unsupported combinations. If the
selection ledger contains additional governing files, read and map them too.

- [ ] **Step 4: Read relaxation, demag-policy, and validation contracts**

Read at minimum:

```text
docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md
docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md
docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md
docs/physics/0540-fem-demag-multi-model-architecture.md
docs/physics/0817-native-fem-cpu-demag-hot-path-profile.md
docs/physics/0819-native-fem-cpu-demag-hypre-solve-telemetry.md
docs/physics/0821-native-fem-cpu-demag-recovery-workspace.md
docs/physics/0822-native-fem-cpu-demag-hypre-vector-workspace.md
docs/physics/0823-native-fem-cpu-pbc-demag-reduced-warm-start.md
docs/physics/0910-permalloy-film-fem-demag-benchmark.md
```

Record algorithm definitions, metric/retraction/line-search semantics, demag
strategy and solver policy, gauge/residual meaning, stopping criteria, runtime
threading, performance claims, and validation limitations.

- [ ] **Step 5: Write the authority map**

Use one row per selected source:

```text
Path | Authority rank | Contract families | Snapshot state | Internal contradictions | Supersedes/is superseded by | Notes
```

Expected: every source used to judge code has an explicit rank and snapshot
state; contradictions are not silently collapsed.

### Task 3: Derive the Scientific Contract Ledger

**Files:**
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/contract-ledger.md`

**Interfaces:**
- Consumes: `authority-map.md` and primary references needed to resolve disputes.
- Produces: expected contracts used by the FEM time/relaxation audit.

- [ ] **Step 1: Create one complete contract row per in-scope feature**

Use this column order:

```text
Contract ID | Feature | Governing equation | Input SI units | Output SI units | Sign/handedness | Energy derivative or direct torque | Spatial/temporal discretization | BC/gauge/mask | CPU/GPU interpretation | Canonical sources | Contradictions/open question
```

Required rows are: Gilbert LLG; precession; damping; tangent projection;
accepted-state normalization; material/mask semantics; exchange; each active
time-domain demag strategy; Zeeman; uniaxial/PMA anisotropy; cubic anisotropy;
interfacial DMI; bulk DMI; thermal Brown field; adiabatic/nonadiabatic STT;
explicit SOT-on-FEM capability rejection; Oersted; prescribed-strain magnetoelasticity;
field and direct-torque composition; interaction energy; energy density; total
energy; Heun; RK4; BS23/RK23; Dormand-Prince RK45; generic tableau dispatch;
adaptive acceptance/rejection; final-field refresh; time-dependent stage
evaluation; stochastic retry/replay; overdamped LLG; projected-gradient BB;
nonlinear CG; tangent-plane implicit relaxation; cache invalidation; rollback;
stopping criterion and stop reason; requested/resolved lane and strict-device
rejection.

- [ ] **Step 2: Perform dimensional checks independently of implementation**

For every row, reduce coefficients to base SI dimensions and verify:

```text
H_eff is A/m
dm/dt and every direct torque are 1/s
energy density is J/m^3
total energy is J
time is s
current density is A/m^2
mechanical strain is dimensionless
```

Record the full dimensional chain whenever `gamma`, `gamma0`, `mu0`, nodal
volume, mass projection, or line-search scaling could conceal a convention
change.

- [ ] **Step 3: Resolve external-reference needs**

Use an official or primary source only for the disputed contract. At minimum,
consult Brown's stochastic magnetization derivation for thermal variance, the
published adaptive stochastic-LLG method claimed by retry semantics, official
NIST micromagnetic standard-problem definitions for any benchmark claim, and
official MFEM/hypre documentation when a library API or residual/gauge
interpretation is material.

For each source record bibliographic identity, stable URL/DOI, exact equation
or numerical rule, affected Fullmag contract row, and whether it resolves or
only exposes a conflict.

- [ ] **Step 4: Validate ledger completeness**

Run:

```bash
rg -n '^\| (LLG|INT|RK|RELAX|ABI)-[A-Z0-9-]+ ' .fullmag/audits/2026-07-09-backend-llg/contracts/contract-ledger.md
rg -n 'T[B]D|TO[D]O|FIXM[E]|PLACEH[O]LDER|unknown without explanatio[n]' .fullmag/audits/2026-07-09-backend-llg/contracts/contract-ledger.md
```

Expected: every required feature has one row; placeholder search prints
nothing. A genuine unresolved contract becomes a fully derived `DOC-*`
candidate.

### Task 4: Map Public Reachability, Capability, and Provenance Claims

**Files:**
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/reachability-map.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/claim-ledger.tsv`

**Interfaces:**
- Consumes: selected caller inventory and contract ledger.
- Produces: exact caller chains and machine-checkable claim inventory.

- [ ] **Step 1: Trace every public in-scope workflow from DSL to FEM ABI**

Search only the selected caller files for symbols covering discretization,
device, precision, execution mode, strictness, FEM, run/relax stages,
integrators, minimizers, interactions, thermal settings, current/strain inputs,
stopping criteria, and requested/resolved execution.

For each workflow, write the exact chain:

```text
Python DSL -> ProblemIR -> validation/normalization -> planner -> runner -> FEM sys binding -> C ABI -> backend entry point
```

Include every rejection and fallback branch that can change the selected lane
or omit an interaction.

- [ ] **Step 2: Trace fields, energies, stop reasons, and provenance back out**

Search selected planner, runner, session, API, and control-room files for
artifacts, provenance, requested/resolved lane, fallback/warnings, field,
energy, energy density, torque, residual, convergence, stop reason, and
capability publication. UI sources remain in scope only where a resource can
mislabel these values or their maturity.

- [ ] **Step 3: Build the claim ledger**

Use tab-separated fields:

```text
Claim ID<TAB>source path and line<TAB>exact claim paraphrase<TAB>lane<TAB>workflow<TAB>claimed maturity<TAB>public caller chain<TAB>managed runtime gate<TAB>physics validation<TAB>verdict<TAB>finding ID
```

Assign a unique `CLAIM-####` ID to each in-scope statement containing maturity,
lane, fallback, strictness, native execution, parity, support, or validation
language.

- [ ] **Step 4: Prove claim rows are evidence-backed**

Every non-historical claim names an exact public caller chain, a managed runtime
gate or explicit missing gate, and a physical-validation artifact or explicit
missing artifact. A source-string test can occupy the runtime field only when
the claim itself is limited to source layout.

### Task 5: Classify Every Selected Document

**Files:**
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/document-rows.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/document-findings.md`

**Interfaces:**
- Consumes: document selection/state ledger, authority map, contract ledger, claim ledger.
- Produces: one annex row per selected document and complete `DOC-*`/`CAP-*` candidates.

- [ ] **Step 1: Classify each selected document**

For every path in `contracts/selected-document-files.txt`, inspect title, status, ownership,
referenced source paths, equations, capability claims, validation claims, and
supersession links. Write one row using the master selected-document schema.
No `unrelated` classification is allowed here: unrelated files belong in the
selection ledger with `exclude`.

- [ ] **Step 2: Run targeted drift searches as a cross-check**

Run:

```bash
xargs -d '\n' rg -n 'native/backends/fem|host cargo|host cmake|docker compose|production[- ]ready|fully validated|CPU/GPU parity|silent fallback|gamma0|mu0|energy density|stop reason|Armijo|Barzilai|thermal' -- < .fullmag/audits/2026-07-09-backend-llg/contracts/selected-document-files.txt
xargs -d '\n' rg -n '^# .*0510|^# .*0530|^# .*0532|^# .*0700|^# .*0800|^# .*0810|^# .*0870|^# .*0910' -- < .fullmag/audits/2026-07-09-backend-llg/contracts/selected-document-files.txt
```

Expected: every relevant hit maps to a selected row and, when contradictory or
stale, to a `DOC-*` or `CAP-*` candidate. Duplicate-number search results that
belong only to excluded documents remain documented in `document-scope.tsv` and
do not expand the active audit.

- [ ] **Step 3: Write complete documentation finding records**

Use the master finding template. Identify the higher authority, current source,
or managed evidence that conflicts, and distinguish stale wording from a
physically wrong equation.

- [ ] **Step 4: Verify exact selected-document coverage**

Run:

```bash
sed -n 's/^| `\([^`]*\)`.*/\1/p' .fullmag/audits/2026-07-09-backend-llg/contracts/document-rows.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/contracts/covered-documents.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/contracts/selected-document-files.txt .fullmag/audits/2026-07-09-backend-llg/contracts/covered-documents.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/contracts/covered-documents.txt
```

Expected: both commands print nothing.

### Task 6: Close the Evidence/Documentation Workstream

**Files:**
- Create: `.fullmag/audits/2026-07-09-backend-llg/contracts/workstream-summary.md`

**Interfaces:**
- Consumes: all workstream evidence.
- Produces: self-contained handoff to FEM time/relaxation and final synthesis.

- [ ] **Step 1: Record the workstream verdict**

Include snapshot HEAD, worktree-state hash, Markdown-universe count, selected
document count, selection counts/reasons, caller-universe count, selected
caller count, contract IDs, unresolved contradictions, claim count by
lane/maturity, finding candidates, and exact evidence paths.

- [ ] **Step 2: Run integrity checks**

Run:

```bash
test -s .fullmag/audits/2026-07-09-backend-llg/snapshot/document-scope.tsv
test -s .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-scope.tsv
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/authority-map.md
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/contract-ledger.md
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/reachability-map.md
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/claim-ledger.tsv
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/document-rows.md
rg -n 'T[B]D|TO[D]O|FIXM[E]|PLACEH[O]LDER|not yet revie[w]ed' .fullmag/audits/2026-07-09-backend-llg/contracts
```

Expected: all `test -s` commands pass and placeholder search prints nothing.

- [ ] **Step 3: Do not commit ignored evidence**

Run:

```bash
git status --short --untracked-files=all
```

Expected: ignored audit evidence does not appear; this workstream changed no
tracked file.
