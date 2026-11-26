# Pakiet Wave 3 (PR C): P1 #6 + P2 #7 — Kwalifikacja GPU PGBB `bb_exchange_mass`, Optymalizacja Kerneli Krótkozasięgowych i GPU Driven Response `cuDSS` — Specyfikacja Architektoniczna

**Data:** 2026-11-26
**Autor:** `wave3-architect`
**Baza repozytorium:** `origin/master` (`9ab99132d55d4af1596f42625c7733ccac496c31`, zawiera PR #558 i PR #564)
**Status:** Gotowy do implementacji w roju (Faza 0 kompilujący się commit szwów + 3 równolegli autorzy z zerowym nakładaniem się plików i pełnym TDD w Fazie 1 + Faza 2 scalenie, weryfikacja i benchmarki A/B)
**Powiązany plan implementacji:** [2026-11-26-fem-pgbb-kernels-dr-plan.md](../plans/2026-11-26-fem-pgbb-kernels-dr-plan.md)

---

## 1. Cel, zakres i nadrzędne kontrakty

Pakiet **Wave 3 (PR C)** domyka trzy ortogonalne obszary wydajności i produkcjonizacji natywnego backendu FEM CUDA bez naruszania ścisłości fizycznej FP64, niezależnej certyfikacji rezyduów ani kontraktu proweniencji z `AGENTS.md` (`requested_intent` $\neq$ `resolved_execution`, bezwzględny zakaz cichego fallbacku GPU$\to$CPU przy jawnym żądaniu):

1. **Track 1 (P1 #6 — Kwalifikacja GPU PGBB `bb_exchange_mass` oraz redukcja synchronizacji i powtórnych redukcji energii):**
   - Diagnoza i naprawa **5 konkretnych defektów** utrzymujących `bb_exchange_mass` w stanie `NOT VERIFIED` (`docs/physics/0581`): sprzężona 3-składowa rekurencja skalarna CG przy jednoczesnym teście per-składowym, niedomiar `b_c^2` w jednostkach SI nanometrycznych (`h ~ 3 nm`, małe planarne `g_z`) oraz rozpiętość $10^{20}$ między wierszami powietrza a magnetycznymi, ciasny limit `kMaximumIterations = 512`, nieaktywna polityka `auto` (`== 2u`) oraz odgadywana zamiast atestowanej z runtime proweniencja w `provenance.rs`.
   - Bezpieczne włączenie `auto` dla kwalifikowanych konfiguracji GPU PGBB z atestacją runtime przez C ABI (`requested` vs `resolved` + `fallback_reason`), ścisłą gwarancją spadku Armijo i niezmienioną fizyczną krzywizną BB.
   - Eliminacja nadmiarowej drugiej redukcji energii na końcu kroku PGBB (`pgbb.cpp:1107` / `rk_step_stats.cu:464`), konsolidacja synchronizacji `bb_exchange_mass` + projekcji stycznej + `z·g` (2$\to$1), połączenie krzywizny BB i metryk następnego kroku z końcowym odczytem statystyk (2$\to$1) oraz pominięcie powtórnej redukcji energii/momentu na wejściu kolejnego kroku przy `reused_field == true` (**7$\to$4** barier/krok z preconditionerem, **6$\to$3** bez niego, **3$\to$1** redukcji energii/krok, bit-w-bit identyczne energie i momenty).

2. **Track 2 (P2 #7a — Optymalizacje krótkozasięgowych kerneli GPU):**
   - **Bramkowanie nieużywanych redukcji energii/sigmy na etapach pośrednich RK:** `energy_out = nullptr` w `rk_dmi_fields.cu:80` (usuwa globalną serializację FP64 `atomicAdd` pod jednym adresem na każdym etapie RK!) + redukcja blokowa `cub::BlockReduce` na końcowej ewaluacji energii DMI; `block_sums = nullptr` i specjalizacja szablonowa `<bool ComputeEnergy>` w `anisotropy_kernels.cu` (`rk_anisotropy_field.cu:72,108`), `magnetoelastic_kernels.cu` (`rk_magnetoelastic_field.cu:86`) i `<bool ComputeMaxSigma>` w `thermal_kernels.cu` (`rk_thermal_field.cu:71`); leniwe zerowanie `h_drive` (`h_drive_zeroed`) eliminujące 3× `cudaMemsetAsync` na każdym etapie RK w `regional_field_kernels.cu:219-225` gdy `regional_drive_count == 0`.
   - **Audyt i rozdział `gpu_relax_dd` w wymianie (`exchange_kernels.cu:115-245`):** wyłączenie programowego double-double (~90 operacji FP64/NNZ) wyłącznie na jawnych etapach dynamiki RK (zastąpione sprzętowym FP64 FMA w postaci grafowego Laplasjanu `fma(weight, m[col] - m[row], acc)` — ~6 operacji FP64/NNZ, dokładne zero dla jednorodnego `m`, zgodność `< 1e-13` z CPU/DD), przy **pełnym zachowaniu** `gpu_relax_dd` w `H_ex` dla relaksacji (`PGBB`/`NCG`) oraz `ExchangeDoubleDouble` w `exchange_energy_difference_kernel`!
   - **Fuzja sumowania `H_eff` (`rk_effective_field.cu:56-117`, `rk_oersted_field.{hpp,cu}`, `vector_field_kernels.{hpp,cu}`):** zastąpienie do 28 osobnych wywołań X/Y/Z jednym scalonym kernelem `fullmag_cuda_accumulate_heff_fused_xyz` w dokładnej dotychczasowej kolejności sumowania FP64 (bit-w-bit identyczne `H_eff`, **28$\to$1** wywołań kerneli/etap!).
   - **Usunięcie strided `cudaMemcpy2D` (`transfer_kernels.{hpp,cu}`, `component_transfer.{hpp,cpp}`, `gpu_state.{hpp,cpp}`, `state_io.cpp:91,308,421,573,627`, `stage_compute.cpp:812`, oraz porządkowanie `api.cpp:423,431` w Fazie 2):** symetryczny kernel `fullmag_cuda_unpack_aos_to_soa` i `gpu_component_upload_aos_packed` współdzielący istniejący bufor `state.packed_field_download.aos_device` (0 B dodatkowego VRAM) oraz przełączenie wszystkich produkcyjnych ścieżek poboru/zapisu pól na ciągłe `cudaMemcpyAsync` na `compute_stream` (w tym usunięcie zbędnej synchronizacji w `stage_compute.cpp:809`).

3. **Track 3 (P2 #7b — GPU Driven Response `cuDSS`):**
   - Bezpośredni solver rzadki `cuDSS` (`CUDSS_MTYPE_GENERAL`, `CUDSS_C_64F`, `CUDSS_MVIEW_FULL`) dla sprzężonego układu harmonicznego w dziedzinie częstotliwości $Z_{\text{aug}}(\omega_k) \begin{pmatrix}\hat{q} \\ \delta\hat{\phi}\end{pmatrix} = \begin{pmatrix}\hat{f} \\ 0\end{pmatrix}$ na całej siatce przemiatań RF $\omega_1, \dots, \omega_K$: **jednorazowa analiza symboliczna (`CUDSS_PHASE_ANALYSIS`)**, jednorazowa ekwilibracja Ruiza $(D_r, D_c)$, jednorazowy preflight VRAM (`CUDSS_DATA_MEMORY_ESTIMATES`), a dla każdej częstotliwości $\omega_k$ jedynie 5-µs aktualizacja $4 N_m$ wpisów diagonalnych na GPU (0 kopiowań H2D macierzy!), szybka faktoryzacja numeryczna (`CUDSS_PHASE_FACTORIZATION`), rozwiązanie (`CUDSS_PHASE_SOLVE`) oraz niezależna certyfikacja nieskalowanego rezyduum obu bloków $(r_q, r_\phi)$ na GPU bez duplikacji CSR!
   - Pełny zakres: open-airbox $k=0$ (`poisson_robin`/`poisson_dirichlet`), brak demag ($N_\phi = 0$) oraz statycznie okresowy `periodic_airbox_k0` (poprzez czysty eksport CSR z `ctx.poisson_demag`), addytywne ABI v14, polityka `auto` / `gpu_sparse_direct` / `gpu_operator_host_krylov`, jawny fail-closed dla wymuszonego `gpu_sparse_direct` i dla nieobsługiwanego niezerowego $k$ `floquet_airbox` z dynamicznym demag.

### Koordynacja między falami (Wave 1 / Wave 2 / Wave 3)
- **Wave 1 (`prism-p2-architect`)** rozszerza `dmi_kernels.cu` o obsługę `prism6` / CSR DMI oraz `pure_prism_p2`. Wave 3 ogranicza zmiany w DMI wyłącznie do kontraktu `energy_out == nullptr` w `rk_dmi_fields.cu:80` i lokalnej osłony `if (energy_out != nullptr)` + `BlockReduce` w `dmi_element_residual_kernel` (`dmi_kernels.cu:220-262`), dzięki czemu oba PR-y nakładają się czysto niezależnie od kolejności merge'a.
- **Wave 2 (`multiphysics-architect`)** dotyczy wyłącznie CPU/GPU Oersteda (`vector_potential`, `direct_tetra_quadrature`) oraz transportu M1/M2 (`steady_transport`, `conservative_current_view`) — zerowy punkt styku z plikami Wave 3.
- **Kompatybilność z buildami bez MFEM i bez CUDA:** CI `bootstrap / native-modal-cabi-contract` kompiluje `backends/fem` z `FULLMAG_HAS_MFEM_STACK=0`, `FULLMAG_HAS_CUDA_RUNTIME=0`, `FULLMAG_FEM_CUDSS_DRIVEN_ENABLED=0`. Każdy nowy symbol C++/CUDA/MFEM/cuDSS musi być ściśle osłonięty preprocesorem z deterministycznym kodem `FULLMAG_FEM_ERR_UNAVAILABLE` / `FrequencyDomainStatus::unavailable` w gałęzi `#else`.

---

## 2. Szczegółowy projekt Track 1 (P1 #6) — Kwalifikacja `bb_exchange_mass` + redukcja sync/energii PGBB

### 2.1. Audyt przyczyn stanu `NOT VERIFIED` na `origin/master` (`9ab99132d5`)

Bezpośrednia inspekcja `bb_exchange_mass.{hpp,cpp}`, `bb_exchange_mass_kernels.{hpp,cu}`, `pgbb.cpp`, `backend_step.cpp:506-519`, `provenance.rs:112-162` oraz `docs/physics/0581` ujawniła **5 konkretnych defektów**:

| # | Lokalizacja na `origin/master` | Defekt | Skutek w uruchomieniach produkcyjnych |
|---|---|---|---|
| **D1** | `bb_exchange_mass_kernels.cu:132-186` | **Sprzężona 3-składowa rekurencja skalarna PCG:** jeden skalar `rho`, `denominator`, `alpha`, `beta` dla wszystkich 3 składowych $(x,y,z)$, ale kryterium zbieżności (`:167-171`) i certyfikat rezyduum (`:201-207`) sprawdzane **osobno na każdą składową** $\|r_c\|_2 \le \text{tol}\|b_c\|_2$. | W cienkich warstwach planarnych (np. SP4, $m_z \approx 0$), $\|b_z\|_2$ bywa o $10^{-10}\text{–}10^{-12}$ mniejsze niż $\|b_x\|_2, \|b_y\|_2$. Wspólne $\alpha, \beta$ minimalizują wyłącznie $r_x, r_y$ kosztem $r_z$, powodując stagnację składowej $z$, wyczerpanie iteracji (`status=2`) lub porażkę certyfikatu (`status=5`). |
| **D2** | `bb_exchange_mass_kernels.cu:110, 118-123` oraz `bb_exchange_mass.cpp:62` | **Niedomiar `b_c^2` w jednostkach SI i rozpiętość $10^{20}$ wierszy powietrza:** dla $h=3\text{ nm}$ mamy $M_{ii} = M_s M_{\text{lumped}} \approx 2.2\times 10^{-20}\text{ A m}^2$. Przy szumie numerycznym $\|g_z\| \sim 10^{-130}\text{ A/m}$ mamy $b_{z,i}^2 \sim 10^{-300}$, więc `reduced[c] * 1e-20 == 0.0` (underflow subnormalny) wyzwala fałszywy twardy błąd `s.status = 3`! Ponadto wiersze powietrza mają przekątną `1.0` wobec $10^{-20}$ dla węzłów magnetycznych. | Fałszywe odrzucenia kroku na siatkach sub-5 nm w stanach planarnych lub przy zbieganiu do tolerancji momentu. |
| **D3** | `bb_exchange_mass_kernels.cu:13` | **Zbyt niski limit `kMaximumIterations = 512`:** dla drobnych siatek ($h \le 1\text{ nm}$) lub materiałów o dużej długości wymiany ($\ell_{\text{ex}} \sim 20\text{ nm}$) liczba uwarunkowania $\kappa(D^{-1} P_\lambda) \sim 1 + 4\lambda M_s (\ell_{\text{ex}}/h)^2$ przekracza $10^3$, wymagając $> 512$ iteracji Jacobi-PCG do osiągnięcia `1e-10`. | Przedwczesny `status=2` na drobnych siatkach mimo poprawnego, dodatnio określonego układu SPD. |
| **D4** | `bb_exchange_mass.cpp:18-21`, `cuda_bb_exchange_mass_contract.cpp:163-168` | **`auto` (`policy == 0`) zwraca `false`:** `gpu_bb_exchange_mass_enabled(ctx)` sprawdza twardo `policy == 2u`, więc ani domyślne wywołanie, ani jawne `policy="auto"` nigdy nie uruchamia preconditionera. | Użytkownicy PGBB na GPU domyślnie płacą 3–8× większą liczbę kroków i rozwiązań demag niż CPU PGBB. |
| **D5** | `crates/fullmag-runner/src/relaxation/provenance.rs:120-162` | **Proweniencja odgadywana z wejścia IR zamiast z runtime:** `resolve_fem_direct_minimizer_policy` ustawia `resolved_direction_policy` bez pytania natywnego backendu o faktyczne rozwiązanie `auto` ani powód ewentualnego nieużycia preconditionera. | Naruszenie kontraktu proweniencji `AGENTS.md` po aktywacji `auto` (brak rozróżnienia `requested="auto"` od `resolved="device_exchange_mass_preconditioned"` / `"device_tangent_gradient"` + `fallback_reason`). |

**Sprawdzenie pozostałych limitów (bez defektu, zweryfikowane):**
- **Rozmiar siatki i launch kooperatywny (`bb_exchange_mass_kernels.cu:212-228`):** `gpu_bb_pcg_grid_size` już obcina `blocks = min((3*n + 255)/256, SMs * per_sm)` i używa pętli grid-stride, więc obsługuje dowolne `n` od `1` do `(INT_MAX - 256)/3` (~715M węzłów) na każdym GPU wspierającym `cudaDevAttrCooperativeLaunch == 1`.
- **Gwarancja spadku Armijo i krzywizna BB (`pgbb.cpp:782-808, 874-920, 570-590`):** po rozwiązaniu $P_\lambda z = M_{M_s} g$, wektor $z$ jest rzutowany okresowo (`project_static_periodic_field`) i na płaszczyznę styczną z maską wolnych węzłów (`project_tangent_field(..., gpu_relax_pgbb_node_mask)` — zerującą `frozen_spins`!), a następnie weryfikowany warunkiem spadku $\langle z, g \rangle_{M_s M_{\text{lumped}}} > 0$ (z bezpiecznym restartem do surowego $g$, identycznie jak CPU `projected_gradient_bb.cpp:246-253`). Armijo używa cięciwy reprezentowalnej $\langle -H_{\text{eff}}(m_k), m_{\text{trial}} - m_k \rangle_{M_s M_{\text{lumped}}}$ (`direct_energy_increment.cpp`), a krzywizna BB wyłącznie surowych gradientów fizycznych `k[0], k[1]`. (Drobny bug diagnostyczny: `pgbb.cpp:1061` wypisuje `-energy_gradient_norm_sq` jako `predicted_directional_derivative_j_per_m_per_a` nawet gdy wybrano kierunek `z` — poprawiamy na `-active_descent_dot_gradient`, gdzie `active_descent_dot_gradient = (trial_gradient == &z) ? direction_dot_gradient : energy_gradient_norm_sq`.)

### 2.2. Projekt kwalifikowanego solvera kooperatywnego (`bb_exchange_mass_kernels.{hpp,cu}`, `bb_exchange_mass.{hpp,cpp}`)

#### A. Niezależne 3-składowe PCG ze skalowaniem $D^{-1/2}$ i dwustopniową normalizacją $\sigma_c, \tilde{\tau}_c$
Dla każdej składowej $c \in \{0, 1, 2\}$ osobno rozwiązujemy równoważny układ symetrycznie skalowany:
$$A = M_{\text{reg}} + w K_A, \quad D_i = A_{ii} > 0, \quad \tilde{A} = D^{-1/2} A D^{-1/2}$$
$$b_c = M_{M_s} g_c, \quad \sigma_c = \max_{0 \le i < n} |b_{c,i}|, \quad \tilde{b}_c = D^{-1/2} \left(\frac{b_c}{\sigma_c}\right), \quad \tilde{\tau}_c = \max_{0 \le i < n} |\tilde{b}_{c,i}|$$

1. **Pass 0 (przekątna i RHS — całkowita odporność na overflow/underflow w FP64 i bezpieczeństwo `grid.sync()`):**
   - Wyznacza $d_i = A_{ii}$, sprawdza `isfinite(d_i) && d_i > 0.0`, zapisuje `inv_sqrt_diagonal[row] = rsqrt(d_i)` (zastępuje `inverse_diagonal`; nazwa pola `inv_sqrt_diagonal` w `GpuBbPcgDevice`).
   - Wyznacza $b_{c,i} = (M_{M_s} g_c)_i$, sprawdza `isfinite(b_{c,i})`, zapisuje `w.rhs[c][row] = b_{c,i}` i wyznacza lokalne `max_abs_b[c] = fmax(...)`, a następnie deterministyczną redukcją `reduce_max<3>` otrzymuje dokładne $\sigma_c$.
   - **Niezmiennik kooperatywny:** ścieżki błędów w Pass 0 (np. niedodatnia przekątna, `NaN`/`Inf` w $d_i$ lub $b_{c,i}$) rejestrują flagę błędu przez redukcję kolektywną i ustawiają `s.status = 3` w wątku `rank == 0` po barierze, **NIGDY** nie wykonując przedwczesnego `return` ani nie pomijając żadnego `grid.sync()` (zero ryzyka deadlocka kooperatywnego!).
   - Dla każdego $c$:
     - jeżeli $\sigma_c == 0.0$ (identycznie zerowa prawa strona): `s.component_status[c] = 1`, `s.component_iterations[c] = 0`, `solution[c][row] = 0.0`, `s.scaled_rhs_norm_squared[c] = 0.0`, `s.scaled_residual_norm_squared[c] = 0.0`;
     - jeżeli $\sigma_c > 0.0$: wyznaczamy bezpiecznie $(b_{c,i}/\sigma_c) \in [-1, 1]$ i $\tilde{b}_{c,i} = (b_{c,i}/\sigma_c)\cdot \text{inv\_sqrt\_d}[i]$, a drugą redukcją `reduce_max<3>` wyznaczamy $\tilde{\tau}_c = \max_i |\tilde{b}_{c,i}|$ (sprawdzając `isfinite(tau_tilde_c) && tau_tilde_c > 0.0`). Inicjalizujemy znormalizowany wektor resztowy $\hat{r}_c = \hat{p}_c = \tilde{b}_c / \tilde{\tau}_c$, $\hat{x}_c = 0$ (w `w.residual`, `w.search`, `solution`). Ponieważ $\max_i |\hat{r}_{c,i}| = 1.0$, mamy **$1.0 \le \rho_{c,0} = \|\hat{r}_c\|_2^2 \le n$** — matematycznie wykluczony underflow i overflow dla dowolnych skończonych wartości IEEE-754! Równocześnie liczymy $\hat{B}_c^2 = \sum_i (b_{c,i}/\sigma_c)^2 \in [1, n]$ (do kryterium i certyfikatu w normie nieskalowanej $b_c$).
2. **Pętla PCG (`while (any_active && iter < kMaximumIterations)`, `kMaximumIterations = 2048`):**
   - **Matvec $\tilde{A} \hat{p}_c$:** dla każdego aktywnego $c$ (`s.component_status[c] == 0`):
     - Ponieważ $A$ działa na $y_{c,j} = D_j^{-1/2} \hat{p}_{c,j}$, wyliczamy `p[col] * inv_sqrt_d[col]` w locie w `action_scaled` (**0 dodatkowej pamięci VRAM!**), a następnie $(\tilde{A}\hat{p}_c)_i = \text{inv\_sqrt\_d}[i] \cdot (A (D^{-1/2} \hat{p}_c))_i$.
     - Równocześnie zbieramy `denom[c] += p_hat[row] * ap_hat[row]` dla $c \in \{0,1,2\}$.
   - `reduce_sum<3>(grid, denom, w.block_sums, reduced, shmem)`: wątek `rank == 0` dla każdego aktywnego $c$ weryfikuje `isfinite(denom[c]) && denom[c] > 0.0` (w przeciwnym razie `component_status[c] = 4`), oblicza niezależne `s.alpha[c] = s.rho[c] / denom[c]`.
   - **Aktualizacja $\hat{x}_c, \hat{r}_c$:** dla każdego aktywnego $c$:
     - $\hat{x}_{c,i} \mathrel{+}= \alpha_c \hat{p}_{c,i}$, $\hat{r}_{c,i} \mathrel{-}= \alpha_c (\tilde{A}\hat{p}_c)_i$;
     - zbieramy `rho_next[c] += r_hat * r_hat` **oraz** nieskalowaną znormalizowaną kwadratową normę reszty $r_{\text{phys},c,i} = (\tilde{\tau}_c / \text{inv\_sqrt\_d}[i]) \cdot \hat{r}_{c,i}$ (gdy `r_hat != 0.0`, więc wiersze powietrza z $\hat{r}=0$ nie wnoszą nic!) $\implies$ `phys_res_sq[c] += r_phys * r_phys`.
   - `reduce_sum<6>(grid, {phys_res_sq[0..2], rho_next[0..2]}, w.block_sums, reduced, shmem)`:
     - Wątek `rank == 0` dla każdego aktywnego $c$: zwiększa `s.component_iterations[c]`, sprawdza `phys_res_sq[c] <= (1e-10)^2 * s.scaled_rhs_norm_squared[c]`. Jeśli zbiegło $\to$ `s.component_status[c] = 1`! W przeciwnym razie wyznacza niezależne `s.beta[c] = rho_next[c] / s.rho[c]`, `s.rho[c] = rho_next[c]`.
     - Globalne `s.iterations = max_c s.component_iterations[c]`.
   - Aktualizacja $\hat{p}_{c,i} = \hat{r}_{c,i} + \beta_c \hat{p}_{c,i}$ wyłącznie dla wciąż aktywnych $c$.
3. **Odzyskanie fizycznego $z_c$ i niezależny certyfikat rezyduum w normie $\sigma_c$-skalowanej (odporny na underflow subnormalny!):**
   - Dla każdego $c$ ze $\sigma_c > 0$: $z_{c,i} = \sigma_c \cdot (\tilde{\tau}_c \cdot \text{inv\_sqrt\_d}[i]) \cdot \hat{x}_{c,i}$, sprawdzamy `isfinite(z_{c,i})` (błąd $\to$ `status = 3`).
   - Świeże mnożenie $A (z_c / \sigma_c) - (b_c / \sigma_c)$ (poza rekurencją CG!):
     $$\hat{r}_{\text{cert}, c, i} = \sum_j A_{ij} \left(\frac{z_{c,j}}{\sigma_c}\right) - \frac{b_{c,i}}{\sigma_c}$$
     **Kluczowe (unikanie underflowu subnormalnego $< 2.2\times 10^{-308}$):** każdy wyraz SpMV liczymy jako `a.values[j] * (z[col] / sigma_c)` (dzieląc `z[col]` przez `sigma_c` **PRZED** mnożeniem przez $M_{ij}$ i $K_{ij}$, nigdy `(a.values[j] * z[col]) / sigma_c`!), ponieważ dla $M_{ii} \sim 2\times 10^{-20}$ i $|g_z| \sim 10^{-285}$ iloczyn $M_{ii} z_j$ wpadłby w underflow do `0.0`, podczas gdy $z_j / \sigma_c \sim 1/M_{ii} \sim 10^{+20}$ i $M_{ii}(z_j/\sigma_c) \sim 1$!
   - `reduce_sum<3>` zwraca `s.scaled_residual_norm_squared[c]`, weryfikujemy dla każdego $c$ ze $\sigma_c > 0$:
     $$\text{scaled\_residual\_norm\_squared}[c] \le (10^{-8})^2 \cdot \text{scaled\_rhs\_norm\_squared}[c]$$
     Relatywne rezyduum składowej $c$ jest dokładnym ilorazem $\sqrt{\text{scaled\_residual\_norm\_squared}[c] / \text{scaled\_rhs\_norm\_squared}[c]}$ (niezależnym od $\sigma_c$!).
   - Agregowany status końcowy `s.status`: `1` gdy wszystkie 3 składowe mają `component_status[c] == 1` i przeszły certyfikat; `2` gdy którakolwiek uderzyła w `kMaximumIterations`; `3` gdy wykryto NaN/Inf/niedodatnią przekątną; `4` gdy `denom <= 0` (nie-SPD); `5` gdy certyfikat nie przeszedł.
- **Bufor redukcyjny i pojedyncza pamięć współdzielona (utrzymanie obłożenia kooperatywnego!):**
  - W `bb_exchange_mass.cpp:116`: `block_sums` zwiększamy z `4 * blocks + 4` na `6 * blocks + 6` (przyrost $< 16\text{ KiB}$ VRAM).
  - W `bb_exchange_mass_kernels.cu:114`: wyraźnie aktualizujemy wskaźnik wyniku z `4 * gridDim.x` na `double *reduced = w.block_sums + 6 * gridDim.x;`.
  - Wewnątrz `gpu_bb_pcg_kernel` deklarujemy **JEDEN** wspólny bufor `__shared__ double shmem[6][kThreads];` (`12 KiB`) i przekazujemy go do pomocników `reduce_max<3>`, `reduce_sum<3>` oraz `reduce_sum<6>` (zamiast osobnych statycznych `__shared__` w każdej instancji szablonu!), utrzymując pełne obłożenie kooperatywne SM!

#### B. Polityka `auto` / `none` / `exchange_mass` oraz atestacja runtime
Definiujemy jawną strukturę statusu w `bb_exchange_mass.hpp` i `native/include/fullmag_fem.h`:
```cpp
struct GpuBbExchangeMassStatus {
    uint32_t requested_policy = 0; // 0=auto, 1=none, 2=exchange_mass
    bool resolved_enabled = false;
    uint64_t last_iterations = 0;
    double last_relative_residual = 0.0;
    const char *solver_kind = "not_used"; // "cooperative_device_pcg" | "not_used"
    const char *preconditioner_kind = "not_used"; // "device_jacobi" | "not_used"
    const char *fallback_reason = ""; // "" | "policy_none" | "exchange_disabled" | "mfem_forms_unavailable" | "cooperative_launch_unsupported"
};
```
Reguły rozstrzygania (`gpu_bb_exchange_mass_resolve(const Context &ctx, GpuBbExchangeMassStatus &out)`):
- `policy == 1` (`none`): `resolved_enabled = false`, `fallback_reason = "policy_none"`.
- `policy == 2` (`exchange_mass`): wymaga `ctx.exchange.enabled`, gotowych sfinalizowanych `mass_form` i `exchange_form` o wymiarze `node_count`, oraz `gpu_bb_pcg_grid_size == cudaSuccess`. Niespełnienie dowolnego warunku to **twardy błąd** (`FULLMAG_FEM_ERR_UNAVAILABLE`, zero fallbacku!).
- `policy == 0` (`auto`, również domyślna wartość przy pominięciu): sprawdza te same warunki kwalifikacji; gdy wszystkie spełnione $\implies$ `resolved_enabled = true`, `solver_kind = "cooperative_device_pcg"`, `preconditioner_kind = "device_jacobi"`, `fallback_reason = ""`; gdy np. `ctx.exchange.enabled == false` (test makrospinowy / Zeeman-only bez wymiany) lub GPU bez `cudaDevAttrCooperativeLaunch` $\implies$ `resolved_enabled = false` z jawnym niepustym `fallback_reason`!
- **Atestacja w `crates/fullmag-runner/src/{types.rs,relaxation.rs,relaxation/provenance.rs,fem/execution.rs,fem/relax/finalize.rs,dispatch.rs,interactive_runtime.rs}`:**
  - W `crates/fullmag-runner/src/types.rs:3408-3419` dodajemy do `FemDirectMinimizerPolicyProvenance` pole `#[serde(default, skip_serializing_if = "Option::is_none")] pub direction_fallback_reason: Option<String>`.
  - W `provenance.rs` dodajemy `apply_native_fem_gpu_bb_preconditioner_runtime_provenance` (re-eksportowane w `relaxation.rs:27`), wywoływane w 4 miejscach gdzie istnieje utworzony `NativeFemBackend`: `fem/execution.rs:381-395`, `fem/relax/finalize.rs:404-411` (odświeżenie `final_provenance` po relaksacji obok `gpu_demag_provenance`), `dispatch.rs:3749-3760`, oraz `interactive_runtime.rs:2448-2458` (zaraz po `NativeFemBackend::create(&effective_plan)?` i `fem_gpu_execution_provenance(...)` — nie wewnątrz `:6833`, gdzie nie ma uchwytu backendu!).
  - Runner odczytuje `fullmag_fem_backend_get_gpu_bb_preconditioner_status` i zapisuje w `FemDirectMinimizerPolicyProvenance`:
    - `requested_direction_policy`: `"auto"` (gdy `Auto` lub domyślne `None` w IR dla GPU PGBB — istniejące testy jednostkowe `provenance.rs:325-375` i `cuda_bb_exchange_mass_contract.cpp:163-168` zostają świadomie zaktualizowane, aby odzwierciedlać zakwalifikowany stan `auto`!), `"none"`, albo `"exchange_mass"`,
    - `resolved_direction_policy`: z faktycznego `status.resolved_enabled` (`"device_exchange_mass_preconditioned"` vs `"device_tangent_gradient"`),
    - `resolved_linear_solver`: z `status.solver_kind`, `resolved_preconditioner`: z `status.preconditioner_kind`,
    - `direction_fallback_reason`: `Some(...)` gdy `auto` nie użyło `exchange_mass` (`None` gdy puste).

### 2.3. Eliminacja powtórnej redukcji energii i redukcja barier H2D/D2H w `pgbb.cpp` i `rk_step_stats.{hpp,cu,cpp}`

#### A. Scalony launch `bb_exchange_mass` + projekcja styczna + iloczyn spadku `z·g` (2 sync $\to$ 1 sync)
W `bb_exchange_mass.{hpp,cpp}` dodajemy funkcję dla ścieżki gorącej `pgbb.cpp` (zachowując dotychczasowe `gpu_bb_exchange_mass_solve` bez zmian dla `cuda_bb_exchange_mass_contract.cpp`!):
```cpp
bool gpu_bb_exchange_mass_solve_and_project(
    GpuBbExchangeMassWorkspace &workspace,
    const FemGpuComponentField &m_backup,
    const FemGpuComponentField &gradient,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *active_node_mask,
    bool has_periodic_reduced_nodes,
    const uint32_t *periodic_representative_nodes,
    double *scalar_workspace,
    double *scalar_result_slot,
    void *reduction_temp_storage,
    size_t reduction_temp_storage_bytes,
    int blocks,
    double step_m_per_a,
    void *compute_stream,
    TransferAudit &audit,
    double &out_direction_dot_gradient,
    std::string &error);
```
Kolejność na jednym strumieniu `compute_stream` (bez pośredniego `cudaStreamSynchronize`):
1. `cudaStreamWaitEvent(stream, w.uploaded, 0)` $\to$ `gpu_bb_pcg_launch(...)`
2. (opcjonalnie) `fullmag_cuda_relax_project_static_periodic_field(z, periodic_rep, n, stream)`
3. `fullmag_cuda_relax_project_tangent_field(m_backup, z, active_node_mask, n, stream)`
4. `fullmag_cuda_relax_energy_weighted_dot_blocks(z, gradient, ms, lumped_mass, active_node_mask, scalar_workspace, n, stream)` $\to$ `fullmag_cuda_device_sum(..., scalar_result_slot, ...)`
5. Dwa asynchroniczne `cudaMemcpyAsync` do buforów pinned host (`w.h_last_pinned`, `w.h_dot_pinned`, łącznie `sizeof(GpuBbPcgResult) + sizeof(double)`) + **1× `cudaStreamSynchronize(stream)`**!
   *(Bufor hostowy `w.h_pinned` szanuje `FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1`, dokładnie jak `reduction_workspace_memory.cpp`!)*
6. Kontrola błędów: najpierw sprawdź `w.last.status != 1` (fail closed), dopiero potem `isfinite(out_direction_dot_gradient)` (fail closed). Księgowanie audytu: dokładnie **1** `record_device_control_scalar_to_host(audit, sizeof(GpuBbPcgResult) + sizeof(double))`.

#### B. Pominięcie drugiej redukcji energii i scalenie krzywizny BB + metryk kroku $k+1$ z finalizacją statystyk (2 sync $\to$ 1 sync, 2 redukcje energii $\to$ 1)
1. **W `rk_step_stats.{hpp,cu,cpp}`:** dodajemy jawny wariant:
   ```cpp
   bool gpu_rk_finalize_step_stats_control_readback_with_scalar_tail_reuse_energy(
       Context &ctx,
       fullmag_fem_step_stats &stats,
       double *tail_scalars,
       size_t tail_count,
       std::string &reason);
   ```
   Wewnątrz `finalize_step_stats_impl(..., bool skip_energy_reduction)` (domyślnie `false` dla wszystkich pozostałych wywołujących, w tym RK i NCG!): gdy `skip_energy_reduction == true`, pomijamy wyłącznie `gpu_rk_reduce_final_energy_terms` (`rk_step_stats.cu:464`) i uruchamiamy `gpu_rk_reduce_final_observable_terms` (`:468`), odczytując `gpu.reductions.scalar_result[0 .. kGpuFinalScalarSlots + tail_count - 1]` w jednym `gpu_rk_read_control_scalar_results`, wypełniając `fullmag_fem_step_stats` oraz kopiując `tail_scalars[0 .. tail_count - 1]`! W `rk_step_stats.cpp` pod `#if !FULLMAG_HAS_CUDA_RUNTIME` wyraźnie zerujemy `tail_scalars[0 .. tail_count - 1]` (gdy `tail_scalars != nullptr && tail_count > 0`) przed delegacją do `gpu_rk_finalize_step_stats`.
2. **Warunek niezmienniczości slotów energii `[1..10]`:**
   - W `pgbb.cpp:543-630` zamieniamy synchroniczne `gpu_relax_compute_accepted_bb_curvature` na bezsynchronizacyjne `gpu_relax_enqueue_accepted_bb_curvature_and_next_norms(...)`, które:
     1. Liczy zaakceptowany gradient styczny `k[1]` oraz `block_norm_sq` (do `scalar_workspace`), redukuje `next_gradient_norm_sq` do **tail slot +3** (`scalar_result + kGpuFinalScalarSlots + 3`).
     2. Liczy `energy_weighted_dot_blocks(k[1], k[1])` (do `rk.error.x`), redukuje `next_projected_gradient_norm_sq` do **tail slot +4** (`scalar_result + kGpuFinalScalarSlots + 4`).
     3. Liczy `bb_curvature_blocks(m_backup, m, k[0], k[1])` (do `scalar_workspace, rk.error.x, rk.error.y`), redukuje `(s·s, s·y, y·y)` do **tail slots +0, +1, +2** (`scalar_result + kGpuFinalScalarSlots + {0, 1, 2}`) — **NIE dotykając slotów `0..17`!**
   - `static_assert(kGpuFinalScalarSlots + 5 <= FEM_GPU_SCALAR_RESULT_SLOTS)` (23 $\le$ 32).
   - Następnie `pgbb.cpp:1107` woła `gpu_rk_finalize_step_stats_control_readback_with_scalar_tail_reuse_energy(ctx, out_stats, tail, 5, reason)` — **1× sync**, odczytujący jednocześnie:
     - już policzone w zaakceptowanym kroku Armijo energie (`slots 1..10`),
     - świeże obserwable (`MaxHEff, MaxHDemag, MaxTorque, Mx/My/MzSum, MomentWeight`, `slots 11..17`),
     - 3 skalary krzywizny BB (`tail[0..2]`) oraz 2 normy gradientu następnego kroku (`tail[3..4]`)!
   - Następnie na hoście wywołujemy `gpu_relax_apply_bb_step_size_from_curvature(ctx, tail, reason)` (w razie niepoprawnych skalarów — ten sam atomowy rollback `gpu_relax_restore_accepted_step_after_finalize_failure`!).
   - **Krytyczna osłona rzadkich wczesnych wyjść (`pgbb.cpp:704, 733, 994`):** zachowujemy pełne `gpu_rk_finalize_step_stats_control_readback` (z `skip_energy_reduction == false`) na **WSZYSTKICH TRZECH** rzadkich wyjściach bez akceptacji próby Armijo (`:704` potwierdzenie zbieżności momentu, `:733` `gradient_norm_sq == 0.0`, `:994` `every_permitted_trial_unchanged`). Powód: kiedy krok $k+1$ wchodzi z `reused_field && token.has_cached_metrics`, `gpu_relax_compute_current_metrics` pomija `gpu_rk_reduce_final_energy_terms`, więc sloty `scalar_result[1..10]` nie są gwarantowanie świeże przy `:704` ani `:733`! Wariant `reuse_energy` jest wywoływany **wyłącznie** dla zaakceptowanej próby Armijo w `:1107`.
3. **Zero-sync na wejściu kroku $k+1$ przy `reused_field == true` (`relaxation_state.hpp`, `pgbb.cpp:340-456, 1156-1164`):**
   - Rozszerzamy `FemGpuPgbbFieldToken` w `relaxation_state.hpp` o:
     ```cpp
     bool has_cached_metrics = false;
     double cached_total_energy_j = 0.0;
     std::array<double, kFemGpuAcceptedEnergyTermSlots> cached_energy_terms_j{};
     double cached_max_torque_apm = 0.0;
     double cached_max_effective_field_amplitude = 0.0;
     double cached_max_demag_field_amplitude = 0.0;
     double cached_gradient_norm_sq = 0.0;
     double cached_projected_gradient_norm_sq = 0.0;
     ```
   - Na końcu kroku $k$ (`pgbb.cpp:1160`), gdy `pgbb_accepted_field.valid = true`, zapisujemy do tokena dokładne wartości już dostępne z zaakceptowanego kroku bez eksponowania surowego bufora `scalars[]`: `armijo_result.trial_snapshot.total_energy_j`, `armijo_result.trial_snapshot.terms_j`, `out_stats.max_torque_Apm`, `out_stats.max_effective_field_amplitude`, `out_stats.max_demag_field_amplitude`, oraz `tail[3]` (`next_gradient_norm_sq`) i `tail[4]` (`next_projected_gradient_norm_sq`) — z pełną walidacją `std::isfinite`!
   - Na wejściu kroku $k+1$, gdy `reused_field == true && token.has_cached_metrics`:
     - Pomijamy `h_eff`, pomijamy `gpu_rk_reduce_final_energy_terms`, pomijamy `gpu_rk_reduce_final_field_metric_terms` oraz pomijamy readback D2H (**0 barier H2D/D2H na wejściu kroku!**).
     - Kolejkujemy wyłącznie lekki kernel `fullmag_cuda_relax_tangent_gradient_and_norm_blocks(m, h_eff, ..., gradient=k[0], ...)` na strumieniu (aby zmaterializować `k[0]` bez zakładania, że `k[1]` przetrwało między krokami!), a wszystkie pola `current_metrics` wypełniamy z zapisanego, jednorazowego tokena!
     - Jeżeli token jest nieprawidłowy lub unieważniony (np. krok 0, po rafinacji, po zmianie pola zewnętrznego/stanu przez `gpu_relax_note_external_state_change`) $\to$ ścieżka pełna bez żadnych zmian.

#### C. Bilans wydajnościowy pojedynczego kroku PGBB w stanie ustalonym ($k \ge 1$, 0 backtracków)
| Metryka | Przed (`9ab99132d5`) | Po Wave 3 Track 1 | Redukcja |
|---|---|---|---|
| Bariery `cudaStreamSynchronize` (bez preconditionera) | 6 | **3** | **−50%** |
| Bariery `cudaStreamSynchronize` (z `bb_exchange_mass`) | 7 | **4** | **−43%** |
| Wywołania `gpu_rk_reduce_final_energy_terms` / krok | 3 | **1** | **−67%** |
| Zbieżność iteracyjna (drobna siatka SP4, $h \le 3\text{ nm}$) | surowy gradient (`auto` off) | `bb_exchange_mass` (`auto` on) | **3–8× mniej kroków i rozwiązań demag** |
| Zgodność energii, momentu i dowodu Armijo | referencja | **bit-w-bit** (ten sam ciąg kroków dla `policy="none"`) / $\le 10^{-9}$ równowagi dla `exchange_mass` | 0 regresji |

---

## 3. Szczegółowy projekt Track 2 (P2 #7a) — Optymalizacje krótkozasięgowych kerneli GPU

### 3.1. Bramkowanie redukcji na etapach pośrednich RK i leniwe zerowanie `h_drive`

Wszystkie końcowe redukcje energii na zaakceptowanym stanie kroku RK są wykonywane niezależnie w `rk_energy_reductions.cu` (`rk_dmi_energy_reductions.cu`, `rk_anisotropy_energy_reductions.cu`, `rk_magnetoelastic_energy_reductions.cu`). Zapisy do `gpu.reductions.scalar_workspace` z etapów pośrednich RK są w 100% martwe (nigdy nieczytane).

1. **DMI (`rk_dmi_fields.cu:80`, `dmi_kernels.cu:1-25, 116-265`):**
   - W `rk_dmi_fields.cu:80`: zastąpić `gpu.reductions.scalar_workspace` wartością `nullptr`!
   - W `dmi_kernels.cu`:
     - **Dodać `#include <cub/cub.cuh>`** na górze pliku (obecnie brakuje tego nagłówka!).
     - W `dmi_element_residual_kernel` (`:116-262`):
       - **KRYTYCZNE (zapobieganie deadlockowi GPU na `__syncthreads` wewnątrz `cub::BlockReduce`!):** zamienić wszystkie **4 wczesne `return;`** (`:141` `e >= element_count`, `:144` element niemagnetyczny, `:156` zdegenerowany czworościan, `:167` `elem_d == 0`) na predykat `bool active = ...; double energy = 0.0; if (active) { ... }`, aby **KAŻDY wątek w bloku** bezwarunkowo dochodził do kolektywnego `cub::BlockReduce<double, kBlockSize>::Sum(energy)` gdy `ComputeEnergy == true`!
       - Specjalizacja `template <bool ComputeEnergy>` wywoływana z `fullmag_cuda_dmi_field_energy` na podstawie `energy_out != nullptr`: dla `ComputeEnergy == false` całkowicie pomijamy gęstość energii, pamięć współdzieloną `BlockReduce` i `atomicAdd` (zero gałęzi w pętli elementowej i zero zbędnych rejestrów!); dla `ComputeEnergy == true` (wyłącznie końcowa ewaluacja w `rk_dmi_energy_reductions.cu`) sumujemy w bloku przez `cub::BlockReduce<double, kBlockSize>::Sum(energy)` i wykonujemy **1× `dmi_atomic_add_double(energy_out, block_sum)` na blok** (zamiast 256× na wątek — 256× mniejsza kontencja atomowa przy dokładności $\le 10^{-14}$).
2. **Anizotropia jednoosiowa i kubiczna (`rk_anisotropy_field.cu:72,108`, `anisotropy_kernels.{hpp,cu}`):**
   - W `anisotropy_kernels.cu`: przekształcić `uniaxial_anisotropy_field_energy_blocks_kernel` oraz `cubic_anisotropy_field_energy_blocks_kernel` w szablony `template <bool ComputeEnergy>` (wybór w wrapperze `block_sums != nullptr`). Dla `ComputeEnergy == false` pomijamy `energy_density * lumped_mass[i]`, `__shared__ BlockReduce::TempStorage`, `BlockReduce::Sum` oraz zapis do `block_sums` (redukując również użycie pamięci współdzielonej i barierę `__syncthreads`!).
   - W `rk_anisotropy_field.cu:72` i `:108`: przekazywać `nullptr` zamiast `gpu.reductions.scalar_workspace`.
3. **Magnetoelastyczność (`rk_magnetoelastic_field.cu:86`, `magnetoelastic_kernels.{hpp,cu}`):**
   - Analogiczny szablon `template <bool ComputeEnergy>` w `magnetoelastic_field_energy_blocks_kernel` (obecnie w `:83` nie było nawet sprawdzenia `block_sums != nullptr` — dereferencja z `nullptr` skończyłaby się crash'em!).
   - W `rk_magnetoelastic_field.cu:86`: przekazywać `nullptr`.
4. **Pole termiczne Browna (`rk_thermal_field.cu:71`, `thermal_kernels.{hpp,cu}`):**
   - Szablon `template <bool ComputeMaxSigma>` w `thermal_field_blocks_kernel` (obecnie `:92` uruchamiało `cub::BlockReduce::Reduce(..., cub::Max())` nawet przy `block_max_sigma == nullptr`!).
   - W `rk_thermal_field.cu:71`: przekazywać `nullptr` (sprawdzić: czy cokolwiek czyta `block_max_sigma` z `rk_thermal_field.cu`? Nie — `rk_step_stats` nie redukuje `sigma` z `scalar_workspace`).
5. **Napędy regionalne (`field_buffer_state.hpp`, `field_buffer_memory.cpp:14-58`, `regional_field_kernels.cu:113-135, 219-229`):**
   - **KRYTYCZNE (unikanie niezainicjowanego śmiecia VRAM z surowego `cudaMalloc`!):** `gpu_field_buffers_allocate` (`field_buffer_memory.cpp:14-33`) alokuje `fields.h_drive` przez `cudaMalloc` i go **NIE zeruje**. Dlatego domyślna wartość w `FemGpuFieldBufferDeviceState` (`field_buffer_state.hpp:44`) **MUSI wynosić `bool h_drive_zeroed = false;`** (NIGDY `true`!).
   - W `field_buffer_memory.cpp`: zarówno w `gpu_field_buffers_allocate`, jak i `gpu_field_buffers_free` ustawiać `fields.h_drive_zeroed = false;`.
   - W `regional_field_kernels.cu`:
     - W `gpu_regional_field_drive_destroy` (`:113`): ustawić `fields.h_drive_zeroed = false;`.
     - W `gpu_regional_field_drive_upload` (`:130-135`, gdy `drive_count == 0`): ustawić `fields.h_drive_zeroed = true;` **dopiero po** wyzerowaniu `h_drive` przez `cudaMemset`/`cudaMemsetAsync` (w przeciwnym razie pozostaje `false`, aby pierwsze wywołanie na etapie RK wyzerowało bufor raz).
     - W `gpu_regional_field_drive_materialize_and_accumulate` (`:219-229`):
       ```cpp
       if (fields.regional_drive_count == 0) {
           if (fields.h_drive_zeroed) {
               return true; // 0 cudaMemsetAsync per RK stage!
           }
           const bool ok = /* 3x cudaMemsetAsync */;
           if (ok) { fields.h_drive_zeroed = true; }
           return ok;
       }
       fields.h_drive_zeroed = false;
       ```
     - Pierwsze wywołanie po alokacji lub usunięciu napędów zeruje `h_drive` dokładnie raz i ustawia `h_drive_zeroed = true`, a wszystkie kolejne etapy RK wykonują 0 `cudaMemsetAsync` — odczyty obserwabli `FULLMAG_FEM_OBSERVABLE_H_DRIVE` są zawsze deterministycznie równe `0.0`!

### 3.2. Audyt `gpu_relax_dd` i dwutorowa akumulacja wymiany (`exchange_kernels.{hpp,cu}`, `rk_exchange_dispatch.{hpp,cu}`, `rk_rhs_runtime.cu`)

**Uzasadnienie numeryczne (z `git show 7d20569e8a`):**
- Software double-double (`gpu_relax_dd::two_diff` + `scale` + `add`) zostało wprowadzone w `7d20569e8a` na potrzeby ścisłych dowodów przyrostu energii Armijo w relaksacji (`relaxation_energy_derivative_contract.cpp`, gdzie weryfikuje się $\langle g, \delta m \rangle = \Delta E$ z dokładnością $10^{-15}$).
- W jawnych etapach dynamiki RK (`Heun`, `RK4`, `RK23`, `RK45`), koszt `gpu_relax_dd` wynosi **~90 instrukcji FP64 / NNZ** (30 na składową) wobec **6 instrukcji FP64 / NNZ** (1 odejmowanie + 1 sprzętowe `fma` na składową) w zwykłym FP64 — **~15× narzutu ALU FP64** i podwojenie ciśnienia rejestrowego na GPU z niskim stosunkiem FP64:FP32 (RTX 4080 SUPER: 1:64)!
- Kluczowa własność stabilności numerycznej: forma różnicowa grafowego Laplasjanu `fma(weight, mx[col] - mx[row], kx)` nadal zachowuje:
  1. **dokładne `0.0`** na stanach jednorodnych ($\mathbf{m}_j = \mathbf{m}_i \implies m_j - m_i = 0.0$ dokładnie w IEEE-754!),
  2. **lemat Sterbenza** dla sąsiednich spinów o małym kącie ($\frac{1}{2} m_i \le m_j \le 2 m_i \implies m_j - m_i$ bez błędu zaokrąglenia!),
  3. błąd względny sumy po stopniu węzła $d \sim 14$ ograniczony przez $d \cdot \varepsilon_{\text{mach}} \approx 3\times 10^{-15} \ll 10^{-13}$ (wymagany próg parytetu RK!).

**Rozwiązanie (bez żadnego kompromisu dla relaksacji!):**
- W `exchange_kernels.cu`: przekształcamy `legacy_sparse_exchange_xyz_kernel` (`:215-260`), `legacy_sparse_exchange_kernel` (`:170-213`) oraz `periodic_reduced_exchange_kernel` (`:489-540`, wywoływany przez `fullmag_cuda_periodic_reduced_exchange_xyz` w `:657-705`) w `template <bool Compensated>`:
  - `Compensated == true`: zachowuje dokładnie obecne `gpu_relax_dd::add(..., scale(two_diff(...), weight))` (zero zmian dla relaksacji!).
  - `Compensated == false`: wykonuje:
    ```cpp
    double kx = 0.0, ky = 0.0, kz = 0.0;
    const double mx_row = mx[row], my_row = my[row], mz_row = mz[row];
    for (uint32_t cursor = begin; cursor < end; ++cursor) {
        const uint32_t col = csr_col_indices[cursor];
        if (col == static_cast<uint32_t>(row)) continue;
        const double weight = csr_values[cursor];
        kx = fma(weight, mx[col] - mx_row, kx);
        ky = fma(weight, my[col] - my_row, ky);
        kz = fma(weight, mz[col] - mz_row, kz);
    }
    hx[row] = material_scale * kx * inv_mass;
    hy[row] = material_scale * ky * inv_mass;
    hz[row] = material_scale * kz * inv_mass;
    ```
    (Ponadto odczytujemy `mx_row/my_row/mz_row` do rejestrów przed pętlą zamiast 3× ładowania z L1 na każde NNZ!)
- Dodajemy opcjonalny parametr `bool compensated_accumulation = true` na końcu sygnatur `fullmag_cuda_legacy_sparse_exchange_xyz`, `fullmag_cuda_legacy_sparse_exchange`, `fullmag_cuda_periodic_reduced_exchange_xyz` oraz `gpu_rk_compute_legacy_sparse_exchange` (domyślnie `true` dla 100% wstecznej zgodności wywołań bezpośrednich!).
- W `rk_rhs_runtime.cu`:
  - `gpu_rk_compute_rhs_for_magnetization` oraz `gpu_rk_compute_effective_field_for_magnetization` (dynamika RK i końcowe odświeżenie RK) przekazują `compensated_accumulation = false`!
  - `gpu_rk_compute_effective_field_for_magnetization_fresh_demag` (wywoływane wyłącznie przez `pgbb.cpp`, `nonlinear_cg.cpp` i `direct_energy_increment.cpp`) przekazuje `compensated_accumulation = true`!
- `exchange_energy_difference_kernel` (`ExchangeDoubleDouble` / `exchange_polarized_edge_term`) pozostaje **w 100% nietknięty**.

### 3.3. Fuzja sumowania `H_eff` (`vector_field_kernels.{hpp,cu}`, `rk_effective_field.cu`, `rk_oersted_field.{hpp,cu}`)

Zastępujemy do 28 osobnych wywołań X/Y/Z w `rk_effective_field.cu:56-117` + `rk_oersted_field.cu:85-95` jednym scalonym kernelem XYZ w `vector_field_kernels.{hpp,cu}`:

```cpp
struct FemGpuHeffAccumulateTerms {
    const double *h_ex_x = nullptr, *h_ex_y = nullptr, *h_ex_z = nullptr;
    const double *h_demag_x = nullptr, *h_demag_y = nullptr, *h_demag_z = nullptr;
    const double *h_ext_x = nullptr, *h_ext_y = nullptr, *h_ext_z = nullptr;
    const double *h_drive_x = nullptr, *h_drive_y = nullptr, *h_drive_z = nullptr;
    const double *h_ani_x = nullptr, *h_ani_y = nullptr, *h_ani_z = nullptr;
    const double *h_cubic_x = nullptr, *h_cubic_y = nullptr, *h_cubic_z = nullptr;
    const double *h_dmi_x = nullptr, *h_dmi_y = nullptr, *h_dmi_z = nullptr;
    const double *h_bulk_dmi_x = nullptr, *h_bulk_dmi_y = nullptr, *h_bulk_dmi_z = nullptr;
    const double *h_oe_src_x = nullptr, *h_oe_src_y = nullptr, *h_oe_src_z = nullptr;
    double *h_oe_out_x = nullptr, *h_oe_out_y = nullptr, *h_oe_out_z = nullptr;
    double h_oe_scale = 1.0;
    const double *h_mel_x = nullptr, *h_mel_y = nullptr, *h_mel_z = nullptr;
    const double *h_therm_x = nullptr, *h_therm_y = nullptr, *h_therm_z = nullptr;
    uint32_t active_mask = 0; // bitmaska obecności każdego składnika (zero gałęzi na nieaktywnych wariantach lub czysty test bitu w rejestrze)
};

void fullmag_cuda_accumulate_heff_fused_xyz(
    const FemGpuHeffAccumulateTerms &terms,
    double *h_eff_x,
    double *h_eff_y,
    double *h_eff_z,
    int N,
    cudaStream_t stream = nullptr);
```

- **Ścisła kolejność sumowania (bit-w-bit identyczna ze ścieżką rozbitą):**
  1. `sx = h_ex_x[i] + h_demag_x[i]`; jeśli `EXT`: `sx += h_ext_x[i]` (identycznie z `accumulate_heff_kernel`: `h_ex[i] + h_demag[i] + (has_ext ? h_ext[i] : 0.0)`!).
  2. W dokładnej kolejności z `rk_effective_field.cu:62-116`: `h_drive` $\to$ `h_ani` $\to$ `h_cubic_ani` $\to$ `h_dmi` $\to$ `h_bulk_dmi` $\to$ `h_oe` (gdy cylinder: `oe_x = h_oe_scale * h_oe_src_x[i]; h_oe_out_x[i] = oe_x; sx += oe_x;`, gdy jawne pole: `sx += h_oe_src_x[i]`) $\to$ `h_mel` $\to$ `h_therm`.
  3. Zapis pojedynczy: `h_eff_x[i] = sx; h_eff_y[i] = sy; h_eff_z[i] = sz;`.
- **Napędy regionalne:** jeżeli `fields.regional_drive_count > 0`, wywołujemy `gpu_regional_field_drive_materialize_and_accumulate(..., accumulate_into_h_eff=false)` przed scalonym kernelem i ustawiamy bit `DRIVE` (łącznie 2 wywołania); jeżeli `regional_drive_count == 0`, leniwy guard pomija `cudaMemsetAsync` (0 wywołań), więc cały `gpu_rk_accumulate_effective_field` to **dokładnie 1 launch kernela na etap RK**!
- **Podział odpowiedzialności z `rk_oersted_field.{hpp,cu}` i zgodność z testami kontraktu:** `rk_oersted_field.cu` eksportuje nowe `gpu_rk_prepare_oersted_heff_term(Context &ctx, double evaluation_time_s, FemGpuHeffAccumulateTerms &terms, std::string &reason)` (zachowując całą logikę skalowania czasowego i walidacji Oersteda w `rk_oersted_field.cu`!) oraz **wyraźnie zachowuje istniejące `gpu_rk_accumulate_oersted_field`** (dla 100% zgodności z `oersted_contract.cpp:593-595` i `source_facade_cuda_kernels_contract.cpp:1405-1426`!). `rk_effective_field.cu` woła `gpu_rk_prepare_oersted_heff_term` przed scalonym kernelem. Dotychczasowe `fullmag_cuda_accumulate_heff` i `fullmag_cuda_add_field_inplace` pozostają wyeksportowane w `vector_field_kernels.{hpp,cu}`. W `source_facade_cuda_kernels_contract.cpp` aktualizujemy **oba** miejsca: `:1398-1404` (sprawdzenie `fullmag_cuda_accumulate_heff_fused_xyz` i `gpu_rk_prepare_oersted_heff_term`) oraz `:2007-2009` (`effective.find("evaluation_time_s, false")` zamiast `"evaluation_time_s, true"`, ponieważ `h_drive` sumuje teraz scalony kernel!).

### 3.4. Zastąpienie strided `cudaMemcpy2D` kernelami device `pack_soa_to_aos` / `unpack_aos_to_soa`

**Audyt na `origin/master`:**
- `FemGpuState` w `gpu_state.cpp:909-924` już alokuje trwały bufor stagingowy na urządzeniu `state.packed_field_download.aos_device` o rozmiarze `3 * node_count * sizeof(double)` (0 dodatkowego VRAM!).
- `transfer_kernels.cu` już posiada `fullmag_cuda_pack_soa_to_aos` i `gpu_state_download_component_aos_packed`, ale **6 produkcyjnych ścieżek** wciąż wywołuje wolne 3× 8-bajtowe strided `cudaMemcpy2D`:
  1. `state_io.cpp:91` (`copy_torque_observable_f64` — `H_eff`),
  2. `state_io.cpp:308` (`context_sync_gpu_magnetization_to_host` — `m`),
  3. `state_io.cpp:421` (`context_copy_field_f64` — wszystkie pola obserwabli),
  4. `state_io.cpp:573` (`context_copy_linearization_field_f64` — pola do linearyzacji/modal/DR),
  5. `state_io.cpp:600,627` (`context_upload_magnetization_f64` — upload magnetyzacji AoS$\to$SoA przez `gpu_state_upload_magnetization_aos`),
  6. `stage_compute.cpp:812` (`recover_device_demag_visual_field` — pełnodomenowe `H_demag visual`, które dodatkowo wykonuje zbędny `cudaStreamSynchronize` w `:809` tuż przed synchronicznym `cudaMemcpy2D`!).
  *(Ponadto w Fazie 2 porządkujemy również `api.cpp:423,431` w `device_apply_demag_tangent_with_potential`: usunięcie zbędnego syncu w `:423` + przełączenie `:431` na `gpu_state_download_component_aos_packed`.)*

**Projekt:**
1. W `transfer_kernels.{hpp,cu}`: dodać symetryczny kernel `fullmag_cuda_unpack_aos_to_soa(const double *aos_xyz, double *x, double *y, double *z, int N, cudaStream_t stream)` (odwrotność `pack_soa_to_aos_kernel`: `x[i] = aos[3*i]; y[i] = aos[3*i+1]; z[i] = aos[3*i+2];`, wymuszający niezerowy strumień `stream != nullptr` tak jak `pack_soa_to_aos`).
2. W `component_transfer.{hpp,cpp}` oraz `gpu_state.{hpp,cpp}`:
   - Dodać `gpu_component_upload_aos_packed(lifecycle, field, aos_device_scratch, aos_dof_len, raw_stream, xyz, len, label, audit, error)` (1× ciągły `cudaMemcpyAsync(H2D)` $\to$ `fullmag_cuda_unpack_aos_to_soa` $\to$ `cudaStreamSynchronize(stream)` $\to$ `record_host_to_device`).
   - Dodać `gpu_state_download_magnetization_aos_packed(state, out_m_xyz, audit, raw_stream, error)` (ustawiający `state.residency.host_state = FemGpuSyncState::HostClean`) oraz `gpu_state_upload_magnetization_aos_packed(state, m_xyz, len, audit, raw_stream, error)` (zachowujący identyczne unieważnienia FSAL/endpoint/relaxation jak `gpu_state.cpp:165-172`).
   - **Zachowanie istniejących fasad:** `gpu_state_upload_magnetization_aos` i `gpu_state_download_magnetization_aos` nadal delegują do `gpu_magnetization_{upload,download}_aos` (100% zgodność z `gpu_state_runtime_contract.cpp:315-335` i `source_facade_gpu_state_contract.cpp:361-386`!).
3. Przełączyć wszystkie 6 produkcyjnych ścieżek (Track 2 w Fazie 1, plus `api.cpp:423,431` w Fazie 2):
   - `state_io.cpp:91` $\to$ `gpu_state_download_component_aos_packed(..., ctx.gpu_state.cuda.compute_stream, ...)`
   - `state_io.cpp:308` $\to$ `gpu_state_download_magnetization_aos_packed(..., ctx.gpu_state.cuda.compute_stream, ...)`
   - `state_io.cpp:421` $\to$ `gpu_state_download_component_aos_packed(..., ctx.gpu_state.cuda.compute_stream, ...)`
   - `state_io.cpp:573` (`context_copy_linearization_field_f64`) $\to$ `gpu_state_download_component_aos_packed(..., ctx.gpu_state.cuda.compute_stream, ...)`
   - `state_io.cpp:600,627` (`context_upload_magnetization_f64`) $\to$ `gpu_state_upload_magnetization_aos_packed(..., ctx.gpu_state.cuda.compute_stream, ...)` gdy `compute_stream != nullptr` i `packed_field_download.aos_device != nullptr`.
   - `stage_compute.cpp:808-818` $\to$ usunąć zbędny `cudaStreamSynchronize(stream)` z `:809` i wywołać bezpośrednio `gpu_state_download_component_aos_packed(ctx.gpu_state.device, ctx.gpu_state.device.demag_poisson.poisson_gradient, ctx.demag.h_visual_xyz, ctx.transfer_audit.audit, raw_stream, "H_demag visual", reason)`!
4. Zachować istniejące `fullmag_cuda_upload_aos_to_soa` i `fullmag_cuda_download_soa_to_aos` (wraz z fallbackiem gdy brak przypisanego strumienia w minimalnych testach jednostkowych `gpu_state_runtime_contract.cpp`) — pełna zgodność z `gpu_state_runtime_contract.cpp:350-374` i `source_facade_cuda_kernels_contract.cpp:102-196`!

---

## 4. Szczegółowy projekt Track 3 (P2 #7b) — GPU Driven Response `cuDSS`

### 4.1. Dokładny układ równań liniowych, konwencje znaków i struktura macierzy

Na podstawie `docs/physics/0700-frequency-domain-linearized-llg.md`, `backends/fem/src/frequency_domain/operator_terms.cpp:534-685`, `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu:560-638` oraz `backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp:501-576`:

Dla każdej częstotliwości $f_k > 0$ ($\omega_k = s_\phi \cdot 2\pi f_k$, gdzie $s_\phi = +1$ dla `exp_i_omega_t`, $s_\phi = -1$ dla `exp_minus_i_omega_t`) układ w dziedzinie częstotliwości w $N_q = 2 N_m$ zmiennych stycznych $\hat{q} \in \mathbb{C}^{N_q}$ ma postać:
$$\big(K - i \omega_k M\big) \hat{q} = \hat{f}$$
(sprawdzenie rozbicia rzeczywistego w `production_cpu_driven_response.cpp:537, 575`: $\text{Re}[(K - i\omega_k M)(x_r + i x_i)] = K x_r + \omega_k M x_i$, $\text{Im}[(K - i\omega_k M)(x_r + i x_i)] = K x_i - \omega_k M x_r$ — dokładna zgodność co do znaku!).

1. **Blok masowo-tłumienny $M \in \mathbb{R}^{N_q \times N_q}$** (ściśle blokowo-diagonalny $2\times 2$ na węzeł magnetyczny $j$):
   $$M_{jj} = \begin{pmatrix} 1 & \alpha_j \\ -\alpha_j & 1 \end{pmatrix}, \qquad -i\omega_k M_{jj} = \begin{pmatrix} -i\omega_k & -i\omega_k \alpha_j \\ +i\omega_k \alpha_j & -i\omega_k \end{pmatrix}$$
2. **Blok sztywności bez demag $K_{\text{loc}} \in \mathbb{R}^{N_q \times N_q}$:**
   Dla każdego węzła magnetycznego $j$ operator precesji $R_{\gamma_0} = \gamma_0 \begin{pmatrix} 0 & 1 \\ -1 & 0 \end{pmatrix}$ działa na sumę liniowych operatorów pola efektywnego $\delta H_{\text{loc}}(\hat{q}) = \delta H_{\text{ex}} + \delta H_{\text{zeeman}} + \delta H_{\text{ani}} + \delta H_{\text{dmi}}$:
   - **Wymiana (`exchange_edges`):** dla krawędzi $(i,j)$ ze sztywnością $w_{ij}$ i macierzą przejścia bazy stycznej $R_{ij} = \begin{pmatrix} e_{1,i}\cdot e_{1,j} & e_{1,i}\cdot e_{2,j} \\ e_{2,i}\cdot e_{1,j} & e_{2,i}\cdot e_{2,j} \end{pmatrix}$ bloki $(i,i), (j,j)$ otrzymują $+w_{ij} I_2$, blok $(i,j)$ otrzymuje $-w_{ij} R_{ij}$, blok $(j,i)$ otrzymuje $-w_{ij} R_{ij}^T$; całość mnożona lewostronnie przez $R_{\gamma_0}$.
   - **Zeeman (`h_ext_a_per_m`):** węzłowy blok diagonalny $-(\mathbf{H}_{\text{ext}}\cdot \mathbf{m}_{0,j}) I_2$, mnożony lewostronnie przez $R_{\gamma_0}$.
   - **Anizotropia jednoosiowa (`uniaxial_anisotropy_axis`, `uniaxial_anisotropy_field_a_per_m`):** węzłowy blok $H_K u_j u_j^T$ ($u_j = (u\cdot e_{1,j}, u\cdot e_{2,j})^T$), mnożony lewostronnie przez $R_{\gamma_0}$.
   - **DMI (`dmi_elements`):** dokładne liniowe elementy 4-węzłowe (`interfacial` i `bulk`) zrzutowane przez $-1/(\mu_0 M_{s,j} V_j)$ w bazę $(e_{1,j}, e_{2,j})$ i pomnożone lewostronnie przez $R_{\gamma_0}$ (identycznie z `mfem_dmi_operator.cpp` i `driven_response_gpu.cu:662-840`).
3. **Sprzężona dynamiczna demagnetyzacja (open-airbox `poisson_robin`/`poisson_dirichlet` oraz `periodic_airbox_k0`):**
   W `apply_demag_tangent` (`api.cpp:6627` $\to$ `ctx.poisson_demag` / `operators.cpp`) odpowiedź demagnetyzacyjna jest dokładnym złożeniem 3 liniowych macierzy CSR:
   $$b_\phi = D_{\text{rhs}} E_{\text{lift}} \hat{q} \equiv R_{\phi q} \hat{q}, \qquad P \, \delta\hat{\phi} = b_\phi, \qquad \delta H_{\text{tan,demag}} = E_{\text{lift}}^T G_{\text{rec}} \delta\hat{\phi}$$
   gdzie $E_{\text{lift}}$ odwzorowuje węzeł magnetyczny $j$ (mapowany na globalny węzeł siatki `magnetic_node_indices[j]`) do 3D wektora $q_0 e_{1,j} + q_1 e_{2,j}$, $P$ pochodzi bezpośrednio z `ctx.poisson_demag.periodic_reduced_ready ? ctx.poisson_demag.periodic_matrix : ctx.poisson_demag.poisson_bc_op` (identycznie jak w `operators.cpp:615-618` i `demag_poisson_boundary.cpp:202,240` — w `PoissonDemagRuntimeState` nie ma `a_form`, a `poisson_bilinear` nie ma jeszcze warunków Robina ani eliminacji BC!), $D_{\text{rhs}}$ to `rhs_{x,y,z}`, a $G_{\text{rec}}$ to `recovery_{x,y,z}`.
   **KRYTYCZNE (zerowanie wierszy `ess_tdofs` w $-R_{\phi q}$):** ponieważ `operators.cpp:873-900` nie zeruje wierszy `ess_tdofs` w macierzy `rhs` (robi to dopiero dynamicznie `stage_compute.cpp:250-254`), `demag_poisson_sparse_export.cpp` (oraz defensywnie `driven_response_cudss.cpp`) **MUSI jawnie wyzerować wszystkie wiersze $r \in \text{ess\_tdofs}$ w bloku $-R_{\phi q}$**, aby w wierszach Dirichleta / pina cechowania układ rozszerzony wymuszał dokładnie $1 \cdot \delta\hat{\phi}_r = 0$!
   Definiując $K_{q\phi} = R_{\gamma_0} E_{\text{lift}}^T G_{\text{rec}}$, otrzymujemy **algebraicznie równoważny rzadki układ rozszerzony** wymiaru $N_{\text{aug}} = N_q + N_\phi$:
   $$\underbrace{\begin{pmatrix} K_{\text{loc}} - i \omega_k M & K_{q\phi} \\ -R_{\phi q} & P \end{pmatrix}}_{Z_{\text{aug}}(\omega_k) \in \mathbb{C}^{(N_q + N_\phi) \times (N_q + N_\phi)}} \begin{pmatrix} \hat{q} \\ \delta\hat{\phi} \end{pmatrix} = \begin{pmatrix} \hat{f} \\ 0 \end{pmatrix}$$
   Eliminacja $\delta\hat{\phi} = P^{-1} R_{\phi q} \hat{q}$ daje dokładnie $(K_{\text{loc}} + K_{q\phi} P^{-1} R_{\phi q} - i\omega_k M)\hat{q} = \hat{f}$!
   - **Dlaczego `CUDSS_MTYPE_GENERAL` + `CUDSS_C_64F` + `CUDSS_MVIEW_FULL`?**
     Układ jest z natury **niehermitowski i niesymetryczny** ze względu na: (a) niezerowe tłumienie Gilberta $\alpha > 0$ (czynnik $-i\omega_k \alpha$ oraz $-i\omega_k$ na przekątnej), (b) operator precesji $R_{\gamma_0}$ i ewentualne DMI, (c) niesymetryczną parę lumped-mass odzysku $G_{\text{rec}}$ vs słabej formy RHS $D_{\text{rhs}}$ przy zmiennym $M_s$. `CUDSS_MTYPE_GENERAL` (faktoryzacja LU z częściowym wyborem elementu głównego na GPU) obsługuje wszystkie te terminy jednolicie i bez utraty dokładności (dla braku demag redukuje się do $N_\phi = 0$, ten sam kod!).
   - **Statyczna okresowość (`periodic_airbox_k0` / `static_periodic_node_pairs`) oraz odbudowa $\delta\hat{\phi}_{\text{full}}$ i $\delta\hat{H}_{\text{demag}}$:** gdy `k = 0` i podano pary okresowe, redukujemy wiersze/kolumny magnetyczne do $N_{q,\text{red}} = 2 N_{\text{rep}}$ klas reprezentantów (identycznie z `static_periodic_reduced_magnetic_solve` w `driven_response_solver.cpp:13919`) i łączymy z okresowo zredukowanym $P_{\text{red}}$ (`periodic_matrix`, rozmiar `periodic_reduced_node_count`). Po rozwiązaniu dla każdej $\omega_k$:
     1. Unosimy $\hat{q}_{\text{red}} \to \hat{q}$ na wszystkie węzły okresowe,
     2. Unosimy $\delta\hat{\phi}_{\text{red}} \to \delta\hat{\phi}_{\text{full}}$ (`n_nodes`) przez tablicę `periodic_reduced_node[u]` (wymagane przez `solve_periodic_airbox_dynamic_demag_mfem_phi_consistency_schur` w `driven_response_solver.cpp:13540-13610`!),
     3. Wyznaczamy $\delta\hat{H}_{\text{demag}} = G_{\text{rec}} \delta\hat{\phi}_{\text{red}}$ bezpośrednio z wyeksportowanych macierzy CSR `recovery_{x,y,z}` (dla `artifact_h_demag` / `populate_h_demag_seam_diagnostics`, **0 wywołań GMRES ani callbacku MFEM!**).

### 4.2. Analiza symboliczna RAZ na całe przemiatanie + ekwilibracja + niezależna certyfikacja bez duplikacji VRAM

Nowy samowystarczalny moduł `backends/fem/gpu/frequency_domain/driven_response_cudss.{hpp,cpp}` + `driven_response_cudss_kernels.cu` (wzorowany architektonicznie na `modal_cudss_shift.{hpp,cpp}` z PR #558):

1. **Jednorazowy montaż i niezmienniczość wzorca rzadkości (przed pętlą po $\omega_k$):**
   - Budujemy posortowany 0-bazowy `DrivenResponseAugmentedCsr` (`uint32_t` indeksy, `double2` wartości), **jawnie rezerwując 4 wpisy** każdego diagonalnego bloku $2\times 2$ $(2j, 2j), (2j, 2j+1), (2j+1, 2j), (2j+1, 2j+1)$ w CSR (nawet jeśli ich wartość dla $\omega = 0$ wynosi `0.0`), i zapisując ich dokładne pozycje w tablicy `omega_slots` o długości $4 N_{m,\text{eff}}$.
   - Dzięki temu **wzorzec rzadkości CSR jest w 100% identyczny dla wszystkich $\omega_1, \dots, \omega_K$**!
2. **Jednorazowa ekwilibracja Ruiza ($10^{20}$ skali $q$ vs $\phi$):**
   - Blok magnetyczny ma skalę $\sim 10^{11}\text{ s}^{-1}$, zaś blok Poissona $\sim 10^{-8}\text{ m}$. Aby zapobiec utracie cyfr przy wyborze pivotów LU, wyznaczamy **raz** przed przemiatanim dodatnie przekątne skalujące $(D_r, D_c) \in \mathbb{R}_{>0}^{N_{\text{aug}}}$ metodą 6 iteracji ekwilibracji Ruiza na macierzy $|Z_{\text{aug}}(\omega_{\text{ref}})|$ (gdzie $\omega_{\text{ref}} = \sqrt{\omega_{\min}\omega_{\max}}$ w paśmie przemiatań):
     $$\tilde{Z}(\omega_k) = D_r \, Z_{\text{aug}}(\omega_k) \, D_c, \qquad \tilde{b} = D_r b, \qquad x = D_c y$$
   - Zapamiętujemy skalowane bazowe wpisy `d_base_values` ($D_r Z_{\text{aug}}(0) D_c$) oraz skalowane współczynniki masowe `d_omega_imag_coeffs[t] = D_r[row] * M_entry * D_c[col]` dla $4 N_{m,\text{eff}}$ slotów.
3. **Jednorazowy `CUDSS_PHASE_ANALYSIS` + preflight VRAM:**
   - Ustawienia cuDSS: `CUDSS_CONFIG_HYBRID_MEMORY_MODE = 0`, `CUDSS_CONFIG_HYBRID_EXECUTE_MODE = 0`, `CUDSS_CONFIG_IR_N_STEPS = 1` (1 krok iteracyjnego udokładniania na GPU podnosi stabilność w pobliżu ostrych rezonansów FMR o 2–3 rzędy wielkości kosztem ~3% czasu!).
   - `cudssExecute(handle, CUDSS_PHASE_ANALYSIS, ...)` uruchamiane **DOKŁADNIE RAZ**.
   - **Preflight VRAM (`CUDSS_DATA_MEMORY_ESTIMATES`):** identyczna arytmetyka budżetu jak w `modal_cudss_shift.cpp:170-204` i `cudss_direct_solver.cpp` (rezerwa `max(512 MiB, 5% total VRAM)`), plus zmienne testowe `FULLMAG_FEM_DRIVEN_CUDSS_BUDGET_BYTES` oraz `FULLMAG_FEM_DRIVEN_CUDSS_MAX_VRAM_MIB` (błędny format zmiennej, np. `"0"`, `"-5"`, `"abc"`, jest **zawsze twardym błędem**, nawet pod `auto`!).
   - Przekroczenie budżetu VRAM $\implies$ natychmiastowe zwolnienie zasobów przed faktoryzacją (`factorization_started = false`):
     - pod `Required` (`gpu_sparse_direct`): **twardy błąd** (`FrequencyDomainStatus::unavailable`, zero fallbacku!),
     - pod `Auto`: czysty powrót ze statusem `fallback_to_krylov = true`, `fallback_reason = "cudss_peak_memory_budget_exceeded"`.
4. **Pętla po częstotliwościach $\omega_k$ ($k = 0 \dots K-1$, ZERO kopiowania macierzy H2D!):**
   - Sprawdzenie `cancel_requested` (obsługa przerwania + opcjonalnych artefaktów częściowych identycznie z GMRES!).
   - Kernel `driven_response_update_omega_entries_kernel<<<blocks, 256, 0, stream>>>`: wpisuje w `d_csr_values[idx] = base + (0, -omega_k * coeff)` dla $4 N_{m,\text{eff}}$ pozycji (~5 µs!).
   - `cudssExecute(handle, CUDSS_PHASE_FACTORIZATION, ...)` — ponowne użycie analizy symbolicznej z pełnym pivotingiem numerycznym (bezpieczne na rezonansie, gdzie `REFACTORIZATION` bez pivotingu mogłoby utracić stabilność!).
   - Kontrola `CUDSS_DATA_INFO == 0`! Jeżeli `info != 0` (macierz osobliwa, np. nietłumiony rezonans $\alpha = 0, \omega_k = \omega_n$ lub brak pina cechowania): **twardy błąd `cudss_factorization_singular_or_failed` również pod `auto`** (zero cichego fallbacku!).
   - `cudssExecute(handle, CUDSS_PHASE_SOLVE, ...)` rozwiązuje $\tilde{Z}(\omega_k) y = \tilde{b}$.
   - **Niezależna certyfikacja nieskalowanego rezyduum na GPU (ZERO duplikacji CSR!):**
     Ponieważ $r_{\text{unscaled}} = Z_{\text{aug}}(\omega_k) (D_c y) - b = D_r^{-1}\big(\tilde{Z}(\omega_k) y - \tilde{b}\big)$, pojedynczy kernel `driven_response_unscaled_residual_norm_kernel` (wieloblokowa redukcja Blue/LAPACK `ScaledNorm` odporna na overflow/underflow!) wylicza na GPU równocześnie:
     - $\|r_q\|_2$, $\|\hat{f}\|_2$, $\|\hat{q}\|_2$,
     - $\|r_\phi\|_2$, $\|R_{\phi q} \hat{q}\|_2$, $\|P \delta\hat{\phi}\|_2$, $\|\delta\hat{\phi}\|_2$ (z $r_\phi = D_{r,\phi}^{-1}(\tilde{Z}_{\phi\cdot} y)$, $\|R_{\phi q}\hat{q}\|_2 = \|D_{r,\phi}^{-1}(\tilde{Z}_{\phi q} y_q)\|_2$ oraz $\|P\delta\hat{\phi}\|_2 = \|D_{r,\phi}^{-1}(\tilde{Z}_{\phi\phi} y_\phi)\|_2$),
     - oraz odskalowane rozwiązanie $\hat{q}_j = D_{c,j} y_j$ (i $\delta\hat{\phi}$ przy $N_\phi > 0$) z kontrolą `isfinite` na każdym elemencie!
     Jednorazowy odczyt D2H skalarów + wektora $\hat{q}$ (oraz $\delta\hat{\phi}$ gdy wymagane):
     - Certyfikat przechodzi iff wszystkie wartości skończone ORAZ $\|r_q\|_2 \le \max(\text{rtol} \cdot \|\hat{f}\|_2, \text{atol})$ ORAZ (dla $N_\phi > 0$):
       $$\|r_\phi\|_2 \le \max\Big(\text{rtol} \cdot \max(\|R_{\phi q}\hat{q}\|_2,\, \|P\delta\hat{\phi}\|_2),\, \text{atol}_\phi\Big)$$
       gdzie $\text{atol}_\phi = 10^{-14} \cdot \max(\|P\|_\infty \|\delta\hat{\phi}\|_2,\, \|R_{\phi q}\|_\infty \|\hat{q}\|_2,\, 10^{-300})$. Dzięki temu mody bezdywergencyjne ($\|R_{\phi q}\hat{q}\|_2 = 0$, $\delta\hat{\phi} \approx 0$ z szumem zaokrągleń $10^{-16}$) przechodzą certyfikację bez fałszywego odrzucenia!
     - W razie porażki certyfikatu: twardy błąd `FrequencyDomainStatus::solve_error` (`cudss_residual_certification_failed`) — zero akceptacji niecertyfikowanego wyniku!

### 4.3. Zakres, eksport bloków demag, ABI v14, polityka i proweniencja

- **Zakres kwalifikowany w Wave 3:**
  - `demag_enabled = false` ($N_\phi = 0$, $k = 0$ + statyczne okresowe `static_periodic_node_pairs`),
  - Open-airbox $k=0$ (`poisson_robin`, `poisson_dirichlet`) z dostarczonymi blokami CSR `(P, rhs_{x,y,z}, recovery_{x,y,z})`,
  - Statycznie okresowy `periodic_airbox_k0` z dostarczonym okresowo zredukowanym blokiem `P_red` (`periodic_matrix`), mapą `periodic_reduced_node` oraz odbudową $\delta\hat{\phi}_{\text{full}}$ i $\delta\hat{H}_{\text{demag}} = G_{\text{rec}}\delta\hat{\phi}_{\text{red}}$.
  - **Jawnie poza zakresem (non-goal):** niezerowe $k$ `floquet_airbox` z dynamicznym demag oraz demag `fredkin_koehler` FEM/BEM (gęsty blok BEM). Pod `Auto` jawnie wycofują się do istniejącej ścieżki z zapisanym `solver_fallback_reason` (`"floquet_nonzero_k_demag_unsupported"` / `"demag_sparse_blocks_unavailable"`); pod jawnym `gpu_sparse_direct` zwracają **twardy błąd** (`FrequencyDomainStatus::unavailable`)!
- **Eksport rzadkich bloków Poissona z `NativeFemBackend` (`native/include/fullmag_fem.h`, `api.cpp`, `CMakeLists.txt`):**
  - Nowa para funkcji C ABI (z bezwarunkowym symbolem w `FEM_SOURCES` i wewnętrznym `#if FULLMAG_HAS_MFEM_STACK` / `#else` stubem dla zgodności z buildem non-MFEM!):
    `fullmag_fem_backend_export_demag_poisson_sparse_blocks(fullmag_fem_backend *handle, fullmag_fem_demag_poisson_sparse_blocks *out_blocks)` + `fullmag_fem_demag_poisson_sparse_blocks_destroy(...)`.
  - Buduje na hoście (raz przed przemiatanim, $<5\text{ ms}$!) spójną kopię CSR `(P, rhs_x/y/z, recovery_x/y/z, ess_tdofs, magnetic_node_indices, periodic_reduced_node)` bezpośrednio z `ctx.poisson_demag` (`periodic_reduced_ready ? periodic_matrix : poisson_bc_op`, z jawnym wyzerowaniem wierszy `ess_tdofs` w `rhs_{x,y,z}`!). Dzięki temu $P, D_{\text{rhs}}, G_{\text{rec}}$ są **algebraicznie identyczne** z operatorem używanym przez `apply_demag_tangent` (parytet $< 10^{-10}$ między GMRES a `cuDSS`!).
  - **Zasada linkowania w `backends/fem/CMakeLists.txt`:** zarówno `gpu/frequency_domain/driven_response_cudss.cpp`, jak i `cpu/mfem/interactions/demag_poisson_sparse_export.cpp` trafiają do **bezwarunkowego `FEM_SOURCES`** (z wewnętrznymi osłonami `#if FULLMAG_FEM_CUDSS_DRIVEN_ENABLED && FULLMAG_HAS_CUDA_RUNTIME` i `#if FULLMAG_HAS_MFEM_STACK`), ponieważ `driven_response_solver.cpp` i `api.cpp` kompilują się także w CI `-DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_ENABLE_CUDA=OFF`. Jedynie `gpu/frequency_domain/driven_response_cudss_kernels.cu` oraz definicja `FULLMAG_FEM_CUDSS_DRIVEN_ENABLED=1` znajdują się wewnątrz `if(FULLMAG_FEM_CUDSS_SHIFT_SUPPORTED)`!
- **Addytywny punkt wejścia C ABI v14 (zero mutacji layoutu `fullmag_fem_frequency_domain_driven_response_request` i pełna wsteczna kompatybilność ABI v13!):**
  - Wewnątrz C++ (`driven_response_solver.hpp`): podniesienie `kDrivenFrequencyResponseSolveRequestAbiVersion = 14` i dodanie 2 końcowych pól POD: `DrivenFrequencyResponseGpuDirectPolicy gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Auto;` oraz `const DrivenFrequencyResponseDemagSparseBlocks *demag_sparse_blocks = nullptr;`. Struktura `DrivenFrequencyResponseDemagSparseBlocks` jest ściśle **standard-layout i trivially-copyable POD** (wyłącznie wskaźniki raw + `uint64_t` rozmiary/flagi, zero `std::vector`), aby zachować `static_assert(is_trivially_copyable && is_standard_layout)` w `driven_response_solver.cpp:16919-16922`!
  - **Kompatybilność wsteczna ABI 0/9/12/13/14 we WSZYSTKICH 4 miejscach `driven_response_solver.cpp`:**
    1. `:1025-1039` (`validate_driven_response_request_header`): akceptuje `abi_version ∈ {0, 9, 12, 13, 14}` oraz 3-poziomowy rozmiar: `sizeof(...)` dla v14, `offsetof(..., gpu_direct_policy)` dla v13, `offsetof(..., artifact_identity)` dla 0/9/12;
    2. `:1050`: `request.abi_version >= 13u` (zamiast `== kDrivenFrequencyResponseSolveRequestAbiVersion`);
    3. `:6772`: `request.abi_version >= 13u` (zamiast `== kDrivenFrequencyResponseSolveRequestAbiVersion`);
    4. `:16925-16932`: 3-wariantowe `copy_size` (`sizeof(...)` dla v14, `offsetof(..., gpu_direct_policy)` dla v13, `offsetof(..., artifact_identity)` dla `< 13`, z zerowaniem `gpu_direct_policy`/`demag_sparse_blocks` dla `< 14` i `artifact_identity` dla `< 13`).
  - **Powiększenie bufora JSON diagnostyki (`driven_response_solver.cpp:12394`):** zamiana `char diagnostics_json[1400]{}` na `char diagnostics_json[4096]{}` (lub `std::string`), aby nowe pola `cuDSS` / fallbacku nigdy nie powodowały błędu obcięcia `artifact_error` w `:12467`!
  - Na publicznej granicy C ABI (`native/include/fullmag_fem.h` + `crates/fullmag-fem-sys/src/lib.rs`): zamiast zmieniać rozmiar istniejącej struktury `fullmag_fem_frequency_domain_driven_response_request` (weryfikowanej przez `fullmag_fem_get_frequency_domain_abi_layout` w `crates/fullmag-fem-sys/src/lib.rs:5583` i `frequency_domain_contract.cpp:2626`), dodajemy addytywną strukturę `fullmag_fem_frequency_domain_gpu_direct_options` (`struct_size`, `gpu_direct_policy`, `demag_sparse_blocks`) i funkcję `fullmag_fem_frequency_domain_solve_driven_response_v14(request, identity, mfem_apply_demag_tangent_with_potential, direct_options, out_result)` — identycznie jak `fullmag_fem_frequency_domain_solve_driven_response_with_identity_v1` (`api.cpp:3083`)! Zero ryzyka złamania istniejących testów layoutu ABI!
- **Polityka w Pythonie / IR / Runnerze:**
  - `crates/fullmag-ir/src/study.rs`: dodanie wariantu `GpuSparseDirect` (`"gpu_sparse_direct"`) do `FrequencyResponseSolverMethodIR`.
  - `packages/fullmag-py/src/fullmag/model/study.py:102`: dodanie `"gpu_sparse_direct"` do dozwolonych metod `solver_method`.
  - `crates/fullmag-runner/src/frequency_response.rs`:
    - `requested_device == Gpu` + `method == None | Auto` $\implies$ `gpu_direct_policy = Auto`;
    - `requested_device == Gpu` + `method == GpuSparseDirect` $\implies$ `gpu_direct_policy = Required`;
    - `requested_device == Gpu` + `method == GpuOperatorHostKrylov` $\implies$ `gpu_direct_policy = Disabled`;
    - `requested_device == Cpu` + `method == GpuSparseDirect` $\implies$ natychmiastowe odrzucenie w `frequency_response_solver_method_rejection_reason`!
    - Gdy `demag_enabled` i `gpu_direct_policy != Disabled`: wyeksportować `demag_sparse_blocks` raz z `NativeBackendDemagTangentProvider` (dla `poisson_robin`/`poisson_dirichlet`/`periodic_airbox_k0`, gdy `!has_nonzero_floquet_k`).
    - W diagnostyce i manifeście zapisać faktyczne `resolved_solver_method` z JSON odpowiedzi natywnej (`"gpu_sparse_direct_cudss"` vs `"gpu_operator_host_krylov"`, z czystym zachowaniem dotychczasowego domyślnego zachowania w testach jednostkowych `frequency_response.rs:5476-5513` gdy pole nie jest obecne w syntetycznym JSON!), `solver_fallback_reason`, `symbolic_analysis_count`, `numeric_factorization_count`, `estimated_peak_device_bytes`, `device_budget_bytes`, `max_magnetic_relative_residual_l2`, `max_poisson_relative_residual_l2` oraz `gpu_device_resident_solver: true`!

---

## 5. Kontrakt dokumentacji naukowej (`scientific-documentation-contract`)

Zgodnie z `.agents/instructions/scientific.md` oraz `docs/physics/README.md`:
1. **Aktualizacja `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.{md,source-map.json}`** (własność `pgbb-author`):
   - Zaktualizować status sekcji 11 (po przejściu bramki w Fazie 2) z `NOT VERIFIED` na stan kwalifikacji potwierdzony dowodami; opisać niezależną 3-składową rekurencję ze skalowaniem $D^{-1/2}$ i normalizacją $\sigma_c, \tau_c$, podniesienie limitu iteracji do 2048, regułę `auto`, atestację runtime C ABI oraz redukcję barier/energii PGBB (7$\to$4 sync, 3$\to$1 redukcji energii). Zaktualizować `source-map.json`.
2. **Nowa nota `docs/physics/0999-fem-gpu-short-range-kernel-optimizations.{md,source-map.json}`** (własność `shortrange-author`):
   - Pełne 15 sekcji: bramkowanie redukcji pośrednich RK (DMI/anizotropia/magnetoelastyczność/termika + `h_drive_zeroed`), analiza błędów zaokrągleń i lematu Sterbenza dla rozdziału `gpu_relax_dd` (RK fast FP64 FMA vs relaksacja DD), dokładna kolejność sumowania w fuzji `H_eff`, oraz zastąpienie strided `cudaMemcpy2D` przez device pack/unpack na buforze stagingowym.
3. **Nowa nota `docs/physics/1000-fem-gpu-driven-response-cudss.{md,source-map.json}`** (własność `dr-cudss-author`):
   - Pełne 15 sekcji: sprzężone równanie $Z_{\text{aug}}(\omega_k)$, analiza jednorazowa vs faktoryzacja per-$\omega_k$, ekwilibracja Ruiza $(D_r, D_c)$, niezależna certyfikacja nieskalowanych bloków $(r_q, r_\phi)$, preflight VRAM, granica zakresu (`open_airbox_k0` + `periodic_airbox_k0` vs niezerowe $k$ `floquet_airbox`), wpływ na Python API / `ProblemIR` (`gpu_sparse_direct`) i proweniencję.
4. **Aktualizacja `docs/physics/README.md`** (Faza 2) + walidacja:
   - `.agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py`
   - `.agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py --base origin/master --head HEAD`
   - `scripts/check_repo_consistency.py`

---

## 6. Podział na 3 autorów o ZEROWYM nakładaniu się plików

Aby uniknąć jakichkolwiek konfliktów podczas równoległej pracy w 3 izolowanych worktree Fazy 1 **i zapewnić natychmiastową pełną kompilowalność + TDD (CTest i Cargo) w każdym worktree od pierwszego commitu**, Faza 0 (commit Koordynatora) zamraża nie tylko szwy nagłówkowe/FFI, ale także kompilujące się szkielety 5 nowych plików, ich rejestrację w `backends/fem/CMakeLists.txt`, 4 cienkie forwardery C ABI w `backends/fem/src/api.cpp` oraz 4-miejscową kompatybilność ABI v13/v14 w `driven_response_solver.cpp`!

| Faza / Właściciel | Wyłączna lista plików (ZERO przecięcia w Fazie 1!) |
|---|---|
| **Faza 0: Coordinator (Kompilujący się Pre-Fanout Seam Commit)** | 6 plików szwów (`rk_step_stats.hpp`, `field_buffer_state.hpp` z `h_drive_zeroed = false`, `bb_exchange_mass.hpp`, `driven_response_solver.hpp`, `native/include/fullmag_fem.h`, `crates/fullmag-fem-sys/src/lib.rs`) + kompilujące się szkielety 5 nowych źródeł i 2 nowych testów (`driven_response_cudss.{hpp,cpp}`, `driven_response_cudss_kernels.cu`, `demag_poisson_sparse_export.{hpp,cpp}`, `cuda_shortrange_kernels_contract.cpp`, `driven_response_cudss_contract.cpp`) + `backends/fem/CMakeLists.txt` (`driven_response_cudss.cpp` & `demag_poisson_sparse_export.cpp` w bezwarunkowym `FEM_SOURCES`, tylko `.cu` i `FULLMAG_FEM_CUDSS_DRIVEN_ENABLED=1` pod `if(FULLMAG_FEM_CUDSS_SHIFT_SUPPORTED)`, 2 cele CTest) + `backends/fem/src/api.cpp` (4 cienkie forwardery C ABI) + 5-liniowy stub `gpu_bb_exchange_mass_resolve` w `bb_exchange_mass.cpp` + 4-miejscowy walidator ABI v13/v14 w `driven_response_solver.cpp`. **Pełna kompilacja i 100% PASS istniejącego CTest + Cargo od razu po Fazie 0!** |
| **Faza 1 — Author 1: `pgbb-author` (Track 1: P1 #6)** | `backends/fem/gpu/cuda/relaxation/bb_exchange_mass.cpp`, `backends/fem/gpu/cuda/relaxation/bb_exchange_mass_kernels.{hpp,cu}`, `backends/fem/gpu/cuda/relaxation/pgbb.cpp`, `backends/fem/gpu/cuda/relaxation/relaxation_state.hpp`, `backends/fem/gpu/cuda/integrators/rk/rk_step_stats.{cu,cpp}`, `backends/fem/cpu/mfem/runtime/backend_step.cpp`, `backends/fem/tests/cuda_bb_exchange_mass_contract.cpp`, `backends/fem/tests/relaxation_source_contract.cpp`, `crates/fullmag-runner/src/types.rs` *(pole `direction_fallback_reason` w `FemDirectMinimizerPolicyProvenance:3408-3419`)*, `crates/fullmag-runner/src/relaxation.rs` *(re-eksport `:27`)*, `crates/fullmag-runner/src/relaxation/provenance.rs`, `crates/fullmag-runner/src/native_fem.rs` *(tylko metoda getter `gpu_bb_preconditioner_status`)*, `crates/fullmag-runner/src/fem/execution.rs` *(wywołanie atestacji runtime w `:386`)*, `crates/fullmag-runner/src/fem/relax/finalize.rs` *(odświeżenie `final_provenance` w `:404-411`)*, `crates/fullmag-runner/src/dispatch.rs` *(wywołanie atestacji w `:3754`)*, `crates/fullmag-runner/src/interactive_runtime.rs` *(wywołanie atestacji w `:2448-2458` po `NativeFemBackend::create`)*, `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.{md,source-map.json}` |
| **Faza 1 — Author 2: `shortrange-author` (Track 2: P2 #7a)** | `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu`, `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu`, `backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_field.cu`, `backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.{hpp,cu}`, `backends/fem/gpu/cuda/integrators/rk/rk_magnetoelastic_field.cu`, `backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.{hpp,cu}`, `backends/fem/gpu/cuda/integrators/rk/rk_thermal_field.cu`, `backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.{hpp,cu}`, `backends/fem/gpu/cuda/fields/field_buffer_memory.cpp`, `backends/fem/gpu/cuda/interactions/zeeman/regional_field_kernels.cu`, `backends/fem/gpu/cuda/exchange/exchange_kernels.{hpp,cu}`, `backends/fem/gpu/cuda/integrators/rk/rk_exchange_dispatch.{hpp,cu}`, `backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu`, `backends/fem/gpu/cuda/fields/vector_field_kernels.{hpp,cu}`, `backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu`, `backends/fem/gpu/cuda/integrators/rk/rk_oersted_field.{hpp,cu}`, `backends/fem/gpu/cuda/transfer/transfer_kernels.{hpp,cu}`, `backends/fem/gpu/cuda/transfer/component_transfer.{hpp,cpp}`, `backends/fem/gpu/cuda/state/gpu_state.{hpp,cpp}`, `backends/fem/cpu/mfem/runtime/state_io.cpp`, `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp`, `backends/fem/tests/source_facade_cuda_kernels_contract.cpp`, `backends/fem/tests/gpu_state_runtime_contract.cpp`, `backends/fem/tests/state_io_contract.cpp`, `backends/fem/tests/cuda_shortrange_kernels_contract.cpp`, `docs/physics/0999-fem-gpu-short-range-kernel-optimizations.{md,source-map.json}` |
| **Faza 1 — Author 3: `dr-cudss-author` (Track 3: P2 #7b)** | `backends/fem/gpu/frequency_domain/driven_response_cudss.{hpp,cpp}`, `backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu`, `backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.{hpp,cpp}`, `backends/fem/src/frequency_domain/driven_response_solver.cpp`, `backends/fem/tests/frequency_domain/driven_response_cudss_contract.cpp`, `crates/fullmag-ir/src/study.rs`, `crates/fullmag-runner/src/frequency_response.rs`, `crates/fullmag-runner/src/native_fem/frequency_domain.rs`, `packages/fullmag-py/src/fullmag/model/study.py`, `packages/fullmag-py/tests/test_api.py`, `docs/physics/1000-fem-gpu-driven-response-cudss.{md,source-map.json}` |
| **Faza 2: Integracja & Weryfikacja (`verifier` / Coordinator)** | Scalenie 3 gałęzi, opcjonalne porządkowanie `backends/fem/src/api.cpp:423,431` (`device_apply_demag_tangent_with_potential` $\to$ `gpu_state_download_component_aos_packed`), `docs/physics/README.md`, build non-MFEM (`FULLMAG_HAS_MFEM_STACK=0`) + GPU w Docker DEV, pełny CTest + Cargo + Pytest, walidatory dokumentacji i spójności repo, benchmarki A/B na RTX 4080 SUPER, aktualizacja statusu kwalifikacji w `0581`/`0999`/`1000`. |

> **Weryfikacja przecięć Fazy 1:** $\text{Author 1} \cap \text{Author 2} = \emptyset$, $\text{Author 1} \cap \text{Author 3} = \emptyset$, $\text{Author 2} \cap \text{Author 3} = \emptyset$. Żaden autor nie dotyka w Fazie 1 plików `api.cpp` ani `CMakeLists.txt`, a mimo to każdy z 3 autorów ma pełne kompilowanie, linkowanie C ABI i uruchomienie TDD CTest + Cargo od pierwszego kroku!

---

## 7. Benchmarki A/B i kryteria akceptacji (RTX 4080 SUPER w Docker DEV)

Wszystkie pomiary wykonujemy metodą A/B (`origin/master` `9ab99132d5` vs scalona gałąź Wave 3) w grupie `just docker-dev`:

1. **Benchmark A/B Track 1 — PGBB na drobnej siatce (SP4 $500\times 125\times 3\text{ nm}$, $h = 3\text{ nm}$ oraz $h = 2\text{ nm}$, z airboxem i demag `cuDSS` oraz `cg_amg`):**
   - Porównanie: `policy="none"` (przed vs po redukcji sync/energii) oraz `policy="auto"` / `"exchange_mass"` (kwalifikowany `bb_exchange_mass`).
   - Mierzone metryki: całkowity wall-time, liczba zaakceptowanych kroków PGBB, liczba rozwiązań demag, liczba `control_fences` / krok, końcowa energia $E_{\text{tot}}$ i średnia magnetyzacja $\langle \mathbf{m} \rangle$ względem CPU PGBB.
   - **Bramki akceptacji:**
     - `policy="none"` po Track 1: bit-w-bit identyczna ścieżka kroków i końcowa energia, `control_fences`/krok spadają z 6 do **3** (w stanie ustalonym), brak powtórnego `gpu_rk_reduce_final_energy_terms`.
     - `policy="auto"` / `"exchange_mass"`: **0 porażek PCG** (w tym dla planarnego SP4 z $\|b_z\| \ll \|b_x\|$), maksymalne względne rezyduum PCG $\le 10^{-8}$, końcowa równowaga zgodna z CPU PGBB ($\Delta E / |E| \le 10^{-7}$, $|\Delta \langle \mathbf{m}\rangle| \le 10^{-5}$), **$\ge 2.0\times$ redukcja kroków PGBB i istotne przyspieszenie wall-time** na drobnej siatce ($h \le 3\text{ nm}$)!

2. **Benchmark A/B Track 2 — Mikro-timing etapów RK (siatka $\sim 20\text{k–}50\text{k}$ węzłów z wymianą + DMI + anizotropią + magnetoelastycznością + `regional_drive_count=0`, 50 kroków RK4 + 10 poborów obserwabli `state_io`):**
   - Mierzone metryki: czas fazy wymiany (`exchange_wall_time_ns`), czas fazy DMI, czas fazy `H_eff`, całkowity czas kroku bez demag, czas transferu `context_copy_field_f64` / `context_sync_gpu_magnetization_to_host`, oraz parytet trajektorii RK4 względem `origin/master`.
   - **Bramki akceptacji:**
     - Parytet trajektorii RK4 (`m(t)`, `E(t)`): błąd względny **$< 10^{-13}$** (dla `H_eff` i `state_io`: **bit-w-bit `0.0`**!),
     - Exchange `Compensated=false` na RK: **$\ge 2.5\times$ przyspieszenie** czasu kernela wymiany (przy zachowaniu `relaxation_energy_derivative_contract` 100% PASS!),
     - DMI na etapach pośrednich RK: **0 globalnych FP64 `atomicAdd` na `energy_out`** (znaczący spadek czasu kernela DMI),
     - `H_eff`: dokładnie **1 launch kernela** na etap (`regional_drive_count == 0`, 0 `cudaMemsetAsync` na `h_drive`),
     - `state_io` / `stage_compute`: **$\ge 5\times$ przyspieszenie** transferów AoS/SoA względem strided `cudaMemcpy2D`.

3. **Benchmark A/B Track 3 — Przemiatanie RF Driven Response (25 częstotliwości $1\text{–}25\text{ GHz}$, $\alpha = 0.01$, film z otwartym airboxem `poisson_robin` oraz wariant `periodic_airbox_k0`, ~3k–15k węzłów):**
   - Porównanie: CPU GMRES (`production_cpu`) vs GPU operator + host GMRES (`gpu_operator_host_krylov`) vs **GPU `cuDSS` (`auto` / `gpu_sparse_direct`)**.
   - Mierzone metryki: całkowity wall-time przemiatań 25 częstotliwości, czas jednorazowego `ANALYSIS` vs średni czas per-częstotliwość (`FACTORIZATION + SOLVE + CERT`), `symbolic_analysis_count == 1`, `numeric_factorization_count == 25`, maksymalny błąd względny $L_2$ odpowiedzi zespolonej $\hat{q}(\omega_k)$ względem CPU GMRES (`rtol=1e-10`).
   - **Bramki akceptacji:**
     - Zgodność spektrum $\hat{q}(\omega_k)$ i podatności $\chi(\omega_k)$ z CPU GMRES: **$< 10^{-8}$** (typowo $< 10^{-10}$),
     - Niezależne certyfikowane rezydua na GPU dla każdej $\omega_k$: $\|r_q\|_2 \le \max(\text{rtol}\cdot\|\hat{f}\|_2, \text{atol})$ oraz $\|r_\phi\|_2 \le \max(\text{rtol}\cdot\max(\|R_{\phi q}\hat{q}\|_2, \|P\delta\hat{\phi}\|_2), \text{atol}_\phi)$,
     - **$\ge 10\times$ przyspieszenie** całego 25-punktowego przemiatań RF względem CPU GMRES / `gpu_operator_host_krylov`!
     - Twardy test kontraktu polityk: wymuszony `gpu_sparse_direct` ponad limitem `FULLMAG_FEM_DRIVEN_CUDSS_MAX_VRAM_MIB` failuje twardo przed faktoryzacją; `auto` spada jawnie do `gpu_operator_host_krylov` z pełną proweniencją; osobliwy układ ($\alpha=0$ dokładnie na rezonansie) failuje twardo również pod `auto`.
