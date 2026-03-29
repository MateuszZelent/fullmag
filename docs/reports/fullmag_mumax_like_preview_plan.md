# Raport: plan dojscia do mumax-like przelaczania pola i energii w interactive mode

Data: 2026-03-29

## Cel

Opracowac diagnoze i szczegolowy plan, jak doprowadzic Fullmag do zachowania zblizonego do `mumax` / `amumax`:

1. zmiana wyswietlanego pola (`m`, `H_demag`, `H_ex`, `H_eff`, itd.) ma byc odczuwalnie natychmiastowa,
2. zmiana nie moze zalezec od kolejnego kroku solvera,
3. po zakonczeniu symulacji, w stanie `awaiting_command`, nadal musi dzialac zmiana wyswietlanej wielkosci,
4. to samo ma dotyczyc energii:
   - albo jako global scalar (`E_ex`, `E_demag`, `E_total`),
   - albo jako spatial scalar field / energy density, jesli taka wielkosc jest wspierana przez backend.

## TL;DR

Najwazniejszy wniosek jest prosty:

Fullmag nadal traktuje preview jako produkt uboczny petli solvera, a `amumax` traktuje preview jako osobny widok nad zyjacym stanem engine.

To oznacza, ze same dotychczasowe optymalizacje transportu i frontendu byly potrzebne, ale nie wystarcza, zeby dojsc do zachowania "jak w mumaxie". Zeby to osiagnac, trzeba wykonac jedna zmiane architektoniczna:

- w interactive mode utrzymywac zywy backend po zakonczeniu komendy,
- wystawic osobny preview service, ktory potrafi na zadanie policzyc i odeslac aktualne pole bez czekania na next solver step.

Bez tego Fullmag bedzie zawsze mial przypadki, w ktorych klikniecie quantity tylko zmienia config, ale nie generuje nowego obrazu, zwlaszcza w `awaiting_command`.

## Co dzisiaj blokuje Fullmag

### 1. Preview jest nadal sprzezone z petla solvera

Runner generuje nowe `preview_field` tylko wtedy, gdy podczas wykonywania kroku solvera uzna, ze preview jest "due":

- `crates/fullmag-runner/src/dispatch.rs:840-875`

To oznacza:

- podczas `running` przelaczenie quantity dziala dopiero po kolejnym kroku,
- podczas `awaiting_command` nie ma juz kroku, wiec nie ma z czego wygenerowac nowego `preview_field`,
- UI moze miec nowy `preview_config.revision`, ale dalej wyswietlac stary obraz.

### 2. Interactive session nie trzyma zywego backendu po zakonczeniu komendy

W CLI po zakonczonym stage/command zachowywana jest `continuation_magnetization`, ale nie zywy backend:

- `crates/fullmag-cli/src/main.rs:1595-1610`
- `crates/fullmag-cli/src/main.rs:1941-1960`

Runner zwraca `RunResult`, a nie interaktywny obiekt backendu:

- `crates/fullmag-runner/src/lib.rs:260-321`

To jest kluczowa roznica wzgledem `mumax`-like UX. W Fullmag po zakonczonym runie mamy wynik, ale nie mamy juz procesu obliczeniowego, z ktorego mozna natychmiast odczytac `H_demag` czy `H_ex`.

### 3. Aktualny model preview wspiera praktycznie tylko vector field

Preview request i payload sa zaprojektowane pod aktualnie wybrane pole wektorowe:

- `crates/fullmag-runner/src/types.rs:115-169`

`LivePreviewField` niesie tylko `vector_field_values`. Nie ma wariantu dla:

- spatial scalar field,
- global scalar,
- energy density,
- "focused scalar metric".

Po stronie API `build_preview_state(...)` akceptuje tylko ilosc typu `vector_field`, a fallback `current_vector_field(...)` zna tylko:

- `m`
- `H_ex`
- `H_demag`
- `H_ext`
- `H_eff`

Dowody:

- `crates/fullmag-api/src/main.rs:1213-1360`
- `crates/fullmag-api/src/main.rs:1576-1629`

W praktyce oznacza to, ze dzisiejszy interactive preview nie ma modelu danych, zeby obsluzyc np. "pokaz energie" w sposob rownorzedny do `m` albo `H_demag`.

### 4. UI w interactive mode celowo odcina scalar quantities

Kiedy `previewControlsActive === true`, dropdown quantity przechodzi na `previewQuantityOptions`, a te sa filtrowane do `vector_field`:

- `apps/web/components/runs/control-room/ControlRoomContext.tsx:862-877`
- `apps/web/components/runs/control-room/ViewportPanels.tsx:70-87`

To znaczy:

- w interactive mode mozna wybierac pola wektorowe,
- ale nie `E_ex`, `E_demag`, `E_total`,
- nawet jesli te scalar quantities sa juz znane i dostepne w sesji.

### 5. API przy nieudanej przebudowie preview zostawia poprzedni obraz

Po zmianie configu preview API robi:

- `snapshot.preview = build_preview_state(...).or(previous_preview);`

czyli jesli nowej wielkosci nie da sie zbudowac z aktualnego stanu, frontend dostaje stary preview:

- `crates/fullmag-api/src/main.rs:1135-1163`

To jest funkcjonalnie "grzeczne", ale z UX punktu widzenia maskuje prawdziwy problem:

- config juz mowi `H_demag`,
- ale viewport moze nadal pokazywac `m`.

### 6. Energii globalnych nie trzeba liczyc na nowo, ale UI nie traktuje ich jako first-class interactive view

`E_ex`, `E_demag`, `E_ext`, `E_total` sa w modelu danych jako `global_scalar`:

- `crates/fullmag-api/src/main.rs:2447-2528`

Frontend umie policzyc `selectedScalarValue` z ostatniego `scalar_row`, ale tylko jako uboczny fallback:

- `apps/web/components/runs/control-room/ControlRoomContext.tsx:913-918`
- `apps/web/components/runs/control-room/ViewportPanels.tsx:296-308`

To jest wazne: globalne energie nie wymagaja zywego backendu do samego przelaczania, jesli juz mamy `scalar_rows`. Tu problem jest bardziej modelem UI niz wydajnoscia obliczen.

### 7. Dodatkowy problem: `latest_fields` wyglada na niedokonczona sciezke

API umie budowac fallback dla `H_ex/H_demag/H_ext/H_eff` z `latest_fields.*`, ale w przejrzanym przeze mnie kodzie nie znalazlem sciezki, ktora regularnie wypelnia `SessionStateResponse.latest_fields` po starcie live session.

Twardy fakt:

- `default_current_live_state(...)` startuje od `LatestFields::default()` w `crates/fullmag-api/src/main.rs:1975-1981`.

Wniosek:

- dzisiejszy fallback dla idle vector fields opiera sie bardziej na intencji architektonicznej niz na domknietym mechanizmie runtime.

To nie wystarczy do mumax-like switching.

## Jak robi to amumax i dlaczego tam to dziala "natychmiastowo"

Na podstawie publicznego repo `MathieuMoalic/amumax`:

### 1. Zmiana quantity trafia od razu do preview state, nie do osobnego pollera CLI

Handler `POST /api/preview/quantity`:

- ustawia `s.Quantity`,
- ustawia `s.Refresh = true`,
- wywoluje `s.ws.broadcastEngineState()`.

Zrodlo:

- `https://github.com/MathieuMoalic/amumax/blob/main/src/api/sec_preview.go`
  szczegolnie `postPreviewQuantity(...)`

### 2. Broadcast preview nie czeka na kolejny solver step

`broadcastEngineState()` robi:

1. `engineState.Update()`
2. `msgpack.Marshal(engineState)`
3. broadcast do websocketow

Zrodlo:

- `https://github.com/MathieuMoalic/amumax/blob/main/src/api/websocket.go`

To znaczy, ze klikniecie quantity moze samo wywolac aktualizacje preview.

### 3. Preview czyta aktualny stan engine bezposrednio z backendu

`PreviewState.Update()` woa:

- `engine.InjectAndWait(s.UpdateQuantityBuffer)`

a `UpdateQuantityBuffer()` bierze dane przez:

- `GPUIn := engine.ValueOf(s.getQuantity())`

Zrodlo:

- `https://github.com/MathieuMoalic/amumax/blob/main/src/api/sec_preview.go`

To jest najwazniejsza roznica. Preview nie zyje tam jako "ostatni sample ze step callbacka", tylko jako bezposredni odczyt aktualnego engine state.

### 4. amumax ma tez jawny endpoint refresh

Istnieje `POST /api/preview/refresh`, ktory po prostu robi broadcast aktualnego stanu preview:

- `https://github.com/MathieuMoalic/amumax/blob/main/src/api/sec_preview.go`

To jest bardzo przydatne przy idle / reconnect / resync.

### 5. Transport i frontend sa lzejsze

Frontend `amumax`:

- odbiera binarny WebSocket,
- dekoduje `msgpack`,
- wrzuca `preview` do store,
- od razu wywoluje `preview3D()` albo `preview2D()`.

Zrodla:

- `https://github.com/MathieuMoalic/amumax/blob/main/frontend/src/api/websocket.ts`
- `https://github.com/MathieuMoalic/amumax/blob/main/frontend/src/lib/preview/preview3D.ts`
- `https://github.com/MathieuMoalic/amumax/blob/main/frontend/src/lib/preview/preview2D.ts`

### Wniosek architektoniczny

To, ze `amumax` dziala dobrze po zakonczeniu symulacji, nie wynika tylko z szybszego JSON-a czy lzejszego renderu. Wynika przede wszystkim z tego, ze preview moze byc przeliczony na zadanie z aktualnego, wciaz zywego engine state.

To jest wniosek oparty na kodzie handlerow preview i `engine.ValueOf(...)`. Nie twierdze, ze kazda sciezka wewnetrzna w `amumax` jest darmowa. Twierdze cos weziej i pewniej:

- preview refresh w `amumax` jest niezalezny od kolejnego solver step,
- a Fullmag dzisiaj nadal jest od niego zalezne.

## Ruznice Fullmag vs amumax

| Obszar | Fullmag dzisiaj | amumax dzisiaj | Co trzeba zrobic |
| --- | --- | --- | --- |
| Zmiana quantity podczas `running` | zwykle czeka na kolejny solver step | moze sama wymusic refresh preview | odpiac preview od step callbacka |
| Zmiana quantity podczas `awaiting_command` | dla `m` bywa OK, dla `H_*` potrafi zostac stare preview | dziala na zyjacym engine state | trzymac backend po komendzie |
| Preview payload | model vector-only | preview model obsluguje vector i scalar view | wprowadzic union payload |
| Energia globalna | jest w `scalar_rows`, ale nie jest first-class interactive quantity | widok sterowany stanem UI / engine | rozdzielic "focused scalar" od "preview field" |
| Refresh endpoint | brak | jest `/api/preview/refresh` | dodac explicit refresh/resync |
| Transport | JSON text WS | binary WS + `msgpack` | rozwazyc binarny preview channel |
| Renderer 3D | nadal O(N) CPU update instancji | lzejsza sciezka store -> renderer | przejsc na GPU-friendly attributes |

## Docelowa architektura dla Fullmag

### Zasada 1. Preview nie moze byc skutkiem ubocznym solver loop

Preview ma byc osobna usluga interactive runtime, nie "momentem" w `StepUpdate`.

Docelowo:

- solver loop produkuje telemetry i opcjonalny background cache,
- preview service odpowiada na `SetQuantity`, `SetComponent`, `SetLayer`, `RefreshNow`,
- preview service czyta aktualny stan backendu, nawet gdy solver stoi.

### Zasada 2. Interactive session musi miec backend lifetime dluzszy niz jedna komenda

Po `run`, `relax`, `pause` i po zakonczeniu stage backend ma nadal istniec, dopoki:

- session zyje,
- user nie zamknie workspace,
- nie przejdziemy do nowej materializacji problemu.

To pozwala:

- przelaczyc `m -> H_demag -> H_ex` bez restartu solvera,
- odswiezyc preview po reconnect,
- policzyc energy density / field snapshot na zadanie.

### Zasada 3. Trzeba rozdzielic trzy klasy "wyswietlanej wielkosci"

1. `vector_field`
   Przyklad: `m`, `H_demag`, `H_ex`, `H_eff`

2. `spatial_scalar`
   Przyklad: komponent `x/y/z`, magnitude, energy density, maski, inne pola skalarne na gridzie / meshu

3. `global_scalar`
   Przyklad: `E_ex`, `E_demag`, `E_total`

To sa rozne byty i nie powinny dzielic tego samego, zbyt waskiego payloadu.

## Szczegolowy plan wdrozenia

## Etap 0: pomiary i acceptance criteria

Przed wieksza przebudowa trzeba dodac telemetry na calej sciezce:

1. `ui_click_to_api_ack_ms`
2. `api_preview_request_to_cli_dispatch_ms`
3. `cli_dispatch_to_backend_snapshot_ms`
4. `backend_snapshot_to_ws_emit_ms`
5. `ws_emit_to_render_commit_ms`

Akceptacja dla FDM/CUDA na problemie rzedu `200 x 200 x 1`:

- `running`: zmiana miedzy juz wspieranymi quantity p95 <= 100 ms
- `awaiting_command`: zmiana `m <-> H_demag <-> H_ex <-> H_eff` p95 <= 100 ms
- `awaiting_command`: zmiana focused global energy (`E_ex/E_demag/E_total`) p95 <= 16 ms
- brak czekania na kolejny solver step do samej zmiany preview

## Etap 1: rozdzielenie UI "preview field" od "focused scalar"

To jest szybki i tani etap, ktory od razu odblokowuje energie globalne po zakonczeniu runu.

Zakres:

1. W `ControlRoomContext` przestac filtrowac dropdown interactive do samych `vector_field`.
2. Wprowadzic dwa rozne stany UI:
   - `selectedPreviewQuantity`
   - `selectedScalarQuantity`
3. Gdy user wybiera `global_scalar`, nie wysylac tego przez preview API.
4. Pokazywac:
   - last value,
   - sparkline / trace,
   - ewentualnie chart focus
   w pelni lokalnie z `scalar_rows`.

Efekt:

- po zakonczeniu runu user moze natychmiast przelaczac `E_ex`, `E_demag`, `E_total`,
- bez backend roundtrip,
- bez mieszania tego z rendererem pola 2D/3D.

To nie daje jeszcze parity dla `H_demag` w idle, ale natychmiast domyka polowe user-facing problemu.

## Etap 2: InteractiveRuntime, ktory trzyma zywy backend po komendzie

To jest glowny etap architektoniczny.

Trzeba dodac w CLI nowy obiekt, roboczo:

- `InteractiveRuntime`

Odpowiedzialnosc:

1. posiadac zywy backend FDM/FEM,
2. trzymac aktualna magnetyzacje / stan solvera,
3. przyjmowac komendy `run/relax/pause/stop`,
4. przyjmowac komendy preview `set_config/refresh_now`,
5. zwracac snapshot preview bez niszczenia backendu.

Minimalny interfejs:

```rust
enum InteractiveCommand {
    Run { until_seconds: f64 },
    Relax { max_steps: u64, torque_tolerance: Option<f64>, energy_tolerance: Option<f64> },
    Pause,
    Stop,
    SetPreview(PreviewSpec),
    RefreshPreview,
    SnapshotPreview(PreviewSpec),
    SnapshotScalars,
    Shutdown,
}
```

Pierwsza implementacja powinna objac:

- FDM native CUDA

Dopiero potem:

- CPU reference,
- FEM.

## Etap 3: preview snapshot API niezalezne od solver step

Po stronie backend/runner trzeba dodac jawna operacje:

- `snapshot_preview(&PreviewSpec) -> PreviewPayload`

To nie moze byc wtorny efekt `on_step`.

Docelowo runner/backend powinien umiec:

1. w stanie `running`
   - wykonywac preview requests w bezpiecznym punkcie synchronizacji
   - bez czekania na "preview every_n"

2. w stanie `awaiting_command`
   - natychmiast zrzucic aktualne `m`, `H_demag`, `H_ex`, `H_eff`
   - tak jak `amumax` robi to przez `engine.ValueOf(...)`

Konkretnie dla FDM/CUDA trzeba dodac metode na backendzie z obecnego stanu:

- nie tylko `copy_live_preview_field(request, original_grid)` wywolywane z `dispatch.rs`,
- ale tez wywolywalne bez petli stepowej, z interactive runtime.

To jest moment, w ktorym Fullmag zacznie zachowywac sie jak `mumax`, a nie tylko "troche szybciej niz wczoraj".

## Etap 4: nowy model danych preview

Obecny `LivePreviewField` trzeba zastapic unia, np.:

```rust
enum PreviewPayload {
    VectorField {
        quantity: String,
        unit: String,
        spatial_kind: String,
        preview_grid: [u32; 3],
        original_grid: [u32; 3],
        vector_values: Vec<f32>,
        ...
    },
    SpatialScalar {
        quantity: String,
        unit: String,
        spatial_kind: String,
        preview_grid: [u32; 3],
        scalar_values: Vec<f32>,
        min: f32,
        max: f32,
        ...
    },
    GlobalScalar {
        quantity: String,
        unit: String,
        value: f64,
        source_step: u64,
        source_time: f64,
    },
}
```

Korzyści:

1. preview API wreszcie umie obsluzyc nie tylko vector field,
2. energy density da sie pokazac jako spatial scalar,
3. globalne energie nie beda udawaly pola 2D/3D,
4. frontend dostanie jawny kontrakt renderowania.

W tym etapie trzeba tez:

- rozszerzyc `resolve_preview_quantity(...)`,
- przestac zakladac, ze preview zawsze oznacza `vector_field`,
- usunac fallback "zostaw previous preview bez sygnalu bledu".

## Etap 5: cache quantity snapshots po stronie interactive runtime

Po wprowadzeniu zywego backendu warto dodac cache:

Klucz:

- `source_revision`
- `quantity`
- `component`
- `layer`
- `all_layers`
- `x_chosen_size`
- `y_chosen_size`
- `max_points`

Strategia:

1. jesli user wraca do niedawno ogladanego quantity i stan backendu sie nie zmienil:
   - tylko display switch,
   - zero recompute,
   - zero GPU copy poza ewentualnym ponownym wyslaniem lekkiego eventu

2. jesli stan backendu sie zmienil:
   - cache invalidation,
   - nowy snapshot

To jest wazne szczegolnie dla sekwencji typu:

- `m -> H_demag -> H_ex -> H_demag -> H_eff -> m`

Bez cache da sie dojsc do "dziala". Z cache da sie dojsc do "czuje sie natychmiastowo".

## Etap 6: dodanie explicit refresh endpoint

Tak jak w `amumax`, Fullmag powinien miec:

- `POST /v1/live/current/preview/refresh`

Semantyka:

- nie zmienia configu,
- wymusza snapshot aktualnie wybranego quantity,
- dziala w `running` i `awaiting_command`.

To rozwiazuje:

- reconnect klienta,
- resync po utraconym evencie,
- debug / benchmark,
- odswiezanie po zmianach, ktore nie musza zmieniac quantity.

## Etap 7: transport preview blizej amumax

Po wykonaniu zmian powyzej warto odchudzic sam transport:

1. osobny preview channel zamiast mieszania ze snapshotami sesji,
2. binarny payload (`msgpack`, `rmp-serde`, ewentualnie prosty packed float buffer),
3. preferencja `f32` dla preview vectors/scalars,
4. bez `serde_json` dla duzych tablic wektorowych.

To nie jest pierwszy, ale bardzo sensowny etap po InteractiveRuntime.

Najwiekszy efekt:

- mniejsze payloady,
- mniejszy parse cost,
- mniej GC i alokacji w JS.

## Etap 8: renderer 3D bez O(N) skladania macierzy na CPU

Zeby zblizyc feeling do `mumax`, sam backend to nie wszystko. Potrzebny jest jeszcze lzejszy renderer.

Docelowo:

1. pozycje instancji sa statyczne,
2. orientacja i kolor ida przez `InstancedBufferAttribute`,
3. shader liczy orientacje glyph / voxel color na GPU,
4. przy zmianie quantity nie skladamy od nowa wszystkich macierzy modelu na CPU.

To jest szczegolnie wazne dla:

- duzych preview gridow,
- szybkiego klikania quantity,
- slabszych CPU.

## Etap 9: parity dla energi przestrzennych

Jesli chcemy byc naprawde "jak amumax", trzeba dodac nie tylko globalne `E_*`, ale tez spatial scalar quantities typu:

- `Edens_ex`
- `Edens_demag`
- `Edens_total`

lub ich odpowiedniki w nazewnictwie Fullmag.

To wymaga:

1. wsparcia po stronie backendu do liczenia / odczytu density fields,
2. wsparcia po stronie `PreviewPayload::SpatialScalar`,
3. 2D/mesh rendereru dla scalar map,
4. sensownego nazewnictwa w dropdownie i quick targets.

Ten etap nie jest potrzebny, zeby naprawic dzisiejszy bug z idle switching `H_demag`, ale jest potrzebny, jesli celem jest prawdziwe parity z narzedziami z rodziny `mumax`.

## Kolejnosc wdrozenia, ktora ma najwiecej sensu

1. Etap 1:
   od razu odblokowac natychmiastowe przelaczanie globalnych energii w UI.

2. Etap 2 + 3:
   dodac `InteractiveRuntime` i idle preview snapshot dla FDM/CUDA.

3. Etap 4 + 6:
   nowy model preview + explicit refresh endpoint.

4. Etap 5:
   cache quantity snapshots.

5. Etap 7 + 8:
   binarny preview transport i renderer GPU-friendly.

6. Etap 9:
   parity dla spatial scalar / energy density.

## Minimalny zakres, ktory trzeba zrobic, zeby user przestal czuc roznice do mumax

Jesli chcemy osiagnac szybki, praktyczny efekt, a nie od razu pelny refactor, to absolutne minimum jest takie:

1. natychmiast odblokowac `global_scalar` w UI lokalnie,
2. trzymac backend zywy w `awaiting_command`,
3. dodac `SnapshotPreview` niezalezny od solver step,
4. dodac cache ostatnich `m/H_ex/H_demag/H_eff`,
5. dodac `/preview/refresh`.

To jeszcze nie da pelnej parity w transporcie ani renderze, ale powinno usunac najbardziej irytujacy problem:

- "klikam quantity po zakonczeniu runu i nic sie nie dzieje albo dzieje sie za wolno".

## Ryzyka i koszty

### 1. Trzymanie backendu zwiekszy zycie GPU memory

To jest koszt realny i trzeba nim zarzadzic:

- session TTL,
- cleanup przy zamknieciu workspace,
- cleanup przy nowej materializacji,
- limit liczby zywych session runtimes.

### 2. Konkurencja miedzy run command a preview snapshot

Trzeba jasno zdecydowac:

- albo snapshot preview jest wykonywany na tym samym serialnym executorze backendu,
- albo ma osobne bezpieczne punkty synchronizacji.

Najprostsza i najbezpieczniejsza droga:

- jeden serialny executor interactive runtime,
- `run`, `pause`, `snapshot_preview`, `refresh` ida jako uporzadkowane komendy.

### 3. FDM najpierw, FEM pozniej

Wdrozenie dla FDM/CUDA bedzie najprostsze i da najwieksza korzysc najszybciej.

Nie warto probowac od razu robic pelnej symetrii FDM/FEM w pierwszym kroku, bo ryzyko wdrozeniowe za bardzo rosnie.

## Finalna rekomendacja

Jesli celem jest zachowanie "tak jak w mumaxie", to najwazniejsza decyzja brzmi:

Nie optymalizowac juz dalej tylko starej sciezki `UI -> preview config -> czekaj na solver step -> dostan preview`.

Ta sciezka jest juz w praktyce na granicy tego, co da sie sensownie poprawic bez zmiany modelu runtime.

Trzeba przejsc na:

- `InteractiveRuntime` z zyjacym backendem,
- `snapshot_preview()` niezalezny od solver cadence,
- rozdzielenie `vector_field`, `spatial_scalar` i `global_scalar`,
- natychmiastowy local switch dla globalnych energii,
- optional binary preview channel i lzejszy renderer.

To jest plan, ktory realnie doprowadzi Fullmag do zachowania bliskiego `amumax`.

## Status wdrozenia

Stan na teraz:

- `global_scalar` zostal odblokowany lokalnie w UI, wiec energie `E_ex/E_demag/E_ext/E_total` moga byc przelaczane bez roundtripu do preview API,
- `preview` zostal odklejony od pollingu co 200 ms i od full-session JSON snapshotu,
- dla `awaiting_command` dodano cache preview dla pol `H_ex/H_demag/H_ext/H_eff` zapisywany lokalnie przy sesji,
- API czyta teraz lekki publiczny snapshot z osobnego bufora JSON zamiast stale serializowac i blokowac `current_live_state`,
- frontend w `awaiting_command` traktuje powrot do `m` jako lokalny switch oparty o `live_state.magnetization`, zeby nie robic zbednego roundtripu.

Zweryfikowane na FDM `200 x 200 x 1`:

- wejscie w `awaiting_command` nie generuje juz ostrzezen `failed to publish current live state`,
- przejscia `m -> H_demag`, `H_demag -> H_ex` i `H_ex -> H_eff` schodza do okolo `100-135 ms`,
- te przejscia dzialaja juz po zakonczeniu solvera, bez nowego solver step.

Pozostaly dlug architektoniczny:

- backend nie jest jeszcze trzymany zywy jak w `mumax/amumax`,
- cache w `awaiting_command` jest nadal cachem preview, a nie pelnym zywym stanem engine,
- parity z `mumax` dla wszystkich zmian preview dalej najlepiej domknie dopiero `InteractiveRuntime` z trwalym backendem i `snapshot_preview()` wykonywanym bez rematerializacji problemu.

## Zrodla

### Kod Fullmag

- `crates/fullmag-runner/src/dispatch.rs`
- `crates/fullmag-runner/src/lib.rs`
- `crates/fullmag-runner/src/types.rs`
- `crates/fullmag-cli/src/main.rs`
- `crates/fullmag-api/src/main.rs`
- `apps/web/components/runs/control-room/ControlRoomContext.tsx`
- `apps/web/components/runs/control-room/ViewportPanels.tsx`

### Kod amumax

- https://github.com/MathieuMoalic/amumax/blob/main/README.md
- https://github.com/MathieuMoalic/amumax/blob/main/src/api/sec_preview.go
- https://github.com/MathieuMoalic/amumax/blob/main/src/api/websocket.go
- https://github.com/MathieuMoalic/amumax/blob/main/src/api/engine_state.go
- https://github.com/MathieuMoalic/amumax/blob/main/frontend/src/api/websocket.ts
- https://github.com/MathieuMoalic/amumax/blob/main/frontend/src/api/incoming/preview.ts
- https://github.com/MathieuMoalic/amumax/blob/main/frontend/src/api/outgoing/preview.ts
- https://github.com/MathieuMoalic/amumax/blob/main/frontend/src/lib/preview/preview3D.ts
- https://github.com/MathieuMoalic/amumax/blob/main/frontend/src/lib/preview/preview2D.ts
