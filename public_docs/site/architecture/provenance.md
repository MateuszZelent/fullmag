---
title: Provenance
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/provenance-contract.md
---

(public-docs-architecture-provenance)=
# Provenance

Provenance keeps requested intent separate from resolved execution and makes every meaningful
action reproducible.

## Recorded identities

| Record | Public meaning |
|---|---|
| Requested backend/device/precision | What the script asked for |
| Resolved backend/device/precision | What the planner selected |
| Requested vs resolved term | Interaction and solver-lane provenance |
| Mesh configuration | Requested and realized mesh summary |
| Stage completion reason | Why a stage ended |
| Field and mesh revisions | Revision identity for inspection and caching |

## Constraints

- A failure must state the unsatisfied combination; it never substitutes another interaction,
  backend, device, or precision silently.
- Automatic fallback, when allowed, must be visible in provenance; fallback is prohibited on
  strict lanes.
- Artifacts and field buffers are revision-keyed so cache invalidation follows mesh and field
  revisions.

See the runtime provenance surface in {doc}`../python-api/runtime/provenance`.
## Control Room crosswalk

This architecture page has no direct authoring screen. Use the object, material, physics, mesh, or stage editor named by the relevant terminal API page; architecture concepts are currently `inspection-only` unless a concrete UI owner is listed. `TODO: frontend support` applies to architecture capabilities without a corresponding control. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

This page documents architecture rather than a standalone Python callable. Exact constructors, arguments, validation, and examples belong to the linked Python API pages; do not infer a public function from an internal architecture term.

## Physics and bibliography scope

No independent physical model is introduced here. Scientific equations are owned by the applicable physics or numerical-methods page. Bibliography: not applicable to this architecture overview; implementation ownership is recorded in the source-code references on the terminal page.
## Source-code index

- No standalone Python callable is introduced by this architecture page. Use the exact source symbol named by the linked API or implementation page; architecture terms alone are not public functions.

