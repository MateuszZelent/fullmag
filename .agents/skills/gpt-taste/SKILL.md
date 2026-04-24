---
name: gpt-taste
description: "Use for high-judgment Fullmag product taste decisions. Converts broad UI requests into scientifically useful workspace interactions, avoiding generic marketing design and preserving OpenAPI, one ribbon, unified viewport, and canonical semantics."
---

# Fullmag Product Taste

## Core Directive

Design for a micromagnetics workstation, not a presentation site. Every visual or interaction decision must make authoring, running, inspecting, exporting, or debugging a physical problem clearer.

## Taste Heuristics

1. Prefer an inspectable control-room layout over dramatic visual composition.
2. Prefer one well-integrated workflow over multiple isolated screens.
3. Prefer capability-aware commands over disabled mysteries.
4. Prefer resource revisions and provenance over optimistic UI guesses.
5. Prefer compact, stable tools over decorative cards.
6. Prefer canonical Python/IR vocabulary over frontend-only naming.
7. Prefer data already published by the runtime over recomputation through preview commands.

## Layout Direction

- Ribbon at the top for grouped commands.
- Left or contextual panels for object/model/stage structure.
- Center viewport with overlays that can be toggled and inspected.
- Right inspectors for properties, capability, provenance, and diagnostics.
- Bottom docks for logs, jobs, charts, live fields, and problems.
- Center tabs are acceptable for primary work modes, but they should share the same workspace model.

## Motion Direction

Use motion only to clarify:

- command submission and completion,
- dock open/close,
- selection changes,
- stale-to-fresh resource updates,
- viewport layer toggles.

Avoid scroll choreography, perpetual animation, parallax, hover trails, magnetic buttons, or anything that burns attention near numerical data.

## Content Direction

- Use concrete scientific labels: quantity, units, material, mesh, stage, run, resource, revision, backend, precision.
- Make warnings direct and actionable.
- Distinguish requested intent from resolved runtime reality in UI copy.
- Do not use marketing copy, fake customer data, generic personas, or celebratory empty states.

## Product Taste Checklist

- Can the same concept be expressed in Python DSL and lowered to `ProblemIR`?
- Does the ribbon command map to an API command/resource and a completion state?
- Does the viewport state come from resource hooks/adapters rather than component-local transport?
- Are FDM/FEM differences handled by capability/adapters rather than separate product UX?
- Is the user told when data is stale, unsupported, degraded, or estimated?
- Did the change reduce old/new architecture mixing?
