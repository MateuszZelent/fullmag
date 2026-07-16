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

- [x] Dodać fail-closed guard dla adaptive follow-up z enabled conformal region; zwraca stabilny reason `adaptive_region_remesh_not_certified` przed remeshem.
- [ ] Dodać analogiczny test dla okresowego meshu oraz pełne testy wywołania stage; test compilation jest obecnie blokowane przez istniejące brakujące pola w `live_workspace.rs`/`step_utils.rs`.

### Task 2: wspólny candidate transaction

- [ ] Zastąpić jednogeometryczny request wywołaniem region-aware shared remesh z MESH-REGION-002; obecny guard świadomie blokuje ścieżkę przed pełnym candidate transaction.
- [ ] Kandydat musi zawierać nową mapę markerów, build report, material fields, PBC pairs/certificate i state-transfer audit; publikacja jest jednym commit eventem.
- [ ] Walidować liczbę elementów i objętość każdego regionu przed/po transferze w opublikowanej tolerancji.

### Task 3: kwalifikacja

- [ ] Usunąć tymczasowy capability block wyłącznie dla kombinacji przechodzących pełny candidate validation; pozostałe pozostają fail-closed z tym samym reason code.
- [ ] Uruchomić orchestrator tests, Python remesh tests i container-backed managed adaptive FEM gate dla conformal+PBC; zachować evidence bundle.
- [ ] Commit: `git add crates/fullmag-cli crates/fullmag-plan packages/fullmag-py justfile && git commit -m "fix(fem): preserve regions through adaptive remesh"`.

**Exit:** adaptive/auto-coarsen albo publikuje kompletną nową realizację region/PBC, albo nie zmienia żadnego current resource.

### Evidence (2026-07-14, fail-closed interim)

- `adaptive_remesh_legality_reason` blocks enabled conformal regions before the
  adaptive remesh call, preventing publication of an uncertified candidate.
- `rustfmt --edition 2021 --check crates/fullmag-cli/src/orchestrator.rs` — PASS.
- `cargo check -p fullmag-cli --bin fullmag` — PASS (existing unrelated warning).
- `cargo test -p fullmag-cli --bin fullmag adaptive_remesh_fails_closed_for_uncertified_conformal_regions` — not runnable because existing test-only initializers in `live_workspace.rs` and `step_utils.rs` lack unrelated required fields.
- Managed adaptive FEM proof and the full candidate transaction remain open.
