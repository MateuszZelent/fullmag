---
title: FDM Grid Inspector
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-meshing-fdm-grid-view)=
# FDM Grid Inspector

FDM meshing separates **global grid sizing and build authoring** from **realized grid/cell
inspection**. Selecting the study **Mesh** root (`Discretization & Mesh`, implemented by
`MeshRootInspectorSpecPanel`) provides interactive structured-grid configuration:

- **Z-stack mode**: switch between `Single 3D grid` (`single_3d`) and `Multilayer Z-slices` (`multilayer`);
- **Sizing definition**: author either voxel cell spacing (`Cell size Δ`) in SI units or integer counts (`Cell count N`: $N_x, N_y, N_z$);
- **Exchange-length guard**: automatically evaluates $l_{\mathrm{ex}}$ against the assigned magnetic material and warns when $\max \Delta > l_{\mathrm{ex}}$ (with a one-click quick fix setting $\Delta x, \Delta y \le 0.8\,l_{\mathrm{ex}}$);
- **7-smooth FFT snap**: optional toggle (`fftSmoothSnap`) snapping $N_x, N_y$ to 7-smooth FFT sizes for fast demagnetization convolution;
- **Save & Build Grid**: commits the updated discretization policy and runs `grid.build-fdm` (prompting via `MeshRebuildConfirmDialog` when re-voxelizing an already built grid).

Once built, the realized grid, per-layer, and single-cell inspector nodes (`FdmGridInspectorSpecPanel`,
`FdmGridLayerInspectorSpecPanel`, `FdmCellInspectorSpecPanel`) remain read-only evidence views
exposing:

- grid origin and cell-centre convention;
- spacing and integer shape;
- total cells and active/inactive participation;
- object and region membership;
- canonical mask status;
- grid fingerprint.

FEM-only policy writes and tetrahedral mesh-build commands remain withheld in the FDM lane. In the
unified 3D canvas, `FdmCuboidLayer` renders active structured cells and region masks (`FMRM` /
`FMBM`) cleanly without generating tetrahedral overlays.

```{image} /_static/images/ui/viewport-3d-interactive.png
:alt: 3D Viewport rendering FDM structured grid cells, vector glyphs, and coordinate frame
:align: center
:width: 100%
```

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx` | `MeshRootInspectorSpecPanel` | Interactive FDM grid sizing, $l_{\mathrm{ex}}$ guard, 7-smooth FFT snap, and `grid.build-fdm` |
| `apps/control-room/src/modules/inspector/inspectors/mesh/fdm/FdmGridSpec.tsx` | `FdmGridInspectorSpecPanel` | Read-only realized structured-grid inspector |
| `apps/control-room/src/modules/inspector/inspectors/mesh/fdm/FdmGridLayerSpec.tsx` | `FdmGridLayerInspectorSpecPanel` | Read-only multilayer FDM grid-layer inspector |
| `apps/control-room/src/modules/inspector/inspectors/mesh/fdm/FdmCellSpec.tsx` | `FdmCellInspectorSpecPanel` | Read-only single FDM cell inspection |
| `apps/control-room/src/modules/inspector/panels/fdmMeshInspectorModel.ts` | `resolveFdmObjectMeshInspectorModel` | Grid identity and participation semantics |
