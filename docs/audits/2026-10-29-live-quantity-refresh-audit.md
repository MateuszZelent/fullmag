# Audyt odświeżania wielkości w trakcie aktywnego solve (FEM i FDM): Control Room ↔ API ↔ worker

Data: 29.10.2026. Baza: `master` `abc6f92ce`. Tryb: wyłącznie odczyt kodu, bez zmian w źródłach.
Zakres: jak w trakcie biegu powstają, są publikowane, projektowane i pobierane `m`, pola `H_*`,
`torque`, gęstości energii `eden_*`, energie `E_*` oraz skalary, na torach FDM CPU, FDM GPU,
FDM multilayer CPU/GPU, FEM CPU i FEM GPU w ścieżce Docker DEV (accepted Study worker).

Kontynuuje [audyt komunikacji z 25.10](2026-10-25-control-room-api-communication.md) i
[audyt dostępności wielkości z 26.10](2026-10-26-quantity-availability-audit.md). Tamtych ustaleń
nie powtarzam w całości. Sekcja 6 podaje ich aktualny stan.

Ścieżki są względem repozytorium, a numery linii dotyczą `abc6f92ce`. Ustalenia pochodzą z odczytu
kodu. Pomiarów runtime i przeglądarki w tym audycie nie wykonano; takie miejsca oznaczam
`NOT VERIFIED`.

## Werdykt

**Założenie „frontend decyduje, jakie wielkości są potrzebne, a backend przygotowuje tylko je”
nie jest dziś zrealizowane na ścieżce, której używa aktywny solve.** Przepływ jest odwrotny:

1. Worker i runner liczą i zapisują **cały aktywny katalog pól na każdym kroku**, o ile mieści się
   w budżecie 128 MiB (`ACCEPTED_LIVE_FIELD_EVERY_N = 1`, `ACCEPTED_LIVE_FIELD_MIN_INTERVAL = 0`).
   Gdy się nie mieści, publikują **tylko `m` co 100 kroków**. Nie ma stanu pośredniego
   „`m` + wielkość oglądana”.
2. API już wylicza z UI zbiór żądanych wielkości (`observation_quantities`), ale ten zbiór
   **nie trafia do accepted workera**. Oba workery przekazują runnerowi
   `DisplaySelectionState::default`.
3. Frontend sam liczy dokładny zbiór potrzeb widoku (`viewport3DFieldDataPlan.ts`), ale go
   nie wysyła. Pobiera wybrane klucze przez HTTP po każdej inwalidacji z WebSocketu, który jest
   tylko jednokierunkowy (serwer → klient).
4. Główne pole FDM pobiera w pełnej rozdzielczości f64 i dopiero w przeglądarce tnie je do
   150 tys. komórek. Serwerowy `max_samples` istnieje, ale próbkuje inaczej niż renderer:
   to rzeczywista niezgodność kontraktu próbek (sekcja 4.4).
5. Historia energii w panelach nie ma ścieżki odświeżania w trakcie biegu (sekcja 5.2).

Fizyka i katalog wielkości są w porządku. Problem leży w płaszczyźnie publikacji. Koszt pełnego
katalogu na krok ponosi solver (kopie D2H, druga ewaluacja pól, SHA-256, zapis pliku).
Użytkownik i tak ogląda zwykle jedną wielkość, odświeżaną najwyżej co 2 s.

## 1. Obecny przepływ danych w trakcie biegu

```
 runner (krok n)                                worker (accepted_study_worker.rs)
 ─ integrator RHS (energie z fused RHS / native)    observe(update):
 ─ every_n == 1 → capture_full_active_*_fields      ─ field_due = m.is_some() (MIN_INTERVAL = 0)
   (wszystkie aktywne H_*, torque, eden_*, mat_*)   ─ zapis live_observation_m.<seq>.f64le
 ─ StepUpdate{m, fields, stats}  ───────────────►      (m + wszystkie pola, SHA-256 całości)
                                                    ─ przepisanie live_observation.v1.json (stats)
                                                              │  store na dysku (u nas 9p)
                                                              ▼
 API: live_accepted_projection.rs, tick 500 ms (MissedTickBehavior::Delay)
 ─ odczyt nagłówka; payload tylko przy zmianie sekwencji; ponowny SHA-256, dekodowanie
 ─ m → json!({"values": …}) i każde pole → JSON w SessionStateResponse.latest_fields
 ─ ScalarRow z header.stats (energie, max torque, dt, <m>) → scalar_rows (bez limitu)
 ─ publikacja: scalar.sample (WS) + PEŁNY resource.batch_changed (WS)
                                                              │  WS /v2/sessions/current/events/ws
                                                              ▼
 Control Room
 ─ RealtimeInvalidationBridge: inwalidacja kluczy /data/fields/{q}/… dla każdej zmienionej q
 ─ tylko klucze z aktywnymi słuchaczami → useResource → ensureLoad
 ─ GET …/fields/{q}/samples/vector (FMVP f64), throttle 2 s od ostatniego ZAKOŃCZONEGO ładowania,
   abortStaleInflight = true
 ─ GET …/tables/default/rows.bin (kursor, 1 s), …/energies/current (status 5 s + WS)
```

Kanały „w górę” od frontendu do backendu to wyłącznie:

- `PATCH /visualization/state` z `active_quantity_id` (stan UI, nie subskrypcja);
- parametry zapytania HTTP przy każdym GET pola (`component`, `scope_*`, `max_samples`);
- `compute_fields` z `reason: "field_on_demand"`, w Docker dozwolone dopiero po biegu terminalnym;
- `POST /visualization/client-acks`.

## 2. Kto decyduje o zbiorze wielkości

| Warstwa | Co istnieje | Czy wpływa na liczenie w biegu |
|---|---|---|
| Frontend | `buildViewport3DPassDemands` → `planViewport3DFieldResourceRequests` (`apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts:375-495`) liczy dokładny zbiór (wielkość, zakres, kompletność, `maxSamples`) | Nie. Służy tylko do wyboru kluczy GET. WS nie ma `send` (`kernel/realtime/RealtimeClient.ts:10-14`) |
| API | `synchronize_observation_quantities` / `observation_quantities_for_visualization_state` (`crates/fullmag-api/src/router_v2/handlers/visualization/display.rs:2407-2474`): aktywna wielkość, widoczne cele z kolorem lub strzałkami, planar | Tylko w starej ścieżce interaktywnej: `GET /v1/internal/live/current/display-selection` (`main.rs:2817`), odpytywane przez `fullmag-cli/src/interactive_runtime_host.rs:1973` |
| Worker accepted | `DisplaySelectionState::default` (`accepted_study_worker.rs:2610`, `accepted_fem_study_worker.rs:140`): `m`, every_n 50, rewizja 0 | Nie. Brak wiadomości w `fullmag-runtime-control/src/worker_inbox.rs`; RunSpec dopuszcza tylko `live_workspace`, politykę startu i `solver_profile` (`accepted_study_worker.rs:534-546`) |
| Runner | Zbiór stały: `field_materialization_quantity_ids()` ∩ aktywna fizyka planu (`fullmag-runner/src/quantities.rs:61-195`). `m`, `H_eff` i `torque` zawsze; reszta zależnie od włączonych członów | Tak, ale nie zależy od UI. Wyjścia skryptu w ProblemIR sterują tylko trwałymi harmonogramami artefaktów (oraz maską statystyk na GPU) |

Wniosek: w kodzie są już dwie połowy mechanizmu popytu, frontendowa i API. Brakuje
**kanału API → worker** oraz **runnera, który liczy tylko żądane pola**. Runner CUDA ma już
`ObservationDemand` (`fdm/gpu/cuda/live_observations.rs:351-403`), ale w accepted dostaje tylko
`m` (+ FrozenSpins).

## 3. Producent: worker i runner

**R1 (K). Pełny katalog na każdym kroku albo samo `m` co 100 kroków.**
- `field_sampling_interval()` (`crates/fullmag-api/src/accepted_study_worker.rs:225-245`) zwraca:
  - 1, gdy cała generacja (`próbki × (Σ n_comp + 3) × 8 B`, :187-193) mieści się w
    `min(storage/8, memory/8, 128 MiB)` (:206-208);
  - 100, gdy mieści się tylko `m`. Przy 100 runner nie wysyła żadnego `H_*`, bo
    `full_fields_due` wymaga `every_n == 1`;
  - `u64::MAX`, gdy nic się nie mieści.
- Brak kadencji czasowej w runnerze. `fdm_multilayer_live_field_due` to `step % n == 0`
  (`fullmag-runner/src/types.rs:36-38`).
- Przykład: FEM z 1,09 mln węzłów ma `m` ≈ 26 MB, a ~10 pól wektorowych + skalary ≈ 300 MB.
  W biegu dostępne jest więc tylko `m`, co 100 kroków. Mała domena FDM płaci natomiast za
  pełny katalog na każdym kroku.

**R2 (K). Throttle skalarów 500 ms jest omijany.**
- W `observe()` (`accepted_study_worker.rs:249-308`) `field_due` jest prawdziwe przy każdym
  `update.magnetization`, bo `MIN_INTERVAL = 0`.
- Każdy zapis pola przepisuje nagłówek (:292). `ACCEPTED_LIVE_SCALAR_MIN_INTERVAL = 500 ms` (:63)
  działa więc tylko dla kroków bez `m`.
- Przy every_n = 1 worker zapisuje payload f64le i nagłówek na każdym kroku: plik tymczasowy,
  rename i usunięcie poprzedniego payloadu (:650-664, :304-307).

**R3 (W). Koszt per krok na poszczególnych torach (every_n = 1).**

| Tor | Dodatkowa praca na krok | Źródło |
|---|---|---|
| FDM CPU | druga pełna ewaluacja pól z demag (`observe_state_with_antenna_field`) obok RHS integratora; `<m>` na każdym kroku | `fdm/cpu/reference.rs:683-785`, `:2757-2829` |
| FDM GPU | `copy_m` D2H **bezwarunkowo**, gdy live, tylko po checkpoint FrozenSpins, który bez `plan.frozen_spins` zwraca `None`; potem drugi `copy_m` (:1107-1118) i jeden D2H per wielkość katalogu; adaptacyjne batchowanie wyłączone przy live (:411-416) | `fdm/gpu/cuda/execute.rs:1015-1025`, `:300-305`, `:1141-1191` |
| FDM multilayer CPU | `observe_multilayer` na każdym kroku, także bez live | `fdm/cpu/multilayer_reference.rs:446`, `:474-525` |
| FDM multilayer GPU | snapshot wszystkich obserwabli przy `live_snapshot_due` (co krok) | `fdm/gpu/cuda/multilayer.rs:1593-1602`, `:1043-1099` |
| FEM CPU/GPU | asynchroniczne `request_magnetization`, potem synchroniczne `capture_native_fem_observables`: ponowny odczyt mapy węzłów przez FFI **i jej SHA-256 na każdym kroku**, D2H per wielkość, nadpisanie `update.magnetization` (druga kopia `m`) | `fem/relax/llg_overdamped.rs:451-619`, `fem/relax/preview.rs:1770-1874` |

**R4 (W). Łańcuch kopii i haszy na jedną publikację.**
Runner tworzy `Vec`. `bind_live_magnetization_layout` klonuje `m` (`lib.rs:3293-3303`).
`capture_solver_observables` klonuje każde pole i hashuje `m` (`accepted_materialization.rs:150-172`).
Worker buduje bufor bajtów i hashuje całość (`accepted_study_worker.rs:402-439`). API przy
odczycie hashuje ponownie (:776-781). Daje to co najmniej trzy pełne SHA-256 i 3–4 kopie na
generację.

**R5 (Ś, hipoteza, `NOT VERIFIED`). Energie FDM GPU w nagłówku live mogą być nieaktualne.**
W trybie `NativeStatsPolicy::requested` krok nie wypełnia statystyk energii
(`backends/fdm/include/context.hpp:1840-1851`). Pełny `snapshot_step_stats` jest wołany tylko
na krokach `due_scalar_row` (`execute.rs:998-1010`), których stride wynika z okresów wyjść
skalarnych skryptu. Nagłówek live może więc nieść zerowe lub stare `E_*` między tymi krokami.
FEM zwraca energie z natywnego kroku zawsze (`native_fem.rs:4116-4208`), a FDM CPU z fused RHS.
Wymaga potwierdzenia w biegu GPU.

**R6 (K, bez zmian od 25.10). Praca po ostatnim kroku.** Airbox FDM multilayer jest
materializowany zachłannie i zapisywany przez `serde_json::to_vec_pretty`
(`fdm/cpu/airbox_observation.rs:391,440`). Ścieżka accepted liczy go ponownie i trzyma w pamięci
zarówno sparsowany `Value`, jak i surowy JSON (`accepted_materialization.rs:961-1065`). `m_initial`
i `m_final` są zapisywane jako pretty JSON (`artifacts.rs:5387`).

## 4. Pośrednik: projektor API i endpointy

### 4.1 Projektor

**P1 (W). Polling co 500 ms z kosztem stałym przy aktywnym zadaniu.**
- `live_accepted_projection.rs:19, 209-210` (`MissedTickBehavior::Delay`, więc wolny tick
  przesuwa kolejne).
- Snapshot Study jest już memoizowany (`cached_accepted_study_snapshot`, :1019-1041). Mimo to
  każdy tick z aktywnym zadaniem:
  - czyta RunIntent, RunCatalog i ArtifactCatalog (:505-604);
  - dekoduje `RunSpecification` (:636);
  - przy każdym podbiciu rewizji RunCatalog (np. heartbeat) wykonuje `load_verified_outputs`
    (:808-816, :1775) i `ensure_stage_preparation_for_step` (:337, :380).

**P2 (W). `m` i wszystkie pola live lądują w `latest_fields` jako JSON.**
- `json!({"values": values})` dla `m` oraz każde pole obserwacji (:2731-2777).
- Każdy odczyt endpointu spłaszcza JSON od nowa (`flatten_json_field_values`).
- `apply_projection` klonuje cały `SessionStateResponse` (:2451), a
  `apply_current_live_accepted_field_frame` drugi raz (`session.rs:3100-3108`). Oba klony
  zawierają wszystkie `scalar_rows` i JSON pól.

**P3 (Ś). Zawsze pełny batch WS.**
- Projektor publikuje `publish_current_live_realtime_batch_changed` (pełna lista zasobów,
  `main.rs:2049`; wywołanie `live_accepted_projection.rs:3018`).
- Wariant `_since` (`main.rs:637, 2066`) używa tylko stara ścieżka owner sync.
- Rewizje `Fields samples` obejmują wszystkie klucze `field_quantity_revisions` z `broad: true`
  i bez `recommended_fetch` (`main.rs:383-395`). Frontend inwaliduje więc każdy klucz
  `/data/fields/{q}/…` (także meta i planar) dla każdej zmienionej wielkości.

**P4 (Ś). Mutex przejścia sesji na każdym zdarzeniu WS.**
`current_live_realtime_ws_scope_active` (`main.rs:5247-5255`) bierze
`current_live_session_transition.lock()` dla każdego zdarzenia, heartbeatu i elementu replay.
Opóźnione publikacje batchy biorą go również (:2168). Adopcja terminalna trzyma go przez
synchroniczną pracę (`live_accepted_projection.rs:2984-2999`).

### 4.2 Endpoint wektora pola

**E1 (K). Brak serwerowego budżetu wyświetlania; zawsze f64.**
- `resolve_field_vector_sample_limit` zwraca `None` bez `max_samples`
  (`router_v2/handlers/data/fields.rs:4814-4832`).
- FMVP v2/v3 zapisuje zawsze f64 (`field_store.rs:86-108`). Nie ma f32 ani kwantyzacji
  jednostkowego `m`.

**E2 (W). ETag i cache są sprawdzane po pełnym odczycie wartości pod blokadą odczytu.**
- W `get_field_vector_unfenced` blokada `current_live_state` trwa od :5031 do :5339. W tym czasie
  handler:
  - rozwiązuje wartości;
  - spłaszcza JSON;
  - klonuje wartości (`field.values.clone()`, :5141);
  - ładuje membership FDM (artefakt FMRM czytany z dysku przy każdym wywołaniu,
    `fdm_region_membership.rs:870-883`).
- ETag (:5360) i cache (:5463) dochodzą do głosu dopiero potem. Odpowiedź 304 kosztuje więc tyle
  samo co 200.
- Trafienie w cache kopiuje całe body (`cached.bytes.clone()`, :5466). `BinaryCache` ma
  128 MiB (`quantity_data_plane.rs:33,44`), czyli mieści ~2 wektory po 2 mln komórek.
- Ten sam wzorzec mają `meta` (:3021), `slice/arrows` (:9155) i planar (`planar_fields.rs:499-692`).

**E3 (Ś). Klucz cache zawiera każdy indeks węzła jako tekst** (`fields.rs:4868-4880`).

### 4.3 Endpoint energii i skalarów

- `energies/current` (`router_v2/handlers/simulation/runtime.rs:1882`): w biegu zwraca ostatni
  `ScalarRow`, bo `current_energy_observation` wymaga `E_total` w `latest_fields`, który pojawia
  się dopiero po adopcji terminalnej.
- `energies/history` (:1926) kopiuje wszystkie wiersze fizyczne, a ogon wybiera tylko `limit`.
  Nie ma kursora.
- `tables/default/rows.bin` jest przyrostowe (kursor, `from_row`, decymacja) i to jest dobra ścieżka.
- `scalar_rows` rośnie bez limitu (`session.rs:3260`) i jest czyszczone tylko przy cofnięciu kroku.

### 4.4 Kontrakt próbek: API i renderer wybierają inne komórki

**K1 (K). Dwa różne samplery dla tego samego budżetu.**

| Gdzie | Algorytm | Plik |
|---|---|---|
| API, zakres (warstwa/obiekt/region) | `stride = floor(N / S)`, pozycje `i · stride` dla `i < S` | `fields.rs:4834-4860` (`sample_field_scope`) |
| API, bez zakresu | **ciągłe okno ze środka**: `start = (N − S)/2`, siatka `[S,1,1]` | `fields.rs:4906-4934` (`sample_unscoped_field_values`) |
| Frontend, wyświetlanie FDM | `floor(i · N / S)`, równomierne | `shared/domain/mesh/fdmDisplaySampling.ts:17-33` |
| Frontend, glify FDM | koszyki przestrzenne 3D | `fdmDisplaySampling.ts:42+` (`sampleFdmSpatialCellIndices`) |

- Dla `S < N < 2S` stride po stronie API wynosi 1. API zwraca wtedy **ciągły początek** zakresu,
  a nie próbkę równomierną.
- Przykład: warstwa 250 tys. komórek i budżet 150 tys. API zwraca komórki 0…149 999, a renderer
  chce ~co 1,67 komórki z całej warstwy.
- Przy innych N oba zbiory też się rozjeżdżają, bo `i·floor(N/S)` ≠ `floor(i·N/S)`.
- Warstwy natywne FDM wysyłają `max_samples = FDM_DISPLAY_CELL_BUDGET`
  (`useViewport3DSceneModel.ts:4294`, `viewport3DFieldDataPlan.ts:214-246`).
- Renderer mapuje komórki przez `buildFdmFieldIndexResolver` (`model/fdmFieldIndexing.ts:22-77`).
  Komórka, której nie ma w próbce API, daje `null`, więc kolor jest odrzucany.
- To zgadza się z objawem „odrzucanych kolorów” zgłoszonym w bieżącej pracy nad frontendem.
- Bez zakresu jest gorzej: okno ze środka ma siatkę `[S,1,1]`. Indeksy węzłów trafiają do
  payloadu tylko wtedy, gdy rozwiąże się odcisk siatki (`fields.rs:5276-5306`). W przeciwnym razie
  FMVP v2 nie ma indeksów i renderer nie może poprawnie zmapować próbki.
- Dla FEM `max_samples` bez zakresu też bierze ciągły zakres numeracji węzłów, czyli przestrzennie
  przypadkowy podzbiór.

Wniosek: `max_samples` w obecnej postaci nie nadaje się na budżet wyświetlania. Dlatego frontend
żąda `complete` (E1) i płaci pełnym transferem. Właściwą poprawką jest **jeden deterministyczny
sampler zdefiniowany w kontrakcie** (API zwraca indeksy, renderer ich nie zgaduje) albo
decymacja 3D o stałym kroku z jawną siatką wynikową.

## 5. Konsument: Control Room

### 5.1 Pola

**F1 (K, bez zmian od 25.10). Ciężkie pobranie może być przerywane w nieskończoność.**
- Hooki wektorów pól mają `abortStaleInflight: true` i `minRefetchIntervalMs = fieldSamplePublishMs`
  = 2 s (`modules/viewport-3d/viewport3dResources.ts:1658-1668`,
  `kernel/realtime/communicationPolicy.ts:27,136-138`).
- Odstęp jest liczony od ostatniego **zakończonego** ładowania (`ResourceRuntimeStore.ts:938-947`),
  a nowa rewizja przerywa trwające (:549-556).
- Gdy backend publikuje co krok, a pobranie z dekodowaniem trwa ponad 2 s, viewport może nie
  przyjąć żadnej klatki w biegu.

**F2 (W). Pełna rozdzielczość FDM po kablu.** Główne pole FDM ma zawsze `complete` i
`maxSamples: null` (`viewport3DFieldDataPlan.ts:1401-1433`; cele FDM `forceComplete`, :945, :1017).
Cięcie do 150 tys. komórek odbywa się w przeglądarce. Dla 2,24 mln komórek to ~54 MB f64 na
klatkę zamiast ~1,8 MB (150 tys. × 3 × f32).

**F3 (W).**
- Deadline 30 s (`FIELD_VECTOR_RETRY_POLICY`, `viewport3dResources.ts:691-711`) jest całkowity:
  obejmuje dekodowanie i cały batch kolekcji, a po przekroczeniu żądanie startuje od zera
  (`ResourceRuntimeStore.ts:619-627`).
- Pętla 202/pending ma nadal 5 s (`ControlRoomApi.ts:898,4552`).

**F4 (W).**
- Brak globalnego limitu ciężkich GET. Jedyny limit to 4 współbieżne żądania na hook kolekcji
  (`viewport3dResources.ts:737`).
- Brak pauzy na `document.hidden`.
- Gest kamery (`pauseLoad`) przerywa pobranie i go nie ponawia (`ResourceRuntimeStore.ts:397-414`).

**F5 (Ś). Viewport 3D jako panel towarzyszący w splicie jest zamontowany, ale wstrzymany.**
`createViewport3DInactiveResourcePauseController` sprawdza tylko `activeViewportMainModuleId`
(`kernel/resources/inactiveViewportResourcePolicy.ts:65-90`). Gdy aktywny jest moduł wykresów,
a 3D jest towarzyszem, wektory pól 3D nie odświeżają się. `NOT VERIFIED` w przeglądarce.

**Dobrze:**
- wielkości niewyświetlane nie są pobierane, bo wyłączony hook nie subskrybuje klucza
  (`useResource.ts:113-137`), a wpis bez słuchaczy jest przerywany i usuwany
  (`ResourceRuntimeStore.ts:797-815`);
- wektory i planar są wstrzymywane, gdy ich moduł nie jest aktywny;
- dekodowanie odbywa się w workerze, dane są poza stanem React.

### 5.2 Energie i skalary

| Zasób | Odświeżanie w biegu | Ocena |
|---|---|---|
| Stopka telemetrii | push `scalar.sample` (WS, ~200 ms) + okno 1 wiersza co 1 s | dobrze |
| Wykresy (`rows.bin`) | przyrostowo po kursorze, throttle 1 s (`studyRuntimeResources.ts:2676-2754`) | dobrze, ale kursor jest w kluczu, więc każdy przyrost tworzy nowy wpis bez throttle (`:2694-2705`); prawdopodobnie jedno dodatkowe żądanie na aktualizację, `NOT VERIFIED` |
| `energies/current` | `recommended_fetch` z batcha + wymuszony `refetch()` przy zmianie `scalars_revision`/`fields_revision` w statusie (`studyRuntimeResources.ts:1438-1479`) | podwójna ścieżka; status ma throttle 5 s |
| `energies/history?limit=N` (wykres energii, `limit=800`; Inspector Study, `limit=120`) | **brak**. Batch WS wskazuje tylko `energies/current` (`main.rs:406-415`). Dokładne `invalidate(.../energies/history)` nie trafia w klucze z `?limit=N` (`ResourceInvalidationController.ts:39-47`). Odświeża się tylko przy `hello`, `resync.required`, zmianie runu lub remount | **K2 (W)**: wykres i panel energii prawdopodobnie stoją w biegu, `NOT VERIFIED` w przeglądarce; przy odświeżeniu pobierają całe okno, nie przyrost |

**F6 (Ś). Inspector (panel prawy) ma `suspendWhenHidden={false}`**
(`kernel/layout/WorkspaceDockLayout.tsx:111`). Zasoby energii z Inspectora Study ładują się więc
także przy ukrytym panelu.

## 6. Stan ustaleń z audytu 25.10

| ID | Stan na `abc6f92ce` |
|---|---|
| A1 Study przeładowywane co tick | naprawione (memo `6bd75c040`); zostaje koszt z P1 |
| A2 podwójny klon `m` | naprawione (`081a0b66b`) |
| A3 blokada zapisu przez adopcję | naprawione dla `RwLock` (`adcbc717a`); mutex przejścia nadal trzymany przez synchroniczną adopcję |
| A4 `m` jako JSON w `latest_fields` | **obecne** (P2), dotyczy też wszystkich pól live |
| A5 capabilities dopiero w stanie terminalnym | w większości naprawione (`61ccdd1c5`, `088cb4329`); wymaga istniejącej obserwacji live i zgodnego toru; brak rozróżnienia `planned`/`accepted` dla klienta |
| A6 mutex na każdym zdarzeniu WS | **obecne** (P4) |
| A7 `scalar_rows` bez limitu, pełny batch | **obecne** (P3, 4.3) |
| B1 membership FDM per żądanie | częściowo: ścieżka planu memo (`852da3191`), artefakt FMRM nadal czytany per wywołanie |
| B2 brak budżetu wyświetlania FDM | **obecne** (E1, K1) |
| B3 ETag po odczycie wartości | **obecne** (E2) |
| B4 podwójny SHA odczytu CAS, brak cache zdekodowanych | **obecne** (poza digest cache Airboxa multilayer, `274696e7e`) |
| B5 indeksy w kluczu cache | **obecne** (E3) |
| B6 praca O(N) pod blokadą, JSON `material-fields` | **obecne** |
| C1 pełny katalog na krok | **obecne** (R1–R4) |
| C2 Airbox jako pretty JSON 308 MB | **obecne**, plus druga ewaluacja w ścieżce accepted (R6) |
| C3 polling schedulerów | **obecne**: 10 ms przy aktywnych workerach, 100 ms bezczynnie (`accepted_scheduler_main.rs:918-922, 1731-1735`) |
| D1 abort + throttle od zakończenia | **obecne** (F1) |
| D2 reszta (`pauseLoad` bez ponowienia) | **obecne** (F4) |
| D3 deadline | częściowo: 30 s zamiast 5 s; nadal całkowity; pending 5 s |
| D4 brak globalnego limitu | **obecne** (F4) |
| D5 | discovery złagodzone (wspólny debounce); ramki instancji naprawione; brak pauzy `document.hidden` i `force` przerywający inflight: **obecne** |

Nowe względem 25.10: R2, R3 (zbędny `copy_m` FDM GPU, SHA mapy węzłów FEM co krok), R5, K1, K2,
F5 i F6.

## 7. Projekt docelowy: popyt sterowany przez frontend

Cel: solver liczy i publikuje tylko to, co ktoś ogląda, z kadencją czasową. Frontend dostaje
klatkę w budżecie wyświetlania. Wszystkie elementy są już częściowo w kodzie.

1. **Deklaracja popytu (frontend → API).** Wynik `planViewport3DFieldResourceRequests` oraz
   planar i wykresy składane w jeden `LiveObservationDemand`: lista
   `{quantity_id, scope, completeness, display_budget}` z rewizją. Wysyłany przez istniejące
   `PATCH /visualization/state` (pole już istnieje jako `observation_quantities` w API) albo przez
   nową wiadomość WS klient → serwer. Wymaga zmiany kontraktu OpenAPI (`just docker-dev-codegen`).
2. **Przekazanie API → worker.** Nowy plik sterujący w katalogu próby workera (np.
   `live_demand.v1.json` z rewizją, zapis atomowy) albo wiadomość `worker_inbox`. Worker czyta go
   przy kadencji pól i podaje runnerowi zamiast `DisplaySelectionState::default`. Brak popytu
   oznacza samo `m`.
3. **Runner: kadencja czasowa i podzbiór pól.**
   - `LiveStepConsumer::field_due(step, now)` z minimalnym odstępem (np. 250 ms) na wszystkich
     torach;
   - `capture_*_fields(requested_ids)` zamiast `capture_full_active_*`;
   - wymuszona publikacja przy pauzie, stopie i końcu;
   - budżet liczony per wielkość: przy dużej domenie `m` + wielkość oglądana zamiast
     „wszystko albo `m`”, z jawnym `materialization_reason_code = live_budget_exceeded` dla reszty.
   - Przy okazji usunąć zbędny `copy_m` (R3 GPU), cache'ować tożsamość mapy węzłów FEM
     (raz na generację siatki) i zastąpić drugą ewaluację FDM CPU polami z RHS tam, gdzie
     to możliwe (wymaga noty naukowej, jeśli zmienia się punkt ewaluacji).
4. **API: binarna płaszczyzna live.**
   - `latest_fields` przechowuje referencje `Arc<[f64]>` lub zakresy payloadu f64le zamiast JSON;
   - ETag liczony z (sekwencja, wielkość, zakres, budżet) przed odczytem wartości;
   - `BinaryCache` na `Arc<[u8]>`.
5. **Jeden sampler.** `display_budget` z decymacją 3D o stałym kroku dla FDM i jawnymi indeksami
   dla FEM, w f32 (opcjonalnie oktaedrycznie dla `m`). Renderer używa indeksów z payloadu,
   bez własnego samplera dla danych z serwera. Usuwa to K1, F2 i E1 jednocześnie.
6. **Energie i skalary.**
   - Historia energii jako widok na `rows.bin` (kursor) albo dodanie `energies/history` do batcha
     z inwalidacją po prefiksie;
   - `scalar_rows` z limitem i ogonem w pamięci, pełna historia z trwałego `scalars.csv`;
   - weryfikacja R5 na FDM GPU.
7. **Frontend: polityka ładowania.**
   - „latest-wins po ukończeniu” dla ciężkich zasobów, throttle od startu ładowania;
   - globalny semafor binarnych GET (1–2 sloty);
   - pauza na `document.hidden`;
   - ponowienie po `pauseLoad`;
   - poprawka F5 (towarzysz splitu).

## 8. Plan naprawczy (kolejność)

| # | Zakres | Ustalenia | Ryzyko | Uwagi |
|---|---|---|---|---|
| 1 | API + frontend | K1, E1, F2: jeden sampler i `display_budget` w f32 | średnie | naprawia odrzucane kolory i 20–30× nadmiar transferu; kontrakt OpenAPI |
| 2 | Frontend | K2: odświeżanie historii energii w biegu | niskie | szybka poprawka widocznego błędu |
| 3 | Worker + runner | R1, R2: kadencja czasowa pól, nagłówek skalarów niezależny od pól | średnie | największy zysk dla solvera; dotyka wszystkich torów; wymaga testów runtime |
| 4 | API → worker → runner | sekcja 7 pkt 1–3: popyt z UI i podzbiór pól, budżet per wielkość | wysokie | właściwa realizacja „frontend decyduje”; ADR i zmiana kontraktu workera |
| 5 | Runner | R3, R4: zbędny `copy_m`, SHA mapy węzłów FEM, łańcuch kopii | niskie–średnie | lokalne |
| 6 | API | P2, E2, A4/B3/B4: binarne `latest_fields`, ETag przed odczytem | średnie | ogranicza RSS i czas pod blokadą |
| 7 | Frontend | F1, F3, F4, F5, F6 | średnie | wymaga dowodu z przeglądarki |
| 8 | Platforma | P1, P3, P4, R6, C3 | niskie–średnie | porządkowe i wydajnościowe |

Kroki 3 i 4 dotyczą fizyki obserwacji tylko w zakresie punktu ewaluacji pól (R3, FDM CPU).
Zmiana tego punktu wymaga noty w `docs/physics/`. Sama zmiana kadencji i podzbioru nie zmienia
fizyki.

## 9. Ograniczenia i `NOT VERIFIED`

- Brak pomiarów runtime w tym audycie. Liczby rozmiarów są wyliczone z kształtów danych,
  a pomiary z 25.10 pochodzą ze starszej bazy.
- R5 (energie FDM GPU między krokami skalarnymi), F5 (towarzysz splitu), K2 (stojący wykres
  energii) i dodatkowe żądanie `rows.bin` wynikają z odczytu kodu i wymagają potwierdzenia
  w przeglądarce oraz w biegu GPU.
- K1 jest potwierdzone porównaniem obu algorytmów w kodzie. Skala braków na konkretnej
  geometrii nie była mierzona.
- Testy jednostkowe nie były kompilowane ani uruchamiane (obowiązujący zakaz).

## 10. Stan poprawek (branch `codex/live-quantity-refresh-20261029`)

Baza: `origin/master` `4b60cdbfa`. R1 i R2 (kadencja czasowa pól live, drugi throttle workera)
realizuje osobny, otwarty PR #270 (`claude/awesome-mayer-5cef23`); tutaj ich nie powtarzam.

| ID | Zmiana | Pliki |
|---|---|---|
| K1, E3 | Jeden sampler `floor(i·N/S)` w API dla zakresu i bez zakresu (zamiast `i·floor(N/S)` i okna ze środka), zgodny z `sampleFdmDisplayCellIndices`; klucz cache indeksów jako SHA-256 zamiast tekstu | `router_v2/handlers/data/fields.rs`, testy w `router_v2/tests.rs` |
| K2 | Zmiana skalarów inwaliduje prefiks `energies/history` (klucze z `?limit=`); throttle 1 s; inwalidacje po restore i mutacjach authoringu też po prefiksie | `RealtimeInvalidationBridge.ts`, `studyRuntimeResources.ts`, `studyRuntimeCommandContributions.ts`, `authoringMutationInvalidation.ts` |
| F1 | Wektory pól: nowsza rewizja czeka na trwające pobranie zamiast je przerywać | `viewport3dResources.ts` |
| F4 | Pauza predykatowa zapamiętuje przerwane pobranie i odtwarza je po zwolnieniu pauzy; ukryta karta przeglądarki wstrzymuje płaszczyznę danych (`/data/`) | `ResourceRuntimeStore.ts`, `hiddenInstanceTabResourcePolicy.ts`, `KernelProvider.tsx` |
| F5 | Viewport 3D i mapa pól jako panel towarzyszący splitu nie są wstrzymywane | `inactiveViewportResourcePolicy.ts` |
| P3 | Projektor publikuje batch `_since`: tylko zmienione zasoby i wielkości | `live_accepted_projection.rs`, `main.rs` |
| R3 | FDM GPU: `copy_m` dla checkpointu FrozenSpins tylko przy planie z FrozenSpins; FEM: tożsamość mapy węzłów cache'owana po rewizji natywnej mapy | `fdm/gpu/cuda/execute.rs`, `native_fem.rs`, `fem/relax/preview.rs` |
| 7.1–7.3 | Popyt: `observation_quantities` stanu wizualizacji + wielkości odczytane w ostatnich 15 s → `runs/<run>/live_demand.v1.json` → worker (co ≤250 ms) → runner zachowuje w przechwytywaniu live tylko `m` i te wielkości (FDM CPU/GPU, FEM CPU/GPU, multilayer); pakiety terminalne bez zmian. Kontrakt: ADR 0075 | `live_field_demand.rs`, `accepted_live_demand.rs`, `accepted_study_worker.rs`, `live_accepted_projection.rs`, `fullmag-runner/src/live_demand.rs` + miejsca przechwytywania |
| R5 | Potwierdzone w biegu (FDM GPU, `fm.run`, grupa DEV tego worktree, build przed poprawką): wiersze skalarów live miały `e_*`, `max_torque`, `max_h_eff` równe 0 przy poprawnych `mx/my/mz`. W polityce `Requested` krok natywny nigdy nie wypełnia diagnostyk (`fullmag_fdm_should_fill_step_stats_for_step` wymaga trybu `FULL`), więc zmiana stride nie pomaga. Poprawka: pod konsumentem live runner robi `snapshot_step_stats` co ≥250 ms, pozostałe kroki oznacza jako niefizyczne (`LegacyUnclassified`), a worker wpisuje do nagłówka ostatnie fizyczne statystyki | `fdm/gpu/cuda/execute.rs`, `accepted_study_worker.rs` |
| — | Miganie pól live (zmierzone: `m` i `H_demag` zwracały 204 w ~60% z 20 odczytów co 0,5 s). Worker podmienia ładunek na każdym kroku; projektor, który przeczytał nowy nagłówek, a nie zdążył z ładunkiem, uznawał wyświetlane `m` za nieaktualne i usuwał wszystkie pola live. Teraz pola są usuwane tylko przy zmianie tożsamości obserwacji (inne zadanie lub próba) | `live_accepted_projection.rs` |
| — | Projektor nie podbija rewizji skalarów dla wiersza identycznego z ostatnim (nagłówek powtarza ostatnie fizyczne statystyki) | `live_accepted_projection.rs` |
| — | Szybki bieg (koniec przed pierwszym tickiem projektora) dawał 0 wierszy skalarów: worker kasował nagłówek live w `finish()`, zanim projektor odczytał statystyki końcowe. Teraz zostaje nagłówek tylko ze statystykami ostatniego kroku; kasowany jest ładunek pól | `accepted_study_worker.rs` |
| R6 | Wartości pól Airboxa zapisywane jako zwarty JSON zamiast `to_vec_pretty` (manifest bez zmian) | `fdm/cpu/airbox_observation.rs` |
| B4 | Cache zdekodowanych, zweryfikowanych wartości binarnych pól CAS (klucz: skrót wartości, 256 MiB) | `accepted_field_binary.rs` |
| F6 | Historia energii Inspectora Study ładuje się tylko przy widocznym Inspectorze | `StudyInspectorPanel.tsx` |

Nie zrobione w tym branchu, z powodem:

- **Budżet per wielkość dla dużych domen.** Gdy pełna generacja nie mieści się w 128 MiB,
  worker nadal wybiera „samo `m` co 100 kroków”. Przełączenie na kadencję 1 + popyt wymaga
  kadencji czasowej z PR #270; bez niej `m` byłoby kopiowane na każdym kroku.
- **P2/A4, E2/B3** (binarne `latest_fields`, ETag przed odczytem wartości). Refaktor ścieżki odczytu pól w `fields.rs` i `session.rs`; wymaga osobnego PR
  z testami regresji API.
- **F2/E1** (budżet wyświetlania dla głównego pola FDM). Po K1 serwerowa próbka pokrywa się
  z próbką wyświetlania, ale glify FDM używają koszyków przestrzennych
  (`sampleFdmSpatialCellIndices`), więc frontend musi najpierw brać indeksy z odpowiedzi API.
- **P4** (mutex przejścia na każdym zdarzeniu WS): mutex chroni przed wysłaniem zdarzenia
  w trakcie przejścia sesji; zdjęcie go wymaga osobnej analizy.
- F3, P1, R4, C3: bez zmian.

### Dowody runtime (29.10.2026)

Grupa weryfikacyjna `live-quantity-refresh-verify-20261029`, commit `69e5afbe9`, FDM GPU, pasek
400×100×5 nm (1600 komórek), `fm.run(1 ns)`, w trakcie biegu `active_quantity_id = H_demag`:

- `runs/<run>/live_demand.v1.json` = `["H_demag","m"]` (z odczytem `H_ex` przez endpoint
  pojawiło się też `H_ex` i wypadło po 15 s);
- nagłówki workera niosły `m` + `H_demag` albo samo `m`, nigdy pełnego katalogu;
- do API trafiło 467 wierszy skalarów, z czego 277 nadal z zerowymi `E_*` i momentem. Źródło:
  aktualizacja live wysyłana przed krokiem z `current_stats` poprzedniego kroku. Poprawka:
  `072626847`; jej weryfikacja runtime: NOT VERIFIED (przebudowa odrzucona, dysk C: < 32 GiB);
- na magazynie w folderze Windows projektor często odkłada projekcję („session read transaction
  requires no active store writer”); pierwsze ~4400 kroków nie zostało zprojektowanych. Worker
  zapisuje ładunek i nagłówek na każdym kroku (~10 kroków/s); kadencję czasową wnosi PR #270.

