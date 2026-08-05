# Physics scope graph and production Explorer/Inspector design

**Status:** design proposal — implementation has not started  
**Date:** 2026-08-05  
**Owners:** Fullmag backend, authoring, API and Control Room maintainers

## 1. Decision summary

The production solution is a canonical physics-scope graph propagated from
Python/ProblemIR through authoring, planner and runtime into the Control Room.
The Explorer must consume the graph rather than infer ownership from list
position, resource family or the currently selected UI node.

The authoritative interpretation of an electrical current being “off” is:

> no current module was authored in Python IR or in the UI, therefore no
> current source record exists after scene normalization.

This is intentionally different from inspecting a numeric value such as
`j = 0`. A module with a zero drive can be a valid authored configuration and
must remain distinguishable from an absent module. An explicit `enabled` or
stage activation flag, where a family already supports one, is a runtime
activation state of an existing module; it must never cause the UI to invent a
module that is absent from IR.

The graph has one semantic shape for FEM and FDM. The lane changes the
capability, planner resolution and numerical realization, not the physical
scope tree or the public equations.

## 2. Problem statement and current defects

The current Explorer unconditionally appends the following product-level
collections from `buildModelTree()`:

- Current Transport
- Spin Transport
- Spin Interfaces
- Spin Torques
- Oersted Fields

As a result, a scene with no authored electrical-current module can expose
spin-transport and torque nodes. Resource list presence is being treated as
physical applicability, and no common graph expresses the relationship
between a current source, its solve domain, its torque targets and its field
targets.

The current authoring resources already contain partial scope information:

- current transport has `domain` region references and legacy `solve_region`,
- spin transport has `domain` and `current_source_id`,
- several torque variants have a `target` region reference and a current
  binding,
- spin interfaces contain region references on both sides,
- regional magnetic field drives have explicit `global`, `object` and `region`
  targets,
- the study contains a global external field.

These partial contracts are not normalized into one graph. Some variants
(notably legacy/targetless records) cannot be assigned to an object without
guessing, which is not acceptable for production scientific software.

The transport and spin inspectors are also flat forms. They do not expose
scope, dependency, requested/resolved execution lane, or qualification in the
same responsive composition used by the Visualization inspector.

## 3. Goals

1. Define a versioned, typed physics-scope contract in ProblemIR.
2. Preserve physical intent across Python DSL, IR, scene authoring, OpenAPI,
   planner, FEM/FDM runtime and provenance.
3. Make module presence the authoritative authoring condition for current,
   spin and Oersted families.
4. Attach an interaction to an object or region only when the canonical
   contract names that object or region.
5. Represent global and cross-object physics explicitly.
6. Fail closed for ambiguous or unsupported scope instead of silently
   assigning a source to the first object.
7. Use the same graph and Explorer structure in FEM and FDM.
8. Rebuild the transport, spin, torque, Oersted and field-drive inspectors
   using the Visualization inspector composition and shared action bar.
9. Make all changes round-trip-safe and observable in provenance.

## 4. Non-goals

- Inferring a module from a zero-valued drive, a default form, array position,
  mesh ownership or the current UI selection.
- Making a semantic-only transport realization executable as a side effect of
  this UI refactor.
- Duplicating physics equations in FEM and FDM frontends.
- Encoding a backend-specific mesh layout in the public Python or UI contract.
- Deleting unknown authoring records. Unknown records remain lossless and
  read-only, with an explicit unsupported/unresolved state.
- Treating a successful TypeScript/unit-test run as proof of FEM or FDM
  physics equivalence.

## 5. Canonical graph model

### 5.1 Graph entities

The canonical `PhysicsGraphIR` contains:

```text
PhysicsGraphIR {
  schema_version,
  scene_revision,
  modules: [PhysicsModuleIR],
  edges: [PhysicsEdgeIR],
  global_interactions: [GlobalInteractionIR],
  requested_execution,
  resolved_execution,
  provenance
}

PhysicsModuleIR {
  id,
  kind,
  applies_to: PhysicsScopeSet,
  solve_domain: [RegionRef],
  depends_on: [PhysicsModuleId],
  activation: PhysicsActivation,
  authored_state,
  capability,
  family_payload
}
```

`family_payload` remains typed by the owning physics family. The graph owns
scope, identity, dependency and lifecycle semantics; it does not flatten
family-specific constitutive parameters into an untyped dictionary.

### 5.2 Scope references

```text
PhysicsScopeRef =
    Global
  | Object { object_id }
  | Region { object_id, region_id }
  | Interface { side_a: RegionRef, side_b: RegionRef }
  | CrossObject { object_ids: [ObjectId] }
  | Unresolved { reason, source_path }
```

Rules:

- `Global` is used only when the authoring contract explicitly defines a
  global effect (for example `study.external_field` or a field drive with
  `target.kind = global`).
- A single object/region is represented by `Object`/`Region`, never by a
  product-level aggregate node.
- A module touching multiple objects is `CrossObject` or `Interface`.
- `Unresolved` is a visible diagnostic state, not a permission to choose an
  arbitrary owner.
- Scope references are stable IDs, not labels or array indexes.

### 5.3 Solve domain versus application target

`solve_domain` answers “where is a charge/spin PDE solved?”.
`applies_to` answers “which magnetic object/region receives the resulting
field or torque?”. These are intentionally separate:

- a spin accumulation may be solved over normal and ferromagnetic regions,
  while a torque is applied only to the ferromagnetic free layer;
- a charge solution can span several conductive objects;
- an Oersted field derived from a solution can be global in the magnetic
  universe even though its source solve is local.

The planner must reject references that are not present in the scene and must
not collapse the two concepts into one `object_id` field.

### 5.4 Activation and authored state

The graph distinguishes:

- `configured`: module exists in authored IR and passes structural validation;
- `active`: configured module is enabled for the current stage/time policy;
- `inactive`: configured module is explicitly disabled or outside its stage
  activation set;
- `blocked`: dependency, scope or lane validation prevents execution;
- `unsupported`: unknown/future variant preserved as opaque data.

Absence is not a graph entity. If no current transport was authored, there is
no current-source module and no dependent spin module may be promoted to an
active runtime node. A configured module with zero numeric amplitude remains a
real module and is shown as configured/inactive only if the family contract
explicitly defines such a state.

### 5.5 Dependency edges

Edges are typed and stable:

```text
source     current_transport -> spin_transport
target     spin_torque -> region/object
field      current_transport -> oersted_field
interface  spin_transport -> spin_interface
```

The graph validator checks that every `depends_on` ID exists, that source
families are compatible, and that no inactive/missing source is reported as
an active dependent effect.

## 6. Family normalization and migration

The migration is additive and versioned. Existing family payloads remain
readable; normalization emits the new graph and records the source path in
provenance.

### 6.1 Current transport

- Preserve the existing transport ID/name and family payload.
- Treat `domain` as `solve_domain`.
- When `domain` contains exactly one object/region owner and the public
  contract says the current is local, emit that owner in `applies_to`.
- When the domain spans multiple objects, emit `CrossObject`.
- Resolve legacy `solve_region` only against stable object/region IDs. A
  non-unique or missing match becomes `Unresolved`.
- A prescribed-density source without a target remains `Global` only if the
  canonical Python contract explicitly declares global current; otherwise it
  is `Unresolved` and cannot be attached to an object.

### 6.2 Spin transport

- Preserve `current_source_id` as a required `source` edge.
- Preserve `domain` as `solve_domain`.
- Derive object/region scope only from the domain refs.
- A domain spanning several objects becomes `CrossObject`.
- A transport whose current source is absent is `blocked`, not global.

### 6.3 Spin interfaces

- Normalize `side_a`/`side_b` or normal/ferromagnet refs to an
  `Interface` scope.
- Carry the owning spin-transport ID as an edge.
- Do not duplicate an interface under both objects; it appears under the
  cross-object/interface branch and links to both sides.

### 6.4 Spin torque and SOT

- Make the target mandatory for new canonical variants.
- Keep the current binding (`current_source` or inline drive) explicit.
- Existing records with a valid target become object/region nodes.
- Legacy targetless records become `Unresolved` unless the legacy IR version
  explicitly documents a global target. They are retained read-only until
  migrated by the author.
- A torque depending on an absent current module is `blocked`; it is not
  displayed as active STT/SOT.

### 6.5 Oersted field

- `OerstedField(source=...)` receives a source edge to the named current
  transport and an explicit application target in the canonical contract.
- `OerstedCylinder` receives an explicit source/application scope in the new
  DSL. Existing cylinders without a target normalize to `Global` only where
  the legacy physical definition guarantees a global analytic field;
  otherwise they become `Unresolved` rather than being guessed from geometry.
- The analytic field parameters (current, radius, center, axis and time
  dependence) remain unchanged.

### 6.6 Field drives and global field

- Reuse the existing typed `FieldTargetResource` (`global`, `object`,
  `region`) as the canonical target for regional drives.
- Promote `study.external_field` to a global Physics module only when the
  vector is authored/present; absence means no global Zeeman module.
- Do not duplicate object-local field drives in the global branch.

## 7. Python DSL and ProblemIR changes

The public DSL must expose the same concepts as the graph:

1. Add explicit `target`/`applies_to` and, where necessary, `solve_domain` to
   current, spin-torque and Oersted constructors.
2. Add a typed activation object only where a family supports stage/time
   activation; do not overload numeric amplitude as presence.
3. Require stable IDs for modules and referenced objects/regions.
4. Lower to one canonical graph representation while preserving family
   payloads.
5. Export canonical Python with all non-default scope/dependency fields.
6. Import old scene/IR versions through a deterministic migration with
   warnings for unresolved scope.
7. Validate:
   - references exist and are unique,
   - a target belongs to the declared solve domain when the family requires
     that relationship,
   - source IDs exist and have the compatible family,
   - interface sides are distinct and geometrically meaningful,
   - FEM/FDM requested execution is a lane request, not a second physical
     model.

Required tests include Python constructor validation, old/new IR migration,
script export/import round-trip, and negative tests for missing targets and
sources.

## 8. Rust authoring, API and OpenAPI

### 8.1 Canonical backend types

Add versioned Rust types in the authoring/IR layer for:

- `PhysicsScopeRef` and `PhysicsScopeSet`,
- `PhysicsActivation`,
- `PhysicsModuleIR`/`PhysicsGraphIR`,
- typed graph edges and lifecycle/capability state.

Existing `Scene*` family structs are retained as payload types and migrated
through one normalization function. There must be one normalization path for
script import, UI mutation and runtime preparation.

### 8.2 Resource-first API

Add a session-scoped semantic resource for the graph, for example:

`GET /v2/sessions/current/model/physics-graph`

The response contains:

- scene revision and graph schema version,
- normalized modules and edges,
- scope and dependency state,
- requested and resolved execution lane per module,
- capability/qualification and diagnostic reasons,
- provenance source paths.

It must not contain heavy field/topology data. Existing family endpoints
remain useful for editing payloads, but the graph resource is the source for
Explorer placement and dependency state. Mutations invalidate the graph
revision together with the affected family resources.

Update OpenAPI, generated frontend types, the typed API client, resource hook,
resource invalidation map and backend route tests together. No module may
hand-roll endpoint strings or call `fetch` directly.

## 9. Planner and runtime semantics

The planner consumes `PhysicsGraphIR` and produces a resolved graph with:

- `requested_execution` (author intent),
- `resolved_execution` (actual FEM/FDM/device/precision lane),
- capability and qualification status,
- backend operator provenance,
- normalized scope mapping.

FEM resolution maps object/region/interface scope to mesh entities and
element markers. FDM resolution maps the same scope to structured-grid cell
membership and region masks. Neither path may introduce a second scope
vocabulary.

Runtime requirements:

- absent source => no dependent operator/torque/field contribution;
- blocked/unresolved source => no silent fallback; fail or expose a declared
  semantic-only state according to the existing execution policy;
- active graph IDs and scope are included in result/provenance artifacts;
- graph revision and scene revision are recorded with every run.

## 10. Explorer design

The Explorer builder consumes the graph resource and only renders branches
with semantic children.

```text
Session Model
├── Global Physics                 (only if it has children)
│   ├── External Field
│   ├── Global Field Drives
│   ├── Cross-object Physics
│   └── Unresolved / Unsupported  (collapsed diagnostic branch)
├── Objects
│   └── <object>
│       ├── Geometry / Material / Mesh / Visualization
│       └── Physics                 (only if it has children)
│           ├── Current Transport
│           ├── Spin Transport
│           ├── Spin Torque / SOT
│           ├── Oersted Field
│           └── <region>
└── Mesh / Study / Results
```

Rules:

1. Do not append an empty family collection.
2. Do not attach a module based on list position or selected object.
3. A dependent node is active only when its source edge resolves to an
   authored module; an absent current module produces no active spin node.
4. Interface and multi-object modules appear once under Cross-object Physics
   and carry links to both object/region refs.
5. Inactive, blocked and unsupported authored records remain available under
   one collapsed diagnostic branch, with a reason and source path.
6. Node identity is stable (`physics-graph:<module-id>` plus scope identity),
   so selection survives list reordering.
7. The same builder contract is used for FEM and FDM. Lane badges and
   capability diagnostics come from the resolved graph.

Add a dedicated resolver/model test suite before changing snapshots. Cover:

- empty scene,
- no current module,
- one object-local current and dependent spin chain,
- global field drive,
- cross-object spin domain/interface,
- unresolved legacy record,
- unknown variant,
- FEM and FDM with identical semantic graph,
- stable IDs after resource reorder.

## 11. Inspector design

Create a reusable physics overview composition based on the exact
Visualization inspector layout (`ObjectVisualizationOverview`):

1. responsive container with the same metric strip,
2. primary bordered card for the main authoring state,
3. navigation-style `InspectorGroup` rows for secondary sections,
4. shared `--fm-*` tokens and shared controls (`FormField`, `Vector3Field`,
   `SegmentedControl`, `Switch`, `Slider` where appropriate),
5. existing `InspectorEditSession` action bar for Apply/Reset/Focus.

Physics-specific sections:

- **Scope** — Global/Object/Region/Interface/Cross-object, stable refs and
  provenance;
- **Drive / Constitutive** — current, polarization, torque/Oersted/field
  parameters with SI units;
- **Dependency** — source ID, upstream module status and blocked reason;
- **Solver / Execution** — requested lane, resolved lane, CPU/GPU, precision,
  solver/operator versions and residual policy;
- **Diagnostics / Provenance** — graph revision, scene revision, validation,
  qualification and source path;
- **Actions** — typed draft mutations through the existing API facade.

The inspector must not duplicate Visualization rendering controls or embed
canvas/image previews. It should use the same responsive card/nav rhythm and
the same CSS token domain; new CSS classes use the `fm-` prefix.

## 12. Implementation phases and review gates

### Phase 0 — specification and fixtures

- finalize this contract and bibliography/source mapping;
- add representative FEM/FDM scene fixtures and expected graph JSON;
- record migration rules and compatibility boundaries.

**Gate:** reviewers approve the graph schema, absence semantics and fixture
truth tables.

### Phase 1 — IR and Python round-trip

- implement typed scope/activation/dependency objects;
- add constructor arguments and canonical lowering/export;
- migrate legacy records with explicit unresolved diagnostics;
- pass Python validation and round-trip tests.

**Gate:** no API/UI work until old and new scripts produce the same normalized
graph for equivalent physical intent.

### Phase 2 — Rust authoring and API resource

- implement normalization and graph validation;
- add OpenAPI route/schema/generated types/facade/resource hook;
- connect mutation invalidation to graph revision;
- add route/schema/unknown-variant tests.

**Gate:** one API response is sufficient to place every Explorer node without
reading family list order or guessing scope.

### Phase 3 — planner/runtime FEM and FDM

- consume graph scope in both lane planners;
- map scopes to FEM markers and FDM memberships;
- enforce dependency omission for absent sources;
- emit requested/resolved lane and graph provenance;
- run managed/container-backed FEM verification and the matching FDM gates.

**Gate:** controlled FEM/FDM semantic parity on the same graph, plus explicit
unsupported/semantic-only outcomes where execution is not qualified.

### Phase 4 — Explorer and selection

- replace unconditional family roots with graph-driven branches;
- add global/object/region/cross-object grouping;
- update selection refs, inspector registry and stable node IDs;
- preserve diagnostics for unresolved/unknown records.

**Gate:** empty-current scenes have no active spin nodes; object-local and
global/cross-object fixtures are placed exactly once.

### Phase 5 — Inspector migration

- add reusable physics overview composition;
- migrate transport, spin transport, torque, Oersted, field-drive and
  object/global physics panels;
- expose scope/dependency/lane/provenance sections;
- add responsive DOM and design-contract tests.

**Gate:** inspectors use the Visualization composition, shared action bar,
token-only styles and no direct API calls.

### Phase 6 — browser and production qualification

- run the Control Room Browser smoke for FEM and FDM;
- verify canvas/context/drawing-buffer health where viewport is involved;
- capture Explorer/Inspector screenshots at narrow and wide widths;
- compare graph JSON, planner provenance and runtime artifacts;
- document any environment/browser bridge blocker separately from product
  behavior.

**Gate:** no production claim before fresh runtime and browser evidence.

## 13. Acceptance matrix

| Scenario | Expected graph | Expected Explorer | FEM/FDM requirement |
|---|---|---|---|
| Empty scene | no current/spin modules | no transport branches | same empty graph |
| Current module absent, old dependent record absent | no dependent edge | no STT/SOT/SHE/Oersted active nodes | no transport operator |
| One object-local current + spin chain | object scope + source edges | one Physics branch under that object | same scope, lane-specific mapping |
| Global field drive | Global scope | Global Physics → Field Drives | same field target |
| Two-object spin domain/interface | CrossObject/Interface | one Cross-object branch, linked refs | markers vs cell masks |
| Unknown future variant | Unsupported/Unresolved | collapsed diagnostics branch | no silent execution |
| Requested FEM, resolved FDM (or inverse) | both lanes recorded | same semantic node, lane diagnostic | planner explains resolution |

## 14. Risks and mitigations

- **Legacy targetless modules:** migrate to `Unresolved`, preserve payload and
  provide an explicit authoring repair path.
- **Scope/domain confusion:** keep separate fields and validate their
  relationship; add fixture cases where they differ.
- **Resource revision races:** graph and family resources share scene revision;
  mutations invalidate all affected keys atomically.
- **UI regressions from dirty shared worktree:** isolate commits by file set,
  inspect staged names separately, and preserve unrelated user changes.
- **False FEM/FDM equivalence:** require controlled graph/provenance/runtime
  evidence, not merely identical tree snapshots.
- **Browser bridge failure:** report `sandboxCwd`/bridge failures as
  environment evidence, never as a product screenshot result.

## 15. Deferred decisions requiring explicit review

1. Exact Rust/OpenAPI names for `PhysicsGraphIR` and `PhysicsGraphResource`.
2. Whether the global branch is called `Global Physics` or `Physics (Global)`
   in the localized UI.
3. The legacy version(s) that formally authorize targetless global torque or
   Oersted semantics.
4. Whether inactive authored modules are shown only in diagnostics or also in
   a collapsed `Inactive Physics` branch.
5. The first runtime lane to be qualified for every new target variant.

No implementation should begin until these decisions are recorded in the
approved execution plan and the unresolved legacy semantics are explicitly
covered by tests.
