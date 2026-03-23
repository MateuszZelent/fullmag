---
applyTo: "apps/web/**/*.{ts,tsx,js,jsx,json}"
description: "Use when editing the Fullmag web app. Keep the web layer as an operator console for scripts, jobs, logs, artifacts, and comparisons — not the home of solver physics."
---

> **Canonical source: [`AGENTS.md`](../../AGENTS.md)** — this file adds context-scoped detail.

# Web instructions

- The web app edits or visualizes `ProblemIR`; it does not define solver semantics.
- Prefer server components and simple data flow for early scaffolding.
- Use UI language that matches the domain: problem, backend, job, artifact, comparison.
- Keep room for Monaco editor, artifact viewer, and FDM/FEM comparison workflows.
