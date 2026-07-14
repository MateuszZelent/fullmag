# MESH-REGION-012 — Region membership mesh identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membership i region quality nigdy nie łączą nowej definicji regionu ze starym meshem bez jawnego statusu stale.

**Architecture:** Endpoint przyjmuje/rozwiązuje konkretną mesh generation i zwraca source scene/region revision, topology hash i `current|stale`. Realized membership pochodzi z certyfikowanej mapy/elementów; analityczna projekcja jest osobnym, jawnie oznaczonym trybem preview.

**Tech Stack:** Rust API v2 schemas/handlers, OpenAPI, binary data plane

## Global Constraints

- `realized` i `preview` nie mogą używać tego samego statusu.
- Current wymaga zgodności mesh generation, region revision i marker certificate.
- Heavy membership arrays pozostają na binary/scoped data plane.

---

**Finding:** MESH-REGION-012, P0.
**Dependencies:** MESH-REGION-006/011.

### Task 1: RED stale combinations

- [ ] Dodać API tests: current scene/current mesh, edited region/stale mesh, obca topology hash, brak marker certificate i explicit old-generation inspection.
- [ ] W stale case oczekiwać 409/stable reason dla `realized current`; explicit historical scope może zwrócić dane oznaczone stale.

### Task 2: schema i handler

```rust
struct RegionMembershipIdentity {
    mesh_generation_id: String,
    topology_hash: String,
    region_revision: u64,
    realization: MembershipRealization,
    freshness: ResourceFreshness,
}
```

- [x] Dodać identity do schema/OpenAPI i ETag; handler publikuje topology/generation oraz niezależną membership revision.
- [x] Oddzielić certified realized membership od analytic preview: `realization=realized|analytic_preview`, `freshness=current|preview`.
- [ ] Usunąć możliwość domyślnego pobrania dowolnego `snapshot.fem_mesh` dla current request.

### Task 3: API/data-plane proof

- [ ] Regenerować transport, uruchomić API tests/hygiene i snapshot tests; sprawdzić 409/stale response oraz historical retrieval.
- [ ] Commit: `git add crates/fullmag-api crates/fullmag-session apps/control-room/src/shared/api && git commit -m "fix(api): bind region membership to mesh identity"`.

### Evidence (2026-07-14, identity publication slice)

- `MeshRegionMembershipResource` now publishes topology fingerprint, mesh generation ID, independent `region_membership_revision`, freshness and realization semantics.
- Analytic geometry projection is explicitly marked `preview`/`analytic_preview`; mesh-part and object-segment paths are `current`/`realized`.
- API membership focused suite: 7 passed.
- OpenAPI v2 regenerated, TypeScript schema synchronized, and `./scripts/ci/contract_guard.sh --strict` passed.
- Historical mesh selection, marker-certificate binding, stale 409 semantics, binary scoped membership and browser proof remain open; MESH-REGION-012 is not production-closed.

**Exit:** client zawsze wie, czy membership odpowiada bieżącemu regionowi i bieżącej topologii.
