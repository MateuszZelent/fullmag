# Backend LLG Audit Validation and Synthesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revalidate, deduplicate, and publish all backend/document findings as one scientifically defensible report plus a complete source-and-document coverage annex.

**Architecture:** Treat the four ignored workstream directories as evidence inputs, require one snapshot identity, audit every P0/P1 reachability chain and proof state, then write the coverage annex before the narrative report. Final gates compare published rows with frozen inventories, refresh source anchors, and reject ambiguous maturity claims.

**Tech Stack:** Markdown, Git, ripgrep, POSIX text tools, repository `just` recipes, managed FEM runtime, existing analytical/convergence/standard-problem tests and artifacts.

## Global Constraints

- Publish exactly two tracked files: `docs/validation/2026-07-09-backend-llg-audit-coverage.md` and `docs/validation/2026-07-09-backend-llg-scientific-audit.md`.
- Do not change solver code, tests, examples, ABI, planner, runner, capability data, canonical docs, build recipes, or generated files.
- All retained findings must be valid on the same frozen HEAD; committed and worktree draft evidence remain distinct.
- Preserve stable finding families: `FDM-NUM`, `FDM-PHY`, `FEM-TD-NUM`, `FEM-TD-PHY`, `FEM-FD-NUM`, `FEM-FD-PHY`, `ABI`, `CAP`, `DOC`, and `VAL`.
- Severity and evidence state are independent; a P0 can remain `proven_static`, and a missing benchmark is not permission to lower impact.
- Every P0/P1 requires complete reachability plus focused executable proof or an explicit missing-proof state and exact fixture needed.
- Passing compilation, source strings, synthetic algebra, dense oracles, CPU neighbors, or public smokes cannot be relabeled `physics_validated`.
- Native FEM runtime conclusions use container-backed `just` evidence only.
- Every backend file and repository Markdown candidate has exactly one published coverage row; `unrelated` document rows still require a read-based reason.
- Preserve unrelated worktree changes; stage only the two final artifacts after all gates pass.

---

### Task 1: Ingest and Validate Workstream Evidence

**Files:**
- Read: `.fullmag/audits/2026-07-09-backend-llg/snapshot/**`
- Read: `.fullmag/audits/2026-07-09-backend-llg/contracts/**`
- Read: `.fullmag/audits/2026-07-09-backend-llg/fdm/**`
- Read: `.fullmag/audits/2026-07-09-backend-llg/fem-time/**`
- Read: `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/**`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/intake.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/all-finding-candidates.md`

**Interfaces:**
- Consumes: four completed workstreams.
- Produces: accepted evidence inventory and raw combined finding set.

- [ ] **Step 1: Assert required evidence exists and is nonempty**

Run:

```bash
test -s .fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt
test -s .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt
test -s .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/contract-ledger.md
test -s .fullmag/audits/2026-07-09-backend-llg/contracts/document-rows.md
test -s .fullmag/audits/2026-07-09-backend-llg/fdm/coverage-rows.md
test -s .fullmag/audits/2026-07-09-backend-llg/fem-time/coverage-rows.md
test -s .fullmag/audits/2026-07-09-backend-llg/fem-frequency/coverage-rows.md
```

Expected: every check exits 0. Missing evidence blocks synthesis; do not infer a workstream verdict from chat summaries.

- [ ] **Step 2: Verify one snapshot identity**

Run:

```bash
cat .fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt
git rev-parse HEAD
sha256sum .fullmag/audits/2026-07-09-backend-llg/snapshot/status.txt
```

Expected: both commit IDs match. Record the status-file hash in `intake.md`; if HEAD differs, re-run source hashes and every affected audit before continuing.

- [ ] **Step 3: Record workstream counts and proof inventory**

In `intake.md`, record owned file count, reviewed row count, finding count by severity/evidence state, command count, passed/failed/blocked gates, and evidence paths for documents, FDM, FEM time/relaxation, and FEM frequency/modal.

- [ ] **Step 4: Combine finding candidates without assigning final IDs yet**

Copy every complete candidate record from `contracts/document-findings.md`, `fdm/findings.md`, `fem-time/findings.md`, and `fem-frequency/findings.md` into `all-finding-candidates.md`. Preserve original provisional IDs and anchors so duplicates can be traced.

### Task 2: Deduplicate, Challenge, and Classify Findings

**Files:**
- Read: `.fullmag/audits/2026-07-09-backend-llg/validation/all-finding-candidates.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/finding-register.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/rejected-or-merged-findings.md`

**Interfaces:**
- Consumes: raw candidates, contract ledger, reachability map, test matrices, command logs.
- Produces: final unique finding set with stable IDs and an audit trail for every dropped/merged candidate.

- [ ] **Step 1: Re-derive each candidate before accepting it**

For every candidate, inspect the complete function, its inputs, all callers, all alternate dispatch branches, units, signs, masks/BCs, output consumers, and current tests. Look specifically for a copy, alias, normalization, sign convention, planner rejection, or unreachable branch that closes the alleged defect.

- [ ] **Step 2: Merge only identical root causes**

Merge CPU/GPU/doc symptoms only when one root cause and one correction boundary truly fixes all of them. Keep separate findings when severity, lane, public reachability, equation, or remediation differs. Record every merge as `old IDs -> final ID` with reason in `rejected-or-merged-findings.md`.

- [ ] **Step 3: Reject disproven candidates explicitly**

For each rejected hypothesis, record the exact current code or contract that resolves it. Do not omit it silently; this prevents a preliminary sub-review from resurfacing as an unsupported final claim.

- [ ] **Step 4: Assign final stable IDs and severity**

Number independently within each family using three digits. Apply design severity literally:

```text
P0: ordinary supported path materially corrupts/wrongly computes physical results or falsely certifies production
P1: material physical/numerical error, silent lane divergence, invalid fallback, or missing gate plausibly invalidating results
P2: limited-scope error, diagnostic/provenance/robustness defect, or significant maintenance risk
P3: documentation hygiene, weak test structure, naming/path drift, low-impact hardening
```

Do not lower severity merely because the current test suite misses the defect.

- [ ] **Step 5: Enforce the full finding schema**

Every record must include all 15 master-template fields. For exact anchors, use current `nl -ba <path>` output and cite the smallest range containing the implementation plus enough caller context to establish reachability.

### Task 3: Close P0/P1 Reachability and Proof States

**Files:**
- Read: `.fullmag/audits/2026-07-09-backend-llg/validation/finding-register.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/p0-p1-proof-matrix.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/commands.tsv`

**Interfaces:**
- Consumes: final finding register and workstream runtime evidence.
- Produces: one defensible proof disposition for every high-severity finding.

- [ ] **Step 1: Build the P0/P1 proof matrix**

Use columns:

```text
Finding ID | Lane | Public configuration | DSL-to-kernel reachability | Static proof | Focused test | Managed/public runtime | Physics oracle | Evidence state | Missing prerequisite | Required reproducer
```

No cell is blank. Use `not applicable because <reason>` only when the reason is physically or architecturally specific.

- [ ] **Step 2: Inspect existing gates before selecting more execution**

For every missing proof, read the full test and `justfile` recipe. Run it only if it reaches the exact formula, lane, precision, feature, BC/material case, and failure condition. Otherwise state why it cannot close the finding and specify the minimum future fixture.

- [ ] **Step 3: Run missing low-cost public/reference checks**

Where relevant and not already captured by a workstream, run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-backend-llg-audit-final-target cargo +nightly test -p fullmag-engine fdm
CARGO_TARGET_DIR=/tmp/fullmag-backend-llg-audit-final-target cargo +nightly test -p fullmag-runner physics_validation
just run-fdm-cpu-smoke
just fullmag build=True fdm cpu headless tests/stdprob4_dynamics.py
```

Expected: record full outputs and exact assertions. These commands can prove reference/public reachability and existing standard-problem behavior only; they cannot certify native GPU or FEM lanes.

- [ ] **Step 4: Run missing native FEM gates through `just` only**

Select from the exact recipes already audited in the FEM workstream plans. Start with:

```bash
just ensure-managed-fem-runtime
```

Then run only the matching `verify-fem-*`, `bench-fem-*`, or `fem-managed-*` recipe needed by the proof matrix. Record requested/resolved lane, runtime manifest, artifact, and asserted property.

- [ ] **Step 5: Handle failures without fighting them**

Read the complete log and classify root cause before retry. Do not repeat an unchanged command after the same failure. If the same unexplained error occurs twice, research three to five credible fixes using official/primary sources, choose the least invasive in-scope diagnostic, and record the blocker if resolution would require changing code, environment authority, or production resources.

- [ ] **Step 6: Finalize evidence states**

Use one or more evidence states per finding only when separately supported. A P0/P1 without executable proof remains valid as `proven_static` plus `risk_requires_test` or `validation_gap`, with an exact future fixture; never relabel it runtime-proven.

- [ ] **Step 7: Close the cross-backend and standard-problem matrix**

Create rows for FDM CPU/GPU, FEM CPU/GPU, and meaningful FDM/FEM convergence on the same physical geometry/material/BC with an explicit projection between discretizations. Separately assess official micromagnetic standard problems applicable to statics and dynamics, including NIST µMAG Standard Problem 4. For each row record existing runnable fixture, lanes reached, observable/time sampling, reference data, discretization refinement, tolerance origin, result, and missing proof. If the repository has no fixture that makes a scientifically valid comparison, record `VAL-*` rather than comparing unrelated meshes or workflows.

### Task 4: Build the Complete Coverage Annex

**Files:**
- Create: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`

**Interfaces:**
- Consumes: frozen inventories, finalized coverage fragments, document rows, finding register.
- Produces: authoritative breadth/completion artifact.

- [ ] **Step 1: Write annex metadata and schema**

Include: title, audit date, frozen HEAD, worktree state/hash, file/document counts, inventory commands, ownership rule, snapshot limitations, backend-row schema, document-row schema, allowed values, and a link to the primary report.

- [ ] **Step 2: Write every backend row in frozen path order**

Merge FDM, FEM time, and FEM frequency rows, replace provisional finding IDs with final IDs, and sort exactly like `snapshot/backend-files.txt`. Do not summarize directories; each file gets its own row.

- [ ] **Step 3: Write every document row in frozen path order**

Copy one finalized row per `snapshot/document-candidates.txt` entry, including `unrelated` candidates. Replace provisional finding IDs and preserve committed/worktree state.

- [ ] **Step 4: Add end-to-end chain and validation indexes**

Append compact indexes for public caller chains, command/artifact evidence, external primary sources, finding-to-file mapping, and explicit workstream ownership. These indexes supplement but never replace per-file/per-document rows.

- [ ] **Step 5: Prove exact backend coverage**

Run:

```bash
sed -n 's/^| `\(backends\/[^`]*\)`.*/\1/p' docs/validation/2026-07-09-backend-llg-audit-coverage.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/published-backend-files.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt .fullmag/audits/2026-07-09-backend-llg/validation/published-backend-files.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/validation/published-backend-files.txt
```

Expected: both commands print nothing.

- [ ] **Step 6: Prove exact document coverage**

Run:

```bash
sed -n 's/^| `\(AGENTS\.md\|docs\/[^`]*\)`.*/\1/p' docs/validation/2026-07-09-backend-llg-audit-coverage.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/published-documents.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt .fullmag/audits/2026-07-09-backend-llg/validation/published-documents.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/validation/published-documents.txt
```

Expected: both commands print nothing.

### Task 5: Write the Scientific Audit Report

**Files:**
- Create: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`

**Interfaces:**
- Consumes: final finding register, proof matrix, contracts, claims, coverage annex, and runtime logs.
- Produces: detailed scientific verdict and remediation roadmap.

- [ ] **Step 1: Write the report front matter and executive verdict**

Include frozen HEAD/worktree state, scope, exact counts, audit-only policy, evidence limitations, overall release/qualification verdict, P0–P3 counts, and the highest-impact blockers. State explicitly that absence of a finding is bounded by the evidence classes run.

- [ ] **Step 2: Write methodology and expected contracts**

Explain authority order, file/document coverage, finding severity/evidence states, dimensional/sign analysis, energy derivative, public reachability, CPU/GPU role separation, managed FEM rule, test classification, external reference policy, and tolerance policy. Summarize the chosen LLG/phasor/gamma/energy conventions with equations and SI units.

- [ ] **Step 3: Write a compact finding register followed by full records**

The compact table contains ID, severity, evidence state, lane/workflow, one-line impact, and correction boundary. Then include every complete 15-field record grouped P0, P1, P2, P3 and ordered by family/ID. Link every ID to coverage rows and validation evidence.

- [ ] **Step 4: Write per-lane maturity matrices**

Provide separate matrices for FDM CPU reference/public, native FDM GPU FP64, native FDM GPU FP32, FEM CPU/MFEM, and FEM strict GPU. For each workflow/feature state `source_present`, `planner_legal`, `public_executable`, `runtime_proven`, `physics_validated`, `blocked`, and exact evidence/finding IDs.

- [ ] **Step 5: Write per-workflow scientific conclusions**

Give independent conclusions for:

```text
static fields and energy
overdamped LLG
PG-BB
nonlinear CG
tangent-plane implicit relaxation
deterministic Heun/RK4/RK23/RK45/ABM3
stochastic LLG
driven frequency response
modal eigensolve
```

For each, cover equations/units/sign, discretization, BC/masks/materials, CPU/GPU differences, reachability, current tests, runtime evidence, physics validation, and blockers.

- [ ] **Step 6: Write per-interaction conclusions**

Cover exchange, demag (Newell/FFT, Poisson-airbox, periodic, FEM/BEM), Zeeman, uniaxial/cubic anisotropy, interfacial/bulk DMI, thermal Brown, STT/SOT, Oersted, magnetoelasticity, and frequency-domain linearized terms. Include energy-field consistency and heterogeneous-material behavior.

- [ ] **Step 7: Write documentation/capability/provenance conclusions**

Summarize canonical inconsistencies, stale paths/status, duplicate numbering/supersession, active-plan routing, machine-readable versus Markdown capability drift, requested/resolved execution, fallback, artifact semantics, and UI/resource mislabeling. Historical docs remain historical evidence, not current proof.

- [ ] **Step 8: Write validation results and missing proof**

List every command with timestamp/HEAD/exit/artifact/assertion, explain what it proves, and list blind spots. Include failed/blocked environment evidence separately from solver failures. Give the exact missing fixture for every `risk_requires_test` or `validation_gap` P0/P1.

- [ ] **Step 9: Write the ordered remediation roadmap**

Order by physical impact and public reachability. For each correction slice state affected files/layers, physics contract, test-first reproducer, managed runtime gate, physics benchmark, capability/doc updates, and dependencies. Keep this descriptive; do not implement fixes in the audit work package.

- [ ] **Step 10: Write the completion audit**

Map every objective and acceptance criterion from the design spec to a report section, annex rows, finding IDs, command/artifact, or explicit limitation. State all remaining uncertainties without softening them into production claims.

### Task 6: Refresh Anchors, Counts, and Snapshot Before Publication

**Files:**
- Verify: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`
- Verify: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/validation/final-checks.md`

**Interfaces:**
- Consumes: both draft deliverables and live checkout.
- Produces: publish/block decision.

- [ ] **Step 1: Recompute source inventory and hashes**

Run:

```bash
find backends/fdm backends/fem -type f -printf '%p\n' | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-files.txt
while IFS= read -r path; do sha256sum "$path"; done < .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-files.txt > .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-file-sha256.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-files.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-file-sha256.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-file-sha256.txt
```

Expected: empty diffs. Any changed audited file invalidates its rows/findings/tests until rechecked.

- [ ] **Step 2: Detect documentation and caller-chain drift**

Before refreshing anchors, prove that the audited documentation and caller-chain sources did not drift:

```bash
printf '%s\n' AGENTS.md > .fullmag/audits/2026-07-09-backend-llg/validation/current-document-candidates.txt
find docs -type f -name '*.md' ! -path 'docs/validation/2026-07-09-backend-llg-scientific-audit.md' ! -path 'docs/validation/2026-07-09-backend-llg-audit-coverage.md' -printf '%p\n' >> .fullmag/audits/2026-07-09-backend-llg/validation/current-document-candidates.txt
LC_ALL=C sort -u -o .fullmag/audits/2026-07-09-backend-llg/validation/current-document-candidates.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-document-candidates.txt
while IFS= read -r path; do sha256sum "$path"; done < .fullmag/audits/2026-07-09-backend-llg/validation/current-document-candidates.txt > .fullmag/audits/2026-07-09-backend-llg/validation/current-document-sha256.txt
while IFS= read -r path; do sha256sum "$path"; done < .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-files.txt > .fullmag/audits/2026-07-09-backend-llg/validation/current-end-to-end-source-sha256.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/document-candidates.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-document-candidates.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/document-sha256.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-document-sha256.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/end-to-end-source-sha256.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-end-to-end-source-sha256.txt
```

Expected: all three diffs are empty. The two new audit deliverables are deliberately excluded because they did not exist in the input snapshot. Any other document or caller drift requires reclassification/re-audit before anchor refresh.

- [ ] **Step 3: Refresh every P0/P1 anchor manually**

For each anchor, run `nl -ba <path> | sed -n '<start>,<end>p'`, confirm the quoted behavior and caller chain, and update line numbers. Record the check in `final-checks.md`.

- [ ] **Step 4: Recompute report counts from source records**

Count backend rows, document rows, findings by family/severity/evidence state, commands by result, lanes/workflows, and validation gaps. Replace manually typed counts in both deliverables and cross-check their agreement.

- [ ] **Step 5: Scan for placeholders and ambiguous maturity language**

Run:

```bash
rg -n 'T[B]D|TO[D]O|FIXM[E]|PLACEH[O]LDER|awaiting revie[w]|not yet audite[d]|probably correc[t]|appears productio[n]|fully supporte[d]' docs/validation/2026-07-09-backend-llg-{scientific-audit,audit-coverage}.md
rg -n '\b(production|validated|parity|supported)\b' docs/validation/2026-07-09-backend-llg-scientific-audit.md
```

Expected: the first search prints nothing. Review every second-search hit and qualify it with the exact evidence level/lane or rewrite it.

- [ ] **Step 6: Validate finding IDs and Markdown quality**

Run:

```bash
rg -o '^(### )?(FDM-(NUM|PHY)|FEM-(TD|FD)-(NUM|PHY)|ABI|CAP|DOC|VAL)-[0-9]{3}' docs/validation/2026-07-09-backend-llg-scientific-audit.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/finding-id-occurrences.txt
git diff --check -- docs/validation/2026-07-09-backend-llg-scientific-audit.md docs/validation/2026-07-09-backend-llg-audit-coverage.md
```

Expected: headings contain each final finding ID exactly once; other appearances are links/table references; whitespace check exits 0.

- [ ] **Step 7: Verify worktree scope**

Run:

```bash
git status --short --untracked-files=all
git diff --name-only
```

Expected: this work package's tracked changes are exactly the two audit deliverables. Existing unrelated changes remain present and untouched.

### Task 7: Hand Off for Master-Plan Commit Gate

**Files:**
- Finalize: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`
- Finalize: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`

**Interfaces:**
- Consumes: passing final checks.
- Produces: two unstaged or intentionally staged files ready for the master plan's scoped commit.

- [ ] **Step 1: Record the final publication decision**

In `final-checks.md`, state frozen/current HEAD, coverage result, document result, source-hash result, P0/P1 proof completeness, runtime blockers, placeholder result, diff result, and exact authorized tracked paths.

- [ ] **Step 2: Stop if any gate is incomplete**

Do not stage or claim completion while a backend/document row is missing, an audited hash drifted, a P0/P1 lacks reachability/proof disposition, a managed runtime claim rests on host evidence, or either report contains an ambiguous production assertion.

- [ ] **Step 3: Return to the master plan commit task**

Expected: the master plan stages and commits only the two finalized deliverables after independently repeating coverage, drift, and whitespace checks.
