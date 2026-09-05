---
name: subagent-driven-development
description: "Use for an authorized implementation plan with substantial independent tasks suited to delegation."
---

# Coordinate implementation

Read the plan, current source state, and completed-task record once. Identify task boundaries and shared resources before dispatch. Use local execution for tightly coupled work and subagents for substantial independent work when allowed by the host.

For each worker, provide the relevant task brief, interfaces and decisions from dependencies, file ownership, exact user constraints, validation requirements, and a concise report contract. Link large briefs and diffs rather than pasting accumulated history. Preserve the requested or configured model and effort unless the user has authorized another routing policy.

Workers return status (`DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`), changed files, check commands/results, and concerns. Commits are optional and require authorization. Clarify context, investigate blockers, or split an oversized task instead of blindly retrying it. The coordinator may fix a small issue directly.

Review specification compliance and code quality at meaningful boundaries. A separate reviewer is valuable for high-risk or substantial changes; do not require a fresh implementer and multiple reviewers for every small step. Give reviewers the actual diff and raw requirements, without steering their verdict. Resolve correctness findings and rerun covering checks after fixes. Reuse valid evidence for unchanged code.

Track completed outcomes, source identity, evidence, decisions, and remaining work in the host's durable checkpoint mechanism or one task-local record. Check it after compaction. Do not automatically repeat completed tasks, create duplicate ledgers, or confuse an old checkpoint with current source evidence.

Coordinate writes and integration explicitly; independent readers may run concurrently. Finish the complete authorized scope with an integrated verification pass where needed. Branch integration and cleanup are separate actions governed by the user's authorization. Existing prompt templates are optional aids, not additional workflow gates.
