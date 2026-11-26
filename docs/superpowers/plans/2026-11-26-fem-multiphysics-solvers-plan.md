# Pakiet FEM Multiphysics Solvers Modernization (Wave 2 / PR B — P1 #5) — Plan Implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Realizacja w roju: **Faza 0** (wspólny szew + `sparse_linear_solver.{hpp,cpp}` + jednorazowe okablowanie `CMakeLists.txt` i szkielet `.cu`) $\to$ **Faza 1** (3 równoległych autorów z **ZERO** nakładaniem się plików i pełną niezależną kompilacją/testowaniem w izolowanych worktree) $\to$ **Faza 2** (addytywna telemetria w `steady_transport_c_api.cpp`, nowa nota `1005`, pełna macierz 5 profili buildów, walidatory dokumentacji i benchmarki A/B w Docker DEV).

**Goal:** Zmodernizować trzy wąskie gardła solverów multifizycznych FEM na bazie już zlinkowanych bibliotek (PETSc/MUMPS/METIS, HYPRE BoomerAMG/AMS/ILU, `std::thread`, CUDA/cuDSS): (1) zastąpić gęste $O(N^3)$ macierze i limit 4096/2048 w Oersted OE-F2 (`vector_potential`) rzadkim, ekwalibrowanym solverem siodłowym i rzadką projekcją masy $H \to H^1$; (2) przyspieszyć OE-F1 (`direct_tetra_quadrature`) deterministyczną 2-poziomową równoległością CPU (0 ULP), fuzją 3× `ProjectField` oraz jawnym opt-in akceleratorem CUDA GPU dalekiego pola z 106-bitowym `TwoSum` i CPU Duffy dla par osobliwych/bliskich; (3) zastąpić powtarzany montaż/CG w wieloterminalowym transporcie ładunku (`steady_transport`, `charge_trace_workspace`), nieprekondycjonowany GMRES(100) w M1/M2 (`solve_spin`, `solve_reciprocal`) oraz `MINRES+Identity` w OE-T0 RT0 KKT (`conservative_current_view`) jednorazową faktoryzacją (*factor-once multi-RHS*) i nowoczesnymi prekondycjonerami rzadkimi.

**Architecture:** Jeden wspólny, bezpieczny wielowątkowo moduł `backends/fem/cpu/mfem/common/sparse_linear_solver.{hpp,cpp}` (Faza 0, wpięty do `backends/fem/CMakeLists.txt` raz w Fazie 0 wraz ze szkieletem `direct_tetra_farfield_kernels.cu`) udostępnia klasę `SparseLinearSolver` z 3-poziomową hierarchią CPU (`PETSc+MUMPS+METIS` $\to$ `HYPRE BoomerAMG/Block-AMG/ILU` $\to$ `MFEM serial` dla TSan/non-MPI) oraz jawnym opt-in torem `GpuCudss` z preflightem VRAM (zero cichego fallbacku GPU→CPU). Trzy rozłączne tory Fazy 1 konsumują ten szew bez jakiegokolwiek nakładania się plików i przechodzą własne CTesty samodzielnie: `oersted-vp-author` (OE-F2 + `crates/fullmag-ir`), `direct-tetra-author` (CPU `std::thread` + `direct_tetra_farfield_kernels.cu`), `transport-author` (`steady_transport`, `charge_trace_workspace`, `conservative_current_view`, `periodic_charge_potential`).

**Tech Stack:** C++20, CUDA (`nvcc`), MFEM v4.10, HYPRE v2.32/v3.1 (`BoomerAMG`, `AMS`, `HyprePCG`, `HypreGMRES`, `HypreILU`), PETSc v3.24.6 + MUMPS + METIS (`PETSC::petsc`), NVIDIA cuDSS 0.8+, `std::thread`, Rust (`fullmag-ir`, `fullmag-fem-sys`, `fullmag-runner`), CMake/CTest, Cargo, Docker DEV (`just docker-dev`).

**Spec:** [2026-11-26-fem-multiphysics-solvers-design.md](../specs/2026-11-26-fem-multiphysics-solvers-design.md)

## Global Constraints

- Baza: `origin/master` (`9ab99132d5`); zero nowych zależności zewnętrznych w Docker/CMake (używamy wyłącznie zlinkowanych MFEM, HYPRE, PETSc/MUMPS/METIS, `Threads::Threads`, CUDA/cuDSS).
- Kompatybilność 5 profili buildów: `FULLMAG_HAS_MFEM_STACK=0` (bootstrap CI), `FULLMAG_FEM_WITH_SLEPC=0` (`fem-cpu` domyślny), `FULLMAG_FEM_WITH_SLEPC=1` (CPU+SLEPc), `FULLMAG_HAS_CUDA_RUNTIME=1` + `FULLMAG_FEM_CUDSS_POISSON_ENABLED=1` (GPU), oraz `FULLMAG_OET0_TSAN=ON` (`FULLMAG_OET0_DISABLE_MPI=1`, bez linkowania/wywoływania MPI i PETSc pod TSan — zachowanie `scripts/test_audit_fem_cpu_only_runtime.py:295-319`).
- Ścisły kontrakt proweniencji i torów (`AGENTS.md`): brak cichego fallbacku GPU→CPU dla jawnych żądań GPU (`GpuCudss`, `GpuHybridFarField`); brak wywoływania GPU na żądaniu CPU (`Cpu`, `CpuDeterministic`); zachowanie negatywnych bramek C ABI v1/v2/v3 (`FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE` $\to$ `FULLMAG_FEM_ERR_UNAVAILABLE` w `steady_transport_abi_contract.cpp` i `charge_transport_abi_contract.cpp`); zero łamiących zmian rozmiaru/offsetów w `native/include/fullmag_fem.h`.
- Bezpieczeństwo PETSc/HYPRE/MPI: każde użycie PETSc pod `fullmag::fem::runtime::petsc_slepc_process_mutex()` + `register/unregister_petsc_slepc_live_cpu_graph_locked()` + `PetscPushErrorHandler(PetscReturnErrorHandler, nullptr)`; gdy `reference_mpi_gather_rank0_broadcast` lub `reference_mpi_gather_broadcast` jest włączone, przypnij tę samą jednorangową politykę `SparseCpuBackendPolicy::Hypre` na `MPI_COMM_SELF` dla `n=1` i `n=2` (zachowanie `fem_conservative_current_view_mpi_byte_identity`!), a dodatkowo utrzymaj straż `world_size > 1 && !petsc_initialized` przeciw kolektywnemu `PetscInitializeNoArguments()`; przed każdym CPU HYPRE obowiązkowe `configure_hypre_host_policy()` + sprawdzenie **obu** pól `memory_location_host && execution_policy_host` + lokalna sonda gniazda OpenMPI singleton (`can_initialize_openmpi_singleton()` w `sparse_linear_solver.cpp`); wszystkie opcjonalne makra chronione przez `#if defined(M) && M`.
- Zachowanie istniejących nazw symboli w `.source-map.json` (`project_compatible_h_to_nodes`, `DirectTetraQuadrature::ResolveWorkLimits`, `WorkBudget`, `norm`, `integrate_duffy_once`, `evaluate_target`, `ChargeTraceWorkspace::Impl::{is_component_constant_control, require_control_topology, vertex_index_for_full_dof}`, `SteadyTransportOracle::{solve_charge, solve_spin, solve_reciprocal}`, `solve_weighted_rt0_projection`, `solve_dense_kkt`, `class ConservativeCurrentView`) oraz tokenów skryptów `scripts/test_antenna_*_source.py`, a także przejście `validate_scientific_docs.py`, `validate_changed_scientific_docs.py --base origin/master --head HEAD` i `scripts/check_repo_consistency.py`.
- Wszystkie komendy budowania, CTest, Cargo i benchmarków A/B wykonywane w zarządzanym Docker DEV (`just docker-dev`), nigdy przez gołe `docker run` z katalogami cache na hoście.

## Review Focus

1. **Wielorangowe MPI (`n=1` vs `n=2` bitowa identyczność + deadlock guard), TSan (`FULLMAG_OET0_DISABLE_MPI=1`) i polityka hosta CUDA-HYPRE w `SparseLinearSolver`** — ścieżki `reference_mpi_gather_*_broadcast` muszą używać tej samej jednorangowej polityki `SparseCpuBackendPolicy::Hypre` na `MPI_COMM_SELF` zarówno dla `n=1`, jak i `n=2` (aby `fem_conservative_current_view_mpi_byte_identity` nie złamał się pod `FULLMAG_FEM_WITH_SLEPC=1`), a `sparse_linear_solver.cpp` zachowuje dodatkową straż `world_size > 1 && !petsc_initialized` przeciw zakleszczeniu kolektywnym `PetscInitializeNoArguments()`; pod `FULLMAG_OET0_TSAN=ON` nie wolno wywoływać ani linkować PETSc/MPI; w binarkach z `FULLMAG_FEM_HYPRE_GPU_BUILD=1` przy `CUDA_VISIBLE_DEVICES=""` lub aktywnym kontekście GPU HYPRE na CPU musi sprawdzać **oba** pola `memory_location_host && execution_policy_host` bez awarii `cudaMalloc` i bez nadpisywania stanu GPU. *(Przypięte do: Zadanie 0 `sparse_linear_solver_contract.cpp`, Zadanie 3 `conservative_current_view_contract.cpp`, Zadanie 4 TSan i `fem_conservative_current_view_mpi_byte_identity`.)*
2. **Ekwilibracja OE-F2 w skali nanometrowej ($L = 10^{-7}\text{ m}$, $\|K_{\mathrm{curl}}\|/\|G\| \sim 10^{22}$), poprawne $\gamma = \mu_0^{-1} L^{-2}$ w `HypreAMS`, nieosobliwy blok `(1,1)` na $\Gamma_{H1}$, gruba siatka z $n_{H1,\mathrm{int}} = 0$ oraz jawne odrzucanie małych limitów DOF** — układ siodłowy z $\beta = d_K / g_{\mathrm{rms}}$ i $\gamma = \mu_0^{-1} L^{-2}$ (z jawną zerową partycją dla `ParMesh` przy `MFEM_USE_METIS=NO` oraz `h1_bdr_identity` na $\Gamma_{H1}$ w bloku `(1,1)`) musi osiągać rezyduum $\le 10^{-10}\cdot\text{scale}$ dla $L = 10^{-7}\text{ m}$ zarówno w Tier 1 (MUMPS), jak i w Tier 2 (HYPRE AMS+BoomerAMG); siatka bez wewnętrznych wierzchołków ($n_{H1,\mathrm{int}} = 0$) musi rozwiązywać blok SPD bez pustych bloków PETSc/HYPRE; jawnie małe/niedodatnie `maximum_nd_dofs` / `maximum_h1_dofs` muszą nadal rzucać `std::invalid_argument`, a domyślne limity muszą skalować się powyżej `10'000` ND DOF. *(Przypięte do: Zadanie 1 `oersted_vector_potential_contract.cpp`.)*
3. **Brak wyścigu w `mfem::IntRules.Get`, bitowy determinizm 0 ULP (`worker_threads` 1 vs 4 vs 8), dokładny `WorkBudget` i testy źródłowe Python, brak fałszywego pair-cap w `ProjectField` oraz bezpieczne przekazanie bliskich/osobliwych par GPU→CPU w `DirectTetraQuadrature`** — płaskie tablice kwadratur (z polami `.x`, `.weight` w `SegQuadPoint`) muszą być wyekstrahowane przed startem `std::thread`; wątki muszą używać `std::exception_ptr` + `catch (...)` (nigdy `catch (const std::runtime_error &)`); sumy `target_diagnostics[t].{kernel_evaluations, ledger_leaf_visits}` muszą być dokładnie równe agregatom w `diagnostics`; `ProjectField` omija punktowy `maximum_source_target_pairs` zachowując wspólny `WorkBudget`; pod `GpuHybridFarField` każda para z $d_c \le 3R_s$ musi trafić na CPU `long double` Duffy ($\le 10^{-13}$), a brak CUDA musi rzucić twardy błąd bez fallbacku. *(Przypięte do: Zadanie 2 `oersted_direct_tetra_contract.cpp` + `pytest scripts/test_antenna_{duffy,global_quadrature,quadrature_evidence}_source.py` + Zadanie 4 TSan.)*
4. **Spójność wieloterminalowego factor-once (rozłączne składowe, współbieżne `ChargeTraceWorkspace::solve() const`), zbieżność silnie niesymetrycznego M1/M2 (małe $\lambda_J$, niezerowe AHE/AMR, kontrast $\sigma = 100\times$) i zachowanie negatywnego kontraktu `GPU_DOUBLE` na ABI v1/v2/v3** — `solve_charge_terminal_currents` nie może współdzielić faktoryzacji poza pojedynczym wywołaniem (ochrona przed mutacją zewnętrznego `Coefficient`); współbieżne `ChargeTraceWorkspace::solve() const` z wielu wątków musi być czyste pod TSan; silnie niesymetryczne M1/M2 musi zbiegać $\le 10^{-11}$ zarówno w Tier 1 (MUMPS LU), jak i w Tier 2 (`SLEPC=0` Block-AMG/ILU GMRES); `steady_transport_abi_contract` i `charge_transport_abi_contract` muszą dalej odrzucać `GPU_DOUBLE` kodem `FULLMAG_FEM_ERR_UNAVAILABLE`, a jawny C++ `GpuCudss` musi failować twardo przy ciasnym limicie VRAM lub `CUDSS_DATA_INFO != 0`. *(Przypięte do: Zadanie 0 `sparse_linear_solver_contract.cpp`, Zadanie 3 `steady_transport_contract.cpp` i `conservative_current_view_contract.cpp`.)*
5. **Dokładna analiza rzędu `ConservativeConstraintRank`, ograniczenie wypełnienia gęstych wierszy terminalowych w prekondycjonerze Schura $\tilde{S}$, pełna bramka `long double` w OE-T0 KKT oraz kompilacja `FULLMAG_HAS_MFEM_STACK=0`** — rzadki solver OE-T0 KKT (Tier 1 MUMPS + refinement i Tier 2 Schur-AMG `MINRES` z ochroną wierszy o stopniu $> 64$) musi spełniać bramki dla **wszystkich** wierszy więzów (łącznie z pominiętymi zależnymi i stałymi zerami brzegowymi!) i dawać zgodność z małą wyrocznią gęstą; wszystkie pliki C ABI muszą kompilować się czysto z `FULLMAG_HAS_MFEM_STACK=0`. *(Przypięte do: Zadanie 3 `conservative_current_view_contract.cpp` i Zadanie 4 macierz buildów.)*

---

## Faza 0: Wspólny rzadki silnik liniowy i zamrożenie szwów nagłówkowych (Pre-Fanout Commit)

### Zadanie 0: Implementacja `sparse_linear_solver.{hpp,cpp}` oraz zamrożenie 4 szwów nagłówkowych

> **Właściciel:** Coordinator (jeden commit bazowy przed uruchomieniem 3 worktree Fazy 1; dzięki pełnej implementacji `sparse_linear_solver.{hpp,cpp}` już w Fazie 0 każdy autor Fazy 1 kompiluje i uruchamia pełny zestaw testów swojego podsystemu lokalnie, bez czekania na scalenie!).

**Files:**
- Create: `backends/fem/cpu/mfem/common/sparse_linear_solver.hpp`
- Create: `backends/fem/cpu/mfem/common/sparse_linear_solver.cpp`
- Create: `backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.hpp`
- Create: `backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu` (minimalny kompilowalny stub zwracający `false`, zastępowany w Zadaniu 2 przez `direct-tetra-author`)
- Create: `backends/fem/tests/sparse_linear_solver_contract.cpp`
- Modify: `backends/fem/CMakeLists.txt` (jednorazowa rejestracja `sparse_linear_solver.cpp`, `direct_tetra_farfield_kernels.cu`, `fem_sparse_linear_solver_contract`, `FULLMAG_HAS_MFEM_STACK=1` na `fem_steady_transport_contract`, oraz warunkowe `PETSC::petsc` z `if(FULLMAG_FEM_WITH_SLEPC AND NOT FULLMAG_OET0_TSAN)` na `fem_conservative_current_view_contract`)
- Modify: `backends/fem/cpu/mfem/interactions/oersted/vector_potential.hpp:16-60`
- Modify: `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp:20-55`
- Modify: `backends/fem/cpu/mfem/transport/steady_transport.hpp:33-82`

**Interfaces:**
- Consumes: `fullmag::fem::runtime::petsc_slepc_process_mutex()`, `register/unregister_petsc_slepc_live_cpu_graph_locked()`, `petsc_slepc_process_is_unsafe_locked()` (`core/petsc_slepc_runtime.hpp`); `configure_hypre_host_policy()`, `current_hypre_host_policy()` (`cpu/mfem/runtime/hypre_host_policy.hpp`); `ensure_mpi_initialized()`, `fullmag_serial_comm()` (`cpu/mfem/runtime/mpi_init.hpp`); `resolve_demag_cudss_device_budget()`, `check_demag_cudss_factor_fits()` (`gpu/cuda/demag_poisson/cudss_direct_solver.hpp`, za `#if FULLMAG_FEM_CUDSS_POISSON_ENABLED && FULLMAG_HAS_CUDA_RUNTIME`).
- Produces:
  - `sparse_linear_solver.hpp`: `SparseMatrixKind`, `SparseExecutionTarget`, `SparseCpuBackendPolicy`, `SparseSolveConfig`, `SparseSolveStats`, `class SparseLinearSolver` (`solve(rhs, solution, denominator_floor)`), `assemble_equilibrated_saddle_point_csr`, `compute_saddle_point_equilibration_beta`, `sparse_independent_relative_residual`.
  - `vector_potential.hpp`: podniesione domyślne `maximum_nd_dofs = 2'000'000`, `maximum_h1_dofs = 1'000'000`, addytywne opcje `SparseExecutionTarget execution_target`, `SparseCpuBackendPolicy cpu_backend` na końcu `VectorPotentialOptions`, oraz addytywne pola diagnostyczne `resolved_linear_solver`, `linear_iterations`, `linear_solve_ms`, `nodal_projection_ms` na końcu `VectorPotentialDiagnostics`.
  - `direct_tetra_quadrature.hpp`: `enum class DirectTetraExecutionPolicy { CpuDeterministic = 0, GpuHybridFarField = 1 }`, addytywne pola na końcu `DirectTetraQuadratureOptions` (`int worker_threads = 0; DirectTetraExecutionPolicy execution_policy = DirectTetraExecutionPolicy::CpuDeterministic;`) oraz addytywne pola na końcu `DirectTetraQuadratureDiagnostics` (`std::string resolved_execution_policy; int effective_worker_threads = 1; std::uint64_t gpu_farfield_pairs = 0; std::uint64_t cpu_near_singular_pairs = 0;`).
  - `direct_tetra_farfield_kernels.hpp`: struktury POD `GpuDirectTetraSourceHostData`, `GpuDirectTetraTargetResult`, funkcja `bool fullmag_cuda_direct_tetra_evaluate_root_farfield(const GpuDirectTetraSourceHostData &sources, const double *target_xyz, std::size_t target_count, const double *low_rule_xyzw, int low_npts, const double *high_rule_xyzw, int high_npts, double near_radius_factor, double relative_tolerance, double absolute_tolerance_apm, GpuDirectTetraTargetResult &out, std::string &error)`.
  - `steady_transport.hpp`: addytywne pola na końcu `SteadyTransportParameters` (`SparseExecutionTarget execution_target = SparseExecutionTarget::Cpu; SparseCpuBackendPolicy cpu_backend = SparseCpuBackendPolicy::Auto;`) oraz `std::string resolved_solver;` na końcu `ChargeSolveDiagnostics` i `SpinSolveDiagnostics`.

- [ ] **Krok 1 (TDD — failing test):** Utwórz `backends/fem/tests/sparse_linear_solver_contract.cpp` testujący (**Review Focus #1 i #4**):
  - `spd_factor_once_multi_rhs_all_cpu_backends()`: ten sam obiekt `SparseLinearSolver` na 3D macierzy Laplasjanu (SPD) rozwiązuje 8 różnych prawych stron pod `Auto`, `PetscMumps` (gdy `FULLMAG_FEM_WITH_SLEPC`), `Hypre` (gdy `MFEM_USE_MPI && !FULLMAG_OET0_DISABLE_MPI`) i `MfemSerial`; asercje `stats.converged == true`, `stats.independent_relative_residual <= 1e-12`, zgodność między torami $\le 10^{-11}$.
  - `equilibrated_saddle_point_nanometer_scale()`: syntetyczny układ siodłowy `[[K, B], [B^T, 0]]` z $\|K\| \sim 10^{14}$, $\|B\| \sim 10^{-8}$ (skala $10^{22}$); asercja `compute_saddle_point_equilibration_beta` zwraca skończone $\beta > 0$, a rozwiązanie odzyskuje wektor dokładny z błędem względnym $\le 10^{-11}$.
  - `nonsymmetric_by_nodes_3comp_and_4comp_preconditioned()`: 3- i 4-składowy układ `byNODES` z silnym członem skośnosymetrycznym ($c_J = 10^3$); asercja zbieżności $\le 10^{-11}$ pod `Auto` i `Hypre` (Block-Diagonal BoomerAMG + eskalacja `HypreILU`).
  - `concurrent_const_solve_thread_safety()`: 4 wątki `std::thread` równocześnie wołają `solver.solve(...)` na tym samym obiekcie `SparseLinearSolver`; brak wyścigów i identyczne wyniki $\le 10^{-14}$.
  - `gpu_cudss_explicit_parity_and_fail_closed()`: pod `FULLMAG_FEM_CUDSS_POISSON_ENABLED=1` weryfikuje parzystość `GpuCudss` vs CPU (`Spd` multi-RHS i `GeneralNonsymmetric`) $\le 10^{-12}$, twardy błąd przy niemożliwym budżecie VRAM (`FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES=1024`) oraz twardy błąd na macierzy osobliwej (`CUDSS_DATA_INFO != 0`, ZERO fallbacku do CPU); bez CUDA/cuDSS asercja twardego wyjątku `std::runtime_error`.
- [ ] **Krok 2 (Implement — szwy nagłówkowe i `sparse_linear_solver.{hpp,cpp}`):**
  - Zaktualizuj 3 nagłówki (`vector_potential.hpp`, `direct_tetra_quadrature.hpp`, `steady_transport.hpp`) i utwórz `direct_tetra_farfield_kernels.hpp` oraz `sparse_linear_solver.hpp` z dokładnymi sygnaturami ze Sekcji 3 i 5.3 specyfikacji (zachowując 100% kompatybilności agregatowej dla istniejących wywołań).
  - Zaimplementuj `backends/fem/cpu/mfem/common/sparse_linear_solver.cpp` z:
    - bezpieczną strażą 2-rankowego MPI (`MPI_Initialized` + `MPI_Comm_size > 1 && !petsc_initialized` $\implies$ pomiń PETSc, idź do Tier 2 `MPI_COMM_SELF`),
    - `petsc_slepc_process_mutex()` + `register/unregister_petsc_slepc_live_cpu_graph_locked()` + `PetscPushErrorHandler(PetscReturnErrorHandler, nullptr)` + `PCCHOLESKY`/`PCLU` + `MATSOLVERMUMPS` + `ICNTL(7)=5` (METIS) + `ICNTL(14)=50` + do `max_refinement_sweeps` kroków doprecyzowania w `long double`,
    - Tier 2 HYPRE z `configure_hypre_host_policy()` + kontrolą **obu** pól `memory_location_host && execution_policy_host` + lokalną sondą `can_initialize_openmpi_singleton()` (test `socket(AF_INET, SOCK_STREAM, 0)` przed `MPI_Init_thread`, bez zależności od `relaxation_math.cpp`), realizujący `HypreBoomerAMG`+`HyprePCG` dla `Spd` oraz blokowo-diagonalny `HypreBoomerAMG` na blokach `byNODES` + `GMRESSolver` z eskalacją do `HypreILU(1)` dla `GeneralNonsymmetric`,
    - Tier 3 `MFEM` serial (`GSSmoother`+`CGSolver`/`GMRESSolver`) bezpieczny pod `FULLMAG_OET0_DISABLE_MPI=1`,
    - opcjonalnym `GpuCudss` (za `#if defined(FULLMAG_FEM_CUDSS_POISSON_ENABLED) && FULLMAG_FEM_CUDSS_POISSON_ENABLED && defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME`) korzystającym z `resolve_demag_cudss_device_budget` + `CUDSS_DATA_MEMORY_ESTIMATES` + twardego błędu przy przekroczeniu VRAM lub `CUDSS_DATA_INFO != 0`.
  - Utwórz minimalny stub `direct_tetra_farfield_kernels.cu` zwracający `false` z komunikatem `"not yet implemented"` oraz zaktualizuj `backends/fem/CMakeLists.txt`:
    - W `if(FULLMAG_USE_MFEM_STACK)`: dodaj `find_package(Threads REQUIRED)`, dodaj `cpu/mfem/common/sparse_linear_solver.cpp` do `FEM_SOURCES` i zlinkuj `Threads::Threads` do `fullmag_fem`; w `if(FULLMAG_ENABLE_CUDA)`: dodaj `gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu` do `FEM_SOURCES`.
    - Zarejestruj `fem_sparse_linear_solver_contract` (`tests/sparse_linear_solver_contract.cpp`, linkujący `fullmag_fem` + `MFEM::mfem` + `Threads::Threads`, z `FULLMAG_FEM_CUDSS_POISSON_ENABLED=1` i `CUDA::cudart` gdy `FULLMAG_FEM_CUDSS_SHIFT_SUPPORTED`).
    - W `fem_steady_transport_contract`: dodaj `FULLMAG_HAS_MFEM_STACK=1`, źródła `cpu/mfem/common/sparse_linear_solver.cpp`, `core/petsc_slepc_runtime.cpp`, `cpu/mfem/runtime/hypre_host_policy.cpp`, `Threads::Threads`, warunkowo `PETSC::petsc` + `FULLMAG_FEM_WITH_SLEPC=1` (gdy `FULLMAG_FEM_WITH_SLEPC`) oraz `gpu/cuda/demag_poisson/cudss_direct_solver.cpp` + `${FULLMAG_CUDSS_LIBRARY}` + `CUDA::cudart` + `target_include_directories(fem_steady_transport_contract PRIVATE "${FULLMAG_CUDSS_INCLUDE_DIR}")` + `FULLMAG_FEM_CUDSS_POISSON_ENABLED=1` + `FULLMAG_HAS_CUDA_RUNTIME=1` (gdy `FULLMAG_FEM_CUDSS_SHIFT_SUPPORTED`).
    - W `fem_conservative_current_view_contract`: dodaj `cpu/mfem/common/sparse_linear_solver.cpp`, `cpu/mfem/runtime/hypre_host_policy.cpp`, `core/petsc_slepc_runtime.cpp`; **WYŁĄCZNIE wewnątrz `if(FULLMAG_FEM_WITH_SLEPC AND NOT FULLMAG_OET0_TSAN)`** zlinkuj `PETSC::petsc` i dodaj `FULLMAG_FEM_WITH_SLEPC=1` (zachowując `scripts/test_audit_fem_cpu_only_runtime.py:295-319`).
- [ ] **Krok 3 (Verify & Commit):** W Docker DEV zbuduj i uruchom `ctest --test-dir <build>/backends/fem --output-on-failure -R "fem_sparse_linear_solver_contract"` (PASS) oraz zweryfikuj `python3 -m unittest scripts/test_audit_fem_cpu_only_runtime.py` (PASS), następnie commituj:
  `git commit -m "fem(multiphysics): add shared 3-tier sparse linear solver, CMake seams, and Wave 2 headers"`

---

## Faza 1 — Author 1: `oersted-vp-author` (Track 1: Oersted Vector Potential OE-F2)

> **Wyłączna własność plików:** `backends/fem/cpu/mfem/interactions/oersted/vector_potential.cpp`, `backends/fem/tests/oersted_vector_potential_contract.cpp`, `backends/fem/tests/steady_transport_rt0_contract.cpp`, `crates/fullmag-ir/src/antenna.rs`, `docs/physics/0980-dynamic-current-and-oersted-coupling.{md,source-map.json}`.
> **NIE dotykać:** `vector_potential.hpp` (zamrożony w Fazie 0), `direct_tetra_*`, `steady_transport.*`, `charge_trace_workspace.*`, `conservative_current_view.*`, `CMakeLists.txt`.

### Zadanie 1: Rzadki solver OE-F2 (`vector_potential.cpp`), podniesienie limitów DOF i aktualizacja `0980`

**Files:**
- Modify: `backends/fem/cpu/mfem/interactions/oersted/vector_potential.cpp:1-411`
- Modify: `backends/fem/tests/oersted_vector_potential_contract.cpp`
- Modify: `backends/fem/tests/steady_transport_rt0_contract.cpp:410-465`
- Modify: `crates/fullmag-ir/src/antenna.rs:56-62`
- Modify: `docs/physics/0980-dynamic-current-and-oersted-coupling.md`
- Modify: `docs/physics/0980-dynamic-current-and-oersted-coupling.source-map.json`

**Interfaces:**
- Consumes: `SparseLinearSolver`, `SparseSolveConfig`, `SparseMatrixKind`, `assemble_equilibrated_saddle_point_csr`, `compute_saddle_point_equilibration_beta`, `sparse_independent_relative_residual` (Zadanie 0); `VectorPotentialOptions`, `VectorPotentialDiagnostics` (Faza 0).
- Produces: Skalowalna rzadka implementacja `VectorPotentialSolver::Evaluate` (Tier 1 PETSc+MUMPS LU + refinement, Tier 2 HYPRE `HypreAMS` + `HypreBoomerAMG` `MINRES`, Tier 3 MFEM serial, opcjonalnie `GpuCudss`), rzadkie `project_compatible_h_to_nodes`, podniesione stałe `ANTENNA_VECTOR_POTENTIAL_MAX_ND_DOFS = 2_000_000`, `ANTENNA_VECTOR_POTENTIAL_MAX_H1_DOFS = 1_000_000`.

- [ ] **Krok 1 (TDD — failing tests):** Rozszerz `backends/fem/tests/oersted_vector_potential_contract.cpp` (**Review Focus #2**):
  - `vector_potential_sparse_matches_dense_oracle_on_small_mesh()`: siatka $3\times 3\times 3$ tets; porównaj `VectorPotentialSolver::Evaluate` (pod `Auto` oraz jawnie pod `SparseCpuBackendPolicy::Hypre` dla ścieżki AMS+BoomerAMG!) z lokalną testową wyrocznią `mfem::DenseMatrixInverse` — asercja maksymalnego błędu względnego na `a_dofs_t_m`, `gauge_dofs_apm`, `compatible_h_dofs_apm` i `nodal_h_xyz_apm` $\le 10^{-11}$.
  - `vector_potential_scales_beyond_legacy_4096_nd_cap()`: siatka $12\times 12\times 12$ tets ($N_{ND} > 12\,000$, $N_{H1} > 2\,100$) z domyślnymi `VectorPotentialOptions{}` — asercja sukcesu, `diagnostics.nd_dofs > 4096`, `diagnostics.h1_dofs > 2048`, `first_block_residual <= tol`, `constraint_residual <= tol`, `compatible_divergence_residual <= tol`, `nodal_projection_residual <= 1e-10`, `!diagnostics.resolved_linear_solver.empty()`.
  - `vector_potential_nanometer_scale_equilibration()`: kostka o boku $L = 10^{-7}\text{ m}$ ($4\times 4\times 4$ tets) — asercja zbieżności poniżej `1e-10 * scale` pod `Auto` i `Hypre`, skończona dodatnia energia sprzężenia źródła $W_J > 0$.
  - `vector_potential_coarse_mesh_zero_interior_h1_and_cap_rejection()`: (a) siatka $1\times 1\times 1$ tets ($n_{H1,\mathrm{int}} = 0$) przechodzi czysto z `gauge_dofs_apm == 0` i poprawnym rezyduum; (b) jawne `options.maximum_nd_dofs = 10` rzuca `std::invalid_argument`; (c) `options.maximum_nd_dofs = 0` rzuca `std::invalid_argument`.
  - W `steady_transport_rt0_contract.cpp`: dodaj asercję potwierdzającą brak nieoczekiwanej regresji ABI i poprawność `nodal_projection_residual <= 1e-10`.
- [ ] **Krok 2 (Verify RED):** Uruchom `fem_oersted_vector_potential_contract` w Docker DEV; oczekiwany FAIL (limit `4096` odrzuca siatkę $12\times 12\times 12$, brak ścieżki AMS/MUMPS).
- [ ] **Krok 3 (Implement):**
  - W `backends/fem/cpu/mfem/interactions/oersted/vector_potential.cpp`:
    - Usuń wszystkie `mfem::DenseMatrix`, `mfem::DenseMatrixInverse`, `add_sparse_block`, `add_sparse_transpose_block`, `impose_zero` i `matrix_vector_residual`.
    - Dodaj walidację przepełnienia `nd_dofs <= std::numeric_limits<int>::max() - h1_dofs`.
    - Zbuduj rzadką eliminację wnętrza `(interior_nd, interior_h1)` w $O(\text{nnz})$ z obsługą $n_{ND,\mathrm{int}} = 0$ i $n_{H1,\mathrm{int}} = 0$ (rozwiązanie SPD na $K_{\mathrm{curl,int}}$).
    - Dla $n_{ND,\mathrm{int}} > 0$ i $n_{H1,\mathrm{int}} > 0$: oblicz $\beta = \text{compute\_saddle\_point\_equilibration\_beta}(K_{\mathrm{curl,int}}, G_{\mathrm{int}})$;
      - w Tier 1 (PETSc+MUMPS) i `GpuCudss`: rozwiąż $S_\beta = \text{assemble\_equilibrated\_saddle\_point\_csr}(K_{\mathrm{curl,int}}, G_{\mathrm{int}}, \beta)$ przez `SparseLinearSolver(S_\beta, SymmetricIndefinite)` i odzyskaj $p = \beta\tilde{p}$;
      - w Tier 2 (`SLEPC=0` lub jawne `Hypre`): ustaw $\gamma = \mu_0^{-1} L^{-2}$ ($L = \operatorname{diam}(\Omega)$), zbuduj `ParMesh` z jawną zerową partycją `std::vector<int> part(mesh.GetNE(), 0); mfem::ParMesh pmesh(MPI_COMM_SELF, ..., part.data());` (wymagane przy `-DMFEM_USE_METIS=NO`!), umieść rzadką macierz brzegową `h1_bdr_identity` (`1.0` na $\Gamma_{H1}$, `0` we wnętrzu) w bloku `(1,1)` operatora `MINRES`, i rozwiąż z prekondycjonerem `blkdiag(HypreAMS(K_curl + gamma * M_ND, &par_nd_space), HypreBoomerAMG((beta^2 / gamma) * L_H1))` po `configure_hypre_host_policy()` i sprawdzeniu `memory_location_host && execution_policy_host`;
      - w Tier 3: `MINRES` z blokowym `GSSmoother` (z tym samym $\gamma = \mu_0^{-1} L^{-2}$ i `h1_bdr_identity` w bloku `(1,1)`).
    - Zastąp podwójne pętle rezyduów (`:303-332`) przez 3 rzadkie wywołania `curl_matrix.Mult`, `gradient_matrix.AddMult`, `gradient_matrix.MultTranspose` i zerowanie na `essential_*_mask`.
    - W `project_compatible_h_to_nodes` (zachowaj dokładną nazwę symbolu!): złóż 3 wektory RHS $(r_x, r_y, r_z)$ w jednym przebiegu po elementach/kwadraturach, sfaktoryzuj `mass.SpMat()` **raz** przez `SparseLinearSolver(Spd)` i rozwiąż dla $c \in \{0,1,2\}$ z rzadką weryfikacją rezyduum `mass.Mult(solution, residual); residual -= rhs;`.
    - Wypełnij nowe pola `diagnostics.{resolved_linear_solver, linear_iterations, linear_solve_ms, nodal_projection_ms}`.
  - W `crates/fullmag-ir/src/antenna.rs:60-61`: zaktualizuj `ANTENNA_VECTOR_POTENTIAL_MAX_ND_DOFS = 2_000_000` i `ANTENNA_VECTOR_POTENTIAL_MAX_H1_DOFS = 1_000_000`.
  - Zaktualizuj `docs/physics/0980-dynamic-current-and-oersted-coupling.{md,source-map.json}` (zastępując zapis o gęstej odwrotności / limicie 4096/2048 opisem rzadkiego solvera ekwalibrowanego i rzadkiej projekcji masy).
- [ ] **Krok 4 (Verify GREEN & Commit):**
  - W Docker DEV: `ctest --test-dir <build>/backends/fem --output-on-failure -R "fem_oersted_vector_potential_contract|fem_steady_transport_rt0_contract"` $\to$ PASS; `cargo test -p fullmag-ir` $\to$ PASS; `python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0980-dynamic-current-and-oersted-coupling.md` $\to$ PASS.
  - Commit: `git commit -m "fem(oersted): replace OE-F2 dense inverse with sparse equilibrated MUMPS/AMS solver and sparse H1 projection"`

---

## Faza 1 — Author 2: `direct-tetra-author` (Track 2: Direct Tetra Quadrature OE-F1 CPU Parallel + GPU Far-Field)

> **Wyłączna własność plików:** `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp`, `backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu`, `backends/fem/cpu/mfem/workflows/antenna_field_solve/frozen_direct_rt0.cpp`, `backends/fem/tests/oersted_direct_tetra_contract.cpp`, `scripts/test_antenna_duffy_source.py`, `scripts/test_antenna_global_quadrature_source.py`, `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.{md,source-map.json}`.
> **NIE dotykać:** `direct_tetra_quadrature.hpp` i `direct_tetra_farfield_kernels.hpp` (zamrożone w Fazie 0), `surface_rt0.*`, `vector_potential.*`, `transport/*`, `CMakeLists.txt`.

### Zadanie 2: Deterministyczna wielowątkowość CPU (0 ULP), fuzja `ProjectField` oraz opt-in CUDA GPU dalekiego pola

**Files:**
- Modify: `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp:1-1004`
- Modify: `backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu` (pełna implementacja zamiast stuba z Fazy 0)
- Modify: `backends/fem/cpu/mfem/workflows/antenna_field_solve/frozen_direct_rt0.cpp:88-91` (weryfikacja kompatybilności z rozszerzonym `DirectTetraQuadratureOptions` — brak naruszeń agregatu i zachowanie ścisłej bramki `CPU_DOUBLE`)
- Modify: `backends/fem/tests/oersted_direct_tetra_contract.cpp`
- Modify: `scripts/test_antenna_duffy_source.py` (aktualizacja granicy podziału `class DirectScalarCoefficient` przy zachowaniu AST Duffy'ego)
- Modify: `scripts/test_antenna_global_quadrature_source.py` (aktualizacja przestarzałych asercji 3-przebiegowego `ProjectField`/`DirectScalarCoefficient` przy zachowaniu bramek `WorkBudget`, `catch`, `inverse_kernel_denominator`)
- Modify: `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`
- Modify: `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.source-map.json`

**Interfaces:**
- Consumes: `DirectTetraExecutionPolicy`, `DirectTetraQuadratureOptions`, `DirectTetraQuadratureDiagnostics`, `GpuDirectTetraSourceHostData`, `GpuDirectTetraTargetResult`, `fullmag_cuda_direct_tetra_evaluate_root_farfield` (Faza 0); `SparseLinearSolver` (`sparse_linear_solver.hpp` dla `ProjectField`).
- Produces: Deterministyczna wielowątkowa implementacja `DirectTetraQuadrature::{Evaluate, EvaluateField, EvaluateFrozenField, ProjectField}` oraz implementacja CUDA `fullmag_cuda_direct_tetra_evaluate_root_farfield`.

- [ ] **Krok 1 (TDD — failing tests):** Rozszerz `backends/fem/tests/oersted_direct_tetra_contract.cpp` (**Review Focus #3**):
  - `direct_tetra_multithread_is_bit_exact_and_observer_monotonic()`:
    - Siatka $4\times 4\times 4$ tets ($N_s = 384$), dwa scenariusze: (a) $N_t = 32$ celów (mieszanka dalekiego pola + punkty na krawędzi, ścianie i we wnętrzu czworościanów — ścieżka równoległości po celach), (b) $N_t = 2$ cele (ścieżka równoległości po źródłach bazowych).
    - Porównaj `worker_threads = 1` vs `worker_threads = 4` vs `worker_threads = 8`: asercje `res_w.h_xyz_apm == res_1.h_xyz_apm` (bitowo identyczne!), identyczne `kernel_evaluations`, `ledger_leaf_visits`, `target_diagnostics`, oraz dokładnie $N_t + 1$ monotonicznych wywołań obserwatora (`0, 1, ..., N_t`, brak wywołań współbieżnych potwierdzony atomowym strażnikiem re-entrancy!).
  - `direct_tetra_parallel_budget_exceeded_fails_cleanly()`: uruchom równolegle (`worker_threads = 4`) z ciasnym limitem budżetu (`maximum_source_target_pairs` / wysoki rząd wyzwalający przekroczenie limitu próbek) — asercja czystego wyjątku `std::runtime_error` bez deadlocku i wycieku wątków.
  - `direct_tetra_project_field_single_pass_parity()`: sprawdź `ProjectField` dla `worker_threads = 1` vs `worker_threads = 4` — zgodność pól $\le 10^{-12}$, `kernel_evaluations` w nowej fuzji $\le \frac{1}{3}$ dawnej wartości (potwierdzenie pojedynczej ewaluacji 3-wektorowej zamiast 3× powtarzania!).
  - `direct_tetra_gpu_hybrid_farfield_parity_and_singular_handoff()`:
    - Z `execution_policy = DirectTetraExecutionPolicy::GpuHybridFarField`: na buildzie z `FULLMAG_HAS_CUDA_RUNTIME=1` przetestuj $N_s = 384$ tets i cele obejmujące (1) dalekie pole ($d > 5R_s$), (2) punkt na granicy strefy bliskiej ($d \approx 2.5 R_s$), (3) punkt dokładnie na wierzchołku, krawędzi, ścianie i we wnętrzu źródła! Asercje: `gpu_farfield_pairs > 0`, `cpu_near_singular_pairs > 0`, zgodność każdego celu względem `CpuDeterministic` $\le 10^{-13} \cdot \max(1.0, \|H_{\text{cpu}}\|_2)$, `unconverged_pair_count == 0`.
    - Na buildzie bez CUDA (`FULLMAG_HAS_CUDA_RUNTIME=0`): asercja twardego wyjątku `std::runtime_error` (zero cichego fallbacku do CPU!).
- [ ] **Krok 2 (Verify RED):** Uruchom `fem_oersted_direct_tetra_contract` w Docker DEV; oczekiwany FAIL (brak wielowątkowej równoległości, fuzji `ProjectField` i ścieżki GPU).
- [ ] **Krok 3 (Implement):**
  - W `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp`:
    - Zachowaj dokładne symbole `DirectTetraQuadrature::ResolveWorkLimits`, `WorkBudget`, `norm`, `evaluate_current`, `integrate_duffy_once`, `evaluate_target` (`0950.source-map.json`), pojedyncze wystąpienia `inverse_kernel_denominator(distance)` i `-inverse_kernel_denominator(ray_norm)`, `work.sample()` przed `evaluate_current(`, `work.visit()`, pola `.x`/`.weight` w `SegQuadPoint` oraz zakaz `catch (const std::runtime_error &)` (wątki robocze używają wyłącznie `std::exception_ptr` + `catch (...)`!).
    - Dodaj strukturę `QuadratureRuleTable` pre-ekstrahującą wszystkie reguły `TETRAHEDRON` i `SEGMENT` z `mfem::IntRules.Get(...)` **raz na wątku głównym** przed uruchomieniem wątków roboczych (eliminacja wyścigu TSan!).
    - Zaimplementuj `AtomicWorkBudget` z okresową atomową kontrolą limitu i `stop_requested` na przekroczeniu budżetu, ale z **dokładnym** raportowaniem per-target `kernel_evaluations` i `ledger_leaf_visits` (nigdy zaokrąglanym do 256!) tak, aby `sum(target_diagnostics[t]) == diagnostics` (`scripts/test_antenna_quadrature_evidence_source.py:63,69`).
    - Zaimplementuj dwupoziomową pulę `std::thread` (sterowaną przez `options.worker_threads` lub odczyt budżetu CPU):
      - $N_t \ge 2W$: dynamiczne przydzielanie celów `next_target.fetch_add(1)`, zapis do `per_target[t]`, sekwencyjne wywołania `observer->emit` pod muteksem w ścisłym porządku $1 \dots N_t$ (zachowując `completed == p.calls`!), redukcja `diagnostics` w kolejności $t = 0 \dots N_t - 1$.
      - $N_t < 2W$ i $N_s \ge 128$: równoległa ewaluacja korzeni `source = 0 .. N_s - 1` do `leaves[source]`, a następnie deterministyczne `ledger.add` + `enqueue` na wątku głównym w porządku rosnącym `source`.
    - Zrefaktoryzuj `ProjectField` (`:892-1004`): zbierz wszystkie punkty kwadratury docelowych elementów do jednego wektora, wywołaj **raz** pomocnika omijającego punktowy `validate_pair_budget` (przy zachowaniu jednego wspólnego `WorkBudget`!), złóż 3 wektory RHS $(b_x, b_y, b_z)$ w jednej pętli elementowej i rozwiąż macierz masy `mass.SpMat()` raz przez `SparseLinearSolver(Spd)` dla 3 składowych.
    - Dodaj gałąź `DirectTetraExecutionPolicy::GpuHybridFarField` chronioną przez **`#if defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME`** (w gałęzi `#else` twardy wyjątek `std::runtime_error`, zero fallbacku!; dzięki `defined(...)` kompiluje się czysto w `fem_conservative_current_view_contract` bez CUDA!):
      - pod CUDA przygotuj `GpuDirectTetraSourceHostData` (wierzchołki SoA, współczynniki RT0, środek/promień kuli opisanej $R_s$, jakobian), wywołaj `fullmag_cuda_direct_tetra_evaluate_root_farfield(..., near_radius_factor = 3.0, ...)`, a następnie dla każdego celu połącz wynik dalekiego pola GPU z dokładną ewaluacją CPU `long double` (Duffy + adaptacyjny kopiec) dla par oznaczonych `needs_cpu` oraz zweryfikuj globalną bramkę `target_error_fits` (dociągając ewentualne niezbiegłe pary dalekiego pola na CPU gdyby globalna tolerancja wymagała dalszego podziału!).
  - Wypełnij pełną implementację `backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu`:
    - Pomocniki `__device__` 106-bitowego *double-double* (`struct DoubleDouble { double hi, lo; }`, bezbłędne `two_sum`, `dd_add`, `dd_add_d`) dla akumulacji `current_at` (`sum += alpha_k * (x - v_k)`) oraz sumowania kwadratury `low`/`high` i redukcji po źródłach w deterministycznej kolejności rosnących indeksów `s`.
    - Kernel klasyfikujący $d_c \le 3.0\,R_s \implies$ `needs_cpu = 1`, w przeciwnym razie obliczający kwadraturę `low_order` i `high_order` w rejestrach (płaskie tablice reguł w pamięci stałej / read-only `__ldg`), sprawdzający skończoność i generujący kompaktowe listy `needs_cpu` par oraz deterministyczne sumy dalekiego pola per cel.
  - Zaktualizuj `scripts/test_antenna_duffy_source.py`, `scripts/test_antenna_global_quadrature_source.py` oraz `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.{md,source-map.json}`.
- [ ] **Krok 4 (Verify GREEN & Commit):**
  - W Docker DEV: `ctest --test-dir <build>/backends/fem --output-on-failure -R "fem_oersted_direct_tetra_contract"` $\to$ PASS; `pytest scripts/test_antenna_duffy_source.py scripts/test_antenna_global_quadrature_source.py scripts/test_antenna_quadrature_evidence_source.py` $\to$ PASS; `python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` $\to$ PASS.
  - Commit: `git commit -m "fem(oersted): parallelize direct tetra quadrature deterministically on CPU and add opt-in CUDA far-field accelerator"`

---

## Faza 1 — Author 3: `transport-author` (Track 3: Charge/Spin Transport + `ChargeTraceWorkspace` + OE-T0 RT0 KKT)

> **Wyłączna własność plików:** `backends/fem/cpu/mfem/transport/steady_transport.cpp`, `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.{hpp,cpp}`, `backends/fem/cpu/mfem/transport/conservative_current_view.cpp`, `backends/fem/cpu/mfem/transport/periodic_charge_potential.cpp`, `backends/fem/tests/steady_transport_contract.cpp`, `backends/fem/tests/conservative_current_view_contract.cpp`, `docs/physics/0970-spin-hall-drift-diffusion-transport.{md,source-map.json}`, `docs/physics/0981-fem-oet0-sparse-kkt.{md,source-map.json}`.
> **NIE dotykać:** `steady_transport.hpp` (zamrożony w Fazie 0), `steady_transport_c_api.cpp`, `oersted/*`, `CMakeLists.txt`, `conservative_constraint_rank.*`.

### Zadanie 3: Factor-once multi-RHS dla transportu ładunku, prekondycjonowany/bezpośredni M1/M2 oraz szybki rzadki OE-T0 KKT

**Files:**
- Modify: `backends/fem/cpu/mfem/transport/steady_transport.cpp:619-1555`
- Modify: `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.hpp:15-75`
- Modify: `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.cpp:100-554`
- Modify: `backends/fem/cpu/mfem/transport/conservative_current_view.cpp:1970-2320,2500-2540`
- Modify: `backends/fem/cpu/mfem/transport/periodic_charge_potential.cpp:1220-1240` (wyłącznie przekazanie `trace_request.cpu_backend = Hypre` pod `reference_mpi_gather_rank0_broadcast` — brak własnego `CGSolver` w tym pliku!)
- Modify: `backends/fem/tests/steady_transport_contract.cpp`
- Modify: `backends/fem/tests/conservative_current_view_contract.cpp`
- Modify: `docs/physics/0970-spin-hall-drift-diffusion-transport.{md,source-map.json}`
- Modify: `docs/physics/0981-fem-oet0-sparse-kkt.{md,source-map.json}`

**Interfaces:**
- Consumes: `SparseLinearSolver`, `SparseSolveConfig`, `SparseMatrixKind`, `SparseExecutionTarget`, `SparseCpuBackendPolicy`, `assemble_equilibrated_saddle_point_csr`, `compute_saddle_point_equilibration_beta`, `sparse_independent_relative_residual` (Zadanie 0); rozszerzone `SteadyTransportParameters`, `ChargeSolveDiagnostics`, `SpinSolveDiagnostics` (Faza 0).
- Produces: Factor-once multi-RHS w `SteadyTransportOracle::solve_charge_terminal_currents` i `ChargeTraceWorkspace`, szybkie zbieżne `solve_spin` / `solve_reciprocal` / `project_torque`, szybki 3-poziomowy rzadki solver KKT i external-lead w `ConservativeCurrentView::Build`, z pełną czystością TSan i 2-rank MPI.

- [ ] **Krok 1 (TDD — failing tests):** Rozszerz `steady_transport_contract.cpp` i `conservative_current_view_contract.cpp` (**Review Focus #1, #4, #5**):
  - W `steady_transport_contract.cpp`:
    - `multi_terminal_factor_once_matches_independent_charge_solves()`: 4-terminalowy przewodnik + oddzielna nieobciążona składowa (weryfikacja cechowania składowej rozłącznej!) — sprawdź `solve_charge_terminal_currents` pod `Auto`, `Hypre` i `MfemSerial`: zbieżność, bilans prądów $\le 10^{-8}|I_{\text{req}}| + 10^{-18}$, zgodność napięć i pola `electric_potential()` między torami $\le 10^{-11}$, `!diagnostics.resolved_solver.empty()`.
    - `stiff_precession_m1_and_reciprocal_m2_converge_with_strong_ahe_and_contrast()`: siatka $8\times 8\times 8$ tets z silną precesją $\lambda_J = 0.05\,L$, $\sigma_{\text{AHE}} = 0.3\sigma_\perp$, $\sigma_\parallel / \sigma_\perp = 1.5$ oraz 100× kontrastem przewodności warstwowej — asercja zbieżności (`relative_residual <= 1e-11`, bilans momentu pędu zachowany!) zarówno pod `Auto` (Tier 1 MUMPS), jak i jawnie pod `SparseCpuBackendPolicy::Hypre` (Tier 2 Block-AMG/ILU GMRES)!
    - `gpu_cudss_transport_parity_when_cuda_enabled()`: pod `#if FULLMAG_FEM_CUDSS_POISSON_ENABLED && FULLMAG_HAS_CUDA_RUNTIME` porównaj `SparseExecutionTarget::GpuCudss` vs `Cpu` na wieloterminalowym ładunku i M2 reciprocal ($\le 10^{-12}$); bez CUDA asercja twardego wyjątku (zero fallbacku!).
  - W `conservative_current_view_contract.cpp`:
    - `charge_trace_workspace_concurrent_const_solves_are_race_free_and_consistent()`: 4 wątki `std::thread` wywołujące `workspace.solve(...)` równolegle dla różnych kombinacji skoków/kotwic — brak wyścigów pod TSan, zgodność wyników z kolejnością szeregową $\le 10^{-13}$.
    - `sparse_kkt_matches_dense_kkt_and_handles_dependent_and_terminal_rows()`: porównaj rzadki tor KKT (wymuszony przez pomocniczy punkt wejścia testowego lub na siatce `7x7x7` `> 4096` RT0 DOFs z wierszami dywergencji, parowaniem i wierszami prądów terminalowych) pod Tier 1 i Tier 2: `scaled_kkt_residual <= 1e-10`, `max_element_divergence_a <= 1e-12`, dokładna zgodność bilansu prądów i energii korekcji z analityczną / gęstą wartością referencyjną!
- [ ] **Krok 2 (Verify RED):** Uruchom `fem_steady_transport_contract` i `fem_conservative_current_view_contract` w Docker DEV; oczekiwany FAIL (stiff M1/M2 nie zbiega pod nieprekondycjonowanym GMRES(100), brak `resolved_solver` / factor-once / Schur-AMG KKT).
- [ ] **Krok 3 (Implement):**
  - W `backends/fem/cpu/mfem/transport/steady_transport.cpp`:
    - W `solve_charge` (`:619-715`): zastąp `GSSmoother` + `CGSolver` przez `SparseLinearSolver(matrix, config_spd)`; ustaw `diagnostics.resolved_solver = stats.resolved_solver`.
    - W `solve_charge_terminal_currents` (`:717-870`): zbuduj `diffusion_form`, `essential_true_dofs`, `K_elim` (przez jedno `FormLinearSystem`) i **jedną** instancję `SparseLinearSolver(K_elim, config_spd)` RAZ na wywołanie; dla każdego z $T - C$ jednostkowych terminali wyznacz prawą stronę przez **`diffusion_form.FullMult(true_bdr, rhs_full)`** (obsługującą identycznie siatki zgodne i niezgodne `GetConformingRestriction()`, analogicznie do `:680-694`!) i oblicz reakcję jednym `FullMult` (bez `project_charge_current` i bez kwadratur objętościowych w pośrednich kolumnach!), rozwiąż blok $T \times T$, następnie rozwiąż końcowy stan **tym samym sfaktoryzowanym obiektem**, odzyskaj pola i pełną diagnostykę.
    - W `solve_spin` (`:872-956`) i `solve_reciprocal` (`:958-1104`): zastąp nieprekondycjonowany `GMRESSolver(100)` przez `SparseLinearSolver(matrix, config_nonsym)` (`by_nodes_component_count = 3` dla `solve_spin`, `4` dla `solve_reciprocal`), zachowując niezmienioną weryfikację niezależnego rezyduum (`:1060-1070`) i `last_spin_weak_balance`.
    - W `project_torque` (`:1454-1555`): sfaktoryzuj skalarną macierz masy $M_{H1}$ RAZ przez `SparseLinearSolver(Spd)` i rozwiąż 3 składowe momentu.
  - W `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.{hpp,cpp}`:
    - Dodaj na końcu `ChargeTraceSolveRequest` addytywne pole `multiphysics::SparseCpuBackendPolicy cpu_backend = multiphysics::SparseCpuBackendPolicy::Auto;`.
    - W konstruktorze `ChargeTraceWorkspace::Impl::Impl` (`:100-211`): **zwaliduj `0 <= anchor.full_dof && anchor.full_dof < count`** (rzucając `std::invalid_argument("invalid charge trace potential anchor")`) przed indeksowaniem `full_to_reduced_`, a następnie zbuduj `free_index_`, `free_count_`, `reduced_matrix_` i **`std::unique_ptr<multiphysics::SparseLinearSolver> reduced_solver_`** (gdy `free_count_ > 0`, respektując `request.cpu_backend`).
    - W `Impl::solve(...) const` (`:290-554`): użyj gotowego `reduced_solver_->solve(rhs, solution)` i tego samego obiektu w pętli korekcyjnej (`:412-463`) — usuwając powtarzaną odbudowę `reduced_matrix` i `GSSmoother` na każdej kolumnie! Zachowaj wszystkie bramki `long double`, skoki i komunikaty diagnostyczne (`:468-543`) bez zmian.
  - W `backends/fem/cpu/mfem/transport/conservative_current_view.cpp`:
    - Zachowaj dokładne symbole `solve_weighted_rt0_projection`, `solve_dense_kkt`, `class ConservativeCurrentView` (`0981.source-map.json`), tokeny sprawdzane przez `scripts/test_antenna_rt0_normalization_source.py:30-42` i `scripts/test_antenna_rt0_failure_diagnostics_source.py` (`kkt_solution[static_cast<int>(index)]`, `sparse_mass->Mult(full_solution, mass_full_solution);`, `weighted KKT residual exceeds`, `weighted correction energy is invalid`), oraz pełną analizę `ConservativeConstraintRank` i bramkę `measure_true_residual()` w `long double` po wszystkich wierszach `constraints`!
    - Gdy `request.reference_mpi_gather_broadcast == true`, przypnij jednolitą politykę `Tier 2` (`MPI_COMM_SELF` Schur-AMG `MINRES`) dla `n=1` i `n=2` (bitowa identyczność `fem_conservative_current_view_mpi_byte_identity`!).
    - W gałęzi `sparse_kkt`:
      - dla `constraint_count == 0`: `SparseLinearSolver(free_mass, Spd)`,
      - dla `constraint_count > 0`: symetryczna ekwilibracja $\beta$; Tier 1 PETSc+MUMPS LU + do 4 kroków iteracyjnego doprecyzowania na tym samym faktorze (pomijany gdy `FULLMAG_OET0_DISABLE_MPI=1`, `mpi_pinned_lane`, lub `world_size > 1 && !petsc_initialized`!); Tier 2 `MINRES` z blokowym prekondycjonerem `blkdiag(GSSmoother(M_f), HypreBoomerAMG(\tilde{S}))`, gdzie $\tilde{S} = \beta^2 \tilde{C}_f \operatorname{diag}(M_f)^{-1} \tilde{C}_f^\top$ z limitem stopnia wiersza $\le 64$ (gęste wiersze terminalowe redukowane w samym $\tilde{S}$ do wkładu diagonalnego!); Tier 3 (TSan) $\beta$-ekwalibrowany `MINRES` z `blkdiag(GSSmoother(M_f), GSSmoother(\tilde{S}))`.
    - W `solve_external_lead_potential` (`:2513-2525`): zastąp `GSSmoother`+`CGSolver` przez `SparseLinearSolver(Spd)`.
  - W `backends/fem/cpu/mfem/transport/periodic_charge_potential.cpp:1220-1240`: ustaw `trace_request.cpu_backend = request.reference_mpi_gather_rank0_broadcast ? SparseCpuBackendPolicy::Hypre : SparseCpuBackendPolicy::Auto;` przed wywołaniem `solve_charge_trace_workspace(trace_request)`.
  - Zaktualizuj `docs/physics/0970-spin-hall-drift-diffusion-transport.{md,source-map.json}` i `docs/physics/0981-fem-oet0-sparse-kkt.{md,source-map.json}`.
- [ ] **Krok 4 (Verify GREEN & Commit):**
  - W Docker DEV: `ctest --test-dir <build>/backends/fem --output-on-failure -R "fem_steady_transport_contract|fem_conservative_current_view_contract|fem_conservative_current_view_mpi_byte_identity"` (w tym z `FULLMAG_OET0_LARGE_MESH=1`) $\to$ PASS; `pytest scripts/test_antenna_rt0_normalization_source.py scripts/test_antenna_rt0_failure_diagnostics_source.py` $\to$ PASS; `validate_scientific_docs.py` dla `0970` i `0981` $\to$ PASS.
  - Commit: `git commit -m "fem(transport): add factor-once multi-RHS charge, preconditioned/direct M1/M2, and sparse MUMPS/Schur-AMG RT0 KKT"`

---

## Faza 2: Telemetria C ABI, dokumentacja `1005`, pełna macierz 5 profili buildów i benchmarki A/B

### Zadanie 4: Scalenie 3 torów, addytywna telemetria C ABI, nowa nota `1005`, weryfikacja 5 profili oraz benchmarki A/B

> **Właściciel:** Integrator / `multiphysics-verifier` (po bezkonfliktowym scaleniu 3 gałęzi Fazy 1; `CMakeLists.txt` jest już gotowy z Fazy 0!).

**Files:**
- Modify: `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` (wyłącznie addytywne klucze `resolved_*_solver` w `diagnostics_json` pod `#if FULLMAG_HAS_MFEM_STACK`, zero zmian sygnatur ani structów!)
- Create: `docs/physics/1005-fem-multiphysics-sparse-and-parallel-solvers.md`
- Create: `docs/physics/1005-fem-multiphysics-sparse-and-parallel-solvers.source-map.json`

**Interfaces:**
- Consumes: Wszystkie implementacje z Zadań 0–3.
- Produces: Addytywna telemetria solverów w `diagnostics_json`, kompletna zwalidowana dokumentacja naukowa `1005` oraz zweryfikowana macierz 5 profili + raport A/B.

- [ ] **Krok 1 (Addytywna telemetria C ABI):**
  - W `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp`: dodaj addytywne pola `"resolved_charge_solver"` / `"resolved_spin_solver"` / `"resolved_linear_solver"` w `diagnostics_json` (weryfikując zmieszczenie w buforze 1024 B i zachowując w 100% gałąź `#else` dla `FULLMAG_HAS_MFEM_STACK=0`!).
- [ ] **Krok 2 (Nowa dokumentacja naukowa `1005`):**
  - Utwórz `docs/physics/1005-fem-multiphysics-sparse-and-parallel-solvers.{md,source-map.json}` obejmujące wszystkie 15 wymaganych sekcji z `.agents/instructions/scientific.md` oraz mapowanie nowych plików (`sparse_linear_solver.{hpp,cpp}`, `direct_tetra_farfield_kernels.{hpp,cu}`).
- [ ] **Krok 3 (Weryfikacja 5 profili buildów i kontraktów w Docker DEV):**
  - **Profil 1 — Non-MFEM (`FULLMAG_USE_MFEM_STACK=OFF`, symulacja `bootstrap / native-modal-cabi-contract`):**
    Skonfiguruj i zbuduj `fullmag_fem` + `fem_oersted_contract` + `fem_modal_eigen_contract` z `-DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_ENABLE_CUDA=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF`; oczekiwane: `0` błędów kompilacji i PASS.
  - **Profil 2 — FEM CPU bez SLEPc (`FULLMAG_USE_MFEM_STACK=ON -DFULLMAG_ENABLE_CUDA=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF`):**
    Zbuduj i uruchom `ctest` dla `fem_sparse_linear_solver_contract`, `fem_oersted_vector_potential_contract`, `fem_oersted_direct_tetra_contract`, `fem_steady_transport_contract`, `fem_conservative_current_view_contract` (z `FULLMAG_OET0_LARGE_MESH=1`), `fem_demag_poisson_contract` (zawiera `charge_transport_abi_contract` i `steady_transport_abi_contract`!), `fem_steady_transport_rt0_contract` $\to$ **100% PASS** (potwierdza pełne działanie Tier 2 HYPRE AMS/BoomerAMG/ILU/Schur bez PETSc!).
  - **Profil 3 — OE-T0 TSan (`-DFULLMAG_OET0_TSAN=ON` + `TSAN_OPTIONS="halt_on_error=1:exitcode=66"`):**
    Uruchom `fem_conservative_current_view_contract` (w tym nowe testy wielowątkowego `ChargeTraceWorkspace` i `direct_tetra_quadrature.cpp`!) oraz `python3 -m unittest scripts/test_audit_fem_cpu_only_runtime.py` $\to$ **0 wyścigów TSan, PASS**.
  - **Profil 4 — 2-rank MPI qualification & byte identity (`ctest -R fem_conservative_current_view_mpi` / `mpiexec -n 2 fem_conservative_current_view_contract`):**
    Oczekiwane: **PASS bez deadlocku i bitowa identyczność `oet0-mpi-n1.bin == oet0-mpi-n2.bin`** zarówno dla `FULLMAG_FEM_WITH_SLEPC=OFF`, jak i `FULLMAG_FEM_WITH_SLEPC=ON`!
  - **Profil 5 — FEM GPU (`FULLMAG_USE_MFEM_STACK=ON -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_FEM_WITH_SLEPC=ON` + `FULLMAG_CUDSS_ROOT`):**
    - Wszystkie CTesty C++ powyżej (w tym ścieżki Tier 1 PETSc+MUMPS, `GpuCudss` i `GpuHybridFarField` z `CUDA_VISIBLE_DEVICES=""` dla testu polityki hosta HYPRE + normalnie na RTX 4080 SUPER) $\to$ **100% PASS**.
    - Rust: `cargo test -p fullmag-fem-sys -p fullmag-ir -p fullmag-plan` oraz testy transport/antenna w `cargo test -p fullmag-runner` $\to$ **100% PASS**.
  - **Walidatory dokumentacji i spójności repo:**
    - `python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py --base origin/master --head HEAD` $\to$ **PASS**.
    - `python3 scripts/check_repo_consistency.py` $\to$ **PASS**.
- [ ] **Krok 4 (Benchmarki A/B z Sekcji 9 specyfikacji):**
  - Uruchom w Docker DEV porównawcze pomiary `origin/master` vs gałąź robocza dla Benchmarku A (OE-F2: mała parzystość + 7.7k / 30k / 58k ND DOF), Benchmarku B (OE-F1: 1 vs 4 vs 8 vs 16 wątków CPU bit-exact + GPU Hybrid far-field + `ProjectField`), oraz Benchmarku C (C1 8-terminalowy charge factor-once, C2 `ChargeTraceWorkspace` 8 kolumn, C3 silnie niesymetryczne M1/M2, C4 OE-T0 RT0 KKT 18.6k DOF).
  - Zapisz wyniki w artefakcie benchmarkowym, uzupełnij sekcję walidacji w `docs/physics/1005-fem-multiphysics-sparse-and-parallel-solvers.md` rzeczywistymi zmierzonymi liczbami (zero liczb szacunkowych bez pomiaru!) i ponownie uruchom `validate_changed_scientific_docs.py`.
- [ ] **Krok 5 (Commit końcowy):**
  `git commit -m "fem(multiphysics): wire Wave 2 sparse/parallel solvers in CMake, add doc 1005, and record A/B evidence"`
