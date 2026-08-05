# Physics Scope Graph and Production Explorer/Inspector Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authored physics-module presence the single source of truth for FEM and FDM, propagate explicit global/object/region/interface scope through Python/ProblemIR/authoring/API/planner/runtime, and present only semantically valid Explorer nodes with Visualization-template inspectors.

**Architecture:** A versioned `PhysicsGraphIR` is normalized once from the existing typed family payloads. The graph owns stable identity, scope, dependencies, activation and capability state while family payloads retain constitutive parameters. The resource-first API exposes the graph to the Control Room; FEM and FDM resolve the same graph into lane-specific markers/masks without inventing a second physical vocabulary.

**Tech Stack:** Rust (`fullmag-authoring`, `fullmag-ir`, `fullmag-plan`, `fullmag-api`, `fullmag-runner`), Python DSL (`packages/fullmag-py`), OpenAPI v2/utoipa, TypeScript/React/Vitest/Next.js 16, existing Control Room inspector primitives, managed container-backed FEM/MFEM/CUDA recipes, and FDM CPU/GPU qualification fixtures.

## Global Constraints

- The absence of a current module in Python IR/UI means no current-source entity exists; `j = 0` is never used to infer absence.
- An authored zero-drive module remains a real module and is rendered according to its explicit activation state.
- `solve_domain` and `applies_to` are separate contracts; scope is never guessed from list order, mesh ownership, labels or selection.
- Unknown or ambiguous records are lossless, read-only `unsupported`/`unresolved` graph modules; no silent fallback or arbitrary object assignment.
- FEM and FDM share the graph, IDs, equations, units, activation and provenance; only marker/mask resolution and numerical lane realization differ.
- All browser/API changes use `/v2/sessions/current/...`, the typed API facade, resource hooks and revision invalidation; no component calls `fetch` or hand-builds endpoint strings.
- Every interactive Control Room class uses the `fm-` prefix, `--fm-*` tokens and existing shadcn-style primitives; no raw one-off colors or legacy cards.
- Physics inspectors use the same responsive composition as `ObjectVisualizationOverview`: metric strip, bordered primary card, navigation `InspectorGroup` rows, and `InspectorEditSession` actions.
- Native FEM/MFEM/CUDA/hypre/libCEED work starts with the repository container-backed `justfile`; persistent build/runtime storage is below `/zfn2/mateuszz/git/fullmag` and task-specific Cargo output uses the managed mounted view.
- Existing unrelated dirty files remain unstaged and untouched; every commit is inspected with a separate `git diff --cached --name-only` command before committing.
- Source/unit tests, a successful API response or a TypeScript build do not establish FEM/FDM numerical equivalence; production claims require controlled runtime, convergence and provenance evidence.
- The current in-app browser bridge failure (`sandboxCwd is not a local file URI`) is recorded as environment evidence and cannot be reported as a product screenshot result.

## File and responsibility map

The following files are the intended ownership boundaries. Existing files are
modified only for the responsibility named here; unrelated dirty edits in the
same files must be preserved and merged surgically.

| Responsibility | Files |
|---|---|
| Normative scope/activation note and source map | `docs/physics/0995-physics-module-scope-and-activation.md`, `docs/physics/0995-physics-module-scope-and-activation.source-map.json` |
| Graph types and scene normalization | Create `crates/fullmag-authoring/src/physics_graph.rs`; modify `crates/fullmag-authoring/src/lib.rs`, `scene.rs`, `spin_transport.rs`, `adapters.rs`, `validation.rs`; add `crates/fullmag-authoring/tests/physics_graph_contract.rs` and JSON fixtures under `crates/fullmag-authoring/tests/fixtures/physics_graph/` |
| Canonical ProblemIR storage/migration | Modify `crates/fullmag-ir/src/model.rs`, `spin_transport.rs`, `plan.rs`, `lib.rs`; add graph fixtures/tests under `crates/fullmag-ir/tests/fixtures/physics_graph/` and `crates/fullmag-ir/tests/physics_graph_ir.rs` |
| Python public scope and round-trip | Create `packages/fullmag-py/src/fullmag/model/physics_scope.py`; modify `current_transport.py`, `spin_transport.py`, `spin_torque.py`, `energy.py`, `runtime/scene_document.py`, `model/problem.py`; add `packages/fullmag-py/tests/test_physics_scope_graph.py` |
| Planner and runtime resolution | Modify `crates/fullmag-plan/src/current_transport.rs`, `spin_transport.rs`, `spin_torque.rs`, `oersted.rs`, `regional_field_drive.rs`, `lib.rs`; add `crates/fullmag-plan/tests/physics_graph_resolution.rs`; modify lane provenance in `crates/fullmag-runner/src/native_fem/steady_transport/descriptor.rs`, `provenance.rs`, `steady_transport.rs`, `fdm/cpu/spin_transport.rs`, `solvers/fdm/interactions/*`, and `interactive_runtime/provenance.rs`; add focused runner tests |
| Resource-first API | Create `crates/fullmag-api/src/router_v2/handlers/model/physics_graph.rs`; modify `crates/fullmag-api/src/router_v2/mod.rs`, `handlers/model.rs`, `handlers/model/authoring.rs`, `schemas/authoring.rs`, `openapi_v2.rs`, and `router_v2/tests.rs` |
| Generated API and graph resource | Modify generated `apps/control-room/src/kernel/api/generated/openapi-v2.json`, `openapi-v2-types.ts`, `openapi-v2-client.ts`, `openapi-v2-paths.ts`; modify `apiPaths.ts`, `apiTypes.ts`, `ControlRoomApi.ts`; create `kernel/resources/physicsGraphResources.ts` and its tests; update invalidation maps |
| Explorer graph placement | Create `apps/control-room/src/modules/explorer/builders/physicsGraphTree.ts` and tests; modify `explorerTypes.ts`, `sceneModelTreeAdapter.ts`, `buildModelTree.ts`, `ExplorerModule.tsx`, `explorerSelection.ts`, `selectionTypes.ts`, and affected explorer tests |
| Shared inspector composition | Create `apps/control-room/src/modules/inspector/primitives/InspectorOverviewFrame.tsx`, `InspectorOverviewFrame.test.tsx`, `panels/PhysicsInspectorOverview.tsx`, `panels/PhysicsInspectorOverviewModel.ts`, and `design/styles/inspector-physics.css`; refactor `ObjectVisualizationOverview.tsx` to consume the shared frame; update transport/spin/interface/torque/Oersted/field-drive/object physics panels and registry/tests |
| Qualification and handoff evidence | Add `docs/raports/2026-08-05-physics-scope-graph-refactor/README.md`, `QUALIFICATION.md`, graph fixture manifest and captured JSON/log paths only after execution; do not put generated build trees in the repository or ordinary `/tmp` |

## Task 1: Freeze the normative semantics and graph fixtures

**Files:**

- Create: `docs/physics/0995-physics-module-scope-and-activation.md`
- Create: `docs/physics/0995-physics-module-scope-and-activation.source-map.json`
- Create: `crates/fullmag-authoring/tests/fixtures/physics_graph/empty.json`
- Create: `crates/fullmag-authoring/tests/fixtures/physics_graph/no_current.json`
- Create: `crates/fullmag-authoring/tests/fixtures/physics_graph/object_local_current_chain.json`
- Create: `crates/fullmag-authoring/tests/fixtures/physics_graph/global_field_drive.json`
- Create: `crates/fullmag-authoring/tests/fixtures/physics_graph/cross_object_interface.json`
- Create: `crates/fullmag-authoring/tests/fixtures/physics_graph/unresolved_legacy.json`
- Test: `scripts/test_physics_scope_graph_fixtures.py`

**Interfaces:**

- The physics note defines the physical distinction between authored module
  presence, explicit activation and numeric drive amplitude, and defines
  `Global`, `Object`, `Region`, `Interface`, `CrossObject`, and
  `Unresolved` in SI-aware publication language.
- The fixture JSON is a backend-neutral input/output contract. Each fixture
  contains `scene`, `expected_modules`, `expected_edges`, and
  `expected_explorer_groups`; it contains no mesh storage layout.
- The source map records the note’s Python, authoring, ProblemIR, planner,
  runtime, API and UI symbols with path-plus-symbol entries.

- [ ] **Step 1: Write the failing fixture validator.**

Require exactly these scenario IDs and assert that the no-current fixture has
an empty current module list and no active dependent module:

```python
required = {
    "empty",
    "no_current",
    "object_local_current_chain",
    "global_field_drive",
    "cross_object_interface",
    "unresolved_legacy",
}
assert {item["id"] for item in fixtures} == required
assert no_current["expected_modules"] == []
assert all(edge["status"] != "active" for edge in no_current["expected_edges"])
```

Run:

```text
python3 -m pytest -q scripts/test_physics_scope_graph_fixtures.py
```

Expected: FAIL because the fixture manifest and fixture files do not exist.

- [ ] **Step 2: Write the publication note and source map.**

The note must include: problem statement, module-presence rule, activation
state table, scope and dependency rules, `solve_domain` versus `applies_to`,
FDM cell-mask interpretation, FEM marker/interface interpretation, Python and
ProblemIR lowering, planner/runtime/provenance semantics, limits and
validation gates. Cite the existing transport/SOT/Oersted physics notes and
the authoritative authoring/runtime symbols; do not claim that this graph makes
semantic-only transport executable.

- [ ] **Step 3: Add the six fixtures.**

Use stable IDs such as `current:film`, `spin:film`, `torque:free-layer` and
stable object/region IDs. The `no_current` fixture must contain no current
transport record at all. The `object_local_current_chain` fixture must contain
one current source, one spin transport, one torque and one Oersted field with
explicit owner/target refs. The cross-object fixture must put the interface
under one cross-object branch, not under both objects. The unresolved fixture
must preserve a targetless legacy record and expose a diagnostic reason.

- [ ] **Step 4: Run the fixture validator and commit the contract.**

```text
python3 -m pytest -q scripts/test_physics_scope_graph_fixtures.py
git add docs/physics/0995-physics-module-scope-and-activation.md docs/physics/0995-physics-module-scope-and-activation.source-map.json crates/fullmag-authoring/tests/fixtures/physics_graph scripts/test_physics_scope_graph_fixtures.py
git diff --cached --name-only
git commit -m "docs: freeze physics scope graph semantics"
```

Expected: PASS, with only the listed new files staged.

## Task 2: Implement the typed Rust graph and one normalization path

**Files:**

- Create: `crates/fullmag-authoring/src/physics_graph.rs`
- Modify: `crates/fullmag-authoring/src/lib.rs`, `scene.rs`, `spin_transport.rs`, `adapters.rs`, `validation.rs`
- Test: `crates/fullmag-authoring/tests/physics_graph_contract.rs`

**Interfaces:**

Expose these public Rust types and functions from `fullmag_authoring`:

```rust
pub enum PhysicsScopeRef {
    Global,
    Object { object_id: String },
    Region { object_id: String, region_id: String },
    Interface { side_a: SceneRegionRef, side_b: SceneRegionRef },
    CrossObject { object_ids: Vec<String> },
    Unresolved { reason: String, source_path: String },
}

pub enum PhysicsActivation { Configured, Active, Inactive, Blocked, Unsupported }

pub struct PhysicsModuleIR {
    pub id: String,
    pub kind: String,
    pub applies_to: Vec<PhysicsScopeRef>,
    pub solve_domain: Vec<SceneRegionRef>,
    pub depends_on: Vec<String>,
    pub activation: PhysicsActivation,
    pub authored_state: String,
    pub capability: String,
    pub source_path: String,
    pub family_payload: serde_json::Value,
}

pub struct PhysicsEdgeIR {
    pub kind: String,
    pub source_id: String,
    pub target_id: String,
    pub status: PhysicsActivation,
}

pub struct PhysicsGraphIR {
    pub schema_version: String,
    pub scene_revision: u64,
    pub modules: Vec<PhysicsModuleIR>,
    pub edges: Vec<PhysicsEdgeIR>,
}

pub fn normalize_physics_graph(
    scene: &SceneDocument,
) -> Result<PhysicsGraphIR, PhysicsGraphError>;
```

- [ ] **Step 1: Add failing Rust contract tests.**

Add tests named `empty_scene_has_no_physics_modules`,
`zero_drive_preserves_authored_module`,
`missing_current_blocks_but_does_not_promote_spin`,
`object_scope_uses_stable_region_ids`,
`interface_is_emitted_once_as_cross_object_scope`,
`targetless_legacy_is_unresolved`, and
`reordering_family_vectors_does_not_change_module_ids`. Load the fixtures from
Task 1 and compare normalized JSON, not debug strings.

Run:

```text
cargo test -p fullmag-authoring physics_graph -- --nocapture
```

Expected: FAIL because the graph types and normalization function do not exist.

- [ ] **Step 2: Implement the graph enums, structs, errors and serde schema.**

Use tagged snake-case serde representations, reject duplicate module IDs,
reject references to missing objects/regions, and retain unknown family
payloads as JSON with `Unsupported` activation. Keep family structs unchanged
as payload owners; do not copy their constitutive equations into the graph.

- [ ] **Step 3: Implement deterministic normalization.**

Normalize current transports, spin transports, interfaces, spin torques/SOT,
Oersted fields, regional field drives and authored global external field in
that order. Emit a module only when the source record exists. Derive
`solve_domain` from transport domain refs and `applies_to` only from an
explicit target or an unambiguous contract-defined owner. Set dependent
modules to `Blocked` when a named source is absent. Preserve the original JSON
pointer in `source_path` for every unresolved/unsupported record.

- [ ] **Step 4: Route all scene-to-problem paths through normalization.**

Export `normalize_physics_graph` from `lib.rs`; call it from script import,
UI scene mutation validation and `scene_document_problem_projection` without
duplicating a second resolver. Existing scene family list endpoints continue
to serialize their family payloads for editing.

- [ ] **Step 5: Run focused tests and commit.**

```text
cargo fmt --check
cargo test -p fullmag-authoring physics_graph -- --nocapture
git add crates/fullmag-authoring/src/physics_graph.rs crates/fullmag-authoring/src/lib.rs crates/fullmag-authoring/src/scene.rs crates/fullmag-authoring/src/spin_transport.rs crates/fullmag-authoring/src/adapters.rs crates/fullmag-authoring/src/validation.rs crates/fullmag-authoring/tests/physics_graph_contract.rs
git diff --cached --name-only
git commit -m "feat(authoring): normalize physics scope graph"
```

## Task 3: Carry the graph through ProblemIR and Python round-trip

**Files:**

- Create: `packages/fullmag-py/src/fullmag/model/physics_scope.py`
- Create: `packages/fullmag-py/tests/test_physics_scope_graph.py`
- Modify: `crates/fullmag-ir/src/model.rs`, `spin_transport.rs`, `plan.rs`, `lib.rs`, `crates/fullmag-ir/tests/ir_tests.rs`
- Modify: `packages/fullmag-py/src/fullmag/model/current_transport.py`, `spin_transport.py`, `spin_torque.py`, `energy.py`, `runtime/scene_document.py`, `model/problem.py`, and public model exports

**Interfaces:**

Python exposes typed scope values and preserves them through canonical export:

```python
PhysicsScope = GlobalScope | ObjectScope | RegionScope | InterfaceScope | CrossObjectScope

@dataclass(frozen=True)
class PhysicsActivation:
    enabled: bool = True
    stages: tuple[str, ...] = ()

class CurrentTransport(...):
    applies_to: PhysicsScope | None = None
    activation: PhysicsActivation | None = None

class PrescribedSpinOrbitTorque(...):
    target: RegionRef
    current_source: str | None = None

class OerstedField(...):
    applies_to: PhysicsScope | None = None
```

The existing `domain`/`solve_region` fields remain readable and are lowered
to `solve_domain`. New canonical constructors reject missing required torque
targets and unknown object/region IDs during IR validation.

- [ ] **Step 1: Add failing Python tests.**

Test `absent_current_is_absent_from_ir`,
`zero_current_is_authored_and_round_trips`,
`object_and_region_scope_round_trip`,
`torque_target_is_required_for_new_variant`,
`legacy_targetless_record_is_preserved_as_unresolved`,
`script_export_import_preserves_graph_ids_and_edges`, and
`fem_and_fdm_requested_lanes_do_not_change_scope`. Use non-default signed
values for current, polarization, torque and Oersted parameters.

Run:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_physics_scope_graph.py
```

Expected: FAIL because typed scope classes and canonical graph lowering are
not implemented.

- [ ] **Step 2: Implement `physics_scope.py` and public exports.**

Use immutable dataclasses, explicit `to_ir()`/`from_ir()` methods and stable
ID validation. Do not make numeric drive amplitude determine object presence.

- [ ] **Step 3: Add constructor fields and lowerers.**

Add `applies_to`/`target` only where the physical family needs a target; keep
transport `domain` as the PDE solve domain. Serialize absent optional modules
as absent collections, not as default module objects. Preserve unknown legacy
records in the existing lossless scene document path and attach the graph
diagnostic during normalization.

- [ ] **Step 4: Add ProblemIR migration.**

Add a versioned graph member with a serde default/migration for old IR. Old
family arrays are normalized deterministically; new IR stores the graph and
family payloads together so canonical script export cannot lose scope or
dependency fields. Reject duplicate IDs and invalid references before planner
selection.

- [ ] **Step 5: Run Python/IR round-trip gates and commit.**

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_physics_scope_graph.py packages/fullmag-py/tests/test_current_transport.py packages/fullmag-py/tests/test_spin_drift_diffusion.py packages/fullmag-py/tests/test_prescribed_sot.py
cargo test -p fullmag-ir physics_graph -- --nocapture
git add packages/fullmag-py/src/fullmag/model/physics_scope.py packages/fullmag-py/src/fullmag/model/current_transport.py packages/fullmag-py/src/fullmag/model/spin_transport.py packages/fullmag-py/src/fullmag/model/spin_torque.py packages/fullmag-py/src/fullmag/model/energy.py packages/fullmag-py/src/fullmag/runtime/scene_document.py packages/fullmag-py/src/fullmag/model/problem.py packages/fullmag-py/tests/test_physics_scope_graph.py crates/fullmag-ir/src crates/fullmag-ir/tests/ir_tests.rs
git diff --cached --name-only
git commit -m "feat(ir): preserve physics scope in Python round-trip"
```

## Task 4: Resolve one graph into FEM/FDM planner and runtime semantics

**Files:**

- Modify: `crates/fullmag-plan/src/current_transport.rs`, `spin_transport.rs`, `spin_torque.rs`, `oersted.rs`, `regional_field_drive.rs`, `lib.rs`
- Create: `crates/fullmag-plan/tests/physics_graph_resolution.rs`
- Modify: `crates/fullmag-runner/src/native_fem/steady_transport/descriptor.rs`, `provenance.rs`, `steady_transport.rs`, `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs`, `crates/fullmag-runner/src/solvers/fdm/interactions/mod.rs`, `observables.rs`, and `interactive_runtime/provenance.rs`
- Test: focused planner/runner modules and existing transport/Oersted contracts

**Interfaces:**

Add backend-neutral resolution before lane-specific mapping:

```rust
pub struct ResolvedPhysicsModule {
    pub module_id: String,
    pub requested_execution: ExecutionRequest,
    pub resolved_execution: ExecutionResolution,
    pub status: PhysicsActivation,
    pub fem_marker_ids: Vec<u32>,
    pub fdm_cell_mask_id: Option<String>,
    pub reason: Option<String>,
}

pub fn resolve_physics_graph(
    graph: &PhysicsGraphIR,
    scene: &SceneDocument,
    lane: ExecutionLane,
) -> Result<Vec<ResolvedPhysicsModule>, PlanError>;
```

- [ ] **Step 1: Add failing planner tests.**

Cover `absent_source_emits_no_operator`,
`blocked_dependency_is_not_silently_global`,
`fem_scope_maps_to_markers`, `fdm_scope_maps_to_cell_membership`,
`cross_object_interface_maps_once`, `requested_and_resolved_lane_are_both
recorded`, and `unsupported_gpu_lane_is_explicit`. Compare graph IDs and
scope, not only operator counts.

Run:

```text
cargo test -p fullmag-plan physics_graph -- --nocapture
```

Expected: FAIL until the resolution layer exists.

- [ ] **Step 2: Implement lane-neutral dependency/status resolution.**

Use graph edges to decide whether a current, spin, torque or Oersted operator
exists. A missing source produces no dependent contribution. A blocked or
unresolved source follows the existing fail-closed/semantic-only policy and
retains its reason. Never create a global contribution as a fallback.

- [ ] **Step 3: Implement FEM mapping.**

Resolve object/region/interface refs against stable mesh entity IDs and
boundary attributes. Keep `solve_domain` markers separate from torque/field
application markers. Include graph ID, scene revision, mesh revision,
operator version, requested lane and resolved lane in the existing steady
transport provenance structures. Do not change constitutive equations or
native FEM hot loops in this task.

- [ ] **Step 4: Implement FDM mapping.**

Resolve the same refs into structured-grid object/region masks and preserve
the graph ID on spin-transport, torque and Oersted source descriptors. Do not
derive scope from array index or first matching object. Keep CPU reference and
GPU execution selection explicit.

- [ ] **Step 5: Add runtime omission/provenance tests.**

Assert that a scene with no current module does not allocate a current solve,
spin solve, STT/SOT operator or current-derived Oersted field. Assert that an
authored zero-drive module still appears in the resolved graph with its
activation status. Assert that artifacts contain graph and scene revisions.

- [ ] **Step 6: Run managed backend gates and commit.**

Run the focused Rust tests first, then use only container-backed recipes for
native verification:

```text
cargo test -p fullmag-plan physics_graph -- --nocapture
cargo test -p fullmag-runner --lib fdm::cpu::spin_transport -- --nocapture
just verify-spin-transport-authoring-parameter-parity
just verify-fem-time-domain-native-contract
just verify-fem-steady-transport-m2-common-limit-contract
just verify-fem-oersted-observable-contract
```

Use task-specific managed Cargo targets below `/zfn2/mateuszz/git/fullmag`
through the existing recipe rather than a host-first FEM build. Commit only
after the managed gate reports the exact graph/provenance assertions.

## Task 5: Add the resource-first physics-graph API and generated client surface

**Files:**

- Create: `crates/fullmag-api/src/router_v2/handlers/model/physics_graph.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model.rs`, `handlers/model/authoring.rs`, `router_v2/mod.rs`, `schemas/authoring.rs`, `openapi_v2.rs`, `router_v2/tests.rs`
- Modify/generated: `apps/control-room/src/kernel/api/apiPaths.ts`, `apiTypes.ts`, `ControlRoomApi.ts`, `generated/openapi-v2.json`, `generated/openapi-v2-types.ts`, `generated/openapi-v2-client.ts`, `generated/openapi-v2-paths.ts`
- Create: `apps/control-room/src/kernel/resources/physicsGraphResources.ts`, `physicsGraphResources.test.ts`
- Modify: `apps/control-room/src/kernel/resources/ResourceInvalidationController.ts`, `resourceTypes.ts`, and resource invalidation tests

**Interfaces:**

Expose a read-only semantic resource:

```text
GET /v2/sessions/current/model/physics-graph
```

with a typed response equivalent to:

```json
{
  "scene_revision": 42,
  "schema_version": "physics_graph.v1",
  "modules": [{
    "id": "torque:free-layer",
    "kind": "spin_torque",
    "applies_to": [{"kind": "region", "object_id": "film", "region_id": "free"}],
    "solve_domain": [],
    "depends_on": ["current:film"],
    "activation": "blocked",
    "capability": "semantic_only",
    "source_path": "/spin_torques/0"
  }],
  "edges": [{"kind": "source", "source_id": "current:film", "target_id": "torque:free-layer", "status": "blocked"}],
  "provenance": {"normalizer": "physics_graph.v1"}
}
```

- [ ] **Step 1: Add failing API contract tests.**

Add tests for empty scene, no-current scene, object-local chain, global drive,
cross-object interface and unresolved legacy record. Assert the response is
thin, has scene/schema revisions, has no topology/field payload, and preserves
stable IDs and source paths.

Run:

```text
cargo test -p fullmag-api router_v2::tests::physics_graph -- --nocapture
```

Expected: FAIL because the route/schema/handler do not exist.

- [ ] **Step 2: Implement the Rust resource schema and handler.**

Load the current scene, call the single authoring normalizer, map graph types
to `ToSchema` response types without exposing raw family arrays as the tree
contract, and return the scene revision. Do not put field samples, meshes or
large numeric arrays in this response.

- [ ] **Step 3: Register the route and revision invalidation.**

Register the route in `build_v2_router`, include it in utoipa OpenAPI, and make
all current/spin/interface/torque/Oersted/field-drive/study mutations invalidate
the graph key atomically with the scene revision. Re-read-after-mutation must
never combine resources from different revisions.

- [ ] **Step 4: Generate and consume the frontend API.**

Run from the repository root:

```text
pnpm --dir apps/control-room generate:api
```

Add `api.model.physicsGraph()` and a `usePhysicsGraphResource()` hook using
`useResource`, a stable resource key, abortable loading and scene-revision
resolution. Add generated contract assertions to the existing API hygiene
tests.

- [ ] **Step 5: Run API/frontend contract tests and commit.**

```text
cargo test -p fullmag-api router_v2::tests::physics_graph -- --nocapture
pnpm --dir apps/control-room test -- src/kernel/resources/physicsGraphResources.test.ts src/kernel/api/openapiV2GeneratedContract.test.ts
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room typecheck
git add crates/fullmag-api/src/router_v2/handlers/model/physics_graph.rs crates/fullmag-api/src/router_v2/handlers/model.rs crates/fullmag-api/src/router_v2/handlers/model/authoring.rs crates/fullmag-api/src/router_v2/mod.rs crates/fullmag-api/src/schemas/authoring.rs crates/fullmag-api/src/openapi_v2.rs crates/fullmag-api/src/router_v2/tests.rs apps/control-room/src/kernel/api apps/control-room/src/kernel/resources/physicsGraphResources.ts apps/control-room/src/kernel/resources/physicsGraphResources.test.ts apps/control-room/src/kernel/resources/ResourceInvalidationController.ts apps/control-room/src/kernel/resources/resourceTypes.ts
git diff --cached --name-only
git commit -m "feat(api): expose normalized physics graph resource"
```

## Task 6: Replace Explorer family roots with graph-driven placement

**Files:**

- Create: `apps/control-room/src/modules/explorer/builders/physicsGraphTree.ts`
- Create: `apps/control-room/src/modules/explorer/builders/physicsGraphTree.test.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerTypes.ts`, `builders/sceneModelTreeAdapter.ts`, `builders/buildModelTree.ts`, `ExplorerModule.tsx`, `explorerSelection.ts`, `apps/control-room/src/kernel/selection/selectionTypes.ts`, and existing Explorer tests

**Interfaces:**

Use a graph-only placement input:

```ts
export interface PhysicsGraphTreeSnapshot {
  sceneRevision: number;
  modules: readonly PhysicsGraphModule[];
  edges: readonly PhysicsGraphEdge[];
}

export function buildPhysicsGraphTree(
  snapshot: PhysicsGraphTreeSnapshot,
): readonly ExplorerNode[];
```

- [ ] **Step 1: Add failing tree/resolver tests.**

Test `empty_scene_has_no_physics_roots`,
`no_current_has_no_active_spin_nodes`,
`object_local_chain_is_nested_under_object_physics`,
`global_drive_is_nested_under_global_physics`,
`interface_is_emitted_once_under_cross_object_physics`,
`blocked_and_unsupported_records_are_collapsed_diagnostics`, and
`reordering_modules_preserves_node_ids`. Use graph fixtures and do not pass
family-list indexes into the resolver.

Run:

```text
pnpm --dir apps/control-room test -- src/modules/explorer/builders/physicsGraphTree.test.ts
```

Expected: FAIL because the graph-driven resolver does not exist.

- [ ] **Step 2: Implement `buildPhysicsGraphTree`.**

Group only modules with semantic children. Create `Global Physics` only when
global/cross-object/diagnostic children exist; create object `Physics` only
when an object/region module exists. Use stable IDs in the form
`physics-graph:<module-id>:<scope-key>`. Put interfaces and multi-object
modules once in `Cross-object Physics` and attach linked object/region refs.

- [ ] **Step 3: Adapt the scene tree and module loading.**

Load the graph resource in `ExplorerModule` for the model tab. Keep family
resources available to inspectors/edit forms, but stop using their list order
or non-empty status to place Explorer nodes. Preserve mesh/study/results tree
branches and existing object child ordering.

- [ ] **Step 4: Update selection and inspector descriptors.**

Extend selection refs with graph module ID and scope key. Selection must
survive resource reordering and resolve a graph node directly. Add explicit
global/object/region/interface descriptors; do not reuse a generic child
selection variant for distinct physics entities.

- [ ] **Step 5: Run Explorer tests and commit.**

```text
pnpm --dir apps/control-room test -- src/modules/explorer/builders/physicsGraphTree.test.ts src/modules/explorer/builders/buildModelTree.test.ts src/modules/explorer/explorerSelection.test.ts
pnpm --dir apps/control-room typecheck
git add apps/control-room/src/modules/explorer apps/control-room/src/kernel/selection/selectionTypes.ts
git diff --cached --name-only
git commit -m "feat(explorer): place physics from canonical graph"
```

## Task 7: Migrate physics inspectors to the Visualization composition

**Files:**

- Create: `apps/control-room/src/modules/inspector/primitives/InspectorOverviewFrame.tsx`
- Create: `apps/control-room/src/modules/inspector/primitives/InspectorOverviewFrame.test.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/PhysicsInspectorOverview.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/PhysicsInspectorOverviewModel.ts`
- Create: `apps/control-room/src/design/styles/inspector-physics.css`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.tsx`, `ObjectVisualizationOverview.test.tsx`, `inspectorDesignSystemContract.test.ts`, `inspectorCssContract.test.ts`
- Modify: `TransportAuthoringInspector.tsx`, `SpinAuthoringInspector.tsx`, `SpinInterfaceInspector.tsx`, `PhysicsInteractionPanel.tsx`, `RegionalFieldDrivePanel.tsx`, `inspectorRegistry.tsx`, and their model/DOM tests

**Interfaces:**

The shared frame accepts semantic metrics and sections, not backend-specific
controls:

```tsx
<InspectorOverviewFrame
  className="fm-physics-inspector-overview"
  metrics={metrics}
  primary={primarySection}
  sections={[
    scopeSection,
    driveSection,
    dependencySection,
    solverSection,
    diagnosticsSection,
  ]}
  actions={<InspectorEditSessionActions ... />}
/>
```

`PhysicsInspectorOverviewModel` must expose scope kind, stable refs, source
status, requested/resolved lane, capability, graph/scene revisions, SI display
values and a typed draft mutation callback. It must not expose canvas or
visualization rendering state.

- [ ] **Step 1: Add failing composition/design tests.**

Assert that the shared frame renders the same four-metric strip, bordered
primary card, navigation groups, tokens and action bar as
`ObjectVisualizationOverview`. Assert all classes are `fm-*`, controls come
from shared primitives, and the physics overview contains Scope, Drive,
Dependency, Solver/Execution and Diagnostics sections.

Run:

```text
pnpm --dir apps/control-room test -- src/modules/inspector/primitives/InspectorOverviewFrame.test.tsx src/modules/inspector/inspectorDesignSystemContract.test.ts src/modules/inspector/inspectorCssContract.test.ts
```

Expected: FAIL because the shared frame and physics overview do not exist.

- [ ] **Step 2: Extract the Visualization layout without changing its semantics.**

Move only the repeated responsive/card/nav shell from
`ObjectVisualizationOverview.tsx` into `InspectorOverviewFrame.tsx`. Keep
visualization-specific fields, display controls and viewport actions in the
Visualization panel. The existing Visualization tests must remain green.

- [ ] **Step 3: Implement the physics overview model and component.**

Render `Global`, `Object`, `Region`, `Interface` and `Cross-object` scopes
with stable refs. Show absent modules as absent selection, not as an empty
form. Show `Blocked`, `Inactive`, `Unsupported` and `Unresolved` with their
diagnostic reason and source path. Use shared `FormField`, `Vector3Field`,
`SegmentedControl`, `Switch`, `Slider` and `InspectorEditSession` only where
the family payload supports the control.

- [ ] **Step 4: Migrate all relevant panels and registry entries.**

Migrate current transport, spin transport, spin interface, STT/SOT, Oersted,
regional field drive and object/global physics panels to the same frame. Keep
editing payloads family-specific, but source scope/dependency/status from the
graph resource. Add graph-ID and scope-aware inspector descriptors for every
Explorer node kind.

- [ ] **Step 5: Add responsive DOM and accessibility tests.**

Cover narrow and wide containers, keyboard navigation of nav rows, disabled
actions for unsupported/unresolved records, scope labels, SI units, and
revision/diagnostic banners. Ensure no inspector makes a direct API call.

- [ ] **Step 6: Run UI verification and commit.**

```text
pnpm --dir apps/control-room test -- src/modules/inspector/panels/ObjectVisualizationOverview.test.tsx src/modules/inspector/primitives/InspectorOverviewFrame.test.tsx src/modules/inspector/panels/PhysicsInspectorOverviewModel.test.ts src/modules/inspector/panels/PhysicsInspectorOverview.dom.test.tsx src/modules/inspector/inspectorRegistry.test.tsx
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room check:architecture-hygiene
git add apps/control-room/src/modules/inspector apps/control-room/src/design/styles/inspector-physics.css
git diff --cached --name-only
git commit -m "feat(inspector): align physics panels with visualization template"
```

## Task 8: End-to-end qualification, browser evidence and documentation handoff

**Files:**

- Create: `docs/raports/2026-08-05-physics-scope-graph-refactor/README.md`
- Create: `docs/raports/2026-08-05-physics-scope-graph-refactor/QUALIFICATION.md`
- Create only as captured evidence: `docs/raports/2026-08-05-physics-scope-graph-refactor/fixtures/` and `artifacts/`
- Test/verification scripts: use existing managed recipes and add a focused `scripts/verify_physics_scope_graph_runtime.py` only if the existing report validators cannot compare graph IDs, scope and dependency omission.

**Interfaces:**

The qualification report records, for every scenario, the exact Python input,
scene revision, graph JSON digest, requested/resolved lane, runtime artifact
digest, Explorer node IDs, inspector screenshot path and pass/fail reason.

- [ ] **Step 1: Run all local semantic gates.**

```text
cargo fmt --check
cargo test -p fullmag-authoring physics_graph -- --nocapture
cargo test -p fullmag-ir physics_graph -- --nocapture
cargo test -p fullmag-plan physics_graph -- --nocapture
cargo test -p fullmag-api router_v2::tests::physics_graph -- --nocapture
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_physics_scope_graph.py
pnpm --dir apps/control-room test -- src/modules/explorer/builders/physicsGraphTree.test.ts src/modules/inspector/primitives/InspectorOverviewFrame.test.tsx
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room check:architecture-hygiene
```

- [ ] **Step 2: Run controlled FEM/FDM runtime checks.**

Use the matching container-backed recipes from `justfile`, including the
steady transport common-limit, Oersted observable and time-domain STT gates.
For any new graph-specific recipe, build below the managed `/zfn2` storage
root and record the exact recipe, container image, source snapshot, runtime
manifest and output directory. Verify separately:

1. no-current scene has no current/spin/torque/Oersted contribution;
2. zero-drive authored module is present but follows explicit activation;
3. object-local chain maps to one object/region in FEM and FDM;
4. global field drive maps to the global branch in both lanes;
5. cross-object interface appears once and preserves both sides;
6. unresolved/unsupported records do not execute silently;
7. requested and resolved execution plus graph revision are in provenance.

- [ ] **Step 3: Run browser/UI proof.**

Start/reuse the Control Room dev server without killing a process owned by
another task. Use the browser smoke/Playwright route that matches the app’s
existing scripts. Capture wide and narrow Explorer/Inspector screenshots and
assert the no-current scene contains no transport roots. If the in-app browser
bridge again emits `sandboxCwd is not a local file URI`, retain the exact
error in the report and mark browser proof blocked; do not substitute the
attached static screenshot for live evidence.

- [ ] **Step 4: Write the qualification report and final status.**

The report must separate source/test proof, API proof, planner proof, executed
FEM/FDM runtime proof, browser proof, and scientific qualification. A green UI
test does not upgrade a semantic-only solver capability. List remaining
blockers and the exact next gate.

- [ ] **Step 5: Run the final repository checks and commit documentation.**

```text
git diff --check
git status --short
git add docs/raports/2026-08-05-physics-scope-graph-refactor
git diff --cached --name-only
git commit -m "docs: record physics graph qualification evidence"
```

## Completion criteria

The refactor is complete only when all of these are true:

1. A scene with no authored current module produces no current-source graph
   node and no active dependent STT/SOT/SHE/Oersted node in either FEM or FDM.
2. An authored zero-drive module remains distinguishable from absence.
3. Every displayed object/global/interface physics node has an explicit graph
   scope and stable ID; no node is placed from list order or selection.
4. Python import/export, ProblemIR, authoring scene, API graph resource,
   planner resolution and runtime provenance agree on module IDs, scope,
   dependency state and revisions.
5. FEM and FDM use the same graph and produce lane-specific marker/mask
   provenance without duplicating public physics semantics.
6. Physics inspectors visibly use the Visualization composition and shared
   controls/action bar with responsive and accessibility tests.
7. Managed runtime and browser evidence are reported separately from source
   tests, and no unsupported lane is promoted by this UI refactor.

## Self-review against the accepted design

- Design sections 1–5 are covered by Tasks 1–3: presence/activation,
  scope/domain separation, typed graph, dependency edges and migration.
- Design section 6 is covered by Tasks 1–3: family normalization for current,
  spin, interfaces, torque/SOT, Oersted and field drives.
- Design section 7 is covered by Task 3: typed Python constructors,
  ProblemIR migration and round-trip/negative tests.
- Design section 8 is covered by Task 5: Rust resource, OpenAPI generation,
  typed facade, hook and revision invalidation.
- Design section 9 is covered by Task 4: FEM markers, FDM masks,
  requested/resolved execution and provenance.
- Design section 10 is covered by Task 6: graph-only Explorer placement,
  stable IDs, diagnostics and empty-branch suppression.
- Design section 11 is covered by Task 7: Visualization-template frame,
  scope/dependency/solver/diagnostic sections and shared action bar.
- Design sections 12–15 are covered by Task 8 and the explicit completion
  criteria; unresolved legacy semantics remain fail-closed until qualified.

The plan contains no placeholder implementation steps: each code task names
the owner files, public interfaces, negative cases, focused command and commit
boundary. The next decision is execution mode, not a physics redesign.
