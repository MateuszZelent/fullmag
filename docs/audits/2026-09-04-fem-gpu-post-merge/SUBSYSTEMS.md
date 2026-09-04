# Aneks: demag/hypre, RK i wiarygodność dowodów

Ścieżki są względem aktywnego worktree z [raportu](README.md). Ustalenia źródłowe nie są pomiarami runtime. P1 oznacza blokadę poprawności/wiarygodności przed promocją danej ścieżki; P2 oznacza lukę kwalifikacji lub kandydata do optymalizacji. Mechanizm niewłączony produkcyjnie nie jest traktowany jak powszechnie występująca awaria.

## H1 — P1: wymuszona niezależna walidacja nie dociera do Poisson

`backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp::validate_demag_poisson_hypre_device_solve`, okolice 380: `force_independent_validation` jest stałą false. FK odczytuje `FULLMAG_FEM_FORCE_INDEPENDENT_RESIDUAL` w `demag_fem_bem/fem_bem.cpp`, okolice 676. Wspólny przełącznik nie wymusza więc niezależnego residuum dla Poisson. Nie oznacza to, że Poisson nigdy nie bada residuum: pozostałe warunki polityki mogą je uruchomić. Test musi wymusić ten przełącznik przy solverze raportującym sukces i potwierdzić wykonanie niezależnego A*x-b.

## H2 — polityka AMG nie oznacza tego samego wykonania CPU/GPU

`backends/fem/core/demag_solver_policy.cpp` definiuje m.in. relax=18, coarsening=8, interpolation=6, aggressive=1. GPU Poisson (`hypre_device_solver.cpp:80`) i GPU FK (`fem_bem.cpp:245`) przekazują pola do AMG. CPU FK w `cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp:219` ustawia jedynie print level, pozostawiając resztę domyślnym MFEM/hypre. Różne realizacje CPU/GPU mogą legalnie mieć odmienne strojenie, ale receipt nie może przedstawiać requested policy jako faktycznie zastosowanej po obu stronach. Wymagane: albo wspólne stosowanie ustawień, albo jawnie rozdzielone resolved policy i ich testy.

## H3 — P1 przed promocją dowolnego strojenia: PCG i AMG

Parser polityki przyjmuje nieujemne kody AMG; tworzenie HyprePCG samo nie certyfikuje, że wybrany operator i preconditioner spełniają wymagania CG. Potrzebna walidacja obsługiwanych konfiguracji GPU oraz zgodności symetrii dla PCG. Nie jest to dowód, że aktualna domyślna konfiguracja jest niepoprawna. Nie przełączać skrycie solvera: odmówić nieobsługiwanej kombinacji lub opublikować uzgodniony resolved GMRES/flexible solver.

## H4 — P2: cold start FK i granice hostowe

`demag_fem_bem/fem_bem.cpp::solve_linear_system:455` zawsze zeruje iterat przed Mult, mimo iterative_mode. Potencjalny warm start należy porównać na kolejnych bliskich RHS, z invalidation i resetem po zmianie operatora oraz odrzuconej próbie. Nie zakładać, że zawsze pomaga.

`demag_poisson/hypre_stream_interop.cpp:311–365` używa event/wait między streamami. `demag_poisson/stage_compute.cpp:301` i dalsze odczytują statystyki solvera przez host API. Niezależna walidacja używa dodatkowych iloczynów i SpMV. Brak cudaStreamSynchronize w wrapperze nie dowodzi braku synchronizacji wewnątrz hypre. `HypreWrite()` przy RHS/iteracie wymaga sprawdzenia rzeczywistych transferów w użytym MFEM — nazwa funkcji sama nie dowodzi H2D.

## H5 — P2: tożsamość cache i zakres testów

Workspace Poisson (`demag_poisson/operators.hpp`, builder fingerprint w `operators.cpp`) śledzi operator, ale nie zawiera kompletnej tożsamości solvera/runtime. Odczyty statystyk w `hypre_device_solver.cpp` wybierają cast według bieżącego enumu. Jeżeli konfiguracja może zmienić się po setupie bez przebudowy, powstaje ryzyko rozjazdu typu obiektu i polityki. Audyt nie wykazał osiągalnej publicznej sekwencji powodującej ten błąd: sprawdzić lifecycle i wymusić immutable resolved policy lub invalidation. Nie jest konieczne hashowanie niezmiennej wersji biblioteki przy każdym kroku.

Małe fixture FK i Poisson wybierają CG+NONE; fixture ACA obejmuje mały rank-1 przykład. To dobry test komponentu, lecz nie dowód wielopoziomowego AMG ani realistycznego BEM. Dodać wieloblokowe/różnorankowe ACA, CG+AMG, nieregularną siatkę i serię zmiennych RHS. Procesowe zatrzaskiwanie pierwszego wyniku polityki hypre wymaga jawnego kontraktu inicjalizacji; fail-closed po błędzie nie jest samo w sobie defektem.

## R1 — P1, blokada włączenia: niepełny graf traktowany jak krok RK

`integrators/rk/rk_graph.cpp::RkGraphPlan::capture:98–153` przechwytuje kopię m do m_stage i memset probe, bez etapów RHS RK i aktualizacji kandydata. `rk_step.cu::gpu_rk_device_resident_step:45–53` po sukcesie launch pomija zwykłą pętlę i deklaruje liczbę RHS równą liczbie etapów oraz zerowy błąd. Nie ma tu pełnego solvera w grafie ani conditional nodes.

Ważna granica: `rk_graph.hpp` domyślnie ustawia Disabled, a wyszukiwanie callsite graph_plan wykazało użycie w rk_step, nie produkcyjny capture. Dlatego nie stwierdzamy, że domyślny solver już wykonuje puste kroki. Włączenie tej ścieżki w obecnym stanie jest niebezpieczne: pomija fizyczną integrację i używa nieprzygotowanego/starego kandydata. Test grafu sprawdza capture/launch, nie trajektorię. Zablokować promocję i dodać test end-to-end z niezerowym RHS oraz porównaniem graph/off, czasu, m i liczników.

Ta sama gałąź omija ReceiptAttemptGuard/PerformanceAttemptGuard; późniejszy note_device nie ma aktywnej próby. Naprawa grafu musi obejmować transaction i accounting, nie tylko dodatkowe kernele.

## R2 — P1: ignorowany błąd commit_candidate

`integrators/rk/rk_final_refresh.cu:183–197` odrzuca bool i tekst błędu `commit_candidate`, następnie publikuje statystyki/residency i zwraca sukces. `rk_output_control.cu::commit_candidate:228–260` może zwrócić false przy błędzie D2D, zanim zwiększy czas/licznik. W takim przypadku caller nadal deklaruje sukces mimo niezatwierdzonego kroku. Wymagana propagacja błędu oraz test fault injection: brak publikacji accepted, spójny czas i m, poprawny fail/rollback receipt.

## R3 — P2: adaptive pozostaje bounded host control

`rk_adaptive_decision_readback.cu:27–72` kopiuje pakiet na host i synchronizuje; `rk_adaptive_runtime.cu:23–82` liczy politykę na CPU. Wynik urządzeniowego kontrolera uruchamianego w `rk_attempt_loop.cu:226–242` nie steruje tą decyzją. Nie nazywać tego całkowicie device-resident adaptive. Dodatkowo make_unique snapshotu na próbę (`rk_attempt_loop.cu:140`) jest kandydatem do usunięcia po sprawdzeniu lifecycle. Jawna ograniczona decyzja hostowa może być poprawnym rozwiązaniem, jeśli jest uczciwie rozliczona i szybsza od alternatywy.

## E1 — P1 dla kwalifikacji: helpery harness nie są przebiegiem benchmarku

Robocze `direct_minimizer_benchmark_matrix_summary` (`scripts/analysis/fem_gpu_benchmark.py:705`) i `direct_minimizer_capture_summary` (`scripts/analysis/capture_fem_gpu_nsight.py:883`) są użyte przez testy; nie znaleziono włączenia ich w CLI/generowanie finalnego artefaktu. Poprawnie zwracany NOT VERIFIED nie jest wynikiem pomiaru. Potrzebny rzeczywisty producer, a potem test negatywny braku danych i zapisany Nsight trace.

## E2 — osobny WIP starego worktree: receipt v2

Poniższe nie dotyczą scalonego HEAD. W `fem-gpu-full-potential-20260902`:

- `execution_receipt.cpp::gpu_execution_receipt_begin_v2:495–564` resetuje część stanu, lecz nie plan_resolved i maski. Powtórny begin może odziedziczyć poprzedni plan. Runner rozpoczyna v2 dla NativeGpu (`dispatch.rs:3472`), a plan jest rozwiązywany dla NCG (`backend_step.cpp:531`). Testować NCG → PG-BB/LLG oraz pierwsze uruchomienie każdej metody.
- `relaxation/nonlinear_cg.cpp:73–113` ustawia executed coverage na wejściu, przed kernelami. Wczesne wyjście lub błąd nie może być świadectwem wykonania wszystkich operatorów.
- `gpu_execution_receipt_record_transfer` i `record_residency` mają definicje, ale brak runtime producentów; zera eksportu/transferów nie dowodzą braku ruchu danych.
- `close_compute_v2:719–735` przy aktywnej próbie nie agreguje całego jej accounting. Test ręcznie mutujący stan nie zastępuje repeated-begin, failure-close i terminal export end-to-end.

Przed przeniesieniem tych zmian uzgodnić zakres v2: tylko NCG albo pełne plany dla pozostałych metod. Resetować stan generacji i wiązać executed flags z rzeczywistym dispatch. Nie promować deklarowanych masek do dowodu rezydencji.

## S1 — sparse: pełne warianty cuSPARSE nie docierają do wskazanych ścieżek

`exchange/exchange_upload.cpp:322` ustawia allow_cusparse=false. Tak samo setup demag RHS/recovery w `demag_poisson/operators.cpp:1231,1242`. `sparse/sparse_apply_plan.cpp::SparseApplyPlan::apply_xyz` posiada implementację vendorową, ale produkcyjne dispatchery demag i exchange używają swoich launcherów. Nieperiodyczne warianty custom Scalar/Subwarp/Warp są realnym postępem; periodic exchange ma osobny przebieg (`integrators/rk/rk_exchange_dispatch.cu:68–115`). Claim o pięciu wariantach end-to-end jest zbyt szeroki. Wymagane: spiąć wybór z wykonywanym launcherem, doliczyć konwersje danych i potwierdzić executed variant w produkcyjnym trace.

## S2 — DMI: cache jest realny, coloring nie jest automatyczną optymalizacją

`interactions/dmi/dmi_geometry_cache.cu` buduje dane geometrii/kolorów, lecz pozostawia AtomicAdd jako domyślny tryb. Nie znaleziono produkcyjnego set_accumulation_mode. Tryb coloring w `dmi_kernels.cu:1012` uruchamia osobny kernel na kolor. Potrzebne A/B dla rzeczywistych siatek i liczby kolorów, nie założenie, że usunięcie atomików zawsze przyspiesza.

Odrzucone podejrzenie błędu: grid liczony po node_count nie oznacza pomijania elementów przy element_count > node_count. W scalonym HEAD zarówno kernel zwykły (`dmi_kernels.cu:62`), cached (`:264`), jak i kolorowany (`:460`) mają pętlę grid-stride. Elementy poza pierwszą falą są przetwarzane w kolejnych obrotach, a energia sumowana per uruchomiony blok. Nie należy naprawiać tego jako błędu poprawności przez samą zmianę liczby bloków. Warto zachować regresję wielu elementów na węzeł i ewentualnie stroić grid jako osobny eksperyment.

## S3 — częściowa fuzja i ACA

`integrators/rk/rk_effective_field.cu::gpu_rk_accumulate_effective_field` scala podstawową akumulację, ale regional drive i Oersted mają kolejne uruchomienia. Jest to częściowa fuzja, nie pełne połączenie wszystkich lokalnych operatorów. Oddzielne fazy mogą być uzasadnione; łączyć je tylko po wykazaniu kosztu i zachowaniu output materialization.

`demag_fem_bem/fem_bem.cpp:587–617,857–868` grupuje far-blocki, a `fem_bem_kernels.cu` przetwarza elementy batcha sekwencyjnie w bloku CUDA z barierami. Redukcja liczby launchy może kosztować równoległość. Zmierzyć rozkład rang, rozmiary bloków i occupancy; brak podstaw do stwierdzenia, że batching zawsze wygrywa lub zawsze przegrywa.

## S4 — P1 przed integracją: small-dense raportuje niewykonaną bibliotekę

`frequency_domain/small_dense_dispatch.cu::select_small_dense_variant:233–244` wybiera Cusolver dla forced GPU n>16. `small_dense_solve:266–303` jednak uruchamia ten sam własny kernel <<<1,1>>> dla wszystkich wariantów GPU, bez cuSolver. Kernel odrzuca n>64. Dla n=17..64 nazwa executed_variant może więc błędnie przypisywać wykonanie bibliotece; powyżej 64 brak obsługi. Alokacje i transfery CUDA w wrapperze nie mają propagacji statusów.

Nie znaleziono produkcyjnego callsite small_dense_solve poza testami. Jest to blokada promocji komponentu, nie dowód, że całe obecne PETSc/SLEPc używa tego błędnego dispatchu. Najkrótsza poprawna droga: uczciwa nazwa własnego wariantu i jawny zakres n, albo rzeczywisty cuSolver z obsługą błędów; dopiero potem integracja i full eigenproblem parity. Nie zmieniać solvera modalnego na podstawie testu n<=64.

Pomocnicze redukcje tego modułu wymagają również kontraktu pustego wejścia oraz poprawnego neutralnego elementu maksimum zamiast -1e300. Nie dowodzi to wady wszystkich produkcyjnych redukcji FEM: zakres dotyczy tego helpera.

## S5 — multi-GPU jest obecnie infrastrukturą kontraktową

`runtime/multi_gpu_binding.cpp::resolve_gpu_rank_binding` operuje mapą tekstowych env i listą urządzeń. Nie znaleziono produkcyjnego callsite poza testami, ustawienia cudaSetDevice ani połączenia z rzeczywistym rozproszonym operatorem w tym module. Flagi CUDA-aware MPI są deklaracjami wejściowymi, nie wykryciem transportu.

Parser `parse_env_int` przyjmuje prefiks liczby (np. 1junk) i nie weryfikuje zakresu przed cast do int. Przed użyciem runtime powinien odrzucać niepoprawny rank, overflow i brak wymaganej tożsamości zamiast cicho wracać do 0. Test wieloprocesowy musi sprawdzić mapowanie rank/GPU i kolizje. Ani syntetyczny preflight, ani test binding nie kwalifikują skalowania.
