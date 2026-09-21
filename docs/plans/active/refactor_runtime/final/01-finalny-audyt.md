# Finalny audyt architektury i planu refaktoryzacji Fullmag

Data: 20.09.2026. Baza: `14c8e73a6f3c55f4fc080835a6156f2a4db8f111`, lokalny `master`. Zakres: 5 dokumentów bazowych, 6 raportów Gemini i 7 raportów Claude, skonfrontowanych z aktualnym kodem i obowiązującymi kontraktami. Rejestr źródeł: [05](05-dowody-i-adr.md).

## Aktualizacja wykonawcza — 21.09.2026

Poniższy audyt zachowuje stan źródeł i ustalenia z 20.09. Po jego zapisaniu użytkownik autoryzował implementację i testowanie na `masterze`. Bieżący stan wykonawczy jest prowadzony osobno w [P0](p0/03-implementation-status.md), [P1](p1/README.md) i [P2](p2/README.md): minimalna bramka P0 przeszła, P1-A/B/D oraz większość P1-C wykonano, ikonę chowania Inspektora zweryfikowano w browser smoke, a pierwszy slice P2-C izolacji kontekstu Python przeszedł testy skupione. Nie należy traktować historycznych zdań „nie wykonano” poniżej jako opisu bieżącego checkoutu.

Aktualny inventory P0-A (`audit_refactor_p0.py --check`) obejmuje **300 operacji OpenAPI, 300 rozpoznanych handlerów, 0 nierozpoznanych handlerów/konsumentów, 2 router-only i 0 OpenAPI-only**. Pozostałe bramki produkcyjne — power-loss, pełna recovery runtime, fizyczny Tauri, baseline naukowy oraz kwalifikacja release — nadal pozostają `NOT VERIFIED`; P2-A ma tylko canonical-bytes slice, a P2-A/B/D oraz granica P2-C obejmująca definicję → materializację, bridge `fullmag-py-core` i równoległe capture/load są `IN PROGRESS`.

## 1. Werdykt

**Kierunek projektowego CAE jest zasadny. Plan bazowy należy zachować jako fundament, ale nie wykonywać dosłownie wraz ze wszystkimi rekomendacjami audytorów.** Wymaga wcześniejszego zabezpieczenia danych, jawnej migracji tożsamości, uzgodnienia ADR oraz pełniejszego planu modularizacji backendów. Finalny pakiet określa te poprawki, kolejność i kryteria odbioru.

Najważniejsza zmiana produktu to rozdzielenie edytowanej definicji, przypiętego wykonania, trwałych wyników i stanu widoku. Usunięcie modalu samo tego nie zapewnia. Nowy ProjectDefinition bez migracji właścicieli i konsumentów również nie zapewnia tej zmiany.

Nie ma podstaw do ocen „100% poprawności”, gwarancji zerowych przerw CI, uniwersalnego parytetu CPU/GPU ani obietnicy dorównania COMSOL/CST po samym refaktorze. Dokumenty są finalną rekomendacją architektoniczną i planem produkcyjnego wdrożenia; stan implementacji oraz release qualification pozostają osobnymi sprawami.

## 2. Metoda i tożsamość źródeł

Odczytano dokumenty, powiązane ADR/reguły i wskazane poniżej ścieżki źródłowe. Niezależne przeglądy backendu, frontend/API i storage dostarczyły anchors; ryzykowne ustalenia storage oraz zliczenia API sprawdzono ponownie w głównym przeglądzie. To audyt statyczny, nie pełny przegląd każdej linii backendu ani wykonanie 70 scenariuszy.

| Baza | Znaczenie |
|---|---|
| `31bac350a15c0af070287de92d4e0c1a6dabab0e` | Baza dokumentów wejściowych i deklarowana baza Gemini. |
| `33aa26fe8b48b6df1bab77e96eb31afa6c6b90a8` | Historyczny checkout opisany przez Claude. |
| `14c8e73a6f3c55f4fc080835a6156f2a4db8f111` | Aktualna baza finalnego audytu; pierwszy SHA jest jej przodkiem, różnica wynosi 2 commity. |

Nie wykonywano synchronizacji repozytorium. Lokalny `origin/master` wskazuje ten sam HEAD, ale nie odświeżano remote; nie jest to zapewnienie o aktualnym stanie serwera GitHub. Początkowe dirty submoduły `external_solvers/3`, `amumax`, `oommf` oraz niewersjonowany katalog raportu Claude pozostawiono bez zmian.

Claude porównywał m.in. liczbę linii przy ocenie zgodności plików. Równa liczba linii nie dowodzi równej treści. Finalny audyt używa bieżących źródeł i jawnej różnicy Git; nie zaleca cofania checkoutu do historycznej bazy ani automatycznego pull przed P0.

## 3. Ustalenia krytyczne i wysokie

Wagi opisują wpływ na migrację i dane, nie potwierdzone incydenty użytkownika. SOURCE-CONFIRMED oznacza gałąź/kontrakt w kodzie; nie oznacza zaobserwowanego runtime failure.

| ID / waga | Ustalenie i źródło | Skutek | Rozstrzygnięcie |
|---|---|---|---|
| F01 / krytyczna | `SessionStore::collect_live_refs` zbiera tylko descriptor refs, nie pełny graf; `CasStore::gc` usuwa resztę; CLI wywołuje GC bez dry-run. `store.rs:314–345`, `cas.rs:91–107`, `main.rs:467–471`. | Żywe payloady mogą zostać uznane za garbage. Uszkodzony checkpoint jest pomijany przez `if let Ok`, co dodatkowo redukuje roots. | P0-B: najpierw zamknąć usuwanie, potem typed traversal i generation/lease guard. Nie uruchamiać GC na danych użytkownika. |
| F02 / krytyczna | `capture_checkpoint` zapisuje primary blob w common state, tworzy descriptor bez chunks, a hash aux porzuca; `plan_cas_entries` pakuje tylko descriptor refs. `capture.rs:72–116`, `fms.rs:205–239`. | Nawet bez GC archiwum może nie zawierać payloadów wymaganych do restore. Sama obecność JSON checkpointu nie dowodzi kompletności. | Nowe ustalenie finalne: wspólny graf capture/export/GC/restore i test rzeczywistych bajtów primary/aux przed P1. |
| F03 / krytyczna | `preflight_fms` waliduje wpisy ZIP, ale nie `session_id` użyte później przez `unpack_fms → commit_session` jako część ścieżki. `fms.rs:636–667,942–956`; `store.rs:53–63`. | Brak kontroli wartości z treści manifestu na granicy zapisu; ryzyko wyjścia poza oczekiwany katalog. Nie wykonano exploit testu. | P0-F: typed-ID validation i containment wszystkich writerów; fixtures wyłącznie izolowane. |
| F04 / wysoka | `commit_checkpoint` publikuje checkpoint przed common state; listing uznaje checkpoint JSON za dostępny. `store.rs:114–164`. | Okno widoczności niekompletnego checkpointu. | State/payload przed markerem; reader sprawdza kompletność; fault injection P0-C. |
| F05 / wysoka | `atomic_write` i CAS put nie mają jawnej bariery sync_all; współdzielone nazwy `.part`. `store.rs:351–357`, `cas.rs:35–47`. | Brak dowodu durability przy crash/power-loss i ryzyko kolizji staging. | Platformowa polityka trwałości, unikalne staging, separate crash/power-loss evidence. Brak fsync nie dowodzi, że każda awaria utraci dane. |
| F06 / wysoka | `try_lock` sprawdza lokalny PID, nie weryfikuje hosta przy odzyskiwaniu; acquisition nie jest atomowe, unlock nie sprawdza owner tokena. `store.rs:273–309,397–405`. | Gwarancja single-writer jest niewystarczająca; na Windows PID probe zawsze zwraca true, więc zachowanie różni się od Unix. | Owner UUID/host/process identity, exclusive acquisition i owner-checked release; niekwalifikowany SMB read-only/odmowa. |
| F07 / wysoka | Trwałe resource keys oraz `run_id="current"`/`run:current` w generatorach eigen/FMR/FEM. `common.rs::eigen_mode_field_resource_key`, `modal_manifest.rs`, `fmr.rs`, `field_sweep.rs`. | Zapisane dane zależą od aktywnej sesji; zmiana routingu nie naprawi manifestów ani placeholder identity. | P3/P6: nowe producers dostają rzeczywiste IDs; stare dane migrowane copy-on-write, bez zgadywania brakującego runu. |
| F08 / wysoka | Startup gate zastępuje children; bez sesji shell wybiera EmptyWorkspace. `WorkspaceShellClient`, `WorkspaceStartupGateView`. | Dostęp do środowiska pracy zależy od technicznego lifecycle runtime. | P1 stała powłoka i lokalne availability; mutacje starego runu ograniczone aż do P5. |
| F09 / wysoka | Scratch supervisor reaguje na zmianę session/backend/scene revision zakończeniem child. `scratch_runtime.rs::run`. | Mutable authoring jest sprzężony z ownership scratch execution. | P3 immutable RunSpec, P5 run ownership. Nie uogólniać do każdej interakcji i wszystkich trybów uruchomienia. |
| F10 / wysoka | `SceneDocument` łączy model, study i editor state; `SceneStudyState` łączy intencję, mesh i solver. | Szeroki revision scope i utrudniona niezależność studies/view/run. | P1/P2/P3: jeden właściciel definicji i projekcje; bez trzech synchronizowanych źródeł prawdy. |
| F11 / wysoka | Rozległy `sessions/current` w handlers, generated schema i artefaktach; explicit session-ID routes nie znaleziono. | Ryzyko cross-context po await, decode i reconnect. | P3a internal context + etapowe scoped resources; nie wystarcza zmiana stringów. |
| F12 / wysoka | Raporty nie uzgadniają w pełni istniejących ADR i zawierają propozycje sprzeczne z lifecycle viewportu. Dodatkowo dokumenty backendowe różnią się w opisie FDM CPU authority. | Możliwość drugiego modelu accepted state, drugiego API lub nieuzgodnionej relokacji solvera. | P0-D, rejestr 05 i zachowanie aktualnego dispatch do scoped decyzji. |

### Priorytet napraw

F01–F06 są podstawą P0 przed promocją nowych zapisów/importu. F07 zaczyna się od inventory już w P0, nowe ID są wymagane w P3, pełna migracja wyników w P6. F08 można poprawiać wcześnie jako lifecycle powłoki, ale F09 blokuje pełne współbieżne mutacje. W momencie utworzenia audytu zakres był plan-only; późniejsza zgoda użytkownika na implementację jest rozliczona w checkpointach P0/P1 i nie znosi żadnej bramki bezpieczeństwa.

## 4. Metryki API: podobne liczby oznaczają różne rzeczy

Powtórzony pomiar w aktualnym drzewie:

| Metoda | Całość | `sessions/current` | Znaczenie |
|---|---:|---:|---|
| Adnotacje `path = "/v2/..."` w Rust handlers | 293 | 288 | Wystąpienia adnotacji, nie deduplikowane endpointy. |
| Klucze `paths` w zapisanym generated OpenAPI | 246 | 239 | Unikalne ścieżki artefaktu schematu; różne metody mogą dzielić path. |

Nie odrzucamy liczby Claude 288/293 (current/total): jest odtwarzalna przy jego sposobie liczenia. Nie przenosimy jej jednak jako mianownika „liczby wszystkich endpointów”. Rozbieżność różnych inwentarzy wymaga w P0 tabeli path + method + operationId + handler + consumer; bez regeneracji i analizy metod nie jest sama w sobie dowodem błędu OpenAPI.

W `crates/fullmag-runner/src` potwierdzono 54 wystąpienia literalnego `sessions/current` w 12 plikach. Dodatkowo występują placeholdery samych IDs. Stąd grep URL-i nie wystarczy do migracji danych.

Frontend posiada scentralizowaną fasadę ścieżek i typowany klient. Teza Gemini o „50+ komponentach ręcznie używających current” nie ma potwierdzenia w odczytanym kodzie. Nie wynika z tego jednak, że migracja UI sprowadza się do regeneracji: cache, events, resources, selection i dekodery nadal przenoszą semantykę aktualnej sesji.

## 5. Rozstrzygnięcie rekomendacji Gemini

| Rekomendacja/teza | Werdykt finalny | Powód i zastosowanie |
|---|---|---|
| Projekt CAE, immutable run, osobne results | Przyjąć | Zgodne z kierunkiem i przyczynami sprzężeń. |
| Stopniowe wydobywanie use cases z orchestratora | Przyjąć | P1–P5; nie nowy monolit w application. |
| ContextVar/per-context Python | Przyjąć po korekcie | Binding nie izoluje automatycznie odziedziczonego mutable world state; explicit ownership, nesting i concurrency tests P2. |
| VirtualSessionAdapter | Ograniczyć | Adapter binduje context raz i deleguje do jednego ownera; nie odczytuje „aktywny projekt w UI” po fakcie. |
| CAS + chunked trajectories | Przyjąć bez obietnicy zero-copy | Reuse Zarr, bounded I/O, integralność przed publikacją; progi z pomiaru. |
| Rozbudować complex/function-space metadata | Przyjąć | Zachować real/imag; C64/C128 nie są obowiązkowym pierwszym krokiem. Duże DOF maps jako binary refs. |
| Semafor GPU i context-loss recovery | Przyjąć po korekcie | Resource admission i fencing procesu; pamięć z pomiarów, brak gwarancji „zero OOM”. |
| Utrzymywać nieaktywne canvasy ukryte CSS | Odrzucić | Narusza ADR-0016 i guard pamięci. Zachować ViewDocument poza rendererem. |
| Wymienić istniejące stores na Zustand | Odrzucić | Gemini samo koryguje tę sugestię; stosować obecne modular stores/ResourceRuntimeStore. To nie dowodzi zerowego narzutu. |
| Każda edycja i każda komenda spawnują/zabijają solver | Zawęzić | Potwierdzono gałęzie scratch; nie dowiedziono uniwersalnego zachowania wszystkich entry points. |
| 600 ms–2.5 s, <5 ms, 4–8 GB, stały margines VRAM | Nie przyjmować jako faktów | Brak pomiarów tego audytu. Baseline i progi są P0-E. |
| UI/CAD makieta zawiera gotowe solvery i presety | Traktować jako ilustrację | Nie importować nazw/metod/parametrów bez mapowania do kanonicznego API i capabilities. |
| „Gwarantuje zero przerw CI” / pełna zgodność | Odrzucić | Żaden statyczny plan nie daje takiej gwarancji. |

## 6. Rozstrzygnięcie rekomendacji Claude

| Rekomendacja/teza | Werdykt finalny | Powód i zastosowanie |
|---|---|---|
| L1 uzgodnienie ADR | Przyjąć i rozszerzyć | Wszystkie 34 pliki opisano w 05, z pełnymi nazwami dla zduplikowanych numerów. |
| L2 transportowe referencje w trwałych danych | Przyjąć i rozszerzyć | Obejmuje również `run:current`; nowy manifest/hash, nie przepisywanie immutable obiektu in-place. |
| L3 GC live refs | Przyjąć i rozszerzyć | Wspólny walker z eksportem/restore, capture aux i mark–sweep race, nie tylko chunks. |
| L4 brak fsync | Przyjąć jako lukę gwarancji | Nie utożsamiać process kill z power-loss; implementacja zależy od platformowego kontraktu. |
| L5 skala current | Przyjąć z definicją metryki | Current/total: 288/293 adnotacje; 239/246 unique paths. |
| L6 quantities | Przyjąć | `fullmag-quantities` pozostaje ownerem katalogu/ewaluacji; nie nowy silnik wyrażeń UI. |
| Pełny pośredni zestaw `/sessions/{id}` | Nie wymagać | Dodatkowa powierzchnia i drugi cutover bez wykazanego zysku. Najpierw immutable context i pilotaż rodzin. |
| Frontend migration to tylko regeneracja | Odrzucić | Typed transport nie migruje cache/event/selection/codec ownership. |
| Epoka UI jest wersją OwnershipEpoch | Odrzucić utożsamienie | Guards mają różne autorytety i zakresy; opisano osobno w 02. |
| Stan widoku poza canvas | Przyjąć | Z bounded cache; po eviction refetch legalny. Bezwarunkowy brak fetch byłby sprzeczny z budżetem pamięci. |
| Results/Tasks trzeba dopisać od zera | Skorygować | Results, Sweep, Mesh Jobs, telemetry i logs już istnieją; rozszerzać je. |
| Drzewo jako jedyne miejsce tworzenia encji | Skorygować | Drzewo ma obsługiwać typowe akcje; inne powierzchnie i Python są równorzędne poprzez wspólne komendy. |
| Trzeba cofnąć/zsynchronizować checkout do bazy | Odrzucić jako automatyczne działanie | Aktualny stan jest nowszy; P0 przypina wybraną bazę i aktualizuje anchors/fixtures. |
| „Nie można zapisać niczego przed solve” | Nieudowodnione uogólnienie | Endpoint wymagający active workspace nie dowodzi wymogu wcześniejszego solve. Istnieją Compact/ConfigOnly. |
| „Lepsze od COMSOL” / konkurenci nie mają określonych cech | Odrzucić | Brak porównania wystarczającego do takich ocen. |

## 7. Co istnieje i czego nie budować ponownie

| Fundament | Aktualny dowód źródłowy | Kierunek |
|---|---|---|
| StudyPipelineDocument primitive/macro/group | `fullmag-authoring/src/builder.rs` | Typed migration z zachowaniem makr i kolejności. ParameterSweep jest makrem. |
| `.fms`, CAS, run_refs, save/restore classes | `fullmag-session/src/types.rs`, `store.rs`, `fms.rs` | Ewolucja i naprawa gwarancji, nie nowy niezależny storage. |
| Selective realization revisions | `region_revisions.rs::classify_region_realization_impact` | Rozszerzyć o producer/version/certificates. |
| Quantity registry/evaluation | `fullmag-quantities/src` | Fundament fields/derived values. |
| Jedna fasada i resource runtime | `ControlRoomApi`, `ResourceRuntimeStore`, `sessionResourceIdentity` | Scoped resources/context, bez direct transport w komponentach. |
| Results Navigator i dataset browser | `ResultsNavigatorModule`, `ResultDatasetBrowser` | Trwałe źródła project/run zamiast tworzenia drugiego Results. |
| Sweep resources i inspectors | `studyRuntimeResources`, `FrequencyDomainFieldSweepInspectors` | Zachować semantic sample/mode/branch identity. |
| MeshJobsPanel, Footer telemetry/logs | `modules/footer` | Uniwersalne Operations/Problems jako projekcja jednego dziennika. |
| Aktywny-only viewport | `ViewportTabHost`, ADR-0016 | Zachować zwalnianie GPU; ustawienia odtwarzać z ViewDocument. |
| Export/sync Python | `ControlRoomApi`, shell commands | Rozszerzyć canonical roundtrip; Monaco/Script View nie jest gotowym istniejącym edytorem. |

Transport zawiera WS invalidation i kontrolowane odpytywanie status/preparation. Nie należy ogłaszać „braku polling” ani usuwać każdego refetch bez analizy. Cel to scoped revision-driven zasoby i bounded recovery, nie ideologiczny zakaz zapytań okresowych.

ADR-0025 jest zaakceptowanym kontraktem, ale odczyt/search nie daje dowodu pełnej realizacji wszystkich nazwanych typów i zachowań. Brak literalnego `AcceptedStateId`/`ObservationRuntime` nie dowodzi braku każdej części persistent runtime. Plan konsumuje kontrakt i wymaga implementacyjnej macierzy, nie zastępuje go drugim modelem.

## 8. Dodatkowe rozstrzygnięcia architektoniczne

1. **Open projektu a restore runtime:** ADR-0025 opisuje kandydacki runtime i atomowy swap. Nowe Open dokumentu nie może tego wykonywać ukrycie; należy scoped amendment rozdzielające oba use cases przed P1.
2. **Compute a Build Mesh:** ADR-0009 ma zasadę jawnego Build Mesh i zakaz auto-trigger. Docelowe Compute może przygotować brakujące zasoby tylko jako jawnie pokazany PreparationPlan i po scoped amendment; manual-only pozostaje dostępne. Nie wprowadzamy remesh na zwykły GET/Apply.
3. **Dataset recipe a materialized dataset:** ADR-0029 definiuje immutable produkt analizy. Nowa edytowalna receptura nie przejmuje jego ID; oba byty są osobne.
4. **Storage a runtime affinity:** cache można zwolnić według jawnego kontraktu; checkpoint/solution nie jest cache tylko dlatego, że ma starą rewizję. Lease GPU i lifecycle rezydentnego runtime muszą być uzgodnione, żeby nie przydzielić urządzenia zajętego przez idle-but-resident worker.
5. **Cały backend:** strumień B w planie obejmuje FDM/FEM, integratory, oddziaływania, demag, workflows, accepted state, ABI, quantities i observation. Przeniesienie samych use cases nie wystarcza do uznania refaktoryzacji solverów za zakończoną.

## 9. Ocena produktu i zakres porównania do CAE

Fullmag powinien zapewnić trwały model, parametry, sekwencję geometrii, study inputs, jawne ustawienia solvera oraz zapisane wyniki dostępne niezależnie od aktywnego procesu. Oficjalny opis [COMSOL Model Builder](https://www.comsol.com/comsol-multiphysics/model-builder) potwierdza takie wzorce pracy; [CST Systems Modeling](https://www.3ds.com/products/simulia/cst-studio-suite/electromagnetic-systems-modeling) przedstawia powiązane przepływy analiz. To odniesienia funkcjonalne, nie dowody wewnętrznej architektury, szybkości ani przewagi Fullmaga.

Profesjonalny UI w tym planie oznacza: zachowany dokument/draft po błędzie, czytelne units i provenance, lokalne diagnostics z przejściem do pola, przewidywalne commands, wyniki przypięte do źródła, bounded memory i dostępność klawiaturą. Nie oznacza kopiowania layoutu ani utrzymywania wszystkich rendererów w pamięci.

## 10. Stan końcowy audytu w momencie utworzenia (20.09.2026)

Zapisano oddzielne dokumenty finalne i zachowano materiały wejściowe. Nie zmieniono kodu aplikacji, ADR, konfiguracji hosta ani danych użytkownika. Nie wykonano commit/push/PR, buildów, migracji, GC, testów runtime ani browser smoke.

Audyt wykazuje źródłowe ryzyka i daje gotowy porządek prac oraz kryteria odbioru. Nie ogłasza bieżącego Fullmaga ani proponowanej implementacji produkcyjnie zakwalifikowaną. Pierwszym zakresem wykonawczym jest P0: identity/inventory, ochrona GC, kompletność checkpoint/export, durability/locks i bezpieczeństwo importu.

Po tej dacie wykonano ograniczone, autoryzowane przyrosty opisane w sekcjach P0/P1. Nie zmienia to historycznej oceny ryzyka ani nie podnosi niezweryfikowanych bramek do statusu produkcyjnego.
