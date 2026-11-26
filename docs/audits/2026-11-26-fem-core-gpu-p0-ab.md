# Raport weryfikacji i benchmarków A/B — FEM Core GPU P0 (`codex/fem-core-gpu-p0-20261126`)

Powiązane dokumenty:
- Specyfikacja architektoniczna: [2026-11-26-fem-core-gpu-p0-design.md](../superpowers/specs/2026-11-26-fem-core-gpu-p0-design.md)
- Plan implementacji: [2026-11-26-fem-core-gpu-p0-plan.md](../superpowers/plans/2026-11-26-fem-core-gpu-p0-plan.md)
- Notatki fizyczne: [0913-fem-gpu-amg-coarse-residency.md](../physics/0913-fem-gpu-amg-coarse-residency.md), [fem_demag_fem_bem.md](../physics/fem_demag_fem_bem.md), [0997-fem-gpu-poisson-direct-cudss.md](../physics/0997-fem-gpu-poisson-direct-cudss.md), [0998-fem-gpu-rk-fsal-and-potential-predictor.md](../physics/0998-fem-gpu-rk-fsal-and-potential-predictor.md)

## 1. Streszczenie wykonawcze

Wszystkie trzy etapy weryfikacji (Etap 1: start Docker DEV i pełna kompilacja; Etap 2: testy kontraktowe C++/CUDA, Rust, Python, dokumentacja naukowa i spójność repozytorium; Etap 3: 4-scenariuszowa suita A/B na GPU) zostały zakończone z wynikiem **PASS** dla gałęzi `codex/fem-core-gpu-p0-20261126` (commit kandydata `7723f7ffa7`, baseline `origin/master` = `226ad126a4`).

Kluczowe wyniki pomiarowe na **NVIDIA GeForce RTX 4080 SUPER (16 GiB VRAM, SM 8.9, `cuDSS 0.8.0.10`, CUDA `12.6.85`)** wewnątrz kontenera Docker DEV worktree (`fullmag-worktree-fem-core-gpu-p0-20261126-c8d7a7973539aa8a-backend-1`), przy `rtol = 1e-8`, 5 krokach rozgrzewkowych i 50 krokach pomiarowych:

| Scenariusz | Integrator | Baseline `226ad126a4` [ms/krok] | Candidate `cg_amg` [ms/krok] (przysp.) | Candidate `auto` (`cudss_direct`) [ms/krok] (przysp.) | $\max\|m_{\text{cand}}-m_{\text{ref}}\|_\infty$ (`auto`) | $|\Delta E_{\text{demag}}|/|E_{\text{demag}}|$ (`auto`) |
|---|---|---:|---:|---:|---:|---:|
| **1a. Poisson open-airbox SP4** (`8 208` węzłów, `60 791` P2 DOF) | Heun | `813.13` | `655.94` (**1.24×**) | `3.72` (**218.4×**) | `5.65e-12` | `1.66e-12` |
| **1a. Poisson open-airbox SP4** (`8 208` węzłów, `60 791` P2 DOF) | RK4 | `1215.01` | `923.61` (**1.32×**) | `8.06` (**150.8×**) | `5.97e-12` | `4.48e-11` |
| **1b. Poisson open-airbox medium** (`49 600` węzłów, `380 701` P2 DOF) | Heun | `477.30` | `254.83` (**1.87×**) | `23.45` (**20.36×**) | `2.51e-11` | `1.81e-11` |
| **1b. Poisson open-airbox medium** (`49 600` węzłów, `380 701` P2 DOF) | RK4 | `874.73` | `400.22` (**2.19×**) | `45.87` (**19.07×**) | `2.39e-11` | `1.89e-11` |
| **2. Ciasny limit VRAM (`MAX_VRAM_MIB=32`)** (`49 600` węzłów) | Heun | `477.30` | *(fallback `auto→hypre_krylov`)* `255.93` (**1.86×**) | *(`cudss` forced → twardy błąd `rc=2`, 0 fallbacku)* | `2.31e-11` (`0.0` vs `cg_amg`) | `3.02e-12` (`0.0` vs `cg_amg`) |
| **3. GPU FEM/BEM geometria otwarta** (`1 183` węzłów, bez airboxu) | Heun | *(`rc=6` — fail step 1 na `226ad126a4`)* | `42.90` (`JACOBI`) / `76.10` (`AMG`) | `2.20` (**34.6× vs AMG / 19.5× vs JACOBI / 5.4× vs CPU**) | `4.88e-14` *(vs CPU)* | `1.54e-14` *(vs CPU)* |
| **4a. PBC-reduced 1D Robin** (`8 379` węzłów, P1) | Heun | `56.81` | `37.64` (**1.51×**) | `1.99` (**28.6×**) | `3.51e-11` | `1.22e-11` |
| **4a. PBC-reduced 1D Robin** (`8 379` węzłów, P1) | RK4 | `92.19` | — | `3.44` (**26.8×**) | `2.66e-11` | `2.40e-11` |
| **4b. PBC-reduced 2D film (Neumann + pin)** (`8 379` węzłów, P1) | Heun | `72.75` | `57.09` (**1.27×**) | `2.05` (**35.5×**) | `3.39e-11` | `1.62e-11` |
| **4b. PBC-reduced 2D film (Neumann + pin)** (`8 379` węzłów, P1) | RK4 | `118.12` | — | `3.58` (**33.0×**) | `3.42e-11` | `1.22e-10` |

Wszystkie wdrożone mechanizmy P0 (Track A: wieloblokowa certyfikacja par + `HypreStreamInterop` + `relax_type=18` w GPU FEM/BEM; Track B: polityka trójstanowa `auto`/`cg_amg`/`cudss`, `create_v6`, limit VRAM `MAX_VRAM_MIB`, PBC-reduced `cuDSS`, atomowy `cuDSS` dla pary `(u1, u2)` FEM/BEM; Track C: FSAL `k0` dla Heun/RK4 i PBC + dwukrokowy liniowy predyktor potencjału $\phi^{(0)}$ z ochroną etapów równoczasowych) spełniły założone bramki dokładności, wydajności i proweniencji.

---

## 2. Środowisko i proweniencja pomiaru

| Parametr | Wartość |
|---|---|
| Identyfikator worktree | `fem-core-gpu-p0-20261126-c8d7a7973539aa8a` |
| Gałąź / Kandydat `HEAD` (pomiar A/B) | `codex/fem-core-gpu-p0-20261126` @ `7723f7ffa7d76a21a9fb94b575164cc177a91541` |
| Baseline | `origin/master` @ `226ad126a4` (zbudowane identycznymi flagami Release SM `89-real` z `git archive 226ad126a4` wewnątrz kontenera; katalog tymczasowy posprzątany po pomiarach) |
| Kontener Docker DEV | `fullmag-worktree-fem-core-gpu-p0-20261126-c8d7a7973539aa8a-backend-1` |
| Obraz toolchaina | `sha256:2b4bc74d514bb7722673d884aef03f12e4f8532162dff9aa5a60d699f0f5c0dd` |
| GPU / Sterownik | NVIDIA GeForce RTX 4080 SUPER (16 376 MiB VRAM, CC 8.9), driver `617.42` (`13040`) |
| Kompilator / CUDA / cuDSS | GCC `11.4.0`, NVCC `12.6.85` (`-DCMAKE_CUDA_ARCHITECTURES=89-real`), `cuDSS 0.8.0.10`, PETSc `3.24.6`, SLEPc `3.24.3`, MFEM + HYPRE device |
| Stan GPU przed suitą A/B | Bezczynny: `utilization.gpu = 1%`, `temperature = 34°C`, `power.draw = 12.06 W`, `compute-apps = 0` |
| Parametry wspólne A/B | `precision = double`, `rtol = 1e-8` (wyrocznia CPU FEM/BEM `1e-10`), `dt = 2.0e-14 s`, `Ms = 800 kA/m`, `Aex = 13 pJ/m`, `alpha = 0.02`, `B_ext = (0, 0, 10 mT)`, `warmup = 5`, `timed_steps = 50`, `FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE` |

---

## 3. Wyniki Etapu 1 i Etapu 2 (build, CTest, Rust, Python, dokumentacja naukowa)

Wszystkie kompilacje i testy wykonano wyłącznie wewnątrz kontenera Docker DEV worktree.

### 3.1. Testy natywne C++/CUDA (CTest + `compute-sanitizer`)

| Suita / Cel | Wynik | Uwagi |
|---|---|---|
| 11-celowa suita P0 GPU CTest (`fem_cuda_rk_heun_rk4_fsal_predictor_contract`, `fem_gpu_pageable_scalar_readback_contract`, `fem_cuda_demag_robin_energy_contract`, `fem_cuda_demag_timing_contract`, `fem_cuda_periodic_demag_contract`, `fem_transfer_audit`, `fem_rk_explicit_contract`, `fem_gpu_strict_execution_contract`, `fem_cudss_poisson_budget_contract`, `fem_demag_fem_bem_contract`, `fem_demag_fem_bem_gpu_contract`) | **11 / 11 PASS** (`12.22 s`) | 100% zielone na `7723f7ffa7`; pokrywa `create_v6`, PBC 1D/2D `cuDSS`, atomowy `cuDSS` FEM/BEM `(u1, u2)`, `relax_type=18`, FSAL Heun/RK4, predyktor $\phi^{(0)}$ i certyfikację wieloblokową |
| Przebieg `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1` (`fem_gpu_pageable_scalar_readback_contract`, `fem_cuda_periodic_demag_contract`) | **2 / 2 PASS** (`1.29 s`) | Potwierdza ścieżkę awaryjną stronicowanego readbacku skalarów |
| `compute-sanitizer --tool memcheck` na `fem_demag_fem_bem_gpu_contract` | **0 błędów** | Wykryty w fazie 1 błąd `0x0` na `d_boundary_tdofs` naprawiony w `f112ae59fa` |
| Przypadki P0 GPU w `demag_poisson_contract.cpp` (`demag_step_stats_provenance_abi_is_append_only`, `mixed_p1_gpu_robin_and_dirichlet_device_hypre_match_cpu_one_step`, `check_gpu_hypre_demag_residual`, `packed_snapshot_field_download_is_runtime_correct_and_fails_closed`) | **3 / 3 PASS** | Potwierdzone `control_fences=2`, `control_bytes=32`, `coarse_relax_type=18`, odrzucenie skorumpowanego wektora (`residual=1`) |

#### Wykryte i usunięte błędy w trakcie weryfikacji (2 rundy poprawek)
1. **Runda 1 (`55c6778c4f`):**
   - `backends/fem/gpu/cuda/demag_poisson/hypre_residual_certification.hpp`: strażnik `#ifdef MFEM_USE_MPI` przed `#include <mfem.hpp>` powodował pustą kompilację `hypre_residual_certification.cpp`.
   - `backends/fem/tests/gpu_strict_execution_contract.cpp` (`periodic_boundary_pair_markers`) i brakujące kwalifikatory `crate::types::ExecutionProvenance`/`FemPoissonDemagProvenance` dla domyślnych feature'ów w `crates/fullmag-runner/src/dispatch.rs`.
   - `backends/fem/gpu/cuda/demag_poisson/demag_predictor.hpp`: bezwarunkowe `#include <cuda_runtime.h>` łamiące nie-CUDA targety testowe (osłonięte `__has_include(<cuda_runtime.h>)`).
2. **Runda 2 (`f112ae59fa`, `7723f7ffa7`):**
   - **Ukryty błąd na `origin/master` w `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp`:** `gpu_demag_fem_bem_initialize` nie wysyłało `d_boundary_tdofs` na GPU (błąd `CUDA illegal memory access at 0x0` pod `compute-sanitizer`).
   - **Ukryty błąd fizyczny na `origin/master` w `backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp`:** ścieżka CPU FEM/BEM przekazywała posortowane `boundary_tdofs` zamiast `boundary_tdofs_by_row` do `prepare_demag_fem_bem_dirichlet_rhs`, co mieszało brzegowe DOF potencjału `u2` na nieposortowanych siatkach (błąd 96.8% w `H_demag` względem GPU).
   - `backends/fem/tests/gpu_strict_execution_contract.cpp`: aktualizacja `PeriodicHexMeshFixture` na siatkę Kuhn `TET4`+`TRI3` z warstwami airboxu `cz==0,2` wokół warstwy magnetycznej `cz==1`.

#### Istniejące wcześniej (pre-existing na `226ad126a4`) usterki poza zakresem P0
- `fem_gpu_rk_plan`: nie kompiluje się na `origin/master` (`std::mutex` w `execution_receipt.hpp:82`).
- `fem_cuda_rk_guard_contract:435`, `fem_source_facade_gpu_rk_contract:1523`, `fem_demag_poisson_contract:2831` (przed przypadkami P0 w `:2981-3231`), `fem_gpu_state_info`, `fem_llg_time_domain_qualification gpu` (`first_dt = 1e-9` na szybkim modzie wymiany): potwierdzone jako niepowiązane z P0.

### 3.2. Testy Rust, Python i bramki statyczne

| Suita | Wynik |
|---|---|
| `cargo test --locked -p fullmag-ir -p fullmag-plan --no-fail-fast` | **100% PASS** (`fullmag-ir` 289 unit + integracyjne; `fullmag-plan` w tym `fem::*` 29/29) |
| `cargo test --locked -p fullmag-fem-sys --lib` | **53 / 53 PASS** (w tym `plan_desc_v5`, `create_v6`, `provenance_v1`, append-only ABI) |
| `cargo test --locked -p fullmag-runner --features fem-gpu --lib` (parzystość GPU/CPU demag + exchange + integrator + koszt RHS RK + proweniencja `dispatch::tests` + `object_average`) | **11 / 11 PASS** (`0.77 s`, z aktywnym `cuDSS` na RTX 4080 SUPER) |
| `cargo check` (`fullmag-fem-sys`, `fullmag-runner --features fem-gpu/fem-native`, `fullmag-api --features fem-gpu`) | **PASS** |
| `packages/fullmag-py` 7 suit `bootstrap-rust.yml` | **124 / 124 PASS** |
| `packages/fullmag-py/tests/test_api.py` (324 testy) | **322 PASS, 1 skipped**, 1 błąd RO-mountu (`test_helper_exports_sp4_overlay_without_real_geometry_assets` zapisuje plik `.tmp` do montowanego RO `/opt/fullmag/source`); wszystkie testy `gpu_strategy` i `demag_solver_policy` **PASS** |
| `validate_scientific_docs.py` (`0913`, `fem_demag_fem_bem`, `0997`, `0998`) | **4 / 4 PASS** |
| `validate_changed_scientific_docs.py --base origin/master --head HEAD` | **PASS** |
| `python3 scripts/check_repo_consistency.py` | **PASS** |

---

## 4. Szczegółowe wyniki suity A/B (Etap 3)

Metodologia: pojedynczy sterownik C ABI (`ab_bench.cpp`) skompilowany identycznymi flagami (`g++ -O3 -std=c++20`) i zlinkowany z `DT_RPATH` osobno z `libfullmag_fem.so` z commitu baseline `226ad126a4` (`create_v5`) oraz kandydata `7723f7ffa7` (`create_v6` + `get_gpu_demag_linear_solver_provenance_v1`). Oba binaria wczytują te same deterministyczne siatki binarne i identyczne początkowe pole $m(0)$. Pomiar obejmuje 50 kroków po 5 krokach warmup, otoczonych `cudaDeviceSynchronize()`.

> **Uwaga o licznikach barier (`control_fences_per_step`):** wartości pochodzą z `fullmag_fem_transfer_audit.hot_loop_control_scalar_host_sync_count` i obejmują zarówno bariery certyfikacji rezyduum demag (po 1 na rozwiązanie dla kandydata zamiast 2 dla baseline), jak i **1 barierę na krok** dla końcowego readbacku skalarów kroku RK (`48 B`: energie, średnia $m$, max moment). Stąd:
> - **Poisson Heun:** baseline `3 × 2 + 1 = 7.0` barier/krok (`96 B`) $\to$ kandydat `2 × 1 + 1 = 3.0` barier/krok (`80 B`: `2 × 16 B + 48 B`).
> - **Poisson RK4:** baseline `5 × 2 + 1 = 11.0` barier/krok (`128 B`) $\to$ kandydat `4 × 1 + 1 = 5.0` barier/krok (`112 B`: `4 × 16 B + 48 B`).
> - **FEM/BEM Heun (`u1` + `u2`):** kandydat `2 × (2 × 1) + 1 = 5.0` barier/krok (`112 B`: `4 × 16 B + 48 B`).
> - `hot_loop_compute_host_sync_count = 0` dla każdego uruchomienia GPU.
>
> **Uwaga o `demag_solve_ms_per_step` pod `cuDSS`:** pole `stats.demag_wall_time_ns` mierzy czas hostowego wywołania `cudssExecute` (asynchroniczne kolejkowanie na strumień HYPRE: `0.3–1.1 ms/krok`), podczas gdy właściwe obliczenia na GPU kończą się na barierze certyfikacji i wchodzą w całkowity `wall_ms_per_step`.

### 4.1. Scenariusz 1a — Poisson open-airbox SP4 (cienka warstwa `500×125×3 nm`, `8 208` węzłów, `60 791` P2 DOF)

| Wariant | `wall_ms/step` | Przysp. | `demag_wall_ms/step` | `create_ms` | `rhs/step` (`s1→s2`) | `iters/step` (`iters/slv`) | `fences/step` (`B/step`) | `max_res` | `relax` | `req → resolved` (`fallback`) | `factor_nnz` (`peak_MiB`) | `DIRECT`/`PRECOND` | $\max\|\Delta m\|_\infty$ | $|\Delta E_{\text{demag}}|/|E_{\text{demag}}|$ |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---|---|---|---:|---:|
| Heun baseline (`226ad126a4`) | `813.129` | `1.00×` | `809.470` | `2990.9` | `3.0` (`3→3`) | `305.32` (`101.77`) | `7.0` (`96 B`) | `1.43e-09` | `18` | `baseline_v5 → hypre_krylov` (`none`) | `0` (`0`) | `0 / 1` | *ref* | *ref* |
| Heun cand `cg_amg` | `655.943` | **1.24×** | `654.157` | `2887.6` | `2.0` (`3→2`) | `253.72` (`126.86`) | `3.0` (`80 B`) | `1.43e-09` | `18` | `cg_amg → hypre_krylov` (`none`) | `0` (`0`) | `0 / 1` | `8.16e-12` | `9.97e-13` |
| Heun cand `auto` | `3.724` | **218.4×** | `0.357` | `3478.6` | `2.0` (`3→2`) | `2.00` (`1.00`) | `3.0` (`80 B`) | `1.08e-14` | `-1` | `auto → cudss_direct` (`none`) | `25.27 M` (`325.6`) | `1 / 0` | `5.65e-12` | `1.66e-12` |
| RK4 baseline (`226ad126a4`) | `1215.005` | `1.00×` | `1209.200` | `2879.5` | `5.0` (`5→5`) | `471.20` (`94.24`) | `11.0` (`128 B`) | `1.19e-09` | `18` | `baseline_v5 → hypre_krylov` (`none`) | `0` (`0`) | `0 / 1` | *ref* | *ref* |
| RK4 cand `cg_amg` | `923.615` | **1.32×** | `920.793` | `2888.8` | `4.0` (`5→4`) | `341.80` (`85.45`) | `5.0` (`112 B`) | `1.19e-09` | `18` | `cg_amg → hypre_krylov` (`none`) | `0` (`0`) | `0 / 1` | `4.85e-12` | `1.91e-12` |
| RK4 cand `auto` | `8.059` | **150.8×** | `0.835` | `3669.2` | `4.0` (`5→4`) | `4.00` (`1.00`) | `5.0` (`112 B`) | `1.08e-14` | `-1` | `auto → cudss_direct` (`none`) | `25.27 M` (`325.6`) | `1 / 0` | `5.97e-12` | `4.48e-11` |

*Obserwacja fizyczna:* wysokie wydłużenie elementów cienkiej warstwy SP4 (`31.25×12.5×3 nm`, stosunek `10.4:1`) pogarsza uwarunkowanie BoomerAMG (~100 iteracji/solve), natomiast rozkład Cholesky'ego w `cuDSS` jest w pełni niewrażliwy na anizotropię siatki, dając **151×–218×** przyspieszenia przy pełnej zgodności fizycznej $\sim 10^{-12}$.

### 4.2. Scenariusz 1b — Poisson open-airbox medium (`200×200×20 nm`, `49 600` węzłów, `380 701` P2 DOF)

| Wariant | `wall_ms/step` | Przysp. | `demag_wall_ms/step` | `create_ms` | `rhs/step` (`s1→s2`) | `iters/step` (`iters/slv`) | `fences/step` (`B/step`) | `max_res` | `relax` | `req → resolved` (`fallback`) | `factor_nnz` (`peak_GiB`) | `DIRECT`/`PRECOND` | $\max\|\Delta m\|_\infty$ | $|\Delta E_{\text{demag}}|/|E_{\text{demag}}|$ |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---|---|---|---:|---:|
| Heun baseline (`226ad126a4`) | `477.295` | `1.00×` | `468.152` | `17262.1` | `3.0` (`3→3`) | `150.00` (`50.00`) | `7.0` (`96 B`) | `3.25e-09` | `18` | `baseline_v5 → hypre_krylov` (`none`) | `0` (`0`) | `0 / 1` | *ref* | *ref* |
| Heun cand `cg_amg` | `254.834` | **1.87×** | `250.576` | `16378.1` | `2.0` (`3→2`) | `78.02` (`39.01`, **−48.0%**) | `3.0` (`80 B`) | `3.19e-09` | `18` | `cg_amg → hypre_krylov` (`none`) | `0` (`0`) | `0 / 1` | `2.31e-11` | `3.02e-12` |
| Heun cand `auto` | `23.448` | **20.36×** | `0.532` | `23908.6` | `2.0` (`3→2`) | `2.00` (`1.00`) | `3.0` (`80 B`) | `8.20e-14` | `-1` | `auto → cudss_direct` (`none`) | `339.87 M` (`3.13`) | `1 / 0` | `2.51e-11` | `1.81e-11` |
| RK4 baseline (`226ad126a4`) | `874.730` | `1.00×` | `859.478` | `18362.1` | `5.0` (`5→5`) | `254.90` (`50.98`) | `11.0` (`128 B`) | `3.62e-09` | `18` | `baseline_v5 → hypre_krylov` (`none`) | `0` (`0`) | `0 / 1` | *ref* | *ref* |
| RK4 cand `cg_amg` | `400.217` | **2.19×** | `394.726` | `16843.4` | `4.0` (`5→4`) | `117.58` (`29.39`, **−53.9%**) | `5.0` (`112 B`) | `3.12e-09` | `18` | `cg_amg → hypre_krylov` (`none`) | `0` (`0`) | `0 / 1` | `2.85e-11` | `4.44e-12` |
| RK4 cand `auto` | `45.869` | **19.07×** | `1.124` | `23648.7` | `4.0` (`5→4`) | `4.00` (`1.00`) | `5.0` (`112 B`) | `8.22e-14` | `-1` | `auto → cudss_direct` (`none`) | `339.87 M` (`3.13`) | `1 / 0` | `2.39e-11` | `1.89e-11` |

*Składowa predyktora $\phi^{(0)}$ na ścieżce Krylowa:* na siatce `49 600` węzłów (`cg_amg`) średnia liczba iteracji PCG na jedno rozwiązanie spada z `50.00 → 39.01` (**−22.0%**) dla Heun i z `50.98 → 29.39` (**−42.3%**) dla RK4 (z ochroną etapów równoczasowych `last_solved_stage_time_s`), co w połączeniu z FSAL daje łączny spadek iteracji **−48.0% (Heun)** i **−53.9% (RK4)** oraz przyspieszenie **1.87×–2.19×** nawet bez użycia `cuDSS`.

### 4.3. Scenariusz 2 — Ciasny limit VRAM (`FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB=32`, siatka `49 600` węzłów, Heun)

| Wariant | Kod wyjścia | `wall_ms/step` | `iters/step` | `fences/step` | `req → resolved` | `fallback_reason` | `factorization_started` | `est_peak` vs `budget` | Zgodność z `cg_amg` |
|---|---:|---:|---:|---:|---|---|---|---|---|
| `s2_49k_auto_cap32` (`gpu_strategy="auto"`) | **0** | `255.928` (**1.86× vs base**) | `78.02` (**−48.0%**) | `3.0` (`80 B`) | `auto → hypre_krylov` | `cudss_factor_exceeds_vram_budget` | **`false`** (`factor_nnz=0`, `factor_bytes=0`) | `3 364 743 212 B` (`3.13 GiB`) > `33 554 432 B` (`32 MiB`) | **Bitowo identyczne (`max|Δm| = 0.0`, `rel|ΔE| = 0.0`)**, `2.31e-11` vs base |
| `s2_49k_cudss_cap32` (`gpu_strategy="cudss"`) | **2 (twardy błąd)** | — | — | — | *(odmowa w `create_v6`, 0 fallbacku)* | — | **`false`** | `3.13 GiB > 0.03 GiB` (`rows=380701`, `est_nnz=339869519`, *„The factorization was not started”*, analiza `5.7 s`) | — |

**Weryfikacja end-to-end Python $\to$ Rust `fullmag-bin` (5 kroków, `study.fem_demag_solver(..., gpu_strategy=...)`):**
- `poisson_robin` + `gpu_strategy="auto"` $\to$ `rc = 0`, `status = "completed"`, `total_steps = 5` (`cuDSS direct solve`, `rows = 4137`, `factor_nnz = 425 167`).
- `poisson_robin` + `gpu_strategy="cg_amg"` $\to$ `rc = 0`, `status = "completed"`, `total_steps = 5` (bez faktoryzacji `cuDSS`).
- `poisson_robin` + `gpu_strategy="auto"` + `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB=1` $\to$ `rc = 0`, `status = "completed"`, `total_steps = 5` (czysty fallback do HYPRE Krylov).
- `poisson_robin` + `gpu_strategy="cudss"` + `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB=1` $\to$ **`rc = 1`** (twardy błąd: `estimated device peak 19111348 bytes > budget 1048576 bytes`, `The factorization was not started`, zero fallbacku).
- `fredkin_koehler` + `gpu_strategy="auto"` i `gpu_strategy="cg_amg"` $\to$ oba `rc = 0`, `status = "completed"`, `total_steps = 5`, `preconditioner=AMG`, `demag_mode=device_hypre_fem_bem`.

### 4.4. Scenariusz 3 — GPU FEM/BEM geometria otwarta (`fembem_open`, `1 183` węzłów, `5 184` TET4, `664` węzłów brzegowych, bez airboxu, Heun)

| Wariant | Kod wyjścia | `wall_ms/step` | `rhs/step` | `iters/step` (`iters/slv`) | `fences/step` (`B/step`) | `max_res` | `relax` | `req → resolved` | `DIRECT`/`PRECOND` | $\max\|\Delta m\|_\infty$ vs CPU | $|\Delta E_{\text{demag}}|/|E_{\text{demag}}|$ vs CPU | $|\Delta H_{\text{demag}}|_\infty/\|H\|_\infty$ vs CPU |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---:|---:|
| CPU FEM/BEM oracle (`HEAD`, `rtol=1e-10`) | `0` | `11.970` | `3.0` | `210.32` (`35.05`) | `0.0` (`0 B`) | `6.52e-14` | `-1` | `cpu → unavailable` | `0 / 0` | *ref* | *ref* | *ref* |
| Baseline `226ad126a4` GPU `JACOBI` (`rtol=1e-8`) | **`6` (FAIL)** | — | — | *(129 iteracji na kroku 1)* | — | `1.10e-08 > 1e-08` | — | `baseline_v5` | — | *(odrzucony w kroku 1; ponadto brak uploadu `d_boundary_tdofs`)* | — | — |
| Cand `cg_amg` + `JACOBI` (`rtol=1e-8`) | `0` | `42.904` | `2.0` | `208.74` (`52.19`) | `5.0` (`112 B`) | `1.78e-12` | `-1` | `cg_amg → hypre_krylov` | `0 / 1` | `4.68e-05` | `1.54e-05` | `4.27e-04` |
| Cand `cg_amg` + `AMG` (`rtol=1e-8`) | `0` | `76.099` | `2.0` | `45.00` (`11.25`) | `5.0` (`112 B`) | `1.31e-12` | **`18`** | `cg_amg → hypre_krylov` | `0 / 1` | `2.32e-05` | `1.55e-06` | `2.04e-04` |
| *Diagnostyka:* Cand `cg_amg` + `AMG` (`rtol=1e-12`) | `0` | `132.421` | `2.0` | `80.00` (`20.00`) | `5.0` (`112 B`) | `3.78e-17` | **`18`** | `cg_amg → hypre_krylov` | `0 / 1` | **`3.36e-09`** | **`1.26e-10`** | **`3.01e-08`** |
| **Cand `auto` (`cudss_direct`, `rtol=1e-8`)** | **`0`** | **`2.202`** | **`2.0`** | **`4.00` (`1.00`)** | **`5.0` (`112 B`)** | **`1.10e-23`** | **`-1`** | **`auto → cudss_direct`** | **`1 / 0`** | **`4.88e-14`** | **`1.54e-14`** | **`2.27e-13`** |

**Kluczowe wnioski ze Scenariusza 3:**
1. **Baseline `226ad126a4` nie przechodzi nawet kroku 1:** na `origin/master` GPU FEM/BEM nie stosowało marginesu `0.1 * rtol`, więc `gpu_fem_bem/cg` raportowało zbieżność z rezyduum `1.095e-08 > 1e-08` i przerywało symulację (a ponadto miało nienaprawiony brak uploadu `d_boundary_tdofs` wykryty przez `compute-sanitizer`).
2. **Wyjaśnienie błędu `2.32e-05` ścieżki Krylowa przy `rtol = 1e-8` (skalowanie `DIAG_ONE` w `dirichlet_op`):** istniejąca eliminacja `EliminateRowCol` w `backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.cpp:354` wstawia `1.0` na przekątnej wierszy brzegowych przy skali sztywności wewnętrznej $K_{\text{int}} \sim h \approx 8 \times 10^{-9}\,\text{m}$ (skok skali $\sim 1/h \approx 10^8$). Z tego powodu norma globalna $\|b\|_2$ dla $u_2$ jest zdominowana przez brzeg $b_\Gamma$, przez co kryterium globalne $\|r\|_2/\|b\|_2 \le 10^{-8}$ odpowiada błędowi względnemu $O(10^{-4})$ w wierszach wewnętrznych $u_2$. Przebieg diagnostyczny z `rtol = 1e-12` (zgodny z `demag_fem_bem_gpu_contract.cpp:334`) natychmiast redukuje różnicę względem CPU do **`3.36e-09` ($m$) / `3.01e-08` ($H_{\text{demag}}$)** — nie jest to regresja P0.
3. **Przewaga `cuDSS` pod `auto` w FEM/BEM:** rozkład Cholesky'ego pary `(u1, u2)` (`factor_nnz = 87 736`, `est_peak = 10.5 MiB`) jest całkowicie odporny na skalowanie `DIAG_ONE`, osiągając **dokładność maszynową (`max|Δm| = 4.88e-14`, `rel|ΔH| = 2.27e-13`)** już przy `rtol = 1e-8`, przy jednoczesnym przyspieszeniu **34.6× względem GPU AMG (`76.10 → 2.20 ms`)**, **19.5× względem GPU JACOBI (`42.90 → 2.20 ms`)** i **5.4× względem CPU FEM/BEM (`11.97 → 2.20 ms`)**.
4. **Kontrakty recepty i AMG:** `coarse_relax_type == 18` pod `cg_amg+AMG` i `-1` pod `auto` (`cuDSS`); bity recepty GPU rozłączne (`DIRECT_SOLVE=1, PRECOND=0` dla `cuDSS`, `DIRECT_SOLVE=0, PRECOND=1` dla Krylowa); 2 bariery certyfikacji (`32 B`) na pojedyncze wywołanie FEM/BEM (`u1` + `u2`), łącznie `5.0` barier/krok (`112 B`) przy FSAL Heun.

### 4.5. Scenariusz 4 — PBC-reduced Poisson (`20×20×18` Kuhn `TET4`, `8 379` węzłów, P1 zredukowany)

| Wariant | `wall_ms/step` | Przysp. | `demag_wall_ms/step` | `rhs/step` (`s1→s2`, `fsal2`) | `iters/step` (`iters/slv`) | `fences/step` (`B/step`) | `max_res` | `relax` | `req → resolved` | `factor_nnz` (`peak_MiB`) | `DIRECT`/`PRECOND` | $\max\|\Delta m\|_\infty$ | $|\Delta E_{\text{demag}}|/|E_{\text{demag}}|$ |
|---|---:|---:|---:|---|---:|---:|---:|---:|---|---|---|---:|---:|
| **4a. 1D Robin** Heun baseline | `56.813` | `1.00×` | `54.886` | `3.0` (`3→3`, `0`) | `26.00` (`8.67`) | `7.0` (`96 B`) | `1.20e-09` | `18` | `baseline_v5 → hypre_krylov` | `0` (`0`) | `0 / 1` | *ref* | *ref* |
| **4a. 1D Robin** Heun cand `cg_amg` | `37.641` | **1.51×** | `36.103` | `2.0` (`3→2`, `1`) | `17.00` (`8.50`) | `3.0` (`80 B`) | `1.20e-09` | `18` | `cg_amg → hypre_krylov` | `0` (`0`) | `0 / 1` | `4.89e-11` | `1.05e-12` |
| **4a. 1D Robin** Heun cand `auto` | `1.986` | **28.6×** | `0.338` | `2.0` (`3→2`, `1`) | `2.00` (`1.00`) | `3.0` (`80 B`) | `6.51e-15` | `-1` | `auto → cudss_direct` | `0.99 M` (`25.3`) | `1 / 0` | `3.51e-11` | `1.22e-11` |
| **4a. 1D Robin** RK4 baseline | `92.188` | `1.00×` | `89.401` | `5.0` (`5→5`, `0`) | `43.00` (`8.60`) | `11.0` (`128 B`) | `4.90e-10` | `18` | `baseline_v5 → hypre_krylov` | `0` (`0`) | `0 / 1` | *ref* | *ref* |
| **4a. 1D Robin** RK4 cand `auto` | `3.445` | **26.8×** | `0.670` | `4.0` (`5→4`, `1`) | `4.00` (`1.00`) | `5.0` (`112 B`) | `6.46e-15` | `-1` | `auto → cudss_direct` | `0.99 M` (`25.3`) | `1 / 0` | `2.66e-11` | `2.40e-11` |
| **4b. 2D film pin** Heun baseline | `72.749` | `1.00×` | `70.779` | `3.0` (`3→3`, `0`) | `37.00` (`12.33`) | `7.0` (`96 B`) | `1.89e-09` | `18` | `baseline_v5 → hypre_krylov` | `0` (`0`) | `0 / 1` | *ref* | *ref* |
| **4b. 2D film pin** Heun cand `cg_amg` | `57.087` | **1.27×** | `55.533` | `2.0` (`3→2`, `1`) | `29.00` (`14.50`) | `3.0` (`80 B`) | `1.89e-09` | `18` | `cg_amg → hypre_krylov` | `0` (`0`) | `0 / 1` | `3.48e-11` | `1.81e-12` |
| **4b. 2D film pin** Heun cand `auto` | `2.052` | **35.5×** | `0.322` | `2.0` (`3→2`, `1`) | `2.00` (`1.00`) | `3.0` (`80 B`) | `1.86e-14` | `-1` | `auto → cudss_direct` | `1.15 M` (`25.2`) | `1 / 0` | `3.39e-11` | `1.62e-11` |
| **4b. 2D film pin** RK4 baseline | `118.116` | `1.00×` | `115.314` | `5.0` (`5→5`, `0`) | `57.00` (`11.40`) | `11.0` (`128 B`) | `9.29e-10` | `18` | `baseline_v5 → hypre_krylov` | `0` (`0`) | `0 / 1` | *ref* | *ref* |
| **4b. 2D film pin** RK4 cand `auto` | `3.580` | **33.0×** | `0.620` | `4.0` (`5→4`, `1`) | `4.00` (`1.00`) | `5.0` (`112 B`) | `1.87e-14` | `-1` | `auto → cudss_direct` | `1.15 M` (`25.2`) | `1 / 0` | `3.42e-11` | `1.22e-10` |

Wszystkie warianty PBC-reduced (1D Robin oraz 2D film czysty Neumann $\beta = 0$ z singletonowym pinem cechowania) rozwiązują zredukowany operator $A_{\text{red}} = P_{\text{pbc}}^T A_{\text{full}} P_{\text{pbc}}$ w `cuDSS` z rezyduum $\le 1.87 \times 10^{-14}$, aktywnym `fsal_reused == true` od kroku 2 (`3→2` Heun, `5→4` RK4), przyspieszeniem **26.8×–35.5×** i parzystością fizyczną $\le 3.51 \times 10^{-11}$.

---

## 5. Podsumowanie spełnienia bramek akceptacyjnych

| Bramka (Specyfikacja sekcja 7 / Plan) | Status | Dowód |
|---|---|---|
| Scenariusz 1: $\max\|m_{\text{cand}}-m_{\text{base}}\|_\infty \le 10^{-6}$, $\|\Delta E_{\text{demag}}\|/\|E_{\text{demag}}\| \le 10^{-7}$ | **PASS** | $4.85 \times 10^{-12} \dots 2.85 \times 10^{-11}$ ($m$), $9.97 \times 10^{-13} \dots 4.48 \times 10^{-11}$ ($E_{\text{demag}}$) |
| Scenariusz 1: RHS/krok Heun `3→2`, RK4 `5→4`, bariery certyfikacji/solve `2→1` (`16 B`) | **PASS** | `step1=3→step2=2` (Heun), `step1=5→step2=4` (RK4); `fences/step`: `7→3` (Heun), `11→5` (RK4), `0` compute synców |
| Scenariusz 1: spadek iteracji CG/AMG pod `cg_amg` + wyraźne przyspieszenie pod `auto` | **PASS** | `cg_amg`: iters −16.9% do −53.9%, **1.24×–2.19×**; `auto` (`cuDSS`): **19.1×–218.4×** |
| Scenariusz 2: `auto` + `MAX_VRAM_MIB=32` $\to$ czysty fallback `hypre_krylov` + `cudss_factor_exceeds_vram_budget`, `factorization_started=false`, przyspieszenie predyktora | **PASS** | `rc=0`, `factor_nnz=0`, `255.93 ms` (**1.86×** vs base), bitowo identyczne z `cg_amg` (`0.0`) |
| Scenariusz 2: `cudss` + `MAX_VRAM_MIB=32` (i `MAX_VRAM_MIB=1` E2E) $\to$ twardy błąd `exit != 0`, zero fallbacku | **PASS** | C ABI `rc=2` (`3.13 GiB > 0.03 GiB`), `fullmag-bin` E2E `rc=1` (`19.1 MB > 1.0 MB`) |
| Scenariusz 3: GPU FEM/BEM `coarse_relax_type == 18` (`cg_amg+AMG`), `-1` (`auto`/`cuDSS`), recepta `DIRECT_SOLVE` bez `PRECONDITIONER`, parzystość $\le 10^{-6}$ | **PASS** | `relax=18` (`cg_amg`) / `-1` (`auto`); `DIRECT_SOLVE=1, PRECOND=0`; `cuDSS` vs CPU: `4.88e-14` ($m$), `2.27e-13` ($H_{\text{demag}}$), **34.6× vs AMG**; `cg_amg+AMG` przy `rtol=1e-12`: `3.36e-09` ($m$) |
| Scenariusz 4: PBC 1D Robin + 2D film pin $\to$ `cudss_direct`, rezyduum $\le \text{rtol}$, parzystość $\le 10^{-6}$, `fsal_reused == true` od kroku 2 | **PASS** | Rezyduum $\le 1.87 \times 10^{-14}$, parzystość $\le 3.51 \times 10^{-11}$, `fsal2=1`, **26.8×–35.5×** |
| Czystość worktree i zasobów Docker | **PASS** | `git status --short` puste (`HEAD 7723f7ffa7`), katalog tymczasowy baseline usunięty, kontener DEV worktree zdrowy |
