# FEM GPU po merge — plan napraw i kwalifikacji

> Dla wykonującego agenta: użyj `executing-plans` i realizuj kolejne zadania z przeglądem przed przejściem dalej. Niniejszy dokument jest planem dalszej pracy, nie zgodą na uruchomienie wszystkich eksperymentów ani dowodem ich zakończenia.

**Cel:** doprowadzić scalony FEM GPU do poprawnego, osiągalnego produkcyjnie solvera i wykazać przyspieszenie czasu do tej samej tolerancji.

**Architektura:** zachować wspólne kontrakty fizyczne CPU/GPU i osobne realizacje runtime. Najpierw domknąć minimizery, provenance i pomiary; kolejne optymalizacje promować pojedynczo po parytecie i A/B. Nie przenosić nowej fizyki do Context ani mfem_bridge.cpp.

**Stos:** C++/CUDA, MFEM, hypre, cuSPARSE/CUB, Rust runner, Python harness; Windows i zarządzany kontener FEM.

## Warunki globalne

- Punkt wyjścia: `5c96cacf0af005ed58a7ad83696281e00eb02136`, branch `codex/fem-gpu-tasks1-5-remediation`. WIP opisany w [raporcie](../../audits/2026-09-04-fem-gpu-post-merge/README.md) nie jest jeszcze kwalifikowaną bazą.
- Nie usuwać starego worktree ani nie nadpisywać jego 19 zmienionych plików. Nie commitować `.superpowers/sdd/progress.md` lub cudzych zmian wraz z poprawką.
- FEM native budować i wykonywać przez repozytoryjne container-backed `just`; na Windows zachować `scripts/windows/run_fullmag_fem.ps1` i zewnętrzny magazyn `C:\git\fullmag\storage`. Receptur zakładających Linux `/mnt/...` nie przepisywać ad hoc na hostowe CMake/Cargo — naprawić właściwą trasę Windows przed ich użyciem.
- Każdy test musi identyfikować commit/diff, runtime/obraz, GPU, precyzję i problem. Brak wymaganego GPU oznacza błąd kwalifikacji, nie cichy CPU fallback.
- Przed każdą zmianą numeryczną zaktualizować 0581 i source-map; zachować jednostki SI, frozen/inactive nodes, material masks, symetrię operatora i rollback.
- Nie zmieniać progu tolerancji, siatki ani liczby próbek, żeby uzyskać korzystniejszy wynik. Zachować kanoniczny benchmark sinc-layer 500×500×10 nm i istniejące parametry fizyczne.
- Kod, kontrakty, runtime, fizyka i performance mają osobne statusy. Każdy podprojekt kończy się małym przeglądalnym commitem dopiero po uzyskaniu zgody na implementację i przejściu swoich bramek.

## Kolejność i podział

Zadanie 0 zamyka blokady poprawności istniejącego kodu; zadania 1–6 tworzą konieczny łańcuch integracji i pomiarów. Następne zadania są odrębnymi podprojektami: ich wykonanie zależy od wyniku profilu, nie od atrakcyjności technologii. Nie prowadzić jednocześnie zmian NCG i receipt w tych samych plikach przez różne modele.

### 0. Zabezpieczyć RK i wymuszoną walidację Poisson

Pliki: `backends/fem/gpu/cuda/integrators/rk/rk_step.cu`, `rk_graph.cpp`, `rk_final_refresh.cu`, `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp`; testy graph/transaction/Poisson. Uzasadnienie: R1/R2/H1 w [aneksie](../../audits/2026-09-04-fem-gpu-post-merge/SUBSYSTEMS.md).

- [ ] Dodać test wymuszonego Captured na niezerowym RHS: porównuje m, czas i rzeczywiste wywołania RHS z graph-off. Obecnego testu copy/memset nie uznawać za ten test. Najpierw ma ujawnić brak pełnego kroku.
- [ ] Do czasu pełnej implementacji usuwać wybór niepełnego grafu z produkcyjnego dispatchu przez jednoznaczny fail-closed albo uzgodniony fallback do istniejącej pełnej pętli. Nie ustawiać liczników RHS na podstawie liczby etapów bez wykonania tych etapów.
- [ ] Dodać fault injection commit_candidate=false: oczekiwany brak zaakceptowanego kroku i błąd finalizacji. Minimalna propagacja w finalizerze:

  ```cpp
  if (!commit_candidate(ctx, gpu.rk.candidate, stream, reason)) {
      gpu.rk.fsal_valid = false;
      return false;
  }
  ```

  Przed zatwierdzeniem sprawdzić również, czy przed tym punktem nie zmieniono stanu wymagającego rollbacku; caller ma zakończyć attempt jako failed, nie accepted.

- [ ] W Poisson zastąpić stałe false odczytem tej samej, rozstrzyganej poza gorącą pętlą polityki wymuszonej walidacji, której używa FK. Test przy zgłoszonym solver success i force=true musi wykazać niezależne residuum; force=false zachowuje dotychczasową warunkowość.
- [ ] Wykonać `just verify-fem-gpu-rk-transaction-contract`, `just verify-fem-time-domain-native-contract`, `just verify-fem-demag-poisson-contract-focused`. Bramka: testy negatywne i pełny rzeczywisty krok działają, niepełny graf nie może być promowany.

### 1. Ustalić jedną bazę i rozliczyć WIP

Pliki: 19 plików starego worktree wymienionych w audycie; aktywne `relaxation/*`, `state/gpu_state.cpp`, `runtime/mfem_context.cpp`, harness i testy Python.

- [ ] Zapisać osobno status/diff obu katalogów oraz dokładne HEAD; potwierdzić `git merge-base --is-ancestor a1ba0369e2d8a9cd9e62eb9c0cde5b3873fd5401 HEAD` (oczekiwany exit 0).
- [ ] Przypisać każdy hunk do PG-BB, NCG, receipt albo harness. Porównać kolizje ABI i lifecycle przed przeniesieniem; nie wykonywać zbiorczego checkout plików ze starego katalogu.
- [ ] Przenosić zaakceptowane fragmenty w odpowiednich zadaniach poniżej. Pozostawić oryginały do potwierdzenia kompletności.
- [ ] Bramka: żadna zmiana nie znika; HEAD/origin oraz lista WIP są jednoznaczne; nie twierdzić, że przeniesienie WIP oznacza już poprawność.

### 2. Naprawić fallback i ukończyć PG-BB

Pliki: `backends/fem/gpu/cuda/relaxation/pgbb.cpp`, `relaxation_memory.cpp/.hpp`, `relaxation_state.hpp`, `backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp`. Kontrakt wejściowy: odrębne g i z, stały plan sparse, wybrany profil; wyjściowy: poprawny kierunek/pochodna i transakcyjne przyjęcie próby.

- [ ] Dodać przypadek wymuszający niezstępujące z i zapamiętujący oryginalne g; oczekiwać po fallbacku z=g oraz g bez zmian. Uruchomić istniejącą recepturę `just verify-fem-demag-fem-bem-native-contract`; nowy przypadek musi wykazać błędny kierunek kopiowania przed poprawką.
- [ ] W istniejącym wywołaniu `gpu_rk_copy_component_device` dla `raw-gradient descent fallback` ustawić pierwsze argumenty dokładnie w kolejności:

  ```cpp
  gpu.rk.k[0],
  gpu.relaxation.preconditioned_gradient,
  ```

- [ ] Podłączyć kwalifikowany profil raz przed startem minimizera; rozróżnić request, resolved kind, fixed_iterations i powód odmowy. Testować none/diagonal/CG4/CG8, nieprawidłową tożsamość profilu i nieobsługiwaną kombinację.
- [ ] Oddzielić utworzenie buforów od aktualizacji lambda. Dla diagonali sprawdzać zmienne lambda bez ponownych cudaMalloc/cudaFree/H2D w iteracjach; dla none nie alokować dodatkowych preconditioner-only danych.
- [ ] Przetestować przyjęcie, odrzucenie, nie-finite, błąd CUDA, inactive/frozen nodes i odtworzenie stanu. Potwierdzić oryginalny raw-gradient stopping metric.
- [ ] Bramka: managed kontrakty przechodzą, test wymuszonego fallbacku ma RED/GREEN, trace nie ujawnia alokacji w hot loop; porównanie PG-BB CPU/GPU dopiero po zgodnych parametrach.

### 3. Wdrożyć prawdziwy preconditioned PR+ NCG

Pliki: `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp`, `pgbb_kernels.cu/.hpp`, `relaxation_state.hpp`; referencja `backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp::next_direction_pr_plus`; test preconditionera i kontrakty relaksacji.

- [ ] Najpierw test porównujący beta i kierunek CPU/GPU na tej samej małej siatce z nietrywialnym g != z, z transportem poprzedniego z. Obecna rekurencja oparta wyłącznie na g nie może zaliczać tego testu jako preconditioned PR+.
- [ ] Zachować osobno aktualne/poprzednie g, z i kierunek. Użyć tych samych wag i transportu co CPU, bez redefiniowania normy stopu.
- [ ] Przenieść obliczenie kierunku i pochodnej za poprawnie zakończone apply; propagować jego bool/error. Testować awarię apply bez publikacji częściowego kroku.
- [ ] Przetestować beta ujemne/restart, prawie zerowy mianownik, nieskończony wynik, utratę kierunku zstępującego i backtracking. Porównać niezależnie resztę układu preconditionera oraz trajektorię minimizacji.
- [ ] Wykonać `just verify-fem-demag-fem-bem-native-contract` oraz `just verify-fem-relaxation-runtime` właściwą trasą kontenerową. Bramka: zgodność kontraktu CPU/GPU, brak cichego fallbacku CPU, brak dowodu performance zastępowanego samą liczbą iteracji.

### 4. Zintegrować receipt v2/snapshot v3 end-to-end

Pliki: `backends/fem/gpu/cuda/runtime/execution_receipt.cpp/.hpp`, `performance_counters.cpp/.hpp`, `backends/fem/src/api.cpp`, `native/include/fullmag_fem.h`, `crates/fullmag-fem-sys/src/lib.rs`, `crates/fullmag-runner/src/fem/execution_receipt.rs`, `crates/fullmag-runner/src/fem/relax/finalize.rs` i odpowiednie pliki runnera ze starego WIP. Podstawą jest istniejący design `docs/superpowers/specs/2026-09-04-fem-gpu-ncg-receipt-v2-snapshot-v3-design.md`.

- [ ] Porównać rozmiary/layout ABI, numery wersji i walidację długości C/Rust; test odrzuca niezgodny payload zamiast czytać poza buforem.
- [ ] Sprawdzić reset liczników pomiędzy run/stage, monotoniczne liczniki prób, odrzuceń, RHS, preconditionera i rzeczywisty resolved backend.
- [ ] Przetestować publikację końcową success/failure/cancel: receipt musi odpowiadać tej samej sesji, źródłom i zaakceptowanemu stanowi. Nie zastępować błędu pozytywnym pustym receipt.
- [ ] Wykonać `just verify-fem-gpu-execution-receipt-contract` i testy Rust ABI/runnera przez zarządzaną trasę FEM. Bramka: spójne C → Rust → artefakt; profile request nie jest mylony z executed strategy.

### 5. Domknąć harness i porównywalność

Pliki: `scripts/analysis/fem_gpu_benchmark.py`, `scripts/analysis/capture_fem_gpu_nsight.py`, `scripts/test_fem_gpu_benchmark_contract.py`, `scripts/test_capture_fem_gpu_nsight.py`.

- [ ] Dokończyć mapowanie rzeczywistych trybów runtime dopiero po zadaniach 2–4; test musi odrzucać nazwę strategii, której receipt nie potwierdza.
- [ ] Zapewnić pytest w zarządzanym środowisku testowym i wykonać oba moduły; obecny wynik 20 unittestów nie zastępuje brakującego zestawu Nsight.
- [ ] Negatywne przypadki: różne mesh/material/source/runtime/GPU, brak terminalnego receipt, zero kernel activity, brak surowych wyników, wyjście runnera !=0, przekroczona tolerancja, różne stopping criteria. Każdy ma odrzucać promotion.
- [ ] Bramka: `python scripts/test_fem_gpu_benchmark_contract.py` oraz `python -m pytest scripts/test_capture_fem_gpu_nsight.py -q -p no:cacheprovider` kończą się exit 0 w deklarowanym środowisku, a testy negatywne nie akceptują nieporównywalnych par.

### 6. Wykonać pierwszy kwalifikowany baseline A/B i profil

Pliki wejściowe: istniejący baseline `benchmarks/fem-gpu/accepted/rtx4080-sm89`, kanoniczne fixture FEM performance; harness z zadania 5. Wyniki ciężkie poza repo; do repo tylko manifest/podsumowanie i odnośniki.

- [ ] Zbudować dwie niezmienne odmiany runtime: uzgodniony stary baseline i kandydat po naprawach. Manifest musi przechowywać oba pełne SHA i obrazy; nie nazywać bieżącego dirty runtime commitem bazowym.
- [ ] Wykonać warmup i co najmniej 5 powtórzeń w przeplatanej kolejności A/B. Zachować temperaturę/power policy, problem, siatkę, precision, tolerance i output cadence; rozróżnić cold setup i warm repeated solve.
- [ ] Mierzyć osobno setup, całość, demag solves, BEM, exchange, DMI, redukcje, transfers, line search, liczbę zaakceptowanych/odrzuconych prób i pamięć szczytową. Zebrać Nsight Systems; Nsight Compute tylko dla dominujących kerneli w osobnym biegu.
- [ ] Porównać energię, torque/residual, stan końcowy i czas do tej samej tolerancji. Fixed-step throughput publikować jako inną metrykę. CPU FP64 oracle: zachować również baseline jednowątkowy.
- [ ] Bramka: brak awarii/parity regression; mediany, rozrzut i surowe dane dostępne; nie promować różnicy mieszczącej się w szumie. W przeciwnym razie pozostawić status performance NOT VERIFIED lub NO GAIN.

### 7. Osobny podprojekt: hypre/BoomerAMG

Pliki: `backends/fem/gpu/cuda/runtime/hypre_device_policy.cpp`, `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp`, `hypre_stream_interop.cpp`, `hypre_validation_policy.cpp` i właściciele operatorów FEM/BEM.

- [ ] Po profilu ustalić udział solve/setup/scalar synchronization. Nie zakładać, że usunięcie fence wrappera usuwa synchronizację wewnątrz hypre.
- [ ] W odrębnym eksperymencie porównać wspierane konfiguracje AMG przy tej samej tolerancji: czas setupu, czas solve, liczba iteracji, operator complexity, VRAM, reuse hierarchii. Zachować zgodność symetrii ze stosowanym Krylovem.
- [ ] Sprawdzić invalidation po zmianie mesh/material/operator i ownership stream; dodać test zmiany generacji oraz niezależnego residuum.
- [ ] Uruchomić `just verify-fem-demag-amg-policy-contract`, `just verify-fem-demag-poisson-contract-focused`, `just verify-fem-demag-fem-bem-native-contract`, potem A/B z zadania 6. Bramka: zysk całego solve, poprawne residuum i brak ukrytej trasy CPU.

### 8. Osobny podprojekt: sparse/fuzja/DMI/BEM

Pliki: `backends/fem/gpu/cuda/sparse/sparse_apply_plan.cpp`, `sparse_apply_kernels.cu`, moduły DMI/FEM-BEM; testy `gpu_sparse_apply_contract.cpp`, `gpu_operator_fusion_contract.cpp`, `gpu_dmi_contract.cpp`.

- [ ] Udowodnić osiągalność każdej deklarowanej optymalizacji przez callsite produkcyjnego kroku i executed receipt, nie test standalone.
- [ ] Zachować grid-stride w DMI: nie traktować node-based grid jako błędu pomijania elementów. Dodać regresję element_count > node_count; zmiany liczby bloków wymagają spójnej liczby partials i pomiaru.
- [ ] Zmierzyć amortyzację setupu/autotuningu i porównać sparse variants z kosztem układania komponentów; sprawdzić trwałość workspace i deskryptorów.
- [ ] Dopiero dla faz dominujących łączyć redukcje lub batching. Weryfikować znaki/jednostki, inactive nodes, niejednorodne materiały, różne topologie i generacje geometrii.
- [ ] Bramka: kontrakty urządzeniowe plus pełny A/B; odrzucić wariant, który oszczędza launch, ale zwiększa całkowity czas lub pamięć ponad budżet.

### 9. Osobny podprojekt: RK/adaptive/graphs

Pliki: `backends/fem/gpu/cuda/integrators/rk/`, `backends/fem/tests/gpu_rk_device_controller_contract.cpp`, `gpu_rk_graph_contract.cpp`.

- [ ] Dla każdej wspieranej jawnej metody RK porównać graph/non-graph i accept/reject/retry; kontrolować czas, magnetyzację, pola, błędy i output cadence.
- [ ] Oddzielić hostową decyzję replay od conditional nodes CUDA. Każdą nazwę funkcji/metryki uzgodnić z rzeczywistą implementacją.
- [ ] Ustalić wymaganą politykę synchronizacji output/control; nie pomijać niezbędnych zdarzeń dla pozornego braku D2H.
- [ ] Uruchomić `just verify-fem-gpu-rk-transaction-contract` i `just verify-fem-time-domain-native-contract`. Bramka: wszystkie wspierane RK, bezpieczny fallback i profil produkcyjnego przebiegu, nie tylko pustego grafu.

### 10. Osobny podprojekt: aktualizacje stosu, potem precision

Pliki: aktualny Dockerfile/manifest stosu i testy dependency-stack; ustalić ich właścicieli z `just verify-fem-dependency-stack-contract` przed edycją.

- [ ] Jedna zmienna na eksperyment: najpierw hypre 3.2 FP64, następnie MFEM 4.10, osobno CUDA 13.x. Zachować rollback do istniejącego obrazu i nie zmieniać domyślnie wszystkich naraz.
- [ ] Dla CUDA skontrolować sterownik, arch listy (usunąć nieobsługiwane sm_60/sm_70 z kandydata), nazwy pakietów i cubin/PTX sm_89. Nie kwalifikować obrazu na podstawie samego udanego build.
- [ ] Mixed precision uruchomić dopiero po stabilnym FP64. Mierzyć niezależne FP64 residuum, korekcje, koszt refinement, wyniki fizyczne i trudne przypadki. Niekwalifikowany wariant nie może stać się automatycznym defaultem.
- [ ] Bramka: dependency contract, native contracts i A/B dla każdej odmiany; opublikować również brak zysku/regresję. Aktualne źródła producentów i ograniczenia znajdują się w raporcie.

### 11. Odroczyć promotion frequency-domain i multi-GPU do dowodów end-to-end

Pliki: `backends/fem/gpu/cuda/runtime/multi_gpu_binding.cpp`, ścieżka frequency-domain FEM, test `backends/fem/tests/frequency_domain/gpu_small_dense_contract.cpp`.

- [ ] Dla eigenproblem mierzyć pełny operator/iteracje/transfery i residual par własnych, nie tylko małą diagonalizację. `just verify-fem-frequency-domain-native-contract` to początek, nie końcowy dowód użytkowego rozwiązania.
- [ ] Przed integracją small_dense_dispatch usunąć błędne oznaczenie Cusolver dla własnego kernela lub zaimplementować prawdziwy wariant biblioteczny; testować n=17,64,65, niepowodzenie alokacji i rzeczywisty executed_variant. Poprawić pustą redukcję oraz maksimum dla całego zakresu double.
- [ ] Dla multi-GPU najpierw zidentyfikować rzeczywisty rozproszony operator/komunikację i liczbę GPU. Binding/preflight bez rozproszonej domeny oznaczyć jako infrastrukturę.
- [ ] Przed podłączeniem bindingu odrzucać niepełne liczby, overflow i nieprawidłowe rangi; testy 1junk, ujemnej wartości i liczby poza int mają kończyć się jawną odmową, nie wyborem GPU 0.
- [ ] Zaplanować strong/weak scaling dopiero po zamknięciu single-GPU. Na obecnej jednej RTX 4080 SUPER nie deklarować zweryfikowanego skalowania.
- [ ] Bramka: osobna kwalifikacja fizyczna i performance na rzeczywistym sprzęcie; w razie braku dowodów jawny NOT VERIFIED, bez blokowania poprawnego single-GPU.

### 12. Zamknąć dokumentację i release gate

- [ ] Zaktualizować 0581 wraz ze source-map do rzeczywistego stanu; uruchomić scientific-documentation-contract validator dla zmienionej publikacji.
- [ ] Dla wszystkich 14 punktów oryginalnego planu zapisać osobno implementację, osiągalność, kontrakty, runtime, fizykę i performance. Zachować oryginalne nazwy zadań.
- [ ] Powiązać każdy wynik z niezmiennymi artefaktami i źródłami. Sprawdzić kompletny managed zestaw dla zaakceptowanych lane; każdy brak pozostaje widoczny.
- [ ] Przed commitem wykonać oddzielnie `git diff --cached --name-only`; commitować tylko własny sprawdzony zakres. Push wyłącznie w uzgodnionym zakresie, bez force i bez zmiany mastera przez domysł.
- [ ] Warunek ukończenia programu optymalizacji: poprawny produkcyjny solver i wiarygodne wyniki porównawcze, nie liczba zielonych testów lub zamkniętych checkboxów. Dopuszczalny wynik eksperymentu to brak zysku — wtedy pozostaje prostsza poprawna implementacja.
