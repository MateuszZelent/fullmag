# Audyt: odświeżanie telemetrii, wizualizacji 3D i wykresów w trakcie runu

- Data: 2026-11-19
- Rewizja kodu: `master` @ `c944b3186`
- Zakres: cały tor danych na żywo, od solvera do pikseli:
  - backend: worker, projektor, snapshot sesji, WebSocket, HTTP data plane (`crates/fullmag-api`, `crates/fullmag-session`);
  - warstwa transportu i zasobów frontendu (`apps/control-room/src/kernel/realtime`, `kernel/resources`, `kernel/api`);
  - viewport 3D, czyli bufory, atrybuty, shadery i `InstancedMesh` (`modules/viewport-3d`);
  - wykresy, mapa 2D i odczyty telemetrii (`modules/live-charts`, `modules/field-map`, `modules/footer`, `shared/analysis-charts`, `shared/domain/study`).
- Charakter: audyt **tylko z odczytu kodu**. Nic nie zostało zbudowane, uruchomione ani zmierzone (bez przeglądarki, bez profilowania). Żaden plik źródłowy nie został zmieniony.
- Kontynuacja: [`live-refresh-and-carrier-bugs-20261030.md`](live-refresh-and-carrier-bugs-20261030.md), sekcja A. Status jej pozycji jest w rozdziale 7.

Oznaczenia pewności:

- **[Z]**: sprawdzone przeze mnie bezpośrednio w kodzie.
- **[R]**: odczytane w kodzie przez agenta przeglądowego, nieskontrolowane przeze mnie.
- **[I]**: wniosek z kodu (kolejność klatek R3F względem efektów Reacta, rywalizacja o locki, odczuwalny efekt). Wymaga potwierdzenia w przeglądarce lub pomiarem.

Ścieżki frontendu są względne do `apps/control-room/src/`, backendu do `crates/fullmag-api/src/`, chyba że podano inaczej. Numery linii dotyczą `c944b3186`.

---

## 1. Najważniejsze wnioski

1. **Opóźnienie pola `m` w 3D wynosi do ~3 s i dominuje w nim celowe okno łączenia 2000 ms.**
   - Worker przechwytuje pole co 250 ms, a projektor API odpytuje co 500 ms.
   - Zdarzenie `fields.samples` wychodzi najwyżej raz na `LIVE_REALTIME_FIELD_SAMPLE_COALESCE_WINDOW_MS = 2000` (`crates/fullmag-session/src/communication_policy.rs:11`) **[Z]**. Flush ma wyłącznie krawędź końcową.
   - Około 7 z 8 przechwyconych klatek nikt nie ogląda, a każda kosztuje kopię GPU→host i zapis na dysk.
2. **Wspólna przyczyna mrugania nadal istnieje.** `markResourceLoading` w stanie `stale` nadpisuje `revision` rewizją oczekującą (`kernel/resources/resourceState.ts:19-33`) **[Z]**. Każdy konsument, który używa `resource.revision` jako tożsamości danych, odrzuca gotowy wynik dwa razy na jedno odświeżenie. Tak działa topologia FDM (A1) i klucze buildów kolorów/topologii FEM (A8). Pole `dataRevision` nadal nie istnieje.
3. **Wzorzec „klucz zasobu z `#revision=`” nadal występuje** w monitorach płaskich, przekrojach, metadanych planarnych i w awaryjnym kluczu membership FDM. Do tego dochodzi kursor w kluczu wykresów.
   - Każda inwalidacja tworzy nowy, pusty wpis, bo `getSnapshot` zwraca `data: null` dla nieznanego klucza (`ResourceRuntimeStore.ts:343-350`) **[Z]**.
   - Stary wpis jest kasowany razem z danymi po odpięciu słuchacza (`ResourceRuntimeStore.ts:862-880`) **[Z]**.
   - `useResource` nie ma retencji między kluczami (brak `keepPreviousData`).
4. **Viewport 3D ma poprawne podwójne buforowanie wewnątrz warstw, ale wiele „pustych klatek” na granicach.**
   - Poprawnie działają: staging i `onVisible` dla kolorów FEM, last-good geometrii FEM, stara klatka glifów do końca uploadu.
   - Puste klatki pojawiają się przy:
     - remontowaniu `InstancedMesh` przez `key={vector-shaft-${capacity}}` (`layers/VectorFieldLayer.tsx:1288`, `:1297`) **[Z]**;
     - nowym materiale FDM przy zmianie `opacity` (`layers/FdmCuboidLayer.tsx:1144-1180`) **[Z]**;
     - swapie geometrii FEM, który gubi kolory i wymusza rekompilację shadera **[R]**;
     - pending topologii FEM, który czyści geometrię (A7) **[R]**.
5. **Skala kolorów „oddycha” w każdej klatce, w 3D i w 2D.** Zakres auto jest liczony z każdej klatki osobno, bez histerezy i bez trybu „tylko rozszerzaj”. Na backendzie domyślny tryb to `AutoScaleMode::Slice`. W FEM zakres pochodzi z osobnego zasobu meta, który nie jest wiązany z rewizją payloadu, więc zakres z kroku N-1 może trafić na wartości z kroku N **[R/I]**.
6. **Wykres histerezy niszczy i tworzy instancję ECharts przy każdej aktualizacji na żywo.** Efekt z `echarts.init`/`dispose` zależy od `liveFieldValue`, `liveYValue`, `progress` i `points` (`shared/domain/study/HysteresisChart.tsx:1293`, `:1522-1524`) **[Z]**. To łamie doktrynę wykresów i prawie na pewno daje puste klatki.
7. **Wykresy live omijają własny limit odświeżania.**
   - Kursor jest częścią klucza zasobu (`kernel/resources/studyRuntimeResources.ts:2795-2806`) **[Z]**.
   - `refetchDelayMs` zwraca 0 dla nowego wpisu (`ResourceRuntimeStore.ts:1003-1012`) **[Z]**.
   - Skutek: przy napływie wierszy pobieranie idzie łańcuchem z prędkością round-tripu zamiast co 1000 ms.
   - Model wykresu jest przebudowywany i wysyłany do `setOption` przy niezwiązanych renderach, bo `LiveChartSurface` przekazuje inline'owe obiekty **[R]**.
8. **Backend wykonuje ciężką pracę przed sprawdzeniem cache i ETag.** Handler wektorów pola kopiuje wartości (`router_v2/handlers/data/fields.rs:5275`) **[Z]** i dla FDM czyta z dysku artefakt membership. Dopiero potem sprawdza projection cache i `If-None-Match` (`:5600-5616`) **[Z]**. Odpowiedź 304 kosztuje więc prawie tyle co 200. Pola live są trzymane w snapshocie jako tablice JSON (`live_accepted_projection.rs:3780-3823`) **[R]**.

---

## 2. Mapa toru danych i budżet opóźnienia

```
 solver (GPU) ──co ≥250 ms──► live_observation_m.<seq>.f64le + nagłówek JSON      [accepted_study_worker.rs:76-80]
                                   │  (tmp+rename, SHA-256; poprzedni plik kasowany od razu)
 projektor API ──poll 500 ms──► odczyt + SHA (spawn_blocking) → tablice JSON w snapshot
                                   │  swap pod write-lockiem, rewizja wielkości ↑   [live_accepted_projection.rs:19, :3780-3966]
 linie QoS WS ──okno 2000 ms──► resource.batch_changed {fields.samples, revision}  [main.rs:2174-2210, :2441-2474]
                                   │  (energies-current: tor Immediate, ~2 s wcześniej)
 RealtimeInvalidationBridge ──rAF──► invalidate(key, revision)                      [RealtimeInvalidationBridge.ts:451-462]
                                   │
 ResourceRuntimeStore ──min 2000 ms dla wektorów──► GET .../samples/vector (FMVP, ETag)
                                   │
 binaryDecodeScheduler (Web Worker, transferables) ──► snapshot store (stale→ready)
                                   │
 useViewport3DSceneModel (~8000 linii, ~20 hooków zasobów) ──► warstwy R3F
                                   │
 worker kolorów / glifów ──► staging ──► onVisible: needsUpdate / addUpdateRange ──► invalidate() (frameloop="demand")
```

Szacunkowy budżet dla `m` **[I]**:

| Odcinek | Czas |
|---|---|
| capture | 0–250 ms |
| poll projektora | 0–500 ms |
| okno łączenia | 0–2000 ms |
| fetch + dekod | ? |
| worker kolorów i glifów, upload chunkowany | ? |
| **Razem** | **~0,3–3 s + fetch/dekod/upload** |

Czasów fetch, dekodu i uploadu nie zmierzono. Dla dużej domeny trzeba je zmierzyć przed wyborem priorytetów (rozdział 9).

Ścieżka CLI/legacy publikuje JSON co 1 s albo co 200 ms w trybie fast (`communication_policy.rs:3-4`; `crates/fullmag-cli/src/live_workspace.rs:5600-5610`) **[R]** i przechodzi przez te same linie QoS.

---

## 3. Backend: przygotowanie i wysyłka danych

### 3.1 Kadencja

| Stała | Wartość | Miejsce | Uwagi |
|---|---|---|---|
| `ACCEPTED_LIVE_FIELD_MIN_INTERVAL` | 250 ms | `accepted_study_worker.rs:80` **[Z]** | kopia GPU→host i zapis f64le |
| `ACCEPTED_LIVE_SCALAR_MIN_INTERVAL` | 500 ms | `accepted_study_worker.rs:77` **[Z]** | skalary w nagłówku |
| `POLL_INTERVAL` projektora | 500 ms | `live_accepted_projection.rs:19` **[Z]** | `MissedTickBehavior::Delay`; backoff do 30 s przy niezmienionym błędzie |
| okno `fields/samples`, `planar-fields/field` | 2000 ms | `communication_policy.rs:11` **[Z]** | flush tylko z krawędzią końcową |
| okno lifecycle | 250 ms | `communication_policy.rs:10` **[Z]** | |
| `scalar.sample` | 200 ms | `communication_policy.rs:5` **[Z]** | |
| wiersze tabeli | 1000 ms | `communication_policy.rs:6` **[Z]** | |
| heartbeat WS | 15 s | `communication_policy.rs:9` **[Z]** | klient go nie używa (4.1) |
| odświeżanie popytu przez worker | 250 ms | `accepted_live_demand.rs:26` **[R]** | popyt = wielkości wyświetlane + odczytane w ostatnich 15 s |

### 3.2 Ustalenia

| ID | Ustalenie | Waga | Pewność |
|---|---|---|---|
| B1 | Okno 2000 ms dla `fields.samples` jest dominującym składnikiem opóźnienia. Komentarz przy stałej workera (`accepted_study_worker.rs:78-79`) zakłada, że każdy poll widzi świeżą klatkę, ale WS i tak ogłasza ją najwyżej co 2 s. Polityka pozwala zejść runtime do 250 ms (PATCH, `realtime_policy.rs:125-126`) **[R]**. | wysoka | [Z] |
| B2 | Ciężka praca przed cache i ETag w `get_field_vector_unfenced`: spłaszczenie JSON do `Vec<f64>` albo odczyt CAS z SHA, druga kopia `field.values.clone()` (`fields.rs:5275`) **[Z]**, dla FDM synchroniczne `std::fs::read` artefaktu FMRM (`resolved_spatial_field.rs:2478` → `fdm_region_membership.rs:859-883`) **[R]**. Projection cache i 304 są sprawdzane dopiero w `:5600-5616` **[Z]**, a cały ten czas trwa pod `current_live_state.read()`. | wysoka | [Z]/[R] |
| B3 | Trafienie w projection cache klonuje cały `Vec<u8>` (`fields.rs:5609`) **[Z]**. `SharedBinaryCache` z `Arc<[u8]>` już istnieje (`quantity_data_plane.rs:69-144`) **[R]**. | średnia | [Z] |
| B4 | Projekcja i serializacja działają na executorze async, bez `spawn_blocking` (`fields.rs:5641-5682`, `field_store.rs:671-675`). Wyjątek: próbkowanie planarne w `spawn_blocking` z single-flight. | średnia | [R] |
| B5 | Pola live w snapshocie są tablicami JSON (`live_accepted_projection.rs:3780-3823`), co daje około 4–5× więcej pamięci niż f64. Hash wartości liczony jest dwa razy (`session.rs:1336`, `:1411-1431`), a snapshot klonowany dodatkowo (`session.rs:3456`), mimo że istnieje wariant bez klonu (`:3600-3606`). | średnia | [R] |
| B6 | Endpointy planarne (meta, scalar, vectors, mask, probe, png, overlay) każdy osobno rozwiązuje pełne pole 3D pod read-lockiem, zanim sprawdzą cache próbki (`planar_fields.rs:522-825`, `:911-943`). Cache próbek ma 8 wpisów (`quantity_data_plane.rs:38`). | średnia | [R] |
| B7 | Statystyki są liczone przy każdym żądaniu: `get_field_meta` dla całego pola, bez ETag (`fields.rs:3047-3051`, `:3514`, `:3590-3617`); `scalar_min/max` w meta planarnej (`planar_fields.rs:1672-1684`). PNG renderuje się zawsze, bez `If-None-Match` (`planar_fields.rs:1323-1366`). | średnia | [R] |
| B8 | Format FMVP jest tylko f64 (`field_store.rs:8`), bez kompresji HTTP (`tower-http` z `cors, fs`). | średnia | [R] |
| B9 | Rywalizacja o locki: `tokio::RwLock` jest sprawiedliwy, więc długie odczyty z B2 opóźniają write projektora, a za nim kolejkują się wszystkie odczyty. Pętla WS bierze globalny mutex `current_live_session_transition` przy każdym evencie i heartbeacie (`main.rs:5180`, `:5274-5282`). | średnia | [I] |
| B10 | Możliwa utrata eventu WS: `seq` jest przydzielany przed `await` na replay lock (`main.rs:2040-2055`), a WS odrzuca `seq <= last_sent` (`main.rs:5076-5078`). Równoległy wydawca (projektor po zwolnieniu `transition` i flusher pod nim) może więc wyprzedzić N przez N+1, a N zginie. | średnia | [I] |
| B11 | Przy nowym zadaniu lub próbie `m` i pola `accepted_live_observation` są usuwane (`live_accepted_projection.rs:3848-3882`). Klient dostaje 204/202 do następnej klatki (`fields.rs:5323-5380`), co daje mignięcie między etapami studium. | średnia | [R] |
| B12 | Ładunek N jest kasowany zaraz po zapisaniu N+1 (`accepted_study_worker.rs:399-402`) **[Z]**. Jeżeli odczyt+SHA dużej domeny trwa dłużej niż ~250 ms, projektor może stale trafiać na usunięty plik i pole przestaje się odświeżać. | średnia | [Z] mechanizm, [I] skutek |

Poprawnie działa: brak rozdartych snapshotów (rename + SHA, swap z fence'ami, event wychodzi dopiero po swapie); topologia nie dostaje nowej rewizji przy zmianie samych wartości (`router_v2/handlers/sessions/status.rs:1357-1367`); silne ETagi, 304 i `Range` dla binariów; scoping i `max_samples` **[R]**.

---

## 4. Transport i warstwa zasobów frontendu

### 4.1 Kanał realtime

- WebSocket z subprotokołem `fullmag.live.v1`. Każda wiadomość to JSON parsowany na głównym wątku (`kernel/realtime/RealtimeClient.ts:78`) **[R]**.
- **Ponowne połączenie** ma stałe 5000 ms, bez backoffu i jittera (`RealtimeClient.ts:245-259`). Po reconnect, `hello`, `resync.required` i zmianie sesji unieważniany jest **cały zakres sesji** (`RealtimeInvalidationBridge.ts:500-502`, `:754-778`), co daje lawinę refetchów **[R]**.
- **Heartbeat** `wsHeartbeatMs = 15000` jest zdefiniowany (`communicationPolicy.ts:38`), ale klient go nie używa i nie wykrywa półotwartego gniazda **[R]**.
- **Łączenie zdarzeń** działa przez flush na rAF (`RealtimeInvalidationBridge.ts:451-462`, `:866-876`) i `minRefetchIntervalMs` per klucz. Pola `coalesced`/`window_ms` od serwera są używane tylko w diagnostyce **[R]**.

### 4.2 Pobieranie i cache

| ID | Ustalenie | Waga | Pewność |
|---|---|---|---|
| T1 | `markResourceLoading` nadpisuje `revision` w stanie `stale` (`resourceState.ts:29`). Brak `dataRevision`. Konsumenci w viewporcie budują z niej tożsamość (rozdz. 5). | wysoka | [Z] |
| T2 | Klucze z `#revision=` tworzą nowy pusty wpis przy każdej inwalidacji: `planarMonitorResources.ts:34`, `:58` **[Z]**; `crossSectionResources.ts:57`, `:80`, `:91`; `planarFieldResources.ts:379`; awaryjny klucz membership FDM `geometryLifecycleResources.ts:270-272` **[R]**. | wysoka | [Z]/[R] |
| T3 | Brak retencji między kluczami w `useResource` (`useResource.ts:180-197`). Klucze z `sample_token` (maska planarna, `PlanarVisualizationSection.tsx:211-216`) i z kursorem (wykresy) zmieniają się co klatkę. | wysoka | [R] |
| T4 | Cache binariów kluczowany rewizją: ETag nigdy nie pasuje (`crossSectionResources.ts:122`, `:157`, `:204`; `planarFieldResources.ts:443`, `:489`). Martwe wpisy siedzą do wyparcia LRU. | niska–średnia | [R] |
| T5 | JSON-y nie wysyłają `If-None-Match` (`ControlRoomApi.ts:4127-4144`), więc każda inwalidacja pobiera i parsuje cały JSON. | średnia | [R] |
| T6 | Mapy rewizji w `ResourceInvalidationController` nigdy nie są przycinane (`:10-13`, `:59-60`, `:114-119`). `getRevision` skanuje wszystkie prefiksy przy każdym `getSnapshot`. | nisko–średnia | [R] |
| T7 | Suma nominalnych limitów cache przekracza 1,2 GB (planar 480 MB, przekroje 240 MB, FDM 256 MB, viewport 272 MB). `MemoryBudgetRegistry` wygląda na wyłącznie raportujący. | średnia | [R]/[I] |
| T8 | Jedno odświeżenie daje około 3 notyfikacji na konsumenta (inwalidacja, `stale`, `finally`) i dwie zmiany `revision`. | średnia | [R] |

Poprawnie działa **[R]**:

- ochrona kolejności odpowiedzi (`entry.sequence`, `signal.aborted`);
- deduplikacja w obrębie klucza;
- zasada „ostatnie wygrywa” dla `pendingRequest`;
- dekodowanie FMVP, topologii, przekrojów i wierszy tabel w Web Workerze z transferables (`kernel/api/binaryDecodeScheduler.ts:183-216`);
- **wektory pola**: stabilny klucz bez rewizji, ETag, `preferCached`, `retainCachedOnNotApplicable` (`viewport3dResources.ts:1654-1709`). **To wzorzec do skopiowania** dla reszty zasobów.

Na głównym wątku zostają: `decodeFdmRegionMembership` (`geometryLifecycleResources.ts:1738`), surowe bajty planarne i wszystkie JSON-y.

---

## 5. Viewport 3D: aktualizacja buforów, kolorów, wektorów i shaderów

### 5.1 Per warstwa

| Warstwa | Co działa | Problem | Waga | Pewność |
|---|---|---|---|---|
| **MeshPartLayer** (FEM) | Geometria swapowana w `onVisible`, stara zwalniana potem (`hooks/useViewport3DGeometryUpload.ts:118-127`). ShaderMaterial stabilny, uniformy aktualizowane w miejscu (`viewport3dScalarSurfaceShader.ts:154-213`). | (a) Nowa `BufferGeometry` przy każdej zmianie **tożsamości** `topologyModel` (`MeshPartLayer.tsx:645-654`); upload manager nie deduplikuje po kluczu. (b) Snapshot kolorów ważny tylko dla tej samej geometrii (`useViewport3DScalarColorUpload.ts:118-133`, `:328-335`), więc po swapie `buffer: null`, materiał shaderowy jest zwalniany i tworzony od nowa. Skutek: rekompilacja programu i klatki jednolitego koloru do końca chunked uploadu. (c) Pending topologii daje `surfaceIndices = null` → `enabled = false` → `clearCurrentGeometry()` (A7). | wysoka | [R], skutek [I] |
| **Kolory/wartości FEM** | Staging + `addUpdateRange` + `needsUpdate` w `onVisible`, `DynamicDrawUsage` (`useViewport3DScalarColorUpload.ts:346-435`, `:639-704`). Częściowy bufor nigdy nie trafia na ekran. | Nowa `Float32Array` przy każdej rewizji (`:362`, `:742`), czyli churn GC. Zakres skali jest w `buildKey` (`useViewport3DChunkedScalarColors.ts:187`, `:211`), więc zmiana samego zakresu wymusza build w workerze i pełny upload, choć wystarczyłaby zmiana uniformu. | średnia | [R] |
| **VectorFieldLayer** (glify) | `InstancedMesh` z pojemnością jako potęgą dwójki. Macierze pisane chunkami, flagowane w `onVisible`, więc GPU trzyma starą klatkę. Materiał współdzielony. | `key={vector-shaft-${capacity}}` (`:1288`, `:1297`) **[Z]**: przekroczenie potęgi dwójki remontuje mesh z `count = capacity`, jednostkowymi macierzami i zerowym `instanceColor` (`:597-607`), więc przed `onVisible` może się narysować klatka glifów w origin. Orientacja liczona na CPU: `setFromUnitVectors` + 2× `matrix.compose` na instancję (`:961-992`); przy ~100k glifów upload rozkłada się na kilka klatek. | średnio-wysoka | [Z]/[R], skutek [I] |
| **FdmCuboidLayer** | Pełne `array.set` w miejscu + `addUpdateRange` (`:613-628`, `:1217-1240`). Last-good przy równym `topologyKey` (`fdmCuboidBuildState.ts:46-56`). | (a) `useMemo` tworzy nowy materiał przy zmianie `opacity`/`vertexColors`/koloru (`:1144-1180`) **[Z]**, co daje rekompilację przy każdym ticku suwaka. (b) `args={[geometry, undefined, renderCount]}` (`:1362`, `:1379`): zmiana liczby instancji daje nowy `InstancedMesh` z jednostkowymi macierzami do czasu efektu. (c) Niezgodna długość kolorów zdejmuje `instanceColor` i wywołuje `mesh.dispose()` (`:632-642`, `:1250-1263`). (d) Kolory liczone na CPU, na wątku głównym, w `useMemo` (`useViewport3DSceneModel.ts:6213-6237`, `:6969-7000`). (e) A1 i A11. | wysoka (A1), średnia (reszta) | [Z]/[R] |
| **AntennaFieldLayer** | Materiały stabilne. | A6: wszędzie `status === "ready"` (`hooks/useAntennaFieldOverlay.ts:33-40`) **[Z]**, więc nakładka znika na czas odświeżania. Atrybut `color` dokładany w późniejszym `useEffect`, więc pierwsza klatka może być czarna. | średnia | [Z]/[R] |
| **Nakładki regionów** | Bufory budowane w workerze, cache po kluczu. | Zgodność po tożsamości obiektów (`region-overlays/useViewport3DRegionOverlayModels.ts:161-185`); `meshRegionOverlayParts` to nowa tablica przy każdej zmianie `femDomain`, więc do końca przebudowy widać `EMPTY_REGION_OVERLAY_MODELS`. | średnia | [R] |
| **ClipPlaneLayer** | Używa `.data`, więc stan `stale` jest wyświetlany; geometria zwalniana po commicie. | — | — | [R] |

### 5.2 Wspólne mechanizmy

- **Tożsamość obiektu zamiast tożsamości danych.** `femDomain` jest memoizowany na obiekcie `sharedDomainManifest.data` (`useViewport3DSceneModel.ts:3620-3626`). Każdy refetch manifestu (nawet z tymi samymi danymi) daje nowe tablice części i kaskadę unieważnień: bundle indeksów, nakładki regionów, kolory (`useViewport3DChunkedScalarColors.ts:307-335` wymaga `current.topology === request.topology`). To ten sam problem co T1, tylko w warstwie modeli **[R]**.
- **Pętla renderowania jest poprawna.** `frameloop="demand"` (`viewport3dTypes.ts:46`), dla ukrytej karty `"never"` (`Viewport3DModule.tsx:2247`). Invalidacje są łączone w mikrotasku, a RAF upload managera kręci się tylko przy niepustej kolejce. Brak bezczynnych przerysowań **[R]**.
- **Hook sceny.** `useViewport3DSceneModel.ts` ma ~8000 linii i ~20 hooków zasobów, bez `useDeferredValue`/`startTransition`. Każda notyfikacja dowolnego zasobu przelicza cały hook **[R]**, koszt **[I]**.

### 5.3 Skala kolorów 3D

- **FEM.** Zakres pochodzi z osobnego `useFieldMetaResource` (`useViewport3DSceneModel.ts:5300-5350`), bez sprawdzenia zgodności rewizji z payloadem. Skutek: zakres z kroku N-1 na wartościach z kroku N, a potem drugi build **[I]**.
- **FDM.** `range = undefined` (`:6216-6225`), więc `resolveScalarRange` skanuje całe pole przy każdej rewizji (`viewport3dFieldMapping.ts:310-312`, `:1141-1170`).
- Brak histerezy i trybu „tylko rozszerzaj”. Stabilne są tylko tryby `manual`/`symmetric` nakładki analizy.

---

## 6. Wykresy, mapa 2D i odczyty telemetrii

| ID | Ustalenie | Waga | Pewność |
|---|---|---|---|
| C1 | **HysteresisChart**: `echarts.init`/`dispose` w efekcie z zależnościami `liveFieldValue`, `liveYValue`, `progress`, `points` (`shared/domain/study/HysteresisChart.tsx:1293`, `:1522-1524`) **[Z]**. Przy każdej aktualizacji sweepu chart jest niszczony i tworzony od nowa z asynchronicznym `import("echarts")` pomiędzy. Do tego animacja `effectScatter` (`:1488`, `:1498`). | wysoka | [Z] |
| C2 | **Kursor w kluczu zasobu** (`studyRuntimeResources.ts:2795-2806`) **[Z]**, a `refetchDelayMs` zwraca 0 dla nowego wpisu (`ResourceRuntimeStore.ts:1003-1012`) **[Z]**. Limit `tableRowsMinRefetchMs = 1000` nie działa, więc fetch idzie łańcuchem z prędkością RTT. Każda zmiana klucza daje też status `loading`, a pigułka statusu przełącza się „Updating” ↔ „Live” (`ChartSection.tsx:176-181`). | średnio-wysoka | [Z] mechanizm, [I] skutek |
| C3 | **Memo modelu wykresu nie działa.** `LiveChartSurface.tsx:225-233` przekazuje inline `surface={{…}}` i nowe tablice `series`/`allSeries`, a `presentation` też jest nowy (`useLiveChartsController.ts:187`). Każdy render kontrolera przebudowuje pełną opcję i woła `setOption` (`EChartsCanvasSurface.tsx:188-194`, `chartRenderer.ts:225-231`, `:453-494`). | średnio-wysoka | [R] |
| C4 | `select_table_rows` skanuje wszystkie wiersze od 0 przy każdym żądaniu (`crates/fullmag-api/src/router_v2/handlers/data/tables.rs:446-456`). Historia energii robi to samo (`.../simulation/runtime.rs:2033-2042`). Koszt O(N) rośnie z długością runu. | średnia | [R] |
| C5 | Tryb „follow”: pierwsza odpowiedź jest zdecymowana do 800 punktów, a kolejne inkrementy przychodzą surowe. Klient trzyma kroczące okno 5000 wierszy (`chartDataPlan.ts:8`), więc gęstość punktów jest nierówna i wczesna historia wypada. Wykres energii pokazuje tylko ostatnie 800 próbek (`useLiveEnergyData.ts:115`). | średnia | [R] |
| C6 | Osie bez `min`/`max`, a prefiks SI liczony od nowa z ekstremów (`chartRenderer.ts:316-337`, `:556-558`, `:585`). Granice skaczą schodkowo, prefiks zmienia się (ps→ns), zoom procentowy dryfuje przy dopisywaniu. | nisko-średnia | [I] |
| C7 | `Float64Array` do 5000×kolumn w `useReducer`, kopiowana w całości przy każdym dopisaniu (`useLiveTableData.ts:66`; `chartDataPlan.ts:253-268`). Narusza doktrynę („no large typed arrays in React state”). | nisko-średnia | [R] |
| C8 | **Mapa 2D: dwa sekwencyjne round-tripy na klatkę.** Meta → (scalar, mask, vectors, overlay) (`FieldMapModule.tsx:291-336`). Klucze z `#revision=` sprawiają, że mask i overlay są pobierane od nowa co klatkę (T4). Brak klienckiego `minRefetchIntervalMs`. | średnia | [R] |
| C9 | **Mapa 2D: skala kolorów** w trybach auto i symmetric liczona z każdej klatki (`modules/field-map/model/fieldMapRenderModel.ts:183-210`), więc legenda „oddycha”. | średnia | [R] |
| C10 | `FooterTelemetry` (~1900 linii, ~9 hooków zasobów) robi `setSample` na każdą próbkę WS ~5 Hz (`modules/footer/FooterTelemetry.tsx:326-337`). Brak zawężenia renderu. | nisko-średnia | [R] |
| C11 | `Math.min(...arr)` w `shared/analysis-charts/frequencyRenderModels.ts:80-81` i `shared/domain/analysis/frequencyUnits.ts:11-12` (zwykle małe listy modów). | niska | [R] |

Poprawnie działa **[R]**:

- `EChartsCanvasSurface`: tworzy chart raz, `ResizeObserver` łączony z rAF, `dispose` przy odmontowaniu, `animation:false`;
- kolorowanie rastra 2D w Web Workerze z odrzucaniem przestarzałych wyników;
- poprzedni obraz zostaje do powrotu workera, a `useRetainedPlanarFrame` trzyma ostatnią klatkę w `FieldMapModule`;
- `StatusBarModule` używa wąskich selektorów.

---

## 7. Status pozycji z audytu 2026-10-30 (sekcja A)

Żadna z pozycji sekcji A nie jest w pełni naprawiona. Poprawa dotyczy tylko części A2 (klucz binariów membership z tożsamości danych).

| ID | Status | Dowód (`c944b3186`) |
|---|---|---|
| Przyczyna „revision w stale” | **nadal** | `resourceState.ts:19-33` [Z] |
| A1 topologia wokseli FDM | **nadal** | `useViewport3DSceneModel.ts:5766-5775` (`domainMeta.revision`, `fdmRegionMembership.revision` w `topologyKey`) [Z]; klucze multilayer `:6520-6622` są już poprawne |
| A2 membership FDM | **częściowo** | klucz binariów z `generation_id` (`geometryLifecycleResources.ts:1669-1677`); nadal `data: null` poza `ready` (`:1455-1460`), prerekwizyt `domain.status === "ready"` (`:1689`), fallback do `#revision=` (`:270-272`) [R] |
| A3 inspektor monitora płaskiego | **nadal** | `planarMonitorResources.ts:58` [Z]; `PlanarMonitorInspectorPanel.tsx:53-61` |
| A4 lista monitorów | **nadal** | `planarMonitorResources.ts:34` [Z] |
| A5 przekroje | **nadal** | `crossSectionResources.ts:57`, `:80`, `:91`; `CrossSectionInspectorPanel.tsx:92`, `:145-147` [R] |
| A6 nakładka anteny | **nadal** | `useAntennaFieldOverlay.ts:33-40` [Z]; `antennaFieldOverlayPlan.ts:13` |
| A7 powierzchnie FEM przy refetchu manifestu | **nadal, złagodzone** | cache po `buildKey` działa dopiero w efekcie, więc zostaje co najmniej jeden commit bez geometrii (`useViewport3DTopologyIndexBundle.ts:222-235`, `:455-460`) [R] |
| A8 `topology.revision` w kluczach buildów | **nadal** | `useViewport3DSceneModel.ts:3641`, `:5037-5038`, `:5579-5593`, `:7123` [R] |
| A9 sekcja 2D w Inspektorze | **nadal** | `planarFieldResources.ts:379`; `PlanarVisualizationSection.tsx:197-217`, `:368-370`; dodatkowo `sample_token` w kluczu maski [R] |
| A11 wyłączone wpisy batcha FDM | **nadal** | `FdmCuboidLayer.tsx:707`, `:793-795` [R] |
| A12 rosnące mapy rewizji | **nadal** | `ResourceInvalidationController.ts:10-13`, `:114-119` [R] |
| A13 cache binariów z rewizją | **nadal** (przekroje, planar), **częściowo** (FDM) | patrz T4 |
| A14 węzły „unavailable” | **nadal** | `resultsExplorerNodes.ts:580`, `:1353`, `:1363` [R] |

---

## 8. Propozycja kolejności napraw

Pogrupowane według toru, który poprawiają. W każdej fali najpierw pozycje o wysokim wpływie i niskim wysiłku. Rozmiar: S ≤ 1 dzień, M ≈ 2–4 dni, L > tydzień (orientacyjnie).

### Fala 1: koniec mrugania (frontend, bez zmian kontraktu)

1. **`dataRevision` w `ResourceState`** (rewizja ustalonych danych, niezmienna w `stale`) i przepięcie konsumentów viewportu: A1, A8, `buildReference` bundla, klucze kolorów. Rozwiązuje T1, A1, A8. **M.**
2. **Usunięcie `#revision=` z kluczy**, z oparciem na `externalRevision`, który `useResource` już subskrybuje, według wzorca wektorów pola (`viewport3dResources.ts:1654-1709`). Dotyczy monitorów, przekrojów, meta planarnej i fallbacku membership. Rozwiązuje A3–A5, A9 (część), A13, ogranicza A12. **S–M.**
3. **Warunki na danych zamiast na statusie** (`stale` z danymi jest wyświetlalne): A2, A5, A6, A9, A14, `studyRuntimeResources.ts:3093`. **S.**
4. **Retencja między kluczami** (`keepPreviousData`) w `useResource` dla kluczy z `sample_token` i kursorem. **M.**
5. **HysteresisChart**: rozdzielenie efektu init/dispose od efektu `setOption`, wyłączenie ripple w trybie live. **S.**
6. **Glify**: `count = 0` przy montażu nowego `InstancedMesh` (albo stary mesh do `onVisible`), wzrost pojemności bez zmiany `key`. **S.**
7. **FdmCuboidLayer**: `opacity`/`color` aktualizowane w miejscu na istniejącym materiale, bez `mesh.dispose()` przy wymianie `instanceColor`. **S.**

### Fala 2: stabilność skali i geometrii

8. **Topologia FEM bez pustej klatki**: last-good bundle kluczowany fingerprintem topologii, `femDomain` memoizowany po `generation_id`/fingerprincie, bez `clearCurrentGeometry()` przy pending. To samo dla nakładek regionów (A7). **M.**
9. **Swap geometrii FEM z zachowaniem kolorów**: przy tym samym `vertexCount` przeniesienie atrybutów lub dopuszczenie retencji bufora; bez ponownego tworzenia ShaderMaterial. **M.**
10. **Polityka zakresu kolorów** wspólna dla 3D i 2D: meta zakresu przyjmowana tylko przy zgodnej rewizji payloadu; tryb „auto: rozszerzaj od razu, zwężaj z histerezą” oraz „zamroź zakres”; zakres wyjęty z `buildKey` ścieżki shaderowej (tylko uniform). Backend: zakres liczony raz na rewizję pola i cache'owany (B7). **M.** Zmiana zachowania widocznego dla użytkownika, więc wymaga decyzji (rozdział 10).
11. **Wykresy live**: stabilne `surface`/`series`/`presentation` (memo per panel), kursor poza kluczem zasobu (ref albo throttle per prefiks), brak pigułki „Updating” przy zachowanych danych, osie z histerezą prefiksu. **S–M.**
12. **Mapa 2D**: równoległe meta i dane (albo meta+scalar w jednej odpowiedzi), retencja meta w `PlanarVisualizationSection`, reużycie `ImageData` i rozmiaru canvasu. **M.**

### Fala 3: przepustowość i opóźnienie (backend + kontrakt)

13. **Okno `fields.samples`** z 2000 ms do ~250–500 ms albo throttle z krawędzią wiodącą (`communication_policy.rs:11`, `main.rs:2174-2210`). **S** w kodzie, ale zwiększa ruch, więc najpierw pozycje 14–15 i pomiar.
14. **ETag i klucz projection cache z metadanych przed dekodowaniem**; cache jako `Arc<[u8]>`/`Bytes`; 304 bez dotykania wartości (B2, B3). **M.**
15. **Dekod, projekcja i serializacja w `spawn_blocking` poza `RwLock`**; cache FMRM per fingerprint (B4, B9). **M.**
16. **Pola live jako `Arc<[f64]>` zamiast tablic JSON** w snapshocie (B5). **M–L.**
17. **Projektor sterowany zdarzeniem** (powiadomienie od workera) albo poll 250 ms w czasie biegu; zachowanie ładunku N-1 o jeden cykl dłużej (B12). **M.**
18. **`seq` przydzielany pod replay lockiem**, pętla WS bez globalnego mutexu (B10). **S.**
19. **Realtime klient**: backoff wykładniczy z jitterem, liveness na heartbeat, rozłożony resync po reconnect. **S.**
20. **Wykresy po stronie serwera**: wyszukiwanie binarne kursora zamiast skanu od 0 (C4); historia energii przez endpoint tabel z kursorem i `minmax_lttb`; okresowa pełna decymacja w trybie follow (C5). **M.**
21. **Glify w shaderze**: atrybuty instancyjne `position`/`dir`/`length` zamiast `mat4`; około 4× mniej bajtów uploadu i brak ~2N `compose` na CPU. **M.** Wymaga dowodu z przeglądarki, że jakość glifów się nie zmienia (reguła viewportu).
22. **Opcjonalnie**: f32 lub kompresja dla FMVP (zmiana kontraktu FMVP), globalny budżet pamięci cache (T7), `If-None-Match` dla dużych JSON-ów (T5). **M.**

---

## 9. Czego ten audyt nie dowodzi i co trzeba zmierzyć

- Nie zmierzono żadnego czasu. Przed falą 3 potrzebne są pomiary na dużej domenie (FDM ≥ 10⁶ komórek i FEM ≥ 10⁶ węzłów, GPU):
  - backend: czas odczytu+SHA ładunku w projektorze, czas `get_field_vector_unfenced` (200 i 304), czas trzymania read-locka, odstęp między eventami `fields.samples`;
  - frontend: czas fetch+dekod FMVP, czas workera kolorów i glifów, liczba commitów Reacta na jedną klatkę live (sonda z pamięci projektu: setter `FiberRoot.current`), liczba klatek bez geometrii lub z jednolitym kolorem (zrzut drawing buffera co klatkę).
- Każda poprawka z fali 1 i 2 dotyka viewportu lub wykresów, więc zgodnie z regułami projektu wymaga smoke'u przeglądarki: widoczny canvas, niezagubiony kontekst WebGL, niezerowy drawing buffer. Do tego test regresji „brak pustej klatki przy odświeżeniu” dla FDM i FEM.
- Ustalenia [I] dotyczące kolejności klatek R3F względem efektów (glify z jednostkowymi macierzami, czarna pierwsza klatka anteny, zwolniona geometria przed commitem) trzeba potwierdzić nagraniem klatek.

## 10. Decyzje do podjęcia przed implementacją

1. **Docelowa kadencja pola na żywo.** Co jest ważniejsze: niskie opóźnienie (~250–500 ms, większy ruch i koszt backendu) czy obecne ~2 s przy niższym koszcie? Od tego zależy kolejność fali 3.
2. **Domyślna polityka zakresu kolorów.** „Auto per klatka” (obecnie), „auto z histerezą” czy „zamroź po pierwszej klatce z ręcznym resetem”? To zmiana zachowania widocznego dla użytkownika.
3. **Zakres wykresu follow.** Kroczące okno ostatnich N próbek (obecnie) czy cała historia z równą decymacją?

---

## 11. Stan wdrożenia (branch `codex/live-refresh-flicker-20261119`)

Wdrożona część fali 1 (frontend, bez zmiany kontraktu API):

| Pozycja | Zmiana |
|---|---|
| T1, A1, A8 | `ResourceState.dataRevision` i `resourceDataRevision()`; klucze buildów FDM (wokseli, airbox) i FEM (bundle indeksów, kolory, model pola) używają rewizji danych zamiast rewizji oczekującej |
| T2, A3, A4, A5, A9 (meta), A13 | opcja `revisionKey` w `useResource`; monitory płaskie, przekroje i zasoby planarne bez `#revision=` w kluczu store i cache binariów |
| A2 | deskryptor membership FDM i prerekwizyt domeny akceptują `stale` z danymi; klucz binariów membership z rewizji danych |
| A5, A6, A9, A14 | warunki na danych (`resourceHasDisplayableData`, `isDisplayableResourceStatus`) zamiast `status === "ready"` |
| 5.1 glify | nowy `InstancedMesh` po zmianie pojemności startuje z `count = 0` |
| 5.1 FDM | materiały wokseli tworzone tylko dla parametrów zmieniających program; kolor, opacity i PBR aktualizowane w miejscu |
| C1 | `HysteresisChart`: jedna instancja ECharts, `setOption` przy aktualizacji, czysta funkcja opcji z testami |
| C3 | memo modeli wykresów live (`presentation`, wybór serii, panele) |
| C2 (część) | pigułka statusu nie przełącza się na „Updating” przy zachowanych danych |

Pozostają otwarte: A7 (pusta klatka przy pending topologii FEM), A11, A12, swap geometrii FEM z zachowaniem kolorów, polityka zakresu kolorów, kursor wykresów w kluczu zasobu (C2), retencja między kluczami (T3) oraz cała fala 3 (backend).
