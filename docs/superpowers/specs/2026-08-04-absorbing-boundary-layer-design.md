# Per-object absorbing boundary layer

## Context

The MuMax scenario `tests/vlad/4.5GHz.mx3` uses
`ext_SetAbsorbingBoundaryAdvanced(400e-9, 300e-9, 0.5, "x+,y-,y+", "smootherstep", 0)`.
Fullmag needs the same intent in the canonical Python/ProblemIR/UI model.

## Decision

Expose the module through the per-object damping control:

```python
film.alpha.absorbing_boundary(
    total_width=400e-9,
    ramp_width=300e-9,
    max_damping=0.5,
    faces=("x+", "y-", "y+"),
    profile="smootherstep",
    frame="object",
)
```

`film.alpha = number` remains valid. `film.alpha` reads as a small proxy that
supports numeric conversion/equality and exposes the module method. One
configuration is stored per magnet; a later call replaces the earlier one.

The module is an additive damping profile. The full width is the inward extent
from the selected face. The final `ramp_width` of that layer is tapered from
zero to `max_damping` using the selected profile; the outer face reaches the
maximum. Multiple faces use the maximum profile weight at corners.

## Canonical data flow

```text
Python MagnetHandle.alpha.absorbing_boundary
  -> AbsorbingBoundaryLayer.to_ir()
  -> Ferromagnet.to_ir() / MagnetIR.absorbing_boundary
  -> planner alpha resolver
  -> FDM alpha_field or FEM alpha_field
  -> existing native material descriptors
```

The authoring scene stores the same optional object field and the script
builder preserves it in both directions. No global study field is introduced.

## Validation and capability boundary

Widths, damping, faces, profile, and frame are validated at the Python and IR
boundaries. FDM CPU and FEM planner paths materialize the field. FDM CUDA is
fail-closed because the native implementation rejects cellwise alpha fields.
FEM runtime support is subject to the existing managed qualification recipes.

## Non-goals

This change does not add a conductor-current antenna, electromagnetic PML, or
rotation-aware object coordinate frame. It does not change the LLG equation or
the native FEM ABI.
