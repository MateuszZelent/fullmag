# Managed FEM Export Lock CLOEXEC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zapobiec dziedziczeniu blokady eksportu managed FEM przez procesy potomne i ponowić końcową kwalifikację Airboxa FEM.

**Architecture:** Zewnętrzny proces `flock --close` posiada blokadę, a właściwy skrypt działa pod strażnikiem `FULLMAG_RUNTIME_EXPORT_LOCK_HELD=1`. Dzięki temu lock obejmuje także re-exec immutable source snapshot, ale żaden build/helper nie otrzymuje deskryptora blokady.

**Tech Stack:** Bash, util-linux `flock`, pytest, repozytoryjne `just` managed FEM runtime.

## Global Constraints

- Nie zabijać procesu PID 754847 w stanie `D` i nie restartować WSL.
- Nie omijać `just ensure-managed-fem-runtime` ani walidacji source identity.
- Zachować serializację jednego eksportu oraz dotychczasowy komunikat oczekiwania.
- Nie modyfikować solvera FEM ani kontenera poza wymaganym skryptem locka.

---

### Task 1: Test kontraktu deskryptora

**Files:**
- Modify: `scripts/test_export_fem_gpu_runtime_copy_helpers.py`
- Modify: `scripts/export_fem_gpu_runtime.sh`

**Interfaces:**
- Consumes: `flock --close`, `FULLMAG_RUNTIME_EXPORT_LOCK_HELD`.
- Produces: eksport serializowany bez fd locka w procesach potomnych.

- [x] **Step 1: Dodać test źródłowy wymagający wrappera i zakazujący `exec 9>`.**
- [x] **Step 2: Uruchomić pojedynczy test i potwierdzić oczekiwaną porażkę.**
- [x] **Step 3: Zastąpić blokadę fd 9 wrapperem `flock --close` oraz usunąć ręczne unlock/close z bootstrapu.**
- [x] **Step 4: Uruchomić test ponownie i potwierdzić PASS.**
- [x] **Step 5: Uruchomić cały `scripts/test_export_fem_gpu_runtime_copy_helpers.py`.**

### Task 2: Dowód wykonawczy braku dziedziczenia

**Files:**
- Test: tymczasowy katalog pod `/tmp`

**Interfaces:**
- Consumes: ten sam wzorzec `flock --close` co skrypt produkcyjny.
- Produces: dowód, że proces potomny nie ma deskryptora locka, a lock pozostaje zajęty.

- [x] **Step 1: Uruchomić kontrolowany proces potomny pod `flock --close`.**
- [x] **Step 2: Sprawdzić `/proc/<pid>/fd` i brak ścieżki locka.**
- [x] **Step 3: Potwierdzić, że konkurencyjny `flock -n` przegrywa podczas życia potomka i przechodzi po jego zakończeniu.**

### Task 3: Ponowienie kwalifikacji FEM

**Files:**
- Evidence: `apps/control-room/.artifacts/viewport-3d-browser-audit/`
- Update: `docs/audits/2026-08-07-airbox-fdm-fem-visualization-regression-audit.md`

**Interfaces:**
- Consumes: `just fullmag`, managed FEM bundle, v2 scoped field API.
- Produces: realny runtime proof FEM albo precyzyjny pozostający blocker starego procesu `D`.

- [ ] **Step 1: Uruchomić `ensure-managed-fem-runtime` przez izolowane porty.**
- [ ] **Step 2: Po `compute_fields` sprawdzić katalog `H_demag`, `H_eff`, `H_ext` i osobne zakresy Airbox/ferromagnetyk.**
- [ ] **Step 3: Uruchomić aktualny frontend, sprawdzić WebGL i zapisać screenshoty.**
- [ ] **Step 4: Zaktualizować raport wyłącznie dowodami z faktycznego wykonania.**
