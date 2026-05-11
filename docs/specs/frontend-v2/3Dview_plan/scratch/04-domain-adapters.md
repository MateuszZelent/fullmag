# 04 - Domain Adapters and Resource Hooks

**Decision:** one domain-neutral render model; adapters own FDM/FEM differences.

## 1. Adapter Responsibility

The adapter layer converts API/resource data into render-model inputs. It is the only place that understands whether the current domain is FDM or FEM.

The renderer receives:

- `CellGeometryResult`;
- object/part/airbox render metadata;
- field location and compatible field mapping;
- bounds and units;
- LOD/sampling decisions already applied.

## 2. API Resources

| Resource | Facade method | Used by |
|---|---|---|
| domain meta | `api.data.domain.meta()` | FDM grid, FEM bounds, units |
| domain topology | `api.data.domain.topology()` | FEM full solver topology |
| field vector | `api.data.fields.vector(quantity, query)` | scalar/vector layers |
| visualization state | `api.visualization.state()` | quantity, layers, sampling, clip |
| visualization patch | `api.visualization.patch(patch)` | toolbar/commands |
| scene | `api.model.scene()` | authoring object ids/names/material refs |
| universe | `api.model.universe()` | bounds/airbox config |
| shared manifest | `api.meshing.sharedDomainManifest()` | object/part/airbox mapping |
| shared topology | `api.meshing.sharedDomainTopology()` | FEM mesh inspection if needed |
| object topology | `api.meshing.objectTopology(objectId)` | optional focused object render |
| part topology | `api.meshing.partTopology(partId)` | airbox/part inspection |

No hook in this document may call `api.fetchBinary("/v2/...")`; that method must not exist as a module-facing escape hatch.

## 3. Resource Hook Aggregator

```typescript
export function useViewport3DResources(): Viewport3DResourceSnapshot {
  const status = useSessionStatus();
  const revisions = status.data?.resources ?? null;

  const meta = useDomainMeta(revisions);
  const manifest = useSharedDomainManifest(revisions);
  const topology = useDomainTopology(revisions);
  const visualization = useVisualizationState(revisions);
  const scene = useSceneResource(revisions);
  const universe = useUniverseResource(revisions);

  const quantity = visualization.data?.quantity?.active_quantity_id ?? null;
  const vectorQuery = resolveFieldVectorQuery(visualization.data);
  const field = useFieldVectorResource(quantity, vectorQuery, revisions);

  return {
    status,
    meta,
    manifest,
    topology,
    visualization,
    scene,
    universe,
    field,
  };
}
```

All individual hook loaders are memoized. Tests must prove unrelated revision ticks do not refetch field/topology resources.

## 4. FDM Adapter

```typescript
class FdmDomainAdapter implements SpatialDomainAdapter {
  readonly discretization = "fdm";

  constructor(
    private readonly meta: DomainMeta,
    private readonly scene: SceneDocumentResource | null,
    private readonly universe: UniverseResource | null,
    private readonly sampling: SamplingConfig,
    private readonly budget: RenderBudget,
  ) {}

  buildGeometry(): CellGeometryResult {
    const grid = requireGrid(this.meta);
    const displayedGrid = chooseFdmDisplayedGrid(grid, this.sampling, this.budget);
    return buildFdmInstancedCuboids(displayedGrid, this.budget);
  }

  getFieldLocation(): FieldLocation {
    return "cell";
  }
}
```

Rules:

1. 204 topology is expected for FDM.
2. Use `DomainMeta.grid` and `DomainMeta.bounds`, but do not assume the current placeholder FDM spacing is final physical truth without checking metadata quality.
3. Choose displayed cells before allocating instance matrices.
4. If the object mapping is not present for FDM, render as one magnetic domain and report degraded object picking.

## 5. FEM Adapter

```typescript
class FemDomainAdapter implements SpatialDomainAdapter {
  readonly discretization = "fem";

  constructor(
    private readonly meta: DomainMeta,
    private readonly topology: DecodedTopology,
    private readonly manifest: MeshSharedDomainManifestResource,
    private readonly scene: SceneDocumentResource | null,
    private readonly universe: UniverseResource | null,
    private readonly sampling: SamplingConfig,
    private readonly budget: RenderBudget,
  ) {}

  buildGeometry(): CellGeometryResult {
    return buildFemBoundaryGeometry({
      topology: this.topology,
      partLookup: buildPartLookup(this.manifest.mesh_parts),
      budget: this.budget,
    });
  }

  getFieldLocation(): FieldLocation {
    return "node";
  }
}
```

Rules:

1. Use `MeshPartResource.role`, `object_id`, `geometry_id`, `material_id`, `boundary_face_indices`, `node_indices`, `surface_faces`, and bounds.
2. Do not assume marker value equals scene object array index.
3. Airbox is `role="air"`.
4. Magnetic objects are parts with `role="magnetic_object"` or manifest regions mapped to source objects.
5. If manifest mapping is missing, render topology in degraded mode and disable object-level picking instead of guessing.

## 6. Render Model Builder

```typescript
export function buildViewport3DRenderModel(
  resources: Viewport3DResourceSnapshot,
  selection: SelectionState,
  budget: RenderBudget,
): Viewport3DRenderModel {
  const adapter = createDomainAdapter(resources, budget);
  if (!adapter) return emptyViewport3DRenderModel(resources);

  const geometry = adapter.buildGeometry();
  const objects = buildObjectRenderData(adapter, geometry, resources);
  const airbox = buildAirboxRenderData(adapter, geometry, resources);
  const scalarField = buildScalarFieldRenderData(adapter, resources.field, resources.visualization);
  const vectorField = buildVectorFieldRenderData(adapter, resources.field, resources.visualization, budget);

  return {
    objects,
    airbox,
    universeBounds: adapter.getBounds(),
    scalarField,
    vectorField,
    layers: resolveLayers(resources.visualization),
    selection: mapSelection(selection, objects, airbox),
    cameraHint: resolveCameraHint(resources),
    clip: resolveClip(resources.visualization),
    status: resolveStatus(resources),
    sampling: resolveSampling(resources.visualization, budget),
    quantity: resolveQuantity(resources.visualization),
    diagnostics: buildModelDiagnostics(resources, geometry),
  };
}
```

The builder is pure. It does not fetch, mutate backend state, or store global caches.

## 7. Field Resource Query

Field-vector resource key:

```typescript
type FieldVectorResourceKey =
  `data:field-vector:${quantityId}:${component}:${scopeKind}:${scopeId}`;
```

Query decisions:

- vector glyph direction uses `component=full`;
- scalar coloring can use `component=magnitude`, `x`, `y`, `z`, or quantity-specific component;
- FEM scope may be `full`, `object`, `part`, `airbox`, or `selection`;
- FDM scope defaults to full domain until backend supports object scope metadata.

## 8. Picking Lookup

The render model may include lookup tables for hit resolution:

```typescript
interface HitLookup {
  objectIdByFace?: string[];
  partIdByFace?: string[];
  objectIdByInstance?: string[];
  partIdByInstance?: string[];
}
```

Lookup data is derived from manifest/parts and displayed geometry. It is not derived from scene-order marker guesses.

If a lookup cannot be built confidently, picking returns a degraded hit with coordinates only and does not set object selection.

## 9. Degraded States

Adapters must produce explicit degraded states for:

- FDM physical spacing not available;
- FEM topology missing;
- FEM manifest mapping missing;
- field quantity unavailable;
- field location incompatible with current topology;
- resource cache over budget;
- object/part lookup unavailable;
- airbox absent.

Degraded states appear in overlays/diagnostics. They must not silently fall back to legacy preview/bootstrap paths.

