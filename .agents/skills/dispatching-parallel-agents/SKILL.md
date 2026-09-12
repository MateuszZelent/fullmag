---
name: dispatching-parallel-agents
description: "Use when authorized delegation can advance independent substantial tasks in parallel."
---

# Delegate independent work

Use subagents when the host permits it and a bounded task can run alongside useful local work. Small tasks, shared-state changes, and tightly coupled investigations usually belong with one agent. Delegation is a cost/quality decision, not a requirement to maximize worker count.

Give each worker a concrete outcome, file ownership, constraints, required evidence, and a concise return format. Use focused context or artifact paths for independent exploration; inherit history only when prior decisions are necessary. Follow the user's model and reasoning settings or the configured default; change them only under an explicit routing policy supported by available models.

Run independent reads concurrently. Serialize writes to shared files, Git staging/commits, cache deletion, and exclusive build resources. A subagent does not gain additional permission to publish, commit, or delete.

Continue your own independent work. Wait for meaningful progress rather than polling unchanged state. Reuse an existing worker for follow-up work when its context is useful.

Review each result, integrate compatible changes, and verify the affected interfaces and required gates. A worker's success report is not sufficient evidence; check the diff and test/runtime artifacts. Do not rerun every suite automatically or redispatch completed work after compaction.
