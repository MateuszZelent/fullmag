---
name: finishing-a-development-branch
description: "Use when the user requests branch integration, a pull request, or worktree cleanup."
---

# Finish the requested integration

Inspect the actual branch, base, working-tree state, and diff. Resolve refs with Git; do not assume `HEAD~1` covers the change. Use existing valid check results for this source state and run any missing required integration checks.

For Fullmag, finish the resource lifecycle as well as the code lifecycle. Update the storage registry and write a final state for the worktree, build profile, and run: owner, source identity, paths, processes/containers, status, reason for retention, and next step. `completed` code does not imply that generated resources are cleaned or that runtime qualification is complete.

Carry out the integration action already authorized. If none was requested, preserve the branch and report the result without forcing a menu. Before any commit in a shared checkout, inspect the staged file list in a separate command and include only this task's changes.

Do not allocate a new build directory merely to finish a branch. Reuse the compatible per-worktree profile and record any retained WIP, failed build, or interrupted run so it can be recovered.

For a PR, describe the concrete behavior, rationale, validation, and limitations. Preserve the worktree for follow-up review. For a merge, verify the merged state before considering cleanup; do not pull or modify an unrelated dirty branch implicitly.

Deletion requires explicit authorization for the exact target. Show the resolved worktree path, dirty files, and unmerged commits before asking when that authorization is missing. Check actual ownership, active processes, and mounts; never infer ownership from a `.worktrees` directory name. Use safe Git removal, not forced cleanup of unknown work. Do not force-push or prune unrelated registrations.
