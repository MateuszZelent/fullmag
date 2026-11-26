# Pakiet FEM Core GPU (P0 #1 + #2 + #3) — Specyfikacja Architektoniczna

**Data:** 2026-11-26
**Autor:** `fem-p0-architect`
**Status:** Zrewidowany po builder-check (`#80`, `#82`), gotowy do implementacji w roju (3 równoległych autorów + 1 weryfikator)
**Powiązany plan implementacji:** [2026-11-26-fem-core-gpu-p0-plan.md](../plans/2026-11-26-fem-core-gpu-p0-plan.md)

---

## 1. Cel i zakres pakietu

Pakiet **FEM Core GPU P0** zamyka trzy najważniejsze wąskie gardła czasowe i architektoniczne natywnego solvera FEM CUDA (MFEM + HYPRE + cuDSS) w jednym spójnym kontrakcie produkcyjnym, bez kompromisów na ścisłości numerycznej (FP64, niezależna certyfikacja rezyduum $L_2$) oraz na kontrakcie proweniencji z `AGENTS.md` (`requested_intent` $\neq$ `resolved_execution`, zero cichego fallbacku przy jawnym żądaniu):

1. **Track A (P0 #2 — Certyfikacja rezyduum i oczyszczenie GPU FEM/BEM):**
   - Zastąpienie 2× jednoblockowego `demag_validation_norm_kernel<<<1, 256>>>` oraz 2× blokującego `cudaStreamSynchronize` wieloblokową redukcją pary norm (`ScaledNormPair` na 256 blokach) liczącą równocześnie $\|b\|_2$ i $\|r\|_2$ na strumieniu i pobierającą pojedynczy 16-bajtowy bufor pinned (1× `cudaStreamSynchronize`).
   - Przeniesienie poprawki rezydencji poziomu zgrubnego AMG z `0913` (`HYPRE_BoomerAMGSetCycleRelaxType(amgraw, 18, 3)`), synchronizacji strumieniowej `HypreStreamInterop`, marginesu certyfikacyjnego `0.1 * rtol` (`certification_solver_tolerance`) oraz wspólnej wieloblokowej certyfikacji rezyduum do GPU FEM/BEM (`fem_bem.cpp`), wraz z usunięciem tymczasowego obejścia domyślnego `"JACOBI"` w `native_fem/plan.rs` oraz usunięciem nadmiarowego ustawiania bitu `FEM_GPU_OPERATOR_PRECONDITIONER` w `fem_bem.cpp:1059`.

2. **Track B (P0 #1 — Produkcyjny `auto`-`cuDSS` ze strażnikiem VRAM + fallback do AMG + rozszerzenie na FEM/BEM i PBC-reduced):**
   - Wprowadzenie trójstanowej polityki wyboru solvera liniowego FEM GPU (`gpu_strategy ∈ {"auto", "cg_amg", "cudss"}`, domyślnie `"auto"`), przekazywanej **w chwili tworzenia backendu** przez addytywne `fullmag_fem_plan_desc_v5` + `fullmag_fem_backend_create_v6` (ponieważ `gpu_demag_poisson_initialize` uruchamia się wewnątrz `create`, zanim uchwyt trafi do wywołującego!):
     - `cg_amg`: deterministyczny HYPRE CG/GMRES + AMG/JACOBI (nigdy nie inicjalizuje `cuDSS`),
     - `cudss`: twarde wymuszenie `cuDSS` (twardy błąd przy braku `cuDSS`, przekroczeniu budżetu VRAM lub błędzie faktoryzacji; zero fallbacku),
     - `auto`: próba faktoryzacji `cuDSS` z preflightem VRAM (`CUDSS_DATA_MEMORY_ESTIMATES`), a przy przekroczeniu budżetu lub braku `cuDSS` czyste zwolnienie zasobów analizy i jawny fallback do HYPRE Krylov z zapisanym `requested_linear_solver_strategy = "auto"`, `resolved_linear_solver = "hypre_krylov"` oraz `linear_solver_fallback_reason` w artefaktach i proweniencji (zarówno dla `FemPoissonDemagProvenance`, jak i `FemBemDemagProvenance`).
   - Rozszerzenie strzeżonego `cuDSS` (faktoryzacja Cholesky'ego `CUDSS_MTYPE_SPD`) na:
     - **GPU FEM/BEM (`u1` Neumann i `u2` Dirichlet)** — atomowa para dwóch czynników z łącznym preflightem szczytowego VRAM,
     - **GPU PBC-reduced Poisson** (`periodic_matrix = P^T A P`) — usunięcie blokady `demag_periodic_poisson_reduction_requested(ctx)` w `hypre_device_solver.cpp:218-222` z dowodem SPD i twardym zamknięciem przypadku osobliwego (3D czysty Neumann bez pina).

3. **Track C (P0 #3 — FSAL `k0` dla Heun/RK4 + liniowy predyktor $\phi^{(0)}$ + ocena CUDA Graph):**
   - Włączenie ponownego użycia pochodnej FSAL `k[0]` z końcowego odświeżenia `rk_final_refresh.cu` dla metod **Heun** (`3 → 2` ewaluacje RHS/demag na krok, **−33%**) i **RK4** (`5 → 4`, **−20%**) przy pełnym audycie unieważnień (w tym napędów impulsowych/host-expression, kroków odrzuconych, transakcji, zamrożonych spinów z poprawką `rk_stage_schedule.cu:138,191` oraz PBC).
   - Wdrożenie 2-krokowego liniowego predyktora potencjału początkowego $\phi^{(0)}(t_{\text{eval}}) = \phi_n + \alpha (\phi_n - \phi_{n-1})$ dla warm-startu HYPRE CG/AMG (wyłącznie gdy `stage_time_s > last_solved_stage_time_s`, aby etapy o równym czasie jak końcowe odświeżenie RK4 lub etap 2 RK4 nie nadpisywały wyższorzędowego potencjału $O(\Delta t^3)$ ekstrapolacją liniową $O(\Delta t^2)$; wyłączanego również na pierwszych 2 krokach, po odrzuceniu/resecie, dla `dt_ratio > 2.0`, przy skokach napędów i dla nie-RK konsumentów; kompletny no-op o zerowym koszcie pamięci i czasu pod `cuDSS`).
   - Uczciwa, oparta na faktach z kodu (`modal_cudss_device_graph.cpp`) decyzja architektoniczna w sprawie **CUDA Graph** dla etapów RK+`cuDSS`: **jawne wyłączenie z tego PR (non-goal P1)** wraz ze szczegółowym uzasadnieniem technicznym 4 blokerów.

---

## 2. Szczegółowy projekt Track A (P0 #2)

### 2.1. Wieloblokowa redukcja pary norm `ScaledNormPair` (bez overflow/underflow FP64)

#### Krytyczny wymóg numeryczny i przypadki brzegowe
Test kontraktowy `backends/fem/tests/cuda_demag_residual_fixture.hpp:146-158` weryfikuje wektory przeskalowane przez `std::ldexp(1.0, ±665)`, których kwadraty ($2^{\pm 1330}$) przekraczają zakres wykładnika `double` ($\pm 1022$). Naiwna redukcja $\sum x_i^2$ uległaby przepełnieniu do `Inf` lub niedomiarowi do `0.0`.

Zachowujemy bezstratny monoid Blue/LAPACK `ScaledNorm { double scale; double sum_squares; }` z łącznym operatorem `MergeScaledNorm`, ale podnosimy go do **złączonej pary dwóch wektorów**:

```cpp
struct ScaledNorm {
    double scale = 0.0;
    double sum_squares = 0.0;
};

struct ScaledNormPair {
    ScaledNorm rhs{};
    ScaledNorm residual{};
};
```

**Krytyczne reguły poprawności pętli złączonej:**
- **Walidacja wejścia:** `rows <= 0` lub `rhs_values == nullptr` natychmiast zwraca `cudaErrorInvalidValue` (identycznie jak jednowektorowe API; zero UB dla pustego wektora).
- **Zakaz przedwczesnego `break;`:** Istniejący jednowektorowy kernel (`demag_kernels.cu:51-54`) robi `break;` na `!isfinite(magnitude)`. W złączonej pętli par **`break;` jest ZABRONIONY** — kanały `rhs` i `residual` aktualizują się **niezależnie**: jeśli `rhs[i]` jest `NaN`/`Inf`, zapisujemy stan niefinityczny wyłącznie do `local.rhs` (`scale = magnitude; sum_squares = 1.0;` lub analogicznie bez utraty `NaN`) i kontynuujemy przetwarzanie `residual[i]` (i odwrotnie), dzięki czemu `rhs` nie maskuje ani nie przerywa obliczenia `residual` i oba kanały zwracają dokładne wyniki.
- **Przypadek `b_norm == 0`:** gdy cały wektor ma same zera, `scale == 0.0`, `sum_squares == 0.0`, a `FinalizeScaledNorm` zwraca dokładnie `0.0` (bez dzielenia `0/0`).

#### Dwuprzebiegowy schemat bez alokacji w pętli gorącej (Fixed-256-Block Grid-Stride)
W `backends/fem/gpu/cuda/demag_poisson/demag_kernels.{hpp,cu}` definiujemy strukturę `GpuValidationNormScratch` (osadzaną w `GpuDemagPoissonWorkspace` oraz `GpuDemagFemBemWorkspace`):

- Stałe: `kDemagValidationNormMaxBlocks = 256`, `kDemagValidationNormBlockSize = 256` (do 65 536 wątków — pełne nasycenie 80 SM na RTX 4080 SUPER przy stałym rozmiarze bufora niezależnym od `rows`).
- Bufory alokowane raz przy inicjalizacji:
  - `void *d_partials` — `256 * sizeof(ScaledNormPair)` = **8 KiB** na urządzeniu,
  - `double *d_out_norms` — `2 * sizeof(double)` = **16 B** na urządzeniu (`[0] = ||b||_2`, `[1] = ||r||_2`),
  - `double *h_norms` — `2 * sizeof(double)` = **16 B** na hoście, alokowane przez `cudaHostAlloc(..., cudaHostAllocDefault)` z deterministycznym fallbackiem do pamięci stronicowalnej (identycznym jak w `reduction_workspace_memory.cpp:40-103`, respektującym `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1` wymaganym przez `gpu_pageable_scalar_readback_contract.cpp`!),
  - `bool host_pinned = false;`.
- **Cykl życia bufora (BEZ duplikacji dla FEM/BEM!):**
  - Dla Poisson GPU inicjalizujemy `workspace.validation_scratch` w **`poisson.cpp:104`** (obok `initialize_hypre_stream_interop`), a **NIE** w `upload_demag_poisson_operators` (ponieważ `fem_bem.hpp:70` osadza `GpuDemagPoissonWorkspace source_operators` i wywołuje `upload_demag_poisson_operators`, co zaalokowałoby nieużywany duplikat!).
  - Dla FEM/BEM inicjalizujemy wyłącznie `ws.validation_scratch` w `gpu_demag_fem_bem_initialize`.
  - Sprzątanie `fullmag_cuda_demag_validation_scratch_destroy(...)` jest idempotentne i wywoływane w `operators.cpp:1257` (`destroy_demag_poisson_operators`) oraz `gpu_demag_fem_bem_destroy`.
- **Przebieg 1 (`demag_validation_norm_pair_blocks_kernel<<<num_blocks, 256, 0, stream>>>`):**
  - `num_blocks = min(256, max(1, (rows + 255) / 256))`.
  - Pętla grid-stride `i = blockIdx.x * 256 + threadIdx.x; i < rows; i += num_blocks * 256`, bez `break;`, niezależnie aktualizująca `local.rhs` i (gdy `residual_values != nullptr`) `local.residual`.
  - `cub::BlockReduce<ScaledNormPair, 256>::Reduce(local, MergeScaledNormPairOp{})` zapisuje wynik bloku do `d_partials[blockIdx.x]`.
- **Przebieg 2 (`demag_validation_norm_pair_finalize_kernel<<<1, 256, 0, stream>>>`):**
  - Wątek `t < num_blocks` wczytuje `d_partials[t]`, pozostałe element neutralny; `cub::BlockReduce<ScaledNormPair, 256>::Reduce` wyznacza końcową parę i zapisuje `d_out_norms[0]` oraz (gdy `residual_values != nullptr`) `d_out_norms[1]`.
- **Jeden transfer i jedna synchronizacja (`fullmag_cuda_demag_validation_norm_pair`):**
  - `const size_t scalar_count = (residual_values != nullptr) ? 2u : 1u;`
  - `cudaMemcpyAsync(scratch.h_norms, scratch.d_out_norms, scalar_count * sizeof(double), cudaMemcpyDeviceToHost, stream)`
  - **1× `cudaStreamSynchronize(stream)`**
  - Zachowujemy również istniejącą jednoargumentową funkcję `fullmag_cuda_demag_validation_norm(...)` dla testu aliasowania `cuda_demag_residual_fixture.hpp:212`.

### 2.2. Wspólny moduł certyfikacji rezyduum `hypre_residual_certification.{hpp,cpp}`

Aby uniknąć duplikacji między `hypre_device_solver.cpp` (Poisson) a `fem_bem.cpp` (FEM/BEM) i utrzymać czysty rozdział plików, wydzielamy `backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.{hpp,cpp}` (deklarowany w Fazie 0, wraz z eksportem `certification_solver_tolerance(double requested_rtol)` — obecnie ukrytej w anonimowym namespace `hypre_device_solver.cpp:156-159`, a NIE w `hypre_validation_policy.hpp`):

```cpp
inline double certification_solver_tolerance(double requested_rtol) noexcept {
    return requested_rtol > 0.0 ? requested_rtol * 0.1 : requested_rtol;
}

struct GpuDemagResidualCertInput {
    const char *label = "GPU Poisson demag";
    mfem::HypreParMatrix *A_par = nullptr;
    mfem::HypreParVector *b_par = nullptr;
    mfem::HypreParVector *x_par = nullptr;
    mfem::HypreParVector *residual = nullptr;
    GpuValidationNormScratch *scratch = nullptr;
    bool compute_independent_residual = true;
    int rows = 0;
    cudaStream_t stream = nullptr;
};

struct GpuDemagResidualCertOutput {
    double rhs_norm = 0.0;
    double absolute_residual = 0.0;
    bool computed_independent_residual = false;
    uint32_t scalar_readback_count = 0;
    uint32_t control_fence_count = 0;
    uint64_t control_d2h_bytes = 0;
};

bool certify_gpu_hypre_demag_residual(
    const GpuDemagResidualCertInput &input,
    GpuDemagResidualCertOutput &output,
    std::string &error);
```

#### Ścisły kontrakt błędów HYPRE, kolejności walidacji i synchronizacji awaryjnej
1. **Zachowanie lepkich (sticky) błędów HYPRE (`hypre_device_solver.cpp:603-622` verbatim):**
   - **NIE** wolno wywoływać `HYPRE_ClearAllErrors()`, `HYPRE_ClearError(...)` ani polegać na `HYPRE_GetError()` po `Mult`/`Axpy`! Zamiast tego zachowujemy dokładnie wzorzec z `hypre_device_solver.cpp:603-622`:
     - przed `Mult`: `const HYPRE_Int prior_status = HYPRE_GetError();` — jeśli `(prior_status & ~HYPRE_ERROR_CONV) != 0`, zwróć błąd natychmiast (bez czyszczenia nienawiązanych błędów!).
     - matvec: `const HYPRE_Int matvec_status = input.A_par->Mult(*input.x_par, *input.residual);` — jeśli `matvec_status != 0`, wykonaj awaryjną synchronizację `reject_queued_work` (`cudaStreamSynchronize(input.stream)` z `:555-565`, aby uniknąć wyścigu z `stage_compute.cpp:369` zerującym `poisson_solution` na `fullmag_stream`!) i zwróć dokładny komunikat pasujący do `cuda_demag_residual_fixture.hpp:169-170`: `std::string(input.label) + " residual matvec failed: HYPRE status " + std::to_string(matvec_status)` (**0** readbacków, **0** barier kontrolnych!).
     - AXPY: `const HYPRE_Int axpy_status = HYPRE_ParVectorAxpy(-1.0, *input.b_par, *input.residual);` — jeśli `(axpy_status & ~(prior_status & HYPRE_ERROR_CONV)) != 0`, wykonaj `reject_queued_work` i zwróć dokładny komunikat: `std::string(input.label) + " residual AXPY failed: HYPRE status " + std::to_string(axpy_status)` (**0** readbacków, **0** barier kontrolnych!).
2. **Pojedynczy złączony readback:**
   - Wywołanie `fullmag_cuda_demag_validation_norm_pair(rhs_data, residual_or_null, rows, *input.scratch, output.rhs_norm, output.absolute_residual, input.stream)` (1× sync, 16 B lub 8 B).
   - Jeśli wywołanie zwróci błąd CUDA, wykonaj `reject_queued_work` i zwróć `false`.
   - Rejestracja u wywołującego: `record_device_control_scalar_to_host(ctx.transfer_audit.audit, output.control_d2h_bytes)` (1 sync, 16 B) oraz `GpuPerformanceCounterDelta { control_fences = 1, control_d2h_bytes = output.control_d2h_bytes }`.
3. **Ścisła kolejność sprawdzania skończoności (krytyczne dla `cuda_demag_residual_fixture.hpp:178-187`):**
   - **Najpierw** sprawdź `!std::isfinite(output.rhs_norm)` $\implies$ `reject_queued_work` i błąd `std::string(input.label) + " RHS norm is nonfinite"` (gdy `b=NaN`, `r` także staje się `NaN` — sprawdzając `rhs_norm` jako pierwsze zachowujemy dokładnie diagnostykę `"RHS norm is nonfinite"` w `:185-187`!).
   - Następnie zarejestruj `demag_rhs_norm_evaluations = 1`, `demag_rhs_norm_sum = output.rhs_norm`.
   - **Dopiero potem**, jeśli `compute_independent_residual && !std::isfinite(output.absolute_residual)` $\implies$ `reject_queued_work` i błąd `std::string(input.label) + " residual norm is nonfinite"` (wymagane w `:178-180`).
4. Następnie `validate_demag_linear_solve_result(...)` sprawdza `||r||_2 / ||b||_2 <= rtol` (zachowując `force_independent_validation = true` zarówno dla Krylov, jak i `cuDSS`).

**Wpływ na istniejące testy kontraktowe C++:**
- `backends/fem/tests/cuda_demag_residual_fixture.hpp`:
  - W `:29-69`: ustaw jawnie `ctx.poisson_demag.gpu_solver_strategy = GpuDemagSolverStrategy::CgAmg;` (inaczej domyślne `Auto` sfaktoryzuje małą macierz 8×8 przez `cuDSS`, zostawi `workspace.solver == nullptr` i spowoduje segfault w `:69`!) oraz zainicjalizuj i zniszcz `workspace.validation_scratch` (bo fixture omija `poisson.cpp`).
  - W `validate_candidate` (`:78-108`): przyjmij parę `(expected_fences, expected_bytes)`: `(1, 16)` w `:109, 143, 156, 180, 187` oraz **`(0, 0)`** w `:166` (błąd HYPRE matvec status 12 odpada przed złączonym readbackiem).
- `backends/fem/tests/cuda_periodic_demag_contract.cpp:215-232`: zaktualizować asercje źródłowe na wieloblokową redukcję par (`demag_validation_norm_pair_blocks_kernel`, `demag_validation_norm_pair_finalize_kernel`, `certify_gpu_hypre_demag_residual`).
- `backends/fem/tests/demag_poisson_contract.cpp:2981-3231`: testuje mały mieszany układ P1 pod HYPRE Krylov (`control_fences`, `fresh_zero_guess_count`, `warm_start_count`, `coarse_relax_type == 18`, `validation_workspace->solver != nullptr`). Musi ustawić `ctx.poisson_demag.gpu_solver_strategy = GpuDemagSolverStrategy::CgAmg;` w `:2981` i zaktualizować `:3030` z `control_fences == 4u` na `control_fences == 2u` (zachowując `control_bytes == 4u * sizeof(double)` = 32 B dla 2 rozwiązań!).

### 2.3. Oczyszczenie GPU FEM/BEM (`fem_bem.hpp`, `fem_bem.cpp`, `native_fem/plan.rs`)

W obecnym `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp` zamykamy pięć regresji względem ścieżki Poisson GPU:

1. **Poprawka `0913` w `configure_amg` (`hypre_device_solver.cpp:50-122`, ustawienie `:105`, weryfikacja `:79-93`):**
   - Dodać `HYPRE_BoomerAMGSetCycleRelaxType(amgraw, 18, 3)` oraz weryfikację przez `HYPRE_BoomerAMGGetCycleRelaxType(amgraw, &configured_coarse_relax_type, 3) == 18`.
   - Dodać eksportowany getter `bool gpu_demag_fem_bem_amg_coarse_relax_type(const Context &ctx, int32_t &relax_type, std::string &error)` (zwraca `18` dla FEM/BEM AMG, `-1` dla FEM/BEM `cuDSS` lub precond `!= AMG`), delegowany z `read_device_demag_amg_coarse_relax_type` gdy `gpu_demag_mode == FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_FEM_BEM`.
2. **Usunięcie 2× blokującego `cudaStreamSynchronize` + 2× `Norml2()` na układ (`u1` i `u2`):**
   - Osadzić `HypreStreamInterop stream_interop{}` oraz `GpuValidationNormScratch validation_scratch{}` w `GpuDemagFemBemWorkspace`.
   - Przed rozwiązaniem: `hypre_wait_for_fullmag(stream, hypre_stream, ...)` zamiast `cudaStreamSynchronize(stream)`.
   - Rozwiązanie liniowe (`solver->Mult` albo **`solve_demag_cudss_direct` przypięte dokładnie do `ws.stream_interop.hypre_stream`**, identycznie jak w `stage_compute.cpp:308-317`, aby `A_par->Mult` w certyfikacji na `hypre_stream` było w jednym strumieniu bez dodatkowego zdarzenia!).
   - Certyfikacja rezyduum przez wspólny `certify_gpu_hypre_demag_residual(...)` na `hypre_stream` (1× sync, 16 B pinned, z zapisem `transfer_audit` i `performance_counters`) zamiast hostowych `Norml2()` i domyślnego strumienia `Add(-1.0, ...)`.
   - Po rozwiązaniu: `fullmag_wait_for_hypre(stream, hypre_stream, ...)` zamiast drugiego `cudaStreamSynchronize(stream)`.
3. **Margines tolerancji `0.1 * rtol`:**
   - W `initialize_linear_system` oraz `configure_solver_initial_iterate` przekazywać `certification_solver_tolerance(requested_rtol)` (z `hypre_residual_certification.hpp`), zachowując próg certyfikacji `requested_rtol`.
4. **Naprawa bitów recepty wykonania GPU (`execution_receipt.hpp:26-42`, `fem_bem.cpp:445-450, 1056-1059`):**
   - W `fem_bem.cpp:1056-1059` pozostają wyłącznie bity operatorów demag: `FEM_GPU_OPERATOR_DEMAG_RHS | FEM_GPU_OPERATOR_DEMAG_SOLVE | FEM_GPU_OPERATOR_DEMAG_RECOVERY` — **usuwamy** bezwarunkowe `FEM_GPU_OPERATOR_PRECONDITIONER` z `:1059`!
   - W `solve_linear_system` (`fem_bem.cpp:445-450`) emitujemy bit liniowy zależny od wybranej realizacji: `system.direct_solver != nullptr ? FEM_GPU_OPERATOR_DIRECT_SOLVE : FEM_GPU_OPERATOR_PRECONDITIONER`. Zapobiega to konfliktowi w `execution_receipt.cpp:76-81`.
5. **Przywrócenie domyślnego `"AMG"` dla GPU FEM/BEM (`crates/fullmag-runner/src/native_fem/plan.rs:81-89`):**
   - Usunąć warunek wymuszający `"JACOBI"` dla nie-Poissonowego demagu na GPU i zaktualizować `fem_demag_solver_policy_preserves_gpu_fem_bem` w `crates/fullmag-runner/src/dispatch.rs:5171-5200` na `"AMG"`.

---

## 3. Szczegółowy projekt Track B (P0 #1)

### 3.1. Dowód matematyczny SPD #1 — GPU FEM/BEM (`u1` Neumann i `u2` Dirichlet)

Na podstawie inspekcji `backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.cpp:289-356` i `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.cu:113-115`:

- **Siatka bez airboxu (body-only `TET4` P1):** oba układy żyją wyłącznie na węzłach ciała magnetycznego $\Omega_m$ (`order = 1`, `DiffusionIntegrator`), przez co liczba niewiadomych $N_{\text{FK}}$ jest typowo $10\times$–$30\times$ mniejsza niż dla P2 Poisson z airboxem.
- **Macierz $K_{\text{neumann}}$ dla $u_1$:**
  - Bazowa macierz sztywności $K_{ij} = \int_{\Omega_m} \nabla \varphi_i \cdot \nabla \varphi_j\, dV$ spełnia $K = K^T \succeq 0$, a jej jądro ma wymiar równy liczbie spójnych składowych $C$ ciała magnetycznego.
  - `collect_neumann_gauge_nodes` używa Union-Find (`DisjointSet`) po aktywnych elementach `TET4` i wyznacza minimalny globalny węzeł `tdof_c` w **każdej** spójnej składowej $c \in \{1, \dots, C\}$, po czym wywołuje symetryczne `neumann_op->EliminateRowCol(tdof_c)` (MFEM `DIAG_ONE`: zera poza przekątną, `1.0` na przekątnej).
  - Równanie $v^T K_{\text{neumann}} v = 0$ wymusza $v_{\text{tdof}_c} = 0$ dla każdego $c$ oraz $\nabla v_h = 0$ na każdej spójnej składowej $\implies v \equiv 0$.
  - **Wniosek:** $K_{\text{neumann}}$ jest **ściśle SPD** $\implies$ `CUDSS_MTYPE_SPD` Cholesky jest matematycznie ścisłe.
- **Macierz $K_{\text{dirichlet}}$ dla $u_2$:**
  - `dirichlet_op->EliminateRowCol(tdof)` wykonywane jest dla wszystkich unikalnych węzłów brzegowych $\Gamma = \partial \Omega_m$ (`boundary_tdofs`), dając $\mathrm{diag}(K_{\text{int,int}}, I_\Gamma) \succ 0$, a `fem_bem_kernels.cu:113-115` nadpisuje wiersze brzegowe RHS wartościami `boundary_values[row]` (zgodnymi z przekątną `1.0`).
  - **Wniosek:** $K_{\text{dirichlet}}$ jest **ściśle SPD** $\implies$ `CUDSS_MTYPE_SPD` Cholesky jest matematycznie ścisłe.

#### Atomowy łączny preflight VRAM dla pary `(u1, u2)` (API niezależne od `Context`!)
`execution_receipt.cpp:76-81` zabrania mieszania `PRECONDITIONER` i `DIRECT_SOLVE`, więc **`u1` i `u2` muszą zawsze używać tej samej rodziny solvera**. Funkcja `try_initialize_fem_bem_cudss_pair` pozostaje **niezależna od `Context`** (tak jak reszta `cudss_direct_solver.hpp`, co pozwala testować ją samodzielnie w `cudss_poisson_budget_contract.cpp`!):

```cpp
bool try_initialize_fem_bem_cudss_pair(
    GpuDemagSolverStrategy requested_strategy,
    const mfem::SparseMatrix &u1_matrix,
    const mfem::SparseMatrix &u2_matrix,
    std::shared_ptr<GpuDemagCudssDirectSolver> &u1_solver,
    std::shared_ptr<GpuDemagCudssDirectSolver> &u2_solver,
    GpuDemagCudssDirectStats &u1_stats,
    GpuDemagCudssDirectStats &u2_stats,
    GpuDemagCudssResolution &resolution,
    std::string &error);
```

1. Uruchamia analizę `CUDSS_PHASE_ANALYSIS` dla `u1` i `u2`, odczytując $(\hat{M}_{\text{peak},1}, \hat{M}_{\text{stable},1})$ oraz $(\hat{M}_{\text{peak},2}, \hat{M}_{\text{stable},2})$.
2. Wyznacza budżet $B = \min\bigl(F_{\text{free}} - \max(512\,\text{MiB},\, M_{\text{total}}/20),\, B_{\text{cap}}\bigr)$ i sprawdza warunek łącznego szczytu sekwencyjnego:
   $$\hat{M}_{\text{peak,FK}} = \max\!\bigl(\hat{M}_{\text{peak},1},\; \hat{M}_{\text{stable},1} + \hat{M}_{\text{peak},2}\bigr) \le B.$$
3. Przy przekroczeniu budżetu: niszczy **oba** uchwyty analityczne bez startu faktoryzacji (`factorization_started = false` w obu `stats`): pod `cudss` twardy błąd, pod `auto` zwrot `true` z `u1_solver = u2_solver = nullptr` i `resolution.fallback_reason = CudssFactorExceedsVramBudget`.
4. Przy sukcesie faktoryzacji obu układów zwraca wypełnione `u1_stats` i `u2_stats` (w tym `device_bytes`), na podstawie których `fem_bem.cpp` aktualizuje `workspace->device_bytes` oraz `rows`, `solver_setup_count`, `solver_setup_complete` dla `u1_system` i `u2_system`.
5. Jeśli `u2` zawiedzie nieoczekiwanie (`CUDSS_DATA_INFO != 0` lub błąd CUDA) po sfaktoryzowaniu `u1`: natychmiast niszczy `u1_solver` i zwraca `false` (nigdy stan częściowy!).

---

### 3.2. Dowód matematyczny SPD #2 — GPU PBC-Reduced Poisson (`A_red = P^T A_full P`)

Na podstawie `demag_poisson_boundary.cpp:124-242`, `demag_poisson_periodic.cpp:89-184`, `operators.cpp:1175-1187` i `hypre_device_solver.cpp:218-222`:

Macierz prolongacji klas równoważności $P \in \{0,1\}^{N_{\text{full}} \times N_{\text{red}}}$ ma pełny rząd kolumnowy ($\operatorname{rank}(P) = N_{\text{red}}$). Z kongruencji $A_{\text{red}} = P^T A_{\text{full}} P$: jeśli $A_{\text{full}} \succ 0$ i $A_{\text{full}} = A_{\text{full}}^T$, to $y^T A_{\text{red}} y = (Py)^T A_{\text{full}} (Py) > 0\ \forall y \ne 0$, więc **$A_{\text{red}}$ jest ściśle SPD**.

1. **1D-periodic + Robin:** $\beta = c / R^* > 0$ na $\Gamma_{\text{open}} \neq \emptyset \implies A_{\text{full}} = K + \beta M_{\Gamma_{\text{open}}} \succ 0 \implies A_{\text{red}} \succ 0$.
2. **2D-periodic film (Robin $\to$ czysty Neumann + gauge pin):** `demag_poisson_boundary.cpp:151-200` ustawia $\beta = 0$, znajduje singletonową klasę `pin` na otwartym brzegu P1 (`class_size[r_pin] == 1`) i woła `A_robin->EliminateRowCol(pin)`. W $A_{\text{red}}$ wiersz/kolumna `r_pin` zachowuje przekątną `1.0` i zera poza nią, usuwając stałe jądro $\implies A_{\text{red}} \succ 0$.
3. **1D/2D-periodic + Dirichlet:** `EliminateRowCol` na węzłach zewnętrznego brzegu wymusza $A_{\text{full}} \succ 0$. Na szwie okresowym przekątna w $A_{\text{red}}$ sumuje się do `class_size[r] >= 1` przy zerach poza przekątną, a `d_ess_tdofs` w `operators.cpp:1175-1187` zeruje odpowiednie zredukowane wiersze RHS $\implies A_{\text{red}} \succ 0$.
4. **3D-periodic czysty Neumann (brak otwartych ścian i brak pina):** Macierz osobliwa (1D jądro stałe). `cuDSS` zwraca `CUDSS_DATA_INFO != 0` i **zawsze kończy się twardym błędem — również pod `auto`** (błąd matematyczny operatora PDE, NIE limit VRAM!).

**Zmiana w `hypre_device_solver.cpp:218-222`:** Usunąć twarde odrzucenie `if (demag_periodic_poisson_reduction_requested(ctx))`. Operator `A_bc` już wskazuje na `periodic_matrix`, a wszystkie bufory urządzenia pracują w przestrzeni zredukowanej.

---

### 3.3. Polityka `auto` / `cg_amg` / `cudss`, budżet VRAM, C ABI (`create_v6`) i proweniencja

#### Ortogonalne pole `FemLinearSolverPolicy.gpu_strategy`
Pola `solver` (`"CG"|"GMRES"`) i `preconditioner` (`"AMG"|"JACOBI"|"NONE"`) pozostają parametrami solvera Krylowa (dla FEM CPU i dla fallbacku `auto → hypre_krylov`). Dodajemy osobne pole **`gpu_strategy`** (`"auto" | "cg_amg" | "cudss"`, domyślnie `"auto"`):
- **Python DSL** (`discretization.py`, `world.py`, `script_builder.py:4929,5000,5027`): `FemLinearSolverPolicy.gpu_strategy = "auto"`, walidacja wartości, serializacja `"gpu_strategy"` w `to_ir()` (wraz z aktualizacją dokładnego porównania słownika w `packages/fullmag-py/tests/test_api.py:2617-2625` oraz wszystkich 3 helperów w `script_builder.py`!).
- **Rust IR i Plan** (`crates/fullmag-ir/src/study.rs:1005`, `crates/fullmag-plan/src/fem.rs`): `#[serde(default = "default_fem_gpu_strategy")] pub gpu_strategy: String` (wsteczna kompatybilność ze starszym JSON IR) oraz aktualizacja literałów struktury w `crates/fullmag-runner/src/frequency_response.rs:5418,5726`.

#### Precedencja zmiennych środowiskowych
1. **`FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER`:** pusta/brak $\implies$ użyj `requested_strategy` z `fullmag_fem_plan_desc_v5` (domyślnie `AUTO`); `"cudss"` $\implies$ `CUDSS`; `"cg_amg"` / `"hypre"` / `"off"` $\implies$ `CG_AMG`; `"auto"` $\implies$ `AUTO`; każda inna wartość $\implies$ **twardy błąd**.
2. **Limit VRAM:** istniejące `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES` (bajty) oraz nowe `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB` (MiB $\to \text{MiB} \times 2^{20}$ z kontrolą przepełnienia `uint64_t`). Gdy obie ustawione: walidacja obu (błędna wartość = twardy błąd nawet pod `auto`!) i `cap_bytes = min(bytes_cap, mib_cap_bytes)`.

#### Tabela rozstrzygania 3-stanowej strategii

| Zdarzenie podczas inicjalizacji `cuDSS` | `gpu_strategy = cg_amg` | `gpu_strategy = cudss` | `gpu_strategy = auto` |
|---|---|---|---|
| `cuDSS` dostępny, $\hat{M}_{\text{peak}} \le B$, faktoryzacja OK | *(pominięte)* $\to$ `hypre_krylov` | `cudss_direct`, `fallback = None` | `cudss_direct`, `fallback = None` |
| Binarka zbudowana bez `FULLMAG_FEM_CUDSS_POISSON_ENABLED` | `hypre_krylov` | **Twardy błąd** | Fallback $\to$ `hypre_krylov`, `reason = "cudss_unavailable"` |
| `CUDSS_DATA_MEMORY_ESTIMATES` niedostępny / $\le 0$ | `hypre_krylov` | **Twardy błąd** | Zwolnij analizę, fallback $\to$ `hypre_krylov`, `reason = "cudss_memory_estimate_unavailable"` |
| $\hat{M}_{\text{peak}} > B$ (lub $\hat{M}_{\text{peak,FK}} > B$) | `hypre_krylov` | **Twardy błąd** (bez startu faktoryzacji) | Zwolnij analizę, fallback $\to$ `hypre_krylov`, `reason = "cudss_factor_exceeds_vram_budget"` |
| Błędny format `*_BUDGET_BYTES` / `*_MAX_VRAM_MIB` / `*_DIRECT_SOLVER` | **Twardy błąd** (jeśli zła wartość) | **Twardy błąd** | **Twardy błąd** (błąd konfiguracji, NIE fallback!) |
| `CUDSS_DATA_INFO != 0` (macierz osobliwa / nie-SPD, np. 3D PBC bez pina) | *(nie dotyczy)* | **Twardy błąd** | **Twardy błąd** (błąd matematyczny, NIE fallback!) |

#### Addytywne C ABI — przekazanie strategii PRZY TWORZENIU (`create_v6`)!
**Krytyczny detal cyklu życia (`api.cpp:5780-5817` $\to$ `fem_context_builder.cpp:184` $\to$ `gpu_state_runtime.cpp:228`):** `fullmag_fem_backend_create_v5` wywołuje `gpu_demag_poisson_initialize(ctx, error)` **wewnątrz `create`**, zanim uchwyt wróci do `NativeFemBackend::create` (`native_fem.rs:4369`). Setter wołany dopiero po `create` byłby za późno (`cg_amg` i tak sfaktoryzowałby `cuDSS`, a wymuszony `cudss` ponad budżetem spadłby pod `Auto`!).

Dlatego strategię przekazujemy **przy tworzeniu backendu** wzorcem wersjonowania `v2 → v3 → v4 → v5 → v6` bez naruszania rozmiaru `fullmag_fem_solver_config`:
- W `native/include/fullmag_fem.h` i `crates/fullmag-fem-sys/src/lib.rs`:
  - `enum fullmag_fem_gpu_demag_solver_strategy_v1`: `AUTO = 0`, `CG_AMG = 1`, `CUDSS = 2`.
  - `enum fullmag_fem_gpu_demag_fallback_reason_v1`: `NONE = 0`, `CUDSS_UNAVAILABLE = 1`, `CUDSS_FACTOR_EXCEEDS_VRAM_BUDGET = 2`, `CUDSS_MEMORY_ESTIMATE_UNAVAILABLE = 3`.
  - `#define FULLMAG_FEM_PLAN_DESC_V5_ABI_VERSION 5u` oraz addytywna struktura opakowująca:
    ```c
    typedef struct fullmag_fem_plan_desc_v5 {
        uint32_t abi_version;               // FULLMAG_FEM_PLAN_DESC_V5_ABI_VERSION
        uint32_t struct_size;               // sizeof(fullmag_fem_plan_desc_v5)
        uint32_t gpu_demag_solver_strategy; // fullmag_fem_gpu_demag_solver_strategy_v1
        uint32_t reserved;                  // must be 0
        fullmag_fem_plan_desc_v4 base;
    } fullmag_fem_plan_desc_v5;

    FULLMAG_FEM_API fullmag_fem_backend *fullmag_fem_backend_create_v6(
        const fullmag_fem_plan_desc_v5 *plan,
        const fullmag_fem_adaptive_config_v2 *adaptive_config);
    ```
    (`fullmag_fem_backend_create_v5` pozostaje w 100% kompatybilne i przekazuje `AUTO`; `create_versioned_plan_backend` ustawia `handle->context.poisson_demag.gpu_solver_strategy` **przed** wywołaniem `initialize_backend_runtime`!).
  - Addytywne zapytanie proweniencji:
    ```c
    typedef struct fullmag_fem_gpu_demag_linear_solver_provenance_v1 {
        uint32_t requested_strategy;
        uint32_t resolved_linear_solver;
        uint32_t fallback_reason;
        uint32_t reserved;
        uint64_t estimated_device_peak_bytes;
        uint64_t device_budget_bytes;
        uint64_t factor_nnz;
        uint64_t factor_device_bytes;
    } fullmag_fem_gpu_demag_linear_solver_provenance_v1;

    FULLMAG_FEM_API int fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1(
        const fullmag_fem_backend *handle,
        fullmag_fem_gpu_demag_linear_solver_provenance_v1 *out_provenance);
    ```
  - Rozszerzenie `gpu_demag_poisson_linear_solver(ctx)` w `poisson.cpp` o delegację do `gpu_demag_fem_bem_linear_solver(ctx)` dla `DEVICE_HYPRE_FEM_BEM`, dzięki czemu `rk_plan.cpp::gpu_rk_required_operator_mask`, `pgbb.cpp`, `nonlinear_cg.cpp`, `api.cpp` i `fullmag_fem_backend_get_gpu_demag_linear_solver_v1` automatycznie obsługują `cuDSS` także dla FEM/BEM.

#### Proweniencja Rust (wszystkie punkty publikacji!)
Uwaga z inspekcji `dispatch.rs:3924` i `fem/runtime_contract.rs:288`: `fem_poisson_demag` jest dziś wypełniane zarówno dla Poisson, jak i dla FEM/BEM (jako ogólny blok polityki solvera liniowego), a dla FEM/BEM dodatkowo publikowane jest `fem_bem_demag` (`FemBemDemagProvenance`, `types.rs:4378`, bez `#[derive(Default)]`).
Dodajemy identyczne trzy pola `#[serde(default, skip_serializing_if = "Option::is_none")]`:
- `requested_linear_solver_strategy: Option<String>` (`"auto" | "cg_amg" | "cudss"`)
- `resolved_linear_solver: Option<String>` (`"cudss_direct" | "hypre_krylov"`)
- `linear_solver_fallback_reason: Option<String>` (`"cudss_unavailable" | "cudss_factor_exceeds_vram_budget" | "cudss_memory_estimate_unavailable"`)

do **obu** struktur `FemPoissonDemagProvenance` i `FemBemDemagProvenance`, aktualizując wszystkie literały i miejsca publikacji:
- `FemBemDemagProvenance`: `native_fem/runtime_info.rs:350` oraz `artifacts.rs:7286`,
- `FemPoissonDemagProvenance`: `dispatch.rs:3932` oraz `fem/runtime_contract.rs:296`,
- Podpięcie wywołania `apply_native_fem_gpu_demag_linear_solver_provenance` w **`fem/execution.rs:376-393`** (obecnie brakowało tam aktualizacji z backendu!), w `dispatch.rs`, oraz w `fem/relax/finalize.rs:399-407`,
- `artifacts.rs:1271`: publikacja `requested_linear_solver_strategy`, `resolved_linear_solver`, `linear_solver_fallback_reason` w `gpu_demag_runtime_metadata` (czytając z `fem_poisson_demag` lub `fem_bem_demag`).

---

## 4. Szczegółowy projekt Track C (P0 #3)

### 4.1. FSAL `k0` dla Heun i RK4 + wyczerpujący audyt 10 warunków unieważnienia

W `backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu:117-165` na końcu każdego zaakceptowanego kroku Heun i RK4 Fullmag i tak oblicza pełne końcowe RHS $f(m_{n+1}, t_{n+1})$ do bufora `gpu.rk.error`. Dotychczas `rk_step_preflight.cu:124` ograniczało `fsal_method` do `rk23 || rk45`, wyrzucając gotowy wynik `gpu.rk.error`. Włączenie ponownego użycia `gpu.rk.error -> gpu.rk.k[0]` daje **Heun `3 → 2` (−33,3%)** i **RK4 `5 → 4` (−20,0%)** z zerową aproksymacją.

#### Ścisłe rozdzielenie dwóch mechanizmów FSAL (krytyczna poprawka `rk_stage_schedule.cu:138,191`!)
1. **`endpoint_rhs_ready` (`gpu_rk_allows_endpoint_rhs_shortcut(ctx)` — wyłącznie RK23/RK45):**
   - Pomija wywołanie RHS w `rk_final_refresh.cu`, używając ostatniego etapu tableau (`k[3]` BS23 / `k[6]` DP54).
   - Wymaga: `gpu_rk_rhs_allows_fsal_k0_reuse(ctx) && !ctx.frozen_spins.enabled() && !gpu.mesh_regions.has_periodic_reduced_nodes`.
   - **MUSI** być sprawdzane również w **`rk_stage_schedule.cu:138` i `:191`** (obecnie sprawdzało `fsal_method && !has_periodic_reduced_nodes` — gdyby `fsal_method` stało się `true` dla `frozen_spins`, to `RK23`/`RK45 + frozen_spins` błędnie ustawiłoby `endpoint_valid = true`, wywołując błędną promocję w `rk_attempt_loop.cu:297` i fałszywe `endpoint_cache_invalidations`!).
2. **`fsal_k0_reuse` (`gpu_rk_rhs_allows_fsal_k0_reuse(ctx)` — wszystkie 4 metody: Heun, RK4, RK23, RK45):**
   - Wykorzystuje końcowe RHS obliczone **po** końcowej projekcji i normalizacji (`rk_final_refresh.cu:117`) jako `k[0]` kolejnego kroku.

#### Kompletna macierz 10 warunków unieważnienia

| # | Warunek / Źródło | Status | Mechanizm strażnika |
|---|---|---|---|
| 1 | Pierwszy krok po inicjalizacji | Wyłączony (`fsal_valid = false`) | `rk_attempt_setup.cu` liczy `k[0]` świeżo |
| 2 | Szum termiczny Browna (`temperature > 0.0`) | **Wyłączony** | `rk_fsal_policy.cpp` |
| 3 | Callbacki etapowe (`oersted`/`stage_transport`) | **Wyłączony** | `rk_fsal_policy.cpp` |
| 4 | Napędy nieciągłe / host-expression (`FULLMAG_FEM_TIME_PULSE`, Oersted `time_dep_kind == 2`, SOT pulse, `FULLMAG_FEM_TIME_HOST_EXPRESSION`) | **Wyłączony (fail-closed)** | `gpu_rk_has_discontinuous_or_host_drive(ctx)` w `rk_fsal_policy.cpp` |
| 5 | Napędy ciągłe (`CONSTANT`, `SINUSOIDAL`, `SINC_PULSE`, ciągły `PIECEWISE_LINEAR`) | **Dozwolony ze strażnikiem czasu i sygnatury** | Zapis `fsal_time_seconds` + `fsal_operator_signature` w `FemGpuRkWorkspaceDeviceState`; sygnatura `gpu_rk_fsal_operator_signature(ctx)` (`rk_fsal_policy.cpp:45-67`) haszuje dodatkowo `zeeman.external_field_am[0..2]`, `zeeman.stage_start_time_s`, `gpu.relaxation.state_generation`, `stt.*`, `sot.*`, `oersted.time_dep_kind`, `dmi.rotated_interfacial_enabled`, `frozen_spins.enabled()` |
| 6 | Odrzucony krok adaptacyjny (retry) | Zachowany tylko gdy policy pozwala | `rk_attempt_loop.cu:244-255` przywraca `m` i `k[0]`, a na `max_reject`/błąd ustawia `fsal_valid = false` |
| 7 | Rollback transakcji (`rk_step_transaction.cpp:457,654`) | Pełny snapshot i przywracanie | Snapshot i przywracanie `(gpu_fsal_valid, fsal_time_seconds, fsal_operator_signature)` + metadanych predyktora (z przesuwaniem buforów predyktora dopiero **po** ostatnim failpoincie `DuringFinalFieldRefresh`!) |
| 8 | Reset `m` / upload pól / relaksacja / `begin_stage` / `invalidate_fsal` (`api.cpp:5976`) | Unieważniany wszędzie | Zerowanie `fsal_valid = false` + `gpu_demag_predictor_invalidate(...)` |
| 9 | Zamrożone spiny (`ctx.frozen_spins.enabled()`) | **Włączony dla Heun/RK4** (wyłączony dla `endpoint_rhs_ready` w RK23/RK45 i w `rk_stage_schedule.cu:138,191`!) | `rk_stage_schedule.cu:162-171` projektuje zamrożone spiny przed `rk_final_refresh.cu:117`, a `rk_rhs_runtime.cu:260-262` zeruje zamrożone węzły w `gpu.rk.error` |
| 10 | Okresowość PBC (`has_periodic_reduced_nodes`) | **Włączony dla Heun/RK4** (wyłączony dla `endpoint_rhs_ready` w RK23/RK45!) | `rk_stage_schedule.cu:104` projektuje okresowo i normalizuje `m`, a `rk_final_refresh.cu:117` woła idempotentną projekcję w `gpu_rk_compute_rhs_for_magnetization` |

---

### 4.2. Dwukrokowy liniowy predyktor potencjału $\phi^{(0)}$ dla HYPRE CG/AMG

#### Wzór matematyczny i ochrona przed regresją etapów o równym czasie!
Niech $\phi_{n-1} = \phi(m(t_{n-1}))$ oraz $\phi_n = \phi(m(t_n))$ będą zaakceptowanymi potencjałami końcowymi z dwóch kolejnych zaakceptowanych kroków ($\Delta t_{n-1} = t_n - t_{n-1} > 0$). Dla etapu RK w chwili $t_{\text{eval}} = t_n + c_s \Delta t_n$:
$$\phi^{(0)}(t_{\text{eval}}) = \phi_n + \alpha \bigl(\phi_n - \phi_{n-1}\bigr), \qquad \alpha = \frac{t_{\text{eval}} - t_n}{t_n - t_{n-1}} = c_s \frac{\Delta t_n}{\Delta t_{n-1}}.$$

**Krytyczna ochrona przed regresją etapów o równym czasie (`last_solved_stage_time_s`):**
W RK4 etap 3 ($c_3 = 1$) oblicza już przybliżenie $\phi(t_{n+1})$ rzędu $O(\Delta t^3)$ i zapisuje je w `poisson_solution`; natychmiast po nim końcowe odświeżenie (`rk_final_refresh.cu`, również w $c = 1$, $t_{\text{eval}} = t_{n+1}$) miałoby gorszy start, gdyby bezwarunkowa ekstrapolacja liniowa $O(\Delta t^2)$ nadpisała `poisson_solution`! To samo dotyczy etapu 2 RK4 ($c_1 = c_2 = 0.5$) oraz etapu 6 RK45 ($c_5 = c_6 = 1.0$).

**Rozwiązanie:** W `GpuDemagLinearPredictorState` przechowujemy `double last_solved_stage_time_s`:
- Na początku każdej próby kroku w `rk_attempt_setup.cu` ustawiamy `last_solved_stage_time_s = ctx.state.current_time` (z `active_step_dt_s = active_dt`).
- W `stage_compute.cpp`: **uruchamiamy ekstrapolację wyłącznie wtedy, gdy `request.stage_time_s > predictor.last_solved_stage_time_s`**! Gdy `stage_time_s <= last_solved_stage_time_s` (kolejny etap w tym samym czasie $t_{\text{eval}}$), zostawiamy w `poisson_solution` świeżo wyznaczone dokładniejsze przybliżenie z poprzedniego etapu!
- Po udanym rozwiązaniu etapu RK w `stage_compute.cpp` aktualizujemy `predictor.last_solved_stage_time_s = request.stage_time_s`.

#### Kompletne strażniki wyłączania i unieważniania predyktora
1. **Zero-overhead pod `cuDSS`:** gdy `workspace->direct_solver != nullptr`, predyktor jest kompletnym no-op (0 B VRAM, 0 kerneli, 0 kopii D2D).
2. **Brak historii:** `history_count < 2` $\implies$ pomiń predyktor (zachowaj $\phi_n$).
3. **Warunek monotonicznego postępu czasu etapu:** `stage_time_s > last_solved_stage_time_s` (chroni RK4 stage 2, RK4 final refresh, RK45 stage 6).
4. **Ograniczenie stosunku kroków:** jeśli $\Delta t_{n-1} \le 0$, $\alpha \le 0$, $\Delta t_n / \Delta t_{n-1} > 2.0$ lub $\alpha > 2.0$ $\implies$ pomiń predyktor (zachowaj $\phi_n$).
5. **Unieważnienie na wszystkich punktach mutacji i nie-RK konsumentach:**
   - `request.reset_initial_solution == true` lub `fresh_initial_guess_required == true` $\implies$ `gpu_demag_predictor_invalidate(...)`,
   - **Nie-RK konsumenci w `stage_compute.cpp`:** jeśli `request.purpose` NIE jest `IntermediateRkStage` ani `EndpointRkStage` (`RelaxationTrial`, `RelaxationAcceptedState`, `ObservableRefresh`, `ValidationOracle`, `FrequencyTangent`, w tym `pgbb.cpp` i `nonlinear_cg.cpp`) $\implies$ automatyczne `gpu_demag_predictor_invalidate(...)`,
   - `api.cpp:5976` (`fullmag_fem_backend_invalidate_fsal`) $\implies$ wywołuje `inline gpu_demag_predictor_invalidate(...)` (z Phase 0 `demag_predictor.hpp`, zero sprzężenia linkera w Fazie 1!),
   - Zewnętrzne uploady `m` / zmiany rozmiaru w `gpu_state.cpp` $\implies$ `gpu_demag_predictor_invalidate(...)`,
   - `!gpu_rk_rhs_allows_fsal_k0_reuse(ctx)` lub zmiana `operator_signature` $\implies$ `gpu_demag_predictor_invalidate(...)`.
6. **Bezpieczny moment commitu i rollback transakcji:**
   - W `rk_final_refresh.cu`: `gpu_demag_predictor_commit_accepted_potential` (swap `d_phi_prev <-> d_phi_curr` + D2D copy) wywołujemy **dopiero PO** ostatnim punkcie wstrzykiwania błędów `RkStepFailurePoint::DuringFinalFieldRefresh` (`rk_final_refresh.cu:142-148`) i przed końcowym zwrotem sukcesu!
   - W `rk_step_transaction.cpp:457,654`: snapshotujemy i przywracamy metadane predyktora (`history_count`, `t_curr`, `t_prev`, `operator_signature`, `last_solved_stage_time_s`); ponieważ bufory `d_phi_curr`/`d_phi_prev` nie zostały zamienione przed failpointem, przywrócenie metadanych gwarantuje 100% spójność po rollbacku!
7. **Zakres FEM/BEM Krylov:** W tym pakiecie predyktor $\phi^{(0)}$ jest wdrażany dla **Poisson Krylov** (gdzie duże siatki z airboxem mogą przekroczyć limit VRAM i spaść z `auto` do CG/AMG). Dla **GPU FEM/BEM** siatka obejmuje wyłącznie ciało magnetyczne P1 (`TET4`, bez airboxu, $10\times$–$30\times$ mniej DOF), więc pod `auto` praktycznie zawsze wygrywa `cuDSS` (gdzie predyktor jest no-op); modularny `GpuDemagLinearPredictorState` można w razie potrzeby podpiąć do `u1`/`u2` jako drobny follow-up bez zmian interfejsu.

---

### 4.3. Uczciwa ocena CUDA Graph Capture dla RK + `cuDSS` — Decyzja: NON-GOAL (Follow-up P1)

Na podstawie analizy istniejącego kodu w repozytorium (**`backends/fem/gpu/frequency_domain/modal_cudss_device_graph.cpp`**, 344 linie) przechwytywanie grafów CUDA dla pętli czasowej RK+`cuDSS` zostaje jawnie wyłączone z zakresu P0 (odłożone do osobnego projektu P1) z powodu czterech twardych blokerów:

1. **Prywatne kopiowania H2D ze stosu wewnątrz `cuDSS 0.8.0.10`:** `cudssExecute(CUDSS_PHASE_SOLVE)` kolejkuje drobne transfery H2D ($\le 64\,\text{B}$) ze zmiennych na stosie hosta (`modal_cudss_device_graph.cpp:1-45`). Raw `cudaStreamBeginCapture` utrwala wiszące wskaźniki; bezpieczne odtworzenie nawet jednego solve'a wymaga klonowania grafu, sondowania buforów, przepisywania węzłów `cudaGraphNodeTypeMemcpy` na D2D z trwałego `replay_control` i weryfikacji bitowej na 2 losowych wektorach.
2. **Niezależna certyfikacja rezyduum po każdym rozwiązaniu:** `A_par->Mult` + `HYPRE_ParVectorAxpy` (ze sprawdzaniem stanu HYPRE na hoście) + `cudaStreamSynchronize` + hostowe gałęzie `std::isfinite` / tolerancji są zakazane wewnątrz `cudaStreamBeginCapture`.
3. **Dynamiczne parametry etapów przekazywane przez wartość z hosta:** `evaluation_time_s`, `active_dt`, obwiednie Oersted/SOT i `HOST_EXPRESSION` zmieniają się w każdym etapie/próbie.
4. **Dwustrumieniowa synchronizacja (`compute_stream` $\leftrightarrow$ `hypre_stream`) i sterowanie adaptacyjne:** zdarzenia między strumieniami oraz pętla accept/reject (`rk_attempt_control_packet`) wymagają gałęzi po stronie hosta.

Po wdrożeniu Track A + B + C pozostały narzut uruchamiania kerneli na siatkach $\ge 49\text{k}$ węzłów to $<5\%$ czasu kroku — pełny CUDA Graph wymaga dedykowanego P1 (własny SpMV CSR dla certyfikacji bez HYPRE + odroczona flaga certyfikacji na koniec kroku + generalizacja `CudssDeviceGraph`).

---

## 5. Macierz rozłącznej własności plików (ZERO nakładania się między 3 autorami)

**Izolacja szwu względem PR #558:** 4 potencjalnie współdzielone pliki (`native/include/fullmag_fem.h`, `backends/fem/src/api.cpp`, `backends/fem/CMakeLists.txt`, `crates/fullmag-plan/src/fem.rs`) zostały zweryfikowane pod kątem rozłączności bloków zmian (wszystkie zmiany P0 są addytywne w odrębnych sekcjach).

### Faza 0 — Zamrożony kontrakt nagłówkowy (9 plików nagłówkowych, commit bazowy)
*(Wszystkie 3 pola członkowskie struktur czytane między torami trafiają do Fazy 0, dzięki czemu każda z 3 izolowanych gałęzi Fazy 1 kompiluje się czysto bez błędów brakujących pól!)*
1. `backends/fem/gpu/cuda/demag_poisson/demag_kernels.hpp`: `GpuValidationNormScratch`, `fullmag_cuda_demag_validation_scratch_{init,destroy}`, `fullmag_cuda_demag_validation_norm_pair`.
2. `backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.hpp` *(NOWY)*: `inline certification_solver_tolerance`, `GpuDemagResidualCertInput`, `GpuDemagResidualCertOutput`, `certify_gpu_hypre_demag_residual`.
3. `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.hpp`: `GpuDemagSolverStrategy`, `GpuDemagFallbackReason`, `GpuDemagCudssResolution`, `kDemagCudssMaxVramMibEnv`, `resolve_demag_gpu_solver_strategy`, `try_initialize_demag_cudss_direct`, `Context`-free `try_initialize_fem_bem_cudss_pair`.
4. `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.hpp`: deklaracje `gpu_demag_fem_bem_amg_coarse_relax_type`, `gpu_demag_fem_bem_linear_solver`, `gpu_demag_fem_bem_cudss_resolution`.
5. `backends/fem/gpu/cuda/demag_poisson/demag_predictor.hpp` *(NOWY)*: `GpuDemagLinearPredictorState` (z `last_solved_stage_time_s`), **`inline gpu_demag_predictor_invalidate`** (zero sprzężenia linkera z `api.cpp` w Fazie 1!), `gpu_demag_predictor_{destroy,apply_warm_start,commit_accepted_potential}`.
6. `backends/fem/gpu/cuda/demag_poisson/stage_compute.hpp`: addytywne pola `bool has_stage_time = false; double stage_time_s = 0.0; double step_dt_s = 0.0;` w `GpuDemagApplyRequest`.
7. `backends/fem/cpu/mfem/interactions/demag_poisson_runtime.hpp`: pola `GpuDemagSolverStrategy gpu_solver_strategy = GpuDemagSolverStrategy::Auto;` oraz `GpuDemagCudssResolution gpu_cudss_resolution{};` (czytane przez Author 1 w `fem_bem.cpp` i `cuda_demag_residual_fixture.hpp` oraz przez Author 2 w `hypre_device_solver.cpp` i `api.cpp`).
8. `backends/fem/gpu/cuda/demag_poisson/operators.hpp`: pole `GpuValidationNormScratch validation_scratch{};` w `GpuDemagPoissonWorkspace` (używane przez Author 1 w `cuda_demag_residual_fixture.hpp` oraz Author 2 w `poisson.cpp`/`operators.cpp`/`hypre_device_solver.cpp`).
9. `backends/fem/gpu/cuda/demag_poisson/demag_state.hpp`: pole `GpuDemagLinearPredictorState predictor{};` w `FemGpuDemagPoissonDeviceState` (używane przez Author 2 w `api.cpp:5976` oraz Author 3 w `gpu_state.cpp`/`stage_compute.cpp`/`rk_*`).

### Faza 1 — Równoległa realizacja (ZERO wspólnych plików między autorami!)

| Autor | Zakres | Wyłączna własność plików (Create / Modify) |
|---|---|---|
| **Author 1: `cert-fembem-author`** (Track A) | Wieloblokowy `ScaledNormPair` (bez `break;`, `rows<=0`), `hypre_residual_certification.cpp` (sticky HYPRE verbatim + `reject_queued_work`), oczyszczenie GPU FEM/BEM (`relax_type=18`, `HypreStreamInterop`, `0.1*rtol`, `cuDSS` na `hypre_stream`, bugfix `:1059`), testy certyfikacji i FEM/BEM, dokumentacja `0913` + `fem_demag_fem_bem` | • `backends/fem/gpu/cuda/demag_poisson/demag_kernels.{hpp,cu}`<br>• `backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.{hpp,cpp}` *(NOWE)*<br>• `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.{hpp,cpp}`<br>• `backends/fem/tests/cuda_demag_residual_fixture.hpp`<br>• `backends/fem/tests/cuda_periodic_demag_contract.cpp`<br>• `backends/fem/tests/demag_fem_bem_gpu_contract.cpp`<br>• `docs/physics/0913-fem-gpu-amg-coarse-residency.{md,source-map.json}`<br>• `docs/physics/fem_demag_fem_bem.{md,source-map.json}` |
| **Author 2: `cudss-auto-author`** (Track B) | Polityka `auto`/`cg_amg`/`cudss`, `MAX_VRAM_MIB` + `BUDGET_BYTES`, `Context`-free `try_initialize_fem_bem_cudss_pair`, PBC-reduced `cuDSS`, inicjalizacja `validation_scratch` w `poisson.cpp:104`, C ABI `plan_desc_v5` + `create_v6` + `get_provenance_v1`, `api.cpp:5976` invalidacja predyktora, Python/IR/Plan/Runner (w tym `frequency_response.rs`, `test_api.py`, `demag_poisson_contract.cpp`, `fem/execution.rs`), dokumentacja `0997` | • `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.{hpp,cpp}`<br>• `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.{hpp,cpp}`<br>• `backends/fem/gpu/cuda/demag_poisson/operators.cpp`<br>• `backends/fem/gpu/cuda/demag_poisson/poisson.{hpp,cpp}`<br>• `native/include/fullmag_fem.h`<br>• `backends/fem/src/api.cpp`<br>• `crates/fullmag-fem-sys/src/lib.rs`<br>• `packages/fullmag-py/src/fullmag/model/discretization.py`<br>• `packages/fullmag-py/src/fullmag/world.py`<br>• `packages/fullmag-py/src/fullmag/runtime/script_builder.py`<br>• `packages/fullmag-py/tests/test_api.py`<br>• `crates/fullmag-ir/src/study.rs`<br>• `crates/fullmag-plan/src/fem.rs`<br>• `crates/fullmag-runner/src/{types.rs,dispatch.rs,artifacts.rs,native_fem.rs,frequency_response.rs}`<br>• `crates/fullmag-runner/src/native_fem/{plan.rs,runtime_info.rs}`<br>• `crates/fullmag-runner/src/fem/{runtime_contract.rs,execution.rs}`<br>• `crates/fullmag-runner/src/fem/relax/finalize.rs`<br>• `backends/fem/tests/{cudss_poisson_budget_contract.cpp,demag_poisson_contract.cpp,gpu_strict_execution_contract.cpp,llg_time_domain_qualification.cpp}`<br>• `docs/physics/0997-fem-gpu-poisson-direct-cudss.{md,source-map.json}` |
| **Author 3: `rk-fsal-author`** (Track C) | FSAL `k0` dla Heun/RK4 + rozdział `endpoint_rhs_shortcut` w `rk_stage_schedule.cu:138,191` + pełna sygnatura operatora + snapshot transakcji + predyktor $\phi^{(0)}$ z ochroną `last_solved_stage_time_s` i auto-unieważnieniem nie-RK konsumentów, dokumentacja `0998` | • `backends/fem/gpu/cuda/integrators/rk/{rk_fsal_policy.hpp,rk_fsal_policy.cpp,rk_step_preflight.cu,rk_attempt_setup.cu,rk_stage_schedule.cu,rk_final_refresh.cu,rk_workspace_state.hpp,rk_demag_dispatch.hpp,rk_demag_dispatch.cu,rk_rhs_runtime.cu}`<br>• `backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp`<br>• `backends/fem/gpu/cuda/demag_poisson/demag_predictor.{hpp,cu}` *(NOWE)*<br>• `backends/fem/gpu/cuda/demag_poisson/stage_compute.{hpp,cpp}`<br>• `backends/fem/gpu/cuda/state/gpu_state.cpp`<br>• `backends/fem/tests/{cuda_rk_guard_contract.cpp,source_facade_gpu_rk_contract.cpp}`<br>• `backends/fem/tests/cuda_rk_heun_rk4_fsal_predictor_contract.cpp` *(NOWY)*<br>• `crates/fullmag-runner/src/native_fem/tests/parity.rs`<br>• `docs/physics/0998-fem-gpu-rk-fsal-and-potential-predictor.{md,source-map.json}` *(NOWE)* |

### Faza 2 — Integracja, `CMakeLists.txt` i Weryfikator
- `backends/fem/CMakeLists.txt`: rejestracja `hypre_residual_certification.cpp`, `demag_predictor.cu`, oraz celu CTest `cuda_rk_heun_rk4_fsal_predictor_contract` (w jednym punkcie po scaleniu).
- Synchronizacja zduplikowanego testu `native_fem_explicit_rk_reports_real_rhs_cost_when_mfem_stack_is_available` w `crates/fullmag-runner/src/native_fem.rs:10379` z `parity.rs:202`.
- Uruchomienie zintegrowanych testów krzyżowych (zwłaszcza `cuda_demag_residual_fixture`, `cuda_periodic_demag_contract`, `demag_poisson_contract`, `demag_fem_bem_gpu_contract` z `cuDSS`), walidatorów dokumentacji naukowej i spójności repo, oraz 4-scenariuszowej suity A/B w Docker DEV.

---

## 6. Dokumentacja naukowa (`scientific-documentation-contract`)

1. **`docs/physics/0913-fem-gpu-amg-coarse-residency.{md,source-map.json}`** *(Author 1)*: rozszerzenie `relax_type=18` na GPU FEM/BEM (`fem_bem.cpp::configure_amg`, `gpu_demag_fem_bem_amg_coarse_relax_type`, usunięcie obejścia `"JACOBI"` w `native_fem/plan.rs`).
2. **`docs/physics/fem_demag_fem_bem.{md,source-map.json}`** *(Author 1)*: ujednolicona certyfikacja rezyduum (`ScaledNormPair`, 1× sync, `0.1*rtol`), `HypreStreamInterop`, dowód SPD dla $K_{\text{neumann}}$ i $K_{\text{dirichlet}}$ oraz atomowy preflight VRAM dla pary `(u1, u2)` na `hypre_stream`.
3. **`docs/physics/0997-fem-gpu-poisson-direct-cudss.{md,source-map.json}`** *(Author 2)*: promocja z opt-in POC do produkcyjnej polityki trójstanowej (`auto`/`cg_amg`/`cudss`), `create_v6` / `plan_desc_v5`, `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB`, wieloblokowa certyfikacja par, PBC-reduced SPD (1D Robin / 2D film pin / 1D–2D Dirichlet / 3D osobliwy fail-closed), FEM/BEM para `(u1, u2)` oraz jawne uzasadnienie odłożenia CUDA Graph do P1 (`modal_cudss_device_graph.cpp`).
4. **`docs/physics/0998-fem-gpu-rk-fsal-and-potential-predictor.{md,source-map.json}`** *(Author 3 — NOWA NOTATKA)*: formalny rozdział `fsal_k0_reuse` vs `endpoint_rhs_ready`, dowody poprawności dla frozen spins i PBC, 10-punktowa macierz unieważnień, liniowy predyktor $\phi^{(0)}(t_{\text{eval}})$ z ochroną `stage_time_s > last_solved_stage_time_s`, progiem `dt_ratio <= 2.0` oraz no-op pod `cuDSS`.

**Obowiązkowe bramki walidacyjne (rzeczywiste ścieżki z `.agents/skills/scientific-documentation-contract/SKILL.md:44-51`):**
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

---

## 7. Suita benchmarków A/B (Docker DEV, RTX 4080 SUPER)

Pomiary wykonuje weryfikator w kontenerze Docker DEV (`just docker-dev` / `just fullmag-dev-container`) na **RTX 4080 SUPER (16 GiB VRAM)** porównując baseline (`origin/master`) z kandydatem przy `rtol = 1e-8`, 5 krokach warmup i 50 krokach pomiarowych. Raportuje: `wall_ms_per_step`, `demag_solve_ms_per_step`, `rhs_evals_per_step`, `avg_linear_iters`, `control_fences_per_step`, `requested_linear_solver_strategy`, `resolved_linear_solver`, `linear_solver_fallback_reason` oraz $\max \|m_{\text{cand}} - m_{\text{base}}\|_\infty$.

1. **Scenariusz 1 — Poisson open-airbox (SP4 ~8k oraz średnia ~49k węzłów):**
   - Baseline `origin/master` (CG/AMG, brak FSAL Heun/RK4, 2× sync) vs Candidate `gpu_strategy="cg_amg"` (1× sync + Heun/RK4 FSAL + predyktor $\phi^{(0)}$) vs Candidate `gpu_strategy="auto"` (`cudss_direct` + 1× sync + Heun/RK4 FSAL).
   - Bramki: $\max\|m_{\text{cand}}-m_{\text{base}}\|_\infty \le 10^{-6}$, $|\Delta E_{\text{demag}}|/|E_{\text{demag}}| \le 10^{-7}$, RHS/krok Heun `3→2` i RK4 `5→4`, fences/solve `2→1` (16 B), redukcja iteracji Krylowa pod `cg_amg`, wyraźne przyspieszenie pod `auto`.
2. **Scenariusz 2 — Ciasny limit VRAM (`FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB=32` na siatce 49k–100k):**
   - Candidate `gpu_strategy="auto"` + `MAX_VRAM_MIB=32`: sukces, `requested_linear_solver_strategy = "auto"`, `resolved_linear_solver = "hypre_krylov"`, `linear_solver_fallback_reason = "cudss_factor_exceeds_vram_budget"`, `factorization_started = false`, spadek średnich iteracji CG/AMG dzięki predyktorowi $\phi^{(0)}$.
   - Candidate `gpu_strategy="cudss"` + `MAX_VRAM_MIB=32`: twardy błąd (`exit != 0`) z estymacją szczytu i budżetu VRAM, zero fallbacku.
3. **Scenariusz 3 — GPU FEM/BEM (geometria otwarta, bez airboxu):**
   - Baseline `origin/master` (domyślny `"JACOBI"`, 4× sync + 4× `Norml2()` na krok) vs Candidate `gpu_strategy="cg_amg"` (`"AMG"`, `relax_type=18`, `HypreStreamInterop`, `0.1*rtol`, 1× sync/układ) vs Candidate `gpu_strategy="auto"` (`cudss_direct` na `u1`/`u2`, recepta `DIRECT_SOLVE` bez `PRECONDITIONER`).
   - Bramki: `coarse_relax_type == 18` dla `cg_amg` i `-1` dla `auto`, parzystość $H_{\text{demag}}$ i $m \le 10^{-6}$.
4. **Scenariusz 4 — PBC-reduced Poisson (1D Robin + 2D film z singleton pinem):**
   - Baseline `origin/master` (AMG, brak FSAL na PBC) vs Candidate `gpu_strategy="auto"` (`cudss_direct` na $A_{\text{red}}$ + FSAL `k0` dla Heun/RK4 na PBC).
   - Bramki: `resolved_linear_solver == "cudss_direct"`, certyfikowane rezyduum $\le \text{rtol}$, parzystość $\le 10^{-6}$, `fsal_reused == true` od kroku 2.
