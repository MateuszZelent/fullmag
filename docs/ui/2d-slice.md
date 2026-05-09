# 2D Slice

2D Slice is the spatial field view for inspecting a physical slice or projection of the active simulation domain. It is separate from scalar 2D time-series plots.

## Heatmap / Quantity Overlay

The quantity overlay renders scalar raster data from the 2D field resource path when available. For FEM exact local rendering, the renderer samples the local tetrahedral section and fills slice polygons.

Supported controls:

- quantity selection,
- component selection,
- auto-scale,
- colorbar visibility through the quantity overlay toggle.

## Plane, Cut, Component

Single-slice mode supports `xy`, `xz`, and `yz` planes through the shared slice toolbar state. FEM slice position uses physical coordinates when bounds are known; normalized position remains the fallback.

`all_layers` is a projection mode. It is not the same as slab mode.

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

## Known Limitations

- Contour and heatmap+contour are semantic-only staged controls.
- Slab mode is not implemented; do not treat it as all-layers projection.
- 2D primitive overlays are staged until authored primitives can be projected into the slice plane.
- Airbox surface and point rendering are not production paths for 2D; wireframe is the supported P0 mode.
