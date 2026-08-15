# FDM Airbox And Terminal Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Naprawić cel wizualizacji Airboxa FDM, końcową publikację telemetrii i średnią magnetyzację po aktywnych komórkach.

**Architecture:** Kanoniczny cel `airbox` pozostaje wspólną semantyką produktu, natomiast techniczny cel komórek poza nośnikiem pozostaje osobny. Terminalne próbki używają jawnej ścieżki publikacji, a obliczanie średniej otrzymuje maskę aktywnego materiału.

**Tech Stack:** TypeScript, React, Vitest, Rust, Cargo.

## Global Constraints

- Nie zmieniać semantyki FEM.
- Nie kopiować zasobów serwera do store modułu.
- Nie dodawać wyjątków dla pojedynczego pola zamiast użycia katalogu quantity.
- Zachować cudze zmiany w brudnym worktree.

---

### Task 1: Kanoniczny cel Airboxa FDM

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`

**Interfaces:**
- Consumes: `resolveVisualizationTargetFromSelection(selection)`.
- Produces: `resolveObjectVisualizationTargetForLane(...)` zwracające `VisualizationTargetRef(kind="airbox")` dla publicznego Airboxa.

- [x] Zmienić test publicznego `airbox.visualization`, aby oczekiwał celu `{id: "airbox", kind: "airbox"}`.
- [x] Uruchomić test i potwierdzić niezgodność z bieżącym `fdm-domain`.
- [x] Rozdzielić publiczny Airbox od `mesh.grid.universe-outside-support` w resolverze.
- [x] Potwierdzić, że test publicznego Airboxa oraz istniejący test technicznego celu przechodzą.

### Task 2: Quantity i render mode Airboxa

**Files:**
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`
- Verify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx`
- Verify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`

**Interfaces:**
- Consumes: katalog quantity z `domain="full_domain"` i ustawienia `AIRBOX_VISUALIZATION_TARGET`.
- Produces: dropdown bez `m`/`mat_*` i render mode konsumowany przez Airbox.

- [x] Dodać regresję potwierdzającą, że Airbox nie oferuje magnetyzacji ani materiałów.
- [x] Uruchomić testy panelu.
- [x] Potwierdzić przepływ render-mode od panelu do modelu sceny.
- [x] Uruchomić typecheck frontendu.

### Task 3: Bezwarunkowa terminalna publikacja skalarów

**Files:**
- Modify: `crates/fullmag-cli/src/orchestrator.rs`
- Test: `crates/fullmag-cli/src/orchestrator.rs`

**Interfaces:**
- Consumes: `set_latest_scalar_row_for_terminal_update` i `force_publish_latest_scalar_row`.
- Produces: ostatni wiersz widoczny niezależnie od `scalar_row_due`.

- [x] Dodać test ścieżki końca skryptowego etapu z `scalar_row_due=false`.
- [x] Uruchomić test i potwierdzić brak terminalnego wiersza.
- [x] Zastosować terminalny setter w finalizacji skryptowej i wymusić publikację po zwolnieniu blokady.
- [x] Uruchomić skupione testy orchestratora.

### Task 4: Średnia magnetyzacja po aktywnych komórkach

**Files:**
- Modify: `crates/fullmag-runner/src/relaxation/direct_minimizer.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/execute.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs`
- Modify: `crates/fullmag-runner/src/table_autosave.rs`
- Test: `crates/fullmag-runner/src/relaxation/direct_minimizer.rs`

**Interfaces:**
- Consumes: `active_mask: Option<&[bool]>`.
- Produces: `StepStats.avg_m` bez komórek Airboxa.

- [x] Dodać test wektorów magnetycznych z nieaktywną zerową komórką pośrodku.
- [x] Uruchomić test i potwierdzić brak parametru maski w kontrakcie metryk.
- [x] Przekazać aktywną maskę do wspólnej funkcji metryk minimizatora.
- [x] Uruchomić testy runnera i test tabel autosave.

### Task 5: Kwalifikacja końcowa

**Files:**
- Modify: `docs/audits/2026-08-14-fdm-3d-visualization-shaders-wireframe-airbox-inspectors-audit.md`

**Interfaces:**
- Consumes: wyniki testów oraz stan rzeczywistej sesji FDM.
- Produces: skorygowany audyt i dowód wizualny.

- [ ] Uruchomić skupione testy TypeScript i Rust.
- [ ] Uruchomić typecheck Control Room.
- [ ] W przeglądarce potwierdzić dropdown Airboxa, widoczny wireframe i końcowe `avg m`.
- [ ] Skorygować werdykt audytu wraz z rzeczywistym zakresem dowodów.
