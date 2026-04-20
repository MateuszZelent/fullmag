# SceneDocument Authoring v1

## Status

Draft

## Goal

`SceneDocument` v1 is the canonical control-room authoring document for geometry, material
assignment, magnetization initialization, study defaults, and editor metadata.

It replaces `script_builder` and `model_builder_graph` in the public live-session payload.

Model tree nodes, inspector panels, and authoring ribbons are projections over this document and
its narrow semantic subresources. They do not define a second persisted physics model.

## Version

- Document version string: `scene.v1`
- Revision field: monotonic `u64`, incremented by the API when the live scene is updated

## Top-level shape

```json
{
  "version": "scene.v1",
  "revision": 3,
  "scene": {},
  "universe": null,
  "objects": [],
  "materials": [],
  "magnetization_assets": [],
  "current_modules": {
    "modules": [],
    "excitation_analysis": null
  },
  "study": {},
  "outputs": {},
  "editor": {}
}
```

## Fields

### `scene`

- metadata for the authored scene
- `id` and `name` are authoring identifiers only

### `universe`

- same semantic universe contract already used by the study authoring path
- optional in v1

### `objects`

Each `SceneObject` contains:

- `id`
- `name`
- `geometry`
- `transform`
- `material_ref`
- `region_name`
- `magnetization_ref`
- `mesh_override`
- `visible`
- `locked`
- `tags`

`transform` serializes only:

- `translation`
- `rotation_quat`
- `scale`
- `pivot`

Editor-local transform space such as local/world stays in `editor`, not in physical object
semantics.

### `materials`

Each material asset contains:

- `id`
- `name`
- `properties`

`properties` carries the current material subset already supported by the builder-driven workflows:
`Ms`, `Aex`, `alpha`, and optional `Dind`.

### `magnetization_assets`

Supported `kind` values in v1:

- `uniform`
- `random`
- `file`
- `sampled`
- `preset_texture`

Each asset stores:

- source/value payload fields needed by the current executable paths
- `mapping`
- `texture_transform`

Concrete authoring examples:

- object magnetization "uniform" maps to `kind = "uniform"` and `value = [mx, my, mz]`
- object magnetization "vortex" maps to `kind = "preset_texture"`,
  `preset_kind = "vortex"`, and `preset_params`

Default migration values:

- `mapping.space = "object"`
- `mapping.projection = "object_local"`
- `mapping.clamp_mode = "clamp"`
- identity `texture_transform`

### `current_modules`

Stored as a top-level module block with:

- `modules`
- `excitation_analysis`

### `study`

Stored study defaults:

- `solver`
- `mesh_defaults`
- `stages`
- `initial_state`

### `outputs`

Reserved authoring container. In this slice it round-trips but does not expand executable coverage.

### `editor`

Editor-only metadata such as selection and gizmo mode. This block must not leak into `ProblemIR`.

## Projection rules

### `SceneDocument -> ScriptBuilderState`

- object transform translation is flattened into builder `geometry_params.translation`
- material and magnetization refs are dereferenced into per-geometry builder payloads
- study/current-module fields project directly to their existing builder counterparts

### `SceneDocument -> ProblemIR`

In v1 the execution path remains:

1. `SceneDocument -> ScriptBuilderState`
2. builder-compatible overrides for canonical rewrite
3. Python canonical rewrite / load
4. canonical `ProblemIR`

This keeps the public `ProblemIR` wire shape unchanged while making `SceneDocument` the authoring
source of truth.

## Live API changes

- `GET /v1/live/current/authoring/scene` returns `SceneDocument`
- `PUT /v1/live/current/authoring/scene` replaces `SceneDocument`
- `PATCH /v1/live/current/authoring/scene` applies coarse scene-level patches
- `POST /v1/live/current/authoring/transactions` commits semantic authoring transactions against
  the same scene revision
- websocket `session_state` continues using the same event kind, but the payload now contains
  `scene_document`
- `script_builder` and `model_builder_graph` are removed from the public payload
- `POST /v1/live/current/authoring/script/sync` derives its input from `SceneDocument`, not from a
  manually mutated public builder payload
- narrow routes such as `authoring/model/materials/:material_id` or
  `authoring/model/magnetization-assets/:asset_id` are allowed only as projections over the same
  canonical scene state

## Validation

The API must reject:

- unsupported `version`
- duplicate object/material/magnetization ids
- objects referencing missing `material_ref`
- objects referencing missing `magnetization_ref`
- unsupported v1 magnetization kinds

## Explicit non-goals for v1

- no texture gizmo
- no procedural/composite magnetization authoring
- no hierarchy or parenting
- no undo/redo
- no direct `ProblemIR -> SceneDocument` reconstruction contract
