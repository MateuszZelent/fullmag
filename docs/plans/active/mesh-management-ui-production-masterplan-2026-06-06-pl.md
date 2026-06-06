# Mesh Management UI Production Masterplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Doprowadzic Control Room do produkcyjnego zarzadzania meshem: uzytkownik widzi intent, draft, current mesh, realized output, log, postep, jakosc, provenance i potwierdzenie, ze backend oraz viewport pracuja na tej samej rewizji.

**Architecture:** Zachowujemy resource-first v2 API. Mesh authoring idzie przez `model/*` i `meshing/policies/*`; rebuild idzie wylacznie przez `POST /v2/sessions/current/simulation/commands` z `kind: "mesh_build"`; status, raporty, jakosc, manifest, log i viewport confirmation sa oddzielnymi zasobami. UI sklada jeden workflow w unified workspace: Explorer/Inspector dla intentu, command registry dla akcji, bottom dock dla dlugich jobow, overlay tylko dla szybkiego potwierdzenia.

**Tech Stack:** `apps/control-room` Next/React/TypeScript, shared shadcn-style primitives, Catppuccin `--fm-*` tokens, `ControlRoomApi`, resource hooks, realtime invalidation bridge, Rust `crates/fullmag-api` OpenAPI v2 schemas/routes, existing meshing resources.

---

## 0. Source Documents Folded Into This Plan

This plan supersedes these draft documents for implementation ordering and contract details:

- `docs/plans/active/mesh-build-ui-overhaul-masterplan-2026-06-06-pl.md`
- `docs/plans/active/mesh-build-ui-dialog-redesign-2026-06-06-pl.md`
- `docs/plans/active/mesh-build-ui-lifecycle-e2e-2026-06-06-pl.md`

Important corrections applied here:

1. The object policy endpoint is `/v2/sessions/current/meshing/policies/objects/{object_id}`, not `/meshing/objects/{id}/policy`.
2. The universe/airbox policy endpoint is `/v2/sessions/current/meshing/policies/universe`.
3. Mesh rebuild commands remain under `/v2/sessions/current/simulation/commands`; do not add `/meshing/builds/commands`.
4. Airbox is part of the shared-domain mesh. Airbox policy rebuild must submit `mesh_target: { kind: "study_domain" }`, not an object mesh target.
5. Long mesh builds must not trap the user in a blocking modal. Use a persistent bottom-dock build detail surface; use an overlay only for confirmation and immediate command feedback.
6. `resource.batch_changed` remains invalidation only. It must not carry heavy topology, field, or full log payloads.

## 1. Product Definition

Production mesh management in Control Room means the user can do all of this without reading a terminal:

1. See whether the current scene has no mesh, stale mesh, active build, failed build, or current mesh.
2. Edit universe/airbox, shared-domain, object, and later region mesh policy with visible dirty state.
3. Compare `current policy`, `draft policy`, `last realized policy`, and `new output`.
4. Apply policy safely before build. Build never silently uses stale draft values.
5. Submit object or shared-domain mesh build through the command registry.
6. Watch a stable build pipeline with all canonical phases, even when a backend phase has not started.
7. See the full engine/Gmsh log with filtering, search, copy, and no hard 8-line limit.
8. See post-build mesh statistics, quality gates, size-field realization, artifacts, and provenance.
9. See explicit confirmation that new mesh resources were published and that the viewport rendered the matching mesh revision.
10. Run solver only when the mesh is current for the scene revision, with actionable disabled reasons.

## 2. Non-Negotiable Contracts

- HTTP v2 resources are the source of truth. Websocket events invalidate resources only.
- Generated OpenAPI v2 transport remains low-level; UI semantics live in `ControlRoomApi`, resource hooks, domain models, and components.
- React components do not call `fetch()` directly and do not build raw `/v2/...` strings.
- Build commands go through command registry entries and `simulation/commands`.
- Topology rebuild is separate from field-buffer update. Mesh policy editing must not dirty the 3D renderer until mesh resources publish a new revision.
- FDM and FEM must stay in one workspace tree. FDM mesh management may show grid/discretization readiness, but this plan's production build pipeline targets FEM shared-domain/object meshing first.
- Every mesh state label must distinguish requested intent from resolved backend reality.
- Every new CSS class in `apps/control-room` uses `fm-` prefix and `--fm-*` tokens.

## 3. Target UX Architecture

### 3.1 User Surfaces

| Surface | Slot | Responsibility |
|---|---|---|
| Explorer mesh badges | `panel-left` | Immediate state: not built, stale, building, failed, current. |
| Object Mesh Policy inspector | `panel-right` | Object policy draft, dirty banner, current/draft/realized diff, apply/build actions. |
| Airbox Mesh Policy inspector | `panel-right` | Universe/airbox draft, dirty banner, current/draft/realized diff, shared-domain rebuild actions. |
| Mesh Details inspector | `panel-right` | Mesh overview, current build, latest success, history, quality, realized size fields, diagnostics. |
| Mesh Build overlay | `overlay` | Short pre-build confirmation and immediate command acceptance/failure. |
| Mesh Jobs dock | `panel-bottom` | Persistent active/history build monitor, full log, pipeline, output, viewport confirmation. |
| Viewport overlay/toast | `viewport-main` | Brief nonblocking confirmation that topology revision rendered. |
| Status bar | `status-bar` | Mesh revision/build revision summary and stale/current state. |

### 3.2 Resolved Design Decisions

| Question | Decision |
|---|---|
| Auto-apply before build | Default behavior. If draft is dirty, `Build` becomes `Apply & Build` and applies policy first. No checkbox. |
| Dialog vs panel | Short confirmation overlay plus persistent bottom-dock build detail. Long-running build monitoring belongs in the dock. |
| Backend enrichments timing | Required for production gate. Frontend may render fallback pending phases during transition, but "production complete" requires typed backend fields. |
| MeshDetailsPanel split | Do after contract/model extraction. Split only by real responsibility, not as first task. |
| Airbox rebuild target | `study_domain`, because airbox is part of shared-domain mesh. |
| Viewport confirmation | Explicit client-side acknowledgement for rendered mesh revision, stored as bounded diagnostic resource or event-backed cache. |

## 4. Resource And Command Inventory

### 4.1 Existing Resources To Keep

| Resource | Owner | UI use |
|---|---|---|
| `sessions/current/status` | status | Revision pointers, capabilities, stale/current gating. |
| `model/scene` | model | Scene revision, objects, stale tags, selected object derivation. |
| `meshing/policies/universe` | meshing | Universe/airbox policy current/effective state. |
| `meshing/policies/objects/{object_id}` | meshing | Object mesh policy current/effective state. |
| `meshing/policies/shared-domain` | meshing | Shared-domain defaults. |
| `meshing/builds/current` | meshing | Active build state, phases, resolved target, provenance. |
| `meshing/builds/latest-successful` | meshing | Last successful output and completion signal. |
| `meshing/builds` | meshing | Build history. |
| `meshing/summary` | meshing | Lightweight dashboard counts, effective airbox/object targets. |
| `meshing/semantics` | meshing | Three-layer mesh semantics and diagnostics. |
| `meshing/meshes/shared-domain/manifest` | meshing | Solver mesh identity, mesh parts, airbox part, object segments. |
| `meshing/meshes/shared-domain/quality` | meshing | Aggregate quality. |
| `meshing/meshes/shared-domain/quality/per-element` | meshing/data-plane | Binary quality payload for heatmaps. |
| `meshing/meshes/shared-domain/realized-size-fields` | meshing | Realized size-field diagnostics. |
| `meshing/meshes/universe/report` | meshing | Airbox/universe report. |
| `meshing/meshes/universe/quality` | meshing | Airbox quality scope. |
| `meshing/meshes/objects/{object_id}/topology` | meshing/data-plane | Object scoped topology when available. |
| `meshing/meshes/objects/{object_id}/report` | meshing | Object report. |
| `meshing/meshes/objects/{object_id}/quality` | meshing | Object quality. |
| `meshing/meshes/objects/{object_id}/size-field` | meshing | Object realized size-field. |
| `diagnostics/engine-log` | diagnostics | Full engine/Gmsh log. |
| `visualization/state` | visualization | View state and target registry. |
| `visualization/client-acks` | visualization | Existing precedent for client-side render acknowledgements. |

### 4.2 Commands

Keep existing command ids where possible:

- `mesh.build-selected`: selected object mesh build. Submits:

```json
{
  "kind": "mesh_build",
  "mesh_target": { "kind": "object_mesh", "object_id": "object-id" },
  "mesh_reason": "selected-object"
}
```

- `mesh.build-shared-domain`: full shared-domain build. Submits:

```json
{
  "kind": "mesh_build",
  "mesh_target": { "kind": "study_domain" },
  "mesh_reason": "shared-domain"
}
```

Add command aliases only if they improve UI semantics:

- `mesh.build-airbox-context`: command registry contribution that calls `mesh.build-shared-domain` with `mesh_reason: "airbox-policy-edited"`.
- `mesh.open-build-jobs`: focuses bottom dock mesh jobs surface.

Do not add transport endpoints for these aliases.

## 5. Data Models To Add

Create frontend models first with tests, then map backend typed fields into them.

### 5.1 Shared Frontend Model Files

Create:

- `apps/control-room/src/shared/domain/mesh/meshPolicyDiff.ts`
- `apps/control-room/src/shared/domain/mesh/meshBuildPhases.ts`
- `apps/control-room/src/shared/domain/mesh/meshBuildSnapshots.ts`
- `apps/control-room/src/shared/domain/mesh/meshBuildFreshness.ts`

Responsibilities:

- `meshPolicyDiff.ts`: compare stored policy, draft policy, and last realized policy.
- `meshBuildPhases.ts`: canonical phase list and normalization of backend phases.
- `meshBuildSnapshots.ts`: flatten mesh summary, quality, manifest, build report into stable UI rows.
- `meshBuildFreshness.ts`: decide `not-built | stale | building | failed | current | unknown` from scene revision, mesh revision, build revision, manifest provenance, and active build state.

### 5.2 Backend Schema Fields

Modify `crates/fullmag-api/src/schemas/mesh.rs` and `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs` so `MeshActiveBuildResource` can expose:

```json
{
  "build_id": "mesh-build-uuid",
  "command_id": "cmd-uuid",
  "target": { "kind": "study_domain" },
  "status": "queued|running|completed|failed|cancelled",
  "source_scene_revision": 12,
  "geometry_realization_revision": 4,
  "requested_policy_revision": 8,
  "resolved_policy": {
    "universe": {},
    "shared_domain": {},
    "objects": {}
  },
  "policy_diff": [
    {
      "scope": "airbox",
      "path": "airbox_hmax",
      "previous": 2e-8,
      "requested": 1e-8,
      "realized": 1e-8,
      "effect": "far_field_element_size"
    }
  ],
  "published_resources": {
    "mesh_revision": 42,
    "mesh_build_revision": 57,
    "manifest": "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
    "quality": "/v2/sessions/current/meshing/meshes/shared-domain/quality",
    "realized_size_fields": "/v2/sessions/current/meshing/meshes/shared-domain/realized-size-fields"
  }
}
```

Use typed structs, not raw `Value`, for new stable fields. Existing raw projections may remain transitional.

## 6. Implementation Plan

### Phase 0: Contract Lock And Baseline Tests

**Goal:** Freeze the target contract before UI churn.

**Files:**

- Modify: `docs/specs/resource-first-control-room-api-v2.md`
- Modify: `docs/specs/frontend-v2/24-geometry-object-authoring-lifecycle.md`
- Test/read: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`
- Test/read: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`

- [ ] Step 0.1: Update the API spec with production mesh management wording.

Add one subsection under meshing resources:

```markdown
### Production mesh build management

Mesh build management distinguishes policy intent, accepted command, active build, latest successful build, and rendered viewport revision. Policy resources store requested authoring intent. Build resources expose resolved execution reality and published mesh revisions. Viewport acknowledgements are diagnostics and must not become the source of mesh truth.
```

- [ ] Step 0.2: Add a short lifecycle invariant to `24-geometry-object-authoring-lifecycle.md`.

```markdown
The Build button must never submit a mesh build using an unapplied inspector draft. If a mesh-affecting draft is dirty, the command label becomes Apply & Build and the command first commits the policy resource. Failure to commit the policy blocks the build.
```

- [ ] Step 0.3: Run spec-only grep checks.

Run:

```bash
rg "/meshing/objects|/meshing/builds/commands|SSE" docs/plans/active/mesh-build-ui-*.md docs/specs/resource-first-control-room-api-v2.md docs/specs/frontend-v2/24-geometry-object-authoring-lifecycle.md
```

Expected:

- Source draft docs may still contain old text.
- Updated authoritative docs must not introduce `/meshing/objects/{id}/policy`.
- Use "websocket/realtime invalidation", not SSE, unless backend actually exposes SSE.

### Phase 1: Frontend Domain Models

**Goal:** Make policy diff, phase normalization, freshness, and snapshot rows testable outside React.

**Files:**

- Create: `apps/control-room/src/shared/domain/mesh/meshPolicyDiff.ts`
- Create: `apps/control-room/src/shared/domain/mesh/meshPolicyDiff.test.ts`
- Create: `apps/control-room/src/shared/domain/mesh/meshBuildPhases.ts`
- Create: `apps/control-room/src/shared/domain/mesh/meshBuildPhases.test.ts`
- Create: `apps/control-room/src/shared/domain/mesh/meshBuildFreshness.ts`
- Create: `apps/control-room/src/shared/domain/mesh/meshBuildFreshness.test.ts`
- Create: `apps/control-room/src/shared/domain/mesh/meshBuildSnapshots.ts`
- Create: `apps/control-room/src/shared/domain/mesh/meshBuildSnapshots.test.ts`

- [ ] Step 1.1: Implement `meshBuildPhases.ts`.

Canonical phases:

```typescript
export const CANONICAL_MESH_BUILD_PHASES = [
  { id: "queued", label: "Queued" },
  { id: "scene_snapshot", label: "Scene Snapshot" },
  { id: "geometry_realization", label: "Geometry Realization" },
  { id: "policy_resolution", label: "Policy Resolution" },
  { id: "size_field_planning", label: "Size Field Planning" },
  { id: "gmsh_meshing", label: "Gmsh Meshing" },
  { id: "mesh_extraction", label: "Mesh Extraction" },
  { id: "quality_analysis", label: "Quality Analysis" },
  { id: "resource_publish", label: "Resource Publish" },
  { id: "viewport_delivery", label: "Viewport Delivery" },
] as const;
```

Rules:

- Unknown backend phase ids are appended after canonical phases.
- Missing canonical phases render as `pending`.
- Terminal status is `completed`, `failed`, `cancelled`, or `unknown`.
- Active status is any of `active`, `building`, `generating`, `pending`, `queued`, `running`, `started` only when phase order implies work has started.

- [ ] Step 1.2: Implement `meshPolicyDiff.ts`.

Policy diff rows must support:

```typescript
export interface MeshPolicyDiffRow {
  scope: "airbox" | "shared-domain" | "object" | "region";
  label: string;
  path: string;
  currentValue: string;
  draftValue: string;
  realizedValue: string;
  state: "unchanged" | "changed" | "added" | "removed" | "realized-drift";
  impact: "resolution" | "quality" | "cost" | "geometry" | "backend" | "unknown";
}
```

Normalize numeric strings before comparison so `1e-8`, `0.00000001`, and `10e-9` compare equal.

- [ ] Step 1.3: Implement `meshBuildFreshness.ts`.

Freshness states:

```typescript
export type MeshFreshnessState =
  | "not-built"
  | "current"
  | "stale"
  | "building"
  | "failed"
  | "unknown";
```

Rules:

- `building` wins when active build phase/status is active.
- `failed` wins when latest build failed and there is no newer successful mesh for current scene.
- `not-built` when `mesh_revision <= 0` or manifest is absent.
- `current` when manifest `source_scene_revision === status.resources.scene_revision`.
- `stale` when manifest source scene revision is older than scene revision.
- `unknown` when provenance is missing and the repo cannot prove currentness.

- [ ] Step 1.4: Run focused model tests.

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/shared/domain/mesh
```

Expected: all new domain tests pass.

### Phase 2: Policy Dirty State And Apply-Build Safety

**Goal:** Build never uses stale inspector draft values.

**Files:**

- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/AirboxMeshPolicyPanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/AirboxMeshPolicyPanelModel.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/AirboxMeshPolicyPanel.tsx`

- [ ] Step 2.1: Add dirty-state helpers in both panel models.

Required exported functions:

```typescript
export function objectMeshPolicyDraftDirty(
  draft: ObjectMeshPolicyDraft,
  baseDraft: ObjectMeshPolicyDraft,
): boolean;

export function airboxMeshPolicyDraftDirty(
  draft: AirboxMeshPolicyDraft,
  baseDraft: AirboxMeshPolicyDraft,
): boolean;
```

They must ignore JSON formatting differences and numeric string formatting differences.

- [ ] Step 2.2: Change object build behavior.

In `ObjectMeshPolicyPanel.tsx`, replace direct build behavior with:

```typescript
async function applyPolicyForBuild(): Promise<boolean> {
  const result = await applyPolicy({ silentSuccess: true });
  return result.ok;
}

async function buildMesh(): Promise<void> {
  if (!objectId) {
    setFeedback({ kind: "error", message: "No selected scene object." });
    return;
  }
  if (isDirty) {
    const applied = await applyPolicyForBuild();
    if (!applied) return;
  }
  setFeedback({
    kind: "success",
    message: "Mesh rebuild submitted. The Mesh Build monitor will track the command.",
  });
  await commands.execute("mesh.build-selected", commandContext);
}
```

The exact implementation may differ, but the observable behavior must match.

- [ ] Step 2.3: Add airbox build actions.

In `AirboxMeshPolicyPanel.tsx`, add:

- `Apply Policy`
- `Apply & Build Shared-Domain Mesh`
- `Build Shared-Domain Mesh`
- `Revert`

Rules:

- `Apply & Build` commits universe policy first, then executes `mesh.build-shared-domain`.
- `Build Shared-Domain Mesh` without dirty draft executes `mesh.build-shared-domain`.
- If dirty draft exists and user clicks plain build, the label must read `Apply & Build Shared-Domain Mesh`.

- [ ] Step 2.4: Update copy.

After policy-only apply:

```text
Policy saved. Current solver mesh is stale until a shared-domain mesh build completes.
```

After apply-and-build:

```text
Policy saved. Shared-domain mesh build submitted.
```

- [ ] Step 2.5: Run targeted tests.

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/ObjectMeshPolicyPanelModel.test.ts src/modules/inspector/panels/AirboxMeshPolicyPanelModel.test.ts
```

Expected: dirty-state and apply/build behavior tests pass.

### Phase 3: Command Registry And Mesh Jobs Surface

**Goal:** Move long-running build management into a persistent bottom-dock surface.

**Files:**

- Create: `apps/control-room/src/modules/footer/MeshJobsPanel.tsx`
- Create: `apps/control-room/src/modules/footer/MeshJobsPanel.test.tsx`
- Create: `apps/control-room/src/modules/footer/meshJobsModel.ts`
- Create: `apps/control-room/src/modules/footer/meshJobsModel.test.ts`
- Modify: `apps/control-room/src/modules/footer/FooterModule.tsx`
- Modify: `apps/control-room/src/kernel/events/eventTypes.ts`
- Modify: `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts`
- Modify: `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`

- [ ] Step 3.1: Add mesh job event types.

Add events:

```typescript
"mesh:build-submitted": {
  commandId: string;
  targetKind: "object_mesh" | "study_domain";
  objectId?: string;
  reason: string;
};
"mesh:build-resource-published": {
  meshRevision: number | string;
  meshBuildRevision: number | string;
};
"mesh:topology-rendered": {
  meshRevision: number | string;
  rendererId: string;
};
```

- [ ] Step 3.2: Emit build submitted events from command contributions.

When `mesh.build-selected` or `mesh.build-shared-domain` is accepted, emit `mesh:build-submitted` and focus/open the bottom panel.

- [ ] Step 3.3: Add footer tab.

`FooterModule.tsx` currently owns bottom dock tabs. Add a `mesh` or `jobs` tab whose content is `MeshJobsPanel`.

The panel reads only resource hooks and event bus state; it must not import inspector or viewport internals.

- [ ] Step 3.4: MeshJobsPanel required sections.

Sections:

1. Active build summary.
2. Pipeline stepper.
3. Full log console.
4. Published output summary.
5. Latest successful build.
6. Build history table.
7. Viewport/render confirmation.

- [ ] Step 3.5: Run footer tests.

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/footer
```

Expected: footer tab, event focus, and mesh job model tests pass.

### Phase 4: Overlay Redesign As Confirmation Surface

**Goal:** Keep overlay lightweight; no long-running lock-in.

**Files:**

- Move/replace: `apps/control-room/src/modules/overlay/MeshBuildDialog.tsx`
- Create: `apps/control-room/src/modules/overlay/mesh-build/MeshBuildConfirmDialog.tsx`
- Create: `apps/control-room/src/modules/overlay/mesh-build/MeshBuildConfirmDialog.test.tsx`
- Create: `apps/control-room/src/modules/overlay/mesh-build/MeshBuildParameterDiff.tsx`
- Create: `apps/control-room/src/modules/overlay/mesh-build/MeshBuildParameterDiff.test.tsx`
- Modify: `apps/control-room/src/modules/overlay/OverlayModule.tsx` if this is where dialog is mounted.
- Modify: `apps/control-room/src/design/styles/dialog.css` or create `apps/control-room/src/design/styles/mesh-build.css` imported through globals style chain.

- [ ] Step 4.1: Replace old dialog body.

The overlay shows:

- Build target.
- Dirty policy changes table.
- Current mesh summary.
- Buttons: `Cancel`, `Apply & Build`, `Open Mesh Jobs`.

It does not show full log and does not attempt to be the long-running monitor.

- [ ] Step 4.2: Add parameter diff table.

Columns:

| Scope | Parameter | Current | Draft | Last realized | Impact |
|---|---|---:|---:|---:|---|

Use `meshPolicyDiff.ts` rows.

- [ ] Step 4.3: Responsive sizing.

Use:

```css
.fm-mesh-build-confirm {
  width: min(760px, calc(100vw - 32px));
  max-height: min(760px, calc(100vh - 64px));
}
```

Use existing `Dialog` primitive. Do not create bespoke dialog primitives.

- [ ] Step 4.4: Run overlay tests.

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/overlay
```

Expected: confirmation dialog renders target, dirty diff, current summary, and command buttons.

### Phase 5: Backend Build Resource Enrichment

**Goal:** Make build monitor data stable instead of screen-inferred raw JSON.

**Files:**

- Modify: `crates/fullmag-api/src/schemas/mesh.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Modify if needed: `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`
- Modify if needed: meshing runner/session code that writes `mesh_workspace`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`

- [ ] Step 5.1: Add typed build phase schema.

Fields:

```rust
pub struct MeshBuildPhaseResource {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: Option<String>,
    pub progress_percent: Option<f64>,
    pub progress_label: Option<String>,
    pub duration_ms: Option<u64>,
    pub started_at_unix_ms: Option<u128>,
    pub completed_at_unix_ms: Option<u128>,
}
```

- [ ] Step 5.2: Add typed provenance and published resources.

Fields:

```rust
pub struct MeshBuildPublishedResourcesResource {
    pub mesh_revision: Option<u64>,
    pub mesh_build_revision: Option<u64>,
    pub manifest: Option<String>,
    pub quality: Option<String>,
    pub realized_size_fields: Option<String>,
}

pub struct MeshBuildProvenanceResource {
    pub command_id: Option<String>,
    pub build_id: Option<String>,
    pub source_scene_revision: Option<u64>,
    pub geometry_realization_revision: Option<u64>,
    pub requested_policy_revision: Option<u64>,
    pub completed_at_unix_ms: Option<u128>,
    pub duration_ms: Option<u64>,
}
```

- [ ] Step 5.3: Preserve compatibility.

Keep `active_build`, `mesh_pipeline_status`, `last_build_summary`, and `shared_domain_build_report` while adding stable typed fields. Mark raw fields transitional in schema descriptions where accurate.

- [ ] Step 5.4: Backend tests.

Run:

```bash
cargo test -p fullmag-api router_v2::tests::mesh_active_build_returns_projection_from_mesh_workspace --no-fail-fast
cargo test -p fullmag-api router_v2 --no-fail-fast
```

For FEM/native meshing runtime proof, use container-backed `just` recipes only when native FEM build/runtime is touched.

### Phase 6: Realtime Completion And Resource Refresh

**Goal:** One completion signal refreshes build, mesh, viewport, and stats without over-fetching.

**Files:**

- Modify: `crates/fullmag-api/src/main.rs`
- Modify: `crates/fullmag-api/src/schemas/realtime.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Modify: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts`
- Modify: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`
- Modify: `apps/control-room/src/kernel/resources/geometryLifecycleResources.ts` if new resource keys are added.

- [ ] Step 6.1: Backend emits completion fetch hints.

On successful mesh build publish, `resource.batch_changed` must include:

- `/v2/sessions/current/meshing/builds/current`
- `/v2/sessions/current/meshing/builds/latest-successful`
- `/v2/sessions/current/meshing/summary`
- `/v2/sessions/current/meshing/meshes/shared-domain/manifest`
- `/v2/sessions/current/meshing/meshes/shared-domain/quality`
- `/v2/sessions/current/meshing/meshes/shared-domain/realized-size-fields`
- `/v2/sessions/current/visualization/state`

Do not recommend full field sample fetches unless field payloads changed.

- [ ] Step 6.2: Frontend invalidates dependent object resources.

When latest-successful changes, subscribed object topology/report/quality/size-field resources must refresh. This behavior already exists in part; expand tests for airbox/shared-domain resources.

- [ ] Step 6.3: Add viewport rendered mesh revision event.

When `viewport-3d` renders a render model built from mesh revision N, emit:

```typescript
kernel.bus.emit("mesh:topology-rendered", {
  meshRevision: renderModel.meshRevision,
  rendererId: "viewport-3d",
});
```

The event is UI diagnostic. It does not mutate backend mesh truth.

- [ ] Step 6.4: Run realtime tests.

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/realtime/RealtimeInvalidationBridge.test.ts src/modules/viewport-3d
```

Expected: mesh completion invalidates mesh resources and viewport emits rendered revision once the render model consumes the new topology.

### Phase 7: Explorer, Status Bar, And Run Gating

**Goal:** Mesh state is visible before the user reaches the inspector.

**Files:**

- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Modify: `apps/control-room/src/modules/explorer/ExplorerModule.tsx`
- Modify: `apps/control-room/src/modules/status-bar/StatusBarModule.tsx`
- Modify: `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
- Modify: `apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts`

- [ ] Step 7.1: Explorer mesh badges.

Badges:

- `Not built`
- `Building`
- `Stale`
- `Failed`
- `Current`

Object mesh node badge must use object-scoped state when available; shared-domain mesh node badge uses global mesh freshness.

- [ ] Step 7.2: Status bar mesh summary.

Show:

```text
Mesh rev 42 | build rev 57 | current
```

If stale:

```text
Mesh rev 42 | scene rev 44 | stale
```

- [ ] Step 7.3: Run button disabled reason with action.

When solver cannot run because mesh is missing/stale, disabled reason must say:

```text
Build a current shared-domain mesh before running. Open Mesh Jobs or Build Shared-Domain Mesh.
```

If command palette supports action links later, add link there. Do not embed ad-hoc callbacks inside tooltip components.

### Phase 8: Mesh Details Consolidation

**Goal:** Turn `MeshDetailsPanel` into a composed, reviewable production inspector.

**Files:**

- Create directory: `apps/control-room/src/modules/inspector/panels/mesh-details/`
- Create: `mesh-details/useMeshDetailsModel.ts`
- Create: `mesh-details/MeshOverviewSection.tsx`
- Create: `mesh-details/MeshBuildPipelineSection.tsx`
- Create: `mesh-details/MeshBuildHistorySection.tsx`
- Create: `mesh-details/MeshPolicyComparisonSection.tsx`
- Create: `mesh-details/MeshQualityGatesSection.tsx`
- Create: `mesh-details/MeshRealizedSizeFieldsSection.tsx`
- Create: `mesh-details/MeshViewportDeliverySection.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/MeshDetailsPanel.tsx`
- Add tests beside each model-heavy section.

- [ ] Step 8.1: Extract model hook first.

`useMeshDetailsModel()` owns resource hook composition and returns plain data for sections. It must not render JSX.

- [ ] Step 8.2: Extract sections one at a time.

After each extraction:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/MeshDetailsPanel.test.tsx src/modules/inspector/panels/ScopedMeshQualityPanels.test.tsx
```

- [ ] Step 8.3: Add policy comparison section.

This section uses `meshPolicyDiff.ts` and shows:

- current stored policy,
- draft when available,
- last realized policy,
- backend ignored/degraded fields when published.

### Phase 9: Build Log And Diagnostics

**Goal:** Users see the same useful information as terminal logs without opening terminal.

**Files:**

- Create: `apps/control-room/src/modules/footer/MeshBuildLogConsole.tsx`
- Create: `apps/control-room/src/modules/footer/MeshBuildLogConsole.test.tsx`
- Modify: `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`
- Modify: `crates/fullmag-api/src/router_v2/handlers/platform/system.rs` if log query options are added.
- Modify: `crates/fullmag-api/src/schemas/logs.rs` if source/phase fields are added.

- [ ] Step 9.1: Frontend full log console.

Features:

- show all entries by default,
- mesh-only filter,
- level filter,
- text search,
- copy visible log,
- auto-scroll while user is at bottom,
- pause auto-scroll when user scrolls upward,
- no hard 8-line cap.

- [ ] Step 9.2: Backend log enrichment.

If current log entries lack phase/source, add optional fields:

```json
{
  "source": "gmsh|mesh|solver|api",
  "phase_id": "gmsh_meshing",
  "command_id": "cmd-uuid"
}
```

Existing clients continue to work if these fields are absent.

### Phase 10: Viewport Delivery Confirmation

**Goal:** Build monitor can prove that a visible viewport consumed mesh revision N.

**Files:**

- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.test.ts`
- Modify: `apps/control-room/src/modules/footer/meshJobsModel.ts`

- [ ] Step 10.1: Carry mesh revision through render model.

Add fields:

```typescript
meshRevision: number | string | null;
meshGenerationId: string | null;
```

to the render model or existing status subobject.

- [ ] Step 10.2: Emit rendered event after demand frame.

After R3F renders a model with non-null mesh revision, emit `mesh:topology-rendered` once per revision.

- [ ] Step 10.3: Show delivery row in Mesh Jobs.

States:

- `Published` when backend resources show new mesh revision.
- `Loaded` when resource hooks fetched manifest/topology.
- `Rendered` when viewport event arrives for the revision.
- `Not visible` when `viewport-3d` is not mounted.

### Phase 11: End-To-End Lifecycle Tests

**Goal:** Prove empty session -> authoring -> mesh -> solver path.

**Files:**

- Create: `apps/control-room/src/modules/overlay/mesh-build/MeshBuildLifecycleSmokeScript.test.ts`
- Modify or create Playwright smoke under existing control-room smoke convention.
- Modify: `apps/control-room/scripts/smoke-viewport-3d.mjs` only if needed for mesh build scenario.

- [ ] Step 11.1: Unit/integration lifecycle test.

Test at model/API mock level:

1. no scene,
2. create object,
3. edit mesh policy,
4. dirty banner appears,
5. apply-and-build submits policy then command,
6. active build phases render,
7. latest-successful invalidates mesh resources,
8. viewport rendered event completes delivery state.

- [ ] Step 11.2: Browser smoke.

Use repo-approved control-room smoke route. Required assertions:

- workspace loads,
- object or fixture mesh policy is editable,
- build command opens mesh job monitor,
- build reaches success or deterministic mocked success,
- canvas is visible,
- WebGL context is not lost,
- drawing buffer is non-zero,
- mesh job monitor shows matching mesh revision.

Run:

```bash
pnpm --dir apps/control-room test
pnpm --dir apps/control-room exec next dev -p 3101
```

Then run the matching smoke command used by this checkout. If the smoke needs the managed runtime, use the repo `just` managed/container recipe first.

## 7. Acceptance Gates

| Gate | Required proof |
|---|---|
| G1 Contract | OpenAPI v2 docs, generated paths/types, and `ControlRoomApi` agree on mesh resources. |
| G2 Dirty safety | Any dirty object/airbox policy build does `apply -> build`; failed apply blocks build. |
| G3 Airbox rebuild | Airbox panel can submit shared-domain build and explains that airbox is part of the solver mesh. |
| G4 Build monitor | Mesh Jobs dock shows active build, canonical phases, full log, output, history, and viewport delivery. |
| G5 Dialog | Overlay shows target and parameter diff; long build monitoring is not trapped in modal. |
| G6 Backend provenance | `builds/current` exposes source scene revision, policy/provenance, phases, published resources. |
| G7 Realtime | Completion invalidates current/latest/summary/manifest/quality/size-fields/visualization without field over-fetch. |
| G8 Viewport | New topology revision is loaded and rendered once, with no continuous idle render loop. |
| G9 Explorer/status | Mesh state is visible in Explorer and status bar. |
| G10 Run gating | Solver run is disabled with actionable reason until mesh is current. |
| G11 E2E | Browser smoke proves mesh build UI reaches visible mesh and current stats. |
| G12 Hygiene | `pnpm --dir apps/control-room typecheck`, targeted tests, viewport tests, and resource-first guard searches pass. |

## 8. Verification Command Set

Run narrow checks during implementation:

```bash
pnpm --dir apps/control-room exec vitest run src/shared/domain/mesh
pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels
pnpm --dir apps/control-room exec vitest run src/modules/overlay
pnpm --dir apps/control-room exec vitest run src/modules/footer
pnpm --dir apps/control-room exec vitest run src/kernel/realtime/RealtimeInvalidationBridge.test.ts
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d
```

Run final frontend gates:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint -- --max-warnings=0
pnpm --dir apps/control-room test
```

Run backend contract gates when backend schema/routes change:

```bash
cargo test -p fullmag-api router_v2 --no-fail-fast
```

For native FEM/MFEM/CUDA/hypre/libCEED runtime proof, inspect `justfile` and use the managed/container `just` recipe. Do not claim FEM runtime proof from host-only commands.

## 9. Explicit Non-Goals

- Do not redesign solver stage UX in this plan.
- Do not add a separate FDM app or FEM app.
- Do not add screen-shaped meshing endpoints.
- Do not stream topology, fields, or full session snapshots over websocket.
- Do not refactor `MeshDetailsPanel` before model tests exist.
- Do not re-enable continuous viewport rendering to observe mesh changes.
- Do not add decorative visual design that competes with numerical data.

## 10. Execution Order Summary

1. Contract docs and baseline tests.
2. Shared mesh domain models.
3. Dirty state and apply-build safety in object/airbox inspectors.
4. Command/event wiring and Mesh Jobs bottom-dock surface.
5. Lightweight confirmation overlay.
6. Backend typed build/provenance/published-resource fields.
7. Realtime completion invalidation.
8. Explorer/status/run gating.
9. MeshDetailsPanel consolidation.
10. Full log diagnostics.
11. Viewport delivery confirmation.
12. End-to-end browser smoke and final gates.

This order keeps every phase shippable: policy safety lands before visual polish, backend contract lands before production claims, and viewport proof lands before calling the workflow complete.

