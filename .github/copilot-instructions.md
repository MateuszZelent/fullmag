# Copilot instructions for Fullmag

> **Canonical source: [`AGENTS.md`](../AGENTS.md)**
> This file is a summary for Copilot. If anything here contradicts `AGENTS.md`, `AGENTS.md` wins.

## Key rules (summary of AGENTS.md)

- **Physics before implementation.** Before implementing any physics or numerics feature, create or update a publication-style note in `docs/physics/` using `docs/physics/TEMPLATE.md`. Missing physics documentation is a blocker.
- The only public scripting surface is the embedded Python DSL in `packages/fullmag-py`.
- Python builds `ProblemIR`; Rust validates, normalizes, and plans it.
- The shared API must describe physics, not grid internals or FEM-only implementation details.
- Treat `docs/1_project_scope.md`, `docs/specs/problem-ir-v0.md`, `docs/physics/`, and the ADRs as the canonical architecture and physics reference.
- Assume container-first verification through `docker compose` and `Makefile`.
- **Keep source files under ~1000 lines.** Split growing modules into focused submodules rather than creating monolithic files.
