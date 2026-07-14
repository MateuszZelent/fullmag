# MESH-FDM-006 — Single-grid top-level translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zachować top-level `Translate` w single-grid FDM tak samo jak w multilayer.

**Architecture:** Wspólne geometry lowering zwraca transform-aware shape; różnice między single-grid i multilayer dotyczą układu domen, nie semantyki transformacji.

**Tech Stack:** Rust geometry/planner tests

## Global Constraints

- Nie kopiować drugiego algorytmu translacji.
- Translation wpływa na bounds, origin, maskę i provenance.
- Wynik bez translacji musi pozostać bitowo zgodny.

---

**Finding:** MESH-FDM-006, P1.
**Files:** `crates/fullmag-plan/src/geometry.rs`, `crates/fullmag-plan/src/fdm.rs`, `crates/fullmag-plan/src/tests.rs`.

### Task 1: RED

- [x] Dodano single-grid fixture `Translate(Box)` z niezerowymi przesunięciami XYZ i porównaniem origin oraz aktywnej komórki z tym samym loweringiem multilayer.
- [x] Uruchomiono `cargo test -p fullmag-plan fdm_translated_single_grid_asset_matches_multilayer_origin -- --nocapture`; PASS.

### Task 2: GREEN

```rust
GeometryShape::Translate { offset_m: [f64; 3], child: Box<GeometryShape> }
```

- [x] `GeometryShape::Translate` zachowuje offset; `contains` używa inverse translation, a bounds forward translation.
- [x] Single-grid i multilayer korzystają z tej samej transform-aware reprezentacji geometrii.
- [x] `cargo test -p fullmag-plan geometry --lib --no-fail-fast` — 4 passed; `cargo test -p fullmag-plan fdm --lib --no-fail-fast` — 43 passed.

### Task 3: commit

- [x] Implementacja została utrwalona w istniejącym commicie zmian plannerowych; bieżący commit dokumentacyjny aktualizuje evidence bez ponownego dotykania kodu.

## Evidence update

- Single-grid precomputed asset przesuwa `origin_m` o dokładny wektor `Translate` i zachowuje tę samą aktywną komórkę co lowering multilayer.
- Boundary SDF i active mask są sprawdzane w tych samych world coordinates; test regresyjny obejmuje również finite-height translated cylinder.
- Managed FDM artifact/browser proof nie jest wymagany do semantycznego zamknięcia tego lokalnego kontraktu, ale pozostaje częścią globalnego gate MESH-GATE-001.

**Exit:** przesunięta geometria ma przesuniętą maskę i origin w single-grid; single/multilayer używają wspólnej semantyki.
