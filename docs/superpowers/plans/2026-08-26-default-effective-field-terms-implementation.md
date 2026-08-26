# Domyślne termy pola efektywnego — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodać czytelny jawny opt-out dla domyślnie aktywnych exchange i demag oraz ujednolicić eksport i dokumentację.

**Architecture:** Istniejące booleany stanu autora pozostają źródłem decyzji, a `ProblemIR.energy_terms` pozostaje kanonicznym zbiorem aktywnych oddziaływań. Nowe metody są cienkimi, publicznymi operacjami ustawiającymi istniejące flagi na `False`; eksporter pomija wartości domyślne i zapisuje tylko konfigurację lub jawne wyłączenie.

**Tech Stack:** Python DSL, pytest/unittest, SceneDocument/script builder, MyST Markdown, scientific source-map validator.

## Global Constraints

- Exchange i demag są domyślnie aktywne.
- Nie zmieniać `ProblemIR`, plannerów ani backendów.
- Zachować kompatybilność `enabled=False`.
- Nie wykonywać commita bez osobnej zgody użytkownika.

---

### Task 1: Testy kontraktu Python i eksportu

**Files:**
- Modify: `packages/fullmag-py/tests/test_api.py`
- Modify: `packages/fullmag-py/tests/test_scratch_authoring_ui_roundtrip.py`
- Modify: `packages/fullmag-py/tests/test_permalloy_layer_bimeron_example.py`

**Interfaces:**
- Consumes: istniejący `load_problem_from_script`, `export_builder_draft`, `rewrite_loaded_problem_script`.
- Produces: regresje dla `disable_exchange()`, `disable_demag()` i kanonicznego eksportu.

- [ ] Dodać test nowych metod i domyślnych termów bez jawnego enable.
- [ ] Dodać test eksportu pomijającego `enabled=True` i emitującego `disable_*()` dla false.
- [ ] Zmienić test przykładu tak, aby odrzucał redundantne `study.exchange()`.
- [ ] Uruchomić testy i potwierdzić oczekiwane błędy RED.

### Task 2: Minimalna implementacja DSL i eksportera

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `examples/permalloy_layer_bimeron_prism_single_layer_relax_300nm.py`

**Interfaces:**
- Produces: `fm.disable_exchange()`, `fm.disable_demag()`, `StudyBuilder.disable_exchange()`, `StudyBuilder.disable_demag()`.

- [ ] Dodać cienkie funkcje i metody ustawiające istniejące flagi na `False`.
- [ ] Wyeksportować nowe funkcje z publicznego pakietu.
- [ ] Zmienić renderer SceneDocument zgodnie z zatwierdzonym kontraktem.
- [ ] Usunąć redundantne `study.exchange()` z przykładu.
- [ ] Uruchomić testy GREEN.

### Task 3: Dokumentacja naukowa i source map

**Files:**
- Modify: `docs/physics/0880-active-effective-field-terms.md`
- Create: `docs/physics/0880-active-effective-field-terms.source-map.json`

**Interfaces:**
- Consumes: faktyczne symbole DSL, lowering i testy.
- Produces: kanoniczny opis domyślności, jawnego opt-out, ProblemIR, round-trip i czterech lane backendu.

- [ ] Uzupełnić wymagane sekcje, równania, symbole, tabelę API i macierz FDM/FEM CPU/GPU.
- [ ] Dodać mapę źródeł opartą na stabilnych symbolach.
- [ ] Uruchomić validator strony oraz testy validatora.

### Task 4: Końcowa weryfikacja

**Files:**
- Verify only.

- [ ] Uruchomić skupione testy Python.
- [ ] Sprawdzić diff i brak niezamierzonych zmian.
- [ ] Uruchomić materializację przykładu i potwierdzić `exchange + demag` bez `study.exchange()`.
- [ ] Kontynuować zarządzaną ścieżkę FEM aż do potwierdzenia startu solvera, jeśli runtime pozostaje zgodny ze źródłami.
