# Audit: region add switches 3D viewport into forced wireframe

Date: 2026-06-06

## Status after fix

A narrow frontend fix is now in place in
[apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts](/home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts:18).
The viewport no longer degrades to `unknown` wireframe when:

- `manifest.source_scene_revision` is temporarily `null`,
- the scene has no `mesh:dirty` / `mesh:building` objects,
- and the loaded manifest still covers the same visible scene objects.

This keeps region-only authoring changes on the current mesh visualization path while the
manifest provenance refresh catches up.

## Scope

Question: why, after adding a `Region`, the 3D viewport falls back to wireframe and refuses to keep `surface` or `points`, with:

`Mesh provenance is unknown; rendering an edge-only safety view.`

This audit is code-based. I did not reproduce the UI interactively in a browser in this pass. I verified the relevant frontend test suite and the backend region tests.

## Executive summary

The forced wireframe is not a random rendering glitch. It is an intentional safety fallback in the viewport. The real bug is that region authoring is not integrated consistently with the mesh/provenance lifecycle.

The highest-confidence root cause is a contract mismatch across three layers:

1. frontend region authoring invalidates `model/*` resources, but not `meshing/*` resources;
2. backend scene commit bumps `mesh_revision` only when `scene_mesh_signature()` changes;
3. `scene_mesh_signature()` ignores authored object regions, so adding/editing/removing a region does not participate in mesh-affecting change detection.

Once the scene revision and mesh provenance drift apart, the viewport safety gate can classify topology freshness as `unknown` or `stale` and then hard-force `wireframe`, disabling shaded surface, points, and vectors.

## What forces wireframe

The wireframe fallback is explicit in the viewport contract:

- `resolveVisualizationTopologyFreshness()` returns `unknown` when either the scene revision or `manifest.source_scene_revision` is missing ([apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts](/home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts:18)).
- For any non-`current` freshness, `resolveTopologyConstrainedVisualizationSettings()` forces:
  - `renderMode: "wireframe"`
  - `shaderVisible: false`
  - `pointsVisible: false`
  - `vectorsVisible: false`
  - `geometryScope: "surface"`
  ([visualizationDisplayResolution.ts](/home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts:56)).

So the visible symptom is expected once provenance is considered broken. The bug is upstream.

## Findings

### 1. Region authoring does not invalidate `meshing/*` resources on the frontend

`invalidateRegionAuthoringResources()` invalidates only:

- `model/scene`
- `model/regions`
- `model/material-fields`
- geometry validation
- geometry diagnostics

It does not invalidate shared-domain manifest, mesh summary, mesh build resources, or topology ([apps/control-room/src/modules/inspector/panels/regionAuthoringInvalidation.ts](/home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/modules/inspector/panels/regionAuthoringInvalidation.ts:12)).

`RegionsListPanel.createRegion()` uses that invalidation path immediately after `api.model.createRegion(...)` ([apps/control-room/src/modules/inspector/panels/RegionsListPanel.tsx](/home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/modules/inspector/panels/RegionsListPanel.tsx:104)).

Effect: scene/region state refreshes, but mesh provenance resources may remain cached or revision-stable.

### 2. Backend commit bumps `mesh_revision` only when `scene_mesh_signature()` changes

`commit_current_live_scene_document()` compares the previous and next `scene_mesh_signature()`. Only then does it bump `mesh_revision` and `mesh_build_revision` ([crates/fullmag-api/src/main.rs](/home/kkingstoun/git/fullmag/fullmag/crates/fullmag-api/src/main.rs:2687)).

That means any scene edit omitted from `scene_mesh_signature()` is invisible to mesh lifecycle bookkeeping.

### 3. `scene_mesh_signature()` ignores authored object regions

The signature includes:

- universe
- study mesh config
- per-object id/name/geometry/transform/material_ref/region_name/object_mesh/mesh_override

but it does not include:

- `object.regions`
- region shape
- region mesh policy
- region material overrides
- region texture override
- region-owned material fields
- region couplings

See [crates/fullmag-api/src/main.rs](/home/kkingstoun/git/fullmag/fullmag/crates/fullmag-api/src/main.rs:3407).

This is the central defect. Adding a region through the authoring transaction changes the scene, but not the mesh-affecting signature used for mesh revision ownership.

### 4. Region transactions currently keep mesh “current” by test contract

The object-region transaction handlers only mutate `object.regions` and return; they do not mark mesh dirty or trigger mesh-specific bookkeeping themselves ([crates/fullmag-api/src/router_v2/handlers/model/authoring.rs](/home/kkingstoun/git/fullmag/fullmag/crates/fullmag-api/src/router_v2/handlers/model/authoring.rs:1896)).

The existing backend tests explicitly assert that region create does **not** mark `mesh:dirty`:

- `authoring_transactions_mutate_object_regions_and_couplings`
- `authoring_object_region_resource_crud_allocates_stable_region_id`

([crates/fullmag-api/src/router_v2/tests.rs](/home/kkingstoun/git/fullmag/fullmag/crates/fullmag-api/src/router_v2/tests.rs:7244)).

So the current tested behavior is already inconsistent with the frontend-v2 spec.

### 5. The spec says region mesh-affecting data must produce `mesh-stale`

The repo spec is explicit:

- `mesh-stale` includes “material/region mesh-affecting data” changes ([docs/specs/frontend-v2/24-geometry-object-authoring-lifecycle.md](/home/kkingstoun/git/fullmag/fullmag/docs/specs/frontend-v2/24-geometry-object-authoring-lifecycle.md:63)).
- edits affecting “region mapping” require transaction semantics and participate in mesh provenance ([24-geometry-object-authoring-lifecycle.md](/home/kkingstoun/git/fullmag/fullmag/docs/specs/frontend-v2/24-geometry-object-authoring-lifecycle.md:119)).

Current implementation does not satisfy that contract.

### 6. Why this can surface specifically as `unknown`

The viewport computes freshness from `scene.data` and `sharedDomainManifest.data` ([apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts](/home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:743)).

If `manifest.source_scene_revision` is absent, freshness becomes `unknown` immediately ([visualizationDisplayResolution.ts](/home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts:27)).

There is a backend fallback that synthesizes clean provenance when:

- no object is `mesh:dirty`
- visible scene object ids are a subset of mesh object ids

([crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs](/home/kkingstoun/git/fullmag/fullmag/crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs:2949)).

That fallback reduces the blast radius, but it does not repair the architectural bug. It also means the exact symptom can vary between:

- `current` despite a logically stale mesh contract,
- `stale`,
- `unknown`,

depending on what mesh snapshot and manifest provenance are available in the live session.

## Most likely user-facing failure chain

1. User adds or edits an authored object region.
2. Scene revision advances.
3. Mesh lifecycle does not treat that edit as mesh-affecting in a consistent way.
4. Frontend refreshes scene/region resources but leaves mesh resources out of the invalidation set.
5. Viewport safety logic sees provenance mismatch or missing provenance.
6. Viewport switches to edge-only safety view and force-disables `surface`, `points`, and vectors.

## Recommended fix direction

### Required

1. Decide which region edits are mesh-affecting.
   - shape
   - realization policy
   - region mesh policy
   - material overrides that alter realized solver domain/material assignment
   - couplings if they alter mesh/interface realization

2. Extend `scene_mesh_signature()` to include all mesh-affecting region-owned state.

3. For mesh-affecting region writes, make the lifecycle explicit:
   - mark affected object mesh stale or dirty, and/or
   - bump mesh-related revisions, and
   - invalidate `meshing/*` resources on the frontend.

4. Expand `invalidateRegionAuthoringResources()` to include at least:
   - shared-domain manifest
   - mesh summary
   - current/latest build resources
   - mesh history
   - any topology resource that is displayed as current for the edited object

### Strongly recommended

5. Add a regression test that proves:
   - adding a mesh-affecting region changes mesh freshness to `stale`, not silent `current`;
   - viewport does not report `unknown` unless manifest provenance is genuinely unavailable;
   - non-mesh-affecting region changes, if any remain, do not dirty mesh.

6. Reconcile the test contract. The current tests codify that region CRUD keeps mesh current, which conflicts with the spec for mesh-affecting region data.

## Verification run in this audit

- Frontend tests:
  - `pnpm --dir apps/control-room test -- --run viewport3dTopologyStaleness ObjectVisualizationPanel RegionsListPanelModel useViewport3DSceneModel`
  - result: pass

- Backend tests:
  - `CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-api object_region -- --nocapture`
  - result: pass

These tests confirm the current code path and current backend expectations. They do not prove the UX is correct; they show the mismatch is presently encoded in the system.
