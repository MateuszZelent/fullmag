# FEM Time-Domain and Relaxation Scientific Audit Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an exhaustive, evidence-backed scientific audit of every semantically selected time-domain/static/relaxation file under `backends/fem`, the exact read-based subset of relevant solver documents, and the end-to-end contracts that can change or misrepresent nonlinear FEM statics, relaxation, deterministic LLG, stochastic LLG, or their interactions.

**Architecture:** Three active workstreams write immutable evidence below the ignored `.fullmag/audits/2026-07-09-backend-llg/` root: evidence/contracts/documentation, FEM time-domain/relaxation source audit, and validation/synthesis. Each workstream uses a fresh implementer and a fresh review checkpoint. Final synthesis revalidates every retained claim against one repository snapshot and publishes exactly two tracked artifacts.

**Tech Stack:** C++20, CUDA, MFEM, hypre, libCEED, Rust, Python, CMake/CTest, repository `just` recipes, Markdown, Git.

## Scope Override — 2026-07-09

The user superseded the original broad backend scope. This active plan covers
only standard nonlinear FEM in the time domain, static field/energy evaluation,
relaxation/minimization algorithms, and the interactions they consume.

Earlier workstreams for another discretization and for frequency/modal FEM are
historical and excluded. Their plan files and preliminary evidence may remain
on disk, but no active task may execute them, ingest their coverage rows, copy
their findings, run their commands, or use them to support the final verdict.
The final artifact filenames retain `backend-llg` solely for continuity.

## Global Constraints

- This is an audit-only work package: do not change solver source, public semantics, capability status, canonical physics notes, tests, examples, build recipes, or generated contracts.
- Freeze every file under `backends/fem`, then select the nonlinear time-domain/static/relaxation subset with one semantic include/exclude row per path. Exclude `frequency_domain` subtrees and dedicated out-of-subtree modal/frequency support. The current directory-filtered universe is 454 and the selected denominator is 450; re-freeze both after concurrent work stabilizes.
- The documentation denominator is the exact read-based FEM time-domain/relaxation subset selected from the frozen Markdown universe, not the entire universe and not a keyword-only result.
- The caller denominator excludes dedicated code for other discretizations, frequency/modal analysis, and unrelated UI behavior through an explicit read-based selection ledger.
- Audit FEM CPU/MFEM and FEM GPU/CUDA separately; within each lane, keep reference, production, bootstrap, compatibility, and validation roles separate.
- Record committed, staged, unstaged, and untracked state; never retain a finding anchored to another HEAD or content hash without revalidation.
- Native FEM/MFEM/CUDA/hypre/libCEED builds and runtime proof must use the matching container-backed repository `just` recipe first. Host `cargo`, `cmake`, and direct binaries are diagnostic only.
- Never infer correctness from source strings, synthetic algebra, a nearby CPU path, or a passing smoke that does not exercise the implicated equation, lane, material, boundary condition, and error path.
- Every tolerance must come from an equation, discretization estimate, convergence result, accepted primary reference, or canonical note; never fit it after observing output.
- Every P0/P1 finding must include complete public reachability and either focused executable proof or an exact `risk_requires_test`/`validation_gap` disposition.
- Preserve all unrelated user and concurrent worktree changes. At audit publication, stage and commit only the two final validation artifacts.
- Final tracked deliverables are only `docs/validation/2026-07-09-backend-llg-scientific-audit.md` and `docs/validation/2026-07-09-backend-llg-audit-coverage.md`.

---

## File and Workstream Map

| Path | Responsibility | Owner plan |
|---|---|---|
| `.fullmag/audits/2026-07-09-backend-llg/snapshot/` | HEAD, worktree state, non-frequency FEM inventory, Markdown/caller universes, selected subsets, counts, and hashes | evidence/documentation |
| `.fullmag/audits/2026-07-09-backend-llg/contracts/` | authority, equation/unit/sign/boundary, reachability, claim, and document ledgers | evidence/documentation |
| `.fullmag/audits/2026-07-09-backend-llg/fem-time/` | complete backend coverage rows, finding records, test inventory, and command evidence | FEM time/relaxation |
| `.fullmag/audits/2026-07-09-backend-llg/reviews/` | fresh reviewer checkpoints and remediation dispositions | all active workstreams |
| `.fullmag/audits/2026-07-09-backend-llg/validation/` | managed-run logs, artifacts, proof matrix, synthesis intake, and final gates | validation/synthesis |
| `docs/validation/2026-07-09-backend-llg-audit-coverage.md` | one row per frozen backend file and selected document | validation/synthesis |
| `docs/validation/2026-07-09-backend-llg-scientific-audit.md` | FEM time-domain/relaxation verdict, findings, lane maturity, limitations, and remediation order | validation/synthesis |

The deterministic backend ownership rule is:

1. every `backends/fem/**` path receives one semantic scope decision; shared or mixed files are included with a time-domain-only verdict;
2. paths below `frequency_domain`, `cpu/mfem/runtime/eigen_dense.{cpp,hpp}`, and the dedicated `cmake/Find{PETSc,SLEPc}.cmake` frequency-dependency modules are currently excluded, receive no active coverage row, and may not be cited as time-domain proof;
3. selected documents and end-to-end files outside `backends/fem` belong to the evidence/documentation workstream; the solver workstream may cite them but does not duplicate their rows.

## Shared Evidence Contracts

Every backend coverage row uses this exact column order:

```text
Path | Snapshot class | File role | Subsystem | Lane | Implementation role | Reviewed | Contract verdict | Reachability verdict | Test verdict | Evidence state | Finding IDs | Notes
```

Allowed `Snapshot class` values are `committed`, `staged`, `unstaged`,
`staged+unstaged`, and `untracked`. Allowed `Implementation role` values are
`reference`, `production`, `bootstrap`, `validation`, `compatibility`,
`generated`, `build`, and `embedded_doc`. `Reviewed` is only `yes` or `no`;
final publication forbids `no`.

Every selected-document coverage row uses:

```text
Path | Snapshot class | Authority | Scope | Classification | Formula/status verdict | Finding IDs | Notes
```

Allowed document classifications are `canonical_current`,
`canonical_inconsistent`, `active_plan`, `worktree_draft`,
`historical_context`, `stale_path`, `stale_status`,
`unsupported_validation_claim`, and `duplicate_or_superseded`.

The Markdown selection ledger covers the complete frozen universe and uses:

```text
Path<TAB>Snapshot class<TAB>Scope decision<TAB>Read-based reason
```

`Scope decision` is exactly `include` or `exclude`. Every exclusion reason must
identify the document's actual subject; `keyword miss` is invalid.

The caller selection ledger uses:

```text
Path<TAB>Scope decision<TAB>Read-based reason
```

Every finding record uses all fields in this order:

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

If a field is inapplicable, state the physical or architectural reason. Empty
cells and placeholders are forbidden.

Every command ledger row uses tab-separated fields:

```text
UTC timestamp<TAB>HEAD<TAB>worktree hash<TAB>command<TAB>exit code<TAB>log path<TAB>claim supported or blocked
```

## Active Workstream Plans

1. [`2026-07-09-backend-llg-audit-evidence-documentation.md`](2026-07-09-backend-llg-audit-evidence-documentation.md)
2. [`2026-07-09-backend-llg-audit-fem-time-relaxation.md`](2026-07-09-backend-llg-audit-fem-time-relaxation.md)
3. [`2026-07-09-backend-llg-audit-validation-synthesis.md`](2026-07-09-backend-llg-audit-validation-synthesis.md)

### Task 1: Re-freeze the FEM Time-Domain Audit Snapshot

**Files:**
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/status.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/head-to-worktree.patch`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/staged.patch`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/unstaged.patch`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/worktree-state.sha256`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/backend-universe.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/backend-universe-sha256.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/backend-scope.tsv`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt`
- Create or replace: `.fullmag/audits/2026-07-09-backend-llg/snapshot/backend-file-sha256.txt`

**Interfaces:**
- Consumes: current Git checkout after overlapping FEM edits stabilize.
- Produces: immutable source identity consumed by every active workstream.

- [ ] **Step 1: Expose and attribute the complete worktree state**

Run:

```bash
git status --short --untracked-files=all
git diff --name-only
git diff --cached --name-only
```

Expected: every changed path is visible and attributable. Do not use a dirty
audited path without recording whether committed or worktree content is the
evidence source.

- [ ] **Step 2: Create only the active evidence directories**

Run:

```bash
mkdir -p .fullmag/audits/2026-07-09-backend-llg/{snapshot,contracts,fem-time,reviews,validation}
```

Expected: exit code 0 and all five directories exist.

- [ ] **Step 3: Record repository identity and tracked deltas**

Run:

```bash
git rev-parse HEAD > .fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt
git status --porcelain=v1 --untracked-files=all > .fullmag/audits/2026-07-09-backend-llg/snapshot/status.txt
git diff --binary HEAD > .fullmag/audits/2026-07-09-backend-llg/snapshot/head-to-worktree.patch
git diff --cached --binary > .fullmag/audits/2026-07-09-backend-llg/snapshot/staged.patch
git diff --binary > .fullmag/audits/2026-07-09-backend-llg/snapshot/unstaged.patch
sha256sum .fullmag/audits/2026-07-09-backend-llg/snapshot/{status.txt,head-to-worktree.patch,staged.patch,unstaged.patch} > .fullmag/audits/2026-07-09-backend-llg/snapshot/worktree-state.sha256
```

Expected: `head.txt` contains one 40-character commit ID; the status and
patches preserve concurrent tracked differences; the checksum fixes their
identity.

- [ ] **Step 4: Inventory and hash every in-scope backend file**

Run:

```bash
find backends/fem -type f -printf '%p\n' | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-universe.txt
while IFS= read -r p; do sha256sum "$p"; done < .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-universe.txt > .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-universe-sha256.txt
```

Read every universe path and write one tab-separated row to
`backend-scope.tsv` as `Path<TAB>include|exclude<TAB>read-based reason`. Mixed
files such as `CMakeLists.txt` and `src/api.cpp` remain included with their
time-domain responsibility stated explicitly. Then run:

```bash
cut -f1 .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-scope.tsv | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-scoped-universe.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-universe.txt .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-scoped-universe.txt
awk -F '\t' '$2 == "include" {print $1}' .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-scope.tsv | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt
awk -F '\t' 'NF < 3 || ($2 != "include" && $2 != "exclude") || $3 == "" {bad=1} END {exit bad}' .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-scope.tsv
while IFS= read -r p; do sha256sum "$p"; done < .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt > .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-file-sha256.txt
wc -l .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt
```

Expected: `comm` prints nothing, the schema check exits 0, and the current
selected count is 450 unless concurrent source changes alter the documented
denominator. Every universe and selected path has one hash row; changes to an
excluded file therefore force semantic reclassification before publication.

### Task 2: Execute and Review the Evidence/Documentation Workstream

**Files:**
- Follow: `docs/superpowers/plans/2026-07-09-backend-llg-audit-evidence-documentation.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/reviews/evidence-documentation-review.md`

**Interfaces:**
- Consumes: Task 1 snapshot.
- Produces: selection ledgers, contract ledger, selected document rows, claim ledger, and caller reachability map.

- [ ] **Step 1: Dispatch a fresh implementer for every unchecked task in the evidence/documentation plan**

Expected: all required evidence files exist, selection ledgers account for
their complete universes, and internal completeness checks pass.

- [ ] **Step 2: Dispatch a fresh reviewer with no reliance on the implementer's summary**

The reviewer reads the design, active plan, frozen universes, selection
ledgers, selected lists, and all contract/document evidence. It verifies scope
compliance, read-based selection, formula/unit completeness, caller-chain
reachability, and absence of excluded evidence.

Expected: `reviews/evidence-documentation-review.md` records `approved` or
actionable findings. Important or critical findings are remediated and reviewed
again before Task 3.

### Task 3: Execute and Review the FEM Time/Relaxation Workstream

**Files:**
- Follow: `docs/superpowers/plans/2026-07-09-backend-llg-audit-fem-time-relaxation.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/reviews/fem-time-relaxation-review.md`

**Interfaces:**
- Consumes: frozen backend list, selected caller chain, and approved contract ledger.
- Produces: one complete coverage fragment, findings, hypothesis dispositions, and test evidence.

- [ ] **Step 1: Dispatch a fresh implementer against the same snapshot**

Expected: the workstream metadata HEAD and hashes match the snapshot; every
backend path has one complete row; every candidate is proven, rejected, or
classified as requiring exact missing proof.

- [ ] **Step 2: Prove backend ownership is exhaustive and unique**

Run:

```bash
sed -n 's/^| `\(backends\/fem\/[^`]*\)`.*/\1/p' .fullmag/audits/2026-07-09-backend-llg/fem-time/coverage-rows.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/covered-backend-files.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt .fullmag/audits/2026-07-09-backend-llg/validation/covered-backend-files.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/validation/covered-backend-files.txt
```

Expected: both comparison commands print nothing.

- [ ] **Step 3: Dispatch a fresh scientific/code reviewer**

The reviewer independently samples every subsystem and fully re-derives all
P0/P1 candidates, checking equations, dimensions, discrete energy derivative,
callers, alternate branches, CPU/GPU legality, tests, and claimed proof state.

Expected: `reviews/fem-time-relaxation-review.md` records `approved` or exact
defects. Important or critical review findings are remediated and re-reviewed.

### Task 4: Execute Validation/Synthesis and Whole-Audit Review

**Files:**
- Follow: `docs/superpowers/plans/2026-07-09-backend-llg-audit-validation-synthesis.md`
- Create: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`
- Create: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/reviews/final-whole-audit-review.md`

**Interfaces:**
- Consumes: approved evidence/documentation and FEM time/relaxation workstreams plus selected managed-runtime logs.
- Produces: the only two tracked audit deliverables and a fresh whole-audit review.

- [ ] **Step 1: Dispatch a fresh synthesis implementer**

Expected: both deliverables exist, contain no unreviewed row or placeholder,
and distinguish source presence, planner legality, public execution, managed
runtime proof, and physics validation.

- [ ] **Step 2: Dispatch a fresh whole-audit reviewer**

The reviewer reads the final reports, source and selection inventories,
contract/finding registers, P0/P1 proof matrix, command logs, and current
source. It checks every acceptance criterion and re-derives each P0/P1.

Expected: `reviews/final-whole-audit-review.md` is `approved`; otherwise all
important/critical findings are corrected and the review repeats.

### Task 5: Final Snapshot and Coverage Gate

**Files:**
- Verify: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`
- Verify: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`

**Interfaces:**
- Consumes: reviewed deliverables and current checkout.
- Produces: publication decision.

- [ ] **Step 1: Detect audited backend drift**

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

Expected: empty diffs. Drift requires re-auditing every changed path and
refreshing rows, findings, tests, and anchors.

- [ ] **Step 2: Run the evidence plan's document/caller universe and selected-subset drift gates**

Expected: Markdown universe, selected documents, caller universe, and selected
callers match their frozen lists and hashes after excluding only the two new
validation artifacts. Any other drift requires re-selection and affected
re-audit.

- [ ] **Step 3: Prove the annex covers the frozen backend inventory**

Run:

```bash
sed -n 's/^| `\(backends\/fem\/[^`]*\)`.*/\1/p' docs/validation/2026-07-09-backend-llg-audit-coverage.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/validation/published-backend-files.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt .fullmag/audits/2026-07-09-backend-llg/validation/published-backend-files.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/validation/published-backend-files.txt
```

Expected: no output.

- [ ] **Step 4: Run document, finding, and Markdown integrity checks**

Run:

```bash
rg -n 'T[B]D|TO[D]O|FIXM[E]|PLACEH[O]LDER|awaiting revie[w]|not yet audite[d]|\| no \|' docs/validation/2026-07-09-backend-llg-{scientific-audit,audit-coverage}.md
rg -n '^### (FEM-TD-(NUM|PHY)|ABI|CAP|DOC|VAL)-[0-9]{3}:' docs/validation/2026-07-09-backend-llg-scientific-audit.md | LC_ALL=C sort
git diff --check -- docs/validation/2026-07-09-backend-llg-scientific-audit.md docs/validation/2026-07-09-backend-llg-audit-coverage.md
```

Expected: placeholder search prints nothing; IDs are unique and ordered within
families; whitespace check exits 0.

- [ ] **Step 5: Verify tracked worktree scope**

Run:

```bash
git status --short --untracked-files=all
git diff --name-only
```

Expected: audit-publication changes are limited to the two deliverables.
Pre-existing or separately approved plan changes remain untouched and are
called out before staging.

### Task 6: Commit the Published Audit

**Files:**
- Commit: `docs/validation/2026-07-09-backend-llg-scientific-audit.md`
- Commit: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`

**Interfaces:**
- Consumes: Task 5 passing evidence and approved whole-audit review.
- Produces: one reviewable documentation commit.

- [ ] **Step 1: Stage only the two final artifacts**

Run:

```bash
git add docs/validation/2026-07-09-backend-llg-scientific-audit.md docs/validation/2026-07-09-backend-llg-audit-coverage.md
git diff --cached --name-only
git diff --cached --check
```

Expected: exactly those two paths are staged and the whitespace check passes.

- [ ] **Step 2: Commit with the FEM boundary in the message**

Run:

```bash
git commit -m "docs: publish FEM time-domain scientific audit"
```

Expected: one commit containing only the two tracked audit artifacts. Ignored
evidence and unrelated worktree changes are not committed.
