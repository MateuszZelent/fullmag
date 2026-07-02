# Control Room region visualization management diagnostic

Date: 2026-07-02

Scope: static diagnostic of `apps/control-room` region/object visualization
management, especially the confusion between whole-object visualization, authored
object regions, realized mesh-backed regions, and field/quantity rendering.

This report does not change runtime behavior. It records the current evidence,
root causes, and a repair plan.

## Executive summary

The current behavior is a real product bug, not just a styling issue.

Control Room currently has four concepts that are visually and semantically
too close to each other:

1. the whole scene object, for example `object:film`;
2. the authored object region, for example a box/cylinder/sphere inside that
   object;
3. the realized mesh-backed region, usually represented by
   `manifest.regions[*].mesh_part_ids`;
4. the per-target field visualization state, for example `m.x`, HSL orientation,
   scalar colormap, vectors, wireframe, opacity, and vector budget.

The UI exposes a `region:*` visualization target, but the frontend v2 spec still
defines canonical visualization targets only for scene object, airbox, mesh part
fallback, and future 2D overrides. The implementation therefore has a region
target without a complete product contract: no safe defaults, no first-class data
scope, no clear distinction between field rendering and diagnostic overlays, and
incomplete end-to-end tests.

The single-color region overlay is not an `mx`/HSL field visualization. It is a
separate authored/realized region overlay layer rendered with uniform
`meshBasicMaterial`. Depending on mesh state, it can be:

- an authored primitive overlay, such as box/cylinder/sphere;
- a realized mesh-backed overlay derived from `mesh_part_ids`;
- a synthetic membership/projection overlay when no mesh part exists.

That explains the user-visible confusion: changing a region target to HSL does
not necessarily mean the visible region-shaped surface is showing field HSL. The
visible single-color shape can still be the region overlay, while the actual
field/quantity pipeline is handled by `MeshPartLayer`.

## Desired product contract

The target behavior should be:

- a region is invisible by default in ordinary visualization mode;
- object visualization controls the whole object;
- region visualization controls only the selected region subdomain;
- diagnostic region overlays are separate from physical field visualization;
- the user can show `mx` on the object and HSL orientation on a region at the
  same time when the region has a realized mesh carrier;
- if a region is not realized as mesh parts, the UI should say that field
  visualization is unavailable/degraded for that region instead of showing a
  single-color overlay that looks like a field result.

Recommended near-term contract: make `region:<object_id>:<region_id>` a
first-class frontend target, but map its data-plane carrier to realized
`mesh_part_ids`. Do not invent `scope_kind=region` until the API/runtime can
support it consistently.

## Evidence

### 1. The spec does not define `region:*` as a canonical target

`docs/specs/frontend-v2/23-per-object-visualization-control.md:18-25` lists
canonical target ids:

- `object:<object_id>`;
- `airbox`;
- `part:<part_id>` only when no object id exists;
- future 2D mode-specific override.

It does not define `region:<object_id>:<region_id>`. Current code does define
region target ids in `selectionTypes.ts`:

- `RegionVisualizationTargetId = region:${string}:${string}` at
  `apps/control-room/src/kernel/selection/selectionTypes.ts:37`;
- `visualizationTargetIdForSceneObject(objectId, regionId)` returns `region:*`
  when a `regionId` exists at `selectionTypes.ts:39-45`.

This is implementation/spec drift.

### 2. Region selection becomes a generic object visualization panel

`ObjectRegionVisualizationPanel` rebuilds a synthetic selection from the region
panel model and passes it directly to `ObjectVisualizationPanel`:

- `apps/control-room/src/modules/inspector/panels/region/ObjectRegionVisualizationPanel.tsx:9-30`.

The generic panel then renders the same sections for object, part, airbox, and
region:

- target info at `ObjectVisualizationPanel.tsx:1444-1457`;
- display passes at `ObjectVisualizationPanel.tsx:1458-1471`;
- render mode, quantity, surface coloring, points, wireframe, vectors, and
  geometry scope at `ObjectVisualizationPanel.tsx:1473-1525`.

This is why the UI feels like object and region management are the same thing:
they are routed through the same panel with only a `Kind = region` field as a
semantic differentiator.

### 3. Region defaults are inherited from visible object defaults

The base object defaults are visible and field-colored:

- `activeQuantityId: "m"` at
  `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts:127`;
- `shaderVisible: true`, `surfaceColorSource: "orientation"` at
  `ObjectVisualizationController.ts:139-140`;
- `visible: true`, `wireframeVisible: true` at
  `ObjectVisualizationController.ts:153-156`.

`defaultVisualizationSettings(kind)` only special-cases `airbox` and `part`;
everything else, including `region`, returns `DEFAULT_OBJECT_VISUALIZATION`:

- `ObjectVisualizationController.ts:302-308`.

The viewport also resolves region settings by first resolving the parent object
settings, then resolving the region with those inherited settings:

- `useViewport3DSceneModel.ts:2575-2588` and the following region resolution.

Inheritance is useful, but the current default is unsafe for regions. A region
that should be invisible by default starts with the same effective display
baseline as a visible object unless an explicit region override hides it.

### 4. Region panel uses inconsistent object target identity for inheritance

In the inspector panel, when a region target is active, the target list and
inheritance lookup use raw `selection.objectId` as an object visualization target:

- `ObjectVisualizationPanel.tsx:1074-1079`;
- `ObjectVisualizationPanel.tsx:1098-1108`.

The canonical object target id elsewhere is `object:<object_id>`, for example
`visualizationTargetIdForSceneObject(object.objectId)` in viewport object
settings at `useViewport3DSceneModel.ts:2562-2572`.

`visualizationTargetKey()` does not normalize target ids. It stores keys as
`${kind}:${id}`:

- `ObjectVisualizationController.ts:1246-1249`.

That creates a real identity hazard: `kind=object, id=film` and
`kind=object, id=object:film` become different local override keys. This can
make region inheritance, reset, and optimistic UI feedback diverge from the
viewport.

### 5. Region model fallback can point visualization at a synthetic fallback id

`resolveObjectRegionPanelModel()` tries to find the selected region, then falls
back to object-level region identity:

- exact selected region lookup at
  `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanelModel.ts:553-562`;
- fallback id `region:${objectId}` at `ObjectRegionsPanelModel.ts:627`.

Since `ObjectRegionVisualizationPanel` rebuilds selection from the model rather
than preserving the original selected `Selection.ref`, a stale or temporarily
missing region resource can turn the region visualization target into a fallback
region id. That is especially risky while resources are loading or when the
selected node is ahead of the model resource.

### 6. The single-color overlay is a separate overlay layer, not field coloring

Authored region overlays are rendered by `RegionOverlayLayer`. It resolves one
fill color and applies it as a uniform material:

- fill color at
  `apps/control-room/src/modules/viewport-3d/layers/RegionOverlayLayer.tsx:107`;
- `meshBasicMaterial` at `RegionOverlayLayer.tsx:130-135`;
- primitive geometries at `RegionOverlayLayer.tsx:162-190`.

Realized mesh-backed overlays are rendered by `RegionMeshOverlayLayer`, again as
a uniform material:

- fill color at
  `apps/control-room/src/modules/viewport-3d/layers/RegionMeshOverlayLayer.tsx:155`;
- `meshBasicMaterial` at `RegionMeshOverlayLayer.tsx:171-178`.

`resolveRegionOverlayStyle()` makes this more confusing:

- it turns fill on by default when the target is visible and shader is visible
  at `regionOverlayModel.ts:185-187`;
- it hides wireframe when fill is visible at `regionOverlayModel.ts:187-189`;
- it uses `shaderMonoColor` only when `surfaceColorSource` is absent or `solid`;
  non-solid sources fall back to the fixed region palette at
  `regionOverlayModel.ts:201-206`.

So when the user selects HSL for a region, the overlay does not become HSL. The
overlay just stops taking `shaderMonoColor` and falls back to its region color.
That is the observed "single-color overlay".

### 7. Region overlay mode defaults to auto and can show regions by default

`Viewport3DModule` initializes `regionOverlayMode` to `auto`:

- `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx:951-952`.

`auto` means:

- show authored overlays when there are no mesh-backed regions;
- show realized overlays when mesh-backed regions exist.

Evidence:

- `regionOverlayModeShowsAuthored("auto")` returns true when no mesh-backed
  regions exist at `apps/control-room/src/modules/viewport-3d/regionOverlayMode.ts:3-8`;
- `regionOverlayModeShowsRealized("auto")` returns true when mesh-backed
  regions exist at `regionOverlayMode.ts:11-16`.

That is correct for an authoring/diagnostic overlay mode, but wrong for normal
field visualization if regions are expected to be invisible by default.

### 8. Region field visualization only works through a mesh-part carrier

The actual field/quantity color path is not `RegionOverlayLayer`; it is
`MeshPartLayer`.

`MeshPartLayer` computes scalar color mode from render settings and applies
scalar colors to the material:

- scalar color mode gate at
  `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx:463-467`;
- `vertexColors={hasScalarColors}` at `MeshPartLayer.tsx:703-709`.

The viewport can map realized manifest region mesh parts to a `region` target:

- manifest region `mesh_part_ids` are copied into overlay inputs at
  `useViewport3DSceneModel.ts:1012-1032`;
- `resolveViewport3DRegionTargetByPartId()` maps each manifest part id to a
  `kind: "region"` target at `useViewport3DSceneModel.ts:1098-1124`;
- `getPartSettings(part)` passes that region target into
  `resolveViewport3DPartVisualizationSettings()` at
  `useViewport3DSceneModel.ts:2544-2552`.

This means region field visualization is possible only when the region has a
real mesh-part carrier. If the frontend is showing an authored primitive overlay
or a synthetic membership/projection overlay, the visible shape is not a
field-colored mesh-part surface.

### 9. Projection memberships are not conformal mesh parts

When there are no `mesh_part_ids`, the frontend can create synthetic membership
parts such as `membership:<region>`:

- `useViewport3DSceneModel.ts:1066-1089`.

The backend marks projected memberships explicitly:

- `source: "geometry_projection"` at
  `crates/fullmag-api/src/router_v2/handlers/data/mesh_region_membership.rs:168-170`;
- `realization_method: "shape_centroid_geometry_projection_v1"` at
  `mesh_region_membership.rs:176-178`.

That path is useful for selection/diagnostics. It should not be silently treated
as equivalent to a conformal field-visualization region.

### 10. Field meta and field scope do not support region as first-class scope

`fieldMetaScopeQueryForVisualizationTarget()` explicitly returns null scope for
region targets:

- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts:153-170`.

The viewport field scope type does not include `region`:

- `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts:37-42`.

The default scope mapper also has no region branch and falls through to `full`:

- `viewport3DFieldDataPlan.ts:1403-1409`.

Some region rendering still works because region settings are collapsed onto
mesh parts, but that is exactly the architectural smell recorded in
`docs/diagnostics/viewport-3d-field-data-architecture-report-2026-06-25.md:220-233`:
object, region, and part target settings are collapsed into part settings before
the original target kind consistently reaches the data planner.

### 11. There are two region-to-part mapping models

The inspector-side vector budget range finds matching parts by aliasing the
region id against `part.geometry_id` or `part.id`:

- `ObjectVisualizationPanelModel.ts:315-323`;
- `ObjectVisualizationPanelModel.ts:563-583`.

The viewport realized region path maps region targets from
`manifest.regions[*].mesh_part_ids`:

- `useViewport3DSceneModel.ts:1098-1124`.

The manifest path is the stronger source of truth. The alias path is a fallback
that can disagree with manifest ownership when geometry ids, part ids, or
backend region ids diverge.

### 12. Existing historical diagnostic is partially stale but still relevant

`docs/diagnostics/2026-06-08-region-realized-wireframe-mixing-audit.md` already
identified that authored and realized region overlays could be visually mixed
and mistaken for stale geometry. The current code has improved since then:
`regionMeshElementIndices()` now uses `meshPartIds` first:

- `apps/control-room/src/modules/viewport-3d/layers/regionOverlayModel.ts:634-641`;
- `meshPartElementIndices()` resolves elements from selected parts at
  `regionOverlayModel.ts:657-672`.

The remaining issue is therefore not "mesh_part_ids are completely ignored".
The current issue is that the region overlay is still a uniform diagnostic layer
and still shares UI controls with physical field visualization.

## Root causes

### RC1: Region target identity exists in code but not in the product contract

The code added `region:*` targets, but the spec, field scope model, colorbar/meta
scope, and tests did not move to the same level. This leaves every layer making a
local interpretation of what "region visualization" means.

### RC2: Object visualization and region visualization share one generic panel

The generic panel is efficient, but it hides a critical semantic difference:
object visualization is the normal render target, while region visualization is
a subdomain override that may or may not have a realized mesh carrier. The UI
does not make that difference clear.

### RC3: Region defaults inherit from object defaults without a region-safe base

Object defaults are visible and shader-enabled. Region defaults should not be.
The current inheritance model should remain useful for quantity/palette fallback,
but region visibility should default to off.

### RC4: Region overlays and field visualization are separate render paths

The overlay path uses uniform materials. The field path uses mesh-part scalar
colors and field buffers. Both are controlled by settings that look similar to
the user, so HSL/quantity settings appear to affect "the region", while the
visible region shape may still be the overlay.

### RC5: Region data plane is not first-class

The data planner understands `full`, `object`, `part`, `airbox`, and `selection`.
Region targets are either ignored for meta/ranges or collapsed to mesh parts.
That can be acceptable as an implementation strategy, but it must be explicit
and tested: a region field visualization requires realized `mesh_part_ids`.

### RC6: Identity normalization is inconsistent

The same object can appear as `film` and `object:film` in visualization target
objects. Because target keys are simple string concatenations, this creates
separate local override buckets.

## Concrete broken user stories

### Story A: Region should be invisible by default

Current behavior:

1. Region overlay mode starts in `auto`.
2. Region target inherits visible object defaults.
3. Overlay style fills visible regions with a uniform material.

Result: the region can appear immediately as a single-color overlay.

Expected behavior:

1. Normal object visualization shows the object.
2. Region overlay is off by default.
3. Region target has `visible=false` until explicitly enabled.
4. Selecting a region in Explorer/Inspector does not by itself turn on a
   region-colored overlay.

### Story B: Show `mx` on object and HSL on region

Current behavior can succeed only if the selected region maps to realized
mesh parts. Otherwise the visible region-shaped overlay remains uniform.

Expected behavior:

1. Object target `object:<id>` has `activeQuantityId=m` and
   `surfaceColorSource=component_x`.
2. Region target `region:<object_id>:<region_id>` has `activeQuantityId=m` and
   `surfaceColorSource=orientation`.
3. The render planner resolves the region target to exact `mesh_part_ids`.
4. `MeshPartLayer` renders the region part surface with HSL field colors.
5. The diagnostic overlay remains hidden unless explicitly enabled.

If step 3 fails, the UI should show a degraded state:

```text
Region field visualization unavailable: this region is not realized as mesh parts.
Only authored/projection overlay can be shown.
```

### Story C: Reset object visualization and region visualization separately

Current risk:

- object override may be stored under raw `id=film`;
- viewport may read canonical `id=object:film`;
- region inheritance may read the raw id while viewport reads canonical id.

Expected behavior:

- object targets are always canonicalized to `object:<object_id>`;
- region inheritance and viewport resolution use the same object target id;
- reset clears exactly one canonical target key.

## Recommended repair plan

### Phase 1: Freeze the contract

Update specs before code:

1. In `23-per-object-visualization-control.md`, add
   `region:<object_id>:<region_id>` as a canonical target.
2. Define region target semantics:
   - region target is hidden by default;
   - region target inherits quantity/palette defaults from object only as a
     baseline;
   - region target field rendering requires realized `mesh_part_ids`;
   - authored/projection overlays are diagnostic overlays, not field rendering.
3. In viewport/data specs, define whether the near-term data-plane model is:
   - `region target -> mesh_part_ids -> scope_kind=part`, recommended now; or
   - `scope_kind=region`, deferred until backend/API contracts exist.

### Phase 2: Normalize target identity

Implementation changes:

1. Add a target normalizer for `VisualizationTargetRef`.
2. Canonicalize all object targets to `object:<object_id>`.
3. Canonicalize all region targets to
   `region:<object_id>:<encodeURIComponent(region_id)>`.
4. Use canonical object id for region inheritance in `ObjectVisualizationPanel`.
5. Make `visualizationTargetKey()` operate only on normalized targets.
6. Add assertions/tests so `kind=object, id=film` is either rejected or
   normalized to `object:film`.

### Phase 3: Add region-safe defaults

Implementation changes:

1. Add `DEFAULT_REGION_VISUALIZATION`.
2. Recommended default:
   - `visible: false`;
   - `shaderVisible: false`;
   - `wireframeVisible: false`;
   - `vectorsVisible: false`;
   - `primitiveVisible: false`;
   - inherit `activeQuantityId`, `surfaceColorSource`, `scalarColorPalette`, and
     vector style only after the user explicitly enables the region.
3. Keep object inheritance for reset/fallback, but apply region-specific
   visibility defaults after inheritance unless an explicit region override
   exists.

### Phase 4: Separate overlay controls from field visualization controls

Implementation changes:

1. Split the region inspector into two explicit sections:
   - `Region Field Visualization`;
   - `Region Geometry/Realization Overlay`.
2. Keep `Region Field Visualization` backed by the normal target registry.
3. Keep `Region Geometry/Realization Overlay` backed by `RegionOverlayMode` or a
   future viewport overlay state.
4. Label authored/projection/realized overlay states explicitly.
5. Do not use the same visual grammar for field-colored region surface and
   diagnostic overlay.

### Phase 5: Make region field carriers explicit

Implementation changes:

1. Build a pure resolver:

```ts
resolveRegionVisualizationCarrier(regionTarget, manifest)
  -> { kind: "mesh-parts"; partIds: string[] }
   | { kind: "projection"; membershipId: string; degradedReason: string }
   | { kind: "unavailable"; degradedReason: string }
```

2. Use manifest `mesh_part_ids` as the preferred carrier.
3. Treat membership/projection as diagnostic-only unless explicitly approved for
   approximate field visualization.
4. Surface degraded state in the inspector, ribbon, and viewport diagnostics.
5. Use this same carrier resolver for vector budget, render planning, field
   requests, colorbar, and selection highlighting.

### Phase 6: Fix field meta/colorbar behavior

Near-term:

1. For region targets with realized mesh parts, query field meta/ranges by the
   resolved part ids or by the merged part carrier.
2. If multiple parts are involved, define whether the range is unioned, shared,
   or shown as unavailable.
3. For non-realized region targets, show a degraded state instead of using null
   scope silently.

Long-term:

1. Add `scope_kind=region` only after OpenAPI, runtime resources, binary field
   payloads, and backend region metadata all support it.

## Regression test plan

### Target identity and selection

- `selectionTypes` / `explorerSelection`: every `object.region.*` node with
  `regionId` resolves to `kind: "region"` and canonical `region:*` id.
- `ObjectRegionVisualizationPanel`: keeps the selected region identity and does
  not silently rebuild to `region:<objectId>` during loading.
- `ObjectVisualizationController`: object target `film` and `object:film` cannot
  create separate override buckets.

### Defaults

- `ObjectVisualizationController`: region default is invisible even when object
  default is visible.
- Reset region target returns to invisible region default, not visible object
  default.
- Object reset does not clear region override, and region reset does not clear
  object override.

### Overlay vs field path

- `regionOverlayModel`: non-solid `surfaceColorSource` does not claim to render
  scalar field colors in overlays.
- `RegionMeshOverlayLayer`: single-color material behavior is either documented
  by test or removed intentionally.
- `Viewport3DScene`/scene model: `RegionOverlayMode=auto` does not make normal
  field visualization look like a visible region target when region visibility
  is off.

### Region carrier and render planning

- Manifest-backed region with `mesh_part_ids` resolves to `region` settings for
  those parts.
- Projection-only region resolves to degraded diagnostic overlay, not field
  rendering.
- Object `mx` plus region HSL produces two render plans with distinct target
  identities and expected part carriers.
- Vector budget range for region uses the same carrier resolver as viewport
  render planning.

### Data plane and colorbar

- Region target with realized mesh parts has deterministic field request and
  colorbar/range behavior.
- Region target without realized mesh parts does not send misleading full-domain
  or null-scope field meta queries.
- Target diagnostics include target id, original target kind, carrier kind,
  scope kind, and degraded reason.

### Browser smoke

Create or load a small scene with one object and one region:

1. initial state: object visible, region invisible;
2. set object surface source to X component;
3. enable region and set surface source to HSL orientation;
4. assert the canvas is nonblank and the region field surface is visible only
   for realized mesh parts;
5. toggle overlay authored/realized/both and verify the overlay is visually
   distinct from the field surface;
6. verify no full topology rebuild occurs for style-only target changes.

## Bad fixes to avoid

- Do not hide the single-color overlay with CSS only. That would not fix target
  identity, data scope, or field rendering semantics.
- Do not make `surfaceColorSource=orientation` change `RegionOverlayLayer` into
  fake HSL. That would still not be physical field data.
- Do not silently map every region to the parent object target. That destroys
  independent region styling.
- Do not introduce `scope_kind=region` only in the frontend. It must be an
  OpenAPI/runtime/backend contract.
- Do not keep both raw and canonical object target ids.

## Priority

P0:

- define region target contract in specs;
- add region-safe invisible defaults;
- split diagnostic overlay semantics from field visualization semantics;
- canonicalize target ids.

P1:

- add region carrier resolver based on manifest `mesh_part_ids`;
- align inspector vector budget, viewport render planning, field requests, and
  colorbar on that resolver;
- expose degraded state for projection-only regions.

P2:

- improve overlay visual grammar for authored vs realized vs projection;
- replace source-string tests with behavior tests where possible;
- add browser smoke for object/region mixed visualization.

## Conclusion

The reported UI problem is valid. The current implementation lets the user
believe they are managing a physical region field visualization, while the
viewport may be showing a diagnostic, single-color authored/realized overlay.
The correct fix is not a visual tweak. The system needs a first-class region
target contract, invisible region defaults, canonical target identity, explicit
region carriers, and a hard separation between region overlays and field
rendering.
