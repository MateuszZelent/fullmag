# Raport Task 5 — FEM/BEM stream interop i warunkowa walidacja

Data: 2026-09-03

## Wynik

Task 5 usuwa cztery jawne hostowe synchronizacje z dwóch solve'ów HYPRE w
ścieżce GPU Fredkin–Koehler i zastępuje je dwukierunkowymi zależnościami CUDA
event. Zwykły, zbieżny solve używa residuum raportowanego przez HYPRE i pomija
dodatkowe `A*x-b`; niezależne residuum pozostaje wymagane po braku zbieżności
albo po jawnym wymuszeniu. Norma RHS jest liczona najwyżej raz na solve.

Nie zmieniono równań, znaków, jednostek, ABI, `Context`, `mfem_bridge.cpp` ani
polityki braku CPU fallbacku.

## Implementacja

- `HypreStreamLease` jest trwałym właścicielem pożyczonego rzeczywistego
  strumienia HYPRE oraz eventów wejścia i wyjścia. Alias zgodności zachowuje
  dotychczasowych użytkowników adaptera Poisson.
- Przed każdym `Mult` HYPRE czeka na event nagrany na strumieniu Fullmag. Po
  solve strumień Fullmag czeka na event HYPRE bez zatrzymania hosta. Lokalne
  domknięcie zależności jest uzbrajane dopiero bezpośrednio przed `Mult` i jest
  wykonywane również przy każdym błędzie po wejściu do HYPRE, w tym po
  niezależnym `A*x-b`.
- `should_validate_independent_residual(reported_converged, forced)` jest czystą
  polityką współdzieloną z istniejącym resolverem potrzeb walidacyjnych.
- `FULLMAG_FEM_FORCE_INDEPENDENT_RESIDUAL` jest kanonicznym przełącznikiem
  kwalifikacyjnym odczytywanym podczas initialize: brak/`0` oznacza false,
  `1` oznacza true, a każda inna wartość jest odrzucana fail-closed.
- Workspace FEM/BEM przechowuje licznik niezależnych walidacji; zwykły
  zbieżny przebieg managed potwierdza zero dodatkowych SpMV, a wymuszony
  przebieg wykonuje po jednym niezależnym residuum dla obu solve'ów.
- Receptura `verify-fem-demag-fem-bem-native-contract` uruchamia teraz CPU
  FEM/BEM, GPU FEM/BEM, stream/timing source contract oraz kontrakt polityki
  residuum.
- Test źródłowy normalizuje CRLF przed dopasowaniem wielowierszowych kontraktów.
  Bez tej korekty niezmieniony kod publikacji timingów był fałszywie odrzucany
  tylko w Windowsowym checkoutcie.

## TDD — RED

Pierwszy zarządzany przebieg po dodaniu testów nie kompilował kontraktu GPU:
brakowało `GpuDemagFemBemWorkspace::stream_lease` i
`GpuFemBemLinearSystem::independent_residual_validation_count`.

Po pierwszej implementacji trzy z czterech targetów przeszły, a
`fem_cuda_demag_timing_contract` odrzucił brak bezpośredniego użycia
`should_validate_independent_residual`. Po naprawie ujawnił odziedziczoną
wrażliwość wielowierszowego dopasowania na CRLF; plik produkcyjny nie miał diffu
względem bazowego `bfdc2bfbb182d356ffaf82f94be978419263b10d`, a wymagany sumator
czterech faz był obecny. Minimalna normalizacja wejścia testu usunęła fałszywy
negatyw.

Formalny review pierwszego commitu wykrył trzy braki i wymusił drugi cykl RED:

- zarządzany kontrakt nie kompilował się, ponieważ nie istniał jeszcze
  `read_force_independent_residual_validation`;
- pierwsza próba remediacji ujawniła zbyt kruche źródłowe dopasowanie kolejności
  po wprowadzeniu lokalnego closure oraz `SIGSEGV` testu, który jako pierwszy
  próbował wykonać solve na ponownie utworzonym workspace;
- diagnostyczny przebieg przeniósł forced solve na pierwotny workspace i użył
  deterministycznego odrzucenia `max_iterations=0` wyłącznie w warstwie
  walidacji. Zakończył się 4/4 PASS, co oddzieliło ścieżkę forced/error od
  istniejącego kontraktu reinitializacji. Finalny test zachowuje zwykły solve,
  wykonuje forced solve na tym samym poprawnym workspace i sprawdza odczyt
  env=1 podczas reinitializacji bez wykonywania kolejnego solve.

## Weryfikacja — GREEN

- `just verify-fem-demag-fem-bem-native-contract` — PASS, exit 0, 4/4:
  `fem_cuda_demag_timing_contract`,
  `fem_hypre_validation_policy_contract`,
  `fem_demag_fem_bem_contract` i
  `fem_demag_fem_bem_gpu_contract`; CUDA 12.4.131, 0 failed, 1.91 s.
- `python scripts/test_fem_gpu_full_potential_contract.py` — PASS, 1/1.
- Validator strony i source map
  `docs/physics/fem_demag_fem_bem.source-map.json` — PASS.
- Testy validatora scientific documentation — PASS, 29/29.

## Macierz dowodów

| Pas dowodowy | Status | Dowód / granica |
|---|---|---|
| Source/contract | VERIFIED | Brak `cudaStreamSynchronize` i `record_mfem_host_sync` w FEM/BEM; jawna kolejność eventów; test polityki |
| Focused managed GPU | VERIFIED | Rzeczywisty initialize→apply na CUDA/HYPRE, 4 event waits, zero przyrostu host sync, receipt `DeviceResident`, literalne `compute_fence_count == 0`, zero niezależnych SpMV po zwykłej zbieżności |
| Wymuszona walidacja na pełnym GPU solve | VERIFIED | Managed GPU wykonuje dwa niezależne residua, 6 zależności event; strict env 0/1 jest przetestowany i env=1 trafia do workspace podczas initialize |
| Błąd po niezależnym `A*x-b` | VERIFIED | Deterministyczne odrzucenie walidacji po u1 dodaje dokładnie 3 zależności: input, validation i outbound closure; brak dodatkowego eventu przed `Mult` |
| CPU/GPU field-energy-residual parity | NOT VERIFIED | Focused kontrakty CPU i GPU przechodzą osobno, ale nie tworzą źródłowo zgodnego porównania pól, energii i residuum |
| Nsight | NOT VERIFIED | Nie wykonano source-pinned trace; brak profilu nie pozwala twierdzić, że HYPRE wewnętrznie nie ma innych synchronizacji |
| Wydajność p50/p95 | NOT VERIFIED | Nie wykonano pięciu zgodnych prób ani pełnego workloadu A/B |
| Walidacja fizyczna / production qualification | NOT VERIFIED | Brak świeżego artefaktu z identycznym ProblemIR, mesh, precision i tolerancjami |

## Granica akceptacji

Można zaakceptować implementację event interop i warunkowej walidacji jako
`source/contract VERIFIED` oraz focused managed GPU contract jako `VERIFIED`.
Nie wolno z tego wywodzić liczbowego przyspieszenia, pełnej parity ani statusu
produkcyjnego. Te lane'y pozostają `NOT VERIFIED` do osobnych receiptu,
benchmarku, profilu Nsight i walidacji fizycznej.
