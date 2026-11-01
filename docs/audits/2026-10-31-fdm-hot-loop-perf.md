# Audyt wydajności pętli FDM CPU i CUDA (2026-10-31)

Zakres: cztery podejrzenia z audytu solverów FDM, każde zmierzone przed zmianą.
Kod zmieniono tylko tam, gdzie zysk jest zmierzony. Zgodność wyników sprawdzano
skrótem wartości `m_final` (bitowo) albo maksymalną różnicą pola (zaokrąglenia).

## Wynik w skrócie

| podejrzenie | pomiar | decyzja |
|---|---|---|
| 1. CPU SoA exchange szeregowy | cała ścieżka SoA była szeregowa; exchange-only 256²×1: 20,3 → 11,1 ms/krok, 128²×32: 162,8 → 55,6 ms/krok | poprawione, wynik bitowo identyczny |
| 2. materiały niejednorodne zawsze AoS | po poprawce 1 AoS jest o 40% (exchange-only) i 22% (z demag) wolniejszy od SoA | zmierzone; refaktor SoA ze współczynnikami per komórka jako osobne zadanie |
| 3. CUDA region LUT | kernel z LUT 1,65× wolniejszy od gałęzi jednorodnej; szerokość maski i liczba regionów bez znaczenia | gałąź jednorodna przy jednorodnym LUT; różnica pola 4·10⁻¹⁶ względnie |
| 4. CUDA adaptive: synchronizacja hosta co krok | adaptive RK45 vs stały RK45 przy tym samym dt: +0,23 ms/krok (+7%) przy 65 tys. komórek | tylko pomiar, poprawność należy do sesji adaptive-dt-race |

Największy zmierzony koszt nie był na liście: podgląd live CLI w trasie
`fullmag-bin --headless` (sekcja „Ustalenia poboczne”, punkt 1).

## Metoda

- Grupa Docker DEV worktree `fdm-hot-loop-perf-r2-20261031`, kontener `backend`:
  budżet 4 CPU (rayon 4 wątki), GPU RTX 4080 SUPER 16 GiB.
- Profil Cargo `backend-dev`: silnik `opt-level=3`, ale dziedziczy `dev`
  (debug-assertions, overflow-checks), runner `opt-level=1`, `codegen-units=256`,
  bez LTO. Liczby bezwzględne nie są liczbami wydania. Porównania przed/po używają
  tego samego profilu.
- Trasa: `fullmag-bin scripts/benchmarks/fdm_hot_loop_case.py --backend fdm --headless
  --json`. Sterownik `scripts/benchmarks/run_fdm_hot_loop_bench.py`: 3 powtórzenia,
  mediana. `FULLMAG_API_PORT=0`, bo przebieg headless podpięty do API grupy jest
  zatrzymywany przy wymianie sesji.
- Stan: losowa tekstura `seed=7`, Ms = 800 kA/m, A = 13 pJ/m, α = 0,02,
  B_ext = 10 mT wzdłuż z, komórka 4 nm, fp64, stały dt = 1e-13 s, Heun, o ile nie
  zaznaczono inaczej. „ex” = bez demag, „full” = z demag.
- Czas kroku CPU: suma `wall_time_ns` z `solver_steps.csv` (krok silnika plus
  `publish_accepted_to`) podzielona przez liczbę kroków.
- Czas kroku CUDA: pas nie raportuje czasu kroku. Liczony jako
  (wall(N) − mediana wall(N/10)) / (kroki(N) − kroki(N/10)), z liczbą kroków
  z paragonu (`observed_step_count`). Szum tej metody to ok. ±0,07 ms/krok.
  Przebiegi CUDA idą z wyłączonym podglądem live (punkt 1 ustaleń pobocznych).
- Profilowanie CPU: `valgrind --tool=callgrind`. `ncu` w kontenerze nie ma dostępu do
  liczników GPU (`ERR_NVGPUCTRPERM`, ustawienie administracyjne hosta), więc kernel
  exchange mierzono mikrobenchmarkiem CUDA-event
  `scripts/benchmarks/cuda_exchange_region_bench.cu`.

## 1. CPU: ścieżka SoA

### Przyczyna

Ścieżka persistent SoA (`step_soa_with_buffers_evaluation`, jednorodny materiał bez
zamrożonych spinów) była w całości szeregowa: exchange, `llg_rhs_soa_into`, pętle
etapów Heun/RK4/RK23/RK45/ABM3, `max_norm_soa`, `max_cross_norm_soa`, `add_soa_into`.
Równoległe były tylko FFT demag i norma błędu. Dlatego SoA był wolniejszy od
równoległej ścieżki AoS (20,3 vs 15,9 ms/krok).

### Zmiany

1. `crates/fullmag-engine/src/fdm/cpu/soa_par.rs`: mapy per komórka
   (`soa_for_each_mut`, `soa_fill`, `soa_try_fill`, `soa_for_each_row_mut`). Każda
   komórka liczy niezależne domknięcie i pisze tylko swoje składowe, więc wynik
   równoległy jest bitowo równy szeregowemu. Max-normy liczy dokładna redukcja `max`
   (`max_over_cells`). Sumy energii zostały szeregowe, bo równoległa suma zmienia bity.
2. Exchange SoA iteruje wierszami wzdłuż x: (y, z) i przesunięcia sąsiednich wierszy
   są liczone raz na wiersz zamiast trzech dzieleń całkowitych na komórkę. Wyrażenie
   zmiennoprzecinkowe bez zmian. callgrind przed tą zmianą (128²×1, 1 wątek, 20 kroków):
   ok. 3400 instrukcji na komórkę i krok, z czego domknięcie exchange 30%,
   `GridShape::index` 8%, `neighbor_index` 9%.
3. `#[inline]` dla `GridShape::index` i `ExchangeLlgProblem::is_active`.

### Wyniki (ms/krok, mediana z 3)

| przypadek | siatka | baza `f95aa31e1` | + równoległe SoA | + exchange wierszami | przyspieszenie | `m_final` |
|---|---|---:|---:|---:|---:|---|
| ex, Heun | 256×256×1 | 20,289 | 11,693 | 11,073 | 1,83× | identyczny |
| ex, Heun | 128×128×32 | 162,826 | 62,853 | 55,577 | 2,93× | identyczny |
| full, Heun | 256×256×1 | 75,824 | 67,565 | 66,155 | 1,15× | identyczny |
| full, Heun | 128×128×32 | 526,144 | 428,833 | 409,274 | 1,29× | identyczny |
| full, RK45 stały dt | 128×128×32 | 1237,397 | 964,894 | 996,289 | 1,24× | identyczny |
| hetero ex (AoS) | 256×256×1 | 15,947 | 16,052 | 15,576 | — | identyczny |
| hetero full (AoS) | 128×128×32 | 498,904 | 489,937 | 498,313 | — | identyczny |

„identyczny” oznacza ten sam SHA-256 wartości `m_final` we wszystkich przebiegach
przed i po. RK45 po drugiej zmianie (996 vs 965 ms) mieści się w rozrzucie
przebiegów; druga zmiana dotyczy tylko exchange.

Skalowanie po pierwszej zmianie (ex, 100 kroków): 128² 4,2 ms, 256² 11,6 ms,
512² 34,2 ms przy 4 wątkach; 256² przy 1 wątku 20,5 ms. Koszt rośnie liniowo
z liczbą komórek. Pozostały czas to praca per komórka w profilu `backend-dev`,
nie stały narzut kroku.

## 2. CPU: niejednorodne materiały (AoS)

Region z innym Ms daje `spatial_saturation_magnetisation`, więc
`soa_fast_path_rejection_reason()` kieruje krok na AoS. Po poprawce 1:

| przypadek | jednorodny (SoA) | niejednorodny (AoS) | narzut AoS |
|---|---:|---:|---:|
| ex 256×256×1 | 11,073 | 15,576 | +41% |
| full 128×128×32 | 409,274 | 498,313 | +22% |

Ścieżka SoA ze współczynnikami per komórka (Ms, A, α) i maską zamrożonych spinów
zlikwidowałaby ten narzut, ale wymaga wariantów SoA wszystkich członów pola
i redukcji energii. To osobne zadanie; tutaj tylko zmierzone.

## 3. CUDA: region mask i LUT exchange

Każdy plan FDM ma niepusty `region_mask` (same zera dla jednego ciała), więc
`has_region_mask` jest zawsze prawdą i kernel `exchange_field_fp64_kernel` zawsze
czytał LUT 256×256 fp64.

### Mikrobenchmark kernela (CUDA events, µs na wywołanie)

| wariant | 512×512×32 (8,4 M) | 256×256×8 (0,5 M) |
|---|---:|---:|
| gałąź jednorodna (Laplasjan) | 813,0 | 54,5 |
| LUT, maska uint32, 1 region | 1377,8 | 88,9 |
| LUT, maska uint32, 64 regiony | 1380,1 | 90,5 |
| LUT, maska uint8, 64 regiony | 1392,1 | 87,8 |

Gałąź jednorodna jest 1,65× szybsza. Liczba regionów i szerokość maski nie mają
znaczenia, więc węższa maska nic nie daje; LUT zostaje fp64. Maksymalna różnica pola
LUT vs jednorodne dla jednorodnego A: 7,5·10⁻⁹ A/m przy |H| = 1,8·10⁷ A/m
(względnie 4·10⁻¹⁶).

### Zmiana

`fullmag_fdm_backend_create_impl` ustawia `Context::exchange_lut_uniform`, gdy każdy
wpis zbudowanego LUT równa się dokładnie A. Standardowe wywołanie
`exchange_field_fp64_kernel` wybiera wtedy gałąź jednorodną. Ścieżki T0/T1, fp32
i redukcja energii bez zmian. Opis w `docs/physics/0400-fdm-exchange-demag-zeeman.md`
(§3.1.2, „Heterogeneous exchange coefficient”).

### Wpływ na krok (ms/krok, podgląd wyłączony)

| przypadek | przed | po | uwagi |
|---|---:|---:|---|
| ex 256×256×8 | 0,578 | 0,649 | w szumie metody (±0,07) |
| ex 256×256×8, 64 regiony | 0,518 | 0,593 | w szumie |
| full 256×256×8 | 17,089 | 18,213 | demag dominuje |
| full 256×256×1 | 1,365 | 1,123 | w szumie |

Oczekiwany zysk z pomiaru kernela: 2 wywołania na krok Heuna × 34 µs = 0,07 ms/krok
przy 0,5 M komórek (ok. 12% kroku exchange-only) i 2 × 565 µs = 1,1 ms/krok przy
8,4 M komórek. Różnicowa metoda czasu kroku nie rozdziela tak małej różnicy.
Przebiegi po zmianie są deterministyczne (jeden skrót na 3 przebiegi); skrót różni się
od przebiegów sprzed zmiany, zgodnie ze zmianą kolejności działań.

## 4. CUDA adaptive: synchronizacja hosta

`adaptive_batch_execution_eligible(plan, live)` wymaga `!live`, a CLI zawsze
przekazuje konsumenta live, także w trybie headless. Trasa `fullmag-bin` nigdy więc nie
używa ścieżki wsadowej ani grafu: paragon pokazuje
`realization = cuda_conditional_graph_v1`, `graph_launch_count = 0`,
`step_completion_host_sync_count` = liczba kroków.

| przypadek 256×256×1 | ms/krok | kroki |
|---|---:|---:|
| RK45, stały dt = 1e-13 s | 3,179 | 10000 |
| RK45 adaptive (dt stoi na `dt_initial`) | 3,410 | 10006–10010 |

Narzut kontroli błędu i synchronizacji co krok: +0,23 ms/krok (+7%) przy 65 tys.
komórek. Przy tej siatce stały narzut na krok jest znaczący; przy większych siatkach
udział maleje. Sesja adaptive-dt-race ustaliła, że w tej ścieżce `dt` nie przyjmuje
`dt_suggested`, a kopie dp45/rk23 mają wyścig strumieni. Zgodnie z tym oba warianty
RK45 na GPU dają w każdym przebiegu inny `m_final`. Tu nic nie poprawiano.

## Ustalenia poboczne

1. **Podgląd live w trasie headless dominuje czas CUDA.** 256×256×32 exchange-only:
   20 kroków 94,1 s, 200 kroków 293,4 s z podglądem; 89,7 s i 87,7 s bez niego
   (`FULLMAG_DISABLE_PREVIEW_3D=1`, `FULLMAG_DISABLE_PREVIEW_2D=1`,
   `FULLMAG_DISABLE_LIVE_MAGNETIZATION=1`). Kopie D2H pełnego pola: 954 (28,3 GB)
   vs 39 (0,75 GB) na 200 kroków. Wynik identyczny. Pierwszy pomiar bazowy GPU (bez
   tych flag, 47 ms/krok przy 512×512×32) mierzył podgląd, nie kernele. Do decyzji:
   czy headless bez podłączonego API powinien publikować podgląd.
2. CUDA demag: 17 ms/krok przy 256×256×8 wobec 0,58 ms bez demag. Bez liczników GPU
   nie rozłożono tego czasu.
3. CUDA 512×512×32 z demag: preflight OOM (wymaga 39,7 GB, dostępne 14,9 GB).
4. Start przebiegu jest drogi: przy 2 M komórek `m_initial.json` i `m_final.json` mają
   po 209 MB, `metadata.json` 299 MB; 512×512×32 potrzebuje ok. 340 s przed krokami.
5. `fm.texture.random(...)` i tekstury wiru na wielu ciałach FDM są odrzucane
   („sampled_field has 4096 vectors, but its realized native grid requires 2048 cells”).
6. W płaskim API demag jest domyślnie włączony; przypadki exchange-only muszą go
   wyłączyć jawnie (`study.demag(enabled=False)`).
7. Przebieg headless w kontenerze DEV podpina się do API grupy i jest przerywany
   („attached runtime owner session was replaced”); pomiary wymagają
   `FULLMAG_API_PORT=0`.

## Odtworzenie

W kontenerze `backend` grupy DEV, z katalogu źródeł:

```bash
python3 scripts/benchmarks/run_fdm_hot_loop_bench.py --output /build/fdm-bench/cpu --suite cpu --repeat 3 --with-preview
python3 scripts/benchmarks/run_fdm_hot_loop_bench.py --output /build/fdm-bench/gpu --suite gpu --repeat 3
nvcc -O3 -arch=native -o /build/fdm-bench/exchange_bench scripts/benchmarks/cuda_exchange_region_bench.cu && /build/fdm-bench/exchange_bench 512 512 32 200
```

Pomiary CPU bazy i po zmianach szły z domyślnym podglądem (`--with-preview`), żeby
warunki były identyczne; czas kroku CPU nie obejmuje publikacji podglądu.

## Ograniczenia

- Nie kompilowano testów jednostkowych (zakaz w AGENTS.md). Dowodem poprawności są
  identyczne skróty `m_final` (CPU) i porównanie pola w mikrobenchmarku (CUDA).
- Ścieżki CPU z transportem spinu, ABM3 i RK23/RK4 korzystają z tych samych map,
  ale benchmark mierzył Heun i RK45.
- Profil `backend-dev` zawyża liczby bezwzględne względem wydania.
