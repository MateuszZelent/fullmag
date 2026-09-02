# Zweryfikowany audyt solvera FEM GPU/CUDA

- **Data weryfikacji:** 2026-09-02
- **Dokument źródłowy SOL PRO:** raport deklarujący rewizję `ae2627c2a8ed2a78ff8cf17c91b846679efc7f0d`
- **Rewizja podczas końcowej weryfikacji:** `df20f7c829e1801b5a9c0bb2f75761e94eb2c0d8`
- **`origin/master` podczas końcowej weryfikacji:** `bbbdd083b13fcf26213f7b537fd403a0e44cc63e`
- **SHA-256 pierwotnej lokalnej wersji raportu:** `A2EB139E94C2E36A94733E261D95B4C267BA55B7FD09E4A92E245E093C19A444`
- **Zakres:** HYPRE, demag Poisson, Fredkin–Köhler FEM/BEM, integratory RK, relaksacja NCG/PG-BB, Exchange, składanie pola efektywnego, DMI, ACA BEM i frequency domain.

> **Granica dowodu:** checkout był zabrudzony i zmieniał `HEAD` podczas audytu. Katalog
> `backends/fem/gpu/cuda/demag_fem_bem/` oraz test
> `backends/fem/tests/demag_fem_bem_gpu_contract.cpp` były nieśledzone przez Git.
> Wnioski dotyczące FEM/BEM opisują dokładnie ten working tree, a nie kod odtwarzalny
> z deklarowanego commitu. Nie wolno przedstawiać ich jako właściwości `master`, dopóki
> pliki nie zostaną włączone do kontrolowanej rewizji.
>
> Dla odtwarzalności roboczego FEM/BEM: `fem_bem.cpp` miał SHA-256
> `8980051C8A333B9D2ABD6F2E5B1E79DA27280CD8040DD4759F7C2ED96209FBF2`,
> `fem_bem_kernels.cu` —
> `94FF6A12D90FBDB6FE7C0E6E37472760D47535A06A888A263108C87259F23550`, a
> `demag_fem_bem_gpu_contract.cpp` —
> `FE4A06A0A49EC528E7940E2F09B4DB0C40843299E9419574BFEF9B3F23D4D9BB`.

## 1. Werdykt

SOL PRO trafnie wskazał najważniejsze klasy problemów: blokujące readbacki sterujące,
brak zakwalifikowanego preconditionera relaksacji GPU, koszt dodatkowego RHS dla metod
bez FSAL, fragmentację akumulacji pola, słabe mapowanie niektórych kerneli CSR/DMI/ACA
oraz twarde synchronizacje w roboczej implementacji FEM/BEM. Raport nie jest jednak
w pełni poprawny.

Najważniejsze korekty są następujące:

1. Poisson nie wykonuje niezależnego `A*x-b` po każdym poprawnie zbieżnym solve; robi
   to warunkowo. Bezwzględna redundancja występuje w roboczej ścieżce FEM/BEM.
2. Błąd Poissona propaguje się fail-closed. `BUG-01` nie został potwierdzony.
3. `cudaStreamWaitEvent(nullptr, ...)` nie jest blokującym hosta
   `cudaDeviceSynchronize`, a strumienie Fullmag są tworzone z
   `cudaStreamNonBlocking`. `BUG-03` w opisanej formie jest fałszywy, choć interop
   nadal zbyt mocno zakłada, na którym strumieniu MFEM uruchomi walidację.
4. Bufor 32 skalarów jest własnością `FemGpuState`, a nie statycznym buforem globalnym.
   Przy obecnym pojedynczym strumieniu nie wykazano wyścigu. `BUG-04` jest ryzykiem
   przyszłej wielostrumieniowości, nie aktywnym błędem.
5. Produkcyjny Exchange nie wykonuje zawsze trzech osobnych launchy. Zwykła ścieżka
   korzysta z fuzji XYZ, a okresowa z apply+lift. Nazwa profilu
   `legacy_sparse_gpu` nie dowodzi trzech kernel launchy.
6. Jednowątkowe kernele frequency domain obsługują głównie małe, ograniczone
   przypadki walidacyjne i skalarne decyzje; produkcyjna ścieżka modalna jest oparta
   na PETSc/SLEPc CUDA. Raport połączył te dwa kontrakty.
7. `HYPRE_PCGSetResidualConvergence` i `HYPRE_BoomerAMGSetDeviceLevel` nie występują
   w oficjalnym API używanego HYPRE 3.1 ani w sprawdzonym API 3.2. Nie mogą być częścią
   planu implementacji.
8. Wszystkie liczby `+15–50%`, `2–10x`, `3–6x`, `10–50x`, czasy mikrosekundowe oraz
   liczby iteracji podane przez SOL PRO są hipotezami. Repozytorium nie zawiera
   porównywalnego, źródłowo przypiętego benchmarku, który je potwierdza.

## 2. Status pasów dowodowych

| Pas dowodowy | Status | Co rzeczywiście sprawdzono |
|---|---|---|
| Źródło i kontrakty | **ZWERYFIKOWANE** | Aktualny working tree, caller chain, konfiguracja kontenera, testy kontraktowe i artefakty benchmarkowe znajdujące się w repozytorium. |
| Profil runtime RTX 4080 | **NOT VERIFIED** | Nie wykonano nowego managed run ani profilu Nsight dla tej rewizji. |
| Parity CPU/GPU | **NOT VERIFIED** | Brak nowego porównania pól, energii, trajektorii, residuów i time-to-tolerance. |
| Poprawność fizyczna | **NOT VERIFIED** | Audyt statyczny nie kwalifikuje demag FEM/BEM, relaksacji ani dynamiki. |
| Kwalifikacja produkcyjna | **NOT VERIFIED** | Brak czystego source identity, kompletnego receipt i artefaktów dla obecnego working tree. |

Legenda werdyktów: **POTWIERDZONE** oznacza zgodność mechanizmu ze źródłem;
**CZĘŚCIOWO** oznacza prawdziwy rdzeń i błędne uogólnienie lub estymatę;
**FAŁSZ** oznacza sprzeczność z aktualnym źródłem; **NOT VERIFIED** oznacza brak
pomiaru lub artefaktu koniecznego do rozstrzygnięcia.

## 3. Weryfikacja wszystkich punktów SOL PRO

| ID | Werdykt | Dowód źródłowy | Skorygowany wniosek |
|---|---|---|---|
| **2.1 HYPRE PCG/GMRES i D2H** | **CZĘŚCIOWO** | HYPRE 3.1 prowadzi pętlę Kryłowa na hoście, a iloczyny skalarne z GPU wracają jako hostowe `HYPRE_Real`; Fullmag wywołuje `HyprePCG::Mult`/`HypreGMRES::Mult` w `demag_poisson/hypre_device_solver.cpp::solve_hypre_device_system`. | Zależność sterująca CPU/GPU jest realna. Nie potwierdzono dokładnie 40 transferów, 3–6 µs ani 0,2 ms. Proponowane `HYPRE_PCGSetResidualConvergence` nie istnieje. GMRES wymaga osobnego profilu, nie wolno przypisywać mu licznika PCG. |
| **2.2 dodatkowa certyfikacja residuum** | **CZĘŚCIOWO** | `hypre_validation_policy.cpp::resolve_hypre_residual_validation_needs`; `hypre_device_solver.cpp::solve_hypre_device_system`; `demag_fem_bem/fem_bem.cpp::solve_linear_system`. | Poisson liczy niezależne residuum tylko po braku raportowanej zbieżności lub po wymuszeniu; norma RHS jest też potrzebna dla tolerancji absolutnej. FEM/BEM robi `A*x-b` i dwie normy bezwarunkowo po każdym solve. |
| **2.3 synchronizacje FEM/BEM** | **POTWIERDZONE DLA WORKING TREE** | `demag_fem_bem/fem_bem.cpp::solve_linear_system` ma `cudaStreamSynchronize(stream)` przed i po solve; funkcja jest używana dla dwóch układów. | Cztery hostowe oczekiwania na ewaluację są możliwe. Sama zamiana na event nie wystarczy: trzeba pożyczyć rzeczywisty strumień HYPRE, ustanowić zależności w obie strony i zachować fail-closed walidację. Kod nie jest obecnie śledzony przez Git. |
| **2.4 brak preconditionera relaksacji GPU** | **POTWIERDZONE** | `relaxation/nonlinear_cg.cpp::gpu_relax_nonlinear_cg_step`, `relaxation/pgbb.cpp::gpu_relax_projected_gradient_bb_step`, `gpu_relaxation_preconditioner.cpp::resolve_gpu_relaxation_preconditioner`. | NCG i PG-BB nie stosują odpowiednika CPU `(M+wK)^-1 M`. Dostępne są `None` i niezakwalifikowany `Diagonal`; HYPRE demag nie jest preconditionerem relaksacji. Liczba kroków i zysk 5–10x pozostają niezmierzone. |
| **2.5 BoomerAMG** | **CZĘŚCIOWO / NOT VERIFIED** | `core/demag_solver_policy.cpp`; `demag_poisson/hypre_device_solver.cpp::configure_demag_amg`. | Parametry 18/8/6/aggressive=1 są prawdziwe i konfigurowalne. Nie ma dowodu na 35–45 zamiast 15–20 iteracji ani próg `N<200`. `HYPRE_BoomerAMGSetDeviceLevel` nie istnieje. Potrzebny autotuner według sygnatury macierzy i pomiar setup/apply/coarse levels. |
| **3.1 18 skalarów po kroku RK** | **POTWIERDZONE MECHANICZNIE** | `runtime/backend_step.cpp::run_backend_step_attempt`, `rk_step_stats.hpp::GpuFinalScalarSlot`, `rk_step_stats.cu::finalize_step_stats_impl`, `rk_scalar_readback.cu::read_scalar_results_impl`. | Każdy publiczny zaakceptowany krok finalizuje 18 skalarów i wykonuje D2H z `cudaStreamSynchronize`. Nie ma jednak dowodu na 10–30 µs ani +20–40%. Nie można pominąć statystyk wyłącznie według logging stride, bo zasilają stop/relax/telemetrię. |
| **3.2 adaptive RK packet** | **POTWIERDZONE I NIEPEŁNE** | `rk_adaptive_decision_readback.cu::gpu_rk_read_attempt_control_packet`, `rk_stage_schedule.cu::gpu_rk_execute_stage_schedule`. | Każda adaptacyjna próba ma packet D2H i fence. Ten sam packet jest odczytywany również w gałęzi fixed-step dla błędu odroczonej normalizacji — dodatkowe wąskie gardło pominięte w raporcie. Sam kernel PI nie usuwa hostowej decyzji retry/rollback/commit. |
| **3.3 finalny RHS Heun/RK4** | **CZĘŚCIOWO** | `rk_final_refresh.cu::gpu_rk_finalize_accepted_step`, `rk_fsal_policy.cpp`. | Bez ważnego endpoint cache Heun ma zwykle 2+1 RHS, a RK4 4+1; BS23/DP54 mogą użyć warunkowego FSAL. Refresh zapewnia zgodne `H_eff`, RHS, statystyki, stop-state i cache, więc nie jest z definicji zbędny. Teoretyczny sufit usunięcia jednego równokosztowego RHS to ok. 33% dla Heuna i 20% dla RK4, nie 30–50% bezwarunkowo. |
| **3.4 Armijo readbacks** | **POTWIERDZONE MECHANICZNIE** | `relaxation/direct_energy_increment.cpp::direct_difference`, pętle w `pgbb.cpp` i `nonlinear_cg.cpp`, `rk_scalar_readback.cu::gpu_rk_read_control_scalar_results`. | Co najmniej jeden fence przypada na próbę Armijo. Dziesięć wykonanych prób daje co najmniej dziesięć takich fence’ów, ale liczba prób nie jest stała, a refinement/recovery mogą dodać kolejne. Decyzja energetyczna musi pozostać kanoniczna. |
| **4.1 CSR demag: thread-per-row** | **CZĘŚCIOWO** | `demag_poisson/demag_kernels.cu::demag_rhs_csr_kernel` i `demag_recovery_xyz_csr_kernel`. | Mapowanie i ryzyko divergence/gather są prawdziwe. Stwierdzenie „brak koalescencji” jest zbyt absolutne, a 3–6x niezmierzone. Warp-per-row może przegrać dla krótkich wierszy FEM; należy porównać scalar/subwarp/warp oraz cuSPARSE SpMV/SpMM na histogramach Fullmag. |
| **4.2 Exchange legacy/DD/3 launche** | **FAŁSZ / NIEAKTUALNE** | `exchange/exchange_operator.cpp`, `exchange/exchange_kernels.cu`, `rk_step_preflight.cu::gpu_rk_step_preflight`. | Nazwa wymaganego profilu to nadal `legacy_sparse_gpu`, lecz normalna nieokresowa ścieżka wykonuje fuzję XYZ; okresowa używa apply+lift. Trzy osobne komponenty są fallbackiem zgodności. Double-double pozostaje kosztem do zbadania, ale „~25 instrukcji” i 2–3x nie są dowodem. |
| **4.3 fragmentacja H_eff** | **CZĘŚCIOWO** | `rk_effective_field.cu::gpu_rk_accumulate_effective_field`. | Są trzy bazowe launche osi i zwykle trzy na aktywne oddziaływanie; Oersted i regional drive mają inne warianty. Liczba 12–18 nie jest stałym kontraktem. Fuzja jest sensownym A/B, ale musi zachować materializowane `H_eff`, obserwable i nie pogorszyć occupancy przez presję rejestrów. |
| **4.4 DMI atomics/geometria** | **POTWIERDZONE, RAPORT NIEPEŁNY** | `interactions/dmi/dmi_kernels.cu::dmi_tetra_gradients_device`, `dmi_tetra_field_energy_kernel`, `dmi_energy_difference_kernel`; `rk_dmi_fields.cu`. | Gradienty i objętość są liczone ponownie dla stałej siatki; energia trafia atomowo do jednego skalara. Ponadto assembly pola wykonuje 12 atomików/tet i podczas każdego RHS niepotrzebnie liczy energię, której caller pola nie używa. To mocniejsze kandydaty niż sam opis raportu. |
| **4.5 ACA BEM** | **CZĘŚCIOWO** | `demag_fem_bem/fem_bem_kernels.cu::fem_bem_far_apply_kernel`. | Pierwsza faza uruchamia 256 wątków, lecz pracę po factor wykonuje tylko `rank` wątków; to realne niedociążenie. Druga faza wykorzystuje więcej wątków, a histogram rang nie istnieje, więc 97–98% idle „całego kernela” i typowe rank 3–8 nie są potwierdzone. |
| **4.6 frequency `<<<1,1>>>`** | **CZĘŚCIOWO / MYLĄCE** | `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`, `backends/fem/gpu/cuda/frequency_domain/modal_krylov.cu`, `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`. | Jednowątkowe gęste solvery istnieją, ale przypadki są ograniczone do małych rozmiarów walidacyjnych; część `<<<1,1>>>` aktualizuje wyłącznie skalary BiCGSTAB. Produkcyjna ścieżka modalna używa PETSc/SLEPc CUDA. `final_metrics_kernel` ma sekwencyjny scan i zasługuje na A/B. cuSOLVER nie musi wygrać dla `N<=64`. |
| **BUG-01 Poisson kontynuuje po błędzie** | **FAŁSZ** | `demag_poisson/stage_compute.cpp`, `rk_demag_dispatch.cu`, caller chain RHS i publiczne API. | Zerowanie rozwiązania jest fail-closed cleanup. `false` i powód błędu propagują się do przerwania kroku; nie znaleziono ścieżki, która kontynuuje fizykę z zerowym demag po nieudanym solve. |
| **BUG-02 DMI overflow/NaN** | **CZĘŚCIOWO** | `dmi_kernels.cu::dmi_atomic_add_double`. | Globalny atomic i niedeterministyczna kolejność sumowania to realny koszt/ryzyko reprodukowalności. Nie wykazano overflow jako aktywnego błędu. Brakuje natomiast licznika zdegenerowanych tetów i jawnej diagnostyki wartości niefinitych. |
| **BUG-03 default stream blokuje wszystko** | **FAŁSZ W TEJ FORMIE** | `hypre_stream_interop.cpp::mfem_default_stream_wait_for_hypre_validation`, `runtime/mfem_context.cpp` oraz testy tworzące streamy `cudaStreamNonBlocking`. | `cudaStreamWaitEvent` tworzy zależność device-side i nie blokuje hosta. Nie synchronizuje automatycznie nonblocking streamów Fullmag. Ryzykiem jest założenie, że MFEM waliduje dokładnie na default stream; trzeba potwierdzić tożsamość streamu w Nsight/adapterze. |
| **BUG-04 statyczne 32 sloty/race** | **FAŁSZ OBECNIE, RYZYKO PRZYSZŁE** | `reductions/reduction_workspace_state.hpp::FemGpuReductionWorkspaceDeviceState`, `rk_step_stats.hpp`, `direct_energy_increment.cpp`. | To bufor per `FemGpuState`; obecny compute stream serializuje użytkowników i readback kończy się fence’em. Przy async/multistream potrzebne będą ownership tagi, generacje lub double buffering oraz racecheck/synccheck. |
| **BUG-05 ACA 97% idle** | **CZĘŚCIOWO** | `fem_bem_kernels.cu::fem_bem_far_apply_kernel`. | Pierwsza projekcja jest niedoparalelizowana, ale podany procent dotyczy tylko założonego `rank`, nie całego kernela ani całej fazy BEM. Jest to kandydat wydajnościowy, nie wykazany błąd funkcjonalny. |

## 4. Szczegółowe korekty architektoniczne

### 4.1 HYPRE: co naprawdę pozostaje na GPU

`runtime/hypre_device_policy.cpp` wymusza `HYPRE_MEMORY_DEVICE`,
`HYPRE_EXEC_DEVICE` oraz vendor SpTrans/SpMV/SpGEMM. Macierze, wektory, SpMV i AMG
są zatem realizowane na GPU. Nie oznacza to jednak pętli Kryłowa pozbawionej hostowych
decyzji. [Oficjalny kod HYPRE 3.1 PCG](https://github.com/hypre-space/hypre/blob/v3.1.0/src/krylov/pcg.c)
oraz `src/seq_mv/vector.c` prowadzi pętlę i konsumuje wyniki redukcji na hoście.
[Dokumentacja Kryłowa HYPRE](https://hypre.readthedocs.io/en/latest/api-sol-krylov.html)
nie zawiera dwóch API proponowanych przez SOL PRO.

Wniosek wdrożeniowy: najpierw zmierzyć liczbę i czas redukcji HYPRE w Nsight.
Następnie porównać co najmniej:

- HYPRE PCG/BoomerAMG 3.1 jako baseline;
- HYPRE 3.2 z tym samym algorytmem;
- PETSc `KSPPIPECG` z tym samym preconditionerem, jeśli adapter nie wymusza
  dodatkowych kopii lub synchronizacji;
- własny device-resident CG tylko jako ostatnią opcję, bo tworzy nowy dług
  poprawności, AMG i utrzymania.

Nie należy implementować planu opartego na nieistniejących funkcjach API.

### 4.2 Interop strumieni

`hypre_stream_interop.cpp::bind_hypre_compute_stream` pobiera rzeczywisty
`hypre_HandleComputeStream`. Zależności Fullmag→HYPRE i HYPRE→Fullmag są tworzone
zdarzeniami, bez globalnego `cudaDeviceSynchronize`. Oczekiwanie walidacji na
`nullptr` nadal jest kruche, ponieważ kontrakt mówi „MFEM default stream”, a nie
„strumień zwrócony przez wykonawcę konkretnego operatora MFEM”. Docelowo każdy
producent i konsument bufora powinien mieć jawny stream ownership i event.
[CUDA Programming Guide](https://docs.nvidia.com/cuda/cuda-programming-guide/02-basics/asynchronous-execution.html)
stanowi źródło semantyki default i nonblocking streams.

Roboczy FEM/BEM nie korzysta z tego adaptera i synchronizuje hosta. Poprawka musi
objąć oba kierunki zależności oraz pomiar, a nie tylko mechaniczne zastąpienie dwóch
wywołań nazwą `cudaStreamWaitEvent`.

### 4.3 RK: rozdzielić stan integratora od stanu obserwacji

Usunięcie finalizacji statystyk według samego `stride` byłoby błędem. Energie,
`max_rhs`, `max_torque`, momenty, licznik solve i aktualne `H_eff` mogą sterować
zakończeniem etapu, akceptacją relaksacji, telemetryką i następnym krokiem.

Bezpieczny kontrakt wymaga:

1. maski obserwabli i decyzji sterujących żądanych dla danego kroku;
2. jawnych bitów ważności accepted-state fields/stats;
3. odroczonego snapshotu, który materializuje tylko żądane pola;
4. zachowania dokładnie tej samej sekwencji accept/retry/rollback, `dt`, FSAL i
   kryteriów stopu;
5. receipt liczników fence/D2H/RHS/demag, obejmującego również finalizację po
   zakończeniu obecnego zakresu `gpu_attempt_hot_loop`.

Przeniesienie wyłącznie wzoru PI na GPU niczego nie rozwiązuje, jeżeli host nadal
musi odebrać flagę, zdecydować o rollbacku i ponownie uruchomić próbę. CUDA Graphs
mają sens dopiero dla całej kompatybilnej z capture pętli decyzji.

### 4.4 Exchange i CSR

Double-double może być uzasadnione redukcją błędu kasowania w wierszach operatora
wymiany. Nie wolno zastąpić go FP64 na podstawie intuicji. Wymagane A/B obejmuje:

- obecny double-double;
- zwykłe FP64 FMA;
- Kahan/pairwise lub przestawione sumowanie;
- scalar-row, subwarp-row, warp-row i cuSPARSE;
- błąd pola, energii, directional derivative i CPU/GPU parity na najgorszych
  siatkach jakościowych, nie tylko średni throughput.

Ponieważ trzy składowe używają tej samej topologii CSR, naturalnym kandydatem jest
`cusparseSpMM` z trwałym deskryptorem i preprocessingiem. Nie należy z góry zakładać,
że warp-per-row wygra na krótkich wierszach P1 FEM.

### 4.5 DMI: dodatkowe problemy nieuwzględnione przez SOL PRO

W aktualnym kodzie są cztery niezależne źródła kosztu:

1. gradienty czterech funkcji kształtu i objętość tet są liczone dla każdego RHS;
2. assembly pola wykonuje 12 `atomicAdd` na element (3 składowe × 4 węzły);
3. energia elementów jest atomowo sumowana do jednego adresu;
4. `rk_dmi_fields.cu` przekazuje workspace energii również w field-only stage, więc
   koszt energii występuje, choć wynik tego wywołania nie jest konsumowany.

Pierwszym bezpiecznym quick win jest przekazanie `nullptr` dla energii w ewaluacji
field-only i osobny test kontraktu. Następnie należy porównać precomputed gradients
(około 12 gradient components + volume na tet), element coloring, sortowanie lub
segmented reduction oraz CTA partials/CUB. Zdegenerowane tetraedry są obecnie
pomijane; potrzebny jest licznik i fail-closed próg. Caller powinien również sprawdzać
wyniki wszystkich `cudaMemsetAsync`, a nie polegać na późniejszym ujawnieniu błędu.

### 4.6 FEM/BEM ACA

Docelowe mapowanie należy wybrać na podstawie histogramów `rank`, liczby source/target
i wielkości bloków. Kandydatami są subwarp/warp na factor, wspólna redukcja po source,
grupowanie bloków o podobnym kształcie oraz batched GEMV/GEMM. Jedna stała konfiguracja
256 wątków nie będzie optymalna dla wszystkich bloków. Trzeba również mierzyć kolizje
atomików po stronie targetów i zachować zgodność potencjału/energii.

### 4.7 Frequency domain

Małe solvery walidacyjne `N<=64` należy benchmarkować osobno: CPU LAPACK może wygrać
z cuSOLVER ze względu na launch i transfer. Produkcyjny modalny GPU powinien pozostać
na PETSc/SLEPc i być profilowany jako osobna ścieżka. Jednowątkowe aktualizacje kilku
skalarów BiCGSTAB nie są równoważne jednowątkowemu SpMV; potencjalnym problemem jest
za to sekwencyjny scan w `modal_krylov.cu::final_metrics_kernel`.

## 5. Dodatkowe problemy znalezione podczas weryfikacji

| ID | Priorytet | Problem | Działanie |
|---|---|---|---|
| **NEW-01** | P0 | Fixed-step Heun/RK4 również wykonuje attempt-control D2H+fence z powodu odroczonego błędu normalizacji. | Dodać osobny licznik i profil fixed/adaptive; zaprojektować device-side validity/decision packet. |
| **NEW-02** | P0 | DMI liczy i atomowo sumuje energię podczas stage field-only, mimo że wynik nie jest używany. | Przekazywać `nullptr` w field-only; testować identyczność pola i spadek atomic traffic. |
| **NEW-03** | P0 | DMI assembly ma 12 atomików/tet, cicho pomija degeneraty i nie sprawdza wszystkich enqueue errors. | Licznik degeneratów, fail-closed polityka, kompletne error checking, A/B coloring/segmented reduction. |
| **NEW-04** | P0 | Zakres profilera `gpu_attempt_hot_loop` kończy się przed finalnym readbackiem publicznego kroku. | Receipt i NVTX muszą osobno raportować attempt, accepted finalization i snapshot/export. |
| **NEW-05** | P1 | Interop walidacji zakłada default stream MFEM, zamiast dowodzić dokładnego streamu producenta/konsumenta. | Jawny adapter stream ownership i test z niezależnymi nonblocking streams. |
| **NEW-06** | P0 | Audyt FEM/BEM opiera się na plikach nieśledzonych przez Git. | Najpierw czysta rewizja/source manifest; dopiero potem runtime i wynik produkcyjny. |
| **NEW-07** | P1 | `scripts/analysis/fem_gpu_benchmark.py` nadal emituje historyczne nazwy strategii preconditionera, których aktualny runtime C++ nie realizuje. | Usunąć drift albo przywrócić jawny, testowany mapping; nie używać historycznej macierzy jako kwalifikacji. |
| **NEW-08** | P1 | Adapter strumienia i testy twardo przypinają `MFEM_VERSION == 40900` oraz `HYPRE_RELEASE_NUMBER == 30100`. | Upgrade MFEM/HYPRE prowadzić jako osobną migrację adaptera, testów, patchy i receipt, nie podmianę dwóch tagów. |

## 6. Korekta macierzy oczekiwanych zysków

| Obszar | Estymata SOL PRO | Werdykt | Uczciwa granica przed benchmarkiem |
|---|---:|---|---|
| RK fences | `+20–40%` | **NOT VERIFIED** | Mechanizm jest realny, ale zysk zależy od kosztu RHS, liczby kroków i wymagań stop/telemetry. |
| Demag Poisson/HYPRE | `+30–50%` | **NOT VERIFIED** | Poisson nie wykonuje normalnie dodatkowego SpMV po sukcesie; trzeba osobno zmierzyć host reductions, AMG setup/apply i iteracje. |
| FEM/BEM | `2–4x` | **NOT VERIFIED** | Twarde fence i słaba pierwsza faza ACA są realne tylko w nieśledzonym kodzie; brak trace i parity. |
| Relaxation preconditioner | `5–10x mniej kroków` | **NOT VERIFIED** | Największy potencjalny zysk algorytmiczny, ale repozytoryjne evidence nie kwalifikuje żadnej strategii GPU. |
| H_eff fusion | `+15–25% RHS` | **NOT VERIFIED** | Sensowny kandydat memory/launch-bound; wynik zależy od aktywnego zestawu fizyki i occupancy. |
| Exchange | `2–3x` | **NOT VERIFIED** | Opis trzech launchy jest nieaktualny. Trzeba porównać dokładność DD/FP64 i formaty sparse. |
| DMI | `2–5x` | **NOT VERIFIED** | Field-only energy skip powinien być tani, lecz zysk całego RHS zależy od udziału DMI. |
| Frequency domain | `10–50x` | **NOT VERIFIED** | Mała walidacja i produkcyjny PETSc/SLEPc to różne ścieżki; CPU może wygrać dla bardzo małych układów. |

Jedyny prosty sufit analityczny dotyczy finalnego RHS przy założeniu równych kosztów:
usunięcie jednego z trzech RHS Heuna daje maksymalnie około 33% czasu całego kroku,
a jednego z pięciu RHS RK4 około 20%. To nie jest prognoza realnego zysku, ponieważ
RHS nie muszą mieć równego kosztu, a refresh obecnie niesie wymagane obserwable.

## 7. Najnowsze oficjalne technologie warte kwalifikacji

Stan datowany jest na 2026-09-02. „Najnowsze” nie znaczy „automatycznie lepsze”;
każda zmiana stosu musi przejść osobny managed build, correctness gate i benchmark.

| Warstwa | Stan Fullmag | Najnowsza sprawdzona informacja oficjalna | Decyzja dla Fullmag |
|---|---|---|---|
| CUDA | Dockerfile domyślnie 12.4.1; Windows compose nadpisuje na 12.6.3 | [CUDA Toolkit 13.3 Update 1](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html) zawiera nowsze cuSPARSE/cuSOLVER i narzędzia Nsight. | Osobny obraz eksperymentalny 13.3 dla RTX 4080. Nie zmieniać produkcji bez zgodności driver/Docker Desktop, buildów wszystkich zależności i parity. |
| HYPRE | 3.1.0 | [HYPRE 3.2.0](https://github.com/hypre-space/hypre/releases/tag/v3.2.0) z 2026-08-20 dodaje GPU mixed precision, flexible BoomerAMG cycles i overlapping Schwarz. | Priorytetowa gałąź kwalifikacyjna 3.2; mixed precision tylko z zewnętrznym FP64 residual/refinement i bez silent fallback. |
| MFEM | 4.9 | [MFEM 4.10](https://github.com/mfem/mfem/releases/tag/v4.10) z 2026-09-01 dodaje m.in. simplicial Bernstein H1 PA, interfejs cuDSS i rozszerzenia device. | Migracja 4.10 razem z adapterem HYPRE; sprawdzić, czy używane przestrzenie/bazy rzeczywiście korzystają z nowych PA kernels. |
| libCEED | stabilne 0.12.0 | [Oficjalne wydania libCEED](https://github.com/CEED/libCEED/releases) nadal oznaczają 0.12.0 jako latest stable; 1.0.0-rc.3 jest prerelease. | Pozostać na stabilnym 0.12.0 w produkcji; RC tylko w izolowanym eksperymencie operatorowym. libCEED nie zastępuje Kryłowa/AMG. |
| PETSc | 3.24.6 | [PETSc 3.25.5](https://petsc.org/release/install/download/) jest bieżącą dokumentowaną linią release. | Osobny upgrade frequency-domain; ocenić [KSPPIPECG](https://petsc.org/release/manualpages/KSP/KSPPIPECG/) jako wariant ograniczający blokujące global reductions. |
| SLEPc | 3.24.3 | [SLEPc 3.25.1](https://slepc.upv.es/release/installation/download.html) jest bieżącą linią release. | Kwalifikować razem z PETSc 3.25 i obecnymi problemami modalnymi, bez mieszania z demag RK. |

### 7.1 Konkretne rozwiązania CUDA do A/B

1. **[cuSPARSE Generic SpMM z preprocessingiem](https://docs.nvidia.com/cuda/cusparse/)** — dla trzech składowych XYZ i
   stałej topologii CSR. Deskryptory i workspace muszą należeć do operatora i być
   reużywane. `SpMVOp` z CUDA 13.x jest interesujący dzięki epilogom, ale pozostaje
   API eksperymentalnym; nie budować na nim od razu kontraktu produkcyjnego.
2. **[CUB/CCCL DeviceReduce i CTA partials](https://nvidia.github.io/cccl/unstable/cub/api/structcub_1_1DeviceReduce.html)** — zastąpić pojedynczy globalny atomic
   energii DMI i podobne redukcje. Zachować deterministyczny wariant kwalifikacyjny.
3. **[CUDA Graphs z conditional nodes](https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/cuda-graphs.html)** — tylko dla własnych, capture-compatible
   odcinków o stałej topologii. Najpierw udowodnić capture HYPRE/MFEM i zachowanie
   retry/rollback; inaczej graphować wyłącznie wewnętrzne sekwencje kerneli Fullmag.
4. **Pinned double buffers + events** — pakiety accepted-step/control mogą być
   buforowane, ale host nadal musi zaczekać przed użyciem decyzji. Zysk pochodzi z
   overlapu niezależnej pracy, nie z samej zamiany pamięci pageable na pinned.
5. **HYPRE 3.2 mixed precision** — niższa precyzja może przyspieszyć AMG/solve, lecz
   zewnętrzna norma residuum FP64, iterative refinement, parity energii/pola i jawna
   provenance requested/resolved precision są obowiązkowe.
6. **MFEM partial assembly / libCEED** — stosować tam, gdzie przestrzeń i operator
   są kompatybilne. Nie przepisywać złożonej fizyki do `mfem_bridge.cpp`; realizacje
   CPU/GPU mają współdzielić backend-neutralny kontrakt.
7. **cuDSS** — [oficjalna dokumentacja](https://docs.nvidia.com/cuda/cudss/) nadal
   oznacza bibliotekę jako Preview. Może być eksperymentem dla powtarzanego sparse
   direct solve/multi-RHS, ale nie jest zamiennikiem BoomerAMG i nie może być
   produkcyjną zależnością bez kwalifikacji licencji, pamięci, capture i błędów.
8. **Nsight Systems/Compute 2026** — profile muszą obejmować cały publiczny krok,
   a nie tylko zakres attempt. Mierzyć launch latency, memcpy, API sync, occupancy,
   register pressure, atomics, DRAM throughput i coarse AMG levels.

## 8. Skorygowany plan wykorzystania potencjału GPU/CUDA

### Faza 0 — odtwarzalny baseline i liczniki

1. Umieścić badany kod FEM/BEM w czystej, jednoznacznej rewizji albo wyłączyć go z
   pierwszego baseline.
2. Uruchomić repozytoryjny managed route (`just ensure-managed-fem-runtime`,
   `just fem-gpu-headless`, odpowiednie `verify-fem-*`) na RTX 4080.
3. Zapisać manifest: source identity, ProblemIR hash, mesh/topology, liczba DOF/nnz,
   device, requested/resolved precision, wersje zależności i brak fallbacku.
4. Dodać liczniki: RHS, demag solve, Krylov iterations, adaptive attempts/rejects,
   final refresh, FSAL hit/miss, control/bulk D2H, host fences, bytes i phase timing.
5. Profil Nsight obejmuje setup, attempt, accepted finalization, snapshot i export.

**Brama:** poprawny receipt, CPU oracle, brak NaN/Inf, stabilny wynik co najmniej pięciu
powtórzeń i raport p50/p95. Bez tego nie ma procentowej obietnicy.

### Faza 1 — niskiego ryzyka quick wins

1. Wyłączyć niewykorzystywaną energię DMI w stage field-only.
2. Zastąpić globalny atomic energii DMI redukcją blokową/device-wide; dodać licznik
   zdegenerowanych elementów i pełne error checking enqueue.
3. W FEM/BEM wdrożyć prawdziwy HYPRE stream interop i warunkową niezależną walidację.
4. Poszerzyć profiler/receipt tak, aby finalny readback nie znikał poza hot-loop.
5. Naprawić drift historycznych strategii benchmarku relaksacji.

**Brama:** identyczna semantyka pól/energii i nie gorszy czas p50/p95. FEM/BEM musi
mieć osobny parity/physics gate.

### Faza 2 — sparse kernels, fuzja i pamięć

1. Demag/Exchange: A/B scalar-row, subwarp, warp, cuSPARSE SpMV oraz SpMM XYZ z
   preprocessingiem i trwałym workspace.
2. Exchange: DD vs FP64/Kahan/pairwise z directional-derivative i najgorszymi
   przypadkami cancellation.
3. H_eff: generowane warianty według active interaction mask; najpierw fuzja osi i
   dodatków, potem opcjonalne połączenie z LLG bez utraty publicznego `H_eff`.
4. DMI: precomputed geometry i alternatywy dla 12 atomików/tet.
5. ACA: mapowanie adaptacyjne według rank/source/target oraz batching podobnych bloków.

**Brama:** kernel szybszy, ale również szybszy pełny RHS/krok; occupancy, rejestry,
pasmo i wynik numeryczny mieszczą się w kwalifikowanych granicach.

### Faza 3 — sterowanie krokami na GPU

1. Wprowadzić maskę wymaganych control/observable outputs i bity accepted-state
   validity.
2. Rozdzielić odroczony snapshot od kryteriów stopu i obowiązkowych decyzji.
3. Przenieść całą decyzję adaptive PI wraz z retry/rollback/commit na device albo
   utrzymać jeden jawny fence; nie udawać, że sam kernel PI rozwiązał problem.
4. Dopiero potem ocenić conditional CUDA Graphs i batching wielu kroków.
5. Po async/multistream przebudować scalar workspace na bufor wersjonowany lub
   double-buffered i uruchomić compute-sanitizer racecheck/synccheck.

**Brama:** identyczna sekwencja akceptacji/odrzuceń i `dt`, poprawny FSAL, stop-state,
rollback oraz parity wszystkich integratorów: Heun, RK4, BS23 i DP54.

### Faza 4 — preconditioner relaksacji i upgrade stosu

1. Zdefiniować backend-neutralny kontrakt `(M+wK)^-1 M` i manufactured SPD test.
2. Zaimplementować GPU application z jawnie ograniczoną tolerancją/iteracjami,
   reusable setup i bez hostowej materializacji wektorów.
3. Porównać None, Diagonal i exchange-mass na time-to-tolerance, nie tylko czas/krok.
4. W osobnym obrazie zaktualizować MFEM 4.10 + HYPRE 3.2 i usunąć/zmienić hard pins
   dopiero po przejściu kontraktów streamu, pamięci i solvera.
5. A/B HYPRE mixed precision z FP64 validation/refinement oraz baseline FP64.

**Brama:** mniejszy time-to-tolerance, monotoniczne/zaakceptowane Armijo, CPU/GPU
parity i zero silent CPU/UVM fallbacku.

### Faza 5 — frequency domain i małe układy

1. Produkcyjny modal GPU: PETSc/SLEPc 3.25 jako osobna migracja.
2. Małe układy walidacyjne: A/B obecny kernel, CPU LAPACK, MFEM batched linear algebra
   i cuSOLVER batched.
3. Równolegle zredukować sekwencyjne skany metryk; nie optymalizować skalarnych
   update kernels, jeśli profil nie pokazuje ich na ścieżce krytycznej.

### Faza 6 — multi-GPU dopiero po single-GPU

Wielogpu ma sens dopiero po usunięciu barier jednego GPU. Wymagane są per-rank device
binding, GPU-aware MPI, jawny brak host fallbacku, partycjonowanie danych i osobny
scaling efficiency gate. Nowe wsparcie device communication w MFEM 4.10 nadal ma
udokumentowane hostowe warianty dla części interfejsów, więc sama wersja biblioteki
nie dowodzi rezydencji.

## 9. Kontrakt benchmarku kwalifikacyjnego

Każdy kandydat musi używać tej samej geometrii, siatki/topologii, ProblemIR, stanu
początkowego, seed, precyzji i kryterium końca. Minimalny raport zawiera:

- pełny source identity i dependency manifest;
- requested/resolved backend, device i precision;
- DOF, nnz, histogram długości CSR i — dla ACA — rank/source/target;
- warm-up, co najmniej 5 powtórzeń, p50/p95 i wariancję;
- setup time oraz apply/step/time-to-tolerance oddzielnie;
- host fences, D2H/H2D bytes, launch count, RHS/demag/Krylov/Armijo counts;
- `m`, pola, energie, residua, trajectory/time-grid i stop reason względem CPU oracle;
- Nsight Systems trace i wybrane metryki Nsight Compute;
- finalny runner message, exit code, kompletny receipt i artefakty.

`just verify-fem-gpu-performance-regression`,
`just verify-fem-gpu-relaxation-preconditioner-qualification` i
`just verify-fem-gpu-demag-performance-benchmark` są właściwymi punktami integracji,
ale istniejący artefakt kwalifikacji preconditionera nie wskazuje obecnie żadnej
zakwalifikowanej strategii. Test źródłowy nie zastępuje runtime benchmarku.

## 10. Pytania do SOL PRO

1. Proszę o Nsight Systems/Compute trace, dokładną rewizję, manifest zależności,
   ProblemIR, geometrię, mesh/DOF/nnz, device i precision stanowiące podstawę każdej
   wartości procentowej i czasowej w raporcie.
2. W której dokładnie wersji i w którym nagłówku istnieją
   `HYPRE_PCGSetResidualConvergence` oraz `HYPRE_BoomerAMGSetDeviceLevel`? Oficjalne
   API HYPRE 3.1/3.2 sprawdzone w tym audycie ich nie zawiera.
3. Proszę o histogram rang ACA oraz pomiar, z którego wynika 97–98% bezczynności
   całego kernela, a nie tylko pierwszej pętli dla założonego rank 3–8.
4. Proszę wskazać benchmark, w którym frequency domain uzyskałoby 10–50x, oraz czy
   dotyczy on małego kernela walidacyjnego czy produkcyjnego PETSc/SLEPc.
5. Proszę wskazać dokładny caller chain, który rzekomo ignoruje błąd Poisson.
   Aktualny chain zwraca `false` i przerywa krok.
6. Jak ma zostać zachowana ważność `H_eff`, energii, stop-state, solve counters i
   FSAL po pominięciu finalnego RHS/statystyk na krokach „bez eksportu”?
7. Na jakich siatkach i kryteriach time-to-tolerance wykazano 5–10x mniej kroków po
   exchange-mass preconditionerze GPU? Aktualny artefakt repozytoryjny tego nie dowodzi.

## 11. Indeks najważniejszych źródeł

- `docker/fem-gpu/Dockerfile` — przypięty stos CUDA/MFEM/libCEED/HYPRE/PETSc/SLEPc.
- `backends/fem/gpu/cuda/runtime/hypre_device_policy.cpp` — device memory/execution i vendor sparse.
- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` — solve, statystyki i walidacja residuum.
- `backends/fem/gpu/cuda/demag_poisson/hypre_validation_policy.cpp` — warunki niezależnego residuum.
- `backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.cpp` — rzeczywisty stream HYPRE i eventy.
- `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp` — robocze solve FEM/BEM i twarde sync.
- `backends/fem/gpu/cuda/integrators/rk/rk_stage_schedule.cu` — packet dla adaptive i fixed.
- `backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu` — endpoint cache, FSAL i finalny RHS.
- `backends/fem/gpu/cuda/integrators/rk/rk_step_stats.cu` — redukcje accepted-step.
- `backends/fem/gpu/cuda/integrators/rk/rk_scalar_readback.cu` — D2H i host fence.
- `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp` — Armijo control readback.
- `backends/fem/gpu/cuda/exchange/exchange_operator.cpp` i `exchange_kernels.cu` — profile i realizacje CSR.
- `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu` — geometria, field assembly i redukcja energii.
- `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp` — produkcyjny modal GPU.
- `justfile` — managed build/run, Nsight i performance qualification gates.

## 12. Lista kompletności audytu

- [x] Zweryfikowano punkty 2.1–2.5.
- [x] Zweryfikowano punkty 3.1–3.4.
- [x] Zweryfikowano punkty 4.1–4.6.
- [x] Zweryfikowano BUG-01–BUG-05.
- [x] Skorygowano wszystkie osiem estymat macierzy optymalizacji.
- [x] Zweryfikowano wszystkie trzy fazy pierwotnej roadmapy i zastąpiono je planem z bramami poprawności.
- [x] Dodano osiem problemów pominiętych przez SOL PRO.
- [x] Sprawdzono najnowsze oficjalne kierunki CUDA, HYPRE, MFEM, libCEED, PETSc i SLEPc.
- [ ] Runtime benchmark RTX 4080 — **NOT VERIFIED**.
- [ ] CPU/GPU parity i fizyka — **NOT VERIFIED**.
- [ ] Kwalifikacja produkcyjna — **NOT VERIFIED**.
