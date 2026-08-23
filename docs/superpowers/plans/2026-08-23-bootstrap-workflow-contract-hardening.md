# Bootstrap Workflow Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR #56's bootstrap contract reject stale action versions regardless of step names and reject tracked gitlinks without complete clone metadata.

**Architecture:** Keep the contract dependency-free inside `scripts/test_bootstrap_workflow_contract.py`. Parse only the workflow's anchored `uses:` keys, parse `.gitmodules` with `configparser`, and express both invariants through small pure helpers exercised by negative unit tests before applying them to repository files.

**Tech Stack:** Python 3 standard library (`configparser`, `pathlib`, `subprocess`, `unittest`), Git index, GitHub Actions YAML as text.

## Global Constraints

- Add no Python or workflow dependency.
- Support Windows and Linux.
- Keep `.github/workflows/bootstrap.yml` as the workflow source of truth.
- Do not alter workflow behavior, action versions, submodule membership, product code, OpenAPI, runtime semantics, or frontend architecture.
- Govern exactly `actions/checkout@v7`, `actions/setup-node@v7`, `actions/setup-python@v7`, `actions/upload-artifact@v7`, and `pnpm/action-setup@v6`.
- A tracked gitlink must have exactly one matching `.gitmodules` path and a nonempty URL.

---

## File map

- Modify `scripts/test_bootstrap_workflow_contract.py`: parsing helpers, negative regression tests, and repository contract assertions.
- Preserve `docs/superpowers/specs/2026-08-23-bootstrap-workflow-contract-hardening-design.md`: approved design owner; no implementation edits expected.

### Task 1: Validate actual workflow action references

**Files:**
- Modify: `scripts/test_bootstrap_workflow_contract.py:1-35`
- Test: `scripts/test_bootstrap_workflow_contract.py`

**Interfaces:**
- Produces: `_workflow_uses(workflow: str) -> list[str]`.
- Produces: `_assert_required_action_version(workflow: str, action: str, version: str) -> None`.
- Consumes: raw text from `.github/workflows/bootstrap.yml`.

- [ ] **Step 1: Add a failing regression test for renamed steps and stale versions**

Add these helpers as unresolved calls and the test method:

```python
def test_action_version_contract_reads_uses_instead_of_step_names(self) -> None:
    workflow = """
jobs:
  test:
    steps:
      - name: Clone sources
        uses: actions/checkout@v6
"""

    with self.assertRaisesRegex(
        AssertionError,
        r"actions/checkout.*actions/checkout@v7",
    ):
        _assert_required_action_version(
            workflow,
            "actions/checkout",
            "actions/checkout@v7",
        )
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
python scripts/test_bootstrap_workflow_contract.py BootstrapWorkflowContractTests.test_action_version_contract_reads_uses_instead_of_step_names -v
```

Expected: `ERROR` with `NameError: name '_assert_required_action_version' is not defined`.

- [ ] **Step 3: Implement the minimal line parser and assertion helper**

Add above the test class:

```python
def _workflow_uses(workflow: str) -> list[str]:
    references: list[str] = []
    for line in workflow.splitlines():
        stripped = line.strip()
        if not stripped.startswith("uses:"):
            continue
        reference = stripped.removeprefix("uses:").strip().strip("'\"")
        if reference:
            references.append(reference)
    return references


def _assert_required_action_version(
    workflow: str,
    action: str,
    expected_reference: str,
) -> None:
    references = [
        reference
        for reference in _workflow_uses(workflow)
        if reference.partition("@")[0] == action
    ]
    if not references:
        raise AssertionError(f"workflow does not use required action {action}")
    stale = [reference for reference in references if reference != expected_reference]
    if stale:
        raise AssertionError(
            f"{action} must use {expected_reference}; found {stale}"
        )
```

- [ ] **Step 4: Replace name-count assertions with governed-family checks**

Replace the body of `test_ci_uses_node24_actions` after reading the workflow:

```python
required = {
    "actions/checkout": "actions/checkout@v7",
    "actions/setup-node": "actions/setup-node@v7",
    "actions/setup-python": "actions/setup-python@v7",
    "actions/upload-artifact": "actions/upload-artifact@v7",
    "pnpm/action-setup": "pnpm/action-setup@v6",
}
for action, expected_reference in required.items():
    with self.subTest(action=action):
        _assert_required_action_version(workflow, action, expected_reference)
```

- [ ] **Step 5: Run the full bootstrap contract and verify GREEN**

Run:

```powershell
python scripts/test_bootstrap_workflow_contract.py -v
```

Expected: all tests pass, including the renamed-step regression and the repository workflow contract.

- [ ] **Step 6: Commit the action-reference hardening**

```powershell
git add -- scripts/test_bootstrap_workflow_contract.py
git diff --cached --check
git commit -m "test(ci): validate workflow action references"
```

### Task 2: Require complete metadata for every tracked gitlink

**Files:**
- Modify: `scripts/test_bootstrap_workflow_contract.py:1-90`
- Test: `scripts/test_bootstrap_workflow_contract.py`

**Interfaces:**
- Produces: `_submodule_urls_by_path(gitmodules: str) -> dict[str, str]`.
- Consumes: `.gitmodules` text and paths from `git ls-files --stage`.

- [ ] **Step 1: Add failing tests for missing URLs and duplicate paths**

Add `import configparser` and these test methods:

```python
def test_submodule_metadata_requires_nonempty_url(self) -> None:
    gitmodules = """
[submodule "external_solvers/example"]
    path = external_solvers/example
"""

    with self.assertRaisesRegex(
        AssertionError,
        r"external_solvers/example.*nonempty url",
    ):
        _submodule_urls_by_path(gitmodules)


def test_submodule_metadata_rejects_duplicate_paths(self) -> None:
    gitmodules = """
[submodule "first"]
    path = external_solvers/example
    url = https://example.test/first
[submodule "second"]
    path = external_solvers/example
    url = https://example.test/second
"""

    with self.assertRaisesRegex(
        AssertionError,
        r"duplicate submodule path external_solvers/example",
    ):
        _submodule_urls_by_path(gitmodules)
```

- [ ] **Step 2: Run both focused tests and verify RED**

Run:

```powershell
python scripts/test_bootstrap_workflow_contract.py BootstrapWorkflowContractTests.test_submodule_metadata_requires_nonempty_url BootstrapWorkflowContractTests.test_submodule_metadata_rejects_duplicate_paths -v
```

Expected: both tests error with `NameError: name '_submodule_urls_by_path' is not defined`.

- [ ] **Step 3: Implement strict `.gitmodules` parsing**

Add above the test class:

```python
def _submodule_urls_by_path(gitmodules: str) -> dict[str, str]:
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    parser.read_string(gitmodules)
    records: dict[str, str] = {}
    for section in parser.sections():
        if not section.startswith('submodule "'):
            continue
        path = parser.get(section, "path", fallback="").strip()
        if not path:
            raise AssertionError(f"{section} must define a nonempty path")
        url = parser.get(section, "url", fallback="").strip()
        if not url:
            raise AssertionError(f"{path} must define a nonempty url")
        if path in records:
            raise AssertionError(f"duplicate submodule path {path}")
        records[path] = url
    return records
```

- [ ] **Step 4: Compare complete metadata paths with the Git index**

Replace `test_every_tracked_gitlink_has_submodule_metadata` after computing `gitlinks`:

```python
self.assertTrue(gitlinks)
metadata = _submodule_urls_by_path(gitmodules)
self.assertEqual(
    set(metadata),
    set(gitlinks),
    "tracked gitlinks and complete .gitmodules records must match exactly",
)
```

- [ ] **Step 5: Run the contract suite and verify GREEN**

Run:

```powershell
python scripts/test_bootstrap_workflow_contract.py -v
```

Expected: all tests pass and each of the six tracked external solver gitlinks has a nonempty URL.

- [ ] **Step 6: Commit the gitlink metadata hardening**

```powershell
git add -- scripts/test_bootstrap_workflow_contract.py
git diff --cached --check
git commit -m "test(ci): require complete gitlink metadata"
```

### Task 3: Verify and publish PR #56

**Files:**
- Verify: `scripts/test_bootstrap_workflow_contract.py`
- Verify: `packages/fullmag-py/tests/test_api.py`
- Verify: `apps/control-room/src/shared/ui/Resizable.tsx`
- Verify: `apps/control-room/src/kernel/visualization/visualizationCommandContributions.ts`
- Verify: `apps/control-room/src/modules/inspector/panels/constraint/FrozenSpinsInspectorPanel.tsx`
- Verify: `apps/control-room/src/modules/ribbon/ribbonCommands.ts`
- Verify: `crates/fullmag-runner/src/dispatch.rs`

**Interfaces:**
- Consumes: the commits produced by Tasks 1 and 2 plus existing PR #56 fixes.
- Produces: a pushed PR head with local evidence and fresh GitHub Actions evidence.

- [ ] **Step 1: Run Python contracts**

```powershell
python scripts/test_bootstrap_workflow_contract.py -v
python -m unittest discover -s packages/fullmag-py/tests -p test_api.py -k random_initializer_serializes_to_ir -v
```

Expected: both commands pass.

- [ ] **Step 2: Run frontend type, lint, and regression tests**

Use the bundled Node runtime and repository dependencies:

```powershell
node node_modules/typescript/bin/tsc --noEmit --project apps/control-room/tsconfig.typecheck.json
node node_modules/eslint/bin/eslint.js apps/control-room/src/shared/ui/Resizable.tsx apps/control-room/src/kernel/visualization/visualizationCommandContributions.ts apps/control-room/src/modules/inspector/panels/constraint/FrozenSpinsInspectorPanel.tsx apps/control-room/src/modules/ribbon/ribbonCommands.ts
node node_modules/vitest/vitest.mjs run apps/control-room/src/shared/ui/Resizable.test.ts apps/control-room/src/kernel/visualization/visualizationCommandContributions.test.ts apps/control-room/src/modules/inspector/panels/constraint/FrozenSpinsInspectorPanel.test.tsx apps/control-room/src/modules/ribbon/ribbonStructure.test.ts
```

Expected: typecheck and lint exit zero; four test files and 128 tests pass.

- [ ] **Step 3: Check repository hygiene and commit graph**

```powershell
git diff --check origin/master...HEAD
git status --short
git log --oneline origin/codex/fix-pr-ci-gates-20260823..HEAD
```

Expected: no whitespace errors, clean worktree, and only reviewed PR #56 commits ahead of the remote branch.

- [ ] **Step 4: Push the approved branch update**

```powershell
git push origin codex/fix-pr-ci-gates-20260823
```

Expected: remote branch advances by fast-forward to the current local head.

- [ ] **Step 5: Verify fresh GitHub Actions and review state**

Fetch workflow runs for the new head, inspect every failed job log, and require all mandatory jobs to complete successfully. Re-fetch review threads and resolve only those whose exact invariant is proven by the new code and tests.

- [ ] **Step 6: Merge only after evidence is complete**

Require a mergeable PR, green mandatory checks, no unresolved actionable review threads, and an exact expected head SHA. Merge PR #56 without bypassing branch protection.
