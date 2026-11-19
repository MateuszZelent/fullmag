# Audyt komunikacji Control Room ↔ API (FEM i FDM)

Data: 25.10.2026. Branch: `codex/control-room-comm-audit-20261025`, baza `f08fc7755` (master).
Pary przykładów: `examples/permalloy_layer_cofeb_rings_relax_300nm.py` (FEM) i
`examples/permalloy_layer_cofeb_rings_relax_300nm_fdm.py` (FDM, multilayer CPU, 2,24 mln komórek
widoku, 3,45 mln komórek universe). Koordynacja: branch `codex/viz-parity-20261025`
(commity `1166e0073`, `9cae041ca`, `e44ac16e1`, `b015145ef`, `040a11b5f`) – tych poprawek tu nie powtarzam.

## Werdykt

**Komunikacja nie jest gotowa produkcyjnie.** Ruch API i obserwacji spowalnia solver, pamięć API
nie jest ograniczona, a kadencja odświeżania wynika z kosztu ticka, nie z polityki. Największe koszty
nie leżą w samym UI, tylko w trzech miejscach:

1. Projektor API na każdym ticku aktywnego zadania od nowa ładuje, waliduje i obniża (lowering)
   cały niezmienny katalog Study (zmierzone: ~21 MB/s odczytu z 9p, ~68% rdzenia).
2. Worker prosi runner o pełny katalog pól na **każdym** kroku solvera, choć API czyta co 500 ms.
3. Po ostatnim kroku FDM multilayer worker przez ~18 min liczy pola docelowe Airboxa na siatce
   3,45 mln komórek i zapisuje je jako 308 MB JSON (`to_vec_pretty`).

Do tego dochodzą: dane pól jako JSON per komórka w `LatestFields`, brak serwerowego budżetu
wyświetlania dla FDM (pełne 54–84 MB f64 na żądanie), ciężka praca pod blokadą `current_live_state`,
oraz brak priorytetu żądań ciężkich w przeglądarce.

## Pomiary (grupa DEV `viz-parity-20261025`, port 3258, tylko odczyt)

Stan: przebieg FDM twin, `solver.state=running`, solver skończył 10 kroków o 19:32, worker nadal
żywy o 19:53. Kontener backendu: 4 CPU (cpuset), limit 8 CPU, 32 GiB.
Metoda: `/proc/<pid>/stat` (utime+stime) i `/proc/<pid>/io` w odstępie 5–10 s.

| Proces | CPU (10 s) | Odczyt | RSS | Uwagi |
|---|---:|---:|---:|---|
| `fullmag-api` | 68% rdzenia (43% sys) | 20,8 MB/s, 51 GB w 37 min | 3,1 GB | czyta w kółko jeden obiekt CAS 41 MB |
| `fullmag-api-accepted-worker` | 118% (47% sys) | — | 0,83 GB | wątek w stanie D, `p9_client_rpc` |
| `fullmag-api-accepted-scheduler` | 19% (80% sys) | 0,8 MB/s | 88 MB | polling store na 9p |
| `…-fem-preparation-scheduler` | 8% (80% sys) | 0,35 MB/s | 18 MB | polling przy sesji FDM |
| `fullmag-runtime-service` | 1% | — | 0,3 GB | |

- Obiekt czytany przez API: `objects/sha256/fbf52811…` (41 383 027 B) = `study_catalog_object_ref`
  z `run_intent.json`. Otwarty w 10 z 40 próbek co 100 ms.
- `/state` to bind mount `E:\` przez 9p (`drvfs`, `cache=0x5`). Każdy odczyt i zapis store przechodzi
  przez 9p.
- Płaszczyzna sterowania (API + schedulery) zużywa ~0,95 rdzenia z 4 podczas pracy solvera.
- Artefakty workera: `m_final.json` 3,4 MB i `m_initial.json` 1,8 MB (JSON), pola obserwacji
  w f64le (961 200 B = 40 050 komórek × 3 × 8). Następnie `fields/H_demag/airbox/H_demag.samples.v1.json`
  = **307 944 805 B** (19:50:11), potem `H_eff` w toku.
- Supervisor zgłaszał `Runtime observation degraded … live_probe_failed`. Odzyskiwał po 4 s i 9 s.
- `GET /v2/sessions/current/status`: 11,6 kB, 87 ms. `GET /v2/platform/instances`: 20 ms.
  Podczas biegu `capabilities.active_lane.resolved = null`,
  `source.kind = unavailable`, a operacje mają stan `stale`.

Nie mierzyłem (`NOT VERIFIED`): przeglądarki (liczba połączeń, czasy żądań wektorowych), biegu FEM
oraz kosztu pojedynczego żądania pola. Szacunki dla tych ścieżek pochodzą z odczytu kodu.

## Ustalenia

Ważność: K – krytyczna, W – wysoka, Ś – średnia, N – niska. „Zmierzone” oznacza pomiar powyżej.
„Kod” oznacza odczyt źródeł; ścieżki są względem repozytorium.

### A. Backend: projektor i sesja

**A1 (K, zmierzone, naprawione tutaj). Każdy tick aktywnego zadania ponownie ładuje Study.**
- `crates/fullmag-api/src/live_accepted_projection.rs`: skrót „bez zmian” działa tylko bez aktywnego zadania
  (`durable_unchanged && !has_active_task && …`). Przy zadaniu `Running`/`Stopping` każdy tick
  wywołuje `fullmag_runtime_control::load_accepted_study_snapshot`. Ta funkcja
  (`crates/fullmag-runtime-control/src/study.rs:3248–3324`) wykonuje kolejno:
  - odczyt katalogu i Study z CAS z weryfikacją SHA,
  - `serde_json::from_slice` i ponowne `to_value` z `canonical_json_sha256`,
  - strumieniowe hashowanie assetów,
  - `lower_study_plan_with_catalog`.
- Interwał ma `MissedTickBehavior::Delay`, więc tick trwa ~2 s, a nie 500 ms. Opóźnia to także
  publikację pól i postępu.
- Dla FEM katalog zawiera siatkę (~93 MB IR dla 1,09 mln komórek), więc koszt jest większy.
- Poprawka: `cached_accepted_study_snapshot` memoizuje `Arc<AcceptedStudySnapshot>` w pętli
  projektora, z kluczem równym zwalidowanemu `FmsRunIntent`. Wszystkie referencje intentu są
  hashami CAS, więc snapshot jest czystą funkcją intentu. Cache jest zwalniany po zakończeniu
  projekcji runu.

**A2 (K, kod, naprawione tutaj). Kwalifikacja `m` klonowała cały payload dwa razy.**
- `registered_latest_field_replay_frame` (`crates/fullmag-api/src/session.rs`) wykonywał
  `stored.clone()` i `incoming.clone()` (z tablicą `values`), żeby porównać wartość samą ze sobą.
- Wywołują go `latest_field_source_is_qualified` dla `m` i ścieżki: katalog pól (≥3×), wektor (≥3×),
  `solver/energies/current` (zalecany przez każdy batch realtime) i każdy tick skalarów.
- Przy 2,24 mln komórek zagnieżdżony JSON to ~320 MB na kopię.
- Poprawka: skrót `std::ptr::eq(stored, incoming)` oraz porównanie map bez klonowania
  (`payloads_equal_except_observation_frame`).

**A3 (K, kod). Adopcja terminalna trzyma blokadę zapisu przez ciężką pracę.**
- `crates/fullmag-api/src/accepted_field_materialization.rs`: `current_live_state.write()` jest trzymane od
  odczytu `m` do `*snapshot = next`. W tym czasie działają:
  - `snapshot.clone()`,
  - `apply_current_live_accepted_field_frame` (kolejny klon i hashowanie źródeł),
  - `resolve_current_spatial_field_metadata` dla każdego wymagania.
- `tokio::RwLock` jest sprawiedliwy, więc w kolejce stoją `/v2/platform/health` (`system.rs:35`)
  i status (4 odczyty blokady).
- To najprawdopodobniejsza przyczyna przekroczeń czasu `health`/`status` i komunikatu
  „Runtime state is unavailable”. `clear_stale_magnetization` ma ten sam wzorzec.
- Naprawa: budować `next` poza blokadą (jak w `apply_projection`), a pod blokadą zapisu wykonywać
  tylko `mem::replace` po sprawdzeniu fence.

**A4 (W, kod). `m` trafia do `latest_fields` jako zagnieżdżony JSON.**
- Ścieżka live: `read_live_magnetization` → `Vec<[f64;3]>` → `json!({"values": values})`
  w `apply_projection`.
- Ścieżka terminalna: `load_verified_outputs` hashuje CAS, a potem `decode_study_artifact` hashuje
  i parsuje JSON drugi raz. Do tego dochodzi kilka kopii `m`.
- Szczyt pamięci przejściowej: ~1,3–1,5 GB przy 2,24 mln komórek. Zmierzony RSS API to 3,1 GB.
- Naprawa: przechowywać `m` jako `accepted_binary_field` z `AcceptedFieldReader`. Infrastruktura
  już istnieje dla pól H. Alternatywnie `Arc<[f64]>`. Stan dekodować raz i współdzielić z adopcją.

**A5 (W, kod i zmierzone). Capabilities runtime powstają dopiero przy stanie terminalnym.**
Właściciel naprawy: branch `codex/viz-parity-20261025`, w toku. Tutaj tylko opis.
- `resolved_capabilities` i `accepted_runtime_capabilities` są liczone wyłącznie dla
  `completed|failed|cancelled` (`live_accepted_projection.rs`, `load_durable_projection` i `poll_once`).
- W biegu `resolved_quantity_capability_for_snapshot` zwraca `runtime_capabilities_unavailable`
  (`router_v2/handlers/data/quantities.rs:262–305`), a `get_field_vector` odrzuca każde pole poza
  przygotowanym `m`.
- Wynik: czarny viewport w biegu.
- Projekt docelowy: capabilities wynikają z planu, nie ze stanu.
  - `ensure_stage_preparation_for_step` ma już przygotowany `ExecutionPlanIR`. Należy wtedy publikować
    `resolve_planned_runtime_capabilities(problem, plan)` z kwalifikacją `planned`.
  - Przy stanie terminalnym potwierdzać je provenance (`accepted`).
  - UI bramkuje żądanie pola na liniach danych (to robi już `040a11b5f`) oraz na `planned|accepted`.
    Nie bramkuje na samym `accepted`.

**A6 (Ś, kod). Każde zdarzenie WS i heartbeat bierze mutex przejścia sesji.**
- `current_live_realtime_ws_scope_active` (`main.rs:5231`). `apply_projection` trzyma ten mutex
  przez zapis dziennika i adopcję terminalną, więc w tym czasie WS stoi.
- Naprawa: sprawdzać zakres przez atomiki (epoka i id sesji).

**A7 (Ś, kod).**
- `scalar_rows` rośnie bez limitu (`upsert_scalar_row`), a każdy klon snapshotu kopiuje wszystkie wiersze.
- Każdy zmieniony tick publikuje pełny batch zasobów (`publish_current_live_realtime_batch_changed`)
  zamiast wariantu `_since`.

### B. Backend: endpointy pól

**B1 (K, kod, częściowo naprawione tutaj). Członkostwo FDM ładowane per pole i żądanie.**
- `resolve_spatial_field_metadata` woła `load_resolved_fdm_membership` dla każdego pola FDM
  (`resolved_spatial_field.rs:2361`): katalog pól, katalog wielkości, meta, wektor i odświeżenie
  bundli na ścieżce zapisu.
- Bez artefaktu `resolved_membership_from_execution_plan` robił `serde_json::from_value(plan.clone())`
  całego planu (`initial_magnetization`, maski per komórka).
  - Poprawka tutaj: użycie memo `SharedJson::execution_plan()`.
- Ścieżka artefaktu nadal czyta i kopiuje FMRM (~5 kopii) przy każdym wywołaniu.
  - Do zrobienia: memo `Arc<ResolvedFdmMembership>` z kluczem
    (generacja domeny, rewizja membership, digest artefaktu) oraz leniwe ładowanie tylko dla zakresów.

**B2 (K, kod). Brak serwerowego budżetu wyświetlania FDM.**
- `resolve_field_vector_sample_limit` zwraca `None` bez `max_samples` (`fields.rs:4740`).
- Główny viewport wysyła `completeness: "complete", maxSamples: null`
  (`viewport3DFieldDataPlan.ts:1383–1414`) i dopiero w przeglądarce tnie do
  `FDM_DISPLAY_CELL_BUDGET = 150 000` (`fdmDisplaySampling.ts:1`).
- Koszt: 53,8 MB (2,24 mln komórek) do 84 MB (3,5 mln) f64 na żądanie, czyli ~23× nadmiarowy transfer.
- Uwaga: niezakresowany `max_samples` bierze ciągłe okno ze środka (`fields.rs:4848`), nie
  równomierną decymację.
- Naprawa:
  - parametr `display_budget` z decymacją 3D o stałym kroku (regularna siatka, bez tablicy indeksów),
  - kodowanie f32 (oraz i16/octahedral dla jednostkowego `m`),
  - `complete` tylko dla eksportu i sond.
  - Przykład: 3,5 mln → 262 tys. w f32 to ~3 MB.

**B3 (W, kod). ETag i cache są sprawdzane dopiero po pełnym odczycie wartości pod blokadą odczytu.**
- `get_field_vector_unfenced` kolejno:
  - czyta i klonuje wartości,
  - rozwiązuje zakres,
  - zwalnia blokadę,
  - liczy ETag i sprawdza cache.
- 304 i trafienie w cache płacą więc pełny koszt. Trafienie kopiuje dodatkowo 84 MB (`cached.bytes.clone()`).
- Naprawa: ETag i klucz z metadanych przed odczytem wartości, `Arc<[u8]>` w `BinaryCache`.

**B4 (W, kod). Odczyt binarnego CAS przy każdym żądaniu, pod blokadą, z podwójnym SHA-256.**
- `AcceptedFieldReader::read_values` (`accepted_field_binary.rs:118`) hashuje strumień, choć
  `get_bounded` zweryfikował już każdy chunk.
- Nic nie cache'uje zdekodowanych wartości.
- Naprawa: `OnceLock<Arc<[f64]>>` per referencja, pierwsze dekodowanie w `spawn_blocking` poza blokadą.

**B5 (W, kod). Klucz cache zawiera każdy indeks węzła jako tekst.**
- `field_node_indices_cache_token` (`fields.rs:4795`): dla warstwy 1,75 mln komórek to ~13 MB klucza.
- Naprawa: digest 64-bit albo zakres.

**B6 (Ś, kod).**
- `fields/:q/meta`, slice, arrows i planar trzymają blokadę przez pracę O(N).
- `fdm_multilayer_layout_resource` przelicza maski i certyfikaty per żądanie.
- `material-fields/:id` zwraca duże `values` w JSON (narusza doktrynę binary data plane).
- Budżet `BinaryCache` (128 MiB) mieści jedno duże pole.

### C. Worker i runner (wpływ na solver)

**C1 (K, kod). Pełny katalog pól na każdym kroku.**
- `ACCEPTED_LIVE_FIELD_EVERY_N = 1` i `ACCEPTED_LIVE_FIELD_MIN_INTERVAL = Duration::ZERO`
  (`accepted_study_worker.rs:49–51`, od `4520fa8b9`).
- Gdy domena mieści się w budżecie, runner na każdym kroku:
  - kopiuje `m` (dla GPU: device→host),
  - wywołuje `capture_full_active_cpu_fields` / `live_fields_from_observables`, czyli wylicza wszystkie
    pola obserwacji (`fdm/cpu/reference.rs:2566`, `fdm/cpu/multilayer_reference.rs:486`).
- Worker następnie na każdym kroku:
  - klonuje pola (`capture_solver_observables`),
  - koduje bajty, liczy SHA-256,
  - zapisuje plik do 128 MB przez 9p.
- API odczytuje najwyżej 2 próbki/s. Dla FEM 183 702 węzłów to ~30–40 MB zapisu i hashowania na krok.
- Naprawa:
  - kadencja czasowa w runnerze (`LiveStepConsumer::field_due(step, now)`, np. ≥250 ms) we wszystkich
    backendach (FDM CPU/GPU, multilayer CPU/GPU, FEM CPU/GPU),
  - wymuszona publikacja przy pauzie, stopie i finiszu,
  - docelowo publikacja na żądanie (subskrypcja widoku).
- Nie wdrażam tutaj. Zmiana dotyka ~15 miejsc runnera w każdym backendzie i wymaga testów runtime,
  których obecnie nie wolno kompilować.

**C2 (K, zmierzone). Worker żyje ~20+ min po ostatnim kroku (FDM multilayer).**
- `materialize_airbox_observation` (`fullmag-runner/src/fdm/cpu/airbox_observation.rs`) liczy
  `H_demag`/`H_eff` na docelowej siatce 3,45 mln komórek osobną wyrocznią konwolucji, z nowymi
  kernelami (`compute_shifted_kernel`).
- Zapisuje wynik jako `serde_json::to_vec_pretty` (308 MB) i hashuje go.
- Zmierzona oś czasu:
  - 19:14 start,
  - 19:32 koniec kroków,
  - 19:50 pierwszy plik Airboxa,
  - po 19:53 nadal `H_eff`.
- Przez cały ten czas zadanie ma stan `Running`, więc projektor (A1) i schedulery dalej pracują.
- Naprawa:
  - binarne f64le w CAS zamiast JSON (API ma już ścieżkę `accepted_binary_field` dla Airboxa),
  - bez `pretty`,
  - kernel liczony raz i cache'owany per (geometria, siatka docelowa),
  - obserwacja Airboxa leniwie na żądanie zamiast przy każdym zakończeniu,
  - osobny stan zadania „materializacja obserwacji”, żeby UI nie pokazywał biegu solvera.

**C3 (Ś, zmierzone). Store na 9p i polling schedulerów.**
- Schedulery zużywają 19% i 8% CPU, głównie na syscalle, także przy sesji, która nie używa FEM.
- Naprawa: zdarzeniowe budzenie (inotify nie działa na 9p, więc dziennik lub kanał od API)
  i backoff przy braku pracy. Sam store dobrze byłoby trzymać na ext4 (WSL), zgodnie z AGENTS.md.

### D. Frontend

Ustalenia z odczytu kodu w `apps/control-room/src`. Przeglądarką ich nie weryfikowałem.

**D1 (K, kod). Ciężkie pobranie pola może być przerywane w nieskończoność.**
- `abortStaleInflight: true` i `minRefetchIntervalMs = fieldSamplePublishMs` (2 s)
  (`viewport3dResources.ts:1639–1646`).
- Odstęp liczony jest od ostatniego **zakończonego** ładowania (`ResourceRuntimeStore.ts:938–946`).
- Gdy pobranie i dekodowanie 54–84 MB trwa dłużej niż 2 s, każda nowa rewizja przerywa transfer.
  Viewport może wtedy nie przyjąć żadnej klatki w trakcie biegu.
- Naprawa: „latest-wins po ukończeniu” dla zasobów ciężkich, throttle liczony od startu ładowania
  i skalowany czasem ostatniego ładowania.

**D2 (W, kod, naprawione tutaj). Dołączanie do przerwanego współdzielonego pobierania.**
- `loadCachedBinaryResourceEntry` dołączał do wpisu inflight, którego kontroler był już przerwany
  (wpis znika dopiero w `finally`).
- Nowe ładowanie dostawało cudzy `AbortError`, a store kończył bez ponowienia.
- Poprawka: nie dołączać do wpisu z `controller.signal.aborted`. Dodany test regresyjny.
- Pozostaje: przerwanie w trakcie `pauseLoad` (gest kamery) nie zapisuje `pendingRequest`
  (`ResourceRuntimeStore.ts:397–414`, `:768–777`), więc przerwane pobranie wraca dopiero
  z następną inwalidacją.

**D3 (W, kod). Deadline 5 s dla pól jest za krótki na pełny payload.**
- `FIELD_VECTOR_RETRY_POLICY = {deadlineMs: 5_000, maxAttempts: 5}` (`viewport3dResources.ts:691`).
- Timeout przerywa żądanie i startuje od zera z oknem 5, 10, … 25 s, czyli ~76 s i 5 pełnych restartów.
- Deadline obejmuje dekodowanie, a w kolekcjach (Airbox, części, warstwy) cały batch.
- Naprawa: timeout bezczynności (od ostatniego bajtu) albo deadline wyliczony z `Content-Length`,
  per żądanie. Po B2 problem w dużej mierze zniknie.

**D4 (W, kod). Brak globalnego limitu i priorytetu żądań ciężkich.**
- Jedyny limit to `VIEWPORT_3D_FIELD_REQUEST_CONCURRENCY = 4` per hook (`viewport3dResources.ts:731`).
- Niezależne hooki działają równolegle: pole główne, Airbox, części, warstwy, topologia, membership.
- Przy HTTP/1.1 (6 połączeń na origin, Next rewrite `/v2`) lekkie żądania `health`/`status` czekają
  w kolejce przeglądarki.
- Naprawa:
  - semafor jądra dla binarnych GET (1–2 sloty), co rezerwuje ≥3 połączenia dla płaszczyzny sterowania,
  - krótki timeout dla `health`/`status`,
  - docelowo HTTP/2 albo osobny origin danych.

**D5 (Ś, kod).**
- `refetch()` z `force` omija single-flight i przerywa trwające żądanie (`ResourceRuntimeStore.ts:519–527`).
- `useInstanceDiscovery` jest zamontowany 3× (każdy z własnym `visibilitychange`). Jeden fokus karty
  daje 3 żądania, z których 2 są przerywane, a serwer i tak sonduje 64 porty.
- Ukryta karta nadal pobiera ciężkie dane: store nie ma pauzy na `document.hidden`.
- Ramki zakładek instancji pracują w tle.
- `fieldVectorCache` ma 128 MiB, więc drugie duże pole wypiera pierwsze razem z jego ETagiem.

**Zgłoszenie „~2 req/s `instances` + `health` przy ukrytej karcie” nie potwierdza się na `master`.**
Discovery działa co 5 s, tylko gdy karta jest widoczna (`instanceDiscoveryResources.ts:51–55`).
Health jest odpytywany zdarzeniowo, a co 5 s tylko w stanie degraded. Prawdopodobne źródła
zaobserwowanego ruchu:
- starszy build,
- zamontowane ramki instancji,
- duplikaty z D5.

## Co jest dobrze (nie przerabiać)

- Projektor:
  - praca store i CAS w `spawn_blocking`,
  - stop po projekcji terminalnej,
  - odczyt payloadu live tylko przy zmianie sekwencji,
  - ograniczone rozmiary nagłówka (256 KB) i payloadu (128 MB).
- Snapshot: końcowa podmiana to krótkie `mem::replace`, a stary snapshot jest zwalniany
  w `spawn_blocking`. `SharedJson` daje tanie klony i memo planu.
- Realtime:
  - zdarzenia serializowane raz,
  - ograniczony bufor replay z resynchronizacją,
  - koalescencja batchy,
  - brak pollingu per połączenie.
- Wektory pól:
  - wersjonowany binarny FMVP z nagłówkami tożsamości, silnymi ETagami, Range i semantyką 202/204,
  - topologia FMMT z `Arc<[u8]>`,
  - maski bit-packed.
- Frontend:
  - dekodowanie zero-copy w workerze,
  - dane poza stanem React (`useSyncExternalStore`),
  - LRU z budżetem bajtowym,
  - single-flight per (klucz, rewizja),
  - frameloop `demand`,
  - timery bramkowane widocznością.

## Plan naprawczy (priorytet)

| # | Zakres | Ustalenia | Ryzyko | Uwagi |
|---|---|---|---|---|
| 1 | API | A1, A2, B1 (plan) | niskie | **zrobione w tym PR** |
| 2 | Frontend | D2 | niskie | **zrobione w tym PR** |
| 3 | API | A3: adopcja i `clear_stale_magnetization` poza blokadą zapisu | średnie | usuwa przyczynę timeoutów `health` |
| 4 | Runner i worker | C1: kadencja czasowa pól live, wymuszona publikacja przy pauzie i stopie | średnie | największy zysk dla solvera; wymaga testów runtime FDM/FEM CPU/GPU |
| 5 | Runner | C2: Airbox binarnie, bez `pretty`, cache kernela, leniwie | średnie | skraca życie workera o ~20 min |
| 6 | API i frontend | B2 + D3: `display_budget` z decymacją 3D i f32 | średnie | kontrakt OpenAPI; usuwa 23× nadmiar |
| 7 | API | A5: capabilities z planu przy przygotowaniu etapu | średnie | w toku na `codex/viz-parity-20261025` |
| 8 | API | A4 + B3 + B4: `m` binarnie, ETag przed odczytem, cache zdekodowanych wartości | średnie | ogranicza RSS API |
| 9 | Frontend | D1, D4, D5: latest-wins, semafor ciężkich żądań, pauza na ukrytej karcie, jedno discovery | średnie | dowód przeglądarkowy wymagany |
| 10 | Platforma | C3, A6, A7, B5, B6 | niskie–średnie | porządkowe |

Kolejność 3→4→5 daje największy efekt dla stabilności UI i czasu solvera. Kroki 6–8 to jeden spójny
kontrakt danych pól i powinny trafić do jednego planu (OpenAPI + typy frontendu).

## Weryfikacja zmian w tym PR

- `just check-api-service-source`: `passed` (cargo check produkcyjnych binarek API, bez testów,
  3 min 27 s). Nowych ostrzeżeń brak; ostrzeżenia w `session.rs:690` i `:2649` istniały wcześniej.
- Kontener frontendu grupy `fullmag-worktree-backend-api-docker-stability-383-bd9c800c01f1fa40`:
  - vitest `viewport3dResources.test.ts`: 67/67 testów przeszło;
  - nowy test bez poprawki kończy się błędem (sprawdzone);
  - `eslint --max-warnings=0` na zmienionych plikach: exit 0;
  - `pnpm run typecheck`: exit 0.
- Test Rust `replay_payload_comparison_ignores_only_the_observation_frame` jest dopisany w źródle,
  ale **nie został skompilowany** z powodu obowiązującego zakazu: `NOT VERIFIED`.
- Pomiar CPU i I/O projektora po poprawce A1 w trakcie biegu: `NOT VERIFIED`.
  Grupa DEV tego worktree zbudowała się i wystartowała, ale nie przyjęła skryptu pomiarowego
  (blokada opisana niżej). Wartości wyjściowe (przed poprawką) pochodzą z grupy `viz-parity`.

### Usterki napotkane przy weryfikacji (poza zakresem)

- `examples/permalloy_box_relax_300x1000x10nm_fdm.py` na `master` nie przechodzi walidacji
  skryptu: `ValueError: LLG relaxation requires an explicit fixed or complete adaptive timestep policy`.
- Po tym odrzuceniu grupa DEV zostaje zablokowana:
  - każde następne `run-script` kończy się `activation_outcome_unknown`, a wewnętrznie
    `ControlOutcomeUnknown: startup activation outcome is unknown; canonical marker/quarantine
    reconciliation is required`;
  - `just docker-dev … <script>` zwraca „Existing DEV operation is active”;
  - `just docker-dev-resume` zwraca „Retained start has no admissible terminal outcome”.
- Odrzucony skrypt użytkownika nie powinien zostawiać kwarantanny, której nie da się usunąć
  udokumentowaną receptą.
