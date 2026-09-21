# Fullmag CAE — migracja do nowej architektury

**Status:** plan proponowany, nie lista wykonanych zmian.  
**Baza:** `31bac350a15c0af070287de92d4e0c1a6dabab0e`.  
**Cel:** wdrożyć [architekturę projektu CAE](01-architektura-cae.md), a nie wyłącznie usunąć startup modal.

## 1. Kolejność wynika z własności danych

Najpierw powstaje trwały projekt i wspólna semantyka, następnie izolowane wykonanie oraz niezależne wyniki. Pełne odblokowanie edycji podczas pracy następuje dopiero po odłączeniu workera od aktualnego draftu. Wcześniejszy nieblokujący widok read-only jest dopuszczalnym etapem przejściowym, nie docelowym rozwiązaniem.

Nie ustalamy z góry liczby PR-ów na podstawie liczby rozdziałów. Każda faza dzieli się na reviewowalne pionowe przekroje: kontrakt → adapter → zachowanie → test → migracja danych. Nie merge’ujemy samego nowego typu jako „wdrożonego projektu”, jeśli UI wciąż zapisuje jedynie bieżącą sesję.

## 2. Docelowe granice kodu

Wybór organizacyjny: dodajemy jedną bibliotekę use-case’ów **`fullmag-application`**. Pozostałe odpowiedzialności rozwijamy przede wszystkim w istniejących pakietach. Nowa biblioteka nie zawiera równań solverów ani HTTP handlers; wydobywa orkiestrację produktu z launcherów i endpointów.

| Pakiet/warstwa | Rola docelowa | Zależności i zakazy |
|---|---|---|
| `fullmag-authoring` | Definicje projektu/modelu, komendy semantyczne, parametry, selekcje i walidacja authoringu | Bez Axum, React, CUDA i aktywnego procesu solvera. |
| `fullmag-ir` | Wspólny kontrakt fizycznego problemu i planów | Bez historii docków i bieżącego wyboru UI. |
| `fullmag-plan` | Lowering study, preflight, zależności przygotowania, finalny plan numeryczny | Nie zapisuje draftu i nie steruje React. |
| **`fullmag-application` — nowy** | Project use cases, transakcje, coordinator, katalog runów i reguły publikacji | Używa ports do wykonania i storage; bez bezpośredniej pętli LLG. |
| `fullmag-session` | Repository definicji/wersji, CAS, manifesty, `.fms`, checkpointy | Zachować kompatybilność istniejącego zapisu; adapter projektu zamiast nowego storage. |
| `fullmag-runner` | Wykonanie przypiętego planu przez runtime, obserwacja i wytwarzanie artefaktów | Nie odczytuje mutowalnego globalnego modelu. |
| `fullmag-engine`, FDM/FEM sys | Numeryka i realizacje CPU/GPU | Nie zależą od klienta, UI ani current HTTP session. |
| `fullmag-api` | Transport typed resources/commands do application use cases | Cienkie handlers; brak drugiego koordynatora. |
| `fullmag-cli` i launchery | Entry points, argumenty, uruchomienie właściwego hosta | Nie są właścicielami definicji projektu. |
| `fullmag-py-core` / `fullmag-py` | Publiczne API, binding i kompatybilny DSL | Jedna semantyka, headless bez serwera GUI. |
| `apps/control-room` | Powłoka, narzędzia, projekcje i wspólny viewport | Brak alternatywnego planera fizyki. |
| `apps/desktop` | Integracja systemowa i hostowanie aplikacji | Ten sam model produktu co web, nie osobna wersja naukowa. |

Ports `ProjectRepository`, `ExecutionGateway`, `GeometryGateway`, `ArtifactRepository` są granicami logicznymi. Wykorzystują istniejące implementacje i np. mechanizm providerów checkpointów; nie tworzymy kopii CAS ani równoległych kolejek. Kontrola grafu zależności Cargo jest częścią kwalifikacji nowej biblioteki.

## 3. Mapa zmiany istniejących właścicieli

| Obecny punkt | Decyzja | Oczekiwany efekt |
|---|---|---|
| `fullmag-authoring/src/scene.rs` | Rozdzielić definicję modelu, study, receptury i stan edytora; zachować migrację scene.v2 | Renderer nie dyktuje schematu projektu. |
| `fullmag-authoring/src/builder.rs` | Adapter dotychczasowych stages/macros do typowanych study steps i config references | Nie utracić sekwencji i makr już używanych. |
| `fullmag-authoring/src/physics_graph.rs` | Rozwinąć scope i porty przez rodziny; zachować unresolved/unsupported | Widoczność modułu nie udaje wykonania. |
| `fullmag-authoring/src/adapters.rs` | Stopniowo zmienić kierunek: canonical definition → projekcje | Nie utrzymywać kilku równorzędnych truth sources. |
| `fullmag-py/.../world.py` | Per-context adapter do authoringu i eksperymentu; zachować jawne run/build | Kilka modeli nie współdzieli niejawnie globalnego świata. |
| `fullmag-py/.../model/problem.py` | Oddzielić lowering intencji od kosztownej materializacji przy zachowaniu explicit APIs | Export/Open bez ukrytej pracy; cache receipts zachowane. |
| `fullmag-cli/src/orchestrator.rs` | Wydobyć use cases i lifecycle wykonania do odpowiednich warstw | CLI nie orkiestruje całego produktu. |
| `fullmag-cli/src/scratch_runtime.rs` | Zastąpić ownership aktywnej sceny ownership przypiętego runu | Edycja draftu nie zabija runu. |
| `fullmag-cli/src/simulation_preparation.rs` | Adapter telemetrii konkretnej operacji; nie globalny warunek istnienia UI | Ready dotyczy operacji, nie aplikacji. |
| `fullmag-api` persistence handlers | Delegacja przez jawny project/run context | Save/Open niezależne od bieżącego solvera. |
| `fullmag-session` | Rozwinąć manifest projektu i catalog; zachować CAS/profile/restore | Przenośny trwały projekt i niezależne wyniki. |
| `kernel/layout/WorkspaceShellClient.tsx` i `SimulationStartupOverlay.tsx` | Stała powłoka, lokalne availability, Operations/Problems | Brak globalnego odmontowania przez stan pracy. |
| `kernel/KernelProvider.tsx` | Kontekst dokumentu/komend niezależny od widoczności progress UI | Skróty działają według uprawnień akcji. |
| `kernel/resources`, fasada API | Namespace project/run/artifact i kontrolowane adaptery legacy | Brak skażenia cache przez zmianę current. |
| `modules/viewport-3d`, `field-map`, charts/results | Jeden system rendererów, ViewDocument i pinned dataset sources | Zmienna quantity nie podmienia topologii lub scope. |

To mapa odpowiedzialności, nie gotowy patch. Zakres odczytu źródeł jest jawny w rejestrze dowodów; pliki wskazane tylko jako migracyjne wymagają odczytu konsumentów przed implementacją.

## 4. Fazy wdrożenia

### P0 — kontrakty i charakterystyka obecnego zachowania

Zamrozić reprezentatywne projekty/script fixtures: FDM single-grid, multilayer, FEM bez/wraz z airboxem w istniejącym zakresie, mixed mesh, eigen, response, histereza, tekstury regionalne, Frozen Spins i dostępne transporty. Zachować wyniki i current scientific receipts.

Spisać wszystkie entry points: pusty UI, New Problem, otwarcie `.fms`, skrypt batch, attach live, headless i desktop. Dla każdego ustalić, kto tworzy scenę, run, mesh i session. Zidentyfikować wszystkie zapisy do current state, nie tylko referencje tekstowe endpointów.

**Brama:** zatwierdzony model tożsamości i ownership; source fixtures; testy charakteryzujące stary tryb; kompletna lista miejsc publikacji. Nic nie twierdzi jeszcze, że nowa architektura działa.

### P1 — trwały projekt bez runtime’u: pierwszy pionowy przekrój

Dodać ProjectDefinition i use cases Create/Open/Save/Close. Wykorzystać SessionStore/CAS oraz migrację istniejącego pliku. UI otrzymuje projekt i może zapisać niekompletny model. Layout i błędy połączenia są niezależne od solvera.

Początkowo istniejący SceneDocument może być migrowanym modelem wewnątrz projektu. Nie może jednak pozostać równoległym źródłem prawdy stale nadpisującym nową definicję. Nowe endpointy mają jawny project ID.

**Brama:** New → zmiana modelu → Save → zamknięcie procesu → Open bez zainicjowania solvera. Brak GPU i brak meshu nie blokują tego scenariusza. `.fms` roundtrip zachowuje niewspierane elementy lub raportuje brak migracji, nigdy ich po cichu nie usuwa.

### P2 — pełne definicje authoringu i historia edycji

Wprowadzić parametry z jednostkami/AST, versioned library refs, komponenty, feature sequence, stabilne selekcje, material/physics assignments, lokalne drafts i Undo/Redo. Najpierw przenieść istniejące primitives/CSG/translations/waveguides; kolejne operacje geometryczne rozszerzać przez jawny registry wsparcia.

Python i UI mają korzystać z tej samej ścieżki lowering; eksport semantyczny i import obsługiwanej definicji muszą przechodzić golden fixtures. Niestrukturalny Python pozostaje script-owned, nie obiecuje pełnej edycji historii.

**Brama:** zmiana parametru odświeża zależną geometrię, zachowuje referencje albo zgłasza ich niejednoznaczność. Nie generuje meshu solvera w transakcji. Undo przywraca semantykę, nie stan sesji obliczeniowej.

### P3 — StudyDefinition, konfiguracje i przypięty run

Rozdzielić globalny SceneStudyState. Migrować stages/macros do typed steps. Dodać jawne references do solver configs i discretizations. Wydobyć application coordinator, tworzenie RunSpecification i durable accepted command.

Worker wrapper przyjmuje niezmienne wejście i identyfikację run/task/attempt. Jeden legacy numerical lane może początkowo być opakowany tym kontraktem, ale adapter ma jawnie ograniczoną współbieżność. Brak bezpiecznej wielosesyjności daje kolejkę lub kontrolowany konflikt, nie udawany parallel run.

**Brama:** dwa wykonania tego samego study z różnymi wejściami mają dwa runy i nie nadpisują wyników. Utracony ACK nie tworzy drugiego runu. Spóźniona publikacja nie trafia do innego projektu.

### P4 — przygotowanie i dyskretyzacja na żądanie

Dodać PreparationPlan oraz registry artefaktów wymaganych przez konkretne kroki. Wydzielić GeometryArtifact, DisplayArtifact, DiscretizationArtifact i FunctionSpaceDescriptor. Przenieść istniejący meshing i grid refresh do task producerów z zachowaniem quality gates/certification receipts.

ReadyToCompute jest obliczane dla study i akcji; może dopuszczać Compute, które zbuduje brakujące przygotowalne zasoby. Nie wymaga globalnie wcześniejszego ręcznego zbudowania wszystkich meshów. W trybie manual-only jawnie wyjaśnia wymagania.

**Brama:** Build Geometry, Build Grid/Mesh i Compute to różne operacje. FDM nie pobiera i nie wymaga zasobów FEM. Niepowodzenie budowania nie odbiera edytora, a ostatni poprawny artefakt pozostaje oznaczony swoim pochodzeniem.

### P5 — izolacja wykonania, live steering i bezpieczna edycja

Usunąć zależność workera od mutowalnej current scene. Zapewnić ownership epochs, manifest publication, cancel/retry/recovery oraz strict requested/resolved/executed receipt. Dopiero teraz w pełni odblokować współbieżne edytowanie projektu.

Wprowadzić jawny tryb eksperymentu interaktywnego: safe-point steering, segmenty i checkpoint compatibility. Zachować affinity oraz data residency dla zgodnych kroków; nie zastąpić starego monolitu sekwencją kosztownych procesów per timestep.

**Brama:** edycja geometrii przyszłego wariantu nie zmienia ani nie zabija runu; explicit live field change ma ACK i provenance; reconnect i zamknięcie dokumentu nie anulują zadania bez osobnej decyzji. Numerical accepted state pozostaje poprawny.

### P6 — trwałe wyniki, datasets i ilościowy postprocessing

Wprowadzić SolutionSet i pełne FieldDescriptors; migrować istniejące artefakty i manifesty do katalogu powiązanego z runami. Zbudować dataset/derived/plot layer ponad istniejącymi quantity providers, Zarr/HDF5 i binary transport, bez przepisywania całego data plane.

Wspólny viewport dostaje jawny ViewDocument zamiast globalnego latest state. Kontrolować scope, carrier, function space i geometry context. Otwieranie starego rozwiązania nie przełącza automatycznie modelu authoringu.

**Brama:** Open solved archive i pełny postprocessing bez solvera; porównanie dwóch runów; brak fallbacks do innego pola lub całej domeny; ilościowe wyniki headless/UI zgodne w określonej tolerancji.

### P7 — badania złożone i wiele kontekstów projektu

Dodać typowane zależności equilibrium → eigen/response, mapowanie przypadków, continuation sweeps i niezależne campaigns. Wykorzystać istniejące makra i wzbogacić je zamiast usuwać. Rozwinąć obsługę wielu dokumentów i przypiętych widoków; w razie pojedynczego workera różne runy czekają w kolejce, ale projekty pozostają dostępne.

Adapter targetów zdalnych używa tych samych kontraktów. Mocniejsze multiphysics i automatyczna optymalizacja są uruchamiane tylko w zadeklarowanym, przetestowanym zakresie. Nie zmieniają schematu tożsamości i storage.

**Brama:** kompletny scenariusz z rozdziału 27 architektury; kolejność histerezy zachowana; niezależne próby można rozdzielać bez zmian modelu; zgodność four-lane według aktualnej macierzy kwalifikacji.

### P8 — usunięcie starych właścicieli i kwalifikacja wydania

Usunąć globalny gate i testy wymagające odmontowania workspace’u, stare szerokie startup enumy jako warunki UX, nieskoordynowane current writers i dual-truth authoring. Zachować wyłącznie opisane adaptery odczytu/importu i kompatybilnego CLI.

Zweryfikować długotrwałe użycie, memory leaks, throttling, limits, błędy zapisu, crash recovery, nieznane schematy, bezpieczeństwo importu i odtwarzalność. Dokumentacja capabilities ma powstawać z danych kwalifikacji, nie z samego registry klas.

**Brama:** wykonany i podpisany raport scenariuszy; brak cichego fallbacku; brak regresji naukowej; migracje plików i rollback sprawdzone. Wszystkie nieprzetestowane kombinacje pozostają wyraźnie niezakwalifikowane.

## 5. Zasady rollout i rollback

Stosujemy pojedynczego writera dla migrowanego agregatu. Stare API może czytać projekcję lub wywoływać ten sam handler, ale nie zapisuje osobnego snapshotu omijającego nową wersję. Adapter legacy pinning jest sprawdzany przy akceptacji i publikacji.

Dopuszczalny jest tryb shadow **porównania definicji i lowering**: nowe i stare ścieżki produkują znormalizowane IR do porównania. Nie należy automatycznie dublować ciężkich obliczeń GPU jako skutku każdego odczytu UI.

Feature flags sterują gotowymi pionowymi przekrojami. Nie są zbiorem ukrytych wyjątków „pomiń walidację, żeby otworzyć projekt”. Jeden projekt używa jednoznacznie wskazanego modelu ownership.

Rollback kodu nie uprawnia starszego programu do zapisu nowego formatu. Otwieramy starszą kopię lub read-only z komunikatem o wersji. Migracja jest transakcją z raportem; oryginał pozostaje zachowany, dopóki użytkownik nie zdecyduje o jego usunięciu.

## 6. Spikes, które muszą zakończyć się dowodem

| Spike | Co rozstrzyga | Wynik wymagany przed wdrożeniem |
|---|---|---|
| Topology/selection lineage | Zakres bezpiecznych operacji CAD i mapowania selekcji | Zestaw transform/split/merge fixtures i przypadków ambiguity. |
| Working store durability | Atomowość i recovery na wspieranych filesystemach | Fault-injection log; udziały sieciowe osobno. |
| Python capture/migration | Które konstrukcje mają roundtrip, a które są script-owned | Macierz przykładów i raport niewspieranych efektów. |
| Native worker isolation | Możliwość bezpiecznego reuse i kolejność zwalniania zasobów | Dwa runy o różnych fingerprintach bez kontaminacji. |
| Checkpoint compatibility | Realny zakres exact/logical resume każdej lane | Powtórzone przebiegi, kompletność RNG/integrator/constraints. |
| Data residency | Koszt granic workflow oraz obserwacji | Profil CPU/GPU, transferów i pamięci dla reprezentatywnych zadań. |
| Scientific projections | Poprawność porównań FDM/FEM i derived values | Referencje analityczne/numeryczne i error bounds. |

Nie są to otwarte pytania oddane użytkownikowi zamiast architektury. To zadania walidujące konkretne decyzje techniczne i ograniczające ryzyko ich implementacji.

## 7. Czego nie robić

Nie zaczynać od masowej zmiany nazw Session → Project. Nie dopisywać jednego ogromnego store React. Nie tworzyć drugiego API tylko dla GUI. Nie próbować przekształcić arbitralnego Pythona w edytowalne AST bez określonego zakresu. Nie zamieniać każdej operacji numerycznej w sieciowy task. Nie upraszczać certyfikatów meshu, checkpointów i pól, żeby łatwiej zintegrować widoki.

Nie blokować całego UI, żeby ukryć brak lokalnych preconditions. Nie odblokowywać wszystkich mutacji przed izolacją runtime’u. Nie uznawać obecności przycisku, enumu, endpointu albo kompilującego się modułu za kwalifikację produkcyjną.

## 8. Stan wykonania tego planu

W tej odpowiedzi przygotowano dokumentację. Nie wykonano zmian repozytorium, buildów, testów ani migracji danych użytkownika. Wszystkie fazy mają status **PLANNED**; wszystkie scenariusze runtime mają status **NOT_RUN**. Kontrole plików dokumentacji dotyczą spójności odnośników i struktury, nie poprawności działającego programu.
