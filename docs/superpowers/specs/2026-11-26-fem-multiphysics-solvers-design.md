# Pakiet FEM Multiphysics Solvers Modernization (Wave 2 / PR B — P1 #5) — Specyfikacja Architektoniczna

**Data:** 2026-11-26
**Autor:** `multiphysics-architect`
**Baza źródłowa:** `origin/master` (`9ab99132d55d4af1596f42625c7733ccac496c31`)
**Status:** Gotowy do realizacji w roju (Faza 0 wspólny szew + 3 równoległych autorów bez kolizji plików + Faza 2 integracja, macierz buildów i benchmarki A/B)
**Powiązany plan implementacji:** [2026-11-26-fem-multiphysics-solvers-plan.md](../plans/2026-11-26-fem-multiphysics-solvers-plan.md)

---

## 1. Cel, zakres i diagnoza stanu bazowego

Pakiet **P1 #5 (FEM Multiphysics Solvers Modernization)** usuwa cztery krytyczne bariery skalowalności w natywnym backendzie FEM dla Oersteda (OE-F2, OE-F1) oraz transportu ładunku i spinu (M1/M2, `ChargeTraceWorkspace`, OE-T0 RT0 KKT), korzystając **wyłącznie z bibliotek już zlinkowanych w `backends/fem/CMakeLists.txt`** (zero nowych zależności zewnętrznych), z zachowaniem rygoru FP64, niezależnej certyfikacji rezyduów, determinizmu oraz pełnej rozłączności torów CPU/GPU z `AGENTS.md`:

1. **Oersted Vector Potential — OE-F2 (`backends/fem/cpu/mfem/interactions/oersted/vector_potential.{hpp,cpp}`):**
   - *Stan bazowy:* składa gęstą macierz `(N_ND + N_H1) × (N_ND + N_H1)` w `mfem::DenseMatrix` + `mfem::DenseMatrixInverse` ($O(N^3)$ czasu, $O(N^2)$ RAM), twardy limit `maximum_nd_dofs = 4096`, `maximum_h1_dofs = 2048` (powielony w `crates/fullmag-ir/src/antenna.rs:60-61`), gęsta odwrotność macierzy masy w `project_compatible_h_to_nodes` (`:151-215`) oraz gęste podwójne pętle $O(N^2 \log k)$ do obliczenia rezyduum (`:303-332`).
   - *Cel:* prawdziwy rzadki solver z symetrycznym skalowaniem bloków $\beta$ (PETSc+MUMPS LU z uporządkowaniem METIS i doprecyzowaniem iteracyjnym w Tier 1; HYPRE `HypreAMS` + `HypreBoomerAMG` ze ścisłym uzupełnieniem Schura w `MINRES` z $\gamma = \mu_0^{-1} L^{-2}$ w Tier 2 dla buildów bez SLEPc), rzadka projekcja masy $H \to H^1$ ze wspólną jednorazową faktoryzacją dla $(H_x, H_y, H_z)$ i jednoprzebiegowym montażem 3 prawych stron, rezyduum przez rzadkie `SpMV` ($O(\text{nnz})$), podniesienie domyślnych limitów do `2'000'000` / `1'000'000` przy zachowaniu ścisłej walidacji jawnych limitów oraz opcjonalnej weryfikacji na małej gęstej wyroczni testowej.

2. **Oersted Direct Tetra Quadrature — OE-F1 (`backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.{hpp,cpp}`):**
   - *Stan bazowy:* jednowątkowe CPU $O(N_{\text{target}} \cdot N_{\text{source}})$ z wywołaniem `mfem::IntRules.Get(...)` wewnątrz pętli kwadratury (niebezpieczne wielowątkowo!) oraz 3-krotnym powtarzaniem pełnej kwadratury Biota–Savarta w `ProjectField` (`:959-994`, osobno dla $H_x, H_y, H_z$).
   - *Cel:* wstępna ekstrakcja płaskich, niemutowalnych tablic kwadratur (zero wyścigów danych pod TSan), dwupoziomowa deterministyczna równoległość CPU (`std::thread`: po celach dla $N_t \ge 2W$, po źródłowych czworościanach bazowych dla małych $N_t$) dająca **bitowo identyczny wynik (0 ULP)** z wykonaniem szeregowym przy zachowaniu sekwencyjnego obserwatora postępu i dokładnego atomowego `WorkBudget`, 3× fuzja `ProjectField` (z zachowaniem limitów `WorkBudget` bez fałszywego przekroczenia punktowego limitu par!), PLUS jawnie opt-in hybrydowy akcelerator **CUDA GPU dla nieosobliwych par dalekiego pola** (`gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.{hpp,cu}`) ze 106-bitową kompensacją *double-double* (`TwoSum`) w deterministycznej kolejności źródeł i ścisłym przekazaniem par osobliwych/bliskich ($d_c \le 3.0\,R_s$) na CPU `long double` Duffy + adaptacyjny podział ósemkowy.
   - *Ocena `surface_rt0.{hpp,cpp}`:* to wyrocznia analityczna w arytmetyce dokładnej GMP/MPFR128/MPFR160 (`mpq_rational` + `mpfr_float<160>`) ze ścisłym jednowątkowym profilerem faz `PhaseProfiler` (`SurfaceRt0PhaseReport`) i budżetami RSS/czasu na pojedynczy cel. Zostaje świadomie **niezmieniona** w tym PR (ryzyko naruszenia audytu faz i limitów RSS bez istotnego zysku w gorącej ścieżce produkcyjnej, gdzie głównym kosztem jest `DirectTetraQuadrature`).

3. **Transport ładunku i spinu + OE-T0 RT0 KKT (`steady_transport.{hpp,cpp}`, `charge_trace_workspace.{hpp,cpp}`, `conservative_current_view.cpp`, `periodic_charge_potential.cpp`):**
   - *Stan bazowy:*
     - `solve_charge_terminal_currents` (`steady_transport.cpp:717-870`): powtarza pełny montaż biliniowy $K_\sigma$, eliminację brzegową, budowę `GSSmoother`, jednowątkowe `CGSolver`, projekcję $J$ i kwadraturę diagnostyczną $(T - C + 1)$ razy dla $T$ terminali!
     - `ChargeTraceWorkspace::Impl::solve` (`charge_trace_workspace.cpp:290-554`): w `ChargeCurrentResponse` (do 64 kolumn sterowań) za każdym wywołaniem od nowa buduje zredukowaną macierz ilorazową `reduced_matrix` i rozwiązuje ją od zera `CGSolver` + `GSSmoother`!
     - `solve_spin` (M1, `:872-956`) oraz `solve_reciprocal` (M2, `:958-1104`): **całkowicie nieprekondycjonowany** jednowątkowy `mfem::GMRESSolver(kdim=100)` dla niesymetrycznych układów z precesją spinu $-c_J[m]_\times$, AMR/AHE i sprzężeniem SHE/ISHE!
     - `conservative_current_view.cpp` (OE-T0, `:2124-2253`): rzadki układ KKT rozwiązywany przez `MINRES` z `GSSmoother(M_f)` i **macierzą jednostkową** w bloku więzów (`IdentityOperator`, do 200 000 iteracji!), plus `solve_external_lead_potential` (`:2515-2525`) używające `CGSolver` + `GSSmoother`.
     - *Audyt `periodic_charge_potential.cpp`:* plik deleguje już całe rozwiązywanie ładunku do `solve_charge_trace_workspace(trace_request)` (`:1233`) i nie zawiera własnego `CGSolver`/`GSSmoother` — więc automatycznie zyskuje factor-once z `ChargeTraceWorkspace`, a jego jedyna zmiana to jawne przypięcie jednorangowej polityki solvera dla `reference_mpi_gather_rank0_broadcast` gwarantujące bitową identyczność `n=1` vs `n=2` w teście MPI!
     - *Audyt `backends/fem/cpu/mfem/interactions/transport_stage.cpp`:* plik zawiera wyłącznie walidację realizacji skalarnego $M_s$ (`validate_transport_stage_ms_realization`) oraz cienki adapter wywołania zwrotnego `fullmag_fem_stage_transport_callback_v1` (zero solverów liniowych — właściwe obliczenia transportu odbywają się po stronie `steady_transport_c_api.cpp` $\to$ `SteadyTransportOracle`, więc `transport_stage.cpp` dziedziczy automatycznie całe przyspieszenie bez modyfikacji!).
   - *Cel:* wspólny wielopoziomowy rzadki solver liniowy (`cpu/mfem/common/sparse_linear_solver.{hpp,cpp}`) z wielokrotnie używaną faktoryzacją (*factor-once multi-RHS*):
     - jednorazowa faktoryzacja $K_\sigma$ dla wszystkich $T$ terminali w `solve_charge_terminal_currents` oraz w konstruktorze `ChargeTraceWorkspace::Impl`,
     - bezpośredni rzadki solver PETSc+MUMPS LU (Tier 1) / blokowo-diagonalny `HypreBoomerAMG` + `HypreILU` GMRES (Tier 2 dla buildów bez SLEPc) dla niesymetrycznych układów `solve_spin` (M1) i `solve_reciprocal` (M2),
     - bezpośredni rzadki PETSc+MUMPS LU + `long double` iteracyjne doprecyzowanie (Tier 1) / `MINRES` z aproksymowanym uzupełnieniem Schura $\tilde{S} = \beta^2 C_f \operatorname{diag}(M_f)^{-1} C_f^\top$ prekondycjonowanym `HypreBoomerAMG` (Tier 2) dla OE-T0 RT0 KKT, z pełnym zachowaniem `ConservativeConstraintRank`, bramek fizycznych oraz toru TSan (`FULLMAG_OET0_DISABLE_MPI=1`),
     - jawnie opt-in ścieżka **GPU `cuDSS`** (`SparseExecutionTarget::GpuCudss`) z preflightem VRAM dla factor-once SPD (ładunek) i LU (spin/M2/KKT), przy **100% zachowaniu istniejącego negatywnego kontraktu C ABI v1/v2/v3** (`FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE` nadal zwraca `FULLMAG_FEM_ERR_UNAVAILABLE` na starych symbolach v1/v2/v3 do czasu odrębnego PR promującego ABI/planner!).

---

## 2. Audyt dostępnych bibliotek w `backends/fem/CMakeLists.txt` i macierzy buildów

Dokładna inspekcja `backends/fem/CMakeLists.txt`, `docker/fem-cpu/Dockerfile` oraz `docker/fem-gpu/Dockerfile` na `origin/master` (`9ab99132d5`) pokazuje pięć odrębnych konfiguracji budowania, które nowy kod **musi** obsłużyć bez błędów kompilacji i linkowania:

| Profil builda | `FULLMAG_HAS_MFEM_STACK` | `FULLMAG_FEM_WITH_SLEPC` | `FULLMAG_HAS_CUDA_RUNTIME` | `FULLMAG_FEM_CUDSS_POISSON_ENABLED` | `FULLMAG_OET0_DISABLE_MPI` | Zlinkowane biblioteki liniowe / równoległe |
|---|:---:|:---:|:---:|:---:|:---:|---|
| **1. Bootstrap / non-MFEM** (`native-modal-cabi-contract`) | `0` | `0` | `0` | `0` | — | Brak (tylko stuby C ABI zwracające `FULLMAG_FEM_ERR_UNAVAILABLE`). |
| **2. FEM CPU domyślny** (`docker/fem-cpu`, CI CPU, `test_fem_build_policy.py`) | `1` | `0` | `0` | `0` | — | MFEM v4.10 (`MFEM_USE_MPI=YES`, `MFEM_USE_OPENMP=YES`, `MFEM_USE_HYPRE=YES`, `MFEM_USE_METIS=NO`, `MFEM_USE_SUITESPARSE=NO`), **HYPRE v2.32.0 CPU** (`BoomerAMG`, `AMS`, `HyprePCG`, `HypreGMRES`, `HypreILU`, `HypreDiagScale`), `OpenMP::OpenMP_CXX`, `Threads::Threads`, GMP/MPFR. **Brak PETSc/MUMPS i CUDA.** |
| **3. FEM CPU + SLEPc** (`/opt/fullmag-mfem-cpu`, `FULLMAG_FEM_CPU_WITH_SLEPC=ON`) | `1` | `1` | `0` | `0` | — | Jak w (2) PLUS **PETSc v3.24.6 (`PETSC::petsc`) + MUMPS (`PETSC_HAVE_MUMPS`) + METIS (`PETSC_HAVE_METIS`) + ScaLAPACK + OpenBLAS**. |
| **4. FEM GPU** (`docker/fem-gpu`, RTX 4080 SUPER) | `1` | `1` | `1` | `1` (gdy `FULLMAG_CUDSS_ROOT`) | — | Jak w (3) PLUS **HYPRE v3.1.0 (`--with-cuda --with-openmp`)** (*UWAGA: domyślna pamięć/egzekucja DEVICE dopóki nie wywołano `configure_hypre_host_policy()`!*), **CUDA 12.4.1** (`cudart`, `cusparse`, `cublas`, `cusolver`), **NVIDIA cuDSS 0.8+**. |
| **5. OE-T0 TSan** (`-DFULLMAG_OET0_TSAN=ON`) | `1` | `0` lub `1` | `0` | `0` | **`1`** | MFEM szeregowy, `Threads::Threads`; **MPI i PETSc nieinstrumentowane przez TSan — ZAKAZ wywoływania/linkowania pod TSan!** |

### Kluczowe pułapki integracyjne wykryte w `CMakeLists.txt` i runtime

1. **Samodzielne targety testowe bez `fullmag_fem`, `Threads::Threads`, nagłówki `cuDSS` i makra kompilacji:**
   - `fem_steady_transport_contract` (`CMakeLists.txt:689-706`) kompiluje `steady_transport.cpp` bezpośrednio bez linkowania `fullmag_fem` i bez definicji `FULLMAG_HAS_MFEM_STACK=1` (co po dołączeniu `mpi_init.hpp` / `hypre_host_policy.cpp` wyłączyłoby gałęzie `#if FULLMAG_HAS_MFEM_STACK`!). Dodatkowo w `CMakeLists.txt:414,499` `Threads::Threads` było dotąd linkowane do `fullmag_fem` tylko pod CUPTI, a `find_package(Threads REQUIRED)` w `:750` występowało dopiero *po* `fem_steady_transport_contract`, zaś `${FULLMAG_CUDSS_INCLUDE_DIR}` (`:487`) było ustawione tylko na `fullmag_fem`.
   - `fem_conservative_current_view_contract` (`CMakeLists.txt:712-779`) kompiluje `conservative_current_view.cpp`, `charge_trace_workspace.cpp` i `direct_tetra_quadrature.cpp` bezpośrednio (bez `CUDA::cudart` i bez `FULLMAG_HAS_CUDA_RUNTIME=1`), z warunkowym TSan (`-DFULLMAG_OET0_DISABLE_MPI=1`).
   - *Rozwiązanie:* w **Fazie 0** w `backends/fem/CMakeLists.txt` dodajemy `find_package(Threads REQUIRED)` w `if(FULLMAG_USE_MFEM_STACK)` (linkując `Threads::Threads` do `fullmag_fem`, `fem_sparse_linear_solver_contract` i `fem_steady_transport_contract`), dopisujemy `target_include_directories(fem_steady_transport_contract PRIVATE "${FULLMAG_CUDSS_INCLUDE_DIR}")` pod `if(FULLMAG_FEM_CUDSS_SHIFT_SUPPORTED)`, dodajemy `FULLMAG_HAS_MFEM_STACK=1` na `fem_steady_transport_contract`, rejestrujemy `sparse_linear_solver.cpp` i szkielet `direct_tetra_farfield_kernels.cu`, oraz chronimy `PETSC::petsc` na `fem_conservative_current_view_contract` przez `if(FULLMAG_FEM_WITH_SLEPC AND NOT FULLMAG_OET0_TSAN)` (100% zachowania `scripts/test_audit_fem_cpu_only_runtime.py:295-319`!). Wszystkie makra opcjonalne w nowych plikach używają bezpiecznej formy `#if defined(MACRO) && MACRO`, dzięki czemu każdy z 3 autorów Fazy 1 kompiluje i przechodzi testy w swoim izolowanym worktree bez jakichkolwiek edycji `CMakeLists.txt`!
2. **Deadlock ORAZ bitowa identyczność w 2-rankowym teście MPI (`fem_conservative_current_view_mpi_byte_identity`, `CMakeLists.txt:799-835`, `conservative_current_view_contract.cpp:6058-6139`):**
   - `PeriodicChargePotentialSolver::Solve` i `ConservativeCurrentView::Build` z flagą `reference_mpi_gather_*_broadcast=true` zbierają siatkę na **rangę 0**, rozwiązują układ na randze 0 i rozsyłają bajty przez `MPI_Bcast`. Następnie CTest `fem_conservative_current_view_mpi_byte_identity` uruchamia `mpiexec -n 1` (`world_size==1`) i `mpiexec -n 2` (`world_size==2`) i wymaga **bitowej równości plików** (`cmake -E compare_files oet0-mpi-n1.bin oet0-mpi-n2.bin`)!
   - Gdyby `n=1` używało PETSc+MUMPS, a `n=2` (ze względu na `world_size > 1`) spadało do HYPRE, wynik różniłby się o $\ge 1$ ULP i złamałby test bitowej identyczności pod `FULLMAG_FEM_WITH_SLEPC=1`!
   - *Rozwiązanie dwuwarstwowe:* (a) gdy `reference_mpi_gather_rank0_broadcast == true` (w `periodic_charge_potential.cpp` $\to$ `ChargeTraceSolveRequest::cpu_backend`) lub `reference_mpi_gather_broadcast == true` (w `conservative_current_view.cpp`), jawnie przypinamy **tę samą jednorangową politykę solvera `SparseCpuBackendPolicy::Hypre` na `MPI_COMM_SELF`** (niezależnie od `world_size` — 100% identyczności bitowej między `n=1` a `n=2`!), a (b) dodatkowo w `sparse_linear_solver.cpp` zachowujemy straż przeciw deadlockowi (`MPI_Initialized && world_size > 1 && !petsc_initialized` $\implies$ nigdy nie wywołuj kolektywnego `PetscInitializeNoArguments()`, pomiń Tier 1 do Tier 2) jako *defense-in-depth*!
3. **Polityka pamięci i wykonania HYPRE w buildzie CUDA (`hypre_host_policy.cpp`):**
   - W buildzie GPU (`FULLMAG_FEM_HYPRE_GPU_BUILD=1`) HYPRE v3.1.0 domyślnie alokuje pamięć na GPU. Przed użyciem Tier-2 HYPRE na CPU `sparse_linear_solver.cpp` zawsze wywołuje `configure_hypre_host_policy(error)` i sprawdza **oba** pola `snapshot.memory_location_host && snapshot.execution_policy_host` (`hypre_host_policy.hpp:23-24`). Jeśli wcześniejszy kontekst GPU w tym samym procesie związał HYPRE z urządzeniem, Tier 2 na CPU nie dotyka HYPRE (korzysta z Tier 1 PETSc+MUMPS lub bezpiecznego Tier 3 MFEM host).
4. **Serializacja globalnego stanu PETSc (`petsc_slepc_process_mutex`):**
   - Każde wywołanie API PETSc (inicjalizacja, `KSPCreate`/`KSPSetUp`/`KSPSolve`/`KSPDestroy`, `Mat*`, `Vec*`) odbywa się pod `std::lock_guard<std::mutex>(fullmag::fem::runtime::petsc_slepc_process_mutex())`, z rejestracją żywego grafu (`register_petsc_slepc_live_cpu_graph_locked` / `unregister_petsc_slepc_live_cpu_graph_locked`), sprawdzeniem `petsc_slepc_process_is_unsafe_locked()` oraz `PetscPushErrorHandler(PetscReturnErrorHandler, nullptr)` (wzorzec z `modal_augmented_shift_solver.hpp:316-350`).

---

## 3. Wspólny moduł rzadkiego solvera liniowego (`sparse_linear_solver.{hpp,cpp}`) — Faza 0

Wydzielamy jeden, samowystarczalny moduł `backends/fem/cpu/mfem/common/sparse_linear_solver.{hpp,cpp}`, współużytkowany przez OE-F2 (`vector_potential.cpp`), transport (`steady_transport.cpp`, `charge_trace_workspace.cpp`) i OE-T0 (`conservative_current_view.cpp`, `periodic_charge_potential.cpp`):

```cpp
namespace fullmag::fem::multiphysics {

enum class SparseMatrixKind : std::uint32_t {
    Spd = 0,                 // K_sigma, H1 mass M_H1, external-lead H1, RT0 pure mass
    SymmetricIndefinite = 1, // OE-F2 curl-curl+grad saddle point, OE-T0 RT0 KKT
    GeneralNonsymmetric = 2, // M1 spin diffusion-precession, M2 reciprocal 4-field
};

enum class SparseExecutionTarget : std::uint32_t {
    Cpu = 0,       // Default: strict CPU execution (Tier 1 PETSc/MUMPS -> Tier 2 HYPRE -> Tier 3 MFEM)
    GpuCudss = 1,  // Explicit GPU cuDSS direct solve; fail-closed if unavailable/OOM (zero fallback!)
};

enum class SparseCpuBackendPolicy : std::uint32_t {
    Auto = 0,
    PetscMumps = 1, // Explicit PETSc/MUMPS (fail-closed if FULLMAG_FEM_WITH_SLEPC=0 or disabled)
    Hypre = 2,      // Explicit HYPRE (BoomerAMG/Block-AMG/ILU)
    MfemSerial = 3, // Explicit MFEM serial fallback (TSan / debug oracle)
};

struct SparseSolveConfig {
    SparseMatrixKind kind = SparseMatrixKind::Spd;
    SparseExecutionTarget execution_target = SparseExecutionTarget::Cpu;
    SparseCpuBackendPolicy cpu_backend = SparseCpuBackendPolicy::Auto;
    double relative_tolerance = 1.0e-12;
    double absolute_tolerance = 0.0;
    int maximum_iterations = 2000;
    int gmres_kdim = 100;
    // Number of coupled scalar components stored in mfem::Ordering::byNODES
    // (1 for scalar, 3 for spin mu, 4 for reciprocal [V, mu_x, mu_y, mu_z]).
    // Used by Tier-2 Block-Diagonal BoomerAMG for GeneralNonsymmetric systems.
    int by_nodes_component_count = 1;
    // Maximum iterative-refinement sweeps after a direct factorization solve.
    int max_refinement_sweeps = 2;
};

struct SparseSolveStats {
    bool converged = false;
    int iterations = 0;
    int refinement_sweeps = 0;
    double independent_relative_residual = std::numeric_limits<double>::infinity();
    std::string resolved_solver; // e.g. "petsc_mumps_cholesky_metis", "petsc_mumps_lu_metis",
                                 // "petsc_default_lu", "hypre_boomeramg_pcg",
                                 // "hypre_block_amg_gmres", "hypre_ilu_gmres",
                                 // "mfem_gs_pcg", "mfem_gs_gmres", "cuda_cudss_spd", "cuda_cudss_lu"
    double setup_ms = 0.0;
    double solve_ms = 0.0;
};

// Reusable factor-once / preconditioner-once sparse linear solver.
// Thread-safe for concurrent const solve() calls (PETSc serialized internally;
// HYPRE/MFEM allocate per-call work vectors).
class SparseLinearSolver {
public:
    SparseLinearSolver(
        const mfem::SparseMatrix &matrix,
        const SparseSolveConfig &config);
    ~SparseLinearSolver();

    SparseLinearSolver(const SparseLinearSolver &) = delete;
    SparseLinearSolver &operator=(const SparseLinearSolver &) = delete;

    // Solve A * x = b; computes independent unpreconditioned relative residual
    // ||A*x - b||_2 / max(1.0, ||b||_2) (or caller denominator when requested).
    SparseSolveStats solve(
        const mfem::Vector &rhs,
        mfem::Vector &solution,
        double denominator_floor = 1.0) const;

    const std::string &resolved_solver() const noexcept;
    double setup_ms() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Assemble symmetric block-equilibrated CSR matrix for
// [[A, beta * B], [beta * B^T, 0]] in O(nnz(A) + nnz(B)) without dense allocation.
mfem::SparseMatrix assemble_equilibrated_saddle_point_csr(
    const mfem::SparseMatrix &top_left,
    const mfem::SparseMatrix &top_right,
    double beta);

// Compute symmetric equilibration scalar beta = mean_diag(A) / rms_nonzero(B)
// (clamped to finite positive values; returns 1.0 if B has no nonzeros).
double compute_saddle_point_equilibration_beta(
    const mfem::SparseMatrix &top_left,
    const mfem::SparseMatrix &top_right);

// Independent O(nnz) unpreconditioned residual ||A*x - b||_2 / max(floor, ||b||_2).
double sparse_independent_relative_residual(
    const mfem::SparseMatrix &matrix,
    const mfem::Vector &solution,
    const mfem::Vector &rhs,
    double denominator_floor = 1.0);

} // namespace fullmag::fem::multiphysics
```

### Hierarchia 3 poziomów dla toru CPU (`SparseExecutionTarget::Cpu`)

1. **Tier 1 — PETSc + MUMPS + METIS** (`FULLMAG_FEM_WITH_SLEPC=1 && !defined(FULLMAG_OET0_DISABLE_MPI)` oraz `mpi_world_size == 1 || petsc_already_initialized`):
   - Konwersja `mfem::SparseMatrix` (CSR `GetI()/GetJ()/GetData()`, posortowane kolumny w wierszu) do `MATSEQAIJ` (`MatCreateSeqAIJWithArrays` / kopiowanie z prealokacją `MatSeqAIJSetPreallocation`).
   - Dla `Spd`: najpierw `PCCHOLESKY` + `MATSOLVERMUMPS` (`MatSetOption(A, MAT_SPD, PETSC_TRUE)`, `MatMumpsSetIcntl(F, 7, 5)` METIS); jeśli `KSPSetUp` zwróci błąd numeryczny (np. bliska półokreśloność), deterministyczny krok do `PCLU` + `MATSOLVERMUMPS`.
   - Dla `SymmetricIndefinite` oraz `GeneralNonsymmetric`: `KSPPREONLY` + `PCLU` + `MATSOLVERMUMPS` + `ICNTL(7)=5` (METIS) + `ICNTL(14)=50` (50% zapasu przestrzeni na opóźnione pivoty dla układów nieokreślonych/siodłowych, bez sztucznego shiftu na zerowej przekątnej — identyczny wzorzec jak w `modal_augmented_shift_solver.hpp:321-340`). Gdy `!defined(PETSC_HAVE_MUMPS)`, używa natywnego `PCLU` PETSc z `MAT_SHIFT_NONZERO` tylko dla macierzy nie-siodłowych (`resolved_solver = "petsc_default_lu"`).
   - **Iteracyjne doprecyzowanie po rozwiązaniu bezpośrednim:** po pierwszym `KSPSolve`, liczymy rezyduum $r = b - Ax$ w `long double` (rzadkie `SpMV` na oryginalnej macierzy `mfem::SparseMatrix`); jeśli $\|r\|_2 > \text{rtol} \cdot \max(\text{floor}, \|b\|_2)$, wykonujemy do `max_refinement_sweeps` (domyślnie 2) tanich podstawień wstecznych `KSPSolve(ksp, r, dx); x += dx;` na **już sfaktoryzowanej** macierzy!
   - Koszt kolejnego RHS (multi-RHS dla $T$ terminali lub 3 składowych $(H_x, H_y, H_z)$): **tylko jedno podstawienie trójkątne $O(\text{nnz}(L))$**!

2. **Tier 2 — HYPRE CPU** (aktywny gdy `FULLMAG_FEM_WITH_SLEPC=0`, lub `mpi_world_size > 1 && !petsc_initialized`, lub jawne `SparseCpuBackendPolicy::Hypre`; wymaga `MFEM_USE_MPI && !defined(FULLMAG_OET0_DISABLE_MPI)` oraz `configure_hypre_host_policy()` z `memory_location_host && execution_policy_host` oraz lokalnego testu tworzenia gniazda OpenMPI singleton `can_initialize_openmpi_singleton()` — analogicznego do prywatnej funkcji w `relaxation_math.cpp:296`, zaimplementowanego lokalnie w `sparse_linear_solver.cpp` bez sprzężenia z `relaxation_math.cpp`):
   - **`Spd`:** `mfem::HypreParMatrix` na `MPI_COMM_SELF` + zbudowany **raz** `mfem::HypreBoomerAMG` (wielokrotnie używany dla wszystkich $T$ prawych stron!) + `mfem::HyprePCG` z tolerancją wewnętrzną `0.1 * relative_tolerance` (margines certyfikacyjny).
   - **`GeneralNonsymmetric` (M1 `solve_spin` 3-polowy i M2 `solve_reciprocal` 4-polowy w układzie `mfem::Ordering::byNODES`):**
     - Pierwszy wybór: **Blokowo-diagonalny `HypreBoomerAMG` jako prawy prekondycjoner dla `mfem::GMRESSolver(kdim=100)`**: dla $d = \text{by\_nodes\_component\_count} \in \{3, 4\}$ wydobywa $d$ skalarnych bloków diagonalnych $A_{cc} \in \mathbb{R}^{n \times n}$ ($n = N/d$, każdy jest skalarnym operatorem dyfuzji-reakcji 3D w $H^1$!) i buduje niezależne hierarchie `HypreBoomerAMG(A_{cc})`. Ponieważ układ `byNODES` nie przeplata składowych, eliminuje to błąd użycia `SetSystemsOptions(d)` na macierzy nieprzeplatanej!
     - Jeśli GMRES + Block-AMG nie zbiegnie (np. ekstremalna dominacja skośnosymetrycznej precesji $\lambda_J \ll h$ lub silnego AHE), deterministyczna eskalacja w obrębie Tier 2 do `mfem::HypreGMRES` + `mfem::HypreILU` (`SetLevelOfFill(1)`, `SetType(0)` — blokowy ILU(1) w HYPRE obsługujący silne sprzężenia między składowymi).
   - **`SymmetricIndefinite`:** obsługiwany dedykowanymi prekondycjonerami fizycznymi (Sekcja 4.2: HYPRE `HypreAMS` + `HypreBoomerAMG` ze ścisłym uzupełnieniem Schura dla OE-F2; Sekcja 6.3: `HypreBoomerAMG` na $\tilde{S} = \beta^2 C_f \operatorname{diag}(M_f)^{-1} C_f^\top$ dla OE-T0 KKT).

3. **Tier 3 — MFEM Serial Fallback** (`FULLMAG_OET0_DISABLE_MPI=1` pod TSan, brak gniazda OpenMPI singleton, lub jawne `SparseCpuBackendPolicy::MfemSerial`):
   - `Spd`: `mfem::CGSolver` + `mfem::GSSmoother` (z tolerancją `0.1 * rtol`).
   - `GeneralNonsymmetric`: `mfem::GMRESSolver(kdim=100)` + **`mfem::GSSmoother`** (prekondycjonowany Gauss-Seidel zamiast dawnego nieprekondycjonowanego GMRES!).
   - `SymmetricIndefinite`: `mfem::MINRESSolver` + blokowy `GSSmoother`.

4. **Jawny tor GPU `cuDSS` (`SparseExecutionTarget::GpuCudss`):**
   - Kompilowany pod `#if FULLMAG_FEM_CUDSS_POISSON_ENABLED && FULLMAG_HAS_CUDA_RUNTIME`.
   - Gdy brak `cuDSS` w buildzie lub budżet VRAM (`resolve_demag_cudss_device_budget` + `CUDSS_DATA_MEMORY_ESTIMATES` z `cudss_direct_solver.hpp`) jest przekroczony, lub `CUDSS_DATA_INFO != 0`: **twardy błąd `std::runtime_error` (ZERO cichego fallbacku GPU→CPU!)**.
   - Dla `Spd`: `CUDSS_MTYPE_SPD`, `CUDSS_MVIEW_LOWER` (wspólna faktoryzacja raz, wielokrotne `CUDSS_PHASE_SOLVE` dla $T$ terminali!).
   - Dla `SymmetricIndefinite`: `CUDSS_MTYPE_SYMMETRIC`, `CUDSS_MVIEW_LOWER` ($LDL^\top$ z pivotingiem).
   - Dla `GeneralNonsymmetric`: `CUDSS_MTYPE_GENERAL`, `CUDSS_MVIEW_FULL` (LU).
   - Zawsze weryfikuje niezależne rezyduum na hoście (z opcjonalnym doprecyzowaniem iteracyjnym) przed zwróceniem wyniku.

---

## 4. Projekt szczegółowy — Track 1: Oersted Vector Potential OE-F2 (`vector_potential.{hpp,cpp}`)

### 4.1. Sformułowanie i symetryczna ekwilibracja skali

Układ mieszany $H_0(\mathrm{curl}) \times H^1_0$ na jednospójnej domenie ($\chi(\Omega) = 1$, $\beta_1 = 0$):
$$\begin{bmatrix} K_{\mathrm{curl}} & G \\ G^\top & 0 \end{bmatrix} \begin{bmatrix} A \\ p \end{bmatrix} = \begin{bmatrix} f \\ 0 \end{bmatrix}, \quad A|_{\partial\Omega,\tau} = 0, \quad p|_{\partial\Omega} = 0,$$
gdzie $(K_{\mathrm{curl}})_{ij} = \int_\Omega \mu_0^{-1} (\nabla \times w_i) \cdot (\nabla \times w_j)\,\mathrm{d}V \sim \mu_0^{-1} h^{-1}$, a $G_{ij} = \int_\Omega w_i \cdot \nabla \phi_j\,\mathrm{d}V \sim h^1$.

**Problem skali w nanometrach:** dla anteny o rozmiarze charakterystycznym $h = 10^{-8}\text{ m}$ mamy $\|K_{\mathrm{curl}}\| / \|G\| \sim \mu_0^{-1} h^{-2} \approx 8 \times 10^{21}$. Bez przeskalowania zarówno częściowe pivotowanie LU, jak i MINRES tracą cyfry znaczące w FP64!

**Rozwiązanie — dokładna symetryczna ekwilibracja:**
1. Eliminujemy w czasie $O(\text{nnz})$ istotne stopnie swobody brzegowe ($\Gamma_{ND}$ i $\Gamma_{H1}$) tworząc podukład wnętrza $(n_{ND,\mathrm{int}}, n_{H1,\mathrm{int}})$ (oryginalne `curl_matrix` i `gradient_matrix` zachowujemy nienaruszone dla niezależnej certyfikacji formy słabej!).
2. Obsługa przypadków brzegowych grubych siatek:
   - $n_{ND,\mathrm{int}} = 0 \implies A \equiv 0,\; p \equiv 0$.
   - $n_{ND,\mathrm{int}} > 0,\; n_{H1,\mathrm{int}} = 0$ (np. siatka $1\times 1\times 1$ lub $2\times 2\times 2$, gdzie wszystkie wierzchołki leżą na $\partial\Omega$): brak wewnętrznych modów gradientowych, więc $K_{\mathrm{curl,int}}$ jest **ściśle SPD** — rozwiązujemy $K_{\mathrm{curl,int}} A_{\mathrm{int}} = f_{\mathrm{int}}$ bezpośrednio przez `SparseLinearSolver(Spd)` i ustawiamy $p \equiv 0$!
3. Dla $n_{ND,\mathrm{int}} > 0$ i $n_{H1,\mathrm{int}} > 0$ obliczamy $\beta = \text{compute\_saddle\_point\_equilibration\_beta}(K_{\mathrm{curl,int}}, G_{\mathrm{int}}) = d_K / g_{\mathrm{rms}}$ i rozwiązujemy symetrycznie przeskalowany układ:
   $$\begin{bmatrix} K_{\mathrm{curl,int}} & \beta G_{\mathrm{int}} \\ \beta G_{\mathrm{int}}^\top & 0 \end{bmatrix} \begin{bmatrix} A_{\mathrm{int}} \\ \tilde{p}_{\mathrm{int}} \end{bmatrix} = \begin{bmatrix} f_{\mathrm{int}} \\ 0 \end{bmatrix}, \qquad p_{\mathrm{int}} = \beta \tilde{p}_{\mathrm{int}}.$$

### 4.2. Dwa skalowalne silniki liniowe (Tier 1 MUMPS + Tier 2 HYPRE AMS/BoomerAMG)

- **Tier 1 (PETSc + MUMPS LU z METIS — domyślny gdy `FULLMAG_FEM_WITH_SLEPC=1`):**
  Składa rzadką macierz CSR $S_\beta = \text{assemble\_equilibrated\_saddle\_point\_csr}(K_{\mathrm{curl,int}}, G_{\mathrm{int}}, \beta)$ i rozwiązuje przez `SparseLinearSolver(S_\beta, SymmetricIndefinite)` z do 2 krokami iteracyjnego doprecyzowania w `long double` na nieskalowanym rezyduum fizycznym. Złożoność pamięciowa $O(N^{4/3})$ zamiast $O(N^2)$; brak limitu 4096.
- **Tier 2 (HYPRE `HypreAMS` + `HypreBoomerAMG` `MINRES` — dla buildów CPU z `FULLMAG_FEM_WITH_SLEPC=0`):**
  Wykorzystuje ścisłą tożsamość ciągu de Rhama ($G = M_{ND}\Pi_\nabla$, $K_{\mathrm{curl}}\Pi_\nabla = 0$):
  $$(K_{\mathrm{curl}} + \gamma M_{ND})\Pi_\nabla = \gamma G \implies \beta^2 G^\top (K_{\mathrm{curl}} + \gamma M_{ND})^{-1} G = \frac{\beta^2}{\gamma} L_{H1} \quad \text{(ściśle!)}$$
  **Krytyczny wybór skalowania $\gamma$ (niezależność od $h$!):** ustawiamy $\gamma = \mu_0^{-1} L^{-2}$, gdzie $L = \operatorname{diam}(\Omega) > 0$ (przekątna prostopadłościanu ograniczającego siatkę). Z nierówności Poincarégo–Friedrichsa dla pól bezźródłowych ($\nabla\cdot u = 0$, $u|_{\partial\Omega,\tau}=0$) zachodzi $\mu_0^{-1}\|\nabla\times u\|^2 \ge C_P \gamma \|u\|^2$, dzięki czemu wartości własne bloku solenoidalnego skupiają się w $[C_P/(C_P+1), 1)$ **jednostajnie względem $h$, $L$ i $\mu_0$** (w tym dla $L = 10^{-7}\text{ m}$!), podczas gdy wartości własne w podprzestrzeni gradientowej/mnożnikowej wynoszą dokładnie $\pm 1$. *(Uwaga: użycie $\gamma = d_K/d_M \sim \mu_0^{-1} h^{-2}$ zdegenerowałoby wartości solenoidalne do $(h/L)^2 \to 0$ i złamało niezależność od $h$!)*
  - Ponieważ oba obrazy Docker budują MFEM z `-DMFEM_USE_METIS=NO` (`docker/fem-cpu/Dockerfile:90`, `docker/fem-gpu/Dockerfile:223,269`), konstruujemy `ParMesh` z jawną zerową partycją: `std::vector<int> part(mesh.GetNE(), 0); mfem::ParMesh pmesh(MPI_COMM_SELF, const_cast<mfem::Mesh &>(mesh), part.data());`.
  - W pełnowymiarowym operatorze blokowym `MINRES` o rozmiarze `(nd_dofs + h1_dofs)` z symetryczną eliminacją brzegową blok `(1,1)` **musi** mieć diagonalę `1.0` na istotnych DOF brzegowych $\Gamma_{H1}$ (`0.0` we wnętrzu — przez rzadką macierz brzegową `h1_bdr_identity`), aby wiersze $\Gamma_{H1}$ nie były zerowe/osobliwe!
  - Prekondycjoner SPD:
    $$\mathcal{P} = \operatorname{diag}\!\Big(\operatorname{HypreAMS}\big(K_{\mathrm{curl}} + \gamma M_{ND},\; V_{ND}\big),\;\; \operatorname{HypreBoomerAMG}\big(\tfrac{\beta^2}{\gamma} L_{H1}\big)\Big), \qquad \gamma = \frac{1}{\mu_0 L^2},$$
    rozwiązywany przez `mfem::MINRESSolver` (tolerancja wewnętrzna `0.1 * options.relative_tolerance`, ~25–50 iteracji niezależnie od $h$).
- **Tier 3 (fallback szeregowy bez MPI):** `MINRES` z `blkdiag(GSSmoother(K_curl + gamma*M_ND), GSSmoother((beta^2/gamma)*L_H1))` ($\gamma = \mu_0^{-1} L^{-2}$ i `h1_bdr_identity` w bloku `(1,1)`).

### 4.3. Rzadkie rezyduum formy słabej i rzadka projekcja $H \to H^1$ (`project_compatible_h_to_nodes`)

1. **Usunięcie gęstego bloku rezyduów (`vector_potential.cpp:303-332`):**
   - Usuwamy martwe wywołanie `matrix_vector_residual(block, ...)` oraz podwójne pętle $O(N^2)$ z `curl_matrix(row, col)` / `gradient_matrix(row, col)`.
   - Liczymy `first_block` i `constraint_block` przez 3 wywołania rzadkiego `SpMV`:
     ```cpp
     curl_matrix.Mult(a_vec, first_block);
     gradient_matrix.AddMult(p_vec, first_block);
     first_block -= current_load;
     // zeruj wiersze essential_nd_mask
     gradient_matrix.MultTranspose(a_vec, constraint_block);
     // zeruj wiersze essential_h1_mask
     ```
2. **Rzadka projekcja `project_compatible_h_to_nodes` (`:151-215`):**
   - Zachowujemy nazwę symbolu `project_compatible_h_to_nodes` (wymaganą przez `docs/physics/0980-dynamic-current-and-oersted-coupling.source-map.json:1360`!).
   - Zastępujemy `mfem::DenseMatrix mass_dense` + `mfem::DenseMatrixInverse` pojedynczą instancją `SparseLinearSolver(mass.SpMat(), Spd)` (jednorazowa faktoryzacja MUMPS Cholesky lub BoomerAMG PCG dla macierzy masy $M_{H1}$ o $\kappa = O(1)$!), rozwiązywaną 3 razy dla $(H_x, H_y, H_z)$.
   - Składamy wszystkie 3 wektory prawych stron $(r_x, r_y, r_z)$ w **jednym wspólnym przebiegu po elementach i punktach kwadratury** (jedno wywołanie `rt_h.GetVectorValue` zamiast trzech!), zachowując dokładność i identyczną bramkę rezyduum `mass.Mult(solution, residual); residual -= rhs;`.
3. **Podniesienie limitów DOF i zgodność z Rust IR:**
   - W `vector_potential.hpp`: `maximum_nd_dofs = 2'000'000;`, `maximum_h1_dofs = 1'000'000;` (z zachowaniem walidacji `> 0`, `nd_dofs <= options.maximum_nd_dofs`, `h1_dofs <= options.maximum_h1_dofs` oraz kontroli przepełnienia `nd_dofs <= INT_MAX - h1_dofs`).
   - W `crates/fullmag-ir/src/antenna.rs:60-61`: synchroniczne podniesienie `ANTENNA_VECTOR_POTENTIAL_MAX_ND_DOFS = 2_000_000` i `ANTENNA_VECTOR_POTENTIAL_MAX_H1_DOFS = 1_000_000` (zweryfikowano na `origin/master`: żaden test Rust nie przypina zahardkodowanego SHA od `4096`/`2048`).
   - W testach jednostkowych (`oersted_vector_potential_contract.cpp`): dodajemy lokalną wyrocznię gęstą wyłącznie na małej siatce (np. $3\times 3\times 3$, ~200 ND DOFs) do sprawdzenia zgodności $\le 10^{-12}$ między rozwiązaniem rzadkim a gęstym, ORAZ test skalowania powyżej dawnego limitu (`> 10'000` ND DOFs i `> 2'500` H1 DOFs) oraz test nanometrowy ($L = 10^{-7}\text{ m}$) i test grubej siatki (`n_{H1,int} == 0`).

---

## 5. Projekt szczegółowy — Track 2: Oersted Direct Tetra Quadrature OE-F1 (`direct_tetra_quadrature.{hpp,cpp}` + opcjonalny GPU CUDA)

### 5.1. Analiza precyzji i struktury algorytmicznej

W `direct_tetra_quadrature.cpp`:
- Każda para `(target, source)` dla $N_t$ punktów docelowych i $N_s$ źródłowych czworościanów RT0 jest ewaluowana na głębokości 0 parą rzędów `(low_order, high_order)`, a następnie adaptacyjnie dzielona przez deterministyczny kopiec maksimum dopóki suma błędów liści + wskaźnik zaokrągleń (`eps * ledger.magnitude`) nie zmieści się w `fma(rtol, |H|, atol)`.
- **99.5%+ par** to nieosobliwe pary dalekiego pola, które zbiegają na `depth = 0` bez rozbicia Duffy'ego i bez podziału ósemkowego.
- **Krytyczny wymóg precyzji:** dla par osobliwych (punkt docelowy wewnątrz, na ścianie, krawędzi lub wierzchołku czworościanu) i bliskiego pola (`decompose_target_tetrahedron == true` lub $d_{\min} \le 2.0\,h_{\text{tet}}$) arytmetyka `long double` (80-bitowa na x86_64) w `AffineRt0Element::current_at` (z odejmowaniem `x - v_k` przed sumowaniem) i kompensacja Kahana w `PairAccumulator` zapobiegają katastrofalnemu skracaniu cyfr.

### 5.2. Deterministyczna równoległość CPU (`CpuDeterministic` — domyślna, bit-exact 0 ULP!)

1. **Wstępna ekstrakcja płaskich tablic kwadratur (`QuadratureRuleTable`):**
   - `mfem::IntRules.Get(geom, order)` leniwie modyfikuje współdzielony cache **bez muteksu** — wywołanie z wielu wątków naruszałoby TSan!
   - Na wątku głównym, przed startem workerów, kopiujemy wszystkie wymagane reguły `TETRAHEDRON` i `SEGMENT` dla `order ∈ [base_order, base_order + 2*(max_depth + 1)]` do płaskich niemutowalnych tablic `std::vector<TetQuadPoint>` / `std::vector<SegQuadPoint>`. Eliminuje to wyścig danych pod TSan ORAZ usuwa narzut wywołań wirtualnych/cache'u MFEM w pętli wewnętrznej.
2. **Wyznaczenie liczby wątków `W` bez nowych zależności i bez zagnieżdżania OpenMP:**
   - Używamy wyłącznie standardowego `std::thread` (już linkowanego przez `Threads::Threads` w `fem_conservative_current_view_contract` i `fullmag_fem` — 100% kompatybilne z `FULLMAG_OET0_TSAN=ON`!).
   - Jeśli `options.worker_threads > 0`, używamy dokładnie `options.worker_threads`; gdy `0` (auto), odczytujemy ten sam budżet CPU co `cpu_threads` (`OMP_NUM_THREADS` / `FULLMAG_CPU_THREADS` / `hardware_concurrency()`, z bezpiecznym limitem do `min(available, max_useful_work)`).
3. **Dwupoziomowy podział deterministyczny:**
   - **Przypadek A — wiele celów ($N_t \ge 2W$, typowy skan 2D/3D lub węzły próbki):**
     - Każdy cel $t \in [0, N_t)$ ma w 100% niezależne `leaves`, `heap`, `ledger`, `sequence`, `target_diagnostics[t]`.
     - Pula $W$ wątków `std::thread` pobiera indeksy celów przez `std::atomic<std::size_t> next_target{0}` (dynamiczne równoważenie obciążenia — cele bliskie przewodnika wykonują adaptację Duffy'ego i są znacznie droższe od celów dalekich!).
     - Każdy wątek zapisuje wynik do własnego slotu `results[t]` (brak współdzielonych zapisów, zero lock-contention!).
     - **Globalny `WorkBudget` i dokładne liczniki:** współdzielone atomowe liczniki limitu z okresową kontrolą (np. co 256 próbek) i flagą `std::atomic<bool> stop_requested` do szybkiego przerywania przy przekroczeniu budżetu; każdy cel zlicza jednak **dokładną** liczbę swoich próbek i wizyt (`local_samples`, `local_visits`, nigdy nie zaokrąglaną do wielokrotności 256!), a po `join()` agregaty `diagnostics.kernel_evaluations` i `diagnostics.ledger_leaf_visits` są dokładną sumą pól `target_diagnostics[t]` (wymagane przez `scripts/test_antenna_quadrature_evidence_source.py:63,69`!). Wątki robocze przechwytują wyjątki przez `std::exception_ptr` + `catch (...)` (nigdy `catch (const std::runtime_error &)`, co jest zakazane przez `scripts/test_antenna_global_quadrature_source.py:113`!).
     - **Sekwencyjny obserwator postępu (`SurfaceRt0ProgressObserver`):** wątek główny (lub dedykowany mutex z licznikiem `emitted_completed`) wywołuje `observer->emit(..., completed, total, source_count)` ściśle monotonicznie `1, 2, ..., N_t` z jednego wątku (nigdy współbieżnie!).
     - **Deterministyczna redukcja końcowa:** po `join()` wątek główny redukuje `diagnostics` (`refined_pairs`, `maximum_pair_error_apm`, `kernel_evaluations`, `ledger_leaf_visits`) w ścisłej kolejności rosnącej $t = 0, 1, \dots, N_t - 1$.
     - **Gwarancja:** wynik `h_xyz_apm`, `target_diagnostics` i `diagnostics` jest **bitowo identyczny (0 ULP)** z wykonaniem jednowątkowym niezależnie od $W$!
   - **Przypadek B — mało celów ($1 \le N_t < 2W$) i duże źródło ($N_s \ge 128$):**
     - Dla każdego celu $t$ równolegle obliczamy pętlę korzeni (`source = 0 .. N_s - 1` w `evaluate_target`), zapisując wynik każdego liścia do `leaves[source]` (w tym `leaf.sequence = source`), a następnie na wątku głównym wykonujemy `ledger.add(leaves[source], 1)` i `enqueue(source)` w **ścisłej kolejności rosnącej `source = 0, 1, ..., N_s - 1`**! Również **bitowo identyczne (0 ULP)** z wersją szeregową!
4. **3× fuzja w `DirectTetraQuadrature::ProjectField` (`direct_tetra_quadrature.cpp:959-994`) i zgodność z testami źródłowymi Python:**
   - Obecnie `ProjectField` wywołuje `DirectScalarCoefficient::Eval` osobno dla składowych $x$, $y$ i $z$, obliczając ten sam 3-wektorowy punkt kwadratury **3 razy od nowa** (przekazując po 1 punkcie naraz, więc nigdy nie wyzwalał punktowego limitu `validate_pair_budget(source_count, target_count, options)`).
   - Zamiast tego zbieramy wszystkie punkty kwadratury docelowych czworościanów do jednego wektora `target_points` ($N_{\text{elem}} \cdot N_q$ punktów), wywołujemy **raz** `evaluate_prepared_unbounded_pairs(...)` (omijającą wyłącznie punktowy limit `maximum_source_target_pairs`, przy pełnym zachowaniu globalnego budżetu `WorkBudget` `kernel_evaluations` / `ledger_leaf_visits` — identycznie jak dotychczasowe 1-punktowe wywołania, bez fałszywego błędu `"pair budget exceeded"` gdy $N_s \cdot N_{\text{elem}} \cdot N_q > 10^6$!), składamy 3 wektory RHS $(b_x, b_y, b_z)$ w jednym przebiegu po elementach i rozwiązujemy 3 układy masy $M_{H1}$ ze wspólną faktoryzacją `SparseLinearSolver(Spd)`!
   - *Kontrakty źródłowe Python (`scripts/test_antenna_duffy_source.py`, `scripts/test_antenna_global_quadrature_source.py`):* zachowujemy pola `SegQuadPoint` nazwane `.x` i `.weight` (dla weryfikacji AST Duffy'ego), pojedyncze wystąpienia `inverse_kernel_denominator(distance)` i `-inverse_kernel_denominator(ray_norm)` oraz `work.sample()` przed `evaluate_current(` i `work.visit()`, a przestarzałe asercje 3-przebiegowej klasy `DirectScalarCoefficient` aktualizujemy w obu skryptach testowych w ramach wyłącznej własności Author 2!

### 5.3. Opcjonalna hybrydowa akceleracja CUDA GPU dla par dalekiego pola (`GpuHybridFarField`)

Aby osiągnąć przyspieszenie **10–100×** na dużych problemach 3D ($N_s \cdot N_t \ge 10^5$, np. $N_s = 10\,000$ czworościanów anteny $\times N_t = 4\,000$ celów = $4 \times 10^7$ par) **bez kompromisu na precyzji w osobliwościach**:

1. **Jawna polityka wyboru toru (`AGENTS.md` — zero cichego przekierowania CPU↔GPU):**
   - W `DirectTetraQuadratureOptions` dodajemy na końcu (z wartościami domyślnymi — zachowując zgodność inicjalizacji agregatowej w `frozen_direct_rt0.cpp:88-91`!):
     ```cpp
     enum class DirectTetraExecutionPolicy : std::uint32_t {
         CpuDeterministic = 0,
         GpuHybridFarField = 1,
     };
     // Na końcu DirectTetraQuadratureOptions:
     int worker_threads = 0; // 0 = auto from CPU thread budget
     DirectTetraExecutionPolicy execution_policy = DirectTetraExecutionPolicy::CpuDeterministic;
     ```
   - `CpuDeterministic` (domyślny dla wszystkich istniejących wywołań CPU/C ABI): nigdy nie dotyka CUDA.
   - `GpuHybridFarField` (jawnie opt-in): jeśli `FULLMAG_HAS_CUDA_RUNTIME=0` lub brak urządzenia CUDA, zwraca twardy błąd `std::runtime_error("direct tetrahedral Oersted GPU hybrid policy requires CUDA runtime")` (ZERO cichego fallbacku!).
2. **Podział fizyczno-numeryczny GPU (dalekie pole) vs CPU (bliskie pole i osobliwości):**
   - **Prekomputacja na hoście ($O(N_s)$):** dla każdego źródłowego czworościanu $s$ obliczamy środek kuli opisanej `center[3]`, promień $R_s$, objętościowy jakobian $|\det|$, 4 wierzchołki $v_{0..3}$ oraz 4 współczynniki `signed_coefficients_a[0..3]` i uploadujemy je w układzie SoA na GPU raz na wywołanie `evaluate_prepared`.
   - **Kryterium klasyfikacji pary $(t, s)$ na GPU:**
     Niech $d_c = \|x_t - c_s\|_2$. Jeśli $d_c \le 3.0\,R_s$ (strefa bliska/osobliwa — gwarantuje z dużym zapasem, że każdy punkt wewnątrz, na ścianie, krawędzi, wierzchołku lub w sąsiedztwie czworościanu trafia na CPU!): kernel ustawia flagę `pair_needs_cpu = 1` i natychmiast kończy parę (zero straty precyzji przy osobliwości!).
   - **Kwadratura dalekiego pola na GPU ($d_c > 3.0\,R_s$):**
     - Kernel 2D (blok po źródłach dla danego celu $t$, lub 1 wątek = 1 para `(t, s)` z deterministyczną redukcją po `s` w porządku rosnącym indeksów!).
     - **Precyzja 106-bitowa (*double-double* `TwoSum` / `TwoProd`):** ponieważ GPU nie ma sprzętowego 80-bitowego `long double`, akumulacja `sum += alpha_k * (x_c - v_{k,c})` (w `current_at`) oraz akumulacja po punktach kwadratury `low` i `high` używa kompensacji **TwoSum (106 bitów mantysy — dokładniejsze niż x86 `long double` o 64 bitach mantysy!)**.
     - Kernel wyznacza dla każdej nieosobliwej pary dalekiego pola: `high[3]`, `error = ||high - low||_2`, `weighted_norm_sum`, oraz flagę `needs_refine` (gdy `error` przekracza próg adaptacji celu lub wykryto `!isfinite`).
   - **Deterministyczne scalenie z CPU:**
     - Dla par dalekiego pola, które zbiegły na `depth = 0` (`pair_needs_cpu == 0` i `error <= local_target_hint`), redukcja GPU (w ścisłej kolejności rosnącej `s` per cel, z 106-bitowym `TwoSum`) zwraca sumaryczny wektor dalekiego pola, sumę błędów i sumę wag, podczas gdy lista par wymagających CPU (`pair_needs_cpu == 1` lub górne ogony błędów do kopca adaptacyjnego — typowo $< 1\%$ par!) jest przekazywana bezpośrednio do deterministycznej pętli CPU `evaluate_target` (z pełnym `long double` Duffy + adaptacją ósemkową + autorytatywną bramką `target_error_fits`!).
     - Uwaga na `TargetLedger` i `recompute_ledger`: aby zachować 100% ścisłości globalnej bramki docelowej `target_error_fits(estimated_error_apm, roundoff_indicator_apm, tolerance_apm)`, jeśli po dodaniu wkładu CPU globalna suma błędów dla celu $t$ nie mieści się jeszcze w tolerancji i największy błąd pochodziłby z pary dalekiego pola (rzadki przypadek przy bardzo ciasnej tolerancji `rtol = 1e-10`), GPU zwraca pełny kompaktowy wynik `Leaf` (lub flagę `requeue_far_pairs`), a CPU wciąga brakujące pary dalekiego pola do kopca i dzieli je adaptacyjnie — **zero utraty certyfikatu błędu!**
   - **Oczekiwana zgodność i wydajność:** zgodność CPU vs GPU-Hybrid $\le 10^{-13}$ względnie dla każdego celu (w tym celów wewnątrz/na krawędzi/na wierzchołku czworościanów, bo te są 100% na CPU Duffy!), przyspieszenie 20–80× na RTX 4080 SUPER dla $N_s \cdot N_t \ge 10^6$!

---

## 6. Projekt szczegółowy — Track 3: Transport ładunku i spinu + OE-T0 RT0 KKT

### 6.1. `SteadyTransportOracle` — Factor-Once Multi-RHS dla ładunku + Prekondycjonowane/Bezpośrednie M1/M2

1. **`solve_charge_terminal_currents` (`steady_transport.cpp:717-870`) — eliminacja $T$-krotnego montażu i faktoryzacji:**
   - Po walidacji terminali i bilansu prądów (bez zmian w `:721-804`) budujemy **RAZ**:
     - nieeliminowaną formę `mfem::BilinearForm diffusion_form(&scalar_space)` z `DiffusionIntegrator(conductivity)` (zachowaną do dokładnego obliczania słabych reakcji $r = K_{\mathrm{full}} V$ i eliminacji prawych stron przez `FullMult`),
     - zbiór `essential_true_dofs` (`all_terminals` + `add_unreferenced_component_gauges`),
     - wyeliminowaną macierz SPD `K_elim` (przez jedno wywołanie `FormLinearSystem` z zerowym wektorem `potential` — wyznacza strukturę `K_elim` oraz pełny operator `FullMult` obsługujący zarówno siatki zgodne, jak i niezgodne `GetConformingRestriction()`!),
     - pojedynczą faktoryzację **`SparseLinearSolver charge_solver(K_elim, config_spd)`** (Tier 1: MUMPS Cholesky/LU, Tier 2: `HypreBoomerAMG`+`HyprePCG`, Tier 3: `GSSmoother`+`CGSolver`, lub jawne `GpuCudss` SPD).
   - Dla każdego nietermicznego terminala źródłowego `source` ($T - C$ razy):
     - przygotowujemy wektor brzegowy `unit_potential` (`1.0` na terminalu `source`, `0.0` na pozostałych), rzutujemy go do współrzędnych true-DOF `true_bdr` (z `GetConformingRestriction()` gdy siatka niezgodna, identycznie jak `:680-694`!) i wyznaczamy prawą stronę przez **`diffusion_form.FullMult(true_bdr, rhs_full)`**: $b_{\mathrm{free}} = -(r_{\mathrm{full}})_{\mathrm{free}}$, $b_{\mathrm{ess}} = (\text{true\_bdr})_{\mathrm{ess}}$ ($O(\text{nnz})$ — zero ponownego montażu, 100% zgodność dla siatek niezgodnych!),
     - wywołujemy **`charge_solver.solve(system_rhs, solution)`** (jedno podstawienie trójkątne!),
     - weryfikujemy `stats.converged && stats.independent_relative_residual <= parameters.relative_tolerance`,
     - obliczamy słabą reakcję terminalową przez 1× `diffusion_form.FullMult(true_potential, weak_residual)` i odczytujemy kolumnę `response[terminal][source]` — **bez zbędnego `project_charge_current()` i bez kosztownych kwadratur objętościowych/brzegowych w pośrednich rozwiązaniach jednostkowych!**
   - Po rozwiązaniu gęstego bloku przewodności terminali $T \times T$ (`solve_terminal_response_block`), wywołujemy **TEN SAM `charge_solver.solve(...)`** dla końcowych napięć terminali, odzyskujemy `potential`, `last_charge_weak_residual`, `last_charge_marker`, uruchamiamy `project_charge_current()` i `accumulate_charge_diagnostics(...)` oraz weryfikujemy końcowe prądy terminali (`1e-8 * |I_req| + 1e-18`).
   - *Uwaga o bezpieczeństwie mutowalnego `conductivity`:* faktoryzacja żyje wyłącznie w ramach pojedynczego wywołania `solve_charge_terminal_currents` (lub `solve_charge`), więc zewnętrzna mutacja `mfem::Coefficient &conductivity` między wywołaniami nigdy nie zwróci przestarzałego czynnika!
   - W pojedynczym `solve_charge(...)` (`:619-715`): zastępujemy `GSSmoother` + `CGSolver` przez `SparseLinearSolver(matrix, config_spd)` (Tier 1 MUMPS / Tier 2 BoomerAMG PCG / Tier 3 GS-PCG).

2. **`solve_spin` (M1, `:872-956`) i `solve_reciprocal` (M2, `:958-1104`) — koniec nieprekondycjonowanego GMRES(100):**
   - `solve_spin`: `system_operator` jest rzadką macierzą `mfem::SparseMatrix` o wymiarze $3N \times 3N$ w układzie `mfem::Ordering::byNODES` (niesymetryczna przez $-c_J [m]_\times$). Zastępujemy nieprekondycjonowany `mfem::GMRESSolver` wywołaniem `SparseLinearSolver(matrix, config_nonsym)` z `by_nodes_component_count = 3`:
     - Tier 1: PETSc + MUMPS LU (`ICNTL(7)=5`, `ICNTL(14)=50`) + do 2 kroków iteracyjnego doprecyzowania,
     - Tier 2 (`SLEPC=0`): prawy prekondycjoner **Block-Diagonal `HypreBoomerAMG`** na 3 blokach skalarnych $(A_{00}, A_{11}, A_{22})$ w `GMRESSolver(kdim=100)` z automatyczną eskalacją do `HypreGMRES` + `HypreILU(1)` przy bardzo silnym sprzężeniu precesyjnym,
     - Tier 3 (TSan/serial): `GMRESSolver(kdim=100)` + `GSSmoother`.
   - `solve_reciprocal` (M2): identycznie na sprzężonej macierzy $4N \times 4N$ (`by_nodes_component_count = 4`, składowe $[V, \mu_x, \mu_y, \mu_z]$)!
   - Zachowujemy w 100% niezależne obliczanie `independent_relative_residual` (w `solve_reciprocal` dokładna formuła z `:1060-1070`!) oraz bilans momentu pędu `last_spin_weak_balance`.
   - W `project_torque` (`:1454-1555`): ponieważ `vector_space` ma układ `byNODES`, macierz masy dla 3 składowych momentu jest blokowo-diagonalna z 3 identycznymi blokami skalarnymi $M_{H1}$ — rozwiązujemy przez pojedynczy `SparseLinearSolver(scalar_mass, Spd)` dla 3 prawych stron zamiast 3× większej macierzy wektorowej + `CGSolver`/`GSSmoother`!

### 6.2. `ChargeTraceWorkspace` (`charge_trace_workspace.{hpp,cpp}`) — jednorazowa faktoryzacja ilorazowa w konstruktorze

- W `ChargeTraceWorkspace::Impl` konstruktor (`:100-211`) już buduje i mrozi na stałe macierz `matrix_`, tablicę `full_to_reduced_`, `electrical_roots_`, `component_gauge_dof_` oraz zbiór indeksów zakotwiczonych DOF `prototype_.potential_anchors`.
- **Krytyczna walidacja granic kotwic w konstruktorze:** dotychczas `charge_trace_workspace.cpp:100-211` nie sprawdzało zakresu `anchor.full_dof` w `Impl::Impl` (robiło to dopiero `Impl::solve` w `:322`). Przed indeksowaniem `full_to_reduced_[anchor.full_dof]` podczas budowy zredukowanej macierzy w konstruktorze **musimy** zweryfikować `0 <= anchor.full_dof && anchor.full_dof < count` (rzucając `std::invalid_argument("invalid charge trace potential anchor")`)!
- Ponieważ **struktura** swobodnych stopni swobody `free_index_` i zredukowanej macierzy ilorazowej `reduced_matrix_` zależy wyłącznie od topologii (indeksów `trace_relations` i `potential_anchors`), a **nigdy** od wartości liczbowych `trace_jumps_v` ani `anchor_potentials_v`:
  - Dodajemy addytywne pole `multiphysics::SparseCpuBackendPolicy cpu_backend = multiphysics::SparseCpuBackendPolicy::Auto;` na końcu `ChargeTraceSolveRequest` (pozwalając `periodic_charge_potential.cpp` przypiąć `Hypre` pod `reference_mpi_gather_rank0_broadcast` dla bitowej identyczności `n=1` vs `n=2`!).
  - W konstruktorze `ChargeTraceWorkspace::Impl` (raz!) budujemy `free_index_`, `free_count_`, `reduced_matrix_` i **`std::unique_ptr<multiphysics::SparseLinearSolver> reduced_solver_`** (`SparseMatrixKind::Spd`, respektując `request.cpu_backend`).
  - Każde kolejne wywołanie `ChargeTraceWorkspace::solve(trace_jumps_v, anchor_potentials_v) const` (`:290-554`, np. $C + 1 \le 65$ wywołań w `charge_current_response.cpp`!):
    1. Weryfikuje niezmienność topologii (`trace.full_to_reduced == full_to_reduced_`) i wyznacza wektor bazowy `potential` oraz `rhs` ($O(\text{nnz})$ — zero odbudowy `reduced_matrix`!),
    2. Wywołuje `reduced_solver_->solve(rhs, solution)` (jedno podstawienie trójkątne MUMPS lub ponowne użycie gotowej hierarchii BoomerAMG!),
    3. Zachowuje **w niezmienionej formie** pętlę niezależnej weryfikacji `long double` na oryginalnej macierzy `matrix_` dla każdej składowej elektrycznej (`:412-463`, z korektą na tym samym sfaktoryzowanym `reduced_solver_` gdy potrzebna!) oraz wszystkie bramki skoków, kotwic, cechowania i niezależnego rezyduum `H1` (`:468-543`)!
  - Ponieważ `reduced_solver_` powstaje w konstruktorze i nie jest mutowany podczas `solve(...) const`, wielowątkowe wywołania `solve(...) const` pozostają w 100% bezpieczne pod TSan!

### 6.3. OE-T0 RT0 KKT (`conservative_current_view.cpp` & `periodic_charge_potential.cpp`)

1. **Rzadki solver KKT w `solve_weighted_rt0_projection` (`conservative_current_view.cpp:2056-2253`):**
   - Zachowujemy niezmienioną analizę rzędu w dokładnej arytmetyce `ConservativeConstraintRank` (`conservative_constraint_rank.cpp`), zachowujemy wszystkie bramki fizyczne i `long double` weryfikację **wszystkich** więzów (łącznie z pominiętymi wierszami zależnymi i zerowymi śladami brzegowymi!) oraz dokładne tokeny sprawdzane przez `scripts/test_antenna_rt0_normalization_source.py:30-42` i `scripts/test_antenna_rt0_failure_diagnostics_source.py` (`kkt_solution[static_cast<int>(index)]`, `sparse_mass->Mult(full_solution, mass_full_solution);`, `weighted KKT residual exceeds`, `weighted correction energy is invalid`).
   - Zachowujemy próg małego gęstego wyroczni `sparse_kkt = global_dof_count > 4096` (z opcjonalnym nadpisaniem testowym lub nowym testem gęsty-vs-rzadki na małej siatce przez wydzieloną funkcję pomocniczą `solve_sparse_weighted_rt0_kkt(...)`, dzięki czemu parzystość rzadki↔gęsty jest weryfikowana bezpośrednio dla identycznej siatki, a dokumentacja `0981` i test `:5611` zachowują spójność!).
   - Gdy `request.reference_mpi_gather_broadcast == true`, przypinamy dla gałęzi `sparse_kkt` jednolitą jednorangową politykę `Tier 2` (`MPI_COMM_SELF` Schur-AMG `MINRES`) niezależnie od `world_size` (bitowa identyczność `n=1` vs `n=2`!).
   - Wewnątrz gałęzi `sparse_kkt`:
     - **Przypadek `constraint_count == 0`:** `SparseLinearSolver(free_mass, Spd)`.
     - **Przypadek `constraint_count > 0`:**
       - Obliczamy symetryczny skalar ekwilibracji $\beta = \text{compute\_saddle\_point\_equilibration\_beta}(M_f, C_f^\top)$.
       - **Tier 1 (`FULLMAG_FEM_WITH_SLEPC=1 && !FULLMAG_OET0_DISABLE_MPI && !mpi_pinned_lane && world_size == 1`):**
         Składamy rzadką macierz CSR $K_\beta = \text{assemble\_equilibrated\_saddle\_point\_csr}(M_f, C_f^\top, \beta)$ i faktoryzujemy ją **raz** przez `SparseLinearSolver(K_\beta, SymmetricIndefinite)` (PETSc + MUMPS LU + METIS `ICNTL(7)=5` + `ICNTL(14)=50`). Następnie wykonujemy istniejącą niezależną bramkę `measure_true_residual()` w `long double` (`:2173-2228`); jeśli nie jest jeszcze spełniona po pierwszym rozwiązaniu, uruchamiamy do 4 kroków iteracyjnego doprecyzowania na **tym samym sfaktoryzowanym obiekcie MUMPS** (czas <5 ms na krok zamiast dziesiątek tysięcy iteracji MINRES!).
       - **Tier 2 (`FULLMAG_FEM_WITH_SLEPC=0`, `mpi_pinned_lane`, lub `world_size > 1`, z `MFEM_USE_MPI && !FULLMAG_OET0_DISABLE_MPI`):**
         Budujemy rzadką SPD aproksymację uzupełnienia Schura:
         $$\tilde{S} = \beta^2 \tilde{C}_f \operatorname{diag}(M_f)^{-1} \tilde{C}_f^\top,$$
         gdzie $\tilde{C}_f$ równa się $C_f$ dla wszystkich wierszy dywergencji/parowania (stopień $\le 4$), a ewentualne bardzo gęste wiersze prądów terminalowych (stopień $> 64$) są w samym prekondycjonerze $\tilde{S}$ reprezentowane diagonalnie ($\beta^2 \sum_j C_{ij}^2 / (M_f)_{jj}$), zapobiegając wypełnieniu $O(|F_{\text{term}}|^2)$! Prekondycjoner $\mathcal{P} = \operatorname{diag}(\operatorname{GSSmoother}(M_f),\; \operatorname{HypreBoomerAMG}(\tilde{S}))$ dla `MINRES` redukuje liczbę iteracji ze $100\,000+$ do ~30–60, zachowując 100% dokładności operatora KKT i pełną pętlę `measure_true_residual()`!
       - **Tier 3 (`FULLMAG_OET0_DISABLE_MPI=1`, czyli TSan):** $\beta$-ekwalibrowany `MINRES` z `blkdiag(GSSmoother(M_f), GSSmoother(\tilde{S}))` — zero wywołań MPI/PETSc, 100% czysty TSan!
2. **`solve_external_lead_potential` (`conservative_current_view.cpp:2513-2525`) i `periodic_charge_potential.cpp:1233`:**
   - W `solve_external_lead_potential`: zastępujemy `GSSmoother` + `CGSolver` wywołaniem `SparseLinearSolver(free_matrix, Spd)` (z przypięciem `Hypre` gdy `reference_mpi_gather_broadcast`).
   - W `periodic_charge_potential.cpp:1233`: plik deleguje już całe rozwiązanie do `solve_charge_trace_workspace(trace_request)` — ustawiamy jedynie `trace_request.cpu_backend = request.reference_mpi_gather_rank0_broadcast ? SparseCpuBackendPolicy::Hypre : SparseCpuBackendPolicy::Auto;` dla bitowej identyczności `n=1` vs `n=2`!

### 6.4. Proweniencja, C ABI i kompatybilność non-MFEM / CPU / GPU

- **Brak łamiących zmian ABI:** żadna istniejąca struktura w `native/include/fullmag_fem.h` nie zmienia rozmiaru ani offsetów (`crates/fullmag-fem-sys` 53/53 bez naruszeń!).
- **Addytywne pola diagnostyczne C++ i JSON:**
  - `VectorPotentialDiagnostics` zyskuje na końcu pola z wartościami domyślnymi: `resolved_linear_solver`, `linear_iterations`, `linear_solve_ms`, `nodal_projection_ms`.
  - `ChargeSolveDiagnostics` i `SpinSolveDiagnostics` zyskują na końcu `std::string resolved_solver;` (domyślnie `""`).
  - `steady_transport_c_api.cpp`: addytywnie dopisuje `"resolved_charge_solver"` / `"resolved_spin_solver"` / `"resolved_linear_solver"` w `diagnostics_json` (sprawdzone: żaden test C++/Rust nie parsuje `diagnostics_json` z `deny_unknown_fields` — testy sprawdzają obecność kluczy podciągami `strstr` lub selektywnym odczytem JSON; mimo to weryfikujemy wszystkie testy `steady_transport_abi_contract`, `charge_transport_abi_contract`, `steady_transport_rt0_contract` i `fullmag-runner`!).
- **Ścisła ochrona `FULLMAG_HAS_MFEM_STACK=0`:** `sparse_linear_solver.{hpp,cpp}` jest kompilowany wyłącznie w gałęzi `if(FULLMAG_USE_MFEM_STACK)` w `backends/fem/CMakeLists.txt`; `steady_transport_c_api.cpp` i `frozen_direct_rt0.cpp` nie dołączają nagłówków MFEM/PETSc/CUDA poza `#if FULLMAG_HAS_MFEM_STACK`.

---

## 7. Podział własności plików (ZERO nakładania się w Fazie 1)

| Faza / Rola | Wyłączna lista plików (ZERO kolizji w Fazie 1) |
|---|---|
| **Faza 0: `coordinator` (Pre-Fanout Seam Commit)** | **Create:** `backends/fem/cpu/mfem/common/sparse_linear_solver.{hpp,cpp}`, `backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.hpp`, szkielet `backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu`, `backends/fem/tests/sparse_linear_solver_contract.cpp`<br>**Modify (szwy nagłówkowe + jednorazowe okablowanie CMake):** `backends/fem/CMakeLists.txt`, `backends/fem/cpu/mfem/interactions/oersted/vector_potential.hpp`, `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp`, `backends/fem/cpu/mfem/transport/steady_transport.hpp` |
| **Faza 1 — Author 1: `oersted-vp-author`** | `backends/fem/cpu/mfem/interactions/oersted/vector_potential.cpp`, `backends/fem/tests/oersted_vector_potential_contract.cpp`, `backends/fem/tests/steady_transport_rt0_contract.cpp`, `crates/fullmag-ir/src/antenna.rs`, `docs/physics/0980-dynamic-current-and-oersted-coupling.{md,source-map.json}` |
| **Faza 1 — Author 2: `direct-tetra-author`** | `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp`, `backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu` (wypełnienie szkieletu z Fazy 0), `backends/fem/cpu/mfem/workflows/antenna_field_solve/frozen_direct_rt0.cpp`, `backends/fem/tests/oersted_direct_tetra_contract.cpp`, `scripts/test_antenna_duffy_source.py`, `scripts/test_antenna_global_quadrature_source.py`, `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.{md,source-map.json}` |
| **Faza 1 — Author 3: `transport-author`** | `backends/fem/cpu/mfem/transport/steady_transport.cpp`, `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.{hpp,cpp}`, `backends/fem/cpu/mfem/transport/conservative_current_view.cpp`, `backends/fem/cpu/mfem/transport/periodic_charge_potential.cpp`, `backends/fem/tests/steady_transport_contract.cpp`, `backends/fem/tests/conservative_current_view_contract.cpp`, `docs/physics/0970-spin-hall-drift-diffusion-transport.{md,source-map.json}`, `docs/physics/0981-fem-oet0-sparse-kkt.{md,source-map.json}` |
| **Faza 2: Integracja + Weryfikator (`multiphysics-verifier`)** | `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp`, `docs/physics/1005-fem-multiphysics-sparse-and-parallel-solvers.{md,source-map.json}` + pełna macierz 5 profili buildów (non-MFEM, CPU-bez-SLEPc, TSan, 2-rank MPI, GPU) + walidatory dokumentacji + benchmarki A/B w Docker DEV |

---

## 8. Plan dokumentacji naukowej (`scientific-documentation-contract`)

Aby przejść `validate_scientific_docs.py`, `validate_changed_scientific_docs.py --base origin/master --head HEAD` oraz `scripts/check_repo_consistency.py`:
1. **Aktualizacje istniejących właścicieli domenowych (z ich `.source-map.json`):**
   - `docs/physics/0980-dynamic-current-and-oersted-coupling.{md,source-map.json}` — aktualizacja sekcji OE-F2 (usunięcie opisu gęstej odwrotności / limitu 4096/2048; opis symetrycznie ekwalibrowanego rzadkiego układu siodłowego MUMPS/HYPRE AMS+BoomerAMG oraz rzadkiej projekcji `project_compatible_h_to_nodes`, zachowując istniejące kotwice symboli).
   - `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.{md,source-map.json}` — aktualizacja realizacji OE-F1 `DirectTetraQuadrature` (płaskie tablice kwadratur, deterministyczna wielowątkowość `std::thread` 0-ULP, fuzja `ProjectField` oraz jawna opt-in hybryda CUDA GPU dalekiego pola z 106-bitowym `TwoSum` i CPU Duffy dla bliskich/osobliwych par).
   - `docs/physics/0970-spin-hall-drift-diffusion-transport.{md,source-map.json}` — aktualizacja realizacji solverów M1/M2 (factor-once multi-RHS dla ładunku i `ChargeTraceWorkspace`, MUMPS LU / Block-Diagonal BoomerAMG+ILU GMRES dla niesymetrycznego spinu i M2, jawny opt-in `GpuCudss` bez zmiany kontraktu v1/v2/v3 ABI).
   - `docs/physics/0981-fem-oet0-sparse-kkt.{md,source-map.json}` — aktualizacja rzadkiego toru OE-T0 KKT (ekwilibracja $\beta$, Tier 1 PETSc+MUMPS LU z `long double` doprecyzowaniem iteracyjnym, Tier 2 Schur-AMG $\tilde{S} = \beta^2 \tilde{C}_f \operatorname{diag}(M_f)^{-1} \tilde{C}_f^\top$ w `MINRES`, zachowanie toru TSan bez MPI).
2. **Nowa zbiorcza nota realizacyjna (numer `1005` — bez kolizji z innymi falami):**
   - `docs/physics/1005-fem-multiphysics-sparse-and-parallel-solvers.{md,source-map.json}` — pełne 15 sekcji z `AGENTS.md` / `.agents/instructions/scientific.md` (równania z jednostkami SI, ekwilibracja siodłowa $\beta$, tożsamość Schura ciągu de Rhama dla AMS+BoomerAMG, klasyfikacja dalekiego/bliskiego pola $d_c > 3R_s$ z arytmetyką 106-bitową *double-double*, polityka CPU/GPU i proweniencja, macierz buildów, kryteria walidacji, wyniki A/B i zakres odroczony — promocja `GPU_DOUBLE` na publicznym ABI transportu).

---

## 9. Plan benchmarków A/B (Docker DEV — przed vs po na `origin/master` `9ab99132d5`)

Wszystkie benchmarki wykonywane wewnątrz zarządzanego kontenera Docker DEV (`just docker-dev`, **bez** gołego `docker run`) z zapisem surowych wyników JSON/CSV do katalogu artefaktów:

1. **Benchmark A — Oersted Vector Potential OE-F2 (skalowanie i parzystość):**
   - *Mała siatka kontrolna* ($6\times 6\times 6$ tets, $N_{ND} \approx 1\,800$, $N_{H1} \approx 343$): pomiar `origin/master` (gęste `DenseMatrixInverse`) vs Tier 1 (PETSc+MUMPS LU) vs Tier 2 (`SLEPC=0` HYPRE AMS+BoomerAMG MINRES) — czas `Evaluate`, szczytowy RSS, zgodność $\|A - A_{\text{dense}}\|_\infty / \|A_{\text{dense}}\|_\infty \le 10^{-12}$, $\|H_{\text{nodal}} - H_{\text{nodal,dense}}\|_\infty / \|H_{\text{nodal,dense}}\|_\infty \le 10^{-12}$.
   - *Duże siatki produkcyjne (wcześniej niemożliwe — odrzucane przez limit `4096`/`2048`!)*:
     - $10\times 10\times 10$ tets ($N_{ND} \approx 7\,700$, $N_{H1} \approx 1\,331$),
     - $16\times 16\times 16$ tets ($N_{ND} \approx 30\,000$, $N_{H1} \approx 4\,913$),
     - $20\times 20\times 20$ tets ($N_{ND} \approx 58\,000$, $N_{H1} \approx 9\,261$).
   - Kryterium sukcesu: wszystkie rezydua (`first_block`, `constraint`, `compatible_divergence`, `nodal_projection`) $\le 10^{-10}\cdot\text{scale}$; czas dla 30k ND DOF $< 2\text{ s}$ (Tier 1 MUMPS) i $< 5\text{ s}$ (Tier 2 HYPRE AMS+BoomerAMG).

2. **Benchmark B — Oersted Direct Tetra Quadrature OE-F1 (czas wykonania i determinizm):**
   - *Konfiguracja:* $N_s = 3\,072$ czworościanów źródłowych ($8\times 8\times 8$ tets) $\times N_t = 1\,024$ punktów docelowych (mieszanka 98% dalekiego pola + 2% punktów na ścianach/krawędziach/wewnątrz źródła), `order=4`, `max_depth=6`, `rtol=1e-5` ($3.15 \times 10^6$ par — profil `4'000'000`!).
   - *Porównanie:*
     - Baseline `origin/master` (1 wątek CPU),
     - Nowy `CpuDeterministic` (`W=1`, `W=4`, `W=8`, `W=16` wątków): weryfikacja **bit-exact `memcmp == 0`** względem `W=1` i oczekiwanego przyspieszenia $\ge 6\times$ (8 wątków) / $\ge 10\times$ (16 wątków),
     - Nowy `GpuHybridFarField` (RTX 4080 SUPER): weryfikacja błędu względnego $\le 10^{-13}$ vs CPU `long double` na wszystkich 1024 celach (w tym punktach osobliwych!) i oczekiwanego przyspieszenia **$\ge 20\times$ względem baseline 1-wątkowego** (i $\ge 3\times$ vs 16-wątkowe CPU),
     - `ProjectField` na siatce docelowej $6\times 6\times 6$: porównanie 3-przebiegowego baseline vs 1-przebiegowej fuzji wielowątkowej (cel: $\ge 15\times$).

3. **Benchmark C — Transport ładunku i spinu (M1/M2 multi-terminal, `ChargeTraceWorkspace`, OE-T0 RT0 KKT):**
   - *C1 — 8-terminalowa struktura H1* ($16\times 16\times 8$ tets, $N \approx 2\,600$ wierzchołków, $T = 8$ terminali): `origin/master` ($8\times$ montaż + `GSSmoother`/`CGSolver`) vs nowy factor-once multi-RHS (Tier 1 MUMPS Cholesky, Tier 2 BoomerAMG PCG, oraz `GpuCudss` SPD) — cel: **$\ge 15\times$ przyspieszenia**, zgodność napięć i prądów $\le 10^{-11}$.
   - *C2 — `ChargeTraceWorkspace` + `ChargeCurrentResponse`* ($8$ kolumn sterowań, $16\times 16\times 8$ tets): baseline vs skeszowany factor-once w konstruktorze — cel: **$\ge 10\times$ przyspieszenia**, identyczne wyniki w tolerancji $\le 10^{-12}$.
   - *C3 — M1 `solve_spin` i M2 `solve_reciprocal` z silną precesją i AHE* ($12\times 12\times 12$ tets, $\lambda_J = 0.05\,L$, $\sigma_{\text{AHE}} \neq 0$, $\sigma_\parallel / \sigma_\perp = 1.5$): `origin/master` nieprekondycjonowany `GMRES(100)` (stagnacja/wolna zbieżność) vs Tier 1 MUMPS LU vs Tier 2 Block-Diagonal BoomerAMG/ILU GMRES — cel: **$\ge 20\times$ przyspieszenia** i zbieżność $\le 10^{-12}$ tam, gdzie baseline przekracza `max_iter`!
   - *C4 — OE-T0 RT0 KKT (`conservative_current_view.cpp`)* na siatce $10\times 10\times 10$ tets ($\sim 12\,600$ ścian RT0 + $6\,000$ więzów = $\sim 18\,600$ DOF KKT): `origin/master` `MINRES` + `Identity` vs Tier 1 PETSc+MUMPS LU + `long double` refinement vs Tier 2 Schur-AMG `MINRES` — cel: **$\ge 30\times$ przyspieszenia** (Tier 1) i **$\ge 10\times$** (Tier 2), pełna zgodność certyfikatów bilansu $\le 10^{-12}$.
