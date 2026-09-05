---
name: executing-plans
description: "Use to carry out an existing implementation plan and track its verification."
---

# Execute the plan

Read the plan and the affected code. Check dependencies, prior completed work, user corrections, and project constraints. Resolve routine gaps from evidence; ask only about a consequential unresolved decision, keeping independent work moving.

Execute the authorized tasks in dependency order. For each meaningful outcome, record changed files, relevant checks, results, and remaining work. Adapt implementation details when the source requires it without changing the approved public contract. Do not stop at a planning handoff or ask whether to continue between tasks.

Use an existing isolated checkout when available. When isolation is needed, follow the worktree workflow and project storage/build rules. A plan alone is not authorization to commit, push, merge, or delete work.

Run the checks appropriate to the affected behavior and all applicable mandatory gates. Reuse still-valid evidence for unchanged inputs; rerun after relevant changes or when a failure needs investigation. Diagnose failures rather than escalating every missing dependency to the user. Report a blocker precisely when it requires unavailable access, information, or an external change.

Finish with the verified outcome and any actual limitations. Use branch integration workflow only when integration is requested.
