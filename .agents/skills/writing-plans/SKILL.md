---
name: writing-plans
description: "Use when a requested implementation needs a durable multi-step plan or the user asks for a plan."
---

# Write an executable plan

Inspect affected files, callers, and project constraints first. Record the goal, scope, decisions, dependencies, and success criteria. Preserve exact user-provided values and distinguish verified paths or symbols from proposals.

Organize by independently verifiable outcomes. For each task, specify affected files, the behavioral change, interfaces that other tasks depend on, and the appropriate verification command or evidence. Include code only when an exact algorithm or interface needs it; avoid prewriting the implementation and repeating it across tasks.

Use the project's plan location; otherwise use `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`. Keep a small change's plan in the response when a separate file adds no value. Review coverage, contradictions, and unresolved decisions once before execution.

If the user requested planning only, deliver the plan. If execution is already authorized, continue with it. Choose local or delegated execution according to actual task independence and host permissions; do not force an execution-mode question. Commits and external publication need their own authorization.
