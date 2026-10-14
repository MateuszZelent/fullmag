# Niezależna recenzja modułu anten mikrofalowych Fullmaga

**Data odczytu:** 11 października 2026 r.  
**Repozytorium:** `MateuszZelent/fullmag`  
**Branch:** `codex/microwave-antenna-latest-20260909`  
**Recenzowany SHA:** `426d1974bf4801f87e34024a81c21b0789605817`  
**Baza najnowszego przyrostu:** `41a5b8936b3eaa38420e9ba358cbf22ac7e2d803`  
**Przypięty master i merge-base:** `2a3c6becb9c7e111ae1497ec0cd9ac9576acba95`  
**Tryb:** niezależna inspekcja źródeł i odczyt metadanych GitHub; bez zmian repozytorium, bez uruchamiania sceny, kompilacji i testów.

## 1. Werdykt

**Nie rekomenduję uznania tego checkpointu za ukończony moduł anten ani za wydanie produkcyjne.** Przyrost ma wartość: wprowadza osobny standalone Study, jawny wybór fizycznej definicji i portu, rozdzielone identyfikatory, przygotowanie RunIntent bez automatycznego Submit, accepted worker bez magnetycznego scaffoldu oraz trwały, wersjonowany pakiet inspekcji. To rzeczywisty postęp implementacyjny, nie wyłącznie dokumentacja.

Największa luka produktu pozostaje jednak pomiędzy inspekcją raw V/J/H a kwalifikowaną bazą H/I używaną przez rzeczywisty magnetyk. Nowa ścieżka raw celowo i prawidłowo odmawia projekcji, solved drive i source spectrum. Starszy producent reusable basis wciąż łączy V/J/prąd normalizacji z jednego solve z H pochodzącym z drugiego solve RT0/Oersted. Nie ma w tej ścieżce wykazanego wspólnego źródła wszystkich tych danych.

Druga luka to kompilacja całego Study: nowy obiekt kompilacji zachowuje strukturę autora i rzeczywiste ekspansje, lecz sam nie produkuje accepted StudyPlan/katalogu/zależności. Odczytane wejścia przygotowania nadal wymagają wcześniej dostarczonych skompilowanych danych. Pojedynczy standalone task nie dowodzi obsługi uporządkowanego pipeline.

**Decyzję o merge trzeba rozdzielić:** otwarte T13–T18 nie są automatycznie zakazem scalenia bezpiecznej infrastruktury WIP. Natomiast nie wolno na tej podstawie opublikować pełnej capability antenowej. Dla merge checkpointu WIP pozostają co najmniej: wyjaśnienie czerwonych checks na dokładnym SHA, brak rozjazdu publicznego API z generowanym klientem, spójność nowego wyboru portu oraz kontrola ekspozycji niekwalifikowanej starszej bazy.

## 2. Zakres dowodów i ograniczenia

W przekazanym poleceniu pozostał placeholder `[WKLEJ PEŁNY SHA]`. Do recenzji przyjąłem odczytany checkpoint brancha wskazany powyżej; nie zastępowałem go późniejszym HEAD. GitHub compare potwierdził jeden commit względem `41a5b893…` oraz 285 commitów ahead, 0 behind względem przypiętego mastera. Ten master jest wspólnym przodkiem.

Dostęp do rzeczywistych plików przez connector działa. Duże odpowiedzi są jednak obcinane w prezentacji. Odczytywałem pełne mniejsze pliki i konkretne zakresy dużych plików oraz sprawdzałem producentów i konsumentów krytycznych danych. Zbiorcze porównanie całej gałęzi udostępnia ograniczoną listę 300 plików; nie jest kompletnym audytem wszystkich zmian 285 commitów. Nie utożsamiam zerowych statystyk dalszych pozycji obciętego porównania z brakiem zmian.

Raport nie poświadcza pełnego przejrzenia każdej linii dokumentacji historycznej, wszystkich ADR ani wszystkich implementacji CPU/GPU. Tam, gdzie brak bezpośredniej inspekcji lub wykonania, stan pozostaje niezakwalifikowany. Nie stwierdzam braku funkcji jedynie dlatego, że nie odczytałem jej implementacji.

Nie uruchamiałem ani nie kompilowałem testów Rust. Nie uruchamiałem testów Python, solvera, przeglądarki ani sceny użytkownika. Opisy reprodukcji poniżej są **proponowanymi eksperymentami**, a nie wynikami wykonanymi podczas recenzji. Zakaz kompilowania testów jednostkowych nie został obchodzony.

### Aktualizacja stanu checks

Odczyt check-runs dla dokładnego SHA zawierał 14 rekordów. W widocznym zakresie potwierdziłem m.in.:

| Check | Stan terminalny | Co z tego wynika |
|---|---|---|
| `build`, ID `114566115214` | `failure` | Ten check nie przeszedł. Nie ustalono z samej nazwy, który komponent się nie zbudował. |
| `control-room-contracts`, ID `114566115164` | `failure` | Bramka kontraktów nie jest zielona. Przyczyna nie została ustalona. |
| `fdm-relaxation-qualification`, ID `114566115159` | `success` | Sukces tej bramki nie kwalifikuje sam w sobie antenowego precompute/projection/LLG. |
| `deploy`, ID `114566278004` | `skipped` | Brak wykonanego deploymentu w tym checku. |

Connector odmówił odczytu endpointu adnotacji checks. Nie przypisuję ich porażek konkretnemu findingowi ani nie twierdzę, że `build` oznaczał natywny build anten. Wcześniejsza obserwacja kolejki nie jest aktualnym werdyktem. Nie otrzymałem manifestów i terminalnych receipts lokalnych zarządzanych buildów 56/67 pozwalających przypisać ich wynik do tego SHA.

Liczby **17/155, 138 otwartych, 0/19 i 7 końcowych bramek** traktuję jako przekazaną inwentaryzację autora, nie własne ponowne przeliczenie całego dokumentu. Nie używam ich do procentowej wyceny gotowości. Historyczne 10/10 Python PASS nie zostało przeze mnie powtórzone.

## 3. Co faktycznie poprawia checkpoint

### 3.1. Standalone bez magnetyzacji

`AntennaStandaloneAuthoringTests` sprawdza nie tylko obecność tekstu. Fixture jest wykonywany na poziomie DSL, eksportowany, importowany i porównywany jako IR. Są przypadki bez `magnets`, `energy_terms` i dynamiki oraz rozdzielenia snapshotu anteny od późniejszego Relax/Run. Testy takie nie wykonują solvera, ale są adekwatniejsze niż grep źródeł do weryfikacji round-trip.

`accepted_antenna_inspection_worker::prepare` wymaga osobnego primitive antenowego, jednego wyjścia `inspection/Artifact`, CPU lease bez budżetu GPU, FEM strict/double i natywnego silnika bez fallbacku. Odrzuca wejścia, czas końcowy, parametry/seeds bez adaptera i rozbieżność z kanonicznym planem. Jest to rzeczywisty fail-closed, nie zwykła etykieta w UI.

### 3.2. Identyfikatory i przygotowanie

`materialize_script_pipeline_with_output_policy_bounded` zachowuje drzewo autora, jego hash, przodków grup i indeksy ekspansji. ID wykonania ma postać `script-execution-<digest>`, a nie surowego tekstu autora użytego jako segment ścieżki. Grupa sama nie staje się solve. To lokalnie poprawny kierunek; pozostaje połączenie z accepted lowering.

`materialize_run_intent` wiąże snapshot projektu, hash Study i katalogu, jawny run/idempotency oraz hashe wskazanych assetów. `run_intent_preparation::prepare_identity` pracuje na dostarczonym archiwum i już skompilowanych danych, bez accepted-store, admission czy uruchamiania solvera. CLI `prepare_run_json` ma rzeczywisty transport HTTP, waliduje odpowiedź i nie wykonuje automatycznego Submit.

### 3.3. Pakiet i odczyt danych

Accepted reader odróżnia Study step ID od native stage ID. Sprawdza run/project, task, attempt, epoch, manifest, publikację katalogu i CAS. Pakiet ma magic `FMANTPK1`, długości, granice rozmiaru, kontrolę trailing bytes i walidację payloadów. ETag uwzględnia ownership, nie tylko zawartość numeryczną.

Nie stwierdzam tu błędu polegającego na samym pomyleniu ID autora i ID wyniku. Nie stwierdzam też, że nowe endpointy nie zostały zarejestrowane: router zawiera nowe trasy. Problem dotyczy m.in. generowanego klienta, nie wyłącznie obecności handlera.

### 3.4. UI ma prawdziwy Inspector antenowego kroku

`AntennaFieldSolveStageInspector` pokazuje definicję, źródło, transport, port i declared outputs; zgłasza błędne referencje i ostrzega, że deklaracja nie jest wynikiem solve ani bazą H/I. `useAntennaFieldOverlay` korzysta z resource hooks, sprawdza session/epoch/scope/source oraz rozdziela domeny i quantities: V na węzłach urządzenia, J jako reprezentację komórkową/ślady, H na nośniku próbkowania. Nie przypisuje antenie magnetyzacji.

Obecność tych kontroli nie dowodzi stabilności SSR, pending/ACK, kamery ani realnego renderingu solverowych danych.

## 4. Tabela T00–T18

Znaczenie stanów: `verified` wymaga dowodu adekwatnego do całego wymagania; `implemented_unqualified` oznacza zaimplementowaną funkcję bez kwalifikacji; `partial` — częściowy łańcuch lub otwarte warunki akceptacji; `missing` — brak wykazanej wymaganej integracji/rezultatu, nie twierdzenie o braku każdego helpera. Ocena dotyczy pełnych etapów, a nie pojedynczych zamkniętych checkboxów. **Nie potwierdzam zamknięcia całego żadnego etapu.**

| Etap | Wymaganie | Faktyczna implementacja / dowód | Brakujący krok | Stan |
|---|---|---|---|---|
| T00 | Stabilny punkt odniesienia i integracja z master | SHA i merge-base ustalone; najnowszy przyrost oddzielony od całej gałęzi | Pełny inwentarz porównania i nieantenowe regresje mastera; lista 300 plików jest ograniczona | `partial` |
| T01 | Odtwarzalne bramki i fixtures | Istnieją testy standalone i harness prawdziwego workera; odczytane źródła nie są wyłącznie grepami | Receipt uruchomienia dla tego SHA, manifesty, wyjaśnienie czerwonych checks | `partial` |
| T02 | Porty, terminale, orientacja i migracja | Planner i raw request-binding sprawdzają źródło, port, gałęzie i żądane prądy | Kwalifikacja podpisanych prądów i kompletności zamknięcia dla docelowej geometrii microstrip | `partial` |
| T03 | SceneDocument, Python i stage API bez utraty intencji | Testy rzeczywistego eksportu/reimportu; osobny Study; kompilacja zachowująca ekspansje | Produkcyjny producer accepted StudyPlan/katalogu/zależności z tej kompilacji | `partial` |
| T04 | Rzeczywista geometria 3D, doprowadzenia i return | Panele nadal rozróżniają MicrostripAntennaLayout i CPWAntennaLayout; raw planner używa niezależnego meshu urządzenia | Odbiór geometrii po transformacjach, terminalach i remeshu; bez zastępowania microstrip przez CPW | `partial` |
| T05 | Integral-current i znak normalizacji | Istnieje pomiar prądów terminalnych i osobna ścieżka konserwatywna | W starszej bazie połączyć mianownik H/I z tym samym źródłem RT0, które generuje H — B-01 | `partial` |
| T06 | Konserwatywny prąd i pole 3D | Raw worker/owned bundle, walidacja żądania, RT0/Oersted; starszy producent pozostaje rozdzielony | Wspólny V/J/H/current certificate oraz zbieżność siatki/kwadratury/closure — B-01/B-03 | `partial` |
| T07 | Wspólny waveform i jawna aktywacja | `DriveActivationIR::is_active_for`: all_time_evolution nie obejmuje Relax; istnieją deklaracje obu zegarów | Dowód zachowania właściwego zegara i aktywacji przez cały compiler/runtime; skoki przebiegu i Relax | `partial` |
| T08 | Integralność, aktualność i reference resolution | Silne walidacje pakietu i accepted ownership; raw nie jest automatycznie bazą | Kwalifikacja signature/invalidation całej bazy, projekcji i wielokrotnego użycia, nie tylko raw package | `partial` |
| T09 | Maski i projekcja na właściwy target | Overlay rozróżnia nośniki V/J/H; raw planner odmawia użycia jako target projection | Odtwarzalna projekcja bazy do właściwej przestrzeni FEM/FDM, maski i outside policy | `partial` |
| T10 | Przestrzenne widmo źródła i faza | Deklaracje/zasoby/panele source spectrum są obecne; raw źródło jest od tej capability odcięte | Zweryfikowana transformacja rzeczywistej kwalifikowanej bazy, faza fizycznego origin i porównanie DFT | `partial` |
| T11 | Ważność modelu i budżet kosztu | Odczytany preflight direct Oersted ma checked source×target i budżet globalny | Mierzone koszty realistycznego modelu, budżet RAM publikacji/odczytu, jawna ważność przybliżeń | `partial` |
| T12 | Lifecycle, cache, anulowanie, publikacja | Accepted identity, attempt/epoch, pakiet CAS; worker sprawdza cancellation przed/po native solve | Crash/fault injection, restart, retry fencing i odbiór trwałości; native solve jest niepreemptive | `partial` |
| T13 | Kwalifikacja FEM LLG | Kontrakty aktywacji i źródeł są obecne; ścieżka raw nie może być użyta jako solved drive | Pełne source→basis→projection→RHS→trajectory na FEM CPU; osobna kwalifikacja GPU | `partial` |
| T14 | OpenAPI, typed resources i realtime | Nowe handlery i rejestracja routera istnieją | Brak nowych tras w generowanym katalogu klienta; integracja UI accepted resources i odbiór realtime — R-01 | `partial` |
| T15 | Pełny Explorer/Inspector, drafty i wizualizacja | Osobny Inspector kroku, composer, transakcja authoring, resource hooks i kontrola ownership | Realny browser E2E z danymi native oraz pending/ACK, remount/subscription/WebGL/camera checks | `partial` |
| T16 | FEM precompute → FDM CPU/GPU | Architektura przewiduje niezależny producer i consumer; nie jest to FDM solve przewodnictwa | Kwalifikacja projekcji i RHS/trajektorii oddzielnie dla CPU/GPU i precyzji; brak dowodu parity | `partial` |
| T17 | Frequency response bez pozornych eigenmodes | Sam ogólny solver/typ FrequencyResponse nie potwierdza antenowego wymuszenia | Brak wykazanej kwalifikowanej integracji tej bazy z zespolonym wymuszeniem; pozostawić unavailable | `missing` dla wymaganego workflow |
| T18 | Dokumentacja, dowody, reaudyt i końcowe bramki | Plan i source-map jawnie opisują część ograniczeń; aktualny przegląd wykazuje postęp | Artefakty tego SHA dla wszystkich obiecywanych capabilities; brak końcowego odbioru | `partial` |

Dla T09/T10/T13/T16/T17 nie poświadczam pełnego audytu wszystkich operatorów numerycznych. Tabela wskazuje brak kwalifikacji ścieżki od recenzowanego producenta, nie automatyczny brak starszego kodu danego operatora.

## 5. Znaleziska

### B-01 — Blocker fizyczny: reusable basis łączy dane z dwóch źródeł prądu

**Lokalizacja:** `crates/fullmag-runner/src/native_fem/charge_transport.rs`, `execute_native_fem_charge_transport`, `charge_request_for_rt0`, `execute_native_fem_antenna_field_solve_plan_interruptible`; powiązany `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp`, `solve_rt0`.

**Dowód i mechanizm.** Pierwsze `solve_native_fem_charge_transport` daje V, J i mierzone prądy. Następnie `solve_native_fem_steady_transport_rt0` wykonuje osobną realizację, z której pochodzi H i certificate RT0. Przy budowie `AntennaFieldBasisInput` V/J i `measured_positive_terminal_current_a` pochodzą z pierwszego result, a `magnetic_field_xyz_apm` i certificate z RT0. Native closed-geometry konstruuje osobny `PeriodicChargePotentialSolveRequest` z source cut. Nie ma na tej granicy wykazanego powiązania pierwszego mierzonego prądu ze źródłem faktycznie użytym przez H.

**Skutek.** Mały residual i zerowy bilans RT0 nie dowodzą poprawnej normalizacji per A ani tego, że pokazane V/J i H należą do jednego rozwiązania fizycznego. Jeżeli prąd źródła H różni się od mianownika normalizacji, otrzymujemy pozornie poprawny i integralny plik z błędną amplitudą pola. Nie twierdzę, że wykonałem przykład z liczbowo błędnym H; potwierdzony jest brak wspólnego kontraktu producenta.

**Pochodzenie.** Ten plik ma identyczny blob SHA `58df13c4af44ba19fca8ddd353f7f8f9d82f1e45` w parent `41a5b893…` i w recenzowanym SHA. To wcześniejszy problem brancha, nie regresja checkpointu. W przypiętym masterze ten path zwrócił 404; nie jest to dowód, że analogicznej semantyki nie było gdzie indziej.

**Proponowana reprodukcja.** Na izolowanym fixture z dotychczasowej ścieżki porównać signed terminal currents pierwszego solve z prądami źródła RT0. Utrzymać żądanie portu, zmienić kontrolę closure/source cut w dozwolonym modelu i sprawdzić spójność H/I. Alternatywnie wstrzyknąć poprawny wewnętrznie wynik RT0 o innym prądzie i wymagać odmowy publikacji basis. To nie powinien być test samego hasha.

**Naprawa.** Jeden zaakceptowany current-driven snapshot/workspace powinien dostarczać V, konserwatywny prąd, H oraz podpisany mianownik normalizacji. Osobna kontrola ma potwierdzać zgodność każdego terminalu i źródła Oersteda. Nie wystarczy skopiowanie certificate albo zmiana nazwy quantity. Do naprawy i kwalifikacji tej ścieżki reusable należy ją oznaczyć unavailable albo jawnie niekwalifikowaną.

**Rozróżnienie.** Nowy raw external-lead bundle jest osobną ścieżką; tego findingu nie przenoszę automatycznie na jej wewnętrzną zgodność.

### B-02 — Blocker integracji produktu: compilation nie zamyka accepted pipeline

**Lokalizacja:** `crates/fullmag-application/src/script_pipeline_compilation.rs::materialize_script_pipeline_with_output_policy_bounded`; `crates/fullmag-authoring/src/scene_study_plan.rs::scene_document_to_study_plan`; `crates/fullmag-api/src/router_v2/handlers/persistence/run_intent_preparation.rs::prepare_identity`; `crates/fullmag-cli/src/accepted_run_transport.rs::prepare_run_json`; `crates/fullmag-api/src/accepted_antenna_inspection_worker.rs::prepare`.

**Mechanizm.** Nowy wynik kompilacji przechowuje authored tree i executions, ale nie StudyPlan, katalogu i portów/zależności. Projekcja SceneDocument nadal używa `StudyPlan::from_pipeline`, a przygotowanie API/CLI wymaga dostarczenia wcześniej skompilowanego StudyPlan i katalogu. Flat projection tworzy kroki z pustymi inputs. Worker raw odrzuca zarówno study inputs, jak i resolved inputs.

**Skutek.** Nie ma wykazanego produkcyjnego łańcucha zachowującego jednocześnie mutatory, ekspansje, bezpieczne ID i kolejność accepted wykonania. Nie twierdzę na tej podstawie, że scheduler zawsze wykonuje kroki w złej kolejności; twierdzę, że sama nowa lista snapshots/ID nie dostarcza wymaganego kontraktu ani dowodu.

**Pochodzenie.** Nowy compiler to postęp w tym przyroście. Luka jest niedomknięciem integracji, nie udowodnioną regresją istniejącego numerycznego solve.

**Proponowana reprodukcja.** Pipeline zawierający mutator, grupę, dwa wykonania tej samej definicji, wyłączony węzeł, Relax i Run przeprowadzić od Python/Scene do accepted workerów przy concurrency > 1. Mutator/grupa nie mogą tworzyć solve; dwa wywołania muszą mieć różne execution/task IDs i właściwe snapshoty; kolejność wymagana przez autora musi być widoczna w journalu. Użyć także ID autora ze znakami niedozwolonymi w ścieżkach magazynu.

**Naprawa.** Podłączyć jeden application-owned producer StudyPlan/katalogu do wyniku rzeczywistej kompilacji. Zależność sterowania modelować osobno od Artifact data input. Nie dodawać fikcyjnego input portu do raw worker, który nie ma adaptera takich danych. Nie dublować ekspansji/mutacji w frontendzie lub CLI.

### B-03 — Blocker celu produktu: raw V/J/H nie jest dostępną bazą H/I

**Lokalizacja:** `crates/fullmag-plan/src/antenna_field_solve.rs::plan_antenna_field_solve_execution`, `plan_antenna_external_lead_inspection`; `crates/fullmag-api/src/accepted_antenna_inspection_worker.rs::prepare/execute`.

**Mechanizm.** Dla `conservative_current_source` planner zwraca osobny plan raw inspection i odmawia referencji target projection/source spectrum do tego solve. Worker publikuje pakiet inspekcji, bez magnetic state i bez adaptera danych wejściowych.

**Skutek.** Na tej ścieżce cel solve once → signed H/I → target → Relax/Run → źródłowe FFT nie jest ukończony. Widoczna mapa H nie dowodzi, że ta sama baza jest użyta w RHS.

**Pochodzenie.** To świadomie zachowana granica WIP, nie błąd samego fail-closed. Blokuje wydanie capability, nie wymaga usunięcia odmowy przed implementacją.

**Proponowana reprodukcja.** Do poprawnego raw source dodać projekcję odwołującą się do tego samego stage. Oczekiwana aktualna odmowa: `source_not_qualified`. Nie kwalifikować tego jako pozytywnego testu LLG.

**Naprawa.** Po zamknięciu B-01/fizyki utworzyć jawny typ i producenta bazy z signed reference current, jednostkami, source/mesh/material/terminal/solver signatures oraz osobną projekcją. Dopiero potem umożliwić runtime consumer. Zachować osobny typ i opis raw H.

### R-01 — Required: nowy backend API i generowany frontend są niespójne

**Lokalizacja:** `crates/fullmag-api/src/router_v2/mod.rs::build_v2_router`; `.../persistence/run_intent_preparation.rs::prepare`; `.../data/accepted_antenna_resource.rs::get_accepted_antenna_catalog/get_accepted_antenna_inspection`; `.../data/accepted_antenna_payload.rs::get_accepted_antenna_payload`; `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts` — wygenerowany katalog ścieżek.

**Mechanizm.** Router zawiera nowe trasy przygotowania RunIntent oraz catalogue/metadata/payload accepted inspections. W odczytanym generowanym katalogu klienta tych tras nie ma. Starsze ścieżki Live anten są obecne. Odczytany overlay korzysta z session-bound zasobów; nie dowodzi konsumpcji nowych durable routes.

**Skutek.** Sam handler i adnotacja OpenAPI nie zamykają kontraktu browsera; integracja nowego API nie ma kompletnego typowanego artefaktu. Nie przypisuję temu findingowi automatycznie przyczyny czerwonego `control-room-contracts`.

**Pochodzenie.** Nowe trasy dodano w recenzowanym przyroście; wygenerowane pliki klienta nie są częścią tego przyrostu.

**Proponowana reprodukcja.** Z dokładnego dopuszczonego buildu wyeksportować OpenAPI, porównać cztery nowe path/method z generated client i uruchomić izolowany test facade/resource→HTTP. W aktualnym źródle rozjazd katalogu jest już widoczny statycznie.

**Naprawa.** Regeneracja z przypiętego backendu; typed facade i resource keys zawierające pełne run/step/attempt/epoch/package identity. Widok nie powinien sam tworzyć URL/fetch ani wybierać „najnowszego” wyniku. Sprawdzić też realny wygenerowany dokument, nie tylko wpisy makra OpenAPI.

### R-02 — Required: Range i 304 nie ograniczają kosztu pełnego decode

**Lokalizacja:** `.../data/accepted_antenna_payload.rs::get_accepted_antenna_payload`; `.../data/accepted_antenna_inspection.rs::load_accepted_antenna_inspection`; `crates/fullmag-antenna-artifacts/src/package.rs::decode_antenna_inspection_package`.

**Mechanizm.** Handler ładuje i waliduje cały pakiet, wybiera payload i wylicza ETag, a dopiero potem stosuje odpowiedź warunkową/Range. Decoder kopiuje payloady i waliduje ich pełną zawartość. Reader dodatkowo wiąże wynik z accepted planem. Analogicznie odczyt cienkich metadanych może angażować pełne dane numeryczne.

**Skutek.** Małe żądanie lub 304 nie oznacza małej alokacji i małego kosztu CPU. Przy wielu klientach pełny decode może się mnożyć. Istnieją granice rozmiaru i fallible allocations, więc nie jest to stwierdzenie „decode jest nieograniczony”. Nie zmierzyłem RSS ani nie wykazałem OOM.

**Pochodzenie.** Dotyczy nowej ścieżki accepted payload/package w tym przyroście.

**Proponowana reprodukcja.** Dla poprawnego dużego pakietu porównać pełny GET, `Range: bytes=0-23` i `If-None-Match` z trafionym ETag; zmierzyć RSS, liczbę dekodowań, odczytane bajty i kolejkę przy równoległości 1/4/16. Wymagać jawnego limitu pamięci dla całego procesu, nie tylko jednego payloadu.

**Naprawa.** Cache zweryfikowanego immutable package/index z pełnym ownership key i ponowną kontrolą aktualności; ewentualnie osobne CAS payloads/index w wersjonowanym formacie. Deduplicacja inflight decode i backpressure. Nie wolno oszczędzać przez pominięcie hasha, request binding lub sprawdzenia bieżącego attempt.

### R-03 — Required: UI pozwala wybrać port, który raw planner następnie odrzuca

**Lokalizacja:** `apps/control-room/src/kernel/runtime/antennaFieldSolveStudyCommand.ts::antennaFieldSolveStudyStages`; `apps/control-room/src/modules/inspector/panels/stages/AntennaFieldSolveStageInspector.tsx::AntennaFieldSolveStageInspector`; `crates/fullmag-plan/src/antenna_field_solve.rs::plan_antenna_field_solve_execution`.

**Mechanizm.** UI akceptuje jeden jawnie wybrany port z `definition.port_mode_ids` zawierającego wiele poprawnych pozycji. Inspector ocenia taki wybór jako zgodny. Raw planner nadal wymaga `stage.port_mode_ids.len() == 1`, czyli jednego portu w całej definicji, niezależnie od wyboru.

**Skutek.** Użytkownik może poprawnie dodać etap przez nowe UI, ale przygotowanie kończy się odmową. Nie jest to podwójne skalowanie prądu ani cichy fallback — to niespójny zakres authoringu i realizacji.

**Pochodzenie.** Defekt nowej granicy UI→planner; nie wykazano regresji wcześniej działającego wieloportowego solve.

**Proponowana reprodukcja.** Jedna poprawna definicja raw z dwoma zadeklarowanymi portami; jawnie wybrać jeden w composerze, następnie wykonać preflight dokładnie tego IR. Sprawdzić błąd o wymaganym jednym independently selected port per dedicated stage.

**Naprawa.** Albo jawnie zablokować taki authoring według rzeczywistej capability, albo poprawić realizację wyboru pojedynczego portu bez mutowania autorskiej definicji i bez udawania wieloportowego solve. Test musi przejść UI→export→IR→planner, a nie tylko helper UI.

### R-04 — Required dowodowe: ekstrakcja crate wymaga kwalifikacji zgodności formatów

**Lokalizacja:** `crates/fullmag-antenna-artifacts/src/package.rs::encode_antenna_inspection_package/decode_antenna_inspection_package`; `crates/fullmag-runner/src/native_fem/accepted_external_lead/record.rs::decode_bundle/validate_bundle_request/bind_preflighted_request`.

**Obserwacja.** Nowy crate nie ma zależności od runnera ani natywnego solvera. Dekodowanie moved bundle jest delegowane do crate, ale w runnerze pozostaje jawny request binding: charge inputs, closure revision, partitions, boundary roles/circuit IDs, branch currents, target points i quadrature policy. Nie stwierdziłem usunięcia tej kontroli.

**Ryzyko.** Poprawny kierunek zależności i obecność walidacji nie dowodzą zachowania wszystkich wcześniejszych reject cases ani poprawnego linkowania feature combinations. Testy Rust w źródłach nie zostały wykonane w tej recenzji i nie wolno obejść zakazu ich budowania.

**Proponowana weryfikacja.** Dla zatwierdzonego środowiska kwalifikacyjnego: golden bytes sprzed ekstrakcji i po niej, version/hash mismatch, duplicate keys, overflow/cardinality, trailing data, zmienione terminale/targety/polityka oraz build produkcyjnych binariów z właściwymi features. Uruchomienie unit tests dopiero po zniesieniu zakazu; obecnie pozostają jawnie niewykonane.

**Działanie.** Zachować rozdział structural integrity i binding do żądania. Nie zgłaszać usuniętej funkcjonalności bez konkretnego kontrprzykładu; warunkiem odbioru są adekwatne artefakty, nie kosmetyczny refaktor.

### S-01 — Suggestion: odróżnić istniejącą akcję od aktywnej akcji

**Lokalizacja:** `apps/control-room/src/kernel/runtime/antennaFieldSolveStudyCommand.ts::antennaFieldSolveStudyStages`.

Przy odnalezieniu zgodnej referencji w drzewie helper zwraca `alreadyAdded`, nie analizując efektywnego enablement węzła i jego grup. Komunikat „already in Study” jest prawdziwy i nie oznacza błędnej fizyki, ale może nie wyjaśnić, dlaczego krok nie wykona się. Reprodukcja: zgodny etap w wyłączonej grupie, ponowne Add Field Solve. Warto pokazać istniejący, lecz nieaktywny krok i zaproponować jawne przejście do jego aktywacji; nie włączać grupy automatycznie.

## 6. Macierze kwalifikacji

### 6.1. Backendy

| Backend | Solve przewodnictwa/raw H | Użycie bazy w LLG | Wynik recenzji |
|---|---|---|---|
| FEM CPU | Dedykowany raw worker i native preflight, strict/double, bez fallbacku są w kodzie | Starsza baza ma B-01; nowy raw nie jest bazą | `not_qualified` dla pełnego workflow; lokalne kontrakty zaimplementowane |
| FEM GPU | Nowa raw ścieżka odrzuca wymuszone GPU | Brak dowodu antenowej RHS/trajectory i projekcji dla tego SHA | `not_qualified`; CPU precompute nie jest dowodem GPU solve |
| FDM CPU | Nie jest realizacją tego FEM source solve | Wymaga jawnego FEM precompute i projekcji na komórki/maski FDM | `not_qualified`; sukces ogólnej relaksacji FDM tego nie zmienia |
| FDM GPU | Nie jest realizacją tego FEM source solve | Osobna kwalifikacja projected basis, upload/residency i RHS/trajectory | `not_qualified`; brak dowodu parity i brak prawa do cichego fallbacku |

Dla single i double potrzebne są osobne dowody. W obecnej ścieżce raw FEM CPU wymagane jest double. Dopuszczenie `device=auto` rozwiązanego i zapisanego jako CPU nie jest samo w sobie cichym fallbackiem; wymuszone GPU jest odrzucane.

### 6.2. Warstwy

| Warstwa | Potwierdzona obserwacja źródłowa | Brak dowodu |
|---|---|---|
| Python / authoring | Samodzielny Study, rzeczywiste testy round-trip i brak dopisywania magnetyzacji | Niezależne wykonanie 10 testów na tym SHA; pełny authored pipeline do accepted workerów |
| IR / planner | Rozdzielenie fizycznego selection i author ID; raw fail-closed; preflight wykonania | Cały łańcuch obu wersji IR, wszystkich złych referencji i hash sensitivity w uruchomionych testach |
| Application / accepted runtime | Osobny worker, immutable preparation, jawny intent; CLI prepare nie submituje | Wieloetapowa kompilacja, kolejność, crash/retry/cancel i actual receipts dla tego SHA |
| API / dane | Router, CAS/identity checks, silny ETag, rozdzielenie raw/basis | Aktualny generated client, terminalne API runtime receipts, budżet decode przy concurrency |
| UI | Inspector kroku, resource hooks, kontrola domen i ownership, authoring transaction | Browser E2E na realnych danych, SSR, ACK/drafts, render poprawnych wartości, kamera i subscriptions |
| Nauka | Kontrakty SI i raw/source boundary; wykryty brak wspólnej bazy | Closed-current zbieżność, signed H/I, analityczne pole, target projection i m(k,ω) |

### 6.3. Nierozstrzygnięte szczegóły

Nie stwierdziłem konkretnego miejsca z podwójnym μ0 w odczytanej ścieżce raw. Nie jest to dowód braku takiego błędu w całym LLG CPU/GPU. Nie kwalifikuję identyczności formatów wszystkich przeniesionych decoderów na podstawie samej liczby usuniętych/dodanych linii. Nie kwalifikuję wszystkich Inspectorów, shaderów, subskrypcji ani braku WebGL remountów na podstawie jednego hooka.

Brakuje również pełnego dowodu pinowania profili i wszystkich execution layers przez admission dla recenzowanego scenariusza. Odczytane preparation zachowuje jawny intent, ale publikowane profile wymagają osobnego sprawdzenia w Submit. Nie należy tego rozwiązywać przez wykonywanie admission wewnątrz prepare.

## 7. Plan dalszej pracy — zależności i mierzalny odbiór

Poniższe progi testów naukowych są **propozycją odbioru**, nie raportem uzyskanej dokładności. Próg przyjęty do produktu musi być zapisany przed uruchomieniem testu i dostosowany do normy, geometrii oraz tolerancji solvera.

### M0. Dowód wykonania przypiętego checkpointu

**Wejście:** dokładny SHA, source manifest, toolchain/features i image digest. Wyjaśnić aktualne czerwone checks, bez zgadywania ich przyczyn. Nie przypisywać buildów 56/67 nowszemu kodowi.

**Odbiór:** terminalny receipt produkcyjnego buildu i wyników dopuszczonych bramek zawiera ten sam SHA/source hash i hashe binariów. Rust unit tests oznaczyć `not_run` do zniesienia zakazu. Żaden green z innego SHA ani nazwa joba nie zamyka capability.

### M1. Jedna kompilacja authoringu do accepted Study

**Zależność:** M0 dla wykonywalnego odbioru; implementacyjnie można przygotowywać równolegle.

Zamknąć B-02 i R-03. Producer musi zużyć rzeczywiste compilation result, zachować author tree i mapping do safe execution IDs, zbudować katalog z pełnym ProblemIR selection, a następnie StudyPlan z właściwymi zależnościami. Idempotency nie może zastępować identity fizycznej.

**Odbiór:** fixture z grupą/mutatorem/dwoma wywołaniami tej samej definicji/disabled/Relax/Run oraz wariant flat daje oczekiwaną liczbę solve, snapshotów i tasków. Zmiana jawnego selection zmienia odpowiedni digest; błędny jawny selection zawsze odmawia, także przy istnieniu jednej poprawnej alternatywy. Żaden author ID nie jest niezweryfikowanym path component. Journal potwierdza zależności przy concurrency > 1.

### M2. Pełny standalone V/J/H z durable result i typed UI

**Zależność:** M1; zachować raw-only scope.

Zamknąć API/client drift, przygotowanie bez Submit, właściwe publication-before-completed, accepted reader i kontrolowany wybór konkretnego wykonania w UI. Model testowy musi być microstrip z osobnym przewodnikiem, doprowadzeniami i jawnym return; CPW pozostaje osobnym wariantem, nie zamiennikiem.

**Odbiór:** Python/UI authoring → export/reimport → prepare → jawny Submit → native solve → CAS → completed receipt → odczyt przez nowy proces → V/J/H we właściwych jednostkach/domenach. Zero kroków LLG/Relax i brak m na antenie. Testy uszkodzenia payloadu/manifestu, zmiany attempt/epoch, przerwania przed publikacją i po zapisie CAS nie mogą dać pozornego completed ani starego overlay. Range/304/concurrency mają zmierzony limit RSS i backpressure. Test odczytu po ponownym uruchomieniu procesu nie zastępuje testu awarii durable storage.

### M3. Kwalifikacja wspólnego źródła i podpisanej bazy H/I

**Zależność:** wspólne raw source z M2; zamknąć B-01 przed promocją bazy.

Przy konwencji outward normal dla dodatniego przepływu inlet→outlet całki terminalne wynoszą odpowiednio -I i +I; orientation musi być zapisana jawnie. Dla każdego terminalu weryfikować jego własny błąd, a nie maskować małej gałęzi skalą największego prądu. Lokalna ciągłość RT0, globalny bilans i zgodność z prescribed current to różne kryteria.

**Odbiór:** analityczny jednorodny przewodnik dla V/J; zamknięty obwód i znany benchmark pola; co najmniej trzy poziomy siatki, refine kwadratury i warianty długości/położenia return. Testy I=+I0, -I0, 2I0, gauge shift i rotacji całego układu. W kontrolnym problemie liniowym proponowany relative defect testu liniowości ≤1e-6, o ile solver/kwadratura są rozwiązane dostatecznie dokładnie; błąd względem pola referencyjnego ≤1% poza wydzielonym obszarem osobliwości/krawędzi, z udokumentowaną zbieżnością. Certyfikat normalizacji musi odnosić się do tego samego źródła co H.

Baza K(r)=H(r;Iref)/Iref musi być niezmienna przy zmianie wyłącznie amplitude/waveform. Jej manifest ma przechowywać signed Iref i convention. H[A/m] i K[A/m/A] pozostają osobnymi quantities; B=μ0H wolno stosować tylko na właściwej granicy wymagającej indukcji w modelu niemagnetycznego ośrodka odniesienia.

### M4. Projekcja i aktywowane LLG dla odrębnych backendów

**Zależność:** M3.

Zdefiniować projekcję P na target, włącznie z origin, topology, maską regionu i outside policy. Dla liniowego modelu używać Htarget(t)=I(t) P[K], nie drugiego mnożnika prądu na już przeskalowanym H. Waveform nie może mutować assetu basis.

**Odbiór:** porównanie projected field z bezpośrednią oceną na identycznych punktach; jawny test pary reprezentacji H i B oraz jednostek gamma w rzeczywistym RHS. W testach 0/+I/-I/2I pole i odpowiednia część RHS skalują się zgodnie z kontraktem. Licznik source solve wynosi 1 dla niezmienionej liniowej bazy; zmiana waveform nie zwiększa licznika, zmiana source geometry/material/terminal policy zwiększa go po invalidation. Zmiana tylko targetu unieważnia projekcję, niekoniecznie źródło. RF w domyślnym Relax pozostaje nieaktywne; jawne statyczne bias/activation jest osobno testowane. Testować także reset stage-local time i discontinuities.

Osobne receipts: FEM CPU, FEM GPU consumer, FDM CPU consumer, FDM GPU consumer; precyzje odrębne. Brak realizacji daje unavailable/not_qualified, nigdy sukces przez niejawny CPU fallback.

### M5. Widmo źródła i odpowiedź magnetyczna

**Zależność:** M3 dla H(k), M4 dla m(k,ω).

**Odbiór H(k):** prawdziwe pozycje/spacing i origin; jawne okno, normalizacja i jednostki rad/m; porównanie do bezpośredniej DFT na tym samym nośniku. Translacja źródła o a daje fazę exp(-ika) przy konwencji exp(-ikx), bez sztucznej zmiany mocy. Testy zero-padding, Nyquista, niejednorodnego próbkowania i complex phase nie mogą opierać się tylko na zgodności |FFT|.

**Odbiór m(k,ω):** osobny eksperyment falowodu z anteną i zapisem m(r,t); odejmowanie stanu równowagi, jawne okna czasu/przestrzeni i rozdzielenie odpowiedzi od source spectrum. Porównać propagację, odbicia i selektywność z tym samym modelem oraz właściwym rozwiązaniem odniesienia. Nie nazywać samego H(k) dyspersją propagujących fal ani odpowiedzi m — S21 bez detektora.

### M6. Końcowy browser i release audit

**Zależność:** M2–M5 oraz wszystkie deklarowane backendy.

**Odbiór:** create microstrip → geometry/terminals/return → mesh → solve → inspect V/J/H → basis/target → Relax/Run → source/response FFT → export/reload → waveform reuse → geometry stale. Przy wymuszonym opóźnieniu ACK draft nie znika, wynik nie staje się ready przed publikacją, stary request nie nadpisuje nowego wyboru. Potwierdzić brak nieoczekiwanego remountu viewportu, stałą liczbę subscriptions, poprawną kamerę, niezerowy drawing buffer i brak utraty WebGL context. Sprawdzić wartości i domeny danych, nie wyłącznie obecność canvas.

Na końcu aktualizować T00–T18 i capability matrix na podstawie artefaktów, nie odwrotnie. Frequency response pozostaje unavailable do osobnego testu fazy/amplitudy i definicji operatora; RF, S-parametry, skin/proximity i inne modele spintroniczne nie są dopisywane do capability tego solve.

## 8. Deklaracje, których nie należy uznawać za potwierdzone

| Deklaracja | Ocena |
|---|---|
| „Standalone authoring = pełny standalone workflow” | Testy DSL/round-trip nie są solve + durable publication + browser E2E. |
| „Compiler pipeline jest zintegrowany” | Nowy compilation result nie jest jeszcze demonstrated producer accepted StudyPlan/katalogu/zależności. |
| „Pole raw H to baza na 1 A” | Kod rozdziela te wyniki i odmawia promocji raw source; jednostka/nazwa nie stanowi dowodu normalizacji. |
| „Dobry bilans RT0 potwierdza normalizację publikowanej bazy” | Nie dla starszego producenta z B-01; potrzebna zgodność prądu tego samego źródła. |
| „Nowy crate zachowuje wszystko, bo przeniesiono kod” | Zachowane request binding potwierdzone lokalnie; pełna parity formatów i feature build pozostaje niezakwalifikowana. |
| „Endpoint działa, bo ma handler/OpenAPI” | Router jest, ale typed client jest nieaktualny i runtime receipt nie został odczytany. |
| „Range/304 daje tani streaming dużych danych” | Odczytany handler najpierw dekoduje cały pakiet. |
| „RAM V/RT0/H dowodzi trwałości” | Nie dowodzi crash/restart/fencing/publication workflow ani kwalifikacji bazy. |
| „Build 56 lub job 67 kwalifikuje 426d1974…” | Bez zgodnego source manifest i terminal receipt takie przypisanie jest niedopuszczalne. |
| „Rustfmt/diff potwierdza kompilację i naukę” | Nie potwierdza typów, ABI, linkowania, runtime ani dokładności. |
| „Kontrolki lub fixture browsera dowodzą działania danych z solvera” | Nie bez realnego source payload i sprawdzenia wartości/domen/renderingu. |
| „FDM relaxation success potwierdza anteny FDM/GPU” | Nie potwierdza source, projekcji, pól w RHS i backend parity. |
| „H(k) dowodzi wzbudzenia propagującej fali” | To widmo wymuszenia; odpowiedź m(k,ω) wymaga osobnego obliczenia. |

## 9. Rejestr głównych źródeł

Wszystkie poniższe pliki, o ile nie zaznaczono inaczej, odnoszą się wyłącznie do SHA `426d1974bf4801f87e34024a81c21b0789605817`. Symbol jest stabilniejszą kotwicą niż numer linii dużego pliku odczytywanego partiami. W odpowiedzi rozmowy dołączono cytowania wyników connectora. Niniejszy rejestr pozwala odtworzyć review po pobraniu przypiętego drzewa.

| ID | Plik / artefakt | Kotwica lub zakres użycia |
|---|---|---|
| E01 | `crates/fullmag-runner/src/native_fem/charge_transport.rs` | `execute_native_fem_charge_transport`; V/J/I pierwszego solve i H RT0 |
| E02 | Ten sam plik w `41a5b893…` | Blob `58df13c4af44ba19fca8ddd353f7f8f9d82f1e45`, taki sam jak head |
| E03 | `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` | `solve_rt0`, osobny PeriodicChargePotentialSolveRequest |
| E04 | `crates/fullmag-plan/src/antenna_field_solve.rs` | standalone selection, raw/basis split, strict lane, port count, rejection projection/spectrum |
| E05 | `crates/fullmag-api/src/accepted_antenna_inspection_worker.rs` | `prepare`, `execute`, output/package validation |
| E06 | `crates/fullmag-application/src/script_pipeline_compilation.rs` | `materialize_script_pipeline_with_output_policy_bounded` |
| E07 | `crates/fullmag-authoring/src/scene_study_plan.rs` | `scene_document_to_study_plan` |
| E08 | `crates/fullmag-application/src/run_intent_materialization.rs` | `materialize_run_intent` |
| E09 | `crates/fullmag-api/src/router_v2/handlers/persistence/run_intent_preparation.rs` | `prepare`, `prepare_identity` |
| E10 | `crates/fullmag-cli/src/accepted_run_transport.rs` | `prepare_run_json`, `prepared_submission`, `submit_run_json` |
| E11 | `crates/fullmag-api/src/router_v2/handlers/data/accepted_antenna_inspection.rs` | `load_accepted_antenna_inspection`, accepted publication checks |
| E12 | `crates/fullmag-api/src/router_v2/handlers/data/accepted_antenna_resource.rs` | catalogue/metadata handlers |
| E13 | `crates/fullmag-api/src/router_v2/handlers/data/accepted_antenna_payload.rs` | `get_accepted_antenna_payload` |
| E14 | `crates/fullmag-antenna-artifacts/src/package.rs` | package encoding/decoding and bounds |
| E15 | `crates/fullmag-antenna-artifacts/Cargo.toml` | zależności bez runner/native |
| E16 | `crates/fullmag-runner/src/native_fem/accepted_external_lead/record.rs` | `bind_preflighted_request`, `decode_bundle` |
| E17 | `crates/fullmag-api/src/router_v2/mod.rs` | `build_v2_router`, rejestracja nowych tras |
| E18 | `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts` | brak nowych tras accepted/run-intent |
| E19 | `apps/control-room/src/kernel/runtime/antennaFieldSolveStudyCommand.ts` | `antennaFieldSolveStudyStages` |
| E20 | `apps/control-room/src/modules/inspector/panels/stages/AntennaFieldSolveStageInspector.tsx` | `AntennaFieldSolveStageInspector` |
| E21 | `apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx` | microstrip/CPW, composer i zasoby |
| E22 | `apps/control-room/src/modules/viewport-3d/hooks/useAntennaFieldOverlay.ts` | `useAntennaFieldOverlay` |
| E23 | `crates/fullmag-ir/src/study.rs` | `DriveActivationIR::is_active_for`, Study family i physical selection |
| E24 | `packages/fullmag-py/tests/test_antenna_standalone_authoring.py` | `AntennaStandaloneAuthoringTests` |
| E25 | `scripts/accepted_antenna_runtime.py` | `execute`, `validate_worker_publication`; one-task harness |
| E26 | `crates/fullmag-runtime-control/src/study.rs` | canonical replanning i preparation receipt binding |
| E27 | `crates/fullmag-runner/src/native_fem/steady_transport.rs` | preflight direct source×target/global budget |
| E28 | `docs/specs/resource-first-control-room-api-v2.md` | canonical spec; prepare/Submit i ograniczenia |
| E29 | `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` i `.source-map.json` | intencja naukowa i mapa implementacji; nie dowód wykonania |
| E30 | `docs/superpowers/plans/2026-09-08-microwave-antenna-refactoring-plan.md` | wymagania T00–T18 i historia dowodów; historia nie zastępuje current source |
| E31 | GitHub compare parent→head i pinned master→head | 1 commit / 285 commits; merge-base; ograniczona lista całego brancha |
| E32 | GitHub check-runs dla dokładnego head | 14 rekordów; konkretne widoczne stany opisane w sekcji 2 |

**Konkluzja:** najważniejszym następnym wynikiem nie jest kolejna mapa V/J/H, lecz jeden odtwarzalny łańcuch od autorskiego microstrip i jego zamknięcia prądu do trwałego wyniku, a następnie podpisanej bazy H/I, projekcji i rzeczywistego wymuszenia magnetyka. Obecny checkpoint buduje istotne części tego łańcucha, ale go nie zamyka.
