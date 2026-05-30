# Arch waveguide 80 nm mesh diagnostic

Date: 2026-05-30

## Summary

The current `arch_waveguide_relax_50nm` FEM domain is not a surface-only mesh.
The live topology contains a conforming shared-domain tetrahedral volume mesh:

- total nodes: 79,756
- total tetrahedra: 495,350
- magnetic tetrahedra: 274,812
- air tetrahedra: 220,538
- magnetic node z bounds: -40 nm to +40 nm
- magnetic nodes inside -30 nm < z < +30 nm: 31,028
- magnetic nodes inside -5 nm < z < +5 nm: 4,714

The visual "empty middle" symptom came from display state, not from missing
volume elements. The active object display was `render_mode=surface` with
`surface_visible=true`, `wireframe_visible=false`, and `points_visible=false`.
In that state the viewport can only draw the shaded surface. `geometry_scope=full`
does not reveal the volume unless a volume-capable pass, such as wireframe,
points, or vectors, is also active.

## Evidence

API checks against the running local session:

- `GET /v2/sessions/current/status`
  - discretization: `fem`
  - explicit topology: `true`
  - mesh revision: 6
- `GET /v2/sessions/current/meshing/summary`
  - domain mesh mode: `shared_domain_mesh_with_air`
  - bounds z: -250 nm to +250 nm for airbox
  - object bounds z: -40 nm to +40 nm for the 80 nm waveguide
- `GET /v2/sessions/current/data/domain/topology`
  - binary FMMT payload decoded successfully
  - no invalid tetrahedra found in the decoded topology
- `GET /v2/sessions/current/meshing/meshes/shared-domain/manifest`
  - magnetic part `part:arch_waveguide_geom`
  - element range: 0..274812
  - node count: 59287
  - bounds z: -40 nm to +40 nm

Decoded magnetic z distribution confirms interior volume sampling. The node
distribution is dense at top and bottom surfaces, as expected, but it is not
surface-only.

## Root Cause

There are two separate issues:

1. Visualization state allowed the inspector to show `Full` while only the
   surface pass was drawable. This made the UI look like a full-volume mesh
   mode was active, even though the renderer had no active interior pass.
2. The example currently requests `layers=1` in `waveguide.mesh.thin_film(...)`.
   This is physically coarse for an 80 nm magnetic thickness. The mesh generator
   still produced volume tetrahedra and interior nodes, but the requested
   through-thickness intent is below the project's own warning threshold of four
   layers.

## Fix Applied

Frontend viewport fix:

- `Full` in the Geometry Scope section now turns on `surface+edges` if the
  current object has only the surface pass active.
- Magnetic mesh parts now draw the hidden/x-ray edge overlay for full-volume
  wireframes behind a shaded surface, instead of suppressing it for `full`.

This makes `Full` visibly diagnostic for FEM volume meshes without changing the
solver mesh or physics.

## Physics Recommendation

For the 80 nm arch waveguide, do not treat `layers=1` as a production physical
mesh. Use at least:

```python
layers = max(4, math.ceil(HEIGHT / WAVEGUIDE_BULK_HMAX))
```

For the current constants this resolves to `4` layers. This is the physically
safer setting for exchange-gradient and demag-related variation through the
thickness. The current `layers=1` setup is acceptable only as an interactive
coarse preview.

