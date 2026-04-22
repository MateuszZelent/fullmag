# Control-Room API Tree v1

- Status: canonical target API tree for the local control room
- Last updated: 2026-04-21
- Parent architecture: `docs/specs/resource-first-control-room-api-v1.md`
- Concrete current endpoint reference: `docs/specs/control-room-api-endpoint-reference-v1.md`
- Related authoring contract: `docs/specs/scene-document-authoring-v1.md`
- Governing ADR: `docs/adr/0011-resource-first-api.md`

## 1. Purpose

This document defines the **full target route tree** for the local Fullmag control-room API.

The previous tree was too runtime-centric. It described status, fields, mesh, and artifacts, but
it did not make the authoring side explicit enough:

- model builder tree,
- inspector edits,
- object/material/magnetization editing,
- interaction stacks,
- study pipeline,
- ribbons, selection, and layout state.

That is not acceptable for Fullmag. The browser is a first-class authoring surface, so the API tree
must answer questions such as:

- "When I click an object in the model tree, what state changes?"
- "When I switch magnetization from `uniform` to `vortex`, what resource is mutated?"
- "Where do per-object mesh controls live?"
- "What is workspace-only UI state versus physics-affecting authoring state?"

## 2. Core split

The canonical local control-room API must keep these families separate:

1. `status/*`
   Thin runtime summary and revision map.
1. `workspace/*`
   Selection, active node, ribbon, layout, and other workspace-only UI state.
1. `authoring/*`
   Canonical editable model, materials, magnetization assets, physics stack, modules, and study.
1. `mesh/*`
   Meshing policy, per-object controls, shared-domain controls, and realized mesh reports.
1. `domain/*`
   Realized solver domain actually used by renderers and field transport.
1. `quantities/*`, `fields/*`, `scalars`
   Already-computed numerical data.
1. `runs/*`, `stages/*`, `solver/*`
   Runtime read-models for run lifecycle, stage execution, solver state, and energy projections.
1. `display`, `commands`
   Runtime display selection and explicit control actions.
1. `artifacts/*`, `logs/*`, `session/*`, `gpu/*`, `eigen/*`
   Supporting product resources.

## 3. Source-of-truth rules

### 3.1 Model builder is not a second physical model

The model tree, inspector panels, and authoring ribbons are **projections over canonical authoring
state**, not separate backend contracts.

In practice this means:

- `SceneDocument` remains the canonical round-trip authoring document,
- targeted authoring endpoints are partial projections over the same semantic state,
- the model tree is a read-model over authoring resources plus workspace context,
- no inspector panel is allowed to invent a private wire model that bypasses the canonical scene.

### 3.2 Workspace state is not physics state

These are **workspace** concerns:

- current selection,
- active ribbon tab,
- expanded tree nodes,
- dock layout,
- viewport presets,
- camera focus commands.

These are **authoring** concerns:

- objects,
- geometry,
- materials,
- magnetization assets,
- physics stacks,
- study/runtime intent,
- modules/antennas,
- outputs.

Selecting an object is not the same thing as changing the simulation.

### 3.3 One scene revision, many narrow routes

Fullmag may expose both:

- one full-document route: `authoring/scene`,
- many narrow routes such as `authoring/model/materials/:material_id` or
  `authoring/model/magnetization-assets/:asset_id`.

That is allowed **only** if all of them resolve to the same canonical authoring state and bump the
same `scene_revision`.

Targeted `PATCH` or `PUT` endpoints must internally materialize a semantic authoring transaction.
They are not a second persistence model.

### 3.4 Mesh remains a first-class family

Mesh semantics must stay split out even though mesh intent also round-trips through authoring:

- universe mesh config,
- shared-domain mesh config,
- per-object mesh config,
- per-interface mesh config,
- realized build reports and quality.

The model tree may show mesh children under an object, but the canonical dedicated API family for
meshing policy is still `mesh/*`.

For FEM viewport work this implies a three-stage browser contract:

- `authoring/scene` defines primitives, transforms, and semantic object identity,
- `mesh/shared-domain/manifest` plus binary topology defines the realized mesh tree and 3D
  selection structure,
- `display` plus quantity/field resources defines shading, arrows, slices, and other quantity
  overlays.

### 3.5 Display and commands stay runtime-only

`display` and `commands` are not authoring substitutes.

- `display` controls what the user is looking at now,
- `commands` control runtime execution and explicit actions,
- neither of them is allowed to become the hidden transport for model-authoring edits.

## 4. Canonical route tree

The canonical local control-room API tree is:

```text
/v1
├── health
├── capabilities
├── openapi.json
├── asyncapi.json
├── docs
│   ├── swagger
│   └── asyncapi
└── live
    └── current
        ├── ws
        ├── status
        ├── workspace
        │   ├── envelope                         (transitional cutover-only)
        │   ├── selection
        │   ├── ribbon
        │   ├── tree
        │   │   ├── active-node
        │   │   └── expansion
        │   ├── layout
        │   └── viewport-presets
        ├── authoring
        │   ├── scene
        │   ├── transactions
        │   ├── model
        │   │   ├── tree
        │   │   ├── nodes
        │   │   │   └── :node_id
        │   │   ├── universe
        │   │   ├── objects
        │   │   │   └── :object_id
        │   │   │       ├── geometry
        │   │   │       ├── transform
        │   │   │       ├── material-ref
        │   │   │       ├── magnetization-ref
        │   │   │       ├── regions
        │   │   │       ├── visibility
        │   │   │       └── tags
        │   │   ├── materials
        │   │   │   └── :material_id
        │   │   └── magnetization-assets
        │   │       └── :asset_id
        │   │           ├── payload
        │   │           ├── mapping
        │   │           ├── texture-transform
        │   │           └── preset
        │   ├── physics
        │   │   ├── solver
        │   │   ├── demag
        │   │   ├── external-field
        │   │   ├── boundary-conditions
        │   │   └── objects
        │   │       └── :object_id
        │   │           └── interactions
        │   │               └── :interaction_kind
        │   ├── modules
        │   │   ├── current
        │   │   ├── antennas
        │   │   │   └── :antenna_id
        │   │   └── excitation-analysis
        │   ├── study
        │   │   ├── runtime
        │   │   ├── mesh-defaults
        │   │   ├── shared-domain
        │   │   ├── initial-state
        │   │   ├── outputs
        │   │   ├── pipeline
        │   │   └── stages
        │   │       └── :stage_id
        │   ├── builder
        │   │   └── graph
        │   └── script
        │       ├── source
        │       ├── sync
        │       └── export
        ├── mesh
        │   ├── summary
        │   ├── capabilities
        │   ├── universe
        │   │   ├── config
        │   │   ├── report
        │   │   └── quality
        │   ├── shared-domain
        │   │   ├── config
        │   │   ├── manifest
        │   │   ├── report
        │   │   ├── topology
        │   │   └── quality
        │   ├── objects
        │   │   └── :object_id
        │   │       ├── config
        │   │       ├── report
        │   │       ├── quality
        │   │       ├── topology
        │   │       └── size-field
        │   ├── interfaces
        │   │   └── :interface_id
        │   │       ├── config
        │   │       ├── report
        │   │       └── quality
        │   └── builds
        │       ├── active
        │       ├── history
        │       ├── last-success
        │       └── commands
        ├── domain
        │   ├── meta
        │   ├── topology
        │   ├── coordinates
        │   ├── regions
        │   └── active-mask
        ├── quantities
        │   └── catalog
        ├── fields
        │   ├── catalog
        │   └── :quantity_id
        │       ├── meta
        │       ├── vector
        │       ├── stats
        │       └── availability
        ├── scalars
        ├── runs
        │   ├── current
        │   └── :run_id
        ├── stages
        │   ├── execution
        │   ├── current
        │   └── :stage_id
        ├── solver
        │   ├── status
        │   ├── energies
        │   │   ├── current
        │   │   └── history
        │   ├── metrics
        │   ├── diagnostics
        │   └── checkpoints
        ├── display
        ├── commands
        │   ├── status
        │   └── :command_id
        ├── artifacts
        │   ├── index
        │   └── :artifact_id
        ├── logs
        │   └── engine
        ├── eigen
        │   ├── spectrum
        │   ├── mode
        │   ├── dispersion
        │   └── branches
        ├── gpu
        │   └── telemetry
        └── session
            ├── export
            ├── import
            │   ├── inspect
            │   └── commit
            ├── checkpoints
            └── recovery
                ├── index
                └── clear
```

## 5. Family meaning

### 5.1 Workspace

Representative routes:

```text
GET  /v1/live/current/workspace/selection
PUT  /v1/live/current/workspace/selection
GET  /v1/live/current/workspace/ribbon
PUT  /v1/live/current/workspace/ribbon
GET  /v1/live/current/workspace/tree/active-node
PUT  /v1/live/current/workspace/tree/active-node
GET  /v1/live/current/workspace/tree/expansion
PUT  /v1/live/current/workspace/tree/expansion
GET  /v1/live/current/workspace/layout
PUT  /v1/live/current/workspace/layout
```

Rules:

- this family stores workspace/UI state only,
- it must not mutate physics or solver semantics,
- camera focus is a workspace/viewport concern, not a scene mutation,
- deployments may keep some of this state frontend-local, but if it is synchronized, it belongs in
  `workspace/*`, not in `commands` and not in preview endpoints.

### 5.2 Authoring

Representative routes:

```text
GET   /v1/live/current/authoring/scene
PUT   /v1/live/current/authoring/scene
PATCH /v1/live/current/authoring/scene
POST  /v1/live/current/authoring/transactions
GET   /v1/live/current/authoring/model/tree
GET   /v1/live/current/authoring/model/nodes/:node_id
GET   /v1/live/current/authoring/model/materials/:material_id
PATCH /v1/live/current/authoring/model/objects/:object_id/geometry
PATCH /v1/live/current/authoring/model/materials/:material_id
PATCH /v1/live/current/authoring/model/magnetization-assets/:asset_id
GET   /v1/live/current/authoring/physics/objects/:object_id/interactions/:interaction_kind
PATCH /v1/live/current/authoring/physics/objects/:object_id/interactions/:interaction_kind
GET   /v1/live/current/authoring/study/runtime
PATCH /v1/live/current/authoring/study/runtime
PATCH /v1/live/current/authoring/study/pipeline
POST  /v1/live/current/authoring/script/sync
GET   /v1/live/current/authoring/script/source
GET   /v1/live/current/authoring/script/export
```

Rules:

- `authoring/scene` is the full round-trip document,
- targeted `PATCH` routes are semantic projections over the same scene,
- `authoring/transactions` is the canonical commit surface for inspector Apply flows,
- model tree nodes are read models over authoring resources; they are not a second persisted graph,
- `script/sync` derives canonical Python and `ProblemIR` from authoring state, never from a hidden
  UI-only builder blob.

### 5.3 Mesh

Representative routes:

```text
GET  /v1/live/current/mesh/universe/config
PUT  /v1/live/current/mesh/universe/config
GET  /v1/live/current/mesh/shared-domain/config
PUT  /v1/live/current/mesh/shared-domain/config
GET  /v1/live/current/mesh/objects/:object_id/config
PUT  /v1/live/current/mesh/objects/:object_id/config
GET  /v1/live/current/mesh/interfaces/:interface_id/config
PUT  /v1/live/current/mesh/interfaces/:interface_id/config
POST /v1/live/current/mesh/builds/commands
```

Rules:

- per-object mesh config is first-class,
- universe/shared-domain/object/interface config must not be collapsed into one anonymous blob,
- mesh-build commands and mesh-build reports are separate from runtime `commands`,
- the model tree may surface mesh nodes under objects, but dedicated mesh mutations still belong in
  `mesh/*`.

### 5.4 Domain, quantities, fields, scalars

Representative routes:

```text
GET /v1/live/current/ws
GET /v1/live/current/domain/meta
GET /v1/live/current/domain/topology
GET /v1/live/current/domain/coordinates
GET /v1/live/current/quantities/catalog
GET /v1/live/current/fields/catalog
GET /v1/live/current/fields/:quantity_id/meta
GET /v1/live/current/fields/:quantity_id/vector
GET /v1/live/current/fields/:quantity_id/stats
GET /v1/live/current/scalars
```

Rules:

- `ws` is a notification bus layered over these resources, not a second state API,
- this is the read-optimized data plane,
- already-computed quantities are fetched as resources,
- quantity switching must not enqueue preview-control work if data already exists,
- authoring changes may invalidate these revisions, but these families are never the authoring
  write path.

### 5.5 Display and commands

Representative routes:

```text
GET   /v1/live/current/display
PUT   /v1/live/current/display
PATCH /v1/live/current/display
POST  /v1/live/current/commands
GET   /v1/live/current/commands/status
GET   /v1/live/current/commands/:command_id
```

Rules:

- `display` controls active quantity/component/view mode/selection for rendering,
- `GET /display` returns the full current resource snapshot,
- `PUT /display` replaces the full display resource,
- `PATCH /display` mutates only the provided fields,
- `commands` controls solve, relax, stop, export, and other explicit runtime actions,
- `mesh/builds/*` owns mesh build lifecycle and remesh intent,
- `commands/status` and `commands/:command_id` are runtime read-models over the command ledger and
  long-term grow into authoritative completion/rejection resources,
- neither route family is allowed to smuggle model-builder mutations.

### 5.6 Runs, stages, solver

Representative routes:

```text
GET /v1/live/current/runs/current
GET /v1/live/current/stages/execution
GET /v1/live/current/solver/status
GET /v1/live/current/solver/energies/current
GET /v1/live/current/solver/energies/history
```

Rules:

- these are runtime read-model resources, not mutation endpoints,
- they close the gap between thin `status` and the old monolithic `/state` snapshot,
- solver energies are explicit projections over scalar history or the latest step, not a second
  source of physics truth,
- run/stage/solver resources must remain cacheable JSON summaries and must not turn back into a
  bootstrap blob.

## 6. UI action to endpoint mapping

The API tree must make concrete UI flows unambiguous.

| UI action | Source of truth | Canonical endpoint | Notes |
|---|---|---|---|
| Click object in model tree | `workspace` | `PUT /workspace/selection` or frontend-local state | Selection changes inspector/ribbon context only. It is not a physics mutation. |
| Focus current selection in 3D | `workspace` / viewport | no authoring endpoint; local camera command or workspace viewport command | Selection and focus are intentionally separate. |
| Rename object | `authoring.scene` | `PATCH /authoring/model/objects/:object_id` or `POST /authoring/transactions` | Bumps `scene_revision`. |
| Change material `Ms`, `Aex`, `alpha`, `Dind` | `authoring.scene` | `PATCH /authoring/model/materials/:material_id` or `POST /authoring/transactions` | Affects canonical physics semantics. |
| Change object magnetization to `uniform` | `authoring.scene` | `PATCH /authoring/model/magnetization-assets/:asset_id` | Payload sets `kind="uniform"` and updates `value=[mx,my,mz]`. |
| Change object magnetization to `vortex` | `authoring.scene` | `PATCH /authoring/model/magnetization-assets/:asset_id/preset` or `POST /authoring/transactions` | Payload sets `kind="preset_texture"`, `preset_kind="vortex"`, plus `preset_params`. |
| Edit texture transform for magnetization preset | `authoring.scene` | `PATCH /authoring/model/magnetization-assets/:asset_id/texture-transform` | Still authoring, not display. |
| Toggle object interaction such as DMI/exchange/anisotropy | `authoring.scene` | `PATCH /authoring/physics/objects/:object_id/interactions/:interaction_kind` | Maps to per-object `physics_stack`. |
| Change requested backend/device/precision/mode | `authoring.scene` | `PATCH /authoring/study/runtime` | Preserves requested intent separately from resolved runtime. |
| Add/reorder/remove study stages in ribbon | `authoring.scene` | `PATCH /authoring/study/pipeline` or `POST /authoring/transactions` | This is authoring, not `commands`. |
| Change per-object mesh override | `mesh` | `PUT /mesh/objects/:object_id/config` | Mesh is first-class and separately queryable/reportable. |
| Change shared-domain FEM mesh policy | `mesh` | `PUT /mesh/shared-domain/config` | Dedicated mesh family, not hidden in display or commands. |
| Switch displayed quantity | `display` + `fields` | `PATCH /display`, then `GET /fields/:quantity_id/*` as needed | Quantity switches are partial display mutations; data comes from field store. |
| Press Run/Relax/Stop/Remesh | `commands` | `POST /commands` | Explicit runtime action. |
| Change active ribbon tab or dock layout | `workspace` | `PUT /workspace/ribbon`, `PUT /workspace/layout` | Workspace-only state, not authoring semantics. |

## 7. Revision vocabulary

The route tree above depends on explicit revision keys.

Minimum families:

- `status_revision`
- `workspace_revision`
- `scene_revision`
- `model_tree_revision`
- `mesh_revision`
- `mesh_build_revision`
- `domain_generation_id`
- `topology_revision`
- `coordinates_revision`
- `quantities_revision`
- `fields_revision`
- `field_revision`
- `scalars_revision`
- `artifacts_revision`
- `engine_log_revision`
- `display_revision`

Not every route needs every revision. But every fetchable resource family must have a stable
cache-invalidating identity.

## 8. Legacy routes that must not survive the refactor

These are explicitly non-canonical and are either already removed from the
public browser contract or kept only behind a deliberate short-lived
compatibility/internal layer:

```text
GET  /v1/live/current/bootstrap
GET  /v1/live/current/poll
GET  /v1/live/current/state                 (retired compatibility snapshot; no longer used by the active frontend and absent from the current public mount)
POST /v1/live/current/preview/*
GET  /v1/live/feature-flags               (removed from public router)
GET  /v1/quantities/catalog                (removed from public router)
GET  /v1/live/current/scene/document      (removed from public router)
PUT  /v1/live/current/scene/document      (removed from public router)
POST /v1/live/current/state/export
POST /v1/live/current/state/import
POST /v1/live/current/scene               (removed from public router)
POST /v1/live/current/script/sync         (removed from public router)
```

As of `2026-04-21`, runner bridge traffic is no longer part of the public browser contract.
The remaining internal-only bridge paths are:

```text
POST /v1/internal/live/current/snapshot
POST /v1/internal/live/current/session
POST /v1/internal/live/current/runtime
POST /v1/internal/live/current/scalars
POST /v1/internal/live/current/fields
GET  /v1/internal/live/current/control/wait
```

Internal bridge note:

- `control/wait` now carries only queued solver/control commands.
- Display selection sync for idle/paused preview refresh follows the canonical
  `display_revision` resource signal from `GET /v1/live/current/status`, not
  legacy preview command kinds.

## 9. Current implementation note

As of `2026-04-21`, the repository is still in migration:

- parts of `status`, `domain`, `fields`, `scalars`, `display`, `commands`, `artifacts`,
  `eigen`, `session`, `gpu`, `system`, and `quantities` already exist,
- the concrete currently mounted endpoint list and field-level schema reference now live in
  `docs/specs/control-room-api-endpoint-reference-v1.md`,
- retired flat aliases such as `/v1/quantities/catalog` and
  `/v1/live/current/scene/document` no longer sit on the public router,
- the mounted `workspace/*` subset now covers `selection`, `tree/active-node`, `ribbon`, and `layout`,
- the mounted `mesh/*` subset now covers `summary`, `builds/active`, `builds/commands`,
  `universe/config`, `shared-domain/config`, and `objects/:object_id/config`,
- `workspace/tree/expansion` and `workspace/viewport-presets` remain target-only,
- wide `authoring/*` families are still not yet fully implemented,
- `mesh/*` still needs broader report, quality, history, and per-interface split coverage in some code paths,
- a lightweight cutover envelope may still be needed while `bootstrap/poll` is removed from the
  current UI.

This document is therefore the **target tree**, not a false claim that every branch already exists.
