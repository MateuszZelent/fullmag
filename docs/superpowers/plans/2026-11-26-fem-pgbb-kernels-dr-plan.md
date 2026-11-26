# Pakiet Wave 3 (PR C): GPU PGBB `bb_exchange_mass` + Kernele Krótkozasięgowe + GPU Driven Response `cuDSS` — Plan Implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Realizacja równoległa w roju: **Faza 0** (kompilujący się commit szwów, szkieletów, `CMakeLists.txt` i forwarderów `api.cpp` przez Koordynatora) $\to$ **Faza 1** (3 równolegli autorzy w izolowanych worktree z **ZEROWYM** nakładaniem się plików i pełnym TDD CTest/Cargo od kroku 1) $\to$ **Faza 2** (scalenie 3 gałęzi, porządkowanie `api.cpp:423,431`, `docs/physics/README.md`, build non-MFEM + GPU w Docker DEV, pełny zestaw testów, walidatory dokumentacji, benchmarki A/B na RTX 4080 SUPER).

**Goal:** Wdrożyć i zakwalifikować w jednym spójnym PR (Wave 3) trzy pakiety wydajnościowe FEM GPU: (1) naprawę i kwalifikację `bb_exchange_mass` (3 niezależne składowe PCG + skalowanie $D^{-1/2}$ + normalizacja $\sigma_c, \tau_c$ + `kMaximumIterations=2048` + bezpieczne `auto` z atestacją runtime) oraz redukcję barier/energii PGBB (7$\to$4 sync, 3$\to$1 redukcji energii); (2) bramkowanie nieużywanych redukcji pośrednich RK (DMI/anizotropia/magnetoelastyczność/termika + `h_drive_zeroed = false` początkowo), rozdział `gpu_relax_dd` (szybkie FP64 FMA w RK vs DD w relaksacji), fuzję `H_eff` (28$\to$1 launch) oraz zastąpienie strided `cudaMemcpy2D` przez device pack/unpack; (3) bezpośredni solver `cuDSS` (`CUDSS_MTYPE_GENERAL`, `CUDSS_C_64F`) dla przemiatań RF Driven Response (1× analiza symboliczna + zero-H2D-copy aktualizacja per-$\omega_k$ + ekwilibracja Ruiza + preflight VRAM + niezależna certyfikacja $(r_q, r_\phi)$ na GPU).

**Architecture:** Trzy w pełni rozłączne tory osadzone na kompilującym się commicie Fazy 0 (nagłówki/FFI + szkielety nowych plików + `CMakeLists.txt` + cienkie forwardery w `api.cpp` + 4-miejscowy walidator ABI v13/v14): (1) Track 1 ulepsza kooperatywny kernel PCG w `bb_exchange_mass_kernels.cu`, łączy go z projekcją/iloczynem `z·g`, usuwa drugą redukcję energii w `rk_step_stats.cu` + `pgbb.cpp` oraz atestuje status `auto` w `types.rs` / `provenance.rs` / 4 punktach wywołania runnera; (2) Track 2 wprowadza szablony `<bool ComputeEnergy/MaxSigma/Compensated>`, jeden scalony kernel `fullmag_cuda_accumulate_heff_fused_xyz` w `vector_field_kernels.cu` oraz symetryczne `fullmag_cuda_unpack_aos_to_soa` współdzielące istniejący bufor `packed_field_download.aos_device`; (3) Track 3 wypełnia `driven_response_cudss.{hpp,cpp}` + `driven_response_cudss_kernels.cu` i eksporter CSR `demag_poisson_sparse_export.{hpp,cpp}` zasilający `driven_response_solver.cpp` (ABI v14) i `frequency_response.rs` pod polityką `auto` / `gpu_sparse_direct` / `gpu_operator_host_krylov`.

**Tech Stack:** C++20, CUDA/CUB (`nvcc`), MFEM, HYPRE, NVIDIA cuDSS 0.8+, Rust (`fullmag-ir`, `fullmag-fem-sys`, `fullmag-runner`), Python 3 (`fullmag-py`), CMake/CTest, Cargo, Pytest, Docker DEV (`just docker-dev`).

**Spec:** [2026-11-26-fem-pgbb-kernels-dr-design.md](../specs/2026-11-26-fem-pgbb-kernels-dr-design.md)

## Global Constraints

- Baza wszystkich prac: `origin/master` (`9ab99132d55d4af1596f42625c7733ccac496c31`); praca wyłącznie w izolowanym worktree `worktrees/<task-id>` i gałęzi `codex/<task-id>` zgodnie z `AGENTS.md`.
- Ścisły kontrakt proweniencji (`AGENTS.md`): `requested_intent` musi pozostać rozdzielone od `resolved_execution`; jawne `policy="exchange_mass"` (PGBB) oraz jawne `solver_method="gpu_sparse_direct"` (Driven Response) **MUSZĄ** zakończyć się twardym błędem przy braku zasobów/wsparcia lub przekroczeniu VRAM — ZERO cichego fallbacku do surowego gradientu, GMRES ani CPU!
- Błędy numeryczne (`CUDSS_DATA_INFO != 0`, porażka certyfikatu rezyduum, `NaN`/`Inf`, błędny format `FULLMAG_FEM_DRIVEN_CUDSS_MAX_VRAM_MIB` / `BUDGET_BYTES`) są **ZAWSZE twardym błędem**, również pod `auto`.
- Zakaz alokacji VRAM/host w pętlach gorących PGBB, RK i przemiatań $\omega_k$; pełne poszanowanie `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1`.
- Pełna kompilowalność i przejście testów w konfiguracjach `FULLMAG_HAS_MFEM_STACK=0`, `FULLMAG_HAS_CUDA_RUNTIME=0` i `FULLMAG_FEM_CUDSS_DRIVEN_ENABLED=0` (CI `bootstrap / native-modal-cabi-contract`): `driven_response_cudss.cpp` i `demag_poisson_sparse_export.cpp` **MUSZĄ** być w bezwarunkowym `FEM_SOURCES` z wewnętrznymi `#if`!
- Zero nakładania się plików w Fazie 1; `backends/fem/CMakeLists.txt` i 4 forwardery C ABI w `backends/fem/src/api.cpp` są zamrażane raz w Fazie 0, a `docs/physics/README.md` (i opcjonalny cleanup `api.cpp:423,431`) w Fazie 2 — żaden z 3 autorów Fazy 1 nie dotyka `api.cpp` ani `CMakeLists.txt`!
- Wszystkie komendy budowania/testowania C++/CUDA/Rust/benchmarków w Docker DEV uruchamiane w grupie `just docker-dev` (nigdy goły `docker run` z hostowymi cache).
- Kompletność dokumentacji naukowej: zaktualizowany `docs/physics/0581-*` + nowe `0999-*` i `1000-*` wraz z `.source-map.json` oraz 100% PASS dla `validate_scientific_docs.py`, `validate_changed_scientific_docs.py --base origin/master --head HEAD` i `scripts/check_repo_consistency.py`.

## Review Focus

1. **Planarna składowa o skrajnie małym gradiencie i nanometrycznej skali SI w `bb_exchange_mass` (`||b_z|| ~ 10^{-150}`, `||b_x|| ~ 10^{-14}`, wiersze powietrza `1.0`)** — 3 niezależne składowe PCG ze skalowaniem $D^{-1/2}$, normalizacją $\sigma_c, \tau_c$, certyfikatem SpMV liczonym jako `a.values[j] * (z[col] / sigma_c)` (zero subnormalnego underflowu!), wspólnym `__shared__ double shmem[6][kThreads]` i brakiem przedwczesnego `return` omijającego `grid.sync()` muszą zbiec z niezależnym certyfikatem $\le 10^{-8}$ na każdej niezerowej składowej i dokładnym `0.0` na wierszach powietrza i zamrożonych spinach. *(Przypięte do: Zadanie 1, `cuda_bb_exchange_mass_contract.cpp`.)*
2. **Brak skażenia slotów energii `[1..10]`, brak nieświeżych slotów przy wczesnych wyjściach i atomowy rollback w PGBB** — tail krzywizny BB `(s.s, s.y, y.y, next_g2, next_pg2)` ląduje wyłącznie w slotach `18..22`; wariant `reuse_energy` jest wołany **wyłącznie** dla zaakceptowanej próby Armijo (`pgbb.cpp:1107`), zaś wszystkie 3 rzadkie wczesne wyjścia (`:704`, `:733`, `:994`) zachowują pełne `gpu_rk_finalize_step_stats_control_readback`; niepoprawna krzywizna BB cofa `m_backup`, metadane i unieważnia `pgbb_accepted_field`. *(Przypięte do: Zadanie 2, `relaxation_source_contract.cpp` i `cuda_bb_exchange_mass_contract.cpp`.)*
3. **Brak deadlocka w `dmi_kernels.cu`, inicjalizacja `h_drive_zeroed = false` oraz rozdział `Compensated=false` (RK) vs `Compensated=true` (relaksacja)** — `dmi_element_residual_kernel` z `#include <cub/cub.cuh>` musi zamienić wszystkie 4 wczesne `return;` (`:141,144,156,167`) na predykat `if (active)` przed `cub::BlockReduce`; świeżo zaalokowany `h_drive` zaczyna z `h_drive_zeroed = false` (zeruje raz na pierwszym wywołaniu i po `drive_count > 0 -> 0`); szybka ścieżka RK wymiany daje dokładne `0.0` na stanie jednorodnym i `< 1e-13` względem DD bez naruszenia `relaxation_energy_derivative_contract`. *(Przypięte do: Zadanie 3 i Zadanie 4, `cuda_shortrange_kernels_contract.cpp`.)*
4. **Spójność strumienia i brak wyścigu w `state_io.cpp` (`:91,308,421,573,627`) / `stage_compute.cpp:809-818` po usunięciu `cudaMemcpy2D`** — `recover_device_demag_visual_field` bez pośredniego syncu wykonuje `pack_soa_to_aos` + `cudaMemcpyAsync` na tym samym `raw_stream` co kernel recovery (0 wyścigu danych), istniejące `gpu_state_{upload,download}_magnetization_aos` zachowują dotychczasowe delegacje, a `gpu_component_upload_aos_packed` odrzuca `raw_stream == nullptr` i dokładnie odtwarza bit-w-bit wektory dla `N ∈ {1, 3, 257, 1031}`. *(Przypięte do: Zadanie 6, `cuda_shortrange_kernels_contract.cpp`, `state_io_contract.cpp`, `gpu_state_runtime_contract.cpp`.)*
5. **Poprawność macierzy `poisson_bc_op` / zerowania `ess_tdofs`, kompatybilność ABI v13, granica VRAM, osobliwy rezonans ($\alpha=0$) i mod bezdywergencyjny w GPU Driven Response `cuDSS`** — (a) `demag_poisson_sparse_export.cpp` eksportuje `periodic_reduced_ready ? periodic_matrix : poisson_bc_op` i jawnie zeruje wiersze `ess_tdofs` w $-R_{\phi q}$; (b) ABI v13 nadal przechodzi wszystkie 4 miejsca w `driven_response_solver.cpp` (`:1025-1039, 1050, 6772, 16925-16932`) i `diagnostics_json[4096]` nie obcina pól `cuDSS`; (c) przekroczenie `FULLMAG_FEM_DRIVEN_CUDSS_MAX_VRAM_MIB` niszczy uchwyty przed faktoryzacją, failuje twardo pod `gpu_sparse_direct` i spada jawnie do GMRES pod `auto`; (d) osobliwy układ (`CUDSS_DATA_INFO != 0`) lub błędny format env failuje twardo również pod `auto`; (e) mod bezdywergencyjny ($\|R_{\phi q}\hat{q}\|_2 = 0$) przechodzi certyfikat `r_phi` z mianownikiem `max(||R_{phi q} q||_2, ||P delta_phi||_2)` i skalowanym progiem `atol_phi`; (f) `periodic_airbox_k0` podnosi $\delta\hat{\phi}_{\text{red}} \to \delta\hat{\phi}_{\text{full}}$ i wylicza $\delta\hat{H}_{\text{demag}} = G_{\text{rec}}\delta\hat{\phi}_{\text{red}}$, a niezerowe $k$ `floquet_airbox` z demag nie uruchamia niekompletnego `cuDSS`. *(Przypięte do: Zadanie 0, Zadanie 7 i Zadanie 8, `driven_response_cudss_contract.cpp` i testy w `frequency_response.rs`.)*

---

## Faza 0: Kompilujący się Commit Szwów, Szkieletów, `CMakeLists.txt` i Forwarderów `api.cpp` (Pre-Fanout)

### Zadanie 0: Zamrożenie szwów nagłówkowych/FFI, szkieletów nowych plików, `CMakeLists.txt`, forwarderów `api.cpp` i kompatybilności ABI v13/v14

> **Właściciel:** Coordinator (commit bazowy przed utworzeniem 3 worktree autorów Fazy 1). Dzięki temu commitowi **każdy z 3 równoległych autorów Fazy 1 ma w pełni kompilujący się i linkujący się stack C++/CUDA/Rust oraz zarejestrowane cele CTest od kroku 1 TDD, przy ZEROWYM nakładaniu się plików!**

**Files:**
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_stats.hpp:70-83`
- Modify: `backends/fem/gpu/cuda/fields/field_buffer_state.hpp:40-45` (`bool h_drive_zeroed = false;`)
- Modify: `backends/fem/gpu/cuda/relaxation/bb_exchange_mass.hpp:14-45`
- Modify: `backends/fem/gpu/cuda/relaxation/bb_exchange_mass.cpp` (5-liniowy kompilujący się stub `gpu_bb_exchange_mass_resolve` dla Fazy 0, zastępowany przez Author 1 w Zadaniu 1)
- Modify: `backends/fem/include/frequency_domain/driven_response_solver.hpp:13-162` (POD `DrivenFrequencyResponseDemagSparseBlocks`, `kDrivenFrequencyResponseSolveRequestAbiVersion = 14`, końcowe pola POD `gpu_direct_policy` i `const DrivenFrequencyResponseDemagSparseBlocks *demag_sparse_blocks = nullptr;`)
- Modify: `backends/fem/src/frequency_domain/driven_response_solver.cpp:1022-1055, 6768-6778, 16919-16935` (4-miejscowa wsteczna kompatybilność ABI 0/9/12/13/14, aby istniejące testy ABI v13 przechodziły od razu po Fazie 0!)
- Modify: `native/include/fullmag_fem.h` (struktury `fullmag_fem_gpu_bb_preconditioner_status`, `fullmag_fem_demag_poisson_sparse_blocks`, `fullmag_fem_frequency_domain_gpu_direct_options` oraz funkcje `fullmag_fem_backend_get_gpu_bb_preconditioner_status`, `fullmag_fem_backend_export_demag_poisson_sparse_blocks`, `fullmag_fem_demag_poisson_sparse_blocks_destroy`, `fullmag_fem_frequency_domain_solve_driven_response_v14` — **bez mutowania layoutu `fullmag_fem_frequency_domain_driven_response_request`**!)
- Modify: `crates/fullmag-fem-sys/src/lib.rs` (pasujące deklaracje FFI Rust)
- Create (kompilujące się szkielety wypełniane w Fazie 1):
  - `backends/fem/gpu/frequency_domain/driven_response_cudss.hpp`
  - `backends/fem/gpu/frequency_domain/driven_response_cudss.cpp` (stub zwracający `fallback_to_krylov = true` pod `Auto` / `unavailable` pod `Required`, wypełniany przez Author 3 w Zadaniu 7)
  - `backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu` (pusty kompilujący się szkielet wypełniany przez Author 3 w Zadaniu 7)
  - `backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.hpp`
  - `backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.cpp` (stub zwracający `false`, wypełniany przez Author 3 w Zadaniu 7)
  - `backends/fem/tests/cuda_shortrange_kernels_contract.cpp` (`int main() { return 0; }`, wypełniany przez Author 2 w Zadaniach 3–6)
  - `backends/fem/tests/frequency_domain/driven_response_cudss_contract.cpp` (`int main() { return 0; }`, wypełniany przez Author 3 w Zadaniu 7)
- Modify: `backends/fem/CMakeLists.txt`:
  - Dodać `gpu/frequency_domain/driven_response_cudss.cpp` oraz `cpu/mfem/interactions/demag_poisson_sparse_export.cpp` do **bezwarunkowego `FEM_SOURCES`** (obowiązkowo poza `if(FULLMAG_USE_MFEM_STACK)` i poza `if(FULLMAG_FEM_CUDSS_SHIFT_SUPPORTED)` — patrz wymaganie linkowania non-MFEM/no-CUDA!),
  - Dodać `gpu/frequency_domain/driven_response_cudss_kernels.cu` oraz `FULLMAG_FEM_CUDSS_DRIVEN_ENABLED=1` **wyłącznie** wewnątrz `if(FULLMAG_FEM_CUDSS_SHIFT_SUPPORTED)`,
  - Zarejestrować 2 cele CTest: `fem_cuda_shortrange_kernels_contract` oraz `fem_driven_response_cudss_contract`.
- Modify: `backends/fem/src/api.cpp` (4 cienkie forwardery C ABI: `fullmag_fem_backend_get_gpu_bb_preconditioner_status`, `fullmag_fem_backend_export_demag_poisson_sparse_blocks`, `fullmag_fem_demag_poisson_sparse_blocks_destroy` pod `#if FULLMAG_HAS_MFEM_STACK` z czystym `#else`, oraz `fullmag_fem_frequency_domain_solve_driven_response_v14`).

**Interfaces:**
- Produces:
  - `rk_step_stats.hpp`: `bool gpu_rk_finalize_step_stats_control_readback_with_scalar_tail_reuse_energy(Context &ctx, fullmag_fem_step_stats &stats, double *tail_scalars, size_t tail_count, std::string &reason);`
  - `field_buffer_state.hpp`: pole `bool h_drive_zeroed = false;` w `FemGpuFieldBufferDeviceState`.
  - `bb_exchange_mass.hpp`: `struct GpuBbExchangeMassStatus`, `void gpu_bb_exchange_mass_resolve(const Context &ctx, GpuBbExchangeMassStatus &out)`, `bool gpu_bb_exchange_mass_solve_and_project(...)`.
  - `driven_response_solver.hpp`: `kDrivenFrequencyResponseSolveRequestAbiVersion = 14`, `enum class DrivenFrequencyResponseGpuDirectPolicy : std::uint32_t { Auto = 0, Disabled = 1, Required = 2 }`, standard-layout trivially-copyable POD `struct DrivenFrequencyResponseDemagSparseBlocks`, 2 końcowe pola `gpu_direct_policy` i `const DrivenFrequencyResponseDemagSparseBlocks *demag_sparse_blocks = nullptr;` w `DrivenFrequencyResponseSolveRequest`.
  - `native/include/fullmag_fem.h` + `crates/fullmag-fem-sys/src/lib.rs` + `backends/fem/src/api.cpp`: pełny, kompilujący się i linkujący kontrakt C ABI + FFI Rust.

- [ ] **Step 1:** Dodaj deklaracje szwów, szkielety 5 nowych źródeł i 2 nowych testów, wpisy w `backends/fem/CMakeLists.txt` (z bezwarunkowym `driven_response_cudss.cpp` i `demag_poisson_sparse_export.cpp`), 4 forwardery w `backends/fem/src/api.cpp`, stub `gpu_bb_exchange_mass_resolve` w `bb_exchange_mass.cpp` oraz 4-miejscową kompatybilność ABI v13/v14 w `driven_response_solver.cpp` (`:1025-1039`, `:1050`, `:6772`, `:16925-16932`).
- [ ] **Step 2:** Zweryfikuj, że build CMake (zarówno non-MFEM/no-CUDA, jak i CUDA/MFEM), istniejące testy `fem_driven_response_contract`, `fem_frequency_domain_contract`, `fem_cuda_bb_exchange_mass_contract` oraz `cargo test -p fullmag-fem-sys` przechodzą w 100% PASS!
- [ ] **Step 3:** Commituj szew bazowy:
  ```bash
  git add backends/fem/gpu/cuda/integrators/rk/rk_step_stats.hpp \
          backends/fem/gpu/cuda/fields/field_buffer_state.hpp \
          backends/fem/gpu/cuda/relaxation/bb_exchange_mass.{hpp,cpp} \
          backends/fem/include/frequency_domain/driven_response_solver.hpp \
          backends/fem/src/frequency_domain/driven_response_solver.cpp \
          backends/fem/gpu/frequency_domain/driven_response_cudss* \
          backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.* \
          backends/fem/tests/cuda_shortrange_kernels_contract.cpp \
          backends/fem/tests/frequency_domain/driven_response_cudss_contract.cpp \
          backends/fem/CMakeLists.txt backends/fem/src/api.cpp \
          native/include/fullmag_fem.h crates/fullmag-fem-sys/src/lib.rs
  git commit -m "fem: freeze Wave 3 Phase 0 seams, CMake/API wiring, ABI v13/v14 compat, and skeletons"
  ```

---

## Faza 1 — Author 1: `pgbb-author` (Track 1: P1 #6)

> **Wyłączna własność plików:** `bb_exchange_mass.cpp`, `bb_exchange_mass_kernels.{hpp,cu}`, `pgbb.cpp`, `relaxation_state.hpp`, `rk_step_stats.{cu,cpp}`, `backend_step.cpp`, `cuda_bb_exchange_mass_contract.cpp`, `relaxation_source_contract.cpp`, `crates/fullmag-runner/src/types.rs`, `crates/fullmag-runner/src/relaxation.rs`, `crates/fullmag-runner/src/relaxation/provenance.rs`, `crates/fullmag-runner/src/native_fem.rs`, `crates/fullmag-runner/src/fem/execution.rs`, `crates/fullmag-runner/src/fem/relax/finalize.rs`, `crates/fullmag-runner/src/dispatch.rs`, `crates/fullmag-runner/src/interactive_runtime.rs`, `docs/physics/0581-*`.
> **ZAKAZ dotykania:** `api.cpp`, `CMakeLists.txt`, plików Track 2 (`rk_dmi_*`, `exchange_kernels.*`, `rk_effective_field.*`, `state_io.*`, `stage_compute.*`) ani Track 3 (`frequency_domain/*`, `frequency_response.rs`).

### Zadanie 1: Naprawa 3-składowego kooperatywnego PCG (`D^{-1/2}`, normalizacja $\sigma_c, \tau_c$, limit 2048) i kwalifikacja polityki `auto`

**Files:**
- Modify: `backends/fem/gpu/cuda/relaxation/bb_exchange_mass_kernels.hpp:1-43`
- Modify: `backends/fem/gpu/cuda/relaxation/bb_exchange_mass_kernels.cu:1-245`
- Modify: `backends/fem/gpu/cuda/relaxation/bb_exchange_mass.cpp:1-222`
- Modify: `backends/fem/cpu/mfem/runtime/backend_step.cpp:506-520`
- Test: `backends/fem/tests/cuda_bb_exchange_mass_contract.cpp:1-173`

**Interfaces:**
- Consumes: `GpuBbExchangeMassStatus`, `gpu_bb_exchange_mass_resolve` (Faza 0 `bb_exchange_mass.hpp`).
- Produces: zaktualizowane `GpuBbPcgResult` (`scaled_rhs_norm_squared[3]`, `scaled_residual_norm_squared[3]`, `component_iterations[3]`, `component_status[3]`, `iterations`, `status`), `gpu_bb_exchange_mass_enabled`, `gpu_bb_exchange_mass_resolve`, `gpu_bb_exchange_mass_solve`, `gpu_bb_exchange_mass_solve_and_project`.

- [ ] **Step 1 (TDD — failing tests):** Rozszerz `backends/fem/tests/cuda_bb_exchange_mass_contract.cpp` (**Review Focus #1**):
  - Dodaj `check_planar_extreme_scale_oracle()`: macierz trójdiagonalna w skali SI dla $h = 3\text{ nm}$ ($M_{ii} \approx 2.2\times 10^{-20}\text{ A m}^2$, $K_{ii} \approx 4\times 10^{-20}\text{ J}$, plus wiersz powietrza z $M_{ii} = 0$ regularyzowany do `1.0`), z gradientem o skrajnej dysproporcji składowych: $|g_x| \sim 10^5$, $|g_y| \sim 10^3$, $|g_z| \sim 10^{-130}\text{ A/m}$ (gdzie $b_z \sim 10^{-150} \implies b_z^2 \sim 10^{-300}$, a stare `b_z^2 * 1e-20` wpadało w underflow!). Asercje: `gpu_bb_exchange_mass_solve` zwraca `true`, `gpu_bb_exchange_mass_last_relative_residual <= 1e-8`, wszystkie 3 składowe (włącznie z $z$!) zgadzają się z wyrocznią Thomasa w `long double` do `2e-8` względnie, wiersz powietrza ma dokładnie `0.0`.
  - Dodaj `check_stiff_fine_mesh_iterations()`: siatka z $\lambda (2/\mu_0) K_{ii} / M_{ii} \approx 200$ (wysoka sztywność wymagająca $> 512$ iteracji Jacobi-PCG) — asercja, że zbiega poniżej `2048` iteracji i przechodzi certyfikat $\le 10^{-8}$.
  - Dodaj `check_auto_policy_resolution()`: `policy == 0` (`auto`) z `ctx.exchange.enabled == true` i sfinalizowanymi formami rozwiązuje się do `resolved_enabled == true`, `solver_kind == "cooperative_device_pcg"`; przy `ctx.exchange.enabled == false` rozwiązuje się do `resolved_enabled == false`, `fallback_reason == "exchange_disabled"`; przy `policy == 1` (`none`) $\to$ `resolved_enabled == false`, `fallback_reason == "policy_none"`; przy `policy == 2` (`exchange_mass`) bez form $\to$ twardy błąd `false`.
  - Dodaj `check_solve_and_project_single_sync()`: testuje `gpu_bb_exchange_mass_solve_and_project` (w tym z `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1`), weryfikując `hot_loop_control_scalar_host_sync_count` zwiększony o dokładnie **1** (nie 2!) oraz dokładność `out_direction_dot_gradient == <z_proj, g>_{Ms M_lumped}` do `1e-13`.
- [ ] **Step 2:** Uruchom `ctest -R fem_cuda_bb_exchange_mass_contract` w Docker DEV — oczekiwany FAIL (stare sprzężone CG i `b_z^2` underflow oraz brak nowych funkcji).
- [ ] **Step 3 (Implement):**
  - W `bb_exchange_mass_kernels.{hpp,cu}`: podnieś `kMaximumIterations = 2048`; zmień `inverse_diagonal` na `inv_sqrt_diagonal`; dodaj `reduce_max<3>` i `reduce_sum<6>` z **jednym współdzielonym `__shared__ double shmem[6][kThreads]`** (12 KiB) przekazywanym do pomocników redukcji oraz wskaźnikiem `double *reduced = w.block_sums + 6 * gridDim.x;` (zamiast `4 * gridDim.x` w `:114`); zapewnij brak przedwczesnego `return` omijającego `grid.sync()` w ścieżkach błędów Pass 0 (zapisuj flagę błędu przez redukcję kolektywną i ustawiaj `s.status = 3` w wątku `rank == 0`); zaimplementuj 3 niezależne stany PCG (`rho[3], denom[3], alpha[3], beta[3], component_status[3], component_iterations[3]`) ze skalowaniem $D^{-1/2} A D^{-1/2}$, dwustopniową normalizacją $\sigma_c = \|b_c\|_\infty$, $\tilde{b}_c = D^{-1/2}(b_c/\sigma_c)$, $\tilde{\tau}_c = \|\tilde{b}_c\|_\infty$ oraz $\sigma_c$-skalowanym niezależnym certyfikatem rezyduum liczącym SpMV jako `a.values[j] * (z[col] / sigma_c)` (dzielenie przez $\sigma_c$ PRZED mnożeniem przez $M_{ij}$/$K_{ij}$ dla uniknięcia underflowu subnormalnego!) zgodnie z sekcją 2.2A specyfikacji.
  - W `bb_exchange_mass.cpp`: zaimplementuj `gpu_bb_exchange_mass_resolve` i zaktualizuj `gpu_bb_exchange_mass_enabled(ctx)` by delegowało do `gpu_bb_exchange_mass_resolve`; alokuj `6 * blocks + 6` w `block_sums` oraz mały bufor hostowy pinned/pageable (szanujący `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1`) dla `{GpuBbPcgResult, double dot}`; zaimplementuj `gpu_bb_exchange_mass_solve_and_project(...)` kolejkując PCG + opcjonalną projekcję okresową + `project_tangent_field` + `energy_weighted_dot_blocks` + `device_sum` i wykonując **1×** `cudaStreamSynchronize`.
  - W `backend_step.cpp:506-519`: wywołuj `gpu_bb_exchange_mass_resolve(ctx, bb_status)`; jeśli `policy == 2u` i `!bb_status.resolved_enabled`, zwróć twardy błąd `FULLMAG_FEM_ERR_UNAVAILABLE`; jeśli `bb_status.resolved_enabled`, przygotuj workspace przez `gpu_bb_exchange_mass_prepare`.
- [ ] **Step 4:** Zbuduj i uruchom `fem_cuda_bb_exchange_mass_contract` (normalnie + z `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1`) — oczekiwany PASS.
- [ ] **Step 5:** Commit:
  ```bash
  git add backends/fem/gpu/cuda/relaxation/bb_exchange_mass* \
          backends/fem/cpu/mfem/runtime/backend_step.cpp \
          backends/fem/tests/cuda_bb_exchange_mass_contract.cpp
  git commit -m "fem(gpu): qualify 3-component scaled cooperative PCG and auto policy for bb_exchange_mass"
  ```

---

### Zadanie 2: Usunięcie drugiej redukcji energii i konsolidacja barier w `pgbb.cpp` + `rk_step_stats` + proweniencja i dokumentacja `0581`

**Files:**
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_stats.cu:432-555`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_stats.cpp:75-95`
- Modify: `backends/fem/gpu/cuda/relaxation/relaxation_state.hpp:26-48, 93-103`
- Modify: `backends/fem/gpu/cuda/relaxation/pgbb.cpp:340-456, 543-630, 700-820, 1055-1166`
- Modify: `backends/fem/tests/relaxation_source_contract.cpp:1830-1850, 1952-2010`
- Modify: `crates/fullmag-runner/src/types.rs:3407-3420` (dodać `#[serde(default, skip_serializing_if = "Option::is_none")] pub direction_fallback_reason: Option<String>` do `FemDirectMinimizerPolicyProvenance`)
- Modify: `crates/fullmag-runner/src/native_fem.rs` (dodać metodę `gpu_bb_preconditioner_status(&self)` czytającą z FFI)
- Modify: `crates/fullmag-runner/src/relaxation.rs:25-32` (re-eksport `apply_native_fem_gpu_bb_preconditioner_runtime_provenance`)
- Modify: `crates/fullmag-runner/src/relaxation/provenance.rs:111-165, 212-234, 324-376` (dodać `apply_native_fem_gpu_bb_preconditioner_runtime_provenance`, wzorowane na `apply_native_fem_gpu_demag_linear_solver_provenance`)
- Modify: `crates/fullmag-runner/src/fem/execution.rs:381-395`, `crates/fullmag-runner/src/fem/relax/finalize.rs:400-415`, `crates/fullmag-runner/src/dispatch.rs:3749-3760`, `crates/fullmag-runner/src/interactive_runtime.rs:2448-2460` (wywołanie `apply_native_fem_gpu_bb_preconditioner_runtime_provenance` tam, gdzie istnieje `NativeFemBackend` — uwaga: w `interactive_runtime.rs` w `:2448-2458` po `NativeFemBackend::create(&effective_plan)?`, NIE w `:6833`!)
- Modify: `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md`
- Modify: `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.source-map.json`

**Interfaces:**
- Consumes: `gpu_rk_finalize_step_stats_control_readback_with_scalar_tail_reuse_energy` (Faza 0 `rk_step_stats.hpp`), `fullmag_fem_backend_get_gpu_bb_preconditioner_status` (Faza 0 `api.cpp`), `gpu_bb_exchange_mass_solve_and_project`, `gpu_bb_exchange_mass_resolve` (Zadanie 1).
- Produces: wdrożenie `gpu_rk_finalize_step_stats_control_readback_with_scalar_tail_reuse_energy`, `FemGpuPgbbFieldToken` z cache metryk kroku, runtime-atestowana proweniencja w `types.rs` + `provenance.rs` + 4 miejscach wywołania runnera.

- [ ] **Step 1 (TDD — failing tests):** (**Review Focus #2**)
  - Zaktualizuj `backends/fem/tests/relaxation_source_contract.cpp` w **OBU** blokach (`:1836-1844` oraz `:1975-2005`):
    - W `:1836-1844`: zaktualizuj asercje z `"gpu_relax_compute_accepted_bb_curvature("` i `"accepted curvature scalars device->host"` na `gpu_relax_enqueue_accepted_bb_curvature_and_next_norms` + `kGpuFinalScalarSlots` (zapis wyłącznie w `kGpuFinalScalarSlots + 0..4`, nigdy w `scalar_result + 0..2`).
    - W `:1975-2005`: sprawdź, że ścieżka zaakceptowanego kroku (`pgbb.cpp:1107`, za `capture_gpu_relax_pgbb_rollback_state`) używa `gpu_rk_finalize_step_stats_control_readback_with_scalar_tail_reuse_energy`, że wszystkie 3 rzadkie wczesne wyjścia (`:704`, `:733`, `:994`) zachowują pełne `gpu_rk_finalize_step_stats_control_readback`, że rollback po nieudanej finalizacji lub złej krzywiźnie przywraca metadane + `m_backup` i unieważnia `pgbb_accepted_field`, oraz że `rk_step_stats.cu` pomija `gpu_rk_reduce_final_energy_terms` przy `skip_energy_reduction == true`.
  - Rozszerz testy w `crates/fullmag-runner/src/relaxation/provenance.rs:325-375`: sprawdź rozdział `requested_direction_policy = "auto"` vs `resolved_direction_policy = "device_exchange_mass_preconditioned"` (gdy runtime zgłosił `resolved_enabled = true`) oraz `resolved_direction_policy = "device_tangent_gradient"` + jawny `direction_fallback_reason` (gdy runtime zgłosił `resolved_enabled = false`, np. `"exchange_disabled"`).
- [ ] **Step 2 (Implement):**
  - W `rk_step_stats.cu:432-555` i `rk_step_stats.cpp`: dodaj parametr `bool skip_energy_reduction = false` w `finalize_step_stats_impl` (pomijający wywołanie `gpu_rk_reduce_final_energy_terms` gdy `true`) i wyeksportuj `gpu_rk_finalize_step_stats_control_readback_with_scalar_tail_reuse_energy` (w `rk_step_stats.cpp` pod `#if !FULLMAG_HAS_CUDA_RUNTIME` wyzeruj `tail_scalars[0..tail_count-1]` gdy `tail_scalars != nullptr && tail_count > 0` przed delegacją do `gpu_rk_finalize_step_stats`).
  - W `relaxation_state.hpp`: rozszerz `FemGpuPgbbFieldToken` o `has_cached_metrics`, `cached_total_energy_j`, `cached_energy_terms_j`, `cached_max_torque_apm`, `cached_max_effective_field_amplitude`, `cached_max_demag_field_amplitude`, `cached_gradient_norm_sq`, `cached_projected_gradient_norm_sq`; wyzeruj `has_cached_metrics = false` w `gpu_relax_consume_pgbb_field` i `gpu_relax_invalidate_accepted_evaluation`.
  - W `pgbb.cpp`:
    1. W `gpu_relax_compute_current_metrics`: przy `reused_field == true && cached_token.has_cached_metrics` uruchom wyłącznie `fullmag_cuda_relax_tangent_gradient_and_norm_blocks(..., gradient, ...)` bez redukcji energii/metryk i bez syncu D2H!
    2. Zachowaj pełne `gpu_rk_finalize_step_stats_control_readback` na **wszystkich 3** rzadkich wyjściach bez akceptacji próby Armijo (`:704` potwierdzenie momentu, `:733` zerowy gradient, `:994` `every_permitted_trial_unchanged`).
    3. W bloku preconditionera (`:766-812`): wywołaj `gpu_bb_exchange_mass_solve_and_project` (**1× sync** zamiast 2!) i zapisz `active_descent_dot_gradient` do diagnostyki `:1061`.
    4. Zamień `gpu_relax_compute_accepted_bb_curvature` na bezsynchronizacyjne `gpu_relax_enqueue_accepted_bb_curvature_and_next_norms` piszące `(s·s, s·y, y·y, next_g2, next_pg2)` do `scalar_result + kGpuFinalScalarSlots + 0..4`.
    5. W `:1107`: wywołaj `gpu_rk_finalize_step_stats_control_readback_with_scalar_tail_reuse_energy(ctx, out_stats, tail, 5, reason)` (**1× sync**, bez powtórnej redukcji energii!), potem `gpu_relax_apply_bb_step_size_from_curvature(ctx, tail, reason)` (przy błędzie: `gpu_relax_restore_accepted_step_after_finalize_failure`), a przy `:1160` zapisz w `pgbb_accepted_field` pola z `armijo_result.trial_snapshot.{total_energy_j, terms_j}` + `out_stats.{max_torque_Apm, max_effective_field_amplitude, max_demag_field_amplitude}` + `tail[3..4]`.
  - W `crates/fullmag-runner/src/{types.rs,native_fem.rs,relaxation.rs,relaxation/provenance.rs,fem/execution.rs,fem/relax/finalize.rs,dispatch.rs,interactive_runtime.rs}`: dodaj pole `direction_fallback_reason`, odczyt `gpu_bb_preconditioner_status`, funkcję `apply_native_fem_gpu_bb_preconditioner_runtime_provenance` i podłącz ją we wszystkich 4 punktach (w tym `fem/relax/finalize.rs:404-411` oraz `interactive_runtime.rs:2448-2458`).
  - Zaktualizuj `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.{md,source-map.json}` (zaznaczając, że końcowe wyniki benchmarku RTX 4080 SUPER uzupełni Faza 2).
- [ ] **Step 3:** Uruchom `fem_relaxation_source_contract`, `fem_relaxation_energy_derivative_contract`, `cargo test -p fullmag-runner relaxation::provenance` (linkuje się od razu dzięki Fazie 0!), oraz `validate_scientific_docs.py docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md` — oczekiwany PASS.
- [ ] **Step 4:** Commit:
  ```bash
  git add backends/fem/gpu/cuda/integrators/rk/rk_step_stats.* \
          backends/fem/gpu/cuda/relaxation/relaxation_state.hpp \
          backends/fem/gpu/cuda/relaxation/pgbb.cpp \
          backends/fem/tests/relaxation_source_contract.cpp \
          crates/fullmag-runner/src/types.rs \
          crates/fullmag-runner/src/relaxation.rs \
          crates/fullmag-runner/src/relaxation/provenance.rs \
          crates/fullmag-runner/src/native_fem.rs \
          crates/fullmag-runner/src/fem/execution.rs \
          crates/fullmag-runner/src/fem/relax/finalize.rs \
          crates/fullmag-runner/src/dispatch.rs \
          crates/fullmag-runner/src/interactive_runtime.rs \
          docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.*
  git commit -m "fem(gpu): fuse PGBB syncs, skip redundant energy rereduction, and attest bb_exchange_mass provenance"
  ```

---

## Faza 1 — Author 2: `shortrange-author` (Track 2: P2 #7a)

> **Wyłączna własność plików:** `rk_dmi_fields.cu`, `dmi_kernels.cu`, `rk_anisotropy_field.cu`, `anisotropy_kernels.{hpp,cu}`, `rk_magnetoelastic_field.cu`, `magnetoelastic_kernels.{hpp,cu}`, `rk_thermal_field.cu`, `thermal_kernels.{hpp,cu}`, `field_buffer_memory.cpp`, `regional_field_kernels.cu`, `exchange_kernels.{hpp,cu}`, `rk_exchange_dispatch.{hpp,cu}`, `rk_rhs_runtime.cu`, `vector_field_kernels.{hpp,cu}`, `rk_effective_field.cu`, `rk_oersted_field.{hpp,cu}`, `transfer_kernels.{hpp,cu}`, `component_transfer.{hpp,cpp}`, `gpu_state.{hpp,cpp}`, `state_io.cpp`, `stage_compute.cpp`, `source_facade_cuda_kernels_contract.cpp`, `gpu_state_runtime_contract.cpp`, `state_io_contract.cpp`, `cuda_shortrange_kernels_contract.cpp`, `docs/physics/0999-*`.
> **ZAKAZ dotykania:** `api.cpp`, `CMakeLists.txt`, `relaxation/*`, `rk_step_stats.*`, `frequency_domain/*`.

### Zadanie 3: Bramkowanie pośrednich redukcji RK (DMI, anizotropia, magnetoelastyczność, termika) + leniwe zerowanie `h_drive`

**Files:**
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu:75-95`
- Modify: `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu:1-25, 116-265, 520-560`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_field.cu:65-125`
- Modify: `backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu:15-210`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_magnetoelastic_field.cu:75-100`
- Modify: `backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.cu:15-135`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_thermal_field.cu:60-85`
- Modify: `backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.cu:43-135`
- Modify: `backends/fem/gpu/cuda/fields/field_buffer_memory.cpp:14-60`
- Modify: `backends/fem/gpu/cuda/interactions/zeeman/regional_field_kernels.cu:105-140, 210-272`
- Modify: `backends/fem/tests/cuda_shortrange_kernels_contract.cpp` (szkielet zarejestrowany w CTest w Fazie 0)

**Interfaces:**
- Consumes: `FemGpuFieldBufferDeviceState::h_drive_zeroed` (Faza 0 `field_buffer_state.hpp`, domyślnie `false`).
- Produces: bezpieczne wywołania `nullptr` dla wszystkich 4 rodzin kerneli lokalnych/DMI (w tym wolne od deadlocka `cub::BlockReduce` w DMI) oraz leniwy skip `cudaMemsetAsync` przy `regional_drive_count == 0`.

- [ ] **Step 1 (TDD — failing test):** Wypełnij `backends/fem/tests/cuda_shortrange_kernels_contract.cpp` testami (**Review Focus #3**):
  - `test_null_reduction_outputs_match_field_bitwise`: wywołaj `fullmag_cuda_dmi_field_energy(..., energy_out=nullptr)`, `fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(..., block_sums=nullptr)`, `fullmag_cuda_cubic_anisotropy_field_energy_blocks(..., block_sums=nullptr)`, `fullmag_cuda_magnetoelastic_field_energy_blocks(..., block_sums=nullptr)`, `fullmag_cuda_thermal_field_blocks(..., block_max_sigma=nullptr)` i sprawdź, że pola wyjściowe są **bit-w-bit identyczne** z wywołaniami z niezerowymi buforami redukcji (zero segfaultu na `nullptr`!). Dla `dmi_field_energy` z `energy_out != nullptr` przetestuj siatkę o niepodzielnej przez 256 liczbie czworościanów z mieszanką elementów magnetycznych, powietrza, zdegenerowanego i `elem_d == 0` (bezpośredni test braku deadlocka na `cub::BlockReduce`!) i sprawdź zgodność energii z sumą referencyjną CPU do `1e-13`.
  - `test_regional_drive_lazy_zero_transition`: sprawdź, że świeżo zaalokowany `FemGpuFieldBufferDeviceState` zaczyna z `h_drive_zeroed == false` (wypełnij testowo markerem `h_drive` przed pierwszym wywołaniem i zweryfikuj, że pierwsze wywołanie z `regional_drive_count == 0` wyzeruje bufor i ustawi `h_drive_zeroed = true`), drugie wywołanie pomija `cudaMemsetAsync`, a po przejściu `drive_count > 0 -> 0` (`h_drive_zeroed == false`) jednorazowo zeruje `h_drive.{x,y,z}` i przywraca `h_drive_zeroed == true`.
  - Asercje źródłowe: `rk_dmi_fields.cu`, `rk_anisotropy_field.cu`, `rk_magnetoelastic_field.cu`, `rk_thermal_field.cu` przekazują `nullptr` zamiast `gpu.reductions.scalar_workspace`.
- [ ] **Step 2 (Implement):**
  - W `dmi_kernels.cu`: dodaj `#include <cub/cub.cuh>` na górze pliku; zamień wszystkie **4 wczesne `return;`** w `dmi_element_residual_kernel` (`:141, 144, 156, 167`) na predykat `bool active = ...; double energy = 0.0; if (active) { ... }`, aby wszystkie wątki bloku dochodziły bezwarunkowo do `cub::BlockReduce`; stempletuj `template <bool ComputeEnergy> __global__ void dmi_element_residual_kernel(...)`: dla `ComputeEnergy == false` pomiń energię i atomics; dla `ComputeEnergy == true` użyj `cub::BlockReduce<double, kBlockSize>::Sum(energy)` + 1× `dmi_atomic_add_double(energy_out, block_sum)` w wątku `threadIdx.x == 0`. W `rk_dmi_fields.cu:80` przekaż `nullptr`.
  - W `anisotropy_kernels.cu`, `magnetoelastic_kernels.cu`, `thermal_kernels.cu`: dodaj szablony `template <bool ComputeEnergy>` / `template <bool ComputeMaxSigma>` wybierane po `block_sums != nullptr` / `block_max_sigma != nullptr`; przekaż `nullptr` z `rk_anisotropy_field.cu:72,108`, `rk_magnetoelastic_field.cu:86`, `rk_thermal_field.cu:71`.
  - W `field_buffer_memory.cpp` i `regional_field_kernels.cu`: ustaw `fields.h_drive_zeroed = false` w `gpu_field_buffers_allocate`, `gpu_field_buffers_free` i `gpu_regional_field_drive_destroy`, oraz `true` wyłącznie po rzeczywistym `cudaMemset`/`cudaMemsetAsync` w `gpu_regional_field_drive_upload` (`:130-135`) i `gpu_regional_field_drive_materialize_and_accumulate` (`:219-229`).
- [ ] **Step 3:** Uruchom `ctest -R fem_cuda_shortrange_kernels_contract` w Docker DEV — oczekiwany PASS! Następnie commit:
  ```bash
  git add backends/fem/gpu/cuda/integrators/rk/rk_{dmi,anisotropy,magnetoelastic,thermal}_field*.cu \
          backends/fem/gpu/cuda/interactions/{dmi/dmi,anisotropy/anisotropy,magnetoelastic/magnetoelastic,thermal/thermal,zeeman/regional_field}_kernels.cu \
          backends/fem/gpu/cuda/fields/field_buffer_memory.cpp \
          backends/fem/tests/cuda_shortrange_kernels_contract.cpp
  git commit -m "fem(gpu): gate dead RK intermediate reductions and skip zero-drive memsets"
  ```

---

### Zadanie 4: Rozdział `gpu_relax_dd` w wymianie (szybkie FP64 FMA dla RK vs DD dla relaksacji)

**Files:**
- Modify: `backends/fem/gpu/cuda/exchange/exchange_kernels.hpp:25-106`
- Modify: `backends/fem/gpu/cuda/exchange/exchange_kernels.cu:115-360, 485-545, 655-710`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp:25-35`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_exchange_dispatch.cu:40-218`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu:104-230`
- Test: `backends/fem/tests/cuda_shortrange_kernels_contract.cpp` (rozszerzenie)

**Interfaces:**
- Produces: opcjonalny końcowy parametr `bool compensated_accumulation = true` w `fullmag_cuda_legacy_sparse_exchange`, `fullmag_cuda_legacy_sparse_exchange_xyz`, `fullmag_cuda_periodic_reduced_exchange_xyz` oraz `gpu_rk_compute_legacy_sparse_exchange`.

- [ ] **Step 1 (TDD — failing test):** Rozszerz `cuda_shortrange_kernels_contract.cpp` (**Review Focus #3**):
  - `test_exchange_fast_vs_compensated_parity`: na losowej siatce CSR 3D (w tym teksturze wiru i stanie jednorodnym):
    1. dla jednorodnego `m = (0.6, 0.8, 0.0)`: `compensated=false` daje **dokładnie `0.0`** na każdym węźle (zero dryfu stałego!),
    2. dla tekstury niejednorodnej: `max_i |H_fast[i] - H_dd[i]| / max(1, ||H_dd||_inf) <= 1e-13`,
    3. sprawdź źródłowo, że `rk_rhs_runtime.cu` wywołuje `compensated_accumulation = false` w `gpu_rk_compute_rhs_for_magnetization` / `gpu_rk_compute_effective_field_for_magnetization` oraz `compensated_accumulation = true` w `gpu_rk_compute_effective_field_for_magnetization_fresh_demag` (relaksacja!).
- [ ] **Step 2 (Implement):**
  - W `exchange_kernels.cu`: przekształć `legacy_sparse_exchange_kernel`, `legacy_sparse_exchange_xyz_kernel` oraz `periodic_reduced_exchange_kernel` (`:489-540`, wrapper `fullmag_cuda_periodic_reduced_exchange_xyz` w `:657-705`) w `template <bool Compensated>` z buforowaniem `mx_row/my_row/mz_row` i `fma(weight, mx[col] - mx_row, kx)` dla `Compensated == false`; **nie dotykaj** `exchange_energy_difference_kernel`!
  - W `rk_exchange_dispatch.{hpp,cu}`: przyjmij `bool compensated_accumulation = true` i przekaż do wrapperów wymiany.
  - W `rk_rhs_runtime.cu`: dodaj `bool compensated_exchange` w wewnętrznym `gpu_rk_accumulate_effective_field_for_magnetization`: `false` z ścieżek RK, `true` z `gpu_rk_compute_effective_field_for_magnetization_fresh_demag`.
- [ ] **Step 3:** Commit:
  ```bash
  git add backends/fem/gpu/cuda/exchange/exchange_kernels.* \
          backends/fem/gpu/cuda/integrators/rk/rk_exchange_dispatch.* \
          backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu \
          backends/fem/tests/cuda_shortrange_kernels_contract.cpp
  git commit -m "fem(gpu): use hardware FP64 FMA graph-Laplacian exchange on RK stages while keeping DD for relaxation"
  ```

---

### Zadanie 5: Fuzja sumowania `H_eff` (28$\to$1 launch)

**Files:**
- Modify: `backends/fem/gpu/cuda/fields/vector_field_kernels.hpp`
- Modify: `backends/fem/gpu/cuda/fields/vector_field_kernels.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_oersted_field.hpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_oersted_field.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu`
- Modify: `backends/fem/tests/source_facade_cuda_kernels_contract.cpp:1395-1410, 2005-2012`
- Test: `backends/fem/tests/cuda_shortrange_kernels_contract.cpp` (rozszerzenie)

**Interfaces:**
- Produces: `FemGpuHeffAccumulateTerms`, `fullmag_cuda_accumulate_heff_fused_xyz` (`vector_field_kernels.hpp`); `gpu_rk_prepare_oersted_heff_term` (`rk_oersted_field.hpp`, przy zachowaniu `gpu_rk_accumulate_oersted_field`!).

- [ ] **Step 1 (TDD — failing test):** Rozszerz `cuda_shortrange_kernels_contract.cpp`:
  - `test_fused_heff_bitwise_parity_all_terms`: utwórz 10 niezerowych pól losowych (`h_ex, h_demag, h_ext, h_drive, h_ani, h_cubic, h_dmi, h_bulk_dmi, h_oe_basis` ze skalą `2.75`, `h_mel, h_therm`) dla `N = 1031`; oblicz `h_eff_ref` starą sekwencją 28 kerneli (`accumulate_heff` + `add_field_inplace` + `scale_field`) oraz `h_eff_fused` jednym wywołaniem `fullmag_cuda_accumulate_heff_fused_xyz`. Asercja: **dokładna równość bit-w-bit (`memcmp == 0`)** dla `h_eff.{x,y,z}` ORAZ `h_oe.{x,y,z}`! Przetestuj także podzbiory (np. tylko `h_ex + h_demag`, bez `h_ext`, oraz jawne `h_oe` bez skalowania).
  - Zaktualizuj `source_facade_cuda_kernels_contract.cpp` w **OBU** miejscach: `:1395-1406` (weryfikacja `fullmag_cuda_accumulate_heff_fused_xyz` w `rk_effective_field.cu` oraz delegacja `gpu_rk_prepare_oersted_heff_term` do `rk_oersted_field.cu`) oraz `:2007-2009` (`effective.find("evaluation_time_s, false")` zamiast `"evaluation_time_s, true"`!).
- [ ] **Step 2 (Implement):**
  - W `vector_field_kernels.{hpp,cu}`: dodaj `FemGpuHeffAccumulateTerms` i `fullmag_cuda_accumulate_heff_fused_xyz` zachowujący dokładnie kolejność sumowania z sekcji 3.3 specyfikacji (pozostawiając `fullmag_cuda_accumulate_heff` i `fullmag_cuda_add_field_inplace` dla wstecznej zgodności).
  - W `rk_oersted_field.{hpp,cu}`: dodaj `gpu_rk_prepare_oersted_heff_term` (walidacja + `gpu_rk_oersted_scale` + ustawienie wskaźników `h_oe_src/h_oe_out/h_oe_scale`), **wyraźnie zachowując istniejące `gpu_rk_accumulate_oersted_field`** (100% zgodność z `oersted_contract.cpp:593-595` i `source_facade_cuda_kernels_contract.cpp:1405-1426`!).
  - W `rk_effective_field.cu`: zastąp pętlę 28 wywołań zmontowaniem `FemGpuHeffAccumulateTerms` i pojedynczym `fullmag_cuda_accumulate_heff_fused_xyz` (plus `gpu_regional_field_drive_materialize_and_accumulate(..., accumulate_into_h_eff=false)` przed nim, które przy `regional_drive_count == 0 && h_drive_zeroed` robi 0 operacji!).
- [ ] **Step 3:** Commit:
  ```bash
  git add backends/fem/gpu/cuda/fields/vector_field_kernels.* \
          backends/fem/gpu/cuda/integrators/rk/rk_{effective,oersted}_field.* \
          backends/fem/tests/source_facade_cuda_kernels_contract.cpp \
          backends/fem/tests/cuda_shortrange_kernels_contract.cpp
  git commit -m "fem(gpu): fuse multi-term XYZ H_eff accumulation into a single kernel launch"
  ```

---

### Zadanie 6: Zastąpienie `cudaMemcpy2D` przez device `pack_soa_to_aos` / `unpack_aos_to_soa` + Dokumentacja `0999`

**Files:**
- Modify: `backends/fem/gpu/cuda/transfer/transfer_kernels.hpp`
- Modify: `backends/fem/gpu/cuda/transfer/transfer_kernels.cu`
- Modify: `backends/fem/gpu/cuda/transfer/component_transfer.hpp`
- Modify: `backends/fem/gpu/cuda/transfer/component_transfer.cpp`
- Modify: `backends/fem/gpu/cuda/state/gpu_state.hpp`
- Modify: `backends/fem/gpu/cuda/state/gpu_state.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/state_io.cpp:85-105, 301-317, 415-435, 568-635` (`copy_torque_observable_f64`, `context_sync_gpu_magnetization_to_host`, `context_copy_field_f64`, `context_copy_linearization_field_f64` w `:573`, `context_upload_magnetization_f64` w `:600,627`)
- Modify: `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp:800-820`
- Modify: `backends/fem/tests/gpu_state_runtime_contract.cpp:285-375`
- Modify: `backends/fem/tests/state_io_contract.cpp`
- Test: `backends/fem/tests/cuda_shortrange_kernels_contract.cpp` (rozszerzenie)
- Create: `docs/physics/0999-fem-gpu-short-range-kernel-optimizations.md`
- Create: `docs/physics/0999-fem-gpu-short-range-kernel-optimizations.source-map.json`

**Interfaces:**
- Produces: `fullmag_cuda_unpack_aos_to_soa` (`transfer_kernels.hpp`), `gpu_component_upload_aos_packed` (`component_transfer.hpp`), `gpu_state_download_magnetization_aos_packed`, `gpu_state_upload_magnetization_aos_packed` (`gpu_state.hpp`, przy zachowaniu delegacji istniejących `gpu_state_{upload,download}_magnetization_aos` do `gpu_magnetization_*`!).

- [ ] **Step 1 (TDD — failing tests):** (**Review Focus #4**)
  - Rozszerz `cuda_shortrange_kernels_contract.cpp`: `test_packed_upload_download_roundtrip` dla `N ∈ {1, 3, 257, 1031}`: sprawdź, że `gpu_component_upload_aos_packed` + `gpu_component_download_aos_packed` na niezerowym `stream` daje **bit-w-bit identyczną tablicę AoS**, odrzuca `raw_stream == nullptr` i dokładnie księguje `h2d_bytes == d2h_bytes == 3 * N * sizeof(double)`.
  - Dodaj asercje źródłowe w `state_io_contract.cpp` i `cuda_shortrange_kernels_contract.cpp`: `state_io.cpp` (w `:91, :308, :421, :573` i `context_upload_magnetization_f64` `:627`) oraz `stage_compute.cpp:812` wywołują warianty `*_aos_packed` na `compute_stream`/`raw_stream`, a `stage_compute.cpp` nie robi zbędnego `cudaStreamSynchronize(stream)` przed `gpu_state_download_component_aos_packed`.
- [ ] **Step 2 (Implement):**
  - W `transfer_kernels.{hpp,cu}`: zaimplementuj `unpack_aos_to_soa_kernel` i `fullmag_cuda_unpack_aos_to_soa` (wymagające `stream != nullptr` i niepustych wskaźników).
  - W `component_transfer.{hpp,cpp}` i `gpu_state.{hpp,cpp}`: zaimplementuj `gpu_component_upload_aos_packed`, `gpu_state_download_magnetization_aos_packed` i `gpu_state_upload_magnetization_aos_packed` współdzielące `state.packed_field_download.aos_device` (0 B dodatkowego VRAM!), zachowując istniejące `gpu_state_{upload,download}_magnetization_aos` delegujące do `gpu_magnetization_*`.
  - W `state_io.cpp` i `stage_compute.cpp:800-820`: przełącz wszystkie 6 ścieżek (`:91, :308, :421, :573, :627` i `stage_compute.cpp:812`) na warianty `*_aos_packed` (z czystym fallbackiem do dotychczasowej ścieżki tylko gdy `compute_stream == nullptr` w testach jednostkowych).
  - Utwórz pełną 15-sekcyjną notę `docs/physics/0999-fem-gpu-short-range-kernel-optimizations.{md,source-map.json}`.
- [ ] **Step 3:** Zweryfikuj `validate_scientific_docs.py docs/physics/0999-fem-gpu-short-range-kernel-optimizations.md` oraz testy `fem_cuda_shortrange_kernels_contract`, `fem_state_io_contract`, `fem_gpu_state_runtime_contract`, `fem_source_facade_cuda_kernels_contract`, `fem_oersted_contract` — oczekiwany PASS!
- [ ] **Step 4:** Commit:
  ```bash
  git add backends/fem/gpu/cuda/transfer/{transfer_kernels,component_transfer}.* \
          backends/fem/gpu/cuda/state/gpu_state.* \
          backends/fem/cpu/mfem/runtime/state_io.cpp \
          backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp \
          backends/fem/tests/{gpu_state_runtime,state_io,cuda_shortrange_kernels}_contract.cpp \
          docs/physics/0999-fem-gpu-short-range-kernel-optimizations.*
  git commit -m "fem(gpu): replace strided cudaMemcpy2D paths with device AoS/SoA pack-unpack and add note 0999"
  ```

---

## Faza 1 — Author 3: `dr-cudss-author` (Track 3: P2 #7b)

> **Wyłączna własność plików:** `backends/fem/gpu/frequency_domain/driven_response_cudss.{hpp,cpp}`, `backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu`, `backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.{hpp,cpp}`, `backends/fem/src/frequency_domain/driven_response_solver.cpp`, `backends/fem/tests/frequency_domain/driven_response_cudss_contract.cpp`, `crates/fullmag-ir/src/study.rs`, `crates/fullmag-runner/src/frequency_response.rs`, `crates/fullmag-runner/src/native_fem/frequency_domain.rs`, `packages/fullmag-py/src/fullmag/model/study.py`, `packages/fullmag-py/tests/test_api.py`, `docs/physics/1000-*`.
> **ZAKAZ dotykania:** `api.cpp`, `CMakeLists.txt`, `relaxation/*`, `integrators/rk/*`, `exchange/*`, `transfer/*`, `state_io.cpp`, `stage_compute.cpp`.

### Zadanie 7: Silnik `CudssDrivenResponseSolver` (1× analiza symboliczna, ekwilibracja Ruiza, aktualizacja per-$\omega_k$, certyfikacja $(r_q, r_\phi)$) + eksporter CSR demag

**Files:**
- Modify (szkielety utworzone i zarejestrowane w CMake w Fazie 0): `backends/fem/gpu/frequency_domain/driven_response_cudss.hpp`
- Modify: `backends/fem/gpu/frequency_domain/driven_response_cudss.cpp`
- Modify: `backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu`
- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.hpp`
- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.cpp`
- Modify: `backends/fem/tests/frequency_domain/driven_response_cudss_contract.cpp`

**Interfaces:**
- Consumes: `DrivenFrequencyResponseSolveRequest`, `DrivenFrequencyResponseDemagSparseBlocks`, `DrivenFrequencyResponseGpuDirectPolicy` (Faza 0 `driven_response_solver.hpp`), `fullmag_fem_demag_poisson_sparse_blocks` (Faza 0 `fullmag_fem.h`).
- Produces:
  - `driven_response_cudss.hpp`: `DrivenResponseCudssOutcome` (`status`, `used_cudss`, `fallback_to_krylov`, `fallback_reason`, `symbolic_analysis_count`, `numeric_factorization_count`, `estimated_peak_device_bytes`, `device_budget_bytes`, `max_magnetic_relative_residual_l2`, `max_poisson_relative_residual_l2`, `completed_frequency_count`, `error_message`), `solve_driven_response_gpu_cudss(const DrivenFrequencyResponseSolveRequest &request, const double *drive_real, const double *drive_imag, double *out_response_real, double *out_response_imag, double *out_residual_l2, double *out_relative_residual_l2, double *out_delta_phi_full_real_opt, double *out_delta_phi_full_imag_opt, double *out_h_demag_real_opt, double *out_h_demag_imag_opt, DrivenResponseCudssOutcome *out_outcome) noexcept`.
  - `demag_poisson_sparse_export.hpp`: `export_demag_poisson_sparse_blocks(const Context &ctx, fullmag_fem_demag_poisson_sparse_blocks &out_blocks, std::string &error)` oraz `destroy_demag_poisson_sparse_blocks(fullmag_fem_demag_poisson_sparse_blocks &blocks) noexcept` (już podłączone w `api.cpp` w Fazie 0!).

- [ ] **Step 1 (TDD — failing tests):** Wypełnij `backends/fem/tests/frequency_domain/driven_response_cudss_contract.cpp` (**Review Focus #5**):
  - `test_no_demag_sweep_parity_and_single_analysis`: mała siatka 3D z wymianą + Zeemanem + anizotropią jednoosiową + DMI ($\alpha = 0.02$), przemiatanie 10 częstotliwości w tym przypadek z zerowymi wpisami bazowymi w blokach diagonalnych $K_{jj}$: porównaj wynik `solve_driven_response_gpu_cudss` z gęstą/GMRES referencją CPU (`max rel L2 error < 1e-10`), sprawdź `symbolic_analysis_count == 1`, `numeric_factorization_count == 10`, `max_magnetic_relative_residual_l2 <= 1e-10`.
  - `test_coupled_airbox_demag_sweep_parity_and_ess_tdofs`: układ sprzężony $(N_q, N_\phi)$ z $10^{20}$ różnicą skal między blokiem magnetycznym ($10^{11}$) a blokiem Poissona ($10^{-8}$) oraz niezerowymi wierszami Dirichleta `ess_tdofs`: sprawdź, że wiersze `ess_tdofs` w $-R_{\phi q}$ są wyzerowane ($\delta\hat{\phi}_r = 0$), ekwilibracja Ruiza daje parytet `< 1e-10` z eliminacją Schura $K_{\text{loc}} + K_{q\phi} P^{-1} R_{\phi q} - i\omega M$ oraz niezależny nieskalowany certyfikat obu bloków `r_q <= 1e-10` i `r_phi <= 1e-10`.
  - `test_divergence_free_mode_poisson_residual_certificate`: mod bezdywergencyjny ($\|R_{\phi q}\hat{q}\|_2 = 0$, $\delta\hat{\phi} \approx 0$ z szumem numerycznym $10^{-16}$) przechodzi certyfikat `r_phi <= max(rtol * max(||R_{phi q} q||_2, ||P delta_phi||_2), atol_phi)` bez fałszywego odrzucenia!
  - `test_vram_budget_guard_auto_vs_required_and_bad_env`:
    - `FULLMAG_FEM_DRIVEN_CUDSS_BUDGET_BYTES=1` pod `Auto` $\implies$ `fallback_to_krylov == true`, `fallback_reason == "cudss_peak_memory_budget_exceeded"`, `numeric_factorization_count == 0`!
    - `FULLMAG_FEM_DRIVEN_CUDSS_BUDGET_BYTES=1` pod `Required` $\implies$ `status == unavailable`, `fallback_to_krylov == false`!
    - `FULLMAG_FEM_DRIVEN_CUDSS_MAX_VRAM_MIB="0"` / `"-5"` / `"abc"` pod `Auto` $\implies$ twardy błąd `validation_error` (zero fallbacku!).
  - `test_singular_undamped_resonance_hard_error_under_auto`: układ z $\alpha = 0$ dokładnie na częstotliwości własnej $\omega_k = \omega_n$ $\implies$ `CUDSS_DATA_INFO != 0` zwraca twardy błąd `solve_error` **również pod `Auto`** (zero cichego fallbacku!).
  - `test_static_periodic_k0_lifting_h_demag_and_floquet_rejection`: statycznie okresowy układ $k=0$ daje parytet `< 1e-10` z CPU GMRES oraz poprawnie podnosi $\delta\hat{\phi}_{\text{red}} \to \delta\hat{\phi}_{\text{full}}$ i wyznacza $\delta\hat{H}_{\text{demag}} = G_{\text{rec}}\delta\hat{\phi}_{\text{red}}$; niezerowe $k$ `floquet_airbox` z demag zwraca `fallback_to_krylov == true` (`"floquet_nonzero_k_demag_unsupported"`) pod `Auto` i `unavailable` pod `Required`.
- [ ] **Step 2 (Implement):**
  - W `driven_response_cudss_kernels.cu`: zaimplementuj `driven_response_update_omega_entries_kernel` (aktualizuje $4 N_{m,\text{eff}}$ wpisów `double2` dla $\omega_k$) oraz `driven_response_unscaled_residual_norm_kernel` (wieloblokowa redukcja Blue/LAPACK `ScaledNorm` licząca na GPU nieskalowane $\|r_q\|_2, \|\hat{f}\|_2, \|\hat{q}\|_2, \|r_\phi\|_2, \|R_{\phi q}\hat{q}\|_2, \|P\delta\hat{\phi}\|_2, \|\delta\hat{\phi}\|_2$ z użyciem $D_r^{-1}(\tilde{Z}y - \tilde{b})$ bez duplikacji CSR oraz kopiująca odskalowane $\hat{q}_j = D_{c,j} y_j$ i $\delta\hat{\phi}$ z detekcją `NaN/Inf`).
  - W `driven_response_cudss.cpp`:
    - Pełna osłona `#if FULLMAG_FEM_CUDSS_DRIVEN_ENABLED && FULLMAG_HAS_CUDA_RUNTIME` (w `#else` zwraca `fallback_to_krylov = true, fallback_reason = "cudss_unavailable"` dla `Auto` oraz `unavailable` dla `Required`).
    - Zaimplementuj montaż posortowanego 0-bazowego `DrivenResponseAugmentedCsr` (wymiana + Zeeman + anizotropia + DMI + opcjonalne sprzężenie demag $(K_{q\phi}, -R_{\phi q}, P)$ z jawnym zerowaniem wierszy `ess_tdofs` w $-R_{\phi q}$ + opcjonalna statyczna redukcja okresowa $k=0$, z jawną rezerwacją $4 N_{m,\text{eff}}$ slotów diagonalnych).
    - Zaimplementuj 6-przebiegową ekwilibrację Ruiza $(D_r, D_c)$ dla $|Z_{\text{aug}}(\omega_{\text{ref}})|$.
    - Zaimplementuj cykl życia `cuDSS` (`CUDSS_MTYPE_GENERAL`, `CUDSS_MVIEW_FULL`, `CUDSS_C_64F`, `IR_N_STEPS = 1`, jednorazowy `CUDSS_PHASE_ANALYSIS`, preflight `CUDSS_DATA_MEMORY_ESTIMATES` z obsługą `FULLMAG_FEM_DRIVEN_CUDSS_BUDGET_BYTES` i `FULLMAG_FEM_DRIVEN_CUDSS_MAX_VRAM_MIB`, a w pętli po $\omega_k$: `cancel_requested` $\to$ `update_omega_entries_kernel` $\to$ `CUDSS_PHASE_FACTORIZATION` $\to$ test `CUDSS_DATA_INFO == 0` $\to$ `CUDSS_PHASE_SOLVE` $\to$ certyfikacja rezyduum na GPU ze skalowanym `atol_phi` $\to$ odczyt $\hat{q}$, podniesienie $\delta\hat{\phi}_{\text{red}} \to \delta\hat{\phi}_{\text{full}}$ przez `periodic_reduced_node` i wyliczenie $\delta\hat{H}_{\text{demag}} = G_{\text{rec}} \delta\hat{\phi}_{\text{red}}$ gdy żądane, oraz callback `progress_callback`).
  - W `demag_poisson_sparse_export.{hpp,cpp}`: pod `#if FULLMAG_HAS_MFEM_STACK` zaimplementuj jednorazowy eksport CSR `(P, rhs_{x,y,z}, recovery_{x,y,z}, ess_tdofs, magnetic_node_indices, periodic_reduced_node)` bezpośrednio z `ctx.poisson_demag`, pobierając $P$ z **`ctx.poisson_demag.periodic_reduced_ready ? ctx.poisson_demag.periodic_matrix : ctx.poisson_demag.poisson_bc_op`** (identycznie jak `operators.cpp:615-618` i `demag_poisson_boundary.cpp:202,240`) oraz **jawnie zerując wszystkie wiersze $r \in \text{ess\_tdofs}$ w `rhs_{x,y,z}`**! Pod `#else` zwróć `false` z komunikatem o braku MFEM.
- [ ] **Step 3:** Uruchom `ctest -R fem_driven_response_cudss_contract` w Docker DEV — oczekiwany PASS! Następnie commit:
  ```bash
  git add backends/fem/gpu/frequency_domain/driven_response_cudss* \
          backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.* \
          backends/fem/tests/frequency_domain/driven_response_cudss_contract.cpp
  git commit -m "fem(gpu): implement factor-once cuDSS driven-response solver and Poisson CSR exporter"
  ```

---

### Zadanie 8: Integracja w `driven_response_solver.cpp`, Rust IR/Runner (`gpu_sparse_direct`), Python API i Dokumentacja `1000`

**Files:**
- Modify: `backends/fem/src/frequency_domain/driven_response_solver.cpp:11950-12475, 13535-14100` *(4-miejscowy walidator ABI v13/v14 już zamrożony w Fazie 0!)*
- Modify: `crates/fullmag-ir/src/study.rs:1670-1690`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs:1610-1695`
- Modify: `crates/fullmag-runner/src/frequency_response.rs:155-268, 1955-2100`
- Modify: `packages/fullmag-py/src/fullmag/model/study.py:95-115`
- Modify: `packages/fullmag-py/tests/test_api.py` (rozszerzenie testu `solver_method` o `"gpu_sparse_direct"`)
- Create: `docs/physics/1000-fem-gpu-driven-response-cudss.md`
- Create: `docs/physics/1000-fem-gpu-driven-response-cudss.source-map.json`

**Interfaces:**
- Consumes: `solve_driven_response_gpu_cudss` (Zadanie 7), ABI v14 pola `gpu_direct_policy` i `demag_sparse_blocks` oraz `fullmag_fem_frequency_domain_solve_driven_response_v14` (Faza 0).
- Produces: pełna ścieżka end-to-end Python $\to$ IR $\to$ Runner $\to$ C ABI $\to$ `driven_response_solver.cpp` $\to$ `cuDSS` z kompletną proweniencją JSON i jawnym fallbackiem pod `auto`.

- [ ] **Step 1 (TDD — failing tests):** (**Review Focus #5**)
  - Dodaj testy jednostkowe w `crates/fullmag-runner/src/frequency_response.rs`:
    1. `frequency_response_solver_method_policy_accepts_gpu_sparse_direct_only_on_gpu`: akceptuje `GpuSparseDirect` dla `ExecutionDevice::Gpu`, odrzuca dla `ExecutionDevice::Cpu` z `"solver_method=gpu_sparse_direct requires requested device gpu"`.
    2. `frequency_response_diagnostics_preserve_cudss_and_auto_fallback_provenance`: sprawdza serializację `requested_solver_method = "auto"`, `resolved_solver_method = "gpu_sparse_direct_cudss"` vs `"gpu_operator_host_krylov"` + `solver_fallback_reason`, przy zachowaniu pełnej zgodności istniejących testów `frequency_response.rs:5476-5513` gdy pole `resolved_solver_method` nie występuje w syntetycznym JSON!
  - Dodaj test w `packages/fullmag-py/tests/test_api.py`: `solver_method="gpu_sparse_direct"` poprawnie eksportuje się do `ProblemIR` i przechodzi round-trip skryptu.
- [ ] **Step 2 (Implement):**
  - W `driven_response_solver.cpp`:
    - Powiększ bufor `char diagnostics_json[1400]{}` w `:12394` do `char diagnostics_json[4096]{}` (lub `std::string`), aby dodatkowe pola `cuDSS` / fallbacku nigdy nie wywoływały błędu obcięcia `artifact_error` w `:12467`!
    - W `solve_mfem_production_gpu_problem` (`:12215`) oraz w `solve_periodic_airbox_dynamic_demag_mfem_phi_consistency_schur` (`:13540-13610`, dla `execution_lane == production_gpu && !requires_floquet_airbox_dynamic_demag`): jeśli `gpu_direct_policy != Disabled`, wywołaj `solve_driven_response_gpu_cudss(...)` (dla `periodic_airbox_k0` odbierając podniesione $\delta\hat{\phi}_{\text{full}}$ i $\delta\hat{H}_{\text{demag}} = G_{\text{rec}}\delta\hat{\phi}_{\text{red}}$ dla `populate_h_demag_seam_diagnostics`, bez wywołań GMRES ani callbacku!):
      - jeżeli `used_cudss == true` i `status == ok`: opublikuj artefakty punktów częstotliwości i JSON diagnostyki/wyniku z polami `"resolved_solver_method":"gpu_sparse_direct_cudss"`, `"direct_solver_package":"nvidia_cudss"`, `"matrix_type":"general_complex_f64"`, `"symbolic_analysis_count":1`, `"numeric_factorization_count":K`, `"estimated_peak_device_bytes"`, `"device_budget_bytes"`, `"max_magnetic_relative_residual_l2"`, `"max_poisson_relative_residual_l2"`, `"gpu_device_resident_solver":true`!
      - jeżeli `fallback_to_krylov == true` (wyłącznie pod `Auto`!): zapisz `solver_fallback_reason` i kontynuuj istniejącą ścieżką GMRES, dopisując `"requested_solver_method":"auto"`, `"resolved_solver_method":"gpu_operator_host_krylov"`, `"solver_fallback_reason":"..."` do diagnostyki JSON!
      - jeżeli `status != ok` (w tym `Required` poza zakresem/VRAM, `CUDSS_DATA_INFO != 0`, błąd certyfikatu lub `interrupted`): zwróć błąd / przerwanie bez fallbacku!
  - W `crates/fullmag-ir/src/study.rs`, `packages/fullmag-py/src/fullmag/model/study.py`, `crates/fullmag-runner/src/native_fem/frequency_domain.rs`, `crates/fullmag-runner/src/frequency_response.rs`: dodaj `GpuSparseDirect` (`"gpu_sparse_direct"`), mapowanie polityki `Auto`/`Disabled`/`Required`, jednorazowy eksport `demag_sparse_blocks` (RAII guard wywołujący `destroy`) z `NativeBackendDemagTangentProvider`, oraz odczyt faktycznego `resolved_solver_method` i `solver_fallback_reason` z JSON odpowiedzi natywnej (z czystym zachowaniem domyślnej ścieżki w helperze gdy pole jest nieobecne, tak by wszystkie testy `:5476-5513` pozostały zielone!).
  - Utwórz pełną 15-sekcyjną notę `docs/physics/1000-fem-gpu-driven-response-cudss.{md,source-map.json}`.
- [ ] **Step 3:** Zweryfikuj `ctest -R "fem_driven_response_cudss_contract|fem_driven_response_contract|fem_frequency_domain_contract"`, `cargo test -p fullmag-ir`, `cargo test -p fullmag-runner frequency_response` (linkuje się od razu dzięki Fazie 0!), `pytest packages/fullmag-py/tests/test_api.py -k gpu_sparse_direct`, oraz `validate_scientific_docs.py docs/physics/1000-fem-gpu-driven-response-cudss.md` — oczekiwany PASS!
- [ ] **Step 4:** Commit:
  ```bash
  git add backends/fem/src/frequency_domain/driven_response_solver.cpp \
          crates/fullmag-ir/src/study.rs \
          crates/fullmag-runner/src/frequency_response.rs \
          crates/fullmag-runner/src/native_fem/frequency_domain.rs \
          packages/fullmag-py/src/fullmag/model/study.py \
          packages/fullmag-py/tests/test_api.py \
          docs/physics/1000-fem-gpu-driven-response-cudss.*
  git commit -m "fem(gpu): wire cuDSS driven response into solver, ABI v14, Rust IR/runner, Python API, and note 1000"
  ```

---

## Faza 2: Integracja, weryfikacja non-MFEM + GPU w Docker DEV oraz benchmarki A/B

### Zadanie 9: Scalenie 3 gałęzi, porządkowanie `api.cpp:423,431` + `docs/physics/README.md`, pełna weryfikacja i pomiary A/B

> **Właściciel:** Verifier / Coordinator (w jednym worktree integracyjnym `codex/fem-wave3-pgbb-kernels-dr-20261126`). *(Uwaga: `CMakeLists.txt` i 4 forwardery C ABI w `api.cpp` zostały już wpięte w Fazie 0!)*

**Files:**
- Modify (opcjonalny cleanup po scaleniu Track 2): `backends/fem/src/api.cpp:420-436` (usunięcie zbędnego `cudaStreamSynchronize` w `:423` w `device_apply_demag_tangent_with_potential` i przełączenie `:431` na `gpu_state_download_component_aos_packed`)
- Modify: `docs/physics/README.md` (wpisy dla `0999` i `1000`)
- Modify (po pomiarach A/B): `docs/physics/{0581,0999,1000}-*.{md,source-map.json}` (wpisanie zmierzonych wyników A/B z RTX 4080 SUPER i zmiana statusu kwalifikacji)

**Interfaces:**
- Consumes: commity Fazy 1 od `pgbb-author`, `shortrange-author` i `dr-cudss-author` (wszystkie rozgałęzione z Fazy 0, zero konfliktów!).
- Produces: w pełni zintegrowany, przetestowany i zmierzony PR gotowy do pushu i CI.

- [ ] **Step 1 (Merge & Polish):** Scal 3 bezkonfliktowe gałęzie Fazy 1 na wspólną gałąź integracyjną; zastosuj porządkowanie `api.cpp:423,431` i wpisz `0999`/`1000` do `docs/physics/README.md`. Sprawdź `git diff --check` (0 błędów).
- [ ] **Step 2 (Weryfikacja builda non-MFEM — symulacja CI `bootstrap / native-modal-cabi-contract`):**
  Zbuduj i uruchom w Docker DEV z `-DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_ENABLE_CUDA=OFF`:
  ```bash
  ctest --output-on-failure -R "fem_modal_eigen_contract|fem_driven_response_contract|fem_relaxation_source_contract"
  ```
  Oczekiwany wynik: **0 błędów kompilacji/linkowania** (`driven_response_cudss.cpp` i `demag_poisson_sparse_export.cpp` w bezwarunkowym `FEM_SOURCES`!) i 100% PASS.
- [ ] **Step 3 (Pełna weryfikacja GPU w Docker DEV — CTest + Cargo + Pytest):**
  Zbuduj pełny stack CUDA/MFEM/HYPRE/cuDSS w `just docker-dev` i uruchom:
  - CTest:
    - `fem_cuda_bb_exchange_mass_contract` (normalnie + `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1`)
    - `fem_relaxation_source_contract`, `fem_relaxation_energy_derivative_contract`
    - `fem_cuda_shortrange_kernels_contract`, `fem_source_facade_cuda_kernels_contract`, `fem_oersted_contract`, `fem_gpu_state_runtime_contract`, `fem_state_io_contract`, `fem_exchange_contract`
    - `fem_driven_response_cudss_contract`, `fem_driven_response_contract`, `fem_frequency_domain_contract`
    - regresje P0: `fem_cudss_poisson_budget_contract`, `fem_cuda_rk_heun_rk4_fsal_predictor_contract`, `fem_demag_fem_bem_gpu_contract`, `fem_gpu_strict_execution_contract`
  - Cargo: `cargo test -p fullmag-fem-sys`, `cargo test -p fullmag-ir`, `cargo test -p fullmag-plan`, `cargo test -p fullmag-runner --features fem-gpu` (testy PGBB, RK parity i `frequency_response`).
  - Pytest: `pytest packages/fullmag-py/tests/test_fem_gpu_bb_preconditioner.py packages/fullmag-py/tests/test_api.py -k "bb_preconditioner or gpu_sparse_direct"`.
  - Kontrakty dokumentacji i spójności repo:
    - `python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md docs/physics/0999-fem-gpu-short-range-kernel-optimizations.md docs/physics/1000-fem-gpu-driven-response-cudss.md`
    - `python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py --base origin/master --head HEAD`
    - `python3 scripts/check_repo_consistency.py`
- [ ] **Step 4 (Benchmarki A/B na RTX 4080 SUPER — `origin/master` `9ab99132d5` vs Wave 3):**
  Wykonaj 3 powtarzalne benchmarki A/B ze Sekcji 7 specyfikacji:
  1. SP4 fine-mesh PGBB ($h = 3\text{ nm}$ i $h = 2\text{ nm}$): `policy="none"` przed vs po (barier/krok 6$\to$3, 0 powtórnej redukcji energii, bit-w-bit) oraz `policy="auto"`/`"exchange_mass"` (redukcja kroków $\ge 2\times$, zgodność energii $\le 10^{-7}$ vs CPU PGBB).
  2. Mikro-timing etapów RK4 (20k–50k węzłów, exchange + DMI + anisotropy + MEL + `regional_drive_count=0`, 50 kroków + 10 poborów `state_io`): zmierz przyspieszenie exchange, DMI, `H_eff`, `state_io` i potwierdź parytet `< 1e-13`.
  3. Driven Response 25-punktowe przemiatanie RF ($1\text{–}25\text{ GHz}$, open-airbox `poisson_robin` + `periodic_airbox_k0`): zmierz wall-time CPU GMRES vs GPU operator+GMRES vs GPU `cuDSS` (cel $\ge 10\times$), potwierdź `symbolic_analysis_count == 1` i parytet `< 1e-8` (typowo `< 1e-10`).
- [ ] **Step 5 (Publikacja wyników i finalny commit):** Zapisz zmierzone liczby A/B w `docs/physics/{0581,0999,1000}` (wraz ze zaktualizowanymi `.source-map.json`), ponów walidatory dokumentacji, commituj i wypchnij gałąź PR:
  ```bash
  git commit -m "fem(gpu): finalize Wave 3 integration and record RTX 4080 SUPER A/B results"
  ```
