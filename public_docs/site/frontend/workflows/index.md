---
title: Frontend Workflows
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-workflows-root)=
# Frontend workflows

## FEM mesh workflow

1. Select the universe and author airbox geometry and grading.
2. Select each magnetic object and author its bulk, topology, and refinement policy.
3. Optionally select object regions and add local refinement.
4. Apply drafts; verify that the current mesh is marked stale.
5. Build the shared domain.
6. Inspect build mode, fallbacks, topology, attributes, quality, and mesh identity.
7. Start simulation stages only from a completed mesh matching current policy revisions.

## FDM grid workflow

1. Author cell size and per-magnet grid policy in Python/API.
2. Plan or run the study.
3. Inspect the resolved grid, active support, region membership, and fingerprint.
4. Change authoring and rerun when a different grid is required.

## Failure workflow

A failed build preserves the last successful mesh as a separate resource. The UI must display the
failed current attempt and the latest successful realization independently, preventing a failed
request from being mistaken for the mesh consumed by the solver.
