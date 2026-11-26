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
sub-object regions, topological charge extensions, and initial magnetization textures using isolated
drafts and unit-aware SI inputs (`PropertyRow` via `InspectorTemplate`, supporting `m`, `mm`,
`um`/`µm`, and `nm`).

## Geometry, CSG Stack, Array 3D & Placement (`GeometryObjectInspectorPanel`)

`GeometryObjectInspectorPanel` (`apps/control-room/src/modules/inspector/inspectors/objects/geometry/ObjectGeometrySpec.tsx`,
paired with `BuilderPrimitiveInspectorPanel` and `GeometryNodeInspectorPanel`) organizes editing
into **Geometry** and **Placement** mode tabs:

- **Parametric shapes, STL & CSG stack**: Authors nine parametric primitives (`box`, `thin_film`,
  `cylinder`, `sphere`, `ellipsoid`, `cone`, `torus`, `polygon_prism`) and `ImportedMesh` (STL),
  plus interactive **Modifiers & Boolean tools** (`PrimitiveModifiersBar`) and the **Geometry
  stack** (`GeometryStackEditor`, `BooleanNodeSection`) for composite CSG (`union`, `subtract`,
  `intersect`, `imprint_regions`) and **Array 3D** lattices (`Array3DLatticeTableSection` with
  instance-count budget validation). Object deletion surfaces dependent-impact previews
  (`DeleteObjectImpactDialog`).
- **Placement tab (`buildGeometryTransformSections`)**: Authors center translation $\mathbf{r}_0$
  (synchronized live with the 3D move gizmo / Ribbon `Move` `W`), **Rotation (Euler XYZ)** with
  `Centroid` / `World origin` / `Custom` pivot, and **Dimensionless scale multiplier**
  (`sx, sy, sz`, `Uniform aspect lock`, `Bake Scale into Dimensions`, `Reset Scale`). Ribbon
  `Rotate`/`Scale` buttons remain disabled with `PROBLEM_IR_03_RIGID_TRANSFORM_REASON`.
- **Optimistic revision reconciliation**: If a live Python script modifies an unrelated object while a Geometry draft is open, `reconcileObjectEditAck` / `reconcileObjectIdentityAck` preserves unconflicted local edits or presents explicit Refetch / Rebase / Retry controls.

```{image} /_static/images/ui/inspector-geometry-and-csg.png
:alt: Geometry inspector displaying primitive box shape, SI unit Size X/Y/Z inputs, summary cards, and Placement tab
:align: center
:width: 100%
```

## Materials, Absorbing Boundaries, Regions & Extensions

- **Materials (`ObjectMaterialInspectorPanel`, `ObjectAbsorbingBoundaryInspectorPanel`)**: Edits scalar magnetic parameters ($M_{\text{sat}}$, exchange stiffness $A_{\text{ex}}$, Gilbert damping $\alpha$, uniaxial/cubic anisotropy, and opt-in material physics activation), creates or assigns library/session materials (`MaterialLibraryPickerDialog`).
- **Absorbing boundaries**: Select a magnet and choose **Physics → Add ABL**. Its **Absorbing Boundary** inspector (`ObjectAbsorbingBoundaryInspectorPanel`) edits independently positioned layers, region targets, frame, widths, peak contribution, and profile. See {doc}`/frontend/inspectors/absorbing-boundaries` for a strip and a region-clipped half-ring.
- **Topological charge extension (`TopologicalChargeExtensionPanel`)**: Dedicated per-object extension inspector (`object.extension.topological-charge`) for skyrmion / topological-charge postprocessing configuration.
- **Spatial Regions (`RegionsCollectionInspectorPanel`, `ObjectRegionOverviewInspectorPanel`)**: Organizes region authoring across declarative specs (`RegionsRootSpec.tsx`, `RegionDetailSpec.tsx`, `RegionMagneticParametersSpec.tsx`, `RegionMeshSpec.tsx`), validating bounds and scalar material/mesh/texture overrides before commit.

```{image} /_static/images/ui/inspector-material-and-regions.png
:alt: Object Regions inspector listing Pinning Annulus and Skyrmion Core cylindrical regions, priority and shape metadata, and YIG Film Core summary
:align: center
:width: 100%
```

## Magnetic Textures (`MagneticTextureInspectorPanel`)

`MagneticTextureInspectorPanel` (`apps/control-room/src/modules/inspector/panels/magnetic-texture/MagneticTextureInspectorPanel.tsx`)
writes initial magnetization assignments, presets, and imported OVF/NPZ field files targeting either
an entire object or a specific spatial region. `MAGNETIZATION_TEXTURE_PRESETS` (`texturePresets.ts`)
exposes **20** canonical preset builders (plus legacy `random_seeded` compatibility) grouped into
five categories:

- **Uniform & stochastic**: `uniform`, `random` (`Random seeded`);
- **Vortices & skyrmions**: `vortex`, `antivortex`, `bloch_skyrmion`, `neel_skyrmion`, `antiskyrmion`, `skyrmionium`, `bimeron`, `skyrmion_lattice`;
- **Domains & walls**: `domain_wall` (`normal_axis`, `center_offset`, `width`, `kind`, `left`, `right`), `two_domain`, `vortex_wall`, `artificial_spin_ice`;
- **Helices & cones**: `helical`, `conical`, `spiral`;
- **3D topological textures**: `hopfion` (`radius`, `hopf_charge`, `background_sign`, `axial_scale`, `phase_rad`), `hopfion_compact_support` (`major_radius`, `minor_radius`), `bloch_point`.

Each preset supports coordinate-mapping transforms (`mappingSpace`, `mappingProjection`, `pivot`,
`translation`, `rotationDeg`, `scale`, `clampMode`), through-axis extent thickness control, and
`tile_period` parity with Python/Rust, and automatically displays prepared magnetization in the 3D
viewport once applied.

```{image} /_static/images/ui/inspector-magnetic-texture.png
:alt: Magnetic Texture inspector displaying target metadata, magnetization reference, asset label, and Preset selector
:align: center
:width: 100%
```

## Selection routes and Python interoperability

- **Selection routes**: `object.root` (`ObjectOverviewInspectorPanel`), `object.geometry` / `object.geometry.node` / `builder.primitive` (`GeometryObjectInspectorPanel`, `GeometryNodeInspectorPanel`, `BuilderPrimitiveInspectorPanel`), `object.material` (`ObjectMaterialInspectorPanel`), `object.absorbing-boundary` (`ObjectAbsorbingBoundaryInspectorPanel`), `object.extension.topological-charge` (`TopologicalChargeExtensionPanel`), `object.regions` / `object.region` / `object.region.magnetic-parameters` / `object.region.mesh` (`RegionsCollectionInspectorPanel`, `ObjectRegionOverviewInspectorPanel`, `ObjectRegionMagneticParametersInspectorPanel`, `ObjectRegionMeshInspectorPanel`), and `object.magnetic-texture` / `object.region.texture` (`MagneticTextureInspectorPanel`).
- **Transaction boundary**: Changes stay staged in local draft stores until **Apply** commits with `runAuthoringMutationWithHistory`.
- **Python-only features**: General callable spatial material fields and custom Python callable magnetization textures remain `Python-only` (see {doc}`/frontend/capability-register`).
- **Python alignment**: Geometry primitives, CSG compositions, Array 3D lattices, materials, absorbing boundary frames, region overrides, and initial magnetization fields are constructed in `packages/fullmag-py` and preserved verbatim during live `fm.connect()` sessions; script export preserves authored region IDs and material assignments.

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Geometry, CSG stack, Array 3D & Placement | `apps/control-room/src/modules/inspector/inspectors/objects/geometry/ObjectGeometrySpec.tsx` | `GeometryObjectInspectorPanel`, `BuilderPrimitiveInspectorPanel` |
| Placement transform sections (Euler, pivot, scale) | `apps/control-room/src/modules/inspector/inspectors/objects/geometry/GeometryTransformSections.tsx` | `buildGeometryTransformSections` |
| Scalar material & anisotropy authoring | `apps/control-room/src/modules/inspector/inspectors/objects/material/ObjectMaterialSpec.tsx` | `ObjectMaterialInspectorPanel` |
| Absorbing boundary layer configuration | `apps/control-room/src/modules/inspector/panels/constraint/ObjectExtensionsSpecs.tsx` | `ObjectAbsorbingBoundaryInspectorPanel` |
| Topological charge extension | `apps/control-room/src/modules/inspector/extensions/topological-charge/TopologicalChargeExtensionPanel.tsx` | `TopologicalChargeExtensionPanel` |
| Object-owned regions & overrides | `apps/control-room/src/modules/inspector/inspectors/objects/regions/RegionsRootSpec.tsx` | `RegionsCollectionInspectorPanel` |
| Initial magnetization texture & transform editor | `apps/control-room/src/modules/inspector/panels/magnetic-texture/MagneticTextureInspectorPanel.tsx` | `MagneticTextureInspectorPanel` |
| Canonical preset catalog (20 presets) | `apps/control-room/src/shared/domain/magnetization-texture/texturePresets.ts` | `MAGNETIZATION_TEXTURE_PRESETS` |
