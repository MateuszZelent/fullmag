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

- [ ] Dodać API snapshot z node pairs, face metrics, mixed domain, unpaired counts, topology hash i validation reasons; current response ma FAIL asercje kompletności.

### Task 2: schema propagation

- [ ] Rozszerzyć `crates/fullmag-api/src/schemas/mesh.rs` i `openapi_v2.rs`; handler mapuje wszystkie fields bez default fabrication.
- [ ] Uruchomić `pnpm --dir apps/control-room generate:api`; usunąć ręczne shadow types i użyć generated enum/interfaces w facade/hooks.
- [ ] Uruchomić `cargo test -p fullmag-api periodic_pairs --no-fail-fast` oraz frontend typecheck/test/API hygiene; PASS.

### Task 3: commit

- [ ] Commit: `git add crates/fullmag-api apps/control-room/src/kernel/api && git commit -m "feat(api): preserve periodic certificate fidelity"`.

**Exit:** typed response nie traci żadnego field potrzebnego Inspectorowi/viewportowi do odróżnienia valid, invalid, stale i unavailable.

