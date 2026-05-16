# Magnetization Texture Module Design

Status: draft for review  
Date: 2026-05-12  
Scope: `apps/control-room`, v2 model API, explorer, inspector, ribbon, viewport preview

## Objective

Implement a production v2 magnetization texture workflow where object-level, region-level, and ribbon-driven assignment are the same operation over the same backend-backed state.

Concrete success criteria:

- An object can have a whole-object magnetization texture.
- A region inside an object can override the object texture.
- Selecting an object texture node, a region texture node, or using a ribbon texture command resolves to the same target model and save path.
- Inspector exposes a detailed texture editor: preset/kind, parameters, mapping, translation, rotation, scale, reset/fit/apply/revert.
- Texture edits update a live viewport preview before save and persist to the backend on explicit apply/save.
- Backend is the source of truth after save; frontend draft state is only a preview layer.
- Existing v1 behavior is used as reference, but v2 must avoid v1 coupling between texture selection and viewport render modes.

## Current State Summary

The current control-room worktree already has partial object magnetic texture plumbing:

- Explorer contains object authoring children including `object.magnetic-texture`.
- Inspector registry routes `object.magnetic-texture` to `ObjectMagneticTexturePanel`.
- `ObjectMagneticTexturePanel` can edit only `object.magnetization_ref`.
- `ObjectRegionsPanel` can edit region `name` and `enabled`, but not `magnetization_ref`.
- Backend object creation can accept `magnetization_asset`, but object patch only supports `magnetization_ref`.
- Backend region patch currently does not support region texture assignment.
- There is no typed magnetization asset patch endpoint.
- Ribbon texture entries are currently static material-tab placeholders, not canonical commands.
- Viewport renders object geometry and solver field layers, but not a live authored magnetization texture preview.

Live-code evidence checked during design review:

- `crates/fullmag-api/src/schemas/authoring.rs` defines `RegionPatchRequest` with only `name` and `enabled`.
- `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs` patches `object.magnetization_ref`, but region patch only maps region name/enabled onto the owning object and marks the object mesh dirty.
- `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx` applies only `api.model.patchObject(...)` with a `magnetization_ref` patch and renders mapping/transform as read-only textareas.
- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx` has `mat-texture-*` actions as static ribbon entries, not registered commands with target resolution.
- `apps/control-room/src/modules/explorer/builders/buildModelTree.ts` creates object magnetic texture children, but region texture children do not exist yet.

V1 reference behavior worth preserving:

- Dedicated magnetic texture UI separate from material parameters.
- Explicit dirty/apply/revert state.
- Preset texture helpers with uniform, random seeded, vortex, skyrmion/domain-wall style parameter editors.
- Texture transform editor for translate, rotate, scale, reset, fit-to-object.

V1 behavior to avoid:

- Explorer texture selection must not implicitly change viewport render mode.
- Ribbon entries must not maintain a parallel state store.
- Frontend-only asset mutation is not acceptable as final state.

## Recommended Architecture

Use one canonical `MagnetizationTextureTarget` and one canonical `MagnetizationTextureDraft` across explorer, inspector, and ribbon.

```ts
type MagnetizationTextureTarget =
  | { kind: "object"; objectId: string }
  | { kind: "region"; objectId: string; regionId: string };

type MagnetizationTextureDraft = {
  target: MagnetizationTextureTarget;
  magnetizationRef: string | null;
  asset: MagnetizationAssetDraft;
  mapping: MagnetizationMappingDraft;
  textureTransform: TextureTransformDraft;
};
```

The inspector, explorer, and ribbon should only differ in how they choose the target. After target resolution, they use the same facade methods and same validation rules.

## Backend Contract

Add typed v2 model support for magnetization assets and region texture assignment.

Required schema changes:

- Extend `RegionPatchRequest` with `magnetization_ref?: string | null`.
- Add a `MagnetizationAssetPatchRequest` with `base_revision`, asset identity, preset kind, preset params, mapping, transform, and UI label.
- Keep `ObjectPatchRequest.magnetization_ref` for object-level assignment.
- Preserve `ObjectCreateRequest.magnetization_asset` for create-time convenience.

Required API facade endpoints:

- `GET /v2/sessions/current/model/magnetization-assets/{asset_id}`
- `PATCH /v2/sessions/current/model/magnetization-assets/{asset_id}`
- Existing `PATCH /v2/sessions/current/model/objects/{object_id}` for object assignment.
- Existing `PATCH /v2/sessions/current/model/regions/{region_id}` extended for region assignment.

Save semantics:

- Assigning a texture to an object patches the object's `magnetization_ref`.
- Assigning a texture to a region patches the region's `magnetization_ref`.
- Editing texture parameters or transform patches the referenced magnetization asset.
- Apply/save uses optimistic `base_revision`; conflicts surface as inspector errors and require refresh/reapply.
- Successful writes invalidate scene, model regions, diagnostics, visualization preview state, and any object/region resource that displays the texture summary.

Mesh semantics:

- Changing texture assignment or asset parameters should not mark the geometric mesh dirty.
- It should mark simulation initial-state/preview data dirty if that distinction exists.
- If no finer invalidation exists yet, invalidate visualization/session model resources but avoid mesh rebuild side effects.
- The current region patch handler always calls `mark_object_mesh_dirty(object)` for name/enabled changes. Region texture patching should avoid that blanket behavior unless geometry-affecting fields changed.

## Frontend Model

Create a shared module under `apps/control-room/src/modules/magnetization-texture/`.

Suggested files:

- `types.ts`: target, draft, preset, mapping, transform types.
- `targetResolver.ts`: resolve target from `Selection`, explorer node metadata, or ribbon context.
- `draftModel.ts`: scene/regions/assets to inspector model, dirty state, validation, patch builders.
- `texturePresets.ts`: v2 preset catalog based on current public texture helpers.
- `commands.ts`: ribbon/command-registry commands.
- `resourceInvalidation.ts`: shared invalidation list after apply.

Inspector panels then become thin target-specific hosts:

- `ObjectMagneticTexturePanel` resolves `{ kind: "object", objectId }`.
- New/extended region texture panel resolves `{ kind: "region", objectId, regionId }`.
- Both render the same `MagnetizationTextureEditor`.

## Explorer Integration

Object subtree:

- Keep `Object -> Magnetic Texture`.
- Add summary metadata: inherited/assigned texture, preset kind, dirty/sync status if selected.

Region subtree:

- Add `Object -> Regions -> <region> -> Magnetic Texture`.
- Region texture node selection opens the same editor in region-target mode.
- Region node summary should show `inherits object texture` when `region.magnetization_ref` is empty and `overrides object texture` when set.

Explorer selection remains inspector-only. It must not toggle shader/vector/field display modes.

## Ribbon Integration

Replace static material-tab texture placeholders with command registry entries.

Required command groups:

- Assign: uniform, random seeded, vortex, skyrmion/domain-wall presets that are supported by backend/Python semantics.
- Transform: fit to target, reset transform, reset rotation, reset scale.
- Visibility: preview authored texture, show vectors, show scalar shader. These remain visualization commands, separate from assignment.
- Apply/Revert: enabled only when active inspector draft has changes, or exposed through inspector-local actions if global draft command ownership is too broad.

Command target resolution:

1. If selection is a region texture node or region node, target that region.
2. If selection is an object texture node or object node, target that object.
3. If selection is a viewport object with a region pick available, target the picked region.
4. Otherwise disable assignment commands with a clear command disabled reason.

The ribbon must call the same magnetization texture facade used by the inspector.

## Inspector UX

Use shadcn-compatible primitives already present in `src/shared/ui` where available, and add missing primitives through the local shadcn pattern only when needed.

Recommended inspector layout:

- Header: target label, effective assignment badge, backend revision, dirty state.
- Assignment section: asset selector/ref, inherit object texture toggle for region target, create asset from preset.
- Preset section: preset kind tabs or select; parameter controls appropriate to selected kind.
- Vector section: uniform vector editor with normalization status for uniform-like presets.
- Mapping section: coordinate space, projection, clamp mode.
- Transform section: translation XYZ, rotation XYZ in degrees, scale XYZ, pivot/fit/reset actions.
- Preview section: live preview toggle, color/vector density controls, warning if preview is approximate.
- Footer: Apply, Revert, Refresh. Apply is disabled until validation passes.

Validation rules:

- Magnetization vector must be finite and normalized or normalizable.
- Scale values must be finite and non-zero.
- Rotation/translation values must be finite.
- Preset parameters must respect preset-specific ranges.
- Region target can inherit object texture by clearing `region.magnetization_ref`.

## Viewport Live Preview

Preview has two layers:

- Draft preview layer: local inspector/ribbon draft renders immediately without backend commit.
- Committed preview layer: after apply, scene resources refresh from backend and replace draft state.

Implementation outline:

- Extend primitive render model with optional `magnetizationTexturePreview` for object/region target.
- Add a preview resolver that combines object assignment, region override, scene asset data, and active draft overlay.
- Render an approximate color/vector preview on object geometry. Initial implementation can be surface-color approximation plus optional sparse arrows; it must be clearly separated from solver-result vector fields.
- Keep solver field glyphs and authored initial magnetization preview as separate render sources.

Acceptance checks:

- Editing transform sliders updates the preview without saving.
- Apply persists to backend and the preview survives resource refresh.
- Revert removes local draft overlay and returns to backend state.
- Selecting explorer texture nodes does not alter render mode.

## Save Flow

Object assignment:

1. Resolve object target.
2. Ensure or create magnetization asset.
3. Patch object `magnetization_ref`.
4. Patch asset if parameters/transform changed.
5. Invalidate scene and visualization resources.

Region assignment:

1. Resolve region target.
2. Ensure or create magnetization asset.
3. Patch region `magnetization_ref`.
4. Patch asset if parameters/transform changed.
5. Invalidate scene, model regions, diagnostics, and visualization resources.

Draft editing:

- All controls write to local draft.
- Draft updates viewport preview immediately.
- Backend receives changes only on Apply/Save.

## Testing And Verification

Backend tests:

- Region patch accepts and persists `magnetization_ref`.
- Magnetization asset patch updates preset params, mapping, and transform.
- Object texture assignment does not mark mesh geometry dirty.
- Revision conflict returns an actionable error.

Frontend unit tests:

- Target resolver maps object node, region node, and ribbon selection to the same target shape.
- Draft model computes effective object assignment and region override/inheritance.
- Patch builders produce expected object, region, and asset payloads.
- Inspector registry routes object and region texture nodes to the editor.
- Ribbon command enablement follows selection target resolution.

Frontend integration tests:

- Object texture Apply calls object patch and asset patch.
- Region texture Apply calls region patch and asset patch.
- Revert restores backend-backed model.
- Explorer texture selection is inspector-only.
- Viewport preview receives draft overlay before apply and committed state after apply.

Validation gates:

- `cd apps/control-room && npm run typecheck`
- `cd apps/control-room && npm run lint`
- `cd apps/control-room && npm run test`
- `cd apps/control-room && npm run check:api-hygiene`
- `cd apps/control-room && npm run build`
- Relevant Rust API tests for model authoring routes.

## Prompt-To-Artifact Completion Checklist

This checklist must be used before claiming the implementation is complete.

| User requirement | Required artifact or evidence |
| --- | --- |
| Implement magnetization texture module | Shared `apps/control-room/src/modules/magnetization-texture/` module with target resolution, draft model, presets, patch builders, commands, and invalidation helpers. |
| Connect texture workflow to explorer for objects | Object `Magnetic Texture` explorer node resolves to object texture target and opens the shared editor. Covered by explorer/inspector tests. |
| Connect texture workflow to explorer for regions | Region subtree contains region `Magnetic Texture` node; selection resolves to region texture target. Covered by explorer/inspector tests. |
| Connect texture workflow to ribbon | Ribbon texture actions are real command-registry commands, not decorative ids, and resolve the same target as explorer/inspector. Covered by ribbon command tests. |
| Object can have whole-object texture | Object assignment patches `object.magnetization_ref` and persists through backend scene refresh. Covered by frontend integration and API tests. |
| Region can override object texture | Region assignment patches `region.magnetization_ref`; clearing it restores object inheritance. Covered by backend and frontend tests. |
| Region selection plus ribbon assignment is equivalent | Target resolver returns the same `{ kind: "region", objectId, regionId }` for region node and ribbon command context. Covered by target resolver tests. |
| Detailed inspector view | `MagnetizationTextureEditor` exposes assignment, preset params, vector params, mapping, transform, preview, apply/revert/refresh states. Covered by component tests and local UI review. |
| Review and improve v1 behavior | Spec and implementation preserve v1 dirty/apply/transform strengths while removing render-mode coupling and frontend-only state. Evidence: design spec plus regression tests for inspector-only selection. |
| Texture can be translated | Transform editor supports translation XYZ and patch builder persists it to magnetization asset. Covered by draft/patch tests. |
| Texture can be rotated | Transform editor supports rotation XYZ/degrees and patch builder persists it. Covered by draft/patch tests. |
| Texture can be parameterized | Preset-specific parameter controls write to asset patch payload. Covered by preset catalog and patch tests. |
| Save/send to backend | Object, region, and asset patches use v2 API facade with optimistic revision and invalidation. Covered by API facade tests. |
| Live viewport update | Viewport preview consumes draft overlay before save and committed backend state after apply. Covered by viewport model tests and, if available, browser smoke. |
| Save after finishing changes | Apply/save explicitly commits draft to backend; revert discards draft. Covered by inspector integration tests. |
| Use frontend v2 conventions | Implementation follows `SceneDocument` source-of-truth, resource invalidation, command registry, inspector registry, and `CommandContext.resourceData`. Evidence: code review and v2 gates. |
| Use shadcn-compatible UI | Missing controls are added through local `src/shared/ui` shadcn-style primitives; editor uses existing Button/Tabs/etc. where appropriate. Evidence: component files and visual review. |
| Production-quality validation | Typecheck, lint, unit/integration tests, API hygiene, build, Rust API tests, and diff check are run or blockers documented. |

## Implementation Slices

1. Backend contract: region `magnetization_ref` patch and magnetization asset patch endpoint.
2. Frontend API facade/resources for magnetization assets and shared invalidation.
3. Shared magnetization texture target/draft/editor model.
4. Inspector editor for object and region targets.
5. Explorer region texture nodes and summaries.
6. Ribbon command registry integration.
7. Viewport draft/committed preview overlay.
8. Tests and completion audit.

## Open Decisions

- Exact preset catalog for v2 first release: uniform, random seeded, and vortex should be first; skyrmion/domain-wall can follow if backend semantics are fully aligned.
- Whether asset creation is a dedicated endpoint or piggybacks on patch/upsert.
- Whether Apply remains inspector-local or becomes a global command once draft ownership is centralized.
- How precise the first viewport preview must be for curved FEM surfaces versus rectangular FDM-like primitives.

## Self-Review

Strengths of this design:

- It closes the core equivalence requirement by forcing object, region, and ribbon paths through the same target/draft/facade model.
- It treats backend as the source of truth and keeps draft state limited to preview.
- It avoids reintroducing the v1 coupling where selecting texture-related explorer nodes changed viewport display mode.
- It gives the viewport an explicit authored-texture preview lane, separate from solver-result fields.

Risks to manage during implementation:

- Backend schema and OpenAPI generation must be kept in sync with `apiTypes.ts` and generated v2 types; otherwise the frontend facade will drift immediately.
- Region patch currently marks mesh dirty unconditionally, so the implementation must split geometry-affecting region edits from magnetization assignment edits.
- The first viewport preview should be honest about approximation. A color-only first pass is acceptable only if the inspector and ribbon do not imply it is a solver field.
- The command registry must own ribbon enable/disable state. Leaving `mat-texture-*` as decorative action ids would fail the equivalence requirement.
- Existing dirty worktree changes touch many of the same modules; implementation must patch narrowly and not overwrite unrelated in-progress edits.

## Recommendation

Proceed with the full backend-backed contract now. Deferring region assignment or magnetization asset patching would leave three non-equivalent paths and would reproduce the v1 problem of frontend state being ahead of backend truth.
