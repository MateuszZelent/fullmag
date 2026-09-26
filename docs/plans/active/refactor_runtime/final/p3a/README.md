# P3a — immutable request context i sesyjny data-plane

Ten katalog zawiera pilot P3a-A oraz kolejne slice'y migracji klienta P3a-B.

Pilot obejmuje obecnie pięć głównych rodzin przepływu oraz recovery persistence:

- definicję sceny authoringu — trzy endpointy:
  `GET /v2/sessions/current/model/scene`,
  `PUT /v2/sessions/current/model/scene` oraz
  `PATCH /v2/sessions/current/model/scene`;
- przyjęcie komendy obliczeniowej przez
  `POST /v2/sessions/current/simulation/commands`. Kontekst jest
  przechwytywany przed walidacją/admission, ponownie sprawdzany po wolnych
  odczytach sceny i przed wejściem do kolejki. Finałowy enqueue i publikacja
  realtime trzymają blokadę przejścia sesji, więc zmiana `current` w tym oknie
  kończy się `409 request_context_stale` bez wpisu do kolejki ani ledgeru.
- odczyt binarny FMRM przez
  `/v2/sessions/current/data/fdm-region-membership` oraz wariant zakresowy z
  `region_id`. Handler klonuje przypięty snapshot po sprawdzeniu kontekstu,
  odczytuje payload poza `current_live_state`, a przed zwrotem odpowiedzi
  ponownie sprawdza epoch pod blokadą przejścia sesji.
- odczyt i mutacje persystencji checkpointów: lista, pobranie, capture oraz
  restore. Run ID i metadane są przechwytywane pod blokadą przejścia, store
  jest odczytywany z przypiętej tożsamości, a capture/restore utrzymują tę
  blokadę przez synchroniczne I/O i finalną publikację.
- eksport i import archiwum sesji. Eksport rewaliduje kontekst po wolnych
  odczytach przed transakcją store, a import rewaliduje go przed publikacją,
  czyści sesyjne kolejki/replay i zwiększa epoch dopiero przy atomowej podmianie
  `current`.
- lista i czyszczenie recovery. Handler przechwytuje ten sam immutable context
  i utrzymuje blokadę przejścia przez synchronizowany odczyt/usunięcie store,
  więc zmiana `current` nie może przekierować operacji na inną sesję.
- zdarzenia realtime dla GET/PATCH polityki komunikacji. Odczyt i mutacja
  polityki są przypięte do kontekstu, a publikacja zmiany trzyma blokadę
  przejścia sesji do końca wyprowadzenia i wysłania batcha.

Przed pierwszym wolnym `await` handler przechwytuje
`CurrentLiveRequestContext` zawierający `session_id`, `run_id` i
`current_live_session_epoch`. Ścieżki context-bound sprawdzają tę tożsamość
przed odczytem, po wolnym ładowaniu sceny, przed zapisem oraz pod blokadą
przejścia sesji. Jeżeli `current` zmienił się w międzyczasie, stary payload nie
trafia do nowej sesji.

Dotychczasowe helpery bez kontekstu pozostały jako adapter kompatybilności dla
niemigrowanych rodzin. Nie należy traktować tego pilota jako zakończenia P3a:
nie obejmuje wszystkich rodzin vector-field/binary decode, pełnej migracji
recovery persistence ani pełnej migracji handlerów. Pierwszy slice P3a-B opakowuje kluczem `session_id + epoch` cache
preview field-vector, planar field oraz metadata i decoded buffers pól
modalnych, a także propaguje canonical prefix invalidation do takich kluczy;
szczegóły są w [`02-client-resource-context.md`](02-client-resource-context.md).
Kolejne przyrosty używają wspólnego hooka dla modelu/geometrii, runtime komend i
checkpointów, events, workspace/visualization, statusowych zasobów meshingu,
analysis i diagnostics; opisują je
[`03-client-resource-context-model-runtime.md`](03-client-resource-context-model-runtime.md).
Następny przyrost objął membership/domain metadata, binary decode, cross-section,
field availability/drives, catalogs/tables/artifacts, analysis results,
analysis runtime, diagnostics/runtime explorer, spin-wave, Frozen Spins,
preparation, spin authoring i mode-composition; opisuje go
[`04-client-resource-context-data-analysis.md`](04-client-resource-context-data-analysis.md).
Macierz rodzin, globalnych wyjątków i otwartych write/import gates znajduje się
w [`05-endpoint-coverage.md`](05-endpoint-coverage.md). Pełny source-level
inventory 300 operacji OpenAPI z ownerem, read/write policy, handlerem i
statusem context migration jest generowany w
[`06-endpoint-owner-policy.md`](06-endpoint-owner-policy.md) przez
`scripts/audit_refactor_p3a.py`.
`session_id` jest świadomym adapterem legacy `/sessions/current`, a nie
udawanym `ProjectId`.

Przyrost source-level dla wizualizacji zamknął cztery odczyty GET oraz cztery
istniejące mutacje POST/PATCH: `visualization/display`,
`visualization/state`, `visualization/client-acks` i
`visualization/mode-compositions/active`. Każdy handler przypina
`CurrentLiveRequestContext`, utrzymuje transition fence do odczytu lub
publikacji, a klient przekazuje `sessionScopeKey` do typed API facade.
Kontrolery registry, mode-composition i ACK odrzucają odpowiedzi starego
scope’u oraz kończą oczekujące operacje w poprzedniej sesji. PUT display/state
mają teraz transition-fenced handlery oraz scoped metody typed facade
`replaceDisplay`/`replaceState`; repozytorium nie ma jednak ich produkcyjnych
callsite'ów. Dopisałem router regression, która wysyła stary scope do obu PUT-ów
i porównuje zasoby przed oraz po odrzuceniu. `rustfmt --check` przechodzi, ale
test Rust nie został uruchomiony, bo Docker Desktop coordinator nie odpowiada.
Test fasady w Vitest również jest `NOT RUN`: Node otrzymał `EPERM` przy odczycie
zablokowanego `vitest.mjs`. Oba wiersze pozostają `OPEN` do czasu produkcyjnego
callsite'u i browserowego A→B proof.

CPU/GPU telemetry jest osobną ścieżką hostową: handlery nie czytają
`SessionStateResponse`, a hooki Control Room używają globalnego klucza zasobu.

Bieżące ograniczenia transportu i lokalnych skutków komend opisuje
[checkpoint request scope](07-request-scope-transport.md). Zgodny klient
współdzielonego runnera i aktualna blokada miejsca są opisane w
[stanie runnera](08-runner-client-status.md).
Te dwa endpointy mają więc status `GLOBAL`, mimo że historyczna ścieżka zawiera
segment `/sessions/current`.

`/v2/sessions/current/status` pozostaje globalnym źródłem tożsamości sesji.
Handler jest jednak transition-fenced i rewaliduje `CurrentLiveRequestContext`
przed publikacją, więc jego status to `SOURCE PASS` bez sztucznego scope’owania
klucza `session:status`.

Źródła: `crates/fullmag-api/src/main.rs`,
`crates/fullmag-api/src/types.rs`,
`crates/fullmag-api/src/router_v2/handlers/model/authoring.rs` oraz
`crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs`,
`crates/fullmag-api/src/router_v2/handlers/data/fdm_region_membership.rs` oraz
`crates/fullmag-api/src/session_persistence.rs` i
`crates/fullmag-api/src/router_v2/handlers/platform/realtime.rs`.
Testy źródłowe epoch fencing dla sceny, enqueue komendy, odczytu binarnego,
capture/restore persystencji oraz events znajdują się w
`crates/fullmag-api/src/router_v2/tests.rs`; zgodnie z bieżącą polityką
repozytorium testy Rust nie są kompilowane ani uruchamiane. Dla slice'ów klienta
wykonano typecheck, API hygiene i wcześniejsze ukierunkowane testy zasobów;
browser/runtime pełnej migracji pozostaje `NOT VERIFIED`.

Inspekcja importowanego `.fms` ma teraz kanoniczny, niezależny od sesji
`POST /v2/persistence/imports/inspections`. Fasada Control Room korzysta z
tej trasy. Po przeglądzie konsumentów repozytorium usunięto stary alias
`/v2/sessions/current/persistence/imports/inspections` z routera i OpenAPI;
pozostałe użycia w testach przeniesiono na nową ścieżkę. Zapis importu sesji
pozostaje odrębną operacją `current`; frontend przekazuje scope do commitu,
a po ACK sprawdza globalną tożsamość aktywnej sesji, zanim zastosuje UI state
lub invaliduje jej zasoby. Handler backendu utrzymuje transition fence przez
atomową podmianę. Testy komendy: **84/84 PASS**; browser/managed cutover
pozostaje `NOT VERIFIED`.

Po tych przyrostach source-level inventory jest już wygenerowany, ale pozostają
owner/write decisions dla 15 operacji `OPEN`, legacy semantics pozostałych
ścieżek persistence/events oraz browserowy test przełączenia sesji podczas
trwającego decode. Deduplikacja
materializacji pól i odczytu świeżości meshu w `ControlRoomApi` jest już
kluczowana przez scope przekazany z `ResourceRuntimeStore`. Następny przyrost
powinien zamknąć migrację pozostałych handlerów i browser/runtime evidence przed
przejściem do managed runtime.

Ostatni slice P3a zamknął PUT `/v2/sessions/current/meshing/policies/objects/{object_id}`
i PUT `/v2/sessions/current/meshing/policies/universe` oraz dwanaście legacy
odczytów data-plane pól. Backend meshingu korzysta z `CurrentLiveRequestContext`
przy ładowaniu i commitowaniu sceny, a typed Object Mesh Policy i Airbox
Inspector przekazują `sessionScopeKey`. Odczyty vector/projection/slice mają
wrapper capture/validate przed i po obliczeniu. Jest to `SOURCE PASS`; wyścig
A→B w browser/runtime pozostaje `NOT VERIFIED`.

Rodzina `current-transports` (lista, odczyt elementu, create, patch i delete)
ma teraz jeden immutable `CurrentLiveRequestContext` przez odczyt sceny i
commit. Jest to `SOURCE PASS`; race qualification API/runtime/browser pozostaje
otwarta.

Rodzina `field-drives` (lista, create, replace i delete) używa tego samego
context-bound odczytu sceny oraz commit-fenced zapisu. Jest to `SOURCE PASS`;
kwalifikacja wyścigu API/runtime/browser pozostaje otwarta.

Najnowszy slice rozszerzył ochronę backendową POST `/v2/sessions/current/model/transactions`
oraz POST `/v2/sessions/current/persistence/assets/import`. Transaction handler
rewaliduje kontekst po każdym wariancie authoringu przed publikacją ACK, a
bezpośrednie komendy, historia Undo/Redo i panele Inspectora przekazują
`sessionScopeKey`. Import assetu fence'uje zapis pliku, odświeżenie indeksu
artefaktów i publikację realtime; loader field-state przekazuje ten sam scope.
Status `SOURCE PASS` dotyczy tutaj backendowego kontekstu przechwyconego przy
obsłudze żądania. Nie dowodzi zgodności z sesją, z której frontend rozpoczął
wieloetapową operację. Przyrost z 22.09.2026 dodaje nagłówek
`x-fullmag-session-scope`, walidowany przy przechwyceniu kontekstu pod blokadą
transition. Fasada przekazuje go dla JSON i binary. Klienci bez scope nadal
korzystają z adaptera zgodności; ich migracja pozostaje otwarta.
Nie należy traktować licznika endpointów jako procentu pełnej migracji klientów.

Rewalidacja 22.09.2026: blokada transition importu assetu obejmuje teraz okres
od walidacji kontekstu przed zapisem pliku do publikacji indeksu i realtime.
Dodano regresje stale epoch oraz oczekiwania na transition przed dekodowaniem
zawartości. `cargo check --locked -p fullmag-api`: PASS (exit 0); nowe testy Rust
nie zostały skompilowane ani uruchomione zgodnie z aktualnym ograniczeniem
AGENTS.md. Test A→B w browserze i kwalifikacja managed pozostają `NOT VERIFIED`.

Historia Undo/Redo ma dodatkowo generację unieważnianą przez `clear()`:
spóźniony odczyt nie inicjuje restore, a spóźniony ACK nie publikuje zasobu
i nie odtwarza stosu. Publikacja znanego scope aktualizuje jego konkretny alias.
Dodano dwie regresje wyścigu; testy jednostkowe pozostają nieuruchomione.
Scope jest przekazywany dalej przez loadery zasobów, a nie tylko kodowany
w kluczu cache. Tekstowy epoch statusu nie zastępuje wewnętrznego licznika;
ponowne otwarcie identycznego session_id/timestamp pozostaje osobnym ryzykiem
do zamknięcia przed kwalifikacją P3a.

Rodzina `couplings` (lista, create, patch i delete) wiąże odczyt sceny oraz
odczyt bieżącego planu/meshu z jednym contextem, a mutacje kończą się
commit-fenced zapisem. Jest to `SOURCE PASS`; kwalifikacja wyścigu
API/runtime/browser pozostaje otwarta.

Rodzina `spin-torques` (lista, odczyt elementu, create, patch i delete) ma
context-bound odczyt sceny oraz commit-fenced mutacje. Jest to `SOURCE PASS`;
kwalifikacja wyścigu API/runtime/browser pozostaje otwarta.

Rodzina `oersted-fields` (lista, odczyt elementu, create, patch i delete) ma
ten sam context-bound odczyt sceny i commit-fenced zapis. Jest to `SOURCE
PASS`; kwalifikacja wyścigu API/runtime/browser pozostaje otwarta.

Rodziny `spin-transports` (lista, odczyt elementu, create, patch i delete)
oraz `spin-interfaces` (projekcja listy interfejsów) korzystają z
context-bound odczytu sceny; mutacje transportu są commit-fenced. Są to
`SOURCE PASS`; kwalifikacja wyścigu API/runtime/browser pozostaje otwarta.

Rodzina `planar-monitors` (lista, odczyt, create, patch, delete i duplicate)
ma context-bound odczyt sceny oraz commit-fenced mutacje. Jest to `SOURCE
PASS`; kwalifikacja wyścigu API/runtime/browser pozostaje otwarta.

Rodzina Frozen Spins CRUD (lista, odczyt, create, patch i delete) ma
context-bound odczyt sceny, commit-fenced zapis oraz context-aware enqueue
replanu runtime. Preview i activation również korzystają z context-bound
odczytu/aktywacji oraz rewalidacji przed publikacją. Jest to `SOURCE PASS`;
kwalifikacja wyścigu API/runtime/browser pozostaje otwarta.

Rodziny FMRM scoped (`data/fdm-region-membership/{region_id}`),
`mesh-region-membership` oraz pól
(`data/fields`, availability i meta) przechwytują immutable context i
rewalidują go przed publikacją odpowiedzi; metadane dodatkowo sprawdzają
kontekst po await walidacji snapshotu. Są to `SOURCE PASS`; kwalifikacja
browser/runtime pozostaje otwarta.

Wszystkie endpointy planar field dla monitorów i domyślnego przekroju
(meta, scalar, vectors, empty-mask, probe, render PNG i mesh overlay)
korzystają ze wspólnego buildera z capture/revalidation przed i po await
walidacji snapshotu oraz po próbkowaniu. Są to `SOURCE PASS`; kwalifikacja
browser/WebGL/runtime pozostaje otwarta.

Trzydzieści trzy proste odczyty meshingu, obejmujące m.in. historię/aktywny/ostatni
poprawny build, capabilities, semantics, summary, konfiguracje
universe/shared-domain/object/interface oraz raporty i quality projections,
korzystają ze wspólnego `current_snapshot` z capture i
walidacją immutable context przed projekcją, a ścieżki artefaktów, przekrojów
i topology rewalidują context przed publikacją po pracy na danych. Są to
`SOURCE PASS`; browser/runtime qualification pozostaje otwarta.

Odczyt engine logu i profilu solvera korzysta również z immutable context,
rewalidacji pod snapshot read lockiem i ponownej kontroli przed publikacją.
Oba endpointy mają `SOURCE PASS`; telemetry CPU/GPU nadal pozostaje osobną
ścieżką hostową bez sesyjnego scope.

Siedem endpointów artefaktów eigen (spectrum v2, branches, dispersion,
mode-v2 i CSV) przechwytuje context przed wyznaczeniem katalogu artefaktów
oraz rewaliduje go po odczycie i parsowaniu pliku. Są to `SOURCE PASS`;
pozostały legacy `get_eigenmode_by_id` oraz reszta analizy wymagają osobnych
fence'ów i pozostają otwarte.

Wspólny helper frequency-domain JSON artefacts przechwytuje i rewaliduje
context po odczycie, dekodowaniu i wyliczeniu digestu dla dwunastu endpointów
spectrum/branches/field-sweep/diagnostics/FMR/response. Są to `SOURCE PASS`;
dynamiczny frequency-point używa osobnego helpera z zachowaniem wyznaczonej
ścieżki artefaktu i również ma `SOURCE PASS`.

Metadane pól eigen i response przechwytują context przed wyznaczeniem ścieżki
payloadu oraz rewalidują go po wyliczeniu digestu. Progress/cancel używają
analogicznego fenced helpera; te cztery endpointy mają `SOURCE PASS`.

Manifest frequency-domain ma dodatkowo outer fence obejmujący progress,
cancel i result manifest; zmiana sesji podczas któregoś z odczytów odrzuca
całą odpowiedź zamiast publikować mieszany manifest.

Rodzina `analysis/results` korzysta ze wspólnego loadera indeksów wyników,
który wiąże katalog artefaktów i tożsamość runu z jednym contextem oraz
rewaliduje go przed zwrotem indeksu. Dwanaście endpointów katalogu, datasetów,
osi, gałęzi, próbek, relacji, elementów i projekcji ma `SOURCE PASS`.

Wspólny typed-artifact loader spin-wave oraz odczyt magnetic-response sweep
rewalidują context po parsowaniu artefaktu; oba endpointy spin-wave i endpoint
frequency-response mają `SOURCE PASS`. Object-scoped topological charge ma
capture przed snapshotem/cache i rewalidację po projekcji legacy oraz zapisie
cache; ten endpoint również ma `SOURCE PASS`.

Textowy artifact dispersion CSV ma dodatkowo rewalidację po odczycie tekstu i
walidacji metadata ścieżki; jest to `SOURCE PASS`.

Wszystkie 14 endpointów analizy hysteresis (punkty, metryki, nasycenie,
adaptive refinement, branches, bookmarks, angular family, minor loops,
reversal fields i settle trace) przechwytuje kontekst przed odczytem artefaktu
i rewaliduje go przed publikacją. `POST` bookmark dodatkowo sprawdza kontekst
przed mutacją store oraz po zwolnieniu blokady. Jest to `SOURCE PASS`; testy
browser/runtime i klientowego scope pozostają otwarte.

Siedem endpointów runtime hysteresis (plan, protocol, saturation, orientation,
settle pipeline, execution tree i progress) ma taki sam capture oraz finalną
rewalidację po odczycie sceny, artefaktów, bookmarków i live magnetization.
Są to `SOURCE PASS`; managed runtime i browserowy stale-session smoke nadal
pozostają otwarte.

Odczyt `physics-graph` również przechwytuje immutable context, wiąże
normalizację z przypiętą sceną i rewaliduje kontekst przed publikacją odpowiedzi.
Jest to `SOURCE PASS`; kwalifikacja browser/runtime pozostaje otwarta.

Katalog i payload material-field oraz model readiness sprawdzają ten sam
context pod snapshot read lockiem. Są to `SOURCE PASS`; ich dowód
browser/runtime pozostaje otwarty.

Authoring material fields oraz odczyt i patch canonical materials korzystają
z jednego kontekstu przez scene load, commit i odczyt rewizji realizacji.
Są to `SOURCE PASS`; kwalifikacja browser/runtime pozostaje otwarta.

Odczyt i patch `magnetization-assets` używają tego samego context-bound
scene load/commit oraz odczytu rewizji initial-state. Są to `SOURCE PASS`;
kwalifikacja browser/runtime pozostaje otwarta.

Rodziny geometrii (capabilities, validation, diagnostics i realizacje), obiektów
i regionów (CRUD, reorder, duplicate oraz listy realized/diagnostics), interakcji
obiektu, `study` i `universe` (włącznie z fit) mają teraz capture immutable
context, context-bound scene load oraz commit-fenced mutacje. Są to `SOURCE PASS`;
kwalifikacja wyścigu API/runtime/browser pozostaje otwarta.

Rejestr `OPEN` z ownerem, znalezionym klientem w repozytorium, polityką
odczytu/zapisu i trasą deprecjacji znajduje się w
[`09-legacy-route-consumer-ledger.md`](09-legacy-route-consumer-ledger.md).
Brak klienta Control Room nie jest dowodem braku klienta zewnętrznego ani
zgodą na usunięcie publicznej operacji.
