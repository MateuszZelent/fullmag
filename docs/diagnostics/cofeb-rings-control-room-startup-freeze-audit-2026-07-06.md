# CoFeB Rings control-room startup freeze audit, 2026-07-06

## Zakres

Audyt dotyczy zgłoszonego zawieszania przeglądarki i wysokiego zużycia CPU/RAM przy starcie symulacji z:

- `examples/permalloy_layer_cofeb_rings_relax_300nm.py`
- frontend `apps/control-room`
- FEM GPU runtime przez zarządzany runtime Fullmag

Nie naprawiałem w tym przebiegu kodu produkcyjnego. Dodałem tylko ten raport. Checkout był już dirty przed audytem; wnioski poniżej opierają się na aktualnym stanie plików i artefaktach runtime z 2026-07-06.

Uzupełnienie po ponownej analizie: naprawa wydajności viewportu nie może domyślnie psuć jakości wizualizacji. Aktywne warstwy, gęstość glyphów, field-color, topologia i airbox overlays mają zachować obecną jakość. Sformułowania o `coarse`, `decimated`, odroczeniu albo ograniczaniu detailu należy traktować wyłącznie jako jawny loading/fallback po pomiarze, nie jako domyślną strategię naprawy. Szczegółowa, źródłowa matryca kod -> problem -> naprawa znajduje się w `docs/diagnostics/cofeb-rings-control-room-startup-freeze-remediation-plan-2026-07-06.md`.

## Artefakty

| Artefakt | Znaczenie |
|---|---|
| `.fullmag/reports/cofeb-rings-relax-diagnostics/fullmag-interactive.log` | Nieudany przebieg standardowego `just run-cofeb-rings-relax-diagnostics`; pokazuje konflikt drugiego Next dev servera i skażenie globalnego API. |
| `.fullmag/reports/cofeb-rings-relax-diagnostics/isolated-8192/fullmag-interactive.log` | Główny runtime log z izolowanym `FULLMAG_API_PORT=8192`. |
| `.fullmag/reports/cofeb-rings-relax-diagnostics/isolated-8192/latest-status.json` | Status runtime po ok. 126 s: solver `running`, ale nadal `total_steps=0`. |
| `apps/control-room/.fullmag/reports/cofeb-rings-relax-diagnostics/isolated-8192/browser/2026-07-06T16-29-35-913Z-boot/` | Boot recorder dla izolowanego API. |
| `apps/control-room/.fullmag/reports/cofeb-rings-relax-diagnostics/isolated-8192/browser/2026-07-06T16-31-40-944Z-viewport-3d/` | Częściowy viewport recorder; zawiera zrzut startu i pierwszy zrzut viewportu, ale recorder padł na końcowym zrzucie ekranu. |
| `apps/control-room/.fullmag/reports/cofeb-rings-relax-diagnostics/existing/2026-07-06T16-25-37-957Z-boot/` | Boot recorder po nieudanym przebiegu shared API; użyte tylko jako pomocniczy dowód boot long tasków. |
| `.fullmag/reports/cofeb-rings-relax-diagnostics/step0-browser-8195/summary.json` | Właściwy profil cold-load przeglądarki uruchomiony dopiero po gotowym `topology_revision=4`, `field_revision=1`, `totalSteps=0`. |
| `.fullmag/reports/cofeb-rings-relax-diagnostics/step0-browser-8196-no-vectors/summary.json` | Kontrprofil tego samego progu gotowości z `disableViewport3DVectorLayers=true`. |
| Log wklejony w rozmowie: `Fullmag Diagnostic Suspect Report`, scenario/profile `boot` | Dodatkowy suspect report z 1497 rekordami, 36 warningami i 30 critical records; niezależnie potwierdza 42 s `frame-window` oraz 36.5 s ścieżkę `H_eff/samples/vector` -> `field-color`. |

Uwaga: artefakty browser recorder zapisują się pod `apps/control-room/.fullmag/...`, bo skrypt jest uruchamiany przez `pnpm --dir apps/control-room`.

## Uruchomienia i testy

| Komenda / scenariusz | Wynik |
|---|---|
| `just run-cofeb-rings-relax-diagnostics gpu auto 3192 viewport-3d` | Pierwsze uruchomienie w sandboxie zatrzymało się na Docker buildx przez brak zapisu do `~/.config/docker`; po eskalacji runtime wystartował, ale Next odmówił startu, bo istniejący dev server dla `apps/control-room` działał już na `:3100` z PID 19260. Recipe zakończyło się `control room did not become ready on :3192`. |
| Boot recorder na istniejącym `http://localhost:3100/workspace` | Zakończony, ale po skażeniu globalnego `:8081` martwą sesją. Dał 7 critical records, long task 660 ms, long animation frame 662 ms i JS heap snapshot 128.2 MB. |
| Izolowany runtime `FULLMAG_API_PORT=8192`, frontend reuse `:3100`, recorder z `CONTROL_ROOM_API_BASE_URL=http://localhost:8192` | Dał główne dowody: Gmsh 40 wątków, 833 480 tetrahedrów, późny pierwszy field revision, solver nadal na kroku 0 po ok. 126 s. |
| `pnpm --dir apps/control-room audit:idle-performance` | Passed. Brak prostego always-on idle render loop według obecnego statycznego audytu. |
| `pnpm --dir apps/control-room audit:compute-performance` | Passed. Obecny statyczny audyt compute nie łapie regresji. |
| `pnpm --dir apps/control-room audit:viewport-3d-memory-churn` | W sandboxie Playwright padł na `sandbox_host_linux.cc ... Operation not permitted`; po eskalacji passed: 24 przełączenia, heap 60.9 MB -> 61.9 MB, cache 2.0 MB -> 2.0 MB, geometrie 5 -> 5, `fieldRequests=0`. |
| Tymczasowy profiler `/tmp/fullmag-step0-browser-profiler.mjs`, runtime `:8195` | Profil z wektorami: start po `topology_revision=4`, `field_revision=1`, `totalSteps=0`; ujawnił 47.7 s long task i 42.8 s wall-time w `buildVectorGlyphInstances`. |
| Ten sam profiler, runtime `:8196`, `FULLMAG_STEP0_BROWSER_PROFILE_DISABLE_VECTORS=1` | Kontrprofil bez wektorów: brak `buildVectorGlyphInstances`, brak timeoutu screenshot/gesture, max long task spadł do 3.85 s. |
| Wklejony `Fullmag Diagnostic Suspect Report`, scenario/profile `boot` | 1497 rekordów, 36 warningów, 30 critical, `Dropped=0`; top suspect to `fullmag.viewport3d.frame-window` 42012.1 ms, z jednoczesnym `field-color` worker/queue ok. 36.5 s i requestem `GET /v2/sessions/current/data/fields/H_eff/samples/vector` 36523 ms. |

## Oś czasu izolowanego przebiegu

| Etap | Dowód | Wniosek |
|---|---|---|
| Start runtime | `fullmag materializing script`, API na `:8192`, frontend reuse `:3100` | Izolacja API była konieczna, bo standardowy recipe używa globalnego `:8081`. |
| Meshing | `Gmsh: multithreading enabled (40 threads)` | `cpu_threads=auto` przekłada się na Gmsh 40 wątków. |
| Meshing 3D | `Done meshing 3D (Wall 15.6596s, CPU 493.473s)` | To bardzo intensywny burst CPU. 493 s CPU w 15.7 s wall oznacza agresywną równoległość i realne zagłodzenie browser/API na tej samej maszynie. |
| Rozmiar siatki | `833480 tetrahedra, 133115 nodes, 89274 boundary faces` | Pierwszy viewport dostaje bardzo duży FEM topology payload. |
| Podział domeny | airbox `701982 tetrahedra`, permalloy `130870 tetrahedra`, CoFeB `628 tetrahedra` | Większość kosztu pochodzi z airbox/shared-domain, nie z samego małego obiektu CoFeB. |
| Post-mesh sync | `live snapshot sync cycle took 4453ms`, `4167ms`, `2529ms`, `2929ms` | Po meshingu pętla publikacji live snapshotów sama trwa sekundy. |
| Rozwiązanie silnika | `resolved_engine_id=fem_native_gpu fallback=None` | Runtime faktycznie wybrał FEM GPU; problem nie wynika z fallbacku CPU solvera. |
| Pierwsze ingest | `live step ingest step=0 legacy_mag_len=399345 preview_field=false ... cached_preview_fields=0` | Dane magnetyzacji istnieją jako legacy vector, ale brak gotowego `preview_field` i brak cached preview fields dla UI. |
| Status po ok. 126 s | `solver.state=running`, `total_steps=0`, `field_revision=1`, `topology_revision=4`, `cell_count=833480` | Po ponad dwóch minutach frontend widzi pierwszy field revision, ale symulacja nadal nie zrobiła kroku solvera. Brak odświeżania tekstury w tym oknie nie jest zaskoczeniem: nie ma jeszcze ewoluującej tekstury. |
| Viewport recorder | Screenshot `010-first-viewport.png` pokazuje canvas, model i telemetry step 0; następny screenshot przekroczył timeout 30 s | UI potrafi dojść do pierwszego frame, ale później page/screenshot może zablokować się na tyle, że recorder traci końcowy artefakt. |

## Najważniejsze wnioski

### 0. Doprecyzowanie: przy gotowym mesh i pierwszym field revision freeze powoduje pipeline vector glyph/field-color

Po uwadze, że właściwy pomiar ma zaczynać się od kroku zerowego, gdy mesh jest już gotowy i dane są wysyłane do przeglądarki, wykonałem dodatkowy profil z odciętym kosztem Gmsh/materializacji. Profiler czekał na:

- `topology_revision > 0`,
- `field_revision > 0`,
- `cell_count > 0`,
- `totalSteps = 0`.

Profil z warstwami wektorów (`:8195`) wystartował przy:

```json
{"cellCount":832944,"fieldRevision":1,"topologyRevision":4,"totalSteps":0}
```

Najważniejsze liczby z tego profilu:

| Metryka | Wynik |
|---|---:|
| `apiRequestCount` | 79 |
| `domContentLoadedMs` | 87 ms |
| `canvasVisibleMs` | 4103 ms |
| `canvasPaintedMs` | 5437 ms |
| `longTaskCount` | 50 |
| `totalLongTaskMs` | 68 660 ms |
| `maxLongTaskMs` | 47 673 ms |
| `eventLoopMaxDelayMs` | 49 961 ms |
| `JSHeapUsedSize` delta | +419.9 MB |
| `fullmag.viewport3d.buildVectorGlyphInstances` | 18 razy, max 14 990.8 ms, suma 42 777.6 ms |
| `fullmag.viewport3d.uploadVectorGlyphColors` | 6 razy, max 1465.9 ms, suma 3517.2 ms |
| `fullmag.api.requestBinaryResource.field-vector.decode` | 1 raz, 74.7 ms |

To rozdziela problem: transfer pola jest widoczny, ale nie jest główną przyczyną wielokrotnego zamrażania przeglądarki. Najcięższy field-vector request trwał ok. 3.8 s, a binary decode `m` trwał tylko ok. 75 ms. Freeze rzędu kilkudziesięciu sekund pojawia się dopiero w viewportowym pipeline po stronie budowy/adopcji/uploadu pochodnych danych dla glyphów i kolorów.

Dowody bezpośrednie z tego samego profilu:

- `locator.boundingBox()` na widocznym `<canvas width="731" height="483" data-engine="three.js r183">` przekroczył timeout 5000 ms.
- `page.screenshot()` przekroczył timeout 5000 ms.
- PerformanceObserver zarejestrował long task 47 673 ms.
- HUD viewportu po settle pokazał `surface:stale-visible`, `Next field sync waiting`, `pipeline:4[field-color{worker=48423ms}; region-overlay{worker=2892ms}; topology-index{worker=6222ms}; ...]`, `cache:26MB`, `frames:74`.
- WebGL zgłosił ostrzeżenia `GPU stall due to ReadPixels`.

Kontrprofil bez warstw wektorów (`:8196`, `disableViewport3DVectorLayers=true`) wystartował przy porównywalnym progu:

```json
{"cellCount":834048,"fieldRevision":1,"topologyRevision":4,"totalSteps":0}
```

| Metryka | Z wektorami | Bez wektorów |
|---|---:|---:|
| `maxLongTaskMs` | 47 673 ms | 3854 ms |
| `totalLongTaskMs` | 68 660 ms | 13 351 ms |
| `eventLoopMaxDelayMs` | 49 961 ms | 3884 ms |
| `JSHeapUsedSize` delta | +419.9 MB | +101.7 MB |
| `buildVectorGlyphInstances` total | 42 777.6 ms | 0 ms |
| `uploadVectorGlyphColors` total | 3517.2 ms | 0 ms |
| screenshot / camera gesture | oba timeoutują | oba przechodzą |

#### Dodatkowy boot suspect report dostarczony po profilu step0

Po profilu step0 został dostarczony dodatkowy `Fullmag Diagnostic Suspect Report` dla scenariusza `boot`. Nie jest to osobny plik w repo, ale log jest spójny z profilem przeglądarki i zawęża najgorszą ścieżkę do `H_eff`/field-color/vector-glyph:

| Metryka z suspect reportu | Wynik |
|---|---:|
| `Records` | 1497 |
| `Warnings` | 36 |
| `Critical` | 30 |
| `Dropped` | 0 |
| `browser.long-animation-frame` | 248 ms |
| `browser.longtask` | 247 ms |
| `fullmag.viewport3d.frame-window` max | 42012.1 ms |
| queue bottleneck: `field-color` | 36596.9 ms |
| queue bottleneck: `vector-glyph` | 3882.8 ms |
| worker bottleneck: `field-color` | 36535.2 ms |
| worker bottleneck: `vector-glyph` | 12349.1 ms / 8422.3 ms |
| worker bottleneck: `topology-index` | 7333.7 ms / 5325.1 ms |
| slow request: `GET /v2/sessions/current/data/fields/H_eff/samples/vector` | 36523 ms |
| slow request: `GET /v2/sessions/current/analysis/frequency-domain/response/progress.v1` | 1599 ms |
| slow request: `GET /v2/sessions/current/meshing/meshes/shared-domain/manifest` | 998 ms |
| slow request: `GET /v2/sessions/current/model/scene` | 843 ms |

Ten log potwierdza, że freeze nie jest zwykłym kosztem bootowania Reacta. Main-thread long animation frame ma 248 ms, a najgorsze `frame-window` ma 42 s. To znaczy, że przeglądarka przez kilkadziesiąt sekund czeka na domknięcie viewportowego okna pracy, głównie przez asynchroniczną ścieżkę worker/resource: `H_eff/samples/vector` ok. 36.5 s, `field-color` worker/queue ok. 36.5 s oraz ciężkie joby `vector-glyph` i `topology-index`.

Najważniejsze doprecyzowanie względem profilu `:8195`: najgorszy target nie jest tylko samym `m` glyph buildem. Suspect report pokazuje również bardzo kosztowny demand na `H_eff` vector samples, najpewniej powiązany z airbox/field-color path. Ten demand nie powinien uruchamiać się automatycznie na pierwszym widocznym frame, jeżeli użytkownik nie poprosił jawnie o wektorowe `H_eff`.

Drugorzędny, ale realny sygnał: podczas zwykłego bootu pojawiają się requesty `analysis/frequency-domain/response/*`. Dla tego scenariusza nie są częścią minimalnego pierwszego viewportu CoFeB rings. Trzeba je potraktować jako osobny leak aktywności modułu Results/frequency-domain albo zbyt szeroki hook zasobu podczas startu workspace.

Razem z kontrprofilem bez wektorów jest to najściślejsze wskazanie przyczyny zacinania przeglądarki po gotowym mesh: domyślne ładowanie viewportu uruchamia zbyt ciężki pipeline vector glyph/field-color dla dużego FEM payloadu, w tym kosztowny `H_eff` vector demand. Same resource fetches i binary decode nadal kosztują sekundy, ale po wyłączeniu vector layers przeglądarka przestaje wpadać w kilkudziesięciosekundowy freeze.

Najbardziej podejrzane miejsca kodu:

- `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx` - budowa glyphów i upload kolorów/macierzowych atrybutów instancji,
- `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.ts` - worker pool dla glyphów, `latestWins`, concurrency i fallback,
- `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphGeometry.ts` - pętle budujące transformy i kolory dla segmentów,
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DChunkedScalarColors.ts` i `field-colors/viewport3dFieldColorBuildWorker.ts` - długi `field-color` worker raportowany przez HUD,
- `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts` / `viewport3DDerivedWorkPlan.ts` - plan demandów `surface|vector-glyph`, który przy starcie odpala kilka targetów naraz.

Najkrótsza technicznie poprawna hipoteza root-cause:

> Po pierwszym `field_revision` viewport od razu próbuje zbudować powierzchnie i glyphy dla wielu targetów (`surface|vector-glyph`, pełne i per-part bufory, airbox vector demand). Worker pipeline liczy duże derived buffers, a adopcja/upload wyników do Three.js/instanced attributes blokuje main thread. Brakuje stopniowania: najpierw lekki pierwszy frame, potem ograniczone wektory, potem pełniejsze glyphy tylko na żądanie.

Wniosek dla naprawy zmienia się względem ogólnego raportu: P0 dla browser freeze to nie "przyspieszyć meshing", tylko **usunąć przypadkowy/duplikowany demand i zoptymalizować vector glyph/field-color pipeline bez obniżania aktywnej jakości wizualizacji**.

Minimalne poprawki do przetestowania w kolejnym kroku:

1. Rozdzielić demand surface-color od vector-glyph, żeby aktywny kolor i aktywne glyphy zachowały jakość, ale glyph demand nie był przypadkowo poszerzany do pełnego, niepróbkowanego payloadu.
2. Dodać globalny budżet glyphów równy skonfigurowanej gęstości wizualizacji raz dla całej sceny, zamiast powielania tego budżetu per target. Redukcja gęstości jest osobnym fallbackiem, nie P0.
3. Nie ładować ukrytych albo nieaktywnych airbox/`H_eff` vector glyphs na boot. Jeżeli `H_eff`/airbox vectors są aktywną wizualizacją, muszą zachować jakość i dostać wyższy priorytet w kolejce pracy.
4. W `VectorFieldLayer.tsx` i upload managerze przenieść koszt per-glyph matrix/adopt/upload poza długi main-thread commit: shader-oriented instancing albo worker-precomputed matrix buffers, z zachowaniem obecnego wyglądu glyphów.
5. W build schedulerze coalescować i anulować stare jobs po field revision; `latestWins` musi obejmować realny target set, nie zostawiać kilku ciężkich jobów do adopcji.
6. Ograniczyć refetch/duplikację manifestów shared-domain przez aktywne bramki resource hooków; profil pokazał kilka requestów po ~2.8 MB manifestu, co dokłada presję, choć nie jest głównym 47 s freeze.
7. Zablokować automatyczne boot-time fetch/build dla nieaktywnego `H_eff` vector samples i `analysis/frequency-domain/response/*`, dopóki aktywny moduł, aktywna stage albo jawna akcja użytkownika ich nie potrzebuje.

### 1. Pierwsze minuty blokuje materializacja, nie sama animacja tekstury

Najsilniejszy dowód to izolowany status po ok. 126 s:

- `solver.state = "running"`
- `metrics.total_steps = 0`
- `resources.field_revision = 1`
- `resources.topology_revision = 4`
- `domain.cell_count = 833480`

To oznacza, że w czasie, w którym użytkownik oczekuje zmiany tekstury magnetyzacji, runtime nadal nie przeszedł do realnych kroków symulacji. UI nie ma czego animować poza stanem początkowym.

W logu ingest widać dodatkowo:

```text
live step ingest step=0 legacy_mag_len=399345 preview_field=false preview_quantity=- preview_len=0 cached_preview_fields=0 cached_m_preview_len=0 scalar_row_due=false finished=false
```

`legacy_mag_len=399345` odpowiada `133115 nodes * 3` komponenty. To jest pełny wektor magnetyzacji, ale nie jest jeszcze opublikowany jako gotowy preview/cache field dla aktualnej ścieżki viewportu. Samo istnienie danych w callbacku solvera nie znaczy, że frontend dostał tani, renderowalny zasób.

### 2. Gmsh używa za dużo CPU dla interaktywnego startu

`FULLMAG_CPU_THREADS=auto` w recipe daje `FULLMAG_GMSH_THREADS` pośrednio przez `packages/fullmag-py/src/fullmag/meshing/_gmsh_infra.py`: najpierw sprawdzane jest `FULLMAG_GMSH_THREADS`, potem `FULLMAG_CPU_THREADS`, a na końcu `os.cpu_count()`.

W tym przebiegu Gmsh dostał 40 wątków:

```text
Gmsh: multithreading enabled (40 threads)
Gmsh: Done meshing 3D (Wall 15.6596s, CPU 493.473s)
```

To poprawia wall time meshingu, ale jest złe dla interaktywnego startu. Browser, Next dev server, API i runtime konkurują o CPU. Przy takim burstcie przeglądarka może sprawiać wrażenie martwej, nawet jeżeli solver backend formalnie robi postęp.

### 3. Live snapshot sync jest drugim dużym bottleneckiem po meshingu

Po zakończeniu mesh generation pętla publikacji live snapshotów miała cykle 2.5-4.5 s. Kod w `crates/fullmag-cli/src/live_workspace.rs` klonuje aktualny payload, dołącza diagnostykę i wywołuje `sync_current_live_delta(&session_id, &snapshot)` synchronicznie w pętli publishera. Przy payloadzie zawierającym dużą topologię, pola i metadane to staje się częścią krytycznej ścieżki startu.

To nie jest wyciek pamięci viewportu. `audit:viewport-3d-memory-churn` na cached quantity switching przeszedł z minimalnym wzrostem heapu i bez refetchy pól. Problem jest wcześniej: publikacja i pierwsza materializacja zasobów są za ciężkie.

### 4. Frontend ma osobny boot long task, ale to objaw pomocniczy

Izolowany boot recorder:

- 40 rekordów
- 5 critical
- long task 665 ms
- long animation frame 666.4 ms
- snapshot heapu 117.9 MB used / 120.6 MB total
- slowest navigation 1310.6 ms

Recorder na skażonej sesji pokazał podobny pattern:

- 7 critical
- long task 660 ms
- long animation frame 662 ms
- dodatkowy long animation frame 161.8 ms
- snapshot heapu 128.2 MB used / 131.6 MB total

To trzeba poprawić, ale te liczby nie tłumaczą samodzielnie kilku minut bez odświeżania magnetycznej tekstury. One dokładają odczuwalny freeze do już ciężkiego backend/materialization startupu.

### 5. Pierwszy viewport jest osiągalny, potem recorder potrafi zamarznąć

`010-first-viewport.png` z częściowego `viewport-3d` pokazuje:

- pełny shell Control Room,
- canvas 3D,
- explorer z mesh-ready/shared-domain nodes,
- telemetry `step=0`,
- `FEM GPU native MFEM/CUDA`,
- aktywną ilość `m`,
- badge `stale 0` dla realized size fields.

Następny screenshot w recorderze nie zakończył się:

```text
page.screenshot: Timeout 30000ms exceeded.
- taking page screenshot
- waiting for fonts to load...
```

To jest realny dowód zamrożenia lub bardzo długiego main-thread stall po pierwszym viewport frame. Niestety `record-diagnostics.mjs` robi końcowy screenshot przed `exportInPageArtifact`, więc przy takim freeze nie zapisuje `summary.json` ani `performance.ndjson` dla scenariusza viewportowego. Sam skrypt diagnostyczny pogarsza observability awarii.

### 6. Standardowy recipe diagnostyczny nie jest bezpieczny przy istniejącym dev serverze

`just run-cofeb-rings-relax-diagnostics` zakłada, że może wystartować osobny Next dev server na podanym porcie. Przy istniejącym `next dev` dla tego samego `apps/control-room` dostał:

```text
Another next dev server is already running.
- Local: http://localhost:3100
- PID: 19260
```

Gorsze jest to, że runtime zdążył wcześniej przepiąć globalne `:8081` na nową sesję, która potem została martwa w `materializing_script`. To skaża `/v2/sessions/current/status` i utrudnia powtarzalną diagnostykę bez ubijania cudzych procesów.

Recipe musi używać izolowanego `FULLMAG_API_PORT` albo wymuszać pełne przejęcie procesu frontendowego przed publikacją sesji.

### 7. Aktualny skrypt CoFeB nie odpowiada opisowi "rings" i ignoruje env max-step

Aktualny plik ma:

- `RING_OUTER_RADIUS = 50 * NM`
- `RING_INNER_RADIUS = 50 * NM`
- `RING_WIDTH = 0`
- `ring_geometry()` zwraca `fm.Box(size=(60 * NM, 50 * NM, 50 * NM), name="permalloy_layer")`
- cylindryczny inner ring jest zakomentowany
- bottom ring jest zakomentowany

To nie jest opisany w docstringu pionowy annulus. Dodatkowo recipe ustawia:

- `FULLMAG_COFEB_RINGS_MINIMIZE_MAX_STEPS=10`
- `FULLMAG_COFEB_RINGS_RELAX_MAX_STEPS=10`

ale stage definitions nadal używają literalnych:

- `max_steps=2000`
- `max_steps=100`

Zmienne `MINIMIZE_MAX_STEPS` i `RELAX_MAX_STEPS` są zdefiniowane, ale nieużywane. To nie jest główna przyczyna pierwszego freeze, bo po 126 s solver nadal jest na kroku 0, ale psuje powtarzalność diagnostyki i wydłuża ewentualny przebieg końcowy.

## Priorytetowe przyczyny

| Priorytet | Przyczyna | Warstwa | Dowód |
|---|---|---|---|
| P0 | Zbyt ciężka materializacja shared-domain mesh i pierwszych zasobów przed interaktywnym viewportem | Python meshing / runtime | 833 480 tets, 133 115 nodes, 493 s CPU Gmsh, topology/field dopiero po długim starcie |
| P0 | Synchroniczna publikacja dużych live snapshotów w krytycznej ścieżce | CLI live publisher / API | sync cycles 4453 ms, 4167 ms, 2529 ms, 2929 ms |
| P0 | Brak renderowalnego preview/cache field na pierwszym `step=0` ingest | Runner / CLI / field-store | `preview_field=false`, `cached_preview_fields=0`, `field_revision=1` dopiero przy `total_steps=0` |
| P1 | Gmsh dziedziczy `FULLMAG_CPU_THREADS=auto` i bierze 40 wątków | Python meshing config | `Gmsh: multithreading enabled (40 threads)` |
| P1 | Frontend boot ma 660 ms long task | Control Room | boot recorder critical records |
| P1 | Viewport recorder traci artefakt przy freeze, bo final screenshot jest przed exportem danych | Diagnostics | `page.screenshot` timeout, brak viewport summary |
| P2 | Recipe diagnostyczny nie izoluje API i nie współpracuje z istniejącym Next dev serverem | Justfile / launcher | konflikt PID 19260 i martwa sesja na `:8081` |
| P2 | Skrypt CoFeB jest niespójny z nazwą/opisem i nie używa env max-step | Example script | `RING_WIDTH=0`, `Box`, literalne `max_steps` |

## Rekomendowany plan naprawy

### P0: rozdzielić responsywność UI od blokującej materializacji, bez utraty jakości

Completed viewport nie może być niższej jakości niż obecny aktywny widok. Minimalny wariant:

1. Utrzymać poprzedni poprawny frame albo jawny loading/progress state, gdy exact active view jest przygotowywany.
2. Publikować exact scoped topology jako osobny zasób po mesh build, żeby frontend nie wyliczał pełnych indeksów na krytycznej ścieżce.
3. Publikować pierwsze renderowalne pole/cache field zgodne z aktywną wizualizacją; decymacja jest dopuszczalna tylko jako jawny fallback/loading, nie jako completed view.
4. W viewportcie nie uruchamiać nieaktywnych targetów i analiz podczas budowania aktywnej sceny, zamiast zastępować aktywną scenę tańszą wizualizacją.

To jest bardziej zgodne z resource-first/data-plane split niż próba "przyspieszenia Reacta" bez zmiany runtime.

### P0: wprowadzić backpressure i latest-only dla live snapshotów

Publisher nie powinien synchronicznie przepychać każdego dużego snapshotu, jeżeli poprzedni sync trwa sekundy. Potrzebne są:

- coalescing do najnowszej rewizji,
- pomijanie intermediate updates,
- oddzielenie cienkiego statusu od ciężkich payloadów,
- limity rozmiaru dla delta JSON,
- osobna ścieżka binary/data-plane dla pól i topologii,
- metryki `clone_wall_time`, `publish_wall_time`, `payload bytes`, `resource kind`.

W obecnym stanie jedna ciężka publikacja live może blokować następną rewizję i utrzymywać UI w stanie "loading/stale".

### P0: materializować preview fields wcześnie i jawnie

Dla FEM GPU pierwszy `StepUpdate` nie powinien trafiać do live state jako tylko `legacy_mag_len` bez renderowalnego preview/cache field, jeżeli UI ma pokazać magnetyzację. Minimum:

- dla `m` wygenerować cached preview field przy step 0,
- zapisać rewizję pola, która odpowiada aktywnej ilości `m`,
- nie uzależniać pierwszej tekstury od późniejszego `compute_fields`,
- dodać test runtime, że pierwszy FEM step 0 z node magnetization publikuje renderowalny `m` field.

### P1: ograniczyć Gmsh threads dla interactive diagnostics

Na interaktywnym starcie domyślne `auto=40` jest zbyt agresywne. Dla `run-cofeb-rings-relax-diagnostics` i podobnych recipe należy ustawić jawne:

```bash
FULLMAG_GMSH_THREADS=${FULLMAG_GMSH_THREADS:-4}
```

albo osobny limit dla WSL/dev UI. Dla finalnych headless benchmarków można zachować wysoką równoległość, ale UI diagnostics nie powinny zagłodzić browsera.

### P1: naprawić recorder, żeby zapisywał częściowy artefakt przy freeze

`record-diagnostics.mjs` powinien eksportować in-page artifact przed końcowym screenshotem albo w `catch` próbować:

1. `collectBrowserMetrics`,
2. `exportInPageArtifact`,
3. `writeArtifactDirectory`,
4. dopiero potem screenshot best-effort.

Obecnie najciekawszy przypadek awarii kończy się tylko screenshotami i stack trace.

### P1: zmniejszyć frontend boot long task

Long task 660-666 ms przy samym boot oznacza, że workspace shell nadal robi za dużo przed pierwszą interakcją. Następne kroki:

- lazy-load viewport heavy modules dopiero po resource readiness,
- odroczyć panele diagnostyczne i mniej ważne chrome,
- sprawdzić chunk `app/workspace/page.js` i main-app JS,
- nie budować dużych modeli UI na pierwszym renderze, gdy runtime jest jeszcze w `materializing_script`.

To nie rozwiąże P0, ale zmniejszy odczuwalne zawieszenie.

### P2: naprawić recipe diagnostyczny

`run-cofeb-rings-relax-diagnostics` powinien:

- używać izolowanego `FULLMAG_API_PORT`,
- przekazywać `CONTROL_ROOM_API_BASE_URL` do recorderów,
- nie mutować globalnego `:8081`, jeśli nie przejął frontendowej sesji,
- wykrywać istniejący Next dev server i albo go reuse'ować, albo kończyć zanim runtime opublikuje sesję,
- zapisywać artefakty poza `apps/control-room/.fullmag`, jeśli caller poda root z repo.

### P2: naprawić przykład CoFeB albo zmienić nazwę/scenariusz

Trzeba zdecydować, czy to nadal ma być "rings". Jeżeli tak:

- przywrócić annulus geometry,
- rozdzielić nazwy obiektów `permalloy_layer` i ring primitive,
- użyć `MINIMIZE_MAX_STEPS` i `RELAX_MAX_STEPS` w stage definitions,
- dopasować docstring do aktualnej geometrii.

Jeżeli obecny box jest celowym szybkim proxy, nazwa i opis powinny to mówić wprost.

## Co nie jest główną przyczyną według obecnych danych

- Nie ma dowodu na memory leak przy cached quantity switching w viewport 3D. Audyt memory churn przeszedł, heap wzrósł tylko o ok. 1 MB po 24 przełączeniach.
- Nie ma dowodu na stały idle render loop złapany przez obecny `audit:idle-performance`.
- Nie ma dowodu, że runtime spadł na CPU solver. Log mówi `resolved_engine_id=fem_native_gpu fallback=None`.
- Nie ma dowodu, że brak odświeżania magnetycznej tekstury w pierwszych minutach wynika głównie z shaderów albo WebGL uploadu. Dane pokazują, że solver jest jeszcze na `step=0`, a pierwsze renderowalne zasoby pojawiają się późno.

## Luki w dowodach

- Pełny viewport diagnostic nie zapisał `summary.json`, bo recorder zawiesił się na końcowym zrzucie ekranu. Mamy screenshot `010-first-viewport.png` i stack trace, ale nie mamy pełnego `performance.ndjson` z tej fazy.
- Izolowany runtime został zakończony po awarii recorderowej; ten audyt nie mierzy pełnego dojścia do końca stage 1/2 ani stage 2/2.
- Boot recorder na `existing/` jest częściowo skażony martwą sesją po nieudanym standardowym recipe, dlatego używam go tylko do potwierdzenia podobnych boot long tasków, nie jako głównego źródła runtime timeline.

## Decyzja techniczna

Najbardziej opłacalna kolejność prac:

1. Naprawić izolację diagnostyki i recorder partial-export, żeby następne pomiary były pełne.
2. Ograniczyć `FULLMAG_GMSH_THREADS` dla interactive diagnostics.
3. Dodać quality-preserving viewport work policy: aktywna wizualizacja zachowuje jakość, a nieaktywne targety/analizy nie blokują startu.
4. Przenieść duże pola/topologię z krytycznej pętli live snapshot JSON na latest-only resource/data-plane.
5. Wygenerować renderowalne `m` preview/cache field już dla pierwszego `step=0`, zgodne z aktywną wizualizacją.
6. Dopiero potem optymalizować React boot chunks i szczegóły viewport renderingu.

Bez punktów 1-5 samo poprawianie komponentów Reacta będzie maskowaniem problemu: przeglądarka nadal będzie czekać na ciężki backend/materialization pipeline i synchroniczną publikację dużych zasobów. Bez zasady jakości samo "odchudzenie" viewportu byłoby natomiast niepoprawnym rozwiązaniem produktu.
