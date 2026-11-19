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

Manual outer-domain policy must contain finite positive size; optional center retains the existing origin convention. Accepted `study.universe_mesh` takes precedence over a retained `scene.universe` projection. An authored body outside manual bounds blocks mesh build and solver run until bounds or placement are corrected; authoring edits remain allowed. Automatic policy may remain geometry-dependent before the first object. It does not require an executing engine. See [ADR 0053](../adr/0053-authoring-method-and-first-run-domain.md) for model method versus run resolution and readiness ownership.

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

### Stage continuation and modal handoff

An implicit Study transition may reuse a field only when the source and target
carry the same canonical discretization identity. For FEM this means the full
`sha256:` topology fingerprint, including node ordering, typed connectivity,
markers, boundary facets and periodic pairs. For FDM it additionally means the
same origin, cell counts, cell size, active mask, region mask and grid
certificate fingerprint. Equal vector length or equal node count is not an
identity proof.

The normal `relax -> dynamics/eigen/frequency-response` path is fail-closed:

- an unsupported transition is rejected before planning or state mutation;
- FDM-to-FEM is rejected unless a dedicated, explicit backend-transfer stage is
  selected;
- FEM-to-FEM with changed topology is rejected rather than interpolated;
- FDM-to-FDM direct reuse is legal only for an identical structured grid;
- adaptive remeshing of `SharedDomainMeshWithAir` is rejected until an
  airbox-preserving remesher and transfer certificate exist.

An explicit remesh or backend-transfer operation may produce a new realization,
but it must publish source and target identities plus transfer provenance. It
must never be represented as ordinary continuation.

Stage history publishes `mesh_generation_id`, `mesh_topology_fingerprint` and,
when owned by the stage, `mesh_revision`. A missing legacy value means
`unknown`; it must not be synthesized from a mesh name or element counts.

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
- COMSOL Multiphysics text v4 `.mphtxt` plus an adjacent `.fullmag.json`
  sidecar is the direct COMSOL interchange representation;
- Gmsh 4.1 `.msh` plus `<mesh>.msh.fullmag.json` remains the general mesh-tool
  interchange representation.

Native loading requires equality of the canonical mesh-authoring fingerprint
and validates the topology fingerprint, member digests, semantic marker maps,
mesh parts, periodic data, and available certificates. External import creates
a new solver-mesh identity because node, element, and Physical Group numbering
may change in COMSOL or another tool. A returned COMSOL mesh without a matching
sidecar requires explicit semantic maps and external geometric-entity maps. In
all cases the accepted topology enters
the existing `fem_domain_mesh_asset`; neither representation replaces universe
or per-object authoring intent.


(mesh-object-id-recipe)=
## Per-object recipe by immutable ID

Zaimplementowane rozszerzenie publiczne: `study.objects.mesh.by_id(object_id)`
zwraca istniejący GeometryMeshHandle zarówno dla magnetic, jak auxiliary
geometry. Lookup używa exact immutable ID, odmawia unknown/ambiguous ID i
handle z innego study. Dotychczasowy raw geometry return pozostaje bez zmian.
Canonical recipe pozostaje `mesh_workflow.per_geometry`, bez nowego IR dialect.
Scene object_mesh/mesh_override → builder geometry.mesh → canonical Python
by_id(exact_id) → ten sam per_geometry intent. Eksport nie może pominąć recipe
nonmagnetic geometry ani inferować physics z nazwy. Independent sampling
recipe zachowuje actual XYZ/connectivity podczas refinements source.
Owner: note0105 DOC-ANCHOR:fem-object-mesh-by-id; runtime/science qualification
nie wynika z authoring lookup ani Gmsh proof.

Dowód E2/E4: publiczne auxiliary ID lookup, recipe, Python i Scene export/reimport
mają interpretowane regresje w `packages/fullmag-py/tests/test_auxiliary_geometry_mesh.py`.
Bitowa stabilność stałego sampling przy source min=max 0.15/0.10/0.075 um dotyczy
Gmsh 4.15.2 z `FULLMAG_GMSH_THREADS=1`; domyślne wielowątkowe ordering/coords
nie są kwalifikowane. To dowód authoring/meshing, bez rozwiązania V/J/H.
