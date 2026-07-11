# Planar Topological Charge Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current diagnostic object topological-charge path with a production-qualified, object-scoped planar FDM/FEM P1 observable whose physics, provenance, API, cache, Explorer, Inspector, and managed validation all implement physics note 0940 exactly.

**Architecture:** A shared oriented-triangle kernel consumes certified planar supports built by separate FDM and FEM P1 adapters. The HTTP handler captures immutable source identity, checks the composite cache before numerical work, and publishes a versioned resource through generated OpenAPI transport and revision-aware hooks. Explorer and Inspector consume that one resource without reinterpreting physics or mutating viewport state.

**Tech Stack:** Rust stable workspace (`fullmag-api`, `fullmag-runner` payloads), Axum, Serde, Utoipa/OpenAPI v2, TypeScript, React 19, Next.js 16, Vitest, shared shadcn/ui-style primitives, repository-managed `just` and container-backed FEM runtime.

## Global Constraints

- `docs/physics/0940-topological-charge-observable.md` is the canonical scientific contract and wins over historical plans.
- Production scope is native object-scoped FDM planes and tetrahedral FEM P1 planar cuts only.
- `fe_order != 1`, curved surfaces, 3D topological flux, and Hopf invariants are typed unsupported cases, never fallbacks.
- Canonical frames are `xy=(+x,+y,+z)`, `xz=(+x,+z,-y)`, and `yz=(+y,+z,+x)` where the tuple is `(u,v,n)`.
- The production quantity is canonical `m`; arbitrary three-component quantities are rejected.
- Missing, invalid, empty, unsupported, or degenerate support is never encoded as `Q=0`.
- `polarity` is removed. Integer qualification is separate from integral validity.
- HTTP v2 owns snapshots; WebSocket carries invalidation only.
- Generated OpenAPI artifacts are regenerated, never edited by hand.
- Components do not call `fetch()` or construct endpoint strings.
- Explorer, Inspector, and viewport remain modules in one workspace; no FDM/FEM UI forks.
- Activation is per kernel/session, not a module-global singleton and not `ProblemIR`.
- Every implementation task follows red-green-refactor and ends with a focused commit.
- Native FEM runtime proof uses a container-backed repository `just` recipe; host Cargo tests are contract checks only.
- Existing unrelated working-tree changes are not staged, reformatted, or committed.

## Frozen public vocabulary

```text
schema_version = "topological_charge.v2"
method = "berg_luescher_oriented_triangles_v2"
plane = auto | xy | xz | yz
support = midplane | layer_profile
status = ready | no_current_magnetization | empty_support |
         invalid_magnetization | degenerate_support | under_resolved |
         unsupported_geometry | unsupported_discretization
trust = qualified | diagnostic_boundary | diagnostic_resolution |
        diagnostic_topology | unavailable
resource_lifecycle = idle | loading | ready | stale | error
```

## Target file map

### Backend analysis ownership

- Replace `crates/fullmag-api/src/analysis/topological_charge.rs` with:
  - `crates/fullmag-api/src/analysis/topological_charge/mod.rs`
  - `crates/fullmag-api/src/analysis/topological_charge/types.rs`
  - `crates/fullmag-api/src/analysis/topological_charge/kernel.rs`
  - `crates/fullmag-api/src/analysis/topological_charge/qualification.rs`
  - `crates/fullmag-api/src/analysis/topological_charge/profile.rs`
  - `crates/fullmag-api/src/analysis/topological_charge/fdm.rs`
  - `crates/fullmag-api/src/analysis/topological_charge/fem_p1.rs`

### Backend transport and source resolution

- Create `crates/fullmag-api/src/schemas/analysis_extensions.rs`.
- Create `crates/fullmag-api/src/router_v2/handlers/analysis/topological_charge.rs`.
- Delete `crates/fullmag-api/src/router_v2/handlers/analysis/extensions.rs` after
  moving its only extension into `topological_charge.rs`; update
  `crates/fullmag-api/src/router_v2/handlers/analysis.rs` exports atomically.
- Create `crates/fullmag-api/src/router_v2/handlers/data/resolved_vector_field.rs` for shared current/snapshot and full/compact field resolution.
- Modify `crates/fullmag-api/src/router_v2/handlers/data.rs`,
  `crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs`, and
  `crates/fullmag-api/src/router_v2/handlers/data/fields.rs` to consume the
  shared resolver.
- Modify `crates/fullmag-api/src/quantity_data_plane.rs`, `openapi_v2.rs`, `schemas/mod.rs`, and router registration.

### Frontend resource and UI ownership

- Regenerate `apps/control-room/src/kernel/api/generated/openapi-v2.json`, `openapi-v2-types.ts`, and `openapi-v2-paths.ts`.
- Modify `apps/control-room/src/kernel/api/apiTypes.ts`, `ControlRoomApi.ts`, and tests.
- Create `apps/control-room/src/kernel/object-extensions/ObjectExtensionActivationController.ts` and tests.
- Modify `apps/control-room/src/kernel/types.ts`, `KernelProvider.tsx`, object-extension hooks/models, Explorer snapshot building, resource hooks, and realtime invalidation.
- Split the Inspector feature into:
  - `TopologicalChargeExtensionPanel.tsx`
  - `topologicalChargeModel.ts`
  - `TopologicalChargeControls.tsx`
  - `TopologicalChargeMethodSummary.tsx`
  - `TopologicalChargeProfileTable.tsx`
  - `TopologicalChargeQualitySection.tsx`
  - focused tests for each model/component.

### Validation

- Add focused router contract tests to
  `crates/fullmag-api/src/router_v2/tests.rs`.
- Create `scripts/validate_topological_charge_runtime.py`.
- Create the exact versioned fixtures and evidence files enumerated in Tasks 12
  and 13.
- Add `just verify-topological-charge-fdm-runtime`, `just verify-topological-charge-fem-runtime`, and `just verify-topological-charge-cross-backend`.

---

### Task 1: Lock the v2 schema and remove false semantics

**Files:**
- Create: `crates/fullmag-api/src/schemas/analysis_extensions.rs`
- Modify: `crates/fullmag-api/src/schemas/mod.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Test: `crates/fullmag-api/src/openapi_v2.rs`

**Interfaces:**
- Consumes: frozen vocabulary in this plan and physics note 0940.
- Produces: `TopologicalChargeQueryV2`, `TopologicalChargeResourceV2`, all nested schema enums/records, and an OpenAPI contract with no `polarity` or arbitrary `quantity_id`.

- [ ] **Step 1: Write the failing OpenAPI schema test**

Add a test that serializes `openapi_v2()` and asserts:

```rust
let schema = openapi_v2();
let json = serde_json::to_value(schema).expect("OpenAPI should serialize");
let operation = &json["paths"]
    ["/v2/sessions/current/analysis/extensions/objects/{object_id}/topological-charge"]
    ["get"];
let parameters = operation["parameters"].as_array().expect("parameters array");
let plane = parameters
    .iter()
    .find(|parameter| parameter["name"] == "plane")
    .expect("plane parameter");
assert_eq!(plane["schema"]["enum"], serde_json::json!(["auto", "xy", "xz", "yz"]));
assert!(!parameters.iter().any(|parameter| parameter["name"] == "quantity_id"));
let status_schema = &json["components"]["schemas"]["TopologicalChargeStatus"];
assert_eq!(
    status_schema["enum"],
    serde_json::json!([
        "ready", "no_current_magnetization", "empty_support",
        "invalid_magnetization", "degenerate_support", "under_resolved",
        "unsupported_geometry", "unsupported_discretization"
    ]),
);
let resource = &json["components"]["schemas"]["TopologicalChargeResourceV2"];
assert!(resource["properties"].get("polarity").is_none());
assert!(json.to_string().contains("topological_charge.v2"));
assert!(!status_schema.to_string().contains("\"stale\""));
```

- [ ] **Step 2: Run the test and record the expected red state**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api openapi_topological_charge_v2_is_closed_and_versioned -- --exact
```

Expected: failure because query parameters are untyped strings and the old resource contains `polarity`.

- [ ] **Step 3: Define exact schema types**

Define Serde/Utoipa enums with `snake_case` values and these fields:

```rust
pub struct TopologicalChargeQueryV2 {
    pub plane: TopologicalChargePlane,
    pub support: TopologicalChargeSupportMode,
    pub profile_samples: Option<TopologicalChargeProfileSamples>,
    pub snapshot_id: Option<String>,
    pub stage_id: Option<String>,
    pub method: TopologicalChargeMethod,
}

pub struct TopologicalChargeResourceV2 {
    pub schema_version: String,
    pub resource_revision: String,
    pub object_id: String,
    pub status: TopologicalChargeStatus,
    pub trust: TopologicalChargeTrust,
    pub charge: Option<f64>,
    pub nearest_integer: Option<i64>,
    pub integer_error: Option<f64>,
    pub request: TopologicalChargeRequestEcho,
    pub resolved_support: TopologicalChargeResolvedSupport,
    pub support_frame: TopologicalChargeSupportFrame,
    pub profile: Vec<TopologicalChargeLayerSample>,
    pub quality: TopologicalChargeQuality,
    pub provenance: TopologicalChargeProvenance,
    pub method: TopologicalChargeMethodDescriptor,
    pub computed_at_unix_ms: u64,
    pub warnings: Vec<TopologicalChargeWarning>,
}
```

`TopologicalChargeProfileSamples` uses custom query deserialization accepting
only `auto` or decimal integers `3..=257`. It is absent for `midplane`; omission
resolves to `auto` only for `layer_profile`. Invalid combinations are validated
by `TopologicalChargeQueryV2::validate()`. The semantic error enum has exact
variants `ProfileSamplesForMidplane` and `StageWithoutSnapshot`; the handler
maps both to `400 invalid_query` with the offending parameter name.

- [ ] **Step 4: Add schema invariants**

Add unit tests proving:

```rust
assert_eq!(
    midplane_with_samples.validate(),
    Err(TopologicalChargeQueryError::ProfileSamplesForMidplane),
);
assert_eq!(
    stage_without_snapshot.validate(),
    Err(TopologicalChargeQueryError::StageWithoutSnapshot),
);
assert!(layer_profile_257.validate().is_ok());
```

Test unknown `method` and `profile_samples=258` through the Axum route in Task
7 because Serde rejects them before a typed value reaches `validate()`.

- [ ] **Step 5: Run schema and OpenAPI tests**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api topological_charge_schema -- --nocapture
```

Expected: all schema tests pass; generated OpenAPI contains enum constraints and no `polarity`.

- [ ] **Step 6: Commit the schema boundary**

Before committing, run `git diff --cached --name-only` separately. Stage only this task and commit:

```bash
git commit -m "docs(api): define topological charge v2 schema"
```

---

### Task 2: Implement the deterministic oriented-triangle kernel

**Files:**
- Replace: `crates/fullmag-api/src/analysis/topological_charge.rs`
- Create: `crates/fullmag-api/src/analysis/topological_charge/mod.rs`
- Create: `crates/fullmag-api/src/analysis/topological_charge/types.rs`
- Create: `crates/fullmag-api/src/analysis/topological_charge/kernel.rs`
- Test: `crates/fullmag-api/src/analysis/topological_charge/kernel.rs`

**Interfaces:**
- Consumes: explicit samples and triangle indices; no mesh or HTTP types.
- Produces: `compute_oriented_charge(OrientedChargeInput) -> Result<OrientedChargeResult, TopologicalChargeError>`.

- [ ] **Step 1: Write red tests for valid, reversed, partial, and exceptional supports**

Tests must cover:

```rust
#[test]
fn reversing_every_triangle_reverses_charge() {
    let input = analytic_neel_support(65);
    let forward = compute_oriented_charge(input.borrow()).unwrap();
    let reversed_triangles = reverse_triangles(&input.triangles);
    let reversed = compute_oriented_charge(input.with_triangles(&reversed_triangles)).unwrap();
    assert!((forward.charge + reversed.charge).abs() <= 1.0e-12);
}

#[test]
fn one_valid_vertex_does_not_create_ready_zero() {
    let samples = [[0.0, 0.0, 1.0], [0.0; 3], [0.0; 3], [0.0; 3]];
    let triangles = [[0, 1, 3], [0, 3, 2]];
    let error = compute_oriented_charge(OrientedChargeInput::new(&samples, &triangles))
        .expect_err("support has no valid triangle");
    assert_eq!(error, TopologicalChargeError::NoValidTriangles);
}

#[test]
fn antipodal_exception_is_not_zero() {
    let samples = [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
    let error = compute_oriented_charge(OrientedChargeInput::new(&samples, &[[0, 1, 2]]))
        .expect_err("antipodal edge is exceptional");
    assert!(matches!(error, TopologicalChargeError::ExceptionalTriangle { triangle: 0 }));
}
```

- [ ] **Step 2: Verify red**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api analysis::topological_charge::kernel::tests -- --nocapture
```

Expected: tests fail because the current kernel skips invalid triangles and lacks exceptional-triangle errors.

- [ ] **Step 3: Implement normalization and admissibility**

Use constants from physics note 0940:

```rust
const MIN_VECTOR_NORM: f64 = 1.0e-12;
const EXCEPTION_EPSILON: f64 = 1.0e-14;
const ANTIPODAL_ANGLE_EPSILON_RAD: f64 = 1.0e-8;
const UNDER_RESOLVED_EDGE_ANGLE_RAD: f64 = std::f64::consts::FRAC_PI_2;
```

Reject nonfinite samples, norms at or below the threshold, out-of-range indices,
no valid triangle, exceptional `atan2`, and nonfinite accumulated output.
Compute the norm by max-component scaling before squaring; add finite vectors
near `f64::MAX` and near the minimum norm threshold to prove no overflow,
underflow, or accidental acceptance.

- [ ] **Step 4: Implement compensated deterministic summation**

Use Neumaier compensation in the input triangle order and report total, valid,
invalid, exceptional counts, maximum edge angle, and minimum absolute
denominator. Do not parallel-reduce the scalar unless a later implementation
preserves deterministic ordering and proves parity.

- [ ] **Step 5: Add analytical tests**

Add uniform, Neel, Bloch, reversed orientation, meron, nonunit normalization,
NaN, infinity, zero, index mismatch, and exceptional inputs. Required assertions:

```rust
assert!(uniform.charge.abs() <= 1.0e-12);
assert!((neel.charge + 1.0).abs() < 0.07);
assert!((bloch.charge + 1.0).abs() < 0.07);
assert!((meron.charge.abs() - 0.5).abs() < 0.08);
assert!(under_resolved.quality.max_edge_angle_rad >= std::f64::consts::FRAC_PI_2);
```

- [ ] **Step 6: Run kernel tests and Clippy for the module**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api analysis::topological_charge::kernel -- --nocapture
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo clippy -p fullmag-api -- -D warnings
```

Expected: kernel tests pass; any unrelated pre-existing workspace warning is reported separately and is not suppressed in this module.

- [ ] **Step 7: Commit the kernel**

```bash
git commit -m "fix(analysis): validate oriented topological charge triangles"
```

---

### Task 3: Qualify support topology, boundary, and integer trust

**Files:**
- Create: `crates/fullmag-api/src/analysis/topological_charge/qualification.rs`
- Modify: `crates/fullmag-api/src/analysis/topological_charge/types.rs`
- Test: `crates/fullmag-api/src/analysis/topological_charge/qualification.rs`

**Interfaces:**
- Consumes: points with physical `(u,v)`, oriented triangles, normalized samples.
- Produces: `SupportQualification`, `BoundaryQualification`, and `TopologicalChargeTrust` inputs.

- [ ] **Step 1: Write failing manifold tests**

Cover one valid disk, one annulus, duplicate triangles, orientation mismatch,
nonmanifold edge, two disconnected components, and an invalid-sample interior
hole. Assert exact diagnostics:

```rust
assert_eq!(disk.connected_component_count, 1);
assert_eq!(disk.nonmanifold_edge_count, 0);
assert_eq!(disk.boundary_loop_count, 1);
assert_eq!(disk.euler_characteristic, 1);
assert_eq!(annulus.boundary_loop_count, 2);
assert_eq!(annulus.euler_characteristic, 0);
assert_eq!(duplicate.duplicate_triangle_count, 1);
assert_eq!(split.connected_component_count, 2);
assert_eq!(hole.invalid_interior_boundary_count, 1);
```

- [ ] **Step 2: Verify red**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api support_qualification -- --nocapture
```

Expected: failure because no incidence/connected-component qualifier exists.

- [ ] **Step 3: Implement canonical keys and incidence**

Canonical triangle key sorts global support vertex ids only for duplicate
detection; orientation remains in the original triangle. Canonical edge key is
`(min(a,b), max(a,b))`. Build edge incidence and triangle adjacency without
losing orientation.

- [ ] **Step 4: Implement length-weighted boundary qualification**

Compute the weighted boundary mean and maximum geodesic deviation. A mean norm
`<=1e-12` is not qualified and must not be normalized. Return:

```rust
pub enum QuantizationStatus {
    Qualified,
    NotQualifiedBoundary,
    NotQualifiedResolution,
    NotQualifiedTopology,
}
```

Use `10_f64.to_radians()` as the boundary threshold. Produce
`nearest_integer` only for `Qualified`.

- [ ] **Step 5: Add boundary and trust tests**

Test uniform boundary, cancelling boundary mean, 11-degree boundary deviation,
under-resolved field, annular support, multi-component support, and a qualified
integer result. Assert that a finite nonqualified charge remains visible while
integer fields are absent.

- [ ] **Step 6: Run qualification and kernel regression tests**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api analysis::topological_charge -- --nocapture
```

Expected: all shared analysis tests pass.

- [ ] **Step 7: Commit qualification**

```bash
git commit -m "feat(analysis): qualify topological charge trust"
```

---

### Task 4: Build one canonical current/snapshot vector-field resolver

**Files:**
- Create: `crates/fullmag-api/src/router_v2/handlers/data/resolved_vector_field.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- Consumes: session snapshot, quantity `m`, object id, optional snapshot/stage.
- Produces: `ResolvedObjectVectorField` with values, physical grid or global node ids, revisions, storage domain, and source kind.

- [ ] **Step 1: Write red parity tests for field endpoint and analysis source**

Create fixtures where current live `m`, revisioned current `latest_fields["m"]`,
a preview-cache decoy, and an explicit persisted snapshot all contain different
values. Assert this closed priority:

1. requested snapshot selects exactly that snapshot;
2. otherwise valid current live `m` wins;
3. otherwise revision-compatible current `latest_fields["m"]` is selected;
4. preview-only data returns `no_current_magnetization`.

The resolver and canonical `m` field endpoint must select the same source for
the same query. Add a compact FEM fixture with eight mesh nodes and four
magnetic values mapped to global ids `[0,1,2,3]`.

- [ ] **Step 2: Verify red**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api resolved_object_vector_field -- --nocapture
```

Expected: the old topological-charge handler falls back to preview data and
does not resolve an explicit snapshot through the canonical path.

- [ ] **Step 3: Define exact resolver output**

```rust
pub struct ResolvedObjectVectorField {
    pub values: Vec<[f64; 3]>,
    pub grid: Option<[u32; 3]>,
    pub global_node_ids: Option<Vec<u32>>,
    pub object_mask: Option<Vec<bool>>,
    pub field_revision: u64,
    pub field_storage_domain: String,
    pub field_node_mapping_id: Option<String>,
    pub snapshot_id: Option<String>,
    pub stage_id: Option<String>,
    pub source_kind: ResolvedFieldSourceKind,
}
```

`ResolvedFieldSourceKind` is closed to `CurrentLive`, `CurrentMaterialized`, and
`PersistedSnapshot`. The resolver accepts only `m`, validates stage/snapshot
scope using the existing hysteresis snapshot path, and uses the closed source
priority above. Preview cache is never a production source.

- [ ] **Step 4: Extract magnetic-node mapping**

Move magnetic node-index discovery from private field serialization code into a
shared pure function. Full-domain layout maps index `i` to global node `i`.
Compact layout requires exact magnetic-node count and returns the ordered global
ids. Length-only matching without mapping returns a typed error.

- [ ] **Step 5: Make the existing field endpoint consume the resolver**

Preserve its existing binary output and snapshot tests. This proves that
topological charge cannot drift to a second source priority.

- [ ] **Step 6: Run field and snapshot suites**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api field_vector_snapshot_id -- --nocapture
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api resolved_object_vector_field -- --nocapture
```

Expected: persisted snapshot, current-live, current-materialized, preview
rejection, full-domain, and compact FEM cases pass.

- [ ] **Step 7: Commit the shared resolver**

```bash
git commit -m "refactor(api): share object vector field resolution"
```

---

### Task 5: Implement exact FEM P1 plane-cut supports

**Files:**
- Create: `crates/fullmag-api/src/analysis/topological_charge/fem_p1.rs`
- Test: `crates/fullmag-api/src/analysis/topological_charge/fem_p1.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- Consumes: object tetrahedra, global nodes, mapped P1 `m`, canonical frame, cut coordinate.
- Produces: `PlanarSupport` with physical points, normalized samples, oriented triangles, coordinate in metres, and topology diagnostics.

- [ ] **Step 1: Write red tests proving general tetra uses a midplane cut**

For the existing single tetra with bounds `[0,1]^3`, `plane=xy`, and midplane,
assert `coordinate_m=0.5`, method topology `tetra_plane_cut`, and reject the old
base face at `z=0`.

- [ ] **Step 2: Add permutation and coincident-face red tests**

Generate all 24 local-node permutations for one tetra and compare sorted cut
points and charge. Add two tetrahedra sharing a face coincident with the cut and
assert that the face is represented once. Add cuts through exactly one global
node and one global edge; zero-area polygons are discarded locally without
duplicating or removing adjacent valid polygons. Repeat after translating the
mesh origin and scaling it to nanometres to prove the scale-aware distance
tolerance is not tied to unit coordinates.

- [ ] **Step 3: Verify red**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api fem_p1_topological_support -- --nocapture
```

Expected: current arbitrary-layer-face priority fails the midplane and duplicate-face assertions.

- [ ] **Step 4: Implement exact intersection and global keys**

Use canonical keys:

```rust
enum CutVertexKey {
    MeshNode(u32),
    MeshEdge { low: u32, high: u32 },
}
```

Derive total ordering with `MeshNode` before `MeshEdge`, then numeric id order.
For one fixed physical plane, a global edge has at most one cut point, so the
global edge id is the exact cross-tetrahedron identity; floating-point `t` must
not be part of the key. Classify signed endpoint distances with
`eps_s = 64*EPSILON*max(abs(s0),abs(s1),abs(s_cut),L) + 1e-12*L`, where `L` is
the object projected thickness. Endpoint hits use `MeshNode`. Retain the
unrounded physical interpolation parameter, sort polygon vertices by
`atan2(v-vc,u-uc)` with `CutVertexKey` as the exact tie-break, rotate the cyclic
order so its smallest key is first, fan-triangulate from that vertex, and
orient by positive projected area.
When the plane coincides with a shared face, the tetrahedron with the lowest
canonical global-node tuple owns that face. Any remaining duplicate triangle
is a topology error rather than a silent deduplication.

- [ ] **Step 5: Interpolate then normalize P1 magnetization**

Interpolate mapped nodal `m` on the global edge, then normalize at the cut
vertex. Antipodal interpolation reaching the minimum norm returns
`invalid_magnetization`; it does not pick one endpoint.

- [ ] **Step 6: Reject non-P1 provenance**

Add `fe_order` to the immutable source descriptor. Return
`UnsupportedDiscretization { requested: order }` before support construction
when order differs from one, and `UnsupportedDiscretization { requested: None }`
when order provenance is absent. Never infer P1 from four-node connectivity
alone.

- [ ] **Step 7: Add compact/full layout parity tests**

Build the same magnetic object once with full-domain values including airbox
nodes and once with compact mapped magnetic values. Assert support point ids,
triangles, charge, and quality agree to `1e-12`.

- [ ] **Step 8: Run focused FEM support tests**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api fem_p1_topological_support -- --nocapture
```

Expected: all exact-cut, mapping, permutation, orientation, and order-reject tests pass.

- [ ] **Step 9: Commit FEM support construction**

```bash
git commit -m "fix(analysis): build exact object FEM P1 plane cuts"
```

---

### Task 6: Implement exact profiles and correct full-thickness aggregation

**Files:**
- Create: `crates/fullmag-api/src/analysis/topological_charge/profile.rs`
- Modify: `crates/fullmag-api/src/analysis/topological_charge/fem_p1.rs`
- Create: `crates/fullmag-api/src/analysis/topological_charge/fdm.rs`
- Test: `crates/fullmag-api/src/analysis/topological_charge/profile.rs`
- Test: `crates/fullmag-api/src/analysis/topological_charge/fem_p1.rs`
- Test: `crates/fullmag-api/src/analysis/topological_charge/fdm.rs`

**Interfaces:**
- Consumes: single-cut builders and requested profile policy.
- Produces: `PlanarSupportProfile` and an optional scalar summary with explicit physical weights.

- [ ] **Step 1: Write red aggregation tests**

Required fixtures:

```rust
assert_eq!(fdm_weighted_mean(&[0.0, 1.0, 0.0], &[1.0, 1.0, 1.0]), Some(1.0 / 3.0));
assert_eq!(fem_midpoint_mean(&[0.0, 1.0, 0.0], 3.0), Some(1.0 / 3.0));
assert_eq!(fem_midpoint_weights(3, 3.0), vec![1.0, 1.0, 1.0]);
assert_eq!(fem_midpoint_mean_with_invalid_cut(), None);
```

- [ ] **Step 2: Verify red**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api topological_charge_profile -- --nocapture
```

Expected: current shared trapezoidal helper returns `0.5` for the three
interior samples instead of the full-thickness midpoint result `1/3`.

- [ ] **Step 3: Implement FEM profile coordinates**

For `profile_samples=N`, use cell-centred normalized positions
`(i+0.5)/N`, `i=0..N-1`, transformed to physical normal bounds. For `auto`, use
33 interior bin-midpoint positions. Every FEM profile sample uses the exact P1
tetra-plane cut builder from Task 5 and reports
`integration_weight_m=(s_max-s_min)/N`. The scalar summary divides the weighted
sum by the full thickness, not by the distance between the first and last cut.

Precompute each object tetrahedron's projected `[s_low,s_high]` interval and
sweep sorted cut coordinates through deterministic start/end events. Evaluate
active candidates in canonical global-tetrahedron order. Add an instrumented
test proving the profile performs one interval build plus candidate
intersections and never `N * tetrahedron_count` full-scan classifications.

- [ ] **Step 4: Remove native FEM layer-face fallback**

Delete the v1 branch that searches mesh faces or native layers. Assert that the
FEM resolved support source is always `exact_plane_cut` and that a mesh with a
coplanar exterior face still evaluates the requested midplane rather than that
face.

- [ ] **Step 5: Implement FDM object-scoped supports**

Require the resolved object mask. Emit only cells whose four samples belong to
the selected object. Mixed ownership becomes a reported physical support
boundary; multiple geometric boundary loops remain a diagnostic-topology
case, while gaps caused by invalid samples are errors. For a multi-object field
without a mask, return `UnsupportedGeometry` rather than global-domain charge.

- [ ] **Step 6: Add two-object FDM tests**

Create adjacent objects with `Q=-1` and uniform `Q=0`. Assert object requests
return independent results and global grid values are never reused without
masking. Add `plane=auto` fixtures with uniquely thinnest x, y, and z extents,
then exact/tolerance-level ties; assert the fixed tie order `xy`, `xz`, `yz` and
the requested/resolved plane echo.

- [ ] **Step 7: Add profile completeness tests**

One invalid requested cut keeps its profile row and removes the scalar summary.
No invalid cut is dropped from averaging. Every row has `coordinate_m` and
`integration_weight_m`.

- [ ] **Step 8: Run profile, FDM, and FEM support suites**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api topological_charge_profile -- --nocapture
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api fdm_object_topological_support -- --nocapture
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api fem_p1_topological_support -- --nocapture
```

Expected: aggregation, full-thickness weights, sweep complexity, object masks,
automatic plane resolution, and exact FEM support tests all pass.

- [ ] **Step 9: Commit profiles and object scoping**

```bash
git commit -m "fix(analysis): scope and aggregate topological charge profiles"
```

---

### Task 7: Rebuild the HTTP handler around immutable provenance and cache-first execution

**Files:**
- Create: `crates/fullmag-api/src/router_v2/handlers/analysis/topological_charge.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/analysis.rs`
- Delete: `crates/fullmag-api/src/router_v2/handlers/analysis/extensions.rs`
- Modify: `crates/fullmag-api/src/router_v2/mod.rs`
- Modify: `crates/fullmag-api/src/quantity_data_plane.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- Consumes: query v2, shared source resolver, FDM/FEM support builders, kernel, qualifier, cache.
- Produces: `GET /v2/sessions/current/analysis/extensions/objects/{object_id}/topological-charge`
  with exact HTTP and scientific statuses.

- [ ] **Step 1: Write red router tests for every status**

Add one test for `ready`, `under_resolved`, `no_current_magnetization`,
`empty_support`, `invalid_magnetization`, `degenerate_support`,
`unsupported_geometry`, `unsupported_discretization`, invalid query `400`,
missing object/snapshot `404`, provenance conflict `409`, and unexpected
failure `500`. Assert that `stale` and `error` are absent from the scientific
status enum.

- [ ] **Step 2: Write red snapshot/cache tests**

Use uniform and skyrmion snapshots. Assert different `resource_revision`, cache
keys, and charges. Instrument the kernel through a test-only invocation counter
and assert the second identical request does not call it. Start two identical
cache-miss requests behind a test barrier and assert exactly one kernel
invocation, identical responses, and removal of the keyed-flight entry after
both success and injected failure.

- [ ] **Step 3: Verify red**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api topological_charge_v2_router -- --nocapture
```

Expected: old handler ignores snapshot, computes before cache lookup, and cannot
emit several statuses.

- [ ] **Step 4: Define immutable source identity**

Capture and clone only the selected scene object, resolved field values/mapping,
object mesh slice, revisions, generation ids, discretization, `fe_order`, and
snapshot scope under the session read lock. Drop the guard before digest, cache,
support construction, and kernel execution.

- [ ] **Step 5: Build the composite revision digest**

Hash a versioned canonical serialization containing:

```text
object_id, source_kind, scene_revision, field_revision,
field_storage_domain, field_node_mapping_id, mesh_revision,
mesh_generation_id, domain_generation_id, snapshot_id, stage_id,
requested_plane, resolved_plane, support, profile_samples,
discretization, fe_order, method_version
```

Use the digest as both cache identity and response `resource_revision`.

Use the existing bounded analysis-resource cache capacity. Add an
analysis-local keyed single-flight map whose entry lifetime is exactly one
in-flight computation; it must not become an unbounded second cache.

- [ ] **Step 6: Map status and trust without discarding diagnostic charge**

`under_resolved` returns a finite charge with `trust=diagnostic_resolution`.
Invalid, empty, and unsupported statuses return no charge. `409` and `500` are
HTTP errors, never successful scientific resources. Qualified integer fields
are computed only when trust is `qualified`.

Implement the exact status precedence from physics note 0940 and table-drive
tests for every branch. Implement trust precedence as `unavailable` before
`diagnostic_resolution` before `diagnostic_topology` before
`diagnostic_boundary` before `qualified`. A fixture failing both topology and
boundary must retain both diagnostics while selecting
`trust=diagnostic_topology`; a fixture failing resolution plus boundary must
select `trust=diagnostic_resolution`.

- [ ] **Step 7: Set actual computation time**

Use current Unix milliseconds on cache miss. A cache hit returns the original
computation timestamp and the same resource revision.

- [ ] **Step 8: Prove short lock duration**

Add a concurrency test where a test kernel barrier pauses computation after
snapshot capture and a writer acquires the live-session write lock before the
barrier is released.

- [ ] **Step 9: Run router, cache, and concurrency tests**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api topological_charge_v2_router -- --nocapture
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api topological_charge_cache_precedes_compute -- --exact
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api topological_charge_singleflight -- --exact
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api topological_charge_does_not_hold_session_lock -- --exact
```

- [ ] **Step 10: Commit handler and cache**

```bash
git commit -m "fix(api): publish revisioned topological charge v2"
```

---

### Task 8: Regenerate OpenAPI and update the handwritten frontend facade

**Files:**
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Generate: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Generate: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Generate: `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`
- Modify: `apps/control-room/src/kernel/api/apiTypes.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Test: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`

**Interfaces:**
- Consumes: backend OpenAPI v2 operation.
- Produces: generated low-level transport and handwritten `topologicalCharge(objectId, query, options)` facade.

- [ ] **Step 1: Write the failing facade test**

Assert exact URL serialization for:

```ts
await api.analysis.extensions.objects.topologicalCharge(
  "film",
  {
    method: "berg_luescher_oriented_triangles_v2",
    plane: "xz",
    profile_samples: 65,
    snapshot_id: "hysteresis_point_004",
    stage_id: "stage-1",
    support: "layer_profile",
  },
);
```

Expected query order is the generated client's canonical serialization; the
test asserts decoded query values rather than depending on incidental ordering.

- [ ] **Step 2: Verify red**

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/api/ControlRoomApi.test.ts
```

Expected: old handwritten query type lacks `support`, `profile_samples`, and `stage_id`.

- [ ] **Step 3: Regenerate all API artifacts**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  pnpm --dir apps/control-room generate:api
```

Do not manually repair generated files. If generation differs unexpectedly,
fix Rust schema/Utoipa sources and regenerate.

- [ ] **Step 4: Make handwritten types aliases of generated types**

Export the generated query/resource types. Keep only UI-friendly name aliases;
do not redefine string unions that can drift from OpenAPI.

- [ ] **Step 5: Update facade serialization and error mapping**

Ensure `400`, `404`, and `409` remain transport errors with request diagnostics,
while scientific statuses remain successful typed resources.

- [ ] **Step 6: Run API generation and facade tests**

```bash
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room exec vitest run src/kernel/api/ControlRoomApi.test.ts
pnpm --dir apps/control-room check:api-hygiene
```

Expected: generated transport remains the only low-level JSON transport and API hygiene passes.

- [ ] **Step 7: Commit generated and handwritten API changes together**

```bash
git commit -m "feat(control-room): consume topological charge v2 API"
```

---

### Task 9: Make resource identity and realtime invalidation exact

**Files:**
- Modify: `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`
- Modify: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts`
- Test: `apps/control-room/src/kernel/resources/studyRuntimeResources.test.ts`
- Test: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`
- Test: `apps/control-room/src/kernel/resources/ResourceRuntimeStore.test.ts`

**Interfaces:**
- Consumes: object id plus complete typed query and realtime field/mesh/domain events.
- Produces: query-specific resource keys and correct stale/refetch behavior.

- [ ] **Step 1: Write red key and invalidation tests**

Assert that midplane, layer-profile, snapshot A, and snapshot B produce distinct
resource keys. Assert both `quantity_ids=["m"]` and a broad field-sample change
invalidate every subscribed topological-charge query for the object family.

- [ ] **Step 2: Verify red**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/kernel/resources/studyRuntimeResources.test.ts \
  src/kernel/realtime/RealtimeInvalidationBridge.test.ts
```

Expected: current hook key omits query identity and broad invalidation misses the analysis family.

- [ ] **Step 3: Implement canonical query resource keys**

Build keys with `URLSearchParams` from every nondefault typed query property.
Use the exact same canonicalization for load identity and invalidation-family
prefix. `resolveRevision` returns `resource_revision`, not scene revision.

- [ ] **Step 4: Preserve on-demand stale behavior**

When invalidated with `pauseLoad=true`, retain the previous data as stale and do
not fetch until `refetch()`. Continuous mode refetches. Add explicit tests for
both branches. A burst of matching realtime events is coalesced by the existing
kernel invalidation policy and never produces overlapping loads for one key;
add a request-counter test and do not introduce timer polling.

- [ ] **Step 5: Add scene/object/snapshot invalidation**

Invalidate the family after relevant scene object changes, mesh build changes,
domain generation changes, exact/broad `m` changes, and snapshot deletion or
replacement. Do not invalidate it for camera or colorbar changes.

- [ ] **Step 6: Run focused resource tests**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/kernel/resources/studyRuntimeResources.test.ts \
  src/kernel/realtime/RealtimeInvalidationBridge.test.ts \
  src/kernel/resources/ResourceRuntimeStore.test.ts
```

- [ ] **Step 7: Commit hook and invalidation**

```bash
git commit -m "fix(control-room): invalidate topological charge resources exactly"
```

---

### Task 10: Move activation into a per-kernel controller and derive Explorer status

**Files:**
- Create: `apps/control-room/src/kernel/object-extensions/ObjectExtensionActivationController.ts`
- Create: `apps/control-room/src/kernel/object-extensions/ObjectExtensionActivationController.test.ts`
- Modify: `apps/control-room/src/kernel/types.ts`
- Modify: `apps/control-room/src/kernel/KernelProvider.tsx`
- Modify: `apps/control-room/src/kernel/object-extensions/useObjectExtensionActivation.ts`
- Modify: `apps/control-room/src/kernel/object-extensions/ObjectExtensionsSectionModel.ts`
- Modify: `apps/control-room/src/modules/explorer/ExplorerModule.tsx`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Test: `apps/control-room/src/kernel/object-extensions/ObjectExtensionsSectionModel.test.ts`
- Test: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Test: `apps/control-room/src/modules/explorer/explorerSelection.test.ts`
- Test: `apps/control-room/src/kernel/KernelProvider.test.ts`

**Interfaces:**
- Consumes: active kernel/session identity and topological resource snapshots.
- Produces: session-scoped activation plus Explorer node status derived from the resource.

- [ ] **Step 1: Write red isolation tests**

Create two controller instances, enable `film:topological_charge` in the first,
and assert the second remains disabled. Call `resetForSession("session-b")` and
assert the first clears its old session state. Render the hook through SSR and
first-client hydration snapshots; both must expose the same disabled server
snapshot before any client-side activation event.

- [ ] **Step 2: Write red Explorer status tests**

Assert enabled without data produces `idle`; then cover `loading`, `ready`,
`under_resolved`, `stale`, `unsupported`, and `error`. No test fixture may
hardcode every enabled extension as `ready`.

- [ ] **Step 3: Verify red**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/kernel/object-extensions/ObjectExtensionActivationController.test.ts \
  src/kernel/object-extensions/ObjectExtensionsSectionModel.test.ts \
  src/modules/explorer/builders/buildModelTree.test.ts
```

- [ ] **Step 4: Implement controller and KernelApi ownership**

Add:

```ts
readonly objectExtensions: ObjectExtensionActivationController;
```

to `KernelApi`, instantiate it inside `createKernel()`, and expose a
`useSyncExternalStore` hook over that instance. Remove the module-level mutable
snapshot and global setter.

- [ ] **Step 5: Gate availability by magnetic object role**

Registry availability requires a committed `object.root` whose scene adapter
reports `objectRole === "magnet"`. Missing field or unsupported support remains
a resource status shown after activation, not a false hidden capability.

- [ ] **Step 6: Derive Explorer child state from resource cache**

Use the query-specific resource key and current resource snapshot. The Explorer
does not initiate duplicate transport; it observes cached state or `idle`.

- [ ] **Step 7: Run kernel, hydration, Explorer, and selection tests**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/kernel/object-extensions \
  src/modules/explorer/builders/buildModelTree.test.ts \
  src/modules/explorer/explorerSelection.test.ts \
  src/kernel/KernelProvider.test.ts
```

- [ ] **Step 8: Commit activation and Explorer state**

```bash
git commit -m "fix(control-room): scope object extensions to the active kernel"
```

---

### Task 11: Rebuild the Inspector as a scientifically complete analysis panel

**Files:**
- Modify: `apps/control-room/src/modules/inspector/extensions/topological-charge/TopologicalChargeExtensionPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/extensions/topological-charge/topologicalChargeModel.ts`
- Create: `apps/control-room/src/modules/inspector/extensions/topological-charge/TopologicalChargeControls.tsx`
- Create: `apps/control-room/src/modules/inspector/extensions/topological-charge/TopologicalChargeMethodSummary.tsx`
- Create: `apps/control-room/src/modules/inspector/extensions/topological-charge/TopologicalChargeProfileTable.tsx`
- Create: `apps/control-room/src/modules/inspector/extensions/topological-charge/TopologicalChargeQualitySection.tsx`
- Modify: `apps/control-room/src/design/styles/inspector.css`
- Modify: `apps/control-room/package.json`
- Create: `apps/control-room/scripts/smoke-topological-charge-inspector.mjs`
- Test: `apps/control-room/src/modules/inspector/extensions/topological-charge/topologicalChargeModel.test.ts`
- Create: `apps/control-room/src/modules/inspector/extensions/topological-charge/TopologicalChargeExtensionPanel.test.tsx`
- Test: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`

**Interfaces:**
- Consumes: typed resource hook, selection, session snapshot availability.
- Produces: controls, exact query, status/trust result, profile, diagnostics, provenance, warnings.

- [ ] **Step 1: Write red control and query tests**

Render the panel with a fake hook adapter. Assert defaults are on-demand,
`plane=auto`, `support=midplane`, and the v2 method. Change to `xz`,
`layer_profile`, `65`, and a snapshot; click Compute and assert the exact query.

- [ ] **Step 2: Write red presentation tests**

Cover every legal scientific status/trust pair and every separate resource
lifecycle state. Assert:

- diagnostic charge is visible for `under_resolved` without nearest integer;
- all warnings render in deterministic order;
- profile rows show `coordinate_m` and `integration_weight_m` with unit `m`
  and no spread-based truncation;
- support frame displays `u=+x`, `v=+z`, `n=-y` for `xz`;
- transport error is not rendered as scientific `ready`;
- stale prior data has a stale banner and no qualified badge;
- removed `polarity` text does not occur.

- [ ] **Step 3: Write red accessibility tests**

Assert labelled controls, keyboard-operable tabs/selects, table headers, live
status region, MathML accessible names, and no raw strings such as
`\\hat{\\mathbf m}` in visible text.

- [ ] **Step 4: Verify red**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/extensions/topological-charge
```

- [ ] **Step 5: Implement a controlled query model**

Keep draft controls local to the panel. The resource hook receives the last
submitted query in on-demand mode and the current query in continuous mode.
Changing on-demand controls marks the displayed result stale-for-query until
Compute; it does not silently reuse a result for different support.

- [ ] **Step 6: Implement complete warning and profile presentation**

Render at most 257 profile rows, matching the backend bound. No min/max-only
summary substitutes for the profile. Use tabular numeric formatting and expose
physical coordinate, integration weight, and per-cut status/trust.

- [ ] **Step 7: Implement quality and provenance sections**

Show valid/total triangles, exceptional count, max edge angle in degrees,
boundary deviation in degrees, component count, method version, resource
revision, field/mesh/domain ids, snapshot/stage, FEM order, source kind, and
computation time.

- [ ] **Step 8: Use shared primitives and token CSS**

Use existing Button, Tabs, Select, Switch/Checkbox, InspectorSection,
FeedbackBanner, and table primitives. Every CSS class has `fm-` prefix and all
colors consume `--fm-*` tokens.

- [ ] **Step 9: Prove viewport independence**

Add a component/integration test that records visualization controller state,
enables, computes, changes profile controls, and disables the extension. Assert
quantity, layers, camera, colorbar, and viewport active tab are unchanged.

Add `smoke:topological-charge-inspector` to `apps/control-room/package.json`.
The smoke script must exercise ready, under-resolved, unsupported, and stale
responses; save screenshots plus a machine-readable summary under
`.fullmag/reports/topological-charge-inspector/`; and assert that the WebGL
context is not lost and its drawing buffer remains non-zero.

- [ ] **Step 10: Run Inspector, Explorer, a11y, and targeted lint**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/extensions/topological-charge \
  src/modules/inspector/inspectorRegistry.test.tsx \
  src/modules/explorer
pnpm --dir apps/control-room exec eslint \
  src/modules/inspector/extensions/topological-charge \
  src/kernel/object-extensions \
  src/modules/explorer/ExplorerModule.tsx \
  --max-warnings=0
pnpm --dir apps/control-room smoke:topological-charge-inspector
```

- [ ] **Step 11: Commit the Inspector**

```bash
git commit -m "feat(control-room): present qualified topological charge analysis"
```

---

### Task 12: Add convergence oracles and cross-discretization fixtures

**Files:**
- Create: `crates/fullmag-api/src/analysis/topological_charge/test_fixtures.rs`
- Create: `examples/assets/topological_charge/fdm-neel-v1.json`
- Create: `examples/assets/topological_charge/fem-p1-regular-neel-v1.json`
- Create: `examples/assets/topological_charge/fem-p1-skew-neel-v1.json`
- Create: `examples/assets/topological_charge/exceptional-triangle-v1.json`
- Create: `scripts/validate_topological_charge_runtime.py`
- Create: `scripts/test_validate_topological_charge_runtime.py`
- Create: `docs/validation/topological-charge/README.md`
- Test: `crates/fullmag-api/src/analysis/topological_charge/test_fixtures.rs`
- Test: `scripts/test_validate_topological_charge_runtime.py`

**Interfaces:**
- Consumes: analytic Neel/Bloch/meron definitions and versioned runtime JSON.
- Produces: deterministic reference fixtures, convergence metrics, and validation evidence schema.

- [ ] **Step 1: Write analytic fixture tests**

Implement the Belavin-Polyakov field and analytic density from physics note
0940, plus an adaptive finite-support quadrature with absolute tolerance
`1e-10`. The reference module must not import or call the production triangle
kernel. Test unit norm, the closed disk integral, finite-rectangle quadrature,
canonical sign, an in-plane Bloch rotation, and reversed support orientation.
Keep polarity, vorticity, and helicity only as independent fixture-generator
parameters; none becomes a production response field.

For the displayed vorticity-`+1` convention, assert the disk reference
`Q(R)=-R^2/(R^2+lambda^2)` and the infinite-radius limit `-1`.

- [ ] **Step 2: Add FDM convergence test**

Evaluate `33`, `65`, and `129` samples. Compare each result with the independent
continuum integral on the exact finite support, assert errors `<0.15`, `<0.07`,
and `<0.035`, and require last-two empirical rate `>=0.8`, computed as
`log(e_coarse/e_fine)/log(2)` for the nested factor-two refinement.

- [ ] **Step 3: Add regular and skew FEM P1 convergence test**

Generate three tetrahedral refinements, evaluate exact midplane cuts, and assert
monotonic error, final error `<0.05`, last-two rate `>=0.8`, and regular/skew
final difference `<0.03`.

- [ ] **Step 4: Add cross-discretization test**

At matched support and finest resolution assert FDM/FEM difference `<0.05`,
same sign, same canonical frame, and same boundary trust.

- [ ] **Step 5: Define evidence JSON schema**

Validator output contains method/schema version, git commit, runtime identity,
requested/resolved backend/device/precision, mesh ids, resolutions, charges,
analytic errors, convergence rates, trust, diagnostics, and pass/fail gates.

- [ ] **Step 6: Add validator unit tests**

Test passing evidence, wrong sign, missing refinement, insufficient rate,
unqualified trust, CPU fallback hidden in strict GPU evidence, and schema-version
mismatch.

- [ ] **Step 7: Run convergence and validator tests**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api topological_charge_convergence -- --nocapture
python3 -m unittest scripts/test_validate_topological_charge_runtime.py
```

- [ ] **Step 8: Commit oracles and validator**

```bash
git commit -m "test(analysis): add topological charge convergence oracles"
```

---

### Task 13: Add repository-managed FDM and FEM runtime proof

**Files:**
- Modify: `justfile`
- Create: `examples/topological_charge_runtime.py`
- Create: `scripts/capture_topological_charge_runtime.py`
- Create: `scripts/test_capture_topological_charge_runtime.py`
- Modify: `scripts/validate_topological_charge_runtime.py`
- Create: `docs/validation/topological-charge/fdm-runtime-v2.json`
- Create: `docs/validation/topological-charge/fem-p1-runtime-v2.json`
- Create: `docs/validation/topological-charge/cross-backend-v2.json`

**Interfaces:**
- Consumes: built Fullmag runtime and analytic fixtures.
- Produces: authoritative runtime evidence for FDM, FEM P1, and cross-backend comparison.

- [ ] **Step 1: Inspect and reuse existing managed FEM recipes**

Before writing commands, identify the exact container wrapper used by
`ensure-managed-fem-runtime` and related verification recipes. The new recipe
must delegate to that owner; it must not assemble raw Docker or host CMake.

- [ ] **Step 2: Write the failing runtime validator invocation**

Add the three final recipe names immediately, with their validators pointed at
`.fullmag/reports/topological-charge/{fdm,fem-p1,cross-backend}/summary.json`.
Run them before implementing capture; each must fail because its summary is
absent. `scripts/capture_topological_charge_runtime.py` accepts
`--api-base-url`, `--object-id`, `--scenario`, and `--output`, waits for
`/v2/sessions/current/status`, sends the exact midplane/profile queries, records
HTTP request and response bodies, and refuses non-v2 schema or missing
provenance.

- [ ] **Step 3: Implement the FDM runtime scenario**

The FDM recipe uses the repository-built `fullmag` binary, launches
`examples/topological_charge_runtime.py` interactively with
`backend=fdm`, `device=cpu`, and an isolated API port, and owns only that child
PID. It waits for API readiness, runs the capture script for uniform,
single-skyrmion, and two-object isolation cases, terminates its child in a trap,
then validates sign, charge, trust, object isolation, and requested/resolved
execution provenance.

- [ ] **Step 4: Implement the managed FEM P1 runtime scenario**

Call `just ensure-managed-fem-runtime`, then use the same launch/cleanup pattern
as `run-viewport-3d-mixed-target-smoke` with `gpu_runtime_bin`, an isolated API
port, `backend=fem`, `FULLMAG_FEM_EXECUTION=cpu`, and fallback-forbidden
provenance. Build and run regular plus skewed P1 films, materialize `m`, call
exact midplane and profile queries through the capture script, and save full
provenance. Include compact `magnetic_only` shared-domain coverage. The recipe
must never launch raw Docker, host CMake, or a host-native FEM binary.

- [ ] **Step 5: Implement the cross-backend recipe**

Consume the two evidence files and enforce the `<0.05` matched-support charge
difference and identical sign/frame/trust gates.

- [ ] **Step 6: Run authoritative recipes**

```bash
just verify-topological-charge-fdm-runtime
just verify-topological-charge-fem-runtime
just verify-topological-charge-cross-backend
```

Expected: every recipe exits zero and evidence records no hidden fallback.

Also run:

```bash
python3 -m unittest scripts/test_capture_topological_charge_runtime.py
python3 -m unittest scripts/test_validate_topological_charge_runtime.py
```

- [ ] **Step 7: Commit recipes and evidence**

```bash
git commit -m "test(runtime): qualify planar topological charge"
```

---

### Task 14: Remove v1 leftovers and run production gates

**Files:**
- Delete: old `TopologicalChargeInput`, `TopologicalChargeTriangleInput`,
  `compute_topological_charge_grid`, and `compute_topological_charge_triangles`
  implementations when `crates/fullmag-api/src/analysis/topological_charge.rs`
  is replaced by the Task 2 module directory
- Verify deleted: v1 query defaults, arbitrary method branching,
  preview/latest source selection, layer-face discovery, and FDM global-grid
  helpers no longer exist after Task 7 deletes
  `crates/fullmag-api/src/router_v2/handlers/analysis/extensions.rs`
- Update: `docs/physics/0940-topological-charge-observable.md` checklist only after proof
- Verify unchanged banner: `docs/plans/active/object-extensions-topological-charge-implementation-plan-2026-06-26-pl.md` remains `SUPERSEDED`
- Update only after an approved contract correction: `docs/specs/resource-first-control-room-api-v2.md`
- Update only after an approved contract correction: `docs/specs/frontend-v2/13-inspector-and-property-editing.md`

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: one implementation path, one schema, one resource hook, one UI meaning, and complete verification evidence.

- [ ] **Step 1: Search for stale vocabulary and paths**

Run:

```bash
rg -n "polarity|berg_luescher_fem_layers|berg_luescher_fem_slice_grid|fem_plane_cut_solid_angle|InsufficientSamples|IMPLEMENTED v1" \
  crates/fullmag-api apps/control-room docs/physics docs/specs docs/plans/active
```

Expected: only explicit migration/history references remain; runtime and UI use v2 vocabulary.

- [ ] **Step 2: Search for transport and state regressions**

```bash
rg -n 'fetch\(|"/v2/|/v1/live/current|bootstrap|poll' \
  apps/control-room/src/modules/inspector/extensions/topological-charge \
  apps/control-room/src/kernel/object-extensions \
  apps/control-room/src/kernel/resources/studyRuntimeResources.ts \
  apps/control-room/src/modules/explorer
rg -n "let activationSnapshot|setGlobalObjectExtensionEnabled" apps/control-room/src
```

Expected: both searches return no matches: no topological-charge component
transport, endpoint literal, global activation singleton, v1 route, bootstrap,
or polling fallback. The broader architecture gate in Step 5 remains
authoritative for the rest of Control Room.

- [ ] **Step 3: Run backend contract suites**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api topological_charge -- --nocapture
CARGO_TARGET_DIR=/tmp/fullmag-topological-charge-target \
  cargo test -p fullmag-api router_v2 --no-fail-fast
```

Expected: zero failures.

- [ ] **Step 4: Regenerate and verify frontend API**

```bash
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room check:api-hygiene
```

Expected: regeneration is clean on a second run and API hygiene passes.

- [ ] **Step 5: Run all Control Room quality gates**

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room check:architecture-hygiene
```

Expected: zero TypeScript errors, ESLint warnings, test failures, or architecture violations. Unrelated pre-existing failures must be separated before this task can be closed.

- [ ] **Step 6: Run managed runtime proof again**

```bash
just verify-topological-charge-fdm-runtime
just verify-topological-charge-fem-runtime
just verify-topological-charge-cross-backend
```

Expected: all three authoritative proofs pass on the final code.

- [ ] **Step 7: Perform visual/browser verification**

Run:

```bash
pnpm --dir apps/control-room smoke:topological-charge-inspector
```

The smoke must open a magnetic object, enable the extension, compute midplane
and profile modes, switch snapshots, observe stale state, test keyboard
controls, and confirm viewport canvas, field quantity, camera, layers, and
colorbar remain unchanged. It must emit ready, under-resolved, unsupported,
and stale screenshots plus `.fullmag/reports/topological-charge-inspector/summary.json`.

- [ ] **Step 8: Update qualification checklist with evidence links**

Only after Steps 3-7 pass, mark implementation/OpenAPI/UI/runtime checklist
items in physics note 0940 complete and link the exact evidence JSON files.

- [ ] **Step 9: Audit the final diff**

Verify every changed line traces to this plan. Confirm generated files match
their sources, no unrelated file is staged, and no historical document still
claims v1 is production-qualified.

- [ ] **Step 10: Commit production qualification**

Run `git diff --cached --name-only` separately, then commit only the final
qualification/docs cleanup:

```bash
git commit -m "docs(analysis): qualify planar topological charge"
```

## Final acceptance matrix

| Requirement | Owning task | Required evidence |
|---|---:|---|
| canonical sign on `xy/xz/yz` | 2, 5, 6 | orientation and reversed-triangle tests |
| deterministic `auto` plane | 5, 6, 7 | thinnest-axis and `xy/xz/yz` tie-order tests |
| no false polarity | 1, 11, 14 | OpenAPI/UI absence and stale-vocabulary scan |
| no `ready` without valid triangles | 2, 7 | partial-support kernel and router tests |
| exceptional and under-resolved handling | 2, 3, 7 | kernel quality and status tests |
| exact general FEM midplane | 5 | single-tetra midplane test |
| compact `magnetic_only` FEM | 4, 5 | full/compact parity tests and managed runtime |
| P1-only enforcement | 5, 7 | `fe_order=2` typed rejection |
| object-scoped FDM | 4, 6 | two-object fixture and runtime proof |
| correct full-thickness FDM/FEM profile quadrature | 6 | explicit control-volume and midpoint-weight tests |
| FEM profile avoids `O(T*K)` rescans | 6 | instrumented interval-sweep complexity test |
| snapshot correctness | 4, 7 | two-snapshot result/cache tests |
| provenance race and stale lifecycle | 7, 9 | HTTP `409` plus hook stale-state tests |
| bounded cache, single-flight, and short session lock | 7 | invocation counter, concurrent-miss, cleanup, and writer-lock tests |
| closed typed OpenAPI | 1, 8 | generated schema assertions |
| exact resource invalidation | 9 | exact/broad/scene/mesh/snapshot tests |
| per-session activation | 10 | two-controller and session reset tests |
| truthful Explorer status | 10 | state matrix tests |
| complete Inspector controls/profile | 11 | component, model, and a11y tests |
| viewport independence | 11, 14 | controller assertion and browser smoke |
| FDM/FEM convergence | 12 | convergence evidence |
| actual managed FEM runtime | 13, 14 | container-backed `just` evidence |
| no stale v1 architecture | 14 | source scans and final diff audit |

## Execution boundary

Do not start Task 2 until Task 1 schema review is accepted. Do not start
frontend Tasks 8-11 until backend Task 7 has a stable OpenAPI operation. Do not
claim production readiness before Task 14 passes all unit, integration,
generation, frontend, browser, managed FDM, managed FEM, and cross-backend
gates.
