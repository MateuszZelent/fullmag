# MESH-REGION-007 — FDM owner transform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regiony object-frame, texture i pola materiałowe FDM są próbkowane w poprawnych współrzędnych ownera po translacji, rotacji i wspieranym skalowaniu.

**Architecture:** Planner zachowuje transform ownera i wylicza `position_object = inverse(T_owner) * position_world`. Ten sam sampler obsługuje region shape, spatial fields i texture; unsupported non-rigid transform jest odrzucany w validation.

**Tech Stack:** Rust authoring adapter/ProblemIR/FDM planner

## Global Constraints

- Nie piec transformacji osobno w każdym konsumencie.
- World-frame i CSG pozostają fail-closed, dopóki capability nie zostanie jawnie rozszerzone.
- CPU reference jest oracle dla maski i współczynników.

---

**Finding:** MESH-REGION-007, P1.

### Task 1: RED — transform matrix

- [x] Dodać translated-owner regression dla object-frame box membership; `cargo test -p fullmag-plan --lib fdm_object_region_uses_inverse_owner_translation` PASS (1/1).
- [ ] Dodać rotated/translated+rotated fixtures oraz material-field/texture parity matrix.

### Task 2: canonical coordinate transform

```rust
struct RegionSamplePoint { position_world: [f64; 3], position_object: [f64; 3] }
fn sample_point(world: [f64; 3], owner_from_object: AffineTransform3) -> Result<RegionSamplePoint, PlanError>;
```

- [x] Wspierany top-level `Translate` jest przekazywany jako owner translation; sampler wylicza `position_object = position_world - owner_translation` dla shape i object-local texture.
- [x] Usunięto stałe world-as-object coordinates z single-grid region/texture path; world coordinates pozostają dla pól przestrzennych.
- [ ] Zachować rotation/scale w typed IR i dodać validation dla singular/unsupported transforms.
- [ ] Dodać validation dla singular/unsupported transforms i stabilny reason code.

### Task 3: parity evidence

- [ ] Uruchomić planner, CPU FDM runtime i canonical Python round-trip tests; porównać mask checksum i sampled arrays dla transformowanych fixtures.
- [ ] Commit: `git add crates/fullmag-authoring crates/fullmag-ir crates/fullmag-plan crates/fullmag-runner && git commit -m "fix(fdm): sample regions in owner coordinates"`.

### Evidence (2026-07-14)

- Translation-aware membership implementation is in the planner; full `fdm_` focused suite: 39 tests, 38 passed before the dedicated regression was fixed, then dedicated regression 1/1.
- Remaining gap: rotation/scale owner transforms, spatial material/texture parity fixtures, Python round-trip, and managed CPU/GPU proof.

**Exit:** transform ownera nie zmienia relatywnego położenia regionu, texture ani pola w układzie obiektowym.
