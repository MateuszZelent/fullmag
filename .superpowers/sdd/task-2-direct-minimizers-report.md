# Raport Task 2 — prawdziwa semantyka preconditionera diagonalnego

## Tożsamość

- Worktree: `C:\git\fullmag\fullmag\.worktrees\fem-gpu-tasks1-5-remediation`
- Branch: `codex/fem-gpu-tasks1-5-remediation`
- Baza Tasku 2: `20cf54a1bbba4ff91bb9150342bbe8e95444cb02`
- Commit przed poprawkami review: `c4e977b19174c02895a7598f73136191530acb57`
- `HEAD` wynikowy: amend powyższego commitu; dokładny hash jest podany w
  handoffie, ponieważ commit nie może zawierać własnego hasha.
- Lane: FEM GPU/CUDA, `double`.

## Wynik

Task 2 nazywa istniejący algorytm zgodnie z jego rzeczywistą semantyką:
`GpuDiagonalRelaxationPreconditioner` wykonuje wyłącznie punktową
aproksymację diagonalną

```text
M_i / (M_i + weight * K_ii).
```

Nie udaje pełnego rozwiązania sparse `(M + weight*K)^-1 M`.
`exchange_mass`, `exchange_mass_cg4` i `exchange_mass_cg8` pozostają jawnie
`NOT IMPLEMENTED` i są odrzucane fail-closed. Produkcyjne podłączenie do
NCG/PG-BB, ABI, receipts, physics parity i performance pozostają poza Taskiem 2.

Po review dodatkowo:

- oddzielono logiczny rozmiar konfiguracji `configured_size_` od pojemności
  alokacji `d_capacity_`;
- oba device apply wymagają dokładnie aktualnego rozmiaru logicznego, ale
  pozwalają ponownie wykorzystać większą alokację;
- oba device apply sprawdzają `cudaPeekAtLastError()` bezpośrednio po launchu,
  zwracają nazwany błąd i nie inkrementują licznika po odrzuconym launchu;
- przywrócono pozytywną ścieżkę jednoskładnikowego `apply_device`;
- naprawiono bieżące symbole i opis pełnego SPD negative control w notach oraz
  source-mapach 0510/0560/0900, pakiecie performance, teście dokumentacji i
  indeksie projektu.

## Zakres plików

- `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp`
  - enum zawiera tylko `None` i `Diagonal`;
  - klasa nosi nazwę `GpuDiagonalRelaxationPreconditioner`;
  - osobne pola przechowują bieżący rozmiar konfiguracji i capacity.
- `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp`
  - resolver odrzuca całą rodzinę `exchange_mass*` jako niezaimplementowaną;
  - zachowano dokładny faktor diagonalny i jego walidację;
  - re-setup większy→mniejszy ponownie wykorzystuje bufor bez zmiany
    logicznego kontraktu rozmiaru;
  - launch scalar/component jest sprawdzany zgodnie z projektem przez
    `cudaPeekAtLastError()`.
- `backends/fem/gpu/cuda/relaxation/relaxation_state.hpp`
  - wyłącznie mechaniczny rename typu pola; call-site i algorytm bez zmian.
- `backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp`
  - niezależny dense oracle dla pełnej SPD z niezerowymi wpisami
    pozadiagonalnymi;
  - positive scalar i x/y/z component apply;
  - setup 5→3, udany apply dla 3 i odrzucenie starego `n=5`;
  - null pointers, złe rozmiary i pozostałe edge cases.
- `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md` i source-map
  - bieżąca nazwa klasy oraz mapowanie stabilnych symboli setup/apply.
- `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md` i source-map
  - kanoniczna semantyka, jednostki i bieżące symbole Tasku 2.
- `docs/physics/0560-all-in-gpu-fem-runtime.md` i source-map
  - bieżąca nazwa klasy oraz pełny SPD negative control.
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md` i
  source-map
  - bieżąca nazwa klasy oraz pełny SPD negative control.
- `docs/superpowers/specs/2026-09-04-fem-gpu-direct-minimizers-phase1-design.md`
  - stabilny indeks wskazuje bieżące symbole; stare nazwy są jawnie oznaczone
    jako historyczny stan wejściowy przed Taskiem 2.
- `docs/performance/fem-gpu-performance-remediation-2026-09-01/`
  - źródłowe README i rozdział 07, combined mirror oraz statystyki manifestu
    wskazują bieżącą klasę diagonalną.
- `docs/audits/2026-09-02-fem-gpu-solver-completion.md`
  - bieżąca korekta preconditionera używa istniejącej nazwy klasy.
- `scripts/test_check_relaxation_contract_docs.py`
  - kontrakt map wymaga bieżących symboli i pełnego SPD negative control;
  - source-contract wymaga kolejności wrapper → `cuda_launch_ok` →
    `apply_count_` dla scalar/component i zabrania `cudaStreamDestroy` w
    fixture;
  - gate odrzuca usuniętą nazwę klasy na bieżących powierzchniach.
- `.superpowers/sdd/task-2-direct-minimizers-report.md`
  - niniejszy raport.

`backends/fem/CMakeLists.txt`, `nonlinear_cg.cpp`, `pgbb.cpp`, ABI i benchmark
nie wymagały zmian. Parent-owned `.superpowers/sdd/progress.md` nie został
zmieniony przez Task 2 i nie jest częścią stage/commitu.

## TDD RED — implementacja bazowa Tasku 2

Pierwotny RED został wykonany po zmianie wyłącznie testu kontraktowego przez
repozytoryjną recepturę:

```text
just verify-fem-demag-fem-bem-native-contract
```

Docelowy target nie kompilował się, ponieważ brakowało prawdziwie nazwanego
API `GpuDiagonalRelaxationPreconditioner`. Po minimalnej implementacji
pierwotny GREEN zakończył się 13/13 PASS.

## TDD RED — poprawki po review

Najpierw uruchomiono niezależne gate dokumentacji bez zmian produkcyjnych.

```text
0560 source-map: exit 1, 3 x declaration not found
0900 source-map: exit 1, 3 x declaration not found
test_check_relaxation_contract_docs.py:
Ran 10 tests
FAILED (failures=1, errors=1)
```

Następnie zmieniono tylko test C++ i dwukrotnie uruchomiono tę samą pełną
kontenerową recepturę, aby oba niezależne defekty miały obserwowalny RED.

Pierwszy runtime RED:

```text
12/13 tests passed
FAIL: scalar apply after larger-to-smaller re-setup must succeed
fem_gpu_relaxation_preconditioner_contract: Failed
```

Drugi historyczny runtime RED, po przeniesieniu testu launch-error przed test
rozmiaru:

```text
12/13 tests passed
FAIL: invalid CUDA stream must fail scalar preconditioner launch
fem_gpu_relaxation_preconditioner_contract: Failed
```

Oba RED doszły przez pełną kompilację C++/CUDA do docelowego CTest. Finalny
re-review wykazał jednak, że drugi fixture używał uchwytu po
`cudaStreamDestroy`, czyli zachowania niezdefiniowanego CUDA. Został usunięty
i nie jest traktowany jako ważny dowód ścieżki launch-error.

## TDD RED — finalny re-review

Przed usunięciem UB i poprawą bieżących dokumentów dodano lekki kontrakt
źródłowy. Wynik:

```text
python scripts/test_check_relaxation_contract_docs.py
Ran 12 tests
FAILED (failures=7)
```

Failures obejmowały `cudaStreamDestroy` w fixture, usuniętą nazwę klasy na
pięciu bieżących powierzchniach oraz brak symboli setup/apply w source-map 0510.
Po chirurgicznej korekcie ten sam test przeszedł 12/12.

## GREEN kontenerowy

Po minimalnej zmianie produkcyjnej uruchomiono dokładnie:

```text
just verify-fem-demag-fem-bem-native-contract
```

Końcowy wynik:

```text
8/13 Test #31: fem_gpu_relaxation_preconditioner_contract ... Passed 0.40 sec
100% tests passed, 0 tests failed out of 13
Total Test time (real) = 7.13 sec
```

Kod wyjścia receptury: 0. Podczas kompilacji wystąpiło zastane ostrzeżenie
NVCC o nieużytej metodzie `ComplexDouble::abs` w
`small_dense_dispatch.cu`; nie dotyczy ono diffu Tasku 2.

## GREEN dokumentacji

Indywidualne walidatory:

```text
validate_scientific_docs.py 0510-fem-relaxation-algorithms-mfem-gpu.source-map.json: exit 0
validate_scientific_docs.py 0560-all-in-gpu-fem-runtime.source-map.json: exit 0
validate_scientific_docs.py 0581-fem-gpu-direct-minimizer-preconditioning.source-map.json: exit 0
validate_scientific_docs.py 0900-native-fem-operator-contracts-and-validation.source-map.json: exit 0
```

Lekki gate kontraktu:

```text
python scripts/test_check_relaxation_contract_docs.py
Ran 12 tests in 0.076s
OK
```

Zestaw validatora dokumentacji:

```text
python -m unittest discover \
  -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
Ran 31 tests in 15.026s
OK
```

## Jednostki i scaling operatora

Odczyt źródła przed implementacją potwierdził:

1. `gpu_exchange_upload_legacy_sparse` kopiuje kanoniczne wartości CSR
   exchange bez dodatkowego skalowania.
2. `legacy_sparse_exchange_kernel` interpretuje je jako `K_A` w dżulach i
   dopiero przy budowie pola stosuje `-(2/(mu0*Ms))*K_A*m/M_lumped`.
3. `exchange_hessian_scale_from_step_m_per_a` zwraca `lambda*(2/mu0)`.
4. CPU oracle przekazuje ten współczynnik do operatora `M + weight*K_A`.

Kontrakt wejścia klasy diagonalnej:

- `mass_diagonal[i] = Ms_i*M_lumped_i`, jednostka `A*m^2`;
- `exchange_diagonal[i] = (K_A)_ii`, jednostka `J`;
- `weight = lambda*(2/mu0)`, jednostka `A*m/N`;
- faktor: `mass_i/(mass_i + weight*exchange_diagonal_i)`.

Task 2 nie dodaje drugiego `2/mu0`.

## Pokrycie kontraktu

- stabilne identyfikatory `none` i `diagonal`;
- fail-closed dla unqualified/stale/unknown i całej rodziny `exchange_mass*`;
- heterogeniczne masy i przekątne exchange;
- `weight=0`, zero RHS, x/y/z, maska free/inactive/fixed;
- puste/niespójne wymiary, ujemny/niefinity weight, niedodatnia aktywna masa,
  niefinity masa/exchange/RHS, null device pointers i złe rozmiary;
- positive scalar apply oraz component apply;
- re-setup 5→3 przy capacity 5, poprawny apply dla 3 i odrzucenie `n=5`;
- source-contract dla obu wrapperów potwierdza sprawdzenie
  `cudaPeekAtLastError()` przed inkrementacją `apply_count_`;
- pełna SPD z off-diagonal rozwiązana niezależnym dense oracle; norma różnicy
  od wyniku diagonalnego musi przekroczyć `1e-3`.

## Stan dowodów

- Source/compile/contract semantyki diagonalnej: `VERIFIED` przez powyższą
  kontenerową recepturę.
- Rzeczywisty launch-error nie jest wymuszany w teście runtime: bez produkcyjnej
  ścieżki do kontrolowanej awarii wymagałoby to test-only hooka albo UB.
  Fail-closed kolejność i propagacja mają source-contract; runtime obejmuje
  valid scalar/x-y-z oraz null/exact-size.
- Pełny sparse `exchange_mass_cg4|cg8`: `NOT IMPLEMENTED`, `NOT VERIFIED`.
- Produkcyjne podłączenie setupu do NCG/PG-BB: `NOT VERIFIED` (Task 4/5).
- Fail-closed propagacja przez algorytmy: `NOT VERIFIED` (Task 4/5).
- Receipt/ABI/provenance: `NOT VERIFIED` (Task 6).
- Physics validation, CPU/GPU parity, benchmark, Nsight i kwalifikacja
  wydajności: `NOT VERIFIED`.
- Capability i produkcyjny default nie są promowane; default pozostaje `none`.

## Self-review

- Diff nie dodaje CSR, fixed-CG, runtime env resolution, nowych buforów
  relaksacji, ABI, receipt ani benchmarku.
- `nonlinear_cg.cpp` i `pgbb.cpp` nie zmieniają algorytmu ani call-site'u.
- Logical size i capacity są rozdzielone bez wymuszania realokacji przy
  zmniejszeniu problemu.
- Oba istniejące void kernel launches są sprawdzane bezpośrednio, a licznik
  sukcesów rośnie dopiero po zaakceptowanym launchu.
- Usunięta nazwa klasy pozostaje tylko w jawnie historycznym projekcie/planie;
  bieżące noty, mapy, audit i pakiet performance wskazują istniejącą klasę, a
  lekki gate chroni te powierzchnie przed regresją.
- Nie uruchomiono hostowego Cargo/CMake ani ręcznego Dockera.
- Nie powtarzano ogólnego baseline; wykonano wyłącznie wymagane RED/GREEN w
  istniejącej kontenerowej recepturze.
- Brak rozszerzeń funkcjonalnych poza Task 2 i poprawkami review.
