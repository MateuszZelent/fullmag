# Raport weryfikacji i benchmarków A/B — Wave 3: `bb_exchange_mass` PGBB, jądra krótkiego zasięgu GPU oraz GPU Driven Response (`cuDSS`)

Powiązane dokumenty:
- Specyfikacja architektoniczna: [2026-11-26-fem-pgbb-kernels-dr-design.md](../superpowers/specs/2026-11-26-fem-pgbb-kernels-dr-design.md)
- Plan implementacji: [2026-11-26-fem-pgbb-kernels-dr-plan.md](../superpowers/plans/2026-11-26-fem-pgbb-kernels-dr-plan.md)
- Notatki fizyczne: [0581-fem-gpu-direct-minimizer-preconditioning.md](../physics/0581-fem-gpu-direct-minimizer-preconditioning.md), [0999-fem-gpu-short-range-kernel-optimizations.md](../physics/0999-fem-gpu-short-range-kernel-optimizations.md), [1000-fem-gpu-driven-response-cudss.md](../physics/1000-fem-gpu-driven-response-cudss.md)

- **Data:** 2026-11-26
- **Identyfikator worktree / gałąź:** `fem-pgbb-kernels-dr-20261126-29c1107b8b5a96ed` (`codex/fem-pgbb-kernels-dr-20261126`)
- **Baseline (A):** `9ab99132d55d4af1596f42625c7733ccac496c31`
- **Kandydat (B):** `311062d617c9187e499f359ac5481a74db7817e1` (po poprawce preskalowania blokowego 2×2 w `compute_ruiz_equilibration`)
- **Środowisko wykonania:** wyłącznie kontener Docker Compose DEV `backend` grupy worktree (`fullmag-worktree-fem-pgbb-kernels-dr-20261126-29c1107b8b5a96ed-backend-1`), GPU **NVIDIA GeForce RTX 4080 SUPER** (SM `89-real`, 16 GiB VRAM), `cuDSS 0.8.0.10`, MFEM + HYPRE + SLEPc, `double` (FP64).

---

## 1. Podsumowanie wykonawcze (wszystkie bramki PASS)

| Ścieżka | Główna zmiana | Zmierzony zysk na RTX 4080 SUPER (B vs A) | Parytet / dokładność | Status bramek |
| :--- | :--- | :--- | :--- | :--- |
| **Track 1** (P1 #6) | Kwalifikacja `bb_exchange_mass` (`auto` → `exchange_mass` gdy aktywny exchange) + redukcja synchronizacji (`7→4` / `6→3`) i redukcji energii (`3→1`) w GPU PGBB | **`6.18×–10.52×`** mniej kroków PGBB (`39` vs `241` dla `h=3 nm`, `29` vs `305` dla `h=2 nm`), **`2.82×–3.79×`** szybciej (`cuDSS`), **`6.11×`** szybciej (`CG+AMG`: `38.37 s` vs `234.28 s`), dokładnie **`-3.0` sync/krok** dla `exchange_mass` (`286→170`) i **`-2.0` sync/krok** dla `none` (`1203→776`) | `ΔE/|E| = 2.0e-14 .. 9.0e-12` względem CPU PGBB; bitowo identyczna trajektoria dla `none` (`CG+AMG` / brak demag); `mono_viol = 0`, `max_pcg_res < 1e-10` | **PASS** |
| **Track 2** (P2 #7a) | Jądra krótkiego zasięgu GPU: `cub::BlockReduce` + `energy_out=nullptr` w DMI, `Exchange` RK FMA (`Compensated=false`), fuzja `H_eff` (do `28→1` kernel launch), spakowany transfer AoS↔SoA (`state_io`, `stage_compute`, `api.cpp`) | **`1.80×`** pełne E2E dla 50 kroków RK4 (`277.46 ms` vs `498.56 ms`), **`2.54×`** DMI RK (`0.3095 ms` vs `0.7873 ms`), **`8.02×`** Exchange RK FMA (`0.0517 ms` vs `0.4144 ms`), **`17.5×`** fuzja `H_eff` (`0.0130 ms` vs `0.2275 ms`, `21→1` launchy), **`13.93×`** `state_io` (`5.28 ms` vs `73.62 ms`), **`40.5×`** D2H / **`6.30×`** H2D (pakowane vs `cudaMemcpy2D`) | Po 50 krokach RK4: `ΔE_tot = 0`, `ΔE_ex = 0`, `ΔE_ani = 0`, `ΔE_mel = 0`, `ΔE_dmi = 1.62e-15`, `max_rel(m) = 4.53e-16`, `max_rel(H_eff) = 1.65e-15` (`<< 1e-13`) | **PASS** |
| **Track 3** (P2 #7b) | GPU Driven Response `cuDSS` (1× analiza symboliczna + szybka aktualizacja diagonali `4*N_m_eff` bez kopiowania CSR H2D + 2×2 preskalowanie blokowe + 6× Ruiz + preflight VRAM + niezależna certyfikacja nieskalowanych residuów GPU) | **`151.3×`** szybciej od CPU GMRES na open-airbox `1,687` DOF (`208.0 ms` vs `31,473.6 ms` dla 8 freq; **`454×`** zamortyzowane dla 25 freq: `8.66 ms/freq` vs `3,934.2 ms/freq`, bez zacinania w rezonansie); **`4.22×`** szybciej od GPU GMRES na `periodic_airbox_k0` `1,690` DOF (`692.7 ms` vs `2,919.9 ms`) i **`2.89×`** na `4,410` DOF (`1,248.2 ms` vs `3,603.1 ms`); skalowanie open-airbox do **`42,907` zespolonych DOF** (`25/25` freq w `6.08 s`, `449.6 MiB` VRAM) | Parytet zespolonej krzywej odpowiedzi `vector_tangent_complex`: **`3.08e-11`** (`3C_periodic_k0`, 25 freq), **`3.04e-11`** (`3C_periodic_k0_large`, 25 freq), **`5.32e-10`** (`3A_open_small` vs CPU GMRES `1e-10`, 8 freq); certyfikowane residua `cuDSS`: `r_q = 2.5e-16..1.1e-14`, `r_phi = 1.9e-15..2.9e-13`; `0` zaburzonych pivotów; preflight VRAM fail-closed (`REQUIRED`) i jawny fallback (`AUTO`, parytet `0.0`) | **PASS** |

---

## 2. Macierz weryfikacji funkcjonalnej, pamięciowej i kontraktowej (Stage 1 & Stage 2)

Wszystkie buildy i testy uruchomiono wewnątrz kontenera Docker DEV worktree (`SM 89-real`):

1. **Pełny build Docker DEV (`cuda-fem-gpu`, SM `89-real` + MFEM + HYPRE + SLEPc + cuDSS + Rust + Python + frontend):** PASS.
2. **Kontrakt CI non-MFEM (`-DFULLMAG_ENABLE_CUDA=OFF -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF`):**
   - **10/10 PASS** (`0.05 s`): wszystkie 8 celów `native-modal-cabi-contract` + `fem_driven_response_contract` + `fem_driven_response_cudss_contract` (ścieżka przenośna bez CUDA/cuDSS).
   - `scripts/ci/test_fem_cuda_driver_selection.py`: **9/9 PASS**.
3. **CTesty GPU i regresje P0 (wszystkie PASS na `311062d617`):**
   - Track 1: `fem_cuda_bb_exchange_mass_contract` (tryb normalny + `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1`), `fem_relaxation_source_contract`, `fem_relaxation_energy_derivative_contract`, `fem_cuda_pgbb_reuse_contract`, `fem_pgbb_accepted_cache_contract`, `fem_gpu_relaxation_preconditioner_contract`.
   - Track 2: `fem_cuda_shortrange_kernels_contract`, `fem_gpu_state_runtime_contract`, `fem_state_io_contract`, `fem_oersted_contract`.
   - Track 3: `fem_driven_response_cudss_contract` (wraz z nowym testem regresyjnym `test_asymmetric_1e25_open_airbox_block_prescaling`), `fem_driven_response_contract`, `fem_frequency_domain_contract`.
   - Regresje P0: `fem_cudss_poisson_budget_contract`, `fem_cuda_rk_heun_rk4_fsal_predictor_contract`, `fem_demag_fem_bem_gpu_contract`, `fem_gpu_strict_execution_contract`.
4. **Sanityzacja pamięci GPU (`compute-sanitizer --tool memcheck --error-exitcode=1`):**
   - `fem_cuda_bb_exchange_mass_contract`: **0 błędów**.
   - `fem_cuda_shortrange_kernels_contract`: **0 błędów**.
   - `fem_driven_response_cudss_contract`: **0 błędów**.
5. **Testy Rust Cargo (wewnątrz kontenera):**
   - `fullmag-fem-sys --features build-native`: **54/54 PASS** (wszystkie testy layoutu C ABI).
   - `fullmag-ir`: **289/289 (+ wszystkie testy integracyjne) PASS**.
   - `fullmag-plan`: **688/688 (+ wszystkie testy integracyjne) PASS**.
   - `fullmag-runner` (domyślne cechy `bootstrap-rust`): `relaxation::provenance` **9/9 PASS**, `frequency_response` **55/55 PASS**.
   - `fullmag-runner --features fem-gpu`: `relaxation::provenance` **9/9 PASS**, `frequency_response` **67/67** nowych i aktywnych testów PASS (5 niepowodzeń na niezmienionych testach zweryfikowano jako wcześniej istniejące na bazie `9ab99132d5`).
6. **Testy Python (wewnątrz kontenera):**
   - `packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_frequency_response_gpu_sparse_direct_solver_method_round_trips_from_python_stage`: **PASS**.
   - `packages/fullmag-py/tests/test_fem_gpu_bb_preconditioner.py`: **17/17 PASS**.
7. **Bramki statyczne i dokumentacja naukowa:**
   - `scripts/check_repo_consistency.py`: **PASS**.
   - `.agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py` dla `0581`, `0999`, `1000`: **PASS**.
   - `.agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py --base origin/master --head HEAD`: **PASS**.
   - `git diff --check`: **PASS**.

### Istotny defekt numeryczny wykryty i naprawiony w trakcie kwalifikacji Stage 3

Podczas pierwszego uruchomienia benchmarków Track 3 na rzeczywistych siatkach 3D MFEM open-airbox P2 (`3A_open`: 21 991 DOF, `3B_open_large`: 42 907 DOF) wykryto, że bloki sprzężone $Z_{\mathrm{aug}}(\omega_{\mathrm{ref}})$ mają asymetrię rzędów wielkości wynoszącą **$10^{25}$** między blokami poza diagonalą ($s_{qq} = 9.45\times 10^{11}$, $s_{q\phi} = 3.54\times 10^{13}$, $s_{\phi q} = 2.67\times 10^{-12}$, $s_{\phi\phi} = 1.35\times 10^{-7}$). Sama 6-przebiegowa (a nawet 20-przebiegowa) ekwilibracja Ruiza zbiegała do niesymetrycznego punktu stałego z minimalną diagonalą bloku Poissona $P_{\mathrm{diag,min}} = 1.715\times 10^{-10}$, co wywoływało zaburzone pivoty `cuDSS` (`CUDSS_DATA_NPIVOTS = 2` przy $f=11\text{ GHz}$ i `1` przy $f=23\text{ GHz}$) oraz degradację residuum Poissona do $1.08\times 10^{-3}$.

Wprowadzono dokładne **geometryczne preskalowanie blokowe 2×2** $(r_\phi, c_\phi)$ przed 6 przebiegami Ruiza (z wyznaczeniem $s_{\phi\phi}$ z wierszy wewnętrznych o `nnz > 1`, aby wiersze `ess_tdofs` z jedynką na diagonali nie maskowały sztywności wewnętrznej):
- $P_{\mathrm{diag}}$ poprawiło się z $1.715\times 10^{-10}$ do **`[1.000, 1.000]`**,
- `CUDSS_DATA_NPIVOTS` spadło do **`0`** dla wszystkich częstotliwości,
- residuum Poissona przy $f=11\text{ GHz}$ (`3A_open`) spadło o **11 rzędów wielkości** ($1.08\times 10^{-3} \to 9.27\times 10^{-15}$), a przy $f=23\text{ GHz}$ (`3B_open_large`) o **10 rzędów wielkości** ($8.30\times 10^{-5} \to 1.24\times 10^{-14}$).

Dodano również dedykowany test regresyjny `test_asymmetric_1e25_open_airbox_block_prescaling()` w `backends/fem/tests/frequency_domain/driven_response_cudss_contract.cpp` (commity `d5b4850ea0` + `311062d617`).

---

## 3. Wyniki A/B — Track 1: Kwalifikacja `bb_exchange_mass` oraz redukcja synchronizacji i energii GPU PGBB

Benchmark: sterownik C ABI `bench_track1_pgbb.cpp` (Permalloy $M_s = 8\times 10^5\text{ A/m}$, $A_{\mathrm{ex}} = 1.3\times 10^{-11}\text{ J/m}$, próg relaksacji $\mathrm{tol} = 10\text{ A/m}$, `Armijo`, `mono_viol = 0` we wszystkich przebiegach).

### 3.1. Zestawienie wszystkich 4 przypadków testowych

| Przypadek | Wariant / polityka | Kroki PGBB | Rozwiązań demag | Czas całkowity [ms] | Czas/krok [ms] | Syncy host-GPU | Syncy/krok | Przyspieszenie vs baza `none` | `E_total` [J] | Błąd `ΔE/|E|` vs CPU ref | `max_pcg_res` |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **1A** SP4 `h=3 nm` + airbox (`7,800` węzłów / `1,952` mag, `cuDSS`) | CPU PGBB ref | 39 | 46 | 14 421.04 | 369.77 | — | — | 0.10× | `1.778806741160e-19` | `0` (ref) | — |
| | Baza A `pol=1 (none / old auto)` | 241 | 309 | 1 424.85 | 5.91 | 1 340 | 5.56 | 1.00× | `1.778806786024e-19` | `2.5e-8` | — |
| | Baza A `pol=2 (exchange_mass)` | 39 | 46 | 437.02 | 11.21 | 286 | 7.33 | 3.26× | `1.778806741159e-19` | `9.0e-12` | `9.997e-11` |
| | Kandydat B `pol=1 (none)` | 209 | 272 | 1 240.87 | 5.94 | 753 | 3.60 | 1.15× | `1.778806786024e-19` | `2.5e-8` | — |
| | **Kandydat B `pol=2 (exchange_mass)`** | **39** | **46** | **505.80** | **12.97** | **170** | **4.36** | **2.82×** (`6.18×` kroków, `28.5×` vs CPU) | `1.778806741159e-19` | **`9.0e-12`** | **`9.997e-11`** |
| | **Kandydat B `pol=0 (auto → exchange_mass)`** | **39** | **46** | **683.87** | **17.54** | **170** | **4.36** | **2.08×** (`6.18×` kroków) | `1.778806741159e-19` | **`9.0e-12`** | **`9.997e-11`** |
| **1A_cgamg** SP4 `h=3 nm` + airbox (`CG+AMG`) | Baza A `pol=1 (none)` | 214 | 281 | 234 276.44 | 1 094.75 | 1 203 | 5.62 | 1.00× | `1.778806784265e-19` | `2.4e-8` | — |
| | Kandydat B `pol=1 (none)` | 214 | 281 | 231 324.15 | 1 080.95 | **776** | **3.63** | 1.01× (**-427 synców = -2.00/krok**, bitowo identyczne!) | `1.778806784265e-19` | `2.4e-8` | — |
| | **Kandydat B `pol=0 (auto → exchange_mass)`** | **39** | **46** | **38 369.84** | **983.84** | **170** | **4.36** | **`6.11×`** (`5.49×` kroków, `6.11×` demag) | `1.778806741159e-19` | **`9.0e-12`** | **`9.997e-11`** |
| **1B** Ultra-fine `h=2 nm` + airbox (`7,800` / `1,952` mag, `cuDSS`) | CPU PGBB ref | 29 | 35 | 13 550.83 | 467.27 | — | — | 0.16× | `5.003661406987e-20` | `0` (ref) | — |
| | Baza A `pol=1 (none)` | 305 | 404 | 2 138.17 | 7.01 | 1 722 | 5.65 | 1.00× | `5.003661717025e-20` | `6.2e-8` | — |
| | Kandydat B `pol=1 (none)` | 279 | 368 | 1 566.74 | 5.62 | 1 015 | 3.64 | 1.36× | `5.003661717025e-20` | `6.2e-8` | — |
| | **Kandydat B `pol=0 (auto → exchange_mass)`** | **29** | **35** | **564.51** | **19.47** | **128** | **4.41** | **`3.79×`** (**`10.52×`** mniej kroków, **`24.0×`** vs CPU) | `5.003661406986e-20` | **`2.0e-14`** | **`9.982e-11`** |
| **1C** Czysty slab `h=2 nm` (`2,583` węzłów, exchange + Zeeman, bez demag) | CPU PGBB ref | 53 | 0 | 578.04 | 10.91 | — | — | 1.52× | `-6.433981754187e-19` | `0` (ref) | — |
| | Baza A `pol=1 (none)` | 322 | 0 | 877.05 | 2.72 | 1 408 | 4.37 | 1.00× | `-6.433981754292e-19` | `1.6e-11` | — |
| | Kandydat B `pol=1 (none)` | 322 | 0 | 702.58 | 2.18 | **1 086** | **3.37** | **1.25×** (**-322 synców = -1.00/krok**, bitowo identyczne!) | `-6.433981754292e-19` | `1.6e-11` | — |
| | **Kandydat B `pol=0 (auto → exchange_mass)`** | **53** | **0** | **263.15** | **4.97** | **218** | **4.11** | **`3.33×`** (**`6.08×`** mniej kroków) | `-6.433981754169e-19` | **`2.8e-12`** | **`9.986e-11`** |

**Kluczowe obserwacje Track 1:**
- Redukcja synchronizacji na krok PGBB potwierdzona z dokładnością do 1 synchronizacji: dla `exchange_mass` na `1A` spadek dokładnie `286 → 170` (`-116` dla 39 kroków ≈ `-3.0` sync/krok), dla `none` z demagiem `1,203 → 776` (`-427` dla 214 kroków = dokładnie `-2.00` sync/krok), dla `none` bez demagu `1,408 → 1,086` (`-322` dla 322 kroków = dokładnie `-1.00` sync/krok).
- Liczba kroków `auto` na GPU dokładnie pokrywa się z CPU PGBB (`39 == 39` dla `h=3 nm`, `29 == 29` dla `h=2 nm`, `53 == 53` dla slabu), z `0` naruszeniami monotoniczności Armijo i zgodnością średniego `<m>` na poziomie `|Δ<m>| <= 4.1e-9` (10 cyfr dla `1B`).

---

## 4. Wyniki A/B — Track 2: Jądra krótkiego zasięgu GPU, fuzja `H_eff` i spakowany transfer AoS↔SoA

Benchmark: sterownik C ABI `bench_track2_shortrange.cpp` — siatka 3D TET4 (`33,150` węzłów, `180,000` czworościanów), włączone jednocześnie: **Exchange + iDMI + bDMI + Uniaxial + Cubic + MEL + Zeeman** (`regional_drive_count = 0`).

### 4.1. Pełny przebieg dynamiczny RK4 (50 kroków = 200 etapów) i transfer `state_io`

| Pomiar | Baza A (`9ab99132d5`) | Kandydat B (`311062d617`) | Przyspieszenie (B vs A) | Bramka planu |
| :--- | ---: | ---: | ---: | :---: |
| **50 kroków RK4 (200 etapów, E2E)** | `498.562 ms` (`9.971 ms/krok`) | **`277.463 ms`** (`5.549 ms/krok`) | **`1.80×`** | PASS |
| **`state_io` 20× `copy_field_f64` (`10× M + 10× H_eff`)** | `73.621 ms` (`3.6810 ms/kopia`) | **`5.284 ms`** (`0.2642 ms/kopia`) | **`13.93×`** | `>= 5×` **PASS** |

**Parytet trajektorii po 50 krokach RK4 (Kandydat B vs Baza A):**
- `E_total`, `E_exchange`, `E_anisotropy`, `E_mel`: `rel = 0.000e+00`
- `E_dmi`: `rel = 1.622e-15`
- `m_final` (`33,150 × 3` FP64): `max_rel = 4.531e-16`
- `H_eff` (`33,150 × 3` FP64): `max_rel = 1.648e-15` (wszystkie `<< 1e-13` — **PASS**)

### 4.2. Mikrobenchmarki CUDA Events (100 powtórzeń na jądro, `33,150` węzłów / `180,000` TET4)

| Komponent | Wariant Baza A | Wariant Kandydat B | Czas Baza A [ms] | Czas Kandydat B [ms] | Przyspieszenie | Uwagi / bramki |
| :--- | :--- | :--- | ---: | ---: | ---: | :--- |
| **DMI (z energią)** | `atomicAdd` (`energy_out != null`) | `cub::BlockReduce` (`energy_out != null`) | `0.7873` | **`0.3632`** | **`2.17×`** | eliminacja globalnego `atomicAdd` |
| **DMI (etap pośredni RK)** | `atomicAdd` | `energy_out = nullptr` (predykowane) | `0.7873` | **`0.3095`** | **`2.54×`** | brak redukcji energii na etapach RK |
| **Exchange CSR** | DD (`Compensated=true`) | RK FMA (`Compensated=false`) | `0.4144` (Kand. DD: `0.4753`) | **`0.0517`** | **`8.02×`** (`9.19×` vs Kand. DD) | bramka `>= 2.5×` **PASS**; relaksacja zachowuje `Compensated=true` |
| **Fuzja `H_eff` (9 składników)** | 21 oddzielnych launchy | **1 zfuzowany kernel launch** | `1.0744` (Kand. split: `0.2275`) | **`0.0130`** | **`17.5×`** (vs Kand. split) | redukcja launchy `21 → 1` (do `28 → 1`) |
| **Transfer D2H (`795.6 KB`)** | `cudaMemcpy2D` (3×) | spakowany kernel + `cudaMemcpyAsync` | `7.8800` | **`0.1944`** | **`40.5×`** | jeden ciągły transfer PCIe |
| **Transfer H2D (`795.6 KB`)** | `cudaMemcpy2D` (3×) | `cudaMemcpyAsync` + kernel rozpakowania | `1.0896` | **`0.1729`** | **`6.30×`** | jeden ciągły transfer PCIe |

---

## 5. Wyniki A/B — Track 3: GPU Driven Response (`cuDSS`)

Benchmark: sterownik C ABI `bench_track3_dr_cudss.cpp` — przemiatania częstotliwościowe RF ($1\text{–}25\text{ GHz}$, $\alpha = 0.01$, $\mathrm{rtol} = 10^{-10}$, rzeczywiste siatki 3D TET4 MFEM ze sprzężonym potencjałem Poissona P2 dla open-airbox `poisson_robin` oraz P1 z redukcją periodyczną dla `periodic_airbox_k0`).

### 5.1. Porównanie bezpośrednie A/B: `cuDSS` vs `CPU GMRES` oraz `GPU operator + host GMRES`

| Przypadek (siatka, BC) | Zespolone DOF (`n_q + n_phi`) | Liczba freq | Solver | Czas eksportu [ms] | Czas rozwiązywania [ms] | Czas/freq [ms] | Przyspieszenie vs baseline | Szczyt VRAM `cuDSS` | Analizy / faktoryzacje | Maks. residuum `(r_q, r_phi)` | Parytet krzywej odpowiedzi `rel_l2` |
| :--- | ---: | ---: | :--- | ---: | ---: | ---: | ---: | ---: | :---: | :--- | :--- |
| **`3A_open_small`** (`252` węzłów, `70` mag, open P2 Robin) | `1,687` (`140 + 1,547`) | 8 (`1..8 GHz`) | CPU GMRES (`GMRES+AMG` Poisson `1e-12`) | — | `31 473.60` | `3 934.20` | `1.00×` | — | — (`1,138` iters) | `9.59e-11` / — | ref |
| | `1,687` | 8 (`1..8 GHz`) | **GPU `cuDSS`** | `0.84` | **`208.02`** | **`26.00`** | **`151.3×`** | `11.7 MiB` | `1 / 8` | `2.49e-16` / `1.88e-15` | **`5.32e-10`** (`4.8e-12..5.3e-10`) |
| | `1,687` | 25 (`1..25 GHz`) | **GPU `cuDSS`** | `0.81` | **`216.44`** | **`8.66`** | **`454×`** (ms/freq; CPU GMRES staje na `9 GHz`) | `11.7 MiB` | `1 / 25` | `3.54e-16` / `2.19e-15` | — |
| **`3C_periodic_k0`** (`1,014` węzłów, `338` mag, 2D periodic `k=0`) | `1,690` (`676 + 1,014`) | 25 (`1..25 GHz`) | GPU GMRES (`gpu_operator_host_krylov`) | — | `2 919.94` | `116.80` | `1.00×` | — | — (`476` iters) | `9.49e-11` / — | ref |
| | `1,690` | 25 (`1..25 GHz`) | **GPU `cuDSS`** | `0.28` | **`692.69`** | **`27.71`** | **`4.22×`** | `11.0 MiB` | `1 / 25` | `2.53e-15` / `2.89e-13` | **`3.08e-11`** |
| | `1,690` | 25 (`1..25 GHz`) | `vram_cap_auto` (`1 MiB`, `AUTO`) | `0.27` | `2 910.94` | `116.44` | jawny fallback | `11.0 > 1.0 MiB` | `1 / 0` → GMRES | `9.49e-11` | **`0.000e+00`** (vs GPU GMRES) |
| **`3C_periodic_k0_large`** (`2,646` węzłów, `882` mag, 2D periodic `k=0`) | `4,410` (`1,764 + 2,646`) | 25 (`1..25 GHz`) | GPU GMRES (`gpu_operator_host_krylov`) | — | `3 603.07` | `144.12` | `1.00×` | — | — (`482` iters) | `9.82e-11` / — | ref |
| | `4,410` | 25 (`1..25 GHz`) | **GPU `cuDSS`** | `0.95` | **`1 248.18`** | **`49.93`** | **`2.89×`** | `33.9 MiB` | `1 / 25` | `2.42e-15` / `2.90e-13` | **`3.04e-11`** |

### 5.2. Skalowanie GPU `cuDSS` dla dużych otwartych siatek 3D (`poisson_robin` P2, 25 częstotliwości `1..25 GHz`)

| Przypadek | Węzły siatki (`n_full` / `n_mag`) | Zespolone DOF (`n_q + n_phi`) | Eksport CSR [ms] | Czas 25 freq [ms] | Czas/freq [ms] | Szczyt VRAM `cuDSS` | Analizy / faktoryzacje | Maks. `r_q` | Maks. `r_phi` | Status |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | :---: | ---: | ---: | :---: |
| **`3A_open_small`** (`6×4×1`, `h=15 nm`) | `252` / `70` | `1,687` (`140 + 1,547`) | `0.81` | `216.44` | `8.66` | `11.7 MiB` | `1 / 25` | `3.54e-16` | `2.19e-15` | **25/25 PASS** |
| **`3A_open_gmres`** (`12×6×1`, `h=10 nm`) | `1,122` / `182` | `7,987` (`364 + 7,623`) | `3.43` | `965.26` | `38.61` | `63.6 MiB` | `1 / 25` | `4.34e-16` | `5.25e-15` | **25/25 PASS** |
| **`3A_open`** (`24×12×1`, `h=5 nm`) | `2,958` / `650` | `21,991` (`1,300 + 20,691`) | `9.35` | `2 690.40` | `107.62` | `203.8 MiB` | `1 / 25` | `3.01e-15` | `1.02e-14` | **25/25 PASS** |
| **`3B_open_large`** (`36×18×1`, `h=5 nm`) | `5,658` / `1,406` | `42,907` (`2,812 + 40,095`) | `17.71` | `6 076.59` | `243.06` | `449.6 MiB` | `1 / 25` | `1.15e-14` | `1.45e-14` | **25/25 PASS** |
| **`3A_open vram_cap_req`** (`1 MiB`, `REQUIRED`) | `2,958` / `650` | `21,991` | `9.13` | `325.28` (preflight) | — | `203.8 > 1.0 MiB` | `1 / 0` | — | — | **fail-closed `unavailable`** (`cudss_peak_memory_budget_exceeded`) |

---

## 6. Wniosek końcowy kwalifikacji

Wszystkie trzy ścieżki Wave 3 spełniły lub przekroczyły wymagane bramki wydajnościowe, numeryczne, pamięciowe i kontraktowe na **RTX 4080 SUPER (SM `89-real`)** wewnątrz kontenera Docker DEV worktree:
- **Track 1:** `bb_exchange_mass` kwalifikuje się jako domyślna polityka `auto` dla GPU PGBB z exchange (`6.18×–10.52×` mniej kroków, `2.82×–6.11×` szybciej, redukcja synchronizacji `-3.0/krok` i `-2.0/krok`, parytet `<= 9.0e-12`).
- **Track 2:** pełny zysk E2E RK4 `1.80×` z mikro-przyspieszeniami `2.54×` (DMI RK), `8.02×` (Exchange FMA), `17.5×` (fuzja `H_eff`), `13.93×` (`state_io`), przy parytecie `< 2e-15`.
- **Track 3:** `gpu_sparse_direct_cudss` osiąga **`151.3×–454×`** nad CPU GMRES dla open-airbox i **`2.89×–4.22×`** nad GPU GMRES dla `periodic_airbox_k0`, skalując się czysto do `42,907` zespolonych DOF (`25/25` częstotliwości w `6.08 s`, `449.6 MiB` VRAM, residua `<= 1.45e-14`, `0` zaburzonych pivotów, ścisły preflight VRAM).
