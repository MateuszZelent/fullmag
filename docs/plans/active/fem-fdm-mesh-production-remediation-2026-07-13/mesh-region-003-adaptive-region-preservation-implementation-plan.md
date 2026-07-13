# MESH-REGION-003 — Adaptive region preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adaptivity i auto-coarsen zachowują conformal region partition, material realization i PBC albo odrzucają konfigurację przed wykonaniem.

**Architecture:** Obie ścieżki używają tego samego region-aware remesh transaction co manual remesh. Do czasu pełnej obsługi capability matrix fail-closed blokuje conformal regions i PBC zamiast uruchamiać niepełny fallback.

**Tech Stack:** Rust orchestrator/capability planner, Python remesh, FEM runtime

## Global Constraints

- Brak adaptacyjnej publikacji bez świeżych markerów, PBC pairs i certificate.
- State transfer raportuje normę, coverage per region i renormalization.
- Initial mesh pozostaje current przy każdym failure.

---

**Finding:** MESH-REGION-003, P0.
**Dependencies:** MESH-REGION-002, MESH-REGION-004, MESH-FEM-006/007.

### Task 1: RED i tymczasowe fail-closed

- [ ] Dodać testy adaptive follow-up i auto-coarsen dla conformal region bez PBC oraz z PBC; obecny przepływ ma zostać wykryty jako niebezpieczny.
- [ ] Dodać planner reason `adaptive_region_remesh_not_certified` i `adaptive_periodic_remesh_not_certified`; sprawdzić, że stage nie startuje do czasu Task 2.

### Task 2: wspólny candidate transaction

- [ ] Zastąpić jednogeometryczny request wywołaniem region-aware shared remesh z MESH-REGION-002.
- [ ] Kandydat musi zawierać nową mapę markerów, build report, material fields, PBC pairs/certificate i state-transfer audit; publikacja jest jednym commit eventem.
- [ ] Walidować liczbę elementów i objętość każdego regionu przed/po transferze w opublikowanej tolerancji.

### Task 3: kwalifikacja

- [ ] Usunąć tymczasowy capability block wyłącznie dla kombinacji przechodzących pełny candidate validation; pozostałe pozostają fail-closed z tym samym reason code.
- [ ] Uruchomić orchestrator tests, Python remesh tests i container-backed managed adaptive FEM gate dla conformal+PBC; zachować evidence bundle.
- [ ] Commit: `git add crates/fullmag-cli crates/fullmag-plan packages/fullmag-py justfile && git commit -m "fix(fem): preserve regions through adaptive remesh"`.

**Exit:** adaptive/auto-coarsen albo publikuje kompletną nową realizację region/PBC, albo nie zmienia żadnego current resource.
