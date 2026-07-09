# Backend LLG Scientific Audit Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an exhaustive, evidence-backed scientific audit of every file under `backends/fdm` and `backends/fem`, every relevant solver document, and the end-to-end contracts that can change or misrepresent static relaxation, nonlinear time-domain LLG, driven response, or modal eigensolve behavior.

**Architecture:** Five workstream plans write immutable evidence fragments into the ignored `.fullmag/audits/2026-07-09-backend-llg/` directory. A final synthesis workstream revalidates every retained claim against one repository snapshot and publishes exactly two tracked artifacts: the scientific report and its complete coverage annex.

**Tech Stack:** C++20, CUDA, MFEM, hypre, libCEED, PETSc/SLEPc, Rust, Python, CMake/CTest, repository `just` recipes, Markdown, Git.

## Global Constraints

- This is an audit-only work package: do not change solver source, public semantics, capability status, canonical physics notes, tests, examples, build recipes, or generated contracts.
- Audit every file in the final `backends/` snapshot; file presence, compilation, public executability, runtime proof, and physics validation are separate statuses.
- Audit FDM CPU, FDM GPU, FEM CPU, and FEM GPU separately; within each lane, keep reference, production, bootstrap, and validation roles separate.
- Treat linearized driven response and modal eigensolve as part of the dynamics audit, with independent conclusions from nonlinear time-domain LLG.
- Record committed, staged, unstaged, and untracked state; never use a finding anchored to a different HEAD without revalidation.
- Native FEM/MFEM/CUDA/hypre/libCEED builds and runtime proof must use the matching container-backed repository `just` recipe first. Host `cargo`, `cmake`, and direct binaries are diagnostic only and cannot close a FEM runtime claim.
- Never infer correctness from a source-string contract, synthetic matrix, dense oracle, nearby CPU path, or passing smoke that does not exercise the implicated equation, lane, precision, boundary condition, and error path.
- Every tolerance must come from an equation, discretization estimate, convergence result, accepted primary reference, or canonical note; never fit a tolerance after seeing output.
- Every P0/P1 finding must include complete reachability evidence and either an executable reproducer or an explicit `risk_requires_test`/`validation_gap` classification.
- Preserve all unrelated user and concurrent worktree changes. Stage and commit only the two final audit artifacts at execution completion.
- Final tracked deliverables are only `docs/validation/2026-07-09-backend-llg-scientific-audit.md` and `docs/validation/2026-07-09-backend-llg-audit-coverage.md`.

---

## File and Workstream Map

| Path | Responsibility | Owner plan |
|---|---|---|
| `.fullmag/audits/2026-07-09-backend-llg/snapshot/` | HEAD, worktree state, inventories, counts, and hashes | evidence/documentation |
| `.fullmag/audits/2026-07-09-backend-llg/contracts/` | equation, unit, sign, boundary, maturity, and validation claim ledgers | evidence/documentation |
| `.fullmag/audits/2026-07-09-backend-llg/fdm/` | FDM coverage rows, finding records, and command evidence | FDM |
| `.fullmag/audits/2026-07-09-backend-llg/fem-time/` | non-frequency FEM coverage rows, finding records, and command evidence | FEM time/relaxation |
| `.fullmag/audits/2026-07-09-backend-llg/fem-frequency/` | frequency-domain FEM coverage rows, finding records, and command evidence | FEM frequency/modal |
| `.fullmag/audits/2026-07-09-backend-llg/validation/` | selected managed-run logs, artifact inventory, and proof matrix | validation/synthesis |
| `docs/validation/2026-07-09-backend-llg-audit-coverage.md` | one row per backend file and candidate document | validation/synthesis |
| `docs/validation/2026-07-09-backend-llg-scientific-audit.md` | scientific verdict, findings, lane maturity, limitations, and remediation order | validation/synthesis |

The deterministic source ownership rule is:

1. `backends/fdm/**` belongs to the FDM workstream.
2. `backends/fem/**/frequency_domain/**` belongs to the FEM frequency/modal workstream.
3. Every other `backends/fem/**` path belongs to the FEM time/relaxation workstream; the frequency workstream may cite shared core code but must not create a duplicate coverage row.
4. Documentation candidates and end-to-end contract files outside `backends/` belong to the evidence/documentation workstream; subsystem workstreams cite them but do not duplicate document rows.

## Shared Evidence Contracts

Every backend coverage row uses this exact column order:

```text
Path | Snapshot class | File role | Subsystem | Lane | Implementation role | Reviewed | Contract verdict | Reachability verdict | Test verdict | Evidence state | Finding IDs | Notes
```

Allowed `Snapshot class` values are `committed`, `staged`, `unstaged`, `staged+unstaged`, and `untracked`. Allowed `Implementation role` values are `reference`, `production`, `bootstrap`, `validation`, `compatibility`, `generated`, `build`, and `embedded_doc`. `Reviewed` is only `yes` or `no`; final publication forbids `no`.

Every document coverage row uses this exact column order:

```text
Path | Snapshot class | Authority | Scope | Classification | Formula/status verdict | Finding IDs | Notes
```

Allowed document classifications are `canonical_current`, `canonical_inconsistent`, `active_plan`, `worktree_draft`, `historical_context`, `stale_path`, `stale_status`, `unsupported_validation_claim`, `duplicate_or_superseded`, and `unrelated`.

Every finding record uses all of these fields in this order:

```markdown
### <stable finding ID>: <concise title>

- Severity: P0 | P1 | P2 | P3
- Evidence state: proven_static | proven_test | proven_runtime | physics_validated | risk_requires_test | documentation_drift | validation_gap
- Affected lane:
- Workflow and feature:
- Expected contract:
- Actual implementation:
- Dimensional and sign analysis:
- Exact anchors:
- Caller and reachability chain:
- Scientific and user-visible impact:
- Existing tests and blind spot:
- Reproducer or missing proof:
- Correction boundary:
- Required post-fix verification:
- Confidence and unresolved assumptions:
```

Never omit a field. If a field is inapplicable, state the physical reason; do not use an empty cell or placeholder.

Every command ledger row uses tab-separated fields:

```text
UTC timestamp<TAB>HEAD<TAB>worktree hash<TAB>command<TAB>exit code<TAB>log path<TAB>claim supported or blocked
```

## Workstream Plans

1. [`2026-07-09-backend-llg-audit-evidence-documentation.md`](2026-07-09-backend-llg-audit-evidence-documentation.md)
2. [`2026-07-09-backend-llg-audit-fdm.md`](2026-07-09-backend-llg-audit-fdm.md)
3. [`2026-07-09-backend-llg-audit-fem-time-relaxation.md`](2026-07-09-backend-llg-audit-fem-time-relaxation.md)
4. [`2026-07-09-backend-llg-audit-fem-frequency-modal.md`](2026-07-09-backend-llg-audit-fem-frequency-modal.md)
5. [`2026-07-09-backend-llg-audit-validation-synthesis.md`](2026-07-09-backend-llg-audit-validation-synthesis.md)

### Task 1: Freeze the Audit Snapshot

**Files:**
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/status.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/head-to-worktree.patch`
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/staged.patch`
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/unstaged.patch`
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/worktree-state.sha256`
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/snapshot/backend-file-sha256.txt`

**Interfaces:**
- Consumes: current Git checkout and ignored `.fullmag/` evidence root.
- Produces: immutable snapshot identity consumed by every later task.

- [ ] **Step 1: Assert that the tracked worktree is not silently dirty**

Run:

```bash
git status --short --untracked-files=all
git diff --name-only
git diff --cached --name-only
```

Expected: every changed path is visible and attributable. Do not continue if an audited tracked path is dirty without recording whether committed or worktree content is the evidence source.

- [ ] **Step 2: Create the evidence directories**

Run:

```bash
mkdir -p .fullmag/audits/2026-07-09-backend-llg/{snapshot,contracts,fdm,fem-time,fem-frequency,validation}
```

Expected: exit code 0 and all seven directories exist under the ignored `.fullmag/audits/2026-07-09-backend-llg/` root.

- [ ] **Step 3: Record repository identity and the complete worktree delta**

Run:

```bash
git rev-parse HEAD > .fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt
git status --porcelain=v1 --untracked-files=all > .fullmag/audits/2026-07-09-backend-llg/snapshot/status.txt
git diff --binary HEAD > .fullmag/audits/2026-07-09-backend-llg/snapshot/head-to-worktree.patch
git diff --cached --binary > .fullmag/audits/2026-07-09-backend-llg/snapshot/staged.patch
git diff --binary > .fullmag/audits/2026-07-09-backend-llg/snapshot/unstaged.patch
sha256sum .fullmag/audits/2026-07-09-backend-llg/snapshot/{status.txt,head-to-worktree.patch,staged.patch,unstaged.patch} > .fullmag/audits/2026-07-09-backend-llg/snapshot/worktree-state.sha256
```

Expected: `head.txt` contains one 40-character commit ID; status plus the combined, staged, and unstaged patches honestly preserve concurrent tracked differences; the checksum file fixes their identity. Untracked paths are listed in `status.txt` and receive content hashes in their owning inventory.

- [ ] **Step 4: Inventory and hash every backend file**

Run:

```bash
find backends/fdm backends/fem -type f -printf '%p\n' | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt
while IFS= read -r path; do sha256sum "$path"; done < .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt > .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-file-sha256.txt
wc -l .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt
```

Expected: the count equals the number of backend coverage rows required at synthesis; every listed path has exactly one hash row.

### Task 2: Execute the Evidence and Documentation Workstream

**Files:**
- Follow: `docs/superpowers/plans/2026-07-09-backend-llg-audit-evidence-documentation.md`

**Interfaces:**
- Consumes: Task 1 snapshot.
- Produces: contract ledger, document classification rows, claim ledger, and end-to-end reachability map.

- [ ] **Step 1: Execute every unchecked task in the evidence/documentation plan**

Expected: `contracts/contract-ledger.md`, `contracts/claim-ledger.tsv`, `snapshot/document-candidates.txt`, and `contracts/document-rows.md` exist and their completeness checks pass.

### Task 3: Execute the Three Solver Workstreams

**Files:**
- Follow: `docs/superpowers/plans/2026-07-09-backend-llg-audit-fdm.md`
- Follow: `docs/superpowers/plans/2026-07-09-backend-llg-audit-fem-time-relaxation.md`
- Follow: `docs/superpowers/plans/2026-07-09-backend-llg-audit-fem-frequency-modal.md`

**Interfaces:**
- Consumes: frozen snapshot and contract ledger.
- Produces: three mutually exclusive backend coverage fragments plus finding and test-evidence fragments.

- [ ] **Step 1: Run the workstreams against the same snapshot**

Expected: the HEAD in each workstream metadata file exactly matches `snapshot/head.txt`; otherwise re-freeze and repeat every affected workstream.

- [ ] **Step 2: Prove source ownership is exhaustive and disjoint**

Run:

```bash
sed -n 's/^| `\(backends\/[^`]*\)`.*/\1/p' .fullmag/audits/2026-07-09-backend-llg/{fdm,fem-time,fem-frequency}/coverage-rows.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/covered-backend-files.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt .fullmag/audits/2026-07-09-backend-llg/validation/covered-backend-files.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/validation/covered-backend-files.txt
```

Expected: both comparison commands print nothing. Any output is a missing or duplicate coverage row and blocks synthesis.

### Task 4: Execute Validation and Synthesis

**Files:**
- Follow: `docs/superpowers/plans/2026-07-09-backend-llg-audit-validation-synthesis.md`
- Create: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`
- Create: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`

**Interfaces:**
- Consumes: all evidence fragments and selected managed runtime logs.
- Produces: the only two tracked deliverables.

- [ ] **Step 1: Execute every unchecked task in the validation/synthesis plan**

Expected: both deliverables exist, contain no unreviewed row or placeholder, and distinguish implemented, public-executable, runtime-proven, and physics-validated status.

### Task 5: Final Snapshot and Coverage Gate

**Files:**
- Verify: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`
- Verify: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`

**Interfaces:**
- Consumes: completed deliverables and current checkout.
- Produces: publication decision.

- [ ] **Step 1: Detect audited source drift**

Run:

```bash
find backends/fdm backends/fem -type f -printf '%p\n' | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-files.txt
while IFS= read -r path; do sha256sum "$path"; done < .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-files.txt > .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-file-sha256.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-files.txt
diff -u .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-file-sha256.txt .fullmag/audits/2026-07-09-backend-llg/validation/current-backend-file-sha256.txt
```

Expected: both diffs are empty. If not, re-audit each changed path and refresh all affected findings, rows, tests, and line anchors.

- [ ] **Step 2: Detect documentation and caller-chain drift**

Before checking published rows, verify document and caller-chain inputs did not drift:

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

Expected: empty diffs; the two output audit documents are the only intentional additions excluded from the candidate recomputation.

- [ ] **Step 3: Prove the published annex covers the frozen backend inventory**

Run:

```bash
sed -n 's/^| `\(backends\/[^`]*\)`.*/\1/p' docs/validation/2026-07-09-backend-llg-audit-coverage.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/published-backend-files.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt .fullmag/audits/2026-07-09-backend-llg/validation/published-backend-files.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/validation/published-backend-files.txt
```

Expected: no output. Any missing or duplicate path blocks completion.

- [ ] **Step 4: Run document and finding integrity checks**

Run:

```bash
rg -n 'T[B]D|TO[D]O|FIXM[E]|PLACEH[O]LDER|awaiting revie[w]|not yet audite[d]|\| no \|' docs/validation/2026-07-09-backend-llg-{scientific-audit,audit-coverage}.md
rg -n '^### (FDM-(NUM|PHY)|FEM-(TD|FD)-(NUM|PHY)|ABI|CAP|DOC|VAL)-[0-9]{3}:' docs/validation/2026-07-09-backend-llg-scientific-audit.md | LC_ALL=C sort
git diff --check -- docs/validation/2026-07-09-backend-llg-scientific-audit.md docs/validation/2026-07-09-backend-llg-audit-coverage.md
```

Expected: the placeholder search prints nothing; finding IDs are unique and ordered within their family; `git diff --check` exits 0.

- [ ] **Step 5: Verify only authorized tracked files changed for this work package**

Run:

```bash
git status --short --untracked-files=all
git diff --name-only
```

Expected: audit-owned tracked changes are limited to the two deliverables. Pre-existing unrelated changes remain untouched and are called out before staging.

### Task 6: Commit the Published Audit

**Files:**
- Commit: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`
- Commit: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`

**Interfaces:**
- Consumes: Task 5 passing evidence.
- Produces: one reviewable documentation commit.

- [ ] **Step 1: Stage only the two final artifacts**

Run:

```bash
git add docs/validation/2026-07-09-backend-llg-scientific-audit.md docs/validation/2026-07-09-backend-llg-audit-coverage.md
git diff --cached --name-only
git diff --cached --check
```

Expected: exactly those two paths are staged and the whitespace check passes.

- [ ] **Step 2: Commit with the audit boundary in the message**

Run:

```bash
git commit -m "docs: publish backend LLG scientific audit"
```

Expected: one commit containing only the two tracked audit artifacts. Do not commit ignored evidence logs or unrelated worktree changes.
