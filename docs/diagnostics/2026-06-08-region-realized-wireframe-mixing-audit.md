# Region realized wireframe mixing audit

Date: 2026-06-08

## Summary

The reported symptom is plausible and traces to the current control-room region
overlay implementation, not to an old Three.js mesh instance being physically
left in the scene after mesh rebuild.

There are two overlapping problems:

1. the viewport can intentionally render authored primitive overlays and
   realized mesh-region overlays at the same time in `both` mode;
2. the realized mesh-region overlay does not render the backend-provided
   region mesh part directly. It reconstructs a tetra selection by testing
   all owner-object tetra centroids against the authored primitive shape.

For a region around a hole, such as `hole_refinement`, this centroid fallback is
too weak. Tetrahedra near or across the hole can be included if their centroid
falls inside the authored cylinder, even if the backend already resolved a
specific conformal mesh part for the region. This makes the realized overlay
look like tetrahedra are falling into the hole or like an old dummy primitive
wireframe was not removed.

## User-visible symptom

The bad visual state is expected to look like:

- a primitive cylinder/box/sphere wireframe is still visible after mesh build;
- a mesh-backed region wireframe also appears;
- for a cylindrical refinement region around a hole, the realized tetra overlay
  can include tetrahedra extending toward the hole interior;
- the result looks like stale primitive fallback geometry is mixed with the
  final mesh.

The current `examples/permalloy_box_relax_300x1000x10nm.py` is a representative
case:

```python
hole_refinement = body.add_region(
    "hole_refinement",
    fm.Cylinder(radius=hole_refinement_radius, height=hole_height),
    priority=10,
    realization_policy="conformal",
)
hole_refinement.mesh(minimum_element_size=0.5e-9, maximum_element_size=1e-9, order=1)
hole_refinement.material.Ms = 400e3
```

The authored region is a cylinder larger than the actual hole. If both authored
and realized overlays are visible, the primitive cylinder and selected tetra
wireframe are visually stacked.

## Evidence

### 1. The scene renders both overlay families when the local mode allows it

`apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx:749-770`
renders two separate layers:

- `RegionMeshOverlayLayer` for realized mesh-backed regions;
- `RegionOverlayLayer` for authored primitive regions.

Those layers are independent. When `regionOverlayMode` is `both`, both are
mounted in the same R3F scene. That is a comparison mode, but it is also the
mode most likely to look like a stale primitive was not removed.

### 2. The authored overlay source is independent of mesh realization

`apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:990-998`
builds `allRegionOverlays` from the model region resource and scene document.
It does not pass `realizedRegionKeys` into `resolveViewport3DRegionOverlays`.

`apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:1024-1034`
then computes:

- `meshRegionOverlays` as a filtered subset of `allRegionOverlays`;
- `regionOverlays = allRegionOverlays`.

So the authored primitive overlay remains available even when the mesh-backed
region exists. That is consistent with the `both` display contract, but the
default/product behavior should probably be `realized` after a current mesh is
available.

### 3. Backend manifest exposes exact region mesh parts

The backend manifest builder resolves mesh-backed region parts in
`crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs:3212-3268`.

For object regions, it emits:

- `source_region_candidate_id`;
- `mesh_part_ids`;
- `element_count`;
- bounds.

This means the frontend has a direct mesh-part identity for realized region
visualization.

### 4. The frontend currently ignores `mesh_part_ids` during geometry extraction

`apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:291-321`
uses `mesh_part_ids` only to decide whether a region is mesh-backed.

`apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:323-350`
uses the same `mesh_part_ids` only for visualization target mapping.

But `RegionMeshOverlayLayer` receives:

```tsx
magneticParts={femDomain.magneticParts}
regions={meshRegionOverlays}
```

It does not receive the manifest region records or the specific `mesh_part_ids`.

### 5. Realized region tetra selection is reconstructed from authored shape

`apps/control-room/src/modules/viewport-3d/layers/regionOverlayModel.ts:188-230`
calls `regionMeshElementIndices(region, topology, ownerParts)`.

`apps/control-room/src/modules/viewport-3d/layers/regionOverlayModel.ts:356-371`
does this:

1. collect all candidate tetrahedra from owner object parts;
2. compute each tetra centroid;
3. keep the element when `regionContainsWorldPoint(region, centroid)` is true.

This is the core bug. The mesh has already been realized, but the viewport
re-runs a geometric point-in-primitive approximation over the whole owner
object. For hole-adjacent conformal regions this can select visually wrong
tetrahedra. It also cannot faithfully represent backend region ownership when
the backend mesher has split parts by `geometry_id`.

## Root cause

The realized region overlay is not actually using the realized region partition
as the source of truth. It uses the authored primitive as a client-side selector
against owner-object topology.

That creates a false mental model in the viewport:

- backend mesh manifest says: "this region is represented by these mesh parts";
- frontend realized overlay says: "this region is any tetra in the owner object
  whose centroid lies inside the authored primitive".

Those are not equivalent for conformal region meshing, especially around holes,
thin features, sharp boundaries, and refinement regions whose authored shape is
larger than the material domain subset it affects.

## Why it looks like a stale dummy mesh

The current code does not show evidence of a leaked R3F geometry from an old
primitive object. The stale-looking behavior is produced by normal rendering:

- authored primitive overlay remains mounted in `both` mode;
- realized overlay is generated from an approximate primitive containment test;
- both overlays share region colors and selection styling;
- all overlay materials disable depth testing, so the primitive and bad tetra
  wireframes float visibly on top of the mesh.

So the visible artifact can look like "old dummy mesh was not removed", but the
more likely source is incorrect overlay source-of-truth plus comparison mode.

## Recommended production fix

### Fix 1: make realized overlay consume manifest region mesh parts directly

Replace the realized overlay input path with a manifest-backed model:

- keep `RegionOverlayLayer` for authored primitive intent;
- introduce/extend a realized-region input that carries `mesh_part_ids`;
- resolve those part ids through `femDomain.partsById`;
- build realized region surface/wireframe from exactly those parts, not from
  owner-object centroid containment.

The target source of truth should be:

```text
shared-domain manifest regions[*].mesh_part_ids
  -> femDomain.partsById
  -> topology element ranges / node selections from those parts
  -> boundary surface + wireframe
```

This avoids reinterpreting the authored shape in the browser.

### Fix 2: default region display should not be `both` after mesh is current

The `both` mode is useful for diagnostics, but it is visually dangerous as a
default. A safer product behavior is:

- before current mesh realization: show `authored`;
- after current mesh-backed region exists: show `realized`;
- keep `both` as an explicit comparison toggle.

This avoids making a normal mesh-backed region look stale.

### Fix 3: keep authored and realized styles visually distinct

If `both` remains available, use different visual grammar:

- authored: dashed/thin primitive outline, low opacity, label as authored;
- realized: solid mesh-part wireframe/surface, label as realized;
- do not use identical fill/wireframe opacity for both.

This is secondary to source-of-truth correctness, but it reduces confusion.

## Regression tests to add before fixing

1. A `regionOverlayModel` test where a manifest region provides a single mesh
   part id and the owner object has additional tetrahedra whose centroid lies
   inside the authored primitive. The realized overlay must include only the
   manifest part.

2. A `useViewport3DSceneModel` test proving `meshRegionOverlays` carries
   `mesh_part_ids` or equivalent realized-part references, not just the authored
   primitive shape.

3. A `Viewport3DScene` wiring test proving authored and realized overlays are
   separately controlled by `regionOverlayMode`, and default state does not show
   both after a current mesh-backed region is available.

4. Optional browser smoke with the `permalloy_box_relax_300x1000x10nm.py`
   geometry: after mesh build, realized region mode should not show tetrahedra
   crossing into the hole.

## Verification performed

Targeted tests for the current overlay path pass, which means they currently
encode the existing behavior and do not catch this bug:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/regionOverlayModel.test.ts
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/regionOverlayMode.test.ts
```

A broad `pnpm --dir apps/control-room test -- --run ...` invocation was not
useful here because this package command ran the full suite and hit an unrelated
timeout in `src/modules/viewport-3d/viewport-memory-stress.test.ts`.

## Conclusion

The likely root cause is not leaked primitive geometry. The bug is that realized
region visualization is still derived from authored primitive containment and
is rendered together with authored primitive overlays in `both` mode. For
regions around holes, that approximation can select tetrahedra that visually
enter the hole.

The production fix is to make realized region overlay geometry manifest-part
owned, using `mesh_part_ids` as the source of truth, and to make `both` an
explicit comparison mode rather than the default post-mesh view.
