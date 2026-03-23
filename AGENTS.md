# Fullmag agents guide

> **This file is the single source of truth for all AI models working on Fullmag**
> (Antigravity, Codex, Copilot, and any future model).
> All other instruction files (`.github/copilot-instructions.md`,
> `.github/instructions/*.md`) must reference this file and must not contradict it.

## North star

Fullmag describes a physical micromagnetic problem, not a numerical storage layout.
Every change must preserve that contract across Python API, `ProblemIR`, planning, and backend execution.

## Canonical instruction sources

- **`AGENTS.md` (this file)** is the canonical source of all project rules.
- `.agents/` contains agent workflows and skills that extend these rules.
- `.github/copilot-instructions.md` and `.github/instructions/` mirror a summary for Copilot.
- `docs/physics/TEMPLATE.md` is the only canonical template for publication-style physics notes.

## Golden rule: physics before implementation

This rule is non-negotiable.

Before implementing any physics or numerical feature, create or update a publication-style note in `docs/physics/` covering:

1. problem statement and physical motivation,
2. governing equations, symbols, SI units, and assumptions,
3. FDM, FEM, and hybrid interpretation,
4. Python API and `ProblemIR` impact,
5. planner and capability-matrix impact,
6. validation strategy and observables,
7. completeness checklist across the stack,
8. known limits and deferred work.

If the note does not exist or is incomplete, the task is not ready for implementation.

## Architectural guardrails

1. The only public scripting surface is the embedded Python DSL in `packages/fullmag-py`.
2. Python scripts build object graphs and canonical `ProblemIR`; Rust validates, normalizes, and plans that IR.
3. The shared API must never expose grid indices, GPU array internals, or FEM-only implementation details.
4. `strict`, `extended`, and `hybrid` are first-class execution semantics from day one.
5. Rust remains the control plane: validation, normalization, planning, runner, API, provenance.
6. Native compute stays behind stable C ABI boundaries.
7. Containerized workflows are the default verification path.
8. `docs/physics/` notes are auto-rendered into frontend documentation — writing physics docs is writing user docs.
9. **No single source file should exceed ~1000 lines.** When a module grows past this threshold, split it into focused submodules. Monolithic files are harder to review, test, and maintain. Prefer many small, well-named files over few large ones.

## Repo map

- `packages/fullmag-py` — public embedded Python DSL and runtime scaffolding.
- `crates/fullmag-ir` — typed canonical `ProblemIR`, validation, and planning summaries.
- `crates/fullmag-plan` — execution planner: lowers `ProblemIR` into backend-specific plans.
- `crates/fullmag-runner` — reference runner: executes planned simulations via `fullmag-engine`.
- `crates/fullmag-engine` — reference CPU solver (exchange-only LLG + Heun).
- `crates/fullmag-cli` — CLI for IR validation, planning, and execution.
- `crates/fullmag-api` — control-plane HTTP API.
- `crates/fullmag-py-core` — private PyO3 bridge for Python/Rust integration.
- `apps/web` — Next.js control room for scripts, jobs, and artifacts.
- `native/` — native backends and C ABI.
- `docs/specs` — canonical architecture and IR specs.
- `docs/plans` — active and archived implementation plans.
- `docs/physics` — publication-style physics documentation and validation notes.
- `.agents/skills` — canonical agent skills.
- `.agents/workflows` — canonical agent workflows.
- `external_solvers/` — **reference solver codebases** (not part of Fullmag, gitignored).

## Reference solvers

`external_solvers/` contains full source trees of existing micromagnetic solvers. These are **read-only references** — study them for patterns and best practices, never copy code verbatim.

| Directory | Solver | Language | Method | Learn from |
|-----------|--------|----------|--------|------------|
| `external_solvers/3/` | **mumax3** | Go + CUDA | FDM | Lightweight workflow, CUDA kernel patterns, cuFFT demag, batch/server mode, `engine/` module structure |
| `external_solvers/plus/` | **mumax+** | C++/CUDA + Python | FDM | **Python API design** (`mumaxplus/` package), extensible core, C++/CUDA kernel architecture, `src/` operator layout |
| `external_solvers/BORIS/` | **BORIS** | C++/CUDA | FDM | Multiphysics design, multi-GPU path, spin transport, `Boris/` module organization, CUDA library patterns |
| `external_solvers/tetmag/` | **tetmag** | C++ | FEM | FEM mesh pipeline, GPU operator assembly, tetrahedral discretization, `gpu/` kernels, boundary conditions |
| `external_solvers/tetrax/` | **tetrax** | Python | FEM | Python-first FEM workflow, `tetrax/` package structure, test patterns, pyproject packaging |

### When to consult reference solvers

- **Designing a new CUDA kernel** → check `3/cuda/`, `plus/src/`, `BORIS/BorisCUDALib/`
- **Designing Python API classes** → check `plus/mumaxplus/` (closest to our architecture)
- **Implementing energy terms** → compare operator structures across all solvers
- **FEM discretization** → check `tetmag/` and `tetrax/tetrax/`
- **Demag/FFT pipeline** → check `3/engine/` and `plus/src/`
- **Time integrators** → compare approaches in `3/engine/`, `plus/src/`, `BORIS/Boris/`
- **Writing validation tests** → check `3/test/`, `plus/test/`, `tetmag/examples/`, `tetrax/tests/`

## Definition of done for foundation changes

- The change strengthens the embedded Python DSL or typed IR boundary.
- Physics-facing changes include a corresponding `docs/physics/` update.
- README, AGENTS, skills, prompts, and web/CLI copy stay aligned.
- Containerized checks cover Rust, Python, repo consistency, and smoke flow.
- No source file exceeds ~1000 lines; large modules are split into focused submodules.
