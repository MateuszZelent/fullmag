---
title: Airbox Grading
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-airbox-grading)=
# Airbox Grading

Airbox grading controls near-body and far-field element sizes.

| Control | Meaning |
|---|---|
| `airbox_hmin` | near/interface lower target |
| `airbox_hmax` | far-field upper target |
| `airbox_growth_rate` | requested growth bound |
| `geometric` | multiplicative distance grading |
| `linear` | legacy distance interpolation |
| curvature/narrow-region fields | geometry-driven additional limits |

The realized distribution is the minimum of all active size fields plus conformity constraints.
Airbox extent and air-mesh refinement require separate convergence studies.
