---
name: gpt-taste
description: "Use for high-judgment Fullmag product decisions that turn broad UI requests into scientifically useful workspace interactions."
---

# Fullmag Product Taste

Use this skill for product-level UI and interaction judgment in the micromagnetics control room. The user instruction and root `AGENTS.md` take precedence. This is model-neutral: it does not select a model, reasoning effort, or test budget.

## Product test

Design for a scientific workstation. Every visual or interaction decision should make authoring, running, inspecting, exporting, or debugging a physical problem clearer.

Prefer:

- one integrated workflow over isolated screen concepts;
- one ribbon and one unified viewport;
- capability-aware commands over disabled mysteries;
- resource revisions and provenance over optimistic guesses;
- compact stable tools over decorative cards;
- canonical Python/IR vocabulary over frontend-only names;
- runtime-published data over preview recomputation;
- Catppuccin Mocha/Latte tokens and shared shadcn/ui-style primitives.

## Layout direction

Use a ribbon for grouped commands, structural or contextual panels for model/stage state, a center viewport with inspectable overlays, inspectors for properties/capability/provenance/diagnostics, and docks for logs/jobs/charts/fields/problems. Center tabs may organize primary work when they share one workspace model.

## Motion and content

Use motion only to clarify command lifecycle, dock state, selection, stale-to-fresh resource updates, or viewport-layer changes. Avoid perpetual animation, parallax, hover trails, and attention-consuming effects near numerical data.

Use concrete scientific labels: quantities, units, materials, meshes, stages, runs, resources, revisions, backends, precision, and diagnostics. Distinguish requested intent from resolved runtime reality, and label stale, unsupported, degraded, and estimated data.

## Checklist

- Can the concept be expressed in the Python DSL and lowered to `ProblemIR`?
- Does a ribbon command map to an API command/resource and completion state?
- Does viewport state come from resource hooks/adapters?
- Are FDM/FEM differences handled by capabilities/adapters rather than product forks?
- Are shared accessible primitives reused?
- Is the result measurable and useful in a scientific workflow?
