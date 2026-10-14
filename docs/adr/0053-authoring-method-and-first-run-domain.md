# ADR 0053: Metoda modelu i polityka domeny przed pierwszym przebiegiem

Status: zaakceptowana w zakresie implementacji PR #155; weryfikacja nowych źródeł i runtime w toku.
Data: 2026-10-13.

## Kontekst

Użytkownik wybiera FEM/FDM podczas tworzenia modelu. Niekompletna resolution urządzenia, trybu lub capabilities nie może blokować edycji Universe. Wynik wcześniejszego przebiegu nie określa metody obecnie edytowanego modelu. Automatyczna polityka domeny może oczekiwać na pierwszą geometrię; nie oznacza to brakującego silnika.

## Decyzja

1. `active_lane.authored` opisuje zaakceptowane `SceneDocument.study.requested_*`, a przy braku sceny zachowuje projekcję dotychczasowego intent sesji. Pole `source.authored_intent` wskazuje rzeczywiste źródło. `requested`, `resolved`, `operations`, `qualification` nadal opisują resolution wykonania i capabilities; authored FEM nie jest dowodem uruchomienia ani wsparcia solvera FEM.
2. Formularze modelu, drzewo authoring, dobór komendy siatki oraz znacznik metody używają jawnej authored metody. Odczyty pól i danych wykonywanego solvera zachowują resolved method. Jawny brak/conflict/auto w authored nie otrzymuje zastępczej metody z zachowanej siatki. Stare payloady bez pola authored mają dotychczasową ścisłą ścieżkę zgodności.
3. Universe pozostaje istniejącą polityką `universe_mesh_config`, bez drugiego modelu domeny. Efektywna polityka sceny ma pierwszeństwo `study.universe_mesh` nad starszą projekcją `scene.universe`. Brak polityki odpowiada istniejącemu domyślnemu `auto`. Domena i rozdzielczość FDM oraz końcowa siatka FEM pozostają oddzielnymi pojęciami.
4. `manual` wymaga dodatnich skończonych wymiarów. Opcjonalny center zachowuje istniejące znaczenie środka `[0,0,0]` w metrach. Obiekt poza ręcznymi granicami daje diagnostykę blokującą `build_mesh` i `run_solver`. Edycja/utworzenie obiektu pozostaje dozwolone, aby użytkownik mógł poprawić granice albo placement. Nie rozszerzamy domeny po cichu. `auto` zachowuje nieblokujące ostrzeżenia starszych materializowanych bounds i wyznacza domenę zgodnie z istniejącą materializacją.
5. Readiness jest zasobem serwera związanym ze scene revision. Stabilne kroki obejmują metodę, domenę, geometrię, materiał, stan początkowy, interakcje, dyskretyzację, badanie i requested execution. Brak przypisania kieruje do konkretnego solve object. Gotowość konfiguracji urządzenia nie dowodzi jego dostępności; planner/preparation nadal sprawdza legalność operacji.
6. CPU/GPU/auto jest wyborem dla przebiegu/obsługiwanego etapu w tej samej sesji. Engine i resolved execution pokazują wynik danego przebiegu. Nie zmieniamy checkpoint compatibility ani nie obiecujemy migracji aktywnego kroku. Wymuszone GPU zachowuje istniejącą zasadę fail-closed.

## Konsekwencje i zakres

Jeden Python DSL, ProblemIR, workspace, Inspector i typed client pozostają kanoniczne. Nie dodajemy pól OpenAPI ani endpointów. Readiness poszerza istniejącą listę checks; konsument zachowuje także nieznane przyszłe ID. Nawigacja przewodnika korzysta z obecnych selection guards i sesji Apply/Revert/Cancel. Wymagania Airbox zależą od wybranej fizyki/demag, a nie wyłącznie etykiety FEM.

Nie zmieniamy parametrów naukowych, operatorów, solverów ani wartości padding/hmin/hmax. Równość granic używa dotychczasowego porównania geometrii; nie wprowadzamy tolerancji, która dopuściłaby obcięcie ciała.

## Implementacja i migracja

- `crates/fullmag-api/src/router_v2/handlers/sessions/status.rs` — `active_lane_capability_snapshot`.
- `apps/control-room/src/kernel/resources/sessionDiscretization.ts` — `describeSessionAuthoringDiscretization`, `resolveSessionAuthoringDiscretization`, istniejący runtime resolver.
- `crates/fullmag-api/src/router_v2/handlers/model/readiness.rs` — `build_model_readiness`, `domain_check`.
- `crates/fullmag-authoring/src/geometry.rs` — `collect_geometry_diagnostics`, `validate_object_geometry`, `geometry_blocks_mesh_build`, `geometry_blocks_solver_run`.
- `crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs` — `validate_authoring_gate_for_command_with_context`; blokady serwera przed queue/spawn.
- Istniejące zasoby `model/scene`, `model/readiness`, `meshing/policies/universe`, `meshing/builds/current` i bieżący run; brak nowego ciężkiego JSON data plane.

Przejściowy fallback dla payloadów bez authored można usunąć dopiero po wycofaniu starych status producerów i fixture. Jawny authored null nie podlega temu fallbackowi. Rollback zmiany wymaga wspólnego cofnięcia projekcji authoring i jej konsumentów; nie należy usuwać blokady manual bounds bez nowej decyzji o legalności przyciętych domen.

## Dowody

Regresje źródłowe obejmują brak capabilities/resolution, authored FEM wobec starego FDM, konflikt/auto, ręczną domenę poza obiektem, brak wymiarów i pierwszeństwo zaakceptowanej polityki. Aktualne CI/DOM/browser oraz runtime receipts zostaną zapisane w checkpointcie implementacji. Dla FDM CPU, FDM GPU, FEM CPU i FEM GPU brak aktualnego receipt oznacza `NOT VERIFIED`; sam znacznik metody ani mock nie dowodzi wykonania lub kwalifikacji fizyki.
