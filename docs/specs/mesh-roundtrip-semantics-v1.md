# Mesh Round-Trip Semantics v1

Status: canonical  
Updated: 2026-04-23

## 1. Vocabulary

This spec freezes the three mesh levels used across Python authoring, canonical `ProblemIR`,
planner/runner, API resources, and UI mesh workspace.

The three levels are:

1. `universe_mesh_config` (authoring intent for outer domain / air policy),
2. `per_object_mesh_config` (authoring intent per object),
3. `solver_mesh` (derived shared-domain realization used by solver execution).

## 2. Canonical Rule: Render vs Physics

UI render controls (`visibility`, `isolate`, `preview scope`, clip-only display filters)
must never mutate solver-domain semantics.

Render controls can affect what is displayed in viewport only; they are not allowed to:

- change FEM domain membership,
- change shared-domain mesh assembly,
- change solver-mesh provenance identity.

## 3. Canonical Representation

### 3.1 Authoring level

- `universe_mesh_config` is the source of truth for universe/airbox policy.
- `per_object_mesh_config` is the source of truth for object-level mesh overrides.

### 3.2 Derived solver level

- `solver_mesh` is a derived artifact/reference, not a replacement for authoring intent.
- `solver_mesh` must expose identity/provenance fields (`mesh_name`, `mesh_id`,
  `generation_id`, `domain_mesh_mode`) and diagnostics/build summary linkage.
- Canonical v2 cell and facet records carry immutable `global_ordinal` identities.
  Filtering, grouping, packing, slicing, serialization, and artifact selection preserve those
  identities. Combining multiple independently authored meshes creates a new canonical mesh
  namespace, so merge assigns a new unique sequential ordinal set instead of retaining colliding
  source ordinals; the merged mesh identity and fingerprint therefore describe a new realization.

## 4. Resource-First API Projection

`GET /v1/live/current/mesh/semantics` is the canonical consolidated projection for mesh semantics:

- `universe_config`,
- `shared_domain_config`,
- `object_configs[]`,
- `solver_mesh`,
- `mesh_build_diagnostics`,
- `render_only_controls_do_not_change_solver_domain`.

This endpoint is a thin semantic projection; heavy geometry remains served by binary topology lanes.

## 5. Round-Trip Contract

Round-trip is valid only if:

1. authoring `universe/per-object` intent survives export/import without semantic loss,
2. solver mesh remains inspectable as derived execution artifact,
3. UI mesh workspace shows config-level and solver-level data as distinct concepts,
4. render-only controls do not alter solver-domain provenance or mesh identity.
