# Fullmag agent runtime assets

`.agents/` is the canonical source for Fullmag workflows and skills.

## Primary rule

Any physics-facing work must pass the `physics-first-gate` workflow before implementation.

## Semantic rule

Agents must preserve one semantic core across Python authoring, UI authoring, `ProblemIR`, planning,
session/run APIs, and backend execution.
If the UI creates or edits a simulation, it must remain exportable as canonical Python.

## Control-room API rule

The canonical local browser contract is the resource-first API described in:

- `docs/specs/resource-first-control-room-api-v1.md`
- `docs/specs/control-room-api-endpoint-reference-v1.md`
- `docs/specs/session-run-api-v1.md`
- `docs/adr/0011-resource-first-api.md`

Rules:

- `status` stays thin and revision-driven,
- `workspace/*` carries selection/ribbon/layout state and must not mutate physics semantics,
- `authoring/*` carries model-builder, inspector, interaction, and study edits against one
  canonical `scene_revision`,
- heavy numerical payloads use binary data-plane transports,
- React components do not call `fetch()` directly,
- FDM/FEM differences stay in capability guards and domain adapters,
- old `bootstrap` / `poll` / `preview/*` flows are legacy, not target architecture.

## Build and run rule

When a repository-level `justfile` recipe exists for a build/run/package task, agents should use it
as the default entrypoint instead of inventing lower-level command sequences.

## Structure

- `skills/` - canonical agent skills
- `workflows/` - canonical agent workflows

`.github/` mirrors these rules for GitHub and Copilot entrypoints.
