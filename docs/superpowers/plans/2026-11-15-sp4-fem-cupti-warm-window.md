# SP4 FEM GPU — ciepłe okno CUPTI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Wykonanie jest już zlecone w zadaniu SP4; nie pytamy ponownie o tę samą implementację.

**Goal:** kompletny profil wybranych ciepłych kroków Poissona bez zmiany fizyki i Zarr.

**Architecture:** zamknięty parametr accepted_cuda_trace.v2 steruje start/stop istniejącego kolektora na granicach zaakceptowanych kroków. Osobny receipt V2 opisuje granice; analyzer rozróżnia zakres od całego runnera. Nie zmieniamy natywnego ABI ani kerneli.

**Tech Stack:** Rust/serde, istniejący CUPTI Activity API28, Python3, Docker Compose Q.

**Spec:** `docs/superpowers/specs/2026-11-15-sp4-fem-cupti-warm-window-design.md`.

## Global Constraints

- V1 zachowuje zachowanie, shape i ścieżkę receiptu; V2 ma osobny receipt.
- 1<=N<M, M-N<=1000; cap4096–536870912B/1–120000ms; limit=>partial.
- Jawne FEM GPU strict/double, fallbacknone; model/siatka/m0/dt/tolerancje bez zmian.
- Pełne `.py/.zarr` i trace/provenance na ext4; historyczny CPU A bez zatrzymania.
- Cztery cudze trackedWIP zachować; buildy tylko we właściwej grupie, bez hostCargo.

## Review Focus

- Pominięty lub powtórzony callback nie może dać fałszywego complete.
- Nieudany delayed start/stop nie może zastąpić wyniku solvera lub uruchomić go ponownie.
- V2 nie może być przeczytany jako profil całego SP4 przez stary analyzer.
- Czas całego wrappera nie jest czasem wybranego capture.
- Źródła/attempt/PID/GPU i Zarr muszą pozostać przypięte także po finalizacji.

---

### Task1: admission, capture i callback FEM

**Files:** `crates/fullmag-api/src/accepted_cuda_trace_admission.rs`,
`crates/fullmag-api/src/accepted_cuda_trace.rs`,
`crates/fullmag-api/src/accepted_fem_study_worker.rs`.

**Owner:** jeden bounded worker; inne pliki tylko po zgłoszeniu rootowi.
**Interfaces:** `Config.accepted_step_window: Option<AcceptedStepWindow>`;
`AcceptedStepWindow {start_after_step:u64,end_after_step:u64}`;
`Capture::observe_accepted_step(&mut self, stats:&fullmag_runner::StepStats)`.
Metoda obserwuje tylko PhysicalObservation, nie zwraca StepAction. Format
receiptu V2 jest dokładnie określony w spec; analyzer Task2 nie zgaduje pól.

- [ ] Dodać testy zamkniętego V2 i zachowania V1; testować digest i typy/granice.
- [ ] Dodać fake-session testy Pending/Active/Closed i błędów ze spec.
- [ ] Dodać opóźniony start, jednorazowy stop i receipt V2; nativeABI bez zmian.
- [ ] Podłączyć obserwację w callbacku przed istniejącym profile/live writer.
- [ ] Sprawdzić Rust parser/diff i referencje; właściwe unit tests w CI SP4.
- [ ] Root po review i adekwatnych kontrolach commitowanej całości zapisuje etap.

### Task2: analyzer V2 i regresje

**Files:** `scripts/analyze_accepted_cuda_trace.py`,
`scripts/test_analyze_accepted_cuda_trace.py`.

**Owner:** niezależny bounded worker, bez zmian w Rust.
**Interfaces:** `analyze(root,run_id,attempt_id,worker_pid,gpu_uuid)` bez zmiany
argumentów. Wybiera dokładnie jeden receipt V1/V2; dodaje `capture_scope`
z `kind=whole_runner` lub `kind=accepted_step_window` i odczytanymi granicami.
`timing_qualification` V2 używa `capture_wall_seconds`, nie wrapper total.

- [ ] Testy RED: kompletny zakres, missed/early/limit, tamper i oba receipty.
- [ ] Zaimplementować strict config/window validation bez rozluźniania hash/identity/header.
- [ ] Zachować legacy API24/API28 i dotychczasowe V1 wyniki.
- [ ] `python3 -B -m unittest scripts.test_analyze_accepted_cuda_trace` PASS.
- [ ] Root ocenia diff i review wspólnego kontraktu z Task1.

### Task3: managed build, capture i porównanie

**Owner:** root. Zmiany operacyjne tylko w grupie Q, dane w dotychczasowym profilu E.

- [ ] Potwierdzić aktualny master, chronione WIP, Qidle, lease/drain i piny B6.
- [ ] Zachować source-transition proof i zaktualizować Q do zweryfikowanych źródeł
      taskbranch; użyć istniejącego launchera Compose, nie manualCargo/Dockerbuild.
- [ ] Zbudować API/native w stałym backendzie Q; wykonać wymagane managed gates.
- [ ] Commit/push spójnego etapu i standardowe CI SP4; poprawić wszystkie regresje.
- [ ] Przygotować dwa nowe accepted request trace-off/on; zakres16–21,
      cap512MiB/60s, lease storage2GiB. To pięć ciepłych kroków i około30solve,
      z zachowaniem pełnego5ps Zarr; większy cap pozostaje awaryjnym limitem.
- [ ] Wykonać je raz przez prepare/validate/Submit/materialize z nowymi idempotency keys.
- [ ] Zachować pełny Zarr, trace i receipt; uruchomić niezależny readback oraz analyzer.
- [ ] Sprawdzić8energii/m/H/torque/residuum/czas i kompletny profil bez strat.
- [ ] Na podstawie śladu wybrać konkretną optymalizację Poissona; mierzyć zysk na
      nieprofilowanych powtórzeniach. Sam profil nie jest przyspieszeniem.
- [ ] Zarejestrować checkpoint i kolejne brakujące pełne CPU A/B; utrzymać
      historyczny A. Dalej pełne4lane/MuMax3,5parBB, PR/merge/localFF/qualifiedcleanup.
