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

- [ ] Dodać testy translated, rotated i translated+rotated owner z box/sphere/cylinder region, material field i texture; porównać oczekiwane cell indices.
- [ ] Uruchomić `env CARGO_TARGET_DIR=/tmp/fullmag-region-transform cargo test -p fullmag-plan object_region -- --nocapture`; oczekiwany RED dla translated owner.

### Task 2: canonical coordinate transform

```rust
struct RegionSamplePoint { position_world: [f64; 3], position_object: [f64; 3] }
fn sample_point(world: [f64; 3], owner_from_object: AffineTransform3) -> Result<RegionSamplePoint, PlanError>;
```

- [ ] Zachować owner transform w authoring adapter/IR lub w typowanym wejściu planera i obliczać inverse raz na ownera.
- [ ] Użyć `position_object` dla object-frame shape, field i texture; nie przekazywać stałego `[0,0,0]` jako translacji.
- [ ] Dodać validation dla singular/unsupported transforms i stabilny reason code.

### Task 3: parity evidence

- [ ] Uruchomić planner, CPU FDM runtime i canonical Python round-trip tests; porównać mask checksum i sampled arrays dla transformowanych fixtures.
- [ ] Commit: `git add crates/fullmag-authoring crates/fullmag-ir crates/fullmag-plan crates/fullmag-runner && git commit -m "fix(fdm): sample regions in owner coordinates"`.

**Exit:** transform ownera nie zmienia relatywnego położenia regionu, texture ani pola w układzie obiektowym.
