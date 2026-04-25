# Fullmag agent runtime assets

`.agents/` is the canonical source for Fullmag workflows and skills.

## Primary rule

Any physics-facing work must pass the `physics-first-gate` workflow before implementation.

## Semantic rule

Agents must preserve one semantic core across Python authoring, UI authoring, `ProblemIR`, planning,
session/run APIs, and backend execution.
If the UI creates or edits a simulation, it must remain exportable as canonical Python.

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

## Build and run rule

When a repository-level `justfile` recipe exists for a build/run/package task, agents should use it
as the default entrypoint instead of inventing lower-level command sequences.

## Structure

- `skills/` - canonical agent skills
- `workflows/` - canonical agent workflows

`.github/` mirrors these rules for GitHub and Copilot entrypoints.
