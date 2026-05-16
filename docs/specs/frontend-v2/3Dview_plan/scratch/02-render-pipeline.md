# 02 - Single R3F Render Pipeline

**Decision:** one R3F canvas with demand rendering and explicit resource ownership.

## 1. Scene Graph

```tsx
<Canvas frameloop="demand">
  <OrbitCameraControls cameraState={camera} />
  <SceneLighting displayMode={layers.displayMode} />

  <ObjectMeshLayer objects={renderModel.objects} />
  <ScalarFieldLayer field={renderModel.scalarField} objects={renderModel.objects} />
  <VectorGlyphLayer vectors={renderModel.vectorField} sampling={renderModel.sampling} />
  <WireframeLayer objects={renderModel.objects} visible={renderModel.layers.wireframe.visible} />
  <AirboxLayer airbox={renderModel.airbox} />
  <AxesGridLayer bounds={renderModel.universeBounds} />
  <BoundsBoxLayer bounds={renderModel.universeBounds} />
  <SelectionHighlightLayer selection={renderModel.selection} />
</Canvas>
```

Layer components receive render-model data only. They do not call APIs, select global state directly, or branch on backend endpoint paths.

## 2. Geometry Strategy

### FDM

FDM uses structured-grid metadata, not binary topology. The adapter must apply LOD before allocating instanced buffers.

```typescript
function buildFdmGeometry(input: FdmGeometryInput): CellGeometryResult {
  const displayGrid = chooseDisplayedGrid(input.grid, input.sampling);
  const instanceCount = displayGrid.count;

  assertWithinBudget(instanceCount, input.memoryBudget);

  return {
    kind: "instanced-cuboids",
    cellCount: input.grid.cellCount,
    displayedCellCount: instanceCount,
    baseGeometry: getSharedUnitCubeGeometry(),
    instanceMatrices: buildInstanceMatrices(displayGrid),
    cellCenters: buildDisplayedCellCenters(displayGrid),
    fieldLocation: "cell",
  };
}
```

Do not allocate `cellCount * 16` matrices and then decimate. The displayed cell set is chosen first.

### FEM

FEM uses decoded FMMT topology plus shared-domain manifest metadata.

```typescript
function buildFemBoundaryGeometry(input: FemGeometryInput): CellGeometryResult {
  const positions = toFloat32RenderBuffer(input.topology.positions, input.bufferOwner);
  const boundaryFaces = input.topology.boundaryFaces;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.Uint32BufferAttribute(boundaryFaces, 1));
  geometry.computeVertexNormals();

  return {
    kind: "tet-boundary",
    elementCount: input.topology.elementCount,
    boundaryFaceCount: input.topology.boundaryFaceCount,
    geometry,
    fieldLocation: "node",
    partLookup: input.partLookup,
  };
}
```

Markers may be retained for diagnostics and compatibility, but object/part/airbox identity comes from mesh manifest/parts.

## 3. R3F Resource Ownership

R3F can dispose mounted Three.js objects, but Phase 5 still tracks ownership explicitly.

Required tracker categories:

- `geometry`;
- `material`;
- `texture`;
- `renderTarget`;
- `bufferAttribute`;
- `typedArray`;
- `worker`;
- `subscription`;
- `observer`.

Every layer must register what it owns or expose deterministic counts through a shared tracker hook. Tests assert the count returns to zero on unmount.

## 4. Scalar Field Layer

Scalar color updates must reuse compatible topology geometry.

Rules:

1. Color buffer key includes `quantityId`, `component`, `fieldRevision`, `topologyRevision`, `scope`.
2. If topology is unchanged, update color attributes/uniforms only.
3. If color transform exceeds the main-thread threshold, run it in a worker or chunked scheduler.
4. Abort stale transforms when a newer field revision arrives.
5. Release stale color buffers after the layer swaps to the new buffer.

## 5. Vector Glyph Layer

Vector glyphs are budgeted render resources.

Rules:

1. Request `component=full` for direction vectors unless a scalar component is explicitly selected for color only.
2. Include `scope_kind` and `scope_id` in the resource key.
3. Apply backend `max_glyphs`, vector density, and frontend memory budget before allocating instance buffers.
4. Reuse arrow base geometry/material.
5. Abort stale glyph transforms when field revision, quantity, vector domain, or density changes.

## 6. Wireframe and Mesh View

Wireframe is a first-class mesh inspection mode.

Rules:

1. FDM wireframe uses the same displayed cell set as the surface layer.
2. FEM wireframe derives edges from rendered boundary geometry.
3. Edge geometry is built only when wireframe is visible.
4. Hiding wireframe releases edge buffers unless they are still retained by cache within budget.

## 7. Airbox Layer

Airbox rendering uses mesh parts with `role="air"` and visualization airbox state. It does not depend on `SceneObject.isAirbox`.

Airbox may render as:

- transparent surface;
- wireframe;
- points;
- hidden.

Airbox vectors are shown only when `VectorLayerDomain` resolves to `airbox_only`. Magnetic texture must not disappear when the airbox layer changes.

## 8. Dirty Rendering

The canvas renders only on dirty reasons:

- initial resource ready;
- camera interaction;
- resize;
- topology resource ready;
- field/color/glyph resource ready;
- visualization state change;
- selection change;
- explicit context restore;
- explicit solver animation mode.

Status ticks, logs, unrelated resource invalidations, inspector drafts, or tree expansion must not invalidate the 3D canvas.

## 9. Context Loss

R3F handles browser WebGL events, but Fullmag must still validate recovery.

Required behavior:

1. `webglcontextlost` marks viewport diagnostics degraded and clears module-owned resource counters.
2. `webglcontextrestored` rebuilds from current render model.
3. No stale decoded binary or render buffer is retained solely because a lost context held it.
4. Tests dispatch context loss/restored and assert the canvas returns to a ready/degraded-but-stable state.

## 10. Large Simulation Strategy

Budgets apply before allocation.

| Scenario | Required strategy |
|---|---|
| Small FDM/FEM | Full displayed topology allowed. |
| Medium domain | Backend `balanced` sampling plus client display budget. |
| Large domain | Backend `interactive`/`memory_saver`; active scope preferred. |
| Oversize field vector | Reject or degrade with explanation rather than retaining unbounded data. |
| Heavy color/glyph transform | Worker/chunked scheduler with abort. |

No implementation may claim support for "1M cells" by allocating full per-cell render buffers without checking memory budget first.

