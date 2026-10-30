# 2D View

The `field-map` module (**2D View**) shows a physical slice or projection of the
active simulation domain. Open it with the **2D View** tab or press `2`. A new
session opens the session **Default** slice (XY, mid-plane); it never creates or
edits a planar monitor. Authored planar monitors are created explicitly from the
Inspector and selected as the source there.

The view is a Canvas 2D surface with a worker, not a second WebGL viewport; only
the active centre tab is mounted. The plot keeps the physical u:v aspect ratio.

## Toolbar (mumax3-style)

The row above the map holds the decisions changed most often. Every control edits
the same session state as the Inspector.

| Control | Effect |
|---|---|
| Quantity | Any available spatial quantity from the field catalog. |
| Component | `Direction` colours the full vector with the mumax3 HSL wheel (hue = in-plane angle in world XY, +X red; lightness = z, +Z white, −Z black). `x`, `y`, `z` use a diverging palette with a symmetric range; `|v|` a sequential palette with an automatic range. A manual range is kept. |
| Plane | `XY`, `XZ`, `YZ` for the Default slice. |
| Single layer / Average | One section, or the occupied-measure mean over the full thickness along the normal. |
| Object layer | A realized object as a named layer: the mean over a slab of the object's thickness, centred on it (`name · z ∈ [a, b] · slab`). `Free section` returns to a plane. Selecting an object region in the scene scopes the map to that region. |
| Line profile | Shift + drag on the map draws a segment; the chart below shows the selected component and, for vectors, x/y/z against the arc length, with CSV/TSV/PNG export. FEM profiles include every element-face crossing. Escape or `Clear` removes it. |
| Layer slider, `‹` `›` | On a structured FDM grid: the cell layer, shown as `layer k / N−1` and the snapped cell-centre coordinate. On a swept FEM mesh: the certificate node planes, shown as `node plane k / N−1`; a request between planes is sampled where it is and reads `between node planes`, and `‹` `›` move to the adjacent plane. On other FEM meshes: a continuous coordinate; `‹` `›` move by the median height of the elements the plane cuts (a navigation aid, not a data layer), and the caption shows how many elements the plane cuts. While a new layer loads, the caption reads `showing … · loading …` and the previous image stays on screen. |
| Arrows | Quiver on a screen grid with arrowheads; ⊙ / ⊗ mark vectors mostly out of / into the plane. Over direction colours the arrows are dark. |
| Mesh | FEM: section of the mesh; FDM: the structured-grid lines (`FMFG v1`). |

## Keyboard

`[` / `]` previous/next layer, `Shift+{` / `Shift+}` ±10 layers, `V` direction,
`X` `Y` `Z` components, `M` magnitude, `A` arrows, `G` mesh. Inside the map:
wheel or `+`/`−` zoom, drag or arrow keys pan, `0` or double-click fit, click or
`Enter` pins a probe. Shortcuts act only while the 2D View is the active tab.

## Inspector

The Inspector **2D visualization** panel holds the rest: source (Default or
monitor), resolution presets (FDM native grid and integer reductions), slab
thickness, colour map and range, units, opacity, vector style, contours, mesh
and boundary style, and provenance. `Requested → resolved` shows the coordinate
you asked for and the one the backend sampled (FDM snaps to a cell centre). The
data state reads **Live** only when the frame on screen matches the current
metadata and field revision.

## Export

`Export 2D PNG` uses the session colour map and range (direction colours
included). `Export 2D Data` writes a CSV of the sampled raster in SI units with
frame (u, v) and world (x, y, z) coordinates; empty pixels keep an empty value.

## Limits

FEM sampling accepts Tet4, Prism6, Pyramid5 and Hex8 carriers (scientific note
`docs/physics/0970-planar-monitor-sampling-and-projection.md`). Multislice and streamlines are planned in
`docs/plans/active/viewport-2d-mumax-parity-2026-10-27/05-plan-wdrozenia.md`.
Current evidence per lane is in `docs/status/2d-slice-capabilities.md`.
