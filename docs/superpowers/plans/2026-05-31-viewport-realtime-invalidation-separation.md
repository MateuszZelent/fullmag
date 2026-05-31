# Viewport Realtime Invalidation Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make camera-only 3D interaction incapable of triggering field-data refetch/decode unless real field payloads changed, by separating UI-plane updates, field-family invalidation, and field-resource freshness all the way from session state to frontend hooks.

**Architecture:** The production fix is not a frontend throttle. Backend must own field freshness through tracked field revisions instead of `snapshot.state_version`, field data-plane endpoints must emit payload-derived ETags/revisions, realtime must distinguish field catalog changes from field sample changes, and the frontend bridge must invalidate field subscribers from semantic field events rather than inferring them from scalar churn. A camera-interaction deferral remains a secondary mitigation only after those contracts are correct.

**Tech Stack:** Rust (`crates/fullmag-api`, `crates/fullmag-cli`, `crates/fullmag-runner`), TypeScript/React (`apps/control-room`), Vitest, cargo tests, existing compute-performance diagnostics and Thread Manager transport logs.

---

## Current Diagnosis

The earlier plan was incomplete. Re-reading the codebase shows four separate faults, not one:

1. realtime field invalidation is keyed off `snapshot.state_version` through `fields_revision`;
2. backend realtime synthesizes blanket exact `/data/fields/{quantity}/samples/vector?component=full&scope_kind=full` fetch hints;
3. frontend widens `/data/scalars` invalidation into `/data/fields` invalidation;
4. the `data/fields/*` handlers themselves build `field_revision` and ETags from `snapshot.state_version`, so any refetch that reaches them can still look “fresh” even when payloads are unchanged.

That fourth point is the production-critical gap. Fixing only websocket invalidation would still leave the data plane unstable.

## Target Contract

### Backend state model

- `snapshot.state_version` remains a generic publish/session aggregation counter only.
- Field resources get their own tracked state:
  - `field_catalog_revision`: membership/metadata/domain availability of the field catalog;
  - `field_samples_revision`: any field payload change across quantities;
  - `field_quantity_revisions[quantity_id]`: exact freshness for one quantity payload.
- Field revisions are bumped when payloads actually change or disappear, not when unrelated snapshot properties are republished.

### Backend HTTP model

- `GET /v2/sessions/current/data/fields` uses `field_catalog_revision`.
- `GET /v2/sessions/current/data/fields/{quantity_id}/meta` uses `field_quantity_revisions[quantity_id]`.
- `GET /v2/sessions/current/data/fields/{quantity_id}/samples/vector` and all slice/projection/matrix/render derivatives derive ETags from `field_quantity_revisions[quantity_id]`, plus scope/component/query parameters, plus domain generation where applicable.

### Backend realtime model

- `resource=fields, resource_id=catalog, recommended_fetch=/v2/sessions/current/data/fields, revision=field_catalog_revision`
- `resource=fields, resource_id=samples, recommended_fetch=null, revision=field_samples_revision`
- optional exact query hints remain allowed later, but they are not required for the first safe production fix.
- no blanket exact field-vector fetch inventory is emitted.
- reconnect/bootstrap does not depend on exact field-vector fetch inventory: the
  frontend already treats `hello` and `resync.required` as session-scope
  invalidation and refetches subscribed `/v2/sessions/current/...` resources
  from that envelope.

### Frontend model

- `RealtimeInvalidationBridge` reads `resource` and `resource_id`, not only `recommended_fetch`.
- `fields/catalog` invalidates the catalog hook.
- `fields/samples` invalidates `DATA_FIELDS_PATH` as a prefix so active field-vector/slice/projection subscribers refetch, without pretending `/data/fields` itself was requested.
- generic `invalidatePrefix(resourceKey, revision)` remains correct for explicit
  family invalidation; the bug is the scalar-only path widening into fields
  without backend proof.
- `/data/scalars` changes no longer imply field changes.
- request diagnostics preserve full query strings so operator logs show whether the app requested `component=full`, `magnitude`, `part`, `airbox`, etc.

## File Structure

### Backend tracked field freshness

- Modify: `crates/fullmag-api/src/types.rs`
  - Add tracked field revision state to `SessionStateResponse`.
- Modify: `crates/fullmag-api/src/session.rs`
  - Detect field payload/catalog deltas and bump tracked revisions during apply/merge.
- Modify if equality support is needed for delta detection: `crates/fullmag-runner/src/types.rs`
  - Derive `PartialEq` for `LivePreviewField` or add an equivalent stable comparison surface.
- Modify: `crates/fullmag-api/src/router_v2/handlers/sessions/status.rs`
  - Publish tracked field revisions into thin status.

### Backend field data-plane

- Modify: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`
  - Stop using `snapshot.state_version` for catalog revision, field meta revision, vector ETags, slice/projection ETags, and matrix/render ETags.
- Modify if helper extraction is warranted: `crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs`
  - Centralize “effective field source and revision” logic if `fields.rs` becomes unwieldy.

### Backend realtime

- Modify: `crates/fullmag-api/src/main.rs`
  - Remove blanket exact field-vector fetch hints.
  - Emit separate `fields/catalog` and `fields/samples` change records.
  - Compare them against tracked field revisions, not `snapshot.state_version`.
- Modify: `crates/fullmag-api/src/schemas/realtime.rs`
  - Document `resource_id` semantics explicitly.
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
  - Add API tests for stable ETags/revisions and narrow realtime behavior.

### Frontend bridge and diagnostics

- Modify: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts`
  - Parse `resource` and `resource_id`.
  - Invalidate field prefix from `fields/samples`.
  - Stop scalar-to-fields widening.
- Modify: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`
  - Lock the new semantics.
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
  - Preserve exact `pathname + search` in diagnostics.
- Modify: `apps/control-room/src/kernel/api/RequestDiagnosticsController.ts`
  - Add `resourceKey` if transport consumers still need query-free aggregation.
- Modify tests as needed:
  - `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`
  - `apps/control-room/src/kernel/api/RequestDiagnosticsController.test.ts`
  - `apps/control-room/src/kernel/performance/threadManagerModel.test.ts`

### Secondary viewport safeguard

- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
  - Defer adoption of new heavy field payloads during active camera interaction.
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
  - Lock the source-level hook contract.
- Modify if necessary: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.test.ts`
  - Keep the existing interaction-active signal covered.

### Documentation and audit

- Modify: `docs/specs/resource-first-control-room-api-v2.md`
- Modify: `docs/specs/asyncapi/fullmag-live-realtime-v1.json`
- Modify: `docs/diagnostics/viewport-realtime-invalidation-architecture-audit-2026-05-31.md`
- Modify if needed: `apps/control-room/scripts/audit-compute-performance.mjs`
- Modify if needed: `apps/control-room/src/kernel/performance/computePerformanceAuditScript.test.ts`

Do not modify:

- `apps/legacy_web/**`
- unrelated FEM/runtime work
- unrelated dirty worktree files

## Task 1: Lock the Real Regression Surface in Tests

**Files:**
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Modify: `crates/fullmag-api/src/main.rs`

- [ ] **Step 1: Add a failing API test proving visualization-only realtime does not include field sample invalidation**

Use the existing visualization realtime test block in `crates/fullmag-api/src/router_v2/tests.rs` and strengthen it:

```rust
#[tokio::test]
async fn visualization_camera_patch_publishes_only_visualization_realtime_changes() {
    let state = test_app_state_with_live_session().await;
    let mut events = state.current_live_realtime_events.subscribe();
    let app = build_v2_router().with_state(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v2/sessions/current/visualization/state")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "camera": {
                            "position": [1.0e-6, 2.0e-6, 3.0e-6],
                            "target": [0.0, 0.0, 0.0]
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
        .await
        .expect("camera patch should publish a realtime event")
        .expect("realtime channel should stay open");
    let json: serde_json::Value = serde_json::from_str(&event.json).unwrap();
    let changes = json["payload"]["changes"].as_array().unwrap();

    assert!(changes.iter().any(|change| {
        change["recommended_fetch"] == "/v2/sessions/current/visualization/state"
    }));
    assert!(changes.iter().all(|change| {
        change["resource"] != "fields" || change["resource_id"] != "samples"
    }));
}
```

- [ ] **Step 2: Add a failing data-plane test proving snapshot-only churn must not change vector ETags**

Near the field-vector endpoint tests in `crates/fullmag-api/src/router_v2/tests.rs`, add:

```rust
#[tokio::test]
async fn field_vector_etag_stays_stable_when_only_snapshot_state_version_changes() {
    let state = test_app_state_with_mock_field().await;
    let app = build_v2_router().with_state(state.clone());

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?component=magnitude")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let etag = first.headers().get("etag").unwrap().to_str().unwrap().to_string();

    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = snapshot.state_version.wrapping_add(1);
    }

    let second = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/data/fields/m/samples/vector?component=magnitude")
                .header("if-none-match", etag.as_str())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
}
```

- [ ] **Step 3: Add a failing realtime unit test that field sample family changes are separate from the catalog**

In `crates/fullmag-api/src/main.rs`, replace blanket exact-fetch expectations with a family-level test:

```rust
#[test]
fn realtime_changes_publish_separate_field_catalog_and_field_sample_changes() {
    let changes = current_live_realtime_changes(&CurrentLiveRealtimeState {
        session_id: "session-1".into(),
        run_id: Some("run-1".into()),
        revisions: revisions(),
        mesh_resource_fetches: Vec::new(),
    });

    assert!(changes.iter().any(|change| {
        change.resource == RealtimeResourceName::Fields
            && change.resource_id.as_deref() == Some("catalog")
            && change.recommended_fetch.as_deref() == Some("/v2/sessions/current/data/fields")
    }));
    assert!(changes.iter().any(|change| {
        change.resource == RealtimeResourceName::Fields
            && change.resource_id.as_deref() == Some("samples")
            && change.recommended_fetch.is_none()
    }));
}
```

- [ ] **Step 4: Run the red tests**

Run:

```bash
cargo test -p fullmag-api visualization_camera_patch_publishes_only_visualization_realtime_changes -- --exact
cargo test -p fullmag-api field_vector_etag_stays_stable_when_only_snapshot_state_version_changes -- --exact
cargo test -p fullmag-api realtime_changes_publish_separate_field_catalog_and_field_sample_changes -- --exact
```

Expected: at least the ETag test and realtime family test FAIL on the current code.

- [ ] **Step 5: Commit the regression tests**

```bash
git add crates/fullmag-api/src/router_v2/tests.rs crates/fullmag-api/src/main.rs
git commit -m "test: lock field freshness and realtime separation regressions"
```

## Task 2: Introduce Tracked Field Revisions in Session State

**Files:**
- Modify: `crates/fullmag-api/src/types.rs`
- Modify: `crates/fullmag-api/src/session.rs`
- Test: `crates/fullmag-api/src/session.rs`

- [ ] **Step 1: Add explicit tracked field revision state to `SessionStateResponse`**

In `crates/fullmag-api/src/types.rs`, extend the hidden session state:

```rust
#[derive(Debug, Serialize, Clone)]
pub(crate) struct SessionStateResponse {
    // ...
    #[serde(skip)]
    pub state_version: u64,
    #[serde(skip)]
    pub scalar_revision: u64,
    #[serde(skip)]
    pub mesh_revision: u64,
    #[serde(skip)]
    pub mesh_build_revision: u64,
    #[serde(skip)]
    pub field_catalog_revision: u64,
    #[serde(skip)]
    pub field_samples_revision: u64,
    #[serde(skip)]
    pub field_quantity_revisions: BTreeMap<String, u64>,
}
```

- [ ] **Step 2: Make merge helpers report which quantities actually changed**

In `crates/fullmag-api/src/session.rs`, replace write-only helpers with delta-aware versions:

```rust
pub(crate) fn merge_latest_fields(
    current: &mut LatestFields,
    incoming: LatestFields,
) -> BTreeSet<String> {
    let mut changed = BTreeSet::new();
    for (quantity, value) in incoming.into_iter() {
        let changed_here = current.get(&quantity) != Some(&value);
        if changed_here {
            changed.insert(quantity.clone());
            current.insert(quantity, value);
        }
    }
    changed
}

pub(crate) fn merge_cached_preview_fields(
    current: &mut CachedPreviewFields,
    incoming: Vec<LivePreviewField>,
) -> BTreeSet<String> {
    let mut changed = BTreeSet::new();
    for field in incoming {
        let quantity = field.quantity.clone();
        let changed_here = current.get(&quantity) != Some(&field);
        if changed_here {
            changed.insert(quantity.clone());
            current.insert(field);
        }
    }
    changed
}
```

If `LatestFields` / `CachedPreviewFields` need `insert()` or `into_iter()` helpers, add them in `types.rs` instead of working around with raw `.0` access.

- [ ] **Step 3: Add one helper that bumps tracked field revisions from actual deltas**

Still in `session.rs`, add one central helper called from both apply paths:

```rust
fn apply_field_revision_deltas(
    current: &mut SessionStateResponse,
    changed_quantities: &BTreeSet<String>,
    catalog_may_have_changed: bool,
) {
    if catalog_may_have_changed {
        current.field_catalog_revision = next_revision(current.field_catalog_revision);
    }
    if !changed_quantities.is_empty() {
        current.field_samples_revision = next_revision(current.field_samples_revision);
        for quantity in changed_quantities {
            let next = current
                .field_quantity_revisions
                .get(quantity)
                .copied()
                .unwrap_or(0);
            current
                .field_quantity_revisions
                .insert(quantity.clone(), next_revision(next));
        }
    }
}
```

- [ ] **Step 4: Detect live-magnetization-backed `m` changes explicitly instead of relying on `state_version`**

For the fallback case where `m` is served from `live_state.latest_step.magnetization`, bump the quantity revision only when the fallback payload changes:

```rust
fn live_magnetization_signature(snapshot: &SessionStateResponse) -> Option<(u64, usize, u64)> {
    snapshot.live_state.as_ref().and_then(|state| {
        state.latest_step.magnetization.as_ref().map(|values| {
            (
                state.latest_step.step,
                values.len(),
                stable_f64_slice_hash(values),
            )
        })
    })
}
```

If the runner can provide a true payload revision for live magnetization, prefer that over hashing. The key rule is: do not promote generic `state_version` into field freshness.

- [ ] **Step 5: Call the helper from both snapshot apply paths**

In `apply_current_live_snapshot()` and `apply_current_live_session_frame()`, gather changed quantities from:

- `latest_fields` merge,
- `preview_fields` merge,
- preview-cache clear,
- live magnetization fallback changes,
- domain/mesh changes that invalidate field availability.

Then call `apply_field_revision_deltas(current, &changed_quantities, catalog_may_have_changed)`.

- [ ] **Step 6: Add focused session-level tests**

In `crates/fullmag-api/src/session.rs`, add tests like:

```rust
#[test]
fn apply_current_live_snapshot_does_not_bump_field_revisions_for_unrelated_state_changes() {
    let mut current = baseline_session_state();
    let initial_catalog = current.field_catalog_revision;
    let initial_samples = current.field_samples_revision;

    apply_current_live_snapshot(
        &mut current,
        CurrentLiveSnapshotRequest {
            session_id: current.session.session_id.clone(),
            session_status: Some("running".into()),
            ..Default::default()
        },
    )
    .unwrap();

    assert_eq!(current.field_catalog_revision, initial_catalog);
    assert_eq!(current.field_samples_revision, initial_samples);
}
```

- [ ] **Step 7: Run the session tests**

Run:

```bash
cargo test -p fullmag-api apply_current_live_snapshot_does_not_bump_field_revisions_for_unrelated_state_changes -- --exact
```

Expected: PASS after the tracked-revision model is in place.

- [ ] **Step 8: Commit tracked field revision state**

```bash
git add crates/fullmag-api/src/types.rs crates/fullmag-api/src/session.rs crates/fullmag-runner/src/types.rs
git commit -m "refactor: track field freshness separately from session state version"
```

## Task 3: Re-key the `data/fields/*` Data Plane to Payload-Derived Revisions

**Files:**
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`
- Modify if helpful: `crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/sessions/status.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

- [ ] **Step 1: Add central helper functions for effective field revisions**

In `fields.rs` or a small shared helper module, add:

```rust
fn quantity_field_revision(snapshot: &SessionStateResponse, quantity_id: &str) -> u64 {
    snapshot
        .field_quantity_revisions
        .get(quantity_id)
        .copied()
        .unwrap_or(0)
}

fn field_catalog_revision(snapshot: &SessionStateResponse) -> u64 {
    snapshot.field_catalog_revision
}

fn field_samples_revision(snapshot: &SessionStateResponse) -> u64 {
    snapshot.field_samples_revision
}
```

Do not fall back to `snapshot.state_version`.

- [ ] **Step 2: Re-key the field catalog and field meta endpoints**

In `get_field_catalog()` and `get_field_meta()` replace `snapshot.state_version`:

```rust
push_field_descriptor(
    &mut quantities,
    qid,
    quantity_unit(qid),
    quantity_field_revision(snapshot, qid),
    gen_id,
);

Ok(Json(FieldCatalog {
    revision: field_catalog_revision(snapshot),
    domain_generation_id: gen_id,
    quantities,
}))
```

and:

```rust
field_revision: quantity_field_revision(snapshot, quantity_id),
```

- [ ] **Step 3: Re-key vector, slice, projection, matrix, and render ETags**

In `get_field_vector()` and the other field-data endpoints, replace:

```rust
let field_revision = snapshot.state_version;
```

with:

```rust
let field_revision = quantity_field_revision(snapshot, quantity_id);
```

That single change must flow through all ETag builders:

- `component_etag_token(...)`
- `projection_etag_token(...)`
- `slice_etag_token(...)`
- matrix/render hash inputs

- [ ] **Step 4: Re-key thin status to tracked field revisions**

In `crates/fullmag-api/src/router_v2/handlers/sessions/status.rs` publish:

```rust
let resources = ResourceRevisionMap {
    field_catalog_revision: snapshot.field_catalog_revision,
    field_revision: snapshot.field_samples_revision,
    fields_revision: snapshot.field_samples_revision,
    // ...
};
```

`fields_revision` stays as a compatibility alias for the family-level field payload revision. It is no longer a generic snapshot counter.

- [ ] **Step 5: Add failing-then-passing endpoint tests**

Add or update tests so these contracts are explicit:

```rust
#[tokio::test]
async fn field_catalog_revision_changes_when_catalog_membership_changes() { /* ... */ }

#[tokio::test]
async fn field_meta_revision_tracks_quantity_payload_revision() { /* ... */ }

#[tokio::test]
async fn field_vector_etag_changes_when_quantity_payload_changes() { /* ... */ }
```

- [ ] **Step 6: Run the targeted field-data tests**

Run:

```bash
cargo test -p fullmag-api field_vector_etag_stays_stable_when_only_snapshot_state_version_changes -- --exact
cargo test -p fullmag-api v2_field_catalog_exposes_live_magnetization_fallback -- --exact
cargo test -p fullmag-api v2_field_vector_prefers_fresh_m_preview_cache_over_stale_latest_field -- --exact
```

Expected: PASS, with no reliance on `snapshot.state_version`.

- [ ] **Step 7: Commit the data-plane revision fix**

```bash
git add crates/fullmag-api/src/router_v2/handlers/data/fields.rs crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs crates/fullmag-api/src/router_v2/handlers/sessions/status.rs crates/fullmag-api/src/router_v2/tests.rs
git commit -m "fix: derive field endpoint freshness from tracked field revisions"
```

## Task 4: Refactor Realtime to Separate `fields/catalog` from `fields/samples`

**Files:**
- Modify: `crates/fullmag-api/src/main.rs`
- Modify: `crates/fullmag-api/src/schemas/realtime.rs`
- Test: `crates/fullmag-api/src/main.rs`

- [ ] **Step 1: Remove blanket exact field-vector fetch synthesis from realtime state**

Delete `field_vector_fetches` from `CurrentLiveRealtimeState`:

```rust
#[derive(Debug, Clone)]
pub(crate) struct CurrentLiveRealtimeState {
    pub session_id: String,
    pub run_id: Option<String>,
    pub revisions: RealtimeResourceRevisionMap,
    pub mesh_resource_fetches: Vec<String>,
}
```

Delete `current_live_field_vector_fetches(snapshot)` in the first safe pass.

- [ ] **Step 2: Emit separate field catalog and field sample changes**

In `current_live_realtime_changes()` replace the old overloaded `Fields` changes with:

```rust
RealtimeResourceChange {
    resource: RealtimeResourceName::Fields,
    revision: realtime_state.revisions.field_catalog_revision,
    resource_id: Some("catalog".to_string()),
    domain_generation_id: Some(realtime_state.revisions.domain_generation_id),
    recommended_fetch: Some("/v2/sessions/current/data/fields".to_string()),
},
RealtimeResourceChange {
    resource: RealtimeResourceName::Fields,
    revision: realtime_state.revisions.field_revision,
    resource_id: Some("samples".to_string()),
    domain_generation_id: Some(realtime_state.revisions.domain_generation_id),
    recommended_fetch: None,
},
```

This step must also remove the legacy exact-vector loop whose old diff key is:

```rust
for recommended_fetch in &realtime_state.field_vector_fetches {
    changes.push(RealtimeResourceChange {
        resource: RealtimeResourceName::Fields,
        revision: realtime_state.revisions.fields_revision,
        resource_id: recommended_fetch
            .split("/data/fields/")
            .nth(1)
            .and_then(|tail| tail.split('/').next())
            .map(ToOwned::to_owned),
        domain_generation_id: Some(realtime_state.revisions.domain_generation_id),
        recommended_fetch: Some(recommended_fetch.clone()),
    });
}
```

That old `revision: realtime_state.revisions.fields_revision` line is the
current exact-vector diff key and must not survive the refactor.

- [ ] **Step 3: Compare field changes by `resource_id`, not by guessed path**

In `current_live_realtime_change_revision_changed()` replace the path-based branch:

```rust
RealtimeResourceName::Fields => {
    match change.resource_id.as_deref() {
        Some("catalog") => {
            previous.field_catalog_revision != change.revision || domain_generation_changed
        }
        Some("samples") => {
            previous.field_revision != change.revision || domain_generation_changed
        }
        _ => true,
    }
}
```

- [ ] **Step 4: Update realtime schema comments**

In `crates/fullmag-api/src/schemas/realtime.rs`, document the new meaning:

```rust
pub struct RealtimeResourceChange {
    pub resource: RealtimeResourceName,
    /// Family sub-identifier such as `catalog` or `samples` for `fields`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    /// Exact fetch hint when the backend can name the affected resource precisely.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_fetch: Option<String>,
}
```

- [ ] **Step 5: Replace old blanket-fetch tests with family-separation tests**

Add or update tests such as:

```rust
#[test]
fn realtime_changes_since_refreshes_field_samples_without_emitting_blanket_exact_vector_fetches() {
    let previous = revisions();
    let mut current = revisions();
    current.field_revision += 1;
    current.fields_revision = current.field_revision;

    let state = CurrentLiveRealtimeState {
        session_id: "session-1".into(),
        run_id: Some("run-1".into()),
        revisions: current,
        mesh_resource_fetches: Vec::new(),
    };

    let changes = current_live_realtime_changes_since(&state, Some(&previous));

    assert!(changes.iter().any(|change| {
        change.resource == RealtimeResourceName::Fields
            && change.resource_id.as_deref() == Some("samples")
            && change.recommended_fetch.is_none()
    }));
    assert!(changes.iter().all(|change| {
        change.recommended_fetch
            .as_deref()
            .is_none_or(|fetch| !fetch.contains("/samples/vector"))
    }));
}
```

- [ ] **Step 6: Run targeted realtime tests**

Run:

```bash
cargo test -p fullmag-api realtime_changes_publish_separate_field_catalog_and_field_sample_changes -- --exact
cargo test -p fullmag-api realtime_changes_since_refreshes_field_samples_without_emitting_blanket_exact_vector_fetches -- --exact
```

Expected: PASS.

- [ ] **Step 7: Commit the realtime contract refactor**

```bash
git add crates/fullmag-api/src/main.rs crates/fullmag-api/src/schemas/realtime.rs
git commit -m "refactor: separate field catalog and field sample realtime changes"
```

## Task 5: Teach the Frontend Bridge the New Semantic Field Events

**Files:**
- Modify: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts`
- Modify: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`

- [ ] **Step 1: Extend realtime change parsing to keep `resource` and `resource_id`**

In `RealtimeInvalidationBridge.ts`, replace the current lossy parser:

```ts
interface RealtimeBatchChange {
  recommended_fetch?: string;
  resource?: string;
  resource_id?: string;
  revision: ResourceRevision;
}

function realtimeBatchChange(change: unknown): RealtimeBatchChange | null {
  if (!change || typeof change !== "object") return null;
  const record = change as Record<string, unknown>;
  const revision = record.revision;
  if (typeof revision !== "number" && typeof revision !== "string") {
    return null;
  }
  return {
    recommended_fetch:
      typeof record.recommended_fetch === "string"
        ? record.recommended_fetch
        : undefined,
    resource: typeof record.resource === "string" ? record.resource : undefined,
    resource_id:
      typeof record.resource_id === "string" ? record.resource_id : undefined,
    revision,
  };
}
```

- [ ] **Step 2: Add one semantic branch for field sample family invalidation**

In the batch-change loop:

```ts
if (change.resource === "fields" && change.resource_id === "samples") {
  this.queueFieldSampleInvalidation(change.revision);
  handled = true;
  continue;
}
```

with a dedicated helper:

```ts
private queueFieldSampleInvalidation(revision: ResourceRevision): void {
  this.pendingFetches.set(
    `${DATA_FIELDS_PATH}#samples`,
    latestRevision(this.pendingFetches.get(`${DATA_FIELDS_PATH}#samples`) ?? null, revision),
  );
}
```

and in `flushPendingInvalidations()`:

```ts
if (resourceKey === `${DATA_FIELDS_PATH}#samples`) {
  this.resources.invalidatePrefix(DATA_FIELDS_PATH, revision);
  continue;
}
```

This intentionally invalidates active field subscribers without pretending the catalog endpoint itself was fetched.

The existing generic path:

```ts
this.resources.invalidatePrefix(resourceKey, revision);
```

must stay in place for explicit backend family invalidation such as
`recommended_fetch === DATA_FIELDS_PATH`. The change here is only to stop
scalar-originated widening and to add semantic `fields/samples` handling when
`recommended_fetch` is absent.

- [ ] **Step 3: Remove scalar-to-fields widening**

Delete the field invalidation from `invalidateSimulationStepResources()`:

```ts
private invalidateSimulationStepResources(revision: ResourceRevision): void {
  this.resources.invalidate(SIMULATION_SOLVER_STATUS_PATH, revision);
  this.resources.invalidate(SIMULATION_SOLVER_ENERGIES_CURRENT_PATH, revision);
  this.resources.invalidatePrefix(
    resourceFamilyPrefix(SIMULATION_OBJECT_METRICS_PATH),
    revision,
  );
}
```

- [ ] **Step 4: Replace the bridge tests with the new semantic contract**

Add tests like:

```ts
it("invalidates field subscribers from semantic fields/samples realtime changes", () => {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const bridge = new RealtimeInvalidationBridge(resources);
  const fieldKey = `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=magnitude&scope_kind=full`;

  resources.subscribe(fieldKey, () => {});

  bridge.handleEvent({
    payload: {
      changes: [
        {
          resource: "fields",
          resource_id: "samples",
          revision: 11,
        },
      ],
    },
    type: "resource.batch_changed",
  });

  expect(resources.getRevision(fieldKey)).toBe(11);
  expect(resources.getRevision(DATA_FIELDS_PATH)).toBeNull();
});
```

and:

```ts
it("does not widen scalar result batches into field invalidation", () => {
  // keep the existing scalar case but assert DATA_FIELDS_PATH stays null
});
```

- [ ] **Step 5: Run the bridge tests**

Run:

```bash
pnpm --dir apps/control-room test src/kernel/realtime/RealtimeInvalidationBridge.test.ts -- --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit the bridge refactor**

```bash
git add apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts
git commit -m "fix: invalidate field subscribers from semantic realtime field events"
```

## Task 6: Preserve Exact Query Identity in Diagnostics

**Files:**
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify: `apps/control-room/src/kernel/api/RequestDiagnosticsController.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`
- Modify if needed: `apps/control-room/src/kernel/api/RequestDiagnosticsController.test.ts`
- Modify if needed: `apps/control-room/src/kernel/performance/threadManagerModel.ts`

- [ ] **Step 1: Add a failing diagnostics test for query preservation**

In `ControlRoomApi.test.ts`:

```ts
it("records full query-bearing field request paths in diagnostics", async () => {
  const diagnostics = new RequestDiagnosticsController();
  const api = new ControlRoomApi({
    baseUrl: "http://127.0.0.1:8765",
    diagnostics,
    fetchImpl: async () =>
      new Response(new ArrayBuffer(8), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "x-api-contract-version": "1.0.0",
        },
      }),
  });

  await api.data.fields.vector("m", {
    component: "magnitude",
    scope_kind: "part",
    scope_id: "body",
  });

  expect(diagnostics.listNewestFirst()[0]?.path).toBe(
    "/v2/sessions/current/data/fields/m/samples/vector?component=magnitude&scope_id=body&scope_kind=part",
  );
});
```

- [ ] **Step 2: Change path extraction to preserve `pathname + search`**

In `ControlRoomApi.ts`:

```ts
function pathFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
```

- [ ] **Step 3: Add `resourceKey` only if query-aware paths break aggregation**

If transport aggregation becomes too granular:

```ts
export interface RequestDiagnosticEntry {
  // ...
  path: string;
  resourceKey: string;
}
```

Populate `resourceKey` with `parsed.pathname` and use it only for grouping, never for operator-visible transport rows.

- [ ] **Step 4: Run diagnostics-related tests**

Run:

```bash
pnpm --dir apps/control-room test src/kernel/api/ControlRoomApi.test.ts src/kernel/api/RequestDiagnosticsController.test.ts -- --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit the diagnostics update**

```bash
git add apps/control-room/src/kernel/api/ControlRoomApi.ts apps/control-room/src/kernel/api/RequestDiagnosticsController.ts apps/control-room/src/kernel/api/ControlRoomApi.test.ts apps/control-room/src/kernel/api/RequestDiagnosticsController.test.ts apps/control-room/src/kernel/performance/threadManagerModel.ts
git commit -m "feat: preserve exact field query identity in transport diagnostics"
```

## Task 7: Add the Secondary Camera-Interaction Safety Valve

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
- Modify if needed: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.test.ts`

- [ ] **Step 1: Reuse the existing camera interaction signal**

The hook already exposes:

```ts
const cameraRegistrySnapshot = useCameraRegistrySnapshot();
const cameraView = resolveViewport3DSceneCameraView({
  cameraRegistrySnapshot,
  commandState,
});
```

Do not add a second interaction-state channel.

- [ ] **Step 2: Gate heavy field adoption in the scene-model hook**

In `useViewport3DSceneModel.ts`:

```ts
const committedFieldVectorRef = useRef(fieldVector);

useEffect(() => {
  if (cameraView.interactionActive) return;
  committedFieldVectorRef.current = fieldVector;
}, [cameraView.interactionActive, fieldVector]);

const effectiveFieldVector = cameraView.interactionActive
  ? committedFieldVectorRef.current
  : fieldVector;
```

Use `effectiveFieldVector` for:

- `fieldDataIssue`
- `fieldRefresh`
- downstream `fieldVector.data` consumers that trigger expensive scene work

- [ ] **Step 3: Lock the hook contract in source-level tests**

In `useViewport3DSceneModel.test.ts`:

```ts
it("defers heavy field adoption while camera interaction is active", () => {
  const source = readFileSync(sceneModelSourceUrl, "utf8");

  expect(source).toContain("const committedFieldVectorRef = useRef(fieldVector);");
  expect(source).toContain("if (cameraView.interactionActive) return;");
  expect(source).toContain("committedFieldVectorRef.current = fieldVector;");
  expect(source).toContain(
    "const effectiveFieldVector = cameraView.interactionActive",
  );
});
```

- [ ] **Step 4: Run the viewport tests**

Run:

```bash
pnpm --dir apps/control-room test src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/viewport-3d/layers/CameraControls.test.ts -- --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit the safety valve**

```bash
git add apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts apps/control-room/src/modules/viewport-3d/layers/CameraControls.test.ts
git commit -m "perf: defer heavy field adoption during active camera interaction"
```

## Task 8: Sync Specs, Audit, and Verification Proof

**Files:**
- Modify: `docs/specs/resource-first-control-room-api-v2.md`
- Modify: `docs/specs/asyncapi/fullmag-live-realtime-v1.json`
- Modify: `docs/diagnostics/viewport-realtime-invalidation-architecture-audit-2026-05-31.md`
- Modify if needed: `apps/control-room/scripts/audit-compute-performance.mjs`
- Modify if needed: `apps/control-room/src/kernel/performance/computePerformanceAuditScript.test.ts`

- [ ] **Step 1: Update the spec to include payload-derived field ETags**

Add explicit language such as:

```md
- `data/fields/*` ETags and revisions must derive from field payload freshness and query scope, not from generic session snapshot counters.
- Realtime `Fields` changes must distinguish field catalog freshness from field sample freshness.
```

- [ ] **Step 2: Update AsyncAPI to document `resource_id` families**

In `fullmag-live-realtime-v1.json`, document:

```json
"resource_id": {
  "type": ["string", "null"],
  "description": "Family sub-identifier such as `catalog` or `samples` for field resources."
}
```

- [ ] **Step 3: Update the audit document with the missing V-04 diagnosis**

Add a section that explicitly states:

```md
### V-04 - Field endpoint ETags are keyed off `snapshot.state_version`

Current behavior:
- `/data/fields`, `/data/fields/{quantity}/meta`, vector, slice, projection, matrix, and render endpoints derive freshness from `snapshot.state_version`.

Why this is wrong:
- any unrelated session publish can invalidate conditional GET freshness.
```

- [ ] **Step 4: Run broad automated verification**

Run:

```bash
cargo test -p fullmag-api realtime_changes -- --nocapture
cargo test -p fullmag-api field_vector_etag_stays_stable_when_only_snapshot_state_version_changes -- --exact
pnpm --dir apps/control-room test src/kernel/realtime/RealtimeInvalidationBridge.test.ts src/kernel/api/ControlRoomApi.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts -- --runInBand
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Record the adjacent `stages_revision` debt explicitly**

This plan fixes the viewport field invalidation bug. While implementing it,
capture the parallel `stages_revision = snapshot.state_version` problem as a
follow-up if it is not fixed in the same branch:

```md
- `stages_revision` currently derives from `snapshot.state_version` and can
  cause unnecessary stage execution refetches during live compute. It is the
  same revision-model smell as the field bug, but not the direct cause of the
  viewport stall.
```

If the implementation can safely split `stages_revision` in the same pass
without increasing risk, do it; otherwise track it explicitly as follow-up work.

- [ ] **Step 6: Capture real before/after proof in the browser**

Manual proof must confirm all of these:

1. drag the 3D camera with no compute command active;
2. observe no `GET /v2/sessions/current/data/fields/.../samples/vector?...` caused by that drag;
3. observe no `decoded binary payload` work item attributable to camera-only interaction;
4. trigger a real field payload update and confirm one semantic `fields/samples` invalidation fans out only to subscribed field resources;
5. confirm diagnostics preserve the full field query string.

- [ ] **Step 7: Commit any repo-tracked verification artifacts**

```bash
git add -A
git commit -m "test: verify field freshness and realtime invalidation separation"
```

Only include files that were intentionally changed by this work. Do not absorb unrelated dirty files.

## Self-Review

Spec coverage:

- tracked field freshness instead of `state_version`: Tasks 2 and 3;
- field endpoint ETags fixed at the data plane: Task 3;
- realtime separates field catalog from field samples: Task 4;
- frontend bridge respects semantic field events and stops scalar widening: Task 5;
- transport logs reveal the exact query shape: Task 6;
- mid-drag safety valve remains secondary: Task 7;
- documentation and runtime proof are explicit: Task 8.

Production-safety checks:

- the fix no longer depends on lucky frontend throttling;
- the backend owns freshness where freshness actually lives;
- the websocket contract is no longer forced to misuse `/data/fields` as both catalog fetch and sample-family invalidation;
- conditional GET semantics stay stable under unrelated snapshot churn.

Plan complete and saved to `docs/superpowers/plans/2026-05-31-viewport-realtime-invalidation-separation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
