---
title: Mesh Quality and Reports
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
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
a failed rebuild does not erase the last successfully built mesh; success alone does not establish numerical qualification.

```{image} /_static/images/ui/explorer-jobs-and-diagnostics-tabs.png
:alt: Explorer Diagnostics tab opened alongside the Jobs tab showing Problem, Health, Capabilities, Solver, Mesh, Frequency Domain, and Performance nodes
:align: center
:width: 100%
```

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `apps/control-room/src/modules/inspector/inspectors/mesh/MeshQualitySpec.tsx` | `MeshQualityInspectorSpecPanel` | Declarative mesh quality route and scope presentation |
| `apps/control-room/src/modules/inspector/panels/MeshQualityStatisticsView.tsx` | `MeshQualityStatisticsView` | Distributions and quality presentation |
