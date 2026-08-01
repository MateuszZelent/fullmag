# 2D Slice Capabilities

This status file distinguishes implementation, managed execution, browser proof, and scientific validation for the canonical `field-map` surface.

| Feature | FDM CPU | FEM CPU | FEM GPU run | Evidence status |
|---|---|---|---|---|
| Plane heatmap and probe | yes | yes | yes | scientifically validated |
| Slab average | yes | yes | yes | scientifically validated |
| Depth projection | yes | yes | yes | scientifically validated |
| Surface projection | not applicable in fixture | yes | yes | scientifically validated for FEM |
| Magnetic vectors | yes | yes | yes | browser verified |
| Contours and masked holes | yes | yes | yes | focused model tested |
| Mesh overlay | structured outline | exact FEM section | exact FEM section | browser verified |
| PNG export | yes | yes | yes | contract tested |
| 3D frame preview | yes | yes | yes | browser verified |

## Status Language

Use these messages consistently:

- `Requires FEM explicit topology` for FEM-only mesh and airbox controls on unsupported domains.
- `No airbox mesh part in current domain` when FEM topology exists but has no airbox part.
- `Using local fallback` or `mesh: local fallback after backend error` when backend mesh overlay cannot be used.
- `Not implemented E2E yet` for contour, slab, primitives, and airbox vectors.

## Managed evidence (2026-07-18)

- `fdm-cpu`: science and browser reports pass; requested/resolved `fdm/cpu`; 100 switches; 61,594,483-byte heap growth.
- `fem-cpu`: science and browser reports pass; requested/resolved `fem/cpu`; 100 switches; 7,936,018-byte heap growth.
- `fem-gpu`: science and browser reports pass; requested `cuda` (GPU alias), resolved `fem/gpu`; 100 switches; 7,457,770-byte heap growth.
- Cross-backend manufactured linear-field relative RMS is about `1.19e-3` for both FEM lanes.

Reports and screenshots are under `.fullmag/reports/viewport-2d-planar-monitor-smoke/`. Planar sampling is currently an explicit CPU postprocessor even when the simulation run resolves to FEM GPU; the report records this instead of implying a device-resident sampler.

## Release Policy

The implemented monitor lanes above are browser-verified and scientifically validated. Airbox-specific field availability still follows the canonical quantity catalog and is not inferred merely from visible airbox geometry. A scene without monitors intentionally creates only an uncommitted Midplane draft; it requires Apply before data is rendered.
