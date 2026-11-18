# Roadmapa optymalizacji solvera eigensolve FEM (2026-11-18)

- **Status:** propozycja planu wdrożenia (dokumentacja; brak zmian kodu źródłowego, brak nowych pomiarów runtime).
- **Bazowy commit weryfikacji kodu:** `origin/master` @ `e8402f3f6c` (2026-11-18).
- **Źródła prawdy o stanie solvera:**
  - `docs/audits/2026-11-18-eigensolve-performance-and-gpu-readiness-audit.md` (sekcje A1–A8, B, C, D, E, F, G oraz H i I);
  - `docs/physics/0830-fem-poisson-airbox-modal-eigen.md` (sekcja „Realizacja LU dokładnego rozwiązania Poissona (MUMPS/METIS)” w liniach 2118–2180; uwaga: sekcja „Dokładny shift-invert K0 przez rzadki układ rozszerzony (q, φ)” istnieje na osobnym branchu w toku — patrz niżej).
- **Powiązane dokumenty z tego samego zadania:**
  - [ADR 0084 — wykonanie FEM Eigenmodes w runie zaakceptowanym](../../adr/0084-accepted-fem-eigenmodes.md) (status: propozycja);
  - [Specyfikacja accepted FEM eigenmodes v1](../../specs/accepted-fem-eigenmodes-v1.md) (status: propozycja).

> **Granice dowodu:** wszystkie lokalizacje `ścieżka:linia` i symbole zostały sprawdzone bezpośrednio w bieżącym `origin/master` (`e8402f3f6c`). Wszystkie szacunki przyspieszeń i pamięci pochodzą z analizy kodu lub wcześniejszego audytu i są oznaczone jako **[H — szacunek]** do potwierdzenia pomiarami z sekcji 3. Branch `codex/eigensolve-a1-augmented-shift-20261118` (praca w toku innego agenta nad A1 dla CPU K0, `modal_augmented_shift_solver.hpp` i sekcja w `0830`) nie jest obecny w lokalnych referencjach tego checkoutu — w roadmapie traktujemy go jako zależność zewnętrzną bez przepisywania niezweryfikowanych numerów linii z tego brancha.

---

## 0. Stan bazowy i znane blokery

### Co jest już wdrożone na `origin/master` (nie planujemy tego ponownie)

- **Etap 1 (PR #451, `codex/eigensolve-stage1-perf-20261118`, opis w audycie H:417–438):**
  - `B1` — iloczyn skalarny dla metryki jednostkowej (`mass == nullptr`) w $O(n)$ (`backends/fem/cpu/frequency_domain/mode_deduplication.cpp:24-32`, `mass_inner_product`);
  - `B13`, `C3` (throttling) — `PoissonAirboxModalProgressThrottle` co 100 ms przy zachowaniu sprawdzania anulowania co iterację (`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp:247`);
  - `D11` — gęste widmo diagnostyczne ograniczone z $\le 4096$ do $\le 512$, powyżej progu `skipped_large_operator` (`crates/fullmag-runner/src/fem/eigen_native_window.rs:2260`);
  - `C4` (częściowo) — cache zmiennej środowiskowej `FULLMAG_FEM_GPU_K0_PETSC_DEBUG` (`backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp:962-966`, `gpu_k0_petsc_debug_enabled`);
  - `E5` — memoizacja builderów wykresów w `frequencyDomainChartModels.ts` i LRU(4) dla parsowania CSV dyspersji.
- **Etap 2 (PR #458, `00e62439e`, status w PR #460 / audyt I:440–467; naprawa PR #462 `2bcf36db7c`):**
  - `A2` (CPU toolchain i rola $P$) — oba prefiksy PETSc (`/opt/fullmag-deps` i `/opt/fullmag-mfem-cpu`) w `docker/fem-gpu/Dockerfile:283,290-339` budują `--download-openblas --download-metis --download-scalapack --download-mumps` z weryfikacją w `write_petsc_build_metadata.py`; wspólny helper `configure_modal_poisson_lu` (`backends/fem/cpu/frequency_domain/modal_poisson_lu.hpp:33-64`) używa MUMPS + METIS (`ICNTL(7)=5`) dla dokładnego Poissona K0 (`poisson_airbox_schur_matshell.cpp:1843`) i $P(k)$ Floqueta (`floquet_modal_solver.cpp:4284,7901`);
  - PR #456 i PR #459 — rozdzielenie kolejności warstw MFEM przed PETSc i parametr `FULLMAG_CPU_DEPENDENCY_BUILD_JOBS` (`docker/fem-gpu/Dockerfile:188,230`, pełny build toolchainu skrócony z ~4–5 h do ~47 min według audytu I:484);
  - PR #462 (`2bcf36db7c`) — przywrócenie `PCLU` w ograniczonym wyroczniowym solverze pełnego deskryptora `poisson_airbox_modal_eigen.cpp`.
- **W toku (prowadzi inny agent — nie dotykać):**
  - `A1` (CPU K0) — branch `codex/eigensolve-a1-augmented-shift-20261118`, plik `backends/fem/cpu/frequency_domain/modal_augmented_shift_solver.hpp`: dokładny shift-invert przez faktoryzację MUMPS układu rozszerzonego $K_\tau$ jako `PCSHELL` (wraz z nową sekcją w `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`).

### Znane blokery uwzględnione w harmonogramie

1. **Bloker uruchomienia z API/Control Room (run zaakceptowany):** `FemEigen` nie ma ścieżki wykonania w runie zaakceptowanym (preparer `accepted_fem_preparer.rs:194-207,473-484`, `NativeFemPreparationKind` w `crates/fullmag-runtime-control/src/study.rs:31-35,214-245`, `PreparationMaterialization` w `crates/fullmag-plan/src/preparation.rs:858-904`, worker `accepted_study_worker.rs:2736-2750,2975-2994` i `accepted_fem_study_worker.rs:85,445-447,595-607,633-655`, brak portu/kodeka `AcceptedFemRelaxStageHandoff`, oraz brak gałęzi `FemEigen` w `study_magnetization_layout_for_plan` i `materialize_study_magnetization_input_with_overlay` w `crates/fullmag-runner/src/lib.rs:3257-3323,3504-3519`). Rozwiązanie architektoniczne definiują [ADR 0084](../../adr/0084-accepted-fem-eigenmodes.md) i [accepted-fem-eigenmodes-v1.md](../../specs/accepted-fem-eigenmodes-v1.md).
2. **Pomiar eigensolve wymaga dziś lokalnego CLI headless (bez API) oraz poprawki PR #452:** na `origin/master` plik `examples/fem_eigen_k0_poisson_airbox_production.py:46` ma `grading="linear"`, które jest odrzucane przez strażnik `thin_film_scoped_fields_require_exact_cell_geometric_airbox` (`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py:235`). Poprawka `grading="geometric"` znajduje się na branchu `origin/codex/k0-airbox-geometric-grading-20261118` (PR #452).
3. **Progi gęstej materializacji maskują ścieżkę produkcyjną na małych siatkach:** w `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp:2620,2752` obowiązują progi:
   - `kProductionExactPreconditionerMaxDimension = 8192` dla `nearest_frequency` (`:5963,6008`),
   - `kProductionWindowExactPreconditionerMaxDimension = 512` dla `frequency_window` (`:5956,6004`),
   - a w `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp:1298` próg `kFloquetExactSchurPreconditionerMaxDimension = 512`.
   Dodatkowo nota `docs/physics/0830-fem-poisson-airbox-modal-eigen.md:537-543` definiuje wymiar $\le 1024$ jako `validation_only`, a kwalifikację produkcyjną dopiero dla `operator_dimension > 1024`. Mały model testowy nie uruchamia więc produkcyjnego `magnetic_shift_preconditioner` ani nowego ścieżkowego `PCSHELL` dla $K_\tau$.

---

## 1. Tabela pozycji audytu

Tabela obejmuje wszystkie wymagane pozycje audytu (`A1` Floquet $k \neq 0$ i GPU + status CPU K0 dla kompletności, `A3`, `A4`, `A5`, `A6`, `A7`, `B4`, `C1–C4`, `D1–D15`, `E1–E2`). Dla przejrzystości poniżej tabeli głównej zamieszczono skrócone przypisanie pozostałych pozycji pomocniczych (`A8`, `B2–B3`, `B5–B15`, `C5–C14`, `E3–E12`).

| ID | Obszar i zweryfikowana lokalizacja w `origin/master` (`e8402f3f6c`) | Stan (PR / branch) | Szacowany zysk [H] i uzasadnienie | Ryzyko | Zależności | Wymagana nota w `docs/physics/` |
|---|---|---|---|---|---|---|
| **A1 (CPU K0)** | `poisson_airbox_schur_matshell.cpp:6098` (`create_production_shift_preconditioner`); brak demagu powyżej `8192` (`nearest`, `:2620`) i `512` (`window`, `:2752`) | **w toku** — branch `codex/eigensolve-a1-augmented-shift-20261118` (`modal_augmented_shift_solver.hpp`, inny agent — nie dotykać) | **10–100×** [H, audyt A1:98] na jeden solve shift-invert: 1 faktoryzacja MUMPS układu rozszerzonego $K_\tau$ zamiast pętli GMRES z 2 rozwiązaniami Poissona na iterację | średnie (skalowanie bloków, pivotowanie z wierszem gauge, zachowanie niezależnego residualu deskryptora) | A2 CPU (PR #458 — wdrożone) | **Tak** — `0830` (sekcja „Dokładny shift-invert K0 przez rzadki układ rozszerzony (q, φ)” przygotowywana na branchu A1) |
| **A1 (Floquet $k \neq 0$)** | `floquet_modal_solver.cpp:1298,1818-1831` (`kFloquetExactSchurPreconditionerMaxDimension = 512`, `create_native_floquet_shifted_preconditioner` używa `rotated_a_qq − shift*gyrotropic` bez demagu; `kFloquetShiftedGmresDefaultRestart = 8`, `:1292`) | **do zrobienia** | **10–100×** [H, audyt A1:98] na punkt $k$ dla wymiaru $> 512$: zastąpienie GMRES(8) bez demagu dokładnym `PCSHELL` z MUMPS na układzie rozszerzonym $K_\tau(k)$ sprowadza liczbę iteracji GMRES do 1–2 | średnie–wysokie (spójność normalizacji `normalize_native_floquet_pencil` gdzie $A_{qq}, A_{q\phi}, B$ są skalowane a $P, A_{\phi q}$ nie; znak fazy $\sigma$; nieosobliwy $P(k)$) | A1 CPU K0 (wzorzec `PCSHELL` i `ICNTL(24)`), A2 CPU (PR #458) | **Tak** — `0830` + `0828` (rozszerzenie układu $K_\tau(k)$ z zachowaniem niezmienionej normalizacji i znaku fazy) |
| **A1 (GPU)** | `modal_petsc_slepc.cpp:422-477,1902-1903,2183-2188` (`create_hypre_shift_preconditioner_cuda`: BoomerAMG na nieokreślonym `[[A,σB],[-σB,A]]` bez demagu; 2× CG+BoomerAMG na matvec) | **do zrobienia** | **10–100×** [H, audyt A1:98, C1:249] dla siatek mieszczących się w VRAM: zastąpienie 3-poziomowego EPS→GMRES→CG+AMG jednym bezpośrednim solve `PCSHELL` na cuDSS dla $K_\tau$; dla większych siatek FGMRES blokowo-trójkątny (3–10× [H]) | wysokie (brak natywnego `MATSOLVERCUDSS` w PETSc 3.24.6 — patrz sekcja 5; limit VRAM dla czynników 3D; zakaz cichego fallbacku CPU) | A1 CPU K0 (walidacja algorytmu), integracja redystrybucji `libcudss` w `docker/fem-gpu/Dockerfile`, CUPTI (C11) | **Tak** — `0830` + `0831` (realizacja FEM GPU układu rozszerzonego i polityka pamięci/fail-closed) |
| **A3** | `poisson_airbox_modal_eigen.hpp:74` (`1e-10`), `poisson_airbox_schur_matshell.cpp:256-267` (`production_modal_eigensolver_tolerance` → `1e-12`), `:3881-3887` (`1e-13`), `:5998-6000` (`max_outer = PETSC_DEFAULT`), brak `EPSSetStoppingTestFunction` w CPU K0; `floquet_modal_solver.cpp:8188` ma tylko test anulowania (`stop_native_floquet_eps:1330`) | **do zrobienia** (odłożone w etapie 1 — audyt H:426) | **2–30×** [H, audyt A3:139] na oknach z nieudanymi podoknami (w historycznym pilocie 2026-10-01 aż 98,8% czasu w nieudanych podoknach): podniesienie tolerancji EPS/KSP ponad podłogę numeryczną i zatrzymanie stagnacji | niskie–średnie (niezależna bramka pełnego residualu deskryptora `:6779-6828` pozostaje nietknięta; zmiana terminacji podokien wymaga rozkładu `outer_iterations` z pomiarów bazowych) | Pomiar bazowy `executed_subwindows_json` (Etap 3a); przy wdrożonym A1 zysk z relaksacji inner KSP maleje, lecz cap restartów i stagnacja nadal chronią nieudane podokna | **Tak** — `0830` (polityka wewnętrznych tolerancji EPS/KSP, `PC_RIGHT` + `KSP_NORM_UNPRECONDITIONED`, próg stagnacji i limit restartów) |
| **A4** | `poisson_airbox_schur_matshell.cpp:3863-3870`, `floquet_modal_solver.cpp:1300,7506` (`PETSC_USE_COMPLEX` odrzucane); podwojony wymiar `split_count = 2*q` i `nev` 2–4× (`poisson_airbox_schur_matshell.cpp:5969-5974`), 2 seryjne solve'y Poissona na apply | **do zrobienia** | **2–4×** [H, audyt A4:152] na czasie i pamięci: eliminacja klas równoważności $J$ ($q$ i $\mathrm{i}q$), ~2× mniejszy rozmiar faktoryzacji LU/cuDSS oraz pojedynczy solve Poissona zamiast pary Re/Im (albo etap przejściowy: 2 RHS w `MatMatSolve` / BAIJ `bs=2`) | średnie–wysokie (drugi `PETSC_ARCH` z `--with-scalar-type=complex`, zmiana ABI / konwersji na granicy C++↔Rust, konwencja fazy i format certyfikatów) | A1 (CPU/GPU), A2; nie mieszać z `PETSC_ARCH` real używanym przez ścieżki real-only | **Tak** — `0830` + `0831` + `0828` (sformułowanie zespolone pencila i niezmienniczość fazy/certyfikatu) |
| **A5** | `poisson_airbox_schur_matshell.cpp:3944,4001-4174,4228-4446,3001-3095` (16+34 seryjne podokna pod `petsc_slepc_process_mutex()`, retry od zera, brak `EPSSetInitialSpace` — 0 wystąpień w `backends/fem/`, drugie LU w `configure_production_refinement_ksp`); `production_cpu_modal_eigen.cpp:4693`; `floquet_modal_solver.cpp:7529,7661,9459`; `modal_petsc_slepc.cpp:2886-3128` | **do zrobienia** | **1,5–3×** [H, audyt A5:171] z samego reuse obiektów EPS/analizy symbolicznej i `EPSSetInitialSpace`, **30–70%** [H] tańsze retry, oraz **~P×** [H] wall-clock przy $P$ równoległych procesach podokien/k-punktów (szczegóły wielowątkowości w sekcji 4) | średnie (deterministyczna deduplikacja „first wins” przy równoległych podoknach; konflikty z `petsc_slepc_process_mutex()`, kwarantanną i polityką wątków supervisora) | A2, A1 (współdzielenie faktoryzacji z refinementem), D8 (pula procesów $k$) | **Częściowo** — dla `EPSSetInitialSpace` i współdzielonej faktoryzacji krótka sekcja w `0830` (brak zmiany równań, lecz zmiana trajektorii Krylova); dla równoległości procesowej i wątków OpenBLAS/MUMPS: ADR/kontrakt zasobów (powiązany z ADR 0034 i ADR 0055) |
| **A6** | `poisson_airbox_schur_matshell.cpp:5003,5700` (`"count_certificate":{"status":"not_performed"}`), 16 bazowych + 34 podokna refinement (`:4001-4003`) jako pośredni test kompletności | **do zrobienia** | **~2–3×** [H, audyt A6:182] (eliminacja ~34 z 50 podproblemów okna + adaptacyjny dobór shiftów i `nev`) oraz **prawdziwy certyfikat kompletności widma** z twierdzenia Haynswortha (`MatGetInertia` w MUMPS LDLᵀ) | średnie–wysokie (wymaga najpierw numerycznej weryfikacji symetrii $A_{qq}$ i $A_{q\phi}=-\mu_0 A_{\phi q}^T$ oraz dodatniej określoności $L_{\mathrm{eff}}$; mody Goldstone'a lub siodła równowagi łamią założenie dodatniości) | A1 (układ rozszerzony $K_\tau$), A2 (MUMPS), pomiar numeryczny symetrii/inercji | **Tak** — `0830` + ADR (dowód symetrycznej formy KKT, reguła Haynswortha, warunki graniczne przy modach zerowych i nowy schemat `count_certificate`) |
| **A7** | `modal_eigen_solver.cpp:2297,2394,2538` (`assemble_poisson_airbox_shared_domain_payload` wołane per $k$); `poisson_airbox_shared_domain.cpp:2804` i `floquet_bloch_scalar.cpp:61` (podwójny montaż `DiffusionIntegrator`); `crates/fullmag-runner/src/fem/eigen_equilibrium.rs:403` + `eigen_shared_domain.rs:296` (ponowne wczytanie JSON równowagi, 4× `MeshTopology::from_ir`, ponowny statyczny demag per $k$) | **do zrobienia** | **2–10×** [H, zależy od liczby punktów $k$ i rozmiaru siatki] na narzucie per-$k$ w ścieżkach dyspersji: montaż niezależny od $k$ raz (`EigenPathContext` + native cache), per-$k$ jedynie kombinacja fazowa $\le 27$ translacji $\Delta t$ przez `MatSetValuesCOO` | średnie (akumulator pomija dokładne zera przy $k\cdot L \in \{0,\pi\}$, więc stały wzorzec zmienia hash CSR → wymaga digestu v2 i zachowania provenance per $k$) | A8 / D1–D2 (digest v2 dla stałego wzorca CSR), D4 | **Tak** — `0828` (rozkład $X(k) = \sum_{\Delta t} e^{\mathrm{i}k\cdot\Delta t} X_{\Delta t}$, niezmienniczość operatora, zmiana schematu digestu CSR) |
| **B4** | `floquet_modal_solver.cpp:1823-1855,7858-7901` (`create_native_floquet_shifted_preconditioner` robi `MatDuplicate` + `MatAXPY(DIFFERENT_NONZERO_PATTERN)` + ręczne wstawianie zer na diagonali i pełną analizę symboliczną per próba EPS; nowy $P(k)$ i KSP per $k$) | **do zrobienia** | **20–40%** [H, audyt B4:227] czasu faktoryzacji na próbach shift-invert / retry dzięki `SAME_NONZERO_PATTERN` i ponownemu użyciu fazy symbolicznej MUMPS (analiza METIS liczona raz na wzorzec) | niskie (ta sama algebra macierzy, jedynie stały wzorzec i reuse analizy symbolicznej) | A2 CPU (PR #458 — wdrożone); naturalnie łączy się z A1 (Floquet) | **Nie** (czysta optymalizacja realizacji pamięci/analizy symbolicznej bez zmiany równań i tolerancji; odnotować w `0830`/`0828`, jeśli współwdrażane z A1 Floquet) |
| **C1** | `modal_petsc_slepc.cpp:932-951,969-1010,1902-1903,2151-2168` (`apply_schur` robi 2 pełne CG+BoomerAMG na każdy matvec wewnętrznego GMRES(128) w `STSINVERT`; brak relaksacji tolerancji) | **do zrobienia** | **10–100×** [H, audyt C1:249] — dominujące wąskie gardło GPU (~$10^5\text{–}10^6$ V-cykli na podokno): zastąpienie 3-poziomowego zagnieżdżenia bezpośrednim `PCSHELL` na cuDSS (A1 GPU) lub FGMRES na $(q,\phi)$ z pojedynczym V-cyklem AMG($P$) | wysokie (integracja cuDSS albo FGMRES+PC blokowo-trójkątnego; rygorystyczny brak fallbacku CPU) | Sekcja 5 (weryfikacja cuDSS i VRAM), C4, C11 (CUPTI) | **Tak** — `0830` + `0831` (zmiana metody linear solve na GPU) |
| **C2** | `modal_petsc_slepc.cpp:422-477,2187-2188` (`create_hypre_shift_preconditioner_cuda`: domyślny BoomerAMG na nieokreślonym `[[A,σB],[-σB,A]]` bez demagu i bez przeplatania Re/Im / `num_functions`; `KSPSetErrorIfNotConverged` `:2168`) | **do zrobienia** | **wysoki** [H, audyt C2:250]: eliminacja niepowodzeń podokien i redukcja iteracji GMRES na GPU (dla ścieżki iteracyjnej: blokowy PC z przeplataniem `bs=2` lub sformułowanie SPD C14; przy A1 GPU zastępowane przez cuDSS) | średnie–wysokie (stabilność AMG dla układów typu Helmholtza jest ograniczona; docelowo eliminowane przez A1 GPU lub C14) | Pomiar bazowy `shift_linear_iteration_count` na GPU (Etap 3a); powiązane z C1 i C14 | **Tak** — `0830` (dla nowego preconditionera lub sformułowania C14) |
| **C3** | `modal_petsc_slepc.cpp:690,2248-2259` (`install_gpu_modal_ksp_convergence_test` nadal instalowane na wewnętrznym `poisson_ksp`, choć po PR #451 postęp jest throttlowany co 100 ms w `poisson_airbox_modal_eigen.hpp:247`) | **częściowo wdrożone** (PR #451 dodał throttling 100 ms; callback wciąż wpięty na wewnętrzny `poisson_ksp` i etykietowany jako `solving_shift_invert`) | **niski–średni po PR #451** [H]: usunięcie callbacku z wewnętrznego `poisson_ksp` usuwa narzut sprawdzania zegara/anulowania w każdej iteracji CG i błędną etykietę fazy (zostawić na `st_ksp`) | niskie (anulowanie pozostaje aktywne co iterację zewnętrznego `st_ksp` i między solve'ami Poissona) | PR #451 (wdrożone) | **Nie** (wyłącznie telemetria/callback; opisać w notatce regresyjnej testów GPU) |
| **C4** | `modal_petsc_slepc.cpp:962-966` (cache `getenv` wdrożony w PR #451); brak `HYPRE_BoomerAMGSetCycleRelaxType(..., 18, 3)` w ścieżce modal GPU (w time-domain jest w `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp:103`); ~3 synchronizacje skalarów/iterację GMRES (`KSP_GMRES_CGS_REFINE_ALWAYS`, `:2159`) | **częściowo wdrożone** (PR #451 zrobił cache `getenv`; coarse relax 18 świadomie odłożony w audycie H:424 do osobnego pomiaru w eigensolve) | **1,3–3×** [H, audyt C4:252] na ścieżce iteracyjnej GPU po wyeliminowaniu D2H/H2D na najgrubszym poziomie AMG i ograniczeniu synchronizacji host-device (uwaga: w time-domain nota `0913` wykazała regresję 4,18 s vs 3,88 s dla relax 18 — wymaga oddzielnego A/B dla eigensolve!) | niskie–średnie (możliwy wzrost liczby iteracji CG przy relax 18 — dlatego obowiązkowy pomiar A/B z CUPTI) | C11 (CUPTI do pomiaru D2H/H2D per V-cykl) | **Tak (warunkowo)** — krótki wpis w `0830` tylko jeśli zmienia się konfiguracja BoomerAMG lub ortogonalizacja Krylova z udokumentowanym A/B |
| **D (D1–D2, A8)** | `crates/fullmag-runner/src/fem/eigen_native_window.rs:2133-2156` (`CanonicalDigestBuilder::add_double_slice` z `format!` per element na 3 gęstych macierzach); `eigen_nonshared_domain.rs:36,672,738-757,1074-1150` (JSON `Value` 4 gęstych macierzy + sidecar per $k$); `poisson_airbox_shared_domain.cpp:1197-1213` (`add_digest_matrix`) | **do zrobienia** | **krytyczny (10–100× RAM i czas przygotowania)** [H, audyt A8:208-217]: eliminuje ~2,9 GB bufora tekstowego przy $n=4000$ i odblokowuje ścieżki `runner_operator` / Floquet nonshared powyżej 1–2 tys. węzłów | średnie (zmiana kontraktu digestu po obu stronach FFI → wymaga nowej wersji schematu `digest v2`, bez cichej zmiany wartości v1) | Nowy schemat digest v2 i walidatory sidecarów | **Tak (kontraktowa)** — nota `0830`/`0828` (wersja digestu v2) + specyfikacja schematu |
| **D (D3)** | `crates/fullmag-runner/src/fem/eigen_operator.rs:131-176` (`assemble_tangent_mass_matrix`, `assemble_full_2x2_operator_real` z `DMatrix::zeros(2n, 2n)`); `eigen_native_window.rs:846-858,2013-2076` (ok. 7 gęstych kopii i skan $n^2$ do CSR) | **do zrobienia** | **wysoki (z $O(n^2)$ do $O(\mathrm{nnz})$ pamięci i czasu)** [H, audyt D3:275]: bezpośredni montaż CSR/COO bez gęstych tablic row-major dla ścieżek z `runner_operator` | średnie (spójność hashy CSR i parzystość numeryczna ze ścieżką gęstą) | D1 (digest v2 na CSR zamiast gęstych macierzy) | **Nie** (jeśli operator dyskretny jest identyczny; jeśli zmienia digest → razem z D1) |
| **D (D4)** | `crates/fullmag-runner/src/fem/eigen_equilibrium.rs:403,697` (`load_certified_equilibrium_artifact`), `eigen_shared_domain.rs:296` (`build_shared_domain_linearization_state`), wołane per $k$ z `eigen_path.rs:1173` | **do zrobienia** | **wysoki** [H, audyt D4:276]: `EigenPathContext` (`Arc`) budowany raz na ścieżkę eliminuje $K$-krotny odczyt JSON równowagi, $4K$ przebudów `MeshTopology::from_ir` i $K$ statycznych rozwiązań demagu | niskie–średnie (zachowanie pełnej walidacji podpisów równowagi i provenance per $k$) | Brak (można wdrożyć niezależnie; naturalnie paruje się z A7) | **Nie** (cache stanu niemutowalnego bez zmiany równań; sprawdzić spójność z `0830:1895-1960`) |
| **D (D5–D6, D9–D10, D14)** | `eigen_path_artifacts.rs:134,4512`, `eigen_output.rs:66,1710` (`to_vec_pretty`, pełne wektory `q_*`/`phi_*` w JSON, 5–6× re-parse przy publikacji); `single_k_checkpoint.rs:284,400,808,882` (fsync per JSON modu); `eigen/k_process_pool.rs:1005-1172` (podwójny SHA-256); `eigen_path_artifacts.rs:2357-2805` ($O((KM)^2)$) | **do zrobienia** | **wysoki** [H, audyt D5–D6,D9–D10:277-282] ($O(K\cdot M\cdot N)$ I/O i RAM, szczególnie krytyczne na 9p/Windows): typowany `ModeRecord`, wektory wyłącznie binarnie (f64 LE), 1 serializacja, kompaktowy checkpoint | średnie (zmiana formatu publikacji JSON modu powiązana z E3 i `docs/specs/eigenmode-artifacts-v1.md` / `frequency-domain-artifacts-v2.md`) | Specyfikacja v2/v3 artefaktów eigen (spójna z ADR 0084 i E3) | **Nie** (transport/serializacja — wymaga aktualizacji `docs/specs/frequency-domain-artifacts-v2.md` i ADR 0084) |
| **D (D7)** | `crates/fullmag-runner/src/eigen/tracking.rs:253-281,1217` (`modal_overlap_views`, `track_branches`: `normalize` + `embed` z alokacją dla każdej pary gałąź×mod) | **do zrobienia** | **10–100×** [H, audyt D7:279] na fazie trackingu dla dużych siatek (redukcja z ~$10^{12}$ operacji przy $T=300\text{k}, B=M=40, K=100$ do $O(3N)$ per para dzięki prekalkulacji $M_c v$ raz na mod) | niskie (identyczny iloczyn w metryce consistent-P1; dodać test równości macierzy overlapów do $10^{-14}$) | Brak | **Nie** (czysta faktoryzacja algebraiczna istniejącego iloczynu z `0830`) |
| **D (D8)** | `crates/fullmag-ir/src/parallel_execution.rs:82` (`ParallelExecutionModeIR::Serial` domyślne); `fem/eigen_k_pool.rs:280-375`, `eigen_k_worker.rs:764-794` (klon całego planu + hashowanie binarki i pliku równowagi per $k$; brak batchowania $k$) | **do zrobienia** | **~P×** [H, audyt D8:280] na ścieżkach wielopunktowych $k$ na maszynach 16–40 rdzeni + redukcja narzutu startu procesu per punkt $k$ (szczegóły w sekcji 4) | średnie (zarządzanie budżetem CPU/RAM i polityką wątków w supervisorze — ADR 0034; brak zmiany wyników względem trybu `serial`) | D4, koordynacja z sekcją 4 (budżet wątków) | **Nie** (harmonogramowanie i transport — reguluje ADR 0034) |
| **D (D12–D13)** | `fem/eigen_execution.rs:1631` (`gpu_eigen_dense_solve` $O(n^3)$ dla 1 wartości z transportem JSON), `:2475` (`solve_complex_hermitian_eigenpairs` $O(n^3)$ bez native) | **do zrobienia** | **średni** [H, audyt D12–D13:284-285]: eliminacja niejawnego $O(n^3)$ i podwójnych wektorów w JSON dla Kittel k0 GPU | niskie–średnie (jawny próg odrzucenia na etapie planowania zamiast cichego $O(n^3)$) | D1–D2 lub A1 GPU | **Nie** (chyba że zastąpienie Kittel GPU shift-invertem — wtedy wpis w `0830`) |
| **D (D15)** | `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs:1260,1356,2085,2354` (`capture_frequency_domain_artifact_set`), `crates/fullmag-session/src/frequency_domain_artifact_generation.rs:345-352` (`read_member_bounded`): brak cache manifestu, blokujące I/O na wątkach tokio, brak ETag/304 dla JSON, pełny JSON modu z wektorami | **do zrobienia** | **średni–wysoki** [H, audyt D15:287] na responsywności Control Room i narzucie CPU serwera API (eliminacja 3× parsowania manifestu i blokowania runtime tokio) | niskie (ETag wiązany z istniejącym `member.sha256` i `generation_id`; brak zmiany semantyki fizycznej) | D5 / E3 (DTO mode summary bez wektorów) | **Nie** (kontrakt API v2 i ADR 0058) |
| **E1** | `apps/control-room/src/kernel/visualization/AnalysisFieldOverlayPhaseAnimation.ts:66,89,185,198`, `AnalysisFieldOverlayController.ts:71,223-234,291,455`: animacja fazy co klatkę rAF wywołuje `controller.update({visualizationPhaseRad})` i przelicza cały stan Reacta, Explorera i paneli | **do zrobienia** (odłożone w etapie 1 — audyt H:428) | **wysoki** [H, audyt E1:295] (płynne 60 fps zamiast zacięć UI): przeniesienie fazy animacji do zegara poza Reactem (wzorzec `ModeCompositionPhaseClock` już używany w `useViewport3DSceneModel.ts:148,3273`) i throttling suwaka do ~10 Hz | niskie–średnie (wymaga dowodu z przeglądarki WebGL i testów synchronizacji suwaka/klawiatury) | E2 (wspólna ścieżka uniformu fazy w rendererze) | **Nie** (wyłącznie warstwa prezentacji Control Room) |
| **E2** | `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:4922-4948`, `viewport3dRenderModel.ts:781-846,1080-1131,1826`, `useViewport3DScalarColorUpload.ts:135-152`, `viewport3DDerivedWorkPlan.ts:50-100`: `visualizationPhaseRad` w `primaryFieldRenderOptions` i `buildKey` powoduje alokację ~50 MB/klatkę przy 1M węzłów i re-upload atrybutów GPU mimo istniejącego uniformu `complexPhaseRad` | **do zrobienia** (odłożone w etapie 1 — audyt H:428) | **wysoki** [H, audyt E2:296]: eliminuje ~50 MB/klatkę alokacji i transferu H2D atrybutów kolorów/wektorów podczas animacji fazy (zostaje aktualizacja 1 uniformu w `useFrame`) | średnie (spójność z trybami glifów E10 i eksportem 3D `export3dVtkSerializer.ts:491`, który nadal czyta `complexPhaseRad`; wymaga dowodu WebGL) | E1 (źródło fazy poza `primaryFieldRenderOptions`) | **Nie** (wyłącznie warstwa WebGL/React Control Room) |

**Pozycje pomocnicze z audytu (powiązane z powyższymi etapami):**
- `B2` (`poisson_airbox_schur_matshell.cpp:2620-2747`: gęste LU w SeqAIJ dla `512 < split ≤ 8192`) — do zastąpienia przez `MATSEQDENSE` + LAPACK `getrf` lub wyeliminowania przez A1 CPU K0 (obniżenie progu dokładnej materializacji do `512` albo wyłączenie przy włączonym A1);
- `B3` (`:1700-1808`), `B5` (`floquet_modal_solver.cpp` + `shifted_ksp_true_convergence.hpp`), `B6` (`poisson_airbox_schur_matshell.cpp:6171`, `floquet_modal_solver.cpp:8185`, `modal_petsc_slepc.cpp:2134` — `EPSSetTrueResidual(PETSC_TRUE)`), `B7`, `B8` (`:6619-6978`), `B9–B12`, `B14–B15` — włączone do Etapów 3 i 4;
- `C5–C14` (`modal_petsc_slepc.cpp`) — włączone do Etapu 3 (szybkie poprawki `C5`, `C7`) oraz Etapu 7 (`C6`, `C8–C11`, `C14`; nie budować na martwym `modal_krylov.cu` — `C12` — ani na gęstym `eigensolver_gpu.cu` / `syevd`);
- `E3–E4`, `E6–E12` — włączone do Etapu 8 wraz z `D15`.

---

## 2. Kolejność wdrożenia (Etapy 3–8)

Numeracja kontynuuje zakończone **Etap 1 (PR #451)** i **Etap 2 (PR #458)** oraz równolegle prowadzony **A1 dla CPU K0** (`codex/eigensolve-a1-augmented-shift-20261118`). Każdy etap wymaga uprzedniego spełnienia kryterium wejścia, w tym — tam gdzie zaznaczono w tabeli 1 — zwalidowanej noty w `docs/physics/` (zgodnie z `scientific-documentation-contract`).

### Etap 3: Pomiary bazowe, stabilizacja tolerancji/limitów i reuse bez zmiany algorytmu (`A3`, `B2–B8`, `C3–C5`, `C7`)

- **Cel:** zebrać pierwsze wiarygodne baseline'y runtime na 3 reżimach rozmiaru, uciąć marnowanie czasu w nieudanych podoknach i redundantnych faktoryzacjach/applies zarówno na CPU, jak i na istniejącym lane GPU.
- **Kryterium wejścia:**
  1. Scalenie PR #452 (`codex/k0-airbox-geometric-grading-20261118`) lub użycie lokalnego skryptu benchmarkowego z `grading="geometric"` (obejście regresji z `examples/fem_eigen_k0_poisson_airbox_production.py:46`).
  2. Zebranie pomiaru bazowego (Etap 3a, bez zmian kodu) dla wszystkich 3 reżimów z sekcji 3 — w tym rozkładu `slepc.outer_iterations`, `shift_linear_iteration_count`, `poisson_solve_count`, `exact_preconditioner.construction_seconds` i `eps_solve_seconds`.
  3. Dla `A3`, `B6` i opcjonalnie `C4` (relax 18): uzupełniona i zwalidowana nota w `docs/physics/0830-fem-poisson-airbox-modal-eigen.md` (+ `source-map.json`).
- **Zakres plików (ścieżka + symbol w `origin/master`):**
  - `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`:
    - `production_modal_eigensolver_tolerance` (`:256-267`) i konfiguracja `default_tuning` (`:3880-3888`) — podniesienie wewnętrznych tolerancji EPS/KSP i domyślne `PC_RIGHT` + `KSP_NORM_UNPRECONDITIONED` (`:6186-6192`),
    - `solve_poisson_airbox_modal_eigen_cpu_schur` (`:5998-6000`, `:6164-6172`) — jawny cap `max_outer` i `EPSSetStoppingTestFunction` (detekcja stagnacji), weryfikacja wyłączenia `EPSSetTrueResidual(PETSC_TRUE)` (`:6171`),
    - `kProductionExactPreconditionerMaxDimension` (`:2620`) / `create_production_exact_shift_preconditioner` (`:6028`) — zastąpienie gęstego SeqAIJ LU przez `MATSEQDENSE` + LAPACK `getrf` albo obniżenie progu przy aktywnym A1 (`B2`),
    - `create_production_shift_preconditioner` (`:1700`) — trwały `Mat` o stałym wzorcu (`B3`),
    - `configure_production_refinement_ksp` (`:3001`) — pominięcie kosztownego refinementu na podoknach z `eps_reason < 0` (`B7`) oraz wstępna eliminacja kopii $J$ przed refinementem (`B8`, przed `deduplicate_modes_by_frequency_and_overlap` w `:6978`);
  - `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp`:
    - `create_native_floquet_shifted_preconditioner` (`:1818-1856`) — `SAME_NONZERO_PATTERN` i reuse analizy symbolicznej MUMPS (`B4`),
    - `stop_native_floquet_eps` (`:1330`, wywołanie `:8188`) — dodanie testu stagnacji obok anulowania (`A3`),
    - `solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context` (`:7858-7905`, `:8185`, `:8585`, `:8950-8955`) — usunięcie nadmiarowych applies po `KSPSolve` i `capture_last_floquet_shifted_solve` (`:1492`) jako opt-in (`B5`, `B6`);
  - `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`:
    - `configure_gpu_solver_request` (`:2252-2260`) — zdjęcie `install_gpu_modal_ksp_convergence_test` z wewnętrznego `poisson_ksp` (`C3`),
    - `destroy_gpu_solver_state` (`:1367`, wywołanie `:4097`) i `create_hypre_shift_preconditioner_cuda` (`:422-477`) — trwała masa split i aktualizacja `A+σB` in-place zamiast pełnego rebuilda (`C5`),
    - postprocessing `apply_schur` (`:4458-4459`, `:4691-4693`) — jeden `apply_schur` z wyjściem `phi_output` (`C7`),
    - opcjonalny test A/B `HYPRE_BoomerAMGSetCycleRelaxType(..., 18, 3)` (wzór: `hypre_device_solver.cpp:103`) z pomiarem CUPTI (`C4`).
- **Protokół pomiaru A/B:**
  - Headless CLI (sekcja 3) na modelach M2 (`512 < split ≤ 8192`) i M3 (`split > 8192`) dla `nearest` i `frequency_window` (K0 CPU, Floquet $k \neq 0$ CPU, K0 GPU).
  - Porównanie parami `baseline (origin/master)` vs `Etap 3` na identycznej siatce i równowadze.
- **Kryterium akceptacji:**
  - **Zgodność fizyczna i certyfikacji:** dla każdego zaakceptowanego modu $|\Delta f| / \max(|f|, 1\,\mathrm{Hz}) \le 10^{-7}$ (oraz identyczna liczba unikalnych modów w oknie bez utraty guard modes), wszystkie mody przechodzą niezmienioną bramkę `modal_original_unscaled_full_descriptor_backward_error ≤ residual_tolerance` (domyślnie `1e-10` z `poisson_airbox_modal_eigen.hpp:74` lub `1e-8` wg kontraktu studium).
  - **Próg przyspieszenia:**
    - na oknach K0/Floquet z dotychczasowymi `slepc_diverged`: skrócenie całkowitego `eps_solve_seconds` okna o **$\ge 2{,}0\times$**;
    - na M2 (`512 < split ≤ 8192`, `nearest`) przed aktywacją A1: skrócenie `exact_preconditioner.construction_seconds` + `shifted_setup_seconds` o **$\ge 3{,}0\times$** (dla `B2`);
    - na Floquet retry/oknach (`B4` + `B5`): spadek `poisson_solve_count` o **$\ge 20\%$** i skrócenie czasu faktoryzacji PC o **$\ge 20\%$**;
    - na GPU K0 (`C3` + `C5` + `C7`): skrócenie czasu okna o **$\ge 1{,}5\times$** bez wzrostu `poisson_iteration_count` i bez fallbacku CPU.

---

### Etap 4: A1 dla Floquet $k \neq 0$, trwały EPS / warm-start (`A5`) i wielowątkowość CPU (16–40 rdzeni)

- **Cel:** przenieść wzorzec dokładnego shift-invert przez układ rozszerzony $K_\tau$ z CPU K0 na Floquet $k \neq 0$, wyeliminować zbędne faktoryzacje i starty Krylova od zera oraz udostępnić skalowanie na 16–40 rdzeni (OpenBLAS pthreads + równoległe podokna + `eigen_k_worker`).
- **Kryterium wejścia:**
  1. Zakończenie i scalenie brancha A1 CPU K0 (`codex/eigensolve-a1-augmented-shift-20261118`) wraz z pomiarem A/B (`FULLMAG_K0_AUGMENTED_SHIFT=0/1`) potwierdzającym spadek `shift_linear_iteration_count` do 1–2 i brak regresji residuali.
  2. Zwalidowana nota naukowa w `docs/physics/0830-fem-poisson-airbox-modal-eigen.md` oraz `docs/physics/0828-fem-frequency-domain-floquet-demag.md` dla rozszerzonego układu $K_\tau(k)$ i `EPSSetInitialSpace`.
  3. Zweryfikowanie flagi konfiguracji OpenBLAS (`./configure --help` w PETSc `v3.24.6`) przed zmianą `docker/fem-gpu/Dockerfile:283`.
- **Zakres plików:**
  - `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` (`create_native_floquet_shifted_preconditioner:1805`, `solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context:7453`, retry `:9459`) — `PCSHELL` z MUMPS/METIS dla zespolonego/real-split $K_\tau(k)$ z zachowaniem niezmienionej normalizacji `normalize_native_floquet_pencil`, trwały `EPS` + `EPSSetInitialSpace` z wektorów poprzedniego przesunięcia lub poprzedniego punktu $k$ (`A1` Floquet + `A5`);
  - `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` (`solve_poisson_airbox_modal_eigen_cpu_schur:3944-5800`, `configure_production_refinement_ksp:3001`) — trwały `EPS` między retry/podoknami, `EPSSetInitialSpace`, współdzielenie faktoryzacji ST z refinementem, opcjonalne równoległe podokna w osobnych procesach z deterministyczną deduplikacją (`A5`);
  - `docker/fem-gpu/Dockerfile:283,290-339` oraz `docker/fem-cpu/Dockerfile:129-130` — OpenBLAS z wątkami (zweryfikowana flaga `--download-openblas-use-pthreads`) i ujednolicenie BLAS w `fem-cpu`;
  - `crates/fullmag-api/src/accepted_study_supervisor.rs:1874-1958` (`build_worker_thread_environment`) oraz `crates/fullmag-runner/src/fem/eigen_k_worker.rs:764-785` (`worker_thread_environment`) — jawny, bezkonfliktowy podział budżetu `OMP_NUM_THREADS` / `OPENBLAS_NUM_THREADS` / `RAYON_NUM_THREADS` (sekcja 4).
- **Protokół pomiaru A/B:**
  - Floquet $k \neq 0$: przełącznik A/B `FULLMAG_FLOQUET_AUGMENTED_SHIFT=0/1` na siatce `split > 512` (DE/BV, np. $\pm 10, \pm 25\,\mathrm{rad/\mu m}$, 15 punktów $k$).
  - Wielowątkowość: seria `OPENBLAS_NUM_THREADS ∈ {1, 4, 8, 16}` dla pojedynczego solve'a M3 (`split > 8192`) oraz macierz $(P \text{ procesów} \times T \text{ wątków}) \le 16$ / $40$ dla ścieżki 15 punktów $k$ i dla okna 16 podokien.
- **Kryterium akceptacji:**
  - **Parytet numeryczny:** $|\Delta f| / \max(|f|, 1\,\mathrm{Hz}) \le 10^{-8}$ między `AUGMENTED_SHIFT=0` i `1` oraz między trybem `serial` a wieloprocesowym (`adaptive`/równoległe podokna); wszystkie zaakceptowane mody spełniają pełne residuum oryginalnego deskryptora $\le \text{residual\_tolerance}$, bez wzrostu `full_residual_rejected_count`.
  - **Próg przyspieszenia:**
    - Floquet $k \neq 0$ (`split > 512`): redukcja `shift_linear_iteration_count` do $\le 3$ na krok Arnoldiego oraz skrócenie `eps_solve_seconds` o **$\ge 5{,}0\times$** względem `magnetic_shift_preconditioner` bez demagu;
    - wielowątkowość OpenBLAS na pojedynczym M3 (`split > 8192`, 8 wątków vs 1 wątek): skrócenie faktoryzacji MUMPS/BLAS3 o **$\ge 1{,}8\times$** (jeśli zysk $< 1{,}3\times$, zostawić `OPENBLAS_NUM_THREADS=1` i alokować wszystkie rdzenie w procesy);
    - wieloprocesowość na 15 punktach $k$ (8 workerów × 2 wątki vs 1 proces): skrócenie wall-clock o **$\ge 4{,}0\times$** przy mieszczącym się w budżecie szczytowym RSS.

---

### Etap 5: Odblokowanie `FemEigen` w runie zaakceptowanym (ADR 0084) + optymalizacje Rust/provenance i ścieżek $k$ (`A7`, `A8`, `D1–D15`)

- **Cel:** (a) umożliwić uruchamianie, pomiar i odczyt `FemEigen` z Control Room / API (zamykając Bloker #1), (b) usunąć wąskie gardła warstwy Rust i serializacji na ścieżkach dyspersji $k$ i `runner_operator`.
- **Kryterium wejścia:**
  1. Akceptacja [ADR 0084](../../adr/0084-accepted-fem-eigenmodes.md) i [accepted-fem-eigenmodes-v1.md](../../specs/accepted-fem-eigenmodes-v1.md).
  2. Dla `A7` i `A8`/`D1` (digest v2): zwalidowana nota w `docs/physics/0828-fem-frequency-domain-floquet-demag.md` i nowa wersja kontraktu digestu (bez modyfikacji wartości v1).
- **Zakres plików:**
  - **Część 5a — Accepted `FemEigen` (szczegóły w sekcji 8 specyfikacji `accepted-fem-eigenmodes-v1.md`):**
    - `crates/fullmag-plan/src/preparation.rs` (`from_fem_eigen_execution_plan_for_accepted_run`),
    - `crates/fullmag-runtime-control/src/study.rs` (`NativeFemPreparationKind::FemEigen`, materializacja i walidacja wejść),
    - `crates/fullmag-application/src/{study_artifact.rs,script_pipeline_acceptance.rs}` + nowy moduł kodeków `study_eigen_artifact.rs`,
    - `crates/fullmag-runner/src/{lib.rs,artifacts.rs,fem/eigen_equilibrium_contract.rs}`,
    - `crates/fullmag-api/src/{accepted_fem_preparer.rs,accepted_study_worker.rs,accepted_fem_study_worker.rs,live_accepted_execution.rs}` + nowy `accepted_fem_eigen_worker.rs`;
  - **Część 5b — Wydajność Rust/provenance i ścieżek $k$:**
    - `crates/fullmag-runner/src/fem/eigen_native_window.rs` (`CanonicalDigestBuilder::add_double_slice:2133-2156`) i `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` (`add_digest_matrix:1197-1213`) — binarny, strumieniowy digest v2 (`A8`, `D1`);
    - `crates/fullmag-runner/src/fem/eigen_nonshared_domain.rs:672,738-757,1074-1150` — preimage binarny, sidecar siatki raz na ścieżkę (`D2`);
    - `crates/fullmag-runner/src/fem/eigen_operator.rs:131-176` — montaż bezpośrednio do CSR/COO (`D3`);
    - `crates/fullmag-runner/src/fem/{eigen_equilibrium.rs:403,eigen_shared_domain.rs:296,eigen_path.rs:1173}` + `backends/fem/src/frequency_domain/modal_eigen_solver.cpp:2297,2394,2538` + `floquet_bloch_scalar.cpp:61` — `EigenPathContext` raz na ścieżkę oraz natywny cache części niezależnej od $k$ + kombinacja fazowa $\Delta t$ (`A7`, `D4`);
    - `crates/fullmag-runner/src/fem/{eigen_path_artifacts.rs:134,4512,eigen_output.rs:66,1710,single_k_checkpoint.rs:284,400,808}` — typowany `ModeRecord`, wektory binarnie (f64 LE), pojedyncza serializacja, kompaktowy checkpoint (`D5`, `D6`, `D9`, `D10`, `D14`);
    - `crates/fullmag-runner/src/eigen/tracking.rs:253-281,1217` — prekalkulacja $M_c v$ raz na mod (`D7`);
    - `crates/fullmag-ir/src/parallel_execution.rs:82` + `crates/fullmag-runner/src/fem/{eigen_k_pool.rs:280-375,eigen_k_worker.rs:764-794}` — batchowanie punktów $k$ per worker i cache hasha binarki/równowagi (`D8`);
    - `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs:1356,2085,2354` + `crates/fullmag-session/src/frequency_domain_artifact_generation.rs:345-352` — cache `(generation_id, path)`, `spawn_blocking`, ETag/304 i DTO mode summary bez wektorów (`D15`, `E3`).
- **Protokół pomiaru A/B:**
  - Ścieżka 15–50 punktów $k$ z rozbiciem fazowym: czas assembly native, czas równowagi/demagu w Rust, czas digestu, czas solve, czas publikacji artefaktów, czas trackingu oraz szczytowy RSS procesu runnera i workerów.
  - Dla 5a: pełny przepływ E2E accepted `Relax → FemEigen` (oraz `Provided` z certyfikowanym artefaktem) w grupie DEV.
- **Kryterium akceptacji:**
  - Identyczne częstotliwości ($|\Delta f|/\max(|f|, 1\,\mathrm{Hz}) \le 10^{-12}$ dla czystych refaktorów Rust `D4–D10,D15` oraz $\le 10^{-9}$ dla `A7/D3`), identyczne przypisanie gałęzi w `track_branches` (overlap zgodny do $10^{-12}$), pełne przejście walidacji CAS/manifestów `study_output_manifest` i `frequency_domain_artifact_generation.v2`.
  - **Próg przyspieszenia:**
    - `A7` + `D4`: redukcja łącznego czasu przygotowania i montażu per $k$ (poza pierwszym $k$) o **$\ge 3{,}0\times$** na ścieżce $\ge 15$ punktów $k$;
    - `D1`–`D3` na modelu `runner_operator` z $N \ge 2000$: redukcja szczytowego RSS o **$\ge 5{,}0\times$** i czasu digestu o **$\ge 10\times$**;
    - `D7`: skrócenie fazy trackingu przy $K \ge 20, M \ge 20$ o **$\ge 10\times$**;
    - `D5`–`D6` + `D15`: zmniejszenie rozmiaru JSON pojedynczego modu o **$\ge 10\times$** (usunięcie gęstych wektorów z JSON na rzecz binarnego data plane) i czas odpowiedzi API dla ponownego odczytu `304 Not Modified` $< 5\,\mathrm{ms}$.

---

### Etap 6: Inercja KKT / spectrum slicing (`A6`) oraz opcjonalny lane zespolony (`A4`)

- **Cel:** zastąpić ślepy harmonogram 16+34 podokien deterministycznym zliczaniem modów przez inercję i `EPSSetInterval`, a następnie zredukować wymiar zadania i krotność klas $J$ przez zespolony `PETSC_ARCH` (`--with-scalar-type=complex`).
- **Kryterium wejścia:**
  1. Działające A1 na CPU (K0 i Floquet) z MUMPS.
  2. Udokumentowany eksperyment numeryczny weryfikujący na $\ge 3$ modelach referencyjnych (z polem i bez — mody Goldstone'a): symetrię $A_{qq}$ i $A_{q\phi} = -\mu_0 A_{\phi q}^T$, dokładność relacji Haynswortha $\mathrm{In}(K(\sigma)) = \mathrm{In}(P) + \mathrm{In}(L_{\mathrm{eff}} - \sigma B_{\mathrm{rot}})$ oraz zgodność `MatGetInertia` z wyrocznią pełnego widma.
  3. Zwalidowana nota w `docs/physics/0830-fem-poisson-airbox-modal-eigen.md` + `0831` + osobny ADR dla nowego `count_certificate` i drugiego `PETSC_ARCH` complex.
- **Zakres plików:**
  - `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` (`:4001-5800`, `count_certificate` `:5003,5700`), `production_cpu_modal_eigen.cpp:4693`, `modal/floquet_modal_solver.cpp` (`:1300,7506`) — implementacja `MatGetInertia` na symetrycznym nieokreślonym $K(\sigma)$, dynamiczne podokna z `EPSSetInterval`, a w podetapie `A4`: ścieżka `PETSC_USE_COMPLEX` z osobnym `PETSC_ARCH=arch-linux-cpu-complex` w `docker/fem-gpu/Dockerfile`.
- **Protokół pomiaru A/B:**
  - Porównanie pełnego okna częstotliwości `[f_min, f_max]` (np. 1–20 GHz na M2 i M3): `16+34 podokna` vs `A6 (inercja + slicing)` oraz `real-split` vs `complex PETSC_ARCH`.
- **Kryterium akceptacji:**
  - **Kompletność i dokładność:** zbiór częstotliwości w oknie identyczny z referencją (0 pominiętych modów, 0 fałszywych modów, $|\Delta f|/\max(|f|, 1\,\mathrm{Hz}) \le 10^{-8}$), wszystkie residua pełnego deskryptora $\le \text{residual\_tolerance}$, `count_certificate.status == "certified"` z jawną metodą `haynsworth_mumps_ldlt` (lub jawny fallback do harmonogramu przy niespełnieniu założeń symetrii/dodatniości, bez fałszywego certyfikatu).
  - **Próg przyspieszenia:**
    - `A6`: spadek liczby faktoryzacji shift-invert w oknie o **$\ge 2{,}0\times$** (odpada przebieg 34 podokien refinement) i wall-clock okna o **$\ge 2{,}0\times$**;
    - `A4`: skrócenie `eps_solve_seconds` i szczytowego RSS faktoryzacji o **$\ge 1{,}8\times$** na modelach M3 (`split > 8192`).

---

### Etap 7: Analog A1 na GPU (cuDSS `PCSHELL` / FGMRES blokowo-trójkątny), weryfikacja C14 i telemetria CUPTI (`A1 GPU`, `C1–C2`, `C6`, `C8–C11`, `C14`)

- **Cel:** zbudować skalowalną, w pełni device-resident ścieżkę modalną GPU dla K0 (a następnie jednego rdzenia dla K0 i Floquet $k \neq 0$), bez cichego fallbacku CPU i z twardym dowodem CUPTI.
- **Kryterium wejścia:**
  1. Potwierdzenie w źródłach przypiętego `PETSC_REF=v3.24.6` (`1467453aedb62826efc970ceafc4bd6dab8229ab`) braku natywnego `MATSOLVERCUDSS` (szczegóły w sekcji 5) oraz decyzja o wpięciu redystrybucji `libcudss` (CUDA 12.x) w `docker/fem-gpu/Dockerfile`.
  2. Numeryczny pomiar warunku `C14` ($\|S - S^T\| / \|S\|$ oraz najmniejsza wartość własna $S$ na 3 modelach referencyjnych, w tym z polem i bez).
  3. Zwalidowana nota w `docs/physics/0830-fem-poisson-airbox-modal-eigen.md` + `0831` opisująca realizację FEM GPU z cuDSS oraz/lub GHEP LOBPCG.
- **Zakres plików:**
  - `docker/fem-gpu/Dockerfile` (izolowana instalacja `libcudss` na wzór CUPTI `:493-528` z zapisem hashy w `dependency-versions.json`);
  - `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp` (`apply_schur:969`, `create_hypre_shift_preconditioner_cuda:422`, `configure_gpu_solver_request:2201`, `per_iteration_transfer_telemetry_measured:2672`) + nowy moduł `backends/fem/gpu/cuda/frequency_domain/modal_cudss_shift_solver.cu/.hpp` (nie modyfikować martwego `modal_krylov.cu` ani gęstego `eigensolver_gpu.cu`);
  - `backends/fem/gpu/cuda/runtime/cuda_activity_trace.cpp` (podpięcie CUPTI do pomiaru H2D/D2H i liczby synchronizacji w pętli modalnej — `C11`);
  - `backends/fem/src/frequency_domain/modal_eigen_solver.cpp:2520` (późniejsze odblokowanie Floquet GPU dopiero po osobnym dowodzie parytetu, bez cichego fallbacku);
  - `backends/fem/tests/frequency_domain/gpu_k0_modal_petsc_slepc_test.cpp` (bramka skali z realnym 3D airboxem `phi_dof > 1`, zamiast obecnego `phi_dof = 1` — `C11`).
- **Protokół pomiaru A/B:**
  - Ten sam zestaw modeli M2 i M3 na GPU (`FULLMAG_K0_PRODUCTION_DEVICE=gpu`): baseline `BoomerAMG-Schur` vs `cuDSS PCSHELL` (przełącznik A/B `FULLMAG_GPU_MODAL_AUGMENTED_CUDSS=0/1`) + porównanie parytetu z CPU K0 A1.
  - Dodatkowo profil CUPTI: `per_iteration_h2d_transfer_count`, `per_iteration_d2h_transfer_count`, bajty H2D/D2H, szczytowy VRAM (`nvidia-smi` / CUDA memory pool stats).
- **Kryterium akceptacji:**
  - **Parytet CPU↔GPU i rezydencja:** $|\Delta f_{\mathrm{GPU-CPU}}| / \max(|f_{\mathrm{CPU}}|, 1\,\mathrm{Hz}) \le 10^{-8}$, wszystkie residua oryginalnego deskryptora (liczone w FP64) $\le \text{residual\_tolerance}$, `fallback_used == false`, `per_iteration_transfer_telemetry_measured == true` z zerowymi transferami pełnych wektorów w hot-loop.
  - **Próg przyspieszenia:**
    - na M3 (`split > 8192`) na RTX 4080 SUPER (SM 89): **$\ge 10\times$** przyspieszenia `eps_solve_seconds` względem obecnego GPU baseline (`modal_petsc_slepc.cpp` z 3-poziomowym EPS→GMRES→CG+AMG) ORAZ **$\ge 2{,}0\times$** szybciej niż CPU MUMPS A1 (lub jawny pomiar progu crossoveru rozmiarowego, poniżej którego CPU jest szybsze — bez ukrywania wyniku).

---

### Etap 8: Optymalizacja warstwy Control Room podczas animacji fazy i pracy z dużymi widmami (`E1`, `E2`, `E3–E4`, `E6–E12`)

- **Cel:** wyeliminować przebudowywanie drzewa Reacta i realokację ~50 MB/klatkę w WebGL podczas animacji fazy modu oraz odciążyć transfer JSON.
- **Kryterium wejścia:** niezależne od backendu numerycznego (można realizować równolegle z Etapami 4–6); dla `E3` wymagana spójność DTO z `D15` (Etap 5b).
- **Zakres plików:**
  - `apps/control-room/src/kernel/visualization/AnalysisFieldOverlayPhaseAnimation.ts:66,89,185,198` i `AnalysisFieldOverlayController.ts:71,223-234,291,455` — wydzielenie zegara fazy poza snapshot Reacta (wzorzec `ModeCompositionPhaseClock` z `useViewport3DSceneModel.ts:148,3273`) i throttling suwaka do $\le 10\,\mathrm{Hz}$ (`E1`);
  - `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:4922-4948`, `viewport3dRenderModel.ts:781-846,1080-1131,1826`, `useViewport3DScalarColorUpload.ts:135-152`, `viewport3DDerivedWorkPlan.ts:50-100` — usunięcie `visualizationPhaseRad` z `primaryFieldRenderOptions` i kluczy cache buforów, pozostawienie fazy wyłącznie jako uniformu `complexPhaseRad` w `useFrame` (przy zachowaniu odczytu statycznej fazy przez `export3dVtkSerializer.ts:491`) (`E2`);
  - `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx` + `modeCompositionViewportProjection.ts` (`E10`), `ExplorerModule.tsx` (`E4`), `FrequencyDomainCharts.tsx` (`E6`), listy niezwirtualizowane (`E7`).
- **Protokół pomiaru A/B:**
  - Profil Chrome DevTools (Performance + React Profiler) podczas 10-sekundowej animacji fazy na załadowanym modzie FEM (siatka $\ge 100\text{k}$ węzłów, docelowo $1\text{M}$ węzłów) w kontenerze DEV.
- **Kryterium akceptacji:**
  - Zgodnie z `AGENTS.md:82`: dowód z przeglądarki (widoczny canvas, niezagubiony kontekst WebGL, niezerowy drawing buffer, wizualnie poprawna rotacja fazy i poprawny eksport statycznej klatki).
  - **Próg przyspieszenia / zasobów:** **0** re-renderów `ExplorerModule` / `RibbonModule` / `useViewport3DSceneModel` podczas ciągłej animacji fazy (`E1`), **0** alokacji `Float64Array`/`Float32Array` i **0** re-uploadów atrybutów buforów geometrii między klatkami animacji (`E2`), czas klatki P95 $< 16{,}7\,\mathrm{ms}$ (60 fps) na modelu referencyjnym.

---

## 3. Protokół pomiaru wydajności

### 3.1. Ścieżka uruchomienia (do czasu wdrożenia ADR 0084)

Do czasu wdrożenia wykonania `FemEigen` w runie zaakceptowanym (Etap 5a), jedyną działającą ścieżką pomiaru eigensolve jest **lokalny orkiestrator CLI w trybie headless bez API**, uruchamiany wewnątrz działającego kontenera `backend` właściwej grupy Docker Compose DEV (np. `fullmag-worktree-<id>`):

```bash
env -u FULLMAG_API_PORT \
  /usr/bin/time -v \
  /opt/fullmag/package/bin/fullmag-bin \
  <skrypt.py> \
  --backend fem \
  --headless \
  --json \
  --output-dir <katalog_wynikowy_na_ext4>
```

**Uwagi środowiskowe:**
- `env -u FULLMAG_API_PORT` wymusza lokalny orkiestrator CLI bez próby połączenia z API DEV.
- Dla uniknięcia wąskiego gardła 9p/Windows katalog `<katalog_wynikowy_na_ext4>` musi leżeć na lokalnym systemie plików Linux/ext4 (zgodnie z `AGENTS.md:56-63`).
- Skrypt wzorcowy to `examples/fem_eigen_k0_poisson_airbox_production.py` z **PR #452** (`origin/codex/k0-airbox-geometric-grading-20261118`), gdzie linia 48 ustawia `grading="geometric"` (na `origin/master:46` jest nadal `grading="linear"`, odrzucane w `_gmsh_swept.py:235` przed uruchomieniem solvera).
- Dla weryfikacji ponownego użycia kontekstu operatora w tym samym procesie skrypt udostępnia flagę `FULLMAG_K0_PERFORMANCE_REPEAT=1` (`examples/fem_eigen_k0_poisson_airbox_production.py:113-114`).

### 3.2. Modele testowe w trzech reżimach wymiaru real-split

Wymiar operatora real-split spełnia `split_dof_count = 2 * q_dof_count = 4 * N_mag_uniq`, gdzie $N_{\mathrm{mag,uniq}}$ to liczba unikalnych węzłów magnetycznych po redukcji periodycznej w osiach $x, y$. Ze względu na lokalne zagęszczanie krawędzi w `body.mesh.thin_film(...)` (`examples/fem_eigen_k0_poisson_airbox_production.py:63-73`), **o przynależności modelu do reżimu decyduje zawsze zmierzona wartość `split_dof_count` (oraz `slepc.pc_matrix`) z `solver.v1.json`**, a poniższe nastawy `FULLMAG_K0_PRODUCTION_*` stanowią punkty startowe **[H — szacunek]**:

| Model | Docelowy reżim `split_dof_count` | Co uruchamia w `origin/master` (`poisson_airbox_schur_matshell.cpp`) | Sugerowane nastawy startowe `FULLMAG_K0_PRODUCTION_*` **[H — do kalibracji po 1. uruchomieniu]** | Rola w benchmarku |
|---|---|---|---|---|
| **M1 (mały / validation)** | `< 512` (oraz $\le 1024$ = `validation_only` wg noty `0830:540`) | `nearest` **i** `window` materializują dokładny PC (`exact_shifted_schur_action`, progi `:2620` i `:2752`) | Domyślne z przykładu (`BODY_X_NM=40`, `BODY_Y_NM=20`, `BODY_Z_NM=10`, `MAG_HMAX_NM=20`, `MAG_HMIN_NM=10`, `AIRBOX_HMAX_NM=40`, `AIRBOX_FACTOR=5.0`) | Wyłącznie regresja algebry, znaków i parytetu z gęstą wyrocznią; **nie jest dowodem ścieżki produkcyjnej** |
| **M2 (pośredni / strefa B2)** | `512 < split ≤ 8192` (wymagane `> 1024` dla zakresu produkcyjnego) | `nearest` uruchamia drogą gęstą materializację w SeqAIJ (`exact_shifted_schur_action`, B2); `frequency_window` przekracza `512` i wchodzi w rzadki `magnetic_shift_preconditioner` bez demagu | `BODY_X_NM=200`, `BODY_Y_NM=200`, `BODY_Z_NM=10`, `MAG_HMAX_NM=10`, `MAG_HMIN_NM=10`, `AIRBOX_HMAX_NM=40`, `AIRBOX_FACTOR=5.0` (szac. $N_{\mathrm{mag,uniq}} \approx 800\text{–}1200 \Rightarrow \text{split} \approx 3200\text{–}4800$) | Izolacja problemu B2 (`nearest`) oraz szybkiego benchmarku okna bez demagu (`window`) i parytetu CPU↔GPU |
| **M3 (produkcyjny)** | `> 8192` (cel: ~10k–16k dla szybkich pętli A/B oraz ~32k–50k dla testu skalowania) | Zarówno `nearest`, jak i `frequency_window` pomijają gęstą materializację i uruchamiają produkcyjny `magnetic_shift_preconditioner` (lub `PCSHELL` z $K_\tau$ w A1) | M3a: `BODY_X_NM=360`, `BODY_Y_NM=360`, `BODY_Z_NM=10`, `MAG_HMAX_NM=10`, `MAG_HMIN_NM=10`, `AIRBOX_HMAX_NM=40`, `AIRBOX_FACTOR=5.0` (szac. $\text{split} \approx 10\text{k–}14\text{k}$); M3b: `BODY_X_NM=640`, `BODY_Y_NM=640` (szac. $\text{split} \approx 32\text{k–}48\text{k}$) | **Główna bramka wydajnościowa** dla A1 (CPU/GPU), A3, A4, A5, A6 oraz wielowątkowości |

Dodatkowo dla ścieżek **Floquet $k \neq 0$** (Etapy 3–6) należy utrzymywać stały przypadek referencyjny DE/BV powyżej `kFloquetExactSchurPreconditionerMaxDimension = 512` (`floquet_modal_solver.cpp:1298`), np. 15 podpisanych punktów $k_y \in [-25, +25]\,\mathrm{rad/\mu m}$ na filmie z airboxem `grading="geometric"` (por. nota `0830:170-248`).

### 3.3. Zbierane metryki i ich dokładne źródła

Wszystkie pola diagnostyczne K0 trafiają do `<output_dir>/eigen/diagnostics/solver.v1.json` (zapisywanego w `crates/fullmag-runner/src/fem/eigen_native_artifacts.rs:1235-1238` z payloadu emitowanego przez `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp:3430-3650`):

| Metryka | Dokładne pole w `eigen/diagnostics/solver.v1.json` (lub źródło OS) | Co weryfikuje |
|---|---|---|
| Rodzaj preconditionera shift-invert | `slepc.pc_matrix` (`:3477`, z pola C++ `result.shifted_preconditioner_kind` w `:3615-3617`; na `origin/master`: `"exact_shifted_schur_action"` lub `"magnetic_shift_preconditioner"`) | Potwierdza, która ścieżka (A vs B) realnie się wykonała |
| Pakiet faktoryzacji Poissona | `poisson_factorization_package` (`:3459`, z `kModalPoissonLuPackage` w `modal_poisson_lu.hpp:23-29`) | Potwierdza użycie `mumps_lu_metis` zamiast `petsc_default_lu` |
| Wymiar operatora | `q_dof_count`, `split_dof_count`, `phi_dof_count`, `augmented_dof_count` (`:3498-3499`) | Kwalifikacja do reżimu `<512`, `512..8192`, `>8192` i `>1024` |
| Czas solve EPS | `exact_preconditioner.eps_solve_seconds` (`:3439`), `exact_preconditioner.shifted_setup_seconds` (`:3439`), `exact_preconditioner.construction_seconds` (`:3438`) | Izoluje koszt faktoryzacji/setupu od kosztu iteracji EPS |
| Liczba rozwiązań Poissona | `poisson_solve_count` (`:3479`), `operator_apply_count` (`:3479`), `exact_preconditioner.construction_poisson_solve_count` (`:3437`) | Bezpośrednia miara kosztu Schura (w A1 powinno spaść do rzędu liczby rekonstrukcji/weryfikacji) |
| Iteracje wewnętrznego GMRES | `shift_linear_iteration_count` (`:3480`), `refinement_linear_iteration_count` (`:3496`) | Skuteczność preconditionera (cel A1: 1–2 iteracje na krok) |
| Iteracje zewnętrzne EPS | `slepc.outer_iterations` (`:3478`), `slepc_converged_reason` (`:3547`), oraz per-podokno w `subwindows[]` (`:3535`) | Wykrywa stagnację i `EPS_DIVERGED_ITS` (A3, A6) |
| Zbieżność i residuum pełnego deskryptora | `eigenpair.frequency_hz` (`:3529`), `residual_fields.modal_original_unscaled_full_descriptor_backward_error` (`:3512`), `residual_fields.modal_original_unscaled_full_descriptor_threshold` (`:3519`), `certification.full_residual_certified` (`:3531`) | Niezależna bramka poprawności fizycznej i numerycznej |
| Czas ścienny (wall-clock) | wyjście `/usr/bin/time -v` (`Elapsed (wall clock) time`) oraz znaczniki JSON CLI | Całkowity czas end-to-end (w tym siatka, relaksacja, assembly, IO) |
| Szczytowy RSS (RAM) | wyjście `/usr/bin/time -v` (`Maximum resident set size (kbytes)`) | Kontrola wzrostu pamięci przy MUMPS na $K_\tau$, równoległych procesach i ścieżkach Rust |
| Telemetria GPU (dla lane GPU) | `per_iteration_h2d_transfer_count`, `per_iteration_d2h_transfer_count`, `per_iteration_transfer_telemetry_measured` (`modal_petsc_slepc.cpp:2672`), `fallback_used`, plus log CUPTI i szczytowy VRAM | Potwierdzenie rezydencji na GPU i braku fallbacku CPU |

### 3.4. Procedura porównania A/B

1. **Identyczne wejście:** obie próby A (baseline, np. `FULLMAG_K0_AUGMENTED_SHIFT=0`) i B (kandydat, np. `FULLMAG_K0_AUGMENTED_SHIFT=1`) muszą uruchamiać ten sam commit binarki (lub parę przypiętych SHA), tę samą siatkę (identyczny `topology_fingerprint`), ten sam plik/stan równowagi i identyczne przypięcie zasobów (`FULLMAG_DEV_BACKEND_CPUS`, `OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS`, ta sama karta GPU).
2. **Powtórzenia:** minimum **1 bieg rozgrzewkowy** (pominięty w statystyce jeśli w grę wchodzi cache JIT/bibliotek, lecz z zapisanym cold-startem osobno) oraz **3 powtórzenia mierzone** dla M1/M2/M3a (raportujemy medianę oraz min–max; dla długich biegów M3b dopuszczalne 1–2 powtórzenia z jawnym odnotowaniem).
3. **Kontrola poprawności przed oceną przyspieszenia:** jeśli próba B ma wyższy błąd częstotliwości niż próg etapu, odrzucony mod, `full_residual_certified != true`, inny status kompletności okna lub niejawny fallback (`fallback_used == true`), wynik **odrzucamy niezależnie od przyspieszenia**.
4. **Archiwizacja dowodu:** dla każdego porównania A/B zapisujemy na ext4 (nigdy wyłącznie wewnątrz kontenera Docker, zgodnie z `AGENTS.md:56-59`) pełny `solver.v1.json`, `spectrum.v2.json`, surowe wyjście `/usr/bin/time -v`, pełne SHA commita oraz użyte zmienne środowiskowe.

---

## 4. Plan wielowątkowości (`A5`) dla maszyn 16–40 rdzeni

Na hoście 40-rdzeniowym (w `.env` grupy DEV: `FULLMAG_DEV_BACKEND_CPUS=16`, audyt I:474) obecny solver CPU wykorzystuje praktycznie **1 rdzeń** podczas fazy EPS/LU/MUMPS. Poniżej przedstawiono cztery uzupełniające się mechanizmy skalowania oraz trzy twarde konflikty z bieżącą architekturą Fullmag.

### 4.1. Cztery osie wykorzystania 16–40 rdzeni

1. **Wielowątkowy OpenBLAS wewnątrz MUMPS i SLEPc (BV/DS):**
   - **Stan obecny w `origin/master`:** `docker/fem-gpu/Dockerfile:283` konfiguruje oba prefiksy PETSc flagą `--download-openblas` bez flagi włączającej wątki; `docker/fem-cpu/Dockerfile:129` nadal linkuje jednowątkowy systemowy `--with-blaslapack-lib="-llapack -lblas"`.
   - **Uwaga weryfikacyjna o nazwie flagi PETSc:** w prompcie wspomniano `--with-openblas-use-pthreads`, natomiast system budowania PETSc (`config/BuildSystem/config/packages/OpenBLAS.py`) historycznie używa nazwy **`--download-openblas-use-pthreads`** (w parze z `--download-openblas` i `--with-pthread=1`). **Kryterium wejścia przed edycją `Dockerfile`:** uruchomić `./configure --help | grep -i openblas` na przypiętym `PETSC_SOURCE_COMMIT=1467453aedb62826efc970ceafc4bd6dab8229ab` (`v3.24.6`) i użyć dokładnej flagi obsługiwanej przez ten commit, a następnie zweryfikować wynikowe `libopenblas.so` (obecność symboli `openblas_set_num_threads` oraz realnego przyspieszenia `dgemm` przy `OPENBLAS_NUM_THREADS=4,8`).
   - **Gdzie pomaga:** frontalna faktoryzacja supernodalna BLAS-3 (`dgemm`/`dtrsm`) wewnątrz MUMPS (zarówno dla $P$, jak i dla dużego $K_\tau$ w A1), ortogonalizacja BV i projektowany problem DS w SLEPc oraz gęste operacje LAPACK w B2.
   - **Praktyczny sufit [H]:** 4–8 wątków na pojedynczy proces MUMPS/SLEPc (powyżej 8 wątków dominuje przepustowość pamięci i narzut synchronizacji małych frontów 3D).

2. **Równoległe podokna częstotliwościowe (w osobnych procesach):**
   - Okno częstotliwości wykonuje dziś seryjnie 16 podokien bazowych + 34 refinement (`poisson_airbox_schur_matshell.cpp:4001-4174`, `production_cpu_modal_eigen.cpp:4693`).
   - Ponieważ PETSc/SLEPc nie są thread-safe (patrz konflikt 4.2.1), równoleglenie podokien **nie może używać wątków w tym samym procesie** — musi używać **puli osobnych procesów potomnych** (na wzór istniejącego `crates/fullmag-runner/src/eigen/k_process_pool.rs` i `fem/eigen_k_worker.rs`), gdzie każdy proces otrzymuje podzbiór przesunięć $\sigma_j$, wykonuje je niezależnie z własnym kontekstem PETSc/MUMPS i zwraca serializowane kandydaty do deterministycznego scalenia w kolejności indeksów podokien (zachowując regułę „first wins” z `poisson_airbox_schur_matshell.cpp:4904-4941`).
   - Dla pojedynczego $k$ z dużym oknem (np. 16 podokien po 1–2 shifty na proces): 4–8 procesów × 2–4 wątki OpenBLAS = 16–32 rdzenie.
   - **Koszt pamięci:** każdy proces powiela siatkę, operator i czynniki LU ($P \times \mathrm{RSS}_1$), dlatego regulator admission musi używać skalibrowanego envelope RSS (analogicznie do ADR 0034).

3. **`fem-eigen k-worker` dla ścieżek dyspersyjnych $k$ (ADR 0034):**
   - Mechanizm istnieje już w `crates/fullmag-runner/src/fem/eigen_k_pool.rs:280-375`, `fem/eigen_k_worker.rs:764-794` i `eigen/k_process_pool.rs`, ale:
     - domyślny tryb to `ParallelExecutionModeIR::Serial` (`crates/fullmag-ir/src/parallel_execution.rs:82`),
     - każdy punkt $k$ uruchamia osobny proces i od nowa montuje stan niezależny od $k$ oraz hashuje binarkę/równowagę (D8 + A7).
   - **Plan rozbudowy:** przejście na **batchowanie wielu punktów $k$ do jednego długowiecznego procesu `eigen_k_worker`** (łącząc się z A7: montaż części niezależnej od $k$ raz na start workera, następnie pętla po przypisanej partii $k$ z warm-startem `EPSSetInitialSpace` z poprzedniego $k$). Na 16–40 rdzeniach dla ścieżki 15–50 punktów $k$ daje to najlepsze wykorzystanie rdzeni przy najmniejszym narzucie komunikacji: np. `8 workerów × 2 wątki BLAS` (16 rdzeni) lub `10 workerów × 4 wątki BLAS` (40 rdzeni).

4. **MUMPS z OpenMP (ewentualnie, jako krok drugorzędny po OpenBLAS pthreads):**
   - Obecnie PETSc w `docker/fem-gpu/Dockerfile:290-335` jest budowany **bez `--with-openmp`**, więc MUMPS działa sekwencyjnie (jedynie wywołania BLAS-3 w jego wnętrzu mogą korzystać z wielowątkowego OpenBLAS).
   - Dodanie `--with-openmp` (i zweryfikowanego w `v3.24.6` `--download-mumps-openmp`) odblokowuje wielowątkowość drzewa eliminacji MUMPS (`ICNTL(16)` / `OMP_NUM_THREADS`), co ma sens wyłącznie dla **bardzo dużych pojedynczych układów** ($K_\tau$ z setkami tysięcy niewiadomych), gdy równoległość po $k$ lub podoknach nie wystarcza do nasycenia rdzeni.
   - **Krytyczna reguła przeciw oversubscription:** nigdy nie łączyć `OMP_NUM_THREADS = T` w MUMPS z `OPENBLAS_NUM_THREADS = T` (co daje $T^2$ wątków, ponieważ `OMP_MAX_ACTIVE_LEVELS=1` nie blokuje wątków POSIX OpenBLAS uruchamianych z regionu OpenMP!). Przy włączonym MUMPS OpenMP należy ustawiać `OPENBLAS_NUM_THREADS=1` (lub rozdzielać budżet tak, aby `OMP_NUM_THREADS * OPENBLAS_NUM_THREADS <= threads_per_worker`).

### 4.2. Konflikty z obecną architekturą (zweryfikowane w `origin/master`)

| Konflikt | Zweryfikowane źródło w `origin/master` | Mechanizm konfliktu | Rozwiązanie w roadmapie |
|---|---|---|---|
| **1. Globalny mutex PETSc/SLEPc** | `backends/fem/core/petsc_slepc_runtime.cpp:24-30` (`petsc_slepc_process_mutex`), `poisson_airbox_schur_matshell.cpp:3944,5818,7150`, `floquet_modal_solver.cpp:7244,7529`, ADR 0055 | Jedna nierekurencyjna blokada obejmuje cały czas życia operacji PETSc/SLEPc w procesie. Wielowątkowość Rust (Rayon) lub `std::thread` w tym samym procesie zostanie w 100% zserializowana na tym mutexie (a zagnieżdżone wywołanie grozi deadlockiem). | Równoległość podokien i punktów $k$ **wyłącznie przez izolowane procesy** (każdy proces ma własny runtime PETSc/SLEPc i własny mutex — zgodne z ADR 0055:17). Wewnątrz jednego procesu równoległość zapewniają wyłącznie wątki BLAS/OpenMP pod spodem pojedynczego wywołania MUMPS/SLEPc. |
| **2. Kwarantanna procesu (`petsc_runtime_unsafe`)** | `backends/fem/core/petsc_slepc_runtime.cpp:32-40,63-67` (`mark_petsc_slepc_process_unsafe_locked`, `petsc_slepc_process_is_unsafe_locked`), `poisson_airbox_modal_eigen.cpp:1521-1524`, ADR 0055:42-55 | Twardy błąd PETSc/SLEPc w jednym wywołaniu zatrzaskuje globalny latch na cały czas życia procesu i blokuje wszystkie kolejne solve'y kodem `petsc_runtime_unsafe`. Gdyby proces API lub pojedynczy worker wykonywał wiele zadań/podokien równolegle, awaria jednego podokna zatrułaby całą sesję. | Procesy `eigen_k_worker` i procesy podokien są jednorazowe lub recyklowane po wystąpieniu kwarantanny: rodzic wykrywa `petsc_runtime_unsafe`, oznacza ten jeden punkt/podokno jako nieudane (bez niejawnego retry na zatrutym procesie) i nie przerywa sąsiednich procesów. |
| **3. `RAYON_NUM_THREADS=1`, `OPENBLAS_NUM_THREADS=1` i iloczyn wątków w supervisorze** | `crates/fullmag-api/src/accepted_study_supervisor.rs:1865-1957` (`build_worker_thread_environment`), `accepted_fem_preparation_supervisor.rs:835-849`, oraz `crates/fullmag-runner/src/fem/eigen_k_worker.rs:764-785` (`worker_thread_environment`) | (a) W `accepted_study_supervisor.rs:1868` `BackendPlanIR::FemEigen(_)` ma `native_fem_lane = true`. Gdy `native_threads > 1` (domyślnie `allocated_cpu_threads`, `:1899`), supervisor **wymusza `RAYON_NUM_THREADS=1`** (`:1903-1904`) i **domyślnie `OPENBLAS_NUM_THREADS=1`** (`:1902,1947-1955`), a ponadto odrzuca konfigurację, gdy `native_threads * blas_threads > allocated_cpu_threads` (`:1911-1914`). Samo włączenie wątków w OpenBLAS nic więc nie da w runach zaakceptowanych, dopóki supervisor wysyła `OPENBLAS_NUM_THREADS=1`!<br>(b) Z kolei `eigen_k_worker.rs:764-784` ustawia **tę samą wartość `resolved_threads`** jednocześnie dla `OMP_NUM_THREADS`, `RAYON_NUM_THREADS` i `OPENBLAS_NUM_THREADS`, co przy równoczesnym OpenMP (MFEM/HYPRE/MUMPS) i OpenBLAS pthreads grozi oversubscription ($T \times T$). | Rozdzielić politykę wątków per rola: dla pojedynczego procesu `FemEigen` (bez MUMPS OpenMP) supervisor ustawia `OPENBLAS_NUM_THREADS = blas_threads` (np. 4–8) oraz `OMP_NUM_THREADS = max(1, allocated / blas_threads)` (lub serializuje fazy MFEM OpenMP vs MUMPS BLAS, bo w trakcie `EPSSolve` nie biegnie montaż MFEM, a w trakcie montażu nie biegnie MUMPS — mimo to twarda strażnica `native_threads * blas_threads <= allocated_cpu_threads` wymaga jawnego rozdzielenia pól lub fazowego budżetu). W `eigen_k_worker.rs` zastąpić jedną liczbę `resolved_threads` parą `(omp_threads, blas_threads)` spełniającą `workers * max(omp_threads, blas_threads) <= allocated_cpu_cores` i `omp_threads * blas_threads <= threads_per_worker` (lub `OPENBLAS_NUM_THREADS=1` gdy aktywny jest MUMPS OpenMP). Dla fazy trackingu D7 w procesie rodzica (`rayon`) nie może być wymuszone `RAYON_NUM_THREADS=1` jeśli rodzic sam nie uruchamia wtedy OpenMP. |

---

## 5. GPU: dostępność cuDSS w PETSc 3.24.6 i plan analogu A1 na GPU

### 5.1. Stan PETSc 3.24.6 i dostępność cuDSS

- **Przypięta wersja w repozytorium:** `docker/fem-gpu/Dockerfile:58,62` przypina `PETSC_REF=v3.24.6` (`PETSC_SOURCE_COMMIT=1467453aedb62826efc970ceafc4bd6dab8229ab`) oraz bazę `nvidia/cuda:12.4.1-devel-ubuntu20.04` (`:1`).
- **Wynik weryfikacji dokumentacji oficjalnej PETSc (stan dla serii 3.24):**
  - Oficjalna tabela solverów rzadkich PETSc ([Summary of Sparse Linear Solvers Available In PETSc](https://petsc.org/release/overview/linear_solve_table/)), referencja typów solverów ([MatSolverType](https://petsc.org/release/manualpages/Mat/MatSolverType/)) oraz opis zmian wydania ([Changes for Release 3.24](https://petsc.org/release/changes/324/)) **nie zawierają wbudowanego wrappera `MATSOLVERCUDSS` ani automatycznego instalatora `--download-cudss` dla NVIDIA cuDSS**.
  - Dostępne w PETSc 3.24.6 pakiety z akceleracją CUDA dla macierzy rzadkich to:
    - `MATSOLVERCUSPARSE` ([petsc.org](https://petsc.org/release/manualpages/Mat/MATSOLVERCUSPARSE/)) — operacje SpMV, trójkątne solve'y i `PCILU(0)`/`PCICC(0)` bez pełnej faktoryzacji LU z pivotowaniem (już używane w `modal_petsc_slepc.cpp:2184-2186` jedynie dla małej dokładnej ścieżki);
    - `MATSOLVERSUPERLU_DIST` ([petsc.org](https://petsc.org/release/manualpages/Mat/MATSOLVERSUPERLU_DIST/)) — rozproszony LU z offloadem GPU (statyczne pivotowanie, wyższy narzut na 1 GPU dla średnich układów);
    - `MATSOLVERSTRUMPACK` ([petsc.org](https://petsc.org/release/manualpages/Mat/MATSOLVERSTRUMPACK/)) — multifrontalny solver z offloadem GPU (`-mat_strumpack_gpu`) i opcjonalną kompresją BLR/HSS.
  - Sama biblioteka **NVIDIA cuDSS** ([NVIDIA cuDSS Documentation](https://docs.nvidia.com/cuda/cudss/)) jest oficjalnym następcą `cuSolverSp`/`cuSolverRf` dla układów rzadkich na GPU, dystrybuowanym dla CUDA 12.x jako archiwum redystrybucyjne Linux x86_64 (`libcudss-linux-x86_64-*_cuda12-archive.tar.xz`) z fazami `CUDSS_PHASE_ANALYSIS`, `CUDSS_PHASE_FACTORIZATION` / `CUDSS_PHASE_REFACTORIZATION`, `CUDSS_PHASE_SOLVE` (w tym tryb hybrydowej pamięci CPU+GPU oraz `cudssMatrixCreateBatchCsr` dla wielu układów o wspólnym wzorcu).
  - **Zastrzeżenie dowodowe:** niniejsza weryfikacja opiera się na oficjalnej dokumentacji online PETSc i NVIDIA; w tym zadaniu nie rozpakowywano ani nie uruchamiano obrazu Docker zawierającego `/tmp/build/petsc`. Jako pierwszy krok techniczny Etapu 7 należy wykonać 1-komendową kontrolę w drzewie źródeł `v3.24.6` (`git ls-tree -r 1467453aedb62826efc970ceafc4bd6dab8229ab -- config/BuildSystem/config/packages/ include/petscmat.h` pod kątem `cudss`).

### 5.2. Plan analogu A1 na GPU (bez przebudowywania PETSc)

Brak `MATSOLVERCUDSS` w PETSc 3.24.6 **nie blokuje** wdrożenia analogu A1 na GPU — przeciwnie, upraszcza jego integrację, ponieważ:

1. **Architektura `PCSHELL` + bezpośrednie API `cudss.h` (ścieżka rekomendowana):**
   - Analogicznie do CPU A1 (gdzie `PCSHELL` owija faktoryzację MUMPS układu rozszerzonego $K_\tau$), w `backends/fem/gpu/cuda/frequency_domain/modal_cudss_shift_solver.cu` implementujemy **`PCSHELL` dla `st_ksp`**, który wywołuje bezpośrednio C API NVIDIA cuDSS na macierzy $K_\tau$ złożonej na GPU w formacie CSR (`MATSEQAIJCUSPARSE` lub natywny bufor device CSR).
   - **Zero przebudowy PETSc:** `libcudss` instalujemy w `docker/fem-gpu/Dockerfile` jako izolowaną redystrybucję w `/opt/fullmag-cudss/<wersja>` z weryfikacją `sha256sum` i wpisem w `dependency-versions.json` — dokładnie według istniejącego wzorca CUPTI w `docker/fem-gpu/Dockerfile:493-528`. Warstwa PETSc CUDA (8,6 min) i MFEM CUDA (12 min) pozostają nietknięte.
   - **Cykl życia w oknie / sweepie (stały wzorzec rzadkości):**
     1. Złożenie stałego wzorca CSR układu rozszerzonego $K_\tau = \begin{bmatrix} A_{qq} - \tau B_{qq} & A_{q\phi} \\ A_{\phi q} & P \end{bmatrix}$ na urządzeniu (przez `COO→CSR` z unią wzorców $A_{qq} \cup B_{qq}$).
     2. Jednorazowa faza `CUDSS_PHASE_ANALYSIS` dla całego okna częstotliwości (i całej ścieżki $k$, gdy wzorzec jest stały).
     3. Dla każdego przesunięcia $\tau$: aktualizacja wartości `values[]` kernelem CUDA (bez alokacji i bez H2D) + `CUDSS_PHASE_FACTORIZATION` (lub `CUDSS_PHASE_REFACTORIZATION`, gdy pivotowanie pozostaje stabilne).
     4. Wewnątrz callbacku `PCSHELL` (`PCApply`): pobranie wskaźników device `VecCUDAGetArrayRead`/`VecCUDAGetArrayWrite` bez kopiowania na host, wypełnienie prawej strony $[r; 0]$ na urządzeniu, `CUDSS_PHASE_SOLVE` na aktywnym strumieniu CUDA i zwrot bloku $q$.
   - **Zastosowanie do Floquet $k \neq 0$:** ten sam rdzeń obsługuje układ zespolony (albo przeplatany real-split) oraz tryb wsadowy `cudssMatrixCreateBatchCsr` dla wielu punktów $k$ o wspólnym wzorcu rzadkości.

2. **Ścieżka dla siatek przekraczających VRAM (poza zasięgiem direct LU):**
   - Jeśli czynniki $L, U$ dla $K_\tau$ nie mieszczą się w VRAM (np. duże 3D airboxy na karcie 16–24 GB):
     - **Krok 2a:** sprawdzić **hybrid memory mode** cuDSS (czynniki częściowo w pamięci hosta z asynchronicznym streamingiem) — weryfikując twardo, czy czas nadal wygrywa z CPU MUMPS A1.
     - **Krok 2b:** w przeciwnym razie przełączyć `st_ksp` na **FGMRES na układzie $(q, \phi)$ z preconditionerem blokowo-trójkątnym** (1 V-cykl BoomerAMG na $P$ + blok magnetyczny przez AMG z zespolonym przesunięciem lub blokowy ILU $2 \times 2$ per węzeł) zamiast obecnego 3-poziomowego EPS→GMRES→CG+AMG (`C1`, `C2`, `C9`).
   - **Rozstrzygnięcie `C14` przed dużym przepisaniem:** równolegle zmierzyć $\|S - S^T\|/\|S\|$ i dodatnią określoność $S$. Jeśli pęk jest hermitowsko-dodatni (dla $\alpha = 0$ i stabilnej równowagi bez modów urojonych), dla najniższych modów naturalnym uzupełnieniem cuDSS jest blokowy LOBPCG/Lanczos na $(J, S \oplus S)$ z batchowanym PCG+BoomerAMG (wyrocznia algorytmiczna: `crates/fullmag-engine/src/fem_sparse.rs:466`, `lobpcg_generalized`).

3. **Twarde kontrakty GPU (bez wyjątków):**
   - **Brak cichego fallbacku CPU:** przekroczenie VRAM, brak `libcudss` lub niespełnienie warunku brzegowego musi kończyć się jawnym `unavailable` / `solve_error` (zgodnie z `AGENTS.md:40` i `modal_petsc_slepc.cpp:2508-2530`).
   - **Precyzja FP64:** zewnętrzne residuum oryginalnego deskryptora i certyfikat pozostają w FP64; ewentualne FP32 wewnątrz preconditionera (iterative refinement) wymaga osobnej noty w `docs/physics/0830` i dowodu przejścia bramki pełnego deskryptora.
   - **Dowód CUPTI (`C11`):** żadna zmiana GPU nie może zostać oznaczona jako zweryfikowana bez włączonego pomiaru CUPTI (`per_iteration_transfer_telemetry_measured == true`) na modelu z realnym 3D airboxem (`phi_dof > 1`, `split_dof_count > 1024`).
   - **Zakaz budowania na martwym kodzie:** nie opierać ścieżki produkcyjnej na `backends/fem/gpu/cuda/frequency_domain/modal_krylov.cu` (`C12`) ani na gęstym wrapperze `backends/fem/gpu/cuda/eigensolver_gpu.cu` (`syevd`).
