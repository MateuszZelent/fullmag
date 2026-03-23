---
applyTo: "**"
description: "Use when working anywhere in Fullmag to preserve the embedded Python DSL, mandatory docs/physics documentation, strict/extended/hybrid modes, Rust control plane, C ABI backend boundary, and container-first workflow."
---

> **Canonical source: [`AGENTS.md`](../../AGENTS.md)** — this file adds context-scoped detail.

# Architecture instructions

- Prefer changes that strengthen the embedded Python DSL to `ProblemIR` boundary.
- Python is the authoring layer; Rust is the validation/normalization/planning layer.
- Never introduce shared APIs that depend on Cartesian cell indices or FEM implementation detail.
- Treat `docs/physics/` as mandatory pre-implementation documentation for physics and numerics work.
- Keep provenance and reproducibility first-class in `ProblemMeta`.
- If a feature is backend-specific, surface it through capability checks or explicit `extended` mode.
- **Keep source files under ~1000 lines.** Split large modules into focused submodules instead of growing monolithic files.
