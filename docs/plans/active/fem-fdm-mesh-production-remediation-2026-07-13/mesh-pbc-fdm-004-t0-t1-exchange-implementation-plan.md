# MESH-PBC-FDM-004 — T0/T1 periodic boundary correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zapewnić periodic seam semantics w boundary-correction exchange T0/T1 lub fail-closed zabronić ich połączenia z PBC.

**Architecture:** Dispatcher nie może wybrać boundary correction przed sprawdzeniem PBC. Docelowo T0/T1 otrzymują te same axes flags i wrapped neighbors co standard FP64 exchange.

**Tech Stack:** CUDA C++, Rust boundary planner, managed tests

## Global Constraints

- Brak ukrytego downgrade do standard exchange bez provenance.
- T0/T1 physics note określa zachowanie na seam.
- GPU verification przez `just`, nie host build.

---

**Finding:** MESH-PBC-FDM-004, P0.

### Task 1: RED dispatch/seam tests

- [ ] Dodać matrix correction none/T0/T1 × periodic none/X/XY oraz analytic seam fixtures.
- [ ] Najpierw dodać planner guard dla kombinacji bez implementacji; test ma oczekiwać stabilnego unsupported reason.

### Task 2: periodic-aware T0/T1

```cpp
void exchange_t0_fp64(..., bool periodic_x, bool periodic_y, bool periodic_z);
void exchange_t1_fp64(..., bool periodic_x, bool periodic_y, bool periodic_z);
```

- [ ] Przekazać flags przez context/dispatcher i zawijać sąsiadów na aktywnych osiach.
- [ ] Porównać seam field/energy z CPU oracle dla obu korekt; uruchomić managed tests, PASS.

### Task 3: capability/provenance

- [ ] Usunąć guard tylko dla zweryfikowanych corrections; artifact zapisuje correction i axes.
- [ ] Commit: `git add crates/fullmag-plan/src/boundary_geometry.rs backends/fdm/gpu/cuda/interactions backends/fdm/tests && git commit -m "fix(cuda): honor PBC in T0 T1 exchange"`.

**Exit:** T0/T1 + PBC jest jawnie supported i parity-tested albo jednoznacznie odrzucone przed dispatch.

