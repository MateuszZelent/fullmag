---
title: Provenance
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/resource-first-control-room-api-v2.md, docs/specs/runtime-distribution-and-managed-backends-v1.md
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
