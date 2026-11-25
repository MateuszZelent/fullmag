# Audyt wydajności i parzystości numerycznej akceleracji GPU backendu FDM (PG-BB, R2C/D2Z cuFFT, transport ładunku M1)

- **Data:** 2026-11-25
- **Gałąź robocza:** `codex/fdm-gpu-accel-20261124`
- **Baseline (`master`):** `124fa8591089686f094fa517521a0d615edcf510`
- **Zweryfikowany stan po zmianach (Faza 2):** `4944bc95a95d` (`e375444a90`, `e51a579430`, `687a988dc9`, `0335be0d32`, `7f225ff903`, `4944bc95a9`)
- **Środowisko pomiarowe:** NVIDIA GeForce RTX 4080 SUPER (16 GiB VRAM, SM 8.9 / `89-real`), Docker DEV worktree (`fullmag-worktree-fdm-gpu-accel-20261124-e516c8a8411d1c5f-backend-1`), CUDA runtime 12.6 (`12060`), sterownik `13040`, cuDSS SDK `/opt/fullmag-cudss/0.8.0.10` (`libcudss.so.0` podlinkowana w `/opt/fullmag/package/lib/libfullmag_fdm.so`)

## 1. Zakres zmian objętych audytem

Audyt dokumentuje porównanie A/B przed i po wdrożeniu trzech niezależnych akceleracji backendu FDM CUDA wykonanych w jednym cyklu weryfikacyjnym:

1. **Demagnetyzacja jednowarstwowa R2C/C2R i D2Z/Z2D cuFFT (`e375444a90`):** zastąpienie transformat zespolonych `Z2Z`/`C2C` transformatami rzeczywistymi `D2Z`/`Z2D` (FP64) i `R2C`/`C2R` (FP32) na półwidmie hermetycznym (`fft_nx/2 + 1`), z współdzielonym obszarem roboczym cuFFT (`max(work_fwd, work_inv)`) oraz zaktualizowaną konwersją jądra Newella i preflightem przestrzeni roboczej GPU.
2. **Rezydentna na GPU relaksacja PG-BB i naprawa poświadczenia `strict` (`687a988dc9`, `0335be0d32`, `4944bc95a9`):** przeniesienie pętli minimalizatora bezpośredniego Projected-Gradient Barzilai–Borwein (`single_layer_bb.cu`) całkowicie na GPU z redukcjami na urządzeniu, eliminacją pełnowektorowych transferów H2D/D2H w gorącej pętli, akceptacją skończonych nieunormowanych stanów początkowych w kroku 0 oraz pełnym poświadczeniem bitu operatora demagnetyzacji/relaksacji w trybie `strict`.
3. **Transport ładunku M1 na GPU — wieloblokowy kooperatywny AMG-PCG oraz opcjonalny cuDSS (`e51a579430`, `7f225ff903`):** rozbudowa hierarchii urządzenia do 6–7 poziomów z wieloblokowym kooperatywnym AMG-PCG oraz opcjonalny bezpośredni solver Cholesky cuDSS (`FULLMAG_FDM_CHARGE_DIRECT_SOLVER=cudss`) z symetrycznym pinowaniem rzędu 1 w komórce środkowej i iteracyjnym doprecyzowaniem na GPU dla warunku zerowej średniej (`zero_mean`).

## 2. Bench 1: Relaksacja PG-BB (`300x300x5 nm` i `256x256x2`)

Scenariusz główny: warstwa Permalloy `300 x 300 x 5 nm` (`120 x 120 x 2 = 28 800` komórek, `h = 2.5 nm`, `Ms = 800 kA/m`, `Aex = 13 pJ/m`, `alpha = 0.02`, stan początkowy jednorodny `(1, 0.1, 0)`, `algorithm="projected_gradient_bb"`, `tolT = 1e-7 T`). Scenariusz skalujący: `256 x 256 x 2` (`131 072` komórek, limit 200 kroków).

| Przypadek | Baseline `rc` / wall | Po zmianach `rc` / wall | Przyspieszenie (wall) | Kroki (B -> A) | Transfery pełnowektorowe H2D/D2H (B -> A) | `max \|dm\|` | `rel dE_ex` | `rel dE_demag` | `rel dE_total` | `gpu_workspace.peak_vram_bytes` (B -> A) |
|---|---|---|---:|---|---|---:|---:|---:|---:|---|
| `b1_120x120x2_extended` | `rc=0` / `191.67 s` | `rc=0` / `32.84 s` (zimny) | **5.84x** | `17073 -> 16519` | `61719 / 112975` (`40.25 GB`) -> obs `0 / 31` (`7.60 MB`), hot `0 / 0` | `2.730e-5` | `2.377e-8` | `3.340e-9` | `5.623e-11` | `47.16 -> 36.32 MB` (**-23.0%**) |
| `b1_120x120x2_strict` | `rc=1` / `171.74 s` | `rc=0` / `19.86 s` (ciepły) | **9.65x** vs ext (`8.65x` vs strict fail) | `fail -> 16519` | `fail ->` obs `0 / 31` (`7.60 MB`), hot `0 / 0` | `2.730e-5` | `2.377e-8` | `3.340e-9` | `5.623e-11` | `47.16 -> 36.32 MB` (**-23.0%**) |
| `b1_256x256x2_200steps_extended` | `rc=0` / `27.81 s` | `rc=0` / `16.85 s` | **1.65x** | `200 -> 200` | `780 / 1417` (`2.31 GB`) -> obs `0 / 31` (`34.60 MB`), hot `0 / 0` | `8.925e-2` (w trakcie trajektorii) | `1.305e-2` | `1.015e-2` | `1.057e-2` | `214.58 -> 164.82 MB` (**-23.2%**) |
| `b1_256x256x2_200steps_strict` | `rc=1` / `24.39 s` | `rc=0` / `16.69 s` | **1.67x** vs ext (`1.46x` vs strict fail) | `fail -> 200` | `fail ->` obs `0 / 31` (`34.60 MB`), hot `0 / 0` | `8.925e-2` (w trakcie trajektorii) | `1.305e-2` | `1.015e-2` | `1.057e-2` | `214.58 -> 164.82 MB` (**-23.2%**) |
| `b1_256x256x2_200steps_fp32_strict` | nowy przypadek | `rc=0` / `18.68 s` | — | `— -> 200` | obs `0 / 31` (`17.30 MB`), hot `0 / 0` | — | — | — | — | `85.45 MB` |

Najważniejsze obserwacje Bench 1:

- **Eliminacja błędu trybu `strict`:** na baseline oba przypadki `strict` kończyły się błędem `rc=1` (`required=0xa7 executed_device=0xa6 executed_unknown=0x1 missing_device=0x1`). Po zmianach wszystkie uruchomienia `strict` kończą się `rc=0` z poświadczeniem `required=0xa7 == executed_device=0xa7`, `executed_unknown=0x0`, `fallback_count=0`, `hot_loop_full_vector_h2d_count=0`, `hot_loop_full_vector_d2h_count=0` oraz `hot_loop_host_compute_count=0`.
- **Czas samego etapu relaksacji:** ostatni znacznik `heartbeat` etapu `flat_relax` dla `120x120x2` spadł z `185.0 s` (baseline) do `15.0 s` (po zmianach) — ok. **11x** krótszy etap relaksacji (`~11.0 ms/krok -> ~0.99 ms/krok`); pozostała część czasu `wall` to rozruch procesu CLI i zapis artefaktów.
- **Zbieżność fizyczna `120x120x2`:** oba przebiegi zbiegają do tego samego stanu równowagi (`E_total = 3.109921e-18 J`, `rel dE_total = 5.623e-11`, `max_torque = 9.5161e-8 T` -> `9.2205e-8 T`, `<m> = (0.671866, 0.671542, -2.36e-14)` -> `(0.67186, 0.67155, -2.27e-14)`). Różnica w 200. kroku dla `256x256x2` wynika wyłącznie z nieco innej długości kroków BB w trakcie niezakończonej jeszcze relaksacji (`max_torque ~ 5.8e-3 T`).

## 3. Bench 2: Dynamika LLG ze stałym `dt` (izolacja demagnetyzacji cuFFT)

Zweryfikowano wszystkie 34 uruchamialne kombinacje geometrii, integratorów (Heun, RK4), precyzji (FP64, FP32) i horyzontów (`50`, `500`, `2000` kroków). Przypadek `pbcxy_128x128x2_heun_fp32` jest intencjonalnie odrzucany (`rc=1`) zarówno na baseline, jak i po zmianach przez istniejący gate kwalifikacyjny dla FP32 + PBC CUDA.

### 3.1. Parzystość po 50 krokach (`s50`), po 500 krokach (`s500`) i redukcja przestrzeni roboczej GPU

| Przypadek | `rel dE_total` (`s50`) | `rel dE_demag` (`s50`) | `rel dE_total` (`s500`) | `max \|dm\|` (`s500`) | `s500` wall B -> A | `s500-s50` ms/krok B -> A (przysp.) | Czyste `(s2000-s50)/1950` ms/krok (przysp.) | `gpu_workspace` B -> A (oszczędność) |
|---|---:|---:|---:|---:|---|---|---|---|
| `256x256x1_heun_fp64` | `0.00e+00` | `1.76e-16` | `2.434e-15` | `5.429e-10` | `16.30 -> 13.84 s` (1.18x) | `9.45 -> 9.41` (1.00x) | `1.295 -> 1.186` (**1.09x**) | `69.54 -> 57.06 MB` (**-18.0%**) |
| `256x256x1_heun_fp32` | `2.71e-10` | `6.35e-10` | `5.395e-06` | `2.052e-01` | `14.83 -> 13.97 s` (1.06x) | `7.10 -> 10.37` (0.68x) | `0.372 -> 0.383` (0.97x) | `36.25 -> 30.01 MB` (**-17.2%**) |
| `256x256x1_rk4_fp64` | `0.00e+00` | `0.00e+00` | `1.631e-15` | `4.199e-10` | `20.83 -> 14.82 s` (1.41x) | `21.96 -> 11.49` (**1.91x**) | — | `74.26 -> 61.78 MB` (**-16.8%**) |
| `256x256x1_rk4_fp32` | `2.91e-10` | `4.21e-10` | `5.131e-06` | `1.761e-01` | `19.23 -> 14.70 s` (1.31x) | `14.21 -> 12.12` (1.17x) | — | `38.61 -> 32.37 MB` (**-16.2%**) |
| `128x128x2_heun_fp64` | `0.00e+00` | `0.00e+00` | `2.633e-14` | `1.728e-09` | `14.88 -> 8.62 s` (1.73x) | `10.30 -> 4.39` (**2.35x**) | `2.290 -> 0.714` (**3.21x**) | `53.65 -> 41.27 MB` (**-23.1%**) |
| `128x128x2_heun_fp32` | `7.59e-10` | `6.62e-10` | `7.414e-06` | `1.615e+00` | `11.73 -> 8.19 s` (1.43x) | `8.10 -> 4.45` (**1.82x**) | `1.352 -> 0.489` (**2.76x**) | `27.57 -> 21.38 MB` (**-22.5%**) |
| `128x128x2_rk4_fp64` | `0.00e+00` | `0.00e+00` | `1.925e-15` | `2.151e-09` | `12.55 -> 9.34 s` (1.34x) | `9.38 -> 5.48` (**1.71x**) | — | `56.01 -> 43.63 MB` (**-22.1%**) |
| `128x128x2_rk4_fp32` | `5.89e-11` | `6.61e-10` | `1.228e-05` | `6.166e-01` | `12.19 -> 8.55 s` (1.43x) | `9.54 -> 5.48` (**1.74x**) | — | `28.75 -> 22.56 MB` (**-21.5%**) |
| `64x64x32_heun_fp64` | `0.00e+00` | `0.00e+00` | `1.168e-14` | `1.219e-08` | `29.67 -> 22.95 s` (1.29x) | `16.87 -> 7.09` (**2.38x**) | — | `214.58 -> 165.82 MB` (**-22.7%**) |
| `64x64x32_heun_fp32` | `1.65e-09` | `5.59e-08` | `5.829e-05` | `1.993e+00` | `24.21 -> 21.72 s` (1.11x) | `9.01 -> 9.04` (1.00x) | — | `110.24 -> 85.86 MB` (**-22.1%**) |
| `64x64x32_rk4_fp64` | `0.00e+00` | `0.00e+00` | `6.994e-15` | `8.734e-09` | `33.90 -> 23.49 s` (1.44x) | `30.25 -> 12.27` (**2.47x**) | — | `224.01 -> 175.25 MB` (**-21.8%**) |
| `64x64x32_rk4_fp32` | `2.00e-09` | `5.70e-08` | `1.293e-04` | `1.988e+00` | `27.52 -> 23.83 s` (1.15x) | `16.46 -> 13.97` (1.18x) | — | `114.96 -> 90.58 MB` (**-21.2%**) |
| `pbcxy_128x128x2_heun_fp64` | `0.00e+00` | `0.00e+00` | `1.471e-14` | `1.683e-09` | `7.24 -> 7.10 s` (1.02x) | `5.50 -> 4.97` (1.11x) | — | `25.34 -> 22.29 MB` (**-12.0%**) |
| `cyl_128x128x2_heun_fp64` | `0.00e+00` | `0.00e+00` | `1.619e-14` | `1.909e-09` | `9.54 -> 8.95 s` (1.07x) | `6.26 -> 5.24` (1.19x) | — | `53.65 -> 41.27 MB` (**-23.1%**) |
| `cyl_128x128x2_heun_fp32` | `1.63e-09` | `1.75e-09` | `2.903e-05` | `6.700e-01` | `9.50 -> 7.94 s` (1.20x) | `6.35 -> 4.12` (**1.54x**) | — | `27.57 -> 21.38 MB` (**-22.5%**) |

Najważniejsze obserwacje Bench 2:

- **Parzystość maszynowa FP64:** we wszystkich 8 geometriach FP64 po 50 krokach `rel dE_ex = 0.00e+00`, `rel dE_total = 0.00e+00`, a `rel dE_demag <= 1.76e-16`; po 500 krokach `rel dE_total <= 2.63e-14` i `max |dm| <= 1.22e-8`.
- **Parzystość FP32:** po 50 krokach wszystkie 7 przypadków FP32 zachowują `rel dE_total <= 2.00e-9` (`rel dE_demag <= 5.70e-8`). Większe `max |dm|` po 500 krokach dla wybranych siatek FP32 (przy zachowanej parzystości energii `~5e-6..1.3e-4`) jest typowe dla nieliniowej precesji LLG w pojedynczej precyzji pod wpływem błędów zaokrągleń `1e-7` w transformacie FFT.
- **Wydajność i pamięć:** największe zyski występują dla siatek 3D (`128x128x2` Heun czyste `(s2000-s50)/1950`: **3.21x** FP64 i **2.76x** FP32; `64x64x32` FP64 RK4/Heun `s500-s50`: **2.47x / 2.38x**). Jednowarstwowe `256x256x1` (`nz=1`, 2D FFT) jest na RTX 4080 SUPER zdominowane przez narzut uruchomień jąder w FP32 (`0.372 -> 0.383 ms/krok`), ale nadal zyskuje **1.91x** w RK4 FP64 oraz **16.2–18.0%** mniej przestrzeni roboczej GPU. We wszystkich 15 geometriach `gpu_workspace.peak_vram_bytes` spadł o **12.0–23.1%**.

## 4. Bench 3: Transport ładunku M1 GPU (C ABI `libfullmag_fdm.so` + CLI)

Wszystkie 13 przypadków macierzy ABI (`U`, `M`, `I`, `F`, `Z` — w tym `boundary_ref` i `zero_mean`, tolerancja `rtol = 1e-13`) oraz oba przypadki publicznego CLI (`examples/fdm_gpu_charge_public.py` oraz `64x32x8`) zakończyły się statusem `PASS` (`host_fallbacks = 0`, `fallbacks_triggered = []`) zarówno dla domyślnego AMG-PCG, jak i opcjonalnego cuDSS.

- **Publiczne CLI (`fullmag-bin`):**
  - `b3_cli_public_2x1x1`: `3.46 s` (baseline) -> `2.91 s` (AMG, `iter=1`, `phys_res=1.38e-16`) / `4.62 s` (cuDSS, `iter=1`, `phys_res=1.38e-16`).
  - `b3_cli_64x32x8`: `3.46 s` (baseline) -> `2.41 s` (AMG, `iter=25`, `phys_res=6.27e-13`, `peak=4.53 MB`) / `2.81 s` (cuDSS, `iter=1`, `phys_res=2.95e-15`, `peak=85.04 MB`).

### 4.1. Bench 3a — Domyślny wieloblokowy kooperatywny AMG-PCG (6–7 poziomów)

| Przypadek | Komórki | Zimny B -> A (ms) | Przysp. zimny | Ciepły med. B -> A (ms) | Przysp. ciepły | Iteracje B -> A | Poziomy B -> A | `phys_res` | `elec_bal` | `comp_bal` | `rel max \|dV\|` | `rel max \|dJ_c\|` | Peak MB B -> A |
|---|---:|---|---:|---|---:|---|---|---:|---:|---:|---:|---:|---|
| `U_33x9x5` | 1 485 | `33.90 -> 34.64` | 0.98x | `16.00 -> 4.40` | **3.64x** | `24/0 -> 24/0` | `2 -> 6` | `1.87e-14` | `6.01e-14` | `1.82e-15` | `4.404e-15` | `1.037e-13` | `0.60 -> 0.53` |
| `M_33x9x5` | 1 485 | `21.85 -> 28.59` | 0.76x | `15.91 -> 5.07` | **3.14x** | `23/0 -> 23/0` | `2 -> 6` | `6.20e-14` | `9.33e-14` | `2.83e-15` | `1.927e-14` | `4.826e-13` | `0.60 -> 0.53` |
| `I_35x9x5` | 1 575 | `19.86 -> 30.37` | 0.65x | `5.89 -> 5.91` | 1.00x | `28/0 -> 24/0` | `2 -> 6` | `2.62e-14` | `6.93e-14` | `1.94e-15` | `8.445e-15` | `1.567e-13` | `0.63 -> 0.56` |
| `F_37x9x5` | 1 665 | `26.38 -> 31.10` | 0.85x | `19.04 -> 5.22` | **3.65x** | `24/0 -> 24/0` | `2 -> 6` | `4.08e-14` | `7.42e-14` | `2.00e-15` | `1.724e-14` | `3.229e-13` | `0.68 -> 0.60` |
| `Z_33x9x5` | 1 485 | `90.03 -> 32.09` | **2.81x** | `13.36 -> 5.80` | **2.30x** | `25/1 -> 25/1` | `2 -> 6` | `6.09e-15` | `0.00e+00` | `4.05e-32` | `2.168e-15` | `2.429e-14` | `0.60 -> 0.53` |
| `M_65x13x7` | 5 915 | `33.28 -> 64.64` | 0.51x | `22.83 -> 15.61` | **1.46x** | `33/0 -> 26/0` | `2 -> 7` | `6.99e-14` | `3.93e-13` | `6.04e-15` | `9.808e-15` | `4.250e-13` | `2.26 -> 1.89` |
| `I_67x13x7` | 6 097 | `35.90 -> 65.00` | 0.55x | `31.75 -> 20.14` | **1.58x** | `39/0 -> 26/0` | `2 -> 7` | `5.82e-14` | `3.19e-13` | `4.72e-15` | `1.123e-14` | `2.403e-13` | `2.33 -> 1.95` |
| `F_69x13x7` | 6 279 | `95.43 -> 73.30` | **1.30x** | `57.86 -> 16.53` | **3.50x** | `34/0 -> 26/0` | `2 -> 7` | `7.94e-14` | `3.16e-13` | `4.57e-15` | `1.504e-14` | `3.983e-13` | `2.42 -> 2.02` |
| `U_64x32x8` | 16 384 | `181.13 -> 47.62` | **3.80x** | `77.77 -> 17.32` | **4.49x** | `34/0 -> 27/0` | `2 -> 6` | `5.51e-14` | `2.60e-13` | `4.06e-15` | `1.399e-14` | `4.578e-13` | `6.07 -> 4.92` |
| `M_64x32x8` | 16 384 | `237.95 -> 42.92` | **5.54x** | `108.64 -> 18.32` | **5.93x** | `34/0 -> 27/0` | `2 -> 6` | `7.47e-14` | `3.97e-13` | `6.20e-15` | `2.311e-14` | `6.142e-13` | `6.07 -> 4.92` |
| `Z_64x32x8` | 16 384 | `1015.23 -> 46.68` | **21.75x** | `141.49 -> 22.29` | **6.35x** | `29/2 -> 28/3` | `2 -> 6` | `1.34e-14` | `0.00e+00` | `8.23e-33` | `1.983e-15` | `6.245e-14` | `6.07 -> 4.92` |
| `U_128x64x8` | 65 536 | `749.09 -> 129.07` | **5.80x** | `492.86 -> 65.87` | **7.48x** | `57/1 -> 30/0` | `2 -> 7` | `7.14e-14` | `1.12e-12` | `8.77e-15` | `1.997e-14` | `1.096e-12` | `24.01 -> 19.32` (**-19.5%**) |
| `M_128x64x8` | 65 536 | `599.45 -> 121.17` | **4.95x** | `436.47 -> 77.67` | **5.62x** | `57/1 -> 29/1` | `2 -> 7` | `1.75e-13` | `1.71e-12` | `1.34e-14` | `4.316e-14` | `1.770e-12` | `24.01 -> 19.32` (**-19.5%**) |

### 4.2. Bench 3b — Opcjonalny bezpośredni solver Cholesky cuDSS (`FULLMAG_FDM_CHARGE_DIRECT_SOLVER=cudss`)

| Przypadek | Komórki | Zimny B -> A (ms) | Przysp. zimny | Ciepły med. B -> A (ms) | Przysp. ciepły | Iteracje | `phys_res` | `elec_bal` | `comp_bal` | `rel max \|dV\|` | `rel max \|dJ_c\|` | Peak MB B -> A |
|---|---:|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| `U_33x9x5` | 1 485 | `33.90 -> 165.42` | 0.20x | `16.00 -> 6.65` | **2.40x** | `1/1` | `2.33e-15` | `3.78e-16` | `1.15e-17` | `1.739e-14` | `1.215e-13` | `0.60 -> 44.64` |
| `M_33x9x5` | 1 485 | `21.85 -> 60.94` | 0.36x | `15.91 -> 4.28` | **3.71x** | `1/1` | `2.93e-15` | `1.16e-15` | `3.53e-17` | `3.165e-14` | `4.228e-13` | `0.60 -> 17.38` |
| `I_35x9x5` | 1 575 | `19.86 -> 22.96` | 0.86x | `5.89 -> 4.33` | **1.36x** | `1/1` | `2.82e-15` | `3.30e-16` | `9.23e-18` | `2.106e-14` | `1.407e-13` | `0.63 -> 17.41` |
| `F_37x9x5` | 1 665 | `26.38 -> 25.73` | 1.03x | `19.04 -> 4.50` | **4.23x** | `1/1` | `2.39e-15` | `5.24e-16` | `1.42e-17` | `2.960e-14` | `2.852e-13` | `0.68 -> 17.46` |
| `Z_33x9x5` | 1 485 | `90.03 -> 52.15` | **1.73x** | `13.36 -> 4.75` | **2.81x** | `1/1` | `5.57e-16` | `0.00e+00` | `3.24e-33` | `1.952e-14` | `3.145e-14` | `0.60 -> 17.38` |
| `M_65x13x7` | 5 915 | `33.28 -> 80.26` | 0.41x | `22.83 -> 16.16` | **1.41x** | `1/1` | `4.36e-15` | `5.41e-16` | `8.33e-18` | `9.666e-14` | `9.775e-13` | `2.26 -> 25.25` |
| `I_67x13x7` | 6 097 | `35.90 -> 62.66` | 0.57x | `31.75 -> 15.34` | **2.07x** | `1/1` | `5.48e-15` | `4.51e-16` | `6.70e-18` | `7.755e-14` | `4.443e-13` | `2.33 -> 27.41` |
| `F_69x13x7` | 6 279 | `95.43 -> 88.57` | 1.08x | `57.86 -> 16.82` | **3.44x** | `1/1` | `3.87e-15` | `5.92e-18` | `8.59e-20` | `8.255e-14` | `6.435e-13` | `2.42 -> 29.59` |
| `U_64x32x8` | 16 384 | `181.13 -> 132.37` | **1.37x** | `77.77 -> 14.65` | **5.31x** | `1/1` | `3.23e-15` | `6.04e-15` | `9.44e-17` | `8.305e-14` | `6.176e-13` | `6.07 -> 58.17` |
| `M_64x32x8` | 16 384 | `237.95 -> 132.00` | **1.80x** | `108.64 -> 14.72` | **7.38x** | `1/1` | `4.68e-15` | `2.00e-15` | `3.13e-17` | `1.098e-13` | `1.207e-12` | `6.07 -> 58.17` |
| `Z_64x32x8` | 16 384 | `1015.23 -> 126.62` | **8.02x** | `141.49 -> 16.58` | **8.53x** | `1/1` | `8.47e-16` | `0.00e+00` | `2.13e-33` | `9.252e-14` | `1.422e-13` | `6.07 -> 58.17` |
| `U_128x64x8` | 65 536 | `749.09 -> 2162.29` | 0.35x | `492.86 -> 66.88` | **7.37x** | `1/1` | `4.21e-15` | `1.06e-15` | `8.27e-18` | `3.101e-13` | `1.998e-12` | `24.01 -> 194.58` |
| `M_128x64x8` | 65 536 | `599.45 -> 521.70` | **1.15x** | `436.47 -> 77.63` | **5.62x** | `1/1` | `8.15e-15` | `1.11e-14` | `8.66e-17` | `4.120e-13` | `3.497e-12` | `24.01 -> 194.58` |

Wnioski Bench 3:

- **AMG-PCG jako domyślny wybór:** dla dużych siatek (`16k–65.5k`) skraca zarówno zimny (`3.80x–21.75x`), jak i ciepły czas rozwiązania (`4.49x–7.48x`), jednocześnie redukując szczytowe zużycie VRAM o **19.5%** (`24.01 -> 19.32 MB` dla `65 536` komórek) przy zachowaniu parzystości potencjału `rel max |dV| <= 4.32e-14`.
- **cuDSS jako ścieżka opt-in do powtarzalnych rozwiązań:** po jednorazowej faktoryzacji osiąga residua fizyczne `5.57e-16..8.15e-15` oraz ciepłe przyspieszenia **1.36x–8.53x** (`Z_64x32x8`: **8.53x**, `U_128x64x8`: **7.37x**), kosztem pamięci czynników (`58.2 MB` dla `16k`, `194.6 MB` dla `65.5k`) i czasu pierwszej faktoryzacji dla dużych siatek 3D.

## 5. Weryfikacja odtwarzalności

Wszystkie pomiary zostały wykonane wyłącznie wewnątrz izolowanego kontenera Docker DEV worktree (`fullmag-worktree-fdm-gpu-accel-20261124-e516c8a8411d1c5f-backend-1`) przy użyciu `/opt/fullmag/package/bin/fullmag-bin` oraz `/opt/fullmag/package/lib/libfullmag_fdm.so` bez kompilacji na hoście:

- Bench 1 (`120x120x2` `extended`/`strict`): `FILM_ENGINE=fdm FILM_MODE=strict FILM_TOLT=1e-7 /opt/fullmag/package/bin/fullmag-bin run scripts/benchmarks/relax_film_compare_case.py`
- Bench 2 (LLG `s50`/`s500`/`s2000`): dedykowany skrypt scenariusza stałego `dt` (`Heun`/`RK4`, `FP64`/`FP32`, cienka warstwa / 3D / `pbcxy` / cylinder) uruchamiany przez `fullmag-bin run`
- Bench 3 (M1 Charge): publiczny przykład `fullmag-bin run examples/fdm_gpu_charge_public.py`, scenariusz `64x32x8` oraz bezpośrednie wywołania C ABI `fullmag_fdm_charge_*` przeciwko `/opt/fullmag/package/lib/libfullmag_fdm.so` (domyślny AMG i `FULLMAG_FDM_CHARGE_DIRECT_SOLVER=cudss`)
