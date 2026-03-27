# Copilot instructions for Fullmag

> **Canonical source: [`AGENTS.md`](../AGENTS.md)**
> This file is a summary for Copilot. If anything here contradicts `AGENTS.md`, `AGENTS.md` wins.

## Key rules (summary of AGENTS.md)

- **Physics before implementation.** Before implementing any physics or numerics feature, create or update a publication-style note in `docs/physics/` using `docs/physics/TEMPLATE.md`. Missing physics documentation is a blocker.
- Fullmag has one semantic core across Python, UI, `ProblemIR`, planning, session/run APIs, and backend execution.
- The only canonical public scripting surface is the embedded Python DSL in `packages/fullmag-py`.
- Python and UI authoring flows must converge to canonical `ProblemIR`; Rust validates, normalizes, plans, and orchestrates execution.
- UI-authored simulations must be exportable as canonical, human-editable Python scripts.
- The shared API must describe physics and runtime truth, not grid internals, raw GPU arrays, or FEM-only implementation details.
- Current execution priority is calibrated GPU-first FDM/CUDA, but the product shell must remain modular and backend-neutral enough for explicit CPU/GPU and FDM/FEM selection.
- Requested execution intent and resolved execution reality must stay explicit across user surfaces, planning, and provenance.
- Treat `docs/specs/fullmag-application-architecture-v2.md`, `docs/specs/session-run-api-v1.md`, `docs/specs/runtime-distribution-and-managed-backends-v1.md`, `docs/physics/`, and ADRs as canonical architecture references.
- Assume container-first verification and prefer canonical `just` workflows over ad-hoc commands.
- Prefer `justfile` as the primary build/run task layer:
  - `just build fullmag`
  - `just build fem-gpu-runtime-host`
  - `just package fullmag`
  - `just run ...`
  - `just run-py-layer-hole`
  - `just control-room`
  Use raw `cargo`, `make`, or `docker compose` only when the relevant `just` recipe does not exist or when debugging lower-level issues.
- **Keep source files under ~1000 lines.** Split growing modules into focused submodules rather than creating monolithic files.
