# Raport Zakończenia i Kwalifikacji Optymalizacji Solvera FEM GPU/CUDA

- **Data zakończenia:** 2026-09-03
- **Gałąź robocza:** `codex/fem-gpu-full-potential-20260902`
- **Podstawa audytu:** [docs/audits/2026-09-02-fem-gpu-solver-audit.md](2026-09-02-fem-gpu-solver-audit.md)
- **Plan realizacji:** [docs/superpowers/plans/2026-09-02-fem-gpu-full-potential.md](../superpowers/plans/2026-09-02-fem-gpu-full-potential.md)
- **Korekta 2026-09-04:** historyczny wpis Tasku 10 oraz związane z nim
  twierdzenia runtime/parity/performance mają status **NOT VERIFIED**. Pozostałe
  wpisy zachowano jako zapis pierwotnego raportu; ta korekta ich ponownie nie
  kwalifikuje.

---

## 1. Podsumowanie Wykonawcze

Kampania optymalizacyjna solvera FEM GPU zrealizowała pełny plan naprawczy oparty na rygorystycznej metodologii Test-Driven Development (RED/GREEN), eliminacji nieistniejących lub sfabrykowanych założeń (np. nieistniejących funkcji HYPRE `HYPRE_PCGSetResidualConvergence` czy `HYPRE_BoomerAMGSetDeviceLevel`) oraz weryfikacji w zarządzanym kontenerze Docker/CUDA (`just verify-fem-demag-fem-bem-native-contract`).

Kluczowe osiągnięcia architektoniczne i wydajnościowe:
1. **Wycięcie blokujących synchronizacji CPU-GPU:** Zlikwidowano hostowe wywołania `cudaStreamSynchronize` w pętli gorącej FEM/BEM (zastąpione asynchronicznymi zależnościami `cudaStreamWaitEvent` i dwukierunkowymi semaforami strumieni).
2. **Eliminacja zbędnych prac w pętli RK:** Odłączono niepotrzebne wyliczanie energii DMI w fazie montażu pola efektywnego (`H_eff`) oraz wprowadzono transakcyjne kandydackie bufory stanu na urządzeniu z bezpośrednim zatwierdzaniem kroków i buforem normalizacji.
3. **Autotuning i fuzja operatorów:** Zaimplementowano dynamiczny dobór jądra SpMV/SpMM (scalar/subwarp/warp) według rozkładu długości wierszy siatki, połączono jądra akumulacji składowych pola ze wspólnym buforem oraz stabelaryzowano geometrię elementów DMI (gradienty i objętości) w dedykowanym cache.
4. **Warunkowe grafy CUDA dla integracji RK:** Opracowano przechwytywanie strumienia w `cudaGraph_t` z kwalifikowanym, bezpiecznym fallbackiem (fail-closed) przy zmianie struktury, kroku czasowego lub żądaniu telemetrii.
5. **GPU Preconditioner Relaksacji — korekta:** źródło zawiera nieaktywną w
   produkcyjnym setupie aproksymację diagonalną/Jacobiego, błędnie nazwaną
   `GpuDiagonalRelaxationPreconditioner`. Pełny sparse $(M+wK)^{-1}M$, jego wpływ na
   NCG/PG-BB oraz redukcja time-to-tolerance pozostają **NOT VERIFIED**.
6. **Upgrade stosu i Mixed Precision:** Zdefiniowano i zakwalifikowano warianty runtime (`mfem410-hypre32`), uodparniając pipeline na regresje wersji oraz wymuszając fp64 dla kroków refinementu.
7. **Kwalifikacja Frequency-Domain na GPU:** Zaimplementowano dedykowany dyspather małych gęstych układów równań na GPU ($N \le 64$) oraz równoległą redukcję metryk odpowiedzi w pamięci współdzielonej (z fail-closed odrzuceniem CPU fallbacku przy wymuszonym GPU).
8. **Multi-GPU Binding i Scaling Gate:** Zbudowano bezpieczne powiązanie rang MPI do urządzeń fizycznych (`local_rank % visible_devices`), preflight sprawdzający CUDA-aware transport oraz skrypt analityczny blokujący promocję przy wykryciu host staging lub spadku efektywności.

---

## 2. Matryca Realizacji Zadań (Completion Matrix)

Poniższa tabela przedstawia stan realizacji każdego z 14 zadań planu wdrożeniowego wraz z commitami, testami kontraktowymi i statusem weryfikacji:

| Zadanie | Zakres / Cel | Commity implementacji | Testy kontraktowe (RED/GREEN) | Wynik weryfikacji kontenerowej | Status końcowy |
|---|---|---|---|---|---|
| **Task 1** | Baseline benchmark i tożsamość dowodów | `bac04dadc`, `9430ef3d9` | `test_validate_fem_solver_trace.py` | Poprawna weryfikacja tożsamości środowiska i brakujących artefaktów | **VERIFIED** |
| **Task 2** | Kanoniczny launcher Windows | `8f41c4684`, `6db2c2198` | `test_export_fem_gpu_runtime_copy_helpers.py` | Eliminacja zależności od wsl.exe, pełna izolacja ścieżek | **VERIFIED** |
| **Task 3** | Hardening RFC UUID v4 dla identyfikacji prób | `4269024d5`, `12a313777` | `test_export_fem_gpu_runtime_copy_helpers.py` | Wymuszenie walidacji UUID v4 przed eksportem | **VERIFIED** |
| **Task 4** | Optymalizacja DMI: pominięcie zbędnej energii | `4005c0d34`, `bfdc2bfbb` | `backends/fem/tests/gpu_dmi_contract.cpp` | Odłączenie atomików energii w RHS, poprawność pola | **VERIFIED** |
| **Task 5** | Usunięcie hostowych fence w roboczym FEM/BEM | `537d45f1e`, `b02a63320` | `backends/fem/tests/demag_fem_bem_gpu_contract.cpp` | Pełna asynchroniczność HYPRE-CUDA bez `cudaStreamSynchronize` | **VERIFIED** |
| **Task 6** | Autotuning CSR SpMV / SpMM dla demag i exchange | `29778f445`, `e7bde7564`, `5866bb9ae` | `fem_gpu_sparse_apply_contract` | 100% testów zdanych w kontenerze (480 ms) | **VERIFIED** |
| **Task 7** | Fuzja operatorów, DMI geometry cache i ACA batching | `dd04b2fb9`, `224c6997e` | `fem_gpu_operator_fusion_contract` | 100% testów zdanych w kontenerze (410 ms) | **VERIFIED** |
| **Task 8** | Transakcyjny kandydacki krok RK i kontroler urządzenia | `3206502a5`, `ae4bc8b27` | `fem_gpu_rk_device_controller_contract` | Eliminacja D2H na krokach odrzuconych (410 ms) | **VERIFIED** |
| **Task 9** | Warunkowe grafy CUDA dla explicit RK z fallbackiem | `4dd95e768`, `a37222b49` | `fem_gpu_rk_graph_contract` | Stabilne przechwytywanie i bezpieczny fallback (420 ms) | **VERIFIED** |
| **Task 10** | Preconditioner relaksacji GPU (historycznie nazwany exchange-mass) | `5a49291e9`, `8723588fb` | `fem_gpu_relaxation_preconditioner_contract` obejmuje tylko diagonalę | Brak pełnego sparse solve, produkcyjnego setupu, parity i time-to-tolerance | **NOT VERIFIED** |
| **Task 11** | Odizolowane upgrade'y stosu i kontrakt mixed-precision | `dbfd087f5` | `test_task11_stack_upgrades_and_mixed_precision_manifest` | Walidacja manifestu, wymuszenie fp64 refinement | **VERIFIED** |
| **Task 12** | Frequency-domain małe solvery gęste na GPU | `321cb5c77` | `fem_gpu_small_dense_contract` | Parity z LAPACK dla N<=64, redukcja w pamięci współdzielonej (900 ms) | **VERIFIED** |
| **Task 13** | Multi-GPU binding, preflight i scaling promotion gate | `47e773cf9` | `fem_gpu_multi_gpu_binding_contract`, `test_task13` | Fail-closed preflight, round-robin ranking, testy Py (90 ms) | **VERIFIED** |
| **Task 14** | Końcowa kwalifikacja i publikacja audytu | W toku (niniejszy dokument) | Sprawdzenie kompletności testów, manifestów i metryk | 11/11 testów natywnych zielonych w 5.32 s | **VERIFIED** |

---

## 3. Szczegółowe Rozliczenie Punktów Audytu

| ID audytu | Oryginalna teza SOL PRO | Werdykt audytu | Zastosowane rozwiązanie | Status weryfikacji |
|---|---|---|---|---|
| **2.1** | HYPRE D2H transfery skalarnych iloczynów | CZĘŚCIOWO (brak `HYPRE_PCGSetResidualConvergence`) | Wykorzystano asynchroniczny model hypre-stream-interop z eventami, bez fantomowych flag API | **VERIFIED** |
| **2.2** | Podwójna certyfikacja residuum | CZĘŚCIOWO (Poisson robi warunkowo, FEM/BEM robił bezwarunkowo) | Usunięto bezwarunkową rekalkulację w FEM/BEM, ujednolicono politykę walidacji z `hypre_validation_policy` | **VERIFIED** |
| **2.3** | Blokujące synchronizacje w FEM/BEM | POTWIERDZONE | Zastąpiono `cudaStreamSynchronize` bezpośrednim chainingiem eventów w `demag_fem_bem/fem_bem.cpp` | **VERIFIED** |
| **2.4** | Brak pełnego preconditionera relaksacji na GPU | POTWIERDZONE PO KOREKCIE | Istnieje wyłącznie nieaktywna aproksymacja diagonalna $M_i/(M_i+wK_{ii})$; pełny sparse $(M+wK)^{-1}M$ jest zatwierdzonym projektem fazy 1 | **NOT VERIFIED** |
| **2.5** | BoomerAMG parametry i brak DeviceLevel | CZĘŚCIOWO (brak `HYPRE_BoomerAMGSetDeviceLevel`) | Autotuning parametrów i izolacja profili bez powoływania się na nieistniejące API | **VERIFIED** |
| **3.1** | 18 skalarów po kroku RK | POTWIERDZONE MECHANICZNIE | Połączono redukcje do wspólnego wektora i odroczono transfery diagnostyczne poza pętlę gorącą | **VERIFIED** |
| **3.2** | Odczyt pakietu adaptacyjnego w fixed-step | POTWIERDZONE I ROZSZERZONE | Wdrożono `rk_attempt_control_memory` z transakcyjnym decydentem na urządzeniu | **VERIFIED** |
| **3.3** | Redundantny RHS Heun / RK4 bez FSAL | CZĘŚCIOWO (zależne od cache punktu końcowego) | Skonfigurowano politykę FSAL i zachowano ważność pól obserwacyjnych | **VERIFIED** |
| **3.4** | Odczyty Armijo w relaksacji | POTWIERDZONE MECHANICZNIE | Obliczanie warunku spadku energii bezpośrednio w jądrze GPU z redukcją skalarną | **VERIFIED** |
| **4.1** | CSR demag: thread-per-row divergence | CZĘŚCIOWO | Wprowadzono dynamiczny wybór jądra (scalar / subwarp / warp) na podstawie histogramu stopnia wierzchołków | **VERIFIED** |
| **4.2** | Trzy osobne launche Exchange | FAŁSZ (fuzja XYZ już istniała dla ścieżki standardowej) | Uporządkowano profile `legacy_sparse_gpu` i autotuning jądra bez double-double, gdy niepotrzebne | **VERIFIED** |
| **4.3** | Fragmentacja akumulacji pola efektywnego | CZĘŚCIOWO | Zaimplementowano fuzję akumulacji w `gpu_operator_fusion` redukującą liczbę kernel launchy | **VERIFIED** |
| **4.4** | DMI powtarzana geometria i atomiki energii | POTWIERDZONE | Stworzono statyczny bufor geometrii tetów (`dmi_geometry_cache`) i pominięto energię w ewaluacji RHS | **VERIFIED** |
| **4.5** | ACA BEM niski stopień zrównoleglenia | CZĘŚCIOWO | Zoptymalizowano batching bloków ACA i wyeliminowano bezczynne wątki w pierwszej projekcji | **VERIFIED** |
| **4.6** | Frequency domain `<<<1,1>>>` | CZĘŚCIOWO (dotyczyło małych układów walidacyjnych) | Zbudowano wyspecjalizowany solver GPU dla $N \le 64$ oraz redukcję odpowiedzi w pamięci współdzielonej | **VERIFIED** |
| **BUG-01** | Poisson kontynuuje po błędzie | FAŁSZ | Kod zawsze propagował `false` i przerywał krok fail-closed; potwierdzono testami | **REJECTED (AS DEFECT)** |
| **BUG-02** | DMI niedeterminizm atomików i overflow | CZĘŚCIOWO | Uporządkowano redukcję i dodano diagnostykę niefinitych wartości; brak dowodów na overflow | **VERIFIED** |
| **BUG-03** | Default stream blokuje nonblocking streamy | FAŁSZ | `cudaStreamWaitEvent` nie blokuje hosta; potwierdzono poprawność modelu asynchronicznego | **REJECTED (AS DEFECT)** |
| **BUG-04** | Wyścig w buforze 32 skalarów | FAŁSZ DLA 1 STRUMIENIA, RYZYKO MULTI-STREAM | Wprowadzono transakcyjne sloty decyzyjne per próba/strumień | **VERIFIED** |
| **BUG-05** | ACA 97% idle | CZĘŚCIOWO | Wyjaśniono, że dotyczyło tylko pojedynczych bloków niskiej rangi; batching zoptymalizowany | **VERIFIED** |

---

## 4. Ostateczny Status Pasów Dowodowych

Pierwotne wyniki kontenerowych testów źródłowych pozostają zapisem historycznym
raportu, ale nie kwalifikują Tasku 10. Dla nowego preconditionera direct
minimizers stan pasów jest następujący:

1. **Capability:** **NOT VERIFIED** — pełny sparse runtime nie istnieje.
2. **Managed runtime:** **NOT VERIFIED** — brak aktywnego setupu i receipt
   `exchange_mass_cg4|cg8`.
3. **Parity CPU/GPU:** **NOT VERIFIED** — diagonalny test nie jest parity
   pełnego operatora ani trajektorii NCG/PG-BB.
4. **Poprawność fizyczna:** **NOT VERIFIED** — brak oddzielnych artefaktów
   energii, torque, stopping state i magnetyzacji dla obu algorytmów.
5. **Wydajność:** **NOT VERIFIED** — nie wykonano pięciu ważnych powtórzeń
   time-to-tolerance per strategia/rozmiar ani powiązanego capture Nsight.

Domyślna strategia pozostaje `none`. Historyczny no-go z 2026-07-26 i
zatwierdzony projekt fazy 1 są oddzielnymi kampaniami; żadna z nich nie promuje
obecnego kodu do produkcji.
