---
name: using-git-worktrees
description: "Use when a code change needs checkout isolation or the user requests a worktree."
---

# Worktree isolation

Inspect `git status --short`, `git worktree list --porcelain`, `git rev-parse --git-dir`, `git rev-parse --git-common-dir`, and `git rev-parse --show-superproject-working-tree` before choosing a checkout. Different git/common directories do not by themselves prove isolation inside a submodule.

Reuse existing isolation. Follow an explicit request to work directly in the current checkout; preserve unrelated dirty changes. If isolation is appropriate and authorized by the task, create it without a redundant permission question. Prefer an available native worktree tool; otherwise use `git worktree add` with a verified path and the project's branch naming policy. Do not invent tool names.

Use the user's directory preference or an existing convention. Verify a project-local worktree directory is ignored before creating it. An ignore change does not authorize a commit. Keep build caches and browser downloads in the project's approved external storage.

Read the project's build instructions before installing or building anything. Set up only dependencies needed for the task; do not infer `npm install` or host `cargo build` from file presence. In Fullmag, native FEM builds start with container-backed `just` recipes.

Record relevant pre-existing test failures and distinguish them from regressions. Continue safe independent work; do not silently move into a shared checkout after an isolation or permission failure. Respect the host approval boundary.

Record ownership when creating a worktree. A directory name is not proof of ownership. Remove it only under explicit cleanup authorization, after checking uncommitted files, unmerged commits, active processes, container mounts, and the resolved path. Preserve externally managed worktrees.
