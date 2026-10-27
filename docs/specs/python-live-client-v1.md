# Tryb `live` DSL i klient Pythona — specyfikacja v1

- Status: **przyjęta** (decyzje ADR 0068 z 22.10.2026); runtime NOT IMPLEMENTED.
- Data: 2026-10-22.
- Decyzja: [ADR 0068](../adr/0068-python-live-session-client.md).
- Kontrakty nadrzędne: [`session-run-api-v1.md`](session-run-api-v1.md),
  [`resource-first-control-room-api-v2.md`](resource-first-control-room-api-v2.md),
  [`scene-document-authoring-v1.md`](scene-document-authoring-v1.md),
  ADR 0053 (FMVP), ADR 0067 (grupy DEV).

## 1. Cel i zakres

Zwykły skrypt Pythona z `import fullmag as fm`, uruchomiony przez
`python skrypt.py`, w interpreterze interaktywnym albo komórka po komórce w
Jupyterze, programuje symulację w działającej instancji Fullmaga, tak jak
skrypt z `NetSocks.py` programuje działającego Borisa. Każde wywołanie DSL:

- buduje lub zmienia scenę: obiekty, materiały, regiony, couplingi, napędy,
  etapy;
- wysyła komendy runtime i czeka na ich wynik;
- odczytuje pola, skalary i tabele jako tablice numpy.

Skrypt może też subskrybować zdarzenia sesji, a stan sesji eksportuje się do
kanonicznego skryptu Pythona.

Poza zakresem v1: wykonanie zdalnego kodu, synchroniczny callback po każdym
kroku solvera (faza F7), komendy `step{n}` i long-poll, wiele sesji w jednym
procesie API.

## 2. Tryby wykonania DSL

| Tryb | Jak się włącza | Co robi |
|---|---|---|
| `capture` | `fullmag skrypt.py` | przechwytuje skrypt do ProblemIR; Rust planuje i wykonuje całość z provenance (bez zmian) |
| `eager` | `python skrypt.py` bez `fm.connect()` i bez `FULLMAG_URL` | liczy w procesie Pythona przez PyO3 (bez zmian) |
| `live` (nowy) | `fm.connect(url=None)` albo zmienna `FULLMAG_URL` | każde wywołanie DSL działa na żywej sesji działającej instancji |

`fm.connect()` bez argumentu używa `FULLMAG_URL`, a bez niej
`http://127.0.0.1:<domyślny port frontendu>`. Wywołanie `fm.connect()` w
trybie `capture` zgłasza `RuntimeError`: skrypt przechwytywany nie steruje
sesją, a sandbox przechwytywania i tak blokuje gniazda.

## 3. Odwzorowanie Boris → Fullmag

| Boris (`NetSocks.py`) | Fullmag, tryb `live` |
|---|---|
| `ns = NSClient()` | `fm.connect()` albo `FULLMAG_URL` |
| `ns.default()` | `fm.reset()` → `replace_scene` pustą sceną |
| `ns.cellsize(...)`, `ns.cuda(1)` | `fm.cell(...)`, `fm.device("cuda:0")` → transakcje |
| `ns.addmesh(...)`, `ns.Ferromagnet(rect, cellsize)` | `layer = fm.geometry(fm.Box(...), name="py")` → `create_object` |
| `mesh.param.damping.setparam(0.01)` | `layer.alpha = 0.01` → `patch_material` |
| `ns.setfield(...)` | `fm.b_ext(...)` → transakcja napędu pola |
| `ns.setstages([...])`, `ns.addstage(...)` | `study.stages.add_relax(...)` → `merge_patch` na `study.stages` |
| `ns.Run()` (blokujące) | `fm.relax()`, `fm.run(1e-9)` → komenda + oczekiwanie |
| `ns.stop()`, `ns.pause()` | `fm.stop()`, `fm.pause()`, `fm.resume()`, `fm.skip()` → komendy z `target=current_stage` |
| `bufferCommand=True` + `runcommbuffer` | `with fm.transaction(): …` → jedna transakcja |
| `mesh.quant.M.getvalue(...)`, OVF2 | `fm.m.average()`, `fm.field("m").to_numpy()` (FMVP) |
| `Get_Data_Columns(file)` | `fm.table(id).to_numpy()` / `.to_pandas()` |
| `Run(callback)` (embedded) | `fm.on(...)`, `fm.run_until(predicate, chunk_steps=N)` |
| `NSMultiClient(ports=[...])` | `fm.sweep(fn, points, groups=[url1, url2, …])` |

## 4. Warstwa niska `fullmag.client`

### 4.1 Transport

- Wyłącznie biblioteka standardowa (`http.client`), bez nowych zależności
  runtime: `fm.connect()` działa w każdym środowisku z pakietem `fullmag`,
  także w obrazie Docker. API jest synchroniczne (`fullmag.client.Client`).
- Jedno trwałe połączenie HTTP/1.1 na wątek, więc synchronizacja po każdym
  wywołaniu DSL nie płaci za nowe połączenie TCP.
- Bazowy URL to origin frontendu grupy DEV, który przekazuje `/v2/*` i
  WebSocket do API. Kolejność: argument `url`, `FULLMAG_URL`,
  `http://127.0.0.1:3197`. Token z argumentu lub `FULLMAG_TOKEN`, wysyłany
  wyłącznie jako `Authorization: Bearer`.
- Nagłówek `x-fullmag-session-scope` jest wysyłany tylko do operacji, które go
  deklarują, i tylko gdy klient zna zakres sesji.
- Ponawiane są wyłącznie żądania, które na pewno nie zostały zastosowane:
  nieudane nawiązanie połączenia, zamknięte bezczynne połączenie keep-alive,
  502 z proxy frontendu oraz 409 `development_restart_in_progress`, z
  backoffem do budżetu `retry_budget_s` (domyślnie 60 s). GET dodatkowo przy
  503/504. Komendy przy ponowieniu zachowują ten sam `client_intent_id`.

### 4.2 Modele

- `scripts/generate_python_api_models.py` generuje z `openapi-v2.json`
  domknięcie schematów operacji używanych przez klienta (lista
  `OPERATION_IDS`): `TypedDict`-y, tabele `REQUIRED_FIELDS` i
  `DISCRIMINATED_UNIONS` do walidacji w czasie działania oraz tabelę operacji.
  Dokumenty sceny (`SceneResource` i pokrewne) są nieprzezroczyste
  (`Dict[str, Any]`), bo tworzą je kanoniczne konwertery DSL.
- Wynik leży w `packages/fullmag-py/src/fullmag/client/_generated/` i jest
  commitowany. Generator uruchamiają `pnpm run generate:api` oraz
  `just docker-dev-codegen`; bramka `generated-api-determinism` i test
  `test_generated_models_are_current` wykrywają nieaktualne modele.
- Klient wywołuje operacje wyłącznie przez tabelę: nieznana operacja,
  parametr zapytania lub brak parametru ścieżki to błąd przed wysłaniem;
  ciało żądania przechodzi kontrolę pól wymaganych i dyskryminatora `kind`.

### 4.3 Błędy

| Odpowiedź serwera | Wyjątek |
|---|---|
| 409 `revision_conflict` | `StaleRevisionError` |
| 409 `accepted_execution_input_locked` lub edycja podczas biegu bez pauzy | `InputLockedError` |
| 409 sesja istnieje bez `replace_current` | `SessionExistsError` |
| 409 `development_restart_in_progress` po wyczerpaniu budżetu | `DevelopmentRestartError` |
| 400 / 404 / 422 | `ValidationError` / `NotFoundError` / `UnsupportedCapabilityError` |
| komenda `rejected` / `failed` / zakończona jako `cancelled` | `CommandFailedError` |
| przekroczony czas oczekiwania na komendę | `CommandTimeoutError` |
| niepoprawny payload lokalnie | `RequestValidationError` |
| brak połączenia | `FullmagConnectionError` z adresem i wskazówką o grupie DEV |

Wszystkie dziedziczą po `FullmagClientError`. Klient nie ponawia transakcji po `StaleRevisionError` automatycznie. Sesja
jest współdzielona z Control Room (ADR 0068, pytanie 4), więc konflikt
oznacza zmianę wprowadzoną przez inną stronę i trafia do użytkownika.

### 4.4 Komendy

```python
cmd = client.commands.submit(kind="run", until_seconds=1e-9,
                             target=Target.study(), precondition=...)
cmd.wait(timeout=None)   # zdarzenia WebSocket, a bez nich odpytywanie GET commands/:id
```

`client_intent_id` jest generowany przez klienta i pozwala bezpiecznie
ponowić wysłanie po zerwanym połączeniu.

## 5. Tryb `live` w DSL

### 5.1 Przykład

```python
import fullmag as fm

fm.connect()                       # albo FULLMAG_URL=… python skrypt.py
fm.engine("fdm")
fm.device("cuda:0", precision="double")
fm.cell(5e-9, 5e-9, 10e-9)

layer = fm.geometry(fm.Box(1000e-9, 1000e-9, 10e-9)
                    - fm.Cylinder(radius=75e-9, height=10e-9), name="layer")
layer.Ms = 800e3                   # natychmiast: patch_material
layer.alpha = 0.5
layer.m = fm.texture.uniform(1, 0, 0)

fm.solver(fix_dt=1e-13)                # etapy wykonywalne wymagają jawnego kroku
fm.relax(dt=1e-13)                 # komenda relax, czeka na zakończenie
m = fm.field("m").to_numpy()   # (punkty, 3) numpy

with fm.transaction():             # kilka zmian jako jedna rewizja
    fm.b_ext(0.05, 0, 0)
    layer.alpha = 0.01
fm.run(2e-9)
print(fm.export_script())          # kanoniczny Python
```

Ten sam skrypt bez `fm.connect()` działa jak dziś (`eager`), a uruchomiony
przez `fullmag skrypt.py` jak dziś (`capture`).

### 5.2 Synchronizacja i tożsamość

- Funkcje DSL definiujące scenę (eksportowane z `fullmag`) oraz przypisania i
  publiczne metody uchwytów (`MagnetHandle`, `MagnetizationHandle`,
  `AlphaControl`, `GeometryMeshHandle`, rejestry regionów, `StudyBuilder` i
  jego uchwyty) działają w `fullmag.live._hooks.dsl_call`. Wspólny licznik
  zagłębienia sprawia, że synchronizuje dopiero najbardziej zewnętrzne
  wywołanie: `fm.b_ext(...)`, które wewnętrznie ustawia kilka pól, daje jedną
  transakcję. Poza trybem `live` hak tylko sprawdza brak sesji.
- Synchronizacja buduje SceneDocument z bieżącego świata tymi samymi
  konwerterami co `fullmag skrypt.py` (`export_builder_draft` +
  `build_scene_document_from_builder`, ~1 ms) i porównuje go z ostatnio
  wysłanym dokumentem (bez `revision` i `editor`). Brak różnicy: nic nie
  jest wysyłane.
- Zmiana jest wysyłana jako:
  - `replace_scene` — pierwszy kompletny świat po `fm.connect()` lub
    `fm.reset()` (skrypt jest właścicielem sceny) oraz gdy zmiana wymaga
    ustawienia `null`, którego merge patch nie wyraża;
  - `patch_material` — gdy zmieniły się tylko właściwości `Ms`, `Aex`,
    `alpha`, `Dind`, `Dbulk` jednego materiału (serwer synchronizuje wtedy
    DMI);
  - `assign_study_execution` — zmiana `study.execution_profile`, której
    serwer nie przyjmuje przez merge patch;
  - `merge_patch` (RFC 7386) — pozostałe zmiany, jedna transakcja.
  Wszystkie warianty serwer stosuje do tego samego dokumentu i zatwierdza
  jedną ścieżką (`commit_authoring_transaction`), więc dokument sesji jest
  równy dokumentowi świata.
- Świat, którego nie da się jeszcze obniżyć (np. magnes bez `Ms`), nie jest
  wysyłany: zmiany czekają i trafiają do sesji przy pierwszym kompletnym
  stanie. Akcje (`relax`, `run`) wymagają kompletnej sceny i zgłaszają błąd.
- `with fm.transaction():` zbiera wywołania w jedną synchronizację na
  wyjściu z bloku.
- Ponowne wykonanie `fm.geometry(shape, name=X)` dla istniejącego `X` w
  trybie `live` podmienia kształt tego obiektu i zwraca ten sam uchwyt
  (ponowne uruchomienie komórki notatnika); poza trybem `live` duplikat
  nadal jest błędem.
- Typ obiektu nie włącza fizyki; moduły fizyczne włącza się jawnie, tak jak w
  DSL.
- Operacje bez zachowania w trybie `live` zgłaszają `fm.LiveModeError` z
  podpowiedzią: deklaracje etapów (`relax_stage`, `run_stage`,
  `eigenmodes_stage`, `frequency_response_stage`, `save_state_stage`),
  `eigenmodes`, `frequency_response` oraz zapis plików z lokalnego wyniku
  (`save`, `save_response`, `snapshot`). Nic nie wykonuje się po cichu
  lokalnie.
- `fm.reset()` zachowuje sesję; następny kompletny świat zastępuje scenę
  (odpowiednik `ns.default()`).

### 5.3 Akcje, stany i pauza

- `fm.relax(...)` i `fm.run(t)` najpierw dopisują etap do `scene.study.stages`
  (budowany jak etap przechwycony przez `fullmag skrypt.py`), a potem wysyłają
  komendę `relax`/`run` z `target={"kind": "stage_index", ...}` tego etapu.
  Jak `study.stages.add_relax`/`add_run`, etap wymaga jawnego kroku czasowego
  (`dt` albo polityki adaptacyjnej z `dt_max`); bez niego wywołanie zgłasza
  `ValueError` przed wysłaniem komendy.
  Run accepted w Dockerze wykonuje dokładnie jeden autorski etap
  (`select_live_step` w `crates/fullmag-api/src/live_accepted_execution.rs`),
  a sekwencja etapów sprawia, że `fm.export_script()` odtwarza wykonane akcje.
  Parametry `relax` są znormalizowane jak lokalnie (`torque_tolerance_apm`,
  `energy_tolerance_j`, `max_steps`, `max_relaxation_time_s`,
  `relax_algorithm`, `relax_alpha`, `fixed_timestep`, `max_error`);
  `fm.minimize` deleguje do `relax`; `until_seconds` w `run` to długość
  odcinka. A captured stage runs in the world state it saw when the script
  called it, like mumax3. Pipeline materialization starts each stage from the
  end-of-script problem, so a `relax`/`run` payload whose uniform `b_ext`
  differs from that problem carries it as `external_field` (tesla, 3 numbers;
  `[0, 0, 0]` when no field was set yet). The override applies to that stage only.
  Changing `b_ext` before an eigenmodes or frequency-response stage, or
  changing material parameters between stages (other than `relax_alpha`), is
  rejected at export instead of silently using the end-of-script values.
  Komenda ma warunek `scene_revision` równy rewizji zbudowanej przez
  skrypt, czeka na stan końcowy i zwraca `LiveCommandResult`. Odrzucona,
  nieudana lub anulowana komenda zgłasza `CommandFailedError`.
- `fm.pause()`, `fm.resume()`, `fm.stop()`, `fm.skip()` wysyłają komendy o
  tej samej nazwie z `target={"kind": "current_stage"}`, jak Control Room.
- `with fm.paused():` wysyła `pause`, czeka na zakończenie komendy, wykonuje
  blok jako jedną transakcję i wysyła `resume` także po wyjątku. Edycje
  wejścia przyjęte w pauzie obowiązują od następnej granicy etapu (ADR
  0068, D3; zakres backendu w §9).
- Edycja wejścia podczas biegu bez pauzy zgłasza `InputLockedError`; klient
  nie wysyła niejawnie `stop`.
- Tryb accepted (Docker DEV) ma dziś ograniczenia serwera, które klient
  zgłasza jawnie, a nie obchodzi:
  - `pause` i `skip` zwracają 422 `accepted_control_unsupported`
    (`UnsupportedCapabilityError`), więc `fm.paused()` działa tylko w
    hoście interaktywnym poza Dockerem; w Dockerze edycje wykonuje się między
    komendami (run jest wtedy terminalny);
  - każda komenda to osobny run startujący od `m` zadanego w scenie, czyli
    `fm.relax()` → `fm.run()` nie kontynuuje jeszcze zrelaksowanego stanu —
    zakres F5 w §9.
- Odczyty wielkości DSL (`fm.m.average()`, `fm.mx`, `fm.E_total`, warunki
  `fm.mx > 0.5`) w trybie `live` czytają najnowszy wiersz skalarów sesji
  (`GET …/data/scalars?tail=1`); `fm.m.get()` czyta pole `m` przez FMVP.
  `fm.field(q)` i `fm.table(id)` zwracają dane jako numpy.

### 5.4 Pętle sterujące

- `fm.on(event_type, fn)` wywołuje `fn(event)` w wątku strumienia zdarzeń
  dla `scalar.sample`, `resource.batch_changed`, `hello`,
  `resync.required` lub `"*"`; zwraca subskrypcję z `cancel()`.
- `fm.run_until(predicate, chunk_time=…, max_time=…|max_chunks=…)`: pętla
  `run(until_seconds=chunk_time)` → najnowszy wiersz skalarów →
  `predicate(step)`. Wymaga co najmniej jednego ogranicznika. Koszt jednej
  iteracji to jedna komenda i jeden odczyt skalarów.
- `fm.run_while(condition, chunk_time=…, max_time=…|max_steps=…)` działa w
  trybie `live` na tej samej pętli; `max_steps` liczy kroki solvera z
  kolumny `step` sesji.
- Warunki stopu, które backend obsługuje natywnie (tolerancje relax,
  `until_seconds`), mają pierwszeństwo przed `run_until`.

## 6. Dane

- Dekoder FMVP v2–v6 w Pythonie z numpy (`fullmag.client.fmvp`) zachowuje
  wszystkie kontrole dekodera Control Room (`fieldVectorCodec.ts`,
  `artifactFieldVectorCodec.ts`); FMTB (`rows.bin`) dekoduje
  `fullmag.client.fmtb`.
- `FieldVector.to_numpy()` zwraca tablicę `(point_count, n_comp)` w
  jednostkach SI; `as_grid()` dla pola FDM pełnej domeny zwraca
  `(nz, ny, nx, n_comp)` (x zmienia się najszybciej, jak w silniku FDM);
  `as_complex()` łączy pary (re, im).
- `client.data.read_field(q)` korzysta z ETag/`If-None-Match`: brak zmiany
  (304) zwraca poprzednio zdekodowany obiekt bez transferu; 202 jest
  odpytywane do limitu czasu, 204 zwraca `None`.
- `client.data.read_table(id, columns=...)` zwraca `TableRows` z numpy;
  `to_pandas()` tylko gdy pandas jest dostępny.
- Zgodność: próbki w `packages/fullmag-py/tests/fixtures/fmvp/` powstają z
  enkoderów odwzorowujących `field_store.rs` bajt w bajt; dekoduje je test
  Pythona i `fieldVectorCodec.fixtures.test.ts`, porównując z jednym
  `expected.json`.

## 7. Zdarzenia

- `fullmag.client.events`: klient WebSocket RFC 6455 na bibliotece
  standardowej (handshake z `Sec-WebSocket-Protocol: fullmag.live.v1`,
  weryfikacja `Sec-WebSocket-Accept`, ramki fragmentowane, odpowiedź na ping,
  zamknięcie). Strumień jest wyłącznie odbiorczy, zgodnie z
  `docs/specs/asyncapi/fullmag-live-realtime-v1.json`.
- `EventStream` czyta zdarzenia w wątku tła, po zerwaniu połączenia wznawia z
  `after_seq` = ostatni `seq`, a `resync.required` czyści kursor.
- `fm.connect(events=True)` (domyślnie) uruchamia strumień; oczekiwanie na
  komendę budzi się wtedy na zdarzeniach zamiast odpytywać z backoffem.
- Zdarzenia są wyłącznie powiadomieniami; dane pobiera się osobnym GET po
  zmianie rewizji.
- Dodatek `fullmag[jupyter]` (`ipython`, `matplotlib`):
  `fm.live.jupyter.monitor(("mx", "my", "mz"))` aktualizuje jedno wyjście
  komórki wykresem skalarów z `scalar.sample` (bez matplotlib — tabela
  tekstowa). Bez IPython monitor tylko zbiera próbki.

## 8. Przemiatanie parametrów (wiele grup DEV)

```python
import fullmag as fm

def point(H):
    fm.engine("fdm")
    fm.cell(5e-9, 5e-9, 10e-9)
    layer = fm.geometry(fm.Box(200e-9, 100e-9, 10e-9), name="layer")
    layer.Ms, layer.Aex, layer.alpha = 800e3, 13e-12, 0.5
    layer.m = fm.texture.uniform(1, 0, 0)
    fm.b_ext(H, 0, 0)
    fm.relax(dt=1e-13)
    return fm.m.average()

results = fm.sweep(point, H=[0.01, 0.02, 0.03, 0.04],
                   groups=["http://127.0.0.1:3197", "http://127.0.0.1:3198"])
values = [r.value for r in results]          # w kolejności punktów
```

- `fm.sweep(function, groups=[...], points=[...] | **listy)` uruchamia jeden
  wątek na grupę DEV (ADR 0067). Każdy wątek ma własny kontekst autorski
  (`fm.ExecutionContext`) i własne połączenie `live`; punkty pobiera ze
  wspólnej kolejki, więc szybsza grupa liczy więcej punktów.
- Przed każdym punktem świat jest resetowany (`fm.reset()`), a pierwszy
  kompletny świat punktu zastępuje scenę grupy (`replace_scene`),
  odpowiednik `ns.default()`. `function` buduje cały model zwykłym DSL.
- Wynik: `SweepResult(index, point, group, value, run_id, error)` w kolejności
  punktów. Błędy punktów są zbierane; domyślnie `SweepError` po zakończeniu
  wszystkich punktów, `raise_on_error=False` zwraca wyniki z błędami.
- Grupa, która nie odpowiada w `connect_retry_s` (domyślnie 5 s), jest
  pomijana, a jej punkty liczą pozostałe grupy. `fm.sweep` nie uruchamia
  grup samodzielnie; równoległość ograniczają liczba grup i ich budżety
  `FULLMAG_DEV_*`.

## 9. Wymagane zmiany backendu

Stan po F5 (22.10.2026):

| Zmiana | Stan przed F5 | Stan po F5 |
|---|---|---|
| Kontynuacja `m` między komendami w trybie accepted | RunIntent komendy miał `seeds: {}` i `dependencies: []`; resolver tylko dla `StepOutput` | zrobione: run deklaruje wyjście `final_state`; następna komenda tej samej sesji i epoki dostaje wejście `initial_state` jako `PinnedArtifact` z ostatniego zakończonego runu, gdy siatka i obsada materiałów się zgadzają (`live_accepted_continuation.rs`, nota `docs/physics/0925-live-session-magnetization-continuation.md`); inaczej stan autorski. Źródło trafia do `live_workspace.initial_state_source` |
| Utrzymanie `m` w trybie scratch przy edycji | supervisor kończy proces potomny przy zmianie rewizji sceny | bez zmian; D3 obowiązuje w hoście interaktywnym |
| `pause`/`skip` w trybie accepted | 422 `accepted_control_unsupported` | bez zmian (Q3: „nie teraz”); `stop` przyjmuje teraz `target: {"kind": "run", "run_id"}` i sprawdza, że run należy do bieżącej sesji |
| Kod błędu istniejącej sesji | 409 bez kodu | zrobione: `session_already_active` |
| Obecność klienta skryptu w sesji | brak rejestru klientów | zrobione po stronie API i klienta: `GET /v2/sessions/current/clients`, `PUT`/`DELETE /clients/{client_id}`, TTL 30 s, zdarzenie zasobu `session-clients`; `LiveSession` wysyła heartbeat co 10 s. Wskaźnik w nagłówku Control Room: nie zrobiony |
| Etap live bez jawnego kroku czasowego | `fm.relax()` bez `dt` dawał etap z adaptacyjnym krokiem bez `dt_max`, którego runner nie wykona | walidacja etapu bez zmian (wymaga `dt_max`); tryb live zgłasza `ValueError` przed wysłaniem komendy, gdy brak `dt` lub `dt_max` |

Wady runtime znalezione podczas E2E w grupie DEV i naprawione w F5:

- błąd workera kończył scheduler, runtime i API; teraz błąd zapisany trwale jako wynik zadania nie zatrzymuje schedulera (`task_failed_settled`);
- zadanie `Running`, którego worker zakończył się bez rozliczenia, trzymało lease CPU na zawsze; scheduler rozlicza je przez ścieżkę odzyskiwania supervisora (`exited_worker_recovered`);
- nieaktualny kandydat przyjęcia (zadanie anulowane po migawce kolejki) był błędem krytycznym; teraz jest odkładany do następnego przebiegu;
- komendy runów zakończonych bez wyjść nigdy się nie kończyły; teraz każdy terminalny run kończy związaną komendę;
- przyczyna błędu workera ginęła w początku stderr; teraz raport bierze ostatni znacznik `accepted worker failed:`;
- `relax` w trybie accepted kończył się „no pinned runner horizon”; horyzont relaksacji może być nieskończony;
- worker padał na zajętym zapisie magazynu sesji i na niepotwierdzonym ostatnim heartbeacie; zapis jest ponawiany, a nieudane wyjście z niepotwierdzonym heartbeatem przechodzi do uzgodnienia stanu.
- scheduler przygotowania kończył się, gdy blokada zapisu magazynu była zajęta dłużej niż 5 s; usługa runtime przechodziła wtedy w `draining`, a nadzorca zamykał API (objaw: „po otwarciu UI pada backend”). Teraz odracza przebieg;
- worker tracił już policzony wynik, bo blokada zapisu to nieblokujący, niesprawiedliwy try-lock współdzielony przez API, oba schedulery i workery, a 5-sekundowe odpytywanie mogło się zagłodzić. Ścieżki workera czekają do `WORKER_STORE_WRITER_WAIT` (120 s); schedulery zostają przy 5 s i odraczają;
- po edycji modelu po zakończonym runie projekcja co 500 ms ponawiała sprawdzenie wejścia tego runu i logowała ostrzeżenie; zakończony, już zrzutowany run jest pomijany, a każde odroczenie raportowane raz;
- `fm.relax()`/`fm.run()` bez jawnego kroku dawały etap, którego runner nie wykona; tryb live zgłasza `ValueError` przed wysłaniem;
- `fm.connect()` dołączał do sesji terminalnej (`failed`), która odrzuca każdą komendę; teraz zakłada nową.
- projekcja przepisywała status zakończonego runu na status sesji, więc po pierwszej komendzie sesja stawała się `completed` i odrzucała następne (także kontynuację stanu). Run komendy interaktywnej przywraca teraz sesję do `awaiting_command`; run skryptu startowego nadal kończy sesję;
- `fm.m.average()`/`fm.field("m")` po runie accepted: tabela skalarów nie jest jeszcze projektowana, a trasa wektora pól odpowiada `quantity_registry_not_resolved_plan`; klient czyta `m` z najnowszej ramki obserwacji (`/data/observation-frames/{id}/magnetization`, FMVP v4), a średnie liczy z pola. `fm.E_total` daje wtedy NaN;
- `fm.export_script()` renderuje bieżącą scenę przez `POST /model/syncs`.

Stan ścieżek trybu live w grupie DEV (23.10.2026):

| Ścieżka | Wynik | Uwagi |
|---|---|---|
| FDM CPU | działa | pełne E2E powtarzalne: model, `relax`, `m` (trasa pól, FMVP v2), `transaction()`, `run` z kontynuacją, zdarzenia, eksport |
| FDM GPU | `run` działa | kolejne `run` z kontynuacją i odczytem `m`; `relax` (`llg_overdamped`) niedostępny z założenia: w macierzy możliwości relaks CUDA to ścieżka rozwojowa, więc bramka `strict` go odrzuca („final execution is not fully device-proven”), a worker runtime'u accepted obsługuje tylko tryb `strict` (`fm.mode("extended")` kończy się „supports only FDM CPU/GPU double strict”) |
| FEM CPU | działa | `relax` → `m` → `transaction()` → `run` → `m` (bez demagnetyzacji; demag FEM wymaga `build_domain_mesh()` z airboxem) |
| FEM GPU | działa | jak FEM CPU; kontynuacja ze stanu runu FEM CPU tej samej sesji |

Ograniczenia stwierdzone w grupie DEV (poza zakresem F5):

- API nie ma operacji zamknięcia sesji (`PATCH /v2/sessions/current` zwraca 400), a launcher celowo nie restartuje backendu z aktywną sesją. Sesja założona przez `fm.connect()` blokuje więc `just docker-dev` po zmianie backendu; launcher mówi to teraz wprost. Docelowy model wielu sesji (karty sesji obok Home) to osobny temat;
- `docker restart` backendu bez launchera pomija delegowaną bramkę cgroup workerów; próbka węzła ma wtedy `cpu_quota: unavailable`, a ledger hosta po cichu odrzuca przyjęcia CPU (komenda zostaje `accepted`). Po zmianie backendu trzeba restartować przez launcher;
- projekcja tabeli skalarów i rejestru wielkości dla runów accepted (wykresy na żywo, `E_total`, trasa wektora pól) nie istnieje; klient obchodzi to ramkami obserwacji;
- magazyn sesji na folderze Windows (`FULLMAG_PROJECT_STORAGE_ROOT=C:\git\fullmag\storage`, montowanie Docker Desktop) wydłuża każdą transakcję do 3–6 s i daje sporadyczne `ENOENT` przy odczycie listingu pod blokadą zapisu; zalecany magazyn na ext4 (WSL) albo w wolumenie Dockera.

Wsparcie każdej zmiany jest deklarowane per ścieżka (FDM CPU, FDM GPU,
FEM CPU, FEM GPU) w `docs/specs/capability-matrix-v0.md`; wymuszony GPU nie
przechodzi niejawnie na CPU.

## 10. Fazy i kryteria ukończenia

| Faza | Zakres | Kryterium |
|---|---|---|
| F0 | ADR 0068 i ta spec | zrobione: decyzje przyjęte 22.10.2026 |
| F1 | `fullmag.client`: transport, modele generowane, błędy, komendy, ponawianie przy handoffie | zrobione: `test_live_client_core.py` na prawdziwym serwerze HTTP w procesie, kontrola aktualności modeli, job CI `python-live-client-contracts` |
| F2 | dekoder FMVP, `to_numpy()`, tabele, cache ETag | zrobione: `test_live_client_data.py` i `fieldVectorCodec.fixtures.test.ts` dają identyczne wyniki na wspólnych próbkach |
| F3 | tryb `live` w `world.py`: `fm.connect`/`FULLMAG_URL`, natychmiastowa synchronizacja, reguła tożsamości, `transaction()`, akcje, `paused()`, `export_script()` | zrobione: testy na stanowym fałszywym API (`test_live_dsl_mode.py`) oraz E2E w grupie DEV (FDM CPU, 23.10.2026): model → `relax` → `m.average()` i `field("m")` → `transaction()` → `run` → `export_script()`; `pause`/`skip` w Dockerze nadal 422 (Q3) |
| F4 | subskrybent WebSocket, `fm.on()`, `fm.run_until()`, dodatek Jupyter | zrobione: `test_live_events.py` (prawdziwy serwer WebSocket w teście); w E2E w grupie DEV strumień dostarczył 29 zdarzeń; pomiar narzutu `run_until` w grupie DEV NOT VERIFIED |
| F5 | zmiany backendu z §9 | zrobione: regresja E2E w grupie DEV na jednej wersji (23.10.2026) przechodzi na FDM CPU, FDM GPU (`run`), FEM CPU i FEM GPU, z kontynuacją `m` między komendami (`initial_state_source.kind = continuation`); obecność klientów potwierdzona; wyjątek: `relax` na FDM GPU (bramka `strict`); testy Rust kompilowane tylko w CI |
| F6 | `fm.sweep()` na wielu grupach DEV | zaimplementowane (`test_live_sweep.py`: 2 serwery, kolejność wyników, błędy punktów, nieosiągalna grupa); przemiatanie na ≥ 2 prawdziwych grupach DEV NOT VERIFIED |
| F7 | opcjonalnie tryb in-process (PyO3 + `InteractiveRuntime`) z tym samym protokołem | callback po każdym kroku bez serwera |
| F8 | przykładowy skrypt i notatnik w `examples/`, strona w `public_docs`, ściągawka Boris → Fullmag | dokumentacja publikowana razem z F3 |

## 11. Bezpieczeństwo

- Brak zdalnego wykonania kodu; klient wysyła wyłącznie typowane transakcje i
  komendy.
- Domyślnie tylko loopback; połączenie z innym hostem jest jawne i wymaga
  tokenu tam, gdzie API go wymaga.
- Token nie trafia do URL ani do logów klienta.
