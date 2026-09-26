# Checkpoint P4 — PreparationPlan

Status: **P4-A/P4-B, FDM preparation materialization, execution binding, application acceptance, durable receipt publication, source-level SceneDocument → ProblemIR adapter i provenance UI slice PASS / P4 IN PROGRESS**.

Krok P4 dotyczący native FEM jest opisany w
[`02-native-fem-mesh-space-producer.md`](02-native-fem-mesh-space-producer.md).
Źródłowy producer, addytywne C ABI, Rustowy walidator fingerprintów,
materializer API i caller Control Room dla FEM Compute są już dodane.
Source-level receipt wiąże teraz osobnym schematem fingerprint kanonicznego
wejścia, topologii MFEM, opcjonalnego build reportu oraz per-domain quality i
jej marker/count mapy. Weryfikacja źródłowa odrzuca raport zdegradowany i
niespójne podsumowania. Brak reportu lub mapy pozostaje jawny i nie jest
akceptacją jakości. Source-level testy planera i application obejmują teraz
materializację FEM oraz odrzucenie rebindingu; używają syntetycznego native
evidence i nie weryfikują ABI ani MFEM. Pozostają kontrakt C++/ABI przez runner,
walidacja progów jakości dla rodzin elementów, weryfikacja HTTP/API oraz
runtime caller'a. Dedykowana recepta
`just verify-fem-mesh-space-preparation-contract` pokrywa target C++ i wrapper
FFI w Runnerze; parser just potwierdzono przez dry-run. Próba została zatrzymana
przed Compose, bo storage preflight wykrył istniejący katalog `.fullmag`
wymagający zinwentaryzowanej migracji. Procent P4 nie rośnie przed przejściem
tych bramek.

`fullmag-plan::PreparationPlan` jest wspólnym, wersjonowanym kontraktem dla
przygotowania FDM i FEM. Zachowuje `problem_fingerprint`, rewizję sceny,
requested/resolved backend oraz pięć jawnych producentów:

- `geometry`,
- `display`,
- `grid`,
- `mesh`,
- `space`.

Każdy producent ma własny identyfikator, schema/version oraz fingerprint
wejścia i wyjścia. Plan i producent mają deterministic `canonical_json_bytes()`
i digest `sha256:<hex>`. `resolved_backend` musi być jawnie `fdm` albo `fem`;
`auto` nie przechodzi granicy przygotowania. Istniejący
`FdmGridCertificateIR` i `PeriodicMeshCertificateV6IR` są opakowywane przez
adaptery bez kopiowania ich topologicznego digestu i bez twierdzenia, że
solver lub function space został uruchomiony.

P4-B dodaje `PreparationCertificate` jako walidator nad istniejącym
producerem. Dla meshu wymagane są quality evidence, dodatni cell count i
marker map; dla function space wymagany jest zgodny fingerprint meshu,
opcjonalnie także zgodny marker map. Niezgodność któregokolwiek z tych
identyfikatorów blokuje akceptację. `assess_selective_reuse()` porównuje każdy
producer osobno, a `PreparationStateTransfer` jest osobnym, jawnie
zidentyfikowanym artefaktem — reuse meshu nie awansuje reuse space ani operatora.

Warstwa `fullmag-application::PreparationReceipt` wymaga jednego canonical
planu i dokładnie jednego zweryfikowanego certyfikatu dla każdego z pięciu
producerów. Receipt odrzuca zmianę planu po obliczeniu digestu, brak certyfikatu,
duplikat oraz rebinding certyfikatu do innego producer/outputu.

`PreparationMaterialization::from_fdm_execution_plan()` materializuje obecnie
pełny FDM slice z istniejącego, resolved `ExecutionPlanIR`. Producer `grid`
wiąże się z `FdmGridCertificateIR`, a `mesh` i `space` mają osobne, jawne
tożsamości `fdm_cell_domain.v1` i `fdm_grid_space.v1`; nie są przedstawiane jako
FEM mesh ani FEM function space. Wrapper application przyjmuje immutable
`ProblemIR`, oddzielny display projection i canonicalizuje fingerprinty
projekcji. Brak certyfikatu grid, pusty aktywny domain, brak markerów lub
resolved backend FEM kończą się błędem zamiast częściowym receipt'em.

`PreparationBinding` jest tworzony wyłącznie z już zweryfikowanego receiptu i
przenosi do `ResolvedTaskInput` identyfikator przygotowania, digest planu oraz
digest całego receiptu. Dzięki temu worker-facing `Prepare` ma jawne wejście
przygotowania; pełny receipt pozostaje w durable run catalog, a binding nie
udaje dowodu uruchomienia solvera. `WorkerCoordinator::prepare` wymaga teraz
pełnego receiptu i odrzuca komendę, gdy jego binding nie jest identyczny z
`ResolvedTaskInput.preparation`.

## Dowód

`cargo test --locked -p fullmag-plan preparation --lib`: **8 passed**.

`cargo test --locked -p fullmag-application preparation --lib`: **5 passed**.

`cargo test --locked -p fullmag-application --lib`: **14 passed**.

Testy obejmują stabilność canonical planu, fail-closed dla niewłaściwego slotu
producenta i nierozstrzygniętego backendu, zachowanie fingerprintu istniejącego
certyfikatu FDM, walidację quality/marker/space, niezależne decyzje reuse oraz
odrębny state transfer, materializację FDM z resolved planu oraz brak grid
evidence. Testy application obejmują kompletny receipt, odrzucenie
plan/certificate rebinding, niezależność fingerprintu projekcji od kolejności
kluczy JSON, hashujący binding receiptu do wejścia wykonawczego oraz
odrzucenie przez coordinatora niezgodnego receiptu przed wysłaniem `Prepare`.

Warstwa sesji publikuje teraz `FmsPreparationReceipt` jako niezmienny
`runs/<run_id>/preparation_receipt.json`. Publikacja wymaga istniejącego
`run_catalog.v1`, sprawdza digest planu i payloadu, odrzuca podmianę już
zaakceptowanego receiptu oraz zachowuje plik w reachability i eksporcie `.fms`.
API przyjmuje zweryfikowany `fullmag-application::PreparationReceipt` przez
wewnętrzny endpoint, wiąże go z aktywną sesją/runem, a zasób preparation
udostępnia wyłącznie identity/provenance digesty. Endpoint
`/v2/sessions/current/internal/live/materialize-preparation` przyjmuje teraz
`RequestedExecution` i osobny display projection. API przechwytuje bieżący
`SceneDocument`, sprawdza `session_id`, epoch, aktywny `preparation_id` i dokładną
rewizję, waliduje scenę w Rust, a następnie wywołuje Pythonowy adapter, który renderuje DSL, ładuje
problem przez publiczną ścieżkę i serializuje kanoniczny `ProblemIR`. Selection
definitions oraz magnetization constraints są dołączane z typed IR; geometry
assets pozostają poza tym receiptem. API waliduje wygenerowany IR i ponownie
sprawdza rewizję sceny oraz aktywny `preparation_id` pod blokadą przejścia przed
publikacją receiptu. Brak przygotowania lub jego zmiana podczas lowering
kończy się konfliktem bez publikacji.
Materializator FDM przyjmuje wyłącznie żądany backend `fdm` lub `auto`; wybór
`fem`/`hybrid` jest odrzucany. Żądanie `auto` pozostaje jawne i nie jest
przepisywane na FDM. Poprzednia idempotentna publikacja receiptu nadal wiąże
replay z tym samym payloadem mimo nowego timestampu obwiedni.

Obsługiwane lowerowanie fail-closed odrzuca obecnie niezaimplementowane
`outputs.items`, sprzeczne definicje universe i legacy `region_overrides`.
Nie jest to jeszcze cross-language golden-parity dowód wszystkich pól
`SceneDocument`; konkretne granice są zapisane w
[`01-scene-document-to-problem-ir.md`](01-scene-document-to-problem-ir.md).

Control Room pokazuje zaakceptowany `preparation_id` i `plan_fingerprint` w
panelu przygotowania, kiedy resource zawiera receipt; nie tworzy wartości
zastępczych przy jego braku.

P4-C ma teraz także command-backed akcje `builder-build-geometry` i
`builder-validate` w ribbonie Geometry. Pierwsza wywołuje istniejący endpoint
realizacji geometrii, a druga endpoint walidacji; obie wymagają
aktualnej rewizji kanonicznej sceny i odrzuca odpowiedź, której
`source_scene_revision` nie jest zgodna z rewizją wejściową. Po zgodnej
odpowiedzi akcja realizacji invaliduje revision-fenced resources realizacji,
regionów, diagnostyki regionów, universe i readiness, a walidacja odświeża
validation, geometry diagnostics i readiness. Żadna akcja nie tworzy artefaktu
zastępczego ani nie deklaruje native FEM mesh/space.

Regresje źródłowe P4-C obejmują sukces realizacji z invalidacją pięciu
zasobów, stale response bez invalidacji, sukces walidacji, stale validation
bez publikacji oraz fail-closed bez rewizji sceny. Typecheck i API hygiene są
**PASS**; uruchomienie Vitest dla tego pliku pozostaje
**NOT VERIFIED** z powodu Windows `EPERM` przy odczycie zablokowanego
`node_modules/.../vitest.mjs`.

Ribonowy status meshu pokazuje teraz jawnie tożsamość ostatniego poprawnego
artefaktu oraz `source_scene_revision` i `geometry_realization_revision`.
Brak artefaktu jest prezentowany jako `none`, a brak rewizji jako `unknown`;
UI nie wyprowadza postępu z liczby etapów i nie promuje niezweryfikowanego
kandydata. Istniejący błąd autorytatywnego builda pozostawia generację
`latest-successful` bez zmian, co jest pokryte regresją źródłową.

Dowody poprzednich przyrostów: test sesji `preparation_receipt_is_bound_to_run_and_immutable`
**1 passed** (w tym replay z nowym timestampem), zarządzana trasa
`just verify-api-preparation` **3 passed** (`source_changed_during_run=false`),
`cargo test --locked -p fullmag-application --lib` **14 passed**,
`cargo check --locked -p fullmag-session` **PASS**, `cargo check --locked -p fullmag-api`
**PASS** oraz istniejący projection test preparation API **1 passed**. Wersjonowany `openapi-v2.json` i
`openapi-v2-types.ts` zawierają teraz `PreparationReceiptResource` oraz pole
`receipt`; `pnpm --dir apps/control-room typecheck` i
`pnpm --dir apps/control-room check:api-hygiene` są **PASS**.

Regresja adaptera Python `SceneDocument → ProblemIR`:
`python -m pytest -q -p no:cacheprovider packages/fullmag-py/tests/test_scene_document_problem_ir.py`
**1 passed**. Zarządzana trasa `api-preparation-tests` skompilowała testowy
binarny API i uruchomiła trzy bezpośrednie testy handlera: odrzucenie
nieaktywnego `preparation_id`, odrzucenie nieaktualnej rewizji sceny oraz
pozytywne lowering do `ProblemIR` z publikacją trwałego receipt i replay.
Receipt: `storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-preparation-tests/2ba52093247642d9ba9e87e7fb7c2203/receipt.json`.
Test pozytywny użył jednorazowego `FULLMAG_PYTHON` override wskazującego
interpreter workspace, ponieważ host nie ma skonfigurowanego projektowego
interpretera z wymaganymi modułami. Receipt route nie zapisuje tego override;
wynik dowodzi zachowania handlera dla fixture, ale nie managed runtime ani
kwalifikacji produkcyjnej.

Regresja renderowania provenance jest zapisana w
`SimulationStartupOverlay.test.tsx`, ale uruchomienie Vitest w bieżącym
środowisku jest **NOT VERIFIED**: Windows zwrócił `EPERM` przy odczycie
zablokowanego `node_modules/.../vitest.mjs` przez aktywny proces.

## Granica odbioru

Source-level adapter `SceneDocument → ProblemIR` oraz jego użycie przez
materializator API są zaimplementowane. Pythonowa regresja adaptera **1 passed**,
a pierwotny checkpoint obejmował trzy bezpośrednie testy handlera API **3 passed**;
nie były one testem HTTP/OpenAPI ani managed runtime. W tamtym checkpointcie
nie było jeszcze publicznego caller'a Control Room. Późniejszy stan tych
warstw opisuje rewalidacja z 23.09 poniżej. Pełna parzystość lowering
wszystkich pól nadal nie ma golden fixture. `PreparationBinding` zamyka
kontrakt wejścia komendy `Prepare` po stronie application; nie dowodzi, że
worker rzeczywiście wykonał przygotowanie.
Native FEM mesh/space materialization i automatyczny producer pipeline są
zaimplementowane źródłowo, ale pozostają `NOT VERIFIED`; pełny przepływ Submit,
browser proof i runtime/physics qualification również nie są ukończone.
Historia meshu ma jawne przywracanie historycznej polityki do draftu; nie jest
to rollback zaakceptowanego artefaktu mesh. Korekta zachowania last-good jest
dodana źródłowo, ale jej testy pozostają `NOT RUN`.

## Oddzielenie Live od ProjectRun

Przegląd lifecycle potwierdził, że obecny endpoint materializacji należy do
aktywnej sesji Live: wymaga jej epoch, bieżącego `SceneDocument`, rewizji sceny
i aktywnego `preparation_id`. Publiczne `ProjectRun` ma inny kontrakt: Submit
trwale akceptuje immutable archive, RunIntent, study plan i katalog problemów,
a materializacja katalogu nie otwiera LiveRuntime ani nie uruchamia workera.
Receipt Live nie może więc zasilać trwałego ProjectRun z chwilowego draftu.

`materialize_current_live_preparation` jest wspólnym use case'em dla historycznej
trasy wewnętrznej i publicznego adaptera
`POST /v2/sessions/current/simulation/preparation/materialization`. Capture,
lowering, kontrola aktywnego runu i trwała publikacja receipt pozostają w
`crates/fullmag-api/src/live_scene_preparation.rs`; use case ponownie sprawdza
scope, run ID, revision i preparation ID pod transition fence. Publiczny
request zawiera tylko `preparation_id` i `scene_revision`, więc klient nie może
podstawić PhysicsIR ani resolved execution. Control Room ma typowaną metodę
facade oraz session-scoped `study.prepare-live`, dostępną z menu Simulation i
komend ribbonu; po odpowiedzi invaliduje Preparation receipt SHA.

## Rewalidacja 23.09.2026

`just verify-api-preparation` wykonało **5 testów**, w tym pozytywne żądanie
przez router HTTP i trwałą publikację receipt; receipt potwierdza
`source_changed_during_run=false` oraz Python 3.12.2:
`storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-preparation-tests/dbc3ab0c918e4b76a08a441c76496331/receipt.json`.
Kanoniczna generacja OpenAPI oraz wygenerowanego TypeScript API i klienta,
typecheck Control Room i testy UI **PASS**; dwa zestawy ukierunkowane objęły
222/222 i 2/2 testy. To nie jest dowód browserowego wykonania, managed Live
runtime, FEM materialization ani walidacji fizycznej. Próba `just control-room`
zatrzymała się przed uruchomieniem na ochronie storage: istniejąca ścieżka
`.fullmag` wymaga inventoried migration. Nie zmieniono ścieżki ani mountów.

W CLI zachowanie ostatniego poprawnego meshu jest poprawiane tak, by
próba w toku i nieudana próba nie usuwały jego podsumowania/proweniencji, a opis
błędu był odrębny. Udany build jawnie zastępuje cele, także `null`, żeby nie
przenosić metadanych poprzedniego meshu. Testy regresyjne zapisano, lecz nie uruchomiono ich:
`windows-test-fem` odrzucił wykonanie bez kolejki, a `runner-container-status`
nie uzyskał odpowiedzi koordynatora. Jawna komenda rollbacku poprzedniej siatki,
automatyczny producer pipeline i natywne FEM mesh/space nadal nie są gotowe.

## Golden-parity slice 23.09.2026

Rozszerzony fixture FEM porównuje kanoniczne bajty całej fizycznej projekcji
`ProblemIR` z niezależnym skryptem Python DSL. Zakres obejmuje geometrię i
regiony, pole materiałowe, coupling, mesh defaults, monitor planar, dwa napędy
Gaussian, study pipeline oraz requested execution. Test wykrył, że
`builder_overrides_from_scene_document` nie przekazywał `field_drives`, a
renderer brał napędy wyłącznie z bazowego `Problem`; poprawka renderuje
autorytatywną listę SceneDocument, także pustą, i odrzuca niepoprawny kształt
lub elementy listy zamiast je pomijać.

Dowody źródłowe: `test_scene_document_problem_ir.py` **12 passed**,
`test_scene_document_roundtrip.py` **4 passed** oraz
`test_script_builder_roundtrip.py` **35 passed, 28 subtests passed**;
`check_repo_consistency.py` i `git diff --check` **PASS**. To reprezentatywny
fixture FEM dla tego wycinka, nie pełna macierz wszystkich pól SceneDocument.
Native FEM mesh/space, automatyczne przygotowanie, browser/Live runtime i
kwalifikacja fizyczna pozostają `NOT VERIFIED`; procent P4 pozostaje **50%**.

## Rewalidacja zasobu preparation — 24.09.2026

Control Room wiąże teraz odczyt preparation z pełną tożsamością aktywnej sesji:
`session_id`, `session_epoch` i `request_scope_epoch`. Hook czeka na status
zawierający te trzy wartości, przekazuje odpowiadający im `sessionScopeKey` do
fasady API i używa sesyjnego klucza cache. Wymagana rewizja z statusu jest
unieważniana pod tym samym kluczem; wcześniejsze unieważnienie ścieżki
kanonicznej nie może utknąć na nieaktywnym kluczu ani udostępnić danych starej
sesji. Ostatnia poprawna rewizja pozostaje widoczna podczas odświeżenia.

Weryfikacja: ukierunkowane suite'y geometry commands, startup overlay,
zamontowanego preparation UI i hooka **88/88**; workspace history restore
**3/3**; Control Room typecheck, celowany ESLint, API hygiene, architecture
hygiene i repository consistency **PASS**. Testy używają teraz tego samego
sesyjnego klucza również przy podstawianiu nowych danych. Jest to dowód
źródłowy; browser/live runtime nadal pozostają `NOT VERIFIED`.

Karta `http://localhost:3104/workspace` zgłosiła `ERR_CONNECTION_REFUSED`,
więc nie uzyskano browser proof. Ponowny `just runner-container-status`
zakończył się `Docker Desktop coordinator request failed`; nie wykonano
kompilacji natywnego FEM poza kolejką. Źródłowa implementacja native mesh/space
producer'a i ścieżki API jest obecna, ale jej kompilacja, kontrakty i runtime
pozostają otwarte. Caller Control Room dopisano w checkpointcie poniżej. P4
pozostaje na **50%**.

## Caller Build Mesh/Compute i provenance — 24.09.2026

Control Room unieważnia teraz zasób Preparation po każdej zmianie sceny
authoringowej oraz po udanym terminalnym wyniku budowy siatki. Komendy FEM
`Compute`, `Compute Fields` i `Compute Energies` przed solver command pobierają aktualne
preparation i scenę, wymagają gotowego statusu Live oraz manifestu shared-domain
mesh z `source_scene_revision` zgodną z bieżącą sceną, po czym materializują
receipt przez typed API. Niezgodna rewizja, brak manifestu, inna sesja lub
niegotowe preparation zatrzymują wysłanie komendy. Ręczna komenda `Prepare`
używa tego samego helpera; FDM nadal zachowuje dotychczasowy submit path.

Overlay pokazuje pola identity-only zwrócone przez API: `preparation_id`,
`run_id`, schema version, plan fingerprint i payload digest. Pełne certyfikaty
pozostają w session store zgodnie z kontraktem API. Kontrakt
`receipt_sha256` poprawiono do maxLength 71, zgodnie z formatem
`sha256:<64 lowercase hex>` z `PreparationBinding`; źródło Rust i wersjonowany
OpenAPI JSON są zsynchronizowane.

Dodano regresje źródłowe dla kolejności FEM Compute → materializacja → submit,
braku materializacji przy nieaktualnej siatce, gotowości Live, invalidacji
Preparation oraz wyświetlania receipt provenance. Testy jednostkowe nie zostały
uruchomione zgodnie z tymczasową regułą repozytorium. Typecheck, ESLint, API
hygiene i statyczna kontrola OpenAPI pozostają do wykonania. FEM build,
kontrakty C++/Rust, managed runtime i browser proof pozostają
`NOT VERIFIED`, bo runner nie odpowiadał i karta lokalnego workspace była
odrzucona. P4 i plan globalny pozostają bez zmiany procentowej.

## Przywracanie historii meshu do draftu — 24.09.2026

`MeshBuildHistoryView` udostępnia jawny przycisk przy wpisie posiadającym
`canonical_policy_snapshot`. `restoreMeshHistoryToDraft` wybiera odpowiedni
edytor, czeka na jego sygnał gotowości i przekazuje snapshot do
`AirboxMeshParametersPanel` albo `ObjectMeshPolicyPanel`. Panele zmieniają
wyłącznie lokalny draft i pokazują komunikat wymagający jawnego Apply przed
budową; ta ścieżka nie zapisuje polityki przez API ani nie nadpisuje
`latest-successful` artefaktu.

Ukierunkowane regresje: `meshBuildHistoryRestore.test.ts` **6/6 PASS** oraz
`MeshBuildHistoryView.test.tsx` **3/3 PASS**, wykonane przez zatwierdzoną
trasę `pnpm --dir apps/control-room exec vitest run ...`. Dowód dotyczy
nawigacji i przywrócenia konfiguracji do draftu, nie odtworzenia pliku meshu,
native FEM, browser runtime ani fizycznej kwalifikacji. Wymóg P4 dotyczący
niepromowania kandydata nadal zależy od testu last-good i zarządzanej bramki;
P4 pozostaje **50%**.

## Widok last-successful po błędzie budowania — 24.09.2026

Ukierunkowane suite'y panelu Airbox oraz jego modelu przeszły **53/53**:
`AirboxMeshBuildPanel.test.tsx` i `airboxMeshInspectorModel.test.ts`.
Sprawdzają prezentację bieżącego błędu, lifecycle `degraded`, bounded details
oraz jednoczesne wyświetlenie wpisu `last_success` z zasobu
`latest-successful`. To potwierdza zachowanie projekcji w UI, nie retencję
artefaktu po stronie backendu. Regresja Rust w `manual_remesh.rs` sprawdza
zachowanie `last_build_summary` po odrzuconym kandydacie, ale pozostaje
nieuruchomiona; native FEM, managed runtime i fizyczne odzyskanie artefaktu
pozostają `NOT VERIFIED`. P4 (**50%**) i całość (~**27%**) bez zmian.

## Końcowa walidacja natywnego meshu — 24.09.2026

`verify_finalized_mesh()` sprawdza po finalizacji, że MFEM zachował dokładne
współrzędne wejściowych węzłów oraz że każdy jawny brzeg ma oczekiwaną
geometrię, marker i uporządkowaną łączność właściciela komórki. Kontrola
liczności poprzedza dopasowanie jeden-do-jednego, więc nadmiarowy element
brzegowy nie może wyjść poza tablicę dopasowań. `fem_mixed_p1_contract` zawiera
regresje współrzędnych i kompletności faset zewnętrznych/okresowych.

Weryfikacja pozostaje **NOT RUN**: managed runner zwrócił
`Docker Desktop coordinator request failed`. Nie uruchomiono kompilacji
hostowej. Procent P4 (**50%**) ani planu ogólnego (~**27%**) nie zmienia się na
podstawie samego source-level diff.

## Fail-closed lowering SceneDocument — 24.09.2026

Pythonowy adapter odrzuca teraz nieznane pola top-level i `study`, błędne
`outputs`, nieobsługiwane wyniki i niepuste `study.mesh_interfaces`. Pole
`table_autosave` jest zachowane przez builder i `ProblemIR`, razem z kadencją,
`table_id`, quantities oraz expressions. `SceneStudyState` i Rustowe adaptery
buildera przenoszą ten sam typed payload. Zgodnie z serde, `field_drives: {}`
oznacza domyślnie pustą listę; `null`, błędne typy i nieznane pola nadal są
odrzucane. Jeden test end-to-end wykrył tę różnicę, a po poprawce zestaw
adaptera Python/table autosave przechodzi **58/58**.

`SceneResource` zachowuje monitory planar i table autosave w projekcji oraz
round-tripie. Zarządzane testy materializacji API **5/5**, projekcja
`SceneResource` **1/1** i adapter Rust **1/1** są zielone. OpenAPI zostało
wygenerowane przez zatwierdzoną trasę; typy i klienta wygenerowano ponownie,
`check:api-hygiene` oraz `typecheck` przeszły. Fixture'y testowe
`geometry_features` zostały poprawione, aby scenę pustą tworzyć przez
kanoniczne serde defaults zamiast nieistniejącego `SceneDocument::default()`.

Te wyniki nie zamykają pełnej macierzy parity. Runner FEM nadal nie odpowiada;
native mesh/space, pełny Live/browser runtime i walidacja fizyczna pozostają
`NOT VERIFIED`. P4 (**50%**) i całość (~**27%**) bez zmian.

## Strict legacy current_transport — 24.09.2026

Dekoder migracyjny odrzuca nieznane pola całego typowanego
`current_transport`, również referencji, materiałów, brzegów, solvera,
obwiedni i obu wariantów closure. `lead_mesh` pozostaje zachowany jako
opaque MeshIR payload. Obie ścieżki migracji przechodzą przez wspólny dekoder.
Suite'y sceny, autosave, transportów i SOT: **159 testów + 66 subtestów
PASS**; `just verify-api-preparation`: **PASS**, receipt
`api-preparation-tests/075054772039409e9ce808a5a9c55591/receipt.json`.
To nie zmienia limitów dowodów: pełna golden parity, FEM, Live/browser i
walidacja fizyczna pozostają `NOT VERIFIED`; P4 (**50%**) i całość (~**27%**).

Najnowszy differential ujawnił i zamknął odrębny błąd: FDM bez jawnych
discretization hints dostawał przy lowering domyślny FEM `hmax` ze stanu
edytora. Renderer rozpoznaje teraz backend z `Problem.runtime`; regression
porównuje cały FDM ProblemIR z DSL, wyłączając tylko tekst `script_source` i
`source_hash`. Rewalidacja szerszych suite'ów przeszła **156 testów + 109
subtestów**, a zarządzany API preparation route
wiąże `script_builder.py` przez zgodny SHA-256. Jawne różnice domyślnych opcji
`mesh_workflow` FEM nadal należą do pełnej golden parity. Szczegóły i receipt:
[`SceneDocument → ProblemIR`](01-scene-document-to-problem-ir.md). Procent P4
pozostaje **50%**, a planu ogólnego ~**27%**.

24.09: current modules przechodzą fail-closed po obu stronach serde/Python;
unknown fields są odrzucane, a dotychczasowa migracja `current_transport` i
częściowe szkice anteny zachowują kompatybilność. Połączone suite'y Python
SceneDocument, table autosave i transportów: **122 testy + 45 subtestów PASS**.
Zarządzane trasy API preparation,
SceneResource, Rust authoring i OpenAPI codegen **PASS**; wygenerowane typy,
ścieżki, API hygiene i TypeScript typecheck **PASS**. Receipts i szczegółowe
granice dowodów są w `01-scene-document-to-problem-ir.md`. P4 pozostaje **50%**;
FEM, pełny runtime, browser i walidacja fizyczna nadal są **NOT VERIFIED**.

Nowsza rewalidacja domyka pełny differential FDM i bogatego przypadku FEM dla
ProblemIR (poza dwoma polami tożsamości tekstu źródłowego). Suite'y adaptera,
round-trip, transportów, autosave, closure, SOT i script builder przechodzą
**193 testy + 137 subtestów**; zarządzane API preparation także **PASS**.
Szczegóły, receipt i jawne ograniczenia dowodów są w
[`01-scene-document-to-problem-ir.md`](01-scene-document-to-problem-ir.md).

## Fence sesji w callerze FEM — 24.09.2026

Ukierunkowane suite'y `livePreparationMaterialization.test.ts` i
`studyRuntimeCommandContributions.test.ts` przechodzą **89/89**. Nowa regresja
zmienia aktywną sesję podczas oczekiwania na receipt i potwierdza, że caller
anuluje operację, nie wysyła FEM Compute i nie publikuje lokalnej invalidacji
receipt'u. `check:architecture-hygiene`, `check:api-hygiene`, `typecheck`
oraz celowany ESLint zmienionego testu również przeszły.

To potwierdza source-level fence i kontrakt callera. Odczytowy podgląd
`http://localhost:3104/workspace` nadal zwraca `ERR_CONNECTION_REFUSED`, a
zarządzane wykonanie native FEM zatrzymuje się przed Compose na storage
preflight istniejącego `.fullmag`. Browser/Live, native C++/ABI i walidacja
fizyczna pozostają `NOT VERIFIED`; P4 (**50%**) i całość (~**27%**) bez zmian.
