# MESH-API-004 — Certificate-aware ETag and revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zmieniać ETag/revision przy każdej zmianie treści topology/certificate, nie tylko liczby par.

**Architecture:** ETag jest pochodną canonical certificate fingerprint + mesh generation; websocket invaliduje, a kolejne HTTP GET pobiera authoritative snapshot.

**Tech Stack:** Rust API caching, realtime invalidation, React resource hooks

## Global Constraints

- ETag nie zależy od kolejności serializacji map.
- Taka sama liczba par z innym residualem musi zmienić ETag.
- Realtime event nie niesie pełnego payloadu.

---

**Finding:** MESH-API-004, P1.

### Task 1: RED cache cases

- [ ] Dodać tests: changed residual, changed pair IDs, changed topology hash, stale/current transition przy stałej pair count; każdy zmienia ETag i 304 behavior.
- [ ] Dodać UI hook test invalidation -> conditional GET -> new snapshot.

### Task 2: fingerprint identity

```rust
fn periodic_pairs_etag(mesh_generation: &str, certificate_fingerprint: &str) -> EntityTag;
```

- [ ] Zastąpić source/count identity certificate fingerprint; emitować revision event po commit mesh/certificate.
- [ ] Zaktualizować `RealtimeInvalidationBridge.ts` i `studyRuntimeResources.ts` wyłącznie do invalidation/refetch.
- [ ] Uruchomić API i focused UI resource tests; PASS.

### Task 3: governance

- [ ] Uaktualnić ADR `0011-resource-first-api.md` o identity; uruchomić resource-first strict gates.
- [ ] Commit: `git add docs/adr/0011-resource-first-api.md crates/fullmag-api crates/fullmag-cli apps/control-room && git commit -m "fix(api): key periodic resources by certificate fingerprint"`.

**Exit:** każda semantyczna zmiana certificate unieważnia cache; 304 występuje wyłącznie dla identycznego snapshotu.

## Evidence update (2026-07-14)

- [x] Periodic-pairs ETag is now a SHA-256 strong validator over mesh generation, persisted certificate fingerprint, and a recursively canonicalized complete resource payload; pair count alone is no longer an identity input.
- [x] `mesh_periodic_pairs_etag_changes_when_residual_changes` proves a same-cardinality residual change rejects the old conditional request and returns a fresh 200 snapshot; the unchanged snapshot returns 304.
- [x] Unit tests prove certificate, generation, status/reason, and map insertion-order changes are handled deterministically.
- [x] The API consumes `certificate_fingerprint` from `mesh/periodic_pairs.v1.json` when the authoritative persisted artifact matches the live topology; live reconstruction remains an explicit compatibility path when no artifact is available.
- [x] Mesh commit realtime changes now advertise `/v2/sessions/current/meshing/mesh/periodic_pairs.v1`; the browser bridge invalidates that exact resource after `latest-successful` mesh commit, keeping websocket payloads thin and forcing an authoritative HTTP refetch.
- [x] RED/GREEN evidence: the API realtime contract initially failed because the periodic-pairs fetch was absent; after the fix `cargo test -p fullmag-api realtime_change_tests::realtime_changes_include_mesh_and_scene_resource_fetches` passed, and the focused `RealtimeInvalidationBridge.test.ts` suite passed 31/31 with the new invalidation assertion.
- [ ] UI invalidation/browser and managed resource gates remain open; those gates are tracked by MESH-UI-005 and MESH-GATE-001.
