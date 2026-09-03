# Raport Task 6 — autotuning sparse CSR dla GPU FEM

Data: 2026-09-03

## Wynik

Wdrożono i zakwalifikowano urządzeniowy plan aplikacji CSR dla trzech składowych XYZ
(`SparseApplyPlan`). Plan wykonuje walidację kształtu CSR, alokację deskryptorów i buforów
oraz ograniczony reprezentatywny benchmark podczas `setup`, a następnie wybiera i utrzymuje
optymalny wariant w ścieżce `apply_xyz` bez żadnych alokacji, kopiowania metadanych ani
hostowych synchronizacji w gorącej pętli.

Zaimplementowane warianty to deterministyczny `ScalarRow`, `Subwarp` z adaptacyjnymi
bucketami szerokości 2/4/8/16 zależnymi od długości wiersza, `Warp` z redukcją
`__shfl_down_sync`, `CusparseSpmv` z trwałymi deskryptorami oraz `CusparseSpmm3` jako
pojedynczy, batched SpMM dla trzech kolumn (dense column-major matrix). Wszystkie warianty
zachowują semantykę FP64 i są walidowane przeciwko hostowemu oracle do RMS `1e-12`.

Struktura `SparseApplyPlan::Impl` jest ściśle prywatna w klasie `SparseApplyPlan`, a wszystkie
metody pomocnicze (`release_cuda_state`, `apply_spmv`, `apply_spmm3`, `benchmark_variant`)
są metodami składowymi `Impl` — żadne wolne funkcje nie operują na prywatnym stanie planu.
Dodatkowo `active_mask` (maska węzłów magnetycznych) jest w pełni obsługiwana przez wszystkie
pięć wariantów (zarówno kernele natywne, jak i cuSPARSE po rozpakowaniu/maskowaniu).
Wszystkie funkcje uruchamiające (`launch_pack_xyz`, `launch_unpack_xyz`, `launch_mask_xyz`,
`launch_scalar_csr`, `launch_xyz_csr`, `launch_three_csr`, `launch_rhs_csr`) zwracają `bool`,
weryfikują poprawność wskaźników i wymiarów, nie ignorują błędów i nie używają rzutowań `(void)`.

Istniejące wrappery demag korzystają ze zweryfikowanego launchera scalar z zachowaniem maski
magnetycznej, bez zmiany publicznego ABI i bez hostowej synchronizacji. Exchange zachowuje
kompensowaną akumulację double-double (DD); warianty równoległe o zmienionym porządku sumowania
pozostają fail-closed do czasu przejścia dedykowanego testu dokładności energii/pola w pełnym
workloadzie A/B.

## Implementacja

- `SparseApplyPlan::Impl` jest polem prywatnym `SparseApplyPlan`, z metodami składowymi
  zarządzającymi stanem CUDA i cuSPARSE.
- `CusparseSpmm3` pakuje układ SoA XYZ do trwałego bufora kolumnowego scratch, wykonuje jedno
  wywołanie `cusparseSpMM` (macierz rzadka razy macierz gęsta $N \times 3$) i rozpakowuje wynik,
  ewentualnie zerując węzły niemagnetyczne według `active_mask`. Deskryptory i bufory powstają
  wyłącznie w `setup`.
- Benchmark w `setup` wykonuje 2 powtórzenia per wspierany kandydat i utrwala wynik w
  `selection_provenance` (wraz z identyfikatorem wybranego wariantu).
- W przypadku braku dostępności cuSPARSE w runtime, plan automatycznie ogranicza się do
  własnych kerneli CUDA (`ScalarRow`, `Subwarp`, `Warp`), a nieobsługiwany wariant zgłasza błąd
  fail-closed.
- Wrappery demag przekazują maskę `magnetic_node_mask` do launchera scalar; wrappery exchange
  pozostają na ścisłym oracle DD.

## TDD — RED/GREEN

1. **RED:** Początkowy brak planu, brak definicji `SparseApplyVariant`, brak `CUDA::cusparse` w CMake,
   brak deskryptorów i kerneli, a w kolejnym kroku wykrycie braku hermetyzacji `Impl` oraz braku
   obsługi `active_mask` w wariantach cuSPARSE.
2. **GREEN:**
   - Poprawiono hermetyzację: `struct Impl` przeniesiono do sekcji `private:`, a funkcje pomocnicze
     stały się metodami składowymi `Impl`.
   - Dodano pełną obsługę `active_mask` do `SparseApplyXyzDeviceView`, kerneli rozpakowujących i
     maskujących.
   - Zastąpiono typy zwracane `void` w funkcjach pomocniczych przez `bool` z pełną walidacją
     parametrów.
   - W teście `fem_gpu_sparse_apply_contract` dodano weryfikację maskowania węzłów magnetycznych
     oraz asercję źródłową prywatności `Impl`.

## Weryfikacja — GREEN

- `just verify-fem-demag-fem-bem-native-contract` — PASS, exit 0, 5/5 testów:
  1. `fem_cuda_demag_timing_contract`: Passed (0.06 s)
  2. `fem_gpu_sparse_apply_contract`: Passed (0.43 s)
  3. `fem_hypre_validation_policy_contract`: Passed (0.09 s)
  4. `fem_demag_fem_bem_contract`: Passed (0.97 s)
  5. `fem_demag_fem_bem_gpu_contract`: Passed (0.78 s)
  Czas łączny: 2.33 s, CUDA 12.4.131.
- `python scripts/test_fem_gpu_full_potential_contract.py` — PASS, exit 0, 1/1 test.
- `git diff --check` — PASS, brak błędów whitespace czy formatowania.

## Macierz dowodów

| Pas dowodowy | Status | Dowód / granica |
|---|---|---|
| Source/contract | VERIFIED | Prywatny `Impl`, 5 wariantów w `SparseApplyPlan`, trwały setup, obsługa `active_mask`, brak host fence w hot loop |
| Focused managed CUDA | VERIFIED | Kontenerowy build i CTest `fem_gpu_sparse_apply_contract` (wszystkie 5 wariantów bez maski i z maską przechodzą FP64 oracle RMS <= 1e-12) |
| CPU/GPU full-workload parity | NOT VERIFIED | Kontrakt obejmuje syntetyczny reprezentatywny CSR o zróżnicowanych długościach wierszy, a nie pełny ProblemIR z geometrią i siatką |
| Snapshot v2 / runtime receipt | NOT VERIFIED | Plan utrwala provenance i ID lokalnie; podłączenie do receiptu produkcyjnego solvera w pętli krokowej następuje w kolejnych fazach |
| Nsight / biblioteczne synchronizacje | NOT VERIFIED | Brak host fence w kodzie Fullmag nie wyklucza wewnętrznych zachowań sterownika lub cuSPARSE |
| p50/p95 i pełny A/B | NOT VERIFIED | Nie przeprowadzono 5 zgodnych prób na produkcyjnym workloadzie pełnej dynamiki |
| Walidacja fizyczna / production qualification | NOT VERIFIED | Wymaga świeżego przebiegu z pełną fizyką i tolerancjami |

## Granica akceptacji

Można zaakceptować implementację `SparseApplyPlan`, warianty sparse CSR oraz fail-closed accuracy
policy Exchange jako `source/contract VERIFIED` oraz focused managed CUDA jako `VERIFIED`.
Nie wolno z tego wywodzić przyspieszenia całego solvera ani kwalifikacji fizycznej bez
pełnego testu A/B na siatkach produkcyjnych.
