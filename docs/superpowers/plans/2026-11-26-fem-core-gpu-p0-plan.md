# Pakiet FEM Core GPU (P0 #1 + #2 + #3) — Plan Implementacji

> **Dla agentów wykonawczych:** REALIZACJA ZGODNIE ZE WZORCEM SUBAGENT-DRIVEN / SWARM-PARALLEL.
> Każdy z 3 autorów pracuje wyłącznie na swojej rozłącznej liście plików (ZERO nakładania się w Fazie 1!).
> Kolejność: Faza 0 (zamrożenie 9 szwów nagłówkowych) $\to$ Faza 1 (3 równolegli autorzy) $\to$ Faza 2 (integracja `CMakeLists.txt`, synchronizacja testu w `native_fem.rs:10379`, testy krzyżowe, walidatory dokumentacji i spójności repo, pełny weryfikator + benchmarki A/B w Docker DEV).

**Goal:** Wdrożyć kompletny pakiet optymalizacji i produkcjonizacji FEM Core GPU P0: (A) wieloblokową certyfikację par norm `ScaledNormPair` (1× sync, 16 B, bez `break;`, z zachowaniem sticky błędów HYPRE i `reject_queued_work`) oraz oczyszczenie GPU FEM/BEM (`relax_type=18`, `HypreStreamInterop`, `0.1*rtol`, `cuDSS` na `hypre_stream`, domyślny AMG); (B) produkcyjną trójstanową politykę `auto`/`cg_amg`/`cudss` przekazywaną przy tworzeniu (`fullmag_fem_plan_desc_v5` + `create_v6`) ze strażnikiem VRAM (`BUDGET_BYTES` + `MAX_VRAM_MIB`), jawnym fallbackiem do AMG oraz rozszerzeniem `cuDSS` na GPU FEM/BEM (`u1`/`u2`) i PBC-reduced Poisson; (C) FSAL `k0` dla Heun/RK4 (z rozdziałem od `endpoint_rhs_shortcut` w `rk_stage_schedule.cu:138,191` i pełnym audytem unieważnień) oraz 2-krokowy liniowy predyktor $\phi^{(0)}$ dla warm-startu HYPRE CG/AMG z ochroną `stage_time_s > last_solved_stage_time_s`.

**Architecture:** Trzy ortogonalne podsystemy połączone wąskim, zamrożonym kontraktem 9 nagłówków (Faza 0): (1) wspólny moduł certyfikacji `hypre_residual_certification.{hpp,cpp}` (wraz z `certification_solver_tolerance`) oparty na 2-przebiegowej redukcji CUB `ScaledNormPair` w `demag_kernels.{hpp,cu}`, współużytkowany przez Poisson i FEM/BEM; (2) `Context`-free trójstanowy rezolwer `cuDSS` w `cudss_direct_solver.{hpp,cpp}` (obsługujący pojedynczą macierz Poisson/PBC oraz atomową parę `(u1, u2)` dla FEM/BEM) sterowany przez addytywne `fullmag_fem_plan_desc_v5` + `fullmag_fem_backend_create_v6` z proweniencją w `FemPoissonDemagProvenance` i `FemBemDemagProvenance`; (3) rozszerzony silnik FSAL w `integrators/rk/` rozdzielający `fsal_k0_reuse` (wszystkie 4 metody RK) od `endpoint_rhs_shortcut` (wyłącznie RK23/RK45 bez frozen spins i PBC) oraz leniwie alokowany predyktor `demag_predictor.{hpp,cu}` (no-op pod `cuDSS`, `inline` invalidacja w nagłówku Fazy 0). Przechwytywanie CUDA Graph dla RK+`cuDSS` jest jawnie wyłączone jako Non-Goal (P1) (`modal_cudss_device_graph.cpp`).

**Tech Stack:** C++20, CUDA/CUB (`nvcc`), MFEM, HYPRE (BoomerAMG + PCG/GMRES), NVIDIA cuDSS 0.8+, Rust (`fullmag-ir`, `fullmag-plan`, `fullmag-fem-sys`, `fullmag-runner`), Python 3 (`fullmag-py`), CMake/CTest, Cargo, Pytest, Docker DEV (`just docker-dev`, `just fullmag-dev-container`).

**Spec:** [2026-11-26-fem-core-gpu-p0-design.md](../specs/2026-11-26-fem-core-gpu-p0-design.md)

**Global Constraints:**
- Ścisły kontrakt proweniencji (`AGENTS.md`): jawne `cudss` MUSI zakończyć się twardym błędem przy przekroczeniu VRAM lub braku `FULLMAG_FEM_CUDSS_POISSON_ENABLED` (zero cichego fallbacku); jawne `cg_amg` nigdy nie dotyka `cuDSS`; `auto` rejestruje `requested_linear_solver_strategy = "auto"`, `resolved_linear_solver` oraz `linear_solver_fallback_reason` (w `FemPoissonDemagProvenance`, `FemBemDemagProvenance` i `gpu_demag_runtime_metadata`).
- `CUDSS_DATA_INFO != 0` (macierz osobliwa / nie-SPD) oraz niepoprawne zmienne środowiskowe limitów ZAWSZE kończą się twardym błędem, również pod `auto`.
- Strategia solvera GPU musi być przekazana w `create_v6` (`plan_desc_v5`) zanim `initialize_backend_runtime` uruchomi `gpu_demag_poisson_initialize`!
- Zakaz alokacji VRAM/host w pętli gorącej RK i demag; pełne poszanowanie `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1`.
- Recepta wykonania GPU (`execution_receipt.cpp`): `FEM_GPU_OPERATOR_PRECONDITIONER` i `FEM_GPU_OPERATOR_DIRECT_SOLVE` wzajemnie się wykluczają.
- Wszystkie komendy budowania/testowania C++/CUDA/Rust/benchmarków w Docker DEV uruchamiane w grupie `just docker-dev` (nigdy `docker run` z gołymi katalogami cache na hoście).
- Zero nakładania się plików w Fazie 1; `backends/fem/CMakeLists.txt` modyfikowany wyłącznie raz w Fazie 2.
- Zgodność z `scientific-documentation-contract`: aktualizacje `docs/physics/{0913,fem_demag_fem_bem,0997}` + nowy `0998` wraz z `.source-map.json` i czystym wynikiem walidatorów `.agents/skills/scientific-documentation-contract/scripts/validate_*.py` oraz `scripts/check_repo_consistency.py`.

**Review Focus:**
1. **Skalowanie ekstremalne `±665`, zakaz `break;`, kolejność błędów NaN i sticky HYPRE status 12** — redukcja 256-blokowa musi obsługiwać `std::ldexp(1.0, ±665)`, odrzucać `rows <= 0` (`cudaErrorInvalidValue`), aktualizować oba kanały niezależnie bez `break;`, zgłaszać dokładnie `(1 fence, 16 B)` dla sukcesu/NaN, sprawdzać `!isfinite(rhs_norm)` przed `!isfinite(residual_norm)`, zachowywać sticky błędy HYPRE + `reject_queued_work` i zwracać `(0 fences, 0 B)` z `"residual matvec"` + `"HYPRE status 12"` przy błędzie matvec. *(Przypięte do: Zadanie 1, testy `cuda_demag_residual_fixture.hpp`, `cuda_periodic_demag_contract.cpp` i Zadanie 4 `demag_poisson_contract.cpp`.)*
2. **Atomowość pary `(u1, u2)` na granicy VRAM w GPU FEM/BEM i poprawność bitów recepty** — gdy `u1` mieści się samodzielnie, ale `stable_1 + peak_2 > budget`, oba uchwyty analityczne muszą zostać zniszczone bez startu faktoryzacji (`factorization_started == false`), pod `cudss` twardy błąd, pod `auto` czysty fallback obu układów do HYPRE na `hypre_stream` bez mieszania `DIRECT_SOLVE` i `PRECONDITIONER`. *(Przypięte do: Zadanie 2 i Zadanie 3, testy `demag_fem_bem_gpu_contract.cpp` oraz `cudss_poisson_budget_contract.cpp`.)*
3. **Osobliwa macierz 3D-PBC czysty Neumann pod `auto`** — macierz z niezerowym jądrem stałym musi wyzwolić `CUDSS_DATA_INFO != 0` i zakończyć się twardym błędem również pod `gpu_strategy = "auto"` (zero cichego fallbacku do CG/AMG). *(Przypięte do: Zadanie 3 i Zadanie 4, testy w `cudss_poisson_budget_contract.cpp` i `gpu_strict_execution_contract.cpp`.)*
4. **Unieważnianie FSAL `k0` (w tym `RK23/RK45 + frozen_spins` w `rk_stage_schedule.cu:138,191`) i ochrona predyktora $\phi^{(0)}$ na etapach równoczasowych, `invalidate_fsal`, retry i skoku `dt_ratio > 2.0`** — `RK23/RK45 + frozen_spins` nie może ustawić `endpoint_valid = true`; impulsy i `HOST_EXPRESSION` blokują FSAL i predyktor; RK4 stage 2 / RK4 final refresh / RK45 stage 6 (`stage_time_s <= last_solved_stage_time_s`) nie mogą nadpisywać $O(\Delta t^3)$ ekstrapolacją $O(\Delta t^2)$; rollback po failpoincie `DuringFinalFieldRefresh` przywraca pełny stan FSAL i predyktora; `api.cpp:5976` i nie-RK konsumenci unieważniają predyktor. *(Przypięte do: Zadanie 6 i Zadanie 7, test `cuda_rk_heun_rk4_fsal_predictor_contract.cpp`.)*
5. **Przekazanie strategii przy tworzeniu (`create_v6`) oraz twardy błąd na błędnym `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB` i wymuszonym `cudss` ponad limitem** — `cg_amg` przekazane do `create_v6` nigdy nie faktoryzuje `cuDSS` podczas `create`; `cudss` ponad limitem failuje twardo już w `create_v6` bez fallbacku i bez faktoryzacji; błędny format `MAX_VRAM_MIB` (`"0"`, `"-5"`, `"abc"`) failuje twardo nawet pod `auto`. *(Przypięte do: Zadanie 3 i Zadanie 5, testy `cudss_poisson_budget_contract.cpp`, `gpu_strict_execution_contract.cpp` oraz `crates/fullmag-runner`.)*

---

## Faza 0: Zamrożenie szwów nagłówkowych (Pre-Fanout Seam Commit)

### Zadanie 0: Ustalenie wspólnych typów, deklaracji i pól członkowskich w 9 nagłówkach na styku 3 torów

> **Właściciel:** Coordinator (commit bazowy przed uruchomieniem 3 worktree autorów; po tym commicie każda z 3 izolowanych gałęzi Fazy 1 kompiluje się czysto i edytuje wyłącznie swoją rozłączną listę plików ze Sekcji 5 specyfikacji).

**Files:**
- Create: `backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.hpp`
- Create: `backends/fem/gpu/cuda/demag_poisson/demag_predictor.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/demag_kernels.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.hpp`
- Modify: `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/stage_compute.hpp`
- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_runtime.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/operators.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/demag_state.hpp`

**Interfaces:**
- Produces:
  - `demag_kernels.hpp`: `GpuValidationNormScratch`, `fullmag_cuda_demag_validation_scratch_init`, `fullmag_cuda_demag_validation_scratch_destroy`, `fullmag_cuda_demag_validation_norm_pair`.
  - `hypre_residual_certification.hpp`: `inline certification_solver_tolerance(double requested_rtol)`, `GpuDemagResidualCertInput`, `GpuDemagResidualCertOutput`, `certify_gpu_hypre_demag_residual`.
  - `cudss_direct_solver.hpp`: `GpuDemagSolverStrategy`, `GpuDemagFallbackReason`, `GpuDemagCudssResolution`, `kDemagCudssMaxVramMibEnv`, `resolve_demag_gpu_solver_strategy`, `try_initialize_demag_cudss_direct`, `Context`-free `try_initialize_fem_bem_cudss_pair`.
  - `fem_bem.hpp`: deklaracje `gpu_demag_fem_bem_amg_coarse_relax_type`, `gpu_demag_fem_bem_linear_solver`, `gpu_demag_fem_bem_cudss_resolution` (implementowane w Zadaniu 2 przez Author 1, wywoływane w Zadaniu 4 przez Author 2).
  - `demag_predictor.hpp`: `GpuDemagLinearPredictorState` (z `last_solved_stage_time_s`), **`inline gpu_demag_predictor_invalidate(...)`** (wołane z `api.cpp:5976` w Author 2 i z RK w Author 3 bez sprzężenia linkera w Fazie 1!), `gpu_demag_predictor_destroy`, `gpu_demag_predictor_apply_warm_start`, `gpu_demag_predictor_commit_accepted_potential`.
  - `stage_compute.hpp`: pola `bool has_stage_time = false; double stage_time_s = 0.0; double step_dt_s = 0.0;` dodane na końcu `GpuDemagApplyRequest`.
  - `demag_poisson_runtime.hpp`: pola `GpuDemagSolverStrategy gpu_solver_strategy = GpuDemagSolverStrategy::Auto;` oraz `GpuDemagCudssResolution gpu_cudss_resolution{};` (czytane przez Author 1 i Author 2).
  - `operators.hpp`: pole `GpuValidationNormScratch validation_scratch{};` w `GpuDemagPoissonWorkspace` (używane przez Author 1 w `cuda_demag_residual_fixture.hpp` i Author 2 w `poisson.cpp`/`operators.cpp`/`hypre_device_solver.cpp`).
  - `demag_state.hpp`: pole `GpuDemagLinearPredictorState predictor{};` w `FemGpuDemagPoissonDeviceState` (używane przez Author 2 w `api.cpp:5976` i Author 3 w `gpu_state.cpp`/`stage_compute.cpp`/`rk_*`).

- [ ] **Krok 1:** Zadeklaruj powyższe typy, funkcje, `inline` helpery i 3 pola członkowskie w dziewięciu nagłówkach dokładnie według sekcji 2.1, 2.2, 3.1, 3.3 i 4.2 specyfikacji (zachowując domyślne wartości pól tak, aby obecny kod kompilował się bez zmian).
- [ ] **Krok 2:** Zweryfikuj czystą składnię nagłówków (dry-compile bez uruchamiania nowych testów).
- [ ] **Krok 3:** Commituj bazowy szew:
  `git commit -m "fem(gpu): freeze P0 9-header seams for cert, auto-cudss, fem-bem, and predictor"`

---

## Faza 1 — Author 1: `cert-fembem-author` (Track A)

> **Wyłączna własność plików:** `demag_kernels.{hpp,cu}`, `hypre_residual_certification.{hpp,cpp}`, `fem_bem.{hpp,cpp}`, `cuda_demag_residual_fixture.hpp`, `cuda_periodic_demag_contract.cpp`, `demag_fem_bem_gpu_contract.cpp`, `docs/physics/0913-*`, `docs/physics/fem_demag_fem_bem.*`. **NIE dotykać** `hypre_device_solver.*`, `cudss_direct_solver.*`, `operators.*`, `poisson.*`, `demag_poisson_contract.cpp`, `CMakeLists.txt`, `rk_*`, Rust ani Pythona!
> **Uwaga dot. testów Fazy 1 vs Fazy 2:** W izolowanym worktree Fazy 1 przechodzą samodzielne testy jednostkowe `ScaledNormPair` oraz testy źródłowe/AMG `demag_fem_bem_gpu_contract`; zintegrowany `cuda_demag_residual_fixture` / `cuda_periodic_demag_contract` oraz ścieżka `cuDSS` w `demag_fem_bem_gpu_contract` integrują się z `hypre_device_solver.cpp` i `cudss_direct_solver.cpp` Author 2 i przechodzą pełną egzekucję po scaleniu w Fazie 2!

### Zadanie 1: Wieloblokowa redukcja `ScaledNormPair` + wspólny moduł `hypre_residual_certification`

**Files:**
- Modify: `backends/fem/gpu/cuda/demag_poisson/demag_kernels.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu`
- Create: `backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.cpp`
- Modify: `backends/fem/tests/cuda_demag_residual_fixture.hpp`
- Modify: `backends/fem/tests/cuda_periodic_demag_contract.cpp`

**Interfaces:**
- Consumes: `ScaledNorm`, `MergeScaledNorm`, `FinalizeScaledNorm` (`demag_kernels.cu`); wzorzec `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK` (`reduction_workspace_memory.cpp`); `GpuDemagResidualCertInput/Output` (Faza 0).
- Produces: `fullmag_cuda_demag_validation_scratch_{init,destroy}`, `fullmag_cuda_demag_validation_norm_pair`, `certify_gpu_hypre_demag_residual`.

- [ ] **Krok 1 (TDD — failing tests):** Zaktualizuj `cuda_demag_residual_fixture.hpp` i `cuda_periodic_demag_contract.cpp` (**Review Focus #1**):
  - W `cuda_demag_residual_fixture.hpp:29-69`: ustaw `ctx.poisson_demag.gpu_solver_strategy = GpuDemagSolverStrategy::CgAmg;` i wywołaj `fullmag_cuda_demag_validation_scratch_{init,destroy}(workspace.validation_scratch)` (chroni przed segfaultem na `workspace.solver == nullptr` pod domyślnym `Auto`!).
  - W `cuda_demag_residual_fixture.hpp`: dodaj samodzielny test `fullmag_cuda_demag_validation_norm_pair` dla: (a) `rows <= 0` $\to$ `cudaErrorInvalidValue`, (b) `std::ldexp(1.0, +665)` i `std::ldexp(1.0, -665)` (błąd $\le 10^{-14}$), (c) `rows = 100000` (wieloblokowy grid-stride), (d) `b` z `NaN` przy skończonym `r` i odwrotnie (weryfikacja braku przedwczesnego `break;`!), (e) wektora zerowego (`0.0`), (f) `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1` (`host_pinned == false`).
  - W `validate_candidate` (`:78-108`): przejdź na `(expected_fences, expected_bytes)`: `(1, 16)` w `:109, 143, 156, 180, 187` i **`(0, 0)`** w `:166` (błąd HYPRE matvec status 12).
  - W `cuda_periodic_demag_contract.cpp:215-232`: podmień asercje źródłowe na `demag_validation_norm_pair_blocks_kernel`, `demag_validation_norm_pair_finalize_kernel` i `certify_gpu_hypre_demag_residual`.
- [ ] **Krok 2 (Implement):**
  - W `demag_kernels.cu`: zaimplementuj `ScaledNormPair`, `MergeScaledNormPairOp`, `fullmag_cuda_demag_validation_scratch_{init,destroy}` (8 KiB `d_partials`, 16 B `d_out_norms`, 16 B `h_norms` pinned/pageable), `demag_validation_norm_pair_blocks_kernel` (grid-stride **bez `break;`** na `!isfinite`, niezależne kanały `rhs`/`residual`, `rows <= 0` $\to$ `cudaErrorInvalidValue`), `demag_validation_norm_pair_finalize_kernel`, oraz `fullmag_cuda_demag_validation_norm_pair` (1× `cudaMemcpyAsync` + 1× `cudaStreamSynchronize`). Zachowaj jednoargumentową `fullmag_cuda_demag_validation_norm` dla testu aliasowania `:212`.
  - W `hypre_residual_certification.cpp`: zaimplementuj `certify_gpu_hypre_demag_residual` zachowując **verbatim** logikę z `hypre_device_solver.cpp:603-622` (BEZ `HYPRE_ClearAllErrors()`, BEZ `HYPRE_ClearError(...)` i BEZ wywołań `HYPRE_GetError()` po `Mult`/`Axpy`!): `const HYPRE_Int prior_status = HYPRE_GetError();` (błąd przy `(prior_status & ~HYPRE_ERROR_CONV) != 0`), `const HYPRE_Int matvec_status = input.A_par->Mult(*input.x_par, *input.residual);` (błąd przy `matvec_status != 0` z komunikatem `std::string(input.label) + " residual matvec failed: HYPRE status " + std::to_string(matvec_status)`), `const HYPRE_Int axpy_status = HYPRE_ParVectorAxpy(-1.0, *input.b_par, *input.residual);` (błąd przy `(axpy_status & ~(prior_status & HYPRE_ERROR_CONV)) != 0` z komunikatem `std::string(input.label) + " residual AXPY failed: HYPRE status " + std::to_string(axpy_status)`), wraz z awaryjną synchronizacją `reject_queued_work` (`cudaStreamSynchronize(input.stream)` z `:555-565`) na każdej ścieżce błędu! Zwracaj `0` fences / `0` B przy błędzie `Mult`/`Axpy`, i `1` fence / `16 B` (lub `8 B`) przy złączonym readbacku.
- [ ] **Krok 3 (Verify & Commit):** Zweryfikuj samodzielny test jednostkowy `ScaledNormPair` (w tym z `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1`) i czystą kompilację; commituj:
  `git commit -m "fem(gpu): add multi-block ScaledNormPair and shared sticky-safe residual certifier"`

---

### Zadanie 2: Oczyszczenie GPU FEM/BEM (`relax_type=18`, `HypreStreamInterop`, `0.1*rtol`, `cuDSS` na `hypre_stream`, bugfix `:1059`) + Dokumentacja `0913` i `fem_demag_fem_bem`

**Files:**
- Modify: `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.hpp`
- Modify: `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp`
- Modify: `backends/fem/tests/demag_fem_bem_gpu_contract.cpp`
- Modify: `docs/physics/0913-fem-gpu-amg-coarse-residency.{md,source-map.json}`
- Modify: `docs/physics/fem_demag_fem_bem.{md,source-map.json}`

**Interfaces:**
- Consumes: `HypreStreamInterop` (`hypre_stream_interop.hpp`); `GpuValidationNormScratch`, `certification_solver_tolerance`, `certify_gpu_hypre_demag_residual` (Faza 0 / Zadanie 1); `Context`-free `try_initialize_fem_bem_cudss_pair`, `solve_demag_cudss_direct`, `GpuDemagCudssResolution` (Faza 0).
- Produces: Implementacje `gpu_demag_fem_bem_amg_coarse_relax_type`, `gpu_demag_fem_bem_linear_solver`, `gpu_demag_fem_bem_cudss_resolution`.

- [ ] **Krok 1 (TDD — failing test):** Rozszerz `backends/fem/tests/demag_fem_bem_gpu_contract.cpp` (**Review Focus #2**):
  - Asercje źródłowe: `HYPRE_BoomerAMGSetCycleRelaxType(amgraw, 18, 3)` i `HYPRE_BoomerAMGGetCycleRelaxType`, brak surowych `cudaStreamSynchronize` przed/po `Mult`, brak blokujących `Norml2()` w `solve_linear_system`, użycie `certification_solver_tolerance`, przypięcie `solve_demag_cudss_direct` do `ws.stream_interop.hypre_stream`, oraz brak bezwarunkowego `FEM_GPU_OPERATOR_PRECONDITIONER` w `compute_device_demag_fem_bem_for_device_stage`.
  - Testy wykonawcze GPU: `gpu_demag_fem_bem_amg_coarse_relax_type == 18` pod `CgAmg`, zgodność $H_{\text{demag}}$ z CPU FEM/BEM ($\le 10^{-8}$), dokładnie 1 fence / 16 B na układ (`u1`, `u2`, łącznie 2 fences / 32 B); dla `cuDSS` (pełna weryfikacja w Fazie 2) brak konfliktu bitów `DIRECT_SOLVE` vs `PRECONDITIONER` i atomowy fallback pary `(u1, u2)` przy ciasnym limicie VRAM.
- [ ] **Krok 2 (Implement):** W `fem_bem.hpp` i `fem_bem.cpp`:
  - Dodaj `std::shared_ptr<GpuDemagCudssDirectSolver> direct_solver;` w `GpuFemBemLinearSystem` oraz `HypreStreamInterop stream_interop{}`, `GpuValidationNormScratch validation_scratch{}`, `GpuDemagCudssResolution cudss_resolution{}` w `GpuDemagFemBemWorkspace`.
  - W `configure_amg`: ustaw i zweryfikuj `HYPRE_BoomerAMGSetCycleRelaxType(amgraw, 18, 3)` (jak w `hypre_device_solver.cpp:50-122`).
  - W `initialize_linear_system` i `configure_solver_initial_iterate`: użyj `certification_solver_tolerance(requested_rtol)`.
  - W `gpu_demag_fem_bem_initialize`: zainicjalizuj `stream_interop` i `validation_scratch`; wywołaj `Context`-free `try_initialize_fem_bem_cudss_pair(ctx.poisson_demag.gpu_solver_strategy, *neumann_op, *dirichlet_op, u1.direct_solver, u2.direct_solver, u1_stats, u2_stats, ws.cudss_resolution, error)`. Przy `CudssDirect` zaktualizuj `ws.device_bytes` o `u1_stats.device_bytes + u2_stats.device_bytes`, ustaw `rows`, `solver_setup_count`, `solver_setup_complete` dla `u1_system`/`u2_system` i pomiń budowę HYPRE preconditionera/solvera (zbuduj wyłącznie `A_par`, `b_par`, `x_par`, `residual` do certyfikacji). Przy `HypreKrylov` zbuduj HYPRE Krylov + AMG dla obu układów.
  - W `solve_linear_system` (`:394-455`): zastąp oba `cudaStreamSynchronize` wywołaniami `hypre_wait_for_fullmag` / `fullmag_wait_for_hypre`; wywołaj `solve_demag_cudss_direct(..., ws.stream_interop.hypre_stream, ...)` (gdy `direct_solver != nullptr`) albo `solver->Mult`; zastąp `Add(-1.0)` + 2× `Norml2()` wywołaniem `certify_gpu_hypre_demag_residual` na `hypre_stream` (kolejność `!isfinite(rhs_norm)` przed `!isfinite(residual_norm)`, aktualizacja `transfer_audit` i `performance_counters`); emituj bit `direct_solver != nullptr ? FEM_GPU_OPERATOR_DIRECT_SOLVE : FEM_GPU_OPERATOR_PRECONDITIONER` wyłącznie tutaj!
  - Usuń `FEM_GPU_OPERATOR_PRECONDITIONER` z `fem_bem.cpp:1059` (zostawiając `FEM_GPU_OPERATOR_DEMAG_RHS | FEM_GPU_OPERATOR_DEMAG_SOLVE | FEM_GPU_OPERATOR_DEMAG_RECOVERY`).
  - Zaimplementuj `gpu_demag_fem_bem_amg_coarse_relax_type`, `gpu_demag_fem_bem_linear_solver`, `gpu_demag_fem_bem_cudss_resolution` oraz sprzątanie w `gpu_demag_fem_bem_destroy`.
- [ ] **Krok 3 (Docs):** Zaktualizuj `docs/physics/0913-fem-gpu-amg-coarse-residency.{md,source-map.json}` oraz `docs/physics/fem_demag_fem_bem.{md,source-map.json}`.
- [ ] **Krok 4 (Commit):** `git commit -m "fem(gpu): unify FEM/BEM AMG coarse residency, stream interop, paired cert, and cuDSS hooks"`

---

## Faza 1 — Author 2: `cudss-auto-author` (Track B)

> **Wyłączna własność plików:** `cudss_direct_solver.{hpp,cpp}`, `hypre_device_solver.{hpp,cpp}`, `operators.cpp`, `poisson.{hpp,cpp}`, `native/include/fullmag_fem.h`, `backends/fem/src/api.cpp`, `crates/fullmag-fem-sys/src/lib.rs`, `packages/fullmag-py/src/fullmag/{model/discretization.py,world.py,runtime/script_builder.py}`, `packages/fullmag-py/tests/test_api.py`, `crates/fullmag-ir/src/study.rs`, `crates/fullmag-plan/src/fem.rs`, `crates/fullmag-runner/src/{types.rs,dispatch.rs,artifacts.rs,native_fem.rs,frequency_response.rs,native_fem/{plan.rs,runtime_info.rs},fem/{runtime_contract.rs,execution.rs,relax/finalize.rs}}`, `backends/fem/tests/{cudss_poisson_budget_contract.cpp,demag_poisson_contract.cpp,gpu_strict_execution_contract.cpp,llg_time_domain_qualification.cpp}`, `docs/physics/0997-*`. **NIE dotykać** `demag_kernels.*`, `fem_bem.*`, `operators.hpp`, `demag_poisson_runtime.hpp`, `demag_state.hpp`, `rk_*`, `stage_compute.*`, `gpu_state.cpp`, `CMakeLists.txt`!

### Zadanie 3: `Context`-free trójstanowy rezolwer `cuDSS` + `MAX_VRAM_MIB` + atomowy preflight pary FEM/BEM

**Files:**
- Modify: `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp`
- Modify: `backends/fem/tests/cudss_poisson_budget_contract.cpp`

**Interfaces:**
- Consumes: `GpuDemagSolverStrategy`, `GpuDemagFallbackReason`, `GpuDemagCudssResolution`, `FULLMAG_FEM_CUDSS_POISSON_ENABLED` (Faza 0).
- Produces: `resolve_demag_gpu_solver_strategy`, rozszerzony `resolve_demag_cudss_device_budget` (`BUDGET_BYTES` + `MAX_VRAM_MIB`), `try_initialize_demag_cudss_direct`, `Context`-free `try_initialize_fem_bem_cudss_pair`.

- [ ] **Krok 1 (TDD — failing tests):** Rozszerz `cudss_poisson_budget_contract.cpp` (**Review Focus #2, #3, #5**):
  1. `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB`: MiB $\to$ bajty, `min(bytes_cap, mib_cap)` przy obu ustawionych, twardy błąd na `"0"`, `"-5"`, `"abc"`, przepełnieniu `uint64_t` (nawet pod `auto`!).
  2. Precedencja `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER`: `"cudss"`, `"cg_amg"`/`"hypre"`/`"off"`, `"auto"`, unset (używa `requested_strategy`), niepoprawna wartość (twardy błąd).
  3. `auto` ponad limitem $\to$ `true`, `solver == nullptr`, `HypreKrylov`, `CudssFactorExceedsVramBudget`, `factorization_started == false`.
  4. `cudss` ponad limitem $\to$ `false` (twardy błąd z estimate i budget), `factorization_started == false`.
  5. `try_initialize_fem_bem_cudss_pair` na granicy `peak_1 <= budget && stable_1 + peak_2 > budget`: pod `auto` oba `nullptr` + `CudssFactorExceedsVramBudget` + `factorization_started == false`; pod `cudss` twardy błąd bez wycieku `u1`.
  6. Osobliwa macierz 3D-PBC czysty Neumann (zerowa suma wierszy, bez pina): pod `auto` zwraca `false` (`CUDSS_DATA_INFO != 0`, brak fallbacku!).
- [ ] **Krok 2 (Implement):** W `cudss_direct_solver.cpp`: rozdziel fazę analizy i faktoryzacji, dodaj `MAX_VRAM_MIB` + `resolve_demag_gpu_solver_strategy`, zaimplementuj `try_initialize_demag_cudss_direct` i `try_initialize_fem_bem_cudss_pair` z wykorzystaniem makra `FULLMAG_FEM_CUDSS_POISSON_ENABLED`.
- [ ] **Krok 3 (Verify & Commit):** Uruchom `cudss_poisson_budget_contract` i commituj:
  `git commit -m "fem(gpu): implement auto/cg_amg/cudss resolver, MAX_VRAM_MIB cap, and atomic FEM/BEM pair preflight"`

---

### Zadanie 4: Podpięcie `auto`-`cuDSS`, PBC-reduced `cuDSS`, `validation_scratch` i wspólnej certyfikacji w Poisson GPU

**Files:**
- Modify: `backends/fem/gpu/cuda/demag_poisson/operators.cpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/poisson.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/poisson.cpp`
- Modify: `backends/fem/tests/demag_poisson_contract.cpp`

**Interfaces:**
- Consumes: `certify_gpu_hypre_demag_residual`, `certification_solver_tolerance`, `GpuValidationNormScratch`, `workspace.validation_scratch` (`operators.hpp`), `ctx.poisson_demag.gpu_solver_strategy`/`gpu_cudss_resolution` (`demag_poisson_runtime.hpp`), deklaracje `gpu_demag_fem_bem_*` (`fem_bem.hpp`) — wszystko zamrożone w Fazie 0; `try_initialize_demag_cudss_direct` (Zadanie 3).
- Produces: `gpu_demag_linear_solver_provenance(ctx)` dla Poisson (open + PBC) i FEM/BEM; odblokowane PBC-reduced `cuDSS`.

- [ ] **Krok 1 (TDD — failing tests):**
  - W `backends/fem/tests/demag_poisson_contract.cpp:2981-3231`: ustaw jawnie `ctx.poisson_demag.gpu_solver_strategy = GpuDemagSolverStrategy::CgAmg;` w `:2981` i zaktualizuj `:3030` z `control_fences == 4u` na `control_fences == 2u` (zachowując `control_bytes == 4u * sizeof(double)` = 32 B dla 2 rozwiązań).
  - Dodaj w `gpu_strict_execution_contract.cpp` (Zadanie 5) testy PBC-reduced 1D Robin i 2D film (singleton pin) z `CUDSS_DIRECT`.
- [ ] **Krok 2 (Implement):**
  - W `operators.cpp:1257`: wywołaj idempotentne `fullmag_cuda_demag_validation_scratch_destroy` przy zwalnianiu `workspace` (**NIE** alokuj w `upload_demag_poisson_operators`!).
  - W `poisson.cpp:104`: zainicjalizuj `workspace->validation_scratch` obok `initialize_hypre_stream_interop` (unikając duplikacji z `fem_bem.hpp:70`!). W `poisson.hpp/.cpp`: rozszerz `gpu_demag_poisson_linear_solver(ctx)` o delegację do `gpu_demag_fem_bem_linear_solver(ctx)` i dodaj `gpu_demag_linear_solver_provenance(ctx)`.
  - W `hypre_device_solver.cpp`:
    - Usuń blokadę `if (demag_periodic_poisson_reduction_requested(ctx))` w `:218-222`.
    - Zastąp `demag_gpu_direct_solver_requested()` wywołaniem `try_initialize_demag_cudss_direct(ctx.poisson_demag.gpu_solver_strategy, *A_bc, workspace.direct_solver, workspace.direct_solver_stats, ctx.poisson_demag.gpu_cudss_resolution, error)`.
    - W `validate_demag_poisson_hypre_device_solve`: zastąp 2× `read_validation_norm` wywołaniem `certify_gpu_hypre_demag_residual(...)` z `workspace.validation_scratch`, zapisując 1× fence i 16 B w `transfer_audit` / `performance_counters`, oraz sprawdzając `!isfinite(rhs_norm)` **przed** `demag_rhs_norm_evaluations` i **przed** `!isfinite(absolute_residual)` (zachowując `reject_queued_work` na błędach!).
    - W `read_device_demag_amg_coarse_relax_type`: dodaj delegację do `gpu_demag_fem_bem_amg_coarse_relax_type` dla `DEVICE_HYPRE_FEM_BEM`.
- [ ] **Krok 3 (Commit):** `git commit -m "fem(gpu): enable auto-cudss, PBC-reduced cuDSS, and shared cert in Poisson solver"`

---

### Zadanie 5: C ABI (`plan_desc_v5` + `create_v6`), Python DSL, Rust IR/Plan/Runner, domyślny AMG dla GPU FEM/BEM i dokumentacja `0997`

**Files:**
- Modify: `native/include/fullmag_fem.h`
- Modify: `backends/fem/src/api.cpp`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `packages/fullmag-py/src/fullmag/model/discretization.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `packages/fullmag-py/tests/test_api.py`
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-runner/src/{types.rs,dispatch.rs,artifacts.rs,native_fem.rs,frequency_response.rs}`
- Modify: `crates/fullmag-runner/src/native_fem/{plan.rs,runtime_info.rs}`
- Modify: `crates/fullmag-runner/src/fem/{runtime_contract.rs,execution.rs}`
- Modify: `crates/fullmag-runner/src/fem/relax/finalize.rs`
- Modify: `backends/fem/tests/{gpu_strict_execution_contract.cpp,llg_time_domain_qualification.cpp}`
- Modify: `docs/physics/0997-fem-gpu-poisson-direct-cudss.{md,source-map.json}`

**Interfaces:**
- Consumes: `gpu_demag_linear_solver_provenance(ctx)` (Zadanie 4); `inline gpu_demag_predictor_invalidate` (Faza 0 `demag_predictor.hpp`).
- Produces: `fullmag_fem_plan_desc_v5`, `fullmag_fem_backend_create_v6`, `fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1`; `FemLinearSolverPolicy.gpu_strategy`; rozszerzone `FemPoissonDemagProvenance` i `FemBemDemagProvenance`.

- [ ] **Krok 1 (TDD — failing tests):**
  - Python (`packages/fullmag-py/tests/test_api.py:2617-2625`): zaktualizuj dokładne porównanie słownika `to_ir()` o `"gpu_strategy": "auto"` + testy round-trip `"auto"|"cg_amg"|"cudss"` i odrzucenia `"bogus"`.
  - Rust: testy deserializacji starego JSON IR (brak `gpu_strategy` $\to$ `"auto"`), aktualizacja `dispatch.rs:5171` (`("cuda", FredkinKoehler)` $\to$ `"AMG"`), testy proweniencji `requested_linear_solver_strategy` / `resolved_linear_solver` / `linear_solver_fallback_reason` w `types.rs`, `artifacts.rs`, `fem/execution.rs`.
  - C++ (`gpu_strict_execution_contract.cpp`, `llg_time_domain_qualification.cpp`): (**Review Focus #3, #5**) `create_v6` z `CG_AMG` (nie faktoryzuje `cuDSS` podczas `create`!), `create_v6` z `CUDSS` + `MAX_VRAM_MIB=1` (twardy błąd już w `create_v6`), `create_v6` z `AUTO` + `MAX_VRAM_MIB=1` (fallback do `HYPRE_KRYLOV` + `CUDSS_FACTOR_EXCEEDS_VRAM_BUDGET`), `create_v6` z `AUTO` na PBC 1D Robin i 2D film (`CUDSS_DIRECT`), walidacja null/złego `abi_version`/`struct_size`/`reserved`, etykieta `"direct_solve"` w `llg_time_domain_qualification.cpp`.
- [ ] **Krok 2 (Implement):**
  - W `fullmag_fem.h`, `api.cpp`, `crates/fullmag-fem-sys/src/lib.rs`: dodaj `fullmag_fem_gpu_demag_solver_strategy_v1`, `fullmag_fem_gpu_demag_fallback_reason_v1`, `fullmag_fem_plan_desc_v5`, `fullmag_fem_backend_create_v6` (ustawiające `handle->context.poisson_demag.gpu_solver_strategy` w `create_versioned_plan_backend` **przed** `initialize_backend_runtime`!) oraz `fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1`.
  - W `api.cpp:5976` (`fullmag_fem_backend_invalidate_fsal`): dodaj wywołanie `gpu_demag_predictor_invalidate(handle->context.gpu_state.device.demag_poisson.predictor);` (funkcja `inline` z Fazy 0 `demag_predictor.hpp` — zero zależności linkera!).
  - W Pythonie: `discretization.py`, `world.py`, wszystkie 3 helpery `script_builder.py:4929,5000,5027`.
  - W Rust: `study.rs:1005`, `fullmag-plan/src/fem.rs`, literały `FemLinearSolverPolicy` w `frequency_response.rs:5418,5726`, usunięcie obejścia `"JACOBI"` w `native_fem/plan.rs:81-89`, przejście `NativeFemBackend::create` (`native_fem.rs:4369`) na `fullmag_fem_backend_create_v6` + odczyt proweniencji, aktualizacja literałów `FemBemDemagProvenance` (`native_fem/runtime_info.rs:350`, `artifacts.rs:7286`) i `FemPoissonDemagProvenance` (`dispatch.rs:3932`, `fem/runtime_contract.rs:296`), dopięcie `apply_native_fem_gpu_demag_linear_solver_provenance` w **`fem/execution.rs:376-393`**, `dispatch.rs` i `fem/relax/finalize.rs:399-407`, oraz publikacja w `artifacts.rs:1271`.
- [ ] **Krok 3 (Docs):** Zaktualizuj `docs/physics/0997-fem-gpu-poisson-direct-cudss.{md,source-map.json}` (polityka trójstanowa, `create_v6`, `MAX_VRAM_MIB`, PBC-reduced SPD, FEM/BEM para `(u1, u2)`, sekcja P1 non-goal dla CUDA Graph).
- [ ] **Krok 4 (Verify & Commit):** Uruchom `cargo test -p fullmag-ir -p fullmag-plan -p fullmag-runner --lib` i `pytest packages/fullmag-py/tests/test_api.py`; commituj:
  `git commit -m "fem(gpu): expose create_v6 gpu_strategy and fallback provenance across C ABI, Rust, and Python"`

---

## Faza 1 — Author 3: `rk-fsal-author` (Track C)

> **Wyłączna własność plików:** `integrators/rk/{rk_fsal_policy.{hpp,cpp},rk_step_preflight.cu,rk_attempt_setup.cu,rk_stage_schedule.cu,rk_final_refresh.cu,rk_workspace_state.hpp,rk_demag_dispatch.{hpp,cu},rk_rhs_runtime.cu}`, `cpu/mfem/integrators/rk_step_transaction.cpp`, `demag_poisson/demag_predictor.{hpp,cu}`, `demag_poisson/stage_compute.{hpp,cpp}`, `state/gpu_state.cpp`, `tests/{cuda_rk_guard_contract.cpp,source_facade_gpu_rk_contract.cpp,cuda_rk_heun_rk4_fsal_predictor_contract.cpp}`, `crates/fullmag-runner/src/native_fem/tests/parity.rs`, `docs/physics/0998-*`. **NIE dotykać** `demag_kernels.*`, `hypre_device_solver.*`, `cudss_direct_solver.*`, `fem_bem.*`, `demag_state.hpp`, `operators.hpp`, `demag_poisson_runtime.hpp`, `api.cpp`, `native_fem.rs`, `CMakeLists.txt`!

### Zadanie 6: FSAL `k0` dla Heun i RK4 + rozdział `endpoint_rhs_shortcut` w `rk_stage_schedule.cu` + audyt unieważnień

**Files:**
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_workspace_state.hpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.hpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_preflight.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_attempt_setup.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_stage_schedule.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu`
- Modify: `backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp`
- Modify: `backends/fem/tests/cuda_rk_guard_contract.cpp`
- Modify: `backends/fem/tests/source_facade_gpu_rk_contract.cpp`
- Create: `backends/fem/tests/cuda_rk_heun_rk4_fsal_predictor_contract.cpp`
- Modify: `crates/fullmag-runner/src/native_fem/tests/parity.rs`

**Interfaces:**
- Consumes: `ctx.zeeman`, `ctx.oersted`, `ctx.sot`, `ctx.stt`, `ctx.dmi`, `ctx.frozen_spins`, `ctx.thermal_brown`, `gpu.relaxation.state_generation`, `gpu.mesh_regions.has_periodic_reduced_nodes`.
- Produces: `gpu_rk_has_discontinuous_or_host_drive(ctx)`, `gpu_rk_rhs_allows_fsal_k0_reuse(ctx)`, `gpu_rk_allows_endpoint_rhs_shortcut(ctx)`, rozszerzone `gpu_rk_fsal_operator_signature(ctx)`, pola `fsal_time_seconds`, `fsal_operator_signature`, `active_step_dt_s` w `FemGpuRkWorkspaceDeviceState`.

- [ ] **Krok 1 (TDD — failing tests):**
  - Utwórz `backends/fem/tests/cuda_rk_heun_rk4_fsal_predictor_contract.cpp` (**Review Focus #4**):
    1. Heun i RK4 na 5 krokach: krok 1 = 3 / 5 RHS (`fsal_reused == false`), kroki 2..5 = 2 / 4 RHS (`fsal_reused == true`), parzystość z FSAL OFF $\le 10^{-14}$.
    2. Napędy impulsowe (`FULLMAG_FEM_TIME_PULSE`, Oersted `time_dep_kind == 2`, SOT pulse) i `HOST_EXPRESSION`: `fsal_reused == false`.
    3. Napęd ciągły `SINUSOIDAL`: `fsal_reused == true` przy zgodnym `fsal_time_seconds`, a po zmianie `current_time`, `external_field_am`, `stage_start_time_s` lub `relaxation.state_generation` `fsal_reused == false`.
    4. Zamrożone spiny (`frozen_spins`) i PBC: Heun/RK4 osiągają `fsal_reused == true` od kroku 2 i parzystość $\le 10^{-14}$; **RK23/RK45 + `frozen_spins` NIE ustawia `endpoint_valid = true`** w `rk_stage_schedule.cu` i ma `endpoint_cache_invalidations == 0`!
    5. Rollback transakcji (`rk_step_transaction.cpp:457,654`): przywraca `(fsal_valid, fsal_time_seconds, fsal_operator_signature)` i metadane predyktora po wstrzykniętym failpoincie `DuringFinalFieldRefresh`.
  - Zaktualizuj `backends/fem/tests/source_facade_gpu_rk_contract.cpp:474,1382` (nowe wzorce `fsal_method` i `fsal_reused`) oraz `crates/fullmag-runner/src/native_fem/tests/parity.rs:202-261` (rozdział oczekiwań GPU vs CPU dla kroku 2 + 5-krokowy test parzystości Heun/RK4 GPU vs CPU).
- [ ] **Krok 2 (Implement):**
  - W `rk_workspace_state.hpp`: dodaj `double fsal_time_seconds = 0.0;`, `uint64_t fsal_operator_signature = 0;`, `double active_step_dt_s = 0.0;`.
  - W `rk_fsal_policy.{hpp,cpp}`: zaimplementuj `gpu_rk_has_discontinuous_or_host_drive(ctx)`, `gpu_rk_rhs_allows_fsal_k0_reuse(ctx)`, `gpu_rk_allows_endpoint_rhs_shortcut(ctx)` (`gpu_rk_rhs_allows_fsal_k0_reuse(ctx) && !ctx.frozen_spins.enabled() && !ctx.gpu_state.device.mesh_regions.has_periodic_reduced_nodes`) oraz rozszerz `gpu_rk_fsal_operator_signature(ctx)` (`:45-67`) o `zeeman.external_field_am[0..2]`, `zeeman.stage_start_time_s`, `gpu.relaxation.state_generation`, `stt.*`, `sot.*`, `oersted.time_dep_kind`, `dmi.rotated_interfacial_enabled`, `frozen_spins.enabled()`.
  - W `rk_step_preflight.cu`: ustaw `result.fsal_method = (result.is_heun || result.is_rk4 || result.is_rk23 || result.is_rk45) && gpu_rk_rhs_allows_fsal_k0_reuse(ctx);`.
  - W `rk_attempt_setup.cu`: zapisz `gpu.rk.active_step_dt_s = active_dt;` oraz zaktualizuj:
    `fsal_reused = fsal_method && gpu.rk.fsal_valid && gpu.rk.fsal_time_seconds == ctx.state.current_time && gpu.rk.fsal_operator_signature == gpu_rk_fsal_operator_signature(ctx);`
  - W **`rk_stage_schedule.cu:138` i `:191`**: zamień `if (fsal_method && !gpu.mesh_regions.has_periodic_reduced_nodes)` na **`if (gpu_rk_allows_endpoint_rhs_shortcut(ctx))`**!
  - W `rk_final_refresh.cu`: sprawdź `reuse_bs23_fsal_rhs && gpu_rk_allows_endpoint_rhs_shortcut(ctx)` dla `endpoint_rhs_ready`; przy `fsal_valid = true` zapisz `fsal_time_seconds = endpoint_time` i `fsal_operator_signature = gpu_rk_fsal_operator_signature(ctx)`.
  - W `rk_step_transaction.cpp:457,654`: snapshotuj i przywracaj `fsal_time_seconds` i `fsal_operator_signature` obok `gpu_fsal_valid`.
- [ ] **Krok 3 (Verify & Commit):** Uruchom `source_facade_gpu_rk_contract` i `cuda_rk_guard_contract`; commituj:
  `git commit -m "fem(gpu): enable FSAL k0 reuse for Heun and RK4 with endpoint shortcut separation"`

---

### Zadanie 7: Dwukrokowy liniowy predyktor $\phi^{(0)}$ z ochroną etapów równoczasowych + Dokumentacja `0998`

**Files:**
- Create: `backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu`
- Modify: `backends/fem/gpu/cuda/demag_poisson/demag_predictor.hpp`
- Modify: `backends/fem/gpu/cuda/state/gpu_state.cpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/stage_compute.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_attempt_setup.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_demag_dispatch.{hpp,cu}`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu`
- Modify: `backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp`
- Modify: `backends/fem/tests/cuda_rk_heun_rk4_fsal_predictor_contract.cpp`
- Create: `docs/physics/0998-fem-gpu-rk-fsal-and-potential-predictor.{md,source-map.json}`

**Interfaces:**
- Consumes: `GpuDemagLinearPredictorState`, `inline gpu_demag_predictor_invalidate`, `gpu.demag_poisson.predictor` (`demag_state.hpp`), `GpuDemagApplyRequest` (Faza 0); `gpu_demag_poisson_linear_solver(ctx)` (`poisson.hpp`); `gpu_rk_rhs_allows_fsal_k0_reuse(ctx)` (Zadanie 6).
- Produces: Predyktor $\phi^{(0)}(t_{\text{eval}})$ aktywny wyłącznie w trybie Krylov RK przy `stage_time_s > last_solved_stage_time_s`.

- [ ] **Krok 1 (TDD — failing tests):** Rozszerz `cuda_rk_heun_rk4_fsal_predictor_contract.cpp` (**Review Focus #4**):
  1. Matematyka kernela: $\phi_n + \alpha(\phi_n - \phi_{n-1})$ dokładne do $10^{-14}$ z zachowaniem zer na `ess_tdofs`.
  2. **Ochrona etapów równoczasowych:** RK4 stage 2 ($c_2=0.5$ po $c_1=0.5$) oraz RK4 final refresh ($c=1.0$ po $c_3=1.0$) **NIE** wywołują ekstrapolacji (`stage_time_s <= last_solved_stage_time_s`) i zachowują dokładniejsze `poisson_solution` z poprzedniego etapu!
  3. Strażniki: `history_count < 2`, `dt_ratio = 2.5 > 2.0`, `reset_initial_solution = true`, nie-RK `purpose` (`RelaxationTrial`, `ValidationOracle`, `FrequencyTangent`, `ObservableRefresh`) $\implies$ unieważnienie predyktora.
  4. Rollback po failpoincie `DuringFinalFieldRefresh`: bufory `d_phi_curr`/`d_phi_prev` nieprzesunięte, metadane przywrócone.
  5. Zero-overhead pod `cuDSS`: `d_phi_curr == nullptr && d_phi_prev == nullptr` po 5 krokach RK.
  6. Redukcja iteracji CG/AMG: na 10 krokach Heun/RK4 pod `CG_AMG` (Poisson) łączna liczba iteracji z predyktorem jest mniejsza niż bez predyktora przy zgodności $m \le 10^{-10}$.
- [ ] **Krok 2 (Implement):**
  - W `demag_predictor.cu`: zaimplementuj kernel `demag_linear_predict_potential_kernel`, `gpu_demag_predictor_apply_warm_start` (z warunkiem `stage_time_s > state.last_solved_stage_time_s`, `dt_ratio <= 2.0`, `0 < alpha <= 2.0`, `operator_signature` match), `gpu_demag_predictor_commit_accepted_potential` (leniwa alokacja tylko dla Krylov, swap + D2D copy) i `gpu_demag_predictor_destroy`.
  - W `gpu_state.cpp`: zwalniaj `gpu.demag_poisson.predictor` (zadeklarowane w Fazie 0 w `demag_state.hpp`) w `gpu_state_destroy` i przy zmianie rozmiaru; unieważniaj przy zewnętrznych uploadach `m`.
  - W `rk_attempt_setup.cu`: zresetuj `gpu.demag_poisson.predictor.last_solved_stage_time_s = ctx.state.current_time;` na starcie próby.
  - W `rk_rhs_runtime.cu`, `rk_demag_dispatch.{hpp,cu}` i `stage_compute.cpp`: przekaż `has_stage_time = true`, `stage_time_s = evaluation_time_s`, `step_dt_s = gpu.rk.active_step_dt_s`. W `stage_compute.cpp`: jeśli `request.purpose` NIE jest `IntermediateRkStage` ani `EndpointRkStage` (albo `reset_initial_solution`/`fresh_initial_guess_required`) $\implies$ wywołaj `gpu_demag_predictor_invalidate(...)`; w przeciwnym razie, gdy `workspace->direct_solver == nullptr && !fresh_zero && gpu_rk_rhs_allows_fsal_k0_reuse(ctx)`, wywołaj `gpu_demag_predictor_apply_warm_start(...)` przed rozwiązaniem HYPRE i zaktualizuj `last_solved_stage_time_s = request.stage_time_s` po rozwiązaniu. Pod `direct_solver != nullptr` kompletny no-op.
  - W `rk_final_refresh.cu`: dopiero **PO** `RkStepFailurePoint::DuringFinalFieldRefresh` (`:142-148`) i przed zwrotem sukcesu, gdy `ctx.poisson_demag.gpu_demag_mode == FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON && gpu_demag_poisson_linear_solver(ctx) == FULLMAG_FEM_GPU_DEMAG_LINEAR_SOLVER_HYPRE_KRYLOV && gpu_rk_rhs_allows_fsal_k0_reuse(ctx)`, wywołaj `gpu_demag_predictor_commit_accepted_potential(...)`.
  - W `rk_step_transaction.cpp:457,654`: snapshotuj i przywracaj metadane `predictor` (`history_count`, `t_curr`, `t_prev`, `operator_signature`, `last_solved_stage_time_s`).
- [ ] **Krok 3 (Docs):** Utwórz `docs/physics/0998-fem-gpu-rk-fsal-and-potential-predictor.{md,source-map.json}`.
- [ ] **Krok 4 (Commit):** `git commit -m "fem(gpu): add 2-step linear potential predictor with equal-stage guard and docs 0998"`

---

## Faza 2: Integracja, `CMakeLists.txt`, Weryfikator i Benchmarki A/B

> **Właściciel:** Integrator / Verifier po scaleniu 3 gałęzi autorów z Fazy 1.

### Zadanie 8: Rejestracja w `CMakeLists.txt`, synchronizacja testów krzyżowych, walidacja i suita A/B

**Files:**
- Modify: `backends/fem/CMakeLists.txt`
- Modify: `crates/fullmag-runner/src/native_fem.rs` *(wyłącznie 4-liniowa synchronizacja zduplikowanego testu `native_fem_explicit_rk_reports_real_rhs_cost_when_mfem_stack_is_available` w `:10387` z `parity.rs:210` na GPU vs CPU!)*

**Interfaces:**
- Consumes: Wszystkie scalone artefakty z Zadań 1–7.
- Produces: Zweryfikowany build C++/CUDA + Rust + Python, zielone bramki `scientific-documentation-contract` + `check_repo_consistency.py`, oraz raport A/B.

- [ ] **Krok 1 (CMake & cross-track sync):**
  - Zarejestruj `gpu/cuda/demag_poisson/hypre_residual_certification.cpp`, `gpu/cuda/demag_poisson/demag_predictor.cu` oraz cel CTest `cuda_rk_heun_rk4_fsal_predictor_contract` w `backends/fem/CMakeLists.txt`.
  - Zsynchronizuj oczekiwania kroku 2 w `crates/fullmag-runner/src/native_fem.rs:10387` z `parity.rs:210` (`native_fem_plan_requests_gpu_mfem_device(&plan)`).
- [ ] **Krok 2 (Walidacja dokumentacji naukowej i spójności repo — bramki obowiązkowe):**
  ```bash
  python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
    docs/physics/0913-fem-gpu-amg-coarse-residency.source-map.json --repo-root .
  python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
    docs/physics/fem_demag_fem_bem.source-map.json --repo-root .
  python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
    docs/physics/0997-fem-gpu-poisson-direct-cudss.source-map.json --repo-root .
  python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
    docs/physics/0998-fem-gpu-rk-fsal-and-potential-predictor.source-map.json --repo-root .
  python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py \
    --base origin/master --head HEAD --repo-root .
  python3 scripts/check_repo_consistency.py
  ```
- [ ] **Krok 3 (Pełna weryfikacja build + CTest + Cargo + Pytest w Docker DEV):**
  Uruchom/uzgodnij grupę Docker DEV przez `just docker-dev` (z zachowaniem wolumenów nazwanych z `AGENTS.md`), a następnie wewnątrz działającego kontenera backendowego tej grupy (`docker exec <dev-backend-container> bash -lc "..."`) wykonaj:
  ```bash
  cmake --build build/fem-cuda --parallel
  ctest --test-dir build/fem-cuda -R 'cudss_poisson_budget|demag_poisson_contract|demag_fem_bem_gpu|cuda_periodic_demag|gpu_strict_execution|gpu_pageable_scalar_readback|cuda_rk_guard|source_facade_gpu_rk|cuda_rk_heun_rk4_fsal_predictor|llg_time_domain_qualification' --output-on-failure
  FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1 ctest --test-dir build/fem-cuda -R 'gpu_pageable_scalar_readback|cuda_periodic_demag' --output-on-failure
  cargo test -p fullmag-ir -p fullmag-plan -p fullmag-runner
  pytest packages/fullmag-py/tests
  ```
- [ ] **Krok 4 (Suita benchmarków A/B na RTX 4080 SUPER w Docker DEV):**
  Wykonaj wszystkie 4 scenariusze ze Sekcji 7 specyfikacji (baseline `origin/master` vs candidate przez `just fullmag-dev-container <benchmark-script>` lub wewnątrz kontenera grupy `just docker-dev`):
  1. **Poisson open-airbox (SP4 ~8k i średnia ~49k):** baseline AMG vs candidate `cg_amg` (cert + FSAL + predyktor) vs candidate `auto` (`cudss_direct` + cert + FSAL).
  2. **Wymuszony ciasny limit VRAM (`FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB=32`):** dowód czystego fallbacku `auto → hypre_krylov` (`fallback_reason = "cudss_factor_exceeds_vram_budget"`) z przyspieszeniem predyktora $\phi^{(0)}$ vs twardego błędu pod `gpu_strategy = "cudss"`.
  3. **GPU FEM/BEM (geometria otwarta):** baseline `"JACOBI"` vs candidate `cg_amg` (`"AMG"`, `relax_type=18`, interop) vs candidate `auto` (`cudss_direct` na `u1`/`u2`).
  4. **PBC-reduced Poisson (1D Robin + 2D film z singleton pinem):** baseline AMG vs candidate `auto` (`cudss_direct` + FSAL `k0` na PBC).
- [ ] **Krok 5 (Commit integracyjny i raport końcowy):**
  Zapisz tabelę A/B (czasy, iteracje, ewaluacje RHS, bariery sync, błędy parzystości $L_\infty$ i proweniencje) w raporcie weryfikatora i zamknij commit integracyjny:
  `git commit -m "fem(gpu): integrate P0 CMake targets, cross-track RK cost test, and verified A/B gates"`
