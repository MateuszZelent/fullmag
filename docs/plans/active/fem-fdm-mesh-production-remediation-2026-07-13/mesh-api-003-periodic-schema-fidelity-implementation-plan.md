# MESH-API-003 — Periodic certificate schema fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zachować w typed API wszystkie fields potrzebne do walidacji i inspekcji v6.

**Architecture:** OpenAPI schema jest lossless control-plane projection certyfikatu; heavy node/face arrays są scoped resources. Generated types zastępują ręczne stringi/statusy.

**Tech Stack:** Rust schemas/OpenAPI, generated TypeScript client

## Global Constraints

- Schema zawiera aggregate status, topology/certificate fingerprint, mixed/unpaired counts i links do pairs.
- Brak ręcznie utrzymywanych duplikatów typów w UI.
- Zmiana przechodzi pełny API hygiene chain.

---

**Finding:** MESH-API-003, P1.

### Task 1: schema diff tests

- [x] Dodać API snapshot z node pairs, face metrics, mixed domain, unpaired counts, topology hash i validation reasons.

### Task 2: schema propagation

- [x] Rozszerzyć `crates/fullmag-api/src/schemas/mesh.rs` i `openapi_v2.rs`; handler mapuje node pairs, face metrics, mixed/unpaired counts, aggregate status i fingerprints bez syntetyzowania topology.
- [ ] Uruchomić `pnpm --dir apps/control-room generate:api`; brak `node_modules` uniemożliwił uruchomienie generatora, więc wygenerowany JSON i typy zostały zsynchronizowane ręcznie z aktualnym OpenAPI.
- [x] Uruchomić `cargo test -p fullmag-api mesh_periodic_pairs --no-fail-fast` oraz API hygiene; 7 testów i contract guard PASS. Frontend typecheck/test pozostają otwarte z powodu braku zależności.

### Task 3: commit

- [x] Commit: backend/schema/OpenAPI/generated types/testy zapisane w osobnym logicznym commicie.

**Exit:** typed response nie traci żadnego field potrzebnego Inspectorowi/viewportowi do odróżnienia valid, invalid, stale i unavailable.

### Evidence (2026-07-14)

- `cargo test -p fullmag-api mesh_periodic_pairs --no-fail-fast -- --nocapture` — 7 passed.
- `./scripts/ci/contract_guard.sh --strict` — passed.
- `MeshPeriodicPairResource` publishes explicit node pairs, mixed-domain pair count, unpaired node/face counts and v6 face metrics; `MeshPeriodicPairsResource` publishes typed aggregate `PeriodicValidationStatus`, reasons, topology/certificate fingerprints and source identity.
