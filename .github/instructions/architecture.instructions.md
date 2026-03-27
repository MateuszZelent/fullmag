---
applyTo: "**"
description: "Use when working anywhere in Fullmag to preserve one semantic core across Python, UI, ProblemIR, planning, session/run APIs, and modular backend execution."
---

> **Canonical source: [`AGENTS.md`](../../AGENTS.md)** - this file adds context-scoped detail.

# Architecture instructions

- Preserve one semantic core across Python DSL, UI authoring, `ProblemIR`, planning, session/run
  APIs, and backend execution.
- The embedded Python DSL is the only canonical public scripting artifact; UI flows may assist
  authoring but must lower to the same semantics and be able to emit equivalent Python.
- Python and UI are authoring layers; Rust is the validation/normalization/planning/control-plane
  layer.
- Keep requested execution intent distinct from resolved backend/runtime/device selection.
- Never introduce shared APIs that depend on Cartesian cell indices, raw GPU arrays, CUDA pointers,
  or FEM implementation detail.
- Treat `docs/physics/` as mandatory pre-implementation documentation for physics and numerics work.
- Keep provenance and reproducibility first-class, including requested and resolved execution truth
  when applicable.
- If a feature is backend-specific, surface it through explicit backend hint blocks, runtime policy,
  capability checks, or explicit `extended` mode.
- **Keep source files under ~1000 lines.** Split large modules into focused submodules instead of growing monolithic files.
