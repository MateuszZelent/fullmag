# Dowody, granice weryfikacji i decyzje architektoniczne

## Metoda

Ponownie odczytano wskazane niżej kontrakty poprzez połączenie GitHub. Sprawdzono bieżący `master` i przypięto odczyty do SHA `31bac350a15c0af070287de92d4e0c1a6dabab0e`. Dodatkowo przeczytano poprzednią architekturę w lokalnym pakiecie dokumentów i oficjalne opisy COMSOL/CST.

Zakres jest statyczny i selektywny. Nie wykonano pełnego przeglądu wszystkich implementacji, aplikacji, testów ani migracji. Istnienie struktury/enumu/modułu jest dowodem kontraktu w źródle, nie produkcyjnego działania funkcji. W szczególności nie uznajemy wszystkich rozszerzeń physics ani wszystkich kombinacji GPU za zakwalifikowane.

W dokumentach zdania opisujące nowy system są propozycją. Poniższy rejestr podpiera twierdzenia o zastanym kodzie oraz wyjaśnia, co należy zachować. Nie ma tu wnioskowania o wewnętrznej implementacji komercyjnych programów.

## E01 — baza odczytu

[Commit bazowy](https://github.com/MateuszZelent/fullmag/commit/31bac350a15c0af070287de92d4e0c1a6dabab0e). Odczyt branch API potwierdził ten commit na `master`. Commit pochodzi z 15 września 2026 r.; dokument powstał 20 września. To nie stan nieopublikowanych lokalnych worktree użytkownika.

## E02 — SceneDocument i SceneStudyState

[scene.rs:1–250](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-authoring/src/scene.rs#L1-L250), [285–410](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-authoring/src/scene.rs#L285-L410), [410–650](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-authoring/src/scene.rs#L410-L650).

Odczyt potwierdza singular `study`, obecność materiałów/tekstur/transportów/constraints oraz osadzenie `editor` w SceneDocument. SceneStudyState łączy globalne ustawienia fizyczne, mesh, solver, runtime intent i stages. SceneObject ma ID oraz wymaganą referencję materiału. Pola rotacji/skali w DTO nie są dowodem wykonania wszystkich transformacji przez każdy backend.

## E03 — istniejące studies, makra i konfiguracje

[builder.rs:1–530](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-authoring/src/builder.rs#L1-L530), [650–900](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-authoring/src/builder.rs#L650-L900).

StudyPipelineDocument zawiera primitive/macro/group nodes. Rodzaje obejmują m.in. Relax, Run, Eigenmodes, FrequencyResponse, Hysteresis i ParameterSweep. Istnieją stabilne ID węzłów i źródła UI/script. Widać także konfiguracje solvera i meshingu. Nie przeanalizowano wykonawców każdego wariantu; dokument nie twierdzi, że cały ten katalog jest produkcyjnie wspierany.

## E04 — API persystencji wokół current session

[persistence/session.rs:1–270](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-api/src/router_v2/handlers/persistence/session.rs#L1-L270).

Odczytano endpointy eksportu/importu `.fms`, checkpointów, field states i recovery. Są to adaptery delegujące do modułu session_persistence i używające `/v2/sessions/current`. To dowód obecnego scope tych ścieżek, nie dowód braku jakichkolwiek innych funkcji zapisu w repozytorium.

## E05 — neutralny graf zakresów fizyki

[physics_graph.rs:1–175](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-authoring/src/physics_graph.rs#L1-L175).

PhysicsScopeRef uwzględnia global/object/region/interface/cross-object/unresolved. Istnieją PhysicsActivation, PhysicsModuleIR i PhysicsGraphIR. Komentarz oraz implementacja wskazują graf zakresów i obecności modułów, a nie uniwersalny solver równań. Widoczny status semantic_only nie oznacza produkcyjnego wykonania transportu.

## E06 — fundament zapisu

[fullmag-session/src/lib.rs](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-session/src/lib.rs).

Istnieją moduły CAS, SessionStore, `.fms` ZIP64, capture, typy i mesh operations. Uzasadnia to adaptację istniejącego storage. Sam moduł nie dowodzi jeszcze wymaganych gwarancji transakcyjnych na każdym systemie plików — pozostaje spike fault-injection.

## E07 — profile, manifesty i run_refs

[fullmag-session/src/types.rs:1–280](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-session/src/types.rs#L1-L280).

SaveProfile: Compact/Solved/Resume/Archive/Recovery. RestoreClass rozróżnia ExactResume/LogicalResume/InitialConditionImport/ConfigOnly. FmsSessionManifest ma `run_refs: Vec<String>`, a workspace manifest zawiera m.in. project/script/scene references. Nie można więc opisywać Fullmag jako systemu całkowicie pozbawionego trwałych projektów lub wielorunowego formatu.

## E08 — checkpoint compatibility i tensor metadata

[fullmag-session/src/types.rs:280–465](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-session/src/types.rs#L280-L465).

Compatibility zawiera restart ABI, problem/plan hash, engine/runtime family, precision, discretization i layout signatures. TensorDescriptor opisuje dtype/shape/logical_axes/chunks; FieldRole odróżnia m.in. Primary, ResumeAux i PreviewOnly. Wyliczenie TensorDtype w tym fragmencie nie ma własnego wariantu complex. Nie oznacza to, że w innych warstwach nie istnieje kodowanie danych zespolonych.

## E09 — Python problem i cache certyfikowanej dyskretyzacji

[problem.py:1–230](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/packages/fullmag-py/src/fullmag/model/problem.py#L1-L230).

Odczyt obejmuje typy/importy i kontrakty fingerprintów cache FEM, m.in. source identity, resolved policy, Gmsh/repair/certifier versions i topology fingerprint. Odczyt nie obejmuje wszystkich wywołań materializacji; nie twierdzimy, że każdy konstruktor Python wykonuje meshing.

## E10 — publiczny Python DSL

[world.py:1–260](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/packages/fullmag-py/src/fullmag/world.py#L1-L260).

Odczyt potwierdza flat API budujące Problem, class-based API i bogate rodziny importowanych modeli. Z tego wynika potrzeba zachowania wygodnych skryptów, nie porzucenia ich na rzecz GUI-only authoring. Wprowadzane per-context binding jest propozycją, nie opisem obecnej izolacji.

## E11 — IR i geometria

[fullmag-ir/src/lib.rs:1–220](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-ir/src/lib.rs#L1-L220), [model.rs:1–220](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-ir/src/model.rs#L1-L220).

Istnieją osobne moduły kontraktów eigen/response, mesh, physics, constraints i study. Geometria zawiera prymitywy, waveguides, CSG i Translate; referencje w RegionIR są stringowe, a ObjectRegionIR ma własny region_id. Nowy model authoringu nie może zgubić istniejących rodzajów geometrii i ram regionów.

## E12 — engine

[fullmag-engine/src/lib.rs:1–180](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-engine/src/lib.rs#L1-L180).

Odczytano strukturę modułów i re-exports FDM, integratorów, constraints i innych mechanizmów. Nie audytowano ponownie implementacji wszystkich operatorów. Wymagania GPU residency i rollback są wymaganiami zachowania/kwalifikacji, nie nowymi dowodami wydajności tej wersji.

## E13 — runner

[fullmag-runner/src/lib.rs:1–205](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-runner/src/lib.rs#L1-L205).

Widać istniejące moduły wykonania, artefaktów, observation, eigen, response, hysteresis i runtime registry oraz walidację timestep policy. Zachowujemy te mechanizmy; nazwy modułów i komentarze historyczne nie rozstrzygają aktualnej pełnej kwalifikacji lane’ów.

## E14 — scratch runtime ownership

[scratch_runtime.rs:100–245](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/crates/fullmag-cli/src/scratch_runtime.rs#L100-L245).

Sprawdzana jest zmiana sesji, backendu i scene revision; odpowiednia gałąź kończy child i raportuje zmianę ownership aktywnej komendy. Potwierdza to konieczność izolacji runu przed pełnym odblokowaniem mutacji projektu. Nie jest to twierdzenie, że każda zmiana dowolnego pola zawsze zabija każdy runtime.

## E15 — globalny startup gate

[SimulationStartupOverlay.tsx:580–655](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx#L580-L655).

Przy widocznym przygotowaniu WorkspaceStartupGateView nie zwraca children, a osobno montuje diagnostykę. Fragment pokazuje również przekształcenie preparation do stale przy disruption. Nowa architektura usuwa zależność istnienia aplikacji od tego mechanizmu; szczegółowy wcześniejszy audyt startupu pozostaje materiałem historycznym.

## E16 — workspace Cargo

[Cargo.toml:1–160](https://github.com/MateuszZelent/fullmag/blob/31bac350a15c0af070287de92d4e0c1a6dabab0e/Cargo.toml#L1-L160).

Potwierdzono istniejące pakiety authoring, API, CLI, IR, plan, runner, engine, session, py-core, sys oraz desktop Tauri. `fullmag-application` proponowane w planie nie należy do odczytanego workspace’u — jest planowanym nowym pakietem.

## W01 — COMSOL Model Builder

[Oficjalny opis Model Builder](https://www.comsol.com/comsol-multiphysics/model-builder), odczyt 20.09.2026.

Punkt odniesienia: parametryczne sekwencje geometrii i selekcje, kroki study używające wcześniejszych rozwiązań, edytowalne konfiguracje solverów, narzędzia wynikowe. To opis funkcjonalny producenta, nie źródło twierdzeń o strukturze kodu produktu.

## W02 — COMSOL Model Manager

[Oficjalny opis Model Manager](https://www.comsol.com/comsol-multiphysics/model-manager), odczyt 20.09.2026.

Punkt odniesienia: trwałe modele i pliki pomocnicze, wersje, porównywanie i zarządzanie danymi. Nowa propozycja Fullmag nie wymaga skopiowania enterprise database w pierwszym lokalnym wydaniu.

## W03 — CST Design Environment

[Oficjalny opis Design Environment](https://www.3ds.com/products/simulia/cst-studio-suite/electromagnetic-design-environment), odczyt 20.09.2026.

Punkt odniesienia: wspólne środowisko modelowania, przygotowania analiz i postprocessingu oraz kontekstowe narzędzia. Nie przenosimy deklaracji marketingowych o szybkości na ocenę Fullmag.

## W04 — CST System Assembly and Modeling

[Oficjalny opis Systems Modeling](https://www.3ds.com/products/simulia/cst-studio-suite/electromagnetic-systems-modeling), odczyt 20.09.2026.

Punkt odniesienia: przepływ wyników pomiędzy symulacjami i porównywanie solverów/konfiguracji w projekcie. Proponowany coordinator Fullmag i jego fencing są własnym projektem, nie rzekomym opisem mechanizmu SAM.

## Rejestr decyzji ADR-CAE

Wszystkie decyzje mają status **PROPOSED**. Prefiks nie zajmuje automatycznie numeracji ADR w repozytorium. Akceptacja i mapowanie na repozytoryjne ADR należą do wdrożenia.

| ID | Decyzja | Konsekwencja / kompromis |
|---|---|---|
| ADR-CAE-01 | Trwały projekt zamiast current session jako korzenia produktu | Potrzebna migracja ownership i tożsamości; nie wystarcza rename. |
| ADR-CAE-02 | Jedna semantyka authoring/IR dla GUI i Python | Bindingi i schema parity wymagają wspólnych testów. |
| ADR-CAE-03 | Scene/render model jest projekcją | Więcej jawnych warstw, ale brak fizyki ukrytej w rendererze. |
| ADR-CAE-04 | Parametry i geometry feature graph są first-class | Konieczne AST, dependency tracking i selekcje z diagnostyką. |
| ADR-CAE-05 | Study, solver config i execution profile są odrębne | UI musi pokazywać efektywną konfigurację i override provenance. |
| ADR-CAE-06 | Input runu niezmienny, dependencies rozstrzygane do artefaktów | Potrzebne durable submit, case mapping i publication checks. |
| ADR-CAE-07 | Control Room zachowany jako eksperyment interaktywny | Steering ma safe points, segmenty i osobne reguły niż edycja. |
| ADR-CAE-08 | Cztery różne grafy i typowane porty | Nie stosujemy jednego dowolnego JSON graph do całego programu. |
| ADR-CAE-09 | Rozwiązanie i jego ocena naukowa odrębne od statusu tasku | Kryteria zbieżności stają się wejściem kolejnych analiz. |
| ADR-CAE-10 | Jeden wspólny viewport i jawny kontekst źródeł | Nie dublujemy FDM/FEM UI; konteksty/caches muszą być izolowane. |
| ADR-CAE-11 | Dataset i plot niezależne od stanu live | Więcej metadanych, ale trwały headless postprocessing. |
| ADR-CAE-12 | Reuse istniejącego `.fms`, CAS i klas restore | Migracja formatu bez konkurencyjnego storage. |
| ADR-CAE-13 | Jeden application kernel; worker protocol niezależny od UI | Nowa biblioteka fullmag-application, extraction zamiast big-bang rewrite. |
| ADR-CAE-14 | Project-scoped API, legacy current wyłącznie adapter | Kontrolowany cutover i brak dwóch kolejek/writerów. |
| ADR-CAE-15 | Selective invalidation z certyfikatami i producer identity | Konieczne dowody pełnych zależności; niewiadome obsługiwane zachowawczo. |
| ADR-CAE-16 | Four-lane qualification i executed receipts | UI nie obiecuje wsparcia na podstawie obecności formularza. |
| ADR-CAE-17 | Incomplete authoring zapisuje się bez solvera | Stan draftu edytora osobny od poprawnego modelu wykonywalnego. |
| ADR-CAE-18 | Jawna granica zaufania plików/skryptów/rozszerzeń | Open nie wykonuje kodu; nieznane schematy nie są niszczone. |

## Ponowna kontrola tez

Przed zamknięciem dokumentacji odrzucono następujące zbyt mocne tezy:

- „Fullmag nie ma zapisu projektu” — nieprawda; są `.fms`, SessionStore, profile i recovery.
- „Nie ma studies” — nieprawda; istnieje pipeline primitive/macro/group.
- „Storage potrafi tylko jeden run” — nie wynika z kodu; manifest posiada run_refs.
- „Wystarczy przenieść progress do dolnego panelu” — nie rozwiązuje własności projektu i runtime’u.
- „Każdy Python constructor mesh’uje” — nie dowiedziono tego; potrzebny audyt konkretnych ścieżek materializacji.
- „DAG załatwia wszystkie sprzężenia fizyczne” — nie; pętle/monolityczne solve mają własną semantykę.
- „Snapshot przy Submit zawiera wszystkie przyszłe wyniki” — nie; przyszłe wejścia są typowanymi zależnościami rozstrzyganymi później.
- „Idempotencja gwarantuje exactly-once obliczeń po awarii” — nie; zabezpiecza intent i kontrolowaną publikację.
- „Jednakowa liczba DOF wystarcza do zgodności pól” — nie; potrzebne są topology/space/layout/scope.
- „Nowa architektura jest już zweryfikowana runtime” — nie; dokument jest specyfikacją, scenariusze mają NOT_RUN.
