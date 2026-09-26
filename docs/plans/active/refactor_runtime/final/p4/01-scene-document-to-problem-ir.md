# P4 — adapter SceneDocument → ProblemIR

Status: **source-level adapter FDM oraz publiczny adapter HTTP/OpenAPI i session-scoped caller Control Room są zaimplementowane i mają testy PASS; pełny Live runtime, FEM materialization, browser i fizyka pozostają NOT VERIFIED**.

## Granica danych

Endpoint `/v2/sessions/current/internal/live/materialize-preparation` nie
przyjmuje od klienta fizycznego `ProblemIR`. Request zawiera identyfikator
sesji/przygotowania, rewizję sceny, jawne `RequestedExecution` i osobną
projekcję display. API przechwytuje klon bieżącego `SceneDocument`, sprawdza
sesję, epoch, aktywny `preparation_id` i rewizję przed rozpoczęciem pracy, a na
końcu ponownie sprawdza rewizję oraz ten sam aktywny `preparation_id` pod
blokadą przejścia przed trwałą publikacją receipt. Brak lub podmiana aktywnego
przygotowania zwraca konflikt przed lowering albo przed publikacją.

Konwersja przechodzi przez walidację `scene_document_problem_projection`, a
następnie przez `fullmag.runtime.helper export-scene-ir`. Pythonowy adapter
renderuje SceneDocument do skryptu przez istniejący builder, ładuje skrypt przez
`load_problem_from_script(..., lightweight_assets=True)` i używa
`LoadedProblem.to_ir()` jako canonical writer. Requested backend, device,
precision i mode pochodzą z requestu wykonawczego i są przekazywane jawnie;
geometry assets nie są kopiowane do ProblemIR ani preparation receipt.

Adapter dołącza typed `selections` i `magnetization_constraints` z
SceneDocument po konwersji skryptu. Zachowuje nazwę Study oraz absorbing
boundary podczas renderowania. `source_root` jest jawnie przekazywany przez
API do katalogu bieżącego workspace. Wygenerowany ProblemIR jest dekodowany i
walidowany w Rust przed rozpoczęciem planner materialization.

Ta konkretna granica materializuje obecnie FDM: żądany backend `fdm` lub `auto`
jest dopuszczony, zaś `fem` i `hybrid` są jawnie odrzucane. `auto` pozostaje
zapisane w provenance; nie jest przepisywane na `fdm`. Nie powstaje tu solver
run, native FEM mesh/space ani dowód fizyki.

## Fail-closed i otwarte przypadki

Pythonowy adapter odrzuca niezaimplementowane `outputs.items`, sprzeczne
`universe` i `study.universe_mesh` oraz legacy `region_overrides`. Python i Rust
odrzucają również obrót i skalę obiektu, których owner-frame lowering jeszcze
nie reprezentuje; translacja jest zachowana. Nieobsługiwane transformacje nie
mogą być pominięte podczas tworzenia `ProblemIR`.
Importowane źródła geometrii muszą rozwiązać się względem przekazanego
`source_root`; odpowiadające im geometry assets należą do osobnego producer
receipt i nie są potwierdzone przez ten adapter.

Nie ma jeszcze golden fixture porównującego wszystkie fizyczne pola
SceneDocument, Pythonowy DSL i kanoniczne bajty ProblemIR. Zarządzana trasa
`just verify-api-preparation` uruchomiła trzy bezpośrednie testy handlera:
nieaktywne `preparation_id` i nieaktualna rewizja są odrzucane przed plannerem;
pozytywny fixture przechodzi przez lowering, publikuje trwały receipt i
potwierdza replay. Test pozytywny wymagał jednorazowego `FULLMAG_PYTHON`
override wskazującego interpreter workspace; nie dowodzi on managed Fullmag
runtime. Receipt nie rejestruje tego override. W pierwotnym checkpointcie nie
było jeszcze klienta Control Room wywołującego endpoint; późniejszą integrację
publicznej ścieżki opisuje rewalidacja na końcu dokumentu.

## Weryfikacja tego przyrostu

- `just check-api-source`: **PASS**, produkcyjny binarny API, exit 0,
  `source_changed_during_run=false`. Receipt:
  `storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/0cf6c4280f034ee4813647b3e8cb24b3/receipt.json`.
  Starszy receipt `a37ef001c97a41549e134ffe9bb4acca` powstał z bezpośredniego
  uruchomienia skryptu poza `just`; pozostaje niekwalifikujący i nie jest
  używany jako dowód.
- `just verify-api-preparation`: **PASS**, trzy bezpośrednie testy handlera,
  `source_changed_during_run=false`. Receipt:
  `storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-preparation-tests/2ba52093247642d9ba9e87e7fb7c2203/receipt.json`.
  Trasa kompiluje testowy binarny API; nie wysyła rzeczywistego żądania HTTP.
  Test pozytywny użył jednorazowego `FULLMAG_PYTHON` override z interpretera
  workspace; zmienna nie jest zapisana w receipcie. Wynik nie kwalifikuje
  managed Fullmag runtime.
- Python AST parse dla pięciu plików runtime i nowej regresji: **PASS**.
- `python -m pytest -q -p no:cacheprovider packages/fullmag-py/tests/test_scene_document_problem_ir.py`:
  **1 passed**.
- `git diff --check` dla zmienionych źródeł: **PASS**.
- HTTP/OpenAPI, Control Room browser, managed Fullmag runtime, physics i
  release: **NOT RUN / NOT VERIFIED**.
- Obecne wydzielenie use case'u materializacji do
  `crates/fullmag-api/src/live_scene_preparation.rs` wykonano po powyższym
  receipcie. Ponowna trasa `just verify-api-preparation` nie rozpoczęła testów:
  preflight zwrócił `Permission denied` przy otwieraniu
  `C:\git\fullmag\storage\.initialize.lock`. Dlatego wcześniejsze 3 testy
  dotyczą poprzedniego kształtu handlera; kompilacja nowego use case'u,
  włącznie z fence run ID, pozostaje **NOT VERIFIED**. Do zarządzanej trasy
  dodano czwarty test regresyjny, który odrzuca zmianę run ID przed dostępem
  do store; nie został jeszcze wykonany.
- `just runner-container-status` nie uzyskał odpowiedzi koordynatora. Nie jest
  to dowód awarii adaptera ani kwalifikacji runtime; pełny build i uruchomienie
  pozostają poza tym przyrostem.

## Aktualny stan 23.09.2026

`just verify-api-preparation` wykonało **5 testów**; obejmują one router HTTP,
odrzucenia stale scope/revision oraz pozytywną publikację receipt.
`source_changed_during_run=false`; Python 3.12.2. Receipt:
`storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-preparation-tests/dbc3ab0c918e4b76a08a441c76496331/receipt.json`.
OpenAPI, typy i klient Control Room zostały wygenerowane ponownie; typecheck
Control Room oraz dwa ukierunkowane zestawy testów UI **PASS** (222/222 i
2/2). Nie stanowi to dowodu pełnego managed Live runtime, browsera ani fizyki.

## Rewalidacja 23.09.2026 — owner transforms

Nowa regresja ujawniła rozbieżność: Rustowy adapter odrzuca owner rotation i
scale, ale Pythonowa ścieżka `SceneDocument → ProblemIR` wcześniej je pomijała.
`build_builder_from_scene_document` waliduje teraz quaternion i scale zgodnie
z ograniczeniem Rustowego owner-frame lowering; translację nadal przekazuje do
geometrii. Obrót/skala pozostają nieobsługiwane i kończą się czytelnym błędem,
zamiast tworzyć inny fizycznie model.

`python -B -m pytest -q -p no:cacheprovider
packages/fullmag-py/tests/test_scene_document_problem_ir.py` — **3 passed**.
To jest lokalna regresja source-level. Pełny golden parity wszystkich pól
SceneDocument/ProblemIR, managed API/runtime, FEM mesh/space, browser i
walidacja fizyczna nadal pozostają **NOT VERIFIED**.

## Rewalidacja 23.09.2026 — geometria i sampled-field

Scena z `magnetization_assets.kind = sampled_field` była renderowana jako
uniform magnetization, ponieważ adapter skryptu rozpoznawał tylko `file` i
`sampled`. Renderer obsługuje teraz wszystkie trzy rodzaje pliku, a
`SceneDocument → ProblemIR` odrzuca fizyczny asset `file`/`sampled`/
`sampled_field` bez niepustego `source_path` przed próbą ładowania skryptu.
Regresje sprawdzają dokładne wektory w kanonicznym `initial_magnetization` i
czytelny błąd braku ścieżki zamiast przypadkowego `FileNotFoundError`.

`test_scene_document_problem_ir.py` oraz `test_scene_document_roundtrip.py`:
**11 passed** łącznie; `check_repo_consistency.py`, `rustfmt --check` dla
zmienionego pliku CLI i `git diff --check`: **PASS**. Jest to source-level
coverage wybranych przypadków adaptera, nie pełny golden fixture. Porównanie
wszystkich pól fizycznych SceneDocument/DSL/ProblemIR, managed runtime,
FEM mesh/space, browser i walidacja fizyczna pozostają **NOT VERIFIED**.

Rozszerzony differential regression porównuje kanoniczne bajty wspólnych pól
fizycznych z osobną ścieżką generowanego Python DSL. Obejmuje geometrię,
materiały, magnetyzację i absorbing boundary, selekcje, constraints, energię,
study oraz pozostałe stabilne pola ProblemIR; requested backend, precision,
runtime selection i FDM hinty są sprawdzane osobno. Builder zachowuje teraz
nazwę study z Problem jako nazwę SceneDocument i generowany skrypt. Zestaw:
`test_scene_document_problem_ir.py` + `test_scene_document_roundtrip.py` —
**11 passed**; `test_script_builder_roundtrip.py` — **35 passed, 28 subtests
passed**. Geometrie pomocnicze zachowują teraz typ DSL (`geometry`, `conductor`,
`electrode`, `antenna`) i translację podczas bootstrapu oraz renderowania
canonical script. Regression porównuje geometrię, regiony i object regions
auxiliary `conductor` z bezpośrednią ścieżką Python DSL. Ponieważ obecny
ProblemIR/Python DSL nie przenosi niezależnego `object_id` pomocniczego
obiektu, adapter odrzuca przypadek, w którym `id != name`, zamiast wiązać
referencje z błędną nazwą. To jest ograniczony differential test, a nie golden
fixture całego wire payloadu: `problem_meta`, potencjalne FEM hints i pełna
macierz fizyczna pozostają do odrębnego pokrycia.

## Rewalidacja 24.09.2026 — fail-closed SceneDocument i table autosave

Adapter Python teraz jawnie odrzuca nieznane pola `scene.v2` i `study`,
nieobsługiwane `outputs.items`, błędne typy oraz niepuste `study.mesh_interfaces`.
`table_autosave` przechodzi z `SceneDocument.study` do buildera i kanonicznego
`ProblemIR`, razem z `table_id`, kadencją, quantities i expressions. Rustowy
`SceneStudyState` oraz adaptery `SceneDocument ↔ ScriptBuilderState` zachowują
ten sam typowany payload.

Pierwszy zarządzany przebieg API wykrył ważną zgodność domyślnego stanu:
Rust pomija pusty wektor `field_drives.drives`, serializując `field_drives` jako
`{}`. Adapter akceptuje teraz ten stan jako pustą listę, ale nadal odrzuca
`null`, błędną strukturę i nieznane pola. Po poprawce `test_scene_document_problem_ir.py`
z `test_table_autosave.py` przechodzi **58/58**.

`SceneResource` zachowuje `monitors.planar` i `study.table_autosave` w projekcji
oraz round-tripie do `SceneDocument`; typ requestu `PUT /model/scene` i jego
OpenAPI są aktualizowane razem. Weryfikacja: zarządzane testy materializacji
API **5/5**, test projekcji `SceneResource` **1/1**, test adaptera Rust
`SceneDocument → ScriptBuilderState` **1/1**, testy kontraktu zarządzanej trasy
**13/13**. OpenAPI codegen, typy i klient Control Room, `check:api-hygiene` oraz
`typecheck` — **PASS**. Receipt'y znajdują się pod
`storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/`;
aktualny test API preparation: `api-preparation-tests/6c9a98d7b94e49feacd66cee30186197/receipt.json`,
adapter Rust: `authoring-scene-adapter-tests/48e8dcf9b84945deb53d37691a349e8b/receipt.json`,
a codegen OpenAPI: `api-openapi-codegen/1fa4c518c20c42f2bc32fd70451730f5/receipt.json`.

To nadal nie jest golden parity wszystkich pól sceny ani dowód użycia
materializatora przez pełny Live runtime. Native FEM mesh/space, browser,
walidacja fizyczna i release pozostają **NOT VERIFIED**; P4 pozostaje **50%**,
a plan globalny około **27%**.

## Rewalidacja 24.09.2026 — current modules i kodowanie OpenAPI

Adapter `SceneDocument → ProblemIR` odrzuca teraz nieobiektowy stan
`current_modules`, nieznane pola kontenera, modułu, `drive` i
`excitation_analysis`, a także błędne kształty list i obiektów. Rustowe typy
`SceneCurrentModulesState`, `ScriptBuilderCurrentModuleState`, `drive` oraz
`ScriptBuilderExcitationAnalysisState` mają zgodne `deny_unknown_fields`.
Migracja legacy `current_transport` zachowuje osobny dekoder, a częściowe
legacy szkice anteny nadal przechodzą adapter buildera i są potwierdzone
testem round-trip.

Weryfikacja po zmianie:

- Połączone suite'y SceneDocument, table autosave, current transport,
  spin-transport runtime round-trip i SceneDocument round-trip: **122/122 testy
  + 45/45 subtestów PASS**.
- Zarządzane trasy API preparation, `SceneResource`, authoring serde/adapter
  oraz OpenAPI codegen: **PASS**. Receipts:
  `api-preparation-tests/fbd538fbcd6f4c2e89643c05b7af1cc0/receipt.json`,
  `api-scene-resource-tests/266cea63f0dd4e049384b2007afaf0db/receipt.json`,
  `authoring-scene-adapter-tests/372078a5e78e4e8cb0de7f91374f6322/receipt.json`,
  `api-openapi-codegen/1addac332a544c9480f13338b5741db3/receipt.json`.
- Wspólny weryfikator OpenAPI dekoduje teraz wyjście CLI jawnie jako UTF-8;
  wygenerowane OpenAPI, typy i ścieżki są zsynchronizowane. `check:api-hygiene`
  oraz Control Room `typecheck`: **PASS**.
- Testy kontraktu tras: **13/13 PASS**; `git diff --check`: **PASS**.

To nadal source/API contract evidence. Pełna golden parity, managed Live i
browser, FEM mesh/space oraz walidacja fizyczna pozostają **NOT VERIFIED**.
P4 (**50%**) i całość (~**27%**) bez zmian.

## Rewalidacja — pełny kontrakt legacy current_transport

Kontrola migracji wykazała, że wcześniejszy dekoder sprawdzał wartości pól,
ale ignorował nieznane klucze. `current_transport` odrzuca teraz nadmiarowe
pola w całym typowanym payloadzie: module, referencjach regionów, materiałach,
brzegach i powierzchniach, solverze, obwiedniach oraz strukturach
`structured_current_closure` i `conservative_current_view`. Nieznane dane
wewnątrz `lead_mesh` pozostają zachowane jako payload MeshIR, zamiast być
odrzucane lub gubione. Obie ścieżki migracji — `current_transports` oraz
`current_modules.modules` — korzystają z tego samego dekodera.

Weryfikacja po zmianie:

- Sceny, table autosave, current/spin transport, oba warianty closure i SOT:
  **159 testów + 66 subtestów PASS**. Macierz odrzucania unknown fields obejmuje
  moduł, regiony, materiały, brzegi/powierzchnie, solver/linear, obwiednię,
  structured closure i conservative view.
- Zarządzane `just verify-api-preparation`: **PASS**; receipt:
  `api-preparation-tests/075054772039409e9ce808a5a9c55591/receipt.json`.
  Receipt pinuje `master` HEAD
  `93f11dbc564c00b725d174ccb2fd0ff9a96493c9`, dirty source tree digest
  `1cdc1264c4cbc424e64802a19a40da4a2d70876bf172e266731f59fdab7fdaf6`;
  SHA-256 bieżącego `scene_document.py` zgadza się z receipt.
- `git diff --check` dla zmienionych plików: **PASS**.

To nadal walidacja adaptera i kontraktu API; nie dowodzi pełnej parity całego
wire payloadu ani działania materializatora w Live runtime. Native FEM,
browser/Live runtime, walidacja fizyczna i release pozostają **NOT VERIFIED**.
P4 (**50%**) i całość (~**27%**) bez zmian.

## Rewalidacja 24.09.2026 — FDM bez domyślnych hintów FEM

Differential regression wykazał, że renderer rozpoznawał czysty FDM wyłącznie
po obecności `DiscretizationHints.fdm`. Gdy problem wybierał FDM bez jawnych
hintów, standardowy `mesh_defaults` SceneDocument trafiał do wygenerowanego
skryptu i tworzył FEM `discretization_hints` z wyprowadzonym `hmax`, mimo że
bezpośredni Python DSL zwracał `None`. `_is_pure_fdm_problem` sprawdza teraz
wybrany backend z `Problem.runtime`; domyślne ustawienia FEM nie są renderowane
dla FDM, a jawne FEM hints nadal wykluczają ten skrót.

Regresja porównuje teraz cały FDM ProblemIR z bezpośrednim ProblemIR; wyłączone
są wyłącznie `problem_meta.script_source` i `problem_meta.source_hash`, bo dwa
niezależne renderowania mają odrębne teksty i hashe. Włącznie porównywane są
`backend_policy`, pełne `runtime_metadata`, builder manifest i wszystkie pola
fizyczne. FEM differential osobno porównuje jawne `discretization_hints`; nie
wymaga identyczności `mesh_workflow`, ponieważ projekcja SceneDocument zawiera
także domyślne ustawienia edytora, których źródłowy skrypt DSL nie deklarował.
Ta różnica pozostaje częścią otwartej pełnej golden parity i nie jest uznana za
równoważność runtime.

Target FDM golden differential: **1/1 PASS**. Weryfikacja: suite'y SceneDocument, round-trip, table autosave, current/spin
transport, closure i SOT — **156 testów + 109 subtestów PASS**; repozytoryjna
spójność i celowany `git diff --check` — **PASS**. Zarządzane
`just verify-api-preparation` — **PASS**, `source_changed_during_run=false`,
`master` HEAD `93f11dbc564c00b725d174ccb2fd0ff9a96493c9`; receipt:
`api-preparation-tests/5eb4edfb9ef142a4ab93233fc6a29ed7/receipt.json`.
SHA-256 `script_builder.py` w receipt jest zgodny z bieżącym plikiem. To test
źródła i trasy API; nie kwalifikuje FEM, Live/browser ani fizyki. P4 (**50%**)
i całość (~**27%**) pozostają bez zmian.

## Rewalidacja 24.09.2026 — pełny differential FDM/FEM

Pełny porównawczy test ProblemIR ujawnił dwie rozbieżności FEM. Bootstrap
SceneDocument wnosił domyślne opcje jakości i algorytmu z typowanego stanu
edytora, a nie przenosił `study_pipeline` do metadanych kanonicznego IR. Przy
aktywnym pipeline w sesji interaktywnej DSL ustawia też `wait_for_solve`; adapter
odtwarza ten warunek z zachowanego pipeline. Filtr domyślnych mesh opcji działa
wyłącznie dla bootstrapu SceneDocument, więc zwykły Python builder nadal
zachowuje jawne `compute_quality=True` i `algorithm_3d=1` w eksporcie.

FDM i bogaty przypadek FEM porównują teraz całe ProblemIR po usunięciu wyłącznie
`problem_meta.script_source` i `source_hash`. Testy obejmują m.in. geometrię,
regions, material fields, coupling, monitor, field drives, stages, pipeline,
runtime metadata i backend policy. Source suite SceneDocument, round-trip,
table autosave, current/spin transport, closure, SOT i script builder: **193
testy + 137 subtestów PASS**; pozostały 2 oczekiwane ostrzeżenia deprecacyjne.
`check_repo_consistency.py` i celowany `git diff --check`: **PASS**.

Zarządzane `just verify-api-preparation`: **PASS**, `source_changed_during_run=false`,
`master` HEAD `93f11dbc564c00b725d174ccb2fd0ff9a96493c9`; receipt:
`storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-preparation-tests/062cde9675a444769cb0b11b035f9637/receipt.json`.
SHA-256 `scene_document_ir.py` i `script_builder.py` odpowiadają receiptowi.
To domyka reprezentatywny pełny differential, nie całą macierz pól ani FEM
runtime: FEM mesh/space, managed Live, browser i walidacja fizyczna pozostają
**NOT VERIFIED**. P4 (**50%**) i całość (~**27%**) bez zmian.
