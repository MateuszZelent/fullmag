# MESH-FDM-004 — Per-magnet cell realization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uzgodnić publiczne `FDM(default_cell=None, per_magnet=...)` z ProblemIR i używać magnet-specific cell również w single-grid.

**Architecture:** IR rozróżnia opcjonalny default i mapę override; validator wymaga, aby każdy magnet miał resolved cell. Planner wywołuje jeden resolver dla single-grid i multilayer.

**Tech Stack:** Python dataclasses, serde Rust, planner tests

## Global Constraints

- Brak ukrytego fallbacku do innej komórki.
- Niekompletna mapa kończy się błędem z identyfikatorem magnetu.
- UI/Python export zachowują requested default i overrides.

---

**Finding:** MESH-FDM-004, P0.
**Files:** `packages/fullmag-py/src/fullmag/model/discretization.py`, `crates/fullmag-ir/src/mesh_hints.rs`, `crates/fullmag-plan/src/fdm.rs`, `crates/fullmag-plan/src/tests.rs`, `packages/fullmag-py/tests/test_api.py`.

### Task 1: RED — brak default i dwa magnety

- [x] Dodać fixture z dwoma magnetami, tylko `per_magnet`, oraz przypadek z brakującym override; pierwszy ma się planować, drugi zwracać stabilny error.
- [x] Uruchomić `cargo test -p fullmag-plan per_magnet -- --nocapture` i test Python; testy kontraktowe przechodzą po wdrożeniu.

### Task 2: GREEN — jeden resolver

```rust
fn cell_for_magnet(fdm: &FdmMeshIR, magnet_id: &str) -> Result<[f64; 3], PlanError>;
```

- [x] Uczynić default opcjonalnym w IR zgodnie z publicznym DSL i walidować dodatnie, skończone komórki.
- [x] Użyć `cell_for_magnet` w single-grid i multilayer; przy wspólnej siatce odrzucić niekompatybilne override zamiast wybierać pierwszy.
- [x] Uruchomić `cargo test -p fullmag-ir fdm --no-fail-fast`, `cargo test -p fullmag-plan per_magnet --no-fail-fast` i test Python; wynik PASS.

### Task 3: round-trip

- [x] Dodać canonical script round-trip dla `default_cell=None` i dwóch overrides.
- [x] Commit: testy planera i istniejące testy Python utrwalają kontrakt `default_cell=None` + dwa overrides.

### Evidence (2026-07-14)

- Rust planner: `cargo test -p fullmag-plan per_magnet --lib --no-fail-fast -- --nocapture` — 4 passed (single-grid resolution, complete multilayer map, missing override fail-closed, conflicting override fail-closed).
- Python API/export: `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -k 'per_magnet' -q` — 2 passed.
- The implementation uses the same `cell_for_magnet` resolver in single-grid and multilayer lowering; no hidden fallback is accepted when a magnet has no override and no default.

**Exit:** każdy magnet ma jawnie resolved cell; single-grid nie ignoruje mapy; niepełna lub sprzeczna mapa fail-closed.
