---
name: finishing-a-development-branch
description: "Use when the user requests branch integration, a pull request, or worktree cleanup."
---

# Finish the requested integration

Inspect the actual branch, base, working-tree state, and diff. Resolve refs with Git; do not assume `HEAD~1` covers the change. Use existing valid check results for this source state and run any missing required integration checks.

Carry out the integration action already authorized. If none was requested, preserve the branch and report the result without forcing a menu. Before any commit in a shared checkout, inspect the staged file list in a separate command and include only this task's changes.

For a PR, describe the concrete behavior, rationale, validation, and limitations. Preserve the worktree for follow-up review. For a merge, verify the merged state before considering cleanup; do not pull or modify an unrelated dirty branch implicitly.

Deletion requires explicit authorization for the exact target. Show the resolved worktree path, dirty files, and unmerged commits before asking when that authorization is missing. Check actual ownership, active processes, and mounts; never infer ownership from a `.worktrees` directory name. Use safe Git removal, not forced cleanup of unknown work. Do not force-push or prune unrelated registrations.
