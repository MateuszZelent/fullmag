# Fullmag multilayer GPU — szczegółowy plan wykonawczy pełnej przebudowy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Dobór workflow i modeli podlega AGENTS.md; ten dokument nie uruchamia implementacji.

**Goal:** Przebudować cały operator multilayer GPU i jego integrację z czasem, stanem oraz artefaktami, naprawić wszystkie sześć findingów i zakwalifikować pełny zaakceptowany zakres.

**Architecture:** Jeden immutable plan i jeden natywny właściciel operatora GPU. Native grids → moment-preserving push → współdzielone widma → tensorowe sumowanie par → inverse → adjoint pull; wszystkie etapy integratora korzystają z tego samego operatora. Rust CPU pozostaje referencją, runner orkiestruje ABI i artefakty, bez hostowego hot loop konwolucji.

**Tech Stack:** Istniejący Rust/Python DSL/ProblemIR, C ABI, C++/CUDA i cuFFT, obecny resource/binary data plane oraz Docker Compose; bez nowej zależności bibliotecznej.

**Spec:** [Zaakceptowany projekt](../specs/2026-10-25-fdm-gpu-multilayer-rebuild-design.md), zaakceptowany przez użytkownika 2026-10-25.
**Audit:** [Sześć findingów FDM-A01…A06](../../audits/2026-10-25-fdm-gpu-multilayer-audit.md).

Status: **PLAN ONLY — implementacja niezaczęta**. Baza rozpoznania:
`28f4fcf5bba4387025944b8fb276c94b3eef5eb5`, `master`,
`/home/kkingstoun/git/fullmag/fullmag`. Zastana modyfikacja `external_solvers/3`
pozostaje poza zadaniem. Wszystkie kroki wykonawcze poniżej są przyszłe.

## Global Constraints

- Pełna przebudowa operatora, nie zakończenie na obecnym D-07 identity/FP64/Heun.
- `two_d_stack` i `three_d`; otwarte granice demag. PBC/Floquet i nowa fizyka poza zakresem; naprawa istniejącej energii exchange PBC A03 jest w zakresie.
- Różne native dx/dy/dz, extenty, przesunięcia XYZ i odstępy; overlap transfer, maski, per-cell Ms/A/alpha. Warstwa bez aktywnych komórek jest odrzucana przed alokacją.
- FP64 i osobno FP32 storage/compute/FFT z redukcjami FP64, bez zmiany requested intent.
- Fixed Heun/RK4/RK23/RK45/ABM3 oraz adaptive RK23/RK45, Frozen Spins, checkpoint/restart i accepted-state observation są wymagane do zakończenia.
- Jeden publiczny DSL i ProblemIR; brak ukrytego CPU/assisted/single-grid fallbacku dla jawnie wybranej nowej realizacji.
- Native GPU nie przenosi pełnych m/H na host w nieobserwowanym kroku; setup i jawne outputy mają oddzielne liczniki.
- Kanoniczne równania i jednostki pozostają w nocie 0421 i jej source-map. Zmiana naukowa wymaga `scientific-documentation-contract` przed kodem operatora.
- Obowiązuje zakaz kompilacji testów jednostkowych do odwołania przez użytkownika. Akceptacja projektu ani tego planu go nie odwołuje.
- Wykonawca tworzy/reużywa zarejestrowany worktree według governance; wszystkie buildy DEV w jego grupie Compose, wyłącznie w stałym `backend`, cache/logi builda w named volumes/BuildKit.
- Tego planu nie realizować przez automatyczny build, commit, push lub merge w sesji planistycznej. W przyszłej implementacji obowiązuje pełny cykl AGENTS.md.
- Progi pola: FP64 `atol=1e-4 A/m`, `rtol=1e-8`; FP32 względem FP64 RMS `2e-4`, component Linf `5e-4`. Progi momentu: FP64 `1e-12`, FP32 `5e-6`; pochodnej energii: FP64 `1e-8`, FP32 `5e-4`. Źródło: istniejący `thresholds.v1.json`; zmiana wymaga naukowego uzasadnienia, nie dopasowania do wyniku.

## Review Focus

1. Te same liczby komórek, lecz inne warstwy, czasy lub origin — verifier ma odrzucić porównanie przed liczeniem błędu (T02).
2. Częściowe pokrycie scratch i dziury w masce — moment nie może zostać renormalizowany do pełnego pokrycia; pull jest adjointem (T08).
3. NaN/Inf, przepełnienie normy, odrzucony krok i przerwanie — accepted state i historia pozostają identyczne, legalny retry działa (T04/T05/T15).
4. OOM lub podmiana descriptora podczas aktywacji — stary uchwyt działa, nowy nie publikuje połowicznego stanu (T07/T10).
5. Ta sama scena z innym Ms, maską lub przesunięciem i wznowienie runu — cache, checkpoint i pole nie mogą użyć poprzedniej tożsamości (T09/T16/T18).

---

## 1. Mapa zmian i kontrakty między zadaniami

Wszystkie ścieżki w tej sekcji są względem repo. `NOWY` oznacza plik do
utworzenia podczas implementacji, nie plik już istniejący. Nie tworzyć
równoległej kopii istniejących `FdmLayerDescriptor`, `CommonTransformLayout`,
`OrientedKernelPairDescriptor`, `KernelCatalogSpec` ani `VolumeWeightedTransfer`.

| Właściciel | Istniejące pliki | Nowe skupione moduły |
|---|---|---|
| Dowody A01/A02 | `scripts/verify_fdm_multilayer_cuda_parity.py`, `scripts/test_verify_fdm_multilayer_cuda_parity.py` | Bez drugiego verifiera parity |
| Energia A03 | `crates/fullmag-engine/src/fdm/cpu/fields/energy.rs`, `crates/fullmag-engine/src/fdm/shared/problem.rs` | `crates/fullmag-engine/tests/exchange_periodic_energy.rs` |
| Krok A04/A05 | `backends/fdm/api/c_api.cpp`, `backends/fdm/gpu/cuda/integrators/multilayer_heun.cu` | `backends/fdm/gpu/cuda/integrators/multilayer_trial_validation.cu` i `.cuh` |
| Descriptor | `crates/fullmag-fdm-demag/src/descriptors.rs`, `transfer.rs`, `lib.rs`, `crates/fullmag-ir/src/mesh_hints.rs` | `crates/fullmag-fdm-demag/src/execution_plan.rs`, `crates/fullmag-plan/src/fdm/multilayer_execution.rs` |
| ABI | `native/include/fullmag_fdm.h`, `backends/fdm/api/plan_ingestion_v2.cpp`, `crates/fullmag-fdm-sys/src/lib.rs`, CUDA `native.rs` | `backends/fdm/include/fullmag/fdm/multilayer_abi_v3.h`, `backends/fdm/api/multilayer_plan_v3.cpp` |
| Operator | `backends/fdm/gpu/cuda/demag/multilayer_convolution.cu`, `runtime/context.cu`, `include/context.hpp`, `backends/fdm/CMakeLists.txt` | W `backends/fdm/gpu/cuda/demag/`: `multilayer_plan.hpp`, `multilayer_plan.cpp`, `multilayer_transfer.cu`, `multilayer_workspace.cu`, `multilayer_operator.cu` |
| Integratory | `multilayer_heun.cu`, `multilayer_explicit_rk.cu`, `runtime/adaptive_controller.cuh`, `runtime/step_transaction_controller.hpp` | W `gpu/cuda/integrators/`: `multilayer_rhs.cu`, `multilayer_rhs.cuh`, `multilayer_abm3.cu`, `multilayer_adaptive.cu` |
| Accepted state | `gpu/cuda/runtime/llg_checkpoint.cpp`, Rust `accepted_materialization.rs`, `observation_runtime.rs` | `backends/fdm/gpu/cuda/runtime/multilayer_checkpoint.cpp` |
| Runner | `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs`, `native.rs`, `multilayer/tests.rs` | `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer/resident.rs` |
| Kwalifikacja | obecne skrypty i scenariusze multilayer, `justfile` | `scripts/fdm_multilayer_checks.py`, `scripts/test_fdm_multilayer_checks.py`, `scripts/fdm_multilayer_rebuild_matrix.py` |

### Uzgodnione nowe interfejsy (projekt, nie aktualne API)

- Rust `ResolvedMultilayerExecutionPlan` w `fullmag-fdm-demag::execution_plan`:
  wersja, `Vec<FdmLayerDescriptor>`, `Vec<CommonTransformLayout>`,
  `KernelCatalogSpec`, mapy transferu, fingerprint całości, polityka precision,
  budżet pamięci, macierz legalnych integratorów. Nie serializuje wskaźników CUDA.
- `resolve_multilayer_execution(plan: &FdmMultilayerPlanIR) -> Result<ResolvedMultilayerExecutionPlan, String>` w nowym module planera. To jedyny wybór realizacji dla preflight i dispatchu; błędy mają stabilny prefiks reason code.
- `OverlapTransferMap` w `fullmag-fdm-demag::transfer`: CSR overlap volumes,
  indeksy native/scratch, obie objętości i fingerprint maski. Funkcja
  `build_overlap_map(layer: &FdmLayerDescriptor, active: &[bool]) -> Result<OverlapTransferMap, DescriptorError>`.
  Wejściową maskę ABI u8 walidować i konwertować na granicy, nie reinterpretować jako bool.
- C ABI `fullmag_fdm_multilayer_plan_desc_v3`: `struct_size`, `abi_version`,
  tablice warstw, transferów, par i layoutów z counts, polityka materiału,
  Frozen Spins oraz fingerprint. Nowy entrypoint
  `int fullmag_fdm_backend_create_multilayer_v3(const fullmag_fdm_multilayer_plan_desc_v3*, fullmag_fdm_backend**)`.
  v2 zachowuje layout; wersjonowanie checkpointu i receipt jest osobne.
- Native `MultilayerDemagPlan` i `MultilayerDemagWorkspace` w `multilayer_plan.hpp`;
  `bool prepare_multilayer_demag(Context&, const MultilayerDemagPlan&)` oraz
  `bool refresh_multilayer_demag(Context&, cudaStream_t)` — zapisują per-layer
  H_demag, a błąd w `last_error`; nie zatwierdzają stanu/czasu.
- `bool evaluate_multilayer_rhs(Context&, double stage_time, cudaStream_t)`
  w `multilayer_rhs.cuh`: konsumuje bieżące trial m, materiały i Frozen Spins,
  odświeża pola i zapisuje RHS w workspace; nie publikuje snapshotu.
- `bool validate_multilayer_trial(Context&, cudaStream_t)` w
  `multilayer_trial_validation.cuh`: sprawdza aktywne komórki, flagę skończoności
  etapów oraz normę końcową; porażka trafia do istniejącego rollback.
- `MultilayerCheckpointV1` jest wersją nowego payloadu, nie zmianą istniejącego
  checkpoint ABI v1. Zawiera fingerprint planu, m, czas/step, historię ABM/FSAL,
  dt controller i Frozen Spins reference; hashe i długości walidowane przed restore.

## 2. Reguły testów, komend i commitów

Oznaczenie **C-BLOCKED**: krok wymaga skompilowanego testu. Do odwołania
zakazu nie uruchamiać go, nie oznaczać jako PASS i nie omijać przez inny
kontener. Można przygotować test i dokumentację; zadanie pozostaje
`implemented/unverified`, a końcowy merge blokuje brak wymaganych dowodów.
Zakaz nie uniemożliwia wykonania tego planu dokumentacyjnego.

T00 ustanawia projektowany dispatcher kontroli:

```text
python3 -B scripts/fdm_multilayer_checks.py --source-root <absolutny-worktree> --suite <suite> --phase <source|contract|runtime|benchmark> --expect <pass|fail>
```

**Komenda jeszcze nie istnieje.** Po T00 nie zastępuje launchera builda:
używa istniejącego BuildControl/resolvera, grupy wybranego checkoutu i stałego
backendu. Phase `source` nie kompiluje; `contract` pozostaje C-BLOCKED.
Każdy suite niżej musi być dodany do jawnego rejestru dispatchera w zadaniu,
które go wprowadza. Nieznany suite lub brak targetu jest błędem, nie skipem.
W dalszym tekście `CHECK(suite, phase)` oznacza dokładnie powyższą komendę
z `--expect pass`; RED używa `--expect fail` i wymaga błędu konkretnej asercji,
a nie braku zależności, urządzenia lub kompilatora.

Dozwolone lekkie testy Python mają własne podane polecenia. Wszystkie
kompilacje/backend/frontend i zależności nadal podlegają Compose. W każdym
tasku: dopisać RED → potwierdzić przyczynę → minimalna zmiana → GREEN → review
→ commit; gdy C-BLOCKED, zapisać brak RED/GREEN, nie fabrykować dowodu.

Zakończenie **każdego** zadania obejmuje przegląd diffu i tylko jego plików,
stage wyłącznie tego zakresu, osobne `git diff --cached --name-only`, kontrolę
staged diff, commit z podanym angielskim komunikatem i checkpoint z pełnym SHA,
wykonanymi wynikami/exit codes oraz niewykonanymi bramkami. Nie dołączać
cudzego kodu ani danych. Sam commit części nie uruchamia merge/cleanup.

## 3. Zadania

### T00 — Powtarzalna ścieżka weryfikacji i baseline

**Owner:** integracja/kwalifikacja. **Depends:** brak. **Files:** NOWE
`scripts/fdm_multilayer_checks.py`, `scripts/test_fdm_multilayer_checks.py`;
istniejące `scripts/docker_build_control.py`, `scripts/docker_compose_identity.py`,
`scripts/docker_volume_checks.py` jako konsumowane wzorce; `justfile` tylko
jeśli potrzebny cienki wrapper. **Interfaces:** dispatcher z sekcji 2;
wynik `fullmag.fdm.multilayer.check.v1`, source SHA/snapshot, suite, phase,
selected Compose project, runtime/device identity, commands, exit codes,
status `passed|failed|blocked`, checks executed/skipped, evidence hashes.

- [ ] Przeczytać aktualne AGENTS, governance i `using-git-worktrees`, sprawdzić rejestr, założyć jeden task branch/worktree bez automatycznego fetch/bootstrap. Zapisać właściciela i bazę; nie tworzyć nowego `.env` dla worktree.
- [ ] Dodać `test_unknown_suite_rejected`, `test_wrong_compose_identity_rejected`, `test_compile_phase_blocked_without_authorization`, `test_missing_device_is_not_pass`; asercje: exit != 0 i konkretny reason, brak dispatchu do innej grupy.
- [ ] RED/GREEN: `PYTHONDONTWRITEBYTECODE=1 python3 -B -m pytest -q -p no:cacheprovider scripts/test_fdm_multilayer_checks.py`; wynik docelowy wszystkie PASS.
- [ ] Zaimplementować jawny rejestr suite → pliki/targety/scenariusze, source checks bez builda; contract/runtime dopiero przez zatwierdzoną receptę. Nie ukrywać kompilacji testów za phase runtime. Zablokować contract do jawnego odwołania zakazu w checkpointcie operatora.
- [ ] Zarejestrować baseline istniejących 27 testów parity i reprodukcje A01/A02; obecny wynik błędny ma zostać zapisany jako known failure. Wykonać procedurę commita: `test: add managed multilayer verification dispatch`.

### T01 — Wszystkie klatki i finite checks (FDM-A01)

**Owner:** dowody. **Depends:** T00. **Files:** modify
`scripts/verify_fdm_multilayer_cuda_parity.py`,
`scripts/test_verify_fdm_multilayer_cuda_parity.py`.
**Interfaces:** `FieldArtifact.snapshots` przechowuje wszystkie snapshoty;
`verify(cpu, cuda, thresholds, lane)` pozostaje zewnętrznym entrypointem.

- [ ] Dodać parametryczny `test_rejects_nonfinite_in_any_snapshot` dla NaN/+Inf/-Inf i pierwszej/środkowej/ostatniej klatki; `test_rejects_earlier_finite_field_error` z wcześniejszym błędem 1 A/m przy zgodnej ostatniej klatce i jednostkowym polu referencji.
- [ ] RED/GREEN: `PYTHONDONTWRITEBYTECODE=1 python3 -B -m pytest -q -p no:cacheprovider scripts/test_verify_fdm_multilayer_cuda_parity.py`; RED ma odtworzyć brak wyjątku, GREEN odrzuca uszkodzenie.
- [ ] Kontrolować finite podczas odczytu każdego komponentu; parity liczyć dla każdej odpowiadającej klatki i warstwy, raportować najgorszy błąd i jego położenie. Czytać strumieniowo po klatce, bez przechowywania całej trajektorii w RAM.
- [ ] Dodać `test_large_frame_cannot_hide_small_frame_error` i `test_large_layer_cannot_hide_small_layer_error`: skala odniesienia i próg są wyznaczane niezależnie dla każdej klatki oraz warstwy. Zbiorcza metryka pozostaje informacyjna; nie zastępuje żadnej lokalnej bramki.
- [ ] Zachować poprawne jedno- i wieloklatkowe artefakty; dodać regresję limitu pamięci przez brak kolekcji pełnych payloadów. `CHECK(parity-snapshots, source)` PASS.
- [ ] Review i commit `fix: validate every multilayer parity snapshot`.

### T02 — Tożsamość porównywanych pól (FDM-A02)

**Owner:** dowody/artefakty. **Depends:** T01. **Files:** te same dwa pliki;
kanoniczny zapis w `crates/fullmag-runner/src/artifacts.rs` ::
`multilayer_field_layers`, `write_multilayer_field_manifest`, `write_layer_field_file`;
producenci wejściowego layoutu w `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs`
i `crates/fullmag-runner/src/fdm/cpu/multilayer_reference/observables.rs`.
**Interfaces:** `FieldArtifact` dodaje identity warstw, grid fingerprint i
indeks snapshotów `(accepted_step, time_seconds)`; run IDs mogą być różne.

- [ ] Dodać `test_rejects_changed_layer_identity`, `test_rejects_same_count_different_grid`, `test_rejects_shifted_step_set`, `test_rejects_same_step_different_time`, `test_reorders_layers_by_stable_identity`, `test_allows_distinct_run_ids`.
- [ ] RED/GREEN tym samym poleceniem pytest co T01. Testy błędne mają odrzucić przed normą błędu, prawidłowa permutacja warstw ma dać tę samą metrykę.
- [ ] Walidować unikalne object/layer ID, shape, cell/origin/mask fingerprint, jawne kroki/czasy i jednostki; dopasować po ID, nie kolejności katalogów. Brak required identity oznacza `evidence_identity_missing`, nigdy zgadywanie po count.
- [ ] Dodać fixture odtwarzający rzeczywisty manifest `fdm_multilayer_field_manifest.v1` i payload `write_layer_field_file`, bez wymyślonych required fields. Krok musi być identyczny; skończone czasy każdej pary odpowiadających warstw porównać bezpośrednio z tolerancją `8 * max(ulp(t_cpu), ulp(t_gpu))`, bez tolerance chaining przez pierwszą warstwę. Metadane payloadu muszą zgadzać się z manifestem.
- [ ] Jeżeli producent nie emituje wymaganych pól, uzupełnić go wersjonowanym manifestem i testem round-trip; stare artefakty nadal czytelne, lecz bez nowego statusu qualified. Sprawdzić ścieżki katalogów bez wyjścia poza root artefaktu. `CHECK(parity-identity, source)` oraz contract producenta C-BLOCKED.
- [ ] Review i commit `fix: bind multilayer parity to layer grid and step identity`.

### T03 — Energia periodyczna CPU (FDM-A03)

**Owner:** CPU reference. **Depends:** T00. **Files:** modify `crates/fullmag-engine/src/fdm/cpu/fields/energy.rs`, `crates/fullmag-engine/src/fdm/shared/problem.rs`; NOWY `crates/fullmag-engine/tests/exchange_periodic_energy.rs`.
**Interfaces:** zachować `exchange_energy(&ExchangeLlgState)` i `exchange_energy_from_vectors(&[Vector3]) -> f64`.

- [ ] Dodać `periodic_scalar_matches_density_integral`: Nx=3, spiny X/Y/-X, oczekiwana energia `8*A*V/dx²`; open oczekuje `4*A*V/dx²`. Nx=1/2, maski, niejednorodne A i pochodna energii są osobnymi cases.
- [ ] RED: `CHECK(exchange-energy, contract)` C-BLOCKED; brak kompilacji nie jest potwierdzeniem RED.
- [ ] Użyć kanonicznej energii z tego samego pola albo poprawnej sumy dodatnich wiązań z wrap; preferować współdzieloną semantykę boundary/material bez drugiego operatora. Nie zmieniać działających solver observables na błędną dotychczasową sumę.
- [ ] GREEN `CHECK(exchange-energy, contract)`; asercja skalar = całka gęstości oraz finite-difference zgodne z H_ex, tolerancja numeryczna ustalona dla FP64 z istniejących testów energii.
- [ ] Review i commit `fix: include periodic exchange bonds in scalar energy`.

### T04 — Walidacja dt na granicy ABI (FDM-A04)

**Owner:** native ABI. **Depends:** T00. **Files:** modify `backends/fdm/api/c_api.cpp`, `backends/fdm/CMakeLists.txt`; NOWY `backends/fdm/tests/multilayer_step_input_contract.cpp`.
**Interfaces:** istniejący `fullmag_fdm_backend_step`; error `FULLMAG_FDM_ERR_INVALID` przed mutacją stanu.

- [ ] Dodać `step_rejects_nonfinite_dt_without_mutation`: NaN/±Inf/0/ujemny dt; osobny case skończone dt z overflow czasu końcowego. Sentinele out_stats i hash m/czas/step pozostają identyczne.
- [ ] RED `CHECK(step-input, contract)` C-BLOCKED; target CUDA z tymi samymi feature macros co backend, wyłącznie publiczne ABI/gettery.
- [ ] Sprawdzać `isfinite(dt) && dt>0` oraz skończony czas docelowy przed trial/accounting. Klient Rust nie zastępuje walidacji C ABI.
- [ ] GREEN `CHECK(step-input, contract)` oraz poprawny następny krok po każdym odrzuceniu.
- [ ] Review i commit `fix: reject nonfinite FDM timestep inputs atomically`.

### T05 — Walidacja i rollback kandydata Heuna (FDM-A05)

**Owner:** native integratory. **Depends:** T04. **Files:** modify `multilayer_heun.cu`, `backends/fdm/api/c_api.cpp`, `backends/fdm/include/context.hpp`, CMake; NOWE `multilayer_trial_validation.cu/.cuh` w katalogu integratorów i `backends/fdm/tests/multilayer_trial_transaction_contract.cu`.
**Interfaces:** `validate_multilayer_trial` z sekcji 1, device error flag w workspace transakcji.

- [ ] Dodać `overflow_candidate_is_rejected`, `large_finite_normalizable_candidate_is_valid`, `nonfinite_predictor_rolls_back`, `failed_trial_does_not_advance_time`, `valid_retry_after_numeric_failure`; wstrzyknięcie błędu tylko w test build, nie publicznym produkcyjnym API. Duże skończone składowe, których kwadraty przepełniają naiwną normę, mają przejść stabilną normalizację; faktyczne przepełnienie składowej lub NaN/Inf ma odrzucić trial.
- [ ] RED `CHECK(trial-transaction, contract)` C-BLOCKED; użyć skończonego dt i dużego RHS, żeby nie testować wyłącznie T04.
- [ ] Obliczać normę przez skalowanie, kontrolować finite przed/po cast do storage i poprawność normy aktywnych komórek. Błąd dowolnego etapu zachować w device flag nawet gdy późniejszy etap daje finite; sprawdzić flagę przed commit.
- [ ] GREEN: rollback odtwarza m, czas, liczniki zaakceptowanego stanu, historię i frozen reference; nie emituje zaakceptowanego outputu. Telemetria prób/odrzuceń odzwierciedla faktyczną próbę zgodnie z kontrolerem transakcji; nie mylić jej z accepted step. Brak pełnego D2H wektora dla kontroli. `CHECK(trial-transaction, contract)`.
- [ ] Review i commit `fix: reject invalid multilayer Heun candidates before commit`.

### T06 — Nota naukowa, jeden descriptor i plan wykonania

**Owner:** kontrakt naukowy/planner. **Depends:** T01–T05 dla promocji dowodów.
**Files:** modify `docs/physics/0421-fdm-multilayer-convolution-demag.md` i `.source-map.json`, `docs/specs/capability-matrix-v0.md`, `docs/architecture/backend-golden-masterplan.md`, `crates/fullmag-fdm-demag/src/{descriptors,lib}.rs`, `crates/fullmag-ir/src/mesh_hints.rs`, `crates/fullmag-plan/src/fdm.rs`; NOWE moduły execution_plan i multilayer_execution z sekcji 1 oraz `crates/fullmag-plan/tests/multilayer_execution_plan.rs`.
**Interfaces:** `ResolvedMultilayerExecutionPlan`, `resolve_multilayer_execution`.

- [ ] Utrwalić w nocie fizykę P/P*, density conversion, volume reciprocity i energię; różnica modelu z resamplingiem względem dokładnego native-cell sum jest jawna i ma badanie zbieżności scratch. Nie obiecywać dokładności dowolnego resamplingu.
- [ ] Dodać `resolution_preserves_requested_intent`, `same_descriptor_for_preflight_and_dispatch`, `empty_layer_rejected`, `unknown_transfer_rejected`, `pbc_demag_remains_unsupported`; oba tryby i signed XYZ w macierzy.
- [ ] RED/GREEN `CHECK(execution-plan, contract)` C-BLOCKED. Źródłowo sprawdzić source-map poleceniem `python3 -B .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0421-fdm-multilayer-convolution-demag.source-map.json --repo-root .`.
- [ ] Zdefiniować wspólny pipeline planowania i cache keys; wybrać wspólne computational spacing per transform family, zachowując physical kernel-cell dimensions. Nie kopiować modeli już w descriptors.rs. Containment publiczny pozostaje do T21.
- [ ] Utrwalić pierwszy layout jako pełne zespolone C2C, zgodnie z zakazem przedwczesnej kompresji: descriptor, rozmiary widm, indexing, padding/crop, normalizacja oraz admission muszą opisywać tę samą reprezentację. Istniejące opisy R2C `Nx/2+1` nie są layoutem C2C; ich ograniczony zakres wyjaśnić w nocie i source-map. Ewentualne R2C wymaga później osobnej kwalifikacji.
- [ ] Review naukowy/ADR-check dla zmiany kontraktu; commit `feat: define canonical multilayer GPU execution descriptors`.

### T07 — Wersjonowane ABI v3 i atomowa aktywacja

**Owner:** ABI/native binding. **Depends:** T06. **Files:** nowe nagłówki/ingestion z sekcji 1; modify `native/include/fullmag_fdm.h`, `backends/fdm/api/plan_ingestion_v2.cpp` tylko adapter, `crates/fullmag-fdm-sys/src/lib.rs`, `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`, CMake; NOWY `backends/fdm/tests/multilayer_abi_v3_contract.cpp`.
**Interfaces:** create_multilayer_v3 i immutable plan; v2 bez zmiany rozmiaru/opisu pól.

- [ ] Dodać `v2_client_layout_unchanged`, `v3_rejects_count_pointer_mismatch`, `v3_rejects_unknown_version`, `v3_failed_activation_preserves_previous_handle`, `v3_duplicate_layer_ids_rejected`.
- [ ] RED `CHECK(abi-v3, contract)` C-BLOCKED; macierz C/C++/Rust size/offset, counts overflow, NaN geometrii, brak map/materiału.
- [ ] Walidować i skopiować plan do owned storage, wykonać admission przed alokacją GPU. Budować uchwyt tymczasowy, publikować dopiero po pełnym prepare; błąd nie niszczy istniejącego handle.
- [ ] GREEN `CHECK(abi-v3, contract)`; Rust przechowuje lifetimes wejść do końca create, native nie zatrzymuje cudzych host pointers.
- [ ] Review i commit `feat: add versioned multilayer GPU plan ABI`.

### T08 — Kanoniczny overlap push i adjoint pull (FDM-A06)

**Owner:** transfer CPU descriptor/native GPU. **Depends:** T06/T07.
**Files:** modify `crates/fullmag-fdm-demag/src/transfer.rs`, `gpu/cuda/runtime/context.cu`, `gpu/cuda/demag/multilayer_convolution.cu`; NOWE `multilayer_transfer.cu`, `backends/fdm/tests/multilayer_transfer_adjoint_contract.cu`, `crates/fullmag-fdm-demag/tests/overlap_transfer_map.rs`.
**Interfaces:** `OverlapTransferMap`, `build_overlap_map`; native plan przechowuje obie objętości i CSR, bez niezależnego trilinear pull.

- [ ] Dodać `half_covered_cell_preserves_half_moment`: jedna aktywna komórka zajmuje połowę scratch, expected push=M/2. `masked_cell_contributes_zero`, `weighted_adjoint_identity`, `unequal_thickness_kernel_density`, `fractional_xy_offset`.
- [ ] RED `CHECK(transfer-adjoint, contract)` C-BLOCKED; oracle liczony z geometrycznych overlapów niezależnie od produkcyjnego kernela CUDA.
- [ ] Eksportować jeden overlap descriptor, użyć pełnego V_scratch w push i V_native w pull. Na źródle uwzględnić Ms[i], a nie skalar Ms pierwszej warstwy. Zaimplementować density conversion dla two_d_stack zgodnie z 0421.
- [ ] GREEN: moment residual <=1e-12 FP64; adjoint i gradient energii <=1e-8; dodatkowo refinement scratch → malejący błąd względem native-cell oracle. Mapy dla identity pomijają koszt, lecz dają identyczny wynik.
- [ ] Review naukowy i commit `fix: implement moment preserving adjoint GPU layer transfers`.

### T09 — Katalog pełnych tensorów par i cache

**Owner:** demag kernel/catalog. **Depends:** T06/T08.
**Files:** modify `crates/fullmag-fdm-demag/src/{descriptors,shifted_kernel,newell}.rs`, `crates/fullmag-runner/src/fdm/cpu/multilayer_reference/construction.rs`; NOWE `gpu/cuda/demag/multilayer_plan.hpp/.cpp`, `backends/fdm/tests/multilayer_pair_kernel_contract.cpp`.
**Interfaces:** konsumuje `KernelCatalogSpec` i oriented descriptors, produkuje `MultilayerDemagPlan` z referencjami do unikalnych pełnych tensorów.

- [ ] Dodać `pair_offset_sign_and_permutation`, `unequal_volume_reciprocity`, `one_layer_matches_self`, `geometry_change_invalidates_kernel`, `magnetization_change_reuses_kernel` dla sześciu składowych.
- [ ] RED `CHECK(pair-kernel, contract)` C-BLOCKED; wartości oczekiwane z niezależnej cubature, nie z tej samej funkcji Newella.
- [ ] Wykorzystać kanoniczny builder par jako host setup, zweryfikować layout FFT/crop/lag i normalizację, upload raz na unikalny kernel. Klucz zawiera obie geometrie, XYZ, tryb, precision i wersję; full-complex najpierw, bez przedwczesnej kompresji symetriami.
- [ ] GREEN dla ±XYZ, nieparzystych/parzystych rozmiarów i odległych warstw; brak demag między warstwami po pominięciu pary ma być wykryty testem, nie tolerancją.
- [ ] Review i commit `feat: build descriptor keyed multilayer tensor catalogs`.

### T10 — Workspace, FFT i dokładny admission pamięci

**Owner:** GPU resources. **Depends:** T07/T09. **Files:** NOWY `gpu/cuda/demag/multilayer_workspace.cu`; modify `multilayer_plan.hpp`, `include/context.hpp`, Rust execution_plan i CMake; NOWY `backends/fdm/tests/multilayer_workspace_budget_contract.cu`.
**Interfaces:** `prepare_multilayer_demag`, workspace własnością jednego Context; manifest alokacji współdzielony z admission.

- [ ] Dodać `budget_counts_all_stage_buffers`, `count_multiplication_overflow_rejected`, `oom_at_each_allocation_preserves_old_state`, `workspace_reused_after_warmup`, `failed_fft_plan_releases_trial_only`.
- [ ] RED `CHECK(workspace-budget, contract)` C-BLOCKED; fault injection obejmuje każdą alokację i tworzenie planu FFT, nie rzeczywiste wyczerpanie całego GPU.
- [ ] Policzyć native vectors/materials/masks, overlap, unique kernel spectra, source/destination spectra, cuFFT work area, history/retry/checkpoint/snapshot. Rzeczywisty work area ustalić na setup i ponownie sprawdzić budżet przed aktywacją; nie udawać znajomości jego rozmiaru z samej liczby komórek.
- [ ] Prealokować, powiązać strumień i ownership; porcjować pary wyłącznie wewnątrz urządzenia. GREEN: brak wzrostu allocations po warmup, jawny peak i brak niezinwentaryzowanych buforów. `CHECK(workspace-budget, contract)`.
- [ ] Review i commit `feat: account and reuse complete multilayer GPU workspaces`.

### T11 — Kompletny operator FP64

**Owner:** native demag. **Depends:** T08–T10. **Files:** NOWY `gpu/cuda/demag/multilayer_operator.cu`; modify `multilayer_convolution.cu` jako adapter, `include/kernels.hpp`, CMake; NOWY `backends/fdm/tests/multilayer_operator_fp64_contract.cu`.
**Interfaces:** `refresh_multilayer_demag(Context&, cudaStream_t)`; nie zmienia m/czasu.

- [ ] Dodać `fp64_native_field_matches_independent_oracle` i `energy_gradient_matches_field` dla L=1/2/3, obu trybów, materiałów i wszystkich klas transferu z T08/T09.
- [ ] RED `CHECK(operator-fp64, contract)` C-BLOCKED; świadomie usunięta jedna cross-pair lub odwrócony offset musi dawać FAIL.
- [ ] Push każdej warstwy, FFT źródeł raz per family, akumulacja wszystkich par do wyzerowanych widm celu, inverse raz per cel/family, normalize/crop/pull. Zera odświeżać na każdym refresh, także po błędzie/retry.
- [ ] GREEN `CHECK(operator-fp64, contract)`; dla wspólnego layoutu measured forward=L, inverse=L, pairs=L². Dla wielu layoutów liczniki wynikają z planu i zmierzonych wywołań, nie stałych deklaracji.
- [ ] Review i commit `feat: execute full FP64 multilayer convolution on GPU`.

### T12 — Materiały, pola lokalne i Frozen Spins

**Owner:** interakcje native. **Depends:** T07/T11. **Files:** modify `gpu/cuda/interactions/multilayer_{exchange,anisotropy,dmi,effective_field}.cu`, `multilayer_heun.cu`, `multilayer_explicit_rk.cu`, ABI v3; NOWY `backends/fdm/tests/multilayer_material_frozen_contract.cu`.
**Interfaces:** per-cell Ms/A/alpha i mask/reference w planie, jeden RHS z sekcji 1.

- [ ] Dodać `cellwise_ms_changes_source_moment`, `heterogeneous_exchange_matches_cpu`, `cellwise_alpha_changes_rhs`, `frozen_spins_exact_after_every_stage`, `inactive_cells_never_generate_field_source`.
- [ ] RED `CHECK(material-frozen, contract)` C-BLOCKED; pola lokalne porównać oddzielnie, nie wyłącznie H_eff.
- [ ] Przenieść walidowane mapy i reference raz na GPU; exchange używa właściwego face A i Ms[i]. Frozen Spins zeruje RHS i odtwarza reference w etapach bez wyłączania magnetostatycznego wkładu zamrożonych spinów.
- [ ] GREEN `CHECK(material-frozen, contract)`; zachować legalne anizotropie/DMI/Zeeman, nie otwierać odmów BulkDMI ani innych modeli bez kontraktu.
- [ ] Review i commit `feat: support layer material fields and frozen spins on GPU`.

### T13 — Wspólny RHS oraz fixed Heun/RK4/RK23

**Owner:** integratory native. **Depends:** T05/T11/T12. **Files:** NOWE `multilayer_rhs.cu/.cuh`; modify `multilayer_heun.cu`, `multilayer_explicit_rk.cu`, CMake; NOWY `backends/fdm/tests/multilayer_fixed_integrators_contract.cu`.
**Interfaces:** `evaluate_multilayer_rhs`, `validate_multilayer_trial`; obecna transakcja wykonuje commit dokładnie raz.

- [ ] Dodać `rhs_uses_trial_not_accepted_m`, `stage_fields_match_cpu`, `fixed_integrator_dt_refinement` dla każdego integratora i time-dependent field dopuszczonego przez planner.
- [ ] RED `CHECK(fixed-integrators, contract)` C-BLOCKED; odebrane czasy etapów porównać z tableau, nie zawsze t_n.
- [ ] Wpiąć jeden RHS do wszystkich etapów; zreuse'ować sprawdzone tableaux, nie kopiować fizyki do poszczególnych integratorów. Włączyć finite checks T05 do każdego etapu.
- [ ] GREEN `CHECK(fixed-integrators, contract)`; parity RHS/stage/step i zbieżność dt, normy m oraz brak H2D/D2H wektorów w nieobserwowanym kroku.
- [ ] Review i commit `feat: integrate resident multilayer fields with fixed RK stages`.

### T14 — Fixed RK45 i ABM3

**Owner:** integratory native. **Depends:** T13. **Files:** modify `multilayer_explicit_rk.cu`; NOWY `multilayer_abm3.cu`, `backends/fdm/tests/multilayer_history_integrators_contract.cu`; konsumować istniejące `llg_dp45_fp64.cu`, `llg_abm3_fp64.cu` jako wzorce, bez zmiany single-grid.
**Interfaces:** wspólny RHS, workspace stage/history; historia ABM aktualizowana wyłącznie w commit.

- [ ] Dodać `rk45_all_stages_use_multilayer_rhs`, `abm3_startup_matches_reference`, `abm3_rejected_step_keeps_history`, `abm3_dt_change_restarts_history`, `abm3_exact_terminal_interval`.
- [ ] RED `CHECK(history-integrators, contract)` C-BLOCKED.
- [ ] Zrealizować fixed RK45 i ABM3 z jawnym startup/restart zgodnym z aktualnym kontraktem CPU. Zmiana dt lub niepełny ostatni krok nie może konsumować stałokrokowych współczynników starej historii.
- [ ] GREEN `CHECK(history-integrators, contract)`; kilka pierwszych kroków, stan ustalony historii, split-run po T16 i dt convergence; brak degradacji do Heuna bez provenance.
- [ ] Review i commit `feat: add resident multilayer RK45 and ABM3 execution`.

### T15 — Adaptive RK23/RK45 i pełna transakcja

**Owner:** adaptive native. **Depends:** T13/T14. **Files:** NOWY `multilayer_adaptive.cu`; modify `runtime/adaptive_controller.cuh`, `step_transaction_controller.hpp`, `multilayer_explicit_rk.cu`, CMake; NOWY `backends/fdm/tests/multilayer_adaptive_transaction_contract.cu`.
**Interfaces:** aktualny kontrakt adaptive tolerances/reason codes, RHS i trial validator; brak hostowej orkiestracji etapów.

- [ ] Dodać `adaptive_reject_retry_matches_cpu`, `dt_min_exhaustion_fails`, `fsal_invalidated_on_material_or_field_change`, `interrupt_rolls_back_all_layers`, `rejected_trial_never_emits_snapshot`.
- [ ] RED `CHECK(adaptive-transaction, contract)` C-BLOCKED; wymusić co najmniej jedno odrzucenie, nie ograniczać dowodu do bezproblemowych kroków.
- [ ] Użyć istniejącego kontrolera błędu i polityki normy, zsynchronizowanego trial dla wszystkich warstw; FSAL i historia należą do accepted/trial transaction. Termika adaptive pozostaje nieobsługiwana zgodnie z obecnymi bramkami.
- [ ] GREEN `CHECK(adaptive-transaction, contract)`; porównać accept/reject sequence i końcowy czas, finite m, brak force-accept przy dt_min, budżet retry i poprawne wznowienie po interrupt.
- [ ] Review i commit `feat: add transactional adaptive multilayer RK execution`.

### T16 — Checkpoint i accepted-state identity

**Owner:** stan/runtime. **Depends:** T14/T15. **Files:** NOWY `gpu/cuda/runtime/multilayer_checkpoint.cpp`, `backends/fdm/tests/multilayer_checkpoint_contract.cpp`; modify `llg_checkpoint.cpp`, `native.rs`, `crates/fullmag-runner/src/accepted_materialization.rs`, `observation_runtime.rs`.
**Interfaces:** `MultilayerCheckpointV1` z sekcji 1; istniejące ABI entrypointy wersjonują payload i odrzucają niewspieraną wersję.

- [ ] Dodać `split_run_matches_continuous` dla każdego integratora, `restore_wrong_grid_rejected`, `restore_truncated_history_rejected`, `observation_uses_accepted_step`, `frozen_reference_survives_restart`.
- [ ] RED `CHECK(checkpoint, contract)` C-BLOCKED; snapshot w trakcie odrzuconego trial nie może odsłonić jego m.
- [ ] Serialize/restore komplet m/time/history/controller/frozen + fingerprint; native bufory robocze odbudować, nie serializować adresów/pointerów CUDA. Restore atomowy; niezgodna scena nie migruje automatycznie.
- [ ] GREEN `CHECK(checkpoint, contract)`; legacy payload nadal odczytywany w swoim zakresie, brak utożsamienia starej assisted realizacji z nową.
- [ ] Review i commit `feat: preserve multilayer accepted state across checkpoints`.

### T17 — Pełna FP32 z redukcjami FP64

**Owner:** native precision. **Depends:** T11–T16. **Files:** operator/transfer/workspace/integratory z poprzednich tasków, `scripts/fdm_multilayer_cuda_precision_contract.py`, jego istniejące testy, `docs/physics/0300-gpu-fdm-precision-and-calibration.md`; NOWY `backends/fdm/tests/multilayer_fp32_parity_contract.cu`.
**Interfaces:** nowe jawne realization IDs `fullmag.fdm.cuda.multilayer.full_double.v1` i `fullmag.fdm.cuda.multilayer.single_storage_fp64_reduction.v1`; dokładne ID propagowane planner→ABI→receipt.

- [ ] Dodać `fp32_realization_matches_executed_precision`, `fp32_cast_overflow_rejected`, `fp32_reductions_accumulate_in_double`, `fp32_all_integrators_match_fp64_accuracy_budget`.
- [ ] RED/GREEN Python: `PYTHONDONTWRITEBYTECODE=1 python3 -B -m pytest -q -p no:cacheprovider scripts/test_fdm_multilayer_cuda_precision_contract.py`; native `CHECK(precision-fp32, contract)` C-BLOCKED.
- [ ] Uogólnić zweryfikowane FP64 kernels na storage/compute FP32 z osobną FFT precision; normy/energie/metryki redukować FP64. Nie nazywać całego operatora FP64 z powodu samych redukcji.
- [ ] GREEN: pełna macierz, nie tylko single-grid; objętościowo ważony RMS i Linf, moment/energia według progów, długie trajektorie i time-to-accuracy.
- [ ] Review i commit `feat: qualify multilayer single precision with double reductions`.

### T18 — Runner, provenance, outputy i Compute Fields

**Owner:** integracja runner/resource. **Depends:** T02/T06/T16/T17.
**Files:** NOWY `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer/resident.rs`;
modify `multilayer.rs`, `native.rs`, `accepted_materialization.rs`, `observation_runtime.rs`,
`crates/fullmag-api/src/accepted_field_materialization.rs`, `accepted_field_materialization_worker.rs`,
`accepted_field_binary.rs`, `scripts/verify_fdm_multilayer_airbox_carrier.py`;
tests `multilayer/tests.rs` oraz `scripts/test_verify_fdm_multilayer_airbox_carrier.py`.
**Interfaces:** ten sam resolved execution plan w preflight i dispatch; per-layer artifact identity T02, receipt z precision T17 i checkpoint T16.

- [ ] Dodać `preflight_matches_executed_realization`, `forced_gpu_never_uses_assisted`, `explicit_multilayer_never_becomes_single_grid`, `field_scope_keeps_layer_ids`, `stale_accepted_revision_is_rejected`.
- [ ] RED `CHECK(runner-observation, contract)` C-BLOCKED; Python carrier suite może działać bez kompilacji: `PYTHONDONTWRITEBYTECODE=1 python3 -B -m pytest -q -p no:cacheprovider scripts/test_verify_fdm_multilayer_airbox_carrier.py`.
- [ ] Runner przekazuje descriptor i obsługuje snapshoty, nie wylicza demag/LLG. Pola/energie opisują accepted step i grid. Rozdzielić setup, warm-step, snapshot i target-only Airbox telemetry.
- [ ] GREEN: Compute Fields pobiera właściwe warstwy i precision; Airbox jest odrębnym targetem, nie FFT scratch. Zachować istniejące endpointy i binary data plane, bez JSON pełnego pola.
- [ ] Review API/resource i commit `feat: connect resident multilayer execution to accepted fields`.

### T19 — Macierz naukowa i verifiery

**Owner:** niezależna kwalifikacja. **Depends:** T01–T18.
**Files:** NOWY `scripts/fdm_multilayer_rebuild_matrix.py`,
`scripts/test_fdm_multilayer_rebuild_matrix.py`; modify trzy istniejące verifiery
`verify_fdm_multilayer_{cuda_parity,independent_oracle,transfer_parity}.py`,
ich testy, `tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json` wyłącznie dla jawnej definicji metryk;
NOWY `tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario_rebuild_matrix.py`.
**Interfaces:** registry case_id → geometria/materiał/integrator/precision/expected legality; evidence wiąże case, source, device, thresholds hash i wszystkie frames.

- [ ] Dodać `matrix_has_every_required_tuple`, `missing_case_blocks_qualification`, `missing_energy_blocks_qualification`, `corrupt_early_frame_blocks_aggregate`, `wrong_device_identity_blocks_aggregate`.
- [ ] RED/GREEN Python `PYTHONDONTWRITEBYTECODE=1 python3 -B -m pytest -q -p no:cacheprovider scripts/test_fdm_multilayer_rebuild_matrix.py`; wszystkie brakujące dowody dają nonzero exit.
- [ ] Założyć cases C01–C10 z sekcji 4; oracle bez produkcyjnego kernel buildera i transfer map. Dla resamplingu porównywać najpierw zgodność z zadeklarowanym P/P*, następnie oddzielnie zbieżność do native-cell oracle.
- [ ] Zdefiniować weighted RMS przez wagi aktywnych objętości native, sumę wag i jawny field floor z progów; osobno raportować błędy każdej warstwy, aby duża warstwa nie ukryła małej. Weryfikować pełną trajektorię i energie.
- [ ] `CHECK(scientific-matrix, runtime)` po legalnym zbudowaniu właściwego runtime; receipt zawiera niezmienne źródła. Wynik musi obejmować każdy wymagany case; `skipped` nie jest PASS. Review i commit `test: qualify the full multilayer GPU operator matrix`.

### T20 — Wydajność, produkt i dowód end-to-end

**Owner:** performance/product QA. **Depends:** T19.
**Files:** registry/dispatcher T00/T19, istniejący
`apps/control-room/scripts/smoke-fdm-multilayer-webgl-matrix.mjs`,
`packages/fullmag-py/tests/test_fdm_multilayer_contract.py`;
NOWY `scripts/verify_fdm_multilayer_rebuild_performance.py` i jego test
`scripts/test_verify_fdm_multilayer_rebuild_performance.py`.
**Interfaces:** receipt cold/warm, measured FFT calls/allocations/transfers/peak VRAM/time, case+GPU identity; export/reimport ten sam requested IR.

- [ ] Dodać `nonzero_warm_vector_transfer_fails`, `warm_allocation_fails`, `wrong_fft_family_count_fails`, `source_runtime_mismatch_fails`, `export_roundtrip_preserves_multilayer_settings`.
- [ ] RED/GREEN źródłowo przez pytest pliku performance i testu DSL; `CHECK(performance, benchmark)` dopiero po właściwym runtime. Benchmark L=1/2/3/8/16 w budżecie; OOM case raportowany oddzielnie, nie usuwany z tabeli.
- [ ] Zmierzyć setup, pierwszy refresh, co najmniej 100 warm refresh i trajektorie przy równoważnej dokładności. Zero warm malloc i wektorowego H2D/D2H jest wymogiem; scalars/status i jawne snapshoty liczyć oddzielnie. Liczniki potwierdzić trace urządzenia, nie wartościami expected.
- [ ] `CHECK(product-e2e, runtime)`: nowa scena → eksport/import → solve → accepted-state fields per layer → Airbox → restart → ponowne odczyty. Sprawdzić canvas visible, `isContextLost()==false`, drawing buffer >0; maska i warstwa nie mogą zostać pomylone. Nie zmieniać UI, jeśli istniejący kontrakt wystarcza.
- [ ] Review i commit `test: verify multilayer GPU residency performance and product flow`. Brak obowiązkowej deklaracji przyspieszenia: raport ma zawierać rzeczywiste wyniki i regresje.

### T21 — Przełączenie produkcyjne, usunięcie duplikacji i integracja

**Owner:** koordynator integracji. **Depends:** T00–T20, wszystkie G0–G7.
**Files:** `crates/fullmag-plan/src/fdm.rs`, nowy selector, runner `multilayer.rs`
i helpery `double_precision.rs`, `single_precision.rs`, `math.rs`, `native_stacked.rs`
wyłącznie w zakresie wykazanych zbędnych ścieżek; capability matrix,
backend masterplan, nota 0421/source-map i qualification-matrix.md.
**Interfaces:** jeden produkcyjny owner nowego multilayer GPU; stare artefakty czytelne, jawny rollback wersji wdrożenia.

- [ ] Dodać `every_qualified_tuple_routes_to_v3`, `unsupported_tuple_fails_before_allocation`, `legacy_artifact_remains_readable`, `unqualified_build_cannot_claim_production`; `CHECK(cutover, contract)` C-BLOCKED do zdjęcia zakazu.
- [ ] Dopiero po pełnym dowodzie otworzyć containment dla dokładnie przetestowanych kombinacji. Nie zastąpić guardów bezwarunkowym true; przypadki spoza spec nadal odrzucane.
- [ ] Zinwentaryzować konsumentów legacy i usunąć wyłącznie wykazane duplikaty GPU operatora/host hot loop objęte przebudową. Single-grid dla prawdziwych single-grid zadań zostaje. Zaktualizować starszy plan z 2026-08-09 wskazaniem następcy, nie usuwać historycznych dowodów.
- [ ] Końcowe review nauki/ABI/runtime/API i diffu; `CHECK(cutover, contract)` oraz niezmienione aktualne dowody T19/T20. Brak testu kompilowanego lub kwalifikacji daje `blocked`, nie warunkowe production-ready.
- [ ] Commit `refactor: make qualified resident multilayer the GPU execution owner`; następnie `finishing-a-development-branch`: push → PR do master → kontrole/akceptacje → merge → bezpieczny lokalny FF → weryfikacja integracji → drain tylko grupy zadania → usunięcie wyłącznie zweryfikowanego worktree/brancha i dozwolonych cache → zamknięcie rejestru. Każdy blocker zapisać z HEAD, PR, zasobem i następnym krokiem.

## 4. Macierz fixture'ów i pokrycia

Każdy przypadek ma deterministyczny seed, SI, jawne shape/origin/cell/mask,
case hash, identyczną scenę CPU/GPU i expected support. Małe przypadki oracle
muszą mieścić się w direct computation; benchmarki mają osobne wejścia.

Kontrakt metryki T19, do utrwalenia w nocie i progach przed promocją FP32:
dla każdej klatki osobno waga komórki to aktywna objętość `V_i`,
`H_scale = max(abs(H_reference[i, component]))`,
`H_floor = max(1 A/m, 1e-8 * H_scale)`, `D = max(H_scale, H_floor)`.
`weighted_rms = sqrt(sum_i(V_i * sum_component(delta_H²)) / (3 * sum_i(V_i))) / D`;
`component_linf = max(abs(delta_H)) / D`. Dodatkowo identyczną ocenę wykonać
per-layer z jej własnym D. Każda klatka i każda warstwa musi spełnić progi;
agregacja nie może ukrywać lokalnego błędu. Zerowa suma aktywnych objętości
jest błędem wejścia. FP64 nadal używa `max_abs <= atol + rtol*max(H_scale,1 A/m)`
osobno dla klatki i warstwy. Badanie tolerancji heterogenicznych przypadków
może wykazać konieczność nowej wersji kontraktu; nie zmieniać wzorów po cichu.

| ID | Wejście | Asercje | Owner |
|---|---|---|---|
| C01 | L=1, identity, 2D i 3D, grid 1/2/3 w każdej osi | Self-kernel, jednostki, trace, zgodność single-layer | T09/T11 |
| C02 | L=2/3, ±Z i ±XY, permutacja warstw, nieparzyste gridy | Sześć tensor components, orientacja, reciprocal energy | T09/T11 |
| C03 | Różne hz oraz dx/dy o stosunkach 1, 1.5, 2; częściowe pokrycie | Moment, P/P*, energy derivative, scratch refinement | T08/T19 |
| C04 | Maski z dziurą, pojedyncza aktywna komórka, pusta warstwa | Brak wkładu inactive; pusta warstwa odrzucona | T06/T08/T12 |
| C05 | Per-cell Ms/A/alpha, materiały różne między warstwami, Frozen Spins | Pola oddzielnych interakcji, reference i RHS | T12/T13 |
| C06 | Fixed Heun/RK4/RK23/RK45/ABM3, zmiana dt, terminal partial step | Stage/step parity, dt convergence, historia | T13/T14 |
| C07 | Adaptive RK23/RK45, wymuszony reject, dt_min, interrupt | Transakcja/FSAL/retry bez ghost snapshot | T05/T15 |
| C08 | Split-run i restart każdego integratora, zmiana geometrii | Historia/frozen reference odtworzone lub jawna odmowa | T16/T18 |
| C09 | NaN/Inf/overflow sizes/dt, zły ABI, fault-injected OOM | Brak częściowej aktywacji i mutacji accepted state | T04/T05/T07/T10 |
| C10 | Zepsute frames/IDs/czasy, duplikaty IDs, zły SHA/device | Qualification fail-closed | T01/T02/T19 |

FP64 i FP32 osobno dla wszystkich legalnych cases. Długie trajektorie:
co najmniej 10 000 zaakceptowanych kroków reprezentatywnego fixed case i
przebieg adaptive z co najmniej 100 odrzuceniami kontrolowanymi wejściem;
nie zastępują dt refinement ani wszystkich cases. Jeżeli taka liczba
odrzuceń nie występuje, dopasować fixture/tolerancję przed zamrożeniem
baseline, nie fałszować licznika. Dokładny czas fizyczny i dt wynikają z
zamrożonego scenariusza oraz stability/convergence study.

## 5. Zależności, ownership i granice commitów

Łańcuch krytyczny: T00 → T01/T02 + T03 + T04/T05 → T06 → T07 → T08 →
T09 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17 → T18 → T19 → T20 → T21.
T03 i T04/T05 mogą być wykonane niezależnie od verifiera. Dokumentację naukową
T06 można przygotowywać równolegle, lecz nie promować wyników przed naprawą
referencji i bramek. T19 fixture inventory można przygotować wcześniej;
jego runtime acceptance zależy od pełnej implementacji.

Domyślnie 1–2 workerów według AGENTS, tylko rozłączne zakresy. Koordynator
posiada `justfile`, CMake, publiczny ABI, selector i staging. Zmiany w tych
plikach zgłasza się przez kontrakt, nie przez konkurujące zapisy. Bounded
worker otrzymuje dokładny task, pliki, spec i test acceptance; brak dalszej
delegacji bez potrzeby. Nie zmieniać modelu/effort poza polityką użytkownika.
Self-review tego planu wykonuje autor, bez kolejnego ceremonialnego reviewera.

Task może mieć kilka spójnych commitów, gdy test i implementacja muszą być
rozdzielone technicznie; nie scalać oddzielnie półdziałającego operatora.
Jeżeli limit zakresu review wymaga podziału, zachować jeden kontrakt końcowy
i powyższy graf zależności. Status taska: `planned`, `in_progress`,
`implemented/unverified`, `verified`, `blocked`; żaden jest dziś `verified`.

## 6. Zamknięcie audytu i wymagania projektu

| Finding / wymaganie | Task naprawczy | Dowód zamknięcia |
|---|---|---|
| A01 wcześniejsze NaN/błędne klatki | T01 | Mutacje dowolnej klatki odrzucane; pełna parity |
| A02 różne warstwy/gridy/czasy | T02 | Negatywne identity cases i legalna permutacja |
| A03 periodyczna energia CPU | T03 | 8*A*V/dx² versus 4*A*V/dx² i density/derivative |
| A04 niepoprawne dt ABI | T04 | Niepoprawny argument nie zmienia żadnego accepted state |
| A05 niefinitywny kandydat | T05 + T13–T15 | Każdy etap kontrolowany; rollback/retry |
| A06 niekanoniczny transfer | T08 | Moment, adjoint, density, GPU/CPU/oracle |
| Pełne two_d_stack/three_d i heterogeniczne siatki | T06–T11/T19 | C01–C04, G0/G2/G3 |
| Materiały, maski, Frozen Spins | T12 | C04/C05 |
| Wszystkie zaakceptowane integratory | T13–T15 | C06/C07, G4 |
| Checkpoint/accepted state | T16/T18 | C08, brak trial leaks |
| FP32 i precision provenance | T17 | G5 dla całego zakresu |
| Admission, brak hot-loop transferów/alokacji | T10/T20 | G1/G6, trace i rzeczywisty peak |
| DSL/IR, outputy, Airbox, WebGL | T06/T18/T20 | G7, export round-trip i browser proof |
| Zastąpienie legacy i integracja | T21 | G8, rejestr/PR/cleanup bez obcych strat |

## 7. Definition of Done i handoff

- [ ] Wszystkie T00–T21 zakończone, każdy finding ma regression proof i pełny commit SHA naprawy.
- [ ] G0–G8 z zaakceptowanego projektu mają aktualny source-bound dowód; brak ukrytych `skipped`, samego `implemented` lub ręcznie wpisanych measured counters.
- [ ] Nowy operator jest jedynym produkcyjnym właścicielem tego zakresu multilayer GPU; publiczny fallback nie maskuje braków.
- [ ] Zakaz kompilacji testów został jawnie odwołany przed ich kompilacją; wymagane testy faktycznie wykonano. W przeciwnym razie integracja pozostaje zablokowana.
- [ ] Raport końcowy odróżnia source/contract, runtime, physics, performance i browser; wskazuje źródła, GPU, precision, thresholds, artefakty i ograniczenia.
- [ ] PR scalony i lokalny cykl zamknięty bez naruszenia cudzych zmian/zasobów albo jawny `blocked` z następnym krokiem.

**Stan przekazania tego dokumentu:** użytkownik zamówił wyłącznie plan.
Nie wykonywać T00 ani żadnego kolejnego taska bez osobnego zlecenia implementacji.
Nie ma potrzeby pytać teraz o uruchomienie, modele ani wykonanie testów.
Podczas sporządzania planu sprawdzono ścieżki istniejących właścicieli,
powiązanie wymagań z taskami, sześć findingów, zgodność interfejsów i linki.
Nie uruchamiano planowanych komend ani nie tworzono modułów implementacji.
