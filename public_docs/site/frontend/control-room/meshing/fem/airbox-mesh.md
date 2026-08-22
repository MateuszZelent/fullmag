---
title: Airbox Mesh Panel
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-meshing-fem-airbox-mesh)=
# Airbox mesh panel

The airbox panel edits the universe-owned exterior policy, not a magnetic-object recipe.

## Canonical authored controls

- domain mode: inherited, automatic, or manual;
- padding in $x$, $y$, and $z$;
- optional explicit airbox size and centre;
- airbox minimum and maximum element size;
- maximum element growth rate;
- geometric, linear, or automatic grading;
- curvature and narrow-region controls;
- advanced universe-policy JSON.

## Effective values

A separate read-only group displays `effective_config` published by the backend. Authored blank or
inherited fields are not replaced in the form by guessed values; effective values retain their own
provenance.

## Transactions

- **Apply Airbox Policy** saves the universe policy and invalidates the current shared-domain mesh.
- **Apply & Build Shared-Domain Mesh** saves a valid draft, then executes
  `mesh.build-shared-domain`.
- **Revert** discards the local draft.

For an FDM session only the domain geometry subset is retained; FEM-only airbox size-field keys are
removed from the outgoing request.
