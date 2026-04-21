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
- The local control-room API is resource-first: thin `status`, on-demand resource fetching, JSON
  control plane, binary data plane.
- Realtime must stay notification-first: `GET /v1/live/current/ws` invalidates resources while HTTP
  resources remain the source of truth; websocket semantics are documented in AsyncAPI, not only in
  OpenAPI.
- React components should not call `fetch()` directly; use the shared typed API client, codecs,
  resource hooks, and caches.
- Keep FDM/FEM differences in capability guards and domain adapters, not in separate top-level
  component trees.
- Preserve explicit requested vs resolved execution in launch flows, run summaries, badges, and
  provenance views.
- Use UI language that matches the domain: problem, study, session, run, backend, device, mode,
  precision, artifact, trace, comparison.
- Prefer server components and simple data flow for early scaffolding.
- Keep room for Monaco editor, script export, live field viewers, artifact viewer, and FDM/FEM
  comparison workflows.
