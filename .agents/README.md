# Fullmag agent runtime assets

`.agents/` is the canonical source for Fullmag workflows and skills.

## Primary rule

Any physics-facing work must pass the `physics-first-gate` workflow before implementation.

For native FEM/MFEM/CUDA/hypre/libCEED work, the default build and runtime
path is the container-backed repository `justfile`. Agents must inspect the
`justfile` first and use the matching managed/container recipe instead of
hand-rolled host `cargo`, `cmake`, Docker, or shell build commands. Host builds
are diagnostics only unless the user explicitly asks for a host-only check.
If an agent is about to build native FEM from the host, it must stop, find the
matching `just` recipe, and use that recipe unless no such recipe exists.
This is not only a final verification rule: the build container is the normal
build route for native FEM/MFEM/CUDA/hypre/libCEED work. Do not start with a
host-side build and treat the container as an afterthought.

## Semantic rule

Agents must preserve one semantic core across Python authoring, UI authoring, `ProblemIR`, planning,
session/run APIs, and backend execution.
If the UI creates or edits a simulation, it must remain exportable as canonical Python.

## Unified workspace rule

`/workspace` is one application shell. Do not reintroduce `Build` / `Study` / `Analyze` as
workspace-switching modes. Top-level modules such as `Geometry`, `Mesh`, `Study`, and `Results`
may change ribbon groups, inspector panels, viewport presets, and commands, but they must stay
inside the same workspace model and unified viewport system.

When touching frontend workspace code, agents must actively retire remaining stage-based assumptions
unless they are explicitly documented as temporary compatibility shims. Geometry authoring must use
the same unified 3D viewport used for FEM and FDM; it is a display/authoring preset, not a separate
builder viewport.

## Control-room API rule

The canonical local browser contract is the v2 session-scoped resource-first API described in:

- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/adr/0011-resource-first-api.md`

Rules:

- frontend work targets `/v2/platform/...` and `/v2/sessions/current/...`; public `/v1/live/current/...` has been removed,
- v2 route families are `platform`, `sessions`, `model`, `meshing`, `simulation`, `data`, `visualization`, `workspace`, `analysis`, `persistence`, and `diagnostics`,
- `status` stays thin and revision-driven,
- `workspace/*` carries selection/ribbon/layout state and must not mutate physics semantics,
- `model/*` carries model-builder, inspector, interaction, and study edits against one
  canonical `scene_revision`,
- all runtime control operations go through `POST /v2/sessions/current/simulation/commands`,
- heavy numerical payloads use binary data-plane transports,
- mesh/topology and field samples must support scoped access for selected objects, mesh parts, airbox, and workspace selection,
- React components do not call `fetch()` directly,
- React/UI code must not hand-roll endpoint strings outside the central typed client/facade,
- FDM/FEM differences stay in capability guards and domain adapters,
- old `bootstrap` / `poll` / `preview/*` flows are legacy, not target architecture.

## Backend architecture rule

The canonical backend solver architecture is:

- `docs/architecture/backend-golden-masterplan.md`
- `.agents/skills/backend-golden-masterplan/SKILL.md`

Backend work must identify the affected lane: FDM CPU, FDM GPU, FEM CPU, or FEM
GPU. FEM production work means MFEM/hypre/libCEED for CPU and GPU, not a new
standalone in-house FEM solver stack. The current `backends/fem` tree is the
production MFEM/hypre/libCEED implementation spine after the controlled
relocation from `native/backends/fem`. Production FEM must not move into
`crates`.
Historical `native-fem-*` documents are context only when they conflict with the
backend golden masterplan.

FEM demag is a model family, not one generic Poisson bucket. Changes must name
the strategy being touched, such as Poisson airbox Dirichlet/Robin,
PBC-reduced Poisson, FEM/BEM Fredkin-Koehler, BEM, FMM, or mapped exterior
shell, and must state mesh requirements, boundary semantics, runtime
realization, provenance, and validation impact.

## Build and run rule

When a repository-level `justfile` recipe exists for a build/run/package task, agents should use it
as the default entrypoint instead of inventing lower-level command sequences.
For build tasks, treat the repo `justfile` as the source of truth and prefer
managed/container recipes when they exist. Do not hand-roll equivalent
host-side `cargo`, `cmake`, Docker, or shell build commands unless there is no
matching recipe or the user explicitly asks for a host-only diagnostic.

For FEM/MFEM/CUDA/hypre/libCEED work, agents must use the container-backed
`just` recipes as the authoritative build/runtime path. The container recipe is
the default build path for native FEM work, not just a final verification step.
Inspect the repo `justfile` first, then run the matching managed/container
recipe instead of assembling host-side build commands. `cargo`, `cmake`, and
direct native binaries on the host are only smoke checks; final FEM runtime
verification must use recipes such as `just rebuild-fem-runtime`,
`just ensure-managed-fem-runtime`, `just fem-gpu-headless ...`,
`just verify-fem-relaxation-runtime`, or the managed run recipes.
Do not replace those recipes with host-side builds when deciding whether FEM
runtime work is done.
Do not begin native FEM build work with host `cargo`, `cmake`, raw `docker`, or
direct binary commands when a managed/container `just` recipe covers the task.
Use the container-backed `just` recipe first; host commands may follow only as
clearly labeled diagnostics.
When no managed/container recipe exists for the exact task, agents must say so
before using a host-side diagnostic command.

## Review rule

For code review, PR preparation, review comments, or reviewer feedback, agents should use
`skills/google-eng-review-practices/SKILL.md` alongside the relevant Fullmag domain skills.

## Structure

- `skills/` - canonical agent skills
- `workflows/` - canonical agent workflows

`.github/` mirrors these rules for GitHub and Copilot entrypoints.
