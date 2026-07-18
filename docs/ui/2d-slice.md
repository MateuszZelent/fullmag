# 2D Slice

The `field-map` module is the spatial field view for inspecting a physical slice or projection of the active simulation domain. Click **2D** in the workspace or press `2`. When monitors exist, the first usable monitor is selected automatically. When none exist, Fullmag opens an uncommitted `Midplane` draft in the Inspector; **Apply** is required before the canonical scene is changed.

The view is a demand-driven Canvas 2D surface, not a second WebGL viewport. Only the active center surface is mounted.

## Heatmap / Quantity Overlay

The quantity overlay renders scalar raster data from the 2D field resource path when available. For FEM exact local rendering, the renderer samples the local tetrahedral section and fills slice polygons.

Supported controls:

- quantity selection,
- component selection,
- auto-scale,
- colorbar visibility through the quantity overlay toggle.

## Plane, Cut, Component

Planar monitors support `xy`, `xz`, `yz`, and arbitrary right-handed frames. Operators are `plane_sample`, `slab_average`, `depth_projection`, and `surface_projection`.

Slab averaging and depth projection are distinct physical reductions. They are not aliases for an unweighted all-layers average.

## Mesh Wireframe

FEM single-slice mesh overlay is supported through:

- backend slice mesh overlay when the resource is available,
- local exact fallback when backend overlay is unavailable,
- source status text such as `mesh: backend`, `mesh: local`, or `mesh: local fallback after backend error`.

Large overlays are sampled before rendering. The current hard cap is 50k segments.

## Airbox 2D

FEM single-slice airbox wireframe is supported when the current domain has an `air` or `outer_boundary` mesh part.

Rules:

- 2D airbox visibility is local to the 2D slice toolbar by default.
- 2D airbox toggles do not call the 3D airbox display command.
- Full-domain quantities such as `H_demag`, `H_eff`, `H_ext`, and `H_ant` request dense FEM field data so the quantity overlay can include airbox nodes.
- Magnetic-only quantities such as `m`, `H_ex`, and `torque` remain restricted to magnetic objects even when the airbox wireframe is visible.
- Missing airbox topology is reported as `No airbox mesh part in current domain`.

## Vectors

Magnetic vectors are supported in:

- backend raster slice rendering when the 2D field resource returns arrows,
- FEM exact local rendering through local in-plane arrow glyphs.

Airbox vectors remain staged until vector-domain routing is split from magnetic vectors.

## Projection / All Layers

`all_layers` uses projection/reduction controls. Single-slice-only overlays such as FEM exact mesh and airbox wireframe are disabled or unavailable in projection mode unless a dedicated projection outline exists.

## Export and diagnostics

`field-map.export-png` uses the revisioned planar `render.png` resource. The filename contains monitor, quantity, field revision, and a unit-safe slug. Surface overlap/fold occupancy remains visible as a degraded diagnostic rather than being silently discarded.

The legacy FEM mesh-quality cross-section endpoint remains available for mesh diagnostics and export, but it is no longer a competing top-level center surface.
