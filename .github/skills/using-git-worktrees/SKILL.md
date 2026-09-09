---
name: using-git-worktrees
description: "Use when a code change needs checkout isolation or the user requests a worktree."
---

# Worktree isolation

Read host storage configuration through the resolver from the main checkout's `.env` (`FULLMAG_PROJECT_STORAGE_ROOT`; template `.env.example`). Do not hardcode Windows/Linux build paths or copy secrets into worktrees. Explicit process variables take precedence for validated container mapping. Git identifies the project and worktree roots; the configured storage root determines build destinations.

Inspect `git status --short`, `git worktree list --porcelain`, `git rev-parse --git-dir`, `git rev-parse --git-common-dir`, and `git rev-parse --show-superproject-working-tree` before choosing a checkout. Different git/common directories do not by themselves prove isolation inside a submodule.

For Fullmag, apply [the shared storage policy](../../../docs/guides/fullmag-build-storage-governance.md): derive the project root from the common Git directory and keep `worktrees` and `storage` as its siblings. Do not derive either path from `cwd.parent`. Register the task and owner before creating or reusing a worktree; the registry and the final resource state are mandatory.

Reuse existing isolation. Follow an explicit request to work directly in the current checkout; preserve unrelated dirty changes. If isolation is appropriate and authorized by the task, create it without a redundant permission question. Prefer an available native worktree tool; otherwise use `git worktree add` with a verified path and the project's branch naming policy. Do not invent tool names.

Create at most one worktree per task by default, under the project's `worktrees/<task-id>` directory. Reuse an existing worktree when it has no active owner. Do not create one for a small documentation edit, audit, or plan. Creating a worktree does not authorize `fetch`, `pull`, `rebase`, submodule updates, or dependency bootstrap; use the locally resolved ref unless the task explicitly requires a recorded remote update.

Use the user's directory preference or an existing convention. Verify a project-local worktree directory is ignored before creating it. An ignore change does not authorize a commit. Keep build caches and browser downloads in the project's approved external storage.

Read the project's build instructions before installing or building anything. Set up only dependencies needed for the task; do not infer `npm install` or host `cargo build` from file presence. In Fullmag, native FEM builds start with container-backed `just` recipes.

Record relevant pre-existing test failures and distinguish them from regressions. Continue safe independent work; do not silently move into a shared checkout after an isolation or permission failure. Respect the host approval boundary.

Commit each completed, coherent increment on the task branch after appropriate verification; do not accumulate all changes until task completion. Include related tests and documentation, and keep dependent changes together so intermediate commits do not break the build or contract. Review the diff, stage only the increment, then inspect staged paths in a separate command and review the staged diff before each commit. Use an English purpose-focused message and record the full commit hash and verification evidence in the task checkpoint. Reuse still-valid checks; documentation may use parser/link/diff checks. Existing task authorization covers these commits unless the user says otherwise. Incremental commits do not replace final integration gates or trigger separate merges.

Record ownership when creating a worktree. Default to branch `codex/<task-id>` based on the verified local `master`, unless the task specifies another base. Record the full base commit and original registry path. A directory name is not proof of ownership.

Implementation includes the user-authorized lifecycle in [AGENTS.md](../../../AGENTS.md) and [the integration procedure](../../../docs/guides/fullmag-build-storage-governance.md#cykl-integracji-zadania): tests/review, scoped commit and push, PR to `master`, required checks/approvals, PR merge, fast-forward main checkout, integration verification, removal of this task's worktree, and final registry update. Use `finishing-a-development-branch` when implementation ends; do not leave a worktree merely because coding is done. Explicit local-only/no-merge/retain instructions take precedence. Verify uncommitted and unintegrated work, processes, containers, mounts and resolved path before deletion; preserve externally managed worktrees. Record blockers and the next step rather than silently abandoning the checkout.
