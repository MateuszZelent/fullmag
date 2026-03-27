---
applyTo: "apps/web/**/*.{ts,tsx,js,jsx,json}"
description: "Use when editing the Fullmag web app. Keep the web layer as the control room and authoring companion for the same canonical simulation model, never a separate solver-semantic surface."
---

> **Canonical source: [`AGENTS.md`](../../AGENTS.md)** - this file adds context-scoped detail.

# Web instructions

- The web app is a first-class control room and authoring companion; it must not define separate
  solver semantics.
- Web authoring flows must converge with Python authoring through canonical `ProblemIR` and support
  canonical Python script export when they create or edit simulations.
- Preserve explicit requested vs resolved execution in launch flows, run summaries, badges, and
  provenance views.
- Use UI language that matches the domain: problem, study, session, run, backend, device, mode,
  precision, artifact, trace, comparison.
- Prefer server components and simple data flow for early scaffolding.
- Keep room for Monaco editor, script export, live field viewers, artifact viewer, and FDM/FEM
  comparison workflows.
