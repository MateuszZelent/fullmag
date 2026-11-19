# Frontend v2 - Shared 3D Model Export (glTF 2.0 / GLB / VTU / ParaView PVD)

**Status:** Proposed production export contract  
**Date:** 2026-11-17  
**Scope:** Browser 3D model export core (`apps/control-room/src/shared/export-3d/`) and Python offline export package (`packages/fullmag-py/src/fullmag/export3d/`) for FDM grids, FEM meshes, complex eigenmodes / harmonic response modes, and saved result bundles.

## 1. Purpose

Fullmag users need portable, publication- and inspection-ready 3D exports of solved and authored micromagnetic fields without re-running or writing ad-hoc conversion scripts. Exported assets must preserve:

1. **Exact visual color parity** with Control Room (`directionColor.ts`, `scalarColorPalette.ts`, `viewport3dColorSpace.ts`, and `viewport3dScalarSurfaceShader.ts`);
2. **Exact physical field & geometry provenance** (SI meters, `si_meters_per_unit`, `origin_offset_m`, active magnetic support vs. far-air exclusion, Floquet wavevector `k_F`, and phasor convention);
3. **First-class static and animated 3D representations** for both regular FDM lattices and unstructured/mixed FEM meshes (`tet4`, `prism6`, `pyramid5`, `hex8`, `tri3`, `quad4`) across `.glb`, `.gltf`, `.vtu`, `.pvd`, and self-contained `.vtu.zip` archives.

This specification defines one shared data and serialization contract implemented symmetrically in TypeScript (`apps/control-room/src/shared/export-3d/`) and pure Python + NumPy (`packages/fullmag-py/src/fullmag/export3d/`).

## 2. Non-Goals

- No rewrite of solver physics or ProblemIR semantics inside export builders.
- No direct component `fetch()` calls or screen-shaped backend export endpoints inside `apps/control-room/src/shared/export-3d/`.
- No `ShaderMaterial` export into glTF (`GLTFExporter` cannot serialize custom GLSL; glTF uses `KHR_materials_unlit` or `pbrMetallicRoughness` with linear-sRGB `COLOR_0`).
- No `EXT_mesh_gpu_instancing` requirement for 3D arrows (standard glTF 2.0 nodes + TRS tracks ensure compatibility with Blender, Three.js, Windows/macOS viewers, and glTF-Validator).

## 3. Supported Formats

| Format | Extension | Use case | Default `coordinateScale` |
|---|---|---|---|
| Binary glTF 2.0 | `.glb` | Compact single-file 3D viewers, Blender, Keynote/web, animated modes & playback | `auto_scene` |
| Embedded glTF 2.0 | `.gltf` | Inspectable JSON + embedded base64 binary buffer URI | `auto_scene` |
| VTK XML UnstructuredGrid | `.vtu` | ParaView / PyVista / scientific volume & surface inspection with SI fields | `si_m` |
| ParaView Collection / Archive | `.pvd` / `.vtu.zip` | Time-series (`playback_frames`) or phase-series (`phase_cycle`) VTU collections | `si_m` |

## 4. Color Parity & Color Space Contract

Both Control Room and `fullmag.export3d` evaluate colors using identical formulas:

1. **mumax3 HSL orientation (`color_mode = "orientation"`)**:
   - Vectors with `|v| <= 1e-30` or non-finite components map to neutral gray `[0.6, 0.6, 0.6]` (sRGB).
   - Otherwise: `hue = atan2(vy, vx)`, `saturation = 1.0`, `lightness = clamp(0.5 * vz / |v| + 0.5, 0.0, 1.0)`.
   - Converted from HSL to sRGB `[0, 1]`.
2. **Scalar palettes**:
   - Exact shared stop tables for `viridis`, `coolwarm`, `inferno`, `magma`, `jet`, `plasma`, `cividis`, `turbo`, `grayscale`, `rdbu`, and `twilight`.
   - Component/scalar modes (`x`, `y`, `z`, `magnitude`, `scalar`) normalize against a consistent scalar range `[vmin, vmax]` across all frames of an animation (`0.5` when `vmin >= vmax` or non-finite).
3. **Color spaces by target format**:
   - **glTF 2.0 (`COLOR_0` `VEC3` `FLOAT`)**: ALWAYS **linear-sRGB** via the piecewise sRGB EOTF (`c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4`), because glTF 2.0 specifies linear vertex colors and multiplies `COLOR_0` by `baseColorFactor`. When `vertexColors` / `COLOR_0` is used, `baseColorFactor` RGB stays `[1.0, 1.0, 1.0]` (`opacity` in alpha).
   - **VTK (`.vtu` `magnetic_texture_rgb`)**: **display sRGB** quantized to `UInt8` triples (`[0..255]`, `NumberOfComponents="3"`), enabling direct RGB rendering in ParaView without scalar colormapping.

## 5. Complex Phasor & Floquet Phase Conventions

For complex frequency-domain fields (`real + i * imag`, eigenmodes and driven frequency response):

- **Temporal phase sign** (`phasorConventionAdapter.ts`):
  - `exp_i_omega_t`, `exp_plus_i_omega_t` -> `+1`
  - `exp_minus_i_omega_t` -> `-1`
- **Floquet spatial phase sign**:
  - `dst_equals_src_exp_minus_i_k_dot_delta_r` -> `-1`
  - `dst_equals_src_exp_plus_i_k_dot_delta_r` -> `+1`
- **Evaluated phase angle**:
  - `theta = wrap_pi(temporal_sign * phase_rad + spatial_sign * dot(k_F, pos_m - cell_origin_m))`
- **Projections**:
  - `phase_rotated_real`: `amplitude_scale * (real * cos(theta) - imag * sin(theta))`
  - `real`, `imag`, `abs`, and `phase`.

## 6. Coordinate Scaling & Provenance

Supported `coordinateScale` / `coordinate_scale` modes:

- `auto_scene`: centers the domain bounding box at `(0, 0, 0)` using `origin_offset_m = 0.5 * (bbox_min + bbox_max)` and scales the largest extent to `2.0` (`units_per_meter = 2.0 / max_extent`, `si_meters_per_unit = max_extent / 2.0`).
- `nm` (`1e9`), `um` (`1e6`), `mm` (`1e3`), `si_m` (`1.0`) with `origin_offset_m = [0, 0, 0]`.

glTF exports record provenance in `asset.extras.fullmag` (`schema`, `coordinate_scale`, `si_meters_per_unit`, `origin_offset_m`, `quantity_id`, `color_mode`, `color_palette`, `scalar_range`, `animation_kind`, `phasor_convention`, `wavevector_kf`, `frequency_hz`, and `frame_times_s`).

## 7. Geometry, Shell Extraction & Support Filtering

### 7.1 FDM Regular & Multilayer Grids

- Cell ordinal layout follows Fullmag's canonical C-order `(nz, ny, nx)` flattened (`cell = iz * (nx * ny) + iy * nx + ix`), with cell `(ix, iy, iz)` spanning `[ox + ix*dx, ox + (ix+1)*dx]` etc.
- **glTF / GLB**: vectorized 6-neighbor exterior face culling extracts only exposed boundary quads (4 unshared vertices per exposed face, exact outward normal, and owning cell index per vertex so every voxel face preserves crisp uninterpolated cell color). Deduplicated grid boundary edges are emitted as optional `mode: 1` (`LINES`) wireframe primitives.
- **VTK (`.vtu` / `.pvd`)**: emits compacted `VTK_HEXAHEDRON` (`12`) volume cells over active magnetic cells so ParaView slice, clip, and threshold filters operate on true 3D volume geometry.

### 7.2 FEM Meshes & Active Magnetic Support

- Supports `MeshData`, `MeshIR` / `SavedFemP1FieldGeometry` (`tet4=10`, `hex8=12`, `prism6=13`, `pyramid5=14`, `tri3=5`, `quad4=9`), and raw node/cell/triangle arrays.
- When `active_node_mask` is present (e.g., excluding `FarAir` / `TransitionAir` nodes around a magnetic body), only fully active cells (all incident nodes active) are retained, and coordinates/bounds/field arrays are compacted onto the active magnetic support so far-air sentinel values never distort bounding boxes or color ranges.
- For glTF surfaces, exterior boundary faces of the active volume are extracted, oriented outward relative to owning cell centroids, and triangulated (`quad4` split into two triangles). Nodal fields keep indexed smooth vertices; cell fields expand faces so each triangle keeps its flat cell color.

## 8. glTF 2.0 Binary, Deduplication & Animation Contract

### 8.1 Binary Layout & Node Naming

- `.glb` strictly follows Khronos glTF 2.0: 12-byte little-endian header (`magic = 0x46546C67`, `version = 2`), 4-byte aligned JSON chunk (`0x4E4F534A`, `0x20` padding), and 4-byte aligned BIN chunk (`0x004E4942`, `0x00` padding).
- All glTF node names are strictly sanitized to `[A-Za-z0-9_-]+` and guaranteed unique (avoiding Three.js `PropertyBinding` delimiter collisions on `.`, `:`, `[`, `]`, `/`).
- `POSITION` and morph-target `POSITION` accessors always include `min` and `max`; `INDICES` use `UNSIGNED_SHORT` (`5123`) when `max_index < 65535` and `UNSIGNED_INT` (`5125`) otherwise; animation sampler `bufferView`s omit `target`; animation `input` accessors include `min` and `max`.

### 8.2 Accessor Deduplication & Frame Switching

- Across multi-frame animations (`phase_cycle` or `playback_frames`), all `K` surface frame meshes share the **exact same** `POSITION`, `NORMAL`, `INDICES`, and morph-delta accessors, differing only in `COLOR_0`.
- Frame visibility switches cleanly via `STEP` `"scale"` channels (`[1, 1, 1]` on the active interval, `[0, 0, 0]` otherwise).

### 8.3 Surface Wave Morph Targets

- When `surface_displacement_scale > 0` on a harmonic `phase_cycle` mode, two relative `POSITION` morph targets (`delta_cos`, `delta_sin`) along surface normals are attached to the shared geometry (`weights` initialized `[0, 0]` for animated or `[1, 0]` for static) and animated via `LINEAR` `"weights"` channels (`SCALAR` `FLOAT` output `[cos(theta_k), sin(theta_k)]`) so both standing and Floquet traveling waves interpolate smoothly.

### 8.4 3D Vector Arrows

- Real 3D geometry: watertight cylinder shaft + cone head oriented along `+Y` (no `EXT_mesh_gpu_instancing`).
- **Static export**: merged triangle mesh with per-vertex linear-sRGB `COLOR_0` (skipping zero-norm vectors).
- **Animated export**: one shared unit arrow geometry (`POSITION`, `NORMAL`, `INDICES` deduplicated) paired with a bounded quantized linear-sRGB material palette (or single material for `monochrome`), animated per site via `LINEAR` `translation`, `rotation` (XYZW unit quaternions with enforced `dot(q[t], q[t-1]) >= 0` hemisphere continuity for artifact-free SLERP), and `scale` tracks.

## 9. VTK `.vtu` & ParaView `.pvd` / `.vtu.zip` Contract

- `.vtu` writes valid `<VTKFile type="UnstructuredGrid" version="0.1" byte_order="LittleEndian" header_type="UInt32|UInt64">` XML with `<Points>`, `<Cells>` (`connectivity`, `offsets`, `types`), physical SI vectors/scalars in `<PointData>` or `<CellData>`, and `UInt8` 3-component `magnetic_texture_rgb`.
- Supports inline base64 `format="binary"` (default) and `format="ascii"`.
- `.pvd` writes `<VTKFile type="Collection">` referencing frame `.vtu` files by physical `timestep` (seconds for playback, radians for phase cycles), either alongside a `<stem>_frames/` / `frames/` directory or packaged into a self-contained `.vtu.zip` archive (`series.pvd` + `frames/frame_XXXX.vtu`).

## 10. Public API Surface

### 10.1 TypeScript (`apps/control-room/src/shared/export-3d/`)

- Orchestration & summary: `export3DModel(request: Export3DModelRequest): Promise<Export3DResult>`, `summarizeExport3DCapabilities(targets: readonly Export3DTargetInput[]): Export3DCapabilitySummary`, `resolveExport3DFilename(...)`.
- Helpers re-exported from `index.ts`:
  - Types & transforms (`export3dTypes.ts`): `defaultCoordinateScaleForFormat`, `resolveEffectiveAnimationMode`, `resolveBoundsFromTargets`, `resolveCoordinateTransform`, `transformPositionByCoordinateTransform`, `sanitizeGlTfNodeName`, `sanitizeJsonExtrasValue`.
  - Color evaluation (`export3dColorEvaluator.ts`): `srgbToLinearChannel`, `linearToSrgbChannel`, `evaluateDirectionSrgb`, `evaluateDirectionLinear`, `evaluateScalarPaletteSrgb`, `evaluateScalarPaletteLinear`, `evaluateComplexFieldArray`, `evaluateComplexHarmonicQuadratureBasis`, `resolveFieldScalarRange`, `evaluateFieldColorsLinear`, `evaluateFieldColorsSrgbUInt8`, `quantizeLinearRgb`.
  - Geometry & arrows (`export3dVoxelShell.ts`, `export3dArrowGeometry.ts`): `extractVoxelExteriorShell`, `resolveFdmActiveCellMask`, `computeFdmCellCentersM`, `buildSurfaceFeatureEdgePositions`, `createUnitArrowGeometry`, `samplePointIndicesSpatially`, `computeAutoArrowBaseLengthM`, `buildMergedStaticArrowGeometry`, `buildAnimatedArrowMeshesAndTracks`.
  - Serializers (`export3dGltfBuilder.ts`, `export3dZipArchive.ts`, `export3dVtkSerializer.ts`): `buildExport3DGltf`, `extractVolumeBoundarySurfaceIndices`, `computeTriangleVertexNormals`, `crc32`, `createStoreZipArchive`, `readStoreZipArchive`, `serializeVtkExport`, `buildPvdCollectionXml`.

### 10.2 Python (`fullmag.export3d`, exported on `fullmag`)

All 31 symbols in `fullmag.export3d.__all__`:

- **High-level exporters & result**: `export_grid_3d`, `export_mesh_3d`, `export_mode_animation_3d`, `export_result_bundle_3d`, `Export3DResult`.
- **Low-level writers & serializers**: `export_glb`, `export_gltf`, `export_vtu`, `export_pvd`, `serialize_glb_bytes`, `serialize_gltf_json`, `serialize_vtu_xml`, `build_pvd_xml`.
- **Color & complex phasor utilities**: `DIRECTION_HSL_NEUTRAL_RGB`, `DIRECTION_HSL_ZERO_NORM`, `SCALAR_PALETTES`, `srgb_to_linear`, `linear_to_srgb`, `direction_hsl_srgb`, `direction_hsl_linear`, `scalar_color_srgb`, `scalar_color_linear`, `evaluate_complex_vector_field`, `evaluate_field_colors`.
- **Voxel shell & 3D arrow geometry**: `VoxelShell`, `extract_voxel_shell`, `UnitArrowMesh`, `create_unit_arrow_mesh`, `vectors_to_quaternions_xyzw`, `build_merged_arrow_mesh`, `build_animated_arrow_tracks`.

## 11. Verification Gates

- **TypeScript (`apps/control-room`)**: Vitest suite in `src/shared/export-3d/*.test.ts` plus `check-architecture-hygiene.mjs` (verifies `src/shared/` isolation, no raw CSS hex literals, no direct `fetch()` or `/v2/` strings, valid GLB magic/version/JSON chunks/accessor deduplication, VTU XML, and `.vtu.zip` archive contents).
- **Python (`packages/fullmag-py`)**: `pytest` suite in `packages/fullmag-py/tests/test_export3d.py` alongside `test_public_python_api_documentation.py` and `test_selection_geometry.py`.
