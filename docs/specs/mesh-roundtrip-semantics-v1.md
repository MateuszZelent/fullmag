# Mesh Round-Trip Semantics v1

Status: canonical  
Updated: 2026-07-30

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

The v1 live endpoint no longer exists. Mesh semantics are projected through the
session-scoped v2 meshing resources under `/v2/sessions/current/meshing/...`:

- `universe_config`,
- `shared_domain_config`,
- `object_configs[]`,
- `solver_mesh`,
- `mesh_build_diagnostics`,
- `render_only_controls_do_not_change_solver_domain`.

These resources remain thin and revisioned; heavy geometry stays on binary topology lanes.

## 5. Round-Trip Contract

Round-trip is valid only if:

1. authoring `universe/per-object` intent survives export/import without semantic loss,
2. solver mesh remains inspectable as derived execution artifact,
3. UI mesh workspace shows config-level and solver-level data as distinct concepts,
4. render-only controls do not alter solver-domain provenance or mesh identity.

## 6. Persistence and interchange

Native reuse and external interchange are separate contracts:

- `.fullmag-mesh` is the lossless native artifact used by
  `study.mesh.save()`, `study.mesh.load()`, and `study.mesh.save_or_load()`;
- Gmsh 4.1 `.msh` plus `<mesh>.msh.fullmag.json` is the explicit interchange
  representation used by `study.mesh.export()` and `study.mesh.import_()`.

Native loading requires equality of the canonical mesh-authoring fingerprint
and validates the topology fingerprint, member digests, semantic marker maps,
mesh parts, periodic data, and available certificates. External import creates
a new solver-mesh identity because node, element, and Physical Group numbering
may change in COMSOL or another tool. In both cases the accepted topology enters
the existing `fem_domain_mesh_asset`; neither representation replaces universe
or per-object authoring intent.
