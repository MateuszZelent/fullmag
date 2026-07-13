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

