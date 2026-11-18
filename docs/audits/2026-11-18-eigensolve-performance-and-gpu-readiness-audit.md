# Audyt wydajności eigensolve (FEM) i gotowości do przepisania na GPU — 2026-11-18

## Podsumowanie

To audyt tylko do odczytu, obejmujący backend natywny (C++/PETSc/SLEPc/CUDA), runner i API (Rust) oraz Control Room.
Nie kompilowałem kodu ani nie uruchamiałem solvera.
Wszystkie liczby wydajności to szacunki z analizy kodu, oznaczone **[H]**.
Pozycje oznaczone ✔ sprawdziłem bezpośrednio w źródle na `master` @ `e34beba4a`.
Pozostałe pochodzą z równoległego przeglądu obszarowego i podają plik oraz linię do weryfikacji.

Wolne obliczenia dla trudnych przypadków nie mają jednej przyczyny.
Każdy poziom stosu dokłada swój mnożnik, a mnożniki się składają:

1. **Algorytm.** Shift-invert jest niedokładny i zagnieżdżony.
   - Każda iteracja wewnętrznego GMRES stosuje MatShell dopełnienia Schura, czyli 2 rozwiązania Poissona.
   - Preconditioner tego GMRES dla dużych układów **pomija demagnetyzację** (CPU k0, CPU Floquet i GPU).
   - Tolerancje wynoszą 1e-12 dla EPS i 1e-13 dla wewnętrznego KSP. To prawdopodobnie poniżej podłogi dokładności operatora.
   - CPU nie ma limitu restartów ani testu stagnacji. Nieudane podokna zjadają więc niemal cały czas (w pilocie 98,8%).
2. **Biblioteki.** PETSc jest zbudowany bez MUMPS/METIS/SuperLU i z referencyjnym BLAS (netlib).
   - Każde LU to natywne, jednowątkowe, nie-supernodalne LU PETSc.
3. **Struktura pracy.**
   - Okno częstotliwości to 16+34 seryjne podproblemy pod globalnym mutexem PETSc.
   - Retry zaczyna od zera. Nie ma `EPSSetInitialSpace`: 0 wystąpień w całym `backends/fem`.
   - Split Re/Im podwaja wymiar i krotność wartości własnych.
4. **Ścieżka k.** Dla każdego k od nowa liczone są dane od k niezależne: składanie MFEM, równowaga, Poisson, topologia, kanoniczne digesty.
   - Domyślne wykonanie po k jest szeregowe.
5. **Rust i provenance.**
   - Ścieżki z `runner_operator` budują gęste macierze n×n.
   - Digest jest liczony **element po elemencie z `format!` na każdą wartość**.
   - Floquet nonshared serializuje gęstą wiązkę macierzy do JSON przy każdym k.
   - Mody wszystkich k trafiają do JSON z pełnymi wektorami (pretty-print) i są parsowane 5–6 razy.
6. **Frontend.**
   - Animacja fazy przebudowuje co klatkę stan Reacta, drzewo Explorera, modele spektrum i bufory GPU.
   - JSON pojedynczego modu niesie gęste wektory DOF, których UI nie używa.

Rekomendacja w jednym zdaniu: **zastąpić zagnieżdżony shift-invert dokładną faktoryzacją rzadkiego układu rozszerzonego (q, φ)** z MUMPS na CPU i cuDSS na GPU, wyrównać tolerancje i limity, a stan niezależny od k liczyć raz na ścieżkę.
Ten sam projekt operatora powinien być podstawą przepisania na GPU.

## Zakres, metoda i granice dowodu

- **Zakres:**
  - `backends/fem/{cpu,gpu,src}/frequency_domain`, `backends/fem/gpu/cuda/frequency_domain`;
  - `crates/fullmag-runner/src/{eigen,fem}` oraz `native_fem`;
  - `crates/fullmag-api/src/router_v2/handlers/analysis/{eigen,frequency_domain}.rs`;
  - `apps/control-room` (panele frequency-domain, analysis-dispersion, viewport i kontrolery wizualizacji modów);
  - `docker/fem-{cpu,gpu}/Dockerfile`.
- **Wykorzystane wcześniejsze audyty:**
  - [`2026-10-01-eigensolve-window-performance.md`](2026-10-01-eigensolve-window-performance.md): 50 seryjnych podokien, 98,81765% czasu w nieudanych podoknach;
  - `2026-11-10-four-lane-solver-performance-audit.md` (lokalny szkic poza repozytorium).
- **Czego brakuje:**
  - świeżego profilu runtime;
  - liczników iteracji per podokno z bieżącego `master`;
  - pomiarów pamięci.

  Wszystkie mechanizmy są potwierdzone w źródle. Rzędy wielkości zysku to hipotezy do zmierzenia (sekcja [Pomiary do wykonania](#pomiary-do-wykonania-przed-decyzjami)).
- **Zasady projektu.** Zmiany metody (układ rozszerzony, complex scalars, slicing, sformułowanie hermitowskie) wymagają najpierw noty w `docs/physics/` (`0830`, `0831`) zgodnie z AGENTS.md.
  Zmiany digestów wymagają nowej wersji schematu, bez cichej zmiany wartości.
  Forced GPU nie może mieć fallbacku CPU.

## Mapa ścieżek wykonania

| Ścieżka | Wejście | Rdzeń numeryczny | Główne pliki |
|---|---|---|---|
| CPU k0, Poisson-airbox Schur | shared-domain MFEM | EPS Krylov-Schur + STSINVERT; operator to MatShell Schura (2 LU-solve Poissona na apply); ST KSP to GMRES(256) z PC LU(`A_qq − σB`) | `cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` |
| CPU k≠0, Floquet shared-domain | payload składany natywnie **dla każdego k** | jak wyżej, ale GMRES(8), PC bez demagu dla wymiaru > 512, `ST_MATMODE_SHELL` | `cpu/frequency_domain/modal/floquet_modal_solver.cpp`, `operators/poisson_airbox_shared_domain.cpp`, `production_cpu_modal_eigen.cpp` |
| CPU, `runner_operator` (k0 periodic bez demag z oknem; Floquet nonshared) | **gęste** macierze n×n z Rusta | natywny SLEPc na gęstych i CSR jednocześnie | `crates/fullmag-runner/src/fem/eigen_native_window.rs`, `eigen_nonshared_domain.rs`, `eigen_operator.rs` |
| GPU k0, Poisson-airbox | shared-domain | EPS Krylov-Schur + STSINVERT; Schur MatShell z CG+BoomerAMG (2 solve'y na apply); ST KSP to GMRES(128) z AMG na `[[A,σB],[−σB,A]]` | `gpu/frequency_domain/modal_petsc_slepc.cpp` |
| GPU dense (Kittel k0) | gęste macierze | cuSOLVER `sygvd`, O(n³) | `crates/fullmag-runner/src/fem/eigen_execution.rs:1601-1638`, `cpu/mfem/runtime/eigen_dense.cpp` |
| GPU Floquet k≠0 | — | **brak lane'u**: jawne `production_gpu_nonzero_k_floquet_k0_poisson_path_unavailable` | `src/frequency_domain/modal_eigen_solver.cpp:2503-2522` |
| `modal_krylov.cu` | — | **martwy w produkcji**, wołany tylko z testu | `gpu/cuda/frequency_domain/modal_krylov.cu` |

Ścieżki w tabeli są względne wobec `backends/fem/`, o ile nie zaczynają się od `crates/`.

## A. Problemy przekrojowe (największy wpływ)

### A1. Niedokładny, zagnieżdżony shift-invert z preconditionerem bez demagu ✔

- **CPU k0.** `create_production_shift_preconditioner(problem.A_qq, problem.B_qq, …)` (`poisson_airbox_schur_matshell.cpp:6093`) jest używany zawsze, gdy nie ma dokładnej materializacji.
  W oknie dokładna materializacja działa tylko dla `split_count ≤ 512` (`:2749`, `:5997-5999`), a `split_count = 2·q`. Dla realnych siatek oznacza to praktycznie zawsze.
- **CPU Floquet.** `kFloquetExactSchurPreconditionerMaxDimension = 512` (`floquet_modal_solver.cpp:1297`). Powyżej progu: `MatDuplicate(rotated_a_qq)` + `MatAXPY(−shift, gyrotropic)` (`:1817-1831`).
  Kod sam to opisuje: *"Larger production systems retain the sparse approximation until a scalable block preconditioner is available"*.
  Restart GMRES = 8 (`:1291`).
- **GPU.** AMG na symetrycznym nieokreślonym `[[A,σB],[−σB,A]]` (problem typu Helmholtza), też bez członu demag (`modal_petsc_slepc.cpp:422-477`, `:2174-2175`).
  Każdy apply Schura to 2 pełne CG+BoomerAMG.
- **Koszt [H].** Liczba rozwiązań Poissona ≈ restarty EPS × kroki Arnoldiego × (iteracje GMRES + narzut) × 2.
  Dla cienkich warstw (silny demag) GMRES ze słabym PC zbiega wolno albo stoi. To spójne z `slepc_diverged` zależnym od shiftu.
- **Propozycja (rdzeń).** Dokładny shift-invert przez **rzadki układ rozszerzony**:

  ```text
  K_σ = [[A_qq − σB_qq,  A_qφ],
         [A_φq,          P   ]]        (real split albo complex)
  (S − σB)⁻¹ r = blok_q( K_σ⁻¹ [r; 0] )   (tożsamość dopełnienia Schura)
  ```

  - Jedna faktoryzacja rzadka na shift (MUMPS/Pardiso na CPU, cuDSS na GPU) i `KSPPREONLY`. Znika GMRES, znika zagnieżdżony Poisson, znika problem preconditionera.
  - Wariant minimalnie inwazyjny: zostawić GMRES i bramki certyfikacji, a LU(K_σ) podać jako right-PC (PCSHELL). GMRES zejdzie do 1–2 iteracji.
  - Dla CPU k0 monolityczny pencil rozszerzony już istnieje: `poisson_airbox_modal_eigen.cpp:1126-1148` (składanie) i `:1578-1605` (EPS). Jest jednak odcięty dla produkcji (`:1496-1501`).
- **Wpływ [H]:** 10–100× na jeden solve shift-invert.
- **Ryzyko:** zmiana metody wymaga noty `0830`/`0831` i ADR. Bramka residualu oryginalnego deskryptora pozostaje bez zmian.
  Trzeba zachować spójność skalowania z `normalize_native_floquet_pencil` (A_qq, A_qφ i B skalowane; P i A_φq nie).

### A2. Build PETSc: brak solverów bezpośrednich i referencyjny BLAS ✔

- **Gdzie:**
  - `docker/fem-cpu/Dockerfile:121-130`: `--with-blaslapack-lib="-llapack -lblas"`, tylko hypre;
  - `docker/fem-gpu/Dockerfile:194-212` (arch CUDA) oraz `:283-294` (arch CPU): to samo, bez `--download-mumps/metis/parmetis/scalapack/superlu_dist/strumpack`.
- **Skutek:**
  - Każde `PCLU` to natywne SeqAIJ LU PETSc: jednowątkowe, bez supernodów i BLAS3, z wbudowanym ND zamiast METIS.
  - Kod nie wywołuje `PCFactorSetMatSolverType` na CPU. Komentarz `poisson_airbox_schur_matshell.cpp:6191-6194` to potwierdza.
  - Referencyjny BLAS spowalnia też BV/DS w SLEPc (ortogonalizacja, projektowany problem) oraz każdy gęsty LAPACK.
- **Propozycja:**
  - CPU: `--download-mumps --download-scalapack --download-metis --download-parmetis` (opcjonalnie `--download-superlu_dist`, `--download-suitesparse`) oraz OpenBLAS albo MKL.
  - Dla P(k), które jest hermitowskie, a dla Robin/Dirichlet także SPD: `PCCHOLESKY` + `MAT_SPD`.
  - GPU: sprawdzić dostępność cuDSS w PETSc 3.24 i STRUMPACK/SuperLU_DIST z CUDA.
- **Wpływ [H]:** 3–50× na faktoryzacji 3D Poissona/airbox, 1,5–3× na triangular solves.
  To warunek inercji (A6) i układu rozszerzonego (A1).
- **Ryzyko:**
  - `MAT_SHIFT_NONZERO`, `PCFactorReorderForNonzeroDiagonal` i `KSPGMRESSetBreakdownTolerance` działają tylko w natywnym PETSc. Dla MUMPS potrzebne są zamienniki (`ICNTL(24)`, jawny `MatShift`).
  - Zmieni się manifest `fem-cpu-slepc-build-inputs.json` i provenance (`petsc_default_lu`).

### A3. Tolerancje poniżej podłogi dokładności i brak limitu restartów (CPU) ✔

- **Tolerancje:**
  - Domyślne `residual_tolerance = 1e-10` (`poisson_airbox_modal_eigen.hpp:73`).
  - `production_modal_eigensolver_tolerance` daje `max(1e-12, min(1e-8, 1e-3·1e-10)) = 1e-12` (`poisson_airbox_schur_matshell.cpp:255-266`).
  - Wewnętrzny KSP: `max(1e-13, min(1e-10, 1e-3·1e-12)) = 1e-13` (`:3876-3881`).
  - Do tego `EPSSetTrueResidual(PETSC_TRUE)` (`:6166`) i `KSPSetErrorIfNotConverged` (`:6205`).
- **Restarty:** przy `max_outer_iterations = 0` (domyślnie z Rusta) EPS dostaje `PETSC_DEFAULT` (`:5993-5995`).
  Brak `EPSSetStoppingTestFunction` (0 wystąpień w pliku CPU). GPU go ma (`modal_petsc_slepc.cpp:2159-2168`) i rezerwuje jedną dekadę, nie trzy (`:193-212`).
- **Mechanizm [H]:**
  - Każdy apply Schura zawiera LU Poissona bez iterative refinement na źle uwarunkowanym, gradowanym airboxie.
  - Prawdziwe residuum Ritza nie zejdzie do 1e-12.
  - Krylov-Schur kręci restarty do domyślnego `max_it` (rzędu `max(100, 2n/ncv)`), co daje `EPS_DIVERGED_ITS` = `slepc_diverged`. To zgodne z 98,8% czasu w nieudanych podoknach.
- **Propozycja:**
  - EPS tol około 1e-9 do 1e-10 i inner rtol około 1e-2·EPS tol (albo relaksacja inexact shift-invert).
  - `PC_RIGHT` + `KSP_NORM_UNPRECONDITIONED`.
  - Jawny cap restartów (100–300) i stopping test stagnacji (brak nowych zbieżnych par przez K restartów).
  - Akceptacja zostaje przy niezależnym residualu oryginalnego deskryptora (`:6773-6813`).
- **Wpływ [H]:** największa „tania" poprawka. Kilka do kilkudziesięciu razy na oknach z porażkami.
- **Ryzyko:** niskie, bo bramka akceptacji jest niezależna od tolerancji EPS. Wymaga regresji residuali i guard modes.

### A4. Split Re/Im: podwojony wymiar i podwojone wartości własne ✔

- **Gdzie:** `PETSC_USE_COMPLEX` jest jawnie odrzucany (`floquet_modal_solver.cpp:1299-1303`, `poisson_airbox_schur_matshell.cpp:3858-3864`). `nev = 2–4×` żądana liczba modów (`floquet_modal_solver.cpp:8020-8037`, `poisson_airbox_schur_matshell.cpp:4008-4012`).
- **Skutek [H]:**
  - Każda wartość własna występuje w klasie J (q oraz i·q). Krylov-Schur z jednym wektorem startowym znajduje drugą kopię wolno, co dokłada się do `DIVERGED_ITS`.
  - LU rzeczywiste wymiaru 2N kosztuje około 2× więcej niż zespolone wymiaru N.
  - Każdy apply Schura robi 2 seryjne solve'y Poissona (`:2331-2334`) zamiast jednego z 2 RHS.
- **Propozycja:**
  - Osobny `PETSC_ARCH` z `--with-scalar-type=complex` dla lane'u modalnego (CPU i GPU).
  - Minimum: blokowy solve 2 RHS (`KSPMatSolve`/`MatMatSolve`) oraz układ przeplatany (Re, Im) per węzeł z BAIJ bs=2.
- **Wpływ [H]:** 2–4×. Na GPU dodatkowo połowa ruchu pamięci.
- **Ryzyko:** średnie (nowy build, kontrakt ABI real split, formaty certyfikatów, konwencja fazy).

### A5. Seryjne okna, retry od zera, brak warm-startu i globalny mutex ✔

- **Okno:** 16 podokien bazowych i 34 refinement, seryjnie (`poisson_airbox_schur_matshell.cpp:3996-3999`, `:4139-4157`; `production_cpu_modal_eigen.cpp:4693-4719`; GPU `modal_petsc_slepc.cpp:2873-2877`, `:3057-3128`).
  Każde podokno ma nowy EPS/ST/KSP i nowe LU preconditionera.
- **Mutex:** `petsc_slepc_process_mutex()` trzymany przez całe okno (`poisson_airbox_schur_matshell.cpp:3938`, `floquet_modal_solver.cpp:7527`).
- **Retry:** nasycenie lub refill wykonuje `destroy_all()` i nowy `EPSSolve` z `nev ×2`, bez zachowania faktoryzacji dla tego samego σ (`floquet_modal_solver.cpp:9445-9472`, `poisson_airbox_schur_matshell.cpp:4240-4442`).
- **Brak warm-startu:** `EPSSetInitialSpace`/`EPSSetDeflationSpace` mają 0 wystąpień ✔. Brak też startu z wektorów poprzedniego k.
  Kontekst reuse odrzuca inne k (`floquet_modal_solver.cpp:7661`).
- **Druga identyczna faktoryzacja:** `configure_production_refinement_ksp` (`poisson_airbox_schur_matshell.cpp:2998-3095`) tworzy drugi PC LU na tej samej macierzy co ST.
- **Redundancja GPU [H]:** dla r = 10 to około 3360 obliczonych par, żeby oddać co najwyżej 10 modów.
- **Propozycja:**
  - trwały EPS (`EPSSetDimensions` na istniejącym obiekcie, jak już robi GPU, `modal_petsc_slepc.cpp:2196-2206`);
  - trwała macierz o stałym wzorcu (`MatAXPY(SAME_NONZERO_PATTERN)` lub `MatCopy`), co pozwala pominąć fazę symboliczną;
  - współdzielenie faktoryzacji ST z refinementem;
  - `EPSSetInitialSpace` z Ritzów poprzedniego podokna, retry albo k;
  - równoległe podokna w osobnych procesach (PETSc nie jest thread-safe), z deterministycznym merge (dedup okna to „first wins", `:4896-4934`).
- **Wpływ [H]:** 1,5–3× mniej faktoryzacji, retry tańsze o 30–70%, wall-clock około P× przy P procesach.

### A6. Pokrycie okna: inercja i spectrum slicing zamiast harmonogramu 16+34 [H]

- **Stan:** certyfikat okna ma `"count_certificate":{"status":"not_performed"}` (`poisson_airbox_schur_matshell.cpp:5695`). Drugi przebieg (34 podokna) to pośredni test stabilności.
- **Hipoteza strukturalna (do potwierdzenia numerycznego):**
  - Według noty `0830`: `A_qφ = −μ0·A_φqᵀ`.
  - Przy symetrycznym `A_qq`, skośnym `B` i dodatnio określonym `L_eff` w stabilnej równowadze, KKT po przeskalowaniu wiersza φ jest symetryczny nieokreślony.
  - Wtedy `In(K(σ)) = In(P) + In(L_eff − σB_rot)` (Haynsworth).
  - Dwie faktoryzacje LDLᵀ (MUMPS, `MatGetInertia`) dają ścisłą liczbę modów w [f_min, f_max].
- **Propozycja:** count certificate z inercji, shifty i `nev` dobierane do zliczeń. Docelowo `EPSSetInterval` + STSINVERT + MUMPS.
- **Wpływ:** odpada około 34 z 50 podproblemów, a certyfikat kompletności staje się rzeczywisty.

### A7. Stan niezależny od k liczony dla każdego k ✔ (częściowo)

- **Native:** `modal_eigen_solver.cpp:2296-2304` ✔ woła `assemble_poisson_airbox_shared_domain_payload` dla każdego żądania, czyli dla każdego k. Składane jest od nowa:
  - import siatki, FE space, lumped mass, stan linearyzacji;
  - `A_qq`, pełny assembler k0, forma dyfuzji (dwukrotnie: `poisson_airbox_shared_domain.cpp:2803` i `floquet_bloch_scalar.cpp:58`);
  - digesty.

  W trybie `full_field_phase_constrained` od k zależą wyłącznie więzy fazowe `C_φ(k)` i `C_q(k)` (`floquet_airbox_operator.cpp:590-627`).
- **Rust** (`eigen_equilibrium.rs:402-513`, wołane per k z `eigen_execution.rs`): dla każdego k wykonywane są
  - `load_certified_equilibrium_artifact` (parse JSON);
  - `MeshTopology::from_ir`, powtarzane 4× dla tego samego k;
  - `FemLlgProblem::with_terms_and_demag_airbox` (montaż Poissona);
  - `problem.observe` (pełny solve demag);
  - linearyzacja shared-domain z digestami.
- **Propozycja:**
  - `EigenPathContext` (Arc) budowany raz na ścieżkę, kluczowany fingerprintem siatki, digestem równowagi i polem.
  - Natywny cache operatora niezależnego od k. Per k tylko fazy: `X(k) = Σ_{Δt} e^{ik·Δt}·X_{Δt}`, co daje ≤ 27 różnych Δt, ze wzorcem symbolicznym liczonym raz i wypełnianiem `MatSetValuesCOO`.
  - Worker puli dostaje paczkę k.
- **Ryzyko:**
  - Akumulator usuwa dokładne zera (`if (value == Complex{}) continue;`), więc przy k·L ∈ {0, π} zmienia się wzorzec. Stały wzorzec zmienia hash CSR i wymaga nowej wersji digestu.
  - Provenance per k musi nadal wiązać identyczne digesty.

### A8. Digesty i provenance na gorącej ścieżce ✔

- **Rust:** `CanonicalDigestBuilder::add_double_slice` (`eigen_native_window.rs:2133-2138`) ✔ robi `format!("{name}[{index}]")` dla **każdej** wartości. Jest wołane dla trzech gęstych macierzy n×n (`:2145-2156`, wywołanie `:915-923`).
  [H] Bufor rośnie o około 60 B na element. Przy n = 4000 (2N dla N = 2000) to około 2,9 GB w pamięci, potem SHA-256.
- **Native:** `add_digest_matrix` (`poisson_airbox_shared_domain.cpp:1197-1213`) ✔ dodaje 2× `std::to_string` i nazwę tekstową dla każdego nnz, w buforze w pamięci.
  `canonical_digest.cpp:22` kopiuje cały payload (`std::string message = input;`). Wszystko to dzieje się dla każdego k.
- **Floquet nonshared:** `eigen_nonshared_domain.rs:738-757`, `:1074-1150` zamienia 4 gęste macierze w `serde_json::Value`, serializuje je 2×, liczy SHA i zapisuje jako sidecar `nonshared_floquet_matrix_pencil_preimage.v1.json` **dla każdego k**. Do tego sidecar siatki jest zapisywany per k.
- **Propozycja:**
  - Digest v2: binarne tagi, jedno pole na tablicę (surowe bajty IEEE LE w ustalonej kolejności), strumieniowe SHA-256 bez bufora, CSR zamiast gęstych.
  - Preimage binarny. Bajty hashowane są tymi samymi, które idą do pliku.
  - Sidecar siatki raz na ścieżkę.
- **Wpływ:** krytyczny dla ścieżek z `runner_operator` i Floquet nonshared. Te ścieżki są dziś praktycznie niewykonalne powyżej około 1–2 tys. węzłów [H].
- **Ryzyko:** zmiana kontraktu digestu po obu stronach FFI. Wymaga nowej wersji schematu i walidatorów sidecarów.

## B. Backend natywny CPU — ustalenia szczegółowe

| ID | Gdzie | Problem | Propozycja | Wpływ | Ryzyko |
|---|---|---|---|---|---|
| B1 ✔ | `cpu/frequency_domain/mode_deduplication.cpp:14-36`, wołane z `poisson_airbox_schur_matshell.cpp:6972-6979` z `nullptr` | `mass_inner_product` robi podwójną pętlę O(n²) także dla metryki jednostkowej (`i==j?1:0`). Woła ją normalizacja każdego kandydata i każda para bliska częstotliwościowo (kopie J zawsze są bliskie). | Gałąź `nullptr` jako zwykły iloczyn O(n); wariant z akcją masy CSR. | **Bardzo duży** na dużych siatkach (q = 50k daje około 2,5·10⁹ operacji na iloczyn) przy trywialnej poprawce | brak, te same liczby |
| B2 ✔ | `poisson_airbox_schur_matshell.cpp:2617-2747` | Dokładny PC dla nearest do wymiaru 8192 robi n applies Schura (16 384 Poissonów), wstawia około 67M wpisów pojedynczym `MatSetValue` (kolumnowo, do AIJ) i robi **rzadkie LU na gęstej macierzy** (O(n³) przez kernele AIJ, około 1 GB). W oknie dochodzi `MatAXPY(DIFFERENT_NONZERO_PATTERN)` na gęstym cache (`:2818`). | `MATSEQDENSE` + LAPACK `getrf` (z OpenBLAS), `SUBSET_NONZERO_PATTERN`; docelowo A1. | Minuty dla 1024 < split ≤ 8192 | niskie |
| B3 | `poisson_airbox_schur_matshell.cpp:1696-1808` | Fallback PC per shift: nowy `Mat` przez `MatSetValue` i pełne LU (symbolic + numeric). | Trwały Mat o stałym wzorcu, tylko faktoryzacja numeryczna. | średni | niskie |
| B4 | `floquet_modal_solver.cpp:7858-7866`, `1822-1855` | Nowe P(k) i KSP dla każdego k; PC per próba EPS przez `MatDuplicate` + `MatAXPY(DIFFERENT)`. Analiza symboliczna jest powtarzana mimo stałego wzorca. | `SAME_NONZERO_PATTERN`; MUMPS reuse analysis (20–40% czasu faktoryzacji). | średni | niskie |
| B5 | `floquet_modal_solver.cpp` oraz `modal/shifted_ksp_true_convergence.hpp:659`, `modal/shifted_ksp_certified_recovery.hpp:413` | Dodatkowe applies operatora na jedno rozwiązanie wewnętrzne: true-probe w teście zbieżności, `floquet_recompute_certified_recovery_residual` po każdym `KSPSolve` (`:843`), `capture_last_floquet_shifted_solve` (`:1538`, opisane jako „diagnostic-only", ale wykonywane zawsze) i raz po EPS (`:8948-8953`). | Zapamiętać residuum z true-probe z identyfikatorem wektora i użyć go ponownie; capture jako opt-in. | +30% Poissonów [H] | certyfikacja: zachować jedną niezależną kontrolę |
| B6 ✔ | `floquet_modal_solver.cpp:8183`, `poisson_airbox_schur_matshell.cpp:6166`, GPU `modal_petsc_slepc.cpp:2121` | `EPSSetTrueResidual(PETSC_TRUE)` przy operatorze MatShell, więc jawne `A·x − λB·x` (z Poissonem) dla sprawdzanych par na każdym restarcie. | Wyłączyć, bo autorytatywna jest późniejsza bramka oryginalnego deskryptora. Zmierzyć liczbę refilli. | średni [H] | możliwy wzrost odrzuceń |
| B7 | `poisson_airbox_schur_matshell.cpp:6401-6434`, `6530-6858`, `4850-4880` | Na podoknie z `eps_reason < 0` i tak wykonywane są drugie LU, refinement, rekonstrukcja φ i residua, a potem zwracane jest `solve_error`. Pętla okna kontynuuje po pierwszej porażce, choć werdykt jest przesądzony. | Tryb diagnostyczny bez refinementu; opcjonalny fail-fast. | średni | brak |
| B8 | `poisson_airbox_schur_matshell.cpp:6613-6660`, `6702`, `6749` | Ritz refinement (do 3 iteracji, każda to 4 applies Schura plus 2 GMRES) dla **każdej** pary, również kopii J i par spoza okna. Dedup następuje dopiero po nim (`:6972`). | Najpierw tanie wykrywanie kopii J ((u,v) ~ (−v,u)); refinować tylko potrzebne pary nad progiem. | średni | niskie |
| B9 | `operators/poisson_airbox_shared_domain.cpp:144-241`, `384-423` | Akumulatory `std::vector<std::map<…>>` (około 64 B na wpis) i SpGEMM projekcji fazowych C^H·X·C (około 10 na k) na mapach. | Dwuprzebiegowy CSR z łączności siatki; projekcje przez wzorzec raz plus wartości per k (A7). | średni dla k-path | digest v2 |
| B10 | `floquet_modal_solver.cpp:1687-1789` | `create_real_split_matrix` 6× na k, 2–4 `MatSetValue` na wpis. | `MatSetPreallocationCOO` + `MatSetValuesCOO` (ta sama droga co GPU). | niski | niskie |
| B11 | `floquet_modal_solver.cpp:1955-2036` | Callback MatShell: `VecScale(−1)`, zbędne `VecCopy(y, feedback)` (`:2027`), rotacja przez hostowe `VecGetArray` (`:1985-1998`). | Wbudować znak i rotację w macierze (`R·A_qq`, `R·A_qφ`). Dla GPU to warunek konieczny. | niski CPU, wysoki GPU | niskie |
| B12 | `poisson_airbox_modal_eigen.cpp:1226-1229`, hpp `390-608` | `evaluate_poisson_airbox_modal_residuals` tworzy na stosie około 800 KiB `PoissonAirboxModalEigenResult` dla każdej pary i wywołuje `validate_problem` (skan CSR). | Walidować raz; lekki rdzeń residualu. | niski czas, **ryzyko przepełnienia stosu** workera 2 MiB w rekurencji okna | — |
| B13 | `poisson_airbox_schur_matshell.cpp:1382-1453`; Rust `eigen_native_window.rs:832-845` | Callback postępu i anulowania w każdej iteracji wewnętrznego KSP: kopia struktury, około 1,5 KB JSON przez `snprintf`, parse w Rust. | Throttling czasowy (≤ 10 Hz); anulowanie jako atomik. | niski–średni | brak |
| B14 | `poisson_airbox_schur_matshell.cpp:3984-3987`, `4896-4934`, `5499-5501` | `WindowCandidate` trzyma pełny wektor (q+φ); dedup okna O(C²·n); kopie agregatu. | Trzymać tylko q, φ rekonstruować dla publikowanych modów; `std::move`. | pamięć (około 3 GB przy C = 200 i 10⁶ DOF) | niskie |
| B15 | `poisson_airbox_schur_matshell.cpp:3062-3063`, `5989` | GMRES(256) dla ST i refinementu: 257 wektorów 2N na bazę (około 4 GB przy q = 10⁶). | Mniejszy restart przy dobrym PC; przy A1 GMRES znika. | pamięć | — |

## C. Backend GPU — ustalenia szczegółowe

Jedyna produkcyjna ścieżka GPU to `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc`.

- **Obsługuje** wyłącznie: k = 0, `periodic_airbox_k0`, shared-domain MFEM, brzeg Robin, `gauge_policy=none`, α = 0, `nearest_frequency` lub `frequency_window`, do 64 modów (`modal_petsc_slepc.cpp:2499-2517`).
- **Nie obsługuje** (jawne `unavailable`, bez fallbacku): Floquet k ≠ 0, ogólnego modal bez airboxa, Neumann/Dirichlet, tłumienia.

| ID | Gdzie | Problem | Propozycja | Wpływ |
|---|---|---|---|---|
| C1 | `modal_petsc_slepc.cpp:1881-1902`, `976`, `204-214`, `941-946` | Trzy poziomy zagnieżdżenia: EPS, GMRES(128), a w każdym matvec 2 pełne CG+BoomerAMG z rtol 1e-8 do 1e-12. [H] Około 3000 V-cykli na krok EPS i 1e5–1e6 na podokno. CPU ma tu LU Poissona raz; GPU zastąpił obie faktoryzacje iteracjami. | A1 (cuDSS na K_σ) albo FGMRES na (q,φ) z PC blokowo-trójkątnym (1 V-cykl P na iterację). | **dominujący** |
| C2 | `:422-477`, `:2174-2175` | AMG z domyślnymi ustawieniami na nieokreślonym `[[A,σB],[−σB,A]]`, bez członu demag. Układ [Re; Im] nie jest przeplatany, brak `num_functions`/nodal. Ryzyko `KSPSetErrorIfNotConverged` (`:2155`) i porażki podokna. | Sformułowanie SPD (C14), complex-shifted PC albo direct. | wysoki |
| C3 ✔ | `:2239-2247`, `:689-727`; `poisson_airbox_modal_eigen.hpp:239-340` | Test zbieżności z postępem i anulowaniem zainstalowany **na wewnętrznym `poisson_ksp`**. Każda iteracja CG daje około 1,5 KB JSON i parse w Rust. Postęp jest mylnie etykietowany jako `solving_shift_invert`. | Nie instalować na wewnętrznym KSP; throttling ≤ 10 Hz. | [H] rzędu kosztu samej iteracji CG dla średnich siatek |
| C4 ✔ | `:965`, `:977`, `:993`; konfiguracja AMG | `std::getenv` 3× na każdy solve Poissona. Domyślny coarse relax BoomerAMG to 9 (Gauss na hoście, D2H/H2D w każdym V-cyklu), choć time-domain wymusza 18 (`gpu/cuda/demag_poisson/hypre_device_solver.cpp:103`). Około 3 synchronizacje skalarów (`VecMDot`, CGS refine always, norma) na iterację GMRES. | Cache env; `HYPRE_BoomerAMGSetCycleRelaxType(...,18,3)`; własny Krylov ze skalarami na device i CUDA Graphs. | wysoki [H] |
| C5 ✔ | `:4070-4100`, `:1354-1378`, `:2005-2186`, `:399-477`, `:352-363` | Zmiana σ (`target_reconfigured`) wywołuje `destroy_gpu_solver_state`, który niszczy także niezależną od σ split mass. Odbudowa przez `MatSetValue` po jednym wpisie na hoście, nowe EPS/ST/KSP i nowy setup AMG. Dla każdego podokna O(nnz) `valid_csr` i 2× `csr_infinity_norm`. | Trwała masa; aktualizacja `A+σB` kernelem lub `SAME_NONZERO_PATTERN`; reuse hierarchii AMG; upload przez COO/CSR. | wysoki w oknie |
| C6 | `:2873-2877`, `:3057-3128` | Okno: 16+34 pełnych solve'ów z rebuildem (C5), nev 4r/8r, brak initial space i deflacji. | A5/A6, streamy per σ. | wysoki |
| C7 | `:4416`, `:4444-4446`, `:4677-4681`, `:1125-1194` | Postprocessing: 3× `apply_schur` na tym samym q (residuum, φ, eksport), 3× `EPSGetEigenpair`; `device_modal_residual_metrics` = 10 MatMult i 14 VecNorm (każdy z synchronizacją). | Jeden `apply_schur` z wyjściem φ, reużyty. | średni |
| C8 | `:1888-1899` | Każdy matvec: 4 VecScatter + `VecSet`, choć połówki wektora są ciągłe; 2 Poissony seryjnie. | `VecGetSubVector`/`VecCUDAPlaceArray` zero-copy; 2 RHS. | średni |
| C9 | `:193-212`, `:2139-2145` | Tolerancja Poissona = tolerancja GMRES (brak relaksacji inexact Krylov); GMRES niefleksyjny przy zmiennym operatorze. | FGMRES; relaksacja tolerancji Simoncini–Szyld. [H] 2–3× mniej V-cykli. | średni |
| C10 | pamięć [H] | Baza GMRES(129) około 4,1 GB, BV około 2,6–5,1 GB, AMG i bloki około 5–10 GB przy N_mag = 1e6. Praktyczny limit to około 1M węzłów magnetycznych na karcie 24 GB. | Restart 30–50 przy dobrym PC; complex zamiast split. | pojemność |
| C11 | `:4801-4804`, `:2659`; `tests/frequency_domain/gpu_k0_modal_petsc_slepc_test.cpp:1144-1200` | Rezydencja „zweryfikowana" porównaniem stringów typów; `per_iteration_transfer_telemetry_measured:false`. Test „production scale" ma φ_dof = 1 (PCJACOBI), więc żaden test nie dotyka BoomerAMG na realnym 3D Poissonie. | CUPTI (`gpu/cuda/runtime/cuda_activity_trace.cpp`); bramka skali z realnym airboxem i licznikami iteracji. | dowód |
| C12 | `gpu/cuda/frequency_domain/modal_krylov.cu` | Martwy w produkcji. `atomicAdd` z każdego wątku na jeden adres w redukcjach (`:412-437`, `:702-731`), CSR wiersz na wątek, kernele `<<<1,1>>>` (w tym O(N³) eliminacja), Hessenberg na hoście, BiCGStab z Jacobi na nieokreślonym (q,φ). | **Nie budować na nim**; najwyżej szkielet kontraktów rezydencji. | — |
| C13 | `gpu/cuda/frequency_domain/driven_response_gpu.cu:2040-2151` | Akcja shift-invert GPU to gęsta wyrocznia (limit 64 DOF, jednowątkowa eliminacja). | Tylko jako oracle parytetu. | — |
| C14 [H] | konwencja pencila | Przy α = 0 i stabilnej równowadze S jest symetryczne dodatnio określone, a B skośne. Pęk `S x = ω (iB) x` jest wtedy hermitowsko-określony, a kod używa GNHEP (`:2117`). | Zweryfikować numerycznie ‖S−Sᵀ‖ i dodatniość (mody Goldstone!). Jeśli tak: GHEP `J x = μ (S⊕S) x`, μ = 1/ω, i Lanczos/LOBPCG z wyłącznie SPD solverami wewnętrznymi (CG+AMG, w czym GPU jest dobre). | potencjalnie fundamentalny |

Obserwacja: w drzewie roboczym są nieśledzone `backends/fem/gpu/cuda/eigensolver_gpu.cu` i `backends/fem/include/eigensolver_gpu.h`, gęsty wrapper cuSOLVER `syevd`.
Gęsty `syevd` nie skaluje się dla tego problemu. Nadaje się wyłącznie do małego projektowanego problemu Rayleigha-Ritza wewnątrz LOBPCG albo Lanczosa.

## D. Runner i API (Rust) — ustalenia szczegółowe

Ścieżki są względne wobec `crates/`.

| ID | Gdzie | Problem | Propozycja | Wpływ |
|---|---|---|---|---|
| D1 ✔ | `fullmag-runner/src/fem/eigen_native_window.rs:2133-2156` | Digest gęstych macierzy element po elemencie z `format!` (A8). | Digest v2: binarny, strumieniowy, CSR. | **krytyczny** |
| D2 | `fem/eigen_nonshared_domain.rs:738-757`, `1074-1150`, `960`, `385`, `401` | Gęsta wiązka i siatka jako JSON `Value`, 2× serializacja i sidecar dla każdego k (A8). | Preimage binarny, sidecar siatki raz na ścieżkę. | **krytyczny** dla Floquet nonshared |
| D3 | `fem/eigen_operator.rs:131-176`, `308-417`; `eigen_native_window.rs:846-858`, `694`, `2013-2076`, `924-937`, `979`, `1572`, `1654-1663`; `eigen_solve.rs:655-709` | `DMatrix::zeros(2n,2n)` i około 7 gęstych kopii (γ·K, row-major ×2, G liczona 2×, osadzenie Bloch 8N liczone 2×). CSR budowany skanem n². Native dostaje jednocześnie gęste i CSR. | Montaż od razu do CSR/COO; γ na wartościach CSR; bez gęstego row-major, gdy jest CSR. | wysoki |
| D4 | `fem/eigen_equilibrium.rs:402-513`, `eigen_path.rs:3447`, `3458`, `eigen_native_window.rs:905`, `1664`, `eigen_shared_domain.rs:296-802`, `1201` | Stan niezależny od k liczony dla każdego k (A7). | `EigenPathContext` raz na ścieżkę. | wysoki |
| D5 ✔ | `fem/eigen_path_artifacts.rs:2647-2655`; `fem/eigen_native_artifacts.rs:909-996`; `fem/eigen_output.rs:62-73`, `3234-3235`; `eigen_path.rs:3304`, `3617` | Tracking wymusza `EigenMode { all_modes: true }` dla każdej próbki. JSON modu zawiera `real/imag/amplitude/phase` oraz `q_*`, `phi_*` (cały airbox) i `node_mass_weights`, zapisany przez `to_vec_pretty`. Wszystko akumulowane w RAM (`RefCell<Vec<AuxiliaryArtifact>>`), a payload binarny zapisany 2× (zarr i `.bin`). | Typowany `ModeRecord` w pamięci; wektory binarnie (f64 LE); zapis strumieniowy po każdym k; `to_vec` zamiast pretty; jeden fizyczny payload. | wysoki, O(K·M·N) |
| D6 | `eigen_path.rs:3582-3593`; `eigen_path_artifacts.rs:2681`, `4504-4544`, `~95-134`, `3861`; `eigen_output.rs:2669-2690`, `2960-2975` | Każdy duży JSON modu parsowany około 5–6× (adapter, tracking, remap z rekurencyjnym `replace`, bundle v2 2× w tym raz tylko dla walidacji, ustawienie `branch_id` z pretty reserialize). | Jedna serializacja przy publikacji; `branch_id` i `sample_index` znane przed nią. | wysoki–średni |
| D7 | `eigen/tracking.rs:253-281`, `1302-1345`; `eigen/tracking_mass.rs:216-240` | Tracking z metryką consistent-P1: `normalize` i `embed` (15·n_tet complex, alokacja) dla **każdej krawędzi** gałąź×mod. [H] Około 10¹² operacji przy T = 300k, B = M = 40, K = 100. | Raz na mod policzyć `M_c·v` i normę; overlap O(3N) bez alokacji; baza stała cache'owana; rayon po krawędziach. | średni–wysoki |
| D8 ✔ | `fullmag-ir/src/parallel_execution.rs:82`; `fem/eigen_k_pool.rs:292-297`, `362`, `465`, `552-727`; `eigen_k_worker.rs:304-330`, `432-443`, `498-507` | Domyślnie `ParallelExecutionModeIR::Serial`. Adaptive: bootstrap seryjny, potem probe sam (2 seryjne solve'y przed rozkręceniem). GPU zawsze seryjne. Klon całego planu i JSON+sha per k; ten sam plik równowagi czytany i hashowany K razy; worker hashuje cały plik wykonywalny. | Domyślnie Adaptive z batchowaniem k; `threads_per_worker` = rdzenie/workerzy; digesty bazowe raz; cache hasha binarki. Na GPU: streamy lub MPS. | średni–wysoki |
| D9 | `eigen/k_process_pool.rs:1172`, `1005-1080`; `fem/eigen_k_pool.rs:650` | Artefakty workera czytane i hashowane SHA-256 2×. | Walidacja zwraca załadowane artefakty. | średni |
| D10 | `eigen_path.rs:136-215`; `fem/single_k_checkpoint.rs:189-204`, `317-410` | Checkpoint per k: każdy JSON modu z fsync na plik, zanim finalna publikacja zapisze te same dane ponownie. | Checkpoint kompaktowy (wartości + binarne wektory) lub hardlink; jeden fsync na katalog. | średni (wysoki na 9p/Windows) |
| D11 ✔ | `fem/eigen_native_window.rs:2250-2282` | Diagnostyczne gęste widmo (cholesky, odwrotność, `L⁻¹KL⁻ᵀ`, `SymmetricEigen`) dla n ≤ 4096 **przy każdym k**: około 5 operacji n³. | Tylko na żądanie diagnostyki albo raz na ścieżkę; próg na przykład 512. | średni dla średnich siatek |
| D12 | `fem/eigen_execution.rs:1601-1638`; `backends/fem/src/frequency_domain/modal_eigen_solver.cpp:953-980` | GPU Kittel k0: pełne gęste uogólnione eigen (O(n³), H2D gęstych) dla jednej wartości. Wynik GPU przychodzi jako JSON ze zdublowanymi `mode_vector_*` i `mode_q_*`. | Shift-invert z celem lub Rayleigh; typowany transport (jak ABI v18 na CPU). | średni |
| D13 | `fem/eigen_execution.rs:2033-2037`, `2474`; `eigen_solve.rs:435-451` | Redukcja complex bez native idzie przez gęste `solve_complex_hermitian_eigenpairs` (O(n³)), tylko z `eprintln!`. | Odrzucać na etapie planowania powyżej progu albo kierować do native. | niski–średni |
| D14 | `eigen_path_artifacts.rs:2357-2371`, `2786-2805`; `eigen_output.rs:2669`, `2960` | Wyszukiwania O((K·M)²) i O(M·A) przy publikacji. | `HashMap` indeksów. | niski |
| D15 | `fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs:2069-2144`, `2354-2423`; `fullmag-session/src/frequency_domain_artifact_generation.rs:232-271`, `352-376`; `results.rs:~4351`; legacy `eigen.rs:49-137` | Serwowanie artefaktów eigen: manifest generacji parsowany i reserializowany 3× na żądanie, członek hashowany 2×, plik parsowany 2×, blokujące I/O na wątkach tokio (pod `read().await`), brak ETag/304 dla JSON, pełny `Value` modu z wektorami. | Cache `(generation_id, path) → Arc<Bytes>`; ETag z `member.sha256`; `spawn_blocking`; `RawValue`; DTO modu bez wektorów. | średni (responsywność UI) |

## E. Frontend (Control Room) — ustalenia szczegółowe

Ścieżki są względne wobec `apps/control-room/src`.

| ID | Gdzie | Problem | Propozycja | Wpływ |
|---|---|---|---|---|
| E1 ✔ | `kernel/visualization/AnalysisFieldOverlayPhaseAnimation.ts:84-99`, `:200`; `AnalysisFieldOverlayController.ts:127-141`, `:252-260` | Animacja fazy co klatkę rAF robi `controller.update({visualizationPhaseRad})` i `notify` z nowym snapshotem. Renderują się: `useViewport3DSceneModel` (`:3238-3240`), `ExplorerModule` (`:420`), `RibbonModule` (`:425`), `ObjectVisualizationPanel` (`:1460`), `FrequencyDomainModeDisplayControls` (`:129`) i panele modów. | Faza w osobnym zegarze czytanym przez renderer (ref lub uniform w `useFrame`), jak `ModeCompositionPhaseClock`. Selektory z porównaniem (`useSyncExternalStoreWithSelector`). Slider throttlowany do około 10 Hz. | **wysoki** |
| E2 ✔ | `modules/viewport-3d/hooks/useViewport3DSceneModel.ts:4906-4944`, `7114-7158`; `modules/viewport-3d/viewport3dRenderModel.ts:786-851`, `1683-1745`, `1083-1136`, `1792-1793`; `useViewport3DScalarColorUpload.ts:141-151` | Faza w `primaryFieldRenderOptions`. Klucz cache `${componentCount}:${phase}` chybia co klatkę. Nowe `Float64Array(pointCount·3)` i 2× `Float32Array(vertexCount·3)` oraz ponowny upload atrybutów na GPU, choć shader już przyjmuje `complexPhaseRad` jako uniform. [H] Około 50 MB alokacji na klatkę przy 1M węzłów. | Tablice re/im niezależne od fazy; faza tylko jako uniform. Wzorzec: `modeCompositionViewportProjection.ts:148-200`. | **wysoki** |
| E3 ✔ | runner `eigen_native_artifacts.rs:935-938`, `eigen_output.rs:3042-3052`; API `frequency_domain.rs:1356`, `2502-2507`; UI `EigenModeInspectorPanel.tsx:370` | JSON modu wozi `q_real/q_imag/phi_real/phi_imag` (cały airbox), a UI czyta tylko skalary (0 użyć `q_real` poza `generated`). | DTO „mode summary"; wektory wyłącznie przez binarny data plane; limit rozmiaru odpowiedzi. | **wysoki** |
| E4 | `modules/explorer/ExplorerModule.tsx:685-951` (dep `:935`); `resultsExplorerNodes.ts:249-284`, `321-388` | Drzewo Explorera przebudowywane co klatkę: `activeAnalysisFieldOverlay` w deps, `parseDispersionCsv`/`buildEigenSpectrumChartModel`, `pathWavevectorAtSample` O(P·S). | Zależność od stabilnej tożsamości overlaya; memo modeli po referencji danych; mapa próbek k raz. | wysoki |
| E5 | `modules/inspector/panels/frequency-domain/*` (0 `useMemo`); `shared/domain/analysis/frequencyDomainChartModels.ts:1366-1376` | `buildEigenSpectrumChartModel` w 19 miejscach, `buildEigenDispersionChartModel` w 7, `buildEigenBranchesModel` w 8; ten ostatni ponownie parsuje CSV. | Cache `WeakMap` po obiekcie zasobu wewnątrz builderów (wzorzec: `analysis-plots/hooks/useAnalysisFrequencyData.ts:204-239`). | średni–wysoki |
| E6 | `modules/inspector/panels/FrequencyDomainCharts.tsx:56`, `:480`; `EChartsCanvasSurface.tsx:188-194`; `chartRenderer.ts:225-230`, `462-467`, `484` | Nowy model wykresu w każdym renderze, więc `setOption(..., {replaceMerge:["series"]})`; `progressive: 0`, brak `large` i `sampling`. | Memo modelu; pomijać `setOption` przy niezmienionej sygnaturze; `large: true` / `sampling: 'lttb'` powyżej około 5k punktów. | średni–wysoki |
| E7 | `FrequencyDomainCharts.tsx:96-139`, `FrequencyDomainTables.tsx:204-258`, `EigenBranchInspectorPanel.tsx:381-385`, `509-587`, `FrequencyDomainResultInspectors.tsx:1470-1481` | Niezwirtualizowane listy: [H] około 9000 przycisków przy 50 k × 20 modów. | Wirtualizacja (jak `ExplorerTreeView.tsx:665`), menu akcji. | średni |
| E8 | API `frequency_domain.rs:1256-1300`; `frequencyDomainChartModels.ts:2138-2213`, `1106-1116`; `kernel/resources/studyRuntimeResources.ts:737-767` | Dyspersja jako CSV w polu JSON `text`, parsowana wielokrotnie na głównym wątku (`split`, `Object.fromEntries` na wiersz). Podział na gałęzie O(B·P). | Tabela kolumnowa lub binarna (`tableRowsCodec` w workerze); grupowanie w jednym przebiegu. | średni |
| E9 | `kernel/api/ControlRoomApi.ts:4796` (ETag tylko dla binarnych) | Brak warunkowego GET dla JSON. Każde `resource.updated` pobiera całość. [H] Przy przyrostowej publikacji po k transfer rośnie O(N²). | ETag = `content_digest` i 304; endpoint „próbki od indeksu". | średni |
| E10 | `modules/viewport-3d/layers/MeshPartLayer.tsx:785-800`; `modeCompositionViewportProjection.ts:203-319` (`:308`, `:314`) | Glify mode composition przebudowywane co klatkę (faza w `buildKey`). | Atrybuty re/im i rotacja w shaderze. | średni |
| E11 | `studyRuntimeResources.ts:695-728` | Rewizja manifestu zawiera `progress_json`: każdy tick postępu re-renderuje hooki podsumowań. | Postęp tylko w zasobie progress. | niski–średni |
| E12 | `EigenBranchInspectorPanel.tsx:700-702`; `ModeCompositionFieldLayerController.ts:107` | `Math.min(...arr)` rzuci `RangeError` przy więcej niż około 100k elementów; `fieldRevisions` rośnie bez limitu. | Pętla; limit lub LRU. | niski |

Co działa dobrze i nie wymaga zmian:

- dekodowanie binarnych pól w workerze (`binaryDecodeScheduler.ts:191`);
- tożsamość binarnego pola modu bez fazy (`frequencyDomainResourceKeys.ts:52-58`);
- `ResourceCache` z limitem bajtów;
- inwalidacja per klucz;
- wirtualizacja drzewa Explorera powyżej 200 wierszy.

## F. Rekomendowana architektura przepisania na GPU

Fundament powinien być wspólny dla CPU i GPU. Port obecnej struktury EPS → GMRES → Poisson przeniósłby na GPU wszystkie problemy z sekcji A, a na GPU jest ona jeszcze gorsza z powodu synchronizacji i słabości AMG na układach nieokreślonych.

1. **Najpierw rozstrzygnąć sformułowanie (C14).**
   Zmierzyć ‖S−Sᵀ‖ oraz dodatniość S na kilku przypadkach referencyjnych, z polem i bez (mody Goldstone).
   - Jeśli pęk jest hermitowsko-określony, dla „najniższych N modów" i okien zaczynających się nisko użyć blokowego LOBPCG albo Lanczosa na `(J, S⊕S)`, gdzie `μ = 1/ω`.
     Akcja S to batchowany PCG Poissona z SpMM: jedna hierarchia AMG i wiele RHS.
   - Wyrocznia algorytmiczna istnieje: `crates/fullmag-engine/src/fem_sparse.rs:466` (`lobpcg_generalized`).
2. **Okno w środku widma: shift-invert bez zagnieżdżenia.**
   - (a) cuDSS (LU/LDLᵀ) na pełnym rozszerzonym K_σ. Analiza symboliczna raz na wzorzec, refaktoryzacja numeryczna na każde σ, wiele RHS naraz.
   - (b) Tam, gdzie direct się nie mieści: FGMRES na (q,φ) z PC blokowo-trójkątnym. Blok magnetyczny przez AMG z zespolonym przesunięciem albo ILU 2×2 node-block, blok φ przez jeden V-cykl AMG(P), z relaksacją tolerancji.
   - (c) Pokrycie okna: inercja (A6) i spectrum slicing lub filtr konturowy (FEAST), z niezależnymi σ na streamach.
3. **Rezydencja.**
   - Montaż CSR na device (MFEM device albo COO→CSR) ze stałym wzorcem unii `A ∪ B ∪ więzy`.
   - Aktualizacja σ i faz k kernelem; trwała masa i hierarchia AMG.
   - Upload przez `MatSetPreallocationCOO`/`MatSetValuesCOO`, nigdy `MatSetValue`.
4. **Synchronizacja.**
   - Redukcje do skalarów na device (pipelined/s-step, CGS2 przez jeden GEMV).
   - Hot loop w CUDA Graphs; postęp tylko z poziomu zewnętrznego i throttlowany.
   - AMG z coarse relax 18 i strojeniem z `configure_demag_amg`.
5. **Jeden kod dla k = 0 i k ≠ 0.**
   - API operatora od początku zespolone hermitowskie (lub przeplatane Re/Im, bs = 2).
   - Batch po k: ten sam wzorzec i inne wartości, więc batched SpMV i batched cuDSS (`cudssMatrixCreateBatchCsr`) albo stream per k-punkt.
6. **Precyzja.** FP64 dla residuum zewnętrznego i certyfikatu (wymóg kontraktu); FP32 dla preconditionera z iterative refinement.
   [H] Daje to 1,5–2× na PC, ale wymaga dowodu, że certyfikat pełnego deskryptora nadal przechodzi.
7. **Matrix-free (libCEED).** Opłaca się dopiero przy wyższym rzędzie elementów. Dla P1 właściwy jest zmontowany CSR z cuSPARSE.
8. **Kontrakty.**
   - Bez fallbacku, jawne `unavailable`.
   - CUPTI do realnego pomiaru transferów.
   - Bramka skali z realnym 3D airboxem i regresją `poisson_iteration_count` oraz `shift_linear_iteration_count`.
   - Nie budować na `modal_krylov.cu` ani na gęstym `syevd`.

Szybkie poprawki obecnej ścieżki GPU bez przepisywania, w kolejności zysk/koszt: C3 (callback poza wewnętrznym KSP), C4 (coarse relax 18, cache env), C7 (redundantne Poissony), C5 (trwała masa, aktualizacja PC in place), C6 (initial space).

## G. Plan wdrożenia (kolejność zysk/koszt)

**Etap 0: pomiar bazowy.** Bez zmiany kodu, z istniejących liczników. Patrz [Pomiary do wykonania](#pomiary-do-wykonania-przed-decyzjami).

**Etap 1: szybkie, lokalne poprawki** (bez zmiany metody i kontraktu):

1. B1: dedup O(n) dla metryki jednostkowej.
2. A3: cap restartów i stopping test stagnacji na CPU (wyrównanie do GPU).
3. B13 i C3: throttling postępu, brak callbacku na wewnętrznym KSP.
4. D11: diagnostyczne gęste widmo tylko na żądanie.
5. C4: coarse relax 18 i cache `getenv`.
6. B7: tani tryb dla nieudanego podokna.
7. Frontend E1 i E2 (faza poza Reactem, uniform) oraz E5 (cache builderów).

**Etap 2: build.** A2: MUMPS, METIS i OpenBLAS na CPU; dobór pakietu LU per rola (Cholesky dla P). Do tego sprawdzenie cuDSS w obrazie GPU.

**Etap 3: tolerancje i reuse.**

- A3: tolerancje 1e-9 do 1e-10, inner rtol około 1e-2, prawa prekondycja.
- A5, B3, B4, C5: trwałe obiekty i stały wzorzec.
- Initial space i warm start z poprzedniego k.
- B5, B6, B8, C7: usunięcie redundantnych applies (każde z jawną decyzją o semantyce certyfikacji).

**Etap 4: Rust i provenance (kontrakty v2).**

- A8, D1, D2: digest v2 i preimage binarny.
- D3: montaż CSR.
- A7 i D4: kontekst ścieżki raz.
- D5, D6, D9, D10: typowane mody, binarne wektory, jedna serializacja.
- D7: tracking.
- D8: domyślnie Adaptive.
- D15 i E3: API bez wektorów w JSON, ETag i cache.

**Etap 5: zmiana metody** (najpierw nota `docs/physics/0830`/`0831` i ADR):

- A1: dokładny shift-invert przez K_σ (CPU MUMPS, GPU cuDSS).
- A6: inercja i spectrum slicing.
- A4: lane complex.
- C14: wariant hermitowski z LOBPCG/Lanczos.

Ten etap jest jednocześnie fundamentem przepisania na GPU (sekcja F).

**Etap 6: równoległość.** Podokna i shifty w osobnych procesach; batch k per worker; na GPU streamy lub MPS.

Każdy etap weryfikować na identycznym źródle i modelu: pełne residua oryginalnego deskryptora, guard modes, certyfikat okna, parytet CPU/GPU. Bez obniżania progów akceptacji.

## Pomiary do wykonania przed decyzjami

Liczniki już istnieją w `executed_subwindows_json` i diagnostyce GPU:

- `shift_linear_iteration_count` i `poisson_solve_count` per podokno (potwierdzenie A1, C1, C2);
- `outer_iterations` nieudanych podokien wobec efektywnego `max_it` (A3);
- `eps_solve_seconds` wobec `shifted_setup_seconds` (A2, A5, B3);
- dla Floquet: `linear_iterations_total`, `shifted_ksp_certified_recovery.cumulative_iterations_total`, `eps_attempt_count` (B5, B6, A5);
- `exact_cache_construction_seconds` i `exact_cache_construction_poisson_solve_count` (B2).

Brakuje:

- profilu per k z podziałem: składanie native, równowaga i demag w Rust, digest, solve, artefakty, tracking (A7, A8, D4–D7);
- pomiaru pamięci szczytowej runnera dla `runner_operator` przy N ≥ 2000 (D1–D3);
- CUPTI: bajty H2D/D2H i liczba synchronizacji na iterację w lane GPU (C4, C11);
- numerycznej weryfikacji ‖S−Sᵀ‖ i dodatniości S (C14) oraz inercji KKT (A6);
- profilu przeglądarki (React Profiler i Performance) podczas animacji fazy na siatce około 1M węzłów (E1, E2, E4).

Status: **NOT VERIFIED.** Wszystkie przyspieszenia to hipotezy do potwierdzenia tymi pomiarami. Mechanizmy są potwierdzone w źródle.

## H. Stan wdrożenia etapu 1 (branch `codex/eigensolve-stage1-perf-20261118`)

| Pozycja | Stan | Zmiana |
|---|---|---|
| B1 | wdrożone | `mode_deduplication.cpp`: metryka jednostkowa (`mass == nullptr`) liczona jako q^H q w O(n). Dla skończonych wektorów wynik jest ten sam. |
| B13, C3 | wdrożone | `PoissonAirboxModalProgressThrottle` w `poisson_airbox_modal_eigen.hpp`. Testy zbieżności KSP na CPU (`production_modal_ksp_convergence_test`) i GPU (`gpu_modal_ksp_convergence_test`) emitują postęp liniowy najwyżej co 100 ms na kontekst KSP. Anulowanie jest nadal sprawdzane w każdej iteracji. Sam emiter JSON nie zmienił się. |
| D11 | wdrożone | `eigen_native_window.rs`: gęste widmo diagnostyczne tylko dla wymiaru ≤ 512 zamiast ≤ 4096. Powyżej progu raportowane jest `skipped_large_operator`. |
| C4 | częściowo | Cache `FULLMAG_FEM_GPU_K0_PETSC_DEBUG` (`gpu_k0_petsc_debug_enabled`). **Coarse relax 18 nie został wdrożony:** nota 0913 nie wykazała przyspieszenia w time-domain (4,18 s wobec 3,88 s) i wymaga osobnego dowodu dla eigensolve. |
| E5 | wdrożone | `frequencyDomainChartModels.ts`: memoizacja `buildEigenSpectrumChartModel`, `buildEigenDispersionChartModel` i `buildEigenBranchesModel` po obiekcie zasobu (unieważniana przy zmianie dowolnego pola zasobu) oraz LRU(4) dla parsowania CSV dyspersji. |
| A3 | odłożone | Cap restartów i test stagnacji zmieniają, kiedy podokno kończy się porażką. Wymaga rozkładu `outer_iterations` udanych i nieudanych podokien z `executed_subwindows_json` oraz aktualizacji noty 0830. |
| B7 | odłożone | Tani tryb nieudanego podokna zmienia zawartość diagnostyki podokien. Wymaga decyzji kontraktowej. |
| E1, E2 | odłożone | Faza animacji poza stanem Reacta i projekcja complex wyłącznie w shaderze (również dla glifów) to refaktor `useViewport3DSceneModel` i warstw viewportu. Wymaga dowodu z przeglądarki (WebGL); prowadzić jako osobne zadanie. |

Dowody:

- Frontend: `vitest` dla `src/shared/domain/analysis`, `src/modules/{inspector,explorer,analysis-dispersion,analysis-plots}` daje 2854 testy zaliczone, w tym 3 nowe testy memoizacji.
  Dwa pakiety nie ładują się z powodu brakującego `@typescript/typescript6` w `node_modules` głównego checkoutu.
  `tsc` zgłasza wyłącznie brak `postprocessing` w nieruszanych plikach viewportu. Oba braki wynikają ze środowiska i istnieją przed zmianą.
- Build: grupa `fullmag-worktree-eigensolve-stage1-perf-20261118-cfae68217ff7ebe7` (attempt `3c3e4559ca0847c3ae74b093d7ed53b2`) dała `state=succeeded` przy `backend_package_cache_hit=false`.
  `libfullmag_fem.so.0.1.0` zbudowana w tej próbie zawiera ścieżkę GPU modal.
  Zgodnie z zakazem nie kompilowano testów jednostkowych C++ ani Rust.
- Runtime eigensolve: **NOT VERIFIED.** `examples/fem_eigen_k0_poisson_airbox_production.py` i `examples/fem_eigen_k0_kittel_periodic_airbox.py` są odrzucane już na etapie loweringu sceny w Pythonie (`thin_film_scoped_fields_require_exact_cell_geometric_airbox`, `asset_pipeline.py:3201`), zanim dojdą do solvera. To osobna regresja ścieżki siatki, niezależna od tych zmian.
