---
title: Mesh Quality and Reports
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/resource-first-control-room-api-v2.md, apps/control-room/src/kernel/events/eventTypes.ts
---

(public-docs-frontend-meshing-quality-and-reports)=
# Mesh Quality and Reports

Quality views are evidence views, not editable policy.

The frontend normalizes and presents:

- element and boundary counts;
- size, edge-length, and volume distributions;
- minimum, mean, percentile, and histogram quality values;
- inverted and degenerate counts;
- region/object/airbox scopes;
- topology and fallback status;
- requested-versus-realized layer counts;
- raw JSON report, quality, and size-field resources.

Histogram hover is linked to the viewport by semantic scope, allowing the user to locate elements in
a problematic size or quality bin. The current build and latest-successful build remain distinct so
a failed rebuild does not erase the last qualified mesh.
