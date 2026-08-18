# Audyt trwałości quantities w trybie interaktywnym: MuMax3, FDM i FEM

- Data: 2026-08-17
- Zakres: stan zaakceptowany solvera, pola przestrzenne, gęstości energii, energie globalne, materializacja po zakończeniu stage/run, API v2 i Control Room
- Metoda: audyt źródłowy lokalnego `external_solvers/3` oraz Fullmag; bez twierdzenia o zamknięciu managed runtime i browser qualification
- Werdykt: **częściowo poprawne; nie ma jeszcze jednolitego kontraktu MuMax3-like dla wszystkich lane'ów FDM/FEM i wszystkich quantities**

## 1. Odpowiedź krótka

MuMax3 nie przechowuje stale w pamięci osobnej pełnej tablicy dla każdego pola i każdej gęstości energii. Przechowuje żywy, zaakceptowany stan symulacji (`M`, parametry, mesh, czas i reużywalne operatory), a quantities są globalnie zarejestrowanymi obiektami funkcyjnymi. `B_demag`, `Edens_demag`, `E_demag` i `E_total` są obliczane na żądanie z aktualnego stanu. Tymczasowe bufory CUDA są po odczycie zwracane do puli. Po zakończeniu `Run` albo `Relax` proces i stan pozostają żywe, więc quantity można nadal odczytać lub zapisać.

Fullmag realizuje dwa mechanizmy:

1. żywy `InteractiveRuntime`, który zachowuje zaakceptowane `m` i potrafi ponownie policzyć fields/energies;
2. opublikowany snapshot sesji (`latest_fields`, preview cache, scalar rows), który przeżywa pojedynczy solve i zasila HTTP v2.

Dla single-grid FDM CPU/CUDA ścieżka `Completed` ma obecnie mocny terminalny snapshot wszystkich aktywnych pól przestrzennych. Globalne energie pozostają w terminalnym `StepStats`/scalar row. Nie jest to jednak jeszcze kontrakt pełny i spójny:

- `/data/quantities` określa support wyłącznie z `preview_quantities` i `snapshot_quantities`, więc globalne energie mogą być oznaczone jako `unsupported`, mimo że są dostępne w scalar history;
- publiczny scalar row/API nie przenosi wszystkich energii obecnych w kanonicznym katalogu (`e_drive`, `e_el`, `e_kin_el`, `elastic_residual_norm`);
- FDM multilayer nie ma persistent `InteractiveRuntime`, tylko osobną ścieżkę snapshotu CPU;
- FEM shared-domain z airboxem jest jawnie wyłączony z idle persistent runtime;
- generic atomic terminal finalizer materializuje pełny zestaw pól wyłącznie dla `BackendPlanIR::Fdm`, nie dla FEM;
- capability lists FEM nie reklamują spatial energy densities, choć runner posiada ich materializatory;
- brak jednego testu publicznego, który po `Completed` przechodzi przez rzeczywisty CLI session host, API v2 i Control Room dla FDM CPU, FDM CUDA, FEM CPU i FEM GPU.

## 2. Jak działa MuMax3

### 2.1 Rejestr quantities

`external_solvers/3/engine/quantity.go:9-13` definiuje quantity jako `NComp()` i `EvalTo(dst)`. `ValueOf` w liniach 73-77 alokuje bufor z puli CUDA, wywołuje `EvalTo`, a użytkownik wyniku zwraca go przez `cuda.Recycle`.

`external_solvers/3/engine/outputquantities.go:60-67` tworzy `ScalarValue` z funkcji `func() float64`; `NewVectorField` i `NewScalarField` w liniach 89-103 rejestrują funkcje w warstwie skryptowej. `fieldFunc.Slice` w liniach 114-120 tworzy i wypełnia bufor dopiero podczas odczytu.

Wniosek: MuMax3 utrzymuje stale **definicję i zdolność ewaluacji quantity**, nie pełną kopię każdej quantity.

### 2.2 Energie

`external_solvers/3/engine/energy.go:13-23` posiada rejestry funkcji `energyTerms` i `edensTerms`. `GetTotalEnergy` w liniach 27-34 sumuje je przy każdym odczycie, a `SetTotalEdens` w liniach 36-42 ponownie buduje pole gęstości.

Demag jest analogiczny:

- `external_solvers/3/engine/demag.go:14-17`: `M_full`, `B_demag`, `Edens_demag`, `E_demag`;
- linie 35-49: `SetDemagField` wykonuje operator na żądanie;
- linie 111-114: `GetDemagEnergy` liczy energię z aktualnego `M_full` i `B_demag`.

### 2.3 Zachowanie po zatrzymaniu solvera

`external_solvers/3/engine/run.go:172-193` kończy tylko pętlę kroków i ustawia `pause`; nie niszczy `M`, mesha ani operatorów. `Inject` umożliwia wykonanie kodu GUI między krokami. `Relax` w `relax.go:42-58` przywraca ustawienia solvera, ale zachowuje znaleziony stan magnetyzacji. Dlatego po zakończeniu solvera quantities pozostają obliczalne.

`Table.Save` (`table.go:110-125`) liczy `AverageOf` każdej kolumny w chwili zapisu. `AutoSave` (`autosave.go:17-47`) jest harmonogramem wywołań, a nie cache'em wszystkich quantities.

### 2.4 Kontrakt referencyjny dla Fullmag

Właściwy kontrakt MuMax3-like brzmi:

> Po zakończeniu, pauzie albo anulowaniu kroku zaakceptowany stan fizyczny i wszystkie zasoby potrzebne do legalnej ewaluacji pozostają dostępne, dopóki użytkownik nie zamknie/nie zastąpi sesji. Każda wspierana quantity może zostać obliczona na żądanie. Cache jest optymalizacją, nie źródłem capability.

Nie należy wymagać stałej rezydencji wszystkich pełnych tablic pól; dla dużego FEM/FDM byłoby to kosztowne i nie odpowiada implementacji MuMax3.

## 3. Macierz porównawcza

| Właściwość | MuMax3 | FDM single-grid | FDM multilayer | FEM body-only | FEM shared-domain/airbox |
|---|---|---|---|---|---|
| Zaakceptowane `m` żyje po solve | tak | tak | tak w continuation/snapshot | tak | tak w continuation/snapshot |
| Ponowna ewaluacja na żywym backendzie | tak | tak CPU/CUDA | nie przez persistent runtime | tak, gdy runtime jest dostępny | brak ogólnego idle persistent runtime |
| Automatyczny terminalny komplet aktywnych pól | na żądanie, nie stały cache | tak po `Completed` | ścieżka osobna/fallback | zależy od ścieżki finalizacji | asymetryczna, zależna od FEM handoff/artifacts |
| Globalne energie po solve | tak, on demand | terminalny scalar row + on demand | scalar row/snapshot | scalar row + on demand | scalar row; on-demand lifecycle niejednolity |
| Spatial energy densities | tak, on demand | materializowane | ograniczony katalog planu | implementacja istnieje | capability/API niespójne |
| API deklaruje support niezależnie od cache | nie dotyczy | nie w pełni | nie w pełni | nie w pełni | nie w pełni |
| Publiczny E2E po zakończeniu | lokalny GUI/skrypt | brak pełnej bramki CLI+API+browser | brak | brak | brak |

## 4. Ustalenia pozytywne

### P-01 — FDM single-grid ma atomową finalną materializację pól

`crates/fullmag-runner/src/interactive/runtime.rs:16-88` przy `RunStatus::Completed` pobiera `field_materialization_quantity_ids`, wywołuje `snapshot_vector_fields`, przypisuje finalny step/time/revision i publikuje jeden `finished=true` update. Test `interactive_runtime.rs:696-887` sprawdza komplet aktywnych pól, finalne `m`, `H_eff`, `H_demag` również w nieaktywnych komórkach airboxa i `eden_demag`.

To jest lepsze od przypadkowego cache'u aktywnego widoku: finalna generacja jest jawna i atomowa.

### P-02 — żywy FDM runtime potrafi obliczać quantities na żądanie

CPU zachowuje `ExchangeLlgProblem`, `ExchangeLlgState`, FFT workspace i integrator buffers (`interactive_runtime.rs:1223-1234`). `fdm/cpu.rs:88-106` wykonuje batch snapshot z aktualnego stanu. CUDA przechowuje `NativeFdmBackend` (`interactive_runtime.rs:1237-1244`), a `fdm/cuda.rs:37-64` kopiuje wszystkie aktywne quantity z backendu.

### P-03 — globalne energie finalnego stanu są zachowane w scalar plane

`StepStats` jest mapowany do `e_ex`, `e_demag`, `e_ext`, `e_ani`, `e_dmi`, `e_total`; idle `compute_energies` aktualizuje te wartości w `interactive_runtime_host.rs:640-654` i `1009-1034`. `/data/scalars` czyta zachowane rows bez zależności od trwającego solvera.

### P-04 — FEM posiada realne materializatory pól i gęstości energii

FEM CPU wywołuje `observe_state` raz na batch (`interactive_runtime/fem/cpu.rs:43-69`). FEM native wywołuje backendowe copy (`fem/gpu.rs:41-75`). `native_fem.rs:3899-4029` posiada osobną ścieżkę energy-density snapshotów. Finalizacja relaksacji FEM (`fem/relax/finalize.rs:122-213`) opróżnia bounded asynchronous handoff, odświeża finalny accepted snapshot i publikuje payload oraz stany materializacji przed późniejszym thin `finished` update.

### P-05 — HTTP v2 rozróżnia capability od materialization state

Schema i handlery obsługują `unmaterialized`, `pending`, `complete`, `stale_complete`, `error`. GET pola zwraca `202` dla aktywnej materializacji, `204` dla rozpoznanej quantity bez nośnika i nie mapuje nieznanej quantity do `m`. To jest właściwy kierunek resource-first.

## 5. Findings wymagające naprawy

### Q-01 — P0: `/data/quantities` błędnie uzależnia support globalnych energii od capability pól

**Dowód.** `router_v2/handlers/data/quantities.rs:37-50` uznaje quantity za supported tylko wtedy, gdy jej ID znajduje się w `preview_quantities` albo `snapshot_quantities`. Globalne `E_ex`, `E_demag`, `E_ext`, `E_ani`, `E_dmi`, `E_total` są publikowane przez `scalar_outputs`, nie przez listy pól (`capabilities.rs:318-323`, `370-375`, `446-451`, `502-507`). W efekcie katalog może odpowiedzieć `capability_state=unsupported` dla energii, która jest legalnie obecna w `/data/scalars`.

**Skutek.** UI nie ma wiarygodnego jednego źródła prawdy. Dostępność scalar może zależeć od omijającej endpoint logiki `build_quantities`, a nie od kanonicznego v2 catalog.

**Naprawa.** W `annotate_runtime_quantity_state` rozgałęzić według `QuantityShape`: pola sprawdzać w preview/snapshot quantities, global scalars w `capabilities.scalar_outputs`, analysis quantities w ich właścicielu. Dodać jawne scalar state (`available`, `not_active`, `unsupported`) zamiast używać field materialization state.

**Test.** Router test: ukończona sesja FDM i FEM z demag ma `E_demag` oraz `E_total` jako supported/available, a nie materializable; nieaktywny `E_dmi` jest `not_active`, nie fałszywie supported.

**Bramka.** Jeden GET `/data/quantities` wystarcza do poprawnego zbudowania selektora pól i energii bez odczytu prywatnego metadata.

### Q-02 — P0: kanoniczny katalog energii jest szerszy niż terminalny/publiczny scalar transport

**Dowód.** `fullmag-quantities/catalog.rs:471-489` definiuje `E_drive`; linie 533-573 definiują `E_el` i `E_kin_el`; linie 576-594 residual. `GlobalQuantityRow` ma odpowiadające pola (`step_data.rs:103-113`). Tymczasem `/data/scalars` publikuje tylko `e_ex`, `e_demag`, `e_ext`, `e_ani`, `e_dmi`, `e_total` (`scalars.rs:69-89`, `120-130`), a `run_manifest_scalar_value` obsługuje ten sam wąski zestaw (`quantities.rs:163-175`).

**Skutek.** Twierdzenie „wszystkie energie pozostają dostępne” jest fałszywe. Szczególnie energia regional drive jest w katalogu i ma spatial density, lecz nie jest przenoszona w publicznym terminalnym scalar row.

**Naprawa.** Rozszerzyć backend-neutral `StepStats`/`ScalarRow`/OpenAPI o brakujące aktywne scalars albo usunąć z `ui_exposed` te, których aktualny workflow nie potrafi publikować. Preferowane: zachować katalog i dodać pola opcjonalne z aktywnością wynikającą z planu; nie używać zera jako substytutu „unavailable”.

**Test.** Dla Zeeman regional drive całka `eden_drive` zgadza się z `E_drive`, a terminalny `/data/scalars?tail=true` zwraca tę samą wartość. Dla niewłączonej fizyki kolumna ma jawny brak/nieaktywność, nie liczbę zero udającą wynik.

**Bramka.** Dla każdej `GlobalScalar` z `ui_exposed=true` istnieje właściciel backendowy, pole transportowe, serializacja OpenAPI i test po `Completed`.

### Q-03 — P0: nie ma jednego trwałego lifecycle dla wszystkich backend plans

**Dowód.** `supports_idle_interactive_runtime` (`interactive_runtime_host.rs:890-897`) zwraca true dla single-grid FDM oraz FEM bez `SharedDomainMeshWithAir`; FDM multilayer i FEM shared-domain nie korzystają z tego samego persistent runtime. Multilayer ma specjalny one-shot snapshot (`848-865`).

**Skutek.** Semantyka po zakończeniu zależy od discretization/topology. MuMax3-like kontrakt wymaga, aby użytkownik nie musiał wiedzieć, czy quantity pochodzi z retained backendu, checkpoint reconstruction czy immutable terminal carrier.

**Naprawa.** Zdefiniować `AcceptedStateQuantityProvider` niezależny od lane'u. Provider może mieć realizację retained-runtime, restartable accepted checkpoint lub immutable terminal snapshot, ale musi implementować: list capability, evaluate batch, evaluate scalar, generation identity, close/replace lifecycle.

**Test.** Ten sam black-box suite uruchomić dla FDM CPU, FDM CUDA, FDM multilayer CPU, FEM CPU body-only, FEM CPU shared-domain, FEM GPU shared-domain.

**Bramka.** Po każdym legalnym zakończeniu `compute_fields` i `compute_energies` działają na finalnym accepted generation bez restartu symulacji i bez zmiany `m`, czasu lub step.

### Q-04 — P0: generic terminal finalizer gwarantuje pełny terminal field set tylko FDM

**Dowód.** `interactive/runtime.rs:36-70` wykonuje pełny batch tylko, gdy backend plan jest FDM; dla FEM ustawia `cached_preview_fields=None`. FEM posiada osobny asynchronous handoff w relaksacji, ale nie jest to jeden kontrakt używany przez wszystkie FEM workflows i entrypoints.

**Skutek.** Nowy workflow FEM może zakończyć się z finalnym `m`/scalarami, ale bez pełnej materializacji wszystkich aktywnych pól, jeśli nie przejdzie przez konkretny finalizer FEM.

**Naprawa.** Przenieść terminalną publikację za metodę backendową `finalize_accepted_quantities(request, deadline)` i wymagać jej od każdego interactive backendu. FDM może wykonać synchronously, FEM może użyć handoff/deadline, ale output schema i atomic generation muszą być wspólne.

**Test.** Source-layout test nie wystarcza. Publiczny test każdego FEM workflow musi potwierdzić dokładnie jedną terminalną generację i zachowanie jej po thin `finished/awaiting_command` update.

**Bramka.** Żaden `finished` update nie może skasować lub postarzyć finalnych fields; timeout materializacji publikuje per-quantity `error`, nie cichy brak.

### Q-05 — P1: capability lists FEM nie odpowiadają istniejącej materializacji spatial energy densities

**Dowód.** `active_fem_preview_quantities` dopuszcza `EdenEx`, `EdenDemag`, `EdenExt`, `EdenDrive`, `EdenAni`, `EdenDmi`, `EdenTotal` (`runner/quantities.rs:281-334` i dalszy filter planu). Native FEM ma implementację energy density. Jednak `capabilities_for_fem_engine` reklamuje tylko pola wektorowe (`capabilities.rs:425-445`, `481-501`).

**Skutek.** Backend może materializować payload, a API nadal oznaczy quantity jako unsupported. To narusza zasadę „catalog capability niezależny od cache”.

**Naprawa.** Generować capability quantities z jednego backend/plan legality ownera zamiast ręcznych list. Lista capability opisuje możliwość; aktywność opisuje plan; materialization state opisuje cache/carrier.

**Test.** Dla FEM demag: `eden_demag` jest supported+active+unmaterialized przed komendą i complete po komendzie; dla demag disabled jest supported-but-inactive albo właściwie unsupported-by-plan zgodnie z ustalonym vocab.

**Bramka.** Nie ma quantity, dla której `active_fem_preview_quantities` zwraca true, a session capability jej nie reklamuje.

### Q-06 — P1: terminalna materializacja FDM jest ograniczona do `Completed`

**Dowód.** `should_materialize_terminal_fdm_fields` (`interactive_runtime.rs:149-151`) akceptuje wyłącznie `Completed`; test w liniach 889-899 odrzuca `Failed`, `Cancelled`, `Paused`.

**Skutek.** Dla `Paused` retained runtime zwykle nadal umożliwia on-demand compute, ale nie ma atomowego pełnego snapshotu tej zaakceptowanej generacji. Dla `Cancelled` użytkownik może stracić szybki dostęp do pól ostatniego poprawnie zaakceptowanego kroku, mimo że `final_magnetization` istnieje.

**Naprawa.** Rozdzielić „solver zakończył się sukcesem” od „istnieje poprawny accepted state”. Materializować dla Completed, Paused i Cancelled, jeśli backend zwraca certyfikowany accepted generation; nie materializować po błędzie przed zaakceptowaniem stanu.

**Test.** Pause/cancel w połowie kroku musi publikować fields z ostatniego accepted step, nie trial state; step/time/revision wszystkich quantities są identyczne.

**Bramka.** Każdy terminal status zawiera typed `accepted_state_available`; availability steruje finalizacją.

### Q-07 — P1: `compute_fields` i `compute_energies` są dwoma rozłącznymi odświeżeniami

**Dowód.** Host ma osobne `compute_current_fields` (`interactive_runtime_host.rs:600-638`) i `compute_current_energies` (`640-654`). Pierwsza komenda publikuje spatial fields, druga tylko aktualizuje StepStats/scalar row.

**Skutek.** Użytkownik może odświeżyć pola dla generacji N, a nadal widzieć energie ze starszej generacji, jeżeli mutation/load/continuation rozdzieli te operacje. MuMax3 oblicza każdą quantity z bieżącego globalnego stanu; Fullmag musi równie mocno wiązać provenance.

**Naprawa.** Obie komendy muszą przyjmować/emitować `accepted_state_generation_id`; opcjonalnie dodać wspólną transakcję `compute_quantities` z listą IDs. Cache update powinien commitować fields i scalars atomowo, gdy należą do jednego requestu.

**Test.** Po `load_state` komenda fields nie może pozostawić energii oznaczonej jako current dla starej generacji. API zwraca `stale_complete` do czasu recompute.

**Bramka.** Każdy scalar row i field carrier ma porównywalny generation identity, nie tylko step liczbowy.

### Q-08 — P1: brak pełnej product/API qualification po zakończeniu

**Dowód.** Istnieją dobre unit/source tests terminalnej materializacji FDM, FEM handoff i API carrier resolution, ale nie znaleziono jednej bramki uruchamiającej realną sesję interaktywną przez CLI/managed backend, kończącej solve i następnie odpytującej wszystkie aktywne quantities przez HTTP v2 oraz widoczny Control Room.

**Skutek.** Obecność kodu nie dowodzi, że host nie zostanie zamknięty, snapshot nie zostanie nadpisany thin update'em albo frontend nie uzna carrier za unavailable.

**Naprawa.** Dodać fixture `interactive_quantity_lifetime` dla każdej kwalifikowanej lane. Po zakończeniu odczekać stan `awaiting_command`, pobrać quantities, fields, scalar tail, wywołać compute commands, ponownie pobrać i wykonać browser switch bez nowego solve.

**Bramka.** Managed runtime report zapisuje requested/resolved backend/device/precision, generation IDs, listę aktywnych IDs, hash payloadu przed/po idle i wynik UI adoption. FEM proof używa container-backed `just`.

## 6. Kolejność wdrożenia

1. Naprawić model capability w `/data/quantities` (Q-01, Q-05).
2. Uzgodnić kompletny katalog scalar energies z `StepStats`, OpenAPI i `/data/scalars` (Q-02).
3. Wprowadzić wspólny `AcceptedStateQuantityProvider` i generation identity (Q-03, Q-07).
4. Ujednolicić terminal finalization dla FDM/FEM i statusów z accepted state (Q-04, Q-06).
5. Dodać managed CLI+API+browser qualification matrix (Q-08).

## 7. Minimalny zestaw regresji

- MuMax3 reference fixture: po `Run` odczytać `E_total`, `E_demag`, `B_demag`, `Edens_demag` i sprawdzić zgodność przed/po bez dodatkowego kroku.
- FDM CPU/CUDA: po Completed, Paused i Cancelled porównać `m`, każde aktywne `H_*`, `eden_*`, globalne `E_*`, step/time/generation.
- FDM airbox: `H_demag` zachowuje pełnodomenowy carrier; energy density pozostaje magnetic-only.
- FDM multilayer: object/layer carrier bez projekcji na wspólną siatkę; on-demand po idle.
- FEM CPU/GPU body-only i shared-domain: finalne `m`, `H_demag`, `demag_phi`, `eden_demag`, `E_demag`, `E_total` po `awaiting_command`.
- API: `/data/quantities`, `/data/fields`, `/data/fields/{id}/samples/vector`, `/data/scalars?tail=true`, command completion i ETag/304.
- Browser: przełączenie wszystkich aktywnych quantities po zakończeniu bez uruchomienia solvera, bez 204 dla supported+complete i bez cichego fallbacku do `m`.

## 8. Kryterium końcowe

Audyt można zamknąć jako production-qualified dopiero, gdy każda kwalifikowana lane spełnia jednocześnie:

1. accepted state przeżywa zakończenie do jawnego close/replace session;
2. capability jest niezależne od cache;
3. każda aktywna quantity jest obliczalna on demand albo ma immutable final carrier;
4. fields i scalars mają wspólną generation provenance;
5. API v2 odróżnia unsupported, inactive, unmaterialized, pending, complete, stale i error;
6. managed runtime i browser test dowodzą zachowania po zakończeniu, a nie tylko obecności kodu.

Na podstawie obecnego audytu źródłowego kryteria 1-6 nie są jeszcze spełnione globalnie. Najbliżej pełnego kontraktu jest single-grid FDM po `Completed`; FEM i publiczny katalog quantities wymagają dalszego ujednolicenia.
