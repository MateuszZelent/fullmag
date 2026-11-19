---
title: Geometry, Materials, Regions & Magnetic Textures
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-inspectors-objects-and-materials)=
# Geometry, Materials, Regions & Magnetic Textures

Domain entity panels edit scene objects, magnetic material properties, absorbing boundaries,
sub-object regions, and initial magnetization textures using isolated drafts and unit-aware SI
inputs (`QuantityField` and `Vector3Field` supporting `m`, `mm`, `um`/`µm`, and `nm`).

## Geometry, Transform, and CSG Scope (`GeometryObjectPanel`, `ObjectPlacementPanel`)

`GeometryObjectPanel` (`apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx`)
and `ObjectPlacementPanel` handle primitive shape parameters (`box`, `cylinder`, `sphere`,
`microstrip`, `cpw`, `thin_film`, and read-only inspection of script-created geometries such as CSG
composites), rigid translation (`translation`, also interactively via Ribbon **Move** `W`), metadata
(`name`, `notes`, `ObjectGeneralPanel`), and unit conversions via `quantityDraftFields`.

- **Rigid rotation & scale policy**: Rigid `rotation` and `scale` controls stay disabled in the UI (`PROBLEM_IR_03_RIGID_TRANSFORM_REASON`); interactive Boolean CSG builder commands on the Ribbon are currently gated behind `preview: true` and stripped from the active toolbar, so multi-body CSG operations remain `Python-only` and should be authored in Python.
- **Optimistic revision reconciliation**: If a live Python script modifies an unrelated object while a Geometry draft is open, `reconcileObjectEditAck` / `reconcileObjectIdentityAck` preserves unconflicted local edits or presents explicit rebase controls.

```{image} /_static/images/ui/inspector-geometry-and-csg.png
:alt: Geometry inspector displaying primitive box shape, SI unit Size X/Y/Z inputs, summary cards, and Placement tab
:align: center
:width: 100%
```

## Materials, Absorbing Boundaries, and Regions (`ObjectMaterialPanel`, `ObjectRegionsPanel`)

- **Materials (`ObjectMaterialPanel`, `ObjectAbsorbingBoundaryPanel`)**: Edits scalar magnetic parameters ($M_{\text{sat}}$, exchange stiffness $A_{\text{ex}}$, Gilbert damping $\alpha$, uniaxial anisotropy $K_{u1}$ and easy axis), creates or assigns library/session materials (`createMaterialThenAssign`).
- **Absorbing boundaries**: Select a magnet and choose **Physics → Add ABL**. Its **Magnetic Parameters → Absorbing Boundary** inspector edits independently positioned layers, region targets, frame, widths, peak contribution and profile. See {doc}`/frontend/inspectors/absorbing-boundaries` for a strip and a region-clipped half-ring.
- **Spatial Regions (`ObjectRegionsPanel`, `RegionsListPanel`)**: Organizes sub-panels under `inspector/panels/region/` (`ObjectRegionOverviewPanel`, `ObjectRegionGeometryPanel`, `ObjectRegionMagneticParametersPanel`, `ObjectRegionMeshPanel`, `ObjectRegionTexturePanel`, `ObjectRegionVisualizationPanel`, `ObjectRegionDiagnosticsPanel`, and `ObjectRegionNestedRegionsPanel`). Raw SI entries are staged in a `QuantityFieldDraftScope` and validated against owning object bounds (`clampObjectRegionDraftShapeToOwnerBounds`) before commit.

```{image} /_static/images/ui/inspector-material-and-regions.png
:alt: Object Regions inspector listing Pinning Annulus and Skyrmion Core cylindrical regions, priority and shape metadata, and YIG Film Core summary
:align: center
:width: 100%
```

## Magnetic Textures (`ObjectMagneticTexturePanel`)

`ObjectMagneticTexturePanel` (`apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx`)
writes initial magnetization assignments and presets targeting either an entire object or a specific
spatial region. `MAGNETIZATION_TEXTURE_PRESETS` (`texturePresets.ts`) exposes sixteen current preset
builders (plus legacy `random_seeded` compatibility):

- **Uniform & stochastic**: `uniform`, `random` (`Random seeded`);
- **Vortex & skyrmion textures**: `vortex`, `antivortex`, `bloch_skyrmion`, `neel_skyrmion`, `antiskyrmion`, `skyrmionium`, `bimeron`;
- **Domain walls & modulations**: `domain_wall` (`normal_axis`, `center_offset`, `width`, `kind`, `left`, `right`), `two_domain`, `vortex_wall`, `helical`, `conical`;
- **3D topological textures**: `hopfion` (`radius`, `hopf_charge`, `background_sign`, `axial_scale`, `phase_rad`) and `hopfion_compact_support` (`major_radius`, `minor_radius`).

Each preset accepts explicit coordinate-mapping transforms (`mappingSpace`, `mappingProjection`,
`pivot`, `translation`, `rotationDeg`, `scale`, `clampMode`) and triggers targeted 3D field
invalidation (`returnToCurrentFieldView`) once `commitMagneticTextureApply` completes.

```{image} /_static/images/ui/inspector-magnetic-texture.png
:alt: Magnetic Texture inspector displaying target metadata, magnetization reference, asset label, and Preset selector
:align: center
:width: 100%
```

## Selection routes and Python interoperability

- **Selection routes**: `object` / `object.geometry` / `object.general` / `object.placement` (`GeometryObjectPanel`, `ObjectGeneralPanel`, `ObjectPlacementPanel`), `object.material` / `material` (`ObjectMaterialPanel`), `object.region` / `region` (`ObjectRegionsPanel`, `RegionsListPanel`), and `object.magnetization` (`ObjectMagneticTexturePanel`).
- **Transaction boundary**: Changes stay staged in local draft stores until **Apply** commits with `runAuthoringMutationWithHistory`.
- **Python-only features**: Boolean CSG authoring, rigid `Rotate`/`Scale` authoring, and general spatial material callbacks remain `Python-only` (see {doc}`/frontend/capability-register`).
- **Python alignment**: Geometry primitives, CSG compositions, materials, absorbing boundary frames, region overrides, and initial magnetization fields are constructed in `packages/fullmag-py` and preserved verbatim during live `fm.connect()` sessions; script export preserves authored region IDs and material assignments.

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Geometry, placement & conflict rebase | `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx` | `GeometryObjectPanel` |
| Scalar material & anisotropy authoring | `apps/control-room/src/modules/inspector/panels/ObjectMaterialPanel.tsx` | `ObjectMaterialPanel` |
| Absorbing boundary layer configuration | `apps/control-room/src/modules/inspector/panels/ObjectAbsorbingBoundaryPanel.tsx` | `ObjectAbsorbingBoundaryPanel` |
| Object-owned regions & nested overrides | `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanel.tsx` | `ObjectRegionsPanel` |
| Initial magnetization texture & transform editor | `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx` | `ObjectMagneticTexturePanel` |
| Canonical preset catalog | `apps/control-room/src/shared/domain/magnetization-texture/texturePresets.ts` | `MAGNETIZATION_TEXTURE_PRESETS` |
