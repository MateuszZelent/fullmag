# Raport Task 6 — autotuning sparse CSR dla GPU FEM

Data: 2026-09-03

## Wynik

Dodano urządzeniowy plan aplikacji CSR dla trzech składowych XYZ. Plan wykonuje
walidację kształtu CSR i ograniczony benchmark podczas `setup`, a następnie
wybiera i utrzymuje jeden wariant do ścieżki `apply_xyz` bez alokacji ani
kopiowania metadanych w gorącej pętli.

Zaimplementowane warianty to deterministyczny `ScalarRow`, subwarp z bucketami
2/4/8/16, warp z redukcją shuffle oraz cuSPARSE SpMV i pojedyncze cuSPARSE
SpMM dla trzech kolumn. Wszystkie warianty pracują na FP64 i są porównywane z
tym samym hostowym oraclem w kontrakcie CUDA.

Istniejące wrappery demag korzystają z kompatybilnego launchera scalar bez
zmiany ABI i bez hostowej synchronizacji. Exchange pozostaje na
kompensowanej akumulacji double-double; warianty o zmienionej kolejności
sumowania nie są promowane bez pełnego testu pola/energii i A/B.

## Implementacja

- `SparseApplyPlan` posiada trwały stan CSR, deskryptory cuSPARSE, bufory
  workspace oraz liczniki `setup`/`apply`.
- `CusparseSpmm3` pakuje SoA XYZ do trwałego bufora column-major, wykonuje jedno
  `cusparseSpMM`, a następnie rozpakowuje wynik. Deskryptory i bufory są
  tworzone wyłącznie podczas `setup`.
- Benchmark setupu ma dwa powtórzenia na kandydata i zapisuje czasy, wybrany
  identyfikator oraz wariant w `selection_provenance`.
- Błędy nieobsługiwanych wariantów i niepoprawnego CSR są fail-closed. Gdy
  inicjalizacja cuSPARSE jest niedostępna, plan jawnie ogranicza listę
  obsługiwanych wariantów do własnych kerneli CUDA.
- Legacyjne wrappery demag przekazują maskę węzłów magnetycznych do scalarowej
  ścieżki recovery; wrappery exchange zachowują istniejący oracle DD.

## TDD — RED/GREEN

Kontrakt `gpu_sparse_apply_contract` obejmuje krótkie, mieszane i długie
wiersze CSR (`1, 2, 4, 8, 16, 32`), wymusza każdy z pięciu wariantów,
porównuje trzy składowe z oraclem FP64 do RMS `1e-12`, sprawdza provenance,
identyfikator, liczniki oraz brak `cudaStreamSynchronize` w wrapperach demag i
exchange. Pierwszy przebieg zarządzany zbudował nowy runtime CUDA i zakończył
się przejściem targetu `fem_gpu_sparse_apply_contract`.

## Weryfikacja — GREEN

- `just verify-fem-demag-fem-bem-native-contract` — managed/container route;
  target `fem_gpu_sparse_apply_contract` zbudowany i przeszedł wraz z
  istniejącymi kontraktami demag/HYPRE/timing (pełny wynik końcowy należy
  odświeżyć po ponownym przebiegu receptury).
- `python scripts/test_fem_gpu_full_potential_contract.py` — PASS, 1/1.
- `git diff --check` — PASS dla zmian Task 6.

## Macierz dowodów

| Pas dowodowy | Status | Dowód / granica |
|---|---|---|
| Source/contract | VERIFIED | Wspólny API planu, pięć wariantów, trwały setup, maska demag i brak hostowego fence w wrapperach |
| Focused managed CUDA | VERIFIED | Rzeczywisty build i wykonanie `fem_gpu_sparse_apply_contract`; wszystkie warianty przechodzą FP64 oracle |
| CPU/GPU full-workload parity | NOT VERIFIED | Kontrakt obejmuje reprezentatywną macierz CSR, nie pełny ProblemIR/mesh i wszystkie obserwable |
| Snapshot v2 / runtime receipt | NOT VERIFIED | Plan publikuje ID/provenance lokalnie; integracja z każdym produkcyjnym receipt wymaga osobnej ścieżki kwalifikacyjnej |
| Nsight / synchronizacje wewnętrzne biblioteki | NOT VERIFIED | Brak source-level fence w wrapperach nie dowodzi zachowania wewnętrznego cuSPARSE/HYPRE |
| p50/p95 i pełny A/B | NOT VERIFIED | Nie wykonano pięciu zgodnych prób na produkcyjnym workloadzie |
| Walidacja fizyczna / production qualification | NOT VERIFIED | Brak świeżego artefaktu z identycznym ProblemIR, geometrią, meshem, precision i tolerancjami |

## Granica akceptacji

Można zaakceptować kontrakt wariantów CSR, trwały setup i fail-closed accuracy
policy exchange jako `source/contract VERIFIED` oraz focused managed CUDA jako
`VERIFIED`. Nie wolno wyprowadzać z tego raportu liczbowego przyspieszenia,
pełnej parity ani kwalifikacji produkcyjnej. W szczególności wrappery
kompatybilności demag pozostają scalarowe; użycie planu autotuningu przez
konkretny produkcyjny workspace i zapis do performance snapshot v2 wymaga
oddzielnego wpięcia i dowodu.
