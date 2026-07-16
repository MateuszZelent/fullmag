# MESH-API-001 — Canonical periodic validation status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wyprowadzać status periodic-pairs z całego v6, z poprawną klasyfikacją magnetic, airbox i mixed-domain.

**Architecture:** API nie rewaliduje fizyki; mapuje canonical certificate status i diagnostykę do resource v2. `valid` wymaga zero unpaired/mixed oraz wszystkich topology gates.

**Tech Stack:** Rust API/OpenAPI, resource-first v2 tests

## Global Constraints

- Jeden enum statusu w backendzie i generated frontend types.
- Mixed magnetic-air jest osobną kategorią błędu.
- HTTP resource zachowuje certificate revision/fingerprint.

---

**Finding:** MESH-API-001, P0.
**Dependency:** MESH-PBC-FEM-002.

### Task 1: RED handler tests

- [x] Dodano RED/GREEN cases dla residual OK + unpaired node oraz mixed magnetic/air pair; oba nie są już raportowane jako `valid`.
- [x] Dodać invalid face oraz stale source-scene cases; testy odróżniają `invalid` od `stale`.

### Task 2: canonical mapping

```rust
pub enum PeriodicValidationStatus { Valid, Invalid, Stale, Unavailable }
```

- [x] Handler nie używa już residual-only statusu: unpaired boundary nodes są `unpaired_boundary_nodes`, a pary mixed-domain nie są liczone jako magnetic/airbox i kończą jako `mixed_domain_pair`.
- [x] Podpiąć v6 aggregate status, reasons, certificate revision/fingerprint, topology fingerprint i source-scene revision do resource/OpenAPI.

### Task 3: generated consumers

- [ ] Regenerować klienta i uruchomić `typecheck`, `test`, `check:api-hygiene` (blokada środowiska: brak `apps/control-room/node_modules`, `openapi-typescript` niedostępne).
- [x] Commit: backend/schema/generated OpenAPI/TS i testy są zapisane w osobnym logicznym commicie.

**Exit:** `valid` jest możliwe tylko dla kompletnego, current v6; mixed/unpaired/stale mają odrębne diagnostics.

### Evidence (2026-07-14, partial)

- `env CARGO_TARGET_DIR=/tmp/fullmag-api-periodic cargo test -p fullmag-api router_v2::tests::mesh_periodic_pairs --no-fail-fast -- --nocapture` — 4 passed, 0 failed.
- `cargo test -p fullmag-api mesh_periodic_pairs --no-fail-fast -- --nocapture` — 7 passed, including accepted/invalid/stale aggregate cases.
- `MeshPeriodicPairsResource` now publishes aggregate status, reasons, v6 certificate fingerprint, topology fingerprint, certificate revision, mesh generation and source scene revision; pair payloads publish explicit node pairs and mixed-domain count.
- `./scripts/ci/contract_guard.sh --strict` — passed; frontend typecheck/test remain open solely because dependencies are absent in this worktree.
