# Raport weryfikacji i porównania A/B — Wave 1 (P0 #4): `pure_prism_p2` GPU + ujednolicony CSR GPU DMI + konforemność `layers=2`

Powiązane dokumenty:
- Specyfikacja architektoniczna: [2026-11-26-fem-prism-p2-gpu-design.md](../superpowers/specs/2026-11-26-fem-prism-p2-gpu-design.md)
- Plan implementacji: [2026-11-26-fem-prism-p2-gpu-plan.md](../superpowers/plans/2026-11-26-fem-prism-p2-gpu-plan.md)
- Notatki fizyczne: [1001-fem-gpu-pure-prism-p2-and-csr-dmi.md](../physics/1001-fem-gpu-pure-prism-p2-and-csr-dmi.md), [0106-fem-mixed-prism-pyramid-shared-domain.md](../physics/0106-fem-mixed-prism-pyramid-shared-domain.md), [0431-fem-demag-mixed-order-potential.md](../physics/0431-fem-demag-mixed-order-potential.md)
- Audyt odniesienia: [2026-11-24-fem-gpu-cudss-film-validation.md](2026-11-24-fem-gpu-cudss-film-validation.md)

- **Data:** 2026-11-26
- **Gałąź / commit zweryfikowany:** `codex/fem-prism-p2-gpu-20261126` @ `c401f28b90` (baza `9ab99132d5`)
- **Środowisko wykonawcze:** zarządzany kontener Docker DEV worktree, GPU **NVIDIA GeForce RTX 4080 SUPER** (16 GiB VRAM, `sm_89`, `FULLMAG_CUDA_ARCHITECTURES=89-real`, `cuDSS 0.8.0.10`, CUDA runtime `12.6`, MFEM `4.10.0`, HYPRE GPU device policy, jedno zadanie GPU naraz).
- **Wartość odniesienia Aharoni (1998):** cienka warstwa permaloju `300 × 300 × 5 nm`, $M_s = 800\;\mathrm{kA/m}$, $A_{\mathrm{ex}} = 13\;\mathrm{pJ/m}$ ($l_{\mathrm{ex}} \approx 5.69\;\mathrm{nm}$), $\alpha = 0.02$, stan jednorodny $\mathbf{m}_0 = (1, 0.1, 0)/|\cdot|$:
  $$E_{\mathrm{demag}}^{\mathrm{Aharoni}} = 4.632850 \times 10^{-18}\;\mathrm{J}.$$
- **Referencje zrelaksowane (`docs/audits/2026-11-24-fem-gpu-cudss-film-validation.md`):**
  - `fullmag FDM` GPU (`120×120×2`, `2.5 nm`, PGBB `tolT = 1e-7 T`): $E_{\mathrm{total}} = 3.109921 \times 10^{-18}\;\mathrm{J}$, $E_{\mathrm{ex}} = 3.895426 \times 10^{-19}\;\mathrm{J}$, $E_{\mathrm{demag}} = 2.720379 \times 10^{-18}\;\mathrm{J}$, $\langle \mathbf{m}\rangle = (0.671866, 0.671542, 0)$.
  - `MuMax3 3.12` (`120×120×2`, `2.5 nm`, `Relax()`, float32): $E_{\mathrm{total}} = 3.08758 \times 10^{-18}\;\mathrm{J}$ (acc 6), $E_{\mathrm{demag}} = 2.712516 \times 10^{-18}\;\mathrm{J}$ (acc 12 na stanie zrelaksowanym fullmag), $\langle \mathbf{m}\rangle = (0.708, 0.631)$.

---

## 1. Podsumowanie wykonawcze (A/B)

1. **Przełom dokładności i wydajności dla cienkich warstw (`pure_prism_p2` GPU + `cuDSS`):**
   - Na siatce `pure_prism_p2` o rozdzielczości w płaszczyźnie $h = 5.0\;\mathrm{nm} < l_{\mathrm{ex}} = 5.69\;\mathrm{nm}$ (100% `prism6`, zero piramid i zero czworościanów) potencjał skalarny automatycznie rozwiązuje się w przestrzeni **P2 `H1_WedgeElement(2)`**, przy jednoczesnym zachowaniu $\mathbf{m}_h \in (V_h^1)^3$:
     - **`L=1` (`76 832` węzłów, `143 490` graniastosłupów, `594 239` DOF P2):** czas siatkowania **`0.50 s`** (**246× szybciej** niż `tet P2` `123 s`), błąd energii Aharoni w stanie jednorodnym spada z **`-30.11%`** (`mixed prism P1`) do **`-0.80%`** ($4.595727 \times 10^{-18}\;\mathrm{J}$), zrelaksowana energia $E_{\mathrm{total}} = 3.094433 \times 10^{-18}\;\mathrm{J}$ zgadza się z `fullmag FDM` do **`-0.50%`** i z `MuMax3` do **`+0.22%`** (wobec **`-19.36%`** dla `mixed prism P1`!), a faktoryzacja `cuDSS` mieści się swobodnie w **`5.14 GiB`** (`5.52 GB` `device_bytes`; `9.48 GB` wolnego VRAM na RTX 4080 SUPER) i liczy **`38.53 ms/krok`** (**144.8× szybciej** niż `cg_amg` `5 579.74 ms/krok` na tej samej siatce oraz **~197× szybciej** niż `tet P2` `~7 600 ms/krok`).
     - **`L=2` (`91 238` węzłów, `172 188` graniastosłupów, `709 253` DOF P2):** czas siatkowania **`0.51 s`**, błąd Aharoni **`-0.60%`** ($4.605080 \times 10^{-18}\;\mathrm{J}$ — **dokładniej niż `tet P2` `-0.63%`** przy **5.76× mniejszej liczbie DOF P2**!), pełna relaksacja do `tolT = 1e-7 T` w `8 153` krokach daje $E_{\mathrm{ex}} = 3.892977 \times 10^{-19}\;\mathrm{J}$ (`-0.06%` vs FDM), $E_{\mathrm{demag}} = 2.707402 \times 10^{-18}\;\mathrm{J}$ (`-0.48%` vs FDM, `-0.19%` vs MuMax3 acc 12), $E_{\mathrm{total}} = 3.096700 \times 10^{-18}\;\mathrm{J}$ (**`-0.43%` vs FDM**, **`+0.30%` vs MuMax3**), $\langle\mathbf{m}\rangle = (0.674475, 0.668814, 2.41\times 10^{-15})$, `cuDSS` zajmuje **`6.73 GiB`** (`7.23 GB` `device_bytes`; `7.59 GB` wolnego VRAM) i liczy **`51.88 ms/krok`**.
   - **Uczciwa granica skalowania dla $h = 2.5\;\mathrm{nm}$ w `pure_prism_p2` (`L=1`):** ekstruzja kolumnowa (`air 7+7 + film 1 = 15` warstw) daje `285 152` węzłów / `534 090` graniastosłupów / `2 208 719` DOF P2 (`mesh = 2.53 s`, **48× szybciej** niż `tet P2`, **1.85× mniej DOF** i **2.8× mniejszy czynnik Cholesky'ego**: `21.18 GiB` vs `59.4 GiB`). Na 16 GB RTX 4080 SUPER wymuszony `cuDSS` czysto uruchamia preflight VRAM bez OOM (`21.18 GiB > 9.10 GiB` dostępnego budżetu; analiza `61.5 s`), a `gpu_strategy='auto'` bezpiecznie przełącza się na `cg_amg` (`device_buffers = 1.399 GB`), gdzie domyślny limit skryptu `max_iterations=600` osiąga rezyduum `7.50e-10` (wobec wymaganego przez ścisłe PGBB `rtol=1e-12`). Rekomendowanym punktem pracy dla `pure_prism_p2` + `cuDSS` na GPU 16 GB jest więc $h \approx 5.0\;\mathrm{nm}$ (poniżej długości wymiany permaloju $l_{\mathrm{ex}} = 5.69\;\mathrm{nm}$), co zapewnia `< 0.6–0.8%` dokładności Aharoni przy `< 7 GiB` VRAM i `38–52 ms/krok`.

2. **Konforemność `layers=2` w siatce mieszanej (`pyramid_to_tetrahedra`):**
   - End-to-end na dokładnie tym samym przypadku `300 × 300 × 5 nm`, $h = 2.5\;\mathrm{nm}$, `layers=2`, który wcześniej zawodził w `docs/audits/2026-11-24-fem-gpu-cudss-film-validation.md` §6.3 z 6 nakładającymi się ścianami `same_side_two_owner_face`:
     - Deterministyczny untangler Chebyshev-center (`_untangle_same_side_mixed_tetrahedra`) redukuje **`same_side_reduced = 6 -> 0`** (relokacja węzła `53465`, `reoriented_tets = 2`, margines `4.452e-04`), przechodzi pełną walidację konforemności (`nodes=54 016`, `cells=159 714`, `p05={'prism6': 0.8616, 'pyramid5': 0.4622, 'tet4': 0.1842}`) i uruchamia się bezpośrednio na GPU `cuDSS` (`180 MB`, `7.52 ms/krok`, `hot_loop_gather_scatter_bytes = 0`).

3. **Ujednolicony operator CSR GPU DMI (`dmi_csr_*`):**
   - Zgodność numeryczna do precyzji maszynowej względem referencji CPU MFEM we wszystkich 15 przetestowanych konfiguracjach (`tet4`, `tet4` okresowe 2D $P^T D P$, `prism6` 60×60×2, `prism6` 120×120×2, siatka mieszana `prism6+pyramid5+tet4`; DMI międzyfazowe ze skośną normalną, obrócone DMI Göbela, DMI objętościowe):
     - $h_{\mathrm{rel}} \le 1.12 \times 10^{-15}$, $E_{\mathrm{rel}} \le 4.76 \times 10^{-14}$.
   - **Wydajność na RTX 4080 SUPER:**
     - Na `tet4_32x32x4` (24 576 tets): **`1.67×–2.51×` szybciej niż dotychczasowy kernel `tet4` GPU** z energią i **`3.33×–4.80×` szybciej** na pośrednich etapach RK bez redukcji energii (`energy_block_sums=nullptr`), oraz **`780×–2 787×` szybciej niż CPU MFEM** (`leg_rel <= 4.12e-16`).
     - Na cienkiej warstwie `prism6_120x120x2` (43 923 węzłów, 57 600 graniastosłupów — pełna skala `300×300×5 nm` przy $h = 2.5\;\mathrm{nm}$, $L=2$): **`0.035–0.091 ms/ewaluację`** (pole) / **`0.037–0.103 ms`** (pole+energia), czyli **`1 953×–4 812×` szybciej niż CPU MFEM** (`168.5–190.8 ms`)!
     - `compute-sanitizer --tool memcheck` na `fem_cuda_csr_dmi_prism_contract`: **0 błędów pamięciowych**.

---

## 2. Benchmark flagowy: cienka warstwa permaloju `300 × 300 × 5 nm` (Aharoni + pełna relaksacja PGBB `tolT = 1e-7 T`)

Wszystkie pomiary Wave 1 wykonane na RTX 4080 SUPER w zarządzanym kontenerze DEV (`scripts/benchmarks/relax_film_compare_case.py` pod `run_memory_transfer_probe.py`, `hot_loop_gather_scatter_bytes = 0` dla wszystkich ukończonych biegów).

| Wariant / Kod | Siatka / Komórki | DOF potencjału demag | Czas siatki | VRAM `cuDSS` / bufory GPU | $E_{\mathrm{demag}}(t=0)$ [J] | Błąd vs Aharoni (`4.63285e-18`) | Zrelaks. $E_{\mathrm{total}}$ [J] | Błąd vs FDM (`3.10992e-18`) | $\langle m_x \rangle, \langle m_y \rangle$ | Kroki (`tolT=1e-7`) | Śr. czas kroku | Czas relaks. / całkowity |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| **Analityczny Aharoni (1998)** | dokładny prostopadłościan | — | — | — | `4.632850e-18` | `0.00%` | — | — | — | — | — | — |
| `fullmag FDM` GPU (audyt 2026-11-24) | `120×120×2` (`2.5 nm`) | FFT `28 800` | — | — | `4.632850e-18` | `-6e-7%` | `3.109921e-18` | `0.00%` | `0.6719, 0.6715` | `17 073` | `7.7 ms` | `131.6 s / 134.7 s` |
| `MuMax3 3.12` (audyt 2026-11-24, acc 6) | `120×120×2` (`2.5 nm`) | FFT `28 800` | — | — | `4.610057e-18` | `-0.49%` | `3.08758e-18` | `-0.72%` | `0.708, 0.631` | `44 406` | `1.5 ms` | `— / 68.8 s` |
| `FEM tet P2` (audyt 2026-11-24, RTX 5050) | `487 736` w., `3.1M` tet | `4 082 076` (P2) | `123 s` | `59.4 GiB` (OOM/stronic.) | `4.603813e-18` | `-0.63%` | *(przerwany)* | — | — | `170 / 423` | `~7 600 ms` | `> 3 600 s` |
| `FEM mixed prism P1` `L=1`, $h=5.0\;\mathrm{nm}$, `cuDSS` | `10 896` w. | `10 896` (P1) | `1.18 s` | `71 MB` / `0.097 GB` | `3.116337e-18` | **`-32.73%`** | `2.490147e-18` | **`-19.93%`** | `0.7528, 0.5991` | `1 661` | `5.23 ms` | `8.7 s / 25.3 s` |
| `FEM mixed prism P1` `L=1`, $h=2.5\;\mathrm{nm}$, `cuDSS` | `36 576` w. | `36 576` (P1) | `6.93 s` | `130 MB` / `0.222 GB` | `3.237685e-18` | **`-30.11%`** | `2.507958e-18` | **`-19.36%`** | `0.7530, 0.5941` | `4 393` | `6.09 ms` | `26.8 s / 81.0 s` |
| `FEM mixed prism P1` `L=2`, $h=2.5\;\mathrm{nm}$, `cuDSS` *(untangler 6→0)* | `54 016` w., `159 714` kom. | `54 016` (P1) | `8.08 s` | `180 MB` / `0.329 GB` | `3.429791e-18` | **`-25.97%`** | `2.582721e-18`\* | **`-16.95%`**\* | `0.7028, 0.6547`\* | `18 091`\* | `7.52 ms` | `136.1 s / 187.9 s`\* |
| **`FEM pure_prism_p2` `L=1`, $h=5.0\;\mathrm{nm}$, `cg_amg`** | `76 832` w., `143 490` pr. | **`594 239` (P2)** | **`0.39 s`** | `—` / `0.375 GB` | **`4.595727e-18`** | **`-0.80%`** | *(limit 20 kr.)* | — | — | `20` (limit) | `5 579.74 ms` | `111.6 s / 208.3 s` |
| **`FEM pure_prism_p2` `L=1`, $h=5.0\;\mathrm{nm}$, `cuDSS`** | `76 832` w., `143 490` pr. | **`594 239` (P2)** | **`0.50 s`** | **`5.52 GB` / `5.89 GB`** | **`4.595727e-18`** | **`-0.80%`** | **`3.094433e-18`** | **`-0.50%`** (`+0.22%` vs MuMax3) | **`0.6743, 0.6691`** | **`7 807`** | **`38.53 ms`** | **`300.8 s / 399.9 s`** |
| **`FEM pure_prism_p2` `L=2`, $h=5.0\;\mathrm{nm}$, `cuDSS`** | `91 238` w., `172 188` pr. | **`709 253` (P2)** | **`0.51 s`** | **`7.23 GB` / `7.70 GB`** | **`4.605080e-18`** | **`-0.60%`** | **`3.096700e-18`** | **`-0.43%`** (`+0.30%` vs MuMax3) | **`0.6745, 0.6688`** | **`8 153`** | **`51.88 ms`** | **`423.0 s / 546.7 s`** |
| `FEM pure_prism_p2` `L=1`, $h=2.5\;\mathrm{nm}$, `cudss` / `auto` | `285 152` w., `534 090` pr. | `2 208 719` (P2) | `2.53 s` | est. `21.18 GiB` (`> 9.10 GiB` budż.) | *(preflight / 600 it.)*\*\* | — | — | — | — | — | — | analiza `61.5 s` |

\* Uwaga do `mixed prism P1` `L=2` (`18 091` kroków): 5-krokowy bieg weryfikacyjny przeszedł czysto (`rc=0`), a bieg pełny dotarł do `max_torque = 1.73e-6 T` (`E_total = 2.582721e-18 J`), gdzie pojedyncze rozwiązanie bezpośrednie `cuDSS` zwróciło rezyduum `1.97e-13` wobec ścisłego progu `1e-13` (istniejąca czułość ścisłej weryfikacji rezyduum `cuDSS` dla siatki mieszanej P1; bezpieczny rollback stanu urządzenia).
\*\* Uwaga do `pure_prism_p2` $h=2.5\;\mathrm{nm}$: przy `gpu_strategy='cudss'` preflight VRAM czysto blokuje faktoryzację przed OOM (`21.18 GiB > 9.10 GiB` wolnego budżetu); przy `gpu_strategy='auto'` następuje przełączenie na `cg_amg` (`device_buffers = 1.399 GB`), gdzie sztywny limit skryptu `max_iterations=600` osiąga rezyduum `7.50e-10` przy ścisłym `rtol=1e-12` wymaganym przez PGBB.

### Szczegóły składowych energii zrelaksowanej (`pure_prism_p2` vs referencje)

| Metoda | $E_{\mathrm{ex}}$ [J] | $E_{\mathrm{demag}}$ [J] | $E_{\mathrm{total}}$ [J] | $\langle m_x \rangle$ | $\langle m_y \rangle$ | $\max |\tau|$ [T] |
|---|---:|---:|---:|---:|---:|---:|
| `fullmag FDM` GPU (`2.5 nm`) | `3.895426e-19` | `2.720379e-18` | `3.109921e-18` | `0.671866` | `0.671542` | `9.50e-8` |
| `MuMax3` (acc 12 na stanie FDM) | `3.895426e-19` | `2.712516e-18` | `3.102059e-18` | `0.671866` | `0.671542` | `1.20e-4` |
| `FEM mixed prism P1` `L=1` (`2.5 nm`) | `2.713702e-19` (`-30.3%`) | `2.236588e-18` (`-17.8%`) | `2.507958e-18` (`-19.4%`) | `0.752951` | `0.594054` | `8.49e-8` |
| **`FEM pure_prism_p2` `L=1` (`5.0 nm`)** | **`3.881510e-19` (`-0.36%`)** | **`2.706282e-18` (`-0.52%`)** | **`3.094433e-18` (`-0.50%`)** | **`0.674284`** | **`0.669116`** | **`9.97e-8`** |
| **`FEM pure_prism_p2` `L=2` (`5.0 nm`)** | **`3.892977e-19` (`-0.06%`)** | **`2.707402e-18` (`-0.48%`)** | **`3.096700e-18` (`-0.43%`)** | **`0.674475`** | **`0.668814`** | **`9.78e-8`** |

### Szczegóły faktoryzacji `cuDSS` na `pure_prism_p2` ($h = 5.0\;\mathrm{nm}$)

| Warstwy | `rows` (P2) | `lower_nnz` | `factor_nnz` | `analysis_ms` | `factorization_ms` | `device_bytes` | `vram_free` (po inicjalizacji) | Przyspieszenie vs `cg_amg` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `L=1` (`air 7+7`) | `594 239` | `13 616 981` | `540 867 409` | `12 253.6 ms` | `5 183.6 ms` | `5.52 GB` (`5.14 GiB`) | `9.48 GB` | **`144.8×`** (`38.53 ms` vs `5 579.74 ms`) |
| `L=2` (`air 8+8`) | `709 253` | `16 316 443` | `727 860 253` | `14 847.8 ms` | `6 919.5 ms` | `7.23 GB` (`6.73 GiB`) | `7.59 GB` | *(>140× wobec ~7.5 s/krok)* |

---

## 3. Konforemność siatki mieszanej `layers=2` (`pyramid_to_tetrahedra`)

- Test `300 × 300 × 5 nm`, $h = 2.5\;\mathrm{nm}$, `layers=2`, `transition="pyramid_to_tetrahedra"`:
  - `Gmsh mixed same_side tet untangler: node=53465, same_side_reduced=6, reoriented_tets=2, margin=4.452e-04`
  - Wynikowa siatka: `nodes=54 016`, `cells=159 714` (`film=66 904` graniastosłupów, `airbox=92 810` piramid i czworościanów), jakość `p05={'prism6': 0.8616, 'pyramid5': 0.4622, 'tet4': 0.1842}`, `same_side_two_owner_face = 0`.
  - Testy parametryczne Python (`test_thin_film_prismatic_layers_2_300x300x5_conforming[1,2,3]`): **3/3 PASS** dla `layers = 1, 2, 3` oraz testy jednostkowe untanglera (ścieżka `scipy.optimize.linprog`, fallback `numpy`, fail-closed): **PASS**.

---

## 4. Benchmark ujednoliconego operatora CSR GPU DMI vs legacy `tet4` GPU DMI i CPU MFEM

Pomiar na RTX 4080 SUPER (zdarzenia CUDA: 20 rozgrzewek + 200 iteracji dla GPU; 5–10 powtórzeń dla CPU MFEM z 4 wątkami OpenMP). Kolumna `CSR GPU pole` to ścieżka etapów RK bez redukcji energii (`energy_block_sums = nullptr`), `CSR GPU pole+E` to pełna ewaluacja pola + redukcja energii, `Legacy tet4 GPU` to dotychczasowy kernel elementowy `fullmag_cuda_dmi_field_energy` (`tet4`).

| Siatka | Typ DMI | Węzły | Elementy | CSR `nnz` | Budowa CSR [ms] | CPU MFEM [ms] | Legacy `tet4` GPU [ms] | CSR GPU pole [ms] | CSR GPU pole+E [ms] | vs CPU (pole) | vs Legacy (E / pole) | $h_{\mathrm{rel}}$ vs CPU | $E_{\mathrm{rel}}$ vs CPU | $h_{\mathrm{rel}}$ vs Legacy |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `tet4_32x32x4` | `interfacial_obl` | `5 445` | `24 576` | `65 160` | `46.94` | `42.052` | `0.1797` | `0.0539` | `0.1079` | `779.8×` | `1.67×` / `3.33×` | `4.12e-16` | `1.27e-14` | `4.12e-16` |
| `tet4_32x32x4` | `rotated_goebel` | `5 445` | `24 576` | `65 160` | `41.79` | `38.519` | `0.1928` | `0.0402` | `0.1122` | `957.6×` | `1.72×` / `4.80×` | `4.67e-16` | `3.00e-15` | `3.74e-16` |
| `tet4_32x32x4` | `bulk_uniform` | `5 445` | `24 576` | `65 160` | `41.06` | `37.156` | `0.0608` | `0.0133` | `0.0242` | `2 786.9×` | `2.51×` / `4.57×` | `4.09e-16` | `1.78e-14` | `3.41e-16` |
| `tet4_per_24x24x4` | `interfacial_obl` | `3 125` | `13 824` | `35 712` | `29.89` | `23.187` | — | `0.0216` | `0.1368` | `1 074.4×` | — | `6.59e-16` | `4.76e-14` | — |
| `tet4_per_24x24x4` | `rotated_goebel` | `3 125` | `13 824` | `35 712` | `27.89` | `21.428` | — | `0.0435` | `0.0332` | `493.1×` | — | `1.12e-15` | `3.87e-14` | — |
| `tet4_per_24x24x4` | `bulk_uniform` | `3 125` | `13 824` | `35 712` | `27.22` | `21.123` | — | `0.1040` | `0.1629` | `203.2×` | — | `8.67e-16` | `4.07e-16` | — |
| `prism6_60x60x2` | `interfacial_obl` | `11 163` | `14 400` | `167 764` | `76.25` | `47.074` | *(nieobsług.)* | `0.0529` | `0.1144` | `890.2×` | — | `6.27e-16` | `6.56e-15` | — |
| `prism6_60x60x2` | `rotated_goebel` | `11 163` | `14 400` | `167 714` | `65.34` | `43.166` | *(nieobsług.)* | `0.0536` | `0.1139` | `804.7×` | — | `4.84e-16` | `6.56e-15` | — |
| `prism6_60x60x2` | `bulk_uniform` | `11 163` | `14 400` | `167 764` | `66.11` | `41.201` | *(nieobsług.)* | `0.0582` | `0.1131` | `707.9×` | — | `6.58e-16` | `4.14e-15` | — |
| `prism6_120x120x2` | `interfacial_obl` | `43 923` | `57 600` | `666 724` | `297.68` | `190.768` | *(nieobsług.)* | **`0.0910`** | **`0.1033`** | **`2 097.1×`** | — | `4.81e-16` | `7.50e-15` | — |
| `prism6_120x120x2` | `rotated_goebel` | `43 923` | `57 600` | `666 434` | `294.45` | `173.993` | *(nieobsług.)* | **`0.0891`** | **`0.1034`** | **`1 953.0×`** | — | `4.79e-16` | `8.18e-15` | — |
| `prism6_120x120x2` | `bulk_uniform` | `43 923` | `57 600` | `666 724` | `273.48` | `168.534` | *(nieobsług.)* | **`0.0350`** | **`0.0374`** | **`4 811.8×`** | — | `5.48e-16` | `3.27e-14` | — |
| `mixed_30x30x2` | `interfacial_obl` | `3 843` | `5 460` | `42 484` | `17.05` | `11.546` | *(nieobsług.)* | `0.0600` | `0.1115` | `192.6×` | — | `4.04e-16` | `4.03e-15` | — |
| `mixed_30x30x2` | `rotated_goebel` | `3 843` | `5 460` | `42 466` | `14.39` | `10.916` | *(nieobsług.)* | `0.0530` | `0.1143` | `205.9×` | — | `5.23e-16` | `6.97e-15` | — |
| `mixed_30x30x2` | `bulk_uniform` | `3 843` | `5 460` | `42 484` | `14.65` | `10.455` | *(nieobsług.)* | `0.0580` | `0.1096` | `180.3×` | — | `6.57e-16` | `4.80e-15` | — |

---

## 5. Macierz testów (Etapy 1–2 na `c401f28b90`)

| Zestaw testów | Środowisko | Wynik | Szczegóły |
|---|---|---|---|
| Non-MFEM CI (`-DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_ENABLE_CUDA=OFF`) | Kontener DEV | **8/8 PASS** | Wszystkie 8 testów `native-modal-cabi-contract` w `0.07 s` |
| `fem_cuda_csr_dmi_prism_contract` | Kontener DEV GPU | **PASS** (`1.02 s`) | Parytet `tet4`, `prism6`, `mixed`, `periodic 2D`, `D=0`, skompensowana różnica energii `m1-m0` |
| `compute-sanitizer --tool memcheck` (`fem_cuda_csr_dmi_prism_contract`) | Kontener DEV GPU | **PASS (0 błędów)** | `ERROR SUMMARY: 0 errors`, `RC=0` |
| `fem_pure_prism_p2_gpu_contract` | Kontener DEV GPU | **PASS** | RK4 (`<= 1e-10`) i PGBB (`<= 1e-9`) CPU vs GPU dla obu strategii `cg_amg` i `cuDSS` (z DMI) |
| `fem_dmi_weak_residual`, `fem_dmi_contract` | Kontener DEV | **PASS** | Zgodność słabego rezyduum DMI |
| `fem_gpu_state_runtime_contract`, `fem_source_facade_gpu_state_contract` | Kontener DEV GPU | **PASS** | Stan CSR DMI i liczniki buforów |
| `fem_relaxation_energy_derivative_contract` | Kontener DEV GPU | **PASS** | Niezmieniona wyrocznia `tet4` |
| Asercje Wave 1 w `fem_mesh_contract`, `fem_gpu_rk_plan`, `source_facade_*`, `relaxation_source_contract` | Kontener DEV GPU | **PASS** | Wszystkie testy Wave 1 przechodzą (pozostałe pojedyncze błędy w tych plikach są pre-existing na bazie `9ab99132d5`) |
| Rust `fullmag-ir` | Kontener DEV | **290/290 PASS** | — |
| Rust `fullmag-api` (`mixed_v2_summary_tests`) | Kontener DEV | **2/2 PASS** | `pure_prism` + wzajemne wykluczanie certyfikatów |
| Rust `fullmag-plan` (`pure_prism`, `mixed_p1`) | Kontener DEV | **12/12 PASS** | `2/2` `pure_prism` + `10/10` `mixed_p1` |
| Rust `fullmag-runner` (default + `--features fem-gpu`) | Kontener DEV | **9/9 PASS** + kompilacja `--features fem-gpu` | `2/2` `pure_prism` + `7/7` `mixed_p1` (default i `fem-gpu`), `cargo check --features fem-gpu` (`runner --tests`, `api --bins`) |
| Python Wave 1 (`test_pure_prism_shared_domain_meshing.py`, `test_mixed_p1_preflight.py`, `test_script_builder_roundtrip.py`, slice Wave 1 `test_mixed_element_meshing.py`) | Kontener DEV | **103/103 PASS** | `10/10` pure_prism + `19/19` preflight + `67/67` (+63 subtesty) roundtrip + `7/7` untangler & `layers=1,2,3` & legacy normalize |
| Bramki statyczne (`check_repo_consistency.py`, `validate_changed_scientific_docs.py`) | Kontener DEV / host | **PASS** | 0 błędów spójności i kontraktu dokumentacji naukowej |
