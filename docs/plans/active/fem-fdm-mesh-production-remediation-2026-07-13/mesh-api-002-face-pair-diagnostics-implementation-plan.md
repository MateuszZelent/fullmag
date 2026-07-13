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

- [ ] Dodać handler fixtures dla bliskich centroidów z inną triangulacją, unmatched source/destination i excessive face residual.
- [ ] Oczekiwać dokładnych v6 IDs/counts; uruchomić focused API tests i potwierdzić FAIL.

### Task 2: resource mapping

```rust
pub struct PeriodicFacePairResponse { pub source_face_id: u64, pub destination_face_id: u64, pub max_vertex_residual_m: f64, pub normal_dot: f64 }
```

- [ ] Usunąć matching loop z handlera; mapować certified pairs i aggregate unpaired counts.
- [ ] Dla dużych payloadów dodać scoped binary link zgodny z resource-first spec, nie rozszerzać thin status.
- [ ] Uruchomić API/OpenAPI tests; PASS.

### Task 3: commit

- [ ] Commit: `git add crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs crates/fullmag-api/src/schemas/mesh.rs crates/fullmag-api/src/router_v2/tests.rs && git commit -m "fix(api): serve certified periodic face diagnostics"`.

**Exit:** API response jest deterministycznym widokiem certificate, bez centroid reconstruction i cichego dropu.

