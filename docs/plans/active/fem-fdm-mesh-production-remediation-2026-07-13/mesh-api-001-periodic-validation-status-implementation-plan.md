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

- [ ] W `crates/fullmag-api/src/router_v2/tests.rs` dodać cases: residual OK + unpaired node, mixed pair, invalid face, stale fingerprint; żaden nie może być `valid`.
- [ ] Uruchomić `cargo test -p fullmag-api periodic_pairs -- --nocapture`; nowe tests mają FAIL.

### Task 2: canonical mapping

```rust
pub enum PeriodicValidationStatus { Valid, Invalid, Stale, Unavailable }
```

- [ ] W `handlers/meshing/mesh.rs` usunąć residual-only status i mapować v6 aggregate status; publikować counts per domain i reasons.
- [ ] Uruchomić API tests i OpenAPI generation; PASS.

### Task 3: generated consumers

- [ ] Regenerować klienta i uruchomić `typecheck`, `test`, `check:api-hygiene`.
- [ ] Commit: `git add crates/fullmag-api apps/control-room/src/kernel/api/generated && git commit -m "fix(api): expose canonical periodic validation status"`.

**Exit:** `valid` jest możliwe tylko dla kompletnego, current v6; mixed/unpaired/stale mają odrębne diagnostics.

