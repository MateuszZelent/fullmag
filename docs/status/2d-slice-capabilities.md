# 2D Slice Capabilities

This status file describes implemented behavior, staged behavior, and known limits for the spatial 2D Slice viewport.

| Feature | FDM | FEM API Raster | FEM Exact Local | Status |
|---|---|---|---|---|
| Heatmap | yes | yes | yes | reference_executable |
| Quantity overlay off | yes | yes | yes | reference_executable |
| Mesh overlay | no | backend/local fallback | yes | production_target |
| Mesh overlay status | no | backend/local/none | local | production_target |
| Airbox wireframe | no | local fallback | yes, FEM single with airbox part | P0_target |
| Magnetic vectors | backend path | backend arrows | local in-plane arrows | P1_target |
| Airbox vectors | staged | staged | staged | semantic_only |
| Projection/all_layers | structured-grid projection | projection resource | projection renderer | production_target |
| Contour | staged | staged | staged | semantic_only |
| Slab | staged | staged | staged | semantic_only |
| Primitives | staged | staged | staged | semantic_only |

## Status Language

Use these messages consistently:

- `Requires FEM explicit topology` for FEM-only mesh and airbox controls on unsupported domains.
- `No airbox mesh part in current domain` when FEM topology exists but has no airbox part.
- `Using local fallback` or `mesh: local fallback after backend error` when backend mesh overlay cannot be used.
- `Not implemented E2E yet` for contour, slab, primitives, and airbox vectors.

## Current Release Notes

- Added a shared 2D Slice availability model for ribbon and command gating.
- Enabled 2D airbox wireframe controls for FEM single-slice domains with airbox parts.
- Kept 2D airbox visibility local to the 2D toolbar path by default.
- Routed active 2D Slice full-domain quantities through dense FEM field data so `H_demag`/`H_eff` can render in the airbox while magnetic-only quantities stay object-scoped.
- Added backend/local/none mesh overlay source resolution and visible status.
- Added local exact FEM arrow glyphs for magnetic vectors.
- Added overlay-only raster rendering and mesh topology keys for stable chart updates.
- Added segment caps for mesh and airbox overlays.

## Release Policy

Do not mark 2D Slice as fully production-ready until:

- P0 tests pass,
- manual QA confirms mesh and airbox behavior on small and large FEM domains with airbox,
- staged controls remain disabled with explicit reasons,
- live browser checks confirm pan/zoom and layer toggles remain stable.
