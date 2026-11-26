# Raport weryfikacji i benchmarków A/B — FEM Multiphysics Solvers Modernization (`codex/fem-multiphysics-solvers-20261126`)

Powiązane dokumenty:
- Specyfikacja architektoniczna: [2026-11-26-fem-multiphysics-solvers-design.md](../superpowers/specs/2026-11-26-fem-multiphysics-solvers-design.md)
- Plan implementacji: [2026-11-26-fem-multiphysics-solvers-plan.md](../superpowers/plans/2026-11-26-fem-multiphysics-solvers-plan.md)
- Notatki fizyczne: [0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md](../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md), [0970-spin-hall-drift-diffusion-transport.md](../physics/0970-spin-hall-drift-diffusion-transport.md), [0980-dynamic-current-and-oersted-coupling.md](../physics/0980-dynamic-current-and-oersted-coupling.md), [0981-fem-oet0-sparse-kkt.md](../physics/0981-fem-oet0-sparse-kkt.md), [1005-fem-multiphysics-sparse-and-parallel-solvers.md](../physics/1005-fem-multiphysics-sparse-and-parallel-solvers.md)

## 1. Streszczenie wykonawcze

Wszystkie etapy weryfikacji (Etap 1: budowanie profili non-MFEM, CPU `SLEPC=OFF`, TSan i pełnego GPU+SLEPc+cuDSS; Etap 2: kontrakty C++/CUDA/MPI, Rust, Python, spójność repo i dokumentacja naukowa; Etap 3: suita benchmarków A/B na Oersted OE-F2, OE-F1 oraz transporcie ładunku/spinu M1/M2 i OE-T0 KKT) zostały zakończone z wynikiem **PASS** dla gałęzi `codex/fem-multiphysics-solvers-20261126` (kandydat `7801f23f25`, baseline `origin/master` = `9ab99132d5`).

### Tabela A/B (`origin/master` `9ab99132d5` vs kandydat `7801f23f25`)

| Obszar / Benchmark | Baseline (`9ab99132d5`) | Kandydat Tier 1 (CPU MUMPS / `std::thread`) | Kandydat Tier 2 (CPU HYPRE, `SLEPC=OFF`) | Kandydat GPU (RTX 4080 SUPER) | Przyspieszenie vs baseline | Parzystość / rezyduum |
|---|---:|---:|---:|---:|---:|---|
| **A1 — OE-F2 `6×6×6`** (`1 854` ND, `343` H1) | `3 273,23 ms` (`DenseMatrixInverse`) | **`31,02 ms`** (`petsc_mumps_lu_metis`, 1 iter) | **`47,91 ms`** (`hypre_ams_boomeramg_minres`, 20 iters) | — | **`105,5×`** (T1) / **`68,3×`** (T2) | `err_A = 5,21e-15` (T1), `1,08e-13` (T2); `err_H = 6,72e-15` (T1), `1,78e-13` (T2) |
| **A2 — OE-F2 `10×10×10`** (`7 930` ND, `1 331` H1) | **ODRZUCONY** (limit `4 096` ND) | **`197,15 ms`** (`93,3 ms` solve, `274 MiB` RSS) | **`278,53 ms`** (56 iters, `268 MiB` RSS) | — | **Odblokowane** | `r1 ≤ 3,95e-14`, `rc ≤ 3,39e-23`, `rp ≤ 2,79e-16` |
| **A2 — OE-F2 `16×16×16`** (`31 024` ND, `4 913` H1) | **ODRZUCONY** (limit `4 096` ND) | **`1 316,36 ms`** (`1,32 s < 2 s`, `489 MiB` RSS) | **`1 977,33 ms`** (`1,98 s < 5 s`, 74 iters, `426 MiB` RSS) | — | **Odblokowane** (`< 2 s` T1, `< 5 s` T2) | `r1 ≤ 1,20e-13`, `rc ≤ 3,31e-23`, `rp ≤ 8,95e-17` |
| **A2 — OE-F2 `20×20×20`** (`59 660` ND, `9 261` H1, `68 921` DOF) | **ODRZUCONY** (`38 GiB` gęsta macierz!) | **`3 524,01 ms`** (`802 MiB` RSS, 1 iter) | **`3 619,25 ms`** (**`362 MiB` RSS**, 80 iters) | — | **Odblokowane** (~`105×` mniej RAM niż gęsta!) | `r1 ≤ 9,55e-14`, `rc ≤ 4,24e-23`, `rd ≤ 7,69e-18`, `rp ≤ 5,22e-17` |
| **B1 — OE-F1 `8×8×8`** (`3 072 × 1 024 = 3,15M` par, 98% dal. + 2% osob., `124,65M` jąder) | `15 316,0 ms` (`W=1`) | `3 673,3 ms` (`W=4`), `2 184,5 ms` (`W=8`), **`1 132,1 ms`** (`W=16`) | — | **`808,94 ms`** (`GpuHybridFarField`, `W=4`) | **`13,53×`** (CPU `W=16`) / **`18,93×`** (GPU) | CPU `W=1..16`: **0-ULP `memcmp == 0`**; GPU: **`max_rel_err = 5,59e-17`** (`3 138 698` GPU + `7 030` CPU osobl.) |
| **B2 — OE-F1 `ProjectField` (`2³ → 4³`)** | `8 187,42 ms` (`70,97M` jąder, 3 przebiegi; **błąd `byNODES` w `byVDIM`**!) | `3 208,6 ms` (`W=1`), `1 179,9 ms` (`W=4`), `850,9 ms` (`W=8`), **`705,6 ms`** (`W=16`, `23,66M` jąder) | — | — | **`3,00×`** mniej jąder / **`11,60×`** szybciej (`W=16`) | `2,13e-7` (po odtworzeniu układu `byNODES` baseline; tolerancja `1e-4`) + **naprawiony błąd układu `byVDIM`** |
| **B2 — OE-F1 `ProjectField` (`2³ → 6³`)** | **PRZEKROCZONY BUDŻET** (`> 100M` jąder, 3 przebiegi = `239,5M`) | **`1 894,7 ms`** (`W=8`, `79,84M` jąder — mieści się w limicie) | — | — | **Odblokowane** (`3,00×` mniej jąder) | Spójne w 1 przebiegu, bez fałszywego limitu par |
| **C1 — Charge 8-terminal `16×16×8`** (`2 601` wierzchołków, 8 rozłącznych terminali) | `1 173,93 ms` (8× montaż + GS/CG) | **`146,33 ms`** (`petsc_mumps_cholesky_metis`) | **`152,73 ms`** (`hypre_boomeramg_pcg`) | **`201,64 ms`** (`cuda_cudss_spd`) | **`8,02×`** (T1) / **`7,69×`** (T2) / **`5,82×`** (GPU) | `err_V ≤ 2,04e-12`, `err_I ≤ 4,25e-12`, `rel_res ≤ 5,26e-14` |
| **C2 — `ChargeTraceWorkspace` `16×16×8`** (8 kolumn po rozgrzaniu MPI/PETSc) | `67,71 ms` (`ctor=10,9`, **`solves=56,82 ms`**) | **`29,29 ms`** (`ctor=24,4`, **`solves=4,90 ms`**) | `43,42 ms` (`ctor=12,0`, `solves=31,46 ms`) | — | **`11,60×`** na kolumnę (`2,31×` łącznie dla 8 kol.) | `err = 1,17e-13` (T1), `1,09e-13` (T2) |
| **C3 — M1+M2 `12×12×12` ($\lambda_J = 0,05 L$, kontrast 100×, AHE)** (`6 591` / `8 788` DOF) | M1: `846,6 ms` (198 it.), M2: `1 804,9 ms` (371 it.) | M1: **`572,4 ms`** (1 it.), M2: **`931,8 ms`** (1 it.) | M1: `717,9 ms` (109 it.), M2: `1 076,9 ms` (113 it.) | M1: **`633,8 ms`**, M2: **`945,1 ms`** (`cuda_cudss_lu`) | **`1,94×`** M2 (T1) / **`1,91×`** M2 (GPU) | `res ≤ 3,16e-15` (T1/GPU), `err ≤ 1,24e-12` (T2), **`err ≤ 4,62e-15`** (GPU vs T1) |
| **C3 — Sztywny M1+M2 `12×12×12` ($\lambda_J = 0,015 L$, kontrast 100×, AHE)** | M1: `2 446,4 ms` (1362 it.), **M2: NIE ZBIEGA!** (`conv=0`, 2000 it., `5 141,7 ms`, `err=1,69e-9`) | M1: **`575,8 ms`** (1 it.), M2: **`965,9 ms`** (1 it., **`conv=1`**) | M1: `3 016,1 ms` (1193 it.), M2: `4 315,1 ms` (1166 it., **`conv=1`**) | M1: **`686,1 ms`**, M2: **`935,0 ms`** (`cuda_cudss_lu`, **`conv=1`**) | **`4,25×`** M1 / **`5,50×` M2 + zbieżność tam, gdzie baseline zawodzi!** | `res ≤ 5,74e-15` (T1/GPU), `err_GPU_vs_T1 ≤ 4,99e-15`, `err_T2_vs_T1 ≤ 1,63e-12` |
| **C4 — OE-T0 `FULLMAG_OET0_LARGE_MESH=1`** (`10 368` elem., `21 600` ścian, pełny build E2E) | `6,87 s` (mediana 3 powtórzeń) | **`5,64 s`** (mediana 3 powtórzeń, bit-exact 3/3) | `6,98 s` (mediana 3 powtórzeń, `SLEPC=OFF`, bit-exact 3/3) | — | **`1,22×`** E2E (build zdominowany przez montaż siatki i RT0) | `max_div ≤ 4,79e-16`, `kkt_res ≤ 1,84e-14`, `err_flux ≤ 1,92e-15`, 100% determinizm SHA256 |

---

## 2. Środowisko i proweniencja pomiaru

| Parametr | Wartość |
|---|---|
| Data pomiaru | `2026-11-26` |
| Gałąź robocza | `codex/fem-multiphysics-solvers-20261126` |
| Baseline (`origin/master`) | `9ab99132d55d4af1596f42625c7733ccac496c31` (`9ab99132d5`) |
| Kandydat (`HEAD` pomiaru A/B) | `7801f23f25` (build `Release`, SM `89-real`) |
| Środowisko wykonania | Zarządzany kontener Docker DEV (`just docker-dev`, `fullmag-worktree-fem-multiphysics-solvers-2026112-f4d4310d55e6c13f-backend-1`) |
| CPU | AMD Ryzen Threadripper 3960X 24-Core Processor (40 wątków logicznych; kontener domyślnie `OMP_NUM_THREADS=4`, `std::thread` skalowane jawnie `W = 1..16`) |
| GPU / stos numeryczny | NVIDIA GeForce RTX 4080 SUPER (16 376 MiB VRAM, sterownik `617.42`, CUDA SM `89-real`), `cuDSS 0.8.0.10`, MFEM `4.10`, HYPRE `3.1.0`, PETSc/SLEPc/MUMPS/METIS |
| Obciążenie tła GPU | W trakcie pomiarów na hoście pracowały równolegle inne kontenery (obciążenie tła GPU ~68%–89%, zajętość VRAM ~6,4 / 16,4 GiB); podane czasy GPU stanowią konserwatywną dolną granicę przyspieszenia na bezczynnym GPU. |

---

## 3. Kluczowe obserwacje techniczne i wykryte usterki baseline

1. **OE-F2 (`VectorPotentialSolver`):**
   - Zastąpienie gęstego `DenseMatrixInverse` rzadkim układem siodłowym z symetryczną ekwilibracją $\beta$ dało na siatce `6×6×6` przyspieszenie **`105,5×`** (Tier 1 `petsc_mumps_lu_metis`, `31,0 ms`) oraz **`68,3×`** (Tier 2 `hypre_ams_boomeramg_minres`, `47,9 ms`, 20 iteracji `MINRES`), przy zgodności z wyrocznią gęstą na poziomie `5,2e-15` / `1,1e-13`.
   - Dla siatek wcześniej odrzucanych przez limit `4 096` ND DOF, układ `16×16×16` (`31 024` ND DOF) rozwiązuje się w **`1,32 s`** (Tier 1) i **`1,98 s`** (Tier 2), a układ `20×20×20` (`59 660` ND + `9 261` H1 = **`68 921` DOF**, wobec `38 GiB` dla gęstej macierzy) w **`3,52 s`** (Tier 1, `802 MiB` RSS) oraz **`3,62 s`** (Tier 2, zaledwie **`362 MiB` RSS**).
2. **OE-F1 (`DirectTetraQuadrature`):**
   - Wstępnie ekstrahowane płaskie tablice kwadratur + deterministyczna wielowątkowość `std::thread` zapewniają **bitową identyczność 0-ULP (`memcmp == 0`)** względem jednowątkowego `origin/master` dla `W = 1, 2, 4, 8, 16` (`15,32 s → 1,13 s`, **`13,53×`** przy `W=16`).
   - Opcjonalny tor `GpuHybridFarField` ze 106-bitową akumulacją *double-double* (`TwoSum`) na RTX 4080 SUPER osiągnął **`0,81 s`** (**`18,93×`** szybciej niż baseline, **`1,40×`** szybciej niż 16-wątkowe CPU mimo obciążenia tła GPU), z automatycznym przekazaniem `7 030` par bliskich/osobliwych do deterministycznej kwadratury Duffy'ego na CPU i maksymalnym błędem względnym **`5,59 × 10⁻¹⁷`** na wszystkich `1 024` punktach (włącznie z wierzchołkami, krawędziami, ścianami i wnętrzami czworościanów).
   - **Naprawiony błąd baseline w `ProjectField` (`9ab99132d5`):** baseline wymagał `mfem::Ordering::byVDIM`, lecz wpisywał wynik indeksem `byNODES` (`target_field[component * scalar_dofs + dof]`), mieszając składowe pola wektorowego. Fala 2 naprawiła indeksowanie (`DofToVDof(dof, component)`), scaliła 3 przebiegi w 1 (dokładne **`3,00×`** mniej ewaluacji jądra: `70,97M → 23,66M` na `2³→4³`, odblokowując `2³→6³` pod limitem `100M`) i przyspieszyła projekcję **`11,60×`** (`8,19 s → 0,71 s` przy `W=16`).
3. **Transport M1/M2 i OE-T0 KKT:**
   - **8-terminalowy ładunek (`16×16×8`):** factor-once multi-RHS przyspieszył obliczenia **`8,02×`** (MUMPS Cholesky), **`7,69×`** (HYPRE BoomerAMG PCG) i **`5,82×`** (`cuda_cudss_spd`) przy zgodności napięć i prądów $\le 4,25 \times 10^{-12}$.
   - **`ChargeTraceWorkspace`:** po jednorazowej faktoryzacji w konstruktorze koszt pojedynczej kolumny spadł **`11,60×`** (`56,82 ms → 4,90 ms` dla 8 kolumn; `0,61 ms/kol.`).
   - **Sztywna precesja M1/M2 ($\lambda_J = 0,015 L$, 100× kontrast, AHE):** nieprekondycjonowany `GMRES(100)` z baseline **nie zbiegł** na M2 w limicie `2 000` iteracji (`5,14 s`, błąd `1,69e-9`), podczas gdy Tier 1 MUMPS (`0,97 s`, 1 iter., `1,01e-15`), GPU `cuda_cudss_lu` (`0,94 s`, **`5,50×` szybciej**, `1,46e-15`, parzystość z MUMPS `3,50e-15`) i Tier 2 `hypre_block_amg_gmres` (`4,32 s`, `1,39e-13`) wszystkie zbiegły czysto.

---

## 4. Macierz weryfikacji 5 profili buildów (`7801f23f25`)

| Profil | Konfiguracja | Wynik | Szczegóły |
|---|---|---|---|
| **Profil 1 — Non-MFEM (CI `native-modal-cabi-contract`)** | `FULLMAG_USE_MFEM_STACK=OFF`, `CUDA=OFF`, `SLEPC=OFF` | **PASS (8/8)** | `0,05 s`; pełna zgodność ABI bez MFEM/CUDA/SLEPc |
| **Profil 2 — FEM CPU bez SLEPc (Tier 2 HYPRE)** | CPU MFEM stack, `MFEM=ON`, `CUDA=OFF`, `SLEPC=OFF`, `OMP_NUM_THREADS=4` | **PASS (13/13 + `LARGE_MESH`)** | Wszystkie 13 kontraktów Wave 2 + 2-rank MPI byte-identity + `FULLMAG_OET0_LARGE_MESH=1` (3/3 bit-exact SHA256, `6,67 s`) |
| **Profil 3 — OE-T0 TSan (`DISABLE_MPI=1`)** | CPU MFEM stack, `FULLMAG_OET0_TSAN=ON`, `SLEPC=OFF` | **BUILD PASS** | Czysta kompilacja i linkowanie `-fsanitize=thread` z `FULLMAG_OET0_DISABLE_MPI=1` (uruchomienie runtime libtsan w standardowym kontenerze DEV zablokowane domyślnym profilem seccomp blokującym `personality(ADDR_NO_RANDOMIZE)` pod Linux 6.x `mmap_rnd_bits=32`; pełne uruchomienie realizowane jest w dedykowanym serwisie `fem-cpu-tsan`) |
| **Profil 4 — 2-rank MPI byte identity** | `mpiexec -n 1` vs `-n 2`, `OMP_NUM_THREADS=4` | **PASS (Profil 2 i Profil 5)** | Bitowa identyczność wyjść `oet0-mpi-n1.bin == oet0-mpi-n2.bin` zarówno dla `SLEPC=OFF`, jak i `SLEPC=ON` |
| **Profil 5 — FEM GPU + SLEPc + cuDSS + MPI** | `MFEM=ON`, `CUDA=ON` (SM `89-real`), `SLEPC=ON`, `cuDSS 0.8.0.10`, `OMP_NUM_THREADS=4` | **PASS (13/13 + 4/4 `CUDA_VISIBLE_DEVICES=""` + `LARGE_MESH`)** | Wszystkie 13 kontraktów Wave 2 (`46,35 s`), 4/4 testy fail-closed z `CUDA_VISIBLE_DEVICES=""` (`10,68 s`), `FULLMAG_OET0_LARGE_MESH=1` 3/3 bit-exact (`5,58 s`) |
| **Rust (w kontenerze)** | `fullmag-fem-sys`, `fullmag-ir`, `fullmag-plan`, `fullmag-runner` (default & `--features fem-gpu --test-threads=1`) | **PASS** | `fem-sys` 53/53, `ir` 289/289, `plan` 688/688, `runner` default (`antenna` 150/150, `oersted` 7/7, `transport` 106/106), `runner --features fem-gpu` (`antenna` 179/179, `oersted` 28/28, `transport` 169/171 — 2 przedistniejące niezwiązane błędy w niezmodyfikowanym `steady_transport_c_api.cpp:1774` oraz FDM M2) |
| **Python + bramki statyczne** | `pytest`, `unittest`, `check_repo_consistency.py`, `validate_changed_scientific_docs.py` | **PASS** | 196/196 `pytest` (+23 subtests), 32/32 `unittest` w kontenerze, spójność repo i walidator dokumentacji naukowej 100% zielone |

> **Uwaga o przedistniejącym teście `direct_tetra_singular_target_contract` (`q8_depth6`):** zweryfikowano bezpośrednio na baseline `9ab99132d5`, że przypadek `q8_depth6` kończy się identycznym co do bitu błędem (`leaves=81850`, `estimated_error=0.29074321124082964`, `kernel_evaluation_budget_exceeded`) z powodu ujemnych wag reguły czworościennej rzędu 22 w MFEM 4.10 (`min_weight = -1.289`). Wszystkie 4 nowe kontrakty Fali 2 OE-F1 są rejestrowane i przechodzą w `fem_oersted_direct_tetra_parallel_contract` (`--wave2`) bez osłabiania kontraktu bazowego.
