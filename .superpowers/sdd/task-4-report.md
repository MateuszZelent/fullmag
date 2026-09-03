# Raport Task 4 — DMI field-only i bezpieczna redukcja energii

Status: `DONE_WITH_CONCERNS`

Formalne findingi review dotyczące wykonywalnej mikrofikstury, jawnej pamięci
diagnostycznej i przepełnienia licznika partiali naprawia osobny commit oraz
`task-4-remediation-report.md`.

## Zakres wykonany

- Dodano wewnętrzne typy `DmiApplyRequest { field, energy }` oraz
  `DmiDiagnostics { degenerate_tet_count, nonfinite_count }`.
- Etapy RK DMI żądają teraz wyłącznie pola i przekazują `nullptr` dla energii.
- Kernel omija arytmetykę i redukcję energii dla `field-only`.
- Energia jest zapisywana jako jeden partial na blok do istniejącego, trwałego
  `scalar_workspace`; zwykła ścieżka używa `fullmag_cuda_device_sum` (CUB).
- Tryb `FULLMAG_FEM_DMI_QUALIFICATION_REDUCTION=pairwise` używa stałego drzewa
  pairwise i odrzuca nieznane wartości zmiennej zamiast przechodzić na CUB.
- Degeneraty i wyniki niefinityczne są zliczane na urządzeniu. Każdy niezerowy
  licznik zatruwa wynik pola/energii `NaN`, aby dalsza polityka numeryczna
  zakończyła obliczenie fail-closed.
- Dodano minimalny target CMake, kanoniczny Windows FEM contract `dmi-gpu`,
  recipe `verify-fem-dmi-gpu-contract` i testy wiringowe.
- `rk_dmi_energy_reductions.cu` został objęty zakresem za zgodą koordynatora,
  ponieważ bez zmiany liczby redukowanych partiali usunięcie atomika energii
  dawałoby błędny wynik.

## TDD i VERIFIED

- RED: `just verify-fem-dmi-gpu-contract` — pełny kontenerowy CUDA build
  przeszedł, CTest zakończył się `FAIL: GPU DMI must expose a typed field/energy
  apply request`.
- GREEN (finalny przebieg): ten sam managed recipe — CUDA compile/link
  `fullmag_fem` przeszedł, `fem_dmi_gpu_contract` 1/1 PASS.
- `python -m unittest scripts.test_fem_gpu_benchmark_contract` — 13/13 PASS.
- Focused funkcje `scripts.test_windows_fullmag_launcher_contract` dla FEM,
  receipt i DMI wiring — PASS.
- `git diff --check` — PASS (wyłącznie ostrzeżenia o przyszłej konwersji LF/CRLF).

## NOT VERIFIED

- CTest wykonuje mikrofiksturę CUDA FP64 dla TET4, ale nie stanowi pełnej
  CPU/GPU parity na produkcyjnej siatce.
- Nie uruchomiono DMI CPU/GPU parity ani niezależnego oracle energii.
- Nie uruchomiono A/B RHS p50/p95; brak podstaw do twierdzenia o poprawie lub
  braku regresji wydajności.
- W mikrofiksturze wykonano runtime odczyt liczników oraz sprawdzono NaN
  fail-closed dla degeneratu i wejścia niefinitycznego.

## Dokumentacja fizyki

Sprawdzono istniejące noty DMI. Zmiana nie modyfikuje równań, znaków, jednostek,
Python DSL, ProblemIR ani publicznej semantyki; dlatego nie zmieniono
`docs/physics/`. Nie podniesiono statusu walidacji fizycznej ani produkcyjnej.

## Higiena

Nie zmieniono ani nie stage'owano cudzej `.superpowers/sdd/progress.md`.
