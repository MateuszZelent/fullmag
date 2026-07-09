# FEM Time-Domain Audit Validation and Synthesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revalidate, challenge, deduplicate, and publish the nonlinear FEM time-domain, statics, relaxation, interaction, and selected-document findings as one scientifically defensible report plus an exact coverage annex.

**Architecture:** Ingest only the approved evidence/contracts/documentation and FEM time/relaxation workstreams, require one snapshot identity, re-derive every high-severity claim, and run the minimum managed FEM proofs that measure the implicated property. Write the coverage annex before the narrative report. Final gates compare published rows with frozen backend and selected-document inventories, verify the complete selection ledgers, refresh anchors, and reject ambiguous maturity claims.

**Tech Stack:** Markdown, Git, ripgrep, POSIX text tools, repository `just` recipes, managed FEM runtime, existing analytical/convergence/standard-problem tests and artifacts.

## Scope Override — 2026-07-09

The active synthesis covers only standard nonlinear FEM in the time domain,
static field/energy evaluation, relaxation/minimization algorithms, and their
interactions. Earlier preliminary evidence for another discretization and for
frequency/modal FEM is excluded and must not be read as an input, copied into a
finding, counted as coverage, executed as validation, or cited as proof.

## Global Constraints

- Publish exactly two tracked files: `docs/validation/2026-07-09-backend-llg-audit-coverage.md` and `docs/validation/2026-07-09-backend-llg-scientific-audit.md`.
- Both deliverables must title and describe themselves as FEM time-domain and relaxation artifacts; `backend-llg` remains only in the filenames for continuity.
- Do not change solver code, tests, examples, ABI, planner, runner, capability data, canonical docs, build recipes, or generated files.
- All retained findings must be valid on the same frozen HEAD and content hashes; committed evidence and worktree drafts remain distinct.
- Stable finding families are only `FEM-TD-NUM`, `FEM-TD-PHY`, `ABI`, `CAP`, `DOC`, and `VAL`.
- Severity and evidence state are independent; a P0 can remain `proven_static`, and a missing benchmark does not lower physical impact.
- Every P0/P1 requires complete public reachability plus focused executable proof or an exact missing-proof disposition.
- Passing compilation, source strings, a synthetic algebra check, a nearby CPU path, or a public smoke cannot be relabeled `physics_validated`.
- Native FEM runtime conclusions use container-backed repository `just` evidence only.
- Every frozen non-frequency FEM backend file has exactly one published row.
- Every selected document has exactly one published row; excluded Markdown-universe files remain accounted for in the selection ledger, not as annex rows.
- Preserve unrelated worktree changes; stage only the two final artifacts after every gate and fresh whole-audit review pass.

---

### Task 1: Ingest and Validate Active Workstream Evidence

**Files:**
- Read: `.fullmag/audits/2026-07-09-backend-llg/snapshot/**`
- Read: `.fullmag/audits/2026-07-09-backend-llg/contracts/**`
- Read: `.fullmag/audits/2026-07-09-backend-llg/fem-time/**`
- Read: `.fullmag/audits/2026-07-09-backend-llg/reviews/evidence-documentation-review.md`
- Read: `.fullmag/audits/2026-07-09-backend-llg/reviews/fem-time-relaxation-review.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/intake.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/all-finding-candidates.md`

**Interfaces:**
- Consumes: two approved evidence inputs and their fresh review checkpoints.
- Produces: accepted evidence inventory and raw combined finding set.

- [ ] **Step 1: Assert required evidence exists and is nonempty**

Run:

```bash
test -s .fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt
test -s .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt
test -s .fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe.txt
test -s .fullmag/audits/2026-07-09-backend-llg/snapshot/document-scope.tsv
test -s .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt
test -s .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-scope.tsv
test -s .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-files.txt
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/contract-ledger.md
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/document-rows.md
test -s .fullmag/audits/2026-07-09-backend-llg/fem-time/coverage-rows.md
test -s .fullmag/audits/2026-07-09-backend-llg/reviews/evidence-documentation-review.md
test -s .fullmag/audits/2026-07-09-backend-llg/reviews/fem-time-relaxation-review.md
```

Expected: every check exits 0. Missing evidence or a non-approved review blocks
synthesis; chat summaries cannot replace files.

- [ ] **Step 2: Verify one snapshot identity and active denominator**

Run:

```bash
cat .fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt
git rev-parse HEAD
sha256sum .fullmag/audits/2026-07-09-backend-llg/snapshot/status.txt
wc -l .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt
wc -l .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt
```

Expected: commit IDs match. Record the worktree-state hash and exact backend
and selected-document counts in `intake.md`. If HEAD differs, rerun hashes and
every affected audit before continuing.

- [ ] **Step 3: Prove excluded workstream evidence is absent from intake**

In `intake.md`, enumerate every consumed evidence root and review file. The
only solver evidence root is `fem-time/`. Any candidate whose sole anchors or
proof come from an excluded workstream is rejected before combination.

- [ ] **Step 4: Record workstream and proof counts**

Record owned backend count, reviewed row count, selected document count,
finding candidates by severity/evidence state, commands by result, managed
artifacts, reviewer dispositions, and exact evidence paths.

- [ ] **Step 5: Combine candidates without assigning final IDs**

Copy every complete candidate from `contracts/document-findings.md` and
`fem-time/findings.md` into `all-finding-candidates.md`. Preserve provisional
IDs and anchors so each merge or rejection can be traced.

### Task 2: Deduplicate, Challenge, and Classify Findings

**Files:**
- Read: `.fullmag/audits/2026-07-09-backend-llg/validation/all-finding-candidates.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/finding-register.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/rejected-or-merged-findings.md`

**Interfaces:**
- Consumes: raw candidates, contract/reachability/claim ledgers, tests, commands, reviewer notes.
- Produces: final unique finding set and disposition for every raw candidate.

- [ ] **Step 1: Re-derive each candidate before acceptance**

Inspect the complete function, inputs, all callers, alternate dispatch branches,
units, signs, material/masks, weak form and BCs, output consumers, caches,
residency, and current tests. Look for aliases, normalization, planner
rejection, cache invalidation, or unreachable branches that disprove the
hypothesis.

- [ ] **Step 2: Merge only identical root causes**

Merge CPU/GPU/doc symptoms only when one root cause and correction boundary
truly fixes all of them. Keep separate findings when severity, lane,
reachability, equation, or remediation differs. Record `old IDs -> final ID`
and reason.

- [ ] **Step 3: Reject disproven candidates explicitly**

For every rejected hypothesis, record exact current code or contract that
resolves it. Never omit a preliminary candidate silently.

- [ ] **Step 4: Assign stable IDs and literal severity**

Number independently within allowed families using three digits:

```text
P0: ordinary supported in-scope path materially corrupts or wrongly computes physics, or falsely certifies production
P1: material physical/numerical error, silent FEM CPU/GPU divergence, invalid fallback, or missing gate plausibly invalidating results
P2: limited-scope error, diagnostic/provenance/robustness defect, or significant maintenance risk
P3: documentation hygiene, weak test structure, naming/path drift, or low-impact hardening
```

- [ ] **Step 5: Enforce the complete finding schema and current anchors**

Every record contains all 15 master fields. Generate anchors from current
`nl -ba <path>` output and cite the smallest range that proves implementation
plus enough caller context for reachability.

### Task 3: Close P0/P1 Reachability and Proof States

**Files:**
- Read: `.fullmag/audits/2026-07-09-backend-llg/validation/finding-register.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/p0-p1-proof-matrix.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/commands.tsv`

**Interfaces:**
- Consumes: final finding register and approved workstream runtime evidence.
- Produces: one defensible proof disposition per high-severity finding.

- [ ] **Step 1: Build the P0/P1 proof matrix**

Use columns:

```text
Finding ID | Lane | Public configuration | DSL-to-backend reachability | Static proof | Focused test | Managed runtime | Physics oracle | Evidence state | Missing prerequisite | Required reproducer
```

No cell is blank. `not applicable` requires a specific physical or
architectural reason.

- [ ] **Step 2: Inspect existing gates before selecting execution**

For every missing proof, read the full test and `justfile` recipe. Run it only
if it reaches the implicated formula, lane, material, boundary condition,
interaction, integrator/relaxation algorithm, and failure condition. Otherwise
state why it cannot close the finding and specify the minimum future fixture.

- [ ] **Step 3: Run low-cost semantic/reference checks only when they close a matrix cell**

Reuse exact non-native commands already accepted by the FEM time/relaxation
workstream after reading their tests. Record full output and assertion. Treat
these as semantic, reference, or public-reachability evidence only; they cannot
certify MFEM/CUDA runtime behavior.

- [ ] **Step 4: Run missing native FEM gates through the managed route**

Start with:

```bash
just ensure-managed-fem-runtime
```

Then run only the matching time-domain/relaxation `verify-fem-*`,
`bench-fem-*`, or managed headless recipe required by the proof matrix. Record
requested/resolved lane, runtime manifest, artifact, exit code, and exact
asserted property.

- [ ] **Step 5: Handle failures without fighting them**

Read the complete log and classify root cause before retry. Do not repeat an
unchanged command after the same failure. If the same unexplained failure
occurs twice, research three to five credible fixes using official/primary
sources, choose the least invasive in-scope diagnostic, and record a blocker
when resolution requires code, new authority, or production resources.

- [ ] **Step 6: Finalize evidence states**

Use multiple evidence states only when separately supported. A P0/P1 without
executable proof remains `proven_static` plus `risk_requires_test` or
`validation_gap`, with the exact required fixture; never relabel it runtime-
proven.

- [ ] **Step 7: Close the FEM CPU/GPU and standard-problem matrix**

Create rows for FEM CPU/MFEM, FEM strict GPU/CUDA, and their comparison on the
same realized mesh, materials, interactions, solver policy, initial state, and
observables. Separately assess applicable official micromagnetic static and
dynamic standard problems. For each row record fixture, lanes reached,
observable/time sampling, reference data, mesh refinement, tolerance origin,
result, and missing proof. If no scientifically valid comparison fixture
exists, record `VAL-*` rather than comparing unrelated workflows.

### Task 4: Build the Exact Coverage Annex

**Files:**
- Create: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`

**Interfaces:**
- Consumes: frozen inventories/selections, finalized FEM coverage, selected document rows, finding register.
- Produces: authoritative FEM time-domain breadth/completion artifact.

- [ ] **Step 1: Write annex metadata and schema**

Title it as a FEM time-domain and relaxation coverage annex. Include audit date,
frozen HEAD, worktree state/hash, backend count, Markdown-universe count,
selected-document count, caller-universe/selected counts, inventory and
selection procedures, snapshot limitations, schemas, allowed values, excluded
scope, and a link to the primary report.

- [ ] **Step 2: Write every backend row in frozen order**

Use only `fem-time/coverage-rows.md`, replace provisional IDs with final IDs,
and sort exactly like `snapshot/backend-files.txt`. Do not summarize
directories; every file gets its own row.

- [ ] **Step 3: Write every selected document row in frozen order**

Copy one finalized row per `snapshot/document-candidates.txt` entry. Preserve
snapshot class and replace provisional IDs. Do not publish annex rows for
excluded universe entries; summarize their count and point to the ignored
selection ledger.

- [ ] **Step 4: Add chain and validation indexes**

Append compact indexes for selected public caller chains, command/artifact
evidence, external primary sources, finding-to-file mapping, selection counts,
and ownership. Indexes supplement but never replace per-file/document rows.

- [ ] **Step 5: Prove exact backend coverage**

Run:

```bash
sed -n 's/^| `\(backends\/fem\/[^`]*\)`.*/\1/p' docs/validation/2026-07-09-backend-llg-audit-coverage.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/published-backend-files.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt .fullmag/audits/2026-07-09-backend-llg/validation/published-backend-files.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/validation/published-backend-files.txt
```

Expected: both comparison commands print nothing.

- [ ] **Step 6: Prove exact selected-document coverage**

Run:

```bash
sed -n 's/^| `\(AGENTS\.md\|docs\/[^`]*\)`.*/\1/p' docs/validation/2026-07-09-backend-llg-audit-coverage.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/published-documents.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt .fullmag/audits/2026-07-09-backend-llg/validation/published-documents.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/validation/published-documents.txt
```

Expected: both comparison commands print nothing.

### Task 5: Write the FEM Time-Domain Scientific Audit Report

**Files:**
- Create: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`

**Interfaces:**
- Consumes: final finding register, proof matrix, contracts, claims, annex, and managed logs.
- Produces: detailed scientific verdict and remediation roadmap.

- [ ] **Step 1: Write front matter and executive verdict**

Title and scope it as the FEM time-domain, statics, and relaxation audit.
Include frozen HEAD/worktree state, exact denominators, audit-only policy,
evidence limitations, qualification verdict, P0-P3 counts, and highest-impact
blockers. State that absence of a finding is bounded by evidence run.

- [ ] **Step 2: Write methodology and expected contracts**

Explain authority order, inventory/selection completeness, severity/evidence
states, dimensional/sign analysis, energy derivative, public reachability,
CPU/GPU role separation, managed FEM rule, test classification, external
reference policy, and tolerance policy. State the chosen LLG, gamma, energy,
mass-metric, stochastic, and relaxation conventions with equations and units.

- [ ] **Step 3: Write compact and full finding registers**

The compact table contains ID, severity, evidence state, lane/workflow,
one-line impact, and correction boundary. Follow with every complete 15-field
record grouped P0-P3 and ordered by family/ID, linked to annex rows and proof.

- [ ] **Step 4: Write per-lane maturity matrices**

Provide separate matrices for FEM CPU/MFEM and FEM strict GPU/CUDA, with
reference/bootstrap/production/validation roles distinguished. For every
workflow/feature state `source_present`, `planner_legal`, `public_executable`,
`runtime_proven`, `physics_validated`, `blocked`, and exact evidence/findings.

- [ ] **Step 5: Write per-workflow conclusions**

Give independent conclusions for:

```text
static fields and energy
overdamped LLG relaxation
projected-gradient Barzilai-Borwein
nonlinear conjugate gradient
tangent-plane implicit relaxation
deterministic Heun, RK4, RK23, and RK45
stochastic LLG
```

For each, cover equations/units/sign, discretization, boundary/mask/material
semantics, CPU/GPU differences, public reachability, current tests, managed
evidence, physics validation, and blockers.

- [ ] **Step 6: Write per-interaction conclusions**

Cover exchange, each time-domain demag strategy, Zeeman, uniaxial/PMA and cubic
anisotropy, interfacial/bulk DMI, thermal Brown field, STT, Oersted, and
prescribed-strain magnetoelasticity. Include energy-field consistency,
direct-torque dimensions, material heterogeneity, masking, BCs, and CPU/GPU
support truth. Report SOT only as a public FEM capability-rejection boundary;
do not present it as a native FEM interaction.

- [ ] **Step 7: Write documentation/capability/provenance conclusions**

Summarize selected canonical inconsistencies, stale paths/status, duplicate
numbering/supersession, machine-readable versus prose capability drift,
requested/resolved lane, fallback, artifacts, stop reasons, and UI/resource
mislabeling. Excluded documents remain selection provenance, not current proof.

- [ ] **Step 8: Write validation results and missing proof**

List each command with timestamp, HEAD, exit, artifact, and asserted property;
explain what it proves and its blind spots. Separate environment blockers from
solver failures. Give the exact missing fixture for every high-severity
`risk_requires_test` or `validation_gap`.

- [ ] **Step 9: Write the ordered remediation roadmap**

Order by physical impact and public reachability. For each slice state affected
layers, physics contract, test-first reproducer, managed runtime gate, physical
benchmark, capability/doc updates, and dependencies. Do not implement fixes.

- [ ] **Step 10: Write the completion audit**

Map every objective and acceptance criterion from the design to a report
section, annex rows, finding IDs, command/artifact, or explicit limitation.
State remaining uncertainty without softening it into a production claim.

### Task 6: Refresh Hashes, Anchors, Counts, and Scope Before Publication

**Files:**
- Verify: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`
- Verify: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/final-checks.md`

**Interfaces:**
- Consumes: both draft deliverables and live checkout.
- Produces: publish/block decision.

- [ ] **Step 1: Recompute in-scope backend inventory and hashes**

Run:

```bash
find backends/fem -type f -printf '%p\n' | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-universe.txt
while IFS= read -r p; do sha256sum "$p"; done < .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-universe.txt > .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-universe-sha256.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-universe.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-universe.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-universe-sha256.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-universe-sha256.txt
while IFS=$'\t' read -r p decision reason; do if [ "$decision" = include ]; then printf '%s\n' "$p"; fi; done < .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-scope.tsv | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-files.txt
while IFS= read -r p; do sha256sum "$p"; done < .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-files.txt > .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-file-sha256.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-files.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-file-sha256.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-file-sha256.txt
```

Expected: empty diffs. Any drift invalidates affected rows/findings/tests until
rechecked.

- [ ] **Step 2: Recompute the Markdown universe and hashes**

Run:

```bash
printf '%s\n' AGENTS.md > .fullmag/audits/2026-07-09-backend-llg/validation/current-document-universe.txt
find docs -type f -name '*.md' ! -path 'docs/validation/2026-07-09-backend-llg-scientific-audit.md' ! -path 'docs/validation/2026-07-09-backend-llg-audit-coverage.md' -printf '%p\n' >> .fullmag/audits/2026-07-09-backend-llg/validation/current-document-universe.txt
LC_ALL=C sort -u -o .fullmag/audits/2026-07-09-backend-llg/validation/current-document-universe.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-document-universe.txt
while IFS= read -r p; do sha256sum "$p"; done < .fullmag/audits/2026-07-09-backend-llg/validation/current-document-universe.txt > .fullmag/audits/2026-07-09-backend-llg/validation/current-document-universe-sha256.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-document-universe.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/document-universe-sha256.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-document-universe-sha256.txt
```

Expected: empty diffs after excluding only the two new deliverables. Any other
drift requires scope reclassification and affected re-audit.

- [ ] **Step 3: Rehash selected documents and selected caller files**

Run:

```bash
while IFS= read -r p; do sha256sum "$p"; done < .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt > .fullmag/audits/2026-07-09-backend-llg/validation/current-document-sha256.txt
while IFS= read -r p; do sha256sum "$p"; done < .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-files.txt > .fullmag/audits/2026-07-09-backend-llg/validation/current-end-to-end-source-sha256.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/document-sha256.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-document-sha256.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-sha256.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-end-to-end-source-sha256.txt
```

Expected: empty diffs.

- [ ] **Step 4: Recompute the caller universe**

Run:

```bash
rg --files apps/control-room packages/fullmag-py crates/fullmag-ir crates/fullmag-plan crates/fullmag-runner crates/fullmag-fdm-sys crates/fullmag-fem-sys native/include examples crates/fullmag-cli crates/fullmag-engine crates/fullmag-authoring crates/fullmag-quantities | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/current-end-to-end-source-universe.txt
while IFS= read -r p; do sha256sum "$p"; done < .fullmag/audits/2026-07-09-backend-llg/validation/current-end-to-end-source-universe.txt > .fullmag/audits/2026-07-09-backend-llg/validation/current-end-to-end-source-universe-sha256.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-universe.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-end-to-end-source-universe.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-universe-sha256.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-end-to-end-source-universe-sha256.txt
```

Expected: empty diffs. Any caller-universe drift requires read-based
reselection before publication.

- [ ] **Step 5: Refresh every P0/P1 anchor manually**

For each anchor, run `nl -ba <path> | sed -n '<start>,<end>p'`, confirm the
behavior and caller chain, update line numbers, and record the check.

- [ ] **Step 6: Recompute all report counts from source records**

Count backend rows, selected document rows, inclusion/exclusion decisions,
findings by family/severity/evidence, commands by result, lanes/workflows, and
validation gaps. Replace manually typed counts and cross-check both reports.

- [ ] **Step 7: Scan for placeholders and ambiguous maturity language**

Run:

```bash
rg -n 'T[B]D|TO[D]O|FIXM[E]|PLACEH[O]LDER|awaiting revie[w]|not yet audite[d]|probably correc[t]|appears productio[n]|fully supporte[d]' docs/validation/2026-07-09-backend-llg-{scientific-audit,audit-coverage}.md
rg -n '\b(production|validated|parity|supported)\b' docs/validation/2026-07-09-backend-llg-scientific-audit.md
```

Expected: first search prints nothing. Qualify every second-search hit with
exact evidence level and lane.

- [ ] **Step 8: Validate IDs, Markdown, and tracked scope**

Run:

```bash
rg -o '^(### )?(FEM-TD-(NUM|PHY)|ABI|CAP|DOC|VAL)-[0-9]{3}' docs/validation/2026-07-09-backend-llg-scientific-audit.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/finding-id-occurrences.txt
git diff --check -- docs/validation/2026-07-09-backend-llg-scientific-audit.md docs/validation/2026-07-09-backend-llg-audit-coverage.md
git status --short --untracked-files=all
git diff --name-only
```

Expected: each finding has one heading; whitespace check exits 0; publication
changes are limited to two reports, with unrelated changes preserved.

### Task 7: Fresh Whole-Audit Review and Master Commit Gate

**Files:**
- Verify: `.fullmag/audits/2026-07-09-backend-llg/reviews/final-whole-audit-review.md`
- Finalize: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`
- Finalize: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`

**Interfaces:**
- Consumes: passing final checks and fresh reviewer verdict.
- Produces: two files ready for the master plan's scoped commit.

- [ ] **Step 1: Require an independent final review**

The reviewer reads the design, all active plans, frozen universes/selections,
all final evidence, both reports, and current source. It re-derives each P0/P1,
checks excluded-scope absence, verifies exact coverage, and records actionable
findings or `approved`.

- [ ] **Step 2: Record the final publication decision**

In `final-checks.md`, state frozen/current HEAD, backend/document/caller
coverage, universe and selected hash results, P0/P1 proof completeness, managed
runtime blockers, placeholder/diff results, reviewer verdict, and exact
authorized tracked paths.

- [ ] **Step 3: Stop if any gate is incomplete**

Do not stage or claim completion while a row is missing, a universe lacks a
selection disposition, an audited hash drifted, a P0/P1 lacks reachability or
proof disposition, a native FEM claim rests on host evidence, an excluded
workstream leaked into the report, or review remains unapproved.

- [ ] **Step 4: Return to the master plan commit task**

Expected: the master plan independently repeats coverage, drift, ID, and
whitespace checks, then stages only the two finalized reports.
