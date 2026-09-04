# Plan wdrożenia fazy 1: FEM GPU direct minimizers i preconditioning

- Data: 2026-09-04
- Gałąź: `codex/fem-gpu-tasks1-5-remediation`
- Worktree: `C:\\git\\fullmag\\fullmag\\.worktrees\\fem-gpu-tasks1-5-remediation`
- Projekt: `docs/superpowers/specs/2026-09-04-fem-gpu-direct-minimizers-phase1-design.md`
- Zakres: FEM GPU `nonlinear_cg` i `projected_gradient_bb`, `double`
- Stan początkowy: implementacja rozwojowa; dowód produkcyjny `NOT VERIFIED`

## 1. Cel i definicja ukończenia

Celem jest zastąpienie błędnie nazwanej aproksymacji diagonalnej prawdziwym,
device-resident preconditionerem
$P_\lambda^{-1}\operatorname{diag}(M_sM_{\mathrm{lumped}})$, połączenie go z
NCG i PG-BB bez zmiany semantyki surowego gradientu oraz dodanie dowodu
wykonania, który failuje przy każdym nieudowodnionym lub niespójnym stanie.

Kod źródłowy jest ukończony dopiero po spełnieniu wszystkich poniższych
warunków:

1. test z pozadiagonalną macierzą SPD odróżnia `diagonal` od pełnego sparse
   `exchange_mass_cg4|cg8`;
2. apply CG nie wykonuje alokacji, H2D, D2H ani hostowego kryterium zbieżności w
   hot loopie;
3. NCG i PG-BB przechowują osobno surowy gradient $g$ i preconditioned gradient
   $z$;
4. każdy błąd konfiguracji, sparse apply, CUDA i breakdown CG jest fail-closed;
5. receipt v2, snapshot v3 i opublikowany artefakt mają tę samą generation i
   rzeczywisty algorithm/preconditioner identity;
6. wszystkie dostępne bramki kontenerowe `just` przechodzą.

Status `performance_qualified` lub `production_default` wymaga dodatkowo pełnej
kampanii parity, pięciu powtórzeń na rozmiar i strategię oraz osobnego capture
Nsight. Jeżeli środowisko nie pozwoli uzyskać któregokolwiek dowodu, kod
pozostaje `development_executable`, a brakujący pas jest oznaczony
`NOT VERIFIED`.

## 2. Reguły obowiązujące wszystkie zadania

- Stosować TDD: najpierw uruchomić i zachować obserwowalny RED, dopiero potem
  zmieniać kod produkcyjny.
- Budować i uruchamiać natywny FEM/MFEM/CUDA/HYPRE wyłącznie przez
  repozytoryjne, kontenerowe receptury `just`.
- Nie dodawać publicznego parametru Python ani pola `ProblemIR`; strategia jest
  wewnętrznym resolved runtime optimization.
- Nie wprowadzać HYPRE PCG/BoomerAMG, TPI, L-BFGS, FP32 ani mixed precision w
  tej fazie.
- Nie kopiować pełnego CSR exchange. Rozwiązanie ma pożyczać kanoniczny
  operator i używać `SparseApplyPlan::apply_xyz`.
- Przed kodowaniem potwierdzić jednostki oraz skalowanie CSR w
  `exchange_upload.cpp`, `exchange_kernels.cu` i CPU oracle; zabronione jest
  podwójne zastosowanie $2/\mu_0$ lub współczynników materiałowych.
- Współdzielenie planu sparse jest dozwolone tylko przy jednoznacznym,
  sekwencyjnym ownership na tym samym strumieniu. W przeciwnym razie utworzyć
  osobny descriptor/planner bez duplikacji CSR.
- Nie zmieniać domyślnej strategii `none` bez literalnego przejścia gate
  wydajności z noty 0581.
- Po każdym zadaniu wykonać przegląd zgodności z projektem i jakości kodu.
- Każdy commit musi zawierać wyłącznie pliki danego zadania; przed commitem
  osobno sprawdzić `git diff --cached --name-only` i `git diff --cached --check`.

## 3. Baseline

Przed pierwszą zmianą uruchomić:

```text
just verify-fem-demag-fem-bem-native-contract
```

Zapisać dokładny wynik w raporcie wdrożenia. Jeżeli baseline nie przechodzi,
oddzielić istniejące niepowodzenie od regresji wprowadzanej przez tę fazę.

## 4. Zadanie 1 — publikacja naukowa i korekta statusu

### Pliki

- modyfikacja: `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md`
- utworzenie:
  `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.source-map.json`
- modyfikacja: `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`
- modyfikacja: `docs/physics/0560-all-in-gpu-fem-runtime.md`
- modyfikacja: `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- modyfikacja:
  `docs/physics/0900-native-fem-operator-contracts-and-validation.source-map.json`
- modyfikacja: `docs/audits/2026-09-02-fem-gpu-solver-completion.md`
- modyfikacja: właściwe pliki indeksu/statusu w
  `docs/performance/fem-gpu-performance-remediation-2026-09-01/`
- testy: `scripts/test_check_relaxation_contract_docs.py` oraz, jeśli wymagane,
  nowy mały test source-map/statusu

### RED

1. Dodać asercje, że dokumentacja:
   - nazywa obecną realizację diagonalną, a nie pełnym
     $(M+wK)^{-1}M$;
   - oznacza historyczny Task 10 jako `NOT VERIFIED`;
   - rozdziela historyczny eksperyment no-go od nowej, jeszcze
     niezakwalifikowanej implementacji;
   - nie promuje capability ani strategii domyślnej.
2. Uruchomić test i zachować oczekiwany RED wynikający z obecnych fałszywych
   twierdzeń.

### GREEN

1. Uzupełnić wszystkie obowiązkowe sekcje terminalnej strony, równania,
   jednostki SI, tabele parametrów, cztery lane'y backendów, failure semantics,
   implementację i walidację.
2. Dodać adjacent source map z mapowaniem `path + symbol`; status runtime,
   parity i performance pozostawić `NOT VERIFIED`.
3. Skorygować raport audytowy i pakiet performance bez przepisywania historii.

### Weryfikacja

```text
python scripts/test_check_relaxation_contract_docs.py
python scripts/check_public_doc_examples.py --root public_docs/site
python scripts/check_scientific_documentation.py
```

Jeżeli nazwa ostatniego walidatora różni się w repozytorium, znaleźć
kanoniczny cel przez `rg` i zapisać użyte polecenie w raporcie zadania.

### Commit

`docs(fem): correct GPU minimizer preconditioning status`

## 5. Zadanie 2 — prawdziwa strategia diagonalna i manufactured RED

### Pliki

- modyfikacja:
  `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp`
- modyfikacja:
  `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp`
- modyfikacja:
  `backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp`
- ewentualna modyfikacja: `backends/fem/CMakeLists.txt`

### RED

1. Zastąpić diagonalny `ManufacturedSpdMatrix` małą pełną macierzą SPD z
   wpisami pozadiagonalnymi i niezależnym dense oracle.
2. Dodać przypadki heterogenicznej masy/$M_s$/exchange, $\lambda=0$, zerowego
   RHS, inactive/fixed nodes oraz niepoprawnych danych.
3. Uruchomić kontenerowy kontrakt i potwierdzić, że obecny kod nie spełnia
   wyniku pełnego sparse solve.

### GREEN

1. Nazwać istniejącą klasę zgodnie z matematyką, np.
   `GpuDiagonalRelaxationPreconditioner`.
2. Zachować tylko punktową realizację `diagonal` i jej osobne oczekiwania.
3. Resolver ma odrzucać `exchange_mass_cg4|cg8`, dopóki Zadanie 3 nie dostarczy
   pełnego runtime.

### Weryfikacja

```text
just verify-fem-demag-fem-bem-native-contract
```

Test docelowy: `fem_gpu_relaxation_preconditioner_contract`.

### Commit

`fix(fem-gpu): separate diagonal preconditioner semantics`

## 6. Zadanie 3 — pełny device-resident sparse fixed-CG4/CG8

### Pliki

- utworzenie:
  `backends/fem/gpu/cuda/relaxation/gpu_exchange_mass_preconditioner.hpp`
- utworzenie:
  `backends/fem/gpu/cuda/relaxation/gpu_exchange_mass_preconditioner.cpp`
- utworzenie:
  `backends/fem/gpu/cuda/relaxation/gpu_exchange_mass_preconditioner_kernels.hpp`
- utworzenie:
  `backends/fem/gpu/cuda/relaxation/gpu_exchange_mass_preconditioner_kernels.cu`
- modyfikacja:
  `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp`
- modyfikacja: `backends/fem/CMakeLists.txt`
- modyfikacja:
  `backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp`
- ewentualnie nowy, wąski kontrakt CTest dla failure latch/cache

### RED

Dodać testy, których nie spełnia implementacja diagonalna:

- wynik CG4/CG8 względem dense oracle dla pełnego SPD;
- różny, deterministyczny wynik CG4 i CG8 przy niedomkniętym Kryłowie;
- wszystkie trzy składowe przez `apply_xyz`;
- brak modyfikacji RHS i dokładne zero dla zera/maski/fixed spins;
- ponowne użycie setupu, invalidacja po zmianie identity i brak duplikacji CSR;
- breakdown/niefinity/niepoprawna masa ustawiają monotoniczny failure latch;
- hot apply nie ma ścieżki host/CPU i nie alokuje pamięci.

### GREEN

1. Zaimplementować stałe CG4/CG8 dla
   $P_\lambda z=\operatorname{diag}(M_sM_{\mathrm{lumped}})g$.
2. Użyć istniejącego pełnego CSR i `SparseApplyPlan::apply_xyz`.
3. Przechowywać wektory Kryłowa i skalary na urządzeniu; stała liczba iteracji
   oznacza brak per-iteration D2H i synchronizacji hosta.
4. Dodać licznik setup/apply, residuum końcowe, sparse variant i failure latch,
   bez alokowania próbek, gdy profiler jest wyłączony.
5. Nie stosować fallbacku do diagonali.

### Weryfikacja

```text
just verify-fem-demag-fem-bem-native-contract
just verify-fem-exchange-runtime
```

### Commit

`feat(fem-gpu): add sparse exchange-mass fixed CG`

## 7. Zadanie 4 — resolver, lifecycle i integracja PG-BB

### Pliki

- modyfikacja: `backends/fem/gpu/cuda/relaxation/relaxation_state.hpp`
- modyfikacja: `backends/fem/gpu/cuda/relaxation/relaxation_memory.cpp`
- modyfikacja: `backends/fem/gpu/cuda/relaxation/pgbb.cpp`
- modyfikacja: setup/dispatch FEM GPU wskazany przez aktualne call-site'y
- modyfikacja testów relaksacji i runtime resolvera

### RED

- wymusić kolejno `none`, `diagonal`, `exchange_mass_cg4` i
  `exchange_mass_cg8` dla PG-BB;
- wykazać, że obecny runtime nie wykonuje `setup()` i nadpisuje/scala $g$ z
  $z$;
- wymusić błąd apply i potwierdzić, że aktualny kod go ignoruje;
- sprawdzić invalidację setupu dla zmiany mesha/operatora/materiału/maski.

### GREEN

1. Rozwiązać jawny wewnętrzny profil przed pierwszym krokiem; nie odczytywać
   zmiennych środowiskowych w hot loopie.
2. Dodać osobny bufor $z$ oraz persistent workspace do stanu/alokacji.
3. PG-BB używa $d=-z$, ale stop, energia, Armijo i descent pozostają oparte na
   surowym $g$.
4. Propagować każdy błąd i rollbackować próbę bez publikacji częściowego stanu.

### Weryfikacja

```text
just verify-fem-relaxation-source-contract
just verify-fem-relaxation-runtime
```

### Commit

`feat(fem-gpu): integrate preconditioning into PG-BB`

## 8. Zadanie 5 — preconditioned PR+ w NCG

### Pliki

- modyfikacja: `backends/fem/gpu/cuda/relaxation/relaxation_state.hpp`
- modyfikacja: `backends/fem/gpu/cuda/relaxation/relaxation_memory.cpp`
- modyfikacja: `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp`
- modyfikacja właściwych kernelów/redukcji NCG
- modyfikacja/dodanie kontraktów NCG

### RED

- porównać jedną i kilka aktualizacji PR+ z CPU oracle;
- wykazać osobne current/previous $g$ i $z$;
- sprawdzić transport na przestrzeń styczną, mianownik
  $g_{old}\cdot z_{old}$, restart od $-z$ i raw-gradient recovery;
- wymusić błąd preconditionera przed i w trakcie próby Armijo oraz sprawdzić
  rollback i terminal error.

### GREEN

Odwzorować CPU `next_direction_pr_plus` bez hostowej rekurencji i bez zmiany
dotychczasowych kryteriów stopu, energii, accepted/rejected lifecycle oraz
recovery. NCG nie może używać preconditioned norm jako nowego kryterium
fizycznego.

### Weryfikacja

```text
just verify-fem-relaxation-source-contract
just verify-fem-relaxation-runtime
just verify-fem-relaxation-cpu-gpu-consistency-smoke
```

### Commit

`feat(fem-gpu): add preconditioned PR-plus NCG`

## 9. Zadanie 6 — receipt v2, snapshot v3 i terminalna publikacja

### Pliki

- modyfikacja: `native/include/fullmag_fem.h`
- modyfikacja: natywny stan/API receipt i snapshot wskazany przez istniejące
  symbole v1/v2
- modyfikacja: Rust FFI `sys`, typy runtime, dispatch/finalize/artifacts
- modyfikacja: walidatory receipt/snapshot/publication
- modyfikacja/dodanie testów ABI i runnera
- modyfikacja ADR 0030 i projektu evidence tylko dla doprecyzowań ujawnionych
  przez implementację

### RED

Najpierw dodać testy dla:

- addytywnego ABI i odrzucania nieznanej wersji/rozmiaru/enuma/bitu;
- `execution_kind=direct_minimizer` oraz dokładnego NCG/PG-BB identity;
- required/resolved/executed operator mask i osobnej identity preconditionera;
- lifecycle candidate/accepted/rejected/failed, także zero accepted steps;
- zachowania dowodu po reject/failure;
- monotonicznych host/unknown/fallback/transfer/sync violation latches;
- jednej `execution_generation_id` i hashy między receipt, snapshotem i finalnym
  artefaktem;
- pobierania finalnego snapshotu po terminalnym drainie artefaktów, nie przed
  nim;
- strict GPU bez CPU fallbacku.

### GREEN

1. Dodać receipt v2 i snapshot v3 addytywnie, zachowując stare symbole ABI.
2. Uzbroić receipt także dla direct minimizers, a nie tylko RK/LLG.
3. Rozdzielić `executed`, `attempted` i terminal outcome, aby zero accepted nie
   było raportowane jako `none` po realnej próbie.
4. Finalizować/bindować dowód dopiero po zakończeniu wykonania i drenażu
   artefaktów.
5. Najpierw zamknąć NCG; następnie w tym samym schemacie dodać niezależną
   tożsamość PG-BB.

### Weryfikacja

```text
just verify-fem-relaxation-policy-provenance-contract
just verify-fem-relaxation-source-contract
just verify-fem-relaxation-runtime
```

### Commit

`feat(fem): publish direct-minimizer execution evidence`

## 10. Zadanie 7 — benchmark, walidator i Nsight

### Pliki

- modyfikacja: `scripts/analysis/fem_gpu_benchmark.py`
- modyfikacja: `scripts/test_fem_gpu_benchmark_contract.py`
- modyfikacja: `scripts/analysis/capture_fem_gpu_nsight.py`
- modyfikacja: `scripts/test_capture_fem_gpu_nsight.py`
- modyfikacja: odpowiednie walidatory artefaktów/receipt
- modyfikacja: kontenerowe receptury `justfile`, tylko jeśli brakuje
  kanonicznego celu dla nowego kontraktu

### RED

- benchmark odrzuca mniej lub więcej niż dokładnie pięć ważnych indeksów;
- odrzuca duplikat/brak indeksu, zmianę source/workload/mesh/GPU/runtime oraz
  receipt bez związania z finalnym artefaktem;
- NCG i PG-BB nie mogą wzajemnie kwalifikować swoich wyników;
- `none`, `diagonal`, `exchange_mass_cg4`, `exchange_mass_cg8` są rozdzielone;
- Nsight dopuszcza wyłącznie osobny repeat-1 capture tej samej identity i nie
  może zastąpić pięciu powtórzeń.

### GREEN

Osiągalne strategie benchmarku muszą odpowiadać realnemu runtime. Raport ma
utrwalać setup/apply/fixed iterations/residual/sparse variant, accepted steps,
Armijo, demag solves, transfery, synchronizacje i alokacje. Każdy brak dowodu
jest błędem kwalifikacji, a nie wartością domyślną.

### Weryfikacja

```text
python scripts/test_fem_gpu_benchmark_contract.py
python scripts/test_capture_fem_gpu_nsight.py
just verify-fem-gpu-performance-regression
```

### Commit

`test(fem-gpu): qualify direct-minimizer preconditioners`

## 11. Zadanie 8 — końcowa kwalifikacja i zgodność dokumentacji

### Pliki

- modyfikacja: `docs/specs/capability-matrix-v0.md`
- modyfikacja: `docs/specs/capability-matrix-v0.json`
- modyfikacja: `docs/architecture/backend-golden-masterplan.md`
- modyfikacja: `docs/specs/native-fem-backend-architecture-v1.md`
- modyfikacja: dokumenty fizyczne i performance z Zadania 1 wyłącznie zgodnie
  z faktycznie uzyskanym evidence
- utworzenie: raport implementacji/kwalifikacji w pakiecie performance

### Weryfikacja źródłowa i runtime

```text
just verify-fem-demag-fem-bem-native-contract
just verify-fem-exchange-runtime
just verify-fem-relaxation-source-contract
just verify-fem-relaxation-policy-provenance-contract
just verify-fem-relaxation-runtime
just verify-fem-relaxation-cpu-gpu-consistency-smoke
just verify-fem-relaxation-equilibrium-parity
just verify-fem-gpu-performance-regression
```

### Kampania kwalifikacyjna

Dla NCG i PG-BB osobno wykonać warm-up i dokładnie pięć pomiarów dla coarse,
medium i fine oraz czterech strategii. Następnie wykonać jeden capture Nsight
dla tej samej identity. Wyniki ocenić literalnie:

- co najmniej 10% poprawy p50 time-to-tolerance na co najmniej dwóch z trzech
  rozmiarów;
- brak pogorszenia p50 lub p95 większego niż 5% na dowolnym rozmiarze;
- komplet physics/parity/residency/synchronization/fail-closed.

Jeżeli kampania jest niedostępna lub gate nie przechodzi, nie zmieniać defaultu
`none` ani statusu capability. Raport musi jawnie oddzielić:

1. source/contract evidence;
2. managed runtime evidence;
3. physics i CPU/GPU parity;
4. performance i Nsight;
5. release qualification.

### Commit

`docs(fem): record direct-minimizer qualification evidence`

## 12. Końcowy przegląd gałęzi

Po wszystkich zadaniach:

1. wykonać przegląd całego diffu od commita bazowego do `HEAD`;
2. usunąć jedynie regresje lub osierocone elementy utworzone przez tę fazę;
3. ponowić pełny zestaw dostępnych bramek z Zadania 8;
4. sprawdzić `git status --short`, historię commitów i brak plików spoza
   zakresu;
5. podać użytkownikowi dokładny stan: wdrożone, zweryfikowane, niezweryfikowane,
   zablokowane oraz realny procent kryteriów akceptacji.

Nie wolno uznać implementacji za produkcyjnie szybszą bez wyników kampanii
time-to-tolerance. Zielone testy kontraktowe dowodzą poprawności kontraktu, nie
przyspieszenia.
