---
title: Shared Mesh Controls
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-shared-controls)=
# Shared mesh controls

FullMag normalizes common mesh-size vocabulary across universe and object policies while preserving
FDM/FEM-specific meaning.

| Python field | Unit | Meaning |
|---|---:|---|
| `maximum_element_size` / `hmax` | m | upper target in the active scope |
| `minimum_element_size` / `hmin` | m | lower target in the active scope |
| `maximum_element_growth_rate` / `growth_rate` | 1 | requested transition growth |
| `curvature_factor` | 1 | curvature-driven sizing factor |
| `narrow_region_resolution` | 1 | narrow-gap resolution policy |
| `calibrate_for` | 1 | physics/workflow calibration family |
| `size_preset` | 1 | named default bundle |
| `size_factor` | 1 | multiplier applied to preset-derived sizes |

## Calibration families

`general_physics`, `micromagnetics_static`, `micromagnetics_relaxation`,
`micromagnetics_frequency_domain`, `magnetostatics_dominated`, and
`imported_surface_cleanup` are accepted normalized names.

## Presets

`extremely_fine`, `extra_fine`, `finer`, `fine`, `normal`, `coarse`, `coarser`,
`extra_coarse`, and `extremely_coarse` provide fallback policy values. Explicit numeric values take
precedence.

For FEM objects, precedence is explicit object recipe, per-geometry workflow override, workflow
default, then study-level FEM default. Airbox targets are resolved separately. A preset is a policy,
not a convergence certificate.
