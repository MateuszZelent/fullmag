# Audyt wydajności solverów Fullmag: FDM CPU, FDM GPU, FEM CPU, FEM GPU

- Data: 2026-11-10
- Audytowany commit: `c0ae004ca270fa56d1c8a06a540a465ebee6dec6` (branch `codex/sp4-fem-cupti-profile`)
- Przypadek: µMAG Standard Problem 4; siatka FEM R2 (26149 węzłów, 138199 elementów), siatka FDM 128×32×1
- Charakter: audyt tylko do odczytu. Niczego nie zbudowano, nie uruchomiono ani nie zmieniono.

## Podsumowanie

W FEM (GPU i CPU) prawie cały czas solvera to rozwiązanie Poissona dla demagu, a nie transfery pól.
Żadna z dotychczasowych optymalizacji FEM GPU nie ma udowodnionego przyspieszenia: każda para
pomiarowa ma n=1, a rozrzut między biegami (ok. 14%) jest większy niż mierzone efekty.

## Zakres dowodu i stan wyjściowy

- Źródła: odczyt kodu z eksportu `git archive` commita `c0ae004ca` oraz istniejące artefakty w
  `storage/user-data/fullmag-worktree-fullmag-a8342df1f0247d61/{sp4-diagnostics,sp4-comparison-20261102}`.
- Cztery kluczowe miejsca w kodzie sprawdzono bezpośrednio (oznaczone ✔). Pozostałe numery linii
  pochodzą z audytów cząstkowych; w części FDM są przybliżone (±5).
- PR [MateuszZelent/fullmag#419](https://github.com/MateuszZelent/fullmag/pull/419) jest otwarty i
  niescalony. Worktree jest za masterem (`da795b554`, merge #422), więc wnioski dotyczą `c0ae004ca`.
- Worktree: brak zmian w plikach śledzonych; 52 pliki nieśledzone (skrypty SP4 i siatka R2).
- Stan grupy Docker `fullmag-worktree-fullmag-a8342df1f0247d61` i portów 3274/8766: **NOT VERIFIED**
  (Docker Desktop nie odpowiadał w czasie audytu).
- Pomiary FEM CPU pochodzą ze starszych buildów (d34e162…59d3369b), nie z `c0ae004ca`.

## A. Cztery realizacje

| Realizacja | Aktualna ścieżka | Główny koszt | Dostępny dowód | Brakujące pomiary |
|---|---|---|---|---|
| FEM GPU, dynamika | RK45, jedno FFI na krok, 6 RHS na krok (FSAL działa), HyprePCG + BoomerAMG na urządzeniu | Poisson: 97,2% czasu solvera, 99 ms na solve, średnio 36 iteracji CG | pary CUPTI, 7 kroków / 50 fs, n=1 | powtórzenia, dłuższy bieg, czas faz na solve, suma iteracji CG |
| FEM GPU, relaksacja | PGBB natywny, sterowanie Armijo/BB na hoście | 756 s na 1567 iteracji (0,48 s/iterację); co najmniej 2 solve Poissona od zera na iterację | Zarr R2 i provenance | liczba solve na iterację, podział faz |
| FEM CPU | ten sam HYPRE (build z CUDA i OpenMP) w polityce host, potencjał P2 (193 155 DOF) | PCG+AMG: ok. 0,4 s na RHS, 87–90% kroku | próby 500 fs na starszych buildach, różne commity między liczbami wątków | krzywa wątków na jednym buildzie; relaksacja R2 (Zarr nie istnieje) |
| FDM CPU | Rustowy `CpuReference`, rustfft, BB w `direct_minimizer_reference.rs` | FFT: 14,3 s z 29,1 s (30 wątków) | Zarr relaksacji | skan wątków, liczniki FFT na iterację |
| FDM GPU | natywny CUDA BB, cuFFT, pola rezydentne | narzut uruchomień: ok. 11 kerneli, 2 synchronizacje i 3 FFI na iterację; cały bieg 1,45 s | Zarr relaksacji | czas na iterację |

## B. Ustalenia

### FEM GPU

| Miejsce | Mechanizm | Częstotliwość | Koszt | Pewność |
|---|---|---|---|---|
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp:154-157` ✔ | wewnętrzna tolerancja CG = 0,1 × autorska (1e-13 zamiast 1e-12) | każdy solve | dodatkowe iteracje; niezmierzone | kod: wysoka |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp:466` ✔ | certyfikat residuum wymuszony stałą: +1 SpMV, +2 odczyty skalarów z synchronizacją | każdy solve | mały wobec pętli PCG | wysoka |
| pętla PCG w HYPRE | 2 iloczyny skalarne z odczytem na host na iterację; ok. 113 uruchomień kerneli na iterację CG | każda iteracja CG | GPU aktywne tylko ok. 8% okna pomiaru | liczniki zmierzone; interpretacja to hipoteza |
| `backends/fem/gpu/cuda/relaxation/pgbb.cpp:263` (wołane z `:577`) ✔ | PGBB liczy pole bieżącego stanu od nowa, choć to samo m policzono jako przyjętą próbę | każda iteracja relaksacji | 1 zbędny solve z minimum 2 | kod: wysoka |
| `pgbb.cpp:263`, `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp:649,914` | każdy solve w relaksacji startuje od zera | każda próba | 66 iteracji w ostatnim solve wobec średnio 36 w dynamice | kod: wysoka |
| `backends/fem/gpu/cuda/integrators/rk/rk_attempt_loop.cu:247` ✔ | po odrzuceniu kroku FSAL unieważniony mimo przywróconego k0 | każde odrzucenie | +1 solve | kod: wysoka |
| `crates/fullmag-runner/src/native_fem.rs:4699-4712` ✔ | średnia m per obiekt: pobranie całego m (3 × 209 192 B) i pętla na hoście | każdy krok, jeśli plan ma więcej niż jeden obiekt | ok. 0,1–0,5 ms | kod: wysoka; aktywność w SP4 niepotwierdzona |
| `backends/fem/cpu/mfem/runtime/backend_step.cpp:220` | energie i metryki liczone co krok niezależnie od kadencji wyjść | każdy krok | ok. 25 uruchomień kerneli | kod: wysoka |
| `backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp:432-490` | głęboka kopia nieaktualnych luster hosta | każdy krok | kilka MB memcpy | kod: wysoka |
| 21 kopii D2D na krok DP54 (`rk_step_transaction_device.cu:228-229`, `rk_attempt_setup.cu:68,151`, `rk_final_refresh.cu:84`) | kopie zamiast zamiany wskaźników | każdy krok | 0,1–0,2 ms | kod: wysoka |

Źródło transferów 209 192 B: w ścisłej ścieżce Poissona nie ma żadnego transferu wektora, tylko
skalary po 8 B. Te transfery pochodzą z pobrań pól składowa po składowej
(`backends/fem/cpu/mfem/runtime/state_io.cpp:308,421`, pula Zarr w `backends/fem/src/api.cpp:835-864`).

Konfiguracja AMG (z kodu i provenance): BoomerAMG, relax 18, coarsening 8 (PMIS), interpolacja 6,
1 poziom agresywny, `coarse_relax_type=18`; macierz i hierarchia budowane raz, bez `SetOperator`
ani `Setup` w pętli gorącej. Nieustawiane jawnie: `MaxCoarseSize`, `KeepTranspose`, `RAP2`.

### FEM CPU

| Miejsce | Mechanizm | Koszt | Pewność |
|---|---|---|---|
| `crates/fullmag-api/src/accepted_study_supervisor.rs:1920-1951` | brak `OMP_WAIT_POLICY`, bindingu i rezerwy CPU dla wątków Rust | 2→6 wątków bez zysku, 30 wątków wolniej (335,6 s wobec ok. 66 s) | pomiar niskiej jakości; przyczyna to hipoteza |
| `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp:143`, `relaxation_math.cpp:1102` | ta sama podwójna ewaluacja i zerowy start co na GPU | +1 solve na iterację | kod: średnia |
| `backends/fem/cpu/mfem/runtime/cpu_threads.cpp:108-110` | limit auto 16 wątków przy zmierzonym optimum ≤6 | — | średnia |
| `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp:500` | licznik iteracji obejmuje tylko ostatni solve kroku | brak sumy iteracji | wysoka |

Do wyjaśnienia: w CMake backendu nie widać `-fopenmp`, więc własne `#pragma omp` Fullmaga mogą być
wykompilowane (sprawdzenie: `nm -D libfullmag_fem.so | grep GOMP`). W trzech starych buildach bieg
z przydziałem 1 CPU miał 6 efektywnych wątków — to kandydat na pierwotne „bardzo wolno”.

### FDM

| Miejsce | Mechanizm | Koszt | Pewność |
|---|---|---|---|
| `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs:~649,~678` | CPU: energia próby i pole po akceptacji liczą ten sam splot dwa razy | 12 FFT zamiast 6 na iterację | wysoka |
| `crates/fullmag-engine` `r2c.rs`, `fft.rs:493,544` | CPU: Rayon bez progu ziarnistości przy 4096 komórkach | więcej wątków może spowalniać | hipoteza |
| `crates/fullmag-fdm-demag/src/newell.rs:601-603` | CPU: padding w z do 2 przy `nz=1` | 2× więcej punktów FFT | wysoka |
| `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer_bb_resident.rs:288-420` | GPU: 3 FFI, 2 odczyty i 2 synchronizacje na iterację | narzut sterowania | wysoka |
| `backends/fdm/api/c_api.cpp:3507` | GPU: wymuszony kernel DMI mimo braku DMI | 1 zbędny kernel na ewaluację | wysoka |
| `crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs:355-402` | skrypt bez `FDMDemag` trafia na BB sterowany z hosta z transferem pól na każdą próbę | ok. 98 KB w każdą stronę na próbę | wysoka |
| `crates/fullmag-runner/src/artifact_pipeline.rs:43,813` | zapis w osobnym wątku, kolejka o pojemności 4; pełna kolejka blokuje solver | zależny od magazynu | wysoka |

## C. Weryfikacja wcześniejszych poprawek

| Poprawka | Werdykt | Uzasadnienie |
|---|---|---|
| AMG coarse 9 → 18 | częściowa | obieg przez host usunięty (1712 par transferów 24 B → 0, zmierzone); czas solvera w jedynej parze +7,8%, bramka zgodności harmonogramu dt nie przeszła |
| pakowanie pól | częściowa | obejmuje tylko `download_gpu_snapshot_fields`; `copy_field`, synchronizacja m i pula Zarr nadal idą trzema transferami |
| cache obserwacji | działa wąsko, zysk niewykazany | buforuje tylko `H_ex` i `H_ext` w obrębie jednego przechwycenia; kopiowanie −39%, solver +4%, n=1 |
| niezależny residual | działa jako bramka poprawności | niesie ukryty koszt: mnożnik 0,1 tolerancji; stara para porównawcza pochodzi sprzed tej zmiany |
| routing FDM GPU BB | działa (z kodu) | brak fallbacku CPU, dwie twarde bramki |
| provenance FDM GPU | potwierdzona w artefaktach | 39/39 chunków bajtowo identycznych, provenance w 7 plikach Zarr; nowe ryzyko: 10 s limit oczekiwania na zapis może zakończyć udany bieg błędem na wolnym magazynie |

Niezgodności z opisem zadania:

- Plik `/tmp/sp4-fem-gpu-r2-relax-result.json` nie istnieje. Zachowany wynik launchera
  (`sp4-diagnostics/sp4-master088-fem-gpu-relax-result-bd2cb3181fc69efd.json`) ma `exit_code=75` i
  `activation_outcome_unknown`, choć manifest biegu mówi `completed`.
- Błąd CUDA 719 wystąpił w biegu docelowym 1 ns (krok 897, t ≈ 44,14 ps), nie w próbie 60 ps, która
  się ukończyła (1217 kroków, 1000,3 s). Przyczyna pozostaje nieustalona; w tym samym czasie host
  zalogował ponad 11 tys. zdarzeń sterownika `nvlddmkm`.

### Porównanie relaksacji

| | FEM GPU R2 | FDM CPU | FDM GPU nativecuda | MuMax3 |
|---|---|---|---|---|
| Kroki | 1567 (+2 odrzucone) | 271 | 255 | 1028 |
| E_ex [J] | 8,2262e-20 | 8,9251e-20 | 8,9250e-20 | 8,9236e-20 |
| E_demag [J] | 5,40839e-19 | 5,40520e-19 | 5,40521e-19 | 5,40366e-19 |
| E_total [J] | 6,23102e-19 | 6,29771e-19 | 6,29771e-19 | 6,29602e-19 |
| ⟨mx⟩ | 0,969261 | 0,966959 | 0,966960 | 0,966962 |
| ⟨my⟩ | 0,120943 | 0,125294 | 0,125290 | 0,125292 |
| Maks. moment [T] | 9,0557e-7 | 9,8704e-7 | 6,2231e-7 | 8,515e-7 |
| Czas ścienny [s] | 756,3 | 29,07 | 1,45 | 2,38 |

FDM CPU i GPU zgadzają się z MuMax3 do 0,03% energii całkowitej. FEM GPU R2 odbiega w energii
wymiany o −7,8% i w ⟨my⟩ o −3,5%; bez studium zbieżności siatki nie da się tego przypisać samej
dyskretyzacji. Powód zatrzymania minimalizatora nie jest zapisany w żadnym Zarr. Konwersja
T = μ0·A/m jest spójna we wszystkich czterech zapisach.

## D. Ranking optymalizacji

| # | Zmiana | Spodziewany zysk | Ryzyko | Koszt |
|---|---|---|---|---|
| 1 | PGBB FEM (GPU i CPU): użyć pól przyjętej próby zamiast ponownej ewaluacji | do −50% solve w relaksacji | niskie; potrzebny znacznik ważności (m + rtol) | mały |
| 2 | Lepszy punkt startowy PCG między etapami RK (ekstrapolacja potencjałów) | średni do dużego na 97% kosztu dynamiki | niskie; tolerancja i certyfikat bez zmian | średni |
| 3 | Usunąć stały mnożnik 0,1; dociskać tolerancję tylko po nieudanym certyfikacie | średni | wyniki przestają być bitowo zgodne; wymaga noty fizycznej | mały |
| 4 | Środowisko wątków FEM CPU: wait policy, binding, rezerwa CPU, niższy limit auto | średni do dużego dla N≥6 | niskie | mały |
| 5 | FDM CPU: jedna ewaluacja pola na próbę BB | blisko 2× na iterację | kolejność sumowania energii musi zostać ta sama | mały |
| 6 | Nie unieważniać FSAL po odrzuceniu; przywracać potencjał stanu przyjętego | −1 solve na odrzucenie | niskie | mały |
| 7 | Średnia m per obiekt i metryki na urządzeniu, tylko gdy należne | mały do średniego | ostatnie bity sum | średni |
| 8 | FDM GPU: jedno wywołanie natywne na iterację BB, bez kernela DMI | mały w liczbach bezwzględnych (bieg trwa 1,45 s) | średnie | średni |
| 9 | Warm start Poissona w relaksacji | duży | narusza chroniony kontrakt „fresh-zero demag” z noty 0532 — to zmiana kompromisu dokładność–koszt | — |

Strojenie hierarchii AMG i przejście na kryterium euklidesowe w PCG też zmieniają politykę
numeryczną; należą do tej samej kategorii co pozycja 9.

## E. Etapy wdrożenia

1. **Telemetria najpierw.** Suma iteracji CG i czasu na każdy solve, liczba solve na iterację
   relaksacji, powód zatrzymania w Zarr. Kryterium: wyniki bitowo niezmienione.
2. **PGBB bez podwójnej ewaluacji** (GPU `pgbb.cpp:263`, CPU `projected_gradient_bb.cpp:143`).
   Kryterium: ta sama liczba iteracji, ten sam moment i energie, licznik solve na iterację 2→1.
   Benchmark: relaksacja R2 z pełnym Zarr.
3. **FDM CPU: jedna ewaluacja na próbę.** Kryterium: identyczna trajektoria energii i m końcowe;
   liczniki FFT spadają o połowę.
4. **Wątki FEM CPU.** Jeden build, N = 1/2/4/6/8/12/16/30, mediana i p95 na krok, `cpu.stat`
   kontenera, macierz {wait policy} × {binding}.
5. **FSAL po odrzuceniu i punkt startowy PCG w RK.** Kryterium: histogram iteracji na etap, energie
   w granicach tolerancji solvera, identyczna liczba kroków przyjętych i odrzuconych.
6. **Redukcje na urządzeniu i jedna ścieżka pobrań pól.** Kryterium: tabela zgodna do ok. 1e-15,
   bajty D2H na krok spadają do zera poza wyjściami.

Wspólny protokół: ten sam build, siatka, m0, tolerancje, precyzja, GPU i budżet CPU; co najmniej
5 powtórzeń naprzemiennie (ABAB); bieg ≥1 ps z odrzuceniem rozgrzewki; osobno inicjalizacja,
pierwszy krok, stan ustalony i publikacja końcowa; CUPTI osobno włączone i wyłączone (narzut
7–16%); pełny zapis Zarr. Iteracji relaksacji BB nie porównuje się z krokami dynamiki.

## F. Co zostaje na CPU w FEM GPU

Na CPU faktycznie pozostają:

- sterowanie pętlą PCG w HYPRE i test zbieżności (2 skalary z urządzenia na iterację),
- decyzja regulatora kroku RK (jeden pakiet na próbę),
- decyzje Armijo i długość kroku BB,
- średnia m per obiekt,
- dziennik transakcji z kopiami luster hosta,
- jednorazowa asemblacja operatorów i eliminacja warunków brzegowych.

Magnetyzacja, pola, wektory etapów, CSR wymiany, macierz Poissona i wektory PCG są na urządzeniu;
w ścieżce RHS nie ma `HostRead` ani `cudaDeviceSynchronize`. Czy fragmenty setupu AMG idą przez
host, pozostaje nieustalone.

Bezpiecznie można przenieść na urządzenie średnią m per obiekt i metryki oraz usunąć dziennik
luster. Decyzje sterujące RK i BB mogą zostać na hoście, bo to pojedyncze skalary. Przeniesienie
reszty na GPU nie rozwiąże problemu: wąskim gardłem jest liczba iteracji i drobnych kerneli
w Poissonie, a nie przepustowość GPU.

## G. Zmierzone, szacunki, hipotezy

**Zmierzone (n=1 lub niska jakość):**

- Poisson to 97,2% czasu solvera FEM GPU; kopiowanie pól 6,1%.
- Solver to 1,9% czasu całego zarządzanego wywołania próby 50 fs (4,4 s z 236 s).
- Redukcje transferów po coarse-18, pakowaniu i cache.
- Czasy relaksacji: FEM GPU 756 s, FDM CPU 29 s, FDM GPU 1,45 s, MuMax3 2,4 s.
- FEM CPU: 30 wątków wolniej niż 6.
- Sześć biegów bez CUPTI tego samego scenariusza daje 3,84–4,38 s (rozstęp 14%).
- Zmierzonego przyspieszenia end-to-end nie ma dla żadnej poprawki.

**Wyliczone:** 99 ms na solve, 36 iteracji CG na solve, ok. 113 uruchomień kerneli na iterację CG,
0,48 s na iterację relaksacji FEM GPU.

**Hipotezy:**

- FEM GPU jest ograniczony latencją uruchomień i synchronizacji.
- Aktywne oczekiwanie wątków OpenMP w HYPRE tłumaczy brak skalowania CPU.
- Odchyłka energii wymiany FEM wynika z dyskretyzacji.
- Wszystkie zyski z tabeli D są szacunkami.

## Brakujące pomiary

1. Powtórzenia (≥5) na wariant, naprzemiennie, na tym samym buildzie, z zapisanym obciążeniem hosta.
2. Bieg dłuższy niż 7 kroków z odrzuceniem rozgrzewki.
3. Liczniki faz na solve: setup AMG, PCG, kontrola residuum, RHS, recovery, wymiana, zapis Zarr.
4. Suma iteracji CG po wszystkich solve; dla relaksacji także liczba solve na iterację.
5. Ślad CUPTI ze znacznikami faz do przypisania transferów 8 B i 209 192 B do miejsc wywołań.
6. Rozbicie czasu całego wywołania (ok. 236 s): aktywacja, kolejka, setup, zapis.
7. Relaksacja FEM CPU R2 oraz profil fazowy relaksacji FEM GPU.
8. Studium zbieżności siatki FEM dla energii wymiany.
9. Krzywa wątków FEM CPU na jednym buildzie z czasem na krok.
10. Powtórzenie biegu 1 ns FEM GPU z telemetrią pamięci i logami sterownika do chwili błędu.
