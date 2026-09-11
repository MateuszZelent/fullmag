---
name: finishing-a-development-branch
description: "Use when finishing implementation in a Fullmag worktree, or when the user requests branch integration, a pull request, or worktree cleanup."
---

# Finish the requested integration

Inspect the actual branch, base, working-tree state, and diff. Resolve refs with Git; do not assume `HEAD~1` covers the change. Use existing valid check results for this source state and run any missing required integration checks.

For Fullmag, finish the resource lifecycle as well as the code lifecycle. Update the storage registry and write a final state for the worktree, build profile, and run: owner, source identity, paths, processes/containers, status, reason for retention, and next step. `completed` code does not imply that generated resources are cleaned or that runtime qualification is complete.

Follow the user-authorized default lifecycle in [AGENTS.md](../../../AGENTS.md) and [the integration procedure](../../../docs/guides/fullmag-build-storage-governance.md#cykl-integracji-zadania): required tests and review, scoped commit, branch push, PR targeting `master`, required PR checks and approvals, merge PR, update the main checkout's `master` by fast-forward, verify integration, then remove this task's verified worktree and finalize its original registry record. Explicit requests such as audit-only, local-only, no merge, or retain worktree override the respective steps. Do not ask again for authorization already established by this policy. Before any commit in a shared checkout, inspect the staged file list in a separate command and include only this task's changes.

Do not allocate a new build directory merely to finish a branch. Reuse the compatible per-worktree profile and record any retained WIP, failed build, or interrupted run so it can be recovered.

Implementation should already contain separate commits for completed, verified logical increments as required by AGENTS.md. Commit any remaining coherent verified changes before pushing; do not create an empty final commit or collapse existing increments merely to finish. Review the complete task diff against its base, not just the last commit. Increment checks remain evidence for unchanged sources, but required whole-task and integration gates still apply.

For a PR, describe the concrete behavior, rationale, validation, and limitations. Keep the worktree while review or CI is pending; continue the lifecycle once requirements are met. Confirm the remote PR is merged and record its HEAD and merge commit. Do not perform a second local merge after merging the PR. The remote merge must be reflected locally: switch the main checkout to the resulting `master` commit. If the main checkout cannot be used, the original worktree may verify the resulting ref, but another surviving checkout must execute cleanup; without one, record `blocked`. From that cleanup executor remove the verified task worktree first, then remove the merged local task branch. Preserve unrelated dirty work in the main checkout; a conflicting update, diverged local master, active process/container/mount, or untracked work is a recorded blocker, never a reason for reset or force-push.

The default lifecycle authorizes deletion only of this task's worktree after successful integration. Verify its resolved path, clean status including untracked files, absence of unique unintegrated work, ownership, active processes, containers, and mounts. Account for squash/rebase using the merged PR and change comparison. Run `git worktree remove` from the main checkout without `--force`; verify both registration and directory are gone. Preserve storage artifacts and other tasks. Other deletion requires explicit authorization for its exact targets.

Save the original worktree ID and registry path before removal. Update that original record with PR URL, merge commit, cleanup outcome, retained resources and next step. `worktree-finish` records state only; it does not implement PR, merge or deletion. Do not mark the full task completed while integration or cleanup remains pending: record `review` or `blocked` with exact paths and reason, and report the remaining action. Respect branch protection and host permissions.
