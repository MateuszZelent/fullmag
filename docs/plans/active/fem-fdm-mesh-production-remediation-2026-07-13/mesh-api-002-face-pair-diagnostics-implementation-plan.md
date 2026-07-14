# MESH-API-002 — Certified face-pair diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usunąć nearest-centroid face reconstruction z API i opublikować certyfikowane face pairs wraz z unpaired counts i residuals.

**Architecture:** Handler czyta artifact/certificate generated upstream. JSON przenosi diagnostykę i identity; ciężka geometria linków może używać binary data plane.

**Tech Stack:** Rust API schemas/handlers, OpenAPI, binary resource conventions

## Global Constraints

- API nie zgaduje par, których nie ma w certificate.
- Każda face pair ma stable IDs, vertex mapping, domain role i residuals.
- Brakujące faces są jawne, nie usuwane z listy bez śladu.

---

**Finding:** MESH-API-002, P0.
**Dependencies:** MESH-PBC-FEM-003 i MESH-API-001.

### Task 1: RED

- [x] Dodano fixture z inną triangulacją/odległym centroidem; przed zmianą handler publikował fałszywą nearest-centroid face pair z `normal_dot=0`.
- [ ] Dodać pełne v6 IDs/counts oraz jawne unmatched-face resource; to wymaga certificate payload w `FemMeshPayload`.

### Task 2: resource mapping

```rust
pub struct PeriodicFacePairResponse { pub source_face_id: u64, pub destination_face_id: u64, pub max_vertex_residual_m: f64, pub normal_dot: f64 }
```

- [x] Matching loop odrzuca kandydatów z niefinite/excessive centroid residual względem zadeklarowanej tolerancji, więc nie publikuje fałszywej pary.
- [x] Usunąć całkowicie nearest-centroid reconstruction i mapować certified pairs oraz aggregate unpaired counts.
- [ ] Dla dużych payloadów dodać scoped binary link zgodny z resource-first spec, nie rozszerzać thin status.
- [x] Uruchomić API/OpenAPI tests; PASS.

### Task 3: commit

- [ ] Commit: `git add crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs crates/fullmag-api/src/schemas/mesh.rs crates/fullmag-api/src/router_v2/tests.rs && git commit -m "fix(api): serve certified periodic face diagnostics"`.

**Exit:** API response jest deterministycznym widokiem certificate, bez centroid reconstruction i cichego dropu.

### Evidence (2026-07-14, partial)

- `cargo test -p fullmag-api router_v2::tests::mesh_periodic_pairs --no-fail-fast -- --nocapture` — 5 passed, 0 failed.
- Current API still lacks upstream v6 certified face IDs/residuals; the present guard is fail-closed protection against false positives, not final certificate mapping.

### Evidence update (2026-07-14, certificate-backed API slice)

- [x] API no longer contains nearest-centroid face reconstruction; it rebuilds the backend-neutral `MeshIR` certificate from explicit node/face topology and publishes only v6-certified pairs.
- [x] Face resources expose stable global IDs, explicit vertex bijections, translation/area residuals, normal orientation and marker identity.
- [x] Pair resources expose source/destination unpaired-face counts and explicit `unpaired_boundary_faces` status while preserving node diagnostics.
- [x] Legacy artifact fallback remains deserializable via serde defaults for the new diagnostics fields.
- [x] `cargo test -p fullmag-api mesh_periodic_pairs --no-fail-fast -- --nocapture` — 7 passed.
- [x] Generated OpenAPI v2 JSON and Control Room TypeScript schema were updated.
- [x] Runner `periodic_pairs.v1.json` now persists `mesh_generation_id` and `certificate_fingerprint` alongside the v6 certificate.
- [x] API prefers the persisted certificate artifact when its topology fingerprint matches the live mesh; mismatched artifacts are rejected and never exposed as current diagnostics.
- [x] Persisted `periodic_pairs.v1.json` artifacts carry `source_scene_revision`; the API rejects a stale artifact when a live mesh is present and falls back to the authoritative live resource builder, which reports `stale` rather than exposing the artifact as current. Commit `208d6bc1` carries the production check and direct artifact stale-scene test.
- [x] Added a matching-topology live-mesh regression test covering the artifact-preferred branch and authoritative fallback (`36250846`). `cargo test -p fullmag-api mesh_periodic_pairs --no-fail-fast -- --nocapture` — 9 passed.
- [x] Added `/v2/sessions/current/meshing/mesh/periodic_pairs.v1.bin` as the resource-first data-plane projection. The `FMPP.v1` codec has a fixed little-endian header, explicit validation status/revision, stable pair-id ordering, and complete node/face vertex mappings; JSON remains the control-plane diagnostic projection.
- [x] Binary responses use `application/vnd.fullmag.periodic-pairs.v1`, strong representation-specific ETags with `304`, optional single-range `206/416`, and mesh/certificate identity headers.
- [x] Backend route and utoipa OpenAPI path registration are present; focused API coverage proves 200 payload magic/version, deterministic repeated bytes, conditional `304`, and the generated OpenAPI content type (`mesh_periodic_pairs` — 10 passed; `openapi_contains_binary_periodic_pairs_path` — 1 passed).
- [ ] Control Room generated path/types and managed runtime evidence remain pending for the bounded backend-only slice.
